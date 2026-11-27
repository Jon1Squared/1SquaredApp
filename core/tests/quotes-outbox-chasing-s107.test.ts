import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_TENANT_MIGRATIONS,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  type MinorUnits,
  TenantCatalogueRepository,
  TenantChasingRepository,
  TenantHrAndRbacRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantTaskWorkflowRepository,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type DocumentPdfConverter,
  type TenantContext,
  type WorkTypesConfiguration,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getOutboxMessageForAdminAction,
  listOutboxMessagesForAdminAction,
  logQuoteFollowUpAction,
  markQuoteSentOfflineAction,
  recordQuoteOutcomeAction,
  retryCommunicationChaseAction,
  reviseQuoteAction,
  saveChasingConfigAction,
  saveEnquiryAction,
  saveQuoteAction,
  saveTeamAction,
  saveWorkTypesConfigAction,
  sendQuoteEmailAction,
  stopCommunicationChaseAction,
} from '@/app/actions';
import * as quotePdfRoute from '@/app/api/quotes/[id]/pdf/route';
import { isActionDenied } from '@/domain/actionResult';
import { addDays } from '@/domain/dates';
import type {
  ConflictCheckRecordInput,
  Enquiry,
  Person,
  Quote,
  Task,
  Team,
} from '@/domain/types';
import { resolveEffectiveWorkTypesConfig } from '@/domain/workTypeConfig';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  executeCommunicationChasesForTenant,
  executeQuoteExpiryForTenant,
  prepareQuoteConversionRecord,
  resetAllDemoData,
  saveMatterRecord,
  sendQuoteEmailRecord,
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

function makeConflictRecord(
  actorId: string,
  actorName: string,
): ConflictCheckRecordInput {
  return {
    status: 'Cleared',
    outcomeLabel: 'Cleared by fee earner',
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
    correlationId: `corr-s107-${tenantId}-${actorId}`,
  });
}

function makeQuoteChasingConfig(overrides?: {
  enabled?: boolean;
  sendEmails?: boolean;
  firstChaseDays?: number;
  secondChaseDays?: number;
  escalateTaskDays?: number;
  emailDisabled?: boolean;
}) {
  const baseObj = notALawFirmBaseConfig as unknown as Record<string, unknown>;
  const baseIntegrations = (baseObj.integrations ?? {}) as Record<string, unknown>;
  const raw = {
    ...baseObj,
    tenantId: 'not-a-law-firm',
    integrations: {
      ...baseIntegrations,
      ...(overrides?.emailDisabled === false ? {} : { email: { provider: 'disabled' } }),
    },
    chasing: {
      ...((baseObj.chasing ?? {}) as Record<string, unknown>),
      quote: {
        enabled: overrides?.enabled ?? true,
        sendEmails: overrides?.sendEmails ?? true,
        firstChaseDays: overrides?.firstChaseDays ?? 7,
        secondChaseDays: overrides?.secondChaseDays ?? 14,
        escalateTaskDays: overrides?.escalateTaskDays ?? 21,
      },
    },
  };
  const cfg = loadAndValidateTenantConfig(
    raw,
    { tenantId: 'not-a-law-firm', environment: 'test' },
    'test',
    'single_tenant',
  );
  return { raw, cfg };
}

