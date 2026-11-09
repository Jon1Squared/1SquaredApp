/**
 * Formatting, matching, and permission helpers for PMS financial data.
 *
 * Rules:
 * - Money in GBP with £ and 2 decimals; negatives in brackets: e.g. £34,140.00, (£540.00).
 * - Percentages to whole numbers: e.g. 73%, 112%.
 * - Finance views are visible to fee earners, partners, finance and admins;
 *   hidden from the Call handler role.
 */
import { formatDate } from './dates';
import { resolveLabel } from './lists';
import { normaliseEmail, normaliseRegNumber, normaliseText } from './normalise';
import {
  resolvePersonPermissionSet,
  type ResolvePersonPermissionsOptions,
} from './rbac';
import { resolveUserAppRole } from './tasks';
import type {
  AppRole,
  ChoiceValue,
  Matter,
  Organisation,
  Person,
  PmsEntityType,
  PmsLink,
  Team,
} from './types';
import type {
  PmsFieldMappingEntry,
  PmsOutboundCommand,
  PmsOutboundCommandType,
} from '@platform/core-api';
import type {
  PmsCashReceivedSummary,
  PmsClient,
  PmsClientFinancials,
  PmsDepartmentFinancials,
  PmsFeeEarner,
  PmsFeeEarnerPerformance,
  PmsFeeEarnerWeeklyTime,
  PmsInvoiceBalance,
  PmsMatter,
  PmsMatterFinancials,
  PmsMonthlyFeesBilled,
  PmsPayment,
  PmsTimeEntry,
} from '@/pms/types';

/** Format GBP currency with £ and 2 decimal places; negatives in brackets. */
export function formatGbp(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return '£0.00';
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  const formatted = rounded.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n < -0.004) {
    return `(£${formatted})`;
  }
  return `£${formatted}`;
}

/** Format a fraction (e.g. 0.7347) as a whole-number percentage (e.g. "73%"). */
export function formatWholePct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return '—';
  }
  return `${Math.round(fraction * 100)}%`;
}

export const PMS_AS_AT_UNAVAILABLE_LABEL = 'PMS as-at date unavailable';

/** Return true only when `value` is a valid calendar date formatted as `YYYY-MM-DD`. */
export function isValidPmsAsAtDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Format the PMS as-at date label (e.g. "16 Oct 2026"), or "PMS as-at date unavailable" when missing/invalid. */
export function formatPmsAsAtLabel(asAtDate: string): string {
  if (!isValidPmsAsAtDate(asAtDate)) return PMS_AS_AT_UNAVAILABLE_LABEL;
  return formatDate(asAtDate);
}

/**
 * Determine whether the current user can view PMS Finance tabs, sections, columns and alerts.
 * Visible to fee earners, partners (team leads), finance, and admins.
 * Hidden from the Call handler role.
 */
export function canUserViewFinance(
  user: Person | null | undefined,
  teams: Team[],
  values: ChoiceValue[] = [],
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  if (!user) return false;
  const appRole: AppRole = resolveUserAppRole(user, teams, values, rbacOptions);
  if (appRole === 'call_handler') return false;
  const perms = resolvePersonPermissionSet(user, { ...rbacOptions, teams });
  return perms.has('finance:view_matter') || perms.has('finance:view');
}

export interface PmsSuggestedMatch {
  onesquaredId: string;
  onesquaredLabel: string;
  pmsCode: string;
  pmsLabel: string;
  reason: string;
}

/**
 * Compute automatic matches for Organisations (by company_number),
 * People (by email), and Employees (by email).
 * Never overwrites existing manual links (`matchedBy === 'manual'`).
 */
