import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTenantCacheKey,
   collectConfigDeprecationWarnings,
  ConflictReviewConfigSubSchema,
  CORE_API_VERSION,
  CORE_TENANT_MIGRATIONS,
  DOCUMENT_GENERATION_MIGRATION_0001,
  DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
  ExtensionHookPointSchema,
  ExtensionHost,
  ExtensionManifestSchema,
  ExtensionPermissionSchema,
  FirmConfigSubSchema,
  KEY_DATES_MIGRATION_0003,
  loadAndValidateTenantConfig,
  PostgresTenantCluster,
  resolveTenantFromVerifiedToken,
  resolveTenantPostgresConfig,
  runTenantBackgroundJob,
  TenantMigrationRunner,
  validateExtensionManifest,
  validateMigrationCatalogueOrder,
  type PlatformExtension,
} from '@platform/core';
import extensionManifestJsonSchema from '../schemas/extension-manifest.schema.json';
import tenantConfigJsonSchema from '../schemas/tenant-config.schema.json';
import { generateExtensionRegistry } from '../../scripts/generate-extension-registry';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';
import { notALawFirmMatterCostsExtension } from '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance/src/index';
import { syncHomeRolesWithEmployeeRoles } from '../../src/domain/homeConfig';
import { createDefaultMatterCostsConfig } from '../../src/domain/matterCosts';
import { buildDefaultOrgStructure } from '../../src/domain/orgStructure';
import {
  getDefaultTenantRbacConfig,
  resolveConfiguredFirmPrimaryDomain,
  runWithActiveActorSession,
  setRuntimeRbacConfigOverride,
} from '../../src/server/rbacRuntime';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getExtensionHostLoadErrors,
  getPlatformExtensionHost,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  createOrProposeKeyDateRecord,
  flagMatterWriteOff,
  getAppSnapshot,
  getMatterPmsViewBundle,
  isDemoModeEnabled,
  liftMatterRestriction,
  markEngagementLetterDrafted,
  recordInvoiceCreditControlAction,
  requestMatterBill,
  resetAllDemoData,
  runMatterConflictSearchRecord,
  saveMatterRecord,
  savePersonRecord,
  updateMatterConflictRecord,
} from '../../src/server/services';
import { getStore } from '../../src/server/store';

