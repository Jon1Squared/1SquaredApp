import type { MinorUnits } from '@platform/core';

/**
 * Types for the Practice Management System (PMS) adapter layer (`PmsSource`).
 * No UI component or server service queries the PMS database directly;
 * all reads go through `PmsSource`.
 */

export interface PmsExtractInfo {
  asAtDate: string; // e.g. 'YYYY-MM-DD'
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
  standard_hourly_rate_pence?: MinorUnits;
  annual_target_hours: number;
  annual_target_fees: number;
  annual_target_fees_pence?: MinorUnits;
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
  credit_limit_pence?: MinorUnits;
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
  fixed_fee_amount_pence?: MinorUnits;
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

export interface PmsFeeEstimate {
  estimate_id: string;
  matter_code: string;
  date_given: string;
  estimate_type: 'Initial' | 'Revised';
  fees_estimate: number;
  fees_estimate_pence?: MinorUnits;
  disbursements_estimate: number;
  disbursements_estimate_pence?: MinorUnits;
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
  rate_pence?: MinorUnits;
  value: number;
  value_pence?: MinorUnits;
  chargeable: 'Y' | 'N';
  billed_status: 'Unbilled' | 'Billed' | 'Written off' | 'Non-chargeable';
  invoice_number: string | null;
  billed_value: number;
  billed_value_pence?: MinorUnits;
  write_off_value: number;
  write_off_value_pence?: MinorUnits;
}

export interface PmsDisbursement {
  disbursement_id: string;
  matter_code: string;
  date: string;
  type: string;
  supplier: string;
  description: string;
  net_amount: number;
  net_amount_pence?: MinorUnits;
  vat_amount: number;
  vat_amount_pence?: MinorUnits;
  gross_amount: number;
  gross_amount_pence?: MinorUnits;
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
  amount_pence?: MinorUnits;
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
  fees_net_pence?: MinorUnits;
  disbursements_net: number;
  disbursements_net_pence?: MinorUnits;
  vat: number;
  vat_pence?: MinorUnits;
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
  amount_pence?: MinorUnits;
  running_balance: number;
  running_balance_pence?: MinorUnits;
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
  estimate_used_pct: number; // fraction e.g. 0.734708333333333
  written_off: number;
  written_off_pence?: MinorUnits;
  client_account_balance: number;
  client_account_balance_pence?: MinorUnits;
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

export interface PmsClientFinancials {
  client_code: string;
  client_name: string;
  client_type: 'Organisation' | 'Individual';
  company_number: string;
  email: string;
  client_partner_id: string;
  credit_terms_days: number;
  credit_limit: number;
  credit_limit_pence?: MinorUnits;
  rate_discount_pct: number;
  status: string;
  unbilled_wip: number;
  unbilled_wip_pence?: MinorUnits;
  fees_billed: number;
  fees_billed_pence?: MinorUnits;
  fees_billed_ytd: number;
  fees_billed_ytd_pence?: MinorUnits;
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
  client_account_balance: number;
  client_account_balance_pence?: MinorUnits;
  aged_not_yet_due: number;
  aged_not_yet_due_pence?: MinorUnits;
  aged_1_30: number;
  aged_1_30_pence?: MinorUnits;
  aged_31_60: number;
  aged_31_60_pence?: MinorUnits;
  aged_61_90: number;
  aged_61_90_pence?: MinorUnits;
  aged_90_plus: number;
  aged_90_plus_pence?: MinorUnits;
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
  standard_hourly_rate_pence?: MinorUnits;
  chargeable_hours: number;
  chargeable_hours_this_month: number; // October 2026
  time_value: number;
  time_value_pence?: MinorUnits;
  unbilled_wip: number;
  unbilled_wip_pence?: MinorUnits;
  billed_value: number;
  billed_value_pence?: MinorUnits;
  written_off: number;
  written_off_pence?: MinorUnits;
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
  myUnbilledWipPence?: MinorUnits;
  myUnbilledMatterCount: number;
  oldestUnbilledDate: string | null;
}

export interface PmsMonthlyFeesBilled {
  monthKey: string; // YYYY-MM
  monthShort: string; // 'Jan'..'Dec'
  feesNet: number;
}

export interface PmsCashReceivedSummary {
  currentMonthTotal: number;
  currentMonthReceiptCount: number;
  previousMonthTotal: number;
  previousMonthReceiptCount: number;
}

export interface PmsDepartmentFinancials {
  practiceArea: string;
  openMatters: number;
  billedThisYear: number;
  billedThisYearPence?: MinorUnits;
  unbilledWip: number;
  unbilledWipPence?: MinorUnits;
  outstandingDebt: number;
  outstandingDebtPence?: MinorUnits;
  overdueDebt: number;
  overdueDebtPence?: MinorUnits;
  currentMonthHours: number;
}

export interface PmsSource {
  getExtractInfo(): PmsExtractInfo;
  getMatterFinancials(matterCode: string): PmsMatterFinancials | null;
  getAllMatterFinancials(): PmsMatterFinancials[];
  getMatterFullBundle(matterCode: string): PmsMatterFullBundle | null;
  getTimeEntries(matterCode: string, filters?: PmsTimeEntryFilters): PmsTimeEntry[];
  listAllTimeEntries(): PmsTimeEntry[];
  getMatterWipBreakdown(matterCode: string): PmsMatterWipBreakdown;
  getFeeEstimates(matterCode: string): PmsFeeEstimate[];
  getInvoices(filter?: { matterCode?: string; clientCode?: string }): PmsInvoiceDetail[];
  getInvoiceBalance(invoiceNumber: string): PmsInvoiceBalance | null;
  listAllInvoiceBalances(): PmsInvoiceBalance[];
  getAgedDebt(clientCode?: string): PmsInvoiceBalance[];
  getDisbursements(matterCode: string): PmsDisbursement[];
  getClientAccountLedger(matterCode: string): PmsClientAccountEntry[];
  listAllPayments(): PmsPayment[];
  listFeeEarners(): PmsFeeEarner[];
  listClients(): PmsClient[];
  listMatters(): PmsMatter[];
}

