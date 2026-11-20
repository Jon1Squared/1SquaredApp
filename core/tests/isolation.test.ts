import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertTenantOwnsKeyVaultSecretRef,
  buildTenantCacheKey,
   collectConfigDeprecationWarnings,
  ConflictReviewConfigSubSchema,
  CORE_API_VERSION,
  CORE_TENANT_MIGRATIONS,
  DOCUMENT_GENERATION_MIGRATION_0001,
  DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
  DocumentStoreTokenService,
  emitTenantTelemetryEvent,
  emitTenantTelemetryException,
  ExtensionHookPointSchema,
  ExtensionHost,
  ExtensionManifestSchema,
  ExtensionPermissionSchema,
  FirmConfigSubSchema,
  KEY_DATES_MIGRATION_0003,
  loadAndValidateTenantConfig,
  PlatformTelemetryRecorder,
  TenantDocumentRepository,
  TenantPostgresPoolManager,
  TenantDocumentStoreRepository,
  resolveTenantFromVerifiedToken,
  resolveTenantPostgresConfig,
  runTenantBackgroundJob,
  runTenantSharePointHealthCheckJob,
  SharePointDocumentStoreProvider,
  TenantAuditRepository,
  TenantMigrationRunner,
  TenantSearchRepository,
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
import {
  reconcileServerConflictMatches,
  searchMatterConflicts,
} from '../../src/domain/matterConflicts';
import { runEnquiryConflictSearch } from '../../src/domain/enquiries';
import {
  conflictStatusPillFromLegacy,
  legacyConflictStatusFromRecord,
  resolveMatterConflictCheckRecord,
} from '../../src/domain/matterOpeningRecord';
import { resolveMatterIntakeComplianceRows } from '../../src/components/MatterProfileClient';
import { buildDefaultOrgStructure } from '../../src/domain/orgStructure';
import {
  getDefaultTenantRbacConfig,
  resolveConfiguredFirmPrimaryDomain,
  runWithActiveActorSession,
} from '../../src/server/rbacRuntime';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getAuditRepository,
  getCatalogueRepository,
  getExtensionHostLoadErrors,
  getJobRunRepository,
  getOutboxRepository,
  getPlatformExtensionHost,
  getPmsRepository,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  clearJwksCache,
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifyEntraJwtSignatureAndClaims,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  approveSignOff,
  assignEnquiryRecord,
  closeEnquiryRecord,
  createOrProposeKeyDateRecord,
  createRecordFromPms,
  discussSignOff,
  executeKeyDateRemindersForTenant,
  flagMatterWriteOff,
  getAppSnapshot,
  getClientPmsViewBundle,
  getEmployeeDetailsForUser,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getKeyDateExceptionsReportRecord,
  getMatterPmsViewBundle,
  getMatterRepository,
  getPartyRepository,
  getRegisterRepository,
  getTaskWorkflowRepository,
  liftMatterRestriction,
  listAuditEntriesForRecord,
  listFirmAuditEntriesPage,
  markEngagementLetterDrafted,
  queryKeyDatesTeamDiaryRecord,
  recordInvoiceCreditControlAction,
  recordKeyDateNotApplicableRecord,
  requestMatterBill,
  resetAllDemoData,
  resolveOrProvisionEntraEmployee,
  runEnquiryRetentionAnonymisationForTenant,
  runMatterConflictSearchRecord,
  runScheduledEnquiryRetentionAnonymisationJobSweep,
  runScheduledUsageRetentionPurgeJobSweep,
  saveEnquiryRecord,
  saveMatterRecord,
  savePersonRecord,
  saveTaskRecord,
  signOffMatterCostsRecord,
  updateMatterConflictRecord,
  updateMatterLifecycleStatusRecord,
  updatePersonPermissionOverrides,
} from '../../src/server/services';
import { guardedJob } from '../../src/server/authorize';
import { getDocumentRepository } from '../../src/server/documentGenerationServices';
import {
  getFirmFinance,
  getMatterFinanceRows,
  getMyFinanceFigures,
} from '../../src/server/financeServices';
import {
  addNoteAction,
  addTaskCommentAction,
  approveSignOffAction,
  assignEnquiryAction,
  closeEnquiryAction,
  deleteLinkAction,
  discussSignOffAction,
  dismissDuplicateAction,
  flagMatterWriteOffAction,
  linkPmsRecordAction,
  logEnquiryContactAction,
  logQuoteFollowUpAction,
  markQuoteSentAction,
  mergeRecordsAction,
  prepareEnquiryConversionAction,
  prepareQuoteConversionAction,
  reassignLeaverOwnedRecordsAction,
  recordInvoiceCreditControlActionAction,
  recordQuoteOutcomeAction,
  reorderChoiceValueAction,
  reorderCustomFieldAction,
  reopenEnquiryAction,
  requestMatterBillAction,
  revealEmployeePayrollAction,
  reviseQuoteAction,
  runMatterConflictSearchAction,
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
import { createSeedStore } from '../../src/seed/seedStoreBuilder';
import { loadCommittedSeedStore } from '../../src/seed/seedSnapshot';
import { testDataResetContext } from '../../src/test/testTenantContexts';
import { auditEntriesForRecord, auditEntriesSince, getKeyDateRepository, markAuditPosition, runAsTestActor, testTenantCtx } from '../../src/server/testSupport/auditTestSupport';

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

  it('isolates data between two tenants in real per-tenant PostgreSQL databases and blocks tampered record IDs across tenants', async () => {
    const repo = new TenantDocumentRepository();

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

    await repo.offboardTenantData(ctxA);
    await repo.offboardTenantData(ctxB);

    const baseDoc = {
      fileName: 'matter-note.docx',
      documentType: 'letter',
      outputFormat: 'docx' as const,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSizeBytes: 256,
      fileSha256: 'sha-iso-0001',
      templateId: 'TPL-ISO',
      templateName: 'Isolation Template',
      templateVersionId: 'TPLV-ISO',
      templateVersionNumber: 1,
      storageProvider: 'local-fs' as const,
      storageKey: 'blob-iso-0001',
      generatedByUserId: 'user-a1',
      generatedAt: new Date().toISOString(),
      isDeleted: false,
    };

    await repo.putDocument(ctxA, {
      ...baseDoc,
      id: 'DOC-ISO-0001',
      tenantId: ctxA.tenantId,
      title: 'Tenant A Confidential Matter',
    });

    await repo.putDocument(ctxB, {
      ...baseDoc,
      id: 'DOC-ISO-0002',
      tenantId: ctxB.tenantId,
      title: 'Tenant B Confidential Matter',
    });

    expect((await repo.getDocumentById(ctxA, 'DOC-ISO-0001'))?.id).toBe('DOC-ISO-0001');
    expect(await repo.getDocumentById(ctxA, 'DOC-ISO-0002')).toBeNull();
    expect(await repo.listDocuments(ctxA)).toHaveLength(1);

    await expect(
      repo.putDocument(ctxA, {
        ...baseDoc,
        id: 'DOC-TAMPERED',
        tenantId: ctxB.tenantId,
        title: 'Cross-tenant write attempt',
      }),
    ).rejects.toMatchObject({
      code: 'TENANCY_ISOLATION_ERROR',
      message: expect.stringMatching(
        /^TENANCY_ISOLATION_ERROR: Cannot write or access \S+ belonging to tenant "fictional-chambers-uk" under tenant "not-a-law-firm"\.$/,
      ),
    });

    // R439: re-read on a fresh pool manager (fresh connections) — the tampered row never landed
    // in either database, and tenant A's own row is still there (positive control).
    const freshPoolMgr = new TenantPostgresPoolManager();
    try {
      const freshRepo = new TenantDocumentRepository({ poolManager: freshPoolMgr });
      expect(await freshRepo.getDocumentById(ctxA, 'DOC-TAMPERED')).toBeNull();
      expect(await freshRepo.getDocumentById(ctxB, 'DOC-TAMPERED')).toBeNull();
      expect((await freshRepo.getDocumentById(ctxA, 'DOC-ISO-0001'))?.title).toBe(
        'Tenant A Confidential Matter',
      );
      expect((await freshRepo.getDocumentById(ctxB, 'DOC-ISO-0002'))?.title).toBe(
        'Tenant B Confidential Matter',
      );

      // R439: a forged tenant claim sent through a real repository call. The context claims
      // tenant B but still points at tenant A's database. Tenant B's role has no USAGE on tenant A's
      // public schema, so PostgreSQL cannot even see the table (SQLSTATE 42P01) and the call fails closed.
      const forgedCtx = Object.freeze({ ...ctxA, tenantId: ctxB.tenantId });
      await expect(
        freshRepo.getDocumentById(forgedCtx, 'DOC-ISO-0001'),
      ).rejects.toMatchObject({
        code: '42P01',
        message: 'TENANCY_DATABASE_ERROR: Database operation "query" failed (SQLSTATE 42P01).',
      });
      // Positive control next to the negative case: the genuine tenant A context still reads.
      expect((await freshRepo.getDocumentById(ctxA, 'DOC-ISO-0001'))?.id).toBe(
        'DOC-ISO-0001',
      );
    } finally {
      await freshPoolMgr.closeAllPools();
    }
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
    ).toThrow(
      'TENANCY_FORGERY_DETECTED: Request attempted to override authenticated token tenantId.',
    );
    // Positive control: the same token without the forged override resolves tenant A.
    expect(
      resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-forgery-001',
      }).tenantId,
    ).toBe(tenantAToken.tenantId);

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
      {
        ...notALawFirmDevOverlay,
        featureFlags: { enableDemoMode: false },
      },
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
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
      const baseMatter = store.matters.find((m) => m.id === 'M-000008')!;

      // (a) Outside a signed-in request scope, saveMatterRecord refuses with UNAUTHENTICATED and runs no extension hooks
      const unauthSaveRes = await runWithActiveActorSession(null, async () =>
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
        async () =>
          saveMatterRecord(
            {
              ...baseMatter,
              agreedFeeCapGbp: 30000,
              feeEstimateGbp: 30000,
              conflictCheckRecord: {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: carys.id,
                lastRunByName: `${carys.firstName} ${carys.surname}`,
                submittedAtDisplay: '19 Nov 2026',
                submittedById: carys.id,
                submittedByName: `${carys.firstName} ${carys.surname}`,
                approvedAtDisplay: '19 Nov 2026',
                approvedById: carys.id,
                approvedByName: `${carys.firstName} ${carys.surname}`,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
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
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
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
      const store = loadCommittedSeedStore();
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
        async () =>
          saveMatterRecord(
            {
              ...baseMatter,
              conflictCheckRecord: {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: carys.id,
                lastRunByName: `${carys.firstName} ${carys.surname}`,
                submittedAtDisplay: '19 Nov 2026',
                submittedById: carys.id,
                submittedByName: `${carys.firstName} ${carys.surname}`,
                approvedAtDisplay: '19 Nov 2026',
                approvedById: carys.id,
                approvedByName: `${carys.firstName} ${carys.surname}`,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
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
          async () =>
            saveMatterRecord(
              {
                ...baseMatter,
                conflictCheckRecord: {
                  status: 'Cleared',
                  outcomeLabel: 'Cleared by fee earner',
                  declarationConfirmed: true,
                  reviewerMessage: '',
                  lastRunAtDisplay: '19 Nov 2026',
                  lastRunById: carys.id,
                  lastRunByName: `${carys.firstName} ${carys.surname}`,
                  submittedAtDisplay: '19 Nov 2026',
                  submittedById: carys.id,
                  submittedByName: `${carys.firstName} ${carys.surname}`,
                  approvedAtDisplay: '19 Nov 2026',
                  approvedById: carys.id,
                  approvedByName: `${carys.firstName} ${carys.surname}`,
                  parties: [],
                  matches: [],
                  comments: [],
                  runs: [],
                },
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }

    // R106: Domain helpers (syncHomeRolesWithEmployeeRoles, createDefaultMatterCostsConfig) succeed in browser window mode without reading tenant configuration
    const storeValues = loadCommittedSeedStore().values;
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

  it('R144: async saveMatterRecord never reissues IDs on veto and serialises concurrent matter saves without losing either write', async () => {
    try {
      const store = loadCommittedSeedStore();
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
      let onHookEntered: (() => void) | null = null;
      let releaseHookFn: (() => void) | null = null;
      const releaseCurrentHook = () => {
        const fn = releaseHookFn;
        releaseHookFn = null;
        fn?.();
      };
      activeHost.registerExtension({
        manifest: {
          id: 'nalf-slow-concurrency-ext',
          name: 'Slow Concurrency Extension',
          version: '1.0.0',
          description: 'Waits for concurrent test latch during beforeMatterOpen',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:open:gate'],
          hooks: ['beforeMatterOpen'],
        },
        hooks: {
          beforeMatterOpen: async () => {
            const releasePromise = new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              releaseHookFn = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            onHookEntered?.();
            await releasePromise;
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

      // Start slow vetoed save and wait until it is inside beforeMatterOpen
      const vetoHookEntered = new Promise<void>((resolve) => {
        onHookEntered = resolve;
      });
      const slowVetoPromise = runWithActiveActorSession(actorSession, async () =>
        saveMatterRecord(
          {
            ...targetMatter,
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '19 Nov 2026',
              lastRunById: carys.id,
              lastRunByName: `${carys.firstName} ${carys.surname}`,
              submittedAtDisplay: '19 Nov 2026',
              submittedById: carys.id,
              submittedByName: `${carys.firstName} ${carys.surname}`,
              approvedAtDisplay: '19 Nov 2026',
              approvedById: carys.id,
              approvedByName: `${carys.firstName} ${carys.surname}`,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
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

      // While slowVetoPromise is awaiting the hook, create a new matter (with an inline party) and update targetMatter's conflict record
      await vetoHookEntered;
      onHookEntered = null;
      const { id: _omittedTargetId, ...newMatterTemplate } = targetMatter;
      void _omittedTargetId;
      const concurrentNewMatterRes = await runWithActiveActorSession(
        actorSession,
        async () =>
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
      const concurrentConflictUpdate = await runWithActiveActorSession(
        actorSession,
        async () =>
          updateMatterConflictRecord(
            targetMatter.id,
            {
              ...baseConflict,
              reviewerMessage: 'Updated concurrently while hook was waiting',
            },
            carys.id,
          ),
      );
      expect(concurrentConflictUpdate.matter).not.toBeNull();

      releaseCurrentHook();
      const slowVetoRes = await slowVetoPromise;
      expect(slowVetoRes.matter).toBeNull();

      // Create another matter after the veto and verify no Matter or Person ID was issued twice
      const postVetoMatterRes = await runWithActiveActorSession(
        actorSession,
        async () =>
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

      const allMatterIds = (
        await getMatterRepository().listAllMattersUnfiltered(testTenantCtx(carys.id))
      ).map((m) => m.id);
      expect(new Set(allMatterIds).size).toBe(allMatterIds.length);
      const allPersonIds = (
        await getPartyRepository().listAllPeople(testTenantCtx(carys.id))
      ).map((p) => p.id);
      expect(new Set(allPersonIds).size).toBe(allPersonIds.length);

      // Verify the concurrent conflict-record update on targetMatter is still intact
      const refreshedTarget = (await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
        testTenantCtx(carys.id),
        targetMatter.id,
      ))!;
      expect(refreshedTarget.conflictCheckRecord?.reviewerMessage).toBe(
        'Updated concurrently while hook was waiting',
      );

      // Now verify that when a hook allows proceed after 50ms, a concurrent update to the same matter bumps row_version in PostgreSQL so saveMatterRecord refuses the stale save with MATTER_CONCURRENCY_CONFLICT and never overwrites the concurrent update
      hookMode = 'allow_after_50ms';
      // Wait until the save is inside the hook (after it has read its baseline) rather than a fixed delay
      const staleHookEntered = new Promise<void>((resolve) => {
        onHookEntered = resolve;
      });
      const staleSavePromise = runWithActiveActorSession(actorSession, async () =>
        saveMatterRecord(
          {
            ...refreshedTarget,
            title: 'Stale Overwrite Attempt',
          },
          { id: refreshedTarget.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      await staleHookEntered;
      onHookEntered = null;
      const queuedUpdateRes = await runWithActiveActorSession(
        actorSession,
        async () =>
          updateMatterConflictRecord(
            refreshedTarget.id,
            {
              ...baseConflict,
              status: 'Cleared',
              reviewerMessage: 'Second concurrent update during allow hook',
            },
            carys.id,
          ),
      );
      expect(queuedUpdateRes.errors).toBeUndefined();
      expect(queuedUpdateRes.matter).not.toBeNull();
      releaseCurrentHook();
      const staleSaveRes = await staleSavePromise;
      expect(staleSaveRes.matter).toBeNull();
      expect(staleSaveRes.errors?.conflict).toMatch(
        /changed by someone else while you were saving/i,
      );
      const finalTarget = (await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
        testTenantCtx(carys.id),
        refreshedTarget.id,
      ))!;
      expect(finalTarget.title).not.toBe('Stale Overwrite Attempt');
      expect(finalTarget.conflictCheckRecord?.reviewerMessage).toBe(
        'Second concurrent update during allow hook',
      );
    } finally {
      setActiveTenantConfigForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R147: referred conflict reviews route via conflictReview config, stay unassigned when unconfigured, and never assign or leak staff matter titles outside restrictedAccessUserIds', async () => {
    try {
      const store = loadCommittedSeedStore();
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
        async () =>
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
      const unconfiguredTask = (
        await getTaskWorkflowRepository().listAllTasksUnfiltered(
          testTenantCtx(carys.id),
        )
      ).find(
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
          await getPartyRepository().putPerson(testTenantCtx(carys.id), p);
        }
      }

      const { id: _omittedBaseId, ...staffMatterTemplate } = baseMatter;
      void _omittedBaseId;
      const staffReferredRes = await runWithActiveActorSession(
        actorSession,
        async () =>
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
      const staffTask = (
        await getTaskWorkflowRepository().listAllTasksUnfiltered(
          testTenantCtx(carys.id),
        )
      ).find((t) =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R152: getAppSnapshot and server endpoints filter out staff and ethical-wall matters, linked tasks, links, notes, audit, and PMS rows for non-participants and block tampered matter IDs', async () => {
    try {
      const store = loadCommittedSeedStore();
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

      const { id: _omittedId, ...rawMatterTemplate } = baseMatter;
      void _omittedId;
      const matterTemplate = {
        ...rawMatterTemplate,
        conflictCheckRecord: rawMatterTemplate.conflictCheckRecord ?? {
          status: 'Cleared' as const,
          outcomeLabel: 'Cleared by fee earner' as const,
          declarationConfirmed: true,
          reviewerMessage: '',
          lastRunAtDisplay: '19 Nov 2026',
          lastRunById: carys.id,
          lastRunByName: 'Carys Hughes',
          submittedAtDisplay: '19 Nov 2026',
          submittedById: carys.id,
          submittedByName: 'Carys Hughes',
          approvedAtDisplay: null,
          approvedById: null,
          approvedByName: null,
          parties: [],
          matches: [],
          comments: [],
          runs: [],
        },
      };

      // Create a staff matter and an ethical-wall matter owned by Carys (outsiderFeeEarner is NOT a participant)
      const staffRes = await runWithActiveActorSession(carysSession, async () =>
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

      const wallRes = await runWithActiveActorSession(carysSession, async () =>
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
      const carysSnap = await runWithActiveActorSession(carysSession, async () =>
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

      const outsiderSnap = await runWithActiveActorSession(outsiderSession, async () =>
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
      for (const restrictedId of [staffMatterId, wallMatterId]) {
        expect(
          await runWithActiveActorSession(outsiderSession, async () =>
            listAuditEntriesForRecord('matter', restrictedId, outsiderFeeEarner.id),
          ),
        ).toEqual([]);
      }
      const outsiderFirmAudit = await runWithActiveActorSession(outsiderSession, async () =>
        listFirmAuditEntriesPage(outsiderFeeEarner.id, { limit: 2000 }),
      );
      expect(
        outsiderFirmAudit.entries.some(
          (a) => a.recordId === staffMatterId || a.recordId === wallMatterId,
        ),
      ).toBe(false);
      const outsiderRows = await runWithActiveActorSession(outsiderSession, () =>
        getMatterFinanceRows(outsiderFeeEarner.id),
      );
      expect(isActionDenied(outsiderRows)).toBe(false);
      if (!isActionDenied(outsiderRows)) {
        expect(
          outsiderRows.pmsSummaryByMatterId[staffMatterId],
        ).toBeUndefined();
        expect(
          outsiderRows.pmsSummaryByMatterId[wallMatterId],
        ).toBeUndefined();
      }

      // Direct PMS bundle lookup and tampered-ID actions by non-participant fail closed
      const outsiderPmsView = await runWithActiveActorSession(outsiderSession, () =>
        getMatterPmsViewBundle(staffMatterId, outsiderFeeEarner.id),
      );
      expect(isActionDenied(outsiderPmsView)).toBe(true);
      if (isActionDenied(outsiderPmsView)) {
        expect(outsiderPmsView.code).toBe('FORBIDDEN');
      }
      expect(
        (await runWithActiveActorSession(outsiderSession, async () =>
          markEngagementLetterDrafted(staffMatterId, outsiderFeeEarner.id),
        )).matter,
      ).toBeNull();
      expect(
        (await runWithActiveActorSession(outsiderSession, async () =>
          liftMatterRestriction(
            staffMatterId,
            'staff_matter',
            'Tampered ID attempt',
            outsiderFeeEarner.id,
          ),
        )).matter,
      ).toBeNull();
      const kdTampered = await runWithActiveActorSession(outsiderSession, async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R144: hiring a matter client via savePersonRecord while beforeMatterOpen is awaiting serialises concurrent matter saves without losing either write', async () => {
    try {
      const store = loadCommittedSeedStore();
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
      const draftRes = await runWithActiveActorSession(carysSession, async () =>
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
            conflictCheckRecord: {
              status: 'In progress',
              outcomeLabel: 'Pending',
              declarationConfirmed: false,
              reviewerMessage: '',
              lastRunAtDisplay: '19 Nov 2026',
              lastRunById: carys.id,
              lastRunByName: `${carys.firstName} ${carys.surname}`,
              submittedAtDisplay: null,
              submittedById: null,
              submittedByName: null,
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
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
      let hireHookEnteredResolve: (() => void) | null = null;
      const hireHookEntered = new Promise<void>((resolve) => {
        hireHookEnteredResolve = resolve;
      });
      let releaseHireHookFn: (() => void) | null = null;
      const releaseHireHook = () => {
        const fn = releaseHireHookFn;
        releaseHireHookFn = null;
        fn?.();
      };
      getPlatformExtensionHost().registerExtension({
        manifest: {
          id: 'nalf-slow-hire-race-ext',
          name: 'Slow Hire Race Extension',
          version: '1.0.0',
          description: 'Waits for concurrent hire latch during beforeMatterOpen for client hire race',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['matter:open:gate'],
          hooks: ['beforeMatterOpen'],
        },
        hooks: {
          beforeMatterOpen: async () => {
            const releasePromise = new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              releaseHireHookFn = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            hireHookEnteredResolve?.();
            await releasePromise;
            return {
              allowProceed: true,
              requiresPartnerSignOff: false,
              governanceWarnings: [],
            };
          },
        },
      });
      const hireRaceSavePromise = runWithActiveActorSession(carysSession, async () =>
        saveMatterRecord(
          {
            ...draftMatter,
            title: 'R144 Concurrent Client Hire Matter Opened',
          },
          { id: draftMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      // Wait until the save is inside the hook rather than a fixed delay
      await hireHookEntered;
      const hireRes = await runAsTestActor('P-000004', () =>
        savePersonRecord(
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
            mfaVerified: true,
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
        ),
      );
      expect(hireRes.errors).toBeUndefined();
      expect(hireRes.person?.isEmployee).toBe(true);
      releaseHireHook();
      // Hiring the client updates the matter's staff-matter restriction metadata in PostgreSQL
      // (incrementing row_version), so the in-flight saveMatterRecord fails optimistic concurrency
      // control with MATTER_CONCURRENCY_CONFLICT and isStaffMatter remains true.
      const hireRaceSaveRes = await hireRaceSavePromise;
      expect(hireRaceSaveRes.matter).toBeNull();
      expect(hireRaceSaveRes.errors?.conflict).toMatch(
        /changed by someone else while you were saving/i,
      );
      const finalDraftMatter = (await getMatterRepository().getMatterById(
        testTenantCtx(draftMatter.responsiblePartnerId || carys.id),
        draftMatter.id,
      ))!;
      expect(finalDraftMatter.title).toBe('R144 Concurrent Client Hire Matter');
      expect(finalDraftMatter.isStaffMatter).toBe(true);
    } finally {
      setActiveTenantConfigForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('rejects a save based on a stale row_version (S0-16)', async () => {
    try {
      const store = loadCommittedSeedStore();
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

      const initialRowVersion = baseMatter.rowVersion ?? 1;

      // Save 1 succeeds and increments rowVersion
      const save1Res = await runWithActiveActorSession(carysSession, async () =>
        saveMatterRecord(
          {
            ...baseMatter,
            title: 'R448 Save 1 Updated Title',
          },
          {
            id: baseMatter.id,
            byId: carys.id,
            expectedRowVersion: initialRowVersion,
          },
        ),
      );
      expect(save1Res.errors).toBeUndefined();
      expect(save1Res.matter).not.toBeNull();
      expect(save1Res.matter!.rowVersion).toBe(initialRowVersion + 1);

      // Save 2 with stale initialRowVersion is rejected with both code and message
      const staleSaveRes = await runWithActiveActorSession(
        carysSession,
        async () =>
          saveMatterRecord(
            {
              ...baseMatter,
              title: 'R448 Stale Save Should Fail',
            },
            {
              id: baseMatter.id,
              byId: carys.id,
              expectedRowVersion: initialRowVersion,
            },
          ),
      );
      expect(staleSaveRes.matter).toBeNull();
      expect(staleSaveRes).toMatchObject({
        code: 'MATTER_CONCURRENCY_CONFLICT',
        message: expect.stringMatching(/MATTER_CONCURRENCY_CONFLICT:.*changed by someone else/i),
      });
      expect(staleSaveRes.errors?.conflict).toMatch(
        /MATTER_CONCURRENCY_CONFLICT:.*changed by someone else/i,
      );

      // Verify the winning title from Save 1 remains intact
      const afterStale = (await getMatterRepository().getMatterById(
        testTenantCtx(carys.id),
        baseMatter.id,
      ))!;
      expect(afterStale.title).toBe('R448 Save 1 Updated Title');
      expect(afterStale.rowVersion).toBe(initialRowVersion + 1);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R153: updateMatterConflictRecord enforces risk:view, never opens a draft matter, never satisfies partnerSignOffCompleted via Cleared, and preserves stored comments and server timestamps', async () => {
    try {
      const store = loadCommittedSeedStore();
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
      const draftRes = await runWithActiveActorSession(carysSession, async () =>
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
      const unauthorizedApprove = await runWithActiveActorSession(feSession, async () =>
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
      const feClearedRes = await runWithActiveActorSession(feSession, async () =>
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
        async () =>
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
      const authorizedApprove = await runWithActiveActorSession(carysSession, async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R159: lifting staff_matter restriction persists across subsequent saveMatterRecord calls and re-applies when a new working employee participant is added', async () => {
    try {
      const store = loadCommittedSeedStore();
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

      const { id: _omittedId, ...rawMatterTemplate } = baseMatter;
      void _omittedId;
      const matterTemplate = {
        ...rawMatterTemplate,
        conflictCheckRecord: rawMatterTemplate.conflictCheckRecord ?? {
          status: 'Cleared' as const,
          outcomeLabel: 'Cleared by fee earner' as const,
          declarationConfirmed: true,
          reviewerMessage: '',
          lastRunAtDisplay: '19 Nov 2026',
          lastRunById: carys.id,
          lastRunByName: 'Carys Hughes',
          submittedAtDisplay: '19 Nov 2026',
          submittedById: carys.id,
          submittedByName: 'Carys Hughes',
          approvedAtDisplay: null,
          approvedById: null,
          approvedByName: null,
          parties: [],
          matches: [],
          comments: [],
          runs: [],
        },
      };
      const staffMatterRes = await runWithActiveActorSession(carysSession, async () =>
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

      const liftedRes = await runWithActiveActorSession(carysSession, async () =>
        liftMatterRestriction(
          staffMatter.id,
          'staff_matter',
          'Approved lift for R159 test',
          carys.id,
        ),
      );
      expect(liftedRes.matter?.isStaffMatter).toBe(false);

      const resaveSameEmp = await runWithActiveActorSession(carysSession, async () =>
        saveMatterRecord(
          {
            ...liftedRes.matter!,
            title: 'R159 Staff Matter After Lift Resave',
          },
          { id: staffMatter.id, byId: carys.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(resaveSameEmp.matter?.isStaffMatter).toBe(false);

      const resaveNewEmp = await runWithActiveActorSession(carysSession, async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R108: bad manifest JSON or unregistered enabled extensions record declaredHooks: null and block submit_cleared', async () => {
    try {
      const store = loadCommittedSeedStore();
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

        const blockedRes = await runWithActiveActorSession(carysSession, async () =>
          saveMatterRecord(
            {
              ...baseMatter,
              conflictCheckRecord: {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: carys.id,
                lastRunByName: `${carys.firstName} ${carys.surname}`,
                submittedAtDisplay: '19 Nov 2026',
                submittedById: carys.id,
                submittedByName: `${carys.firstName} ${carys.surname}`,
                approvedAtDisplay: '19 Nov 2026',
                approvedById: carys.id,
                approvedByName: `${carys.firstName} ${carys.surname}`,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R155: PostgreSQL party repository preserves multi-role assignments in order for risk and compliance officers', async () => {
    try {
      const store = loadCommittedSeedStore();
      const multiRolePerson = store.people.find((p) => p.id === 'P-000009')!;
      multiRolePerson.roles = ['risk_compliance', 'partner', 'fee_earner'];
      await getPartyRepository().putPerson(
        testTenantCtx('P-000001'),
        multiRolePerson,
      );
      const reloadedPerson = (await getPartyRepository().getPersonById<typeof multiRolePerson>(
        testTenantCtx('P-000001'),
        'P-000009',
      ))!;
      expect(reloadedPerson.roles).toEqual([
        'risk_compliance',
        'partner',
        'fee_earner',
      ]);
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
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

  it('R161: conflictReview and firm schemas enforce parity and migration rollback checks CORE_TENANT_MIGRATIONS', async () => {
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
    await migRunner.applyUp(syncCtx, CORE_TENANT_MIGRATIONS);
    await expect(
      migRunner.rollbackVersion(syncCtx, '0003', [
        DOCUMENT_GENERATION_MIGRATION_0001,
        DOCUMENT_STORE_INTEGRATION_MIGRATION_0002,
        KEY_DATES_MIGRATION_0003,
      ]),
    ).rejects.toThrow(/MIGRATION_ROLLBACK_ORDER_ERROR/);
  });

  it('R162: conflict search returns a redacted match on restricted matters and saveMatterRecord refuses submit_cleared', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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

      const { id: _omittedId, ...rawMatterTemplate } = baseMatter;
      void _omittedId;
      const matterTemplate = {
        ...rawMatterTemplate,
        conflictCheckRecord: rawMatterTemplate.conflictCheckRecord ?? {
          status: 'Cleared' as const,
          outcomeLabel: 'Cleared by fee earner' as const,
          declarationConfirmed: true,
          reviewerMessage: '',
          lastRunAtDisplay: '19 Nov 2026',
          lastRunById: carys.id,
          lastRunByName: 'Carys Hughes',
          submittedAtDisplay: '19 Nov 2026',
          submittedById: carys.id,
          submittedByName: 'Carys Hughes',
          approvedAtDisplay: null,
          approvedById: null,
          approvedByName: null,
          parties: [],
          matches: [],
          comments: [],
          runs: [],
        },
      };

      // Carys opens a restricted staff matter where staffClient is the client and feeEarner is NOT a participant
      const staffRes = await runWithActiveActorSession(carysSession, async () =>
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
      const searchResult = await runWithActiveActorSession(feSession, async () =>
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
      const clearedAttempt = await runWithActiveActorSession(feSession, async () =>
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
      const referredAttempt = await runWithActiveActorSession(feSession, async () =>
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
      const riskApproveRes = await runWithActiveActorSession(carysSession, async () =>
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
      const secondStaffRes = await runWithActiveActorSession(carysSession, async () =>
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
        async () =>
          saveMatterRecord(
            {
              ...riskApproveRes.matter!,
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R164: conflictReview.assigneeTeamKey matches strictly by team ID or org team code, never by display name', async () => {
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      // Configure a schema-valid display name as assigneeTeamKey and null assigneeRoleKey so no role fallback rescues it
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        conflictReview: {
          assigneeTeamKey: 'RiskComplianceDisplayName',
          assigneeRoleKey: null,
        },
      });
      const store = loadCommittedSeedStore();
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

      const result = await runWithActiveActorSession(feSession, async () =>
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
      const createdTask = (
        await getTaskWorkflowRepository().listAllTasksUnfiltered(
          testTenantCtx(feeEarner.id),
        )
      ).find(
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
      await resetAllDemoData('P-000001', testDataResetContext());
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

  it('R166: getDefaultTenantRbacConfig rejects mismatched tenantId with TENANT_MISMATCH', () => {
    expect(() => getDefaultTenantRbacConfig('other-tenant')).toThrow(
      /TENANT_MISMATCH/,
    );
  });

  it('R167: billing and credit-control actions leave unassigned when matter has no leadFeeEarnerId or responsiblePartnerId, and getStore does not overwrite firm when demo mode is off', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const prevDemoMode = process.env.ONESQUARED_DEMO_MODE;
    try {
      const store = loadCommittedSeedStore();
      const targetMatter = store.matters.find((m) => m.id === 'M-000013')!;
      targetMatter.leadFeeEarnerId = null;
      targetMatter.responsiblePartnerId = null;
      targetMatter.supervisingPartnerId = null;
      await getMatterRepository().putMatter(
        testTenantCtx('P-000001'),
        targetMatter,
        { expectedRowVersion: null },
      );

      const billRes = await runAsTestActor('P-000001', () =>
        requestMatterBill(targetMatter.matterNumber, 'P-000001'),
      );
      expect(isActionDenied(billRes)).toBe(false);
      if (!isActionDenied(billRes)) {
        expect(billRes.ok).toBe(true);
        const billingTask = await getTaskWorkflowRepository().getTaskById(
          testTenantCtx('P-000001'),
          billRes.taskId!,
          { includeRestricted: true },
        );
        expect(billingTask).toBeDefined();
        expect(billingTask?.assignedPersonId).toBeNull();
      }

      const writeOffRes = await runAsTestActor('P-000001', () =>
        flagMatterWriteOff(targetMatter.matterNumber, 1500, 'P-000001'),
      );
      expect(isActionDenied(writeOffRes)).toBe(false);
      if (!isActionDenied(writeOffRes)) {
        expect(writeOffRes.ok).toBe(true);
        const signOff = await getTaskWorkflowRepository().getSignOffById(
          testTenantCtx('P-000001'),
          writeOffRes.signOffId!,
          { includeRestricted: true },
        );
        expect(signOff).toBeDefined();
        expect(signOff?.assignedPartnerId).toBeNull();
      }

      const ccRes = await runAsTestActor('P-000001', () =>
        recordInvoiceCreditControlAction(
          {
            invoiceNumber: 'PV/2026/0040',
            matterCode: targetMatter.matterNumber,
            clientCode: 'HAR001',
            actionType: 'escalate',
            note: 'Escalating overdue invoice without fallback partner ID',
          },
          'P-000001',
        ),
      );
      expect(isActionDenied(ccRes)).toBe(false);
      if (!isActionDenied(ccRes)) {
        expect(ccRes.ok).toBe(true);
        const ccTask = await getTaskWorkflowRepository().getTaskById(
          testTenantCtx('P-000001'),
          ccRes.taskId!,
          { includeRestricted: true },
        );
        expect(ccTask).toBeDefined();
        expect(ccTask?.assignedPersonId).toBeNull();
      }

      // Verify firm profile in PostgreSQL is not overwritten with demo FIRM when demo mode is disabled
      await getCatalogueRepository().putFirmProfile(testTenantCtx('P-000001'), {
        firmId: store.firmId,
        isCleanDeployment: false,
        firm: {
          ...store.firm,
          name: 'Custom Non-Demo Firm Name LLP',
        },
      });
      process.env.ONESQUARED_DEMO_MODE = 'false';
      const reloadedProfile = await getCatalogueRepository().getFirmProfile(
        testTenantCtx('P-000001'),
      );
      expect(reloadedProfile?.firm.name).toBe('Custom Non-Demo Firm Name LLP');
    } finally {
      if (prevDemoMode === undefined) {
        delete process.env.ONESQUARED_DEMO_MODE;
      } else {
        process.env.ONESQUARED_DEMO_MODE = prevDemoMode;
      }
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R168: buildDefaultOrgStructure requires options.legalName and derives entity codes from shortCode or cleaned legalName', async () => {
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

    const store = loadCommittedSeedStore();
    const snap = await runAsTestActor('P-000001', () => getAppSnapshot('P-000001'));
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
    await resetAllDemoData('P-000001', testDataResetContext());
    const r169AuditMark = await markAuditPosition();
    try {
      const store = loadCommittedSeedStore();
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
            conflictCheckRecord: {
              status: 'In progress',
              outcomeLabel: 'Pending',
              declarationConfirmed: false,
              reviewerMessage: '',
              lastRunAtDisplay: '19 Nov 2026',
              lastRunById: feeEarner.id,
              lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
              submittedAtDisplay: null,
              submittedById: null,
              submittedByName: null,
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
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
          async () =>
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
          (await auditEntriesForRecord('matter', matterId, r169AuditMark)).some(
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R170: searchMatterConflicts redacts matches on restricted enquiries (converted to a staff matter or another user personal Draft)', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
      const partnerCtx = testTenantCtx(partner.id);
      const baseEnquiry = (
        await getIntakeQuoteRepository().listAllEnquiriesUnfiltered(partnerCtx)
      )[0]!;

      // Create a restricted staff matter invisible to feeEarner
      const r170StaffMatter = {
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
      };
      await getMatterRepository().putMatter(
        partnerCtx,
        r170StaffMatter,
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [partner.id] },
      );

      // Create an enquiry converted into that restricted staff matter and a personal Draft enquiry belonging to partner
      await getIntakeQuoteRepository().putEnquiries(partnerCtx, [
        {
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
          createdAt: new Date().toISOString(),
          takenById: partner.id,
        },
        {
          ...structuredClone(baseEnquiry),
          id: 'ENQ-R170-DRAFT',
          reference: 'ENQ-R170-DRAFT',
          status: 'Draft',
          firstName: 'DraftOnly',
          lastName: 'PrivateEnquirer',
          summary: 'Unpublished personal draft enquiry',
          convertedMatterId: null,
          createdById: partner.id,
          createdAt: new Date().toISOString(),
          takenById: partner.id,
        },
      ]);

      const res = await runAsTestActor(feeEarner.id, () =>
        runMatterConflictSearchRecord(
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
        ),
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R172: runMatterConflictSearchRecord logs count-only restricted conflict match audit entries and structured logs with no party or record names', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
      const partnerCtx = testTenantCtx(partner.id);
      const baseEnquiry = (
        await getIntakeQuoteRepository().listAllEnquiriesUnfiltered(partnerCtx)
      )[0]!;

      await getIntakeQuoteRepository().putEnquiry(partnerCtx, {
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R172-DRAFT',
        reference: 'ENQ-R172-DRAFT',
        status: 'Draft',
        firstName: 'SecretDraft',
        lastName: 'CallerName',
        summary: 'Sensitive draft enquiry summary',
        convertedMatterId: null,
        createdById: partner.id,
        createdAt: new Date().toISOString(),
        takenById: partner.id,
      });

      const r172AuditMark = await markAuditPosition();
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        // 1. Unsaved matter (currentMatterId: null) writes the structured log only, not store.audit
        const unsavedRes = await runAsTestActor(feeEarner.id, () =>
          runMatterConflictSearchRecord(
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
          ),
        );
        expect(unsavedRes.errors).toBeUndefined();
        expect(unsavedRes.matches.some((m) => m.restricted)).toBe(true);
        expect(await auditEntriesSince(r172AuditMark)).toHaveLength(0);

        // 2. Saved matter (currentMatterId: 'M-000001') writes both the count-only audit entry and structured log
        const res = await runAsTestActor(feeEarner.id, () =>
          runMatterConflictSearchRecord(
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
          ),
        );
        expect(res.errors).toBeUndefined();
        expect(res.matches.some((m) => m.restricted)).toBe(true);

        const r172NewAudit = await auditEntriesSince(r172AuditMark);
        expect(r172NewAudit).toHaveLength(1);
        const latestAudit = r172NewAudit[0]!;
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R173: saveMatterRecord runs beforeMatterOpen on every non-draft save until the matter has opened, and updateMatterConflictRecord keeps referred matters Prospective until partner cost sign-off', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
        async () =>
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
        async () =>
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
        async () =>
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
        async () =>
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

      const riskApproveBeforeSignOff = await runWithActiveActorSession(
        riskSession,
        async () =>
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
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R174: getAppSnapshot conflict reviewer resolution uses stable team id/code and configured assigneeRoleKey without matching team display names or hard-coding risk_compliance', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = loadCommittedSeedStore();
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      const nonRiskEmployee = store.people.find(
        (p) =>
          p.isEmployee &&
          p.id !== partner.id &&
          p.employeeRoleId !== 'employee_role.risk_and_compliance' &&
          !(p.roles ?? []).includes('risk_compliance'),
      )!;

      // 1. Team whose display name (not id or code) equals assigneeTeamKey is NOT picked
      const nameOnlyTeam = {
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
      };
      store.teams.push(nameOnlyTeam);
      await getHrAndRbacRepository().putTeam(
        testTenantCtx(partner.id),
        nameOnlyTeam,
      );

      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeTeamKey: 'custom-team-key-by-name',
        },
      });
      const snapByName = await runAsTestActor(partner.id, () =>
        getAppSnapshot(partner.id),
      );
      expect(
        snapByName.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBeNull();

      // 2. Custom assigneeRoleKey selects a holder of that role, not a holder of risk_compliance (and R180d: scopes to assigneeTeamKey when configured)
      nonRiskEmployee.employeeRoleId = 'employee_role.custom_conflict_reviewer';
      await getPartyRepository().putPerson(
        testTenantCtx(partner.id),
        nonRiskEmployee,
      );
      const emptyCustomTeamId = 'TM-R174-EMPTY-TEAM';
      const emptyCustomTeam = {
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
      };
      store.teams.push(emptyCustomTeam);
      await getHrAndRbacRepository().putTeam(
        testTenantCtx(partner.id),
        emptyCustomTeam,
      );
      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeTeamKey: emptyCustomTeamId,
          assigneeRoleKey: 'employee_role.custom_conflict_reviewer',
        },
      });
      const snapRoleOutsideTeam = await runAsTestActor(partner.id, () =>
        getAppSnapshot(partner.id),
      );
      expect(
        snapRoleOutsideTeam.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBeNull();

      setActiveTenantConfigForTesting({
        ...originalRawBase,
        conflictReview: {
          assigneeRoleKey: 'employee_role.custom_conflict_reviewer',
        },
      });
      const snapCustomRole = await runAsTestActor(partner.id, () =>
        getAppSnapshot(partner.id),
      );
      expect(
        snapCustomRole.suggestedMatterGovernanceAssignees.riskReviewerId,
      ).toBe(nonRiskEmployee.id);
    } finally {
      setActiveTenantConfigForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R175: user with risk:view (and matter:create/edit) but without matter:restricted:access cannot submit_cleared on an unapproved restricted match unless recording status Approved', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = loadCommittedSeedStore();
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
      const r175StaffMatter = {
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
            entityType: 'organisation' as const,
            role: 'Opponent',
            relationshipCode: 'OP',
            capacityCodes: ['CAP_DEFENDANT'],
            alignment: 'adverse' as const,
            linkedRecordId: null,
          },
        ],
      };
      await getMatterRepository().putMatter(
        testTenantCtx(partner.id),
        r175StaffMatter,
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [partner.id] },
      );

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
      await getHrAndRbacRepository().putRbacConfigOverride(
        testTenantCtx(partner.id),
        {
          ...currentRbac,
          roles: customRoles,
        },
      );
      customReviewer.roles = ['junior_risk_reviewer' as never];
      await getPartyRepository().putPerson(
        testTenantCtx(partner.id),
        customReviewer,
      );

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
        async () =>
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
        async () =>
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
      setActiveTenantConfigForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R176: saveMatterRecord builds ConflictCheckRecord on the server, preserving stored comments and runs and rejecting forged risk approvals', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
        async () =>
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
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
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

    const store = loadCommittedSeedStore();
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
    await resetAllDemoData('P-000001', testDataResetContext());
    const originalRawBase = getActiveTenantRawBaseConfig();
    try {
      const store = loadCommittedSeedStore();
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
        async () =>
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

      const referRes = await runWithActiveActorSession(feeEarnerSession, async () =>
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
        async () =>
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

      const riskApproveAfterDraft = await runWithActiveActorSession(
        riskSession,
        async () =>
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
          async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R179: saveMatterRecord, updateMatterConflictRecord, and signOffMatterCostsRecord enforce evaluateMatterKeyDateOpeningGate when requiredKeyDateTypeIds are configured', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
      const r179ClearedConflict = {
        status: 'Cleared' as const,
        outcomeLabel: 'Cleared by fee earner' as const,
        declarationConfirmed: true,
        reviewerMessage: '',
        lastRunAtDisplay: '19 Nov 2026',
        lastRunById: partner.id,
        lastRunByName: `${partner.firstName} ${partner.surname}`,
        submittedAtDisplay: '19 Nov 2026',
        submittedById: partner.id,
        submittedByName: `${partner.firstName} ${partner.surname}`,
        approvedAtDisplay: null,
        approvedById: null,
        approvedByName: null,
        parties: [],
        matches: [],
        comments: [],
        runs: [],
      };
      const fixtureM8OpenWithoutKd = await runWithActiveActorSession(
        partnerSession,
        async () =>
          saveMatterRecord(
            {
              ...fixtureM8,
              matterTypeId: 'matter_type.litigation',
              conflictCheckRecord: r179ClearedConflict,
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
        async () =>
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
              conflictCheckRecord: r179ClearedConflict,
            },
            { byId: partner.id, saveMode: 'submit_cleared' },
          ),
      );
      expect(newOpenWithoutKd.matter).toBeNull();
      expect(newOpenWithoutKd.errors?.keyDates).toMatch(
        /Save the matter as a draft and add its required key dates before opening/i,
      );

      // 2. Saving as a draft succeeds; attempting to open the saved draft without the required key date is refused with errors.keyDates
      const draftRes = await runWithActiveActorSession(partnerSession, async () =>
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
            conflictCheckRecord: {
              ...r179ClearedConflict,
              status: 'In progress',
              outcomeLabel: 'Pending',
              declarationConfirmed: false,
            },
          },
          { byId: partner.id, saveMode: 'draft' },
        ),
      );
      expect(draftRes.errors).toBeUndefined();
      const draftId = draftRes.matter!.id;

      const draftOpenWithoutKd = await runWithActiveActorSession(
        partnerSession,
        async () =>
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
      const riskApproveWithoutKd = await runWithActiveActorSession(riskSession, async () =>
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
      const naRes = await runWithActiveActorSession(partnerSession, () =>
        recordKeyDateNotApplicableRecord(
          {
            matterId: draftId,
            keyDateTypeId: 'limitation',
            reason:
              'Declaratory relief only; statutory limitation period does not apply.',
          },
          partner.id,
        ),
      );
      expect(naRes.ok).toBe(true);
      expect(naRes.error).toBeUndefined();

      const openWithKdRes = await runWithActiveActorSession(
        partnerSession,
        async () =>
          saveMatterRecord(
            {
              ...riskApproveWithoutKd.matter!,
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R181: saveMatterRecord enforces conflict-decision and opening gate on status transition out of Prospective, allows stage edits while Prospective, and saveMatterAction filters opts', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
      const partnerCtx = testTenantCtx(partner.id);
      const baseEnquiry = (
        await getIntakeQuoteRepository().listAllEnquiriesUnfiltered(partnerCtx)
      )[0]!;
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
      await getIntakeQuoteRepository().putEnquiry(partnerCtx, {
        ...structuredClone(baseEnquiry),
        id: 'ENQ-R181-RESTRICTED',
        reference: 'ENQ-R181-RESTRICTED',
        status: 'Draft',
        firstName: 'Restricted',
        lastName: 'CounterpartyR181',
        summary: 'Private draft enquiry belonging to partner',
        convertedMatterId: null,
        createdById: partner.id,
        createdAt: new Date().toISOString(),
        takenById: partner.id,
      });

      // 1. Refer a matter with a restricted match, then attempt to open it by setting matterStatusId: Active with no saveMode
      const referredRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
        async () =>
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
        (
          await getMatterRepository().getMatterById(
            testTenantCtx(partner.id),
            referredId,
          )
        )?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 2. Edit while waiting for Risk: a referred matter above the £50,000 sign-off threshold with no sign-off allows a stage change (no saveMode) while keeping the matter Prospective and matterOpeningGate.allowProceed === false
      const highEstimateDraftRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
        async () =>
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
        async () =>
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
      const pmsImportAuditMark = await markAuditPosition();
      const pmsImportRes = await runWithActiveActorSession(
        partnerSession,
        async () =>
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
        (await auditEntriesSince(pmsImportAuditMark)).some(
          (a) =>
            a.recordId === pmsImportRes.matter?.id &&
            a.action === 'matter-imported-open',
        ),
      ).toBe(true);
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R183: existing open matters without an opening snapshot can be edited and closed without triggering the opening gate, and backfill matterOpeningSnapshot with saveMode backfilled', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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
      const m3StageRes = await runWithActiveActorSession(partnerSession, async () =>
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

      const m1StageRes = await runWithActiveActorSession(partnerSession, async () =>
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
      const kdRes = await runWithActiveActorSession(partnerSession, () =>
        createOrProposeKeyDateRecord(
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
        ),
      );
      expect(kdRes.ok).toBe(true);

      const closeBlockedByKd = await runWithActiveActorSession(
        partnerSession,
        async () =>
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

      // Resolve the open key date(s) (key dates are never deleted) and verify M-000003 closes cleanly despite £145,000 fee estimate without partner sign-off
      const r183KdCtx = testTenantCtx(partner.id);
      for (const kd of await getKeyDateRepository().listKeyDatesForMatter(
        r183KdCtx,
        fixtureM3.id,
      )) {
        await getKeyDateRepository().putKeyDate(r183KdCtx, { ...kd, status: 'met' });
      }
      const closeSuccessRes = await runWithActiveActorSession(
        partnerSession,
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R184: legacy escalated conflict status maps to Referred with no fabricated approver, and once referred only Risk & Compliance can clear or approve a matter', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
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

      // 1. resolveMatterConflictCheckRecord for M-000006 (and legacy 'Potential conflict — escalated' with no conflictCheckRecord) returns status: 'Referred' and null approvedById
      const resolvedM6Record = resolveMatterConflictCheckRecord(
        { ...fixtureM6, conflictCheckRecord: undefined },
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
        async () =>
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
        loadCommittedSeedStore().matters.find((m) => m.id === fixtureM6.id)?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 3. Refer a new matter as feeEarner, then attempt submit_cleared with status: 'Cleared' as feeEarner -> refused with errors.conflict and stays Referred & Prospective
      const referNewRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
        async () =>
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
      const storedAfterSelfClear = (await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
        testTenantCtx(partner.id),
        referredMatterId,
      ))!;
      expect(storedAfterSelfClear.conflictCheckRecord?.status).toBe('Referred');
      expect(storedAfterSelfClear.matterStatusId).toBe(prospectiveStatusId);

      // Also verify updateMatterConflictRecord refuses status: 'Cleared' by a non-Risk caller on a referred matter
      const updateSelfClearRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
      const riskApproveRes = await runWithActiveActorSession(riskSession, async () =>
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
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R185: saveMatterRecord ignores conflictCheckRecord: null and caller conflictCheckStatus, preserves Referred status across two-save bypass attempts, and derives conflictCheckStatus from the server record', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
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

      const store = loadCommittedSeedStore();
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

      // 1. Legacy matter M-000006: simulate a legacy record without conflictCheckRecord; Save 1 with no saveMode, conflictCheckRecord: null, and conflictCheckStatus: 'Clear' keeps stored record Referred and conflictCheckStatus as 'Pending conflict review'; Save 2 (submit_cleared) is refused with errors.conflict
      const fixtureM6 = store.matters.find((m) => m.id === 'M-000006')!;
      expect(fixtureM6.conflictCheckRecord?.status).toBe('Referred');
      expect(fixtureM6.conflictCheckStatus).toBe(
        'Potential conflict — escalated',
      );
      delete fixtureM6.conflictCheckRecord;
      const savedFixtureM6 = await getMatterRepository().putMatter(
        testTenantCtx(partner.id),
        fixtureM6,
        { expectedRowVersion: null },
      );
      fixtureM6.rowVersion = savedFixtureM6.rowVersion;

      const m6Save1Res = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
        async () =>
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
        (
          await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
            testTenantCtx(partner.id),
            fixtureM6.id,
          )
        )?.conflictCheckRecord?.status,
      ).toBe('Referred');

      // 2. Newly referred matter: two-save bypass attempt (conflictCheckRecord: null + conflictCheckStatus: 'Clear', then submit_cleared) is refused
      const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
      const referNewRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
        async () =>
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
        async () =>
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
        async () =>
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
        async () =>
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
        (
          await getMatterRepository().getMatterById(
            testTenantCtx(partner.id),
            referredId,
          )
        )?.matterStatusId,
      ).toBe(prospectiveStatusId);

      // 4. After a Risk user records Approved through updateMatterConflictRecord, matter.conflictCheckStatus is set to match, and the fee earner can then open the matter
      const riskApproveWithConditions = await runWithActiveActorSession(
        riskSession,
        async () =>
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
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R186: an open matter cannot be moved back to Prospective or saved as a draft, and submit_referred + Risk approval preserve open status and matterOpeningSnapshot', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const store = loadCommittedSeedStore();
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
          loadCommittedSeedStore().matters.find((m) => m.id === openMatterId)!,
        );
        expect(fixtureOpen).toBeDefined();
        expect(fixtureOpen.matterStatusId).toBe(activeStatusId);
        const originalMatterNumber = fixtureOpen.matterNumber;

        // (a) draft save on an open matter is refused and leaves the matter Active
        const draftSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          async () =>
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
        const afterDraftAttempt = loadCommittedSeedStore().matters.find(
          (m) => m.id === openMatterId,
        )!;
        expect(afterDraftAttempt.matterStatusId).toBe(activeStatusId);
        expect(afterDraftAttempt.matterNumber).toBe(originalMatterNumber);

        // (b) plain save with matterStatusId set to Prospective is refused and leaves the matter Active
        const prospectiveSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          async () =>
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
        const afterProspectiveAttempt = loadCommittedSeedStore().matters.find(
          (m) => m.id === openMatterId,
        )!;
        expect(afterProspectiveAttempt.matterStatusId).toBe(activeStatusId);
        expect(afterProspectiveAttempt.matterNumber).toBe(originalMatterNumber);

        // (c) submit_referred save on an open matter succeeds, records Referred, and keeps the matter Active
        const referSaveRes = await runWithActiveActorSession(
          feeEarnerSession,
          async () =>
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
        const riskApproveRes = await runWithActiveActorSession(riskSession, async () =>
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
      const templateOpen = loadCommittedSeedStore().matters.find(
        (m) => m.id === 'M-000001',
      )!;
      const newOpenedRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
              conflictCheckRecord: {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: feeEarner.id,
                lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
                submittedAtDisplay: '19 Nov 2026',
                submittedById: feeEarner.id,
                submittedByName: `${feeEarner.firstName} ${feeEarner.surname}`,
                approvedAtDisplay: null,
                approvedById: null,
                approvedByName: null,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
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
        async () =>
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
        async () =>
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
        async () =>
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

      const newRiskApproveRes = await runWithActiveActorSession(riskSession, async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R187: a fee earner cannot set an open matter conflict check back to In progress or Not started via saveMatterRecord or updateMatterConflictRecord, while submit_referred still records Referred and keeps the matter Active', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const store = loadCommittedSeedStore();
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
          loadCommittedSeedStore().matters.find((m) => m.id === openMatterId)!,
        );
        expect(fixtureOpen).toBeDefined();
        expect(fixtureOpen.matterStatusId).toBe(activeStatusId);

        // Save 1: plain save backfills conflictCheckRecord as Cleared
        const save1Res = await runWithActiveActorSession(
          feeEarnerSession,
          async () =>
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
          async () =>
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
          async () =>
            saveMatterRecord(
              {
                ...saveInProgressRes.matter!,
                conflictCheckRecord: {
                  ...saveInProgressRes.matter!.conflictCheckRecord!,
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
          const updateResetRes = await runWithActiveActorSession(
            feeEarnerSession,
            async () =>
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
          const storedAfterResetAttempt = (await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
            testTenantCtx(feeEarner.id),
            openMatterId,
          ))!;
          expect(storedAfterResetAttempt.conflictCheckRecord?.status).toBe(
            'Cleared',
          );
          expect(storedAfterResetAttempt.conflictCheckStatus).toBe('Clear');
        }

        // submit_referred on the open matter still gives Referred and keeps the matter Active
        const referRes = await runWithActiveActorSession(
          feeEarnerSession,
          async () =>
            saveMatterRecord(
              {
                ...saveNotStartedRes.matter!,
                conflictCheckRecord: {
                  ...saveNotStartedRes.matter!.conflictCheckRecord!,
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R189: buildServerConflictCheckRecord derives outcomeLabel from the final status for fee earners without risk:view', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const store = loadCommittedSeedStore();
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
        async () =>
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
              conflictCheckRecord: {
                status: 'In progress',
                outcomeLabel: 'Pending',
                declarationConfirmed: false,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: feeEarner.id,
                lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
                submittedAtDisplay: null,
                submittedById: null,
                submittedByName: null,
                approvedAtDisplay: null,
                approvedById: null,
                approvedByName: null,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
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
        async () =>
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
        async () =>
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
              conflictCheckRecord: {
                status: 'In progress',
                outcomeLabel: 'Pending',
                declarationConfirmed: false,
                reviewerMessage: '',
                lastRunAtDisplay: '19 Nov 2026',
                lastRunById: feeEarner.id,
                lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
                submittedAtDisplay: null,
                submittedById: null,
                submittedByName: null,
                approvedAtDisplay: null,
                approvedById: null,
                approvedByName: null,
                parties: [],
                matches: [],
                comments: [],
                runs: [],
              },
            },
            { byId: feeEarner.id, saveMode: 'draft' },
          ),
      );
      expect(referredMismatchRes.errors).toBeUndefined();
      const plainSaveReferredRes = await runWithActiveActorSession(
        feeEarnerSession,
        async () =>
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
      await resetAllDemoData('P-000001', testDataResetContext());
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
        certificateKeyVaultSecretRef: 'kv://kv-not-a-law-firm-dev/sp-cert',
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
        certificateKeyVaultSecretRef: 'kv://kv-fictional-chambers-uk-dev/sp-cert',
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
      const store = loadCommittedSeedStore();
      const namedPartner = store.people.find((p) => p.id === 'P-000005')!;
      const unnamedPartner = store.people.find((p) => p.id === 'P-000001')!;
      const unnamedFeeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const adminPerson = store.people.find((p) => p.id === 'P-000004')!;

      // Create an ethical-wall matter owned by namedPartner (P-000005) and explicitly clear restrictedAccessUserIds to []
      const baseMatter = store.matters.find((m) => m.id === 'M-000011')!;
      const { id: _omittedId, ...rawMatterTemplate } = baseMatter;
      void _omittedId;
      const matterTemplate = {
        ...rawMatterTemplate,
        conflictCheckRecord: rawMatterTemplate.conflictCheckRecord ?? {
          status: 'Cleared' as const,
          outcomeLabel: 'Cleared by fee earner' as const,
          declarationConfirmed: true,
          reviewerMessage: '',
          lastRunAtDisplay: '19 Nov 2026',
          lastRunById: namedPartner.id,
          lastRunByName: 'Named Partner',
          submittedAtDisplay: '19 Nov 2026',
          submittedById: namedPartner.id,
          submittedByName: 'Named Partner',
          approvedAtDisplay: null,
          approvedById: null,
          approvedByName: null,
          parties: [],
          matches: [],
          comments: [],
          runs: [],
        },
      };

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

      const wallSaveRes = await runWithActiveActorSession(namedSession, async () =>
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
      const wallMatter = structuredClone(wallSaveRes.matter!);
      // Force restrictedAccessUserIds to empty array (B12 condition: hasEthicalWall === true, isStaffMatter === false, restrictedAccessUserIds === [])
      wallMatter.isStaffMatter = false;
      wallMatter.hasEthicalWall = true;
      wallMatter.restrictedAccessUserIds = [];
      await getMatterRepository().putMatter(
        testTenantCtx(namedPartner.id),
        wallMatter,
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );

      // Create a key date and a sign-off linked to wallMatter
      await runWithActiveActorSession(namedSession, async () =>
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
      await getTaskWorkflowRepository().putSignOff(
        testTenantCtx(namedPartner.id),
        {
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
        },
      );

      // Revoke matter:restricted:access on adminPerson to test admin without matter:restricted:access
      adminPerson.permissionOverrides = {
        grant: [],
        revoke: ['matter:restricted:access'],
      };
      await getPartyRepository().putPerson(
        testTenantCtx(unnamedPartner.id),
        adminPerson,
      );

      for (const excludedActor of [unnamedPartner, unnamedFeeEarner, adminPerson]) {
        const snap = await runAsTestActor(excludedActor.id, () =>
          getAppSnapshot(excludedActor.id),
        );
        expect(snap.matters.some((m) => m.id === wallMatter.id)).toBe(false);
        expect(snap.searchIndex).toEqual([]);
        expect(
          snap.searchIndex.some(
            (doc) =>
              doc.id === wallMatter.id ||
              doc.title.includes('Empty Allowlist Ethical Wall'),
          ),
        ).toBe(false);
        expect(snap.keyDates.some((kd) => kd.matterId === wallMatter.id)).toBe(false);

        const diary = await runAsTestActor(excludedActor.id, () =>
          queryKeyDatesTeamDiaryRecord({}, excludedActor.id),
        );
        expect(diary.some((e) => e.matterId === wallMatter.id)).toBe(false);
      }

      // Reports also exclude the walled matter for an actor without matter:restricted:access
      const partnerExceptions = await runAsTestActor(unnamedPartner.id, () =>
        getKeyDateExceptionsReportRecord({}, unnamedPartner.id),
      );
      expect(
        partnerExceptions.some((ex) => ex.matterId === wallMatter.id),
      ).toBe(false);

      // Tampered matterId / signOffId attempts by unnamedPartner and unnamedFeeEarner are denied
      const tamperedPmsView = await runAsTestActor(unnamedPartner.id, () =>
        getMatterPmsViewBundle(wallMatter.id, unnamedPartner.id),
      );
      expect(isActionDenied(tamperedPmsView)).toBe(true);
      if (isActionDenied(tamperedPmsView)) {
        expect(tamperedPmsView.code).toBe('FORBIDDEN');
      }
      const tamperedSignOffApprove = await runAsTestActor(unnamedPartner.id, () =>
        approveSignOff('SO-WALLED-01', unnamedPartner.id),
      );
      expect(isActionDenied(tamperedSignOffApprove)).toBe(true);
      const tamperedSignOffId = await runAsTestActor(unnamedPartner.id, () =>
        approveSignOff('SO-NONEXISTENT-999', unnamedPartner.id),
      );
      expect(isActionDenied(tamperedSignOffId)).toBe(true);
      const tamperedDiscuss = await runAsTestActor(unnamedPartner.id, () =>
        discussSignOff('SO-WALLED-01', 'Probe', unnamedPartner.id),
      );
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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-04: an admin of tenant B cannot change tenant A lists, custom fields, teams, or PMS links via forged tenant claims or tampered record IDs', async () => {
    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const store = loadCommittedSeedStore();
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
      expect(
        (await getHrAndRbacRepository().getTeamById(testDataResetContext(), firstTeam.id))?.name,
      ).toBe(firstTeam.name);

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

      const teamsCountBefore = (
        await getHrAndRbacRepository().listAllTeams(testDataResetContext())
      ).length;
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
      expect(
        (await getHrAndRbacRepository().listAllTeams(testDataResetContext())).length,
      ).toBe(teamsCountBefore);

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
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-05: rejects forged tenant claims and tampered record IDs across all 20 S0-05 record actions (with positive Tenant A controls and data-layer cluster checks)', async () => {
    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const store = loadCommittedSeedStore();
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

      const tamperedIds = {
        task: 'TSK-TB-000501',
        matter: 'M-TB-000501',
        enquiry: 'ENQ-TB-000501',
        quote: 'Q-TB-000501',
        org: 'O-TB-000501',
        person: 'P-TB-000501',
        link: 'L-TB-000501',
      };

      // 1. Forged tenant claim is rejected at the action boundary across all 20 S0-05 actions (and takeTaskAction)
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

      const forgedCalls: Array<() => Promise<unknown>> = [
        () =>
          saveTaskAction({
            title: 'Cross-tenant task',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000001',
          }),
        () => takeTaskAction(tamperedIds.task),
        () => addTaskCommentAction(tamperedIds.task, 'Cross-tenant comment'),
        () =>
          saveEnquiryAction({ firstName: 'Cross', lastName: 'Tenant' }, { asDraft: true }),
        () => assignEnquiryAction(tamperedIds.enquiry, 'P-000001'),
        () =>
          logEnquiryContactAction(tamperedIds.enquiry, {
            method: 'Phone',
            outcome: 'Spoke',
            note: 'Cross-tenant',
          }),
        () =>
          sendEnquiryEmailAction(tamperedIds.enquiry, {
            to: 'test@notalawfirm.example',
            subject: 'Cross-tenant',
            bodyHtml: '<p>Test</p>',
            bodyText: 'Test',
          }),
        () =>
          closeEnquiryAction(tamperedIds.enquiry, {
            targetStatus: 'Declined',
            closeReasonId: 'enquiry_close_reason.conflict',
          }),
        () => reopenEnquiryAction(tamperedIds.enquiry),
        () =>
          saveQuoteAction({
            clientType: 'prospect',
            prospectName: 'Cross Tenant',
            practiceAreaId: 'work_type.real_estate_and_property',
            scope: 'Scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1000,
          }),
        () => markQuoteSentAction(tamperedIds.quote),
        () =>
          logQuoteFollowUpAction(tamperedIds.quote, {
            method: 'Phone',
            note: 'Cross-tenant',
            nextFollowUpDate: '2026-12-01',
          }),
        () =>
          reviseQuoteAction(tamperedIds.quote, {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1200,
            scope: 'Cross-tenant',
          }),
        () => recordQuoteOutcomeAction(tamperedIds.quote, { outcome: 'Accepted' }),
        () => saveOrganisationAction({ legalName: 'Cross-Tenant Org' }, { id: tamperedIds.org }),
        () =>
          saveLinkAction({
            id: tamperedIds.link,
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
        () => deleteLinkAction(tamperedIds.link),
        () => addNoteAction('matter', tamperedIds.matter, 'Cross-tenant note'),
        () => dismissDuplicateAction('person', tamperedIds.person, 'P-000001'),
        () => mergeRecordsAction('person', 'P-000001', tamperedIds.person),
        () => reassignLeaverOwnedRecordsAction(tamperedIds.person, 'P-000001'),
      ];
      expect(forgedCalls.length).toBe(21);
      for (const invokeForged of forgedCalls) {
        await expect(invokeForged()).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      }

      // 2. Within an authenticated Tenant A session, tampered/foreign record IDs are rejected with code === 'FORBIDDEN' and a specific not-found/access-denied message
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

      const s005Ctx = testTenantCtx('P-000001');
      const [
        initialTasks,
        initialEnquiries,
        initialQuotes,
        initialOrgs,
        initialLinks,
        initialNotes,
      ] = await Promise.all([
        getTaskWorkflowRepository().listAllTasksUnfiltered(s005Ctx),
        getIntakeQuoteRepository().listAllEnquiriesUnfiltered(s005Ctx),
        getIntakeQuoteRepository().listAllQuotesUnfiltered(s005Ctx),
        getPartyRepository().listAllOrganisations(s005Ctx),
        getPartyRepository().listAllLinks(s005Ctx),
        getPartyRepository().listAllNotes(s005Ctx),
      ]);
      const tasksBefore = initialTasks.length;
      const enquiriesBefore = initialEnquiries.length;
      const quotesBefore = initialQuotes.length;
      const orgsBefore = initialOrgs.length;
      const linksBefore = initialLinks.length;
      const notesBefore = initialNotes.length;
      const samplePracticeAreaId = initialQuotes[0]!.practiceAreaId;

      const expectTamperedForbidden = (res: unknown, expectedMessage: string) => {
        expect(isActionDenied(res)).toBe(true);
        if (isActionDenied(res)) {
          expect(res.code).toBe('FORBIDDEN');
          expect(res.message).toBe(expectedMessage);
        }
      };

      expectTamperedForbidden(
        await saveTaskAction({
          id: tamperedIds.task,
          title: 'Tampered task',
          dueAt: '2026-12-01',
          assignedPersonId: 'P-000001',
        }),
        'Task not found.',
      );
      expectTamperedForbidden(
        await saveTaskAction({
          title: 'Task linked to tampered matter',
          dueAt: '2026-12-01',
          assignedPersonId: 'P-000001',
          linkedRecords: [{ recordType: 'matter', recordId: tamperedIds.matter }],
        }),
        'Linked matter not found or access denied.',
      );
      expectTamperedForbidden(await takeTaskAction(tamperedIds.task), 'Task not found.');
      expectTamperedForbidden(
        await addTaskCommentAction(tamperedIds.task, 'Tampered comment'),
        'Task not found or access denied.',
      );

      expectTamperedForbidden(
        await saveEnquiryAction(
          { firstName: 'Tampered', lastName: 'Enquiry' },
          { id: tamperedIds.enquiry, asDraft: true },
        ),
        'Enquiry not found.',
      );
      expectTamperedForbidden(
        await assignEnquiryAction(tamperedIds.enquiry, 'P-000001'),
        'Enquiry not found.',
      );
      expectTamperedForbidden(
        await logEnquiryContactAction(tamperedIds.enquiry, {
          method: 'Phone',
          outcome: 'Spoke',
          note: 'Tampered',
        }),
        'Enquiry not found.',
      );
      expectTamperedForbidden(
        await sendEnquiryEmailAction(tamperedIds.enquiry, {
          to: 'test@notalawfirm.example',
          subject: 'Tampered',
          bodyHtml: '<p>Test</p>',
          bodyText: 'Test',
        }),
        'Enquiry not found.',
      );
      expectTamperedForbidden(
        await closeEnquiryAction(tamperedIds.enquiry, {
          targetStatus: 'Declined',
          closeReasonId: 'enquiry_close_reason.conflict',
        }),
        'Enquiry not found.',
      );
      expectTamperedForbidden(
        await reopenEnquiryAction(tamperedIds.enquiry),
        'Enquiry not found.',
      );

      expectTamperedForbidden(
        await saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'Tampered',
            practiceAreaId: samplePracticeAreaId,
            scope: 'Scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1000,
          },
          { id: tamperedIds.quote },
        ),
        'Quote not found.',
      );
      expectTamperedForbidden(await markQuoteSentAction(tamperedIds.quote), 'Quote not found.');
      expectTamperedForbidden(
        await logQuoteFollowUpAction(tamperedIds.quote, {
          method: 'Phone',
          note: 'Tampered',
          nextFollowUpDate: '2026-12-01',
        }),
        'Quote not found.',
      );
      expectTamperedForbidden(
        await reviseQuoteAction(tamperedIds.quote, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1200,
          scope: 'Tampered',
        }),
        'Quote not found.',
      );
      expectTamperedForbidden(
        await recordQuoteOutcomeAction(tamperedIds.quote, { outcome: 'Accepted' }),
        'Quote not found.',
      );

      expectTamperedForbidden(
        await saveOrganisationAction(
          { legalName: 'Tampered Org' },
          { id: tamperedIds.org },
        ),
        'Organisation not found.',
      );
      expectTamperedForbidden(
        await saveLinkAction({
          id: tamperedIds.link,
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
        `Organisation link "${tamperedIds.link}" not found.`,
      );
      expectTamperedForbidden(
        await deleteLinkAction(tamperedIds.link),
        `Organisation link "${tamperedIds.link}" not found.`,
      );
      expectTamperedForbidden(
        await addNoteAction('matter', tamperedIds.matter, 'Tampered note'),
        `Target matter "${tamperedIds.matter}" not found.`,
      );
      expectTamperedForbidden(
        await dismissDuplicateAction('person', tamperedIds.person, 'P-000001'),
        `Target person "${tamperedIds.person}" not found.`,
      );
      expectTamperedForbidden(
        await mergeRecordsAction('person', 'P-000001', tamperedIds.person),
        'Record not found for merge.',
      );
      expectTamperedForbidden(
        await reassignLeaverOwnedRecordsAction(tamperedIds.person, 'P-000001'),
        'Source person must be an existing leaver.',
      );

      expect(
        (await getTaskWorkflowRepository().listAllTasksUnfiltered(s005Ctx))
          .length,
      ).toBe(tasksBefore);
      expect(
        (await getIntakeQuoteRepository().listAllEnquiriesUnfiltered(s005Ctx))
          .length,
      ).toBe(enquiriesBefore);
      expect(
        (await getIntakeQuoteRepository().listAllQuotesUnfiltered(s005Ctx))
          .length,
      ).toBe(quotesBefore);
      expect(
        (await getPartyRepository().listAllOrganisations(s005Ctx)).length,
      ).toBe(orgsBefore);
      expect((await getPartyRepository().listAllLinks(s005Ctx)).length).toBe(
        linksBefore,
      );
      expect((await getPartyRepository().listAllNotes(s005Ctx)).length).toBe(
        notesBefore,
      );

      // 3. Positive controls (R281, R298): all 20 S0-05 actions (plus takeTaskAction) succeed with Tenant A's valid session and valid Tenant A record IDs, producing observable state changes
      const validTask = initialTasks[0]!;
      const validTaskSave = await saveTaskAction({
        id: validTask.id,
        title: 'Tenant A Verified Task Title',
        dueAt: validTask.dueAt,
        assignedTeamId: validTask.assignedTeamId,
        assignedPersonId: validTask.assignedPersonId,
      });
      expect(isActionDenied(validTaskSave)).toBe(false);
      expect(validTaskSave.error).toBeUndefined();
      expect(
        (
          await getTaskWorkflowRepository().getTaskById(s005Ctx, validTask.id, {
            includeRestricted: true,
          })
        )?.title,
      ).toBe('Tenant A Verified Task Title');

      const actorTeam = store.teams.find(
        (tm) => tm.memberIds.includes('P-000001') || tm.leadIds.includes('P-000001'),
      )!;
      const unclaimedTaskCreate = await saveTaskAction({
        title: 'Tenant A Unclaimed Queue Task',
        dueAt: '2026-12-10',
        assignedTeamId: actorTeam.id,
        assignedPersonId: null,
      });
      expect(isActionDenied(unclaimedTaskCreate)).toBe(false);
      const unclaimedTaskId = unclaimedTaskCreate.task!.id;
      const validTaskTake = await takeTaskAction(unclaimedTaskId);
      expect(isActionDenied(validTaskTake)).toBe(false);
      expect(
        (
          await getTaskWorkflowRepository().getTaskById(
            s005Ctx,
            unclaimedTaskId,
            { includeRestricted: true },
          )
        )?.assignedPersonId,
      ).toBe('P-000001');

      const validTaskComment = await addTaskCommentAction(
        validTask.id,
        'Tenant A valid comment',
      );
      expect(isActionDenied(validTaskComment)).toBe(false);
      expect(
        (
          await getTaskWorkflowRepository().getTaskById(s005Ctx, validTask.id, {
            includeRestricted: true,
          })
        )?.comments.some((c) => c.text === 'Tenant A valid comment'),
      ).toBe(true);

      const templateEnq = initialEnquiries.find(
        (e) => e.status === 'New' || e.status === 'Assigned',
      )!;
      const validEnqCreate = await saveEnquiryAction({
        firstName: 'TenantA',
        lastName: 'PositiveControl',
        email: 'tenanta.control@notalawfirm.example',
        phone: '029 2000 5555',
        channelId: templateEnq.channelId,
        practiceAreaId: templateEnq.practiceAreaId,
        summary: 'Tenant A positive control enquiry',
        notes: 'Initial notes for Tenant A positive control enquiry',
        urgencyId: templateEnq.urgencyId,
        privacyNoticeGiven: true,
      });
      expect(isActionDenied(validEnqCreate)).toBe(false);
      const validEnqId = validEnqCreate.enquiry!.id;
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.firstName,
      ).toBe('TenantA');

      const validEnqUpdate = await saveEnquiryAction(
        {
          firstName: 'TenantA',
          lastName: 'PositiveControl',
          email: 'tenanta.control@notalawfirm.example',
          phone: '029 2000 5555',
          channelId: templateEnq.channelId,
          practiceAreaId: templateEnq.practiceAreaId,
          summary: 'Tenant A positive control enquiry updated by ID',
          notes: 'Updated notes for Tenant A positive control enquiry',
          urgencyId: templateEnq.urgencyId,
          privacyNoticeGiven: true,
        },
        { id: validEnqId },
      );
      expect(isActionDenied(validEnqUpdate)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.summary,
      ).toBe('Tenant A positive control enquiry updated by ID');

      const validEnqAssign = await assignEnquiryAction(validEnqId, 'P-000001');
      expect(isActionDenied(validEnqAssign)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.assignedToId,
      ).toBe('P-000001');

      const validEnqContactLog = await logEnquiryContactAction(validEnqId, {
        method: 'Phone',
        outcome: 'Spoke',
        note: 'Tenant A valid contact log note',
      });
      expect(isActionDenied(validEnqContactLog)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.contactLog.some((c) => c.note === 'Tenant A valid contact log note'),
      ).toBe(true);

      const auditMarkBeforeEmail = await markAuditPosition();
      const validEnqEmail = await sendEnquiryEmailAction(validEnqId, {
        to: 'tenanta.control@notalawfirm.example',
        subject: 'Tenant A Valid Follow-up Email',
        bodyHtml: '<p>Tenant A email body</p>',
        bodyText: 'Tenant A email body',
      });
      expect(isActionDenied(validEnqEmail)).toBe(false);
      const auditAfterEmail = await auditEntriesSince(auditMarkBeforeEmail);
      expect(auditAfterEmail.length).toBeGreaterThan(0);
      const queuedEntry = auditAfterEmail.find(
        (a) =>
          a.recordType === 'enquiry' &&
          a.recordId === validEnqId &&
          a.action === 'email-queued',
      );
      expect(queuedEntry).toBeDefined();
      expect(queuedEntry?.newValue).toContain('recipients:1');
      expect(JSON.stringify(queuedEntry)).not.toContain('tenanta.control@notalawfirm.example');
      expect(JSON.stringify(queuedEntry)).not.toContain('Tenant A Valid Follow-up Email');
      const queuedOutbox = await getOutboxRepository().listOutboxRecords(s005Ctx);
      expect(
        queuedOutbox.some((r) => r.templateKey === 'enquiry.email'),
      ).toBe(true);

      const validEnqClose = await closeEnquiryAction(validEnqId, {
        targetStatus: 'Declined',
        closeReasonId: 'enquiry_close_reason.conflict',
        closeNotes: 'Closed in Tenant A positive control',
      });
      expect(isActionDenied(validEnqClose)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.status,
      ).toBe('Declined');

      const validEnqReopen = await reopenEnquiryAction(validEnqId);
      expect(isActionDenied(validEnqReopen)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getEnquiryById(s005Ctx, validEnqId, {
            includeRestricted: true,
          })
        )?.status,
      ).toBe('Assigned');

      const validQuoteCreate = await saveQuoteAction({
        clientType: 'prospect',
        prospectName: 'Tenant A Prospect',
        practiceAreaId: samplePracticeAreaId,
        scope: 'Tenant A valid quote scope',
        feeBasis: 'Fixed fee',
        feeAmountExVat: 1250,
      });
      expect(isActionDenied(validQuoteCreate)).toBe(false);
      const validQuoteId = validQuoteCreate.quote!.id;
      expect(
        (
          await getIntakeQuoteRepository().getQuoteById(s005Ctx, validQuoteId, {
            includeRestricted: true,
          })
        )?.scope,
      ).toBe('Tenant A valid quote scope');

      const validQuoteUpdate = await saveQuoteAction(
        {
          clientType: 'prospect',
          prospectName: 'Tenant A Prospect',
          practiceAreaId: samplePracticeAreaId,
          scope: 'Tenant A valid quote scope updated by ID',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1250,
        },
        { id: validQuoteId },
      );
      expect(isActionDenied(validQuoteUpdate)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getQuoteById(s005Ctx, validQuoteId, {
            includeRestricted: true,
          })
        )?.scope,
      ).toBe('Tenant A valid quote scope updated by ID');

      const validQuoteSent = await markQuoteSentAction(validQuoteId);
      expect(isActionDenied(validQuoteSent)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getQuoteById(s005Ctx, validQuoteId, {
            includeRestricted: true,
          })
        )?.status,
      ).toBe('Sent');

      const validQuoteFollowUp = await logQuoteFollowUpAction(validQuoteId, {
        method: 'Phone',
        note: 'Tenant A valid quote follow-up',
        nextFollowUpDate: '2026-12-01',
      });
      expect(isActionDenied(validQuoteFollowUp)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getQuoteById(s005Ctx, validQuoteId, {
            includeRestricted: true,
          })
        )?.followUps.some((f) => f.note === 'Tenant A valid quote follow-up'),
      ).toBe(true);

      const validQuoteRevise = await reviseQuoteAction(validQuoteId, {
        feeBasis: 'Fixed fee',
        feeAmountExVat: 1500,
        scope: 'Tenant A revised quote scope',
        markAsSent: true,
      });
      expect(isActionDenied(validQuoteRevise)).toBe(false);
      const revisedQuote = await getIntakeQuoteRepository().getQuoteById(
        s005Ctx,
        validQuoteId,
        { includeRestricted: true },
      );
      expect(revisedQuote?.version).toBe(2);
      expect(revisedQuote?.feeAmountExVat).toBe(1500);

      const validQuoteOutcome = await recordQuoteOutcomeAction(validQuoteId, {
        outcome: 'Accepted',
        note: 'Tenant A accepted quote',
      });
      expect(isActionDenied(validQuoteOutcome)).toBe(false);
      expect(
        (
          await getIntakeQuoteRepository().getQuoteById(s005Ctx, validQuoteId, {
            includeRestricted: true,
          })
        )?.status,
      ).toBe('Accepted');

      const validOrg = store.organisations[0]!;
      const validOrgSave = await saveOrganisationAction(
        {
          legalName: validOrg.legalName,
          clientReference: 'TA-CTRL-01',
        },
        { id: validOrg.id },
      );
      expect(isActionDenied(validOrgSave)).toBe(false);
      expect(
        (await getPartyRepository().getOrganisationById(testTenantCtx('P-000001'), validOrg.id))?.clientReference,
      ).toBe('TA-CTRL-01');

      const validContact = store.people.find((p) => !p.isEmployee)!;
      const validLinkSave = await saveLinkAction({
        personId: validContact.id,
        organisationId: validOrg.id,
        jobTitle: 'Tenant A General Counsel',
        department: 'Legal',
        roleWithinOrganisation: 'General Counsel',
        contactRoleIds: [],
        isPrimaryContact: false,
        isCurrent: true,
        startDate: '2026-01-01',
        endDate: null,
        contactStatusId: null,
      });
      expect(isActionDenied(validLinkSave)).toBe(false);
      expect(
        (await getPartyRepository().listAllLinks(testTenantCtx('P-000001'))).some(
          (l) =>
            l.id === validLinkSave.id &&
            l.jobTitle === 'Tenant A General Counsel',
        ),
      ).toBe(true);

      const validLinkDelete = await deleteLinkAction(validLinkSave.id);
      expect(isActionDenied(validLinkDelete)).toBe(false);
      expect(
        (await getPartyRepository().listAllLinks(testTenantCtx('P-000001'))).some(
          (l) => l.id === validLinkSave.id,
        ),
      ).toBe(false);

      const validMatterNote = await addNoteAction(
        'matter',
        store.matters[0]!.id,
        'Tenant A valid matter note',
      );
      expect(isActionDenied(validMatterNote)).toBe(false);
      expect(
        (
          await getPartyRepository().listNotesForRecord(
            testTenantCtx('P-000001'),
            'matter',
            store.matters[0]!.id,
          )
        ).some(
          (n) =>
            n.recordType === 'matter' &&
            n.recordId === store.matters[0]!.id &&
            n.text === 'Tenant A valid matter note',
        ),
      ).toBe(true);

      const dupOrgA = await saveOrganisationAction(
        { legalName: 'Tenant A Duplicate Candidate Alpha Ltd' },
        {},
      );
      const dupOrgB = await saveOrganisationAction(
        { legalName: 'Tenant A Duplicate Candidate Beta Ltd' },
        {},
      );
      expect(isActionDenied(dupOrgA)).toBe(false);
      expect(isActionDenied(dupOrgB)).toBe(false);
      const validDismissDup = await dismissDuplicateAction(
        'organisation',
        dupOrgA.organisation.id,
        dupOrgB.organisation.id,
      );
      expect(isActionDenied(validDismissDup)).toBe(false);
      expect(
        (
          await getPartyRepository().getOrganisationById(
            testTenantCtx('P-000001'),
            dupOrgA.organisation.id,
          )
        )?.notDuplicateOf.includes(dupOrgB.organisation.id),
      ).toBe(true);

      const mergeOrgSurvivor = await saveOrganisationAction(
        { legalName: 'Tenant A Merge Survivor Ltd' },
        {},
      );
      const mergeOrgTarget = await saveOrganisationAction(
        { legalName: 'Tenant A Merge Target Ltd' },
        {},
      );
      expect(isActionDenied(mergeOrgSurvivor)).toBe(false);
      expect(isActionDenied(mergeOrgTarget)).toBe(false);
      const validMerge = await mergeRecordsAction(
        'organisation',
        mergeOrgSurvivor.organisation.id,
        mergeOrgTarget.organisation.id,
      );
      expect(isActionDenied(validMerge)).toBe(false);
      expect(
        (
          await getPartyRepository().getOrganisationById(
            testTenantCtx('P-000001'),
            mergeOrgTarget.organisation.id,
          )
        )?.mergedIntoId,
      ).toBe(mergeOrgSurvivor.organisation.id);

      const dupPersonA = await savePersonAction(
        { firstName: 'TenantADup', surname: 'PersonAlpha' },
        {},
      );
      const dupPersonB = await savePersonAction(
        { firstName: 'TenantADup', surname: 'PersonBeta' },
        {},
      );
      expect(isActionDenied(dupPersonA)).toBe(false);
      expect(isActionDenied(dupPersonB)).toBe(false);
      const validDismissPersonDup = await dismissDuplicateAction(
        'person',
        dupPersonA.person.id,
        dupPersonB.person.id,
      );
      expect(isActionDenied(validDismissPersonDup)).toBe(false);
      expect(
        (
          await getPartyRepository().getPersonById(
            testTenantCtx('P-000001'),
            dupPersonA.person.id,
          )
        )?.notDuplicateOf.includes(dupPersonB.person.id),
      ).toBe(true);

      const mergePersonSurvivor = await savePersonAction(
        { firstName: 'TenantAMerge', surname: 'SurvivorPerson' },
        {},
      );
      const mergePersonTarget = await savePersonAction(
        { firstName: 'TenantAMerge', surname: 'TargetPerson' },
        {},
      );
      expect(isActionDenied(mergePersonSurvivor)).toBe(false);
      expect(isActionDenied(mergePersonTarget)).toBe(false);
      const validPersonMerge = await mergeRecordsAction(
        'person',
        mergePersonSurvivor.person.id,
        mergePersonTarget.person.id,
      );
      expect(isActionDenied(validPersonMerge)).toBe(false);
      expect(
        (
          await getPartyRepository().getPersonById(
            testTenantCtx('P-000001'),
            mergePersonTarget.person.id,
          )
        )?.mergedIntoId,
      ).toBe(mergePersonSurvivor.person.id);

      const leaverCandidate = store.people.find(
        (p) => p.isEmployee && p.id !== 'P-000001' && p.id !== 'P-000002',
      )!;
      leaverCandidate.isEmployee = false;
      leaverCandidate.employment = {
        ...(leaverCandidate.employment!),
        status: 'Leaver',
      };
      await getPartyRepository().putPerson(testTenantCtx('P-000001'), leaverCandidate);
      const taskInRepo = (
        await getTaskWorkflowRepository().getTaskById(s005Ctx, validTask.id, {
          includeRestricted: true,
        })
      )!;
      taskInRepo.assignedPersonId = leaverCandidate.id;
      taskInRepo.assignedPersonIds = [leaverCandidate.id];
      await getTaskWorkflowRepository().putTask(s005Ctx, taskInRepo);
      const validLeaverReassign = await reassignLeaverOwnedRecordsAction(
        leaverCandidate.id,
        'P-000001',
      );
      expect(isActionDenied(validLeaverReassign)).toBe(false);
      expect(validLeaverReassign.reassignedCount).toBeGreaterThan(0);
      expect(
        (
          await getTaskWorkflowRepository().getTaskById(s005Ctx, validTask.id, {
            includeRestricted: true,
          })
        )?.assignedPersonId,
      ).toBe('P-000001');

      // 4. Data-layer isolation check (real PostgreSQL TenantDocumentRepository)
      const pgDocRepo = new TenantDocumentRepository();
      const ctxA = resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-s005-a',
      });
      const ctxB = resolveTenantFromVerifiedToken({
        verifiedToken: tenantBToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-s005-b',
      });
      await pgDocRepo.putDocument(ctxB, {
        id: tamperedIds.task,
        tenantId: ctxB.tenantId,
        title: 'Tenant B Confidential Task',
        fileName: 'task.docx',
        documentType: 'letter',
        outputFormat: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 128,
        fileSha256: 'sha-s005-task',
        templateId: 'TPL-B',
        templateName: 'B',
        templateVersionId: 'TPLV-B',
        templateVersionNumber: 1,
        storageProvider: 'local-fs',
        storageKey: 'blob-s005-task',
        generatedByUserId: 'user-b1',
        generatedAt: new Date().toISOString(),
        isDeleted: false,
      });
      expect((await pgDocRepo.getDocumentById(ctxB, tamperedIds.task))?.title).toBe(
        'Tenant B Confidential Task',
      );
      expect(await pgDocRepo.getDocumentById(ctxA, tamperedIds.task)).toBeNull();
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-07: rejects forged tenant claims and tampered IDs on conflict search and conversion actions (with positive Tenant A controls and data-layer cluster checks)', async () => {
    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const store = loadCommittedSeedStore();
      const ctxA = resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-s007-a',
      });
      const ctxB = resolveTenantFromVerifiedToken({
        verifiedToken: tenantBToken,
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-s007-b',
      });
      expect(ctxA.tenantId).toBe('not-a-law-firm');
      expect(ctxB.tenantId).toBe('fictional-chambers-uk');

      // 1. Forged tenant claim: session whose tenant claim ('pembroke-vaughan') differs from the active tenant ('not-a-law-firm')
      const forgedTenantBSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'pembroke-vaughan',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '99999999-8888-7777-6666-555555555555',
          sub: 'P-000001',
          email: 'rhian.morgan@pembroke.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(forgedTenantBSession);
      await expect(
        runMatterConflictSearchAction({
          currentMatterId: store.matters[0]!.id,
          parties: [
            {
              id: 'cp-forged-1',
              name: 'Forged Claim Party',
              entityType: 'organisation',
              role: 'Client',
              linkedRecordId: null,
            },
          ],
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      await expect(
        prepareEnquiryConversionAction('ENQ-000001', {}),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      await expect(
        prepareQuoteConversionAction('Q-000001'),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);

      // 2. Tampered IDs under a valid Tenant A session fail closed with explicit "not found" errors and create nothing
      const validTenantASession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000001',
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(validTenantASession);
      const peopleBefore = store.people.length;
      const orgsBefore = store.organisations.length;
      const tamperedEnqConv = await prepareEnquiryConversionAction('ENQ-TENANT-B-501', {});
      expect(tamperedEnqConv.ok).toBe(false);
      expect(tamperedEnqConv.conflictReasons).toEqual(['Enquiry not found.']);
      const tamperedQuoteConv = await prepareQuoteConversionAction('Q-TENANT-B-501');
      expect(tamperedQuoteConv.ok).toBe(false);
      expect(tamperedQuoteConv.error).toBe('Quote not found.');
      expect(store.people.length).toBe(peopleBefore);
      expect(store.organisations.length).toBe(orgsBefore);

      // 3. Positive controls: the same actions succeed with Tenant A's valid session and valid Tenant A records
      const tenantAClientOrg = store.organisations.find(
        (o) => o.id === store.matters[0]!.clientId,
      )!;
      const posSearchRes = await runMatterConflictSearchAction({
        currentMatterId: null,
        parties: [
          {
            id: 'cp-pos-1',
            name: tenantAClientOrg.legalName,
            entityType: 'organisation',
            role: 'Opponent',
            linkedRecordId: tenantAClientOrg.id,
          },
        ],
      });
      expect(posSearchRes.errors).toBeUndefined();
      expect(posSearchRes.matches.some((m) => m.matterId === store.matters[0]!.id)).toBe(true);

      const s007Enquiries =
        await getIntakeQuoteRepository().listAllEnquiriesUnfiltered(
          testTenantCtx('P-000001'),
        );
      const templateEnq = s007Enquiries.find((e) => e.status !== 'Draft')!;
      const cleanTenantAEnqRes = await saveEnquiryAction(
        {
          channelId: templateEnq.channelId,
          firstName: 'Carys',
          lastName: 'PositiveEnqControl',
          callingOnBehalfOf: 'Brecon Positive Control Holdings Ltd',
          email: 'carys@brecon-pos.example',
          phone: '029 2018 0444',
          preferredContactMethodId: templateEnq.preferredContactMethodId,
          sourceId: templateEnq.sourceId,
          practiceAreaId: store.matters[0]!.practiceAreaId,
          summary: 'Positive control Tenant A enquiry conversion',
          notes: 'Notes for positive control conversion.',
          otherPartiesNamed: 'None',
          urgencyId: templateEnq.urgencyId,
          privacyNoticeGiven: true,
        },
        { asDraft: false },
      );
      expect(isActionDenied(cleanTenantAEnqRes)).toBe(false);
      const cleanTenantAEnq = (cleanTenantAEnqRes as { enquiry?: { id: string } }).enquiry!;
      const posEnqConv = await prepareEnquiryConversionAction(cleanTenantAEnq.id, {
        createForBusiness: true,
      });
      expect(posEnqConv.ok).toBe(true);
      expect(posEnqConv.clientId).toBeTruthy();

      const cleanTenantAQuoteRes = await saveQuoteAction({
        clientType: 'prospect',
        prospectName: 'Gareth PositiveQuoteControl',
        prospectOrganisationName: 'Taff Positive Quote Control Ltd',
        practiceAreaId: store.matters[0]!.practiceAreaId,
        scope: 'Positive control Tenant A quote conversion',
        feeBasis: 'Fixed fee',
        feeAmountExVat: 1750,
      });
      expect(isActionDenied(cleanTenantAQuoteRes)).toBe(false);
      const cleanTenantAQuote = (cleanTenantAQuoteRes as { quote?: { id: string } }).quote!;
      const posQuoteConv = await prepareQuoteConversionAction(cleanTenantAQuote.id);
      expect(posQuoteConv.ok).toBe(true);
      expect(posQuoteConv.clientId).toBeTruthy();

      // 4. Domain and data-layer cluster checks (testing domain conflict helpers on separate stores and PostgresTenantCluster, not single-tenant store actions)
      const tenantBStore = createSeedStore();
      const pgStoreRepo = new TenantDocumentStoreRepository();
      const tenantBPerson = {
        ...tenantBStore.people[0]!,
        id: 'P-TENANT-B-501',
        firstName: 'Owain',
        surname: 'PembrokeSecretContact',
        isEmployee: false,
      };
      const tenantBOrg = {
        ...tenantBStore.organisations[0]!,
        id: 'O-TENANT-B-501',
        legalName: 'Pembroke Vaughan Secret Client Holdings Ltd',
      };
      const tenantBLink = {
        ...tenantBStore.links[0]!,
        id: 'L-TENANT-B-501',
        personId: tenantBPerson.id,
        organisationId: tenantBOrg.id,
        isCurrent: true,
      };
      const tenantBMatter = {
        ...tenantBStore.matters[0]!,
        id: 'M-TENANT-B-501',
        matterNumber: 'PV-999999',
        title: 'Pembroke Secret Matter',
        clientId: tenantBOrg.id,
        additionalClientIds: [tenantBPerson.id],
        instructingContactId: tenantBPerson.id,
        billingContactId: tenantBPerson.id,
        parties: [
          {
            id: 'MP-TB-1',
            name: tenantBOrg.legalName,
            entityType: 'organisation' as const,
            role: 'Opponent',
            linkedRecordId: tenantBOrg.id,
          },
        ],
      };
      const tenantBEnquiry = {
        ...tenantBStore.enquiries[0]!,
        id: 'ENQ-TENANT-B-501',
        firstName: tenantBPerson.firstName,
        lastName: tenantBPerson.surname,
        callingOnBehalfOf: tenantBOrg.legalName,
      };
      const tenantBQuote = {
        ...tenantBStore.quotes[0]!,
        id: 'Q-TENANT-B-501',
        prospectName: `${tenantBPerson.firstName} ${tenantBPerson.surname}`,
        prospectOrganisationName: tenantBOrg.legalName,
      };

      tenantBStore.people.push(tenantBPerson);
      tenantBStore.organisations.push(tenantBOrg);
      tenantBStore.links.push(tenantBLink);
      tenantBStore.matters.push(tenantBMatter);
      tenantBStore.enquiries.push(tenantBEnquiry);
      tenantBStore.quotes.push(tenantBQuote);

      await pgStoreRepo.putMatterLocation(ctxB, {
        id: 'LOC-TENANT-B-501',
        tenantId: ctxB.tenantId,
        matterId: tenantBMatter.id,
        storeId: 'sp-b',
        libraryId: 'lib-b',
        providerSiteId: 'site-b',
        providerDriveId: 'drive-b',
        providerFolderItemId: 'item-b-501',
        webUrl: 'https://contoso.sharepoint.com/sites/b/PV-999999',
        relativePath: 'PV-999999',
        linkMode: 'provisioned',
        routingMismatchNote: null,
        deltaSyncCursor: null,
        lastJobId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        provisionedAt: new Date().toISOString(),

        templateId: 'tpl-default',
        templateVersion: 1,
        folderItemMap: {},
        intendedGrants: [],
        hasUniquePermissions: false,
        uniqueScopeCount: 0,

        provisioningStatus: 'provisioned',
        retentionLabelId: null,



        updatedAt: new Date().toISOString(),
      });

      const matterSearchB = searchMatterConflicts(
        {
          currentMatterId: null,
          parties: [
            {
              id: 'cp-tb-1',
              name: tenantBOrg.legalName,
              entityType: 'organisation',
              role: 'Opponent',
              linkedRecordId: tenantBOrg.id,
            },
            {
              id: 'cp-tb-2',
              name: `${tenantBPerson.firstName} ${tenantBPerson.surname}`,
              entityType: 'person',
              role: 'Opponent',
              linkedRecordId: tenantBPerson.id,
            },
          ],
          canReviewConditions: true,
        },
        {
          matters: tenantBStore.matters,
          enquiries: tenantBStore.enquiries,
          people: tenantBStore.people,
          organisations: tenantBStore.organisations,
          links: tenantBStore.links,
          tenantId: ctxB.tenantId,
          canView: () => true,
          canViewEnquiry: () => true,
        },
      );
      expect(matterSearchB.some((m) => m.matterId === tenantBMatter.id)).toBe(true);

      const enqSearchB = runEnquiryConflictSearch(
        {
          firstName: tenantBPerson.firstName,
          lastName: tenantBPerson.surname,
          callingOnBehalfOf: tenantBOrg.legalName,
          otherPartiesNamed: `${tenantBOrg.legalName}, ${tenantBPerson.firstName} ${tenantBPerson.surname}`,
        },
        tenantBStore.people,
        tenantBStore.organisations,
        tenantBStore.matters,
        tenantBStore.values,
        tenantBStore.enquiries,
        tenantBEnquiry.id,
        tenantBStore.links,
        () => true,
        ctxB.tenantId,
      );
      expect(enqSearchB.allConflicts.length).toBeGreaterThan(0);

      const matterSearchA = searchMatterConflicts(
        {
          currentMatterId: null,
          parties: [
            {
              id: 'cp-tb-1',
              name: tenantBOrg.legalName,
              entityType: 'organisation',
              role: 'Opponent',
              linkedRecordId: tenantBOrg.id,
            },
            {
              id: 'cp-tb-2',
              name: `${tenantBPerson.firstName} ${tenantBPerson.surname}`,
              entityType: 'person',
              role: 'Opponent',
              linkedRecordId: tenantBPerson.id,
            },
          ],
          canReviewConditions: true,
        },
        {
          matters: store.matters,
          enquiries: s007Enquiries,
          people: store.people,
          organisations: store.organisations,
          links: store.links,
          tenantId: ctxA.tenantId,
          canView: () => true,
          canViewEnquiry: () => true,
        },
      );
      expect(matterSearchA).toEqual([]);
      expect(JSON.stringify(matterSearchA)).not.toContain(tenantBMatter.matterNumber);

      const enqSearchA = runEnquiryConflictSearch(
        {
          firstName: tenantBPerson.firstName,
          lastName: tenantBPerson.surname,
          callingOnBehalfOf: tenantBOrg.legalName,
          otherPartiesNamed: `${tenantBOrg.legalName}, ${tenantBPerson.firstName} ${tenantBPerson.surname}`,
        },
        store.people,
        store.organisations,
        store.matters,
        store.values,
        s007Enquiries,
        null,
        store.links,
        () => true,
        ctxA.tenantId,
      );
      expect(enqSearchA.allConflicts).toEqual([]);
      expect(enqSearchA.otherPartyClientMatches).toEqual([]);
      expect(enqSearchA.clientAgainstPartyMatches).toEqual([]);
      expect(enqSearchA.hasBlockingConflict).toBe(false);

      expect(await pgStoreRepo.listMatterLocationsByMatterId(ctxA, tenantBMatter.id)).toEqual([]);
      expect(
        (await pgStoreRepo.listMatterLocationsByMatterId(ctxB, tenantBMatter.id))[0]?.matterId,
      ).toBe(tenantBMatter.id);
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-09: rejects forged tenant claims and tampered IDs on mergeRecordsAction (with positive Tenant A controls and TenantDocumentRepository / cluster data-layer checks)', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const sA = (await runAsTestActor('P-000004', () =>
        savePersonRecord(
          { firstName: 'TenantA', surname: 'Survivor', isEmployee: false },
          { byId: 'P-000004' },
        ),
      )).person!;
      const mA = (await runAsTestActor('P-000004', () =>
        savePersonRecord(
          { firstName: 'TenantA', surname: 'Merged', isEmployee: false },
          { byId: 'P-000004' },
        ),
      )).person!;

      const ctxA = resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 's0-09-iso-a',
      });
      const ctxB = resolveTenantFromVerifiedToken({
        verifiedToken: tenantBToken,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 's0-09-iso-b',
      });

      // 1. Forged tenant claim: session whose tenant claim ('pembroke-vaughan') differs from the active tenant ('not-a-law-firm')
      const forgedTenantBSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000004',
          tenantId: 'pembroke-vaughan',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '99999999-8888-7777-6666-555555555555',
          sub: 'P-000004',
          email: 'admin@pembroke.example',
          displayName: 'Admin',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(forgedTenantBSession);
      await expect(
        mergeRecordsAction('person', sA.id, mA.id),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
      await expect(
        mergeRecordsAction('organisation', 'O-000001', 'O-000002'),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);

      // 2. Tampered IDs under a valid Tenant A session fail closed with FORBIDDEN and "Record not found for merge."
      const validTenantASession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'admin@notalawfirm.example',
          displayName: 'Admin',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(validTenantASession);

      const sOrgARes = await saveOrganisationAction(
        {
          legalName: 'Tenant A Survivor Org Ltd',
        },
        {},
      );
      expect(isActionDenied(sOrgARes)).toBe(false);
      const sOrgA = (sOrgARes as { organisation: { id: string } }).organisation;
      const mOrgARes = await saveOrganisationAction(
        {
          legalName: 'Tenant A Merged Org Ltd',
        },
        {},
      );
      expect(isActionDenied(mOrgARes)).toBe(false);
      const mOrgA = (mOrgARes as { organisation: { id: string } }).organisation;

      const tenantBPersonSurvId = 'P-TENANT-B-SURV';
      const tenantBPersonMergId = 'P-TENANT-B-MERG';

      const tamperedSurv = await mergeRecordsAction('person', tenantBPersonSurvId, sA.id);
      expect(isActionDenied(tamperedSurv)).toBe(true);
      if (isActionDenied(tamperedSurv)) {
        expect(tamperedSurv.code).toBe('FORBIDDEN');
        expect(tamperedSurv.message).toBe('Record not found for merge.');
      }

      const tamperedMerg = await mergeRecordsAction('person', sA.id, tenantBPersonMergId);
      expect(isActionDenied(tamperedMerg)).toBe(true);
      if (isActionDenied(tamperedMerg)) {
        expect(tamperedMerg.code).toBe('FORBIDDEN');
        expect(tamperedMerg.message).toBe('Record not found for merge.');
      }

      const tamperedBoth = await mergeRecordsAction(
        'person',
        tenantBPersonSurvId,
        tenantBPersonMergId,
      );
      expect(isActionDenied(tamperedBoth)).toBe(true);
      if (isActionDenied(tamperedBoth)) {
        expect(tamperedBoth.code).toBe('FORBIDDEN');
        expect(tamperedBoth.message).toBe('Record not found for merge.');
      }

      const tamperedOrg = await mergeRecordsAction(
        'organisation',
        'O-TENANT-B-SURV',
        'O-TENANT-B-MERG',
      );
      expect(isActionDenied(tamperedOrg)).toBe(true);
      if (isActionDenied(tamperedOrg)) {
        expect(tamperedOrg.code).toBe('FORBIDDEN');
        expect(tamperedOrg.message).toBe('Record not found for merge.');
      }
      expect((await getPartyRepository().getPersonById(testTenantCtx('P-000004'), sA.id))?.mergedIntoId).toBeNull();
      expect((await getPartyRepository().getPersonById(testTenantCtx('P-000004'), mA.id))?.mergedIntoId).toBeNull();

      // 3. Data-layer isolation checks (TenantDocumentRepository and PostgresTenantCluster) + positive Tenant A merge controls
      const repo = getDocumentRepository();
      await repo.offboardTenantData(ctxB);

      const docB = {
        id: 'DOC-TENANT-B-09',
        tenantId: ctxB.tenantId,
        title: 'Tenant B Confidential Engagement',
        fileName: 'b.docx',
        documentType: 'letter',
        outputFormat: 'docx' as const,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 512,
        fileSha256: 'sha-b',
        templateId: 'TPL-B',
        templateName: 'B',
        templateVersionId: 'TPLV-B',
        templateVersionNumber: 1,
        storageProvider: 'local-fs' as const,
        storageKey: 'blob-b-09',
        generatedByUserId: 'user-b1',
        generatedAt: new Date().toISOString(),
        primaryClientId: tenantBPersonMergId,
        recipientPartyId: mA.id,
        isDeleted: false,
      };
      const linkB = {
        id: 'DL-TENANT-B-09',
        tenantId: ctxB.tenantId,
        documentId: docB.id,
        entityType: 'person' as const,
        entityId: mA.id,
        linkRole: 'recipient_party' as const,
        createdAt: new Date().toISOString(),

      };
      await repo.putDocument(ctxB, docB);
      await repo.putDocumentLink(ctxB, linkB);

      // Positive controls: merging valid Tenant A person and organisation records succeeds
      const mergeARes = await mergeRecordsAction('person', sA.id, mA.id);
      expect(isActionDenied(mergeARes)).toBe(false);
      expect((mergeARes as { survivorId: string }).survivorId).toBe(sA.id);
      expect((await getPartyRepository().getPersonById(testTenantCtx('P-000004'), mA.id))?.mergedIntoId).toBe(sA.id);

      const mergeOrgARes = await mergeRecordsAction('organisation', sOrgA.id, mOrgA.id);
      expect(isActionDenied(mergeOrgARes)).toBe(false);
      expect((mergeOrgARes as { survivorId: string }).survivorId).toBe(sOrgA.id);
      expect((await getPartyRepository().getOrganisationById(testTenantCtx('P-000004'), mOrgA.id))?.mergedIntoId).toBe(
        sOrgA.id,
      );

      // Tenant B's document and link in TenantDocumentRepository and records in PostgresTenantCluster remain untouched
      const fetchedDocB = (await repo.getDocumentById(ctxB, docB.id))!;
      expect(fetchedDocB.primaryClientId).toBe(tenantBPersonMergId);
      expect(fetchedDocB.recipientPartyId).toBe(mA.id);
      expect((await repo.listDocumentsForEntity(ctxB, 'person', mA.id)).map((d) => d.id)).toEqual([
        docB.id,
      ]);
      expect(await repo.listDocumentsForEntity(ctxA, 'person', mA.id)).toHaveLength(0);
      expect(await repo.getDocumentById(ctxA, docB.id)).toBeNull();
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-10: enforces two-tenant isolation, tampered record ID rejection, and positive controls across all five finance loaders and three credit-control actions', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const validTenantASession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: '00000000-0000-4000-8000-000000000001',
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;

      const forgedTenantBSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'pembroke-vaughan',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '99999999-8888-7777-6666-555555555555',
          sub: '00000000-0000-4000-8000-000000000001',
          email: 'rhian.morgan@pembroke.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;

      const validActorScope = {
        tenantId: validTenantASession.tenantId,
        personId: validTenantASession.personId,
        tokenRoles: validTenantASession.mappedRoles,
        expiresAtMs: Date.now() + 3600_000,
        verifiedSession: validTenantASession,
      };

      const forgedActorScope = {
        ...validActorScope,
        tenantId: forgedTenantBSession.tenantId,
        verifiedSession: forgedTenantBSession,
      };

      // --- 1. getMatterFinanceRows ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      await expect(
        runWithActiveActorSession(forgedActorScope, () =>
          getMatterFinanceRows('P-000001', ['M-000008']),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered record ID and real restricted matter ID -> ActionDenied FORBIDDEN
      const tamperedRows = await runWithActiveActorSession(validActorScope, () =>
        getMatterFinanceRows('P-000001', ['M-TENANT-B-999']),
      );
      expect(isActionDenied(tamperedRows)).toBe(true);
      if (isActionDenied(tamperedRows)) {
        expect(tamperedRows.code).toBe('FORBIDDEN');
        expect(tamperedRows.message).toBe('Matter not found or access denied.');
      }
      const store = loadCommittedSeedStore();
      const restrictedStaffMatter = (await getMatterRepository().getMatterById<import('@/domain/types').Matter>(
        testTenantCtx('P-000004'),
        'M-000014',
      ))!;
      restrictedStaffMatter.isStaffMatter = true;
      restrictedStaffMatter.responsiblePartnerId = 'P-000004';
      restrictedStaffMatter.supervisingPartnerId = 'P-000004';
      restrictedStaffMatter.leadFeeEarnerId = 'P-000004';
      restrictedStaffMatter.restrictedAccessUserIds = ['P-000004'];
      await getMatterRepository().putMatter(
        testTenantCtx('P-000004'),
        restrictedStaffMatter,
        { expectedRowVersion: null },
      );
      const validFeeEarnerSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000002',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-555555555555',
          sub: '00000000-0000-4000-8000-000000000002',
          email: 'dafydd.evans@notalawfirm.example',
          displayName: 'Dafydd Evans',
          entraRoles: ['fee_earner'],
          mappedRoles: ['fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      const restrictedRows = await runWithActiveActorSession(
        {
          tenantId: validFeeEarnerSession.tenantId,
          personId: validFeeEarnerSession.personId,
          tokenRoles: validFeeEarnerSession.mappedRoles,
          expiresAtMs: Date.now() + 3600_000,
          verifiedSession: validFeeEarnerSession,
        },
        () => getMatterFinanceRows('P-000002', ['M-000014']),
      );
      expect(isActionDenied(restrictedRows)).toBe(true);
      if (isActionDenied(restrictedRows)) {
        expect(restrictedRows.code).toBe('FORBIDDEN');
        expect(restrictedRows.message).toBe('Matter not found or access denied.');
      }
      // (c) Positive control: valid Tenant A session + valid linked matter ID -> succeeds
      const okRows = await runWithActiveActorSession(validActorScope, () =>
        getMatterFinanceRows('P-000001', ['M-000001']),
      );
      expect(isActionDenied(okRows)).toBe(false);
      if (!isActionDenied(okRows)) {
        expect(okRows.pmsSummaryByMatterId['M-000001']).toBeDefined();
      }

      // --- 2. getMyFinanceFigures ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      await expect(
        runWithActiveActorSession(forgedActorScope, () =>
          getMyFinanceFigures('P-000001'),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered actor ID -> ActionDenied FORBIDDEN
      const tamperedMine = await runWithActiveActorSession(validActorScope, () =>
        getMyFinanceFigures('P-TENANT-B-999'),
      );
      expect(isActionDenied(tamperedMine)).toBe(true);
      if (isActionDenied(tamperedMine)) {
        expect(tamperedMine.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid actor ID -> succeeds
      const okMine = await runWithActiveActorSession(validActorScope, () =>
        getMyFinanceFigures('P-000001'),
      );
      expect(isActionDenied(okMine)).toBe(false);
      if (!isActionDenied(okMine)) {
        expect(okMine.myFeeEarnerFigures?.fee_earner_id).toBe('FE001');
      }

      // --- 3. getFirmFinance ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      await expect(
        runWithActiveActorSession(forgedActorScope, () =>
          getFirmFinance('P-000001'),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered actor ID -> ActionDenied FORBIDDEN
      const tamperedFirm = await runWithActiveActorSession(validActorScope, () =>
        getFirmFinance('P-TENANT-B-999'),
      );
      expect(isActionDenied(tamperedFirm)).toBe(true);
      if (isActionDenied(tamperedFirm)) {
        expect(tamperedFirm.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid actor ID -> succeeds
      const okFirm = await runWithActiveActorSession(validActorScope, () =>
        getFirmFinance('P-000001'),
      );
      expect(isActionDenied(okFirm)).toBe(false);
      if (!isActionDenied(okFirm)) {
        expect(okFirm.allFeeEarnerPerformance.length).toBeGreaterThan(0);
      }

      // --- 4. getMatterPmsViewBundle ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      await expect(
        runWithActiveActorSession(forgedActorScope, () =>
          getMatterPmsViewBundle('M-000008', 'P-000001'),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered matter ID -> ActionDenied FORBIDDEN
      const tamperedMatterView = await runWithActiveActorSession(validActorScope, () =>
        getMatterPmsViewBundle('M-TENANT-B-999', 'P-000001'),
      );
      expect(isActionDenied(tamperedMatterView)).toBe(true);
      if (isActionDenied(tamperedMatterView)) {
        expect(tamperedMatterView.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid linked matter ID -> succeeds
      const okMatterView = await runWithActiveActorSession(validActorScope, () =>
        getMatterPmsViewBundle('M-000008', 'P-000001'),
      );
      expect(isActionDenied(okMatterView)).toBe(false);
      if (!isActionDenied(okMatterView)) {
        expect(okMatterView.matterBundle).not.toBeNull();
      }

      // --- 5. getClientPmsViewBundle ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      await expect(
        runWithActiveActorSession(forgedActorScope, () =>
          getClientPmsViewBundle('organisation', 'O-000001', 'P-000001'),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered client record ID -> ActionDenied FORBIDDEN
      const tamperedClientView = await runWithActiveActorSession(validActorScope, () =>
        getClientPmsViewBundle('organisation', 'O-TENANT-B-999', 'P-000001'),
      );
      expect(isActionDenied(tamperedClientView)).toBe(true);
      if (isActionDenied(tamperedClientView)) {
        expect(tamperedClientView.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid client ID -> succeeds
      const okClientView = await runWithActiveActorSession(validActorScope, () =>
        getClientPmsViewBundle('organisation', 'O-000001', 'P-000001'),
      );
      expect(isActionDenied(okClientView)).toBe(false);
      if (!isActionDenied(okClientView)) {
        expect(okClientView.clientBundle).not.toBeNull();
      }

      // --- 6. requestMatterBillAction ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      setTestEntraSessionOverride(forgedTenantBSession);
      await expect(
        requestMatterBillAction('HAR001-0003'),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered matter code -> ActionDenied FORBIDDEN
      setTestEntraSessionOverride(validTenantASession);
      const tamperedBill = await requestMatterBillAction('TENANTB-9999');
      expect(isActionDenied(tamperedBill)).toBe(true);
      if (isActionDenied(tamperedBill)) {
        expect(tamperedBill.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid matter code -> succeeds
      const okBill = await requestMatterBillAction('HAR001-0003');
      expect(isActionDenied(okBill)).toBe(false);
      if (!isActionDenied(okBill)) {
        expect(okBill.ok).toBe(true);
      }

      // --- 7. flagMatterWriteOffAction ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      setTestEntraSessionOverride(forgedTenantBSession);
      await expect(
        flagMatterWriteOffAction('HAR001-0003', 350),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered matter code -> ActionDenied FORBIDDEN
      setTestEntraSessionOverride(validTenantASession);
      const tamperedWriteOff = await flagMatterWriteOffAction('TENANTB-9999', 350);
      expect(isActionDenied(tamperedWriteOff)).toBe(true);
      if (isActionDenied(tamperedWriteOff)) {
        expect(tamperedWriteOff.code).toBe('FORBIDDEN');
      }
      // (c) Positive control: valid Tenant A session + valid matter code -> succeeds
      const okWriteOff = await flagMatterWriteOffAction('HAR001-0003', 350);
      expect(isActionDenied(okWriteOff)).toBe(false);
      if (!isActionDenied(okWriteOff)) {
        expect(okWriteOff.ok).toBe(true);
      }

      // --- 8. recordInvoiceCreditControlActionAction ---
      // (a) Forged tenant claim -> TENANCY_FORGERY_DETECTED
      setTestEntraSessionOverride(forgedTenantBSession);
      await expect(
        recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0040',
          matterCode: 'HAR001-0003',
          clientCode: 'HAR001',
          actionType: 'log_call',
        }),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      // (b) Tampered matter code, mismatched clientCode, or cross-matter invoiceNumber -> ActionDenied FORBIDDEN
      setTestEntraSessionOverride(validTenantASession);
      const s010Ctx = testTenantCtx('P-000001');
      const notesCountBefore = (await getPartyRepository().listAllNotes(s010Ctx))
        .length;
      const tasksCountBefore = (
        await getTaskWorkflowRepository().listAllTasksUnfiltered(s010Ctx)
      ).length;
      const tamperedCc = await recordInvoiceCreditControlActionAction({
        invoiceNumber: 'INV-TENANT-B-999',
        matterCode: 'TENANTB-9999',
        clientCode: 'TENANTB',
        actionType: 'log_call',
      });
      expect(isActionDenied(tamperedCc)).toBe(true);
      if (isActionDenied(tamperedCc)) {
        expect(tamperedCc.code).toBe('FORBIDDEN');
      }
      const mismatchedClientCc = await recordInvoiceCreditControlActionAction({
        invoiceNumber: 'PV/2026/0040',
        matterCode: 'HAR001-0003',
        clientCode: 'SEV001',
        actionType: 'log_call',
      });
      expect(isActionDenied(mismatchedClientCc)).toBe(true);
      if (isActionDenied(mismatchedClientCc)) {
        expect(mismatchedClientCc.code).toBe('FORBIDDEN');
        expect(mismatchedClientCc.message).toMatch(/Client code does not match/i);
      }
      const crossMatterInvoiceCc = await recordInvoiceCreditControlActionAction({
        invoiceNumber: 'PV/2026/0021',
        matterCode: 'HAR001-0003',
        clientCode: 'HAR001',
        actionType: 'log_call',
      });
      expect(isActionDenied(crossMatterInvoiceCc)).toBe(true);
      if (isActionDenied(crossMatterInvoiceCc)) {
        expect(crossMatterInvoiceCc.code).toBe('FORBIDDEN');
        expect(crossMatterInvoiceCc.message).toMatch(
          /Invoice does not belong to the specified matter/i,
        );
      }
      expect((await getPartyRepository().listAllNotes(s010Ctx)).length).toBe(
        notesCountBefore,
      );
      expect(
        (await getTaskWorkflowRepository().listAllTasksUnfiltered(s010Ctx))
          .length,
      ).toBe(tasksCountBefore);
      // (c) Positive control: valid Tenant A session + valid matter code -> succeeds
      const okCc = await recordInvoiceCreditControlActionAction({
        invoiceNumber: 'PV/2026/0040',
        matterCode: 'HAR001-0003',
        clientCode: 'HAR001',
        actionType: 'log_call',
      });
      expect(isActionDenied(okCc)).toBe(false);
      if (!isActionDenied(okCc)) {
        expect(okCc.ok).toBe(true);
      }
    } finally {
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
  it('S0-30 (B13): rejects forged tenant claims on savePersonAction and Entra JWT sign-in verification, and rejects tampered person IDs on savePersonAction, savePersonRecord, and updatePersonPermissionOverrides, with positive Tenant A controls', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = loadCommittedSeedStore();
      const targetEmployeeA = store.people.find((p) => p.id === 'P-000002')!;
      delete targetEmployeeA.entraObjectId;
      await getPartyRepository().putPerson(testTenantCtx('P-000004'), targetEmployeeA);
      const originalEmailsJson = JSON.stringify(targetEmployeeA.emails);
      const tamperedPersonId = 'P-TENANT-B-EMP-99';
      const tamperedEnquiryId = 'ENQ-TENANT-B-99';

      // Set up RSA key pair and JWKS fetch stub for real Entra JWT verification (verifyEntraJwtSignatureAndClaims)
      const tenantAEntraTid = '11111111-2222-3333-4444-000000000000';
      const tenantBEntraTid = '99999999-8888-7777-6666-555555555555';
      const clientId = '00000000-0000-4000-8000-000000000111';
      const kid = 's0-30-isolation-kid';
      const nonce = 's0-30-nonce-123';
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const publicJwk = {
        ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
        kid,
        use: 'sig',
        alg: 'RS256',
      };
      clearJwksCache();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ keys: [publicJwk] }),
        }),
      );
      const signJwt = (payload: Record<string, unknown>): string => {
        const rawHeader = Buffer.from(
          JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }),
          'utf8',
        ).toString('base64url');
        const rawPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
          'base64url',
        );
        const signingInput = `${rawHeader}.${rawPayload}`;
        const sig = crypto
          .sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey)
          .toString('base64url');
        return `${signingInput}.${sig}`;
      };
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Forged tenant claim: session whose tenantId ('pembroke-vaughan') does not match active tenant ('not-a-law-firm')
      const forgedTenantBSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000004',
          tenantId: 'pembroke-vaughan',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: tenantBEntraTid,
          sub: 'P-000004',
          email: 'admin@pembroke.example',
          displayName: 'Admin',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(forgedTenantBSession);

      await expect(
        savePersonAction(
          {
            firstName: targetEmployeeA.firstName,
            surname: targetEmployeeA.surname,
            emails: [
              {
                id: 'em-forged',
                address: 'forged@notalawfirm.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { id: targetEmployeeA.id },
        ),
      ).rejects.toThrow(
        'TENANCY_FORGERY_DETECTED: Request attempted to override authenticated session tenantId.',
      );

      // Forged Entra token whose tid belongs to Tenant B is rejected by verifyEntraJwtSignatureAndClaims
      const forgedTidToken = signJwt({
        aud: clientId,
        tid: tenantBEntraTid,
        iss: `https://login.microsoftonline.com/${tenantBEntraTid}/v2.0`,
        sub: 'sub-forged-b',
        oid: '22222222-0000-4000-8000-000000000002',
        nonce,
        iat: nowSec - 10,
        nbf: nowSec - 10,
        exp: nowSec + 3600,
        preferred_username: targetEmployeeA.emails[0]!.address,
        roles: [],
        amr: ['pwd', 'mfa'],
      });
      await expect(
        verifyEntraJwtSignatureAndClaims({
          idToken: forgedTidToken,
          tenantId: tenantAEntraTid,
          clientId,
          expectedNonce: nonce,
        }),
      ).rejects.toThrow(
        'Microsoft Entra ID token tenant (tid) is missing or does not match ENTRA_TENANT_ID.',
      );

      // Reload from PostgreSQL to confirm nothing was written under forged tenant claims
      const reloadedEmployeeA = (await getPartyRepository().getPersonById(
        testTenantCtx('P-000004'),
        targetEmployeeA.id,
      ))!;
      expect(reloadedEmployeeA.emails).toEqual(JSON.parse(originalEmailsJson));
      expect(reloadedEmployeeA.entraObjectId).toBeUndefined();

      // 2. Tampered person ID (an ID not in active Tenant A, including a tampered ENQ- ID) is refused on both person save and identity binding
      const validTenantASession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: tenantAEntraTid,
          sub: 'P-000004',
          email: 'catrin.williams@notalawfirm.example',
          displayName: 'Catrin Williams',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(validTenantASession);

      const tamperedActionRes = await savePersonAction(
        {
          firstName: 'Tampered',
          surname: 'TenantBPerson',
          emails: [
            {
              id: 'em-tampered',
              address: 'tampered@notalawfirm.example',
              typeId: 'email_type.work',
              isPrimary: true,
              active: true,
            },
          ],
        },
        { id: tamperedPersonId },
      );
      expect(isActionDenied(tamperedActionRes)).toBe(true);
      if (isActionDenied(tamperedActionRes)) {
        expect(tamperedActionRes.code).toBe('FORBIDDEN');
        expect(tamperedActionRes.message).toBe('Person record not found.');
      }

      const tamperedServiceRes = await savePersonRecord(
        {
          firstName: 'Tampered',
          surname: 'TenantBPerson',
          emails: [
            {
              id: 'em-tampered-svc',
              address: 'tampered.svc@notalawfirm.example',
              typeId: 'email_type.work',
              isPrimary: true,
              active: true,
            },
          ],
        },
        { id: tamperedPersonId, byId: 'P-000004', mfaVerified: true },
      );
      expect(isActionDenied(tamperedServiceRes)).toBe(true);
      expect(tamperedServiceRes.code).toBe('FORBIDDEN');
      expect(tamperedServiceRes.message).toBe('Person record not found.');

      const peopleCountBeforeTamperedEnq = (
        await getPartyRepository().listAllPeople(testTenantCtx('P-000004'))
      ).length;
      const tamperedEnqServiceRes = await savePersonRecord(
        {
          firstName: 'Tampered',
          surname: 'EnquiryCaller',
        },
        { id: tamperedEnquiryId, byId: 'P-000004', mfaVerified: true },
      );
      expect(isActionDenied(tamperedEnqServiceRes)).toBe(true);
      expect(tamperedEnqServiceRes.code).toBe('FORBIDDEN');
      expect(tamperedEnqServiceRes.message).toBe('Person record not found.');
      expect(
        (await getPartyRepository().listAllPeople(testTenantCtx('P-000004')))
          .length,
      ).toBe(peopleCountBeforeTamperedEnq);

      const tamperedBindRes = await updatePersonPermissionOverrides(
        tamperedPersonId,
        {
          grant: [],
          revoke: [],
          entraObjectId: '99999999-0000-4000-8000-000000000099',
        },
        'P-000004',
        { mfaVerified: true },
      );
      expect(tamperedBindRes.ok).toBe(false);
      expect(tamperedBindRes.error).toBe('Target employee not found.');

      expect(
        (await getPartyRepository().listAllPeople(testTenantCtx('P-000004'))).some(
          (p) => p.id === tamperedPersonId,
        ),
      ).toBe(false);

      // 3. Positive controls: valid Tenant A session updates Tenant A employee email and valid Tenant A JWT binds unbound non-privileged employee on sign-in
      const validEmailUpdate = await savePersonAction(
        {
          firstName: targetEmployeeA.firstName,
          surname: targetEmployeeA.surname,
          emails: [
            {
              id: targetEmployeeA.emails[0]!.id,
              address: 'dafydd.verified@notalawfirm.example',
              typeId: 'email_type.work',
              isPrimary: true,
              active: true,
            },
          ],
        },
        { id: targetEmployeeA.id },
      );
      expect(isActionDenied(validEmailUpdate)).toBe(false);
      expect(
        (
          await getPartyRepository().getPersonById(
            testTenantCtx('P-000004'),
            targetEmployeeA.id,
          )
        )?.emails[0]?.address,
      ).toBe('dafydd.verified@notalawfirm.example');

      const validTenantAToken = signJwt({
        aud: clientId,
        tid: tenantAEntraTid,
        iss: `https://login.microsoftonline.com/${tenantAEntraTid}/v2.0`,
        sub: 'sub-dafydd-valid',
        oid: '33333333-0000-4000-8000-000000000002',
        nonce,
        iat: nowSec - 10,
        nbf: nowSec - 10,
        exp: nowSec + 3600,
        name: 'Dafydd Evans',
        preferred_username: 'dafydd.verified@notalawfirm.example',
        roles: [],
        amr: ['pwd', 'mfa'],
      });
      const verifiedTenantAClaims = await verifyEntraJwtSignatureAndClaims({
        idToken: validTenantAToken,
        tenantId: tenantAEntraTid,
        clientId,
        expectedNonce: nonce,
      });
      const validSignInBind = await resolveOrProvisionEntraEmployee(verifiedTenantAClaims);
      expect(validSignInBind.person.id).toBe(targetEmployeeA.id);
      expect(validSignInBind.person.entraObjectId).toBe(
        '33333333-0000-4000-8000-000000000002',
      );
      expect(
        (
          await getPartyRepository().getPersonById(
            testTenantCtx('P-000004'),
            targetEmployeeA.id,
          )
        )?.entraObjectId,
      ).toBe('33333333-0000-4000-8000-000000000002');
    } finally {
      clearJwksCache();
      vi.unstubAllGlobals();
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('S0-13b: isolates concurrent two-tenant telemetry events, rejects forged tenant claims with TENANCY_FORGERY_DETECTED, and scrubs PII', async () => {
    const recorder = new PlatformTelemetryRecorder();

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-tel-forged-001',
        untrustedRequestTenantOverride: 'fictional-chambers-uk',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-tel-iso-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: tenantBToken,
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-tel-iso-b',
    });

    await Promise.all([
      Promise.resolve().then(() =>
        emitTenantTelemetryEvent({
          eventName: 'matter.opened',
          tenantId: ctxA.tenantId,
          correlationId: ctxA.correlationId,
          properties: {
            matterId: 'M-A-001',
            email: ctxA.actorEmail,
            matterTitle: 'Confidential Alpha Acquisition',
          },
          recorder,
        }),
      ),
      Promise.resolve().then(() =>
        emitTenantTelemetryException({
          eventName: 'matter.open_failed',
          tenantId: ctxB.tenantId,
          correlationId: ctxB.correlationId,
          error: new Error(
            'Validation failed for partner@fictionalchambers.co.uk',
          ),
          properties: {
            matterId: 'M-B-999',
            name: ctxB.actorName,
          },
          recorder,
        }),
      ),
    ]);

    const entriesA = recorder.getRecentEntries({ tenantId: ctxA.tenantId });
    expect(entriesA).toHaveLength(1);
    expect(entriesA[0]).toMatchObject({
      eventName: 'matter.opened',
      tenantId: 'not-a-law-firm',
      correlationId: 'corr-tel-iso-a',
      properties: {
        matterId: 'M-A-001',
      },
    });
    expect(JSON.stringify(entriesA)).not.toContain('notalawfirm.example');
    expect(JSON.stringify(entriesA)).not.toContain(
      'Confidential Alpha Acquisition',
    );
    expect(JSON.stringify(entriesA)).not.toContain('M-B-999');

    const entriesB = recorder.getRecentEntries({ tenantId: ctxB.tenantId });
    expect(entriesB).toHaveLength(1);
    expect(entriesB[0]?.tenantId).toBe('fictional-chambers-uk');
    expect(entriesB[0]?.correlationId).toBe('corr-tel-iso-b');
    expect(entriesB[0]?.errorMessage).toBe(
      'Validation failed for [REDACTED_EMAIL]',
    );
    expect(JSON.stringify(entriesB)).not.toContain('fictionalchambers.co.uk');
    expect(JSON.stringify(entriesB)).not.toContain('Bernard Sterling');
  });

  it('restricts derived Key Vault names to the context environment, so a test context cannot resolve a live vault reference (S0-13b, R425)', () => {
    const ctxTest = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-kv-env-r425',
    });
    expect(ctxTest.configuredKeyVault).toBeUndefined();

    let caught: unknown;
    try {
      assertTenantOwnsKeyVaultSecretRef(
        ctxTest,
        `kv://kv-${ctxTest.tenantId}-live/sp-provisioning-cert`,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe(
      'TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED',
    );
    expect((caught as Error).message).toBe(
      `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED: Tenant "${ctxTest.tenantId}" is not permitted to access Key Vault "kv-${ctxTest.tenantId}-live".`,
    );

    // Positive tenant-A control: the same tenant's vault for its own environment resolves
    expect(
      assertTenantOwnsKeyVaultSecretRef(
        ctxTest,
        `kv://kv-${ctxTest.tenantId}-test/sp-provisioning-cert`,
      ),
    ).toEqual({
      vaultName: `kv-${ctxTest.tenantId}-test`,
      secretName: 'sp-provisioning-cert',
    });
  });

  it('enforces two-tenant Key Vault secret-reference isolation in DocumentStoreTokenService including 24-character truncated vault names (S0-13b, ADR 0024 AG3, R411, R413)', async () => {
    // Forged tenant claim is rejected before any Key Vault reference is inspected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: tenantAToken,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-kv-forged',
        untrustedRequestTenantOverride: 'fictional-chambers-uk',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // Tenant A ('not-a-law-firm') configured with deployment output kv-notalawfirm-test
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: tenantAToken,
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-kv-iso-a',
      configuredKeyVault: {
        vaultName: 'kv-notalawfirm-test',
        vaultUri: 'https://kv-notalawfirm-test.vault.azure.net/',
      },
    });

    // Tenant B ('fictional-chambers-uk', >24 chars with kv-...-test) configured with 24-char Bicep output kv-fictionalchambersuk-t
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: tenantBToken,
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-kv-iso-b',
      configuredKeyVault: {
        vaultName: 'kv-fictionalchambersuk-t',
        vaultUri: 'https://kv-fictionalchambersuk-t.vault.azure.net/',
      },
    });

    const tokenService = new DocumentStoreTokenService({
      cache: new TenantScopedEncryptedTokenCache(),
    });

    const userAccessA = {
      kind: 'user' as const,
      tenantContext: ctxA,
      actorUserId: ctxA.actorId,
      entraObjectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      userUpn: ctxA.actorEmail,
      userAssertionToken: 'verified-assertion-a',
    };
    const provAccessA = {
      kind: 'provisioning' as const,
      tenantContext: ctxA,
      triggeredByUserId: ctxA.actorId,
      triggerEvent: 'matter.opened',
    };
    const provAccessB = {
      kind: 'provisioning' as const,
      tenantContext: ctxB,
      triggeredByUserId: ctxB.actorId,
      triggerEvent: 'matter.opened',
    };

    // Attack 1: Tenant A delegated OBO call with tampered certificateKeyVaultSecretRef pointing at Tenant B's 24-char vault
    await expect(
      tokenService.acquireDelegatedUserToken({
        accessContext: userAccessA,
        storeId: 'store-alpha',
        authConfig: {
          entraTenantId: '11111111-1111-1111-1111-111111111111',
          credentialMode: 'client_certificate',
          clientId: 'aaaaaaaa-1111-1111-1111-111111111111',
          certificateKeyVaultSecretRef: 'kv://kv-fictionalchambersuk-t/sp-cert',
          delegatedPermissionScope: 'Sites.Selected',
        },
      }),
    ).rejects.toMatchObject({
      code: 'TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED',
    });

    // Attack 2: Tenant A provisioning call pointing at Tenant B's https://<vault>.vault.azure.net URI
    await expect(
      tokenService.acquireProvisioningToken({
        accessContext: provAccessA,
        storeId: 'store-alpha',
        authConfig: {
          entraTenantId: '11111111-1111-1111-1111-111111111111',
          credentialMode: 'client_certificate',
          clientId: 'aaaaaaaa-1111-1111-1111-111111111111',
          certificateKeyVaultSecretRef:
            'https://kv-fictionalchambersuk-t.vault.azure.net/secrets/sp-cert',
          delegatedPermissionScope: 'Sites.Selected',
        },
      }),
    ).rejects.toMatchObject({
      code: 'TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED',
    });

    // Positive controls: Tenant A with its own vault and Tenant B with its 24-char truncated output vault both succeed
    const tokenA = await tokenService.acquireProvisioningToken({
      accessContext: provAccessA,
      storeId: 'store-alpha',
      authConfig: {
        entraTenantId: '11111111-1111-1111-1111-111111111111',
        credentialMode: 'client_certificate',
        clientId: 'aaaaaaaa-1111-1111-1111-111111111111',
        certificateKeyVaultSecretRef: 'kv://kv-notalawfirm-test/sp-cert',
        delegatedPermissionScope: 'Sites.Selected',
      },
    });
    expect(typeof tokenA).toBe('string');
    expect(tokenA.length).toBeGreaterThan(10);

    const tokenB = await tokenService.acquireProvisioningToken({
      accessContext: provAccessB,
      storeId: 'store-beta',
      authConfig: {
        entraTenantId: '22222222-2222-2222-2222-222222222222',
        credentialMode: 'client_certificate',
        clientId: 'bbbbbbbb-2222-2222-2222-222222222222',
        certificateKeyVaultSecretRef: 'kv://kv-fictionalchambersuk-t/sp-cert',
        delegatedPermissionScope: 'Sites.Selected',
      },
    });
    expect(typeof tokenB).toBe('string');
    expect(tokenB).not.toBe(tokenA);
  });

  it('enforces two-tenant scheduled job isolation (tenant-alpha and tenant-bravo through PgBouncer) and rejects unregistered or disabled tenants (S0-19, ADR 0030, Rule 4 & Rule 9)', async () => {
    const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const makeEntry = (tenantId: string, slug: string, enabled = true) => ({
      tenantId,
      slug,
      environment: 'test' as const,
      postgresHost: host,
      postgresDatabaseName: `pg_tenant_${slug}_test`,
      postgresRoleName: `role_tenant_${slug}_test`,
      keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
      packageDir: 'client-not-a-law-firm',
      timeZone: 'Europe/London',
      enabled,
    });

    const registry = {
      schemaVersion: '1.0.0' as const,
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
      tenants: [
        makeEntry('tenant-alpha', 'tenant_alpha', true),
        makeEntry('tenant-bravo', 'tenant_bravo', true),
        makeEntry('tenant-disabled-test', 'tenant_disabled_test', false),
      ],
    };

    // Attack 1: Unregistered tenant or empty tenant ID is refused by guardedJob with TENANCY_UNREGISTERED_JOB_TENANT
    await expect(
      guardedJob('key-date-reminders', '', async () => 'should-not-run', {
        registry,
      }),
    ).rejects.toMatchObject({
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
    });

    await expect(
      guardedJob(
        'key-date-reminders',
        'unregistered-evil-tenant',
        async () => 'should-not-run',
        { registry },
      ),
    ).rejects.toMatchObject({
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
    });

    // Attack 2: Disabled tenant in registry is refused by guardedJob
    await expect(
      guardedJob(
        'key-date-reminders',
        'tenant-disabled-test',
        async () => 'should-not-run',
        { registry },
      ),
    ).rejects.toMatchObject({
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
    });

    // Build tenant contexts for tenant-alpha and tenant-bravo
    const ctxAlpha = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'tenant-alpha',
        email: 'admin@alpha.example',
        name: 'Alpha Admin',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-iso-job-alpha',
    });
    const ctxBravo = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'tenant-bravo',
        email: 'admin@bravo.example',
        name: 'Bravo Admin',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-iso-job-bravo',
    });

    const jobRunRepo = getJobRunRepository();
    const docRepo = getDocumentRepository();
    await jobRunRepo.clearTenantJobRuns(ctxAlpha);
    await jobRunRepo.clearTenantJobRuns(ctxBravo);

    // Seed an expired usage event in tenant-alpha and a fresh usage event in tenant-bravo
    const sweepNowIso = '2026-06-15T02:05:00.000Z';
    await docRepo.putUsageEvent(ctxAlpha, {
      id: 'UE-ISO-ALPHA-OLD',
      tenantId: 'tenant-alpha',
      templateId: 'TPL-ALPHA-1',
      templateVersionId: 'TPLV-ALPHA-1',
      versionNumber: 1,
      eventType: 'generated',
      occurredAt: '2020-01-10T10:00:00.000Z',
      actorUserId: 'P-000001',
      actorRoleKey: 'partner',
      sourceEntityType: 'matter',
      outputFormat: 'docx',
      missingFieldKeys: [],
      durationMs: 12,
      correlationId: 'corr-ue-alpha-old',
    });
    await docRepo.putUsageEvent(ctxBravo, {
      id: 'UE-ISO-BRAVO-RECENT',
      tenantId: 'tenant-bravo',
      templateId: 'TPL-BRAVO-1',
      templateVersionId: 'TPLV-BRAVO-1',
      versionNumber: 1,
      eventType: 'generated',
      occurredAt: '2026-06-14T10:00:00.000Z',
      actorUserId: 'P-000001',
      actorRoleKey: 'partner',
      sourceEntityType: 'matter',
      outputFormat: 'docx',
      missingFieldKeys: [],
      durationMs: 15,
      correlationId: 'corr-ue-bravo-recent',
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(sweepNowIso));
    let purgeSummary;
    try {
      purgeSummary = await runScheduledUsageRetentionPurgeJobSweep({
        registry,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(purgeSummary.exitCode).toBe(0);
    expect(purgeSummary.succeededTenants).toEqual(['tenant-alpha', 'tenant-bravo']);

    const alphaRuns = await jobRunRepo.listJobRuns(ctxAlpha, {
      jobKey: 'usage-retention-purge',
    });
    const bravoRuns = await jobRunRepo.listJobRuns(ctxBravo, {
      jobKey: 'usage-retention-purge',
    });
    expect(alphaRuns).toHaveLength(1);
    expect(alphaRuns[0]!.tenantId).toBe('tenant-alpha');
    expect(alphaRuns[0]!.triggeredById).toBe('system:usage-retention-purge');
    expect(alphaRuns[0]!.summary.purgedEventsCount).toBeGreaterThanOrEqual(1);

    expect(bravoRuns).toHaveLength(1);
    expect(bravoRuns[0]!.tenantId).toBe('tenant-bravo');
    expect(bravoRuns[0]!.triggeredById).toBe('system:usage-retention-purge');
    expect(bravoRuns[0]!.summary.purgedEventsCount).toBe(0);
    expect(alphaRuns[0]!.correlationId).not.toBe(bravoRuns[0]!.correlationId);

    // Tenant Bravo's recent usage event remains untouched in Tenant Bravo's database, and Tenant Alpha cannot see Bravo's job_runs
    const bravoEventsAfter = await docRepo.listUsageEvents(ctxBravo);
    expect(bravoEventsAfter.some((e) => e.id === 'UE-ISO-BRAVO-RECENT')).toBe(true);
    expect(alphaRuns.some((r) => r.id === bravoRuns[0]!.id)).toBe(false);
  });

  it('S0-19b: enforces two-tenant PgBouncer isolation for enquiry-retention-anonymise (retentionMonths: 6 in tenant-alpha vs retentionMonths: 24 in tenant-bravo, tampered specificEnquiryId, and unregistered/forged tenant claims)', async () => {
    const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const makeEntry = (tenantId: string, slug: string, enabled = true) => ({
      tenantId,
      slug,
      environment: 'test' as const,
      postgresHost: host,
      postgresDatabaseName: `pg_tenant_${slug}_test`,
      postgresRoleName: `role_tenant_${slug}_test`,
      keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
      packageDir: 'client-not-a-law-firm',
      timeZone: 'Europe/London',
      enabled,
    });

    const registry = {
      schemaVersion: '1.0.0' as const,
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
      tenants: [
        makeEntry('tenant-alpha', 'tenant_alpha', true),
        makeEntry('tenant-bravo', 'tenant_bravo', true),
        makeEntry('tenant-disabled-test', 'tenant_disabled_test', false),
      ],
    };

    // Attack 1: Unregistered or disabled tenant in guardedJob('enquiry-retention-anonymise', ...) is rejected with TENANCY_UNREGISTERED_JOB_TENANT
    await expect(
      guardedJob(
        'enquiry-retention-anonymise',
        'unregistered-evil-tenant',
        async () => 'should-not-run',
        { registry },
      ),
    ).rejects.toMatchObject({
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
    });

    await expect(
      guardedJob(
        'enquiry-retention-anonymise',
        'tenant-disabled-test',
        async () => 'should-not-run',
        { registry },
      ),
    ).rejects.toMatchObject({
      code: 'TENANCY_UNREGISTERED_JOB_TENANT',
    });

    // Attack 2: Forged OIDC claim with untrusted request tenant override is rejected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 'tenant-alpha',
          email: 'admin@alpha.example',
          name: 'Alpha Admin',
          roles: ['admin'],
          mfaVerified: true,
        },
        untrustedRequestTenantOverride: 'tenant-bravo',
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-enq-anon',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    const ctxAlpha = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'tenant-alpha',
        email: 'admin@alpha.example',
        name: 'Alpha Admin',
        roles: ['admin', 'risk_compliance'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-iso-enq-anon-alpha',
    });
    const ctxBravo = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'tenant-bravo',
        email: 'admin@bravo.example',
        name: 'Bravo Admin',
        roles: ['admin', 'risk_compliance'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-iso-enq-anon-bravo',
    });

    const jobRunRepo = getJobRunRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const catalogueRepo = getCatalogueRepository();
    const auditRepo = getAuditRepository();
    const partyRepo = getPartyRepository();

    await jobRunRepo.clearTenantJobRuns(ctxAlpha);
    await jobRunRepo.clearTenantJobRuns(ctxBravo);

    // Ensure actor P-000001 exists in both tenant databases with risk_compliance & admin roles
    for (const [ctx, domain] of [
      [ctxAlpha, 'alpha.example'],
      [ctxBravo, 'bravo.example'],
    ] as const) {
      const existingActor = await partyRepo.getPersonById(ctx, 'P-000001');
      if (!existingActor) {
        await partyRepo.putPerson(ctx, {
          id: 'P-000001',
          recordType: 'person',
          recordOwnerId: 'P-000001',
          recordStatusId: 'person_record_status.active',
          createdById: 'P-000001',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedById: 'P-000001',
          updatedAt: '2025-01-01T00:00:00.000Z',
          sourceId: 'data_source.manual_entry',
          lastVerifiedAt: '2025-01-01',
          tags: [],
          duplicateStatusId: 'duplicate_status.none',
          notDuplicateOf: [],
          possibleMatchIds: [],
          mergedIntoId: null,
          lastInteractionAt: null,
          customFields: {},
          titleId: null,
          firstName: 'Tenant',
          middleNames: '',
          surname: 'Admin',
          preferredName: '',
          otherNames: [],
          jobTitle: 'Managing Partner',
          emails: [
            {
              id: 'em-admin',
              typeId: null,
              address: `admin@${domain}`,
              isPrimary: true,
            },
          ],
          phones: [],
          preferredContactMethodId: null,
          preferredLanguageId: null,
          addresses: [],
          website: '',
          relationshipOwnerId: null,
          relationshipStatusId: null,
          relationshipStandingId: null,
          relationshipRoleIds: [],
          originId: null,
          firstKnownAt: null,
          engagementLevelId: null,
          interests: '',
          relationshipNotes: '',
          marketingConsentId: null,
          consentRecord: '',
          verificationStatusId: null,
          verifiedAt: null,
          verificationMethodId: null,
          verificationReviewerId: null,
          riskReferences: '',
          isEmployee: true,
          employeeRoleId: 'employee_role.managing_partner',
          departmentId: null,
          roles: ['admin', 'managing_partner', 'risk_compliance'],
        });
      }
    }

    // Configure Tenant Alpha with retentionMonths: 6 and Tenant Bravo with retentionMonths: 24
    await catalogueRepo.putEnquirySettingsConfig(
      ctxAlpha,
      {
        defaultSlaHoursByUrgency: {},
        routingTeamByPracticeArea: {},
        fallbackIntakeTeamId: null,
        retentionMonths: 6,
      },
      'P-000001',
    );
    await catalogueRepo.putEnquirySettingsConfig(
      ctxBravo,
      {
        defaultSlaHoursByUrgency: {},
        routingTeamByPracticeArea: {},
        fallbackIntakeTeamId: null,
        retentionMonths: 24,
      },
      'P-000001',
    );

    await intakeRepo.clearTenantData(ctxAlpha, {
      includeEnquiries: true,
      includeQuotes: false,
    });
    await intakeRepo.clearTenantData(ctxBravo, {
      includeEnquiries: true,
      includeQuotes: false,
    });

    // Seed a 12-month-old closed unconverted enquiry in each tenant (receivedAt = 2025-06-01, sweepNowIso = 2026-06-15)
    const sweepNowIso = '2026-06-15T02:15:00.000Z';
    const baseEnq = {
      receivedAt: '2025-06-01T10:00:00.000Z',
      takenById: 'P-000001',
      channelId: 'enquiry_channel.phone',
      callingOnBehalfOf: 'Invented Holdings',
      linkedOrganisationId: null,
      preferredContactMethodId: null,
      bestTimeToCall: '',
      address: null,
      practiceAreaId: 'work_type.commercial_property',
      workTypeSubcategoryId: null,
      summary: 'Commercial lease enquiry',
      otherPartiesNamed: '',
      urgencyId: 'enquiry_urgency.standard',
      keyDate: null,
      keyDateLabel: '',
      sourceId: 'origin.website',
      referrerPersonId: null,
      privacyNoticeGiven: true,
      linkedPersonId: null,
      assignedTeamId: null,
      assignedToId: 'P-000001',
      status: 'Declined' as const,
      firstContactDueAt: null,
      nextActionDate: null,
      closeReasonId: 'enquiry_close_reason.declined_capacity',
      referredToOrganisationId: null,
      convertedMatterId: null,
      contactLog: [],
      anonymisedAt: null,
      createdById: 'P-000001',
      createdAt: '2025-06-01T10:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2025-06-02T10:00:00.000Z',
    };

    const runSuffix = crypto.randomUUID().slice(0, 8);
    const alphaEnqId = `ENQ-ALPHA-12M-${runSuffix}`;
    const bravoEnqId = `ENQ-BRAVO-12M-${runSuffix}`;
    const bravo30mId = `ENQ-BRAVO-30M-${runSuffix}`;

    await intakeRepo.putEnquiry(ctxAlpha, {
      ...baseEnq,
      id: alphaEnqId,
      reference: alphaEnqId,
      firstName: 'AlphaProspect',
      lastName: 'TwelveMonths',
      email: 'alpha12m@invented.example',
      phone: '07700 900111',
      notes: 'Alpha 12m prospect notes',
    });
    await intakeRepo.putEnquiry(ctxBravo, {
      ...baseEnq,
      id: bravoEnqId,
      reference: bravoEnqId,
      firstName: 'BravoProspect',
      lastName: 'TwelveMonths',
      email: 'bravo12m@invented.example',
      phone: '07700 900222',
      notes: 'Bravo 12m prospect notes',
    });
    // Also seed a 30-month-old closed unconverted enquiry in Tenant Bravo to test tampered cross-tenant specificEnquiryId
    await intakeRepo.putEnquiry(ctxBravo, {
      ...baseEnq,
      id: bravo30mId,
      reference: bravo30mId,
      receivedAt: '2023-11-01T10:00:00.000Z',
      firstName: 'BravoExpiredProspect',
      lastName: 'ThirtyMonths',
      email: 'bravo30m@invented.example',
      phone: '07700 900333',
      notes: 'Bravo 30m prospect notes',
    });

    // Attack 3: Tampered specificEnquiryId from Tenant Alpha targeting Tenant Bravo's expired enquiry touches 0 rows in Tenant Bravo
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T01:30:00.000Z'));
    let tamperedAlphaOutcome;
    try {
      tamperedAlphaOutcome = await runEnquiryRetentionAnonymisationForTenant(
        ctxAlpha,
        {
          triggerSource: 'manual',
          actorId: 'P-000001',
          specificEnquiryId: bravo30mId,
        },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(tamperedAlphaOutcome.outcome).toBe('executed');
    if (tamperedAlphaOutcome.outcome === 'executed') {
      expect(tamperedAlphaOutcome.result.evaluatedCount).toBe(0);
      expect(tamperedAlphaOutcome.result.anonymisedCount).toBe(0);
      expect(tamperedAlphaOutcome.result.scope).toBe('single');
    }

    const bravo30mAfterTamper = await intakeRepo.getEnquiryById(
      ctxBravo,
      bravo30mId,
      { includeRestricted: true },
    );
    expect(bravo30mAfterTamper?.firstName).toBe('BravoExpiredProspect');
    expect(bravo30mAfterTamper?.anonymisedAt).toBeNull();

    // Remove the 30m enquiry before running the 12-month comparison sweep across Tenant Alpha (retentionMonths: 6) and Tenant Bravo (retentionMonths: 24)
    await intakeRepo.deleteEnquiryById(ctxBravo, bravo30mId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(sweepNowIso));
    let sweepSummary;
    try {
      sweepSummary = await runScheduledEnquiryRetentionAnonymisationJobSweep({
        registry,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(sweepSummary.exitCode).toBe(0);
    expect(sweepSummary.succeededTenants).toEqual([
      'tenant-alpha',
      'tenant-bravo',
    ]);

    // Tenant Alpha (retentionMonths: 6): 12-month-old enquiry IS anonymised (1) and audited in pg_tenant_alpha_test
    const alphaEnqAfter = (await intakeRepo.getEnquiryById(
      ctxAlpha,
      alphaEnqId,
      { includeRestricted: true },
    ))!;
    expect(alphaEnqAfter.anonymisedAt).toBe(sweepNowIso);
    expect(alphaEnqAfter.firstName).toBe('Anonymised');
    expect(alphaEnqAfter.lastName).toBe('Enquirer');
    expect(alphaEnqAfter.email).toBe('');

    const alphaAudits = await auditRepo.listAuditEntriesForRecord(
      ctxAlpha,
      'enquiry',
      alphaEnqId,
    );
    expect(
      alphaAudits.filter((a) => a.field === 'Privacy retention anonymisation'),
    ).toHaveLength(1);
    expect(alphaAudits[0]!.byId).toBe('system:enquiry-retention-anonymise');

    // Tenant Bravo (retentionMonths: 24): 12-month-old enquiry is INTACT (0 anonymised) in pg_tenant_bravo_test
    const bravoEnqAfter = (await intakeRepo.getEnquiryById(
      ctxBravo,
      bravoEnqId,
      { includeRestricted: true },
    ))!;
    expect(bravoEnqAfter.anonymisedAt).toBeNull();
    expect(bravoEnqAfter.firstName).toBe('BravoProspect');
    expect(bravoEnqAfter.lastName).toBe('TwelveMonths');
    expect(bravoEnqAfter.email).toBe('bravo12m@invented.example');

    const bravoAudits = await auditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'enquiry',
      bravoEnqId,
    );
    expect(
      bravoAudits.filter((a) => a.field === 'Privacy retention anonymisation'),
    ).toHaveLength(0);

    // Verify job_runs rows are isolated per tenant database
    const alphaJobRuns = await jobRunRepo.listJobRuns(ctxAlpha, {
      jobKey: 'enquiry-retention-anonymise',
    });
    const bravoJobRuns = await jobRunRepo.listJobRuns(ctxBravo, {
      jobKey: 'enquiry-retention-anonymise',
    });
    const alphaScheduledRun = alphaJobRuns.find(
      (r) => r.triggerSource === 'scheduled',
    )!;
    const bravoScheduledRun = bravoJobRuns.find(
      (r) => r.triggerSource === 'scheduled',
    )!;
    expect(alphaScheduledRun.tenantId).toBe('tenant-alpha');
    expect(alphaScheduledRun.summary).toEqual({
      evaluatedCount: 1,
      anonymisedCount: 1,
      retentionMonths: 6,
      scope: 'bulk',
    });
    expect(bravoScheduledRun.tenantId).toBe('tenant-bravo');
    expect(bravoScheduledRun.summary).toEqual({
      evaluatedCount: 1,
      anonymisedCount: 0,
      retentionMonths: 24,
      scope: 'bulk',
    });
    expect(alphaScheduledRun.correlationId).not.toBe(
      bravoScheduledRun.correlationId,
    );
    expect(alphaJobRuns.some((r) => r.id === bravoScheduledRun.id)).toBe(false);
  });

  it('R508 & R513 two-tenant isolation: savePersonRecord, getEmployeeDetailsForUser, and revealEmployeePayrollAction reject forged claims and block cross-tenant payroll reads/leaks with tampered Tenant B employee IDs', async () => {
    const rawBase = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-ADMIN',
        tenantId: 'tenant-a',
        name: 'Alpha Admin',
        email: 'admin@tenant-a.example',
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r508-r513-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-ADMIN',
        tenantId: 'tenant-b',
        name: 'Bravo Admin',
        email: 'admin@tenant-b.example',
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r508-r513-b',
    });

    const partyRepo = getPartyRepository();
    const hrRepo = getHrAndRbacRepository();
    const auditRepo = new TenantAuditRepository();
    const suffix = crypto.randomUUID().slice(0, 8);
    const alphaAdminId = `P-A-ADM-${suffix}`;
    const bravoEmpId = `P-B-EMP-${suffix}`;
    const bravoPayRef = `PAY-BRAVO-SECRET-${suffix}`;

    const baseEmpRecord = createDefaultEmploymentRecord({
      person: {
        id: alphaAdminId,
        firstName: 'Alpha',
        surname: 'Admin',
        jobTitle: 'Payroll Admin',
      },
      allPeople: [],
      orgStructure: buildDefaultOrgStructure({ legalName: 'Isolation Test Firm' }),
      byId: alphaAdminId,
      nowIso: '2026-11-19T12:00:00.000Z',
      status: 'Active',
      primaryDomain: 'tenant-a.example',
    });

    const alphaAdminPerson = {
      id: alphaAdminId,
      recordType: 'person' as const,
      recordOwnerId: alphaAdminId,
      recordStatusId: 'person_record_status.active',
      createdById: alphaAdminId,
      createdAt: '2026-11-19T12:00:00.000Z',
      updatedById: alphaAdminId,
      updatedAt: '2026-11-19T12:00:00.000Z',
      sourceId: null,
      lastVerifiedAt: '2026-11-19',
      tags: [],
      duplicateStatusId: 'duplicate_status.none',
      notDuplicateOf: [],
      possibleMatchIds: [],
      mergedIntoId: null,
      lastInteractionAt: '2026-11-19',
      customFields: {},
      titleId: null,
      firstName: 'Alpha',
      middleNames: '',
      surname: 'Admin',
      preferredName: '',
      dateOfBirth: '1985-01-01',
      otherNames: [],
      jobTitle: 'Payroll Admin',
      emails: [
        {
          id: `em-${alphaAdminId}`,
          address: `alpha.${suffix}@tenant-a.example`,
          typeId: 'email_type.work',
          isPrimary: true,
          active: true,
        },
      ],
      phones: [],
      preferredContactMethodId: null,
      preferredLanguageId: null,
      addresses: [],
      website: '',
      relationshipOwnerId: null,
      relationshipStatusId: null,
      relationshipStandingId: null,
      relationshipRoleIds: ['person_role.internal_colleague'],
      originId: null,
      firstKnownAt: '2026-01-01',
      engagementLevelId: null,
      interests: '',
      relationshipNotes: '',
      marketingConsentId: null,
      consentRecord: '',
      verificationStatusId: null,
      verifiedAt: null,
      verificationMethodId: null,
      verificationReviewerId: null,
      riskReferences: '',
      isEmployee: true,
      employeeRoleId: 'employee_role.system_administrator',
      departmentId: 'DEPT-HR',
      appRole: 'admin' as const,
      roles: ['admin' as const],
      employment: {
        ...baseEmpRecord,
        personId: alphaAdminId,
        employeeNumber: `EMP-A-${suffix}`,
        payroll: {
          ...baseEmpRecord.payroll!,
          externalPayrollReference: `PAY-ALPHA-${suffix}`,
        },
      },
    };

    const bravoEmpPerson = {
      ...alphaAdminPerson,
      id: bravoEmpId,
      recordOwnerId: bravoEmpId,
      createdById: bravoEmpId,
      updatedById: bravoEmpId,
      firstName: 'Bravo',
      surname: 'SecretEmployee',
      emails: [
        {
          id: `em-${bravoEmpId}`,
          address: `bravo.${suffix}@tenant-b.example`,
          typeId: 'email_type.work',
          isPrimary: true,
          active: true,
        },
      ],
      employment: {
        ...baseEmpRecord,
        personId: bravoEmpId,
        employeeNumber: `EMP-B-${suffix}`,
        payroll: {
          ...baseEmpRecord.payroll!,
          externalPayrollReference: bravoPayRef,
        },
      },
    };

    await partyRepo.putPeople(ctxA, [alphaAdminPerson]);
    await partyRepo.putPeople(ctxB, [bravoEmpPerson]);

    const signSession = (tenantId: 'tenant-a' | 'tenant-b', personId: string) => {
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const verified = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId,
          tenantId,
          oid: `00000000-0000-4000-8000-${personId.replace(/[^a-f0-9]/gi, '0').padStart(12, '0').slice(-12)}`,
          tid: '11111111-2222-4333-8444-555555555555',
          sub: personId,
          email: `${personId.toLowerCase()}@${tenantId}.example`,
          displayName: personId,
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        }),
      )!;
      setTestEntraSessionOverride(verified);
      return {
        personId,
        tenantId,
        tokenRoles: ['admin'],
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verified,
      };
    };

    try {
      // Forged tenant claim rejection
      expect(() =>
        resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: false as unknown as true,
            sub: alphaAdminId,
            tenantId: 'tenant-b',
            email: 'forged@tenant-a.example',
            name: 'Forged Actor',
            roles: ['admin'],
            mfaVerified: true,
          },
          hostingMode: 'multi_tenant',
          environment: 'test',
          correlationId: 'corr-forged-r513',
        }),
      ).toThrow();

      const baseCfgA = {
        ...rawBase,
        tenantId: 'tenant-a',
        displayName: 'Isolation Tenant Alpha',
        hostingMode: 'multi_tenant',
      };
      const baseCfgB = {
        ...rawBase,
        tenantId: 'tenant-b',
        displayName: 'Isolation Tenant Bravo',
        hostingMode: 'multi_tenant',
      };
      const overlayA = { tenantId: 'tenant-a', environment: 'test' };
      const overlayB = { tenantId: 'tenant-b', environment: 'test' };

      // Run as Tenant Alpha Payroll Admin and verify tampered Tenant B ID yields no data/leaks
      setActiveTenantConfigForTesting(baseCfgA, overlayA);
      const alphaSession = signSession('tenant-a', alphaAdminId);

      await runWithActiveActorSession(alphaSession, async () => {
        const snapA = await getAppSnapshot(alphaAdminId);
        // R538: snapshot must never include payroll on currentUser, effectiveWorkPerson, or employees
        expect(snapA.currentUser.employment?.payroll).toBeUndefined();
        expect(snapA.effectiveWorkPerson.employment?.payroll).toBeUndefined();
        for (const e of snapA.employees) {
          expect(e.employment?.payroll).toBeUndefined();
        }
        for (const p of snapA.people) {
          expect(p.employment?.payroll).toBeUndefined();
          expect(p.id).not.toBe(bravoEmpId);
        }

        const tamperedSave = await savePersonRecord(
          { firstName: 'Bravo', surname: '' },
          { id: bravoEmpId, byId: alphaAdminId, worksAtFirm: true },
        );
        expect(tamperedSave.person).toBeNull();

        const tamperedDetails = await getEmployeeDetailsForUser(
          bravoEmpId,
          alphaAdminId,
          { logViewPayroll: true, logViewSensitive: true },
        );
        expect(tamperedDetails.employment).toBeNull();
        expect(tamperedDetails.errors?.notFound).toBeTruthy();

        const tamperedAction = await revealEmployeePayrollAction(bravoEmpId);
        expect(isActionDenied(tamperedAction)).toBe(false);
        if (!isActionDenied(tamperedAction)) {
          expect(tamperedAction.ok).toBe(false);
          expect(tamperedAction.payroll).toBeNull();
        }
      });

      const bravoAuditsAfterTamper = await auditRepo.listAuditEntriesForRecord(
        ctxB,
        'employee_payroll',
        bravoEmpId,
      );
      expect(bravoAuditsAfterTamper.some((a) => a.byId === alphaAdminId)).toBe(false);

      // Positive control in Tenant Bravo
      setActiveTenantConfigForTesting(baseCfgB, overlayB);
      const bravoSession = signSession('tenant-b', bravoEmpId);
      await runWithActiveActorSession(bravoSession, async () => {
        const bravoMasked = await revealEmployeePayrollAction(bravoEmpId);
        expect(isActionDenied(bravoMasked)).toBe(false);
        if (!isActionDenied(bravoMasked)) {
          expect(bravoMasked.ok).toBe(true);
          expect(bravoMasked.payroll?.externalPayrollReference).toBe(bravoPayRef);
          if (bravoEmpPerson.employment?.payroll?.nationalInsuranceNumber) {
            expect(bravoMasked.payroll?.nationalInsuranceNumber.startsWith('•')).toBe(true);
          }
          expect(bravoMasked.payroll?.bankAccountName).toBe('');
        }
        const bravoAction = await revealEmployeePayrollAction(bravoEmpId, { mode: 'full' });
        expect(isActionDenied(bravoAction)).toBe(false);
        if (!isActionDenied(bravoAction)) {
          expect(bravoAction.ok).toBe(true);
          expect(bravoAction.payroll?.externalPayrollReference).toBe(bravoPayRef);
          expect(bravoAction.payroll?.nationalInsuranceNumber).toBe(
            bravoEmpPerson.employment?.payroll?.nationalInsuranceNumber,
          );
        }
      });
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await hrRepo.clearTenantData(ctxA).catch(() => undefined);
      await hrRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
    }
  });

  it('R509 & R528 two-tenant isolation: allow-list-only restricted matters hide rows across all 5 PostgreSQL repositories, and restricted task assignment denies tampered cross-tenant IDs', async () => {
    const rawBase = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        name: 'Alpha User',
        email: 'alpha1@tenant-alpha.example',
        roles: ['partner', 'fee_earner', 'admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r528-r509-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-1',
        tenantId: 'tenant-bravo',
        name: 'Bravo User',
        email: 'bravo1@tenant-bravo.example',
        roles: ['partner', 'fee_earner', 'admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r528-r509-b',
    });

    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();
    const kdRepo = getKeyDateRepository();
    const regRepo = getRegisterRepository();
    const suffix = crypto.randomUUID().slice(0, 8);
    const allowListMatterId = `M-R528-AL-${suffix}`;
    const bravoMatterId = `M-BRAVO-AL-${suffix}`;
    const enqId = `ENQ-R528-${suffix}`;
    const quoteId = `QT-R528-${suffix}`;
    const taskId = `TSK-R528-${suffix}`;
    const signOffId = `SO-R528-${suffix}`;
    const kdId = `KD-R528-${suffix}`;
    const regId = `REG-R528-${suffix}`;

    const makePerson = (id: string) => ({
      id,
      recordType: 'person' as const,
      recordOwnerId: id,
      recordStatusId: 'person_record_status.active',
      createdById: id,
      createdAt: '2026-11-19T10:00:00.000Z',
      updatedById: id,
      updatedAt: '2026-11-19T10:00:00.000Z',
      sourceId: null,
      lastVerifiedAt: '2026-11-19',
      tags: [],
      duplicateStatusId: 'duplicate_status.none',
      notDuplicateOf: [],
      possibleMatchIds: [],
      mergedIntoId: null,
      lastInteractionAt: '2026-11-19',
      customFields: {},
      titleId: null,
      firstName: id,
      middleNames: '',
      surname: 'Tester',
      preferredName: '',
      dateOfBirth: '1988-01-01',
      otherNames: [],
      jobTitle: 'Solicitor',
      emails: [],
      phones: [],
      preferredContactMethodId: null,
      preferredLanguageId: null,
      addresses: [],
      website: '',
      relationshipOwnerId: null,
      relationshipStatusId: null,
      relationshipStandingId: null,
      relationshipRoleIds: ['person_role.internal_colleague'],
      originId: null,
      firstKnownAt: '2026-01-01',
      engagementLevelId: null,
      interests: '',
      relationshipNotes: '',
      marketingConsentId: null,
      consentRecord: '',
      verificationStatusId: null,
      verifiedAt: null,
      verificationMethodId: null,
      verificationReviewerId: null,
      riskReferences: '',
      isEmployee: true,
      employeeRoleId: 'employee_role.solicitor',
      departmentId: 'DEPT-RE',
      appRole: 'fee_earner' as const,
      roles: ['fee_earner' as const],
    });

    const seed = loadCommittedSeedStore();
    try {
      // Ensure pre-existing test runs (such as s021) do not leave stale rows in tenant-alpha/tenant-bravo.
      await regRepo.clearTenantData(ctxA).catch(() => undefined);
      await kdRepo.clearTenantData(ctxA).catch(() => undefined);
      await taskRepo.clearTenantData(ctxA).catch(() => undefined);
      await taskRepo.clearTenantData(ctxB).catch(() => undefined);
      await intakeRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);

      await partyRepo.putPeople(ctxA, [
        makePerson('P-ALPHA-1'),
        makePerson('P-ALPHA-2'),
      ]);
      await partyRepo.putPeople(ctxB, [makePerson('P-BRAVO-1')]);

      // Seed allow-list-only restricted matter (isStaffMatter: false, hasEthicalWall: false, restrictedAccessUserIds: ['P-ALPHA-1'])
      await matterRepo.putMatter(
        ctxA,
        {
          ...structuredClone(seed.matters[0]!),
          id: allowListMatterId,
          matterNumber: `MAT-AL-${suffix}`,
          title: 'Allow-List Only Restricted Matter',
          clientId: 'P-ALPHA-1',
          responsiblePartnerId: 'P-ALPHA-1',
          supervisingPartnerId: 'P-ALPHA-1',
          leadFeeEarnerId: 'P-ALPHA-1',
          teamMemberIds: ['P-ALPHA-1'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: ['P-ALPHA-1'],
          createdById: 'P-ALPHA-1',
          updatedById: 'P-ALPHA-1',
        },
        {
          expectedRowVersion: null,
          sqlRestrictedAccessUserIds: ['P-ALPHA-1'],
        },
      );

      await matterRepo.putMatter(
        ctxB,
        {
          ...structuredClone(seed.matters[0]!),
          id: bravoMatterId,
          matterNumber: `MAT-BRV-${suffix}`,
          title: 'Bravo Allow-List Only Matter',
          clientId: 'P-BRAVO-1',
          responsiblePartnerId: 'P-BRAVO-1',
          supervisingPartnerId: 'P-BRAVO-1',
          leadFeeEarnerId: 'P-BRAVO-1',
          teamMemberIds: ['P-BRAVO-1'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: ['P-BRAVO-1'],
          createdById: 'P-BRAVO-1',
          updatedById: 'P-BRAVO-1',
        },
        {
          expectedRowVersion: null,
          sqlRestrictedAccessUserIds: ['P-BRAVO-1'],
        },
      );

      await intakeRepo.putEnquiry(ctxA, {
        ...structuredClone(seed.enquiries[0]!),
        id: enqId,
        reference: enqId,
        takenById: 'P-ALPHA-1',
        assignedToId: 'P-ALPHA-1',
        status: 'Converted',
        convertedMatterId: allowListMatterId,
        createdById: 'P-ALPHA-1',
        updatedById: 'P-ALPHA-1',
      });

      await intakeRepo.putQuote(ctxA, {
        ...structuredClone(seed.quotes[0]!),
        id: quoteId,
        reference: quoteId,
        linkedEnquiryId: enqId,
        status: 'Converted',
        convertedMatterId: allowListMatterId,
        createdById: 'P-ALPHA-1',
        updatedById: 'P-ALPHA-1',
      });

      await taskRepo.putTask(ctxA, {
        ...structuredClone(seed.tasks[0]!),
        id: taskId,
        reference: taskId,
        title: 'Allow-list Restricted Task',
        assignedTeamId: null,
        assignedPersonId: 'P-ALPHA-1',
        assignedPersonIds: ['P-ALPHA-1'],
        linkedRecords: [{ recordType: 'matter', recordId: allowListMatterId }],
        createdById: 'P-ALPHA-1',
        updatedById: 'P-ALPHA-1',
      });

      await taskRepo.putSignOff(ctxA, {
        id: signOffId,
        kind: 'write_off',
        title: 'Allow-list Sign-off',
        matterNumber: `MAT-AL-${suffix}`,
        matterId: allowListMatterId,
        subtitle: 'Allow-list Sign-off',
        requestedById: 'P-ALPHA-1',
        requestedAt: '2026-11-19T10:00:00.000Z',
        assignedPartnerId: 'P-ALPHA-1',
        status: 'Pending',
      });

      await kdRepo.putKeyDate(ctxA, {
        id: kdId,
        matterId: allowListMatterId,
        keyDateTypeId: 'limitation',
        category: 'limitation',
        title: 'Allow-list Key Date',
        dueDate: '2027-02-01',
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-000001',
        responsiblePersonIds: ['P-ALPHA-1'],
        verification: { required: false },
        createdById: 'P-ALPHA-1',
        createdAt: '2026-11-19T10:00:00.000Z',
        updatedById: 'P-ALPHA-1',
        updatedAt: '2026-11-19T10:00:00.000Z',
        version: 1,
      });

      await regRepo.createRegisterRecord(
        ctxA,
        {
          id: regId,
          registerTypeKey: 'complaint',
          reference: regId,
          title: 'Allow-list Complaint Register',
          status: 'open',
          matterId: allowListMatterId,
          enquiryId: null,
          personId: null,
          organisationId: null,
          ownerId: 'P-ALPHA-1',
          assignedApproverId: null,
          dueAt: null,
          reviewAt: null,
          reminderScheduleDays: [],
          fieldValues: {},
          createdById: 'P-ALPHA-1',
        },
        { recordInitialTransition: false },
      );

      // Unlisted P-ALPHA-2 sees ZERO rows across all 5 repositories!
      expect((await matterRepo.listVisibleMatters(ctxA, 'P-ALPHA-2')).some((m) => m.id === allowListMatterId)).toBe(false);
      expect(await matterRepo.getMatterById(ctxA, allowListMatterId, { viewerId: 'P-ALPHA-2' })).toBeNull();
      expect((await intakeRepo.listVisibleEnquiries(ctxA, 'P-ALPHA-2')).some((e) => e.id === enqId)).toBe(false);
      expect((await intakeRepo.listVisibleQuotes(ctxA, 'P-ALPHA-2')).some((q) => q.id === quoteId)).toBe(false);
      expect((await taskRepo.listVisibleTasks(ctxA, 'P-ALPHA-2')).some((t) => t.id === taskId)).toBe(false);
      expect((await taskRepo.listVisibleSignOffs(ctxA, 'P-ALPHA-2')).some((s) => s.id === signOffId)).toBe(false);
      expect((await kdRepo.listAllVisibleKeyDates(ctxA, 'P-ALPHA-2')).some((k) => k.id === kdId)).toBe(false);
      expect(await kdRepo.getKeyDateById(ctxA, kdId, 'P-ALPHA-2')).toBeNull();
      expect(await kdRepo.isMatterVisibleToViewer(ctxA, allowListMatterId, 'P-ALPHA-2')).toBe(false);
      expect((await regRepo.listVisibleRegisterRecords(ctxA, 'P-ALPHA-2')).some((r) => r.id === regId)).toBe(false);

      // Listed P-ALPHA-1 (positive control) sees ALL rows!
      expect((await matterRepo.listVisibleMatters(ctxA, 'P-ALPHA-1')).some((m) => m.id === allowListMatterId)).toBe(true);
      expect((await intakeRepo.listVisibleEnquiries(ctxA, 'P-ALPHA-1')).some((e) => e.id === enqId)).toBe(true);
      expect((await intakeRepo.listVisibleQuotes(ctxA, 'P-ALPHA-1')).some((q) => q.id === quoteId)).toBe(true);
      expect((await taskRepo.listVisibleTasks(ctxA, 'P-ALPHA-1')).some((t) => t.id === taskId)).toBe(true);
      expect((await taskRepo.listVisibleSignOffs(ctxA, 'P-ALPHA-1')).some((s) => s.id === signOffId)).toBe(true);
      expect((await kdRepo.listAllVisibleKeyDates(ctxA, 'P-ALPHA-1')).some((k) => k.id === kdId)).toBe(true);
      expect((await regRepo.listVisibleRegisterRecords(ctxA, 'P-ALPHA-1')).some((r) => r.id === regId)).toBe(true);

      // Tampered Tenant Bravo matter ID from Tenant Alpha saveTaskRecord session is rejected
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const verifiedA = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-ALPHA-1',
          tenantId: 'tenant-alpha',
          oid: '00000000-0000-4000-8000-00000000a001',
          tid: '11111111-2222-4333-8444-555555555555',
          sub: 'P-ALPHA-1',
          email: 'alpha1@tenant-alpha.example',
          displayName: 'Alpha User',
          entraRoles: ['partner', 'fee_earner'],
          mappedRoles: ['partner', 'fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        }),
      )!;
      setTestEntraSessionOverride(verifiedA);
      await runWithActiveActorSession(
        {
          personId: 'P-ALPHA-1',
          tenantId: 'tenant-alpha',
          tokenRoles: ['partner', 'fee_earner'],
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifiedA,
        },
        async () => {
          const crossTenantTask = await saveTaskRecord(
            {
              title: 'Cross-Tenant Tamper Task',
              dueAt: '2027-02-01',
              assignedPersonId: 'P-ALPHA-1',
              linkedRecords: [{ recordType: 'matter', recordId: bravoMatterId }],
            },
            'P-ALPHA-1',
          );
          expect(isActionDenied(crossTenantTask)).toBe(true);
          expect(crossTenantTask.code).toBe('FORBIDDEN');
        },
      );
      expect((await taskRepo.listVisibleTasks(ctxB, 'P-BRAVO-1')).length).toBe(0);

      // R535 two-tenant isolation: admin tokenRoles (matter:restricted:access) in Tenant Alpha must NEVER leak onto other responsible persons or manual reminder recipients, nor touch Tenant Bravo
      await partyRepo.putPerson(ctxA, {
        ...makePerson('P-ALPHA-ADM'),
        roles: ['admin', 'managing_partner'],
        appRole: 'admin',
        isEmployee: true,
      });
      await getHrAndRbacRepository().putTeam(ctxA, {
        id: 'TM-000001',
        name: 'Alpha Property',
        description: 'Alpha test team',
        leadIds: ['P-ALPHA-ADM'],
        memberIds: ['P-ALPHA-1', 'P-ALPHA-2', 'P-ALPHA-ADM'],
        practiceAreaIds: [],
        active: true,
        createdById: 'P-ALPHA-ADM',
        createdAt: '2026-11-19T10:00:00.000Z',
        updatedById: 'P-ALPHA-ADM',
        updatedAt: '2026-11-19T10:00:00.000Z',
      });
      const existingAlphaWallMatter = (await matterRepo.getMatterById(
        ctxA,
        allowListMatterId,
        { includeRestricted: true },
      ))!;
      await matterRepo.putMatter(
        ctxA,
        {
          ...existingAlphaWallMatter,
          teamMemberIds: ['P-ALPHA-1', 'P-ALPHA-ADM'],
          restrictedAccessUserIds: ['P-ALPHA-1', 'P-ALPHA-ADM'],
        },
        {
          expectedRowVersion: null,
          sqlRestrictedAccessUserIds: ['P-ALPHA-1', 'P-ALPHA-ADM'],
        },
      );
      const adminVerifiedA = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-ALPHA-ADM',
          tenantId: 'tenant-alpha',
          oid: '00000000-0000-4000-8000-00000000a099',
          tid: '11111111-2222-4333-8444-555555555555',
          sub: 'P-ALPHA-ADM',
          email: 'alpha-adm@tenant-alpha.example',
          displayName: 'Alpha Admin',
          entraRoles: ['admin', 'managing_partner'],
          mappedRoles: ['admin', 'managing_partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        }),
      )!;
      setTestEntraSessionOverride(adminVerifiedA);
      const adminTokenCtxA = resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-ALPHA-ADM',
          tenantId: 'tenant-alpha',
          name: 'Alpha Admin',
          email: 'alpha-adm@tenant-alpha.example',
          roles: ['admin', 'managing_partner'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-r535-alpha-adm',
      });
      await runWithActiveActorSession(
        {
          personId: 'P-ALPHA-ADM',
          tenantId: 'tenant-alpha',
          tokenRoles: ['admin', 'managing_partner'],
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: adminVerifiedA,
        },
        async () => {
          const r535CreateDenied = await createOrProposeKeyDateRecord(
            {
              matterId: allowListMatterId,
              keyDateTypeId: 'limitation',
              title: 'R535 Alpha Blocked Responsible',
              dueDate: '2027-02-15',
              intent: 'propose',
              teamId: 'TM-000001',
              responsiblePersonIds: ['P-ALPHA-2'],
            },
            'P-ALPHA-ADM',
          );
          expect(r535CreateDenied.ok).toBe(false);
          expect(r535CreateDenied.error).toMatch(/does not have access to restricted matter/i);
        },
      );

      // Update allow-list key date to list unpermitted P-ALPHA-2 + permitted P-ALPHA-1 and run manual reminder as admin tokenRoles in Tenant Alpha
      await kdRepo.putKeyDate(ctxA, {
        id: kdId,
        matterId: allowListMatterId,
        keyDateTypeId: 'limitation',
        category: 'limitation',
        title: 'Allow-list Key Date',
        dueDate: '2027-02-01',
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-000001',
        responsiblePersonIds: ['P-ALPHA-2', 'P-ALPHA-1'],
        verification: { required: false },
        createdById: 'P-ALPHA-1',
        createdAt: '2026-11-19T10:00:00.000Z',
        updatedById: 'P-ALPHA-1',
        updatedAt: '2026-11-19T10:00:00.000Z',
        version: 2,
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2027-02-01T10:00:00.000Z'));
      try {
        await executeKeyDateRemindersForTenant(adminTokenCtxA, {
          triggerSource: 'manual',
          triggeredById: 'P-ALPHA-ADM',
        });
      } finally {
        vi.useRealTimers();
      }
      const alphaTasksAfterR535 = await taskRepo.listAllTasksUnfiltered<{ assignedPersonId?: string | null; assignedPersonIds?: string[] }>(ctxA);
      expect(alphaTasksAfterR535.some((t) => t.assignedPersonId === 'P-ALPHA-2' || (t.assignedPersonIds ?? []).includes('P-ALPHA-2'))).toBe(false);
      expect(alphaTasksAfterR535.some((t) => t.assignedPersonId === 'P-ALPHA-1')).toBe(true);
      expect((await taskRepo.listAllNotificationsUnfiltered<{ recipientId: string }>(ctxA)).some((n) => n.recipientId === 'P-ALPHA-2')).toBe(false);
      expect((await taskRepo.listVisibleTasks(ctxB, 'P-BRAVO-1')).length).toBe(0);

      // R568 two-tenant isolation: a task linked to TWO key dates where the second key_date belongs to allowListMatterId
      // must be hidden from unpermitted P-ALPHA-2 in SQL task visibility and global search while visible to P-ALPHA-1 and leaving Bravo isolated
      await matterRepo.putMatter(
        ctxA,
        {
          ...structuredClone(seed.matters[0]!),
          id: `MAT-R568-OPEN-${suffix}`,
          matterNumber: `MAT-R568-OPEN-${suffix}`,
          title: 'Alpha Unrestricted Matter R568',
          clientId: 'P-ALPHA-1',
          responsiblePartnerId: 'P-ALPHA-1',
          supervisingPartnerId: 'P-ALPHA-1',
          leadFeeEarnerId: 'P-ALPHA-1',
          teamMemberIds: ['P-ALPHA-1', 'P-ALPHA-2'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: [],
          createdById: 'P-ALPHA-1',
          updatedById: 'P-ALPHA-1',
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await kdRepo.putKeyDate(ctxA, {
        id: `KD-R568-OPEN-${suffix}`,
        matterId: `MAT-R568-OPEN-${suffix}`,
        keyDateTypeId: 'limitation',
        category: 'limitation',
        title: 'R568 Alpha Open KeyDate',
        dueDate: '2027-02-01',
        isCritical: false,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-000001',
        responsiblePersonIds: ['P-ALPHA-1'],
        verification: { required: false },
        createdById: 'P-ALPHA-1',
        createdAt: '2026-11-19T10:00:00.000Z',
        updatedById: 'P-ALPHA-1',
        updatedAt: '2026-11-19T10:00:00.000Z',
        version: 1,
      });
      const r568TwoKdTaskId = `TSK-R568-ISO-${suffix}`;
      await taskRepo.putTask(ctxA, {
        ...structuredClone(seed.tasks[0]!),
        id: r568TwoKdTaskId,
        reference: r568TwoKdTaskId,
        title: `DualKdSecretR568 ${suffix}`,
        assignedTeamId: null,
        assignedPersonId: 'P-ALPHA-1',
        assignedPersonIds: ['P-ALPHA-1'],
        linkedKeyDateId: `KD-R568-OPEN-${suffix}`,
        linkedRecords: [
          { recordType: 'key_date', recordId: `KD-R568-OPEN-${suffix}` },
          { recordType: 'key_date', recordId: kdId },
        ] as unknown as Parameters<typeof taskRepo.putTask>[1]['linkedRecords'],
        createdById: 'P-ALPHA-1',
        updatedById: 'P-ALPHA-1',
      });
      expect((await taskRepo.listVisibleTasks(ctxA, 'P-ALPHA-2')).some((t) => t.id === r568TwoKdTaskId)).toBe(false);
      expect((await taskRepo.listVisibleTasks(ctxA, 'P-ALPHA-1')).some((t) => t.id === r568TwoKdTaskId)).toBe(true);
      const searchRepo = new TenantSearchRepository();
      const alphaP2Search = await searchRepo.searchRecords(ctxA, {
        query: `DualKdSecretR568`,
        entityTypes: ['task'],
        actor: {
          actorId: 'P-ALPHA-2',
          hasRestrictedMatterAccess: false,
          canViewDocuments: true,
          canViewQuotes: true,
          canViewFinance: false,
          canViewKeyDates: true,
          permittedDiaryTeamIds: ['TM-000001'],
          canViewRegisters: true,
          canManageUndertakings: true,
        },
      });
      expect(alphaP2Search.hits.some((h) => h.id === r568TwoKdTaskId)).toBe(false);
      const alphaP1Search = await searchRepo.searchRecords(ctxA, {
        query: `DualKdSecretR568`,
        entityTypes: ['task'],
        actor: {
          actorId: 'P-ALPHA-1',
          hasRestrictedMatterAccess: false,
          canViewDocuments: true,
          canViewQuotes: true,
          canViewFinance: false,
          canViewKeyDates: true,
          permittedDiaryTeamIds: ['TM-000001'],
          canViewRegisters: true,
          canManageUndertakings: true,
        },
      });
      expect(alphaP1Search.hits.some((h) => h.id === r568TwoKdTaskId)).toBe(true);
      const bravoSearch = await searchRepo.searchRecords(ctxB, {
        query: `DualKdSecretR568`,
        entityTypes: ['task'],
        actor: {
          actorId: 'P-BRAVO-1',
          hasRestrictedMatterAccess: true,
          canViewDocuments: true,
          canViewQuotes: true,
          canViewFinance: false,
          canViewKeyDates: true,
          permittedDiaryTeamIds: ['TM-000001'],
          canViewRegisters: true,
          canManageUndertakings: true,
        },
      });
      expect(bravoSearch.hits).toHaveLength(0);
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await getHrAndRbacRepository().clearTenantData(ctxA).catch(() => undefined);
      await regRepo.clearTenantData(ctxA).catch(() => undefined);
      await kdRepo.clearTenantData(ctxA).catch(() => undefined);
      await taskRepo.clearTenantData(ctxA).catch(() => undefined);
      await taskRepo.clearTenantData(ctxB).catch(() => undefined);
      await intakeRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
    }
  });

  it('R510 (B20): refuses opening a new matter without a conflictCheckRecord while preserving normal clearance, referred blocking, stored Not started/In progress submit_cleared, PMS import, and two-tenant isolation', async () => {
    const rawBase = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'client-not-a-law-firm', 'config', 'base.json'),
        'utf8',
      ),
    ) as import('../src/api').TenantConfiguration;
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        name: 'Alpha Partner',
        email: 'alpha510@tenant-alpha.example',
        roles: ['partner', 'fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r510-alpha',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-1',
        tenantId: 'tenant-bravo',
        name: 'Bravo Partner',
        email: 'bravo510@tenant-bravo.example',
        roles: ['partner', 'fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r510-bravo',
    });
    const matterRepo = getMatterRepository();
    const partyRepo = getPartyRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const hrRepo = getHrAndRbacRepository();
    const taskRepo = getTaskWorkflowRepository();

    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const store = loadCommittedSeedStore();
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const adminUser = store.people.find((p) => p.id === 'P-000004')!;
      const clientOrg = store.organisations.find((o) => o.id === 'O-000001')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

      const makeSession = (
        person: typeof feeEarner,
        roles: string[],
        email: string,
      ) => {
        const cookie = createSignedEntraSessionCookie({
          personId: person.id,
          tenantId: 'not-a-law-firm',
          oid: person.entraObjectId ?? `00000000-0000-4000-8000-${person.id.replace(/\D/g, '').padStart(12, '0')}`,
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
          mfaVerified: true,
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession: verifySignedEntraSessionCookie(cookie)!,
        };
      };

      const feSession = makeSession(feeEarner, ['fee_earner'], 'fe-r510@notalawfirm.example');
      const adminSession = makeSession(adminUser, ['admin'], 'admin-r510@notalawfirm.example');

      const baseNewInput = {
        title: 'R510 Invented Matter Without Conflict Check',
        clientId: clientOrg.id,
        practiceAreaId: 'work_type.real_estate_and_property',
        workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
        responsiblePartnerId: 'P-000001',
        supervisingPartnerId: 'P-000001',
        leadFeeEarnerId: feeEarner.id,
        teamMemberIds: [feeEarner.id, 'P-000001'],
        agreedFeeCapGbp: 5000,
        feeEstimateGbp: 5000,
      };

      // (a) Bypass test: brand-new matter with saveMode: 'submit_cleared' and NO conflictCheckRecord must NOT open
      const bypassSubmitCleared = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput },
          { byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(bypassSubmitCleared.matter).toBeNull();
      expect(bypassSubmitCleared.errors?.conflict).toBe(
        'Run and record a conflict check before opening this matter.',
      );

      // (a2) Plain save (saveMode omitted) requesting open status without conflictCheckRecord must also fail
      const bypassPlainOpen = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, matterStatusId: 'matter_status.active' },
          { byId: feeEarner.id },
        ),
      );
      expect(bypassPlainOpen.matter).toBeNull();
      expect(bypassPlainOpen.errors?.conflict).toBe(
        'Run and record a conflict check before opening this matter.',
      );

      // (b) Normal clearance with a recorded ConflictCheckRecord opens
      const clearedRecord = {
        status: 'Cleared' as const,
        outcomeLabel: 'Cleared by fee earner' as const,
        declarationConfirmed: true,
        reviewerMessage: 'Conflicts searched and cleared.',
        lastRunAtDisplay: '19 Nov 2026',
        lastRunById: feeEarner.id,
        lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
        submittedAtDisplay: '19 Nov 2026',
        submittedById: feeEarner.id,
        submittedByName: `${feeEarner.firstName} ${feeEarner.surname}`,
        approvedAtDisplay: null,
        approvedById: null,
        approvedByName: null,
        parties: [],
        matches: [],
        comments: [],
        runs: [],
      };
      const normalOpen = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'R510 Cleared Opening',
            conflictCheckRecord: clearedRecord,
          },
          { byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(normalOpen.errors).toBeUndefined();
      expect(normalOpen.matter).not.toBeNull();
      expect(normalOpen.matter?.matterStatusId).not.toBe('matter_status.prospective');
      expect(normalOpen.matter?.conflictCheckRecord?.status).toBe('Cleared');

      // (c) Referred conflict record blocks fee earner from opening
      const referredSave = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'R510 Referred Matter',
            conflictCheckRecord: {
              ...clearedRecord,
              status: 'Referred',
              outcomeLabel: 'Referred to risk for review',
            },
          },
          { byId: feeEarner.id, saveMode: 'submit_referred' },
        ),
      );
      expect(referredSave.errors).toBeUndefined();
      expect(referredSave.matter).not.toBeNull();
      const referredReopen = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, title: 'R510 Referred Matter' },
          { id: referredSave.matter!.id, byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(referredReopen.matter).toBeNull();
      expect(referredReopen.errors?.conflict).toContain('referred to Risk');

      // (d) Stored 'Not started' and 'In progress' conflictCheckRecord + submit_cleared still opens (owner decision)
      for (const initialStatus of ['Not started', 'In progress'] as const) {
        const draftRes = await runWithActiveActorSession(feSession, async () =>
          saveMatterRecord(
            {
              ...baseNewInput,
              title: `R510 Stored ${initialStatus} Draft`,
              conflictCheckRecord: {
                ...clearedRecord,
                status: initialStatus,
                outcomeLabel: 'Pending',
              },
            },
            { byId: feeEarner.id, saveMode: 'draft' },
          ),
        );
        expect(draftRes.errors).toBeUndefined();
        expect(draftRes.matter?.conflictCheckRecord?.status).toBe(initialStatus);

        const promotedOpen = await runWithActiveActorSession(feSession, async () =>
          saveMatterRecord(
            {
              ...baseNewInput,
              title: `R510 Stored ${initialStatus} Draft`,
            },
            { id: draftRes.matter!.id, byId: feeEarner.id, saveMode: 'submit_cleared' },
          ),
        );
        expect(promotedOpen.errors).toBeUndefined();
        expect(promotedOpen.matter).not.toBeNull();
        expect(promotedOpen.matter?.conflictCheckRecord?.status).toBe('Cleared');
      }

      // (e) PMS import path still opens without conflictCheckRecord and records 'Not started' (not 'Clear')
      const pmsBundle = await runWithActiveActorSession(adminSession, async () =>
        getMatterPmsViewBundle('M-000001', adminUser.id),
      );
      expect(isActionDenied(pmsBundle)).toBe(false);
      if (isActionDenied(pmsBundle) || pmsBundle.allUnlinkedPmsMatters.length === 0) {
        throw new Error('Expected at least one unlinked PMS matter in seed workbook.');
      }
      const unlinkedCode = pmsBundle.allUnlinkedPmsMatters[0]!.matter_code;
      const pmsImportRes = await runWithActiveActorSession(adminSession, async () =>
        createRecordFromPms('matter', unlinkedCode, adminUser.id, { mfaVerified: true }),
      );
      expect(pmsImportRes.ok).toBe(true);
      expect(pmsImportRes.createdId).toBeDefined();
      const importedMatter = await matterRepo.getMatterById<import('../../src/domain/types').Matter>(
        testTenantCtx(adminUser.id),
        pmsImportRes.createdId!,
        { includeRestricted: true },
      );
      expect(importedMatter).not.toBeNull();
      expect((importedMatter as { conflictCheckStatus?: string })?.conflictCheckStatus).not.toBe('Clear');
      expect((importedMatter as { isPmsImport?: boolean })?.isPmsImport).toBe(true);
      const pmsComplianceRows = resolveMatterIntakeComplianceRows(importedMatter!, {
        overallRisk: null,
        completedQuestions: 0,
        totalQuestions: 0,
      });
      expect(pmsComplianceRows.conflictCheck.label).toBe(
        'Imported from PMS: conflict check recorded in the source system',
      );

      // (f) Two-tenant variant: cross-tenant opts.id from Tenant Bravo cannot be opened or read in Tenant Alpha
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-bravo', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      );
      await partyRepo.putPerson(ctxB, {
        ...feeEarner,
        id: 'P-BRAVO-1',
        firstName: 'Bravo',
        surname: 'Partner',
        roles: ['partner', 'fee_earner'],
        isEmployee: true,
        isLeaver: false,
      });
      await partyRepo.putOrganisation(ctxB, {
        ...clientOrg,
        id: 'O-BRAVO-1',
        legalName: 'Bravo Invented Holdings Ltd',
      });
      const bravoMatterSeed = store.matters.find((m) => m.id === 'M-000001')!;
      const bravoMatterId = 'M-BRAVO-R510';
      await matterRepo.putMatter(
        ctxB,
        {
          ...bravoMatterSeed,
          id: bravoMatterId,
          matterNumber: 'BRV510-0001',
          title: 'Bravo Prospective Matter',
          clientId: 'O-BRAVO-1',
          matterStatusId: 'matter_status.prospective',
          conflictCheckStatus: 'Not started',
          conflictCheckRecord: {
            ...clearedRecord,
            status: 'Not started',
            outcomeLabel: 'Pending',
          },
          responsiblePartnerId: 'P-BRAVO-1',
          supervisingPartnerId: 'P-BRAVO-1',
          leadFeeEarnerId: 'P-BRAVO-1',
          teamMemberIds: ['P-BRAVO-1'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );

      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );
      await partyRepo.putPerson(ctxA, {
        ...feeEarner,
        id: 'P-ALPHA-1',
        firstName: 'Alpha',
        surname: 'Partner',
        roles: ['partner', 'fee_earner'],
        isEmployee: true,
        isLeaver: false,
      });
      await partyRepo.putOrganisation(ctxA, {
        ...clientOrg,
        id: 'O-ALPHA-1',
        legalName: 'Alpha Invented Holdings Ltd',
      });
      const alphaSession = {
        personId: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        tokenRoles: ['partner', 'fee_earner'],
        mfaVerified: true,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: 'P-ALPHA-1',
            tenantId: 'tenant-alpha',
            oid: '00000000-0000-4000-8000-00000000a510',
            tid: '11111111-2222-4333-8444-555555555555',
            sub: 'P-ALPHA-1',
            email: 'alpha510@tenant-alpha.example',
            displayName: 'Alpha Partner',
            entraRoles: ['partner', 'fee_earner'],
            mappedRoles: ['partner', 'fee_earner'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: nowIso,
            expiresAt,
          }),
        )!,
      };
      setTestEntraSessionOverride(alphaSession.verifiedSession);
      const crossTenantOpen = await runWithActiveActorSession(alphaSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            clientId: 'O-ALPHA-1',
            responsiblePartnerId: 'P-ALPHA-1',
            supervisingPartnerId: 'P-ALPHA-1',
            leadFeeEarnerId: 'P-ALPHA-1',
            teamMemberIds: ['P-ALPHA-1'],
            conflictCheckRecord: clearedRecord,
          },
          { id: bravoMatterId, byId: 'P-ALPHA-1', saveMode: 'submit_cleared' },
        ),
      );
      expect(crossTenantOpen.matter).toBeNull();
      expect(crossTenantOpen.errors?.access).toBeDefined();
      const bravoAfter = await matterRepo.getMatterById<import('../../src/domain/types').Matter>(
        ctxB,
        bravoMatterId,
        { includeRestricted: true },
      );
      expect(bravoAfter?.matterStatusId).toBe('matter_status.prospective');
      expect(bravoAfter?.conflictCheckRecord?.status).toBe('Not started');
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await taskRepo.clearTenantData(ctxA).catch(() => undefined);
      await intakeRepo.clearTenantData(ctxA).catch(() => undefined);
      await hrRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R536: refuses submit_cleared after draft with no persisted conflictCheckRecord and for unopened legacy-only Clear matters, allows submit_referred and persisted In progress -> submit_cleared, and isolates across two tenants', async () => {
    const rawBase = JSON.parse(JSON.stringify(notALawFirmBaseConfig));
    setActiveTenantConfigForTesting(rawBase, {
      tenantId: 'not-a-law-firm',
      environment: 'test',
    });
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        name: 'Alpha Partner',
        email: 'alpha@tenant-alpha.example',
        roles: ['partner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r536-alpha',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-1',
        tenantId: 'tenant-bravo',
        name: 'Bravo Partner',
        email: 'bravo@tenant-bravo.example',
        roles: ['partner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r536-bravo',
    });
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const hrRepo = getHrAndRbacRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();

    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const seed = loadCommittedSeedStore();
      const feeEarner = seed.people.find((p) => p.id === 'P-000002')!;
      const clientOrg = seed.organisations.find((o) => !o.mergedIntoId)!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const feSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        mfaVerified: true,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: feeEarner.id,
            tenantId: 'not-a-law-firm',
            oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000002',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: feeEarner.id,
            email: 'fe-r536@notalawfirm.example',
            displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
            entraRoles: ['fee_earner'],
            mappedRoles: ['fee_earner'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: nowIso,
            expiresAt,
          }),
        )!,
      };
      const baseNewInput = {
        title: 'R536 Draft Then Submit Cleared Bypass',
        clientId: clientOrg.id,
        practiceAreaId: 'work_type.real_estate_and_property',
        workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
        responsiblePartnerId: 'P-000001',
        supervisingPartnerId: 'P-000001',
        leadFeeEarnerId: feeEarner.id,
        teamMemberIds: [feeEarner.id, 'P-000001'],
        agreedFeeCapGbp: 5000,
        feeEstimateGbp: 5000,
      };

      // 1. Draft with NO conflictCheckRecord, then save same ID with submit_cleared MUST be refused
      setTestEntraSessionOverride(feSession.verifiedSession);
      const draftNoRecord = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord({ ...baseNewInput }, { byId: feeEarner.id, saveMode: 'draft' }),
      );
      expect(draftNoRecord.matter).not.toBeNull();
      const draftId = draftNoRecord.matter!.id;
      const draftReFetched = await matterRepo.getMatterById<import('../../src/domain/types').Matter>(
        testTenantCtx(feeEarner.id),
        draftId,
        { includeRestricted: true },
      );
      expect(draftReFetched?.conflictCheckRecord).toBeUndefined();

      const bypassAfterDraft = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, title: 'R536 Bypass After Draft' },
          { id: draftId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(bypassAfterDraft.matter).toBeNull();
      expect(bypassAfterDraft.errors?.conflict).toBe(
        'Run and record a conflict check before opening this matter.',
      );

      // 2. Draft with no record -> submit_referred is allowed (stays Prospective / Referred)
      const referFromDraft = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, title: 'R536 Referred After Draft' },
          { id: draftId, byId: feeEarner.id, saveMode: 'submit_referred' },
        ),
      );
      expect(referFromDraft.matter).not.toBeNull();
      expect(referFromDraft.matter?.matterStatusId).toBe('matter_status.prospective_enquiry');
      expect(referFromDraft.matter?.conflictCheckRecord?.status).toBe('Referred');

      // 3. Persisted In progress record -> submit_cleared opens
      const inProgressDraft = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'R536 Persisted In Progress',
            conflictCheckRecord: {
              status: 'In progress',
              outcomeLabel: 'Pending',
              declarationConfirmed: false,
              reviewerMessage: '',
              lastRunAtDisplay: '19 Nov 2026',
              lastRunById: feeEarner.id,
              lastRunByName: `${feeEarner.firstName} ${feeEarner.surname}`,
              submittedAtDisplay: '19 Nov 2026',
              submittedById: feeEarner.id,
              submittedByName: `${feeEarner.firstName} ${feeEarner.surname}`,
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
          },
          { byId: feeEarner.id, saveMode: 'draft' },
        ),
      );
      expect(inProgressDraft.matter?.conflictCheckRecord?.status).toBe('In progress');
      const openPersisted = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, title: 'R536 Persisted In Progress' },
          { id: inProgressDraft.matter!.id, byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(openPersisted.matter).not.toBeNull();
      expect(openPersisted.matter?.conflictCheckRecord?.status).toBe('Cleared');
      expect(openPersisted.matter?.matterStatusId).not.toBe('matter_status.prospective_enquiry');
      expect(openPersisted.matter?.openedAt).toBeTruthy();

      // 4. Legacy-only Prospective matter (conflictCheckStatus: 'Clear', no persisted conflictCheckRecord, openedAt: null) -> refused on submit_cleared
      const legacyOnlyMatterId = 'M-R536-LEGACY-CLEAR';
      const templateMatter = seed.matters.find((m) => m.id === 'M-000001')!;
      await matterRepo.putMatter(
        testTenantCtx(feeEarner.id),
        {
          ...structuredClone(templateMatter),
          id: legacyOnlyMatterId,
          matterNumber: 'MAT-R536-LEG',
          title: 'R536 Legacy Clear Only Unopened',
          clientId: clientOrg.id,
          matterStatusId: 'matter_status.prospective',
          openedAt: null,
          conflictCheckStatus: 'Clear',
          conflictCheckRecord: undefined,
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: feeEarner.id,
          teamMemberIds: [feeEarner.id, 'P-000001'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      const legacyOpenDenied = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          { ...baseNewInput, title: 'R536 Legacy Clear Only Unopened' },
          { id: legacyOnlyMatterId, byId: feeEarner.id, saveMode: 'submit_cleared' },
        ),
      );
      expect(legacyOpenDenied.matter).toBeNull();
      expect(legacyOpenDenied.errors?.conflict).toBe(
        'Run and record a conflict check before opening this matter.',
      );

      // 5. Two-tenant variant in Tenant Alpha vs Tenant Bravo
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-bravo', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      );
      await partyRepo.putPerson(ctxB, { ...feeEarner, id: 'P-BRAVO-1', firstName: 'Bravo', surname: 'User' });
      await partyRepo.putOrganisation(ctxB, { ...clientOrg, id: 'O-BRAVO-1', legalName: 'Bravo Corp Ltd' });
      await matterRepo.putMatter(
        ctxB,
        {
          ...structuredClone(templateMatter),
          id: 'M-BRAVO-R536',
          matterNumber: 'BRV-536',
          title: 'Bravo Unopened Legacy Clear',
          clientId: 'O-BRAVO-1',
          matterStatusId: 'matter_status.prospective',
          openedAt: null,
          conflictCheckStatus: 'Clear',
          conflictCheckRecord: undefined,
          responsiblePartnerId: 'P-BRAVO-1',
          supervisingPartnerId: 'P-BRAVO-1',
          leadFeeEarnerId: 'P-BRAVO-1',
          teamMemberIds: ['P-BRAVO-1'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );

      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );
      await partyRepo.putPerson(ctxA, {
        ...feeEarner,
        id: 'P-ALPHA-1',
        firstName: 'Alpha',
        surname: 'FeeEarner',
        roles: ['fee_earner'],
      });
      await partyRepo.putOrganisation(ctxA, { ...clientOrg, id: 'O-ALPHA-1', legalName: 'Alpha Corp Ltd' });
      const alphaSession = {
        personId: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        tokenRoles: ['fee_earner'],
        mfaVerified: true,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: 'P-ALPHA-1',
            tenantId: 'tenant-alpha',
            oid: '00000000-0000-4000-8000-00000000a536',
            tid: '11111111-2222-4333-8444-555555555555',
            sub: 'P-ALPHA-1',
            email: 'alpha536@tenant-alpha.example',
            displayName: 'Alpha FeeEarner',
            entraRoles: ['fee_earner'],
            mappedRoles: ['fee_earner'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: nowIso,
            expiresAt,
          }),
        )!,
      };
      setTestEntraSessionOverride(alphaSession.verifiedSession);
      const alphaDraft = await runWithActiveActorSession(alphaSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'Alpha R536 Draft',
            clientId: 'O-ALPHA-1',
            responsiblePartnerId: 'P-ALPHA-1',
            supervisingPartnerId: 'P-ALPHA-1',
            leadFeeEarnerId: 'P-ALPHA-1',
            teamMemberIds: ['P-ALPHA-1'],
          },
          { byId: 'P-ALPHA-1', saveMode: 'draft' },
        ),
      );
      expect(alphaDraft.matter).not.toBeNull();
      const alphaSubmitDenied = await runWithActiveActorSession(alphaSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'Alpha R536 Submit Cleared',
            clientId: 'O-ALPHA-1',
            responsiblePartnerId: 'P-ALPHA-1',
            supervisingPartnerId: 'P-ALPHA-1',
            leadFeeEarnerId: 'P-ALPHA-1',
            teamMemberIds: ['P-ALPHA-1'],
          },
          { id: alphaDraft.matter!.id, byId: 'P-ALPHA-1', saveMode: 'submit_cleared' },
        ),
      );
      expect(alphaSubmitDenied.matter).toBeNull();
      expect(alphaSubmitDenied.errors?.conflict).toBe(
        'Run and record a conflict check before opening this matter.',
      );
      const crossTenantDenied = await runWithActiveActorSession(alphaSession, async () =>
        saveMatterRecord(
          {
            ...baseNewInput,
            title: 'Forged Cross-Tenant Bypass',
            clientId: 'O-ALPHA-1',
            responsiblePartnerId: 'P-ALPHA-1',
            supervisingPartnerId: 'P-ALPHA-1',
            leadFeeEarnerId: 'P-ALPHA-1',
            teamMemberIds: ['P-ALPHA-1'],
          },
          { id: 'M-BRAVO-R536', byId: 'P-ALPHA-1', saveMode: 'submit_cleared' },
        ),
      );
      expect(crossTenantDenied.matter).toBeNull();
      expect(crossTenantDenied.errors?.access).toBeDefined();
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await taskRepo.clearTenantData(ctxA).catch(() => undefined);
      await intakeRepo.clearTenantData(ctxA).catch(() => undefined);
      await hrRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R537: refuses closing an unopened or Prospective matter (preventing close -> reopen -> Active bypass), allows closing/reopening an opened matter, and isolates across two tenants', async () => {
    const rawBase = JSON.parse(JSON.stringify(notALawFirmBaseConfig));
    setActiveTenantConfigForTesting(rawBase, {
      tenantId: 'not-a-law-firm',
      environment: 'test',
    });
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        name: 'Alpha User',
        email: 'alpha@tenant-alpha.example',
        roles: ['fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r537-alpha',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-1',
        tenantId: 'tenant-bravo',
        name: 'Bravo User',
        email: 'bravo@tenant-bravo.example',
        roles: ['fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r537-bravo',
    });
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const hrRepo = getHrAndRbacRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();

    try {
      await resetAllDemoData('P-000001', testDataResetContext());
      const seed = loadCommittedSeedStore();
      const feeEarner = seed.people.find((p) => p.id === 'P-000002')!;
      const clientOrg = seed.organisations.find((o) => !o.mergedIntoId)!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const feSession = {
        personId: feeEarner.id,
        tenantId: 'not-a-law-firm',
        tokenRoles: ['fee_earner'],
        mfaVerified: true,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: feeEarner.id,
            tenantId: 'not-a-law-firm',
            oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000002',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: feeEarner.id,
            email: 'fe-r537@notalawfirm.example',
            displayName: `${feeEarner.firstName} ${feeEarner.surname}`,
            entraRoles: ['fee_earner'],
            mappedRoles: ['fee_earner'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: nowIso,
            expiresAt,
          }),
        )!,
      };
      setTestEntraSessionOverride(feSession.verifiedSession);

      // Seed a Prospective matter that has no conflictCheckRecord (even with an openedAt placeholder date, e.g. seeded Prospective matter)
      const prospectiveMatterId = 'M-R537-PROSPECTIVE';
      const templateMatter = seed.matters.find((m) => m.id === 'M-000001')!;
      await matterRepo.putMatter(
        testTenantCtx(feeEarner.id),
        {
          ...structuredClone(templateMatter),
          id: prospectiveMatterId,
          matterNumber: 'MAT-R537-PROS',
          title: 'R537 Prospective Without Conflict Record',
          clientId: clientOrg.id,
          matterStatusId: 'matter_status.prospective',
          openedAt: '2026-01-10',
          conflictCheckStatus: 'Draft',
          conflictCheckRecord: undefined,
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: feeEarner.id,
          teamMemberIds: [feeEarner.id, 'P-000001'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );

      // 1. Attempt close -> reopen bypass on Prospective matter MUST be refused on close and must NEVER become Active
      const closeProspectiveRes = await runWithActiveActorSession(feSession, async () =>
        updateMatterLifecycleStatusRecord(
          prospectiveMatterId,
          'close',
          { closedAt: '2026-11-19', reason: 'Bypass test' },
          feeEarner.id,
        ),
      );
      expect(closeProspectiveRes.matter).toBeNull();
      expect(closeProspectiveRes.errors?.matterStatusId).toBe(
        'This matter has not been opened. Delete or abandon it instead of closing it.',
      );
      const afterCloseAttempt = await matterRepo.getMatterById<import('../../src/domain/types').Matter>(
        testTenantCtx(feeEarner.id),
        prospectiveMatterId,
        { includeRestricted: true },
      );
      expect(afterCloseAttempt?.matterStatusId).toBe('matter_status.prospective');
      const reopenProspectiveRes = await runWithActiveActorSession(feSession, async () =>
        updateMatterLifecycleStatusRecord(
          prospectiveMatterId,
          'reopen',
          { reason: 'Bypass reopen check' },
          feeEarner.id,
        ),
      );
      expect(reopenProspectiveRes.matter).toBeNull();

      // 2. Also test draft matter with openedAt: null
      const draftNullOpened = await runWithActiveActorSession(feSession, async () =>
        saveMatterRecord(
          {
            title: 'R537 Draft With Null OpenedAt',
            clientId: clientOrg.id,
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: feeEarner.id,
            teamMemberIds: [feeEarner.id, 'P-000001'],
          },
          { byId: feeEarner.id, saveMode: 'draft' },
        ),
      );
      const closeDraftRes = await runWithActiveActorSession(feSession, async () =>
        updateMatterLifecycleStatusRecord(
          draftNullOpened.matter!.id,
          'close',
          { closedAt: '2026-11-19', reason: 'Close draft' },
          feeEarner.id,
        ),
      );
      expect(closeDraftRes.matter).toBeNull();
      expect(closeDraftRes.errors?.matterStatusId).toBe(
        'This matter has not been opened. Delete or abandon it instead of closing it.',
      );

      // 3. Normal opened Active matter (with no blocking open key dates) still closes and reopens cleanly
      const openMatterId = 'M-R537-OPEN';
      await matterRepo.putMatter(
        testTenantCtx(feeEarner.id),
        {
          ...structuredClone(templateMatter),
          id: openMatterId,
          matterNumber: 'MAT-R537-OPEN',
          title: 'R537 Opened Active Matter',
          clientId: clientOrg.id,
          matterStatusId: 'matter_status.active',
          openedAt: '2026-01-10',
          amlStatus: 'Verified',
          conflictCheckStatus: 'Clear',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: feeEarner.id,
          teamMemberIds: [feeEarner.id, 'P-000001'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      const closeOpenedRes = await runWithActiveActorSession(feSession, async () =>
        updateMatterLifecycleStatusRecord(
          openMatterId,
          'close',
          { reason: 'Normal close' },
          feeEarner.id,
        ),
      );
      expect(closeOpenedRes.matter?.matterStatusId).toBe('matter_status.closed');
      const reopenOpenedRes = await runWithActiveActorSession(feSession, async () =>
        updateMatterLifecycleStatusRecord(
          openMatterId,
          'reopen',
          { reason: 'Normal reopen' },
          feeEarner.id,
        ),
      );
      expect(reopenOpenedRes.matter?.matterStatusId).toBe('matter_status.active');

      // 4. Two-tenant isolation: cross-tenant close/reopen from Tenant Alpha targeting Tenant Bravo's matter fails closed
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-bravo', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      );
      await partyRepo.putPerson(ctxB, { ...feeEarner, id: 'P-BRAVO-1', firstName: 'Bravo', surname: 'User' });
      await partyRepo.putOrganisation(ctxB, { ...clientOrg, id: 'O-BRAVO-1', legalName: 'Bravo Corp Ltd' });
      await matterRepo.putMatter(
        ctxB,
        {
          ...structuredClone(templateMatter),
          id: 'M-BRAVO-R537',
          matterNumber: 'BRV-537',
          title: 'Bravo Prospective Matter',
          clientId: 'O-BRAVO-1',
          matterStatusId: 'matter_status.prospective',
          openedAt: '2026-01-10',
          conflictCheckRecord: undefined,
          responsiblePartnerId: 'P-BRAVO-1',
          supervisingPartnerId: 'P-BRAVO-1',
          leadFeeEarnerId: 'P-BRAVO-1',
          teamMemberIds: ['P-BRAVO-1'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );
      await partyRepo.putPerson(ctxA, {
        ...feeEarner,
        id: 'P-ALPHA-1',
        firstName: 'Alpha',
        surname: 'User',
        roles: ['fee_earner'],
      });
      await partyRepo.putOrganisation(ctxA, { ...clientOrg, id: 'O-ALPHA-1', legalName: 'Alpha Corp Ltd' });
      await matterRepo.putMatter(
        ctxA,
        {
          ...structuredClone(templateMatter),
          id: 'M-ALPHA-R537',
          matterNumber: 'ALP-537',
          title: 'Alpha Prospective Matter',
          clientId: 'O-ALPHA-1',
          matterStatusId: 'matter_status.prospective',
          openedAt: '2026-01-10',
          conflictCheckRecord: undefined,
          responsiblePartnerId: 'P-ALPHA-1',
          supervisingPartnerId: 'P-ALPHA-1',
          leadFeeEarnerId: 'P-ALPHA-1',
          teamMemberIds: ['P-ALPHA-1'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      const alphaSession = {
        personId: 'P-ALPHA-1',
        tenantId: 'tenant-alpha',
        tokenRoles: ['fee_earner'],
        mfaVerified: true,
        expiresAtMs: Date.parse(expiresAt),
        verifiedSession: verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: 'P-ALPHA-1',
            tenantId: 'tenant-alpha',
            oid: '00000000-0000-4000-8000-00000000a537',
            tid: '11111111-2222-4333-8444-555555555555',
            sub: 'P-ALPHA-1',
            email: 'alpha537@tenant-alpha.example',
            displayName: 'Alpha User',
            entraRoles: ['fee_earner'],
            mappedRoles: ['fee_earner'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: nowIso,
            expiresAt,
          }),
        )!,
      };
      setTestEntraSessionOverride(alphaSession.verifiedSession);
      const alphaCloseOwn = await runWithActiveActorSession(alphaSession, async () =>
        updateMatterLifecycleStatusRecord('M-ALPHA-R537', 'close', { reason: 'Close' }, 'P-ALPHA-1'),
      );
      expect(alphaCloseOwn.matter).toBeNull();
      expect(alphaCloseOwn.errors?.matterStatusId).toBe(
        'This matter has not been opened. Delete or abandon it instead of closing it.',
      );
      const crossClose = await runWithActiveActorSession(alphaSession, async () =>
        updateMatterLifecycleStatusRecord('M-BRAVO-R537', 'close', { reason: 'Cross' }, 'P-ALPHA-1'),
      );
      expect(crossClose.matter).toBeNull();
      expect(crossClose.code).toBe('NOT_FOUND');
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await taskRepo.clearTenantData(ctxA).catch(() => undefined);
      await intakeRepo.clearTenantData(ctxA).catch(() => undefined);
      await hrRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
  it('R526 two-tenant isolation: getMatterFinanceRows restricts non-finance:view actors to own/team matters in their verified tenant and rejects cross-tenant IDs and forged tenant claims', async () => {
    const rawBase = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-FE',
        tenantId: 'tenant-alpha',
        name: 'Alpha Fee Earner',
        email: 'alpha-fe@tenant-alpha.example',
        roles: ['fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r526-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-FE',
        tenantId: 'tenant-bravo',
        name: 'Bravo Fee Earner',
        email: 'bravo-fe@tenant-bravo.example',
        roles: ['fee_earner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r526-b',
    });

    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const pmsRepo = getPmsRepository();
    const store = loadCommittedSeedStore();

    try {
      await pmsRepo.clearTenantData(ctxA).catch(() => undefined);
      await pmsRepo.clearTenantData(ctxB).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);

      const feTemplate = store.people.find((p) => p.id === 'P-000002')!;
      const partnerTemplate = store.people.find((p) => p.id === 'P-000001')!;
      const orgTemplate = store.organisations.find((o) => o.id === 'O-000001')!;
      const matterTemplate = store.matters.find((m) => m.id === 'M-000001')!;

      await partyRepo.putPeople(ctxA, [
        {
          ...feTemplate,
          id: 'P-ALPHA-FE',
          firstName: 'Alpha',
          surname: 'FeeEarner',
          roles: ['fee_earner'],
          permissionOverrides: undefined,
        },
        {
          ...partnerTemplate,
          id: 'P-ALPHA-PARTNER',
          firstName: 'Alpha',
          surname: 'Partner',
          roles: ['partner', 'fee_earner'],
          permissionOverrides: undefined,
        },
      ]);
      await partyRepo.putOrganisation(ctxA, {
        ...orgTemplate,
        id: 'O-ALPHA-R526',
        legalName: 'Alpha Client Ltd',
      });
      await partyRepo.putPerson(ctxB, {
        ...feTemplate,
        id: 'P-BRAVO-FE',
        firstName: 'Bravo',
        surname: 'FeeEarner',
        roles: ['fee_earner'],
        permissionOverrides: undefined,
      });
      await partyRepo.putOrganisation(ctxB, {
        ...orgTemplate,
        id: 'O-BRAVO-R526',
        legalName: 'Bravo Client Ltd',
      });

      // Tenant Alpha has two linked unrestricted matters: OWN (owned by P-ALPHA-FE) and OTHER (owned only by P-ALPHA-PARTNER)
      await matterRepo.putMatter(
        ctxA,
        {
          ...matterTemplate,
          id: 'M-ALPHA-OWN',
          matterNumber: 'PEN001-0001',
          title: 'Alpha Own Matter',
          clientId: 'O-ALPHA-R526',
          responsiblePartnerId: 'P-ALPHA-PARTNER',
          supervisingPartnerId: 'P-ALPHA-PARTNER',
          leadFeeEarnerId: 'P-ALPHA-FE',
          teamMemberIds: ['P-ALPHA-FE'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: [],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await matterRepo.putMatter(
        ctxA,
        {
          ...matterTemplate,
          id: 'M-ALPHA-OTHER',
          matterNumber: 'PRI001-0001',
          title: 'Alpha Non-Team Matter',
          clientId: 'O-ALPHA-R526',
          responsiblePartnerId: 'P-ALPHA-PARTNER',
          supervisingPartnerId: 'P-ALPHA-PARTNER',
          leadFeeEarnerId: 'P-ALPHA-PARTNER',
          teamMemberIds: ['P-ALPHA-PARTNER'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: [],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await matterRepo.putMatter(
        ctxB,
        {
          ...matterTemplate,
          id: 'M-BRAVO-OWN',
          matterNumber: 'SEV001-0001',
          title: 'Bravo Own Matter',
          clientId: 'O-BRAVO-R526',
          responsiblePartnerId: 'P-BRAVO-FE',
          supervisingPartnerId: 'P-BRAVO-FE',
          leadFeeEarnerId: 'P-BRAVO-FE',
          teamMemberIds: ['P-BRAVO-FE'],
          isStaffMatter: false,
          hasEthicalWall: false,
          restrictedAccessUserIds: [],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );

      await pmsRepo.putPmsLink(ctxA, {
        id: 'PMSL-ALPHA-OWN',
        entityType: 'matter',
        onesquaredId: 'M-ALPHA-OWN',
        pmsCode: 'PEN001-0001',
        matchedBy: 'manual',
        matchedAt: '2026-11-19T10:00:00.000Z',
      });
      await pmsRepo.putPmsLink(ctxA, {
        id: 'PMSL-ALPHA-OTHER',
        entityType: 'matter',
        onesquaredId: 'M-ALPHA-OTHER',
        pmsCode: 'PRI001-0001',
        matchedBy: 'manual',
        matchedAt: '2026-11-19T10:00:00.000Z',
      });
      await pmsRepo.putPmsLink(ctxB, {
        id: 'PMSL-BRAVO-OWN',
        entityType: 'matter',
        onesquaredId: 'M-BRAVO-OWN',
        pmsCode: 'SEV001-0001',
        matchedBy: 'manual',
        matchedAt: '2026-11-19T10:00:00.000Z',
      });

      const extractMeta = {
        asAtDate: '2026-10-31',
        sourceFile: 'invented-pms.xlsx',
        importedAt: '2026-11-19T10:00:00.000Z',
      };
      await pmsRepo.importExtractDataset(ctxA, {
        extractInfo: extractMeta,
        feeEarners: [
          {
            fee_earner_id: 'FE001',
            initials: 'AM',
            first_name: 'Alex',
            last_name: 'Morgan',
            email: 'alex.morgan@tenant-alpha.example',
            grade: 'Partner',
            department: 'Corporate',
            standard_hourly_rate: 350,
            annual_target_hours: 1200,
            annual_target_fees: 350000,
            active: 'Yes',
          },
        ],
        clients: [
          {
            client_code: 'PEN001',
            client_name: 'Alpha Client Ltd',
            client_type: 'Organisation',
            company_number: '10000001',
            email: 'accounts@alpha.example',
            phone: '029 2018 0100',
            billing_address: '1 High Street',
            postcode: 'CF10 1AA',
            client_partner_id: 'FE001',
            credit_terms_days: 30,
            credit_limit: 50000,
            rate_discount_pct: 0,
            date_opened: '2025-01-15',
            sector: 'Industrial',
            crm_match_on: 'company_number',
            status: 'Active',
          },
        ],
        matters: [
          {
            matter_code: 'PEN001-0001',
            client_code: 'PEN001',
            matter_description: 'Alpha Own Financial',
            work_type: 'M&A',
            practice_area: 'Corporate',
            responsible_partner_id: 'FE001',
            fee_earner_id: 'FE001',
            billing_basis: 'Hourly Rate',
            fixed_fee_amount: 0,
            fee_estimate: 10000,
            estimate_alert_pct: 80,
            date_opened: '2026-01-01',
            date_closed: null,
            status: 'Open',
            billing_frequency: 'Monthly',
            client_reference: 'REF-OWN',
            third_party_payer: '',
          },
          {
            matter_code: 'PRI001-0001',
            client_code: 'PEN001',
            matter_description: 'Alpha Other Financial',
            work_type: 'M&A',
            practice_area: 'Corporate',
            responsible_partner_id: 'FE001',
            fee_earner_id: 'FE001',
            billing_basis: 'Hourly Rate',
            fixed_fee_amount: 0,
            fee_estimate: 20000,
            estimate_alert_pct: 80,
            date_opened: '2026-01-01',
            date_closed: null,
            status: 'Open',
            billing_frequency: 'Monthly',
            client_reference: 'REF-OTHER',
            third_party_payer: '',
          },
        ],
        feeEstimates: [],
        invoices: [],
        payments: [],
        timeEntries: [
          {
            time_id: 'T-OWN-1',
            matter_code: 'PEN001-0001',
            fee_earner_id: 'FE001',
            date: '2026-10-15',
            activity: 'Drafting',
            narrative: 'Drafting agreement',
            minutes: 60,
            units: 10,
            hours: 1,
            rate: 350,
            value: 1200,
            chargeable: 'Y',
            billed_status: 'Unbilled',
            invoice_number: null,
            billed_value: 0,
            write_off_value: 0,
          },
          {
            time_id: 'T-OTHER-1',
            matter_code: 'PRI001-0001',
            fee_earner_id: 'FE001',
            date: '2026-10-15',
            activity: 'Review',
            narrative: 'Reviewing papers',
            minutes: 120,
            units: 20,
            hours: 2,
            rate: 350,
            value: 9900,
            chargeable: 'Y',
            billed_status: 'Unbilled',
            invoice_number: null,
            billed_value: 0,
            write_off_value: 0,
          },
        ],
        disbursements: [],
        clientAccount: [],
      });
      await pmsRepo.importExtractDataset(ctxB, {
        extractInfo: extractMeta,
        feeEarners: [
          {
            fee_earner_id: 'FE003',
            initials: 'BM',
            first_name: 'Bravo',
            last_name: 'Earner',
            email: 'bravo.earner@tenant-bravo.example',
            grade: 'Partner',
            department: 'Commercial',
            standard_hourly_rate: 350,
            annual_target_hours: 1200,
            annual_target_fees: 350000,
            active: 'Yes',
          },
        ],
        clients: [
          {
            client_code: 'SEV001',
            client_name: 'Bravo Client Ltd',
            client_type: 'Organisation',
            company_number: '20000002',
            email: 'accounts@bravo.example',
            phone: '029 2018 0200',
            billing_address: '2 High Street',
            postcode: 'CF10 1AA',
            client_partner_id: 'FE003',
            credit_terms_days: 30,
            credit_limit: 50000,
            rate_discount_pct: 0,
            date_opened: '2025-01-15',
            sector: 'Industrial',
            crm_match_on: 'company_number',
            status: 'Active',
          },
        ],
        matters: [
          {
            matter_code: 'SEV001-0001',
            client_code: 'SEV001',
            matter_description: 'Bravo Own Financial',
            work_type: 'Contract',
            practice_area: 'Commercial',
            responsible_partner_id: 'FE003',
            fee_earner_id: 'FE003',
            billing_basis: 'Fixed Fee',
            fixed_fee_amount: 0,
            fee_estimate: 15000,
            estimate_alert_pct: 80,
            date_opened: '2026-01-01',
            date_closed: null,
            status: 'Open',
            billing_frequency: 'Monthly',
            client_reference: 'REF-BRV',
            third_party_payer: '',
          },
        ],
        feeEstimates: [],
        invoices: [],
        payments: [],
        timeEntries: [
          {
            time_id: 'T-BRV-1',
            matter_code: 'SEV001-0001',
            fee_earner_id: 'FE003',
            date: '2026-10-15',
            activity: 'Drafting',
            narrative: 'Bravo drafting',
            minutes: 60,
            units: 10,
            hours: 1,
            rate: 350,
            value: 5500,
            chargeable: 'Y',
            billed_status: 'Unbilled',
            invoice_number: null,
            billed_value: 0,
            write_off_value: 0,
          },
        ],
        disbursements: [],
        clientAccount: [],
      });

      setActiveTenantConfigForTesting(
        { ...rawBase, tenantId: 'tenant-alpha', hostingMode: 'multi_tenant' },
        { tenantId: 'tenant-alpha', environment: 'test' },
      );

      const feRowsA = await getMatterFinanceRows(ctxA);
      expect(isActionDenied(feRowsA)).toBe(false);
      if (!isActionDenied(feRowsA)) {
        expect(feRowsA.allMatterFins.map((r) => r.matter_code)).toEqual(['PEN001-0001']);
      }

      // Tampered Tenant A non-team matter ID and tampered Tenant B matter ID are both rejected
      const nonTeamExplicitA = await getMatterFinanceRows(ctxA, ['M-ALPHA-OTHER']);
      expect(isActionDenied(nonTeamExplicitA)).toBe(true);
      if (isActionDenied(nonTeamExplicitA)) {
        expect(nonTeamExplicitA.code).toBe('FORBIDDEN');
      }

      const tamperedBravoMatterA = await getMatterFinanceRows(ctxA, ['M-BRAVO-OWN']);
      expect(isActionDenied(tamperedBravoMatterA)).toBe(true);
      if (isActionDenied(tamperedBravoMatterA)) {
        expect(tamperedBravoMatterA.code).toBe('FORBIDDEN');
      }

      // Mismatched tenantId on TenantContext fails at database layer; forged session tenant claim throws TENANCY_FORGERY_DETECTED
      await expect(
        getMatterFinanceRows(Object.freeze({ ...ctxA, tenantId: 'tenant-bravo' })),
      ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED|TENANCY_FORGERY_DETECTED|42501/i);
      await expect(
        runWithActiveActorSession(
          {
            personId: 'P-ALPHA-FE',
            tenantId: 'tenant-bravo',
            tokenRoles: ['fee_earner'],
            expiresAtMs: Date.now() + 60_000,
          },
          () => getMatterFinanceRows('P-ALPHA-FE'),
        ),
      ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
      await pmsRepo.clearTenantData(ctxA).catch(() => undefined);
      await pmsRepo.clearTenantData(ctxB).catch(() => undefined);
      await matterRepo.clearTenantData(ctxA).catch(() => undefined);
      await matterRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
    }
  });

  it('R524: before_matter_open_hook_failed logs extensionId + errorCode only (never raw reason), billing warnings use ctx.correlationId, and tenantRuntime/docGen logs include tenantId and sanitise messages', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = loadCommittedSeedStore();
      await resetAllDemoData('P-000001', testDataResetContext());
      const sessionPayload = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-4333-8444-000000000000',
          sub: 'P-000001',
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner', 'managing_partner'],
          mappedRoles: ['partner', 'managing_partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(sessionPayload);
      const ctx = resolveCurrentTenantContext(
        createVerifiedSessionActorFromEntraSession(sessionPayload, {
          correlationId: 'corr-r524-verified-context',
        }),
      );

      // 1. Trigger unassigned billing task warning using ctx (expects ctx.correlationId, never corr-bill-task-*)
      const linkedMatter = store.matters.find((m) => m.id === 'M-000001')!;
      await getMatterRepository().putMatter(
        ctx,
        {
          ...linkedMatter,
          responsiblePartnerId: null,
          supervisingPartnerId: null,
          leadFeeEarnerId: null,
          teamMemberIds: ['P-000001'],
        },
        { expectedRowVersion: null, sqlRestrictedAccessUserIds: [] },
      );
      await runWithActiveActorSession(
        {
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          tokenRoles: ['partner', 'managing_partner'],
          mfaVerified: true,
          expiresAtMs: Date.now() + 3600_000,
          verifiedSession: sessionPayload,
        },
        () => requestMatterBill('PEN001-0001', ctx),
      );
      const billWarnLogs = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((s) => s.includes('draft_bill_approval_task_unassigned'));
      expect(billWarnLogs.length).toBeGreaterThanOrEqual(1);
      expect(billWarnLogs[0]).toContain('corr-r524-verified-context');
      expect(billWarnLogs[0]).not.toMatch(/corr-bill-task-/);

      // 2. Inject a beforeMatterOpen throwing hook containing sensitive email/secret text and assert raw reason is NEVER logged
      const host = getPlatformExtensionHost();
      const origExec = host.executeMatterCostsHook.bind(host);
      host.executeMatterCostsHook = async () => ({
        allowProceed: false,
        requiresPartnerSignOff: true,
        governanceWarnings: [
          'Hook "beforeMatterOpen" in extension "nalf-matter-costs-governance" failed: Bearer secret-jwt-token client@confidential.example',
        ],
      });
      try {
        await runWithActiveActorSession(
          {
            personId: 'P-000001',
            tenantId: 'not-a-law-firm',
            tokenRoles: ['partner', 'managing_partner'],
            mfaVerified: true,
            expiresAtMs: Date.now() + 3600_000,
            verifiedSession: sessionPayload,
          },
          () =>
            signOffMatterCostsRecord('M-000001', 'P-000001'),
        );
      } finally {
        host.executeMatterCostsHook = origExec;
      }

      const hookErrLogs = errSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((s) => s.includes('before_matter_open_hook_failed'));
      expect(hookErrLogs.length).toBeGreaterThanOrEqual(1);
      const parsedHookErr = JSON.parse(hookErrLogs[0]!) as Record<string, unknown>;
      expect(parsedHookErr.extensionId).toBe('nalf-matter-costs-governance');
      expect(parsedHookErr.errorCode).toBeDefined();
      expect(parsedHookErr.errorMessage).toBeUndefined();
      expect(hookErrLogs[0]).not.toContain('client@confidential.example');
      expect(hookErrLogs[0]).not.toContain('secret-jwt-token');
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      setTestEntraSessionOverride(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R515 two-tenant isolation: merge repoints register_records in verified tenant only and rejects forged tenant claims', async () => {
    const ctxA = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-ALPHA-ADM',
        tenantId: 'tenant-alpha',
        name: 'Alpha Admin',
        email: 'alpha-admin@tenant-alpha.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r515-a',
    });
    const ctxB = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-BRAVO-ADM',
        tenantId: 'tenant-bravo',
        name: 'Bravo Admin',
        email: 'bravo-admin@tenant-bravo.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'corr-r515-b',
    });

    const partyRepo = getPartyRepository();
    const regRepo = getRegisterRepository();
    const store = loadCommittedSeedStore();
    const contactTemplate = store.people.find((p) => !p.isEmployee)!;
    const orgTemplate = store.organisations[0]!;

    try {
      await regRepo.clearTenantData(ctxA).catch(() => undefined);
      await regRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);

      const pSurv = { ...contactTemplate, id: 'P-R515-SURV', isEmployee: false, employment: null };
      const pLose = { ...contactTemplate, id: 'P-R515-LOSE', isEmployee: false, employment: null };
      const oSurv = { ...orgTemplate, id: 'O-R515-SURV', legalName: 'R515 Survivor Org Ltd' };
      const oLose = { ...orgTemplate, id: 'O-R515-LOSE', legalName: 'R515 Duplicate Org Ltd' };

      await partyRepo.putPeople(ctxA, [pSurv, pLose]);
      await partyRepo.putOrganisation(ctxA, oSurv);
      await partyRepo.putOrganisation(ctxA, oLose);

      await partyRepo.putPeople(ctxB, [pSurv, pLose]);
      await partyRepo.putOrganisation(ctxB, oSurv);
      await partyRepo.putOrganisation(ctxB, oLose);

      await regRepo.createRegisterRecord(
        ctxA,
        {
          id: 'REG-R515-ISO-1',
          registerTypeKey: 'complaint',
          reference: 'CMP-R515-A',
          title: 'Alpha Register Record',
          status: 'open',
          matterId: null,
          enquiryId: null,
          personId: 'P-R515-LOSE',
          organisationId: 'O-R515-LOSE',
          ownerId: 'P-ALPHA-ADM',
          assignedApproverId: null,
          dueAt: null,
          reviewAt: null,
          reminderScheduleDays: [],
          fieldValues: {
            complainantPersonId: 'P-R515-LOSE',
            nestedParty: { id: 'P-R515-LOSE' },
          },
          createdById: 'P-ALPHA-ADM',
        },
        { recordInitialTransition: false },
      );

      await regRepo.createRegisterRecord(
        ctxB,
        {
          id: 'REG-R515-ISO-1',
          registerTypeKey: 'complaint',
          reference: 'CMP-R515-B',
          title: 'Bravo Register Record',
          status: 'open',
          matterId: null,
          enquiryId: null,
          personId: 'P-R515-LOSE',
          organisationId: 'O-R515-LOSE',
          ownerId: 'P-BRAVO-ADM',
          assignedApproverId: null,
          dueAt: null,
          reviewAt: null,
          reminderScheduleDays: [],
          fieldValues: {
            complainantPersonId: 'P-R515-LOSE',
            nestedParty: { id: 'P-R515-LOSE' },
          },
          createdById: 'P-BRAVO-ADM',
        },
        { recordInitialTransition: false },
      );

      await partyRepo.executeMergeInTransaction(ctxA, {
        recordType: 'person',
        survivor: pSurv,
        merged: pLose,
      });
      await partyRepo.executeMergeInTransaction(ctxA, {
        recordType: 'organisation',
        survivor: oSurv,
        merged: oLose,
      });

      const alphaRec = await regRepo.getRegisterRecordById(ctxA, 'REG-R515-ISO-1', {
        includeRestricted: true,
      });
      const bravoRec = await regRepo.getRegisterRecordById(ctxB, 'REG-R515-ISO-1', {
        includeRestricted: true,
      });
      expect(alphaRec?.personId).toBe('P-R515-SURV');
      expect(alphaRec?.organisationId).toBe('O-R515-SURV');
      expect(alphaRec?.fieldValues.complainantPersonId).toBe('P-R515-SURV');
      expect(alphaRec?.fieldValues.nestedParty).toEqual({ id: 'P-R515-SURV' });
      expect(alphaRec?.rowVersion).toBeGreaterThan(1);
      await expect(
        regRepo.updateRegisterRecordDetails(ctxA, {
          recordId: 'REG-R515-ISO-1',
          expectedRowVersion: 1,
          title: 'Stale pre-merge write in Alpha',
          updatedById: 'P-ALPHA-ADM',
        }),
      ).rejects.toThrow(/modified concurrently/);
      // Bravo remains untouched on its own tenant DB
      expect(bravoRec?.personId).toBe('P-R515-LOSE');
      expect(bravoRec?.organisationId).toBe('O-R515-LOSE');
      expect(bravoRec?.fieldValues.complainantPersonId).toBe('P-R515-LOSE');
      expect(bravoRec?.fieldValues.nestedParty).toEqual({ id: 'P-R515-LOSE' });
      expect(bravoRec?.rowVersion).toBe(1);

      // Forged tenant claim fails at PostgreSQL pool/ROLE boundary
      await expect(
        partyRepo.executeMergeInTransaction(
          Object.freeze({ ...ctxA, tenantId: 'tenant-bravo' }),
          {
            recordType: 'person',
            survivor: pSurv,
            merged: pLose,
          },
        ),
      ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED|42501/i);
    } finally {
      await regRepo.clearTenantData(ctxA).catch(() => undefined);
      await regRepo.clearTenantData(ctxB).catch(() => undefined);
      await partyRepo.clearTenantData(ctxA).catch(() => undefined);
      await partyRepo.clearTenantData(ctxB).catch(() => undefined);
    }
  });

  it('R576: matter opening gate resolves prospective, cmi_incomplete, and active by systemKey even when labels are renamed and fails closed if missing', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const catRepo = getCatalogueRepository();
    try {
      const values = await catRepo.listAllChoiceValues<{
        id: string;
        listKey: string;
        label: string;
        systemKey?: string;
        sortOrder: number;
        active: boolean;
      }>(ctx);
      const renamedValues = values.map((v) => {
        if (v.listKey !== 'matter_status') return v;
        if (v.systemKey === 'prospective') return { ...v, label: 'Pre-opening' };
        if (v.systemKey === 'cmi_incomplete') return { ...v, label: 'Pending CDD' };
        if (v.systemKey === 'active') return { ...v, label: 'Open' };
        return v;
      });
      await catRepo.putChoiceValues(ctx, renamedValues);

      const seed = loadCommittedSeedStore();
      const template = seed.matters.find((m) => m.id === 'M-000004')!;
      const { id: _id, ...baseMatter } = template;
      void _id;

      await runAsTestActor('P-000004', async () => {
        // 1. Draft save under renamed 'Prospective / Enquiry' must stay prospective, NEVER Active
        const draftSave = await saveMatterRecord(
          {
            ...baseMatter,
            matterNumber: 'DRAFT',
            title: 'R576 Renamed Prospective Draft',
            matterStatusId: undefined,
            recordStatusId: undefined,
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(draftSave.errors).toBeUndefined();
        expect(draftSave.matter?.matterStatusId).toBe(
          'matter_status.prospective_enquiry',
        );

        // 2. Attempt to open without conflict check or risk assessment MUST still invoke opening gate and fail closed
        const gatedSave = await saveMatterRecord(
          {
            ...baseMatter,
            matterNumber: 'MAT-R576-GATE',
            title: 'R576 Missing Conflict Check Open Attempt',
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckRecord: undefined,
            fieldValues: {},
          },
          { byId: 'P-000004', saveMode: 'submit_cleared' },
        );
        expect(gatedSave.matter).toBeNull();
        expect(Object.keys(gatedSave.errors ?? {}).length).toBeGreaterThan(0);

        // 3. Removing prospective systemKey must fail closed (never fall back to Active)
        const brokenValues = renamedValues.map((v) =>
          v.listKey === 'matter_status' && v.systemKey === 'prospective'
            ? { ...v, systemKey: undefined }
            : v,
        );
        await catRepo.putChoiceValues(ctx, brokenValues);

        const missingKeySave = await saveMatterRecord(
          {
            ...baseMatter,
            matterNumber: 'DRAFT',
            title: 'R576 Missing SystemKey Fail Closed',
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(missingKeySave.matter).toBeNull();
        expect(Object.keys(missingKeySave.errors ?? {}).length).toBeGreaterThan(0);
      });
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R589: saveMatterRecord ignores client-supplied conflictCheckDate and openedAt and stamps tenant-local date on opening', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const seed = loadCommittedSeedStore();
    const template = seed.matters.find((m) => m.id === 'M-000004')!;
    const {
      id: _id,
      openedAt: _opened,
      conflictCheckDate: _ccDate,
      matterStatusId: _msId,
      recordStatusId: _rsId,
      ...baseMatter
    } = template;
    void _id;
    void _opened;
    void _ccDate;
    void _msId;
    void _rsId;
    const clearedConflict = {
      status: 'Cleared' as const,
      outcomeLabel: 'Cleared by fee earner' as const,
      declarationConfirmed: true,
      reviewerMessage: '',
      lastRunAtDisplay: '19 Nov 2026',
      lastRunById: 'P-000004',
      lastRunByName: 'Catrin Williams',
      submittedAtDisplay: '19 Nov 2026',
      submittedById: 'P-000004',
      submittedByName: 'Catrin Williams',
      approvedAtDisplay: null,
      approvedById: null,
      approvedByName: null,
      parties: [],
      matches: [],
      comments: [],
      runs: [],
    };

    try {
      await runAsTestActor('P-000004', async () => {
        const draftSave = await saveMatterRecord(
          {
            ...baseMatter,
            matterNumber: 'DRAFT',
            title: 'R589 Backdate Draft',
            conflictCheckDate: '1999-02-02',
            openedAt: '1999-01-01',
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(draftSave.errors).toBeUndefined();
        expect(draftSave.matter?.conflictCheckDate).not.toBe('1999-02-02');
        expect(draftSave.matter?.openedAt).toBeNull();

        const openSave = await saveMatterRecord(
          {
            ...baseMatter,
            id: draftSave.matter!.id,
            matterNumber: 'DRAFT',
            title: 'R589 Backdate Open',
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckDate: '1999-02-02',
            openedAt: '1999-01-01',
            conflictCheckRecord: clearedConflict,
          },
          { id: draftSave.matter!.id, byId: 'P-000004', saveMode: 'submit_cleared' },
        );
        expect(openSave.errors).toBeUndefined();
        expect(openSave.matter?.conflictCheckDate).not.toBe('1999-02-02');
        expect(openSave.matter?.openedAt).not.toBe('1999-01-01');
        expect(openSave.matter?.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R592: enquiry urgency SLA, close reasons, and automatic contact/draft tasks use systemKey and autoTrigger rather than labels or title prefixes', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const catRepo = getCatalogueRepository();
    const taskRepo = getTaskWorkflowRepository();
    try {
      const values = await catRepo.listAllChoiceValues<{
        id: string;
        listKey: string;
        label: string;
        systemKey?: string;
        sortOrder: number;
        active: boolean;
      }>(ctx);
      const renamedValues = values.map((v) => {
        if (v.listKey === 'enquiry_urgency' && v.systemKey === 'emergency') {
          return { ...v, label: 'Level 1 Critical' };
        }
        if (v.listKey === 'task_priority' && v.systemKey === 'urgent') {
          return { ...v, label: 'P1 Now' };
        }
        if (v.listKey === 'enquiry_close_reason' && v.systemKey === 'referred_out') {
          return { ...v, label: 'Sent to Specialist Counsel' };
        }
        if (v.listKey === 'task_type' && v.systemKey === 'call_back') {
          return { ...v, label: 'Initial Telephone Call' };
        }
        if (v.listKey === 'task_type' && v.systemKey === 'general') {
          return { ...v, label: 'General Admin' };
        }
        return v;
      });
      await catRepo.putChoiceValues(ctx, renamedValues);

      const seed = loadCommittedSeedStore();
      const templateEnq = seed.enquiries.find((e) => e.status === 'New')!;

      await runAsTestActor('P-000004', async () => {
        // 1. Emergency urgency (renamed label) must assign Urgent priority ('task_priority.urgent') & 2h emergency SLA
        const createdEnq = await saveEnquiryRecord(
          {
            firstName: 'R592',
            lastName: 'Prospect',
            email: 'r592.prospect@outside.example',
            phone: '029 2000 5920',
            channelId: templateEnq.channelId,
            practiceAreaId: templateEnq.practiceAreaId,
            summary: 'Urgent injunctive relief',
            notes: 'Needs urgent contact',
            urgencyId: 'enquiry_urgency.emergency',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000004' },
        );
        expect(createdEnq.error).toBeUndefined();
        const enqId = createdEnq.enquiry!.id;

        const tasks = await taskRepo.listAllTasksUnfiltered(ctx);
        const contactTask = tasks.find(
          (t) =>
            t.linkedRecords.some(
              (r) => r.recordType === 'enquiry' && r.recordId === enqId,
            ) && t.autoTrigger === 'enquiry_contact',
        )!;
        expect(contactTask).toBeDefined();
        expect(contactTask.priorityId).toBe('task_priority.urgent');

        // Rename contact task title & taskTypeId away from legacy strings; keep autoTrigger: 'enquiry_contact'
        await taskRepo.putTask(ctx, {
          ...contactTask,
          title: 'Initial Telephone Follow-up (Renamed)',
          taskTypeId: 'task_type.general',
        });

        // Reassign enquiry -> renamed contact task moves via autoTrigger
        const assignRes = await assignEnquiryRecord(enqId, 'P-000002', undefined, 'P-000004');
        expect(assignRes.error).toBeUndefined();
        const taskAfterAssign = await taskRepo.getTaskById(ctx, contactTask.id, {
          includeRestricted: true,
        });
        expect(taskAfterAssign?.assignedPersonId).toBe('P-000002');

        // Close as Referred out without explicit closeReasonId -> resolves by systemKey 'referred_out'
        // and closes renamed contact task via autoTrigger
        const closeRes = await closeEnquiryRecord(
          enqId,
          {
            targetStatus: 'Referred out',
            referredToName: 'Specialist Chambers',
          },
          'P-000004',
        );
        expect(closeRes.error).toBeUndefined();
        expect(closeRes.enquiry?.closeReasonId).toBe(
          'enquiry_close_reason.referred_out',
        );
        const taskAfterClose = await taskRepo.getTaskById(ctx, contactTask.id, {
          includeRestricted: true,
        });
        expect(taskAfterClose?.status).toBe('Done');

        // 2. Conflict draft task uses autoTrigger: 'conflict_check_draft' rather than title prefix
        const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
        const { id: _mid, ...matterTemplate } = baseMatter;
        void _mid;
        const draftMatter = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            title: 'R592 Draft Task AutoTrigger',
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(draftMatter.errors).toBeUndefined();
        const matterId = draftMatter.matter!.id;
        const draftTasks = await taskRepo.listAllTasksUnfiltered(ctx);
        const conflictDraftTask = draftTasks.find((t) =>
          t.linkedRecords.some(
            (r) => r.recordType === 'matter' && r.recordId === matterId,
          ),
        )!;
        expect(conflictDraftTask).toBeDefined();
        expect(conflictDraftTask.autoTrigger).toBe('conflict_check_draft');

        await taskRepo.putTask(ctx, {
          ...conflictDraftTask,
          title: 'Custom Compliance Draft Task Name',
        });

        const clearedMatter = await saveMatterRecord(
          {
            ...matterTemplate,
            id: matterId,
            matterNumber: 'DRAFT',
            title: 'R592 Draft Task AutoTrigger',
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            conflictCheckRecord: matterTemplate.conflictCheckRecord ?? {
              status: 'Cleared' as const,
              outcomeLabel: 'Cleared by fee earner' as const,
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '19 Nov 2026',
              lastRunById: 'P-000004',
              lastRunByName: 'Catrin Williams',
              submittedAtDisplay: '19 Nov 2026',
              submittedById: 'P-000004',
              submittedByName: 'Catrin Williams',
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [],
              matches: [],
              comments: [],
              runs: [],
            },
          },
          { id: matterId, byId: 'P-000004', saveMode: 'submit_cleared' },
        );
        expect(clearedMatter.errors).toBeUndefined();
        const completedDraftTask = await taskRepo.getTaskById(
          ctx,
          conflictDraftTask.id,
          { includeRestricted: true },
        );
        expect(completedDraftTask?.status).toBe('Done');
      });
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });
});
