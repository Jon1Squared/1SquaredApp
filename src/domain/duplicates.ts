/** Duplicate detection rules for people and organisations. */
import {
  addressesMatch,
  extractEmailDomain,
  FREE_EMAIL_DOMAINS,
  hasMinThreeCharToken,
  isValidEmailFormat,
  isValidUkPostcode,
  normaliseComparableName,
  normaliseEmail,
  normaliseOrgName,
  normalisePhoneLast9,
  normalisePostcode,
  normaliseRegNumber,
  organisationNameLooseMatch,
  personNameLooseMatch,
  type AddressLike,
} from './normalise';
import type { Organisation, Person } from './types';

export type DuplicateReason =
  | 'email'
  | 'emailDomain'
  | 'phone'
  | 'name'
  | 'similarName'
  | 'soundsLike'
  | 'orgName'
  | 'companyNumber'
  | 'address'
  | 'postcode';

export const REASON_LABELS: Record<DuplicateReason, string> = {
  email: 'Same email',
  emailDomain: 'Same email domain',
  phone: 'Same phone',
  name: 'Same name',
  similarName: 'Similar name',
  soundsLike: 'Name sounds alike',
  orgName: 'Same name',
  companyNumber: 'Same company number',
  address: 'Same address',
  postcode: 'Same postcode',
};

export const REASON_STRENGTH: Record<DuplicateReason, number> = {
  email: 5,
  companyNumber: 5,
  phone: 4,
  name: 4,
  orgName: 4,
  address: 3,
  emailDomain: 2,
  similarName: 2,
  soundsLike: 2,
  postcode: 1,
};

/** Short lower-case wording for each reason, used in "Matched on: ..." text. */
const REASON_SHORT: Record<DuplicateReason, string> = {
  email: 'email',
  emailDomain: 'email domain',
  phone: 'phone',
  name: 'name',
  similarName: 'similar name',
  soundsLike: 'name sounds alike',
  orgName: 'name',
  companyNumber: 'company number',
  address: 'same address',
  postcode: 'same postcode',
};

/** Human-readable reasons, e.g. ['name', 'email'] -> "name, email". */
export function formatDuplicateReasons(reasons: DuplicateReason[]): string {
  return Array.from(new Set(reasons.map((r) => REASON_SHORT[r] ?? r))).join(', ');
}

/**
 * Options for duplicate matching. `fuzzy` adds 'similarName' (misspelling) and 'soundsLike'
 * (phonetic) matches. Used by the New Enquiry screen and the People / Organisation forms.
 */
export interface DuplicateMatchOptions {
  fuzzy?: boolean;
}

export interface DuplicateMatch<T> {
  record: T;
  reasons: DuplicateReason[];
  strength?: 'high' | 'medium' | 'low';
}

export interface PersonCandidate {
  id?: string;
  firstName: string;
  preferredName?: string;
  surname: string;
  emails: string[];
  phones: string[];
  /** Postcode-only matching (weak signal). */
  postcodes?: string[];
  /** Full address matching (first line + postcode). */
  addresses?: AddressLike[];
}

export interface OrgCandidate {
  id?: string;
  legalName: string;
  otherNames?: string[];
  companyNumber?: string;
  emails?: string[];
  phones?: string[];
  postcodes?: string[];
  addresses?: AddressLike[];
}

function orgAddresses(o: Organisation): AddressLike[] {
  return [o.registeredAddress, o.correspondenceAddress, o.billingAddress].filter(
    (a): a is NonNullable<typeof a> => Boolean(a),
  );
}

function anyAddressMatch(candidates: AddressLike[] | undefined, theirs: AddressLike[]): boolean {
  if (!candidates?.length) return false;
  return candidates.some((c) => theirs.some((t) => addressesMatch(c, t)));
}

function firstNameMatches(a: string, b: string): boolean {
  const na = normaliseComparableName(a);
  const nb = normaliseComparableName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Initial match: "G" or "G." vs "Gareth"
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  return short.length === 1 && long.startsWith(short);
}

function excluded(
  candidateId: string | undefined,
  r: { id: string; mergedIntoId: string | null; notDuplicateOf: string[] },
): boolean {
  if (r.mergedIntoId) return true;
  if (!candidateId) return false;
  return r.id === candidateId || r.notDuplicateOf.includes(candidateId);
}

function computeStrength(reasons: DuplicateReason[]): 'high' | 'medium' | 'low' {
  if (reasons.some((r) => REASON_STRENGTH[r] >= 4)) return 'high';
  if (reasons.some((r) => REASON_STRENGTH[r] >= 2)) return 'medium';
  return 'low';
}

