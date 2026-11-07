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
  DocumentStoreTokenService,
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
  runTenantSharePointHealthCheckJob,
  SharePointDocumentStoreProvider,
  TenantMigrationRunner,
  TenantScopedEncryptedTokenCache,
  validateExtensionManifest,
  validateMigrationCatalogueOrder,
  type DocumentStoreConfig,
  type PlatformExtension,
} from '@platform/core';
import { MockSharePointGraphBackend } from '../src/testing';
import extensionManifestJsonSchema from '../schemas/extension-manifest.schema.json';
import tenantConfigJsonSchema from '../schemas/tenant-config.schema.json';
import { generateExtensionRegistry } from '../../scripts/generate-extension-registry';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';
import { notALawFirmMatterCostsExtension } from '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance/src/index';
import { syncHomeRolesWithEmployeeRoles } from '../../src/domain/homeConfig';
import {
  createDefaultEmploymentRecord,
  migrateEmployeesToEmploymentRecords,
} from '../../src/domain/employment';
import { createDefaultMatterCostsConfig } from '../../src/domain/matterCosts';
import { reconcileServerConflictMatches } from '../../src/domain/matterConflicts';
import {
  conflictStatusPillFromLegacy,
  legacyConflictStatusFromRecord,
  resolveMatterConflictCheckRecord,
} from '../../src/domain/matterOpeningRecord';
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
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  approveSignOff,
  createOrProposeKeyDateRecord,
  discussSignOff,
  flagMatterWriteOff,
  getAppSnapshot,
  getKeyDateExceptionsReportRecord,
  getMatterPmsViewBundle,
  liftMatterRestriction,
  markEngagementLetterDrafted,
  queryKeyDatesTeamDiaryRecord,
  recordInvoiceCreditControlAction,
  recordKeyDateNotApplicableRecord,
  requestMatterBill,
  resetAllDemoData,
  runMatterConflictSearchRecord,
  saveMatterRecord,
  savePersonRecord,
  signOffMatterCostsRecord,
  updateMatterConflictRecord,
} from '../../src/server/services';
import {
  addNoteAction,
  addTaskCommentAction,
  approveSignOffAction,
  assignEnquiryAction,
  closeEnquiryAction,
  deleteLinkAction,
  discussSignOffAction,
  dismissDuplicateAction,
  linkPmsRecordAction,
  logEnquiryContactAction,
  logQuoteFollowUpAction,
  markQuoteSentAction,
  mergeRecordsAction,
  reassignLeaverOwnedRecordsAction,
  recordQuoteOutcomeAction,
  reorderChoiceValueAction,
  reorderCustomFieldAction,
  reopenEnquiryAction,
  reviseQuoteAction,
  saveCustomFieldAction,
  saveEnquiryAction,
  saveLinkAction,
  saveMatterAction,
  saveOrganisationAction,
  savePersonAction,
  saveQuoteAction,
  saveTaskAction,
  saveTeamAction,
  sendEnquiryEmailAction,
  takeTaskAction,
  unlinkPmsRecordAction,
  updateChoiceValueAction,
} from '../../src/app/actions';
import { isActionDenied } from '../../src/domain/actionResult';
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
      const baseMatter = store.matters.find((m) => m.id === 'M-000008')!;

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
      setTestEntraSessionOverride(undefined);
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
      const baseMatter = store.matters.find((m) => m.id === 'M-000008')!;
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
              },
              { id: baseMatter.id, byId: 'P-000001', saveMode: 'submit_cleared' },
            ),
        );
        expect(loadErrSaveRes.matter).toBeNull();
        expect(loadErrSaveRes.errors?.extensions).toBe(
          "A required opening check couldn't run. Please contact your administrator.",
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
      const targetMatter = store.matters.find((m) => m.id === 'M-000008')!;
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
      const baseMatter = store.matters.find((m) => m.id === 'M-000008')!;
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
            },
            { id: baseMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
          ),
        );
        expect(blockedRes.matter).toBeNull();
        expect(blockedRes.errors?.extensions).toBe(
          "A required opening check couldn't run. Please contact your administrator.",
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
      setTestEntraSessionOverride(undefined);
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

      // Risk & Compliance (Carys) approves the referred conflict check; server records approvedRestrictedMatchIds
      const referredMatter = referredAttempt.matter!;
      const riskApproveRes = runWithActiveActorSession(carysSession, () =>
        updateMatterConflictRecord(
          referredMatter.id,
          {
            ...referredMatter.conflictCheckRecord!,
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
          },
          carys.id,
        ),
      );
      expect(riskApproveRes.errors).toBeUndefined();
      expect(
        riskApproveRes.matter?.conflictCheckRecord?.approvedRestrictedMatchIds?.length,
      ).toBeGreaterThan(0);

      // Now create a SECOND restricted staff matter for a different employee
      const secondStaffClient = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== carys.id &&
          p.id !== feeEarner.id &&
          p.id !== staffClient.id &&
          Boolean(p.employment),
      )!;
      const secondStaffRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R162 Second Confidential Staff Matter',
            clientId: secondStaffClient.id,
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
      expect(secondStaffRes.matter?.isStaffMatter).toBe(true);

      // Fee earner adds secondStaffClient as a new party on the previously approved matter and tries submit_cleared
      // (even attempting to forge approvedRestrictedMatchIds in conflictCheckRecord)
      const secondPartyClearedAttempt = await runWithActiveActorSession(
        feSession,
        () =>
          saveMatterRecord(
            {
              ...referredMatter,
              parties: [
                ...referredMatter.parties,
                {
                  id: 'mp-r162-2',
                  name: `${secondStaffClient.firstName} ${secondStaffClient.surname}`,
                  role: 'Opponent',
                  linkedRecordId: secondStaffClient.id,
                },
              ],
              conflictCheckRecord: {
                ...riskApproveRes.matter!.conflictCheckRecord!,
                approvedRestrictedMatchIds: [
                  ...(riskApproveRes.matter!.conflictCheckRecord!
                    .approvedRestrictedMatchIds ?? []),
                  'forged-match-id',
                ],
              },
            },
            {
              id: referredMatter.id,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(secondPartyClearedAttempt.matter).toBeNull();
      expect(secondPartyClearedAttempt.errors?.conflict).toMatch(
        /must be referred to Risk/i,
      );
    } finally {
      setTestEntraSessionOverride(undefined);
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

    const store = getStore();
    const snap = getAppSnapshot('P-000001');
    expect(snap.suggestedMatterGovernanceAssignees).toBeDefined();
    expect(snap.suggestedMatterGovernanceAssignees.riskReviewerId).toBeTruthy();
    expect(
      snap.suggestedMatterGovernanceAssignees.practiceManagerId,
    ).toBeTruthy();

    const defaultEmp = createDefaultEmploymentRecord({
      person: { id: 'P-TEST-168', firstName: 'Test', surname: 'Employee' },
      allPeople: store.people,
      byId: 'P-000001',
      primaryDomain: 'notalawfirm.example',
    });
    expect(defaultEmp.departmentId).toBeTruthy();
    const migrated = migrateEmployeesToEmploymentRecords(
      store.people.slice(0, 2),
      store.values,
      undefined,
      [],
      'notalawfirm.example',
    );
    expect(migrated.people).toHaveLength(2);
  });

  it('R169: saveMatterRecord strips server-owned fieldValues, ignores caller conflictClearedById, preserves matterOpeningSnapshot on open matters, requires signOffMatterCostsRecord (matter:costs:sign_off), and resets sign-off if feeEstimateGbp changes', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
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
      const partnerCookie = createSignedEntraSessionCookie({
        personId: partner.id,
        tenantId: 'not-a-law-firm',
        oid: partner.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: partner.id,
        email: partner.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: `${partner.firstName} ${partner.surname}`,
        entraRoles: ['partner', 'managing_partner'],
        mappedRoles: ['partner', 'managing_partner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const partnerSession = {
        personId: partner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['partner', 'managing_partner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(partnerCookie)!,
      };

      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;

      await runWithActiveActorSession(feSession, async () => {
        // 1. Draft with £75,000 estimate + forged server-owned fieldValues + forged conflictClearedById
        const draftRes = await saveMatterRecord(
          {
            ...matterTemplate,
            title: 'R169 High Value Matter',
            leadFeeEarnerId: feeEarner.id,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            teamMemberIds: [feeEarner.id, partner.id],
            feeEstimateGbp: 75000,
            agreedFeeCapGbp: 75000,
            ...( { conflictClearedById: partner.id } as Record<string, unknown> ),
            fieldValues: {
              partnerCostSignOffCompleted: true,
              partnerCostSignOff: {
                byId: partner.id,
                byName: 'Forged',
                at: '2026-01-01T00:00:00Z',
                note: '',
                signedOffEstimateGbp: 75000,
              },
              matterOpeningSnapshot: { forged: true },
              matterCostsGovernance: { allowProceed: true },
              riskAssessment: {
                forged: true,
                overallRisk: 'Low',
                sections: [{ id: 'forged_section', title: 'Forged' }],
                answers: {
                  inScopeMlr: 'Yes, in scope',
                  highRiskJurisdictionLink: 'Yes',
                },
                followUps: {
                  highRiskJurisdictionLink:
                    'Linked counterparty in high-risk jurisdiction',
                },
              },
              customClientNote: 'preserved',
            },
          },
          { byId: feeEarner.id, saveMode: 'draft' },
        );
        expect(draftRes.errors).toBeUndefined();
        expect(draftRes.matter).not.toBeNull();
        const matterId = draftRes.matter!.id;
        expect(draftRes.matter!.conflictClearedById).toBeNull();
        expect(
          draftRes.matter!.fieldValues['partnerCostSignOffCompleted'],
        ).toBeUndefined();
        expect(
          draftRes.matter!.fieldValues['partnerCostSignOff'],
        ).toBeUndefined();
        expect(draftRes.matter!.fieldValues['customClientNote']).toBe(
          'preserved',
        );
        expect(
          (
            draftRes.matter!.fieldValues['matterOpeningSnapshot'] as {
              forged?: boolean;
            }
          )?.forged,
        ).toBeUndefined();
        const savedRisk = draftRes.matter!.fieldValues['riskAssessment'] as {
          forged?: boolean;
          overallRisk?: string;
          answers?: Record<string, string>;
          followUps?: Record<string, string>;
          sections?: Array<{ id: string }>;
        };
        expect(savedRisk?.forged).toBeUndefined();
        expect(savedRisk?.overallRisk).toBe('High');
        expect(savedRisk?.sections?.[0]?.id).toBe('about_instruction');
        expect(savedRisk?.answers?.highRiskJurisdictionLink).toBe('Yes');
        expect(savedRisk?.followUps?.highRiskJurisdictionLink).toBe(
          'Linked counterparty in high-risk jurisdiction',
        );
        expect(draftRes.matter!.riskRatingId).toBe('risk_rating.high');

        // 2. Attempting to open with forged partnerCostSignOffCompleted: true in fieldValues is blocked by beforeMatterOpen
        const forgedOpenRes = await saveMatterRecord(
          {
            ...draftRes.matter!,
            title: 'R169 High Value Matter',
            fieldValues: {
              ...draftRes.matter!.fieldValues,
              partnerCostSignOffCompleted: true,
            },
          },
          { id: matterId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        );
        expect(forgedOpenRes.matter).toBeNull();
        expect(forgedOpenRes.errors?.costsGovernance).toMatch(
          /partner.*sign-off/i,
        );

        // 3. Fee earner without matter:costs:sign_off cannot sign off
        const feSignOff = await signOffMatterCostsRecord(
          matterId,
          feeEarner.id,
          'Attempting self sign-off',
        );
        expect(feSignOff.matter).toBeNull();
        expect(feSignOff.errors?.permission).toMatch(/matter:costs:sign_off/i);

        // 4. Partner with matter:costs:sign_off signs off £75,000
        const partnerSignOff = await runWithActiveActorSession(
          partnerSession,
          () =>
            signOffMatterCostsRecord(
              matterId,
              partner.id,
              'Approved high-value estimate',
            ),
        );
        expect(partnerSignOff.errors).toBeUndefined();
        expect(
          partnerSignOff.matter?.fieldValues['partnerCostSignOffCompleted'],
        ).toBe(true);

        // 5. If fee earner raises feeEstimateGbp to £90,000 after sign-off, sign-off resets and opening is blocked
        const raisedOpenRes = await saveMatterRecord(
          {
            ...partnerSignOff.matter!,
            title: 'R169 High Value Matter',
            feeEstimateGbp: 90000,
            agreedFeeCapGbp: 90000,
          },
          { id: matterId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        );
        expect(raisedOpenRes.matter).toBeNull();
        expect(raisedOpenRes.errors?.costsGovernance).toMatch(
          /partner.*sign-off/i,
        );

        // 6. Opening at the signed-off £75,000 estimate succeeds and preserves matterOpeningSnapshot on subsequent edits
        const validOpenRes = await saveMatterRecord(
          {
            ...partnerSignOff.matter!,
            title: 'R169 High Value Matter',
            feeEstimateGbp: 75000,
            agreedFeeCapGbp: 75000,
            ...( { conflictClearedById: partner.id } as Record<string, unknown> ),
          },
          { id: matterId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        );
        expect(validOpenRes.errors).toBeUndefined();
        expect(validOpenRes.matter?.conflictClearedById).toBeNull();
        expect(
          store.audit.some(
            (a) =>
              a.recordId === matterId && a.field === 'Partner cost sign-off',
          ),
        ).toBe(true);
        const capturedAt = (
          validOpenRes.matter?.fieldValues['matterOpeningSnapshot'] as {
            capturedAt?: string;
          }
        )?.capturedAt;
        expect(capturedAt).toBeTruthy();

        const editOpenMatterRes = await saveMatterRecord(
          {
            ...validOpenRes.matter!,
            title: 'R169 High Value Matter (Updated Title)',
            fieldValues: {
              ...validOpenRes.matter!.fieldValues,
              matterOpeningSnapshot: { forgedOverwrite: true },
            },
          },
          { id: matterId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        );
        expect(editOpenMatterRes.errors).toBeUndefined();
        expect(
          (
            editOpenMatterRes.matter?.fieldValues['matterOpeningSnapshot'] as {
              capturedAt?: string;
              forgedOverwrite?: boolean;
            }
          )?.capturedAt,
        ).toBe(capturedAt);
        expect(
          (
            editOpenMatterRes.matter?.fieldValues['matterOpeningSnapshot'] as {
              forgedOverwrite?: boolean;
            }
          )?.forgedOverwrite,
        ).toBeUndefined();
      });
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R170: searchMatterConflicts redacts matches on restricted enquiries (converted to a staff matter or another user personal Draft)', () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const baseEnquiry = store.enquiries[0]!;

      // Create a restricted staff matter invisible to feeEarner
      store.matters.push({
        ...structuredClone(baseMatter),
        id: 'M-R170-STAFF',
        matterNumber: 'STF999-0001',
        title: 'Confidential Staff Matter',
        isStaffMatter: true,
        restrictedAccessUserIds: [partner.id],
        responsiblePartnerId: partner.id,
        supervisingPartnerId: partner.id,
        leadFeeEarnerId: partner.id,
        teamMemberIds: [partner.id],
      });

      // Create an enquiry converted into that restricted staff matter
      store.enquiries.push({
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R170-STAFF',
        reference: 'ENQ-R170-STAFF',
        status: 'Converted',
        firstName: 'Private',
        lastName: 'StaffCaller',
        callingOnBehalfOf: 'SecretStaffOrg LLP',
        otherPartiesNamed: 'HiddenEnquiryOpponent Ltd',
        summary: 'Confidential disciplinary advice',
        convertedMatterId: 'M-R170-STAFF',
        createdById: partner.id,
        takenById: partner.id,
      });

      // Also create a personal Draft enquiry belonging to partner (invisible to feeEarner)
      store.enquiries.push({
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R170-DRAFT',
        reference: 'ENQ-R170-DRAFT',
        status: 'Draft',
        firstName: 'DraftOnly',
        lastName: 'PrivateEnquirer',
        summary: 'Unpublished personal draft enquiry',
        convertedMatterId: null,
        createdById: partner.id,
        takenById: partner.id,
      });

      const res = runMatterConflictSearchRecord(
        {
          currentMatterId: null,
          parties: [
            {
              id: 'pty-r170-1',
              name: 'Private StaffCaller',
              entityType: 'person',
              role: 'Opponent',
              linkedRecordId: null,
            },
            {
              id: 'pty-r170-2',
              name: 'DraftOnly PrivateEnquirer',
              entityType: 'person',
              role: 'Opponent',
              linkedRecordId: null,
            },
          ],
        },
        feeEarner.id,
      );

      expect(res.errors).toBeUndefined();
      const restrictedMatches = res.matches.filter((m) => m.restricted);
      expect(restrictedMatches.length).toBe(2);
      for (const rm of restrictedMatches) {
        expect(rm.matchedRecordName).toBe('Match on a restricted enquiry');
        expect(rm.whereFound).toBe('Restricted enquiry: refer to Risk');
        expect(rm.matterNumber).toBeNull();
        expect(rm.responsiblePartnerName).toBe('');
        expect(rm.disposition).toBe('potential_conflict');
      }
      const serialized = JSON.stringify(res.matches);
      expect(serialized).not.toContain('ENQ-R170-STAFF');
      expect(serialized).not.toContain('Confidential disciplinary advice');
      expect(serialized).not.toContain('ENQ-R170-DRAFT');
      expect(serialized).not.toContain('Unpublished personal draft enquiry');
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R172: runMatterConflictSearchRecord logs count-only restricted conflict match audit entries and structured logs with no party or record names', () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseEnquiry = store.enquiries[0]!;

      store.enquiries.push({
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R172-DRAFT',
        reference: 'ENQ-R172-DRAFT',
        status: 'Draft',
        firstName: 'SecretDraft',
        lastName: 'CallerName',
        summary: 'Sensitive draft enquiry summary',
        convertedMatterId: null,
        createdById: partner.id,
        takenById: partner.id,
      });

      const auditCountBefore = store.audit.length;
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        // 1. Unsaved matter (currentMatterId: null) writes the structured log only, not store.audit
        const unsavedRes = runMatterConflictSearchRecord(
          {
            currentMatterId: null,
            parties: [
              {
                id: 'pty-r172-1',
                name: 'SecretDraft CallerName',
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          feeEarner.id,
        );
        expect(unsavedRes.errors).toBeUndefined();
        expect(unsavedRes.matches.some((m) => m.restricted)).toBe(true);
        expect(store.audit.length).toBe(auditCountBefore);

        // 2. Saved matter (currentMatterId: 'M-000001') writes both the count-only audit entry and structured log
        const res = runMatterConflictSearchRecord(
          {
            currentMatterId: 'M-000001',
            parties: [
              {
                id: 'pty-r172-1',
                name: 'SecretDraft CallerName',
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          feeEarner.id,
        );
        expect(res.errors).toBeUndefined();
        expect(res.matches.some((m) => m.restricted)).toBe(true);

        expect(store.audit.length).toBe(auditCountBefore + 1);
        const latestAudit = store.audit[0]!;
        expect(latestAudit.recordId).toBe('M-000001');
        expect(latestAudit.field).toBe('Conflict check restricted match');
        expect(latestAudit.newValue).toContain('Restricted conflict match count: 1');
        expect(latestAudit.newValue).not.toContain('SecretDraft CallerName');
        expect(latestAudit.newValue).not.toContain('ENQ-R172-DRAFT');

        const logCall = infoSpy.mock.calls.find((call) =>
          String(call[0]).includes('conflict_search_restricted_match'),
        );
        expect(logCall).toBeDefined();
        const logJson = String(logCall![0]);
        expect(logJson).not.toContain('SecretDraft CallerName');
        expect(logJson).not.toContain('ENQ-R172-DRAFT');
        const parsedLog = JSON.parse(logJson);
        expect(parsedLog.restrictedCount).toBe(1);
        expect(parsedLog.partiesCount).toBe(1);
      } finally {
        infoSpy.mockRestore();
      }
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R173: saveMatterRecord runs beforeMatterOpen on every non-draft save until the matter has opened, and updateMatterConflictRecord keeps referred matters Prospective until partner cost sign-off', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const riskOfficer = store.people.find((p) =>
        (p.roles ?? []).includes('risk_compliance'),
      )!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          p.id !== riskOfficer.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const prospectiveStatusId =
        store.values.find(
          (v) =>
            v.listKey === 'matter_status' &&
            v.label === 'Prospective / Enquiry',
        )?.id ?? 'matter_status.prospective_enquiry';
      const activeStatusId =
        store.values.find(
          (v) => v.listKey === 'matter_status' && v.label === 'Active',
        )?.id ?? 'matter_status.active';

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeActorSession = (
        person: typeof partner,
        roles: string[],
        fallbackEmail: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id.replace(/\D/g, '').padStart(12, '0')}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email: person.emails[0]?.address ?? fallbackEmail,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };
      const feeEarnerSession = makeActorSession(
        feeEarner,
        feeEarner.roles ?? ['fee_earner'],
        'fe@notalawfirm.example',
      );
      const riskSession = makeActorSession(
        riskOfficer,
        riskOfficer.roles ?? ['risk_compliance'],
        'risk@notalawfirm.example',
      );
      const partnerSession = makeActorSession(
        partner,
        partner.roles ?? ['partner', 'managing_partner'],
        'partner@notalawfirm.example',
      );

      // 1. Refer a matter with a £10,000 estimate (below £50,000 partner sign-off threshold), and verify existing Prospective fixture M-000016 is refused on submit_referred at £75,000
      const fixtureM16 = store.matters.find((m) => m.id === 'M-000016')!;
      const fixtureM16ReferHigh = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM16,
              feeEstimateGbp: 75000,
              agreedFeeCapGbp: 75000,
            },
            { id: fixtureM16.id, byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(fixtureM16ReferHigh.matter).toBeNull();
      expect(fixtureM16ReferHigh.errors?.costsGovernance).toMatch(
        /partner.*sign-off/i,
      );

      const referLowRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R173 Referred Matter',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              parties: [],
            },
            { byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(referLowRes.errors).toBeUndefined();
      expect(referLowRes.matter?.matterStatusId).toBe(prospectiveStatusId);
      const matterId = referLowRes.matter!.id;

      // 2. Saving the referred matter with a £75,000 estimate and saveMode: 'submit_referred' runs beforeMatterOpen and returns errors.costsGovernance
      const referHighRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referLowRes.matter!,
              title: 'R173 Referred Matter',
              feeEstimateGbp: 75000,
              agreedFeeCapGbp: 75000,
            },
            { id: matterId, byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(referHighRes.matter).toBeNull();
      expect(referHighRes.errors?.costsGovernance).toMatch(/partner.*sign-off/i);

      // 3. Raising the estimate to £75,000 on a draft save updates matterOpeningGate.allowProceed to false; Risk approval then keeps the matter in prospectiveStatus until a partner signs off
      const draftHighRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referLowRes.matter!,
              title: 'R173 Referred Matter',
              feeEstimateGbp: 75000,
              agreedFeeCapGbp: 75000,
            },
            { id: matterId, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(draftHighRes.errors).toBeUndefined();
      expect(
        (
          draftHighRes.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(false);

      const riskApproveBeforeSignOff = runWithActiveActorSession(
        riskSession,
        () =>
          updateMatterConflictRecord(
            matterId,
            {
              ...draftHighRes.matter!.conflictCheckRecord!,
              status: 'Approved',
              outcomeLabel: 'Approved by Risk & Compliance',
            },
            riskOfficer.id,
          ),
      );
      expect(riskApproveBeforeSignOff.errors).toBeUndefined();
      expect(riskApproveBeforeSignOff.matter?.matterStatusId).toBe(
        prospectiveStatusId,
      );
      expect(riskApproveBeforeSignOff.warnings?.[0]).toMatch(
        /partner cost sign-off/i,
      );

      // 4. Once a partner signs off the £75,000 estimate, the matter transitions to Active
      const partnerSignOffRes = await runWithActiveActorSession(
        partnerSession,
        () =>
          signOffMatterCostsRecord(
            matterId,
            partner.id,
            'Approved £75,000 estimate',
          ),
      );
      expect(partnerSignOffRes.errors).toBeUndefined();
      expect(partnerSignOffRes.matter?.matterStatusId).toBe(activeStatusId);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R174: getAppSnapshot conflict reviewer resolution uses stable team id/code and configured assigneeRoleKey without matching team display names or hard-coding risk_compliance', () => {
    resetAllDemoData('P-000001');
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const nonRiskEmployee = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          p.employeeRoleId !== 'employee_role.risk_and_compliance' &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;

      // 1. Team whose display name (not id or code) equals assigneeTeamKey is NOT picked
      store.teams.push({
        id: 'TM-R174-NAME-ONLY',
        name: 'custom-team-key-by-name',
        description: 'Name collision test team',
        memberIds: [nonRiskEmployee.id],
        leadIds: [nonRiskEmployee.id],
        practiceAreaIds: [],
        active: true,
        createdById: partner.id,
        createdAt: new Date().toISOString(),
        updatedById: partner.id,
        updatedAt: new Date().toISOString(),
      });

      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeTeamKey: 'custom-team-key-by-name',
        },
      });
      const snapByName = getAppSnapshot(partner.id);
      expect(
        snapByName.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBeNull();

      // 2. Custom assigneeRoleKey selects a holder of that role, not a holder of risk_compliance (and R180d: scopes to assigneeTeamKey when configured)
      nonRiskEmployee.employeeRoleId = 'employee_role.custom_conflict_reviewer';
      const emptyCustomTeamId = 'TM-R174-EMPTY-TEAM';
      store.teams.push({
        id: emptyCustomTeamId,
        name: 'Conflict Review Team Without Custom Role Holder',
        description: 'Team that does not include nonRiskEmployee',
        memberIds: [partner.id],
        leadIds: [partner.id],
        practiceAreaIds: [],
        active: true,
        createdById: partner.id,
        createdAt: new Date().toISOString(),
        updatedById: partner.id,
        updatedAt: new Date().toISOString(),
      });
      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeTeamKey: emptyCustomTeamId,
          assigneeRoleKey: 'employee_role.custom_conflict_reviewer',
        },
      });
      const snapRoleOutsideTeam = getAppSnapshot(partner.id);
      expect(
        snapRoleOutsideTeam.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBeNull();

      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeRoleKey: 'employee_role.custom_conflict_reviewer',
        },
      });
      const snapCustomRole = getAppSnapshot(partner.id);
      expect(
        snapCustomRole.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBe(nonRiskEmployee.id);
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R175: user with risk:view (and matter:create/edit) but without matter:restricted:access cannot submit_cleared on an unapproved restricted match unless recording status Approved', async () => {
    resetAllDemoData('P-000001');
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const customReviewer = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;

      // Create a restricted staff matter invisible to customReviewer (since customReviewer lacks matter:restricted:access)
      store.matters.push({
        ...structuredClone(baseMatter),
        id: 'M-R175-STAFF',
        matterNumber: 'STF175-0001',
        title: 'Restricted Staff Matter R175',
        isStaffMatter: true,
        restrictedAccessUserIds: [partner.id],
        responsiblePartnerId: partner.id,
        supervisingPartnerId: partner.id,
        leadFeeEarnerId: partner.id,
        teamMemberIds: [partner.id],
        parties: [
          {
            id: 'pty-r175-secret',
            name: 'ConfidentialStaffTarget Ltd',
            entityType: 'organisation',
            role: 'Opponent',
            relationshipCode: 'OP',
            capacityCodes: ['CAP_DEFENDANT'],
            alignment: 'adverse',
            linkedRecordId: null,
          },
        ],
      });

      // Grant customReviewer a role with risk:view, matter:create, and matter:edit, but NOT matter:restricted:access
      const currentRbac = getActiveTenantConfiguration().rbac;
      const customRoles = {
        ...currentRbac.roles,
        junior_risk_reviewer: {
          key: 'junior_risk_reviewer',
          label: 'Junior Risk Reviewer',
          description: 'Can view risk queue and edit matters without unrestricted staff matter access',
          permissions: [
            'matter:view',
            'matter:create',
            'matter:edit',
            'risk:view',
          ] as never,
        },
      };
      setRuntimeRbacConfigOverride({
        ...currentRbac,
        roles: customRoles,
      });
      customReviewer.roles = ['junior_risk_reviewer' as never];

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const reviewerCookie = createSignedEntraSessionCookie({
        personId: customReviewer.id,
        tenantId: 'not-a-law-firm',
        oid: customReviewer.entraObjectId ?? '00000000-0000-4000-8000-000000000175',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: customReviewer.id,
        email: customReviewer.emails[0]?.address ?? 'jr@notalawfirm.example',
        displayName: 'Junior Reviewer',
        entraRoles: ['junior_risk_reviewer'],
        mappedRoles: ['junior_risk_reviewer'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const reviewerSession = {
        personId: customReviewer.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['junior_risk_reviewer'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(reviewerCookie)!,
      };

      // 1. Attempting submit_cleared with conflictCheckRecord.status === 'Cleared' is refused because the restricted match is unapproved
      const clearedAttempt = await runWithActiveActorSession(
        reviewerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R175 Matter With Restricted Hit',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: customReviewer.id,
              feeEstimateGbp: 5000,
              parties: [
                {
                  id: 'pty-r175-1',
                  name: 'ConfidentialStaffTarget Ltd',
                  entityType: 'organisation',
                  role: 'Opponent',
                  relationshipCode: 'OP',
                  capacityCodes: ['CAP_DEFENDANT'],
                  alignment: 'adverse',
                  linkedRecordId: null,
                },
              ],
              conflictCheckRecord: {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: null,
                lastRunById: null,
                lastRunByName: null,
                parties: [],
                matches: [],
                runs: [],
                comments: [],
              },
            },
            { byId: customReviewer.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(clearedAttempt.matter).toBeNull();
      expect(clearedAttempt.errors?.conflict).toMatch(/referred to Risk/i);

      // 2. Saving with conflictCheckRecord.status === 'Approved' succeeds and records the restricted match ID in approvedRestrictedMatchIds
      const approvedAttempt = await runWithActiveActorSession(
        reviewerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R175 Matter With Restricted Hit',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: customReviewer.id,
              feeEstimateGbp: 5000,
              parties: [
                {
                  id: 'pty-r175-1',
                  name: 'ConfidentialStaffTarget Ltd',
                  entityType: 'organisation',
                  role: 'Opponent',
                  relationshipCode: 'OP',
                  capacityCodes: ['CAP_DEFENDANT'],
                  alignment: 'adverse',
                  linkedRecordId: null,
                },
              ],
              conflictCheckRecord: {
                status: 'Approved',
                outcomeLabel: 'Approved by Risk & Compliance',
                declarationConfirmed: true,
                reviewerMessage: 'Approved after review',
                lastRunAtDisplay: null,
                lastRunById: null,
                lastRunByName: null,
                parties: [],
                matches: [],
                runs: [],
                comments: [],
              },
            },
            { byId: customReviewer.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(approvedAttempt.errors).toBeUndefined();
      expect(approvedAttempt.matter).not.toBeNull();
      const restrictedIds = approvedAttempt.matter!.conflictCheckRecord!.matches
        .filter((m) => m.restricted)
        .map((m) => m.id);
      expect(restrictedIds.length).toBeGreaterThan(0);
      expect(
        approvedAttempt.matter!.conflictCheckRecord!.approvedRestrictedMatchIds,
      ).toEqual(restrictedIds);
    } finally {
      void originalRawBase;
      setRuntimeRbacConfigOverride(null);
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R176: saveMatterRecord builds ConflictCheckRecord on the server, preserving stored comments and runs and rejecting forged risk approvals', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const riskOfficer = store.people.find((p) =>
        (p.roles ?? []).includes('risk_compliance'),
      )!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          p.id !== riskOfficer.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const feeEarnerCookie = createSignedEntraSessionCookie({
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000176',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: feeEarner.id,
        email: feeEarner.emails[0]?.address ?? 'fe@notalawfirm.example',
        displayName: 'Fee Earner',
        entraRoles: feeEarner.roles ?? ['fee_earner'],
        mappedRoles: feeEarner.roles ?? ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const feeEarnerSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: feeEarner.roles ?? ['fee_earner'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(feeEarnerCookie)!,
      };

      // Seed a draft matter with an existing comment and server run
      const initialSave = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R176 Audit Integrity Matter',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 5000,
              parties: [],
              conflictCheckRecord: {
                status: 'In progress',
                outcomeLabel: 'Pending',
                declarationConfirmed: false,
                reviewerMessage: '',
                lastRunAtDisplay: null,
                lastRunById: null,
                lastRunByName: null,
                parties: [],
                matches: [],
                runs: [],
                comments: [
                  {
                    id: 'comment-original-1',
                    authorId: feeEarner.id,
                    authorName: 'Fee Earner',
                    authorRole: 'Solicitor',
                    atDisplay: '2026-01-01',
                    text: 'Original conflict note that must not be deleted',
                  },
                ],
              },
            },
            { byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(initialSave.errors).toBeUndefined();
      const matterId = initialSave.matter!.id;
      const originalRunId =
        initialSave.matter!.conflictCheckRecord!.runs[0]!.id;

      // Fee earner now attempts to forge status: 'Approved', approvedById: riskOfficer.id, wipe comments: [], and inject runs: [{ id: 'forged' }]
      const forgedSave = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...initialSave.matter!,
              title: 'R176 Audit Integrity Matter',
              conflictCheckRecord: {
                status: 'Approved',
                outcomeLabel: 'Approved by Risk & Compliance',
                declarationConfirmed: true,
                reviewerMessage: 'Forged approval',
                lastRunAtDisplay: null,
                lastRunById: null,
                lastRunByName: null,
                approvedById: riskOfficer.id,
                approvedByName: 'Forged Risk Officer',
                approvedAtDisplay: '2099-01-01',
                parties: [],
                matches: [],
                runs: [
                  {
                    id: 'forged',
                    runAtDisplay: '2099-01-01',
                    runById: riskOfficer.id,
                    runByName: 'Forged Risk Officer',
                    searchTerms: ['forged'],
                    partiesCount: 99,
                    matchesCount: 0,
                    potentialConflictsCount: 0,
                  },
                ],
                comments: [],
              } as never,
            },
            { id: matterId, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(forgedSave.errors).toBeUndefined();
      const storedRecord = forgedSave.matter!.conflictCheckRecord!;
      expect(storedRecord.status).not.toBe('Approved');
      expect(storedRecord.approvedById).toBeNull();
      expect(storedRecord.approvedByName).toBeNull();
      expect(
        storedRecord.comments.some((c) => c.id === 'comment-original-1'),
      ).toBe(true);
      expect(storedRecord.runs.some((r) => r.id === originalRunId)).toBe(true);
      expect(storedRecord.runs.some((r) => r.id === 'forged')).toBe(false);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R177: reconcileServerConflictMatches preserves restricted enquiry labels and resolveMatterConflictCheckRecord uses blank date fallbacks', () => {
    const reconciled = reconcileServerConflictMatches({
      serverMatches: [
        {
          id: 'match-restricted-enq-1',
          partyId: 'pty-1',
          partyName: 'Restricted Enquirer',
          matchedRecordId: '',
          matchedRecordName: 'Match on a restricted enquiry',
          matchedRecordType: 'matter',
          strength: 'Exact',
          whereFound: 'Restricted enquiry: refer to Risk',
          matterId: null,
          matterNumber: null,
          responsiblePartnerId: null,
          responsiblePartnerName: '',
          dateLabel: '',
          matchedOn: 'Restricted enquiry: refer to Risk',
          restricted: true,
          disposition: 'potential_conflict',
          note: 'Match on a restricted enquiry — must be referred to Risk & Compliance.',
        },
      ],
      canReviewConditions: false,
    });
    expect(reconciled[0]?.matchedRecordName).toBe(
      'Match on a restricted enquiry',
    );
    expect(reconciled[0]?.whereFound).toBe('Restricted enquiry: refer to Risk');
    expect(reconciled[0]?.matchedOn).toBe('Restricted enquiry: refer to Risk');

    const store = getStore();
    const baseMatter = structuredClone(store.matters[0]!);
    delete baseMatter.conflictCheckRecord;
    baseMatter.conflictCheckDate = null;
    const fallbackRecord = resolveMatterConflictCheckRecord(
      baseMatter,
      store.people,
      store.organisations,
    );
    expect(fallbackRecord.lastRunAtDisplay).toBe('');
    expect(fallbackRecord.submittedAtDisplay).toBe('');
    expect(fallbackRecord.approvedAtDisplay).toBe('');
    expect(fallbackRecord.runs[0]?.runAtDisplay).toBe('');
  });

  it('R178: draft saves of unopened matters set matterOpeningGate.allowProceed to false, and signOffMatterCostsRecord fails closed when an enabled beforeMatterOpen extension fails to load', async () => {
    resetAllDemoData('P-000001');
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const riskOfficer = store.people.find((p) =>
        (p.roles ?? []).includes('risk_compliance'),
      )!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          p.id !== riskOfficer.id &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const prospectiveStatusId = store.values.find(
        (v) =>
          v.listKey === 'matter_status' &&
          v.label === 'Prospective / Enquiry',
      )!.id;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeSession = (
        person: typeof partner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const feeEarnerSession = makeSession(
        feeEarner,
        feeEarner.roles ?? ['fee_earner'],
        'fe-r178@notalawfirm.example',
      );
      const riskSession = makeSession(
        riskOfficer,
        riskOfficer.roles ?? ['risk_compliance'],
        'risk-r178@notalawfirm.example',
      );
      const partnerSession = makeSession(
        partner,
        partner.roles ?? ['partner', 'managing_partner'],
        'partner-r178@notalawfirm.example',
      );

      // Part 1: Refer a matter (£10,000, below threshold), then save it as a draft -> matterOpeningGate.allowProceed becomes false -> Risk approval keeps matter Prospective (and verify existing Prospective fixture M-000008 behaves identically on draft save)
      const fixtureM8 = store.matters.find((m) => m.id === 'M-000008')!;
      const fixtureM8Draft = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM8,
              title: `${fixtureM8.title} (Draft)`,
            },
            { id: fixtureM8.id, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(fixtureM8Draft.errors).toBeUndefined();
      expect(
        (
          fixtureM8Draft.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(false);

      const referRes = await runWithActiveActorSession(feeEarnerSession, () =>
        saveMatterRecord(
          {
            title: 'R178 Draft Gate Reset Matter',
            clientId: baseMatter.clientId,
            practiceAreaId: baseMatter.practiceAreaId,
            workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            leadFeeEarnerId: feeEarner.id,
            feeEstimateGbp: 10000,
            agreedFeeCapGbp: 10000,
            parties: [],
          },
          { byId: feeEarner.id, saveMode: 'submit_referred' },
        ),
      );
      expect(referRes.errors).toBeUndefined();
      expect(
        (
          referRes.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(true);
      const matterId = referRes.matter!.id;

      const draftSaveAfterRefer = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referRes.matter!,
              title: 'R178 Draft Gate Reset Matter (Edited Draft)',
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
            },
            { id: matterId, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(draftSaveAfterRefer.errors).toBeUndefined();
      expect(
        (
          draftSaveAfterRefer.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(false);

      const riskApproveAfterDraft = runWithActiveActorSession(
        riskSession,
        () =>
          updateMatterConflictRecord(
            matterId,
            {
              ...draftSaveAfterRefer.matter!.conflictCheckRecord!,
              status: 'Approved',
              outcomeLabel: 'Approved by Risk & Compliance',
            },
            riskOfficer.id,
          ),
      );
      expect(riskApproveAfterDraft.errors).toBeUndefined();
      expect(riskApproveAfterDraft.matter?.matterStatusId).toBe(
        prospectiveStatusId,
      );
      expect(riskApproveAfterDraft.warnings?.length).toBeGreaterThan(0);

      // Part 2: When an enabled beforeMatterOpen extension fails to load, signOffMatterCostsRecord fails closed and does not activate the matter
      const tmpLoadFailDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'nalf-r178-load-fail-'),
      );
      const prevPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
      try {
        fs.mkdirSync(path.join(tmpLoadFailDir, 'config'), { recursive: true });
        const extSubDir = path.join(
          tmpLoadFailDir,
          'extensions',
          'missing-open-gate-r178',
        );
        fs.mkdirSync(extSubDir, { recursive: true });
        fs.writeFileSync(
          path.join(tmpLoadFailDir, 'config', 'base.json'),
          JSON.stringify({
            ...originalRawBase,
            enabledExtensions: ['missing-open-gate-r178'],
          }),
          'utf8',
        );
        fs.writeFileSync(
          path.join(extSubDir, 'manifest.json'),
          JSON.stringify({
            id: 'missing-open-gate-r178',
            name: 'Missing Open Gate R178',
            version: '1.0.0',
            description: 'Missing from generated registry to trigger load error',
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
              e.extensionId === 'missing-open-gate-r178' &&
              e.declaredHooks?.includes('beforeMatterOpen'),
          ),
        ).toBe(true);

        const signOffUnderLoadErr = await runWithActiveActorSession(
          partnerSession,
          () =>
            signOffMatterCostsRecord(
              matterId,
              partner.id,
              'Attempt sign-off while beforeMatterOpen extension failed to load',
            ),
        );
        expect(signOffUnderLoadErr.errors).toBeUndefined();
        expect(signOffUnderLoadErr.matter?.matterStatusId).toBe(
          prospectiveStatusId,
        );
        expect(
          (
            signOffUnderLoadErr.matter?.fieldValues['matterOpeningGate'] as {
              allowProceed?: boolean;
            }
          )?.allowProceed,
        ).toBe(false);
        expect(signOffUnderLoadErr.warnings?.[0]).toBe(
          "A required opening check couldn't run. Please contact your administrator.",
        );
      } finally {
        if (prevPkgDir === undefined) {
          delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
        } else {
          process.env.PLATFORM_TENANT_PACKAGE_DIR = prevPkgDir;
        }
        setActiveTenantConfigForTesting(null);
        fs.rmSync(tmpLoadFailDir, { recursive: true, force: true });
      }
    } finally {
      setActiveTenantConfigForTesting(null);
      resetAllDemoData('P-000001');
    }
  });

  it('R179: saveMatterRecord, updateMatterConflictRecord, and signOffMatterCostsRecord enforce evaluateMatterKeyDateOpeningGate when requiredKeyDateTypeIds are configured', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const riskOfficer = store.people.find((p) =>
        (p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const prospectiveStatusId = store.values.find(
        (v) =>
          v.listKey === 'matter_status' &&
          v.label === 'Prospective / Enquiry',
      )!.id;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeSession = (
        person: typeof partner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const partnerSession = makeSession(
        partner,
        partner.roles ?? ['partner', 'managing_partner', 'admin'],
        'partner-r179@notalawfirm.example',
      );
      const riskSession = makeSession(
        riskOfficer,
        riskOfficer.roles ?? ['risk_compliance'],
        'risk-r179@notalawfirm.example',
      );

      // 1. Brand-new matter (and existing Prospective fixture M-000008) whose matterTypeId requires 'limitation' is refused on submit_cleared without the required key date
      const fixtureM8 = store.matters.find((m) => m.id === 'M-000008')!;
      const fixtureM8OpenWithoutKd = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM8,
              matterTypeId: 'matter_type.litigation',
            },
            { id: fixtureM8.id, byId: partner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(fixtureM8OpenWithoutKd.matter).toBeNull();
      expect(fixtureM8OpenWithoutKd.errors?.keyDates).toMatch(
        /Matter cannot open until required key date\(s\) are recorded or marked not applicable.*Limitation date/i,
      );

      const newOpenWithoutKd = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R179 Litigation Matter Requiring Limitation Date',
              clientId: baseMatter.clientId,
              practiceAreaId: 'work_type.dispute_resolution',
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              matterTypeId: 'matter_type.litigation',
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: partner.id,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              parties: [],
            },
            { byId: partner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(newOpenWithoutKd.matter).toBeNull();
      expect(newOpenWithoutKd.errors?.keyDates).toMatch(
        /Save the matter as a draft and add its required key dates before opening/i,
      );

      // 2. Saving as a draft succeeds; attempting to open the saved draft without the required key date is refused with errors.keyDates
      const draftRes = await runWithActiveActorSession(partnerSession, () =>
        saveMatterRecord(
          {
            title: 'R179 Litigation Matter Requiring Limitation Date',
            clientId: baseMatter.clientId,
            practiceAreaId: 'work_type.dispute_resolution',
            workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
            matterTypeId: 'matter_type.litigation',
            responsiblePartnerId: partner.id,
            supervisingPartnerId: partner.id,
            leadFeeEarnerId: partner.id,
            feeEstimateGbp: 10000,
            agreedFeeCapGbp: 10000,
            parties: [],
          },
          { byId: partner.id, saveMode: 'draft' },
        ),
      );
      expect(draftRes.errors).toBeUndefined();
      const draftId = draftRes.matter!.id;

      const draftOpenWithoutKd = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              ...draftRes.matter!,
              title: 'R179 Litigation Matter Requiring Limitation Date',
            },
            { id: draftId, byId: partner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(draftOpenWithoutKd.matter).toBeNull();
      expect(draftOpenWithoutKd.errors?.keyDates).toMatch(
        /Matter cannot open until required key date\(s\) are recorded or marked not applicable.*Limitation date/i,
      );

      // 3. Risk approval on a draft/referred matter missing its required key date keeps matterStatusId as Prospective
      const riskApproveWithoutKd = runWithActiveActorSession(riskSession, () =>
        updateMatterConflictRecord(
          draftId,
          {
            ...draftRes.matter!.conflictCheckRecord!,
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
          },
          riskOfficer.id,
        ),
      );
      expect(riskApproveWithoutKd.errors).toBeUndefined();
      expect(riskApproveWithoutKd.matter?.matterStatusId).toBe(
        prospectiveStatusId,
      );
      expect(riskApproveWithoutKd.warnings?.[0]).toMatch(/required key dates/i);

      // 4. Recording the required key date as Not applicable (or adding it) allows saveMatterRecord(submit_cleared) to open the matter
      const naRes = recordKeyDateNotApplicableRecord(
        {
          matterId: draftId,
          keyDateTypeId: 'limitation',
          reason:
            'Declaratory relief only; statutory limitation period does not apply.',
        },
        partner.id,
      );
      expect(naRes.ok).toBe(true);
      expect(naRes.error).toBeUndefined();

      const openWithKdRes = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              ...draftRes.matter!,
              title: 'R179 Litigation Matter Requiring Limitation Date',
            },
            { id: draftId, byId: partner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(openWithKdRes.errors).toBeUndefined();
      expect(openWithKdRes.matter).not.toBeNull();
      expect(openWithKdRes.matter?.matterStatusId).not.toBe(
        prospectiveStatusId,
      );
      expect(openWithKdRes.matter?.matterNumber).not.toBe('DRAFT');
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R181: saveMatterRecord enforces conflict-decision and opening gate on status transition out of Prospective, allows stage edits while Prospective, and saveMatterAction filters opts', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          (p.roles ?? []).includes('fee_earner') &&
          !(p.roles ?? []).includes('partner') &&
          !(p.roles ?? []).includes('managing_partner') &&
          !(p.roles ?? []).includes('admin') &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const baseEnquiry = store.enquiries[0]!;
      const prospectiveStatusId = store.values.find(
        (v) =>
          v.listKey === 'matter_status' &&
          v.label === 'Prospective / Enquiry',
      )!.id;
      const activeStatusId = store.values.find(
        (v) => v.listKey === 'matter_status' && v.label === 'Active',
      )!.id;
      const alternateStageId =
        store.values.find(
          (v) =>
            v.listKey === 'matter_stage' && v.id !== baseMatter.stageId,
        )?.id ?? 'matter_stage.stage_2_investigation_and_preparation';

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeSession = (
        person: typeof partner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const feeEarnerSession = makeSession(
        feeEarner,
        feeEarner.roles ?? ['fee_earner'],
        'fee-earner-r181@notalawfirm.example',
      );
      const partnerSession = makeSession(
        partner,
        partner.roles ?? ['partner', 'managing_partner', 'admin'],
        'partner-r181@notalawfirm.example',
      );

      // Seed a restricted enquiry invisible to feeEarner so the party produces a restricted conflict match
      store.enquiries.push({
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R181-RESTRICTED',
        reference: 'ENQ-R181-RESTRICTED',
        status: 'Draft',
        firstName: 'Restricted',
        lastName: 'CounterpartyR181',
        summary: 'Private draft enquiry belonging to partner',
        convertedMatterId: null,
        createdById: partner.id,
        takenById: partner.id,
      });

      // 1. Refer a matter with a restricted match, then attempt to open it by setting matterStatusId: Active with no saveMode
      const referredRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R181 Referred Restricted Match Matter',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              parties: [
                {
                  id: 'pty-r181-1',
                  name: 'Restricted CounterpartyR181',
                  role: 'Opponent',
                  entityType: 'person',
                  linkedRecordId: null,
                },
              ],
            },
            { byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(referredRes.errors).toBeUndefined();
      expect(referredRes.matter?.matterStatusId).toBe(prospectiveStatusId);
      expect(referredRes.matter?.conflictCheckRecord?.status).toBe('Referred');
      const referredId = referredRes.matter!.id;

      const bypassOpenRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referredRes.matter!,
              matterStatusId: activeStatusId,
            },
            { id: referredId, byId: feeEarner.id },
          ),
      );
      expect(bypassOpenRes.matter).toBeNull();
      expect(bypassOpenRes.errors?.conflict).toMatch(
        /cannot open until its conflict check is cleared or approved by Risk/i,
      );
      expect(
        getStore().matters.find((m) => m.id === referredId)?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 2. Edit while waiting for Risk: a referred matter above the £50,000 sign-off threshold with no sign-off allows a stage change (no saveMode) while keeping the matter Prospective and matterOpeningGate.allowProceed === false
      const highEstimateDraftRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referredRes.matter!,
              feeEstimateGbp: 75000,
              agreedFeeCapGbp: 75000,
            },
            { id: referredId, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(highEstimateDraftRes.errors).toBeUndefined();

      const stageChangeRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...highEstimateDraftRes.matter!,
              stageId: alternateStageId,
            },
            { id: referredId, byId: feeEarner.id },
          ),
      );
      expect(stageChangeRes.errors).toBeUndefined();
      expect(stageChangeRes.matter).not.toBeNull();
      expect(stageChangeRes.matter?.matterStatusId).toBe(prospectiveStatusId);
      expect(stageChangeRes.matter?.stageId).toBe(alternateStageId);
      expect(
        (
          stageChangeRes.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(false);

      // Also verify stage edit on existing Prospective fixture M-000006 (with £75,000 estimate, no saveMode) succeeds and keeps M-000006 Prospective with allowProceed: false
      const fixtureM6 = store.matters.find((m) => m.id === 'M-000006')!;
      const fixtureM6StageRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM6,
              feeEstimateGbp: 75000,
              agreedFeeCapGbp: 75000,
              stageId: alternateStageId,
            },
            { id: fixtureM6.id, byId: feeEarner.id },
          ),
      );
      expect(fixtureM6StageRes.errors).toBeUndefined();
      expect(fixtureM6StageRes.matter?.matterStatusId).toBe(
        prospectiveStatusId,
      );
      expect(fixtureM6StageRes.matter?.stageId).toBe(alternateStageId);
      expect(
        (
          fixtureM6StageRes.matter?.fieldValues['matterOpeningGate'] as {
            allowProceed?: boolean;
          }
        )?.allowProceed,
      ).toBe(false);

      // 3. saveMatterAction filters opts so unknown/internal options (such as source: 'pms_import') cannot be passed from the client
      setTestEntraSessionOverride(feeEarnerSession.verifiedSession);
      const actionAttemptRes = await saveMatterAction(
        {
          ...stageChangeRes.matter!,
          matterStatusId: activeStatusId,
        },
        {
          id: referredId,
          source: 'pms_import',
          unknownOption: 'dropped',
        } as unknown as {
          id?: string;
          saveMode?: 'draft' | 'submit_cleared' | 'submit_referred';
        },
      );
      setTestEntraSessionOverride(undefined);
      expect(actionAttemptRes.matter).toBeNull();
      expect(actionAttemptRes.errors?.conflict).toMatch(
        /cannot open until its conflict check is cleared or approved by Risk/i,
      );

      // 4. Server-only PMS import (opts.source === 'pms_import') opens the imported matter and writes a 'matter-imported-open' audit entry
      const pmsImportRes = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              matterNumber: 'PMS-R181-0001',
              title: 'R181 Imported PMS Matter',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              matterStatusId: activeStatusId,
              responsiblePartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
            },
            { byId: partner.id, source: 'pms_import' },
          ),
      );
      expect(pmsImportRes.errors).toBeUndefined();
      expect(pmsImportRes.matter?.matterStatusId).toBe(activeStatusId);
      expect(
        getStore().audit.some(
          (a) =>
            a.recordId === pmsImportRes.matter?.id &&
            a.action === 'matter-imported-open',
        ),
      ).toBe(true);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R183: existing open matters without an opening snapshot can be edited and closed without triggering the opening gate, and backfill matterOpeningSnapshot with saveMode backfilled', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const activeStatusId = store.values.find(
        (v) => v.listKey === 'matter_status' && v.label === 'Active',
      )!.id;
      const closedStatusId = store.values.find(
        (v) => v.listKey === 'matter_status' && v.label === 'Closed',
      )!.id;
      const fixtureM3 = store.matters.find((m) => m.id === 'M-000003')!;
      const fixtureM1 = store.matters.find((m) => m.id === 'M-000001')!;
      expect(fixtureM3.matterStatusId).toBe(activeStatusId);
      expect(fixtureM3.feeEstimateGbp).toBe(145000);
      expect(
        fixtureM3.fieldValues?.['matterOpeningSnapshot'],
      ).toBeUndefined();

      const alternateStageId =
        store.values.find(
          (v) =>
            v.listKey === 'matter_stage' && v.id !== fixtureM3.stageId,
        )?.id ?? 'matter_stage.stage_2_investigation_and_preparation';

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const cookie = createSignedEntraSessionCookie({
        personId: partner.id,
        tenantId: 'not-a-law-firm',
        oid: partner.entraObjectId ?? `00000000-0000-4000-8000-${partner.id}`,
        tid: '11111111-2222-3333-4444-000000000000',
        sub: partner.id,
        email: 'partner-r183@notalawfirm.example',
        displayName: `${partner.firstName} ${partner.surname}`,
        entraRoles: partner.roles ?? ['partner', 'managing_partner', 'admin'],
        mappedRoles: partner.roles ?? ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const partnerSession = {
        personId: partner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: partner.roles ?? ['partner', 'managing_partner', 'admin'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(cookie)!,
      };

      // 1. Stage change on M-000003 (£145,000, Active, no opening snapshot) and M-000001 (£8,500) with no saveMode succeeds and writes a backfilled snapshot
      const m3StageRes = await runWithActiveActorSession(partnerSession, () =>
        saveMatterRecord(
          {
            ...fixtureM3,
            stageId: alternateStageId,
          },
          { id: fixtureM3.id, byId: partner.id },
        ),
      );
      expect(m3StageRes.errors).toBeUndefined();
      expect(m3StageRes.matter?.matterStatusId).toBe(activeStatusId);
      expect(m3StageRes.matter?.stageId).toBe(alternateStageId);
      const backfilledSnap = m3StageRes.matter?.fieldValues?.[
        'matterOpeningSnapshot'
      ] as {
        saveMode?: string;
        capturedAt?: string;
        captureNote?: string;
      };
      expect(backfilledSnap).toBeDefined();
      expect(backfilledSnap.saveMode).toBe('backfilled');
      expect(backfilledSnap.capturedAt).not.toBe(fixtureM3.openedAt);
      expect(backfilledSnap.captureNote).toMatch(/Recorded after opening/i);

      const m1StageRes = await runWithActiveActorSession(partnerSession, () =>
        saveMatterRecord(
          {
            ...fixtureM1,
            stageId: alternateStageId,
          },
          { id: fixtureM1.id, byId: partner.id },
        ),
      );
      expect(m1StageRes.errors).toBeUndefined();
      expect(m1StageRes.matter?.matterStatusId).toBe(activeStatusId);

      // 2. Closing M-000003 follows only the key dates closure check (not the £145,000 opening gate)
      const kdRes = await createOrProposeKeyDateRecord(
        {
          matterId: fixtureM3.id,
          keyDateTypeId: 'limitation',
          title: 'R183 Open Key Date Blocking Closure',
          dueDate: '2027-06-01',
          source: 'manual',
          responsiblePersonIds: [partner.id],
          teamId: 'TM-000001',
        },
        partner.id,
      );
      expect(kdRes.ok).toBe(true);

      const closeBlockedByKd = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              ...m3StageRes.matter!,
              matterStatusId: closedStatusId,
            },
            { id: fixtureM3.id, byId: partner.id },
          ),
      );
      expect(closeBlockedByKd.matter).toBeNull();
      expect(closeBlockedByKd.errors?.keyDates).toMatch(
        /Cannot close matter while \d+ key date\(s\) remain open/i,
      );
      expect(closeBlockedByKd.errors?.costsGovernance).toBeUndefined();

      // Remove the open key date and verify M-000003 closes cleanly despite £145,000 fee estimate without partner sign-off
      getStore().keyDates = (getStore().keyDates ?? []).filter(
        (kd) => kd.matterId !== fixtureM3.id,
      );
      const closeSuccessRes = await runWithActiveActorSession(
        partnerSession,
        () =>
          saveMatterRecord(
            {
              ...m3StageRes.matter!,
              matterStatusId: closedStatusId,
            },
            { id: fixtureM3.id, byId: partner.id },
          ),
      );
      expect(closeSuccessRes.errors).toBeUndefined();
      expect(closeSuccessRes.matter?.matterStatusId).toBe(closedStatusId);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R184: legacy escalated conflict status maps to Referred with no fabricated approver, and once referred only Risk & Compliance can clear or approve a matter', async () => {
    resetAllDemoData('P-000001');
    try {
      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const riskOfficer = store.people.find((p) =>
        (p.roles ?? []).includes('risk_compliance'),
      )!;
      const prospectiveStatusId = store.values.find(
        (v) =>
          v.listKey === 'matter_status' &&
          v.label === 'Prospective / Enquiry',
      )!.id;
      const activeStatusId = store.values.find(
        (v) => v.listKey === 'matter_status' && v.label === 'Active',
      )!.id;
      const fixtureM6 = store.matters.find((m) => m.id === 'M-000006')!;
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeSession = (
        person: typeof partner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const feeEarnerSession = makeSession(
        feeEarner,
        feeEarner.roles ?? ['fee_earner'],
        'fe-r184@notalawfirm.example',
      );
      const riskSession = makeSession(
        riskOfficer,
        riskOfficer.roles ?? ['risk_compliance'],
        'risk-r184@notalawfirm.example',
      );

      // 1. resolveMatterConflictCheckRecord for M-000006 ('Potential conflict — escalated') returns status: 'Referred' and null approvedById
      const resolvedM6Record = resolveMatterConflictCheckRecord(
        fixtureM6,
        store.people,
        store.organisations,
      );
      expect(resolvedM6Record.status).toBe('Referred');
      expect(resolvedM6Record.outcomeLabel).toBe('Referred to risk for review');
      expect(resolvedM6Record.approvedById).toBeNull();
      expect(resolvedM6Record.approvedByName).toBeNull();
      expect(resolvedM6Record.approvedAtDisplay).toBeNull();

      // 2. Saving M-000006 as feeEarner P-000002 with no saveMode, matterStatusId: Active, and estimate lowered to £10,000 is refused with errors.conflict and M-000006 stays Prospective
      const m6OpenAttempt = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM6,
              matterStatusId: activeStatusId,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
            },
            { id: fixtureM6.id, byId: feeEarner.id },
          ),
      );
      expect(m6OpenAttempt.matter).toBeNull();
      expect(m6OpenAttempt.errors?.conflict).toMatch(
        /cannot open until its conflict check is cleared or approved by Risk/i,
      );
      expect(
        getStore().matters.find((m) => m.id === fixtureM6.id)?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 3. Refer a new matter as feeEarner, then attempt submit_cleared with status: 'Cleared' as feeEarner -> refused with errors.conflict and stays Referred & Prospective
      const referNewRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R184 Referred Matter Cannot Self-Clear',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              parties: [],
            },
            { byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(referNewRes.errors).toBeUndefined();
      expect(referNewRes.matter?.conflictCheckRecord?.status).toBe('Referred');
      expect(referNewRes.matter?.matterStatusId).toBe(prospectiveStatusId);
      const referredMatterId = referNewRes.matter!.id;

      const feeEarnerSelfClearRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referNewRes.matter!,
              conflictCheckRecord: {
                ...referNewRes.matter!.conflictCheckRecord!,
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
              },
            },
            {
              id: referredMatterId,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(feeEarnerSelfClearRes.matter).toBeNull();
      expect(feeEarnerSelfClearRes.errors?.conflict).toMatch(
        /referred to Risk.*Only Risk & Compliance can clear or approve/i,
      );
      const storedAfterSelfClear = getStore().matters.find(
        (m) => m.id === referredMatterId,
      )!;
      expect(storedAfterSelfClear.conflictCheckRecord?.status).toBe('Referred');
      expect(storedAfterSelfClear.matterStatusId).toBe(prospectiveStatusId);

      // Also verify updateMatterConflictRecord refuses status: 'Cleared' by a non-Risk caller on a referred matter
      const updateSelfClearRes = runWithActiveActorSession(
        feeEarnerSession,
        () =>
          updateMatterConflictRecord(
            referredMatterId,
            {
              ...storedAfterSelfClear.conflictCheckRecord!,
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
            },
            feeEarner.id,
          ),
      );
      expect(updateSelfClearRes.matter).toBeNull();
      expect(updateSelfClearRes.errors?.conflict).toMatch(
        /referred to Risk.*Only Risk & Compliance can clear or approve/i,
      );

      // 4. After a Risk user records Approved, the fee earner's submit_cleared succeeds
      const riskApproveRes = runWithActiveActorSession(riskSession, () =>
        updateMatterConflictRecord(
          referredMatterId,
          {
            ...storedAfterSelfClear.conflictCheckRecord!,
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
          },
          riskOfficer.id,
        ),
      );
      expect(riskApproveRes.errors).toBeUndefined();
      expect(riskApproveRes.matter?.conflictCheckRecord?.status).toBe(
        'Approved',
      );

      const postApprovalSubmitRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...riskApproveRes.matter!,
              conflictCheckRecord: {
                ...riskApproveRes.matter!.conflictCheckRecord!,
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
              },
            },
            {
              id: referredMatterId,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(postApprovalSubmitRes.errors).toBeUndefined();
      expect(postApprovalSubmitRes.matter).not.toBeNull();
      expect(postApprovalSubmitRes.matter?.matterStatusId).not.toBe(
        prospectiveStatusId,
      );
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R185: saveMatterRecord ignores conflictCheckRecord: null and caller conflictCheckStatus, preserves Referred status across two-save bypass attempts, and derives conflictCheckStatus from the server record', async () => {
    resetAllDemoData('P-000001');
    try {
      // Round-trip check: conflictStatusPillFromLegacy(legacyConflictStatusFromRecord(r)) returns r.status for every status
      const roundTripCases = [
        { status: 'Cleared' as const, outcomeLabel: 'Cleared by fee earner' as const },
        {
          status: 'Approved' as const,
          outcomeLabel: 'Approved by Risk & Compliance' as const,
        },
        {
          status: 'Approved' as const,
          outcomeLabel: 'Approved with conditions' as const,
        },
        {
          status: 'Declined' as const,
          outcomeLabel: 'Declined by Risk & Compliance' as const,
        },
        {
          status: 'Referred' as const,
          outcomeLabel: 'Referred to risk for review' as const,
        },
        { status: 'In progress' as const, outcomeLabel: 'Pending' as const },
        { status: 'Not started' as const, outcomeLabel: 'Pending' as const },
      ];
      for (const c of roundTripCases) {
        expect(
          conflictStatusPillFromLegacy(legacyConflictStatusFromRecord(c)),
        ).toBe(c.status);
      }

      const store = getStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const riskOfficer = store.people.find(
        (p) => p.isEmployee && (p.roles ?? []).includes('risk_compliance'),
      )!;
      const prospectiveStatusId = store.values.find(
        (v) =>
          v.listKey === 'matter_status' &&
          v.label === 'Prospective / Enquiry',
      )!.id;
      const activeStatusId = store.values.find(
        (v) => v.listKey === 'matter_status' && v.label === 'Active',
      )!.id;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const makeSession = (
        person: typeof partner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
          tid: '11111111-2222-3333-4444-000000000000',
          sub: person.id,
          email,
          displayName: `${person.firstName} ${person.surname}`,
          entraRoles: roles,
          mappedRoles: roles,
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        });
        return {
          personId: person.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: roles,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const feeEarnerSession = makeSession(
        feeEarner,
        feeEarner.roles ?? ['fee_earner'],
        'fee-earner-r185@notalawfirm.example',
      );
      const riskSession = makeSession(
        riskOfficer,
        riskOfficer.roles ?? ['risk_compliance'],
        'risk-r185@notalawfirm.example',
      );

      // 1. Legacy matter M-000006: Save 1 with no saveMode, conflictCheckRecord: null, and conflictCheckStatus: 'Clear' keeps stored record Referred and conflictCheckStatus as 'Pending conflict review'; Save 2 (submit_cleared) is refused with errors.conflict
      const fixtureM6 = store.matters.find((m) => m.id === 'M-000006')!;
      expect(fixtureM6.conflictCheckRecord).toBeFalsy();
      expect(fixtureM6.conflictCheckStatus).toBe(
        'Potential conflict — escalated',
      );

      const m6Save1Res = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...fixtureM6,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              conflictCheckStatus: 'Clear',
              conflictCheckRecord: null,
            } as unknown as Parameters<typeof saveMatterRecord>[0],
            { id: fixtureM6.id, byId: feeEarner.id },
          ),
      );
      expect(m6Save1Res.errors).toBeUndefined();
      expect(m6Save1Res.matter?.conflictCheckRecord?.status).toBe('Referred');
      expect(m6Save1Res.matter?.conflictCheckStatus).toBe(
        'Pending conflict review',
      );
      expect(m6Save1Res.matter?.matterStatusId).toBe(prospectiveStatusId);

      const m6Save2Res = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...m6Save1Res.matter!,
            },
            {
              id: fixtureM6.id,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(m6Save2Res.matter).toBeNull();
      expect(m6Save2Res.errors?.conflict).toMatch(
        /referred to Risk.*Only Risk & Compliance can clear or approve/i,
      );
      expect(
        getStore().matters.find((m) => m.id === fixtureM6.id)
          ?.conflictCheckRecord?.status,
      ).toBe('Referred');

      // 2. Newly referred matter: two-save bypass attempt (conflictCheckRecord: null + conflictCheckStatus: 'Clear', then submit_cleared) is refused
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const referNewRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R185 Newly Referred Matter',
              clientId: baseMatter.clientId,
              practiceAreaId: baseMatter.practiceAreaId,
              workTypeSubcategoryId: baseMatter.workTypeSubcategoryId,
              responsiblePartnerId: partner.id,
              supervisingPartnerId: partner.id,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 10000,
              agreedFeeCapGbp: 10000,
              parties: [],
            },
            { byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(referNewRes.errors).toBeUndefined();
      const referredId = referNewRes.matter!.id;
      expect(referNewRes.matter?.conflictCheckRecord?.status).toBe('Referred');
      expect(referNewRes.matter?.conflictCheckStatus).toBe(
        'Pending conflict review',
      );

      const newRefSave1 = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referNewRes.matter!,
              conflictCheckStatus: 'Clear',
              conflictCheckRecord: null,
            } as unknown as Parameters<typeof saveMatterRecord>[0],
            { id: referredId, byId: feeEarner.id },
          ),
      );
      expect(newRefSave1.errors).toBeUndefined();
      expect(newRefSave1.matter?.conflictCheckRecord?.status).toBe('Referred');
      expect(newRefSave1.matter?.conflictCheckStatus).toBe(
        'Pending conflict review',
      );

      const newRefSave2 = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...newRefSave1.matter!,
            },
            {
              id: referredId,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(newRefSave2.matter).toBeNull();
      expect(newRefSave2.errors?.conflict).toMatch(
        /referred to Risk.*Only Risk & Compliance can clear or approve/i,
      );

      // 3. Forged Risk approval: saving with conflictCheckStatus: 'Approved with conditions' and conflictCheckRecord: null keeps the stored record as Referred, and a later plain save with matterStatusId: Active is refused
      const forgedApprovalSave1 = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...newRefSave1.matter!,
              conflictCheckStatus: 'Approved with conditions',
              conflictCheckRecord: null,
            } as unknown as Parameters<typeof saveMatterRecord>[0],
            { id: referredId, byId: feeEarner.id },
          ),
      );
      expect(forgedApprovalSave1.errors).toBeUndefined();
      expect(forgedApprovalSave1.matter?.conflictCheckRecord?.status).toBe(
        'Referred',
      );
      expect(
        forgedApprovalSave1.matter?.conflictCheckRecord?.outcomeLabel,
      ).toBe('Referred to risk for review');
      expect(forgedApprovalSave1.matter?.conflictCheckStatus).toBe(
        'Pending conflict review',
      );

      const forgedApprovalSave2 = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...forgedApprovalSave1.matter!,
              matterStatusId: activeStatusId,
            },
            { id: referredId, byId: feeEarner.id },
          ),
      );
      expect(forgedApprovalSave2.matter).toBeNull();
      expect(forgedApprovalSave2.errors?.conflict).toMatch(
        /cannot open until its conflict check is cleared or approved by Risk/i,
      );
      expect(
        getStore().matters.find((m) => m.id === referredId)?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 4. After a Risk user records Approved through updateMatterConflictRecord, matter.conflictCheckStatus is set to match, and the fee earner can then open the matter
      const riskApproveWithConditions = runWithActiveActorSession(
        riskSession,
        () =>
          updateMatterConflictRecord(
            fixtureM6.id,
            {
              ...m6Save1Res.matter!.conflictCheckRecord!,
              status: 'Approved',
              outcomeLabel: 'Approved with conditions',
            },
            riskOfficer.id,
          ),
      );
      expect(riskApproveWithConditions.errors).toBeUndefined();
      expect(
        riskApproveWithConditions.matter?.conflictCheckRecord?.status,
      ).toBe('Approved');
      expect(riskApproveWithConditions.matter?.conflictCheckStatus).toBe(
        'Approved with conditions',
      );

      const feeEarnerOpenM6Res = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...riskApproveWithConditions.matter!,
            },
            {
              id: fixtureM6.id,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(feeEarnerOpenM6Res.errors).toBeUndefined();
      expect(feeEarnerOpenM6Res.matter).not.toBeNull();
      expect(feeEarnerOpenM6Res.matter?.matterStatusId).not.toBe(
        prospectiveStatusId,
      );
      expect(
        feeEarnerOpenM6Res.matter?.conflictCheckRecord?.status,
      ).toBe('Approved');
      expect(feeEarnerOpenM6Res.matter?.conflictCheckStatus).toBe(
        'Approved with conditions',
      );
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R186: an open matter cannot be moved back to Prospective or saved as a draft, and submit_referred + Risk approval preserve open status and matterOpeningSnapshot', async () => {
    resetAllDemoData('P-000001');
    const store = getStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
    const riskOfficer = store.people.find(
      (p) => p.isEmployee && (p.roles ?? []).includes('risk_compliance'),
    )!;
    expect(feeEarner).toBeDefined();
    expect(riskOfficer).toBeDefined();

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const makeSession = (
      person: typeof feeEarner,
      roles: string[],
      email: string,
    ) => {
      const cookie = createSignedEntraSessionCookie({
        personId: person.id,
        tenantId: 'not-a-law-firm',
        oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id}`,
        tid: '11111111-2222-3333-4444-000000000000',
        sub: person.id,
        email,
        displayName: `${person.firstName} ${person.surname}`,
        entraRoles: roles,
        mappedRoles: roles,
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      return {
        personId: person.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: roles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(cookie)!,
      };
    };

    const feeEarnerSession = makeSession(
      feeEarner,
      feeEarner.roles ?? ['fee_earner'],
      'fee-earner-r186@notalawfirm.example',
    );
    const riskSession = makeSession(
      riskOfficer,
      riskOfficer.roles ?? ['risk_compliance'],
      'risk-r186@notalawfirm.example',
    );

    const activeStatusId = store.values.find(
      (v) => v.listKey === 'matter_status' && v.label === 'Active',
    )!.id;
    const prospectiveStatusId = store.values.find(
      (v) =>
        v.listKey === 'matter_status' && v.label === 'Prospective / Enquiry',
    )!.id;

    try {
      // 1. Existing open matters M-000003 and M-000001 straight from the fixture
      for (const openMatterId of ['M-000003', 'M-000001'] as const) {
        const fixtureOpen = structuredClone(
          getStore().matters.find((m) => m.id === openMatterId)!,
        );
        expect(fixtureOpen).toBeDefined();
        expect(fixtureOpen.matterStatusId).toBe(activeStatusId);
        const originalMatterNumber = fixtureOpen.matterNumber;

        // (a) draft save on an open matter is refused and leaves the matter Active
        const draftSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              { ...fixtureOpen },
              {
                id: openMatterId,
                byId: feeEarner.id,
                saveMode: 'draft',
              },
            ),
        );
        expect(draftSaveRes.matter).toBeNull();
        expect(draftSaveRes.errors?.form).toMatch(
          /opened, so it can no longer be saved as a draft/i,
        );
        const afterDraftAttempt = getStore().matters.find(
          (m) => m.id === openMatterId,
        )!;
        expect(afterDraftAttempt.matterStatusId).toBe(activeStatusId);
        expect(afterDraftAttempt.matterNumber).toBe(originalMatterNumber);

        // (b) plain save with matterStatusId set to Prospective is refused and leaves the matter Active
        const prospectiveSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              {
                ...fixtureOpen,
                matterStatusId: prospectiveStatusId,
              },
              {
                id: openMatterId,
                byId: feeEarner.id,
              },
            ),
        );
        expect(prospectiveSaveRes.matter).toBeNull();
        expect(prospectiveSaveRes.errors?.matterStatusId).toMatch(
          /open matter cannot be moved back to Prospective/i,
        );
        const afterProspectiveAttempt = getStore().matters.find(
          (m) => m.id === openMatterId,
        )!;
        expect(afterProspectiveAttempt.matterStatusId).toBe(activeStatusId);
        expect(afterProspectiveAttempt.matterNumber).toBe(originalMatterNumber);

        // (c) submit_referred save on an open matter succeeds, records Referred, and keeps the matter Active
        const referSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              { ...fixtureOpen },
              {
                id: openMatterId,
                byId: feeEarner.id,
                saveMode: 'submit_referred',
              },
            ),
        );
        expect(referSaveRes.errors).toBeUndefined();
        expect(referSaveRes.matter).not.toBeNull();
        expect(referSaveRes.matter?.matterStatusId).toBe(activeStatusId);
        expect(referSaveRes.matter?.matterNumber).toBe(originalMatterNumber);
        expect(referSaveRes.matter?.conflictCheckRecord?.status).toBe(
          'Referred',
        );
        expect(referSaveRes.matter?.conflictCheckStatus).toBe(
          'Pending conflict review',
        );

        const snapshotBeforeRiskApproval = structuredClone(
          referSaveRes.matter?.fieldValues?.['matterOpeningSnapshot'],
        );
        expect(snapshotBeforeRiskApproval).toBeDefined();

        // (d) Risk user approves through updateMatterConflictRecord; matter stays Active and matterOpeningSnapshot is unchanged
        const riskApproveRes = runWithActiveActorSession(riskSession, () =>
          updateMatterConflictRecord(
            openMatterId,
            {
              ...referSaveRes.matter!.conflictCheckRecord!,
              status: 'Approved',
              outcomeLabel: 'Approved by Risk & Compliance',
            },
            riskOfficer.id,
          ),
        );
        expect(riskApproveRes.errors).toBeUndefined();
        expect(riskApproveRes.matter).not.toBeNull();
        expect(riskApproveRes.matter?.matterStatusId).toBe(activeStatusId);
        expect(riskApproveRes.matter?.conflictCheckRecord?.status).toBe(
          'Approved',
        );
        expect(riskApproveRes.matter?.conflictCheckStatus).toBe(
          'Approved by Risk & Compliance',
        );
        expect(
          riskApproveRes.matter?.fieldValues?.['matterOpeningSnapshot'],
        ).toEqual(snapshotBeforeRiskApproval);
      }

      // 2. Newly created and opened matter also refuses draft and Prospective saves and preserves status/snapshot on referral + Risk approval
      const templateOpen = getStore().matters.find(
        (m) => m.id === 'M-000001',
      )!;
      const newOpenedRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R186 Newly Opened Matter',
              clientId: templateOpen.clientId,
              practiceAreaId: templateOpen.practiceAreaId,
              workTypeSubcategoryId: templateOpen.workTypeSubcategoryId,
              responsiblePartnerId: templateOpen.responsiblePartnerId,
              supervisingPartnerId: templateOpen.supervisingPartnerId,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 5000,
              matterStatusId: activeStatusId,
            },
            {
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(newOpenedRes.errors).toBeUndefined();
      expect(newOpenedRes.matter).not.toBeNull();
      const newOpenId = newOpenedRes.matter!.id;
      const initialOpenedSnapshot = structuredClone(
        newOpenedRes.matter!.fieldValues?.['matterOpeningSnapshot'],
      );
      expect(initialOpenedSnapshot).toBeDefined();

      const newDraftAttempt = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            { ...newOpenedRes.matter! },
            { id: newOpenId, byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(newDraftAttempt.matter).toBeNull();
      expect(newDraftAttempt.errors?.form).toMatch(
        /opened, so it can no longer be saved as a draft/i,
      );

      const newProspectiveAttempt = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...newOpenedRes.matter!,
              matterStatusId: prospectiveStatusId,
            },
            { id: newOpenId, byId: feeEarner.id },
          ),
      );
      expect(newProspectiveAttempt.matter).toBeNull();
      expect(newProspectiveAttempt.errors?.matterStatusId).toMatch(
        /open matter cannot be moved back to Prospective/i,
      );

      const newReferRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            { ...newOpenedRes.matter! },
            { id: newOpenId, byId: feeEarner.id, saveMode: 'submit_referred' },
          ),
      );
      expect(newReferRes.errors).toBeUndefined();
      expect(newReferRes.matter?.matterStatusId).not.toBe(prospectiveStatusId);
      expect(newReferRes.matter?.conflictCheckRecord?.status).toBe('Referred');
      expect(
        newReferRes.matter?.fieldValues?.['matterOpeningSnapshot'],
      ).toEqual(initialOpenedSnapshot);

      const newRiskApproveRes = runWithActiveActorSession(riskSession, () =>
        updateMatterConflictRecord(
          newOpenId,
          {
            ...newReferRes.matter!.conflictCheckRecord!,
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
          },
          riskOfficer.id,
        ),
      );
      expect(newRiskApproveRes.errors).toBeUndefined();
      expect(newRiskApproveRes.matter?.conflictCheckRecord?.status).toBe(
        'Approved',
      );
      expect(
        newRiskApproveRes.matter?.fieldValues?.['matterOpeningSnapshot'],
      ).toEqual(initialOpenedSnapshot);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R187: a fee earner cannot set an open matter conflict check back to In progress or Not started via saveMatterRecord or updateMatterConflictRecord, while submit_referred still records Referred and keeps the matter Active', async () => {
    resetAllDemoData('P-000001');
    const store = getStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
    expect(feeEarner).toBeDefined();

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cookie = createSignedEntraSessionCookie({
      personId: feeEarner.id,
      tenantId: 'not-a-law-firm',
      oid: feeEarner.entraObjectId ?? `00000000-0000-4000-8000-${feeEarner.id}`,
      tid: '11111111-2222-3333-4444-000000000000',
      sub: feeEarner.id,
      email: 'fee-earner-r187@notalawfirm.example',
      displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
      entraRoles: feeEarner.roles ?? ['fee_earner'],
      mappedRoles: feeEarner.roles ?? ['fee_earner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: nowIso,
      expiresAt,
    });
    const feeEarnerSession = {
      personId: feeEarner.id,
      tenantId: 'not-a-law-firm',
      tokenRoles: feeEarner.roles ?? ['fee_earner'],
      expiresAtMs: Date.parse(expiresAt),
      verifiedSession: verifySignedEntraSessionCookie(cookie)!,
    };

    const activeStatusId = store.values.find(
      (v) => v.listKey === 'matter_status' && v.label === 'Active',
    )!.id;

    try {
      for (const openMatterId of ['M-000005', 'M-000003'] as const) {
        const fixtureOpen = structuredClone(
          getStore().matters.find((m) => m.id === openMatterId)!,
        );
        expect(fixtureOpen).toBeDefined();
        expect(fixtureOpen.matterStatusId).toBe(activeStatusId);

        // Save 1: plain save backfills conflictCheckRecord as Cleared
        const save1Res = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              { ...fixtureOpen },
              { id: openMatterId, byId: feeEarner.id },
            ),
        );
        expect(save1Res.errors).toBeUndefined();
        expect(save1Res.matter).not.toBeNull();
        expect(save1Res.matter?.matterStatusId).toBe(activeStatusId);
        expect(save1Res.matter?.conflictCheckRecord?.status).toBe('Cleared');
        expect(save1Res.matter?.conflictCheckRecord?.outcomeLabel).toBe(
          'Cleared by fee earner',
        );
        expect(save1Res.matter?.conflictCheckStatus).toBe('Clear');

        // Save 2a: plain save attempting to set conflictCheckRecord.status back to 'In progress' / 'Pending'
        const saveInProgressRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              {
                ...save1Res.matter!,
                conflictCheckRecord: {
                  ...save1Res.matter!.conflictCheckRecord!,
                  status: 'In progress',
                  outcomeLabel: 'Pending',
                },
              },
              { id: openMatterId, byId: feeEarner.id },
            ),
        );
        expect(saveInProgressRes.errors).toBeUndefined();
        expect(saveInProgressRes.matter).not.toBeNull();
        expect(saveInProgressRes.matter?.matterStatusId).toBe(activeStatusId);
        expect(saveInProgressRes.matter?.conflictCheckRecord?.status).toBe(
          'Cleared',
        );
        expect(
          saveInProgressRes.matter?.conflictCheckRecord?.outcomeLabel,
        ).toBe('Cleared by fee earner');
        expect(saveInProgressRes.matter?.conflictCheckStatus).toBe('Clear');

        // Save 2b: repeat with 'Not started' / 'Pending'
        const saveNotStartedRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              {
                ...save1Res.matter!,
                conflictCheckRecord: {
                  ...save1Res.matter!.conflictCheckRecord!,
                  status: 'Not started',
                  outcomeLabel: 'Pending',
                },
              },
              { id: openMatterId, byId: feeEarner.id },
            ),
        );
        expect(saveNotStartedRes.errors).toBeUndefined();
        expect(saveNotStartedRes.matter).not.toBeNull();
        expect(saveNotStartedRes.matter?.matterStatusId).toBe(activeStatusId);
        expect(saveNotStartedRes.matter?.conflictCheckRecord?.status).toBe(
          'Cleared',
        );
        expect(
          saveNotStartedRes.matter?.conflictCheckRecord?.outcomeLabel,
        ).toBe('Cleared by fee earner');
        expect(saveNotStartedRes.matter?.conflictCheckStatus).toBe('Clear');

        // Direct updateMatterConflictRecord attempt to reset to 'In progress' or 'Not started' is refused with errors.conflict
        for (const resetStatus of ['In progress', 'Not started'] as const) {
          const updateResetRes = runWithActiveActorSession(
            feeEarnerSession,
            () =>
              updateMatterConflictRecord(
                openMatterId,
                {
                  ...save1Res.matter!.conflictCheckRecord!,
                  status: resetStatus,
                  outcomeLabel: 'Pending',
                },
                feeEarner.id,
              ),
          );
          expect(updateResetRes.matter).toBeNull();
          expect(updateResetRes.errors?.conflict).toMatch(
            /opened.*cannot be reset.*referred to Risk/i,
          );
          const storedAfterResetAttempt = getStore().matters.find(
            (m) => m.id === openMatterId,
          )!;
          expect(storedAfterResetAttempt.conflictCheckRecord?.status).toBe(
            'Cleared',
          );
          expect(storedAfterResetAttempt.conflictCheckStatus).toBe('Clear');
        }

        // submit_referred on the open matter still gives Referred and keeps the matter Active
        const referRes = await runWithActiveActorSession(
          feeEarnerSession,
          () =>
            saveMatterRecord(
              {
                ...save1Res.matter!,
                conflictCheckRecord: {
                  ...save1Res.matter!.conflictCheckRecord!,
                  status: 'Referred',
                  outcomeLabel: 'Referred to risk for review',
                },
              },
              {
                id: openMatterId,
                byId: feeEarner.id,
                saveMode: 'submit_referred',
              },
            ),
        );
        expect(referRes.errors).toBeUndefined();
        expect(referRes.matter).not.toBeNull();
        expect(referRes.matter?.matterStatusId).toBe(activeStatusId);
        expect(referRes.matter?.conflictCheckRecord?.status).toBe('Referred');
        expect(referRes.matter?.conflictCheckRecord?.outcomeLabel).toBe(
          'Referred to risk for review',
        );
        expect(referRes.matter?.conflictCheckStatus).toBe(
          'Pending conflict review',
        );
      }
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('R189: buildServerConflictCheckRecord derives outcomeLabel from the final status for fee earners without risk:view', async () => {
    resetAllDemoData('P-000001');
    const store = getStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
    const templateMatter = store.matters.find((m) => m.id === 'M-000001')!;
    expect(feeEarner).toBeDefined();
    expect(templateMatter).toBeDefined();

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cookie = createSignedEntraSessionCookie({
      personId: feeEarner.id,
      tenantId: 'not-a-law-firm',
      oid: feeEarner.entraObjectId ?? `00000000-0000-4000-8000-${feeEarner.id}`,
      tid: '11111111-2222-3333-4444-000000000000',
      sub: feeEarner.id,
      email: 'fee-earner-r189@notalawfirm.example',
      displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
      entraRoles: feeEarner.roles ?? ['fee_earner'],
      mappedRoles: feeEarner.roles ?? ['fee_earner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: nowIso,
      expiresAt,
    });
    const feeEarnerSession = {
      personId: feeEarner.id,
      tenantId: 'not-a-law-firm',
      tokenRoles: feeEarner.roles ?? ['fee_earner'],
      expiresAtMs: Date.parse(expiresAt),
      verifiedSession: verifySignedEntraSessionCookie(cookie)!,
    };

    try {
      // 1. Probe E2: new matter saved as a draft, then submit_cleared with the draft's outcomeLabel: 'Pending' (and status 'Cleared' + outcomeLabel: 'Pending') stores 'Cleared by fee earner'
      const draftRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R189 Draft Then Submit Cleared Matter',
              clientId: templateMatter.clientId,
              practiceAreaId: templateMatter.practiceAreaId,
              workTypeSubcategoryId: templateMatter.workTypeSubcategoryId,
              responsiblePartnerId: templateMatter.responsiblePartnerId,
              supervisingPartnerId: templateMatter.supervisingPartnerId,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 4500,
            },
            { byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(draftRes.errors).toBeUndefined();
      expect(draftRes.matter?.conflictCheckRecord?.status).toBe('In progress');
      expect(draftRes.matter?.conflictCheckRecord?.outcomeLabel).toBe(
        'Pending',
      );

      const submitClearedFromDraftRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...draftRes.matter!,
              conflictCheckRecord: {
                ...draftRes.matter!.conflictCheckRecord!,
                status: 'Cleared',
                outcomeLabel: 'Pending',
              },
            },
            {
              id: draftRes.matter!.id,
              byId: feeEarner.id,
              saveMode: 'submit_cleared',
            },
          ),
      );
      expect(submitClearedFromDraftRes.errors).toBeUndefined();
      expect(
        submitClearedFromDraftRes.matter?.conflictCheckRecord?.status,
      ).toBe('Cleared');
      expect(
        submitClearedFromDraftRes.matter?.conflictCheckRecord?.outcomeLabel,
      ).toBe('Cleared by fee earner');

      // 2. Fee earner plain save with status: 'Referred' and outcomeLabel: 'Cleared by fee earner' stores 'Referred to risk for review'
      const referredMismatchRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              title: 'R189 Referred Outcome Mismatch Matter',
              clientId: templateMatter.clientId,
              practiceAreaId: templateMatter.practiceAreaId,
              workTypeSubcategoryId: templateMatter.workTypeSubcategoryId,
              responsiblePartnerId: templateMatter.responsiblePartnerId,
              supervisingPartnerId: templateMatter.supervisingPartnerId,
              leadFeeEarnerId: feeEarner.id,
              feeEstimateGbp: 4500,
            },
            { byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(referredMismatchRes.errors).toBeUndefined();
      const plainSaveReferredRes = await runWithActiveActorSession(
        feeEarnerSession,
        () =>
          saveMatterRecord(
            {
              ...referredMismatchRes.matter!,
              conflictCheckRecord: {
                ...referredMismatchRes.matter!.conflictCheckRecord!,
                status: 'Referred',
                outcomeLabel: 'Cleared by fee earner',
              },
            },
            {
              id: referredMismatchRes.matter!.id,
              byId: feeEarner.id,
            },
          ),
      );
      expect(plainSaveReferredRes.errors).toBeUndefined();
      expect(plainSaveReferredRes.matter?.conflictCheckRecord?.status).toBe(
        'Referred',
      );
      expect(
        plainSaveReferredRes.matter?.conflictCheckRecord?.outcomeLabel,
      ).toBe('Referred to risk for review');
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('enforces two-tenant SharePoint Sites.Selected grant isolation, tampered siteId/driveId rejection, and cached health isolation (R195, R196)', async () => {
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-sp-iso-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: tenantBToken,
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-sp-iso-b',
    });

    const storeA: DocumentStoreConfig = {
      storeId: 'store-alpha',
      displayName: 'Alpha SharePoint Store',
      providerType: 'sharepoint',
      isDefault: true,
      enabled: true,
      auth: {
        entraTenantId: '11111111-1111-1111-1111-111111111111',
        credentialMode: 'client_certificate',
        clientId: 'aaaaaaaa-1111-1111-1111-111111111111',
        certificateKeyVaultSecretRef: 'kv://kv-alpha/sp-cert',
        delegatedPermissionScope: 'Sites.Selected',
      },
      sharepoint: {
        hostname: 'alpha.sharepoint.com',
        siteRelativePath: '/sites/AlphaMatters',
        siteId: 'site-alpha-001',
        libraries: [
          {
            libraryId: 'lib-matters',
            displayName: 'Matters',
            libraryUrlSegment: 'Matters',
            driveId: 'drive-alpha-001',
          },
        ],
      },
    };

    const storeB: DocumentStoreConfig = {
      storeId: 'store-beta',
      displayName: 'Beta SharePoint Store',
      providerType: 'sharepoint',
      isDefault: true,
      enabled: true,
      auth: {
        entraTenantId: '22222222-2222-2222-2222-222222222222',
        credentialMode: 'client_certificate',
        clientId: 'bbbbbbbb-2222-2222-2222-222222222222',
        certificateKeyVaultSecretRef: 'kv://kv-beta/sp-cert',
        delegatedPermissionScope: 'Sites.Selected',
      },
      sharepoint: {
        hostname: 'beta.sharepoint.com',
        siteRelativePath: '/sites/BetaMatters',
        siteId: 'site-beta-001',
        libraries: [
          {
            libraryId: 'lib-matters',
            displayName: 'Matters',
            libraryUrlSegment: 'Matters',
            driveId: 'drive-beta-001',
          },
        ],
      },
    };

    const backend = new MockSharePointGraphBackend();
    const tokenService = new DocumentStoreTokenService({
      cache: new TenantScopedEncryptedTokenCache(),
    });
    const providerA = new SharePointDocumentStoreProvider({
      tenantContext: ctxA,
      storeConfig: storeA,
      tokenService,
      backend,
    });
    const providerB = new SharePointDocumentStoreProvider({
      tenantContext: ctxB,
      storeConfig: storeB,
      tokenService,
      backend,
    });

    // Tenant A has fullcontrol on site-alpha-001, while Tenant B has NO grant on site-beta-001
    backend.setSitePermissionGrant({
      tenantId: ctxA.tenantId,
      storeId: storeA.storeId,
      siteId: 'site-alpha-001',
      role: 'fullcontrol',
    });
    backend.setSitePermissionGrant({
      tenantId: ctxB.tenantId,
      storeId: storeB.storeId,
      siteId: 'site-beta-001',
      role: 'none',
    });

    const [healthA] = await runTenantSharePointHealthCheckJob({
      tenantId: ctxA.tenantId,
      tenantContext: ctxA,
      stores: [storeA],
      tokenService,
      backend,
    });
    const [healthB] = await runTenantSharePointHealthCheckJob({
      tenantId: ctxB.tenantId,
      tenantContext: ctxB,
      stores: [storeB],
      tokenService,
      backend,
    });

    expect(healthA?.ok).toBe(true);
    expect(healthB?.ok).toBe(false);
    expect(healthB?.errorReasonCode).toBe('site_access_not_granted');

    // Tenant A's grant never gives Tenant B access to Tenant B's site, nor can Tenant A target Tenant B's siteId or driveId
    await expect(
      providerB.ensureFolderTree(
        {
          kind: 'provisioning',
          tenantContext: ctxB,
          triggerEvent: 'test.b',
        },
        {
          storeId: storeB.storeId,
          libraryId: 'lib-matters',
          siteId: 'site-beta-001',
          driveId: 'drive-beta-001',
        },
        [{ name: '01 Client Care', relativePath: '01 Client Care' }],
      ),
    ).rejects.toMatchObject({
      code: 'access_denied',
      reason: 'site_access_not_granted',
    });

    backend.clearCallLog();
    await expect(
      providerA.ensureFolderTree(
        {
          kind: 'provisioning',
          tenantContext: ctxA,
          triggerEvent: 'test.a.tampered',
        },
        {
          storeId: storeA.storeId,
          libraryId: 'lib-matters',
          siteId: 'site-beta-001',
          driveId: 'drive-alpha-001',
        },
        [{ name: '01 Client Care', relativePath: '01 Client Care' }],
      ),
    ).rejects.toMatchObject({
      code: 'access_denied',
      reason: 'site_or_drive_mismatch',
    });
    expect(backend.getCallLog()).toHaveLength(0);
  });

  it('S0-03 (B12, B11, B3): empty-allowlist ethical-wall matter is hidden from snapshots, search, and reports for non-participants (partner, fee earner, admin without matter:restricted:access), and blocks tampered matter/sign-off/person IDs and cross-tenant claims', async () => {
    try {
      const store = getStore();
      const namedPartner = store.people.find((p) => p.id === 'P-000005')!;
      const unnamedPartner = store.people.find((p) => p.id === 'P-000001')!;
      const unnamedFeeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const adminPerson = store.people.find((p) => p.id === 'P-000004')!;

      // Create an ethical-wall matter owned by namedPartner (P-000005) and explicitly clear restrictedAccessUserIds to []
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const { id: _omittedId, ...matterTemplate } = baseMatter;
      void _omittedId;

      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const namedPartnerCookie = createSignedEntraSessionCookie({
        personId: namedPartner.id,
        tenantId: 'not-a-law-firm',
        oid: namedPartner.entraObjectId ?? '00000000-0000-4000-8000-000000000005',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: namedPartner.id,
        email: namedPartner.emails[0]?.address ?? 'partner5@notalawfirm.example',
        displayName: 'Named Partner',
        entraRoles: ['partner'],
        mappedRoles: ['partner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verifiedNamedSession = verifySignedEntraSessionCookie(namedPartnerCookie)!;
      const namedSession = {
        personId: namedPartner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: verifiedNamedSession.mappedRoles,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifiedNamedSession,
      };

      const wallSaveRes = await runWithActiveActorSession(namedSession, () =>
        saveMatterRecord(
          {
            ...matterTemplate,
            title: 'S0-03 Empty Allowlist Ethical Wall Secret Acquisition',
            isStaffMatter: false,
            hasEthicalWall: true,
            restrictedAccessUserIds: [],
            responsiblePartnerId: namedPartner.id,
            supervisingPartnerId: namedPartner.id,
            leadFeeEarnerId: namedPartner.id,
            teamMemberIds: [namedPartner.id],
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
          },
          { byId: namedPartner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(wallSaveRes.matter).not.toBeNull();
      const wallMatter = store.matters.find((m) => m.id === wallSaveRes.matter!.id)!;
      // Force restrictedAccessUserIds to empty array (B12 condition: hasEthicalWall === true, isStaffMatter === false, restrictedAccessUserIds === [])
      wallMatter.isStaffMatter = false;
      wallMatter.hasEthicalWall = true;
      wallMatter.restrictedAccessUserIds = [];

      // Create a key date and a sign-off linked to wallMatter
      await runWithActiveActorSession(namedSession, () =>
        createOrProposeKeyDateRecord(
          {
            matterId: wallMatter.id,
            keyDateTypeId: 'limitation',
            title: 'S0-03 Walled Matter Key Date',
            dueDate: '2026-01-01',
            responsiblePersonIds: [namedPartner.id],
            teamId: wallMatter.owningTeamId || 'TM-000001',
            source: 'manual',
          },
          namedPartner.id,
        ),
      );
      store.signOffs.unshift({
        id: 'SO-WALLED-01',
        kind: 'write_off',
        title: 'Walled write-off',
        matterNumber: wallMatter.matterNumber,
        matterId: wallMatter.id,
        subtitle: 'Walled matter write-off',
        requestedById: namedPartner.id,
        requestedAt: nowIso,
        assignedPartnerId: unnamedPartner.id,
        status: 'Pending',
      });

      // Revoke matter:restricted:access on adminPerson to test admin without matter:restricted:access
      adminPerson.permissionOverrides = {
        grant: [],
        revoke: ['matter:restricted:access'],
      };

      for (const excludedActor of [unnamedPartner, unnamedFeeEarner, adminPerson]) {
        const snap = getAppSnapshot(excludedActor.id);
        expect(snap.matters.some((m) => m.id === wallMatter.id)).toBe(false);
        expect(
          snap.searchIndex.some(
            (doc) =>
              doc.id === wallMatter.id ||
              doc.title.includes('Empty Allowlist Ethical Wall'),
          ),
        ).toBe(false);
        expect(snap.keyDates.some((kd) => kd.matterId === wallMatter.id)).toBe(false);

        const diary = queryKeyDatesTeamDiaryRecord({}, excludedActor.id);
        expect(diary.some((e) => e.matterId === wallMatter.id)).toBe(false);
      }

      // Reports also exclude the walled matter for an actor without matter:restricted:access
      const partnerExceptions = getKeyDateExceptionsReportRecord({}, unnamedPartner.id);
      expect(
        partnerExceptions.some((ex) => ex.matterId === wallMatter.id),
      ).toBe(false);

      // Tampered matterId / signOffId attempts by unnamedPartner and unnamedFeeEarner are denied
      expect(
        getMatterPmsViewBundle(wallMatter.id, unnamedPartner.id).matterBundle,
      ).toBeNull();
      const tamperedSignOffApprove = approveSignOff('SO-WALLED-01', unnamedPartner.id);
      expect(isActionDenied(tamperedSignOffApprove)).toBe(true);
      const tamperedSignOffId = approveSignOff('SO-NONEXISTENT-999', unnamedPartner.id);
      expect(isActionDenied(tamperedSignOffId)).toBe(true);
      const tamperedDiscuss = discussSignOff('SO-WALLED-01', 'Probe', unnamedPartner.id);
      expect(isActionDenied(tamperedDiscuss)).toBe(true);

      // Forged cross-tenant session is rejected by guardedAction on S0-03 actions
      setTestEntraSessionOverride({
        personId: unnamedPartner.id,
        tenantId: 'tenant-beta-forged',
        oid: '00000000-0000-4000-8000-000000000001',
        tid: '99999999-8888-7777-6666-555555555555',
        sub: unnamedPartner.id,
        email: 'forged@pembrokevaughan.example',
        displayName: 'Forged Partner',
        entraRoles: ['partner', 'admin'],
        mappedRoles: ['partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });

      await expect(approveSignOffAction('SO-000001')).rejects.toThrow(
        /TENANCY_FORGERY_DETECTED/i,
      );
      await expect(
        discussSignOffAction('SO-000001', 'Cross-tenant note'),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      await expect(
        savePersonAction({ firstName: 'Forged', surname: 'Tenant' }, {}),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('S0-04: an admin of tenant B cannot change tenant A lists, custom fields, teams, or PMS links via forged tenant claims or tampered record IDs', async () => {
    try {
      resetAllDemoData('P-000001');
      const store = getStore();
      const firstValue = structuredClone(store.values[0]!);
      const firstTeam = structuredClone(store.teams[0]!);
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

      // 1. Admin of Tenant B presenting a Tenant B claim against Tenant A's runtime is rejected at the action boundary
      setTestEntraSessionOverride({
        personId: 'P-000004',
        tenantId: 'fictional-chambers-uk',
        oid: '00000000-0000-4000-8000-000000000004',
        tid: '22222222-2222-2222-2222-222222222222',
        sub: 'P-000004',
        email: 'admin@fictionalchambers.example',
        displayName: 'Tenant B Admin',
        entraRoles: ['admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });

      await expect(
        updateChoiceValueAction(firstValue.id, {
          label: 'Tampered From Tenant B',
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      expect(store.values.find((v) => v.id === firstValue.id)?.label).toBe(
        firstValue.label,
      );

      await expect(
        saveTeamAction({
          id: firstTeam.id,
          name: 'Tampered Team Name From Tenant B',
          memberIds: firstTeam.memberIds,
          leadIds: firstTeam.leadIds,
          practiceAreaIds: firstTeam.practiceAreaIds,
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      expect(store.teams.find((t) => t.id === firstTeam.id)?.name).toBe(
        firstTeam.name,
      );

      // 2. Even within an authenticated admin session, tampered cross-tenant record IDs that do not belong to the tenant are rejected with FORBIDDEN and never create phantom records
      setTestEntraSessionOverride({
        personId: 'P-000004',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000004',
        tid: '00000000-0000-4000-8000-000000000000',
        sub: 'P-000004',
        email: 'huw.pritchard@notalawfirm.example',
        displayName: 'Huw Pritchard',
        entraRoles: ['admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });

      const teamsCountBefore = store.teams.length;
      const cfCountBefore = store.customFields.length;
      const pmsLinksCountBefore = store.pmsLinks.length;

      const tamperedValUpdate = await updateChoiceValueAction(
        'choice_value.tenant_b_nonexistent',
        { label: 'Tampered' },
      );
      expect(isActionDenied(tamperedValUpdate)).toBe(true);

      const tamperedValReorder = await reorderChoiceValueAction(
        'choice_value.tenant_b_nonexistent',
        1,
      );
      expect(isActionDenied(tamperedValReorder)).toBe(true);

      const tamperedCfSave = await saveCustomFieldAction({
        id: 'cf_tenant_b_nonexistent',
        recordType: 'person',
        label: 'Tampered CF',
        fieldType: 'text',
        section: 'A',
        required: false,
      });
      expect(isActionDenied(tamperedCfSave)).toBe(true);
      expect(store.customFields.length).toBe(cfCountBefore);

      const tamperedCfReorder = await reorderCustomFieldAction(
        'cf_tenant_b_nonexistent',
        1,
      );
      expect(isActionDenied(tamperedCfReorder)).toBe(true);

      const tamperedTeamSave = await saveTeamAction({
        id: 'TM-TENANT-B-999',
        name: 'Tampered Cross-Tenant Team',
        memberIds: ['P-000001'],
        leadIds: ['P-000001'],
        practiceAreaIds: [],
      });
      expect(isActionDenied(tamperedTeamSave)).toBe(true);
      expect(store.teams.length).toBe(teamsCountBefore);

      const tamperedPmsLink = await linkPmsRecordAction(
        'organisation',
        'O-TENANT-B-999',
        'CL-TAMPERED',
      );
      expect(isActionDenied(tamperedPmsLink)).toBe(true);
      expect(store.pmsLinks.length).toBe(pmsLinksCountBefore);

      const tamperedPmsUnlink = await unlinkPmsRecordAction('PMSL-TENANT-B-999');
      expect(isActionDenied(tamperedPmsUnlink)).toBe(true);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('S0-05: rejects tampered cross-tenant record IDs and forged tenant claims across all 20 S0-05 record actions', async () => {
    try {
      resetAllDemoData('P-000001');
      const store = getStore();
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

      // 1. Forged tenant claim is rejected at the action boundary
      setTestEntraSessionOverride({
        personId: 'P-000001',
        tenantId: 'fictional-chambers-uk',
        oid: '00000000-0000-4000-8000-000000000001',
        tid: '22222222-2222-2222-2222-222222222222',
        sub: 'P-000001',
        email: 'partner@fictionalchambers.example',
        displayName: 'Tenant B Partner',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });

      await expect(
        saveTaskAction({
          title: 'Cross-tenant task',
          dueAt: '2026-12-01',
          assignedPersonId: 'P-000001',
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);

      await expect(
        saveEnquiryAction({ firstName: 'Cross', lastName: 'Tenant' }, { asDraft: true }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);

      await expect(
        saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Cross Tenant',
          practiceAreaId: store.quotes[0]!.practiceAreaId,
          scope: 'Scope',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1000,
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);

      // 2. Within an authenticated Tenant A session, tampered record IDs belonging to Tenant B are rejected with FORBIDDEN
      setTestEntraSessionOverride({
        personId: 'P-000001',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000001',
        tid: '00000000-0000-4000-8000-000000000000',
        sub: 'P-000001',
        email: 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });

      const tasksBefore = store.tasks.length;
      const enquiriesBefore = store.enquiries.length;
      const quotesBefore = store.quotes.length;
      const orgsBefore = store.organisations.length;
      const linksBefore = store.links.length;
      const notesBefore = store.notes.length;

      expect(
        isActionDenied(
          await saveTaskAction({
            id: 'TSK-TENANT-B-999',
            title: 'Tampered task',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000001',
          }),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await saveTaskAction({
            title: 'Task linked to Tenant B matter',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000001',
            linkedRecords: [{ recordType: 'matter', recordId: 'M-TENANT-B-999' }],
          }),
        ),
      ).toBe(true);
      expect(isActionDenied(await takeTaskAction('TSK-TENANT-B-999'))).toBe(true);
      expect(
        isActionDenied(await addTaskCommentAction('TSK-TENANT-B-999', 'Tampered comment')),
      ).toBe(true);

      expect(
        isActionDenied(
          await saveEnquiryAction(
            { firstName: 'Tampered', lastName: 'Enquiry' },
            { id: 'ENQ-TENANT-B-999', asDraft: true },
          ),
        ),
      ).toBe(true);
      expect(
        isActionDenied(await assignEnquiryAction('ENQ-TENANT-B-999', 'P-000001')),
      ).toBe(true);
      expect(
        isActionDenied(
          await logEnquiryContactAction('ENQ-TENANT-B-999', {
            method: 'Phone',
            outcome: 'Spoke',
            note: 'Tampered',
          }),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await sendEnquiryEmailAction('ENQ-TENANT-B-999', {
            to: 'test@notalawfirm.example',
            subject: 'Tampered',
            bodyHtml: '<p>Test</p>',
            bodyText: 'Test',
          }),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await closeEnquiryAction('ENQ-TENANT-B-999', {
            targetStatus: 'Declined',
            closeReasonId: 'enquiry_close_reason.conflict',
          }),
        ),
      ).toBe(true);
      expect(isActionDenied(await reopenEnquiryAction('ENQ-TENANT-B-999'))).toBe(true);

      expect(
        isActionDenied(
          await saveQuoteAction(
            {
              clientType: 'prospect',
              prospectName: 'Tampered',
              practiceAreaId: store.quotes[0]!.practiceAreaId,
              scope: 'Scope',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1000,
            },
            { id: 'Q-TENANT-B-999' },
          ),
        ),
      ).toBe(true);
      expect(isActionDenied(await markQuoteSentAction('Q-TENANT-B-999'))).toBe(true);
      expect(
        isActionDenied(
          await logQuoteFollowUpAction('Q-TENANT-B-999', {
            method: 'Phone',
            note: 'Tampered',
            nextFollowUpDate: '2026-12-01',
          }),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await reviseQuoteAction('Q-TENANT-B-999', {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1200,
            scope: 'Tampered',
          }),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await recordQuoteOutcomeAction('Q-TENANT-B-999', { outcome: 'Accepted' }),
        ),
      ).toBe(true);

      expect(
        isActionDenied(
          await saveOrganisationAction(
            { legalName: 'Tampered Org' },
            { id: 'O-TENANT-B-999' },
          ),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await saveLinkAction({
            id: 'L-TENANT-B-999',
            personId: 'P-000001',
            organisationId: store.organisations[0]!.id,
            jobTitle: 'Director',
            department: '',
            roleWithinOrganisation: 'Director',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: true,
            startDate: null,
            endDate: null,
            contactStatusId: null,
          }),
        ),
      ).toBe(true);
      expect(isActionDenied(await deleteLinkAction('L-TENANT-B-999'))).toBe(true);
      expect(
        isActionDenied(await addNoteAction('matter', 'M-TENANT-B-999', 'Tampered note')),
      ).toBe(true);
      expect(
        isActionDenied(
          await dismissDuplicateAction('person', 'P-TENANT-B-999', 'P-000001'),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await mergeRecordsAction('person', 'P-000001', 'P-TENANT-B-999'),
        ),
      ).toBe(true);
      expect(
        isActionDenied(
          await reassignLeaverOwnedRecordsAction('P-TENANT-B-999', 'P-000001'),
        ),
      ).toBe(true);

      expect(store.tasks.length).toBe(tasksBefore);
      expect(store.enquiries.length).toBe(enquiriesBefore);
      expect(store.quotes.length).toBe(quotesBefore);
      expect(store.organisations.length).toBe(orgsBefore);
      expect(store.links.length).toBe(linksBefore);
      expect(store.notes.length).toBe(notesBefore);
    } finally {
      setTestEntraSessionOverride(undefined);
      resetAllDemoData('P-000001');
    }
  });
});
