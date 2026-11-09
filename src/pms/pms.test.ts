import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildPmsDatabaseFromWorkbook, resolveWorkbookPath } from './importPms';
import * as pmsSourceModule from './pmsSource';
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

  it('reproduces every row of check_aged_debt (invoices and client buckets) via v_invoice_balances and domain rollups', async () => {
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
    const { buildFirmFinanceRollups } = await import('@/domain/pms');
    const rollups = buildFirmFinanceRollups({
      asAtDate: source.getExtractInfo().asAtDate,
      matterFinancials: source.getAllMatterFinancials(),
      invoices: source.listAllInvoiceBalances(),
      timeEntries: source.listAllTimeEntries(),
      payments: source.listAllPayments(),
      clients: source.listClients(),
      feeEarners: source.listFeeEarners(),
    });
    expect(rollups.pmsMonthlyFeesBilled.yearToDateTotal).toBe(181673.48);
    expect(rollups.pmsCashReceived).toEqual({
      currentMonthTotal: 30878.42,
      currentMonthReceiptCount: 6,
      previousMonthTotal: 44586.44,
      previousMonthReceiptCount: 7,
    });
    expect(rollups.pmsDepartmentFinancials.firmTotal.billedThisYear).toBe(181673.48);
    expect(rollups.pmsDepartmentFinancials.firmTotal.unbilledWip).toBe(34140.0);
    expect(rollups.pmsDepartmentFinancials.firmTotal.outstandingDebt).toBe(49130.22);
    expect(rollups.pmsDepartmentFinancials.firmTotal.overdueDebt).toBe(8781.6);
    expect(rollups.pmsDepartmentFinancials.firmTotal.currentMonthHours).toBe(90.3);

    const clients = rollups.allClientFins;
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

  it('reproduces every row of check_fee_earners via domain rollups and derives November buckets when asAtDate is 2026-11-09', async () => {
    const { buildFeeEarnerWeeklyTime, buildFirmFinanceRollups } = await import('@/domain/pms');
    const wb = openXlsxWorkbook(resolveWorkbookPath());
    const checkMatrix = wb.getSheetMatrix('check_fee_earners');
    const source = new DemoDbPmsSource();
    const rollups = buildFirmFinanceRollups({
      asAtDate: source.getExtractInfo().asAtDate,
      matterFinancials: source.getAllMatterFinancials(),
      invoices: source.listAllInvoiceBalances(),
      timeEntries: source.listAllTimeEntries(),
      payments: source.listAllPayments(),
      clients: source.listClients(),
      feeEarners: source.listFeeEarners(),
    });
    const perf = rollups.allFeeEarnerPerformance;
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

    // R319: with a PMS as-at of 2026-11-09, the November buckets are filled and labelled "Nov"
    const baseInvoices = source.listAllInvoiceBalances();
    const baseTimeEntries = source.listAllTimeEntries();
    const basePayments = source.listAllPayments();
    const novInvoice = {
      ...baseInvoices[0]!,
      invoice_number: 'PV/2026/0099',
      matter_code: 'PEN001-0001',
      client_code: 'PEN001',
      invoice_date: '2026-11-05',
      due_date: '2026-12-05',
      invoice_type: 'Interim',
      fees_net: 2500,
      exported_status: 'Posted',
    };
    const novPayment = {
      ...basePayments[0]!,
      receipt_id: 'R00099',
      invoice_number: 'PV/2026/0099',
      matter_code: 'PEN001-0001',
      client_code: 'PEN001',
      receipt_date: '2026-11-07',
      amount: 3000,
    };
    const novTimeEntry = {
      ...baseTimeEntries[0]!,
      time_id: 'T000999',
      matter_code: 'PEN001-0001',
      fee_earner_id: 'FE005',
      date: '2026-11-09',
      hours: 3.5,
      value: 752.5,
      chargeable: 'Y' as const,
      billed_status: 'Unbilled' as const,
    };
    const novRollups = buildFirmFinanceRollups({
      asAtDate: '2026-11-09',
      matterFinancials: source.getAllMatterFinancials(),
      invoices: [...baseInvoices, novInvoice],
      timeEntries: [...baseTimeEntries, novTimeEntry],
      payments: [...basePayments, novPayment],
      clients: source.listClients(),
      feeEarners: source.listFeeEarners(),
    });
    expect(novRollups.pmsMonthlyFeesBilled.months.length).toBe(11);
    const novBucket = novRollups.pmsMonthlyFeesBilled.months[10]!;
    expect(novBucket.monthKey).toBe('2026-11');
    expect(novBucket.monthShort).toBe('Nov');
    expect(novBucket.feesNet).toBe(2500);
    expect(novRollups.pmsMonthlyFeesBilled.yearToDateTotal).toBe(184173.48);
    expect(novRollups.pmsCashReceived).toEqual({
      currentMonthTotal: 3000,
      currentMonthReceiptCount: 1,
      previousMonthTotal: 30878.42,
      previousMonthReceiptCount: 6,
    });
    expect(novRollups.pmsDepartmentFinancials.firmTotal.currentMonthHours).toBe(3.5);

    const novWeek = buildFeeEarnerWeeklyTime({
      feeEarner: { fee_earner_id: 'FE005', annual_target_hours: 0 },
      timeEntries: [...baseTimeEntries, novTimeEntry],
      asAtDate: '2026-11-09',
    })!;
    expect(novWeek.weekdays.map((d) => d.date)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    expect(novWeek.weekTotalHours).toBe(3.5);
    expect(novWeek.monthToDateHours).toBe(3.5);
    expect(novWeek.dailyPaceHours).toBe(0);
    expect(novWeek.weeklyPaceHours).toBe(0);

    // R339 & R358: Adding a 2025 invoice and a 2025 time entry does not change current-year (2026) billedThisYear, yearToDateTotal, chargeable_hours, pct_of_annual_target, time_value, billed_value, written_off, or client fees_billed
    const inv2025 = {
      ...baseInvoices[0]!,
      invoice_number: 'PV/2025/0999',
      matter_code: 'PEN001-0001',
      client_code: 'PEN001',
      invoice_date: '2025-10-12',
      due_date: '2025-11-12',
      invoice_type: 'Interim',
      fees_net: 9000,
      total: 10800,
      paid: 10800,
      outstanding: 0,
      exported_status: 'Posted',
    };
    const te2025 = {
      ...baseTimeEntries[0]!,
      time_id: 'T2025999',
      matter_code: 'PEN001-0001',
      fee_earner_id: 'FE005',
      date: '2025-10-12',
      hours: 12.0,
      value: 2580,
      chargeable: 'Y' as const,
      billed_status: 'Billed' as const,
      billed_value: 2580,
      write_off_value: 350,
    };
    const withPriorYear = buildFirmFinanceRollups({
      asAtDate: source.getExtractInfo().asAtDate,
      matterFinancials: source.getAllMatterFinancials(),
      invoices: [...baseInvoices, inv2025],
      timeEntries: [...baseTimeEntries, te2025],
      payments: basePayments,
      clients: source.listClients(),
      feeEarners: source.listFeeEarners(),
    });
    expect(withPriorYear.pmsMonthlyFeesBilled.yearToDateTotal).toBe(181673.48);
    expect(withPriorYear.pmsDepartmentFinancials.firmTotal.billedThisYear).toBe(181673.48);
    const fe005Baseline = perfById.get('FE005')!;
    const fe005WithPriorYear = withPriorYear.allFeeEarnerPerformance.find(
      (p) => p.fee_earner_id === 'FE005',
    )!;
    expect(fe005WithPriorYear.chargeable_hours).toBe(fe005Baseline.chargeable_hours);
    expect(fe005WithPriorYear.pct_of_annual_target).toBe(fe005Baseline.pct_of_annual_target);
    expect(fe005WithPriorYear.time_value).toBe(fe005Baseline.time_value);
    expect(fe005WithPriorYear.billed_value).toBe(fe005Baseline.billed_value);
    expect(fe005WithPriorYear.written_off).toBe(fe005Baseline.written_off);

    const pen001Baseline = rollups.allClientFins.find((c) => c.client_code === 'PEN001')!;
    const pen001WithPriorYear = withPriorYear.allClientFins.find(
      (c) => c.client_code === 'PEN001',
    )!;
    expect(pen001WithPriorYear.fees_billed).toBe(pen001Baseline.fees_billed);
  });

  it('handles an extract with no as-at date or a malformed as-at date without throwing or falling back to October (R338)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const {
      buildFeeEarnerWeeklyTime,
      buildFirmFinanceRollups,
      formatPmsAsAtLabel,
      PMS_AS_AT_UNAVAILABLE_LABEL,
    } = await import('@/domain/pms');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-r338-'));
    const tmpDbPath = path.join(tmpDir, 'pms-r338.sqlite');
    try {
      buildPmsDatabaseFromWorkbook({ dbPath: tmpDbPath });
      const customSource = new DemoDbPmsSource(tmpDbPath);

      for (const badDate of ['', 'not-a-date', '2026-02-31']) {
        const db = new DatabaseSync(tmpDbPath);
        try {
          if (badDate === '') {
            db.exec(`DELETE FROM extract_info;`);
          } else {
            db.exec(`DELETE FROM extract_info;`);
            db.prepare(
              `INSERT INTO extract_info (as_at_date, imported_at, source_file) VALUES (?, ?, ?)`,
            ).run(badDate, '2026-11-09T09:00:00Z', 'bad.xlsx');
          }
        } finally {
          db.close();
        }

        const info = customSource.getExtractInfo();
        expect(info.asAtDate).toBe('');
        expect(info.sourceFile).toBe(PMS_AS_AT_UNAVAILABLE_LABEL);
        expect(formatPmsAsAtLabel(info.asAtDate)).toBe(PMS_AS_AT_UNAVAILABLE_LABEL);
        expect(formatPmsAsAtLabel(badDate)).toBe(PMS_AS_AT_UNAVAILABLE_LABEL);
        expect(formatPmsAsAtLabel(badDate)).not.toMatch(/Oct/i);

        const rollups = buildFirmFinanceRollups({
          asAtDate: badDate,
          feeEarners: customSource.listFeeEarners(),
          clients: customSource.listClients(),
          matterFinancials: customSource.getAllMatterFinancials(),
          invoices: customSource.listAllInvoiceBalances(),
          timeEntries: customSource.listAllTimeEntries(),
          payments: customSource.listAllPayments(),
        });
        expect(rollups.allFeeEarnerPerformance).toEqual([]);
        expect(rollups.pmsMonthlyFeesBilled).toEqual({ months: [], yearToDateTotal: 0 });
        expect(rollups.pmsCashReceived).toEqual({
          currentMonthTotal: 0,
          currentMonthReceiptCount: 0,
          previousMonthTotal: 0,
          previousMonthReceiptCount: 0,
        });
        expect(rollups.pmsDepartmentFinancials.departments).toEqual([]);

        const weekly = buildFeeEarnerWeeklyTime({
          feeEarner: customSource.listFeeEarners()[0],
          timeEntries: customSource.listAllTimeEntries(),
          asAtDate: badDate,
        });
        expect(weekly).toBeNull();

        const { isActionDenied } = await import('@/domain/actionResult');
        const { getFirmFinance, getMatterFinanceRows, getMyFinanceFigures } =
          await import('@/server/financeServices');
        const { getClientPmsViewBundle, getMatterPmsViewBundle } =
          await import('@/server/services');
        const getPmsSpy = vi
          .spyOn(pmsSourceModule, 'getPmsSource')
          .mockReturnValue(customSource);
        try {
          const rowsRes = getMatterFinanceRows('P-000001');
          expect(isActionDenied(rowsRes)).toBe(false);
          if (!isActionDenied(rowsRes)) {
            expect(rowsRes.pmsExtractInfo.asAtDate).toBe('');
            expect(rowsRes.pmsExtractInfo.sourceFile).toBe(PMS_AS_AT_UNAVAILABLE_LABEL);
            expect(rowsRes.allMatterFins).toEqual([]);
            expect(rowsRes.pmsSummaryByMatterId).toEqual({});
          }

          const myRes = getMyFinanceFigures('P-000002');
          expect(isActionDenied(myRes)).toBe(false);
          if (!isActionDenied(myRes)) {
            expect(myRes.myFeeEarnerFigures).toBeNull();
            expect(myRes.myWeeklyTime).toBeNull();
          }

          const firmRes = getFirmFinance('P-000001');
          expect(isActionDenied(firmRes)).toBe(false);
          if (!isActionDenied(firmRes)) {
            expect(firmRes.pmsExtractInfo.asAtDate).toBe('');
            expect(firmRes.pmsExtractInfo.sourceFile).toBe(PMS_AS_AT_UNAVAILABLE_LABEL);
            expect(firmRes.allFeeEarnerPerformance).toEqual([]);
            expect(firmRes.pmsMonthlyFeesBilled).toEqual({ months: [], yearToDateTotal: 0 });
            expect(firmRes.allClientFins).toEqual([]);
          }

          const matterBundleRes = getMatterPmsViewBundle('M-000001', 'P-000004');
          expect(isActionDenied(matterBundleRes)).toBe(false);
          if (!isActionDenied(matterBundleRes)) {
            expect(matterBundleRes.extractInfo.asAtDate).toBe('');
            expect(matterBundleRes.extractInfo.sourceFile).toBe(
              PMS_AS_AT_UNAVAILABLE_LABEL,
            );
            expect(matterBundleRes.matterBundle).toBeNull();
            expect(matterBundleRes.allUnlinkedPmsMatters.length).toBeGreaterThan(0);
          }

          const clientBundleRes = getClientPmsViewBundle(
            'organisation',
            'O-000001',
            'P-000001',
          );
          expect(isActionDenied(clientBundleRes)).toBe(false);
          if (!isActionDenied(clientBundleRes)) {
            expect(clientBundleRes.extractInfo.asAtDate).toBe('');
            expect(clientBundleRes.extractInfo.sourceFile).toBe(
              PMS_AS_AT_UNAVAILABLE_LABEL,
            );
            expect(clientBundleRes.clientBundle).toBeNull();
            expect(Object.keys(clientBundleRes.oneSquaredMatterIdByPmsCode).length).toBeGreaterThan(0);
          }
        } finally {
          getPmsSpy.mockRestore();
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates README as-at date parsing, buildPmsDatabaseFromWorkbook date validation, and --as-at CLI overrides (R359)', async () => {
    const {
      extractAsAtDateFromWorkbook,
      parseImportPmsCliArgs,
    } = await import('@/pms/importPms');

    // 1. README parser accepts ISO and "16 October 2026. ..."
    expect(
      extractAsAtDateFromWorkbook({
        sheetNames: ['README'],
        getSheetMatrix: () => [
          { rowNumber: 1, cells: { A: 'Field', B: 'Value' } },
          { rowNumber: 2, cells: { A: 'As-at date', B: '2026-10-16' } },
        ],
      }),
    ).toBe('2026-10-16');

    expect(
      extractAsAtDateFromWorkbook({
        sheetNames: ['README'],
        getSheetMatrix: () => [
          {
            rowNumber: 5,
            cells: {
              A: 'As-at date',
              B: '16 October 2026. All age buckets, overdue indicators, and YTD totals are evaluated relative to this date.',
            },
          },
        ],
      }),
    ).toBe('2026-10-16');

    // 2. Rejects bad day ("31 February 2026"), missing row, and missing README sheet
    expect(
      extractAsAtDateFromWorkbook({
        sheetNames: ['README'],
        getSheetMatrix: () => [
          { rowNumber: 2, cells: { A: 'As-at date', B: '31 February 2026' } },
        ],
      }),
    ).toBeNull();

    expect(
      extractAsAtDateFromWorkbook({
        sheetNames: ['README'],
        getSheetMatrix: () => [
          { rowNumber: 1, cells: { A: 'Firm name', B: 'Not A Law Firm LLP' } },
        ],
      }),
    ).toBeNull();

    expect(
      extractAsAtDateFromWorkbook({
        sheetNames: ['clients'],
        getSheetMatrix: () => [],
      }),
    ).toBeNull();

    // 3. buildPmsDatabaseFromWorkbook throws on bad date or empty explicit override, and --as-at overrides README
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-r359-'));
    const tmpDbPath = path.join(tmpDir, 'pms-r359.sqlite');
    try {
      expect(() =>
        buildPmsDatabaseFromWorkbook({ dbPath: tmpDbPath, asAtDate: '2026-02-30' }),
      ).toThrow(/Invalid or missing PMS extract as-at date "2026-02-30"/);

      expect(() =>
        buildPmsDatabaseFromWorkbook({ dbPath: tmpDbPath, asAtDate: '' }),
      ).toThrow(/Invalid or missing PMS extract as-at date ""/);

      const parsedOverride = parseImportPmsCliArgs(['--as-at', '2026-11-30']);
      expect(parsedOverride).toEqual({ asAtDate: '2026-11-30' });
      expect(parseImportPmsCliArgs(['--as-at=2026-11-30'])).toEqual({
        asAtDate: '2026-11-30',
      });

      const imported = buildPmsDatabaseFromWorkbook({
        dbPath: tmpDbPath,
        ...parsedOverride,
      });
      expect(imported.asAtDate).toBe('2026-11-30');
      const customSource = new DemoDbPmsSource(tmpDbPath);
      expect(customSource.getExtractInfo().asAtDate).toBe('2026-11-30');

      // 4. --as-at with no value or --as-at= fails instead of falling back to README
      expect(() => parseImportPmsCliArgs(['--as-at'])).toThrow(
        /Missing value for --as-at/,
      );
      expect(() => parseImportPmsCliArgs(['--as-at', '--other-flag'])).toThrow(
        /Missing value for --as-at/,
      );
      expect(() => parseImportPmsCliArgs(['--as-at='])).toThrow(
        /Empty value for --as-at=/,
      );
      expect(() => parseImportPmsCliArgs(['--as-at=   '])).toThrow(
        /Empty value for --as-at=/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const { isActionDenied } = await import('@/domain/actionResult');
    const { getClientPmsViewBundle } = await import('@/server/services');
    const view = getClientPmsViewBundle('organisation', 'O-000005', 'P-000001');
    expect(isActionDenied(view)).toBe(false);
    if (isActionDenied(view)) return;
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

  it('surfaces PMS financial alerts on the home page attention list and hides them without finance capability', async () => {
    const { attentionList } = await import('@/domain/attention');
    const { isActionDenied } = await import('@/domain/actionResult');
    const { canUserViewFinance } = await import('@/domain/pms');
    const { getMatterFinanceRows } = await import('@/server/financeServices');
    const { getAppSnapshot } = await import('@/server/services');

    const snap = getAppSnapshot('P-000001');
    const matterRows = getMatterFinanceRows('P-000001');
    expect(isActionDenied(matterRows)).toBe(false);
    if (isActionDenied(matterRows)) return;

    const allRecords = [...snap.people, ...snap.organisations];
    const today = new Date('2026-10-16T10:00:00Z');

    const fullItems = attentionList(allRecords, snap.values, today, {
      tasks: snap.tasks,
      enquiries: snap.enquiries,
      teams: snap.teams,
      matters: snap.matters,
      pmsSummaryByMatterId: matterRows.pmsSummaryByMatterId,
      canViewFinance: true,
    });

    const pmsKinds = new Set(fullItems.map((i) => i.kind).filter((k) => k.startsWith('pms_')));
    expect(pmsKinds.has('pms_over_estimate')).toBe(true);
    expect(pmsKinds.has('pms_capped_fee_exceeded')).toBe(true);
    expect(pmsKinds.has('pms_overdue_bill_60')).toBe(true);
    expect(pmsKinds.has('pms_old_wip_30')).toBe(true);
    expect(pmsKinds.has('pms_pending_estimate_revision')).toBe(true);

    // Call handler role (canViewFinance = false, or omitted default) must not see any PMS financial alerts
    const callHandlerItems = attentionList(allRecords, snap.values, today, {
      tasks: snap.tasks,
      enquiries: snap.enquiries,
      teams: snap.teams,
      matters: snap.matters,
      pmsSummaryByMatterId: matterRows.pmsSummaryByMatterId,
    });
    expect(callHandlerItems.some((i) => i.kind.startsWith('pms_'))).toBe(false);
    expect(canUserViewFinance(null, snap.teams, snap.values)).toBe(false);
    expect(canUserViewFinance(undefined, snap.teams, snap.values)).toBe(false);
  });

  it('builds two-way outbound PMS commands and reconciles inbound commercials respecting System-of-Record ownership', async () => {
    const { isActionDenied } = await import('@/domain/actionResult');
    const {
      buildPmsOutboundMatterCommand,
      reconcilePmsInboundMatterCommercials,
    } = await import('@/domain/pms');
    const { getMatterFinanceRows } = await import('@/server/financeServices');
    const { getAppSnapshot } = await import('@/server/services');
    const { getActiveTenantConfiguration } = await import('@/platform/tenantRuntime');

    const snap = getAppSnapshot('P-000001');
    const matterRows = getMatterFinanceRows('P-000001');
    expect(isActionDenied(matterRows)).toBe(false);
    if (isActionDenied(matterRows)) return;

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
      pmsLinks: matterRows.pmsLinks,
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

  it('enforces Ofcom drama phone ranges and allow-listed invented email domains across imported PMS data and seed (R49, R74)', async () => {
    const source = new DemoDbPmsSource();
    const clients = source.listClients();
    const feeEarners = source.listFeeEarners();

    const ofcomDramaRegex =
      /^(01632\s?960\d{3}|020\s?7946\s?0\d{3}|029\s?2018\s?0\d{3}|0117\s?496\s?0\d{3}|07700\s?900\d{3}|08081\s?570\d{3}|0909\s?8790\d{3})$/;
    const allowedDomainRegex =
      /@(example\.(com|org|net)|[a-z0-9.-]+\.(example|test))$/i;

    for (const c of clients) {
      if (c.phone.trim()) {
        expect(c.phone.trim()).toMatch(ofcomDramaRegex);
      }
      if (c.email.trim()) {
        expect(c.email.trim()).toMatch(allowedDomainRegex);
      }
      if (c.company_number.trim()) {
        expect(c.company_number.trim()).toMatch(/^DEMO-/);
      }
    }

    for (const fe of feeEarners) {
      expect(fe.email.trim()).toMatch(allowedDomainRegex);
    }

    const { getAppSnapshot } = await import('@/server/services');
    const snap = getAppSnapshot('P-000001');
    for (const p of snap.people) {
      for (const em of p.emails) {
        expect(em.address.trim()).toMatch(allowedDomainRegex);
      }
      for (const ph of p.phones) {
        expect(ph.number.trim()).toMatch(ofcomDramaRegex);
      }
    }
    for (const enq of snap.enquiries) {
      if (enq.email?.trim()) expect(enq.email.trim()).toMatch(allowedDomainRegex);
      if (enq.phone?.trim()) expect(enq.phone.trim()).toMatch(ofcomDramaRegex);
    }
    for (const qte of snap.quotes) {
      if (qte.prospectEmail?.trim()) expect(qte.prospectEmail.trim()).toMatch(allowedDomainRegex);
      if (qte.prospectPhone?.trim()) expect(qte.prospectPhone.trim()).toMatch(ofcomDramaRegex);
    }

    // R49 & R130: Verify single canonical workbook (data/pms/1Squared_PMS_Demo_Data.xlsx) across every sheet and raw src/seed/demo.ts source text
    const wbPath = path.join(
      process.cwd(),
      'data',
      'pms',
      '1Squared_PMS_Demo_Data.xlsx',
    );
    expect(fs.existsSync(wbPath)).toBe(true);
    expect(
      fs.existsSync(
        path.join(process.cwd(), 'docs', '1Squared_PMS_Demo_Data.xlsx'),
      ),
    ).toBe(false);
    const wb = openXlsxWorkbook(wbPath);
    expect(wb.sheetNames.length).toBeGreaterThan(0);
    const emailCandidateRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneHeaderRe = /phone|mobile|tel/i;
    for (const sheetName of wb.sheetNames) {
      const rows = wb.getSheetRows(sheetName);
      for (const row of rows) {
        for (const [colName, rawVal] of Object.entries(row)) {
          const val = rawVal?.trim();
          if (!val) continue;
          if (/email/i.test(colName) || emailCandidateRe.test(val)) {
            expect(val, `${wbPath} [${sheetName}.${colName}] email`).toMatch(
              allowedDomainRegex,
            );
          }
          if (phoneHeaderRe.test(colName)) {
            expect(val, `${wbPath} [${sheetName}.${colName}] phone`).toMatch(
              ofcomDramaRegex,
            );
          }
        }
      }
      const matrix = wb.getSheetMatrix(sheetName);
      for (const mRow of matrix) {
        for (const [colRef, rawCell] of Object.entries(mRow.cells)) {
          const cellVal = rawCell?.trim();
          if (cellVal && emailCandidateRe.test(cellVal)) {
            expect(
              cellVal,
              `${wbPath} [${sheetName}!${colRef}${mRow.rowNumber}] cell email`,
            ).toMatch(allowedDomainRegex);
          }
        }
      }
    }

    const seedSourceText = fs.readFileSync(
      path.join(process.cwd(), 'src', 'seed', 'demo.ts'),
      'utf8',
    );
    const phoneFieldRe =
      /(?:["']?(?:phone|mobile|directPhone|mainPhone|prospectPhone|number)["']?\s*:\s*["']([^"']+)["']|\bphone\(\s*["']([^"']+)["'])/g;
    const matchedSeedPhones: string[] = [];
    for (const m of seedSourceText.matchAll(phoneFieldRe)) {
      const ph = (m[1] ?? m[2] ?? '').trim();
      if (ph && !ph.includes('${')) {
        matchedSeedPhones.push(ph);
        expect(ph, 'src/seed/demo.ts phone literal').toMatch(ofcomDramaRegex);
      }
    }
    expect(matchedSeedPhones.length).toBeGreaterThan(20);
  });
});

