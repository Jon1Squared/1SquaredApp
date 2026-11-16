import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  GLOBAL_SEARCH_ENTITY_TYPES,
  TenantDocumentRepository,
  TenantIntakeQuoteRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPostgresPoolManager,
  TenantSearchRepository,
  getPlatformTelemetryRecorder,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type DocumentLinkRecord,
  type GeneratedDocumentRecord,
  type KeyDate,
  type TenantContext,
} from '../src/index';
import { TENANT_SEARCH_INDEXES_MIGRATION_0018 } from '../src/tenancy/migrations/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { createDirectMigrationClient } from '../src/tenancy/postgresPoolManager';
import { searchGlobalRecordsAction } from '@/app/actions';
import type { Matter, Quote } from '@/domain/types';
import {
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import {
  createRegisterRecordService,
  getAppSnapshot,
  getKeyDatesConfig,
  resetAllDemoData,
  saveEnquiryRecord,
  saveKeyDatesConfigRecord,
  saveMatterRecord,
  saveOrganisationRecord,
  savePersonRecord,
  saveQuoteRecord,
  saveTaskRecord,
  searchGlobalRecords,
  updatePersonPermissionOverrides,
} from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

const BASE_LOW_RISK_ANSWERS: Record<string, string> = {
  inScopeMlr: 'Yes, in scope',
  instructionMakesSense: 'Yes',
  moveMoneyWithoutTransaction: 'No',
  clientRelationshipStatus: 'Existing, CDD current',
  clientDealingMethod: 'Met in person',
  complexOwnershipStructure: 'No',
  thirdPartyInstructions: 'No',
  highRiskJurisdictionLink: 'No',
  crossBorderFundsOrAssets: 'No',
  holdClientMoney: 'No',
  matterFundingSource: 'The client',
  sourceOfFundsUnderstood: 'Yes',
  unusualPaymentRequests: 'No',
  regularTeamWork: 'Yes',
  capacityAndSupervision: 'Yes',
  imminentDeadlines: 'No',
  feeBasis: 'Fixed fee',
  moneyOnAccountRequested: 'Yes',
  valueOrExposure: 'Within normal range',
  limitationOfLiabilityProposed: 'No',
  reputationOrEthicalConcerns: 'No',
  sensitiveSectorOrMedia: 'No',
  specialCategoryDataOrConfidentiality: 'No',
};

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId = 'P-000004',
  roles: readonly string[] = ['admin', 'partner', 'fee_earner', 'risk_compliance'],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Test Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles,
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s025-${tenantId}-${actorId}`,
  });
}

async function runAsActionActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { tenantId?: string; mfaVerified?: boolean; roles?: readonly string[] },
): Promise<R> {
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    setTestActorSession(null);
  }
}

async function insertSearchableDocument(
  ctx: TenantContext,
  opts: {
    id: string;
    title: string;
    fileName: string;
    primaryMatterId?: string | null;
    primaryClientId?: string | null;
    linkedMatters?: string[];
    isDeleted?: boolean;
  },
): Promise<void> {
  const docRepo = new TenantDocumentRepository();
  const tplId = `TPL-S025-${opts.id}`;
  const verId = `VER-S025-${opts.id}`;
  const nowIso = '2026-11-16T09:00:00.000Z';

  await docRepo.putTemplate(ctx, {
    id: tplId,
    tenantId: ctx.tenantId,
    code: `CODE_${opts.id.replace(/[^A-Za-z0-9_]/g, '_')}`,
    name: `Template ${opts.title}`,
    description: 'Search test template',
    category: 'General',
    tags: [],
    outputDocumentType: 'letter',
    filenamePattern: '{{matter.reference}}',
    availabilityRules: { sourceContexts: ['matter'] },
    activeVersionId: verId,
    status: 'Active',
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await docRepo.putTemplateVersion(ctx, {
    id: verId,
    tenantId: ctx.tenantId,
    templateId: tplId,
    versionNumber: 1,
    engine: 'basic-merge',
    status: 'Active',
    storageProvider: 'local-fs',
    blobKey: `templates/${verId}.docx`,
    fileName: `${verId}.docx`,
    fileSha256: 'abc123def456',
    fileSizeBytes: 512,
    scanStatus: 'clean',
    extractedPlaceholders: [],
    fieldMappings: {},
    promptedFields: [],
    createdByUserId: 'P-000001',
    createdAt: nowIso,
    submittedByUserId: 'P-000001',
    submittedAt: nowIso,
  });

  const doc: GeneratedDocumentRecord = {
    id: opts.id,
    tenantId: ctx.tenantId,
    title: opts.title,
    fileName: opts.fileName,
    documentType: 'letter',
    outputFormat: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileSizeBytes: 1024,
    fileSha256: 'sha256-test',
    templateId: tplId,
    templateName: `Template ${opts.title}`,
    templateVersionId: verId,
    templateVersionNumber: 1,
    storageProvider: 'local-fs',
    storageKey: `documents/${opts.fileName}`,
    generatedByUserId: 'P-000001',
    generatedByName: 'Rhian Morgan',
    generatedAt: nowIso,
    primaryMatterId: opts.primaryMatterId ?? null,
    primaryClientId: opts.primaryClientId ?? null,
    recipientPartyId: null,
    isDeleted: Boolean(opts.isDeleted),
  };
  await docRepo.putDocument(ctx, doc);

  for (let i = 0; i < (opts.linkedMatters ?? []).length; i++) {
    const link: DocumentLinkRecord = {
      id: `DL-S025-${opts.id}-${i + 1}`,
      tenantId: ctx.tenantId,
      documentId: doc.id,
      entityType: 'matter',
      entityId: opts.linkedMatters![i],
      linkRole: 'source_matter',
      createdAt: nowIso,
    };
    await docRepo.putDocumentLink(ctx, link);
  }
}

async function insertKeyDateForSearchTest(
  ctx: TenantContext,
  opts: {
    id: string;
    matterId: string;
    teamId: string;
    title: string;
    notes?: string;
    dueDate?: string;
  },
): Promise<void> {
  const kdRepo = new TenantKeyDateRepository();
  const nowIso = '2026-11-16T09:00:00.000Z';
  const kd: KeyDate = {
    id: opts.id,
    matterId: opts.matterId,
    keyDateTypeId: 'kd_type_limitation',
    category: 'limitation',
    title: opts.title,
    dueDate: opts.dueDate ?? '2027-06-15',
    isCritical: true,
    status: 'confirmed',
    source: 'manual',
    teamId: opts.teamId,
    responsiblePersonIds: ['P-000001'],
    verification: {
      required: true,
      proposedById: 'P-000001',
      proposedAt: nowIso,
      verifiedById: 'P-000001',
      verifiedAt: nowIso,
    },
    notes: opts.notes ?? '',
    createdById: 'P-000001',
    createdAt: nowIso,
    updatedById: 'P-000001',
    updatedAt: nowIso,
    version: 1,
  };
  await kdRepo.putKeyDate(ctx, kd);
}

describe('S0-25: Server-Side Full-Text & Trigram Search, Pre-Rank SQL RBAC, Pagination & Two-Tenant Isolation', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    getPlatformTelemetryRecorder().clearForTesting();
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. Migration 0018 schema contract, pg_trgm extension, and all 20 IMMUTABLE GIN/link indexes exist', async () => {
    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0018');
    expect(TENANT_SEARCH_INDEXES_MIGRATION_0018.version).toBe('0018');
    expect(TENANT_SEARCH_INDEXES_MIGRATION_0018.dependsOn).toEqual(['0017']);

    const ctx = testTenantCtx('P-000004');
    const client = await createDirectMigrationClient({ ctx });
    try {
      const ext = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      expect(ext.rowCount).toBe(1);

      const idxRes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND (indexname LIKE 'idx_search_%' OR indexname = 'idx_document_links_tenant_document')`,
      );
      const names = idxRes.rows.map((r) => r.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'idx_document_links_tenant_document',
          'idx_search_people_fts',
          'idx_search_people_trgm',
          'idx_search_person_emails_trgm',
          'idx_search_organisations_fts',
          'idx_search_organisations_trgm',
          'idx_search_matters_fts',
          'idx_search_matters_trgm',
          'idx_search_enquiries_fts',
          'idx_search_enquiries_trgm',
          'idx_search_quotes_fts',
          'idx_search_quotes_trgm',
          'idx_search_tasks_fts',
          'idx_search_tasks_trgm',
          'idx_search_documents_fts',
          'idx_search_documents_trgm',
          'idx_search_key_dates_fts',
          'idx_search_key_dates_trgm',
          'idx_search_register_records_fts',
          'idx_search_register_records_trgm',
        ]),
      );
      expect(names.length).toBe(20);
    } finally {
      await client.end();
    }
  });

  it('2. Searches across all 9 entity types via exact, prefix, FTS, secondary emails, and trigram typos with facets and pagination', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const token = 'QuicksilverHorizon';

    await runAsActionActor(
      'P-000004',
      async () => {
        // Ensure keyDates enabled for search
        const existingKdCfg = await getKeyDatesConfig({ ctx, userId: 'P-000004' });
        const kdSaveRes = await saveKeyDatesConfigRecord(
          {
            ...existingKdCfg,
            enabled: true,
          },
          'S0-25 test enable key dates search',
          'P-000004',
          { mfaVerified: true },
        );
        expect(kdSaveRes.ok).toBe(true);

        // 1. Person with secondary active email
        const personRes = await savePersonRecord(
          {
            firstName: 'Aled',
            surname: `${token}Person`,
            emails: [
              {
                id: 'em-s025-prim',
                address: 'aled.primary@quicksilver-test.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
              {
                id: 'em-s025-sec',
                address: 'kestrel.alias@s025-secondary.example',
                typeId: 'email_type.personal',
                isPrimary: false,
                active: true,
              },
            ],
          },
          { byId: 'P-000004' },
        );
        expect(personRes.errors).toBeUndefined();

        // 2. Organisation
        const orgRes = await saveOrganisationRecord(
          {
            legalName: `${token} Holdings Ltd`,
            companyNumber: '09988776',
          },
          { byId: 'P-000004' },
        );
        expect(orgRes.errors).toBeUndefined();

        // 3. Matter
        const seedStore = createSeedStore();
        const baseMatter = seedStore.matters.find((m) => m.id === 'M-000011')!;
        const { id: _omitM, rowVersion: _omitRv, ...matterTemplate } = baseMatter;
        void _omitM;
        void _omitRv;
        const matterRes = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: `${token} Lease Renewal`,
            clientId: orgRes.organisation!.id,
            isStaffMatter: false,
            hasEthicalWall: false,
            restrictedAccessUserIds: [],
            fieldValues: { riskAssessment: { answers: BASE_LOW_RISK_ANSWERS } },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(matterRes.errors).toBeUndefined();
        const matterId = matterRes.matter!.id;

        // 4. Enquiry
        const enqRes = await saveEnquiryRecord(
          {
            firstName: 'Morgan',
            lastName: 'Davies',
            email: 'morgan.davies@quicksilver-test.example',
            callingOnBehalfOf: `${token} Ventures`,
            channelId: 'enquiry_channel.phone',
            practiceAreaId: 'work_type.real_estate_and_property',
            urgencyId: 'urgency.standard',
            summary: `${token} initial property instruction`,
            notes: 'Confirmed instruction scope and lease timeline',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000004' },
        );
        expect(enqRes.errors).toBeUndefined();

        // 5. Quote
        const quoteRes = await saveQuoteRecord(
          {
            clientType: 'existing',
            linkedOrganisationId: orgRes.organisation!.id,
            prospectName: `${token} Commercial Quote`,
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Commercial advisory scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 3200,
            validUntil: '2027-03-01',
            feeEarnerId: 'P-000004',
            followUpAfterDays: 7,
          },
          { byId: 'P-000004' },
        );
        expect(quoteRes.error).toBeUndefined();

        // 6. Task
        const taskRes = await saveTaskRecord(
          {
            title: `${token} Review Lease Clauses`,
            description: 'Review headlease break notice clause',
            dueAt: '2027-02-15',
            assignedTeamId: 'TM-000001',
            assignedPersonId: 'P-000004',
            linkedRecords: [{ recordType: 'matter', recordId: matterId }],
          },
          'P-000004',
        );
        expect(taskRes.error).toBeUndefined();

        // 7. Document + soft-deleted document (must stay hidden)
        await insertSearchableDocument(ctx, {
          id: 'DOC-S025-VISIBLE',
          title: `${token} Completion Statement`,
          fileName: 'quicksilver-completion.docx',
          primaryMatterId: matterId,
        });
        await insertSearchableDocument(ctx, {
          id: 'DOC-S025-DELETED',
          title: `${token} Deleted Statement`,
          fileName: 'quicksilver-deleted.docx',
          primaryMatterId: matterId,
          isDeleted: true,
        });

        // 8. Key Date
        await insertKeyDateForSearchTest(ctx, {
          id: 'KD-S025-1',
          matterId,
          teamId: 'TM-000001',
          title: `${token} Break Notice Deadline`,
          notes: 'Serve statutory break notice',
        });

        // 9. Register Record (complaint created by P-000004 who holds register:create)
        const regRes = await createRegisterRecordService(
          {
            registerTypeKey: 'complaint',
            title: `${token} Register Entry`,
            matterId,
            dueAt: '2027-04-01T00:00:00.000Z',
            fieldValues: {
              complainantName: 'Morgan Davies',
              complaintSummary: `${token} initial complaint summary`,
            },
          },
          'P-000004',
        );
        expect(regRes.ok).toBe(true);

        // Search across all 9 entity types
        const allRes = await searchGlobalRecordsAction({
          query: token,
          limit: 6,
          offset: 0,
        });
        const expectedTotal = GLOBAL_SEARCH_ENTITY_TYPES.reduce(
          (sum, entityType) => sum + allRes.countsByType[entityType],
          0,
        );
        expect(expectedTotal).toBeGreaterThanOrEqual(9);
        expect(allRes.totalCount).toBe(expectedTotal);
        for (const entityType of GLOBAL_SEARCH_ENTITY_TYPES) {
          expect(allRes.countsByType[entityType]).toBeGreaterThanOrEqual(1);
        }
        expect(allRes.hits.length).toBe(6);
        expect(allRes.hasMore).toBe(true);
        expect(allRes.hits.some((h) => h.id === 'DOC-S025-DELETED')).toBe(false);

        // Page 2 pagination completes the deterministic union without duplicates
        const page2Res = await searchGlobalRecordsAction({
          query: token,
          limit: 20,
          offset: 6,
        });
        expect(page2Res.hits.length).toBe(expectedTotal - 6);
        expect(page2Res.hasMore).toBe(false);
        expect(page2Res.totalCount).toBe(expectedTotal);

        const combinedHits = [...allRes.hits, ...page2Res.hits];
        expect(combinedHits.some((h) => h.id === 'DOC-S025-DELETED')).toBe(false);
        const combinedKeys = combinedHits.map((h) => `${h.entityType}:${h.id}`);
        expect(new Set(combinedKeys).size).toBe(expectedTotal);
        expect(new Set(combinedHits.map((h) => h.entityType))).toEqual(
          new Set(GLOBAL_SEARCH_ENTITY_TYPES),
        );

        // Entity filter narrows hits & totalCount while preserving permitted countsByType
        const docOnly = await searchGlobalRecordsAction({
          query: token,
          entityTypes: ['document', 'quote'],
        });
        expect(docOnly.totalCount).toBe(2);
        expect(docOnly.hits.map((h) => h.entityType).sort()).toEqual(['document', 'quote']);
        expect(docOnly.countsByType.matter).toBe(1);

        // Prefix search
        const prefixRes = await searchGlobalRecordsAction({
          query: 'QuicksilverHor',
        });
        expect(prefixRes.totalCount).toBe(expectedTotal);

        // Trigram typo tolerance ('QuicksilvrHorison' vs 'QuicksilverHorizon')
        const typoRes = await searchGlobalRecordsAction({
          query: 'QuicksilvrHorison',
        });
        expect(typoRes.totalCount).toBeGreaterThanOrEqual(5);

        // Secondary active email search in person_emails
        const secEmailRes = await searchGlobalRecordsAction({
          query: 'kestrel.alias@s025-secondary.example',
        });
        expect(secEmailRes.countsByType.person).toBeGreaterThanOrEqual(1);
        expect(secEmailRes.hits.some((h) => h.id === personRes.person!.id)).toBe(true);

        // Key-date stub matter (O-KEYDATE-STUB) never appears in search results
        await new TenantKeyDateRepository().setMatterRestriction(ctx, {
          matterId: 'M-S025-STUB-ONLY',
          isRestricted: false,
          restrictedAccessUserIds: [],
        });
        const stubCheck = await searchGlobalRecordsAction({
          query: 'M-S025-STUB-ONLY',
        });
        expect(stubCheck.totalCount).toBe(0);
        expect(stubCheck.hits).toEqual([]);
      },
      { mfaVerified: true },
    );
  });

  it('3. Enforces pre-ranking & pre-count RBAC and visibility predicates (staff matters, ethical walls, fallback allowlist revocations, drafts, key-date teams, quote finance redaction, documents, undertakings)', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const secretToken = 'CobaltVaultRestricted91';

    let restrictedMatterId = '';
    let wallMatterId = '';
    const draftEnquiryCreatorId = 'P-000002';
    let teamTwoMatterId = '';

    await runAsActionActor(
      'P-000004',
      async () => {
        const kdCfg = await getKeyDatesConfig({ ctx, userId: 'P-000004' });
        const kdSaveRes = await saveKeyDatesConfigRecord(
          { ...kdCfg, enabled: true },
          'S0-25 test enable key dates search',
          'P-000004',
          { mfaVerified: true },
        );
        expect(kdSaveRes.ok).toBe(true);

        const seedStore = createSeedStore();
        const baseMatter = seedStore.matters.find((m) => m.id === 'M-000011')!;
        const { id: _omitId, rowVersion: _omitRv, ...matterTemplate } = baseMatter;
        void _omitId;
        void _omitRv;

        // Staff matter (employee P-000010 as client -> server derives isStaffMatter: true)
        const staffMatterRes = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: `${secretToken} Staff Matter`,
            clientId: 'P-000010',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000001',
            teamMemberIds: ['P-000001'],
            fieldValues: { riskAssessment: { answers: BASE_LOW_RISK_ANSWERS } },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(staffMatterRes.errors).toBeUndefined();
        expect(staffMatterRes.matter!.isStaffMatter).toBe(true);
        restrictedMatterId = staffMatterRes.matter!.id;

        // Empty-allowlist Ethical Wall matter (B12 fail-closed: participant P-000001 only, allowlist [])
        const wallMatterRes = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: `${secretToken} Empty Wall`,
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000001',
            teamMemberIds: ['P-000001'],
            fieldValues: { riskAssessment: { answers: BASE_LOW_RISK_ANSWERS } },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(wallMatterRes.errors).toBeUndefined();
        wallMatterId = wallMatterRes.matter!.id;
        const wallMatterUpdated: Matter = {
          ...wallMatterRes.matter!,
          hasEthicalWall: true,
          isStaffMatter: false,
          restrictedAccessUserIds: [],
        };
        await new TenantMatterRepository().putMatter(ctx, wallMatterUpdated, {
          expectedRowVersion: wallMatterRes.matter!.rowVersion ?? 1,
        });

        // Normal unrestricted matter in team TM-000002 (for team-scoped key date test)
        const normalMatterRes = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: null,
            title: 'Public Normal Matter S025',
            isStaffMatter: false,
            hasEthicalWall: false,
            restrictedAccessUserIds: [],
            responsiblePartnerId: 'P-000005',
            supervisingPartnerId: 'P-000005',
            leadFeeEarnerId: 'P-000005',
            teamMemberIds: ['P-000005'],
            fieldValues: { riskAssessment: { answers: BASE_LOW_RISK_ANSWERS } },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        );
        expect(normalMatterRes.errors).toBeUndefined();
        teamTwoMatterId = normalMatterRes.matter!.id;

        // Linked restricted document + key date attached to restricted / walled matters
        await insertSearchableDocument(ctx, {
          id: 'DOC-S025-RESTRICTED',
          title: `${secretToken} Confidential Memo`,
          fileName: 'cobalt-vault-memo.docx',
          primaryMatterId: null,
          linkedMatters: [wallMatterId],
        });

        await insertKeyDateForSearchTest(ctx, {
          id: 'KD-S025-RESTRICTED',
          matterId: restrictedMatterId,
          teamId: 'TM-000001',
          title: `${secretToken} Tribunal Deadline`,
        });

        // Restricted quote linked/converted to walled matter
        const restrictedQuoteRes = await saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: `${secretToken} Restricted Quote`,
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Restricted matter conversion quote',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 4500,
            validUntil: '2027-04-01',
            feeEarnerId: 'P-000001',
            followUpAfterDays: 7,
          },
          { byId: 'P-000004' },
        );
        expect(restrictedQuoteRes.error).toBeUndefined();
        const convertedRestrictedQuote: Quote = {
          ...restrictedQuoteRes.quote!,
          convertedMatterId: wallMatterId,
        };
        await new TenantIntakeQuoteRepository().putQuote(ctx, convertedRestrictedQuote);

        // Public quote for quote:view & finance redaction checks
        const publicQuoteRes = await saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'PublicQuoteRedactCheck Prospect',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Unrestricted commercial quote',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 4500,
            validUntil: '2027-04-01',
            feeEarnerId: 'P-000001',
            followUpAfterDays: 7,
          },
          { byId: 'P-000004' },
        );
        expect(publicQuoteRes.error).toBeUndefined();

        // Two key dates on normalMatter (TM-000001 own team vs TM-000003 outside team) for team scoping
        await insertKeyDateForSearchTest(ctx, {
          id: 'KD-S025-TEAM1',
          matterId: teamTwoMatterId,
          teamId: 'TM-000001',
          title: 'TeamScopedKeyDate One',
        });
        await insertKeyDateForSearchTest(ctx, {
          id: 'KD-S025-TEAM2',
          matterId: teamTwoMatterId,
          teamId: 'TM-000003',
          title: 'TeamScopedKeyDate Two',
        });
      },
      { mfaVerified: true },
    );

    // P-000001 creates linked task & complaint on the restricted/ethical-wall matters
    await runAsActionActor(
      'P-000001',
      async () => {
        const tRes = await saveTaskRecord(
          {
            title: `${secretToken} Prepare Staff File`,
            description: 'Strictly confidential task',
            dueAt: '2027-02-01',
            assignedTeamId: 'TM-000001',
            assignedPersonId: 'P-000001',
            linkedRecords: [{ recordType: 'matter', recordId: restrictedMatterId }],
          },
          'P-000001',
        );
        expect(tRes.error).toBeUndefined();

        const regRes = await createRegisterRecordService(
          {
            registerTypeKey: 'complaint',
            title: `${secretToken} Sensitive Complaint`,
            matterId: wallMatterId,
            fieldValues: {
              complainantName: 'Private Complainant',
              complaintSummary: `${secretToken} sensitive complaint details`,
            },
          },
          'P-000001',
        );
        expect(regRes.ok).toBe(true);
      },
      { roles: ['partner', 'fee_earner'] },
    );

    // P-000002 creates a personal Draft enquiry with secretToken
    await runAsActionActor(
      draftEnquiryCreatorId,
      async () => {
        const draftEnq = await saveEnquiryRecord(
          {
            firstName: 'Drafty',
            lastName: secretToken,
            channelId: 'enquiry_channel.phone',
            practiceAreaId: 'work_type.real_estate_and_property',
            urgencyId: 'urgency.standard',
            summary: `${secretToken} draft enquiry notes`,
            privacyNoticeGiven: false,
          },
          { byId: draftEnquiryCreatorId, asDraft: true },
        );
        expect(draftEnq.errors).toBeUndefined();
      },
      { roles: ['fee_earner'] },
    );

    // 3a. Excluded fee earner (P-000006, not in TM-000001/staff/wall, not creator of draft)
    //     MUST receive ZERO hits AND ZERO total/facet counts for secretToken!
    const excludedRes = await runAsActionActor(
      'P-000006',
      () => searchGlobalRecordsAction({ query: secretToken }),
      { roles: ['fee_earner'] },
    );
    expect(excludedRes.hits).toEqual([]);
    expect(excludedRes.totalCount).toBe(0);
    for (const k of GLOBAL_SEARCH_ENTITY_TYPES) {
      expect(excludedRes.countsByType[k]).toBe(0);
    }

    // Check P-000001 sees public quote (with fee amount) + staff/wall/doc/task/kd/complaint/restricted quote, NOT P-000002's personal Draft enquiry
    const partnerRes = await runAsActionActor(
      'P-000001',
      () => searchGlobalRecordsAction({ query: secretToken }),
      { roles: ['partner', 'fee_earner'] },
    );
    expect(partnerRes.countsByType.matter).toBe(2);
    expect(partnerRes.countsByType.document).toBe(1);
    expect(partnerRes.countsByType.key_date).toBe(1);
    expect(partnerRes.countsByType.task).toBeGreaterThanOrEqual(1);
    expect(partnerRes.countsByType.register_record).toBe(1);
    expect(partnerRes.countsByType.quote).toBe(1);
    expect(partnerRes.countsByType.enquiry).toBe(0); // personal Draft belongs to P-000002

    const partnerPublicQuote = await runAsActionActor(
      'P-000001',
      () => searchGlobalRecordsAction({ query: 'PublicQuoteRedactCheck' }),
      { roles: ['partner', 'fee_earner'] },
    );
    expect(partnerPublicQuote.countsByType.quote).toBe(1);
    expect(partnerPublicQuote.hits.find((h) => h.entityType === 'quote')?.subtitle).toContain('£');

    // Creator P-000002 sees ONLY their personal Draft enquiry — NOT the restricted matters/doc/task/kd/register/restricted quote
    const creatorRes = await runAsActionActor(
      draftEnquiryCreatorId,
      () => searchGlobalRecordsAction({ query: secretToken }),
      { roles: ['fee_earner'] },
    );
    expect(creatorRes.countsByType.enquiry).toBe(1);
    expect(creatorRes.countsByType.matter).toBe(0);
    expect(creatorRes.countsByType.document).toBe(0);
    expect(creatorRes.countsByType.key_date).toBe(0);
    expect(creatorRes.countsByType.task).toBe(0);
    expect(creatorRes.countsByType.quote).toBe(0);
    expect(creatorRes.countsByType.register_record).toBe(0);

    // 3b. Finance-only user (P-000009, lacks quote:view) must NOT see quotes
    const financeRes = await runAsActionActor(
      'P-000009',
      () => searchGlobalRecordsAction({ query: 'PublicQuoteRedactCheck' }),
      { roles: ['finance'] },
    );
    expect(financeRes.countsByType.quote).toBe(0);
    expect(financeRes.hits.some((h) => h.entityType === 'quote')).toBe(false);

    // 3c. Enquiries Coordinator without finance:view / finance:view_matter sees quote hit,
    //     but financial amount (£) is redacted from subtitle; and lacking document:view hides documents
    await runAsActionActor(
      'P-000004',
      async () => {
        const revRes = await updatePersonPermissionOverrides(
          'P-000008',
          {
            grant: ['quote:view'],
            revoke: ['document:view', 'finance:view', 'finance:view_matter'],
            reason: 'S0-25 quote redaction and document denial test',
          },
          'P-000004',
          { mfaVerified: true },
        );
        expect(revRes.ok).toBe(true);
      },
      { mfaVerified: true },
    );

    const noDocNoFinRes = await runAsActionActor(
      'P-000008',
      () => searchGlobalRecordsAction({ query: 'PublicQuoteRedactCheck' }),
      { roles: ['enquiries_coordinator'] },
    );
    expect(noDocNoFinRes.countsByType.quote).toBe(1);
    const redactedQuoteHit = noDocNoFinRes.hits.find((h) => h.entityType === 'quote');
    expect(redactedQuoteHit?.subtitle).not.toContain('£');

    const noDocCheck = await runAsActionActor(
      'P-000008',
      () => searchGlobalRecordsAction({ query: secretToken }),
      { roles: ['enquiries_coordinator'] },
    );
    expect(noDocCheck.countsByType.document).toBe(0);

    // 3d. Key date team scoping (without keydate:view_any_team) and missing keydate:view
    await runAsActionActor(
      'P-000004',
      async () => {
        await updatePersonPermissionOverrides(
          'P-000002',
          {
            grant: [],
            revoke: ['keydate:view_any_team'],
            reason: 'S0-25 restrict to own diary team only',
          },
          'P-000004',
          { mfaVerified: true },
        );
      },
      { mfaVerified: true },
    );

    const ownTeamKdRes = await runAsActionActor(
      'P-000002',
      () => searchGlobalRecordsAction({ query: 'TeamScopedKeyDate' }),
      { roles: ['fee_earner'] },
    );
    expect(ownTeamKdRes.countsByType.key_date).toBe(1);
    expect(ownTeamKdRes.hits.map((h) => h.id)).toEqual(['KD-S025-TEAM1']);

    // When keydate:view and register:view are revoked, zero key_date hits/counts
    await runAsActionActor(
      'P-000004',
      async () => {
        const revRes = await updatePersonPermissionOverrides(
          'P-000002',
          {
            grant: [],
            revoke: ['keydate:view', 'keydate:view_any_team', 'register:view'],
            reason: 'S0-25 revoke keydate:view and general register:view',
          },
          'P-000004',
          { mfaVerified: true },
        );
        expect(revRes.ok).toBe(true);
      },
      { mfaVerified: true },
    );

    const noKdRes = await runAsActionActor(
      'P-000002',
      () => searchGlobalRecordsAction({ query: 'TeamScopedKeyDate' }),
      { roles: ['fee_earner'] },
    );
    expect(noKdRes.countsByType.key_date).toBe(0);
    expect(noKdRes.hits).toEqual([]);

    // 3e. undertaking:manage WITHOUT register:view sees undertaking register records ONLY, NOT complaint records
    const filterRegToken = 'ZirconGateFilter982';
    let createdUndertakingId = '';
    await runAsActionActor(
      'P-000001',
      async () => {
        const uRes = await createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: `${filterRegToken} Direct Entry`,
            matterId: teamTwoMatterId,
            fieldValues: {
              recipientName: 'Veridian Bank plc',
              undertakingTerms: 'Discharge charge upon registration completion',
              givenByPersonId: 'P-000001',
            },
          },
          'P-000001',
        );
        expect(uRes.ok).toBe(true);
        if (uRes.ok) createdUndertakingId = uRes.record.id;

        const cRes = await createRegisterRecordService(
          {
            registerTypeKey: 'complaint',
            title: `${filterRegToken} Complaint Entry`,
            matterId: teamTwoMatterId,
            fieldValues: {
              complainantName: 'Test Client',
              complaintSummary: 'General service delay complaint',
            },
          },
          'P-000001',
        );
        expect(cRes.ok).toBe(true);
      },
      { roles: ['partner', 'fee_earner'] },
    );

    const undertakingOnlyRes = await runAsActionActor(
      'P-000002',
      () => searchGlobalRecordsAction({ query: filterRegToken }),
      { roles: ['fee_earner'] },
    );
    expect(undertakingOnlyRes.countsByType.register_record).toBe(1);
    expect(undertakingOnlyRes.hits.map((h) => h.id)).toEqual([createdUndertakingId]);
    expect(undertakingOnlyRes.hits.every((h) => !h.title.includes('Complaint'))).toBe(true);

    // 3f. Revoked matter:restricted:access respects opening_record_json->'restrictedAccessUserIdsFallback'
    // Before revoking: P-000003 holds matter:restricted:access via risk_compliance
    const beforeRevoke = await runAsActionActor(
      'P-000003',
      () => searchGlobalRecords({ query: `${secretToken} Staff Matter` }, 'P-000003'),
      { roles: ['risk_compliance', 'fee_earner', 'partner'] },
    );
    expect(beforeRevoke.hits.some((h) => h.id === restrictedMatterId)).toBe(true);

    await runAsActionActor(
      'P-000004',
      async () => {
        const revokeRestricted = await updatePersonPermissionOverrides(
          'P-000003',
          {
            grant: [],
            revoke: ['matter:restricted:access'],
            reason: 'S0-25 fallback allowlist verification',
          },
          'P-000004',
          { mfaVerified: true },
        );
        expect(revokeRestricted.ok).toBe(true);
      },
      { mfaVerified: true },
    );

    const afterRevoke = await runAsActionActor(
      'P-000003',
      () => searchGlobalRecords({ query: `${secretToken} Staff Matter` }, 'P-000003'),
      { roles: ['risk_compliance', 'fee_earner', 'partner'] },
    );
    expect(afterRevoke.hits.some((h) => h.id === restrictedMatterId)).toBe(false);
    expect(afterRevoke.totalCount).toBe(0);
  });

  it('4. Empties snap.searchIndex on getAppSnapshot, rejects unauthenticated searchGlobalRecordsAction, and scrubs query text from telemetry', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    getPlatformTelemetryRecorder().clearForTesting();

    // Unauthenticated call fails closed
    setTestActorSession(null);
    await expect(searchGlobalRecordsAction({ query: 'Pembroke' })).rejects.toThrow(
      /UNAUTHENTICATED|Sign in required/i,
    );

    const snap = await runAsTestActor('P-000004', () => getAppSnapshot('P-000004'));
    expect(snap.searchIndex).toEqual([]);

    const secretQuery = 'TopSecretClientNameZeta99';
    await runAsActionActor(
      'P-000004',
      async () => {
        const res = await searchGlobalRecordsAction({ query: secretQuery });
        expect(res.hits).toEqual([]);
        expect(res.totalCount).toBe(0);
      },
      { mfaVerified: true },
    );

    const entries = getPlatformTelemetryRecorder().getRecentEntries();
    const searchEvent = entries.find((e) => e.eventName === 'search.global.executed');
    expect(searchEvent).toBeDefined();
    expect(searchEvent?.tenantId).toBeTruthy();
    expect(searchEvent?.correlationId).toBeTruthy();
    expect(JSON.stringify(searchEvent)).not.toContain(secretQuery);
  });

  it('5. Enforces strict two-tenant PostgreSQL isolation across tenant-alpha and tenant-bravo and rejects forged tenant claims', async () => {
    const tenantAlpha = 's025-alpha';
    const tenantBravo = 's025-bravo';

    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha);
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo);

    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    // Forged tenant claim fails closed
    try {
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000004',
          name: 'Forger',
          email: 'forger@example.test',
          tenantId: tenantAlpha,
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        untrustedRequestTenantOverride: tenantBravo,
        correlationId: 'corr-forged-s025',
      });
      expect.fail('Expected TENANCY_FORGERY_DETECTED');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^TENANCY_FORGERY_DETECTED:.*override/i);
    }

    const rawBase = getActiveTenantRawBaseConfig();
    const alphaRaw = {
      ...structuredClone(rawBase),
      tenantId: tenantAlpha,
      displayName: 'Alpha Legal S025',
    };
    const bravoRaw = {
      ...structuredClone(rawBase),
      tenantId: tenantBravo,
      displayName: 'Bravo Legal S025',
    };

    const alphaCfg = loadAndValidateTenantConfig(alphaRaw, {}, 'test', 'multi_tenant');
    const bravoCfg = loadAndValidateTenantConfig(bravoRaw, {}, 'test', 'multi_tenant');

    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaCfg,
      store: createSeedStore(),
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoCfg,
      store: createSeedStore(),
      clearFirst: true,
    });

    const alphaSecret = 'AlphaMeridianExclusive771';
    const bravoSecret = 'BravoSolsticeExclusive882';

    setActiveTenantConfigForTesting(alphaRaw);
    await runAsActionActor(
      'P-000004',
      async () => {
        await saveOrganisationRecord(
          { legalName: `${alphaSecret} Corp`, companyNumber: '77100001' },
          { byId: 'P-000004' },
        );
      },
      { tenantId: tenantAlpha, mfaVerified: true },
    );

    setActiveTenantConfigForTesting(bravoRaw);
    await runAsActionActor(
      'P-000004',
      async () => {
        await saveOrganisationRecord(
          { legalName: `${bravoSecret} LLP`, companyNumber: '88200002' },
          { byId: 'P-000004' },
        );
      },
      { tenantId: tenantBravo, mfaVerified: true },
    );

    // Search using a brand-new TenantSearchRepository + fresh TenantPostgresPoolManager
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshSearchRepo = new TenantSearchRepository({ poolManager: freshPoolMgr });
    const fullActor = {
      actorId: 'P-000004',
      hasRestrictedMatterAccess: true,
      canViewDocuments: true,
      canViewQuotes: true,
      canViewFinance: true,
      canViewKeyDates: true,
      permittedDiaryTeamIds: ['TM-000001'],
      canViewRegisters: true,
      canManageUndertakings: true,
    };

    const alphaFindsOwn = await freshSearchRepo.searchRecords(ctxAlpha, {
      query: alphaSecret,
      actor: fullActor,
    });
    expect(alphaFindsOwn.totalCount).toBe(1);
    expect(alphaFindsOwn.hits[0]?.title).toContain(alphaSecret);

    const alphaCannotFindBravo = await freshSearchRepo.searchRecords(ctxAlpha, {
      query: bravoSecret,
      actor: fullActor,
    });
    expect(alphaCannotFindBravo.hits).toEqual([]);
    expect(alphaCannotFindBravo.totalCount).toBe(0);
    expect(alphaCannotFindBravo.countsByType.organisation).toBe(0);

    const bravoFindsOwn = await freshSearchRepo.searchRecords(ctxBravo, {
      query: bravoSecret,
      actor: fullActor,
    });
    expect(bravoFindsOwn.totalCount).toBe(1);

    const bravoCannotFindAlpha = await freshSearchRepo.searchRecords(ctxBravo, {
      query: alphaSecret,
      actor: fullActor,
    });
    expect(bravoCannotFindAlpha.hits).toEqual([]);
    expect(bravoCannotFindAlpha.totalCount).toBe(0);

    // Guarded action also respects tenant boundaries
    setActiveTenantConfigForTesting(bravoRaw);
    await runAsActionActor(
      'P-000004',
      async () => {
        const bravoActionRes = await searchGlobalRecordsAction({ query: alphaSecret });
        expect(bravoActionRes.hits).toEqual([]);
        expect(bravoActionRes.totalCount).toBe(0);
      },
      { tenantId: tenantBravo, mfaVerified: true },
    );
  });
});
