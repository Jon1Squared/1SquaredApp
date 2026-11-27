'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Link2, Plus, RefreshCw, Search, Trash2, User, X } from 'lucide-react';
import {
  poundsToMinorUnits,
  resolveEffectiveFeeCaps,
  type FeeArrangementCapEntry,
  type ResolvedApplicableRatesResult,
  type WorkTypesConfiguration,
} from '@platform/core-api';
import {
  previewIntakeDuplicatesAndConflictsAction,
  resolveApplicableRatesAction,
  reviseQuoteAction,
  saveQuoteAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatRateTierBadgeLabel } from '@/domain/matterCosts';
import { addDays, toIsoDate } from '@/domain/dates';
import {
  enquiryDisplayName,
  hasQuickConflictCheckInputs,
} from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { personDisplayName, primaryEmail, primaryPhone } from '@/domain/names';
import { isWorkTypeChoiceActive } from '@/domain/orgStructure';
import {
  calculateQuoteTotals,
  formatGbp,
  mapQuoteFeeBasisToArrangementBasis,
  QUOTE_FEE_BASES,
  roundCurrency,
} from '@/domain/quotes';
import {
  DEFAULT_WORK_TYPES_CONFIG,
  resolveWorkTypeFeeArrangementSettings,
  resolveWorkTypePriceTransparency,
} from '@/domain/workTypeConfig';
import { shouldShowNoMatchesMessage } from '@/domain/intakePreviewState';
import type {
  EntityPickerEnquirySummary,
  EntityPickerOrganisationSummary,
  EntityPickerPersonSummary,
} from '@/domain/intakePreviewTypes';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  OrgStructureCatalogue,
  Organisation,
  Person,
  PersonOrganisationLink,
  Quote,
  QuoteDisbursement,
  QuoteFeeBasis,
} from '@/domain/types';
import { InfoPopover } from './InfoPopover';
import { createSendIdempotencyController } from './sendIdempotency';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';
import { useEntityPicker } from './useEntityPicker';
import { useIntakePreview } from './useIntakePreview';

interface Props {
  mode: 'new' | 'edit' | 'revise';
  existing?: Quote | null;
  initialEnquiry?: Enquiry | null;
  initialResolvedRates?: ResolvedApplicableRatesResult | null;
  enquiries?: Enquiry[];
  matters?: Matter[];
  people?: Person[];
  organisations?: Organisation[];
  links?: PersonOrganisationLink[];
  values: ChoiceValue[];
  orgStructure?: OrgStructureCatalogue;
  currentUserId: string;
  tenantId: string;
  tenantVatRatePercent?: number;
  workTypesConfig?: WorkTypesConfiguration;
  firmFeeArrangementCaps?: FeeArrangementCapEntry[];
  emailProviderDisabled?: boolean;
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
  initialResolvedRates = null,
  enquiries = [],
  matters: _matters = [],
  people = [],
  organisations = [],
  links = [],
  values,
  orgStructure,
  currentUserId,
  tenantId: _tenantId,
  tenantVatRatePercent = 20,
  workTypesConfig,
  firmFeeArrangementCaps,
  emailProviderDisabled = false,
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
    () =>
      valuesForList(values, 'work_type').filter(
        (v) =>
          isWorkTypeChoiceActive(v.id, values, orgStructure) ||
          v.id === existing?.practiceAreaId ||
          v.id === existing?.workTypeSubcategoryId ||
          v.id === initialEnquiry?.practiceAreaId ||
          v.id === initialEnquiry?.workTypeSubcategoryId,
      ),
    [
      values,
      orgStructure,
      existing?.practiceAreaId,
      existing?.workTypeSubcategoryId,
      initialEnquiry?.practiceAreaId,
      initialEnquiry?.workTypeSubcategoryId,
    ],
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
  const [feeArrangementPercentStr, setFeeArrangementPercentStr] = useState<string>(
    () =>
      existing?.feeArrangementPercent !== undefined &&
      existing?.feeArrangementPercent !== null
        ? String(existing.feeArrangementPercent)
        : '',
  );
  const [quoteFeeCapError, setQuoteFeeCapError] = useState<string | null>(null);
  const [feeAmountStr, setFeeAmountStr] = useState<string>(() =>
    existing ? String(existing.feeAmountExVat) : '',
  );
  const [rateGradeKey, setRateGradeKey] = useState<string>(
    () => existing?.rateGradeKey ?? 'associate',
  );
  const [resolvedRates, setResolvedRates] = useState<ResolvedApplicableRatesResult | null>(
    () => initialResolvedRates,
  );
  const [refreshRates, setRefreshRates] = useState<boolean>(() => mode !== 'edit');
  const [hourlyRateManuallyEdited, setHourlyRateManuallyEdited] = useState<boolean>(
    () => mode === 'edit' && existing?.rateSource === 'custom_override',
  );
  const [hourlyRateStr, setHourlyRateStr] = useState<string>(() => {
    if (existing?.hourlyRateGbp) return String(existing.hourlyRateGbp);
    const initialFromRates =
      initialResolvedRates?.grades?.[existing?.rateGradeKey ?? 'associate']?.rateGbp ??
      initialResolvedRates?.associateRateGbp;
    if (initialFromRates && initialFromRates > 0) return String(initialFromRates);
    const currentEmp = people.find((p) => p.id === (existing?.feeEarnerId ?? currentUserId));
    const rate = currentEmp?.employment?.feeEarner?.chargeOutRateGbp ?? null;
    return rate ? String(rate) : '320';
  });

