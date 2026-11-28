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
  minorUnitsToPgBigInt,
  minorUnitsToPounds,
  pgBigIntToMinorUnits,
  poundsToMinorUnits,
  subtractMinorUnits,
  sumMinorUnits,
  type MinorUnits,
} from '../domain/money/index';
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

function roundHours2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export function toSafeMinorUnits(n: unknown): MinorUnits | null {
  if (n === null || n === undefined) return null;
  if (typeof n === 'string') {
    const trimmed = n.trim();
    if (!trimmed) return null;
    if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
      try {
        return poundsToMinorUnits(trimmed);
      } catch {
        return null;
      }
    }
    if (/^[-+]?\d+(?:\.\d+)?[eE][-+]?\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && Math.abs(parsed) < 1e-9) {
        return 0 as MinorUnits;
      }
      return null;
    }
    return null;
  }
  if (typeof n === 'number') {
    if (!Number.isFinite(n)) return null;
    if (/[eE]/.test(String(n))) {
      if (Math.abs(n) < 1e-9) return 0 as MinorUnits;
      return null;
    }
    try {
      return poundsToMinorUnits(n);
    } catch {
      return null;
    }
  }
  return null;
}

function parsePayloadMoneyPence(
  text: unknown,
  corruptTracker: { count: number },
): MinorUnits | null {
  if (text === null || text === undefined) return 0 as MinorUnits;
  const trimmed = String(text).trim();
  if (!trimmed) return 0 as MinorUnits;
  const parsed = toSafeMinorUnits(trimmed);
  if (parsed === null) {
    corruptTracker.count += 1;
    return null;
  }
  return parsed;
}

function warnIfCorruptMoneyText(
  ctx: TenantContext,
  corruptTracker: { count: number },
): void {
  if (corruptTracker.count > 0) {
    console.warn(
      JSON.stringify({
        event: 'pms.corrupt_money_text',
        tenantId: ctx.tenantId,
        corruptCount: corruptTracker.count,
      }),
    );
  }
}

function resolvePenceField(
  pence: MinorUnits | null | undefined,
  fallbackGbp: number | null | undefined,
): MinorUnits {
  if (typeof pence === 'number' && Number.isSafeInteger(pence)) {
    return pence;
  }
  if (fallbackGbp === null || fallbackGbp === undefined) {
    return 0 as MinorUnits;
  }
  return toSafeMinorUnits(fallbackGbp) ?? (0 as MinorUnits);
}

const PMS_FEE_EARNERS_SELECT =
  "*, payload_json->>'annual_target_fees' AS payload_annual_target_fees_text";
const PMS_CLIENTS_SELECT =
  "*, payload_json->>'credit_limit' AS payload_credit_limit_text";
const PMS_MATTERS_SELECT =
  "*, payload_json->>'fixed_fee_amount' AS payload_fixed_fee_amount_text";
const PMS_FEE_ESTIMATES_SELECT =
  "*, payload_json->>'disbursements_estimate' AS payload_disbursements_estimate_text";
const PMS_INVOICES_SELECT =
  "*, payload_json->>'fees_net' AS payload_fees_net_text, payload_json->>'disbursements_net' AS payload_disbursements_net_text, payload_json->>'vat' AS payload_vat_text";
const PMS_TIME_ENTRIES_SELECT =
  "*, payload_json->>'rate' AS payload_rate_text, payload_json->>'billed_value' AS payload_billed_value_text, payload_json->>'write_off_value' AS payload_write_off_value_text";
const PMS_DISBURSEMENTS_SELECT =
  "*, payload_json->>'vat_amount' AS payload_vat_amount_text, payload_json->>'gross_amount' AS payload_gross_amount_text";

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
  standard_hourly_rate_pence?: MinorUnits;
  annual_target_hours: number;
  annual_target_fees: number | null;
  annual_target_fees_pence?: MinorUnits | null;
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
  credit_limit: number | null;
  credit_limit_pence?: MinorUnits | null;
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
  fixed_fee_amount: number | null;
  fixed_fee_amount_pence?: MinorUnits | null;
  fee_estimate: number;
  fee_estimate_pence?: MinorUnits;
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
  fees_estimate_pence?: MinorUnits;
  disbursements_estimate: number | null;
  disbursements_estimate_pence?: MinorUnits | null;
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
  rate: number | null;
  rate_pence?: MinorUnits | null;
  value: number;
  value_pence?: MinorUnits;
  chargeable: 'Y' | 'N';
  billed_status: 'Unbilled' | 'Billed' | 'Written off' | 'Non-chargeable';
  invoice_number: string | null;
  billed_value: number | null;
  billed_value_pence?: MinorUnits | null;
  write_off_value: number | null;
  write_off_value_pence?: MinorUnits | null;
}