function scoreReasons(reasons: DuplicateReason[]): number {
  return reasons.reduce((sum, r) => sum + (REASON_STRENGTH[r] ?? 1), 0);
}

export function findPersonDuplicates(
  candidate: PersonCandidate,
  people: Person[],
  dismissed: string[] = [],
  opts: DuplicateMatchOptions = {},
): DuplicateMatch<Person>[] {
  const emails = new Set(
    candidate.emails
      .map(normaliseEmail)
      .filter((e) => isValidEmailFormat(e)),
  );
  const phones = new Set(
    candidate.phones
      .map(normalisePhoneLast9)
      .filter((p) => p.length >= 9),
  );
  const postcodes = new Set(
    (candidate.postcodes ?? [])
      .filter((pc) => isValidUkPostcode(pc))
      .map(normalisePostcode),
  );

  const rawSurname = normaliseComparableName(candidate.surname);
  const rawFirsts = [candidate.firstName, candidate.preferredName ?? '']
    .map(normaliseComparableName)
    .filter(Boolean);
  const combinedNameInput = [candidate.firstName, candidate.surname].filter(Boolean).join(' ');
  const nameThresholdMet = hasMinThreeCharToken(combinedNameInput);

  const matches: DuplicateMatch<Person>[] = [];
  for (const p of people) {
    if (excluded(candidate.id, p) || dismissed.includes(p.id)) continue;
    const reasons: DuplicateReason[] = [];

    if (emails.size > 0 && p.emails.some((e) => emails.has(normaliseEmail(e.address)))) {
      reasons.push('email');
    }

    if (phones.size > 0 && p.phones.some((ph) => phones.has(normalisePhoneLast9(ph.number)))) {
      reasons.push('phone');
    }

    if (nameThresholdMet) {
      const pSurname = normaliseComparableName(p.surname);
      const pFirsts = [p.firstName, p.preferredName, ...p.otherNames.map((n) => n.name)]
        .map(normaliseComparableName)
        .filter(Boolean);

      if (rawSurname && pSurname === rawSurname && rawFirsts.length > 0) {
        if (rawFirsts.some((a) => pFirsts.some((b) => firstNameMatches(a, b)))) {
          reasons.push('name');
        }
      } else if (!rawSurname && rawFirsts.length > 0) {
        // Full name typed into a single field (e.g. "Siân Lewis" in firstName or callingOnBehalfOf)
        const pFull = normaliseComparableName(`${p.firstName} ${p.surname}`);
        const pPrefFull = p.preferredName
          ? normaliseComparableName(`${p.preferredName} ${p.surname}`)
          : '';
        if (rawFirsts.some((f) => f.includes(' ') && (f === pFull || (pPrefFull && f === pPrefFull)))) {
          reasons.push('name');
        }
      } else if (rawSurname && rawFirsts.length === 0 && rawSurname.includes(' ')) {
        // Full name typed into surname field
        const pFull = normaliseComparableName(`${p.firstName} ${p.surname}`);
        if (rawSurname === pFull) {
          reasons.push('name');
        }
      }

      if (opts.fuzzy && !reasons.includes('name')) {
        const queryFull = [candidate.firstName, candidate.surname].filter(Boolean).join(' ');
        const targets = [
          `${p.firstName} ${p.surname}`,
          p.preferredName ? `${p.preferredName} ${p.surname}` : '',
        ].filter(Boolean);
        const kinds = targets.map((t) => personNameLooseMatch(queryFull, t));
        if (kinds.includes('similar spelling')) reasons.push('similarName');
        else if (kinds.includes('sounds like')) reasons.push('soundsLike');
      }
    }

    if (anyAddressMatch(candidate.addresses, p.addresses)) {
      reasons.push('address');
    } else if (
      postcodes.size > 0 &&
      p.addresses.some((a) => postcodes.has(normalisePostcode(a.postcode)))
    ) {
      reasons.push('postcode');
    }

    if (reasons.length) {
      const uniqueReasons = Array.from(new Set(reasons));
      matches.push({
        record: p,
        reasons: uniqueReasons,
        strength: computeStrength(uniqueReasons),
      });
    }
  }
  return matches.sort((a, b) => scoreReasons(b.reasons) - scoreReasons(a.reasons));
}

function extractOrgDomains(o: Organisation): Set<string> {
  const domains = new Set<string>();
  const emailDom = extractEmailDomain(o.generalEmail);
  if (emailDom && !FREE_EMAIL_DOMAINS.has(emailDom)) {
    domains.add(emailDom);
  }
  if (o.website) {
    const cleaned = o.website
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0] ?? '';
    if (cleaned && cleaned.includes('.') && !FREE_EMAIL_DOMAINS.has(cleaned)) {
      domains.add(cleaned);
    }
  }
  return domains;
}

