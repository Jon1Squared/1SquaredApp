import { formatDate } from './dates';
import { personDisplayName } from './names';
import type {
  ConflictCheckMatch,
  ConflictCheckParty,
  Enquiry,
  Matter,
  MatterParty,
  Organisation,
  Person,
  PersonOrganisationLink,
} from './types';

export const CONFLICT_SEARCHED_SOURCES = [
  'matter clients',
  'additional clients',
  'parties',
  'instructing contacts',
  'billing contacts',
  'person–organisation links',
  'enquiries',
  'directory',
] as const;

export interface MatterConflictSearchInput {
  currentMatterId?: string | null;
  sourceEnquiryId?: string | null;
  parties: ConflictCheckParty[];
  previousMatches?: ConflictCheckMatch[];
  canReviewConditions?: boolean;
  reviewerUserId?: string | null;
  reviewerDisplayName?: string | null;
  reviewedAtIso?: string | null;
}

export interface MatterConflictSearchDeps {
  matters: Matter[];
  enquiries: Enquiry[];
  people: Person[];
  organisations: Organisation[];
  links?: PersonOrganisationLink[];
  canView: (matter: Matter) => boolean;
  canViewEnquiry: (enquiry: Enquiry) => boolean;
}

function redactMatchKeyHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function namesMatch(aLower: string, bLower: string): boolean {
  if (!aLower || !bLower) return false;
  return aLower === bLower || aLower.includes(bLower) || bLower.includes(aLower);
}

/**
 * Ensures all matter clients and matter parties are present in the conflict check party list
 * so a caller cannot omit a party from `conflictCheckRecord.parties` to evade server-side checks.
 */
export function buildEffectiveConflictParties(params: {
  submittedParties?: ConflictCheckParty[];
  clientId?: string | null;
  additionalClientIds?: string[];
  instructingContactId?: string | null;
  billingContactId?: string | null;
  matterParties?: MatterParty[];
  people: Person[];
  organisations: Organisation[];
}): ConflictCheckParty[] {
  const result: ConflictCheckParty[] = [...(params.submittedParties ?? [])];
  const hasPartyForRecord = (recordId: string | null | undefined, nameLower: string) =>
    result.some(
      (p) =>
        (recordId && p.linkedRecordId === recordId) ||
        (nameLower && p.name.trim().toLowerCase() === nameLower),
    );

  const resolveRecordNameAndType = (
    id: string,
  ): { name: string; entityType: 'person' | 'organisation' } | null => {
    const org = params.organisations.find((o) => o.id === id);
    if (org) return { name: org.legalName, entityType: 'organisation' };
    const person = params.people.find((p) => p.id === id);
    if (person) return { name: personDisplayName(person), entityType: 'person' };
    return null;
  };

  const clientIds = Array.from(
    new Set([params.clientId, ...(params.additionalClientIds ?? [])].filter(Boolean) as string[]),
  );
  clientIds.forEach((cid, idx) => {
    const info = resolveRecordNameAndType(cid);
    const name = info?.name ?? cid;
    if (!hasPartyForRecord(cid, name.trim().toLowerCase())) {
      result.push({
        id: idx === 0 ? 'cp-client-1' : `cp-client-${idx + 1}`,
        name,
        entityType: info?.entityType ?? (cid.startsWith('P-') ? 'person' : 'organisation'),
        role: idx === 0 ? 'Client' : 'Joint client',
        linkedRecordId: cid,
        isClientFixed: true,
      });
    }
  });

  if (params.instructingContactId) {
    const info = resolveRecordNameAndType(params.instructingContactId);
    if (info && !hasPartyForRecord(params.instructingContactId, info.name.trim().toLowerCase())) {
      result.push({
        id: 'cp-instructing-1',
        name: info.name,
        entityType: 'person',
        role: 'Client contact',
        linkedRecordId: params.instructingContactId,
        isClientFixed: true,
      });
    }
  }

  if (params.billingContactId) {
    const info = resolveRecordNameAndType(params.billingContactId);
    if (info && !hasPartyForRecord(params.billingContactId, info.name.trim().toLowerCase())) {
      result.push({
        id: 'cp-billing-1',
        name: info.name,
        entityType: 'person',
        role: 'Client contact',
        linkedRecordId: params.billingContactId,
        isClientFixed: true,
      });
    }
  }

  for (const mp of params.matterParties ?? []) {
    const nameLower = mp.name.trim().toLowerCase();
    if (!nameLower && !mp.linkedRecordId) continue;
    if (!hasPartyForRecord(mp.linkedRecordId, nameLower)) {
      result.push({
        id: mp.id || `cp-party-${result.length + 1}`,
        name: mp.name,
        entityType:
          mp.entityType ??
          (mp.linkedRecordId?.startsWith('P-') ? 'person' : 'organisation'),
        role: (mp.role as ConflictCheckParty['role']) || 'Opponent',
        linkedRecordId: mp.linkedRecordId ?? null,
      });
    }
  }

  return result;
}

