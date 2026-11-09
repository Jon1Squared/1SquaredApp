'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Link2, Plus, Search, Trash2, User, X } from 'lucide-react';
import { reviseQuoteAction, saveQuoteAction } from '@/app/actions';
import { addDays, toIsoDate } from '@/domain/dates';
import {
  detectPreliminaryConflicts,
  enquiryDisplayName,
  findEnquiryEntityMatches,
  hasQuickConflictCheckInputs,
  isEnquiryOpen,
  mergePeopleWithEnquiries,
} from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { personDisplayName, primaryEmail, primaryPhone } from '@/domain/names';
import {
  allowedNameEdits,
  editDistance,
  normaliseComparableName,
  organisationNameLooseMatch,
  personNameLooseMatch,
  tokensSoundAlike,
} from '@/domain/normalise';
import {
  calculateQuoteTotals,
  formatGbp,
  QUOTE_FEE_BASES,
  roundCurrency,
} from '@/domain/quotes';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  PersonOrganisationLink,
  Quote,
  QuoteDisbursement,
  QuoteFeeBasis,
} from '@/domain/types';
import { InfoPopover } from './InfoPopover';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  mode: 'new' | 'edit' | 'revise';
  existing?: Quote | null;
  initialEnquiry?: Enquiry | null;
  enquiries: Enquiry[];
  matters?: Matter[];
  people: Person[];
  organisations: Organisation[];
  links?: PersonOrganisationLink[];
  values: ChoiceValue[];
  currentUserId: string;
  tenantId: string;
  onCancelOverride?: () => void;
  onSuccessOverride?: (quote: Quote) => void;
}

function splitFullName(fullName: string): { firstName: string; surname: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: '', surname: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], surname: '' };
  return {
    firstName: parts[0],
    surname: parts.slice(1).join(' '),
  };
}

