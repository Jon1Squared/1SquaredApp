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
  tenantId: string;
  canView: (matter: Matter) => boolean;
  canViewEnquiry: (enquiry: Enquiry) => boolean;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Returns the first 16 lowercase hex characters of SHA-256 over `${tenantId}:${recordId}`.
 * Uses standard FIPS 180-4 SHA-256 so it produces identical results to `node:crypto`
 * `createHash('sha256')` while remaining safe for client-bundled domain modules (R290).
 */
export function redactRecordId(tenantId: string, recordId: string): string {
  const bytes = new TextEncoder().encode(`${tenantId}:${recordId}`);
  const bitLen = bytes.length * 8;
  const totalLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    (h0 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  );
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

  const personById = new Map<string, Person>();
  for (const p of deps.people) {
    personById.set(p.id, p);
  }
  const orgById = new Map<string, Organisation>();
  for (const o of deps.organisations) {
    orgById.set(o.id, o);
  }

  const resolveRecord = (
    id: string,
  ): { id: string; name: string; type: 'person' | 'organisation' } | null => {
    const org = orgById.get(id);
    if (org) return { id: org.id, name: org.legalName, type: 'organisation' };
    const person = personById.get(id);
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
        const cOrg = orgById.get(cid);
        const cPerson = personById.get(cid);
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
        const redactedId = `match-restricted-${party.id}-${redactRecordId(deps.tenantId, `${party.id}:${m.id}`)}`;
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

      const respPartner = m.responsiblePartnerId
        ? personById.get(m.responsiblePartnerId)
        : undefined;
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

    // 1b. Check person–organisation links (B7, R259: pre-indexed maps)
    for (const link of deps.links ?? []) {
      if (link.isCurrent === false) continue;
      const linkPerson = personById.get(link.personId);
      if (!linkPerson || linkPerson.mergedIntoId || linkPerson.demo) continue;
      const linkOrg = orgById.get(link.organisationId);
      if (!linkOrg || linkOrg.mergedIntoId) continue;

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
      const counterpartLower = counterpartName.toLowerCase();
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
              namesMatch(mp.name.trim().toLowerCase(), counterpartLower),
          );
        if (!counterpartOnMatter) continue;

        if (!deps.canView(m)) {
          const redactedId = `match-restricted-${party.id}-${redactRecordId(deps.tenantId, `${party.id}:${m.id}`)}`;
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

        const respPartner = m.responsiblePartnerId
          ? personById.get(m.responsiblePartnerId)
          : undefined;
        const respPartnerName = respPartner ? personDisplayName(respPartner) : '';
        const dateLabel = formatDate(m.openedAt || m.createdAt) || '';
        const matchId = `match-${party.id}-link-${link.id}-${m.id}`;
        const whereFound = `Linked ${counterpartType} (${counterpartName}) on ${m.matterNumber} (${m.title})`;
        const fallbackKey = `${lower}__${counterpartLower}__${whereFound.toLowerCase()}`;
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
        const ownerCandidateId = personMatched
          ? linkOrg.relationshipPartnerId || linkOrg.recordOwnerId
          : linkPerson.relationshipOwnerId || linkPerson.recordOwnerId;
        const ownerPerson = ownerCandidateId ? personById.get(ownerCandidateId) : undefined;
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
        const fallbackKey = `${lower}__${counterpartLower}__${whereFound.toLowerCase()}`;
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
            const redactedId = `match-restricted-enq-${party.id}-${redactRecordId(deps.tenantId, `${party.id}:${enq.id}`)}`;
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
        const redactedId = `match-restricted-enq-${party.id}-${redactRecordId(deps.tenantId, `${party.id}:${enq.id}`)}`;
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

/**
 * Normalises a list of non-blocking conflict warnings returned by `prepareEnquiryConversion`
 * or `prepareQuoteConversionRecord`, stripping blanks and duplicates.
 */
export function normaliseConversionConflictWarnings(
  conflictWarnings: readonly string[] | string | undefined | null,
): string[] {
  if (!conflictWarnings) return [];
  const rawList = Array.isArray(conflictWarnings)
    ? conflictWarnings
    : [conflictWarnings];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Turns non-blocking conversion `conflictWarnings` into a single plain-English notice string
 * for toast notifications and the new-matter conversion warning banner (R311).
 * Returns `null` when there are no warnings.
 */
export function formatConversionConflictWarningsNotice(
  conflictWarnings: readonly string[] | string | undefined | null,
): string | null {
  const warnings = normaliseConversionConflictWarnings(conflictWarnings);
  if (warnings.length === 0) return null;
  return `Conflict warning: ${warnings.join(' · ')}`;
}

