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
import { normaliseEmail, normaliseOrgName, normaliseRegNumber, normaliseText } from './normalise';
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
import type { PmsClient, PmsFeeEarner, PmsMatter } from '@/pms/types';

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
  values: ChoiceValue[],
): boolean {
  if (!user) return true;
  const appRole: AppRole = resolveUserAppRole(user, teams, values);
  if (appRole === 'call_handler') return false;
  const empRoleLabel = resolveLabel(values, user.employeeRoleId).toLowerCase();
  if (empRoleLabel.includes('support staff') && appRole !== 'admin' && appRole !== 'team_lead') {
    return false;
  }
  return true;
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

  // 3. Employees <-> PMS fee_earners on work email (or local-part across @notalawfirm.co.uk / @pembrokevaughan.co.uk)
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

// Keep normaliseOrgName referenced for potential fuzzy matching
void normaliseOrgName;