describe('Platform Architecture Standard — Two-Tenant Isolation & Contract Tests', () => {
  const tenantAToken = {
    __verifiedByOidcMiddleware: true as const,
    sub: 'user-a1',
    tenantId: 'not-a-law-firm',
    email: 'partner@notalawfirm.example',
    name: 'Alice Vance',
    roles: ['partner', 'admin'],
    mfaVerified: true,
  };

  const tenantBToken = {
    __verifiedByOidcMiddleware: true as const,
    sub: 'user-b1',
    tenantId: 'fictional-chambers-uk',
    email: 'partner@fictionalchambers.co.uk',
    name: 'Bernard Sterling',
    roles: ['partner'],
    mfaVerified: true,
  };

  it('isolates data between two tenants and blocks tampered record IDs across tenants', () => {
    const cluster = new PostgresTenantCluster();

    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-a-001',
    });

    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: tenantBToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-b-001',
    });

    expect(ctxA.postgresDatabaseName).not.toBe(ctxB.postgresDatabaseName);
    expect(ctxA.blobContainerName).not.toBe(ctxB.blobContainerName);

    cluster.putRecord(ctxA, {
      id: 'MAT-0001',
      tenantId: ctxA.tenantId,
      title: 'Tenant A Confidential Matter',
    });

    cluster.putRecord(ctxB, {
      id: 'MAT-0002',
      tenantId: ctxB.tenantId,
      title: 'Tenant B Confidential Matter',
    });

    // Tenant A can read its own record, but gets null when querying Tenant B's record ID
    expect(cluster.getRecordById(ctxA, 'MAT-0001')?.id).toBe('MAT-0001');
    expect(cluster.getRecordById(ctxA, 'MAT-0002')).toBeNull();
    expect(cluster.listRecords(ctxA)).toHaveLength(1);

    // Attempting to write a record with a forged/mismatched tenantId is rejected
    expect(() =>
      cluster.putRecord(ctxA, {
        id: 'MAT-TAMPERED',
        tenantId: ctxB.tenantId,
        title: 'Cross-tenant write attempt',
      }),
    ).toThrow(/TENANCY_ISOLATION_ERROR/);
  });

  it('rejects unverified tokens and forged request tenant overrides', () => {
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-forgery-001',
        untrustedRequestTenantOverride: 'fictional-chambers-uk',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // R55: resolveCurrentTenantContext() with no argument throws TENANCY_AUTH_ERROR
    expect(() => resolveCurrentTenantContext()).toThrow(/TENANCY_AUTH_ERROR/);

    // R77: Plain unbranded object is rejected at compile time by tsc on both resolveCurrentTenantContext and createVerifiedSessionActorFromEntraSession
    expect(() =>
      // @ts-expect-error R77: resolveCurrentTenantContext requires a branded VerifiedSessionActorInput
      resolveCurrentTenantContext({
        id: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        name: 'Dafydd Evans',
      }),
    ).toBeDefined();

    expect(() =>
      // @ts-expect-error R77: createVerifiedSessionActorFromEntraSession requires a branded VerifiedEntraSessionPayload
      createVerifiedSessionActorFromEntraSession({
        personId: 'P-000002',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: '00000000-0000-4000-8000-000000000000',
        sub: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: '2026-10-31T10:00:00Z',
        expiresAt: '2099-10-31T18:00:00Z',
      }),
    ).toThrow(/TENANCY_AUTH_ERROR/);

    // R55: resolveCurrentTenantContext rejects a forged tenantId that differs from the active tenant / session
    const signedSession = verifySignedEntraSessionCookie(
      createSignedEntraSessionCookie({
        personId: 'P-000002',
        tenantId: 'fictional-chambers-uk',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: '00000000-0000-4000-8000-000000000000',
        sub: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: '2026-10-31T10:00:00Z',
        expiresAt: '2099-10-31T18:00:00Z',
      }),
    )!;
    expect(() =>
      resolveCurrentTenantContext(
        createVerifiedSessionActorFromEntraSession(signedSession),
      ),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // R102: Setting PLATFORM_TENANT_PACKAGE_DIR to a non-existent directory or leaving it unset in production causes getActiveTenantConfiguration() to throw
    const prevDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      setActiveTenantConfigForTesting(null);
      process.env.PLATFORM_TENANT_PACKAGE_DIR = 'non-existent-tenant-package-dir';
      expect(() => getActiveTenantConfiguration()).toThrow(/TENANT_CONFIG_ERROR/);

      setActiveTenantConfigForTesting(null);
      delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      expect(() => getActiveTenantConfiguration()).toThrow(/TENANT_CONFIG_ERROR/);
    } finally {
      if (prevDir === undefined) {
        delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
      } else {
        process.env.PLATFORM_TENANT_PACKAGE_DIR = prevDir;
      }
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
    }
  });

  it('supports both single-tenant (Model A) and multi-tenant (Model B) via configuration only', () => {
    const multiTenantConfig = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      notALawFirmDevOverlay,
      'dev',
      'multi_tenant',
    );
    const singleTenantConfig = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      notALawFirmDevOverlay,
      'live',
      'single_tenant',
    );

    const ctxMulti = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: multiTenantConfig.hostingMode,
      environment: multiTenantConfig.environment,
      correlationId: 'corr-mode-multi',
    });
    const ctxSingle = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: singleTenantConfig.hostingMode,
      environment: singleTenantConfig.environment,
      correlationId: 'corr-mode-single',
    });

    expect(resolveTenantPostgresConfig(ctxMulti).host).toContain(
      'platform-shared-pool',
    );
    expect(resolveTenantPostgresConfig(ctxSingle).host).toContain(
      'not-a-law-firm-pg-live',
    );
  });

  it('enforces tenantId on cache keys and background jobs', () => {
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-job-001',
    });

    expect(buildTenantCacheKey(ctxA, 'matters', 'MAT-0001')).toBe(
      'tenant:not-a-law-firm:matters:MAT-0001',
    );

    expect(() =>
      runTenantBackgroundJob(
        {
          jobId: 'job-1',
          tenantId: '',
          correlationId: 'corr-job-001',
          payload: {},
        },
        () => 'ok',
      ),
    ).toThrow(/TENANCY_JOB_ERROR/);
  });

  it('executes client extension hooks with sandboxing and error isolation', async () => {
    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    host.registerExtension(notALawFirmMatterCostsExtension);

    const config = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      notALawFirmDevOverlay,
      'dev',
      'multi_tenant',
    );
    const ctx = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: config.hostingMode,
      environment: config.environment,
      correlationId: 'corr-ext-001',
    });

    const blockedResult = await host.executeMatterCostsHook(
      'beforeMatterOpen',
      ctx,
      config,
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 27984,
        disbursementsTotalGbp: 500,
        partnerSignOffCompleted: false,
      },
    );

    expect(blockedResult.requiresPartnerSignOff).toBe(true);
    expect(blockedResult.allowProceed).toBe(false);
    expect(blockedResult.governanceWarnings[0]).toContain('£25,000');

    // R108: Verify getPlatformExtensionHost() dynamically loads and registers tenant extensions from disk
    const platformHost = getPlatformExtensionHost();
    expect(
      platformHost.getActiveExtensionsForTenant(config).map((ext) => ext.manifest.id),
    ).toContain('nalf-matter-costs-governance');
    const platformHookRes = await platformHost.executeMatterCostsHook(
      'beforeMatterOpen',
      ctx,
      config,
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 27984,
        disbursementsTotalGbp: 500,
        partnerSignOffCompleted: false,
      },
    );
    expect(platformHookRes.requiresPartnerSignOff).toBe(true);
    expect(platformHookRes.allowProceed).toBe(false);

    // Verify extension error isolation does not crash the core
    const faultyExtension: PlatformExtension = {
      manifest: {
        id: 'faulty-ext',
        name: 'Faulty Test Extension',
        version: '1.0.0',
        description: 'Simulates an unhandled throw inside a hook',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:read'],
        hooks: ['beforeMatterOpen'],
      },
      hooks: {
        beforeMatterOpen() {
          throw new Error('Simulated extension failure');
        },
      },
    };
    host.registerExtension(faultyExtension);

    const isolatedResult = await host.executeMatterCostsHook(
      'beforeMatterOpen',
      ctx,
      { ...config, enabledExtensions: ['faulty-ext'] },
      {
        matterId: 'M-000012',
        workBasis: 'fixed_fee',
        estimatedFeeGbp: 5000,
        disbursementsTotalGbp: 0,
        partnerSignOffCompleted: false,
      },
    );

    expect(isolatedResult.allowProceed).toBe(false);
    expect(isolatedResult.governanceWarnings[0]).toContain(
      'Extension isolated error: faulty-ext',
    );

    // Verify two-tenant isolation on outbound PMS sync commands
    await expect(
      host.executePmsOutboundCommandHook(ctx, config, {
        id: 'PMSO-000001',
        tenantId: 'pembroke-vaughan', // Forged tenantId
        correlationId: 'corr-pms-001',
        commandType: 'open_matter',
        entityType: 'matter',
        onesquaredId: 'M-000001',
        externalPmsCode: null,
        payload: {},
        mappedFields: {},
        createdAt: '2026-10-31T12:00:00Z',
        createdById: 'P-000001',
      }),
    ).rejects.toThrow(/EXTENSION_TENANT_MISMATCH/);

    // R108 (1): An invalid manifest or an extension that throws on load is skipped and logged while valid enabled extensions still load, and extensions not in enabledExtensions are ignored
    const tempPkgDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'onesquared-r108-pkg-'),
    );
    const prevPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cfgDir = path.join(tempPkgDir, 'config', 'environments');
      fs.mkdirSync(cfgDir, { recursive: true });
      const baseWithMixedExts = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        enabledExtensions: [
          'nalf-matter-costs-governance',
          'bad-manifest-ext',
          'throwing-ext',
        ],
      };
      fs.writeFileSync(
        path.join(tempPkgDir, 'config', 'base.json'),
        JSON.stringify(baseWithMixedExts, null, 2),
        'utf8',
      );
      fs.writeFileSync(
        path.join(cfgDir, 'dev.json'),
        JSON.stringify(notALawFirmDevOverlay, null, 2),
        'utf8',
      );

      // Copy valid nalf-matter-costs-governance extension
      const srcNalfExt = path.resolve(
        __dirname,
        '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance',
      );
      const destNalfExt = path.join(
        tempPkgDir,
        'extensions',
        'nalf-matter-costs-governance',
        'src',
      );
      fs.mkdirSync(destNalfExt, { recursive: true });
      fs.copyFileSync(
        path.join(srcNalfExt, 'manifest.json'),
        path.join(
          tempPkgDir,
          'extensions',
          'nalf-matter-costs-governance',
          'manifest.json',
        ),
      );
      fs.copyFileSync(
        path.join(srcNalfExt, 'src', 'index.ts'),
        path.join(destNalfExt, 'index.ts'),
      );

      // Create bad-manifest-ext with a valid module export (`src/index.js`) and invalid manifest.json
      const badManifestDir = path.join(
        tempPkgDir,
        'extensions',
        'bad-manifest-ext',
        'src',
      );
      fs.mkdirSync(badManifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(
          tempPkgDir,
          'extensions',
          'bad-manifest-ext',
          'manifest.json',
        ),
        JSON.stringify({ id: 'bad-manifest-ext', name: 'Bad' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(badManifestDir, 'index.js'),
        `module.exports = {
          manifest: {
            id: 'bad-manifest-ext',
            name: 'Bad Manifest Extension',
            version: '1.0.0',
            description: 'Valid export with invalid manifest.json',
            supportedCoreApiRange: '^1.0.0',
            permissions: ['matter:read'],
            hooks: ['beforeMatterOpen'],
          },
          hooks: {},
        };`,
        'utf8',
      );

      // Create throwing-ext with valid manifest.json that throws during module load
      const throwingExtDir = path.join(
        tempPkgDir,
        'extensions',
        'throwing-ext',
        'src',
      );
      fs.mkdirSync(throwingExtDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempPkgDir, 'extensions', 'throwing-ext', 'manifest.json'),
        JSON.stringify({
          id: 'throwing-ext',
          name: 'Throwing Extension',
          version: '1.0.0',
          description: 'Throws during load',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:read'],
          hooks: ['beforeMatterOpen'],
        }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(throwingExtDir, 'index.js'),
        'throw new Error("Simulated extension module load crash");',
        'utf8',
      );

      // Create disabled-ext with a valid manifest and valid module export that loads cleanly when enabled,
      // but is omitted from enabledExtensions in base.json
      const disabledExtDir = path.join(
        tempPkgDir,
        'extensions',
        'disabled-ext',
        'src',
      );
      fs.mkdirSync(disabledExtDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempPkgDir, 'extensions', 'disabled-ext', 'manifest.json'),
        JSON.stringify({
          id: 'disabled-ext',
          name: 'Disabled Extension',
          version: '1.0.0',
          description: 'Valid extension omitted from enabledExtensions',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:read'],
          hooks: ['beforeMatterOpen'],
        }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(disabledExtDir, 'index.js'),
        `module.exports = {
          manifest: {
            id: 'disabled-ext',
            name: 'Disabled Extension',
            version: '1.0.0',
            description: 'Valid extension omitted from enabledExtensions',
            supportedCoreApiRange: '^1.0.0',
            permissions: ['matter:read'],
            hooks: ['beforeMatterOpen'],
          },
          hooks: {},
        };`,
        'utf8',
      );

      process.env.PLATFORM_TENANT_PACKAGE_DIR = tempPkgDir;
      setActiveTenantConfigForTesting(null);

      const isolatedHost = getPlatformExtensionHost();
      const loadedIds = isolatedHost
        .getActiveExtensionsForTenant({
          ...config,
          enabledExtensions: [
            'nalf-matter-costs-governance',
            'bad-manifest-ext',
            'throwing-ext',
            'disabled-ext',
          ],
        })
        .map((e) => e.manifest.id);
      expect(loadedIds).toContain('nalf-matter-costs-governance');
      expect(loadedIds).not.toContain('bad-manifest-ext');
      expect(loadedIds).not.toContain('throwing-ext');
      expect(loadedIds).not.toContain('disabled-ext');

      const loadErrors = getExtensionHostLoadErrors();
      expect(loadErrors.map((e) => e.extensionDir)).toEqual(
        expect.arrayContaining(['bad-manifest-ext', 'throwing-ext']),
      );
      expect(loadErrors.map((e) => e.extensionDir)).not.toContain(
        'disabled-ext',
      );
      const badManifestErr = loadErrors.find(
        (e) => e.extensionDir === 'bad-manifest-ext',
      );
      expect(badManifestErr?.error).toContain('EXTENSION_MANIFEST_ERROR');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      if (prevPkgDir === undefined) {
        delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
      } else {
        process.env.PLATFORM_TENANT_PACKAGE_DIR = prevPkgDir;
      }
      setActiveTenantConfigForTesting(null);
      fs.rmSync(tempPkgDir, { recursive: true, force: true });
    }

    // R108 & R131: saveMatterRecord requires an authenticated request session, awaits beforeMatterOpen, blocks opening when allowProceed === false, and rolls back inline parties when vetoed
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const baseMatter = store.matters[0]!;

      // (a) Outside a signed-in request scope, saveMatterRecord refuses with UNAUTHENTICATED and runs no extension hooks
      const unauthSaveRes = await runWithActiveActorSession(null, () =>
        saveMatterRecord(
          {
            ...baseMatter,
            title: 'Should Fail Without Session',
          },
          { id: baseMatter.id, byId: 'P-000001', saveMode: 'draft' },
        ),
      );
      expect(unauthSaveRes.matter).toBeNull();
      expect(unauthSaveRes.errors?.access).toMatch(/UNAUTHENTICATED/);

      // Build a verified session scope for P-000001
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const verifiedSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: carys.id,
          tenantId: 'not-a-law-firm',
          oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: carys.id,
          email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
          displayName: `${carys.firstName} ${carys.surname}`,
          entraRoles: carys.roles ?? ['partner'],
          mappedRoles: carys.roles ?? ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt,
        }),
      )!;

      // (b) Inside a signed-in request scope, saveMode: 'submit_cleared' at £30,000 without partner sign-off is vetoed by beforeMatterOpen (allowProceed: false) and returns errors.costsGovernance with matter: null
      const peopleCountBeforeVeto = store.people.length;
      const vetoedSaveRes = await runWithActiveActorSession(
        {
          personId: carys.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: verifiedSession.mappedRoles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        () =>
          saveMatterRecord(
            {
              ...baseMatter,
              agreedFeeCapGbp: 30000,
              feeEstimateGbp: 30000,
              conflictClearedById: null,
              parties: [
                ...(baseMatter.parties ?? []),
                {
                  id: 'pt-new-transient',
                  name: 'Transient Counterparty Person',
                  role: 'Counterparty',
                  linkedRecordId: null,
                  entityType: 'person',
                },
              ],
            },
            { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
      );
      expect(vetoedSaveRes.matter).toBeNull();
      expect(vetoedSaveRes.errors?.costsGovernance).toMatch(/£25,000|partner sign-off/i);
      // Inline-created party was NOT pushed to store.people when beforeMatterOpen vetoed the save
      expect(store.people.length).toBe(peopleCountBeforeVeto);

      // (c) In draft mode, beforeMatterCostsCalculate records governance warnings without blocking pre-open draft save
      const preOpenRes = await runWithActiveActorSession(
        {
          personId: carys.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: verifiedSession.mappedRoles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        () =>
          saveMatterRecord(
            {
              ...baseMatter,
              agreedFeeCapGbp: 30000,
              feeEstimateGbp: 30000,
              conflictClearedById: null,
            },
            { id: baseMatter.id, byId: 'P-000001', saveMode: 'draft' },
          ),
      );
      expect(preOpenRes.errors).toBeUndefined();
      const gov = (preOpenRes.matter?.fieldValues ?? {})[
        'matterCostsGovernance'
      ] as
        | {
            requiresPartnerSignOff?: boolean;
            allowProceed?: boolean;
            governanceWarnings?: string[];
          }
        | undefined;
      expect(gov).toBeDefined();
      expect(gov?.requiresPartnerSignOff).toBe(true);
      expect(gov?.allowProceed).toBe(true);
    } finally {
      resetAllDemoData('P-000001');
    }

    // R108 (3): Async beforeMatterOpen hook veto and hook timeout both block opening (allowProceed === false)
    const asyncHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    asyncHost.registerExtension({
      manifest: {
        id: 'async-veto-ext',
        name: 'Async Veto Extension',
        version: '1.0.0',
        description: 'Awaits a timer and vetoes matter opening',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:open:gate'],
        hooks: ['beforeMatterOpen'],
        hookTimeoutMs: 500,
      },
      hooks: {
        beforeMatterOpen: async () => {
          await new Promise((r) => setTimeout(r, 15));
          return {
            allowProceed: false,
            requiresPartnerSignOff: true,
            governanceWarnings: ['Async veto from extension hook'],
          };
        },
      },
    });
    const asyncCtx = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'single_tenant',
      environment: 'dev',
      correlationId: 'corr-async-veto',
    });
    const asyncVetoOutcome = await asyncHost.executeMatterCostsHook(
      'beforeMatterOpen',
      asyncCtx,
      {
        ...config,
        enabledExtensions: ['async-veto-ext'],
      },
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 10000,
        disbursementsTotalGbp: 0,
        partnerSignOffCompleted: false,
      },
    );
    expect(asyncVetoOutcome.allowProceed).toBe(false);
    expect(asyncVetoOutcome.governanceWarnings).toContain(
      'Async veto from extension hook',
    );

    const timeoutHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    timeoutHost.registerExtension({
      manifest: {
        id: 'timeout-gate-ext',
        name: 'Timeout Gate Extension',
        version: '1.0.0',
        description: 'Exceeds hookTimeoutMs during beforeMatterOpen',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:open:gate'],
        hooks: ['beforeMatterOpen'],
        hookTimeoutMs: 20,
      },
      hooks: {
        beforeMatterOpen: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return {
            allowProceed: true,
            requiresPartnerSignOff: false,
            governanceWarnings: [],
          };
        },
      },
    });
    const timeoutOutcome = await timeoutHost.executeMatterCostsHook(
      'beforeMatterOpen',
      asyncCtx,
      {
        ...config,
        enabledExtensions: ['timeout-gate-ext'],
      },
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 10000,
        disbursementsTotalGbp: 0,
        partnerSignOffCompleted: true,
      },
    );
    expect(timeoutOutcome.allowProceed).toBe(false);
    expect(timeoutOutcome.governanceWarnings[0]).toMatch(/timeout-gate-ext/i);

    // R108 (4): When a beforeMatterOpen hook throws an unhandled error, executeMatterCostsHook fails closed (allowProceed === false)
    const throwingHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    throwingHost.registerExtension({
      manifest: {
        id: 'throwing-gate-ext',
        name: 'Throwing Gate Extension',
        version: '1.0.0',
        description: 'Throws during beforeMatterOpen',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:open:gate'],
        hooks: ['beforeMatterOpen'],
        hookTimeoutMs: 500,
      },
      hooks: {
        beforeMatterOpen: async () => {
          throw new Error('Simulated extension database crash');
        },
      },
    });
    const throwingOutcome = await throwingHost.executeMatterCostsHook(
      'beforeMatterOpen',
      asyncCtx,
      {
        ...config,
        enabledExtensions: ['throwing-gate-ext'],
      },
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 10000,
        disbursementsTotalGbp: 0,
        partnerSignOffCompleted: true,
      },
    );
    expect(throwingOutcome.allowProceed).toBe(false);
    expect(throwingOutcome.governanceWarnings[0]).toMatch(
      /Simulated extension database crash/i,
    );

    // R108 (5): When an enabled extension declaring beforeMatterOpen fails to load, saveMatterRecord refuses to open the matter
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;

      // Temporarily register a throwing beforeMatterOpen hook on the active ExtensionHost and verify saveMatterRecord blocks
      const rawBaseCfg = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        enabledExtensions: ['nalf-throwing-open-gate'],
      });
      const activeHost = getPlatformExtensionHost();
      activeHost.registerExtension({
        manifest: {
          id: 'nalf-throwing-open-gate',
          name: 'NALF Throwing Open Gate',
          version: '1.0.0',
          description: 'Throws on beforeMatterOpen',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:open:gate'],
          hooks: ['beforeMatterOpen'],
        },
        hooks: {
          beforeMatterOpen: () => {
            throw new Error('Unhandled hook crash on open');
          },
        },
      });
      const throwSaveRes = await runWithActiveActorSession(
        {
          personId: carys.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: verifiedSession.mappedRoles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        () =>
          saveMatterRecord(
            {
              ...baseMatter,
              conflictClearedById: null,
            },
            { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
      );
      expect(throwSaveRes.matter).toBeNull();
      expect(throwSaveRes.errors?.costsGovernance).toBe(
        'A required costs check could not run. Please contact your administrator.',
      );

      // Now configure an enabled extension that is not in the generated registry (so it records an ExtensionLoadError for beforeMatterOpen)
      setActiveTenantConfigForTesting(null);
      const tmpLoadFailDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'nalf-load-fail-'),
      );
      const prevPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
      try {
        fs.mkdirSync(path.join(tmpLoadFailDir, 'config'), { recursive: true });
        const extSubDir = path.join(
          tmpLoadFailDir,
          'extensions',
          'missing-open-gate',
        );
        fs.mkdirSync(extSubDir, { recursive: true });
        fs.writeFileSync(
          path.join(tmpLoadFailDir, 'config', 'base.json'),
          JSON.stringify({
            ...rawBaseCfg,
            enabledExtensions: ['missing-open-gate'],
          }),
          'utf8',
        );
        fs.writeFileSync(
          path.join(extSubDir, 'manifest.json'),
          JSON.stringify({
            id: 'missing-open-gate',
            name: 'Missing Open Gate',
            version: '1.0.0',
            description: 'Registered in manifest but missing from generated registry',
            supportedCoreApiRange: '^1.0.0',
            permissions: ['matter:open:gate'],
            hooks: ['beforeMatterOpen'],
          }),
          'utf8',
        );
        process.env.PLATFORM_TENANT_PACKAGE_DIR = tmpLoadFailDir;
        setActiveTenantConfigForTesting(null);
        getPlatformExtensionHost();
        expect(
          getExtensionHostLoadErrors().some(
            (e) =>
              e.extensionId === 'missing-open-gate' &&
              e.declaredHooks?.includes('beforeMatterOpen'),
          ),
        ).toBe(true);

        const loadErrSaveRes = await runWithActiveActorSession(
          {
            personId: carys.id,
            tenantId: 'not-a-law-firm',
            tokenRoles: verifiedSession.mappedRoles,
            expiresAtMs: Date.parse(expiresAt),
            verifiedSession,
          },
          () =>
            saveMatterRecord(
              {
                ...baseMatter,
                conflictClearedById: null,
              },
              { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
            ),
        );
        expect(loadErrSaveRes.matter).toBeNull();
        expect(loadErrSaveRes.errors?.costsGovernance).toBe(
          'A required costs check could not run. Please contact your administrator.',
        );
      } finally {
        if (prevPkgDir === undefined) {
          delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
        } else {
          process.env.PLATFORM_TENANT_PACKAGE_DIR = prevPkgDir;
        }
        fs.rmSync(tmpLoadFailDir, { recursive: true, force: true });
      }
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }

    // R106: Domain helpers (syncHomeRolesWithEmployeeRoles, createDefaultMatterCostsConfig) succeed in browser window mode without reading tenant configuration
    const storeValues = getStore().values;
    const prevWindow = (globalThis as Record<string, unknown>).window;
    const savedPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
    try {
      (globalThis as Record<string, unknown>).window = {};
      delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
      const syncedRoles = syncHomeRolesWithEmployeeRoles([], storeValues);
      expect(syncedRoles.length).toBeGreaterThan(0);
      const defaultCosts = createDefaultMatterCostsConfig(storeValues);
      expect(defaultCosts.clientProfileCode).toBeDefined();
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
      if (savedPkgDir !== undefined) {
        process.env.PLATFORM_TENANT_PACKAGE_DIR = savedPkgDir;
      }
    }

    // R143 (7) & R151: Two-way manifest schema parity between core/schemas/extension-manifest.schema.json and ExtensionManifestSchema
    const schemaPerms =
      extensionManifestJsonSchema.properties.permissions.items.enum;
    const schemaHooks =
      extensionManifestJsonSchema.properties.hooks.items.enum;
    expect(ExtensionPermissionSchema.options).toEqual(schemaPerms);
    expect(ExtensionHookPointSchema.options).toEqual(schemaHooks);
    const zodRequiredKeys = Object.entries(ExtensionManifestSchema.shape)
      .filter(([, fieldSchema]) => !fieldSchema.isOptional())
      .map(([key]) => key);
    expect(zodRequiredKeys).toEqual(extensionManifestJsonSchema.required);
    for (const perm of schemaPerms) {
      expect(() =>
        validateExtensionManifest({
          id: 'parity-ext',
          name: 'Parity Extension',
          version: '1.0.0',
          description: 'Parity test',
          supportedCoreApiRange: '^1.0.0',
          permissions: [perm],
          hooks: [schemaHooks[0]],
        }),
      ).not.toThrow();
    }
    for (const hook of schemaHooks) {
      expect(() =>
        validateExtensionManifest({
          id: 'parity-ext',
          name: 'Parity Extension',
          version: '1.0.0',
          description: 'Parity test',
          supportedCoreApiRange: '^1.0.0',
          permissions: [schemaPerms[0]],
          hooks: [hook],
        }),
      ).not.toThrow();
    }
    expect(() =>
      validateExtensionManifest({
        id: '',
        name: 'Parity Extension',
        version: '1.0.0',
        description: 'Parity test',
        supportedCoreApiRange: '^1.0.0',
        permissions: [],
        hooks: [],
      }),
    ).toThrow(/EXTENSION_MANIFEST_ERROR/);
    expect(() =>
      validateExtensionManifest({
        id: 'parity-ext',
        name: 'Parity Extension',
        version: '1.0.0',
        description: 'Parity test',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['not:a:permission'],
        hooks: [],
      }),
    ).toThrow(/EXTENSION_MANIFEST_ERROR/);

    // R118: resolveConfiguredFirmPrimaryDomain throws TENANT_CONFIG_ERROR when branding.primaryDomain is missing
    const rawBase = getActiveTenantRawBaseConfig();
    try {
      setActiveTenantConfigForTesting({
        ...rawBase,
        branding: {
          ...((rawBase.branding as Record<string, unknown>) ?? {}),
          primaryDomain: '   ',
        },
      });
      expect(() => resolveConfiguredFirmPrimaryDomain()).toThrow(
        /TENANT_CONFIG_ERROR/,
      );
    } finally {
      setActiveTenantConfigForTesting(null);
    }
  });

  it('R132 & R151: generateExtensionRegistry writes an empty registry when PLATFORM_TENANT_PACKAGE_DIR is unset, throws on missing package or duplicate ID, and emits one import for a valid package', () => {
    const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reg-out-'));
    try {
      // (a) Unset PLATFORM_TENANT_PACKAGE_DIR and no --all-fixtures -> empty registry with zero imports
      const emptyRes = generateExtensionRegistry({
        repoRoot: process.cwd(),
        env: {},
        argv: [],
        outDir: tmpOutDir,
      });
      expect(emptyRes.bundledExtensionIds).toEqual([]);
      const emptySrc = fs.readFileSync(emptyRes.writtenFile, 'utf8');
      expect(emptySrc).not.toMatch(/^import \* as /m);
      expect(emptySrc).toContain('export const BUNDLED_TENANT_EXTENSIONS');

      // (b) Missing package directory -> throws TENANT_CONFIG_ERROR
      expect(() =>
        generateExtensionRegistry({
          repoRoot: process.cwd(),
          env: { PLATFORM_TENANT_PACKAGE_DIR: 'client-does-not-exist' },
          argv: [],
          outDir: tmpOutDir,
        }),
      ).toThrow(/TENANT_CONFIG_ERROR/);

      // (c) Valid package -> writes one import
      const validRes = generateExtensionRegistry({
        repoRoot: process.cwd(),
        env: { PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm' },
        argv: [],
        outDir: tmpOutDir,
      });
      expect(validRes.bundledExtensionIds).toEqual([
        'nalf-matter-costs-governance',
      ]);

      // (d) Duplicate extension ID across two folders -> throws DUPLICATE_EXTENSION_ID
      const tmpPkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-dup-pkg-'));
      try {
        fs.mkdirSync(path.join(tmpPkgDir, 'config'), { recursive: true });
        fs.writeFileSync(
          path.join(tmpPkgDir, 'config', 'base.json'),
          JSON.stringify({
            ...notALawFirmBaseConfig,
            enabledExtensions: ['dup-ext-id'],
          }),
          'utf8',
        );
        for (const sub of ['ext-a', 'ext-b']) {
          const dir = path.join(tmpPkgDir, 'extensions', sub, 'src');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(tmpPkgDir, 'extensions', sub, 'manifest.json'),
            JSON.stringify({
              id: 'dup-ext-id',
              name: `Dup ${sub}`,
              version: '1.0.0',
              description: 'Duplicate ID test',
              supportedCoreApiRange: '^1.0.0',
              permissions: ['matter:read'],
              hooks: ['beforeMatterOpen'],
            }),
            'utf8',
          );
          fs.writeFileSync(
            path.join(dir, 'index.ts'),
            'export default {};\n',
            'utf8',
          );
        }
        expect(() =>
          generateExtensionRegistry({
            repoRoot: process.cwd(),
            env: { PLATFORM_TENANT_PACKAGE_DIR: tmpPkgDir },
            argv: [],
            outDir: tmpOutDir,
          }),
        ).toThrow(/DUPLICATE_EXTENSION_ID/);
      } finally {
        fs.rmSync(tmpPkgDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpOutDir, { recursive: true, force: true });
    }
  });

  it('R144: async saveMatterRecord never reissues IDs on veto and preserves concurrent conflict-record updates (rejecting stale concurrent matter saves)', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const targetMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const actorSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const rawBaseCfg = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        enabledExtensions: ['nalf-slow-concurrency-ext'],
      });
      const activeHost = getPlatformExtensionHost();
      let hookMode: 'veto_after_50ms' | 'allow_after_50ms' = 'veto_after_50ms';
      activeHost.registerExtension({
        manifest: {
          id: 'nalf-slow-concurrency-ext',
          name: 'Slow Concurrency Extension',
          version: '1.0.0',
          description: 'Waits 50ms during beforeMatterOpen',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:open:gate'],
          hooks: ['beforeMatterOpen'],
        },
        hooks: {
          beforeMatterOpen: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return {
              allowProceed: hookMode === 'allow_after_50ms',
              requiresPartnerSignOff: hookMode === 'veto_after_50ms',
              governanceWarnings:
                hookMode === 'veto_after_50ms'
                  ? ['Slow veto after 50ms']
                  : [],
            };
          },
        },
      });

      // Start slow vetoed save that allocates an inline party ID before awaiting the hook
      const slowVetoPromise = runWithActiveActorSession(actorSession, () =>
        saveMatterRecord(
          {
            ...targetMatter,
            conflictClearedById: null,
            parties: [
              ...(targetMatter.parties ?? []),
              {
                id: 'pt-slow-veto',
                name: 'Slow Veto Counterparty',
                role: 'Counterparty',
                linkedRecordId: null,
                entityType: 'person',
              },
            ],
          },
          { id: targetMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );

      // While slowVetoPromise is awaiting the 50ms hook, create a new matter (with an inline party) and update targetMatter's conflict record
      await new Promise((r) => setTimeout(r, 15));
      const { id: _omittedTargetId, ...newMatterTemplate } = targetMatter;
      void _omittedTargetId;
      const concurrentNewMatterRes = await runWithActiveActorSession(
        actorSession,
        () =>
          saveMatterRecord(
            {
              ...newMatterTemplate,
              title: 'Concurrent Draft Matter During Hook Wait',
              parties: [
                {
                  id: 'pt-concurrent-draft',
                  name: 'Concurrent Created Person',
                  role: 'Counterparty',
                  linkedRecordId: null,
                  entityType: 'person',
                },
              ],
            },
            { byId: carys.id, saveMode: 'draft' },
          ),
      );
      expect(concurrentNewMatterRes.errors).toBeUndefined();
      expect(concurrentNewMatterRes.matter).not.toBeNull();

      const baseConflict = targetMatter.conflictCheckRecord ?? {
        status: 'In progress' as const,
        outcomeLabel: 'Cleared by fee earner' as const,
        declarationConfirmed: true,
        reviewerMessage: '',
        lastRunAtDisplay: '04 Nov 2026',
        lastRunById: carys.id,
        lastRunByName: 'Carys Hughes',
        submittedAtDisplay: '04 Nov 2026',
        submittedById: carys.id,
        submittedByName: 'Carys Hughes',
        approvedAtDisplay: null,
        approvedById: null,
        approvedByName: null,
        parties: [],
        matches: [],
        comments: [],
        runs: [],
      };
      const concurrentConflictUpdate = updateMatterConflictRecord(
        targetMatter.id,
        {
          ...baseConflict,
          reviewerMessage: 'Updated concurrently while hook was waiting',
        },
        carys.id,
      );
      expect(concurrentConflictUpdate.matter).not.toBeNull();

      const slowVetoRes = await slowVetoPromise;
      expect(slowVetoRes.matter).toBeNull();

      // Create another matter after the veto and verify no Matter or Person ID was issued twice
      const postVetoMatterRes = await runWithActiveActorSession(
        actorSession,
        () =>
          saveMatterRecord(
            {
              ...newMatterTemplate,
              title: 'Post-Veto Draft Matter',
              parties: [
                {
                  id: 'pt-post-veto',
                  name: 'Post Veto Created Person',
                  role: 'Counterparty',
                  linkedRecordId: null,
                  entityType: 'person',
                },
              ],
            },
            { byId: carys.id, saveMode: 'draft' },
          ),
      );
      expect(postVetoMatterRes.errors).toBeUndefined();
      expect(postVetoMatterRes.matter).not.toBeNull();
      expect(postVetoMatterRes.matter!.id).not.toBe(
        concurrentNewMatterRes.matter!.id,
      );

      const allMatterIds = store.matters.map((m) => m.id);
      expect(new Set(allMatterIds).size).toBe(allMatterIds.length);
      const allPersonIds = store.people.map((p) => p.id);
      expect(new Set(allPersonIds).size).toBe(allPersonIds.length);

      // Verify the concurrent conflict-record update on targetMatter is still intact
      const refreshedTarget = store.matters.find(
        (m) => m.id === targetMatter.id,
      )!;
      expect(refreshedTarget.conflictCheckRecord?.reviewerMessage).toBe(
        'Updated concurrently while hook was waiting',
      );

      // Now verify that when a hook allows proceed after 50ms, a concurrent update to the same matter causes saveMatterRecord to refuse with errors.conflict
      hookMode = 'allow_after_50ms';
      const staleSavePromise = runWithActiveActorSession(actorSession, () =>
        saveMatterRecord(
          {
            ...refreshedTarget,
            title: 'Stale Overwrite Attempt',
            conflictClearedById: null,
          },
          { id: refreshedTarget.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      await new Promise((r) => setTimeout(r, 15));
      updateMatterConflictRecord(
        refreshedTarget.id,
        {
          ...baseConflict,
          reviewerMessage: 'Second concurrent update during allow hook',
        },
        carys.id,
      );
      const staleSaveRes = await staleSavePromise;
      expect(staleSaveRes.matter).toBeNull();
      expect(staleSaveRes.errors?.conflict).toMatch(
        /changed by someone else while you were saving/i,
      );
      expect(
        store.matters.find((m) => m.id === refreshedTarget.id)!.title,
      ).not.toBe('Stale Overwrite Attempt');
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R147: referred conflict reviews route via conflictReview config, stay unassigned when unconfigured, and never assign or leak staff matter titles outside restrictedAccessUserIds', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const actorSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const rawBaseCfg = getActiveTenantRawBaseConfig();

      // (a) With conflictReview unconfigured (assigneeTeamKey: null, assigneeRoleKey: null), the review task is unassigned
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        conflictReview: {
          assigneeTeamKey: null,
          assigneeRoleKey: null,
        },
      });
      const unconfiguredRes = await runWithActiveActorSession(
        actorSession,
        () =>
          saveMatterRecord(
            {
              ...baseMatter,
              title: 'Unconfigured Conflict Review Matter',
              agreedFeeCapGbp: 5000,
              feeEstimateGbp: 5000,
            },
            { id: baseMatter.id, byId: carys.id, saveMode: 'submit_referred' },
          ),
      );
      expect(unconfiguredRes.errors).toBeUndefined();
      expect(unconfiguredRes.matter).not.toBeNull();
      const unconfiguredTask = store.tasks.find(
        (t) =>
          t.linkedRecords.some((r) => r.recordId === baseMatter.id) &&
          t.title.includes('Unconfigured Conflict Review Matter'),
      );
      expect(unconfiguredTask).toBeDefined();
      expect(unconfiguredTask?.assignedPersonId).toBeNull();
      expect(unconfiguredTask?.assignedTeamId).toBeNull();

      // (b) On a staff matter where no risk team member is in restrictedAccessUserIds (and matter:restricted:access is revoked on risk team members), the task is never assigned to someone outside restrictedAccessUserIds and omits the client name and matter title
      setActiveTenantConfigForTesting(null);
      const staffEmployeeClient = store.people.find(
        (p) => p.isEmployee && p.id !== carys.id,
      )!;
      for (const p of store.people) {
        if (p.id !== carys.id) {
          p.permissionOverrides = {
            grant: p.permissionOverrides?.grant ?? [],
            revoke: ['matter:restricted:access'],
          };
        }
      }

      const { id: _omittedBaseId, ...staffMatterTemplate } = baseMatter;
      void _omittedBaseId;
      const staffReferredRes = await runWithActiveActorSession(
        actorSession,
        () =>
          saveMatterRecord(
            {
              ...staffMatterTemplate,
              title: 'Confidential Staff Disciplinary Matter',
              clientId: staffEmployeeClient.id,
              agreedFeeCapGbp: 5000,
              feeEstimateGbp: 5000,
              responsiblePartnerId: carys.id,
              supervisingPartnerId: carys.id,
              leadFeeEarnerId: carys.id,
              teamMemberIds: [carys.id],
            },
            { byId: carys.id, saveMode: 'submit_referred' },
          ),
      );
      expect(staffReferredRes.errors).toBeUndefined();
      expect(staffReferredRes.matter).not.toBeNull();
      expect(staffReferredRes.matter!.isStaffMatter).toBe(true);
      const staffTask = store.tasks.find((t) =>
        t.linkedRecords.some((r) => r.recordId === staffReferredRes.matter!.id),
      );
      expect(staffTask).toBeDefined();
      if (staffTask?.assignedPersonId) {
        expect(staffReferredRes.matter!.restrictedAccessUserIds).toContain(
          staffTask.assignedPersonId,
        );
      } else {
        expect(staffTask?.assignedPersonId).toBeNull();
        expect(staffTask?.title).not.toContain(
          'Confidential Staff Disciplinary Matter',
        );
        expect(staffTask?.title).not.toContain(staffEmployeeClient.surname);
        expect(staffTask?.description).not.toContain(
          'Confidential Staff Disciplinary Matter',
        );
      }
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R152: getAppSnapshot and server endpoints filter out staff and ethical-wall matters, linked tasks, links, notes, audit, and PMS rows for non-participants and block tampered matter IDs', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const outsiderFeeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== carys.id &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const staffClient = store.people.find(
        (p) =>
          p.isEmployee && p.id !== carys.id && p.id !== outsiderFeeEarner.id,
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;

      // Create a staff matter and an ethical-wall matter owned by Carys (outsiderFeeEarner is NOT a participant)
      const staffRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R152 Secret Staff Matter',
            clientId: staffClient.id,
            responsiblePartnerId: carys.id,
            supervisingPartnerId: carys.id,
            leadFeeEarnerId: carys.id,
            teamMemberIds: [carys.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(staffRes.matter?.isStaffMatter).toBe(true);
      const staffMatterId = staffRes.matter!.id;

      const wallRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R152 Secret Ethical Wall Matter',
            responsiblePartnerId: carys.id,
            supervisingPartnerId: carys.id,
            leadFeeEarnerId: carys.id,
            teamMemberIds: [carys.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '04 Nov 2026',
              lastRunById: carys.id,
              lastRunByName: 'Carys Hughes',
              submittedAtDisplay: null,
              submittedById: null,
              submittedByName: null,
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [
                {
                  id: 'm-wall-152',
                  partyId: 'pt-wall-1',
                  partyName: 'Barrier Match',
                  matchedRecordType: 'organisation',
                  matchedRecordId: 'O-000001',
                  matchedRecordName: 'Barrier Match',
                  strength: 'Exact',
                  whereFound: 'Organisation register',
                  responsiblePartnerId: carys.id,
                  responsiblePartnerName: 'Carys Hughes',
                  dateLabel: '04 Nov 2026',
                  disposition: 'potential_conflict',
                  note: 'Ethical wall required',
                  reviewerDecision: 'approve_with_conditions',
                  reviewerConditionType: 'information_barrier',
                  reviewerNote: 'Ethical wall required',
                  reviewedById: carys.id,
                  reviewedByName: 'Carys Hughes',
                  reviewedAt: '04 Nov 2026',
                },
              ],
              comments: [],
              runs: [],
            },
          },
          { byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(wallRes.matter?.hasEthicalWall).toBe(true);
      const wallMatterId = wallRes.matter!.id;

      // Participant (Carys) sees both matters in getAppSnapshot
      const carysSnap = runWithActiveActorSession(carysSession, () =>
        getAppSnapshot(carys.id),
      );
      expect(carysSnap.matters.some((m) => m.id === staffMatterId)).toBe(true);
      expect(carysSnap.matters.some((m) => m.id === wallMatterId)).toBe(true);

      // Non-participant fee earner does NOT see either matter, nor linked tasks, links, notes, audit, or PMS summary rows
      const outsiderCookie = createSignedEntraSessionCookie({
        personId: outsiderFeeEarner.id,
        tenantId: 'not-a-law-firm',
        oid:
          outsiderFeeEarner.entraObjectId ??
          '00000000-0000-4000-8000-000000000099',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: outsiderFeeEarner.id,
        email:
          outsiderFeeEarner.emails[0]?.address ??
          'outsider@notalawfirm.example',
        displayName: 'Outsider Fee Earner',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const outsiderVerified = verifySignedEntraSessionCookie(outsiderCookie)!;
      const outsiderSession = {
        personId: outsiderFeeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: outsiderVerified,
      };

      const outsiderSnap = runWithActiveActorSession(outsiderSession, () =>
        getAppSnapshot(outsiderFeeEarner.id),
      );
      expect(outsiderSnap.matters.some((m) => m.id === staffMatterId)).toBe(
        false,
      );
      expect(outsiderSnap.matters.some((m) => m.id === wallMatterId)).toBe(
        false,
      );
      expect(
        outsiderSnap.tasks.some((t) =>
          t.linkedRecords.some(
            (r) => r.recordId === staffMatterId || r.recordId === wallMatterId,
          ),
        ),
      ).toBe(false);
      expect(
        outsiderSnap.audit.some(
          (a) => a.recordId === staffMatterId || a.recordId === wallMatterId,
        ),
      ).toBe(false);
      expect(
        outsiderSnap.pmsSummaryByMatterId[staffMatterId],
      ).toBeUndefined();
      expect(outsiderSnap.pmsSummaryByMatterId[wallMatterId]).toBeUndefined();

      // Direct PMS bundle lookup and tampered-ID actions by non-participant fail closed
      const outsiderPmsView = runWithActiveActorSession(outsiderSession, () =>
        getMatterPmsViewBundle(staffMatterId, outsiderFeeEarner.id),
      );
      expect(outsiderPmsView.matterBundle).toBeNull();
      expect(outsiderPmsView.link).toBeNull();
      expect(
        runWithActiveActorSession(outsiderSession, () =>
          markEngagementLetterDrafted(staffMatterId, outsiderFeeEarner.id),
        ).matter,
      ).toBeNull();
      expect(
        runWithActiveActorSession(outsiderSession, () =>
          liftMatterRestriction(
            staffMatterId,
            'staff_matter',
            'Tampered ID attempt',
            outsiderFeeEarner.id,
          ),
        ).matter,
      ).toBeNull();
      const kdTampered = await runWithActiveActorSession(outsiderSession, () =>
        createOrProposeKeyDateRecord(
          {
            matterId: staffMatterId,
            keyDateTypeId: 'court_hearing',
            title: 'Tampered Key Date',
            dueDate: '2027-01-15',
            teamId: 'TM-000001',
            responsiblePersonIds: [outsiderFeeEarner.id],
          },
          outsiderFeeEarner.id,
        ),
      );
      expect(kdTampered.keyDate).toBeUndefined();
      expect(kdTampered.error).toMatch(/Forbidden|not found/i);
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R144: hiring a matter client via savePersonRecord while beforeMatterOpen is awaiting returns errors.conflict and preserves isStaffMatter', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const externalClient = store.people.find(
        (p) => !p.isEmployee && !p.employment,
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;
      const draftRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            fieldValues: {},
            title: 'R144 Concurrent Client Hire Matter',
            clientId: externalClient.id,
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: carys.id, saveMode: 'draft' },
        ),
      );
      const draftMatter = draftRes.matter!;

      const rawBaseCfg = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        enabledExtensions: ['nalf-slow-hire-race-ext'],
      });
      getPlatformExtensionHost().registerExtension({
        manifest: {
          id: 'nalf-slow-hire-race-ext',
          name: 'Slow Hire Race Extension',
          version: '1.0.0',
          description: 'Waits 50ms during beforeMatterOpen for client hire race',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:open:gate'],
          hooks: ['beforeMatterOpen'],
        },
        hooks: {
          beforeMatterOpen: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return {
              allowProceed: true,
              requiresPartnerSignOff: false,
              governanceWarnings: [],
            };
          },
        },
      });
      const hireRaceSavePromise = runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...draftMatter,
            title: 'R144 Concurrent Client Hire Matter Opened',
            conflictClearedById: null,
          },
          { id: draftMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      await new Promise((r) => setTimeout(r, 15));
      const hireRes = savePersonRecord(
        {
          ...externalClient,
          firstName: externalClient.firstName,
          surname: externalClient.surname,
          dateOfBirth: externalClient.dateOfBirth || '1988-04-10',
          isEmployee: true,
        },
        {
          id: externalClient.id,
          byId: 'P-000004',
          worksAtFirm: true,
          employmentSubmitted: {
            ...carys.employment!,
            employeeNumber: 'EMP-HIRE-144',
            status: 'Active',
            feeEarner: carys.employment?.feeEarner
              ? {
                  ...carys.employment.feeEarner,
                  timekeeperCode: 'FE-HIRE-144',
                }
              : null,
          },
        },
      );
      expect(hireRes.errors).toBeUndefined();
      const hireRaceSaveRes = await hireRaceSavePromise;
      expect(hireRaceSaveRes.matter).toBeNull();
      expect(hireRaceSaveRes.errors?.conflict).toMatch(
        /changed by someone else while you were saving/i,
      );
      expect(
        store.matters.find((m) => m.id === draftMatter.id)!.isStaffMatter,
      ).toBe(true);
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R153: updateMatterConflictRecord enforces risk:view, never opens a draft matter, never satisfies partnerSignOffCompleted via Cleared, and preserves stored comments and server timestamps', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== carys.id &&
          (p.roles ?? []).includes('fee_earner') &&
          !(p.roles ?? []).includes('risk_compliance') &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin'),
      )!;
      const externalClient = store.people.find(
        (p) => !p.isEmployee && !p.employment,
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };
      const feCookie = createSignedEntraSessionCookie({
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000088',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: feeEarner.id,
        email: feeEarner.emails[0]?.address ?? 'fe@notalawfirm.example',
        displayName: 'Fee Earner',
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const feSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(feCookie)!,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;
      const draftRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            fieldValues: {},
            title: 'R153 Draft Matter',
            clientId: externalClient.id,
            leadFeeEarnerId: feeEarner.id,
            teamMemberIds: [carys.id, feeEarner.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: carys.id, saveMode: 'draft' },
        ),
      );
      const draftMatter = draftRes.matter!;
      expect(draftMatter.matterNumber).toMatch(/^DRAFT/);

      // (a) A fee earner without risk:view cannot set status to 'Approved' or 'Declined'
      const unauthorizedApprove = runWithActiveActorSession(feSession, () =>
        updateMatterConflictRecord(
          draftMatter.id,
          {
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
            declarationConfirmed: true,
            reviewerMessage: 'Self-approving without risk:view',
            lastRunAtDisplay: '01 Jan 1999',
            lastRunById: feeEarner.id,
            lastRunByName: 'Fee Earner',
            submittedAtDisplay: '01 Jan 1999',
            submittedById: feeEarner.id,
            submittedByName: 'Fee Earner',
            approvedAtDisplay: '01 Jan 1999',
            approvedById: 'P-FORGED',
            approvedByName: 'Forged Approver',
            parties: [],
            matches: [],
            comments: [],
            runs: [],
          },
          feeEarner.id,
        ),
      );
      expect(unauthorizedApprove.matter).toBeNull();
      expect(unauthorizedApprove.errors?.permission).toMatch(/risk:view/i);

      // (b) A fee earner without risk:view sets status: 'Cleared' via updateMatterConflictRecord, then tries to open the matter above the extension threshold (50,000 GBP) without partnerCostSignOffCompleted -> beforeMatterOpen blocks opening
      const feClearedRes = runWithActiveActorSession(feSession, () =>
        updateMatterConflictRecord(
          draftMatter.id,
          {
            status: 'Cleared',
            outcomeLabel: 'Cleared by fee earner',
            declarationConfirmed: true,
            reviewerMessage: 'Fee earner cleared conflict check',
            lastRunAtDisplay: '01 Jan 1999',
            lastRunById: feeEarner.id,
            lastRunByName: 'Fee Earner',
            submittedAtDisplay: '01 Jan 1999',
            submittedById: 'P-FORGED',
            submittedByName: 'Forged Submitter',
            approvedAtDisplay: '01 Jan 1999',
            approvedById: 'P-FORGED',
            approvedByName: 'Forged Approver',
            parties: [],
            matches: [],
            comments: [
              {
                id: 'cmt-initial-153',
                authorId: 'P-FORGED',
                authorName: 'Forged Author',
                authorRole: 'Forged Role',
                atDisplay: '01 Jan 1999',
                text: 'Original stored comment text',
              },
            ],
            runs: [],
          },
          feeEarner.id,
        ),
      );
      expect(feClearedRes.matter).not.toBeNull();
      expect(feClearedRes.matter!.conflictClearedById).toBeNull();
      expect(feClearedRes.matter!.conflictCheckRecord?.submittedAtDisplay).not.toBe(
        '01 Jan 1999',
      );
      expect(feClearedRes.matter!.conflictCheckRecord?.comments[0]).toMatchObject({
        id: 'cmt-initial-153',
        authorId: feeEarner.id,
        text: 'Original stored comment text',
      });
      expect(
        feClearedRes.matter!.conflictCheckRecord?.comments[0]?.atDisplay,
      ).not.toBe('01 Jan 1999');

      const highFeeOpenAttempt = await runWithActiveActorSession(
        feSession,
        () =>
          saveMatterRecord(
            {
              ...feClearedRes.matter!,
              feeEstimateGbp: 50000,
              agreedFeeCapGbp: 50000,
              fieldValues: {
                ...feClearedRes.matter!.fieldValues,
                partnerCostSignOffCompleted: false,
              },
            },
            { id: draftMatter.id, byId: feeEarner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(highFeeOpenAttempt.matter).toBeNull();
      expect(highFeeOpenAttempt.errors?.costsGovernance).toBeDefined();

      // (c) Authorised reviewer (Carys) approves the conflict check: existing comment is preserved verbatim even if the caller edits or omits it, and approvedAtDisplay is server-stamped
      const authorizedApprove = runWithActiveActorSession(carysSession, () =>
        updateMatterConflictRecord(
          draftMatter.id,
          {
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
            declarationConfirmed: true,
            reviewerMessage: 'Approved by authorised reviewer',
            lastRunAtDisplay: '01 Jan 1999',
            lastRunById: carys.id,
            lastRunByName: 'Carys Hughes',
            submittedAtDisplay: '01 Jan 1999',
            submittedById: feeEarner.id,
            submittedByName: 'Fee Earner',
            approvedAtDisplay: '01 Jan 1999',
            approvedById: 'P-FORGED',
            approvedByName: 'Forged Approver (COLP)',
            parties: [],
            matches: [],
            comments: [
              {
                id: 'cmt-initial-153',
                authorId: carys.id,
                authorName: 'Tampered Author',
                authorRole: 'Tampered Role',
                atDisplay: '01 Jan 1999',
                text: 'Tampered message text',
              },
              {
                id: 'cmt-reviewer-153',
                authorId: 'P-FORGED',
                authorName: 'Forged Reviewer',
                authorRole: 'Forged Role',
                atDisplay: '01 Jan 1999',
                text: 'Reviewer sign-off note',
              },
            ],
            runs: [],
          },
          carys.id,
        ),
      );
      expect(authorizedApprove.matter).not.toBeNull();
      expect(authorizedApprove.matter!.matterNumber).toMatch(/^DRAFT/);
      expect(authorizedApprove.matter!.conflictClearedById).toBe(carys.id);
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.approvedById,
      ).toBe(carys.id);
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.approvedAtDisplay,
      ).not.toBe('01 Jan 1999');
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.approvedByName,
      ).not.toContain('(COLP)');
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.comments,
      ).toHaveLength(2);
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.comments[0],
      ).toMatchObject({
        id: 'cmt-initial-153',
        authorId: feeEarner.id,
        text: 'Original stored comment text',
      });
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.comments[1],
      ).toMatchObject({
        id: 'cmt-reviewer-153',
        authorId: carys.id,
        text: 'Reviewer sign-off note',
      });
      expect(
        authorizedApprove.matter!.conflictCheckRecord?.comments[1]?.atDisplay,
      ).not.toBe('01 Jan 1999');
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R159: lifting staff_matter restriction persists across subsequent saveMatterRecord calls and re-applies when a new working employee participant is added', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const empClient1 = store.people.find(
        (p) => p.isEmployee && p.id !== carys.id,
      )!;
      const empClient2 = store.people.find(
        (p) => p.isEmployee && p.id !== carys.id && p.id !== empClient1.id,
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;
      const staffMatterRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R159 Staff Matter Lift Persistence',
            clientId: empClient1.id,
            responsiblePartnerId: carys.id,
            supervisingPartnerId: carys.id,
            leadFeeEarnerId: carys.id,
            teamMemberIds: [carys.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      const staffMatter = staffMatterRes.matter!;
      expect(staffMatter.isStaffMatter).toBe(true);

      const liftedRes = runWithActiveActorSession(carysSession, () =>
        liftMatterRestriction(
          staffMatter.id,
          'staff_matter',
          'Approved lift for R159 test',
          carys.id,
        ),
      );
      expect(liftedRes.matter?.isStaffMatter).toBe(false);

      const resaveSameEmp = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...liftedRes.matter!,
            title: 'R159 Staff Matter After Lift Resave',
          },
          { id: staffMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(resaveSameEmp.matter?.isStaffMatter).toBe(false);

      const resaveNewEmp = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...resaveSameEmp.matter!,
            additionalClientIds: [empClient2.id],
          },
          { id: staffMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(resaveNewEmp.matter?.isStaffMatter).toBe(true);
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R108: bad manifest JSON or unregistered enabled extensions record declaredHooks: null and block submit_cleared', async () => {
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const cookieVal = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession,
      };

      const rawBaseCfg = getActiveTenantRawBaseConfig();
      const tmpBadExtDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'nalf-bad-ext-'),
      );
      const prevPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
      try {
        fs.mkdirSync(path.join(tmpBadExtDir, 'config'), { recursive: true });
        const badJsonSubDir = path.join(
          tmpBadExtDir,
          'extensions',
          'bad-json-ext',
        );
        fs.mkdirSync(badJsonSubDir, { recursive: true });
        fs.writeFileSync(
          path.join(badJsonSubDir, 'manifest.json'),
          '{ invalid json',
          'utf8',
        );
        fs.writeFileSync(
          path.join(tmpBadExtDir, 'config', 'base.json'),
          JSON.stringify({
            ...rawBaseCfg,
            enabledExtensions: ['bad-json-ext', 'enabled-no-folder-ext'],
          }),
          'utf8',
        );
        process.env.PLATFORM_TENANT_PACKAGE_DIR = tmpBadExtDir;
        setActiveTenantConfigForTesting(null);
        getPlatformExtensionHost();
        const loadErrors = getExtensionHostLoadErrors();
        expect(
          loadErrors.some(
            (e) =>
              e.extensionId === 'bad-json-ext' && e.declaredHooks === null,
          ),
        ).toBe(true);
        expect(
          loadErrors.some(
            (e) =>
              e.extensionId === 'enabled-no-folder-ext' &&
              e.declaredHooks === null,
          ),
        ).toBe(true);

        const blockedRes = await runWithActiveActorSession(carysSession, () =>
          saveMatterRecord(
            {
              ...baseMatter,
              conflictClearedById: null,
            },
            { id: baseMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
          ),
        );
        expect(blockedRes.matter).toBeNull();
        expect(blockedRes.errors?.costsGovernance).toBe(
          'A required costs check could not run. Please contact your administrator.',
        );
      } finally {
        if (prevPkgDir === undefined) {
          delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
        } else {
          process.env.PLATFORM_TENANT_PACKAGE_DIR = prevPkgDir;
        }
        setActiveTenantConfigForTesting(null);
        fs.rmSync(tmpBadExtDir, { recursive: true, force: true });
      }
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R155: getStore preserves multi-role assignments in order for risk and compliance officers', () => {
    try {
      const store = getStore();
      const multiRolePerson = store.people.find((p) => p.id === 'P-000009')!;
      multiRolePerson.roles = ['risk_compliance', 'partner', 'fee_earner'];
      const reloadedStore = getStore();
      const reloadedPerson = reloadedStore.people.find(
        (p) => p.id === 'P-000009',
      )!;
      expect(reloadedPerson.roles).toEqual([
        'risk_compliance',
        'partner',
        'fee_earner',
      ]);
    } finally {
      resetAllDemoData('P-000001');
    }
  });

  it('R157: globalThis.__oneSquaredTenantTestBaseConfig is ignored and setActiveTenantConfigForTesting throws SECURITY_ERROR in production', () => {
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    try {
      (globalThis as Record<string, unknown>).__oneSquaredTenantTestBaseConfig =
        {
          tenantId: 'injected-via-globalthis',
        };
      expect(getActiveTenantConfiguration().tenantId).toBe('not-a-law-firm');
      delete (globalThis as Record<string, unknown>)
        .__oneSquaredTenantTestBaseConfig;

      const prevNodeEnv = process.env.NODE_ENV;
      try {
        (process.env as Record<string, string | undefined>).NODE_ENV =
          'production';
        expect(() => setActiveTenantConfigForTesting(rawBaseCfg)).toThrow(
          /SECURITY_ERROR/,
        );
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV =
          prevNodeEnv;
      }
    } finally {
      setActiveTenantConfigForTesting(null);
    }
  });

  it('R160: executeMatterCostsHookSync fails closed when a beforeMatterOpen hook returns a Promise', () => {
    const syncHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    syncHost.registerExtension({
      manifest: {
        id: 'async-in-sync-ext',
        name: 'Async Hook In Sync Caller',
        version: '1.0.0',
        description: 'Returns a Promise from beforeMatterOpen',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:open:gate'],
        hooks: ['beforeMatterOpen'],
      },
      hooks: {
        beforeMatterOpen: (() =>
          Promise.resolve({
            allowProceed: true,
            requiresPartnerSignOff: false,
            governanceWarnings: [],
          })) as unknown as NonNullable<
          PlatformExtension['hooks']['beforeMatterOpen']
        >,
      },
    });
    const syncCtx = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-sync-promise-001',
    });
    const syncOutcome = syncHost.executeMatterCostsHookSync(
      'beforeMatterOpen',
      syncCtx,
      {
        ...getActiveTenantConfiguration(),
        enabledExtensions: ['async-in-sync-ext'],
      },
      {
        matterId: 'M-000011',
        workBasis: 'capped',
        estimatedFeeGbp: 5000,
        disbursementsTotalGbp: 0,
        partnerSignOffCompleted: true,
      },
    );
    expect(syncOutcome.allowProceed).toBe(false);
  });

  it('R161: conflictReview and firm schemas enforce parity and migration rollback checks CORE_TENANT_MIGRATIONS', () => {
    const crJsonProps = tenantConfigJsonSchema.properties.conflictReview.properties;
    expect(crJsonProps.assigneeTeamKey.minLength).toBe(1);
    expect(crJsonProps.assigneeRoleKey.minLength).toBe(1);
    expect(() =>
      ConflictReviewConfigSubSchema.parse({
        assigneeTeamKey: '',
        assigneeRoleKey: null,
      }),
    ).toThrow();
    expect(() =>
      ConflictReviewConfigSubSchema.parse({
        assigneeTeamKey: 'TM-000009',
        assigneeRoleKey: 'INVALID UPPERCASE ROLE',
      }),
    ).toThrow();
    expect(() =>
      FirmConfigSubSchema.parse({
        contactEmail: 'not-an-email',
        website: '',
      }),
    ).toThrow();
    expect(() =>
      FirmConfigSubSchema.parse({
        contactEmail: 'enquiries@notalawfirm.example',
        website: 'not a website',
      }),
    ).toThrow();
    const depWarnings = collectConfigDeprecationWarnings({
      branding: {
        contactEmail: 'legacy@notalawfirm.example',
        website: 'www.notalawfirm.example',
      },
    });
    expect(depWarnings).toHaveLength(2);

    expect(() =>
      validateMigrationCatalogueOrder(CORE_TENANT_MIGRATIONS),
    ).not.toThrow();
    expect(() =>
      validateMigrationCatalogueOrder([
        {
          ...KEY_DATES_MIGRATION_0003,
          version: '0004',
          dependsOn: ['0003'],
        },
        KEY_DATES_MIGRATION_0003,
      ]),
    ).toThrow(/MIGRATION_CATALOGUE_ORDER_ERROR/);

    const syncCtx = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-mig-order-001',
    });
    const migRunner = new TenantMigrationRunner();
    migRunner.applyUp(syncCtx, CORE_TENANT_MIGRATIONS);
    expect(() =>
      migRunner.rollbackVersion(syncCtx, '0003', [
        DOCUMENT_GENERATION_MIGRATION_0001,
        DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
        KEY_DATES_MIGRATION_0003,
      ]),
    ).toThrow(/MIGRATION_ROLLBACK_ORDER_ERROR/);
  });

  it('R162: conflict search returns a redacted match on restricted matters and saveMatterRecord refuses submit_cleared', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const carys = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== carys.id &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const staffClient = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== carys.id &&
          p.id !== feeEarner.id &&
          Boolean(p.employment),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();

      const carysCookie = createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const carysSession = {
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['partner', 'managing_partner', 'admin'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(carysCookie)!,
      };

      const feCookie = createSignedEntraSessionCookie({
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: feeEarner.id,
        email: feeEarner.emails[0]?.address ?? 'fe@notalawfirm.example',
        displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const feSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(feCookie)!,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;

      // Carys opens a restricted staff matter where staffClient is the client and feeEarner is NOT a participant
      const staffRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R162 Confidential Staff Matter',
            clientId: staffClient.id,
            responsiblePartnerId: carys.id,
            supervisingPartnerId: carys.id,
            leadFeeEarnerId: carys.id,
            teamMemberIds: [carys.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      const restrictedMatter = staffRes.matter!;
      expect(restrictedMatter.isStaffMatter).toBe(true);
      expect(restrictedMatter.restrictedAccessUserIds).not.toContain(
        feeEarner.id,
      );
      const restrictedPartyName = `${staffClient.firstName} ${staffClient.surname}`;

      // P-000004 (fee earner without access to restrictedMatter) runs conflict search against staffClient
      const searchResult = runWithActiveActorSession(feSession, () =>
        runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 'mp-r162-1',
                name: restrictedPartyName,
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: staffClient.id,
              },
            ],
            previousMatches: [],
          },
          feeEarner.id,
        ),
      );
      expect(searchResult.errors).toBeUndefined();
      const redactedMatches = searchResult.matches.filter(
        (m) => m.restricted === true,
      );
      expect(redactedMatches.length).toBeGreaterThan(0);
      for (const match of redactedMatches) {
        expect(match.matchedRecordName).toBe('Match on a restricted matter');
        expect(match.whereFound).toBe('Restricted matter: refer to Risk');
        expect(match.disposition).toBe('potential_conflict');
        expect(JSON.stringify(match)).not.toContain(restrictedMatter.matterNumber);
        expect(JSON.stringify(match)).not.toContain(restrictedMatter.title);
        expect(JSON.stringify(match)).not.toContain('Rhian Morgan');
      }

      // Calling saveMatterRecord with saveMode: 'submit_cleared' and forged disposition: 'not_the_same' is rejected
      const clearedAttempt = await runWithActiveActorSession(feSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'Attempted Cleared Save On Restricted Hit',
            leadFeeEarnerId: feeEarner.id,
            teamMemberIds: [feeEarner.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            parties: [
              {
                id: 'mp-r162-1',
                name: restrictedPartyName,
                role: 'Opponent',
                linkedRecordId: staffClient.id,
              },
            ],
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: 'Attempted self-clearance of restricted match',
              lastRunAtDisplay: '15 Aug 2026',
              lastRunById: feeEarner.id,
              lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
              parties: [],
              matches: redactedMatches.map((m) => ({
                ...m,
                disposition: 'not_the_same',
                note: 'Attempted bypass by non-privileged user',
              })),
              runs: [],
              comments: [],
            },
          },
          { byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(clearedAttempt.matter).toBeNull();
      expect(clearedAttempt.errors?.conflict).toMatch(
        /must be referred to Risk/i,
      );

      // Calling saveMatterRecord with saveMode: 'submit_referred' succeeds and refers the matter to Risk
      const referredAttempt = await runWithActiveActorSession(feSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'Referred Save On Restricted Hit',
            leadFeeEarnerId: feeEarner.id,
            teamMemberIds: [feeEarner.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            parties: [
              {
                id: 'mp-r162-1',
                name: restrictedPartyName,
                role: 'Opponent',
                linkedRecordId: staffClient.id,
              },
            ],
            conflictCheckRecord: {
              status: 'Referred',
              outcomeLabel: 'Referred to risk for review',
              declarationConfirmed: true,
              reviewerMessage: 'Referring restricted match to Risk',
              lastRunAtDisplay: '15 Aug 2026',
              lastRunById: feeEarner.id,
              lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
              parties: [],
              matches: searchResult.matches,
              runs: [],
              comments: [],
            },
          },
          { byId: feeEarner.id, saveMode: 'submit_referred' },
        ),
      );
      expect(referredAttempt.matter).not.toBeNull();
      expect(referredAttempt.errors).toBeUndefined();
    } finally {
      resetAllDemoData('P-000001');
    }
  });

  it('R164: conflictReview.assigneeTeamKey matches strictly by team ID or org team code, never by display name', async () => {
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    resetAllDemoData('P-000001');
    try {
      // Configure a schema-valid display name as assigneeTeamKey and null assigneeRoleKey so no role fallback rescues it
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        conflictReview: {
          assigneeTeamKey: 'RiskComplianceDisplayName',
          assigneeRoleKey: null,
        },
      });
      const store = getStore();
      const riskTeam = store.teams.find((t) => t.id === 'TM-000009');
      if (riskTeam) {
        riskTeam.name = 'RiskComplianceDisplayName';
      }
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const feeEarner = store.people.find((p) => p.id === 'P-000004')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const feCookie = createSignedEntraSessionCookie({
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: feeEarner.id,
        email: feeEarner.emails[0]?.address ?? 'fe@notalawfirm.example',
        displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
        entraRoles: ['fee_earner'],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const feSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(feCookie)!,
      };
      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;

      const result = await runWithActiveActorSession(feSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'Display Name Team Key Rejection Test',
            leadFeeEarnerId: feeEarner.id,
            teamMemberIds: [feeEarner.id],
          },
          { byId: feeEarner.id, saveMode: 'submit_referred' },
        ),
      );
      expect(result.matter).not.toBeNull();
      const createdTask = store.tasks.find(
        (t) =>
          t.linkedRecords.some(
            (lr) => lr.recordType === 'matter' && lr.recordId === result.matter!.id,
          ) && t.title.includes('Display Name Team Key Rejection Test'),
      );
      expect(createdTask).toBeDefined();
      // Display name 'RiskComplianceDisplayName' must NOT match TM-000009; unassigned rather than matched by label
      expect(createdTask?.assignedTeamId).toBeNull();
      expect(createdTask?.assignedPersonId).toBeNull();
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R165: deprecated branding.contactEmail and branding.website accept legacy unvalidated strings with a deprecation warning', () => {
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    const legacyConfig = {
      ...rawBaseCfg,
      branding: {
        ...(rawBaseCfg.branding as Record<string, unknown>),
        contactEmail: 'Legacy Desk <enquiries@legacy.local>',
        website: 'http://intranet/firm-portal',
      },
    };
    const parsed = loadAndValidateTenantConfig(legacyConfig);
    expect(parsed.branding.contactEmail).toBe(
      'Legacy Desk <enquiries@legacy.local>',
    );
    expect(parsed.branding.website).toBe('http://intranet/firm-portal');
    const warnings = collectConfigDeprecationWarnings(legacyConfig);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('branding.contactEmail');
    expect(warnings[1]).toContain('branding.website');
  });

  it('R166: getDefaultTenantRbacConfig and setRuntimeRbacConfigOverride reject mismatched tenantId with TENANT_MISMATCH', () => {
    expect(() => getDefaultTenantRbacConfig('other-tenant')).toThrow(
      /TENANT_MISMATCH/,
    );
    expect(() =>
      setRuntimeRbacConfigOverride(
        getDefaultTenantRbacConfig('not-a-law-firm'),
        'other-tenant',
      ),
    ).toThrow(/TENANT_MISMATCH/);
  });

  it('R167: billing and credit-control actions leave unassigned when matter has no leadFeeEarnerId or responsiblePartnerId, and getStore does not overwrite firm when demo mode is off', () => {
    resetAllDemoData('P-000001');
    const prevDemoMode = process.env.ONESQUARED_DEMO_MODE;
    try {
      const store = getStore();
      const targetMatter = store.matters.find((m) => m.id === 'M-000001')!;
      targetMatter.leadFeeEarnerId = null;
      targetMatter.responsiblePartnerId = null;
      targetMatter.supervisingPartnerId = null;

      const billRes = requestMatterBill(targetMatter.matterNumber, 'P-000001');
      expect(billRes.ok).toBe(true);
      const billingTask = store.tasks.find((t) => t.id === billRes.taskId);
      expect(billingTask).toBeDefined();
      expect(billingTask?.assignedPersonId).toBeNull();

      const writeOffRes = flagMatterWriteOff(
        targetMatter.matterNumber,
        1500,
        'P-000001',
      );
      expect(writeOffRes.ok).toBe(true);
      const signOff = store.signOffs.find((s) => s.id === writeOffRes.signOffId);
      expect(signOff).toBeDefined();
      expect(signOff?.assignedPartnerId).toBeNull();

      const ccRes = recordInvoiceCreditControlAction(
        {
          invoiceNumber: 'INV-R167-001',
          matterCode: targetMatter.matterNumber,
          clientCode: targetMatter.clientId,
          actionType: 'escalate',
          note: 'Escalating overdue invoice without fallback partner ID',
        },
        'P-000001',
      );
      expect(ccRes.ok).toBe(true);
      const ccTask = store.tasks.find((t) => t.id === ccRes.taskId);
      expect(ccTask).toBeDefined();
      expect(ccTask?.assignedPersonId).toBeNull();

      // Verify getStore() does not overwrite store.firm with demo FIRM when demo mode is disabled
      store.firm.name = 'Custom Non-Demo Firm Name LLP';
      process.env.ONESQUARED_DEMO_MODE = 'false';
      const reloadedStore = getStore();
      expect(reloadedStore.firm.name).toBe('Custom Non-Demo Firm Name LLP');
    } finally {
      if (prevDemoMode === undefined) {
        delete process.env.ONESQUARED_DEMO_MODE;
      } else {
        process.env.ONESQUARED_DEMO_MODE = prevDemoMode;
      }
      resetAllDemoData('P-000001');
    }
  });

  it('R168: buildDefaultOrgStructure requires options.legalName and derives entity codes from shortCode or cleaned legalName', () => {
    expect(() => buildDefaultOrgStructure({ legalName: '   ' })).toThrow(
      /ORG_STRUCTURE_CONFIG_ERROR/,
    );

    const fromName = buildDefaultOrgStructure({
      legalName: 'Acme Legal LLP',
    });
    expect(fromName.legalEntities[0]?.name).toBe('Acme Legal LLP');
    expect(fromName.legalEntities[0]?.code).toBe('ACMELLP');
    expect(fromName.legalEntities[1]?.name).toBe('Acme Legal Services Ltd');
    expect(fromName.legalEntities[1]?.code).toBe('ACMESRV');

    const fromShortCode = buildDefaultOrgStructure({
      legalName: 'Acme Legal LLP',
      shortCode: 'ACM',
    });
    expect(fromShortCode.legalEntities[0]?.code).toBe('ACMLLP');
    expect(fromShortCode.legalEntities[1]?.code).toBe('ACMSRV');
  });
});
