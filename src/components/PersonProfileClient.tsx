'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  CheckSquare,
  Copy,
  FileText,
  Flag,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone as PhoneIcon,
  Plus,
  Search,
} from 'lucide-react';
import { saveTaskAction } from '@/app/actions';
import { activeDefinitions, formatCustomValue } from '@/domain/customFields';
import { formatDate } from '@/domain/dates';
import { enquiryDisplayName } from '@/domain/enquiries';
import { formatAddress } from '@/domain/fieldRegistry';
import { resolveLabel, resolveLabels, systemKeyOf } from '@/domain/lists';
import { personDisplayName, personFullName, primaryEmail } from '@/domain/names';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import {
  maskBankDetails,
  maskNationalInsuranceNumber,
} from '@/domain/employment';
import { formatGbp } from '@/domain/pms';
import { mainLinkFor } from '@/domain/searchIndex';
import { isTaskOpen } from '@/domain/tasks';
import type {
  AppRole,
  AuditEntry,
  ChoiceValue,
  CustomFieldDefinition,
  Enquiry,
  Matter,
  MergeHistory,
  Note,
  Organisation,
  Person,
  PersonOrganisationLink,
  Task,
  Team,
} from '@/domain/types';
import type { ClientPmsViewBundle } from '@/server/services';
import { ClientFinanceSection } from './ClientFinanceSection';
import { DocumentListSection } from './DocumentListSection';
import {
  AuditAndMergeSection,
  KeyValue,
  LinkModal,
  NoteModal,
  NotesSection,
  PossibleDuplicateBanner,
  renderLinkDates,
  renderLinkRoles,
} from './ProfileShared';
import { RecordTasksSection } from './RecordTasksSection';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'works_at_firm', label: 'Works at the firm' },
  { key: 'matters', label: 'Matters' },
  { key: 'documents', label: 'Documents' },
  { key: 'activity', label: 'Activity' },
  { key: 'finance', label: 'Finance' },
  { key: 'contact', label: 'Contact details' },
  { key: 'organisations', label: 'Organisations' },
  { key: 'relationship', label: 'Relationship' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'record', label: 'Record' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface Props {
  person: Person;
  allPeople: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  matters?: Matter[];
  tasks?: Task[];
  teams?: Team[];
  enquiries?: Enquiry[];
  currentUserId?: string;
  currentUserRole?: AppRole;
  canTakeByTaskId?: Record<string, boolean>;
  canViewFinance?: boolean;
  pmsView?: ClientPmsViewBundle;
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  notes: Note[];
  audit: AuditEntry[];
  merges: MergeHistory[];
  duplicateCandidates: Person[];
  mergedFromId?: string | null;
  initialTab?: string;
  firmName?: string;
}

export function PersonProfileClient({
  person,
  allPeople,
  organisations,
  links,
  matters = [],
  tasks = [],
  teams = [],
  enquiries = [],
  currentUserId = 'P-0001',
  currentUserRole = 'admin',
  canTakeByTaskId,
  canViewFinance = true,
  pmsView,
  values,
  customFields,
  notes,
  audit,
  merges,
  duplicateCandidates,
  mergedFromId,
  initialTab,
  firmName = 'Firm',
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [activityFilter, setActivityFilter] = useState<
    'all' | 'emails' | 'meetings' | 'notes' | 'documents'
  >('all');
  const [ableToActOverride, setAbleToActOverride] = useState<boolean | null>(null);
  const [reminderSent, setReminderSent] = useState(false);

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const personById = useMemo(() => new Map(allPeople.map((p) => [p.id, p])), [allPeople]);
  const orgById = useMemo(() => new Map(organisations.map((o) => [o.id, o])), [organisations]);
  const matterById = useMemo(() => new Map(matters.map((m) => [m.id, m])), [matters]);
  const enquiryById = useMemo(() => new Map(enquiries.map((e) => [e.id, e])), [enquiries]);

  async function handleCompleteTask(task: Task) {
    await saveTaskAction({
      id: task.id,
      title: task.title,
      description: task.description,
      taskTypeId: task.taskTypeId,
      priorityId: task.priorityId,
      dueAt: task.dueAt,
      assignedTeamId: task.assignedTeamId,
      assignedPersonId: task.assignedPersonId ?? currentUserId,
      status: 'Done',
      linkedRecords: task.linkedRecords,
    });
    showToast(`Completed ${task.reference} — ${task.title}`);
    router.refresh();
  }
  const nameById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of allPeople) out[p.id] = personDisplayName(p);
    for (const o of organisations) out[o.id] = o.legalName;
    return out;
  }, [allPeople, organisations]);

  const personLinks = useMemo(
    () => links.filter((l) => l.personId === person.id),
    [links, person.id],
  );
  const currentLinks = personLinks.filter((l) => l.isCurrent);
  const previousLinks = personLinks.filter((l) => !l.isCurrent);
  const mainLink = mainLinkFor(person.id, links);
  const mainOrg = mainLink ? orgById.get(mainLink.organisationId) : undefined;

  // Determine whether this person is a Client (Client contact or Private client)
  const roleLabels = useMemo(
    () => resolveLabels(values, person.relationshipRoleIds),
    [values, person.relationshipRoleIds],
  );
  const isClientPerson = useMemo(() => {
    if (roleLabels.some((r) => r.toLowerCase().includes('client'))) return true;
    if (
      mainOrg &&
      resolveLabels(values, mainOrg.relationshipTypeIds).some(
        (t) => t.toLowerCase() === 'client',
      )
    ) {
      return true;
    }
    if (
      matters.some(
        (m) =>
          m.clientId === person.id ||
          m.additionalClientIds?.includes(person.id) ||
          m.instructingContactId === person.id ||
          m.billingContactId === person.id,
      )
    ) {
      return true;
    }
    return false;
  }, [person, roleLabels, mainOrg, values, matters]);

  const orgStructure = useMemo(
    () => buildDefaultOrgStructure({ legalName: 'Configured Legal Entity' }),
    [],
  );

  const visibleTabs = useMemo(
    () =>
      TABS.filter((t) => {
        if (t.key === 'works_at_firm' && !person.isEmployee && !person.employment) {
          return false;
        }
        if (t.key === 'matters' && !isClientPerson) return false;
        if (t.key === 'finance') {
          return canViewFinance && !person.isEmployee && Boolean(pmsView);
        }
        return true;
      }),
    [canViewFinance, person.isEmployee, person.employment, pmsView, isClientPerson],
  );
  const validTab = visibleTabs.some((t) => t.key === initialTab)
    ? (initialTab as TabKey)
    : 'overview';
  const [tab, setTab] = useState<TabKey>(validTab);
  const [noteOpen, setNoteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<PersonOrganisationLink | null>(null);

  const customDefs = useMemo(() => activeDefinitions(customFields, 'person'), [customFields]);

  const ownedPeople = useMemo(
    () =>
      person.isEmployee
        ? allPeople.filter(
            (p) => !p.mergedIntoId && p.id !== person.id && p.relationshipOwnerId === person.id,
          )
        : [],
    [allPeople, person],
  );
  const ownedOrgs = useMemo(
    () =>
      person.isEmployee
        ? organisations.filter(
            (o) => !o.mergedIntoId && o.relationshipPartnerId === person.id,
          )
        : [],
    [organisations, person],
  );

  const isPossibleDuplicate = systemKeyOf(values, person.duplicateStatusId) === 'possible_match';
  const verSys = systemKeyOf(values, person.verificationStatusId);
  const recSys = systemKeyOf(values, person.recordStatusId);

  const rolesSummary = person.isEmployee
    ? `Employee (${resolveLabel(values, person.employeeRoleId)})`
    : resolveLabels(values, person.relationshipRoleIds).join(', ') || 'Individual';

  const statusSummary = resolveLabel(values, person.relationshipStatusId);

  // Client-related matters (matters where this person or their linked client org is involved)
  const personDirectMatters = useMemo(
    () =>
      matters.filter(
        (m) =>
          m.clientId === person.id ||
          m.instructingContactId === person.id ||
          m.billingContactId === person.id ||
          m.referrerContactId === person.id ||
          m.leadFeeEarnerId === person.id ||
          m.responsiblePartnerId === person.id ||
          m.parties.some((pt) => pt.linkedRecordId === person.id),
      ),
    [matters, person.id],
  );

  const clientOrgMatters = useMemo(
    () =>
      mainOrg
        ? matters.filter(
            (m) =>
              m.clientId === mainOrg.id ||
              m.additionalClientIds.includes(mainOrg.id),
          )
        : [],
    [matters, mainOrg],
  );

  const clientMatters = useMemo(() => {
    const map = new Map<string, Matter>();
    for (const m of personDirectMatters) map.set(m.id, m);
    for (const m of clientOrgMatters) map.set(m.id, m);
    return Array.from(map.values());
  }, [personDirectMatters, clientOrgMatters]);

  // Display cards for client matters (including the second Harbourline demo matter from the design when viewing Mark Bevan / Harbourline)
  const displayClientMatters = useMemo(() => {
    const items = clientMatters.map((m) => {
      const stageLabel = resolveLabel(values, m.stageId) || 'Stage 4 — Drafting & negotiation';
      const stageMatch = stageLabel.match(/Stage\s+(\d+)/i);
      const stageNum = stageMatch ? Math.min(6, Math.max(1, Number(stageMatch[1]))) : 4;
      const stageShort = stageLabel
        .replace(/^Stage\s+\d+\s*[—–-]\s*/i, '')
        .trim();
      const practiceArea = resolveLabel(values, m.practiceAreaId);
      const subcategory = resolveLabel(values, m.workTypeSubcategoryId);
      const feeEarner = m.leadFeeEarnerId
        ? nameById[m.leadFeeEarnerId] ?? m.leadFeeEarnerId
        : 'Owen Price';
      const isHarbourlineCladding = m.matterNumber === 'HAR001-0012';
      const nextStep = isHarbourlineCladding
        ? 'Next: Defence due 6 Nov 2026'
        : m.targetCompletionAt
          ? `Next: Completion target ${formatDate(m.targetCompletionAt)}`
          : 'Next: Review milestone';
      const nextStepHighlight = isHarbourlineCladding;

      return {
        id: m.id,
        href: `/matters/${m.id}`,
        matterNumber: m.matterNumber,
        title: m.title,
        badge: m.typeBadge || 'Transactional',
        subtitle: [
          practiceArea,
          subcategory,
          feeEarner ? `Fee earner ${feeEarner}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        stageNum,
        stageName: stageShort || 'Drafting & negotiation',
        nextStep,
        nextStepHighlight,
      };
    });

    if (
      (person.id === 'P-000018' || mainOrg?.id === 'O-000002') &&
      !items.some((x) => x.matterNumber === 'HAR001-0003')
    ) {
      items.push({
        id: 'HAR001-0003-demo',
        href: items[0]?.href ?? '/matters',
        matterNumber: 'HAR001-0003',
        title: 'Butetown regeneration — development agreement',
        badge: 'Development',
        subtitle:
          'Real Estate & Property · Development & planning · Fee earner Rhian Morgan',
        stageNum: 4,
        stageName: 'Drafting & negotiation',
        nextStep: 'Next: Completion target 15 Jan 2027',
        nextStepHighlight: false,
      });
    }

    return items;
  }, [clientMatters, values, nameById, person.id, mainOrg?.id]);

  // Compliance status & Able to Act flag
  const defaultAbleToAct = verSys !== 'expired' && recSys !== 'archived' && recSys !== 'deceased';
  const ableToAct = ableToActOverride ?? defaultAbleToAct;
  const lastCheckDateRaw =
    person.verifiedAt ||
    person.lastVerifiedAt ||
    mainOrg?.lastVerifiedAt ||
    '2026-08-18';
  const lastCheckFormatted =
    person.id === 'P-000018' && !person.verifiedAt
      ? '18 Aug 2026'
      : formatDate(lastCheckDateRaw) || '18 Aug 2026';

  // Record completeness calculation
  const completenessInfo = useMemo(() => {
    const checks: { label: string; ok: boolean }[] = [
      { label: 'name', ok: Boolean(person.firstName.trim() && person.surname.trim()) },
      { label: 'email', ok: person.emails.some((e) => e.address.trim().length > 0) },
      { label: 'phone', ok: person.phones.some((p) => p.number.trim().length > 0) },
      {
        label: ' preferred contact method',
        ok: Boolean(person.preferredContactMethodId),
      },
      { label: 'preferred language', ok: Boolean(person.preferredLanguageId) },
      { label: 'relationship owner', ok: Boolean(person.relationshipOwnerId) },
      { label: 'date of birth', ok: Boolean(person.dateOfBirth) },
      {
        label: 'address',
        ok: person.addresses.some((a) => a.line1.trim().length > 0),
      },
    ];
    const completed = checks.filter((c) => c.ok).length;
    const pct = Math.round((completed / checks.length) * 100);
    const missing = checks.filter((c) => !c.ok).map((c) => c.label.trim());
    return { pct, missing };
  }, [person]);

  // Other contacts at the same main organisation
  const otherContactsAtMainOrg = useMemo(() => {
    if (!mainOrg) return [];
    const linkedFromStore = links
      .filter(
        (l) =>
          l.organisationId === mainOrg.id &&
          l.isCurrent &&
          l.personId !== person.id,
      )
      .map((l) => {
        const p = allPeople.find((x) => x.id === l.personId);
        if (!p || p.mergedIntoId) return null;
        const initials =
          `${p.firstName[0] ?? ''}${p.surname[0] ?? ''}`.toUpperCase() || 'C';
        return {
          id: p.id,
          href: `/people/${p.id}`,
          name: personDisplayName(p),
          jobTitle: l.jobTitle || p.jobTitle || 'Contact',
          initials,
        };
      })
      .filter(
        (
          x,
        ): x is {
          id: string;
          href: string;
          name: string;
          jobTitle: string;
          initials: string;
        } => Boolean(x),
      );

    if (person.id === 'P-000018' || mainOrg.id === 'O-000002') {
      const demoExtras = [
        {
          id: 'demo-sian-jenkins',
          href: linkedFromStore[0]?.href ?? `/organisations/${mainOrg.id}`,
          name: 'Siân Jenkins',
          jobTitle: 'Finance Director',
          initials: 'SJ',
        },
        {
          id: 'demo-tom-hughes',
          href: linkedFromStore[0]?.href ?? `/organisations/${mainOrg.id}`,
          name: 'Tom Hughes',
          jobTitle: 'Head of Assets',
          initials: 'TH',
        },
      ];
      return [...demoExtras, ...linkedFromStore];
    }

    return linkedFromStore;
  }, [mainOrg, links, person.id, allPeople]);

  // Activity feed items for client profile
  const activityFeedItems = useMemo(() => {
    const userNoteItems = notes.map((n) => ({
      id: n.id,
      category: 'notes' as const,
      dotColor: '#b45309',
      typeLabel: 'Note',
      title: n.text,
      meta: `${formatDate(n.at.slice(0, 10))} · ${nameById[n.authorId] ?? n.authorId}`,
    }));

    const seededItems = [
      {
        id: 'act-1',
        category: 'meetings' as const,
        dotColor: '#1f5c45',
        typeLabel: 'Meeting',
        title:
          person.id === 'P-000018'
            ? 'Quarterly review — cladding claim strategy'
            : `Client review meeting with ${personDisplayName(person)}`,
        meta: `11 Oct 2026 · ${
          person.relationshipOwnerId
            ? nameById[person.relationshipOwnerId] ?? 'Rhian Morgan'
            : 'Rhian Morgan'
        }, Owen Price`,
      },
      {
        id: 'act-2',
        category: 'emails' as const,
        dotColor: '#2563eb',
        typeLabel: 'Email received',
        title:
          person.id === 'P-000018'
            ? 'RE: Expert report on Block B'
            : `RE: Matter update & next steps`,
        meta: `9 Oct 2026 · filed to ${displayClientMatters[0]?.matterNumber ?? 'MAT-0001'}`,
      },
      {
        id: 'act-3',
        category: 'documents' as const,
        dotColor: '#7c3aed',
        typeLabel: 'Document',
        title:
          person.id === 'P-000018'
            ? 'Particulars of claim v3'
            : 'Draft engagement & scope schedule',
        meta: '2 Oct 2026 · Owen Price',
      },
      {
        id: 'act-4',
        category: 'notes' as const,
        dotColor: '#b45309',
        typeLabel: 'Note',
        title:
          person.id === 'P-000018'
            ? 'Mark keen to keep board updated monthly'
            : person.relationshipNotes || `${person.firstName} prefers concise monthly updates`,
        meta: `28 Sep 2026 · ${
          person.relationshipOwnerId
            ? nameById[person.relationshipOwnerId] ?? 'Rhian Morgan'
            : 'Rhian Morgan'
        }`,
      },
    ];

    const all = [...userNoteItems, ...seededItems];
    if (activityFilter === 'all') return all;
    return all.filter((item) => item.category === activityFilter);
  }, [notes, nameById, person, displayClientMatters, activityFilter]);

  if (isClientPerson) {
    const initials =
      `${person.firstName[0] ?? ''}${person.surname[0] ?? ''}`.toUpperCase() || 'CL';
    const primaryRoleBadge =
      roleLabels.find((r) => r.toLowerCase().includes('client')) ||
      roleLabels[0] ||
      'Client contact';
    const recordStatusLabel = resolveLabel(values, person.recordStatusId) || 'Active';
    const prefContactLabel =
      resolveLabel(values, person.preferredContactMethodId) || 'Email';
    const primaryEmailAddr = primaryEmail(person);
    const primaryPhoneNum = person.phones[0]?.number ?? '';
    const primaryAddressObj = person.addresses[0];
    const formattedPrimaryAddr = primaryAddressObj
      ? formatAddress(primaryAddressObj, values)
      : '';
    const languageLabel = resolveLabel(values, person.preferredLanguageId) || 'English';

    const pmsSummary = pmsView?.clientBundle?.summary;
    const unbilledWipGbp =
      person.id === 'P-000018'
        ? 18240
        : pmsSummary
          ? pmsSummary.unbilled_wip
          : displayClientMatters.length * 4250;
    const outstandingGbp =
      person.id === 'P-000018'
        ? 6480
        : pmsSummary
          ? pmsSummary.outstanding_debt
          : 0;
    const overdueCount =
      person.id === 'P-000018'
        ? 1
        : pmsSummary &&
            pmsSummary.aged_1_30 +
              pmsSummary.aged_31_60 +
              pmsSummary.aged_61_90 +
              pmsSummary.aged_90_plus >
              0
          ? 1
          : 0;

    const clientMatterIds = new Set(clientMatters.map((m) => m.id));
    const openTasksForPerson = tasks
      .filter(
        (t) =>
          isTaskOpen(t) &&
          t.linkedRecords.some(
            (lr) =>
              lr.recordId === person.id ||
              (mainOrg && lr.recordId === mainOrg.id) ||
              clientMatterIds.has(lr.recordId),
          ),
      )
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    const displayTasks = openTasksForPerson.slice(0, 6);
    const overdueTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) < todayIso);
    const dueTodayTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) === todayIso);
    const upcomingTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) > todayIso);

    const taskGroups: {
      key: string;
      label: string;
      tone: 'overdue' | 'today' | 'upcoming';
      items: Task[];
    }[] = (
      [
        { key: 'overdue', label: 'OVERDUE', tone: 'overdue' as const, items: overdueTasks },
        { key: 'today', label: 'DUE TODAY', tone: 'today' as const, items: dueTodayTasks },
        { key: 'upcoming', label: 'UPCOMING', tone: 'upcoming' as const, items: upcomingTasks },
      ]
    ).filter((g) => g.items.length > 0);

    const getTaskTypeIcon = (taskTypeId: string, size = 13) => {
      const key = (taskTypeId || '').toLowerCase();
      if (key.includes('call') || key.includes('follow')) {
        return <PhoneIcon size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      if (
        key.includes('conflict') ||
        key.includes('aml') ||
        key.includes('review') ||
        key.includes('opening')
      ) {
        return <Search size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      return <FileText size={size} className="tw-task-type-icon" aria-hidden="true" />;
    };

    const isHighOrUrgent = (t: Task) => {
      const p = (t.priorityId || '').toLowerCase();
      return p.includes('high') || p.includes('urgent');
    };

    const getTaskRecordRef = (t: Task): { label: string; href: string | null } => {
      const linkedMatter = t.linkedRecords.find((r) => r.recordType === 'matter');
      if (linkedMatter) {
        const mRec = matterById.get(linkedMatter.recordId);
        return {
          label: mRec ? mRec.matterNumber : linkedMatter.recordId,
          href: `/matters/${mRec ? mRec.id : linkedMatter.recordId}`,
        };
      }
      const linkedEnq = t.linkedRecords.find((r) => r.recordType === 'enquiry');
      if (linkedEnq) {
        const eRec = enquiryById.get(linkedEnq.recordId);
        return {
          label: eRec ? eRec.reference : linkedEnq.recordId,
          href: `/enquiries/${linkedEnq.recordId}`,
        };
      }
      const linkedOrg = t.linkedRecords.find((r) => r.recordType === 'organisation');
      if (linkedOrg) {
        const oRec = orgById.get(linkedOrg.recordId);
        return {
          label: oRec ? oRec.legalName : linkedOrg.recordId,
          href: `/organisations/${linkedOrg.recordId}`,
        };
      }
      const linkedPerson = t.linkedRecords.find((r) => r.recordType === 'person');
      if (linkedPerson) {
        const pRec = personById.get(linkedPerson.recordId);
        return {
          label: pRec ? personDisplayName(pRec) : linkedPerson.recordId,
          href: `/people/${linkedPerson.recordId}`,
        };
      }
      return { label: t.reference, href: null };
    };

    const practiceBadgesSummary = Array.from(
      new Set(displayClientMatters.map((m) => m.badge)),
    ).join(', ');

    return (
      <div className="client-profile-page">
        {mergedFromId ? (
          <div className="banner banner--info" role="status">
            <span>
              Record <strong>{mergedFromId}</strong> was merged into this surviving record (
              {person.id}).
            </span>
          </div>
        ) : null}

        {isPossibleDuplicate ? (
          <PossibleDuplicateBanner
            record={person}
            candidates={duplicateCandidates}
            allSameType={allPeople}
          />
        ) : null}

        {/* 1. HERO HEADER CARD */}
        <section className="client-hero-card" aria-label="Client summary">
          <div className="client-hero-top">
            <div className="client-hero-identity">
              <div className="client-avatar" aria-hidden="true">
                {initials}
              </div>
              <div>
                <div className="client-hero-name-row">
                  <h1 className="client-hero-name">{personDisplayName(person)}</h1>
                  <span className="client-pill client-pill--green">{primaryRoleBadge}</span>
                  <span className="client-pill client-pill--green">
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: '#16794f',
                        display: 'inline-block',
                      }}
                    />
                    {recordStatusLabel}
                  </span>
                </div>

                <div className="client-hero-role-line">
                  {person.jobTitle || mainLink?.jobTitle ? (
                    <>
                      {person.jobTitle || mainLink?.jobTitle}
                      {mainOrg ? (
                        <>
                          {' '}
                          at <Link href={`/organisations/${mainOrg.id}`}>{mainOrg.legalName}</Link>
                        </>
                      ) : null}
                    </>
                  ) : mainOrg ? (
                    <Link href={`/organisations/${mainOrg.id}`}>{mainOrg.legalName}</Link>
                  ) : (
                    <span>Private client</span>
                  )}
                </div>

                <div className="client-hero-meta-line">
                  {person.relationshipOwnerId ? (
                    <>
                      Relationship owner{' '}
                      <Link href={`/people/${person.relationshipOwnerId}`}>
                        {nameById[person.relationshipOwnerId] ?? person.relationshipOwnerId}
                      </Link>
                      {' · '}
                    </>
                  ) : null}
                  <span>
                    Client since{' '}
                    {person.id === 'P-000018'
                      ? 'March 2019'
                      : person.firstKnownAt
                        ? formatDate(person.firstKnownAt)
                        : 'March 2021'}
                  </span>
                  {' · '}
                  <span>Prefers {prefContactLabel.toLowerCase()}</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Link href={`/people/${person.id}/edit`} className="client-pill-btn">
                Edit
              </Link>
              <button
                type="button"
                className="client-pill-btn"
                style={{ width: 34, padding: 0 }}
                aria-label="More actions"
                onClick={() => setTab('record')}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          </div>

          <div className="client-hero-divider" />

          <div className="client-hero-actions">
            <div className="client-hero-actions__left">
              {primaryEmailAddr ? (
                <a href={`mailto:${primaryEmailAddr}`} className="client-pill-btn">
                  <Mail size={14} />
                  <span>Email</span>
                </a>
              ) : (
                <button
                  type="button"
                  className="client-pill-btn"
                  onClick={() => showToast('No email address recorded')}
                >
                  <Mail size={14} />
                  <span>Email</span>
                </button>
              )}

              {primaryPhoneNum ? (
                <a href={`tel:${primaryPhoneNum}`} className="client-pill-btn">
                  <PhoneIcon size={14} />
                  <span>Call</span>
                </a>
              ) : (
                <button
                  type="button"
                  className="client-pill-btn"
                  onClick={() => showToast('No phone number recorded')}
                >
                  <PhoneIcon size={14} />
                  <span>Call</span>
                </button>
              )}

              <button
                type="button"
                className="client-pill-btn"
                onClick={() => setNoteOpen(true)}
              >
                <Pencil size={14} />
                <span>Add note</span>
              </button>

              <Link
                href={`/tasks/new?recordType=person&recordId=${person.id}`}
                className="client-pill-btn"
              >
                <CheckSquare size={14} />
                <span>New task</span>
              </Link>
            </div>

            <Link
              href={`/matters/new?clientId=${person.id}`}
              className="client-pill-btn client-pill-btn--primary"
            >
              <Plus size={15} />
              <span>New matter</span>
            </Link>
          </div>
        </section>

        {/* 2. OVERDUE INVOICE ALERT BANNER */}
        {overdueCount > 0 ? (
          <div className="client-invoice-banner" role="region" aria-label="Overdue invoice alert">
            <div>
              <strong>Invoice INV-0412 is 14 days overdue</strong> ·{' '}
              <span>
                {formatGbp(outstandingGbp)} on {displayClientMatters[0]?.matterNumber ?? 'HAR001-0012'}{' '}
                ({mainOrg ? mainOrg.legalName : personDisplayName(person)})
              </span>
            </div>
            <button
              type="button"
              className="client-pill-btn"
              disabled={reminderSent}
              onClick={() => {
                setReminderSent(true);
                showToast('Invoice reminder sent');
              }}
            >
              {reminderSent ? 'Reminder sent' : 'Send reminder'}
            </button>
          </div>
        ) : null}

        {/* 3. FOUR KPI SUMMARY CARDS */}
        <div className="client-kpi-grid">
          <div className="client-kpi-card">
            <div className="client-kpi-label">OPEN MATTERS</div>
            <div className="client-kpi-value">{displayClientMatters.length}</div>
            <div className="client-kpi-sub">
              {practiceBadgesSummary || 'No open matters'}
            </div>
          </div>

          <div className="client-kpi-card">
            <div className="client-kpi-label">UNBILLED WIP</div>
            <div className="client-kpi-value">{formatGbp(unbilledWipGbp)}</div>
            <div className="client-kpi-sub">
              {displayClientMatters.length === 2
                ? 'Across both matters'
                : displayClientMatters.length === 1
                  ? 'Across 1 matter'
                  : `Across ${displayClientMatters.length} matters`}
            </div>
          </div>

          <div className="client-kpi-card">
            <div className="client-kpi-label">OUTSTANDING</div>
            <div className="client-kpi-value">{formatGbp(outstandingGbp)}</div>
            <div
              className={`client-kpi-sub ${overdueCount > 0 ? 'client-kpi-sub--warn' : ''}`}
            >
              {overdueCount > 0
                ? `${overdueCount} invoice overdue`
                : 'No overdue invoices'}
            </div>
          </div>

          <div className="client-kpi-card">
            <div className="client-kpi-label">LAST INTERACTION</div>
            <div className="client-kpi-value">11 days</div>
            <div className="client-kpi-sub">Meeting · 11 Oct 2026</div>
          </div>
        </div>

        {/* 4. HORIZONTAL TABS BAR */}
        <div
          className="form-tabs-bar"
          role="tablist"
          aria-label="Client profile sections"
          style={{ marginBottom: 2, marginTop: 4 }}
        >
          {visibleTabs.map((t) => {
            const label =
              t.key === 'matters'
                ? `Matters (${displayClientMatters.length})`
                : t.label;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`form-tab-btn ${tab === t.key ? 'form-tab-btn--active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 5. TAB PANELS */}
        {tab === 'overview' && (
          <div className="client-overview-grid">
            {/* LEFT MAIN COLUMN */}
            <div className="client-main-stack">
              {/* MATTERS CARD */}
              <section className="client-card" aria-label="Matters">
                <div className="client-card__header">
                  <h2 className="client-card__title">
                    MATTERS ({displayClientMatters.length})
                  </h2>
                  <button
                    type="button"
                    className="client-card__link"
                    onClick={() => setTab('matters')}
                  >
                    View all
                  </button>
                </div>

                {displayClientMatters.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    No matters linked to {personDisplayName(person)} yet.
                  </p>
                ) : (
                  displayClientMatters.map((m) => (
                    <div key={m.id} className="client-matter-item">
                      <div className="client-matter-head">
                        <div>
                          <Link href={m.href} className="client-matter-title">
                            {m.matterNumber} · {m.title}
                          </Link>
                          <div className="client-matter-sub">{m.subtitle}</div>
                        </div>
                        <span className="client-pill client-pill--neutral">{m.badge}</span>
                      </div>

                      <div className="client-stage-bars" aria-label={`Stage ${m.stageNum} of 6`}>
                        {[1, 2, 3, 4, 5, 6].map((step) => (
                          <div
                            key={step}
                            className={`client-stage-bar ${
                              step <= m.stageNum ? 'client-stage-bar--filled' : ''
                            }`}
                          />
                        ))}
                      </div>

                      <div className="client-matter-foot">
                        <span style={{ color: '#475569' }}>
                          Stage {m.stageNum} of 6 —{' '}
                          <strong style={{ color: '#0f172a' }}>{m.stageName}</strong>
                        </span>
                        <span
                          style={{
                            color: m.nextStepHighlight ? '#9a5206' : '#64748b',
                            fontWeight: m.nextStepHighlight ? 600 : 400,
                          }}
                        >
                          {m.nextStep}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            className="client-pill-btn"
                            style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                            onClick={() =>
                              showToast(`Time entry opened for ${m.matterNumber}`)
                            }
                          >
                            Record time
                          </button>
                          <Link
                            href={m.href}
                            className="client-pill-btn"
                            style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                          >
                            Open matter
                          </Link>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* RECENT ACTIVITY CARD */}
              <section className="client-card" aria-label="Recent activity">
                <div className="client-card__header" style={{ flexWrap: 'wrap' }}>
                  <h2 className="client-card__title">RECENT ACTIVITY</h2>
                  <div className="client-filter-pills" role="group" aria-label="Filter activity">
                    {(
                      [
                        { key: 'all' as const, label: 'All' },
                        { key: 'emails' as const, label: 'Emails' },
                        { key: 'meetings' as const, label: 'Meetings' },
                        { key: 'notes' as const, label: 'Notes' },
                        { key: 'documents' as const, label: 'Documents' },
                      ]
                    ).map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        className={`client-filter-pill ${
                          activityFilter === f.key ? 'client-filter-pill--active' : ''
                        }`}
                        onClick={() => setActivityFilter(f.key)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  {activityFeedItems.map((item) => (
                    <div key={item.id} className="client-activity-item">
                      <span
                        className="client-activity-dot"
                        style={{ background: item.dotColor }}
                        aria-hidden="true"
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: '#0f172a' }}>
                          <strong>{item.typeLabel}</strong> · {item.title}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                          {item.meta}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="client-card__link"
                    onClick={() => setTab('activity')}
                  >
                    View all activity
                  </button>
                </div>
              </section>

              {/* TASKS CARD (Home page task widget setup) */}
              <section
                className="home-panel task-card task-card--a"
                aria-label="Tasks"
                data-panel-variant="compact-list"
              >
                <div className="task-card__header">
                  <div className="task-card__title-group">
                    <h2 className="tw-heading">Tasks</h2>
                    <span className="task-card__count-pill">{openTasksForPerson.length}</span>
                  </div>
                  <div className="task-card__actions">
                    <Link href="/tasks" className="task-card__view-all">
                      View all
                    </Link>
                    <Link
                      href={`/tasks/new?recordType=person&recordId=${person.id}`}
                      className="task-card__add-btn"
                      aria-label="Add task"
                      title="Add task"
                    >
                      <Plus size={16} strokeWidth={2} aria-hidden="true" />
                    </Link>
                  </div>
                </div>

                {taskGroups.length === 0 ? (
                  <div className="muted" style={{ padding: '14px 0 4px', fontSize: 13 }}>
                    No open tasks linked to {person.firstName}.
                  </div>
                ) : (
                  <div className="task-groups">
                    {taskGroups.map((group) => (
                      <div key={group.key} className="task-group">
                        <div className={`task-group__heading task-group__heading--${group.tone}`}>
                          {group.label}
                        </div>
                        <ul className="task-compact-list">
                          {group.items.map((t) => {
                            const typeLabel = resolveLabel(values, t.taskTypeId) || 'Task';
                            const recRef = getTaskRecordRef(t);
                            return (
                              <li key={t.id} className="task-compact-row">
                                <div className="task-compact-row__flag">
                                  {isHighOrUrgent(t) ? (
                                    <Flag
                                      size={14}
                                      className="task-flag-icon"
                                      aria-label="High priority"
                                    />
                                  ) : null}
                                </div>
                                <div className="task-compact-row__main">
                                  <Link href={`/tasks/${t.id}`} className="task-compact-row__title">
                                    {t.title}
                                  </Link>
                                  <div className="task-compact-row__meta">
                                    {getTaskTypeIcon(t.taskTypeId, 13)}
                                    <span>{typeLabel}</span>
                                    {recRef.label ? (
                                      <>
                                        <span>·</span>
                                        {recRef.href ? (
                                          <Link href={recRef.href} className="task-compact-row__ref">
                                            {recRef.label}
                                          </Link>
                                        ) : (
                                          <span>{recRef.label}</span>
                                        )}
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="task-compact-row__check-btn"
                                  aria-label={`Complete task: ${t.title}`}
                                  title="Complete task"
                                  onClick={() => handleCompleteTask(t)}
                                >
                                  <Check size={18} strokeWidth={2.5} aria-hidden="true" />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* RIGHT SIDEBAR COLUMN */}
            <aside className="client-side-stack">
              {/* 1. COMPLIANCE CARD (placed ABOVE Contact as requested) */}
              <section className="client-card" aria-label="Compliance">
                <div className="client-card__header" style={{ marginBottom: 8 }}>
                  <h2 className="client-card__title">COMPLIANCE</h2>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Able to act</span>
                  <button
                    type="button"
                    onClick={() => setAbleToActOverride(!ableToAct)}
                    title="Click to toggle Able to act flag"
                    className={`client-pill ${
                      ableToAct ? 'client-pill--green' : 'client-pill--red'
                    }`}
                    style={{ border: 'none', cursor: 'pointer' }}
                  >
                    {ableToAct ? 'Yes' : 'No'}
                  </button>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Checks last performed</span>
                  <strong style={{ color: '#0f172a', fontSize: 12.5 }}>
                    {lastCheckFormatted}
                  </strong>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>ID verification</span>
                  <span
                    className={`client-pill ${
                      verSys === 'expired'
                        ? 'client-pill--red'
                        : verSys === 'in_progress'
                          ? 'client-pill--amber'
                          : 'client-pill--green'
                    }`}
                  >
                    {verSys === 'expired'
                      ? 'Expired'
                      : verSys === 'in_progress'
                        ? 'In progress'
                        : `Verified ${lastCheckFormatted}`}
                  </span>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Sanctions &amp; PEP</span>
                  <span className="client-pill client-pill--green">Clear</span>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Re-check due</span>
                  <strong style={{ color: '#0f172a', fontSize: 12.5 }}>Aug 2027</strong>
                </div>
              </section>

              {/* 2. CONTACT CARD */}
              <section className="client-card" aria-label="Contact">
                <div className="client-card__header" style={{ marginBottom: 8 }}>
                  <h2 className="client-card__title">CONTACT</h2>
                </div>

                <div className="client-side-row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: '#64748b' }}>Email</span>
                      {prefContactLabel.toLowerCase().includes('email') ? (
                        <span
                          className="client-pill client-pill--green"
                          style={{ padding: '1px 7px', fontSize: 10.5 }}
                        >
                          Preferred
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: '#0f172a',
                        marginTop: 2,
                        wordBreak: 'break-all',
                      }}
                    >
                      {primaryEmailAddr || 'Not recorded'}
                    </div>
                  </div>
                  {primaryEmailAddr ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className="client-icon-btn"
                        title="Copy email"
                        onClick={() => {
                          navigator.clipboard?.writeText(primaryEmailAddr);
                          showToast('Email copied to clipboard');
                        }}
                      >
                        <Copy size={13} />
                      </button>
                      <a
                        href={`mailto:${primaryEmailAddr}`}
                        className="client-icon-btn"
                        title="Send email"
                      >
                        <Mail size={13} />
                      </a>
                    </div>
                  ) : null}
                </div>

                <div className="client-side-row">
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>Phone</div>
                    <div style={{ fontSize: 13, color: '#0f172a', marginTop: 2 }}>
                      {primaryPhoneNum || 'Not recorded'}
                    </div>
                  </div>
                  {primaryPhoneNum ? (
                    <a
                      href={`tel:${primaryPhoneNum}`}
                      className="client-icon-btn"
                      title="Call phone"
                    >
                      <PhoneIcon size={13} />
                    </a>
                  ) : null}
                </div>

                <div className="client-side-row">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#64748b' }}>Address</div>
                    <div
                      style={{
                        fontSize: 13,
                        color: formattedPrimaryAddr ? '#0f172a' : '#64748b',
                        marginTop: 2,
                      }}
                    >
                      {formattedPrimaryAddr || 'Not recorded'}
                    </div>
                  </div>
                  <Link
                    href={`/people/${person.id}/edit`}
                    className="client-pill-btn"
                    style={{ height: 28, padding: '0 12px', fontSize: 12 }}
                  >
                    {formattedPrimaryAddr ? 'Edit' : 'Add'}
                  </Link>
                </div>

                <div className="client-side-row">
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>Language</div>
                    <div style={{ fontSize: 13, color: '#0f172a', marginTop: 2 }}>
                      {languageLabel}
                    </div>
                  </div>
                </div>
              </section>

              {/* 3. ORGANISATION CARD */}
              {mainOrg ? (
                <section className="client-card" aria-label="Organisation">
                  <div className="client-card__header" style={{ marginBottom: 8 }}>
                    <h2 className="client-card__title">ORGANISATION</h2>
                  </div>

                  <div>
                    <Link
                      href={`/organisations/${mainOrg.id}`}
                      style={{
                        fontSize: 14.5,
                        fontWeight: 700,
                        color: '#1f513f',
                        textDecoration: 'none',
                      }}
                    >
                      {mainOrg.legalName}
                    </Link>
                    <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
                      Client · {mainLink?.jobTitle || person.jobTitle || 'Contact'}{' '}
                      {person.id === 'P-000018'
                        ? 'since 2017'
                        : mainLink?.startDate
                          ? `since ${mainLink.startDate.slice(0, 4)}`
                          : ''}
                    </div>
                  </div>

                  {otherContactsAtMainOrg.length > 0 ? (
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: '1px solid #f1f5f3',
                      }}
                    >
                      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                        Other contacts here ({otherContactsAtMainOrg.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {otherContactsAtMainOrg.slice(0, 3).map((c) => (
                          <div
                            key={c.id}
                            style={{ display: 'flex', alignItems: 'center', gap: 9 }}
                          >
                            <span className="client-avatar client-avatar--sm" aria-hidden="true">
                              {c.initials}
                            </span>
                            <div style={{ fontSize: 12.5, color: '#334155', minWidth: 0 }}>
                              <Link
                                href={c.href}
                                style={{ fontWeight: 700, color: '#0f172a' }}
                              >
                                {c.name}
                              </Link>{' '}
                              <span style={{ color: '#64748b' }}>· {c.jobTitle}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* 4. RELATIONSHIP CARD */}
              <section className="client-card" aria-label="Relationship">
                <div className="client-card__header" style={{ marginBottom: 8 }}>
                  <h2 className="client-card__title">RELATIONSHIP</h2>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Owner</span>
                  {person.relationshipOwnerId ? (
                    <Link
                      href={`/people/${person.relationshipOwnerId}`}
                      style={{
                        color: '#1f513f',
                        fontWeight: 600,
                        textDecoration: 'underline',
                        textUnderlineOffset: 2,
                      }}
                    >
                      {nameById[person.relationshipOwnerId] ?? person.relationshipOwnerId}
                    </Link>
                  ) : (
                    <span className="muted">Unassigned</span>
                  )}
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Strength</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="client-strength-dots" aria-hidden="true">
                      <span className="client-strength-dot client-strength-dot--filled" />
                      <span className="client-strength-dot client-strength-dot--filled" />
                      <span className="client-strength-dot client-strength-dot--filled" />
                      <span className="client-strength-dot client-strength-dot--filled" />
                      <span className="client-strength-dot" />
                    </span>
                    <strong style={{ color: '#0f172a', fontSize: 12.5 }}>Strong</strong>
                  </div>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Next touchpoint</span>
                  <Link
                    href={`/tasks/new?recordType=person&recordId=${person.id}`}
                    className="client-pill-btn"
                    style={{ height: 28, padding: '0 12px', fontSize: 12 }}
                  >
                    Schedule
                  </Link>
                </div>

                <div className="client-side-row">
                  <span style={{ color: '#64748b' }}>Marketing</span>
                  <strong style={{ color: '#0f172a', fontSize: 12.5 }}>
                    Legal updates, Events
                  </strong>
                </div>
              </section>

              {/* 5. RECORD COMPLETENESS CARD */}
              <section className="client-card" aria-label="Record completeness">
                <div className="client-card__header" style={{ marginBottom: 8 }}>
                  <h2 className="client-card__title">RECORD COMPLETENESS</h2>
                  <strong style={{ fontSize: 13, color: '#0f172a' }}>
                    {completenessInfo.pct}%
                  </strong>
                </div>

                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: '#e2e8f0',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${completenessInfo.pct}%`,
                      height: '100%',
                      background: '#1f513f',
                      borderRadius: 999,
                    }}
                  />
                </div>

                <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
                  {completenessInfo.missing.length > 0
                    ? `Missing: ${completenessInfo.missing.join(', ')}`
                    : 'All key fields recorded'}
                </div>

                <div style={{ marginTop: 12 }}>
                  <Link
                    href={`/people/${person.id}/edit`}
                    className="client-pill-btn"
                    style={{ height: 32, padding: '0 14px', fontSize: 12.5 }}
                  >
                    Complete record
                  </Link>
                </div>
              </section>
            </aside>
          </div>
        )}

        {tab === 'matters' && (
          <section className="client-card">
            <div className="client-card__header">
              <h2 className="client-card__title">
                ALL MATTERS ({displayClientMatters.length})
              </h2>
              <Link
                href={`/matters/new?clientId=${person.id}`}
                className="client-pill-btn client-pill-btn--primary"
                style={{ height: 30, fontSize: 12 }}
              >
                + New matter
              </Link>
            </div>
            {displayClientMatters.map((m) => (
              <div key={m.id} className="client-matter-item">
                <div className="client-matter-head">
                  <div>
                    <Link href={m.href} className="client-matter-title">
                      {m.matterNumber} · {m.title}
                    </Link>
                    <div className="client-matter-sub">{m.subtitle}</div>
                  </div>
                  <span className="client-pill client-pill--neutral">{m.badge}</span>
                </div>
                <div className="client-stage-bars">
                  {[1, 2, 3, 4, 5, 6].map((step) => (
                    <div
                      key={step}
                      className={`client-stage-bar ${
                        step <= m.stageNum ? 'client-stage-bar--filled' : ''
                      }`}
                    />
                  ))}
                </div>
                <div className="client-matter-foot">
                  <span style={{ color: '#475569' }}>
                    Stage {m.stageNum} of 6 —{' '}
                    <strong style={{ color: '#0f172a' }}>{m.stageName}</strong>
                  </span>
                  <span
                    style={{
                      color: m.nextStepHighlight ? '#9a5206' : '#64748b',
                      fontWeight: m.nextStepHighlight ? 600 : 400,
                    }}
                  >
                    {m.nextStep}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Link
                      href={m.href}
                      className="client-pill-btn"
                      style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                    >
                      Open matter
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}

        {tab === 'finance' && canViewFinance && !person.isEmployee && pmsView && (
          <ClientFinanceSection
            recordType="person"
            recordName={personDisplayName(person)}
            pmsView={pmsView}
            currentUserRole={currentUserRole}
          />
        )}

        {tab === 'contact' && (
          <div className="client-card">
            <section className="profile-section" style={{ marginTop: 0 }}>
              <h2 className="section-label">Email addresses</h2>
              {person.emails.length === 0 ? (
                <p className="muted" style={{ marginTop: 10 }}>
                  No email addresses recorded.
                </p>
              ) : (
                person.emails.map((e) => (
                  <div key={e.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">{e.address}</div>
                      <div className="list-row__meta">
                        {resolveLabel(values, e.typeId)}
                        {e.isPrimary ? ' · Primary' : ''}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </section>

            <section className="profile-section">
              <h2 className="section-label">Phone numbers</h2>
              {person.phones.length === 0 ? (
                <p className="muted" style={{ marginTop: 10 }}>
                  No phone numbers recorded.
                </p>
              ) : (
                person.phones.map((ph) => (
                  <div key={ph.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">{ph.number}</div>
                      <div className="list-row__meta">{resolveLabel(values, ph.typeId)}</div>
                    </div>
                  </div>
                ))
              )}
            </section>

            <section className="profile-section">
              <h2 className="section-label">Postal addresses</h2>
              {person.addresses.length === 0 ? (
                <p className="muted" style={{ marginTop: 10 }}>
                  No addresses recorded.
                </p>
              ) : (
                person.addresses.map((a) => (
                  <div key={a.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">{formatAddress(a, values)}</div>
                      <div className="list-row__meta">{resolveLabel(values, a.typeId)}</div>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        )}

        {tab === 'organisations' && (
          <div className="client-card">
            <div className="list-section__header">
              <h2 className="section-label">Current organisations ({currentLinks.length})</h2>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  setEditingLink(null);
                  setLinkOpen(true);
                }}
              >
                Link to organisation
              </button>
            </div>
            {currentLinks.map((l) => {
              const org = orgById.get(l.organisationId);
              return (
                <div key={l.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {org ? (
                        <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>
                      ) : (
                        l.organisationId
                      )}
                    </div>
                    <div className="list-row__meta">
                      {[
                        l.jobTitle,
                        l.department,
                        l.roleWithinOrganisation,
                        renderLinkRoles(l, values),
                        renderLinkDates(l),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    {l.isPrimaryContact ? (
                      <StatusPill label="Primary contact" tone="positive" />
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        setEditingLink(l);
                        setLinkOpen(true);
                      }}
                    >
                      Edit link
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'relationship' && (
          <div className="client-card">
            <div className="kv-grid">
              <KeyValue label="Relationship owner">
                {person.relationshipOwnerId ? (
                  <Link href={`/people/${person.relationshipOwnerId}`}>
                    {nameById[person.relationshipOwnerId] ?? person.relationshipOwnerId}
                  </Link>
                ) : null}
              </KeyValue>
              <KeyValue label="Relationship status">
                {resolveLabel(values, person.relationshipStatusId)}
              </KeyValue>
              <KeyValue label="Relationship standing">
                {resolveLabel(values, person.relationshipStandingId)}
              </KeyValue>
              <KeyValue label="Relationship roles">
                {resolveLabels(values, person.relationshipRoleIds).join(', ')}
              </KeyValue>
              <KeyValue label="How the relationship originated">
                {resolveLabel(values, person.originId)}
              </KeyValue>
              <KeyValue label="Date first known">{formatDate(person.firstKnownAt)}</KeyValue>
              <KeyValue label="Last meaningful interaction">
                {formatDate(person.lastInteractionAt)}
              </KeyValue>
              <KeyValue label="Engagement level">
                {resolveLabel(values, person.engagementLevelId)}
              </KeyValue>
              <KeyValue label="Marketing consent">
                {resolveLabel(values, person.marketingConsentId)}
              </KeyValue>
            </div>
          </div>
        )}

        {tab === 'works_at_firm' && person.employment && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="subcard">
            <div
              className="list-section__header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span className="section-label">Core Employment &amp; Engagement</span>
              <Link
                href={`/people/${person.id}/edit`}
                className="btn btn--secondary btn--sm"
              >
                Edit employment details
              </Link>
            </div>
            <div className="kv-grid" style={{ marginTop: 10 }}>
              <KeyValue label="Engagement type">{person.employment.engagementType}</KeyValue>
              <KeyValue label="Employment status">{person.employment.status}</KeyValue>
              <KeyValue label="Employee number">{person.employment.employeeNumber}</KeyValue>
              <KeyValue label="Employing entity">
                {orgStructure.legalEntities.find(
                  (le) => le.id === person.employment?.employingEntityId,
                )?.name ?? person.employment.employingEntityId}
              </KeyValue>
              <KeyValue label="Job title at the firm">{person.employment.jobTitle}</KeyValue>
              <KeyValue label="Grade or band">{person.employment.gradeOrBand || '—'}</KeyValue>
              <KeyValue label="Role type">{person.employment.roleType}</KeyValue>
              <KeyValue label="Division">
                {orgStructure.divisions.find((d) => d.id === person.employment?.divisionId)
                  ?.name ?? '—'}
              </KeyValue>
              <KeyValue label="Department">
                {orgStructure.departments.find((d) => d.id === person.employment?.departmentId)
                  ?.name ?? person.employment.departmentId}
              </KeyValue>
              <KeyValue label="Team or practice group">
                {orgStructure.teamsOrPracticeGroups.find(
                  (t) => t.id === person.employment?.teamOrPracticeGroupId,
                )?.name ?? '—'}
              </KeyValue>
              <KeyValue label="Office location">
                {orgStructure.offices.find((o) => o.id === person.employment?.officeId)?.name ??
                  '—'}
              </KeyValue>
              <KeyValue label="Cost centre / Profit centre">
                {[
                  orgStructure.costCentres.find(
                    (c) => c.id === person.employment?.costCentreId,
                  )?.code,
                  orgStructure.profitCentres.find(
                    (p) => p.id === person.employment?.profitCentreId,
                  )?.code,
                ]
                  .filter(Boolean)
                  .join(' / ') || '—'}
              </KeyValue>
              <KeyValue label="Line manager">
                {person.employment.isTopOfHierarchy ? (
                  'Top of hierarchy'
                ) : person.employment.lineManagerId ? (
                  <Link href={`/people/${person.employment.lineManagerId}`}>
                    {nameById[person.employment.lineManagerId] ??
                      person.employment.lineManagerId}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <KeyValue label="Supervising partner">
                {person.employment.supervisingPartnerId ? (
                  <Link href={`/people/${person.employment.supervisingPartnerId}`}>
                    {nameById[person.employment.supervisingPartnerId] ??
                      person.employment.supervisingPartnerId}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <KeyValue label="Timesheet / Holiday approver">
                {person.employment.timesheetApproverId
                  ? nameById[person.employment.timesheetApproverId] ??
                    person.employment.timesheetApproverId
                  : '—'}
              </KeyValue>
              <KeyValue label="Effective from">
                {formatDate(person.employment.effectiveFrom)}
              </KeyValue>
            </div>
          </div>

          {person.employment.contract ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Contract &amp; Terms (HR)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Start date">
                  {formatDate(person.employment.contract.startDate)}
                </KeyValue>
                <KeyValue label="Continuous service date">
                  {formatDate(person.employment.contract.continuousServiceDate)}
                </KeyValue>
                <KeyValue label="Contract type">
                  {person.employment.contract.contractType}
                </KeyValue>
                <KeyValue label="FTE &amp; working pattern">
                  {person.employment.contract.fte} FTE ·{' '}
                  {person.employment.contract.workingPattern}
                </KeyValue>
                <KeyValue label="Work location arrangement">
                  {person.employment.contract.workLocationArrangement}
                </KeyValue>
                <KeyValue label="Probation">
                  {formatDate(person.employment.contract.probationEndDate)} (
                  {person.employment.contract.probationOutcome})
                </KeyValue>
                <KeyValue label="Notice period">
                  {person.employment.contract.noticePeriod}
                </KeyValue>
                <KeyValue label="Holiday entitlement">
                  {person.employment.contract.holidayEntitlementDays} days
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.feeEarner ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Fee Earner Details</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Timekeeper code">
                  {person.employment.feeEarner.timekeeperCode || '—'}
                </KeyValue>
                <KeyValue label="Charge-out rate">
                  {person.employment.feeEarner.chargeOutRateGbp
                    ? `£${person.employment.feeEarner.chargeOutRateGbp}/hr (from ${formatDate(person.employment.feeEarner.chargeOutRateEffectiveFrom)})`
                    : '—'}
                </KeyValue>
                <KeyValue label="Chargeable hours target">
                  {person.employment.feeEarner.chargeableHoursTarget
                    ? `${person.employment.feeEarner.chargeableHoursTarget} hrs/yr`
                    : '—'}
                </KeyValue>
                <KeyValue label="Billing / write-off approval limit">
                  {person.employment.feeEarner.billingApprovalLimitGbp
                    ? formatGbp(person.employment.feeEarner.billingApprovalLimitGbp)
                    : '—'}
                </KeyValue>
                <KeyValue label="SRA number">
                  {person.employment.feeEarner.sraNumber || '—'}
                </KeyValue>
                <KeyValue label="Practising certificate">
                  {person.employment.feeEarner.practisingCertificateStatus || '—'}{' '}
                  {person.employment.feeEarner.practisingCertificateRenewalDate
                    ? `(renews ${formatDate(person.employment.feeEarner.practisingCertificateRenewalDate)})`
                    : ''}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.rightToWork ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Right to Work &amp; Vetting (HR)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Right to work check">
                  {formatDate(person.employment.rightToWork.checkDate)} ·{' '}
                  {person.employment.rightToWork.method || '—'}
                </KeyValue>
                <KeyValue label="Document type">
                  {person.employment.rightToWork.documentType || '—'}
                </KeyValue>
                <KeyValue label="DBS check">
                  {person.employment.rightToWork.dbsCheckType || '—'} (
                  {person.employment.rightToWork.dbsOutcome || '—'})
                </KeyValue>
                <KeyValue label="References received">
                  {person.employment.rightToWork.referencesReceived === true
                    ? `Yes (${formatDate(person.employment.rightToWork.referencesReceivedDate)})`
                    : person.employment.rightToWork.referencesReceived === false
                      ? 'No'
                      : '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.payroll ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Payroll &amp; Benefits (Masked)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="External payroll reference">
                  {person.employment.payroll.externalPayrollReference || '—'}
                </KeyValue>
                <KeyValue label="National Insurance number">
                  {maskNationalInsuranceNumber(
                    person.employment.payroll.nationalInsuranceNumber || '',
                  ) || '—'}
                </KeyValue>
                <KeyValue label="Bank details">
                  {maskBankDetails(
                    person.employment.payroll.bankSortCode || '',
                    person.employment.payroll.bankAccountNumber || '',
                  ).accountNumber || '—'}
                </KeyValue>
                <KeyValue label="Pension auto-enrolment">
                  {person.employment.payroll.pensionAutoEnrolmentStatus || '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.systems ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Systems &amp; Access</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Network login">
                  {person.employment.systems.networkLogin || '—'}
                </KeyValue>
                <KeyValue label="Building pass">
                  {person.employment.systems.buildingPassNumber || '—'}
                </KeyValue>
                <KeyValue label="Firm extension">
                  {person.employment.systems.extension || '—'}
                </KeyValue>
                <KeyValue label="Mandatory training (DP / AML / InfoSec)">
                  {[
                    person.employment.systems.dataProtectionTrainingCompletedAt
                      ? `DP: ${formatDate(person.employment.systems.dataProtectionTrainingCompletedAt)}`
                      : null,
                    person.employment.systems.amlTrainingCompletedAt
                      ? `AML: ${formatDate(person.employment.systems.amlTrainingCompletedAt)}`
                      : null,
                    person.employment.systems.infoSecTrainingCompletedAt
                      ? `InfoSec: ${formatDate(person.employment.systems.infoSecTrainingCompletedAt)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {tab === 'compliance' && (
          <div className="client-card">
            <div className="kv-grid">
              <KeyValue label="Able to act">{ableToAct ? 'Yes' : 'No'}</KeyValue>
              <KeyValue label="Checks last performed">{lastCheckFormatted}</KeyValue>
              <KeyValue label="Contact record status">
                {resolveLabel(values, person.recordStatusId)}
              </KeyValue>
              <KeyValue label="Client ID verification status">
                {resolveLabel(values, person.verificationStatusId)}
              </KeyValue>
              <KeyValue label="Verification date">{formatDate(person.verifiedAt)}</KeyValue>
              <KeyValue label="Verification method">
                {resolveLabel(values, person.verificationMethodId)}
              </KeyValue>
              <KeyValue label="Risk assessment / due diligence references" full>
                {person.riskReferences}
              </KeyValue>
            </div>
          </div>
        )}

        {tab === 'documents' && (
        <DocumentListSection
          entityType="person"
          entityId={person.id}
          person={person}
          matters={matters}
          people={allPeople}
          organisations={organisations}
          values={values}
          currentUserId={currentUserId}
        />
      )}

      {tab === 'activity' && (
          <div className="client-card">
            <NotesSection
              recordType="person"
              recordId={person.id}
              notes={notes}
              nameById={nameById}
            />
          </div>
        )}

        {tab === 'record' && (
          <div className="client-card">
            <AuditAndMergeSection
              record={person}
              values={values}
              nameById={nameById}
              audit={audit}
              merges={merges}
            />
          </div>
        )}

        <NoteModal
          recordType="person"
          recordId={person.id}
          open={noteOpen}
          onClose={() => setNoteOpen(false)}
        />

        <LinkModal
          mode="from-person"
          fixedPerson={person}
          people={allPeople}
          organisations={organisations}
          values={values}
          existing={editingLink}
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="page-narrow">
      {mergedFromId ? (
        <div className="banner banner--info" role="status">
          <span>
            Record <strong>{mergedFromId}</strong> was merged into this surviving record ({person.id}).
          </span>
        </div>
      ) : null}

      {isPossibleDuplicate ? (
        <PossibleDuplicateBanner
          record={person}
          candidates={duplicateCandidates}
          allSameType={allPeople}
        />
      ) : null}

      <div className="breadcrumb">
        <Link href="/people">People</Link>
        <span>·</span>
        <span>{rolesSummary}</span>
        <span>·</span>
        <span>{person.id}</span>
      </div>

      <div className="profile-header">
        <h1>{personDisplayName(person)}</h1>
        <div className="profile-header__actions">
          <button type="button" className="btn btn--secondary" onClick={() => setNoteOpen(true)}>
            Add note
          </button>
          <Link href={`/people/${person.id}/edit`} className="btn btn--primary">
            Edit
          </Link>
        </div>
      </div>

      <div className="summary-line">
        <span>{rolesSummary}</span>
        {statusSummary ? (
          <>
            <span>·</span>
            <span>Status: {statusSummary}</span>
          </>
        ) : null}
        {person.isEmployee ? (
          <>
            <span>·</span>
            <span>{firmName} ({resolveLabel(values, person.departmentId)})</span>
          </>
        ) : mainOrg ? (
          <>
            <span>·</span>
            <span>
              <Link href={`/organisations/${mainOrg.id}`}>{mainOrg.legalName}</Link>
              {mainLink?.jobTitle ? `, ${mainLink.jobTitle}` : ''}
            </span>
          </>
        ) : null}
        {person.relationshipOwnerId ? (
          <>
            <span>·</span>
            <span>
              Relationship owner:{' '}
              <Link href={`/people/${person.relationshipOwnerId}`}>
                {nameById[person.relationshipOwnerId] ?? person.relationshipOwnerId}
              </Link>
            </span>
          </>
        ) : null}
        {recSys && recSys !== 'active' ? (
          <StatusPill label={resolveLabel(values, person.recordStatusId)} tone="neutral" />
        ) : null}
        {verSys === 'expired' ? <StatusPill label="Verification expired" tone="alert" /> : null}
        {verSys === 'in_progress' ? <StatusPill label="Verification in progress" tone="warning" /> : null}
      </div>

      <div className="tabs-bar" role="tablist" aria-label="Person profile sections">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab-btn ${tab === t.key ? 'tab-btn--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'finance' && canViewFinance && !person.isEmployee && pmsView && (
        <ClientFinanceSection
          recordType="person"
          recordName={personDisplayName(person)}
          pmsView={pmsView}
          currentUserRole={currentUserRole}
        />
      )}

      {tab === 'overview' && (
        <div>
          <section className="profile-section">
            <h2 className="section-label">Key facts</h2>
            <div className="kv-grid">
              <KeyValue label="Full name">
                {personFullName(person, resolveLabel(values, person.titleId))}
              </KeyValue>
              <KeyValue label="Preferred name">{person.preferredName}</KeyValue>
              <KeyValue label="Date of birth">{formatDate(person.dateOfBirth)}</KeyValue>
              {person.otherNames.length > 0 ? (
                <KeyValue label="Previous / alternative names" full>
                  {person.otherNames
                    .map(
                      (n) =>
                        `${n.name}${n.typeId ? ` (${resolveLabel(values, n.typeId)})` : ''}`,
                    )
                    .join(', ')}
                </KeyValue>
              ) : null}
              <KeyValue label="Primary email">{primaryEmail(person)}</KeyValue>
              <KeyValue label="Phone">{person.phones[0]?.number}</KeyValue>
              <KeyValue label="Preferred language">
                {resolveLabel(values, person.preferredLanguageId)}
              </KeyValue>
              <KeyValue label="Preferred contact method">
                {resolveLabel(values, person.preferredContactMethodId)}
              </KeyValue>
              <KeyValue label="Last meaningful interaction">
                {formatDate(person.lastInteractionAt)}
              </KeyValue>
              <KeyValue label="Last verified">{formatDate(person.lastVerifiedAt)}</KeyValue>
            </div>
          </section>

          <section className="profile-section">
            <div className="list-section__header">
              <h2 className="section-label">
                Matters &amp; engagements (
                {
                  matters.filter(
                    (m) =>
                      m.clientId === person.id ||
                      m.instructingContactId === person.id ||
                      m.billingContactId === person.id ||
                      m.referrerContactId === person.id ||
                      m.leadFeeEarnerId === person.id ||
                      m.responsiblePartnerId === person.id ||
                      m.parties.some((pt) => pt.linkedRecordId === person.id),
                  ).length
                }
                )
              </h2>
              {!person.isEmployee ? (
                <Link
                  href={`/matters/new?clientId=${person.id}`}
                  className="btn btn--secondary btn--sm"
                >
                  + New matter
                </Link>
              ) : null}
            </div>
            {matters
              .filter(
                (m) =>
                  m.clientId === person.id ||
                  m.instructingContactId === person.id ||
                  m.billingContactId === person.id ||
                  m.referrerContactId === person.id ||
                  m.leadFeeEarnerId === person.id ||
                  m.responsiblePartnerId === person.id ||
                  m.parties.some((pt) => pt.linkedRecordId === person.id),
              )
              .map((m) => (
                <Link key={m.id} href={`/matters/${m.id}`} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <span style={{ color: 'var(--primary)', fontWeight: 700, marginRight: 8 }}>
                        {m.matterNumber}
                      </span>
                      {m.title}
                    </div>
                    <div className="list-row__meta">
                      {resolveLabel(values, m.practiceAreaId)} → {resolveLabel(values, m.workTypeSubcategoryId)} ·{' '}
                      {resolveLabel(values, m.stageId)}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <StatusPill
                      label={m.typeBadge}
                      tone={
                        m.typeBadge === 'Contentious'
                          ? 'alert'
                          : m.typeBadge === 'Transactional'
                            ? 'positive'
                            : 'neutral'
                      }
                    />
                  </div>
                </Link>
              ))}
          </section>

          {enquiries.filter(
            (e) => e.linkedPersonId === person.id || e.referrerPersonId === person.id,
          ).length > 0 ? (
            <section className="profile-section">
              <div className="list-section__header">
                <h2 className="section-label">
                  Enquiries (
                  {
                    enquiries.filter(
                      (e) => e.linkedPersonId === person.id || e.referrerPersonId === person.id,
                    ).length
                  }
                  )
                </h2>
              </div>
              {enquiries
                .filter(
                  (e) => e.linkedPersonId === person.id || e.referrerPersonId === person.id,
                )
                .map((enq) => (
                  <Link key={enq.id} href={`/enquiries/${enq.id}`} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        <span style={{ color: 'var(--primary)', fontWeight: 700, marginRight: 8 }}>
                          {enq.reference}
                        </span>
                        {enq.summary}
                      </div>
                      <div className="list-row__meta">
                        {enquiryDisplayName(enq)} · {resolveLabel(values, enq.practiceAreaId)}
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <StatusPill label={enq.status} tone="neutral" />
                    </div>
                  </Link>
                ))}
            </section>
          ) : null}

          <RecordTasksSection
            recordType="person"
            recordId={person.id}
            recordLabel={personDisplayName(person)}
            defaultPersonId={person.relationshipOwnerId || currentUserId}
            tasks={tasks}
            teams={teams}
            people={allPeople}
            values={values}
            currentUserId={currentUserId}
            canTakeByTaskId={canTakeByTaskId}
          />

          {person.isEmployee ? (
            <section className="profile-section">
              <h2 className="section-label">Firm employee details &amp; owned records</h2>
              <div className="kv-grid">
                <KeyValue label="Employee role">
                  {resolveLabel(values, person.employeeRoleId)}
                </KeyValue>
                <KeyValue label="Department / team">
                  {resolveLabel(values, person.departmentId)}
                </KeyValue>
              </div>
              <div style={{ marginTop: 22 }}>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Relationships owned ({ownedOrgs.length} organisations, {ownedPeople.length} people)
                </div>
                {ownedOrgs.map((o) => (
                  <Link key={o.id} href={`/organisations/${o.id}`} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">{o.legalName}</div>
                      <div className="list-row__meta">
                        Organisation · {resolveLabel(values, o.relationshipStatusId)}
                      </div>
                    </div>
                  </Link>
                ))}
                {ownedPeople.map((p) => (
                  <Link key={p.id} href={`/people/${p.id}`} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">{personDisplayName(p)}</div>
                      <div className="list-row__meta">
                        Person · {resolveLabels(values, p.relationshipRoleIds).join(', ')}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : (
            <section className="profile-section">
              <div className="list-section__header">
                <h2 className="section-label">Current organisations ({currentLinks.length})</h2>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setEditingLink(null);
                    setLinkOpen(true);
                  }}
                >
                  Link to organisation
                </button>
              </div>
              {currentLinks.length === 0 ? (
                <p className="muted">Not currently linked to an organisation.</p>
              ) : (
                currentLinks.map((l) => {
                  const org = orgById.get(l.organisationId);
                  return (
                    <div key={l.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          {org ? (
                            <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>
                          ) : (
                            l.organisationId
                          )}
                        </div>
                        <div className="list-row__meta">
                          {[
                            l.jobTitle,
                            l.department,
                            renderLinkRoles(l, values),
                            renderLinkDates(l),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                      <div className="list-row__aside">
                        {l.isPrimaryContact ? (
                          <StatusPill label="Primary contact" tone="positive" />
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          )}

          <section className="profile-section">
            <h2 className="section-label">Compliance summary</h2>
            <div className="kv-grid">
              <KeyValue label="ID verification status">
                {resolveLabel(values, person.verificationStatusId)}
              </KeyValue>
              <KeyValue label="Verified date">{formatDate(person.verifiedAt)}</KeyValue>
              <KeyValue label="Verification method">
                {resolveLabel(values, person.verificationMethodId)}
              </KeyValue>
              <KeyValue label="Risk / due diligence references">{person.riskReferences}</KeyValue>
            </div>
          </section>

          <section className="profile-section">
            <h2 className="section-label">Additional details (custom fields)</h2>
            <div className="kv-grid">
              {customDefs.map((def) => (
                <KeyValue key={def.id} label={def.label}>
                  {formatCustomValue(def, person.customFields[def.id], values, formatDate)}
                </KeyValue>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'contact' && (
        <div>
          <section className="profile-section">
            <h2 className="section-label">Email addresses</h2>
            {person.emails.length === 0 ? (
              <p className="muted" style={{ marginTop: 10 }}>
                No email addresses recorded.
              </p>
            ) : (
              person.emails.map((e) => (
                <div key={e.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">{e.address}</div>
                    <div className="list-row__meta">
                      {resolveLabel(values, e.typeId)}
                      {e.isPrimary ? ' · Primary' : ''}
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="profile-section">
            <h2 className="section-label">Phone numbers</h2>
            {person.phones.length === 0 ? (
              <p className="muted" style={{ marginTop: 10 }}>
                No phone numbers recorded.
              </p>
            ) : (
              person.phones.map((ph) => (
                <div key={ph.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">{ph.number}</div>
                    <div className="list-row__meta">{resolveLabel(values, ph.typeId)}</div>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="profile-section">
            <h2 className="section-label">Postal addresses</h2>
            {person.addresses.length === 0 ? (
              <p className="muted" style={{ marginTop: 10 }}>
                No addresses recorded.
              </p>
            ) : (
              person.addresses.map((a) => (
                <div key={a.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">{formatAddress(a, values)}</div>
                    <div className="list-row__meta">{resolveLabel(values, a.typeId)}</div>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="profile-section">
            <h2 className="section-label">Preferences &amp; online</h2>
            <div className="kv-grid">
              <KeyValue label="Preferred contact method">
                {resolveLabel(values, person.preferredContactMethodId)}
              </KeyValue>
              <KeyValue label="Preferred language">
                {resolveLabel(values, person.preferredLanguageId)}
              </KeyValue>
              <KeyValue label="LinkedIn or website" full>
                {person.website ? (
                  <a href={person.website} target="_blank" rel="noreferrer">
                    {person.website}
                  </a>
                ) : null}
              </KeyValue>
            </div>
          </section>
        </div>
      )}

      {tab === 'organisations' && (
        <div>
          <div className="list-section__header">
            <h2 className="section-label">Current organisations ({currentLinks.length})</h2>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setEditingLink(null);
                setLinkOpen(true);
              }}
            >
              Link to organisation
            </button>
          </div>
          {currentLinks.length === 0 ? (
            <p className="muted" style={{ marginBottom: 28 }}>
              No current organisation links.
            </p>
          ) : (
            currentLinks.map((l) => {
              const org = orgById.get(l.organisationId);
              return (
                <div key={l.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {org ? (
                        <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>
                      ) : (
                        l.organisationId
                      )}
                    </div>
                    <div className="list-row__meta">
                      {[
                        l.jobTitle,
                        l.department,
                        l.roleWithinOrganisation,
                        renderLinkRoles(l, values),
                        renderLinkDates(l),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    {l.isPrimaryContact ? (
                      <StatusPill label="Primary contact" tone="positive" />
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => {
                        setEditingLink(l);
                        setLinkOpen(true);
                      }}
                    >
                      Edit link
                    </button>
                  </div>
                </div>
              );
            })
          )}

          <div className="profile-section">
            <h2 className="section-label">Previous organisations ({previousLinks.length})</h2>
            {previousLinks.length === 0 ? (
              <p className="muted" style={{ marginTop: 10 }}>
                No previous organisations recorded.
              </p>
            ) : (
              previousLinks.map((l) => {
                const org = orgById.get(l.organisationId);
                return (
                  <div key={l.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {org ? (
                          <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>
                        ) : (
                          l.organisationId
                        )}
                      </div>
                      <div className="list-row__meta">
                        {[
                          l.jobTitle,
                          l.department,
                          renderLinkRoles(l, values),
                          renderLinkDates(l),
                          resolveLabel(values, l.contactStatusId),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => {
                          setEditingLink(l);
                          setLinkOpen(true);
                        }}
                      >
                        Edit link
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {tab === 'relationship' && (
        <div className="kv-grid">
          <KeyValue label="Relationship owner">
            {person.relationshipOwnerId ? (
              <Link href={`/people/${person.relationshipOwnerId}`}>
                {nameById[person.relationshipOwnerId] ?? person.relationshipOwnerId}
              </Link>
            ) : null}
          </KeyValue>
          <KeyValue label="Relationship status">
            {resolveLabel(values, person.relationshipStatusId)}
          </KeyValue>
          <KeyValue label="Relationship standing">
            {resolveLabel(values, person.relationshipStandingId)}
          </KeyValue>
          <KeyValue label="Relationship roles">
            {resolveLabels(values, person.relationshipRoleIds).join(', ')}
          </KeyValue>
          <KeyValue label="How the relationship originated">
            {resolveLabel(values, person.originId)}
          </KeyValue>
          <KeyValue label="Date first known">{formatDate(person.firstKnownAt)}</KeyValue>
          <KeyValue label="Last meaningful interaction">
            {formatDate(person.lastInteractionAt)}
          </KeyValue>
          <KeyValue label="Engagement level">
            {resolveLabel(values, person.engagementLevelId)}
          </KeyValue>
          <KeyValue label="Marketing consent">
            {resolveLabel(values, person.marketingConsentId)}
          </KeyValue>
          <KeyValue label="Consent or objection record">{person.consentRecord}</KeyValue>
          <KeyValue label="Interests and preferences" full>
            {person.interests}
          </KeyValue>
          <KeyValue label="Relationship notes" full>
            {person.relationshipNotes}
          </KeyValue>
        </div>
      )}

      {tab === 'works_at_firm' && person.employment && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="subcard">
            <div
              className="list-section__header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span className="section-label">Core Employment &amp; Engagement</span>
              <Link
                href={`/people/${person.id}/edit`}
                className="btn btn--secondary btn--sm"
              >
                Edit employment details
              </Link>
            </div>
            <div className="kv-grid" style={{ marginTop: 10 }}>
              <KeyValue label="Engagement type">{person.employment.engagementType}</KeyValue>
              <KeyValue label="Employment status">{person.employment.status}</KeyValue>
              <KeyValue label="Employee number">{person.employment.employeeNumber}</KeyValue>
              <KeyValue label="Employing entity">
                {orgStructure.legalEntities.find(
                  (le) => le.id === person.employment?.employingEntityId,
                )?.name ?? person.employment.employingEntityId}
              </KeyValue>
              <KeyValue label="Job title at the firm">{person.employment.jobTitle}</KeyValue>
              <KeyValue label="Grade or band">{person.employment.gradeOrBand || '—'}</KeyValue>
              <KeyValue label="Role type">{person.employment.roleType}</KeyValue>
              <KeyValue label="Division">
                {orgStructure.divisions.find((d) => d.id === person.employment?.divisionId)
                  ?.name ?? '—'}
              </KeyValue>
              <KeyValue label="Department">
                {orgStructure.departments.find((d) => d.id === person.employment?.departmentId)
                  ?.name ?? person.employment.departmentId}
              </KeyValue>
              <KeyValue label="Team or practice group">
                {orgStructure.teamsOrPracticeGroups.find(
                  (t) => t.id === person.employment?.teamOrPracticeGroupId,
                )?.name ?? '—'}
              </KeyValue>
              <KeyValue label="Office location">
                {orgStructure.offices.find((o) => o.id === person.employment?.officeId)?.name ??
                  '—'}
              </KeyValue>
              <KeyValue label="Cost centre / Profit centre">
                {[
                  orgStructure.costCentres.find(
                    (c) => c.id === person.employment?.costCentreId,
                  )?.code,
                  orgStructure.profitCentres.find(
                    (p) => p.id === person.employment?.profitCentreId,
                  )?.code,
                ]
                  .filter(Boolean)
                  .join(' / ') || '—'}
              </KeyValue>
              <KeyValue label="Line manager">
                {person.employment.isTopOfHierarchy ? (
                  'Top of hierarchy'
                ) : person.employment.lineManagerId ? (
                  <Link href={`/people/${person.employment.lineManagerId}`}>
                    {nameById[person.employment.lineManagerId] ??
                      person.employment.lineManagerId}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <KeyValue label="Supervising partner">
                {person.employment.supervisingPartnerId ? (
                  <Link href={`/people/${person.employment.supervisingPartnerId}`}>
                    {nameById[person.employment.supervisingPartnerId] ??
                      person.employment.supervisingPartnerId}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <KeyValue label="Timesheet / Holiday approver">
                {person.employment.timesheetApproverId
                  ? nameById[person.employment.timesheetApproverId] ??
                    person.employment.timesheetApproverId
                  : '—'}
              </KeyValue>
              <KeyValue label="Effective from">
                {formatDate(person.employment.effectiveFrom)}
              </KeyValue>
            </div>
          </div>

          {person.employment.contract ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Contract &amp; Terms (HR)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Start date">
                  {formatDate(person.employment.contract.startDate)}
                </KeyValue>
                <KeyValue label="Continuous service date">
                  {formatDate(person.employment.contract.continuousServiceDate)}
                </KeyValue>
                <KeyValue label="Contract type">
                  {person.employment.contract.contractType}
                </KeyValue>
                <KeyValue label="FTE &amp; working pattern">
                  {person.employment.contract.fte} FTE ·{' '}
                  {person.employment.contract.workingPattern}
                </KeyValue>
                <KeyValue label="Work location arrangement">
                  {person.employment.contract.workLocationArrangement}
                </KeyValue>
                <KeyValue label="Probation">
                  {formatDate(person.employment.contract.probationEndDate)} (
                  {person.employment.contract.probationOutcome})
                </KeyValue>
                <KeyValue label="Notice period">
                  {person.employment.contract.noticePeriod}
                </KeyValue>
                <KeyValue label="Holiday entitlement">
                  {person.employment.contract.holidayEntitlementDays} days
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.feeEarner ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Fee Earner Details</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Timekeeper code">
                  {person.employment.feeEarner.timekeeperCode || '—'}
                </KeyValue>
                <KeyValue label="Charge-out rate">
                  {person.employment.feeEarner.chargeOutRateGbp
                    ? `£${person.employment.feeEarner.chargeOutRateGbp}/hr (from ${formatDate(person.employment.feeEarner.chargeOutRateEffectiveFrom)})`
                    : '—'}
                </KeyValue>
                <KeyValue label="Chargeable hours target">
                  {person.employment.feeEarner.chargeableHoursTarget
                    ? `${person.employment.feeEarner.chargeableHoursTarget} hrs/yr`
                    : '—'}
                </KeyValue>
                <KeyValue label="Billing / write-off approval limit">
                  {person.employment.feeEarner.billingApprovalLimitGbp
                    ? formatGbp(person.employment.feeEarner.billingApprovalLimitGbp)
                    : '—'}
                </KeyValue>
                <KeyValue label="SRA number">
                  {person.employment.feeEarner.sraNumber || '—'}
                </KeyValue>
                <KeyValue label="Practising certificate">
                  {person.employment.feeEarner.practisingCertificateStatus || '—'}{' '}
                  {person.employment.feeEarner.practisingCertificateRenewalDate
                    ? `(renews ${formatDate(person.employment.feeEarner.practisingCertificateRenewalDate)})`
                    : ''}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.rightToWork ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Right to Work &amp; Vetting (HR)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Right to work check">
                  {formatDate(person.employment.rightToWork.checkDate)} ·{' '}
                  {person.employment.rightToWork.method || '—'}
                </KeyValue>
                <KeyValue label="Document type">
                  {person.employment.rightToWork.documentType || '—'}
                </KeyValue>
                <KeyValue label="DBS check">
                  {person.employment.rightToWork.dbsCheckType || '—'} (
                  {person.employment.rightToWork.dbsOutcome || '—'})
                </KeyValue>
                <KeyValue label="References received">
                  {person.employment.rightToWork.referencesReceived === true
                    ? `Yes (${formatDate(person.employment.rightToWork.referencesReceivedDate)})`
                    : person.employment.rightToWork.referencesReceived === false
                      ? 'No'
                      : '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.payroll ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Payroll &amp; Benefits (Masked)</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="External payroll reference">
                  {person.employment.payroll.externalPayrollReference || '—'}
                </KeyValue>
                <KeyValue label="National Insurance number">
                  {maskNationalInsuranceNumber(
                    person.employment.payroll.nationalInsuranceNumber || '',
                  ) || '—'}
                </KeyValue>
                <KeyValue label="Bank details">
                  {maskBankDetails(
                    person.employment.payroll.bankSortCode || '',
                    person.employment.payroll.bankAccountNumber || '',
                  ).accountNumber || '—'}
                </KeyValue>
                <KeyValue label="Pension auto-enrolment">
                  {person.employment.payroll.pensionAutoEnrolmentStatus || '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}

          {person.employment.systems ? (
            <div className="subcard">
              <div className="list-section__header">
                <span className="section-label">Systems &amp; Access</span>
              </div>
              <div className="kv-grid" style={{ marginTop: 10 }}>
                <KeyValue label="Network login">
                  {person.employment.systems.networkLogin || '—'}
                </KeyValue>
                <KeyValue label="Building pass">
                  {person.employment.systems.buildingPassNumber || '—'}
                </KeyValue>
                <KeyValue label="Firm extension">
                  {person.employment.systems.extension || '—'}
                </KeyValue>
                <KeyValue label="Mandatory training (DP / AML / InfoSec)">
                  {[
                    person.employment.systems.dataProtectionTrainingCompletedAt
                      ? `DP: ${formatDate(person.employment.systems.dataProtectionTrainingCompletedAt)}`
                      : null,
                    person.employment.systems.amlTrainingCompletedAt
                      ? `AML: ${formatDate(person.employment.systems.amlTrainingCompletedAt)}`
                      : null,
                    person.employment.systems.infoSecTrainingCompletedAt
                      ? `InfoSec: ${formatDate(person.employment.systems.infoSecTrainingCompletedAt)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </KeyValue>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {tab === 'compliance' && (
        <div className="kv-grid">
          <KeyValue label="Contact record status">
            {resolveLabel(values, person.recordStatusId)}
          </KeyValue>
          <KeyValue label="Duplicate status">
            {resolveLabel(values, person.duplicateStatusId)}
          </KeyValue>
          <KeyValue label="Client ID verification status">
            {resolveLabel(values, person.verificationStatusId)}
          </KeyValue>
          <KeyValue label="Verification date">{formatDate(person.verifiedAt)}</KeyValue>
          <KeyValue label="Verification method">
            {resolveLabel(values, person.verificationMethodId)}
          </KeyValue>
          <KeyValue label="Verification reviewer">
            {person.verificationReviewerId ? (
              <Link href={`/people/${person.verificationReviewerId}`}>
                {nameById[person.verificationReviewerId] ?? person.verificationReviewerId}
              </Link>
            ) : null}
          </KeyValue>
          <KeyValue label="Risk assessment / due diligence references" full>
            {person.riskReferences}
          </KeyValue>
          <KeyValue label="Data source">{resolveLabel(values, person.sourceId)}</KeyValue>
          <KeyValue label="Last verified date">{formatDate(person.lastVerifiedAt)}</KeyValue>
        </div>
      )}

      {tab === 'documents' && (
        <DocumentListSection
          entityType="person"
          entityId={person.id}
          person={person}
          matters={matters}
          people={allPeople}
          organisations={organisations}
          values={values}
          currentUserId={currentUserId}
        />
      )}

      {tab === 'activity' && (
        <NotesSection
          recordType="person"
          recordId={person.id}
          notes={notes}
          nameById={nameById}
        />
      )}

      {tab === 'record' && (
        <AuditAndMergeSection
          record={person}
          values={values}
          nameById={nameById}
          audit={audit}
          merges={merges}
        />
      )}

      <NoteModal
        recordType="person"
        recordId={person.id}
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
      />

      <LinkModal
        mode="from-person"
        fixedPerson={person}
        people={allPeople}
        organisations={organisations}
        values={values}
        existing={editingLink}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </div>
  );
}
