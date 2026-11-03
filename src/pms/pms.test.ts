import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPmsDatabaseFromWorkbook, resolveWorkbookPath } from './importPms';
import { DemoDbPmsSource } from './pmsSource';
import { openXlsxWorkbook, parseMoney } from './xlsxReader';

describe('PMS Demo Database Import & Derived Views vs check_ sheets', () => {
  it('builds the SQLite database idempotently from 1Squared_PMS_Demo_Data.xlsx', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-test-'));
    const tmpDbPath = path.join(tmpDir, 'pms-demo.sqlite');
    try {
      const run1 = buildPmsDatabaseFromWorkbook({ dbPath: tmpDbPath });
      const run2 = buildPmsDatabaseFromWorkbook({ dbPath: tmpDbPath });
      expect(run1.asAtDate).toBe('2026-10-16');
      expect(run1.counts).toEqual({
        fee_earners: 8,
        clients: 10,
        matters: 20,
        fee_estimates: 23,
        time_entries: 740,
        disbursements: 16,
        invoices: 51,
        payments: 40,
        client_account: 15,
      });
      expect(run2.counts).toEqual(run1.counts);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reproduces every row and total of check_matters via v_matter_financials', () => {
    const wb = openXlsxWorkbook(resolveWorkbookPath());
    const checkMatrix = wb.getSheetMatrix('check_matters');
    const source = new DemoDbPmsSource();
    const matters = source.getAllMatterFinancials();
    const byCode = new Map(matters.map((m) => [m.matter_code, m]));

    // Rows 5..24 in check_matters are the 20 matters
    const matterRows = checkMatrix.filter((r) => r.rowNumber >= 5 && r.rowNumber <= 24);
    expect(matterRows.length).toBe(20);

    for (const row of matterRows) {
      const code = row.cells.A;
      const m = byCode.get(code);
      expect(m, `Missing matter ${code}`).toBeDefined();
      if (!m) continue;

      expect(m.client_code).toBe(row.cells.B);
      expect(m.work_type).toBe(row.cells.C);
      expect(m.billing_basis).toBe(row.cells.D);
      expect(m.fee_estimate).toBe(parseMoney(row.cells.E));
      expect(m.time_value_recorded).toBe(parseMoney(row.cells.F));
      expect(m.unbilled_wip).toBe(parseMoney(row.cells.G));
      expect(m.fees_billed).toBe(parseMoney(row.cells.H));
      expect(m.disbursements_billed).toBe(parseMoney(row.cells.I));
      expect(m.total_invoiced_inc_vat).toBe(parseMoney(row.cells.J));
      expect(m.total_paid).toBe(parseMoney(row.cells.K));
      expect(m.outstanding_debt).toBe(parseMoney(row.cells.L));
      expect(m.unbilled_disbursements).toBe(parseMoney(row.cells.M));
      expect(m.estimate_used_pct).toBeCloseTo(Number(row.cells.N), 6);
      expect(m.written_off).toBe(parseMoney(row.cells.O));
      expect(m.client_account_balance).toBe(parseMoney(row.cells.P));
    }

    // Check grand totals across all matters (Row 25 of check_matters)
    const totalWip = parseMoney(matters.reduce((s, m) => s + m.unbilled_wip, 0));
    const totalOutstanding = parseMoney(matters.reduce((s, m) => s + m.outstanding_debt, 0));
    const totalClientAccount = parseMoney(matters.reduce((s, m) => s + m.client_account_balance, 0));

    expect(totalWip).toBe(34140.0);
    expect(totalOutstanding).toBe(49130.22);
    expect(totalClientAccount).toBe(118454.2);

    // Acceptance criteria specific matter checks:
    const bri3 = byCode.get('BRI001-0003')!;
    expect(bri3.unbilled_wip).toBe(11057.0);
    expect(bri3.outstanding_debt).toBe(22637.4);
    expect(Math.round(bri3.estimate_used_pct * 100)).toBe(73);
    expect(bri3.fee_estimate).toBe(72000.0);
    expect(bri3.has_pending_estimate_revision).toBe(true);

    const sev1 = byCode.get('SEV001-0001')!;
    expect(sev1.time_value_recorded).toBe(27984.0);
    expect(sev1.fixed_fee_amount).toBe(25000.0);

    const pug1 = byCode.get('PUG001-0001')!;
    expect(pug1.client_account_balance).toBe(33510.6);
    const pugLedger = source.getClientAccountLedger('PUG001-0001');
    expect(pugLedger[pugLedger.length - 1]?.running_balance).toBe(33510.6);
  });

  it('reproduces every row of check_aged_debt (invoices and client buckets) via v_invoice_balances and v_client_financials', () => {
    const wb = openXlsxWorkbook(resolveWorkbookPath());
    const checkMatrix = wb.getSheetMatrix('check_aged_debt');
    const source = new DemoDbPmsSource();

    const agedInvoices = source.getAgedDebt();
    const invByNo = new Map(agedInvoices.map((i) => [i.invoice_number, i]));

    // Rows 6..55 in check_aged_debt are the 50 non-credit-note invoices
    const invoiceCheckRows = checkMatrix.filter((r) => r.rowNumber >= 6 && r.rowNumber <= 55);
    expect(invoiceCheckRows.length).toBe(50);

    for (const row of invoiceCheckRows) {
      const invNo = row.cells.A;
      const inv = invByNo.get(invNo);
      expect(inv, `Missing invoice ${invNo}`).toBeDefined();
      if (!inv) continue;

      expect(inv.client_code).toBe(row.cells.B);
      expect(inv.total).toBe(parseMoney(row.cells.D));
      expect(inv.paid).toBe(parseMoney(row.cells.E));
      expect(inv.credit_notes).toBe(parseMoney(row.cells.F));
      expect(inv.outstanding).toBe(parseMoney(row.cells.G));
      const expectedDays = row.cells.H !== undefined && row.cells.H !== '' ? Number(row.cells.H) : null;
      expect(inv.days_past_due).toBe(expectedDays);
      expect(inv.age_bucket).toBe(row.cells.I);
    }

    // PEN001-0003 final bill PV/2026/0033 shows as Paid after its credit note PV/2026/0034
    const penBills = source.getInvoices({ matterCode: 'PEN001-0003' });
    const finalBill = penBills.find((b) => b.invoice_number === 'PV/2026/0033')!;
    expect(finalBill.recalculated_status).toBe('Paid');
    expect(finalBill.outstanding).toBe(0);
    expect(finalBill.credit_notes).toBe(-540);

    // Rows 59..68 in check_aged_debt are the 10 clients
    const clients = source.getAllClientFinancials();
    const clientByCode = new Map(clients.map((c) => [c.client_code, c]));
    const clientCheckRows = checkMatrix.filter((r) => r.rowNumber >= 59 && r.rowNumber <= 68);
    expect(clientCheckRows.length).toBe(10);

    for (const row of clientCheckRows) {
      const code = row.cells.A;
      const cl = clientByCode.get(code);
      expect(cl, `Missing client ${code}`).toBeDefined();
      if (!cl) continue;

      expect(cl.aged_not_yet_due).toBe(parseMoney(row.cells.B));
      expect(cl.aged_1_30).toBe(parseMoney(row.cells.C));
      expect(cl.aged_31_60).toBe(parseMoney(row.cells.D));
      expect(cl.aged_61_90).toBe(parseMoney(row.cells.E));
      expect(cl.aged_90_plus).toBe(parseMoney(row.cells.F));
      expect(cl.outstanding_debt).toBe(parseMoney(row.cells.G));
    }

    // Bay Cafés Ltd specific check
    const bay = clientByCode.get('BAY001')!;
    expect(bay.aged_90_plus).toBe(3300.0);
    expect(bay.aged_1_30).toBe(1080.0);
  });

  it('reproduces every row of check_fee_earners via v_fee_earner_performance', () => {
    const wb = openXlsxWorkbook(resolveWorkbookPath());
    const checkMatrix = wb.getSheetMatrix('check_fee_earners');
    const source = new DemoDbPmsSource();
    const perf = source.getFeeEarnerPerformance();
    const perfById = new Map(perf.map((p) => [p.fee_earner_id, p]));

    const feRows = checkMatrix.filter((r) => r.rowNumber >= 5 && r.rowNumber <= 12);
    expect(feRows.length).toBe(8);

    for (const row of feRows) {
      const id = row.cells.A;
      const p = perfById.get(id);
      expect(p, `Missing fee earner ${id}`).toBeDefined();
      if (!p) continue;

      expect(p.name).toBe(row.cells.B);
      expect(p.chargeable_hours).toBeCloseTo(Number(row.cells.C), 2);
      expect(p.time_value).toBe(parseMoney(row.cells.D));
      expect(p.billed_value).toBe(parseMoney(row.cells.E));
      expect(p.written_off).toBe(parseMoney(row.cells.F));
      expect(p.annual_target_hours).toBe(Number(row.cells.G));
      expect(p.pct_of_annual_target).toBeCloseTo(Number(row.cells.H), 6);
    }
  });

  it('automatically links PMS clients and fee earners and preserves manual links', async () => {
    const { computeAutomaticPmsLinks } = await import('@/domain/pms');
    const { buildDemoData } = await import('@/seed/demo');
    const source = new DemoDbPmsSource();
    const demo = buildDemoData();

    const pmsClients = source.listClients();
    const pmsFeeEarners = source.listFeeEarners();
    const pmsMatters = source.listMatters();

    // Keep one manual link override on Severn Holdings plc (O-000005)
    const manualLink = {
      id: 'PMSL-MAN-1',
      entityType: 'organisation' as const,
      onesquaredId: 'O-000005',
      pmsCode: 'SEV001',
      matchedBy: 'manual' as const,
      matchedAt: '2026-10-16T09:00:00Z',
    };

    const merged = computeAutomaticPmsLinks(
      [manualLink],
      demo.organisations,
      demo.people,
      demo.matters,
      pmsClients,
      pmsFeeEarners,
      pmsMatters,
    );

    // Manual link is preserved
    const sevLink = merged.find((l) => l.onesquaredId === 'O-000005');
    expect(sevLink?.matchedBy).toBe('manual');
    expect(sevLink?.pmsCode).toBe('SEV001');

    // All 8 Corporate clients and 2 Individual clients are matched (10 total)
    const clientLinks = merged.filter(
      (l) => l.entityType === 'organisation' || l.entityType === 'person',
    );
    expect(clientLinks.length).toBe(10);

    // 5 of 8 fee earners match existing 1Squared employees (FE001, FE002, FE005, FE006, FE007);
    // FE003, FE004 (Megan Howells), and FE008 are PMS-only fee earners until created in 1Squared
    const feLinks = merged.filter((l) => l.entityType === 'employee');
    expect(feLinks.length).toBe(5);
    expect(feLinks.some((l) => l.pmsCode === 'FE004')).toBe(false);
  });

  it('computes Severn Holdings plc corporate group rollup across parent and two subsidiaries', async () => {
    const { getClientPmsViewBundle } = await import('@/server/services');
    const view = getClientPmsViewBundle('organisation', 'O-000005');
    expect(view.link?.pmsCode).toBe('SEV001');
    expect(view.groupView).not.toBeNull();
    const gv = view.groupView!;
    expect(gv.companies.length).toBe(3);
    expect(gv.companies.map((c) => c.pmsClientCode)).toEqual(['SEV001', 'SEV002', 'SEV003']);

    // Verify group totals equal sum of the 3 companies
    const sumWip = parseMoney(
      gv.companies.reduce((s, c) => s + (c.financials?.unbilled_wip ?? 0), 0),
    );
    const sumDebt = parseMoney(
      gv.companies.reduce((s, c) => s + (c.financials?.outstanding_debt ?? 0), 0),
    );
    expect(gv.totals.unbilled_wip).toBe(sumWip);
    expect(gv.totals.outstanding_debt).toBe(sumDebt);
  });

  it('surfaces PMS financial alerts on the home page attention list and hides them for call_handler', async () => {
    const { attentionList } = await import('@/domain/attention');
    const { getAppSnapshot } = await import('@/server/services');

    const snap = getAppSnapshot();
    const allRecords = [...snap.people, ...snap.organisations];
    const today = new Date('2026-10-16T10:00:00Z');

    const fullItems = attentionList(allRecords, snap.values, today, {
      tasks: snap.tasks,
      enquiries: snap.enquiries,
      teams: snap.teams,
      matters: snap.matters,
      pmsSummaryByMatterId: snap.pmsSummaryByMatterId,
      canViewFinance: true,
    });

    const pmsKinds = new Set(fullItems.map((i) => i.kind).filter((k) => k.startsWith('pms_')));
    expect(pmsKinds.has('pms_over_estimate')).toBe(true);
    expect(pmsKinds.has('pms_capped_fee_exceeded')).toBe(true);
    expect(pmsKinds.has('pms_overdue_bill_60')).toBe(true);
    expect(pmsKinds.has('pms_old_wip_30')).toBe(true);
    expect(pmsKinds.has('pms_pending_estimate_revision')).toBe(true);

    // Call handler role (canViewFinance = false) must not see any PMS financial alerts
    const callHandlerItems = attentionList(allRecords, snap.values, today, {
      tasks: snap.tasks,
      enquiries: snap.enquiries,
      teams: snap.teams,
      matters: snap.matters,
      pmsSummaryByMatterId: snap.pmsSummaryByMatterId,
      canViewFinance: false,
    });
    expect(callHandlerItems.some((i) => i.kind.startsWith('pms_'))).toBe(false);
  });

  it('builds two-way outbound PMS commands and reconciles inbound commercials respecting System-of-Record ownership', async () => {
    const {
      buildPmsOutboundMatterCommand,
      reconcilePmsInboundMatterCommercials,
    } = await import('@/domain/pms');
    const { getAppSnapshot } = await import('@/server/services');
    const { getActiveTenantConfiguration } = await import('@/platform/tenantRuntime');

    const snap = getAppSnapshot();
    const tenantConfig = getActiveTenantConfiguration();
    const mappings = tenantConfig.integrations.pmsSync?.fieldMappings ?? [];
    expect(mappings.length).toBeGreaterThan(0);

    const matter = snap.matters[0]!;
    const cmd = buildPmsOutboundMatterCommand({
      commandId: 'PMSO-000001',
      tenantId: tenantConfig.tenantId,
      correlationId: 'corr-sync-001',
      commandType: 'update_matter_commercials',
      matter: {
        ...matter,
        feeEstimateGbp: 18500,
        agreedFeeCapGbp: 20000,
        fieldValues: { ...matter.fieldValues, 'CORE-050': 'PO-9988' },
      },
      pmsLinks: snap.pmsLinks,
      fieldMappings: mappings,
      values: snap.values,
      createdById: 'P-000001',
    });

    expect(cmd.tenantId).toBe('not-a-law-firm');
    expect(cmd.mappedFields.matter_description).toBe(matter.title);
    expect(cmd.mappedFields.fee_estimate).toBe(18500);
    expect(cmd.mappedFields.fixed_fee_amount).toBe(20000);
    expect(cmd.mappedFields.client_reference).toBe('PO-9988');

    // Inbound reconciliation: bidirectional fee_estimate updates 1Squared, while onesquared_master title reports a discrepancy without overwriting
    const source = new DemoDbPmsSource();
    const pmsRow = source.getAllMatterFinancials()[0]!;
    const reconciled = reconcilePmsInboundMatterCommercials(
      {
        ...matter,
        title: '1Squared Master Title',
        feeEstimateGbp: 10000,
      },
      {
        ...pmsRow,
        matter_description: 'External PMS Different Title',
        fee_estimate: 24500,
      },
      mappings,
      snap.values,
    );

    expect(reconciled.updatedMatterFields.feeEstimateGbp).toBe(24500);
    expect(reconciled.updatedMatterFields.title).toBeUndefined();
    expect(
      reconciled.discrepancies.some(
        (d) =>
          d.onesquaredFieldKey === 'title' &&
          d.ownership === 'onesquared_master',
      ),
    ).toBe(true);
  });
});

