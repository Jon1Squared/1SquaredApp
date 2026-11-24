/**
 * Pure domain helpers for C2 server preview sanitisation and fuzzy picker scoring.
 */
import {
  allowedNameEdits,
  editDistance,
  normaliseComparableName,
  organisationNameLooseMatch,
  personNameLooseMatch,
  tokensSoundAlike,
} from './normalise';
import { personDisplayName, primaryEmail } from './names';
import type {
  EntityPickerEnquirySummary,
  EntityPickerMatterSummary,
  EntityPickerOption,
  EntityPickerOrganisationSummary,
  EntityPickerPersonSummary,
} from './intakePreviewTypes';
import type { Enquiry, Matter, Organisation, Person, PersonOrganisationLink } from './types';

/**
 * Strips all HR/employment, payroll, sensitive, override, role, and Entra fields
 * from a Person before returning it in preview or search-picker payloads.
 */
export function sanitizePersonForClientPreview(
  person: Person,
  options?: { readonly preserveNonEmployeeDob?: boolean },
): Person {
  const safe: Person = {
    id: person.id,
    recordType: 'person',
    recordOwnerId: person.recordOwnerId,
    recordStatusId: person.recordStatusId,
    createdById: person.createdById,
    createdAt: person.createdAt,
    updatedById: person.updatedById,
    updatedAt: person.updatedAt,
    sourceId: person.sourceId,
    lastVerifiedAt: person.lastVerifiedAt,
    tags: [...(person.tags ?? [])],
    duplicateStatusId: person.duplicateStatusId,
    notDuplicateOf: [...(person.notDuplicateOf ?? [])],
    possibleMatchIds: [...(person.possibleMatchIds ?? [])],
    mergedIntoId: person.mergedIntoId,
    lastInteractionAt: person.lastInteractionAt,
    customFields: structuredClone(person.customFields ?? {}),
    titleId: person.titleId,
    firstName: person.firstName,
    middleNames: person.middleNames,
    surname: person.surname,
    preferredName: person.preferredName,
    otherNames: structuredClone(person.otherNames ?? []),
    jobTitle: person.jobTitle,
    emails: structuredClone(person.emails ?? []),
    phones: structuredClone(person.phones ?? []),
    preferredContactMethodId: person.preferredContactMethodId,
    preferredLanguageId: person.preferredLanguageId,
    addresses: structuredClone(person.addresses ?? []),
    website: person.website,
    relationshipOwnerId: person.relationshipOwnerId,
    relationshipStatusId: person.relationshipStatusId,
    relationshipStandingId: person.relationshipStandingId,
    relationshipRoleIds: [...(person.relationshipRoleIds ?? [])],
    originId: person.originId,
    firstKnownAt: person.firstKnownAt,
    engagementLevelId: person.engagementLevelId,
    interests: person.interests,
    relationshipNotes: person.relationshipNotes,
    marketingConsentId: person.marketingConsentId,
    consentRecord: person.consentRecord,
    verificationStatusId: person.verificationStatusId,
    verifiedAt: person.verifiedAt,
    verificationMethodId: person.verificationMethodId,
    verificationReviewerId: person.verificationReviewerId,
    riskReferences: person.riskReferences,
    isEmployee: person.isEmployee,
    employeeRoleId: person.employeeRoleId,
    departmentId: person.departmentId,
  };
  if (typeof person.demo === 'boolean') {
    safe.demo = person.demo;
  }
  if (person.createdFromEnquiryId !== undefined) {
    safe.createdFromEnquiryId = person.createdFromEnquiryId;
  }
  if (
    options?.preserveNonEmployeeDob &&
    !person.isEmployee &&
    !person.employment &&
    person.dateOfBirth !== undefined
  ) {
    safe.dateOfBirth = person.dateOfBirth;
  }
  return safe;
}