export function computeAutomaticPmsLinks(
  existingLinks: PmsLink[],
  organisations: Organisation[],
  people: Person[],
  matters: Matter[],
  pmsClients: PmsClient[],
  pmsFeeEarners: PmsFeeEarner[],
  pmsMatters: PmsMatter[],
  nowIso: string = new Date().toISOString(),
  includeInitialSeedMatterLinks = false,
): PmsLink[] {
  // Keep manual links and seed matter links intact
  const preserved = existingLinks.filter(
    (l) => l.matchedBy === 'manual' || (l.entityType === 'matter' && l.matchedBy === 'seed'),
  );

  const usedOneSquared = new Set<string>(
    preserved.map((l) => `${l.entityType}:${l.onesquaredId}`),
  );
  const usedPms = new Set<string>(preserved.map((l) => `${l.entityType}:${l.pmsCode}`));

  const out: PmsLink[] = [...preserved];
  let counter = out.length;
  const nextLinkId = () => `PMSL-${String(++counter).padStart(6, '0')}`;

  // 1. Organisations <-> PMS clients (Organisation) on company_number
  const orgClients = pmsClients.filter((c) => c.client_type === 'Organisation');
  for (const org of organisations) {
    if (org.mergedIntoId) continue;
    if (usedOneSquared.has(`organisation:${org.id}`)) continue;
    const normReg = normaliseRegNumber(org.companyNumber);
    if (!normReg) continue;

    const matchedClient = orgClients.find(
      (c) =>
        !usedPms.has(`organisation:${c.client_code}`) &&
        normaliseRegNumber(c.company_number) === normReg,
    );
    if (matchedClient) {
      usedOneSquared.add(`organisation:${org.id}`);
      usedPms.add(`organisation:${matchedClient.client_code}`);
      out.push({
        id: nextLinkId(),
        entityType: 'organisation',
        onesquaredId: org.id,
        pmsCode: matchedClient.client_code,
        matchedBy: 'auto_company_number',
        matchedAt: nowIso,
      });
    }
  }

  // 2. People (external) <-> PMS clients (Individual) on any of the person's emails
  const indClients = pmsClients.filter((c) => c.client_type === 'Individual');
  for (const person of people) {
    if (person.mergedIntoId || person.isEmployee) continue;
    if (usedOneSquared.has(`person:${person.id}`)) continue;
    const personEmails = person.emails.map((e) => normaliseEmail(e.address)).filter(Boolean);
    if (personEmails.length === 0) continue;

    const matchedClient = indClients.find(
      (c) =>
        !usedPms.has(`person:${c.client_code}`) &&
        c.email &&
        personEmails.includes(normaliseEmail(c.email)),
    );
    if (matchedClient) {
      usedOneSquared.add(`person:${person.id}`);
      usedPms.add(`person:${matchedClient.client_code}`);
      out.push({
        id: nextLinkId(),
        entityType: 'person',
        onesquaredId: person.id,
        pmsCode: matchedClient.client_code,
        matchedBy: 'auto_email',
        matchedAt: nowIso,
      });
    }
  }

  // 3. Employees <-> PMS fee_earners on work email (or local-part across configured firm domains)
  for (const emp of people) {
    if (emp.mergedIntoId || !emp.isEmployee) continue;
    if (usedOneSquared.has(`employee:${emp.id}`)) continue;
    const empEmails = emp.emails.map((e) => normaliseEmail(e.address)).filter(Boolean);
    if (empEmails.length === 0) continue;
    const empLocalParts = empEmails.map((addr) => addr.split('@')[0]).filter(Boolean);

    const matchedFe = pmsFeeEarners.find((fe) => {
      if (usedPms.has(`employee:${fe.fee_earner_id}`) || !fe.email) return false;
      const feEmail = normaliseEmail(fe.email);
      if (empEmails.includes(feEmail)) return true;
      const feLocal = feEmail.split('@')[0];
      return Boolean(feLocal && empLocalParts.includes(feLocal));
    });
    if (matchedFe) {
      usedOneSquared.add(`employee:${emp.id}`);
      usedPms.add(`employee:${matchedFe.fee_earner_id}`);
      out.push({
        id: nextLinkId(),
        entityType: 'employee',
        onesquaredId: emp.id,
        pmsCode: matchedFe.fee_earner_id,
        matchedBy: 'auto_email',
        matchedAt: nowIso,
      });
    }
  }

  // 4. Optional initial seed links for the demo matters that exist in both systems
  if (includeInitialSeedMatterLinks) {
    for (const m of matters) {
      if (m.mergedIntoId) continue;
      if (m.id > 'M-000018') continue;
      if (usedOneSquared.has(`matter:${m.id}`)) continue;
      const exactPms = pmsMatters.find(
        (pm) =>
          !usedPms.has(`matter:${pm.matter_code}`) && pm.matter_code === m.matterNumber,
      );
      if (exactPms) {
        usedOneSquared.add(`matter:${m.id}`);
        usedPms.add(`matter:${exactPms.matter_code}`);
        out.push({
          id: nextLinkId(),
          entityType: 'matter',
          onesquaredId: m.id,
          pmsCode: exactPms.matter_code,
          matchedBy: 'seed',
          matchedAt: nowIso,
        });
      }
    }
  }

  return out;
}

/**
 * Suggest candidate matter matches between unlinked 1Squared matters and unlinked PMS matters
 * that share the same linked client and have a similar description or work type.
 */
