import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_JOB_ONLY_PERMISSION_KEYS,
  ALL_PERMISSION_KEYS,
  ALL_USER_PERMISSION_KEYS,
  CORE_API_VERSION,
  CORE_REGISTER_TYPES,
  CORE_REQUIRED_SCHEMA_VERSION,
  DEFAULT_RBAC_ROLES,
  ExtensionHost,
  PERMISSION_REGISTRY,
  REGISTER_DOMAIN_ERROR_CODES,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantJobRunRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantRegisterRepository,
  TenantTaskWorkflowRepository,
  loadAndValidateTenantConfig,
  resolveEffectiveRegisterTypes,
  resolveTenantFromVerifiedToken,
  validateRegisterCreateInput,
  validateRegisterTransitionExecution,
  validateUserOverrideOrRoleMutation,
  type RegistersConfiguration,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  createRegisterRecordAction,
  discussSignOffAction,
  getRegisterRecordDetailAction,
  listRegistersWorkspaceAction,
  saveRegistersConfigAction,
  transitionRegisterRecordAction,
  updateRegisterRecordAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { resolvePersonPermissions, resolvePersonPermissionSet } from '@/domain/rbac';
import { resolveEmployeePermissions } from '@/domain/employment';
import type { Matter, Person } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getPlatformExtensionHost,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { JOB_PERMISSIONS } from '@/server/actionPermissions';
import {
  approveSignOff,
  createRegisterRecordService,
  discussSignOff,
  executeRegisterRemindersForTenant,
  flagMatterWriteOff,
  getRegisterRecordDetailRecord,
  listRegistersWorkspaceDataRecord,
  resetAllDemoData,
  runScheduledRegisterRemindersJobSweep,
  saveRegistersConfigRecord,
  transitionRegisterRecordService,
  updateEmployeeRoleSetting,
  updateEmployeeRolesAndSupports,
  updatePersonPermissionOverrides,
  updateRegisterRecordDetailsService,
} from '@/server/services';
import { getAppSnapshot } from '@/server/__tests__/testAppSnapshot';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  auditEntriesSince,
  markAuditPosition,
  runAsTestActor,
  setAuditAdapterFailureHookForTesting,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

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
    correlationId: `corr-s024-${tenantId}-${actorId}`,
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