/**
 * Pure server-side conflict search across all tenant matters, enquiries, people, organisations,
 * and person–organisation links.
 * When a match occurs on a matter that fails `deps.canView(m)`, returns a redacted match with
 * `restricted: true` and no matter number, client name, or partner name.
 */
export function searchMatterConflicts(
  input: MatterConflictSearchInput,
  deps: MatterConflictSearchDeps,
): ConflictCheckMatch[] {
  const prevById = new Map<string, ConflictCheckMatch>();
  const prevByKey = new Map<string, ConflictCheckMatch>();
  for (const m of input.previousMatches ?? []) {
    prevById.set(m.id, m);
    prevByKey.set(
      `${m.partyName.toLowerCase()}__${m.matchedRecordName.toLowerCase()}__${m.whereFound.toLowerCase()}`,
      m,
    );
  }

  const applyPreviousDecision = (
    base: ConflictCheckMatch,
    prev: ConflictCheckMatch | undefined,
  ): ConflictCheckMatch => {
    if (base.restricted) {
      return {
        ...base,
        disposition: 'potential_conflict',
        note: prev?.note ?? base.note,
        ...(input.canReviewConditions && prev?.reviewerDecision
          ? {
              reviewerDecision: prev.reviewerDecision,
              reviewerConditionType:
                prev.reviewerDecision === 'approve_with_conditions'
                  ? prev.reviewerConditionType ?? 'consent_obtained'
                  : null,
              reviewerNote: prev.reviewerNote,
              reviewedById: input.reviewerUserId ?? prev.reviewedById ?? null,
              reviewedByName: input.reviewerDisplayName ?? prev.reviewedByName ?? null,
              reviewedAt: input.reviewedAtIso ?? prev.reviewedAt ?? null,
            }
          : {}),
      };
    }
    if (!prev) return base;
    return {
      ...base,
      disposition: prev.disposition ?? base.disposition,
      note: prev.note ?? base.note,
      ...(input.canReviewConditions && prev.reviewerDecision
        ? {
            reviewerDecision: prev.reviewerDecision,
            reviewerConditionType:
              prev.reviewerDecision === 'approve_with_conditions'
                ? prev.reviewerConditionType ?? 'consent_obtained'
                : null,
            reviewerNote: prev.reviewerNote,
            reviewedById: input.reviewerUserId ?? prev.reviewedById ?? null,
            reviewedByName: input.reviewerDisplayName ?? prev.reviewedByName ?? null,
            reviewedAt: input.reviewedAtIso ?? prev.reviewedAt ?? null,
          }
        : {}),
    };
  };

  const generated: ConflictCheckMatch[] = [];
  const emittedIds = new Set<string>();
  const pushMatch = (match: ConflictCheckMatch, fallbackKey?: string) => {
    if (emittedIds.has(match.id)) return;
    emittedIds.add(match.id);
    const prev =
      prevById.get(match.id) ?? (fallbackKey ? prevByKey.get(fallbackKey) : undefined);
    generated.push(applyPreviousDecision(match, prev));
  };

  const resolveRecord = (
    id: string,
  ): { id: string; name: string; type: 'person' | 'organisation' } | null => {
    const org = deps.organisations.find((o) => o.id === id);
    if (org) return { id: org.id, name: org.legalName, type: 'organisation' };
    const person = deps.people.find((p) => p.id === id);
    if (person) return { id: person.id, name: personDisplayName(person), type: 'person' };
    return null;
  };

  for (const party of input.parties) {
    const lower = party.name.trim().toLowerCase();
    if (!lower && !party.linkedRecordId) continue;

    // 1. Check all matters in the tenant store (including restricted matters)
    for (const m of deps.matters) {
      if (input.currentMatterId && m.id === input.currentMatterId) continue;

      const allMatterClientIds = Array.from(
        new Set([m.clientId, ...(m.additionalClientIds ?? [])].filter(Boolean)),
      );
      let matchedClientRecord: {
        id: string;
        name: string;
        type: 'person' | 'organisation';
        exact: boolean;
      } | null = null;

      for (const cid of allMatterClientIds) {
        const cOrg = deps.organisations.find((o) => o.id === cid);
        const cPerson = deps.people.find((p) => p.id === cid);
        const cName = cOrg?.legalName || (cPerson ? personDisplayName(cPerson) : '');
        const cLower = cName.toLowerCase();
        const linkedMatch = Boolean(party.linkedRecordId && party.linkedRecordId === cid);
        const nameMatch = namesMatch(cLower, lower);
        if (linkedMatch || nameMatch) {
          matchedClientRecord = {
            id: cid,
            name: cName || cid,
            type: cPerson ? 'person' : 'organisation',
            exact: linkedMatch || (Boolean(cLower) && cLower === lower),
          };
          break;
        }
      }

      const matchingMatterParties = m.parties.filter((mp) => {
        const linkedMatch = Boolean(
          party.linkedRecordId && mp.linkedRecordId && party.linkedRecordId === mp.linkedRecordId,
        );
        const mpLower = mp.name.trim().toLowerCase();
        return linkedMatch || namesMatch(mpLower, lower);
      });

      const matchingMatterContacts: Array<{
        id: string;
        name: string;
        type: 'person' | 'organisation';
        exact: boolean;
        key: 'instructing' | 'billing';
        label: 'Instructing contact' | 'Billing contact';
      }> = [];
      const contactSlots: Array<{
        id: string | null | undefined;
        key: 'instructing' | 'billing';
        label: 'Instructing contact' | 'Billing contact';
      }> = [
        { id: m.instructingContactId, key: 'instructing', label: 'Instructing contact' },
        { id: m.billingContactId, key: 'billing', label: 'Billing contact' },
      ];
      for (const slot of contactSlots) {
        if (!slot.id) continue;
        const resolved = resolveRecord(slot.id);
        const cName = resolved?.name ?? '';
        const cLower = cName.toLowerCase();
        const linkedMatch = Boolean(party.linkedRecordId && party.linkedRecordId === slot.id);
        const nameMatch = namesMatch(cLower, lower);
        if (linkedMatch || nameMatch) {
          matchingMatterContacts.push({
            id: slot.id,
            name: cName || slot.id,
            type: resolved?.type ?? 'person',
            exact: linkedMatch || (Boolean(cLower) && cLower === lower),
            key: slot.key,
            label: slot.label,
          });
        }
      }

      const hasAnyMatchOnMatter =
        matchedClientRecord !== null ||
        matchingMatterParties.length > 0 ||
        matchingMatterContacts.length > 0;
      if (!hasAnyMatchOnMatter) continue;

      const isVisible = deps.canView(m);
      if (!isVisible) {
        // Redacted match for restricted matter (Rule 4 / R162)
        const exact =
          Boolean(matchedClientRecord?.exact) ||
          matchingMatterParties.some(
            (mp) =>
              (party.linkedRecordId && mp.linkedRecordId === party.linkedRecordId) ||
              mp.name.trim().toLowerCase() === lower,
          ) ||
          matchingMatterContacts.some((mc) => mc.exact);
        const redactedId = `match-restricted-${party.id}-${redactMatchKeyHash(`${party.id}:${m.id}`)}`;
        const fallbackKey = `${lower}__match on a restricted matter__restricted matter: refer to risk`;
        pushMatch(
          {
            id: redactedId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: '',
            matchedRecordName: 'Match on a restricted matter',
            matchedRecordType: 'matter',
            strength: exact ? 'Exact' : 'Close',
            whereFound: 'Restricted matter: refer to Risk',
            matterId: null,
            matterNumber: null,
            responsiblePartnerId: null,
            responsiblePartnerName: '',
            dateLabel: '',
            matchedOn: 'Restricted matter: refer to Risk',
            restricted: true,
            disposition: 'potential_conflict',
            note: 'Match on a restricted matter — must be referred to Risk & Compliance.',
          },
          fallbackKey,
        );
        continue;
      }

      const respPartner = deps.people.find((p) => p.id === m.responsiblePartnerId);
      const respPartnerName = respPartner ? personDisplayName(respPartner) : '';
      const dateLabel = formatDate(m.openedAt || m.createdAt) || '';

      if (matchedClientRecord && !party.isClientFixed) {
        const matchId = `match-${party.id}-${m.id}`;
        const whereFound = `Client on ${m.matterNumber} (${m.title})`;
        const fallbackKey = `${lower}__${matchedClientRecord.name.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: matchedClientRecord.id,
            matchedRecordName: matchedClientRecord.name,
            matchedRecordType: matchedClientRecord.type,
            strength: matchedClientRecord.exact ? 'Exact' : 'Close',
            whereFound,
            matterId: m.id,
            matterNumber: m.matterNumber,
            responsiblePartnerId: m.responsiblePartnerId || null,
            responsiblePartnerName: respPartnerName,
            dateLabel,
            matchedOn: matchedClientRecord.exact
              ? 'Exact client name on matter'
              : 'Similar client name on matter',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }

      for (const matchedParty of matchingMatterParties) {
        if (
          party.isClientFixed &&
          (matchedParty.role === 'Client' || matchedParty.role === 'Joint client') &&
          matchedParty.linkedRecordId &&
          matchedParty.linkedRecordId === party.linkedRecordId
        ) {
          continue;
        }
        const mpExact =
          Boolean(
            party.linkedRecordId &&
              matchedParty.linkedRecordId &&
              party.linkedRecordId === matchedParty.linkedRecordId,
          ) || matchedParty.name.trim().toLowerCase() === lower;
        const matchId = `match-${party.id}-${m.id}-${matchedParty.id}`;
        const whereFound = `${matchedParty.role} on ${m.matterNumber} (${m.title})`;
        const fallbackKey = `${lower}__${matchedParty.name.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: matchedParty.linkedRecordId ?? m.id,
            matchedRecordName: matchedParty.name,
            matchedRecordType:
              matchedParty.entityType === 'person' ? 'person' : 'organisation',
            strength: mpExact ? 'Exact' : 'Close',
            whereFound,
            matterId: m.id,
            matterNumber: m.matterNumber,
            responsiblePartnerId: m.responsiblePartnerId || null,
            responsiblePartnerName: respPartnerName,
            dateLabel,
            matchedOn: mpExact
              ? `Exact ${matchedParty.role.toLowerCase()} name on matter`
              : `Similar ${matchedParty.role.toLowerCase()} name on matter`,
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }

      const sameClientOnInput = allMatterClientIds.some((cid) =>
        input.parties.some(
          (ip) =>
            ip.isClientFixed &&
            (ip.role === 'Client' || ip.role === 'Joint client') &&
            ip.linkedRecordId === cid,
        ),
      );
      for (const mc of matchingMatterContacts) {
        if (
          party.isClientFixed &&
          party.role === 'Client contact' &&
          sameClientOnInput &&
          party.linkedRecordId === mc.id
        ) {
          continue;
        }
        const matchId = `match-${party.id}-${m.id}-${mc.key}`;
        const whereFound = `${mc.label} on ${m.matterNumber} (${m.title})`;
        const fallbackKey = `${lower}__${mc.name.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: mc.id,
            matchedRecordName: mc.name,
            matchedRecordType: mc.type,
            strength: mc.exact ? 'Exact' : 'Close',
            whereFound,
            matterId: m.id,
            matterNumber: m.matterNumber,
            responsiblePartnerId: m.responsiblePartnerId || null,
            responsiblePartnerName: respPartnerName,
            dateLabel,
            matchedOn: mc.exact
              ? `Exact ${mc.label.toLowerCase()} name on matter`
              : `Similar ${mc.label.toLowerCase()} name on matter`,
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }
    }

    // 1b. Check person–organisation links (B7)
    for (const link of deps.links ?? []) {
      if (link.isCurrent === false) continue;
      const linkPerson = deps.people.find(
        (p) => p.id === link.personId && !p.mergedIntoId && !p.demo,
      );
      const linkOrg = deps.organisations.find(
        (o) => o.id === link.organisationId && !o.mergedIntoId,
      );
      if (!linkPerson || !linkOrg) continue;

      const pName = personDisplayName(linkPerson);
      const pLower = pName.toLowerCase();
      const oName = linkOrg.legalName;
      const oLower = oName.toLowerCase();

      const personMatched =
        Boolean(party.linkedRecordId && party.linkedRecordId === linkPerson.id) ||
        namesMatch(pLower, lower);
      const orgMatched =
        !personMatched &&
        (Boolean(party.linkedRecordId && party.linkedRecordId === linkOrg.id) ||
          namesMatch(oLower, lower));
      if (!personMatched && !orgMatched) continue;

      const bothFixedInInput =
        input.parties.some((ip) => ip.isClientFixed && ip.linkedRecordId === linkPerson.id) &&
        input.parties.some((ip) => ip.isClientFixed && ip.linkedRecordId === linkOrg.id);

      const counterpartId = personMatched ? linkOrg.id : linkPerson.id;
      const counterpartName = personMatched ? oName : pName;
      const counterpartType: 'person' | 'organisation' = personMatched
        ? 'organisation'
        : 'person';
      const isExact = personMatched
        ? Boolean(party.linkedRecordId && party.linkedRecordId === linkPerson.id) ||
          pLower === lower
        : Boolean(party.linkedRecordId && party.linkedRecordId === linkOrg.id) ||
          oLower === lower;

      for (const m of deps.matters) {
        if (input.currentMatterId && m.id === input.currentMatterId) continue;
        const allMatterClientIds = [m.clientId, ...(m.additionalClientIds ?? [])].filter(Boolean);
        const counterpartOnMatter =
          allMatterClientIds.includes(counterpartId) ||
          m.instructingContactId === counterpartId ||
          m.billingContactId === counterpartId ||
          m.parties.some(
            (mp) =>
              mp.linkedRecordId === counterpartId ||
              namesMatch(mp.name.trim().toLowerCase(), counterpartName.toLowerCase()),
          );
        if (!counterpartOnMatter) continue;

        if (!deps.canView(m)) {
          const redactedId = `match-restricted-${party.id}-${redactMatchKeyHash(`${party.id}:${m.id}`)}`;
          const fallbackKey = `${lower}__match on a restricted matter__restricted matter: refer to risk`;
          pushMatch(
            {
              id: redactedId,
              partyId: party.id,
              partyName: party.name,
              matchedRecordId: '',
              matchedRecordName: 'Match on a restricted matter',
              matchedRecordType: 'matter',
              strength: isExact ? 'Exact' : 'Close',
              whereFound: 'Restricted matter: refer to Risk',
              matterId: null,
              matterNumber: null,
              responsiblePartnerId: null,
              responsiblePartnerName: '',
              dateLabel: '',
              matchedOn: 'Restricted matter: refer to Risk',
              restricted: true,
              disposition: 'potential_conflict',
              note: 'Match on a restricted matter — must be referred to Risk & Compliance.',
            },
            fallbackKey,
          );
          continue;
        }

        const sameClientOnMatter =
          (bothFixedInInput && allMatterClientIds.includes(linkOrg.id)) ||
          Boolean(
            party.isClientFixed &&
              (party.role === 'Client' || party.role === 'Joint client') &&
              party.linkedRecordId &&
              allMatterClientIds.includes(party.linkedRecordId) &&
              (m.instructingContactId === counterpartId ||
                m.billingContactId === counterpartId),
          );
        if (sameClientOnMatter) continue;

        const respPartner = deps.people.find((p) => p.id === m.responsiblePartnerId);
        const respPartnerName = respPartner ? personDisplayName(respPartner) : '';
        const dateLabel = formatDate(m.openedAt || m.createdAt) || '';
        const matchId = `match-${party.id}-link-${link.id}-${m.id}`;
        const whereFound = `Linked ${counterpartType} (${counterpartName}) on ${m.matterNumber} (${m.title})`;
        const fallbackKey = `${lower}__${counterpartName.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: counterpartId,
            matchedRecordName: counterpartName,
            matchedRecordType: counterpartType,
            strength: isExact ? 'Exact' : 'Close',
            whereFound,
            matterId: m.id,
            matterNumber: m.matterNumber,
            responsiblePartnerId: m.responsiblePartnerId || null,
            responsiblePartnerName: respPartnerName,
            dateLabel,
            matchedOn: 'Person–organisation link on matter',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }

      if (!bothFixedInInput) {
        const ownerPerson = deps.people.find(
          (p) =>
            p.id ===
            (personMatched
              ? linkOrg.relationshipPartnerId || linkOrg.recordOwnerId
              : linkPerson.relationshipOwnerId || linkPerson.recordOwnerId),
        );
        const ownerName = ownerPerson ? personDisplayName(ownerPerson) : '';
        const ownerId =
          ownerPerson?.id ??
          (personMatched
            ? linkOrg.relationshipPartnerId ?? linkOrg.recordOwnerId
            : linkPerson.relationshipOwnerId ?? linkPerson.recordOwnerId) ??
          null;
        const dateLabel = formatDate(link.startDate || linkOrg.createdAt) || '';
        const matchId = `match-${party.id}-link-${link.id}`;
        const whereFound = personMatched
          ? `Linked to ${oName} (${link.roleWithinOrganisation || 'Contact link'})`
          : `Linked person ${pName} at ${oName}`;
        const fallbackKey = `${lower}__${counterpartName.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: counterpartId,
            matchedRecordName: counterpartName,
            matchedRecordType: counterpartType,
            strength: isExact ? 'Exact' : 'Close',
            whereFound,
            matterId: null,
            matterNumber: null,
            responsiblePartnerId: ownerId,
            responsiblePartnerName: ownerName,
            dateLabel,
            matchedOn: 'Person–organisation link',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }
    }

    // 2. Check enquiries
    if (party.isClientFixed) {
      for (const enq of deps.enquiries) {
        if (enq.anonymisedAt) continue;
        if (input.sourceEnquiryId && enq.id === input.sourceEnquiryId) continue;
        const ownerPerson = deps.people.find(
          (p) => p.id === (enq.assignedToId ?? enq.takenById ?? enq.createdById),
        );
        const ownerName = ownerPerson ? personDisplayName(ownerPerson) : '';
        const ownerId =
          ownerPerson?.id ?? enq.assignedToId ?? enq.takenById ?? enq.createdById ?? null;
        const dateLabel = formatDate(enq.receivedAt || enq.createdAt) || '';

        const enqOtherEntries = (enq.otherPartiesNamed ?? '')
          .split(/[,;/\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const matchedOther = enqOtherEntries.find((op) =>
          namesMatch(op.toLowerCase(), lower),
        );
        if (matchedOther) {
          const isExact = matchedOther.toLowerCase() === lower;
          if (!deps.canViewEnquiry(enq)) {
            const redactedId = `match-restricted-enq-${party.id}-${redactMatchKeyHash(`${party.id}:${enq.id}`)}`;
            const fallbackKey = `${lower}__match on a restricted enquiry__restricted enquiry: refer to risk`;
            pushMatch(
              {
                id: redactedId,
                partyId: party.id,
                partyName: party.name,
                matchedRecordId: '',
                matchedRecordName: 'Match on a restricted enquiry',
                matchedRecordType: 'matter',
                strength: isExact ? 'Exact' : 'Close',
                whereFound: 'Restricted enquiry: refer to Risk',
                matterId: null,
                matterNumber: null,
                responsiblePartnerId: null,
                responsiblePartnerName: '',
                dateLabel: '',
                matchedOn: 'Restricted enquiry: refer to Risk',
                restricted: true,
                disposition: 'potential_conflict',
                note: 'Match on a restricted enquiry — must be referred to Risk & Compliance.',
              },
              fallbackKey,
            );
            continue;
          }
          const matchId = `match-client-enq-other-${party.id}-${enq.id}`;
          const whereFound = `Other party on Enquiry ${enq.reference} (${enq.summary})`;
          const fallbackKey = `${lower}__${matchedOther.toLowerCase()}__${whereFound.toLowerCase()}`;
          pushMatch(
            {
              id: matchId,
              partyId: party.id,
              partyName: party.name,
              matchedRecordId: enq.id,
              matchedRecordName: matchedOther,
              matchedRecordType: party.entityType,
              strength: isExact ? 'Exact' : 'Close',
              whereFound,
              matterId: null,
              matterNumber: enq.reference,
              responsiblePartnerId: ownerId,
              responsiblePartnerName: ownerName,
              dateLabel,
              matchedOn: isExact
                ? 'Prospective client named as other party on enquiry'
                : 'Similar name to other party on enquiry',
              disposition: null,
              note: '',
            },
            fallbackKey,
          );
        }
      }
      continue;
    }

    for (const enq of deps.enquiries) {
      if (enq.anonymisedAt) continue;
      if (input.sourceEnquiryId && enq.id === input.sourceEnquiryId) continue;
      const callerName = [enq.firstName, enq.lastName].filter(Boolean).join(' ').trim();
      const callerLower = callerName.toLowerCase();
      const behalfName = (enq.callingOnBehalfOf || '').trim();
      const behalfLower = behalfName.toLowerCase();
      const ownerPerson = deps.people.find(
        (p) => p.id === (enq.assignedToId ?? enq.takenById ?? enq.createdById),
      );
      const ownerName = ownerPerson ? personDisplayName(ownerPerson) : '';
      const ownerId =
        ownerPerson?.id ?? enq.assignedToId ?? enq.takenById ?? enq.createdById ?? null;
      const dateLabel = formatDate(enq.receivedAt || enq.createdAt) || '';

      const callerMatched = namesMatch(callerLower, lower);
      const behalfMatched = !callerMatched && namesMatch(behalfLower, lower);
      const enqOtherEntries =
        !callerMatched && !behalfMatched
          ? (enq.otherPartiesNamed ?? '')
              .split(/[,;/\n]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const matchedOther =
        !callerMatched && !behalfMatched
          ? enqOtherEntries.find((op) => namesMatch(op.toLowerCase(), lower))
          : undefined;

      if (!callerMatched && !behalfMatched && !matchedOther) continue;

      if (!deps.canViewEnquiry(enq)) {
        const isExact =
          (callerMatched && callerLower === lower) ||
          (behalfMatched && behalfLower === lower) ||
          (matchedOther !== undefined && matchedOther.toLowerCase() === lower);
        const redactedId = `match-restricted-enq-${party.id}-${redactMatchKeyHash(`${party.id}:${enq.id}`)}`;
        const fallbackKey = `${lower}__match on a restricted enquiry__restricted enquiry: refer to risk`;
        pushMatch(
          {
            id: redactedId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: '',
            matchedRecordName: 'Match on a restricted enquiry',
            matchedRecordType: 'matter',
            strength: isExact ? 'Exact' : 'Close',
            whereFound: 'Restricted enquiry: refer to Risk',
            matterId: null,
            matterNumber: null,
            responsiblePartnerId: null,
            responsiblePartnerName: '',
            dateLabel: '',
            matchedOn: 'Restricted enquiry: refer to Risk',
            restricted: true,
            disposition: 'potential_conflict',
            note: 'Match on a restricted enquiry — must be referred to Risk & Compliance.',
          },
          fallbackKey,
        );
        continue;
      }

      if (callerMatched) {
        const isExact = callerLower === lower;
        const matchId = `match-${party.id}-${enq.id}-caller`;
        const whereFound = `Enquirer on ${enq.reference} (${enq.summary})`;
        const fallbackKey = `${lower}__${callerLower}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: enq.linkedPersonId ?? enq.id,
            matchedRecordName: callerName,
            matchedRecordType: 'person',
            strength: isExact ? 'Exact' : 'Close',
            whereFound,
            matterId: null,
            matterNumber: enq.reference,
            responsiblePartnerId: ownerId,
            responsiblePartnerName: ownerName,
            dateLabel,
            matchedOn: isExact
              ? 'Exact enquirer name on enquiry'
              : 'Similar enquirer name on enquiry',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      } else if (behalfMatched) {
        const isExact = behalfLower === lower;
        const matchId = `match-${party.id}-${enq.id}-behalf`;
        const whereFound = `Prospective client on ${enq.reference} (${enq.summary})`;
        const fallbackKey = `${lower}__${behalfLower}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: enq.linkedOrganisationId ?? enq.id,
            matchedRecordName: behalfName,
            matchedRecordType: 'organisation',
            strength: isExact ? 'Exact' : 'Close',
            whereFound,
            matterId: null,
            matterNumber: enq.reference,
            responsiblePartnerId: ownerId,
            responsiblePartnerName: ownerName,
            dateLabel,
            matchedOn: isExact
              ? 'Exact organisation name on enquiry'
              : 'Similar organisation name on enquiry',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      } else if (matchedOther) {
        const isExact = matchedOther.toLowerCase() === lower;
        const matchId = `match-${party.id}-${enq.id}-other`;
        const whereFound = `Other party on ${enq.reference} (${enq.summary})`;
        const fallbackKey = `${lower}__${matchedOther.toLowerCase()}__${whereFound.toLowerCase()}`;
        pushMatch(
          {
            id: matchId,
            partyId: party.id,
            partyName: party.name,
            matchedRecordId: enq.id,
            matchedRecordName: matchedOther,
            matchedRecordType: party.entityType,
            strength: isExact ? 'Exact' : 'Close',
            whereFound,
            matterId: null,
            matterNumber: enq.reference,
            responsiblePartnerId: ownerId,
            responsiblePartnerName: ownerName,
            dateLabel,
            matchedOn: isExact
              ? 'Exact other party name on enquiry'
              : 'Similar other party name on enquiry',
            disposition: null,
            note: '',
          },
          fallbackKey,
        );
      }
    }

    // 3. Check standalone people and organisations if not already matched on a visible record
    const matchedPerson = deps.people.find((p) => {
      if (p.demo || p.mergedIntoId) return false;
      if (party.linkedRecordId && p.id === party.linkedRecordId) return true;
      const pName = personDisplayName(p).toLowerCase();
      return namesMatch(pName, lower);
    });
    if (
      matchedPerson &&
      !generated.some(
        (g) => g.partyId === party.id && g.matchedRecordId === matchedPerson.id,
      )
    ) {
      const pDisplay = personDisplayName(matchedPerson);
      const isExact =
        (party.linkedRecordId && matchedPerson.id === party.linkedRecordId) ||
        pDisplay.toLowerCase() === lower;
      const ownerPerson = deps.people.find(
        (p) =>
          p.id ===
          (matchedPerson.relationshipOwnerId || matchedPerson.recordOwnerId),
      );
      const ownerName = ownerPerson ? personDisplayName(ownerPerson) : '';
      const ownerId =
        ownerPerson?.id ??
        matchedPerson.relationshipOwnerId ??
        matchedPerson.recordOwnerId ??
        null;
      const dateLabel =
        formatDate(matchedPerson.firstKnownAt || matchedPerson.createdAt) || '';
      const matchId = `match-${party.id}-${matchedPerson.id}`;
      const whereFound = matchedPerson.isEmployee
        ? `Employee record (${matchedPerson.jobTitle || 'Staff'})`
        : 'Person directory record';
      const fallbackKey = `${lower}__${pDisplay.toLowerCase()}__${whereFound.toLowerCase()}`;
      pushMatch(
        {
          id: matchId,
          partyId: party.id,
          partyName: party.name,
          matchedRecordId: matchedPerson.id,
          matchedRecordName: pDisplay,
          matchedRecordType: 'person',
          strength: isExact ? 'Exact' : 'Close',
          whereFound,
          matterId: null,
          matterNumber: null,
          responsiblePartnerId: ownerId,
          responsiblePartnerName: ownerName,
          dateLabel,
          matchedOn: isExact
            ? 'Exact name match in People directory'
            : 'Partial name match in People directory',
          disposition: null,
          note: '',
        },
        fallbackKey,
      );
    }

    const matchedOrg = deps.organisations.find((o) => {
      if (o.mergedIntoId) return false;
      if (party.linkedRecordId && o.id === party.linkedRecordId) return true;
      const oLower = o.legalName.toLowerCase();
      return namesMatch(oLower, lower);
    });
    if (
      matchedOrg &&
      !generated.some(
        (g) => g.partyId === party.id && g.matchedRecordId === matchedOrg.id,
      )
    ) {
      const isExact =
        (party.linkedRecordId && matchedOrg.id === party.linkedRecordId) ||
        matchedOrg.legalName.toLowerCase() === lower;
      const ownerPerson = deps.people.find(
        (p) =>
          p.id === (matchedOrg.relationshipPartnerId || matchedOrg.recordOwnerId),
      );
      const ownerName = ownerPerson ? personDisplayName(ownerPerson) : '';
      const ownerId =
        ownerPerson?.id ??
        matchedOrg.relationshipPartnerId ??
        matchedOrg.recordOwnerId ??
        null;
      const dateLabel =
        formatDate(matchedOrg.relationshipStartedAt || matchedOrg.createdAt) || '';
      const matchId = `match-${party.id}-${matchedOrg.id}`;
      const whereFound = 'Organisation directory record';
      const fallbackKey = `${lower}__${matchedOrg.legalName.toLowerCase()}__${whereFound.toLowerCase()}`;
      pushMatch(
        {
          id: matchId,
          partyId: party.id,
          partyName: party.name,
          matchedRecordId: matchedOrg.id,
          matchedRecordName: matchedOrg.legalName,
          matchedRecordType: 'organisation',
          strength: isExact ? 'Exact' : 'Close',
          whereFound,
          matterId: null,
          matterNumber: null,
          responsiblePartnerId: ownerId,
          responsiblePartnerName: ownerName,
          dateLabel,
          matchedOn: isExact
            ? 'Exact legal name in Organisations directory'
            : 'Partial legal name in Organisations directory',
          disposition: null,
          note: '',
        },
        fallbackKey,
      );
    }
  }

  return generated;
}

/**
 * Reconciles server-computed conflict matches with client-submitted and previously stored matches:
 * - Server-computed matches are authoritative and cannot be omitted by the client.
 * - Restricted matches (`restricted: true`) always keep `disposition: 'potential_conflict'` and redacted fields.
 * - Reviewer fields (`reviewerDecision`, `reviewerConditionType`, `reviewerNote`) are accepted from
 *   `submittedMatches` only when `canReviewConditions` (`risk:view`) is true; otherwise only pre-existing
 *   reviewer decisions from `existingStoredMatches` are preserved.
 */
export function reconcileServerConflictMatches(params: {
  serverMatches: ConflictCheckMatch[];
  submittedMatches?: ConflictCheckMatch[];
  existingStoredMatches?: ConflictCheckMatch[];
  canReviewConditions: boolean;
  reviewerUserId?: string | null;
  reviewerDisplayName?: string | null;
  reviewedAtIso?: string | null;
}): ConflictCheckMatch[] {
  const storedById = new Map<string, ConflictCheckMatch>();
  for (const sm of params.existingStoredMatches ?? []) {
    storedById.set(sm.id, sm);
  }

  const reconciled: ConflictCheckMatch[] = params.serverMatches.map((m) => {
    const fixed: ConflictCheckMatch = m.restricted
      ? {
          ...m,
          matchedRecordId: '',
          matchedRecordName: m.matchedRecordName || 'Match on a restricted matter',
          matchedRecordType: 'matter',
          whereFound: m.whereFound || 'Restricted matter: refer to Risk',
          matterId: null,
          matterNumber: null,
          responsiblePartnerId: null,
          responsiblePartnerName: '',
          dateLabel: '',
          matchedOn: m.matchedOn || 'Restricted matter: refer to Risk',
          restricted: true,
          disposition: 'potential_conflict',
        }
      : { ...m };

    if (!params.canReviewConditions) {
      const prior = storedById.get(fixed.id);
      if (prior?.reviewerDecision) {
        fixed.reviewerDecision = prior.reviewerDecision;
        fixed.reviewerConditionType = prior.reviewerConditionType ?? null;
        fixed.reviewerNote = prior.reviewerNote;
        fixed.reviewedById = prior.reviewedById ?? null;
        fixed.reviewedByName = prior.reviewedByName ?? null;
        fixed.reviewedAt = prior.reviewedAt ?? null;
      } else {
        delete fixed.reviewerDecision;
        delete fixed.reviewerConditionType;
        delete fixed.reviewerNote;
        delete fixed.reviewedById;
        delete fixed.reviewedByName;
        delete fixed.reviewedAt;
      }
    }
    return fixed;
  });

  const seenIds = new Set(reconciled.map((m) => m.id));
  for (const sub of params.submittedMatches ?? []) {
    if (seenIds.has(sub.id)) continue;
    const prior = storedById.get(sub.id);
    if (!prior && !params.canReviewConditions) {
      continue;
    }
    seenIds.add(sub.id);
    const extra: ConflictCheckMatch = {
      ...sub,
      ...(params.canReviewConditions && sub.reviewerDecision
        ? {
            reviewerDecision: sub.reviewerDecision,
            reviewerConditionType:
              sub.reviewerDecision === 'approve_with_conditions'
                ? sub.reviewerConditionType ?? 'consent_obtained'
                : null,
            reviewerNote: sub.reviewerNote,
            reviewedById: params.reviewerUserId ?? sub.reviewedById ?? null,
            reviewedByName: params.reviewerDisplayName ?? sub.reviewedByName ?? null,
            reviewedAt: params.reviewedAtIso ?? sub.reviewedAt ?? null,
          }
        : prior?.reviewerDecision
          ? {
              reviewerDecision: prior.reviewerDecision,
              reviewerConditionType: prior.reviewerConditionType ?? null,
              reviewerNote: prior.reviewerNote,
              reviewedById: prior.reviewedById ?? null,
              reviewedByName: prior.reviewedByName ?? null,
              reviewedAt: prior.reviewedAt ?? null,
            }
          : {
              reviewerDecision: undefined,
              reviewerConditionType: undefined,
              reviewerNote: undefined,
              reviewedById: undefined,
              reviewedByName: undefined,
              reviewedAt: undefined,
            }),
    };
    reconciled.push(extra);
  }

  return reconciled;
}

export function hasUnapprovedRestrictedMatches(
  matches: readonly ConflictCheckMatch[],
  approvedIds: Iterable<string> | undefined | null,
): boolean {
  const approved = new Set(approvedIds ?? []);
  return matches.some((m) => m.restricted && !approved.has(m.id));
}
