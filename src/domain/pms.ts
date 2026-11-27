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
import {
  minorUnitsToPounds,
  poundsToMinorUnits,
  sumMinorUnits,
  type MinorUnits,
  type PmsFieldMappingEntry,
  type PmsOutboundCommand,
  type PmsOutboundCommandType,
} from '@platform/core-api';
import type {
  PmsCashReceivedSummary,
  PmsClient,
  PmsClientFinancials,
  PmsDepartmentFinancials,
  PmsExtractInfo,
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

function toSafeMinorUnits(n: number | null | undefined): MinorUnits {
  if (n === null || n === undefined) return 0 as MinorUnits;
  const num = Number(n);
  if (!Number.isFinite(num)) return 0 as MinorUnits;
  if (/[eE]/.test(String(num))) {
    return Math.abs(num) < 1e-6 ? (0 as MinorUnits) : poundsToMinorUnits(num.toFixed(6));
  }
  return poundsToMinorUnits(num);
}

/** Return pre-computed integer pence when present, falling back to decimal conversion only for unmigrated fixtures. */
export function resolvePmsPence(
  pence: MinorUnits | null | undefined,
  fallbackGbp?: number | null,
): MinorUnits {
  if (typeof pence === 'number' && Number.isSafeInteger(pence)) {
    return pence as MinorUnits;
  }
  return toSafeMinorUnits(fallbackGbp);
}

/** Format GBP currency with £ and 2 decimal places; negatives in brackets. Corrupt/null amounts render as "Not available". */
export function formatGbp(amount: number | null | undefined): string {
  if (amount === null || (typeof amount === 'number' && !Number.isFinite(amount))) {
    return 'Not available';
  }
  const minor = toSafeMinorUnits(amount);
  const absPounds = minorUnitsToPounds(Math.abs(minor));
  const formatted = absPounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (minor < 0) {
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

  // 4. Optional initial seed links for matters that exist in both systems
  if (includeInitialSeedMatterLinks) {
    for (const m of matters) {
      if (m.mergedIntoId) continue;
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

function roundHours2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sumMoneyPence<T>(rows: readonly T[], selector: (row: T) => MinorUnits): MinorUnits {
  return sumMinorUnits(rows.map(selector));
}

function sumHours2<T>(rows: readonly T[], selector: (row: T) => number): number {
  let total = 0;
  for (const row of rows) {
    const val = selector(row);
    if (Number.isFinite(val)) total += val;
  }
  return roundHours2(total);
}

/**
 * Compute per-client financial summary (`PmsClientFinancials`) purely from
 * matter-filtered `PmsMatterFinancials` and `PmsInvoiceBalance` rows (ADR 0029).
 */
export function buildClientFinancialsFromRows(
  client: PmsClient,
  visibleMatters: readonly PmsMatterFinancials[],
  visibleInvoices: readonly PmsInvoiceBalance[],
  asAtDate?: string,
): PmsClientFinancials {
  const clientMatters = visibleMatters.filter((m) => m.client_code === client.client_code);
  const clientInvoices = visibleInvoices.filter(
    (inv) => inv.client_code === client.client_code && inv.invoice_type !== 'Credit note',
  );

  const unbilled_wip_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.unbilled_wip_pence, m.unbilled_wip),
  );
  const fees_billed_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.fees_billed_pence, m.fees_billed),
  );
  const fees_billed_ytd_pence = isValidPmsAsAtDate(asAtDate)
    ? sumMoneyPence(visibleInvoices, (inv) =>
        inv.client_code === client.client_code &&
        inv.invoice_date.slice(0, 4) === asAtDate.slice(0, 4) &&
        inv.invoice_date <= asAtDate.slice(0, 10)
          ? resolvePmsPence(inv.fees_net_pence, inv.fees_net)
          : (0 as MinorUnits),
      )
    : (0 as MinorUnits);
  const disbursements_billed_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.disbursements_billed_pence, m.disbursements_billed),
  );
  const total_invoiced_inc_vat_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.total_invoiced_inc_vat_pence, m.total_invoiced_inc_vat),
  );
  const total_paid_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.total_paid_pence, m.total_paid),
  );
  const outstanding_debt_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.outstanding_debt_pence, m.outstanding_debt),
  );
  const unbilled_disbursements_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.unbilled_disbursements_pence, m.unbilled_disbursements),
  );
  const client_account_balance_pence = sumMoneyPence(clientMatters, (m) =>
    resolvePmsPence(m.client_account_balance_pence, m.client_account_balance),
  );

  const aged_not_yet_due_pence = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === 'Not yet due'
      ? resolvePmsPence(i.outstanding_pence, i.outstanding)
      : (0 as MinorUnits),
  );
  const aged_1_30_pence = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '1-30'
      ? resolvePmsPence(i.outstanding_pence, i.outstanding)
      : (0 as MinorUnits),
  );
  const aged_31_60_pence = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '31-60'
      ? resolvePmsPence(i.outstanding_pence, i.outstanding)
      : (0 as MinorUnits),
  );
  const aged_61_90_pence = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '61-90'
      ? resolvePmsPence(i.outstanding_pence, i.outstanding)
      : (0 as MinorUnits),
  );
  const aged_90_plus_pence = sumMoneyPence(clientInvoices, (i) =>
    i.age_bucket === '90+'
      ? resolvePmsPence(i.outstanding_pence, i.outstanding)
      : (0 as MinorUnits),
  );

  const credit_limit_pence = resolvePmsPence(client.credit_limit_pence, client.credit_limit);

  return {
    client_code: client.client_code,
    client_name: client.client_name,
    client_type: client.client_type,
    company_number: client.company_number,
    email: client.email,
    client_partner_id: client.client_partner_id,
    credit_terms_days: client.credit_terms_days,
    credit_limit: minorUnitsToPounds(credit_limit_pence),
    credit_limit_pence,
    rate_discount_pct: client.rate_discount_pct,
    status: client.status,
    unbilled_wip: minorUnitsToPounds(unbilled_wip_pence),
    unbilled_wip_pence,
    fees_billed: minorUnitsToPounds(fees_billed_pence),
    fees_billed_pence,
    fees_billed_ytd: minorUnitsToPounds(fees_billed_ytd_pence),
    fees_billed_ytd_pence,
    disbursements_billed: minorUnitsToPounds(disbursements_billed_pence),
    disbursements_billed_pence,
    total_invoiced_inc_vat: minorUnitsToPounds(total_invoiced_inc_vat_pence),
    total_invoiced_inc_vat_pence,
    total_paid: minorUnitsToPounds(total_paid_pence),
    total_paid_pence,
    outstanding_debt: minorUnitsToPounds(outstanding_debt_pence),
    outstanding_debt_pence,
    unbilled_disbursements: minorUnitsToPounds(unbilled_disbursements_pence),
    unbilled_disbursements_pence,
    client_account_balance: minorUnitsToPounds(client_account_balance_pence),
    client_account_balance_pence,
    aged_not_yet_due: minorUnitsToPounds(aged_not_yet_due_pence),
    aged_not_yet_due_pence,
    aged_1_30: minorUnitsToPounds(aged_1_30_pence),
    aged_1_30_pence,
    aged_31_60: minorUnitsToPounds(aged_31_60_pence),
    aged_31_60_pence,
    aged_61_90: minorUnitsToPounds(aged_61_90_pence),
    aged_61_90_pence,
    aged_90_plus: minorUnitsToPounds(aged_90_plus_pence),
    aged_90_plus_pence,
    credit_limit_used_pct:
      credit_limit_pence > 0 ? outstanding_debt_pence / credit_limit_pence : null,
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
      hoursByDate.set(t.date, roundHours2((hoursByDate.get(t.date) ?? 0) + t.hours));
    }
  }

  const weekdays = weekDaysSpec.map((d) => ({
    dayLabel: d.dayLabel,
    date: d.date,
    hours: hoursByDate.get(d.date) ?? 0,
  }));
  const weekTotalHours = Math.round(weekdays.reduce((acc, d) => acc + d.hours, 0) * 10) / 10;

  let mtdHours = 0;
  let unbilledWipPence = 0 as MinorUnits;
  const unbilledMatters = new Set<string>();
  let oldestUnbilledDate: string | null = null;
  const currentYm = asAtIso.slice(0, 7);

  for (const t of visibleEntries) {
    if (t.date.slice(0, 7) === currentYm && t.date <= asAtIso) {
      mtdHours += t.hours;
    }
    if (t.billed_status === 'Unbilled') {
      unbilledWipPence = sumMinorUnits([
        unbilledWipPence,
        resolvePmsPence(t.value_pence, t.value),
      ]);
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
    monthToDateHours: roundHours2(mtdHours),
    myUnbilledWip: minorUnitsToPounds(unbilledWipPence),
    myUnbilledWipPence: unbilledWipPence,
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
          billedThisYearPence: 0 as MinorUnits,
          unbilledWip: 0,
          unbilledWipPence: 0 as MinorUnits,
          outstandingDebt: 0,
          outstandingDebtPence: 0 as MinorUnits,
          overdueDebt: 0,
          overdueDebtPence: 0 as MinorUnits,
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

  // 1. Fee-earner performance (chargeable_hours, pct_of_annual_target, time_value, billed_value & written_off scoped to as-at year up to asAtIso, R339, R358)
  const sortedFeeEarners = [...rows.feeEarners].sort((a, b) =>
    a.fee_earner_id.localeCompare(b.fee_earner_id),
  );
  const allFeeEarnerPerformance: PmsFeeEarnerPerformance[] = sortedFeeEarners.map((fe) => {
    const feEntries = visibleTimeEntries.filter((t) => t.fee_earner_id === fe.fee_earner_id);
    const feYearEntries = feEntries.filter(
      (t) => t.date.slice(0, 4) === asAtYear && t.date <= asAtIso,
    );
    const chargeable_hours = sumHours2(feYearEntries, (t) =>
      t.chargeable === 'Y' ? t.hours : 0,
    );
    const chargeable_hours_this_month = sumHours2(feEntries, (t) =>
      t.chargeable === 'Y' && t.date.slice(0, 7) === currentYm && t.date <= asAtIso
        ? t.hours
        : 0,
    );
    const time_value_pence = sumMoneyPence(feYearEntries, (t) =>
      resolvePmsPence(t.value_pence, t.value),
    );
    const unbilled_wip_pence = sumMoneyPence(feEntries, (t) =>
      t.billed_status === 'Unbilled'
        ? resolvePmsPence(t.value_pence, t.value)
        : (0 as MinorUnits),
    );
    const billed_value_pence = sumMoneyPence(feYearEntries, (t) =>
      resolvePmsPence(t.billed_value_pence, t.billed_value),
    );
    const written_off_pence = sumMoneyPence(feYearEntries, (t) =>
      resolvePmsPence(t.write_off_value_pence, t.write_off_value),
    );
    const standard_hourly_rate_pence = resolvePmsPence(
      fe.standard_hourly_rate_pence,
      fe.standard_hourly_rate,
    );
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
      standard_hourly_rate: minorUnitsToPounds(standard_hourly_rate_pence),
      standard_hourly_rate_pence,
      chargeable_hours,
      chargeable_hours_this_month,
      time_value: minorUnitsToPounds(time_value_pence),
      time_value_pence,
      unbilled_wip: minorUnitsToPounds(unbilled_wip_pence),
      unbilled_wip_pence,
      billed_value: minorUnitsToPounds(billed_value_pence),
      billed_value_pence,
      written_off: minorUnitsToPounds(written_off_pence),
      written_off_pence,
      annual_target_hours,
      pct_of_annual_target,
    };
  });

  // 2. Client financials
  const sortedClients = [...rows.clients].sort((a, b) =>
    a.client_code.localeCompare(b.client_code),
  );
  const allClientFins: PmsClientFinancials[] = sortedClients.map((client) =>
    buildClientFinancialsFromRows(client, visibleMatters, visibleInvoices, asAtIso),
  );

  // 3. Monthly fees billed (derived from asAtDate year and month range up to asAtIso, R339)
  const byYmPence = new Map<string, MinorUnits>();
  for (const inv of visibleInvoices) {
    if (
      inv.invoice_date.slice(0, 4) !== asAtYear ||
      inv.invoice_date > asAtIso ||
      inv.exported_status === 'Draft'
    ) {
      continue;
    }
    const ym = inv.invoice_date.slice(0, 7);
    byYmPence.set(
      ym,
      sumMinorUnits([
        byYmPence.get(ym) ?? (0 as MinorUnits),
        resolvePmsPence(inv.fees_net_pence, inv.fees_net),
      ]),
    );
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
      feesNet: minorUnitsToPounds(byYmPence.get(monthKey) ?? (0 as MinorUnits)),
    };
  });
  const yearToDateTotalPence = sumMinorUnits(
    monthNames.map(
      (_, idx) =>
        byYmPence.get(`${asAtYear}-${String(idx + 1).padStart(2, '0')}`) ??
        (0 as MinorUnits),
    ),
  );
  const yearToDateTotal = minorUnitsToPounds(yearToDateTotalPence);

  // 4. Cash received summary (derived from asAtDate current & previous month)
  let currentMonthPence = 0 as MinorUnits;
  let currentMonthReceiptCount = 0;
  let previousMonthPence = 0 as MinorUnits;
  let previousMonthReceiptCount = 0;
  for (const p of visiblePayments) {
    if (p.receipt_date > asAtIso) continue;
    const ym = p.receipt_date.slice(0, 7);
    if (ym === currentYm) {
      currentMonthPence = sumMinorUnits([
        currentMonthPence,
        resolvePmsPence(p.amount_pence, p.amount),
      ]);
      currentMonthReceiptCount += 1;
    } else if (ym === previousYm) {
      previousMonthPence = sumMinorUnits([
        previousMonthPence,
        resolvePmsPence(p.amount_pence, p.amount),
      ]);
      previousMonthReceiptCount += 1;
    }
  }
  const pmsCashReceived: PmsCashReceivedSummary = {
    currentMonthTotal: minorUnitsToPounds(currentMonthPence),
    currentMonthReceiptCount,
    previousMonthTotal: minorUnitsToPounds(previousMonthPence),
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
    const billedThisYearPence = sumMoneyPence(
      visibleInvoices.filter(
        (inv) =>
          matterPracticeAreaByCode.get(inv.matter_code) === practiceArea &&
          inv.invoice_date.slice(0, 4) === asAtYear &&
          inv.invoice_date <= asAtIso &&
          inv.exported_status !== 'Draft',
      ),
      (inv) => resolvePmsPence(inv.fees_net_pence, inv.fees_net),
    );
    const unbilledWipPence = sumMoneyPence(deptMatters, (m) =>
      resolvePmsPence(m.unbilled_wip_pence, m.unbilled_wip),
    );
    const outstandingDebtPence = sumMoneyPence(deptMatters, (m) =>
      resolvePmsPence(m.outstanding_debt_pence, m.outstanding_debt),
    );
    const overdueDebtPence = sumMoneyPence(
      visibleInvoices.filter(
        (inv) =>
          matterPracticeAreaByCode.get(inv.matter_code) === practiceArea &&
          (inv.days_past_due ?? 0) > 0,
      ),
      (inv) => resolvePmsPence(inv.outstanding_pence, inv.outstanding),
    );
    const currentMonthHours = sumHours2(
      visibleTimeEntries.filter(
        (t) =>
          matterPracticeAreaByCode.get(t.matter_code) === practiceArea &&
          t.chargeable === 'Y' &&
          t.date.slice(0, 7) === currentYm &&
          t.date <= asAtIso,
      ),
      (t) => t.hours,
    );
    departments.push({
      practiceArea,
      openMatters,
      billedThisYear: minorUnitsToPounds(billedThisYearPence),
      billedThisYearPence,
      unbilledWip: minorUnitsToPounds(unbilledWipPence),
      unbilledWipPence,
      outstandingDebt: minorUnitsToPounds(outstandingDebtPence),
      outstandingDebtPence,
      overdueDebt: minorUnitsToPounds(overdueDebtPence),
      overdueDebtPence,
      currentMonthHours,
    });
  }
  departments.sort((a, b) => b.billedThisYear - a.billedThisYear);

  const firmBilledThisYearPence = sumMoneyPence(departments, (d) =>
    resolvePmsPence(d.billedThisYearPence, d.billedThisYear),
  );
  const firmUnbilledWipPence = sumMoneyPence(departments, (d) =>
    resolvePmsPence(d.unbilledWipPence, d.unbilledWip),
  );
  const firmOutstandingDebtPence = sumMoneyPence(departments, (d) =>
    resolvePmsPence(d.outstandingDebtPence, d.outstandingDebt),
  );
  const firmOverdueDebtPence = sumMoneyPence(departments, (d) =>
    resolvePmsPence(d.overdueDebtPence, d.overdueDebt),
  );

  const firmTotal: PmsDepartmentFinancials = {
    practiceArea: 'Firm total',
    openMatters: departments.reduce((s, d) => s + d.openMatters, 0),
    billedThisYear: minorUnitsToPounds(firmBilledThisYearPence),
    billedThisYearPence: firmBilledThisYearPence,
    unbilledWip: minorUnitsToPounds(firmUnbilledWipPence),
    unbilledWipPence: firmUnbilledWipPence,
    outstandingDebt: minorUnitsToPounds(firmOutstandingDebtPence),
    outstandingDebtPence: firmOutstandingDebtPence,
    overdueDebt: minorUnitsToPounds(firmOverdueDebtPence),
    overdueDebtPence: firmOverdueDebtPence,
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

export interface PmsAdminSnapshot {
  extractInfo: PmsExtractInfo;
  pmsLinks: PmsLink[];
  pmsFeeEarners: PmsFeeEarner[];
  pmsClients: PmsClient[];
  pmsMatters: PmsMatter[];
  suggestedMatterMatches: PmsSuggestedMatch[];
}

export type PmsLinksSubTab = 'organisations' | 'people' | 'employees' | 'matters';

export interface PmsLinkedRecordSummary {
  readonly id: string;
  readonly entityType: PmsEntityType;
  readonly label: string;
  readonly href: string;
  readonly companyNumber?: string;
  readonly primaryEmail?: string;
  readonly matterNumber?: string;
  readonly title?: string;
  readonly openedAt?: string | null;
}

export interface PmsUnlinkedOrganisationRow {
  readonly id: string;
  readonly legalName: string;
  readonly companyNumber: string;
  readonly generalEmail: string;
}

export interface PmsUnlinkedPersonRow {
  readonly id: string;
  readonly displayName: string;
  readonly primaryEmail: string;
}

export interface PmsUnlinkedEmployeeRow {
  readonly id: string;
  readonly displayName: string;
  readonly jobTitle: string;
  readonly primaryEmail: string;
}

export interface PmsUnlinkedMatterRow {
  readonly id: string;
  readonly matterNumber: string;
  readonly title: string;
  readonly openedAt: string | null;
}

export interface PmsLinksAdminPageData {
  readonly pmsAdmin: PmsAdminSnapshot;
  readonly subTab: PmsLinksSubTab;
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly linkedRecordTitles: Record<string, PmsLinkedRecordSummary>;
  readonly unlinkedOrganisationsPage: {
    readonly items: readonly PmsUnlinkedOrganisationRow[];
    readonly totalCount: number;
  };
  readonly unlinkedPeoplePage: {
    readonly items: readonly PmsUnlinkedPersonRow[];
    readonly totalCount: number;
  };
  readonly unlinkedEmployeesPage: {
    readonly items: readonly PmsUnlinkedEmployeeRow[];
    readonly totalCount: number;
  };
  readonly unlinkedMattersPage: {
    readonly items: readonly PmsUnlinkedMatterRow[];
    readonly totalCount: number;
  };
}