export function findOrganisationDuplicates(
  candidate: OrgCandidate,
  organisations: Organisation[],
  dismissed: string[] = [],
  opts: DuplicateMatchOptions = {},
): DuplicateMatch<Organisation>[] {
  const rawNames = [candidate.legalName, ...(candidate.otherNames ?? [])].filter((n) =>
    hasMinThreeCharToken(n),
  );
  const orgKeyNames = new Set(rawNames.map(normaliseOrgName).filter((n) => n.length >= 3));
  const compNames = new Set(rawNames.map(normaliseComparableName).filter((n) => n.length >= 3));
  const companyNumber = normaliseRegNumber(candidate.companyNumber);

  const emails = new Set(
    (candidate.emails ?? [])
      .map(normaliseEmail)
      .filter((e) => isValidEmailFormat(e)),
  );
  const emailDomains = new Set(
    (candidate.emails ?? [])
      .map(extractEmailDomain)
      .filter((d) => d && !FREE_EMAIL_DOMAINS.has(d)),
  );
  const phones = new Set(
    (candidate.phones ?? [])
      .map(normalisePhoneLast9)
      .filter((p) => p.length >= 9),
  );
  const postcodes = new Set(
    (candidate.postcodes ?? [])
      .filter((pc) => isValidUkPostcode(pc))
      .map(normalisePostcode),
  );

  const matches: DuplicateMatch<Organisation>[] = [];
  for (const o of organisations) {
    if (excluded(candidate.id, o) || dismissed.includes(o.id)) continue;
    const reasons: DuplicateReason[] = [];

    if (orgKeyNames.size > 0 || compNames.size > 0) {
      const theirRaw = [o.legalName, ...o.otherNames.map((n) => n.name)];
      const theirOrgKeys = theirRaw.map(normaliseOrgName).filter(Boolean);
      const theirCompNames = theirRaw.map(normaliseComparableName).filter(Boolean);
      if (
        theirOrgKeys.some((n) => orgKeyNames.has(n)) ||
        theirCompNames.some((n) => compNames.has(n))
      ) {
        reasons.push('orgName');
      } else if (opts.fuzzy) {
        const kinds = rawNames.flatMap((q) => theirRaw.map((t) => organisationNameLooseMatch(q, t)));
        if (kinds.includes('similar spelling')) reasons.push('similarName');
        else if (kinds.includes('sounds like')) reasons.push('soundsLike');
      }
    }

    if (companyNumber && normaliseRegNumber(o.companyNumber) === companyNumber) {
      reasons.push('companyNumber');
    }

    if (emails.size > 0 && o.generalEmail && emails.has(normaliseEmail(o.generalEmail))) {
      reasons.push('email');
    } else if (emailDomains.size > 0) {
      const orgDoms = extractOrgDomains(o);
      if (Array.from(emailDomains).some((d) => orgDoms.has(d))) {
        reasons.push('emailDomain');
      }
    }

    if (phones.size > 0 && o.mainPhone && phones.has(normalisePhoneLast9(o.mainPhone))) {
      reasons.push('phone');
    }

    if (anyAddressMatch(candidate.addresses, orgAddresses(o))) {
      reasons.push('address');
    } else if (postcodes.size > 0) {
      const orgPcs = orgAddresses(o).map((a) => normalisePostcode(a.postcode));
      if (orgPcs.some((pc) => postcodes.has(pc))) {
        reasons.push('postcode');
      }
    }

    if (reasons.length) {
      const uniqueReasons = Array.from(new Set(reasons));
      matches.push({
        record: o,
        reasons: uniqueReasons,
        strength: computeStrength(uniqueReasons),
      });
    }
  }
  return matches.sort((a, b) => scoreReasons(b.reasons) - scoreReasons(a.reasons));
}

export function personCandidateFrom(p: Person): PersonCandidate {
  return {
    id: p.id,
    firstName: p.firstName,
    preferredName: p.preferredName,
    surname: p.surname,
    emails: p.emails.map((e) => e.address),
    phones: p.phones.map((ph) => ph.number),
  };
}

export function orgCandidateFrom(o: Organisation): OrgCandidate {
  return {
    id: o.id,
    legalName: o.legalName,
    otherNames: o.otherNames.map((n) => n.name),
    companyNumber: o.companyNumber,
    emails: o.generalEmail ? [o.generalEmail] : [],
    phones: o.mainPhone ? [o.mainPhone] : [],
  };
}

