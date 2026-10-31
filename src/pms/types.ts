/**
 * Types for the Practice Management System (PMS) adapter layer (`PmsSource`).
 * No UI component or server service queries the PMS database directly;
 * all reads go through `PmsSource`.
 */

export interface PmsExtractInfo {
  asAtDate: string; // e.g. '2026-10-16'
  importedAt: string; // ISO datetime
  sourceFile: string;
}

export interface PmsFeeEarner {
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
  active: string; // 'Yes' | 'No'
}

export interface PmsClient {
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

export interface PmsMatter {
  matter_code: string;
  client_code: string;
  matter_description: string;
  work_type: string;
  practice_area: string;
  responsible_partner_id: string;
  fee_earner_id: string;
  billing_basis: 'Hourly Rate' | 'Fixed Fee' | 'Capped Fee' | 'Retainer / Subscription';
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

export interface PmsFeeEstimate {
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

export interface PmsTimeEntry {
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

export interface PmsDisbursement {
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

export type PmsRecalculatedInvoiceStatus =
  | 'Paid'
  | 'Part paid'
  | 'Unpaid'
  | 'Overdue'
  | 'Applied';

export type PmsAgeBucket = 'Settled' | 'Not yet due' | '1-30' | '31-60' | '61-90' | '90+';

export interface PmsPayment {
  receipt_id: string;
  invoice_number: string;
  matter_code: string;
  client_code: string;
  receipt_date: string;
  amount: number;
  method: string;
  reference: string;
}

export interface PmsInvoiceBalance {
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
  age_bucket: PmsAgeBucket;
  recalculated_status: PmsRecalculatedInvoiceStatus;
}

export interface PmsInvoiceDetail extends PmsInvoiceBalance {
  payments: PmsPayment[];
  timeEntries: PmsTimeEntry[];
  disbursements: PmsDisbursement[];
  appliedCreditNotes: PmsInvoiceBalance[];
}

export interface PmsClientAccountEntry {
  transaction_id: string;
  matter_code: string;
  client_code: string;
  date: string;
  type: 'Receipt' | 'Payment' | 'Transfer to office';
  description: string;
  amount: number;
  running_balance: number;
}

export interface PmsMatterFinancials {
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
  billing_basis: 'Hourly Rate' | 'Fixed Fee' | 'Capped Fee' | 'Retainer / Subscription';
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
  estimate_used_pct: number; // fraction e.g. 0.734708333333333
  written_off: number;
  client_account_balance: number;
  has_pending_estimate_revision: boolean;
  oldest_unbilled_wip_days: number | null;
  max_invoice_days_past_due: number | null;
}

export interface PmsMatterWipBreakdown {
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

export interface PmsClientFinancials {
  client_code: string;
  client_name: string;
  client_type: 'Organisation' | 'Individual';
  company_number: string;
  email: string;
  client_partner_id: string;
  credit_terms_days: number;
  credit_limit: number;
  rate_discount_pct: number;
  status: string;
  unbilled_wip: number;
  fees_billed: number;
  disbursements_billed: number;
  total_invoiced_inc_vat: number;
  total_paid: number;
  outstanding_debt: number;
  unbilled_disbursements: number;
  client_account_balance: number;
  aged_not_yet_due: number;
  aged_1_30: number;
  aged_31_60: number;
  aged_61_90: number;
  aged_90_plus: number;
  credit_limit_used_pct: number | null; // fraction when credit_limit > 0, else null
}

export interface PmsFeeEarnerPerformance {
  fee_earner_id: string;
  initials: string;
  name: string;
  email: string;
  grade: string;
  department: string;
  standard_hourly_rate: number;
  chargeable_hours: number;
  chargeable_hours_this_month: number; // October 2026
  time_value: number;
  unbilled_wip: number;
  billed_value: number;
  written_off: number;
  annual_target_hours: number;
  pct_of_annual_target: number; // fraction
}

export interface PmsTimeEntryFilters {
  feeEarnerId?: string;
  billedStatus?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PmsMatterFullBundle {
  extractInfo: PmsExtractInfo;
  summary: PmsMatterFinancials;
  estimates: PmsFeeEstimate[];
  timeEntries: PmsTimeEntry[];
  wipBreakdown: PmsMatterWipBreakdown;
  invoices: PmsInvoiceDetail[];
  disbursements: PmsDisbursement[];
  clientAccount: PmsClientAccountEntry[];
}

export interface PmsClientFullBundle {
  extractInfo: PmsExtractInfo;
  summary: PmsClientFinancials;
  matters: PmsMatterFinancials[];
  invoices: PmsInvoiceBalance[];
}

export interface PmsFeeEarnerWeekdayBar {
  dayLabel: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri';
  date: string; // YYYY-MM-DD
  hours: number;
}

export interface PmsFeeEarnerWeeklyTime {
  feeEarnerId: string;
  weekTotalHours: number;
  dailyPaceHours: number;
  weeklyPaceHours: number;
  weekdays: PmsFeeEarnerWeekdayBar[];
  monthToDateHours: number;
  myUnbilledWip: number;
  myUnbilledMatterCount: number;
  oldestUnbilledDate: string | null;
}

export interface PmsMonthlyFeesBilled {
  monthKey: string; // '2026-01'..'2026-10'
  monthShort: string; // 'Jan'..'Oct'
  feesNet: number;
}

export interface PmsCashReceivedSummary {
  octoberTotal: number;
  octoberReceiptCount: number;
  septemberTotal: number;
  septemberReceiptCount: number;
}

export interface PmsDepartmentFinancials {
  practiceArea: string;
  openMatters: number;
  billedThisYear: number;
  unbilledWip: number;
  outstandingDebt: number;
  overdueDebt: number;
  octoberHours: number;
}

export interface PmsSource {
  getExtractInfo(): PmsExtractInfo;
  getMatterFinancials(matterCode: string): PmsMatterFinancials | null;
  getAllMatterFinancials(): PmsMatterFinancials[];
  getMatterFullBundle(matterCode: string): PmsMatterFullBundle | null;
  getClientFinancials(clientCode: string): PmsClientFinancials | null;
  getAllClientFinancials(): PmsClientFinancials[];
  getClientFullBundle(clientCode: string): PmsClientFullBundle | null;
  getTimeEntries(matterCode: string, filters?: PmsTimeEntryFilters): PmsTimeEntry[];
  getMatterWipBreakdown(matterCode: string): PmsMatterWipBreakdown;
  getFeeEstimates(matterCode: string): PmsFeeEstimate[];
  getInvoices(filter?: { matterCode?: string; clientCode?: string }): PmsInvoiceDetail[];
  getAgedDebt(clientCode?: string): PmsInvoiceBalance[];
  getDisbursements(matterCode: string): PmsDisbursement[];
  getClientAccountLedger(matterCode: string): PmsClientAccountEntry[];
  getFeeEarnerPerformance(feeEarnerId?: string): PmsFeeEarnerPerformance[];
  getFeeEarnerWeeklyTime(feeEarnerId: string, customDailyPace?: number | null): PmsFeeEarnerWeeklyTime | null;
  getMonthlyFeesBilled(year?: string): { months: PmsMonthlyFeesBilled[]; yearToDateTotal: number };
  getCashReceivedSummary(): PmsCashReceivedSummary;
  getDepartmentFinancials(): { departments: PmsDepartmentFinancials[]; firmTotal: PmsDepartmentFinancials };
  listFeeEarners(): PmsFeeEarner[];
  listClients(): PmsClient[];
  listMatters(): PmsMatter[];
}