export function toEntityPickerPersonSummary(
  person: Person,
  options?: { readonly preserveNonEmployeeDob?: boolean },
): EntityPickerPersonSummary {
  const safe = sanitizePersonForClientPreview(person, options);
  const firstTown = safe.addresses?.[0]?.town;
  return {
    id: safe.id,
    firstName: safe.firstName,
    surname: safe.surname,
    ...(safe.preferredName !== undefined ? { preferredName: safe.preferredName } : {}),
    ...(safe.jobTitle !== undefined ? { jobTitle: safe.jobTitle } : {}),
    ...(safe.dateOfBirth !== undefined ? { dateOfBirth: safe.dateOfBirth } : {}),
    ...(safe.verificationStatusId !== undefined
      ? { verificationStatusId: safe.verificationStatusId }
      : {}),
    ...(safe.relationshipStatusId !== undefined
      ? { relationshipStatusId: safe.relationshipStatusId }
      : {}),
    ...(safe.verifiedAt !== undefined ? { verifiedAt: safe.verifiedAt } : {}),
    ...(safe.isEmployee !== undefined ? { isEmployee: safe.isEmployee } : {}),
    ...(safe.mergedIntoId !== undefined ? { mergedIntoId: safe.mergedIntoId } : {}),
    emails: structuredClone(safe.emails ?? []),
    phones: structuredClone(safe.phones ?? []),
    ...(firstTown ? { addresses: [{ town: firstTown }] } : {}),
  };
}

export function toEntityPickerOrganisationSummary(
  org: Organisation | EntityPickerOrganisationSummary,
): EntityPickerOrganisationSummary {
  const addr = org.registeredAddress;
  return {
    id: org.id,
    legalName: org.legalName,
    ...(org.organisationTypeId !== undefined
      ? { organisationTypeId: org.organisationTypeId }
      : {}),
    ...(org.companyNumber !== undefined ? { companyNumber: org.companyNumber } : {}),
    ...(org.generalEmail !== undefined ? { generalEmail: org.generalEmail } : {}),
    ...(org.mainPhone !== undefined ? { mainPhone: org.mainPhone } : {}),
    ...(org.parentOrganisationId !== undefined
      ? { parentOrganisationId: org.parentOrganisationId }
      : {}),
    ...(org.verificationStatusId !== undefined
      ? { verificationStatusId: org.verificationStatusId }
      : {}),
    ...(org.relationshipStatusId !== undefined
      ? { relationshipStatusId: org.relationshipStatusId }
      : {}),
    ...(org.reviewDate !== undefined ? { reviewDate: org.reviewDate } : {}),
    ...(org.mergedIntoId !== undefined ? { mergedIntoId: org.mergedIntoId } : {}),
    ...(addr && (addr.line1 || addr.town || addr.postcode)
      ? {
          registeredAddress: {
            line1: addr.line1 ?? '',
            town: addr.town ?? '',
            postcode: addr.postcode ?? '',
          },
        }
      : {}),
  };
}

export function toEntityPickerMatterSummary(matter: Matter): EntityPickerMatterSummary {
  return {
    id: matter.id,
    matterNumber: matter.matterNumber,
    title: matter.title,
    clientId: matter.clientId,
    matterStatusId: matter.matterStatusId,
    leadFeeEarnerId: matter.leadFeeEarnerId,
    supervisingPartnerId: matter.supervisingPartnerId,
    responsiblePartnerId: matter.responsiblePartnerId,
    teamMemberIds: [...(matter.teamMemberIds ?? [])],
  };
}

export function toEntityPickerEnquirySummary(
  enquiry: Enquiry,
): EntityPickerEnquirySummary {
  return {
    id: enquiry.id,
    reference: enquiry.reference,
    firstName: enquiry.firstName,
    lastName: enquiry.lastName,
    callingOnBehalfOf: enquiry.callingOnBehalfOf,
    summary: enquiry.summary,
    notes: enquiry.notes,
    email: enquiry.email,
    phone: enquiry.phone,
    ...(enquiry.linkedPersonId !== undefined
      ? { linkedPersonId: enquiry.linkedPersonId }
      : {}),
    ...(enquiry.linkedOrganisationId !== undefined
      ? { linkedOrganisationId: enquiry.linkedOrganisationId }
      : {}),
    ...(enquiry.practiceAreaId !== undefined
      ? { practiceAreaId: enquiry.practiceAreaId }
      : {}),
    ...(enquiry.workTypeSubcategoryId !== undefined
      ? { workTypeSubcategoryId: enquiry.workTypeSubcategoryId }
      : {}),
    ...(enquiry.assignedToId !== undefined ? { assignedToId: enquiry.assignedToId } : {}),
    status: enquiry.status,
  };
}

