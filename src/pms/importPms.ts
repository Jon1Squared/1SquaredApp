/**
 * Builds the separate PMS SQLite demo database (`data/pms/pms-demo.sqlite`)
 * from `data/pms/1Squared_PMS_Demo_Data.xlsx` (or `docs/1Squared_PMS_Demo_Data.xlsx`).
 *
 * Imports ONLY the 9 data sheets:
 *   fee_earners, clients, matters, fee_estimates, time_entries,
 *   disbursements, invoices, payments, client_account.
 *
 * Enforces primary and foreign keys, creates indexes on matter_code,
 * client_code, fee_earner_id and invoice_number, and builds the four
 * derived views (`v_matter_financials`, `v_invoice_balances`,
 * `v_client_financials`, `v_fee_earner_performance`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { excelSerialToIsoDate, openXlsxWorkbook, parseMoney } from './xlsxReader';

export const DEFAULT_XLSX_PATH = path.join(
  process.cwd(),
  'data',
  'pms',
  '1Squared_PMS_Demo_Data.xlsx',
);
export const FALLBACK_XLSX_PATH = path.join(
  process.cwd(),
  'docs',
  '1Squared_PMS_Demo_Data.xlsx',
);
export const DEFAULT_PMS_DB_PATH = path.join(process.cwd(), 'data', 'pms', 'pms-demo.sqlite');

export const PMS_AS_AT_DATE = '2026-10-16';

export function resolveWorkbookPath(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (fs.existsSync(DEFAULT_XLSX_PATH)) return DEFAULT_XLSX_PATH;
  if (fs.existsSync(FALLBACK_XLSX_PATH)) return FALLBACK_XLSX_PATH;
  throw new Error(
    `PMS demo workbook not found at ${DEFAULT_XLSX_PATH} or ${FALLBACK_XLSX_PATH}`,
  );
}

const SCHEMA_SQL = `
PRAGMA foreign_keys = OFF;

DROP VIEW IF EXISTS v_fee_earner_performance;
DROP VIEW IF EXISTS v_client_financials;
DROP VIEW IF EXISTS v_invoice_balances;
DROP VIEW IF EXISTS v_matter_financials;

DROP TABLE IF EXISTS client_account;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS disbursements;
DROP TABLE IF EXISTS time_entries;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS fee_estimates;
DROP TABLE IF EXISTS matters;
DROP TABLE IF EXISTS clients;
DROP TABLE IF EXISTS fee_earners;
DROP TABLE IF EXISTS extract_info;

PRAGMA foreign_keys = ON;

CREATE TABLE extract_info (
  as_at_date TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  source_file TEXT NOT NULL
);

CREATE TABLE fee_earners (
  fee_earner_id TEXT PRIMARY KEY,
  initials TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  grade TEXT NOT NULL,
  department TEXT NOT NULL,
  standard_hourly_rate NUMERIC NOT NULL,
  annual_target_hours INTEGER NOT NULL,
  annual_target_fees NUMERIC NOT NULL,
  active TEXT NOT NULL
);

CREATE TABLE clients (
  client_code TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_type TEXT NOT NULL,
  company_number TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  billing_address TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  client_partner_id TEXT NOT NULL REFERENCES fee_earners(fee_earner_id),
  credit_terms_days INTEGER NOT NULL,
  credit_limit NUMERIC NOT NULL,
  rate_discount_pct NUMERIC NOT NULL,
  date_opened TEXT NOT NULL,
  sector TEXT NOT NULL,
  crm_match_on TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE matters (
  matter_code TEXT PRIMARY KEY,
  client_code TEXT NOT NULL REFERENCES clients(client_code),
  matter_description TEXT NOT NULL,
  work_type TEXT NOT NULL,
  practice_area TEXT NOT NULL,
  responsible_partner_id TEXT NOT NULL REFERENCES fee_earners(fee_earner_id),
  fee_earner_id TEXT NOT NULL REFERENCES fee_earners(fee_earner_id),
  billing_basis TEXT NOT NULL,
  fixed_fee_amount NUMERIC NOT NULL,
  fee_estimate NUMERIC NOT NULL,
  estimate_alert_pct NUMERIC NOT NULL,
  date_opened TEXT NOT NULL,
  date_closed TEXT,
  status TEXT NOT NULL,
  billing_frequency TEXT NOT NULL DEFAULT '',
  client_reference TEXT NOT NULL DEFAULT '',
  third_party_payer TEXT NOT NULL DEFAULT ''
);

CREATE TABLE fee_estimates (
  estimate_id TEXT PRIMARY KEY,
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  date_given TEXT NOT NULL,
  estimate_type TEXT NOT NULL,
  fees_estimate NUMERIC NOT NULL,
  disbursements_estimate NUMERIC NOT NULL,
  given_by TEXT NOT NULL REFERENCES fee_earners(fee_earner_id),
  accepted_by_client TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE invoices (
  invoice_number TEXT PRIMARY KEY,
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  client_code TEXT NOT NULL REFERENCES clients(client_code),
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  invoice_type TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  fees_net NUMERIC NOT NULL,
  disbursements_net NUMERIC NOT NULL,
  vat NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  status TEXT NOT NULL,
  credit_note_for TEXT REFERENCES invoices(invoice_number)
);

CREATE TABLE time_entries (
  time_id TEXT PRIMARY KEY,
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  fee_earner_id TEXT NOT NULL REFERENCES fee_earners(fee_earner_id),
  date TEXT NOT NULL,
  activity TEXT NOT NULL,
  narrative TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  units INTEGER NOT NULL,
  hours NUMERIC NOT NULL,
  rate NUMERIC NOT NULL,
  value NUMERIC NOT NULL,
  chargeable TEXT NOT NULL,
  billed_status TEXT NOT NULL,
  invoice_number TEXT REFERENCES invoices(invoice_number),
  billed_value NUMERIC NOT NULL,
  write_off_value NUMERIC NOT NULL
);

CREATE TABLE disbursements (
  disbursement_id TEXT PRIMARY KEY,
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  supplier TEXT NOT NULL,
  description TEXT NOT NULL,
  net_amount NUMERIC NOT NULL,
  vat_amount NUMERIC NOT NULL,
  gross_amount NUMERIC NOT NULL,
  paid_from TEXT NOT NULL,
  billed_status TEXT NOT NULL,
  invoice_number TEXT REFERENCES invoices(invoice_number)
);

CREATE TABLE payments (
  receipt_id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL REFERENCES invoices(invoice_number),
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  client_code TEXT NOT NULL REFERENCES clients(client_code),
  receipt_date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL
);

CREATE TABLE client_account (
  transaction_id TEXT PRIMARY KEY,
  matter_code TEXT NOT NULL REFERENCES matters(matter_code),
  client_code TEXT NOT NULL REFERENCES clients(client_code),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC NOT NULL
);

-- Indexes on every matter_code, client_code, fee_earner_id and invoice_number column
CREATE INDEX idx_clients_partner ON clients(client_partner_id);
CREATE INDEX idx_matters_client_code ON matters(client_code);
CREATE INDEX idx_matters_resp_partner ON matters(responsible_partner_id);
CREATE INDEX idx_matters_fee_earner ON matters(fee_earner_id);
CREATE INDEX idx_fee_estimates_matter_code ON fee_estimates(matter_code);
CREATE INDEX idx_fee_estimates_given_by ON fee_estimates(given_by);
CREATE INDEX idx_invoices_matter_code ON invoices(matter_code);
CREATE INDEX idx_invoices_client_code ON invoices(client_code);
CREATE INDEX idx_invoices_credit_note_for ON invoices(credit_note_for);
CREATE INDEX idx_time_entries_matter_code ON time_entries(matter_code);
CREATE INDEX idx_time_entries_fee_earner ON time_entries(fee_earner_id);
CREATE INDEX idx_time_entries_invoice ON time_entries(invoice_number);
CREATE INDEX idx_disbursements_matter_code ON disbursements(matter_code);
CREATE INDEX idx_disbursements_invoice ON disbursements(invoice_number);
CREATE INDEX idx_payments_invoice ON payments(invoice_number);
CREATE INDEX idx_payments_matter_code ON payments(matter_code);
CREATE INDEX idx_payments_client_code ON payments(client_code);
CREATE INDEX idx_client_account_matter_code ON client_account(matter_code);
CREATE INDEX idx_client_account_client_code ON client_account(client_code);
`;

const VIEWS_SQL = `
-- 1. v_invoice_balances: Invoice balances, credit notes applied, days past due at as_at_date, age bucket, and recalculated status
CREATE VIEW v_invoice_balances AS
WITH ext AS (
  SELECT as_at_date FROM extract_info LIMIT 1
),
paid_per_inv AS (
  SELECT invoice_number, ROUND(SUM(ROUND(amount * 100)) / 100.0, 2) AS paid_amount
  FROM payments
  GROUP BY invoice_number
),
cn_per_inv AS (
  SELECT credit_note_for AS invoice_number, ROUND(SUM(ROUND(total * 100)) / 100.0, 2) AS cn_amount
  FROM invoices
  WHERE credit_note_for IS NOT NULL AND credit_note_for != ''
  GROUP BY credit_note_for
),
base AS (
  SELECT
    i.invoice_number,
    i.matter_code,
    i.client_code,
    i.invoice_date,
    i.due_date,
    i.invoice_type,
    i.period_from,
    i.period_to,
    ROUND(i.fees_net, 2) AS fees_net,
    ROUND(i.disbursements_net, 2) AS disbursements_net,
    ROUND(i.vat, 2) AS vat,
    ROUND(i.total, 2) AS total,
    i.status AS exported_status,
    i.credit_note_for,
    COALESCE(p.paid_amount, 0) AS paid,
    COALESCE(cn.cn_amount, 0) AS credit_notes,
    CASE
      WHEN i.invoice_type = 'Credit note' THEN 0
      ELSE ROUND((ROUND(i.total * 100) - ROUND(COALESCE(p.paid_amount, 0) * 100) + ROUND(COALESCE(cn.cn_amount, 0) * 100)) / 100.0, 2)
    END AS outstanding,
    (SELECT as_at_date FROM ext) AS as_at_date
  FROM invoices i
  LEFT JOIN paid_per_inv p ON p.invoice_number = i.invoice_number
  LEFT JOIN cn_per_inv cn ON cn.invoice_number = i.invoice_number
)
SELECT
  invoice_number,
  matter_code,
  client_code,
  invoice_date,
  due_date,
  invoice_type,
  period_from,
  period_to,
  fees_net,
  disbursements_net,
  vat,
  total,
  exported_status,
  credit_note_for,
  paid,
  credit_notes,
  outstanding,
  CASE
    WHEN invoice_type = 'Credit note' THEN NULL
    WHEN outstanding <= 0.005 THEN NULL
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) < 0 THEN 0
    ELSE CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER)
  END AS days_past_due,
  CASE
    WHEN invoice_type = 'Credit note' THEN 'Settled'
    WHEN outstanding <= 0.005 THEN 'Settled'
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) <= 0 THEN 'Not yet due'
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) <= 30 THEN '1-30'
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) <= 60 THEN '31-60'
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) <= 90 THEN '61-90'
    ELSE '90+'
  END AS age_bucket,
  CASE
    WHEN invoice_type = 'Credit note' THEN 'Applied'
    WHEN outstanding <= 0.005 THEN 'Paid'
    WHEN paid > 0.005 THEN 'Part paid'
    WHEN CAST(julianday(as_at_date) - julianday(due_date) AS INTEGER) > 0 THEN 'Overdue'
    ELSE 'Unpaid'
  END AS recalculated_status
FROM base;

-- 2. v_matter_financials: One row per matter reproducing check_matters
CREATE VIEW v_matter_financials AS
WITH ext AS (
  SELECT as_at_date FROM extract_info LIMIT 1
),
latest_est AS (
  SELECT fe.matter_code, fe.fees_estimate, fe.accepted_by_client, fe.estimate_type
  FROM fee_estimates fe
  WHERE fe.estimate_id = (
    SELECT fe2.estimate_id
    FROM fee_estimates fe2
    WHERE fe2.matter_code = fe.matter_code
    ORDER BY fe2.date_given DESC, fe2.estimate_id DESC
    LIMIT 1
  )
),
time_agg AS (
  SELECT
    matter_code,
    ROUND(SUM(ROUND(value * 100)) / 100.0, 2) AS time_value_recorded,
    ROUND(SUM(CASE WHEN billed_status = 'Unbilled' THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS unbilled_wip,
    ROUND(SUM(ROUND(write_off_value * 100)) / 100.0, 2) AS written_off,
    MAX(CASE WHEN billed_status = 'Unbilled' AND value > 0 THEN CAST(julianday((SELECT as_at_date FROM ext)) - julianday(date) AS INTEGER) ELSE NULL END) AS oldest_unbilled_wip_days
  FROM time_entries
  GROUP BY matter_code
),
inv_agg AS (
  SELECT
    matter_code,
    ROUND(SUM(ROUND(fees_net * 100)) / 100.0, 2) AS fees_billed,
    ROUND(SUM(ROUND(disbursements_net * 100)) / 100.0, 2) AS disbursements_billed,
    ROUND(SUM(ROUND(total * 100)) / 100.0, 2) AS total_invoiced_inc_vat,
    ROUND(SUM(ROUND(paid * 100)) / 100.0, 2) AS total_paid,
    ROUND(SUM(ROUND(outstanding * 100)) / 100.0, 2) AS outstanding_debt,
    MAX(CASE WHEN outstanding > 0.005 THEN days_past_due ELSE NULL END) AS max_invoice_days_past_due
  FROM v_invoice_balances
  GROUP BY matter_code
),
disb_agg AS (
  SELECT
    matter_code,
    ROUND(SUM(CASE WHEN billed_status = 'Unbilled' THEN ROUND(net_amount * 100) ELSE 0 END) / 100.0, 2) AS unbilled_disbursements
  FROM disbursements
  GROUP BY matter_code
),
ca_agg AS (
  SELECT
    matter_code,
    ROUND(SUM(ROUND(amount * 100)) / 100.0, 2) AS client_account_balance
  FROM client_account
  GROUP BY matter_code
)
SELECT
  m.matter_code,
  m.client_code,
  c.client_name,
  m.matter_description,
  m.work_type,
  m.practice_area,
  m.responsible_partner_id,
  (rp.first_name || ' ' || rp.last_name) AS responsible_partner_name,
  m.fee_earner_id,
  (fe.first_name || ' ' || fe.last_name) AS fee_earner_name,
  m.billing_basis,
  ROUND(m.fixed_fee_amount, 2) AS fixed_fee_amount,
  m.estimate_alert_pct,
  m.date_opened,
  m.date_closed,
  m.status,
  m.billing_frequency,
  m.client_reference,
  m.third_party_payer,
  ROUND(COALESCE(le.fees_estimate, m.fee_estimate), 2) AS fee_estimate,
  COALESCE(ta.time_value_recorded, 0) AS time_value_recorded,
  COALESCE(ta.unbilled_wip, 0) AS unbilled_wip,
  COALESCE(ia.fees_billed, 0) AS fees_billed,
  COALESCE(ia.disbursements_billed, 0) AS disbursements_billed,
  COALESCE(ia.total_invoiced_inc_vat, 0) AS total_invoiced_inc_vat,
  COALESCE(ia.total_paid, 0) AS total_paid,
  ROUND((ROUND(COALESCE(ia.total_invoiced_inc_vat, 0) * 100) - ROUND(COALESCE(ia.total_paid, 0) * 100)) / 100.0, 2) AS outstanding_debt,
  COALESCE(da.unbilled_disbursements, 0) AS unbilled_disbursements,
  CASE
    WHEN COALESCE(le.fees_estimate, m.fee_estimate) > 0
      THEN (COALESCE(ia.fees_billed, 0) + COALESCE(ta.unbilled_wip, 0)) * 1.0 / COALESCE(le.fees_estimate, m.fee_estimate)
    ELSE 0
  END AS estimate_used_pct,
  COALESCE(ta.written_off, 0) AS written_off,
  COALESCE(ca.client_account_balance, 0) AS client_account_balance,
  CASE WHEN EXISTS (
    SELECT 1 FROM fee_estimates fe_p
    WHERE fe_p.matter_code = m.matter_code AND fe_p.accepted_by_client = 'Pending'
  ) THEN 1 ELSE 0 END AS has_pending_estimate_revision,
  ta.oldest_unbilled_wip_days,
  ia.max_invoice_days_past_due
FROM matters m
JOIN clients c ON c.client_code = m.client_code
JOIN fee_earners rp ON rp.fee_earner_id = m.responsible_partner_id
JOIN fee_earners fe ON fe.fee_earner_id = m.fee_earner_id
LEFT JOIN latest_est le ON le.matter_code = m.matter_code
LEFT JOIN time_agg ta ON ta.matter_code = m.matter_code
LEFT JOIN inv_agg ia ON ia.matter_code = m.matter_code
LEFT JOIN disb_agg da ON da.matter_code = m.matter_code
LEFT JOIN ca_agg ca ON ca.matter_code = m.matter_code;

-- 3. v_client_financials: One row per client reproducing check_aged_debt client summary + matter totals
CREATE VIEW v_client_financials AS
WITH matter_sums AS (
  SELECT
    client_code,
    ROUND(SUM(ROUND(unbilled_wip * 100)) / 100.0, 2) AS unbilled_wip,
    ROUND(SUM(ROUND(fees_billed * 100)) / 100.0, 2) AS fees_billed,
    ROUND(SUM(ROUND(disbursements_billed * 100)) / 100.0, 2) AS disbursements_billed,
    ROUND(SUM(ROUND(total_invoiced_inc_vat * 100)) / 100.0, 2) AS total_invoiced_inc_vat,
    ROUND(SUM(ROUND(total_paid * 100)) / 100.0, 2) AS total_paid,
    ROUND(SUM(ROUND(outstanding_debt * 100)) / 100.0, 2) AS outstanding_debt,
    ROUND(SUM(ROUND(unbilled_disbursements * 100)) / 100.0, 2) AS unbilled_disbursements,
    ROUND(SUM(ROUND(client_account_balance * 100)) / 100.0, 2) AS client_account_balance
  FROM v_matter_financials
  GROUP BY client_code
),
aged_sums AS (
  SELECT
    client_code,
    ROUND(SUM(CASE WHEN age_bucket = 'Not yet due' THEN ROUND(outstanding * 100) ELSE 0 END) / 100.0, 2) AS aged_not_yet_due,
    ROUND(SUM(CASE WHEN age_bucket = '1-30' THEN ROUND(outstanding * 100) ELSE 0 END) / 100.0, 2) AS aged_1_30,
    ROUND(SUM(CASE WHEN age_bucket = '31-60' THEN ROUND(outstanding * 100) ELSE 0 END) / 100.0, 2) AS aged_31_60,
    ROUND(SUM(CASE WHEN age_bucket = '61-90' THEN ROUND(outstanding * 100) ELSE 0 END) / 100.0, 2) AS aged_61_90,
    ROUND(SUM(CASE WHEN age_bucket = '90+' THEN ROUND(outstanding * 100) ELSE 0 END) / 100.0, 2) AS aged_90_plus
  FROM v_invoice_balances
  WHERE invoice_type != 'Credit note'
  GROUP BY client_code
)
SELECT
  c.client_code,
  c.client_name,
  c.client_type,
  c.company_number,
  c.email,
  c.client_partner_id,
  c.credit_terms_days,
  ROUND(c.credit_limit, 2) AS credit_limit,
  c.rate_discount_pct,
  c.status,
  COALESCE(ms.unbilled_wip, 0) AS unbilled_wip,
  COALESCE(ms.fees_billed, 0) AS fees_billed,
  COALESCE(ms.disbursements_billed, 0) AS disbursements_billed,
  COALESCE(ms.total_invoiced_inc_vat, 0) AS total_invoiced_inc_vat,
  COALESCE(ms.total_paid, 0) AS total_paid,
  COALESCE(ms.outstanding_debt, 0) AS outstanding_debt,
  COALESCE(ms.unbilled_disbursements, 0) AS unbilled_disbursements,
  COALESCE(ms.client_account_balance, 0) AS client_account_balance,
  COALESCE(ag.aged_not_yet_due, 0) AS aged_not_yet_due,
  COALESCE(ag.aged_1_30, 0) AS aged_1_30,
  COALESCE(ag.aged_31_60, 0) AS aged_31_60,
  COALESCE(ag.aged_61_90, 0) AS aged_61_90,
  COALESCE(ag.aged_90_plus, 0) AS aged_90_plus,
  CASE
    WHEN c.credit_limit > 0 THEN COALESCE(ms.outstanding_debt, 0) * 1.0 / c.credit_limit
    ELSE NULL
  END AS credit_limit_used_pct
FROM clients c
LEFT JOIN matter_sums ms ON ms.client_code = c.client_code
LEFT JOIN aged_sums ag ON ag.client_code = c.client_code;

-- 4. v_fee_earner_performance: One row per fee earner reproducing check_fee_earners
CREATE VIEW v_fee_earner_performance AS
WITH ext AS (
  SELECT substr(as_at_date, 1, 7) AS current_ym FROM extract_info LIMIT 1
),
te_agg AS (
  SELECT
    fee_earner_id,
    ROUND(SUM(CASE WHEN chargeable = 'Y' THEN ROUND(hours * 100) ELSE 0 END) / 100.0, 2) AS chargeable_hours,
    ROUND(SUM(CASE WHEN chargeable = 'Y' AND substr(date, 1, 7) = (SELECT current_ym FROM ext) THEN ROUND(hours * 100) ELSE 0 END) / 100.0, 2) AS chargeable_hours_this_month,
    ROUND(SUM(ROUND(value * 100)) / 100.0, 2) AS time_value,
    ROUND(SUM(CASE WHEN billed_status = 'Unbilled' THEN ROUND(value * 100) ELSE 0 END) / 100.0, 2) AS unbilled_wip,
    ROUND(SUM(ROUND(billed_value * 100)) / 100.0, 2) AS billed_value,
    ROUND(SUM(ROUND(write_off_value * 100)) / 100.0, 2) AS written_off
  FROM time_entries
  GROUP BY fee_earner_id
)
SELECT
  fe.fee_earner_id,
  fe.initials,
  (fe.first_name || ' ' || fe.last_name) AS name,
  fe.email,
  fe.grade,
  fe.department,
  ROUND(fe.standard_hourly_rate, 2) AS standard_hourly_rate,
  COALESCE(ta.chargeable_hours, 0) AS chargeable_hours,
  COALESCE(ta.chargeable_hours_this_month, 0) AS chargeable_hours_this_month,
  COALESCE(ta.time_value, 0) AS time_value,
  COALESCE(ta.unbilled_wip, 0) AS unbilled_wip,
  COALESCE(ta.billed_value, 0) AS billed_value,
  COALESCE(ta.written_off, 0) AS written_off,
  fe.annual_target_hours,
  CASE
    WHEN fe.annual_target_hours > 0 THEN COALESCE(ta.chargeable_hours, 0) * 1.0 / fe.annual_target_hours
    ELSE 0
  END AS pct_of_annual_target
FROM fee_earners fe
LEFT JOIN te_agg ta ON ta.fee_earner_id = fe.fee_earner_id;
`;

function assertForeignKeyExists(
  set: Set<string>,
  keyVal: string | null | undefined,
  sourceTable: string,
  sourcePk: string,
  fkColumn: string,
  targetTable: string,
): void {
  if (!keyVal) return;
  if (!set.has(keyVal)) {
    throw new Error(
      `Foreign key violation in ${sourceTable} (${sourcePk}): ${fkColumn}="${keyVal}" does not exist in ${targetTable}`,
    );
  }
}

export interface ImportSummary {
  dbPath: string;
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
}

const DEMO_CLIENT_DRAMA_OVERRIDES: Record<
  string,
  { phone: string; companyNumber: string }
> = {
  PEN001: { phone: '029 2018 0410', companyNumber: 'DEMO-000001' },
  HAR001: { phone: '029 2018 0520', companyNumber: 'DEMO-RS0002' },
  BRI001: { phone: '0117 496 0730', companyNumber: 'DEMO-000003' },
  BAY001: { phone: '029 2018 0633', companyNumber: 'DEMO-000004' },
  SEV001: { phone: '0117 496 0810', companyNumber: 'DEMO-000005' },
  SEV002: { phone: '0117 496 0822', companyNumber: 'DEMO-000006' },
  SEV003: { phone: '0117 496 0830', companyNumber: 'DEMO-000007' },
  PRI001: { phone: '07700 900610', companyNumber: '' },
  PUG001: { phone: '', companyNumber: '' },
  SJO001: { phone: '07700 900877', companyNumber: '' },
};

/**
 * Drops and rebuilds the PMS SQLite database from the Excel workbook.
 * Safe and idempotent to run repeatedly.
 */
