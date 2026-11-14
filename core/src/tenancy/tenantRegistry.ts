/**
 * Schema-validated Environment Tenant Registry (`core/src/tenancy/tenantRegistry.ts`).
 *
 * Implements ADR 0030 §2 & ADR 0028 §4 (`R403`, `R413`):
 * - Provides the single authoritative list of provisioned tenants for the `migrate` Container Apps job
 *   and scheduled background jobs (`S0-19` / `S0-19b`).
 * - Stores `keyVaultUri` directly from `core/infra/modules/tenant.bicep` deployment outputs so 24-character
 *   truncated Azure Key Vault names are never re-derived in TypeScript (`R413`).
 * - Web requests NEVER resolve their `TenantContext` from this registry (Rule 4 — web requests resolve
 *   exclusively from verified OIDC token claims).
 */

import path from 'node:path';
import { z } from 'zod';
import type { HostingMode, PlatformEnvironment } from '../api/index';

function getNodeFs(): typeof import('node:fs') {
  if (
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    throw new Error(
      'TENANT_REGISTRY_BROWSER_FORBIDDEN: File-system tenant registry loading is server-only.',
    );
  }
  const mod = process.getBuiltinModule('node:fs') as
    | typeof import('node:fs')
    | undefined;
  if (!mod) {
    throw new Error('TENANT_REGISTRY_ERROR: node:fs builtin unavailable.');
  }
  return mod;
}

const PLATFORM_ENVIRONMENTS: readonly PlatformEnvironment[] = [
  'dev',
  'test',
  'training',
  'demo',
  'live',
];

function registryError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = 'TENANT_REGISTRY_ERROR';
  return err;
}

function requireRegistryEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw registryError(
      `TENANT_REGISTRY_ERROR: ${name} must be set to load the single-package tenant registry.`,
    );
  }
  return value;
}

export interface TenantRegistryEntry {
  readonly tenantId: string;
  readonly slug: string;
  readonly environment: PlatformEnvironment;
  readonly postgresHost: string;
  readonly postgresDatabaseName: string;
  readonly postgresRoleName: string;
  readonly keyVaultUri: string;
  readonly packageDir: string;
  readonly timeZone: string;
  readonly enabled: boolean;
}

export interface TenantRegistry {
  readonly schemaVersion: string;
  readonly environment: PlatformEnvironment;
  readonly hostingMode: HostingMode;
  readonly tenants: readonly TenantRegistryEntry[];
}

const TenantRegistryEntrySchema = z
  .object({
    tenantId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
    slug: z.string().regex(/^[a-z0-9][a-z0-9_]{1,48}[a-z0-9]$/),
    environment: z.enum(['dev', 'test', 'training', 'demo', 'live']),
    postgresHost: z.string().min(1),
    postgresDatabaseName: z.string().regex(/^pg_tenant_[a-z0-9_]{2,55}$/),
    postgresRoleName: z.string().regex(/^role_tenant_[a-z0-9_]{2,55}$/),
    keyVaultUri: z
      .string()
      .regex(
        /^https:\/\/[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]\.vault\.azure\.net\/?$/i,
      ),
    packageDir: z.string().min(1),
    timeZone: z
      .string()
      .min(1)
      .default('Europe/London')
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA timeZone identifier.'),
    enabled: z.boolean(),
  })
  .strict();

export const TenantRegistrySchema = z
  .object({
    schemaVersion: z.string().default('1.0.0'),
    environment: z.enum(['dev', 'test', 'training', 'demo', 'live']),
    hostingMode: z.enum(['single_tenant', 'multi_tenant']),
    tenants: z.array(TenantRegistryEntrySchema),
  })
  .strict()
  .superRefine((reg, ctx) => {
    const seenIds = new Set<string>();
    for (let i = 0; i < reg.tenants.length; i++) {
      const entry = reg.tenants[i]!;
      if (seenIds.has(entry.tenantId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'tenantId'],
          message: `Duplicate tenantId "${entry.tenantId}" in tenant registry.`,
        });
      }
      seenIds.add(entry.tenantId);

      const expectedSlug = entry.tenantId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_');
      if (entry.slug !== expectedSlug) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'slug'],
          message: `Registry entry slug "${entry.slug}" must match normalised tenantId "${expectedSlug}".`,
        });
      }
      if (entry.environment !== reg.environment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'environment'],
          message: `Registry entry environment "${entry.environment}" must match registry environment "${reg.environment}".`,
        });
      }
      const expectedDb = `pg_tenant_${expectedSlug}_${entry.environment}`;
      if (entry.postgresDatabaseName !== expectedDb) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'postgresDatabaseName'],
          message: `Registry entry postgresDatabaseName "${entry.postgresDatabaseName}" must be "${expectedDb}".`,
        });
      }
      const expectedRole = `role_tenant_${expectedSlug}_${entry.environment}`;
      if (entry.postgresRoleName !== expectedRole) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'postgresRoleName'],
          message: `Registry entry postgresRoleName "${entry.postgresRoleName}" must be "${expectedRole}".`,
        });
      }
    }

    if (reg.hostingMode === 'single_tenant' && reg.tenants.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenants'],
        message:
          'single_tenant hostingMode cannot register more than one tenant entry.',
      });
    }
  });

export function validateTenantRegistry(raw: unknown): TenantRegistry {
  const parsed = TenantRegistrySchema.parse(raw);
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    environment: parsed.environment,
    hostingMode: parsed.hostingMode,
    tenants: Object.freeze(parsed.tenants.map((t) => Object.freeze({ ...t }))),
  });
}