export function suggestMatterMatches(
  pmsLinks: PmsLink[],
  matters: Matter[],
  pmsMatters: PmsMatter[],
  values: ChoiceValue[],
): PmsSuggestedMatch[] {
  const linked1SqMatters = new Set(
    pmsLinks.filter((l) => l.entityType === 'matter').map((l) => l.onesquaredId),
  );
  const linkedPmsMatters = new Set(
    pmsLinks.filter((l) => l.entityType === 'matter').map((l) => l.pmsCode),
  );

  // Map 1Squared client ID -> PMS client_code
  const clientCodeBy1SqId = new Map<string, string>();
  for (const l of pmsLinks) {
    if (l.entityType === 'organisation' || l.entityType === 'person') {
      clientCodeBy1SqId.set(l.onesquaredId, l.pmsCode);
    }
  }

  const suggestions: PmsSuggestedMatch[] = [];

  for (const m of matters) {
    if (m.mergedIntoId || linked1SqMatters.has(m.id)) continue;
    const pmsClientCode = clientCodeBy1SqId.get(m.clientId);
    if (!pmsClientCode) continue;

    const mSubcat = resolveLabel(values, m.workTypeSubcategoryId).toLowerCase();
    const mTokens = new Set(
      normaliseText(`${m.title} ${m.shortDescription} ${mSubcat}`)
        .split(/\s+/)
        .filter((w) => w.length >= 4),
    );

    const candidatePms = pmsMatters.filter(
      (pm) => pm.client_code === pmsClientCode && !linkedPmsMatters.has(pm.matter_code),
    );

    for (const pm of candidatePms) {
      const pmTokens = normaliseText(`${pm.matter_description} ${pm.work_type}`)
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      const shared = pmTokens.filter((w) => mTokens.has(w));
      const sameWorkType =
        normaliseText(pm.work_type) === normaliseText(mSubcat) && mSubcat.length > 0;
      const sameCode = pm.matter_code === m.matterNumber;

      if (sameCode || sameWorkType || shared.length >= 1) {
        const reasons: string[] = [`Same linked client (${pmsClientCode})`];
        if (sameWorkType) reasons.push(`Same work type (${pm.work_type})`);
        if (shared.length > 0) reasons.push(`Similar description`);
        suggestions.push({
          onesquaredId: m.id,
          onesquaredLabel: `${m.matterNumber} — ${m.title}`,
          pmsCode: pm.matter_code,
          pmsLabel: `${pm.matter_code} — ${pm.matter_description}`,
          reason: reasons.join(' · '),
        });
      }
    }
  }

  return suggestions;
}

export function findPmsCodeForRecord(
  pmsLinks: PmsLink[],
  entityType: PmsEntityType,
  onesquaredId: string,
): string | null {
  return (
    pmsLinks.find((l) => l.entityType === entityType && l.onesquaredId === onesquaredId)
      ?.pmsCode ?? null
  );
}

export function findOneSquaredIdForPmsCode(
  pmsLinks: PmsLink[],
  entityType: PmsEntityType,
  pmsCode: string,
): string | null {
  return (
    pmsLinks.find((l) => l.entityType === entityType && l.pmsCode === pmsCode)?.onesquaredId ??
    null
  );
}

/**
 * Extract the 1Squared value for a configured field mapping key across core fields,
 * matter `fieldValues` (`CORE-xxx` / `FGxx`), and `customFields`.
 */
export function resolveOneSquaredFieldValueForMapping(
  record: Matter | Organisation | Person,
  fieldKey: string,
  values: ChoiceValue[] = [],
): unknown {
  if ('matterNumber' in record) {
    if (fieldKey === 'billingBasisLabel') {
      return resolveLabel(values, record.billingBasisId) || record.billingBasisId;
    }
    if (fieldKey === 'practiceAreaLabel') {
      return resolveLabel(values, record.practiceAreaId) || record.practiceAreaId;
    }
    if (fieldKey === 'workTypeSubcategoryLabel') {
      return (
        resolveLabel(values, record.workTypeSubcategoryId) ||
        record.workTypeSubcategoryId
      );
    }
    if (fieldKey in record.fieldValues) {
      return record.fieldValues[fieldKey];
    }
  }
  if (record.customFields && fieldKey in record.customFields) {
    return record.customFields[fieldKey];
  }
  const direct = (record as unknown as Record<string, unknown>)[fieldKey];
  return direct !== undefined ? direct : null;
}

/**
 * Build a tenant-scoped outbound PMS command for a Matter (`open_matter`,
 * `update_matter_commercials`, or `revise_fee_estimate`), including mapped fields
 * owned by 1Squared (`onesquared_master` or `bidirectional`).
 */
