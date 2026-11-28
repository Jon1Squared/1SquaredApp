import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_API_VERSION,
  CORE_TENANT_MIGRATIONS,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantChasingRepository,
  TenantEvidenceArtifactRepository,
  TenantIntakeCheckRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantMoneyOnAccountRepository,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPmsRepository,
  TenantPostgresPoolManager,
  TenantRegisterRepository,
  TenantTaskWorkflowRepository,
  assertMoneyOnAccountSafeForEnvironment,
  isCoreApiRangeCompatible,
  isPlaceholderClientBankDetails,
  loadAndValidateTenantConfig,
  resolveMoneyOnAccountConfiguration,
  resolveTenantFromVerifiedToken,
  type DocumentPdfConverter,
  type MinorUnits,
  type MoneyOnAccountConfiguration,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  cancelMoneyOnAccountRequestAction,
  createAndSendMoneyOnAccountRequestAction,
  matchPmsClientLedgerReceiptAction,
  openProspectiveMatterAction,
  overrideMatterOpeningPreconditionAction,
  recordMoneyOnAccountReceiptAction,
  retryCommunicationChaseAction,
  reverseMoneyOnAccountReceiptAction,
  saveMoneyOnAccountConfigAction,
  stopCommunicationChaseAction,
} from '@/app/actions';
import * as evidenceDownloadRoute from '@/app/api/evidence/download/route';
import * as evidenceUploadRoute from '@/app/api/evidence/upload/route';
import { isActionDenied } from '@/domain/actionResult';
import { addDays } from '@/domain/dates';
import {
  buildMoneyOnAccountDisplaySummary,
  buildMoneyOnAccountPaymentReference,
  evaluateMatterFundsOnAccountGate,
  formatMaskedMoaConfigAuditSummary,
  maskBankDetailForAudit,
  resolveEffectiveMoneyOnAccountConfig,
} from '@/domain/moneyOnAccount';
import type { ConflictCheckRecordInput, Matter, Person, Task } from '@/domain/types';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { getDocumentStorage } from '@/server/documentGenerationServices';
import { loadAdminPageData, loadMatterDetailPageData } from '@/server/pageLoaders';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  completeClientCddRecord,
  createAndSendMoneyOnAccountRequestRecord,
  downloadOutboxAttachmentForAdminRecord,
  executeCommunicationChasesForTenant,
  getMatterOpeningGateStateRecord,
  matchPmsClientLedgerReceiptRecord,
  openProspectiveMatterRecord,
  prepareQuoteConversionRecord,
  recordCddChecklistItemRecord,
  recordMoneyOnAccountReceiptRecord,
  resetAllDemoData,
  reverseMoneyOnAccountReceiptRecord,
  saveMatterRecord,
  saveQuoteRecord,
  signOffMatterCostsRecord,
  startOrLoadClientCddRecord,
  transitionRegisterRecordService,
  updateMatterConflictRecord,
  updateMatterLifecycleStatusRecord,
  uploadEvidenceArtifactRecord,
} from '@/server/services';
import {
  auditEntriesForRecord,
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

const HIGH_RISK_ANSWERS: Record<string, string> = {
  ...BASE_LOW_RISK_ANSWERS,
  highRiskJurisdictionLink: 'Yes',
};

const HIGH_RISK_FOLLOW_UPS: Record<string, string> = {
  highRiskJurisdictionLink: 'Simulated high-risk jurisdiction factor for S1-08 test.',
};

function makeConflictRecord(
  actorId: string,
  actorName: string,
  status: ConflictCheckRecordInput['status'] = 'Cleared',
): ConflictCheckRecordInput {
  return {
    status,
    outcomeLabel:
      status === 'Cleared'
        ? 'Cleared by fee earner'
        : status === 'Approved'
          ? 'Approved by Risk & Compliance'
          : 'Pending',
    declarationConfirmed: true,
    reviewerMessage: '',
    lastRunAtDisplay: '27 Nov 2026',
    lastRunById: actorId,
    lastRunByName: actorName,
    submittedAtDisplay: '27 Nov 2026',
    submittedByName: actorName,
    parties: [],
    matches: [],
    runs: [],
    comments: [],
  };
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

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId: string,
  roles: readonly string[] = ['partner', 'admin'],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `User ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles: [...roles],
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s108-${tenantId}-${actorId}`,
  });
}

function makeMoaTestConfig(overrides?: {
  chasingEnabled?: boolean;
  sendEmails?: boolean;
  moaEnabled?: boolean;
  liveEnv?: boolean;
}) {
  const baseObj = notALawFirmBaseConfig as unknown as Record<string, unknown>;
  const baseIntegrations = (baseObj.integrations ?? {}) as Record<string, unknown>;
  const baseMoa = (baseObj.moneyOnAccount ?? {}) as Record<string, unknown>;
  const raw = {
    ...baseObj,
    tenantId: 'not-a-law-firm',
    integrations: {
      ...baseIntegrations,
      email: { provider: 'disabled' },
    },
    chasing: {
      ...((baseObj.chasing ?? {}) as Record<string, unknown>),
      moneyOnAccount: {
        enabled: overrides?.chasingEnabled ?? true,
        sendEmails: overrides?.sendEmails ?? true,
        firstChaseDays: 7,
        secondChaseDays: 14,
        escalateTaskDays: 21,
      },
    },
    moneyOnAccount:
      overrides?.moaEnabled === false
        ? {
            ...baseMoa,
            enabled: false,
            clientAccount: {
              accountName: '',
              bankName: '',
              sortCode: '',
              accountNumber: '',
              iban: '',
              bic: '',
              allowDemoPlaceholderDetails: false,
            },
          }
        : baseMoa,
  };
  return { raw };
}

function buildMinimalPmsDataset(matterCode: string, txRows: Array<{
  transaction_id: string;
  date: string;
  type: 'Receipt' | 'Payment' | 'Transfer to office';
  description: string;
  amount: number;
  amount_pence: number;
}>) {
  return {
    extractInfo: {
      asAtDate: '2026-11-27',
      sourceFile: 's108-test-extract.xlsx',
      importedAt: '2026-11-27T08:00:00.000Z',
    },
    feeEarners: [
      {
        fee_earner_id: 'FE-01',
        initials: 'RM',
        first_name: 'Rhian',
        last_name: 'Morgan',
        email: 'rhian@notalawfirm.example',
        grade: 'Partner',
        department: 'Real Estate & Property',
        standard_hourly_rate: 360,
        annual_target_hours: 1200,
        annual_target_fees: 350000,
        active: 'Yes' as const,
      },
    ],
    clients: [
      {
        client_code: 'CL-S108-1',
        client_name: 'Oakridge Manufacturing Ltd',
        client_type: 'Organisation' as const,
        company_number: '10000001',
        email: 'accounts@oakridge.test',
        phone: '029 2018 0100',
        billing_address: '1 High Street',
        postcode: 'CF10 1AA',
        client_partner_id: 'FE-01',
        credit_terms_days: 30,
        credit_limit: 50000,
        rate_discount_pct: 0,
        date_opened: '2025-01-15',
        sector: 'Industrial',
        crm_match_on: 'company_number' as const,
        status: 'Active' as const,
      },
    ],
    matters: [
      {
        matter_code: matterCode,
        client_code: 'CL-S108-1',
        client_name: 'Oakridge Manufacturing Ltd',
        matter_description: 'Conveyancing purchase',
        work_type: 'Residential Conveyancing',
        practice_area: 'Real Estate & Property',
        responsible_partner_id: 'FE-01',
        responsible_partner_name: 'Rhian Morgan',
        fee_earner_id: 'FE-01',
        fee_earner_name: 'Rhian Morgan',
        billing_basis: 'Fixed Fee' as const,
        fixed_fee_amount: 1450,
        estimate_alert_pct: 80,
        date_opened: '2026-11-01',
        date_closed: null,
        status: 'Pending' as const,
        billing_frequency: 'On completion',
        client_reference: 'OAK-001',
        third_party_payer: '',
        fee_estimate: 1450,
        time_value_recorded: 0,
        unbilled_wip: 0,
        fees_billed: 0,
        disbursements_billed: 0,
        total_invoiced_inc_vat: 0,
        total_paid: 0,
        outstanding_debt: 0,
        client_account_balance: 500,
      },
    ],
    feeEstimates: [],
    invoices: [],
    payments: [],
    timeEntries: [],
    disbursements: [],
    clientAccount: txRows.map((row) => ({
      transaction_id: row.transaction_id,
      matter_code: matterCode,
      client_code: 'CL-S108-1',
      date: row.date,
      type: row.type,
      description: row.description,
      amount: row.amount,
      amount_pence: row.amount_pence as MinorUnits,
      running_balance: 500,
      running_balance_pence: 50000 as MinorUnits,
    })),
  };
}

async function ensureOrgValidCdd(orgId: string, actorId: string) {
  await runAsActionActor(
    actorId,
    async () => {
      const started = await startOrLoadClientCddRecord(
        { subjectType: 'organisation', subjectId: orgId, createIfMissing: true },
        actorId,
      );
      if (!started.ok) throw new Error(started.message);
      const incompleteItems = started.summary.checklistItems.filter(
        (item) => item.status !== 'recorded',
      );
      if (
        started.summary.record &&
        (incompleteItems.length > 0 || started.summary.status !== 'recorded')
      ) {
        for (const item of incompleteItems) {
          const res = await recordCddChecklistItemRecord(
            {
              recordId: started.summary.record.id,
              itemKey: item.itemKey,
              status: 'recorded',
              note: 'Verified for S1-08 test',
            },
            actorId,
          );
          if (!res.ok) throw new Error(res.message);
        }
        const comp = await completeClientCddRecord(
          { recordId: started.summary.record.id },
          actorId,
        );
        if (!comp.ok) throw new Error(comp.message);
      }
    },
    { roles: ['partner'], mfaVerified: false },
  );
}

async function createConveyancingProspectiveMatter(params?: {
  title?: string;
  retainerMoniesOnAccountPence?: number | null;
  feeEstimateGbp?: number;
  riskAnswers?: Record<string, string>;
  riskFollowUps?: Record<string, string>;
  responsiblePartnerId?: string;
  leadFeeEarnerId?: string;
  signedEngagement?: boolean;
  conflictStatus?: ConflictCheckRecordInput['status'];
  saveMode?: 'submit_cleared' | 'submit_referred';
  isStaffMatter?: boolean;
  restrictedAccessUserIds?: string[];
}) {
  const actorId = params?.leadFeeEarnerId ?? 'P-000002';
  const conflictStatus = params?.conflictStatus ?? 'Cleared';
  const saved = await runAsActionActor(
    actorId,
    () =>
      saveMatterRecord(
        {
          title: params?.title ?? 'S1-08 Conveyancing Matter',
          clientId: 'O-000001',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
          responsiblePartnerId: params?.responsiblePartnerId ?? 'P-000001',
          supervisingPartnerId: params?.responsiblePartnerId ?? 'P-000001',
          leadFeeEarnerId: actorId,
          teamMemberIds: ['P-000001', 'P-000002', 'P-000009'],
          feeEstimateGbp: params?.feeEstimateGbp ?? 1200,
          retainerMoniesOnAccountGbp:
            params?.retainerMoniesOnAccountPence !== undefined
              ? params.retainerMoniesOnAccountPence === null
                ? null
                : params.retainerMoniesOnAccountPence / 100
              : null,
          retainerMoniesOnAccountPence: params?.retainerMoniesOnAccountPence ?? null,
          ...(params?.isStaffMatter !== undefined ? { isStaffMatter: params.isStaffMatter } : {}),
          ...(params?.restrictedAccessUserIds !== undefined
            ? { restrictedAccessUserIds: params.restrictedAccessUserIds }
            : {}),
          conflictCheckRecord: makeConflictRecord(actorId, 'Dafydd Evans', conflictStatus),
          riskAssessment: {
            answers: params?.riskAnswers ?? BASE_LOW_RISK_ANSWERS,
            ...(params?.riskFollowUps ? { followUps: params.riskFollowUps } : {}),
          },
        },
        { byId: actorId, saveMode: params?.saveMode ?? 'submit_cleared' },
      ),
    { roles: ['fee_earner', 'partner'], mfaVerified: false },
  );
  if (!saved.matter) {
    throw new Error(`Failed to save S1-08 matter: ${JSON.stringify(saved.errors)}`);
  }
  if (params?.signedEngagement) {
    const signedAt = new Date().toISOString();
    const matterRepo = new TenantMatterRepository();
    const ctx = testTenantCtx(actorId);
    return await matterRepo.putMatter<Matter>(
      ctx,
      {
        ...saved.matter,
        engagementLetterStatus: 'Signed & returned',
        engagementLetterSignedAt: signedAt,
      },
      { expectedRowVersion: null },
    );
  }
  return saved.matter;
}