function checkTokenMatch(
  queryVal: string,
  candidates: readonly string[],
): 'exact' | 'similar spelling' | 'sounds like' | null {
  const qNorm = normaliseComparableName(queryVal);
  const qTokens = qNorm.split(' ').filter(Boolean);
  if (qTokens.length === 0) return null;

  let best: 'exact' | 'similar spelling' | 'sounds like' | null = null;
  for (const cand of candidates) {
    const cNorm = normaliseComparableName(cand);
    if (!cNorm) continue;
    if (cNorm.includes(qNorm)) {
      return 'exact';
    }
    const cTokens = cNorm.split(' ').filter(Boolean);
    let allMatched = true;
    let usedFuzzy: 'similar spelling' | 'sounds like' | null = null;
    for (const qt of qTokens) {
      let tokenMatched = false;
      for (const ct of cTokens) {
        if (ct.includes(qt)) {
          tokenMatched = true;
          break;
        }
        const minLen = Math.min(qt.length, ct.length);
        const maxEdits =
          minLen >= 4 ? allowedNameEdits(minLen) : minLen === 3 ? 1 : 0;
        if (maxEdits > 0 && editDistance(qt, ct) <= maxEdits) {
          tokenMatched = true;
          if (!usedFuzzy) usedFuzzy = 'similar spelling';
          break;
        }
        if (qt.length >= 3 && ct.length >= 3 && tokensSoundAlike(qt, ct)) {
          tokenMatched = true;
          if (!usedFuzzy) usedFuzzy = 'sounds like';
          break;
        }
      }
      if (!tokenMatched) {
        allMatched = false;
        break;
      }
    }
    if (allMatched) {
      if (!usedFuzzy) return 'exact';
      if (best !== 'similar spelling') best = usedFuzzy;
    }
  }
  return best;
}

/**
 * Shared fuzzy/phonetic scoring for Client Lookup (`MatterFormClient`) and
 * Prospect Lookup (`QuoteFormClient`) over SQL candidate rows.
 */
