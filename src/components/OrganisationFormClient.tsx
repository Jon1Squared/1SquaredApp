'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { saveOrganisationAction } from '@/app/actions';
import {
  DEMO_COMPANIES_HOUSE_RECORDS,
  searchCompaniesHouseDemo,
  type CompaniesHouseCompanyRecord,
} from '@/domain/companiesHouse';
import { findOrganisationDuplicates, formatDuplicateReasons } from '@/domain/duplicates';
import {
  detectPreliminaryConflicts,
  findEnquiryEntityMatches,
  hasQuickConflictCheckInputs,
  mergePeopleWithEnquiries,
} from '@/domain/enquiries';
import { InfoPopover } from './InfoPopover';
import { resolveLabel, valueBySystemKey, valuesForList } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
import type {
  Address,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  Enquiry,
  Matter,
  Organisation,
  OtherName,
  Person,
} from '@/domain/types';
import {
  ChoiceMultiGroup,
  ChoiceSelect,
  CustomFieldsFormSection,
  EmployeeSelect,
  SingleAddressEditor,
} from './FormControls';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  existing?: Organisation | null;
  allOrganisations: Organisation[];
  allPeople?: Person[];
  matters?: Matter[];
  enquiries?: Enquiry[];
  employees: Person[];
  lists: ChoiceList[];
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  currentUserId: string;
  tenantId: string;
  embeddedInModal?: boolean;
  nameOnlyMandatory?: boolean;
  modalTitle?: string;
  modalSubmitLabel?: string;
  modalCancelLabel?: string;
  modalSelectExistingLabel?: (org: Organisation) => string;
  topSlot?: React.ReactNode;
  highlightMissingClientFields?: boolean;
  initialLegalName?: string;
  initialCompanyNumber?: string;
  onCancelModal?: () => void;
  onSelectExistingOrganisation?: (org: Organisation) => void;
  onOrganisationCreated?: (org: Organisation) => void;
}

type OrgTabKey = 'most_used' | 'identity' | 'commercial' | 'compliance' | 'custom';

