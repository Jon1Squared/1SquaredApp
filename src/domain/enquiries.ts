/**
 * Domain rules for Enquiries: validation, live duplicate checks, conflict pre-checks,
 * failed contact attempt tracking, sorting, and retention anonymisation.
 */
import { activeDefinitions, isCustomFieldValueMissing } from './customFields';
import { addMonths, isBefore } from './dates';
import {
  findOrganisationDuplicates,
  findPersonDuplicates,
  formatDuplicateReasons,
  REASON_STRENGTH,
  type DuplicateMatch,
  type DuplicateReason,
} from './duplicates';
import { resolveLabel } from './lists';
import { CONFLICT_SEARCHED_SOURCES, redactRecordId } from './matterConflicts';
import { personDisplayName } from './names';
import {
  extractEmailDomain,
  FREE_EMAIL_DOMAINS,
  hasMinThreeCharToken,
  isValidEmailFormat,
  isValidPhoneForCheck,
  isValidUkPostcode,
  normaliseComparableName,
  normaliseEmail,
  normaliseOrgName,
  normalisePhoneLast9,
  addressesMatch,
  organisationNameLooseMatch,
  personNameLooseMatch,
  type AddressLike,
  type LooseNameMatch,
} from './normalise';
import type { ResolvePersonPermissionsOptions } from './rbac';
import { isUserTeamLeadFor, resolveUserAppRole } from './tasks';
import type {
  ChoiceValue,
  CustomFieldDefinition,
  Enquiry,
  EnquiryConflictSnapshot,
  EnquiryConflictStatus,
  EnquiryStatus,
  Matter,
  Organisation,
  Person,
  PersonOrganisationLink,
  Team,
} from './types';

export const CLOSED_ENQUIRY_STATUSES = new Set<EnquiryStatus>([
  'Converted',
  'Declined',
  'Referred out',
  'No response',
]);

export function isEnquiryOpen(enquiry: Pick<Enquiry, 'status'>): boolean {
  return !CLOSED_ENQUIRY_STATUSES.has(enquiry.status);
}

/** True once an enquiry has been routed (New, Assigned, In contact) — never true on a Draft or closed enquiry. */
export function isEnquiryRouted(enquiry: Pick<Enquiry, 'status'>): boolean {
  return enquiry.status !== 'Draft' && !CLOSED_ENQUIRY_STATUSES.has(enquiry.status);
}

export function enquiryDisplayName(
  e: Pick<Enquiry, 'firstName' | 'lastName' | 'anonymisedAt'>,
  fallback = 'Unknown caller',
): string {
  if (e.anonymisedAt) return 'Anonymised enquirer';
  return [e.firstName?.trim(), e.lastName?.trim()].filter(Boolean).join(' ') || fallback;
}

/**
 * Returns the ordered list of human-readable field names still required before a draft or new enquiry
 * can be routed to a practice area team.
 */
export function getMissingRoutingFields(
  input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    practiceAreaId?: string;
    summary?: string;
    notes?: string;
    customFields?: Record<string, unknown>;
  },
  customFieldDefs: CustomFieldDefinition[] = [],
): string[] {
  const list: string[] = [];
  if (!input.firstName?.trim()) list.push('first name');
  if (!input.lastName?.trim()) list.push('last name');
  if (!input.phone?.trim() && !input.email?.trim()) list.push('phone or email');
  if (!input.practiceAreaId?.trim()) list.push('practice area');
  if (!input.summary?.trim()) list.push('summary');
  if (!input.notes?.trim()) list.push('enquiry notes');

  const activeEnquiryDefs = activeDefinitions(customFieldDefs, 'enquiry');
  const submittedCf = input.customFields ?? {};
  for (const def of activeEnquiryDefs) {
    if (isCustomFieldValueMissing(def, submittedCf[def.id])) {
      list.push(def.label.toLowerCase());
    }
  }
  return list;
}