function extractVaultUriFromPackageConfig(
  baseJson: Record<string, unknown>,
  overlayJson: Record<string, unknown>,
  tenantId: string,
  environment: PlatformEnvironment,
): string {
  const mergedKv = {
    ...((baseJson.keyVault as Record<string, unknown> | undefined) ?? {}),
    ...((overlayJson.keyVault as Record<string, unknown> | undefined) ?? {}),
  };
  if (typeof mergedKv.vaultUri === 'string' && mergedKv.vaultUri.trim()) {
    return mergedKv.vaultUri.trim();
  }
  if (typeof mergedKv.vaultName === 'string' && mergedKv.vaultName.trim()) {
    return `https://${mergedKv.vaultName.trim()}/.vault.azure.net/`.replace(
      '/.vault.azure.net/',
      '.vault.azure.net/',
    );
  }
  const mergedIntegrations = {
    ...((baseJson.integrations as Record<string, unknown> | undefined) ?? {}),
    ...((overlayJson.integrations as Record<string, unknown> | undefined) ?? {}),
  };
  const pmsRef =
    typeof mergedIntegrations.pmsConnectionSecretVaultRef === 'string'
      ? mergedIntegrations.pmsConnectionSecretVaultRef.trim()
      : '';
  const kvMatch = /^kv:\/\/([a-zA-Z0-9-]+)\//.exec(pmsRef);
  if (kvMatch?.[1]) {
    return `https://${kvMatch[1]}.vault.azure.net/`;
  }
  return `https://kv-${tenantId.replace(/-/g, '')}-${environment}.vault.azure.net/`;
}

/**
 * Loads and validates the active environment's `TenantRegistry` from:
 * 1. `PLATFORM_TENANT_REGISTRY_JSON` (inline JSON string from Container Apps secret/env), or
 * 2. `PLATFORM_TENANT_REGISTRY_PATH` (file path), or
 * 3. Single-package fallback from `PLATFORM_TENANT_PACKAGE_DIR` + `PLATFORM_ENVIRONMENT`
 *    (Model A / local development & CI single-tenant package).
 */
export function loadActiveTenantRegistry(options?: {
  cwd?: string;
}): TenantRegistry {
  const inlineJson = process.env.PLATFORM_TENANT_REGISTRY_JSON?.trim();
  if (inlineJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inlineJson);
    } catch {
      throw new Error(
        'TENANT_REGISTRY_ERROR: PLATFORM_TENANT_REGISTRY_JSON is not valid JSON.',
      );
    }
    return validateTenantRegistry(parsed);
  }

  const fs = getNodeFs();
  const registryFilePath = process.env.PLATFORM_TENANT_REGISTRY_PATH?.trim();
  if (registryFilePath) {
    const absPath = path.resolve(options?.cwd ?? process.cwd(), registryFilePath);
    const rawText = fs.readFileSync(absPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(
        'TENANT_REGISTRY_ERROR: Tenant registry file is not valid JSON.',
      );
    }
    return validateTenantRegistry(parsed);
  }

  // R436: no defaults for the package, environment, hosting mode or host (rule 1; fail closed).
  const packageDir = requireRegistryEnv('PLATFORM_TENANT_PACKAGE_DIR');
  const rawEnv = requireRegistryEnv('PLATFORM_ENVIRONMENT');
  if (!PLATFORM_ENVIRONMENTS.includes(rawEnv as PlatformEnvironment)) {
    throw registryError(
      `TENANT_REGISTRY_ERROR: PLATFORM_ENVIRONMENT "${rawEnv}" is not a supported environment.`,
    );
  }
  const environment = rawEnv as PlatformEnvironment;
  const rawHostingMode = requireRegistryEnv('PLATFORM_HOSTING_MODE');
  if (rawHostingMode !== 'single_tenant' && rawHostingMode !== 'multi_tenant') {
    throw registryError(
      `TENANT_REGISTRY_ERROR: PLATFORM_HOSTING_MODE "${rawHostingMode}" must be single_tenant or multi_tenant.`,
    );
  }
  const hostingMode: HostingMode = rawHostingMode;

  const rootDir = options?.cwd ?? process.cwd();
  const basePath = path.join(rootDir, packageDir, 'config', 'base.json');
  const overlayPath = path.join(
    rootDir,
    packageDir,
    'config',
    'environments',
    `${environment}.json`,
  );

  const baseJson = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Record<
    string,
    unknown
  >;
  const overlayJson = fs.existsSync(overlayPath)
    ? (JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};

  const tenantId = String(overlayJson.tenantId ?? baseJson.tenantId ?? '').trim();
  const slug = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const dedicatedHost = (
    (overlayJson.database as { dedicatedServerHost?: string } | undefined)
      ?.dedicatedServerHost ??
    (baseJson.database as { dedicatedServerHost?: string } | undefined)
      ?.dedicatedServerHost ??
    ''
  ).trim();
  const postgresHost =
    dedicatedHost || requireRegistryEnv('PLATFORM_POSTGRES_HOST');
  const rawTimeZone =
    typeof overlayJson.timeZone === 'string' && overlayJson.timeZone.trim()
      ? overlayJson.timeZone.trim()
      : typeof baseJson.timeZone === 'string' && baseJson.timeZone.trim()
        ? baseJson.timeZone.trim()
        : 'Europe/London';

  return validateTenantRegistry({
    schemaVersion: '1.0.0',
    environment,
    hostingMode,
    tenants: [
      {
        tenantId,
        slug,
        environment,
        postgresHost,
        postgresDatabaseName: `pg_tenant_${slug}_${environment}`,
        postgresRoleName: `role_tenant_${slug}_${environment}`,
        keyVaultUri: extractVaultUriFromPackageConfig(
          baseJson,
          overlayJson,
          tenantId,
          environment,
        ),
        packageDir,
        timeZone: rawTimeZone,
        enabled: true,
      },
    ],
  });
}