  const targetRateClientId = linkedOrganisationId ?? linkedPersonId ?? null;
  const targetRateClientType = linkedOrganisationId
    ? ('organisation' as const)
    : linkedPersonId
      ? ('person' as const)
      : null;
  const prevRateLookupKeyRef = useRef<string>(
    `${targetRateClientId ?? ''}::${practiceAreaId}`,
  );

  useEffect(() => {
    const key = `${targetRateClientId ?? ''}::${practiceAreaId}`;
    if (prevRateLookupKeyRef.current === key) return;
    prevRateLookupKeyRef.current = key;
    if (mode === 'edit' && !refreshRates) return;
    let cancelled = false;
    void resolveApplicableRatesAction({
      clientId: targetRateClientId,
      clientType: targetRateClientType,
      practiceAreaId: practiceAreaId || null,
    }).then((res) => {
      if (cancelled || isActionDenied(res) || !res.resolved) return;
      setResolvedRates(res.resolved);
      if (!hourlyRateManuallyEdited) {
        const gradeRate =
          res.resolved.grades?.[rateGradeKey]?.rateGbp ?? res.resolved.associateRateGbp;
        if (gradeRate > 0) {
          setHourlyRateStr(String(gradeRate));
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    targetRateClientId,
    targetRateClientType,
    practiceAreaId,
    mode,
    refreshRates,
    hourlyRateManuallyEdited,
    rateGradeKey,
  ]);

  const applyResolvedRateForGrade = (nextGradeKey: string) => {
    setRateGradeKey(nextGradeKey);
    const gradeRes = resolvedRates?.grades?.[nextGradeKey];
    if (gradeRes && gradeRes.rateGbp > 0) {
      setHourlyRateStr(String(gradeRes.rateGbp));
      setHourlyRateManuallyEdited(false);
    }
  };

  const refreshApplicableQuoteRates = async () => {
    const res = await resolveApplicableRatesAction({
      clientId: targetRateClientId,
      clientType: targetRateClientType,
      practiceAreaId: practiceAreaId || null,
    });
    if (isActionDenied(res) || !res.resolved) return;
    setResolvedRates(res.resolved);
    setRefreshRates(true);
    setHourlyRateManuallyEdited(false);
    const gradeRate =
      res.resolved.grades?.[rateGradeKey]?.rateGbp ?? res.resolved.associateRateGbp;
    if (gradeRate > 0) {
      setHourlyRateStr(String(gradeRate));
    }
  };

  const feeAmountNum = useMemo(
    () => roundCurrency(Math.max(0, Number(feeAmountStr) || 0)),
    [feeAmountStr],
  );

  const arrangementBasis = useMemo(
    () => mapQuoteFeeBasisToArrangementBasis(feeBasis),
    [feeBasis],
  );
  const workTypeFeeSettings = useMemo(
    () =>
      resolveWorkTypeFeeArrangementSettings(
        workTypesConfig ?? DEFAULT_WORK_TYPES_CONFIG,
        {
          workTypeSubcategoryId: workTypeSubcategoryId || null,
          practiceAreaId,
        },
      ),
    [workTypesConfig, workTypeSubcategoryId, practiceAreaId],
  );
  const arrangementMappedCategoryKey = useMemo(() => {
    if (!arrangementBasis) return null;
    return arrangementBasis === 'conditional_fee_agreement'
      ? workTypeFeeSettings.feeArrangementCapCategories
          .conditional_fee_agreement ?? null
      : workTypeFeeSettings.feeArrangementCapCategories
          .damages_based_agreement ?? null;
  }, [arrangementBasis, workTypeFeeSettings]);
  const arrangementCapResolution = useMemo(() => {
    if (!arrangementMappedCategoryKey) return null;
    const res = resolveEffectiveFeeCaps({
      capCategoryKey: arrangementMappedCategoryKey,
      firmCaps: firmFeeArrangementCaps,
      workTypeCapOverrides: workTypeFeeSettings.workTypeCapOverrides,
    });
    return res.ok ? res.resolution : null;
  }, [
    arrangementMappedCategoryKey,
    firmFeeArrangementCaps,
    workTypeFeeSettings.workTypeCapOverrides,
  ]);
  const feeArrangementPercentNum = useMemo(() => {
    const trimmed = feeArrangementPercentStr.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }, [feeArrangementPercentStr]);

  const [refreshVatRate, setRefreshVatRate] = useState<boolean>(
    () => mode === 'revise',
  );
  const existingVatRatePercent = existing?.vatRatePercent ?? 20;
  const effectiveVatRatePercent =
    mode === 'new'
      ? tenantVatRatePercent
      : refreshVatRate
        ? tenantVatRatePercent
        : existingVatRatePercent;

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
    return calculateQuoteTotals(
      feeAmountNum,
      null,
      [],
      effectiveVatRatePercent,
    ).vatOnFee;
  }, [feeAmountNum, vatOverridden, vatInputStr, effectiveVatRatePercent]);

  const [disbursements, setDisbursements] = useState<QuoteDisbursement[]>(() =>
    existing?.disbursements?.length
      ? existing.disbursements.map((d) => ({ ...d }))
      : [],
  );

  const totals = useMemo(
    () =>
      calculateQuoteTotals(
        feeAmountNum,
        effectiveVatOnFee,
        disbursements,
        effectiveVatRatePercent,
      ),
    [feeAmountNum, effectiveVatOnFee, disbursements, effectiveVatRatePercent],
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
  const [paymentOnAccountRequired, setPaymentOnAccountRequired] = useState<boolean>(
    () => Boolean(existing?.paymentOnAccountRequired),
  );
  const [paymentOnAccountGbpStr, setPaymentOnAccountGbpStr] = useState<string>(() => {
    if (existing?.paymentOnAccountGbp != null) return String(existing.paymentOnAccountGbp);
    if (existing?.paymentOnAccountPence != null) return String(existing.paymentOnAccountPence / 100);
    return '';
  });
  const [priceTransparencyCustomNote, setPriceTransparencyCustomNote] = useState<string>(
    () => existing?.priceTransparencySnapshot?.customNote ?? '',
  );

  const resolvedPriceTransparency = useMemo(
    () =>
      resolveWorkTypePriceTransparency(
        workTypesConfig ?? DEFAULT_WORK_TYPES_CONFIG,
        {
          practiceAreaId,
          workTypeSubcategoryId: workTypeSubcategoryId || null,
        },
      ),
    [workTypesConfig, practiceAreaId, workTypeSubcategoryId],
  );

  const quoteSendControllerRef = useRef<ReturnType<
    typeof createSendIdempotencyController
  > | null>(null);
  const getQuoteSendController = () => {
    if (!quoteSendControllerRef.current) {
      quoteSendControllerRef.current = createSendIdempotencyController();
    }
    return quoteSendControllerRef.current;
  };
  useEffect(() => {
    quoteSendControllerRef.current?.reset();
  }, [
    existing?.id,
    existing?.version,
    practiceAreaId,
    workTypeSubcategoryId,
    feeAmountStr,
    paymentOnAccountRequired,
    paymentOnAccountGbpStr,
    prospectEmail,
    linkedPersonId,
    linkedOrganisationId,
  ]);

  const feeEarners = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId && !p.demo)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  // Local hydrated cache for records picked via C2 actions
  const [selectedPeopleById, setSelectedPeopleById] = useState<
    Record<string, Person | EntityPickerPersonSummary>
  >({});
  const [selectedOrgsById, setSelectedOrgsById] = useState<
    Record<string, Organisation | EntityPickerOrganisationSummary>
  >({});
  const [selectedEnquiriesById, setSelectedEnquiriesById] = useState<
    Record<string, Enquiry | EntityPickerEnquirySummary>
  >({});

  // Same contact search as "Add client" on the New Matter screen via debounced C2 SQL picker
  const hasContactSearchQuery = Boolean(
    firstName.trim() || surname.trim() || prospectOrganisationName.trim(),
  );

  const { items: rawContactPickerItems } = useEntityPicker(
    {
      entityTypes: ['person', 'organisation'],
      query: '',
      personQuery: {
        firstName,
        surname,
        organisationName: prospectOrganisationName,
      },
      excludeDemo: true,
      includeLinkedOrgs: true,
      includeEnquiryProspects: true,
      limit: 25,
    },
    { enabled: !contactSearchDismissed && hasContactSearchQuery },
  );

  const contactLookupResults = useMemo(
    () =>
      rawContactPickerItems.map((item) => ({
        id: item.id,
        entityType: item.recordType === 'organisation' ? ('organisation' as const) : ('person' as const),
        name: item.label,
        organisationName:
          item.recordType === 'organisation'
            ? item.label
            : (item.linkedOrgs ?? []).map((o) => o.legalName).join(', ') || '—',
        details: item.subtitle,
        matchNote: item.matchNote ?? null,
        rank: item.rank ?? 1,
        person: item.person,
        organisation: item.organisation,
        linkedOrgs: item.linkedOrgs,
      })),
    [rawContactPickerItems],
  );

  // Live Quick Conflict Check, Entity Matching, and Linked Active Enquiries via C2 server action
  const {
    preview: quoteIntakePreview,
    loadingFast,
    loadingConflicts,
    fastError,
    conflictError,
    triggerConflictCheck,
    retryFastCheck,
    retryConflictCheck,
  } = useIntakePreview({
    kind: 'quote',
    firstName,
    surname,
    callingOnBehalfOf: prospectOrganisationName,
    emails: prospectEmail.trim() ? [prospectEmail] : [],
    phones: prospectPhone.trim() ? [prospectPhone] : [],
    linkedPersonId,
    linkedOrganisationId,
  });

  const activeEnquiriesForLinkedContact = quoteIntakePreview.activeLinkedEnquiries;
  const liveEntityMatches = quoteIntakePreview.entityMatches;
  const possibleConflicts = quoteIntakePreview.possibleConflicts;

  const peopleById = useMemo(() => {
    const map = new Map<string, Person | EntityPickerPersonSummary>();
    for (const p of people) map.set(p.id, p);
    for (const m of liveEntityMatches.people) map.set(m.person.id, m.person);
    for (const p of Object.values(selectedPeopleById)) map.set(p.id, p);
    return map;
  }, [people, liveEntityMatches.people, selectedPeopleById]);

  const orgsById = useMemo(() => {
    const map = new Map<string, Organisation | EntityPickerOrganisationSummary>();
    for (const o of organisations) map.set(o.id, o);
    for (const m of liveEntityMatches.organisations) {
      map.set(m.organisation.id, m.organisation);
    }
    for (const o of Object.values(selectedOrgsById)) map.set(o.id, o);
    return map;
  }, [organisations, liveEntityMatches.organisations, selectedOrgsById]);

  const { items: enquiryPickerItems } = useEntityPicker(
    {
      entityTypes: ['enquiry'],
      query: enquirySearch,
      limit: 25,
    },
    { enabled: showLinkedEnquiry },
  );

  const enquiriesById = useMemo(() => {
    const map = new Map<string, Enquiry | EntityPickerEnquirySummary>();
    if (initialEnquiry) map.set(initialEnquiry.id, initialEnquiry);
    for (const e of enquiries) map.set(e.id, e);
    for (const e of activeEnquiriesForLinkedContact) map.set(e.id, e);
    for (const item of enquiryPickerItems) {
      if (item.enquiry) map.set(item.enquiry.id, item.enquiry);
    }
    for (const e of Object.values(selectedEnquiriesById)) map.set(e.id, e);
    return map;
  }, [
    initialEnquiry,
    enquiries,
    activeEnquiriesForLinkedContact,
    enquiryPickerItems,
    selectedEnquiriesById,
  ]);

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
    const enq = enquiriesById.get(nextId);
    if (!enq) return;
    setSelectedEnquiriesById((prev) => ({ ...prev, [enq.id]: enq }));

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
      setScope(enq.summary);
    }
    if (enq.assignedToId) {
      setFeeEarnerId(enq.assignedToId);
    }
  };

