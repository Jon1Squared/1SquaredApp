import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REGISTER_TYPES,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  DEFAULT_RBAC_ROLES,
  PERMISSION_REGISTRY,
  TenantAuditRepository,
  TenantEvidenceArtifactRepository,
  TenantIntakeCheckRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantRegisterRepository,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  scanBytesForMalwareAndMacros,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import * as actionsModule from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { vid, type Matter, type NotificationItem, type Person } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { getDocumentStorage } from '@/server/documentGenerationServices';
import type { CddChecklistItemEvidenceSummary } from '@/domain/cdd';
import registersConfigJsonSchema from '../schemas/registers.config.schema.json';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import * as servicesModule from '@/server/services';
import {
  anonymiseExpiredEnquiries,
  completeClientCddRecord,
  createRegisterRecordService,
  executeMerge,
  executeRegisterRemindersForTenant,
  getRegisterRecordDetailRecord,
  listRegistersWorkspaceDataRecord,
  recordCddChecklistItemRecord,
  resetAllDemoData,
  saveMatterRecord,
  searchGlobalRecords,
  transitionRegisterRecordService,
  updateRegisterRecordDetailsService,
  uploadEvidenceArtifactRecord,
} from '@/server/services';
import {
  runAsTestActor,
  setAuditAdapterFailureHookForTesting,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

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
  roles: readonly string[],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles,
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s104-${tenantId}-${actorId}`,
  });
}

async function buildMultipartUploadRequest(
  form: FormData,
  opts?: { omitContentLength?: boolean; overrideContentLength?: string },
): Promise<Request> {
  const serialized = new Response(form);
  const contentType = serialized.headers.get('content-type') || 'multipart/form-data';
  const rawBody = await serialized.arrayBuffer();
  const headers = new Headers();
  headers.set('content-type', contentType);
  if (opts?.overrideContentLength !== undefined) {
    headers.set('content-length', opts.overrideContentLength);
  } else if (!opts?.omitContentLength) {
    headers.set('content-length', String(rawBody.byteLength));
  }
  return new Request('http://localhost/api/evidence/upload', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

describe('S1-04 (ADR 0039): Client Due Diligence (CDD) workflow, evidence security, R747 employee hiding & reminders', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    setAuditAdapterFailureHookForTesting(null);
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. R748: enforces strict cdd:view / cdd:record RBAC (legal_secretary allowed; admin & finance refused; risk:view without cdd:record refused writes; saveCddConfigAction requires MFA)', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(25);
    expect(PERMISSION_REGISTRY['cdd:view']).toBeDefined();
    expect(PERMISSION_REGISTRY['cdd:record']).toBeDefined();
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain('cdd:view');
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain('cdd:record');
    expect(DEFAULT_RBAC_ROLES.finance.permissions).not.toContain('cdd:view');
    expect(DEFAULT_RBAC_ROLES.finance.permissions).not.toContain('cdd:record');
    expect(DEFAULT_RBAC_ROLES.legal_secretary.permissions).toContain('cdd:view');
    expect(DEFAULT_RBAC_ROLES.legal_secretary.permissions).toContain('cdd:record');
    expect(CORE_REGISTER_TYPES.cdd.viewPermission).toBe('cdd:view');
    expect(CORE_REGISTER_TYPES.cdd.createPermission).toBe('cdd:record');

    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const partyRepo = new TenantPartyRepository();
    const seededPeople = await partyRepo.listAllPeople<Person>(ctx);
    const baseEmp = seededPeople.find((p) => p.id === 'P-000004')!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S104-PURE-ADMIN',
      entraObjectId: undefined,
      firstName: 'Alun',
      surname: 'AdminOnly',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      emails: [
        {
          id: 'em-s104-admin',
          address: 'alun.admin@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    const riskReadOnlyPerson: Person = {
      ...baseEmp,
      id: 'P-S104-RISK-VIEW-ONLY',
      entraObjectId: undefined,
      firstName: 'Ceri',
      surname: 'RiskViewer',
      employeeRoleId: 'employee_role.support_staff',
      roles: ['finance'],
      appRole: 'call_handler',
      permissionOverrides: {
        grant: ['risk:view', 'cdd:view'],
        revoke: [],
      },
      emails: [
        {
          id: 'em-s104-riskview',
          address: 'ceri.riskview@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo.putPeople(ctx, [pureAdmin, riskReadOnlyPerson]);

    // Existing bug check (R748): admin must NOT see seeded `cdd` records in registers workspace or detail
    const adminList = await runAsActionActor(
      pureAdmin.id,
      () => listRegistersWorkspaceDataRecord({ registerTypeKey: 'cdd' }, pureAdmin.id),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminList.ok).toBe(true);
    if (adminList.ok) {
      expect(adminList.records.some((r) => r.registerTypeKey === 'cdd')).toBe(false);
    }

    const [adminDetail, adminMissingDetail] = await runAsActionActor(
      pureAdmin.id,
      () =>
        Promise.all([
          getRegisterRecordDetailRecord('REG-000003', pureAdmin.id),
          getRegisterRecordDetailRecord('REG-DOES-NOT-EXIST-ADMIN', pureAdmin.id),
        ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminDetail).toMatchObject({ ok: false, code: 'NOT_FOUND', message: 'Register record was not found.' });
    expect(adminDetail).toEqual(adminMissingDetail);

    // Finance cannot view `cdd` register records either
    const financeList = await runAsActionActor(
      'P-000009',
      () => listRegistersWorkspaceDataRecord({ registerTypeKey: 'cdd' }, 'P-000009'),
      { roles: ['finance'], mfaVerified: false },
    );
    if (financeList.ok) {
      expect(financeList.records.some((r) => r.registerTypeKey === 'cdd')).toBe(false);
    }

    // New S1-04 actions must exist and enforce R748 strictly
    const startOrLoadClientCddAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).startOrLoadClientCddAction;
    const recordManualSanctionsPepAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).recordManualSanctionsPepAction;
    const saveCddConfigAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).saveCddConfigAction;
    expect(typeof startOrLoadClientCddAction).toBe('function');
    expect(typeof recordManualSanctionsPepAction).toBe('function');
    expect(typeof saveCddConfigAction).toBe('function');

    // Admin refused startOrLoadClientCddAction
    const adminCddStart = (await runAsActionActor(
      pureAdmin.id,
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['admin'], mfaVerified: true },
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(adminCddStart as never)).toBe(true);

    // Finance refused startOrLoadClientCddAction
    const financeCddStart = (await runAsActionActor(
      'P-000009',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-000015',
        }),
      { roles: ['finance'], mfaVerified: false },
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(financeCddStart as never)).toBe(true);

    // risk:view without cdd:record refused manual sanctions/PEP write
    const riskOnlySanctions = (await runAsActionActor(
      riskReadOnlyPerson.id,
      () =>
        recordManualSanctionsPepAction!({
          subjectType: 'person',
          subjectId: 'P-000015',
          outcome: 'clear',
          screeningScope: 'Manual UK sanctions & PEP register check',
          referenceCode: 'SP-DENY-1',
        }),
      { roles: ['finance'], mfaVerified: false },
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(riskOnlySanctions as never)).toBe(true);

    // Legal secretary (P-000010) CAN load and record client CDD
    const secCddLoad = (await runAsActionActor(
      'P-000010',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-000015',
        }),
      { roles: ['legal_secretary'], mfaVerified: false },
    )) as { ok: boolean; summary?: { subjectId: string; canRecord: boolean } };
    expect(secCddLoad.ok).toBe(true);
    expect(secCddLoad.summary?.canRecord).toBe(true);

    // saveCddConfigAction requires MFA (refuses non-MFA) and allows MFA-verified admin
    const noMfaSaveCfg = (await runAsActionActor(
      pureAdmin.id,
      () =>
        saveCddConfigAction!(
          { enabled: true, recheckIntervalsMonths: { standard: 24, high: 12 } },
          'Attempt without MFA',
        ),
      { roles: ['admin'], mfaVerified: false },
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(noMfaSaveCfg as never)).toBe(true);
    if (isActionDenied(noMfaSaveCfg as never)) {
      expect(noMfaSaveCfg.code).toBe('MFA_REQUIRED');
    }
  }, 30_000);

  it('2. R747: completely hides employee-client CDD records (list, detail, action, search, evidence download, and reminders) from unpermitted staff while allowing participants & risk:view holders', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const regRepo = new TenantRegisterRepository();
    const matterRepo = new TenantMatterRepository();

    // P-000005 (Siân Llewellyn) is an employee who is NOT on Owain's (P-000006) team.
    // Give Siân an active staff matter led by P-000001 where P-000002 is fee earner,
    // and P-000006 is completely excluded.
    const baseMatter = await matterRepo.getMatterById<Matter>(ctx, 'M-000001');
    expect(baseMatter).not.toBeNull();
    const empMatter = await matterRepo.createMatter<Matter>(ctx, {
      ...baseMatter!,
      id: 'M-S104-EMP',
      recordType: 'matter',
      matterNumber: 'S104-EMP-0001',
      title: 'Employee Conveyance Staff Purchase',
      clientId: 'P-000005',
      instructingContactId: null,
      billingContactId: null,
      matterTypeId: vid('matter_type', 'Residential'),
      practiceAreaId: 'work_type.real_estate_and_property',
      workTypeSubcategoryId: 'work_type.real_estate_and_property_residential_conveyancing',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000002',
      teamMemberIds: ['P-000002'],
      additionalClientIds: [],
      parties: [],
      conflictCheckStatus: 'Cleared',
      conflictCheckDate: '2026-01-10',
      conflictClearedById: 'P-000003',
      conflictNotes: '',
      amlStatus: 'Verified',
      amlCompletedAt: null,
      sourceOfFundsVerified: 'In progress',
      sourceOfWealthVerified: 'N/A',
      engagementLetterStatus: 'Signed',
      engagementLetterSentAt: null,
      engagementLetterSignedAt: '2026-01-10',
      feeEstimateGbp: 4000,
      agreedFeeCapGbp: null,
      retainerMoniesOnAccountGbp: null,
      stageId: vid('matter_status', 'Active'),
      milestoneId: null,
      enquiryReceivedAt: '2026-01-10',
      openedAt: '2026-01-10',
      targetCompletionAt: null,
      closedAt: null,
      matterStatusId: vid('matter_status', 'Active'),
      riskRatingId: 'risk_rating.low',
      createdById: 'P-000001',
      createdAt: '2026-01-10T10:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-01-10T10:00:00.000Z',
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-000001', 'P-000002'],
    });
    expect(empMatter.id).toBe('M-S104-EMP');

    // Create a CDD record directly on employee-client P-000005 with a due date today
    const todayYmd = new Date().toISOString().slice(0, 10);
    const empCdd = await regRepo.createRegisterRecord(ctx, {
      id: 'REG-S104-EMP',
      registerTypeKey: 'cdd',
      reference: 'CDD-S104-EMP',
      title: 'Client CDD — Sian Employee Confidential',
      status: 'recorded',
      personId: 'P-000005',
      ownerId: 'P-000006', // Purposely assign non-permitted P-000006 as owner to verify R747 filters recipients out
      dueAt: `${todayYmd}T12:00:00.000Z`,
      fieldValues: {
        clientCategory: 'individual',
        riskTier: 'standard',
        checklistItems: [
          {
            itemKey: 'photo_id',
            label: 'Photo ID',
            required: true,
            status: 'recorded',
            recordedById: 'P-000001',
            recordedAt: `${todayYmd}T09:00:00.000Z`,
            evidenceRefs: [],
          },
        ],
      },
      createdById: 'P-000001',
    });

    // Unpermitted fee earner P-000006 (holds cdd:view, NOT on employee's matter, no risk:view):
    // must see ZERO trace of P-000005 CDD across list, detail, search, or startOrLoadClientCddAction
    const outsiderList = await runAsActionActor(
      'P-000006',
      () => listRegistersWorkspaceDataRecord({ registerTypeKey: 'cdd' }, 'P-000006'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderList.ok).toBe(true);
    if (outsiderList.ok) {
      expect(outsiderList.records.some((r) => r.id === empCdd.id)).toBe(false);
    }

    const [outsiderDetail, outsiderMissingDetail] = await runAsActionActor(
      'P-000006',
      () =>
        Promise.all([
          getRegisterRecordDetailRecord(empCdd.id, 'P-000006'),
          getRegisterRecordDetailRecord('REG-DOES-NOT-EXIST-S104', 'P-000006'),
        ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderDetail).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(outsiderDetail).toEqual(outsiderMissingDetail);

    const startOrLoadClientCddAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).startOrLoadClientCddAction;
    expect(typeof startOrLoadClientCddAction).toBe('function');
    const outsiderProfileCdd = (await runAsActionActor(
      'P-000006',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-000005',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; code?: string };
    const missingProfileCdd = (await runAsActionActor(
      'P-000006',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-DOES-NOT-EXIST-S104',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; code?: string };
    expect(outsiderProfileCdd).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(outsiderProfileCdd).toEqual(missingProfileCdd);

    const outsiderSearch = await runAsActionActor(
      'P-000006',
      () => searchGlobalRecords({ query: 'Employee Confidential', entityTypes: ['register_record'] }, 'P-000006'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderSearch.hits.some((h) => h.id === empCdd.id)).toBe(false);

    const outsiderPrior = await runAsActionActor(
      'P-000006',
      () => servicesModule.listClientPriorMattersRecord(['P-000005'], 'P-000006'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect('denied' in outsiderPrior).toBe(false);
    if (!('denied' in outsiderPrior)) {
      expect(outsiderPrior.cddSummaries['P-000005']?.visible).toBe(false);
    }

    // Positive controls: P-000002 (active matter participant) & P-000003 (risk_compliance) CAN see it
    const participantList = await runAsActionActor(
      'P-000002',
      () => listRegistersWorkspaceDataRecord({ registerTypeKey: 'cdd' }, 'P-000002'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(participantList.ok).toBe(true);
    if (participantList.ok) {
      expect(participantList.records.some((r) => r.id === empCdd.id)).toBe(true);
    }

    const complianceDetail = await runAsActionActor(
      'P-000003',
      () => getRegisterRecordDetailRecord(empCdd.id, 'P-000003'),
      { roles: ['risk_compliance'], mfaVerified: false },
    );
    expect(complianceDetail.ok).toBe(true);
    expect(await matterRepo.getMatterById(ctx, empMatter.id, { includeRestricted: true })).toBeDefined();

    // R777 / R800 / R803 (Test 2 evidence upload & download on employee-client P-000005):
    const uploadRoute = await import('@/app/api/evidence/upload/route');
    const downloadRoute = await import('@/app/api/evidence/download/route');
    const empPdf = new TextEncoder().encode('%PDF-1.4\n%Employee Confidential ID');
    const empUpForm = new FormData();
    empUpForm.set('subjectType', 'person');
    empUpForm.set('subjectId', 'P-000005');
    empUpForm.set('file', new File([empPdf], 'sian-passport.pdf', { type: 'application/pdf' }));
    const empUpReq = await buildMultipartUploadRequest(empUpForm);
    const empUpRes = await runAsActionActor(
      'P-000002',
      () => uploadRoute.POST(empUpReq),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(empUpRes.status).toBe(200);
    const empUpJson = (await empUpRes.json()) as {
      artifact?: { id: string };
      evidenceRef?: { blobKey: string };
      downloadUrl?: string;
    };
    expect(empUpJson.downloadUrl).toMatch(/^\/api\/evidence\/download\?token=/);

    const outsiderEmpUpForm = new FormData();
    outsiderEmpUpForm.set('subjectType', 'person');
    outsiderEmpUpForm.set('subjectId', 'P-000005');
    outsiderEmpUpForm.set('file', new File([empPdf], 'outsider-attempt.pdf', { type: 'application/pdf' }));
    const outsiderEmpUpReq = await buildMultipartUploadRequest(outsiderEmpUpForm);
    const outsiderEmpUpRes = await runAsActionActor(
      'P-000006',
      () => uploadRoute.POST(outsiderEmpUpReq),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    const missingEmpUpForm = new FormData();
    missingEmpUpForm.set('subjectType', 'person');
    missingEmpUpForm.set('subjectId', 'P-DOES-NOT-EXIST-S104');
    missingEmpUpForm.set('file', new File([empPdf], 'outsider-attempt.pdf', { type: 'application/pdf' }));
    const missingEmpUpRes = await runAsActionActor(
      'P-000006',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(missingEmpUpForm)),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderEmpUpRes.status).toBe(404);
    expect(missingEmpUpRes.status).toBe(404);
    expect(await outsiderEmpUpRes.json()).toEqual(await missingEmpUpRes.json());

    // Another user's token returns opaque 404 matching missing artifact (R844)
    const outsiderEmpDlRes = await runAsActionActor(
      'P-000006',
      () =>
        downloadRoute.GET(
          new Request(`http://localhost${empUpJson.downloadUrl}`, { method: 'GET' }),
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(outsiderEmpDlRes.status).toBe(404);
    expect(await outsiderEmpDlRes.json()).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    // R803: Token owned by P-000006 passes token-owner check and reaches R747 employee check -> 404 NOT_FOUND
    const storageForP6 = getDocumentStorage(getActiveTenantConfiguration());
    const p6OwnToken = await storageForP6.issueScopedDownloadToken(
      makeVerifiedTenantCtx('not-a-law-firm', 'P-000006', ['fee_earner'], false),
      {
        blobKey: empUpJson.evidenceRef!.blobKey,
        fileName: 'sian-passport.pdf',
        documentId: empUpJson.artifact!.id,
      },
    );
    const p6OwnTokenDlRes = await runAsActionActor(
      'P-000006',
      () =>
        downloadRoute.GET(
          new Request(
            `http://localhost/api/evidence/download?token=${encodeURIComponent(p6OwnToken.token)}`,
            { method: 'GET' },
          ),
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(p6OwnTokenDlRes.status).toBe(404);
    expect(await p6OwnTokenDlRes.json()).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    // R771: relationshipPartnerId alone on an unrestricted matter for P-000005 grants aligned SQL list, detail & startOrLoad access (no duplicate record created)
    await matterRepo.createMatter<Matter>(ctx, {
      ...baseMatter!,
      id: 'M-S104-REL-EMP',
      recordType: 'matter',
      matterNumber: 'S104-REL-0001',
      title: 'Unrestricted Matter With Relationship Partner',
      clientId: 'P-000005',
      instructingContactId: null,
      billingContactId: null,
      matterTypeId: vid('matter_type', 'Commercial'),
      practiceAreaId: 'work_type.corporate_and_commercial',
      workTypeSubcategoryId: 'work_type.corporate_and_commercial_acquisitions',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000002',
      relationshipPartnerId: 'P-000008',
      teamMemberIds: ['P-000002'],
      additionalClientIds: [],
      parties: [],
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
    });
    const relPartnerList = await runAsActionActor(
      'P-000008',
      () => listRegistersWorkspaceDataRecord({ registerTypeKey: 'cdd' }, 'P-000008'),
      { roles: ['partner'], mfaVerified: false },
    );
    expect(relPartnerList.ok).toBe(true);
    if (relPartnerList.ok) {
      expect(relPartnerList.records.some((r) => r.id === empCdd.id)).toBe(true);
    }
    const relPartnerLoad = (await runAsActionActor(
      'P-000008',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'person',
          subjectId: 'P-000005',
          createIfMissing: true,
        }),
      { roles: ['partner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null } };
    expect(relPartnerLoad.ok).toBe(true);
    expect(relPartnerLoad.summary?.record?.id).toBe(empCdd.id);
    const regRepoCheck = new TenantRegisterRepository();
    const empRecordsAfterRel = await regRepoCheck.listVisibleRegisterRecords(
      ctx,
      'P-000001',
      {
        registerTypeKey: 'cdd',
        personId: 'P-000005',
        canViewCdd: true,
        canBypassEmployeeCddVisibility: true,
      },
    );
    expect(empRecordsAfterRel.filter((r) => r.id === empCdd.id || r.status === 'recorded' || r.status === 'in_progress')).toHaveLength(1);
  }, 30_000);

  it('3. R746, R748 & Rule 9: /api/evidence/upload pre-scans malware BEFORE storage; /api/evidence/download enforces HMAC, DB ownership & R747 across tenants', async () => {
    const uploadRoute = await import('@/app/api/evidence/upload/route').catch(() => null);
    const downloadRoute = await import('@/app/api/evidence/download/route').catch(() => null);
    expect(uploadRoute).not.toBeNull();
    expect(downloadRoute).not.toBeNull();
    expect(typeof uploadRoute?.POST).toBe('function');
    expect(typeof downloadRoute?.GET).toBe('function');

    await resetAllDemoData('P-000004', testDataResetContext());
    const evidenceRepo = new TenantEvidenceArtifactRepository();

    // 1. EICAR malware bytes must fail BEFORE putObject (zero evidence_artifacts row persisted)
    const eicarBytes = new TextEncoder().encode(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    expect(scanBytesForMalwareAndMacros(eicarBytes, 'bad-id.pdf')).toBe('infected');

    const badForm = new FormData();
    badForm.set('subjectType', 'person');
    badForm.set('subjectId', 'P-000015');
    badForm.set('file', new File([eicarBytes], 'eicar-passport.pdf', { type: 'application/pdf' }));
    const badReq = await buildMultipartUploadRequest(badForm);
    const preArtifacts = await evidenceRepo.listArtifactsForSubject(testTenantCtx('P-000010'), {
      subjectType: 'person',
      subjectId: 'P-000015',
    });
    const malwareRes = await runAsActionActor(
      'P-000010',
      () => uploadRoute!.POST(badReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(malwareRes.status).toBe(422);
    const malwareJson = (await malwareRes.json()) as { code?: string; error?: string };
    expect(malwareJson.code).toBe('EVIDENCE_MALWARE_DETECTED');
    expect(malwareJson.error).toBe("This file failed a security check and can't be attached.");
    const postArtifacts = await evidenceRepo.listArtifactsForSubject(testTenantCtx('P-000010'), {
      subjectType: 'person',
      subjectId: 'P-000015',
    });
    expect(postArtifacts.length).toBe(preArtifacts.length);

    // 2. Clean PDF upload by P-000010 (legal_secretary) succeeds and issues download URL
    const cleanPdf = new TextEncoder().encode('%PDF-1.4\n%Clean CDD passport scan sample');
    const goodForm = new FormData();
    goodForm.set('subjectType', 'person');
    goodForm.set('subjectId', 'P-000015');
    goodForm.set('file', new File([cleanPdf], 'passport-scan.pdf', { type: 'application/pdf' }));
    const goodReq = await buildMultipartUploadRequest(goodForm);
    const cleanRes = await runAsActionActor(
      'P-000010',
      () => uploadRoute!.POST(goodReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(cleanRes.status).toBe(200);
    const cleanJson = (await cleanRes.json()) as {
      ok: boolean;
      evidenceRef?: { blobKey: string; sha256: string };
      artifact?: { id: string; scanStatus: string };
      downloadUrl?: string;
    };
    expect(cleanJson.ok).toBe(true);
    expect(cleanJson.artifact?.scanStatus).toBe('clean');
    expect(cleanJson.downloadUrl).toMatch(/^\/api\/evidence\/download\?token=/);

    // 3. Download by issuing actor succeeds with Attachment headers
    const dlUrl = `http://localhost${cleanJson.downloadUrl}`;
    const okDlRes = await runAsActionActor(
      'P-000010',
      () => downloadRoute!.GET(new Request(dlUrl, { method: 'GET' })),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(okDlRes.status).toBe(200);
    expect(okDlRes.headers.get('content-type')).toBe('application/pdf');
    expect(okDlRes.headers.get('content-disposition')).toContain('passport-scan.pdf');
    expect(okDlRes.headers.get('x-content-type-options')).toBe('nosniff');

    // 4. Token belonging to P-000010 rejected with opaque 404 (R844) when presented by another
    //    actor (P-000002), admin (P-000004 as admin only), or with a tampered token
    const wrongActorDl = await runAsActionActor(
      'P-000002',
      () => downloadRoute!.GET(new Request(dlUrl, { method: 'GET' })),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(wrongActorDl.status).toBe(404);
    expect(await wrongActorDl.json()).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    const adminDl = await runAsActionActor(
      'P-000004',
      () => downloadRoute!.GET(new Request(dlUrl, { method: 'GET' })),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminDl.status).toBe(404);

    const tamperedRes = await runAsActionActor(
      'P-000010',
      () => downloadRoute!.GET(new Request(`${dlUrl}tampered`, { method: 'GET' })),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(tamperedRes.status).toBe(404);
    expect(await tamperedRes.json()).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    // 5. R775 upload hardening:
    //    (a) Upload audit uses artifact.id (EVD-...), NOT blobKey / filename
    const auditRepo = new TenantAuditRepository();
    const uploadAudits = await auditRepo.listAuditEntriesForRecord(
      testTenantCtx('P-000010'),
      'evidence_artifact',
      cleanJson.artifact!.id,
    );
    expect(uploadAudits.some((a) => a.action === 'upload' && a.recordId === cleanJson.artifact!.id)).toBe(true);
    const rawBlobAudits = await auditRepo.listAuditEntriesForRecord(
      testTenantCtx('P-000010'),
      'evidence_artifact',
      cleanJson.evidenceRef!.blobKey,
    );
    expect(rawBlobAudits).toHaveLength(0);

    //    (b) Missing Content-Length rejected with 411; oversized Content-Length rejected with 413 BEFORE formData() parses
    const missingLenReq = await buildMultipartUploadRequest(goodForm, { omitContentLength: true });
    const missingLenRes = await runAsActionActor(
      'P-000010',
      () => uploadRoute!.POST(missingLenReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(missingLenRes.status).toBe(411);
    const missingLenJson = (await missingLenRes.json()) as { error?: string };
    expect(missingLenJson.error).toBe(
      "The upload couldn't be checked because the file size wasn't sent. Please try again.",
    );

    let formDataCalledOnOversize = false;
    const oversizeReq = new Request('http://localhost/api/evidence/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----testboundary',
        'content-length': String(30 * 1024 * 1024),
      },
      body: 'stub',
    });
    Object.defineProperty(oversizeReq, 'formData', {
      value: async () => {
        formDataCalledOnOversize = true;
        return new FormData();
      },
    });
    const oversizeRes = await runAsActionActor(
      'P-000010',
      () => uploadRoute!.POST(oversizeReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(oversizeRes.status).toBe(413);
    const oversizeJson = (await oversizeRes.json()) as { error?: string };
    expect(oversizeJson.error).toBe('This file is too large. The limit is 10 MB.');
    expect(formDataCalledOnOversize).toBe(false);

    // Missing file field & R805 service-level plain-English messages
    const missingFileForm = new FormData();
    missingFileForm.set('subjectType', 'person');
    missingFileForm.set('subjectId', 'P-000015');
    const missingFileRes = await runAsActionActor(
      'P-000010',
      async () => uploadRoute!.POST(await buildMultipartUploadRequest(missingFileForm)),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(missingFileRes.status).toBe(400);
    const missingFileJson = (await missingFileRes.json()) as { error?: string };
    expect(missingFileJson.error).toBe('Please choose a file to attach.');

    const emptyServiceRes = await runAsActionActor(
      'P-000010',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'person',
            subjectId: 'P-000015',
            fileName: 'empty-passport.pdf',
            contentType: 'application/pdf',
            bytes: new Uint8Array(0),
          },
          'P-000010',
        ),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(emptyServiceRes.ok).toBe(false);
    if (!emptyServiceRes.ok) {
      expect(emptyServiceRes.code).toBe('VALIDATION_ERROR');
      expect(emptyServiceRes.message).toBe('The file is empty.');
    }

    const oversizeServiceRes = await runAsActionActor(
      'P-000010',
      () =>
        uploadEvidenceArtifactRecord(
          {
            subjectType: 'person',
            subjectId: 'P-000015',
            fileName: 'huge-passport.pdf',
            contentType: 'application/pdf',
            bytes: new Uint8Array(11 * 1024 * 1024),
          },
          'P-000010',
        ),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(oversizeServiceRes.ok).toBe(false);
    if (!oversizeServiceRes.ok) {
      expect(oversizeServiceRes.code).toBe('PAYLOAD_TOO_LARGE');
      expect(oversizeServiceRes.message).toBe('This file is too large. The limit is 10 MB.');
    }

    //    (c) Allowlist MIME + magic-byte check: HTML / spoofed PDF / WebP / text refused; valid HEIC / PPTX accepted
    const badMimeForm = new FormData();
    badMimeForm.set('subjectType', 'person');
    badMimeForm.set('subjectId', 'P-000015');
    badMimeForm.set('file', new File([new TextEncoder().encode('<script>1</script>')], 'page.html', { type: 'text/html' }));
    const badMimeReq = await buildMultipartUploadRequest(badMimeForm);
    const badMimeRes = await runAsActionActor(
      'P-000010',
      () => uploadRoute!.POST(badMimeReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(badMimeRes.status).toBe(415);
    const badMimeJson = (await badMimeRes.json()) as { error?: string };
    expect(badMimeJson.error).toBe(
      "This type of file can't be attached. Use a PDF, image, Word, Excel or PowerPoint file.",
    );

    const spoofedPdfForm = new FormData();
    spoofedPdfForm.set('subjectType', 'person');
    spoofedPdfForm.set('subjectId', 'P-000015');
    spoofedPdfForm.set('file', new File([new TextEncoder().encode('<script>1</script>')], 'fake.pdf', { type: 'application/pdf' }));
    const spoofedPdfRes = await runAsActionActor(
      'P-000010',
      async () => uploadRoute!.POST(await buildMultipartUploadRequest(spoofedPdfForm)),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(spoofedPdfRes.status).toBe(415);
    const spoofedPdfJson = (await spoofedPdfRes.json()) as { error?: string };
    expect(spoofedPdfJson.error).toBe("This file's contents don't match its file type.");

    // R805: verify no upload error exposes MIME types, raw byte counts, status codes, or uploaded filenames
    const collectedUploadMessages = [
      malwareJson.error ?? '',
      missingLenJson.error ?? '',
      oversizeJson.error ?? '',
      missingFileJson.error ?? '',
      !emptyServiceRes.ok ? emptyServiceRes.message : '',
      !oversizeServiceRes.ok ? oversizeServiceRes.message : '',
      badMimeJson.error ?? '',
      spoofedPdfJson.error ?? '',
    ];
    for (const msg of collectedUploadMessages) {
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain('application/');
      expect(msg).not.toContain('bytes');
      expect(msg).not.toContain('status:');
      expect(msg).not.toContain('eicar-passport.pdf');
      expect(msg).not.toContain('empty-passport.pdf');
      expect(msg).not.toContain('huge-passport.pdf');
      expect(msg).not.toContain('page.html');
      expect(msg).not.toContain('fake.pdf');
    }

    for (const removedMime of [
      { ext: 'webp', type: 'image/webp', bytes: new TextEncoder().encode('RIFFxxxxWEBP') },
      { ext: 'txt', type: 'text/plain', bytes: new TextEncoder().encode('plain text') },
    ]) {
      const f = new FormData();
      f.set('subjectType', 'person');
      f.set('subjectId', 'P-000015');
      f.set('file', new File([removedMime.bytes], `doc.${removedMime.ext}`, { type: removedMime.type }));
      const r = await runAsActionActor(
        'P-000010',
        async () => uploadRoute!.POST(await buildMultipartUploadRequest(f)),
        { roles: ['legal_secretary'], mfaVerified: false },
      );
      expect(r.status).toBe(415);
    }

    const heicForm = new FormData();
    heicForm.set('subjectType', 'person');
    heicForm.set('subjectId', 'P-000015');
    heicForm.set('file', new File([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], 'id.heic', { type: 'image/heic' }));
    const heicRes = await runAsActionActor(
      'P-000010',
      async () => uploadRoute!.POST(await buildMultipartUploadRequest(heicForm)),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(heicRes.status).toBe(200);

    const pptxForm = new FormData();
    pptxForm.set('subjectType', 'person');
    pptxForm.set('subjectId', 'P-000015');
    pptxForm.set('file', new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])], 'slides.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    const pptxRes = await runAsActionActor(
      'P-000010',
      async () => uploadRoute!.POST(await buildMultipartUploadRequest(pptxForm)),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(pptxRes.status).toBe(200);

    //    (d) R807: post-storage non-clean scan deletes stored blob and returns plain-English security message
    const activeStorage = getDocumentStorage(getActiveTenantConfiguration());
    let orphanCandidateBlobKey = '';
    const origPutObject = activeStorage.putObject.bind(activeStorage);
    const putSpy = vi
      .spyOn(activeStorage, 'putObject')
      .mockImplementation(async (putCtx, putInput) => {
        const stored = await origPutObject(putCtx, putInput);
        orphanCandidateBlobKey = stored.blobKey;
        return { ...stored, scanStatus: 'infected' };
      });
    try {
      const postScanRes = await runAsActionActor(
        'P-000010',
        () =>
          uploadEvidenceArtifactRecord(
            {
              subjectType: 'person',
              subjectId: 'P-000015',
              fileName: 'post-scan-suspect.pdf',
              contentType: 'application/pdf',
              bytes: new TextEncoder().encode('%PDF-1.4\n%Clean bytes flagged post-storage'),
            },
            'P-000010',
          ),
        { roles: ['legal_secretary'], mfaVerified: false },
      );
      expect(postScanRes.ok).toBe(false);
      if (!postScanRes.ok) {
        expect(postScanRes.code).toBe('EVIDENCE_MALWARE_DETECTED');
        expect(postScanRes.message).toBe(
          "This file failed a security check and can't be attached.",
        );
      }
      expect(orphanCandidateBlobKey).toBeTruthy();
      await expect(
        activeStorage.getObjectBytes(testTenantCtx('P-000010'), {
          blobKey: orphanCandidateBlobKey,
        }),
      ).rejects.toThrow();
    } finally {
      putSpy.mockRestore();
    }

    // 6. R777 two-tenant isolation: Alpha evidence token presented in Bravo, forged tenant claim, cross-tenant subjectId
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolMgr3 = new TenantPostgresPoolManager();
    openPoolManagers.push(poolMgr3);
    const runner3 = new TenantMigrationRunner();
    const ctxAlpha3 = makeVerifiedTenantCtx('tenant-alpha', 'P-000004', ['admin', 'legal_secretary', 'fee_earner']);
    const ctxBravo3 = makeVerifiedTenantCtx('tenant-bravo', 'P-000004', ['admin', 'legal_secretary', 'fee_earner']);
    await runner3.applyUp(ctxAlpha3, CORE_TENANT_MIGRATIONS);
    await runner3.applyUp(ctxBravo3, CORE_TENANT_MIGRATIONS);
    const alphaRaw3 = { ...(notALawFirmBaseConfig as unknown as Record<string, unknown>), tenantId: 'tenant-alpha' };
    const bravoRaw3 = { ...(notALawFirmBaseConfig as unknown as Record<string, unknown>), tenantId: 'tenant-bravo' };
    const alphaCfg3 = loadAndValidateTenantConfig(alphaRaw3, { tenantId: 'tenant-alpha', environment: 'test' }, 'test', 'multi_tenant');
    const bravoCfg3 = loadAndValidateTenantConfig(bravoRaw3, { tenantId: 'tenant-bravo', environment: 'test' }, 'test', 'multi_tenant');
    await importFirmStoreModulesToPostgres({ ctx: ctxAlpha3, tenantConfig: alphaCfg3, clearFirst: true, store: createSeedStore(new Date()) });
    await importFirmStoreModulesToPostgres({ ctx: ctxBravo3, tenantConfig: bravoCfg3, clearFirst: true, store: createSeedStore(new Date()) });
    const partyAlpha3 = new TenantPartyRepository({ poolManager: poolMgr3 });
    const seededP15Alpha = (await partyAlpha3.getPersonById<Person>(ctxAlpha3, 'P-000015'))!;
    await partyAlpha3.putPerson(ctxAlpha3, {
      ...seededP15Alpha,
      id: 'P-S104-ALPHA-ONLY',
      firstName: 'Alpha',
      surname: 'Exclusive',
    });

    setActiveTenantConfigForTesting(alphaRaw3, {});
    const alphaUploadRes = await runAsActionActor(
      'P-000010',
      async () => {
        const f = new FormData();
        f.set('subjectType', 'person');
        f.set('subjectId', 'P-000015');
        f.set('file', new File([cleanPdf], 'alpha-passport.pdf', { type: 'application/pdf' }));
        return uploadRoute!.POST(await buildMultipartUploadRequest(f));
      },
      { tenantId: 'tenant-alpha', roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(alphaUploadRes.status).toBe(200);
    const alphaUploadJson = (await alphaUploadRes.json()) as { downloadUrl?: string };

    // Alpha download token presented in Bravo returns opaque 404 (R844)
    setActiveTenantConfigForTesting(bravoRaw3, {});
    const crossTenantDlRes = await runAsActionActor(
      'P-000010',
      () =>
        downloadRoute!.GET(
          new Request(`http://localhost${alphaUploadJson.downloadUrl}`, { method: 'GET' }),
        ),
      { tenantId: 'tenant-bravo', roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(crossTenantDlRes.status).toBe(404);
    expect(await crossTenantDlRes.json()).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Evidence file not found or access denied.',
    });

    // Upload with Alpha-only subjectId inside Bravo -> 404 (no cross-tenant write)
    const crossTenantUpRes = await runAsActionActor(
      'P-000010',
      async () => {
        const f = new FormData();
        f.set('subjectType', 'person');
        f.set('subjectId', 'P-S104-ALPHA-ONLY');
        f.set('file', new File([cleanPdf], 'cross-tenant.pdf', { type: 'application/pdf' }));
        return uploadRoute!.POST(await buildMultipartUploadRequest(f));
      },
      { tenantId: 'tenant-bravo', roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(crossTenantUpRes.status).toBe(404);

    // Forged tenant claim (session claims tenant-bravo while active tenant is tenant-alpha) -> rejected
    setActiveTenantConfigForTesting(alphaRaw3, {});
    await expect(
      runAsActionActor(
        'P-000010',
        () =>
          downloadRoute!.GET(
            new Request(`http://localhost${alphaUploadJson.downloadUrl}`, { method: 'GET' }),
          ),
        { tenantId: 'tenant-bravo', roles: ['legal_secretary'], mfaVerified: false },
      ),
    ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
  }, 45_000);

  it('4. R749 & R750: completes Standard CDD immediately -> recorded (36m dueAt), upgrades Standard -> High preserving items & setting 12m dueAt, and saveMatterRecord ignores legacy CDD fields', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    // R750: saveMatterRecord must IGNORE client-supplied legacy matter CDD fields (runs first for fail-first proof)
    const savedMatter = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRecord(
          {
            title: 'R750 Legacy CDD Field Spoof Attempt',
            clientId: 'O-000001',
            matterTypeId: vid('matter_type', 'Commercial'),
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId: 'work_type.corporate_and_commercial_acquisitions',
            officeId: 'OFF-CAR',
            responsiblePartnerId: 'P-000001',
            leadFeeEarnerId: 'P-000002',
            amlStatus: 'Verified',
            sourceOfFundsVerified: 'Verified',
            sourceOfWealthVerified: 'Verified',
          } as Parameters<typeof saveMatterRecord>[0],
          { byId: 'P-000001', saveMode: 'draft' },
        ),
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(savedMatter.matter).toBeDefined();
    expect(savedMatter.matter?.amlStatus).not.toBe('Verified');
    expect(savedMatter.matter?.sourceOfFundsVerified).not.toBe('Verified');
    expect(savedMatter.matter?.sourceOfWealthVerified).not.toBe('Verified');

    const updatedMatter = await runAsActionActor(
      'P-000001',
      () =>
        saveMatterRecord(
          {
            ...savedMatter.matter!,
            title: 'R750 Legacy CDD Field Update Spoof',
            amlStatus: 'Verified',
            sourceOfFundsVerified: 'Verified',
            sourceOfWealthVerified: 'Verified',
          } as Parameters<typeof saveMatterRecord>[0],
          {
            id: savedMatter.matter!.id,
            byId: 'P-000001',
            saveMode: 'draft',
            expectedRowVersion: savedMatter.matter!.rowVersion,
          },
        ),
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(updatedMatter.matter).toBeDefined();
    expect(updatedMatter.matter?.amlStatus).not.toBe('Verified');
    expect(updatedMatter.matter?.sourceOfFundsVerified).not.toBe('Verified');
    expect(updatedMatter.matter?.sourceOfWealthVerified).not.toBe('Verified');

    const startOrLoadClientCddAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).startOrLoadClientCddAction;
    const recordCddChecklistItemAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).recordCddChecklistItemAction;
    const completeClientCddAction = (
      actionsModule as Record<string, (...args: unknown[]) => Promise<unknown>>
    ).completeClientCddAction;
    expect(typeof startOrLoadClientCddAction).toBe('function');
    expect(typeof recordCddChecklistItemAction).toBe('function');
    expect(typeof completeClientCddAction).toBe('function');

    // Bay Cafés Ltd (O-000004) starts at Standard risk (Low org risk & no active High-risk matter)
    const loaded = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'organisation',
          subjectId: 'O-000004',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as {
      ok: boolean;
      summary: {
        record: { id: string; status: string; rowVersion: number };
        checklistItems: Array<{ itemKey: string; required: boolean }>;
      };
    };
    expect(loaded.ok).toBe(true);
    expect(loaded.summary.record.status).toBe('in_progress');

    // `not_applicable` without note fails validation
    const missingNoteRes = (await runAsActionActor(
      'P-000002',
      () =>
        recordCddChecklistItemAction!({
          recordId: loaded.summary.record.id,
          itemKey: loaded.summary.checklistItems[0]!.itemKey,
          status: 'not_applicable',
          note: '',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean };
    expect(missingNoteRes.ok).toBe(false);

    // Record all Standard items cleanly
    for (const item of loaded.summary.checklistItems) {
      const recRes = (await runAsActionActor(
        'P-000002',
        () =>
          recordCddChecklistItemAction!({
            recordId: loaded.summary.record.id,
            itemKey: item.itemKey,
            status: 'recorded',
            note: `Checked ${item.itemKey}`,
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      )) as { ok: boolean };
      expect(recRes.ok).toBe(true);
    }

    // Immediate completion to `recorded` (no second approver)
    const completedStd = (await runAsActionActor(
      'P-000002',
      () =>
        completeClientCddAction!({
          recordId: loaded.summary.record.id,
          manualSummaryNote: 'All standard items checked',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as {
      ok: boolean;
      record: { status: string; dueAt: string | null };
      summary: { riskTier: string };
    };
    expect(completedStd.ok).toBe(true);
    expect(completedStd.record.status).toBe('recorded');
    expect(completedStd.record.dueAt).not.toBeNull();
    const stdYearsDiff =
      new Date(completedStd.record.dueAt!).getUTCFullYear() - new Date().getUTCFullYear();
    expect(stdYearsDiff).toBe(3);

    // Upgrade Standard -> High Risk preserves Standard items & returns status to `in_progress`
    const upgraded = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction!({
          subjectType: 'organisation',
          subjectId: 'O-000004',
          upgradeToHighRisk: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as {
      ok: boolean;
      summary: {
        riskTier: string;
        record: { status: string };
        checklistItems: Array<{ itemKey: string; status: string }>;
      };
    };
    expect(upgraded.ok).toBe(true);
    expect(upgraded.summary.riskTier).toBe('high');
    expect(upgraded.summary.record.status).toBe('in_progress');
    // Standard items still `recorded`; new highAdditional items `pending`
    const pendingHigh = upgraded.summary.checklistItems.filter((i) => i.status === 'pending');
    expect(pendingHigh.length).toBeGreaterThan(0);

    // Record high-risk items & re-complete -> 12 month dueAt
    for (const item of pendingHigh) {
      await runAsActionActor(
        'P-000002',
        () =>
          recordCddChecklistItemAction!({
            recordId: loaded.summary.record.id,
            itemKey: item.itemKey,
            status: 'recorded',
            note: `High risk verified ${item.itemKey}`,
          }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
    }
    const completedHigh = (await runAsActionActor(
      'P-000002',
      () => completeClientCddAction!({ recordId: loaded.summary.record.id }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; record: { status: string; dueAt: string | null } };
    expect(completedHigh.ok).toBe(true);
    expect(completedHigh.record.status).toBe('recorded');
    const highYearsDiff =
      new Date(completedHigh.record.dueAt!).getUTCFullYear() - new Date().getUTCFullYear();
    expect(highYearsDiff).toBe(1);

    // R750 check already executed at start of test 4 above
  }, 30_000);

  it('5. R755: partner on empty-allow-list restricted matter sees register rows & transition history in listRegistersWorkspaceDataRecord & getRegisterRecordDetailRecord', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const matterRepo = new TenantMatterRepository();
    const regRepo = new TenantRegisterRepository();
    const ctx = testTenantCtx('P-000001');

    const baseMatterR755 = await matterRepo.getMatterById<Matter>(ctx, 'M-000001');
    expect(baseMatterR755).not.toBeNull();
    const emptyAllowListMatter = await matterRepo.createMatter<Matter>(ctx, {
      ...baseMatterR755!,
      id: 'M-S104-R755',
      recordType: 'matter',
      matterNumber: 'MAT-S104-R755',
      title: 'Restricted Matter Empty Allow List',
      clientId: 'O-000001',
      instructingContactId: null,
      billingContactId: null,
      matterTypeId: vid('matter_type', 'Commercial'),
      practiceAreaId: 'work_type.corporate_and_commercial',
      workTypeSubcategoryId: 'work_type.corporate_and_commercial_acquisitions',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000002',
      teamMemberIds: ['P-000002'],
      additionalClientIds: [],
      parties: [],
      conflictCheckStatus: 'Cleared',
      conflictCheckDate: '2026-01-10',
      conflictClearedById: 'P-000003',
      conflictNotes: '',
      amlStatus: 'Verified',
      amlCompletedAt: null,
      sourceOfFundsVerified: 'In progress',
      sourceOfWealthVerified: 'N/A',
      engagementLetterStatus: 'Signed',
      engagementLetterSentAt: null,
      engagementLetterSignedAt: '2026-01-10',
      feeEstimateGbp: 5000,
      agreedFeeCapGbp: null,
      retainerMoniesOnAccountGbp: null,
      stageId: vid('matter_stage', 'Stage 1 — Inception & Onboarding'),
      milestoneId: null,
      enquiryReceivedAt: '2026-01-10',
      openedAt: '2026-01-10',
      targetCompletionAt: null,
      closedAt: null,
      matterStatusId: vid('matter_status', 'Active'),
      riskRatingId: 'risk_rating.low',
      createdById: 'P-000001',
      createdAt: '2026-01-10T10:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-01-10T10:00:00.000Z',
      isStaffMatter: true,
      restrictedAccessUserIds: [],
    });

    const createdReg = await runAsActionActor(
      'P-000001',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'R755 Empty Allow List Undertaking',
            matterId: emptyAllowListMatter.id,
            fieldValues: {
              recipientName: 'Partner Visible Bank',
              undertakingTerms: 'Hold title deeds pending completion',
              givenByPersonId: 'P-000001',
            },
          },
          'P-000001',
        ),
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(createdReg.ok).toBe(true);
    if (!createdReg.ok) return;

    await regRepo.lockAndExecuteTransition(ctx, {
      recordId: createdReg.record.id,
      transitionKey: 'discharge',
      actorId: 'P-000001',
      comment: 'Discharged on completion',
      validateAndCompute: async () => ({
        nextStatus: 'discharged',
        mergedFieldValues: createdReg.record.fieldValues,
        setsDecidedAt: true,
      }),
    });

    // Notice P-000001 does NOT hold `matter:restricted:access` by default on ['partner', 'fee_earner'],
    // yet IS `responsiblePartnerId` on the empty-allow-list restricted matter!
    const partnerList = await runAsActionActor(
      'P-000001',
      () => listRegistersWorkspaceDataRecord({ matterId: emptyAllowListMatter.id }, 'P-000001'),
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(partnerList.ok).toBe(true);
    if (partnerList.ok) {
      const found = partnerList.records.find((r) => r.id === createdReg.record.id);
      expect(found).toBeDefined();
      expect(partnerList.transitionsByRecordId[createdReg.record.id]?.length).toBeGreaterThan(0);
    }

    const partnerDetail = await runAsActionActor(
      'P-000001',
      () => getRegisterRecordDetailRecord(createdReg.record.id, 'P-000001'),
      { roles: ['partner', 'fee_earner'], mfaVerified: false },
    );
    expect(partnerDetail.ok).toBe(true);
    if (partnerDetail.ok) {
      expect(partnerDetail.transitions.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('6. Rule 9, R754 & R758: enforces two-tenant isolation, party merge repointing, reminder recipient routing with R747, and non-deletion on anonymiseExpiredEnquiries', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const poolManager = new TenantPostgresPoolManager();
    openPoolManagers.push(poolManager);
    const runner = new TenantMigrationRunner();
    const ctxAlphaAdmin = makeVerifiedTenantCtx('tenant-alpha', 'P-000004', ['admin', 'partner', 'fee_earner', 'risk_compliance']);
    const ctxBravoAdmin = makeVerifiedTenantCtx('tenant-bravo', 'P-000004', ['admin', 'partner', 'fee_earner', 'risk_compliance']);
    await runner.applyUp(ctxAlphaAdmin, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravoAdmin, CORE_TENANT_MIGRATIONS);

    const alphaCfg = loadAndValidateTenantConfig(notALawFirmBaseConfig, { tenantId: 'tenant-alpha', environment: 'test' }, 'test', 'multi_tenant');
    const bravoCfg = loadAndValidateTenantConfig(notALawFirmBaseConfig, { tenantId: 'tenant-bravo', environment: 'test' }, 'test', 'multi_tenant');
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlphaAdmin,
      tenantConfig: alphaCfg,
      clearFirst: true,
      store: createSeedStore(new Date()),
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravoAdmin,
      tenantConfig: bravoCfg,
      clearFirst: true,
      store: createSeedStore(new Date()),
    });

    const regRepo = new TenantRegisterRepository({ poolManager });
    const evidenceRepo = new TenantEvidenceArtifactRepository({ poolManager });
    const intakeRepo = new TenantIntakeCheckRepository({ poolManager });

    const todayYmd = new Date().toISOString().slice(0, 10);
    // Employee-client due reminder (P-000005, owner = P-000006 non-permitted -> R747 must fall back to risk_compliance P-000003, NOT P-000006 or admin!)
    await regRepo.createRegisterRecord(ctxAlphaAdmin, {
      id: 'REG-S104-REM-EMP',
      registerTypeKey: 'cdd',
      reference: 'CDD-S104-REM-EMP',
      title: 'Employee CDD Reminder R747 Test',
      status: 'recorded',
      personId: 'P-000005',
      ownerId: 'P-000006',
      dueAt: `${todayYmd}T12:00:00.000Z`,
      fieldValues: {
        clientCategory: 'individual',
        riskTier: 'standard',
        checklistItems: [
          { itemKey: 'photo_id', label: 'Photo ID', required: true, status: 'recorded', recordedById: 'P-000001', recordedAt: `${todayYmd}T08:00:00.000Z`, evidenceRefs: [] },
        ],
      },
      createdById: 'P-000001',
    });

    // External client due reminder (O-000002, no record owner -> resolves via client owner / recent fee earner / compliance)
    await regRepo.createRegisterRecord(ctxAlphaAdmin, {
      id: 'REG-S104-REM-EXT',
      registerTypeKey: 'cdd',
      reference: 'CDD-S104-REM-EXT',
      title: 'External Org CDD Due Reminder',
      status: 'recorded',
      organisationId: 'O-000002',
      ownerId: 'P-000001',
      dueAt: `${todayYmd}T12:00:00.000Z`,
      fieldValues: {
        clientCategory: 'company_or_llp',
        riskTier: 'standard',
        checklistItems: [
          { itemKey: 'companies_house_record', label: 'Companies House record', required: true, status: 'recorded', recordedById: 'P-000001', recordedAt: `${todayYmd}T08:00:00.000Z`, evidenceRefs: [] },
        ],
      },
      createdById: 'P-000001',
    });

    // Run reminder sweep on tenant-alpha and assert Bravo stays isolated
    const remOutcome = await executeRegisterRemindersForTenant(ctxAlphaAdmin, {
      triggerSource: 'manual',
      triggeredById: 'system:register-reminders',
      defaultRunHourLocal: 0,
      tenantConfig: alphaCfg,
    });
    expect(remOutcome.outcome).toBe('executed');

    const { TenantTaskWorkflowRepository } = await import('../src/index');
    const taskRepo = new TenantTaskWorkflowRepository({ poolManager });
    const p6Notifs = await taskRepo.listNotificationsForUser<NotificationItem>(ctxAlphaAdmin, 'P-000006', { includeRestricted: true });
    expect(p6Notifs.some((n) => n.recordId === 'REG-S104-REM-EMP')).toBe(false);
    const p3Notifs = await taskRepo.listNotificationsForUser<NotificationItem>(ctxAlphaAdmin, 'P-000003', { includeRestricted: true });
    expect(p3Notifs.some((n) => n.recordId === 'REG-S104-REM-EMP')).toBe(true);
    const bravoNotifs = await taskRepo.listNotificationsForUser<NotificationItem>(ctxBravoAdmin, 'P-000003', { includeRestricted: true });
    expect(bravoNotifs.some((n) => n.recordId === 'REG-S104-REM-EMP')).toBe(false);

    // Tampered cross-tenant detail call fails identically to missing ID
    const crossTenantDetail = await runAsActionActor(
      'P-000003',
      () => getRegisterRecordDetailRecord('REG-S104-REM-EMP', 'P-000003', { tenantCtx: ctxBravoAdmin, tenantConfig: bravoCfg }),
      { tenantId: 'tenant-bravo', roles: ['risk_compliance'], mfaVerified: false },
    );
    expect(crossTenantDetail).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    // R754 & R758: Create evidence & intake check for P-000015 -> merge P-000015 into P-000011 -> run anonymiseExpiredEnquiries -> assert repointed & preserved
    await intakeRepo.recordCheck(ctxAlphaAdmin, {
      checkKind: 'identity_verification',
      provider: 'manual',
      subjectType: 'person',
      subjectId: 'P-000015',
      outcome: 'verified',
      metadata: { verificationMethod: 'Passport' },
      evidenceRefs: [],
    });
    await evidenceRepo.createArtifact(ctxAlphaAdmin, {
      blobKey: `tenant-tenant-alpha-test/evidence/p15/passport-${Date.now()}.pdf`,
      subjectType: 'person',
      subjectId: 'P-000015',
      fileName: 'passport.pdf',
      contentType: 'application/pdf',
      byteSize: 1000,
      sha256: 'e'.repeat(64),
      scanStatus: 'clean',
      uploadedByPersonId: 'P-000001',
    });

    const alphaRaw = {
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      tenantId: 'tenant-alpha',
    };
    setActiveTenantConfigForTesting(alphaRaw, {});
    try {
      const mergeRes = await runAsActionActor(
        'P-000003',
        () => executeMerge('person', 'P-000011', 'P-000015', 'P-000003'),
        { tenantId: 'tenant-alpha', roles: ['risk_compliance'], mfaVerified: true },
      );
      expect(mergeRes).toMatchObject({
        id: expect.stringMatching(/^MRG-/),
        survivorId: 'P-000011',
      });

      // Verify intake check & evidence artifacts now under P-000011
      const mergedEvd = await evidenceRepo.listArtifactsForSubject(ctxAlphaAdmin, {
        subjectType: 'person',
        subjectId: 'P-000011',
      });
      expect(mergedEvd.length).toBeGreaterThan(0);

      // R758: anonymiseExpiredEnquiries must NEVER delete CDD register records or evidence artifacts
      const hasAnonFn = typeof (servicesModule as Record<string, unknown>).anonymiseExpiredEnquiries === 'function';
      expect(hasAnonFn).toBe(true);
      await anonymiseExpiredEnquiries('P-000004', undefined, { tenantCtx: ctxAlphaAdmin });
      const stillThereEvd = await evidenceRepo.listArtifactsForSubject(ctxAlphaAdmin, {
        subjectType: 'person',
        subjectId: 'P-000011',
      });
      expect(stillThereEvd.length).toBeGreaterThan(0);
      const stillThereCdd = await regRepo.getRegisterRecordById(ctxAlphaAdmin, 'REG-S104-REM-EXT', {
        canViewCdd: true,
      });
      expect(stillThereCdd).not.toBeNull();
    } finally {
      setActiveTenantConfigForTesting(null);
    }
  }, 45_000);

  it('7a. R765 (Blocking): generic createRegisterRecordAction refuses cdd', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const createRegisterRecordAction = actionsModule.createRegisterRecordAction;

    // Valid client-supplied payload that SUCCEEDS before the fix (forged checklist + standard tier)
    const genCreateRes = (await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'cdd',
          title: 'Forged High-Risk CDD Direct Create',
          personId: 'P-000014',
          fieldValues: {
            clientCategory: 'individual',
            riskTier: 'standard',
            checklistItems: [
              {
                itemKey: 'photo_id',
                label: 'Photo ID',
                required: true,
                status: 'recorded',
                evidenceRefs: [],
              },
            ],
          },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(genCreateRes).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  }, 30_000);

  it('7b. R765 (Blocking): generic updateRegisterRecordAction refuses cdd', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const evidenceRepo = new TenantEvidenceArtifactRepository();
    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const updateRegisterRecordAction = actionsModule.updateRegisterRecordAction;

    const empArtifact = await evidenceRepo.createArtifact(ctx, {
      blobKey: 'tenant-not-a-law-firm-test/evidence/p5/emp-passport-secret.pdf',
      subjectType: 'person',
      subjectId: 'P-000005',
      fileName: 'sian-llewellyn-secret-passport.pdf',
      contentType: 'application/pdf',
      byteSize: 512,
      sha256: 'a'.repeat(64),
      scanStatus: 'clean',
      uploadedByPersonId: 'P-000001',
    });

    const loadedP15 = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null } };
    expect(loadedP15.ok).toBe(true);

    const genUpdateRes = (await runAsActionActor(
      'P-000002',
      () =>
        updateRegisterRecordAction({
          recordId: loadedP15.summary!.record!.id,
          fieldValues: {
            clientCategory: 'individual',
            riskTier: 'standard',
            checklistItems: [
              {
                itemKey: 'photo_id',
                label: 'Photo ID',
                required: true,
                status: 'recorded',
                evidenceRefs: [
                  {
                    blobKey: empArtifact.blobKey,
                    sha256: empArtifact.sha256,
                    contentType: empArtifact.contentType,
                    sizeBytes: empArtifact.byteSize,
                    scanStatus: 'clean',
                    fileName: empArtifact.fileName,
                  },
                ],
              },
            ],
          },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(genUpdateRes).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  }, 30_000);

  it('7c. R765 (Blocking): generic transitionRegisterRecordAction refuses record_cdd, upgrade_to_high_risk, and fieldUpdates on supersede_cdd', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const transitionRegisterRecordAction = actionsModule.transitionRegisterRecordAction;

    const loadedP15 = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null } };
    expect(loadedP15.ok).toBe(true);
    const p15RecordId = loadedP15.summary!.record!.id;

    const genTransRecordCdd = (await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: p15RecordId,
          transitionKey: 'record_cdd',
          comment: 'Bypass checklist completion',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(genTransRecordCdd).toMatchObject({ ok: false, code: 'REGISTER_SYSTEM_ONLY_TRANSITION' });

    const genTransUpgrade = (await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: p15RecordId,
          transitionKey: 'upgrade_to_high_risk',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(genTransUpgrade).toMatchObject({ ok: false, code: 'REGISTER_SYSTEM_ONLY_TRANSITION' });

    const badFieldUpdatesSupersede = (await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: p15RecordId,
          transitionKey: 'supersede_cdd',
          comment: 'Attempt field injection',
          fieldUpdates: { riskTier: 'standard' },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(badFieldUpdatesSupersede).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  }, 30_000);

  it('7d1. R766 & R801 (Blocking / Should fix): strips cross-subject artifacts from summary and checklist items, emitting slim item evidence metadata only', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const regRepo = new TenantRegisterRepository();
    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const uploadRoute = await import('@/app/api/evidence/upload/route');

    // Legitimately upload clean evidence for hidden employee client P-000005 as Risk partner P-000001
    const empForm = new FormData();
    empForm.set('subjectType', 'person');
    empForm.set('subjectId', 'P-000005');
    empForm.set('file', new File([new TextEncoder().encode('%PDF-1.4\n%Emp')], 'sian-llewellyn-secret-passport.pdf', { type: 'application/pdf' }));
    const empUpRes = await runAsActionActor(
      'P-000001',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(empForm)),
      { roles: ['partner', 'risk_compliance'], mfaVerified: false },
    );
    expect(empUpRes.status).toBe(200);
    const empJson = (await empUpRes.json()) as {
      artifact: { id: string };
      evidenceRef: { blobKey: string; sha256: string; contentType: string; sizeBytes: number; scanStatus: 'clean'; fileName?: string };
    };

    const loadedP15 = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null } };
    expect(loadedP15.ok).toBe(true);
    const p15RecordId = loadedP15.summary!.record!.id;

    const cleanPdf = new TextEncoder().encode('%PDF-1.4\n%Valid P15 Evidence');
    const upForm = new FormData();
    upForm.set('subjectType', 'person');
    upForm.set('subjectId', 'P-000015');
    upForm.set('file', new File([cleanPdf], 'p15-id.pdf', { type: 'application/pdf' }));
    const upRes = await runAsActionActor(
      'P-000002',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(upForm)),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(upRes.status).toBe(200);
    const upJson = (await upRes.json()) as {
      artifact: { id: string };
      evidenceRef: { blobKey: string; sha256: string; contentType: string; sizeBytes: number; scanStatus: 'clean'; fileName?: string };
    };

    const p15RecPre = (await regRepo.getRegisterRecordById(ctx, p15RecordId, { canViewCdd: true }))!;
    const existingItems = (p15RecPre.fieldValues.checklistItems ?? []) as Array<Record<string, unknown>>;
    const tamperedItems = existingItems.map((it, idx) =>
      idx === 0
        ? { ...it, evidenceRefs: [upJson.evidenceRef, empJson.evidenceRef] }
        : it,
    );
    await regRepo.updateRegisterRecordDetails(ctx, {
      recordId: p15RecordId,
      updatedById: 'P-000002',
      fieldValues: {
        ...p15RecPre.fieldValues,
        checklistItems: tamperedItems,
        supportingEvidence: [upJson.evidenceRef, empJson.evidenceRef],
      },
    });
    const r766SummaryRes = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'person', subjectId: 'P-000015' }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as {
      ok: boolean;
      summary?: {
        visible: boolean;
        evidenceRefs: Array<{ blobKey: string; fileName?: string }>;
        checklistItems: Array<{
          itemKey: string;
          evidenceRefs: CddChecklistItemEvidenceSummary[];
        }>;
      };
    };
    expect(r766SummaryRes.ok).toBe(true);
    expect(r766SummaryRes.summary?.visible).toBe(true);
    expect(r766SummaryRes.summary?.evidenceRefs.some((r) => r.blobKey === upJson.evidenceRef.blobKey)).toBe(true);
    expect(r766SummaryRes.summary?.evidenceRefs.some((r) => r.blobKey === empJson.evidenceRef.blobKey)).toBe(false);

    // R801: Item-level evidenceRefs carries slim metadata only for verified same-subject artifact (no cross-subject ref, no blobKey)
    const firstItem = r766SummaryRes.summary?.checklistItems[0];
    expect(firstItem?.evidenceRefs).toHaveLength(1);
    expect(firstItem?.evidenceRefs[0]).toMatchObject({
      artifactId: upJson.artifact.id,
      displayName: 'p15-id.pdf',
      downloadable: true,
    });
    expect(firstItem?.evidenceRefs[0]?.downloadUrl).toMatch(/^\/api\/evidence\/download\?token=/);
    expect(Object.keys(firstItem!.evidenceRefs[0]!).sort()).toEqual([
      'artifactId',
      'displayName',
      'downloadUrl',
      'downloadable',
    ]);
    const serialisedSummary = JSON.stringify(r766SummaryRes.summary);
    expect(serialisedSummary).not.toContain('sian-llewellyn-secret-passport.pdf');
    expect(serialisedSummary).not.toContain(empJson.evidenceRef.blobKey);
    expect(serialisedSummary).not.toContain(empJson.artifact.id);
  }, 30_000);

  it('7d2. R766 (Blocking): resolveEvidenceRefsDownloadable isolates pending-scan or unstored blobs without breaking CDD card', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const regRepo = new TenantRegisterRepository();
    const evidenceRepo = new TenantEvidenceArtifactRepository();
    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const uploadRoute = await import('@/app/api/evidence/upload/route');

    const loadedP15 = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null } };
    expect(loadedP15.ok).toBe(true);
    const p15RecordId = loadedP15.summary!.record!.id;

    const cleanPdf = new TextEncoder().encode('%PDF-1.4\n%Valid P15 Evidence');
    const upForm = new FormData();
    upForm.set('subjectType', 'person');
    upForm.set('subjectId', 'P-000015');
    upForm.set('file', new File([cleanPdf], 'p15-id.pdf', { type: 'application/pdf' }));
    const upRes = await runAsActionActor(
      'P-000002',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(upForm)),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(upRes.status).toBe(200);
    const upJson = (await upRes.json()) as {
      evidenceRef: { blobKey: string; sha256: string; contentType: string; sizeBytes: number; scanStatus: 'clean'; fileName?: string };
    };

    // DB artifact marked clean whose blob is absent from storage (storage.getMalwareScanStatus returns 'pending' -> throws STORAGE_MALWARE_GATE)
    const pendingArtifact = await evidenceRepo.createArtifact(ctx, {
      blobKey: 'tenant-not-a-law-firm-test/evidence/p15/pending-never-stored.pdf',
      subjectType: 'person',
      subjectId: 'P-000015',
      fileName: 'pending-never-stored.pdf',
      contentType: 'application/pdf',
      byteSize: 200,
      sha256: 'b'.repeat(64),
      scanStatus: 'clean',
      uploadedByPersonId: 'P-000002',
    });

    const p15RecPre = (await regRepo.getRegisterRecordById(ctx, p15RecordId, { canViewCdd: true }))!;
    await regRepo.updateRegisterRecordDetails(ctx, {
      recordId: p15RecordId,
      updatedById: 'P-000002',
      fieldValues: {
        ...p15RecPre.fieldValues,
        supportingEvidence: [upJson.evidenceRef, {
          blobKey: pendingArtifact.blobKey,
          sha256: pendingArtifact.sha256,
          contentType: pendingArtifact.contentType,
          sizeBytes: pendingArtifact.byteSize,
          scanStatus: 'clean',
          fileName: pendingArtifact.fileName,
        }],
      },
    });
    const r766SummaryRes = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'person', subjectId: 'P-000015' }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { visible: boolean; evidenceRefs: Array<{ blobKey: string }> } };
    expect(r766SummaryRes.ok).toBe(true);
    expect(r766SummaryRes.summary?.visible).toBe(true);
    expect(r766SummaryRes.summary?.evidenceRefs.some((r) => r.blobKey === upJson.evidenceRef.blobKey)).toBe(true);
  }, 30_000);

  it('7e. R770, R772, R773 & R774: matches NOT_FOUND, prevents lost/duplicate CDD writes, blocks Standard completion on High risk, and writes audit inside TX', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const regRepo = new TenantRegisterRepository();
    const matterRepo = new TenantMatterRepository();

    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const recordCddChecklistItemAction = actionsModule.recordCddChecklistItemAction;
    const completeClientCddAction = actionsModule.completeClientCddAction;
    const transitionRegisterRecordAction = actionsModule.transitionRegisterRecordAction;

    // Employee CDD for P-000005 and external client CDD for P-000015
    const empCdd = await regRepo.createRegisterRecord(ctx, {
      id: 'REG-S104-T7-EMP',
      registerTypeKey: 'cdd',
      reference: 'CDD-S104-T7-EMP',
      title: 'Employee CDD Hidden Target',
      status: 'recorded',
      personId: 'P-000005',
      ownerId: 'P-000001',
      fieldValues: { clientCategory: 'individual', riskTier: 'standard', checklistItems: [] },
      createdById: 'P-000001',
    });

    const loadedP15 = (await runAsActionActor(
      'P-000002',
      () =>
        startOrLoadClientCddAction({
          subjectType: 'person',
          subjectId: 'P-000015',
          createIfMissing: true,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string; rowVersion: number } | null; checklistItems: Array<{ itemKey: string; label: string }> } };
    expect(loadedP15.ok).toBe(true);
    const p15RecordId = loadedP15.summary!.record!.id;

    // R770: Hidden employee-client CDD ID vs missing ID must return identical NOT_FOUND across all record-by-ID services
    const missingId = 'REG-S104-DOES-NOT-EXIST';
    const [hiddenDetail, missingDetail] = await runAsActionActor(
      'P-000006',
      () => Promise.all([
        getRegisterRecordDetailRecord(empCdd.id, 'P-000006'),
        getRegisterRecordDetailRecord(missingId, 'P-000006'),
      ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(hiddenDetail).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(hiddenDetail).toEqual(missingDetail);

    const [hiddenRecItem, missingRecItem] = await runAsActionActor(
      'P-000006',
      () => Promise.all([
        recordCddChecklistItemRecord({ recordId: empCdd.id, itemKey: 'photo_id', status: 'recorded' }, 'P-000006'),
        recordCddChecklistItemRecord({ recordId: missingId, itemKey: 'photo_id', status: 'recorded' }, 'P-000006'),
      ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(hiddenRecItem).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(hiddenRecItem).toEqual(missingRecItem);

    const [hiddenComplete, missingComplete] = await runAsActionActor(
      'P-000006',
      () => Promise.all([
        completeClientCddRecord({ recordId: empCdd.id }, 'P-000006'),
        completeClientCddRecord({ recordId: missingId }, 'P-000006'),
      ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(hiddenComplete).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(hiddenComplete).toEqual(missingComplete);

    const [hiddenTrans, missingTrans] = await runAsActionActor(
      'P-000006',
      () => Promise.all([
        transitionRegisterRecordService({ recordId: empCdd.id, transitionKey: 'archive_cdd', comment: 'Probe' }, 'P-000006'),
        transitionRegisterRecordService({ recordId: missingId, transitionKey: 'archive_cdd', comment: 'Probe' }, 'P-000006'),
      ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(hiddenTrans).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(hiddenTrans).toEqual(missingTrans);

    const [hiddenUpd, missingUpd] = await runAsActionActor(
      'P-000006',
      () => Promise.all([
        updateRegisterRecordDetailsService({ recordId: empCdd.id, title: 'Probe' }, 'P-000006'),
        updateRegisterRecordDetailsService({ recordId: missingId, title: 'Probe' }, 'P-000006'),
      ]),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(hiddenUpd).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(hiddenUpd).toEqual(missingUpd);

    // R772: Concurrent creates on O-000006 via Promise.all produce 1 live CDD record;
    // concurrent item updates on O-000006 preserve both items; archived CDD rejects item edits
    const [concCreateA, concCreateB] = (await Promise.all([
      runAsActionActor('P-000002', () => startOrLoadClientCddAction({ subjectType: 'organisation', subjectId: 'O-000006', createIfMissing: true }), { roles: ['fee_earner'], mfaVerified: false }),
      runAsActionActor('P-000002', () => startOrLoadClientCddAction({ subjectType: 'organisation', subjectId: 'O-000006', createIfMissing: true }), { roles: ['fee_earner'], mfaVerified: false }),
    ])) as Array<{ ok: boolean; summary?: { record?: { id: string } | null; checklistItems: Array<{ itemKey: string }> } }>;
    expect(concCreateA.ok).toBe(true);
    expect(concCreateB.ok).toBe(true);
    expect(concCreateA.summary?.record?.id).toBe(concCreateB.summary?.record?.id);
    const liveO6 = await regRepo.listVisibleRegisterRecords(ctx, 'P-000001', {
      registerTypeKey: 'cdd',
      organisationId: 'O-000006',
      canViewCdd: true,
    });
    expect(liveO6.filter((r) => r.status === 'in_progress' || r.status === 'recorded')).toHaveLength(1);

    const o6Id = concCreateA.summary!.record!.id;
    const o6Items = concCreateA.summary!.checklistItems;
    expect(o6Items.length).toBeGreaterThanOrEqual(2);
    const [concItemA, concItemB] = (await Promise.all([
      runAsActionActor('P-000002', () => recordCddChecklistItemAction({ recordId: o6Id, itemKey: o6Items[0]!.itemKey, status: 'recorded', note: 'Concurrent A' }), { roles: ['fee_earner'], mfaVerified: false }),
      runAsActionActor('P-000002', () => recordCddChecklistItemAction({ recordId: o6Id, itemKey: o6Items[1]!.itemKey, status: 'recorded', note: 'Concurrent B' }), { roles: ['fee_earner'], mfaVerified: false }),
    ])) as Array<{ ok: boolean }>;
    expect(concItemA.ok).toBe(true);
    expect(concItemB.ok).toBe(true);
    const o6AfterItems = (await regRepo.getRegisterRecordById(ctx, o6Id, { canViewCdd: true }))!;
    const savedO6Items = o6AfterItems.fieldValues.checklistItems as Array<{ itemKey: string; status: string }>;
    expect(savedO6Items.find((i) => i.itemKey === o6Items[0]!.itemKey)?.status).toBe('recorded');
    expect(savedO6Items.find((i) => i.itemKey === o6Items[1]!.itemKey)?.status).toBe('recorded');

    // Archive P-000015 CDD cleanly, then assert recordCddChecklistItemAction refuses edits on archived records
    const archRes = (await runAsActionActor(
      'P-000002',
      () => transitionRegisterRecordAction({ recordId: p15RecordId, transitionKey: 'archive_cdd', comment: 'Archived client' }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean };
    expect(archRes.ok).toBe(true);
    const editArchivedRes = (await runAsActionActor(
      'P-000002',
      () => recordCddChecklistItemAction({ recordId: p15RecordId, itemKey: loadedP15.summary!.checklistItems[0]!.itemKey, status: 'recorded', note: 'Edit after archive' }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; denied?: boolean; code?: string };
    expect(editArchivedRes).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    // R773: Standard CDD completion refused when client O-000006 has an active High-risk matter
    for (const item of o6Items) {
      await runAsActionActor(
        'P-000002',
        () => recordCddChecklistItemAction({ recordId: o6Id, itemKey: item.itemKey, status: 'recorded', note: `Recorded ${item.itemKey}` }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
    }
    const baseMatter = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001'))!;
    await matterRepo.createMatter<Matter>(ctx, {
      ...baseMatter,
      id: 'M-S104-HR-O6',
      recordType: 'matter',
      matterNumber: 'S104-HR-0006',
      title: 'High Risk Matter Requiring Enhanced CDD',
      clientId: 'O-000006',
      riskRatingId: 'risk_rating.high',
      matterStatusId: vid('matter_status', 'Active'),
    });
    const completeStdOnHighRes = (await runAsActionActor(
      'P-000002',
      () => completeClientCddAction({ recordId: o6Id }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; code?: string; message?: string; error?: string };
    expect(completeStdOnHighRes).toMatchObject({ ok: false, code: 'REGISTER_VALIDATION_ERROR' });

    // Upgrade to High risk, complete remaining items, then verify R774 audit failure rolls back completeClientCddAction
    const upgradedO6 = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'organisation', subjectId: 'O-000006', upgradeToHighRisk: true }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { checklistItems: Array<{ itemKey: string; status: string }> } };
    expect(upgradedO6.ok).toBe(true);
    for (const item of upgradedO6.summary!.checklistItems.filter((i) => i.status === 'pending')) {
      await runAsActionActor(
        'P-000002',
        () => recordCddChecklistItemAction({ recordId: o6Id, itemKey: item.itemKey, status: 'recorded', note: `Enhanced ${item.itemKey}` }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
    }

    setAuditAdapterFailureHookForTesting(() => {
      throw new Error('Simulated TX audit failure for R774');
    });
    const rollbackRes = (await runAsActionActor(
      'P-000002',
      () => completeClientCddAction({ recordId: o6Id }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok?: boolean; code?: string };
    setAuditAdapterFailureHookForTesting(null);
    expect(rollbackRes).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });

    const o6RolledBack = await regRepo.getRegisterRecordById(ctx, o6Id, { canViewCdd: true });
    expect(o6RolledBack?.status).toBe('in_progress');
  }, 45_000);

  it('7f. R799, R800 & Suggestion 9: derives CDD tier firm-wide without exposing restricted matters, gives NOT_FOUND parity to admin without cdd:record, and rejects extra cdd register fields', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const matterRepo = new TenantMatterRepository();
    const startOrLoadClientCddAction = actionsModule.startOrLoadClientCddAction;
    const recordCddChecklistItemAction = actionsModule.recordCddChecklistItemAction;
    const completeClientCddAction = actionsModule.completeClientCddAction;

    // R799: P-000014 starts Standard CDD, then gets a High-risk restricted staff matter hidden from P-000002
    const stdLoad = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'person', subjectId: 'P-000014', createIfMissing: true }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { record?: { id: string } | null; checklistItems: Array<{ itemKey: string }> } };
    expect(stdLoad.ok).toBe(true);
    const p14RecId = stdLoad.summary!.record!.id;
    for (const item of stdLoad.summary!.checklistItems) {
      await runAsActionActor(
        'P-000002',
        () => recordCddChecklistItemAction({ recordId: p14RecId, itemKey: item.itemKey, status: 'recorded', note: 'OK' }),
        { roles: ['fee_earner'], mfaVerified: false },
      );
    }

    const baseMatter = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001'))!;
    await matterRepo.createMatter<Matter>(ctx, {
      ...baseMatter,
      id: 'M-S104-R799-STAFF',
      recordType: 'matter',
      matterNumber: 'S104-R799-0001',
      title: 'Confidential Executive High Risk Matter',
      clientId: 'P-000014',
      riskRatingId: 'risk_rating.high',
      matterStatusId: vid('matter_status', 'Active'),
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000001',
      teamMemberIds: ['P-000001'],
      isStaffMatter: true,
      restrictedAccessUserIds: ['P-000001'],
    });

    // Fee earner P-000002 cannot see M-S104-R799-STAFF, yet card shows High risk & needsUpgradeToHighRisk=true with zero matter leak
    const cardForOutsider = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'person', subjectId: 'P-000014' }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { derivedRiskTier: string; riskTier: string; needsUpgradeToHighRisk: boolean } };
    expect(cardForOutsider.ok).toBe(true);
    expect(cardForOutsider.summary?.riskTier).toBe('standard');
    expect(cardForOutsider.summary?.derivedRiskTier).toBe('high');
    expect(cardForOutsider.summary?.needsUpgradeToHighRisk).toBe(true);
    expect(JSON.stringify(cardForOutsider.summary)).not.toContain('Confidential Executive High Risk Matter');
    expect(JSON.stringify(cardForOutsider.summary)).not.toContain('M-S104-R799-STAFF');

    const completeStd = (await runAsActionActor(
      'P-000002',
      () => completeClientCddAction({ recordId: p14RecId }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; code?: string };
    expect(completeStd).toMatchObject({ ok: false, code: 'REGISTER_VALIDATION_ERROR' });

    const upgradeRes = (await runAsActionActor(
      'P-000002',
      () => startOrLoadClientCddAction({ subjectType: 'person', subjectId: 'P-000014', upgradeToHighRisk: true }),
      { roles: ['fee_earner'], mfaVerified: false },
    )) as { ok: boolean; summary?: { riskTier: string; needsUpgradeToHighRisk: boolean } };
    expect(upgradeRes.ok).toBe(true);
    expect(upgradeRes.summary?.riskTier).toBe('high');
    expect(upgradeRes.summary?.needsUpgradeToHighRisk).toBe(false);

    // R800: Admin holding register:view & register:edit, WITHOUT cdd:view/cdd:record, receives equal NOT_FOUND on existing vs missing CDD ID
    const partyRepo7f = new TenantPartyRepository();
    const seededBaseEmp = (await partyRepo7f.getPersonById<Person>(ctx, 'P-000004'))!;
    const pureAdmin7f: Person = {
      ...seededBaseEmp,
      id: 'P-S104-7F-ADMIN',
      entraObjectId: undefined,
      firstName: 'Alun',
      surname: 'Admin7f',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      permissionOverrides: { grant: [], revoke: [] },
      emails: [
        {
          id: 'em-s104-7f-admin',
          address: 'alun.admin7f@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    await partyRepo7f.putPeople(ctx, [pureAdmin7f]);

    const missingId = 'REG-S104-ADMIN-MISSING';
    const [adminDetReal, adminDetMissing] = await runAsActionActor(
      pureAdmin7f.id,
      () => Promise.all([
        getRegisterRecordDetailRecord(p14RecId, pureAdmin7f.id),
        getRegisterRecordDetailRecord(missingId, pureAdmin7f.id),
      ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminDetReal).toMatchObject({ ok: false, code: 'NOT_FOUND', message: 'Register record was not found.' });
    expect(adminDetReal).toEqual(adminDetMissing);

    const [adminTransReal, adminTransMissing] = await runAsActionActor(
      pureAdmin7f.id,
      () => Promise.all([
        transitionRegisterRecordService({ recordId: p14RecId, transitionKey: 'archive_cdd', comment: 'Admin probe' }, pureAdmin7f.id),
        transitionRegisterRecordService({ recordId: missingId, transitionKey: 'archive_cdd', comment: 'Admin probe' }, pureAdmin7f.id),
      ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminTransReal).toMatchObject({ ok: false, code: 'NOT_FOUND', message: 'Register record was not found.' });
    expect(adminTransReal).toEqual(adminTransMissing);

    const [adminUpdReal, adminUpdMissing] = await runAsActionActor(
      pureAdmin7f.id,
      () => Promise.all([
        updateRegisterRecordDetailsService({ recordId: p14RecId, title: 'Admin probe' }, pureAdmin7f.id),
        updateRegisterRecordDetailsService({ recordId: missingId, title: 'Admin probe' }, pureAdmin7f.id),
      ]),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminUpdReal).toMatchObject({ ok: false, code: 'NOT_FOUND', message: 'Register record was not found.' });
    expect(adminUpdReal).toEqual(adminUpdMissing);

    // Suggestion 9: Schema + Zod reject typeOverrides.cdd.additionalFields
    expect(() =>
      loadAndValidateTenantConfig(
        {
          ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
          registers: {
            ...(notALawFirmBaseConfig as unknown as { registers: Record<string, unknown> }).registers,
            typeOverrides: {
              cdd: {
                additionalFields: [
                  { key: 'customFlag', label: 'Custom', type: 'text' },
                ],
              },
            },
          },
        },
        {},
        'test',
        'multi_tenant',
      ),
    ).toThrow(/cdd/i);
    expect(registersConfigJsonSchema.properties.typeOverrides).toHaveProperty('allOf');
  }, 45_000);
});
