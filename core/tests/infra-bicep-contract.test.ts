import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INFRA_DIR = path.join(REPO_ROOT, 'core', 'infra');
const MAIN_BICEP_PATH = path.join(INFRA_DIR, 'main.bicep');
const PLATFORM_BICEP_PATH = path.join(INFRA_DIR, 'modules', 'platform.bicep');
const TENANT_BICEP_PATH = path.join(INFRA_DIR, 'modules', 'tenant.bicep');
const PG_ADMIN_BICEP_PATH = path.join(
  INFRA_DIR,
  'modules',
  'postgres-entra-admin.bicep',
);
const BICEP_CONFIG_PATH = path.join(INFRA_DIR, 'bicepconfig.json');

function resolveOptionalBicepBinary(): string | null {
  const isWin = process.platform === 'win32';
  const direct = isWin ? 'bicep.exe' : 'bicep';
  const directRes = spawnSync(direct, ['--version'], {
    stdio: 'ignore',
    shell: false,
  });
  if (directRes.status === 0) {
    return direct;
  }
  if (isWin && process.env.LOCALAPPDATA) {
    const wingetLinks = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Links',
      'bicep.exe',
    );
    if (fs.existsSync(wingetLinks)) {
      return wingetLinks;
    }
    const packagesDir = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft',
      'WinGet',
      'Packages',
    );
    if (fs.existsSync(packagesDir)) {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('Microsoft.Bicep')) {
          const candidate = path.join(packagesDir, entry.name, 'bicep.exe');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    }
  }
  return null;
}