export interface TenantPmsDisbursement {
  disbursement_id: string;
  matter_code: string;
  date: string;
  type: string;
  supplier: string;
  description: string;
  net_amount: number;
  net_amount_pence?: MinorUnits;
  vat_amount: number | null;
  vat_amount_pence?: MinorUnits | null;
  gross_amount: number | null;
  gross_amount_pence?: MinorUnits | null;
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
  amount_pence?: MinorUnits;
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
  fees_net: number | null;
  fees_net_pence?: MinorUnits | null;
  disbursements_net: number | null;
  disbursements_net_pence?: MinorUnits | null;
  vat: number | null;
  vat_pence?: MinorUnits | null;
  total: number;
  total_pence?: MinorUnits;
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
  fees_net: number | null;
  fees_net_pence?: MinorUnits | null;
  disbursements_net: number | null;
  disbursements_net_pence?: MinorUnits | null;
  vat: number | null;
  vat_pence?: MinorUnits | null;
  total: number;
  total_pence?: MinorUnits;
  exported_status: string;
  credit_note_for: string | null;
  paid: number;
  paid_pence?: MinorUnits;
  credit_notes: number;
  credit_notes_pence?: MinorUnits;
  outstanding: number;
  outstanding_pence?: MinorUnits;
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
  amount_pence?: MinorUnits;
  running_balance: number;
  running_balance_pence?: MinorUnits;
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
  fixed_fee_amount_pence?: MinorUnits;
  estimate_alert_pct: number;
  date_opened: string;
  date_closed: string | null;
  status: 'Pending' | 'Open' | 'Closed';
  billing_frequency: string;
  client_reference: string;
  third_party_payer: string;
  fee_estimate: number;
  fee_estimate_pence?: MinorUnits;
  time_value_recorded: number;
  time_value_recorded_pence?: MinorUnits;
  unbilled_wip: number;
  unbilled_wip_pence?: MinorUnits;
  fees_billed: number;
  fees_billed_pence?: MinorUnits;
  disbursements_billed: number;
  disbursements_billed_pence?: MinorUnits;
  total_invoiced_inc_vat: number;
  total_invoiced_inc_vat_pence?: MinorUnits;
  total_paid: number;
  total_paid_pence?: MinorUnits;
  outstanding_debt: number;
  outstanding_debt_pence?: MinorUnits;
  unbilled_disbursements: number;
  unbilled_disbursements_pence?: MinorUnits;
  estimate_used_pct: number;
  written_off: number;
  written_off_pence?: MinorUnits;
  client_account_balance: number;
  client_account_balance_pence?: MinorUnits;
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
    wip_value_pence?: MinorUnits;
  }[];
  byAgeBucket: {
    bucket_0_30: number;
    bucket_0_30_pence?: MinorUnits;
    bucket_31_60: number;
    bucket_31_60_pence?: MinorUnits;
    bucket_61_90: number;
    bucket_61_90_pence?: MinorUnits;
    bucket_90_plus: number;
    bucket_90_plus_pence?: MinorUnits;
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
  const paidPenceByInv = new Map<string, MinorUnits>();
  for (const p of params.payments) {
    paidPenceByInv.set(
      p.invoice_number,
      sumMinorUnits([
        paidPenceByInv.get(p.invoice_number) ?? (0 as MinorUnits),
        resolvePenceField(p.amount_pence, p.amount),
      ]),
    );
  }

  const cnPenceByInv = new Map<string, MinorUnits>();
  for (const inv of params.invoices) {
    if (inv.credit_note_for && inv.credit_note_for.trim()) {
      const target = inv.credit_note_for.trim();
      cnPenceByInv.set(
        target,
        sumMinorUnits([
          cnPenceByInv.get(target) ?? (0 as MinorUnits),
          resolvePenceField(inv.total_pence, inv.total),
        ]),
      );
    }
  }

  const balances: TenantPmsInvoiceBalance[] = params.invoices.map((inv) => {
    const paidPence = paidPenceByInv.get(inv.invoice_number) ?? (0 as MinorUnits);
    const creditNotesPence = cnPenceByInv.get(inv.invoice_number) ?? (0 as MinorUnits);
    const feesNetPence = resolvePenceField(inv.fees_net_pence, inv.fees_net);
    const disbursementsNetPence = resolvePenceField(
      inv.disbursements_net_pence,
      inv.disbursements_net,
    );
    const vatPence = resolvePenceField(inv.vat_pence, inv.vat);
    const totalPence = resolvePenceField(inv.total_pence, inv.total);
    const paid = minorUnitsToPounds(paidPence);
    const creditNotes = minorUnitsToPounds(creditNotesPence);
    const isCreditNote = inv.invoice_type === 'Credit note';
    const outstandingPence = isCreditNote
      ? (0 as MinorUnits)
      : sumMinorUnits([subtractMinorUnits(totalPence, paidPence), creditNotesPence]);
    const outstanding = minorUnitsToPounds(outstandingPence);

    const diffDays = validAsAt
      ? daysBetweenIsoDates(validAsAt, inv.due_date)
      : 0;
    const daysPastDue =
      isCreditNote || outstandingPence <= 0 || !validAsAt
        ? null
        : diffDays < 0
          ? 0
          : diffDays;

    let ageBucket: TenantPmsAgeBucket;
    if (isCreditNote || outstandingPence <= 0) {
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
    } else if (outstandingPence <= 0) {
      recalculatedStatus = 'Paid';
    } else if (paidPence > 0) {
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
      fees_net: minorUnitsToPounds(feesNetPence),
      fees_net_pence: feesNetPence,
      disbursements_net: minorUnitsToPounds(disbursementsNetPence),
      disbursements_net_pence: disbursementsNetPence,
      vat: minorUnitsToPounds(vatPence),
      vat_pence: vatPence,
      total: minorUnitsToPounds(totalPence),
      total_pence: totalPence,
      exported_status: inv.status,
      credit_note_for: inv.credit_note_for ?? null,
      paid,
      paid_pence: paidPence,
      credit_notes: creditNotes,
      credit_notes_pence: creditNotesPence,
      outstanding,
      outstanding_pence: outstandingPence,
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
  clientAccount: readonly (Pick<
    TenantPmsClientAccountEntry,
    'matter_code' | 'amount'
  > &
    Partial<
      Pick<
        TenantPmsClientAccountEntry,
        'amount_pence' | 'running_balance' | 'running_balance_pence' | 'date' | 'transaction_id'
      >
    >)[];
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

  // Prefer persisted running_balance_pence (`balance_after_pence`) on the latest entry
  // per matter; only accumulate amount_pence when importing fresh entries with no balance_after.
  const caEntriesByMatter = new Map<
    string,
    (typeof params.clientAccount)[number][]
  >();
  for (const ca of params.clientAccount) {
    const list = caEntriesByMatter.get(ca.matter_code) ?? [];
    list.push(ca);
    caEntriesByMatter.set(ca.matter_code, list);
  }
  const caPenceByMatter = new Map<string, MinorUnits>();
  for (const [mCode, entries] of caEntriesByMatter.entries()) {
    const lastEntry = entries[entries.length - 1];
    if (
      lastEntry &&
      typeof lastEntry.running_balance_pence === 'number' &&
      Number.isSafeInteger(lastEntry.running_balance_pence)
    ) {
      caPenceByMatter.set(mCode, lastEntry.running_balance_pence);
    } else if (lastEntry && typeof lastEntry.running_balance === 'number') {
      caPenceByMatter.set(
        mCode,
        toSafeMinorUnits(lastEntry.running_balance) ?? (0 as MinorUnits),
      );
    } else {
      caPenceByMatter.set(
        mCode,
        sumMinorUnits(
          entries.map((ca) => resolvePenceField(ca.amount_pence, ca.amount)),
        ),
      );
    }
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
    const feeEstimatePence = latestEst
      ? resolvePenceField(latestEst.fees_estimate_pence, latestEst.fees_estimate)
      : resolvePenceField(m.fee_estimate_pence, m.fee_estimate);
    const feeEstimate = minorUnitsToPounds(feeEstimatePence);
    const fixedFeeAmountPence = resolvePenceField(
      m.fixed_fee_amount_pence,
      m.fixed_fee_amount,
    );
    const hasPendingRevision = mEstimates.some(
      (e) => e.accepted_by_client === 'Pending',
    );

    const mTimes = timeByMatter.get(m.matter_code) ?? [];
    let timeRecordedPence = 0 as MinorUnits;
    let unbilledWipPence = 0 as MinorUnits;
    let writtenOffPence = 0 as MinorUnits;
    let oldestUnbilledWipDays: number | null = null;

    for (const te of mTimes) {
      const valPence = resolvePenceField(te.value_pence, te.value);
      timeRecordedPence = sumMinorUnits([timeRecordedPence, valPence]);
      writtenOffPence = sumMinorUnits([
        writtenOffPence,
        resolvePenceField(te.write_off_value_pence, te.write_off_value),
      ]);
      if (te.billed_status === 'Unbilled') {
        unbilledWipPence = sumMinorUnits([unbilledWipPence, valPence]);
        if (valPence > 0 && validAsAt) {
          const age = daysBetweenIsoDates(validAsAt, te.date);
          if (oldestUnbilledWipDays === null || age > oldestUnbilledWipDays) {
            oldestUnbilledWipDays = age;
          }
        }
      }
    }

    const timeValueRecorded = minorUnitsToPounds(timeRecordedPence);
    const unbilledWip = minorUnitsToPounds(unbilledWipPence);
    const writtenOff = minorUnitsToPounds(writtenOffPence);

    const mInvoices = invByMatter.get(m.matter_code) ?? [];
    let feesBilledPence = 0 as MinorUnits;
    let disbBilledPence = 0 as MinorUnits;
    let totalInvoicedPence = 0 as MinorUnits;
    let totalPaidPence = 0 as MinorUnits;
    let maxInvoiceDaysPastDue: number | null = null;

    for (const ib of mInvoices) {
      feesBilledPence = sumMinorUnits([
        feesBilledPence,
        resolvePenceField(ib.fees_net_pence, ib.fees_net),
      ]);
      disbBilledPence = sumMinorUnits([
        disbBilledPence,
        resolvePenceField(ib.disbursements_net_pence, ib.disbursements_net),
      ]);
      totalInvoicedPence = sumMinorUnits([
        totalInvoicedPence,
        resolvePenceField(ib.total_pence, ib.total),
      ]);
      totalPaidPence = sumMinorUnits([
        totalPaidPence,
        resolvePenceField(ib.paid_pence, ib.paid),
      ]);
      const outstandingInvPence = resolvePenceField(
        ib.outstanding_pence,
        ib.outstanding,
      );
      if (outstandingInvPence > 0 && ib.days_past_due !== null) {
        if (
          maxInvoiceDaysPastDue === null ||
          ib.days_past_due > maxInvoiceDaysPastDue
        ) {
          maxInvoiceDaysPastDue = ib.days_past_due;
        }
      }
    }

    const feesBilled = minorUnitsToPounds(feesBilledPence);
    const disbursementsBilled = minorUnitsToPounds(disbBilledPence);
    const totalInvoicedIncVat = minorUnitsToPounds(totalInvoicedPence);
    const totalPaid = minorUnitsToPounds(totalPaidPence);
    const outstandingDebtPence = subtractMinorUnits(
      totalInvoicedPence,
      totalPaidPence,
    );
    const outstandingDebt = minorUnitsToPounds(outstandingDebtPence);

    const mDisbs = disbByMatter.get(m.matter_code) ?? [];
    let unbilledDisbPence = 0 as MinorUnits;
    for (const d of mDisbs) {
      if (d.billed_status === 'Unbilled') {
        unbilledDisbPence = sumMinorUnits([
          unbilledDisbPence,
          resolvePenceField(d.net_amount_pence, d.net_amount),
        ]);
      }
    }
    const unbilledDisbursements = minorUnitsToPounds(unbilledDisbPence);
    const clientAccountPence = caPenceByMatter.get(m.matter_code) ?? (0 as MinorUnits);
    const clientAccountBalance = minorUnitsToPounds(clientAccountPence);
    const estimateUsedPct =
      feeEstimatePence > 0
        ? sumMinorUnits([feesBilledPence, unbilledWipPence]) / feeEstimatePence
        : 0;

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
      fixed_fee_amount: minorUnitsToPounds(fixedFeeAmountPence),
      fixed_fee_amount_pence: fixedFeeAmountPence,
      estimate_alert_pct: Number(m.estimate_alert_pct ?? 0.75),
      date_opened: m.date_opened,
      date_closed: m.date_closed ?? null,
      status: m.status,
      billing_frequency: m.billing_frequency ?? '',
      client_reference: m.client_reference ?? '',
      third_party_payer: m.third_party_payer ?? '',
      fee_estimate: feeEstimate,
      fee_estimate_pence: feeEstimatePence,
      time_value_recorded: timeValueRecorded,
      time_value_recorded_pence: timeRecordedPence,
      unbilled_wip: unbilledWip,
      unbilled_wip_pence: unbilledWipPence,
      fees_billed: feesBilled,
      fees_billed_pence: feesBilledPence,
      disbursements_billed: disbursementsBilled,
      disbursements_billed_pence: disbBilledPence,
      total_invoiced_inc_vat: totalInvoicedIncVat,
      total_invoiced_inc_vat_pence: totalInvoicedPence,
      total_paid: totalPaid,
      total_paid_pence: totalPaidPence,
      outstanding_debt: outstandingDebt,
      outstanding_debt_pence: outstandingDebtPence,
      unbilled_disbursements: unbilledDisbursements,
      unbilled_disbursements_pence: unbilledDisbPence,
      estimate_used_pct: estimateUsedPct,
      written_off: writtenOff,
      written_off_pence: writtenOffPence,
      client_account_balance: clientAccountBalance,
      client_account_balance_pence: clientAccountPence,
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
      wipPence: MinorUnits;
    }
  >();

  let bucket0_30Pence = 0 as MinorUnits;
  let bucket31_60Pence = 0 as MinorUnits;
  let bucket61_90Pence = 0 as MinorUnits;
  let bucket90PlusPence = 0 as MinorUnits;

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
      wipPence: 0 as MinorUnits,
    };
    const valPence = resolvePenceField(te.value_pence, te.value);
    existing.hoursHund += Math.round(te.hours * 100);
    existing.wipPence = sumMinorUnits([existing.wipPence, valPence]);
    feAgg.set(te.fee_earner_id, existing);

    const ageDays = validAsAt ? daysBetweenIsoDates(validAsAt, te.date) : 0;
    if (ageDays <= 30) {
      bucket0_30Pence = sumMinorUnits([bucket0_30Pence, valPence]);
    } else if (ageDays <= 60) {
      bucket31_60Pence = sumMinorUnits([bucket31_60Pence, valPence]);
    } else if (ageDays <= 90) {
      bucket61_90Pence = sumMinorUnits([bucket61_90Pence, valPence]);
    } else {
      bucket90PlusPence = sumMinorUnits([bucket90PlusPence, valPence]);
    }
  }

  const byFeeEarner = Array.from(feAgg.values())
    .map((item) => ({
      fee_earner_id: item.fee_earner_id,
      name: item.name,
      initials: item.initials,
      grade: item.grade,
      hours: roundHours2(item.hoursHund / 100),
      wip_value: minorUnitsToPounds(item.wipPence),
      wip_value_pence: item.wipPence,
    }))
    .sort((a, b) => {
      if (b.wip_value !== a.wip_value) return b.wip_value - a.wip_value;
      return a.fee_earner_id.localeCompare(b.fee_earner_id);
    });

  return {
    byFeeEarner,
    byAgeBucket: {
      bucket_0_30: minorUnitsToPounds(bucket0_30Pence),
      bucket_0_30_pence: bucket0_30Pence,
      bucket_31_60: minorUnitsToPounds(bucket31_60Pence),
      bucket_31_60_pence: bucket31_60Pence,
      bucket_61_90: minorUnitsToPounds(bucket61_90Pence),
      bucket_61_90_pence: bucket61_90Pence,
      bucket_90_plus: minorUnitsToPounds(bucket90PlusPence),
      bucket_90_plus_pence: bucket90PlusPence,
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
      sourceFile: row.source_name || 'PMS Extract',
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
      const sourceName = info.sourceFile?.trim() || 'PMS Extract';
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
      dataset.extractInfo.sourceFile?.trim() || 'PMS Extract';

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
          'charge_out_rate_pence',
          'status',
          'payload_json',
        ],
        dataset.feeEarners,
        (fe) => {
          const ratePence = resolvePenceField(
            fe.standard_hourly_rate_pence,
            fe.standard_hourly_rate,
          );
          return [
            ctx.tenantId,
            fe.fee_earner_id,
            `${fe.first_name} ${fe.last_name}`.trim(),
            fe.grade,
            fe.department,
            'London',
            minorUnitsToPounds(ratePence),
            minorUnitsToPgBigInt(ratePence),
            fe.active || 'Yes',
            JSON.stringify(fe),
          ];
        },
        { 7: '::bigint', 9: '::jsonb' },
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
          'fee_estimate_pence',
          'matter_status',
          'open_date',
          'close_date',
          'payload_json',
        ],
        dataset.matters,
        (matter) => {
          const estPence = resolvePenceField(
            matter.fee_estimate_pence,
            matter.fee_estimate,
          );
          return [
            ctx.tenantId,
            matter.matter_code,
            matter.client_code,
            matter.matter_description,
            matter.practice_area,
            matter.work_type,
            matter.responsible_partner_id,
            matter.fee_earner_id,
            matter.billing_basis,
            minorUnitsToPounds(estPence),
            minorUnitsToPgBigInt(estPence),
            matter.status,
            matter.date_opened || null,
            matter.date_closed || null,
            JSON.stringify(matter),
          ];
        },
        { 10: '::bigint', 14: '::jsonb' },
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
          'current_fee_estimate_pence',
          'wip_hours',
          'wip_value',
          'wip_value_pence',
          'total_time_value',
          'total_time_value_pence',
          'billed_fees_ex_vat',
          'billed_fees_ex_vat_pence',
          'billed_disb_ex_vat',
          'billed_disb_ex_vat_pence',
          'billed_vat',
          'billed_vat_pence',
          'billed_total_inc_vat',
          'billed_total_inc_vat_pence',
          'cash_received',
          'cash_received_pence',
          'outstanding_debt',
          'outstanding_debt_pence',
          'unbilled_disbursements',
          'unbilled_disbursements_pence',
          'client_account_balance',
          'client_account_balance_pence',
          'payload_json',
        ],
        matterFinancials,
        (mf) => {
          const wipHours = roundHours2(
            (wipHoursByMatter.get(mf.matter_code) ?? 0) / 100,
          );
          const feeEstimatePence = resolvePenceField(
            mf.fee_estimate_pence,
            mf.fee_estimate,
          );
          const unbilledWipPence = resolvePenceField(
            mf.unbilled_wip_pence,
            mf.unbilled_wip,
          );
          const timeRecordedPence = resolvePenceField(
            mf.time_value_recorded_pence,
            mf.time_value_recorded,
          );
          const feesBilledPence = resolvePenceField(
            mf.fees_billed_pence,
            mf.fees_billed,
          );
          const disbBilledPence = resolvePenceField(
            mf.disbursements_billed_pence,
            mf.disbursements_billed,
          );
          const totalInvoicedPence = resolvePenceField(
            mf.total_invoiced_inc_vat_pence,
            mf.total_invoiced_inc_vat,
          );
          const billedVatPence = subtractMinorUnits(
            subtractMinorUnits(totalInvoicedPence, feesBilledPence),
            disbBilledPence,
          );
          const totalPaidPence = resolvePenceField(
            mf.total_paid_pence,
            mf.total_paid,
          );
          const outstandingDebtPence = resolvePenceField(
            mf.outstanding_debt_pence,
            mf.outstanding_debt,
          );
          const unbilledDisbPence = resolvePenceField(
            mf.unbilled_disbursements_pence,
            mf.unbilled_disbursements,
          );
          const clientAccountPence = resolvePenceField(
            mf.client_account_balance_pence,
            mf.client_account_balance,
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
            minorUnitsToPgBigInt(feeEstimatePence),
            wipHours,
            mf.unbilled_wip,
            minorUnitsToPgBigInt(unbilledWipPence),
            mf.time_value_recorded,
            minorUnitsToPgBigInt(timeRecordedPence),
            mf.fees_billed,
            minorUnitsToPgBigInt(feesBilledPence),
            mf.disbursements_billed,
            minorUnitsToPgBigInt(disbBilledPence),
            minorUnitsToPounds(billedVatPence),
            minorUnitsToPgBigInt(billedVatPence),
            mf.total_invoiced_inc_vat,
            minorUnitsToPgBigInt(totalInvoicedPence),
            mf.total_paid,
            minorUnitsToPgBigInt(totalPaidPence),
            mf.outstanding_debt,
            minorUnitsToPgBigInt(outstandingDebtPence),
            mf.unbilled_disbursements,
            minorUnitsToPgBigInt(unbilledDisbPence),
            mf.client_account_balance,
            minorUnitsToPgBigInt(clientAccountPence),
            JSON.stringify(mf),
          ];
        },
        {
          13: '::bigint',
          16: '::bigint',
          18: '::bigint',
          20: '::bigint',
          22: '::bigint',
          24: '::bigint',
          26: '::bigint',
          28: '::bigint',
          30: '::bigint',
          32: '::bigint',
          34: '::bigint',
          35: '::jsonb',
        },
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
          'estimated_fees_ex_vat_pence',
          'payload_json',
        ],
        dataset.feeEstimates,
        (est) => {
          const nextVer = (estVersionByMatter.get(est.matter_code) ?? 0) + 1;
          estVersionByMatter.set(est.matter_code, nextVer);
          const estPence = resolvePenceField(
            est.fees_estimate_pence,
            est.fees_estimate,
          );
          return [
            ctx.tenantId,
            est.estimate_id,
            est.matter_code,
            nextVer,
            est.date_given,
            minorUnitsToPounds(estPence),
            minorUnitsToPgBigInt(estPence),
            JSON.stringify(est),
          ];
        },
        { 6: '::bigint', 7: '::jsonb' },
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
          'total_inc_vat_pence',
          'payload_json',
        ],
        dataset.invoices,
        (inv) => {
          const totalPence = resolvePenceField(inv.total_pence, inv.total);
          return [
            ctx.tenantId,
            inv.invoice_number,
            inv.matter_code,
            inv.client_code,
            inv.invoice_date,
            inv.due_date,
            inv.status,
            minorUnitsToPounds(totalPence),
            minorUnitsToPgBigInt(totalPence),
            JSON.stringify(inv),
          ];
        },
        { 8: '::bigint', 9: '::jsonb' },
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
          'amount_pence',
          'payload_json',
        ],
        dataset.payments,
        (pay) => {
          const amtPence = resolvePenceField(pay.amount_pence, pay.amount);
          return [
            ctx.tenantId,
            pay.receipt_id,
            pay.invoice_number,
            pay.matter_code,
            pay.client_code,
            pay.receipt_date,
            minorUnitsToPounds(amtPence),
            minorUnitsToPgBigInt(amtPence),
            JSON.stringify(pay),
          ];
        },
        { 7: '::bigint', 8: '::jsonb' },
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
          'value_pence',
          'billing_status',
          'invoice_number',
          'payload_json',
        ],
        dataset.timeEntries,
        (te) => {
          const valPence = resolvePenceField(te.value_pence, te.value);
          return [
            ctx.tenantId,
            te.time_id,
            te.matter_code,
            te.fee_earner_id,
            te.date,
            Number(te.hours),
            minorUnitsToPounds(valPence),
            minorUnitsToPgBigInt(valPence),
            te.billed_status,
            te.invoice_number ?? null,
            JSON.stringify(te),
          ];
        },
        { 7: '::bigint', 10: '::jsonb' },
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
          'amount_ex_vat_pence',
          'billing_status',
          'invoice_number',
          'payload_json',
        ],
        dataset.disbursements,
        (d) => {
          const netPence = resolvePenceField(d.net_amount_pence, d.net_amount);
          return [
            ctx.tenantId,
            d.disbursement_id,
            d.matter_code,
            d.date,
            minorUnitsToPounds(netPence),
            minorUnitsToPgBigInt(netPence),
            d.billed_status,
            d.invoice_number ?? null,
            JSON.stringify(d),
          ];
        },
        { 5: '::bigint', 8: '::jsonb' },
      );

      const runningPenceByMatter = new Map<string, MinorUnits>();
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
          'amount_pence',
          'balance_after',
          'balance_after_pence',
          'payload_json',
        ],
        sortedCa,
        (ca) => {
          const amtPence = resolvePenceField(ca.amount_pence, ca.amount);
          const amt = minorUnitsToPounds(amtPence);
          const nextPence = sumMinorUnits([
            runningPenceByMatter.get(ca.matter_code) ?? (0 as MinorUnits),
            amtPence,
          ]);
          runningPenceByMatter.set(ca.matter_code, nextPence);
          const runningBalance = minorUnitsToPounds(nextPence);
          const fullEntry: TenantPmsClientAccountEntry = {
            ...ca,
            amount: amt,
            amount_pence: amtPence,
            running_balance: runningBalance,
            running_balance_pence: nextPence,
          };
          return [
            ctx.tenantId,
            ca.transaction_id,
            ca.matter_code,
            ca.client_code,
            ca.date,
            ca.type,
            amt,
            minorUnitsToPgBigInt(amtPence),
            runningBalance,
            minorUnitsToPgBigInt(nextPence),
            JSON.stringify(fullEntry),
          ];
        },
        { 7: '::bigint', 9: '::bigint', 10: '::jsonb' },
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

  private mapFeeEarnerRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsFeeEarner[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_fee_earners');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsFeeEarner>;
      const hourlyRatePence = pgBigIntToMinorUnits(
        row.charge_out_rate_pence as string | number | bigint,
      );
      const annualTargetFeesPence = parsePayloadMoneyPence(
        row.payload_annual_target_fees_text,
        corruptTracker,
      );
      return {
        fee_earner_id: String(row.fee_earner_id),
        initials: String(p.initials ?? ''),
        first_name: String(p.first_name ?? ''),
        last_name: String(p.last_name ?? ''),
        email: String(p.email ?? ''),
        grade: String(row.grade ?? p.grade ?? ''),
        department: String(row.department ?? p.department ?? ''),
        standard_hourly_rate: minorUnitsToPounds(hourlyRatePence),
        standard_hourly_rate_pence: hourlyRatePence,
        annual_target_hours: Number(p.annual_target_hours ?? 0),
        annual_target_fees:
          annualTargetFeesPence !== null
            ? minorUnitsToPounds(annualTargetFeesPence)
            : null,
        annual_target_fees_pence: annualTargetFeesPence,
        active: String(p.active ?? row.status ?? 'Yes'),
      };
    });
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapClientRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsClient[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_clients');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsClient>;
      const creditLimitPence = parsePayloadMoneyPence(
        row.payload_credit_limit_text,
        corruptTracker,
      );
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
        credit_limit:
          creditLimitPence !== null ? minorUnitsToPounds(creditLimitPence) : null,
        credit_limit_pence: creditLimitPence,
        rate_discount_pct: Number(p.rate_discount_pct ?? 0),
        date_opened: String(p.date_opened ?? ''),
        sector: String(p.sector ?? ''),
        crm_match_on: (p.crm_match_on ??
          'company_number') as TenantPmsClient['crm_match_on'],
        status: String(p.status ?? 'Active'),
      };
    });
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapMatterRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsMatter[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_matters');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsMatter>;
      const fixedFeePence = parsePayloadMoneyPence(
        row.payload_fixed_fee_amount_text,
        corruptTracker,
      );
      const feeEstimatePence = pgBigIntToMinorUnits(
        row.fee_estimate_pence as string | number | bigint,
      );
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
        fixed_fee_amount:
          fixedFeePence !== null ? minorUnitsToPounds(fixedFeePence) : null,
        fixed_fee_amount_pence: fixedFeePence,
        fee_estimate: minorUnitsToPounds(feeEstimatePence),
        fee_estimate_pence: feeEstimatePence,
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
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapFeeEstimateRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
    feById: ReadonlyMap<string, TenantPmsFeeEarner>,
  ): TenantPmsFeeEstimate[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_fee_estimates');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsFeeEstimate>;
      const givenBy = String(p.given_by ?? '');
      const fe = feById.get(givenBy);
      const feesEstimatePence = pgBigIntToMinorUnits(
        row.estimated_fees_ex_vat_pence as string | number | bigint,
      );
      const disbEstimatePence = parsePayloadMoneyPence(
        row.payload_disbursements_estimate_text,
        corruptTracker,
      );
      return {
        estimate_id: String(row.estimate_id),
        matter_code: String(row.matter_code),
        date_given: String(row.estimate_date ?? p.date_given ?? ''),
        estimate_type: (p.estimate_type ??
          'Initial') as TenantPmsFeeEstimate['estimate_type'],
        fees_estimate: minorUnitsToPounds(feesEstimatePence),
        fees_estimate_pence: feesEstimatePence,
        disbursements_estimate:
          disbEstimatePence !== null
            ? minorUnitsToPounds(disbEstimatePence)
            : null,
        disbursements_estimate_pence: disbEstimatePence,
        given_by: givenBy,
        given_by_name: fe
          ? `${fe.first_name} ${fe.last_name}`
          : p.given_by_name,
        accepted_by_client: (p.accepted_by_client ??
          'Yes') as TenantPmsFeeEstimate['accepted_by_client'],
        notes: String(p.notes ?? ''),
      };
    });
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapInvoiceRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsInvoiceRow[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_invoices');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsInvoiceRow>;
      const feesNetPence = parsePayloadMoneyPence(
        row.payload_fees_net_text,
        corruptTracker,
      );
      const disbNetPence = parsePayloadMoneyPence(
        row.payload_disbursements_net_text,
        corruptTracker,
      );
      const vatPence = parsePayloadMoneyPence(
        row.payload_vat_text,
        corruptTracker,
      );
      const totalPence = pgBigIntToMinorUnits(
        row.total_inc_vat_pence as string | number | bigint,
      );
      return {
        invoice_number: String(row.invoice_number),
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        invoice_date: String(row.invoice_date),
        due_date: String(row.due_date),
        invoice_type: String(p.invoice_type ?? 'Interim'),
        period_from: p.period_from ? String(p.period_from) : null,
        period_to: p.period_to ? String(p.period_to) : null,
        fees_net: feesNetPence !== null ? minorUnitsToPounds(feesNetPence) : null,
        fees_net_pence: feesNetPence,
        disbursements_net:
          disbNetPence !== null ? minorUnitsToPounds(disbNetPence) : null,
        disbursements_net_pence: disbNetPence,
        vat: vatPence !== null ? minorUnitsToPounds(vatPence) : null,
        vat_pence: vatPence,
        total: minorUnitsToPounds(totalPence),
        total_pence: totalPence,
        status: String(row.status ?? p.status ?? ''),
        credit_note_for: p.credit_note_for ? String(p.credit_note_for) : null,
      };
    });
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapPaymentRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsPayment[] {
    return rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_payments');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsPayment>;
      const amountPence = pgBigIntToMinorUnits(
        row.amount_pence as string | number | bigint,
      );
      return {
        receipt_id: String(row.receipt_id),
        invoice_number: String(row.invoice_number),
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        receipt_date: String(row.payment_date ?? p.receipt_date ?? ''),
        amount: minorUnitsToPounds(amountPence),
        amount_pence: amountPence,
        method: String(p.method ?? ''),
        reference: String(p.reference ?? ''),
      };
    });
  }

  private mapTimeEntryRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
    feById: ReadonlyMap<string, TenantPmsFeeEarner>,
  ): TenantPmsTimeEntry[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_time_entries');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsTimeEntry>;
      const feId = String(row.fee_earner_id);
      const fe = feById.get(feId);
      const ratePence = parsePayloadMoneyPence(
        row.payload_rate_text,
        corruptTracker,
      );
      const valuePence = pgBigIntToMinorUnits(
        row.value_pence as string | number | bigint,
      );
      const billedValuePence = parsePayloadMoneyPence(
        row.payload_billed_value_text,
        corruptTracker,
      );
      const writeOffValuePence = parsePayloadMoneyPence(
        row.payload_write_off_value_text,
        corruptTracker,
      );
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
        rate: ratePence !== null ? minorUnitsToPounds(ratePence) : null,
        rate_pence: ratePence,
        value: minorUnitsToPounds(valuePence),
        value_pence: valuePence,
        chargeable: (p.chargeable ?? 'Y') as 'Y' | 'N',
        billed_status: (row.billing_status ??
          p.billed_status ??
          'Unbilled') as TenantPmsTimeEntry['billed_status'],
        invoice_number:
          row.invoice_number || p.invoice_number
            ? String(row.invoice_number ?? p.invoice_number)
            : null,
        billed_value:
          billedValuePence !== null
            ? minorUnitsToPounds(billedValuePence)
            : null,
        billed_value_pence: billedValuePence,
        write_off_value:
          writeOffValuePence !== null
            ? minorUnitsToPounds(writeOffValuePence)
            : null,
        write_off_value_pence: writeOffValuePence,
      };
    });
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapDisbursementRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsDisbursement[] {
    const corruptTracker = { count: 0 };
    const mapped = rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_disbursements');
      const p = (row.payload_json ?? {}) as Partial<TenantPmsDisbursement>;
      const netAmountPence = pgBigIntToMinorUnits(
        row.amount_ex_vat_pence as string | number | bigint,
      );
      const vatAmountPence = parsePayloadMoneyPence(
        row.payload_vat_amount_text,
        corruptTracker,
      );
      const grossAmountPence = parsePayloadMoneyPence(
        row.payload_gross_amount_text,
        corruptTracker,
      );
      return {
        disbursement_id: String(row.disbursement_id),
        matter_code: String(row.matter_code),
        date: String(row.entry_date ?? p.date ?? ''),
        type: String(p.type ?? ''),
        supplier: String(p.supplier ?? ''),
        description: String(p.description ?? ''),
        net_amount: minorUnitsToPounds(netAmountPence),
        net_amount_pence: netAmountPence,
        vat_amount:
          vatAmountPence !== null ? minorUnitsToPounds(vatAmountPence) : null,
        vat_amount_pence: vatAmountPence,
        gross_amount:
          grossAmountPence !== null
            ? minorUnitsToPounds(grossAmountPence)
            : null,
        gross_amount_pence: grossAmountPence,
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
    warnIfCorruptMoneyText(ctx, corruptTracker);
    return mapped;
  }

  private mapClientAccountRows(
    ctx: TenantContext,
    rows: readonly DbGenericPayloadRow[],
  ): TenantPmsClientAccountEntry[] {
    return rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'pms_client_account_entries');
      const p = (row.payload_json ??
        {}) as Partial<TenantPmsClientAccountEntry>;
      const amtPence = pgBigIntToMinorUnits(
        row.amount_pence as string | number | bigint,
      );
      const balanceAfterPence = pgBigIntToMinorUnits(
        row.balance_after_pence as string | number | bigint,
      );
      return {
        transaction_id: String(row.transaction_id),
        matter_code: String(row.matter_code),
        client_code: String(row.client_code),
        date: String(row.entry_date ?? p.date ?? ''),
        type: (row.direction ??
          p.type ??
          'Receipt') as TenantPmsClientAccountEntry['type'],
        description: String(p.description ?? ''),
        amount: minorUnitsToPounds(amtPence),
        amount_pence: amtPence,
        running_balance: minorUnitsToPounds(balanceAfterPence),
        running_balance_pence: balanceAfterPence,
      };
    });
  }

  private async refreshSnapshotInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<HydratedTenantPmsSnapshot> {
    const extractInfo = await this.getExtractInfoInTx(tx, ctx);
    const pmsLinks = await this.listPmsLinksInTx(tx, ctx);

    const feRes = await tx.query<DbGenericPayloadRow>(
      `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
      [ctx.tenantId],
    );
    const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
    const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));

    const [
      clientRes,
      matterRes,
      estRes,
      invRes,
      payRes,
      teRes,
      disbRes,
      caRes,
      ccRes,
    ] = await Promise.all([
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 ORDER BY client_code ASC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 ORDER BY matter_code ASC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1 ORDER BY estimate_date ASC, estimate_id ASC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1 ORDER BY invoice_date DESC, invoice_number DESC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        'SELECT * FROM public.pms_payments WHERE tenant_id = $1 ORDER BY payment_date ASC, receipt_id ASC',
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 ORDER BY entry_date DESC, time_id DESC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 ORDER BY entry_date DESC, disbursement_id DESC`,
        [ctx.tenantId],
      ),
      tx.query<DbGenericPayloadRow>(
        'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 ORDER BY matter_code ASC, entry_date ASC, transaction_id ASC',
        [ctx.tenantId],
      ),
      tx.query<DbCreditControlLogRow>(
        'SELECT * FROM public.pms_credit_control_log WHERE tenant_id = $1 ORDER BY id DESC',
        [ctx.tenantId],
      ),
    ]);

    const clients = this.mapClientRows(ctx, clientRes.rows);
    const matters = this.mapMatterRows(ctx, matterRes.rows);
    const feeEstimates = this.mapFeeEstimateRows(ctx, estRes.rows, feById);
    const invoices = this.mapInvoiceRows(ctx, invRes.rows);
    const payments = this.mapPaymentRows(ctx, payRes.rows);
    const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
    const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
    const clientAccount = this.mapClientAccountRows(ctx, caRes.rows);
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

    return {
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
    return this.listFeeEarnersOnly(ctx);
  }

  public async listFeeEarnersOnly(
    ctx: TenantContext,
  ): Promise<TenantPmsFeeEarner[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const feRes = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
        [ctx.tenantId],
      );
      return this.mapFeeEarnerRows(ctx, feRes.rows);
    });
  }

  public async listClients(ctx: TenantContext): Promise<TenantPmsClient[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 ORDER BY client_code ASC`,
        [ctx.tenantId],
      );
      return this.mapClientRows(ctx, res.rows);
    });
  }

  public async listMatters(ctx: TenantContext): Promise<TenantPmsMatter[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 ORDER BY matter_code ASC`,
        [ctx.tenantId],
      );
      return this.mapMatterRows(ctx, res.rows);
    });
  }

  public async getClientByCode(
    ctx: TenantContext,
    clientCode: string,
  ): Promise<TenantPmsClient | null> {
    const cleanCode = clientCode?.trim();
    if (!cleanCode) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 AND client_code = $2 LIMIT 1`,
        [ctx.tenantId, cleanCode],
      );
      return this.mapClientRows(ctx, res.rows)[0] ?? null;
    });
  }

  public async getMatterByCode(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatter | null> {
    const cleanCode = matterCode?.trim();
    if (!cleanCode) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 AND matter_code = $2 LIMIT 1`,
        [ctx.tenantId, cleanCode],
      );
      return this.mapMatterRows(ctx, res.rows)[0] ?? null;
    });
  }

  public async listUnlinkedMatters(
    ctx: TenantContext,
  ): Promise<TenantPmsMatter[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT m.*, m.payload_json->>'fixed_fee_amount' AS payload_fixed_fee_amount_text
         FROM public.pms_matters m
         WHERE m.tenant_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM public.pms_links l
             WHERE l.tenant_id = m.tenant_id
               AND l.entity_type = 'matter'
               AND l.pms_code = m.matter_code
           )
         ORDER BY m.matter_code ASC`,
        [ctx.tenantId],
      );
      return this.mapMatterRows(ctx, res.rows);
    });
  }

  public async getMatterFinanceSummaryRows(
    ctx: TenantContext,
    matterCodes: readonly string[],
  ): Promise<TenantPmsMatterFinancials[]> {
    const cleanCodes = Array.from(
      new Set(matterCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (cleanCodes.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, feRes, mRes, estRes, invRes, payRes, teRes, disbRes, caRes] =
        await Promise.all([
          this.getExtractInfoInTx(tx, ctx),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
            [ctx.tenantId],
          ),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY matter_code ASC`,
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY estimate_date ASC, estimate_id ASC`,
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY invoice_date DESC, invoice_number DESC`,
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            'SELECT * FROM public.pms_payments WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY payment_date ASC, receipt_id ASC',
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date DESC, time_id DESC`,
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date DESC, disbursement_id DESC`,
            [ctx.tenantId, cleanCodes],
          ),
          tx.query<DbGenericPayloadRow>(
            'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY matter_code ASC, entry_date ASC, transaction_id ASC',
            [ctx.tenantId, cleanCodes],
          ),
        ]);

      const matters = this.mapMatterRows(ctx, mRes.rows);
      if (matters.length === 0) return [];
      const clientCodes = Array.from(
        new Set(matters.map((m) => m.client_code).filter(Boolean)),
      );
      const clientRes =
        clientCodes.length > 0
          ? await tx.query<DbGenericPayloadRow>(
              `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 AND client_code = ANY($2::text[]) ORDER BY client_code ASC`,
              [ctx.tenantId, clientCodes],
            )
          : { rows: [] as DbGenericPayloadRow[] };

      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const clients = this.mapClientRows(ctx, clientRes.rows);
      const feeEstimates = this.mapFeeEstimateRows(ctx, estRes.rows, feById);
      const invoices = this.mapInvoiceRows(ctx, invRes.rows);
      const payments = this.mapPaymentRows(ctx, payRes.rows);
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
      const clientAccount = this.mapClientAccountRows(ctx, caRes.rows);

      const invoiceBalances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices,
        payments,
      });
      return computeDerivedMatterFinancials({
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
    });
  }

  public async getAllMatterFinancials(
    ctx: TenantContext,
  ): Promise<TenantPmsMatterFinancials[]> {
    const rollups = await this.getFirmFinanceRollupsSql(ctx);
    return rollups.matterFinancials;
  }

  public async getMatterFinancials(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterFinancials | null> {
    const rows = await this.getMatterFinanceSummaryRows(ctx, [matterCode]);
    return rows[0] ?? null;
  }

  public async getFeeEstimates(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsFeeEstimate[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [feRes, estRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1 AND matter_code = $2 ORDER BY estimate_date ASC, estimate_id ASC`,
          [ctx.tenantId, matterCode],
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      return this.mapFeeEstimateRows(ctx, estRes.rows, feById);
    });
  }

  public async getTimeEntries(
    ctx: TenantContext,
    matterCode: string,
    filters?: TenantPmsTimeEntryFilters,
  ): Promise<TenantPmsTimeEntry[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1', 'matter_code = $2'];
      const params: unknown[] = [ctx.tenantId, matterCode];
      if (filters?.feeEarnerId && filters.feeEarnerId !== 'all') {
        params.push(filters.feeEarnerId);
        clauses.push(`fee_earner_id = $${params.length}`);
      }
      if (filters?.billedStatus && filters.billedStatus !== 'all') {
        params.push(filters.billedStatus);
        clauses.push(`billing_status = $${params.length}`);
      }
      if (filters?.dateFrom) {
        params.push(filters.dateFrom);
        clauses.push(`entry_date >= $${params.length}`);
      }
      if (filters?.dateTo) {
        params.push(filters.dateTo);
        clauses.push(`entry_date <= $${params.length}`);
      }
      const [feRes, teRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE ${clauses.join(' AND ')} ORDER BY entry_date DESC, time_id DESC`,
          params,
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      return this.mapTimeEntryRows(ctx, teRes.rows, feById);
    });
  }

  public async getFeeEarnerTimeSummary(
    ctx: TenantContext,
    feeEarnerId: string,
    options?: { readonly accessibleMatterCodes?: readonly string[] },
  ): Promise<{
    readonly extractInfo: TenantPmsExtractInfo;
    readonly feeEarner: TenantPmsFeeEarner | null;
    readonly timeEntries: TenantPmsTimeEntry[];
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const extractInfo = await this.getExtractInfoInTx(tx, ctx);
      const feRes = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 AND fee_earner_id = $2`,
        [ctx.tenantId, feeEarnerId],
      );
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feeEarner = feeEarners[0] ?? null;
      if (!feeEarner) {
        return { extractInfo, feeEarner: null, timeEntries: [] };
      }
      const clauses = ['tenant_id = $1', 'fee_earner_id = $2'];
      const params: unknown[] = [ctx.tenantId, feeEarnerId];
      if (options?.accessibleMatterCodes) {
        const codes = Array.from(
          new Set(options.accessibleMatterCodes.filter(Boolean)),
        );
        if (codes.length === 0) {
          return { extractInfo, feeEarner, timeEntries: [] };
        }
        params.push(codes);
        clauses.push(`matter_code = ANY($${params.length}::text[])`);
      }
      const teRes = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE ${clauses.join(' AND ')} ORDER BY entry_date DESC, time_id DESC`,
        params,
      );
      const feById = new Map([[feeEarner.fee_earner_id, feeEarner]]);
      return {
        extractInfo,
        feeEarner,
        timeEntries: this.mapTimeEntryRows(ctx, teRes.rows, feById),
      };
    });
  }

  public async listAllTimeEntries(
    ctx: TenantContext,
  ): Promise<TenantPmsTimeEntry[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [feRes, teRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 ORDER BY entry_date DESC, time_id DESC`,
          [ctx.tenantId],
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      return this.mapTimeEntryRows(ctx, teRes.rows, feById);
    });
  }

  public async getMatterWipBreakdown(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterWipBreakdown> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, feRes, teRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date DESC, time_id DESC`,
          [ctx.tenantId, matterCode],
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      return computeDerivedMatterWipBreakdown({
        matterCode,
        asAtDate: extractInfo.asAtDate,
        feeEarners,
        timeEntries,
      });
    });
  }

  public async listAllInvoiceBalances(
    ctx: TenantContext,
  ): Promise<TenantPmsInvoiceBalance[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, invRes, payRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1 ORDER BY invoice_date DESC, invoice_number DESC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_payments WHERE tenant_id = $1 ORDER BY payment_date ASC, receipt_id ASC',
          [ctx.tenantId],
        ),
      ]);
      return computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices: this.mapInvoiceRows(ctx, invRes.rows),
        payments: this.mapPaymentRows(ctx, payRes.rows),
      });
    });
  }

  public async getInvoiceBalance(
    ctx: TenantContext,
    invoiceNumber: string,
  ): Promise<TenantPmsInvoiceBalance | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, invRes, payRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices
           WHERE tenant_id = $1
             AND (invoice_number = $2 OR payload_json->>'credit_note_for' = $2)`,
          [ctx.tenantId, invoiceNumber],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_payments WHERE tenant_id = $1 AND invoice_number = $2 ORDER BY payment_date ASC, receipt_id ASC',
          [ctx.tenantId, invoiceNumber],
        ),
      ]);
      const balances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices: this.mapInvoiceRows(ctx, invRes.rows),
        payments: this.mapPaymentRows(ctx, payRes.rows),
      });
      return balances.find((i) => i.invoice_number === invoiceNumber) ?? null;
    });
  }

  private async loadAgedDebtWhere(
    ctx: TenantContext,
    whereClauseSql: string,
    params: readonly unknown[],
  ): Promise<TenantPmsInvoiceBalance[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, invRes, payRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE ${whereClauseSql}`,
          params,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT * FROM public.pms_payments WHERE ${whereClauseSql} ORDER BY payment_date ASC, receipt_id ASC`,
          params,
        ),
      ]);
      const balances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices: this.mapInvoiceRows(ctx, invRes.rows),
        payments: this.mapPaymentRows(ctx, payRes.rows),
      });
      return balances
        .filter((i) => i.invoice_type !== 'Credit note')
        .sort((a, b) => a.invoice_number.localeCompare(b.invoice_number));
    });
  }

  public async getAgedDebt(
    ctx: TenantContext,
    clientCode?: string,
  ): Promise<TenantPmsInvoiceBalance[]> {
    return clientCode
      ? this.loadAgedDebtWhere(ctx, 'tenant_id = $1 AND client_code = $2', [
          ctx.tenantId,
          clientCode,
        ])
      : this.loadAgedDebtWhere(ctx, 'tenant_id = $1', [ctx.tenantId]);
  }

  public async listAgedDebtByMatterCodes(
    ctx: TenantContext,
    matterCodes: readonly string[],
  ): Promise<TenantPmsInvoiceBalance[]> {
    const cleanCodes = Array.from(
      new Set(matterCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (cleanCodes.length === 0) return [];
    return this.loadAgedDebtWhere(
      ctx,
      'tenant_id = $1 AND matter_code = ANY($2::text[])',
      [ctx.tenantId, cleanCodes],
    );
  }

  public async listAgedDebtByClientCodes(
    ctx: TenantContext,
    clientCodes: readonly string[],
  ): Promise<TenantPmsInvoiceBalance[]> {
    const cleanCodes = Array.from(
      new Set(clientCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (cleanCodes.length === 0) return [];
    return this.loadAgedDebtWhere(
      ctx,
      'tenant_id = $1 AND client_code = ANY($2::text[])',
      [ctx.tenantId, cleanCodes],
    );
  }

  public async getInvoices(
    ctx: TenantContext,
    filter?: {
      matterCode?: string;
      matterCodes?: readonly string[];
      clientCode?: string;
    },
  ): Promise<TenantPmsInvoiceDetail[]> {
    const cleanMatterCodes = Array.from(
      new Set((filter?.matterCodes ?? []).map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (filter?.matterCodes !== undefined && cleanMatterCodes.length === 0) {
      return [];
    }
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const invClauses = ['tenant_id = $1'];
      const invParams: unknown[] = [ctx.tenantId];
      if (filter?.matterCode) {
        invParams.push(filter.matterCode);
        invClauses.push(`matter_code = $${invParams.length}`);
      } else if (cleanMatterCodes.length > 0) {
        invParams.push(cleanMatterCodes);
        invClauses.push(`matter_code = ANY($${invParams.length}::text[])`);
      }
      if (filter?.clientCode) {
        invParams.push(filter.clientCode);
        invClauses.push(`client_code = $${invParams.length}`);
      }

      const [extractInfo, invRes, feRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE ${invClauses.join(' AND ')} ORDER BY invoice_date DESC, invoice_number DESC`,
          invParams,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
      ]);
      const invoices = this.mapInvoiceRows(ctx, invRes.rows);
      if (invoices.length === 0) return [];
      const invNumbers = invoices.map((i) => i.invoice_number);
      const matterCodes = Array.from(new Set(invoices.map((i) => i.matter_code)));

      const [payRes, teRes, disbRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_payments WHERE tenant_id = $1 AND invoice_number = ANY($2::text[]) ORDER BY payment_date ASC, receipt_id ASC',
          [ctx.tenantId, invNumbers],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) AND invoice_number = ANY($3::text[])`,
          [ctx.tenantId, matterCodes, invNumbers],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) AND invoice_number = ANY($3::text[])`,
          [ctx.tenantId, matterCodes, invNumbers],
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const payments = this.mapPaymentRows(ctx, payRes.rows);
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
      const balances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices,
        payments,
      });

      return balances.map((inv) => ({
        ...inv,
        payments: payments.filter((p) => p.invoice_number === inv.invoice_number),
        timeEntries: timeEntries
          .filter((t) => t.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            return cmp !== 0 ? cmp : a.time_id.localeCompare(b.time_id);
          }),
        disbursements: disbursements
          .filter((d) => d.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            return cmp !== 0
              ? cmp
              : a.disbursement_id.localeCompare(b.disbursement_id);
          }),
        appliedCreditNotes: balances.filter(
          (other) => other.credit_note_for === inv.invoice_number,
        ),
      }));
    });
  }

  public async listInvoicesByMatterCodes(
    ctx: TenantContext,
    matterCodes: readonly string[],
  ): Promise<TenantPmsInvoiceDetail[]> {
    return this.getInvoices(ctx, { matterCodes });
  }

  public async getDisbursements(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsDisbursement[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date DESC, disbursement_id DESC`,
        [ctx.tenantId, matterCode],
      );
      return this.mapDisbursementRows(ctx, res.rows);
    });
  }

  public async listDisbursementsByMatterCodes(
    ctx: TenantContext,
    matterCodes: readonly string[],
  ): Promise<TenantPmsDisbursement[]> {
    const cleanCodes = Array.from(
      new Set(matterCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (cleanCodes.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date DESC, disbursement_id DESC`,
        [ctx.tenantId, cleanCodes],
      );
      return this.mapDisbursementRows(ctx, res.rows);
    });
  }

  public async getClientAccountLedger(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsClientAccountEntry[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date ASC, transaction_id ASC',
        [ctx.tenantId, matterCode],
      );
      return this.mapClientAccountRows(ctx, res.rows);
    });
  }

  public async listClientAccountEntriesByMatterCodes(
    ctx: TenantContext,
    matterCodes: readonly string[],
  ): Promise<TenantPmsClientAccountEntry[]> {
    const cleanCodes = Array.from(
      new Set(matterCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    if (cleanCodes.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date ASC, transaction_id ASC',
        [ctx.tenantId, cleanCodes],
      );
      return this.mapClientAccountRows(ctx, res.rows);
    });
  }

  public async listAllPayments(
    ctx: TenantContext,
  ): Promise<TenantPmsPayment[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbGenericPayloadRow>(
        'SELECT * FROM public.pms_payments WHERE tenant_id = $1 ORDER BY payment_date ASC, receipt_id ASC',
        [ctx.tenantId],
      );
      return this.mapPaymentRows(ctx, res.rows);
    });
  }

  public async getMatterFullBundle(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterFullBundle | null> {
    return this.getMatterPmsDataByCode(ctx, matterCode);
  }

  public async getMatterPmsDataByCode(
    ctx: TenantContext,
    matterCode: string,
  ): Promise<TenantPmsMatterFullBundle | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [
        extractInfo,
        feRes,
        mRes,
        estRes,
        invRes,
        payRes,
        teRes,
        disbRes,
        caRes,
      ] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 AND matter_code = $2`,
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1 AND matter_code = $2 ORDER BY estimate_date ASC, estimate_id ASC`,
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1 AND matter_code = $2 ORDER BY invoice_date DESC, invoice_number DESC`,
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_payments WHERE tenant_id = $1 AND matter_code = $2 ORDER BY payment_date ASC, receipt_id ASC',
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date DESC, time_id DESC`,
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date DESC, disbursement_id DESC`,
          [ctx.tenantId, matterCode],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 AND matter_code = $2 ORDER BY entry_date ASC, transaction_id ASC',
          [ctx.tenantId, matterCode],
        ),
      ]);

      const matters = this.mapMatterRows(ctx, mRes.rows);
      if (matters.length === 0) return null;
      const clientRes = matters[0]!.client_code
        ? await tx.query<DbGenericPayloadRow>(
            `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 AND client_code = $2`,
            [ctx.tenantId, matters[0]!.client_code],
          )
        : { rows: [] as DbGenericPayloadRow[] };

      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const clients = this.mapClientRows(ctx, clientRes.rows);
      const estimates = this.mapFeeEstimateRows(ctx, estRes.rows, feById);
      const rawInvoices = this.mapInvoiceRows(ctx, invRes.rows);
      const payments = this.mapPaymentRows(ctx, payRes.rows);
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
      const clientAccount = this.mapClientAccountRows(ctx, caRes.rows);

      const invoiceBalances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices: rawInvoices,
        payments,
      });
      const matterFinancials = computeDerivedMatterFinancials({
        asAtDate: extractInfo.asAtDate,
        feeEarners,
        clients,
        matters,
        feeEstimates: estimates,
        invoiceBalances,
        timeEntries,
        disbursements,
        clientAccount,
      });
      const summary = matterFinancials[0];
      if (!summary) return null;

      const detailedInvoices: TenantPmsInvoiceDetail[] = invoiceBalances.map(
        (inv) => ({
          ...inv,
          payments: payments.filter(
            (p) => p.invoice_number === inv.invoice_number,
          ),
          timeEntries: timeEntries
            .filter((t) => t.invoice_number === inv.invoice_number)
            .sort((a, b) => {
              const cmp = a.date.localeCompare(b.date);
              return cmp !== 0 ? cmp : a.time_id.localeCompare(b.time_id);
            }),
          disbursements: disbursements
            .filter((d) => d.invoice_number === inv.invoice_number)
            .sort((a, b) => {
              const cmp = a.date.localeCompare(b.date);
              return cmp !== 0
                ? cmp
                : a.disbursement_id.localeCompare(b.disbursement_id);
            }),
          appliedCreditNotes: invoiceBalances.filter(
            (other) => other.credit_note_for === inv.invoice_number,
          ),
        }),
      );

      return {
        extractInfo,
        summary,
        estimates,
        timeEntries,
        wipBreakdown: computeDerivedMatterWipBreakdown({
          matterCode,
          asAtDate: extractInfo.asAtDate,
          feeEarners,
          timeEntries,
        }),
        invoices: detailedInvoices,
        disbursements,
        clientAccount,
      };
    });
  }

  public async getClientPmsDataByCodes(
    ctx: TenantContext,
    clientCodes: readonly string[],
  ): Promise<{
    readonly extractInfo: TenantPmsExtractInfo;
    readonly clients: TenantPmsClient[];
    readonly matterFinancials: TenantPmsMatterFinancials[];
    readonly invoiceBalances: TenantPmsInvoiceBalance[];
  }> {
    const cleanCodes = Array.from(
      new Set(clientCodes.map((c) => c?.trim()).filter(Boolean) as string[]),
    );
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const extractInfo = await this.getExtractInfoInTx(tx, ctx);
      if (cleanCodes.length === 0) {
        return {
          extractInfo,
          clients: [],
          matterFinancials: [],
          invoiceBalances: [],
        };
      }
      const [feRes, cRes, mRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 AND client_code = ANY($2::text[]) ORDER BY client_code ASC`,
          [ctx.tenantId, cleanCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 AND client_code = ANY($2::text[]) ORDER BY matter_code ASC`,
          [ctx.tenantId, cleanCodes],
        ),
      ]);
      const clients = this.mapClientRows(ctx, cRes.rows);
      const matters = this.mapMatterRows(ctx, mRes.rows);
      const matterCodes = matters.map((m) => m.matter_code);
      if (matterCodes.length === 0) {
        return {
          extractInfo,
          clients,
          matterFinancials: [],
          invoiceBalances: [],
        };
      }
      const [estRes, invRes, payRes, teRes, disbRes, caRes] = await Promise.all([
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY estimate_date ASC, estimate_id ASC`,
          [ctx.tenantId, matterCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY invoice_date DESC, invoice_number DESC`,
          [ctx.tenantId, matterCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_payments WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY payment_date ASC, receipt_id ASC',
          [ctx.tenantId, matterCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date DESC, time_id DESC`,
          [ctx.tenantId, matterCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY entry_date DESC, disbursement_id DESC`,
          [ctx.tenantId, matterCodes],
        ),
        tx.query<DbGenericPayloadRow>(
          'SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1 AND matter_code = ANY($2::text[]) ORDER BY matter_code ASC, entry_date ASC, transaction_id ASC',
          [ctx.tenantId, matterCodes],
        ),
      ]);
      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const feeEstimates = this.mapFeeEstimateRows(ctx, estRes.rows, feById);
      const invoices = this.mapInvoiceRows(ctx, invRes.rows);
      const payments = this.mapPaymentRows(ctx, payRes.rows);
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
      const clientAccount = this.mapClientAccountRows(ctx, caRes.rows);
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
      return {
        extractInfo,
        clients,
        matterFinancials,
        invoiceBalances,
      };
    });
  }

  public async getFirmFinanceRollupsSql(
    ctx: TenantContext,
    options?: { readonly hiddenMatterCodes?: readonly string[] },
  ): Promise<{
    readonly extractInfo: TenantPmsExtractInfo;
    readonly feeEarners: TenantPmsFeeEarner[];
    readonly clients: TenantPmsClient[];
    readonly matterFinancials: TenantPmsMatterFinancials[];
    readonly invoiceBalances: TenantPmsInvoiceBalance[];
    readonly timeEntries: TenantPmsTimeEntry[];
    readonly payments: TenantPmsPayment[];
  }> {
    const hidden = Array.from(
      new Set((options?.hiddenMatterCodes ?? []).filter(Boolean)),
    );
    const excludeClause =
      hidden.length > 0 ? ' AND NOT (matter_code = ANY($2::text[]))' : '';
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const args = hidden.length > 0 ? [ctx.tenantId, hidden] : [ctx.tenantId];
      const [
        extractInfo,
        feRes,
        cRes,
        mRes,
        estRes,
        invRes,
        payRes,
        teRes,
        disbRes,
        caRes,
      ] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 ORDER BY client_code ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1${excludeClause} ORDER BY matter_code ASC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_ESTIMATES_SELECT} FROM public.pms_fee_estimates WHERE tenant_id = $1${excludeClause} ORDER BY estimate_date ASC, estimate_id ASC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_INVOICES_SELECT} FROM public.pms_invoices WHERE tenant_id = $1${excludeClause} ORDER BY invoice_date DESC, invoice_number DESC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT * FROM public.pms_payments WHERE tenant_id = $1${excludeClause} ORDER BY payment_date ASC, receipt_id ASC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_TIME_ENTRIES_SELECT} FROM public.pms_time_entries WHERE tenant_id = $1${excludeClause} ORDER BY entry_date DESC, time_id DESC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_DISBURSEMENTS_SELECT} FROM public.pms_disbursements WHERE tenant_id = $1${excludeClause} ORDER BY entry_date DESC, disbursement_id DESC`,
          args,
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT * FROM public.pms_client_account_entries WHERE tenant_id = $1${excludeClause} ORDER BY matter_code ASC, entry_date ASC, transaction_id ASC`,
          args,
        ),
      ]);

      const feeEarners = this.mapFeeEarnerRows(ctx, feRes.rows);
      const feById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));
      const clients = this.mapClientRows(ctx, cRes.rows);
      const matters = this.mapMatterRows(ctx, mRes.rows);
      const feeEstimates = this.mapFeeEstimateRows(ctx, estRes.rows, feById);
      const rawInvoices = this.mapInvoiceRows(ctx, invRes.rows);
      const payments = this.mapPaymentRows(ctx, payRes.rows);
      const timeEntries = this.mapTimeEntryRows(ctx, teRes.rows, feById);
      const disbursements = this.mapDisbursementRows(ctx, disbRes.rows);
      const clientAccount = this.mapClientAccountRows(ctx, caRes.rows);

      const invoiceBalances = computeDerivedInvoiceBalances({
        asAtDate: extractInfo.asAtDate,
        invoices: rawInvoices,
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
      return {
        extractInfo,
        feeEarners,
        clients,
        matterFinancials,
        invoiceBalances,
        timeEntries,
        payments,
      };
    });
  }

  public async getPmsAdminSummarySnapshot(ctx: TenantContext): Promise<{
    readonly extractInfo: TenantPmsExtractInfo;
    readonly pmsLinks: TenantPmsLinkRecord[];
    readonly feeEarners: TenantPmsFeeEarner[];
    readonly clients: TenantPmsClient[];
    readonly matters: TenantPmsMatter[];
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [extractInfo, pmsLinks, feRes, cRes, mRes] = await Promise.all([
        this.getExtractInfoInTx(tx, ctx),
        this.listPmsLinksInTx(tx, ctx),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_FEE_EARNERS_SELECT} FROM public.pms_fee_earners WHERE tenant_id = $1 ORDER BY fee_earner_id ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_CLIENTS_SELECT} FROM public.pms_clients WHERE tenant_id = $1 ORDER BY client_code ASC`,
          [ctx.tenantId],
        ),
        tx.query<DbGenericPayloadRow>(
          `SELECT ${PMS_MATTERS_SELECT} FROM public.pms_matters WHERE tenant_id = $1 ORDER BY matter_code ASC`,
          [ctx.tenantId],
        ),
      ]);
      return {
        extractInfo,
        pmsLinks,
        feeEarners: this.mapFeeEarnerRows(ctx, feRes.rows),
        clients: this.mapClientRows(ctx, cRes.rows),
        matters: this.mapMatterRows(ctx, mRes.rows),
      };
    });
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
