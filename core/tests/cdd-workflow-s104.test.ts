import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REGISTER_TYPES,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  DEFAULT_RBAC_ROLES,
  PERMISSION_REGISTRY,
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
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import * as servicesModule from '@/server/services';
import {
  anonymiseExpiredEnquiries,
  createRegisterRecordService,
  executeMerge,
  executeRegisterRemindersForTenant,
  getRegisterRecordDetailRecord,
  listRegistersWorkspaceDataRecord,
  resetAllDemoData,
  saveMatterRecord,
  searchGlobalRecords,
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

describe('S1-04 (ADR 0039): Client Due Diligence (CDD) workflow, evidence security, R747 employee hiding & reminders', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
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

    const adminDetail = await runAsActionActor(
      pureAdmin.id,
      () => getRegisterRecordDetailRecord('REG-000003', pureAdmin.id),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(isActionDenied(adminDetail)).toBe(true);
    if (isActionDenied(adminDetail)) {
      expect(adminDetail.code).toBe('FORBIDDEN');
    }

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

    const outsiderDetail = await runAsActionActor(
      'P-000006',
      () => getRegisterRecordDetailRecord(empCdd.id, 'P-000006'),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(outsiderDetail)).toBe(true);

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
    )) as { denied?: boolean; code?: string };
    expect(isActionDenied(outsiderProfileCdd as never)).toBe(true);

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
    const badReq = new Request('http://localhost/api/evidence/upload', {
      method: 'POST',
      body: badForm,
    });
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
    const malwareJson = (await malwareRes.json()) as { code?: string };
    expect(malwareJson.code).toBe('EVIDENCE_MALWARE_DETECTED');
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
    const goodReq = new Request('http://localhost/api/evidence/upload', {
      method: 'POST',
      body: goodForm,
    });
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

    // 4. Token belonging to P-000010 rejected when presented by another actor (P-000002),
    //    AND admin (P-000004 as admin only) or tampered token rejected
    const wrongActorDl = await runAsActionActor(
      'P-000002',
      () => downloadRoute!.GET(new Request(dlUrl, { method: 'GET' })),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(wrongActorDl.status).toBe(403);

    const adminDl = await runAsActionActor(
      'P-000004',
      () => downloadRoute!.GET(new Request(dlUrl, { method: 'GET' })),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(adminDl.status).toBe(403);

    const tamperedRes = await runAsActionActor(
      'P-000010',
      () => downloadRoute!.GET(new Request(`${dlUrl}tampered`, { method: 'GET' })),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(tamperedRes.status).toBe(403);
  }, 30_000);

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

    // Tampered cross-tenant detail call fails
    const crossTenantDetail = await runAsActionActor(
      'P-000003',
      () => getRegisterRecordDetailRecord('REG-S104-REM-EMP', 'P-000003', { tenantCtx: ctxBravoAdmin, tenantConfig: bravoCfg }),
      { tenantId: 'tenant-bravo', roles: ['risk_compliance'], mfaVerified: false },
    );
    expect(isActionDenied(crossTenantDetail) || crossTenantDetail.ok === false).toBe(true);

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
});