export function buildPmsOutboundMatterCommand(input: {
  commandId: string;
  tenantId: string;
  correlationId: string;
  commandType: Extract<
    PmsOutboundCommandType,
    'open_matter' | 'update_matter_commercials' | 'revise_fee_estimate'
  >;
  matter: Matter;
  pmsLinks: PmsLink[];
  fieldMappings: PmsFieldMappingEntry[];
  values: ChoiceValue[];
  createdById: string;
  nowIso?: string;
}): PmsOutboundCommand<{
  matterNumber: string;
  title: string;
  clientId: string;
  externalClientCode: string | null;
  feeEstimateGbp: number | null;
  agreedFeeCapGbp: number | null;
  billingBasisLabel: string;
}> {
  if (!input.tenantId || !input.tenantId.trim()) {
    throw new Error(
      'PMS_OUTBOUND_TENANCY_ERROR: Outbound PMS commands require a valid tenantId.',
    );
  }

  const externalMatterCode = findPmsCodeForRecord(
    input.pmsLinks,
    'matter',
    input.matter.id,
  );
  const externalClientCode =
    findPmsCodeForRecord(input.pmsLinks, 'organisation', input.matter.clientId) ??
    findPmsCodeForRecord(input.pmsLinks, 'person', input.matter.clientId);

  const mappedFields: Record<string, unknown> = {};
  for (const mapping of input.fieldMappings) {
    if (!mapping.active) continue;
    if (mapping.entityType !== 'matter' && mapping.entityType !== 'fee_estimate') {
      continue;
    }
    if (
      mapping.ownership !== 'onesquared_master' &&
      mapping.ownership !== 'bidirectional'
    ) {
      continue;
    }
    mappedFields[mapping.externalFieldKey] = resolveOneSquaredFieldValueForMapping(
      input.matter,
      mapping.onesquaredFieldKey,
      input.values,
    );
  }

  return {
    id: input.commandId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    commandType: input.commandType,
    entityType: 'matter',
    onesquaredId: input.matter.id,
    externalPmsCode: externalMatterCode,
    payload: {
      matterNumber: input.matter.matterNumber,
      title: input.matter.title,
      clientId: input.matter.clientId,
      externalClientCode,
      feeEstimateGbp: input.matter.feeEstimateGbp,
      agreedFeeCapGbp: input.matter.agreedFeeCapGbp,
      billingBasisLabel:
        resolveLabel(input.values, input.matter.billingBasisId) ||
        input.matter.billingBasisId,
    },
    mappedFields,
    createdAt: input.nowIso ?? new Date().toISOString(),
    createdById: input.createdById,
  };
}

export interface PmsMatterReconciliationResult {
  updatedMatterFields: Partial<Pick<Matter, 'feeEstimateGbp' | 'agreedFeeCapGbp' | 'title'>>;
  updatedFieldValues: Record<string, unknown>;
  discrepancies: {
    onesquaredFieldKey: string;
    externalFieldKey: string;
    onesquaredValue: unknown;
    externalValue: unknown;
    ownership: PmsFieldMappingEntry['ownership'];
  }[];
}

/**
 * Reconcile inbound third-party PMS matter financials against a 1Squared Matter:
 * - Fields with `ownership === 'pms_master'` or `'bidirectional'` can update 1Squared when changed in the PMS.
 * - Fields with `ownership === 'onesquared_master'` are never overwritten by the PMS; if they differ,
 *   a discrepancy is recorded so an outbound sync or review can resolve it.
 */
export function reconcilePmsInboundMatterCommercials(
  matter: Matter,
  pmsFinancials: PmsMatterFinancials,
  fieldMappings: PmsFieldMappingEntry[],
  values: ChoiceValue[] = [],
): PmsMatterReconciliationResult {
  const updatedMatterFields: Partial<
    Pick<Matter, 'feeEstimateGbp' | 'agreedFeeCapGbp' | 'title'>
  > = {};
  const updatedFieldValues: Record<string, unknown> = {};
  const discrepancies: PmsMatterReconciliationResult['discrepancies'] = [];

  const externalRecord = pmsFinancials as unknown as Record<string, unknown>;

  for (const mapping of fieldMappings) {
    if (!mapping.active || mapping.entityType !== 'matter') continue;
    const extVal = externalRecord[mapping.externalFieldKey];
    if (extVal === undefined) continue;

    const currentVal = resolveOneSquaredFieldValueForMapping(
      matter,
      mapping.onesquaredFieldKey,
      values,
    );

    const isDifferent = String(currentVal ?? '') !== String(extVal ?? '');
    if (!isDifferent) continue;

    if (mapping.ownership === 'onesquared_master') {
      discrepancies.push({
        onesquaredFieldKey: mapping.onesquaredFieldKey,
        externalFieldKey: mapping.externalFieldKey,
        onesquaredValue: currentVal,
        externalValue: extVal,
        ownership: mapping.ownership,
      });
      continue;
    }

    // ownership is 'pms_master' or 'bidirectional' -> accept inbound update
    if (mapping.onesquaredFieldKey === 'feeEstimateGbp' && typeof extVal === 'number') {
      updatedMatterFields.feeEstimateGbp = extVal;
    } else if (
      mapping.onesquaredFieldKey === 'agreedFeeCapGbp' &&
      typeof extVal === 'number'
    ) {
      updatedMatterFields.agreedFeeCapGbp = extVal;
    } else if (mapping.onesquaredFieldKey === 'title' && typeof extVal === 'string') {
      updatedMatterFields.title = extVal;
    } else if (mapping.onesquaredFieldKey.startsWith('CORE-') || mapping.onesquaredFieldKey.startsWith('FG')) {
      updatedFieldValues[mapping.onesquaredFieldKey] = extVal;
    }
  }

  return {
    updatedMatterFields,
    updatedFieldValues,
    discrepancies,
  };
}

