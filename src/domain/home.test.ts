import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canPreviewAnyHomeRole,
  createDefaultHomePagesConfig,
  createDefaultRoleConfigs,
  cyclePanelPlacement,
  getPanelPlacement,
  HEADLINE_CARD_DEFINITIONS,
  PANEL_DEFINITIONS,
  resolveEmployeeRoles,
  resolveHeaderDisplayedViewingRole,
  resolveViewingRoleOptions,
  setRolePanelPlacement,
  syncHomeRolesWithEmployeeRoles,
} from './homeConfig';
import { getLeftRailVisibility } from '../server/rbacRuntime';
import { isActionDenied } from './actionResult';
import { buildFeeEarnerWeeklyTime, buildFirmFinanceRollups } from './pms';
import { getPmsSource } from '@/pms/pmsSource';
import { primaryEmail } from './names';
import { switchUserAction } from '@/app/actions';
import { setTestEntraSessionOverride } from '@/server/entraAuth';
import {
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  addChoiceValue,
  addHomeRole,
  approveSignOff,
  discussSignOff,
  flagMatterWriteOff,
  getAppSnapshot,
  requestMatterBill,
  resetAllDemoData,
  resetHomePagesConfig,
  saveHomePagesConfig,
  switchViewingRole,
  updateEmployeeRolesAndSupports,
} from '@/server/services';

