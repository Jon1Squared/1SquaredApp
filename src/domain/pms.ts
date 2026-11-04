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
import { resolvePersonPermissionSet } from './rbac';
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
import type { PmsClient, PmsFeeEarner, PmsMatter, PmsMatterFinancials } from '@/pms/types';

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

/** Format the PMS as-at date label (e.g. "16 Oct 2026"). */
export function formatPmsAsAtLabel(asAtDate: string = '2026-10-16'): string {
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
): boolean {
  if (!user) return true;
  const appRole: AppRole = resolveUserAppRole(user, teams, values);
  if (appRole === 'call_handler') return false;
  const perms = resolvePersonPermissionSet(user, { teams });
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
