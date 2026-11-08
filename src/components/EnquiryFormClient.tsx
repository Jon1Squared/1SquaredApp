'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  anonymiseExpiredEnquiriesAction,
  assignEnquiryAction,
  closeEnquiryAction,
  logEnquiryContactAction,
  prepareEnquiryConversionAction,
  reopenEnquiryAction,
  saveEnquiryAction,
  saveTaskAction,
  sendEnquiryEmailAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { enquiryStatusTone, urgencyTone } from '@/domain/badges';
import {
  activeDefinitions,
  isCustomFieldValueMissing,
  validateCustomFields,
} from '@/domain/customFields';
import {
  addMonths,
  formatDate,
  formatDateTime,
  formatKeyDateCountdown,
  toIsoDate,
} from '@/domain/dates';
import {
  computeDraftSaveBarState,
  detectPreliminaryConflicts,
  enquiryDisplayName,
  extractEnquiryFormInitialState,
  failedContactAttemptsCount,
  findEnquiryEntityMatches,
  getAvailableEnquiryActions,
  getMissingRoutingFields,
  hasQuickConflictCheckInputs,
  isEnquiryFormDirty,
  isEnquiryOpen,
  isEnquiryRouted,
  mergePeopleWithEnquiries,
  runEnquiryConflictSearch,
  shouldSuggestNoResponse,
  type EnquiryFormState,
} from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import {
  resolveAddressSuggestion,
  searchAddressSuggestions,
  type AddressSuggestion,
} from '@/domain/addressLookup';
import { personDisplayName, primaryEmail, primaryPhone } from '@/domain/names';
import { hasMinThreeCharToken } from '@/domain/normalise';
import { isTaskOpen, resolveRoutedTeam } from '@/domain/tasks';
import type {
  Address,
  AuditEntry,
  ChoiceValue,
  ContactLogMethod,
  ContactLogOutcome,
  CustomFieldDefinition,
  Enquiry,
  EnquirySentEmailSnapshot,
  EnquirySettings,
  Matter,
  Organisation,
  Person,
  Quote,
  Task,
  Team,
} from '@/domain/types';

import {
  CreateTaskModal,
  type CreateTaskSubmitPayload,
  type SuggestedTaskAssignee,
} from './CreateTaskModal';
import { CustomFieldGroupItems } from './FormControls';
import { InfoPopover } from './InfoPopover';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

const CONTACT_OUTCOMES_BY_METHOD: Record<
  'Phone' | 'In person' | 'Video call',
  ContactLogOutcome[]
> = {
  Phone: ['Spoke', 'Left Message', 'Left Voicemail', 'No answer'],
  'In person': ['Spoke'],
  'Video call': ['Spoke', 'No answer', 'Left Message', 'Left Voicemail'],
};