describe('S0-24: Configurable Registers Engine, Direct Undertakings, RBAC, Hooks & Reminders (ADR 0032)', () => {
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

  it('1. Migration 0017 version, SignOffKind narrowing, SO-000003 removal & seeded registerRecords contract', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(22);
    expect(Object.keys(CORE_REGISTER_TYPES)).toEqual([
      'sign_off',
      'undertaking',
      'complaint',
      'breach',
      'cdd',
      'high_risk_opening',
    ]);

    const undertakingDef = CORE_REGISTER_TYPES.undertaking;
    expect(undertakingDef.createPermission).toBe('undertaking:manage');
    expect(undertakingDef.editPermission).toBe('undertaking:manage');
    expect(undertakingDef.initialStatus).toBe('open');
    expect(undertakingDef.approvalRules).toBeNull();

    const committed = loadCommittedSeedStore();
    expect(committed.signOffs.map((s) => s.id)).toEqual(['SO-000001', 'SO-000002']);
    expect(committed.signOffs.some((s) => s.id === 'SO-000003')).toBe(false);
    expect(committed.signOffs.some((s) => (s.kind as string) === 'undertaking')).toBe(false);
    expect(committed.counters.SO).toBe(2);
    expect(committed.registerRecords?.some((r) => r.id === 'REG-000001' && r.registerTypeKey === 'undertaking')).toBe(
      true,
    );
    expect(committed.registerRecords?.some((r) => r.id === 'REG-000002' && r.registerTypeKey === 'complaint')).toBe(
      true,
    );
  });

  it('2. RBAC registry (71 user + 10 job-only = 81), undertaking:manage fee-earner-only separation & admin leak fixes', async () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(81);
    expect(ALL_USER_PERMISSION_KEYS).toHaveLength(71);
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toHaveLength(10);
    expect(PERMISSION_REGISTRY['register:configure'].requiresMfa).toBe(true);
    expect(PERMISSION_REGISTRY['register:run_reminders'].jobOnly).toBe(true);
    expect(JOB_PERMISSIONS['register-reminders'].permission).toBe('register:run_reminders');

    // undertaking:manage is explicitly excluded from admin and restricted to fee-earner roles
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.admin.permissions).toContain('register:view');
    expect(DEFAULT_RBAC_ROLES.admin.permissions).toContain('register:configure');
    expect(DEFAULT_RBAC_ROLES.fee_earner.permissions).toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.supervisor.permissions).toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.partner.permissions).toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.managing_partner.permissions).toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.risk_compliance.permissions).not.toContain('undertaking:manage');
    expect(DEFAULT_RBAC_ROLES.finance.permissions).not.toContain('undertaking:manage');

    const seed = createSeedStore();
    const baseEmp = seed.people.find((p) => p.id === 'P-000004')!;
    const pureAdmin: Person = {
      ...baseEmp,
      id: 'P-S024-PURE-ADMIN',
      firstName: 'Alan',
      surname: 'AdminOnly',
      employeeRoleId: 'employee_role.system_administrator',
      roles: ['admin'],
      appRole: 'admin',
      departmentId: 'DEPT-IT',
      emails: [
        {
          id: 'em-s024-admin',
          address: 'alan.adminonly@notalawfirm.example',
          isPrimary: true,
          typeId: null,
        },
      ],
    };
    const activeTenantCfg = getActiveTenantConfiguration();
    const pureAdminResolved = resolvePersonPermissionSet(pureAdmin, {
      tenantId: activeTenantCfg.tenantId,
      allPeople: [pureAdmin],
      teams: [],
      mfaVerified: true,
      config: activeTenantCfg,
    });
    expect(pureAdminResolved.permissions.has('register:configure')).toBe(true);
    expect(pureAdminResolved.permissions.has('rbac:manage_config')).toBe(true);
    expect(pureAdminResolved.permissions.has('rbac:manage_user_overrides')).toBe(true);
    expect(pureAdminResolved.permissions.has('undertaking:manage')).toBe(false);
    expect(pureAdminResolved.permissions.has('register:run_reminders')).toBe(false);

    // Host helper checks: no 'admin' -> ALL_USER_PERMISSION_KEYS bypass anywhere
    const pureAdminPermsList = resolvePersonPermissions(pureAdmin, {
      tenantId: activeTenantCfg.tenantId,
      allPeople: [pureAdmin],
      teams: [],
      mfaVerified: true,
      config: activeTenantCfg,
    });
    expect(pureAdminPermsList).not.toContain('undertaking:manage');
    const empPerms = resolveEmployeePermissions(pureAdmin, [pureAdmin], [], {
      tenantId: activeTenantCfg.tenantId,
      mfaVerified: true,
      config: activeTenantCfg,
    });
    expect(empPerms.length).toBeGreaterThan(0);

    // Direct unit check on validateUserOverrideOrRoleMutation
    const targetOther: Person = {
      ...seed.people.find((p) => p.id === 'P-000009')!,
      id: 'P-S024-TARGET',
      roles: ['finance'],
    };
    expect(() =>
      validateUserOverrideOrRoleMutation({
        targetPersonId: targetOther.id,
        actorPermissions: pureAdminResolved,
        addedPermissions: ['undertaking:manage'],
      }),
    ).toThrow(/PRIVILEGE_ESCALATION_FORBIDDEN|does not hold/);

    // Same MFA-verified admin holding BOTH rbac:manage_user_overrides + rbac:manage_config
    // IS permitted to assign the configured fee_earner role to ANOTHER user
    expect(() =>
      validateUserOverrideOrRoleMutation({
        targetPersonId: targetOther.id,
        actorPermissions: pureAdminResolved,
        addedPermissions: [],
        addedRoleKeys: ['fee_earner'],
      }),
    ).not.toThrow();

    // ...but NEVER self-modification
    expect(() =>
      validateUserOverrideOrRoleMutation({
        targetPersonId: pureAdmin.id,
        actorPermissions: pureAdminResolved,
        addedPermissions: [],
        addedRoleKeys: ['fee_earner'],
      }),
    ).toThrow(/own permissions|own roles|SELF_MODIFICATION/);

    // Persist pure admin into PostgreSQL and test service/action enforcement
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx(pureAdmin.id);
    const partyRepo = new TenantPartyRepository();
    await partyRepo.putPeople(ctx, [pureAdmin]);

    // Pure admin attempting to create an undertaking directly fails closed with FORBIDDEN
    const adminUndertakingAttempt = await runAsActionActor(
      pureAdmin.id,
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'undertaking',
          title: 'Admin blocked undertaking',
          matterId: 'M-000001',
          fieldValues: {
            recipientName: 'Example Lender PLC',
            undertakingTerms: 'Test terms',
            givenByPersonId: pureAdmin.id,
          },
        }),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(isActionDenied(adminUndertakingAttempt)).toBe(true);
    if (isActionDenied(adminUndertakingAttempt)) {
      expect(adminUndertakingAttempt.code).toBe('FORBIDDEN');
    }

    // Pure admin blocked from granting unheld direct undertaking:manage override to another user
    const directGrantDenied = await runAsActionActor(
      pureAdmin.id,
      () =>
        updatePersonPermissionOverrides(
          'P-000009',
          {
            grant: ['undertaking:manage'],
            revoke: [],
            reason: 'Escalation check',
          },
          pureAdmin.id,
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(directGrantDenied.ok).toBe(false);
    expect(directGrantDenied.code).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');

    // Pure admin blocked from updateEmployeeRoleSetting on self, and can assign 'fee_earner' role to another employee via RBAC services
    const selfRoleAttempt = await runAsActionActor(
      pureAdmin.id,
      () =>
        updateEmployeeRoleSetting(
          pureAdmin.id,
          'team_lead',
          pureAdmin.id,
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(selfRoleAttempt.ok).toBe(false);

    const assignFeeEarnerRes = await runAsActionActor(
      pureAdmin.id,
      () =>
        updateEmployeeRolesAndSupports(
          'P-000009',
          { roles: ['finance', 'fee_earner'] },
          pureAdmin.id,
          { mfaVerified: true },
        ),
      { roles: ['admin'], mfaVerified: true },
    );
    expect(assignFeeEarnerRes.ok).toBe(true);
  });

  it('3. Direct fee-earner undertaking creation without two-person approval, vary/discharge transitions & optimistic concurrency', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const auditPos = await markAuditPosition();

    // Finance user (P-000009, register:view only) can list registers but CANNOT create or vary undertakings
    const finList = await runAsActionActor(
      'P-000009',
      () => listRegistersWorkspaceAction(),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(finList.ok).toBe(true);
    const finCreateDenied = await runAsActionActor(
      'P-000009',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'undertaking',
          title: 'Finance forbidden undertaking',
          matterId: 'M-000001',
          fieldValues: {
            recipientName: 'Example Bank',
            undertakingTerms: 'Should fail',
          },
        }),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(isActionDenied(finCreateDenied)).toBe(true);

    // Fee earner P-000002 creates undertaking directly — opens immediately without partner approval!
    const createdRes = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'undertaking',
          title: 'Undertaking to deliver Land Registry charge release',
          matterId: 'M-000001',
          dueAt: '2026-12-15T17:00:00.000Z',
          fieldValues: {
            recipientName: 'Cymru Building Society',
            undertakingTerms: 'Deliver sealed release within 10 working days of completion.',
            givenByPersonId: 'P-000002',
            dischargeCriteria: 'Written acknowledgement from lender.',
          },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(createdRes.ok).toBe(true);
    if (!createdRes.ok) throw new Error('Expected undertaking creation to succeed');
    const uRec = createdRes.record;
    expect(uRec.registerTypeKey).toBe('undertaking');
    expect(uRec.reference).toMatch(/^UND-\d{6}$/);
    expect(uRec.status).toBe('open');
    expect(uRec.assignedApproverId).toBeNull();
    expect(uRec.decidedById).toBeNull();
    expect(uRec.decidedAt).toBeNull();
    expect(uRec.rowVersion).toBe(1);

    // Empty comment on vary (requiresComment: true) is rejected cleanly
    const varyMissingComment = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: uRec.id,
          transitionKey: 'vary',
          comment: '   ',
          expectedRowVersion: uRec.rowVersion,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(varyMissingComment.ok).toBe(false);
    if (!varyMissingComment.ok) {
      expect(varyMissingComment.code).toBe(REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR);
    }

    // Fee earner varies undertaking directly
    const varyRes = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: uRec.id,
          transitionKey: 'vary',
          comment: 'Extended window to 15 working days by mutual solicitor letter.',
          expectedRowVersion: 1,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(varyRes.ok).toBe(true);
    if (!varyRes.ok) throw new Error('Expected vary to succeed');
    expect(varyRes.record.status).toBe('varied');
    expect(varyRes.record.rowVersion).toBe(2);

    // Stale expectedRowVersion conflicts safely
    const staleRes = await runAsActionActor(
      'P-000002',
      () =>
        updateRegisterRecordAction({
          recordId: uRec.id,
          expectedRowVersion: 1,
          title: 'Stale write should conflict',
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(staleRes.ok).toBe(false);
    if (!staleRes.ok) {
      expect(staleRes.code).toBe(REGISTER_DOMAIN_ERROR_CODES.CONCURRENCY_CONFLICT);
    }

    // Fee earner discharges undertaking directly -> terminal state
    const dischargeRes = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordAction({
          recordId: uRec.id,
          transitionKey: 'discharge',
          comment: 'Written release received from lender.',
          expectedRowVersion: 2,
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(dischargeRes.ok).toBe(true);
    if (!dischargeRes.ok) throw new Error('Expected discharge to succeed');
    expect(dischargeRes.record.status).toBe('discharged');
    expect(dischargeRes.record.rowVersion).toBe(3);

    // Same-TX audit trail recorded create + transitions
    const audits = await auditEntriesSince(auditPos);
    const regAudits = audits
      .filter((a) => a.recordType === 'register_record' && a.recordId === uRec.id)
      .reverse();
    expect(regAudits.map((a) => a.action)).toEqual(['create', 'status-change', 'status-change']);
  });

  it('4. Sign-off consolidation on register_records, unconditional no-self-approval & assigned approver matching', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');

    // Existing SO-000001 and SO-000002 migrated cleanly and accessible via TaskWorkflowRepository & RegisterRepository
    const twRepo = new TenantTaskWorkflowRepository();
    const migratedSignOffs = await twRepo.listVisibleSignOffs(ctx, 'P-000001');
    expect(migratedSignOffs.map((s) => s.id)).toEqual(['SO-000001', 'SO-000002']);

    // Partner P-000001 creates a write-off sign-off record assigned to themselves -> MUST NOT allow self-approval
    const selfSignOffRes = await runAsActionActor(
      'P-000001',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'sign_off',
          title: 'Write-off request created by Partner 1',
          matterId: 'M-000001',
          assignedApproverId: 'P-000005',
          fieldValues: {
            signOffKind: 'write_off',
            subtitle: 'Write off £250 disbursements variance',
          },
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(selfSignOffRes.ok).toBe(true);
    if (!selfSignOffRes.ok) throw new Error('Expected sign_off creation to succeed');

    const selfApproveDenied = await runAsActionActor(
      'P-000001',
      () =>
        transitionRegisterRecordAction({
          recordId: selfSignOffRes.record.id,
          transitionKey: 'approve',
          comment: 'Trying self approval',
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(selfApproveDenied.ok).toBe(false);
    if (!selfApproveDenied.ok) {
      expect(selfApproveDenied.code).toBe(REGISTER_DOMAIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN);
    }

    // Partner P-000007 tries to approve a sign-off specifically assigned to P-000005 -> APPROVER_MISMATCH
    const wrongPartnerDenied = await runAsActionActor(
      'P-000007',
      () =>
        transitionRegisterRecordAction({
          recordId: selfSignOffRes.record.id,
          transitionKey: 'approve',
          comment: 'Wrong assigned partner',
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(wrongPartnerDenied.ok).toBe(false);
    if (!wrongPartnerDenied.ok) {
      expect(wrongPartnerDenied.code).toBe(REGISTER_DOMAIN_ERROR_CODES.APPROVER_MISMATCH);
    }

    // Assigned approver P-000005 succeeds
    const validApprove = await runAsActionActor(
      'P-000005',
      () =>
        transitionRegisterRecordAction({
          recordId: selfSignOffRes.record.id,
          transitionKey: 'approve',
          comment: 'Confirmed write-off variance after review.',
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(validApprove.ok).toBe(true);
    if (!validApprove.ok) throw new Error('Expected assigned partner approval to succeed');
    expect(validApprove.record.status).toBe('approved');
    expect(validApprove.record.decidedById).toBe('P-000005');
    expect(validApprove.record.decidedAt).toBeTruthy();
  });

  it('5. Custom tenant register definitions in tenant_module_configs["registers"] with MFA enforcement', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const customConfig: RegistersConfiguration = {
      defaultReminderHourLocal: 8,
      defaultDueDaysBefore: [14, 7, 1, 0],
      defaultReviewDaysBefore: [14, 7, 0],
      customTypes: [
        {
          key: 'dsar_request',
          label: 'Data Subject Access Request',
          pluralLabel: 'Data Subject Access Requests',
          description: 'UK GDPR Article 15 subject access requests.',
          isCore: false,
          enabled: true,
          referencePrefix: 'DSAR',
          initialStatus: 'received',
          createPermission: 'register:create',
          editPermission: 'register:edit',
          requireMatterLink: false,
          approvalRules: {
            requireTwoPersonApproval: true,
            forbidSelfApproval: true,
            allowedApproverRoles: ['risk_compliance', 'partner', 'managing_partner'],
            requireAssignedApproverMatch: false,
          },
          reminderSchedule: {
            enabled: true,
            dueDaysBefore: [14, 7, 1, 0],
            reviewDaysBefore: [7, 0],
            recipientMode: 'owner_and_approver',
          },
          states: [
            { key: 'received', label: 'Received', tone: 'info' },
            { key: 'completed', label: 'Completed', isTerminal: true, tone: 'success' },
          ],
          transitions: [
            {
              key: 'complete_dsar',
              label: 'Approve & issue response',
              fromStatuses: ['received'],
              toStatus: 'completed',
              requiredPermission: 'register:approve',
              requiresComment: true,
              forbidSelfAction: true,
              setsDecidedAt: true,
            },
          ],
          fields: [
            { key: 'requesterEmail', label: 'Requester email', type: 'text', required: true },
            { key: 'verifiedId', label: 'Identity verified', type: 'boolean', defaultValue: false },
          ],
        },
      ],
    };

    // Missing MFA fails closed
    const noMfaRes = await runAsActionActor(
      'P-000004',
      () => saveRegistersConfigAction(customConfig, 'Attempt without MFA'),
      { roles: ['admin'], mfaVerified: false },
    );
    expect(isActionDenied(noMfaRes)).toBe(true);
    if (isActionDenied(noMfaRes)) {
      expect(noMfaRes.code).toBe('MFA_REQUIRED');
    }

    // Missing register:configure fails closed even with MFA
    const feeEarnerDenied = await runAsActionActor(
      'P-000002',
      () => saveRegistersConfigAction(customConfig, 'Fee earner cannot configure'),
      { roles: ['fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(feeEarnerDenied)).toBe(true);
    if (isActionDenied(feeEarnerDenied)) {
      expect(feeEarnerDenied.code).toBe('FORBIDDEN');
    }

    // MFA-verified admin saves custom register definition
    const savedCfg = await runAsActionActor(
      'P-000004',
      () => saveRegistersConfigAction(customConfig, 'Enable UK GDPR DSAR register'),
      { roles: ['admin', 'fee_earner', 'partner'], mfaVerified: true },
    );
    expect(savedCfg.ok).toBe(true);
    if (!savedCfg.ok) throw new Error('Expected config save to succeed');
    expect(savedCfg.registerTypes.some((t) => t.key === 'dsar_request')).toBe(true);

    // Fee earner creates a custom DSAR record; Risk & Compliance approves & completes it
    const dsarCreate = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'dsar_request',
          title: 'Article 15 DSAR — Ms A. Client',
          dueAt: '2026-12-20T17:00:00.000Z',
          fieldValues: {
            requesterEmail: 'a.client@example.test',
            verifiedId: true,
          },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(dsarCreate.ok).toBe(true);
    if (!dsarCreate.ok) throw new Error('Expected custom register create to succeed');
    expect(dsarCreate.record.reference).toMatch(/^DSAR-\d{6}$/);
    expect(dsarCreate.record.status).toBe('received');

    const dsarComplete = await runAsActionActor(
      'P-000003',
      () =>
        transitionRegisterRecordAction({
          recordId: dsarCreate.record.id,
          transitionKey: 'complete_dsar',
          comment: 'Disclosure pack verified and dispatched.',
        }),
      { roles: ['risk_compliance', 'partner'], mfaVerified: true },
    );
    expect(dsarComplete.ok).toBe(true);
    if (!dsarComplete.ok) throw new Error('Expected custom DSAR transition to succeed');
    expect(dsarComplete.record.status).toBe('completed');
    expect(dsarComplete.record.decidedById).toBe('P-000003');
  });

  it('6. Extension hooks (beforeCreate, beforeTransition, afterTransition) run outside TX, fail closed vs post-commit isolation', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    const rawTenantCfg = loadAndValidateTenantConfig(rawBaseCfg, {}, 'test', 'multi_tenant');

    // (a) Direct host guard: ExtensionHost throws EXTENSION_TRANSACTION_FORBIDDEN if called inside an open TX
    const directHost = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    const regRepo = new TenantRegisterRepository();
    await regRepo.withTenantTransaction(ctx, async () => {
      await expect(
        directHost.executeRegisterBeforeCreateHook(ctx, rawTenantCfg, {
          tenantId: ctx.tenantId,
          actorId: 'P-000002',
          correlationId: ctx.correlationId,
          registerType: CORE_REGISTER_TYPES.undertaking,
          draft: {
            registerTypeKey: 'undertaking',
            title: 'Inside TX forbidden check',
            matterId: 'M-000001',
            enquiryId: null,
            personId: null,
            organisationId: null,
            ownerId: 'P-000002',
            assignedApproverId: null,
            dueAt: null,
            reviewAt: null,
            fieldValues: {
              recipientName: 'Example Bank',
              undertakingTerms: 'Test terms',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'EXTENSION_TRANSACTION_FORBIDDEN' });
    });

    // (b) Live service wiring on platform host: beforeCreate enriches fields OUTSIDE TX; beforeTransition vetoes BEFORE TX; afterTransition error stays isolated AFTER commit
    const extIdEnrich = `s024-enrich-ext-${Date.now()}`;
    const extIdVeto = `s024-veto-ext-${Date.now()}`;
    const extIdAfterFail = `s024-after-fail-ext-${Date.now()}`;

    setActiveTenantConfigForTesting({
      ...rawBaseCfg,
      enabledExtensions: [...(Array.isArray(rawBaseCfg.enabledExtensions) ? rawBaseCfg.enabledExtensions : []), extIdEnrich],
    });
    let afterTransitionCalledOutsideTx = false;
    getPlatformExtensionHost().registerExtension({
      manifest: {
        id: extIdEnrich,
        name: 'S0-24 Register Enrichment Test',
        version: '1.0.0',
        description: 'Enriches undertakings outside TX and runs isolated post-commit afterTransition',
        supportedCoreApiRange: '^2.0.0',
        permissions: ['register:read', 'register:write'],
        hooks: ['register.beforeCreate', 'register.beforeTransition', 'register.afterTransition'],
        hookTimeoutMs: 500,
      },
      hooks: {
        'register.beforeCreate': (_extCtx, input) => ({
          fieldValues: {
            ...input.draft.fieldValues,
            extensionComplianceRef: 'EXT-S024-OK',
          },
        }),
        'register.beforeTransition': (_extCtx, input) => ({
          fieldUpdates: {
            lastTransitionHookKey: input.transition.key,
          },
        }),
        'register.afterTransition': (_extCtx, input) => {
          afterTransitionCalledOutsideTx = input.updatedRecord.status === 'varied';
        },
      },
    });

    const enrichedCreate = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'Extension enriched undertaking',
            matterId: 'M-000001',
            fieldValues: {
              recipientName: 'Lloyds Banking Group',
              undertakingTerms: 'Deliver title deeds within 14 days.',
              givenByPersonId: 'P-000002',
            },
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(enrichedCreate.ok).toBe(true);
    if (!enrichedCreate.ok) throw new Error('Expected enriched create to succeed');
    expect(enrichedCreate.record.fieldValues.extensionComplianceRef).toBe('EXT-S024-OK');

    const variedWithHooks = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordService(
          {
            recordId: enrichedCreate.record.id,
            transitionKey: 'vary',
            comment: 'Varied with hooks active',
            expectedRowVersion: enrichedCreate.record.rowVersion,
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(variedWithHooks.ok).toBe(true);
    if (!variedWithHooks.ok) throw new Error('Expected transition with hooks to succeed');
    expect(variedWithHooks.record.fieldValues.lastTransitionHookKey).toBe('vary');
    expect(afterTransitionCalledOutsideTx).toBe(true);

    // (c) Timeout on beforeCreate fails closed BEFORE any DB write
    const preTimeoutCount = (await regRepo.listVisibleRegisterRecords(ctx, 'P-000002')).length;
    setActiveTenantConfigForTesting({
      ...rawBaseCfg,
      enabledExtensions: [...(Array.isArray(rawBaseCfg.enabledExtensions) ? rawBaseCfg.enabledExtensions : []), extIdVeto],
    });
    getPlatformExtensionHost().registerExtension({
      manifest: {
        id: extIdVeto,
        name: 'S0-24 Timeout Extension',
        version: '1.0.0',
        description: 'Times out in beforeCreate / throws in beforeTransition',
        supportedCoreApiRange: '^2.0.0',
        permissions: ['register:write'],
        hooks: ['register.beforeCreate', 'register.beforeTransition'],
        hookTimeoutMs: 40,
      },
      hooks: {
        'register.beforeCreate': async () => {
          await new Promise((r) => setTimeout(r, 120));
          return {};
        },
        'register.beforeTransition': () => {
          throw new Error('Blocked by extension beforeTransition');
        },
      },
    });

    const timeoutCreate = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'Should timeout in hook before write',
            matterId: 'M-000001',
            fieldValues: {
              recipientName: 'Timeout Bank',
              undertakingTerms: 'Must not persist',
              givenByPersonId: 'P-000002',
            },
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(timeoutCreate.ok).toBe(false);
    expect((await regRepo.listVisibleRegisterRecords(ctx, 'P-000002')).length).toBe(preTimeoutCount);

    const vetoTransition = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordService(
          {
            recordId: enrichedCreate.record.id,
            transitionKey: 'discharge',
            comment: 'Should veto before TX',
            expectedRowVersion: variedWithHooks.record.rowVersion,
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(vetoTransition.ok).toBe(false);
    const unchangedRec = await regRepo.getRegisterRecordById(ctx, enrichedCreate.record.id);
    expect(unchangedRec?.status).toBe('varied');
    expect(unchangedRec?.rowVersion).toBe(variedWithHooks.record.rowVersion);

    // (d) afterTransition throwing stays isolated and preserves committed DB transition
    setActiveTenantConfigForTesting({
      ...rawBaseCfg,
      enabledExtensions: [...(Array.isArray(rawBaseCfg.enabledExtensions) ? rawBaseCfg.enabledExtensions : []), extIdAfterFail],
    });
    getPlatformExtensionHost().registerExtension({
      manifest: {
        id: extIdAfterFail,
        name: 'S0-24 Failing AfterTransition Extension',
        version: '1.0.0',
        description: 'Throws in post-commit afterTransition',
        supportedCoreApiRange: '^2.0.0',
        permissions: ['register:read'],
        hooks: ['register.afterTransition'],
        hookTimeoutMs: 200,
      },
      hooks: {
        'register.afterTransition': () => {
          throw new Error('Downstream webhook unreachable');
        },
      },
    });

    const committedDespiteAfterErr = await runAsActionActor(
      'P-000002',
      () =>
        transitionRegisterRecordService(
          {
            recordId: enrichedCreate.record.id,
            transitionKey: 'discharge',
            comment: 'Must commit despite afterTransition failure',
            expectedRowVersion: variedWithHooks.record.rowVersion,
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(committedDespiteAfterErr.ok).toBe(true);
    if (!committedDespiteAfterErr.ok) throw new Error('Expected post-commit transition to succeed');
    expect(committedDespiteAfterErr.record.status).toBe('discharged');
    expect(committedDespiteAfterErr.isolatedHookErrors?.length).toBeGreaterThan(0);
  });

  it('7. Matter restriction & ethical-wall isolation + register-reminders job idempotency & recipient filtering', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000005');
    const matterRepo = new TenantMatterRepository();
    const matterBase = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001'))!;

    const dueTomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T17:00:00.000Z';

    // Staff restricted matter allowing ONLY P-000005 (not P-000002!)
    const staffMatter: Matter = {
      ...matterBase,
      id: 'M-S024-STAFF',
      matterNumber: 'STF001-0001',
      title: 'Staff Matter Private Dispute',
      isStaffMatter: true,
      hasEthicalWall: false,
      restrictedAccessUserIds: ['P-000005'],
      responsiblePartnerId: 'P-000005',
      supervisingPartnerId: 'P-000005',
      leadFeeEarnerId: 'P-000005',
      teamMemberIds: ['P-000005'],
    };
    // Ethical wall with empty allow-list & no participants (fails closed for all except oversight)
    const wallMatter: Matter = {
      ...matterBase,
      id: 'M-S024-WALL',
      matterNumber: 'WAL001-0001',
      title: 'Walled Corporate Acquisition',
      isStaffMatter: false,
      hasEthicalWall: true,
      restrictedAccessUserIds: [],
      responsiblePartnerId: null,
      supervisingPartnerId: null,
      leadFeeEarnerId: null,
      teamMemberIds: [],
    };
    await matterRepo.putMatter(ctx, staffMatter);
    await matterRepo.putMatter(ctx, wallMatter);

    const restrictedUndertaking = await runAsActionActor(
      'P-000005',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'undertaking',
          title: 'Secret Staff Matter Undertaking',
          matterId: staffMatter.id,
          dueAt: dueTomorrowIso,
          fieldValues: {
            recipientName: 'Confidential Counterparty',
            undertakingTerms: 'Hold documents in escrow',
            givenByPersonId: 'P-000005',
          },
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(restrictedUndertaking.ok).toBe(true);
    if (!restrictedUndertaking.ok) throw new Error('Expected staff matter undertaking to succeed');

    // Unpermitted P-000002 MUST NOT see restricted undertaking anywhere
    const p2List = await runAsActionActor(
      'P-000002',
      () => listRegistersWorkspaceAction(),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(p2List.ok).toBe(true);
    if (p2List.ok) {
      expect(p2List.records.some((r) => r.id === restrictedUndertaking.record.id)).toBe(false);
    }

    const p2Detail = await runAsActionActor(
      'P-000002',
      () => getRegisterRecordDetailAction(restrictedUndertaking.record.id),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(isActionDenied(p2Detail)).toBe(true);
    if (isActionDenied(p2Detail)) {
      expect(p2Detail.code).toBe('FORBIDDEN');
    }

    // Open undertaking due tomorrow owned by P-000002 (eligible for due reminder)
    const openUndertaking = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordAction({
          registerTypeKey: 'undertaking',
          title: 'Open Undertaking Due Tomorrow',
          matterId: 'M-000001',
          dueAt: dueTomorrowIso,
          fieldValues: {
            recipientName: 'Open Bank Ltd',
            undertakingTerms: 'Send title report tomorrow.',
            givenByPersonId: 'P-000002',
          },
        }),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(openUndertaking.ok).toBe(true);
    if (!openUndertaking.ok) throw new Error('Expected open undertaking creation to succeed');

    // Insert a record owned by P-000002 on the empty-allowlist ethical-wall matter directly in repo to prove reminder job filters out unauthorised recipients!
    const regRepo = new TenantRegisterRepository();
    const walledId = await regRepo.allocateNextRecordId(ctx, { idPrefix: 'REG' });
    const walledRef = await regRepo.allocateNextRecordId(ctx, { idPrefix: 'UND' });
    await regRepo.createRegisterRecord(ctx, {
      id: walledId,
      registerTypeKey: 'undertaking',
      reference: walledRef,
      title: 'Walled undertaking whose owner lacks access',
      status: 'open',
      matterId: wallMatter.id,
      ownerId: 'P-000002',
      dueAt: dueTomorrowIso,
      fieldValues: {
        recipientName: 'Walled Bank',
        undertakingTerms: 'Must not notify unauthorised owner',
        givenByPersonId: 'P-000002',
      },
      createdById: 'P-000005',
    });

    // Clear today's job_runs for clean scheduled test run
    await new TenantJobRunRepository().clearTenantJobRuns(ctx);

    const firstSweep = await executeRegisterRemindersForTenant(ctx, {
      triggerSource: 'scheduled',
      triggeredById: 'system:register-reminders',
      defaultRunHourLocal: 0,
    });
    expect(firstSweep.outcome).toBe('executed');
    if (firstSweep.outcome !== 'executed') throw new Error('Expected reminder job execution');
    expect(firstSweep.result.summary.remindersDispatched).toBeGreaterThanOrEqual(2);
    expect(firstSweep.result.summary.skippedRestrictedOrMissingRecipients).toBeGreaterThanOrEqual(1);

    const twRepo = new TenantTaskWorkflowRepository();
    const p2NotifsAfterFirst = await twRepo.listNotificationsForUser(ctx, 'P-000002');
    expect(
      p2NotifsAfterFirst.some(
        (n) =>
          n.kind === 'register_reminder' &&
          n.href?.includes(openUndertaking.record.id),
      ),
    ).toBe(true);
    // P-000002 MUST NOT receive any notification for the walled undertaking!
    expect(
      p2NotifsAfterFirst.some((n) => n.href?.includes(walledId)),
    ).toBe(false);

    // Second run via manual trigger verifies register_reminder_states DB deduplication (0 new dispatches!)
    const secondRun = await executeRegisterRemindersForTenant(ctx, {
      triggerSource: 'manual',
      triggeredById: 'system:register-reminders',
      defaultRunHourLocal: 0,
    });
    expect(secondRun.outcome).toBe('executed');
    if (secondRun.outcome !== 'executed') throw new Error('Expected manual reminder check');
    expect(secondRun.result.summary.remindersDispatched).toBe(0);
    expect(secondRun.result.summary.skippedAlreadyNotified).toBeGreaterThanOrEqual(2);

    // Run full multi-tenant scheduled sweep wrapper cleanly
    const sweepSummary = await runScheduledRegisterRemindersJobSweep({
      defaultRunHourLocal: 0,
    });
    expect(sweepSummary.exitCode).toBe(0);
  });

  it('8. Same-TX audit rollback atomicity & Model B two-tenant PostgreSQL isolation (P8: tampered IDs & forged TenantContext)', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const regRepo = new TenantRegisterRepository();
    const beforeCount = (await regRepo.listVisibleRegisterRecords(ctx, 'P-000002')).length;

    // Audit failure during create rolls back register_records insert completely
    setAuditAdapterFailureHookForTesting(() => {
      throw new Error('Simulated audit append failure during create');
    });
    const rollbackCreate = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'Must roll back on audit failure',
            matterId: 'M-000001',
            fieldValues: {
              recipientName: 'Rollback Bank',
              undertakingTerms: 'Must not commit without audit',
              givenByPersonId: 'P-000002',
            },
          },
          'P-000002',
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    setAuditAdapterFailureHookForTesting(null);
    expect(rollbackCreate.ok).toBe(false);
    expect((await regRepo.listVisibleRegisterRecords(ctx, 'P-000002')).length).toBe(beforeCount);

    // Two distinct PostgreSQL tenants (`s024-alpha` & `s024-bravo`)
    const tenantAlpha = 's024-alpha';
    const tenantBravo = 's024-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha, 'P-000004');
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo, 'P-000004');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    const alphaRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantAlpha,
      displayName: 'Alpha Solicitors LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const bravoRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantBravo,
      displayName: 'Bravo Law LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const alphaValidated = loadAndValidateTenantConfig(alphaRaw, {}, 'test', 'multi_tenant');
    const bravoValidated = loadAndValidateTenantConfig(bravoRaw, {}, 'test', 'multi_tenant');

    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaValidated,
      store: createSeedStore(),
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoValidated,
      store: createSeedStore(),
      clearFirst: true,
    });

    // Save custom config ONLY in Alpha via service
    setActiveTenantConfigForTesting(alphaRaw);
    const alphaCfgSave = await runAsActionActor(
      'P-000004',
      () =>
        saveRegistersConfigAction(
          {
            customTypes: [
              {
                key: 'alpha_deed',
                label: 'Alpha Title Deed',
                pluralLabel: 'Alpha Title Deeds',
                description: 'Alpha-only deed register',
                isCore: false,
                enabled: true,
                referencePrefix: 'DEED',
                initialStatus: 'held',
                createPermission: 'register:create',
                editPermission: 'register:edit',
                approvalRules: null,
                reminderSchedule: {
                  enabled: false,
                  dueDaysBefore: [],
                  reviewDaysBefore: [],
                  recipientMode: 'owner_only',
                },
                states: [{ key: 'held', label: 'Held', tone: 'info' }],
                transitions: [],
                fields: [{ key: 'deedPacketRef', label: 'Packet ref', type: 'text', required: true }],
              },
            ],
          },
          'Configure Alpha-only register',
        ),
      { tenantId: tenantAlpha, roles: ['admin', 'partner'], mfaVerified: true },
    );
    expect(alphaCfgSave.ok).toBe(true);

    // Create a unique Alpha undertaking directly in Alpha's PostgreSQL
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshRegRepo = new TenantRegisterRepository({ poolManager: freshPoolMgr });
    const freshCatRepo = new TenantCatalogueRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    const alphaRecId = await freshRegRepo.allocateNextRecordId(ctxAlpha, { idPrefix: 'REG' });
    const alphaRec = await freshRegRepo.createRegisterRecord(
      ctxAlpha,
      {
        id: alphaRecId,
        registerTypeKey: 'undertaking',
        reference: 'UND-ALPHA-001',
        title: 'Alpha Strictly Isolated Undertaking',
        status: 'open',
        matterId: 'M-000001',
        ownerId: 'P-000002',
        fieldValues: {
          recipientName: 'Alpha Escrow Bank',
          undertakingTerms: 'Hold Alpha completion deeds.',
          givenByPersonId: 'P-000002',
        },
        createdById: 'P-000002',
      },
      {
        auditEntries: [
          {
            recordType: 'register_record',
            recordId: alphaRecId,
            action: 'create',
            field: 'Status',
            oldValue: '',
            newValue: 'UND-ALPHA-001',
            byId: 'P-000002',
            at: new Date().toISOString(),
          },
        ],
      },
    );

    // 1. Bravo cannot read Alpha's custom config OR Alpha's record
    const bravoModCfg = await freshCatRepo.getModuleConfig<RegistersConfiguration>(ctxBravo, 'registers');
    expect(bravoModCfg).toBeNull();
    expect(await freshRegRepo.getRegisterRecordById(ctxBravo, alphaRec.id)).toBeNull();

    // 2. Tampered record ID from Alpha submitted against Bravo rejects with REGISTER_NOT_FOUND
    await expect(
      freshRegRepo.updateRegisterRecordDetails(ctxBravo, {
        recordId: alphaRec.id,
        title: 'Tampered cross-tenant edit',
        updatedById: 'P-000004',
      }),
    ).rejects.toMatchObject({ code: REGISTER_DOMAIN_ERROR_CODES.NOT_FOUND });

    await expect(
      freshRegRepo.lockAndExecuteTransition(ctxBravo, {
        recordId: alphaRec.id,
        transitionKey: 'discharge',
        actorId: 'P-000004',
        comment: 'Tampered cross-tenant transition',
        validateAndCompute: (locked) => ({
          nextStatus: 'discharged',
          setsDecidedAt: true,
          mergedFieldValues: locked.fieldValues,
        }),
      }),
    ).rejects.toMatchObject({ code: REGISTER_DOMAIN_ERROR_CODES.NOT_FOUND });

    // 3. Forged TenantContext (Alpha's claims/handle but swapped tenantId -> Bravo) fails closed
    const forgedCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: tenantBravo,
    }) as TenantContext;
    await expect(
      freshRegRepo.listVisibleRegisterRecords(forgedCtx, 'P-000002'),
    ).rejects.toThrow();

    // 4. Alpha's record & audit remain intact; Bravo's audit has zero entries for Alpha's ID
    const alphaStillThere = await freshRegRepo.getRegisterRecordById(ctxAlpha, alphaRec.id);
    expect(alphaStillThere?.title).toBe('Alpha Strictly Isolated Undertaking');
    const bravoAudits = await freshAuditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'register_record',
      alphaRec.id,
    );
    expect(bravoAudits).toHaveLength(0);

    // 5. Host getAppSnapshot cleanly includes live registerRecords & registerTypes
    setActiveTenantConfigForTesting(alphaRaw);
    await runAsActionActor(
      'P-000002',
      async () => {
        const snap = await getAppSnapshot('P-000002');
        expect(snap.registerTypes?.some((t) => t.key === 'undertaking')).toBe(true);
        expect(snap.registerRecords?.some((r) => r.registerTypeKey === 'undertaking')).toBe(true);
      },
      { tenantId: tenantAlpha, roles: ['fee_earner'], mfaVerified: false },
    );
  });

  it('R615: register services resolve verified tenant configuration via resolveVerifiedTenantConfiguration and reject cross-tenant context mismatches with TENANT_CONFIG_MISMATCH', async () => {
    const tenantAlpha = 's024-alpha';
    const tenantBravo = 's024-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha, 'P-000004');
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo, 'P-000004');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    const alphaRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantAlpha,
      displayName: 'Alpha Solicitors LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
    };
    const bravoRaw = {
      ...getActiveTenantRawBaseConfig(),
      tenantId: tenantBravo,
      displayName: 'Bravo Seal Law LLP',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
      registers: {
        defaultReminderHourLocal: 8,
        defaultDueDaysBefore: [14, 7, 1, 0],
        defaultReviewDaysBefore: [14, 7, 0],
        customTypes: [
          {
            key: 'bravo_seal',
            label: 'Bravo Corporate Seal',
            pluralLabel: 'Bravo Corporate Seals',
            description: 'Tenant-configured register loaded strictly from verified tenantConfig',
            isCore: false,
            enabled: true,
            referencePrefix: 'SEAL',
            initialStatus: 'held',
            createPermission: 'register:create' as const,
            editPermission: 'register:edit' as const,
            approvalRules: null,
            reminderSchedule: {
              enabled: false,
              dueDaysBefore: [],
              reviewDaysBefore: [],
              recipientMode: 'owner_only' as const,
            },
            states: [
              { key: 'held', label: 'Held', isTerminal: false, tone: 'info' as const },
              { key: 'returned', label: 'Returned', isTerminal: true, tone: 'success' as const },
            ],
            transitions: [
              {
                key: 'return_seal',
                label: 'Return seal',
                fromStatuses: ['held'],
                toStatus: 'returned',
                requiredPermission: 'register:edit' as const,
              },
            ],
            fields: [
              { key: 'sealNumber', label: 'Seal number', type: 'text' as const, required: true },
            ],
          },
        ],
        typeOverrides: {},
      },
    };
    const alphaValidated = loadAndValidateTenantConfig(alphaRaw, {}, 'test', 'multi_tenant');
    const bravoValidated = loadAndValidateTenantConfig(bravoRaw, {}, 'test', 'multi_tenant');

    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaValidated,
      store: createSeedStore(),
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoValidated,
      store: createSeedStore(),
      clearFirst: true,
    });

    // Keep process active config at not-a-law-firm; passing foreign ctxBravo without tenantConfig must fail closed with TENANT_CONFIG_MISMATCH across all 6 services
    await expect(
      listRegistersWorkspaceDataRecord({}, 'P-000004', { tenantCtx: ctxBravo }),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      getRegisterRecordDetailRecord('REG-000001', 'P-000004', { tenantCtx: ctxBravo }),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      createRegisterRecordService(
        { registerTypeKey: 'bravo_seal', title: 'Mismatch must reject', fieldValues: { sealNumber: 'S-1' } },
        'P-000004',
        { tenantCtx: ctxBravo },
      ),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      transitionRegisterRecordService(
        { recordId: 'REG-000001', transitionKey: 'return_seal' },
        'P-000004',
        { tenantCtx: ctxBravo },
      ),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      updateRegisterRecordDetailsService(
        { recordId: 'REG-000001', title: 'Updated' },
        'P-000004',
        { tenantCtx: ctxBravo },
      ),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);
    await expect(
      saveRegistersConfigRecord({ customTypes: [] }, 'Mismatch config save', 'P-000004', {
        mfaVerified: true,
        tenantCtx: ctxBravo,
      }),
    ).rejects.toThrow(/TENANT_CONFIG_MISMATCH/);

    // Supplying verified bravoValidated resolves Bravo's custom register config (no silent DEFAULT_REGISTERS_CONFIG fallback)
    const listedBravo = await listRegistersWorkspaceDataRecord({}, 'P-000004', {
      tenantCtx: ctxBravo,
      tenantConfig: bravoValidated,
    });
    expect(listedBravo.ok).toBe(true);
    if (!listedBravo.ok) throw new Error(`Expected Bravo list ok: ${listedBravo.message}`);
    expect(listedBravo.registerTypes.some((t) => t.key === 'bravo_seal')).toBe(true);

    const createdBravo = await createRegisterRecordService(
      {
        registerTypeKey: 'bravo_seal',
        title: 'Bravo Deed Seal #1',
        fieldValues: { sealNumber: 'SEAL-2026-01' },
      },
      'P-000004',
      { tenantCtx: ctxBravo, tenantConfig: bravoValidated },
    );
    expect(createdBravo.ok).toBe(true);
    if (!createdBravo.ok) throw new Error(`Expected Bravo create ok: ${createdBravo.message}`);

    const updatedBravo = await updateRegisterRecordDetailsService(
      {
        recordId: createdBravo.record.id,
        expectedRowVersion: createdBravo.record.rowVersion,
        title: 'Bravo Deed Seal #1 Updated',
        fieldValues: { sealNumber: 'SEAL-2026-02' },
      },
      'P-000004',
      { tenantCtx: ctxBravo, tenantConfig: bravoValidated },
    );
    expect(updatedBravo.ok).toBe(true);
    if (!updatedBravo.ok) throw new Error(`Expected Bravo update ok: ${updatedBravo.message}`);

    const transitionedBravo = await transitionRegisterRecordService(
      {
        recordId: createdBravo.record.id,
        transitionKey: 'return_seal',
        expectedRowVersion: updatedBravo.record.rowVersion,
      },
      'P-000004',
      { tenantCtx: ctxBravo, tenantConfig: bravoValidated },
    );
    expect(transitionedBravo.ok).toBe(true);
    if (!transitionedBravo.ok) throw new Error(`Expected Bravo transition ok: ${transitionedBravo.message}`);
    expect(transitionedBravo.record.status).toBe('returned');

    const detailBravo = await getRegisterRecordDetailRecord(createdBravo.record.id, 'P-000004', {
      tenantCtx: ctxBravo,
      tenantConfig: bravoValidated,
    });
    expect(detailBravo.ok).toBe(true);

    const savedCfgBravo = await saveRegistersConfigRecord(
      { typeOverrides: { undertaking: { enabled: true } } },
      'Verify verified tenantConfig in saveRegistersConfigRecord',
      'P-000004',
      { mfaVerified: true, tenantCtx: ctxBravo, tenantConfig: bravoValidated },
    );
    expect(savedCfgBravo.ok).toBe(true);

    // Two-tenant isolation: Alpha with its own config does not see Bravo's record or bravo_seal type
    const listedAlpha = await listRegistersWorkspaceDataRecord({}, 'P-000004', {
      tenantCtx: ctxAlpha,
      tenantConfig: alphaValidated,
    });
    expect(listedAlpha.ok).toBe(true);
    if (!listedAlpha.ok) throw new Error('Expected Alpha list ok');
    expect(listedAlpha.registerTypes.some((t) => t.key === 'bravo_seal')).toBe(false);
    expect(listedAlpha.records.some((r) => r.id === createdBravo.record.id)).toBe(false);
  });

  it('11 (R647): executeRegisterRemindersForTenant enqueues email and Teams outbox rows for Immediate recipients and skips None preferences', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000002');
    const rawBaseCfg = getActiveTenantRawBaseConfig();
    const reminderOverlay = {
      integrations: {
        email: {
          provider: 'dev_catcher' as const,
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@notalawfirm.example'],
          devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
        },
        teams: {
          provider: 'dev_catcher' as const,
          teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
          recipientAllowList: ['@notalawfirm.example'],
          devCatcher: { endpointUrl: 'http://127.0.0.1:1099/teams' },
        },
      },
    };
    const reminderCfg = loadAndValidateTenantConfig(rawBaseCfg, reminderOverlay);
    setActiveTenantConfigForTesting(rawBaseCfg, reminderOverlay);

    const partyRepo = new TenantPartyRepository();
    const outboxRepo = new TenantOutboxRepository();
    const twRepo = new TenantTaskWorkflowRepository();

    // Ensure both recipients have allow-listed emails and bound Entra object IDs
    const p2 = (await partyRepo.getPersonById<Person>(ctx, 'P-000002'))!;
    p2.emails = [
      {
        id: 'EM-R647-P2',
        typeId: 'email_type.work',
        address: 'dafydd.evans@notalawfirm.example',
        isPrimary: true,
        active: true,
      },
    ];
    p2.entraObjectId = 'oid-s024-p2';
    await partyRepo.putPerson(ctx, p2);

    const p5 = (await partyRepo.getPersonById<Person>(ctx, 'P-000005'))!;
    p5.emails = [
      {
        id: 'EM-R647-P5',
        typeId: 'email_type.work',
        address: 'elin.davies@notalawfirm.example',
        isPrimary: true,
        active: true,
      },
    ];
    p5.entraObjectId = 'oid-s024-p5';
    await partyRepo.putPerson(ctx, p5);

    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: 'P-000002',
      notificationKind: 'register_reminder',
      emailFrequency: 'immediate',
      teamsEnabled: true,
    });
    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: 'P-000005',
      notificationKind: 'register_reminder',
      emailFrequency: 'none',
      teamsEnabled: false,
    });

    const dueTomorrowIso =
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T17:00:00.000Z';

    const p2Und = await runAsActionActor(
      'P-000002',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'R647 Immediate Email & Teams Reminder',
            matterId: 'M-000001',
            dueAt: dueTomorrowIso,
            fieldValues: {
              recipientName: 'Immediate Recipient Bank',
              undertakingTerms: 'Confirm completion undertakings.',
              givenByPersonId: 'P-000002',
            },
          },
          'P-000002',
          { tenantConfig: reminderCfg },
        ),
      { roles: ['fee_earner'], mfaVerified: false },
    );
    expect(p2Und.ok).toBe(true);
    if (!p2Und.ok) throw new Error(p2Und.message);

    const p5Und = await runAsActionActor(
      'P-000005',
      () =>
        createRegisterRecordService(
          {
            registerTypeKey: 'undertaking',
            title: 'R647 Opt-Out Reminder',
            matterId: 'M-000001',
            dueAt: dueTomorrowIso,
            fieldValues: {
              recipientName: 'OptOut Recipient Bank',
              undertakingTerms: 'No outbox dispatch expected for P-000005.',
              givenByPersonId: 'P-000005',
            },
          },
          'P-000005',
          { tenantConfig: reminderCfg },
        ),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(p5Und.ok).toBe(true);
    if (!p5Und.ok) throw new Error(p5Und.message);

    await new TenantJobRunRepository().clearTenantJobRuns(ctx);
    const sweepRes = await executeRegisterRemindersForTenant(ctx, {
      triggerSource: 'scheduled',
      triggeredById: 'system:register-reminders',
      defaultRunHourLocal: 0,
      tenantConfig: reminderCfg,
    });
    expect(sweepRes.outcome).toBe('executed');

    const p2ReminderNotifs = (await twRepo.listNotificationsForUser(ctx, 'P-000002')).filter(
      (n) => n.kind === 'register_reminder' && n.recordId === p2Und.record.id,
    );
    expect(p2ReminderNotifs).toHaveLength(1);
    const p5ReminderNotifs = (await twRepo.listNotificationsForUser(ctx, 'P-000005')).filter(
      (n) => n.kind === 'register_reminder' && n.recordId === p5Und.record.id,
    );
    expect(p5ReminderNotifs).toHaveLength(1);

    const outboxStats = await outboxRepo.withTenantReadTransaction(ctx, async (tx) => {
      const eP2 = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.email_outbox WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, `notification:${ctx.tenantId}:${p2ReminderNotifs[0]!.id}`],
      );
      const tP2 = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.teams_activity_outbox WHERE tenant_id = $1 AND recipient_person_id = 'P-000002' AND deep_link_path LIKE $2`,
        [ctx.tenantId, `%${p2Und.record.id}%`],
      );
      const eP5 = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.email_outbox WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, `notification:${ctx.tenantId}:${p5ReminderNotifs[0]!.id}`],
      );
      const tP5 = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.teams_activity_outbox WHERE tenant_id = $1 AND recipient_person_id = 'P-000005' AND deep_link_path LIKE $2`,
        [ctx.tenantId, `%${p5Und.record.id}%`],
      );
      return {
        p2Emails: Number(eP2.rows[0]?.count ?? 0),
        p2Teams: Number(tP2.rows[0]?.count ?? 0),
        p5Emails: Number(eP5.rows[0]?.count ?? 0),
        p5Teams: Number(tP5.rows[0]?.count ?? 0),
      };
    });
    expect(outboxStats.p2Emails).toBe(1);
    expect(outboxStats.p2Teams).toBe(1);
    expect(outboxStats.p5Emails).toBe(0);
    expect(outboxStats.p5Teams).toBe(0);
  });

  it('12 (R648): approveSignOff and discussSignOff route through transitionRegisterRecordService, write register_transitions, increment row_version, invoke hooks, create follow-up task, and reject stale expectedRowVersion', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const regRepo = new TenantRegisterRepository();
    const twRepo = new TenantTaskWorkflowRepository();
    const rawBaseCfg = getActiveTenantRawBaseConfig();

    const hookExtId = `s024-r648-hook-${Date.now()}`;
    let beforeTransitionCount = 0;
    let afterTransitionCount = 0;
    setActiveTenantConfigForTesting({
      ...rawBaseCfg,
      enabledExtensions: [
        ...(Array.isArray(rawBaseCfg.enabledExtensions) ? rawBaseCfg.enabledExtensions : []),
        hookExtId,
      ],
    });
    getPlatformExtensionHost().registerExtension({
      manifest: {
        id: hookExtId,
        name: 'R648 SignOff Hook Observer',
        version: '1.0.0',
        description: 'Observes Home sign-off transitions routed through the Registers Engine',
        supportedCoreApiRange: '^2.0.0',
        permissions: ['register:read', 'register:write'],
        hooks: ['register.beforeTransition', 'register.afterTransition'],
        hookTimeoutMs: 500,
      },
      hooks: {
        'register.beforeTransition': () => {
          beforeTransitionCount += 1;
          return {};
        },
        'register.afterTransition': () => {
          afterTransitionCount += 1;
        },
      },
    });

    const beforeReg = (await regRepo.getRegisterRecordById(ctx, 'SO-000001', { includeRestricted: true }))!;
    expect(beforeReg.rowVersion).toBe(1);

    const discRes = await runAsActionActor(
      'P-000001',
      () => discussSignOffAction('SO-000001', 'Confirm client billing cap first'),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(discRes)).toBe(false);

    const afterDiscussReg = (await regRepo.getRegisterRecordById(ctx, 'SO-000001', { includeRestricted: true }))!;
    expect(afterDiscussReg.status).toBe('discussing');
    expect(afterDiscussReg.rowVersion).toBe(2);

    const transitionsAfterDiscuss = await regRepo.listTransitionsForRecord(ctx, 'SO-000001', {
      includeRestricted: true,
    });
    expect(
      transitionsAfterDiscuss.some(
        (t) =>
          t.transitionKey === 'discuss' &&
          t.fromStatus === 'pending_approval' &&
          t.toStatus === 'discussing',
      ),
    ).toBe(true);
    expect(beforeTransitionCount).toBeGreaterThanOrEqual(1);
    expect(afterTransitionCount).toBeGreaterThanOrEqual(1);

    // Same-TX follow-up task created for requester P-000002
    const allTasks = await twRepo.listAllTasksUnfiltered(ctx);
    expect(
      allTasks.some(
        (t) =>
          t.assignedPersonId === 'P-000002' &&
          t.title.includes('Discuss partner sign-off:'),
      ),
    ).toBe(true);

    // Stale expectedRowVersion=1 is refused when record is at rowVersion=2
    const staleApprove = await runAsActionActor(
      'P-000001',
      () => approveSignOff('SO-000001', 'P-000001', { expectedRowVersion: 1 }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(staleApprove)).toBe(true);

    const discussStale = await runAsActionActor(
      'P-000001',
      () =>
        discussSignOff('SO-000001', 'Stale discuss', 'P-000001', {
          expectedRowVersion: 1,
        }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(discussStale)).toBe(true);

    const currentApprove = await runAsActionActor(
      'P-000001',
      () => approveSignOff('SO-000001', 'P-000001', { expectedRowVersion: 2 }),
      { roles: ['partner', 'fee_earner'], mfaVerified: true },
    );
    expect(isActionDenied(currentApprove)).toBe(false);

    const afterApproveReg = (await regRepo.getRegisterRecordById(ctx, 'SO-000001', { includeRestricted: true }))!;
    expect(afterApproveReg.status).toBe('approved');
    expect(afterApproveReg.rowVersion).toBe(3);

    const transitionsAfterApprove = await regRepo.listTransitionsForRecord(ctx, 'SO-000001', {
      includeRestricted: true,
    });
    expect(
      transitionsAfterApprove.some(
        (t) =>
          t.transitionKey === 'approve' &&
          t.fromStatus === 'discussing' &&
          t.toStatus === 'approved',
      ),
    ).toBe(true);
  });

  it('13 (R649): flagMatterWriteOff creates sign-off through Registers Engine with audit entry and approval_requested notification', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000009');
    const regRepo = new TenantRegisterRepository();
    const twRepo = new TenantTaskWorkflowRepository();
    const auditPos = await markAuditPosition();

    const woRes = await runAsActionActor(
      'P-000009',
      () => flagMatterWriteOff('SEV001-0001', 1250, 'P-000009'),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(isActionDenied(woRes)).toBe(false);
    if (isActionDenied(woRes)) throw new Error(woRes.message);
    expect(woRes.signOffId).toMatch(/^SO-/);

    const regRec = await regRepo.getRegisterRecordById(ctx, woRes.signOffId!, {
      includeRestricted: true,
    });
    expect(regRec).not.toBeNull();
    expect(regRec?.registerTypeKey).toBe('sign_off');
    expect(regRec?.assignedApproverId).toBeTruthy();

    const transitions = await regRepo.listTransitionsForRecord(ctx, woRes.signOffId!, {
      includeRestricted: true,
    });
    expect(transitions.length).toBeGreaterThanOrEqual(1);

    const newAudits = await auditEntriesSince(auditPos);
    expect(
      newAudits.some((a) => a.action === 'create' && a.recordId === woRes.signOffId),
    ).toBe(true);

    const approverNotifs = await twRepo.listNotificationsForUser(
      ctx,
      regRec!.assignedApproverId!,
    );
    expect(
      approverNotifs.some(
        (n) => n.kind === 'approval_requested' && n.recordId === woRes.signOffId,
      ),
    ).toBe(true);
  });

  it('14 (R650): unifies SO- ID allocation across legacy & engine paths and rejects duplicate putSignOff writes with SIGN_OFF_ID_CONFLICT', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const twRepo = new TenantTaskWorkflowRepository();

    const [idLegacy1, idLegacy2, engRes1, engRes2] = await Promise.all([
      twRepo.allocateNextSignOffId(ctx),
      twRepo.allocateNextSignOffId(ctx),
      runAsActionActor(
        'P-000001',
        () =>
          createRegisterRecordService(
            {
              registerTypeKey: 'sign_off',
              title: 'R650 Concurrent Sign-Off A',
              matterId: 'M-000001',
              fieldValues: { signOffKind: 'write_off' },
            },
            'P-000001',
          ),
        { roles: ['partner', 'fee_earner'], mfaVerified: true },
      ),
      runAsActionActor(
        'P-000001',
        () =>
          createRegisterRecordService(
            {
              registerTypeKey: 'sign_off',
              title: 'R650 Concurrent Sign-Off B',
              matterId: 'M-000001',
              fieldValues: { signOffKind: 'write_off' },
            },
            'P-000001',
          ),
        { roles: ['partner', 'fee_earner'], mfaVerified: true },
      ),
    ]);
    expect(engRes1.ok).toBe(true);
    expect(engRes2.ok).toBe(true);
    if (!engRes1.ok || !engRes2.ok) throw new Error('Expected concurrent creations to succeed');

    const ids = [idLegacy1, idLegacy2, engRes1.record.id, engRes2.record.id];
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(id).toMatch(/^SO-\d{6}$/);
    }

    // Attempting putSignOff with an existing engine record ID must fail closed instead of overwriting
    await expect(
      twRepo.putSignOff(ctx, {
        id: engRes1.record.id,
        kind: 'write_off',
        title: 'Tampered Duplicate Overwrite',
        subtitle: 'Should fail on conflict',
        requestedById: 'P-000002',
        requestedAt: new Date().toISOString(),
        assignedPartnerId: 'P-000001',
        status: 'Pending',
      }),
    ).rejects.toMatchObject({ code: 'SIGN_OFF_ID_CONFLICT' });

    const unchanged = await new TenantRegisterRepository().getRegisterRecordById(
      ctx,
      engRes1.record.id,
      { includeRestricted: true },
    );
    expect(unchanged?.title).toBe('R650 Concurrent Sign-Off A');
  });

  it('15 (S1-04 Commit 1, R755): enforces cdd subjectScope=client, checklist/evidence field rules, non-terminal recorded state & REGISTER_RECORD_VISIBLE_SQL_PREDICATE empty-allow-list partner visibility', async () => {
    const cddType = CORE_REGISTER_TYPES.cdd;
    expect(cddType.subjectScope).toBe('client');
    expect(cddType.viewPermission).toBe('cdd:view');
    expect(cddType.createPermission).toBe('cdd:record');
    expect(cddType.states.find((s) => s.key === 'recorded')?.isTerminal).toBe(false);

    expect(() =>
      validateRegisterCreateInput({
        registerType: cddType,
        title: 'Bad dual client',
        matterId: null,
        personId: 'P-000013',
        organisationId: 'O-000001',
        dueAt: null,
        reviewAt: null,
        fieldValues: {
          clientCategory: 'individual',
          riskTier: 'standard',
          checklistItems: [],
        },
      }),
    ).toThrow(/requires exactly one of personId or organisationId/);

    expect(() =>
      validateRegisterCreateInput({
        registerType: cddType,
        title: 'Bad matter-linked CDD',
        matterId: 'M-000001',
        personId: 'P-000013',
        dueAt: null,
        reviewAt: null,
        fieldValues: {
          clientCategory: 'individual',
          riskTier: 'standard',
          checklistItems: [
            {
              itemKey: 'photo_id',
              label: 'Photo ID',
              required: true,
              status: 'recorded',
              recordedById: 'P-000002',
              recordedAt: new Date().toISOString(),
              evidenceRefs: [],
            },
          ],
        },
      }),
    ).toThrow(/cannot link directly to a matterId/);

    expect(() =>
      validateRegisterCreateInput({
        registerType: cddType,
        title: 'Missing note on N/A',
        matterId: null,
        personId: 'P-000013',
        dueAt: null,
        reviewAt: null,
        fieldValues: {
          clientCategory: 'individual',
          riskTier: 'standard',
          checklistItems: [
            {
              itemKey: 'photo_id',
              label: 'Photo ID',
              required: true,
              status: 'not_applicable',
              recordedById: 'P-000002',
              recordedAt: new Date().toISOString(),
              note: '   ',
              evidenceRefs: [],
            },
          ],
        },
      }),
    ).toThrow(/requires a note when marked "not_applicable"/);

    // R755: REGISTER_RECORD_VISIBLE_SQL_PREDICATE converged onto buildMatterHiddenFromViewerSql
    // lets a restricted matter's own partner (empty allow-list fallback) see linked register rows
    await resetAllDemoData('P-000004', testDataResetContext());
    const adminCtx = testTenantCtx('P-000004');
    const matterRepo = new TenantMatterRepository();
    const matter = await matterRepo.getMatterById(adminCtx, 'M-000001');
    expect(matter).toBeTruthy();
    if (!matter) throw new Error('Expected seeded M-000001');
    matter.isStaffMatter = true;
    matter.hasEthicalWall = false;
    matter.restrictedAccessUserIds = [];
    matter.responsiblePartnerId = 'P-000001';
    matter.leadFeeEarnerId = 'P-000002';
    matter.supervisingPartnerId = 'P-000001';
    matter.teamMemberIds = [];
    await matterRepo.putMatter(adminCtx, matter, { expectedRowVersion: null });

    const regRepo = new TenantRegisterRepository();
    const created = await regRepo.createRegisterRecord(adminCtx, {
      id: 'REG-009991',
      registerTypeKey: 'undertaking',
      reference: 'UND-009991',
      title: 'R755 Empty Allow-List Restricted Matter Undertaking',
      status: 'open',
      matterId: 'M-000001',
      fieldValues: {
        recipientName: 'Example Bank',
        undertakingTerms: 'Hold title deeds',
        givenByPersonId: 'P-000002',
      },
      createdById: 'P-000002',
    });

    const partnerVisible = await regRepo.listVisibleRegisterRecords(adminCtx, 'P-000001', {
      matterId: 'M-000001',
    });
    expect(partnerVisible.some((r) => r.id === created.id)).toBe(true);

    const outsiderVisible = await regRepo.listVisibleRegisterRecords(adminCtx, 'P-000009', {
      matterId: 'M-000001',
    });
    expect(outsiderVisible.some((r) => r.id === created.id)).toBe(false);
  });

  it('16 (S1-04 Suggestion 7 & 9): enforces core permission check on viaDedicatedWorkflow and refuses typeOverrides.cdd.additionalFields', () => {
    const cddType = CORE_REGISTER_TYPES.cdd;
    const sampleCddRecord = {
      id: 'REG-900001',
      tenantId: 'not-a-law-firm',
      registerTypeKey: 'cdd',
      reference: 'CDD-900001',
      title: 'Client CDD',
      status: 'in_progress',
      matterId: null,
      enquiryId: null,
      personId: 'P-000014',
      organisationId: null,
      ownerId: 'P-000002',
      assignedApproverId: null,
      decidedById: null,
      decidedAt: null,
      dueAt: null,
      reviewAt: null,
      reminderScheduleDays: null,
      fieldValues: {},
      rowVersion: 1,
      createdById: 'P-000002',
      createdAt: new Date().toISOString(),
      updatedById: 'P-000002',
      updatedAt: new Date().toISOString(),
    };

    // Suggestion 7: viaDedicatedWorkflow=true still enforces transition.requiredPermission in core
    expect(() =>
      validateRegisterTransitionExecution({
        registerType: cddType,
        record: sampleCddRecord,
        transitionKey: 'record_cdd',
        actorId: 'P-000004',
        actorRoles: ['admin'],
        actorPermissionSet: new Set(['register:edit', 'cdd:view']),
        comment: 'Complete CDD',
        viaDedicatedWorkflow: true,
      }),
    ).toThrow(/Missing permission "cdd:record"/);

    expect(() =>
      validateRegisterTransitionExecution({
        registerType: cddType,
        record: sampleCddRecord,
        transitionKey: 'record_cdd',
        actorId: 'P-000002',
        actorRoles: ['fee_earner'],
        actorPermissionSet: new Set(['cdd:view', 'cdd:record']),
        comment: 'Complete CDD',
        viaDedicatedWorkflow: true,
      }),
    ).not.toThrow();

    // Suggestion 9: core engine refuses extra firm-defined fields on cdd
    expect(() =>
      resolveEffectiveRegisterTypes({
        typeOverrides: {
          cdd: {
            additionalFields: [{ key: 'extraNote', label: 'Extra note', type: 'text' }],
          },
        },
      }),
    ).toThrow(/REGISTER_VALIDATION_ERROR/);
  });

  it('17 (S1-05 B1, ADR 0039/0040): enforces high_risk_opening core type, allowAdminBypass=false, distinct step-1/step-2 approvers, systemOnly withdraw_opening, core-lock & matter:opening_gate:override RBAC', async () => {
    const hroType = (
      CORE_REGISTER_TYPES as Record<string, import('../src/api/registers.types').RegisterTypeDefinition>
    ).high_risk_opening;
    expect(hroType).toBeDefined();
    expect(hroType.key).toBe('high_risk_opening');
    expect(hroType.referencePrefix).toBe('HRO');
    expect(hroType.subjectScope).toBe('matter');
    expect(hroType.requireMatterLink).toBe(true);
    expect(hroType.approvalRules?.allowAdminBypass).toBe(false);
    expect(hroType.states.find((s) => s.key === 'withdrawn')?.isTerminal).toBe(true);

    const errCodes = REGISTER_DOMAIN_ERROR_CODES as Record<string, string>;
    expect(errCodes.DISTINCT_APPROVER_REQUIRED).toBe('REGISTER_DISTINCT_APPROVER_REQUIRED');

    expect(PERMISSION_REGISTRY['matter:opening_gate:override']).toBeDefined();
    expect(DEFAULT_RBAC_ROLES.partner.permissions).toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.managing_partner.permissions).toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.risk_compliance.permissions).not.toContain('matter:opening_gate:override');
    expect(DEFAULT_RBAC_ROLES.fee_earner.permissions).not.toContain('matter:opening_gate:override');

    const { resolveEffectiveRegisterTypes, validateRegisterTransitionExecution } = await import(
      '../src/domain/registers/index'
    );
    expect(() =>
      resolveEffectiveRegisterTypes(undefined, {
        typeOverrides: {
          high_risk_opening: { enabled: false },
        },
      }),
    ).toThrow(/REGISTER_VALIDATION_ERROR/);

    // Verify allowAdminBypass=false + distinct step-1/step-2 approvers in lockAndExecuteTransition
    await resetAllDemoData('P-000004', testDataResetContext());
    const adminCtx = testTenantCtx('P-000004');
    const regRepo = new TenantRegisterRepository();
    const hroRec = await regRepo.createRegisterRecord(adminCtx, {
      id: 'REG-009995',
      registerTypeKey: 'high_risk_opening',
      reference: 'HRO-009995',
      title: 'High-risk opening test record',
      status: 'pending_partner',
      matterId: 'M-000001',
      fieldValues: { riskLevel: 'High' },
      createdById: 'P-000002',
    });

    // Pure admin (lacking partner/managing_partner role) must fail partner_approve despite holding register:approve
    expect(() =>
      validateRegisterTransitionExecution({
        registerType: hroType,
        record: hroRec,
        transitionKey: 'partner_approve',
        actorId: 'P-000099',
        actorRoles: ['admin'],
        actorPermissionSet: new Set(['register:view', 'register:approve']),
        comment: null,
      }),
    ).toThrow(/REGISTER_APPROVER_MISMATCH/);

    // Non-system actor cannot execute withdraw_opening directly
    expect(() =>
      validateRegisterTransitionExecution({
        registerType: hroType,
        record: hroRec,
        transitionKey: 'withdraw_opening',
        actorId: 'P-000003',
        actorRoles: ['risk_compliance'],
        actorPermissionSet: new Set(['register:view', 'register:edit', 'register:approve']),
        comment: null,
      }),
    ).toThrow(/REGISTER_SYSTEM_ONLY_TRANSITION/);

    // Dual-role partner + risk_compliance completes partner_approve
    const step1 = await regRepo.lockAndExecuteTransition(adminCtx, {
      recordId: hroRec.id,
      transitionKey: 'partner_approve',
      actorId: 'P-000001',
      comment: 'Partner approved stage 1',
      validateAndCompute: (locked) => {
        const res = validateRegisterTransitionExecution({
          registerType: hroType,
          record: locked,
          transitionKey: 'partner_approve',
          actorId: 'P-000001',
          actorRoles: ['partner', 'risk_compliance'],
          actorPermissionSet: new Set(['register:view', 'register:approve']),
          comment: 'Partner approved stage 1',
        });
        return {
          nextStatus: res.nextStatus,
          setsDecidedAt: Boolean(res.transition.setsDecidedAt),
          mergedFieldValues: locked.fieldValues,
        };
      },
    });
    expect(step1.updatedRecord.status).toBe('pending_compliance');

    // Same dual-role actor P-000001 must be rejected on compliance_approve (distinct approver)
    await expect(
      regRepo.lockAndExecuteTransition(adminCtx, {
        recordId: hroRec.id,
        transitionKey: 'compliance_approve',
        actorId: 'P-000001',
        comment: 'Same person attempting step 2',
        validateAndCompute: (locked, ...extraArgs: unknown[]) => {
          const priorTransitions = (extraArgs[0] ?? []) as Array<{
            transitionKey: string;
            actorId: string;
          }>;
          const res = validateRegisterTransitionExecution({
            registerType: hroType,
            record: locked,
            transitionKey: 'compliance_approve',
            actorId: 'P-000001',
            actorRoles: ['partner', 'risk_compliance'],
            actorPermissionSet: new Set(['register:view', 'register:approve']),
            comment: 'Same person attempting step 2',
            priorTransitions: priorTransitions as Parameters<
              typeof validateRegisterTransitionExecution
            >[0]['priorTransitions'],
          });
          return {
            nextStatus: res.nextStatus,
            setsDecidedAt: Boolean(res.transition.setsDecidedAt),
            mergedFieldValues: locked.fieldValues,
          };
        },
      }),
    ).rejects.toThrow(/REGISTER_DISTINCT_APPROVER_REQUIRED/);

    // Different risk_compliance user P-000003 succeeds
    const step2 = await regRepo.lockAndExecuteTransition(adminCtx, {
      recordId: hroRec.id,
      transitionKey: 'compliance_approve',
      actorId: 'P-000003',
      comment: 'MLRO approved stage 2',
      validateAndCompute: (locked, ...extraArgs: unknown[]) => {
        const priorTransitions = (extraArgs[0] ?? []) as Array<{
          transitionKey: string;
          actorId: string;
        }>;
        const res = validateRegisterTransitionExecution({
          registerType: hroType,
          record: locked,
          transitionKey: 'compliance_approve',
          actorId: 'P-000003',
          actorRoles: ['risk_compliance'],
          actorPermissionSet: new Set(['register:view', 'register:approve']),
          comment: 'MLRO approved stage 2',
          priorTransitions: priorTransitions as Parameters<
            typeof validateRegisterTransitionExecution
          >[0]['priorTransitions'],
        });
        return {
          nextStatus: res.nextStatus,
          setsDecidedAt: Boolean(res.transition.setsDecidedAt),
          mergedFieldValues: locked.fieldValues,
        };
      },
    });
    expect(step2.updatedRecord.status).toBe('approved');
  });

  it('17 (S1-05 R781 & Suggestion 8): enforces ADR 0039 §4 active approval-cycle boundary on distinct approver checks and refuses typeOverrides.high_risk_opening.enabled=false', () => {
    const hroType = CORE_REGISTER_TYPES.high_risk_opening;
    const sampleHro = {
      id: 'REG-CYCLE-1',
      tenantId: 'not-a-law-firm',
      registerTypeKey: 'high_risk_opening',
      reference: 'HRO-CYCLE-1',
      title: 'Cycle test',
      matterId: 'M-1',
      enquiryId: null,
      personId: null,
      organisationId: null,
      status: 'pending_compliance',
      rowVersion: 2,
      ownerId: 'P-000002',
      createdById: 'P-000002',
      assignedApproverId: null,
      dueAt: null,
      reviewAt: null,
      decidedById: null,
      decidedAt: null,
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:00:00.000Z',
      updatedById: 'P-000002',
      reminderScheduleDays: [],
      fieldValues: {},
    };

    // Prior cycle had P-000003 on partner_approve, followed by withdraw_opening + fresh partner_approve by P-000001 -> P-000003 CAN approve compliance_approve in the NEW cycle!
    const cycleRes = validateRegisterTransitionExecution({
      registerType: hroType,
      record: sampleHro,
      transitionKey: 'compliance_approve',
      actorId: 'P-000003',
      actorRoles: ['risk_compliance'],
      actorPermissionSet: new Set(['register:view', 'register:approve']),
      comment: 'New cycle MLRO sign-off',
      priorTransitions: [
        { transitionKey: 'partner_approve', actorId: 'P-000003' },
        { transitionKey: 'withdraw_opening', actorId: 'P-000002' },
        { transitionKey: 'partner_approve', actorId: 'P-000001' },
      ],
    });
    expect(cycleRes.nextStatus).toBe('approved');

    // Suggestion 8: disabling high_risk_opening in tenant registers config must be rejected
    const rawBase = getActiveTenantRawBaseConfig() as Record<string, unknown>;
    expect(() =>
      loadAndValidateTenantConfig(
        {
          ...rawBase,
          registers: {
            ...((rawBase.registers as Record<string, unknown> | undefined) ?? {}),
            typeOverrides: {
              high_risk_opening: { enabled: false },
            },
          },
        },
        {},
        'test',
      ),
    ).toThrow(/high_risk_opening/);
  });
});
