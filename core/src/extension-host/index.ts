/**
 * Sandboxed Extension Host (`core/src/extension-host/`).
 *
 * Rules enforced:
 * - Validates extension manifest and supported core API version range on registration.
 * - Executes hooks only for extensions explicitly enabled in the active tenant's configuration.
 * - Passes a read-only tenant-scoped context object (never raw database connections).
 * - Enforces timeouts and error isolation so an extension failure never takes down the core.
 */

import type {
  ExtensionExecutionContext,
  MatterCostsHookInput,
  MatterCostsHookResult,
  PlatformExtension,
  TenantConfiguration,
  TenantContext,
} from '../api/index';

export interface ExtensionHostOptions {
  coreApiVersion: string;
  defaultHookTimeoutMs?: number;
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

      try {
        const result = await Promise.race<MatterCostsHookResult>([
          Promise.resolve(fn(scopedContext, input)),
          new Promise<MatterCostsHookResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Extension "${ext.manifest.id}" timed out after ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            ),
          ),
        ]);

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
        // Fail-safe error isolation: log warning without crashing the core
        const reason = err instanceof Error ? err.message : 'Unknown error';
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
}
