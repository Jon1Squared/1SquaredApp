import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectMigrationClient,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantHrAndRbacRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  type TenantConfiguration,
  type TenantContext,
  type TenantPersonRecord,
  type TenantTeamRecord,
} from '@platform/core';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  getAppSnapshot,
  getEmployeeDetailsForUser,
  getHrAndRbacRepository,
  getPartyRepository,
  logEmployeeRestrictedAccess,
  previewRbacOverrides,
  reassignLeaverOwnedRecords,
  resetAllDemoData,
  savePersonRecord,
  saveTeamRecord,
  updateTenantRbacConfig,
} from '@/server/services';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import type { EmployeeSensitiveRecord, EmploymentRecord, Person } from '@/domain/types';

afterEach(() => {
  setTestEntraSessionOverride(null);
});

function makeTenantContext(
  tenantId: 'tenant-a' | 'tenant-b',
  actorId = `actor-${tenantId}`,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${tenantId}`,
      email: `actor@${tenantId}.example`,
      roles: ['admin', 'managing_partner', 'partner', 'fee_earner'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s017b-${tenantId}`,
  });
}

function makeHostActorAndContext(actorPersonId = 'P-000001') {
  const cfg = getActiveTenantConfiguration();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const roles = [
    'admin',
    'managing_partner',
    'partner',
    'fee_earner',
    'enquiries_coordinator',
    'finance',
    'risk_compliance',
  ];
  const cookieVal = createSignedEntraSessionCookie({
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    oid: `00000000-0000-4000-8000-${actorPersonId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: actorPersonId,
    email: `${actorPersonId.toLowerCase()}@${cfg.branding.primaryDomain}`,
    displayName: `Test Actor ${actorPersonId}`,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verified = verifySignedEntraSessionCookie(cookieVal)!;
  setTestEntraSessionOverride(verified);
  const ctx = resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verified, {
      correlationId: `corr-s017b-host-${actorPersonId}`,
    }),
    cfg,
  );
  const actorSession = {
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    tokenRoles: verified.mappedRoles,
    mfaVerified: true,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession: verified,
  };
  return { ctx, actorSession };
}

function makeSamplePerson(id: string, email: string): TenantPersonRecord {
  return {
    id,
    recordType: 'person',
    recordOwnerId: id,
    recordStatusId: 'person_record_status.active',
    createdById: id,
    createdAt: '2026-11-11T09:00:00.000Z',
    updatedById: id,
    updatedAt: '2026-11-11T09:00:00.000Z',
    sourceId: null,
    lastVerifiedAt: '2026-11-11',
    tags: [],
    duplicateStatusId: 'duplicate_status.none',
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    lastInteractionAt: '2026-11-11',
    customFields: {},
    titleId: null,
    firstName: 'Carys',
    middleNames: '',
    surname: `Employee-${id}`,
    preferredName: '',
    dateOfBirth: '1988-04-12',
    otherNames: [],
    jobTitle: 'Senior Associate',
    emails: [
      {
        id: `em-${id}-1`,
        address: email,
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
    relationshipRoleIds: [],
    originId: null,
    firstKnownAt: '2024-01-10',
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
    departmentId: 'DEPT-CORP',
    appRole: 'fee_earner',
    roles: ['fee_earner'],
    entraObjectId: `oid-${id}`,
  };
}

describe('S0-17b: PostgreSQL HR, Teams & RBAC Repository, R408/R410/R413/R417/R421/R460, and Audit Atomicity', () => {
  it('enforces two-tenant isolation, forged-claim rejection, single-connection SET LOCAL ROLE, R402 privileges, and R460 sequence privileges across teams, HR records, and RBAC overrides', async () => {
    const ctxA = makeTenantContext('tenant-a');
    const ctxB = makeTenantContext('tenant-b');
    const poolMgr = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
    const partyRepo = new TenantPartyRepository({ poolManager: poolMgr });
    const hrRepo = new TenantHrAndRbacRepository({ poolManager: poolMgr });

    try {
      await partyRepo.clearTenantData(ctxA);
      await partyRepo.clearTenantData(ctxB);
      await hrRepo.clearTenantData(ctxA);
      await hrRepo.clearTenantData(ctxB);

      const personA = makeSamplePerson('P-HR-A1', 'carys.a@tenant-a.example');
      const personB = makeSamplePerson('P-HR-B1', 'carys.b@tenant-b.example');
      await partyRepo.putPeople(ctxA, [personA]);
      await partyRepo.putPeople(ctxB, [personB]);

      const teamAId = await hrRepo.allocateNextTeamId(ctxA);
      const teamBId = await hrRepo.allocateNextTeamId(ctxB);
      expect(teamAId).toMatch(/^TM-\d{6}$/);
      expect(teamBId).toMatch(/^TM-\d{6}$/);

      const teamA: TenantTeamRecord = {
        id: teamAId,
        name: 'Tenant A Corporate',
        description: 'Corporate team A',
        memberIds: ['P-HR-A1'],
        leadIds: ['P-HR-A1'],
        practiceAreaIds: ['work_type.corporate'],
        active: true,
        createdById: ctxA.actorId,
        createdAt: '2026-11-11T10:00:00.000Z',
        updatedById: ctxA.actorId,
        updatedAt: '2026-11-11T10:00:00.000Z',
      };
      const teamB: TenantTeamRecord = {
        id: teamBId,
        name: 'Tenant B Disputes',
        description: 'Disputes team B',
        memberIds: ['P-HR-B1'],
        leadIds: ['P-HR-B1'],
        practiceAreaIds: ['work_type.litigation'],
        active: true,
        createdById: ctxB.actorId,
        createdAt: '2026-11-11T10:00:00.000Z',
        updatedById: ctxB.actorId,
        updatedAt: '2026-11-11T10:00:00.000Z',
      };
      await hrRepo.putTeam(ctxA, teamA);
      await hrRepo.putTeam(ctxB, teamB);

      await hrRepo.putEmploymentRecord(ctxA, 'P-HR-A1', {
        personId: 'P-HR-A1',
        status: 'Active',
        engagementType: 'Employee',
        jobTitle: 'Corporate Associate A',
        departmentId: 'DEPT-CORP',
        effectiveFrom: '2024-02-01',
        contract: {
          startDate: '2024-02-01',
          leavingDate: null,
          noticeEndDate: null,
          hrRetentionUntil: '2031-02-01',
        },
        payroll: {
          salaryOrDrawingsGbp: 78000,
          nationalInsuranceNumber: 'QQ123456C',
        },
        systems: {
          firmWorkEmail: 'carys.work.a@tenant-a.example',
        },
        updatedAt: '2026-11-11T10:05:00.000Z',
        updatedById: ctxA.actorId,
      });

      await hrRepo.putSensitiveRecord(ctxA, {
        personId: 'P-HR-A1',
        reasonableAdjustmentsNeeded: 'Standing desk A',
        diversity: { disability: 'No' },
        updatedById: ctxA.actorId,
        updatedAt: '2026-11-11T10:05:00.000Z',
      });

      await hrRepo.putMigrationReport(ctxA, {
        migratedAt: '2026-11-11T10:05:00.000Z',
        employeesMigrated: 1,
      });

      await hrRepo.putRbacConfigOverride(
        ctxA,
        {
          roles: {
            fee_earner: {
              key: 'fee_earner',
              label: 'Fee Earner A',
              permissions: ['matter:edit', 'task:edit'],
            },
          },
        },
        ctxA.actorId,
      );

      // Positive control: Tenant A reads its own records; Tenant B reads only its own
      const teamsA = await hrRepo.listAllTeams(ctxA);
      const teamsB = await hrRepo.listAllTeams(ctxB);
      expect(teamsA.map((t) => t.name)).toEqual(['Tenant A Corporate']);
      expect(teamsB.map((t) => t.name)).toEqual(['Tenant B Disputes']);

      expect(await hrRepo.getEmploymentRecord(ctxA, 'P-HR-A1')).toMatchObject({
        jobTitle: 'Corporate Associate A',
      });
      expect(await hrRepo.getEmploymentRecord(ctxB, 'P-HR-A1')).toBeNull();

      expect(await hrRepo.getSensitiveRecord(ctxA, 'P-HR-A1')).toMatchObject({
        reasonableAdjustmentsNeeded: 'Standing desk A',
      });
      expect(await hrRepo.getSensitiveRecord(ctxB, 'P-HR-A1')).toBeNull();

      expect(await hrRepo.getMigrationReport(ctxA)).toMatchObject({
        employeesMigrated: 1,
      });
      expect(await hrRepo.getMigrationReport(ctxB)).toBeNull();

      expect(await hrRepo.getRbacConfigOverride(ctxA)).toMatchObject({
        roles: {
          fee_earner: { label: 'Fee Earner A' },
        },
      });
      expect(await hrRepo.getRbacConfigOverride(ctxB)).toBeNull();

      // Forged tenant claim is rejected with TENANCY_FORGERY_DETECTED and invalid context is rejected with TENANCY_ISOLATION_ERROR
      expect(() =>
        resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: 'actor-a',
            tenantId: 'tenant-a',
            name: 'Actor A',
            email: 'actor@tenant-a.example',
            roles: ['admin'],
            mfaVerified: true,
          },
          hostingMode: 'multi_tenant',
          environment: 'test',
          correlationId: 'corr-forged',
          untrustedRequestTenantOverride: 'tenant-b',
        }),
      ).toThrow(/TENANCY_FORGERY_DETECTED/);

      const forgedCtx = Object.freeze({
        ...ctxA,
        tenantId: '',
      }) as unknown as TenantContext;
      await expect(hrRepo.listAllTeams(forgedCtx)).rejects.toThrow(
        /TENANCY_ISOLATION_ERROR/,
      );

      // Single-connection role switching & R402 / R460 verification on raw connection
      const { pool: poolA } = await poolMgr.getPoolForTenant(ctxA);
      const rawClient = await poolA.connect();
      try {
        for (const tableName of [
          'teams',
          'employee_employment_records',
          'employee_sensitive_records',
          'tenant_rbac_configs',
        ]) {
          // Base login role without SET LOCAL ROLE is denied table access (R402)
          await expect(
            rawClient.query(`SELECT * FROM public.${tableName}`),
          ).rejects.toMatchObject({
            code: '42501',
            message: expect.stringMatching(
              new RegExp(`permission denied for (table ${tableName}|schema public)`, 'i'),
            ),
          });
        }

        // Cross-tenant role on single connection is also denied (42501)
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_b_test"');
        await expect(
          rawClient.query('SELECT * FROM public.teams'),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(/permission denied for (table teams|schema public)/i),
        });
        await rawClient.query('ROLLBACK');

        // R460: role_tenant_tenant_a_test has USAGE, SELECT on tenant_team_id_seq, but UPDATE (setval) is denied with 42501
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_a_test"');
        await expect(
          rawClient.query("SELECT setval('public.tenant_team_id_seq', 999999, true)"),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(/permission denied for sequence tenant_team_id_seq/i),
        });
        await rawClient.query('ROLLBACK');
      } finally {
        rawClient.release();
      }
    } finally {
      await poolMgr.closeAllPools();
    }
  });

  it('enforces ON DELETE RESTRICT on employee_employment_records and employee_sensitive_records so statutory HR retention records cannot be cascade-deleted with people (R413)', async () => {
    const ctx = makeTenantContext('tenant-a');
    const poolMgr = new TenantPostgresPoolManager();
    const partyRepo = new TenantPartyRepository({ poolManager: poolMgr });
    const hrRepo = new TenantHrAndRbacRepository({ poolManager: poolMgr });

    try {
      await partyRepo.clearTenantData(ctx);
      await hrRepo.clearTenantData(ctx);

      const empPerson = makeSamplePerson('P-RETENTION-1', 'retention@tenant-a.example');
      await partyRepo.putPeople(ctx, [empPerson]);
      await hrRepo.putEmploymentRecord(ctx, 'P-RETENTION-1', {
        personId: 'P-RETENTION-1',
        status: 'Leaver',
        engagementType: 'Employee',
        jobTitle: 'Former Solicitor',
        departmentId: 'DEPT-CORP',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2026-01-31',
        contract: {
          startDate: '2020-01-01',
          leavingDate: '2026-01-31',
          hrRetentionUntil: '2033-01-31',
        },
      });
      await hrRepo.putSensitiveRecord(ctx, {
        personId: 'P-RETENTION-1',
        reasonableAdjustmentsNeeded: 'Protected record',
        diversity: {},
        updatedById: ctx.actorId,
        updatedAt: '2026-11-11T10:00:00.000Z',
      });

      // Attempting to delete the person row while employment/sensitive rows exist must fail with 23503 ON DELETE RESTRICT
      await expect(
        partyRepo.withTenantTransaction(ctx, async (tx) => {
          await tx.query(
            'DELETE FROM public.people WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, 'P-RETENTION-1'],
          );
        }),
      ).rejects.toMatchObject({
        code: '23503',
        message: expect.stringMatching(/TENANCY_FOREIGN_KEY_RESTRICT.*SQLSTATE 23503/),
      });

      // Fresh connection confirms both the person row and HR/sensitive rows remain intact
      const directClient = await createDirectMigrationClient({ ctx });
      try {
        const personCount = await directClient.query<{ cnt: string }>(
          'SELECT COUNT(*)::text AS cnt FROM public.people WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, 'P-RETENTION-1'],
        );
        const empCount = await directClient.query<{ cnt: string }>(
          'SELECT COUNT(*)::text AS cnt FROM public.employee_employment_records WHERE tenant_id = $1 AND person_id = $2',
          [ctx.tenantId, 'P-RETENTION-1'],
        );
        const sensCount = await directClient.query<{ cnt: string }>(
          'SELECT COUNT(*)::text AS cnt FROM public.employee_sensitive_records WHERE tenant_id = $1 AND person_id = $2',
          [ctx.tenantId, 'P-RETENTION-1'],
        );
        expect(Number(personCount.rows[0]?.cnt)).toBe(1);
        expect(Number(empCount.rows[0]?.cnt)).toBe(1);
        expect(Number(sensCount.rows[0]?.cnt)).toBe(1);
      } finally {
        await directClient.end();
      }
    } finally {
      await poolMgr.closeAllPools();
    }
  });

  it('maintains firmWorkEmail in person_emails (source = firm_work_email) on employment updates and imports post-S0-16 live people.employment_json edits on --modules hr (R410, R421)', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    await runWithActiveActorSession(actorSession, async () => {
      const store = loadCommittedSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr'],
        clearFirst: true,
      });

      // 1. R410: Updating firmWorkEmail via savePersonRecord updates person_emails (source = 'firm_work_email') in the same transaction
      const dafydd = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000002'))!;
      const updatedFirmEmail = 'dafydd.updated-work@notalawfirm.co.uk';
      const saveRes = await savePersonRecord(
        {
          firstName: dafydd.firstName,
          surname: dafydd.surname,
          emails: dafydd.emails,
        },
        {
          id: dafydd.id,
          byId: 'P-000001',
          mfaVerified: true,
          employmentSubmitted: {
            systems: {
              networkLogin: dafydd.employment?.systems?.networkLogin ?? 'd.lloyd',
              buildingPassNumber: dafydd.employment?.systems?.buildingPassNumber ?? 'BP-002',
              extension: dafydd.employment?.systems?.extension ?? '202',
              dataProtectionTrainingCompletedAt:
                dafydd.employment?.systems?.dataProtectionTrainingCompletedAt ?? null,
              amlTrainingCompletedAt:
                dafydd.employment?.systems?.amlTrainingCompletedAt ?? null,
              infoSecTrainingCompletedAt:
                dafydd.employment?.systems?.infoSecTrainingCompletedAt ?? null,
              firmWorkEmail: updatedFirmEmail,
            },
          },
        },
      );
      expect(saveRes.errors).toBeUndefined();

      // Verify via TenantPartyRepository.findActivePeopleByEmail on a fresh query that S0-30 (B13) email lookup finds Dafydd by the new firmWorkEmail
      const matchedByEmail = await getPartyRepository().findActivePeopleByEmail(
        ctx,
        updatedFirmEmail,
      );
      expect(matchedByEmail.map((p) => p.id)).toContain('P-000002');

      // Verify on a fresh direct connection that person_emails has source = 'firm_work_email'
      const directClient = await createDirectMigrationClient({ ctx });
      try {
        const emailRows = await directClient.query<{
          email_lower: string;
          source: string;
        }>(
          `SELECT email_lower, source
             FROM public.person_emails
            WHERE tenant_id = $1 AND person_id = 'P-000002' AND source = 'firm_work_email'`,
          [ctx.tenantId],
        );
        expect(emailRows.rows).toEqual([
          {
            email_lower: updatedFirmEmail,
            source: 'firm_work_email',
          },
        ]);

        // 2. R421: Simulate a live edit stored in PostgreSQL employee_employment_records / employee_sensitive_records
        // while an imported seed store.people[].employment still has an older pre-cut-over value
        const savedEmp = saveRes.person.employment!;
        const { payroll: livePayroll, ...liveEmpWithoutPayroll } = {
          ...savedEmp,
          jobTitle: 'Post-S016 Live Promoted Partner',
          updatedAt: '2099-01-01T00:00:00.000Z',
          payroll: {
            externalPayrollReference: 'PAY-LIVE-S016',
            nationalInsuranceNumber:
              savedEmp.payroll?.nationalInsuranceNumber ?? 'QQ123456C',
            bankAccountName:
              savedEmp.payroll?.bankAccountName ?? 'D Lloyd',
            bankSortCode: savedEmp.payroll?.bankSortCode ?? '20-00-00',
            bankAccountNumber:
              savedEmp.payroll?.bankAccountNumber ?? '12345678',
            starterDeclarationOrP45:
              savedEmp.payroll?.starterDeclarationOrP45 ?? 'P45',
            studentLoanPlan: savedEmp.payroll?.studentLoanPlan ?? 'None',
            pensionAutoEnrolmentStatus:
              savedEmp.payroll?.pensionAutoEnrolmentStatus ?? 'Enrolled',
            pensionOptOutDate: savedEmp.payroll?.pensionOptOutDate ?? null,
          },
          systems: {
            networkLogin: savedEmp.systems?.networkLogin ?? 'd.lloyd',
            buildingPassNumber: savedEmp.systems?.buildingPassNumber ?? 'BP-002',
            extension: savedEmp.systems?.extension ?? '202',
            dataProtectionTrainingCompletedAt:
              savedEmp.systems?.dataProtectionTrainingCompletedAt ?? null,
            amlTrainingCompletedAt:
              savedEmp.systems?.amlTrainingCompletedAt ?? null,
            infoSecTrainingCompletedAt:
              savedEmp.systems?.infoSecTrainingCompletedAt ?? null,
            firmWorkEmail: 'dafydd.live-s016@notalawfirm.co.uk',
          },
        };
        await directClient.query(
          `UPDATE public.employee_employment_records
              SET employment_json = $3::jsonb,
                  updated_at = '2099-01-01T00:00:00.000Z'::timestamptz
            WHERE tenant_id = $1 AND person_id = $2`,
          [ctx.tenantId, 'P-000002', JSON.stringify(liveEmpWithoutPayroll)],
        );
        await directClient.query(
          `UPDATE public.employee_sensitive_records
              SET payroll_json = $3::jsonb,
                  updated_at = '2099-01-01T00:00:00.000Z'::timestamptz
            WHERE tenant_id = $1 AND person_id = $2`,
          [ctx.tenantId, 'P-000002', JSON.stringify(livePayroll)],
        );
      } finally {
        await directClient.end();
      }

      // Stale JSON store copy has an older jobTitle and firmWorkEmail
      const staleStore = createSeedStore();
      const staleDafydd = staleStore.people.find((p) => p.id === 'P-000002')!;
      expect(staleDafydd.employment?.jobTitle).not.toBe('Post-S016 Live Promoted Partner');

      // Running `--modules hr` import must read authoritative post-S0-16 `people.employment_json` from PostgreSQL (R421)
      await importFirmStoreModulesToPostgres({
        ctx,
        store: staleStore,
        modules: ['hr'],
        clearFirst: false,
      });

      const checkClient = await createDirectMigrationClient({ ctx });
      try {
        const empRow = await checkClient.query<{
          employment_json: EmploymentRecord;
        }>(
          `SELECT employment_json
             FROM public.employee_employment_records
            WHERE tenant_id = $1 AND person_id = 'P-000002'`,
          [ctx.tenantId],
        );
        expect(empRow.rows[0]?.employment_json.jobTitle).toBe(
          'Post-S016 Live Promoted Partner',
        );
        expect(empRow.rows[0]?.employment_json.payroll?.externalPayrollReference).toBe(
          'PAY-LIVE-S016',
        );

        const sensRow = await checkClient.query<{
          payroll_json: EmploymentRecord['payroll'] | null;
        }>(
          `SELECT payroll_json
             FROM public.employee_sensitive_records
            WHERE tenant_id = $1 AND person_id = 'P-000002'`,
          [ctx.tenantId],
        );
        expect(sensRow.rows[0]?.payroll_json?.externalPayrollReference).toBe(
          'PAY-LIVE-S016',
        );

        const fweRow = await checkClient.query<{ email_lower: string }>(
          `SELECT email_lower
             FROM public.person_emails
            WHERE tenant_id = $1 AND person_id = 'P-000002' AND source = 'firm_work_email'`,
          [ctx.tenantId],
        );
        expect(fweRow.rows[0]?.email_lower).toBe(
          'dafydd.live-s016@notalawfirm.co.uk',
        );
      } finally {
        await checkClient.end();
      }
    });
  });

  it('proves zero runtime dependency on people.employment_json with the column permanently dropped by migration 0015 (R408, R417)', async () => {
    const ctx = makeTenantContext('tenant-a');
    const poolMgr = new TenantPostgresPoolManager();
    const partyRepo = new TenantPartyRepository({ poolManager: poolMgr });
    const hrRepo = new TenantHrAndRbacRepository({ poolManager: poolMgr });

    const directClient = await createDirectMigrationClient({ ctx });
    try {
      await partyRepo.clearTenantData(ctx);
      await hrRepo.clearTenantData(ctx);

      // Verify migration 0015 has permanently dropped people.employment_json on tenant-a (R408, R417)
      const colCheck = await directClient.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'employment_json'`,
      );
      expect(colCheck.rowCount).toBe(0);

      const person = makeSamplePerson('P-NO-EMPJSON-1', 'no-empjson@tenant-a.example');
      person.employment = {
        personId: 'P-NO-EMPJSON-1',
        status: 'Active',
        engagementType: 'Employee',
        jobTitle: 'Solicitor Without Legacy Column',
        departmentId: 'DEPT-CORP',
        effectiveFrom: '2025-01-01',
        systems: {
          firmWorkEmail: 'no-empjson.work@tenant-a.example',
        },
      };

      await partyRepo.putPeople(ctx, [person]);
      const loadedById = await partyRepo.getPersonById(ctx, 'P-NO-EMPJSON-1');
      expect(loadedById?.employment).toMatchObject({
        jobTitle: 'Solicitor Without Legacy Column',
      });

      const allPeople = await partyRepo.listAllPeople(ctx);
      expect(allPeople).toHaveLength(1);
      expect(allPeople[0]?.employment).toMatchObject({
        jobTitle: 'Solicitor Without Legacy Column',
      });

      const byEmail = await partyRepo.findActivePeopleByEmail(
        ctx,
        'no-empjson.work@tenant-a.example',
      );
      expect(byEmail.map((p) => p.id)).toEqual(['P-NO-EMPJSON-1']);
    } finally {
      await directClient.end();
      await poolMgr.closeAllPools();
    }
  });

  it('commits HR sensitive/payroll reads and writes and their audit_entries in one PostgreSQL transaction and rolls back both on forced failure (Carry-forward item 3)', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    await runWithActiveActorSession(actorSession, async () => {
      const store = loadCommittedSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr'],
        clearFirst: true,
      });

      const auditRepo = new TenantAuditRepository();
      const beforeAuditRows = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'employee_sensitive',
        'P-000002',
      );
      const beforeViewSensitiveCount = beforeAuditRows.filter(
        (a) => a.action === 'view-sensitive',
      ).length;

      // 1. Forced failure inside getEmployeeDetailsForUser rolls back view-payroll and view-sensitive audit entries
      await expect(
        getEmployeeDetailsForUser('P-000002', 'P-000001', {
          logViewPayroll: true,
          logViewSensitive: true,
          beforeCommitHook: () => {
            throw new Error('HR_FORCED_READ_AUDIT_ROLLBACK');
          },
        }),
      ).rejects.toThrow('HR_FORCED_READ_AUDIT_ROLLBACK');

      const afterFailedReadSensAudit = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'employee_sensitive',
        'P-000002',
      );
      expect(
        afterFailedReadSensAudit.filter((a) => a.action === 'view-sensitive').length,
      ).toBe(beforeViewSensitiveCount);

      // Positive control: without forced failure, getEmployeeDetailsForUser returns sensitive record and commits view-sensitive + view-payroll
      const okDetails = await getEmployeeDetailsForUser('P-000002', 'P-000001', {
        logViewPayroll: true,
        logViewSensitive: true,
      });
      expect(okDetails.errors).toBeUndefined();
      const afterOkReadSensAudit = await auditRepo.listAuditEntriesForRecord(
        ctx,
        'employee_sensitive',
        'P-000002',
      );
      expect(
        afterOkReadSensAudit.filter((a) => a.action === 'view-sensitive').length,
      ).toBe(beforeViewSensitiveCount + 1);

      // 2. Forced failure during HR sensitive + payroll write in one transaction rolls back both data and audit_entries
      const hrRepo = getHrAndRbacRepository();
      const beforeSensRecord = await hrRepo.getSensitiveRecord(
        ctx,
        'P-000002',
      );
      const beforeUpdateSensCount = (
        await auditRepo.listAuditEntriesForRecord(ctx, 'employee_sensitive', 'P-000002')
      ).filter((a) => a.action === 'update-sensitive').length;

      await expect(
        hrRepo.withTenantTransaction(ctx, async () => {
          await hrRepo.putSensitiveRecord(
            ctx,
            {
              personId: 'P-000002',
              reasonableAdjustmentsNeeded: 'SHOULD_ROLL_BACK_ADJUSTMENT',
              diversity: (beforeSensRecord?.diversity ?? {}) as EmployeeSensitiveRecord['diversity'],
              updatedById: 'P-000001',
              updatedAt: new Date().toISOString(),
            } satisfies EmployeeSensitiveRecord,
          );
          await hrRepo.appendHrAuditEntriesInTx(ctx, [
            {
              recordType: 'employee_sensitive',
              recordId: 'P-000002',
              action: 'update-sensitive',
              field: 'Sensitive information (special category data)',
              oldValue: 'Recorded',
              newValue: 'SHOULD_ROLL_BACK_AUDIT',
              byId: 'P-000001',
            },
          ]);
          throw new Error('HR_FORCED_WRITE_AUDIT_ROLLBACK');
        }),
      ).rejects.toThrow('HR_FORCED_WRITE_AUDIT_ROLLBACK');

      // Fresh direct connection verifies neither the sensitive change nor the audit entry survived
      const directClient = await createDirectMigrationClient({ ctx });
      try {
        const sensRow = await directClient.query<{
          sensitive_hr_json: EmployeeSensitiveRecord;
        }>(
          `SELECT sensitive_hr_json
             FROM public.employee_sensitive_records
            WHERE tenant_id = $1 AND person_id = 'P-000002'`,
          [ctx.tenantId],
        );
        expect(
          sensRow.rows[0]?.sensitive_hr_json?.reasonableAdjustmentsNeeded,
        ).not.toBe('SHOULD_ROLL_BACK_ADJUSTMENT');

        const auditRows = await directClient.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
             FROM public.audit_entries
            WHERE tenant_id = $1
              AND record_type = 'employee_sensitive'
              AND record_id = 'P-000002'
              AND new_value = 'SHOULD_ROLL_BACK_AUDIT'`,
          [ctx.tenantId],
        );
        expect(Number(auditRows.rows[0]?.cnt)).toBe(0);
      } finally {
        await directClient.end();
      }

      const afterRollbackUpdateSensCount = (
        await auditRepo.listAuditEntriesForRecord(ctx, 'employee_sensitive', 'P-000002')
      ).filter((a) => a.action === 'update-sensitive').length;
      expect(afterRollbackUpdateSensCount).toBe(beforeUpdateSensCount);

      // Also verify host services saveTeamRecord, updateTenantRbacConfig, previewRbacOverrides, logEmployeeRestrictedAccess, and reassignLeaverOwnedRecords
      const teamSave = await saveTeamRecord(
        {
          name: 'S0-17b Specialist Team',
          description: 'PostgreSQL-backed team',
          memberIds: ['P-000001', 'P-000002'],
          leadIds: ['P-000002'],
          practiceAreaIds: [],
          active: true,
        },
        'P-000001',
      );
      expect(teamSave.error).toBeUndefined();
      expect(teamSave.team?.id).toMatch(/^TM-\d{6}$/);

      const logRes = await logEmployeeRestrictedAccess(
        'P-000002',
        'payroll',
        'P-000001',
      );
      expect(logRes.error).toBeUndefined();
      expect(logRes.auditEntry?.action).toBe('view-payroll');

      const rbacUpdate = await updateTenantRbacConfig(
        {
          departmentGrants: {
            'DEPT-CORP': ['matter:edit'],
          },
        },
        'P-000001',
        { mfaVerified: true },
      );
      expect(rbacUpdate.ok).toBe(true);

      const previewRes = await previewRbacOverrides(
        'P-000002',
        { grant: ['risk:view'], revoke: [] },
        'P-000001',
        { mfaVerified: true },
      );
      expect(previewRes.ok).toBe(true);
      expect(previewRes.permissions).toContain('risk:view');

      const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
      const leaver = allPeople.find(
        (p) => p.employment?.status === 'Leaver',
      );
      if (leaver) {
        const reassignRes = await reassignLeaverOwnedRecords(
          leaver.id,
          'P-000001',
          'P-000001',
        );
        expect(reassignRes.errors).toBeUndefined();
      }
    });
  });

  it('R468: updating payroll and sensitive HR fields via savePersonRecord never writes payroll, sensitive HR, or moved collections into runtime-store.json on disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1sq-r468-hr-'));
    const runtimeStorePath = path.join(tmpDir, 'runtime-store.json');
    const prevStorePath = process.env.ONESQUARED_RUNTIME_STORE_PATH;
    const prevNodeEnv = process.env.NODE_ENV;
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    try {
      await runWithActiveActorSession(actorSession, async () => {
        await resetAllDemoData('P-000001', ctx);
        process.env.ONESQUARED_RUNTIME_STORE_PATH = runtimeStorePath;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

        const dafydd = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000002'))!;
        const secretNi = 'JC987654D';
        const secretBankAcct = '87654321';
        const secretSortCode = '40-55-66';
        const secretPayrollRef = 'PAY-R468-NEVER-IN-JSON';
        const secretSensitiveAdjustment = 'R468_CONFIDENTIAL_MEDICAL_ADJUSTMENT_NEVER_ON_DISK';

        const saveRes = await savePersonRecord(
          {
            ...dafydd,
            firstName: dafydd.firstName,
            surname: dafydd.surname,
          },
          {
            id: dafydd.id,
            byId: 'P-000001',
            mfaVerified: true,
            worksAtFirm: true,
            employmentSubmitted: {
              ...dafydd.employment,
              payroll: {
                externalPayrollReference: secretPayrollRef,
                nationalInsuranceNumber: secretNi,
                bankAccountName: 'Dafydd R468 Secret Account',
                bankSortCode: secretSortCode,
                bankAccountNumber: secretBankAcct,
                starterDeclarationOrP45: 'P45',
                studentLoanPlan: 'Plan 2',
                pensionAutoEnrolmentStatus: 'Enrolled',
                pensionOptOutDate: null,
              },
            },
            sensitiveSubmitted: {
              reasonableAdjustmentsNeeded: secretSensitiveAdjustment,
            },
            sensitiveSectionOpened: true,
            sensitiveSectionEdited: true,
          },
        );
        expect(saveRes.errors).toBeUndefined();

        // Runtime JSON store is retired (S0-20): no runtime-store.json file is ever written to disk
        expect(fs.existsSync(runtimeStorePath)).toBe(false);
      });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
      if (prevStorePath === undefined) {
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      } else {
        process.env.ONESQUARED_RUNTIME_STORE_PATH = prevStorePath;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await resetAllDemoData('P-000001', ctx);
    }
  });

  it('R465 & R466: HR employment, sensitive HR, teams, and RBAC overrides survive simulated cold-start restart and are immediately visible across isolated module instances without clearTenantData', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    try {
      await runWithActiveActorSession(actorSession, async () => {
        await resetAllDemoData('P-000001', ctx);

        const dafydd = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000002'))!;
        const saveRes = await savePersonRecord(
          {
            ...dafydd,
            firstName: dafydd.firstName,
            surname: dafydd.surname,
          },
          {
            id: dafydd.id,
            byId: 'P-000001',
            mfaVerified: true,
            worksAtFirm: true,
            employmentSubmitted: {
              ...dafydd.employment,
              jobTitle: 'R465 Cold-Start Principal Associate',
              payroll: {
                externalPayrollReference: 'PAY-R465-SURVIVES',
                nationalInsuranceNumber: 'JC112233A',
                bankAccountName: 'D Evans Cold Start',
                bankSortCode: '20-11-22',
                bankAccountNumber: '11223344',
                starterDeclarationOrP45: 'P45',
                studentLoanPlan: 'None',
                pensionAutoEnrolmentStatus: 'Enrolled',
                pensionOptOutDate: null,
              },
            },
            sensitiveSubmitted: {
              reasonableAdjustmentsNeeded: 'R465 Cold-Start Ergonomic Keyboard',
            },
            sensitiveSectionOpened: true,
            sensitiveSectionEdited: true,
          },
        );
        expect(saveRes.errors).toBeUndefined();

        const createdTeam = await saveTeamRecord(
          {
            name: 'R465 Cold-Start Restructuring Team',
            description: 'Must survive cold start and be visible on Replica B',
            memberIds: ['P-000001', 'P-000002'],
            leadIds: ['P-000002'],
            practiceAreaIds: [],
            active: true,
          },
          'P-000001',
        );
        expect(createdTeam.team?.id).toBeDefined();

        const rbacRes = await updateTenantRbacConfig(
          {
            departmentGrants: {
              'DEPT-R465': ['risk:view'],
            },
          },
          'P-000001',
          { mfaVerified: true },
        );
        expect(rbacRes.ok).toBe(true);

        // Simulate a cold start / second replica: reset modules and wipe all __oneSquared* globals
        vi.resetModules();
        for (const key of Object.keys(globalThis)) {
          if (key.startsWith('__oneSquared')) {
            delete (globalThis as Record<string, unknown>)[key];
          }
        }
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;

        const replicaBServices = await import('@/server/services');
        const replicaBRbac = await import('@/server/rbacRuntime');
        const replicaBEntra = await import('@/server/entraAuth');

        const clearSpy = vi.spyOn(
          replicaBServices.getHrAndRbacRepository(),
          'clearTenantData',
        );

        const cfgB = getActiveTenantConfiguration();
        const cookieB = replicaBEntra.createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: cfgB.tenantId,
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000001',
          email: `p-000001@${cfgB.branding.primaryDomain}`,
          displayName: 'Test Actor P-000001',
          entraRoles: ['admin', 'managing_partner', 'partner'],
          mappedRoles: ['admin', 'managing_partner', 'partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const verifiedB = replicaBEntra.verifySignedEntraSessionCookie(cookieB)!;
        replicaBEntra.setTestEntraSessionOverride(verifiedB);

        await replicaBRbac.runWithActiveActorSession(
          {
            personId: 'P-000001',
            tenantId: cfgB.tenantId,
            tokenRoles: verifiedB.mappedRoles,
            mfaVerified: true,
            expiresAtMs: Date.now() + 3600_000,
            verifiedSession: verifiedB,
          },
          async () => {
            const snapB = await replicaBServices.getAppSnapshot('P-000001');
            expect(
              snapB.teams.some((t) => t.name === 'R465 Cold-Start Restructuring Team'),
            ).toBe(true);
            expect(snapB.rbacConfig.departmentGrants?.['DEPT-R465']).toEqual([
              'risk:view',
            ]);
            const dafyddInSnapB = snapB.people.find((p) => p.id === 'P-000002');
            expect(dafyddInSnapB?.employment?.jobTitle).toBe(
              'R465 Cold-Start Principal Associate',
            );

            const detailsB = await replicaBServices.getEmployeeDetailsForUser(
              'P-000002',
              'P-000001',
              { logViewPayroll: true, logViewSensitive: true },
            );
            expect(
              detailsB.employment?.payroll?.externalPayrollReference,
            ).toBe('PAY-R465-SURVIVES');
            expect(detailsB.sensitive?.reasonableAdjustmentsNeeded).toBe(
              'R465 Cold-Start Ergonomic Keyboard',
            );
            expect(clearSpy).not.toHaveBeenCalled();
          },
        );
      });
    } finally {
      await resetAllDemoData('P-000001', ctx);
    }
  });

  it('R467: services-level Model B two-tenant interleaving in one process isolates teams, employment/sensitive HR, RBAC overrides, and audit entries across tenant-a and tenant-b', async () => {
    const rawBaseConfig = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const rawConfigA: Record<string, unknown> = {
      ...structuredClone(rawBaseConfig),
      tenantId: 'tenant-a',
      displayName: 'Tenant A Law LLP',
      hostingMode: 'multi_tenant',
    };
    const rawConfigB: Record<string, unknown> = {
      ...structuredClone(rawBaseConfig),
      tenantId: 'tenant-b',
      displayName: 'Tenant B Chambers LLP',
      hostingMode: 'multi_tenant',
    };
    setActiveTenantConfigForTesting(rawConfigA, {});
    const tenantACfg: TenantConfiguration = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(rawConfigB, {});
    const tenantBCfg: TenantConfiguration = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(null);

    const ctxA = makeTenantContext('tenant-a', 'P-000001');
    const ctxB = makeTenantContext('tenant-b', 'P-000001');

    const runInTenant = async <T>(
      rawCfg: Record<string, unknown>,
      cfg: TenantConfiguration,
      fn: () => Promise<T>,
    ): Promise<T> => {
      setActiveTenantConfigForTesting(rawCfg, {});
      const roles = ['admin', 'managing_partner', 'partner', 'fee_earner'];
      const cookie = createSignedEntraSessionCookie({
        personId: 'P-000001',
        tenantId: cfg.tenantId,
        oid: '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-000001',
        email: `p1@${cfg.branding.primaryDomain}`,
        displayName: `Actor ${cfg.tenantId}`,
        entraRoles: roles,
        mappedRoles: roles,
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const verified = verifySignedEntraSessionCookie(cookie)!;
      setTestEntraSessionOverride(verified);
      return runWithActiveActorSession(
        {
          personId: 'P-000001',
          tenantId: cfg.tenantId,
          tokenRoles: roles,
          mfaVerified: true,
          expiresAtMs: Date.now() + 3600_000,
          verifiedSession: verified,
        },
        fn,
      );
    };

    try {
      const seedA = createSeedStore();
      const seedB = createSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx: ctxA,
        store: seedA,
        tenantConfig: tenantACfg,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr'],
        clearFirst: true,
      });
      await importFirmStoreModulesToPostgres({
        ctx: ctxB,
        store: seedB,
        tenantConfig: tenantBCfg,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr'],
        clearFirst: true,
      });

      // Interleave service writes on tenant-a and tenant-b
      const teamA = await runInTenant(rawConfigA, tenantACfg, () =>
        saveTeamRecord(
          {
            name: 'Tenant A Exclusive Restructuring Team',
            description: 'Tenant A only',
            memberIds: ['P-000001', 'P-000002'],
            leadIds: ['P-000002'],
            practiceAreaIds: [],
            active: true,
          },
          'P-000001',
        ),
      );
      expect(teamA.team?.name).toBe('Tenant A Exclusive Restructuring Team');

      const teamB = await runInTenant(rawConfigB, tenantBCfg, () =>
        saveTeamRecord(
          {
            name: 'Tenant B Exclusive Disputes Team',
            description: 'Tenant B only',
            memberIds: ['P-000001', 'P-000002'],
            leadIds: ['P-000002'],
            practiceAreaIds: [],
            active: true,
          },
          'P-000001',
        ),
      );
      expect(teamB.team?.name).toBe('Tenant B Exclusive Disputes Team');

      await runInTenant(rawConfigA, tenantACfg, async () => {
        const p2A = (await getPartyRepository().getPersonById<Person>(ctxA, 'P-000002'))!;
        await savePersonRecord(
          { ...p2A, firstName: p2A.firstName, surname: p2A.surname },
          {
            id: 'P-000002',
            byId: 'P-000001',
            mfaVerified: true,
            worksAtFirm: true,
            employmentSubmitted: {
              ...p2A.employment,
              jobTitle: 'Tenant A Head of Tax',
            },
            sensitiveSubmitted: {
              reasonableAdjustmentsNeeded: 'Tenant A Secret Adjustment',
            },
            sensitiveSectionOpened: true,
            sensitiveSectionEdited: true,
          },
        );
        await updateTenantRbacConfig(
          { departmentGrants: { 'DEPT-TENANT-A': ['risk:view'] } },
          'P-000001',
          { mfaVerified: true },
        );
      });

      await runInTenant(rawConfigB, tenantBCfg, async () => {
        const p2B = (await getPartyRepository().getPersonById<Person>(ctxB, 'P-000002'))!;
        await savePersonRecord(
          { ...p2B, firstName: p2B.firstName, surname: p2B.surname },
          {
            id: 'P-000002',
            byId: 'P-000001',
            mfaVerified: true,
            worksAtFirm: true,
            employmentSubmitted: {
              ...p2B.employment,
              jobTitle: 'Tenant B Head of IP',
            },
            sensitiveSubmitted: {
              reasonableAdjustmentsNeeded: 'Tenant B Secret Adjustment',
            },
            sensitiveSectionOpened: true,
            sensitiveSectionEdited: true,
          },
        );
        await updateTenantRbacConfig(
          { departmentGrants: { 'DEPT-TENANT-B': ['finance:view'] } },
          'P-000001',
          { mfaVerified: true },
        );
      });

      // Verify positive controls and strict cross-tenant isolation via service reads
      await runInTenant(rawConfigA, tenantACfg, async () => {
        const snapA = await getAppSnapshot('P-000001');
        expect(
          snapA.teams.some((t) => t.name === 'Tenant A Exclusive Restructuring Team'),
        ).toBe(true);
        expect(
          snapA.teams.some((t) => t.name === 'Tenant B Exclusive Disputes Team'),
        ).toBe(false);
        expect(snapA.rbacConfig.departmentGrants?.['DEPT-TENANT-A']).toEqual([
          'risk:view',
        ]);
        expect(
          snapA.rbacConfig.departmentGrants?.['DEPT-TENANT-B'],
        ).toBeUndefined();
        const detailsA = await getEmployeeDetailsForUser('P-000002', 'P-000001', {
          logViewSensitive: true,
        });
        expect(detailsA.employment?.jobTitle).toBe('Tenant A Head of Tax');
        expect(detailsA.sensitive?.reasonableAdjustmentsNeeded).toBe(
          'Tenant A Secret Adjustment',
        );
      });

      await runInTenant(rawConfigB, tenantBCfg, async () => {
        const snapB = await getAppSnapshot('P-000001');
        expect(
          snapB.teams.some((t) => t.name === 'Tenant B Exclusive Disputes Team'),
        ).toBe(true);
        expect(
          snapB.teams.some((t) => t.name === 'Tenant A Exclusive Restructuring Team'),
        ).toBe(false);
        expect(snapB.rbacConfig.departmentGrants?.['DEPT-TENANT-B']).toEqual([
          'finance:view',
        ]);
        expect(
          snapB.rbacConfig.departmentGrants?.['DEPT-TENANT-A'],
        ).toBeUndefined();
        const detailsB = await getEmployeeDetailsForUser('P-000002', 'P-000001', {
          logViewSensitive: true,
        });
        expect(detailsB.employment?.jobTitle).toBe('Tenant B Head of IP');
        expect(detailsB.sensitive?.reasonableAdjustmentsNeeded).toBe(
          'Tenant B Secret Adjustment',
        );
      });
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
    }
  });

  it('R477: two-replica RBAC override test using separate vi.resetModules() graphs — setting, clearing, and re-setting an override on Replica A immediately governs guarded actions on Replica B with no snapshot load in between, and updateTenantRbacConfig enforces row_version', async () => {
    const loadReplica = async () => {
      vi.resetModules();
      const servicesMod = await import('@/server/services');
      const entraAuthMod = await import('@/server/entraAuth');
      const rbacRuntimeMod = await import('@/server/rbacRuntime');
      const actionsMod = await import('@/app/actions');
      const tenantRuntimeMod = await import('@/platform/tenantRuntime');
      return {
        services: servicesMod,
        entraAuth: entraAuthMod,
        rbacRuntime: rbacRuntimeMod,
        actions: actionsMod,
        tenantRuntime: tenantRuntimeMod,
      };
    };

    const replicaA = await loadReplica();
    const replicaB = await loadReplica();

    expect(replicaA.services).not.toBe(replicaB.services);
    expect(replicaA.rbacRuntime).not.toBe(replicaB.rbacRuntime);
    expect(replicaA.actions).not.toBe(replicaB.actions);

    const runOnReplica = async <T>(
      replica: Awaited<ReturnType<typeof loadReplica>>,
      actorPersonId: string,
      roles: string[],
      fn: (ctx: TenantContext) => Promise<T>,
    ): Promise<T> => {
      const cfg = replica.tenantRuntime.getActiveTenantConfiguration();
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const cookieVal = replica.entraAuth.createSignedEntraSessionCookie({
        personId: actorPersonId,
        tenantId: cfg.tenantId,
        oid: `00000000-0000-4000-8000-${actorPersonId.replace(/\D/g, '').padStart(12, '0')}`,
        tid: '11111111-2222-3333-4444-000000000000',
        sub: actorPersonId,
        email: `${actorPersonId.toLowerCase()}@${cfg.branding.primaryDomain}`,
        displayName: `Replica Actor ${actorPersonId}`,
        entraRoles: roles,
        mappedRoles: roles,
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      const verified =
        replica.entraAuth.verifySignedEntraSessionCookie(cookieVal)!;
      replica.entraAuth.setTestEntraSessionOverride(verified);
      const ctx = replica.tenantRuntime.resolveCurrentTenantContext(
        replica.entraAuth.createVerifiedSessionActorFromEntraSession(verified, {
          correlationId: `corr-r477-${actorPersonId}`,
        }),
        cfg,
      );
      try {
        return await replica.rbacRuntime.runWithActiveActorSession(
          {
            personId: actorPersonId,
            tenantId: cfg.tenantId,
            tokenRoles: roles,
            mfaVerified: true,
            expiresAtMs: Date.parse(expiresAt),
            verifiedSession: verified,
          },
          () => fn(ctx),
        );
      } finally {
        replica.entraAuth.setTestEntraSessionOverride(null);
      }
    };

    const sampleEnquiryPayload = (suffix: string) => ({
      status: 'New' as const,
      firstName: 'R477',
      lastName: `Caller-${suffix}`,
      email: `r477.${suffix}@notalawfirm.example`,
      phone: '029 2000 4770',
      practiceAreaId: 'pa_corp',
      workTypeSubcategoryId: 'wt_corp_ma',
      summary: `R477 two-replica enquiry ${suffix}`,
      notes: 'Testing R477 across independent module graphs',
      urgencyId: 'enquiry_urgency.standard',
      sourceId: 'source.website',
      assignedTeamId: 'TM-000001',
      assignedToId: 'P-000002',
      privacyNoticeGiven: true,
    });

    try {
      // Seed demo data on Replica A
      await runOnReplica(
        replicaA,
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'fee_earner'],
        async (ctxA) => {
          await replicaA.services.resetAllDemoData('P-000001', ctxA);
        },
      );

      const baseFeeEarnerRole =
        replicaA.rbacRuntime.getDefaultTenantRbacConfig().roles['fee_earner']!;
      expect(baseFeeEarnerRole.permissions).toContain('enquiry:create');

      const overrideWithoutEnquiryCreate = {
        roles: {
          fee_earner: {
            ...baseFeeEarnerRole,
            permissions: baseFeeEarnerRole.permissions.filter(
              (p) => p !== 'enquiry:create',
            ),
          },
        },
      };

      // Step 1: Replica A sets an override that removes permission 'enquiry:create' from role 'fee_earner'.
      // On Replica B, a guarded action ('saveEnquiryAction') that needs 'enquiry:create' is denied.
      await runOnReplica(
        replicaA,
        'P-000004',
        ['admin'],
        async () => {
          const res = await replicaA.services.updateTenantRbacConfig(
            overrideWithoutEnquiryCreate,
            'P-000004',
            { mfaVerified: true },
          );
          expect(res.ok).toBe(true);
        },
      );

      const step1OnB = await runOnReplica(
        replicaB,
        'P-000002',
        ['fee_earner'],
        async () =>
          replicaB.actions.saveEnquiryAction(sampleEnquiryPayload('step1')),
      );
      expect(step1OnB).toMatchObject({
        ok: false,
        denied: true,
        code: 'FORBIDDEN',
      });

      // Step 2: Replica A clears the override.
      // Replica B allows the guarded action, with NO snapshot load in between.
      await runOnReplica(
        replicaA,
        'P-000004',
        ['admin'],
        async () => {
          const res = await replicaA.services.updateTenantRbacConfig(
            null,
            'P-000004',
            { mfaVerified: true },
          );
          expect(res.ok).toBe(true);
        },
      );

      const step2OnB = await runOnReplica(
        replicaB,
        'P-000002',
        ['fee_earner'],
        async () =>
          replicaB.actions.saveEnquiryAction(sampleEnquiryPayload('step2')),
      );
      expect('denied' in step2OnB && step2OnB.denied).toBe(false);
      expect(
        (step2OnB as { enquiry?: { id: string } | null }).enquiry?.id,
      ).toMatch(/^ENQ-\d{6}$/);

      // Step 3: Replica A sets the override again.
      // Replica B denies the guarded action.
      await runOnReplica(
        replicaA,
        'P-000004',
        ['admin'],
        async () => {
          const res = await replicaA.services.updateTenantRbacConfig(
            overrideWithoutEnquiryCreate,
            'P-000004',
            { mfaVerified: true },
          );
          expect(res.ok).toBe(true);
        },
      );

      const step3OnB = await runOnReplica(
        replicaB,
        'P-000002',
        ['fee_earner'],
        async () =>
          replicaB.actions.saveEnquiryAction(sampleEnquiryPayload('step3')),
      );
      expect(step3OnB).toMatchObject({
        ok: false,
        denied: true,
        code: 'FORBIDDEN',
      });

      // Also verify row_version optimistic concurrency on updateTenantRbacConfig:
      await expect(
        runOnReplica(replicaA, 'P-000004', ['admin'], async () =>
          replicaA.services.updateTenantRbacConfig(
            overrideWithoutEnquiryCreate,
            'P-000004',
            { mfaVerified: true, expectedRowVersion: 999 },
          ),
        ),
      ).rejects.toMatchObject({
        code: 'RBAC_CONFIG_CONCURRENCY_CONFLICT',
        message: expect.stringMatching(/RBAC_CONFIG_CONCURRENCY_CONFLICT/),
      });
    } finally {
      const { ctx, actorSession } = makeHostActorAndContext('P-000001');
      await runWithActiveActorSession(actorSession, () =>
        resetAllDemoData('P-000001', ctx),
      );
    }
  });

  it('R477 contract: src/server/rbacRuntime.ts holds zero module-level Map or Set instances and exports no process-wide override mutator', async () => {
    const rbacRuntimePath = path.resolve(
      __dirname,
      '../../src/server/rbacRuntime.ts',
    );
    const rawSource = fs.readFileSync(rbacRuntimePath, 'utf8');
    const strippedComments = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(strippedComments).not.toMatch(/\bnew\s+Map\b/);
    expect(strippedComments).not.toMatch(/\bnew\s+Set\b/);
    expect(strippedComments).not.toMatch(/\bsetRuntimeRbacConfigOverride\b/);
    expect(strippedComments).not.toMatch(/\btenantRbacConfigCacheByTenant\b/);
    expect(strippedComments).not.toMatch(/\bruntimeRbacConfigOverrideByTenant\b/);

    const rbacRuntimeMod = await import('@/server/rbacRuntime');
    expect('setRuntimeRbacConfigOverride' in rbacRuntimeMod).toBe(false);
  });
});