describe('S0-13: Azure Container Apps & PostgreSQL Bicep infrastructure contracts', () => {
  const mainBicep = fs.readFileSync(MAIN_BICEP_PATH, 'utf8');
  const platformBicep = fs.readFileSync(PLATFORM_BICEP_PATH, 'utf8');
  const tenantBicep = fs.readFileSync(TENANT_BICEP_PATH, 'utf8');
  const pgAdminBicep = fs.readFileSync(PG_ADMIN_BICEP_PATH, 'utf8');
  const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');
  const platformNoComments = stripComments(platformBicep);
  const allBicepCombined = [
    mainBicep,
    platformBicep,
    tenantBicep,
    pgAdminBicep,
  ].join('\n');

  it('removes legacy App Service resources and composes shared platform + per-tenant modules for both hosting models', () => {
    expect(allBicepCombined).not.toContain('Microsoft.Web/serverfarms');
    expect(allBicepCombined).not.toContain('Microsoft.Web/sites');
    expect(allBicepCombined).not.toContain('snet-appservice');
    expect(allBicepCombined).not.toContain('@Microsoft.KeyVault(');

    expect(mainBicep).toContain("module platform 'modules/platform.bicep'");
    expect(mainBicep).toContain("module tenantDeployments 'modules/tenant.bicep'");
    expect(mainBicep).toContain("'single_tenant'");
    expect(mainBicep).toContain("'multi_tenant'");
    expect(mainBicep).toContain("'demo'");
  });

  it('separates migrateIdentity (PostgreSQL Entra admin, port 5432, migrate job only) from runtimeIdentity (non-admin, port 6432, web & jobs) (R401, R402)', () => {
    expect(platformBicep).toContain('resource runtimeIdentity');
    expect(platformBicep).toContain('resource migrateIdentity');

    // Only migrateIdentity is passed to PostgreSQL Entra administrator assignment
    expect(platformBicep).toContain(
      "module sharedPostgresEntraAdmin 'postgres-entra-admin.bicep'",
    );
    expect(platformBicep).toContain(
      'principalId: migrateIdentity.properties.principalId',
    );
    expect(platformBicep).toContain('principalName: migrateIdentity.name');
    expect(platformBicep).not.toContain(
      'principalId: runtimeIdentity.properties.principalId\r\n    principalName: runtimeIdentity.name',
    );
    expect(tenantBicep).toContain('name: migrateIdentityPrincipalId');
    expect(tenantBicep).toContain('principalName: migrateIdentityName');
    expect(pgAdminBicep).toContain(
      'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
    );


    // Web app uses runtimeIdentity on PgBouncer port 6432 and waits for RBAC role assignments
    const webAppBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource webContainerApp'),
      platformNoComments.indexOf('resource provisionJob'),
    );
    expect(webAppBlock).toContain("'${runtimeIdentity.id}': {}");
    expect(webAppBlock).not.toContain('migrateIdentity');
    expect(webAppBlock).toContain('runtimePlatformKvSecretsUserRole');
    expect(webAppBlock).toContain('runtimeAcrPullRole');

    // Runtime common env uses runtimePostgresPort ('6432' on GeneralPurpose/MemoryOptimized with PgBouncer, '5432' on Burstable)
    const runtimeEnvBlock = platformBicep.slice(
      platformBicep.indexOf('var runtimeCommonEnv ='),
      platformBicep.indexOf('var optionalIdealPostcodesEnv ='),
    );
    expect(runtimeEnvBlock).toContain("name: 'PLATFORM_POSTGRES_PORT'");
    expect(runtimeEnvBlock).toContain('value: runtimePostgresPort');
    expect(platformBicep).toContain(
      "var runtimePostgresPort = enablePgBouncer ? '6432' : '5432'",
    );
    expect(runtimeEnvBlock).toContain('runtimeIdentity.properties.clientId');

    // Provision job uses migrateIdentity ONLY and connects directly to port 5432 bypassing PgBouncer
    const provisionJobBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource provisionJob'),
      platformNoComments.indexOf('resource migrateJob'),
    );
    expect(provisionJobBlock).toContain("'${migrateIdentity.id}': {}");
    expect(provisionJobBlock).not.toContain('runtimeIdentity');
    expect(provisionJobBlock).toContain("name: 'PLATFORM_POSTGRES_PORT'");
    expect(provisionJobBlock).toContain("name: 'PLATFORM_POSTGRES_MIGRATE_PORT'");
    expect(provisionJobBlock).toContain("value: '5432'");
    expect(provisionJobBlock).not.toContain("value: '6432'");
    expect(provisionJobBlock).toContain('migrateAcrPullRole');
    expect(provisionJobBlock).toContain('sharedPostgresEntraAdmin');

    // Migrate job uses migrateIdentity ONLY and connects directly to port 5432 bypassing PgBouncer
    const migrateJobBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource migrateJob'),
      platformNoComments.indexOf('resource keyDateRemindersJob'),
    );
    expect(migrateJobBlock).toContain("'${migrateIdentity.id}': {}");
    expect(migrateJobBlock).not.toContain('runtimeIdentity');
    expect(migrateJobBlock).toContain("name: 'PLATFORM_POSTGRES_PORT'");
    expect(migrateJobBlock).toContain("name: 'PLATFORM_POSTGRES_MIGRATE_PORT'");
    expect(migrateJobBlock).toContain("value: '5432'");
    expect(migrateJobBlock).not.toContain("value: '6432'");
    expect(migrateJobBlock).toContain('migrateAcrPullRole');
    expect(migrateJobBlock).toContain('sharedPostgresEntraAdmin');

    const nonMigrateJobsBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource keyDateRemindersJob'),
      platformNoComments.indexOf('output vnetId'),
    );
    expect(nonMigrateJobsBlock).toContain("'${runtimeIdentity.id}': {}");
    expect(nonMigrateJobsBlock).not.toContain('migrateIdentity');
    expect(platformBicep).not.toContain('storeImportJob');
    expect(platformBicep).not.toContain('enableStoreImportJob');
  });

  it('enforces Entra ID auth only, TLS 1.2+, and explicit PgBouncer TRANSACTION pool mode on both shared and dedicated PostgreSQL servers (R401)', () => {
    for (const [label, content] of [
      ['platform.bicep', platformBicep],
      ['tenant.bicep', tenantBicep],
    ] as const) {
      expect(content, `${label} activeDirectoryAuth`).toContain(
        "activeDirectoryAuth: 'Enabled'",
      );
      expect(content, `${label} passwordAuth`).toContain(
        "passwordAuth: 'Disabled'",
      );
      expect(content, `${label} require_secure_transport`).toContain(
        "name: 'require_secure_transport'",
      );
      expect(content, `${label} TLSv1.2`).toContain("value: 'TLSv1.2'");
      expect(content, `${label} pgbouncer.enabled`).toContain(
        "name: 'pgbouncer.enabled'",
      );
      expect(content, `${label} pgbouncer.pool_mode`).toContain(
        "name: 'pgbouncer.pool_mode'",
      );
      expect(content, `${label} TRANSACTION pool mode`).toContain(
        "value: 'TRANSACTION'",
      );
      expect(content, `${label} azure.extensions`).toContain(
        "name: 'azure.extensions'",
      );
      expect(content, `${label} PG_TRGM allowlist`).toContain(
        "value: 'PG_TRGM'",
      );
    }

    expect(tenantBicep).toContain('param deployDedicatedPostgresServer bool = false');
    expect(tenantBicep).toContain(
      "var postgresDatabaseName = 'pg_tenant_${underscoredSlug}_${environment}'",
    );
  });

  it('runs bundled dist/jobs/ entry points for migrate and scheduled jobs, and defines the Application Insights job failure alert rule (R403, R404, R412)', () => {
    expect(platformBicep).not.toContain('scripts/run-job');
    expect(platformBicep).not.toContain('tsx');

    expect(platformBicep).toContain("'dist/jobs/run-job.mjs'");
    expect(platformBicep).toContain("'migrate'");
    expect(platformBicep).not.toContain("'dist/jobs/import-store.mjs'");
    expect(platformBicep).toContain("'key-date-reminders'");
    expect(platformBicep).toContain("'usage-retention-purge'");
    expect(platformBicep).toContain("'enquiry-retention-anonymise'");
    expect(platformBicep).toContain("'register-reminders'");
    expect(platformBicep).toContain("'quote-expiry'");
    expect(platformBicep).toContain('param enableSchedulerJobs bool = true');
    expect(platformBicep).toContain('param enableKeyDateRemindersJob bool = true');
    expect(platformBicep).toContain('param enableUsageRetentionPurgeJob bool = true');
    expect(platformBicep).toContain('param enableEnquiryAnonymisationJob bool = true');
    expect(platformBicep).toContain('param enableRegisterRemindersJob bool = true');
    expect(platformBicep).toContain('param enableOutboxDrainJob bool = true');
    expect(platformBicep).toContain('param enableNotificationDigestsJob bool = true');
    expect(platformBicep).toContain('param enableQuoteExpiryJob bool = true');
    expect(platformBicep).toContain("cronExpression: '0 * * * *'");

    // Internal-only PDF converter Container App
    const pdfBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource pdfConverterContainerApp'),
      platformNoComments.indexOf('resource webContainerApp'),
    );
    expect(pdfBlock).toContain('external: false');
    expect(pdfBlock).toContain('allowInsecure: false');

    // Scheduled query alert rule for job failures & timeouts (ADR 0030 §7, R412, R485)
    expect(platformBicep).toContain('Microsoft.Insights/scheduledQueryRules');
    expect(platformBicep).toContain('job.tenant.failed');
    expect(platformBicep).toContain('DeadlineExceeded');
    expect(platformBicep).toContain(
      'Reason_s in~ ("BackoffLimitExceeded", "DeadlineExceeded", "Failed")',
    );
    expect(platformBicep).toContain('exited with status Failed');
    expect(platformBicep).toContain('ContainerAppConsoleLogs_CL');
    expect(platformBicep).toContain('failedPermanentCount');
    expect(platformBicep).toContain('AppTraces');
    expect(platformBicep).toContain('AppDependencies');
    expect(platformBicep).toContain('AppExceptions');
  });

  it('enforces Key Vault Private Endpoints (publicNetworkAccess Disabled), exports keyVaultName/keyVaultUri, applies tenant cost tags, and contains zero inline secret values (R413, Rule 5)', () => {
    for (const [label, content] of [
      ['platform.bicep', platformBicep],
      ['tenant.bicep', tenantBicep],
    ] as const) {
      expect(content, `${label} Key Vault publicNetworkAccess`).toContain(
        "publicNetworkAccess: 'Disabled'",
      );
      expect(content, `${label} Key Vault defaultAction`).toContain(
        "defaultAction: 'Deny'",
      );
      expect(content, `${label} Key Vault RBAC`).toContain(
        'enableRbacAuthorization: true',
      );
      expect(content, `${label} Key Vault purge protection`).toContain(
        'enablePurgeProtection: true',
      );
      expect(content, `${label} Private Endpoint`).toContain(
        'Microsoft.Network/privateEndpoints',
      );
    }

    // R413/R428: tenant.bicep outputs a collision-safe 24-char keyVaultName and keyVaultUri
    expect(tenantBicep).toContain(
      "var keyVaultResourceName = 'kv${take(sanitizedSlug, 9)}${globalNameHash}'",
    );
    expect(tenantBicep).toContain('output keyVaultName string = keyVault.name');
    expect(tenantBicep).toContain(
      'output keyVaultUri string = keyVault.properties.vaultUri',
    );

    // Tenant cost & governance tags (Standard §13)
    expect(tenantBicep).toContain('tenant: tenantSlug');
    expect(tenantBicep).toContain('costCentre: costCentre');
    expect(tenantBicep).toContain('hostingMode: hostingMode');

    // Container Apps secrets block references Key Vault URLs only, never inline secret `value:`
    const secretsArrayBlock = platformBicep.slice(
      platformBicep.indexOf('var runtimeKeyVaultSecrets = ['),
      platformBicep.indexOf('var runtimeCommonEnv = ['),
    );
    expect(secretsArrayBlock).toContain('keyVaultUrl:');
    expect(secretsArrayBlock).not.toMatch(/\bvalue\s*:/);

    const bicepConfig = JSON.parse(fs.readFileSync(BICEP_CONFIG_PATH, 'utf8'));
    expect(
      bicepConfig.analyzers?.core?.rules?.['outputs-should-not-contain-secrets']
        ?.level,
    ).toBe('error');
    expect(
      bicepConfig.analyzers?.core?.rules?.['secure-secrets-in-params']?.level,
    ).toBe('error');
  });

  it('grants Monitoring Metrics Publisher on Application Insights to both identities and exposes AZURE_CLIENT_ID, because local auth is disabled (R422)', () => {
    expect(platformBicep).toContain('DisableLocalAuth: true');
    expect(platformBicep).toContain("'3913510d-42f4-4e42-8a64-420c390055eb'");
    for (const [roleName, identity] of [
      ['runtimeAppInsightsMetricsPublisherRole', 'runtimeIdentity'],
      ['migrateAppInsightsMetricsPublisherRole', 'migrateIdentity'],
    ] as const) {
      const start = platformNoComments.indexOf(`resource ${roleName} `);
      expect(start, roleName).toBeGreaterThan(-1);
      const block = platformNoComments.slice(
        start,
        platformNoComments.indexOf('\n}', start),
      );
      expect(block).toContain('scope: appInsights');
      expect(block).toContain(
        'roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId',
      );
      expect(block).toContain(`principalId: ${identity}.properties.principalId`);
    }

    const runtimeEnvBlock = platformBicep.slice(
      platformBicep.indexOf('var runtimeCommonEnv ='),
      platformBicep.indexOf('var optionalIdealPostcodesEnv ='),
    );
    expect(runtimeEnvBlock).toMatch(
      /name: 'AZURE_CLIENT_ID'\s+value: runtimeIdentity\.properties\.clientId/,
    );

    const resourceBlock = (name: string, next: string) =>
      platformNoComments.slice(
        platformNoComments.indexOf(`resource ${name} `),
        platformNoComments.indexOf(`resource ${next} `),
      );
    const provisionJobBlock = resourceBlock('provisionJob', 'migrateJob');
    expect(provisionJobBlock).toMatch(
      /name: 'AZURE_CLIENT_ID'\s+value: migrateIdentity\.properties\.clientId/,
    );
    expect(provisionJobBlock).toContain('migrateAppInsightsMetricsPublisherRole');
    const migrateJobBlock = resourceBlock('migrateJob', 'keyDateRemindersJob');
    expect(migrateJobBlock).toMatch(
      /name: 'AZURE_CLIENT_ID'\s+value: migrateIdentity\.properties\.clientId/,
    );
    expect(migrateJobBlock).toContain('migrateAppInsightsMetricsPublisherRole');
    for (const [name, next] of [
      ['webContainerApp', 'provisionJob'],
      ['keyDateRemindersJob', 'usageRetentionPurgeJob'],
      ['usageRetentionPurgeJob', 'enquiryAnonymisationJob'],
      ['enquiryAnonymisationJob', 'registerRemindersJob'],
      ['registerRemindersJob', 'outboxDrainJob'],
      ['outboxDrainJob', 'notificationDigestsJob'],
      ['notificationDigestsJob', 'quoteExpiryJob'],
      ['quoteExpiryJob', 'seedDemoJob'],
    ] as const) {
      expect(resourceBlock(name, next), name).toContain(
        'runtimeAppInsightsMetricsPublisherRole',
      );
    }
    expect(platformBicep).toContain('outbox.delivery.failed_permanent');
    expect(platformBicep).toContain('caj-outbox-drain-${environment}');
    expect(platformBicep).toContain('caj-ntf-dig-${environment}');
    expect(platformBicep).toContain('caj-quo-exp-${environment}');
    expect(
      platformNoComments.slice(
        platformNoComments.indexOf('resource seedDemoJob '),
      ),
    ).toContain('runtimeAppInsightsMetricsPublisherRole');
  });

  it('derives Key Vault and storage names that differ per environment and region even for slugs of 20+ characters (R428)', () => {
    expect(tenantBicep).toContain(
      'var globalNameHash = uniqueString(resourceGroup().id, tenantSlug, environment)',
    );
    expect(tenantBicep).toContain(
      "var storageAccountName = 'st${take(sanitizedSlug, 9)}${globalNameHash}'",
    );
    expect(platformBicep).toContain(
      "var platformKeyVaultName = 'kvp${take(sanitizedPlatformSlug, 8)}${uniqueString(resourceGroup().id, platformSlug, environment)}'",
    );

    // Model the expressions: uniqueString always returns 13 characters, so the hash
    // (which varies by resource group, slug and environment) must survive in full
    // within the 24-character Key Vault and storage account limits.
    const UNIQUE_STRING_LENGTH = 13;
    const slug = 'an-invented-very-long-firm-slug';
    expect(slug.replace(/-/g, '').length).toBeGreaterThanOrEqual(20);
    const sanitized = slug.replace(/-/g, '');
    const fakeHash = (env: string) => `h${env}`.padEnd(UNIQUE_STRING_LENGTH, 'x');
    const names = (env: string) => ({
      kv: `kv${sanitized.slice(0, 9)}${fakeHash(env)}`,
      st: `st${sanitized.slice(0, 9)}${fakeHash(env)}`,
      platformKv: `kvp${sanitized.slice(0, 8)}${fakeHash(env)}`,
    });
    const test = names('test');
    const live = names('live');
    for (const key of ['kv', 'st', 'platformKv'] as const) {
      expect(test[key].length, key).toBeLessThanOrEqual(24);
      expect(live[key].length, key).toBeLessThanOrEqual(24);
      expect(test[key], key).not.toBe(live[key]);
    }
    expect(tenantBicep).not.toMatch(/take\('kv-\$\{sanitizedSlug\}/);
    expect(tenantBicep).not.toMatch(/take\('st\$\{sanitizedSlug\}/);
  });

  it('compiles main.bicep and demo.bicepparam into valid ARM templates and passes bicep lint with zero errors or warnings when Bicep CLI is installed', () => {
    const bicepBin = resolveOptionalBicepBinary();
    if (!bicepBin) {
      return;
    }
    const res = spawnSync(bicepBin, ['build', MAIN_BICEP_PATH, '--stdout'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(res.stderr?.trim() ?? '').toBe('');
    expect(res.status).toBe(0);
    const compiledArm = JSON.parse(res.stdout);
    expect(compiledArm.$schema).toContain('deploymentTemplate.json');
    expect(compiledArm.resources).toBeDefined();

    const lintRes = spawnSync(bicepBin, ['lint', MAIN_BICEP_PATH], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(lintRes.stderr?.trim() ?? '').toBe('');
    expect(lintRes.status).toBe(0);

    const demoParamPath = path.join(INFRA_DIR, 'parameters', 'demo.bicepparam');
    const paramRes = spawnSync(
      bicepBin,
      ['build-params', demoParamPath, '--stdout'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(paramRes.stderr?.trim() ?? '').toBe('');
    expect(paramRes.status).toBe(0);
    const compiledParams = JSON.parse(paramRes.stdout) as {
      parametersJson: string;
    };
    const parsedParams = JSON.parse(compiledParams.parametersJson) as {
      parameters: Record<string, { value: unknown }>;
    };
    expect(parsedParams.parameters.environment?.value).toBe('demo');
    expect(parsedParams.parameters.tenantSlug?.value).toBe('not-a-law-firm');
    expect(parsedParams.parameters.entraClientId?.value).toBe(
      '0a1a7a83-367f-426b-aaa3-70c288541d1d',
    );
    expect(parsedParams.parameters.entraTenantId?.value).toBe(
      'f8218d9a-e055-463f-add2-f03679aad7f2',
    );
  });

  it('provisions Azure Container Registry, supports two-stage deployApps toggle, optional API secret toggles, provisionJob, and non-live seedDemoJob guard (S0-11b)', () => {
    expect(platformBicep).toContain(
      "resource containerRegistry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {",
    );
    expect(platformBicep).not.toContain(
      "resource containerRegistry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing",
    );
    expect(platformBicep).toContain("name: environment == 'live' ? 'Premium' : 'Basic'");
    expect(platformBicep).toContain('adminUserEnabled: false');
    expect(mainBicep).toContain('output containerRegistryName string');
    expect(mainBicep).toContain('output containerRegistryLoginServer string');

    expect(mainBicep).toContain('param deployApps bool = true');
    expect(platformBicep).toContain('param deployApps bool = true');
    expect(platformBicep).toContain('param enableIdealPostcodesSecret bool = false');
    expect(platformBicep).toContain('param enableAnthropicSecret bool = false');
    expect(platformBicep).toContain("param enableSeedDemoJob bool = environment != 'live'");
    expect(platformBicep).toContain(
      "fail('SEED_DEMO_LIVE_FORBIDDEN: enableSeedDemoJob cannot be true when environment is live.')",
    );
    expect(platformBicep).toContain("'provision'");
    expect(platformBicep).toContain("'seed-demo'");
    expect(platformBicep).toContain("name: 'DEMO_ENTRA_MAP_JSON'");
  });

  it('R578, R580, R581, R582: enforces demo single-replica & /app/data writable ownership, /api/health/live + /api/health/ready probes, required alertRecipientEmail + Action Group in demo/live, and non-empty ca-pdf image guard', () => {
    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, 'Dockerfile'),
      'utf8',
    );
    const demoParams = fs.readFileSync(
      path.join(INFRA_DIR, 'parameters', 'demo.bicepparam'),
      'utf8',
    );

    // R578 (D4) & R613: local-fs web app pinned to 1 replica across all environments and /app/data writable by USER node
    expect(platformBicep).toContain(
      "param webMaxReplicas int = documentStorageProvider == 'local-fs' ? 1 : 10",
    );
    expect(platformBicep).toContain('LOCAL_FS_SINGLE_REPLICA_REQUIRED');
    expect(demoParams).toContain("param documentStorageProvider = 'local-fs'");
    expect(demoParams).toContain('param webMaxReplicas = 1');
    const mkdirIdx = dockerfile.indexOf('chown -R node:node /app/data');
    const userNodeIdx = dockerfile.indexOf('USER node');
    expect(mkdirIdx).toBeGreaterThan(-1);
    expect(userNodeIdx).toBeGreaterThan(mkdirIdx);

    // R580: health probes target /api/health/live and /api/health/ready (not /login)
    const webAppBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource webContainerApp'),
      platformNoComments.indexOf('resource provisionJob'),
    );
    expect(webAppBlock).toContain("path: '/api/health/live'");
    expect(webAppBlock).toContain("path: '/api/health/ready'");
    expect(webAppBlock).not.toContain("path: '/login'");

    // R581: Action Group provisioned from alertRecipientEmail and required in demo/live
    expect(mainBicep).toContain("param alertRecipientEmail string = ''");
    expect(platformBicep).toContain("param alertRecipientEmail string = ''");
    expect(platformBicep).toContain('Microsoft.Insights/actionGroups');
    expect(platformBicep).toContain('ALERT_RECIPIENT_REQUIRED');

    // R582 (D5): ca-pdf cannot be enabled with an empty container image
    expect(platformBicep).toContain('PDF_CONVERTER_IMAGE_REQUIRED');
  });

  it('R611 & R613: enforces Startup probe and 5s/3x probe thresholds, and guards local-fs single replica across all environments', () => {
    // R613: documentStorageProvider parameter + global local-fs single-replica guard
    expect(mainBicep).toMatch(/param documentStorageProvider string/);
    expect(platformBicep).toMatch(/param documentStorageProvider string/);
    expect(platformBicep).toContain(
      "param webMaxReplicas int = documentStorageProvider == 'local-fs' ? 1 : 10",
    );
    expect(platformBicep).toContain('LOCAL_FS_SINGLE_REPLICA_REQUIRED');
    expect(platformBicep).toContain("documentStorageProvider == 'local-fs'");
    expect(platformBicep).toContain('STORAGE_LIVE_LOCAL_FS_FORBIDDEN');

    // R611: Startup probe on /api/health/live + timeoutSeconds: 5 & failureThreshold: 3 on Liveness & Readiness
    const webAppBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource webContainerApp'),
      platformNoComments.indexOf('resource provisionJob'),
    );
    expect(webAppBlock).toContain("type: 'Startup'");
    expect(webAppBlock).toMatch(/type:\s*'Liveness'[\s\S]*?timeoutSeconds:\s*5[\s\S]*?failureThreshold:\s*3/);
    expect(webAppBlock).toMatch(/type:\s*'Readiness'[\s\S]*?timeoutSeconds:\s*5[\s\S]*?failureThreshold:\s*3/);
  });

  it('R620, R631 & R640: enforces ARM probe bounds (initialDelaySeconds 0..60, periodSeconds 1..240, failureThreshold 1..10, timeoutSeconds 1..240), Startup probe 5s/10s/5s/10x, azure-blob fail() guard, and PLATFORM_DOCUMENT_STORAGE_PROVIDER env wiring', () => {
    const webAppBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource webContainerApp'),
      platformNoComments.indexOf('resource provisionJob'),
    );
    const probeBlocks = Array.from(
      webAppBlock.matchAll(
        /\{\s*type:\s*'(Startup|Liveness|Readiness)'[\s\S]*?failureThreshold:\s*(\d+)\s*\}/g,
      ),
    );
    expect(probeBlocks.map((m) => m[1])).toEqual(['Startup', 'Liveness', 'Readiness']);
    for (const block of probeBlocks) {
      const initialDelayMatch = block[0].match(/initialDelaySeconds:\s*(\d+)/);
      const periodMatch = block[0].match(/periodSeconds:\s*(\d+)/);
      const timeoutMatch = block[0].match(/timeoutSeconds:\s*(\d+)/);
      expect(initialDelayMatch, block[1]).not.toBeNull();
      expect(periodMatch, block[1]).not.toBeNull();
      expect(timeoutMatch, block[1]).not.toBeNull();
      const initialDelaySeconds = Number(initialDelayMatch![1]);
      const periodSeconds = Number(periodMatch![1]);
      const timeoutSeconds = Number(timeoutMatch![1]);
      const failureThreshold = Number(block[2]);
      expect(initialDelaySeconds, `${block[1]} initialDelaySeconds`).toBeGreaterThanOrEqual(0);
      expect(initialDelaySeconds, `${block[1]} initialDelaySeconds`).toBeLessThanOrEqual(60);
      expect(periodSeconds, `${block[1]} periodSeconds`).toBeGreaterThanOrEqual(1);
      expect(periodSeconds, `${block[1]} periodSeconds`).toBeLessThanOrEqual(240);
      expect(timeoutSeconds, `${block[1]} timeoutSeconds`).toBeGreaterThanOrEqual(1);
      expect(timeoutSeconds, `${block[1]} timeoutSeconds`).toBeLessThanOrEqual(240);
      expect(failureThreshold, `${block[1]} failureThreshold`).toBeGreaterThanOrEqual(1);
      expect(failureThreshold, `${block[1]} failureThreshold`).toBeLessThanOrEqual(10);
    }

    // R620: Startup probe explicitly sets 5s initial delay, 10s period, 5s timeout, failureThreshold 10 (~105s window)
    expect(webAppBlock).toMatch(
      /type:\s*'Startup'[\s\S]*?initialDelaySeconds:\s*5[\s\S]*?periodSeconds:\s*10[\s\S]*?timeoutSeconds:\s*5[\s\S]*?failureThreshold:\s*10/,
    );

    // R631: Bicep refuses unimplemented azure-blob at deployment time and passes PLATFORM_DOCUMENT_STORAGE_PROVIDER into runtimeCommonEnv
    expect(platformBicep).toContain('AZURE_BLOB_STORAGE_NOT_IMPLEMENTED');
    expect(platformBicep).toContain('var azureBlobUnimplementedGuard');
    expect(platformBicep).toMatch(
      /resource webContainerApp[^=]*= if\s*\([^)]*azureBlobUnimplementedGuard/,
    );
    expect(platformBicep).toMatch(
      /name:\s*'PLATFORM_DOCUMENT_STORAGE_PROVIDER'\s+value:\s*documentStorageProvider/,
    );
  });

  it('R655: copies tenant extension manifests into the Docker runtime stage for bundled-only execution', () => {
    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, 'Dockerfile'),
      'utf8',
    );
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));
    const userNodeIdx = runnerStage.indexOf('USER node');
    const copyManifestsIdx = runnerStage.indexOf('runtime-tenant-extensions');
    expect(copyManifestsIdx).toBeGreaterThan(-1);
    expect(userNodeIdx).toBeGreaterThan(copyManifestsIdx);
    expect(dockerfile).toContain('manifest.json');
    expect(runnerStage).toContain('--chown=node:node');
  });

  it('S1-10: configures internal-only ca-pdf probes, pdfConverterMinReplicas parameter, disabled default, and DOC_CONVERTER_URL on web app and all 7 scheduled jobs', () => {
    const demoParams = fs.readFileSync(
      path.join(INFRA_DIR, 'parameters', 'demo.bicepparam'),
      'utf8',
    );
    expect(mainBicep).toMatch(/@minValue\(0\)[\s\S]*?@maxValue\(4\)[\s\S]*?param pdfConverterMinReplicas int = 0/);
    expect(platformBicep).toMatch(/@minValue\(0\)[\s\S]*?@maxValue\(4\)[\s\S]*?param pdfConverterMinReplicas int = 0/);
    expect(mainBicep).toContain('pdfConverterMinReplicas: pdfConverterMinReplicas');
    expect(mainBicep).toContain('param enablePdfConverterContainerApp bool = false');
    expect(platformBicep).toContain('param enablePdfConverterContainerApp bool = false');
    expect(demoParams).toContain('param enablePdfConverterContainerApp = false');

    const pdfBlock = platformNoComments.slice(
      platformNoComments.indexOf('resource pdfConverterContainerApp'),
      platformNoComments.indexOf('resource webContainerApp'),
    );
    expect(pdfBlock).toContain('external: false');
    expect(pdfBlock).toContain('allowInsecure: false');
    expect(pdfBlock).toContain('targetPort: 8080');
    expect(pdfBlock).toContain('minReplicas: pdfConverterMinReplicas');
    expect(pdfBlock).toMatch(/type:\s*'Startup'[\s\S]*?path:\s*'\/health\/live'[\s\S]*?port:\s*8080/);
    expect(pdfBlock).toMatch(/type:\s*'Liveness'[\s\S]*?path:\s*'\/health\/live'[\s\S]*?port:\s*8080[\s\S]*?timeoutSeconds:\s*5[\s\S]*?failureThreshold:\s*3/);
    expect(pdfBlock).toMatch(/type:\s*'Readiness'[\s\S]*?path:\s*'\/health\/ready'[\s\S]*?port:\s*8080[\s\S]*?timeoutSeconds:\s*5[\s\S]*?failureThreshold:\s*3/);

    const resourceBlock = (name: string, next: string) =>
      platformNoComments.slice(
        platformNoComments.indexOf(`resource ${name} `),
        platformNoComments.indexOf(`resource ${next} `),
      );
    const webAppBlock = resourceBlock('webContainerApp', 'provisionJob');
    expect(webAppBlock).toContain('pdfConverterEnv');
    for (const [name, next] of [
      ['keyDateRemindersJob', 'usageRetentionPurgeJob'],
      ['usageRetentionPurgeJob', 'enquiryAnonymisationJob'],
      ['enquiryAnonymisationJob', 'registerRemindersJob'],
      ['registerRemindersJob', 'outboxDrainJob'],
      ['outboxDrainJob', 'notificationDigestsJob'],
      ['notificationDigestsJob', 'quoteExpiryJob'],
      ['quoteExpiryJob', 'seedDemoJob'],
    ] as const) {
      expect(resourceBlock(name, next), name).toContain(
        'env: concat(runtimeCommonEnv, pdfConverterEnv)',
      );
    }
  });
});