export function scoreFuzzyPersonOrgQuery(params: {
  readonly personQuery: {
    readonly firstName?: string;
    readonly surname?: string;
    readonly organisationName?: string;
  };
  readonly people: readonly Person[];
  readonly organisations: readonly Organisation[];
  readonly links: readonly PersonOrganisationLink[];
  readonly includePeople: boolean;
  readonly includeOrganisations: boolean;
  readonly excludeIds?: ReadonlySet<string>;
  readonly excludeDemo?: boolean;
  readonly employeesOnly?: boolean;
  readonly nonEmployeesOnly?: boolean;
  readonly limit: number;
}): EntityPickerOption[] {
  const fnRaw = params.personQuery.firstName?.trim() ?? '';
  const snRaw = params.personQuery.surname?.trim() ?? '';
  const orgRaw = params.personQuery.organisationName?.trim() ?? '';
  const fn = normaliseComparableName(fnRaw);
  const sn = normaliseComparableName(snRaw);
  const orgQ = normaliseComparableName(orgRaw);
  if (!fn && !sn && !orgQ) return [];

  const orgById = new Map(params.organisations.map((o) => [o.id, o]));
  const results: EntityPickerOption[] = [];

  if (params.includePeople) {
    for (const p of params.people) {
      if (p.mergedIntoId) continue;
      if (params.excludeIds?.has(p.id)) continue;
      if (params.excludeDemo && p.demo) continue;
      if (params.employeesOnly && !p.isEmployee) continue;
      if (params.nonEmployeesOnly && p.isEmployee) continue;

      const linkedOrgs = params.links
        .filter((l) => l.personId === p.id && l.isCurrent)
        .map((l) => orgById.get(l.organisationId))
        .filter((o): o is Organisation => Boolean(o && !o.mergedIntoId));

      let matchNote: 'similar spelling' | 'sounds like' | null = null;
      if (fn) {
        const fnRes = checkTokenMatch(fn, [
          p.firstName,
          p.preferredName ?? '',
          ...(p.otherNames ?? []).map((n) => n.name),
        ]);
        if (!fnRes) continue;
        if (fnRes !== 'exact') matchNote = fnRes;
      }
      if (sn) {
        const snRes = checkTokenMatch(sn, [
          p.surname,
          ...(p.otherNames ?? []).map((n) => n.name),
        ]);
        if (!snRes) continue;
        if (snRes !== 'exact' && !matchNote) matchNote = snRes;
      }
      if (!matchNote && fn && sn) {
        const loose = personNameLooseMatch(
          `${fnRaw} ${snRaw}`,
          `${p.firstName} ${p.surname}`,
        );
        if (loose) matchNote = loose;
      }
      if (orgQ) {
        const orgCandidates = linkedOrgs.flatMap((o) => [
          o.legalName,
          ...(o.otherNames ?? []).map((n) => n.name),
        ]);
        const orgRes = checkTokenMatch(orgQ, orgCandidates);
        const looseOrg = linkedOrgs
          .map((o) => organisationNameLooseMatch(orgRaw, o.legalName))
          .find(Boolean);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact' && !matchNote) matchNote = orgRes;
        else if (!orgRes && looseOrg && !matchNote) matchNote = looseOrg;
      }

      const email = primaryEmail(p);
      const town = p.addresses?.[0]?.town ?? '';
      const safePerson = toEntityPickerPersonSummary(p, {
        preserveNonEmployeeDob: true,
      });
      results.push({
        id: p.id,
        recordType: 'person',
        label: personDisplayName(p),
        subtitle: [p.jobTitle || null, email, town || null]
          .filter(Boolean)
          .join(' · '),
        reference: p.id,
        href: p.id.startsWith('ENQ-') ? `/enquiries/${p.id}` : `/people/${p.id}`,
        matchNote,
        rank: matchNote ? 2 : 1,
        person: safePerson,
        linkedOrgs: linkedOrgs.map(toEntityPickerOrganisationSummary),
      });
    }
  }

  if (params.includeOrganisations) {
    const combinedQuery = orgQ ? orgRaw : [fnRaw, snRaw].filter(Boolean).join(' ');
    for (const o of params.organisations) {
      if (o.mergedIntoId) continue;
      if (params.excludeIds?.has(o.id)) continue;
      if (!combinedQuery) continue;
      const orgCandidates = [o.legalName, ...(o.otherNames ?? []).map((n) => n.name)];
      const orgRes = checkTokenMatch(combinedQuery, orgCandidates);
      const looseOrg = organisationNameLooseMatch(combinedQuery, o.legalName);
      if (!orgRes && !looseOrg) continue;
      const matchNote: 'similar spelling' | 'sounds like' | null =
        orgRes && orgRes !== 'exact'
          ? orgRes
          : !orgRes && looseOrg
            ? looseOrg
            : null;
      results.push({
        id: o.id,
        recordType: 'organisation',
        label: o.legalName,
        subtitle: [
          o.companyNumber ? `Co. no. ${o.companyNumber}` : null,
          o.registeredAddress?.town ?? null,
          o.generalEmail || null,
        ]
          .filter(Boolean)
          .join(' · '),
        reference: o.id,
        href: `/organisations/${o.id}`,
        matchNote,
        rank: matchNote ? 2 : 1,
        organisation: toEntityPickerOrganisationSummary(o),
      });
    }
  }

  return results
    .sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1) || a.label.localeCompare(b.label))
    .slice(0, params.limit);
}