  const applyAutoEnquirySelectionForContact = (
    pId: string | null,
    oId: string | null,
    personObj?: Person | EntityPickerPersonSummary | null,
    orgObj?: Organisation | EntityPickerOrganisationSummary | null,
  ) => {
    void previewIntakeDuplicatesAndConflictsAction({
      kind: 'quote',
      firstName: personObj?.firstName ?? firstName,
      surname: personObj?.surname ?? surname,
      callingOnBehalfOf: orgObj?.legalName ?? prospectOrganisationName,
      linkedPersonId: pId,
      linkedOrganisationId: oId,
      includeConflicts: false,
    }).then((res) => {
      if (isActionDenied(res)) return;
      const activeEnqs = res.activeLinkedEnquiries;
      for (const e of activeEnqs) {
        setSelectedEnquiriesById((prev) => ({ ...prev, [e.id]: e }));
      }
      if (activeEnqs.length === 1) {
        setShowLinkedEnquiry(true);
        setShowAllEnquiriesInDropdown(false);
        handleSelectEnquiry(activeEnqs[0].id, true);
      } else if (activeEnqs.length > 1) {
        setShowLinkedEnquiry(true);
        setShowAllEnquiriesInDropdown(false);
      }
    });
  };

  const linkExistingPerson = (
    p: Person | EntityPickerPersonSummary,
    linkedOrgsForPerson?: EntityPickerOrganisationSummary[] | Organisation[],
  ) => {
    setSelectedPeopleById((prev) => ({ ...prev, [p.id]: p }));
    setLinkedPersonId(p.id);
    setFirstName(p.firstName);
    setSurname(p.surname);
    const pEmail = primaryEmail(p);
    const pPhone = primaryPhone(p);
    if (pEmail) setProspectEmail(pEmail);
    if (pPhone) setProspectPhone(pPhone);

    const orgsList: Array<Organisation | EntityPickerOrganisationSummary> =
      linkedOrgsForPerson ??
      links
        .filter((l) => l.personId === p.id && l.isCurrent)
        .map((l) => orgsById.get(l.organisationId))
        .filter((o): o is Organisation | EntityPickerOrganisationSummary => Boolean(o));
    if (orgsList.length > 0) {
      setSelectedOrgsById((prev) => {
        const next = { ...prev };
        for (const o of orgsList) next[o.id] = o;
        return next;
      });
    }

    let nextOrgId = linkedOrganisationId;
    let nextOrgObj: Organisation | EntityPickerOrganisationSummary | null =
      linkedOrganisationId ? orgsById.get(linkedOrganisationId) ?? null : null;

    if (orgsList.length > 0 && !prospectOrganisationName.trim()) {
      setProspectOrganisationName(orgsList[0].legalName);
      setLinkedOrganisationId(orgsList[0].id);
      nextOrgId = orgsList[0].id;
      nextOrgObj = orgsList[0];
    } else if (p.id.startsWith('ENQ-') && !prospectOrganisationName.trim()) {
      const matchedEnq = enquiriesById.get(p.id);
      if (matchedEnq?.callingOnBehalfOf.trim()) {
        setProspectOrganisationName(matchedEnq.callingOnBehalfOf.trim());
        if (matchedEnq.linkedOrganisationId) {
          setLinkedOrganisationId(matchedEnq.linkedOrganisationId);
          nextOrgId = matchedEnq.linkedOrganisationId;
          nextOrgObj = orgsById.get(matchedEnq.linkedOrganisationId) ?? null;
        }
      }
    }

    setContactSearchDismissed(true);
    applyAutoEnquirySelectionForContact(p.id, nextOrgId, p, nextOrgObj);
    showToast(`Linked quote to ${personDisplayName(p)} (${p.id})`);
  };

