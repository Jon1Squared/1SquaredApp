/**
 * Sandboxed Extension Host (`core/src/extension-host/`).
 *
 * Rules enforced:
 * - Validates extension manifest and supported core API version range on registration.
 * - Executes hooks only for extensions explicitly enabled in the active tenant's configuration.
 * - Passes a read-only tenant-scoped context object (never raw database connections).
 * - Enforces timeouts and error isolation so an extension failure never takes down the core.
 * - For `provideDocumentFields`, enforces `document:fields:provide` plus the required entity
 *   read permission (`matter:read`, `client:read`, `person:read`, or `finance:view`) and blocks
 *   any sensitive HR/payroll field keys.
 */

import type {
  ExtensionExecutionContext,
  FieldCatalogueEntry,
  FieldProviderHookInput,
  FieldProviderHookResult,
  KeyDateAfterStatusChangeHookInput,
  KeyDateBeforeCreateHookInput,
  KeyDateBeforeCreateHookResult,
  KeyDateCalculateCustomRuleHookInput,
  KeyDateCalculateCustomRuleHookResult,
  MatterCostsHookInput,
  MatterCostsHookResult,
  MatterDocumentsLifecycleHookInput,
  PlatformExtension,
  PmsOutboundCommand,
  PmsOutboundSyncResult,
  TenantConfiguration,
  TenantContext,
} from '../api/index';
import {
  buildExtensionFieldCatalogueEntries,
  isExcludedSensitiveEmployeeFieldKey,
} from '../domain/document-generation/fieldCatalogue';
import { validateExtensionManifest } from '../config-engine/index';

export class ExtensionHookTimeoutError extends Error {
  readonly code = 'EXTENSION_HOOK_TIMEOUT';
  constructor(extensionId: string, timeoutMs: number) {
    super(`Extension "${extensionId}" timed out after ${timeoutMs}ms`);
    this.name = 'ExtensionHookTimeoutError';
  }
}

export interface ExtensionHostOptions {
  coreApiVersion: string;
  defaultHookTimeoutMs?: number;
}

export interface ExecutedFieldProvidersResult {
  catalogueEntries: FieldCatalogueEntry[];
  resolvedValues: Record<string, unknown>;
  isolatedErrors: string[];
}

