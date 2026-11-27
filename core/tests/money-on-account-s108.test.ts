import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_API_VERSION,
  CORE_TENANT_MIGRATIONS,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  TenantCatalogueRepository,
  TenantChasingRepository,
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
  reverseMoneyOnAccountReceiptAction,
  saveMoneyOnAccountConfigAction,
  stopCommunicationChaseAction,
} from '@/app/actions';
import * as evidenceDownloadRoute from '@/app/api/evidence/download/route';
import * as evidenceUploadRoute from '@/app/api/evidence/upload/route';
import { isActionDenied } from '@/domain/actionResult';
import { addDays } from '@/domain/dates';
import {
  buildMoneyOnAccountPaymentReference,
  evaluateMatterFundsOnAccountGate,
  formatMaskedMoaConfigAuditSummary,
  maskBankDetailForAudit,
  resolveEffectiveMoneyOnAccountConfig,
} from '@/domain/moneyOnAccount';
import type { ConflictCheckRecordInput, Matter, Person, Task } from '@/domain/types';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  completeClientCddRecord,
  createAndSendMoneyOnAccountRequestRecord,
  downloadOutboxAttachmentForAdminRecord,
  executeCommunicationChasesForTenant,
  getMatterOpeningGateStateRecord,
  prepareQuoteConversionRecord,
  recordCddChecklistItemRecord,
  resetAllDemoData,
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
}) {
  const actorId = params?.leadFeeEarnerId ?? 'P-000002';
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
          conflictCheckRecord: makeConflictRecord(actorId, 'Dafydd Evans', 'Cleared'),
          riskAssessment: {
            answers: params?.riskAnswers ?? BASE_LOW_RISK_ANSWERS,
            ...(params?.riskFollowUps ? { followUps: params.riskFollowUps } : {}),
          },
        },
        { byId: actorId, saveMode: 'submit_cleared' },
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

  it('1. Unit & Core API contracts: payment ref <= 18 ASCII zero-PII, live placeholder refusal, safe core defaults & R824 masking', () => {
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

    // R824 bank detail masking (only last 2 chars preserved)
    expect(maskBankDetailForAudit('12-34-56', 'sortCode')).toBe('**-**-56');
    expect(maskBankDetailForAudit('87654321', 'accountNumber')).toBe('******21');
    expect(maskBankDetailForAudit('GB29NWBK60161331926819', 'iban')).toBe(
      '********************19',
    );
    const auditSummary = formatMaskedMoaConfigAuditSummary({
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
    });
    expect(auditSummary).not.toContain('12-34-56');
    expect(auditSummary).not.toContain('87654321');
    expect(auditSummary).not.toContain('GB29NWBK60161331926819');
    expect(auditSummary).toContain('**-**-56');
    expect(auditSummary).toContain('******21');
    expect(auditSummary).toContain('19');
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
    expect(send1.request.bankDetailsSnapshot.sortCode).toBe('00-00-00');
    expect(send1.request.bankDetailsSnapshot.accountNumber).toBe('00000000');
    expect(send1.outboxRecord?.matterId).toBe(convMatterId);
    expect(send1.outboxRecord?.quoteId).toBe(quoteId);
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
  }, 45_000);

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
      expect(wrongPurposeRes.code).toBe('VALIDATION_ERROR');
    }

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

    // Fee earner cannot reverse; Finance reverses and request reverts to 'requested'
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
  }, 45_000);

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
      runAsActionActor(
        'P-000009',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: reqId,
            pmsTransactionId: 'TX-POS-PART-300',
          }),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsActionActor(
        'P-000001',
        () =>
          matchPmsClientLedgerReceiptAction({
            requestId: reqId,
            pmsTransactionId: 'TX-POS-PART-300',
          }),
        { roles: ['partner'], mfaVerified: false },
      ),
    ]);
    const successes = raceResults.filter((r) => r.ok);
    const failures = raceResults.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failObj = failures[0]!;
    if (!failObj.ok && !isActionDenied(failObj)) {
      expect(failObj.code).toBe('MOA_PMS_RECEIPT_ALREADY_MATCHED');
    }

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

  it('6. R822 / Q8 canonical gate rule: tests all 6 cases across all 5 opening paths, reversal vs open race, and reversal after opening', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const { raw } = makeMoaTestConfig();
    setActiveTenantConfigForTesting(raw, {});
    await ensureOrgValidCdd('O-000001', 'P-000001');

    // Pure unit verification of Case 4(b): no agreed POA, single request paid in full
    const case4bEval = evaluateMatterFundsOnAccountGate({
      requests: [{ id: 'R1', status: 'received', requestedAmountPence: 20_000 }],
      receipts: [{ requestId: 'R1', amountPence: 20_000, reversedAt: null }],
      agreedAmountPence: null,
    });
    expect(case4bEval.fundsOnAccountSatisfied).toBe(true);

    // Pure unit verification of Case 5(a): cancelled request only -> blocked
    const case5aEval = evaluateMatterFundsOnAccountGate({
      requests: [{ id: 'R1', status: 'cancelled', requestedAmountPence: 50_000 }],
      receipts: [],
      agreedAmountPence: 50_000,
    });
    expect(case5aEval.fundsOnAccountSatisfied).toBe(false);

    // Path 1: saveMatterRecord (Residential Conveyancing, 0 requests -> Case 1 blocked)
    const mCase = await createConveyancingProspectiveMatter({
      title: 'S1-08 Gate 6-Case Matter',
      retainerMoniesOnAccountPence: 50_000,
      signedEngagement: true,
    });
    expect(mCase.matterStatusId).toBe('matter_status.prospective_enquiry');

    const gateStateInitial = await runAsActionActor(
      'P-000009',
      () => getMatterOpeningGateStateRecord(mCase.id, 'P-000009'),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(gateStateInitial.ok).toBe(true);
    if (gateStateInitial.ok) {
      const fundsPre = gateStateInitial.evaluation.preconditions.find(
        (p) => p.key === 'funds_on_account',
      );
      expect(fundsPre?.required).toBe(true);
      expect(fundsPre?.satisfied).toBe(false);
      // R812: Finance gate state hides CDD verdict cleanly
      const cddPre = gateStateInitial.evaluation.preconditions.find(
        (p) => p.key === 'cdd_complete',
      );
      expect(cddPre?.statusSummary).toBe('Not available to you');
    }

    // Open fails on Case 1 (no request)
    const openCase1 = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(mCase.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openCase1.ok).toBe(false);

    // Path 2: updateMatterConflictRecord remains prospective when funds missing
    await runAsActionActor(
      'P-000003',
      () =>
        updateMatterConflictRecord(
          mCase.id,
          makeConflictRecord('P-000003', 'Bethan Rees', 'Approved'),
          'P-000003',
        ),
      { roles: ['risk_compliance'], mfaVerified: true },
    );
    expect(
      (await new TenantMatterRepository().getMatterById<Matter>(testTenantCtx('P-000002'), mCase.id))
        ?.matterStatusId,
    ).toBe('matter_status.prospective_enquiry');

    // Path 3: signOffMatterCostsRecord remains prospective when funds missing
    const costsRes = await runAsActionActor(
      'P-000001',
      () => signOffMatterCostsRecord(mCase.id, 'P-000001', 'Partner costs approved'),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(costsRes.matter?.matterStatusId).toBe('matter_status.prospective_enquiry');

    // Case 3: £100 request created & paid in full while agreed POA is £500 -> STILL blocked!
    const smallReq = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: mCase.id,
          requestedAmountPence: 10_000,
          idempotencyKey: 'gate-small-req',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!smallReq.ok) throw new Error(String(smallReq.error));
    const smallPaid = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: smallReq.request.id,
          amountPence: 10_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!smallPaid.ok) throw new Error(String(smallPaid.error));
    expect(smallPaid.request.status).toBe('received');

    const openCase3 = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(mCase.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openCase3.ok).toBe(false);

    // Case 5: Create a cancelled request alongside -> cancelled never blocks once remaining £400 request is paid
    const cancelMe = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: mCase.id,
          requestedAmountPence: 40_000,
          idempotencyKey: 'gate-cancel-me',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!cancelMe.ok) throw new Error(String(cancelMe.error));
    await runAsActionActor(
      'P-000002',
      () =>
        cancelMoneyOnAccountRequestAction({
          requestId: cancelMe.request.id,
          reason: 'Duplicate request cancelled',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );

    // Case 2: Request remaining £400, pay £250 (part_received -> blocked)
    const remReq = await runAsActionActor(
      'P-000002',
      () =>
        createAndSendMoneyOnAccountRequestAction({
          matterId: mCase.id,
          requestedAmountPence: 40_000,
          idempotencyKey: 'gate-rem-req',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    if (!remReq.ok) throw new Error(String(remReq.error));
    const partPaid = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: remReq.request.id,
          amountPence: 25_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!partPaid.ok) throw new Error(String(partPaid.error));
    const openCase2 = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(mCase.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openCase2.ok).toBe(false);

    // Pay remaining £150 -> £500 total across non-cancelled requests -> gate satisfies!
    const balPaid = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: remReq.request.id,
          amountPence: 15_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!balPaid.ok) throw new Error(String(balPaid.error));
    expect(balPaid.request.status).toBe('received');

    // Case 6: Reversing before opening blocks the gate again; concurrent reversal vs open never violates invariant
    const revBeforeOpen = await runAsActionActor(
      'P-000009',
      () =>
        reverseMoneyOnAccountReceiptAction({
          receiptId: balPaid.receipt.id,
          reason: 'Cheque bounced before matter opening',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(revBeforeOpen.ok).toBe(true);
    const blockedAfterRev = await runAsActionActor(
      'P-000002',
      () => openProspectiveMatterAction(mCase.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(blockedAfterRev.ok).toBe(false);

    // Re-pay replacement £150 and test concurrent reverse vs open race cleanly inside TX
    const replPaid = await runAsActionActor(
      'P-000009',
      () =>
        recordMoneyOnAccountReceiptAction({
          requestId: remReq.request.id,
          amountPence: 15_000,
          receivedDate: '2026-11-27',
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    if (!replPaid.ok) throw new Error(String(replPaid.error));

    await Promise.all([
      runAsActionActor(
        'P-000009',
        () =>
          reverseMoneyOnAccountReceiptAction({
            receiptId: replPaid.receipt.id,
            reason: 'Concurrent reversal vs open check',
          }),
        { roles: ['finance'], mfaVerified: false },
      ),
      runAsActionActor(
        'P-000002',
        () => openProspectiveMatterAction(mCase.id),
        { roles: ['fee_earner'], mfaVerified: false },
      ),
    ]);
    // After Promise.all finishes, verify matter status & receipt state are strictly consistent:
    const postRaceMatter = await new TenantMatterRepository().getMatterById<Matter>(
      testTenantCtx('P-000002'),
      mCase.id,
    );
    if (postRaceMatter?.matterStatusId === 'matter_status.prospective_enquiry') {
      // Pay final £150 and open cleanly (Case 4(a))
      await runAsActionActor(
        'P-000009',
        () =>
          recordMoneyOnAccountReceiptAction({
            requestId: remReq.request.id,
            amountPence: 15_000,
            receivedDate: '2026-11-27',
          }),
        { roles: ['finance'], mfaVerified: false },
      );
      const openCase4a = await runAsActionActor(
        'P-000002',
        () => openProspectiveMatterAction(mCase.id),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(openCase4a.ok).toBe(true);
    }

    const activeCheck = await new TenantMatterRepository().getMatterById<Matter>(
      testTenantCtx('P-000002'),
      mCase.id,
    );
    expect(activeCheck?.matterStatusId).toBe('matter_status.active');

    // Reversal AFTER opening leaves matter Open and does NOT reopen the opening gate!
    const allReceiptsAfterOpen = await new TenantMoneyOnAccountRepository().listReceiptsForMatter(
      testTenantCtx('P-000009'),
      mCase.id,
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
    const stillActiveMatter = await new TenantMatterRepository().getMatterById<Matter>(
      testTenantCtx('P-000002'),
      mCase.id,
    );
    expect(stillActiveMatter?.matterStatusId).toBe('matter_status.active');

    // Path 4 & Path 5: high_risk_opening compliance_approve blocks without funds, then opens via override / cleared funds
    const hroMatter = await createConveyancingProspectiveMatter({
      title: 'S1-08 High Risk Path 5 Matter',
      retainerMoniesOnAccountPence: 50_000,
      riskAnswers: HIGH_RISK_ANSWERS,
      riskFollowUps: HIGH_RISK_FOLLOW_UPS,
      responsiblePartnerId: 'P-000005',
      leadFeeEarnerId: 'P-000002',
      signedEngagement: true,
    });
    // Upgrade O-000001 CDD to High-risk tier after hroMatter exists, and sign off costs
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
                  note: 'Verified High-risk CDD item for S1-08',
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
        await signOffMatterCostsRecord(hroMatter.id, 'P-000001', 'High risk costs approved');
      },
      { roles: ['partner'], mfaVerified: false },
    );
    const ctxAdmin = testTenantCtx('P-000004');
    const hroList = await new TenantRegisterRepository().listVisibleRegisterRecords(
      ctxAdmin,
      'P-000004',
      { includeRestricted: true, registerTypeKey: 'high_risk_opening', matterId: hroMatter.id },
    );
    const hroId = hroList[0]!.id;
    await runAsActionActor(
      'P-000001',
      () =>
        transitionRegisterRecordService(
          { recordId: hroId, transitionKey: 'partner_approve', comment: 'Partner stage approved' },
          'P-000001',
        ),
      { roles: ['partner'], mfaVerified: false },
    );
    const compBlocked = await runAsActionActor(
      'P-000003',
      () =>
        transitionRegisterRecordService(
          { recordId: hroId, transitionKey: 'compliance_approve', comment: 'Compliance stage approved' },
          'P-000003',
        ),
      { roles: ['risk_compliance'], mfaVerified: false },
    );
    expect(compBlocked.ok).toBe(true);
    // HRO approved, but matter stays Prospective because funds_on_account is unmet
    expect(
      (await new TenantMatterRepository().getMatterById<Matter>(ctxAdmin, hroMatter.id))
        ?.matterStatusId,
    ).toBe('matter_status.prospective_enquiry');

    // Partner grants audited 'funds_on_account' override (R751: does not auto-open), then Open matter succeeds cleanly!
    const ovrRes = await runAsActionActor(
      'P-000001',
      () =>
        overrideMatterOpeningPreconditionAction({
          matterId: hroMatter.id,
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
      () => openProspectiveMatterAction(hroMatter.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openHro.ok).toBe(true);
    expect(
      (await new TenantMatterRepository().getMatterById<Matter>(ctxAdmin, hroMatter.id))
        ?.matterStatusId,
    ).toBe('matter_status.active');
  }, 45_000);

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
              conflictCheckRecord: makeConflictRecord('P-000001', 'Rhian Morgan', 'Cleared'),
              riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        { tenantId: 'tenant-alpha', roles: ['partner'], mfaVerified: false },
      );
      const alphaMatterId = alphaMatterSave.matter!.id;

      // Send MOA request in Alpha as insider P-000001
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

      // Cross-tenant isolation: Bravo actor with Bravo config cannot touch Alpha's IDs -> NOT_FOUND
      setActiveTenantConfigForTesting(bravoRaw, {});
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
          reverseMoneyOnAccountReceiptAction({
            receiptId: alphaRcptId,
            reason: 'Cross-tenant reverse',
          }),
      ];
      for (const crossAttempt of crossAttempts) {
        const res = await runAsActionActor('P-000001', crossAttempt, {
          tenantId: 'tenant-bravo',
          roles: ['partner', 'admin'],
          mfaVerified: true,
        });
        expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      }

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
  }, 45_000);
});