  const linkExistingOrg = (o: Organisation | EntityPickerOrganisationSummary) => {
    setSelectedOrgsById((prev) => ({ ...prev, [o.id]: o }));
    setLinkedOrganisationId(o.id);
    setProspectOrganisationName(o.legalName);
    if (!prospectEmail.trim() && o.generalEmail) setProspectEmail(o.generalEmail);
    if (!prospectPhone.trim() && o.mainPhone) setProspectPhone(o.mainPhone);
    setContactSearchDismissed(true);
    const pObj = linkedPersonId ? peopleById.get(linkedPersonId) ?? null : null;
    applyAutoEnquirySelectionForContact(linkedPersonId, o.id, pObj, o);
    showToast(`Linked quote to ${o.legalName} (${o.id})`);
  };

  const filteredEnquiries = useMemo(() => {
    const q = enquirySearch.trim().toLowerCase();
    const remoteEnquiries = enquiryPickerItems
      .map((item) => item.enquiry)
      .filter((e): e is EntityPickerEnquirySummary => Boolean(e));
    const pool =
      activeEnquiriesForLinkedContact.length > 0 && !showAllEnquiriesInDropdown && !q
        ? activeEnquiriesForLinkedContact
        : Array.from(enquiriesById.values());
    const mergedPool = q
      ? Array.from(
          new Map<string, Enquiry | EntityPickerEnquirySummary>(
            [...remoteEnquiries, ...pool].map((e) => [e.id, e]),
          ).values(),
        )
      : pool;
    const list = mergedPool.filter((e) => {
      if (!q) return true;
      const hay = `${e.reference} ${e.firstName} ${e.lastName} ${e.callingOnBehalfOf} ${e.summary}`.toLowerCase();
      return hay.includes(q);
    });
    if (linkedEnquiryId && !list.some((e) => e.id === linkedEnquiryId)) {
      const sel = enquiriesById.get(linkedEnquiryId);
      if (sel) return [sel, ...list];
    }
    return list;
  }, [
    enquirySearch,
    enquiryPickerItems,
    activeEnquiriesForLinkedContact,
    showAllEnquiriesInDropdown,
    enquiriesById,
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

  const handleSubmit = (
    markAsSent: boolean,
    sendMode: 'email' | 'offline' = 'email',
  ) => {
    const combinedProspectName = [firstName.trim(), surname.trim()].filter(Boolean).join(' ');
    const resolvedClientType: 'existing' | 'prospect' =
      linkedOrganisationId || linkedPersonId ? 'existing' : 'prospect';

    let paymentOnAccountPence: number | null = null;
    let paymentOnAccountGbp: number | null = null;
    if (paymentOnAccountRequired) {
      const cleanPoa = paymentOnAccountGbpStr.trim();
      const poaNum = Number(cleanPoa);
      if (!cleanPoa || !Number.isFinite(poaNum) || poaNum <= 0) {
        showToast('Please enter a Payment on Account amount greater than £0.00.');
        return;
      }
      paymentOnAccountPence = poundsToMinorUnits(cleanPoa);
      if (paymentOnAccountPence <= 0) {
        showToast('Please enter a Payment on Account amount greater than £0.00.');
        return;
      }
      paymentOnAccountGbp = poaNum;
    }

    const linkedPersonRec = linkedPersonId ? peopleById.get(linkedPersonId) : undefined;
    const linkedOrgRec = linkedOrganisationId ? orgsById.get(linkedOrganisationId) : undefined;
    const linkedEmailFallback =
      (linkedPersonRec && 'emails' in linkedPersonRec ? primaryEmail(linkedPersonRec) : '') ||
      (linkedPersonRec && 'primaryEmail' in linkedPersonRec ? String(linkedPersonRec.primaryEmail ?? '') : '') ||
      (linkedOrgRec && 'generalEmail' in linkedOrgRec ? String(linkedOrgRec.generalEmail ?? '') : '');
    const effectiveRecipientEmail = (prospectEmail.trim() || linkedEmailFallback).trim();

    if (markAsSent && sendMode === 'email' && !effectiveRecipientEmail) {
      showToast('Please enter a client email address before sending the quote by email, or save and record it as sent offline.');
      return;
    }

    const executeSave = async (idempotencyKey?: string) => {
      setQuoteFeeCapError(null);
      const feeArrangementPayload = arrangementBasis
        ? {
            feeArrangementCapCategoryKey:
              arrangementCapResolution?.capCategoryKey ??
              arrangementMappedCategoryKey ??
              undefined,
            feeArrangementPercent: feeArrangementPercentNum,
            feeArrangementCapBaseKey:
              arrangementCapResolution?.capBaseKey ?? undefined,
          }
        : {};

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
          paymentOnAccountRequired,
          paymentOnAccountPence,
          paymentOnAccountGbp,
          priceTransparencyCustomNote: priceTransparencyCustomNote.trim() || null,
          scope,
          assumptions,
          validUntil,
          followUpAfterDays: Math.max(1, Number(followUpAfterDaysStr) || 7),
          revisionNote,
          markAsSent,
          ...(markAsSent ? { sendMode } : {}),
          ...(markAsSent && sendMode === 'email'
            ? {
                recipientEmail: effectiveRecipientEmail,
                idempotencyKey,
              }
            : {}),
          refreshVatRate,
          rateGradeKey,
          refreshRates,
          ...feeArrangementPayload,
        });
        if (res.error || !res.quote) {
          const errMsg = res.error ?? 'Failed to revise quote';
          setQuoteFeeCapError(errMsg);
          showToast(errMsg);
          return;
        }
        quoteSendControllerRef.current?.reset();
        showToast(
          markAsSent
            ? sendMode === 'email'
              ? res.emailProviderDisabled
                ? `Revised to v${res.quote.version} and queued in outbox (email delivery disabled)`
                : `Revised to v${res.quote.version} and sent by email`
              : `Revised to v${res.quote.version} and recorded as sent offline`
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
          paymentOnAccountRequired,
          paymentOnAccountPence,
          paymentOnAccountGbp,
          priceTransparencyCustomNote: priceTransparencyCustomNote.trim() || null,
          validUntil,
          feeEarnerId,
          followUpAfterDays: Math.max(1, Number(followUpAfterDaysStr) || 7),
          rateGradeKey,
          refreshRates,
          ...feeArrangementPayload,
        },
        {
          id: existing?.id,
          markAsSent,
          ...(markAsSent ? { sendMode } : {}),
          ...(markAsSent && sendMode === 'email'
            ? {
                recipientEmail: effectiveRecipientEmail,
                idempotencyKey,
              }
            : {}),
          refreshVatRate,
        },
      );

      if (res.error || !res.quote) {
        const errMsg = res.error ?? 'Could not save quote';
        setQuoteFeeCapError(errMsg);
        showToast(errMsg);
        return;
      }
      quoteSendControllerRef.current?.reset();

      showToast(
        markAsSent
          ? sendMode === 'email'
            ? res.emailProviderDisabled
              ? `Quote ${res.quote.reference} queued in outbox (email delivery disabled) · Follow-up scheduled for ${res.quote.nextFollowUpDate}`
              : `Quote ${res.quote.reference} sent by email · Follow-up scheduled for ${res.quote.nextFollowUpDate}`
            : `Quote ${res.quote.reference} recorded as sent offline · Follow-up scheduled for ${res.quote.nextFollowUpDate}`
          : `Quote ${res.quote.reference} saved`,
      );
      if (onSuccessOverride) {
        onSuccessOverride(res.quote);
      } else {
        router.push(`/quotes/${res.quote.id}`);
      }
    };

