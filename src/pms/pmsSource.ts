/**
 * Adapter layer (`PmsSource`) and its SQLite demo implementation (`DemoDbPmsSource`).
 * No UI component or server service queries the PMS database directly;
 * all reads go through `getPmsSource()`.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  buildPmsDatabaseFromWorkbook,
  DEFAULT_PMS_DB_PATH,
  PMS_AS_AT_DATE,
} from './importPms';
import type {
  PmsAgeBucket,
  PmsClient,
  PmsClientAccountEntry,
  PmsClientFinancials,
  PmsClientFullBundle,
  PmsDisbursement,
  PmsExtractInfo,
  PmsFeeEarner,
  PmsFeeEarnerPerformance,
  PmsFeeEstimate,
  PmsInvoiceBalance,
  PmsInvoiceDetail,
  PmsMatter,
  PmsMatterFinancials,
  PmsMatterFullBundle,
  PmsMatterWipBreakdown,
  PmsPayment,
  PmsRecalculatedInvoiceStatus,
  PmsSource,
  PmsTimeEntry,
  PmsTimeEntryFilters,
} from './types';

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function num(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

export class DemoDbPmsSource implements PmsSource {
  private readonly dbPath: string;

  constructor(dbPath: string = DEFAULT_PMS_DB_PATH) {
    this.dbPath = dbPath;
  }

  private openDb(): DatabaseSync {
    if (!fs.existsSync(this.dbPath)) {
      buildPmsDatabaseFromWorkbook({ dbPath: this.dbPath });
    }
    return new DatabaseSync(this.dbPath, { readOnly: true });
  }

  private mapMatterFinancials(row: Record<string, unknown>): PmsMatterFinancials {
    return {
      matter_code: String(row.matter_code),
      client_code: String(row.client_code),
      client_name: String(row.client_name ?? ''),
      matter_description: String(row.matter_description ?? ''),
      work_type: String(row.work_type ?? ''),
      practice_area: String(row.practice_area ?? ''),
      responsible_partner_id: String(row.responsible_partner_id ?? ''),
      responsible_partner_name: String(row.responsible_partner_name ?? ''),
      fee_earner_id: String(row.fee_earner_id ?? ''),
      fee_earner_name: String(row.fee_earner_name ?? ''),
      billing_basis: String(row.billing_basis) as PmsMatterFinancials['billing_basis'],
      fixed_fee_amount: round2(Number(row.fixed_fee_amount)),
      estimate_alert_pct: Number(row.estimate_alert_pct ?? 0.75),
      date_opened: String(row.date_opened ?? ''),
      date_closed: row.date_closed ? String(row.date_closed) : null,
      status: String(row.status) as PmsMatterFinancials['status'],
      billing_frequency: String(row.billing_frequency ?? ''),
      client_reference: String(row.client_reference ?? ''),
      third_party_payer: String(row.third_party_payer ?? ''),
      fee_estimate: round2(Number(row.fee_estimate)),
      time_value_recorded: round2(Number(row.time_value_recorded)),
      unbilled_wip: round2(Number(row.unbilled_wip)),
      fees_billed: round2(Number(row.fees_billed)),
      disbursements_billed: round2(Number(row.disbursements_billed)),
      total_invoiced_inc_vat: round2(Number(row.total_invoiced_inc_vat)),
      total_paid: round2(Number(row.total_paid)),
      outstanding_debt: round2(Number(row.outstanding_debt)),
      unbilled_disbursements: round2(Number(row.unbilled_disbursements)),
      estimate_used_pct: Number(row.estimate_used_pct ?? 0),
      written_off: round2(Number(row.written_off)),
      client_account_balance: round2(Number(row.client_account_balance)),
      has_pending_estimate_revision: Boolean(Number(row.has_pending_estimate_revision)),
      oldest_unbilled_wip_days:
        row.oldest_unbilled_wip_days !== null && row.oldest_unbilled_wip_days !== undefined
          ? Number(row.oldest_unbilled_wip_days)
          : null,
      max_invoice_days_past_due:
        row.max_invoice_days_past_due !== null && row.max_invoice_days_past_due !== undefined
          ? Number(row.max_invoice_days_past_due)
          : null,
    };
  }

  private mapClientFinancials(row: Record<string, unknown>): PmsClientFinancials {
    return {
      client_code: String(row.client_code),
      client_name: String(row.client_name ?? ''),
      client_type: String(row.client_type) as PmsClientFinancials['client_type'],
      company_number: String(row.company_number ?? ''),
      email: String(row.email ?? ''),
      client_partner_id: String(row.client_partner_id ?? ''),
      credit_terms_days: Number(row.credit_terms_days ?? 0),
      credit_limit: round2(Number(row.credit_limit)),
      rate_discount_pct: Number(row.rate_discount_pct ?? 0),
      status: String(row.status ?? 'Active'),
      unbilled_wip: round2(Number(row.unbilled_wip)),
      fees_billed: round2(Number(row.fees_billed)),
      disbursements_billed: round2(Number(row.disbursements_billed)),
      total_invoiced_inc_vat: round2(Number(row.total_invoiced_inc_vat)),
      total_paid: round2(Number(row.total_paid)),
      outstanding_debt: round2(Number(row.outstanding_debt)),
      unbilled_disbursements: round2(Number(row.unbilled_disbursements)),
      client_account_balance: round2(Number(row.client_account_balance)),
      aged_not_yet_due: round2(Number(row.aged_not_yet_due)),
      aged_1_30: round2(Number(row.aged_1_30)),
      aged_31_60: round2(Number(row.aged_31_60)),
      aged_61_90: round2(Number(row.aged_61_90)),
      aged_90_plus: round2(Number(row.aged_90_plus)),
      credit_limit_used_pct:
        row.credit_limit_used_pct !== null && row.credit_limit_used_pct !== undefined
          ? Number(row.credit_limit_used_pct)
          : null,
    };
  }

  private mapInvoiceBalance(row: Record<string, unknown>): PmsInvoiceBalance {
    return {
      invoice_number: String(row.invoice_number),
      matter_code: String(row.matter_code),
      client_code: String(row.client_code),
      invoice_date: String(row.invoice_date),
      due_date: String(row.due_date),
      invoice_type: String(row.invoice_type),
      period_from: row.period_from ? String(row.period_from) : null,
      period_to: row.period_to ? String(row.period_to) : null,
      fees_net: round2(Number(row.fees_net)),
      disbursements_net: round2(Number(row.disbursements_net)),
      vat: round2(Number(row.vat)),
      total: round2(Number(row.total)),
      exported_status: String(row.exported_status ?? ''),
      credit_note_for: row.credit_note_for ? String(row.credit_note_for) : null,
      paid: round2(Number(row.paid)),
      credit_notes: round2(Number(row.credit_notes)),
      outstanding: round2(Number(row.outstanding)),
      days_past_due:
        row.days_past_due !== null && row.days_past_due !== undefined
          ? Number(row.days_past_due)
          : null,
      age_bucket: String(row.age_bucket) as PmsAgeBucket,
      recalculated_status: String(row.recalculated_status) as PmsRecalculatedInvoiceStatus,
    };
  }

  private mapTimeEntry(row: Record<string, unknown>): PmsTimeEntry {
    return {
      time_id: String(row.time_id),
      matter_code: String(row.matter_code),
      fee_earner_id: String(row.fee_earner_id),
      fee_earner_name: row.fee_earner_name ? String(row.fee_earner_name) : undefined,
      fee_earner_initials: row.fee_earner_initials ? String(row.fee_earner_initials) : undefined,
      date: String(row.date),
      activity: String(row.activity),
      narrative: String(row.narrative),
      minutes: Number(row.minutes ?? 0),
      units: Number(row.units ?? 0),
      hours: Number(row.hours ?? 0),
      rate: round2(Number(row.rate)),
      value: round2(Number(row.value)),
      chargeable: String(row.chargeable) as 'Y' | 'N',
      billed_status: String(row.billed_status) as PmsTimeEntry['billed_status'],
      invoice_number: row.invoice_number ? String(row.invoice_number) : null,
      billed_value: round2(Number(row.billed_value)),
      write_off_value: round2(Number(row.write_off_value)),
    };
  }

  private mapDisbursement(row: Record<string, unknown>): PmsDisbursement {
    return {
      disbursement_id: String(row.disbursement_id),
      matter_code: String(row.matter_code),
      date: String(row.date),
      type: String(row.type),
      supplier: String(row.supplier),
      description: String(row.description),
      net_amount: round2(Number(row.net_amount)),
      vat_amount: round2(Number(row.vat_amount)),
      gross_amount: round2(Number(row.gross_amount)),
      paid_from: String(row.paid_from) as PmsDisbursement['paid_from'],
      billed_status: String(row.billed_status) as PmsDisbursement['billed_status'],
      invoice_number: row.invoice_number ? String(row.invoice_number) : null,
    };
  }

  getExtractInfo(): PmsExtractInfo {
    const db = this.openDb();
    try {
      const row = db
        .prepare(`SELECT as_at_date, imported_at, source_file FROM extract_info LIMIT 1`)
        .get() as Record<string, unknown> | undefined;
      return {
        asAtDate: row?.as_at_date ? String(row.as_at_date) : PMS_AS_AT_DATE,
        importedAt: row?.imported_at ? String(row.imported_at) : new Date().toISOString(),
        sourceFile: row?.source_file ? String(row.source_file) : '1Squared_PMS_Demo_Data.xlsx',
      };
    } finally {
      db.close();
    }
  }

  getMatterFinancials(matterCode: string): PmsMatterFinancials | null {
    const db = this.openDb();
    try {
      const row = db
        .prepare(`SELECT * FROM v_matter_financials WHERE matter_code = ?`)
        .get(matterCode) as Record<string, unknown> | undefined;
      return row ? this.mapMatterFinancials(row) : null;
    } finally {
      db.close();
    }
  }

  getAllMatterFinancials(): PmsMatterFinancials[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM v_matter_financials ORDER BY matter_code ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((r) => this.mapMatterFinancials(r));
    } finally {
      db.close();
    }
  }

  getClientFinancials(clientCode: string): PmsClientFinancials | null {
    const db = this.openDb();
    try {
      const row = db
        .prepare(`SELECT * FROM v_client_financials WHERE client_code = ?`)
        .get(clientCode) as Record<string, unknown> | undefined;
      return row ? this.mapClientFinancials(row) : null;
    } finally {
      db.close();
    }
  }

  getAllClientFinancials(): PmsClientFinancials[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM v_client_financials ORDER BY client_code ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((r) => this.mapClientFinancials(r));
    } finally {
      db.close();
    }
  }

  getTimeEntries(matterCode: string, filters?: PmsTimeEntryFilters): PmsTimeEntry[] {
    const db = this.openDb();
    try {
      const clauses = ['te.matter_code = ?'];
      const params: (string | number)[] = [matterCode];

      if (filters?.feeEarnerId && filters.feeEarnerId !== 'all') {
        clauses.push('te.fee_earner_id = ?');
        params.push(filters.feeEarnerId);
      }
      if (filters?.billedStatus && filters.billedStatus !== 'all') {
        clauses.push('te.billed_status = ?');
        params.push(filters.billedStatus);
      }
      if (filters?.dateFrom) {
        clauses.push('te.date >= ?');
        params.push(filters.dateFrom);
      }
      if (filters?.dateTo) {
        clauses.push('te.date <= ?');
        params.push(filters.dateTo);
      }

      const sql = `
        SELECT
          te.*,
          (fe.first_name || ' ' || fe.last_name) AS fee_earner_name,
          fe.initials AS fee_earner_initials
        FROM time_entries te
        JOIN fee_earners fe ON fe.fee_earner_id = te.fee_earner_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY te.date DESC, te.time_id DESC
      `;
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map((r) => this.mapTimeEntry(r));
    } finally {
      db.close();
    }
  }

  getMatterWipBreakdown(matterCode: string): PmsMatterWipBreakdown {
    const db = this.openDb();
    try {
      const feRows = db
        .prepare(`
          SELECT
            fe.fee_earner_id,
            (fe.first_name || ' ' || fe.last_name) AS name,
            fe.initials,
            fe.grade,
            ROUND(SUM(ROUND(te.hours * 100)) / 100.0, 2) AS hours,
            ROUND(SUM(ROUND(te.value * 100)) / 100.0, 2) AS wip_value
          FROM time_entries te
          JOIN fee_earners fe ON fe.fee_earner_id = te.fee_earner_id
          WHERE te.matter_code = ? AND te.billed_status = 'Unbilled'
          GROUP BY fe.fee_earner_id
          ORDER BY wip_value DESC, fe.fee_earner_id ASC
        `)
        .all(matterCode) as Record<string, unknown>[];

      const ageRow = db
        .prepare(`
          WITH ext AS (SELECT as_at_date FROM extract_info LIMIT 1)
          SELECT
            ROUND(SUM(CASE WHEN CAST(julianday((SELECT as_at_date FROM ext)) - julianday(date) AS INTEGER) <= 30 THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS bucket_0_30,
            ROUND(SUM(CASE WHEN CAST(julianday((SELECT as_at_date FROM ext)) - julianday(date) AS INTEGER) BETWEEN 31 AND 60 THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS bucket_31_60,
            ROUND(SUM(CASE WHEN CAST(julianday((SELECT as_at_date FROM ext)) - julianday(date) AS INTEGER) BETWEEN 61 AND 90 THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS bucket_61_90,
            ROUND(SUM(CASE WHEN CAST(julianday((SELECT as_at_date FROM ext)) - julianday(date) AS INTEGER) > 90 THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS bucket_90_plus
          FROM time_entries
          WHERE matter_code = ? AND billed_status = 'Unbilled'
        `)
        .get(matterCode) as Record<string, unknown> | undefined;

      return {
        byFeeEarner: feRows.map((r) => ({
          fee_earner_id: String(r.fee_earner_id),
          name: String(r.name),
          initials: String(r.initials),
          grade: String(r.grade),
          hours: Number(r.hours ?? 0),
          wip_value: round2(Number(r.wip_value)),
        })),
        byAgeBucket: {
          bucket_0_30: round2(Number(ageRow?.bucket_0_30)),
          bucket_31_60: round2(Number(ageRow?.bucket_31_60)),
          bucket_61_90: round2(Number(ageRow?.bucket_61_90)),
          bucket_90_plus: round2(Number(ageRow?.bucket_90_plus)),
        },
      };
    } finally {
      db.close();
    }
  }

  getFeeEstimates(matterCode: string): PmsFeeEstimate[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`
          SELECT
            fe.*,
            (f.first_name || ' ' || f.last_name) AS given_by_name
          FROM fee_estimates fe
          LEFT JOIN fee_earners f ON f.fee_earner_id = fe.given_by
          WHERE fe.matter_code = ?
          ORDER BY fe.date_given ASC, fe.estimate_id ASC
        `)
        .all(matterCode) as Record<string, unknown>[];
      return rows.map((r) => ({
        estimate_id: String(r.estimate_id),
        matter_code: String(r.matter_code),
        date_given: String(r.date_given),
        estimate_type: String(r.estimate_type) as PmsFeeEstimate['estimate_type'],
        fees_estimate: round2(Number(r.fees_estimate)),
        disbursements_estimate: round2(Number(r.disbursements_estimate)),
        given_by: String(r.given_by),
        given_by_name: r.given_by_name ? String(r.given_by_name) : undefined,
        accepted_by_client: String(r.accepted_by_client) as PmsFeeEstimate['accepted_by_client'],
        notes: String(r.notes ?? ''),
      }));
    } finally {
      db.close();
    }
  }

  getInvoices(filter?: { matterCode?: string; clientCode?: string }): PmsInvoiceDetail[] {
    const db = this.openDb();
    try {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter?.matterCode) {
        clauses.push('matter_code = ?');
        params.push(filter.matterCode);
      }
      if (filter?.clientCode) {
        clauses.push('client_code = ?');
        params.push(filter.clientCode);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const invRows = db
        .prepare(
          `SELECT * FROM v_invoice_balances ${where} ORDER BY invoice_date DESC, invoice_number DESC`,
        )
        .all(...params) as Record<string, unknown>[];

      const allBalances = invRows.map((r) => this.mapInvoiceBalance(r));

      const paymentStmt = db.prepare(
        `SELECT * FROM payments WHERE invoice_number = ? ORDER BY receipt_date ASC, receipt_id ASC`,
      );
      const timeStmt = db.prepare(`
        SELECT te.*, (fe.first_name || ' ' || fe.last_name) AS fee_earner_name, fe.initials AS fee_earner_initials
        FROM time_entries te
        JOIN fee_earners fe ON fe.fee_earner_id = te.fee_earner_id
        WHERE te.invoice_number = ?
        ORDER BY te.date ASC, te.time_id ASC
      `);
      const disbStmt = db.prepare(
        `SELECT * FROM disbursements WHERE invoice_number = ? ORDER BY date ASC, disbursement_id ASC`,
      );

      return allBalances.map((inv) => {
        const payRows = paymentStmt.all(inv.invoice_number) as Record<string, unknown>[];
        const teRows = timeStmt.all(inv.invoice_number) as Record<string, unknown>[];
        const dRows = disbStmt.all(inv.invoice_number) as Record<string, unknown>[];
        const appliedCreditNotes = allBalances.filter(
          (other) => other.credit_note_for === inv.invoice_number,
        );

        const payments: PmsPayment[] = payRows.map((p) => ({
          receipt_id: String(p.receipt_id),
          invoice_number: String(p.invoice_number),
          matter_code: String(p.matter_code),
          client_code: String(p.client_code),
          receipt_date: String(p.receipt_date),
          amount: round2(Number(p.amount)),
          method: String(p.method),
          reference: String(p.reference),
        }));

        return {
          ...inv,
          payments,
          timeEntries: teRows.map((t) => this.mapTimeEntry(t)),
          disbursements: dRows.map((d) => this.mapDisbursement(d)),
          appliedCreditNotes,
        };
      });
    } finally {
      db.close();
    }
  }

  getAgedDebt(clientCode?: string): PmsInvoiceBalance[] {
    const db = this.openDb();
    try {
      const clauses = [`invoice_type != 'Credit note'`];
      const params: string[] = [];
      if (clientCode) {
        clauses.push('client_code = ?');
        params.push(clientCode);
      }
      const rows = db
        .prepare(
          `SELECT * FROM v_invoice_balances WHERE ${clauses.join(' AND ')} ORDER BY invoice_number ASC`,
        )
        .all(...params) as Record<string, unknown>[];
      return rows.map((r) => this.mapInvoiceBalance(r));
    } finally {
      db.close();
    }
  }

  getDisbursements(matterCode: string): PmsDisbursement[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(
          `SELECT * FROM disbursements WHERE matter_code = ? ORDER BY date DESC, disbursement_id DESC`,
        )
        .all(matterCode) as Record<string, unknown>[];
      return rows.map((r) => this.mapDisbursement(r));
    } finally {
      db.close();
    }
  }

  getClientAccountLedger(matterCode: string): PmsClientAccountEntry[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(
          `SELECT * FROM client_account WHERE matter_code = ? ORDER BY date ASC, transaction_id ASC`,
        )
        .all(matterCode) as Record<string, unknown>[];
      let runningPence = 0;
      return rows.map((r) => {
        const amt = round2(Number(r.amount));
        runningPence += Math.round(amt * 100);
        return {
          transaction_id: String(r.transaction_id),
          matter_code: String(r.matter_code),
          client_code: String(r.client_code),
          date: String(r.date),
          type: String(r.type) as PmsClientAccountEntry['type'],
          description: String(r.description),
          amount: amt,
          running_balance: round2(runningPence / 100),
        };
      });
    } finally {
      db.close();
    }
  }

  getFeeEarnerPerformance(feeEarnerId?: string): PmsFeeEarnerPerformance[] {
    const db = this.openDb();
    try {
      const sql = feeEarnerId
        ? `SELECT * FROM v_fee_earner_performance WHERE fee_earner_id = ? ORDER BY fee_earner_id ASC`
        : `SELECT * FROM v_fee_earner_performance ORDER BY fee_earner_id ASC`;
      const rows = (
        feeEarnerId ? db.prepare(sql).all(feeEarnerId) : db.prepare(sql).all()
      ) as Record<string, unknown>[];
      return rows.map((r) => ({
        fee_earner_id: String(r.fee_earner_id),
        initials: String(r.initials),
        name: String(r.name),
        email: String(r.email),
        grade: String(r.grade),
        department: String(r.department),
        standard_hourly_rate: round2(Number(r.standard_hourly_rate)),
        chargeable_hours: Number(r.chargeable_hours ?? 0),
        chargeable_hours_this_month: Number(r.chargeable_hours_this_month ?? 0),
        time_value: round2(Number(r.time_value)),
        unbilled_wip: round2(Number(r.unbilled_wip)),
        billed_value: round2(Number(r.billed_value)),
        written_off: round2(Number(r.written_off)),
        annual_target_hours: Number(r.annual_target_hours ?? 0),
        pct_of_annual_target: Number(r.pct_of_annual_target ?? 0),
      }));
    } finally {
      db.close();
    }
  }

  getMatterFullBundle(matterCode: string): PmsMatterFullBundle | null {
    const summary = this.getMatterFinancials(matterCode);
    if (!summary) return null;
    return {
      extractInfo: this.getExtractInfo(),
      summary,
      estimates: this.getFeeEstimates(matterCode),
      timeEntries: this.getTimeEntries(matterCode),
      wipBreakdown: this.getMatterWipBreakdown(matterCode),
      invoices: this.getInvoices({ matterCode }),
      disbursements: this.getDisbursements(matterCode),
      clientAccount: this.getClientAccountLedger(matterCode),
    };
  }

  getClientFullBundle(clientCode: string): PmsClientFullBundle | null {
    const summary = this.getClientFinancials(clientCode);
    if (!summary) return null;
    const allMatters = this.getAllMatterFinancials().filter((m) => m.client_code === clientCode);
    const invoices = this.getAgedDebt(clientCode);
    return {
      extractInfo: this.getExtractInfo(),
      summary,
      matters: allMatters,
      invoices,
    };
  }

  listFeeEarners(): PmsFeeEarner[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM fee_earners ORDER BY fee_earner_id ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        fee_earner_id: String(r.fee_earner_id),
        initials: String(r.initials),
        first_name: String(r.first_name),
        last_name: String(r.last_name),
        email: String(r.email),
        grade: String(r.grade),
        department: String(r.department),
        standard_hourly_rate: round2(Number(r.standard_hourly_rate)),
        annual_target_hours: Number(r.annual_target_hours ?? 0),
        annual_target_fees: round2(Number(r.annual_target_fees)),
        active: String(r.active ?? 'Yes'),
      }));
    } finally {
      db.close();
    }
  }

  listClients(): PmsClient[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM clients ORDER BY client_code ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        client_code: String(r.client_code),
        client_name: String(r.client_name),
        client_type: String(r.client_type) as PmsClient['client_type'],
        company_number: String(r.company_number ?? ''),
        email: String(r.email ?? ''),
        phone: String(r.phone ?? ''),
        billing_address: String(r.billing_address ?? ''),
        postcode: String(r.postcode ?? ''),
        client_partner_id: String(r.client_partner_id),
        credit_terms_days: Number(r.credit_terms_days ?? 0),
        credit_limit: round2(Number(r.credit_limit)),
        rate_discount_pct: Number(r.rate_discount_pct ?? 0),
        date_opened: String(r.date_opened),
        sector: String(r.sector ?? ''),
        crm_match_on: String(r.crm_match_on) as PmsClient['crm_match_on'],
        status: String(r.status ?? 'Active'),
      }));
    } finally {
      db.close();
    }
  }

  listMatters(): PmsMatter[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM matters ORDER BY matter_code ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        matter_code: String(r.matter_code),
        client_code: String(r.client_code),
        matter_description: String(r.matter_description),
        work_type: String(r.work_type),
        practice_area: String(r.practice_area),
        responsible_partner_id: String(r.responsible_partner_id),
        fee_earner_id: String(r.fee_earner_id),
        billing_basis: String(r.billing_basis) as PmsMatter['billing_basis'],
        fixed_fee_amount: round2(Number(r.fixed_fee_amount)),
        fee_estimate: round2(Number(r.fee_estimate)),
        estimate_alert_pct: Number(r.estimate_alert_pct ?? 0.75),
        date_opened: String(r.date_opened),
        date_closed: r.date_closed ? String(r.date_closed) : null,
        status: String(r.status) as PmsMatter['status'],
        billing_frequency: String(r.billing_frequency ?? ''),
        client_reference: String(r.client_reference ?? ''),
        third_party_payer: String(r.third_party_payer ?? ''),
      }));
    } finally {
      db.close();
    }
  }

  getFeeEarnerWeeklyTime(feeEarnerId: string, customDailyPace?: number | null): import('./types').PmsFeeEarnerWeeklyTime | null {
    const db = this.openDb();
    try {
      const feRow = db
        .prepare(`SELECT fee_earner_id, annual_target_hours FROM fee_earners WHERE fee_earner_id = ?`)
        .get(feeEarnerId) as Record<string, unknown> | undefined;
      if (!feRow) return null;

      const targetHours = num(feRow.annual_target_hours) || 1200;
      const defaultDailyPace = Math.round((targetHours / (260 - 30)) * 10) / 10; // ~5.2h for 1200h
      const dailyPaceHours =
        typeof customDailyPace === 'number' && customDailyPace > 0 ? customDailyPace : defaultDailyPace;
      const weeklyPaceHours = Math.round(dailyPaceHours * 5 * 10) / 10;

      const weekDaysSpec: { dayLabel: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri'; date: string }[] = [
        { dayLabel: 'Mon', date: '2026-10-12' },
        { dayLabel: 'Tue', date: '2026-10-13' },
        { dayLabel: 'Wed', date: '2026-10-14' },
        { dayLabel: 'Thu', date: '2026-10-15' },
        { dayLabel: 'Fri', date: '2026-10-16' },
      ];

      const dayRows = db
        .prepare(
          `SELECT date, ROUND(SUM(hours), 2) AS hrs
           FROM time_entries
           WHERE fee_earner_id = ? AND chargeable = 'Y' AND date >= '2026-10-12' AND date <= '2026-10-16'
           GROUP BY date`
        )
        .all(feeEarnerId) as Record<string, unknown>[];

      const hoursByDate = new Map<string, number>();
      for (const r of dayRows) {
        hoursByDate.set(String(r.date), num(r.hrs));
      }

      const weekdays = weekDaysSpec.map((d) => ({
        dayLabel: d.dayLabel,
        date: d.date,
        hours: hoursByDate.get(d.date) ?? 0,
      }));
      const weekTotalHours = Math.round(weekdays.reduce((acc, d) => acc + d.hours, 0) * 10) / 10;

      const mtdRow = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(hours), 0), 2) AS mtd_hours
           FROM time_entries
           WHERE fee_earner_id = ? AND chargeable = 'Y' AND date >= '2026-10-01' AND date <= '2026-10-31'`
        )
        .get(feeEarnerId) as Record<string, unknown> | undefined;

      const wipRow = db
        .prepare(
          `SELECT
             ROUND(COALESCE(SUM(value), 0), 2) AS unbilled_wip,
             COUNT(DISTINCT matter_code) AS matter_count,
             MIN(date) AS oldest_date
           FROM time_entries
           WHERE fee_earner_id = ? AND chargeable = 'Y' AND billed_status = 'Unbilled'`
        )
        .get(feeEarnerId) as Record<string, unknown> | undefined;

      return {
        feeEarnerId,
        weekTotalHours,
        dailyPaceHours,
        weeklyPaceHours,
        weekdays,
        monthToDateHours: num(mtdRow?.mtd_hours),
        myUnbilledWip: num(wipRow?.unbilled_wip),
        myUnbilledMatterCount: num(wipRow?.matter_count),
        oldestUnbilledDate: wipRow?.oldest_date ? String(wipRow.oldest_date) : null,
      };
    } finally {
      db.close();
    }
  }

  getMonthlyFeesBilled(year = '2026'): { months: import('./types').PmsMonthlyFeesBilled[]; yearToDateTotal: number } {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(
          `SELECT substr(invoice_date, 1, 7) AS ym, ROUND(COALESCE(SUM(fees_net), 0), 2) AS total_fees
           FROM invoices
           WHERE substr(invoice_date, 1, 4) = ? AND status != 'Draft'
           GROUP BY substr(invoice_date, 1, 7)`
        )
        .all(year) as Record<string, unknown>[];

      const byYm = new Map<string, number>();
      for (const r of rows) {
        byYm.set(String(r.ym), num(r.total_fees));
      }

      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
      const months = monthNames.map((shortName, idx) => {
        const monthKey = `${year}-${String(idx + 1).padStart(2, '0')}`;
        return {
          monthKey,
          monthShort: shortName,
          feesNet: byYm.get(monthKey) ?? 0,
        };
      });
      const yearToDateTotal = Math.round(months.reduce((acc, m) => acc + m.feesNet, 0) * 100) / 100;
      return { months, yearToDateTotal };
    } finally {
      db.close();
    }
  }

  getCashReceivedSummary(): import('./types').PmsCashReceivedSummary {
    const db = this.openDb();
    try {
      const octRow = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(amount), 0), 2) AS total, COUNT(*) AS cnt
           FROM payments
           WHERE substr(receipt_date, 1, 7) = '2026-10'`
        )
        .get() as Record<string, unknown> | undefined;

      const sepRow = db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(amount), 0), 2) AS total, COUNT(*) AS cnt
           FROM payments
           WHERE substr(receipt_date, 1, 7) = '2026-09'`
        )
        .get() as Record<string, unknown> | undefined;

      return {
        octoberTotal: num(octRow?.total),
        octoberReceiptCount: num(octRow?.cnt),
        septemberTotal: num(sepRow?.total),
        septemberReceiptCount: num(sepRow?.cnt),
      };
    } finally {
      db.close();
    }
  }

  getDepartmentFinancials(): {
    departments: import('./types').PmsDepartmentFinancials[];
    firmTotal: import('./types').PmsDepartmentFinancials;
  } {
    const db = this.openDb();
    try {
      const deptRows = db
        .prepare(
          `SELECT
             m.practice_area,
             SUM(CASE WHEN m.status = 'Open' THEN 1 ELSE 0 END) AS open_matters,
             ROUND(COALESCE(SUM(m.fees_billed), 0), 2) AS billed_this_year,
             ROUND(COALESCE(SUM(m.unbilled_wip), 0), 2) AS unbilled_wip,
             ROUND(COALESCE(SUM(m.outstanding_debt), 0), 2) AS outstanding_debt,
             ROUND(COALESCE((
               SELECT SUM(inv.outstanding)
               FROM v_invoice_balances inv
               JOIN matters mat ON mat.matter_code = inv.matter_code
               WHERE mat.practice_area = m.practice_area
                 AND inv.days_past_due > 0
             ), 0), 2) AS overdue_debt,
             ROUND(COALESCE((
               SELECT SUM(t.hours)
               FROM time_entries t
               JOIN matters mat ON mat.matter_code = t.matter_code
               WHERE mat.practice_area = m.practice_area
                 AND t.chargeable = 'Y'
                 AND substr(t.date, 1, 7) = '2026-10'
             ), 0), 2) AS october_hours
           FROM v_matter_financials m
           GROUP BY m.practice_area
           ORDER BY billed_this_year DESC`
        )
        .all() as Record<string, unknown>[];

      const departments: import('./types').PmsDepartmentFinancials[] = deptRows.map((r) => ({
        practiceArea: String(r.practice_area),
        openMatters: num(r.open_matters),
        billedThisYear: num(r.billed_this_year),
        unbilledWip: num(r.unbilled_wip),
        outstandingDebt: num(r.outstanding_debt),
        overdueDebt: num(r.overdue_debt),
        octoberHours: num(r.october_hours),
      }));

      const firmTotal: import('./types').PmsDepartmentFinancials = {
        practiceArea: 'Firm total',
        openMatters: departments.reduce((s, d) => s + d.openMatters, 0),
        billedThisYear: Math.round(departments.reduce((s, d) => s + d.billedThisYear, 0) * 100) / 100,
        unbilledWip: Math.round(departments.reduce((s, d) => s + d.unbilledWip, 0) * 100) / 100,
        outstandingDebt: Math.round(departments.reduce((s, d) => s + d.outstandingDebt, 0) * 100) / 100,
        overdueDebt: Math.round(departments.reduce((s, d) => s + d.overdueDebt, 0) * 100) / 100,
        octoberHours: Math.round(departments.reduce((s, d) => s + d.octoberHours, 0) * 10) / 10,
      };

      return { departments, firmTotal };
    } finally {
      db.close();
    }
  }
}

let defaultPmsSourceInstance: PmsSource | null = null;

export function getPmsSource(customDbPath?: string): PmsSource {
  if (customDbPath) {
    return new DemoDbPmsSource(customDbPath);
  }
  if (!defaultPmsSourceInstance) {
    defaultPmsSourceInstance = new DemoDbPmsSource();
  }
  return defaultPmsSourceInstance;
}