function parseMajorVersion(version: string): number {
  const cleaned = version.trim().replace(/^\^|~|>=|=/, '');
  const major = Number.parseInt(cleaned.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? -1 : major;
}

export function isCoreApiRangeCompatible(
  coreApiVersion: string,
  supportedRange: string,
): boolean {
  const coreMajor = parseMajorVersion(coreApiVersion);
  const rangeMajor = parseMajorVersion(supportedRange);
  return coreMajor > 0 && coreMajor === rangeMajor;
}

export class ExtensionHost {
  private readonly coreApiVersion: string;
  private readonly defaultHookTimeoutMs: number;
  private readonly extensions = new Map<string, PlatformExtension>();

  constructor(options: ExtensionHostOptions) {
    this.coreApiVersion = options.coreApiVersion;
    this.defaultHookTimeoutMs = options.defaultHookTimeoutMs ?? 2000;
  }

  public registerExtension(extension: PlatformExtension): void {
    const { manifest } = extension;
    if (!manifest?.id || !manifest?.version || !manifest?.supportedCoreApiRange) {
      throw new Error(
        'EXTENSION_MANIFEST_ERROR: Extension manifest must declare id, version, and supportedCoreApiRange.',
      );
    }
    validateExtensionManifest(manifest);

    if (
      !isCoreApiRangeCompatible(
        this.coreApiVersion,
        manifest.supportedCoreApiRange,
      )
    ) {
      throw new Error(
        `EXTENSION_COMPATIBILITY_ERROR: Extension "${manifest.id}" requires core API "${manifest.supportedCoreApiRange}", which is incompatible with core API "${this.coreApiVersion}".`,
      );
    }

    if (manifest.hooks.includes('provideDocumentFields')) {
      if (!manifest.permissions.includes('document:fields:provide')) {
        throw new Error(
          `EXTENSION_PERMISSION_ERROR: Extension "${manifest.id}" registers hook "provideDocumentFields" but does not declare permission "document:fields:provide".`,
        );
      }
      const hasEntityRead =
        manifest.permissions.includes('matter:read') ||
        manifest.permissions.includes('client:read') ||
        manifest.permissions.includes('person:read') ||
        manifest.permissions.includes('finance:view');
      if (!hasEntityRead) {
        throw new Error(
          `EXTENSION_PERMISSION_ERROR: Field Provider extension "${manifest.id}" must also declare at least one entity read permission (matter:read, client:read, person:read, or finance:view).`,
        );
      }
    }

    if (manifest.hooks.includes('keyDate.beforeCreate')) {
      if (!manifest.permissions.includes('keydate:write')) {
        throw new Error(
          `EXTENSION_PERMISSION_ERROR: Extension "${manifest.id}" registers hook "keyDate.beforeCreate" but does not declare permission "keydate:write".`,
        );
      }
    }

    if (
      manifest.hooks.includes('keyDate.afterStatusChange') ||
      manifest.hooks.includes('keyDate.calculateCustomRule')
    ) {
      if (
        !manifest.permissions.includes('keydate:read') &&
        !manifest.permissions.includes('keydate:write')
      ) {
        throw new Error(
          `EXTENSION_PERMISSION_ERROR: Extension "${manifest.id}" registers a keyDate read/calculation hook but does not declare permission "keydate:read" or "keydate:write".`,
        );
      }
    }

    this.extensions.set(manifest.id, extension);
  }

  public getActiveExtensionsForTenant(
    tenantConfig: TenantConfiguration,
  ): PlatformExtension[] {
    return tenantConfig.enabledExtensions
      .map((id) => this.extensions.get(id))
      .filter((ext): ext is PlatformExtension => Boolean(ext));
  }

  public async executeMatterCostsHook(
    hookName: 'beforeMatterCostsCalculate' | 'beforeMatterOpen',
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: MatterCostsHookInput,
  ): Promise<MatterCostsHookResult> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const aggregatedWarnings: string[] = [];
    let requiresPartnerSignOff = false;
    let allowProceed = true;

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks[hookName];
      if (!fn) continue;

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race<MatterCostsHookResult>([
          Promise.resolve(fn(scopedContext, input)),
          new Promise<MatterCostsHookResult>((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            );
          }),
        ]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        });

        if (result.requiresPartnerSignOff) {
          requiresPartnerSignOff = true;
        }
        if (!result.allowProceed) {
          allowProceed = false;
        }
        if (result.governanceWarnings?.length) {
          aggregatedWarnings.push(...result.governanceWarnings);
        }
      } catch (err) {
        // Fail-safe error isolation: log warning without crashing the core.
        // For beforeMatterOpen (opening gate), fail closed on any error (throw or timeout).
        // For beforeMatterCostsCalculate (advisory), fail open with a warning.
        const reason = err instanceof Error ? err.message : 'Unknown error';
        if (hookName === 'beforeMatterOpen') {
          allowProceed = false;
        }
        aggregatedWarnings.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return {
      requiresPartnerSignOff,
      governanceWarnings: aggregatedWarnings,
      allowProceed,
    };
  }

  /**
   * @deprecated Use async `executeMatterCostsHook` instead.
   */
  public executeMatterCostsHookSync(
    hookName: 'beforeMatterCostsCalculate' | 'beforeMatterOpen',
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: MatterCostsHookInput,
  ): MatterCostsHookResult {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const aggregatedWarnings: string[] = [];
    let requiresPartnerSignOff = false;
    let allowProceed = true;

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks[hookName];
      if (!fn) continue;

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;
      const startedAt = Date.now();

      try {
        const maybePromise = fn(scopedContext, input);
        if (
          maybePromise &&
          typeof (maybePromise as Promise<MatterCostsHookResult>).then ===
            'function'
        ) {
          continue;
        }
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > timeoutMs) {
          throw new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs);
        }
        const result = maybePromise as MatterCostsHookResult;
        if (result.requiresPartnerSignOff) {
          requiresPartnerSignOff = true;
        }
        if (!result.allowProceed) {
          allowProceed = false;
        }
        if (result.governanceWarnings?.length) {
          aggregatedWarnings.push(...result.governanceWarnings);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        if (hookName === 'beforeMatterOpen') {
          allowProceed = false;
        }
        aggregatedWarnings.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return {
      requiresPartnerSignOff,
      governanceWarnings: aggregatedWarnings,
      allowProceed,
    };
  }

  public async executePmsOutboundCommandHook(
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    command: PmsOutboundCommand,
  ): Promise<PmsOutboundSyncResult> {
    if (
      tenantCtx.tenantId !== tenantConfig.tenantId ||
      command.tenantId !== tenantCtx.tenantId
    ) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext, TenantConfiguration, and PmsOutboundCommand must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks.onPmsOutboundCommand;
      if (!fn) continue;

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      try {
        const result = await Promise.race<PmsOutboundSyncResult>([
          Promise.resolve(fn(scopedContext, command)),
          new Promise<PmsOutboundSyncResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);
        return result;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        return {
          commandId: command.id,
          status: 'Failed',
          syncedAt: new Date().toISOString(),
          errorMessage: `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        };
      }
    }

    return {
      commandId: command.id,
      status: 'Pending',
      syncedAt: new Date().toISOString(),
      errorMessage: null,
    };
  }

  /**
   * Executes active `provideDocumentFields` extensions for the current tenant,
   * verifying manifest permissions (`document:fields:provide` + entity read permission),
   * enforcing timeout & error isolation, and blocking excluded HR/payroll keys.
   */
  public async executeFieldProviders(
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: FieldProviderHookInput,
  ): Promise<ExecutedFieldProvidersResult> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const catalogueEntries: FieldCatalogueEntry[] = [];
    const resolvedValues: Record<string, unknown> = {};
    const isolatedErrors: string[] = [];

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks.provideDocumentFields;
      if (!fn) continue;

      if (!ext.manifest.permissions.includes('document:fields:provide')) {
        isolatedErrors.push(
          `[Extension permission denied: ${ext.manifest.id}] Missing document:fields:provide`,
        );
        continue;
      }

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? Math.min(this.defaultHookTimeoutMs, 500);

      try {
        const sanitizedInput: FieldProviderHookInput = {
          sourceEntityType: input.sourceEntityType,
          matterId: input.matterId,
          clientId: input.clientId,
          matter: ext.manifest.permissions.includes('matter:read')
            ? input.matter
            : null,
          client:
            ext.manifest.permissions.includes('client:read') ||
            ext.manifest.permissions.includes('person:read')
              ? input.client
              : null,
        };

        const result = await Promise.race<FieldProviderHookResult>([
          Promise.resolve(fn(scopedContext, sanitizedInput)),
          new Promise<FieldProviderHookResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);

        const permittedDefinitions = (result.definitions ?? []).filter((def) => {
          if (!ext.manifest.permissions.includes(def.requiredEntityPermission)) {
            isolatedErrors.push(
              `[Extension permission denied: ${ext.manifest.id}] Field "${def.key}" requires manifest permission "${def.requiredEntityPermission}".`,
            );
            return false;
          }
          if (isExcludedSensitiveEmployeeFieldKey(def.key)) {
            isolatedErrors.push(
              `[Extension security blocked: ${ext.manifest.id}] Field "${def.key}" is a restricted HR/payroll/sensitive field.`,
            );
            return false;
          }
          return true;
        });

        const builtEntries = buildExtensionFieldCatalogueEntries(
          ext.manifest.id,
          permittedDefinitions,
        );
        catalogueEntries.push(...builtEntries);

        const prefix = `ext.${ext.manifest.id}.`;
        for (const [k, v] of Object.entries(result.values ?? {})) {
          const fullKey = k.startsWith(prefix)
            ? k
            : `${prefix}${k.replace(/^ext\./, '')}`;
          if (!isExcludedSensitiveEmployeeFieldKey(fullKey)) {
            resolvedValues[fullKey] = v;
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        isolatedErrors.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return {
      catalogueEntries,
      resolvedValues,
      isolatedErrors,
    };
  }

  /**
   * Executes active `afterMatterDocumentsProvisioned` or `beforeMatterDocumentsClose` extension hooks
   * with timeout and error isolation.
   */
  public async executeMatterDocumentsLifecycleHook(
    hookName: 'afterMatterDocumentsProvisioned' | 'beforeMatterDocumentsClose',
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: MatterDocumentsLifecycleHookInput,
  ): Promise<{ isolatedErrors: string[] }> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const isolatedErrors: string[] = [];

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks[hookName];
      if (!fn) continue;

      if (!ext.manifest.permissions.includes('document:read')) {
        isolatedErrors.push(
          `[Extension permission denied: ${ext.manifest.id}] Hook "${hookName}" requires permission "document:read".`,
        );
        continue;
      }

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      try {
        await Promise.race([
          Promise.resolve(fn(scopedContext, input)),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        isolatedErrors.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return { isolatedErrors };
  }

  public async executeKeyDateBeforeCreateHook(
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: KeyDateBeforeCreateHookInput,
  ): Promise<{
    allowProceed: boolean;
    rejectionReason?: string;
    enrichedInput: KeyDateBeforeCreateHookInput;
    isolatedErrors: string[];
  }> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const isolatedErrors: string[] = [];
    let allowProceed = true;
    let rejectionReason: string | undefined;
    let currentInput: KeyDateBeforeCreateHookInput = { ...input };

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks['keyDate.beforeCreate'];
      if (!fn) continue;

      if (!ext.manifest.permissions.includes('keydate:write')) {
        isolatedErrors.push(
          `[Extension permission denied: ${ext.manifest.id}] Hook "keyDate.beforeCreate" requires permission "keydate:write".`,
        );
        continue;
      }

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      try {
        const result = await Promise.race<KeyDateBeforeCreateHookResult>([
          Promise.resolve(fn(scopedContext, currentInput)),
          new Promise<KeyDateBeforeCreateHookResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);

        if (!result.allowProceed) {
          allowProceed = false;
          rejectionReason = result.rejectionReason ?? `Rejected by extension ${ext.manifest.id}`;
          break;
        }
        if (result.enrichedFields) {
          currentInput = {
            ...currentInput,
            ...result.enrichedFields,
          };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        isolatedErrors.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return {
      allowProceed,
      rejectionReason,
      enrichedInput: currentInput,
      isolatedErrors,
    };
  }

  public async executeKeyDateAfterStatusChangeHook(
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: KeyDateAfterStatusChangeHookInput,
  ): Promise<{ isolatedErrors: string[] }> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const isolatedErrors: string[] = [];

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks['keyDate.afterStatusChange'];
      if (!fn) continue;

      if (
        !ext.manifest.permissions.includes('keydate:read') &&
        !ext.manifest.permissions.includes('keydate:write')
      ) {
        isolatedErrors.push(
          `[Extension permission denied: ${ext.manifest.id}] Hook "keyDate.afterStatusChange" requires permission "keydate:read" or "keydate:write".`,
        );
        continue;
      }

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      try {
        await Promise.race([
          Promise.resolve(fn(scopedContext, input)),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        isolatedErrors.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return { isolatedErrors };
  }

  public async executeKeyDateCalculateCustomRuleHook(
    tenantCtx: TenantContext,
    tenantConfig: TenantConfiguration,
    input: KeyDateCalculateCustomRuleHookInput,
  ): Promise<{
    result: KeyDateCalculateCustomRuleHookResult | null;
    isolatedErrors: string[];
  }> {
    if (tenantCtx.tenantId !== tenantConfig.tenantId) {
      throw new Error(
        'EXTENSION_TENANT_MISMATCH: TenantContext and TenantConfiguration must belong to the same tenant.',
      );
    }

    const active = this.getActiveExtensionsForTenant(tenantConfig);
    const isolatedErrors: string[] = [];

    const scopedContext: ExtensionExecutionContext = Object.freeze({
      tenant: Object.freeze({
        tenantId: tenantCtx.tenantId,
        hostingMode: tenantCtx.hostingMode,
        environment: tenantCtx.environment,
        correlationId: tenantCtx.correlationId,
        actorRoles: tenantCtx.actorRoles,
      }),
      config: Object.freeze({ ...tenantConfig }),
    });

    for (const ext of active) {
      const fn = ext.hooks['keyDate.calculateCustomRule'];
      if (!fn) continue;

      if (
        !ext.manifest.permissions.includes('keydate:read') &&
        !ext.manifest.permissions.includes('keydate:write')
      ) {
        isolatedErrors.push(
          `[Extension permission denied: ${ext.manifest.id}] Hook "keyDate.calculateCustomRule" requires permission "keydate:read" or "keydate:write".`,
        );
        continue;
      }

      const timeoutMs =
        ext.manifest.hookTimeoutMs ?? this.defaultHookTimeoutMs;

      try {
        const result = await Promise.race<KeyDateCalculateCustomRuleHookResult>([
          Promise.resolve(fn(scopedContext, input)),
          new Promise<KeyDateCalculateCustomRuleHookResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ExtensionHookTimeoutError(ext.manifest.id, timeoutMs),
                ),
              timeoutMs,
            ),
          ),
        ]);
        return { result, isolatedErrors };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error';
        isolatedErrors.push(
          `[Extension isolated error: ${ext.manifest.id}] ${reason}`,
        );
      }
    }

    return { result: null, isolatedErrors };
  }
}