interface Props {
  mode?: 'new' | 'draft' | 'saved';
  enquiry?: Enquiry;
  quotes?: Quote[];
  tasks?: Task[];
  audit?: AuditEntry[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries?: Enquiry[];
  teams: Team[];
  values: ChoiceValue[];
  customFields?: CustomFieldDefinition[];
  enquirySettings?: EnquirySettings;
  currentUserId: string;
  canReopen?: boolean;
  canAnonymise?: boolean;
  firmName?: string;
  tenantId: string;
}

const DEMO_POSTCODE_ADDRESSES: Record<
  string,
  { line1: string; line2: string; town: string; county: string }[]
> = {
  CF101AA: [
    { line1: '12 Park Place', line2: '', town: 'Cardiff', county: 'South Glamorgan' },
    { line1: '14 Park Place', line2: 'Suite 2', town: 'Cardiff', county: 'South Glamorgan' },
  ],
  CF105FQ: [
    {
      line1: '3 Bute Dock Chambers',
      line2: 'Mount Stuart Square',
      town: 'Cardiff',
      county: 'South Glamorgan',
    },
  ],
  CF119HS: [
    { line1: '18 Cathedral View', line2: 'Pontcanna', town: 'Cardiff', county: 'South Glamorgan' },
  ],
  CF641TQ: [
    { line1: 'Marina House, 14 Ferry Road', line2: '', town: 'Penarth', county: 'Vale of Glamorgan' },
  ],
  BS16DZ: [
    { line1: 'Severn House, 1 Temple Quay', line2: '', town: 'Bristol', county: 'Bristol' },
  ],
};

export function EnquiryFormClient({
  mode = 'new',
  enquiry,
  quotes = [],
  tasks = [],
  audit = [],
  people,
  organisations,
  matters,
  enquiries = [],
  teams,
  values,
  customFields = [],
  enquirySettings,
  currentUserId,
  canReopen: canReopenProp = false,
  canAnonymise = false,
  firmName = 'the firm',
  tenantId,
}: Props) {
  const isSavedEnquiry = Boolean(enquiry) && mode !== 'new';
  const isDraftMode = isSavedEnquiry && enquiry?.status === 'Draft';
  const isRoutedOrClosedMode = isSavedEnquiry && enquiry?.status !== 'Draft';
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  const channels = useMemo(
    () => valuesForList(values, 'enquiry_channel').filter((v) => v.active),
    [values],
  );
  const urgencies = useMemo(
    () => valuesForList(values, 'enquiry_urgency').filter((v) => v.active),
    [values],
  );
  const practiceAreas = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => !v.parentId && v.active),
    [values],
  );
  const allWorkTypes = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => v.active),
    [values],
  );
  const contactMethods = useMemo(
    () => valuesForList(values, 'contact_method').filter((v) => v.active),
    [values],
  );
  const origins = useMemo(
    () => valuesForList(values, 'origin').filter((v) => v.active),
    [values],
  );
  const countries = useMemo(
    () => valuesForList(values, 'country').filter((v) => v.active),
    [values],
  );
  const closeReasons = useMemo(
    () => valuesForList(values, 'enquiry_close_reason').filter((v) => v.active),
    [values],
  );
  const taskTypes = useMemo(
    () => valuesForList(values, 'task_type').filter((v) => v.active),
    [values],
  );
  const taskPriorities = useMemo(
    () => valuesForList(values, 'task_priority').filter((v) => v.active),
    [values],
  );
  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const defaultChannelId =
    channels.find((c) => c.label === 'Phone')?.id ?? channels[0]?.id ?? '';
  const defaultUrgencyId =
    urgencies.find((u) => u.label === 'Standard')?.id ?? urgencies[0]?.id ?? '';
  const defaultCountryId =
    countries.find((c) => c.label === 'United Kingdom')?.id ?? countries[0]?.id ?? null;

  const initialFormState = useMemo(
    () =>
      extractEnquiryFormInitialState(enquiry, {
        channelId: defaultChannelId,
        urgencyId: defaultUrgencyId,
        countryId: defaultCountryId,
      }),
    [enquiry, defaultChannelId, defaultUrgencyId, defaultCountryId],
  );

  // Section 1: Caller
  const [channelId, setChannelId] = useState(initialFormState.channelId);
  const [takenByPersonId, setTakenByPersonId] = useState<string>(
    enquiry?.takenById ?? currentUserId,
  );
  const [customReceivedAt, setCustomReceivedAt] = useState<string | null>(
    enquiry?.receivedAt ?? null,
  );
  const [savedTakenByPersonId, setSavedTakenByPersonId] = useState<string>(
    enquiry?.takenById ?? currentUserId,
  );
  const [savedReceivedAt, setSavedReceivedAt] = useState<string | null>(
    enquiry?.receivedAt ?? null,
  );
  const [receivedModalOpen, setReceivedModalOpen] = useState(false);
  const [modalTakenById, setModalTakenById] = useState<string>(
    enquiry?.takenById ?? currentUserId,
  );
  const [modalEmployeeQuery, setModalEmployeeQuery] = useState('');
  const [modalUseNow, setModalUseNow] = useState<boolean>(!enquiry?.receivedAt);
  const [modalDate, setModalDate] = useState<string>(() => toIsoDate(new Date()));
  const [modalTime, setModalTime] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [modalReceivedError, setModalReceivedError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState(initialFormState.firstName);
  const [lastName, setLastName] = useState(initialFormState.lastName);
  const [callingOnBehalfOf, setCallingOnBehalfOf] = useState(initialFormState.callingOnBehalfOf);
  const [sourceId, setSourceId] = useState(initialFormState.sourceId);
  const [privacyNoticeGiven, setPrivacyNoticeGiven] = useState(
    initialFormState.privacyNoticeGiven,
  );
  const [linkedPersonId, setLinkedPersonId] = useState<string | null>(
    initialFormState.linkedPersonId,
  );
  const [linkedOrganisationId, setLinkedOrganisationId] = useState<string | null>(
    initialFormState.linkedOrganisationId,
  );

  // Section 2: Contact details & Address
  const [phone, setPhone] = useState(initialFormState.phone);
  const [email, setEmail] = useState(initialFormState.email);
  const [preferredContactMethodId, setPreferredContactMethodId] = useState<string>(
    initialFormState.preferredContactMethodId,
  );
  const [bestTimeToCall, setBestTimeToCall] = useState(initialFormState.bestTimeToCall);
  const [postcode, setPostcode] = useState(initialFormState.postcode);
  const [line1, setLine1] = useState(initialFormState.line1);
  const [line2, setLine2] = useState(initialFormState.line2);
  const [town, setTown] = useState(initialFormState.town);
  const [county, setCounty] = useState(initialFormState.county);
  const [countryId, setCountryId] = useState<string | null>(initialFormState.countryId);
  const [addressModalOpen, setAddressModalOpen] = useState(false);

  // Single-textbox Ideal Postcodes autocomplete state
  const [addressLookupQuery, setAddressLookupQuery] = useState<string>(() =>
    [
      initialFormState.line1,
      initialFormState.line2,
      initialFormState.town,
      initialFormState.county,
      initialFormState.postcode,
    ]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', '),
  );
  const [addressUserTyping, setAddressUserTyping] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressDropdownOpen, setAddressDropdownOpen] = useState(false);
  const [addressSearching, setAddressSearching] = useState(false);
  const [addressResolvingId, setAddressResolvingId] = useState<string | null>(null);
  const [addressLookupError, setAddressLookupError] = useState<string | null>(null);
  const addressLookupWrapRef = useRef<HTMLDivElement | null>(null);

  // Section 3: The Enquiry
  const [practiceAreaId, setPracticeAreaId] = useState(initialFormState.practiceAreaId);
  const [workTypeSubcategoryId, setWorkTypeSubcategoryId] = useState(
    initialFormState.workTypeSubcategoryId,
  );
  const [summary, setSummary] = useState(initialFormState.summary);
  const [notes, setNotes] = useState(initialFormState.notes);
  const [otherPartiesNamed, setOtherPartiesNamed] = useState(initialFormState.otherPartiesNamed);
  const [urgencyId, setUrgencyId] = useState(initialFormState.urgencyId);
  const [keyDate, setKeyDate] = useState(initialFormState.keyDate);
  const [keyDateLabel, setKeyDateLabel] = useState(enquiry?.keyDateLabel ?? '');

  // Client-configured custom fields on the Enquiry screen
  const [cfValues, setCfValues] = useState<Record<string, unknown>>(
    initialFormState.customFields ?? {},
  );

  const enquiryCustomDefs = useMemo(
    () => activeDefinitions(customFields, 'enquiry'),
    [customFields],
  );
  const callerCustomDefs = useMemo(
    () => enquiryCustomDefs.filter((d) => d.section === 'enquiry_caller'),
    [enquiryCustomDefs],
  );
  const contactCustomDefs = useMemo(
    () => enquiryCustomDefs.filter((d) => d.section === 'enquiry_contact'),
    [enquiryCustomDefs],
  );
  const enquiryDetailsCustomDefs = useMemo(
    () => enquiryCustomDefs.filter((d) => d.section === 'enquiry_details'),
    [enquiryCustomDefs],
  );
  const additionalCustomDefs = useMemo(
    () =>
      enquiryCustomDefs.filter(
        (d) =>
          d.section !== 'enquiry_caller' &&
          d.section !== 'enquiry_contact' &&
          d.section !== 'enquiry_details',
      ),
    [enquiryCustomDefs],
  );

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Save bar & dirty tracking state
  const [savedBaseline, setSavedBaseline] = useState<EnquiryFormState>(initialFormState);
  const [savedKeyDateLabel, setSavedKeyDateLabel] = useState(enquiry?.keyDateLabel ?? '');
  const [justSaved, setJustSaved] = useState(false);
  const [attemptedRouteWithMissing, setAttemptedRouteWithMissing] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string>(
    enquiry?.updatedAt ?? enquiry?.receivedAt ?? new Date().toISOString(),
  );
  const [lastSavedById, setLastSavedById] = useState<string>(
    enquiry?.updatedById ?? enquiry?.takenById ?? currentUserId,
  );
  const [savedSnapshot, setSavedSnapshot] = useState(enquiry?.conflictSnapshot ?? null);

  // Modals for saved enquiries (Assign, Close/Decline/Refer out, Convert, Log contact, New task)
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignPersonId, setAssignPersonId] = useState(enquiry?.assignedToId ?? '');
  const [assignTeamId, setAssignTeamId] = useState(enquiry?.assignedTeamId ?? '');

  const [closeModalMode, setCloseModalMode] = useState<
    'Declined' | 'Referred out' | 'No response' | null
  >(null);
  const [closeReasonId, setCloseReasonId] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [referredToOrganisationId, setReferredToOrganisationId] = useState('');
  const [referredToName, setReferredToName] = useState('');

  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [convertUsePersonId, setConvertUsePersonId] = useState<string>(
    enquiry?.linkedPersonId ?? '',
  );
  const [convertUseOrgId, setConvertUseOrgId] = useState<string>(
    enquiry?.linkedOrganisationId ?? '',
  );
  const [convertForBusiness, setConvertForBusiness] = useState<boolean>(
    Boolean(enquiry?.callingOnBehalfOf?.trim() || enquiry?.linkedOrganisationId),
  );

  const [logContactModalOpen, setLogContactModalOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleDocClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, [moreMenuOpen]);
  const [contactMethod, setContactMethod] = useState<'Phone' | 'In person' | 'Video call'>('Phone');
  const [contactOutcome, setContactOutcome] = useState<ContactLogOutcome>('Spoke');
  const [contactNote, setContactNote] = useState('');

  const [sendEmailModalOpen, setSendEmailModalOpen] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState(`Response to enquiry to ${firmName}`);
  const [emailBodyHtml, setEmailBodyHtml] = useState('');
  const emailEditorRef = useRef<HTMLDivElement | null>(null);
  const [viewingSentEmail, setViewingSentEmail] = useState<{
    entry: AuditEntry;
    email: EnquirySentEmailSnapshot;
  } | null>(null);

  const [newTaskModalOpen, setNewTaskModalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskDueAt, setTaskDueAt] = useState(() => toIsoDate(new Date()));
  const [taskTypeId, setTaskTypeId] = useState(() => taskTypes[0]?.id ?? '');
  const [taskPriorityId, setTaskPriorityId] = useState(
    () => taskPriorities.find((p) => p.label === 'Normal')?.id ?? taskPriorities[0]?.id ?? '',
  );

  const currentFormState: EnquiryFormState = useMemo(
    () => ({
      channelId,
      firstName,
      lastName,
      callingOnBehalfOf,
      sourceId,
      privacyNoticeGiven,
      linkedPersonId,
      linkedOrganisationId,
      phone,
      email,
      preferredContactMethodId,
      bestTimeToCall,
      postcode,
      line1,
      line2,
      town,
      county,
      countryId,
      practiceAreaId,
      workTypeSubcategoryId,
      summary,
      notes,
      otherPartiesNamed,
      urgencyId,
      keyDate,
      customFields: cfValues,
    }),
    [
      channelId,
      firstName,
      lastName,
      callingOnBehalfOf,
      sourceId,
      privacyNoticeGiven,
      linkedPersonId,
      linkedOrganisationId,
      phone,
      email,
      preferredContactMethodId,
      bestTimeToCall,
      postcode,
      line1,
      line2,
      town,
      county,
      countryId,
      practiceAreaId,
      workTypeSubcategoryId,
      summary,
      notes,
      otherPartiesNamed,
      urgencyId,
      keyDate,
      cfValues,
    ],
  );

  const isDirty = useMemo(
    () =>
      isEnquiryFormDirty(currentFormState, savedBaseline) ||
      keyDateLabel !== savedKeyDateLabel ||
      takenByPersonId !== savedTakenByPersonId ||
      customReceivedAt !== savedReceivedAt,
    [
      currentFormState,
      savedBaseline,
      keyDateLabel,
      savedKeyDateLabel,
      takenByPersonId,
      savedTakenByPersonId,
      customReceivedAt,
      savedReceivedAt,
    ],
  );

  const watchedFieldsChangedSinceSave = useMemo(
    () =>
      firstName !== savedBaseline.firstName ||
      lastName !== savedBaseline.lastName ||
      callingOnBehalfOf !== savedBaseline.callingOnBehalfOf ||
      otherPartiesNamed !== savedBaseline.otherPartiesNamed ||
      email !== savedBaseline.email ||
      phone !== savedBaseline.phone ||
      postcode !== savedBaseline.postcode ||
      line1 !== savedBaseline.line1 ||
      line2 !== savedBaseline.line2 ||
      linkedPersonId !== savedBaseline.linkedPersonId ||
      linkedOrganisationId !== savedBaseline.linkedOrganisationId,
    [
      firstName,
      lastName,
      callingOnBehalfOf,
      otherPartiesNamed,
      email,
      phone,
      postcode,
      line1,
      line2,
      linkedPersonId,
      linkedOrganisationId,
      savedBaseline,
    ],
  );

  // Clear "Still needed" banner as soon as all missing fields are completed
  const missingItems = useMemo(
    () =>
      getMissingRoutingFields(
        {
          firstName,
          lastName,
          phone,
          email,
          practiceAreaId,
          summary,
          notes,
          customFields: cfValues,
        },
        customFields,
      ),
    [firstName, lastName, phone, email, practiceAreaId, summary, notes, cfValues, customFields],
  );

  useEffect(() => {
    if (missingItems.length === 0 && attemptedRouteWithMissing) {
      setAttemptedRouteWithMissing(false);
    }
  }, [missingItems.length, attemptedRouteWithMissing]);

  // Warn before leaving page if there are unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const subcategories = useMemo(
    () =>
      practiceAreaId
        ? allWorkTypes.filter((v) => v.parentId === practiceAreaId)
        : [],
    [allWorkTypes, practiceAreaId],
  );

  const routedPreview = useMemo(() => {
    if (!practiceAreaId) return null;
    return resolveRoutedTeam(practiceAreaId, teams);
  }, [practiceAreaId, teams]);

  const combinedPeople = useMemo(
    () => mergePeopleWithEnquiries(people, enquiries, values, enquiry?.id ?? null),
    [people, enquiries, values, enquiry?.id],
  );

  // Live duplicate/entity matching against People & Organisations across all 6 watched fields
  const liveEntityMatches = useMemo(
    () =>
      findEnquiryEntityMatches(
        {
          firstName,
          lastName,
          email,
          phone,
          callingOnBehalfOf,
          postcode,
          addressLine1: line1,
          addressLine2: line2,
          otherPartiesNamed,
        },
        people,
        organisations,
        enquiries,
        enquiry?.id ?? null,
      ),
    [
      firstName,
      lastName,
      email,
      phone,
      callingOnBehalfOf,
      postcode,
      line1,
      line2,
      otherPartiesNamed,
      people,
      organisations,
      enquiries,
      enquiry?.id,
    ],
  );

  // Live preliminary conflict check on caller (name, email, phone, address), organisation, and other parties
  const livePossibleConflicts = useMemo(
    () =>
      detectPreliminaryConflicts(
        {
          firstName,
          lastName,
          callingOnBehalfOf,
          otherPartiesNamed,
          email,
          phone,
          address: { line1, line2, postcode },
          linkedPersonId,
          linkedOrganisationId,
        },
        people,
        organisations,
        matters,
        values,
        enquiries,
        enquiry?.id ?? null,
        undefined,
        undefined,
        tenantId,
      ),
    [
      firstName,
      lastName,
      callingOnBehalfOf,
      otherPartiesNamed,
      email,
      phone,
      line1,
      line2,
      postcode,
      linkedPersonId,
      linkedOrganisationId,
      people,
      organisations,
      matters,
      values,
      enquiries,
      enquiry?.id,
      tenantId,
    ],
  );

  // On initial load of a saved enquiry (before any watched field changes), use the recorded snapshot if present;
  // as soon as any watched field changes, use the live calculation.
  const useRecordedSnapshot =
    isSavedEnquiry && !watchedFieldsChangedSinceSave && Boolean(savedSnapshot);

  const possibleConflicts = useMemo(
    () => (useRecordedSnapshot && savedSnapshot ? savedSnapshot.conflicts : livePossibleConflicts),
    [useRecordedSnapshot, savedSnapshot, livePossibleConflicts],
  );

  // Each record appears once: anything flagged as a possible conflict is removed from
  // "Already known to us", and its contact-match reasons are shown on the conflict row instead.
  const conflictKeys = useMemo(
    () => new Set(possibleConflicts.map((h) => `${h.recordType}:${h.recordId}`)),
    [possibleConflicts],
  );
  const entityReasonsByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (useRecordedSnapshot && savedSnapshot) {
      for (const kp of savedSnapshot.knownPeople) map.set(`person:${kp.id}`, kp.formattedReasons);
      for (const ko of savedSnapshot.knownOrganisations) {
        map.set(`organisation:${ko.id}`, ko.formattedReasons);
      }
    } else {
      for (const m of liveEntityMatches.people) map.set(`person:${m.person.id}`, m.formattedReasons);
      for (const m of liveEntityMatches.organisations) {
        map.set(`organisation:${m.organisation.id}`, m.formattedReasons);
      }
    }
    return map;
  }, [useRecordedSnapshot, savedSnapshot, liveEntityMatches]);

  const knownPeople = useMemo(() => {
    if (useRecordedSnapshot && savedSnapshot) {
      return savedSnapshot.knownPeople
        .filter((kp) => !conflictKeys.has(`person:${kp.id}`))
        .map((kp) => {
          const person = combinedPeople.find((p) => p.id === kp.id);
          return person ? { person, formattedReasons: kp.formattedReasons } : null;
        })
        .filter((x): x is { person: Person; formattedReasons: string } => Boolean(x));
    }
    return liveEntityMatches.people.filter((m) => !conflictKeys.has(`person:${m.person.id}`));
  }, [useRecordedSnapshot, savedSnapshot, liveEntityMatches, conflictKeys, combinedPeople]);

  const knownOrganisations = useMemo(() => {
    if (useRecordedSnapshot && savedSnapshot) {
      return savedSnapshot.knownOrganisations
        .filter((ko) => !conflictKeys.has(`organisation:${ko.id}`))
        .map((ko) => {
          const organisation = organisations.find((o) => o.id === ko.id);
          return organisation ? { organisation, formattedReasons: ko.formattedReasons } : null;
        })
        .filter((x): x is { organisation: Organisation; formattedReasons: string } => Boolean(x));
    }
    return liveEntityMatches.organisations.filter(
      (m) => !conflictKeys.has(`organisation:${m.organisation.id}`),
    );
  }, [useRecordedSnapshot, savedSnapshot, liveEntityMatches, conflictKeys, organisations]);

  const callerMissingCount =
    (!firstName.trim() ? 1 : 0) +
    (!lastName.trim() ? 1 : 0) +
    callerCustomDefs.filter((d) => isCustomFieldValueMissing(d, cfValues[d.id])).length;
  const contactCustomMissingCount = contactCustomDefs.filter((d) =>
    isCustomFieldValueMissing(d, cfValues[d.id]),
  ).length;
  const hasContactInfo = Boolean(phone.trim() || email.trim()) && contactCustomMissingCount === 0;
  const enquiryMissingCount =
    (!practiceAreaId ? 1 : 0) +
    (!summary.trim() ? 1 : 0) +
    (!notes.trim() ? 1 : 0) +
    enquiryDetailsCustomDefs.filter((d) => isCustomFieldValueMissing(d, cfValues[d.id])).length;
  const additionalMissingCount = additionalCustomDefs.filter((d) =>
    isCustomFieldValueMissing(d, cfValues[d.id]),
  ).length;

  // Quick conflict check per-field threshold & distinct record count
  const hasSearchInputs = useMemo(
    () =>
      hasQuickConflictCheckInputs({
        firstName,
        lastName,
        callingOnBehalfOf,
        otherPartiesNamed,
        email,
        phone,
        postcode,
      }) || Boolean(line1.trim() && postcode.trim()),
    [firstName, lastName, callingOnBehalfOf, otherPartiesNamed, email, phone, postcode, line1],
  );

  const hasHighSeverityConflict = useMemo(
    () => possibleConflicts.some((h) => h.severity === 'high' || h.blocking),
    [possibleConflicts],
  );

  const distinctMatchedCount = conflictKeys.size + knownPeople.length + knownOrganisations.length;

  const hasOtherPartyInput = useMemo(() => {
    const entries = otherPartiesNamed
      .split(/[,;/\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return entries.some((entry) => hasMinThreeCharToken(entry));
  }, [otherPartiesNamed]);

  const formatSingleLineAddress = (parts: {
    line1?: string;
    line2?: string;
    town?: string;
    county?: string;
    postcode?: string;
  }) =>
    [parts.line1, parts.line2, parts.town, parts.county, parts.postcode]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(', ');

  useEffect(() => {
    if (!addressDropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        addressLookupWrapRef.current &&
        !addressLookupWrapRef.current.contains(e.target as Node)
      ) {
        setAddressDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [addressDropdownOpen]);

  useEffect(() => {
    if (!addressUserTyping) return;
    const q = addressLookupQuery.trim();
    if (q.length < 3) {
      setAddressSuggestions([]);
      setAddressDropdownOpen(false);
      setAddressLookupError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAddressSearching(true);
      setAddressLookupError(null);
      const { suggestions, error } = await searchAddressSuggestions(q, controller.signal);
      if (!controller.signal.aborted) {
        setAddressSearching(false);
        setAddressSuggestions(suggestions);
        setAddressLookupError(error ?? null);
        setAddressDropdownOpen(true);
      }
    }, 260);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addressLookupQuery, addressUserTyping]);

  const handleSelectAddressSuggestion = async (item: AddressSuggestion) => {
    setAddressResolvingId(item.id);
    setAddressLookupError(null);
    const { address: resolved, error } = await resolveAddressSuggestion(item.id);
    setAddressResolvingId(null);

    if (!resolved || error) {
      setAddressLookupError(error ?? 'Could not resolve address details.');
      showToast(error ?? 'Could not resolve address details.');
      return;
    }

    setLine1(resolved.line1);
    setLine2(resolved.line2);
    setTown(resolved.town);
    setCounty(resolved.county);
    setPostcode(resolved.postcode);

    const matchedCountry =
      countries.find(
        (c) => c.label.toLowerCase() === resolved.country.toLowerCase(),
      ) ??
      countries.find(
        (c) =>
          c.label === 'United Kingdom' ||
          c.label === 'Wales' ||
          c.label === 'England',
      );
    if (matchedCountry) {
      setCountryId(matchedCountry.id);
    }

    const formatted = formatSingleLineAddress(resolved);
    setAddressUserTyping(false);
    setAddressLookupQuery(formatted);
    setAddressDropdownOpen(false);
    showToast(`Filled address: ${formatted}`);
  };

  const linkExistingPerson = (p: Person) => {
    if (!p.id.startsWith('ENQ-')) {
      setLinkedPersonId(p.id);
    }
    if (!firstName.trim()) setFirstName(p.firstName);
    if (!lastName.trim()) setLastName(p.surname);
    const pEmail = primaryEmail(p);
    const pPhone = primaryPhone(p);
    if (!email.trim() && pEmail) setEmail(pEmail);
    if (!phone.trim() && pPhone) setPhone(pPhone);
    if (!line1.trim() && p.addresses[0]) {
      setLine1(p.addresses[0].line1);
      setLine2(p.addresses[0].line2);
      setTown(p.addresses[0].town);
      setCounty(p.addresses[0].county);
      setPostcode(p.addresses[0].postcode);
      setCountryId(p.addresses[0].countryId);
      setAddressUserTyping(false);
      setAddressLookupQuery(formatSingleLineAddress(p.addresses[0]));
    }
    showToast(
      p.id.startsWith('ENQ-')
        ? `Pre-filled details from enquiry ${p.id} (${personDisplayName(p)})`
        : `Linked enquiry to ${personDisplayName(p)} (${p.id})`,
    );
  };

  const linkExistingOrg = (o: Organisation) => {
    setLinkedOrganisationId(o.id);
    if (!callingOnBehalfOf.trim()) setCallingOnBehalfOf(o.legalName);
    if (!line1.trim() && o.registeredAddress) {
      setLine1(o.registeredAddress.line1);
      setLine2(o.registeredAddress.line2);
      setTown(o.registeredAddress.town);
      setCounty(o.registeredAddress.county);
      setPostcode(o.registeredAddress.postcode);
      setCountryId(o.registeredAddress.countryId);
      setAddressUserTyping(false);
      setAddressLookupQuery(formatSingleLineAddress(o.registeredAddress));
    }
    showToast(`Linked enquiry to ${o.legalName} (${o.id})`);
  };

  const handleFindAddress = async () => {
    const q = (addressLookupQuery || postcode).trim();
    if (q.length < 3) {
      showToast('Type a postcode or part of an address (at least 3 characters).');
      return;
    }

    setAddressSearching(true);
    setAddressLookupError(null);
    const { suggestions, error } = await searchAddressSuggestions(q);
    setAddressSearching(false);
    setAddressSuggestions(suggestions);
    setAddressLookupError(error ?? null);
    setAddressDropdownOpen(true);

    if (suggestions.length === 0 && !error) {
      showToast('No matching UK addresses found. Try a postcode or enter manually.');
    }
  };

  const submitForm = (asDraft: boolean) => {
    if (!asDraft && missingItems.length > 0) {
      setAttemptedRouteWithMissing(true);
      const nextErrors: Record<string, string> = {};
      if (!firstName.trim() || !lastName.trim()) {
        nextErrors.name = 'First name and surname are required.';
      }
      if (!phone.trim() && !email.trim()) {
        nextErrors.contact = 'Provide at least a phone number or an email address.';
      }
      if (!practiceAreaId) {
        nextErrors.practiceAreaId = 'Select a practice area.';
      }
      if (!summary.trim()) {
        nextErrors.summary = 'Provide a short one-line summary.';
      }
      if (!notes.trim()) {
        nextErrors.notes = 'Provide enquiry notes.';
      }
      const cfVal = validateCustomFields(
        customFields,
        'enquiry',
        cfValues,
        enquiry?.customFields ?? {},
        values,
      );
      Object.assign(nextErrors, cfVal.errors);
      setErrors(nextErrors);
      showToast(`Still needed: ${missingItems.join(', ')}`);
      return;
    }

    const hasAddress = [line1, line2, town, county, postcode].some((s) => s.trim().length > 0);
    const addressPayload: Address | null = hasAddress
      ? {
          id: enquiry?.address?.id ?? 'enq_addr',
          typeId: enquiry?.address?.typeId ?? null,
          line1: line1.trim(),
          line2: line2.trim(),
          town: town.trim(),
          county: county.trim(),
          postcode: postcode.trim(),
          countryId,
        }
      : null;

    startTransition(async () => {
      const res = await saveEnquiryAction(
        {
          channelId,
          takenById: takenByPersonId,
          ...(customReceivedAt ? { receivedAt: customReceivedAt } : {}),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          callingOnBehalfOf: callingOnBehalfOf.trim(),
          linkedPersonId,
          linkedOrganisationId,
          phone: phone.trim(),
          email: email.trim(),
          preferredContactMethodId: preferredContactMethodId || null,
          bestTimeToCall: bestTimeToCall.trim(),
          address: addressPayload,
          practiceAreaId: practiceAreaId || '',
          workTypeSubcategoryId: workTypeSubcategoryId || null,
          summary: summary.trim(),
          notes: notes.trim(),
          otherPartiesNamed: otherPartiesNamed.trim(),
          urgencyId,
          keyDate: keyDate || null,
          keyDateLabel: keyDateLabel.trim(),
          sourceId: sourceId || null,
          referrerPersonId: enquiry?.referrerPersonId ?? null,
          privacyNoticeGiven,
          customFields: cfValues,
        },
        { id: enquiry?.id, asDraft },
      );

      if (res.errors) {
        setErrors(res.errors);
        if (res.missingFields && res.missingFields.length > 0) {
          setAttemptedRouteWithMissing(true);
        }
        showToast('Please complete the required fields before saving.');
        return;
      }

      if (!res.enquiry) {
        showToast('Could not save enquiry');
        return;
      }

      setErrors({});
      setAttemptedRouteWithMissing(false);
      setSavedBaseline(currentFormState);
      setSavedKeyDateLabel(keyDateLabel.trim());
      setSavedTakenByPersonId(res.enquiry.takenById);
      setSavedReceivedAt(res.enquiry.receivedAt);
      setCustomReceivedAt(res.enquiry.receivedAt);
      setJustSaved(true);
      setLastSavedAt(res.enquiry.updatedAt);
      setLastSavedById(res.enquiry.updatedById);
      if (res.enquiry.conflictSnapshot) {
        setSavedSnapshot(res.enquiry.conflictSnapshot);
      }

      if (asDraft) {
        showToast(
          isDraftMode
            ? `Draft ${res.enquiry.reference} changes saved.`
            : `Draft enquiry ${res.enquiry.reference} saved.`,
        );
        if (isSavedEnquiry) {
          router.refresh();
        } else {
          router.push(`/enquiries/${res.enquiry.id}`);
        }
      } else if (isRoutedOrClosedMode) {
        showToast(`Enquiry ${res.enquiry.reference} changes saved.`);
        router.refresh();
      } else {
        showToast(
          `Enquiry ${res.enquiry.reference} saved and routed to ${res.routedTeamName ?? 'Intake'}.`,
        );
        if (isSavedEnquiry) {
          router.refresh();
        } else {
          router.push(`/enquiries/${res.enquiry.id}`);
        }
      }
    });
  };

  // Pre-conversion conflict check for the Convert to Matter modal
  const conflictCheck = useMemo(
    () =>
      runEnquiryConflictSearch(
        {
          firstName,
          lastName,
          callingOnBehalfOf,
          otherPartiesNamed,
          email,
          phone,
          address: {
            line1,
            line2,
            postcode,
          },
          linkedPersonId: convertUsePersonId || linkedPersonId,
          linkedOrganisationId: convertUseOrgId || linkedOrganisationId,
        },
        people,
        organisations,
        matters,
        values,
        enquiries,
        enquiry?.id ?? null,
        undefined,
        undefined,
        tenantId,
      ),
    [
      firstName,
      lastName,
      callingOnBehalfOf,
      otherPartiesNamed,
      email,
      phone,
      line1,
      line2,
      postcode,
      convertUsePersonId,
      linkedPersonId,
      convertUseOrgId,
      linkedOrganisationId,
      people,
      organisations,
      matters,
      values,
      enquiries,
      enquiry?.id,
      tenantId,
    ],
  );

  const open = enquiry ? isEnquiryOpen(enquiry) : true;
  const routed = enquiry ? isEnquiryRouted(enquiry) : false;
  const availableActions = useMemo(
    () => (enquiry ? getAvailableEnquiryActions(enquiry, currentUserId) : []),
    [enquiry, currentUserId],
  );
  const canReopen = Boolean(enquiry && canReopenProp);
  const suggestNoResponse = useMemo(
    () =>
      enquiry
        ? shouldSuggestNoResponse(
            enquiry,
            enquirySettings?.failedAttemptsBeforeSuggestNoResponse || 3,
          )
        : false,
    [enquiry, enquirySettings?.failedAttemptsBeforeSuggestNoResponse],
  );
  const failedAttemptsCount = enquiry ? failedContactAttemptsCount(enquiry) : 0;
  const keyDateCountdown = formatKeyDateCountdown(keyDate || enquiry?.keyDate || null);
  const convertedMatter = enquiry?.convertedMatterId
    ? matters.find((m) => m.id === enquiry.convertedMatterId) ?? null
    : null;

  const handleTake = () => {
    if (!enquiry) return;
    startTransition(async () => {
      await assignEnquiryAction(enquiry.id, currentUserId);
      setAssignPersonId(currentUserId);
      showToast('Enquiry assigned to you');
      router.refresh();
    });
  };

  const handleAssignSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enquiry) return;
    startTransition(async () => {
      await assignEnquiryAction(
        enquiry.id,
        assignPersonId || null,
        assignTeamId || null,
      );
      setAssignModalOpen(false);
      showToast('Enquiry assignment updated');
      router.refresh();
    });
  };

  const handleCloseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enquiry || !closeModalMode) return;
    if (closeModalMode === 'Declined' && !closeReasonId) {
      showToast('Please select a reason for declining the enquiry.');
      return;
    }
    startTransition(async () => {
      const res = await closeEnquiryAction(enquiry.id, {
        targetStatus: closeModalMode,
        closeReasonId: closeModalMode === 'Declined' ? closeReasonId || null : undefined,
        closeNotes,
        referredToOrganisationId:
          closeModalMode === 'Referred out' && referredToOrganisationId
            ? referredToOrganisationId
            : null,
        referredToName: closeModalMode === 'Referred out' ? referredToName : undefined,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      const modeClosed = closeModalMode;
      setCloseModalMode(null);
      setCloseReasonId('');
      showToast(
        isDraftMode
          ? `Enquiry ${enquiry.reference} declined.`
          : `Enquiry closed as ${modeClosed}`,
      );
      router.refresh();
    });
  };

  const handleReopen = () => {
    if (!enquiry) return;
    startTransition(async () => {
      const res = await reopenEnquiryAction(enquiry.id);
      if (res.error) {
        showToast(res.error);
        return;
      }
      showToast('Enquiry reopened');
      router.refresh();
    });
  };

  const handleConvertProceed = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enquiry) return;
    startTransition(async () => {
      const res = await prepareEnquiryConversionAction(enquiry.id, {
        usePersonId: convertUsePersonId || null,
        useOrganisationId: convertForBusiness ? convertUseOrgId || null : null,
        createForBusiness: convertForBusiness,
      });
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      if (!res.ok) {
        showToast(res.conflictReasons?.[0] ?? 'Cannot convert enquiry due to conflict');
        return;
      }
      setConvertModalOpen(false);
      router.push(
        `/matters/new?enquiryId=${enquiry.id}&clientId=${res.clientId ?? ''}&instructingContactId=${res.instructingContactId ?? ''}`,
      );
    });
  };

  const handleDeclineConflict = () => {
    const conflictReason = closeReasons.find((r) => r.label.toLowerCase() === 'conflict');
    if (conflictReason) setCloseReasonId(conflictReason.id);
    setCloseNotes(
      conflictCheck.otherPartyClientMatches
        .concat(conflictCheck.clientAgainstPartyMatches)
        .map((h) => `${h.queryTerm}: ${h.reason}`)
        .join('; '),
    );
    setConvertModalOpen(false);
    setCloseModalMode('Declined');
  };

  const handleLogContact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enquiry) return;
    startTransition(async () => {
      const res = await logEnquiryContactAction(enquiry.id, {
        method: contactMethod,
        outcome: contactOutcome,
        note: contactNote,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setContactNote('');
      setLogContactModalOpen(false);
      showToast(
        contactOutcome === 'Spoke' && !isDraftMode
          ? 'Contact logged — enquiry marked In contact and initial callback task completed'
          : 'Contact logged',
      );
      router.refresh();
    });
  };

  const resolvedEmail = useMemo(() => {
    const direct = email.trim() || enquiry?.email?.trim() || '';
    if (direct) return direct;
    if (linkedPersonId) {
      const lp = people.find((p) => p.id === linkedPersonId);
      const pe = lp ? primaryEmail(lp) : '';
      if (pe) return pe;
    }
    if (linkedOrganisationId) {
      const lo = organisations.find((o) => o.id === linkedOrganisationId);
      if (lo?.generalEmail?.trim()) return lo.generalEmail.trim();
    }
    return '';
  }, [email, enquiry?.email, linkedPersonId, linkedOrganisationId, people, organisations]);

  const openSendEmailModal = () => {
    setEmailTo(resolvedEmail);
    setEmailSubject(`Response to enquiry to ${firmName}`);
    setEmailBodyHtml('');
    setSendEmailModalOpen(true);
    setTimeout(() => {
      if (emailEditorRef.current) {
        emailEditorRef.current.innerHTML = '';
        emailEditorRef.current.focus();
      }
    }, 0);
  };

  const applyEmailFormat = (command: string, value?: string) => {
    const editor = emailEditorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    setEmailBodyHtml(editor.innerHTML);
  };

  const handleSendEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enquiry) return;
    const editor = emailEditorRef.current;
    const bodyHtml = (editor ? editor.innerHTML : emailBodyHtml).trim();
    const bodyText = (editor ? editor.innerText : emailBodyHtml.replace(/<[^>]+>/g, ' ')).trim();
    if (!emailTo.trim()) {
      showToast('Please enter a recipient email address.');
      return;
    }
    if (!emailSubject.trim()) {
      showToast('Please enter an email subject.');
      return;
    }
    if (!bodyText) {
      showToast('Please enter a message before sending.');
      return;
    }
    startTransition(async () => {
      const res = await sendEnquiryEmailAction(enquiry.id, {
        to: emailTo.trim(),
        subject: emailSubject.trim(),
        bodyHtml,
        bodyText,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setSendEmailModalOpen(false);
      showToast(`Email sent to ${emailTo.trim()} and logged in audit trail`);
      router.refresh();
    });
  };

  const suggestedEnquiryTaskAssignees = useMemo<SuggestedTaskAssignee[]>(() => {
    const seen = new Set<string>();
    const list: SuggestedTaskAssignee[] = [];
    const addPerson = (personId: string | null | undefined, badgeLabel: string) => {
      if (!personId || seen.has(personId)) return;
      const emp = employees.find((e) => e.id === personId);
      if (!emp) return;
      seen.add(personId);
      list.push({ person: emp, badgeLabel });
    };

    addPerson(enquiry?.assignedToId ?? currentUserId, 'Fee earner');
    const leadEmp = employees.find((e) => e.id === (enquiry?.assignedToId ?? currentUserId));
    if (leadEmp?.employment?.supervisingPartnerId) {
      addPerson(leadEmp.employment.supervisingPartnerId, 'Supervising partner');
    }
    const colpEmp =
      employees.find((e) => e.employeeRoleId === 'employee_role.risk_and_compliance') ??
      employees.find((e) =>
        (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('colp'),
      );
    if (colpEmp) addPerson(colpEmp.id, 'COLP');

    const practiceMgrEmp = employees.find((e) =>
      (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('practice manager'),
    );
    if (practiceMgrEmp) addPerson(practiceMgrEmp.id, 'Practice manager');

    return list;
  }, [employees, enquiry?.assignedToId, currentUserId]);

  const handleCreateTask = (payload: CreateTaskSubmitPayload) => {
    if (!enquiry) return;
    startTransition(async () => {
      const res = await saveTaskAction({
        title: payload.title,
        description: payload.details || undefined,
        taskTypeId,
        priorityId: taskPriorityId,
        dueAt: payload.dueAtIso,
        assignedPersonId: payload.assignedPersonIds[0] ?? (enquiry.assignedToId ?? currentUserId),
        assignedPersonIds: payload.assignedPersonIds,
        multiAssigneeMode: payload.multiAssigneeMode,
        assignedTeamId: enquiry.assignedTeamId ?? null,
        linkedRecords: [{ recordType: 'enquiry', recordId: enquiry.id }],
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setNewTaskModalOpen(false);
      showToast('Task created');
      router.refresh();
    });
  };

  // Ordered urgencies: Standard, Urgent, Emergency
  const orderedUrgencies = useMemo(() => {
    const order = ['Standard', 'Urgent', 'Emergency'];
    return [...urgencies].sort(
      (a, b) => order.indexOf(a.label) - order.indexOf(b.label),
    );
  }, [urgencies]);

  const takenByPerson = people.find((p) => p.id === takenByPersonId);
  const takenByDisplay = personDisplayName(
    takenByPerson ?? {
      firstName: 'Siân',
      surname: 'Llewellyn',
      preferredName: '',
    },
  );

  const getLocalDateAndTimeStrings = (dateObj: Date) => {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    return {
      dateStr: `${yyyy}-${mm}-${dd}`,
      timeStr: `${hh}:${min}`,
    };
  };

  const openReceivedModal = () => {
    setModalTakenById(takenByPersonId);
    setModalEmployeeQuery('');
    setModalReceivedError(null);
    if (customReceivedAt) {
      const parsed = new Date(customReceivedAt);
      const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      const { dateStr, timeStr } = getLocalDateAndTimeStrings(base);
      setModalDate(dateStr);
      setModalTime(timeStr);
      setModalUseNow(false);
    } else {
      const { dateStr, timeStr } = getLocalDateAndTimeStrings(new Date());
      setModalDate(dateStr);
      setModalTime(timeStr);
      setModalUseNow(true);
    }
    setReceivedModalOpen(true);
  };

  const handleApplyReceivedModal = () => {
    setModalReceivedError(null);
    if (!modalUseNow) {
      if (!modalDate) {
        setModalReceivedError('Please select a date.');
        return;
      }
      const chosen = new Date(`${modalDate}T${modalTime || '00:00'}:00`);
      if (Number.isNaN(chosen.getTime())) {
        setModalReceivedError('Enter a valid date and time.');
        return;
      }
      if (chosen.getTime() > Date.now()) {
        setModalReceivedError('Received date and time cannot be in the future.');
        return;
      }
      setCustomReceivedAt(chosen.toISOString());
    } else {
      setCustomReceivedAt(isSavedEnquiry ? new Date().toISOString() : null);
    }
    setTakenByPersonId(modalTakenById);
    setReceivedModalOpen(false);
  };

  const filteredModalEmployees = useMemo(() => {
    const q = modalEmployeeQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((emp) => {
      const name = personDisplayName(emp).toLowerCase();
      const role = (resolveLabel(values, emp.employeeRoleId) || '').toLowerCase();
      const jobTitle = (emp.jobTitle || '').toLowerCase();
      return name.includes(q) || role.includes(q) || jobTitle.includes(q);
    });
  }, [employees, modalEmployeeQuery, values]);

  const lastSavedByPerson = people.find((p) => p.id === lastSavedById);
  const lastSavedByDisplay = personDisplayName(
    lastSavedByPerson ?? {
      firstName: 'Siân',
      surname: 'Llewellyn',
      preferredName: '',
    },
  );

  const assignedPerson = enquiry?.assignedToId
    ? people.find((p) => p.id === enquiry.assignedToId)
    : null;
  const assignedPersonDisplay = assignedPerson ? personDisplayName(assignedPerson) : '';
  const assignedTeam = enquiry?.assignedTeamId
    ? teams.find((t) => t.id === enquiry.assignedTeamId)
    : null;
  const assignedTeamDisplay = assignedTeam?.name ?? '';

  const draftTitleName =
    [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') ||
    (enquiry ? enquiryDisplayName(enquiry) : '') ||
    'Unnamed enquiry';

  const channelLabel = resolveLabel(values, channelId) || 'phone';
  const urgencyLabel = resolveLabel(values, urgencyId) || 'Standard';
  const practiceAreaLabel = practiceAreaId ? resolveLabel(values, practiceAreaId) : '';
  const subcatLabel = workTypeSubcategoryId ? resolveLabel(values, workTypeSubcategoryId) : '';

  const draftSaveBar = useMemo(
    () =>
      computeDraftSaveBarState({
        isDirty,
        justSaved,
        attemptedRouteWithMissing,
        missingFields: missingItems,
        lastSavedAtFormatted: formatDateTime(lastSavedAt),
        lastSavedByName: lastSavedByDisplay,
      }),
    [
      isDirty,
      justSaved,
      attemptedRouteWithMissing,
      missingItems,
      lastSavedAt,
      lastSavedByDisplay,
    ],
  );

  const enquiryTasks = useMemo(
    () =>
      enquiry
        ? tasks.filter((t) =>
            t.linkedRecords.some(
              (lr) => lr.recordType === 'enquiry' && lr.recordId === enquiry.id,
            ),
          )
        : [],
    [tasks, enquiry],
  );

  const [savedPanelTab, setSavedPanelTab] = useState<'contact' | 'tasks' | 'audit'>('contact');

  const nextTask = useMemo(() => {
    const openTasks = enquiryTasks.filter(
      (t) => t.status !== 'Done' && t.status !== 'Cancelled',
    );
    if (openTasks.length === 0) return null;
    return [...openTasks].sort(
      (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
    )[0];
  }, [enquiryTasks]);

  const displayAudit = useMemo<AuditEntry[]>(() => {
    if (!enquiry) return audit;
    const initialField = `Initial enquiry received (${channelLabel.toLowerCase()})`;
    const initialNewValue = [
      enquiry.reference,
      practiceAreaLabel || null,
      enquiry.summary ? `"${enquiry.summary.slice(0, 80)}"` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const existingInitial = audit.find(
      (a) =>
        a.field?.startsWith('Initial enquiry received') ||
        (a.action === 'create' && !a.field),
    );

    const initialEntry: AuditEntry = existingInitial
      ? {
          ...existingInitial,
          field: existingInitial.field ?? initialField,
          newValue:
            existingInitial.field?.startsWith('Initial enquiry received') &&
            existingInitial.newValue
              ? existingInitial.newValue
              : initialNewValue,
          byId: existingInitial.byId || enquiry.takenById,
          at: existingInitial.at || enquiry.receivedAt,
        }
      : {
          id: `AU-INIT-${enquiry.id}`,
          at: enquiry.receivedAt,
          recordType: 'enquiry',
          recordId: enquiry.id,
          action: 'create',
          field: initialField,
          oldValue: null,
          newValue: initialNewValue,
          byId: enquiry.takenById,
        };

    const rest = [...audit.filter((a) => a.id !== existingInitial?.id)].sort((a, b) => {
      const tDiff = new Date(b.at).getTime() - new Date(a.at).getTime();
      if (tDiff !== 0) return tDiff;
      return b.id.localeCompare(a.id);
    });
    return [...rest, initialEntry];
  }, [audit, enquiry, channelLabel, practiceAreaLabel]);

  const hasCustomSourceOption = Boolean(
    sourceId && !origins.some((o) => o.id === sourceId),
  );

  return (
    <div className="new-enquiry-page">
      {/* Saved Enquiry Header Row: Title & Badges, followed by Call/Email + Workflow Actions on the same line */}
      {isSavedEnquiry && enquiry ? (
        <div className="new-enquiry-header">
          <div style={{ width: '100%' }}>
            <Link href="/enquiries" className="new-enquiry-back">
              ← Back to enquiries
            </Link>
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginTop: 2,
                }}
              >
                <h1 className="new-enquiry-title" style={{ margin: 0 }}>
                  {draftTitleName}
                </h1>
                <span className="new-enquiry-badge">{enquiry.reference}</span>
                {enquiry.status === 'Draft' ? (
                  <span className="new-enquiry-badge new-enquiry-badge--warn">Draft</span>
                ) : enquiry.status !== 'New' ? (
                  <StatusPill
                    label={
                      enquiry.status === 'Assigned' && (assignedPersonDisplay || assignedTeamDisplay)
                        ? `Assigned to ${assignedPersonDisplay || assignedTeamDisplay}`
                        : enquiry.status
                    }
                    tone={enquiryStatusTone(enquiry.status)}
                  />
                ) : null}
                {urgencyLabel === 'Emergency' || urgencyLabel === 'Urgent' ? (
                  <span
                    className={`new-enquiry-badge ${
                      urgencyLabel === 'Emergency'
                        ? 'new-enquiry-badge--alert'
                        : 'new-enquiry-badge--warn'
                    }`}
                  >
                    {urgencyLabel}
                  </span>
                ) : null}
              </div>

              {(summary.trim() || enquiry.summary.trim()) ? (
                <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
                  {summary.trim() || enquiry.summary}
                </div>
              ) : null}

              {/* Single inline row: Call / Email / Key date on left, Workflow Action buttons on right */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginTop: 10,
                  width: '100%',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  {phone.trim() ? (
                    <a
                      href={`tel:${phone.replace(/\s+/g, '')}`}
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                    >
                      Call {phone.trim()}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    style={{ borderRadius: 999 }}
                    onClick={openSendEmailModal}
                  >
                    {resolvedEmail ? `Email ${resolvedEmail}` : 'Email'}
                  </button>
                  {keyDateCountdown ? (
                      <span className="status-pill status-pill--warning" style={{ fontWeight: 700 }}>
                        Key date: {formatDate(keyDate || enquiry.keyDate)}
                        {keyDateLabel.trim() || enquiry.keyDateLabel
                          ? ` (${keyDateLabel.trim() || enquiry.keyDateLabel})`
                          : ''}{' '}
                        — {keyDateCountdown.label}
                      </span>
                    ) : null}
                    {convertedMatter ? (
                      <Link
                        href={`/matters/${convertedMatter.id}`}
                        className="status-pill status-pill--positive"
                        style={{ textDecoration: 'none' }}
                      >
                        {convertedMatter.matterNumber === 'DRAFT'
                          ? `Converted to Matter (Draft — ${convertedMatter.title}) →`
                          : `Converted to Matter ${convertedMatter.matterNumber} — ${convertedMatter.title} →`}
                      </Link>
                    ) : enquiry.status === 'Converted' ? (
                      <span className="status-pill status-pill--positive">
                        Converted to matter
                      </span>
                    ) : null}
                    {!open && enquiry.status !== 'Converted' ? (
                      <span className="status-pill status-pill--neutral">
                        Outcome: {enquiry.status}
                        {enquiry.closeReasonId
                          ? ` — ${resolveLabel(values, enquiry.closeReasonId)}`
                          : ''}
                        {enquiry.referredToName ? ` · Referred to: ${enquiry.referredToName}` : ''}
                        {enquiry.closeNotes ? ` · ${enquiry.closeNotes}` : ''}
                      </span>
                    ) : null}
                  </div>

                  {isDraftMode ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => setLogContactModalOpen(true)}
                      >
                        Record contact
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        disabled={pending}
                        onClick={() => submitForm(true)}
                      >
                        Save changes
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        style={{ borderRadius: 999 }}
                        disabled={pending}
                        onClick={() => submitForm(false)}
                      >
                        Send to Team
                      </button>
                      <div className="popover-anchor" ref={moreMenuRef}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          style={{ borderRadius: 999 }}
                          aria-expanded={moreMenuOpen}
                          onClick={() => setMoreMenuOpen((v) => !v)}
                        >
                          More ▾
                        </button>
                        {moreMenuOpen ? (
                          <div className="popover-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="popover-menu__item"
                              onClick={() => {
                                setMoreMenuOpen(false);
                                setCloseModalMode('Declined');
                              }}
                            >
                              Decline
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : isRoutedOrClosedMode ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {open ? (
                        <>
                          {availableActions.includes('Take') ? (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ borderRadius: 999 }}
                              disabled={pending}
                              onClick={handleTake}
                            >
                              Take
                            </button>
                          ) : null}
                          {availableActions.includes('Assign') ? (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ borderRadius: 999 }}
                              onClick={() => {
                                setAssignPersonId(enquiry.assignedToId ?? '');
                                setAssignTeamId(enquiry.assignedTeamId ?? '');
                                setAssignModalOpen(true);
                              }}
                            >
                              Assign
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ borderRadius: 999 }}
                            onClick={() => setLogContactModalOpen(true)}
                          >
                            Record contact
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ borderRadius: 999 }}
                            disabled={pending}
                            onClick={() => submitForm(false)}
                          >
                            Save changes
                          </button>
                          <Link
                            href={`/quotes/new?enquiryId=${enquiry.id}`}
                            className="btn btn--secondary btn--sm"
                            style={{ borderRadius: 999, textDecoration: 'none' }}
                          >
                            Create quote
                          </Link>
                          {availableActions.includes('Convert to matter') ? (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              style={{ borderRadius: 999 }}
                              disabled={pending}
                              onClick={() => {
                                setConvertUsePersonId(
                                  linkedPersonId ?? liveEntityMatches.people[0]?.person.id ?? '',
                                );
                                setConvertUseOrgId(
                                  linkedOrganisationId ??
                                    liveEntityMatches.organisations[0]?.organisation.id ??
                                    '',
                                );
                                setConvertForBusiness(
                                  Boolean(callingOnBehalfOf.trim() || linkedOrganisationId),
                                );
                                setConvertModalOpen(true);
                              }}
                            >
                              Convert to matter
                            </button>
                          ) : null}
                          <div className="popover-anchor" ref={moreMenuRef}>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ borderRadius: 999 }}
                              aria-expanded={moreMenuOpen}
                              onClick={() => setMoreMenuOpen((v) => !v)}
                            >
                              More ▾
                            </button>
                            {moreMenuOpen ? (
                              <div className="popover-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="popover-menu__item"
                                  onClick={() => {
                                    setMoreMenuOpen(false);
                                    setCloseModalMode('Declined');
                                  }}
                                >
                                  Decline
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="popover-menu__item"
                                  onClick={() => {
                                    setMoreMenuOpen(false);
                                    setCloseModalMode('Referred out');
                                  }}
                                >
                                  Refer out
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="popover-menu__item"
                                  disabled={pending || enquiry.contactLog.length < 2}
                                  style={
                                    enquiry.contactLog.length < 2
                                      ? { opacity: 0.5, cursor: 'not-allowed' }
                                      : undefined
                                  }
                                  title={
                                    enquiry.contactLog.length < 2
                                      ? 'Requires at least 2 logged contact attempts before closing as no response'
                                      : undefined
                                  }
                                  onClick={() => {
                                    if (enquiry.contactLog.length < 2) return;
                                    setMoreMenuOpen(false);
                                    setCloseModalMode('No response');
                                  }}
                                >
                                  Close — no response
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ borderRadius: 999 }}
                            disabled={pending}
                            onClick={() => submitForm(false)}
                          >
                            Save changes
                          </button>
                          {canReopen ? (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              style={{ borderRadius: 999 }}
                              disabled={pending}
                              onClick={handleReopen}
                            >
                              Reopen enquiry
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
            </>
          </div>
        </div>
      ) : null}

      {/* BANNER: Linked quotes for this enquiry */}
      {enquiry && quotes.some((q) => q.linkedEnquiryId === enquiry.id) ? (
        <div
          className="banner"
          style={{
            marginBottom: 14,
            background: 'rgba(15, 118, 110, 0.06)',
            border: '1px solid rgba(15, 118, 110, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>Quoted:</strong>
            {quotes
              .filter((q) => q.linkedEnquiryId === enquiry.id)
              .map((q) => (
                <Link
                  key={q.id}
                  href={`/quotes/${q.id}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: 'var(--surface, #fff)',
                    border: '1px solid rgba(15, 118, 110, 0.3)',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#0f766e',
                    textDecoration: 'none',
                  }}
                >
                  <span>
                    {q.reference}
                    {q.version > 1 ? ` (v${q.version})` : ''}
                  </span>
                  <span>·</span>
                  <span>£{q.feeAmountExVat.toLocaleString('en-GB')} ex VAT</span>
                  <span>·</span>
                  <span>{q.status} →</span>
                </Link>
              ))}
          </div>
          <Link
            href={`/quotes/new?enquiryId=${enquiry.id}`}
            className="btn btn--secondary btn--sm"
            style={{ borderRadius: 999 }}
          >
            + New quote
          </Link>
        </div>
      ) : null}

      {/* BANNER: Converted to matter notice when opened from the closed list */}
      {enquiry && enquiry.status === 'Converted' ? (
        <div
          className="banner"
          style={{
            marginBottom: 14,
            background: 'rgba(15, 118, 110, 0.08)',
            border: '1px solid rgba(15, 118, 110, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong>This enquiry has been converted to a matter.</strong>{' '}
            {convertedMatter ? (
              <span>
                It is now linked to{' '}
                <strong>
                  {convertedMatter.matterNumber === 'DRAFT'
                    ? `Draft Matter — ${convertedMatter.title}`
                    : `${convertedMatter.matterNumber} — ${convertedMatter.title}`}
                </strong>
                . All enquiry details and contact history are retained here and accessible via the
                matter&rsquo;s Activity tab.
              </span>
            ) : (
              <span>
                All enquiry details and contact history are retained on this closed enquiry record.
              </span>
            )}
          </div>
          {convertedMatter ? (
            <Link
              href={`/matters/${convertedMatter.id}`}
              className="btn btn--primary btn--sm"
              style={{ borderRadius: 999, flexShrink: 0 }}
            >
              {convertedMatter.matterNumber === 'DRAFT'
                ? 'Open draft matter →'
                : `Open Matter ${convertedMatter.matterNumber} →`}
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* BANNER: Fallback Intake routing */}
      {enquiry && enquiry.routedToIntakeFallback && open && routed ? (
        <div className="banner banner--warning" style={{ marginBottom: 14 }}>
          <div>
            <strong>Manual routing needed:</strong> No active team was mapped to{' '}
            {practiceAreaLabel || 'this practice area'}, so this enquiry was placed in the{' '}
            <strong>Intake</strong> team queue. Use <strong>Assign</strong> to route it to a team or
            fee earner.
          </div>
        </div>
      ) : null}

      {/* BANNER: Suggest closing as No response after N failed attempts */}
      {suggestNoResponse ? (
        <div className="banner banner--warning" style={{ marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <strong>{failedAttemptsCount} contact attempts without speaking:</strong> You have
            logged {failedAttemptsCount} contact attempts on this enquiry without a &lsquo;Spoke&rsquo;
            outcome. Would you like to close this enquiry as <strong>No response</strong>?
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setCloseModalMode('No response')}
          >
            Close — no response
          </button>
        </div>
      ) : null}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submitForm(false);
        }}
      >
        <div className="person-form-layout">
          <div className="person-form-main-col">
            {!isSavedEnquiry ? (
              <div className="new-enquiry-header">
                <div style={{ width: '100%' }}>
                  <Link href="/enquiries" className="new-enquiry-back">
                    ← Back to enquiries
                  </Link>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                    }}
                  >
                    <h1 className="new-enquiry-title">New enquiry</h1>
                  </div>
                </div>
              </div>
            ) : null}

            {/* ==============================================================
                1 · CALLER
                ============================================================== */}
            <section className="new-enquiry-card" aria-labelledby="sec-caller-heading">
              <div className="new-enquiry-card__top">
                <h2 id="sec-caller-heading" className="new-enquiry-card__label">
                  1 · CALLER
                </h2>
                <span
                  className={`new-enquiry-badge ${callerMissingCount === 0 ? 'new-enquiry-badge--ok' : ''}`}
                >
                  {callerMissingCount === 0 ? 'Complete' : `${callerMissingCount} required`}
                </span>
              </div>

              <div className="form-grid-3">
                <div className="field-group">
                  <label className="field-label" htmlFor="enq-channel">
                    Channel <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <select
                    id="enq-channel"
                    className="field-select"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                  >
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-received-taken-by">
                    Received &amp; taken by
                  </label>
                  <button
                    id="enq-received-taken-by"
                    type="button"
                    className="field-input"
                    onClick={openReceivedModal}
                    title="Click to change when the enquiry was received and which employee took it"
                    style={{
                      background: 'var(--bg-subtle)',
                      color: 'var(--ink, var(--text-primary))',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {customReceivedAt
                        ? `${formatDateTime(customReceivedAt)} · ${takenByDisplay}`
                        : `Now · ${takenByDisplay}`}
                    </span>
                    <span
                      className="muted"
                      style={{ fontSize: 11.5, flexShrink: 0 }}
                      aria-hidden="true"
                    >
                      Change
                    </span>
                  </button>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-privacy-notice">
                    Privacy notice given
                  </label>
                  <select
                    id="enq-privacy-notice"
                    className="field-select"
                    value={privacyNoticeGiven ? 'yes' : 'no'}
                    onChange={(e) => setPrivacyNoticeGiven(e.target.value === 'yes')}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-first-name">
                    First name <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <input
                    ref={firstInputRef}
                    id="enq-first-name"
                    type="text"
                    autoFocus={!isSavedEnquiry}
                    className="field-input"
                    placeholder="Caller's first name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-last-name">
                    Last name <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <input
                    id="enq-last-name"
                    type="text"
                    className="field-input"
                    placeholder="Caller's surname"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-behalf">
                    Calling on behalf of{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (if not for themselves)
                    </span>
                  </label>
                  <input
                    id="enq-behalf"
                    type="text"
                    className="field-input"
                    placeholder="e.g. Castell Homes Ltd"
                    value={callingOnBehalfOf}
                    onChange={(e) => setCallingOnBehalfOf(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-source">
                    How they heard about us
                  </label>
                  <select
                    id="enq-source"
                    className="field-select"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    <option value="">Not asked yet</option>
                    {hasCustomSourceOption ? (
                      <option value={sourceId}>
                        {resolveLabel(values, sourceId) || sourceId}
                      </option>
                    ) : null}
                    {origins.map((orig) => (
                      <option key={orig.id} value={orig.id}>
                        {orig.label}
                      </option>
                    ))}
                  </select>
                </div>

                <CustomFieldGroupItems
                  definitions={callerCustomDefs}
                  values={values}
                  fieldValues={cfValues}
                  errors={errors}
                  onChange={setCfValues}
                />
              </div>
              {errors.name ? <span className="field-error">{errors.name}</span> : null}
            </section>

            {/* ==============================================================
                2 · CONTACT DETAILS + ADDRESS
                ============================================================== */}
            <section className="new-enquiry-card" aria-labelledby="sec-contact-heading">
              <div className="new-enquiry-card__top">
                <h2 id="sec-contact-heading" className="new-enquiry-card__label">
                  2 · CONTACT DETAILS
                </h2>
                <span
                  className={`new-enquiry-badge ${hasContactInfo ? 'new-enquiry-badge--ok' : ''}`}
                >
                  {hasContactInfo
                    ? 'Complete'
                    : !phone.trim() && !email.trim()
                      ? 'Phone or email'
                      : `${contactCustomMissingCount} required`}
                </span>
              </div>

              {errors.contact ? (
                <span className="field-error">{errors.contact}</span>
              ) : null}

              <div className="form-grid-3">
                <div className="field-group">
                  <label className="field-label" htmlFor="enq-phone">
                    Phone <span style={{ color: 'var(--coral)' }}>*</span>{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (or email)
                    </span>
                  </label>
                  <input
                    id="enq-phone"
                    type="tel"
                    className="field-input"
                    placeholder="e.g. 07700 900412 or 029 2010 4400"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-email">
                    Email <span style={{ color: 'var(--coral)' }}>*</span>{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (or phone)
                    </span>
                  </label>
                  <input
                    id="enq-email"
                    type="email"
                    className="field-input"
                    placeholder="name@example.co.uk"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  {errors.email ? <span className="field-error">{errors.email}</span> : null}
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-pref-method">
                    Preferred contact
                  </label>
                  <select
                    id="enq-pref-method"
                    className="field-select"
                    value={preferredContactMethodId}
                    onChange={(e) => setPreferredContactMethodId(e.target.value)}
                  >
                    <option value="">Any</option>
                    {contactMethods.map((cm) => (
                      <option key={cm.id} value={cm.id}>
                        {cm.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-best-time">
                    Best time to call
                  </label>
                  <input
                    id="enq-best-time"
                    type="text"
                    className="field-input"
                    placeholder="e.g. after 2pm"
                    value={bestTimeToCall}
                    onChange={(e) => setBestTimeToCall(e.target.value)}
                  />
                </div>

                <CustomFieldGroupItems
                  definitions={contactCustomDefs}
                  values={values}
                  fieldValues={cfValues}
                  errors={errors}
                  onChange={setCfValues}
                />
              </div>

              {/* ADDRESS SUBSECTION */}
              <div className="field-group">
                <div
                  className="new-enquiry-subhead"
                  style={{
                    paddingTop: 0,
                    marginTop: 0,
                    justifyContent: 'space-between',
                    flexWrap: 'nowrap',
                  }}
                >
                  <label
                    className="field-label"
                    htmlFor="enq-postcode"
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Address{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {[line1, town, postcode].some((s) => s.trim().length > 0)
                        ? `(${[line1, line2, town, county, postcode]
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .join(', ')})`
                        : '(optional now, needed before a matter opens)'}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ height: 22, padding: '0 6px', fontSize: 12, flexShrink: 0 }}
                    onClick={() => setAddressModalOpen(true)}
                  >
                    {[line1, line2, town, county].some((s) => s.trim().length > 0)
                      ? 'Edit address'
                      : 'Enter manually'}
                  </button>
                </div>
              <div
                ref={addressLookupWrapRef}
                style={{ position: 'relative' }}
              >
                <div className="new-enquiry-postcode-row">
                  <input
                    id="enq-postcode"
                    type="text"
                    className="field-input"
                    placeholder="Type postcode or street address (e.g. CF10 1AA or 25 St Mary Street)…"
                    value={addressLookupQuery}
                    autoComplete="off"
                    onFocus={() => {
                      if (addressSuggestions.length > 0) {
                        setAddressDropdownOpen(true);
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setAddressUserTyping(true);
                      setAddressLookupQuery(val);
                      if (!val.trim()) {
                        setLine1('');
                        setLine2('');
                        setTown('');
                        setCounty('');
                        setPostcode('');
                      } else if (!line1.trim()) {
                        setPostcode(val);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    style={{ borderRadius: 999, padding: '0 16px' }}
                    disabled={addressSearching}
                    onClick={handleFindAddress}
                  >
                    {addressSearching ? 'Searching…' : 'Find address'}
                  </button>
                </div>

                {addressDropdownOpen ? (
                  <div
                    role="listbox"
                    aria-label="Address suggestions"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      right: 0,
                      zIndex: 50,
                      background: 'var(--surface, #fff)',
                      border: '1px solid var(--border, #e2e8f0)',
                      borderRadius: 10,
                      boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.14)',
                      maxHeight: 260,
                      overflowY: 'auto',
                      padding: 4,
                    }}
                  >
                    {addressLookupError ? (
                      <div
                        style={{
                          padding: '8px 12px',
                          fontSize: 12.5,
                          color: 'var(--coral, #dc2626)',
                        }}
                      >
                        {addressLookupError}
                      </div>
                    ) : addressSuggestions.length === 0 ? (
                      <div
                        className="muted"
                        style={{ padding: '8px 12px', fontSize: 12.5 }}
                      >
                        {addressSearching
                          ? 'Searching Ideal Postcodes…'
                          : 'No matching UK addresses found.'}
                      </div>
                    ) : (
                      addressSuggestions.map((item) => {
                        const isResolving = addressResolvingId === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={false}
                            disabled={Boolean(addressResolvingId)}
                            onClick={() => handleSelectAddressSuggestion(item)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 10px',
                              border: 'none',
                              background: 'transparent',
                              borderRadius: 6,
                              cursor: 'pointer',
                              fontSize: 13,
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
                            <span>{item.suggestion}</span>
                            {isResolving ? (
                              <span
                                className="muted"
                                style={{ fontSize: 11.5, marginLeft: 8 }}
                              >
                                Loading…
                              </span>
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          {/* ==============================================================
              3 · THE ENQUIRY
              ============================================================== */}
          <section
            className="new-enquiry-card"
            aria-labelledby="sec-enquiry-heading"
          >
            <div className="new-enquiry-card__top">
              <h2 id="sec-enquiry-heading" className="new-enquiry-card__label">
                3 · THE ENQUIRY
              </h2>
              <span
                className={`new-enquiry-badge ${enquiryMissingCount === 0 ? 'new-enquiry-badge--ok' : ''}`}
              >
                {enquiryMissingCount === 0 ? 'Complete' : `${enquiryMissingCount} required`}
              </span>
            </div>

            <div className="new-enquiry-row-3">
              <div className="field-group">
                <label className="field-label" htmlFor="enq-practice-area">
                  Practice area <span style={{ color: 'var(--coral)' }}>*</span>
                </label>
                <select
                  id="enq-practice-area"
                  className="field-select"
                  value={practiceAreaId}
                  onChange={(e) => {
                    setPracticeAreaId(e.target.value);
                    setWorkTypeSubcategoryId('');
                  }}
                >
                  <option value="">Select…</option>
                  {practiceAreas.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.label}
                    </option>
                  ))}
                </select>
                {errors.practiceAreaId ? (
                  <span className="field-error">{errors.practiceAreaId}</span>
                ) : null}
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-subcat">
                  Work type{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (if known)
                  </span>
                </label>
                <select
                  id="enq-subcat"
                  className="field-select"
                  disabled={!practiceAreaId}
                  value={workTypeSubcategoryId}
                  onChange={(e) => setWorkTypeSubcategoryId(e.target.value)}
                >
                  <option value="">Unsure / leave for fee earner</option>
                  {subcategories.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label">Urgency</label>
                <div className="new-enquiry-segmented" role="radiogroup" aria-label="Urgency">
                  {orderedUrgencies.map((u) => {
                    const active = urgencyId === u.id;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`new-enquiry-seg-btn ${active ? 'new-enquiry-seg-btn--active' : ''}`}
                        onClick={() => setUrgencyId(u.id)}
                      >
                        {u.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {routedPreview ? (
              <div className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>
                Routes to team: <strong>{routedPreview.team?.name ?? 'Intake'}</strong>
              </div>
            ) : null}

            <div className="field-group">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                }}
              >
                <label className="field-label" htmlFor="enq-summary">
                  One-line summary <span style={{ color: 'var(--coral)' }}>*</span>
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  {summary.length} / 120
                </span>
              </div>
              <input
                id="enq-summary"
                type="text"
                maxLength={120}
                className="field-input"
                placeholder="e.g. Settlement agreement review, senior operations manager"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              {errors.summary ? <span className="field-error">{errors.summary}</span> : null}
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="enq-other-parties">
                Other parties named{' '}
                <span className="muted" style={{ fontWeight: 400 }}>
                  (separate with commas)
                </span>
              </label>
              <input
                id="enq-other-parties"
                type="text"
                className="field-input"
                placeholder="e.g. landlord Bay Retail Group Ltd, neighbour Mrs Patel"
                value={otherPartiesNamed}
                onChange={(e) => setOtherPartiesNamed(e.target.value)}
              />
            </div>

            <div className="field-group" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <label className="field-label" htmlFor="enq-notes">
                Enquiry notes <span style={{ color: 'var(--coral)' }}>*</span>{' '}
                <span className="muted" style={{ fontWeight: 400 }}>
                  (in the caller&rsquo;s own words)
                </span>
              </label>
              <textarea
                id="enq-notes"
                rows={4}
                className="field-textarea"
                style={{ flex: 1, minHeight: 108 }}
                placeholder="The caller's situation, background facts, and what they're asking the firm to do…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {errors.notes ? <span className="field-error">{errors.notes}</span> : null}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(160px, 210px) 1fr',
                gap: 12,
                alignItems: 'end',
              }}
            >
              <div className="field-group">
                <label className="field-label" htmlFor="enq-key-date">
                  Key date{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (if any)
                  </span>
                </label>
                <input
                  id="enq-key-date"
                  type="date"
                  className="field-input"
                  value={keyDate}
                  onChange={(e) => setKeyDate(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-key-date-label">
                  Key date description{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (short description)
                  </span>
                </label>
                <input
                  id="enq-key-date-label"
                  type="text"
                  className="field-input"
                  placeholder="e.g. Completion deadline, hearing date, settlement expiry"
                  value={keyDateLabel}
                  onChange={(e) => setKeyDateLabel(e.target.value)}
                />
              </div>
            </div>

            {enquiryDetailsCustomDefs.length > 0 ? (
              <div className="form-grid-3">
                <CustomFieldGroupItems
                  definitions={enquiryDetailsCustomDefs}
                  values={values}
                  fieldValues={cfValues}
                  errors={errors}
                  onChange={setCfValues}
                />
              </div>
            ) : null}
          </section>

          {additionalCustomDefs.length > 0 ? (
            <section
              className="new-enquiry-card"
              aria-labelledby="sec-enquiry-additional-heading"
            >
              <div className="new-enquiry-card__top">
                <h2
                  id="sec-enquiry-additional-heading"
                  className="new-enquiry-card__label"
                >
                  4 · ADDITIONAL DETAILS
                </h2>
                <span
                  className={`new-enquiry-badge ${
                    additionalMissingCount === 0 ? 'new-enquiry-badge--ok' : ''
                  }`}
                >
                  {additionalMissingCount === 0
                    ? 'Complete'
                    : `${additionalMissingCount} required`}
                </span>
              </div>
              <div className="form-grid-3">
                <CustomFieldGroupItems
                  definitions={additionalCustomDefs}
                  values={values}
                  fieldValues={cfValues}
                  errors={errors}
                  onChange={setCfValues}
                />
              </div>
            </section>
          ) : null}
          </div>

          {/* ==============================================================
              RIGHT STICKY COLUMN:
              - On Saved / Draft Enquiry: NEXT TASK -> QUICK CONFLICT CHECK -> TABBED (Contact log / Tasks / Audit trail)
              - On New Enquiry: STICKY TOP ACTIONS + QUICK CONFLICT CHECK
              ============================================================== */}
          <aside
            className="person-form-side-col"
            style={isSavedEnquiry && enquiry ? { marginTop: 0 } : undefined}
          >
            {!isSavedEnquiry ? (
              <div className="new-enquiry-footer-actions">
                <Link
                  href="/enquiries"
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                >
                  Cancel
                </Link>
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                  disabled={pending}
                  onClick={() => submitForm(true)}
                >
                  Save as draft
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ borderRadius: 999, padding: '0 22px' }}
                  disabled={pending}
                  onClick={() => submitForm(false)}
                >
                  Send to Team
                </button>
              </div>
            ) : null}

            {/* 1. NEXT TASK (Saved / Draft enquiries only) */}
            {isSavedEnquiry && enquiry ? (
              <section
                className="new-enquiry-card"
                aria-labelledby="sec-next-task-heading"
                style={{ gap: 6, padding: '16px 20px' }}
              >
                <div className="new-enquiry-card__top">
                  <h2 id="sec-next-task-heading" className="new-enquiry-card__label">
                    NEXT TASK
                  </h2>
                </div>
                {nextTask ? (
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.35 }}>
                      <Link
                        href={`/tasks?focus=${nextTask.id}`}
                        style={{ color: 'var(--color-primary)', textDecoration: 'none' }}
                      >
                        {nextTask.title}
                      </Link>
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                      {(() => {
                        const assignee = nextTask.assignedPersonId
                          ? people.find((p) => p.id === nextTask.assignedPersonId)
                          : null;
                        const team = nextTask.assignedTeamId
                          ? teams.find((tm) => tm.id === nextTask.assignedTeamId)
                          : null;
                        return `Due ${formatDate(nextTask.dueAt)}${
                          assignee
                            ? ` · ${personDisplayName(assignee)}`
                            : team
                              ? ` · ${team.name}`
                              : ''
                        } · ${nextTask.reference}`;
                      })()}
                    </div>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    No open tasks for this enquiry.
                  </p>
                )}
              </section>
            ) : null}

            {/* 2. QUICK CONFLICT CHECK */}
            <section
              className="new-enquiry-card new-enquiry-card--grow"
              aria-labelledby="sec-conflict-heading"
            >
              <div className="new-enquiry-card__top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h2 id="sec-conflict-heading" className="new-enquiry-card__label">
                    QUICK CONFLICT CHECK
                  </h2>
                  <InfoPopover
                    label="About the quick conflict check"
                    title="What the quick conflict check looks for"
                    docHref="/docs/quick-conflict-check"
                    docLabel="How the quick conflict check works"
                  >
                    <p>
                      As you type, the caller&rsquo;s details are compared with existing People,
                      Organisations and matters.
                    </p>
                    <ul>
                      <li>
                        <strong>Possible conflicts</strong>: the caller or their organisation is a known
                        opposite party (by name, email, phone or address), or someone named as an other
                        party is an existing client or opposite party.
                      </li>
                      <li>
                        <strong>Already known to us</strong>: existing records with the same name,
                        email, phone, address or postcode, which you can link to the enquiry.
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
                Runs as you type the caller&rsquo;s name, the organisation, other parties, email,
                phone or address.
              </p>

              {/* Dynamic results area */}
              <div
                style={{
                  flex: 1,
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
                      label={`Linked: ${personDisplayName(people.find((p) => p.id === linkedPersonId)!) || linkedPersonId}`}
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
                    {!hasOtherPartyInput
                      ? 'Caller checked. Other side not yet named. Ask who the other party is.'
                      : 'No conflicts or existing records matched.'}
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

              <p
                className="muted"
                style={{ margin: 'auto 0 0', fontSize: 12.5, lineHeight: 1.4 }}
              >
                {isDraftMode
                  ? `Last recorded ${formatDateTime(savedSnapshot?.recordedAt ?? lastSavedAt)}; re-runs as you edit. Indicative only. Don’t share results with the caller.`
                  : 'Indicative only. The full conflict check runs before a matter is opened. Don’t share results with the caller.'}
              </p>
            </section>

            {/* 3. TABBED WINDOW: Contact log (default) · Tasks · Audit trail */}
            {isSavedEnquiry && enquiry ? (
              <section
                className="new-enquiry-card"
                aria-label="Contact log, tasks and audit trail"
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <div
                    className="new-enquiry-tabs"
                    style={{ borderBottom: 0, marginBottom: 0, gap: 12, minWidth: 0 }}
                    role="tablist"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={savedPanelTab === 'contact'}
                      className={`new-enquiry-tab ${
                        savedPanelTab === 'contact' ? 'new-enquiry-tab--active' : ''
                      }`}
                      onClick={() => setSavedPanelTab('contact')}
                    >
                      Contact log ({enquiry.contactLog.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={savedPanelTab === 'tasks'}
                      className={`new-enquiry-tab ${
                        savedPanelTab === 'tasks' ? 'new-enquiry-tab--active' : ''
                      }`}
                      onClick={() => setSavedPanelTab('tasks')}
                    >
                      Tasks ({enquiryTasks.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={savedPanelTab === 'audit'}
                      className={`new-enquiry-tab ${
                        savedPanelTab === 'audit' ? 'new-enquiry-tab--active' : ''
                      }`}
                      onClick={() => setSavedPanelTab('audit')}
                    >
                      Audit trail ({displayAudit.length})
                    </button>
                  </div>

                  {savedPanelTab === 'contact' ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{
                        borderRadius: 999,
                        height: 28,
                        padding: '0 10px',
                        fontSize: 12,
                        marginBottom: 6,
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                      onClick={() => setLogContactModalOpen(true)}
                    >
                      + Rec. contact
                    </button>
                  ) : savedPanelTab === 'tasks' ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999, height: 28, padding: '0 10px', fontSize: 12, marginBottom: 6 }}
                      onClick={() => setNewTaskModalOpen(true)}
                    >
                      + New task
                    </button>
                  ) : !open && enquiry.status !== 'Converted' && !enquiry.anonymisedAt && canAnonymise ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ fontSize: 11.5, marginBottom: 6 }}
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const res = await anonymiseExpiredEnquiriesAction(enquiry.id);
                          if (isActionDenied(res)) {
                            showToast(res.message);
                            return;
                          }
                          if (res.count === 0) {
                            const retentionEnd = formatDate(
                              addMonths(
                                new Date(enquiry.receivedAt),
                                Math.max(1, enquirySettings?.retentionMonths || 12),
                              ),
                            );
                            showToast(
                              `Not yet due for anonymisation (retention period ends ${retentionEnd})`,
                            );
                            return;
                          }
                          showToast('Personal details anonymised for retention compliance');
                          router.refresh();
                        })
                      }
                    >
                      Anonymise
                    </button>
                  ) : null}
                </div>

                {/* Tab Content */}
                {savedPanelTab === 'contact' ? (
                  enquiry.contactLog.length === 0 ? (
                    <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45 }}>
                      No contact logged yet. Use &ldquo;Record contact&rdquo; whenever you call or
                      meet the enquirer.
                    </p>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        maxHeight: 260,
                        overflowY: 'auto',
                      }}
                    >
                      {enquiry.contactLog.map((c) => {
                        const byPerson = people.find((p) => p.id === c.byId);
                        return (
                          <div
                            key={c.id}
                            style={{
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: '1px solid var(--border-subtle)',
                              fontSize: 12.5,
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                                fontWeight: 600,
                              }}
                            >
                              <span>
                                {c.method} · {c.outcome}
                              </span>
                              <span className="muted" style={{ fontWeight: 400 }}>
                                {formatDateTime(c.at)}
                              </span>
                            </div>
                            {c.note ? <div style={{ marginTop: 4 }}>{c.note}</div> : null}
                            {byPerson ? (
                              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                                By {personDisplayName(byPerson)}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : savedPanelTab === 'tasks' ? (
                  enquiryTasks.length === 0 ? (
                    <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45 }}>
                      No tasks yet. The first-contact callback task is raised when the enquiry is
                      saved and routed.
                    </p>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        maxHeight: 260,
                        overflowY: 'auto',
                      }}
                    >
                      {enquiryTasks.map((t) => {
                        const assignee = t.assignedPersonId
                          ? people.find((p) => p.id === t.assignedPersonId)
                          : null;
                        const team = t.assignedTeamId
                          ? teams.find((tm) => tm.id === t.assignedTeamId)
                          : null;
                        return (
                          <div
                            key={t.id}
                            style={{
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: '1px solid var(--border-subtle)',
                              fontSize: 12.5,
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                                fontWeight: 600,
                              }}
                            >
                              <Link href={`/tasks?focus=${t.id}`}>{t.title}</Link>
                              <span
                                className="muted"
                                style={{ fontWeight: 400, whiteSpace: 'nowrap' }}
                              >
                                {t.status}
                              </span>
                            </div>
                            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                              {t.reference} · Due {formatDate(t.dueAt)}
                              {assignee
                                ? ` · ${personDisplayName(assignee)}`
                                : team
                                  ? ` · ${team.name}`
                                  : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : displayAudit.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                    No audit entries recorded yet.
                  </p>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      maxHeight: 260,
                      overflowY: 'auto',
                    }}
                  >
                    {displayAudit.map((a, idx) => {
                      const actor = people.find((p) => p.id === a.byId);
                      const actorDisplay = actor ? personDisplayName(actor) : a.byId;
                      const sentEmail =
                        (a.snapshot as EnquirySentEmailSnapshot | undefined)?.kind === 'sent_email'
                          ? (a.snapshot as EnquirySentEmailSnapshot)
                          : null;
                      return (
                        <div
                          key={a.id}
                          style={{
                            fontSize: 12.5,
                            paddingBottom: idx < displayAudit.length - 1 ? 8 : 0,
                            borderBottom:
                              idx < displayAudit.length - 1
                                ? '1px solid var(--border-subtle)'
                                : 'none',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              {a.field ?? a.action}
                            </div>
                            {sentEmail ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--xs"
                                style={{ borderRadius: 999, flexShrink: 0 }}
                                onClick={() => setViewingSentEmail({ entry: a, email: sentEmail })}
                              >
                                View email
                              </button>
                            ) : null}
                          </div>
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                            {formatDateTime(a.at)} · {actorDisplay}
                            {a.newValue ? ` · ${a.newValue}` : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}
          </aside>
        </div>
      </form>

      {/* MODAL: ASSIGN ENQUIRY */}
      {assignModalOpen && enquiry ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setAssignModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">Assign enquiry {enquiry.reference}</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setAssignModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleAssignSubmit}>
              <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field-group">
                  <label className="field-label" htmlFor="assign-enq-team">
                    Team
                  </label>
                  <select
                    id="assign-enq-team"
                    className="field-select"
                    value={assignTeamId}
                    onChange={(e) => setAssignTeamId(e.target.value)}
                  >
                    <option value="">— None —</option>
                    {teams
                      .filter((t) => t.active)
                      .map((tm) => (
                        <option key={tm.id} value={tm.id}>
                          {tm.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="assign-enq-person">
                    Assigned person
                  </label>
                  <select
                    id="assign-enq-person"
                    className="field-select"
                    value={assignPersonId}
                    onChange={(e) => setAssignPersonId(e.target.value)}
                  >
                    <option value="">— Unclaimed (team queue) —</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {personDisplayName(emp)} ({resolveLabel(values, emp.employeeRoleId)})
                      </option>
                    ))}
                  </select>
                  <span className="field-help">
                    Assigning the enquiry also moves its open contact callback task to that person.
                  </span>
                </div>
              </div>
              <div className="modal__footer">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setAssignModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Save assignment
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: CLOSE / DECLINE / REFER OUT */}
      {closeModalMode && enquiry ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setCloseModalMode(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">
                {closeModalMode === 'Declined'
                  ? isDraftMode
                    ? 'Decline draft enquiry'
                    : 'Decline enquiry'
                  : closeModalMode === 'Referred out'
                    ? 'Refer enquiry out'
                    : 'Close enquiry — No response'}
              </h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setCloseModalMode(null)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCloseSubmit}>
              <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {closeModalMode === 'Declined' ? (
                  <div className="field-group">
                    <label className="field-label" htmlFor="close-reason-select">
                      Reason <span style={{ color: 'var(--coral)' }}>*</span>
                    </label>
                    <select
                      id="close-reason-select"
                      className="field-select"
                      required
                      value={closeReasonId}
                      onChange={(e) => setCloseReasonId(e.target.value)}
                    >
                      <option value="">Select…</option>
                      {closeReasons.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {closeModalMode === 'Referred out' ? (
                  <>
                    <div className="field-group">
                      <label className="field-label" htmlFor="refer-org-select">
                        Referred to organisation in directory (optional)
                      </label>
                      <select
                        id="refer-org-select"
                        className="field-select"
                        value={referredToOrganisationId}
                        onChange={(e) => {
                          setReferredToOrganisationId(e.target.value);
                          const o = organisations.find((x) => x.id === e.target.value);
                          if (o && !referredToName) setReferredToName(o.legalName);
                        }}
                      >
                        <option value="">— Or type firm/service name below —</option>
                        {organisations
                          .filter((o) => !o.mergedIntoId)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.legalName} ({o.id})
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="refer-name-input">
                        Referred to firm or service name *
                      </label>
                      <input
                        id="refer-name-input"
                        type="text"
                        required={!referredToOrganisationId}
                        className="field-input"
                        placeholder="e.g. Morgans Criminal Defence LLP"
                        value={referredToName}
                        onChange={(e) => setReferredToName(e.target.value)}
                      />
                    </div>
                  </>
                ) : null}

                <div className="field-group">
                  <label className="field-label" htmlFor="close-notes-input">
                    Notes
                  </label>
                  <textarea
                    id="close-notes-input"
                    rows={3}
                    className="field-textarea"
                    placeholder="Context or explanation for the file…"
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal__footer">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setCloseModalMode(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  {closeModalMode === 'Declined'
                    ? 'Decline enquiry'
                    : `Confirm ${closeModalMode.toLowerCase()}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODAL: CONVERT TO MATTER */}
      {convertModalOpen && enquiry ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setConvertModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 660 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">Convert {enquiry.reference} to a matter</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConvertModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConvertProceed}>
              <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    Step 1 — Link or create client record
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                    Select an existing Person (and Organisation if acting for a business), or leave
                    set to create a new client record from the enquiry details.
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className="field-group">
                      <label className="field-label" htmlFor="conv-person-select">
                        Person record for {firstName || enquiry.firstName}{' '}
                        {lastName || enquiry.lastName}
                      </label>
                      <select
                        id="conv-person-select"
                        className="field-select"
                        value={convertUsePersonId}
                        onChange={(e) => setConvertUsePersonId(e.target.value)}
                      >
                        <option value="">
                          + Create new Person ({firstName || enquiry.firstName}{' '}
                          {lastName || enquiry.lastName})
                        </option>
                        {people
                          .filter((p) => !p.mergedIntoId && !p.isEmployee)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              Use existing: {personDisplayName(p)} ({p.id})
                              {liveEntityMatches.people.some((m) => m.person.id === p.id)
                                ? ' ★ Suggested match'
                                : ''}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="field-group">
                      <label className="checkbox-pill">
                        <input
                          type="checkbox"
                          checked={convertForBusiness}
                          onChange={(e) => setConvertForBusiness(e.target.checked)}
                        />
                        <span>
                          Enquiry is on behalf of a business / organisation (
                          {callingOnBehalfOf ||
                            enquiry.callingOnBehalfOf ||
                            'specify or link organisation'}
                          )
                        </span>
                      </label>
                    </div>

                    {convertForBusiness ? (
                      <div className="field-group">
                        <label className="field-label" htmlFor="conv-org-select">
                          Organisation client record
                        </label>
                        <select
                          id="conv-org-select"
                          className="field-select"
                          value={convertUseOrgId}
                          onChange={(e) => setConvertUseOrgId(e.target.value)}
                        >
                          <option value="">
                            + Create new Organisation (
                            {callingOnBehalfOf ||
                              enquiry.callingOnBehalfOf ||
                              `${firstName || enquiry.firstName} ${lastName || enquiry.lastName} Business`}
                            )
                          </option>
                          {organisations
                            .filter((o) => !o.mergedIntoId)
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                Use existing: {o.legalName} ({o.id})
                                {liveEntityMatches.organisations.some(
                                  (m) => m.organisation.id === o.id,
                                )
                                  ? ' ★ Suggested match'
                                  : ''}
                              </option>
                            ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    Step 2 — Pre-conversion conflict check
                  </div>
                  {conflictCheck.hasBlockingConflict ? (
                    <div className="banner banner--warning">
                      <div>
                        <strong>Conflict identified — conversion blocked:</strong>
                        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                          {[
                            ...conflictCheck.otherPartyClientMatches,
                            ...conflictCheck.clientAgainstPartyMatches,
                          ]
                            .filter((h) => h.blocking)
                            .map((hit, idx) => (
                              <li key={`${hit.recordId}-${idx}`}>
                                <strong>{hit.queryTerm}</strong> — {hit.reason}
                              </li>
                            ))}
                        </ul>
                        <div style={{ marginTop: 8 }}>
                          Conversion cannot proceed while an active conflict exists. You can decline
                          this enquiry with reason <strong>Conflict</strong> (which will raise the
                          non-engagement letter task).
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="subcard" style={{ background: 'var(--bg-subtle)' }}>
                      <StatusPill label="No blocking conflicts found" tone="positive" />{' '}
                      <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>
                        Checked client ({firstName || enquiry.firstName}{' '}
                        {lastName || enquiry.lastName}
                        {callingOnBehalfOf ? ` / ${callingOnBehalfOf}` : ''}) and other parties (
                        {otherPartiesNamed || 'none named'}) against People, Organisations and
                        Matter parties.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="modal__footer">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setConvertModalOpen(false)}
                >
                  Cancel
                </button>
                {conflictCheck.hasBlockingConflict ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleDeclineConflict}
                  >
                    Decline enquiry (Conflict)
                  </button>
                ) : (
                  <button type="submit" className="btn btn--primary" disabled={pending}>
                    Continue to pre-filled New Matter form →
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Record Contact Modal */}
      {logContactModalOpen && enquiry ? (
        <div className="modal-backdrop" onClick={() => setLogContactModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">Record contact</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setLogContactModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleLogContact}>
              <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="new-enquiry-row-2">
                  <div className="field-group">
                    <label className="field-label" htmlFor="contact-method">
                      Method
                    </label>
                    <select
                      id="contact-method"
                      className="field-select"
                      value={contactMethod}
                      onChange={(e) => {
                        const nextMethod = e.target.value as 'Phone' | 'In person' | 'Video call';
                        setContactMethod(nextMethod);
                        const allowed = CONTACT_OUTCOMES_BY_METHOD[nextMethod];
                        if (!allowed.includes(contactOutcome)) {
                          setContactOutcome(allowed[0]);
                        }
                      }}
                    >
                      <option value="Phone">Phone</option>
                      <option value="In person">In person</option>
                      <option value="Video call">Video call</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="contact-outcome">
                      Outcome
                    </label>
                    <select
                      id="contact-outcome"
                      className="field-select"
                      value={contactOutcome}
                      onChange={(e) => setContactOutcome(e.target.value as ContactLogOutcome)}
                    >
                      {CONTACT_OUTCOMES_BY_METHOD[contactMethod].map((outcomeOpt) => (
                        <option key={outcomeOpt} value={outcomeOpt}>
                          {outcomeOpt}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="contact-notes">
                    Notes
                  </label>
                  <textarea
                    id="contact-notes"
                    rows={3}
                    className="field-textarea"
                    value={contactNote}
                    onChange={(e) => setContactNote(e.target.value)}
                    placeholder="Summary of call or message…"
                  />
                  {contactOutcome === 'Spoke' && !isDraftMode ? (
                    <span className="field-help">
                      Logging &lsquo;Spoke&rsquo; automatically moves the enquiry to{' '}
                      <strong>In contact</strong> and marks the initial callback task complete.
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="modal__footer">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setLogContactModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Save contact log
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Send Email Modal (with WYSIWYG formatting) */}
      {sendEmailModalOpen && enquiry ? (
        <div className="modal-backdrop" onClick={() => setSendEmailModalOpen(false)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">Send email</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setSendEmailModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSendEmail}>
              <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field-group">
                  <label className="field-label" htmlFor="send-email-to">
                    To <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <input
                    id="send-email-to"
                    type="email"
                    required
                    className="field-input"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="recipient@example.com"
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="send-email-subject">
                    Subject <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <input
                    id="send-email-subject"
                    type="text"
                    required
                    className="field-input"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="send-email-body">
                    Message <span style={{ color: 'var(--coral)' }}>*</span>
                  </label>
                  <div
                    style={{
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      background: 'var(--bg-card)',
                    }}
                  >
                    {/* WYSIWYG Toolbar */}
                    <div
                      role="toolbar"
                      aria-label="Email formatting toolbar"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: '6px 8px',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: 'var(--bg-subtle)',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Bold"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('bold')}
                      >
                        <strong>B</strong>
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Italic"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('italic')}
                      >
                        <em>I</em>
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Underline"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('underline')}
                      >
                        <span style={{ textDecoration: 'underline' }}>U</span>
                      </button>
                      <span
                        style={{
                          width: 1,
                          height: 16,
                          background: 'var(--border-strong)',
                          margin: '0 4px',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Heading"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('formatBlock', '<h3>')}
                      >
                        H3
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Normal text"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('formatBlock', '<p>')}
                      >
                        Paragraph
                      </button>
                      <span
                        style={{
                          width: 1,
                          height: 16,
                          background: 'var(--border-strong)',
                          margin: '0 4px',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Bulleted list"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('insertUnorderedList')}
                      >
                        • List
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Numbered list"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('insertOrderedList')}
                      >
                        1. List
                      </button>
                      <span
                        style={{
                          width: 1,
                          height: 16,
                          background: 'var(--border-strong)',
                          margin: '0 4px',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title="Clear formatting"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyEmailFormat('removeFormat')}
                      >
                        Clear format
                      </button>
                    </div>
                    {/* Editable Message Area */}
                    <div
                      id="send-email-body"
                      ref={emailEditorRef}
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      aria-multiline="true"
                      aria-label="Email message body"
                      onInput={(e) => setEmailBodyHtml((e.target as HTMLDivElement).innerHTML)}
                      style={{
                        minHeight: 180,
                        maxHeight: 320,
                        overflowY: 'auto',
                        padding: '10px 12px',
                        fontSize: 14,
                        lineHeight: 1.5,
                        color: 'var(--text-primary)',
                        outline: 'none',
                      }}
                    />
                  </div>
                  <span className="field-help">
                    Sending will record this email in the enquiry&rsquo;s audit trail so it can be
                    reviewed at a later date.
                  </span>
                </div>
              </div>
              <div className="modal__footer">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setSendEmailModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending}>
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Review Sent Email Modal */}
      {viewingSentEmail ? (
        <div className="modal-backdrop" onClick={() => setViewingSentEmail(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3 className="modal__title">Sent email</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setViewingSentEmail(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr',
                  rowGap: 6,
                  columnGap: 12,
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 13,
                }}
              >
                <span className="muted" style={{ fontWeight: 600 }}>
                  From
                </span>
                <span>
                  {(() => {
                    const sender = people.find((p) => p.id === viewingSentEmail.email.sentById);
                    return sender
                      ? `${personDisplayName(sender)} (${firmName})`
                      : `${viewingSentEmail.email.sentById} (${firmName})`;
                  })()}
                </span>
                <span className="muted" style={{ fontWeight: 600 }}>
                  To
                </span>
                <span>{viewingSentEmail.email.to}</span>
                <span className="muted" style={{ fontWeight: 600 }}>
                  Sent
                </span>
                <span>{formatDateTime(viewingSentEmail.email.sentAt)}</span>
                <span className="muted" style={{ fontWeight: 600 }}>
                  Subject
                </span>
                <span style={{ fontWeight: 600 }}>{viewingSentEmail.email.subject}</span>
              </div>
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-card)',
                  fontSize: 14,
                  lineHeight: 1.55,
                  minHeight: 120,
                  maxHeight: 360,
                  overflowY: 'auto',
                }}
                dangerouslySetInnerHTML={{
                  __html:
                    viewingSentEmail.email.bodyHtml ||
                    viewingSentEmail.email.bodyText.replace(/\n/g, '<br />'),
                }}
              />
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setViewingSentEmail(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* New Task Modal */}
      {enquiry ? (
        <CreateTaskModal
          open={newTaskModalOpen}
          headerTitle="Create task"
          headerSubtitle="Create a task on this enquiry and assign it to one or more people."
          peopleSectionLabel="PEOPLE ON THIS ENQUIRY"
          initialTaskName=""
          taskNamePlaceholder="e.g. Check document availability"
          suggestedPeople={suggestedEnquiryTaskAssignees}
          initialSelectedPersonIds={[enquiry.assignedToId ?? currentUserId]}
          employees={employees}
          values={values}
          defaultDueHoursFromNow={48}
          submitting={pending}
          submitLabel="Create task"
          onClose={() => setNewTaskModalOpen(false)}
          onSubmit={handleCreateTask}
        />
      ) : null}

      {/* Address Modal */}
      {addressModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="address-modal-title"
          onClick={() => setAddressModalOpen(false)}
        >
          <div
            className="modal"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h3 id="address-modal-title" className="modal__title">
                Enquirer address
              </h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setAddressModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div
              className="modal__body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <div className="field-group">
                <label className="field-label" htmlFor="enq-modal-postcode">
                  Postcode
                </label>
                <div className="new-enquiry-postcode-row">
                  <input
                    id="enq-modal-postcode"
                    type="text"
                    className="field-input"
                    placeholder="E.G. CF10 1AA"
                    value={postcode}
                    onChange={(e) => setPostcode(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    style={{ borderRadius: 999, padding: '0 16px' }}
                    onClick={() => {
                      const clean = postcode.replace(/\s+/g, '').toUpperCase();
                      if (!clean) {
                        showToast('Enter a postcode first (e.g. CF10 1AA).');
                        return;
                      }
                      handleFindAddress();
                    }}
                  >
                    Find address
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-line1">
                  Address line 1
                </label>
                <input
                  id="enq-line1"
                  type="text"
                  className="field-input"
                  value={line1}
                  onChange={(e) => setLine1(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-line2">
                  Address line 2
                </label>
                <input
                  id="enq-line2"
                  type="text"
                  className="field-input"
                  value={line2}
                  onChange={(e) => setLine2(e.target.value)}
                />
              </div>

              <div className="new-enquiry-row-2">
                <div className="field-group">
                  <label className="field-label" htmlFor="enq-town">
                    Town / city
                  </label>
                  <input
                    id="enq-town"
                    type="text"
                    className="field-input"
                    value={town}
                    onChange={(e) => setTown(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="enq-county">
                    County / region
                  </label>
                  <input
                    id="enq-county"
                    type="text"
                    className="field-input"
                    value={county}
                    onChange={(e) => setCounty(e.target.value)}
                  />
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-country">
                  Country
                </label>
                <select
                  id="enq-country"
                  className="field-select"
                  value={countryId ?? ''}
                  onChange={(e) => setCountryId(e.target.value || null)}
                >
                  {countries.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal__footer">
              {[line1, line2, town, county, postcode].some((s) => s.trim().length > 0) ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ marginRight: 'auto' }}
                  onClick={() => {
                    setLine1('');
                    setLine2('');
                    setTown('');
                    setCounty('');
                    setPostcode('');
                    setAddressUserTyping(false);
                    setAddressLookupQuery('');
                    setAddressSuggestions([]);
                    setAddressDropdownOpen(false);
                  }}
                >
                  Clear address
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setAddressUserTyping(false);
                  setAddressLookupQuery(
                    formatSingleLineAddress({ line1, line2, town, county, postcode }),
                  );
                  setAddressModalOpen(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Received & Taken By Modal */}
      {receivedModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="received-modal-title"
          onClick={() => setReceivedModalOpen(false)}
        >
          <div
            className="modal"
            style={{ maxWidth: 480 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h3 id="received-modal-title" className="modal__title">
                Received &amp; taken by
              </h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setReceivedModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div
              className="modal__body"
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              {/* 1. Taken by employee search + list */}
              <div className="field-group">
                <label className="field-label" htmlFor="enq-modal-emp-search">
                  Taken by (employee)
                </label>
                <input
                  id="enq-modal-emp-search"
                  type="text"
                  className="field-input"
                  placeholder="Search employees by name or role…"
                  value={modalEmployeeQuery}
                  onChange={(e) => setModalEmployeeQuery(e.target.value)}
                  autoFocus
                />
                <div
                  role="listbox"
                  aria-label="Employees"
                  style={{
                    marginTop: 6,
                    maxHeight: 190,
                    overflowY: 'auto',
                    border: '1px solid var(--border, #e2e8f0)',
                    borderRadius: 8,
                    background: 'var(--surface, #fff)',
                    padding: 4,
                  }}
                >
                  {filteredModalEmployees.length === 0 ? (
                    <div
                      className="muted"
                      style={{ padding: '10px 12px', fontSize: 12.5 }}
                    >
                      No matching employees found.
                    </div>
                  ) : (
                    filteredModalEmployees.map((emp) => {
                      const selected = emp.id === modalTakenById;
                      const roleLabel = resolveLabel(values, emp.employeeRoleId);
                      const isCurrentUser = emp.id === currentUserId;
                      return (
                        <button
                          key={emp.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => setModalTakenById(emp.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 10px',
                            border: 'none',
                            borderRadius: 6,
                            cursor: 'pointer',
                            background: selected
                              ? 'var(--surface-subtle, #f1f5f9)'
                              : 'transparent',
                            fontWeight: selected ? 600 : 400,
                            fontSize: 13,
                            color: 'var(--ink, #0f172a)',
                          }}
                        >
                          <span>
                            {personDisplayName(emp)}
                            {isCurrentUser ? ' (You)' : ''}
                            {roleLabel ? (
                              <span
                                className="muted"
                                style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}
                              >
                                · {roleLabel}
                              </span>
                            ) : null}
                          </span>
                          {selected ? (
                            <span
                              style={{
                                color: 'var(--teal, #0d9488)',
                                fontWeight: 700,
                                fontSize: 13,
                              }}
                            >
                              ✓
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 2. Date & time (past dates/times only) */}
              <div className="field-group">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 6,
                  }}
                >
                  <label className="field-label" style={{ marginBottom: 0 }}>
                    Date &amp; time received (past only)
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ height: 22, padding: '0 8px', fontSize: 12 }}
                    onClick={() => {
                      const { dateStr, timeStr } = getLocalDateAndTimeStrings(
                        new Date(),
                      );
                      setModalDate(dateStr);
                      setModalTime(timeStr);
                      setModalUseNow(!isSavedEnquiry);
                      setModalReceivedError(null);
                    }}
                  >
                    Reset to Now
                  </button>
                </div>

                {(() => {
                  const { dateStr: todayStr, timeStr: nowTimeStr } =
                    getLocalDateAndTimeStrings(new Date());
                  return (
                    <div className="new-enquiry-row-2">
                      <div className="field-group">
                        <label
                          className="field-label"
                          htmlFor="enq-modal-rec-date"
                          style={{ fontSize: 12 }}
                        >
                          Date
                        </label>
                        <input
                          id="enq-modal-rec-date"
                          type="date"
                          className="field-input"
                          max={todayStr}
                          value={modalDate}
                          onChange={(e) => {
                            setModalDate(e.target.value);
                            setModalUseNow(false);
                            setModalReceivedError(null);
                          }}
                        />
                      </div>
                      <div className="field-group">
                        <label
                          className="field-label"
                          htmlFor="enq-modal-rec-time"
                          style={{ fontSize: 12 }}
                        >
                          Time
                        </label>
                        <input
                          id="enq-modal-rec-time"
                          type="time"
                          className="field-input"
                          max={modalDate === todayStr ? nowTimeStr : undefined}
                          value={modalTime}
                          onChange={(e) => {
                            setModalTime(e.target.value);
                            setModalUseNow(false);
                            setModalReceivedError(null);
                          }}
                        />
                      </div>
                    </div>
                  );
                })()}

                {modalUseNow && !isSavedEnquiry ? (
                  <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Currently set to <strong>Now</strong> (records exact timestamp when saved). Pick a date or time above to backdate.
                  </span>
                ) : null}

                {modalReceivedError ? (
                  <span className="field-error" style={{ marginTop: 4 }}>
                    {modalReceivedError}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setReceivedModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleApplyReceivedModal}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