    startTransition(async () => {
      if (markAsSent && sendMode === 'email') {
        await getQuoteSendController().runGuarded(executeSave);
        return;
      }
      await executeSave();
    });
  };

  const isWorkTypeComplete = Boolean(practiceAreaId && scope.trim());
  const isFeesComplete = arrangementBasis
    ? Boolean(
        arrangementCapResolution &&
          feeArrangementPercentNum !== null &&
          feeArrangementPercentNum >= 0 &&
          feeArrangementPercentNum <=
            arrangementCapResolution.appliedCapPercent,
      )
    : Boolean(feeBasis && feeAmountStr.trim() !== '' && feeAmountNum > 0);

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
                  onBlur={triggerConflictCheck}
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
                  onBlur={triggerConflictCheck}
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
                  onBlur={triggerConflictCheck}
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
                  onBlur={triggerConflictCheck}
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
                  onBlur={triggerConflictCheck}
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
                <>
                  <div className="field-group">
                    <label className="field-label" htmlFor="qte-rate-grade">
                      Rate grade
                    </label>
                    <select
                      id="qte-rate-grade"
                      className="field-select"
                      value={rateGradeKey}
                      onChange={(e) => applyResolvedRateForGrade(e.target.value)}
                    >
                      <option value="partner">Partner</option>
                      <option value="associate">Associate</option>
                      <option value="trainee">Trainee</option>
                      {(resolvedRates?.customGrades ?? []).map((cg) => (
                        <option key={cg.id} value={cg.id}>
                          {cg.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field-group">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <label className="field-label" htmlFor="qte-hourly-rate">
                        Hourly rate (£/hr ex VAT)
                      </label>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ fontSize: 11, padding: '0 4px', minHeight: 18 }}
                        onClick={() => void refreshApplicableQuoteRates()}
                      >
                        <RefreshCw size={11} aria-hidden="true" />
                        <span>Apply hierarchy rate</span>
                      </button>
                    </div>
                    <input
                      id="qte-hourly-rate"
                      type="number"
                      min="0"
                      step="10"
                      className="field-input"
                      value={hourlyRateStr}
                      onChange={(e) => {
                        setHourlyRateManuallyEdited(true);
                        setHourlyRateStr(e.target.value);
                      }}
                    />
                    {(() => {
                      const activeGradeRes = resolvedRates?.grades?.[rateGradeKey];
                      const activeTier =
                        mode === 'edit' && !refreshRates
                          ? existing?.rateTier
                          : hourlyRateManuallyEdited
                            ? undefined
                            : (activeGradeRes?.tier ?? resolvedRates?.dominantTier);
                      const activeSource =
                        mode === 'edit' && !refreshRates
                          ? existing?.rateSource
                          : hourlyRateManuallyEdited
                            ? 'custom_override'
                            : (activeGradeRes?.source ?? resolvedRates?.dominantSource);
                      const parentName =
                        activeGradeRes?.inheritedFromParentOrganisationName ??
                        Object.values(
                          (mode === 'edit' && !refreshRates
                            ? existing?.rateProvenanceByGrade
                            : resolvedRates?.grades) ?? {},
                        ).find((g) => g.tier === 3 && g.inheritedFromParentOrganisationName)
                          ?.inheritedFromParentOrganisationName;
                      return activeSource ? (
                        <div style={{ marginTop: 4 }}>
                          <StatusPill
                            label={formatRateTierBadgeLabel(activeTier, activeSource, parentName)}
                            tone={
                              activeTier === 2 || activeTier === 3
                                ? 'positive'
                                : activeSource === 'custom_override'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          />
                        </div>
                      ) : null;
                    })()}
                  </div>
                </>
              ) : null}

              <div className="field-group">
                <label className="field-label" htmlFor="qte-fee-amount">
                  {arrangementBasis === 'damages_based_agreement'
                    ? 'Indicative base fee estimate (£ ex VAT, optional)'
                    : 'Professional fee (£ ex VAT)'}{' '}
                  {arrangementBasis === 'damages_based_agreement' ? null : (
                    <span className="required">*</span>
                  )}
                </label>
                <input
                  id="qte-fee-amount"
                  type="number"
                  min="0"
                  step="50"
                  className="field-input"
                  placeholder={
                    arrangementBasis === 'damages_based_agreement'
                      ? '0 (recovery-contingent)'
                      : 'e.g. 2850'
                  }
                  value={feeAmountStr}
                  onChange={(e) => setFeeAmountStr(e.target.value)}
                />
              </div>

              <div className="field-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="field-label" htmlFor="qte-vat-amount">
                    VAT{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (£ — standard {effectiveVatRatePercent}%)
                    </span>
                  </label>
                  {vatOverridden ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ fontSize: 11, padding: '0 4px', minHeight: 18 }}
                      onClick={() => setVatOverridden(false)}
                    >
                      Reset to {effectiveVatRatePercent}%
                    </button>
                  ) : null}
                </div>
                <input
                  id="qte-vat-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  className="field-input"
                  value={vatOverridden ? vatInputStr : String(effectiveVatOnFee)}
                  onChange={(e) => {
                    setVatOverridden(true);
                    setVatInputStr(e.target.value);
                  }}
                />
                {existing && existingVatRatePercent !== tenantVatRatePercent ? (
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      marginTop: 4,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={refreshVatRate}
                      onChange={(e) => setRefreshVatRate(e.target.checked)}
                    />
                    <span className="muted">
                      Update quote VAT rate from {existingVatRatePercent}% to current firm setting ({tenantVatRatePercent}%)
                    </span>
                  </label>
                ) : null}
              </div>
            </div>

            {arrangementBasis ? (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-surface-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    {arrangementBasis === 'conditional_fee_agreement'
                      ? 'Conditional Fee Agreement (CFA) Terms'
                      : 'Damages-Based Agreement (DBA) Terms'}
                  </strong>
                  {arrangementCapResolution ? (
                    <StatusPill
                      label={`Max ${arrangementCapResolution.appliedCapPercent}% (${
                        arrangementCapResolution.capLevel === 'work_type'
                          ? 'work type cap'
                          : arrangementCapResolution.capLevel === 'firm'
                            ? 'firm cap'
                            : 'statutory maximum'
                      })`}
                      tone="neutral"
                    />
                  ) : (
                    <StatusPill label="Unmapped work type" tone="warning" />
                  )}
                </div>

                {!arrangementCapResolution ? (
                  <div
                    role="alert"
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--status-warning, #d97706)',
                      background: 'rgba(217, 119, 6, 0.08)',
                      fontSize: 12.5,
                    }}
                  >
                    This work type does not have a mapped{' '}
                    {arrangementBasis === 'conditional_fee_agreement'
                      ? 'CFA'
                      : 'DBA'}{' '}
                    statutory cap category in Administration → Work types. Saving a quote on this fee basis will be blocked fail closed (<code>FEE_CAP_CATEGORY_UNMAPPED</code>).
                  </div>
                ) : (
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label" htmlFor="qte-fee-cap-percent">
                        {arrangementBasis === 'conditional_fee_agreement'
                          ? 'Success fee uplift (%)'
                          : 'Damages-based fee (%)'}{' '}
                        <span className="required">*</span>
                      </label>
                      <input
                        id="qte-fee-cap-percent"
                        type="number"
                        min={0}
                        max={arrangementCapResolution.appliedCapPercent}
                        step={0.5}
                        className="field-input"
                        placeholder={`Up to ${arrangementCapResolution.appliedCapPercent}%`}
                        value={feeArrangementPercentStr}
                        onChange={(e) => {
                          setQuoteFeeCapError(null);
                          setFeeArrangementPercentStr(e.target.value);
                        }}
                      />
                    </div>
                    <div className="field-group" style={{ gridColumn: 'span 2' }}>
                      <span className="field-label">Locked calculation base</span>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {arrangementCapResolution.capBaseDescription}{' '}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          ({arrangementCapResolution.caseTypeLabel} ·{' '}
                          <code>{arrangementCapResolution.capBaseKey}</code>)
                        </span>
                      </div>
                      <span className="field-hint">
                        Exceeding the {arrangementCapResolution.appliedCapPercent}% cap is blocked on save with no override path ({arrangementCapResolution.legislationRef}).
                      </span>
                    </div>
                  </div>
                )}

                {arrangementCapResolution &&
                feeArrangementPercentNum !== null &&
                feeArrangementPercentNum >
                  arrangementCapResolution.appliedCapPercent ? (
                  <div
                    role="alert"
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--status-alert)',
                      background: 'rgba(220, 38, 38, 0.08)',
                      color: 'var(--status-alert)',
                      fontSize: 12.5,
                    }}
                  >
                    Submitted percentage of {feeArrangementPercentNum}% exceeds the{' '}
                    {arrangementCapResolution.capLevel === 'work_type'
                      ? 'work type cap'
                      : arrangementCapResolution.capLevel === 'firm'
                        ? 'firm cap'
                        : 'statutory maximum'}{' '}
                    of {arrangementCapResolution.appliedCapPercent}% of{' '}
                    {arrangementCapResolution.capBaseDescription}.
                  </div>
                ) : null}

                {quoteFeeCapError ? (
                  <div
                    role="alert"
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--status-alert)',
                      background: 'rgba(220, 38, 38, 0.08)',
                      color: 'var(--status-alert)',
                      fontSize: 12.5,
                    }}
                  >
                    {quoteFeeCapError}
                  </div>
                ) : null}
              </div>
            ) : quoteFeeCapError ? (
              <div
                role="alert"
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--status-alert)',
                  background: 'rgba(220, 38, 38, 0.08)',
                  color: 'var(--status-alert)',
                  fontSize: 12.5,
                }}
              >
                {quoteFeeCapError}
              </div>
            ) : null}

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
                        <span>+ {effectiveVatRatePercent}% VAT</span>
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

            <hr
              style={{
                margin: '4px 0',
                border: 'none',
                borderTop: '1px solid var(--border-subtle)',
              }}
            />

            {/* Payment on Account on instruction */}
            <div style={{ display: 'grid', gap: 10 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="quote-poa-toggle"
                  checked={paymentOnAccountRequired}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setPaymentOnAccountRequired(checked);
                    if (!checked) setPaymentOnAccountGbpStr('');
                  }}
                />
                <span>Request a Payment on Account before work begins</span>
              </label>

              {paymentOnAccountRequired ? (
                <div className="field-group" style={{ maxWidth: 280, marginBottom: 0 }}>
                  <label className="field-label" htmlFor="qte-poa-amount">
                    Payment on Account amount (£) *
                  </label>
                  <input
                    id="qte-poa-amount"
                    data-testid="quote-poa-amount-input"
                    type="number"
                    min="0.01"
                    step="0.01"
                    className="field-input"
                    placeholder="e.g. 500.00"
                    value={paymentOnAccountGbpStr}
                    onChange={(e) => setPaymentOnAccountGbpStr(e.target.value)}
                  />
                  <span className="field-hint">
                    Carried over to the matter costs screen on conversion.
                  </span>
                </div>
              ) : null}
            </div>

            <hr
              style={{
                margin: '4px 0',
                border: 'none',
                borderTop: '1px solid var(--border-subtle)',
              }}
            />

            {/* Price Transparency Preview & Matter-specific custom note */}
            <div
              data-testid="quote-price-transparency-preview"
              style={{ display: 'grid', gap: 8 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span className="field-label" style={{ marginBottom: 0 }}>
                  Price Transparency disclosures ({resolvedPriceTransparency.enabled ? 'Included in PDF' : 'Turned off for work type'})
                </span>
                <StatusPill
                  label={
                    resolvedPriceTransparency.source === 'work_type'
                      ? 'Work type wording'
                      : resolvedPriceTransparency.source === 'practice_area'
                        ? 'Practice area wording'
                        : 'Firm default'
                  }
                  tone="neutral"
                />
              </div>
              {resolvedPriceTransparency.enabled ? (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-subtle)',
                    fontSize: 12.5,
                    display: 'grid',
                    gap: 4,
                  }}
                >
                  {resolvedPriceTransparency.headlineSummary ? (
                    <div><strong>Overview:</strong> {resolvedPriceTransparency.headlineSummary}</div>
                  ) : null}
                  {resolvedPriceTransparency.keyStages ? (
                    <div><strong>Key stages:</strong> {resolvedPriceTransparency.keyStages}</div>
                  ) : null}
                  {resolvedPriceTransparency.typicalTimescales ? (
                    <div><strong>Typical timescales:</strong> {resolvedPriceTransparency.typicalTimescales}</div>
                  ) : null}
                  {resolvedPriceTransparency.exclusionsAndVatNote ? (
                    <div><strong>VAT &amp; exclusions:</strong> {resolvedPriceTransparency.exclusionsAndVatNote}</div>
                  ) : null}
                </div>
              ) : null}
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="qte-pt-custom-note">
                  Additional matter-specific pricing note (optional)
                </label>
                <textarea
                  id="qte-pt-custom-note"
                  data-testid="quote-transparency-custom-note"
                  className="field-input"
                  rows={2}
                  placeholder="Optional note frozen into the sent quote snapshot and quote PDF…"
                  value={priceTransparencyCustomNote}
                  onChange={(e) => setPriceTransparencyCustomNote(e.target.value)}
                />
              </div>
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
              className="btn btn--secondary"
              style={{ borderRadius: 999 }}
              data-testid="quote-form-save-offline-btn"
              disabled={pending}
              onClick={() => handleSubmit(true, 'offline')}
            >
              {mode === 'revise'
                ? `Save v${(existing?.version ?? 1) + 1} offline`
                : 'Record as sent offline'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              style={{ borderRadius: 999 }}
              data-testid="quote-form-send-email-btn"
              disabled={pending}
              onClick={() => handleSubmit(true, 'email')}
            >
              {mode === 'revise'
                ? `Revise v${(existing?.version ?? 1) + 1} & send email`
                : emailProviderDisabled
                  ? 'Save & queue quote email'
                  : 'Save & send quote by email'}
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
              ) : fastError || conflictError ? (
                <span className="new-enquiry-badge new-enquiry-badge--warn">
                  Check failed
                </span>
              ) : loadingFast || loadingConflicts ? (
                <span className="new-enquiry-badge">Checking…</span>
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
              {fastError || conflictError ? (
                <div className="banner banner--warning" role="alert">
                  <div style={{ flex: 1 }}>
                    <span>{conflictError ?? fastError}</span>
                  </div>
                  <div className="banner__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        if (fastError) retryFastCheck();
                        if (conflictError) retryConflictCheck();
                      }}
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : null}

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
                    label={`Linked: ${(peopleById.get(linkedPersonId) ? personDisplayName(peopleById.get(linkedPersonId)!) : '') || linkedPersonId}`}
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
                    label={`Linked: ${orgsById.get(linkedOrganisationId)?.legalName ?? linkedOrganisationId}`}
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

              {shouldShowNoMatchesMessage({
                hasSearchInputs,
                loadingFast,
                loadingConflicts,
                fastError,
                conflictError,
                matchCount: distinctMatchedCount,
              }) ? (
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
                      hit.recordType === 'person' ? peopleById.get(hit.recordId) : undefined;
                    const org =
                      hit.recordType === 'organisation'
                        ? orgsById.get(hit.recordId)
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
              {arrangementBasis && arrangementCapResolution ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="muted">Agreed % &amp; base</span>
                  <span style={{ textAlign: 'right', fontSize: 12.5 }}>
                    <strong>
                      {feeArrangementPercentNum !== null
                        ? `${feeArrangementPercentNum}%`
                        : '—'}
                    </strong>{' '}
                    of {arrangementCapResolution.capBaseDescription}
                  </span>
                </div>
              ) : null}
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
                <span className="muted">
                  VAT on professional fee ({vatOverridden ? 'overridden' : `${effectiveVatRatePercent}%`})
                </span>
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
              {paymentOnAccountRequired && Number(paymentOnAccountGbpStr) > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13,
                    paddingTop: 4,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>Payment on Account (on instruction)</span>
                  <strong>{formatGbp(Number(paymentOnAccountGbpStr), true)}</strong>
                </div>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
