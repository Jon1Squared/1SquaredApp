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
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantRegisterRepository,
  TenantTaskWorkflowRepository,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  validateUserOverrideOrRoleMutation,
  type RegistersConfiguration,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  createRegisterRecordAction,
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
  createRegisterRecordService,
  executeRegisterRemindersForTenant,
  getAppSnapshot,
  resetAllDemoData,
  runScheduledRegisterRemindersJobSweep,
  transitionRegisterRecordService,
  updateEmployeeRoleSetting,
  updateEmployeeRolesAndSupports,
  updatePersonPermissionOverrides,
} from '@/server/services';
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
    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0020');
    expect(Object.keys(CORE_REGISTER_TYPES)).toEqual([
      'sign_off',
      'undertaking',
      'complaint',
      'breach',
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

  it('2. RBAC registry (68 user + 9 job-only = 77), undertaking:manage fee-earner-only separation & admin leak fixes', async () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(77);
    expect(ALL_USER_PERMISSION_KEYS).toHaveLength(68);
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toHaveLength(9);
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
        supportedCoreApiRange: '^1.0.0',
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
        supportedCoreApiRange: '^1.0.0',
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
        supportedCoreApiRange: '^1.0.0',
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
});