function roundMoney2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sumMoneyPence<T>(rows: readonly T[], selector: (row: T) => number): number {
  let totalPence = 0;
  for (const row of rows) {
    const val = selector(row);
    if (Number.isFinite(val)) {
      totalPence += Math.round(val * 100);
    }
  }
  return roundMoney2(totalPence / 100);
}

/**
 * Compute per-client financial summary (`PmsClientFinancials`) purely from
 * matter-filtered `PmsMatterFinancials` and `PmsInvoiceBalance` rows (ADR 0029).
 */
export function buildClientFinancialsFromRows(
  client: PmsClient,
  visibleMatters: readonly PmsMatterFinancials[],
  visibleInvoices: readonly PmsInvoiceBalance[],
): PmsClientFinancials {
  const clientMatters = visibleMatters.filter((m) => m.client_code === client.client_code);
  const clientInvoices = visibleInvoices.filter(
    (inv) => inv.client_code === client.client_code && inv.invoice_type !== 'Credit note',
  );

  const unbilled_wip = sumMoneyPence(clientMatters, (m) => m.unbilled_wip);
  const fees_billed = sumMoneyPence(clientMatters, (m) => m.fees_billed);
  const disbursements_billed = sumMoneyPence(clientMatters, (m) => m.disbursements_billed);
  const total_invoiced_inc_vat = sumMoneyPence(clientMatters, (m) => m.total_invoiced_inc_vat);
  const total_paid = sumMoneyPence(clientMatters, (m) => m.total_paid);
  const outstanding_debt = sumMoneyPence(clientMatters, (m) => m.outstanding_debt);
  const unbilled_disbursements = sumMoneyPence(clientMatters, (m) => m.unbilled_disbursements);
  const client_account_balance = sumMoneyPence(clientMatters, (m) => m.client_account_balance);

  const aged_not_yet_due = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === 'Not yet due' ? i.outstanding : 0,
  );
  const aged_1_30 = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '1-30' ? i.outstanding : 0,
  );
  const aged_31_60 = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '31-60' ? i.outstanding : 0,
  );
  const aged_61_90 = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '61-90' ? i.outstanding : 0,
  );
  const aged_90_plus = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '90+' ? i.outstanding : 0,
  );

  const credit_limit = roundMoney2(client.credit_limit);

  return {
    client_code: client.client_code,
    client_name: client.client_name,
    client_type: client.client_type,
    company_number: client.company_number,
    email: client.email,
    client_partner_id: client.client_partner_id,
    credit_terms_days: client.credit_terms_days,
    credit_limit,
    rate_discount_pct: client.rate_discount_pct,
    status: client.status,
    unbilled_wip,
    fees_billed,
    disbursements_billed,
    total_invoiced_inc_vat,
    total_paid,
    outstanding_debt,
    unbilled_disbursements,
    client_account_balance,
    aged_not_yet_due,
    aged_1_30,
    aged_31_60,
    aged_61_90,
    aged_90_plus,
    credit_limit_used_pct: credit_limit > 0 ? outstanding_debt / credit_limit : null,
  };
}

/**
 * Compute a fee earner's weekly time and unbilled WIP (`PmsFeeEarnerWeeklyTime`)
 * purely from matter-filtered `PmsTimeEntry` rows (ADR 0029).
 */