export function OrganisationFormClient({
  existing,
  allOrganisations,
  allPeople = [],
  matters = [],
  enquiries = [],
  employees,
  lists,
  values,
  customFields,
  currentUserId,
  tenantId,
  embeddedInModal = false,
  nameOnlyMandatory = false,
  modalTitle,
  modalSubmitLabel,
  modalCancelLabel,
  modalSelectExistingLabel,
  topSlot,
  highlightMissingClientFields = false,
  initialLegalName,
  initialCompanyNumber,
  onCancelModal,
  onSelectExistingOrganisation,
  onOrganisationCreated,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [continueAnyway, setContinueAnyway] = useState(false);

  const defaultCountryId = useMemo(
    () =>
      valuesForList(values, 'country').find((v) => v.label === 'England and Wales')?.id ??
      valuesForList(values, 'country').find((v) => v.label === 'Wales')?.id ??
      valuesForList(values, 'country').find((v) => v.label === 'United Kingdom')?.id ??
      null,
    [values],
  );
  const defaultActiveStatus = useMemo(
    () => valueBySystemKey(values, 'organisation_record_status', 'active')?.id ?? '',
    [values],
  );
  const defaultRelStatus = useMemo(
    () => valuesForList(values, 'relationship_status').find((v) => v.label === 'Active')?.id ?? null,
    [values],
  );
  const defaultOnboarding = useMemo(
    () =>
      valuesForList(values, 'onboarding_status').find((v) => v.label === 'Not started')?.id ?? null,
    [values],
  );
  const defaultConflict = useMemo(
    () =>
      valueBySystemKey(values, 'conflict_status', 'not_checked')?.id ??
      valuesForList(values, 'conflict_status')[0]?.id ??
      null,
    [values],
  );
  const defaultRiskAssessment = useMemo(
    () =>
      valuesForList(values, 'risk_assessment_status').find((v) => v.label === 'Not started')?.id ??
      null,
    [values],
  );
  const defaultVerification = useMemo(
    () =>
      valueBySystemKey(values, 'verification_status', 'not_started')?.id ??
      valuesForList(values, 'verification_status')[0]?.id ??
      null,
    [values],
  );
  const defaultSource = useMemo(
    () => valuesForList(values, 'data_source').find((v) => v.label === 'Manual entry')?.id ?? null,
    [values],
  );
  const formerNameTypeId = useMemo(() => {
    const listCandidates = [
      ...valuesForList(values, 'org_other_name_type'),
      ...valuesForList(values, 'org_name_type'),
    ];
    return (
      listCandidates.find((v) => v.label.toLowerCase().includes('former'))?.id ??
      listCandidates[0]?.id ??
      null
    );
  }, [values]);

  // Split existing otherNames into former names (in Mandatory section) vs trading/other names
  const initialFormerNames = useMemo(() => {
    const all = existing?.otherNames ?? [];
    const matching = all.filter((n) => {
      if (!n.typeId) return true;
      const lbl = (resolveLabel(values, n.typeId) || '').toLowerCase();
      return lbl.includes('former') || n.typeId === formerNameTypeId;
    });
    return matching.length > 0
      ? matching.map((n) => n.name)
      : [''];
  }, [existing?.otherNames, values, formerNameTypeId]);

  const initialTradingNames = useMemo(() => {
    const all = existing?.otherNames ?? [];
    return all.filter((n) => {
      if (!n.typeId) return false;
      const lbl = (resolveLabel(values, n.typeId) || '').toLowerCase();
      return !lbl.includes('former') && n.typeId !== formerNameTypeId;
    });
  }, [existing?.otherNames, values, formerNameTypeId]);

  // 1 · MANDATORY DETAILS state
  const [legalName, setLegalName] = useState(existing?.legalName ?? initialLegalName ?? '');
  const [chDropdownOpen, setChDropdownOpen] = useState(false);
  const chWrapRef = useRef<HTMLDivElement | null>(null);
  const [organisationTypeId, setOrganisationTypeId] = useState<string | null>(
    existing?.organisationTypeId ?? null,
  );
  const [companyNumber, setCompanyNumber] = useState(
    existing?.companyNumber ?? initialCompanyNumber ?? '',
  );
  const [registeredAddress, setRegisteredAddress] = useState<Address | null>(
    existing?.registeredAddress ?? null,
  );
  const [formerNames, setFormerNames] = useState<string[]>(initialFormerNames);
  const [pscList, setPscList] = useState<string[]>(
    existing?.peopleWithSignificantControl && existing.peopleWithSignificantControl.length > 0
      ? existing.peopleWithSignificantControl
      : [''],
  );
  const [directorsList, setDirectorsList] = useState<string[]>(
    existing?.directors && existing.directors.length > 0
      ? existing.directors
      : [''],
  );

  // Additional Identity, Contact & Correspondence Address
  const [tradingNames, setTradingNames] = useState<OtherName[]>(initialTradingNames);
  const [vatNumber, setVatNumber] = useState(existing?.vatNumber ?? '');
  const [countryOfRegistrationId, setCountryOfRegistrationId] = useState<string | null>(
    existing?.countryOfRegistrationId ?? defaultCountryId,
  );
  const [correspondenceAddress, setCorrespondenceAddress] = useState<Address | null>(
    existing?.correspondenceAddress ?? null,
  );
  const [website, setWebsite] = useState(existing?.website ?? '');
  const [mainPhone, setMainPhone] = useState(existing?.mainPhone ?? '');
  const [generalEmail, setGeneralEmail] = useState(existing?.generalEmail ?? '');
  const [parentOrganisationId, setParentOrganisationId] = useState<string | null>(
    existing?.parentOrganisationId ?? null,
  );

  // Commercial relationship
  const [relationshipPartnerId, setRelationshipPartnerId] = useState<string | null>(
    existing?.relationshipPartnerId ?? currentUserId,
  );
  const [relationshipTypeIds, setRelationshipTypeIds] = useState<string[]>(
    existing?.relationshipTypeIds ?? [],
  );
  const [relationshipStatusId, setRelationshipStatusId] = useState<string | null>(
    existing?.relationshipStatusId ?? defaultRelStatus,
  );
  const [relationshipStandingId, setRelationshipStandingId] = useState<string | null>(
    existing?.relationshipStandingId ?? null,
  );
  const [sectorId, setSectorId] = useState<string | null>(existing?.sectorId ?? null);
  const [clientTierId, setClientTierId] = useState<string | null>(existing?.clientTierId ?? null);
  const [originId, setOriginId] = useState<string | null>(existing?.originId ?? null);
  const [relationshipStartedAt, setRelationshipStartedAt] = useState(
    existing?.relationshipStartedAt ?? '',
  );
  const [lastInteractionAt, setLastInteractionAt] = useState(existing?.lastInteractionAt ?? '');
  const [engagementLevelId, setEngagementLevelId] = useState<string | null>(
    existing?.engagementLevelId ?? null,
  );
  const [pipelineStageId, setPipelineStageId] = useState<string | null>(
    existing?.pipelineStageId ?? null,
  );
  const [bdNotes, setBdNotes] = useState(existing?.bdNotes ?? '');

  // Legal, financial and compliance
  const [recordStatusId, setRecordStatusId] = useState(
    existing?.recordStatusId ?? defaultActiveStatus,
  );
  const [recordOwnerId, setRecordOwnerId] = useState<string | null>(
    existing?.recordOwnerId ?? currentUserId,
  );
  const [clientReference, setClientReference] = useState(existing?.clientReference ?? '');
  const [onboardingStatusId, setOnboardingStatusId] = useState<string | null>(
    existing?.onboardingStatusId ?? defaultOnboarding,
  );
  const [conflictStatusId, setConflictStatusId] = useState<string | null>(
    existing?.conflictStatusId ?? defaultConflict,
  );
  const [conflictReference, setConflictReference] = useState(existing?.conflictReference ?? '');
  const [riskRatingId, setRiskRatingId] = useState<string | null>(existing?.riskRatingId ?? null);
  const [riskAssessmentStatusId, setRiskAssessmentStatusId] = useState<string | null>(
    existing?.riskAssessmentStatusId ?? defaultRiskAssessment,
  );
  const [verificationStatusId, setVerificationStatusId] = useState<string | null>(
    existing?.verificationStatusId ?? defaultVerification,
  );
  const [billingAddress, setBillingAddress] = useState<Address | null>(
    existing?.billingAddress ?? null,
  );
  const [invoicePreferenceId, setInvoicePreferenceId] = useState<string | null>(
    existing?.invoicePreferenceId ?? null,
  );
  const [paymentTermsId, setPaymentTermsId] = useState<string | null>(
    existing?.paymentTermsId ?? null,
  );
  const [creditControlNotes, setCreditControlNotes] = useState(
    existing?.creditControlNotes ?? '',
  );
  const [engagementTermsRef, setEngagementTermsRef] = useState(
    existing?.engagementTermsRef ?? '',
  );
  const [reviewDate, setReviewDate] = useState(existing?.reviewDate ?? '');
  const [reviewerId, setReviewerId] = useState<string | null>(existing?.reviewerId ?? null);
  const [sourceId, setSourceId] = useState<string | null>(existing?.sourceId ?? defaultSource);
  const [lastVerifiedAt, setLastVerifiedAt] = useState(
    existing?.lastVerifiedAt ?? new Date().toISOString().slice(0, 10),
  );
  const [tagsText, setTagsText] = useState((existing?.tags ?? []).join(', '));

  // Custom fields
  const [cfValues, setCfValues] = useState<Record<string, unknown>>(existing?.customFields ?? {});

  const orgCustomDefs = useMemo(
    () => customFields.filter((d) => d.recordType === 'organisation'),
    [customFields],
  );

  // Active tab in "2 · MORE DETAILS"
  const [activeTab, setActiveTab] = useState<OrgTabKey>('most_used');

  useEffect(() => {
    if (!chDropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (chWrapRef.current && !chWrapRef.current.contains(e.target as Node)) {
        setChDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [chDropdownOpen]);

  const chResults = useMemo(() => {
    const q = legalName.trim();
    if (q.length >= 2) {
      return searchCompaniesHouseDemo(q);
    }
    return DEMO_COMPANIES_HOUSE_RECORDS;
  }, [legalName]);

  const handleSelectCompaniesHouseRecord = (rec: CompaniesHouseCompanyRecord) => {
    setLegalName(rec.companyName);
    setCompanyNumber(rec.companyNumber);

    const orgTypes = valuesForList(values, 'organisation_type');
    const matchedOrgType =
      orgTypes.find(
        (v) => v.label.toLowerCase() === rec.organisationTypeLabel.toLowerCase(),
      ) ??
      orgTypes.find((v) =>
        v.label.toLowerCase().includes(rec.organisationTypeLabel.toLowerCase()),
      );
    if (matchedOrgType) {
      setOrganisationTypeId(matchedOrgType.id);
    }

    const countries = valuesForList(values, 'country');
    const matchedCountry =
      countries.find(
        (c) =>
          c.label.toLowerCase() ===
          rec.registeredOfficeAddress.country.toLowerCase(),
      ) ??
      countries.find(
        (c) =>
          c.label === 'United Kingdom' ||
          c.label === 'England and Wales' ||
          c.label === 'Wales',
      );
    const addrTypes = valuesForList(values, 'address_type');
    const regOfficeTypeId =
      addrTypes.find((t) => t.label.toLowerCase().includes('registered'))?.id ??
      null;

    setRegisteredAddress({
      id: registeredAddress?.id ?? `addr-ch-${rec.companyNumber}`,
      typeId: regOfficeTypeId,
      line1: rec.registeredOfficeAddress.line1,
      line2: rec.registeredOfficeAddress.line2,
      town: rec.registeredOfficeAddress.town,
      county: rec.registeredOfficeAddress.county,
      postcode: rec.registeredOfficeAddress.postcode,
      countryId: matchedCountry?.id ?? defaultCountryId,
    });
    if (matchedCountry) {
      setCountryOfRegistrationId(matchedCountry.id);
    }

    setFormerNames(rec.formerNames.length > 0 ? rec.formerNames : ['']);
    setPscList(
      rec.peopleWithSignificantControl.length > 0
        ? rec.peopleWithSignificantControl
        : [''],
    );
    setDirectorsList(rec.directors.length > 0 ? rec.directors : ['']);
    setChDropdownOpen(false);
    showToast(
      `Auto-completed company details from Companies House (${rec.companyNumber})`,
    );
  };

  const cleanFormerNames = useMemo(
    () => formerNames.map((n) => n.trim()).filter(Boolean),
    [formerNames],
  );
  const cleanPscs = useMemo(
    () => pscList.map((n) => n.trim()).filter(Boolean),
    [pscList],
  );
  const cleanDirectors = useMemo(
    () => directorsList.map((n) => n.trim()).filter(Boolean),
    [directorsList],
  );

  const combinedOtherNames: OtherName[] = useMemo(() => {
    const fromFormer: OtherName[] = cleanFormerNames.map((name, i) => ({
      id: `fn-${i}-${name}`,
      name,
      typeId: formerNameTypeId,
    }));
    const fromTrading = tradingNames.filter((t) => t.name.trim().length > 0);
    return [...fromFormer, ...fromTrading];
  }, [cleanFormerNames, formerNameTypeId, tradingNames]);

  // Live duplicate check while typing
  const liveDuplicates = useMemo(
    () =>
      findOrganisationDuplicates(
        {
          id: existing?.id,
          legalName,
          otherNames: combinedOtherNames.map((n) => n.name),
          companyNumber,
          emails: generalEmail.trim() ? [generalEmail] : [],
          phones: mainPhone.trim() ? [mainPhone] : [],
          addresses: [registeredAddress, correspondenceAddress].filter(
            (a): a is Address => Boolean(a && a.line1.trim() && a.postcode.trim()),
          ),
        },
        allOrganisations,
        existing?.notDuplicateOf,
        { fuzzy: true },
      ).filter((m) => m.reasons.some((r) => r !== 'address' && r !== 'postcode')),
    [
      existing?.id,
      existing?.notDuplicateOf,
      legalName,
      combinedOtherNames,
      companyNumber,
      generalEmail,
      mainPhone,
      registeredAddress,
      correspondenceAddress,
      allOrganisations,
    ],
  );

  const mergedAllPeople = useMemo(
    () => mergePeopleWithEnquiries(allPeople, enquiries, values),
    [allPeople, enquiries, values],
  );

  // Quick Conflict Check (right-hand panel, working in the exact same way as Enquiry & Person screens)
  const otherOrganisations = useMemo(
    () =>
      existing
        ? allOrganisations.filter((o) => o.id !== existing.id)
        : allOrganisations,
    [allOrganisations, existing],
  );

  const otherPartiesQuery = useMemo(
    () => [...cleanFormerNames, ...cleanPscs, ...cleanDirectors].join(', '),
    [cleanFormerNames, cleanPscs, cleanDirectors],
  );

  const entityMatches = useMemo(
    () =>
      findEnquiryEntityMatches(
        {
          firstName: '',
          lastName: '',
          callingOnBehalfOf: legalName,
          email: generalEmail,
          phone: mainPhone,
          postcode: registeredAddress?.postcode ?? '',
          addressLine1: registeredAddress?.line1 ?? '',
          addressLine2: registeredAddress?.line2 ?? '',
        },
        mergedAllPeople,
        otherOrganisations,
        enquiries,
      ),
    [legalName, generalEmail, mainPhone, registeredAddress, mergedAllPeople, otherOrganisations, enquiries],
  );

  const possibleConflicts = useMemo(
    () =>
      detectPreliminaryConflicts(
        {
          firstName: '',
          lastName: '',
          callingOnBehalfOf: legalName,
          otherPartiesNamed: otherPartiesQuery,
          email: generalEmail,
          phone: mainPhone,
          address: {
            line1: registeredAddress?.line1 ?? '',
            line2: registeredAddress?.line2 ?? '',
            postcode: registeredAddress?.postcode ?? '',
          },
          linkedPersonId: null,
          linkedOrganisationId: null,
        },
        mergedAllPeople,
        otherOrganisations,
        matters,
        values,
        enquiries,
        null,
        undefined,
        undefined,
        tenantId,
      ),
    [
      legalName,
      otherPartiesQuery,
      generalEmail,
      mainPhone,
      registeredAddress,
      mergedAllPeople,
      otherOrganisations,
      matters,
      values,
      enquiries,
      tenantId,
    ],
  );

  const conflictKeys = useMemo(
    () => new Set(possibleConflicts.map((h) => `${h.recordType}:${h.recordId}`)),
    [possibleConflicts],
  );

  const knownPeople = useMemo(
    () => entityMatches.people.filter((m) => !conflictKeys.has(`person:${m.person.id}`)),
    [entityMatches.people, conflictKeys],
  );

  const knownOrganisations = useMemo(
    () =>
      entityMatches.organisations.filter(
        (m) => !conflictKeys.has(`organisation:${m.organisation.id}`),
      ),
    [entityMatches.organisations, conflictKeys],
  );

  const hasConflictInputs = useMemo(
    () =>
      hasQuickConflictCheckInputs({
        firstName: '',
        lastName: '',
        callingOnBehalfOf: legalName,
        otherPartiesNamed: otherPartiesQuery,
        email: generalEmail,
        phone: mainPhone,
        postcode: registeredAddress?.postcode ?? '',
      }) ||
      Boolean(
        registeredAddress?.line1.trim() && registeredAddress?.postcode.trim(),
      ),
    [legalName, otherPartiesQuery, generalEmail, mainPhone, registeredAddress],
  );

  const hasHighSeverityConflict = useMemo(
    () => possibleConflicts.some((h) => h.severity === 'high' || h.blocking),
    [possibleConflicts],
  );

  const distinctMatchedCount =
    conflictKeys.size + knownPeople.length + knownOrganisations.length;

  const mandatoryComplete = nameOnlyMandatory
    ? Boolean(legalName.trim())
    : Boolean(
        legalName.trim() &&
          organisationTypeId &&
          companyNumber.trim() &&
          registeredAddress?.line1.trim() &&
          registeredAddress?.postcode.trim(),
      );

  const submitOrganisation = (forceFlagDuplicate = false) => {
    setErrorMsg(null);

    if (!legalName.trim()) {
      setErrorMsg('Full legal name is required.');
      return;
    }

    const shouldFlagDuplicate =
      forceFlagDuplicate || (continueAnyway && liveDuplicates.length > 0);

    startTransition(async () => {
      const res = await saveOrganisationAction(
        {
          legalName: legalName.trim(),
          otherNames: combinedOtherNames,
          organisationTypeId,
          companyNumber: companyNumber.trim(),
          vatNumber: vatNumber.trim(),
          countryOfRegistrationId,
          registeredAddress,
          correspondenceAddress,
          peopleWithSignificantControl: cleanPscs,
          directors: cleanDirectors,
          website: website.trim(),
          mainPhone: mainPhone.trim(),
          generalEmail: generalEmail.trim(),
          parentOrganisationId,
          relationshipPartnerId,
          relationshipTypeIds,
          relationshipStatusId,
          relationshipStandingId,
          sectorId,
          clientTierId,
          originId,
          relationshipStartedAt: relationshipStartedAt || null,
          lastInteractionAt: lastInteractionAt || null,
          engagementLevelId,
          pipelineStageId,
          bdNotes,
          recordStatusId,
          recordOwnerId,
          clientReference: clientReference.trim(),
          onboardingStatusId,
          conflictStatusId,
          conflictReference: conflictReference.trim(),
          riskRatingId,
          riskAssessmentStatusId,
          verificationStatusId,
          billingAddress,
          invoicePreferenceId,
          paymentTermsId,
          creditControlNotes,
          engagementTermsRef,
          reviewDate: reviewDate || null,
          reviewerId,
          sourceId,
          lastVerifiedAt: lastVerifiedAt || null,
          tags: tagsText
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
        {
          id: existing?.id,
          customFieldsSubmitted: cfValues,
          flagPossibleDuplicate: shouldFlagDuplicate,
          matchedDuplicateIds: shouldFlagDuplicate
            ? liveDuplicates.map((m) => m.record.id)
            : undefined,
        },
      );

      if (res.errors && Object.keys(res.errors).length > 0) {
        setErrorMsg(Object.values(res.errors).join(' '));
        return;
      }

      if (onOrganisationCreated) {
        onOrganisationCreated(res.organisation);
        return;
      }

      showToast('Organisation saved');
      router.push(`/organisations/${res.organisation.id}`);
    });
  };

  const handleSubmit = (e: React.FormEvent, forceFlagDuplicate = false) => {
    e.preventDefault();
    submitOrganisation(forceFlagDuplicate);
  };

  const entityReasonsByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of entityMatches.people) {
      map.set(`person:${p.person.id}`, p.formattedReasons);
    }
    for (const o of entityMatches.organisations) {
      map.set(`organisation:${o.organisation.id}`, o.formattedReasons);
    }
    return map;
  }, [entityMatches]);

  return (
    <div className="new-enquiry-page" style={embeddedInModal ? { padding: 0, maxWidth: 'none' } : undefined}>
      <datalist id="org-known-people-list">
        {mergedAllPeople
          .filter((p) => !p.mergedIntoId && !p.isEmployee)
          .map((p) => (
            <option key={p.id} value={personDisplayName(p)} />
          ))}
      </datalist>

      <form onSubmit={(e) => handleSubmit(e, liveDuplicates.length > 0)}>
        <div className="person-form-layout">
          {/* ================================================================
              LEFT COLUMN (~65%): 1 · MANDATORY DETAILS + EXPANDABLE SECTIONS
              ================================================================ */}
          <div className="person-form-main-col">
            {/* Header Row matching New Person & New Enquiry */}
            <div
              className="new-enquiry-header"
              style={embeddedInModal ? { marginBottom: 0, minHeight: 40 } : { marginBottom: 0 }}
            >
              <div style={{ width: '100%' }}>
                {!embeddedInModal ? (
                  <Link
                    href={existing ? `/organisations/${existing.id}` : '/organisations'}
                    className="new-enquiry-back"
                  >
                    ← Back to {existing ? existing.legalName : 'organisations'}
                  </Link>
                ) : null}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <h1 className="new-enquiry-title">
                    {modalTitle ?? (existing ? `Edit ${existing.legalName}` : 'Add an organisation')}
                  </h1>
                </div>
              </div>
            </div>

            {liveDuplicates.length > 0 ? (
              <div className="banner banner--warning" role="alert" style={{ marginBottom: 0 }}>
                <div>
                  <strong>Possible duplicate detected</strong>{' '}
                  <InfoPopover
                    label="About duplicate checks"
                    title="How duplicate checks work"
                    docHref="/docs/duplicate-checks"
                    docLabel="Read about duplicate checks"
                  >
                    <p>
                      Existing records are compared on name (including misspellings and names that sound
                      alike), company number, email, phone and address.
                    </p>
                  </InfoPopover>{' '}
                  {liveDuplicates.map((m, idx) => (
                    <span key={m.record.id}>
                      {idx > 0 ? '; ' : ''}
                      <strong>{m.record.legalName}</strong> ({m.record.id}
                      {m.record.companyNumber ? `, Co. No. ${m.record.companyNumber}` : ''}) —{' '}
                      {formatDuplicateReasons(m.reasons)}
                    </span>
                  ))}
                  {continueAnyway ? (
                    <div style={{ marginTop: 4 }}>
                      Continuing anyway — saving will flag this record as a{' '}
                      <strong>Possible match</strong> for review.
                    </div>
                  ) : null}
                </div>
                <div className="banner__actions">
                  {onSelectExistingOrganisation ? (
                    liveDuplicates.map((m) => (
                      <button
                        key={`add-org-dup-${m.record.id}`}
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => onSelectExistingOrganisation(m.record)}
                      >
                        {modalSelectExistingLabel
                          ? modalSelectExistingLabel(m.record)
                          : `Add ${m.record.legalName} as client`}
                      </button>
                    ))
                  ) : (
                    <Link
                      href={`/organisations/${liveDuplicates[0].record.id}`}
                      className="btn btn--secondary btn--sm"
                    >
                      Open record
                    </Link>
                  )}
                  {!continueAnyway ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setContinueAnyway(true)}
                    >
                      Continue anyway
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {errorMsg ? (
              <div className="banner banner--alert" role="alert" style={{ marginBottom: 0 }}>
                <span>{errorMsg}</span>
              </div>
            ) : null}

            {topSlot}
            <section className="new-enquiry-card" aria-labelledby="org-mandatory-heading">
              <div className="new-enquiry-card__top">
                <h2 id="org-mandatory-heading" className="new-enquiry-card__label">
                  1 · MANDATORY DETAILS
                </h2>
                <span
                  className={`new-enquiry-badge ${mandatoryComplete ? 'new-enquiry-badge--ok' : ''}`}
                >
                  {mandatoryComplete ? 'Complete' : 'Required'}
                </span>
              </div>

              <div className="form-grid-3" style={{ marginTop: 4 }}>
                {/* 1. Full legal name (with Companies House lookup) */}
                <div className="field-group field-group--full">
                  <label className="field-label" htmlFor="org-legal">
                    Full legal name <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>

                  <div ref={chWrapRef} style={{ position: 'relative' }}>
                    <div className="new-enquiry-postcode-row">
                      <input
                        id="org-legal"
                        type="text"
                        required
                        autoComplete="off"
                        className="field-input"
                        placeholder="Search Companies House or type full legal name…"
                        value={legalName}
                        onFocus={() => {
                          if (legalName.trim().length >= 2) {
                            setChDropdownOpen(true);
                          }
                        }}
                        onChange={(e) => {
                          const val = e.target.value;
                          setLegalName(val);
                          setChDropdownOpen(val.trim().length >= 2);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary"
                        style={{ borderRadius: 999, padding: '0 16px', flexShrink: 0 }}
                        onClick={() => setChDropdownOpen((prev) => !prev)}
                      >
                        Search Companies House
                      </button>
                    </div>

                    {chDropdownOpen ? (
                      <div
                        role="listbox"
                        aria-label="Companies House search results"
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 4px)',
                          left: 0,
                          right: 0,
                          zIndex: 60,
                          background: 'var(--surface, #fff)',
                          border: '1px solid var(--border, #e2e8f0)',
                          borderRadius: 10,
                          boxShadow: '0 12px 28px -6px rgba(15, 23, 42, 0.16)',
                          maxHeight: 300,
                          overflowY: 'auto',
                          padding: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '4px 10px 6px',
                            borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: '0.05em',
                            textTransform: 'uppercase',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <span>Companies House Registry (Demo)</span>
                          <span>Click to auto-complete 6 fields</span>
                        </div>
                        {chResults.map((rec) => (
                          <button
                            key={rec.companyNumber}
                            type="button"
                            role="option"
                            aria-selected={false}
                            onClick={() => handleSelectCompaniesHouseRecord(rec)}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 10px',
                              border: 'none',
                              background: 'transparent',
                              borderRadius: 6,
                              cursor: 'pointer',
                              color: 'var(--ink, #0f172a)',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background =
                                'var(--surface-subtle, #f1f5f9)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'transparent';
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                width: '100%',
                              }}
                            >
                              <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                                {rec.companyName}
                              </span>
                              <span
                                style={{
                                  fontSize: 11.5,
                                  fontWeight: 600,
                                  color: 'var(--teal, #0d9488)',
                                  flexShrink: 0,
                                }}
                              >
                                Co. No. {rec.companyNumber} · {rec.companyStatus}
                              </span>
                            </div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {rec.companyTypeDescription} ·{' '}
                              {[
                                rec.registeredOfficeAddress.line1,
                                rec.registeredOfficeAddress.town,
                                rec.registeredOfficeAddress.postcode,
                              ]
                                .filter(Boolean)
                                .join(', ')}
                            </div>
                            <div className="muted" style={{ fontSize: 11.5 }}>
                              {rec.directors.length} director
                              {rec.directors.length === 1 ? '' : 's'} ·{' '}
                              {rec.peopleWithSignificantControl.length} PSC
                              {rec.peopleWithSignificantControl.length === 1 ? '' : 's'}
                              {rec.formerNames.length > 0
                                ? ` · Former: ${rec.formerNames.join(', ')}`
                                : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* 2. Organisation type */}
                <div
                  className="field-group"
                  style={
                    highlightMissingClientFields && !organisationTypeId
                      ? {
                          padding: 8,
                          borderRadius: 8,
                          border: '1.5px solid #d93025',
                          background: 'rgba(217, 48, 37, 0.04)',
                        }
                      : undefined
                  }
                >
                  <label
                    className="field-label"
                    htmlFor="org-type"
                    style={
                      highlightMissingClientFields && !organisationTypeId
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Organisation type{' '}
                    {!nameOnlyMandatory ? <span style={{ color: 'var(--coral)' }}>*</span> : null}
                  </label>
                  <ChoiceSelect
                    id="org-type"
                    listKey="organisation_type"
                    values={values}
                    value={organisationTypeId}
                    onChange={setOrganisationTypeId}
                  />
                </div>

                {/* 3. Company registration number */}
                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="org-company-no"
                    style={
                      highlightMissingClientFields && !companyNumber.trim()
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Company registration number{' '}
                    {!nameOnlyMandatory ? <span style={{ color: 'var(--coral)' }}>*</span> : null}
                  </label>
                  <input
                    id="org-company-no"
                    type="text"
                    className="field-input"
                    style={
                      highlightMissingClientFields && !companyNumber.trim()
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={companyNumber}
                    onChange={(e) => setCompanyNumber(e.target.value)}
                  />
                  {highlightMissingClientFields && !companyNumber.trim() ? (
                    <span style={{ fontSize: 12, color: '#d93025', fontWeight: 600, marginTop: 2 }}>
                      Required to convert organisation to a client
                    </span>
                  ) : null}
                </div>

                {/* 4. Registered office address (single-textbox Ideal Postcodes lookup) */}
                <div
                  className="field-group field-group--full"
                  style={
                    highlightMissingClientFields &&
                    (!registeredAddress?.line1?.trim() || !registeredAddress?.postcode?.trim())
                      ? {
                          marginTop: 4,
                          padding: 10,
                          borderRadius: 8,
                          border: '1.5px solid #d93025',
                          background: 'rgba(217, 48, 37, 0.04)',
                        }
                      : { marginTop: 4 }
                  }
                >
                  <SingleAddressEditor
                    bare
                    fieldLabelStyle
                    inputId="org-reg-postcode"
                    label="Registered office address"
                    hintText=""
                    address={registeredAddress}
                    onChange={setRegisteredAddress}
                    values={values}
                  />
                </div>

                {/* 5. Former names */}
                <div className="field-group" style={{ marginTop: 4 }}>
                  <div className="list-section__header">
                    <label className="field-label" style={{ marginBottom: 0 }}>
                      Former names
                    </label>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setFormerNames([...formerNames, ''])}
                    >
                      + Add
                    </button>
                  </div>
                  {formerNames.map((fn, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 6,
                      }}
                    >
                      <input
                        type="text"
                        className="field-input"
                        value={fn}
                        onChange={(e) => {
                          const next = [...formerNames];
                          next[idx] = e.target.value;
                          setFormerNames(next);
                        }}
                      />
                      {formerNames.length > 1 ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setFormerNames(formerNames.filter((_, i) => i !== idx))
                          }
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {/* 6. People with significant control */}
                <div className="field-group" style={{ marginTop: 4 }}>
                  <div className="list-section__header">
                    <label className="field-label" style={{ marginBottom: 0 }}>
                      People with significant control
                    </label>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setPscList([...pscList, ''])}
                    >
                      + Add
                    </button>
                  </div>
                  {pscList.map((psc, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 6,
                      }}
                    >
                      <input
                        type="text"
                        list="org-known-people-list"
                        className="field-input"
                        value={psc}
                        onChange={(e) => {
                          const next = [...pscList];
                          next[idx] = e.target.value;
                          setPscList(next);
                        }}
                      />
                      {pscList.length > 1 ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setPscList(pscList.filter((_, i) => i !== idx))}
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {/* 7. Directors */}
                <div className="field-group" style={{ marginTop: 4 }}>
                  <div className="list-section__header">
                    <label className="field-label" style={{ marginBottom: 0 }}>
                      Directors
                    </label>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setDirectorsList([...directorsList, ''])}
                    >
                      + Add
                    </button>
                  </div>
                  {directorsList.map((dir, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 6,
                      }}
                    >
                      <input
                        type="text"
                        list="org-known-people-list"
                        className="field-input"
                        value={dir}
                        onChange={(e) => {
                          const next = [...directorsList];
                          next[idx] = e.target.value;
                          setDirectorsList(next);
                        }}
                      />
                      {directorsList.length > 1 ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setDirectorsList(directorsList.filter((_, i) => i !== idx))
                          }
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* ================================================================
                2 · MORE DETAILS — TABBED VIEW FOR NON-MANDATORY SECTIONS
                ================================================================ */}
            <section className="new-enquiry-card" aria-labelledby="org-more-heading">
              <div className="new-enquiry-card__top">
                <h2 id="org-more-heading" className="new-enquiry-card__label">
                  2 · MORE DETAILS
                </h2>
              </div>

              <div className="form-tabs-bar" role="tablist" aria-label="Additional organisation details">
                {(
                  [
                    { key: 'most_used' as const, label: 'Most used' },
                    { key: 'identity' as const, label: 'Identity & contact' },
                    { key: 'commercial' as const, label: 'Commercial relationship' },
                    { key: 'compliance' as const, label: 'Compliance & billing' },
                    { key: 'custom' as const, label: 'Custom fields' },
                  ]
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    className={`form-tab-btn ${activeTab === tab.key ? 'form-tab-btn--active' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* TAB 0: Most used */}
              {activeTab === 'most_used' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Main phone</label>
                      <input
                        type="tel"
                        className="field-input"
                        value={mainPhone}
                        onChange={(e) => setMainPhone(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">General email</label>
                      <input
                        type="email"
                        className="field-input"
                        value={generalEmail}
                        onChange={(e) => setGeneralEmail(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Website</label>
                      <input
                        type="text"
                        className="field-input"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Sector</label>
                      <ChoiceSelect
                        listKey="sector"
                        values={values}
                        value={sectorId}
                        onChange={setSectorId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Relationship partner (employee)</label>
                      <EmployeeSelect
                        employees={employees}
                        values={values}
                        value={relationshipPartnerId}
                        onChange={setRelationshipPartnerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Parent organisation</label>
                      <select
                        className="field-select"
                        value={parentOrganisationId ?? ''}
                        onChange={(e) => setParentOrganisationId(e.target.value || null)}
                      >
                        <option value="">None (top-level organisation)</option>
                        {allOrganisations
                          .filter((o) => !o.mergedIntoId && o.id !== existing?.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.legalName} ({o.id})
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* TAB 1: Identity & contact */}
              {activeTab === 'identity' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Country of registration</label>
                      <ChoiceSelect
                        listKey="country"
                        values={values}
                        value={countryOfRegistrationId}
                        onChange={setCountryOfRegistrationId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">VAT number</label>
                      <input
                        type="text"
                        className="field-input"
                        value={vatNumber}
                        onChange={(e) => setVatNumber(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Main phone</label>
                      <input
                        type="tel"
                        className="field-input"
                        value={mainPhone}
                        onChange={(e) => setMainPhone(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">General email</label>
                      <input
                        type="email"
                        className="field-input"
                        value={generalEmail}
                        onChange={(e) => setGeneralEmail(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Website</label>
                      <input
                        type="text"
                        className="field-input"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Parent organisation</label>
                      <select
                        className="field-select"
                        value={parentOrganisationId ?? ''}
                        onChange={(e) => setParentOrganisationId(e.target.value || null)}
                      >
                        <option value="">None (top-level organisation)</option>
                        {allOrganisations
                          .filter((o) => !o.mergedIntoId && o.id !== existing?.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.legalName} ({o.id})
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  {/* Trading / other names */}
                  <div style={{ marginTop: 18 }}>
                    <div className="list-section__header">
                      <span className="field-label">Trading and other names</span>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() =>
                          setTradingNames([
                            ...tradingNames,
                            { id: `on-${Date.now()}`, name: '', typeId: null },
                          ])
                        }
                      >
                        + Add trading name
                      </button>
                    </div>
                    {tradingNames.map((item, idx) => (
                      <div key={item.id} className="repeatable-row">
                        <input
                          type="text"
                          className="field-input"
                          placeholder="Trading or brand name"
                          value={item.name}
                          onChange={(e) => {
                            const next = [...tradingNames];
                            next[idx] = { ...item, name: e.target.value };
                            setTradingNames(next);
                          }}
                        />
                        <ChoiceSelect
                          listKey="org_other_name_type"
                          values={values}
                          value={item.typeId}
                          onChange={(typeId) => {
                            const next = [...tradingNames];
                            next[idx] = { ...item, typeId };
                            setTradingNames(next);
                          }}
                          placeholder="Name type…"
                        />
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setTradingNames(tradingNames.filter((_, i) => i !== idx))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <SingleAddressEditor
                      bare
                      fieldLabelStyle
                      label="Main or correspondence address"
                      hintText=""
                      address={correspondenceAddress}
                      onChange={setCorrespondenceAddress}
                      values={values}
                    />
                  </div>
                </div>
              ) : null}

              {/* TAB 2: Commercial relationship */}
              {activeTab === 'commercial' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Relationship partner (employee)</label>
                      <EmployeeSelect
                        employees={employees}
                        values={values}
                        value={relationshipPartnerId}
                        onChange={setRelationshipPartnerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Relationship status</label>
                      <ChoiceSelect
                        listKey="relationship_status"
                        values={values}
                        value={relationshipStatusId}
                        onChange={setRelationshipStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Relationship standing</label>
                      <ChoiceSelect
                        listKey="relationship_standing"
                        values={values}
                        value={relationshipStandingId}
                        onChange={setRelationshipStandingId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Sector</label>
                      <ChoiceSelect
                        listKey="sector"
                        values={values}
                        value={sectorId}
                        onChange={setSectorId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Client tier</label>
                      <ChoiceSelect
                        listKey="client_tier"
                        values={values}
                        value={clientTierId}
                        onChange={setClientTierId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Source of relationship</label>
                      <ChoiceSelect
                        listKey="relationship_origin"
                        values={values}
                        value={originId}
                        onChange={setOriginId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Date started</label>
                      <input
                        type="date"
                        className="field-input"
                        value={relationshipStartedAt}
                        onChange={(e) => setRelationshipStartedAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Last meaningful interaction</label>
                      <input
                        type="date"
                        className="field-input"
                        value={lastInteractionAt}
                        onChange={(e) => setLastInteractionAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Engagement level</label>
                      <ChoiceSelect
                        listKey="engagement_level"
                        values={values}
                        value={engagementLevelId}
                        onChange={setEngagementLevelId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Pipeline stage</label>
                      <ChoiceSelect
                        listKey="pipeline_stage"
                        values={values}
                        value={pipelineStageId}
                        onChange={setPipelineStageId}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Relationship types</label>
                      <ChoiceMultiGroup
                        listKey="organisation_relationship_type"
                        values={values}
                        selectedIds={relationshipTypeIds}
                        onChange={setRelationshipTypeIds}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Business development notes</label>
                      <textarea
                        className="field-textarea"
                        rows={3}
                        value={bdNotes}
                        onChange={(e) => setBdNotes(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {/* TAB 3: Compliance & billing */}
              {activeTab === 'compliance' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Record status</label>
                      <ChoiceSelect
                        listKey="organisation_record_status"
                        values={values}
                        value={recordStatusId}
                        onChange={(v) => setRecordStatusId(v ?? defaultActiveStatus)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Record owner</label>
                      <EmployeeSelect
                        employees={employees}
                        values={values}
                        value={recordOwnerId}
                        onChange={setRecordOwnerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Client or supplier reference</label>
                      <input
                        type="text"
                        className="field-input"
                        value={clientReference}
                        onChange={(e) => setClientReference(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Onboarding status</label>
                      <ChoiceSelect
                        listKey="onboarding_status"
                        values={values}
                        value={onboardingStatusId}
                        onChange={setOnboardingStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Conflict check status</label>
                      <ChoiceSelect
                        listKey="conflict_status"
                        values={values}
                        value={conflictStatusId}
                        onChange={setConflictStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Conflict check reference</label>
                      <input
                        type="text"
                        className="field-input"
                        value={conflictReference}
                        onChange={(e) => setConflictReference(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Risk rating</label>
                      <ChoiceSelect
                        listKey="risk_rating"
                        values={values}
                        value={riskRatingId}
                        onChange={setRiskRatingId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Risk assessment status</label>
                      <ChoiceSelect
                        listKey="risk_assessment_status"
                        values={values}
                        value={riskAssessmentStatusId}
                        onChange={setRiskAssessmentStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Due diligence / verification status</label>
                      <ChoiceSelect
                        listKey="verification_status"
                        values={values}
                        value={verificationStatusId}
                        onChange={setVerificationStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Invoice preferences</label>
                      <ChoiceSelect
                        listKey="invoice_preference"
                        values={values}
                        value={invoicePreferenceId}
                        onChange={setInvoicePreferenceId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Payment terms</label>
                      <ChoiceSelect
                        listKey="payment_terms"
                        values={values}
                        value={paymentTermsId}
                        onChange={setPaymentTermsId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Engagement terms &amp; document reference</label>
                      <input
                        type="text"
                        className="field-input"
                        value={engagementTermsRef}
                        onChange={(e) => setEngagementTermsRef(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Review date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={reviewDate}
                        onChange={(e) => setReviewDate(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Reviewer</label>
                      <EmployeeSelect
                        employees={employees}
                        values={values}
                        value={reviewerId}
                        onChange={setReviewerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Data source</label>
                      <ChoiceSelect
                        listKey="data_source"
                        values={values}
                        value={sourceId}
                        onChange={setSourceId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Last verified date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={lastVerifiedAt}
                        onChange={(e) => setLastVerifiedAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group field-group--span2">
                      <label className="field-label">Tags (comma-separated)</label>
                      <input
                        type="text"
                        className="field-input"
                        value={tagsText}
                        onChange={(e) => setTagsText(e.target.value)}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Credit control notes</label>
                      <textarea
                        className="field-textarea"
                        rows={2}
                        value={creditControlNotes}
                        onChange={(e) => setCreditControlNotes(e.target.value)}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <SingleAddressEditor
                      bare
                      fieldLabelStyle
                      label="Billing address"
                      hintText=""
                      address={billingAddress}
                      onChange={setBillingAddress}
                      values={values}
                    />
                  </div>
                </div>
              ) : null}

              {/* TAB 4: Custom fields */}
              {activeTab === 'custom' ? (
                <div role="tabpanel">
                  {orgCustomDefs.length > 0 ? (
                    <CustomFieldsFormSection
                      definitions={orgCustomDefs}
                      values={values}
                      lists={lists}
                      fieldValues={cfValues}
                      onChange={setCfValues}
                    />
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
                      No custom fields are currently configured for organisation records.
                    </p>
                  )}
                </div>
              ) : null}
            </section>
          </div>

          {/* ================================================================
              RIGHT COLUMN: STICKY ACTIONS + QUICK CONFLICT CHECK
              ================================================================ */}
          <div
            className="person-form-side-col"
            style={embeddedInModal ? { top: 0, marginTop: 0 } : undefined}
          >
            <div
              className="new-enquiry-footer-actions"
              style={{ justifyContent: 'flex-end' }}
            >
              {embeddedInModal && onCancelModal ? (
                <button
                  type="button"
                  onClick={onCancelModal}
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                >
                  Cancel
                </button>
              ) : (
                <Link
                  href={existing ? `/organisations/${existing.id}` : '/organisations'}
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                >
                  Cancel
                </Link>
              )}
              <button
                type="button"
                className="btn btn--primary"
                style={{ borderRadius: 999, padding: '0 22px' }}
                disabled={pending}
                onClick={() => submitOrganisation(liveDuplicates.length > 0)}
              >
                {pending
                  ? 'Saving…'
                  : modalSubmitLabel
                    ? modalSubmitLabel
                    : existing
                      ? 'Save changes'
                      : embeddedInModal
                        ? 'Create Org. & add as client'
                        : 'Create organisation'}
              </button>
            </div>

            <section
              className="new-enquiry-card new-enquiry-card--grow"
              aria-labelledby="org-conflict-heading"
            >
              <div className="new-enquiry-card__top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h2 id="org-conflict-heading" className="new-enquiry-card__label">
                    QUICK CONFLICT CHECK
                  </h2>
                  <InfoPopover
                    label="About the quick conflict check"
                    title="What the quick conflict check looks for"
                    docHref="/docs/quick-conflict-check"
                    docLabel="How the quick conflict check works"
                  >
                    <p>
                      As you type, the organisation&rsquo;s details are compared with existing
                      People, Organisations and matters.
                    </p>
                    <ul>
                      <li>
                        <strong>Possible conflicts</strong>: the organisation, its former names,
                        PSCs or directors match a known opposite party (by name, email, phone or
                        address).
                      </li>
                      <li>
                        <strong>Already known to us</strong>: existing records with the same name,
                        email, phone, address or postcode.
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
                {!hasConflictInputs ? (
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
                Runs as you type the organisation&rsquo;s legal name, former names, PSCs, directors
                or address.
              </p>

              {/* Dynamic results area */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  maxHeight: 360,
                  overflowY: 'auto',
                }}
              >
                {hasConflictInputs && distinctMatchedCount === 0 ? (
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
                          <Link href={hit.href} className="btn btn--secondary btn--sm">
                            Open
                          </Link>
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
                        {onSelectExistingOrganisation ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => onSelectExistingOrganisation(m.organisation)}
                          >
                            {modalSelectExistingLabel
                              ? modalSelectExistingLabel(m.organisation)
                              : 'Add as client'}
                          </button>
                        ) : (
                          <Link
                            href={`/organisations/${m.organisation.id}`}
                            className="btn btn--secondary btn--sm"
                          >
                            Open
                          </Link>
                        )}
                      </div>
                    ))}

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
                        <Link
                          href={`/people/${m.person.id}`}
                          className="btn btn--secondary btn--sm"
                        >
                          Open
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <p
                className="muted"
                style={{ margin: 'auto 0 0', fontSize: 12.5, lineHeight: 1.4 }}
              >
                Indicative only. The full conflict check runs before a matter is opened.
              </p>
            </section>
          </div>
        </div>
      </form>
    </div>
  );
}