describe('S1-08 (ADR 0043): Money on Account Requests, Chasing, Manual/PMS Receipts, Bank Audit, Evidence Separation & Transactional Opening Gate', () => {
  afterEach(() => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
  });

  it('1. Unit & Core API contracts: payment ref <= 18 ASCII zero-PII (no R866 clashes), live placeholder refusal, safe core defaults & R824/R864 masking', () => {
    expect(isCoreApiRangeCompatible(CORE_API_VERSION, '^2.6.0')).toBe(true);

    // Safe core defaults: enabled=false, empty client account
    const coreDefaults = resolveMoneyOnAccountConfiguration(undefined);
    expect(coreDefaults.enabled).toBe(false);
    expect(coreDefaults.clientAccount.accountName).toBe('');
    expect(coreDefaults.clientAccount.sortCode).toBe('');
    expect(coreDefaults.clientAccount.accountNumber).toBe('');
    expect(coreDefaults.clientAccount.allowDemoPlaceholderDetails).toBe(false);
    expect(coreDefaults.paymentReferencePrefix).toBe('MOA');

    // Payment reference formatting <= 18 chars ASCII with zero client PII
    const refFromNumber = buildMoneyOnAccountPaymentReference({
      prefix: 'MOA',
      matterNumber: 'MAT001-0004',
      matterId: 'M-000012',
      sequenceNumber: 1,
    });
    expect(refFromNumber).toBe('MOA-MAT0010004-01');
    expect(refFromNumber.length).toBeLessThanOrEqual(18);
    expect(refFromNumber).toMatch(/^[A-Z0-9-]+$/);

    const refFromDraftMatter = buildMoneyOnAccountPaymentReference({
      prefix: 'MOA',
      matterNumber: 'DRAFT',
      matterId: 'M-000099',
      sequenceNumber: 2,
    });
    expect(refFromDraftMatter).toBe('MOA-M000099-02');
    expect(refFromDraftMatter.length).toBeLessThanOrEqual(18);

    // R866: 6-char prefix with MAT0010004 and MAT0010005 must NOT truncate to collide; >10-char matter number works
    const ref6A = buildMoneyOnAccountPaymentReference({
      prefix: 'ABCDEF',
      matterNumber: 'MAT001-0004',
      matterId: 'M-000004',
      sequenceNumber: 1,
    });
    const ref6B = buildMoneyOnAccountPaymentReference({
      prefix: 'ABCDEF',
      matterNumber: 'MAT001-0005',
      matterId: 'M-000005',
      sequenceNumber: 1,
    });
    expect(ref6A).not.toBe(ref6B);
    expect(ref6A.length).toBeLessThanOrEqual(18);
    expect(ref6B.length).toBeLessThanOrEqual(18);
    expect(ref6A).toMatch(/^[A-Z0-9-]+$/);

    const refLong1 = buildMoneyOnAccountPaymentReference({
      prefix: 'MOA',
      matterNumber: 'LONGCLIENT2026-0001',
      matterId: 'M-001001',
      sequenceNumber: 1,
    });
    const refLong2 = buildMoneyOnAccountPaymentReference({
      prefix: 'MOA',
      matterNumber: 'LONGCLIENT2026-0002',
      matterId: 'M-001002',
      sequenceNumber: 1,
    });
    expect(refLong1).not.toBe(refLong2);
    expect(refLong1.length).toBeLessThanOrEqual(18);
    expect(refLong2.length).toBeLessThanOrEqual(18);

    // Placeholder detection & live refusal
    const effectiveDemo = resolveEffectiveMoneyOnAccountConfig(
      notALawFirmBaseConfig as never,
    );
    expect(isPlaceholderClientBankDetails(effectiveDemo.clientAccount)).toBe(true);
    expect(() =>
      assertMoneyOnAccountSafeForEnvironment(effectiveDemo, 'test'),
    ).not.toThrow();
    expect(() =>
      assertMoneyOnAccountSafeForEnvironment(effectiveDemo, 'live'),
    ).toThrow(/MOA_LIVE_PLACEHOLDER_BANK_DETAILS_FORBIDDEN/);

    // R824 bank detail masking (only last 2 chars preserved) & R864 browser summary DTO
    expect(maskBankDetailForAudit('12-34-56', 'sortCode')).toBe('**-**-56');
    expect(maskBankDetailForAudit('87654321', 'accountNumber')).toBe('******21');
    expect(maskBankDetailForAudit('GB29NWBK60161331926819', 'iban')).toBe(
      '********************19',
    );
    const fullRealConfig = {
      ...effectiveDemo,
      clientAccount: {
        accountName: 'Real Firm Client Account',
        bankName: 'Real Bank plc',
        sortCode: '12-34-56',
        accountNumber: '87654321',
        iban: 'GB29NWBK60161331926819',
        bic: 'NWBKGB2L',
        allowDemoPlaceholderDetails: false,
      },
    };
    const auditSummary = formatMaskedMoaConfigAuditSummary(fullRealConfig);
    expect(auditSummary).not.toContain('12-34-56');
    expect(auditSummary).not.toContain('87654321');
    expect(auditSummary).not.toContain('GB29NWBK60161331926819');
    expect(auditSummary).toContain('**-**-56');
    expect(auditSummary).toContain('******21');
    expect(auditSummary).toContain('19');

    const displaySummaryJson = JSON.stringify(
      buildMoneyOnAccountDisplaySummary(fullRealConfig),
    );
    expect(displaySummaryJson).not.toContain('12-34-56');
    expect(displaySummaryJson).not.toContain('87654321');
    expect(displaySummaryJson).not.toContain('GB29NWBK60161331926819');
    expect(displaySummaryJson).toContain('**-**-56');
    expect(displaySummaryJson).toContain('******21');
  });

  it('2. Request dispatch builds PDF outside TX (<= 3 MB), enqueues outbox (matter_id/quote_id) + ADR 0038 check, enforces Lesson 3 idempotency, and blocks unconfigured/live placeholder', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const outboxRepo = new TenantOutboxRepository();
    const chasingRepo = new TenantChasingRepository();
    const checkRepo = new TenantIntakeCheckRepository();
    const moaRepo = new TenantMoneyOnAccountRepository();

    // Unconfigured / disabled check fails closed with MOA_NOT_CONFIGURED
    const { raw: disabledMoaRaw } = makeMoaTestConfig({ moaEnabled: false });
    setActiveTenantConfigForTesting(disabledMoaRaw, {});
    const matterA = await createConveyancingProspectiveMatter({
      title: 'S1-08 Unconfigured Test',
      retainerMoniesOnAccountPence: 50_000,
    });

    const notConfiguredRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matterA.id,
          idempotencyKey: 'unconf-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(notConfiguredRes.ok).toBe(false);
    if (!notConfiguredRes.ok && !isActionDenied(notConfiguredRes)) {
      expect(notConfiguredRes.code).toBe('MOA_NOT_CONFIGURED');
    }

    // Oversized PDF check runs pre-TX and blocks cleanly
    const { raw: enabledMoaRaw } = makeMoaTestConfig({ moaEnabled: true });
    setActiveTenantConfigForTesting(enabledMoaRaw, {});
    const oversizedConverter: DocumentPdfConverter = {
      converterId: 's108-oversized',
      async convertDocxToPdf() {
        return new Uint8Array(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES + 1024);
      },
    };
    const bigPdfRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestRecord(
          {
            matterId: matterA.id,
            requestedAmountPence: 50_000,
            idempotencyKey: 'oversize-moa-1',
          },
          'P-000002',
          { pdfConverter: oversizedConverter },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(bigPdfRes.ok).toBe(false);
    if (!bigPdfRes.ok) {
      expect(bigPdfRes.code).toBe('EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED');
    }
    expect(await moaRepo.listRequestsForMatter(ctx, matterA.id)).toHaveLength(0);

    // Live placeholder refusal check
    const livePlaceholderRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestRecord(
          {
            matterId: matterA.id,
            requestedAmountPence: 50_000,
            idempotencyKey: 'live-placeholder-1',
          },
          'P-000002',
          { tenantConfig: { ...enabledMoaRaw, environment: 'live' } as never },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(livePlaceholderRes.ok).toBe(false);
    if (!livePlaceholderRes.ok) {
      expect(livePlaceholderRes.code).toBe('MOA_LIVE_PLACEHOLDER_BANK_DETAILS_FORBIDDEN');
    }

    // Create quote with £500 POA -> convert -> send request linked to quoteId
    const quoteRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteRecord(
          {
            clientType: 'existing',
            linkedOrganisationId: 'O-000001',
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
            scope: 'Purchase with quote POA',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1500,
            paymentOnAccountRequired: true,
            paymentOnAccountPence: 50_000,
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000002',
            followUpAfterDays: 7,
          },
          { byId: 'P-000002', markAsSent: true, sendMode: 'offline' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (quoteRes.error || !quoteRes.quote) throw new Error(quoteRes.error);
    const quoteId = quoteRes.quote.id;

    // Accept and convert quote -> link matter
    await runAsActionActor(
      'P-000002',
      () => prepareQuoteConversionRecord(quoteId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const convMatterSave = await runAsActionActor(
      'P-000002',
      () =>
        saveMatterRecord(
          {
            title: 'S1-08 Quote Converted Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
            sourceQuoteId: quoteId,
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002', 'P-000009'],
            retainerMoniesOnAccountGbp: 500,
            retainerMoniesOnAccountPence: 50_000,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'submit_cleared' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const convMatterId = convMatterSave.matter!.id;

    // Primary send -> pre-fills £500 from matter/quote, enqueues PDF, ADR 0038 check & chase
    const idempKey = 'moa-send-key-1';
    const send1 = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: convMatterId,
          quoteId,
          recipientEmail: 'accounts@oakridge.test',
          recipientName: 'Oakridge Finance',
          idempotencyKey: idempKey,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(send1)).toBe(false);
    expect(send1.ok).toBe(true);
    if (!send1.ok) return;
    expect(send1.deduplicated).toBe(false);
    expect(send1.emailProviderDisabled).toBe(true);
    expect(send1.request.requestedAmountPence).toBe(50_000);
    expect(send1.request.paymentReference).toMatch(/^MOA-[A-Z0-9]{1,10}-01$/);
    expect(send1.request.status).toBe('requested');
    expect(send1.request.bankDetailsSnapshot.sortCode).toBe('**-**-00');
    expect(send1.request.bankDetailsSnapshot.accountNumber).toBe('******00');
    const persistedReq1 = await new TenantMoneyOnAccountRepository().getRequestById(
      ctx,
      send1.request.id,
    );
    expect(persistedReq1?.bankDetailsSnapshot.sortCode).toBe('00-00-00');
    expect(persistedReq1?.bankDetailsSnapshot.accountNumber).toBe('00000000');
    expect(send1.outboxRecord?.matterId).toBe(convMatterId);
    expect(send1.outboxRecord?.quoteId).toBe(quoteId);
    expect(send1.outboxRecord?.htmlBody).toBeNull();
    expect(send1.outboxRecord?.textBody).toBeNull();
    const send1Json = JSON.stringify(send1);
    expect(send1Json).not.toContain('00-00-00');
    expect(send1Json).not.toContain('00000000');
    expect(send1.chase?.entityKind).toBe('money_on_account');
    expect(send1.chase?.entityId).toBe(send1.request.id);
    expect(send1.chase?.status).toBe('active');
    expect((send1.request as unknown as Record<string, unknown>).amlStatus).toBeUndefined();

    // Admin inspects outbox PDF attachment (%PDF-, reference, demo bank details, zero CDD/AML)
    const attRes = await runAsActionActor(
      'P-000004',
      () =>
        downloadOutboxAttachmentForAdminRecord(
          { outboxId: send1.outboxRecord!.id, ordinal: 0 },
          'P-000004',
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(attRes.ok).toBe(true);
    if (attRes.ok) {
      const pdfBytesText = Buffer.from(attRes.attachment.contentBytes).toString('latin1');
      expect(pdfBytesText.startsWith('%PDF-')).toBe(true);
      expect(pdfBytesText).not.toContain('amlStatus');
    }

    const checks = await checkRepo.listChecksForSubject(ctx, {
      subjectType: 'matter',
      subjectId: convMatterId,
      checkKind: 'payment_request',
    });
    expect(checks.filter((c) => c.outcome === 'requested_manual')).toHaveLength(1);

    // Lesson 3: Re-submitting with SAME idempotencyKey returns deduplicated result with zero duplicates
    const dupRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: convMatterId,
          quoteId,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: idempKey,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(dupRes.ok).toBe(true);
    if (dupRes.ok) {
      expect(dupRes.deduplicated).toBe(true);
      expect(dupRes.request.id).toBe(send1.request.id);
    }
    expect(await moaRepo.listRequestsForMatter(ctx, convMatterId)).toHaveLength(1);
    const outboxForMatter = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
      (r) => r.matterId === convMatterId,
    );
    expect(outboxForMatter).toHaveLength(1);
    expect(
      (await chasingRepo.listChasesForMatter(ctx, convMatterId)).filter(
        (c) => c.chase.entityKind === 'money_on_account',
      ),
    ).toHaveLength(1);

    // New key creates distinct -02 request
    const send2 = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: convMatterId,
          requestedAmountPence: 25_000,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: 'moa-send-key-2',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(send2.ok).toBe(true);
    if (send2.ok) {
      expect(send2.deduplicated).toBe(false);
      expect(send2.request.paymentReference).toMatch(/^MOA-[A-Z0-9]{1,10}-02$/);
    }

    // R876 item 7: off-client email flags offClientEmail=true (zero PII); client email does not
    const send2Audits = await auditEntriesForRecord('money_on_account_request', send2.ok ? send2.request.id : '');
    const offClientAudit = send2Audits.find((a) => a.field === 'Money on account requested');
    expect(offClientAudit?.newValue).toContain('; offClientEmail=true');
    expect(offClientAudit?.newValue).not.toContain('accounts@oakridge.test');

    const org1 = await new TenantPartyRepository().getOrganisationById(ctx, 'O-000001');
    const matchedClientEmail = org1?.generalEmail?.trim() || '';
    expect(matchedClientEmail).toBeTruthy();
    const sendMatched = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: convMatterId,
          requestedAmountPence: 10_000,
          recipientEmail: matchedClientEmail,
          idempotencyKey: 'moa-send-matched-email',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendMatched.ok).toBe(true);
    if (sendMatched.ok) {
      const matchedAudits = await auditEntriesForRecord('money_on_account_request', sendMatched.request.id);
      const matchedEntry = matchedAudits.find((a) => a.field === 'Money on account requested');
      expect(matchedEntry?.newValue).not.toContain('offClientEmail=true');
    }

    // R866: Concurrent request sends on same matter retry and produce strictly consecutive -01, -02
    await ensureOrgValidCdd('O-000001', 'P-000001');
    const concMatter = await createConveyancingProspectiveMatter({
      title: 'S1-08 Concurrent Ref Seq Matter',
      retainerMoniesOnAccountPence: 50_000,
      signedEngagement: true,
    });
    const [c1, c2] = await Promise.all([
      runAsTestActor(
        'P-000002',
        () =>
          createAndSendMoneyOnAccountRequestRecord(
            {
              matterId: concMatter.id,
              requestedAmountPence: 20_000,
              recipientEmail: 'accounts@oakridge.test',
              idempotencyKey: 'conc-seq-a',
            },
            'P-000002',
            {
              tenantCtx: testTenantCtx('P-000002', {
                roles: ['fee_earner'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      ),
      runAsTestActor(
        'P-000002',
        () =>
          createAndSendMoneyOnAccountRequestRecord(
            {
              matterId: concMatter.id,
              requestedAmountPence: 30_000,
              recipientEmail: 'accounts@oakridge.test',
              idempotencyKey: 'conc-seq-b',
            },
            'P-000002',
            {
              tenantCtx: testTenantCtx('P-000002', {
                roles: ['fee_earner'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      ),
    ]);
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    if (c1.ok && c2.ok) {
      const seqSuffixes = [c1.request.paymentReference, c2.request.paymentReference]
        .map((ref) => ref.split('-').pop()!)
        .sort();
      expect(seqSuffixes).toEqual(['01', '02']);
    }

    // R871: Requesting £1,000 on a matter with no agreed POA does NOT backfill retainer_monies_on_account_pence;
    // cancelling £1,000 and sending + paying £500 satisfies funds_on_account and opens cleanly.
    const noAgreedMatter = await createConveyancingProspectiveMatter({
      title: 'S1-08 R871 No Agreed POA Matter',
      retainerMoniesOnAccountPence: null,
      feeEstimateGbp: 400,
      signedEngagement: true,
    });
    const r871WrongReq = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: noAgreedMatter.id,
          requestedAmountPence: 100_000,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: 'r871-wrong-1000',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r871WrongReq.ok).toBe(true);
    if (!r871WrongReq.ok) return;
    const matterAfterWrongReq = await new TenantMatterRepository().getMatterById<Matter>(
      ctx,
      noAgreedMatter.id,
    );
    expect(matterAfterWrongReq?.retainerMoniesOnAccountPence ?? null).toBeNull();

    const r871Cancel = await runAsActionActor(
      'P-000002',
      () =>
        cancelMoneyOnAccountRequestAction({
          requestId: r871WrongReq.request.id,
          reason: 'Requested £1,000 in error',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r871Cancel.ok).toBe(true);

    const r871RightReq = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: noAgreedMatter.id,
          requestedAmountPence: 50_000,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: 'r871-right-500',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!r871RightReq.ok) throw new Error(String(r871RightReq.error));
    const r871Paid = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: r871RightReq.request.id,
          amountPence: 50_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r871Paid.ok).toBe(true);
    const r871Open = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(noAgreedMatter.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r871Open.ok).toBe(true);
  }, 60_000);

  it('3. Chasing 7/14/21 lifecycle, Lesson 1 adapter & R818 re-send key, Lesson 2 same-TX stop + oldValue audit, and R824 MFA + masked bank details audit', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const { raw } = makeMoaTestConfig({ chasingEnabled: true, sendEmails: true });
    setActiveTenantConfigForTesting(raw, {});

    // R824: saveMoneyOnAccountConfigAction requires admin:access + MFA and masks old/new bank details in audit
    const nonAdminSave = await runAsActionActor(
      'P-000002',
      () =>
        saveMoneyOnAccountConfigAction(
          { enabled: true },
          'Unauthorized fee earner change',
        ),
      { roles: ['fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(nonAdminSave)).toBe(true);

    const noMfaSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          {
            clientAccount: {
              accountName: 'Updated Client Account',
              bankName: 'Updated Clearing Bank',
              sortCode: '12-34-56',
              accountNumber: '87654321',
              iban: 'GB29NWBK60161331926819',
              bic: 'NWBKGB2L',
              allowDemoPlaceholderDetails: false,
            },
          },
          'Update bank details without MFA',
        ),
      { roles: ['admin'], mfaVerified: false },
    );
    expect(noMfaSave).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });

    const mfaSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          {
            enabled: true,
            paymentReferencePrefix: 'NALF',
            clientAccount: {
              accountName: 'Updated Client Account',
              bankName: 'Updated Clearing Bank',
              sortCode: '12-34-56',
              accountNumber: '87654321',
              iban: 'GB29NWBK60161331926819',
              bic: 'NWBKGB2L',
              allowDemoPlaceholderDetails: false,
            },
          },
          'Rotate client bank details after signatory check',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(mfaSave.ok).toBe(true);
    if (!mfaSave.ok) throw new Error(String(mfaSave.error));
    expect('config' in mfaSave).toBe(false);
    expect(mfaSave.summary.maskedSortCode).toBe('**-**-56');
    expect(mfaSave.summary.maskedAccountNumber).toBe('******21');
    const mfaSaveJson = JSON.stringify(mfaSave);
    expect(mfaSaveJson).not.toContain('12-34-56');
    expect(mfaSaveJson).not.toContain('87654321');
    expect(mfaSaveJson).not.toContain('GB29NWBK60161331926819');

    const configAudits = await auditEntriesForRecord('money_on_account_config', 'FIRM-MOA-CONFIG');
    expect(configAudits.length).toBeGreaterThanOrEqual(1);
    const latestAudit = configAudits[configAudits.length - 1]!;
    expect(latestAudit.byId).toBe('P-000004');
    expect(latestAudit.reason).toBe('Rotate client bank details after signatory check');
    expect(latestAudit.newValue).toContain('**-**-56');
    expect(latestAudit.newValue).toContain('******21');
    expect(latestAudit.newValue).toContain('19');
    expect(latestAudit.newValue).not.toContain('12-34-56');
    expect(latestAudit.newValue).not.toContain('87654321');
    expect(latestAudit.newValue).not.toContain('GB29NWBK60161331926819');
    expect(latestAudit.oldValue).not.toContain('00-00-00');
    expect(latestAudit.oldValue).not.toContain('00000000');

    // R867 & R881: saveMoneyOnAccountConfigAction validates merged config with plain labels (never raw field paths)
    const badEnabledSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          { enabled: 'yes' as unknown as boolean },
          'Invalid enabled boolean type',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(badEnabledSave).toMatchObject({ ok: false, code: 'MOA_CONFIG_VALIDATION_ERROR' });
    if (!badEnabledSave.ok && !isActionDenied(badEnabledSave)) {
      expect(badEnabledSave.message).toContain('Money on Account enabled');
    }

    const longWordingSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          {
            requestWordings: {
              introductoryParagraph: 'W'.repeat(4001),
            } as unknown as MoneyOnAccountConfiguration['requestWordings'],
          },
          'Excessive wording length test',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(longWordingSave).toMatchObject({ ok: false, code: 'MOA_CONFIG_VALIDATION_ERROR' });
    if (!longWordingSave.ok && !isActionDenied(longWordingSave)) {
      expect(longWordingSave.message).toContain('Introductory paragraph');
      expect(longWordingSave.message).not.toContain('requestWordings.introductoryParagraph');
    }

    const badSortCodeSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          {
            clientAccount: {
              sortCode: '12-34-56-0000000000',
            } as unknown as MoneyOnAccountConfiguration['clientAccount'],
          },
          'Excessive sort code length test',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(badSortCodeSave).toMatchObject({ ok: false, code: 'MOA_CONFIG_VALIDATION_ERROR' });
    if (!badSortCodeSave.ok && !isActionDenied(badSortCodeSave)) {
      expect(badSortCodeSave.message).toContain('Sort code');
      expect(badSortCodeSave.message).not.toContain('clientAccount.sortCode');
    }

    const badAccountNumberSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          {
            clientAccount: {
              accountNumber: '1'.repeat(33),
            } as unknown as MoneyOnAccountConfiguration['clientAccount'],
          },
          'Excessive account number length test',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(badAccountNumberSave).toMatchObject({ ok: false, code: 'MOA_CONFIG_VALIDATION_ERROR' });
    if (!badAccountNumberSave.ok && !isActionDenied(badAccountNumberSave)) {
      expect(badAccountNumberSave.message).toContain('Account number');
      expect(badAccountNumberSave.message).not.toContain('clientAccount.accountNumber');
    }

    const badPrefixSave = await runAsActionActor(
      'P-000004',
      () =>
        saveMoneyOnAccountConfigAction(
          { paymentReferencePrefix: 'a' },
          'Invalid prefix length test',
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(badPrefixSave).toMatchObject({ ok: false, code: 'MOA_CONFIG_VALIDATION_ERROR' });
    if (!badPrefixSave.ok && !isActionDenied(badPrefixSave)) {
      expect(badPrefixSave.message).toContain('Payment reference prefix');
      expect(badPrefixSave.message).not.toContain('moneyOnAccount.paymentReferencePrefix');
    }

    // Create matter and send request -> verify Day 7, Day 14, Day 21 execution
    const matter = await createConveyancingProspectiveMatter({
      title: 'S1-08 Chasing Lifecycle Matter',
      retainerMoniesOnAccountPence: 40_000,
    });
    const sent1 = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 40_000,
          recipientEmail: 'chase-client@example.test',
          recipientName: 'Chase Client',
          idempotencyKey: 'chase-req-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!sent1.ok) throw new Error(String(sent1.error));
    expect(sent1.request.paymentReference).toMatch(/^NALF-/);

    // R864: Admin & matter loaders never pass raw bank details (sortCode/accountNumber/IBAN) to browser,
    // and Enquiries/Intake users receive no MOA config/requests/receipts at all.
    const adminPageData = await runAsActionActor(
      'P-000004',
      () => loadAdminPageData('P-000004', { mfaVerified: true }),
      { roles: ['admin'], mfaVerified: true },
    );
    if ('redirectTo' in adminPageData) throw new Error('Unexpected redirect');
    const adminClientPayload = { ...adminPageData, shell: undefined };
    expect('effectiveMoneyOnAccountConfig' in adminPageData).toBe(false);
    expect(adminClientPayload.moneyOnAccountSummary?.maskedSortCode).toBe('**-**-56');
    expect(adminClientPayload.moneyOnAccountSummary?.maskedAccountNumber).toBe('******21');
    const adminSerialised = JSON.stringify(adminClientPayload);
    expect(adminSerialised).not.toContain('12-34-56');
    expect(adminSerialised).not.toContain('87654321');
    expect(adminSerialised).not.toContain('GB29NWBK60161331926819');

    const feMatterData = await runAsActionActor(
      'P-000002',
      () => loadMatterDetailPageData('P-000002', matter.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(feMatterData?.kind).toBe('profile');
    if (feMatterData && feMatterData.kind === 'profile') {
      const feClientPayload = { ...feMatterData, shell: undefined };
      expect('effectiveMoneyOnAccountConfig' in feMatterData).toBe(false);
      expect(feClientPayload.moneyOnAccountSummary?.maskedSortCode).toBe('**-**-56');
      expect(feClientPayload.moneyOnAccountRequests[0]?.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      expect(feClientPayload.moneyOnAccountRequests[0]?.bankDetailsSnapshot.accountNumber).toBe('******21');
      const feSerialised = JSON.stringify(feClientPayload);
      expect(feSerialised).not.toContain('12-34-56');
      expect(feSerialised).not.toContain('87654321');
      expect(feSerialised).not.toContain('GB29NWBK60161331926819');
    }

    // Enquiries Coordinator (P-000008 narrowed to pure enquiries_coordinator without fee_earner)
    // has no money_on_account:view and receives ZERO MOA config/requests/receipts.
    const enqPartyRepo = new TenantPartyRepository();
    const p8Before = await enqPartyRepo.getPersonById<Person>(ctx, 'P-000008');
    if (p8Before) {
      await enqPartyRepo.putPerson(ctx, { ...p8Before, roles: ['enquiries_coordinator'] });
    }
    try {
      const enqMatterData = await runAsActionActor(
        'P-000008',
        () => loadMatterDetailPageData('P-000008', matter.id),
        { roles: ['enquiries_coordinator'], mfaVerified: false },
      );
      expect(enqMatterData?.kind).toBe('profile');
      if (enqMatterData && enqMatterData.kind === 'profile') {
        const enqClientPayload = { ...enqMatterData, shell: undefined };
        expect(enqClientPayload.moneyOnAccountSummary).toBeNull();
        expect(enqClientPayload.moneyOnAccountBankConfigured).toBe(false);
        expect(enqClientPayload.moneyOnAccountAgreedPence).toBeNull();
        expect(enqClientPayload.moneyOnAccountRequests).toEqual([]);
        expect(enqClientPayload.moneyOnAccountReceipts).toEqual([]);
        const enqSerialised = JSON.stringify(enqClientPayload);
        expect(enqSerialised).not.toContain('12-34-56');
        expect(enqSerialised).not.toContain('87654321');
        expect(enqSerialised).not.toContain('GB29NWBK60161331926819');
      }
    } finally {
      if (p8Before) {
        await enqPartyRepo.putPerson(ctx, p8Before);
      }
    }
    const chase1Id = sent1.chase!.id;
    const sentAtDate = new Date(sent1.chase!.sentAt);

    // Day 7: Step 1 chase email
    const step1 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'P-000004',
      tenantConfig: { ...raw, tenantId: 'not-a-law-firm' } as never,
      now: addDays(sentAtDate, 7),
    });
    expect(step1.outcome).toBe('executed');

    // Day 14: Step 2 chase email
    const step2 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'P-000004',
      tenantConfig: { ...raw, tenantId: 'not-a-law-firm' } as never,
      now: addDays(sentAtDate, 14),
    });
    expect(step2.outcome).toBe('executed');

    // Day 21: Escalation task created for lead fee earner P-000002
    const step3 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'P-000004',
      tenantConfig: { ...raw, tenantId: 'not-a-law-firm' } as never,
      now: addDays(sentAtDate, 21),
    });
    expect(step3.outcome).toBe('executed');

    const outboxRepo = new TenantOutboxRepository();
    const stepEmails = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
      (r) =>
        r.idempotencyKey === `chase:${chase1Id}:step:1` ||
        r.idempotencyKey === `chase:${chase1Id}:step:2`,
    );
    expect(stepEmails).toHaveLength(2);
    expect(stepEmails[0]!.matterId).toBe(matter.id);
    expect(stepEmails[0]!.textBody).toContain('12-34-56');
    expect(stepEmails[0]!.textBody).toContain('£400.00');

    const linkedTasks = await new TenantTaskWorkflowRepository().listTasksLinkedToRecord<Task>(
      ctx,
      'matter',
      matter.id,
    );
    const escTask = linkedTasks.find((t) =>
      t.title.includes(sent1.request.paymentReference),
    );
    expect(escTask).toBeDefined();
    expect(escTask!.assignedPersonId).toBe('P-000002');
    expect(escTask!.autoTrigger).toBe('communication_chase_escalation');

    // R818 + Lesson 2: Send request #2 -> manually stop chase -> send request #3 -> chase runs under chase:<id>:step:1
    const sent2 = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 40_000,
          recipientEmail: 'chase-client@example.test',
          idempotencyKey: 'chase-req-2',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!sent2.ok) throw new Error(String(sent2.error));

    // R865: Risk & Compliance (has matter:edit, lacks money_on_account:request) gets opaque NOT_FOUND on stop & retry; Fee Earner succeeds
    const p3PartyRepo = new TenantPartyRepository();
    const p3Before = await p3PartyRepo.getPersonById<Person>(ctx, 'P-000003');
    if (p3Before) {
      await p3PartyRepo.putPerson(ctx, { ...p3Before, roles: ['risk_compliance'] });
    }
    try {
      const riskStopRes = await runAsActionActor(
        'P-000003',
        () => stopCommunicationChaseAction({ chaseId: sent2.chase!.id }),
        { roles: ['risk_compliance'], mfaVerified: false },
      );
      expect(riskStopRes).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      const riskRetryRes = await runAsActionActor(
        'P-000003',
        () => retryCommunicationChaseAction({ chaseId: sent2.chase!.id }),
        { roles: ['risk_compliance'], mfaVerified: false },
      );
      expect(riskRetryRes).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    } finally {
      if (p3Before) {
        await p3PartyRepo.putPerson(ctx, p3Before);
      }
    }

    const stopRes = await runAsActionActor(
      'P-000002',
      () => stopCommunicationChaseAction({ chaseId: sent2.chase!.id }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(stopRes.ok).toBe(true);

    const sent3 = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 40_000,
          recipientEmail: 'chase-client@example.test',
          idempotencyKey: 'chase-req-3',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!sent3.ok) throw new Error(String(sent3.error));
    const chase3Id = sent3.chase!.id;
    expect(chase3Id).not.toBe(chase1Id);

    await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'P-000004',
      tenantConfig: { ...raw, tenantId: 'not-a-law-firm' } as never,
      now: addDays(new Date(sent3.chase!.sentAt), 8),
    });
    const chase3Email = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).find(
      (r) => r.idempotencyKey === `chase:${chase3Id}:step:1`,
    );
    expect(chase3Email).toBeDefined();

    // Closing an active matter stops active money_on_account chase in same TX (Lesson 2)
    const closeMatterSave = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRecord(
          {
            title: 'S1-08 Close Stops Chase Active Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.employment_and_hr',
            workTypeSubcategoryId: 'work_type.employment_and_hr_employment_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(closeMatterSave.errors).toBeUndefined();
    expect(closeMatterSave.matter?.matterStatusId).toBe('matter_status.active');
    const closeMatterId = closeMatterSave.matter!.id;

    const sentClose = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: closeMatterId,
          requestedAmountPence: 40_000,
          recipientEmail: 'chase-close@example.test',
          idempotencyKey: 'chase-req-close',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!sentClose.ok) throw new Error(String(sentClose.error));
    const closeChaseId = sentClose.chase!.id;

    const closedRes = await runAsActionActor(
      'P-000001',
      () =>
        updateMatterLifecycleStatusRecord(
          closeMatterId,
          'close',
          { reason: 'Matter concluded by client' },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(closedRes.errors).toBeUndefined();
    expect(closedRes.matter).not.toBeNull();
    const chasingRepo = new TenantChasingRepository();
    const chaseCloseAfter = await chasingRepo.getChaseById(ctx, closeChaseId);
    expect(chaseCloseAfter?.status).toBe('stopped');
    expect(chaseCloseAfter?.stoppedReason).toBe('matter_closed');
    const chaseAudits = await auditEntriesForRecord('communication_chase', closeChaseId);
    expect(
      chaseAudits.some(
        (a) => a.field === 'Communication chase stopped' && a.oldValue === 'active',
      ),
    ).toBe(true);

    // R878: Every Money on Account action response masks bank details in serialised JSON
    // (1: saveConfig verified on mfaSave; 2: createAndSend + pre-TX replay; 3: recordReceipt + replay;
    //  4: reverseReceipt; 5: matchPms; 6: cancelRequest)
    const assertNoRawR878BankDetails = (payload: unknown) => {
      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain('12-34-56');
      expect(serialised).not.toContain('87654321');
      expect(serialised).not.toContain('GB29NWBK60161331926819');
    };
    assertNoRawR878BankDetails(sent1);
    expect(sent1.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
    expect(sent1.request.bankDetailsSnapshot.accountNumber).toBe('******21');
    expect(sent1.outboxRecord?.htmlBody).toBeNull();
    expect(sent1.outboxRecord?.textBody).toBeNull();

    const sent1Replay = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 40_000,
          recipientEmail: 'chase-client@example.test',
          idempotencyKey: 'chase-req-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sent1Replay.ok).toBe(true);
    if (sent1Replay.ok) {
      expect(sent1Replay.deduplicated).toBe(true);
      expect(sent1Replay.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      expect(sent1Replay.outboxRecord?.htmlBody).toBeNull();
      expect(sent1Replay.outboxRecord?.textBody).toBeNull();
    }
    assertNoRawR878BankDetails(sent1Replay);

    const r878Manual = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: sent2.request.id,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
          bankReference: 'R878-MAN-1',
          idempotencyKey: 'r878-manual-1',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r878Manual.ok).toBe(true);
    if (r878Manual.ok) {
      expect(r878Manual.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      expect(r878Manual.request.bankDetailsSnapshot.accountNumber).toBe('******21');
    }
    assertNoRawR878BankDetails(r878Manual);

    const r878ManualReplay = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: sent2.request.id,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
          bankReference: 'R878-MAN-1',
          idempotencyKey: 'r878-manual-1',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r878ManualReplay.ok).toBe(true);
    if (r878ManualReplay.ok) {
      expect(r878ManualReplay.deduplicated).toBe(true);
      expect(r878ManualReplay.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
    }
    assertNoRawR878BankDetails(r878ManualReplay);

    if (r878Manual.ok) {
      const r878Reverse = await runAsActionActor(
        'P-000009',
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: r878Manual.receipt.id,
            reason: 'R878 serialised reversal check',
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      expect(r878Reverse.ok).toBe(true);
      if (r878Reverse.ok) {
        expect(r878Reverse.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      }
      assertNoRawR878BankDetails(r878Reverse);
    }

    const r878PmsRepo = new TenantPmsRepository();
    await r878PmsRepo.importExtractDataset(
      ctx,
      buildMinimalPmsDataset('MAT-S108-R878', [
        {
          transaction_id: 'TX-R878-MATCH',
          date: '2026-11-27',
          type: 'Receipt',
          description: 'R878 client receipt',
          amount: 100,
          amount_pence: 10_000,
        },
      ]),
    );
    await r878PmsRepo.putPmsLink(ctx, {
      id: 'PMSL-MOA-R878',
      entityType: 'matter',
      onesquaredId: matter.id,
      pmsCode: 'MAT-S108-R878',
      matchedBy: 'manual',
      matchedAt: '2026-11-27T08:00:00.000Z',
    });
    const r878PmsMatch = await runAsActionActor(
      'P-000009',
      () =>
        matchPmsClientLedgerReceiptAction({
          requestId: sent3.request.id,
          pmsTransactionId: 'TX-R878-MATCH',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r878PmsMatch.ok).toBe(true);
    if (r878PmsMatch.ok) {
      expect(r878PmsMatch.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      expect(r878PmsMatch.request.bankDetailsSnapshot.accountNumber).toBe('******21');
    }
    assertNoRawR878BankDetails(r878PmsMatch);

    const r878Cancel = await runAsActionActor(
      'P-000002',
      () =>
        cancelMoneyOnAccountRequestAction({
          requestId: sent2.request.id,
          reason: 'R878 serialised cancel check',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r878Cancel.ok).toBe(true);
    if (r878Cancel.ok) {
      expect(r878Cancel.request.bankDetailsSnapshot.sortCode).toBe('**-**-56');
      expect(r878Cancel.request.bankDetailsSnapshot.accountNumber).toBe('******21');
    }
    assertNoRawR878BankDetails(r878Cancel);
  }, 45_000);

  it('4. Strict receipt RBAC (Q4), Lesson 7 moa_receipt evidence upload/download & stored-purpose validation, and uniform NOT_FOUND', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const { raw } = makeMoaTestConfig();
    setActiveTenantConfigForTesting(raw, {});

    await ensureOrgValidCdd('O-000001', 'P-000001');
    const matter = await createConveyancingProspectiveMatter({
      title: 'S1-08 Receipt RBAC & Evidence Matter',
      retainerMoniesOnAccountPence: 50_000,
    });

    const reqRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 50_000,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: 'rbac-req-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!reqRes.ok) throw new Error(String(reqRes.error));
    const reqId = reqRes.request.id;

    // Narrow P-000004 (demo multi-role admin) and P-000003 (risk_compliance + partner) in test DB
    // so Test 4 tests pure single-role admin and risk_compliance accounts cleanly.
    const adminCtx = testTenantCtx('P-000004');
    const partyRepo = new TenantPartyRepository();
    await partyRepo.withTenantTransaction(adminCtx, async () => {
      const pAdmin = await partyRepo.getPersonById<Person>(adminCtx, 'P-000004');
      if (pAdmin) {
        await partyRepo.putPerson(adminCtx, {
          ...pAdmin,
          roles: ['admin'],
        });
      }
      const pCompliance = await partyRepo.getPersonById<Person>(adminCtx, 'P-000003');
      if (pCompliance) {
        await partyRepo.putPerson(adminCtx, {
          ...pCompliance,
          roles: ['risk_compliance'],
        });
      }
    });

    // Fee earner, legal secretary, admin, risk_compliance are ALL forbidden from recording/matching receipts
    for (const deniedCase of [
      { id: 'P-000002', roles: ['fee_earner'] },
      { id: 'P-000010', roles: ['legal_secretary'] },
      { id: 'P-000004', roles: ['admin'] },
      { id: 'P-000003', roles: ['risk_compliance'] },
    ]) {
      const deniedManual = await runAsActionActor(
        deniedCase.id,
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: reqId,
            amountPence: 50_000,
            receivedDate: '2026-11-27',
          }),
        { roles: deniedCase.roles, mfaVerified: true },
      );
      expect(isActionDenied(deniedManual)).toBe(true);

      const deniedMatch = await runAsActionActor(
        deniedCase.id,
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: reqId,
            pmsTransactionId: 'CA-ANY',
          }),
        { roles: deniedCase.roles, mfaVerified: true },
      );
      expect(isActionDenied(deniedMatch)).toBe(true);

      // Lesson 7: HTTP POST /api/evidence/upload purpose='moa_receipt' requires money_on_account:record_receipt
      const form = new FormData();
      form.append('subjectType', 'matter');
      form.append('subjectId', matter.id);
      form.append('purpose', 'moa_receipt');
      form.append(
        'file',
        new File([Buffer.from('%PDF-1.4\n% Remittance\n%%EOF\n')], 'remittance.pdf', {
          type: 'application/pdf',
        }),
      );
      const httpDeniedUp = await runAsActionActor(
        deniedCase.id,
        () =>
          evidenceUploadRoute.POST(
            new Request('http://localhost/api/evidence/upload', {
              method: 'POST',
              headers: { 'content-length': '2048' },
              body: form,
            }),
          ),
        { roles: deniedCase.roles, mfaVerified: true },
      );
      expect(httpDeniedUp.status).toBe(403);
    }

    // Finance (P-000009) succeeds uploading purpose='moa_receipt'
    const finForm = new FormData();
    finForm.append('subjectType', 'matter');
    finForm.append('subjectId', matter.id);
    finForm.append('purpose', 'moa_receipt');
    finForm.append(
      'file',
      new File([Buffer.from('%PDF-1.4\n% Finance Remittance\n%%EOF\n')], 'bank-advice.pdf', {
        type: 'application/pdf',
      }),
    );
    const finUpRes = await runAsActionActor(
      'P-000009',
      () =>
        evidenceUploadRoute.POST(
          new Request('http://localhost/api/evidence/upload', {
            method: 'POST',
            headers: { 'content-length': '2048' },
            body: finForm,
          }),
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finUpRes.status).toBe(200);
    const finUpBody = (await finUpRes.json()) as {
      ok: boolean;
      artifact: { id: string; purpose: string };
      downloadUrl: string;
    };
    expect(finUpBody.ok).toBe(true);
    expect(finUpBody.artifact.purpose).toBe('moa_receipt');

    // Finance and accessible Fee Earner (with money_on_account:view) can download 'moa_receipt'
    const finDl = await runAsActionActor(
      'P-000009',
      () =>
        evidenceDownloadRoute.GET(
          new Request(`http://localhost${finUpBody.downloadUrl}`, { method: 'GET' }),
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finDl.status).toBe(200);

    // Outsider without matter access gets uniform 404 NOT_FOUND on download
    const outsiderTokenUrl = finUpBody.downloadUrl;
    const outsiderDl = await runAsActionActor(
      'P-000006',
      () =>
        evidenceDownloadRoute.GET(
          new Request(`http://localhost${outsiderTokenUrl}`, { method: 'GET' }),
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderDl.status).toBe(404);

    // Stored purpose validation (R817): 'engagement_signed' and 'cdd' artifacts are rejected by recordMoneyOnAccountReceiptAction
    const engUpload = await runAsActionActor(
      'P-000002',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'matter',
            subjectId: matter.id,
            purpose: 'engagement_signed',
            fileName: 'signed.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% Signed\n%%EOF\n'),
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!engUpload.ok) throw new Error(engUpload.message);

    const wrongPurposeRes = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqId,
          amountPence: 20_000,
          receivedDate: '2026-11-27',
          evidenceArtifactId: engUpload.artifact.id,
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(wrongPurposeRes.ok).toBe(false);
    if (!wrongPurposeRes.ok && !isActionDenied(wrongPurposeRes)) {
      expect(wrongPurposeRes.code).toBe('NOT_FOUND');
    }

    // R857 & R868: stored 'cdd' artifact on the same accessible matter is also refused with opaque NOT_FOUND
    const cddUpload = await runAsActionActor(
      'P-000001',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'matter',
            subjectId: matter.id,
            purpose: 'cdd',
            fileName: 'passport-check.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% CDD Passport\n%%EOF\n'),
          },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    if (!cddUpload.ok) throw new Error(cddUpload.message);
    const cddPurposeRes = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqId,
          amountPence: 20_000,
          receivedDate: '2026-11-27',
          evidenceArtifactId: cddUpload.artifact.id,
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(cddPurposeRes).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    // Invalid calendar date rejected cleanly (Lesson 4)
    const badDateRes = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqId,
          amountPence: 20_000,
          receivedDate: '2026-02-30',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(badDateRes.ok).toBe(false);

    // Finance records part-receipt with 'moa_receipt' evidence -> status becomes 'part_received'
    const okPartRes = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqId,
          amountPence: 20_000,
          receivedDate: '2026-11-27',
          bankReference: 'FPS-BANK-01',
          evidenceArtifactId: finUpBody.artifact.id,
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(okPartRes.ok).toBe(true);
    if (okPartRes.ok) {
      expect(okPartRes.request.status).toBe('part_received');
      expect(okPartRes.receipt.evidenceArtifactId).toBe(finUpBody.artifact.id);
      expect(okPartRes.stoppedChase).toBeNull();
    }

    // Cancel fails while unreversed receipt exists (Lesson 4), then succeeds after reversal
    const blockedCancel = await runAsActionActor(
      'P-000002',
      () =>
        cancelMoneyOnAccountRequestAction({
          requestId: reqId,
          reason: 'Should fail while unreversed receipt exists',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(blockedCancel.ok).toBe(false);

    // Fee earner cannot reverse; R873 enforces 5-char min on server; Finance reverses cleanly
    const feeReverse = await runAsActionActor(
      'P-000002',
      () =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: okPartRes.ok ? okPartRes.receipt.id : '',
          reason: 'Unauthorized reverse',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(feeReverse)).toBe(true);

    for (const shortReason of ['x', 'abcd']) {
      const shortRev = await runAsActionActor(
        'P-000009',
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: okPartRes.ok ? okPartRes.receipt.id : '',
            reason: shortReason,
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      expect(shortRev).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    }

    const finReverse = await runAsActionActor(
      'P-000009',
      () =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: okPartRes.ok ? okPartRes.receipt.id : '',
          reason: 'Matched against wrong client transfer',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finReverse.ok).toBe(true);
    if (finReverse.ok) {
      expect(finReverse.receipt.reversedAt).toBeTruthy();
      expect(finReverse.request.status).toBe('requested');
    }

    const cancelledAfterRev = await runAsActionActor(
      'P-000002',
      () =>
        cancelMoneyOnAccountRequestAction({
          requestId: reqId,
          reason: 'Re-issuing corrected payment request',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(cancelledAfterRev.ok).toBe(true);
    if (cancelledAfterRev.ok) {
      expect(cancelledAfterRev.request.status).toBe('cancelled');
      expect(cancelledAfterRev.stoppedChase?.status).toBe('stopped');
      expect(cancelledAfterRev.stoppedChase?.stoppedReason).toBe('cancelled');
    }

    // R872: Deleting a matter that has client money requests fails cleanly (never raw 23503), leaving records intact
    const matterRepo = new TenantMatterRepository();
    const moaRepo = new TenantMoneyOnAccountRepository();
    await expect(matterRepo.deleteMatterById(adminCtx, matter.id)).rejects.toMatchObject({
      code: 'MATTER_HAS_CLIENT_MONEY_RECORDS',
      message: 'This matter has client money records and cannot be deleted.',
    });
    expect(await matterRepo.getMatterById<Matter>(adminCtx, matter.id)).not.toBeNull();
    expect(await moaRepo.getRequestById(adminCtx, reqId)).not.toBeNull();

    // R874: Idempotent manual receipt recording & orphan proof cleanup on failure
    const reqIdempRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 30_000,
          recipientEmail: 'accounts@oakridge.test',
          idempotencyKey: 'rbac-req-idemp-test',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!reqIdempRes.ok) throw new Error(String(reqIdempRes.error));
    const reqIdempId = reqIdempRes.request.id;

    // Upload a proof file for a receipt call that fails date validation -> blob + artifact row must be cleaned up
    const finCtx = testTenantCtx('P-000009');
    const orphanUpload = await runAsActionActor(
      'P-000009',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'matter',
            subjectId: matter.id,
            purpose: 'moa_receipt',
            fileName: 'orphan-proof.pdf',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4\n% Orphan proof\n%%EOF\n'),
          },
          'P-000009',
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!orphanUpload.ok) throw new Error(orphanUpload.message);
    const failedWithProof = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 10_000,
          receivedDate: '2026-02-31',
          evidenceArtifactId: orphanUpload.artifact.id,
          idempotencyKey: 'rcpt-fail-clean',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(failedWithProof).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(
      await new TenantEvidenceArtifactRepository().getArtifactById(finCtx, orphanUpload.artifact.id),
    ).toBeNull();
    const validatedCfg = loadAndValidateTenantConfig(
      raw,
      { tenantId: 'not-a-law-firm', environment: 'test' },
      'test',
      'multi_tenant',
    );
    await expect(
      getDocumentStorage(validatedCfg).getObjectBytes(finCtx, {
        blobKey: orphanUpload.artifact.blobKey,
      }),
    ).rejects.toThrow();

    // Double submit with SAME idempotencyKey records ONCE; distinct key records second part-payment
    const r1 = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
          bankReference: 'IDEM-1',
          idempotencyKey: 'rcpt-idem-k1',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r1.ok).toBe(true);
    const r1Replay = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
          bankReference: 'IDEM-1',
          idempotencyKey: 'rcpt-idem-k1',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r1Replay.ok).toBe(true);
    if (r1.ok && r1Replay.ok) {
      expect(r1.deduplicated).toBe(false);
      expect(r1Replay.deduplicated).toBe(true);
      expect(r1Replay.receipt.id).toBe(r1.receipt.id);
    }

    const r2 = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
          bankReference: 'IDEM-2',
          idempotencyKey: 'rcpt-idem-k2',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.deduplicated).toBe(false);
      expect(r2.receipt.id).not.toBe(r1.receipt.id);
    }
    const receiptsOnIdemp = (await moaRepo.listReceiptsForMatter(finCtx, matter.id)).filter(
      (r) => r.requestId === reqIdempId,
    );
    expect(receiptsOnIdemp).toHaveLength(2);

    // R873: exact 5-character reversal reason succeeds
    if (r2.ok) {
      const fiveCharRev = await runAsActionActor(
        'P-000009',
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: r2.receipt.id,
            reason: 'Error',
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      expect(fiveCharRev.ok).toBe(true);
    }

    // R872: Deleting a matter with receipts also fails cleanly and preserves receipts & matter
    await expect(matterRepo.deleteMatterById(adminCtx, matter.id)).rejects.toMatchObject({
      code: 'MATTER_HAS_CLIENT_MONEY_RECORDS',
      message: 'This matter has client money records and cannot be deleted.',
    });
    expect(await matterRepo.getMatterById<Matter>(adminCtx, matter.id)).not.toBeNull();
    expect(await moaRepo.listReceiptsForMatter(finCtx, matter.id)).toHaveLength(3);

    // R880 (a): Concurrent same-key receipt recording (Promise.all, real PG, runAsTestActor):
    // exactly one receipt is persisted, both calls return it, winning proof survives (row + blob),
    // and losing duplicate proof is cleaned up (row + blob) only AFTER transactional reference check.
    const evRepoR880 = new TenantEvidenceArtifactRepository();
    const storageR880 = getDocumentStorage(validatedCfg);
    const uploadConcProof = async (fileName: string, bodyMarker: string) => {
      const up = await runAsActionActor(
        'P-000009',
        () =>
          uploadEvidenceArtifactRecord(
            {
              subjectType: 'matter',
              subjectId: matter.id,
              purpose: 'moa_receipt',
              fileName,
              contentType: 'application/pdf',
              bytes: Buffer.from(`%PDF-1.4\n% ${bodyMarker}\n%%EOF\n`),
            },
            'P-000009',
          ),
        { roles: ['finance'], mfaVerified: false },
      );
      if (!up.ok) throw new Error(up.message);
      return up.artifact;
    };

    const concProofA = await uploadConcProof('conc-proof-a.pdf', 'Conc Proof A');
    const concProofB = await uploadConcProof('conc-proof-b.pdf', 'Conc Proof B');
    const concKey = 'rcpt-conc-same-key';
    const [concResA, concResB] = await Promise.all([
      runAsTestActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptRecord(
            {
              requestId: reqIdempId,
              amountPence: 5_000,
              receivedDate: '2026-11-27',
              bankReference: 'CONC-SAME-1',
              evidenceArtifactId: concProofA.id,
              idempotencyKey: concKey,
            },
            'P-000009',
            {
              tenantCtx: testTenantCtx('P-000009', {
                roles: ['finance'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsTestActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptRecord(
            {
              requestId: reqIdempId,
              amountPence: 5_000,
              receivedDate: '2026-11-27',
              bankReference: 'CONC-SAME-1',
              evidenceArtifactId: concProofB.id,
              idempotencyKey: concKey,
            },
            'P-000009',
            {
              tenantCtx: testTenantCtx('P-000009', {
                roles: ['finance'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
    ]);
    expect(concResA.ok).toBe(true);
    expect(concResB.ok).toBe(true);
    if (!concResA.ok || !concResB.ok) throw new Error('Expected both concurrent calls to succeed');
    expect(concResA.receipt.id).toBe(concResB.receipt.id);
    expect([concResA.deduplicated, concResB.deduplicated].sort()).toEqual([false, true]);
    expect(concResA.request.bankDetailsSnapshot.sortCode).toBe('**-**-00');
    expect(concResB.request.bankDetailsSnapshot.sortCode).toBe('**-**-00');

    const receiptsForConcKey = (await moaRepo.listReceiptsForMatter(finCtx, matter.id)).filter(
      (r) => r.idempotencyKey === concKey,
    );
    expect(receiptsForConcKey).toHaveLength(1);

    const winningArtifact =
      concResA.receipt.evidenceArtifactId === concProofA.id ? concProofA : concProofB;
    const losingArtifact =
      winningArtifact.id === concProofA.id ? concProofB : concProofA;
    expect(await evRepoR880.getArtifactById(finCtx, winningArtifact.id)).not.toBeNull();
    const winningBytes = await storageR880.getObjectBytes(finCtx, {
      blobKey: winningArtifact.blobKey,
    });
    expect(winningBytes.byteLength).toBeGreaterThan(0);
    expect(await evRepoR880.getArtifactById(finCtx, losingArtifact.id)).toBeNull();
    await expect(
      storageR880.getObjectBytes(finCtx, { blobKey: losingArtifact.blobKey }),
    ).rejects.toThrow();

    // R880 (b): Cleanup on duplicate or failed validation MUST NOT delete a proof file referenced by
    // an existing receipt (isEvidenceArtifactReferencedInReceiptsInTx + FOR UPDATE row lock).
    const replaySameProof = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 5_000,
          receivedDate: '2026-11-27',
          bankReference: 'CONC-SAME-1',
          evidenceArtifactId: winningArtifact.id,
          idempotencyKey: concKey,
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(replaySameProof.ok).toBe(true);
    if (replaySameProof.ok) {
      expect(replaySameProof.deduplicated).toBe(true);
      expect(replaySameProof.receipt.id).toBe(concResA.receipt.id);
    }
    const failedWithReferencedProof = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 5_000,
          receivedDate: '2026-02-31',
          evidenceArtifactId: winningArtifact.id,
          idempotencyKey: 'rcpt-fail-must-keep-ref-proof',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(failedWithReferencedProof).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await evRepoR880.getArtifactById(finCtx, winningArtifact.id)).not.toBeNull();
    expect(
      (await storageR880.getObjectBytes(finCtx, { blobKey: winningArtifact.blobKey })).byteLength,
    ).toBeGreaterThan(0);

    // R880 (c): Real PostgreSQL SQLSTATE 23505 (uq_moa_receipts_idempotency_key -> MOA_RECEIPT_IDEMPOTENCY_CONFLICT)
    // recovery returns existing receipt, cleans up unused duplicate proof, and preserves winning proof.
    const pg23505WinningProof = await uploadConcProof(
      'pg23505-win-proof.pdf',
      'PG 23505 Winning Proof',
    );
    const pg23505DupProof = await uploadConcProof(
      'pg23505-dup-proof.pdf',
      'PG 23505 Duplicate Proof',
    );
    const pg23505Key = 'rcpt-pg23505-key';
    const first23505Res = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqIdempId,
          amountPence: 5_000,
          receivedDate: '2026-11-27',
          bankReference: 'PG23505-1',
          evidenceArtifactId: pg23505WinningProof.id,
          idempotencyKey: pg23505Key,
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(first23505Res.ok).toBe(true);
    if (!first23505Res.ok) throw new Error('Expected initial 23505 fixture receipt to commit');

    const findPreSpy = vi
      .spyOn(TenantMoneyOnAccountRepository.prototype, 'findReceiptByIdempotencyKey')
      .mockResolvedValueOnce(null);
    const findInTxSpy = vi
      .spyOn(TenantMoneyOnAccountRepository.prototype, 'findReceiptByIdempotencyKeyInTx')
      .mockResolvedValueOnce(null);
    let second23505Res: Awaited<ReturnType<typeof recordMoneyOnAccountReceiptAction>>;
    try {
      second23505Res = await runAsActionActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: reqIdempId,
            amountPence: 5_000,
            receivedDate: '2026-11-27',
            bankReference: 'PG23505-1',
            evidenceArtifactId: pg23505DupProof.id,
            idempotencyKey: pg23505Key,
          }),
        { roles: ['finance'], mfaVerified: false },
      );
    } finally {
      findPreSpy.mockRestore();
      findInTxSpy.mockRestore();
    }
    expect(second23505Res.ok).toBe(true);
    if (second23505Res.ok) {
      expect(second23505Res.deduplicated).toBe(true);
      expect(second23505Res.receipt.id).toBe(first23505Res.receipt.id);
      expect(second23505Res.request.bankDetailsSnapshot.sortCode).toBe('**-**-00');
    }
    expect(await evRepoR880.getArtifactById(finCtx, pg23505WinningProof.id)).not.toBeNull();
    expect(
      (await storageR880.getObjectBytes(finCtx, { blobKey: pg23505WinningProof.blobKey }))
        .byteLength,
    ).toBeGreaterThan(0);
    expect(await evRepoR880.getArtifactById(finCtx, pg23505DupProof.id)).toBeNull();
    await expect(
      storageR880.getObjectBytes(finCtx, { blobKey: pg23505DupProof.blobKey }),
    ).rejects.toThrow();
  }, 60_000);

  it('5. PMS client ledger matching rejects negative outflows, enforces uq_moa_receipts_tenant_pms_tx on Promise.all race, stops chase on received, and allows rematch after reversal', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000009');
    const { raw } = makeMoaTestConfig();
    setActiveTenantConfigForTesting(raw, {});

    const matter = await createConveyancingProspectiveMatter({
      title: 'S1-08 PMS Match Matter',
      retainerMoniesOnAccountPence: 50_000,
    });
    const pmsRepo = new TenantPmsRepository();
    await pmsRepo.importExtractDataset(
      ctx,
      buildMinimalPmsDataset('MAT-S108-MATCH', [
        {
          transaction_id: 'TX-POS-PART-300',
          date: '2026-11-26',
          type: 'Receipt',
          description: 'Initial deposit receipt',
          amount: 300,
          amount_pence: 30_000,
        },
        {
          transaction_id: 'TX-POS-BAL-200',
          date: '2026-11-27',
          type: 'Receipt',
          description: 'Balance receipt',
          amount: 200,
          amount_pence: 20_000,
        },
        {
          transaction_id: 'TX-NEG-PAY',
          date: '2026-11-27',
          type: 'Payment',
          description: 'Land Registry disbursement',
          amount: -356.4,
          amount_pence: -35_640,
        },
        {
          transaction_id: 'TX-NEG-XFER',
          date: '2026-11-27',
          type: 'Transfer to office',
          description: 'Bill transfer',
          amount: -100.5,
          amount_pence: -10_050,
        },
        {
          transaction_id: 'TX-ZERO-PENCE',
          date: '2026-11-27',
          type: 'Receipt',
          description: 'Receipt with zero integer pence despite float amount',
          amount: 150,
          amount_pence: 0,
        },
      ]),
    );
    await pmsRepo.putPmsLink(ctx, {
      id: 'PMSL-MOA-1',
      entityType: 'matter',
      onesquaredId: matter.id,
      pmsCode: 'MAT-S108-MATCH',
      matchedBy: 'manual',
      matchedAt: '2026-11-27T08:00:00.000Z',
    });

    const sendRes = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: matter.id,
          requestedAmountPence: 50_000,
          idempotencyKey: 'pms-req-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!sendRes.ok) throw new Error(String(sendRes.error));
    const reqId = sendRes.request.id;

    // R876 item 2: Missing/non-positive amount_pence fails closed with VALIDATION_ERROR (never float Math.round(amount * 100))
    const zeroPenceMatch = await runAsActionActor(
      'P-000009',
      () =>
        matchPmsClientLedgerReceiptAction({
          requestId: reqId,
          pmsTransactionId: 'TX-ZERO-PENCE',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(zeroPenceMatch).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    const realPmsRow = await pmsRepo.withTenantReadTransaction(ctx, (tx) =>
      pmsRepo.getClientLedgerEntryByTransactionIdInTx(tx, ctx, 'TX-POS-PART-300'),
    );
    expect(realPmsRow).not.toBeNull();
    const pmsSpy = vi
      .spyOn(TenantPmsRepository.prototype, 'getClientLedgerEntryByTransactionIdInTx')
      .mockResolvedValueOnce({
        ...realPmsRow!,
        amount: 300,
        amount_pence: undefined as unknown as MinorUnits,
      });
    try {
      const undefinedPenceMatch = await runAsActionActor(
        'P-000009',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: reqId,
            pmsTransactionId: 'TX-POS-PART-300',
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      expect(undefinedPenceMatch).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    } finally {
      pmsSpy.mockRestore();
    }

    // Negative Payment & Transfer to office rejected cleanly
    for (const negId of ['TX-NEG-PAY', 'TX-NEG-XFER']) {
      const negRes = await runAsActionActor(
        'P-000009',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: reqId,
            pmsTransactionId: negId,
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      expect(negRes.ok).toBe(false);
      if (!negRes.ok && !isActionDenied(negRes)) {
        expect(negRes.code).toBe('VALIDATION_ERROR');
      }
    }

    // Promise.all race against same TX-POS-PART-300 -> exactly 1 succeeds, 1 hits uq_moa_receipts_tenant_pms_tx
    const raceResults = await Promise.all([
      runAsTestActor(
        'P-000009',
        () =>
          matchPmsClientLedgerReceiptRecord(
            {
              requestId: reqId,
              pmsTransactionId: 'TX-POS-PART-300',
            },
            'P-000009',
            {
              tenantCtx: testTenantCtx('P-000009', {
                roles: ['finance'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsTestActor(
        'P-000001',
        () =>
          matchPmsClientLedgerReceiptRecord(
            {
              requestId: reqId,
              pmsTransactionId: 'TX-POS-PART-300',
            },
            'P-000001',
            {
              tenantCtx: testTenantCtx('P-000001', {
                roles: ['partner'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['partner'], mfaVerified: false },
      ),
    ]);
    const successes = raceResults.filter((r) => r.ok);
    const failures = raceResults.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failObj = failures[0]!;
    expect(failObj.ok).toBe(false);
    expect(isActionDenied(failObj)).toBe(false);
    expect((failObj as { code?: string }).code).toBe('MOA_PMS_RECEIPT_ALREADY_MATCHED');

    // Second positive Receipt completes request -> 'received' + stops chase immediately in same TX
    const completeMatch = await runAsActionActor(
      'P-000009',
      () =>
        matchPmsClientLedgerReceiptAction({
          requestId: reqId,
          pmsTransactionId: 'TX-POS-BAL-200',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(completeMatch.ok).toBe(true);
    if (completeMatch.ok) {
      expect(completeMatch.request.status).toBe('received');
      expect(completeMatch.stoppedChase?.status).toBe('stopped');
      expect(completeMatch.stoppedChase?.stoppedReason).toBe('received');
    }

    // Matching another receipt to an already-'received' request fails (Lesson 4)
    const closedReqMatch = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqId,
          amountPence: 1000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(closedReqMatch.ok).toBe(false);

    // Reversal frees TX-POS-BAL-200 so a new request (or rematch) can match it cleanly
    const revRes = await runAsActionActor(
      'P-000009',
      () =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: completeMatch.ok ? completeMatch.receipt.id : '',
          reason: 'Allocated to wrong matter request; re-matching cleanly.',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(revRes.ok).toBe(true);
    if (revRes.ok) {
      expect(revRes.request.status).toBe('part_received');
    }

    const rematchRes = await runAsActionActor(
      'P-000009',
      () =>
        matchPmsClientLedgerReceiptAction({
          requestId: reqId,
          pmsTransactionId: 'TX-POS-BAL-200',
          notes: 'Legitimate rematch after error correction',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(rematchRes.ok).toBe(true);
  }, 45_000);

  it('6. R822 / Q8 canonical gate rule: table-driven 6+ cases across all 5 opening paths, reversal vs open race, sibling chase isolation & reversal after opening', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const { raw } = makeMoaTestConfig();
    setActiveTenantConfigForTesting(raw, {});
    const ctxFee = testTenantCtx('P-000002');
    const auditRepo = new TenantAuditRepository();
    const matterRepo = new TenantMatterRepository();
    const regRepo = new TenantRegisterRepository();
    const chasingRepo = new TenantChasingRepository();

    // Upgrade O-000001 CDD to High-risk completed once up front so both Low-risk and High-risk gate paths never fail on CDD
    await runAsActionActor(
      'P-000001',
      async () => {
        const o1Upgraded = await startOrLoadClientCddRecord(
          {
            subjectType: 'organisation',
            subjectId: 'O-000001',
            upgradeToHighRisk: true,
            reason: 'High-risk jurisdictional matter requires High-tier CDD',
          },
          'P-000001',
        );
        expect(o1Upgraded.ok).toBe(true);
        if (o1Upgraded.ok && o1Upgraded.summary.record) {
          for (const item of o1Upgraded.summary.checklistItems) {
            if (item.status !== 'recorded') {
              const recRes = await recordCddChecklistItemRecord(
                {
                  recordId: o1Upgraded.summary.record.id,
                  itemKey: item.itemKey,
                  status: 'recorded',
                  note: 'Verified High-risk CDD item for S1-08 matrix',
                },
                'P-000001',
              );
              expect(recRes.ok).toBe(true);
            }
          }
          const compRes = await completeClientCddRecord(
            { recordId: o1Upgraded.summary.record.id },
            'P-000001',
          );
          expect(compRes.ok).toBe(true);
        }
      },
      { roles: ['partner'], mfaVerified: false },
    );

    // Pure unit verification of Case 4(b) & Case 5(a)
    expect(
      evaluateMatterFundsOnAccountGate({
        requests: [{ id: 'R1', status: 'received', requestedAmountPence: 20_000 }],
        receipts: [{ requestId: 'R1', amountPence: 20_000, reversedAt: null }],
        agreedAmountPence: null,
      }).fundsOnAccountSatisfied,
    ).toBe(true);
    expect(
      evaluateMatterFundsOnAccountGate({
        requests: [{ id: 'R1', status: 'cancelled', requestedAmountPence: 50_000 }],
        receipts: [],
        agreedAmountPence: 50_000,
      }).fundsOnAccountSatisfied,
    ).toBe(false);

    // R870: Table-driven matrix of all 6 gate cases (Cases 1, 2, 3, 4a, 4b, 5a, 5b, 6) across all 5 real opening paths
    type GateOpeningPath =
      | 'open_prospective_matter'
      | 'save_matter'
      | 'conflict_approve'
      | 'costs_sign_off'
      | 'high_risk_compliance_approve';
    type GateCaseKey =
      | 'case1_no_request'
      | 'case2_part_received'
      | 'case3_paid_below_agreed'
      | 'case4a_paid_to_agreed'
      | 'case4b_no_agreed_single_paid'
      | 'case5a_cancelled_only'
      | 'case5b_cancelled_plus_paid'
      | 'case6_reversed_before_open';

    const GATE_PATHS: readonly GateOpeningPath[] = [
      'open_prospective_matter',
      'save_matter',
      'conflict_approve',
      'costs_sign_off',
      'high_risk_compliance_approve',
    ];
    const GATE_CASES: ReadonlyArray<{
      readonly key: GateCaseKey;
      readonly agreedPence: number | null;
      readonly expectedAllowed: boolean;
    }> = [
      { key: 'case1_no_request', agreedPence: 50_000, expectedAllowed: false },
      { key: 'case2_part_received', agreedPence: 50_000, expectedAllowed: false },
      { key: 'case3_paid_below_agreed', agreedPence: 50_000, expectedAllowed: false },
      { key: 'case4a_paid_to_agreed', agreedPence: 50_000, expectedAllowed: true },
      { key: 'case4b_no_agreed_single_paid', agreedPence: null, expectedAllowed: true },
      { key: 'case5a_cancelled_only', agreedPence: 50_000, expectedAllowed: false },
      { key: 'case5b_cancelled_plus_paid', agreedPence: 50_000, expectedAllowed: true },
      { key: 'case6_reversed_before_open', agreedPence: 50_000, expectedAllowed: false },
    ];

    let cellSeq = 0;
    for (const pathKind of GATE_PATHS) {
      for (const gateCase of GATE_CASES) {
        cellSeq += 1;
        const isConflictPath = pathKind === 'conflict_approve';
        const isHroPath = pathKind === 'high_risk_compliance_approve';
        const created = await createConveyancingProspectiveMatter({
          title: `Gate ${pathKind} ${gateCase.key} #${cellSeq}`,
          retainerMoniesOnAccountPence: gateCase.agreedPence,
          feeEstimateGbp: 1200,
          conflictStatus: isConflictPath ? 'Referred' : 'Cleared',
          saveMode: isConflictPath ? 'submit_referred' : 'submit_cleared',
          signedEngagement: true,
          ...(isHroPath
            ? {
                riskAnswers: HIGH_RISK_ANSWERS,
                riskFollowUps: HIGH_RISK_FOLLOW_UPS,
                responsiblePartnerId: 'P-000005',
                leadFeeEarnerId: 'P-000002',
              }
            : {}),
        });

        let hroIdForCell: string | null = null;
        if (isHroPath) {
          const hroList = await regRepo.listVisibleRegisterRecords(
            testTenantCtx('P-000004'),
            'P-000004',
            {
              includeRestricted: true,
              registerTypeKey: 'high_risk_opening',
              matterId: created.id,
            },
          );
          hroIdForCell = hroList[0]!.id;
          const pAppr = await runAsActionActor(
            'P-000001',
            () =>
              transitionRegisterRecordService(
                { recordId: hroIdForCell!, transitionKey: 'partner_approve', comment: 'Partner stage approved' },
                'P-000001',
              ),
            { roles: ['partner'], mfaVerified: false },
          );
          expect(pAppr.ok).toBe(true);
        }

        const sendCellReq = async (amt: number, tag: string) => {
          const r = await runAsActionActor(
            'P-000002',
            () =>
              createAndSendMoneyOnAccountRequestAction({
                matterId: created.id,
                requestedAmountPence: amt,
                idempotencyKey: `cell-${cellSeq}-${tag}`,
              }),
            { roles: ['fee_earner'], mfaVerified: false },
          );
          if (!r.ok) throw new Error(String(r.error));
          return r.request.id;
        };
        const payCellReq = async (reqId: string, amt: number, tag: string) => {
          const rc = await runAsActionActor(
            'P-000009',
            () =>
              recordMoneyOnAccountReceiptAction({
                requestId: reqId,
                amountPence: amt,
                receivedDate: '2026-11-27',
                idempotencyKey: `rcpt-${cellSeq}-${tag}`,
              }),
            { roles: ['finance'], mfaVerified: false },
          );
          if (!rc.ok) throw new Error(String(rc.error));
          return rc.receipt.id;
        };

        switch (gateCase.key) {
          case 'case1_no_request':
            break;
          case 'case2_part_received': {
            const rq = await sendCellReq(50_000, 'c2');
            await payCellReq(rq, 25_000, 'c2p');
            break;
          }
          case 'case3_paid_below_agreed': {
            const rq = await sendCellReq(10_000, 'c3');
            await payCellReq(rq, 10_000, 'c3p');
            break;
          }
          case 'case4a_paid_to_agreed': {
            const rq1 = await sendCellReq(10_000, 'c4a1');
            await payCellReq(rq1, 10_000, 'c4a1p');
            const rq2 = await sendCellReq(40_000, 'c4a2');
            await payCellReq(rq2, 40_000, 'c4a2p');
            break;
          }
          case 'case4b_no_agreed_single_paid': {
            const rq = await sendCellReq(20_000, 'c4b');
            await payCellReq(rq, 20_000, 'c4bp');
            break;
          }
          case 'case5a_cancelled_only': {
            const rq = await sendCellReq(50_000, 'c5a');
            await runAsActionActor(
              'P-000002',
              () => cancelMoneyOnAccountRequestAction({ requestId: rq, reason: 'Cancelled request only' }),
              { roles: ['fee_earner'], mfaVerified: false },
            );
            break;
          }
          case 'case5b_cancelled_plus_paid': {
            const rqCan = await sendCellReq(50_000, 'c5b-can');
            await runAsActionActor(
              'P-000002',
              () => cancelMoneyOnAccountRequestAction({ requestId: rqCan, reason: 'Superseded request' }),
              { roles: ['fee_earner'], mfaVerified: false },
            );
            const rqOk = await sendCellReq(50_000, 'c5b-ok');
            await payCellReq(rqOk, 50_000, 'c5b-okp');
            break;
          }
          case 'case6_reversed_before_open': {
            const rq = await sendCellReq(50_000, 'c6');
            const rcId = await payCellReq(rq, 50_000, 'c6p');
            const rev = await runAsActionActor(
              'P-000009',
              () => reverseMoneyOnAccountReceiptAction({ receiptId: rcId, reason: 'Bounced before opening' }),
              { roles: ['finance'], mfaVerified: false },
            );
            expect(rev.ok).toBe(true);
            break;
          }
        }

        if (!gateCase.expectedAllowed) {
          const preState = await runAsActionActor(
            'P-000002',
            () => getMatterOpeningGateStateRecord(created.id, 'P-000002'),
            { roles: ['fee_earner'], mfaVerified: false },
          );
          expect(preState.ok).toBe(true);
          if (preState.ok) {
            const unmetKeys = preState.evaluation.preconditions
              .filter((p) => p.required && !p.satisfied)
              .map((p) => p.key);
            expect(unmetKeys).toEqual(
              pathKind === 'conflict_approve'
                ? ['conflict_cleared', 'funds_on_account']
                : ['funds_on_account'],
            );
          }
        }

        if (pathKind === 'open_prospective_matter') {
          const openRes = await runAsActionActor(
            'P-000002',
            () => openProspectiveMatterAction(created.id),
            { roles: ['fee_earner'], mfaVerified: false },
          );
          if (gateCase.expectedAllowed) {
            expect(openRes.ok).toBe(true);
            if (openRes.ok) {
              expect(openRes.matter.matterStatusId).toBe('matter_status.active');
            }
          } else {
            expect(openRes.ok).toBe(false);
            expect(isActionDenied(openRes)).toBe(false);
            expect((openRes as { code?: string }).code).toBe(
              'MATTER_OPENING_GATE_BLOCKED',
            );
          }
        } else if (pathKind === 'save_matter') {
          const latestBeforeSave = await matterRepo.getMatterById<Matter>(ctxFee, created.id);
          const saveOpenRes = await runAsActionActor(
            'P-000001',
            () =>
              saveMatterRecord(
                {
                  id: created.id,
                  title: latestBeforeSave!.title,
                  clientId: latestBeforeSave!.clientId,
                  practiceAreaId: latestBeforeSave!.practiceAreaId,
                  workTypeSubcategoryId: latestBeforeSave!.workTypeSubcategoryId,
                  responsiblePartnerId: latestBeforeSave!.responsiblePartnerId,
                  supervisingPartnerId: latestBeforeSave!.supervisingPartnerId,
                  leadFeeEarnerId: latestBeforeSave!.leadFeeEarnerId,
                  teamMemberIds: latestBeforeSave!.teamMemberIds,
                  feeEstimateGbp: latestBeforeSave!.feeEstimateGbp,
                  retainerMoniesOnAccountPence: latestBeforeSave!.retainerMoniesOnAccountPence,
                  retainerMoniesOnAccountGbp: latestBeforeSave!.retainerMoniesOnAccountGbp,
                  matterStatusId: 'matter_status.active',
                  conflictCheckRecord: latestBeforeSave!.conflictCheckRecord,
                  riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
                },
                { id: created.id, byId: 'P-000001', saveMode: 'submit_cleared' },
              ),
            { roles: ['partner'], mfaVerified: false },
          );
          expect(saveOpenRes.errors).toBeUndefined();
          expect(saveOpenRes.matter).not.toBeNull();
          if (gateCase.expectedAllowed) {
            expect(saveOpenRes.matter?.matterStatusId).toBe('matter_status.active');
          } else {
            expect(saveOpenRes.matter?.matterStatusId).toBe('matter_status.prospective_enquiry');
            const unmet = (saveOpenRes.openingGate?.preconditions ?? [])
              .filter((p) => p.required && !p.satisfied)
              .map((p) => p.key);
            expect(unmet).toEqual(['funds_on_account']);
          }
        } else if (pathKind === 'conflict_approve') {
          const confRes = await runAsActionActor(
            'P-000003',
            () =>
              updateMatterConflictRecord(
                created.id,
                makeConflictRecord('P-000003', 'Bethan Rees', 'Approved'),
                'P-000003',
              ),
            { roles: ['risk_compliance'], mfaVerified: true },
          );
          expect(confRes.matter).not.toBeNull();
          expect(confRes.matter?.matterStatusId).toBe(
            gateCase.expectedAllowed ? 'matter_status.active' : 'matter_status.prospective_enquiry',
          );
        } else if (pathKind === 'costs_sign_off') {
          const costsRes = await runAsActionActor(
            'P-000001',
            () => signOffMatterCostsRecord(created.id, 'P-000001', 'Partner costs approved'),
            { roles: ['partner'], mfaVerified: false },
          );
          expect(costsRes.matter).not.toBeNull();
          expect(costsRes.matter?.matterStatusId).toBe(
            gateCase.expectedAllowed ? 'matter_status.active' : 'matter_status.prospective_enquiry',
          );
        } else if (pathKind === 'high_risk_compliance_approve') {
          const compRes = await runAsActionActor(
            'P-000003',
            () =>
              transitionRegisterRecordService(
                { recordId: hroIdForCell!, transitionKey: 'compliance_approve', comment: 'Compliance stage approved' },
                'P-000003',
              ),
            { roles: ['risk_compliance'], mfaVerified: false },
          );
          expect(compRes.ok).toBe(true);
          const afterCompMatter = await matterRepo.getMatterById<Matter>(ctxFee, created.id);
          expect(afterCompMatter?.matterStatusId).toBe(
            gateCase.expectedAllowed ? 'matter_status.active' : 'matter_status.prospective_enquiry',
          );
        }

        if (!gateCase.expectedAllowed) {
          const postState = await runAsActionActor(
            'P-000002',
            () => getMatterOpeningGateStateRecord(created.id, 'P-000002'),
            { roles: ['fee_earner'], mfaVerified: false },
          );
          expect(postState.ok).toBe(true);
          if (postState.ok) {
            expect(
              postState.evaluation.preconditions
                .filter((p) => p.required && !p.satisfied)
                .map((p) => p.key),
            ).toEqual(['funds_on_account']);
          }
        }
      }
    }

    // Sibling chase isolation + Finance CDD redaction + Concurrent reversal vs open race + Post-opening reversal + Partner HRO override
    const raceMatter = await createConveyancingProspectiveMatter({
      title: 'S1-08 Race & Sibling Chase Matter',
      retainerMoniesOnAccountPence: 50_000,
      signedEngagement: true,
    });
    const finGateInitial = await runAsActionActor(
      'P-000009',
      () => getMatterOpeningGateStateRecord(raceMatter.id, 'P-000009'),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finGateInitial.ok).toBe(true);
    if (finGateInitial.ok) {
      expect(
        finGateInitial.evaluation.preconditions.find((p) => p.key === 'cdd_complete')?.statusSummary,
      ).toBe('Not available to you');
      expect(
        finGateInitial.evaluation.preconditions
          .filter((p) => p.required && !p.satisfied)
          .map((p) => p.key),
      ).toEqual(['funds_on_account']);
    }

    const reqSiblingA = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: raceMatter.id,
          requestedAmountPence: 25_000,
          idempotencyKey: 'race-sib-a',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const reqSiblingB = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: raceMatter.id,
          requestedAmountPence: 25_000,
          idempotencyKey: 'race-sib-b',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!reqSiblingA.ok || !reqSiblingB.ok) throw new Error('Failed sending sibling requests');
    expect(reqSiblingA.chase?.status).toBe('active');
    expect(reqSiblingB.chase?.status).toBe('active');

    const payA = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqSiblingA.request.id,
          amountPence: 25_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(payA.ok).toBe(true);
    expect((await chasingRepo.getChaseById(ctxFee, reqSiblingA.chase!.id))?.status).toBe('stopped');
    expect((await chasingRepo.getChaseById(ctxFee, reqSiblingB.chase!.id))?.status).toBe('active');

    const payB = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: reqSiblingB.request.id,
          amountPence: 25_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!payB.ok) throw new Error(String(payB.error));
    expect((await chasingRepo.getChaseById(ctxFee, reqSiblingB.chase!.id))?.status).toBe('stopped');

    // Race test: reverse vs open running concurrently must produce a strictly consistent commit order
    const [raceRevRes, raceOpenRes] = await Promise.all([
      runAsTestActor(
        'P-000009',
        () =>
          reverseMoneyOnAccountReceiptRecord(
            {
              receiptId: payB.receipt.id,
              reason: 'Concurrent reversal vs open check',
            },
            'P-000009',
            {
              tenantCtx: testTenantCtx('P-000009', {
                roles: ['finance'],
                mfaVerified: false,
              }),
            },
          ),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsTestActor(
        'P-000002',
        () =>
          openProspectiveMatterRecord(raceMatter.id, 'P-000002', {
            tenantCtx: testTenantCtx('P-000002', {
              roles: ['fee_earner'],
              mfaVerified: false,
            }),
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      ),
    ]);
    expect(raceRevRes.ok).toBe(true);
    const postRaceMatter = await matterRepo.getMatterById<Matter>(ctxFee, raceMatter.id);
    if (!raceOpenRes.ok) {
      expect(isActionDenied(raceOpenRes)).toBe(false);
      if (!isActionDenied(raceOpenRes)) {
        expect(raceOpenRes.code).toBe('MATTER_OPENING_GATE_BLOCKED');
      }
      expect(postRaceMatter?.matterStatusId).toBe('matter_status.prospective_enquiry');
      const gateAfterLostRace = await runAsActionActor(
        'P-000002',
        () => getMatterOpeningGateStateRecord(raceMatter.id, 'P-000002'),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(gateAfterLostRace.ok).toBe(true);
      if (gateAfterLostRace.ok) {
        expect(
          gateAfterLostRace.evaluation.preconditions
            .filter((p) => p.required && !p.satisfied)
            .map((p) => p.key),
        ).toEqual(['funds_on_account']);
      }
      // Replace reversed £250 and open cleanly
      await runAsActionActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: reqSiblingB.request.id,
            amountPence: 25_000,
            receivedDate: '2026-11-27',
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      const openClean = await runAsActionActor(
        'P-000002',
        () => openProspectiveMatterAction(raceMatter.id),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(openClean.ok).toBe(true);
    } else {
      expect(postRaceMatter?.matterStatusId).toBe('matter_status.active');
      const [matterAudits, receiptAudits] = await Promise.all([
        auditRepo.listAuditEntriesForRecord(ctxFee, 'matter', raceMatter.id),
        auditRepo.listAuditEntriesForRecord(ctxFee, 'money_on_account_receipt', payB.receipt.id),
      ]);
      const openAudit = matterAudits.find((a) => a.field === 'Matter opening (Open matter)');
      const revAudit = receiptAudits.find((a) => a.field === 'Money on account receipt reversed');
      expect(openAudit).toBeDefined();
      expect(revAudit).toBeDefined();
      expect(openAudit!.seq).toBeTypeOf('number');
      expect(revAudit!.seq).toBeTypeOf('number');
      expect(openAudit!.seq!).toBeLessThan(revAudit!.seq!);
    }

    const activeCheck = await matterRepo.getMatterById<Matter>(ctxFee, raceMatter.id);
    expect(activeCheck?.matterStatusId).toBe('matter_status.active');

    // Reversal AFTER opening leaves matter Open and does NOT reopen the opening gate
    const allReceiptsAfterOpen = await new TenantMoneyOnAccountRepository().listReceiptsForMatter(
      testTenantCtx('P-000009'),
      raceMatter.id,
    );
    const activeRcpt = allReceiptsAfterOpen.find((r) => !r.reversedAt)!;
    const revAfterOpen = await runAsActionActor(
      'P-000009',
      () =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: activeRcpt.id,
          reason: 'Post-opening reversal test',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(revAfterOpen.ok).toBe(true);
    expect((await matterRepo.getMatterById<Matter>(ctxFee, raceMatter.id))?.matterStatusId).toBe(
      'matter_status.active',
    );

    // High-risk matter blocked on funds_on_account -> Partner funds_on_account override -> explicit Open matter (R751)
    const hroOvrMatter = await createConveyancingProspectiveMatter({
      title: 'S1-08 High Risk Override Path',
      retainerMoniesOnAccountPence: 50_000,
      riskAnswers: HIGH_RISK_ANSWERS,
      riskFollowUps: HIGH_RISK_FOLLOW_UPS,
      responsiblePartnerId: 'P-000005',
      leadFeeEarnerId: 'P-000002',
      signedEngagement: true,
    });
    const hroList = await regRepo.listVisibleRegisterRecords(
      testTenantCtx('P-000004'),
      'P-000004',
      { includeRestricted: true, registerTypeKey: 'high_risk_opening', matterId: hroOvrMatter.id },
    );
    const hroOvrId = hroList[0]!.id;
    await runAsActionActor(
      'P-000001',
      () =>
        transitionRegisterRecordService(
          { recordId: hroOvrId, transitionKey: 'partner_approve', comment: 'Partner stage approved' },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    await runAsActionActor(
      'P-000003',
      () =>
        transitionRegisterRecordService(
          { recordId: hroOvrId, transitionKey: 'compliance_approve', comment: 'Compliance stage approved' },
          'P-000003',
        ),
      { roles: ['risk_compliance'], mfaVerified: false },
    );
    expect((await matterRepo.getMatterById<Matter>(ctxFee, hroOvrMatter.id))?.matterStatusId).toBe(
      'matter_status.prospective_enquiry',
    );
    const ovrRes = await runAsActionActor(
      'P-000001',
      () =>
        overrideMatterOpeningPreconditionAction({
          matterId: hroOvrMatter.id,
          preconditionKey: 'funds_on_account',
          reason: 'Partner undertaking received pending same-day CHAPS transfer.',
        }),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(ovrRes.ok).toBe(true);
    if (ovrRes.ok) {
      expect(ovrRes.evaluation.canOpen).toBe(true);
    }
    const openHro = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(hroOvrMatter.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openHro.ok).toBe(true);
    expect((await matterRepo.getMatterById<Matter>(ctxFee, hroOvrMatter.id))?.matterStatusId).toBe(
      'matter_status.active',
    );
  }, 120_000);

  it('7. Rule 9 two-tenant isolation, forged tenant-bravo claim (TENANCY_FORGERY_DETECTED), and restricted staff-matter refusal (Lesson 5)', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolManager = new TenantPostgresPoolManager();
    const runner = new TenantMigrationRunner();
    const { raw: baseRaw } = makeMoaTestConfig();
    const alphaRaw = { ...baseRaw, tenantId: 'tenant-alpha' };
    const bravoRaw = { ...baseRaw, tenantId: 'tenant-bravo' };
    const ctxAlpha = makeVerifiedTenantCtx('tenant-alpha', 'P-000001', ['partner', 'admin'], true);
    const ctxBravo = makeVerifiedTenantCtx('tenant-bravo', 'P-000001', ['partner', 'admin'], true);
    const alphaCfg = loadAndValidateTenantConfig(
      alphaRaw,
      { tenantId: 'tenant-alpha', environment: 'test' },
      'test',
      'multi_tenant',
    );
    const bravoCfg = loadAndValidateTenantConfig(
      bravoRaw,
      { tenantId: 'tenant-bravo', environment: 'test' },
      'test',
      'multi_tenant',
    );

    try {
      await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
      await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);
      await importFirmStoreModulesToPostgres({
        ctx: ctxAlpha,
        tenantConfig: alphaCfg,
        store: createSeedStore(new Date()),
        clearFirst: true,
      });
      await importFirmStoreModulesToPostgres({
        ctx: ctxBravo,
        tenantConfig: bravoCfg,
        store: createSeedStore(new Date()),
        clearFirst: true,
      });

      setActiveTenantConfigForTesting(alphaRaw, {});

      // Create unrestricted control matter & request FIRST in Alpha so the restricted staff matter & its
      // request/receipt/chase get strictly distinct sequence IDs that do NOT exist in Bravo.
      const alphaControlSave = await runAsActionActor(
        'P-000001',
        () =>
          saveMatterRecord(
            {
              title: 'Alpha Unrestricted Control Matter',
              clientId: 'O-000001',
              practiceAreaId: 'work_type.real_estate_and_property',
              workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001', 'P-000009'],
              isStaffMatter: false,
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      expect(alphaControlSave.matter?.isStaffMatter).toBe(false);
      const alphaControlMatterId = alphaControlSave.matter!.id;
      const alphaControlReq = await runAsActionActor(
        'P-000001',
        () =>
          createAndSendMoneyOnAccountRequestAction({
            matterId: alphaControlMatterId,
            requestedAmountPence: 40_000,
            recipientEmail: 'alpha-control@example.test',
            idempotencyKey: 'alpha-control-req-1',
          }),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      if (!alphaControlReq.ok) throw new Error(String(alphaControlReq.error));
      const finControlRec = await runAsActionActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: alphaControlReq.request.id,
            amountPence: 10_000,
            receivedDate: '2026-11-27',
            idempotencyKey: 'alpha-control-rcpt-1',
          }),
        { tenantId: 'tenant-alpha', roles: ['finance'], mfaVerified: false },
      );
      expect(finControlRec.ok).toBe(true);
      if (finControlRec.ok) {
        const finControlRev = await runAsActionActor(
          'P-000009',
          () =>
            reverseMoneyOnAccountReceiptAction({
              receiptId: finControlRec.receipt.id,
              reason: 'Finance positive control reversal',
            }),
          { tenantId: 'tenant-alpha', roles: ['finance'], mfaVerified: false },
        );
        expect(finControlRev.ok).toBe(true);
      }

      // R869: Explicitly staff-restricted matter in Alpha (Finance P-000009 excluded)
      const alphaMatterSave = await runAsActionActor(
        'P-000001',
        () =>
          saveMatterRecord(
            {
              title: 'Alpha Staff Matter',
              clientId: 'P-000002',
              practiceAreaId: 'work_type.real_estate_and_property',
              workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001'],
              isStaffMatter: true,
              restrictedAccessUserIds: ['P-000001'],
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      expect(alphaMatterSave.matter).not.toBeNull();
      expect(alphaMatterSave.matter?.isStaffMatter).toBe(true);
      expect(alphaMatterSave.matter?.restrictedAccessUserIds).toContain('P-000001');
      expect(alphaMatterSave.matter?.restrictedAccessUserIds).not.toContain('P-000009');
      const alphaMatterId = alphaMatterSave.matter!.id;

      // Send MOA request in Alpha as insider P-000001 on restricted staff matter
      const alphaReq = await runAsActionActor(
        'P-000001',
        () =>
          createAndSendMoneyOnAccountRequestAction({
            matterId: alphaMatterId,
            requestedAmountPence: 50_000,
            recipientEmail: 'alpha-staff@example.test',
            idempotencyKey: 'alpha-isolation-1',
          }),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      if (!alphaReq.ok) throw new Error(String(alphaReq.error));
      const alphaReqId = alphaReq.request.id;
      const alphaChaseId = alphaReq.chase!.id;

      // Insider records receipt so we also have an Alpha receiptId
      const alphaRcpt = await runAsActionActor(
        'P-000001',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: alphaReqId,
            amountPence: 10_000,
            receivedDate: '2026-11-27',
          }),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      if (!alphaRcpt.ok) throw new Error(String(alphaRcpt.error));
      const alphaRcptId = alphaRcpt.receipt.id;

      // R857: Seed Alpha & Bravo PMS data + upload Alpha moa_receipt evidence on control matter for tampered ID checks
      const alphaPmsRepo = new TenantPmsRepository();
      await alphaPmsRepo.importExtractDataset(
        ctxAlpha,
        buildMinimalPmsDataset('MAT-ALPHA-CTL', [
          {
            transaction_id: 'TX-ALPHA-OTHER-MATTER',
            date: '2026-11-27',
            type: 'Receipt',
            description: 'Belongs to control matter, NOT staff matter',
            amount: 200,
            amount_pence: 20_000,
          },
        ]),
      );
      await alphaPmsRepo.putPmsLink(ctxAlpha, {
        id: 'PMSL-ALPHA-STAFF',
        entityType: 'matter',
        onesquaredId: alphaMatterId,
        pmsCode: 'MAT-ALPHA-STAFF',
        matchedBy: 'manual',
        matchedAt: '2026-11-27T08:00:00.000Z',
      });
      await alphaPmsRepo.putPmsLink(ctxAlpha, {
        id: 'PMSL-ALPHA-CTL',
        entityType: 'matter',
        onesquaredId: alphaControlMatterId,
        pmsCode: 'MAT-ALPHA-CTL',
        matchedBy: 'manual',
        matchedAt: '2026-11-27T08:00:00.000Z',
      });

      const alphaControlProof = await runAsActionActor(
        'P-000001',
        () =>
          uploadEvidenceArtifactRecord(
            {
              subjectType: 'matter',
              subjectId: alphaControlMatterId,
              purpose: 'moa_receipt',
              fileName: 'alpha-control-proof.pdf',
              contentType: 'application/pdf',
              bytes: Buffer.from('%PDF-1.4\n% Alpha Control Proof\n%%EOF\n'),
            },
            'P-000001',
          ),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      if (!alphaControlProof.ok) throw new Error(alphaControlProof.message);

      // R857 tampered IDs within Alpha:
      // 1) Another matter's PMS transactionId on alphaMatterId -> NOT_FOUND
      const wrongMatterPms = await runAsActionActor(
        'P-000001',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: alphaReqId,
            pmsTransactionId: 'TX-ALPHA-OTHER-MATTER',
          }),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      expect(wrongMatterPms).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      // 2) Another matter's evidenceArtifactId on alphaMatterId -> NOT_FOUND
      const wrongMatterArt = await runAsActionActor(
        'P-000001',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: alphaReqId,
            amountPence: 5_000,
            receivedDate: '2026-11-27',
            evidenceArtifactId: alphaControlProof.artifact.id,
          }),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      expect(wrongMatterArt).toMatchObject({ ok: false, code: 'NOT_FOUND' });

      // Lesson 5: Unauthorised Finance user P-000009 in Alpha receives uniform NOT_FOUND on staff matter
      const staffAttempts: Array<() => Promise<unknown>> = [
        () =>
          createAndSendMoneyOnAccountRequestAction({
            matterId: alphaMatterId,
            requestedAmountPence: 50_000,
            idempotencyKey: 'unauth-req',
          }),
        () =>
          cancelMoneyOnAccountRequestAction({
            requestId: alphaReqId,
            reason: 'Unauthorised cancel',
          }),
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: alphaReqId,
            amountPence: 5000,
            receivedDate: '2026-11-27',
          }),
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: alphaReqId,
            pmsTransactionId: 'CA-UNKNOWN',
          }),
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: alphaRcptId,
            reason: 'Unauthorised reverse',
          }),
      ];
      for (const staffAttempt of staffAttempts) {
        const res = await runAsActionActor('P-000009', staffAttempt, {
          tenantId: 'tenant-alpha',
          roles: ['finance'],
          mfaVerified: false,
        });
        expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      }

      // Cross-tenant setup in Bravo for tampered TX/artifact tests + cross-tenant isolation
      setActiveTenantConfigForTesting(bravoRaw, {});
      const bravoMatterSave = await runAsActionActor(
        'P-000001',
        () =>
          saveMatterRecord(
            {
              title: 'Bravo Matter',
              clientId: 'O-000001',
              practiceAreaId: 'work_type.real_estate_and_property',
              workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001', 'P-000009'],
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        { tenantId: 'tenant-bravo', roles: ['partner'], mfaVerified: false },
      );
      const bravoMatterId = bravoMatterSave.matter!.id;
      const bravoReq = await runAsActionActor(
        'P-000001',
        () =>
          createAndSendMoneyOnAccountRequestAction({
            matterId: bravoMatterId,
            requestedAmountPence: 50_000,
            recipientEmail: 'bravo@example.test',
            idempotencyKey: 'bravo-req-1',
          }),
        { tenantId: 'tenant-bravo', roles: ['partner'], mfaVerified: false },
      );
      if (!bravoReq.ok) throw new Error(String(bravoReq.error));
      expect(alphaMatterId).not.toBe(bravoMatterId);
      expect(alphaReqId).not.toBe(bravoReq.request.id);
      expect(alphaChaseId).not.toBe(bravoReq.chase!.id);
      const bravoPmsRepo = new TenantPmsRepository();
      await bravoPmsRepo.importExtractDataset(
        ctxBravo,
        buildMinimalPmsDataset('MAT-BRAVO-1', [
          {
            transaction_id: 'TX-BRAVO-ONLY',
            date: '2026-11-27',
            type: 'Receipt',
            description: 'Bravo client receipt',
            amount: 300,
            amount_pence: 30_000,
          },
        ]),
      );
      await bravoPmsRepo.putPmsLink(ctxBravo, {
        id: 'PMSL-BRAVO-1',
        entityType: 'matter',
        onesquaredId: bravoMatterId,
        pmsCode: 'MAT-BRAVO-1',
        matchedBy: 'manual',
        matchedAt: '2026-11-27T08:00:00.000Z',
      });

      // R857 cross-tenant tampered IDs & actions: Bravo actor with Bravo config cannot touch Alpha's IDs -> NOT_FOUND
      const crossAttempts: Array<() => Promise<unknown>> = [
        () =>
          createAndSendMoneyOnAccountRequestAction({
            matterId: alphaMatterId,
            requestedAmountPence: 50_000,
            idempotencyKey: 'cross-req',
          }),
        () =>
          cancelMoneyOnAccountRequestAction({
            requestId: alphaReqId,
            reason: 'Cross-tenant cancel',
          }),
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: alphaReqId,
            amountPence: 5000,
            receivedDate: '2026-11-27',
          }),
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: bravoReq.request.id,
            amountPence: 5000,
            receivedDate: '2026-11-27',
            evidenceArtifactId: alphaControlProof.artifact.id,
          }),
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: alphaReqId,
            pmsTransactionId: 'TX-ALPHA-OTHER-MATTER',
          }),
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: alphaRcptId,
            reason: 'Cross-tenant reverse',
          }),
        () => stopCommunicationChaseAction({ chaseId: alphaChaseId }),
        () => retryCommunicationChaseAction({ chaseId: alphaChaseId }),
      ];
      for (const crossAttempt of crossAttempts) {
        const res = await runAsActionActor('P-000001', crossAttempt, {
          tenantId: 'tenant-bravo',
          roles: ['partner', 'admin', 'finance'],
          mfaVerified: true,
        });
        expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      }

      // R857 cross-tenant upload & download routes for moa_receipt -> 404
      const makeMoaUploadForm = (targetMatterId: string) => {
        const f = new FormData();
        f.append('subjectType', 'matter');
        f.append('subjectId', targetMatterId);
        f.append('purpose', 'moa_receipt');
        f.append(
          'file',
          new File([Buffer.from('%PDF-1.4\n% Cross Tenant\n%%EOF\n')], 'cross.pdf', {
            type: 'application/pdf',
          }),
        );
        return f;
      };
      const crossUploadRes = await runAsActionActor(
        'P-000009',
        () =>
          evidenceUploadRoute.POST(
            new Request('http://localhost/api/evidence/upload', {
              method: 'POST',
              headers: { 'content-length': '2048' },
              body: makeMoaUploadForm(alphaMatterId),
            }),
          ),
        { tenantId: 'tenant-bravo', roles: ['finance'], mfaVerified: false },
      );
      expect(crossUploadRes.status).toBe(404);

      const crossDlRes = await runAsActionActor(
        'P-000009',
        () =>
          evidenceDownloadRoute.GET(
            new Request(`http://localhost${alphaControlProof.downloadUrl}`, {
              method: 'GET',
            }),
          ),
        { tenantId: 'tenant-bravo', roles: ['finance'], mfaVerified: false },
      );
      expect(crossDlRes.status).toBe(404);

      // Also check Alpha trying Bravo's pmsTransactionId -> NOT_FOUND
      setActiveTenantConfigForTesting(alphaRaw, {});
      const alphaUsingBravoPms = await runAsActionActor(
        'P-000009',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: alphaControlReq.request.id,
            pmsTransactionId: 'TX-BRAVO-ONLY',
          }),
        { tenantId: 'tenant-alpha', roles: ['finance'], mfaVerified: false },
      );
      expect(alphaUsingBravoPms).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      setActiveTenantConfigForTesting(bravoRaw, {});

      // Bank details config isolation: saving Bravo MOA config does not mutate Alpha
      const bravoCfgSave = await runAsActionActor(
        'P-000001',
        () =>
          saveMoneyOnAccountConfigAction(
            { paymentReferencePrefix: 'BRAVO1' },
            'Bravo prefix config',
          ),
        { tenantId: 'tenant-bravo', roles: ['admin'], mfaVerified: true },
      );
      expect(bravoCfgSave.ok).toBe(true);
      const alphaStoredMod = await new TenantCatalogueRepository().getModuleConfig<
        Partial<MoneyOnAccountConfiguration>
      >(ctxAlpha, 'money_on_account');
      expect(alphaStoredMod?.paymentReferencePrefix).not.toBe('BRAVO1');

      // Forged tenant claim: active config is Alpha, token claims tenant-bravo -> TENANCY_FORGERY_DETECTED & zero writes
      setActiveTenantConfigForTesting(alphaRaw, {});
      const alphaBeforeReqs = await new TenantMoneyOnAccountRepository().listRequestsForMatter(
        ctxAlpha,
        alphaMatterId,
      );
      const expectForged = async (fn: () => Promise<unknown>) => {
        await expect(
          runAsActionActor('P-000001', fn, {
            tenantId: 'tenant-bravo',
            roles: ['partner', 'admin', 'finance'],
            mfaVerified: true,
          }),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      };
      await expectForged(() =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: alphaMatterId,
          requestedAmountPence: 10_000,
          idempotencyKey: 'forged-req',
        }),
      );
      await expectForged(() =>
        cancelMoneyOnAccountRequestAction({
          requestId: alphaReqId,
          reason: 'Forged cancel',
        }),
      );
      await expectForged(() =>
        recordMoneyOnAccountReceiptAction({
          requestId: alphaReqId,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
        }),
      );
      await expectForged(() =>
        matchPmsClientLedgerReceiptAction({
          requestId: alphaReqId,
          pmsTransactionId: 'CA-FORGED',
        }),
      );
      await expectForged(() =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: alphaRcptId,
          reason: 'Forged reverse',
        }),
      );
      await expectForged(() =>
        saveMoneyOnAccountConfigAction(
          { paymentReferencePrefix: 'FORGED' },
          'Forged config save',
        ),
      );
      await expectForged(() =>
        stopCommunicationChaseAction({ chaseId: alphaChaseId }),
      );
      await expectForged(() =>
        retryCommunicationChaseAction({ chaseId: alphaChaseId }),
      );
      await expectForged(() =>
        evidenceUploadRoute.POST(
          new Request('http://localhost/api/evidence/upload', {
            method: 'POST',
            headers: { 'content-length': '2048' },
            body: makeMoaUploadForm(alphaMatterId),
          }),
        ),
      );
      await expectForged(() =>
        evidenceDownloadRoute.GET(
          new Request(`http://localhost${alphaControlProof.downloadUrl}`, {
            method: 'GET',
          }),
        ),
      );
      expect(
        await new TenantMoneyOnAccountRepository().listRequestsForMatter(
          ctxAlpha,
          alphaMatterId,
        ),
      ).toHaveLength(alphaBeforeReqs.length);
    } finally {
      setTestActorSession(null);
      setActiveTenantConfigForTesting(null);
      await poolManager.closeAllPools();
    }
  }, 60_000);
});