export function buildFeeEarnerWeeklyTime(params: {
  feeEarner: Pick<PmsFeeEarner, 'fee_earner_id' | 'annual_target_hours'> | null | undefined;
  timeEntries: readonly PmsTimeEntry[];
  asAtDate: string;
  customDailyPace?: number | null;
}): PmsFeeEarnerWeeklyTime | null {
  const { feeEarner, timeEntries, asAtDate, customDailyPace } = params;
  if (!feeEarner || !isValidPmsAsAtDate(asAtDate)) return null;

  const rawTargetHours = Number(feeEarner.annual_target_hours ?? 0);
  const targetHours =
    Number.isFinite(rawTargetHours) && rawTargetHours > 0 ? rawTargetHours : 0;
  const defaultDailyPace =
    targetHours > 0 ? Math.round((targetHours / (260 - 30)) * 10) / 10 : 0;
  const dailyPaceHours =
    typeof customDailyPace === 'number' && customDailyPace > 0
      ? customDailyPace
      : defaultDailyPace;
  const weeklyPaceHours = dailyPaceHours > 0 ? Math.round(dailyPaceHours * 5 * 10) / 10 : 0;

  const visibleEntries = timeEntries.filter(
    (t) =>
      t.fee_earner_id === feeEarner.fee_earner_id &&
      t.chargeable === 'Y',
  );

  const asAtIso = asAtDate.slice(0, 10);
  const parsedAsAt = new Date(`${asAtIso}T00:00:00Z`);
  const utcDay = parsedAsAt.getUTCDay();
  const offsetToMonday = utcDay === 0 ? -6 : 1 - utcDay;
  const mondayMs = parsedAsAt.getTime() + offsetToMonday * 86_400_000;
  const dayLabels: readonly ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri')[] = [
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
  ];
  const weekDaysSpec = dayLabels.map((dayLabel, idx) => ({
    dayLabel,
    date: new Date(mondayMs + idx * 86_400_000).toISOString().slice(0, 10),
  }));
  const weekStart = weekDaysSpec[0]!.date;
  const weekEnd = weekDaysSpec[4]!.date;

  const hoursByDate = new Map<string, number>();
  for (const t of visibleEntries) {
    if (t.date >= weekStart && t.date <= weekEnd && t.date <= asAtIso) {
      hoursByDate.set(t.date, roundMoney2((hoursByDate.get(t.date) ?? 0) + t.hours));
    }
  }

  const weekdays = weekDaysSpec.map((d) => ({
    dayLabel: d.dayLabel,
    date: d.date,
    hours: hoursByDate.get(d.date) ?? 0,
  }));
  const weekTotalHours = Math.round(weekdays.reduce((acc, d) => acc + d.hours, 0) * 10) / 10;

  let mtdHours = 0;
  let unbilledWip = 0;
  const unbilledMatters = new Set<string>();
  let oldestUnbilledDate: string | null = null;
  const currentYm = asAtIso.slice(0, 7);

  for (const t of visibleEntries) {
    if (t.date.slice(0, 7) === currentYm && t.date <= asAtIso) {
      mtdHours += t.hours;
    }
    if (t.billed_status === 'Unbilled') {
      unbilledWip += t.value;
      unbilledMatters.add(t.matter_code);
      if (!oldestUnbilledDate || t.date < oldestUnbilledDate) {
        oldestUnbilledDate = t.date;
      }
    }
  }

  return {
    feeEarnerId: feeEarner.fee_earner_id,
    weekTotalHours,
    dailyPaceHours,
    weeklyPaceHours,
    weekdays,
    monthToDateHours: roundMoney2(mtdHours),
    myUnbilledWip: roundMoney2(unbilledWip),
    myUnbilledMatterCount: unbilledMatters.size,
    oldestUnbilledDate,
  };
}

export interface FirmFinanceRollupInputRows {
  asAtDate: string;
  feeEarners: readonly PmsFeeEarner[];
  clients: readonly PmsClient[];
  matterFinancials: readonly PmsMatterFinancials[];
  invoices: readonly PmsInvoiceBalance[];
  timeEntries: readonly PmsTimeEntry[];
  payments: readonly PmsPayment[];
}

export interface FirmFinanceRollups {
  allFeeEarnerPerformance: PmsFeeEarnerPerformance[];
  allClientFins: PmsClientFinancials[];
  pmsMonthlyFeesBilled: { months: PmsMonthlyFeesBilled[]; yearToDateTotal: number };
  pmsCashReceived: PmsCashReceivedSummary;
  pmsDepartmentFinancials: {
    departments: PmsDepartmentFinancials[];
    firmTotal: PmsDepartmentFinancials;
  };
}

/**
 * Pure domain roll-up calculator (`buildFirmFinanceRollups`) that computes
 * fee-earner performance, client financials, monthly fees billed, cash received,
 * and department financials from matter-filtered row-level PMS records (ADR 0029).
 *
 * Restricted matters in `hiddenMatterCodes` (staff matters and ethical-wall matters
 * the caller cannot access) are excluded from every total.
 */
