import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalTenantPostgresPoolManager,
  MATTER_CONCURRENCY_CONFLICT_CODE,
  MATTER_CONCURRENCY_CONFLICT_MESSAGE,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantDirectoryRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  type TenantContext,
} from '@platform/core';
import { saveMatterAction } from '@/app/actions';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import {
  getMatterRepository,
  getPartyRepository,
} from '@/platform/tenantRuntime';
import { setAuditAdapterFailureHookForTesting } from '@/server/testSupport/auditTestSupport';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  addNoteToRecord,
  createOrUpdateLink,
  executeMerge,
  generateMatterNumber,
  getAppSnapshot,
  liftMatterRestriction,
  listFirmAuditEntriesPage,
  markEngagementLetterDrafted,
  reassignLeaverOwnedRecords,
  resetAllDemoData,
  runMatterConflictSearchRecord,
  saveMatterRecord,
  saveOrganisationRecord,
  savePersonRecord,
  signOffMatterCostsRecord,
  updateMatterConflictRecord,
} from '@/server/services';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { testDataResetContext } from '@/test/testTenantContexts';

function makeTenantCtx(
  tenantId: string,
  actorId = 'P-000001',
  roles: readonly string[] = ['admin', 'managing_partner', 'partner', 'risk_compliance'],
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      roles,
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s016-${tenantId}-${actorId}`,
  });
}

function makeActorSession(
  personId: string,
  roles: string[] = ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
  tenantId = 'not-a-law-firm',
) {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const cookieVal = createSignedEntraSessionCookie({
    personId,
    tenantId,
    oid: `00000000-0000-4000-8000-${personId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: personId,
    email: `${personId.toLowerCase()}@notalawfirm.example`,
    displayName: `Test Actor ${personId}`,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
  return {
    personId,
    tenantId,
    tokenRoles: verifiedSession.mappedRoles,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession,
  };
}

describe('S0-16: People, organisations, links, notes, merge history and matters on PostgreSQL', () => {
  afterEach(() => {
    setAuditAdapterFailureHookForTesting(null);
    setTestEntraSessionOverride(undefined);
  });

  it('Two-tenant isolation: TenantPartyRepository and TenantMatterRepository enforce positive control, forged claims, tampered IDs, SET LOCAL ROLE on a single connection, and fresh-connection reads', async () => {
    const ctxA = makeTenantCtx('tenant-alpha', 'P-ALPHA-1');
    const ctxB = makeTenantCtx('tenant-bravo', 'P-BRAVO-1');

    // Forged claim without __verifiedByOidcMiddleware or with untrustedRequestTenantOverride is rejected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: false as unknown as true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged',
      }),
    ).toThrow(
      /TENANCY_AUTH_ERROR: Tenant context can only be resolved from a verified OIDC token/i,
    );
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-override',
        untrustedRequestTenantOverride: 'tenant-bravo',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/i);

    const singleConnPoolMgr = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
    const partyRepo = new TenantPartyRepository({ poolManager: singleConnPoolMgr });
    const matterRepo = new TenantMatterRepository({ poolManager: singleConnPoolMgr });

    try {
      await matterRepo.clearTenantData(ctxA);
      await partyRepo.clearTenantData(ctxA);
      await matterRepo.clearTenantData(ctxB);
      await partyRepo.clearTenantData(ctxB);

      // Verify single-connection SET LOCAL ROLE switching between Tenant A and Tenant B
      const roleCheckA = await partyRepo.withTenantTransaction(ctxA, async (tx) => {
        const r = await tx.query<{ pid: number; role_name: string }>(
          'SELECT pg_backend_pid() AS pid, current_user AS role_name',
        );
        return r.rows[0]!;
      });
      const roleCheckB = await partyRepo.withTenantTransaction(ctxB, async (tx) => {
        const r = await tx.query<{ pid: number; role_name: string }>(
          'SELECT pg_backend_pid() AS pid, current_user AS role_name',
        );
        return r.rows[0]!;
      });
      expect(roleCheckA.role_name).toBe('role_tenant_tenant_alpha_test');
      expect(roleCheckB.role_name).toBe('role_tenant_tenant_bravo_test');

      const seedPerson = structuredClone(loadCommittedSeedStore().people[0]!);
      const personA = {
        ...seedPerson,
        id: 'P-ISO-A01',
        firstName: 'Alys',
        surname: 'Aberystwyth',
        emails: [
          {
            id: 'em-iso-a1',
            address: 'alys.aberystwyth@alpha.example',
            typeId: 'email_type.work',
            isPrimary: true,
            active: true,
          },
        ],
      };
      const seedOrg = structuredClone(loadCommittedSeedStore().organisations[0]!);
      const orgA = {
        ...seedOrg,
        id: 'O-ISO-A01',
        legalName: 'Alpha Haberdashery Ltd',
        clientReference: 'ALP001',
      };
      const seedLink = structuredClone(loadCommittedSeedStore().links[0]!);
      const linkA = {
        ...seedLink,
        id: 'L-ISO-A01',
        personId: personA.id,
        organisationId: orgA.id,
      };
      const seedNote = structuredClone(loadCommittedSeedStore().notes[0]!);
      const noteA = {
        ...seedNote,
        id: 'N-ISO-A01',
        recordType: 'person' as const,
        recordId: personA.id,
        text: 'Alpha confidential note',
      };
      const seedMatter = structuredClone(loadCommittedSeedStore().matters[0]!);
      const matterA = {
        ...seedMatter,
        id: 'M-ISO-A01',
        rowVersion: 1,
        matterNumber: 'ALP001-0001',
        title: 'Alpha Harbour Lease Acquisition',
        clientId: orgA.id,
        isStaffMatter: false,
        hasEthicalWall: false,
        restrictedAccessUserIds: [],
      };

      await partyRepo.putPerson(ctxA, personA);
      await partyRepo.putOrganisation(ctxA, orgA);
      await partyRepo.putLink(ctxA, linkA);
      await partyRepo.putNote(ctxA, noteA);
      await matterRepo.createMatter(ctxA, matterA);

      // Positive control: Tenant A reads its own records on a fresh pool manager
      const freshPoolMgr = new TenantPostgresPoolManager();
      const freshPartyRepo = new TenantDirectoryRepository({ poolManager: freshPoolMgr });
      const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
      try {
        expect((await freshPartyRepo.getPersonById(ctxA, personA.id))?.surname).toBe(
          'Aberystwyth',
        );
        expect(
          (await freshPartyRepo.findActivePeopleByEmail(ctxA, 'alys.aberystwyth@alpha.example')).map(
            (p) => p.id,
          ),
        ).toEqual([personA.id]);
        expect((await freshPartyRepo.getOrganisationById(ctxA, orgA.id))?.legalName).toBe(
          'Alpha Haberdashery Ltd',
        );
        expect((await freshPartyRepo.getLinkById(ctxA, linkA.id))?.organisationId).toBe(
          orgA.id,
        );
        expect(
          (await freshPartyRepo.listNotesForRecord(ctxA, 'person', personA.id)).map((n) => n.id),
        ).toEqual([noteA.id]);
        expect(
          (await freshMatterRepo.getMatterById(ctxA, matterA.id, { viewerUserId: 'P-ALPHA-1' }))
            ?.title,
        ).toBe('Alpha Harbour Lease Acquisition');

        // Cross-tenant & tampered record ID checks: Tenant B cannot read, list, search, update, or delete Tenant A's rows
        expect(await freshPartyRepo.getPersonById(ctxB, personA.id)).toBeNull();
        expect(
          await freshPartyRepo.findActivePeopleByEmail(ctxB, 'alys.aberystwyth@alpha.example'),
        ).toEqual([]);
        expect(await freshPartyRepo.getOrganisationById(ctxB, orgA.id)).toBeNull();
        expect(await freshPartyRepo.getLinkById(ctxB, linkA.id)).toBeNull();
        expect(await freshPartyRepo.deleteLinkById(ctxB, linkA.id)).toBe(false);
        expect(await freshPartyRepo.listNotesForRecord(ctxB, 'person', personA.id)).toEqual([]);
        expect(
          await freshMatterRepo.getMatterById(ctxB, matterA.id, {
            viewerUserId: 'P-BRAVO-1',
            hasRestrictedMatterAccess: true,
          }),
        ).toBeNull();
        expect(
          await freshMatterRepo.listVisibleMatters(ctxB, {
            viewerUserId: 'P-BRAVO-1',
            hasRestrictedMatterAccess: true,
          }),
        ).toEqual([]);
        expect(
          await freshMatterRepo.searchVisibleMatters(ctxB, 'Alpha Harbour', {
            viewerUserId: 'P-BRAVO-1',
            hasRestrictedMatterAccess: true,
          }),
        ).toEqual([]);

        // Tenant A records remain untouched after Tenant B's tampered delete/update attempts
        expect(await freshPartyRepo.getLinkById(ctxA, linkA.id)).not.toBeNull();
      } finally {
        await freshPoolMgr.closeAllPools();
      }
    } finally {
      await matterRepo.clearTenantData(ctxA);
      await partyRepo.clearTenantData(ctxA);
      await matterRepo.clearTenantData(ctxB);
      await partyRepo.clearTenantData(ctxB);
      await singleConnPoolMgr.closeAllPools();
    }
  });

  it('Staff-matter & ethical-wall enforcement (B12): TenantMatterRepository filters out staff and ethical-wall matters (including empty allow-list) for non-permitted viewers while returning them to authorised viewers', async () => {
    const ctx = makeTenantCtx('tenant-alpha', 'P-ALLOW-1');
    const matterRepo = getMatterRepository();
    try {
      await matterRepo.clearTenantData(ctx);

      const base = structuredClone(loadCommittedSeedStore().matters[0]!);
      const openMatter = {
        ...base,
        id: 'M-WALL-OPEN',
        matterNumber: 'ALP001-0101',
        title: 'Standard Unwalled Matter',
        isStaffMatter: false,
        hasEthicalWall: false,
        restrictedAccessUserIds: [],
      };
      const staffMatter = {
        ...base,
        id: 'M-WALL-STAFF',
        matterNumber: 'ALP001-0102',
        title: 'Confidential Staff Matter',
        isStaffMatter: true,
        hasEthicalWall: false,
        restrictedAccessUserIds: ['P-ALLOW-1'],
      };
      const emptyWallMatter = {
        ...base,
        id: 'M-WALL-EMPTY',
        matterNumber: 'ALP001-0103',
        title: 'Ethical Wall Empty Allow List Matter',
        isStaffMatter: false,
        hasEthicalWall: true,
        restrictedAccessUserIds: [],
      };

      await matterRepo.createMatter(ctx, openMatter);
      await matterRepo.createMatter(ctx, staffMatter);
      await matterRepo.createMatter(ctx, emptyWallMatter);

      // Non-permitted viewer P-OUTSIDER sees only the standard unwalled matter across get, list, search, and export
      expect(
        await matterRepo.getMatterById(ctx, staffMatter.id, { viewerUserId: 'P-OUTSIDER' }),
      ).toBeNull();
      expect(
        await matterRepo.getMatterById(ctx, emptyWallMatter.id, { viewerUserId: 'P-OUTSIDER' }),
      ).toBeNull();
      expect(
        (await matterRepo.listVisibleMatters(ctx, { viewerUserId: 'P-OUTSIDER' })).map((m) => m.id),
      ).toEqual(['M-WALL-OPEN']);
      expect(
        (
          await matterRepo.searchVisibleMatters(ctx, 'Matter', { viewerUserId: 'P-OUTSIDER' })
        ).map((m) => m.id),
      ).toEqual(['M-WALL-OPEN']);
      expect(
        (await matterRepo.exportVisibleMatters(ctx, { viewerUserId: 'P-OUTSIDER' })).map(
          (m) => m.id,
        ),
      ).toEqual(['M-WALL-OPEN']);

      // Authorised allow-list member P-ALLOW-1 sees openMatter + staffMatter, but STILL cannot see emptyWallMatter (B12 fail-closed)
      expect(
        (await matterRepo.getMatterById(ctx, staffMatter.id, { viewerUserId: 'P-ALLOW-1' }))?.id,
      ).toBe(staffMatter.id);
      expect(
        await matterRepo.getMatterById(ctx, emptyWallMatter.id, { viewerUserId: 'P-ALLOW-1' }),
      ).toBeNull();
      expect(
        (await matterRepo.listVisibleMatters(ctx, { viewerUserId: 'P-ALLOW-1' }))
          .map((m) => m.id)
          .sort(),
      ).toEqual(['M-WALL-OPEN', 'M-WALL-STAFF']);

      // Viewer with explicit matter:restricted:access sees all 3 matters
      expect(
        (
          await matterRepo.listVisibleMatters(ctx, {
            viewerUserId: 'P-RISK-OFFICER',
            hasRestrictedMatterAccess: true,
          })
        )
          .map((m) => m.id)
          .sort(),
      ).toEqual(['M-WALL-EMPTY', 'M-WALL-OPEN', 'M-WALL-STAFF']);
    } finally {
      await matterRepo.clearTenantData(ctx);
    }
  });

  it('B6 monotonic matter number sequence: never goes backwards across creation, deletion, rolled-back transactions, 10 concurrent Promise.all allocations, or resetAllDemoData', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const matterRepo = getMatterRepository();
    try {
      await matterRepo.withTenantTransaction(ctx, async (tx) => {
        await tx.query(
          "DELETE FROM public.matter_number_sequences WHERE tenant_id = $1 AND prefix = 'B6TST001'",
          [ctx.tenantId],
        );
      });

      // 1. Allocate two numbers for prefix B6TST001
      const num1 = await matterRepo.allocateNextMatterNumber(ctx, 'B6TST001');
      const num2 = await matterRepo.allocateNextMatterNumber(ctx, 'B6TST001');
      expect(num1).toBe('B6TST001-0001');
      expect(num2).toBe('B6TST001-0002');

      // 2. Allocate inside an outer transaction that rolls back — autonomous transaction preserves the advance
      await expect(
        matterRepo.withTenantTransaction(ctx, async () => {
          const burned = await matterRepo.allocateNextMatterNumber(ctx, 'B6TST001');
          expect(burned).toBe('B6TST001-0003');
          const abortErr = new Error('TENANCY_SIMULATED_OUTER_TX_ABORT') as Error & {
            code: string;
          };
          abortErr.code = 'TENANCY_SIMULATED_OUTER_TX_ABORT';
          throw abortErr;
        }),
      ).rejects.toMatchObject({
        code: 'TENANCY_SIMULATED_OUTER_TX_ABORT',
        message: 'TENANCY_SIMULATED_OUTER_TX_ABORT',
      });

      const numAfterAbort = await matterRepo.allocateNextMatterNumber(ctx, 'B6TST001');
      expect(numAfterAbort).toBe('B6TST001-0004');

      // 3. 10 concurrent Promise.all allocations produce 10 distinct sequential numbers
      const concurrentNumbers = await Promise.all(
        Array.from({ length: 10 }, () =>
          matterRepo.allocateNextMatterNumber(ctx, 'B6TST001'),
        ),
      );
      expect(new Set(concurrentNumbers).size).toBe(10);
      expect([...concurrentNumbers].sort()).toEqual([
        'B6TST001-0005',
        'B6TST001-0006',
        'B6TST001-0007',
        'B6TST001-0008',
        'B6TST001-0009',
        'B6TST001-0010',
        'B6TST001-0011',
        'B6TST001-0012',
        'B6TST001-0013',
        'B6TST001-0014',
      ]);

      // 4. Allocate a number for a seeded prefix (PEN001, seeded max is PEN001-0004), then run resetAllDemoData and verify PEN001 never goes backwards
      const penBeforeReset = await generateMatterNumber(loadCommittedSeedStore(), 'O-000001', ctx);
      const beforeSuffix = Number.parseInt(penBeforeReset.split('-')[1]!, 10);
      expect(beforeSuffix).toBeGreaterThanOrEqual(5);

      await resetAllDemoData('P-000001', ctx);

      const penAfterReset = await generateMatterNumber(loadCommittedSeedStore(), 'O-000001', ctx);
      const afterSuffix = Number.parseInt(penAfterReset.split('-')[1]!, 10);
      expect(afterSuffix).toBe(beforeSuffix + 1);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R409 & R448: row_version optimistic concurrency rejects missing or stale expectedRowVersion across repository, saveMatterRecord, and saveMatterAction, and all 8 matter writers increment row_version', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const carysSession = makeActorSession('P-000001');
    const freshPoolMgr = new TenantPostgresPoolManager();
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });

    try {
      // 1. Repository rejects missing or stale expectedRowVersion with code and message
      const target = structuredClone(
        loadCommittedSeedStore().matters.find((m) => m.id === 'M-000011')!,
      );
      await expect(
        freshMatterRepo.updateMatter(ctx, target, undefined),
      ).rejects.toMatchObject({
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
      });
      await expect(
        freshMatterRepo.updateMatter(ctx, target, 999),
      ).rejects.toMatchObject({
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
      });

      // 2. saveMatterAction rejects missing expectedRowVersion when opts.id is set
      setTestEntraSessionOverride(carysSession.verifiedSession);
      const { rowVersion: _omittedRv, ...payloadWithoutRv } = target;
      void _omittedRv;
      const missingRvActionRes = await runWithActiveActorSession(carysSession, () =>
        saveMatterAction(
          {
            ...payloadWithoutRv,
            title: 'Should Reject Missing RowVersion',
          },
          { id: target.id },
        ),
      );
      expect(missingRvActionRes.matter).toBeNull();
      expect(missingRvActionRes).toMatchObject({
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
      });
      expect(missingRvActionRes.errors?.conflict).toBe(
        MATTER_CONCURRENCY_CONFLICT_MESSAGE,
      );

      // 3. Verify all 8 writers of matters increment row_version in PostgreSQL on a fresh connection:
      // Writer (1): saveMatterRecord
      const rv0 = (
        await freshMatterRepo.getMatterById(ctx, 'M-000011', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!.rowVersion!;
      const w1 = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...loadCommittedSeedStore().matters.find((m) => m.id === 'M-000011')!,
            title: 'Writer 1 saveMatterRecord Title',
          },
          { id: 'M-000011', byId: 'P-000001', expectedRowVersion: rv0 },
        ),
      );
      expect(w1.errors).toBeUndefined();
      expect(w1.matter?.rowVersion).toBe(rv0 + 1);
      const dbAfterW1 = await freshMatterRepo.getMatterById(ctx, 'M-000011', {
        viewerUserId: 'P-000001',
        hasRestrictedMatterAccess: true,
      });
      expect(dbAfterW1?.rowVersion).toBe(rv0 + 1);

      // Writer (2): markEngagementLetterDrafted (on M-000006 where engagementLetterStatus !== 'Signed')
      const m6Before = (
        await freshMatterRepo.getMatterById(ctx, 'M-000006', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const w2 = await runWithActiveActorSession(carysSession, () =>
        markEngagementLetterDrafted('M-000006', 'P-000001'),
      );
      expect(w2.errors).toBeUndefined();
      expect(w2.matter?.rowVersion).toBe((m6Before.rowVersion ?? 1) + 1);

      // Writer (3): runMatterConflictSearchRecord (with currentMatterId)
      const m6BeforeW3 = (
        await freshMatterRepo.getMatterById(ctx, 'M-000006', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const w3 = await runWithActiveActorSession(carysSession, () =>
        runMatterConflictSearchRecord(
          {
            currentMatterId: 'M-000006',
            parties: [
              {
                id: 'cp-w3',
                name: 'Ty Gwyn Holdings Ltd',
                role: 'Client',
                entityType: 'organisation',
                linkedRecordId: m6BeforeW3.clientId,
              },
            ],
          },
          'P-000001',
        ),
      );
      expect(w3.errors).toBeUndefined();
      expect(w3.matter?.rowVersion).toBe((m6BeforeW3.rowVersion ?? 1) + 1);

      // Writer (4): updateMatterConflictRecord
      const m6BeforeW4 = (
        await freshMatterRepo.getMatterById<import('@/domain/types').Matter>(ctx, 'M-000006', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const storedM6Conflict = m6BeforeW4.conflictCheckRecord!;
      const w4 = await runWithActiveActorSession(carysSession, () =>
        updateMatterConflictRecord(
          'M-000006',
          {
            ...storedM6Conflict,
            reviewerMessage: 'Reviewed for W4 row_version test',
          },
          'P-000001',
        ),
      );
      expect(w4.errors).toBeUndefined();
      expect(w4.matter?.rowVersion).toBe((m6BeforeW4.rowVersion ?? 1) + 1);

      // Writer (5): signOffMatterCostsRecord
      const m6BeforeW5 = (
        await freshMatterRepo.getMatterById(ctx, 'M-000006', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const w5 = await runWithActiveActorSession(carysSession, () =>
        signOffMatterCostsRecord('M-000006', 'P-000001', 'Approved estimate for W5'),
      );
      expect(w5.errors).toBeUndefined();
      expect(w5.matter?.rowVersion).toBe((m6BeforeW5.rowVersion ?? 1) + 1);

      // Writer (6): liftMatterRestriction (on staff matter M-000014)
      const m14BeforeW6 = (
        await freshMatterRepo.getMatterById(ctx, 'M-000014', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const w6 = await runWithActiveActorSession(carysSession, () =>
        liftMatterRestriction(
          'M-000014',
          'staff_matter',
          'Authorised lift for W6 row_version test',
          'P-000001',
        ),
      );
      expect(w6.errors).toBeUndefined();
      expect(w6.matter?.rowVersion).toBe((m14BeforeW6.rowVersion ?? 1) + 1);

      // Writer (7): executeMerge (merging a duplicate client contact into M-000011's instructingContactId)
      const m11BeforeW7 = (
        await freshMatterRepo.getMatterById<import('@/domain/types').Matter>(ctx, 'M-000011', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      const dupPersonRes = await runWithActiveActorSession(carysSession, () =>
        savePersonRecord(
          {
            firstName: 'MergeSource',
            surname: 'ContactForW7',
          },
          { byId: 'P-000001' },
        ),
      );
      const dupPersonId = dupPersonRes.person.id;
      const w7Prep = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...m11BeforeW7,
            instructingContactId: dupPersonId,
          },
          {
            id: 'M-000011',
            byId: 'P-000001',
            expectedRowVersion: m11BeforeW7.rowVersion,
          },
        ),
      );
      const rvBeforeMerge = w7Prep.matter!.rowVersion!;
      const survivorPerson = loadCommittedSeedStore().people.find(
        (p) => !p.isEmployee && !p.employment && p.id !== dupPersonId && !p.mergedIntoId,
      )!;
      await runWithActiveActorSession(carysSession, () =>
        executeMerge('person', survivorPerson.id, dupPersonId, 'P-000001'),
      );
      const m11AfterW7 = (
        await freshMatterRepo.getMatterById<import('@/domain/types').Matter>(ctx, 'M-000011', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      expect(m11AfterW7.instructingContactId).toBe(survivorPerson.id);
      expect(m11AfterW7.rowVersion).toBe(rvBeforeMerge + 1);

      // Writer (8): reassignLeaverOwnedRecords
      const w8Prep = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...m11AfterW7,
            leadFeeEarnerId: 'P-000010',
          },
          {
            id: 'M-000011',
            byId: 'P-000001',
            expectedRowVersion: m11AfterW7.rowVersion,
          },
        ),
      );
      const rvBeforeLeaverReassign = w8Prep.matter!.rowVersion!;
      const p10Before = structuredClone(
        (await getPartyRepository().getPersonById<import('@/domain/types').Person>(
          ctx,
          'P-000010',
        ))!,
      );
      await runWithActiveActorSession(carysSession, () =>
        savePersonRecord(
          {
            ...p10Before,
            employment: {
              ...p10Before.employment!,
              status: 'Leaver',
              effectiveTo: '2026-10-31',
            },
          },
          { id: 'P-000010', byId: 'P-000001' },
        ),
      );
      const reassignRes = await runWithActiveActorSession(carysSession, () =>
        reassignLeaverOwnedRecords('P-000010', 'P-000004', 'P-000001'),
      );
      expect(reassignRes.reassignedCount).toBeGreaterThanOrEqual(1);
      const m11AfterW8 = (
        await freshMatterRepo.getMatterById(ctx, 'M-000011', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        })
      )!;
      expect(m11AfterW8.rowVersion).toBe(rvBeforeLeaverReassign + 1);
    } finally {
      await freshPoolMgr.closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R410 & R417: person_emails indexes all active contact and firmWorkEmail addresses in the same transaction, and TenantKeyDateRepository has zero runtime dependency on matter_restriction_metadata', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const carysSession = makeActorSession('P-000001');
    const partyRepo = getPartyRepository();
    const keyDateRepo = new TenantKeyDateRepository();

    try {
      // 1. Save a person with primary + secondary emails and verify findActivePeopleByEmail finds both
      const created = await runWithActiveActorSession(carysSession, () =>
        savePersonRecord(
          {
            firstName: 'Eleri',
            surname: ' SecondaryMailTest',
            emails: [
              {
                id: 'em-1',
                address: 'eleri.primary@notalawfirm.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
              {
                id: 'em-2',
                address: 'eleri.alias@notalawfirm.example',
                typeId: 'email_type.personal',
                isPrimary: false,
                active: true,
              },
              {
                id: 'em-3',
                address: 'eleri.inactive@notalawfirm.example',
                typeId: 'email_type.personal',
                isPrimary: false,
                active: false,
              },
            ],
          },
          { byId: 'P-000001' },
        ),
      );
      expect(
        (
          await partyRepo.findActivePeopleByEmail(
            ctx,
            'ELERI.ALIAS@notalawfirm.example',
          )
        ).map((p) => p.id),
      ).toEqual([created.person.id]);
      expect(
        await partyRepo.findActivePeopleByEmail(
          ctx,
          'eleri.inactive@notalawfirm.example',
        ),
      ).toEqual([]);

      // 2. R408 & R417: Verify public.matter_restriction_metadata is permanently dropped by migration 0015 and TenantKeyDateRepository enforces matter restrictions directly from public.matters
      const bridgeTableCount = await keyDateRepo.withTenantReadTransaction(ctx, async (tx) => {
        const r = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'matter_restriction_metadata'`,
        );
        return Number(r.rows[0]?.cnt ?? 0);
      });
      expect(bridgeTableCount).toBe(0);

      const baseMatter = structuredClone(loadCommittedSeedStore().matters[0]!);
      const staffMatter = {
        ...baseMatter,
        id: 'M-R417-STAFF',
        matterNumber: 'R417STF-0001',
        title: 'R417 Staff Matter Restriction Check',
        isStaffMatter: true,
        hasEthicalWall: false,
        restrictedAccessUserIds: ['P-000001'],
      };
      await getMatterRepository().createMatter(ctx, staffMatter);
      const kdId = await keyDateRepo.allocateNextKeyDateId(ctx);
      const firstKd = (loadCommittedSeedStore().keyDates ?? [])[0];
      if (!firstKd) {
        throw new Error('Expected at least one seeded key date in PostgreSQL');
      }
      const { enquiryId: _omittedEnquiryId, ...templateKd } = structuredClone(firstKd);
      void _omittedEnquiryId;
      await keyDateRepo.putKeyDate(ctx, {
        ...templateKd,
        id: kdId,
        matterId: staffMatter.id,
        title: 'Staff Matter Limitation Date',
      });

      // Outsider P-000008 cannot see the key date on the staff matter
      const outsiderKds = await keyDateRepo.listKeyDatesForMatter(
        ctx,
        staffMatter.id,
        'P-000008',
      );
      expect(outsiderKds).toEqual([]);

      // Authorised participant on staffMatter.restrictedAccessUserIds sees it
      const allowedViewer = 'P-000001';
      const allowedKds = await keyDateRepo.listKeyDatesForMatter(
        ctx,
        staffMatter.id,
        allowedViewer,
      );
      expect(allowedKds.map((k) => k.id)).toContain(kdId);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Same-transaction atomicity & cross-module compensation (Owner Decision 4, R405, R406): forced failure during person, organisation, link, note, matter, and merge writes rolls back both PostgreSQL rows and audit_entries', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const carysSession = makeActorSession('P-000001');
    const freshPoolMgr = new TenantPostgresPoolManager();
    const freshPartyRepo = new TenantPartyRepository({ poolManager: freshPoolMgr });
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    try {
      const preAuditIds = new Set(
        (await freshAuditRepo.listFirmAuditEntriesPage(ctx, { limit: 500 })).entries.map(
          (e) => e.id,
        ),
      );
      const prePeopleCount = (await freshPartyRepo.countAllTenantPartyRows(ctx)).people;
      const preOrgsCount = (await freshPartyRepo.countAllTenantPartyRows(ctx)).organisations;
      const preLinksCount = (await freshPartyRepo.countAllTenantPartyRows(ctx)).links;
      const preNotesCount = (await freshPartyRepo.countAllTenantPartyRows(ctx)).notes;
      const preMattersCount = (await freshMatterRepo.countAllTenantMatterRows(ctx)).matters;

      setAuditAdapterFailureHookForTesting(() => {
        const simErr = new Error('SIMULATED_S016_TX_FAILURE') as Error & {
          code: string;
        };
        simErr.code = 'TENANCY_SIMULATED_S016_TX_FAILURE';
        throw simErr;
      });

      await expect(
        runWithActiveActorSession(carysSession, () =>
          savePersonRecord(
            { firstName: 'RolledBack', surname: 'Person' },
            { byId: 'P-000001' },
          ),
        ),
      ).rejects.toThrow(/SIMULATED_S016_TX_FAILURE/);

      await expect(
        runWithActiveActorSession(carysSession, () =>
          saveOrganisationRecord(
            { legalName: 'RolledBack Organisation Ltd' },
            { byId: 'P-000001' },
          ),
        ),
      ).rejects.toThrow(/SIMULATED_S016_TX_FAILURE/);

      await expect(
        runWithActiveActorSession(carysSession, () =>
          createOrUpdateLink(
            {
              personId: 'P-000001',
              organisationId: 'O-000001',
              jobTitle: 'RolledBack Link',
              department: '',
              roleWithinOrganisation: 'Advisor',
              contactRoleIds: [],
              isPrimaryContact: false,
              isCurrent: true,
              startDate: '2026-11-01',
              endDate: null,
              contactStatusId: 'contact_status.active',
            },
            'P-000001',
          ),
        ),
      ).rejects.toThrow(/SIMULATED_S016_TX_FAILURE/);

      await expect(
        runWithActiveActorSession(carysSession, () =>
          addNoteToRecord('person', 'P-000001', 'RolledBack Note Text', 'P-000001'),
        ),
      ).rejects.toThrow(/SIMULATED_S016_TX_FAILURE/);

      const templateMatter = structuredClone(loadCommittedSeedStore().matters[0]!);
      const { id: _omittedId, ...newMatterPayload } = templateMatter;
      void _omittedId;
      await expect(
        runWithActiveActorSession(carysSession, () =>
          saveMatterRecord(
            {
              ...newMatterPayload,
              matterNumber: 'DRAFT',
              title: 'RolledBack Draft Matter',
            },
            { byId: 'P-000001', saveMode: 'draft' },
          ),
        ),
      ).rejects.toThrow(/SIMULATED_S016_TX_FAILURE/);

      setAuditAdapterFailureHookForTesting(null);

      // Verify zero rows were committed to PostgreSQL across all tables
      const postPartyCounts = await freshPartyRepo.countAllTenantPartyRows(ctx);
      const postMatterCounts = await freshMatterRepo.countAllTenantMatterRows(ctx);
      expect(postPartyCounts.people).toBe(prePeopleCount);
      expect(postPartyCounts.organisations).toBe(preOrgsCount);
      expect(postPartyCounts.links).toBe(preLinksCount);
      expect(postPartyCounts.notes).toBe(preNotesCount);
      expect(postMatterCounts.matters).toBe(preMattersCount);

      // Verify zero new audit entries were committed during the rolled-back writes
      const recentAudit = await freshAuditRepo.listFirmAuditEntriesPage(ctx, {
        limit: 500,
      });
      expect(
        recentAudit.entries.filter((e) => !preAuditIds.has(e.id)),
      ).toEqual([]);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await freshPoolMgr.closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Import idempotency: importFirmStoreModulesToPostgres([parties, matters]) run twice produces identical row counts and sequences continue past imported high-water marks', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const store = loadCommittedSeedStore();

    const run1 = await importFirmStoreModulesToPostgres({
      ctx,
      store,
      modules: ['parties', 'matters'],
    });
    const run2 = await importFirmStoreModulesToPostgres({
      ctx,
      store,
      modules: ['parties', 'matters'],
    });

    expect(run2).toEqual(run1);
    expect(run1.counts.people).toBe(store.people.length);
    expect(run1.counts.organisations).toBe(store.organisations.length);
    expect(run1.counts.links).toBe(store.links.length);
    expect(run1.counts.notes).toBe(store.notes.length);
    expect(run1.counts.mergeHistory).toBe(store.mergeHistory.length);
    expect(run1.counts.matters).toBe(store.matters.length);

    // Next allocated IDs must be strictly greater than every existing store ID
    const nextPersonId = await getPartyRepository().allocateNextPersonId(ctx);
    expect(store.people.some((p) => p.id === nextPersonId)).toBe(false);
    const nextMatterId = await getMatterRepository().allocateNextMatterId(ctx);
    expect(store.matters.some((m) => m.id === nextMatterId)).toBe(false);

    await getGlobalTenantPostgresPoolManager().closeAllPools();
  });

  it('R465: Cold start or new replica with unset ONESQUARED_RUNTIME_STORE_PATH and cleared globals preserves PostgreSQL people and matters without running clearTenantData', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const carysSession = makeActorSession('P-000001');
    const savedRuntimeStoreEnv = process.env.ONESQUARED_RUNTIME_STORE_PATH;

    try {
      // 1. Write a person and a matter through the services
      const createdPerson = await runWithActiveActorSession(carysSession, () =>
        savePersonRecord(
          {
            firstName: 'ColdStart',
            surname: 'ReplicaSurvivor',
            emails: [
              {
                id: 'em-r465-1',
                address: 'coldstart.survivor@notalawfirm.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { byId: 'P-000001' },
        ),
      );
      expect(createdPerson.errors).toBeUndefined();
      const personId = createdPerson.person.id;

      const templateMatter = structuredClone(
        (await getMatterRepository().listAllMattersUnfiltered<import('@/domain/types').Matter>(
          testDataResetContext(),
        ))[0]!,
      );
      const { id: _omitId, rowVersion: _omitRv, ...newMatterInput } = templateMatter;
      void _omitId;
      void _omitRv;
      const createdMatter = await runWithActiveActorSession(carysSession, () =>
        saveMatterRecord(
          {
            ...newMatterInput,
            matterNumber: 'DRAFT',
            title: 'R465 Cold Start Replica Matter',
          },
          { byId: 'P-000001', saveMode: 'draft' },
        ),
      );
      expect(createdMatter.errors).toBeUndefined();
      const matterId = createdMatter.matter!.id;

      // 2. Simulate a restart: vi.resetModules(), clear every __oneSquared* global, unset ONESQUARED_RUNTIME_STORE_PATH
      await getGlobalTenantPostgresPoolManager().closeAllPools();
      vi.resetModules();
      for (const key of Object.keys(globalThis)) {
        if (key.startsWith('__oneSquared')) {
          delete (globalThis as Record<string, unknown>)[key];
        }
      }
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;

      // 3. Re-import services and repositories in the fresh replica module graph and spy on clearTenantData
      const freshCore = await import('@platform/core');
      const clearPartySpy = vi.spyOn(
        freshCore.TenantPartyRepository.prototype,
        'clearTenantData',
      );
      const clearMatterSpy = vi.spyOn(
        freshCore.TenantMatterRepository.prototype,
        'clearTenantData',
      );
      const clearKeyDateSpy = vi.spyOn(
        freshCore.TenantKeyDateRepository.prototype,
        'clearTenantData',
      );
      const clearAuditSpy = vi.spyOn(
        freshCore.TenantAuditRepository.prototype,
        'resetNonLiveAuditLog',
      );

      const freshEntra = await import('@/server/entraAuth');
      const freshRbac = await import('@/server/rbacRuntime');
      const freshServices = await import('@/server/services');
      const freshSignedCookie = freshEntra.createSignedEntraSessionCookie(
        carysSession.verifiedSession,
      );
      const freshVerifiedSession =
        freshEntra.verifySignedEntraSessionCookie(freshSignedCookie)!;
      const freshCarysSession = {
        ...carysSession,
        verifiedSession: freshVerifiedSession,
      };

      const snapshotAfterColdStart = await freshRbac.runWithActiveActorSession(
        freshCarysSession,
        () => freshServices.getAppSnapshot('P-000001'),
      );

      // 4. Assert both person and matter are unchanged and no clearTenantData ran
      const readBackPerson = snapshotAfterColdStart.people.find(
        (p) => p.id === personId,
      );
      const readBackMatter = snapshotAfterColdStart.matters.find(
        (m) => m.id === matterId,
      );
      expect(readBackPerson).toBeDefined();
      expect(readBackPerson?.firstName).toBe('ColdStart');
      expect(readBackPerson?.surname).toBe('ReplicaSurvivor');
      expect(readBackMatter).toBeDefined();
      expect(readBackMatter?.title).toBe('R465 Cold Start Replica Matter');

      expect(clearPartySpy).not.toHaveBeenCalled();
      expect(clearMatterSpy).not.toHaveBeenCalled();
      expect(clearKeyDateSpy).not.toHaveBeenCalled();
      expect(clearAuditSpy).not.toHaveBeenCalled();

      await freshCore.getGlobalTenantPostgresPoolManager().closeAllPools();
    } finally {
      if (savedRuntimeStoreEnv !== undefined) {
        process.env.ONESQUARED_RUNTIME_STORE_PATH = savedRuntimeStoreEnv;
      } else {
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      }
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R466: Two isolated module instances (replicas) sharing one database see writes immediately and stale saves from Replica B do not overwrite Replica A changes', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const carysSession = makeActorSession('P-000001');

    // Verify zero __oneSquaredSynced* globals in core/src/tenancy/ or src/
    const coreTenancyDir = path.resolve(__dirname, '../src/tenancy');
    const walkTsFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTsFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    for (const file of walkTsFiles(coreTenancyDir)) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).not.toContain('__oneSquaredSynced');
    }

    // Load Replica A and Replica B from separate vi.resetModules() module graphs
    vi.resetModules();
    const replicaAEntra = await import('@/server/entraAuth');
    const replicaARbac = await import('@/server/rbacRuntime');
    const replicaAServices = await import('@/server/services');
    const replicaACore = await import('@platform/core');
    const replicaASession = {
      ...carysSession,
      verifiedSession: replicaAEntra.verifySignedEntraSessionCookie(
        replicaAEntra.createSignedEntraSessionCookie(carysSession.verifiedSession),
      )!,
    };

    vi.resetModules();
    for (const key of Object.keys(globalThis)) {
      if (key.startsWith('__oneSquared')) {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
    const replicaBEntra = await import('@/server/entraAuth');
    const replicaBRbac = await import('@/server/rbacRuntime');
    const replicaBServices = await import('@/server/services');
    const replicaBCore = await import('@platform/core');
    const replicaBSession = {
      ...carysSession,
      verifiedSession: replicaBEntra.verifySignedEntraSessionCookie(
        replicaBEntra.createSignedEntraSessionCookie(carysSession.verifiedSession),
      )!,
    };

    try {
      // 1. Replica B reads initial snapshot before Replica A writes
      const snapBInitial = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () => replicaBServices.getAppSnapshot('P-000001'),
      );
      const matterM11InitialInB = snapBInitial.matters.find(
        (m) => m.id === 'M-000011',
      )!;
      const staleRowVersionInB = matterM11InitialInB.rowVersion!;
      const personP3InitialInB = snapBInitial.people.find(
        (p) => p.id === 'P-000003',
      )!;

      // 2. Replica A creates a new person and a new matter, and updates M-000011 and P-000002
      const newPersonFromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.savePersonRecord(
            {
              firstName: 'ReplicaA',
              surname: 'ImmediateVisibility',
            },
            { byId: 'P-000001' },
          ),
      );
      expect(newPersonFromA.errors).toBeUndefined();

      const { id: _omitId, rowVersion: _omitRv, ...m11Template } =
        structuredClone(matterM11InitialInB);
      void _omitId;
      void _omitRv;
      const newMatterFromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.saveMatterRecord(
            {
              ...m11Template,
              matterNumber: 'DRAFT',
              title: 'Replica A Newly Created Matter',
            },
            { byId: 'P-000001', saveMode: 'draft' },
          ),
      );
      expect(newMatterFromA.errors).toBeUndefined();

      const updatedM11FromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.saveMatterRecord(
            {
              ...matterM11InitialInB,
              title: 'Replica A Updated Matter Title',
            },
            {
              id: 'M-000011',
              byId: 'P-000001',
              expectedRowVersion: staleRowVersionInB,
            },
          ),
      );
      expect(updatedM11FromA.errors).toBeUndefined();
      expect(updatedM11FromA.matter?.rowVersion).toBe(staleRowVersionInB + 1);

      const personP2InA = snapBInitial.people.find((p) => p.id === 'P-000002')!;
      const updatedP2FromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.savePersonRecord(
            {
              ...personP2InA,
              jobTitle: 'Replica A Senior Partner Title',
            },
            { id: 'P-000002', byId: 'P-000001' },
          ),
      );
      expect(updatedP2FromA.errors).toBeUndefined();

      // 3. Replica B immediately sees Replica A's new person, new matter, updated matter, and updated person
      const snapBAfterA = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () => replicaBServices.getAppSnapshot('P-000001'),
      );
      expect(
        snapBAfterA.people.some((p) => p.id === newPersonFromA.person.id),
      ).toBe(true);
      expect(
        snapBAfterA.matters.some((m) => m.id === newMatterFromA.matter!.id),
      ).toBe(true);
      expect(
        snapBAfterA.matters.find((m) => m.id === 'M-000011')?.title,
      ).toBe('Replica A Updated Matter Title');
      expect(
        snapBAfterA.people.find((p) => p.id === 'P-000002')?.jobTitle,
      ).toBe('Replica A Senior Partner Title');

      // 4. A save from Replica B based on its older read (staleRowVersionInB) returns errors.conflict and does not overwrite A's change
      const staleSaveFromB = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () =>
          replicaBServices.saveMatterRecord(
            {
              ...matterM11InitialInB,
              title: 'Replica B Stale Overwrite Attempt',
            },
            {
              id: 'M-000011',
              byId: 'P-000001',
              expectedRowVersion: staleRowVersionInB,
            },
          ),
      );
      expect(staleSaveFromB.matter).toBeNull();
      expect(staleSaveFromB.errors?.conflict).toBe(
        MATTER_CONCURRENCY_CONFLICT_MESSAGE,
      );

      // Saving P-000003 from Replica B does not overwrite Replica A's change to P-000002 or newPersonFromA
      const saveP3FromB = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () =>
          replicaBServices.savePersonRecord(
            {
              ...personP3InitialInB,
              interests: 'Replica B Updated P3 Interests',
            },
            { id: 'P-000003', byId: 'P-000001' },
          ),
      );
      expect(saveP3FromB.errors).toBeUndefined();

      const snapAVerify = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () => replicaAServices.getAppSnapshot('P-000001'),
      );
      expect(
        snapAVerify.matters.find((m) => m.id === 'M-000011')?.title,
      ).toBe('Replica A Updated Matter Title');
      expect(
        snapAVerify.people.find((p) => p.id === 'P-000002')?.jobTitle,
      ).toBe('Replica A Senior Partner Title');
      expect(
        snapAVerify.people.some((p) => p.id === newPersonFromA.person.id),
      ).toBe(true);
      expect(
        snapAVerify.people.find((p) => p.id === 'P-000003')?.interests,
      ).toBe('Replica B Updated P3 Interests');
    } finally {
      await replicaACore.getGlobalTenantPostgresPoolManager().closeAllPools();
      await replicaBCore.getGlobalTenantPostgresPoolManager().closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R467: Services-level two-tenant test in one process (Model B configuration) interleaves saves and reads across Tenant A and Tenant B with zero cross-tenant leakage', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
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
    const validatedConfigA = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(rawConfigB, {});
    const validatedConfigB = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(null);

    const sessionA = makeActorSession(
      'P-000001',
      ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
      'tenant-a',
    );
    const sessionB = makeActorSession(
      'P-000001',
      ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
      'tenant-b',
    );
    const ctxA = makeTenantCtx('tenant-a', 'P-000001');
    const ctxB = makeTenantCtx('tenant-b', 'P-000001');

    try {
      // Seed Tenant A and Tenant B per-tenant databases with base fixture so P-000001 and O-000001 exist in both
      await getMatterRepository().clearTenantData(ctxA);
      await getPartyRepository().clearTenantData(ctxA);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxA);
      await importFirmStoreModulesToPostgres({
        ctx: ctxA,
        tenantConfig: validatedConfigA,
        store: loadCommittedSeedStore(),
        modules: ['parties', 'matters'],
      });

      await getMatterRepository().clearTenantData(ctxB);
      await getPartyRepository().clearTenantData(ctxB);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxB);
      await importFirmStoreModulesToPostgres({
        ctx: ctxB,
        tenantConfig: validatedConfigB,
        store: loadCommittedSeedStore(),
        modules: ['parties', 'matters'],
      });

      // Step 1: Tenant A saves a person, an organisation, and a matter via services
      setActiveTenantConfigForTesting(rawConfigA, {});
      const personARes = await runWithActiveActorSession(sessionA, () =>
        savePersonRecord(
          {
            firstName: 'TenantAOnlyFirstName',
            surname: 'TenantAOnlySurname',
          },
          { byId: 'P-000001' },
        ),
      );
      expect(personARes.errors).toBeUndefined();

      const orgARes = await runWithActiveActorSession(sessionA, () =>
        saveOrganisationRecord(
          {
            legalName: 'Tenant A Exclusive Holdings Ltd',
          },
          { byId: 'P-000001' },
        ),
      );
      expect(orgARes.errors).toBeUndefined();

      const templateMatter = structuredClone(
        (await getMatterRepository().listAllMattersUnfiltered<import('@/domain/types').Matter>(
          ctxA,
        ))[0]!,
      );
      const { id: _omitId, rowVersion: _omitRv, ...matterInput } = templateMatter;
      void _omitId;
      void _omitRv;
      const matterARes = await runWithActiveActorSession(sessionA, () =>
        saveMatterRecord(
          {
            ...matterInput,
            clientId: orgARes.organisation.id,
            matterNumber: 'DRAFT',
            title: 'Tenant A Exclusive Matter Deal',
          },
          { byId: 'P-000001', saveMode: 'draft' },
        ),
      );
      expect(matterARes.errors).toBeUndefined();

      // Step 2: Interleave Tenant B saves in the same process
      setActiveTenantConfigForTesting(rawConfigB, {});
      const personBRes = await runWithActiveActorSession(sessionB, () =>
        savePersonRecord(
          {
            firstName: 'TenantBOnlyFirstName',
            surname: 'TenantBOnlySurname',
          },
          { byId: 'P-000001' },
        ),
      );
      expect(personBRes.errors).toBeUndefined();

      const orgBRes = await runWithActiveActorSession(sessionB, () =>
        saveOrganisationRecord(
          {
            legalName: 'Tenant B Exclusive Ventures Plc',
          },
          { byId: 'P-000001' },
        ),
      );
      expect(orgBRes.errors).toBeUndefined();

      const matterBRes = await runWithActiveActorSession(sessionB, () =>
        saveMatterRecord(
          {
            ...matterInput,
            clientId: orgBRes.organisation.id,
            matterNumber: 'DRAFT',
            title: 'Tenant B Exclusive Matter Merger',
          },
          { byId: 'P-000001', saveMode: 'draft' },
        ),
      );
      expect(matterBRes.errors).toBeUndefined();

      // Step 3: Interleave another Tenant A save after Tenant B ran, then read Tenant A snapshot & audit
      setActiveTenantConfigForTesting(rawConfigA, {});
      const personA2Res = await runWithActiveActorSession(sessionA, () =>
        savePersonRecord(
          {
            firstName: 'TenantASecondFirstName',
            surname: 'TenantASecondSurname',
          },
          { byId: 'P-000001' },
        ),
      );
      expect(personA2Res.errors).toBeUndefined();

      const snapA = await runWithActiveActorSession(sessionA, () =>
        getAppSnapshot('P-000001'),
      );
      const auditA = await runWithActiveActorSession(sessionA, () =>
        listFirmAuditEntriesPage('P-000001', { limit: 200 }),
      );

      // Positive controls for Tenant A
      expect(
        snapA.people.some((p) => p.firstName === 'TenantAOnlyFirstName'),
      ).toBe(true);
      expect(
        snapA.people.some((p) => p.firstName === 'TenantASecondFirstName'),
      ).toBe(true);
      expect(
        snapA.organisations.some(
          (o) => o.legalName === 'Tenant A Exclusive Holdings Ltd',
        ),
      ).toBe(true);
      expect(
        snapA.matters.some((m) => m.title === 'Tenant A Exclusive Matter Deal'),
      ).toBe(true);
      expect(
        auditA.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant A Exclusive'),
        ),
      ).toBe(true);

      // Negative controls: zero Tenant B records, counts, or audit entries in Tenant A
      expect(
        snapA.people.some((p) => p.firstName === 'TenantBOnlyFirstName'),
      ).toBe(false);
      expect(
        snapA.organisations.some(
          (o) => o.legalName === 'Tenant B Exclusive Ventures Plc',
        ),
      ).toBe(false);
      expect(
        snapA.matters.some(
          (m) => m.title === 'Tenant B Exclusive Matter Merger',
        ),
      ).toBe(false);
      expect(
        auditA.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant B Exclusive'),
        ),
      ).toBe(false);

      // Step 4: Read Tenant B snapshot & audit and assert positive and negative controls
      setActiveTenantConfigForTesting(rawConfigB, {});
      const snapB = await runWithActiveActorSession(sessionB, () =>
        getAppSnapshot('P-000001'),
      );
      const auditB = await runWithActiveActorSession(sessionB, () =>
        listFirmAuditEntriesPage('P-000001', { limit: 200 }),
      );

      // Positive controls for Tenant B
      expect(
        snapB.people.some((p) => p.firstName === 'TenantBOnlyFirstName'),
      ).toBe(true);
      expect(
        snapB.organisations.some(
          (o) => o.legalName === 'Tenant B Exclusive Ventures Plc',
        ),
      ).toBe(true);
      expect(
        snapB.matters.some(
          (m) => m.title === 'Tenant B Exclusive Matter Merger',
        ),
      ).toBe(true);
      expect(
        auditB.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant B Exclusive'),
        ),
      ).toBe(true);

      // Negative controls: zero Tenant A records, counts, or audit entries in Tenant B
      expect(
        snapB.people.some((p) => p.firstName === 'TenantAOnlyFirstName'),
      ).toBe(false);
      expect(
        snapB.people.some((p) => p.firstName === 'TenantASecondFirstName'),
      ).toBe(false);
      expect(
        snapB.organisations.some(
          (o) => o.legalName === 'Tenant A Exclusive Holdings Ltd',
        ),
      ).toBe(false);
      expect(
        snapB.matters.some((m) => m.title === 'Tenant A Exclusive Matter Deal'),
      ).toBe(false);
      expect(
        auditB.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant A Exclusive'),
        ),
      ).toBe(false);
      expect(snapB.people.length).toBe(snapA.people.length - 1);
    } finally {
      setActiveTenantConfigForTesting(null);
      await getMatterRepository().clearTenantData(ctxA);
      await getPartyRepository().clearTenantData(ctxA);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxA);
      await getMatterRepository().clearTenantData(ctxB);
      await getPartyRepository().clearTenantData(ctxB);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
      await getGlobalTenantPostgresPoolManager().closeAllPools();
    }
  });

  it('R473: two-replica A -> B -> A staff-matter access changes update matters.restricted_access_user_ids_json and key-date visibility at every step with zero process-level digest cache', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const adminCtx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const adminSession = makeActorSession('P-000001');

    // Find an active employee user U who is not initially permitted on the staff matter
    const allPeople = await getPartyRepository().listAllPeople<
      import('@/domain/types').Person
    >(adminCtx);
    const allMatters = await getMatterRepository().listAllMattersUnfiltered<
      import('@/domain/types').Matter
    >(adminCtx);
    const positiveControlUserId = 'P-000001';
    const staffMatter: import('@/domain/types').Matter = {
      ...allMatters[0]!,
      isStaffMatter: true,
      hasEthicalWall: false,
      responsiblePartnerId: positiveControlUserId,
      supervisingPartnerId: positiveControlUserId,
      leadFeeEarnerId: positiveControlUserId,
      teamMemberIds: [],
      restrictedAccessUserIds: [positiveControlUserId],
    };
    await getMatterRepository().putMatter(adminCtx, staffMatter, {
      expectedRowVersion: null,
      sqlRestrictedAccessUserIds: [positiveControlUserId],
    });
    const candidateUser = allPeople.find(
      (p) =>
        p.isEmployee &&
        !p.mergedIntoId &&
        p.id !== positiveControlUserId &&
        p.id !== staffMatter.responsiblePartnerId &&
        p.id !== staffMatter.supervisingPartnerId &&
        p.id !== staffMatter.leadFeeEarnerId &&
        !(staffMatter.teamMemberIds ?? []).includes(p.id) &&
        !(staffMatter.restrictedAccessUserIds ?? []).includes(p.id) &&
        !(p.roles ?? []).includes('admin') &&
        !(p.roles ?? []).includes('managing_partner') &&
        !(p.roles ?? []).includes('risk_compliance'),
    )!;
    expect(candidateUser).toBeDefined();
    const userU = candidateUser.id;
    const originalRoles = [...(candidateUser.roles ?? ['fee_earner'])];
    const userUSession = makeActorSession(userU, ['fee_earner']);

    const userUTeamId =
      loadCommittedSeedStore().teams.find(
        (t) =>
          t.active &&
          (t.memberIds.includes(userU) || t.leadIds.includes(userU)),
      )?.id ?? 'TM-000001';

    // Ensure the staff matter has a dedicated key date on userU's team for visibility assertions
    const keyDateRepo = new TenantKeyDateRepository();
    const testKeyDateId = 'KD-R473-STAFF-01';
    const nowIso = new Date().toISOString();
    await keyDateRepo.putKeyDate(adminCtx, {
      id: testKeyDateId,
      matterId: staffMatter.id,
      keyDateTypeId: 'kd-type-limitation',
      category: 'limitation',
      title: 'R473 Staff Matter Key Date',
      dueDate: '2027-06-15',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: userUTeamId,
      responsiblePersonIds: [positiveControlUserId],
      verification: {
        required: true,
        proposedById: positiveControlUserId,
        proposedAt: nowIso,
        verifiedById: positiveControlUserId,
        verifiedAt: nowIso,
      },
      createdById: positiveControlUserId,
      createdAt: nowIso,
      updatedById: positiveControlUserId,
      updatedAt: nowIso,
      version: 1,
    });

    const readRestrictedIdsOnFreshConnection = async (): Promise<string[]> => {
      const freshPools = new TenantPostgresPoolManager();
      try {
        const freshMatterRepo = new TenantMatterRepository({
          poolManager: freshPools,
        });
        return await freshMatterRepo.withTenantReadTransaction(
          adminCtx,
          async (tx) => {
            const res = await tx.query<{
              restricted_access_user_ids_json: string[];
            }>(
              'SELECT restricted_access_user_ids_json FROM public.matters WHERE tenant_id = $1 AND id = $2',
              [adminCtx.tenantId, staffMatter.id],
            );
            return res.rows[0]?.restricted_access_user_ids_json ?? [];
          },
        );
      } finally {
        await freshPools.closeAllPools();
      }
    };

    const userUCtx = makeTenantCtx('not-a-law-firm', userU, ['fee_earner']);

    // Zero process-level digest cache exists on global
    expect(
      (globalThis as Record<string, unknown>)
        .__oneSquaredMatterRestrictionSyncDigests,
    ).toBeUndefined();

    // Baseline before Step 1: U is not in restricted_access_user_ids_json, positive control is
    const baselineIds = await readRestrictedIdsOnFreshConnection();
    expect(baselineIds).toContain(positiveControlUserId);
    expect(baselineIds).not.toContain(userU);

    // Step 1 (Replica A): Add user U to staff matter access via role grant ('managing_partner')
    vi.resetModules();
    const replicaAEntra = await import('@/server/entraAuth');
    const replicaA = await import('@/server/services');
    const { runWithActiveActorSession: runInReplicaA } = await import(
      '@/server/rbacRuntime'
    );
    const rebrandSession = (
      entraMod: typeof replicaAEntra,
      s: typeof adminSession,
    ) => ({
      ...s,
      verifiedSession: entraMod.verifySignedEntraSessionCookie(
        entraMod.createSignedEntraSessionCookie(s.verifiedSession),
      )!,
    });
    const adminSessionA = rebrandSession(replicaAEntra, adminSession);
    const userUSessionA = rebrandSession(replicaAEntra, userUSession);

    const step1Res = await runInReplicaA(adminSessionA, () =>
      replicaA.updateEmployeeRolesAndSupports(
        userU,
        { roles: Array.from(new Set([...originalRoles, 'managing_partner'])) },
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(step1Res.ok).toBe(true);

    const step1Ids = await readRestrictedIdsOnFreshConnection();
    expect(step1Ids).toContain(positiveControlUserId);
    expect(step1Ids).toContain(userU);

    const step1RepoListU = await keyDateRepo.listKeyDatesForMatter(
      userUCtx,
      staffMatter.id,
      userU,
    );
    expect(step1RepoListU.some((kd) => kd.id === testKeyDateId)).toBe(true);
    const step1SnapU = await runInReplicaA(userUSessionA, () =>
      replicaA.getMatterKeyDatesSnapshot(staffMatter.id, userU),
    );
    expect(step1SnapU.keyDates.some((kd) => kd.id === testKeyDateId)).toBe(
      true,
    );
    const step1DiaryU = await runInReplicaA(userUSessionA, () =>
      replicaA.queryKeyDatesTeamDiaryRecord({}, userU),
    );
    expect(step1DiaryU.some((d) => d.keyDateId === testKeyDateId)).toBe(true);
    const step1ListControl = await keyDateRepo.listKeyDatesForMatter(
      adminCtx,
      staffMatter.id,
      positiveControlUserId,
    );
    expect(step1ListControl.some((kd) => kd.id === testKeyDateId)).toBe(true);

    // Step 2 (Replica B after vi.resetModules()): Remove user U from staff matter access
    vi.resetModules();
    const replicaBEntra = await import('@/server/entraAuth');
    const replicaB = await import('@/server/services');
    const { runWithActiveActorSession: runInReplicaB } = await import(
      '@/server/rbacRuntime'
    );
    const adminSessionB = rebrandSession(replicaBEntra, adminSession);
    const userUSessionB = rebrandSession(replicaBEntra, userUSession);

    const step2Res = await runInReplicaB(adminSessionB, () =>
      replicaB.updateEmployeeRolesAndSupports(
        userU,
        { roles: originalRoles },
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(step2Res.ok).toBe(true);

    const step2Ids = await readRestrictedIdsOnFreshConnection();
    expect(step2Ids).toContain(positiveControlUserId);
    expect(step2Ids).not.toContain(userU);

    const step2RepoListU = await keyDateRepo.listKeyDatesForMatter(
      userUCtx,
      staffMatter.id,
      userU,
    );
    expect(step2RepoListU).toHaveLength(0);
    const step2SnapU = await runInReplicaB(userUSessionB, () =>
      replicaB.getMatterKeyDatesSnapshot(staffMatter.id, userU),
    );
    expect(step2SnapU.keyDates).toHaveLength(0);
    const step2DiaryU = await runInReplicaB(userUSessionB, () =>
      replicaB.queryKeyDatesTeamDiaryRecord({}, userU),
    );
    expect(step2DiaryU.some((d) => d.keyDateId === testKeyDateId)).toBe(false);
    const step2ListControl = await keyDateRepo.listKeyDatesForMatter(
      adminCtx,
      staffMatter.id,
      positiveControlUserId,
    );
    expect(step2ListControl.some((kd) => kd.id === testKeyDateId)).toBe(true);

    // Step 3 (Replica A adds U back — returning to Step 1's exact state A):
    // Must not skip the write due to any stale in-memory digest from Step 1.
    const step3Res = await runInReplicaA(adminSessionA, () =>
      replicaA.updateEmployeeRolesAndSupports(
        userU,
        { roles: Array.from(new Set([...originalRoles, 'managing_partner'])) },
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(step3Res.ok).toBe(true);

    const step3Ids = await readRestrictedIdsOnFreshConnection();
    expect(step3Ids).toContain(positiveControlUserId);
    expect(step3Ids).toContain(userU);

    const step3RepoListU = await keyDateRepo.listKeyDatesForMatter(
      userUCtx,
      staffMatter.id,
      userU,
    );
    expect(step3RepoListU.some((kd) => kd.id === testKeyDateId)).toBe(true);
    const step3SnapU = await runInReplicaA(userUSessionA, () =>
      replicaA.getMatterKeyDatesSnapshot(staffMatter.id, userU),
    );
    expect(step3SnapU.keyDates.some((kd) => kd.id === testKeyDateId)).toBe(
      true,
    );
    const step3DiaryU = await runInReplicaA(userUSessionA, () =>
      replicaA.queryKeyDatesTeamDiaryRecord({}, userU),
    );
    expect(step3DiaryU.some((d) => d.keyDateId === testKeyDateId)).toBe(true);
    const step3ListControl = await keyDateRepo.listKeyDatesForMatter(
      adminCtx,
      staffMatter.id,
      positiveControlUserId,
    );
    expect(step3ListControl.some((kd) => kd.id === testKeyDateId)).toBe(true);
  });

  it('R478 & R479: two-replica interleaving test — when Replica A loads inputs, Replica B removes user U (including team-lead access) and commits, and Replica A runs former read-path callers, a concurrent person write, or saveMatterRecord, U is not written back to restricted_access_user_ids_json and cannot see the matter key dates', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const adminCtx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const adminSession = makeActorSession('P-000001');

    const allPeople = await getPartyRepository().listAllPeople<
      import('@/domain/types').Person
    >(adminCtx);
    const allMatters = await getMatterRepository().listAllMattersUnfiltered<
      import('@/domain/types').Matter
    >(adminCtx);
    const positiveControlUserId = 'P-000001';
    const staffMatter: import('@/domain/types').Matter = {
      ...allMatters[0]!,
      isStaffMatter: true,
      hasEthicalWall: false,
      responsiblePartnerId: positiveControlUserId,
      supervisingPartnerId: positiveControlUserId,
      leadFeeEarnerId: positiveControlUserId,
      teamMemberIds: [],
      restrictedAccessUserIds: [positiveControlUserId],
    };
    await getMatterRepository().putMatter(adminCtx, staffMatter, {
      expectedRowVersion: null,
      sqlRestrictedAccessUserIds: [positiveControlUserId],
    });

    const nonOversightEmployees = allPeople.filter(
      (p) =>
        p.isEmployee &&
        !p.mergedIntoId &&
        p.id !== positiveControlUserId &&
        p.id !== staffMatter.responsiblePartnerId &&
        p.id !== staffMatter.supervisingPartnerId &&
        p.id !== staffMatter.leadFeeEarnerId &&
        !(staffMatter.teamMemberIds ?? []).includes(p.id) &&
        !(staffMatter.restrictedAccessUserIds ?? []).includes(p.id) &&
        !(p.roles ?? []).includes('admin') &&
        !(p.roles ?? []).includes('managing_partner') &&
        !(p.roles ?? []).includes('risk_compliance'),
    );
    expect(nonOversightEmployees.length).toBeGreaterThanOrEqual(2);
    const candidateUser = nonOversightEmployees[0]!;
    const unrelatedEmployee = nonOversightEmployees[1]!;
    const userU = candidateUser.id;
    const originalRoles = [...(candidateUser.roles ?? ['fee_earner'])];
    const userUSession = makeActorSession(userU, ['fee_earner']);
    const userUCtx = makeTenantCtx('not-a-law-firm', userU, ['fee_earner']);

    const userUTeamId =
      loadCommittedSeedStore().teams.find(
        (t) =>
          t.active &&
          (t.memberIds.includes(userU) || t.leadIds.includes(userU)),
      )?.id ?? 'TM-000001';

    const keyDateRepo = new TenantKeyDateRepository();
    const testKeyDateId = 'KD-R478-STAFF-01';
    const nowIso = new Date().toISOString();
    await keyDateRepo.putKeyDate(adminCtx, {
      id: testKeyDateId,
      matterId: staffMatter.id,
      keyDateTypeId: 'kd-type-limitation',
      category: 'limitation',
      title: 'R478 Interleaved Staff Matter Key Date',
      dueDate: '2027-07-01',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId: userUTeamId,
      responsiblePersonIds: [positiveControlUserId],
      verification: {
        required: true,
        proposedById: positiveControlUserId,
        proposedAt: nowIso,
        verifiedById: positiveControlUserId,
        verifiedAt: nowIso,
      },
      createdById: positiveControlUserId,
      createdAt: nowIso,
      updatedById: positiveControlUserId,
      updatedAt: nowIso,
      version: 1,
    });

    const readRestrictedIdsOnFreshConnection = async (): Promise<string[]> => {
      const freshPools = new TenantPostgresPoolManager();
      try {
        const freshMatterRepo = new TenantMatterRepository({
          poolManager: freshPools,
        });
        return await freshMatterRepo.withTenantReadTransaction(
          adminCtx,
          async (tx) => {
            const res = await tx.query<{
              restricted_access_user_ids_json: string[];
            }>(
              'SELECT restricted_access_user_ids_json FROM public.matters WHERE tenant_id = $1 AND id = $2',
              [adminCtx.tenantId, staffMatter.id],
            );
            return res.rows[0]?.restricted_access_user_ids_json ?? [];
          },
        );
      } finally {
        await freshPools.closeAllPools();
      }
    };

    // Build two isolated replica module graphs
    vi.resetModules();
    const replicaAEntra = await import('@/server/entraAuth');
    const replicaA = await import('@/server/services');
    const { runWithActiveActorSession: runInReplicaA } = await import(
      '@/server/rbacRuntime'
    );

    vi.resetModules();
    const replicaBEntra = await import('@/server/entraAuth');
    const replicaB = await import('@/server/services');
    const { runWithActiveActorSession: runInReplicaB } = await import(
      '@/server/rbacRuntime'
    );

    const rebrandSession = (
      entraMod: typeof replicaAEntra,
      s: typeof adminSession,
    ) => ({
      ...s,
      verifiedSession: entraMod.verifySignedEntraSessionCookie(
        entraMod.createSignedEntraSessionCookie(s.verifiedSession),
      )!,
    });
    const adminSessionA = rebrandSession(replicaAEntra, adminSession);
    const userUSessionA = rebrandSession(replicaAEntra, userUSession);
    const adminSessionB = rebrandSession(replicaBEntra, adminSession);
    const userUSessionB = rebrandSession(replicaBEntra, userUSession);

    // Initial setup: grant user U 'managing_partner' so U is in restricted_access_user_ids_json
    const grantRes = await runInReplicaA(adminSessionA, () =>
      replicaA.updateEmployeeRolesAndSupports(
        userU,
        { roles: Array.from(new Set([...originalRoles, 'managing_partner'])) },
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(grantRes.ok).toBe(true);
    expect(await readRestrictedIdsOnFreshConnection()).toContain(userU);

    // Interleaving 1 (Read path):
    // 1. Replica A starts getAppSnapshot and loads people + matters while U is still permitted.
    // 2. Right after Replica A loads matters, Replica B removes U and commits.
    // 3. Replica A finishes getAppSnapshot, listAuditEntriesForRecord, listFirmAuditEntriesPage, and getKeyDateExceptionsReportRecord.
    const matterRepoA = replicaA.getMatterRepository();
    const origListAllMattersA =
      matterRepoA.listAllMattersUnfiltered.bind(matterRepoA);
    let bRemovedDuringARead = false;
    const spyReadInterleave = vi
      .spyOn(matterRepoA, 'listAllMattersUnfiltered')
      .mockImplementationOnce(async (ctx) => {
        const loadedMatters = await origListAllMattersA(ctx);
        // Confirm Replica A loaded inputs while U was still in restricted_access_user_ids_json in SQL
        expect(await readRestrictedIdsOnFreshConnection()).toContain(userU);

        // Step 2: Replica B removes U and commits while Replica A is mid-flight with stale inputs
        const removeRes = await runInReplicaB(adminSessionB, () =>
          replicaB.updateEmployeeRolesAndSupports(
            userU,
            { roles: originalRoles },
            positiveControlUserId,
            { mfaVerified: true },
          ),
        );
        expect(removeRes.ok).toBe(true);
        bRemovedDuringARead = true;
        return loadedMatters;
      });

    try {
      // Step 3: Replica A completes getAppSnapshot (which loaded stale people & matters before B committed)
      await runInReplicaA(adminSessionA, () =>
        replicaA.getAppSnapshot(positiveControlUserId),
      );
      expect(bRemovedDuringARead).toBe(true);

      // Run additional former read-path callers on Replica A
      await runInReplicaA(adminSessionA, () =>
        replicaA.listAuditEntriesForRecord(
          'matter',
          staffMatter.id,
          positiveControlUserId,
        ),
      );
      await runInReplicaA(adminSessionA, () =>
        replicaA.listFirmAuditEntriesPage(positiveControlUserId, { limit: 10 }),
      );
      await runInReplicaA(adminSessionA, () =>
        replicaA.getKeyDateExceptionsReportRecord({}, positiveControlUserId),
      );
    } finally {
      spyReadInterleave.mockRestore();
    }

    // Step 4: On a fresh connection, U is NOT in restricted_access_user_ids_json and cannot see the matter's key dates
    const afterReadIds = await readRestrictedIdsOnFreshConnection();
    expect(afterReadIds).toContain(positiveControlUserId);
    expect(afterReadIds).not.toContain(userU);
    expect(
      await keyDateRepo.listKeyDatesForMatter(userUCtx, staffMatter.id, userU),
    ).toHaveLength(0);
    const snapAfterReadU = await runInReplicaA(userUSessionA, () =>
      replicaA.getMatterKeyDatesSnapshot(staffMatter.id, userU),
    );
    expect(snapAfterReadU.keyDates).toHaveLength(0);
    const diaryAfterReadU = await runInReplicaB(userUSessionB, () =>
      replicaB.queryKeyDatesTeamDiaryRecord({}, userU),
    );
    expect(diaryAfterReadU.some((d) => d.keyDateId === testKeyDateId)).toBe(
      false,
    );
    expect(
      (
        await keyDateRepo.listKeyDatesForMatter(
          adminCtx,
          staffMatter.id,
          positiveControlUserId,
        )
      ).some((kd) => kd.id === testKeyDateId),
    ).toBe(true);

    // Interleaving 2 (Concurrent write path with pre-transaction reads):
    // Re-grant U, then have Replica A start savePersonRecord on an unrelated employee;
    // right after Replica A's pre-transaction listAllMattersUnfiltered resolves (with stale people & matters),
    // Replica B removes U and commits, and Replica A enters its write transaction.
    const regrantRes = await runInReplicaA(adminSessionA, () =>
      replicaA.updateEmployeeRolesAndSupports(
        userU,
        { roles: Array.from(new Set([...originalRoles, 'managing_partner'])) },
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(regrantRes.ok).toBe(true);
    expect(await readRestrictedIdsOnFreshConnection()).toContain(userU);

    let bRemovedDuringAWrite = false;
    const spyWriteInterleave = vi
      .spyOn(matterRepoA, 'listAllMattersUnfiltered')
      .mockImplementationOnce(async (ctx) => {
        const loadedMatters = await origListAllMattersA(ctx);
        const removeRes = await runInReplicaB(adminSessionB, () =>
          replicaB.updateEmployeeRolesAndSupports(
            userU,
            { roles: originalRoles },
            positiveControlUserId,
            { mfaVerified: true },
          ),
        );
        expect(removeRes.ok).toBe(true);
        bRemovedDuringAWrite = true;
        return loadedMatters;
      });

    try {
      const saveUnrelatedRes = await runInReplicaA(adminSessionA, () =>
        replicaA.savePersonRecord(
          {
            ...unrelatedEmployee,
            jobTitle: `${unrelatedEmployee.jobTitle || 'Solicitor'} (Updated)`,
          },
          { id: unrelatedEmployee.id, byId: positiveControlUserId },
        ),
      );
      expect(saveUnrelatedRes.person).not.toBeNull();
      expect(bRemovedDuringAWrite).toBe(true);
    } finally {
      spyWriteInterleave.mockRestore();
    }

    const afterWriteIds = await readRestrictedIdsOnFreshConnection();
    expect(afterWriteIds).toContain(positiveControlUserId);
    expect(afterWriteIds).not.toContain(userU);
    expect(
      await keyDateRepo.listKeyDatesForMatter(userUCtx, staffMatter.id, userU),
    ).toHaveLength(0);

    // Interleaving 3 (R479 — team-lead access removed while saveMatterRecord is in flight):
    // 1. Grant team-lead restricted matter access and make U a team lead so U is in restricted_access_user_ids_json.
    // 2. Replica A loads its pre-transaction inputs for saveMatterRecord.
    // 3. Replica B removes U's team-lead access via saveTeamRecord and commits.
    // 4. Replica A finishes saveMatterRecord.
    // 5. On a fresh connection, U is not in restricted_access_user_ids_json.
    const rbacTeamLeadPatch = {
      relationshipGrants: [
        {
          relationship: 'is_team_lead_of_any_team' as const,
          permissions: ['matter:restricted:access' as const],
        },
      ],
    };
    const rbacUpdateA = await runInReplicaA(adminSessionA, () =>
      replicaA.updateTenantRbacConfig(
        rbacTeamLeadPatch,
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );
    expect(rbacUpdateA.ok).toBe(true);
    await runInReplicaB(adminSessionB, () =>
      replicaB.updateTenantRbacConfig(
        rbacTeamLeadPatch,
        positiveControlUserId,
        { mfaVerified: true },
      ),
    );

    const targetTeam = loadCommittedSeedStore().teams.find((t) => t.id === userUTeamId)!;
    const originalTeamLeadIds = targetTeam.leadIds.filter((id) => id !== userU);
    const addTeamLeadRes = await runInReplicaA(adminSessionA, () =>
      replicaA.saveTeamRecord(
        {
          id: targetTeam.id,
          name: targetTeam.name,
          description: targetTeam.description,
          practiceAreaIds: targetTeam.practiceAreaIds,
          leadIds: Array.from(new Set([...originalTeamLeadIds, userU])),
          memberIds: Array.from(new Set([...targetTeam.memberIds, userU])),
          active: true,
        },
        positiveControlUserId,
      ),
    );
    expect(addTeamLeadRes.team).toBeDefined();
    expect(await readRestrictedIdsOnFreshConnection()).toContain(userU);

    const latestStaffMatterBeforeTeamRace = (
      await matterRepoA.getMatterById<import('@/domain/types').Matter>(
        adminCtx,
        staffMatter.id,
        {
          viewerUserId: positiveControlUserId,
          hasRestrictedMatterAccess: true,
        },
      )
    )!;
    expect(latestStaffMatterBeforeTeamRace).not.toBeNull();

    let bRemovedTeamLeadDuringAMatterSave = false;
    const spyTeamInterleave = vi
      .spyOn(matterRepoA, 'listAllMattersUnfiltered')
      .mockImplementationOnce(async (ctx) => {
        const loadedMatters = await origListAllMattersA(ctx);
        expect(await readRestrictedIdsOnFreshConnection()).toContain(userU);

        const removeTeamLeadRes = await runInReplicaB(adminSessionB, () =>
          replicaB.saveTeamRecord(
            {
              id: targetTeam.id,
              name: targetTeam.name,
              description: targetTeam.description,
              practiceAreaIds: targetTeam.practiceAreaIds,
              leadIds: originalTeamLeadIds,
              memberIds: targetTeam.memberIds,
              active: true,
            },
            positiveControlUserId,
          ),
        );
        expect(removeTeamLeadRes.team).toBeDefined();
        bRemovedTeamLeadDuringAMatterSave = true;
        return loadedMatters;
      });

    try {
      const saveMatterRes = await runInReplicaA(adminSessionA, () =>
        replicaA.saveMatterRecord(
          {
            ...latestStaffMatterBeforeTeamRace,
            title: `${latestStaffMatterBeforeTeamRace.title} (R479 Team Interleave)`,
          },
          {
            id: staffMatter.id,
            byId: positiveControlUserId,
            expectedRowVersion: latestStaffMatterBeforeTeamRace.rowVersion ?? 1,
          },
        ),
      );
      expect(saveMatterRes.errors).toBeUndefined();
      expect(saveMatterRes.matter).not.toBeNull();
      expect(bRemovedTeamLeadDuringAMatterSave).toBe(true);
    } finally {
      spyTeamInterleave.mockRestore();
    }

    const afterTeamInterleaveIds = await readRestrictedIdsOnFreshConnection();
    expect(afterTeamInterleaveIds).toContain(positiveControlUserId);
    expect(afterTeamInterleaveIds).not.toContain(userU);
    expect(
      await keyDateRepo.listKeyDatesForMatter(userUCtx, staffMatter.id, userU),
    ).toHaveLength(0);

    // R479 signature check: neither syncAffectedMattersRestrictionsInTx nor putMatterWithInTxRestrictions accepts `teams`
    const servicesSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/server/services.ts'),
      'utf8',
    );
    const syncSigMatch = servicesSource.match(
      /async function syncAffectedMattersRestrictionsInTx\([\s\S]*?\): Promise<void>/,
    );
    const putSigMatch = servicesSource.match(
      /async function putMatterWithInTxRestrictions\([\s\S]*?\): Promise<Matter>/,
    );
    expect(syncSigMatch).not.toBeNull();
    expect(putSigMatch).not.toBeNull();
    expect(syncSigMatch![0]).not.toMatch(/\bteams\b/);
    expect(putSigMatch![0]).not.toMatch(/\bteams\b/);
  });
});