describe('S1-07: Quote PDFs, outbox dispatch across send flows, POA, Price Transparency, idempotency, chasing & two-tenant isolation', () => {
  afterEach(() => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
  });

  it('1. Dispatches PDF across sendQuoteEmail, save-and-send, and revise-and-send; enforces 3 MB limit & offline dispatch', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const outboxRepo = new TenantOutboxRepository();
    const chasingRepo = new TenantChasingRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();

    const { raw: disabledRaw } = makeQuoteChasingConfig({ emailDisabled: true });
    setActiveTenantConfigForTesting(disabledRaw, {});

    // 1(a). Create Draft quote, verify 3 MB guard blocks BEFORE outbox or status mutation
    const draftCreate = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Oliver Hayes',
          prospectEmail: 'oliver.hayes@example.test',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
          scope: 'Freehold house purchase in Cardiff.',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1450,
          paymentOnAccountRequired: true,
          paymentOnAccountPence: 50000,
          priceTransparencyCustomNote: 'Includes leasehold ground rent review.',
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000002',
          followUpAfterDays: 7,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(draftCreate.error).toBeUndefined();
    const draftId = draftCreate.quote!.id;

    const oversizedConverter: DocumentPdfConverter = {
      converterId: 's107-oversized-pdf',
      async convertDocxToPdf() {
        return new Uint8Array(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES + 2048);
      },
    };
    const bigSend = await runAsActionActor(
      'P-000002',
      () =>
        sendQuoteEmailRecord(
          { quoteId: draftId, idempotencyKey: 'oversize-key-1' },
          'P-000002',
          { pdfConverter: oversizedConverter },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(bigSend.ok).toBe(false);
    if (!bigSend.ok) {
      expect(bigSend.code).toBe('EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED');
    }
    expect((await intakeRepo.getQuoteById<Quote>(ctx, draftId))?.status).toBe('Draft');
    expect((await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter((r) => r.quoteId === draftId)).toHaveLength(0);

    // 1(b). Primary sendQuoteEmailAction -> valid %PDF- attachment, quote_id set, frozen priceTransparencySnapshot,
    // honest disabled queue report, and active 'quote' chase created
    const sendRes = await runAsActionActor(
      'P-000002',
      () =>
        sendQuoteEmailAction({
          quoteId: draftId,
          idempotencyKey: 'send-flow-1',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(sendRes)).toBe(false);
    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok) return;
    expect(sendRes.emailProviderDisabled).toBe(true);
    expect(sendRes.outboxRecord.quoteId).toBe(draftId);
    expect(sendRes.outboxRecord.status).toBe('pending');
    expect(sendRes.outboxRecord.attachments).toHaveLength(1);
    expect(sendRes.quote.status).toBe('Sent');
    expect(sendRes.quote.paymentOnAccountPence).toBe(50000);
    expect(sendRes.quote.priceTransparencySnapshot?.enabled).toBe(true);
    expect(sendRes.quote.priceTransparencySnapshot?.capturedAt).toBeTruthy();
    expect(sendRes.quote.priceTransparencySnapshot?.customNote).toBe(
      'Includes leasehold ground rent review.',
    );
    expect(sendRes.chase?.entityKind).toBe('quote');
    expect(sendRes.chase?.status).toBe('active');

    const storedClaim = await outboxRepo.claimDueOutboxBatch(ctx, {
      claimToken: 'test-inspect',
      limit: 50,
    });
    const sentClaimed = storedClaim.find((r) => r.id === sendRes.outboxRecord.id);
    expect(sentClaimed).toBeDefined();
    const attBytes = await outboxRepo.getClaimedOutboxAttachmentBytes(ctx, {
      outboxId: sendRes.outboxRecord.id,
      claimToken: 'test-inspect',
    });
    expect(attBytes).toHaveLength(1);
    expect(Buffer.from(attBytes[0]!.contentBytes).toString('latin1').startsWith('%PDF-')).toBe(true);

    // 1(c). Save-and-send flow (`saveQuoteAction` with markAsSent: true, sendMode: 'email')
    const saveAndSend = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'Freya Jenkins',
            prospectEmail: 'freya.jenkins@example.test',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Commercial lease review.',
            feeBasis: 'Capped fee',
            feeAmountExVat: 1800,
            paymentOnAccountRequired: true,
            paymentOnAccountGbp: 600,
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000002',
            followUpAfterDays: 7,
          },
          {
            markAsSent: true,
            sendMode: 'email',
            idempotencyKey: 'save-send-flow-1',
          },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(saveAndSend.error).toBeUndefined();
    expect(saveAndSend.outboxRecord?.quoteId).toBe(saveAndSend.quote?.id);
    expect(saveAndSend.quote?.status).toBe('Sent');
    expect(saveAndSend.chase?.entityKind).toBe('quote');
    expect(saveAndSend.chase?.status).toBe('active');

    // 1(d). Revise-and-send flow (`reviseQuoteAction` with markAsSent: true, sendMode: 'email')
    const revisedSend = await runAsActionActor(
      'P-000002',
      () =>
        reviseQuoteAction(draftId, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1650,
          paymentOnAccountRequired: true,
          paymentOnAccountPence: 75000,
          scope: 'Freehold house purchase with expedited searches.',
          revisionNote: 'Updated to v2',
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'revise-send-v2',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(revisedSend.error).toBeUndefined();
    expect(revisedSend.quote?.version).toBe(2);
    expect(revisedSend.quote?.status).toBe('Sent');
    expect(revisedSend.outboxRecord?.quoteId).toBe(draftId);
    expect(revisedSend.chase?.id).not.toBe(sendRes.chase!.id);
    const oldChaseRow = await chasingRepo.getChaseById(ctx, sendRes.chase!.id);
    expect(oldChaseRow?.status).toBe('stopped');
    expect(oldChaseRow?.stoppedReason).toBe('superseded');

    // 1(e). Offline send (`markQuoteSentOfflineAction`) creates ZERO outbox row & ZERO chase row,
    // and rejects impossible calendar dates like 2026-02-31
    const offlineDraft = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Offline Prospect',
          prospectEmail: 'offline.prospect@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Offline paper quote test.',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 950,
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000002',
          followUpAfterDays: 7,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const offlineQuoteId = offlineDraft.quote!.id;

    const badDateRes = await runAsActionActor(
      'P-000002',
      () =>
        markQuoteSentOfflineAction({
          quoteId: offlineQuoteId,
          sentDate: '2026-02-31',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(badDateRes).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    const offlineOk = await runAsActionActor(
      'P-000002',
      () =>
        markQuoteSentOfflineAction({
          quoteId: offlineQuoteId,
          sentDate: '2026-11-20',
          note: 'Posted by signed post',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(offlineOk.ok).toBe(true);
    if (!offlineOk.ok) return;
    expect(offlineOk.quote.status).toBe('Sent');
    expect(offlineOk.quote.sentAt).toBe('2026-11-20T09:00:00.000Z');
    expect(offlineOk.quote.sentToEmail).toBeNull();
    expect(offlineOk.quote.lastSentOutboxId).toBeNull();
    const offlineOutbox = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
      (r) => r.quoteId === offlineQuoteId,
    );
    expect(offlineOutbox).toHaveLength(0);
    expect(
      await chasingRepo.getActiveChaseForEntity(ctx, {
        entityKind: 'quote',
        entityId: offlineQuoteId,
      }),
    ).toBeNull();
  }, 45_000);

  it('2. /api/quotes/[id]/pdf enforces quote:view, uniform 404 on hidden draft-enquiry & restricted matters, zero CDD/AML fields, and R823 admin outbox suppression', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const partyRepo = new TenantPartyRepository();
    const { raw: disabledRaw } = makeQuoteChasingConfig({ emailDisabled: true });
    setActiveTenantConfigForTesting(disabledRaw, {});

    const allPeople = await partyRepo.listAllPeople<Person>(ctx);
    const financeUser = allPeople.find((p) => p.employeeRoleId === 'employee_role.finance');
    expect(financeUser).toBeDefined();

    // Pure admin (lacks matter:restricted:access and didn't create draft enquiry)
    const baseEmp = (await partyRepo.getPersonById<Person>(ctx, 'P-000004'))!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S107-ADMIN',
      firstName: 'Tamsin',
      surname: 'AdminS107',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      entraObjectId: undefined,
      emails: [{ id: 'em-s107-admin', address: 's107-admin@example.test', isPrimary: true, typeId: null }],
    };
    const otherFeeEarner: Person = {
      ...baseEmp,
      id: 'P-S107-FE2',
      firstName: 'Bethan',
      surname: 'OtherFe',
      employeeRoleId: 'employee_role.fee_earner',
      roles: ['fee_earner'],
      appRole: 'fee_earner',
      entraObjectId: undefined,
      emails: [{ id: 'em-s107-fe2', address: 's107-fe2@example.test', isPrimary: true, typeId: null }],
    };
    await partyRepo.putPeople(ctx, [pureAdmin, otherFeeEarner]);

    // Visible quote created & sent by P-000002
    const visibleSend = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'Visible Quote Client',
            prospectEmail: 'visible-quote@example.test',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Visible corporate advice.',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1200,
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000002',
            followUpAfterDays: 7,
          },
          { markAsSent: true, sendMode: 'email', idempotencyKey: 'r823-vis-1' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const visibleQuoteId = visibleSend.quote!.id;
    const visibleOutboxId = visibleSend.outboxRecord!.id;

    // Hidden quote linked to a Draft enquiry created by P-000002
    const draftEnqRes = await runAsActionActor(
      'P-000002',
      () =>
        saveEnquiryAction(
          {
            firstName: 'DraftEnq',
            lastName: 'HiddenClient',
            email: 'draft-enq@example.test',
            channelId: 'enquiry_channel.email',
            practiceAreaId: 'work_type.corporate_and_commercial',
            summary: 'Private draft enquiry',
            notes: 'Draft only',
            urgencyId: 'urgency.standard',
            takenById: 'P-000002',
          } as Partial<Enquiry>,
          { asDraft: true },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const hiddenDraftEnqQuote = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'DraftEnq HiddenClient',
            prospectEmail: 'draft-enq@example.test',
            linkedEnquiryId: draftEnqRes.enquiry!.id,
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Draft-enquiry linked quote.',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 900,
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000002',
            followUpAfterDays: 7,
          },
          { markAsSent: true, sendMode: 'email', idempotencyKey: 'r823-draft-enq' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const hiddenQuoteId = hiddenDraftEnqQuote.quote!.id;
    const hiddenOutboxId = hiddenDraftEnqQuote.outboxRecord!.id;

    // Restricted Staff matter converted from a quote (restricted to P-000004 only)
    const restrictedQuote = await runAsActionActor(
      'P-000004',
      () =>
        saveQuoteAction(
          {
            clientType: 'existing',
            linkedOrganisationId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Confidential staff matter quote.',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1500,
            validUntil: '2026-12-31',
            feeEarnerId: 'P-000004',
            followUpAfterDays: 7,
          },
          { markAsSent: true, sendMode: 'email', idempotencyKey: 'r823-staff-1' },
        ),
      { roles: ['partner'], mfaVerified: true },
    );
    const restrictedQuoteId = restrictedQuote.quote!.id;
    const restrictedOutboxId = restrictedQuote.outboxRecord!.id;
    const convRestricted = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterRecord(
          {
            title: 'Restricted Staff Quote Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000004',
            supervisingPartnerId: 'P-000004',
            leadFeeEarnerId: 'P-000004',
            teamMemberIds: ['P-000004'],
            sourceQuoteId: restrictedQuoteId,
            isStaffMatter: true,
            restrictedAccessUserIds: ['P-000004'],
            conflictCheckRecord: makeConflictRecord('P-000004', 'Gareth Davies'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        ),
      { roles: ['partner'], mfaVerified: true },
    );
    expect(convRestricted.matter?.sourceQuoteId).toBe(restrictedQuoteId);
    const matterRepo = new TenantMatterRepository();
    await matterRepo.putMatter(
      ctx,
      {
        ...convRestricted.matter!,
        hasEthicalWall: true,
        restrictedAccessUserIds: ['P-000004'],
      },
      {
        expectedRowVersion: null,
        sqlRestrictedAccessUserIds: ['P-000004'],
      },
    );

    // PDF route: permitted viewer gets 200 %PDF- with no CDD/AML leakage
    const okPdf = await runAsActionActor(
      'P-000002',
      () =>
        quotePdfRoute.GET(
          new Request(`http://localhost/api/quotes/${encodeURIComponent(visibleQuoteId)}/pdf`) as never,
          { params: Promise.resolve({ id: visibleQuoteId }) } as never,
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(okPdf.status).toBe(200);
    expect(okPdf.headers.get('content-type')).toBe('application/pdf');
    const okBytes = new Uint8Array(await okPdf.arrayBuffer());
    expect(Buffer.from(okBytes).toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(JSON.stringify(Object.fromEntries(okPdf.headers.entries()))).not.toMatch(/amlStatus|clientCddStatus/);

    // Finance lacks quote:view -> 403
    const finPdf = await runAsActionActor(
      financeUser!.id,
      () =>
        quotePdfRoute.GET(
          new Request(`http://localhost/api/quotes/${encodeURIComponent(visibleQuoteId)}/pdf`) as never,
          { params: Promise.resolve({ id: visibleQuoteId }) } as never,
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finPdf.status).toBe(403);

    // Other fee earner gets uniform 404 for hidden Draft-enquiry quote, restricted converted matter quote, AND missing quote
    const [feDraftRes, feRestrRes, feMissingRes] = await runAsActionActor(
      otherFeeEarner.id,
      () =>
        Promise.all([
          quotePdfRoute.GET(
            new Request(`http://localhost/api/quotes/${encodeURIComponent(hiddenQuoteId)}/pdf`) as never,
            { params: Promise.resolve({ id: hiddenQuoteId }) } as never,
          ),
          quotePdfRoute.GET(
            new Request(`http://localhost/api/quotes/${encodeURIComponent(restrictedQuoteId)}/pdf`) as never,
            { params: Promise.resolve({ id: restrictedQuoteId }) } as never,
          ),
          quotePdfRoute.GET(
            new Request('http://localhost/api/quotes/Q-9999-999/pdf') as never,
            { params: Promise.resolve({ id: 'Q-9999-999' }) } as never,
          ),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(feDraftRes.status).toBe(404);
    expect(feRestrRes.status).toBe(404);
    expect(feMissingRes.status).toBe(404);
    const missingText = await feMissingRes.text();
    expect(await feDraftRes.text()).toBe(missingText);
    expect(await feRestrRes.text()).toBe(missingText);

    // Admin Outbox R823 visibility: pureAdmin sees visibleOutboxId, NEVER hidden or restricted
    const adminList = await runAsActionActor(
      pureAdmin.id,
      () => listOutboxMessagesForAdminAction({ limit: 100 }),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminList.ok).toBe(true);
    if (!adminList.ok) return;
    const listedIds = adminList.messages.map((m) => m.id);
    expect(listedIds).toContain(visibleOutboxId);
    expect(listedIds).not.toContain(hiddenOutboxId);
    expect(listedIds).not.toContain(restrictedOutboxId);

    const [openHidden, openRestricted] = await runAsActionActor(
      pureAdmin.id,
      () =>
        Promise.all([
          getOutboxMessageForAdminAction({ outboxId: hiddenOutboxId }),
          getOutboxMessageForAdminAction({ outboxId: restrictedOutboxId }),
        ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(openHidden).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(openRestricted).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  }, 45_000);

  it('3. Enforces send idempotency under concurrent Promise.all calls on both sendQuoteEmailAction and saveQuoteAction', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const outboxRepo = new TenantOutboxRepository();
    const chasingRepo = new TenantChasingRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();
    const { raw: disabledRaw } = makeQuoteChasingConfig({ emailDisabled: true });
    setActiveTenantConfigForTesting(disabledRaw, {});

    // 3(a). Concurrent sendQuoteEmailAction on an existing Draft
    const qRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Race Test Client',
          prospectEmail: 'race-send@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Idempotency race check.',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1100,
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000002',
          followUpAfterDays: 7,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const quoteId = qRes.quote!.id;
    const fixedKey = 'idemp-concurrent-send-1';

    const [r1, r2] = await runAsActionActor(
      'P-000002',
      () =>
        Promise.all([
          sendQuoteEmailAction({ quoteId, idempotencyKey: fixedKey }),
          sendQuoteEmailAction({ quoteId, idempotencyKey: fixedKey }),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.outboxRecord.id).toBe(r2.outboxRecord.id);

    const outboxes = (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
      (o) => o.quoteId === quoteId,
    );
    expect(outboxes).toHaveLength(1);
    const chases = await chasingRepo.listChasesForEntity(ctx, {
      entityKind: 'quote',
      entityId: quoteId,
    });
    expect(chases).toHaveLength(1);
    const savedQuote = (await intakeRepo.getQuoteById<Quote>(ctx, quoteId))!;
    expect(savedQuote.timeline.filter((t) => t.kind === 'sent')).toHaveLength(1);
    const audits = await auditEntriesForRecord('quote', quoteId);
    expect(audits.filter((a) => a.field === 'Quote sent')).toHaveLength(1);

    // 3(b). Concurrent saveQuoteAction(..., { markAsSent: true, sendMode: 'email', idempotencyKey })
    const saveKey = 'idemp-concurrent-save-send-1';
    const [s1, s2] = await runAsActionActor(
      'P-000002',
      () =>
        Promise.all([
          saveQuoteAction(
            {
              clientType: 'prospect',
              prospectName: 'Concurrent Create Send',
              prospectEmail: 'concurrent-create@example.test',
              practiceAreaId: 'work_type.corporate_and_commercial',
              scope: 'Create + send concurrency check.',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1250,
              validUntil: '2026-12-31',
              feeEarnerId: 'P-000002',
              followUpAfterDays: 7,
            },
            { markAsSent: true, sendMode: 'email', idempotencyKey: saveKey },
          ),
          saveQuoteAction(
            {
              clientType: 'prospect',
              prospectName: 'Concurrent Create Send',
              prospectEmail: 'concurrent-create@example.test',
              practiceAreaId: 'work_type.corporate_and_commercial',
              scope: 'Create + send concurrency check.',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1250,
              validUntil: '2026-12-31',
              feeEarnerId: 'P-000002',
              followUpAfterDays: 7,
            },
            { markAsSent: true, sendMode: 'email', idempotencyKey: saveKey },
          ),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(s1.quote?.id).toBeTruthy();
    expect(s1.quote?.id).toBe(s2.quote?.id);
    expect(s1.outboxRecord?.id).toBe(s2.outboxRecord?.id);
    const createdQuoteId = s1.quote!.id;
    expect(
      (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
        (o) => o.quoteId === createdQuoteId,
      ),
    ).toHaveLength(1);
    expect(
      await chasingRepo.listChasesForEntity(ctx, {
        entityKind: 'quote',
        entityId: createdQuoteId,
      }),
    ).toHaveLength(1);
  }, 45_000);

  it('4. Chases at Day 7/14/21, stops immediately in-TX on Accepted/Conversion/Declined/Expired/Superseded, supports R818 re-send, and never chases pre-WP3 Sent quotes', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const outboxRepo = new TenantOutboxRepository();
    const chasingRepo = new TenantChasingRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();
    const taskRepo = new TenantTaskWorkflowRepository();

    const { raw: chaseRaw, cfg: chaseCfg } = makeQuoteChasingConfig({
      enabled: true,
      sendEmails: true,
      firstChaseDays: 7,
      secondChaseDays: 14,
      escalateTaskDays: 21,
      emailDisabled: true,
    });
    setActiveTenantConfigForTesting(chaseRaw, {});

    await runAsActionActor(
      'P-000004',
      () => saveChasingConfigAction(chaseCfg.chasing ?? {}, 'Enable S1-07 quote chasing test'),
      { roles: ['admin'], mfaVerified: true },
    );

    // 4(a). Legacy pre-WP3 Sent quote with NO chase row is never chased retrospectively
    const preWp3Res = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction({
          clientType: 'prospect',
          prospectName: 'Pre WP3 Client',
          prospectEmail: 'pre-wp3@example.test',
          practiceAreaId: 'work_type.corporate_and_commercial',
          scope: 'Legacy sent quote',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 800,
          validUntil: '2026-12-31',
          feeEarnerId: 'P-000002',
          followUpAfterDays: 7,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const preWp3Quote = (await intakeRepo.getQuoteById<Quote>(ctx, preWp3Res.quote!.id))!;
    preWp3Quote.status = 'Sent';
    preWp3Quote.sentAt = new Date('2026-01-01T10:00:00.000Z').toISOString();
    await intakeRepo.putQuote(ctx, preWp3Quote);

    // 4(b). Full Day 7 -> Day 14 -> Day 21 lifecycle
    const sendA = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(
          {
            clientType: 'prospect',
            prospectName: 'Chase Schedule Client',
            prospectEmail: 'chase-schedule@example.test',
            practiceAreaId: 'work_type.corporate_and_commercial',
            scope: 'Day 7/14/21 chase schedule',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1500,
            validUntil: '2027-06-30',
            feeEarnerId: 'P-000002',
            followUpAfterDays: 7,
          },
          { markAsSent: true, sendMode: 'email', idempotencyKey: 'chase-sched-1' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const qChaseId = sendA.chase!.id;
    const qId = sendA.quote!.id;
    const sentDateA = new Date(sendA.chase!.sentAt);

    // Day +6 -> nothing
    const d6 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(sentDateA, 6),
    });
    expect(d6.outcome).toBe('executed');
    if (d6.outcome === 'executed') {
      expect(d6.result.summary.dueEvaluated).toBe(0);
    }

    // Day +7 -> Step 1 email + quote timeline follow_up
    const d7 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(sentDateA, 7),
    });
    expect(d7.outcome).toBe('executed');
    if (d7.outcome === 'executed') {
      expect(d7.result.summary.emailsQueuedCount).toBe(1);
    }
    const step1Outbox = await outboxRepo.getOutboxRecordByIdempotencyKey(
      ctx,
      `chase:${qChaseId}:step:1`,
    );
    expect(step1Outbox?.quoteId).toBe(qId);
    expect(step1Outbox?.templateKey).toBe('communication.chase.quote.step1');
    const qAfterD7 = (await intakeRepo.getQuoteById<Quote>(ctx, qId))!;
    expect(qAfterD7.timeline.some((t) => t.kind === 'follow_up')).toBe(true);

    // Day +14 -> Step 2 email
    const d14 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(sentDateA, 14),
    });
    expect(d14.outcome).toBe('executed');
    if (d14.outcome === 'executed') {
      expect(d14.result.summary.emailsQueuedCount).toBe(1);
    }
    const step2Outbox = await outboxRepo.getOutboxRecordByIdempotencyKey(
      ctx,
      `chase:${qChaseId}:step:2`,
    );
    expect(step2Outbox?.templateKey).toBe('communication.chase.quote.step2');

    // Day +21 -> fee-earner escalation task + completed
    const d21 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(sentDateA, 21),
    });
    expect(d21.outcome).toBe('executed');
    if (d21.outcome === 'executed') {
      expect(d21.result.summary.tasksCreatedCount).toBe(1);
    }
    expect((await chasingRepo.getChaseById(ctx, qChaseId))?.status).toBe('completed');
    const allTasks = await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'quote', qId);
    expect(
      allTasks.some(
        (t) =>
          t.autoTrigger === 'communication_chase_escalation' &&
          t.linkedRecords?.some((lr) => lr.recordType === 'quote' && lr.recordId === qId),
      ),
    ).toBe(true);

    // Verify pre-WP3 quote STILL has zero outboxes & zero chases
    expect(
      (await outboxRepo.listOutboxRecords(ctx, { limit: 100 })).filter(
        (r) => r.quoteId === preWp3Quote.id,
      ),
    ).toHaveLength(0);
    expect(
      await chasingRepo.listChasesForEntity(ctx, {
        entityKind: 'quote',
        entityId: preWp3Quote.id,
      }),
    ).toHaveLength(0);

    // 4(c). R818 revise -> re-send on SAME quoteId issues fresh chaseId & queues step 1 without collision
    await runAsActionActor(
      'P-000002',
      () =>
        reviseQuoteAction(qId, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1700,
          scope: 'Revised quote v2 for R818',
          revisionNote: 'R818 revision',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const resendV2 = await runAsActionActor(
      'P-000002',
      () => sendQuoteEmailAction({ quoteId: qId, idempotencyKey: 'r818-v2-send' }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(resendV2.ok).toBe(true);
    if (!resendV2.ok) return;
    const v2ChaseId = resendV2.chase!.id;
    expect(v2ChaseId).not.toBe(qChaseId);
    const v2D7 = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(new Date(resendV2.chase!.sentAt), 7),
    });
    expect(v2D7.outcome).toBe('executed');
    expect(
      await outboxRepo.getOutboxRecordByIdempotencyKey(ctx, `chase:${v2ChaseId}:step:1`),
    ).not.toBeNull();

    // Stop transitions helper
    const makeAndSendQuote = async (label: string, validUntil = '2027-06-30') => {
      const r = await runAsActionActor(
        'P-000002',
        () =>
          saveQuoteAction(
            {
              clientType: 'prospect',
              prospectName: `Stop ${label}`,
              prospectEmail: `${label.toLowerCase()}@example.test`,
              practiceAreaId: 'work_type.corporate_and_commercial',
              scope: `Stop test ${label}`,
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1000,
              validUntil,
              feeEarnerId: 'P-000002',
              followUpAfterDays: 7,
            },
            { markAsSent: true, sendMode: 'email', idempotencyKey: `stop-${label}` },
          ),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      return { quoteId: r.quote!.id, chaseId: r.chase!.id };
    };

    // Stop 1: Accepted via recordQuoteOutcomeAction -> stopped ('accepted')
    const accTarget = await makeAndSendQuote('Accept');
    await runAsActionActor(
      'P-000002',
      () => recordQuoteOutcomeAction(accTarget.quoteId, { outcome: 'Accepted', note: 'Client signed off' }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const accChase = (await chasingRepo.getChaseById(ctx, accTarget.chaseId))!;
    expect(accChase.status).toBe('stopped');
    expect(accChase.stoppedReason).toBe('accepted');
    const accAudits = await auditEntriesForRecord('communication_chase', accTarget.chaseId);
    expect(accAudits.some((a) => a.oldValue === 'active' && a.newValue?.includes('accepted'))).toBe(true);

    // Stop 2: Declined -> stopped ('declined')
    const decTarget = await makeAndSendQuote('Decline');
    await runAsActionActor(
      'P-000002',
      () =>
        recordQuoteOutcomeAction(decTarget.quoteId, {
          outcome: 'Declined',
          declineReason: 'Price',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect((await chasingRepo.getChaseById(ctx, decTarget.chaseId))?.stoppedReason).toBe('declined');

    // Stop 3: Superseded via reviseQuoteAction -> stopped ('superseded')
    const supTarget = await makeAndSendQuote('Supersede');
    await runAsActionActor(
      'P-000002',
      () =>
        reviseQuoteAction(supTarget.quoteId, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 1150,
          scope: 'Superseded by v2',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect((await chasingRepo.getChaseById(ctx, supTarget.chaseId))?.stoppedReason).toBe('superseded');

    // Stop 4: Conversion via prepareQuoteConversionRecord + saveMatterRecord -> stopped ('accepted')
    const convTarget = await makeAndSendQuote('Convert');
    const convPrep = await runAsActionActor(
      'P-000002',
      () => prepareQuoteConversionRecord(convTarget.quoteId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(convPrep.clientId).toBeTruthy();
    await runAsActionActor(
      'P-000002',
      () =>
        saveMatterRecord(
          {
            title: 'Converted Stop Chase Matter',
            clientId: convPrep.clientId!,
            instructingContactId: convPrep.instructingContactId!,
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            sourceQuoteId: convTarget.quoteId,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'draft' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect((await chasingRepo.getChaseById(ctx, convTarget.chaseId))?.stoppedReason).toBe('accepted');

    // Stop 5: Expired via executeQuoteExpiryForTenant -> stopped ('expired')
    const expTarget = await makeAndSendQuote('Expire', '2026-01-10');
    await executeQuoteExpiryForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:quote-expiry',
      tenantConfig: chaseCfg,
    });
    expect((await chasingRepo.getChaseById(ctx, expTarget.chaseId))?.stoppedReason).toBe('expired');

    // Stop 5(b): Lazy expiry check inside QUOTE_CHASE_ADAPTER.checkStop (without running quote-expiry job first)
    const expLazyTarget = await makeAndSendQuote('ExpireLazy', '2026-01-10');
    const expLazyRun = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(new Date(), 8),
    });
    expect(expLazyRun.outcome).toBe('executed');
    if (expLazyRun.outcome === 'executed') {
      expect(expLazyRun.result.summary.emailsQueuedCount).toBe(0);
    }
    const expLazyChase = await chasingRepo.getChaseById(ctx, expLazyTarget.chaseId);
    expect(expLazyChase?.status).toBe('stopped');
    expect(expLazyChase?.stoppedReason).toBe('expired');

    // Stop 6: Manual stop via stopCommunicationChaseAction on v2ChaseId -> stopped ('manual')
    const manualStop = await runAsActionActor(
      'P-000002',
      () => stopCommunicationChaseAction({ chaseId: v2ChaseId }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(manualStop.ok).toBe(true);
    expect((await chasingRepo.getChaseById(ctx, v2ChaseId))?.stoppedReason).toBe('manual_stop');
  }, 45_000);

  it('5. WorkTypes Price Transparency config requires MFA, freezes snapshots across edits, and enforces two-tenant isolation + TENANCY_FORGERY_DETECTED', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolManager = new TenantPostgresPoolManager();
    const runner = new TenantMigrationRunner();
    const { raw: baseRaw } = makeQuoteChasingConfig({ emailDisabled: true });
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

      // WorkTypes MFA check & Price Transparency save in Alpha
      setActiveTenantConfigForTesting(alphaRaw, {});
      const effectiveAlpha = resolveEffectiveWorkTypesConfig(alphaCfg, null);
      const alphaBespokePt = {
        enabled: true,
        headlineSummary: 'Alpha bespoke Price Transparency headline.',
        serviceDescription: 'Alpha bespoke scope wording.',
        keyStages: 'Stage 1 -> Stage 2',
        typicalTimescales: '6 weeks',
        disbursementsGuidance: 'At cost',
        exclusionsAndVatNote: 'Plus 20% VAT',
      };
      const updatedWorkTypes: WorkTypesConfiguration = {
        ...effectiveAlpha,
        defaults: {
          ...effectiveAlpha.defaults,
          priceTransparency: alphaBespokePt,
        },
        items: effectiveAlpha.items.map((item) =>
          item.workTypeId === 'work_type.corporate_and_commercial'
            ? { ...item, priceTransparency: alphaBespokePt }
            : item,
        ),
      };

      const noMfaSave = await runAsActionActor(
        'P-000001',
        () => saveWorkTypesConfigAction(updatedWorkTypes, 'No MFA update'),
        { tenantId: 'tenant-alpha', roles: ['admin'], mfaVerified: false },
      );
      expect(noMfaSave).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });

      const mfaSave = await runAsActionActor(
        'P-000001',
        () => saveWorkTypesConfigAction(updatedWorkTypes, 'Set Alpha Price Transparency'),
        { tenantId: 'tenant-alpha', roles: ['admin', 'partner'], mfaVerified: true },
      );
      expect(mfaSave.ok).toBe(true);
      const catAlpha = new TenantCatalogueRepository();
      const persistedWt = await catAlpha.getWorkTypeConfigs<WorkTypesConfiguration>(ctxAlpha);
      expect(persistedWt?.defaults.priceTransparency?.headlineSummary).toBe(
        'Alpha bespoke Price Transparency headline.',
      );

      // Send Alpha quote -> snapshot captures Alpha bespoke text even if config changes later
      const alphaSend = await runAsActionActor(
        'P-000001',
        () =>
          saveQuoteAction(
            {
              clientType: 'prospect',
              prospectName: 'Alpha PT Client',
              prospectEmail: 'alpha-pt@example.test',
              practiceAreaId: 'work_type.corporate_and_commercial',
              scope: 'Alpha commercial advice.',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1400,
              validUntil: '2026-12-31',
              feeEarnerId: 'P-000001',
              followUpAfterDays: 7,
            },
            { markAsSent: true, sendMode: 'email', idempotencyKey: 'alpha-pt-1' },
          ),
        { tenantId: 'tenant-alpha', roles: ['partner', 'admin'], mfaVerified: true },
      );
      const alphaQuoteId = alphaSend.quote!.id;
      expect(alphaSend.quote?.priceTransparencySnapshot?.headlineSummary).toBe(
        'Alpha bespoke Price Transparency headline.',
      );

      // Mutate Alpha Price Transparency afterwards -> sent quote snapshot remains immutable
      await runAsActionActor(
        'P-000001',
        () =>
          saveWorkTypesConfigAction(
            {
              ...updatedWorkTypes,
              defaults: {
                ...updatedWorkTypes.defaults,
                priceTransparency: {
                  ...updatedWorkTypes.defaults.priceTransparency!,
                  headlineSummary: 'Later mutated headline',
                },
              },
              items: updatedWorkTypes.items.map((item) =>
                item.workTypeId === 'work_type.corporate_and_commercial'
                  ? {
                      ...item,
                      priceTransparency: {
                        ...alphaBespokePt,
                        headlineSummary: 'Later mutated headline',
                      },
                    }
                  : item,
              ),
            },
            'Later headline update',
          ),
        { tenantId: 'tenant-alpha', roles: ['partner', 'admin'], mfaVerified: true },
      );
      const alphaQuoteAfter = await new TenantIntakeQuoteRepository().getQuoteById<Quote>(
        ctxAlpha,
        alphaQuoteId,
      );
      expect(alphaQuoteAfter?.priceTransparencySnapshot?.headlineSummary).toBe(
        'Alpha bespoke Price Transparency headline.',
      );

      // Bravo cannot access Alpha's quote PDF -> 404
      setActiveTenantConfigForTesting(bravoRaw, {});
      const bravoCrossPdf = await runAsActionActor(
        'P-000001',
        () =>
          quotePdfRoute.GET(
            new Request(`http://localhost/api/quotes/${encodeURIComponent(alphaQuoteId)}/pdf`) as never,
            { params: Promise.resolve({ id: alphaQuoteId }) } as never,
          ),
        { tenantId: 'tenant-bravo', roles: ['partner', 'admin'], mfaVerified: true },
      );
      expect(bravoCrossPdf.status).toBe(404);

      // Forged tenant-bravo claim against active not-a-law-firm session throws TENANCY_FORGERY_DETECTED
      setActiveTenantConfigForTesting(baseRaw, {});
      const expectForged = async (fn: () => Promise<unknown>) => {
        await expect(
          runAsActionActor('P-000001', fn, {
            tenantId: 'tenant-bravo',
            roles: ['partner', 'admin'],
            mfaVerified: true,
          }),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      };
      await expectForged(() => sendQuoteEmailAction({ quoteId: alphaQuoteId }));
      await expectForged(() => markQuoteSentOfflineAction({ quoteId: alphaQuoteId }));
      await expectForged(() =>
        quotePdfRoute.GET(
          new Request(`http://localhost/api/quotes/${encodeURIComponent(alphaQuoteId)}/pdf`) as never,
          { params: Promise.resolve({ id: alphaQuoteId }) } as never,
        ),
      );
      await expectForged(() =>
        reviseQuoteAction(alphaQuoteId, {
          feeBasis: 'Fixed fee',
          feeAmountExVat: 999,
          scope: 'Forged revise',
        }),
      );
      await expectForged(() => saveWorkTypesConfigAction(updatedWorkTypes, 'Forged save'));
      await expectForged(() =>
        recordQuoteOutcomeAction(alphaQuoteId, { outcome: 'Accepted' }),
      );
    } finally {
      setTestActorSession(null);
      setActiveTenantConfigForTesting(null);
      await poolManager.closeAllPools();
    }
  }, 45_000);

  it('6. Review hardening (R855, R856, R858-R861): terminal/converted/version locks, PDF race conflict, chase stop on save/followUp Expired & offline save, restricted enquiry escalation visibility, pence priority & locked outcome', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const intakeRepo = new TenantIntakeQuoteRepository();
    const outboxRepo = new TenantOutboxRepository();
    const chasingRepo = new TenantChasingRepository();
    const taskRepo = new TenantTaskWorkflowRepository();
    const matterRepo = new TenantMatterRepository();
    const hrRepo = new TenantHrAndRbacRepository();
    const { raw: chaseRaw, cfg: chaseCfg } = makeQuoteChasingConfig({
      enabled: true,
      sendEmails: true,
      firstChaseDays: 7,
      secondChaseDays: 14,
      escalateTaskDays: 21,
      emailDisabled: true,
    });
    setActiveTenantConfigForTesting(chaseRaw, {});

    await runAsActionActor(
      'P-000004',
      () => saveChasingConfigAction(chaseCfg.chasing ?? {}, 'R855-R861 test chase config'),
      { roles: ['admin'], mfaVerified: true },
    );

    const baseQuoteInput = (label: string, validUntil = '2027-06-30') => ({
      clientType: 'prospect' as const,
      prospectName: `Hardening ${label}`,
      prospectEmail: `hardening-${label.toLowerCase()}@example.test`,
      practiceAreaId: 'work_type.corporate_and_commercial',
      scope: `Scope for ${label}`,
      feeBasis: 'Fixed fee' as const,
      feeAmountExVat: 1200,
      validUntil,
      feeEarnerId: 'P-000002',
      followUpAfterDays: 7,
    });

    // R855: Accepted, Converted, Declined, Expired, and Superseded quotes refuse saveQuoteAction & reviseQuoteAction
    const accRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R855Acc'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r855-acc',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const accQuoteId = accRes.quote!.id;
    await runAsActionActor(
      'P-000002',
      () => recordQuoteOutcomeAction(accQuoteId, { outcome: 'Accepted' }),
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const decRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R855Dec'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r855-dec',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const decQuoteId = decRes.quote!.id;
    await runAsActionActor(
      'P-000002',
      () =>
        recordQuoteOutcomeAction(decQuoteId, {
          outcome: 'Declined',
          declineReason: 'Price',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );

    const expRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R855Exp', '2026-01-10'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r855-exp',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const expQuoteId = expRes.quote!.id;
    await executeQuoteExpiryForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:quote-expiry',
      tenantConfig: chaseCfg,
    });

    const supRes = await runAsActionActor(
      'P-000002',
      () => saveQuoteAction(baseQuoteInput('R855Sup')),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const supQuoteId = supRes.quote!.id;
    const supQuoteObj = (await intakeRepo.getQuoteById<Quote>(ctx, supQuoteId))!;
    supQuoteObj.status = 'Superseded';
    await intakeRepo.putQuote(ctx, supQuoteObj);

    const convRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R855Conv'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r855-conv',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const convQuoteId = convRes.quote!.id;
    const convPrep = await runAsActionActor(
      'P-000002',
      () => prepareQuoteConversionRecord(convQuoteId, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    await runAsActionActor(
      'P-000002',
      () =>
        saveMatterRecord(
          {
            title: 'R855 Converted Quote Matter',
            clientId: convPrep.clientId!,
            instructingContactId: convPrep.instructingContactId!,
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            teamMemberIds: ['P-000001', 'P-000002'],
            sourceQuoteId: convQuoteId,
            conflictCheckRecord: makeConflictRecord('P-000002', 'Dafydd Evans'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000002', saveMode: 'draft' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );

    for (const [label, qId, expectedStatus] of [
      ['Accepted', accQuoteId, 'Accepted'],
      ['Declined', decQuoteId, 'Declined'],
      ['Expired', expQuoteId, 'Expired'],
      ['Superseded', supQuoteId, 'Superseded'],
      ['Converted', convQuoteId, 'Accepted'],
    ] as const) {
      const outboxBefore = (await outboxRepo.listOutboxRecords(ctx, { limit: 200 })).filter(
        (r) => r.quoteId === qId,
      ).length;

      const emailSaveRes = await runAsActionActor(
        'P-000002',
        () =>
          saveQuoteAction(baseQuoteInput(`BlockedEmail${label}`), {
            id: qId,
            markAsSent: true,
            sendMode: 'email',
            idempotencyKey: `r855-blk-email-${label}`,
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(emailSaveRes.code, `${label} save email`).toBe('VALIDATION_ERROR');

      const offlineSaveRes = await runAsActionActor(
        'P-000002',
        () =>
          saveQuoteAction(baseQuoteInput(`BlockedOff${label}`), {
            id: qId,
            markAsSent: true,
            sendMode: 'offline',
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(offlineSaveRes.code, `${label} save offline`).toBe('VALIDATION_ERROR');

      const revRes = await runAsActionActor(
        'P-000002',
        () =>
          reviseQuoteAction(qId, {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 9999,
            scope: 'Blocked revise',
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
      expect(revRes.code, `${label} revise`).toBe('VALIDATION_ERROR');

      const afterQ = (await intakeRepo.getQuoteById<Quote>(ctx, qId))!;
      expect(afterQ.status).toBe(expectedStatus);
      const outboxAfter = (await outboxRepo.listOutboxRecords(ctx, { limit: 200 })).filter(
        (r) => r.quoteId === qId,
      ).length;
      expect(outboxAfter).toBe(outboxBefore);
      expect(
        await chasingRepo.getActiveChaseForEntity(ctx, {
          entityKind: 'quote',
          entityId: qId,
        }),
      ).toBeNull();
    }

    // R855 version/updatedAt conflict on concurrent reviseQuoteAction calls
    const revTarget = (
      await runAsActionActor(
        'P-000002',
        () => saveQuoteAction(baseQuoteInput('RevConflict')),
        { roles: ['fee_earner'], mfaVerified: false },
      )
    ).quote!;
    const [revA, revB] = await runAsActionActor(
      'P-000002',
      () =>
        Promise.all([
          reviseQuoteAction(revTarget.id, {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1500,
            scope: 'Concurrent rev A',
          }),
          reviseQuoteAction(revTarget.id, {
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1600,
            scope: 'Concurrent rev B',
          }),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const revOutcomes = [revA, revB];
    expect(revOutcomes.some((r) => Boolean(r.quote) && r.quote?.version === 2)).toBe(true);
    expect(revOutcomes.some((r) => !r.quote && r.code === 'CONFLICT')).toBe(true);

    // R858: Concurrent edit between PDF render and TX commit in sendQuoteEmailRecord -> CONFLICT + 0 outboxes
    const r858Draft = (
      await runAsActionActor(
        'P-000002',
        () => saveQuoteAction(baseQuoteInput('R858Race')),
        { roles: ['fee_earner'], mfaVerified: false },
      )
    ).quote!;
    const r858Converter: DocumentPdfConverter = {
      converterId: 'r858-race-converter',
      async convertDocxToPdf() {
        await saveQuoteAction(
          {
            ...baseQuoteInput('R858RaceEdited'),
            feeAmountExVat: 8888,
            scope: 'Mutated right before send TX',
          },
          { id: r858Draft.id },
        );
        return Buffer.from('%PDF-1.4\n% stale PDF bytes\n%%EOF\n');
      },
    };
    const r858Res = await runAsActionActor(
      'P-000002',
      () =>
        sendQuoteEmailRecord(
          { quoteId: r858Draft.id, idempotencyKey: 'r858-conflict-check' },
          'P-000002',
          { pdfConverter: r858Converter, drainAfterCommit: false },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r858Res.ok).toBe(false);
    if (!r858Res.ok) {
      expect(r858Res.code).toBe('CONFLICT');
    }
    expect(
      (await outboxRepo.listOutboxRecords(ctx, { limit: 200 })).filter(
        (r) => r.quoteId === r858Draft.id,
      ),
    ).toHaveLength(0);

    // R859(a): Updating validUntil into the past on an open Sent quote transitions it to Expired & stops chase in the same TX
    const r859PlainRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859Plain', '2027-06-30'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r859-plain',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r859PlainRes.chase?.status).toBe('active');
    const r859PlainSaved = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859PlainUpdated', '2026-01-10'), {
          id: r859PlainRes.quote!.id,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r859PlainSaved.quote?.status).toBe('Expired');
    expect((await chasingRepo.getChaseById(ctx, r859PlainRes.chase!.id))?.stoppedReason).toBe(
      'expired',
    );
    // Subsequent edit on the now-Expired quote refuses cleanly (R855)
    const r855AlreadyExpEdit = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859PlainBlockedAgain', '2027-06-30'), {
          id: r859PlainRes.quote!.id,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r855AlreadyExpEdit.code).toBe('VALIDATION_ERROR');

    // R859(b): logQuoteFollowUpAction on an Expired-by-date Sent quote stops its active chase in the same TX
    const r859FuRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859Fu', '2026-01-10'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r859-fu',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const r859FuLogged = await runAsActionActor(
      'P-000002',
      () =>
        logQuoteFollowUpAction(r859FuRes.quote!.id, {
          method: 'Phone',
          note: 'Client confirmed quote expired',
          nextFollowUpDate: null,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r859FuLogged.quote?.status).toBe('Expired');
    expect((await chasingRepo.getChaseById(ctx, r859FuRes.chase!.id))?.stoppedReason).toBe(
      'expired',
    );

    // R859(c): Offline save on an already-emailed Sent quote stops email chase with 'superseded'
    const r859OffRes = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859OfflineSave'), {
          markAsSent: true,
          sendMode: 'email',
          idempotencyKey: 'r859-off-save',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(r859OffRes.chase?.status).toBe('active');
    await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(baseQuoteInput('R859OfflineSave'), {
          id: r859OffRes.quote!.id,
          markAsSent: true,
          sendMode: 'offline',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect((await chasingRepo.getChaseById(ctx, r859OffRes.chase!.id))?.stoppedReason).toBe(
      'superseded',
    );

    // R860: upsertQuoteInTx uses paymentOnAccountPence as authoritative over paymentOnAccountGbp
    const qPoaAuthoritative = (
      await runAsActionActor(
        'P-000002',
        () => saveQuoteAction(baseQuoteInput('R860PenceWins')),
        { roles: ['fee_earner'], mfaVerified: false },
      )
    ).quote!;
    await intakeRepo.withTenantTransaction(ctx, async (tx) => {
      await intakeRepo.upsertQuoteInTx(tx, ctx, {
        ...qPoaAuthoritative,
        paymentOnAccountRequired: true,
        paymentOnAccountPence: 50000 as MinorUnits,
        paymentOnAccountGbp: 499.99,
      });
    });
    const qPoaStored = (await intakeRepo.getQuoteById<Quote>(ctx, qPoaAuthoritative.id))!;
    expect(qPoaStored.paymentOnAccountPence).toBe(50000);
    expect(qPoaStored.paymentOnAccountGbp).toBe(500);

    // R861: Concurrent sendQuoteEmailRecord + recordQuoteOutcomeAction preserves send metadata
    const r861Draft = (
      await runAsActionActor(
        'P-000002',
        () => saveQuoteAction(baseQuoteInput('R861LockedOutcome')),
        { roles: ['fee_earner'], mfaVerified: false },
      )
    ).quote!;
    const r861Converter: DocumentPdfConverter = {
      converterId: 'r861-concurrent-converter',
      async convertDocxToPdf() {
        return Buffer.from('%PDF-1.4\n% R861 PDF\n%%EOF\n');
      },
    };
    const [sendFirstRes, outcomeAfterRes] = await runAsActionActor(
      'P-000002',
      async () => {
        const sent = await sendQuoteEmailRecord(
          { quoteId: r861Draft.id, idempotencyKey: 'r861-send-key' },
          'P-000002',
          { pdfConverter: r861Converter, drainAfterCommit: false },
        );
        const outcome = await recordQuoteOutcomeAction(r861Draft.id, {
          outcome: 'Accepted',
          note: 'Accepted immediately after send',
        });
        return [sent, outcome] as const;
      },
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(sendFirstRes.ok).toBe(true);
    expect(outcomeAfterRes.quote?.status).toBe('Accepted');
    expect(outcomeAfterRes.quote?.lastSentOutboxId).toBe(
      sendFirstRes.ok ? sendFirstRes.outboxRecord.id : 'missing',
    );
    expect(outcomeAfterRes.quote?.sentToEmail).toBe('hardening-r861lockedoutcome@example.test');

    // True concurrent Promise.all race check on a second quote
    const r861RaceQ = (
      await runAsActionActor(
        'P-000002',
        () => saveQuoteAction(baseQuoteInput('R861TrueRace')),
        { roles: ['fee_earner'], mfaVerified: false },
      )
    ).quote!;
    const [raceSend, raceOutcome] = await runAsActionActor(
      'P-000002',
      () =>
        Promise.all([
          sendQuoteEmailAction({ quoteId: r861RaceQ.id, idempotencyKey: 'r861-true-race' }),
          recordQuoteOutcomeAction(r861RaceQ.id, { outcome: 'Accepted', note: 'Concurrent race' }),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const raceFinal = (await intakeRepo.getQuoteById<Quote>(ctx, r861RaceQ.id))!;
    if (raceSend.ok) {
      expect(raceFinal.lastSentOutboxId).toBe(raceSend.outboxRecord.id);
      expect(raceFinal.sentToEmail).toBe('hardening-r861truerace@example.test');
      expect(raceFinal.status).toBe('Accepted');
    } else {
      expect(raceOutcome.quote?.status).toBe('Accepted');
      expect(raceSend.code).toBe('VALIDATION_ERROR');
    }

    // R856: Enquiry converted to a restricted staff matter while older quote on it stays Sent & chased;
    // Day 21 escalation excludes unauthorised team lead / fee earner via repository visibility predicate -> needs_owner,
    // then succeeds when an authorised restricted team lead (P-000004) becomes lead on retry
    const allTeams = await hrRepo.listAllTeams<Team>(ctx);
    const corpTeam =
      allTeams.find(
        (t) => t.active && t.practiceAreaIds.includes('work_type.corporate_and_commercial'),
      ) ?? allTeams.find((t) => t.active)!;
    // Configure team lead solely to P-000002 (no matter:restricted:access) while keeping practiceAreaIds
    await runAsActionActor(
      'P-000004',
      () =>
        saveTeamAction({
          id: corpTeam.id,
          name: corpTeam.name,
          description: corpTeam.description,
          departmentId: corpTeam.departmentId,
          orgTeamId: corpTeam.orgTeamId,
          systemKey: corpTeam.systemKey,
          memberIds: Array.from(new Set([...corpTeam.memberIds, 'P-000002', 'P-000006'])),
          leadIds: ['P-000002'],
          practiceAreaIds: corpTeam.practiceAreaIds,
          active: true,
        }),
      { roles: ['partner', 'admin'], mfaVerified: true },
    );

    const enqCreated = await runAsActionActor(
      'P-000002',
      () =>
        saveEnquiryAction({
          firstName: 'Restricted',
          lastName: 'EscClient',
          email: 'restricted-esc@example.test',
          channelId: 'enquiry_channel.email',
          practiceAreaId: 'work_type.corporate_and_commercial',
          summary: 'Enquiry linked to older quote before restricted conversion.',
          notes: 'Enquiry notes before conversion to restricted matter.',
          urgencyId: 'urgency.standard',
          privacyNoticeGiven: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(enqCreated.enquiry).toBeTruthy();
    const enqId = enqCreated.enquiry!.id;

    // Older quote sent on that enquiry with P-000006 as fee earner and P-000002 as team lead (neither has restricted access)
    const oldQuoteSent = await runAsActionActor(
      'P-000002',
      () =>
        saveQuoteAction(
          {
            ...baseQuoteInput('R856Esc'),
            linkedEnquiryId: enqId,
            feeEarnerId: 'P-000006',
          },
          { markAsSent: true, sendMode: 'email', idempotencyKey: 'r856-esc-quote' },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const escQuoteId = oldQuoteSent.quote!.id;
    const escChaseId = oldQuoteSent.chase!.id;
    const escSentAt = new Date(oldQuoteSent.chase!.sentAt);

    // Enquiry converted into a restricted staff matter (restricted strictly to P-000004), WITHOUT setting sourceQuoteId
    const enqConvMatter = await runAsActionActor(
      'P-000004',
      () =>
        saveMatterRecord(
          {
            title: 'R856 Restricted Enquiry Matter',
            clientId: 'O-000001',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_commercial_contracts',
            responsiblePartnerId: 'P-000004',
            supervisingPartnerId: 'P-000004',
            leadFeeEarnerId: 'P-000004',
            teamMemberIds: ['P-000004'],
            sourceEnquiryId: enqId,
            isStaffMatter: true,
            restrictedAccessUserIds: ['P-000004'],
            conflictCheckRecord: makeConflictRecord('P-000004', 'Gareth Davies'),
            riskAssessment: { answers: BASE_LOW_RISK_ANSWERS },
          },
          { byId: 'P-000004', saveMode: 'draft' },
        ),
      { roles: ['partner'], mfaVerified: true },
    );
    const enqLoaded = (await intakeRepo.getEnquiryById<Enquiry>(ctx, enqId, {
      includeRestricted: true,
    }))!;
    enqLoaded.convertedMatterId = enqConvMatter.matter!.id;
    await intakeRepo.putEnquiry(ctx, enqLoaded);
    await matterRepo.putMatter(
      ctx,
      {
        ...enqConvMatter.matter!,
        hasEthicalWall: true,
        restrictedAccessUserIds: ['P-000004'],
      },
      {
        expectedRowVersion: null,
        sqlRestrictedAccessUserIds: ['P-000004'],
      },
    );

    // Advance chase to Day 7 -> 14 -> 21
    await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(escSentAt, 7),
    });
    await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(escSentAt, 14),
    });
    const d21Esc = await executeCommunicationChasesForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:communication-chases',
      tenantConfig: chaseCfg,
      drainAfterCommit: false,
      now: addDays(escSentAt, 21),
    });
    expect(d21Esc.outcome).toBe('executed');
    expect(await taskRepo.listTasksLinkedToRecord<Task>(ctx, 'quote', escQuoteId)).toHaveLength(0);
    expect((await chasingRepo.getChaseById(ctx, escChaseId))?.status).toBe('needs_owner');

    // Add authorised user P-000003 (holds matter:restricted:access + quote:view; P-000004 avoids self-escalation) & retry escalation -> P-000003 gets task, NOT P-000002 / P-000006
    const teamUpdate2 = await runAsActionActor(
      'P-000004',
      () =>
        saveTeamAction({
          id: corpTeam.id,
          name: corpTeam.name,
          description: corpTeam.description,
          departmentId: corpTeam.departmentId,
          orgTeamId: corpTeam.orgTeamId,
          systemKey: corpTeam.systemKey,
          memberIds: Array.from(new Set([...corpTeam.memberIds, 'P-000003', 'P-000004'])),
          leadIds: ['P-000002', 'P-000003'],
          practiceAreaIds: corpTeam.practiceAreaIds,
          active: true,
        }),
      { roles: ['partner', 'admin'], mfaVerified: true },
    );
    expect(teamUpdate2.team).toBeTruthy();
    const retryRes = await runAsActionActor(
      'P-000004',
      () => retryCommunicationChaseAction({ chaseId: escChaseId }),
      { roles: ['partner', 'admin'], mfaVerified: true },
    );
    expect(retryRes.ok).toBe(true);
    if (retryRes.ok) {
      expect(retryRes.outcome).toBe('escalated');
    }
    const escTasksResolved = await taskRepo.listTasksLinkedToRecord<Task>(
      testTenantCtx('P-000003'),
      'quote',
      escQuoteId,
    );
    expect(escTasksResolved).toHaveLength(1);
    expect(escTasksResolved[0]?.assignedPersonId).toBe('P-000003');
  }, 60_000);
});