export function buildFirmFinanceRollups(
  rows: FirmFinanceRollupInputRows,
  hiddenMatterCodes: ReadonlySet<string> = new Set(),
): FirmFinanceRollups {
  if (!isValidPmsAsAtDate(rows.asAtDate)) {
    return {
      allFeeEarnerPerformance: [],
      allClientFins: [],
      pmsMonthlyFeesBilled: { months: [], yearToDateTotal: 0 },
      pmsCashReceived: {
        currentMonthTotal: 0,
        currentMonthReceiptCount: 0,
        previousMonthTotal: 0,
        previousMonthReceiptCount: 0,
      },
      pmsDepartmentFinancials: {
        departments: [],
        firmTotal: {
          practiceArea: 'Firm total',
          openMatters: 0,
          billedThisYear: 0,
          unbilledWip: 0,
          outstandingDebt: 0,
          overdueDebt: 0,
          currentMonthHours: 0,
        },
      },
    };
  }

  const visibleMatters = rows.matterFinancials.filter(
    (m) => !hiddenMatterCodes.has(m.matter_code),
  );
  const visibleInvoices = rows.invoices.filter(
    (inv) => !hiddenMatterCodes.has(inv.matter_code),
  );
  const visibleTimeEntries = rows.timeEntries.filter(
    (t) => !hiddenMatterCodes.has(t.matter_code),
  );
  const visiblePayments = rows.payments.filter(
    (p) => !hiddenMatterCodes.has(p.matter_code),
  );

  const asAtIso = rows.asAtDate.slice(0, 10);
  const asAtYear = asAtIso.slice(0, 4);
  const asAtYearNum = Number(asAtYear) || 0;
  const asAtMonthNum = Math.min(12, Math.max(1, Number(asAtIso.slice(5, 7)) || 12));
  const currentYm = asAtIso.slice(0, 7);
  const prevYearNum = asAtMonthNum === 1 ? asAtYearNum - 1 : asAtYearNum;
  const prevMonthNum = asAtMonthNum === 1 ? 12 : asAtMonthNum - 1;
  const previousYm = `${String(prevYearNum).padStart(4, '0')}-${String(prevMonthNum).padStart(2, '0')}`;

  // 1. Fee-earner performance (chargeable_hours & pct_of_annual_target scoped to as-at year up to asAtIso, R339)
  const sortedFeeEarners = [...rows.feeEarners].sort((a, b) =>
    a.fee_earner_id.localeCompare(b.fee_earner_id),
  );
  const allFeeEarnerPerformance: PmsFeeEarnerPerformance[] = sortedFeeEarners.map((fe) => {
    const feEntries = visibleTimeEntries.filter((t) => t.fee_earner_id === fe.fee_earner_id);
    const chargeable_hours = sumMoneyPence(feEntries, (t) =>
      t.chargeable === 'Y' && t.date.slice(0, 4) === asAtYear && t.date <= asAtIso
        ? t.hours
        : 0,
    );
    const chargeable_hours_this_month = sumMoneyPence(feEntries, (t) =>
      t.chargeable === 'Y' && t.date.slice(0, 7) === currentYm && t.date <= asAtIso
        ? t.hours
        : 0,
    );
    const time_value = sumMoneyPence(feEntries, (t) => t.value);
    const unbilled_wip = sumMoneyPence(feEntries, (t) =>
      t.billed_status === 'Unbilled' ? t.value : 0,
    );
    const billed_value = sumMoneyPence(feEntries, (t) => t.billed_value);
    const written_off = sumMoneyPence(feEntries, (t) => t.write_off_value);
    const annual_target_hours = Number(fe.annual_target_hours ?? 0);
    const pct_of_annual_target =
      annual_target_hours > 0 ? chargeable_hours / annual_target_hours : 0;

    return {
      fee_earner_id: fe.fee_earner_id,
      initials: fe.initials,
      name: `${fe.first_name} ${fe.last_name}`,
      email: fe.email,
      grade: fe.grade,
      department: fe.department,
      standard_hourly_rate: roundMoney2(fe.standard_hourly_rate),
      chargeable_hours,
      chargeable_hours_this_month,
      time_value,
      unbilled_wip,
      billed_value,
      written_off,
      annual_target_hours,
      pct_of_annual_target,
    };
  });

  // 2. Client financials
  const sortedClients = [...rows.clients].sort((a, b) =>
    a.client_code.localeCompare(b.client_code),
  );
  const allClientFins: PmsClientFinancials[] = sortedClients.map((client) =>
    buildClientFinancialsFromRows(client, visibleMatters, visibleInvoices),
  );

  // 3. Monthly fees billed (derived from asAtDate year and month range up to asAtIso, R339)
  const byYm = new Map<string, number>();
  for (const inv of visibleInvoices) {
    if (
      inv.invoice_date.slice(0, 4) !== asAtYear ||
      inv.invoice_date > asAtIso ||
      inv.exported_status === 'Draft'
    ) {
      continue;
    }
    const ym = inv.invoice_date.slice(0, 7);
    byYm.set(ym, roundMoney2((byYm.get(ym) ?? 0) + inv.fees_net));
  }
  const allMonthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const monthNames = allMonthNames.slice(0, asAtMonthNum);
  const months: PmsMonthlyFeesBilled[] = monthNames.map((shortName, idx) => {
    const monthKey = `${asAtYear}-${String(idx + 1).padStart(2, '0')}`;
    return {
      monthKey,
      monthShort: shortName,
      feesNet: byYm.get(monthKey) ?? 0,
    };
  });
  const yearToDateTotal = roundMoney2(months.reduce((acc, m) => acc + m.feesNet, 0));

  // 4. Cash received summary (derived from asAtDate current & previous month)
  let currentMonthTotal = 0;
  let currentMonthReceiptCount = 0;
  let previousMonthTotal = 0;
  let previousMonthReceiptCount = 0;
  for (const p of visiblePayments) {
    if (p.receipt_date > asAtIso) continue;
    const ym = p.receipt_date.slice(0, 7);
    if (ym === currentYm) {
      currentMonthTotal += p.amount;
      currentMonthReceiptCount += 1;
    } else if (ym === previousYm) {
      previousMonthTotal += p.amount;
      previousMonthReceiptCount += 1;
    }
  }
  const pmsCashReceived: PmsCashReceivedSummary = {
    currentMonthTotal: roundMoney2(currentMonthTotal),
    currentMonthReceiptCount,
    previousMonthTotal: roundMoney2(previousMonthTotal),
    previousMonthReceiptCount,
  };

  // 5. Department financials (billedThisYear scoped to as-at year up to asAtIso, R339)
  const matterPracticeAreaByCode = new Map<string, string>();
  const mattersByPracticeArea = new Map<string, PmsMatterFinancials[]>();
  for (const m of visibleMatters) {
    matterPracticeAreaByCode.set(m.matter_code, m.practice_area);
    const list = mattersByPracticeArea.get(m.practice_area) ?? [];
    list.push(m);
    mattersByPracticeArea.set(m.practice_area, list);
  }

  const departments: PmsDepartmentFinancials[] = [];
  for (const [practiceArea, deptMatters] of mattersByPracticeArea.entries()) {
    const openMatters = deptMatters.filter((m) => m.status === 'Open').length;
    const billedThisYear = roundMoney2(
      visibleInvoices
        .filter(
          (inv) =>
            matterPracticeAreaByCode.get(inv.matter_code) === practiceArea &&
            inv.invoice_date.slice(0, 4) === asAtYear &&
            inv.invoice_date <= asAtIso &&
            inv.exported_status !== 'Draft',
        )
        .reduce((s, inv) => s + inv.fees_net, 0),
    );
    const unbilledWip = roundMoney2(deptMatters.reduce((s, m) => s + m.unbilled_wip, 0));
    const outstandingDebt = roundMoney2(
      deptMatters.reduce((s, m) => s + m.outstanding_debt, 0),
    );
    const overdueDebt = roundMoney2(
      visibleInvoices
        .filter(
          (inv) =>
            matterPracticeAreaByCode.get(inv.matter_code) === practiceArea &&
            (inv.days_past_due ?? 0) > 0,
        )
        .reduce((s, inv) => s + inv.outstanding, 0),
    );
    const currentMonthHours = roundMoney2(
      visibleTimeEntries
        .filter(
          (t) =>
            matterPracticeAreaByCode.get(t.matter_code) === practiceArea &&
            t.chargeable === 'Y' &&
            t.date.slice(0, 7) === currentYm &&
            t.date <= asAtIso,
        )
        .reduce((s, t) => s + t.hours, 0),
    );
    departments.push({
      practiceArea,
      openMatters,
      billedThisYear,
      unbilledWip,
      outstandingDebt,
      overdueDebt,
      currentMonthHours,
    });
  }
  departments.sort((a, b) => b.billedThisYear - a.billedThisYear);

  const firmTotal: PmsDepartmentFinancials = {
    practiceArea: 'Firm total',
    openMatters: departments.reduce((s, d) => s + d.openMatters, 0),
    billedThisYear: roundMoney2(departments.reduce((s, d) => s + d.billedThisYear, 0)),
    unbilledWip: roundMoney2(departments.reduce((s, d) => s + d.unbilledWip, 0)),
    outstandingDebt: roundMoney2(departments.reduce((s, d) => s + d.outstandingDebt, 0)),
    overdueDebt: roundMoney2(departments.reduce((s, d) => s + d.overdueDebt, 0)),
    currentMonthHours:
      Math.round(departments.reduce((s, d) => s + d.currentMonthHours, 0) * 10) / 10,
  };

  return {
    allFeeEarnerPerformance,
    allClientFins,
    pmsMonthlyFeesBilled: { months, yearToDateTotal },
    pmsCashReceived,
    pmsDepartmentFinancials: { departments, firmTotal },
  };
}