describe('Role-based Home pages & configuration', () => {
  beforeEach(() => {
    resetAllDemoData('P-000001');
  });

  afterAll(() => {
    resetAllDemoData('P-000001');
  });

  it('defines all 43 panels across 7 categories and 35 headline figure cards, including To Do', () => {
    expect(PANEL_DEFINITIONS.length).toBe(43);
    expect(PANEL_DEFINITIONS.some((p) => p.id === 'to_do')).toBe(true);
    expect(HEADLINE_CARD_DEFINITIONS.length).toBe(35);

    const roleConfigs = createDefaultRoleConfigs();
    expect(roleConfigs.map((r) => r.key)).toEqual([
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
      'admin',
    ]);

    const feeEarner = roleConfigs.find((r) => r.key === 'fee_earner')!;
    expect(feeEarner.primaryPanels).toContain('to_do');
    const partner = roleConfigs.find((r) => r.key === 'partner')!;
    expect(partner.summaryPanels).toContain('to_do');
  });

  it('seeds all 8 demo personas and underlying real employees with showsWorkOfId and supportsIds', () => {
    const snap = getAppSnapshot('P-000001');
    const demoUsers = snap.people.filter((p) => p.isEmployee && p.demo);
    expect(demoUsers.length).toBe(8);

    const demoEmails = demoUsers.map((d) => primaryEmail(d));
    expect(demoEmails).toContain('felicity.fee-earner@notalawfirm.example');
    expect(demoEmails).toContain('patrick.partner@notalawfirm.example');
    expect(demoEmails).toContain('simone.secretary@notalawfirm.example');
    expect(demoEmails).toContain('ethel.enquiries@notalawfirm.example');
    expect(demoEmails).toContain('frank.finance@notalawfirm.example');
    expect(demoEmails).toContain('rita.risk@notalawfirm.example');
    expect(demoEmails).toContain('martha.managing-partner@notalawfirm.example');
    expect(demoEmails).toContain('adam.admin@notalawfirm.example');

    // Felicity shows Dafydd Evans (P-000002)
    const felicity = demoUsers.find(
      (d) => primaryEmail(d) === 'felicity.fee-earner@notalawfirm.example',
    );
    expect(felicity?.showsWorkOfId).toBe('P-000002');
    expect(felicity?.roles).toEqual(['fee_earner']);

    // Martha Managing-Partner has both managing_partner and partner roles
    const martha = demoUsers.find(
      (d) => primaryEmail(d) === 'martha.managing-partner@notalawfirm.example',
    );
    expect(martha?.showsWorkOfId).toBeTruthy();
    expect(martha?.roles).toEqual(['managing_partner', 'partner']);

    // Adam Admin has all roles
    const adam = demoUsers.find(
      (d) => primaryEmail(d) === 'adam.admin@notalawfirm.example',
    );
    expect(adam?.showsWorkOfId).toBeNull();
    expect(adam?.roles).toContain('admin');
    expect(adam?.roles).toContain('fee_earner');
    expect(adam?.roles).toContain('managing_partner');

    // Simone Secretary supports Rhian Morgan (P-000001) and Dafydd Evans (P-000002)
    const simone = demoUsers.find(
      (d) => primaryEmail(d) === 'simone.secretary@notalawfirm.example',
    );
    expect(simone?.supportsIds).toContain('P-000001');
    expect(simone?.supportsIds).toContain('P-000002');
  });

  it('computes left-rail visibility accurately per role', () => {
    // Fee earner: no Finance, no Risk
    const feRail = getLeftRailVisibility('fee_earner', ['fee_earner']);
    expect(feRail.finance).toBe(false);
    expect(feRail.risk).toBe(false);
    expect(feRail.enquiries).toBe(true);
    expect(feRail.matters).toBe(true);

    // Partner: Finance visible, Risk hidden
    const ptRail = getLeftRailVisibility('partner', ['partner', 'fee_earner']);
    expect(ptRail.finance).toBe(true);
    expect(ptRail.risk).toBe(false);

    // Enquiries coordinator: Matters hidden, Finance/Risk hidden
    const ecRail = getLeftRailVisibility('enquiries_coordinator', ['enquiries_coordinator']);
    expect(ecRail.matters).toBe(false);
    expect(ecRail.enquiries).toBe(true);
    expect(ecRail.finance).toBe(false);
    expect(ecRail.risk).toBe(false);

    // Finance: Enquiries and Key Dates hidden, Finance visible
    const finRail = getLeftRailVisibility('finance', ['finance']);
    expect(finRail.enquiries).toBe(false);
    expect(finRail.keyDates).toBe(false);
    expect(finRail.finance).toBe(true);
    expect(finRail.risk).toBe(false);

    // R244: getAppSnapshot keeps leftRailVisibility.keyDates false when the Home role hides key dates
    // even if the employee (P-000009, Finance, team lead of Accounts) holds keydate:view via team-lead grant
    const financeSnapshot = getAppSnapshot('P-000009');
    expect(financeSnapshot.activeViewingRole).toBe('finance');
    expect(financeSnapshot.leftRailVisibility?.keyDates).toBe(false);

    const feeEarnerSnapshot = getAppSnapshot('P-000002');
    expect(feeEarnerSnapshot.activeViewingRole).toBe('fee_earner');
    expect(feeEarnerSnapshot.leftRailVisibility?.keyDates).toBe(true);

    // Risk & compliance: Risk visible, Finance hidden
    const riskRail = getLeftRailVisibility('risk_compliance', ['risk_compliance']);
    expect(riskRail.risk).toBe(true);
    expect(riskRail.finance).toBe(false);

    // Managing partner: Finance and Risk both visible
    const mpRail = getLeftRailVisibility('managing_partner', ['managing_partner', 'partner']);
    expect(mpRail.finance).toBe(true);
    expect(mpRail.risk).toBe(true);
  });

  it('remembers Viewing As selection per user and validates against user roles', () => {
    const snap1 = getAppSnapshot('P-000001'); // Rhian Morgan: ['partner', 'fee_earner']
    expect(snap1.activeViewingRole).toBe('partner');

    // Switch Rhian to 'fee_earner'
    const res = switchViewingRole('P-000001', 'fee_earner');
    expect(res.ok).toBe(true);

    const snap2 = getAppSnapshot('P-000001');
    expect(snap2.activeViewingRole).toBe('fee_earner');

    // Attempting to switch Rhian to a role she does not hold ('finance') is rejected
    const badSwitch = switchViewingRole('P-000001', 'finance');
    expect(badSwitch.ok).toBe(false);

    // Negative test (R215): a user with only ['fee_earner'] (P-000002) switching to 'finance' gets ok: false
    const feeEarnerSwitch = switchViewingRole('P-000002', 'finance');
    expect(feeEarnerSwitch.ok).toBe(false);

    // Positive test (R215): an administrator holding ['admin'] can preview any configured role via Viewing As
    const adamAdmin = snap1.people.find(
      (p) => primaryEmail(p) === 'adam.admin@notalawfirm.example',
    )!;
    updateEmployeeRolesAndSupports(
      'P-000004',
      { roles: ['admin'] },
      adamAdmin.id,
      { mfaVerified: true },
    );
    const adminSnap1 = getAppSnapshot('P-000004');
    expect(adminSnap1.currentUserRoles).toEqual(['admin']);
    expect(canPreviewAnyHomeRole(adminSnap1.currentUserRoles)).toBe(true);
    const adminSwitch = switchViewingRole('P-000004', 'finance');
    expect(adminSwitch.ok).toBe(true);
    const adminSnap2 = getAppSnapshot('P-000004');
    expect(adminSnap2.activeViewingRole).toBe('finance');

    // Negative test (R215): an undefined legacy key (not 'admin') does not grant role preview
    const undefinedLegacyKey = ['system', 'admin'].join('_');
    expect(canPreviewAnyHomeRole([undefinedLegacyKey])).toBe(false);
    updateEmployeeRolesAndSupports(
      'P-000002',
      { roles: [undefinedLegacyKey] },
      adamAdmin.id,
      { mfaVerified: true },
    );
    const invalidKeySwitch = switchViewingRole('P-000002', 'finance');
    expect(invalidKeySwitch.ok).toBe(false);
  });

  it('resolves Viewing As dropdown options and URL preview role in the header (R216)', () => {
    const configuredRoleKeys = createDefaultRoleConfigs().map((r) => r.key);

    // Non-admin on /matters sees only their own assigned roles
    expect(
      resolveViewingRoleOptions({
        currentUserRoles: ['partner'],
        configuredRoleKeys,
        pathname: '/matters',
      }),
    ).toEqual(['partner']);

    // Admin on /matters sees all configured roles
    expect(
      resolveViewingRoleOptions({
        currentUserRoles: ['admin'],
        configuredRoleKeys,
        pathname: '/matters',
      }),
    ).toEqual(configuredRoleKeys);

    // Header displayed role honours ?previewRole= and ?view= on '/' when valid
    expect(
      resolveHeaderDisplayedViewingRole({
        activeViewingRole: 'fee_earner',
        pathname: '/',
        previewRoleParam: 'finance',
        viewParam: null,
        configuredRoleKeys,
      }),
    ).toBe('finance');

    expect(
      resolveHeaderDisplayedViewingRole({
        activeViewingRole: 'fee_earner',
        pathname: '/',
        previewRoleParam: null,
        viewParam: 'risk_compliance',
        configuredRoleKeys,
      }),
    ).toBe('risk_compliance');

    // Unknown role keys are ignored
    expect(
      resolveHeaderDisplayedViewingRole({
        activeViewingRole: 'fee_earner',
        pathname: '/',
        previewRoleParam: 'not_a_real_role',
        viewParam: null,
        configuredRoleKeys,
      }),
    ).toBe('fee_earner');
  });

  it('does not expose signedSession from switchUserAction in Demo Mode (R228)', async () => {
    const rawBase = getActiveTenantRawBaseConfig();
    setActiveTenantConfigForTesting(
      {
        ...rawBase,
        featureFlags: {
          ...(rawBase.featureFlags as Record<string, unknown>),
          enableDemoMode: true,
        },
      },
      {},
    );
    setTestEntraSessionOverride({
      personId: 'P-000004',
      tenantId: 'not-a-law-firm',
      oid: '00000000-0000-4000-8000-000000000004',
      tid: '11111111-2222-4333-8444-555555555555',
      sub: 'P-000004',
      email: 'adam.admin@notalawfirm.example',
      displayName: 'Adam Admin',
      entraRoles: ['admin'],
      mappedRoles: ['admin'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    try {
      const snap = getAppSnapshot('P-000004');
      const felicity = snap.people.find(
        (p) => primaryEmail(p) === 'felicity.fee-earner@notalawfirm.example',
      )!;
      const res = await switchUserAction(felicity.id);
      expect(res).toEqual({ ok: true, personId: felicity.id });
      expect('signedSession' in res).toBe(false);
    } finally {
      setTestEntraSessionOverride(undefined);
      setActiveTenantConfigForTesting(null, undefined);
      resetAllDemoData('P-000001');
    }
  });

  it('cycles panel placements Primary -> Summary -> Off and persists Admin › Home pages changes and resets', () => {
    const defaults = createDefaultHomePagesConfig();
    const partnerRole = defaults.roles.find((r) => r.key === 'partner')!;

    // Initially 'aged_debt_by_age_band' is 'off' on partner
    expect(getPanelPlacement(partnerRole, 'aged_debt_by_age_band')).toBe('off');

    // Cycle Off -> Primary -> Summary -> Off
    expect(cyclePanelPlacement('off')).toBe('primary');
    expect(cyclePanelPlacement('primary')).toBe('summary');
    expect(cyclePanelPlacement('summary')).toBe('off');

    // Set 'aged_debt_by_age_band' to 'summary' for Partner and save
    const updatedPartner = setRolePanelPlacement(partnerRole, 'aged_debt_by_age_band', 'summary');
    expect(updatedPartner.summaryPanels).toContain('aged_debt_by_age_band');

    const adminUser = getAppSnapshot('P-000001').people.find(
      (p) => primaryEmail(p) === 'adam.admin@notalawfirm.example',
    )!;
    const updatedRoles = defaults.roles.map((r) => (r.key === 'partner' ? updatedPartner : r));
    const saveRes = saveHomePagesConfig(
      {
        roles: updatedRoles,
        firmSettings: { demoMode: true },
      },
      adminUser.id,
      { mfaVerified: true },
    );
    expect(saveRes.ok).toBe(true);

    const snapAfterSave = getAppSnapshot('P-000001');
    const savedPartner = snapAfterSave.homePagesConfig.roles.find((r) => r.key === 'partner')!;
    expect(savedPartner.summaryPanels).toContain('aged_debt_by_age_band');
    // demoMode comes strictly from schema-validated tenant configuration, never from user-writable store state
    expect(snapAfterSave.homePagesConfig.firmSettings.demoMode).toBe(false);

    // Reset to defaults removes 'aged_debt_by_age_band' from Partner summary
    const resetRes = resetHomePagesConfig(adminUser.id, { mfaVerified: true });
    expect(resetRes.ok).toBe(true);
    const snapAfterReset = getAppSnapshot('P-000001');
    const resetPartner = snapAfterReset.homePagesConfig.roles.find((r) => r.key === 'partner')!;
    expect(resetPartner.summaryPanels).not.toContain('aged_debt_by_age_band');
  });

  it('allows adding a custom role in Admin › Home pages and assigning roles/supports to employees', () => {
    const adminUser = getAppSnapshot('P-000001').people.find(
      (p) => primaryEmail(p) === 'adam.admin@notalawfirm.example',
    )!;
    const res = addHomeRole(
      {
        label: 'Business Development',
        shortLabel: 'Bus Dev',
        purpose: 'Enquiry pipeline, referral sources and key client relationships.',
        copyFromRoleKey: 'partner',
      },
      adminUser.id,
      { mfaVerified: true },
    );
    expect(res.ok).toBe(true);
    expect(res.role?.key).toBe('business_development');
    const empUpdate = updateEmployeeRolesAndSupports(
      'P-000002',
      { roles: ['fee_earner', 'business_development'] },
      adminUser.id,
      { mfaVerified: true },
    );
    expect(empUpdate.ok).toBe(true);

    const snap = getAppSnapshot('P-000002');
    const dafydd = snap.people.find((p) => p.id === 'P-000002')!;
    expect(resolveEmployeeRoles(dafydd, snap.teams)).toEqual([
      'fee_earner',
      'business_development',
    ]);
  });

  it('provides accurate PMS queries for Home pages matching check-sheet totals', () => {
    const pms = getPmsSource();
    const extractInfo = pms.getExtractInfo();
    const feeEarners = pms.listFeeEarners();
    const timeEntries = pms.listAllTimeEntries();
    const dafyddFe = feeEarners.find((fe) => fe.last_name === 'Evans')!;
    expect(dafyddFe).toBeDefined();

    // Check Dafydd Evans weekly time for 12-16 Oct 2026
    const feWeek = buildFeeEarnerWeeklyTime({
      feeEarner: dafyddFe,
      timeEntries,
      asAtDate: extractInfo.asAtDate,
    })!;
    expect(feWeek).not.toBeNull();
    expect(feWeek.feeEarnerId).toBe(dafyddFe.fee_earner_id);
    expect(feWeek.weekdays.length).toBe(5);
    expect(feWeek.weekTotalHours).toBeGreaterThan(0);

    const rollups = buildFirmFinanceRollups({
      asAtDate: extractInfo.asAtDate,
      matterFinancials: pms.getAllMatterFinancials(),
      invoices: pms.listAllInvoiceBalances(),
      timeEntries,
      payments: pms.listAllPayments(),
      clients: pms.listClients(),
      feeEarners,
    });

    // Check Monthly fees billed Jan-Oct 2026 (exact SQL parity)
    const monthly = rollups.pmsMonthlyFeesBilled;
    expect(monthly.months.length).toBe(10);
    expect(monthly.yearToDateTotal).toBe(181673.48);

    // Check Cash received summary (exact SQL parity)
    const cash = rollups.pmsCashReceived;
    expect(cash.currentMonthTotal).toBe(30878.42);
    expect(cash.currentMonthReceiptCount).toBe(6);
    expect(cash.previousMonthTotal).toBe(44586.44);
    expect(cash.previousMonthReceiptCount).toBe(7);

    // Check Department financials (exact SQL parity)
    const depts = rollups.pmsDepartmentFinancials;
    expect(depts.departments.length).toBe(6);
    expect(depts.firmTotal.billedThisYear).toBe(181673.48);
    expect(depts.firmTotal.unbilledWip).toBe(34140.0);
    expect(depts.firmTotal.outstandingDebt).toBe(49130.22);
    expect(depts.firmTotal.overdueDebt).toBe(8781.6);
    expect(depts.firmTotal.currentMonthHours).toBe(90.3);
  });

  it('supports inline Home actions: approve/discuss sign-offs and request bill / flag write-off', () => {
    const snapBefore = getAppSnapshot('P-000001');
    expect(snapBefore.signOffs.filter((s) => s.status === 'Pending').length).toBe(3);

    // Approve SO-000001
    const appRes = approveSignOff('SO-000001', 'P-000001');
    expect(appRes.ok).toBe(true);

    // Discuss SO-000002
    const discRes = discussSignOff('SO-000002', 'Please confirm cap ceiling first', 'P-000001');
    expect(discRes.ok).toBe(true);

    const snapAfter = getAppSnapshot('P-000001');
    expect(snapAfter.signOffs.find((s) => s.id === 'SO-000001')?.status).toBe('Approved');
    expect(snapAfter.signOffs.find((s) => s.id === 'SO-000002')?.status).toBe('Discussing');

    // Request bill on PEN001-0001 by partner (finance:credit_control) creates a Billing task
    const billRes = requestMatterBill('PEN001-0001', 'P-000001');
    expect(isActionDenied(billRes)).toBe(false);
    expect(billRes.ok).toBe(true);

    // Flag write-off on linked PMS matter SEV001-0001 by partner (finance:credit_control) creates a new SignOffItem, while unlinked TGL001-0002 is rejected (R337)
    const unlinkedWo = flagMatterWriteOff('TGL001-0002', 350, 'P-000001');
    expect(isActionDenied(unlinkedWo)).toBe(true);
    const woRes = flagMatterWriteOff('SEV001-0001', 2984, 'P-000001');
    expect(isActionDenied(woRes)).toBe(false);
    expect(woRes.ok).toBe(true);
    const snapFinal = getAppSnapshot('P-000001');
    expect(snapFinal.signOffs.some((s) => s.matterNumber === 'SEV001-0001')).toBe(true);
  });

  it('links configurable Home page roles to Employee Roles in the People taxonomy and removes test_role', () => {
    const snapBefore = getAppSnapshot('P-000001');
    const synced = syncHomeRolesWithEmployeeRoles(
      [
        ...snapBefore.homePagesConfig.roles,
        {
          key: 'test_role',
          label: 'Test Role',
          shortLabel: 'Test Role',
          purpose: 'Temporary test role',
          headlineCardIds: [],
          primaryPanels: [],
          summaryPanels: [],
        },
      ],
      snapBefore.values,
    );
    expect(synced.some((r) => r.key === 'test_role')).toBe(false);
    expect(synced.find((r) => r.key === 'fee_earner')?.employeeRoleId).toBe(
      'employee_role.fee_earner',
    );
    expect(synced.find((r) => r.key === 'partner')?.employeeRoleId).toBe(
      'employee_role.partner',
    );

    // Adding a new Employee Role in Taxonomy › People › Employee roles automatically creates a configurable Home role
    addChoiceValue(
      {
        listKey: 'employee_role',
        label: 'Costs Lawyer',
        description: 'Specialist costs draftsman and litigator',
      },
      'P-000001',
    );
    const snapAfter = getAppSnapshot('P-000001');
    const costsRole = snapAfter.homePagesConfig.roles.find(
      (r) => r.employeeRoleId === 'employee_role.costs_lawyer',
    );
    expect(costsRole).toBeDefined();
    expect(costsRole?.label).toBe('Costs Lawyer');
  });
});