export function validateEnquiryInput(input: {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  channelId?: string;
  practiceAreaId?: string;
  summary?: string;
  notes?: string;
  urgencyId?: string;
  privacyNoticeGiven?: boolean;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    errors.name = 'First name and last name are required.';
  }
  const email = input.email?.trim() ?? '';
  const phone = input.phone?.trim() ?? '';
  if (!email && !phone) {
    errors.contact = 'At least one of email or phone number is required.';
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (!input.channelId) {
    errors.channelId = 'Channel is required.';
  }
  if (!input.practiceAreaId) {
    errors.practiceAreaId = 'Practice area is required.';
  }
  if (!input.summary?.trim()) {
    errors.summary = 'Summary is required.';
  } else if (input.summary.trim().length > 120) {
    errors.summary = 'Summary must be 120 characters or fewer.';
  }
  if (!input.notes?.trim()) {
    errors.notes = 'High-level notes are required.';
  }
  if (!input.urgencyId) {
    errors.urgencyId = 'Urgency is required.';
  }
  if (!input.privacyNoticeGiven) {
    errors.privacyNoticeGiven = 'Please confirm the privacy notice was read or sent to the caller.';
  }
  return errors;
}

/** Count failed contact attempts (attempts where outcome is not 'Spoke') when no 'Spoke' has occurred. */
export function failedContactAttemptsCount(enquiry: Enquiry): number {
  const hasSpoken = enquiry.contactLog.some((c) => c.outcome === 'Spoke');
  if (hasSpoken) return 0;
  return enquiry.contactLog.filter((c) => c.outcome !== 'Spoke').length;
}

/** Whether to suggest closing the enquiry as 'No response'. */
export function shouldSuggestNoResponse(
  enquiry: Enquiry,
  threshold = 3,
): boolean {
  if (!isEnquiryOpen(enquiry)) return false;
  return failedContactAttemptsCount(enquiry) >= threshold;
}

export type ConflictSeverity = 'high' | 'medium' | 'low';

export interface ConflictHit {
  recordId: string;
  recordType: 'person' | 'organisation' | 'matter';
  name: string;
  recordLabel: string;
  queryTerm: string;
  href: string;
  reason: string;
  reasons: string[];
  matchedFields: string[];
  severity: ConflictSeverity;
  strength: number;
  blocking: boolean;
}

/**
 * Check whether any of the six watched fields on the New Enquiry screen meet their trigger threshold:
 * - Names / organisation / other parties: at least one token of 3+ characters
 * - Email: syntactically valid email address
 * - Phone: 9+ digits after normalisation
 * - Postcode: complete, valid UK postcode format
 */
export function hasQuickConflictCheckInputs(input: {
  firstName?: string;
  lastName?: string;
  callingOnBehalfOf?: string;
  otherPartiesNamed?: string;
  email?: string;
  phone?: string;
  postcode?: string;
}): boolean {
  const callerCombined = [input.firstName, input.lastName].filter(Boolean).join(' ');
  if (hasMinThreeCharToken(callerCombined)) return true;
  if (hasMinThreeCharToken(input.callingOnBehalfOf)) return true;
  const otherEntries = (input.otherPartiesNamed ?? '')
    .split(/[,;/\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (otherEntries.some((entry) => hasMinThreeCharToken(entry))) return true;
  if (isValidEmailFormat(input.email)) return true;
  if (isValidPhoneForCheck(input.phone)) return true;
  if (isValidUkPostcode(input.postcode)) return true;
  return false;
}

/**
 * Compare two names (person or organisation) after full normalisation.
 * Requires at least one token >= 3 chars. A single-token query against a multi-token person name
 * (e.g. surname alone vs full name) does NOT match as a full name match.
 */
export function namesLikelyMatch(
  query: string | null | undefined,
  target: string | null | undefined,
  mode: 'person' | 'organisation' = 'organisation',
): boolean {
  if (!hasMinThreeCharToken(query) || !hasMinThreeCharToken(target)) return false;
  const qComp = normaliseComparableName(query);
  const tComp = normaliseComparableName(target);
  if (!qComp || !tComp) return false;
  if (qComp === tComp) return true;

  if (mode === 'organisation') {
    const qOrg = normaliseOrgName(query);
    const tOrg = normaliseOrgName(target);
    if (qOrg && tOrg && qOrg.length >= 3 && qOrg === tOrg) return true;
    const qTokens = qComp.split(' ').filter(Boolean);
    const tTokens = tComp.split(' ').filter(Boolean);
    // Require at least 2 tokens (e.g. "castell homes") to match prefix/subset of an organisation
    if (qTokens.length >= 2 && qTokens.every((qt) => tTokens.includes(qt))) return true;
  }
  return false;
}

function isOppositePartyOrg(org: Organisation, values: ChoiceValue[]): boolean {
  const labels = [
    org.organisationTypeId ? resolveLabel(values, org.organisationTypeId) : '',
    ...org.relationshipTypeIds.map((id) => resolveLabel(values, id)),
    // Support tests/fixtures that pass a plain string on organisationType or organisationTypeId
    (org as unknown as { organisationType?: string }).organisationType ?? '',
    org.organisationTypeId ?? '',
    ...org.relationshipTypeIds,
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  return labels.some(
    (l) =>
      l.includes('opposite party') ||
      l.includes('opposing') ||
      l.includes('counterparty') ||
      l.includes('adverse'),
  );
}

function isClientOrg(org: Organisation, matters: Matter[], values: ChoiceValue[]): boolean {
  const labels = [
    ...org.relationshipTypeIds.map((id) => resolveLabel(values, id)),
    ...org.relationshipTypeIds,
    (org as unknown as { organisationType?: string }).organisationType ?? '',
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (
    labels.some(
      (l) =>
        (l.includes('client') && !l.includes('opposing')) ||
        l === 'organisation_relationship_type.client' ||
        l === 'organisation_relationship_type.former_client',
    )
  ) {
    return true;
  }
  return matters.some(
    (m) => m.clientId === org.id || (m.additionalClientIds ?? []).includes(org.id),
  );
}

function isOppositePartyPerson(p: Person, values: ChoiceValue[]): boolean {
  const extraContactTypes =
    (p as unknown as { contactTypes?: string[] }).contactTypes ?? [];
  const labels = [
    ...p.relationshipRoleIds.map((id) => resolveLabel(values, id)),
    ...p.relationshipRoleIds,
    ...extraContactTypes,
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  return labels.some(
    (l) =>
      l.includes('opposite party') ||
      l.includes('opposing') ||
      l.includes('counterparty') ||
      l.includes('adverse'),
  );
}

function isClientPerson(p: Person, matters: Matter[], values: ChoiceValue[]): boolean {
  const extraContactTypes =
    (p as unknown as { contactTypes?: string[] }).contactTypes ?? [];
  const labels = [
    ...p.relationshipRoleIds.map((id) => resolveLabel(values, id)),
    ...p.relationshipRoleIds,
    ...extraContactTypes,
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  if (labels.some((l) => l.includes('client') && !l.includes('opposing'))) {
    return true;
  }
  return matters.some(
    (m) => m.clientId === p.id || (m.additionalClientIds ?? []).includes(p.id),
  );
}

const SEVERITY_ORDER: Record<ConflictSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function upsertConflictHit(
  map: Map<string, ConflictHit>,
  hit: Omit<ConflictHit, 'reasons' | 'matchedFields'> & { matchedField: string },
) {
  const key = `${hit.recordType}:${hit.recordId}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      recordId: hit.recordId,
      recordType: hit.recordType,
      name: hit.name,
      recordLabel: hit.recordLabel,
      queryTerm: hit.queryTerm,
      href: hit.href,
      reason: hit.reason,
      reasons: [hit.reason],
      matchedFields: [hit.matchedField],
      severity: hit.severity,
      strength: hit.strength,
      blocking: hit.blocking,
    });
    return;
  }
  if (!existing.reasons.includes(hit.reason)) {
    existing.reasons.push(hit.reason);
  }
  if (!existing.matchedFields.includes(hit.matchedField)) {
    existing.matchedFields.push(hit.matchedField);
  }
  if (SEVERITY_ORDER[hit.severity] > SEVERITY_ORDER[existing.severity]) {
    existing.severity = hit.severity;
  }
  if (hit.strength > existing.strength) {
    existing.strength = hit.strength;
  }
  if (hit.blocking) {
    existing.blocking = true;
  }
  existing.reason = existing.reasons.join(' · ');
}

/**
 * Detect preliminary conflicts across caller name, callingOnBehalfOf, and each comma-separated
 * entry in otherPartiesNamed. Collects ALL matching conflicts, deduplicated by record ID.
 */
export function detectPreliminaryConflicts(
  input: {
    firstName?: string;
    lastName?: string;
    callingOnBehalfOf?: string;
    otherPartiesNamed?: string;
    email?: string;
    phone?: string;
    /** Caller's address (first line + postcode). Same address as an opposite party is flagged. */
    address?: AddressLike | null;
    linkedPersonId?: string | null;
    linkedOrganisationId?: string | null;
  },
  people: Person[],
  organisations: Organisation[],
  matters: Matter[] = [],
  values: ChoiceValue[] = [],
  enquiries: Enquiry[] = [],
  excludeEnquiryId: string | null | undefined = null,
  links: PersonOrganisationLink[] = [],
  canViewMatter: ((matter: Matter) => boolean) | undefined = undefined,
  tenantId: string,
): ConflictHit[] {
  const res = runEnquiryConflictSearch(
    input,
    people,
    organisations,
    matters,
    values,
    enquiries,
    excludeEnquiryId,
    links,
    canViewMatter,
    tenantId,
  );
  return res.allConflicts;
}

/** Strongest loose match in a list: a misspelling beats a sound-alike. */
function firstLoose(kinds: (LooseNameMatch | null)[]): LooseNameMatch | null {
  if (kinds.includes('similar spelling')) return 'similar spelling';
  if (kinds.includes('sounds like')) return 'sounds like';
  return null;
}

/** Wording for a loose match in a reason sentence. */
function looseVerb(loose: LooseNameMatch | null): string {
  return loose === 'sounds like' ? 'sounds like' : 'is a similar spelling to';
}

/** Bare domain from a website URL ("https://www.castellhomes.co.uk/about" -> "castellhomes.co.uk"). */
function websiteDomain(website: string | null | undefined): string {
  const cleaned = (website ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0] ?? '';
  return cleaned.includes('.') ? cleaned : '';
}

/**
 * Check whether the named other parties, caller (name, email, phone), or organisation on behalf of
 * conflict with existing clients, opposite parties, or matter parties. Similar spellings are raised
 * as medium severity "check if this is the same" results.
 */
export function runEnquiryConflictSearch(
  input: {
    firstName?: string;
    lastName?: string;
    callingOnBehalfOf?: string;
    otherPartiesNamed?: string;
    email?: string;
    phone?: string;
    /** Caller's address (first line + postcode). Same address as an opposite party is flagged. */
    address?: AddressLike | null;
    linkedPersonId?: string | null;
    linkedOrganisationId?: string | null;
  },
  people: Person[],
  organisations: Organisation[],
  matters: Matter[] = [],
  values: ChoiceValue[] = [],
  enquiries: Enquiry[] = [],
  excludeEnquiryId: string | null | undefined = null,
  links: PersonOrganisationLink[] = [],
  canViewMatter: ((matter: Matter) => boolean) | undefined = undefined,
  tenantId: string,
): {
  otherPartyClientMatches: ConflictHit[];
  clientAgainstPartyMatches: ConflictHit[];
  allConflicts: ConflictHit[];
  hasBlockingConflict: boolean;
} {
  const otherPartyMap = new Map<string, ConflictHit>();
  const clientAgainstPartyMap = new Map<string, ConflictHit>();
  const combinedMap = new Map<string, ConflictHit>();

  const combinedPeople = mergePeopleWithEnquiries(
    people,
    enquiries,
    values,
    excludeEnquiryId,
  );

  // 1. Parse each comma-separated entry in otherPartiesNamed (only entries meeting 3+ char token threshold)
  const rawOther = (input.otherPartiesNamed ?? '')
    .split(/[,;/\n]+/)
    .map((s) => s.trim())
    .filter((s) => hasMinThreeCharToken(s));

  for (const otherName of rawOther) {
    // 1a. Check existing Organisations against otherName
    for (const org of organisations) {
      if (org.mergedIntoId) continue;
      const orgNames = [org.legalName, ...org.otherNames.map((n) => n.name)];
      const exact = orgNames.some((n) => namesLikelyMatch(otherName, n, 'organisation'));
      const loose = exact ? null : firstLoose(orgNames.map((n) => organisationNameLooseMatch(otherName, n)));
      const fuzzy = Boolean(loose);
      if (!exact && !fuzzy) continue;

      const isClient = isClientOrg(org, matters, values);
      const isOpposite = isOppositePartyOrg(org, values);
      const isHigh = isClient || isOpposite;
      // Similar spellings are only worth raising when they point at a client or opposite party
      if (fuzzy && !isHigh) continue;
      const kind = isClient ? 'existing client' : isOpposite ? 'opposite party' : 'organisation';
      const reason = fuzzy
        ? `Other party "${otherName}" ${looseVerb(loose)} ${kind} ${org.legalName} (${org.id}). Check if this is the same organisation`
        : `Other party "${otherName}" matches ${kind} ${org.legalName} (${org.id})`;
      const severity: ConflictSeverity = fuzzy ? 'medium' : isHigh ? 'high' : 'medium';

      const hitData = {
        recordId: org.id,
        recordType: 'organisation' as const,
        name: org.legalName,
        recordLabel: `${org.legalName} (${org.id})`,
        queryTerm: otherName,
        href: `/organisations/${org.id}`,
        reason,
        matchedField: fuzzy ? `other parties (${loose})` : 'other parties',
        severity,
        strength: fuzzy ? 2 : isHigh ? 5 : 3,
        blocking: !fuzzy && isHigh,
      };
      upsertConflictHit(otherPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }

    // 1b. Check existing People against otherName
    for (const p of combinedPeople) {
      if (p.mergedIntoId || p.isEmployee) continue;
      const pName = personDisplayName(p);
      const pCandidateNames = [
        pName,
        `${p.firstName} ${p.surname}`,
        ...p.otherNames.map((n) => n.name),
      ].filter(Boolean);
      const exact = pCandidateNames.some((n) => namesLikelyMatch(otherName, n, 'person'));
      const loose = exact
        ? null
        : firstLoose(pCandidateNames.map((n) => personNameLooseMatch(otherName, n)));
      const fuzzy = Boolean(loose);
      if (!exact && !fuzzy) continue;

      const isClient = isClientPerson(p, matters, values);
      const isOpposite = isOppositePartyPerson(p, values);
      const isHigh = isClient || isOpposite;
      if (fuzzy && !isHigh) continue;
      const kind = isClient ? 'existing client' : isOpposite ? 'opposite party' : 'person';
      const reason = fuzzy
        ? `Other party "${otherName}" ${looseVerb(loose)} ${kind} ${pName} (${p.id}). Check if this is the same person`
        : `Other party "${otherName}" matches ${kind} ${pName} (${p.id})`;
      const severity: ConflictSeverity = fuzzy ? 'medium' : isHigh ? 'high' : 'medium';

      const hitData = {
        recordId: p.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${p.id})`,
        queryTerm: otherName,
        href: `/people/${p.id}`,
        reason,
        matchedField: fuzzy ? `other parties (${loose})` : 'other parties',
        severity,
        strength: fuzzy ? 2 : isHigh ? 5 : 3,
        blocking: !fuzzy && isHigh,
      };
      upsertConflictHit(otherPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
  }

  // 2. Check Caller Name & Calling On Behalf Of against known Opposite Party People & Organisations
  const callerFullRaw = [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(' ');
  const hasBothCallerNames = Boolean(
    hasMinThreeCharToken(input.firstName) && hasMinThreeCharToken(input.lastName),
  );
  const singleFieldFullCaller =
    !hasBothCallerNames &&
    hasMinThreeCharToken(callerFullRaw) &&
    normaliseComparableName(callerFullRaw).includes(' ');
  const canMatchCallerFullName = hasBothCallerNames || singleFieldFullCaller;

  if (canMatchCallerFullName) {
    for (const p of combinedPeople) {
      if (p.mergedIntoId || p.isEmployee) continue;
      if (!isOppositePartyPerson(p, values)) continue;
      const pName = personDisplayName(p);
      const target = `${p.firstName} ${p.surname}`;
      const exact = namesLikelyMatch(callerFullRaw, target, 'person');
      const loose = exact ? null : personNameLooseMatch(callerFullRaw, target);
      const fuzzy = Boolean(loose);
      if (!exact && !fuzzy) continue;
      const hitData = {
        recordId: p.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${p.id})`,
        queryTerm: callerFullRaw,
        href: `/people/${p.id}`,
        reason: fuzzy
          ? `Caller "${callerFullRaw}" ${looseVerb(loose)} known opposite party ${pName} (${p.id}). Check if this is the same person`
          : `Caller "${callerFullRaw}" matches known opposite party ${pName} (${p.id})`,
        matchedField: fuzzy ? `caller name (${loose})` : 'caller name',
        severity: fuzzy ? ('medium' as const) : ('high' as const),
        strength: fuzzy ? 2 : 5,
        blocking: !fuzzy,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
  }

  const behalfRaw = (input.callingOnBehalfOf ?? '').trim();
  if (hasMinThreeCharToken(behalfRaw)) {
    for (const org of organisations) {
      if (org.mergedIntoId) continue;
      if (!isOppositePartyOrg(org, values)) continue;
      const orgNames = [org.legalName, ...org.otherNames.map((n) => n.name)];
      const exact = orgNames.some((n) => namesLikelyMatch(behalfRaw, n, 'organisation'));
      const loose = exact ? null : firstLoose(orgNames.map((n) => organisationNameLooseMatch(behalfRaw, n)));
      const fuzzy = Boolean(loose);
      if (!exact && !fuzzy) continue;
      const hitData = {
        recordId: org.id,
        recordType: 'organisation' as const,
        name: org.legalName,
        recordLabel: `${org.legalName} (${org.id})`,
        queryTerm: behalfRaw,
        href: `/organisations/${org.id}`,
        reason: fuzzy
          ? `Organisation "${behalfRaw}" ${looseVerb(loose)} opposite party ${org.legalName} (${org.id}). Check if this is the same organisation`
          : `Organisation "${behalfRaw}" matches opposite party ${org.legalName} (${org.id})`,
        matchedField: fuzzy ? `organisation (${loose})` : 'organisation',
        severity: fuzzy ? ('medium' as const) : ('high' as const),
        strength: fuzzy ? 2 : 5,
        blocking: !fuzzy,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }

    for (const p of combinedPeople) {
      if (p.mergedIntoId || p.isEmployee) continue;
      if (!isOppositePartyPerson(p, values)) continue;
      const pName = personDisplayName(p);
      const target = `${p.firstName} ${p.surname}`;
      const exact = namesLikelyMatch(behalfRaw, target, 'person');
      const loose = exact ? null : personNameLooseMatch(behalfRaw, target);
      const fuzzy = Boolean(loose);
      if (!exact && !fuzzy) continue;
      const hitData = {
        recordId: p.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${p.id})`,
        queryTerm: behalfRaw,
        href: `/people/${p.id}`,
        reason: fuzzy
          ? `"${behalfRaw}" ${looseVerb(loose)} opposite party ${pName} (${p.id}). Check if this is the same person`
          : `"${behalfRaw}" matches opposite party ${pName} (${p.id})`,
        matchedField: fuzzy ? `organisation (${loose})` : 'organisation',
        severity: fuzzy ? ('medium' as const) : ('high' as const),
        strength: fuzzy ? 2 : 5,
        blocking: !fuzzy,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
  }

  // 2b. Check the caller's email and phone against opposite party People & Organisations.
  // An exact email or phone is as strong as a name match, so it's high severity.
  // A shared (non-free) email domain is weaker, so it's medium.
  const callerEmail = isValidEmailFormat(input.email) ? normaliseEmail(input.email) : '';
  const callerDomain = callerEmail ? extractEmailDomain(callerEmail) : '';
  const callerDomainUsable = Boolean(callerDomain && !FREE_EMAIL_DOMAINS.has(callerDomain));
  const callerPhone = isValidPhoneForCheck(input.phone) ? normalisePhoneLast9(input.phone) : '';

  if (callerEmail || callerPhone) {
    for (const p of combinedPeople) {
      if (p.mergedIntoId || p.isEmployee) continue;
      if (!isOppositePartyPerson(p, values)) continue;
      const pName = personDisplayName(p);
      const emailHit =
        Boolean(callerEmail) && p.emails.some((e) => normaliseEmail(e.address) === callerEmail);
      const phoneHit =
        Boolean(callerPhone) && p.phones.some((ph) => normalisePhoneLast9(ph.number) === callerPhone);
      const fields: [boolean, string][] = [
        [emailHit, 'email'],
        [phoneHit, 'phone'],
      ];
      for (const [hit, field] of fields) {
        if (!hit) continue;
        const hitData = {
          recordId: p.id,
          recordType: 'person' as const,
          name: pName,
          recordLabel: `${pName} (${p.id})`,
          queryTerm: field === 'email' ? callerEmail : String(input.phone ?? ''),
          href: `/people/${p.id}`,
          reason: `Caller's ${field} matches known opposite party ${pName} (${p.id})`,
          matchedField: field,
          severity: 'high' as const,
          strength: 5,
          blocking: true,
        };
        upsertConflictHit(clientAgainstPartyMap, hitData);
        upsertConflictHit(combinedMap, hitData);
      }
    }

    for (const org of organisations) {
      if (org.mergedIntoId) continue;
      if (!isOppositePartyOrg(org, values)) continue;
      const emailHit = Boolean(callerEmail) && normaliseEmail(org.generalEmail) === callerEmail;
      const phoneHit =
        Boolean(callerPhone) && Boolean(org.mainPhone) && normalisePhoneLast9(org.mainPhone) === callerPhone;
      const orgDomains = [extractEmailDomain(org.generalEmail), websiteDomain(org.website)].filter(
        (d) => d && !FREE_EMAIL_DOMAINS.has(d),
      );
      const domainHit = !emailHit && callerDomainUsable && orgDomains.includes(callerDomain);

      const fields: [boolean, string, 'high' | 'medium'][] = [
        [emailHit, 'email', 'high'],
        [phoneHit, 'phone', 'high'],
        [domainHit, 'email domain', 'medium'],
      ];
      for (const [hit, field, severity] of fields) {
        if (!hit) continue;
        const hitData = {
          recordId: org.id,
          recordType: 'organisation' as const,
          name: org.legalName,
          recordLabel: `${org.legalName} (${org.id})`,
          queryTerm: field === 'phone' ? String(input.phone ?? '') : callerEmail,
          href: `/organisations/${org.id}`,
          reason:
            field === 'email domain'
              ? `Caller's email domain (${callerDomain}) belongs to opposite party ${org.legalName} (${org.id})`
              : `Caller's ${field} matches opposite party ${org.legalName} (${org.id})`,
          matchedField: field,
          severity,
          strength: severity === 'high' ? 5 : 2,
          blocking: severity === 'high',
        };
        upsertConflictHit(clientAgainstPartyMap, hitData);
        upsertConflictHit(combinedMap, hitData);
      }
    }
  }

  // 2c. Same address (first line + postcode) as an opposite party person or organisation.
  // Medium severity: households, shared offices and business centres can share an address.
  // A postcode on its own is never raised as a conflict.
  const callerAddress = input.address ?? null;
  if (callerAddress && isValidUkPostcode(callerAddress.postcode)) {
    for (const p of combinedPeople) {
      if (p.mergedIntoId || p.isEmployee) continue;
      if (!isOppositePartyPerson(p, values)) continue;
      if (!p.addresses.some((a) => addressesMatch(callerAddress, a))) continue;
      const pName = personDisplayName(p);
      const hitData = {
        recordId: p.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${p.id})`,
        queryTerm: `${callerAddress.line1 ?? ''} ${callerAddress.postcode ?? ''}`.trim(),
        href: `/people/${p.id}`,
        reason: `Caller's address is the same as known opposite party ${pName} (${p.id})`,
        matchedField: 'address',
        severity: 'medium' as const,
        strength: 3,
        blocking: false,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }

    for (const org of organisations) {
      if (org.mergedIntoId) continue;
      if (!isOppositePartyOrg(org, values)) continue;
      const theirs = [org.registeredAddress, org.correspondenceAddress, org.billingAddress].filter(
        (a): a is NonNullable<typeof a> => Boolean(a),
      );
      if (!theirs.some((a) => addressesMatch(callerAddress, a))) continue;
      const hitData = {
        recordId: org.id,
        recordType: 'organisation' as const,
        name: org.legalName,
        recordLabel: `${org.legalName} (${org.id})`,
        queryTerm: `${callerAddress.line1 ?? ''} ${callerAddress.postcode ?? ''}`.trim(),
        href: `/organisations/${org.id}`,
        reason: `Caller's address is the same as opposite party ${org.legalName} (${org.id})`,
        matchedField: 'address',
        severity: 'medium' as const,
        strength: 3,
        blocking: false,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
  }

  // 3. Check if caller, callingOnBehalfOf, or otherPartiesNamed is an adverse/counterparty or instructing/billing contact on a matter
  const isRestrictedMatter = (m: Matter): boolean =>
    canViewMatter ? !canViewMatter(m) : Boolean(m.isStaffMatter || m.hasEthicalWall);

  const personById = new Map<string, Person>();
  for (const p of combinedPeople) {
    if (!p.mergedIntoId) {
      personById.set(p.id, p);
    }
  }
  const orgById = new Map<string, Organisation>();
  for (const o of organisations) {
    if (!o.mergedIntoId) {
      orgById.set(o.id, o);
    }
  }

  const looseForParty = (partyName: string): LooseNameMatch | null =>
    (canMatchCallerFullName ? personNameLooseMatch(callerFullRaw, partyName) : null) ??
    (hasMinThreeCharToken(behalfRaw) ? organisationNameLooseMatch(behalfRaw, partyName) : null);
  for (const m of matters) {
    const restricted = isRestrictedMatter(m);
    const matterDisplayLabel = restricted
      ? 'Restricted matter'
      : `${m.matterNumber} — ${m.title}`;
    const matterHref = restricted ? '' : `/matters/${m.id}`;
    const matterHitId = restricted ? `restricted-${redactRecordId(tenantId, m.id)}` : m.id;

    for (const party of m.parties) {
      const roleLower = party.role.toLowerCase();
      const isAdverseRole =
        roleLower.includes('opposing') ||
        roleLower.includes('opponent') ||
        roleLower.includes('other side') ||
        roleLower.includes('adverse') ||
        roleLower.includes('counterparty') ||
        roleLower.includes('defendant') ||
        roleLower.includes('claimant') ||
        roleLower.includes('adjoining');
      if (!isAdverseRole) continue;

      const matchesCaller =
        (canMatchCallerFullName && namesLikelyMatch(callerFullRaw, party.name, 'person')) ||
        (hasMinThreeCharToken(behalfRaw) &&
          namesLikelyMatch(behalfRaw, party.name, 'organisation')) ||
        Boolean(input.linkedPersonId && party.linkedRecordId === input.linkedPersonId) ||
        Boolean(input.linkedOrganisationId && party.linkedRecordId === input.linkedOrganisationId);

      if (matchesCaller) {
        const hitData = {
          recordId: matterHitId,
          recordType: 'matter' as const,
          name: matterDisplayLabel,
          recordLabel: matterDisplayLabel,
          queryTerm: behalfRaw || callerFullRaw || (restricted ? 'restricted' : party.name),
          href: matterHref,
          reason: restricted
            ? 'Prospective client matches a party on a restricted matter'
            : `Prospective client matches adverse/other party "${party.name}" (${party.role}) on matter ${m.matterNumber}`,
          matchedField: behalfRaw ? 'organisation' : 'caller name',
          severity: 'high' as const,
          strength: 5,
          blocking: true,
        };
        upsertConflictHit(clientAgainstPartyMap, hitData);
        upsertConflictHit(combinedMap, hitData);
      } else if (looseForParty(party.name)) {
        const loose = looseForParty(party.name);
        const hitData = {
          recordId: matterHitId,
          recordType: 'matter' as const,
          name: matterDisplayLabel,
          recordLabel: matterDisplayLabel,
          queryTerm: behalfRaw || callerFullRaw,
          href: matterHref,
          reason: restricted
            ? `Prospective client ${looseVerb(loose)} a party on a restricted matter. Check if this is the same party`
            : `Prospective client ${looseVerb(loose)} adverse/other party "${party.name}" (${party.role}) on matter ${m.matterNumber}. Check if this is the same party`,
          matchedField: `${behalfRaw ? 'organisation' : 'caller name'} (${loose})`,
          severity: 'medium' as const,
          strength: 2,
          blocking: false,
        };
        upsertConflictHit(clientAgainstPartyMap, hitData);
        upsertConflictHit(combinedMap, hitData);
      }

      for (const otherName of rawOther) {
        if (
          namesLikelyMatch(otherName, party.name, 'organisation') ||
          namesLikelyMatch(otherName, party.name, 'person')
        ) {
          const hitData = {
            recordId: matterHitId,
            recordType: 'matter' as const,
            name: matterDisplayLabel,
            recordLabel: matterDisplayLabel,
            queryTerm: otherName,
            href: matterHref,
            reason: restricted
              ? `Other party "${otherName}" is recorded on a restricted matter`
              : `Other party "${otherName}" is recorded as "${party.name}" (${party.role}) on matter ${m.matterNumber}`,
            matchedField: 'other parties',
            severity: restricted ? ('high' as const) : ('medium' as const),
            strength: restricted ? 5 : 3,
            blocking: restricted,
          };
          upsertConflictHit(otherPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }
    }

    // 3b. Check matter instructingContactId and billingContactId (B7)
    const matterContactSlots: Array<{
      id: string | null | undefined;
      slotLabel: 'instructing contact' | 'billing contact';
    }> = [
      { id: m.instructingContactId, slotLabel: 'instructing contact' },
      { id: m.billingContactId, slotLabel: 'billing contact' },
    ];
    const allMatterClientIds = [m.clientId, ...(m.additionalClientIds ?? [])].filter(Boolean);
    const callerOrgMatchesMatterClient =
      Boolean(input.linkedOrganisationId && allMatterClientIds.includes(input.linkedOrganisationId)) ||
      (hasMinThreeCharToken(behalfRaw) &&
        allMatterClientIds.some((cid) => {
          const cOrg = orgById.get(cid);
          return Boolean(cOrg && namesLikelyMatch(behalfRaw, cOrg.legalName, 'organisation'));
        }));

    for (const slot of matterContactSlots) {
      if (!slot.id) continue;
      const contactPerson = personById.get(slot.id);
      const contactOrg = !contactPerson ? orgById.get(slot.id) : undefined;
      const contactName = contactPerson
        ? personDisplayName(contactPerson)
        : contactOrg
          ? contactOrg.legalName
          : '';
      if (!contactName) continue;

      for (const otherName of rawOther) {
        const exact =
          namesLikelyMatch(otherName, contactName, contactOrg ? 'organisation' : 'person');
        const loose = exact
          ? null
          : contactOrg
            ? organisationNameLooseMatch(otherName, contactName)
            : personNameLooseMatch(otherName, contactName);
        if (!exact && !loose) continue;
        const severity: ConflictSeverity = exact ? 'high' : 'medium';
        const hitData = {
          recordId: restricted ? matterHitId : slot.id,
          recordType: (restricted ? 'matter' : contactOrg ? 'organisation' : 'person') as
            | 'matter'
            | 'organisation'
            | 'person',
          name: restricted ? matterDisplayLabel : contactName,
          recordLabel: restricted
            ? matterDisplayLabel
            : `${contactName} (${slot.id})`,
          queryTerm: otherName,
          href: restricted
            ? ''
            : contactOrg
              ? `/organisations/${slot.id}`
              : `/people/${slot.id}`,
          reason: restricted
            ? `Other party "${otherName}" matches ${slot.slotLabel} on a restricted matter`
            : loose
              ? `Other party "${otherName}" ${looseVerb(loose)} ${slot.slotLabel} ${contactName} on matter ${m.matterNumber}`
              : `Other party "${otherName}" matches ${slot.slotLabel} ${contactName} on matter ${m.matterNumber}`,
          matchedField: slot.slotLabel,
          severity,
          strength: exact ? 5 : 2,
          blocking: exact,
        };
        upsertConflictHit(otherPartyMap, hitData);
        upsertConflictHit(combinedMap, hitData);
      }

      if (!callerOrgMatchesMatterClient) {
        const callerMatchesContact =
          Boolean(input.linkedPersonId && input.linkedPersonId === slot.id) ||
          Boolean(input.linkedOrganisationId && input.linkedOrganisationId === slot.id) ||
          (canMatchCallerFullName &&
            namesLikelyMatch(callerFullRaw, contactName, 'person')) ||
          (hasMinThreeCharToken(behalfRaw) &&
            namesLikelyMatch(behalfRaw, contactName, 'organisation'));
        if (callerMatchesContact) {
          const hitData = {
            recordId: restricted ? matterHitId : slot.id,
            recordType: (restricted ? 'matter' : contactOrg ? 'organisation' : 'person') as
              | 'matter'
              | 'organisation'
              | 'person',
            name: restricted ? matterDisplayLabel : contactName,
            recordLabel: restricted
              ? matterDisplayLabel
              : `${contactName} (${slot.id})`,
            queryTerm: behalfRaw || callerFullRaw || contactName,
            href: restricted
              ? ''
              : contactOrg
                ? `/organisations/${slot.id}`
                : `/people/${slot.id}`,
            reason: restricted
              ? `Prospective client matches ${slot.slotLabel} on a restricted matter`
              : `Prospective client matches ${slot.slotLabel} ${contactName} on matter ${m.matterNumber}`,
            matchedField: slot.slotLabel,
            severity: restricted ? ('high' as const) : ('medium' as const),
            strength: restricted ? 5 : 3,
            blocking: restricted,
          };
          upsertConflictHit(clientAgainstPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }
    }
  }

  // 3c. Check person–organisation links (B7, R259: pre-indexed maps, name match tested first, status computed lazily only after a hit)
  const isAdverseMatterRole = (role: string) => {
    const r = role.toLowerCase();
    return (
      r.includes('oppos') ||
      r.includes('opponent') ||
      r.includes('counterparty') ||
      r.includes('other side') ||
      r.includes('adverse') ||
      r.includes('defendant') ||
      r.includes('claimant') ||
      r.includes('adjoining')
    );
  };
  const orgLinkStatusCache = new Map<string, { isClient: boolean; isOpposite: boolean }>();
  const getOrgLinkStatus = (org: Organisation, oName: string) => {
    let cached = orgLinkStatusCache.get(org.id);
    if (!cached) {
      const onMatterAdverse = matters.some((m) =>
        m.parties.some(
          (mp) =>
            isAdverseMatterRole(mp.role) &&
            ((mp.linkedRecordId && mp.linkedRecordId === org.id) ||
              namesLikelyMatch(mp.name, oName, 'organisation')),
        ),
      );
      cached = {
        isClient: isClientOrg(org, matters, values),
        isOpposite: isOppositePartyOrg(org, values) || onMatterAdverse,
      };
      orgLinkStatusCache.set(org.id, cached);
    }
    return cached;
  };
  const personLinkStatusCache = new Map<string, { isClient: boolean; isOpposite: boolean }>();
  const getPersonLinkStatus = (person: Person, pName: string) => {
    let cached = personLinkStatusCache.get(person.id);
    if (!cached) {
      const onMatterAdverse = matters.some((m) =>
        m.parties.some(
          (mp) =>
            isAdverseMatterRole(mp.role) &&
            ((mp.linkedRecordId && mp.linkedRecordId === person.id) ||
              namesLikelyMatch(mp.name, pName, 'person')),
        ),
      );
      cached = {
        isClient: isClientPerson(person, matters, values),
        isOpposite: isOppositePartyPerson(person, values) || onMatterAdverse,
      };
      personLinkStatusCache.set(person.id, cached);
    }
    return cached;
  };

  for (const link of links) {
    if (link.isCurrent === false) continue;
    const linkPerson = personById.get(link.personId);
    if (!linkPerson || linkPerson.isEmployee) continue;
    const linkOrg = orgById.get(link.organisationId);
    if (!linkOrg) continue;

    const pName = personDisplayName(linkPerson);
    const oName = linkOrg.legalName;

    const matchedOtherForPerson = rawOther.filter((otherName) =>
      namesLikelyMatch(otherName, pName, 'person'),
    );
    const matchedOtherForOrg = rawOther.filter((otherName) =>
      namesLikelyMatch(otherName, oName, 'organisation'),
    );
    const callerMatchesLinkPerson =
      Boolean(input.linkedPersonId && input.linkedPersonId === linkPerson.id) ||
      (canMatchCallerFullName && namesLikelyMatch(callerFullRaw, pName, 'person'));
    const callerMatchesLinkOrg =
      Boolean(input.linkedOrganisationId && input.linkedOrganisationId === linkOrg.id) ||
      (hasMinThreeCharToken(behalfRaw) && namesLikelyMatch(behalfRaw, oName, 'organisation'));

    const needsOrgStatus =
      matchedOtherForPerson.length > 0 || (callerMatchesLinkPerson && !callerMatchesLinkOrg);
    const needsPersonStatus =
      matchedOtherForOrg.length > 0 || (callerMatchesLinkOrg && !callerMatchesLinkPerson);
    if (!needsOrgStatus && !needsPersonStatus) continue;

    for (const otherName of matchedOtherForPerson) {
      const { isClient: orgIsClient, isOpposite: orgIsOpposite } = getOrgLinkStatus(linkOrg, oName);
      const isHigh = orgIsClient || orgIsOpposite;
      const hitData = {
        recordId: linkOrg.id,
        recordType: 'organisation' as const,
        name: oName,
        recordLabel: `${oName} (${linkOrg.id})`,
        queryTerm: otherName,
        href: `/organisations/${linkOrg.id}`,
        reason: `Other party "${otherName}" is linked to ${orgIsClient ? 'existing client' : orgIsOpposite ? 'opposite party' : 'organisation'} ${oName} (${linkOrg.id})`,
        matchedField: 'person–organisation link',
        severity: isHigh ? ('high' as const) : ('medium' as const),
        strength: isHigh ? 5 : 3,
        blocking: isHigh,
      };
      upsertConflictHit(otherPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
    for (const otherName of matchedOtherForOrg) {
      const { isClient: personIsClient, isOpposite: personIsOpposite } = getPersonLinkStatus(
        linkPerson,
        pName,
      );
      const isHigh = personIsClient || personIsOpposite;
      const hitData = {
        recordId: linkPerson.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${linkPerson.id})`,
        queryTerm: otherName,
        href: `/people/${linkPerson.id}`,
        reason: `Other party "${otherName}" is linked to ${personIsClient ? 'existing client' : personIsOpposite ? 'opposite party' : 'person'} ${pName} (${linkPerson.id})`,
        matchedField: 'person–organisation link',
        severity: isHigh ? ('high' as const) : ('medium' as const),
        strength: isHigh ? 5 : 3,
        blocking: isHigh,
      };
      upsertConflictHit(otherPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }

    if (callerMatchesLinkPerson && !callerMatchesLinkOrg) {
      const { isClient: orgIsClient, isOpposite: orgIsOpposite } = getOrgLinkStatus(linkOrg, oName);
      const isHigh = orgIsOpposite;
      const hitData = {
        recordId: linkOrg.id,
        recordType: 'organisation' as const,
        name: oName,
        recordLabel: `${oName} (${linkOrg.id})`,
        queryTerm: callerFullRaw || pName,
        href: `/organisations/${linkOrg.id}`,
        reason: `Caller "${pName}" is linked to ${orgIsOpposite ? 'opposite party' : orgIsClient ? 'existing client' : 'organisation'} ${oName} (${linkOrg.id})`,
        matchedField: 'person–organisation link',
        severity: isHigh ? ('high' as const) : ('medium' as const),
        strength: isHigh ? 5 : 3,
        blocking: isHigh,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }

    if (callerMatchesLinkOrg && !callerMatchesLinkPerson) {
      const { isClient: personIsClient, isOpposite: personIsOpposite } = getPersonLinkStatus(
        linkPerson,
        pName,
      );
      const isHigh = personIsOpposite;
      const hitData = {
        recordId: linkPerson.id,
        recordType: 'person' as const,
        name: pName,
        recordLabel: `${pName} (${linkPerson.id})`,
        queryTerm: behalfRaw || oName,
        href: `/people/${linkPerson.id}`,
        reason: `Organisation "${oName}" is linked to ${personIsOpposite ? 'opposite party' : personIsClient ? 'existing client' : 'person'} ${pName} (${linkPerson.id})`,
        matchedField: 'person–organisation link',
        severity: isHigh ? ('high' as const) : ('medium' as const),
        strength: isHigh ? 5 : 3,
        blocking: isHigh,
      };
      upsertConflictHit(clientAgainstPartyMap, hitData);
      upsertConflictHit(combinedMap, hitData);
    }
  }

  // 4. Check Enquiries (caller details, callingOnBehalfOf, and otherPartiesNamed saved in enquiries)
  for (const enq of enquiries) {
    if (enq.id === excludeEnquiryId || enq.anonymisedAt) continue;
    const enqCallerName = enquiryDisplayName(enq, '').trim();
    const enqBehalf = (enq.callingOnBehalfOf ?? '').trim();
    const enqOtherEntries = (enq.otherPartiesNamed ?? '')
      .split(/[,;/\n]+/)
      .map((s) => s.trim())
      .filter((s) => hasMinThreeCharToken(s));
    const enqIsOpen = isEnquiryOpen(enq);

    // 4a. Other parties entered on this form vs Enquiry Caller / CallingOnBehalfOf / Enquiry Other Parties
    for (const otherName of rawOther) {
      if (enqCallerName && hasMinThreeCharToken(enqCallerName)) {
        const exact = namesLikelyMatch(otherName, enqCallerName, 'person');
        const loose = exact ? null : personNameLooseMatch(otherName, enqCallerName);
        if (exact || loose) {
          const recId = enq.linkedPersonId || enq.id;
          const href = enq.linkedPersonId ? `/people/${enq.linkedPersonId}` : `/enquiries/${enq.id}`;
          const severity: ConflictSeverity = exact && enqIsOpen ? 'high' : 'medium';
          const hitData = {
            recordId: recId,
            recordType: 'person' as const,
            name: enqCallerName,
            recordLabel: `${enqCallerName} (${enq.reference})`,
            queryTerm: otherName,
            href,
            reason: loose
              ? `Other party "${otherName}" ${looseVerb(loose)} enquiry caller ${enqCallerName} on ${enq.reference} (${enq.status}). Check if this is the same person`
              : `Other party "${otherName}" matches enquiry caller ${enqCallerName} on ${enq.reference} (${enq.status})`,
            matchedField: loose ? `other parties (${loose})` : 'other parties',
            severity,
            strength: exact && enqIsOpen ? 5 : 3,
            blocking: exact && enqIsOpen,
          };
          upsertConflictHit(otherPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }

      if (enqBehalf && hasMinThreeCharToken(enqBehalf)) {
        const exact = namesLikelyMatch(otherName, enqBehalf, 'organisation');
        const loose = exact ? null : organisationNameLooseMatch(otherName, enqBehalf);
        if (exact || loose) {
          const recId = enq.linkedOrganisationId || enq.id;
          const href = enq.linkedOrganisationId
            ? `/organisations/${enq.linkedOrganisationId}`
            : `/enquiries/${enq.id}`;
          const severity: ConflictSeverity = exact && enqIsOpen ? 'high' : 'medium';
          const hitData = {
            recordId: recId,
            recordType: 'organisation' as const,
            name: enqBehalf,
            recordLabel: `${enqBehalf} (${enq.reference})`,
            queryTerm: otherName,
            href,
            reason: loose
              ? `Other party "${otherName}" ${looseVerb(loose)} enquiry organisation ${enqBehalf} on ${enq.reference} (${enq.status})`
              : `Other party "${otherName}" matches enquiry organisation ${enqBehalf} on ${enq.reference} (${enq.status})`,
            matchedField: loose ? `other parties (${loose})` : 'other parties',
            severity,
            strength: exact && enqIsOpen ? 5 : 3,
            blocking: exact && enqIsOpen,
          };
          upsertConflictHit(otherPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }

      for (const enqOther of enqOtherEntries) {
        if (
          namesLikelyMatch(otherName, enqOther, 'person') ||
          namesLikelyMatch(otherName, enqOther, 'organisation')
        ) {
          const hitData = {
            recordId: enq.id,
            recordType: 'person' as const,
            name: `${enqOther} (${enq.reference})`,
            recordLabel: `${enqOther} (${enq.reference})`,
            queryTerm: otherName,
            href: `/enquiries/${enq.id}`,
            reason: `Other party "${otherName}" is also named as an other party on enquiry ${enq.reference} (caller: ${enqCallerName || 'Unknown'})`,
            matchedField: 'other parties',
            severity: 'medium' as const,
            strength: 3,
            blocking: false,
          };
          upsertConflictHit(otherPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }
    }

    // 4b. Caller / Organisation on this form vs Other Parties named on existing enquiries
    for (const enqOther of enqOtherEntries) {
      if (canMatchCallerFullName) {
        const exact = namesLikelyMatch(callerFullRaw, enqOther, 'person');
        const loose = exact ? null : personNameLooseMatch(callerFullRaw, enqOther);
        if (exact || loose) {
          const severity: ConflictSeverity = exact && enqIsOpen ? 'high' : 'medium';
          const hitData = {
            recordId: enq.id,
            recordType: 'person' as const,
            name: `${enqOther} (${enq.reference})`,
            recordLabel: `${enqOther} (${enq.reference})`,
            queryTerm: callerFullRaw,
            href: `/enquiries/${enq.id}`,
            reason: loose
              ? `Caller "${callerFullRaw}" ${looseVerb(loose)} other party "${enqOther}" named on enquiry ${enq.reference} (caller: ${enqCallerName || 'Unknown'})`
              : `Caller "${callerFullRaw}" matches other party "${enqOther}" named on enquiry ${enq.reference} (caller: ${enqCallerName || 'Unknown'})`,
            matchedField: loose ? `caller name (${loose})` : 'caller name',
            severity,
            strength: exact && enqIsOpen ? 5 : 2,
            blocking: exact && enqIsOpen,
          };
          upsertConflictHit(clientAgainstPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }

      if (hasMinThreeCharToken(behalfRaw)) {
        const exact =
          namesLikelyMatch(behalfRaw, enqOther, 'organisation') ||
          namesLikelyMatch(behalfRaw, enqOther, 'person');
        const loose = exact ? null : organisationNameLooseMatch(behalfRaw, enqOther);
        if (exact || loose) {
          const severity: ConflictSeverity = exact && enqIsOpen ? 'high' : 'medium';
          const hitData = {
            recordId: enq.id,
            recordType: 'organisation' as const,
            name: `${enqOther} (${enq.reference})`,
            recordLabel: `${enqOther} (${enq.reference})`,
            queryTerm: behalfRaw,
            href: `/enquiries/${enq.id}`,
            reason: loose
              ? `"${behalfRaw}" ${looseVerb(loose)} other party "${enqOther}" named on enquiry ${enq.reference} (caller: ${enqCallerName || 'Unknown'})`
              : `"${behalfRaw}" matches other party "${enqOther}" named on enquiry ${enq.reference} (caller: ${enqCallerName || 'Unknown'})`,
            matchedField: loose ? `organisation (${loose})` : 'organisation',
            severity,
            strength: exact && enqIsOpen ? 5 : 2,
            blocking: exact && enqIsOpen,
          };
          upsertConflictHit(clientAgainstPartyMap, hitData);
          upsertConflictHit(combinedMap, hitData);
        }
      }
    }
  }

  const sortHits = (arr: ConflictHit[]) =>
    [...arr].sort((a, b) => {
      const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.strength - a.strength;
    });

  const otherPartyClientMatches = sortHits(Array.from(otherPartyMap.values()));
  const clientAgainstPartyMatches = sortHits(Array.from(clientAgainstPartyMap.values()));
  const allConflicts = sortHits(Array.from(combinedMap.values()));

  const hasBlockingConflict = allConflicts.some((h) => h.severity === 'high' || h.blocking);

  return {
    otherPartyClientMatches,
    clientAgainstPartyMatches,
    allConflicts,
    hasBlockingConflict,
  };
}

function mergeDuplicateMatches<T extends { id: string }>(
  lists: DuplicateMatch<T>[][],
): DuplicateMatch<T>[] {
  const byId = new Map<string, DuplicateMatch<T>>();
  for (const list of lists) {
    for (const item of list) {
      const existing = byId.get(item.record.id);
      if (!existing) {
        byId.set(item.record.id, {
          record: item.record,
          reasons: [...item.reasons],
          strength: item.strength,
        });
      } else {
        for (const r of item.reasons) {
          if (!existing.reasons.includes(r)) {
            existing.reasons.push(r);
          }
        }
        const maxWeight = Math.max(...existing.reasons.map((r) => REASON_STRENGTH[r] ?? 1));
        existing.strength = maxWeight >= 4 ? 'high' : maxWeight >= 2 ? 'medium' : 'low';
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const scoreA = a.reasons.reduce((s, r) => s + (REASON_STRENGTH[r] ?? 1), 0);
    const scoreB = b.reasons.reduce((s, r) => s + (REASON_STRENGTH[r] ?? 1), 0);
    return scoreB - scoreA;
  });
}

export function formatEntityMatchReasons(reasons: DuplicateReason[]): string {
  return formatDuplicateReasons(reasons);
}

/** Find matching People and Organisations for an enquiry or capture form state. */
export function findEnquiryEntityMatches(
  input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    callingOnBehalfOf?: string;
    postcode?: string;
    /** First and second address lines, used with the postcode for "same address" matches. */
    addressLine1?: string;
    addressLine2?: string;
    otherPartiesNamed?: string;
  },
  people: Person[],
  organisations: Organisation[],
  enquiries: Enquiry[] = [],
  excludeEnquiryId?: string | null,
) {
  const combinedPeople = mergePeopleWithEnquiries(
    people,
    enquiries,
    [],
    excludeEnquiryId,
  );
  const nonEmployeePeople = combinedPeople.filter((p) => !p.isEmployee);
  const emails = input.email ? [input.email] : [];
  const phones = input.phone ? [input.phone] : [];
  const postcodes = input.postcode ? [input.postcode] : [];
  const addresses: AddressLike[] = input.addressLine1?.trim()
    ? [{ line1: input.addressLine1, line2: input.addressLine2, postcode: input.postcode }]
    : [];

  const primaryPersonMatches = findPersonDuplicates(
    {
      firstName: input.firstName ?? '',
      surname: input.lastName ?? '',
      emails,
      phones,
      postcodes,
      addresses,
    },
    nonEmployeePeople,
    [],
    { fuzzy: true },
  );

  // Also check if callingOnBehalfOf matches a Person's full name
  const behalfRaw = (input.callingOnBehalfOf ?? '').trim();
  const behalfPersonMatches: DuplicateMatch<Person>[] = [];
  if (hasMinThreeCharToken(behalfRaw) && normaliseComparableName(behalfRaw).includes(' ')) {
    behalfPersonMatches.push(
      ...findPersonDuplicates(
        {
          firstName: behalfRaw,
          surname: '',
          emails: [],
          phones: [],
        },
        nonEmployeePeople,
        [],
        { fuzzy: true },
      ),
    );
  }

  const personMatches = mergeDuplicateMatches([primaryPersonMatches, behalfPersonMatches]);

  // Check Organisations against callingOnBehalfOf, email, email domain, phone, address and postcode
  const orgMatches = mergeDuplicateMatches([
    findOrganisationDuplicates(
      {
        legalName: behalfRaw,
        emails,
        phones,
        postcodes,
        addresses,
      },
      organisations,
      [],
      { fuzzy: true },
    ),
  ]);

  return {
    personMatches,
    orgMatches,
    people: personMatches.map((m) => ({
      person: m.record,
      reasons: m.reasons,
      strength: m.strength ?? 'low',
      formattedReasons: formatEntityMatchReasons(m.reasons),
    })),
    organisations: orgMatches.map((m) => ({
      organisation: m.record,
      reasons: m.reasons,
      strength: m.strength ?? 'low',
      formattedReasons: formatEntityMatchReasons(m.reasons),
    })),
  };
}


/** Urgency rank for queue sorting: Emergency (0), Urgent (1), Standard (2). */
export function urgencyRank(urgencyId: string, values: ChoiceValue[]): number {
  const label = resolveLabel(values, urgencyId).toLowerCase();
  if (label.includes('emergency')) return 0;
  if (label.includes('urgent')) return 1;
  return 2;
}

/** Sort enquiries in queue: Emergency and Urgent at the top, then oldest first. */
export function sortEnquiriesQueue(enquiries: Enquiry[], values: ChoiceValue[]): Enquiry[] {
  return [...enquiries].sort((a, b) => {
    const rA = urgencyRank(a.urgencyId, values);
    const rB = urgencyRank(b.urgencyId, values);
    if (rA !== rB) return rA - rB;
    return a.receivedAt.localeCompare(b.receivedAt);
  });
}

/** Check if user can reopen a closed enquiry (assignee, team lead, or admin). */
export function canUserReopenEnquiry(
  userId: string,
  enquiry: Enquiry,
  teams: Team[],
  people: Person[],
  values: ChoiceValue[],
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  if (isEnquiryOpen(enquiry) || enquiry.status === 'Converted') return false;
  if (enquiry.assignedToId === userId) return true;
  if (isUserTeamLeadFor(userId, enquiry.assignedTeamId, teams)) return true;
  const user = people.find((p) => p.id === userId) ?? null;
  if (!user) return false;
  if (
    user.appRole === 'admin' ||
    user.employeeRoleId === 'employee_role.system_administrator' ||
    user.roles?.includes('admin')
  ) {
    return true;
  }
  if (rbacOptions?.config?.rbac) {
    const role = resolveUserAppRole(user, teams, values, rbacOptions);
    if (role === 'admin') return true;
  }
  return false;
}

/** Anonymise personal details on an unconverted closed enquiry past the retention period. */
export function isReadyForRetentionAnonymisation(
  enquiry: Enquiry,
  retentionMonths: number,
  now: Date = new Date(),
): boolean {
  if (enquiry.status === 'Converted' || isEnquiryOpen(enquiry) || enquiry.anonymisedAt) {
    return false;
  }
  const cutoff = addMonths(now, -Math.max(1, retentionMonths));
  return isBefore(enquiry.receivedAt, cutoff);
}

/**
 * Compute the complete Quick Conflict Check snapshot (conflicts + known records + summary counts/severity).
 * Shared by the server-side save handler and the client UI.
 */
export function computeEnquiryConflictSnapshot(
  input: {
    firstName?: string;
    lastName?: string;
    callingOnBehalfOf?: string;
    otherPartiesNamed?: string;
    email?: string;
    phone?: string;
    postcode?: string;
    addressLine1?: string;
    addressLine2?: string;
    linkedPersonId?: string | null;
    linkedOrganisationId?: string | null;
  },
  people: Person[],
  organisations: Organisation[],
  matters: Matter[],
  values: ChoiceValue[],
  opts: {
    recordedAt: string;
    recordedById: string;
    enquiries?: Enquiry[];
    excludeEnquiryId?: string | null;
    links?: PersonOrganisationLink[];
    canViewMatter?: (matter: Matter) => boolean;
    tenantId: string;
  },
): EnquiryConflictSnapshot {
  const searchedInput = {
    firstName: (input.firstName ?? '').trim(),
    lastName: (input.lastName ?? '').trim(),
    callingOnBehalfOf: (input.callingOnBehalfOf ?? '').trim(),
    otherPartiesNamed: (input.otherPartiesNamed ?? '').trim(),
    email: (input.email ?? '').trim(),
    phone: (input.phone ?? '').trim(),
    postcode: (input.postcode ?? '').trim(),
    addressLine1: (input.addressLine1 ?? '').trim(),
    addressLine2: (input.addressLine2 ?? '').trim(),
    searchedSources: [...CONFLICT_SEARCHED_SOURCES],
  };

  const hasInputs =
    hasQuickConflictCheckInputs(searchedInput) ||
    Boolean(searchedInput.addressLine1 && searchedInput.postcode);

  const conflicts = runEnquiryConflictSearch(
    {
      ...searchedInput,
      address:
        searchedInput.addressLine1 || searchedInput.postcode
          ? {
              line1: searchedInput.addressLine1,
              line2: searchedInput.addressLine2,
              postcode: searchedInput.postcode,
            }
          : null,
      linkedPersonId: input.linkedPersonId ?? null,
      linkedOrganisationId: input.linkedOrganisationId ?? null,
    },
    people,
    organisations,
    matters,
    values,
    opts.enquiries ?? [],
    opts.excludeEnquiryId ?? null,
    opts.links ?? [],
    opts.canViewMatter,
    opts.tenantId,
  );

  const entityMatches = findEnquiryEntityMatches(
    searchedInput,
    people,
    organisations,
    opts.enquiries ?? [],
    opts.excludeEnquiryId ?? null,
  );
  const conflictKeys = new Set(conflicts.allConflicts.map((h) => `${h.recordType}:${h.recordId}`));
  const knownPeople = entityMatches.people
    .filter((m) => !conflictKeys.has(`person:${m.person.id}`))
    .map((m) => ({ id: m.person.id, formattedReasons: m.formattedReasons }));
  const knownOrganisations = entityMatches.organisations
    .filter((m) => !conflictKeys.has(`organisation:${m.organisation.id}`))
    .map((m) => ({ id: m.organisation.id, formattedReasons: m.formattedReasons }));

  const matchCount = conflictKeys.size + knownPeople.length + knownOrganisations.length;

  let highestSeverity: 'high' | 'medium' | 'low' | 'none' = 'none';
  if (conflicts.allConflicts.some((h) => h.severity === 'high' || h.blocking)) {
    highestSeverity = 'high';
  } else if (conflicts.allConflicts.some((h) => h.severity === 'medium')) {
    highestSeverity = 'medium';
  } else if (matchCount > 0) {
    highestSeverity = 'low';
  }

  let conflictStatus: EnquiryConflictStatus = 'Not checked';
  if (hasInputs) {
    if (highestSeverity === 'high') {
      conflictStatus = 'Possible conflict';
    } else if (matchCount > 0) {
      conflictStatus = 'Check';
    } else {
      conflictStatus = 'Clear';
    }
  }

  return {
    recordedAt: opts.recordedAt,
    recordedById: opts.recordedById,
    searchedInput,
    matchCount,
    highestSeverity,
    conflictStatus,
    conflicts: conflicts.allConflicts.map((h) => ({
      recordId: h.recordId,
      recordType: h.recordType,
      name: h.name,
      recordLabel: h.recordLabel,
      queryTerm: h.queryTerm,
      href: h.href,
      reason: h.reason,
      matchedFields: h.matchedFields,
      severity: h.severity,
      strength: h.strength,
      blocking: h.blocking,
    })),
    knownPeople,
    knownOrganisations,
  };
}

export type EnquiriesQueueTab = 'team' | 'mine' | 'drafts' | 'open' | 'open_quotes' | 'closed';

/**
 * Filter enquiries for a tab on the Enquiries list.
 * Drafts never appear in team queues ('team'), 'mine', or 'open'; they appear in 'drafts'.
 */
export function filterEnquiriesForTab(
  enquiries: Enquiry[],
  tab: EnquiriesQueueTab,
  currentUserId: string,
  myTeamIds: Set<string>,
): Enquiry[] {
  if (tab === 'open_quotes') {
    return [];
  }
  if (tab === 'drafts') {
    return enquiries.filter(
      (e) =>
        e.status === 'Draft' &&
        (!currentUserId || e.takenById === currentUserId || e.createdById === currentUserId),
    );
  }
  if (tab === 'team') {
    return enquiries.filter(
      (e) =>
        isEnquiryRouted(e) &&
        Boolean(e.assignedTeamId) &&
        (myTeamIds.size === 0 || myTeamIds.has(e.assignedTeamId!)),
    );
  }
  if (tab === 'mine') {
    return enquiries.filter((e) => e.assignedToId === currentUserId && isEnquiryRouted(e));
  }
  if (tab === 'open') {
    return enquiries.filter(isEnquiryRouted);
  }
  return enquiries.filter((e) => !isEnquiryOpen(e));
}

/**
 * Determine which header actions are available on an enquiry record page.
 * Take, Assign and Convert to matter are only available once the enquiry has been routed (New or later),
 * never on a Draft.
 */
export function getAvailableEnquiryActions(
  enquiry: Pick<Enquiry, 'status' | 'assignedToId'>,
  currentUserId: string,
  canReopen = false,
): string[] {
  if (enquiry.status === 'Draft') {
    return ['Decline', 'Save changes', 'Save and route enquiry'];
  }
  const actions: string[] = [];
  if (isEnquiryRouted(enquiry)) {
    if (enquiry.assignedToId !== currentUserId) {
      actions.push('Take');
    }
    actions.push(
      'Assign',
      'Log contact',
      'Create quote',
      'Convert to matter',
      'Decline',
      'Refer out',
      'Close — no response',
    );
  } else if (canReopen) {
    actions.push('Reopen enquiry');
  }
  actions.push('Edit details');
  return actions;
}

/**
 * Format a conflict hit's display label so the record ID appears once, never duplicated
 * with a repeated trailing record ID suffix.
 */
export function formatConflictAlertLabel(hit: { recordLabel: string; recordId: string }): string {
  const suffix = `(${hit.recordId})`;
  const trimmed = hit.recordLabel.trim();
  if (trimmed.endsWith(suffix)) {
    // Strip any accidental duplicate suffix
    const doubleSuffix = `${suffix} ${suffix}`;
    if (trimmed.endsWith(doubleSuffix)) {
      return trimmed.slice(0, -suffix.length - 1).trim();
    }
    return trimmed;
  }
  if (trimmed.includes(hit.recordId)) {
    return trimmed;
  }
  return `${trimmed} ${suffix}`;
}

export interface EnquiryFormState {
  channelId: string;
  firstName: string;
  lastName: string;
  callingOnBehalfOf: string;
  sourceId: string;
  privacyNoticeGiven: boolean;
  linkedPersonId: string | null;
  linkedOrganisationId: string | null;
  phone: string;
  email: string;
  preferredContactMethodId: string;
  bestTimeToCall: string;
  postcode: string;
  line1: string;
  line2: string;
  town: string;
  county: string;
  countryId: string | null;
  practiceAreaId: string;
  workTypeSubcategoryId: string;
  summary: string;
  notes: string;
  otherPartiesNamed: string;
  urgencyId: string;
  keyDate: string;
  customFields?: Record<string, unknown>;
}

export function extractEnquiryFormInitialState(
  enquiry?: Enquiry | null,
  defaults: { channelId?: string; urgencyId?: string; countryId?: string | null } = {},
): EnquiryFormState {
  return {
    channelId: enquiry?.channelId || defaults.channelId || '',
    firstName: enquiry?.firstName ?? '',
    lastName: enquiry?.lastName ?? '',
    callingOnBehalfOf: enquiry?.callingOnBehalfOf ?? '',
    sourceId: enquiry?.sourceId ?? '',
    privacyNoticeGiven: enquiry?.privacyNoticeGiven ?? false,
    linkedPersonId: enquiry?.linkedPersonId ?? null,
    linkedOrganisationId: enquiry?.linkedOrganisationId ?? null,
    phone: enquiry?.phone ?? '',
    email: enquiry?.email ?? '',
    preferredContactMethodId: enquiry?.preferredContactMethodId ?? '',
    bestTimeToCall: enquiry?.bestTimeToCall ?? '',
    postcode: enquiry?.address?.postcode ?? '',
    line1: enquiry?.address?.line1 ?? '',
    line2: enquiry?.address?.line2 ?? '',
    town: enquiry?.address?.town ?? '',
    county: enquiry?.address?.county ?? '',
    countryId:
      enquiry?.address?.countryId !== undefined
        ? enquiry.address.countryId
        : defaults.countryId ?? null,
    practiceAreaId: enquiry?.practiceAreaId ?? '',
    workTypeSubcategoryId: enquiry?.workTypeSubcategoryId ?? '',
    summary: enquiry?.summary ?? '',
    notes: enquiry?.notes ?? '',
    otherPartiesNamed: enquiry?.otherPartiesNamed ?? '',
    urgencyId: enquiry?.urgencyId || defaults.urgencyId || '',
    keyDate: enquiry?.keyDate ?? '',
    ...(enquiry?.customFields && Object.keys(enquiry.customFields).length > 0
      ? { customFields: { ...enquiry.customFields } }
      : {}),
  };
}

export function isEnquiryFormDirty(current: EnquiryFormState, baseline: EnquiryFormState): boolean {
  const cfCurrent = JSON.stringify(current.customFields ?? {});
  const cfBaseline = JSON.stringify(baseline.customFields ?? {});
  return (
    current.channelId !== baseline.channelId ||
    current.firstName !== baseline.firstName ||
    current.lastName !== baseline.lastName ||
    current.callingOnBehalfOf !== baseline.callingOnBehalfOf ||
    current.sourceId !== baseline.sourceId ||
    current.privacyNoticeGiven !== baseline.privacyNoticeGiven ||
    current.linkedPersonId !== baseline.linkedPersonId ||
    current.linkedOrganisationId !== baseline.linkedOrganisationId ||
    current.phone !== baseline.phone ||
    current.email !== baseline.email ||
    current.preferredContactMethodId !== baseline.preferredContactMethodId ||
    current.bestTimeToCall !== baseline.bestTimeToCall ||
    current.postcode !== baseline.postcode ||
    current.line1 !== baseline.line1 ||
    current.line2 !== baseline.line2 ||
    current.town !== baseline.town ||
    current.county !== baseline.county ||
    current.countryId !== baseline.countryId ||
    current.practiceAreaId !== baseline.practiceAreaId ||
    current.workTypeSubcategoryId !== baseline.workTypeSubcategoryId ||
    current.summary !== baseline.summary ||
    current.notes !== baseline.notes ||
    current.otherPartiesNamed !== baseline.otherPartiesNamed ||
    current.urgencyId !== baseline.urgencyId ||
    current.keyDate !== baseline.keyDate ||
    cfCurrent !== cfBaseline
  );
}

export function computeDraftSaveBarState(opts: {
  isDirty: boolean;
  justSaved: boolean;
  attemptedRouteWithMissing: boolean;
  missingFields: string[];
  lastSavedAtFormatted: string;
  lastSavedByName: string;
}): {
  pillLabel: 'Draft' | 'Unsaved changes' | 'Still needed';
  pillTone: 'neutral' | 'warning' | 'alert';
  message: string;
} {
  const reqSuffix =
    opts.missingFields.length > 0
      ? `Required before routing: ${opts.missingFields.join(', ')}.`
      : 'All required details are in; ready to route.';

  if (opts.attemptedRouteWithMissing && opts.missingFields.length > 0) {
    return {
      pillLabel: 'Still needed',
      pillTone: 'alert',
      message: reqSuffix,
    };
  }
  if (opts.isDirty) {
    return {
      pillLabel: 'Unsaved changes',
      pillTone: 'warning',
      message: reqSuffix,
    };
  }
  if (opts.justSaved) {
    return {
      pillLabel: 'Draft',
      pillTone: 'neutral',
      message: `Saved just now by ${opts.lastSavedByName}. ${reqSuffix}`,
    };
  }
  return {
    pillLabel: 'Draft',
    pillTone: 'neutral',
    message: `Last saved ${opts.lastSavedAtFormatted} by ${opts.lastSavedByName}. ${reqSuffix}`,
  };
}

export interface EnquiryStagePersonEntry {
  kind: 'enquiry_person';
  id: string;
  enquiryId: string;
  enquiryReference: string;
  enquiryStatus: EnquiryStatus;
  firstName: string;
  surname: string;
  displayName: string;
  email: string;
  phone: string;
  callingOnBehalfOf: string;
  linkedOrganisationId: string | null;
  relationshipRoleIds: string[];
  relationshipOwnerId: string | null;
}

/**
 * Returns enquiry-stage people entries for the People list from open enquiries
 * (Draft, New, Assigned, In contact) that have not yet been converted or linked to a Person record.
 * Declined, Referred out, No response, and Converted enquiries are excluded.
 */
export function getEnquiryStagePeople(
  enquiries: Enquiry[],
  people: Person[],
  values: ChoiceValue[],
): EnquiryStagePersonEntry[] {
  const activePersonIds = new Set(
    people.filter((p) => !p.mergedIntoId).map((p) => p.id),
  );

  const clientContactRoleId =
    values.find(
      (v) => v.listKey === 'person_role' && v.label.toLowerCase() === 'client contact',
    )?.id ?? 'person_role.client_contact';
  const privateClientRoleId =
    values.find(
      (v) => v.listKey === 'person_role' && v.label.toLowerCase() === 'private client',
    )?.id ?? 'person_role.private_client';

  const openUnlinked = enquiries
    .filter((enq) => {
      if (!isEnquiryOpen(enq)) return false;
      if (enq.anonymisedAt) return false;
      if (!enq.firstName.trim() && !enq.lastName.trim()) return false;
      if (enq.linkedPersonId && activePersonIds.has(enq.linkedPersonId)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const seenKeys = new Set<string>();
  const out: EnquiryStagePersonEntry[] = [];

  for (const enq of openUnlinked) {
    const normName = normaliseComparableName(`${enq.firstName} ${enq.lastName}`);
    const normEmail = normaliseEmail(enq.email);
    const normPhone = normalisePhoneLast9(enq.phone);
    const dedupeKey =
      normEmail || normPhone
        ? `${normName}|${normEmail}|${normPhone}`
        : `enq:${enq.id}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const isBusinessCaller = Boolean(
      enq.callingOnBehalfOf.trim() || enq.linkedOrganisationId,
    );

    out.push({
      kind: 'enquiry_person',
      id: enq.id,
      enquiryId: enq.id,
      enquiryReference: enq.reference,
      enquiryStatus: enq.status,
      firstName: enq.firstName.trim(),
      surname: enq.lastName.trim(),
      displayName: enquiryDisplayName(enq),
      email: enq.email.trim(),
      phone: enq.phone.trim(),
      callingOnBehalfOf: enq.callingOnBehalfOf.trim(),
      linkedOrganisationId: enq.linkedOrganisationId,
      relationshipRoleIds: [
        isBusinessCaller ? clientContactRoleId : privateClientRoleId,
      ],
      relationshipOwnerId: enq.assignedToId || enq.takenById || null,
    });
  }

  return out;
}

/**
 * Builds synthetic Person records from enquiries whose caller is not yet linked to a Person record.
 * Used across New Matter, New Enquiry, New Person, New Organisation, New Quote, and conflict checks
 * so people saved in enquiries are included in contact lookups, duplicate detection, and conflict checks.
 */
export function buildEnquiryPersonRecords(
  enquiries: Enquiry[],
  people: Person[],
  values: ChoiceValue[] = [],
  excludeEnquiryId?: string | null,
): Person[] {
  const existingPersonIds = new Set(people.map((p) => p.id));
  const linkedEnquiryIds = new Set(
    people
      .map((p) => p.createdFromEnquiryId)
      .filter((id): id is string => Boolean(id)),
  );

  const clientContactRoleId =
    values.find(
      (v) => v.listKey === 'person_role' && v.label.toLowerCase() === 'client contact',
    )?.id ?? 'person_role.client_contact';
  const privateClientRoleId =
    values.find(
      (v) => v.listKey === 'person_role' && v.label.toLowerCase() === 'private client',
    )?.id ?? 'person_role.private_client';
  const prospectStatusId =
    values.find(
      (v) => v.listKey === 'relationship_status' && v.label.toLowerCase() === 'prospect',
    )?.id ?? 'relationship_status.prospect';

  const sorted = [...enquiries].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const seenKeys = new Set<string>();
  const out: Person[] = [];

  for (const enq of sorted) {
    if (excludeEnquiryId && enq.id === excludeEnquiryId) continue;
    if (enq.anonymisedAt) continue;
    if (!enq.firstName.trim() && !enq.lastName.trim()) continue;
    if (existingPersonIds.has(enq.id)) continue;
    if (linkedEnquiryIds.has(enq.id)) continue;
    if (enq.linkedPersonId && existingPersonIds.has(enq.linkedPersonId)) continue;

    const normName = normaliseComparableName(`${enq.firstName} ${enq.lastName}`);
    const normEmail = normaliseEmail(enq.email);
    const normPhone = normalisePhoneLast9(enq.phone);
    const dedupeKey =
      normEmail || normPhone
        ? `${normName}|${normEmail}|${normPhone}`
        : normName
          ? `name:${normName}`
          : `enq:${enq.id}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const isBusinessCaller = Boolean(
      enq.callingOnBehalfOf.trim() || enq.linkedOrganisationId,
    );

    const hasAddress = Boolean(
      enq.address &&
        (enq.address.line1?.trim() ||
          enq.address.postcode?.trim() ||
          enq.address.town?.trim()),
    );

    out.push({
      id: enq.id,
      recordType: 'person',
      recordOwnerId: enq.assignedToId || enq.takenById || null,
      recordStatusId: 'record_status.active',
      createdById: enq.createdById,
      createdAt: enq.createdAt,
      updatedById: enq.updatedById,
      updatedAt: enq.updatedAt,
      sourceId: enq.sourceId || null,
      lastVerifiedAt: null,
      tags: ['enquiry'],
      duplicateStatusId: 'duplicate_status.unique',
      notDuplicateOf: [],
      possibleMatchIds: [],
      mergedIntoId: null,
      lastInteractionAt: enq.updatedAt,
      customFields: {},
      titleId: null,
      firstName: enq.firstName.trim(),
      middleNames: '',
      surname: enq.lastName.trim(),
      preferredName: '',
      dateOfBirth: null,
      otherNames: [],
      jobTitle: enq.callingOnBehalfOf.trim()
        ? `${enq.callingOnBehalfOf.trim()} (${enq.reference})`
        : `Enquiry ${enq.reference} (${enq.status})`,
      emails: enq.email.trim()
        ? [
            {
              id: `${enq.id}-email`,
              address: enq.email.trim(),
              typeId: null,
              isPrimary: true,
              active: true,
            },
          ]
        : [],
      phones: enq.phone.trim()
        ? [
            {
              id: `${enq.id}-phone`,
              number: enq.phone.trim(),
              typeId: null,
              active: true,
            },
          ]
        : [],
      preferredContactMethodId: enq.preferredContactMethodId || null,
      preferredLanguageId: null,
      addresses:
        hasAddress && enq.address
          ? [
              {
                ...enq.address,
                id: enq.address.id || `${enq.id}-addr`,
              },
            ]
          : [],
      website: '',
      relationshipOwnerId: enq.assignedToId || enq.takenById || null,
      relationshipStatusId: prospectStatusId,
      relationshipStandingId: null,
      relationshipRoleIds: [
        isBusinessCaller ? clientContactRoleId : privateClientRoleId,
      ],
      originId: enq.sourceId || null,
      firstKnownAt: enq.receivedAt ? enq.receivedAt.slice(0, 10) : null,
      engagementLevelId: null,
      interests: '',
      relationshipNotes: enq.summary || '',
      marketingConsentId: null,
      consentRecord: '',
      verificationStatusId: null,
      verifiedAt: null,
      verificationMethodId: null,
      verificationReviewerId: null,
      riskReferences: '',
      isEmployee: false,
      employeeRoleId: null,
      departmentId: null,
      createdFromEnquiryId: enq.id,
    });
  }

  return out;
}

/**
 * Returns `people` merged with synthetic Person records for unlinked enquiries.
 */
export function mergePeopleWithEnquiries(
  people: Person[],
  enquiries: Enquiry[] = [],
  values: ChoiceValue[] = [],
  excludeEnquiryId?: string | null,
): Person[] {
  if (!enquiries || enquiries.length === 0) return people;
  const extra = buildEnquiryPersonRecords(enquiries, people, values, excludeEnquiryId);
  if (extra.length === 0) return people;
  return [...people, ...extra];
}

export interface EnquiryDashboardMetrics {
  currentMonthKey: string;
  todayIso: string;
  monthEnquiries: Enquiry[];
  monthReceivedCount: number;
  monthConvertedCount: number;
  monthConversionPct: number;
  monthOpenCount: number;
  monthInContactCount: number;
  monthUnassignedCount: number;
  monthDeclinedCount: number;
  monthReferredCount: number;
  monthNoResponseCount: number;
  callbacksDueTodayCount: number;
  overdueCallbacksCount: number;
  slaEvaluatedCount: number;
  slaMetCount: number;
  slaMetPct: number | null;
  overdueSlaCount: number;
}

const londonDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Formats an ISO timestamp or date string into a `YYYY-MM-DD` calendar date in `Europe/London` (R360).
 * Date-only strings (`YYYY-MM-DD`) are returned unchanged.
 */
export function formatLondonDateIso(isoOrDate: string): string {
  const trimmed = isoOrDate.trim();
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed.slice(0, 10);
  return londonDateFormatter.format(parsed);
}

export function isDueTimestampOverdue(dueIso: string, nowIso: string, todayIso: string): boolean {
  const trimmed = dueIso.trim();
  if (!trimmed) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed < todayIso;
  }
  const dueMs = new Date(trimmed).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isNaN(dueMs) && !Number.isNaN(nowMs)) {
    return dueMs < nowMs;
  }
  return trimmed < nowIso;
}

export interface PracticeAreaAndTeamEnquiryScope {
  enquiries: Enquiry[];
  hasScope: boolean;
}

/**
 * Pure helper to filter enquiries to a user's team practice areas and teams (R361).
 * - Uses only the `practiceAreaIds` and `teamIds` supplied (never supervised matters or firm-wide fallback).
 * - When both `practiceAreaIds` and `teamIds` are empty, returns `{ enquiries: [], hasScope: false }`.
 * - When either set is non-empty, returns `{ hasScope: true, enquiries }` containing enquiries whose
 *   `practiceAreaId` is in `practiceAreaIds` or whose `assignedTeamId` is in `teamIds`.
 */
export function filterEnquiriesForPracticeAreasAndTeams(
  enquiries: readonly Enquiry[],
  practiceAreaIds: Iterable<string>,
  teamIds: Iterable<string>,
): PracticeAreaAndTeamEnquiryScope {
  const paSet = new Set(Array.from(practiceAreaIds).filter(Boolean));
  const tmSet = new Set(Array.from(teamIds).filter(Boolean));
  if (paSet.size === 0 && tmSet.size === 0) {
    return { enquiries: [], hasScope: false };
  }
  const filtered = enquiries.filter(
    (e) =>
      (Boolean(e.practiceAreaId) && paSet.has(e.practiceAreaId)) ||
      (e.assignedTeamId !== null && Boolean(e.assignedTeamId) && tmSet.has(e.assignedTeamId)),
  );
  return { enquiries: filtered, hasScope: true };
}

/**
 * Pure helper for Home dashboard enquiry KPIs and panels (R324, R342, R343, R360):
 * - Formats `receivedAt` and `firstContactDueAt` in `Europe/London` (`formatLondonDateIso`) for
 *   `currentMonthKey` (`YYYY-MM`) and `todayIso` (`YYYY-MM-DD`) calendar bucketing.
 * - Compares `firstContactDueAt` against the real `nowIso` instant for overdue and SLA checks.
 * - Filters `callbacksDueTodayCount` to uncontacted open enquiries (`contactLog.length === 0`)
 *   whose callback/due date in `Europe/London` equals `todayIso`.
 * - Computes `slaMetPct` only over enquiries that have been contacted (`contactLog.length > 0`,
 *   comparing the earliest `contactLog[].at` against `firstContactDueAt`) or are already overdue.
 */
export function computeEnquiryDashboardMetrics(
  enquiries: readonly Enquiry[],
  nowIso: string,
  options?: { todayIso?: string; currentMonthKey?: string },
): EnquiryDashboardMetrics {
  const todayIso = options?.todayIso ?? formatLondonDateIso(nowIso);
  const currentMonthKey = options?.currentMonthKey ?? todayIso.slice(0, 7);

  const monthEnquiries = enquiries.filter(
    (e) => Boolean(e.receivedAt) && formatLondonDateIso(e.receivedAt).slice(0, 7) === currentMonthKey,
  );
  const monthReceivedCount = monthEnquiries.length;
  const monthConvertedCount = monthEnquiries.filter((e) => e.status === 'Converted').length;
  const monthConversionPct =
    monthReceivedCount > 0 ? Math.round((monthConvertedCount / monthReceivedCount) * 100) : 0;
  const monthOpenCount = monthEnquiries.filter((e) => isEnquiryOpen(e)).length;
  const monthInContactCount = monthEnquiries.filter((e) => e.status === 'In contact').length;
  const monthUnassignedCount = monthEnquiries.filter(
    (e) => isEnquiryOpen(e) && !e.assignedToId,
  ).length;
  const monthDeclinedCount = monthEnquiries.filter((e) => e.status === 'Declined').length;
  const monthReferredCount = monthEnquiries.filter((e) => e.status === 'Referred out').length;
  const monthNoResponseCount = monthEnquiries.filter((e) => e.status === 'No response').length;

  const callbacksDueTodayCount = enquiries.filter((e) => {
    if (!isEnquiryOpen(e) || e.contactLog.length > 0) return false;
    const firstDueDay = e.firstContactDueAt ? formatLondonDateIso(e.firstContactDueAt) : null;
    const nextActionDay = e.nextActionDate ? formatLondonDateIso(e.nextActionDate) : null;
    return firstDueDay === todayIso || nextActionDay === todayIso;
  }).length;

  const overdueCallbacksCount = enquiries.filter((e) => {
    if (!isEnquiryOpen(e)) return false;
    const firstDueOverdue =
      Boolean(e.firstContactDueAt) &&
      isDueTimestampOverdue(e.firstContactDueAt!, nowIso, todayIso) &&
      e.contactLog.length === 0;
    const nextActionOverdue =
      Boolean(e.nextActionDate) && formatLondonDateIso(e.nextActionDate!) < todayIso;
    return firstDueOverdue || nextActionOverdue;
  }).length;

  let slaEvaluatedCount = 0;
  let slaMetCount = 0;
  let overdueSlaCount = 0;

  for (const e of enquiries) {
    if (!e.firstContactDueAt) continue;
    const firstContactAt = e.contactLog.reduce<string | null>(
      (earliest, entry) =>
        entry.at && (!earliest || entry.at < earliest) ? entry.at : earliest,
      null,
    );
    const hasContact = Boolean(firstContactAt);
    const isOverdue =
      !hasContact && isDueTimestampOverdue(e.firstContactDueAt, nowIso, todayIso);

    if (isEnquiryOpen(e) && isOverdue) {
      overdueSlaCount += 1;
    }

    if (hasContact || isOverdue) {
      slaEvaluatedCount += 1;
      if (hasContact && firstContactAt! <= e.firstContactDueAt) {
        slaMetCount += 1;
      }
    }
  }

  const slaMetPct =
    slaEvaluatedCount > 0 ? Math.round((slaMetCount / slaEvaluatedCount) * 100) : null;

  return {
    currentMonthKey,
    todayIso,
    monthEnquiries,
    monthReceivedCount,
    monthConvertedCount,
    monthConversionPct,
    monthOpenCount,
    monthInContactCount,
    monthUnassignedCount,
    monthDeclinedCount,
    monthReferredCount,
    monthNoResponseCount,
    callbacksDueTodayCount,
    overdueCallbacksCount,
    slaEvaluatedCount,
    slaMetCount,
    slaMetPct,
    overdueSlaCount,
  };
}