export function buildPmsDatabaseFromWorkbook(options?: {
  workbookPath?: string;
  dbPath?: string;
  importedAt?: string;
}): ImportSummary {
  const workbookPath = resolveWorkbookPath(options?.workbookPath);
  const dbPath = options?.dbPath ?? DEFAULT_PMS_DB_PATH;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const wb = openXlsxWorkbook(workbookPath);

  const feeEarnersRows = wb.getSheetRows('fee_earners');
  const clientsRows = wb.getSheetRows('clients');
  const mattersRows = wb.getSheetRows('matters');
  const feeEstimatesRows = wb.getSheetRows('fee_estimates');
  const invoicesRows = wb.getSheetRows('invoices');
  const timeEntriesRows = wb.getSheetRows('time_entries');
  const disbursementsRows = wb.getSheetRows('disbursements');
  const paymentsRows = wb.getSheetRows('payments');
  const clientAccountRows = wb.getSheetRows('client_account');

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN TRANSACTION;');

    const importedAt = options?.importedAt ?? `${PMS_AS_AT_DATE}T09:00:00.000Z`;
    const insertExtractInfo = db.prepare(
      `INSERT INTO extract_info (as_at_date, imported_at, source_file) VALUES (?, ?, ?)`,
    );
    insertExtractInfo.run(PMS_AS_AT_DATE, importedAt, path.basename(workbookPath));

    // Track primary keys for clear foreign-key error reporting
    const feeEarnerIds = new Set<string>();
    const clientCodes = new Set<string>();
    const matterCodes = new Set<string>();
    const invoiceNumbers = new Set<string>();

    // 1. fee_earners
    const insFeeEarner = db.prepare(`
      INSERT INTO fee_earners (
        fee_earner_id, initials, first_name, last_name, email,
        grade, department, standard_hourly_rate, annual_target_hours, annual_target_fees, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of feeEarnersRows) {
      const id = r.fee_earner_id;
      feeEarnerIds.add(id);
      insFeeEarner.run(
        id,
        r.initials,
        r.first_name,
        r.last_name,
        r.email,
        r.grade,
        r.department,
        parseMoney(r.standard_hourly_rate),
        parseInt(r.annual_target_hours, 10) || 0,
        parseMoney(r.annual_target_fees),
        r.active || 'Yes',
      );
    }

    // 2. clients
    const insClient = db.prepare(`
      INSERT INTO clients (
        client_code, client_name, client_type, company_number, email, phone,
        billing_address, postcode, client_partner_id, credit_terms_days,
        credit_limit, rate_discount_pct, date_opened, sector, crm_match_on, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of clientsRows) {
      const code = r.client_code;
      assertForeignKeyExists(
        feeEarnerIds,
        r.client_partner_id,
        'clients',
        code,
        'client_partner_id',
        'fee_earners',
      );
      clientCodes.add(code);
      const override = DEMO_CLIENT_DRAMA_OVERRIDES[code];
      insClient.run(
        code,
        r.client_name,
        r.client_type,
        override ? override.companyNumber : (r.company_number ?? ''),
        r.email ?? '',
        override ? override.phone : (r.phone ?? ''),
        r.billing_address ?? '',
        r.postcode ?? '',
        r.client_partner_id,
        parseInt(r.credit_terms_days, 10) || 0,
        parseMoney(r.credit_limit),
        Number(r.rate_discount_pct || 0),
        excelSerialToIsoDate(r.date_opened) ?? PMS_AS_AT_DATE,
        r.sector ?? '',
        r.crm_match_on ?? '',
        r.status ?? 'Active',
      );
    }

    // 3. matters
    const insMatter = db.prepare(`
      INSERT INTO matters (
        matter_code, client_code, matter_description, work_type, practice_area,
        responsible_partner_id, fee_earner_id, billing_basis, fixed_fee_amount,
        fee_estimate, estimate_alert_pct, date_opened, date_closed, status,
        billing_frequency, client_reference, third_party_payer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of mattersRows) {
      const code = r.matter_code;
      assertForeignKeyExists(clientCodes, r.client_code, 'matters', code, 'client_code', 'clients');
      assertForeignKeyExists(
        feeEarnerIds,
        r.responsible_partner_id,
        'matters',
        code,
        'responsible_partner_id',
        'fee_earners',
      );
      assertForeignKeyExists(
        feeEarnerIds,
        r.fee_earner_id,
        'matters',
        code,
        'fee_earner_id',
        'fee_earners',
      );
      matterCodes.add(code);
      insMatter.run(
        code,
        r.client_code,
        r.matter_description,
        r.work_type,
        r.practice_area,
        r.responsible_partner_id,
        r.fee_earner_id,
        r.billing_basis,
        parseMoney(r.fixed_fee_amount),
        parseMoney(r.fee_estimate),
        Number(r.estimate_alert_pct || 0.75),
        excelSerialToIsoDate(r.date_opened) ?? PMS_AS_AT_DATE,
        excelSerialToIsoDate(r.date_closed),
        r.status ?? 'Open',
        r.billing_frequency ?? '',
        r.client_reference ?? '',
        r.third_party_payer ?? '',
      );
    }

    // 4. fee_estimates
    const insEstimate = db.prepare(`
      INSERT INTO fee_estimates (
        estimate_id, matter_code, date_given, estimate_type,
        fees_estimate, disbursements_estimate, given_by, accepted_by_client, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of feeEstimatesRows) {
      const id = r.estimate_id;
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'fee_estimates',
        id,
        'matter_code',
        'matters',
      );
      assertForeignKeyExists(
        feeEarnerIds,
        r.given_by,
        'fee_estimates',
        id,
        'given_by',
        'fee_earners',
      );
      insEstimate.run(
        id,
        r.matter_code,
        excelSerialToIsoDate(r.date_given) ?? PMS_AS_AT_DATE,
        r.estimate_type,
        parseMoney(r.fees_estimate),
        parseMoney(r.disbursements_estimate),
        r.given_by,
        r.accepted_by_client,
        r.notes ?? '',
      );
    }

    // 5. invoices (must be inserted before time_entries, disbursements, and payments which reference invoice_number)
    const insInvoice = db.prepare(`
      INSERT INTO invoices (
        invoice_number, matter_code, client_code, invoice_date, due_date,
        invoice_type, period_from, period_to, fees_net, disbursements_net,
        vat, total, status, credit_note_for
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of invoicesRows) {
      const invNo = r.invoice_number;
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'invoices',
        invNo,
        'matter_code',
        'matters',
      );
      assertForeignKeyExists(
        clientCodes,
        r.client_code,
        'invoices',
        invNo,
        'client_code',
        'clients',
      );
      const cnFor = r.credit_note_for?.trim() || null;
      if (cnFor) {
        assertForeignKeyExists(
          invoiceNumbers,
          cnFor,
          'invoices',
          invNo,
          'credit_note_for',
          'invoices',
        );
      }
      invoiceNumbers.add(invNo);
      insInvoice.run(
        invNo,
        r.matter_code,
        r.client_code,
        excelSerialToIsoDate(r.invoice_date) ?? PMS_AS_AT_DATE,
        excelSerialToIsoDate(r.due_date) ?? PMS_AS_AT_DATE,
        r.invoice_type,
        excelSerialToIsoDate(r.period_from),
        excelSerialToIsoDate(r.period_to),
        parseMoney(r.fees_net),
        parseMoney(r.disbursements_net),
        parseMoney(r.vat),
        parseMoney(r.total),
        r.status,
        cnFor,
      );
    }

    // 6. time_entries
    const insTime = db.prepare(`
      INSERT INTO time_entries (
        time_id, matter_code, fee_earner_id, date, activity, narrative,
        minutes, units, hours, rate, value, chargeable, billed_status,
        invoice_number, billed_value, write_off_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of timeEntriesRows) {
      const id = r.time_id;
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'time_entries',
        id,
        'matter_code',
        'matters',
      );
      assertForeignKeyExists(
        feeEarnerIds,
        r.fee_earner_id,
        'time_entries',
        id,
        'fee_earner_id',
        'fee_earners',
      );
      const invNo = r.invoice_number?.trim() || null;
      if (invNo) {
        assertForeignKeyExists(
          invoiceNumbers,
          invNo,
          'time_entries',
          id,
          'invoice_number',
          'invoices',
        );
      }
      insTime.run(
        id,
        r.matter_code,
        r.fee_earner_id,
        excelSerialToIsoDate(r.date) ?? PMS_AS_AT_DATE,
        r.activity,
        r.narrative,
        parseInt(r.minutes, 10) || 0,
        parseInt(r.units, 10) || 0,
        Math.round((Number(r.hours || 0) + Number.EPSILON) * 10000) / 10000,
        parseMoney(r.rate),
        parseMoney(r.value),
        r.chargeable || 'Y',
        r.billed_status,
        invNo,
        parseMoney(r.billed_value),
        parseMoney(r.write_off_value),
      );
    }

    // 7. disbursements
    const insDisb = db.prepare(`
      INSERT INTO disbursements (
        disbursement_id, matter_code, date, type, supplier, description,
        net_amount, vat_amount, gross_amount, paid_from, billed_status, invoice_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of disbursementsRows) {
      const id = r.disbursement_id;
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'disbursements',
        id,
        'matter_code',
        'matters',
      );
      const invNo = r.invoice_number?.trim() || null;
      if (invNo) {
        assertForeignKeyExists(
          invoiceNumbers,
          invNo,
          'disbursements',
          id,
          'invoice_number',
          'invoices',
        );
      }
      insDisb.run(
        id,
        r.matter_code,
        excelSerialToIsoDate(r.date) ?? PMS_AS_AT_DATE,
        r.type,
        r.supplier,
        r.description,
        parseMoney(r.net_amount),
        parseMoney(r.vat_amount),
        parseMoney(r.gross_amount),
        r.paid_from,
        r.billed_status,
        invNo,
      );
    }

    // 8. payments
    const insPayment = db.prepare(`
      INSERT INTO payments (
        receipt_id, invoice_number, matter_code, client_code,
        receipt_date, amount, method, reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of paymentsRows) {
      const id = r.receipt_id;
      assertForeignKeyExists(
        invoiceNumbers,
        r.invoice_number,
        'payments',
        id,
        'invoice_number',
        'invoices',
      );
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'payments',
        id,
        'matter_code',
        'matters',
      );
      assertForeignKeyExists(
        clientCodes,
        r.client_code,
        'payments',
        id,
        'client_code',
        'clients',
      );
      insPayment.run(
        id,
        r.invoice_number,
        r.matter_code,
        r.client_code,
        excelSerialToIsoDate(r.receipt_date) ?? PMS_AS_AT_DATE,
        parseMoney(r.amount),
        r.method,
        r.reference,
      );
    }

    // 9. client_account
    const insClientAccount = db.prepare(`
      INSERT INTO client_account (
        transaction_id, matter_code, client_code, date, type, description, amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of clientAccountRows) {
      const id = r.transaction_id;
      assertForeignKeyExists(
        matterCodes,
        r.matter_code,
        'client_account',
        id,
        'matter_code',
        'matters',
      );
      assertForeignKeyExists(
        clientCodes,
        r.client_code,
        'client_account',
        id,
        'client_code',
        'clients',
      );
      insClientAccount.run(
        id,
        r.matter_code,
        r.client_code,
        excelSerialToIsoDate(r.date) ?? PMS_AS_AT_DATE,
        r.type,
        r.description,
        parseMoney(r.amount),
      );
    }

    db.exec(VIEWS_SQL);
    db.exec('COMMIT;');

    return {
      dbPath,
      asAtDate: PMS_AS_AT_DATE,
      importedAt,
      counts: {
        fee_earners: feeEarnersRows.length,
        clients: clientsRows.length,
        matters: mattersRows.length,
        fee_estimates: feeEstimatesRows.length,
        time_entries: timeEntriesRows.length,
        disbursements: disbursementsRows.length,
        invoices: invoicesRows.length,
        payments: paymentsRows.length,
        client_account: clientAccountRows.length,
      },
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    db.close();
  }
}