export function QuoteFormClient({
  mode,
  existing = null,
  initialEnquiry = null,
  enquiries,
  matters = [],
  people,
  organisations,
  links = [],
  values,
  currentUserId,
  tenantId,
  onCancelOverride,
  onSuccessOverride,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const defaultValidUntil = useMemo(() => toIsoDate(addDays(new Date(), 30)), []);

  const [linkedOrganisationId, setLinkedOrganisationId] = useState<string | null>(
    () => existing?.linkedOrganisationId ?? initialEnquiry?.linkedOrganisationId ?? null,
  );
  const [linkedPersonId, setLinkedPersonId] = useState<string | null>(
    () => existing?.linkedPersonId ?? initialEnquiry?.linkedPersonId ?? null,
  );

  const initialSplitName = useMemo(() => {
    if (existing) {
      if (existing.prospectName.trim()) {
        return splitFullName(existing.prospectName);
      }
      if (existing.linkedPersonId) {
        const linkedP =
          people.find((p) => p.id === existing.linkedPersonId) ??
          enquiries.find((e) => e.id === existing.linkedPersonId);
        if (linkedP) {
          return {
            firstName: linkedP.firstName,
            surname: 'surname' in linkedP ? linkedP.surname : linkedP.lastName,
          };
        }
      }
      return { firstName: '', surname: '' };
    }
    if (initialEnquiry) {
      return {
        firstName: initialEnquiry.firstName || '',
        surname: initialEnquiry.lastName || '',
      };
    }
    return { firstName: '', surname: '' };
  }, [existing, initialEnquiry, people]);

  const [firstName, setFirstName] = useState<string>(() => initialSplitName.firstName);
  const [surname, setSurname] = useState<string>(() => initialSplitName.surname);

  const [prospectOrganisationName, setProspectOrganisationName] = useState<string>(() => {
    if (existing) {
      if (existing.prospectOrganisationName.trim()) {
        return existing.prospectOrganisationName;
      }
      if (existing.linkedOrganisationId) {
        const linkedO = organisations.find((o) => o.id === existing.linkedOrganisationId);
        if (linkedO) return linkedO.legalName;
      }
      return '';
    }
    if (initialEnquiry) return initialEnquiry.callingOnBehalfOf || '';
    return '';
  });

  const [prospectEmail, setProspectEmail] = useState<string>(() => {
    if (existing) return existing.prospectEmail;
    if (initialEnquiry) return initialEnquiry.email || '';
    return '';
  });
  const [prospectPhone, setProspectPhone] = useState<string>(() => {
    if (existing) return existing.prospectPhone;
    if (initialEnquiry) return initialEnquiry.phone || '';
    return '';
  });

  // Track whether the inline existing-contacts search table is open while typing
  const [contactSearchDismissed, setContactSearchDismissed] = useState<boolean>(
    () => Boolean(existing || initialEnquiry),
  );

  // Linked enquiry (hidden by default unless an enquiry is linked or user clicks "Link Enquiry")
  const [linkedEnquiryId, setLinkedEnquiryId] = useState<string | null>(
    () => existing?.linkedEnquiryId ?? initialEnquiry?.id ?? null,
  );
  const [showLinkedEnquiry, setShowLinkedEnquiry] = useState<boolean>(() =>
    Boolean(existing?.linkedEnquiryId || initialEnquiry?.id),
  );
  const [enquirySearch, setEnquirySearch] = useState('');
  const [showAllEnquiriesInDropdown, setShowAllEnquiriesInDropdown] = useState(false);

  // Work type & scope
  const allWorkTypes = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => v.active),
    [values],
  );
  const practiceAreas = useMemo(
    () => allWorkTypes.filter((v) => !v.parentId),
    [allWorkTypes],
  );

  const [practiceAreaId, setPracticeAreaId] = useState<string>(() => {
    if (existing?.practiceAreaId) return existing.practiceAreaId;
    if (initialEnquiry?.practiceAreaId) return initialEnquiry.practiceAreaId;
    return practiceAreas[0]?.id ?? '';
  });

  const subcategories = useMemo(
    () => allWorkTypes.filter((v) => v.parentId === practiceAreaId),
    [allWorkTypes, practiceAreaId],
  );

  const [workTypeSubcategoryId, setWorkTypeSubcategoryId] = useState<string>(() => {
    if (existing?.workTypeSubcategoryId) return existing.workTypeSubcategoryId;
    if (initialEnquiry?.workTypeSubcategoryId) return initialEnquiry.workTypeSubcategoryId;
    return '';
  });

  const [scope, setScope] = useState<string>(() => {
    if (existing) return existing.scope;
    if (initialEnquiry) {
      return [initialEnquiry.summary, initialEnquiry.notes].filter(Boolean).join('\n\n');
    }
    return '';
  });

  const [assumptions, setAssumptions] = useState<string>(() => existing?.assumptions ?? '');

  // Fee & financials
  const [feeBasis, setFeeBasis] = useState<QuoteFeeBasis>(
    () => existing?.feeBasis ?? 'Fixed fee',
  );
  const [feeAmountStr, setFeeAmountStr] = useState<string>(() =>
    existing ? String(existing.feeAmountExVat) : '',
  );
  const [hourlyRateStr, setHourlyRateStr] = useState<string>(() => {
    if (existing?.hourlyRateGbp) return String(existing.hourlyRateGbp);
    const currentEmp = people.find((p) => p.id === (existing?.feeEarnerId ?? currentUserId));
    const rate = currentEmp?.employment?.feeEarner?.chargeOutRateGbp ?? null;
    return rate ? String(rate) : '320';
  });

  const feeAmountNum = useMemo(
    () => roundCurrency(Math.max(0, Number(feeAmountStr) || 0)),
    [feeAmountStr],
  );

  const [vatOverridden, setVatOverridden] = useState<boolean>(
    () => Boolean(existing?.vatOverridden),
  );
  const [vatInputStr, setVatInputStr] = useState<string>(() =>
    existing ? String(existing.vatAmount) : '0',
  );

  const effectiveVatOnFee = useMemo(() => {
    if (vatOverridden) {
      return roundCurrency(Math.max(0, Number(vatInputStr) || 0));
    }
    return roundCurrency(feeAmountNum * 0.2);
  }, [feeAmountNum, vatOverridden, vatInputStr]);

  const [disbursements, setDisbursements] = useState<QuoteDisbursement[]>(() =>
    existing?.disbursements?.length
      ? existing.disbursements.map((d) => ({ ...d }))
      : [],
  );

  const totals = useMemo(
    () => calculateQuoteTotals(feeAmountNum, effectiveVatOnFee, disbursements),
    [feeAmountNum, effectiveVatOnFee, disbursements],
  );

  // Dates & ownership
  const [validUntil, setValidUntil] = useState<string>(
    () =>
      mode === 'revise'
        ? defaultValidUntil
        : existing?.validUntil ?? defaultValidUntil,
  );
  const [feeEarnerId, setFeeEarnerId] = useState<string>(
    () =>
      existing?.feeEarnerId ??
      initialEnquiry?.assignedToId ??
      currentUserId,
  );
  const [followUpAfterDaysStr, setFollowUpAfterDaysStr] = useState<string>(
    () => String(existing?.followUpAfterDays ?? 7),
  );
  const [revisionNote, setRevisionNote] = useState('');

  const feeEarners = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId && !p.demo)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const mergedPeople = useMemo(
    () => mergePeopleWithEnquiries(people, enquiries, values),
    [people, enquiries, values],
  );

  // Same contact search as "Add client" on the New Matter screen (First name, Surname, Organisation)
  const hasContactSearchQuery = Boolean(
    firstName.trim() || surname.trim() || prospectOrganisationName.trim(),
  );

  const contactLookupResults = useMemo(() => {
    const fnRaw = firstName.trim();
    const snRaw = surname.trim();
    const orgRaw = prospectOrganisationName.trim();
    if (!fnRaw && !snRaw && !orgRaw) {
      return [];
    }

    const fn = normaliseComparableName(fnRaw);
    const sn = normaliseComparableName(snRaw);
    const orgQ = normaliseComparableName(orgRaw);

    const checkTokenMatch = (
      queryVal: string,
      candidates: string[],
    ): 'exact' | 'similar spelling' | 'sounds like' | null => {
      const qTokens = normaliseComparableName(queryVal).split(' ').filter(Boolean);
      if (qTokens.length === 0) return null;

      let best: 'exact' | 'similar spelling' | 'sounds like' | null = null;
      for (const cand of candidates) {
        const cNorm = normaliseComparableName(cand);
        if (!cNorm) continue;
        if (cNorm.includes(normaliseComparableName(queryVal))) {
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
            const maxEdits = minLen >= 4 ? allowedNameEdits(minLen) : minLen === 3 ? 1 : 0;
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
    };

    const results: {
      id: string;
      entityType: 'person' | 'organisation';
      name: string;
      organisationName: string;
      details: string;
      matchNote: 'similar spelling' | 'sounds like' | null;
      rank: number;
      person?: Person;
      organisation?: Organisation;
      linkedOrgs?: Organisation[];
    }[] = [];

    // 1. Search People (including people saved in enquiries)
    for (const p of mergedPeople) {
      if (p.mergedIntoId || p.demo) continue;
      const personLinks = links.filter((l) => l.personId === p.id && l.isCurrent);
      const linkedOrgs = personLinks
        .map((l) => organisations.find((o) => o.id === l.organisationId))
        .filter((o): o is Organisation => Boolean(o));
      const orgNames = linkedOrgs.map((o) => o.legalName).join(', ');

      let matchNote: 'similar spelling' | 'sounds like' | null = null;

      if (fn) {
        const fnRes = checkTokenMatch(fn, [
          p.firstName,
          p.preferredName ?? '',
          ...p.otherNames.map((n) => n.name),
        ]);
        if (!fnRes) continue;
        if (fnRes !== 'exact') matchNote = fnRes;
      }

      if (sn) {
        const snRes = checkTokenMatch(sn, [
          p.surname,
          ...p.otherNames.map((n) => n.name),
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
          ...o.otherNames.map((n) => n.name),
        ]);
        const orgRes = checkTokenMatch(orgQ, orgCandidates);
        const looseOrg = linkedOrgs
          .map((o) => organisationNameLooseMatch(orgRaw, o.legalName))
          .find(Boolean);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact' && !matchNote) matchNote = orgRes;
        else if (!orgRes && looseOrg && !matchNote) matchNote = looseOrg;
      }

      const email =
        p.emails.find((e) => e.isPrimary)?.address ?? p.emails[0]?.address ?? null;
      results.push({
        id: p.id,
        entityType: 'person',
        name: personDisplayName(p),
        organisationName: orgNames || '—',
        details: [p.jobTitle || null, email, p.addresses[0]?.town ?? null]
          .filter(Boolean)
          .join(' · '),
        matchNote,
        rank: matchNote ? 2 : 1,
        person: p,
        linkedOrgs,
      });
    }

    // 2. Search Organisations
    for (const o of organisations) {
      if (o.mergedIntoId) continue;
      const orgCandidates = [o.legalName, ...o.otherNames.map((n) => n.name)];
      let matchNote: 'similar spelling' | 'sounds like' | null = null;

      if (orgQ) {
        const orgRes = checkTokenMatch(orgQ, orgCandidates);
        const looseOrg = organisationNameLooseMatch(orgRaw, o.legalName);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact') matchNote = orgRes;
        else if (!orgRes && looseOrg) matchNote = looseOrg;
      } else if (fn || sn) {
        const combinedQuery = [fnRaw, snRaw].filter(Boolean).join(' ');
        const orgRes = checkTokenMatch(combinedQuery, orgCandidates);
        const looseOrg = organisationNameLooseMatch(combinedQuery, o.legalName);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact') matchNote = orgRes;
        else if (!orgRes && looseOrg) matchNote = looseOrg;
      }

      results.push({
        id: o.id,
        entityType: 'organisation',
        name: o.legalName,
        organisationName: o.legalName,
        details: [
          o.companyNumber ? `Co. no. ${o.companyNumber}` : null,
          o.registeredAddress?.town ?? null,
          o.generalEmail || null,
        ]
          .filter(Boolean)
          .join(' · '),
        matchNote,
        rank: matchNote ? 2 : 1,
        organisation: o,
      });
    }

    return results.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }, [firstName, surname, prospectOrganisationName, mergedPeople, organisations, links]);

  // Helper to find active (open) enquiries linked to a given person and/or organisation
  const getActiveEnquiriesForContact = (
    pId: string | null,
    oId: string | null,
    personObj?: Person | null,
    orgObj?: Organisation | null,
  ): Enquiry[] => {
    const pNorm = personObj
      ? normaliseComparableName(`${personObj.firstName} ${personObj.surname}`)
      : '';
    const oNorm = orgObj ? normaliseComparableName(orgObj.legalName) : '';

    return enquiries.filter((e) => {
      if (!isEnquiryOpen(e)) return false;
      if (pId && (e.linkedPersonId === pId || e.id === pId)) return true;
      if (oId && e.linkedOrganisationId === oId) return true;
      if (pNorm) {
        const enqName = normaliseComparableName(`${e.firstName} ${e.lastName}`);
        if (enqName && enqName === pNorm) return true;
      }
      if (oNorm && e.callingOnBehalfOf) {
        const enqOrg = normaliseComparableName(e.callingOnBehalfOf);
        if (enqOrg && enqOrg === oNorm) return true;
      }
      return false;
    });
  };

  // Active enquiries for currently linked person / organisation
  const activeEnquiriesForLinkedContact = useMemo(() => {
    if (!linkedPersonId && !linkedOrganisationId) return [];
    const pObj = linkedPersonId ? mergedPeople.find((p) => p.id === linkedPersonId) : null;
    const oObj = linkedOrganisationId
      ? organisations.find((o) => o.id === linkedOrganisationId)
      : null;
    return getActiveEnquiriesForContact(linkedPersonId, linkedOrganisationId, pObj, oObj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedPersonId, linkedOrganisationId, mergedPeople, organisations, enquiries]);

  // Live Quick Conflict Check & Entity Matching (matching Enquiry & Person screens)
  const liveEntityMatches = useMemo(
    () =>
      findEnquiryEntityMatches(
        {
          firstName,
          lastName: surname,
          email: prospectEmail,
          phone: prospectPhone,
          callingOnBehalfOf: prospectOrganisationName,
          postcode: '',
          addressLine1: '',
          addressLine2: '',
          otherPartiesNamed: '',
        },
        mergedPeople,
        organisations,
        enquiries,
      ),
    [firstName, surname, prospectEmail, prospectPhone, prospectOrganisationName, mergedPeople, organisations, enquiries],
  );

  const possibleConflicts = useMemo(
    () =>
      detectPreliminaryConflicts(
        {
          firstName,
          lastName: surname,
          callingOnBehalfOf: prospectOrganisationName,
          otherPartiesNamed: '',
          email: prospectEmail,
          phone: prospectPhone,
          address: { line1: '', line2: '', postcode: '' },
          linkedPersonId,
          linkedOrganisationId,
        },
        mergedPeople,
        organisations,
        matters,
        values,
        enquiries,
        null,
        links,
        undefined,
        tenantId,
      ),
    [
      firstName,
      surname,
      prospectOrganisationName,
      prospectEmail,
      prospectPhone,
      linkedPersonId,
      linkedOrganisationId,
      mergedPeople,
      organisations,
      matters,
      values,
      enquiries,
      links,
      tenantId,
    ],
  );

  const conflictKeys = useMemo(
    () => new Set(possibleConflicts.map((h) => `${h.recordType}:${h.recordId}`)),
    [possibleConflicts],
  );

  const entityReasonsByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of liveEntityMatches.people) map.set(`person:${m.person.id}`, m.formattedReasons);
    for (const m of liveEntityMatches.organisations) {
      map.set(`organisation:${m.organisation.id}`, m.formattedReasons);
    }
    return map;
  }, [liveEntityMatches]);

  const knownPeople = useMemo(
    () => liveEntityMatches.people.filter((m) => !conflictKeys.has(`person:${m.person.id}`)),
    [liveEntityMatches, conflictKeys],
  );

  const knownOrganisations = useMemo(
    () =>
      liveEntityMatches.organisations.filter(
        (m) => !conflictKeys.has(`organisation:${m.organisation.id}`),
      ),
    [liveEntityMatches, conflictKeys],
  );

  const hasSearchInputs = useMemo(
    () =>
      hasQuickConflictCheckInputs({
        firstName,
        lastName: surname,
        callingOnBehalfOf: prospectOrganisationName,
        otherPartiesNamed: '',
        email: prospectEmail,
        phone: prospectPhone,
        postcode: '',
      }),
    [firstName, surname, prospectOrganisationName, prospectEmail, prospectPhone],
  );

  const hasHighSeverityConflict = useMemo(
    () => possibleConflicts.some((h) => h.severity === 'high' || h.blocking),
    [possibleConflicts],
  );

  const distinctMatchedCount = conflictKeys.size + knownPeople.length + knownOrganisations.length;

  const handleSelectEnquiry = (enqId: string, skipContactFill = false) => {
    const nextId = enqId || null;
    setLinkedEnquiryId(nextId);
    if (!nextId) return;
    const enq = enquiries.find((e) => e.id === nextId);
    if (!enq) return;

    if (!skipContactFill) {
      if (!firstName.trim() && enq.firstName) {
        setFirstName(enq.firstName);
      }
      if (!surname.trim() && enq.lastName) {
        setSurname(enq.lastName);
      }
      if (!prospectOrganisationName.trim() && enq.callingOnBehalfOf) {
        setProspectOrganisationName(enq.callingOnBehalfOf);
      }
      if (!prospectEmail.trim() && enq.email) {
        setProspectEmail(enq.email);
      }
      if (!prospectPhone.trim() && enq.phone) {
        setProspectPhone(enq.phone);
      }
      if (enq.linkedOrganisationId) setLinkedOrganisationId(enq.linkedOrganisationId);
      if (enq.linkedPersonId) setLinkedPersonId(enq.linkedPersonId);
    }

    if (enq.practiceAreaId) {
      setPracticeAreaId(enq.practiceAreaId);
    }
    if (enq.workTypeSubcategoryId) {
      setWorkTypeSubcategoryId(enq.workTypeSubcategoryId);
    }
    if (!scope.trim() && enq.summary) {
      setScope([enq.summary, enq.notes].filter(Boolean).join('\n\n'));
    }
    if (enq.assignedToId) {
      setFeeEarnerId(enq.assignedToId);
    }
  };

  const applyAutoEnquirySelectionForContact = (
    pId: string | null,
    oId: string | null,
    personObj?: Person | null,
    orgObj?: Organisation | null,
  ) => {
    const activeEnqs = getActiveEnquiriesForContact(pId, oId, personObj, orgObj);
    if (activeEnqs.length === 1) {
      setShowLinkedEnquiry(true);
      setShowAllEnquiriesInDropdown(false);
      handleSelectEnquiry(activeEnqs[0].id, true);
    } else if (activeEnqs.length > 1) {
      setShowLinkedEnquiry(true);
      setShowAllEnquiriesInDropdown(false);
    }
  };

  const linkExistingPerson = (p: Person, linkedOrgsForPerson?: Organisation[]) => {
    setLinkedPersonId(p.id);
    setFirstName(p.firstName);
    setSurname(p.surname);
    const pEmail = primaryEmail(p);
    const pPhone = primaryPhone(p);
    if (pEmail) setProspectEmail(pEmail);
    if (pPhone) setProspectPhone(pPhone);

    const orgsList =
      linkedOrgsForPerson ??
      links
        .filter((l) => l.personId === p.id && l.isCurrent)
        .map((l) => organisations.find((o) => o.id === l.organisationId))
        .filter((o): o is Organisation => Boolean(o));

    let nextOrgId = linkedOrganisationId;
    let nextOrgObj: Organisation | null = linkedOrganisationId
      ? organisations.find((o) => o.id === linkedOrganisationId) ?? null
      : null;

    if (orgsList.length > 0 && !prospectOrganisationName.trim()) {
      setProspectOrganisationName(orgsList[0].legalName);
      setLinkedOrganisationId(orgsList[0].id);
      nextOrgId = orgsList[0].id;
      nextOrgObj = orgsList[0];
    } else if (p.id.startsWith('ENQ-') && !prospectOrganisationName.trim()) {
      const matchedEnq = enquiries.find((e) => e.id === p.id);
      if (matchedEnq?.callingOnBehalfOf.trim()) {
        setProspectOrganisationName(matchedEnq.callingOnBehalfOf.trim());
        if (matchedEnq.linkedOrganisationId) {
          setLinkedOrganisationId(matchedEnq.linkedOrganisationId);
          nextOrgId = matchedEnq.linkedOrganisationId;
          nextOrgObj =
            organisations.find((o) => o.id === matchedEnq.linkedOrganisationId) ?? null;
        }
      }
    }

    setContactSearchDismissed(true);
    applyAutoEnquirySelectionForContact(p.id, nextOrgId, p, nextOrgObj);
    showToast(`Linked quote to ${personDisplayName(p)} (${p.id})`);
  };

  const linkExistingOrg = (o: Organisation) => {
    setLinkedOrganisationId(o.id);
    setProspectOrganisationName(o.legalName);
    if (!prospectEmail.trim() && o.generalEmail) setProspectEmail(o.generalEmail);
    if (!prospectPhone.trim() && o.mainPhone) setProspectPhone(o.mainPhone);
    setContactSearchDismissed(true);
    const pObj = linkedPersonId ? mergedPeople.find((p) => p.id === linkedPersonId) ?? null : null;
    applyAutoEnquirySelectionForContact(linkedPersonId, o.id, pObj, o);
    showToast(`Linked quote to ${o.legalName} (${o.id})`);
  };

  const filteredEnquiries = useMemo(() => {
    const q = enquirySearch.trim().toLowerCase();
    const basePool =
      activeEnquiriesForLinkedContact.length > 0 && !showAllEnquiriesInDropdown && !q
        ? activeEnquiriesForLinkedContact
        : enquiries;
    const list = basePool.filter((e) => {
      if (!q) return true;
      const hay = `${e.reference} ${e.firstName} ${e.lastName} ${e.callingOnBehalfOf} ${e.summary}`.toLowerCase();
      return hay.includes(q);
    });
    // Ensure currently selected linkedEnquiryId is always present in options
    if (linkedEnquiryId && !list.some((e) => e.id === linkedEnquiryId)) {
      const sel = enquiries.find((e) => e.id === linkedEnquiryId);
      if (sel) return [sel, ...list];
    }
    return list;
  }, [
    enquiries,
    enquirySearch,
    activeEnquiriesForLinkedContact,
    showAllEnquiriesInDropdown,
    linkedEnquiryId,
  ]);

  const handleAddDisbursement = () => {
    setDisbursements((prev) => [
      ...prev,
      {
        id: `QDISB-${Date.now()}-${prev.length + 1}`,
        description: '',
        amountExVat: 0,
        vatApplicable: false,
      },
    ]);
  };

  const handleUpdateDisbursement = (
    idx: number,
    patch: Partial<QuoteDisbursement>,
  ) => {
    setDisbursements((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  };

  const handleRemoveDisbursement = (idx: number) => {
    setDisbursements((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = (markAsSent: boolean) => {
    const combinedProspectName = [firstName.trim(), surname.trim()].filter(Boolean).join(' ');
    const resolvedClientType: 'existing' | 'prospect' =
      linkedOrganisationId || linkedPersonId ? 'existing' : 'prospect';

    startTransition(async () => {
      if (mode === 'revise' && existing) {
        const res = await reviseQuoteAction(existing.id, {
          feeBasis,
          feeAmountExVat: feeAmountNum,
          hourlyRateGbp:
            feeBasis === 'Hourly rate with estimate'
              ? Number(hourlyRateStr) || null
              : null,
          vatAmount: effectiveVatOnFee,
          vatOverridden,
          disbursements,
          scope,
          assumptions,
          validUntil,
          followUpAfterDays: Math.max(1, Number(followUpAfterDaysStr) || 7),
          revisionNote,
          markAsSent,
        });
        if (res.error || !res.quote) {
          showToast(res.error ?? 'Failed to revise quote');
          return;
        }
        showToast(
          markAsSent
            ? `Revised to v${res.quote.version} and marked as sent (v${res.quote.version - 1} marked Superseded)`
            : `Revised quote saved as v${res.quote.version} draft`,
        );
        if (onSuccessOverride) {
          onSuccessOverride(res.quote);
        } else {
          router.push(`/quotes/${res.quote.id}`);
        }
        return;
      }

      const res = await saveQuoteAction(
        {
          clientType: resolvedClientType,
          linkedOrganisationId,
          linkedPersonId,
          prospectName: combinedProspectName,
          prospectOrganisationName,
          prospectEmail,
          prospectPhone,
          linkedEnquiryId,
          practiceAreaId,
          workTypeSubcategoryId: workTypeSubcategoryId || null,
          scope,
          assumptions,
          feeBasis,
          feeAmountExVat: feeAmountNum,
          hourlyRateGbp:
            feeBasis === 'Hourly rate with estimate'
              ? Number(hourlyRateStr) || null
              : null,
          vatAmount: effectiveVatOnFee,
          vatOverridden,
          disbursements,
          validUntil,
          feeEarnerId,
          followUpAfterDays: Math.max(1, Number(followUpAfterDaysStr) || 7),
        },
        {
          id: existing?.id,
          markAsSent,
        },
      );

      if (res.error || !res.quote) {
        showToast(res.error ?? 'Could not save quote');
        return;
      }

      showToast(
        markAsSent
          ? `Quote ${res.quote.reference} marked as sent · Follow-up scheduled for ${res.quote.nextFollowUpDate}`
          : `Quote ${res.quote.reference} saved`,
      );
      if (onSuccessOverride) {
        onSuccessOverride(res.quote);
      } else {
        router.push(`/quotes/${res.quote.id}`);
      }
    });
  };

  const isWorkTypeComplete = Boolean(practiceAreaId && scope.trim());
  const isFeesComplete = Boolean(feeBasis && feeAmountStr.trim() !== '' && feeAmountNum > 0);

  return (
    <div className="new-enquiry-page">
      <div className="person-form-layout">
        {/* LEFT / CENTRAL COLUMN */}
        <div className="person-form-main-col">
          <div className="new-enquiry-header">
            <div>
              <Link href="/enquiries" className="new-enquiry-back">
                ← Back to Enquiries &amp; Quotes
              </Link>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  minHeight: 40,
                  marginTop: 0,
                }}
              >
                <h1 className="new-enquiry-title">
                  {mode === 'new'
                    ? 'New quote'
                    : mode === 'revise' && existing
                      ? `Revise quote ${existing.reference} (creating v${existing.version + 1})`
                      : `Edit quote ${existing?.reference ?? ''}`}
                </h1>
                <StatusPill
                  label={
                    mode === 'revise' && existing
                      ? `v${existing.version + 1} Draft`
                      : existing?.status ?? 'Draft'
                  }
                  tone="neutral"
                />
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                  }}
                >
                  {mode === 'revise' && existing
                    ? `Version v${existing.version} will be marked Superseded and kept in the version history on ${existing.reference}`
                    : 'Single-page fee quote and scope summary for prospective or existing clients'}
                </span>
              </div>
            </div>
          </div>

          {initialEnquiry ? (
            <div
              className="banner"
              style={{
                marginBottom: 0,
                background: 'rgba(15, 118, 110, 0.08)',
                border: '1px solid rgba(15, 118, 110, 0.28)',
              }}
            >
              <div>
                <strong>Pre-filled from enquiry {initialEnquiry.reference}:</strong>{' '}
                {enquiryDisplayName(initialEnquiry)}
                {initialEnquiry.callingOnBehalfOf ? ` (${initialEnquiry.callingOnBehalfOf})` : ''} —{' '}
                {initialEnquiry.summary}
              </div>
            </div>
          ) : null}

          {/* 1. CLIENT OR PROSPECT & LINKED ENQUIRY */}
          <section className="new-enquiry-card" aria-labelledby="sec-quote-client">
            <div className="new-enquiry-card__top">
              <h2 id="sec-quote-client" className="new-enquiry-card__label">
                1 · CLIENT OR PROSPECT
              </h2>
              <span
                className="new-enquiry-badge"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <Search size={12} aria-hidden="true" />
                Searches clients &amp; prospects
              </span>
            </div>

            <div className="form-grid-3">
              <div className="field-group">
                <label className="field-label" htmlFor="qte-first-name">
                  First name
                </label>
                <input
                  id="qte-first-name"
                  type="text"
                  className="field-input"
                  placeholder="e.g. Alun"
                  autoFocus={mode === 'new'}
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                    setContactSearchDismissed(false);
                  }}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-surname">
                  Surname
                </label>
                <input
                  id="qte-surname"
                  type="text"
                  className="field-input"
                  placeholder="e.g. Davies"
                  value={surname}
                  onChange={(e) => {
                    setSurname(e.target.value);
                    setContactSearchDismissed(false);
                  }}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-prospect-org">
                  Organisation
                </label>
                <input
                  id="qte-prospect-org"
                  type="text"
                  className="field-input"
                  placeholder="e.g. Example Holdings Ltd"
                  value={prospectOrganisationName}
                  onChange={(e) => {
                    setProspectOrganisationName(e.target.value);
                    setContactSearchDismissed(false);
                  }}
                />
              </div>
            </div>

            {/* INLINE EXISTING CONTACTS SEARCH RESULTS (same as Add Client on New Matter screen) */}
            {hasContactSearchQuery && !contactSearchDismissed && contactLookupResults.length > 0 ? (
              <div
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  background: 'var(--bg-surface)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--bg-surface-subtle)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Matching people &amp; organisations ({contactLookupResults.length})
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ height: 24, padding: '0 8px', fontSize: 12 }}
                    onClick={() => setContactSearchDismissed(true)}
                  >
                    Hide matches
                  </button>
                </div>

                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table
                    className="enquiries-table"
                    style={{ width: '100%', borderCollapse: 'collapse' }}
                  >
                    <thead>
                      <tr>
                        <th style={{ padding: '7px 12px', textAlign: 'left' }}>Name</th>
                        <th style={{ padding: '7px 12px', textAlign: 'left' }}>Type</th>
                        <th style={{ padding: '7px 12px', textAlign: 'left' }}>Organisation</th>
                        <th style={{ padding: '7px 12px', textAlign: 'left' }}>Details</th>
                        <th style={{ padding: '7px 12px', width: 90, textAlign: 'right' }}>
                          <span className="sr-only">Select</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactLookupResults.map((row) => {
                        const isSelected =
                          (row.entityType === 'person' && linkedPersonId === row.id) ||
                          (row.entityType === 'organisation' &&
                            linkedOrganisationId === row.id);
                        return (
                          <tr
                            key={`${row.entityType}:${row.id}`}
                            style={{
                              borderTop: '1px solid var(--border-subtle)',
                              cursor: 'pointer',
                              background: isSelected
                                ? 'var(--bg-surface-subtle)'
                                : 'var(--bg-surface)',
                            }}
                            onClick={() => {
                              if (row.entityType === 'person' && row.person) {
                                linkExistingPerson(row.person, row.linkedOrgs);
                              } else if (
                                row.entityType === 'organisation' &&
                                row.organisation
                              ) {
                                linkExistingOrg(row.organisation);
                              }
                            }}
                          >
                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                              <div
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                }}
                              >
                                {row.entityType === 'organisation' ? (
                                  <Building2 size={14} color="var(--text-secondary)" />
                                ) : (
                                  <User size={14} color="var(--text-secondary)" />
                                )}
                                <span>{row.name}</span>
                                {row.matchNote ? (
                                  <StatusPill
                                    label={
                                      row.matchNote === 'similar spelling'
                                        ? 'Similar spelling'
                                        : 'Sounds alike'
                                    }
                                    tone="warning"
                                  />
                                ) : null}
                              </div>
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <StatusPill
                                label={
                                  row.entityType === 'organisation'
                                    ? 'Organisation'
                                    : 'Person'
                                }
                                tone="neutral"
                              />
                            </td>
                            <td style={{ padding: '8px 12px', fontSize: 13 }}>
                              {row.organisationName}
                            </td>
                            <td
                              style={{
                                padding: '8px 12px',
                                fontSize: 12.5,
                                color: 'var(--text-secondary)',
                              }}
                            >
                              {row.details || '—'}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                              {isSelected ? (
                                <StatusPill label="Selected" tone="positive" />
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (row.entityType === 'person' && row.person) {
                                      linkExistingPerson(row.person, row.linkedOrgs);
                                    } else if (
                                      row.entityType === 'organisation' &&
                                      row.organisation
                                    ) {
                                      linkExistingOrg(row.organisation);
                                    }
                                  }}
                                >
                                  Select
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="form-grid-3">
              <div className="field-group">
                <label className="field-label" htmlFor="qte-prospect-email">
                  Email
                </label>
                <input
                  id="qte-prospect-email"
                  type="email"
                  className="field-input"
                  placeholder="name@example.com"
                  value={prospectEmail}
                  onChange={(e) => setProspectEmail(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-prospect-phone">
                  Phone
                </label>
                <input
                  id="qte-prospect-phone"
                  type="tel"
                  className="field-input"
                  placeholder="029 2018 0000"
                  value={prospectPhone}
                  onChange={(e) => setProspectPhone(e.target.value)}
                />
              </div>
            </div>

            <hr
              style={{
                margin: '4px 0',
                border: 'none',
                borderTop: '1px solid var(--border-subtle)',
              }}
            />

            {!showLinkedEnquiry && !linkedEnquiryId ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={() => setShowLinkedEnquiry(true)}
                >
                  <Link2 size={14} aria-hidden="true" /> Link Enquiry
                </button>
              </div>
            ) : (
              <div className="field-group">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <label className="field-label" htmlFor="qte-linked-enquiry" style={{ marginBottom: 0 }}>
                    Linked enquiry{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (optional, searchable)
                    </span>
                    {activeEnquiriesForLinkedContact.length > 0 && !showAllEnquiriesInDropdown ? (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--accent-primary, #0f766e)',
                        }}
                      >
                        · Showing {activeEnquiriesForLinkedContact.length} active{' '}
                        {activeEnquiriesForLinkedContact.length === 1 ? 'enquiry' : 'enquiries'} for this
                        contact
                      </span>
                    ) : null}
                  </label>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {activeEnquiriesForLinkedContact.length > 0 ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ height: 24, padding: '0 8px', fontSize: 12 }}
                        onClick={() => setShowAllEnquiriesInDropdown((prev) => !prev)}
                      >
                        {showAllEnquiriesInDropdown
                          ? 'Show contact’s active enquiries only'
                          : 'Show all enquiries'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ height: 24, padding: '0 8px', fontSize: 12 }}
                      onClick={() => {
                        setLinkedEnquiryId(null);
                        setShowLinkedEnquiry(false);
                      }}
                    >
                      <X size={13} aria-hidden="true" /> Remove link
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 12 }}>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Filter enquiries by ref or name…"
                    value={enquirySearch}
                    onChange={(e) => setEnquirySearch(e.target.value)}
                  />
                  <select
                    id="qte-linked-enquiry"
                    className="field-select"
                    value={linkedEnquiryId ?? ''}
                    onChange={(e) => handleSelectEnquiry(e.target.value)}
                  >
                    <option value="">— No linked enquiry (standalone quote) —</option>
                    {filteredEnquiries.map((enq) => (
                      <option key={enq.id} value={enq.id}>
                        {enq.reference} · {enquiryDisplayName(enq)}
                        {enq.callingOnBehalfOf ? ` (${enq.callingOnBehalfOf})` : ''} —{' '}
                        {enq.summary.slice(0, 55)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </section>

          {/* 2. WORK TYPE, SCOPE & ASSUMPTIONS */}
          <section className="new-enquiry-card" aria-labelledby="sec-quote-work-type">
            <div className="new-enquiry-card__top">
              <h2 id="sec-quote-work-type" className="new-enquiry-card__label">
                2 · WORK TYPE &amp; SCOPE
              </h2>
              {isWorkTypeComplete ? (
                <span className="new-enquiry-badge new-enquiry-badge--ok">Complete</span>
              ) : (
                <span className="new-enquiry-badge">2 required</span>
              )}
            </div>

            <div className="form-grid-3">
              <div className="field-group">
                <label className="field-label" htmlFor="qte-practice-area">
                  Practice area <span className="required">*</span>
                </label>
                <select
                  id="qte-practice-area"
                  className="field-select"
                  value={practiceAreaId}
                  onChange={(e) => {
                    const nextPa = e.target.value;
                    setPracticeAreaId(nextPa);
                    const firstSub = allWorkTypes.find((w) => w.parentId === nextPa);
                    setWorkTypeSubcategoryId(firstSub?.id ?? '');
                  }}
                >
                  <option value="">Select practice area…</option>
                  {practiceAreas.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-work-type">
                  Work type / matter type
                </label>
                <select
                  id="qte-work-type"
                  className="field-select"
                  value={workTypeSubcategoryId}
                  onChange={(e) => setWorkTypeSubcategoryId(e.target.value)}
                >
                  <option value="">General {resolveLabel(values, practiceAreaId)}</option>
                  {subcategories.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="qte-scope">
                Description of work / scope <span className="required">*</span>
              </label>
              <textarea
                id="qte-scope"
                className="field-textarea"
                rows={3}
                placeholder="Describe the agreed scope of work to be covered by this quote…"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="qte-assumptions">
                Assumptions and exclusions
              </label>
              <textarea
                id="qte-assumptions"
                className="field-textarea"
                rows={3}
                placeholder="Key assumptions on which the fee is based and any work explicitly excluded…"
                value={assumptions}
                onChange={(e) => setAssumptions(e.target.value)}
              />
            </div>

            {mode === 'revise' ? (
              <div className="field-group">
                <label className="field-label" htmlFor="qte-revision-note">
                  Revision summary note (recorded on version history)
                </label>
                <input
                  id="qte-revision-note"
                  type="text"
                  className="field-input"
                  placeholder="e.g. Revised to capped fee following client discussion"
                  value={revisionNote}
                  onChange={(e) => setRevisionNote(e.target.value)}
                />
              </div>
            ) : null}
          </section>

          {/* 3. FEE BASIS, PROFESSIONAL FEE, VAT & DISBURSEMENTS */}
          <section className="new-enquiry-card" aria-labelledby="sec-quote-fees">
            <div className="new-enquiry-card__top">
              <h2 id="sec-quote-fees" className="new-enquiry-card__label">
                3 · FEES &amp; DISBURSEMENTS
              </h2>
              {isFeesComplete ? (
                <span className="new-enquiry-badge new-enquiry-badge--ok">Complete</span>
              ) : (
                <span className="new-enquiry-badge">2 required</span>
              )}
            </div>

            <div className="form-grid-3">
              <div className="field-group">
                <label className="field-label" htmlFor="qte-fee-basis">
                  Fee basis <span className="required">*</span>
                </label>
                <select
                  id="qte-fee-basis"
                  className="field-select"
                  value={feeBasis}
                  onChange={(e) => setFeeBasis(e.target.value as QuoteFeeBasis)}
                >
                  {QUOTE_FEE_BASES.map((fb) => (
                    <option key={fb} value={fb}>
                      {fb}
                    </option>
                  ))}
                </select>
              </div>

              {feeBasis === 'Hourly rate with estimate' ? (
                <div className="field-group">
                  <label className="field-label" htmlFor="qte-hourly-rate">
                    Hourly rate (£/hr ex VAT)
                  </label>
                  <input
                    id="qte-hourly-rate"
                    type="number"
                    min="0"
                    step="10"
                    className="field-input"
                    value={hourlyRateStr}
                    onChange={(e) => setHourlyRateStr(e.target.value)}
                  />
                </div>
              ) : null}

              <div className="field-group">
                <label className="field-label" htmlFor="qte-fee-amount">
                  Professional fee (£ ex VAT) <span className="required">*</span>
                </label>
                <input
                  id="qte-fee-amount"
                  type="number"
                  min="0"
                  step="50"
                  className="field-input"
                  placeholder="e.g. 2850"
                  value={feeAmountStr}
                  onChange={(e) => setFeeAmountStr(e.target.value)}
                />
              </div>

              <div className="field-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="field-label" htmlFor="qte-vat-amount">
                    VAT{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (£ — standard 20%)
                    </span>
                  </label>
                  {vatOverridden ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ fontSize: 11, padding: '0 4px', minHeight: 18 }}
                      onClick={() => setVatOverridden(false)}
                    >
                      Reset to 20%
                    </button>
                  ) : null}
                </div>
                <input
                  id="qte-vat-amount"
                  type="number"
                  min="0"
                  step="1"
                  className="field-input"
                  value={vatOverridden ? vatInputStr : String(effectiveVatOnFee)}
                  onChange={(e) => {
                    setVatOverridden(true);
                    setVatInputStr(e.target.value);
                  }}
                />
              </div>
            </div>

            <hr
              style={{
                margin: '4px 0',
                border: 'none',
                borderTop: '1px solid var(--border-subtle)',
              }}
            />

            {/* Disbursements repeatable table */}
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <span className="field-label" style={{ marginBottom: 0 }}>
                  Disbursements
                </span>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={handleAddDisbursement}
                >
                  <Plus size={14} aria-hidden="true" /> Add disbursement
                </button>
              </div>

              {disbursements.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
                  No disbursements added. Click &ldquo;Add disbursement&rdquo; to itemise search fees, Land Registry fees, or counsel fees.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {disbursements.map((row, idx) => (
                    <div
                      key={row.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 140px 110px 36px',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="text"
                        className="field-input"
                        placeholder="Disbursement description (e.g. HM Land Registry fee)"
                        aria-label={`Disbursement ${idx + 1} description`}
                        value={row.description}
                        onChange={(e) =>
                          handleUpdateDisbursement(idx, { description: e.target.value })
                        }
                      />
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="field-input"
                        placeholder="Amount £"
                        aria-label={`Disbursement ${idx + 1} amount`}
                        value={row.amountExVat || ''}
                        onChange={(e) =>
                          handleUpdateDisbursement(idx, {
                            amountExVat: Number(e.target.value) || 0,
                          })
                        }
                      />
                      <label
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={row.vatApplicable}
                          onChange={(e) =>
                            handleUpdateDisbursement(idx, {
                              vatApplicable: e.target.checked,
                            })
                          }
                        />
                        <span>+ 20% VAT</span>
                      </label>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={`Remove disbursement ${idx + 1}`}
                        onClick={() => handleRemoveDisbursement(idx)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* 4. VALIDITY, FEE EARNER & FOLLOW-UP */}
          <section className="new-enquiry-card" aria-labelledby="sec-quote-validity">
            <div className="new-enquiry-card__top">
              <h2 id="sec-quote-validity" className="new-enquiry-card__label">
                4 · VALIDITY, FEE EARNER &amp; FOLLOW-UP
              </h2>
            </div>

            <div className="form-grid-3">
              <div className="field-group">
                <label className="field-label" htmlFor="qte-fee-earner">
                  Fee earner
                </label>
                <select
                  id="qte-fee-earner"
                  className="field-select"
                  value={feeEarnerId}
                  onChange={(e) => {
                    const nextFe = e.target.value;
                    setFeeEarnerId(nextFe);
                    const emp = people.find((p) => p.id === nextFe);
                    const rate = emp?.employment?.feeEarner?.chargeOutRateGbp ?? null;
                    if (rate) setHourlyRateStr(String(rate));
                  }}
                >
                  {feeEarners.map((fe) => (
                    <option key={fe.id} value={fe.id}>
                      {personDisplayName(fe)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-valid-until">
                  Valid until{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (defaults to 30 days)
                  </span>
                </label>
                <input
                  id="qte-valid-until"
                  type="date"
                  className="field-input"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="qte-followup-days">
                  Follow-up after{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (days after sending)
                  </span>
                </label>
                <input
                  id="qte-followup-days"
                  type="number"
                  min="1"
                  max="90"
                  className="field-input"
                  value={followUpAfterDaysStr}
                  onChange={(e) => setFollowUpAfterDaysStr(e.target.value)}
                />
              </div>
            </div>

            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              When marked as sent, the first follow-up is automatically scheduled{' '}
              {Math.max(1, Number(followUpAfterDaysStr) || 7)} days later.
            </p>
          </section>
        </div>

        {/* RIGHT STICKY COLUMN: ACTIONS, QUICK CONFLICT CHECK & QUOTE TOTAL */}
        <aside className="person-form-side-col">
          <div className="new-enquiry-footer-actions">
            {onCancelOverride ? (
              <button
                type="button"
                className="btn btn--secondary"
                style={{ borderRadius: 999 }}
                disabled={pending}
                onClick={onCancelOverride}
              >
                Cancel
              </button>
            ) : (
              <Link
                href={existing ? `/quotes/${existing.id}` : '/enquiries'}
                className="btn btn--secondary"
                style={{ borderRadius: 999 }}
              >
                Cancel
              </Link>
            )}
            <button
              type="button"
              className="btn btn--secondary"
              style={{ borderRadius: 999 }}
              disabled={pending}
              onClick={() => handleSubmit(false)}
            >
              {mode === 'revise'
                ? `Save v${(existing?.version ?? 1) + 1} as draft`
                : existing
                  ? 'Save changes'
                  : 'Save as draft'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              style={{ borderRadius: 999 }}
              disabled={pending}
              onClick={() => handleSubmit(true)}
            >
              {mode === 'revise'
                ? `Save v${(existing?.version ?? 1) + 1} & mark as sent`
                : 'Save & mark as sent'}
            </button>
          </div>

          {/* 1. QUICK CONFLICT CHECK */}
          <section
            className="new-enquiry-card"
            aria-labelledby="sec-quote-conflict-heading"
          >
            <div className="new-enquiry-card__top">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <h2 id="sec-quote-conflict-heading" className="new-enquiry-card__label">
                  QUICK CONFLICT CHECK
                </h2>
                <InfoPopover
                  label="About the quick conflict check"
                  title="What the quick conflict check looks for"
                  docHref="/docs/quick-conflict-check"
                  docLabel="How the quick conflict check works"
                >
                  <p>
                    As you type, the person&rsquo;s and organisation&rsquo;s details are compared
                    with existing People, Organisations and matters.
                  </p>
                  <ul>
                    <li>
                      <strong>Possible conflicts</strong>: the client or their organisation is a known
                      opposite party (by name, email or phone).
                    </li>
                    <li>
                      <strong>Already known to us</strong>: existing records with the same name,
                      email or phone, which you can link to the quote.
                    </li>
                    <li>
                      Misspellings and names that sound alike are shown as amber &ldquo;check&rdquo;
                      results rather than red conflicts.
                    </li>
                  </ul>
                  <p>
                    It&rsquo;s indicative only. The full conflict check runs before a matter is
                    opened.
                  </p>
                </InfoPopover>
              </div>
              {!hasSearchInputs ? (
                <span className="new-enquiry-badge">Waiting</span>
              ) : hasHighSeverityConflict ? (
                <span className="new-enquiry-badge new-enquiry-badge--alert">
                  Possible conflict
                </span>
              ) : distinctMatchedCount > 0 ? (
                <span className="new-enquiry-badge new-enquiry-badge--warn">
                  {distinctMatchedCount} {distinctMatchedCount === 1 ? 'match' : 'matches'}
                </span>
              ) : (
                <span className="new-enquiry-badge new-enquiry-badge--ok">No matches</span>
              )}
            </div>

            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45 }}>
              Runs as you type the person&rsquo;s name, organisation, email or phone.
            </p>

            {/* Dynamic results area */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {linkedPersonId ? (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-subtle)',
                  }}
                >
                  <StatusPill
                    label={`Linked: ${personDisplayName(mergedPeople.find((p) => p.id === linkedPersonId)) || linkedPersonId}`}
                    tone="positive"
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setLinkedPersonId(null)}
                  >
                    Unlink
                  </button>
                </div>
              ) : null}

              {linkedOrganisationId ? (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-subtle)',
                  }}
                >
                  <StatusPill
                    label={`Linked: ${organisations.find((o) => o.id === linkedOrganisationId)?.legalName ?? linkedOrganisationId}`}
                    tone="positive"
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setLinkedOrganisationId(null)}
                  >
                    Unlink
                  </button>
                </div>
              ) : null}

              {hasSearchInputs && distinctMatchedCount === 0 ? (
                <div
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-secondary)',
                    fontSize: 12.5,
                    lineHeight: 1.45,
                  }}
                >
                  No conflicts or existing records matched.
                </div>
              ) : null}

              {possibleConflicts.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Possible conflicts
                  </div>
                  {possibleConflicts.map((hit) => {
                    const isHigh = hit.severity === 'high' || hit.blocking;
                    const key = `${hit.recordType}:${hit.recordId}`;
                    const isSimilarOnly = hit.matchedFields.every(
                      (f) => f.includes('similar spelling') || f.includes('sounds like'),
                    );
                    const matchedOn = Array.from(
                      new Set([
                        ...hit.matchedFields,
                        ...(entityReasonsByKey.get(key)?.split(', ') ?? []),
                      ]),
                    ).join(', ');
                    const person =
                      hit.recordType === 'person'
                        ? people.find((p) => p.id === hit.recordId)
                        : undefined;
                    const org =
                      hit.recordType === 'organisation'
                        ? organisations.find((o) => o.id === hit.recordId)
                        : undefined;
                    const isLinked =
                      (person && linkedPersonId === person.id) ||
                      (org && linkedOrganisationId === org.id);
                    return (
                      <div
                        key={`conflict-${hit.recordType}-${hit.recordId}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '8px 10px',
                          borderRadius: 8,
                          background: isHigh ? '#fde8e4' : '#fdf0d9',
                          color: isHigh ? '#9a230b' : '#7a4204',
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>
                            {isHigh
                              ? 'Possible conflict: '
                              : isSimilarOnly
                                ? 'Similar name, check: '
                                : hit.recordType === 'matter'
                                  ? 'Matter / party match: '
                                  : 'Check: '}
                            <Link
                              href={hit.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: 'inherit', textDecoration: 'underline' }}
                            >
                              {hit.recordLabel}
                            </Link>
                          </div>
                          <div>{hit.reason}</div>
                          {matchedOn ? (
                            <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>
                              Matched on: {matchedOn}
                            </div>
                          ) : null}
                        </div>
                        {person || org ? (
                          isLinked ? (
                            <StatusPill label="Linked" tone="positive" />
                          ) : (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() =>
                                person ? linkExistingPerson(person) : linkExistingOrg(org!)
                              }
                            >
                              Link
                            </button>
                          )
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {knownPeople.length > 0 || knownOrganisations.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Already known to us
                  </div>

                  {knownPeople.map((m) => (
                    <div
                      key={m.person.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                        fontSize: 12.5,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>
                          <Link
                            href={`/people/${m.person.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {personDisplayName(m.person)}
                          </Link>{' '}
                          <span className="muted">({m.person.id})</span>
                        </div>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          Matched on: {m.formattedReasons} ·{' '}
                          {resolveLabel(values, m.person.relationshipStatusId)}
                        </div>
                      </div>
                      {linkedPersonId === m.person.id ? (
                        <StatusPill label="Linked" tone="positive" />
                      ) : (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => linkExistingPerson(m.person)}
                        >
                          Link
                        </button>
                      )}
                    </div>
                  ))}

                  {knownOrganisations.map((m) => (
                    <div
                      key={m.organisation.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)',
                        fontSize: 12.5,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>
                          <Link
                            href={`/organisations/${m.organisation.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {m.organisation.legalName}
                          </Link>{' '}
                          <span className="muted">({m.organisation.id})</span>
                        </div>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          Matched on: {m.formattedReasons} ·{' '}
                          {resolveLabel(values, m.organisation.relationshipStatusId)}
                        </div>
                      </div>
                      {linkedOrganisationId === m.organisation.id ? (
                        <StatusPill label="Linked" tone="positive" />
                      ) : (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => linkExistingOrg(m.organisation)}
                        >
                          Link
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <p className="muted" style={{ margin: 'auto 0 0', fontSize: 12.5, lineHeight: 1.4 }}>
              Indicative only. The full conflict check runs before a matter is opened.
            </p>
          </section>

          {/* 2. QUOTE TOTAL */}
          <section className="new-enquiry-card" aria-labelledby="sec-quote-total-heading">
            <div className="new-enquiry-card__top">
              <h2 id="sec-quote-total-heading" className="new-enquiry-card__label">
                QUOTE TOTAL
              </h2>
              <span className="new-enquiry-badge">Calculated</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">Fee basis</span>
                <strong>{feeBasis}</strong>
              </div>
              {feeBasis === 'Hourly rate with estimate' && Number(hourlyRateStr) > 0 ? (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted">Hourly rate (ex VAT)</span>
                  <span>{formatGbp(Number(hourlyRateStr))}/hr</span>
                </div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">Professional fee (ex VAT)</span>
                <span>{formatGbp(totals.feeAmountExVat, true)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">VAT on professional fee</span>
                <span>{formatGbp(totals.vatOnFee, true)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">Disbursements (ex VAT)</span>
                <span>{formatGbp(totals.disbursementsExVat, true)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">VAT on disbursements</span>
                <span>{formatGbp(totals.vatOnDisbursements, true)}</span>
              </div>
              <hr
                style={{
                  margin: '4px 0',
                  border: 'none',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">Total (ex VAT)</span>
                <strong>{formatGbp(totals.totalExVat, true)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">Total VAT</span>
                <span>{formatGbp(totals.totalVat, true)}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  paddingTop: 8,
                  borderTop: '2px solid var(--border, #cbd5e1)',
                  fontSize: 17,
                  fontWeight: 700,
                }}
              >
                <span>Total (inc VAT)</span>
                <span style={{ color: 'var(--brand, #0f766e)' }}>
                  {formatGbp(totals.totalIncVat, true)}
                </span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
