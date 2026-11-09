/**
 * Adapter layer (`PmsSource`) and its SQLite demo implementation (`DemoDbPmsSource`).
 * No UI component or server service queries the PMS database directly;
 * all reads go through `getPmsSource()`.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isValidPmsAsAtDate, PMS_AS_AT_UNAVAILABLE_LABEL } from '../domain/pms';
import {
  buildPmsDatabaseFromWorkbook,
  DEFAULT_PMS_DB_PATH,
} from './importPms';
import type {
  PmsAgeBucket,
  PmsClient,
  PmsClientAccountEntry,
  PmsDisbursement,
  PmsExtractInfo,
  PmsFeeEarner,
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
      const rawAsAt = row?.as_at_date ? String(row.as_at_date).trim() : '';
      if (!isValidPmsAsAtDate(rawAsAt)) {
        return {
          asAtDate: '',
          importedAt: row?.imported_at ? String(row.imported_at) : '',
          sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
        };
      }
      return {
        asAtDate: rawAsAt,
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

  listAllTimeEntries(): PmsTimeEntry[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`
          SELECT
            te.*,
            (fe.first_name || ' ' || fe.last_name) AS fee_earner_name,
            fe.initials AS fee_earner_initials
          FROM time_entries te
          JOIN fee_earners fe ON fe.fee_earner_id = te.fee_earner_id
          ORDER BY te.date DESC, te.time_id DESC
        `)
        .all() as Record<string, unknown>[];
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

  getInvoiceBalance(invoiceNumber: string): PmsInvoiceBalance | null {
    const db = this.openDb();
    try {
      const row = db
        .prepare(`SELECT * FROM v_invoice_balances WHERE invoice_number = ?`)
        .get(invoiceNumber) as Record<string, unknown> | undefined;
      return row ? this.mapInvoiceBalance(row) : null;
    } finally {
      db.close();
    }
  }

  listAllInvoiceBalances(): PmsInvoiceBalance[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(
          `SELECT * FROM v_invoice_balances ORDER BY invoice_date DESC, invoice_number DESC`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => this.mapInvoiceBalance(r));
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

  listAllPayments(): PmsPayment[] {
    const db = this.openDb();
    try {
      const rows = db
        .prepare(`SELECT * FROM payments ORDER BY receipt_date ASC, receipt_id ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((p) => ({
        receipt_id: String(p.receipt_id),
        invoice_number: String(p.invoice_number),
        matter_code: String(p.matter_code),
        client_code: String(p.client_code),
        receipt_date: String(p.receipt_date),
        amount: round2(Number(p.amount)),
        method: String(p.method),
        reference: String(p.reference),
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
