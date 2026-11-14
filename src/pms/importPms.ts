/**
 * Parses `data/pms/1Squared_PMS_Demo_Data.xlsx` and imports the 9 PMS data sheets
 * into the tenant's PostgreSQL database via `TenantPmsRepository`:
 *   fee_earners, clients, matters, fee_estimates, time_entries,
 *   disbursements, invoices, payments, client_account.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  TenantPmsRepository,
  type TenantContext,
  type TenantPmsClient,
  type TenantPmsDisbursement,
  type TenantPmsExtractDataset,
  type TenantPmsFeeEarner,
  type TenantPmsFeeEstimate,
  type TenantPmsInvoiceRow,
  type TenantPmsMatter,
  type TenantPmsPayment,
  type TenantPmsTimeEntry,
} from '@platform/core';
import { isValidPmsAsAtDate } from '../domain/pms';
import { excelSerialToIsoDate, openXlsxWorkbook, parseMoney } from './xlsxReader';

export const DEFAULT_XLSX_PATH = path.join(
  process.cwd(),
  'data',
  'pms',
  '1Squared_PMS_Demo_Data.xlsx',
);

const MONTH_NAME_TO_NUMBER: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

export interface WorkbookReadmeLike {
  sheetNames: string[];
  getSheetMatrix: (name: string) => Array<{ rowNumber: number; cells: Record<string, string> }>;
}

export function extractAsAtDateFromWorkbook(wb: WorkbookReadmeLike): string | null {
  if (!wb.sheetNames.includes('README')) return null;
  const rows = wb.getSheetMatrix('README');
  for (const row of rows) {
    const label = (row.cells.A ?? '').trim().toLowerCase();
    if (!label.startsWith('as-at date') && !label.startsWith('as at date')) {
      continue;
    }
    const raw = (row.cells.B ?? '').trim();
    if (!raw) continue;
    const isoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (isoMatch && isValidPmsAsAtDate(isoMatch[1])) {
      return isoMatch[1];
    }
    const ukMatch = raw.match(
      /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
    );
    if (ukMatch) {
      const day = ukMatch[1]!.padStart(2, '0');
      const month = MONTH_NAME_TO_NUMBER[ukMatch[2]!.toLowerCase()];
      const year = ukMatch[3]!;
      const candidate = `${year}-${month}-${day}`;
      if (isValidPmsAsAtDate(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function parseImportPmsCliArgs(args: readonly string[]): {
  asAtDate?: string;
  tenant?: string;
} {
  let asAtDate: string | undefined;
  let tenant: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--as-at') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--') || next.trim().length === 0) {
        throw new Error('Missing value for --as-at. Provide a valid YYYY-MM-DD date.');
      }
      asAtDate = next.trim();
      i++;
    } else if (arg.startsWith('--as-at=')) {
      const val = arg.slice('--as-at='.length).trim();
      if (val.length === 0) {
        throw new Error('Empty value for --as-at=. Provide a valid YYYY-MM-DD date.');
      }
      asAtDate = val;
    } else if (arg === '--tenant') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--') || next.trim().length === 0) {
        throw new Error('Missing value for --tenant. Provide a valid tenant slug or ID.');
      }
      tenant = next.trim();
      i++;
    } else if (arg.startsWith('--tenant=')) {
      const val = arg.slice('--tenant='.length).trim();
      if (val.length === 0) {
        throw new Error('Empty value for --tenant=. Provide a valid tenant slug or ID.');
      }
      tenant = val;
    }
  }
  return {
    ...(asAtDate !== undefined ? { asAtDate } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
  };
}

export function resolveWorkbookPath(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (fs.existsSync(DEFAULT_XLSX_PATH)) return DEFAULT_XLSX_PATH;
  throw new Error(`PMS demo workbook not found at ${DEFAULT_XLSX_PATH}`);
}

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

export function parsePmsWorkbookDataset(options?: {
  workbookPath?: string;
  asAtDate?: string;
  importedAt?: string;
}): TenantPmsExtractDataset {
  const workbookPath = resolveWorkbookPath(options?.workbookPath);
  const wb = openXlsxWorkbook(workbookPath);
  const hasExplicitAsAt =
    options !== undefined &&
    Object.prototype.hasOwnProperty.call(options, 'asAtDate') &&
    options.asAtDate !== undefined;
  const asAtDate = (
    hasExplicitAsAt ? (options.asAtDate ?? '') : (extractAsAtDateFromWorkbook(wb) ?? '')
  ).trim();
  if (!isValidPmsAsAtDate(asAtDate)) {
    throw new Error(
      `Invalid or missing PMS extract as-at date "${asAtDate}". Provide a valid YYYY-MM-DD via --as-at or in the workbook README sheet.`,
    );
  }
  const importedAt = options?.importedAt ?? `${asAtDate}T09:00:00.000Z`;

  const feeEarnersRows = wb.getSheetRows('fee_earners');
  const clientsRows = wb.getSheetRows('clients');
  const mattersRows = wb.getSheetRows('matters');
  const feeEstimatesRows = wb.getSheetRows('fee_estimates');
  const invoicesRows = wb.getSheetRows('invoices');
  const timeEntriesRows = wb.getSheetRows('time_entries');
  const disbursementsRows = wb.getSheetRows('disbursements');
  const paymentsRows = wb.getSheetRows('payments');
  const clientAccountRows = wb.getSheetRows('client_account');

  const feeEarnerIds = new Set<string>();
  const clientCodes = new Set<string>();
  const matterCodes = new Set<string>();
  const invoiceNumbers = new Set<string>();

  const feeEarners: TenantPmsFeeEarner[] = feeEarnersRows.map((r) => {
    const id = r.fee_earner_id;
    feeEarnerIds.add(id);
    return {
      fee_earner_id: id,
      initials: r.initials,
      first_name: r.first_name,
      last_name: r.last_name,
      email: (r.email ?? '').replace(/\.co\.uk$/i, '.example'),
      grade: r.grade,
      department: r.department,
      standard_hourly_rate: parseMoney(r.standard_hourly_rate),
      annual_target_hours: parseInt(r.annual_target_hours, 10) || 0,
      annual_target_fees: parseMoney(r.annual_target_fees),
      active: r.active || 'Yes',
    };
  });

  const clients: TenantPmsClient[] = clientsRows.map((r) => {
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
    return {
      client_code: code,
      client_name: r.client_name,
      client_type: (r.client_type || 'Organisation') as TenantPmsClient['client_type'],
      company_number: r.company_number ?? '',
      email: (r.email ?? '').replace(/\.co\.uk$/i, '.example'),
      phone: r.phone ?? '',
      billing_address: r.billing_address ?? '',
      postcode: r.postcode ?? '',
      client_partner_id: r.client_partner_id,
      credit_terms_days: parseInt(r.credit_terms_days, 10) || 0,
      credit_limit: parseMoney(r.credit_limit),
      rate_discount_pct: Number(r.rate_discount_pct || 0),
      date_opened: excelSerialToIsoDate(r.date_opened) ?? asAtDate,
      sector: r.sector ?? '',
      crm_match_on: (r.crm_match_on || 'company_number') as TenantPmsClient['crm_match_on'],
      status: r.status ?? 'Active',
    };
  });

  const matters: TenantPmsMatter[] = mattersRows.map((r) => {
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
    return {
      matter_code: code,
      client_code: r.client_code,
      matter_description: r.matter_description,
      work_type: r.work_type,
      practice_area: r.practice_area,
      responsible_partner_id: r.responsible_partner_id,
      fee_earner_id: r.fee_earner_id,
      billing_basis: r.billing_basis as TenantPmsMatter['billing_basis'],
      fixed_fee_amount: parseMoney(r.fixed_fee_amount),
      fee_estimate: parseMoney(r.fee_estimate),
      estimate_alert_pct: Number(r.estimate_alert_pct || 0.75),
      date_opened: excelSerialToIsoDate(r.date_opened) ?? asAtDate,
      date_closed: excelSerialToIsoDate(r.date_closed),
      status: (r.status ?? 'Open') as TenantPmsMatter['status'],
      billing_frequency: r.billing_frequency ?? '',
      client_reference: r.client_reference ?? '',
      third_party_payer: r.third_party_payer ?? '',
    };
  });

  const feeById = new Map(feeEarners.map((f) => [f.fee_earner_id, f]));

  const feeEstimates: TenantPmsFeeEstimate[] = feeEstimatesRows.map((r) => {
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
    const fe = feeById.get(r.given_by);
    return {
      estimate_id: id,
      matter_code: r.matter_code,
      date_given: excelSerialToIsoDate(r.date_given) ?? asAtDate,
      estimate_type: r.estimate_type as TenantPmsFeeEstimate['estimate_type'],
      fees_estimate: parseMoney(r.fees_estimate),
      disbursements_estimate: parseMoney(r.disbursements_estimate),
      given_by: r.given_by,
      given_by_name: fe ? `${fe.first_name} ${fe.last_name}` : undefined,
      accepted_by_client: r.accepted_by_client as TenantPmsFeeEstimate['accepted_by_client'],
      notes: r.notes ?? '',
    };
  });

  const invoices: TenantPmsInvoiceRow[] = invoicesRows.map((r) => {
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
    return {
      invoice_number: invNo,
      matter_code: r.matter_code,
      client_code: r.client_code,
      invoice_date: excelSerialToIsoDate(r.invoice_date) ?? asAtDate,
      due_date: excelSerialToIsoDate(r.due_date) ?? asAtDate,
      invoice_type: r.invoice_type,
      period_from: excelSerialToIsoDate(r.period_from),
      period_to: excelSerialToIsoDate(r.period_to),
      fees_net: parseMoney(r.fees_net),
      disbursements_net: parseMoney(r.disbursements_net),
      vat: parseMoney(r.vat),
      total: parseMoney(r.total),
      status: r.status,
      credit_note_for: cnFor,
    };
  });

  const timeEntries: TenantPmsTimeEntry[] = timeEntriesRows.map((r) => {
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
    const fe = feeById.get(r.fee_earner_id);
    return {
      time_id: id,
      matter_code: r.matter_code,
      fee_earner_id: r.fee_earner_id,
      fee_earner_name: fe ? `${fe.first_name} ${fe.last_name}` : undefined,
      fee_earner_initials: fe?.initials,
      date: excelSerialToIsoDate(r.date) ?? asAtDate,
      activity: r.activity,
      narrative: r.narrative,
      minutes: parseInt(r.minutes, 10) || 0,
      units: parseInt(r.units, 10) || 0,
      hours: Math.round((Number(r.hours || 0) + Number.EPSILON) * 10000) / 10000,
      rate: parseMoney(r.rate),
      value: parseMoney(r.value),
      chargeable: (r.chargeable || 'Y') as 'Y' | 'N',
      billed_status: r.billed_status as TenantPmsTimeEntry['billed_status'],
      invoice_number: invNo,
      billed_value: parseMoney(r.billed_value),
      write_off_value: parseMoney(r.write_off_value),
    };
  });

  const disbursements: TenantPmsDisbursement[] = disbursementsRows.map((r) => {
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
    return {
      disbursement_id: id,
      matter_code: r.matter_code,
      date: excelSerialToIsoDate(r.date) ?? asAtDate,
      type: r.type,
      supplier: r.supplier,
      description: r.description,
      net_amount: parseMoney(r.net_amount),
      vat_amount: parseMoney(r.vat_amount),
      gross_amount: parseMoney(r.gross_amount),
      paid_from: r.paid_from as TenantPmsDisbursement['paid_from'],
      billed_status: r.billed_status as TenantPmsDisbursement['billed_status'],
      invoice_number: invNo,
    };
  });

  const payments: TenantPmsPayment[] = paymentsRows.map((r) => {
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
    return {
      receipt_id: id,
      invoice_number: r.invoice_number,
      matter_code: r.matter_code,
      client_code: r.client_code,
      receipt_date: excelSerialToIsoDate(r.receipt_date) ?? asAtDate,
      amount: parseMoney(r.amount),
      method: r.method,
      reference: r.reference,
    };
  });

  const clientAccount = clientAccountRows.map((r) => {
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
    return {
      transaction_id: id,
      matter_code: r.matter_code,
      client_code: r.client_code,
      date: excelSerialToIsoDate(r.date) ?? asAtDate,
      type: r.type as 'Receipt' | 'Payment' | 'Transfer to office',
      description: r.description,
      amount: parseMoney(r.amount),
    };
  });

  return {
    extractInfo: {
      asAtDate,
      importedAt,
      sourceFile: path.basename(workbookPath),
    },
    feeEarners,
    clients,
    matters,
    feeEstimates,
    invoices,
    timeEntries,
    disbursements,
    payments,
    clientAccount,
  };
}

let cachedDefaultWorkbookDataset: TenantPmsExtractDataset | null = null;

export function getCachedDefaultWorkbookDataset(): TenantPmsExtractDataset {
  if (!cachedDefaultWorkbookDataset) {
    cachedDefaultWorkbookDataset = parsePmsWorkbookDataset();
  }
  return cachedDefaultWorkbookDataset;
}

export async function importPmsWorkbookToPostgres(
  ctx: TenantContext,
  options?: {
    workbookPath?: string;
    asAtDate?: string;
    importedAt?: string;
  },
): Promise<ImportSummary> {
  const dataset = parsePmsWorkbookDataset(options);
  const pmsRepo = new TenantPmsRepository();
  const res = await pmsRepo.importExtractDataset(ctx, dataset);
  return {
    dbPath: `postgres://${ctx.postgresDatabaseName}`,
    asAtDate: res.asAtDate,
    importedAt: res.importedAt,
    counts: res.counts,
  };
}
