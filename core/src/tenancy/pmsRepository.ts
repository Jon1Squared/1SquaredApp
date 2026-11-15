/**
 * Tenant-Scoped Practice Management System (PMS) Repository (`core/src/tenancy/pmsRepository.ts`).
 *
 * Enforces ADR 0028 & Slice S0-18 (`R401`, `R402`, `R403`, `R460`, `R319`, `R358`):
 * - Stores all PMS links and read-only PMS financial dataset rows in per-tenant PostgreSQL tables
 *   (`pms_links`, `pms_extract_metadata`, `pms_fee_earners`, `pms_clients`, `pms_matters`,
 *   `pms_matter_financials`, `pms_fee_estimates`, `pms_invoices`, `pms_payments`, `pms_time_entries`,
 *   `pms_disbursements`, `pms_client_account_entries`, and `pms_credit_control_log`).
 * - Every read and write executes inside `withTenantReadTransaction` or `withTenantTransaction`
 *   (`SET LOCAL ROLE`) and verifies `assertRowTenant` on returned rows.
 * - Fails closed when `pms_extract_metadata.as_at_date` is missing or invalid (`R319`, `R358`).
 */

import type { TenantContext } from '../api/index';
import {
  TenantScopedRepository,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const PMS_AS_AT_UNAVAILABLE_SENTINEL = 'PMS as-at date unavailable';

const ISO_DATE_STRICT_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTenantPmsAsAtDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!ISO_DATE_STRICT_RE.test(trimmed)) return false;
  const [yStr, mStr, dStr] = trimmed.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function daysBetweenIsoDates(laterIso: string, earlierIso: string): number {
  const t1 = Date.parse(`${laterIso.slice(0, 10)}T00:00:00Z`);
  const t2 = Date.parse(`${earlierIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.trunc((t1 - t2) / 86_400_000);
}

function safePgTimestampIso(val: unknown): string {
  if (typeof val === 'string' && val.trim()) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString();
  }
  return new Date().toISOString();
}

export type TenantPmsEntityType =
  | 'organisation'
  | 'person'
  | 'employee'
  | 'matter';

export type TenantPmsMatchedBy =
  | 'auto_company_number'
  | 'auto_email'
  | 'seed'
  | 'manual';

export interface TenantPmsLinkRecord {
  id: string;
  entityType: TenantPmsEntityType;
  onesquaredId: string;
  pmsCode: string;
  matchedBy: TenantPmsMatchedBy;
  matchedAt: string;
  matchedByUserId?: string | null;
  syncDirection?: 'inbound' | 'outbound' | 'bidirectional';
  syncStatus?: 'Synced' | 'Pending' | 'Failed';
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}

export interface TenantPmsExtractInfo {
  asAtDate: string;
  importedAt: string;
  sourceFile: string;
}

export interface TenantPmsFeeEarner {
  fee_earner_id: string;
  initials: string;
  first_name: string;
  last_name: string;
  email: string;
  grade: string;
  department: string;
  standard_hourly_rate: number;
  annual_target_hours: number;
  annual_target_fees: number;
  active: string;
}

export interface TenantPmsClient {
  client_code: string;
  client_name: string;
  client_type: 'Organisation' | 'Individual';
  company_number: string;
  email: string;
  phone: string;
  billing_address: string;
  postcode: string;
  client_partner_id: string;
  credit_terms_days: number;
  credit_limit: number;
  rate_discount_pct: number;
  date_opened: string;
  sector: string;
  crm_match_on: 'company_number' | 'email';
  status: string;
}

export interface TenantPmsMatter {
  matter_code: string;
  client_code: string;
  matter_description: string;
  work_type: string;
  practice_area: string;
  responsible_partner_id: string;
  fee_earner_id: string;
  billing_basis:
    | 'Hourly Rate'
    | 'Fixed Fee'
    | 'Capped Fee'
    | 'Retainer / Subscription';
  fixed_fee_amount: number;
  fee_estimate: number;
  estimate_alert_pct: number;
  date_opened: string;
  date_closed: string | null;
  status: 'Pending' | 'Open' | 'Closed';
  billing_frequency: string;
  client_reference: string;
  third_party_payer: string;
}

export interface TenantPmsFeeEstimate {
  estimate_id: string;
  matter_code: string;
  date_given: string;
  estimate_type: 'Initial' | 'Revised';
  fees_estimate: number;
  disbursements_estimate: number;
  given_by: string;
  given_by_name?: string;
  accepted_by_client: 'Yes' | 'No' | 'Pending';
  notes: string;
}

export interface TenantPmsTimeEntry {
  time_id: string;
  matter_code: string;
  fee_earner_id: string;
  fee_earner_name?: string;
  fee_earner_initials?: string;
  date: string;
  activity: string;
  narrative: string;
  minutes: number;
  units: number;
  hours: number;
  rate: number;
  value: number;
  chargeable: 'Y' | 'N';
  billed_status: 'Unbilled' | 'Billed' | 'Written off' | 'Non-chargeable';
  invoice_number: string | null;
  billed_value: number;
  write_off_value: number;
}

export interface TenantPmsDisbursement {
  disbursement_id: string;
  matter_code: string;
  date: string;
  type: string;
  supplier: string;
  description: string;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  paid_from: 'Office' | 'Client account';
  billed_status: 'Unbilled' | 'Billed';
  invoice_number: string | null;
}

export type TenantPmsRecalculatedInvoiceStatus =
  | 'Paid'
  | 'Part paid'
  | 'Unpaid'
  | 'Overdue'
  | 'Applied';

export type TenantPmsAgeBucket =
  | 'Settled'
  | 'Not yet due'
  | '1-30'
  | '31-60'
  | '61-90'
  | '90+';

export interface TenantPmsPayment {
  receipt_id: string;
  invoice_number: string;
  matter_code: string;
  client_code: string;
  receipt_date: string;
  amount: number;
  method: string;
  reference: string;
}

export interface TenantPmsInvoiceRow {
  invoice_number: string;
  matter_code: string;
  client_code: string;
  invoice_date: string;
  due_date: string;
  invoice_type: string;
  period_from: string | null;
  period_to: string | null;
  fees_net: number;
  disbursements_net: number;
  vat: number;
  total: number;
  status: string;
  credit_note_for: string | null;
}

export interface TenantPmsInvoiceBalance {
  invoice_number: string;
  matter_code: string;
  client_code: string;
  invoice_date: string;
  due_date: string;
  invoice_type: string;
  period_from: string | null;
  period_to: string | null;
  fees_net: number;
  disbursements_net: number;
  vat: number;
  total: number;
  exported_status: string;
  credit_note_for: string | null;
  paid: number;
  credit_notes: number;
  outstanding: number;
  days_past_due: number | null;
  age_bucket: TenantPmsAgeBucket;
  recalculated_status: TenantPmsRecalculatedInvoiceStatus;
}

export interface TenantPmsInvoiceDetail extends TenantPmsInvoiceBalance {
  payments: TenantPmsPayment[];
  timeEntries: TenantPmsTimeEntry[];
  disbursements: TenantPmsDisbursement[];
  appliedCreditNotes: TenantPmsInvoiceBalance[];
}

export interface TenantPmsClientAccountEntry {
  transaction_id: string;
  matter_code: string;
  client_code: string;
  date: string;
  type: 'Receipt' | 'Payment' | 'Transfer to office';
  description: string;
  amount: number;
  running_balance: number;
}

export interface TenantPmsMatterFinancials {
  matter_code: string;
  client_code: string;
  client_name: string;
  matter_description: string;
  work_type: string;
  practice_area: string;
  responsible_partner_id: string;
  responsible_partner_name: string;
  fee_earner_id: string;
  fee_earner_name: string;
  billing_basis:
    | 'Hourly Rate'
    | 'Fixed Fee'
    | 'Capped Fee'
    | 'Retainer / Subscription';
  fixed_fee_amount: number;
  estimate_alert_pct: number;
  date_opened: string;
  date_closed: string | null;
  status: 'Pending' | 'Open' | 'Closed';
  billing_frequency: string;
  client_reference: string;
  third_party_payer: string;
  fee_estimate: number;
  time_value_recorded: number;
  unbilled_wip: number;
  fees_billed: number;
  disbursements_billed: number;
  total_invoiced_inc_vat: number;
  total_paid: number;
  outstanding_debt: number;
  unbilled_disbursements: number;
  estimate_used_pct: number;
  written_off: number;
  client_account_balance: number;
  has_pending_estimate_revision: boolean;
  oldest_unbilled_wip_days: number | null;
  max_invoice_days_past_due: number | null;
}

export interface TenantPmsMatterWipBreakdown {
  byFeeEarner: {
    fee_earner_id: string;
    name: string;
    initials: string;
    grade: string;
    hours: number;
    wip_value: number;
  }[];
  byAgeBucket: {
    bucket_0_30: number;
    bucket_31_60: number;
    bucket_61_90: number;
    bucket_90_plus: number;
  };
}

export interface TenantPmsTimeEntryFilters {
  feeEarnerId?: string;
  billedStatus?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface TenantPmsMatterFullBundle {
  extractInfo: TenantPmsExtractInfo;
  summary: TenantPmsMatterFinancials;
  estimates: TenantPmsFeeEstimate[];
  timeEntries: TenantPmsTimeEntry[];
  wipBreakdown: TenantPmsMatterWipBreakdown;
  invoices: TenantPmsInvoiceDetail[];
  disbursements: TenantPmsDisbursement[];
  clientAccount: TenantPmsClientAccountEntry[];
}

export interface TenantPmsCreditControlLogEntry {
  id: number;
  tenantId: string;
  invoiceNumber: string;
  matterCode: string;
  actionType: string;
  notes: string;
  actorName: string;
  createdAt: string;
}

export interface TenantPmsExtractDataset {
  extractInfo: TenantPmsExtractInfo;
  feeEarners: readonly TenantPmsFeeEarner[];
  clients: readonly TenantPmsClient[];
  matters: readonly TenantPmsMatter[];
  feeEstimates: readonly TenantPmsFeeEstimate[];
  invoices: readonly TenantPmsInvoiceRow[];
  timeEntries: readonly TenantPmsTimeEntry[];
  disbursements: readonly TenantPmsDisbursement[];
  payments: readonly TenantPmsPayment[];
  clientAccount: readonly Omit<
    TenantPmsClientAccountEntry,
    'running_balance'
  >[];
}

export interface HydratedTenantPmsSnapshot {
  readonly tenantId: string;
  readonly databaseName: string;
  readonly extractInfo: TenantPmsExtractInfo;
  readonly pmsLinks: TenantPmsLinkRecord[];
  readonly feeEarners: TenantPmsFeeEarner[];
  readonly clients: TenantPmsClient[];
  readonly matters: TenantPmsMatter[];
  readonly matterFinancials: TenantPmsMatterFinancials[];
  readonly feeEstimates: TenantPmsFeeEstimate[];
  readonly invoices: TenantPmsInvoiceRow[];
  readonly invoiceBalances: TenantPmsInvoiceBalance[];
  readonly payments: TenantPmsPayment[];
  readonly timeEntries: TenantPmsTimeEntry[];
  readonly disbursements: TenantPmsDisbursement[];
  readonly clientAccount: TenantPmsClientAccountEntry[];
  readonly creditControlLog: TenantPmsCreditControlLogEntry[];
}

interface DbPmsLinkRow {
  tenant_id: string;
  id: string;
  entity_type: string;
  onesquared_id: string;
  pms_code: string;
  match_status: string;
  confidence: string;
  match_reason: string;
  linked_at: string | Date;
  linked_by_id: string | null;
  last_synced_at: string | Date | null;
  payload_json: Record<string, unknown> | null;
}

interface DbPmsExtractMetadataRow {
  tenant_id: string;
  as_at_date: string;
  source_name: string;
  imported_at: string | Date;
  metadata_json: Record<string, unknown> | null;
}

interface DbGenericPayloadRow {
  tenant_id: string;
  payload_json: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface DbCreditControlLogRow {
  tenant_id: string;
  id: string | number;
  invoice_number: string;
  matter_code: string;
  action_type: string;
  notes: string;
  actor_name: string;
  created_at: string | Date;
}

function mapPmsLinkRow<TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord>(
  row: DbPmsLinkRow,
): TLink {
  const payload =
    row.payload_json && typeof row.payload_json === 'object'
      ? structuredClone(row.payload_json)
      : {};
  const linkedAtIso =
    row.linked_at instanceof Date
      ? row.linked_at.toISOString()
      : String(row.linked_at);
  const lastSyncedIso = row.last_synced_at
    ? row.last_synced_at instanceof Date
      ? row.last_synced_at.toISOString()
      : String(row.last_synced_at)
    : (payload.lastSyncedAt as string | null | undefined) ?? null;

  return {
    ...payload,
    id: row.id,
    entityType: row.entity_type as TenantPmsEntityType,
    onesquaredId: row.onesquared_id,
    pmsCode: row.pms_code,
    matchedBy: (row.match_reason ||
      payload.matchedBy ||
      'manual') as TenantPmsMatchedBy,
    matchedAt: (payload.matchedAt as string | undefined) ?? linkedAtIso,
    ...(row.linked_by_id !== null || payload.matchedByUserId !== undefined
      ? {
          matchedByUserId:
            row.linked_by_id ??
            (payload.matchedByUserId as string | null | undefined) ??
            null,
        }
      : {}),
    ...(payload.syncDirection !== undefined
      ? {
          syncDirection:
            payload.syncDirection as TenantPmsLinkRecord['syncDirection'],
        }
      : {}),
    ...(payload.syncStatus !== undefined || row.match_status
      ? {
          syncStatus: ((payload.syncStatus as string | undefined) ||
            row.match_status) as TenantPmsLinkRecord['syncStatus'],
        }
      : {}),
    ...(lastSyncedIso !== null || payload.lastSyncedAt !== undefined
      ? { lastSyncedAt: lastSyncedIso }
      : {}),
  } as TLink;
}

export function computeDerivedInvoiceBalances(params: {
  asAtDate: string;
  invoices: readonly TenantPmsInvoiceRow[];
  payments: readonly TenantPmsPayment[];
}): TenantPmsInvoiceBalance[] {
  const validAsAt = isValidTenantPmsAsAtDate(params.asAtDate)
    ? params.asAtDate.trim()
    : '';
  const paidPenceByInv = new Map<string, number>();
  for (const p of params.payments) {
    paidPenceByInv.set(
      p.invoice_number,
      (paidPenceByInv.get(p.invoice_number) ?? 0) + Math.round(p.amount * 100),
    );
  }

  const cnPenceByInv = new Map<string, number>();
  for (const inv of params.invoices) {
    if (inv.credit_note_for && inv.credit_note_for.trim()) {
      const target = inv.credit_note_for.trim();
      cnPenceByInv.set(
        target,
        (cnPenceByInv.get(target) ?? 0) + Math.round(inv.total * 100),
      );
    }
  }

  const balances: TenantPmsInvoiceBalance[] = params.invoices.map((inv) => {
    const paid = round2((paidPenceByInv.get(inv.invoice_number) ?? 0) / 100);
    const creditNotes = round2(
      (cnPenceByInv.get(inv.invoice_number) ?? 0) / 100,
    );
    const isCreditNote = inv.invoice_type === 'Credit note';
    const outstanding = isCreditNote
      ? 0
      : round2(
          (Math.round(inv.total * 100) -
            Math.round(paid * 100) +
            Math.round(creditNotes * 100)) /
            100,
        );

    const diffDays = validAsAt
      ? daysBetweenIsoDates(validAsAt, inv.due_date)
      : 0;
    const daysPastDue =
      isCreditNote || outstanding <= 0.005 || !validAsAt
        ? null
        : diffDays < 0
          ? 0
          : diffDays;

    let ageBucket: TenantPmsAgeBucket;
    if (isCreditNote || outstanding <= 0.005) {
      ageBucket = 'Settled';
    } else if (diffDays <= 0) {
      ageBucket = 'Not yet due';
    } else if (diffDays <= 30) {
      ageBucket = '1-30';
    } else if (diffDays <= 60) {
      ageBucket = '31-60';
    } else if (diffDays <= 90) {
      ageBucket = '61-90';
    } else {
      ageBucket = '90+';
    }

    let recalculatedStatus: TenantPmsRecalculatedInvoiceStatus;
    if (isCreditNote) {
      recalculatedStatus = 'Applied';
    } else if (outstanding <= 0.005) {
      recalculatedStatus = 'Paid';
    } else if (paid > 0.005) {
      recalculatedStatus = 'Part paid';
    } else if (diffDays > 0) {
      recalculatedStatus = 'Overdue';
    } else {
      recalculatedStatus = 'Unpaid';
    }

    return {
      invoice_number: inv.invoice_number,
      matter_code: inv.matter_code,
      client_code: inv.client_code,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      invoice_type: inv.invoice_type,
      period_from: inv.period_from ?? null,
      period_to: inv.period_to ?? null,
      fees_net: round2(inv.fees_net),
      disbursements_net: round2(inv.disbursements_net),
      vat: round2(inv.vat),
      total: round2(inv.total),
      exported_status: inv.status,
      credit_note_for: inv.credit_note_for ?? null,
      paid,
      credit_notes: creditNotes,
      outstanding,
      days_past_due: daysPastDue,
      age_bucket: ageBucket,
      recalculated_status: recalculatedStatus,
    };
  });

  balances.sort((a, b) => {
    const cmpDate = b.invoice_date.localeCompare(a.invoice_date);
    if (cmpDate !== 0) return cmpDate;
    return b.invoice_number.localeCompare(a.invoice_number);
  });

  return balances;
}

export function computeDerivedMatterFinancials(params: {
  asAtDate: string;
  feeEarners: readonly TenantPmsFeeEarner[];
  clients: readonly TenantPmsClient[];
  matters: readonly TenantPmsMatter[];
  feeEstimates: readonly TenantPmsFeeEstimate[];
  invoiceBalances: readonly TenantPmsInvoiceBalance[];
  timeEntries: readonly TenantPmsTimeEntry[];
  disbursements: readonly TenantPmsDisbursement[];
  clientAccount: readonly Pick<
    TenantPmsClientAccountEntry,
    'matter_code' | 'amount'
  >[];
}): TenantPmsMatterFinancials[] {
  const validAsAt = isValidTenantPmsAsAtDate(params.asAtDate)
    ? params.asAtDate.trim()
    : '';
  const feById = new Map(params.feeEarners.map((f) => [f.fee_earner_id, f]));
  const clientByCode = new Map(params.clients.map((c) => [c.client_code, c]));

  const estimatesByMatter = new Map<string, TenantPmsFeeEstimate[]>();
  for (const est of params.feeEstimates) {
    const list = estimatesByMatter.get(est.matter_code) ?? [];
    list.push(est);
    estimatesByMatter.set(est.matter_code, list);
  }

  const timeByMatter = new Map<string, TenantPmsTimeEntry[]>();
  for (const te of params.timeEntries) {
    const list = timeByMatter.get(te.matter_code) ?? [];
    list.push(te);
    timeByMatter.set(te.matter_code, list);
  }

  const invByMatter = new Map<string, TenantPmsInvoiceBalance[]>();
  for (const ib of params.invoiceBalances) {
    const list = invByMatter.get(ib.matter_code) ?? [];
    list.push(ib);
    invByMatter.set(ib.matter_code, list);
  }

  const disbByMatter = new Map<string, TenantPmsDisbursement[]>();
  for (const d of params.disbursements) {
    const list = disbByMatter.get(d.matter_code) ?? [];
    list.push(d);
    disbByMatter.set(d.matter_code, list);
  }

  const caPenceByMatter = new Map<string, number>();
  for (const ca of params.clientAccount) {
    caPenceByMatter.set(
      ca.matter_code,
      (caPenceByMatter.get(ca.matter_code) ?? 0) + Math.round(ca.amount * 100),
    );
  }

  const sortedMatters = [...params.matters].sort((a, b) =>
    a.matter_code.localeCompare(b.matter_code),
  );

  return sortedMatters.map((m) => {
    const client = clientByCode.get(m.client_code);
    const rp = feById.get(m.responsible_partner_id);
    const fe = feById.get(m.fee_earner_id);

    const mEstimates = [...(estimatesByMatter.get(m.matter_code) ?? [])].sort(
      (a, b) => {
        const cmpDate = b.date_given.localeCompare(a.date_given);
        if (cmpDate !== 0) return cmpDate;
        return b.estimate_id.localeCompare(a.estimate_id);
      },
    );
    const latestEst = mEstimates[0];
    const feeEstimate = round2(
      latestEst ? latestEst.fees_estimate : m.fee_estimate,
    );
    const hasPendingRevision = mEstimates.some(
      (e) => e.accepted_by_client === 'Pending',
    );

    const mTimes = timeByMatter.get(m.matter_code) ?? [];
    let timeRecordedPence = 0;
    let unbilledWipPence = 0;
    let writtenOffPence = 0;
    let oldestUnbilledWipDays: number | null = null;

    for (const te of mTimes) {
      timeRecordedPence += Math.round(te.value * 100);
      writtenOffPence += Math.round(te.write_off_value * 100);
      if (te.billed_status === 'Unbilled') {
        unbilledWipPence += Math.round(te.value * 100);
        if (te.value > 0 && validAsAt) {
          const age = daysBetweenIsoDates(validAsAt, te.date);
          if (oldestUnbilledWipDays === null || age > oldestUnbilledWipDays) {
            oldestUnbilledWipDays = age;
          }
        }
      }
    }

    const timeValueRecorded = round2(timeRecordedPence / 100);
    const unbilledWip = round2(unbilledWipPence / 100);
    const writtenOff = round2(writtenOffPence / 100);

    const mInvoices = invByMatter.get(m.matter_code) ?? [];
    let feesBilledPence = 0;
    let disbBilledPence = 0;
    let totalInvoicedPence = 0;
    let totalPaidPence = 0;
    let maxInvoiceDaysPastDue: number | null = null;

    for (const ib of mInvoices) {
      feesBilledPence += Math.round(ib.fees_net * 100);
      disbBilledPence += Math.round(ib.disbursements_net * 100);
      totalInvoicedPence += Math.round(ib.total * 100);
      totalPaidPence += Math.round(ib.paid * 100);
      if (ib.outstanding > 0.005 && ib.days_past_due !== null) {
        if (
          maxInvoiceDaysPastDue === null ||
          ib.days_past_due > maxInvoiceDaysPastDue
        ) {
          maxInvoiceDaysPastDue = ib.days_past_due;
        }
      }
    }

    const feesBilled = round2(feesBilledPence / 100);
    const disbursementsBilled = round2(disbBilledPence / 100);
    const totalInvoicedIncVat = round2(totalInvoicedPence / 100);
    const totalPaid = round2(totalPaidPence / 100);
    const outstandingDebt = round2(
      (Math.round(totalInvoicedIncVat * 100) - Math.round(totalPaid * 100)) /
        100,
    );

    const mDisbs = disbByMatter.get(m.matter_code) ?? [];
    let unbilledDisbPence = 0;
    for (const d of mDisbs) {
      if (d.billed_status === 'Unbilled') {
        unbilledDisbPence += Math.round(d.net_amount * 100);
      }
    }
    const unbilledDisbursements = round2(unbilledDisbPence / 100);
    const clientAccountBalance = round2(
      (caPenceByMatter.get(m.matter_code) ?? 0) / 100,
    );
    const estimateUsedPct =
      feeEstimate > 0 ? (feesBilled + unbilledWip) / feeEstimate : 0;

    return {
      matter_code: m.matter_code,
      client_code: m.client_code,
      client_name: client?.client_name ?? '',
      matter_description: m.matter_description,
      work_type: m.work_type,
      practice_area: m.practice_area,
      responsible_partner_id: m.responsible_partner_id,
      responsible_partner_name: rp ? `${rp.first_name} ${rp.last_name}` : '',
      fee_earner_id: m.fee_earner_id,
      fee_earner_name: fe ? `${fe.first_name} ${fe.last_name}` : '',
      billing_basis: m.billing_basis,
      fixed_fee_amount: round2(m.fixed_fee_amount),
      estimate_alert_pct: Number(m.estimate_alert_pct ?? 0.75),
      date_opened: m.date_opened,
      date_closed: m.date_closed ?? null,
      status: m.status,
      billing_frequency: m.billing_frequency ?? '',
      client_reference: m.client_reference ?? '',
      third_party_payer: m.third_party_payer ?? '',
      fee_estimate: feeEstimate,
      time_value_recorded: timeValueRecorded,
      unbilled_wip: unbilledWip,
      fees_billed: feesBilled,
      disbursements_billed: disbursementsBilled,
      total_invoiced_inc_vat: totalInvoicedIncVat,
      total_paid: totalPaid,
      outstanding_debt: outstandingDebt,
      unbilled_disbursements: unbilledDisbursements,
      estimate_used_pct: estimateUsedPct,
      written_off: writtenOff,
      client_account_balance: clientAccountBalance,
      has_pending_estimate_revision: hasPendingRevision,
      oldest_unbilled_wip_days: oldestUnbilledWipDays,
      max_invoice_days_past_due: maxInvoiceDaysPastDue,
    };
  });
}

export function computeDerivedMatterWipBreakdown(params: {
  matterCode: string;
  asAtDate: string;
  feeEarners: readonly TenantPmsFeeEarner[];
  timeEntries: readonly TenantPmsTimeEntry[];
}): TenantPmsMatterWipBreakdown {
  const validAsAt = isValidTenantPmsAsAtDate(params.asAtDate)
    ? params.asAtDate.trim()
    : '';
  const feById = new Map(params.feeEarners.map((f) => [f.fee_earner_id, f]));

  const feAgg = new Map<
    string,
    {
      fee_earner_id: string;
      name: string;
      initials: string;
      grade: string;
      hoursHund: number;
      wipPence: number;
    }
  >();

  let bucket0_30Pence = 0;
  let bucket31_60Pence = 0;
  let bucket61_90Pence = 0;
  let bucket90PlusPence = 0;

  for (const te of params.timeEntries) {
    if (te.matter_code !== params.matterCode || te.billed_status !== 'Unbilled') {
      continue;
    }
    const fe = feById.get(te.fee_earner_id);
    const existing = feAgg.get(te.fee_earner_id) ?? {
      fee_earner_id: te.fee_earner_id,
      name: fe ? `${fe.first_name} ${fe.last_name}` : te.fee_earner_name ?? '',
      initials: fe?.initials ?? te.fee_earner_initials ?? '',
      grade: fe?.grade ?? '',
      hoursHund: 0,
      wipPence: 0,
    };
    existing.hoursHund += Math.round(te.hours * 100);
    existing.wipPence += Math.round(te.value * 100);
    feAgg.set(te.fee_earner_id, existing);

    const valPence = Math.round(te.value * 100);
    const ageDays = validAsAt ? daysBetweenIsoDates(validAsAt, te.date) : 0;
    if (ageDays <= 30) {
      bucket0_30Pence += valPence;
    } else if (ageDays <= 60) {
      bucket31_60Pence += valPence;
    } else if (ageDays <= 90) {
      bucket61_90Pence += valPence;
    } else {
      bucket90PlusPence += valPence;
    }
  }

  const byFeeEarner = Array.from(feAgg.values())
    .map((item) => ({
      fee_earner_id: item.fee_earner_id,
      name: item.name,
      initials: item.initials,
      grade: item.grade,
      hours: round2(item.hoursHund / 100),
      wip_value: round2(item.wipPence / 100),
    }))
    .sort((a, b) => {
      if (b.wip_value !== a.wip_value) return b.wip_value - a.wip_value;
      return a.fee_earner_id.localeCompare(b.fee_earner_id);
    });

  return {
    byFeeEarner,
    byAgeBucket: {
      bucket_0_30: round2(bucket0_30Pence / 100),
      bucket_31_60: round2(bucket31_60Pence / 100),
      bucket_61_90: round2(bucket61_90Pence / 100),
      bucket_90_plus: round2(bucket90PlusPence / 100),
    },
  };
}

export class TenantPmsRepository extends TenantScopedRepository {
  // ============================================================================
  // PMS Link Sequence Allocation & CRUD (`pms_links`)
  // ============================================================================

  public async allocatePmsLinkIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<string> {
    const seqRes = await tx.query<{ next_val: string }>(
      `SELECT nextval('public.tenant_pms_link_id_seq')::text AS next_val`,
    );
    const seqVal = Number.parseInt(seqRes.rows[0]?.next_val ?? '1', 10);
    const rowRes = await tx.query<{ tenant_id: string; last_value: string }>(
      `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
       VALUES ($1, 'PMSL', $2::bigint)
       ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
         last_value = GREATEST(
           public.tenant_record_sequences.last_value + 1,
           EXCLUDED.last_value
         )
       RETURNING tenant_id, last_value::text AS last_value`,
      [ctx.tenantId, seqVal],
    );
    const row = rowRes.rows[0];
    if (!row) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Could not allocate PMS link sequence.',
      );
    }
    this.assertRowTenant(ctx, row.tenant_id, 'tenant_record_sequences.PMSL');
    const num = Number.parseInt(row.last_value, 10);
    return `PMSL-${String(num).padStart(6, '0')}`;
  }

  public async allocatePmsLinkId(ctx: TenantContext): Promise<string> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocatePmsLinkIdInTx(tx, ctx),
    );
  }

  public async upsertPmsLinkInTx<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(tx: TenantSqlClient, ctx: TenantContext, link: TLink): Promise<TLink> {
    if (!link?.id?.trim()) {
      throw new Error('PMS_LINK_VALIDATION_ERROR: PMS link id is required.');
    }
    if (!link?.entityType?.trim()) {
      throw new Error(
        'PMS_LINK_VALIDATION_ERROR: PMS link entityType is required.',
      );
    }
    if (!link?.onesquaredId?.trim()) {
      throw new Error(
        'PMS_LINK_VALIDATION_ERROR: PMS link onesquaredId is required.',
      );
    }
    if (!link?.pmsCode?.trim()) {
      throw new Error(
        'PMS_LINK_VALIDATION_ERROR: PMS link pmsCode is required.',
      );
    }

    // Remove any superseded row for the same (entity_type, onesquared_id) or (entity_type, pms_code)
    await tx.query(
      `DELETE FROM public.pms_links
       WHERE tenant_id = $1
         AND entity_type = $2
         AND id <> $3
         AND (onesquared_id = $4 OR pms_code = $5)`,
      [
        ctx.tenantId,
        link.entityType,
        link.id,
        link.onesquaredId,
        link.pmsCode,
      ],
    );

    const linkedAtIso = safePgTimestampIso(link.matchedAt);
    const lastSyncedIso = link.lastSyncedAt
      ? safePgTimestampIso(link.lastSyncedAt)
      : null;
    const matchStatus = link.syncStatus ?? 'Synced';
    const confidence =
      link.matchedBy === 'manual' || link.matchedBy === 'seed'
        ? 'exact'
        : 'high';
    const matchReason = link.matchedBy ?? 'manual';

    const res = await tx.query<DbPmsLinkRow>(
      `INSERT INTO public.pms_links (
         tenant_id, id, entity_type, onesquared_id, pms_code,
         match_status, confidence, match_reason,
         linked_at, linked_by_id, last_synced_at, payload_json
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9::timestamptz, $10, $11::timestamptz, $12::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         onesquared_id = EXCLUDED.onesquared_id,
         pms_code = EXCLUDED.pms_code,
         match_status = EXCLUDED.match_status,
         confidence = EXCLUDED.confidence,
         match_reason = EXCLUDED.match_reason,
         linked_at = EXCLUDED.linked_at,
         linked_by_id = EXCLUDED.linked_by_id,
         last_synced_at = EXCLUDED.last_synced_at,
         payload_json = EXCLUDED.payload_json
       RETURNING *`,
      [
        ctx.tenantId,
        link.id,
        link.entityType,
        link.onesquaredId,
        link.pmsCode,
        matchStatus,
        confidence,
        matchReason,
        linkedAtIso,
        link.matchedByUserId ?? null,
        lastSyncedIso,
        JSON.stringify(link),
      ],
    );
    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: PMS link row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'pms_links');

    const match = /^PMSL-(\d+)$/.exec(link.id);
    if (match?.[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'PMSL', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, n],
        );
      }
    }

    return mapPmsLinkRow<TLink>(saved);
  }

  public async putPmsLink<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(ctx: TenantContext, link: TLink): Promise<TLink> {
    const saved = await this.withTenantTransaction(ctx, async (tx) => {
      return this.upsertPmsLinkInTx<TLink>(tx, ctx, link);
    });
    return saved;
  }

  public async putPmsLinks<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(
    ctx: TenantContext,
    links: readonly TLink[],
    options?: { replaceAll?: boolean },
  ): Promise<TLink[]> {
    return this.withTenantTransaction(ctx, async (tx) => {
      if (options?.replaceAll) {
        if (links.length === 0) {
          await tx.query('DELETE FROM public.pms_links WHERE tenant_id = $1', [
            ctx.tenantId,
          ]);
          return [];
        }
        const keepIds = links.map((l) => l.id);
        await tx.query(
          'DELETE FROM public.pms_links WHERE tenant_id = $1 AND NOT (id = ANY($2::text[]))',
          [ctx.tenantId, keepIds],
        );
      }
      const out: TLink[] = [];
      for (const link of links) {
        out.push(await this.upsertPmsLinkInTx<TLink>(tx, ctx, link));
      }
      return out;
    });
  }

  public async getPmsLinkById<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(ctx: TenantContext, id: string): Promise<TLink | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPmsLinkRow>(
        'SELECT * FROM public.pms_links WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'pms_links');
      return mapPmsLinkRow<TLink>(row);
    });
  }

  public async listPmsLinks<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(ctx: TenantContext): Promise<TLink[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      return this.listPmsLinksInTx<TLink>(tx, ctx);
    });
  }

  private async listPmsLinksInTx<
    TLink extends TenantPmsLinkRecord = TenantPmsLinkRecord,
  >(tx: TenantSqlClient, ctx: TenantContext): Promise<TLink[]> {
    const res = await tx.query<DbPmsLinkRow>(
      'SELECT * FROM public.pms_links WHERE tenant_id = $1 ORDER BY id ASC',
      [ctx.tenantId],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_links');
      return mapPmsLinkRow<TLink>(row);
    });
  }

  public async deletePmsLinkById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.pms_links WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // PMS Extract Metadata (`pms_extract_metadata`)
  // ============================================================================

  private async getExtractInfoInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<TenantPmsExtractInfo> {
    const res = await tx.query<DbPmsExtractMetadataRow>(
      'SELECT * FROM public.pms_extract_metadata WHERE tenant_id = $1 LIMIT 1',
      [ctx.tenantId],
    );
    const row = res.rows[0];
    if (!row) {
      return {
        asAtDate: '',
        importedAt: '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_SENTINEL,
      };
    }
    this.assertRowTenant(ctx, row.tenant_id, 'pms_extract_metadata');
    const rawAsAt = row.as_at_date ? String(row.as_at_date).trim() : '';
    const importedAt =
      row.imported_at instanceof Date
        ? row.imported_at.toISOString()
        : String(row.imported_at ?? '');
    if (!isValidTenantPmsAsAtDate(rawAsAt)) {
      return {
        asAtDate: '',
        importedAt,
        sourceFile: PMS_AS_AT_UNAVAILABLE_SENTINEL,
      };
    }
    return {
      asAtDate: rawAsAt,
      importedAt,
      sourceFile: row.source_name || '1Squared_PMS_Demo_Data.xlsx',
    };
  }

  public async getExtractInfo(
    ctx: TenantContext,
  ): Promise<TenantPmsExtractInfo> {
    return this.withTenantReadTransaction(ctx, (tx) =>
      this.getExtractInfoInTx(tx, ctx),
    );
  }

  public async putExtractMetadata(
    ctx: TenantContext,
    info: TenantPmsExtractInfo,
  ): Promise<TenantPmsExtractInfo> {
    const trimmedAsAt = info?.asAtDate ? String(info.asAtDate).trim() : '';
    if (!isValidTenantPmsAsAtDate(trimmedAsAt)) {
      const err = new Error(
        `PMS_INVALID_AS_AT_DATE: Invalid or missing PMS extract as-at date "${trimmedAsAt}".`,
      ) as Error & { code: string };
      err.code = 'PMS_INVALID_AS_AT_DATE';
      throw err;
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      const importedIso = safePgTimestampIso(info.importedAt);
      const sourceName = info.sourceFile?.trim() || '1Squared_PMS_Demo_Data.xlsx';
      const res = await tx.query<DbPmsExtractMetadataRow>(
        `INSERT INTO public.pms_extract_metadata (
           tenant_id, as_at_date, source_name, imported_at, metadata_json
         ) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           as_at_date = EXCLUDED.as_at_date,
           source_name = EXCLUDED.source_name,
           imported_at = EXCLUDED.imported_at,
           metadata_json = EXCLUDED.metadata_json
         RETURNING *`,
        [
          ctx.tenantId,
          trimmedAsAt,
          sourceName,
          importedIso,
          JSON.stringify({
            asAtDate: trimmedAsAt,
            importedAt: importedIso,
            sourceFile: sourceName,
          }),
        ],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: PMS extract metadata row could not be persisted.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'pms_extract_metadata');
      return {
        asAtDate: trimmedAsAt,
        importedAt: importedIso,
        sourceFile: sourceName,
      };
    });
  }

  // ============================================================================
  // Credit Control Log (`pms_credit_control_log`)
  // ============================================================================

  public async recordCreditControlActionInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      invoiceNumber: string;
      matterCode: string;
      actionType: string;
      notes: string;
      actorName: string;
      createdAt?: string;
    },
  ): Promise<TenantPmsCreditControlLogEntry> {
    const createdAtIso = safePgTimestampIso(input.createdAt);
    const res = await tx.query<DbCreditControlLogRow>(
      `INSERT INTO public.pms_credit_control_log (
         tenant_id, invoice_number, matter_code, action_type, notes, actor_name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING *`,
      [
        ctx.tenantId,
        input.invoiceNumber,
        input.matterCode,
        input.actionType,
        input.notes,
        input.actorName,
        createdAtIso,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Credit control log row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, row.tenant_id, 'pms_credit_control_log');
    return {
      id: Number(row.id),
      tenantId: row.tenant_id,
      invoiceNumber: row.invoice_number,
      matterCode: row.matter_code,
      actionType: row.action_type,
      notes: row.notes,
      actorName: row.actor_name,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  }

  public async recordCreditControlAction(
    ctx: TenantContext,
    input: {
      invoiceNumber: string;
      matterCode: string;
      actionType: string;
      notes: string;
      actorName: string;
      createdAt?: string;
    },
  ): Promise<TenantPmsCreditControlLogEntry> {
    return this.withTenantTransaction(ctx, async (tx) => {
      return this.recordCreditControlActionInTx(tx, ctx, input);
    });
  }

  public async listCreditControlActions(
    ctx: TenantContext,
    filter?: { invoiceNumber?: string; matterCode?: string },
  ): Promise<TenantPmsCreditControlLogEntry[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.invoiceNumber) {
        values.push(filter.invoiceNumber);
        clauses.push(`invoice_number = $${values.length}`);
      }
      if (filter?.matterCode) {
        values.push(filter.matterCode);
        clauses.push(`matter_code = $${values.length}`);
      }
      const res = await tx.query<DbCreditControlLogRow>(
        `SELECT * FROM public.pms_credit_control_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY id DESC`,
        values,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'pms_credit_control_log');
        return {
          id: Number(row.id),
          tenantId: row.tenant_id,
          invoiceNumber: row.invoice_number,
          matterCode: row.matter_code,
          actionType: row.action_type,
          notes: row.notes,
          actorName: row.actor_name,
          createdAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : String(row.created_at),
        };
      });
    });
  }

  // ============================================================================
  // PMS Extract Dataset Import & Queries
  // ============================================================================

  private async batchInsertRowsInTx<T>(
    tx: TenantSqlClient,
    table: string,
    columns: readonly string[],
    items: readonly T[],
    mapRow: (item: T, index: number) => readonly unknown[],
    castByColIndex?: Readonly<Record<number, string>>,
    chunkSize = 200,
  ): Promise<void> {
    if (items.length === 0) return;
    const colsSql = columns.join(', ');
    for (let offset = 0; offset < items.length; offset += chunkSize) {
      const chunk = items.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const tuples: string[] = [];
      chunk.forEach((item, idx) => {
        const rowVals = mapRow(item, offset + idx);
        const placeholders = rowVals.map((val, colIdx) => {
          values.push(val);
          const cast = castByColIndex?.[colIdx] ?? '';
          return `$${values.length}${cast}`;
        });
        tuples.push(`(${placeholders.join(', ')})`);
      });
      await tx.query(
        `INSERT INTO public.${table} (${colsSql}) VALUES ${tuples.join(', ')}`,
        values,
      );
    }
  }

  public async importExtractDataset(
    ctx: TenantContext,
    dataset: TenantPmsExtractDataset,
  ): Promise<{
    asAtDate: string;
    importedAt: string;
    counts: {
      fee_earners: number;
      clients: number;
      matters: number;
      fee_estimates: number;
      time_entries: number;
      disbursements: number;
      invoices: number;
      payments: number;
      client_account: number;
    };
  }> {
    const asAtDate = dataset?.extractInfo?.asAtDate
      ? String(dataset.extractInfo.asAtDate).trim()
      : '';
    if (!isValidTenantPmsAsAtDate(asAtDate)) {
      const err = new Error(
        `PMS_INVALID_AS_AT_DATE: Invalid or missing PMS extract as-at date "${asAtDate}". Provide a valid YYYY-MM-DD via --as-at or in the workbook README sheet.`,
      ) as Error & { code: string };
      err.code = 'PMS_INVALID_AS_AT_DATE';
      throw err;
    }

    const importedAt = safePgTimestampIso(
      dataset.extractInfo.importedAt || `${asAtDate}T09:00:00.000Z`,
    );
    const sourceFile =
      dataset.extractInfo.sourceFile?.trim() || '1Squared_PMS_Demo_Data.xlsx';

    const invoiceBalances = computeDerivedInvoiceBalances({
      asAtDate,
      invoices: dataset.invoices,
      payments: dataset.payments,
    });
    const matterFinancials = computeDerivedMatterFinancials({
      asAtDate,
      feeEarners: dataset.feeEarners,
      clients: dataset.clients,
      matters: dataset.matters,
      feeEstimates: dataset.feeEstimates,
      invoiceBalances,
      timeEntries: dataset.timeEntries,
      disbursements: dataset.disbursements,
      clientAccount: dataset.clientAccount,
    });

    await this.withTenantTransaction(ctx, async (tx) => {
      // Clear previous extract rows for this tenant only
      for (const table of [
        'pms_client_account_entries',
        'pms_payments',
        'pms_disbursements',
        'pms_time_entries',
        'pms_invoices',
        'pms_fee_estimates',
        'pms_matter_financials',
        'pms_matters',
        'pms_clients',
        'pms_fee_earners',
        'pms_extract_metadata',
      ]) {
        await tx.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [
          ctx.tenantId,
        ]);
      }

      await tx.query(
        `INSERT INTO public.pms_extract_metadata (
           tenant_id, as_at_date, source_name, imported_at, metadata_json
         ) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)`,
        [
          ctx.tenantId,
          asAtDate,
          sourceFile,
          importedAt,
          JSON.stringify({ asAtDate, importedAt, sourceFile }),
        ],
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_fee_earners',
        [
          'tenant_id',
          'fee_earner_id',
          'name',
          'grade',
          'department',
          'office',
          'charge_out_rate',
          'status',
          'payload_json',
        ],
        dataset.feeEarners,
        (fe) => [
          ctx.tenantId,
          fe.fee_earner_id,
          `${fe.first_name} ${fe.last_name}`.trim(),
          fe.grade,
          fe.department,
          'London',
          round2(fe.standard_hourly_rate),
          fe.active || 'Yes',
          JSON.stringify(fe),
        ],
        { 8: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_clients',
        [
          'tenant_id',
          'client_code',
          'client_name',
          'client_type',
          'company_number',
          'payload_json',
        ],
        dataset.clients,
        (client) => [
          ctx.tenantId,
          client.client_code,
          client.client_name,
          client.client_type,
          client.company_number || null,
          JSON.stringify(client),
        ],
        { 5: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_matters',
        [
          'tenant_id',
          'matter_code',
          'client_code',
          'matter_description',
          'department',
          'work_type',
          'responsible_partner_id',
          'acting_fee_earner_id',
          'billing_basis',
          'fee_estimate',
          'matter_status',
          'open_date',
          'close_date',
          'payload_json',
        ],
        dataset.matters,
        (matter) => [
          ctx.tenantId,
          matter.matter_code,
          matter.client_code,
          matter.matter_description,
          matter.practice_area,
          matter.work_type,
          matter.responsible_partner_id,
          matter.fee_earner_id,
          matter.billing_basis,
          round2(matter.fee_estimate),
          matter.status,
          matter.date_opened || null,
          matter.date_closed || null,
          JSON.stringify(matter),
        ],
        { 13: '::jsonb' },
      );

      const wipHoursByMatter = new Map<string, number>();
      for (const te of dataset.timeEntries) {
        if (te.billed_status === 'Unbilled') {
          wipHoursByMatter.set(
            te.matter_code,
            (wipHoursByMatter.get(te.matter_code) ?? 0) +
              Math.round(te.hours * 100),
          );
        }
      }

      await this.batchInsertRowsInTx(
        tx,
        'pms_matter_financials',
        [
          'tenant_id',
          'matter_code',
          'client_code',
          'matter_description',
          'department',
          'work_type',
          'responsible_partner_id',
          'acting_fee_earner_id',
          'billing_basis',
          'matter_status',
          'open_date',
          'close_date',
          'current_fee_estimate',
          'wip_hours',
          'wip_value',
          'total_time_value',
          'billed_fees_ex_vat',
          'billed_disb_ex_vat',
          'billed_vat',
          'billed_total_inc_vat',
          'cash_received',
          'outstanding_debt',
          'unbilled_disbursements',
          'client_account_balance',
          'payload_json',
        ],
        matterFinancials,
        (mf) => {
          const wipHours = round2(
            (wipHoursByMatter.get(mf.matter_code) ?? 0) / 100,
          );
          const billedVat = round2(
            mf.total_invoiced_inc_vat - mf.fees_billed - mf.disbursements_billed,
          );
          return [
            ctx.tenantId,
            mf.matter_code,
            mf.client_code,
            mf.matter_description,
            mf.practice_area,
            mf.work_type,
            mf.responsible_partner_id,
            mf.fee_earner_id,
            mf.billing_basis,
            mf.status,
            mf.date_opened || null,
            mf.date_closed || null,
            mf.fee_estimate,
            wipHours,
            mf.unbilled_wip,
            mf.time_value_recorded,
            mf.fees_billed,
            mf.disbursements_billed,
            billedVat,
            mf.total_invoiced_inc_vat,
            mf.total_paid,
            mf.outstanding_debt,
            mf.unbilled_disbursements,
            mf.client_account_balance,
            JSON.stringify(mf),
          ];
        },
        { 24: '::jsonb' },
      );

      const estVersionByMatter = new Map<string, number>();
      await this.batchInsertRowsInTx(
        tx,
        'pms_fee_estimates',
        [
          'tenant_id',
          'estimate_id',
          'matter_code',
          'version',
          'estimate_date',
          'estimated_fees_ex_vat',
          'payload_json',
        ],
        dataset.feeEstimates,
        (est) => {
          const nextVer = (estVersionByMatter.get(est.matter_code) ?? 0) + 1;
          estVersionByMatter.set(est.matter_code, nextVer);
          return [
            ctx.tenantId,
            est.estimate_id,
            est.matter_code,
            nextVer,
            est.date_given,
            round2(est.fees_estimate),
            JSON.stringify(est),
          ];
        },
        { 6: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_invoices',
        [
          'tenant_id',
          'invoice_number',
          'matter_code',
          'client_code',
          'invoice_date',
          'due_date',
          'status',
          'total_inc_vat',
          'payload_json',
        ],
        dataset.invoices,
        (inv) => [
          ctx.tenantId,
          inv.invoice_number,
          inv.matter_code,
          inv.client_code,
          inv.invoice_date,
          inv.due_date,
          inv.status,
          round2(inv.total),
          JSON.stringify(inv),
        ],
        { 8: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_payments',
        [
          'tenant_id',
          'receipt_id',
          'invoice_number',
          'matter_code',
          'client_code',
          'payment_date',
          'amount',
          'payload_json',
        ],
        dataset.payments,
        (pay) => [
          ctx.tenantId,
          pay.receipt_id,
          pay.invoice_number,
          pay.matter_code,
          pay.client_code,
          pay.receipt_date,
          round2(pay.amount),
          JSON.stringify(pay),
        ],
        { 7: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_time_entries',
        [
          'tenant_id',
          'time_id',
          'matter_code',
          'fee_earner_id',
          'entry_date',
          'hours',
          'value',
          'billing_status',
          'invoice_number',
          'payload_json',
        ],
        dataset.timeEntries,
        (te) => [
          ctx.tenantId,
          te.time_id,
          te.matter_code,
          te.fee_earner_id,
          te.date,
          Number(te.hours),
          round2(te.value),
          te.billed_status,
          te.invoice_number ?? null,
          JSON.stringify(te),
        ],
        { 9: '::jsonb' },
      );

      await this.batchInsertRowsInTx(
        tx,
        'pms_disbursements',
        [
          'tenant_id',
          'disbursement_id',
          'matter_code',
          'entry_date',
          'amount_ex_vat',
          'billing_status',
          'invoice_number',
          'payload_json',
        ],
        dataset.disbursements,
        (d) => [
          ctx.tenantId,
          d.disbursement_id,
          d.matter_code,
          d.date,
          round2(d.net_amount),
          d.billed_status,
          d.invoice_number ?? null,
          JSON.stringify(d),
        ],
        { 7: '::jsonb' },
      );

      const runningPenceByMatter = new Map<string, number>();
      const sortedCa = [...dataset.clientAccount].sort((a, b) => {
        const cmpMatter = a.matter_code.localeCompare(b.matter_code);
        if (cmpMatter !== 0) return cmpMatter;
        const cmpDate = a.date.localeCompare(b.date);
        if (cmpDate !== 0) return cmpDate;
        return a.transaction_id.localeCompare(b.transaction_id);
      });
      await this.batchInsertRowsInTx(
        tx,
        'pms_client_account_entries',
        [
          'tenant_id',
          'transaction_id',
          'matter_code',
          'client_code',
          'entry_date',
          'direction',
          'amount',
          'balance_after',
          'payload_json',
        ],
        sortedCa,
        (ca) => {
          const amt = round2(ca.amount);
          const nextPence =
            (runningPenceByMatter.get(ca.matter_code) ?? 0) +
            Math.round(amt * 100);
          runningPenceByMatter.set(ca.matter_code, nextPence);
          const runningBalance = round2(nextPence / 100);
          const fullEntry: TenantPmsClientAccountEntry = {
            ...ca,
            amount: amt,
            running_balance: runningBalance,
          };
          return [
            ctx.tenantId,
            ca.transaction_id,
            ca.matter_code,
            ca.client_code,
            ca.date,
            ca.type,
            amt,
            runningBalance,
            JSON.stringify(fullEntry),
          ];
        },
        { 8: '::jsonb' },
      );
    });

    return {
      asAtDate,
      importedAt,
      counts: {
        fee_earners: dataset.feeEarners.length,
        clients: dataset.clients.length,
        matters: dataset.matters.length,
        fee_estimates: dataset.feeEstimates.length,
        time_entries: dataset.timeEntries.length,
        disbursements: dataset.disbursements.length,
        invoices: dataset.invoices.length,
        payments: dataset.payments.length,
        client_account: dataset.clientAccount.length,
      },
    };
  }

  private async refreshSnapshotInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<HydratedTenantPmsSnapshot> {
    const extractInfo = await this.getExtractInfoInTx(tx, ctx);
    const pmsLinks = await this.listPmsLinksInTx(tx, ctx);

    const feRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC',
      [ctx.tenantId],
    );
    const feeEarners: TenantPmsFeeEarner[] = feRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_fee_earners');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsFeeEarner>;
      return {
        fee_earner_id: String(row.fee_earner_id),
        initials: String(p.initials ?? ''),
        first_name: String(p.first_name ?? ''),
        last_name: String(p.last_name ?? ''),
        email: String(p.email ?? ''),
        grade: String(row.grade ?? p.grade ?? ''),
        department: String(row.department ?? p.department ?? ''),
        standard_hourly_rate: round2(
          Number(p.standard_hourly_rate ?? row.charge_out_rate ?? 0),
        ),
        annual_target_hours: Number(p.annual_target_hours ?? 0),
        annual_target_fees: round2(Number(p.annual_target_fees ?? 0)),
        active: String(p.active ?? row.status ?? 'Yes'),
      };
    });
    const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));

    const clientRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_clients WHERE tenant_id = $1 ORDER BY client_code ASC',
      [ctx.tenantId],
    );
    const clients: TenantPmsClient[] = clientRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_clients');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsClient>;
      return {
        client_code: String(row.client_code),
        client_name: String(row.client_name ?? p.client_name ?? ''),
        client_type: (row.client_type ??
          p.client_type ??
          'Organisation') as TenantPmsClient['client_type'],
        company_number: String(row.company_number ?? p.company_number ?? ''),
        email: String(p.email ?? ''),
        phone: String(p.phone ?? ''),
        billing_address: String(p.billing_address ?? ''),
        postcode: String(p.postcode ?? ''),
        client_partner_id: String(p.client_partner_id ?? ''),
        credit_terms_days: Number(p.credit_terms_days ?? 0),
        credit_limit: round2(Number(p.credit_limit ?? 0)),
        rate_discount_pct: Number(p.rate_discount_pct ?? 0),
        date_opened: String(p.date_opened ?? ''),
        sector: String(p.sector ?? ''),
        crm_match_on: (p.crm_match_on ??
          'company_number') as TenantPmsClient['crm_match_on'],
        status: String(p.status ?? 'Active'),
      };
    });

    const matterRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_matters WHERE tenant_id = $1 ORDER BY matter_code ASC',
      [ctx.tenantId],
    );
    const matters: TenantPmsMatter[] = matterRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_matters');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsMatter>;
      return {
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        matter_description: String(
          row.matter_description ?? p.matter_description ?? '',
        ),
        work_type: String(row.work_type ?? p.work_type ?? ''),
        practice_area: String(p.practice_area ?? row.department ?? ''),
        responsible_partner_id: String(
          row.responsible_partner_id ?? p.responsible_partner_id ?? '',
        ),
        fee_earner_id: String(
          p.fee_earner_id ?? row.acting_fee_earner_id ?? '',
        ),
        billing_basis: (row.billing_basis ??
          p.billing_basis ??
          'Hourly Rate') as TenantPmsMatter['billing_basis'],
        fixed_fee_amount: round2(Number(p.fixed_fee_amount ?? 0)),
        fee_estimate: round2(Number(row.fee_estimate ?? p.fee_estimate ?? 0)),
        estimate_alert_pct: Number(p.estimate_alert_pct ?? 0.75),
        date_opened: String(row.open_date ?? p.date_opened ?? ''),
        date_closed:
          row.close_date || p.date_closed
            ? String(row.close_date ?? p.date_closed)
            : null,
        status: (row.matter_status ??
          p.status ??
          'Open') as TenantPmsMatter['status'],
        billing_frequency: String(p.billing_frequency ?? ''),
        client_reference: String(p.client_reference ?? ''),
        third_party_payer: String(p.third_party_payer ?? ''),
      };
    });

    const estRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_fee_estimates WHERE tenant_id = $1 ORDER BY estimate_date ASC, estimate_id ASC',
      [ctx.tenantId],
    );
    const feeEstimates: TenantPmsFeeEstimate[] = estRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_fee_estimates');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsFeeEstimate>;
      const givenBy = String(p.given_by ?? '');
      const fe = feById.get(givenBy);
      return {
        estimate_id: String(row.estimate_id),
        matter_code: String(row.matter_code),
        date_given: String(row.estimate_date ?? p.date_given ?? ''),
        estimate_type: (p.estimate_type ??
          'Initial') as TenantPmsFeeEstimate['estimate_type'],
        fees_estimate: round2(
          Number(row.estimated_fees_ex_vat ?? p.fees_estimate ?? 0),
        ),
        disbursements_estimate: round2(Number(p.disbursements_estimate ?? 0)),
        given_by: givenBy,
        given_by_name: fe
          ? `${fe.first_name} ${fe.last_name}`
          : p.given_by_name,
        accepted_by_client: (p.accepted_by_client ??
          'Yes') as TenantPmsFeeEstimate['accepted_by_client'],
        notes: String(p.notes ?? ''),
      };
    });

    const invRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_invoices WHERE tenant_id = $1 ORDER BY invoice_date DESC, invoice_number DESC',
      [ctx.tenantId],
    );
    const invoices: TenantPmsInvoiceRow[] = invRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_invoices');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsInvoiceRow>;
      return {
        invoice_number: String(row.invoice_number),
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        invoice_date: String(row.invoice_date),
        due_date: String(row.due_date),
        invoice_type: String(p.invoice_type ?? 'Interim'),
        period_from: p.period_from ? String(p.period_from) : null,
        period_to: p.period_to ? String(p.period_to) : null,
        fees_net: round2(Number(p.fees_net ?? 0)),
        disbursements_net: round2(Number(p.disbursements_net ?? 0)),
        vat: round2(Number(p.vat ?? 0)),
        total: round2(Number(row.total_inc_vat ?? p.total ?? 0)),
        status: String(row.status ?? p.status ?? ''),
        credit_note_for: p.credit_note_for ? String(p.credit_note_for) : null,
      };
    });

    const payRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_payments WHERE tenant_id = $1 ORDER BY payment_date ASC, receipt_id ASC',
      [ctx.tenantId],
    );
    const payments: TenantPmsPayment[] = payRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_payments');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsPayment>;
      return {
        receipt_id: String(row.receipt_id),
        invoice_number: String(row.invoice_number),
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        receipt_date: String(row.payment_date ?? p.receipt_date ?? ''),
        amount: round2(Number(row.amount ?? p.amount ?? 0)),
        method: String(p.method ?? ''),
        reference: String(p.reference ?? ''),
      };
    });

    const teRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_time_entries WHERE tenant_id = $1 ORDER BY entry_date DESC, time_id DESC',
      [ctx.tenantId],
    );
    const timeEntries: TenantPmsTimeEntry[] = teRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_time_entries');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsTimeEntry>;
      const feId = String(row.fee_earner_id);
      const fe = feById.get(feId);
      return {
        time_id: String(row.time_id),
        matter_code: String(row.matter_code),
        fee_earner_id: feId,
        fee_earner_name: fe
          ? `${fe.first_name} ${fe.last_name}`
          : p.fee_earner_name,
        fee_earner_initials: fe?.initials ?? p.fee_earner_initials,
        date: String(row.entry_date ?? p.date ?? ''),
        activity: String(p.activity ?? ''),
        narrative: String(p.narrative ?? ''),
        minutes: Number(p.minutes ?? 0),
        units: Number(p.units ?? 0),
        hours: Number(row.hours ?? p.hours ?? 0),
        rate: round2(Number(p.rate ?? 0)),
        value: round2(Number(row.value ?? p.value ?? 0)),
        chargeable: (p.chargeable ?? 'Y') as 'Y' | 'N',
        billed_status: (row.billing_status ??
          p.billed_status ??
          'Unbilled') as TenantPmsTimeEntry['billed_status'],
        invoice_number:
          row.invoice_number || p.invoice_number
            ? String(row.invoice_number ?? p.invoice_number)
            : null,
        billed_value: round2(Number(p.billed_value ?? 0)),
        write_off_value: round2(Number(p.write_off_value ?? 0)),
      };
    });

    const disbRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_disbursements WHERE tenant_id = $1 ORDER BY entry_date DESC, disbursement_id DESC',
      [ctx.tenantId],
    );
    const disbursements: TenantPmsDisbursement[] = disbRes.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_disbursements');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsDisbursement>;
      return {
        disbursement_id: String(row.disbursement_id),
        matter_code: String(row.matter_code),
        date: String(row.entry_date ?? p.date ?? ''),
        type: String(p.type ?? ''),
        supplier: String(p.supplier ?? ''),
        description: String(p.description ?? ''),
        net_amount: round2(Number(row.amount_ex_vat ?? p.net_amount ?? 0)),
        vat_amount: round2(Number(p.vat_amount ?? 0)),
        gross_amount: round2(Number(p.gross_amount ?? 0)),
        paid_from: (p.paid_from ??
          'Office') as TenantPmsDisbursement['paid_from'],
        billed_status: (row.billing_status ??
          p.billed_status ??
          'Unbilled') as TenantPmsDisbursement['billed_status'],
        invoice_number:
          row.invoice_number || p.invoice_number
            ? String(row.invoice_number ?? p.invoice_number)
            : null,
      };
    });

    const caRes = await tx.query<DbGenericPayloadRow>(
      'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 ORDER BY matter_code ASC, entry_date ASC, transaction_id ASC',
      [ctx.tenantId],
    );
    const runningByMatter = new Map<string, number>();
    const clientAccount: TenantPmsClientAccountEntry[] = caRes.rows.map(
      (row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'pms_client_account_entries');
        const p = (row.payload_json ??
          {}) as Partial<TenantPmsClientAccountEntry>;
        const mCode = String(row.matter_code);
        const amt = round2(Number(row.amount ?? p.amount ?? 0));
        const nextPence =
          (runningByMatter.get(mCode) ?? 0) + Math.round(amt * 100);
        runningByMatter.set(mCode, nextPence);
        return {
          transaction_id: String(row.transaction_id),
          matter_code: mCode,
          client_code: String(row.client_code),
          date: String(row.entry_date ?? p.date ?? ''),
          type: (row.direction ??
            p.type ??
            'Receipt') as TenantPmsClientAccountEntry['type'],
          description: String(p.description ?? ''),
          amount: amt,
          running_balance: round2(nextPence / 100),
        };
      },
    );

    const ccRes = await tx.query<DbCreditControlLogRow>(
      'SELECT * FROM public.pms_credit_control_log WHERE tenant_id = $1 ORDER BY id DESC',
      [ctx.tenantId],
    );
    const creditControlLog: TenantPmsCreditControlLogEntry[] = ccRes.rows.map(
      (row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'pms_credit_control_log');
        return {
          id: Number(row.id),
          tenantId: row.tenant_id,
          invoiceNumber: row.invoice_number,
          matterCode: row.matter_code,
          actionType: row.action_type,
          notes: row.notes,
          actorName: row.actor_name,
          createdAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : String(row.created_at),
        };
      },
    );

    const invoiceBalances = computeDerivedInvoiceBalances({
      asAtDate: extractInfo.asAtDate,
      invoices,
      payments,
    });
    const matterFinancials = computeDerivedMatterFinancials({
      asAtDate: extractInfo.asAtDate,
      feeEarners,
      clients,
      matters,
      feeEstimates,
      invoiceBalances,
      timeEntries,
      disbursements,
      clientAccount,
    });

    const snapshot: HydratedTenantPmsSnapshot = {
      tenantId: ctx.tenantId,
      databaseName: ctx.postgresDatabaseName,
      extractInfo,
      pmsLinks,
      feeEarners,
      clients,
      matters,
      matterFinancials,
      feeEstimates,
      invoices,
      invoiceBalances,
      payments,
      timeEntries,
      disbursements,
      clientAccount,
      creditControlLog,
    };

    return snapshot;
  }

  public async loadTenantPmsSnapshot(
    ctx: TenantContext,
  ): Promise<HydratedTenantPmsSnapshot> {
    return this.withTenantReadTransaction(ctx, (tx) =>
      this.refreshSnapshotInTx(tx, ctx),
    );
  }

  public async listFeeEarners(
    ctx: TenantContext,
  ): Promise<TenantPmsFeeEarner[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.feeEarners);
  }

  public async listClients(ctx: TenantContext): Promise<TenantPmsClient[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.clients);
  }

  public async listMatters(ctx: TenantContext): Promise<TenantPmsMatter[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.matters);
  }

  public async getAllMatterFinancials(
    ctx: TenantContext,
  ): Promise<TenantPmsMatterFinancials[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.matterFinancials);
  }

  public async getMatterFinancials(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterFinancials | null> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    const found = snap.matterFinancials.find(
      (m) => m.matter_code === matterCode,
    );
    return found ? structuredClone(found) : null;
  }

  public async getFeeEstimates(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsFeeEstimate[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(
      snap.feeEstimates.filter((e) => e.matter_code === matterCode),
    );
  }

  public async getTimeEntries(
    ctx: TenantContext,
    matterCode: string,
    filters?: TenantPmsTimeEntryFilters,
  ): Promise<TenantPmsTimeEntry[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(
      snap.timeEntries.filter((te) => {
        if (te.matter_code !== matterCode) return false;
        if (
          filters?.feeEarnerId &&
          filters.feeEarnerId !== 'all' &&
          te.fee_earner_id !== filters.feeEarnerId
        ) {
          return false;
        }
        if (
          filters?.billedStatus &&
          filters.billedStatus !== 'all' &&
          te.billed_status !== filters.billedStatus
        ) {
          return false;
        }
        if (filters?.dateFrom && te.date < filters.dateFrom) return false;
        if (filters?.dateTo && te.date > filters.dateTo) return false;
        return true;
      }),
    );
  }

  public async listAllTimeEntries(
    ctx: TenantContext,
  ): Promise<TenantPmsTimeEntry[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.timeEntries);
  }

  public async getMatterWipBreakdown(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterWipBreakdown> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return computeDerivedMatterWipBreakdown({
      matterCode,
      asAtDate: snap.extractInfo.asAtDate,
      feeEarners: snap.feeEarners,
      timeEntries: snap.timeEntries,
    });
  }

  public async listAllInvoiceBalances(
    ctx: TenantContext,
  ): Promise<TenantPmsInvoiceBalance[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.invoiceBalances);
  }

  public async getInvoiceBalance(
    ctx: TenantContext,
    invoiceNumber: string,
  ): Promise<TenantPmsInvoiceBalance | null> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    const found = snap.invoiceBalances.find(
      (i) => i.invoice_number === invoiceNumber,
    );
    return found ? structuredClone(found) : null;
  }

  public async getAgedDebt(
    ctx: TenantContext,
    clientCode?: string,
  ): Promise<TenantPmsInvoiceBalance[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(
      snap.invoiceBalances
        .filter(
          (i) =>
            i.invoice_type !== 'Credit note' &&
            (!clientCode || i.client_code === clientCode),
        )
        .sort((a, b) => a.invoice_number.localeCompare(b.invoice_number)),
    );
  }

  public async getInvoices(
    ctx: TenantContext,
    filter?: { matterCode?: string; clientCode?: string },
  ): Promise<TenantPmsInvoiceDetail[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    const filteredBalances = snap.invoiceBalances.filter((inv) => {
      if (filter?.matterCode && inv.matter_code !== filter.matterCode) {
        return false;
      }
      if (filter?.clientCode && inv.client_code !== filter.clientCode) {
        return false;
      }
      return true;
    });

    return structuredClone(
      filteredBalances.map((inv) => ({
        ...inv,
        payments: snap.payments.filter(
          (p) => p.invoice_number === inv.invoice_number,
        ),
        timeEntries: [...snap.timeEntries]
          .filter((t) => t.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            if (cmp !== 0) return cmp;
            return a.time_id.localeCompare(b.time_id);
          }),
        disbursements: [...snap.disbursements]
          .filter((d) => d.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            if (cmp !== 0) return cmp;
            return a.disbursement_id.localeCompare(b.disbursement_id);
          }),
        appliedCreditNotes: filteredBalances.filter(
          (other) => other.credit_note_for === inv.invoice_number,
        ),
      })),
    );
  }

  public async getDisbursements(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsDisbursement[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(
      snap.disbursements.filter((d) => d.matter_code === matterCode),
    );
  }

  public async getClientAccountLedger(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsClientAccountEntry[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(
      snap.clientAccount.filter((ca) => ca.matter_code === matterCode),
    );
  }

  public async listAllPayments(
    ctx: TenantContext,
  ): Promise<TenantPmsPayment[]> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    return structuredClone(snap.payments);
  }

  public async getMatterFullBundle(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterFullBundle | null> {
    const snap = await this.loadTenantPmsSnapshot(ctx);
    const summary = snap.matterFinancials.find(
      (m) => m.matter_code === matterCode,
    );
    if (!summary) return null;
    const invoices = await this.getInvoices(ctx, { matterCode });
    return {
      extractInfo: structuredClone(snap.extractInfo),
      summary: structuredClone(summary),
      estimates: structuredClone(
        snap.feeEstimates.filter((e) => e.matter_code === matterCode),
      ),
      timeEntries: structuredClone(
        snap.timeEntries.filter((t) => t.matter_code === matterCode),
      ),
      wipBreakdown: computeDerivedMatterWipBreakdown({
        matterCode,
        asAtDate: snap.extractInfo.asAtDate,
        feeEarners: snap.feeEarners,
        timeEntries: snap.timeEntries,
      }),
      invoices,
      disbursements: structuredClone(
        snap.disbursements.filter((d) => d.matter_code === matterCode),
      ),
      clientAccount: structuredClone(
        snap.clientAccount.filter((ca) => ca.matter_code === matterCode),
      ),
    };
  }

  // ============================================================================
  // Counts & Clean Deployment Clear
  // ============================================================================

  public async countAllTenantPmsRows(ctx: TenantContext): Promise<{
    pmsLinks: number;
    extractMetadata: number;
    feeEarners: number;
    clients: number;
    matters: number;
    matterFinancials: number;
    feeEstimates: number;
    invoices: number;
    payments: number;
    timeEntries: number;
    disbursements: number;
    clientAccountEntries: number;
    creditControlLog: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const countTable = async (table: string): Promise<number> => {
        const res = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM public.${table} WHERE tenant_id = $1`,
          [ctx.tenantId],
        );
        return Number.parseInt(res.rows[0]?.cnt ?? '0', 10);
      };
      return {
        pmsLinks: await countTable('pms_links'),
        extractMetadata: await countTable('pms_extract_metadata'),
        feeEarners: await countTable('pms_fee_earners'),
        clients: await countTable('pms_clients'),
        matters: await countTable('pms_matters'),
        matterFinancials: await countTable('pms_matter_financials'),
        feeEstimates: await countTable('pms_fee_estimates'),
        invoices: await countTable('pms_invoices'),
        payments: await countTable('pms_payments'),
        timeEntries: await countTable('pms_time_entries'),
        disbursements: await countTable('pms_disbursements'),
        clientAccountEntries: await countTable('pms_client_account_entries'),
        creditControlLog: await countTable('pms_credit_control_log'),
      };
    });
  }

  public async clearTenantData(
    ctx: TenantContext,
    options?: { keepExtractTables?: boolean },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('DELETE FROM public.pms_links WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        'DELETE FROM public.pms_credit_control_log WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      if (!options?.keepExtractTables) {
        for (const table of [
          'pms_client_account_entries',
          'pms_payments',
          'pms_disbursements',
          'pms_time_entries',
          'pms_invoices',
          'pms_fee_estimates',
          'pms_matter_financials',
          'pms_matters',
          'pms_clients',
          'pms_fee_earners',
          'pms_extract_metadata',
        ]) {
          await tx.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [
            ctx.tenantId,
          ]);
        }
      }
      await tx.query(
        `DELETE FROM public.tenant_record_sequences
         WHERE tenant_id = $1 AND counter_key = 'PMSL'`,
        [ctx.tenantId],
      );
    });
  }
}
