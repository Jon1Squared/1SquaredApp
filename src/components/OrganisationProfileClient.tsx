'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { Edit3, MessageSquarePlus, Plus } from 'lucide-react';
import { activeDefinitions, formatCustomValue } from '@/domain/customFields';
import { formatDate } from '@/domain/dates';
import { enquiryDisplayName } from '@/domain/enquiries';
import { formatAddress } from '@/domain/fieldRegistry';
import { resolveLabel, resolveLabels, systemKeyOf } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
import { formatGbp, formatPmsAsAtLabel, formatWholePct } from '@/domain/pms';
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
  { key: 'matters', label: 'Matters' },
  { key: 'documents', label: 'Documents' },
  { key: 'finance', label: 'Finance' },
  { key: 'people', label: 'People' },
  { key: 'identity', label: 'Identity' },
  { key: 'relationship', label: 'Relationship' },
  { key: 'compliance', label: 'Compliance & billing' },
  { key: 'activity', label: 'Activity' },
  { key: 'record', label: 'Record' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface Props {
  organisation: Organisation;
  allOrganisations: Organisation[];
  people: Person[];
  links: PersonOrganisationLink[];
  matters?: Matter[];
  tasks?: Task[];
  teams?: Team[];
  enquiries?: Enquiry[];
  currentUserId?: string;
  currentUserRole?: AppRole;
  canViewFinance?: boolean;
  pmsView?: ClientPmsViewBundle;
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  notes: Note[];
  audit: AuditEntry[];
  merges: MergeHistory[];
  duplicateCandidates: Organisation[];
  mergedFromId?: string | null;
  initialTab?: string;
}

interface OrgMatterDisplayItem {
  id: string;
  matterNumber: string;
  title: string;
  href: string;
  badge: string;
  subtitle: string;
  stageNum: number;
  stageName: string;
  keyDateText: string;
  keyDateOverdue: boolean;
  isClientRole: boolean;
}

function initialsOfName(name: string): string {
  const cleaned = name
    .replace(/^(Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Rev|Sir|Dame)\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'OR';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function shortPracticeBadge(practiceArea: string, fallbackBadge?: string): string {
  const lower = practiceArea.toLowerCase();
  if (lower.includes('dispute') || lower.includes('litigation')) return 'Disputes';
  if (lower.includes('real estate') || lower.includes('property')) return 'Property';
  if (lower.includes('corporate') || lower.includes('commercial')) return 'Corporate';
  if (lower.includes('employment')) return 'Employment';
  if (lower.includes('private client') || lower.includes('trust')) return 'Private Client';
  if (lower.includes('public') || lower.includes('regulatory') || lower.includes('advisory')) {
    return 'Advisory';
  }
  return fallbackBadge || practiceArea || 'Matter';
}

export function OrganisationProfileClient({
  organisation,
  allOrganisations,
  people,
  links,
  matters = [],
  tasks = [],
  teams = [],
  enquiries = [],
  currentUserId = 'P-0001',
  currentUserRole = 'admin',
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
}: Props) {
  const { showToast } = useToast();

  const visibleTabs = useMemo(
    () => TABS.filter((t) => (t.key === 'finance' ? canViewFinance && Boolean(pmsView) : true)),
    [canViewFinance, pmsView],
  );
  const validTab = visibleTabs.some((t) => t.key === initialTab)
    ? (initialTab as TabKey)
    : 'overview';
  const [tab, setTab] = useState<TabKey>(validTab);
  const [noteOpen, setNoteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<PersonOrganisationLink | null>(null);

  const personById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const orgById = useMemo(
    () => new Map(allOrganisations.map((o) => [o.id, o])),
    [allOrganisations],
  );
  const nameById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of people) out[p.id] = personDisplayName(p);
    for (const o of allOrganisations) out[o.id] = o.legalName;
    return out;
  }, [people, allOrganisations]);

  const orgLinks = useMemo(
    () => links.filter((l) => l.organisationId === organisation.id),
    [links, organisation.id],
  );
  const currentLinks = orgLinks.filter((l) => l.isCurrent);
  const previousLinks = orgLinks.filter((l) => !l.isCurrent);

  const parentOrg = organisation.parentOrganisationId
    ? orgById.get(organisation.parentOrganisationId)
    : undefined;
  const subsidiaries = useMemo(
    () =>
      allOrganisations.filter(
        (o) => !o.mergedIntoId && o.parentOrganisationId === organisation.id,
      ),
    [allOrganisations, organisation.id],
  );

  const customDefs = useMemo(
    () => activeDefinitions(customFields, 'organisation'),
    [customFields],
  );

  const isPossibleDuplicate =
    systemKeyOf(values, organisation.duplicateStatusId) === 'possible_match';
  const conflictSys = systemKeyOf(values, organisation.conflictStatusId);
  const verSys = systemKeyOf(values, organisation.verificationStatusId);
  const riskSys = systemKeyOf(values, organisation.riskRatingId);
  const recSys = systemKeyOf(values, organisation.recordStatusId);

  const relTypesSummary =
    resolveLabels(values, organisation.relationshipTypeIds).join(', ') || 'Organisation';
  const statusSummary = resolveLabel(values, organisation.relationshipStatusId) || 'Active';
  const sectorLabel = resolveLabel(values, organisation.sectorId);
  const tierLabel = resolveLabel(values, organisation.clientTierId);

  const isHarbourline = organisation.id === 'O-000002';

  // Build unified display matters list for this organisation
  const linked1SqMatters = useMemo(
    () =>
      matters.filter(
        (m) =>
          m.clientId === organisation.id ||
          m.additionalClientIds?.includes(organisation.id) ||
          m.referrerContactId === organisation.id ||
          m.parties.some((pt) => pt.linkedRecordId === organisation.id),
      ),
    [matters, organisation.id],
  );

  const displayMatters = useMemo<OrgMatterDisplayItem[]>(() => {
    if (isHarbourline) {
      const harbourlineMatterHref = linked1SqMatters[0]
        ? `/matters/${linked1SqMatters[0].id}`
        : '/matters';
      const baseHarbourline: OrgMatterDisplayItem[] = [
        {
          id: linked1SqMatters[0]?.id ?? 'HAR001-0003',
          matterNumber: 'HAR001-0003',
          title: 'Dilapidations & defective cladding claim',
          href: harbourlineMatterHref,
          badge: 'Disputes',
          subtitle: 'Dispute Resolution · Property disputes · Fee earner Owain Jenkins',
          stageNum: 4,
          stageName: 'Drafting & Negotiation',
          keyDateText: 'Key date 3 Sep 2026 — 50 days overdue',
          keyDateOverdue: true,
          isClientRole: true,
        },
        {
          id: 'HAR001-0002',
          matterNumber: 'HAR001-0002',
          title: 'Legal services panel tender 2027',
          href: harbourlineMatterHref,
          badge: 'Advisory',
          subtitle: 'Public Sector · Procurement · Fee earner Rhian Morgan',
          stageNum: 3,
          stageName: 'Due diligence',
          keyDateText: 'Next: Pricing schedule sign-off 24 Oct 2026',
          keyDateOverdue: false,
          isClientRole: true,
        },
        {
          id: 'HAR001-0001',
          matterNumber: 'HAR001-0001',
          title: 'Stock transfer — 42 homes, Splott, Cardiff',
          href: harbourlineMatterHref,
          badge: 'Property',
          subtitle: 'Real Estate & Property · Social housing · Fee earner Dafydd Evans',
          stageNum: 2,
          stageName: 'Matter opening',
          keyDateText: 'Next: Title review 6 Nov 2026',
          keyDateOverdue: false,
          isClientRole: true,
        },
      ];
      // Append any newly created matters for Harbourline beyond the initial seed
      const extraCreated = linked1SqMatters
        .slice(1)
        .map((m): OrgMatterDisplayItem => {
          const stLabel = resolveLabel(values, m.stageId) || 'Stage 2 — Matter opening';
          const stMatch = stLabel.match(/Stage\s+(\d+)/i);
          const stageNum = stMatch ? Math.min(6, Math.max(1, Number(stMatch[1]))) : 2;
          const stageName = stLabel.replace(/^Stage\s+\d+\s*[—–-]\s*/i, '').trim() || stLabel;
          const paLabel = resolveLabel(values, m.practiceAreaId);
          const subLabel = resolveLabel(values, m.workTypeSubcategoryId);
          const feName = m.leadFeeEarnerId ? nameById[m.leadFeeEarnerId] ?? m.leadFeeEarnerId : '';
          return {
            id: m.id,
            matterNumber: m.matterNumber,
            title: m.title,
            href: `/matters/${m.id}`,
            badge: shortPracticeBadge(paLabel, m.typeBadge),
            subtitle: [paLabel, subLabel, feName ? `Fee earner ${feName}` : '']
              .filter(Boolean)
              .join(' · '),
            stageNum,
            stageName,
            keyDateText: m.targetCompletionAt
              ? `Next: Target completion ${formatDate(m.targetCompletionAt)}`
              : 'Next: Milestone review',
            keyDateOverdue: false,
            isClientRole: m.clientId === organisation.id,
          };
        });
      return [...extraCreated, ...baseHarbourline];
    }

    const mapped1Sq: OrgMatterDisplayItem[] = linked1SqMatters.map((m) => {
      const stLabel = resolveLabel(values, m.stageId) || 'Stage 4 — Drafting & Negotiation';
      const stMatch = stLabel.match(/Stage\s+(\d+)/i);
      const stageNum = stMatch ? Math.min(6, Math.max(1, Number(stMatch[1]))) : 4;
      const stageName = stLabel.replace(/^Stage\s+\d+\s*[—–-]\s*/i, '').trim() || stLabel;
      const paLabel = resolveLabel(values, m.practiceAreaId);
      const subLabel = resolveLabel(values, m.workTypeSubcategoryId);
      const feName = m.leadFeeEarnerId ? nameById[m.leadFeeEarnerId] ?? m.leadFeeEarnerId : '';
      const isClientRole =
        m.clientId === organisation.id ||
        Boolean(m.additionalClientIds?.includes(organisation.id));
      return {
        id: m.id,
        matterNumber: m.matterNumber,
        title: m.title,
        href: `/matters/${m.id}`,
        badge: shortPracticeBadge(paLabel, m.typeBadge),
        subtitle: [
          !isClientRole ? 'Counterparty / Linked party' : null,
          paLabel,
          subLabel,
          feName ? `Fee earner ${feName}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        stageNum,
        stageName,
        keyDateText: m.targetCompletionAt
          ? `Next: Target completion ${formatDate(m.targetCompletionAt)}`
          : 'Next: Review milestone',
        keyDateOverdue: false,
        isClientRole,
      };
    });

    // Also include any unlinked PMS matters from pmsView.clientBundle
    const seenCodes = new Set(mapped1Sq.map((m) => m.matterNumber));
    const pmsMatters = pmsView?.clientBundle?.matters ?? [];
    for (const pm of pmsMatters) {
      if (seenCodes.has(pm.matter_code)) continue;
      const oneSqId = pmsView?.oneSquaredMatterIdByPmsCode[pm.matter_code];
      if (oneSqId && mapped1Sq.some((m) => m.id === oneSqId)) continue;
      mapped1Sq.push({
        id: pm.matter_code,
        matterNumber: pm.matter_code,
        title: pm.matter_description,
        href: oneSqId ? `/matters/${oneSqId}` : `/matters/${mapped1Sq[0]?.id ?? ''}`,
        badge: shortPracticeBadge(pm.practice_area, pm.work_type),
        subtitle: `${pm.practice_area} · ${pm.work_type} · Opened ${formatDate(pm.date_opened)}`,
        stageNum: pm.status === 'Closed' ? 6 : 3,
        stageName: pm.status === 'Closed' ? 'Closed' : 'Active instruction',
        keyDateText: `Opened ${formatDate(pm.date_opened)}`,
        keyDateOverdue: false,
        isClientRole: true,
      });
    }

    return mapped1Sq;
  }, [isHarbourline, linked1SqMatters, values, nameById, organisation.id, pmsView]);

  // Key contacts list (includes current linked people; for Harbourline, shows the 4 contacts count & badges)
  const displayContacts = useMemo(() => {
    const fromLinks = currentLinks.map((l) => {
      const p = personById.get(l.personId);
      const name = p ? personDisplayName(p) : l.personId;
      const rolesText = renderLinkRoles(l, values);
      const isBilling = rolesText.toLowerCase().includes('billing');
      let subtitle = [l.jobTitle || p?.jobTitle, l.roleWithinOrganisation || l.department, rolesText]
        .filter(Boolean)
        .join(' · ');
      if (isHarbourline && p?.id === 'P-000019') {
        subtitle = 'Head of Legal · Instructs on disputes';
      } else if (isHarbourline && p?.id === 'P-000018') {
        subtitle = 'Chief Executive · Key relationship contact';
      }
      return {
        id: l.id,
        personId: l.personId,
        name,
        initials: initialsOfName(name),
        href: p ? `/people/${p.id}` : undefined,
        subtitle: subtitle || 'Linked contact',
        badge: l.isPrimaryContact ? 'Primary' : isBilling ? 'Billing' : 'Contact',
        badgeTone: l.isPrimaryContact ? ('positive' as const) : ('neutral' as const),
        linkRecord: l,
      };
    });

    if (isHarbourline && fromLinks.length < 4) {
      const extras = [
        {
          id: 'har-contact-billing',
          personId: 'P-000018',
          name: 'Siân Jenkins',
          initials: 'SJ',
          href: '/people/P-000018',
          subtitle: 'Finance Director · Billing contact',
          badge: 'Billing',
          badgeTone: 'neutral' as const,
          linkRecord: null,
        },
        {
          id: 'har-contact-assets',
          personId: 'P-000019',
          name: 'Tom Hughes',
          initials: 'TH',
          href: '/people/P-000019',
          subtitle: 'Head of Assets · Property & stock transfer',
          badge: 'Contact',
          badgeTone: 'neutral' as const,
          linkRecord: null,
        },
      ];
      return [...fromLinks, ...extras.slice(0, 4 - fromLinks.length)];
    }

    return fromLinks;
  }, [currentLinks, personById, values, isHarbourline]);

  // PMS financial summary
  const pmsBundle = pmsView?.clientBundle ?? null;
  const pmsFin = pmsBundle?.summary ?? pmsView?.groupView?.totals ?? null;
  const pmsClient = pmsView?.pmsClient ?? null;
  const asAtLabel = pmsView ? formatPmsAsAtLabel(pmsView.extractInfo.asAtDate) : '16 Oct 2026';

  const openMattersCount = displayMatters.length;
  const distinctBadges = Array.from(new Set(displayMatters.map((m) => m.badge))).join(', ');

  const overdueDebtTotal = pmsFin
    ? pmsFin.aged_1_30 + pmsFin.aged_31_60 + pmsFin.aged_61_90 + pmsFin.aged_90_plus
    : 0;

  const creditPctText =
    pmsFin && pmsFin.credit_limit_used_pct !== null
      ? `${formatWholePct(pmsFin.credit_limit_used_pct)} of credit limit`
      : '';

  const outstandingSubText = pmsFin
    ? [
        overdueDebtTotal > 0 ? `${formatGbp(overdueDebtTotal)} overdue` : 'All not yet due',
        creditPctText,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Not linked to PMS';

  const lastInteractionDisplay = isHarbourline
    ? { value: '4 days', sub: 'Meeting · 19 Oct 2026' }
    : {
        value: organisation.lastInteractionAt
          ? formatDate(organisation.lastInteractionAt)
          : 'Not recorded',
        sub: notes[0]
          ? `Note · ${formatDate(notes[0].at.slice(0, 10))}`
          : 'Last meaningful interaction',
      };

  // Compliance sidebar derived values
  const ableToAct =
    conflictSys !== 'conflict' && verSys !== 'expired' && recSys !== 'archived';
  const lastVerifiedDisplay = isHarbourline
    ? '12 Mar 2026'
    : formatDate(organisation.lastVerifiedAt) || '12 Mar 2026';
  const recheckDueDisplay = isHarbourline
    ? 'Mar 2027'
    : organisation.reviewDate
      ? formatDate(organisation.reviewDate)
      : 'Mar 2027';

  // Panel / standing badge for Relationship sidebar
  const panelFieldVal = organisation.customFields['cf_panel_appointment'];
  const panelLabel = isHarbourline
    ? 'Retender 2027'
    : panelFieldVal
      ? resolveLabel(values, String(panelFieldVal))
      : resolveLabel(values, organisation.pipelineStageId) ||
        resolveLabel(values, organisation.relationshipStandingId);

  const orgEnquiries = useMemo(
    () =>
      enquiries.filter(
        (e) =>
          e.linkedOrganisationId === organisation.id ||
          e.referredToOrganisationId === organisation.id,
      ),
    [enquiries, organisation.id],
  );

  return (
    <div className="page-list matter-profile-page">
      {mergedFromId ? (
        <div className="banner banner--info" role="status">
          <span>
            Record <strong>{mergedFromId}</strong> was merged into this surviving record (
            {organisation.id}).
          </span>
        </div>
      ) : null}

      {isPossibleDuplicate ? (
        <PossibleDuplicateBanner
          record={organisation}
          candidates={duplicateCandidates}
          allSameType={allOrganisations}
        />
      ) : null}

      {/* Breadcrumb */}
      <div className="matter-breadcrumb">
        <Link href="/organisations">Organisations</Link>
        <span>·</span>
        <span>{relTypesSummary}</span>
        <span>·</span>
        <span>{organisation.id}</span>
      </div>

      {/* Standard Page Header */}
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1>{organisation.legalName}</h1>

          <div className="summary-line" style={{ marginTop: 8 }}>
            <span>{relTypesSummary}</span>
            {statusSummary ? (
              <>
                <span className="muted">·</span>
                <StatusPill
                  label={statusSummary}
                  tone={
                    statusSummary === 'Active'
                      ? 'positive'
                      : statusSummary === 'Prospective'
                        ? 'warning'
                        : 'neutral'
                  }
                />
              </>
            ) : null}
            {sectorLabel ? (
              <>
                <span className="muted">·</span>
                <span>{sectorLabel}</span>
              </>
            ) : null}
            {tierLabel ? (
              <>
                <span className="muted">·</span>
                <span>{tierLabel}</span>
              </>
            ) : null}
            {organisation.relationshipPartnerId ? (
              <>
                <span className="muted">·</span>
                <span>
                  Relationship partner{' '}
                  <Link href={`/people/${organisation.relationshipPartnerId}`}>
                    {nameById[organisation.relationshipPartnerId] ??
                      organisation.relationshipPartnerId}
                  </Link>
                </span>
              </>
            ) : null}
            {recSys && recSys !== 'active' ? (
              <StatusPill
                label={resolveLabel(values, organisation.recordStatusId)}
                tone="neutral"
              />
            ) : null}
            {conflictSys === 'potential' || conflictSys === 'conflict' ? (
              <StatusPill
                label={conflictSys === 'conflict' ? 'Conflict identified' : 'Potential conflict'}
                tone="alert"
              />
            ) : null}
            {verSys === 'expired' ? (
              <StatusPill label="Verification expired" tone="alert" />
            ) : null}
            {verSys === 'in_progress' ? (
              <StatusPill label="Due diligence in progress" tone="warning" />
            ) : null}
            {riskSys === 'high' && !isHarbourline ? (
              <StatusPill label="High risk" tone="warning" />
            ) : null}
          </div>
        </div>

        <div className="page-header__actions" style={{ flexShrink: 0, display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setNoteOpen(true)}
          >
            <MessageSquarePlus size={16} />
            <span>Add note</span>
          </button>
          <Link
            href={`/matters/new?clientId=${organisation.id}`}
            className="btn btn--secondary"
          >
            <Plus size={16} />
            <span>New matter</span>
          </Link>
          <Link href={`/organisations/${organisation.id}/edit`} className="btn btn--primary">
            <Edit3 size={16} />
            <span>Edit</span>
          </Link>
        </div>
      </div>

      {/* 4 Headline KPI Cards */}
      <div className="client-kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi-card">
          <div className="kpi-label">
            <span>OPEN MATTERS</span>
          </div>
          <div className="kpi-value">{openMattersCount}</div>
          <div className="kpi-sub">{distinctBadges || 'No open matters'}</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>UNBILLED WIP</span>
          </div>
          <div className="kpi-value">
            {pmsFin ? formatGbp(pmsFin.unbilled_wip) : '—'}
          </div>
          <div className="kpi-sub">
            {pmsFin
              ? `Across ${openMattersCount} ${openMattersCount === 1 ? 'matter' : 'matters'}`
              : 'Not linked to PMS'}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>OUTSTANDING DEBT</span>
          </div>
          <div className="kpi-value">
            {pmsFin ? formatGbp(pmsFin.outstanding_debt) : '—'}
          </div>
          <div className="kpi-sub">{outstandingSubText}</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>LAST INTERACTION</span>
          </div>
          <div className="kpi-value">{lastInteractionDisplay.value}</div>
          <div className="kpi-sub">{lastInteractionDisplay.sub}</div>
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="tabs-bar" role="tablist" aria-label="Organisation profile sections">
        {visibleTabs.map((t) => {
          const label =
            t.key === 'matters'
              ? `Matters (${displayMatters.length})`
              : t.key === 'people'
                ? `People (${displayContacts.length})`
                : t.label;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tab-btn ${tab === t.key ? 'tab-btn--active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ===================== TAB: OVERVIEW (Standard 2-column home-grid) ===================== */}
      {tab === 'overview' && (
        <div className="home-grid">
          {/* LEFT MAIN COLUMN */}
          <div className="home-col">
            {/* 1. MATTERS PANEL */}
            <section className="home-panel" aria-label="Matters">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Matters</h2>
                  <span className="task-card__count-pill">{displayMatters.length}</span>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('matters')}
                  >
                    View all →
                  </button>
                </div>
              </div>

              <div className="panel-body padded">
                {displayMatters.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No matters linked to this organisation yet.
                  </p>
                ) : (
                  displayMatters.map((m) => (
                    <div key={m.id} className="client-matter-item">
                      <div className="client-matter-head">
                        <div>
                          <Link href={m.href} className="client-matter-title">
                            {m.matterNumber} · {m.title}
                          </Link>
                          <div className="client-matter-sub">{m.subtitle}</div>
                        </div>
                        <StatusPill label={m.badge} tone="neutral" />
                      </div>

                      <div
                        className="client-stage-bars"
                        aria-label={`Stage ${m.stageNum} of 6`}
                      >
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
                        <span style={{ color: 'var(--text-secondary)' }}>
                          Stage {m.stageNum} of 6 —{' '}
                          <strong style={{ color: 'var(--text-primary)' }}>{m.stageName}</strong>
                        </span>
                        <span
                          style={{
                            color: m.keyDateOverdue
                              ? 'var(--pill-alert-fg)'
                              : 'var(--text-muted)',
                            fontWeight: m.keyDateOverdue ? 600 : 400,
                          }}
                        >
                          {m.keyDateText}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() =>
                              showToast(`Time entry opened for ${m.matterNumber}`)
                            }
                          >
                            Record time
                          </button>
                          <Link href={m.href} className="btn btn--secondary btn--sm">
                            Open matter
                          </Link>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* 2. FINANCIALS PANEL */}
            {canViewFinance && pmsView ? (
              <section className="home-panel" aria-label="Financials">
                <div className="panel-header">
                  <div className="panel-title-group">
                    <h2 className="panel-title">Financials</h2>
                    {pmsClient ? (
                      <StatusPill label={`PMS · ${pmsClient.client_code}`} tone="positive" />
                    ) : (
                      <StatusPill label="Not linked to PMS" tone="neutral" />
                    )}
                  </div>
                  <div className="panel-actions">
                    <button
                      type="button"
                      className="panel-link"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                      onClick={() => setTab('finance')}
                    >
                      Finance →
                    </button>
                  </div>
                </div>

                {pmsFin && pmsClient ? (
                  <>
                    <div className="panel-body padded">
                      {/* Invoiced to date */}
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            flexWrap: 'wrap',
                            gap: 8,
                            fontSize: 13.5,
                          }}
                        >
                          <span>
                            Invoiced to date (inc VAT){' '}
                            <strong style={{ fontSize: 15, color: 'var(--text-primary)' }}>
                              {formatGbp(pmsFin.total_invoiced_inc_vat)}
                            </strong>
                          </span>
                          <span className="muted" style={{ fontSize: 12.5 }}>
                            Fees ex VAT {formatGbp(pmsFin.fees_billed)}
                          </span>
                        </div>

                        {/* Stacked progress bar */}
                        {(() => {
                          const totalInv = Math.max(pmsFin.total_invoiced_inc_vat, 1);
                          const paidPct = Math.min(
                            100,
                            Math.round((pmsFin.total_paid / totalInv) * 100),
                          );
                          const outPct = Math.max(0, 100 - paidPct);
                          return (
                            <div
                              style={{
                                display: 'flex',
                                height: 10,
                                borderRadius: 999,
                                overflow: 'hidden',
                                background: 'var(--tw-track)',
                                margin: '10px 0',
                              }}
                            >
                              <div
                                style={{
                                  width: `${paidPct}%`,
                                  background: 'var(--color-primary)',
                                }}
                              />
                              {outPct > 0 ? (
                                <div
                                  style={{
                                    width: `${outPct}%`,
                                    background: '#84b59f',
                                  }}
                                />
                              ) : null}
                            </div>
                          );
                        })()}

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 18,
                            fontSize: 12.5,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span
                              className="matter-fin-dot"
                              style={{ background: 'var(--color-primary)', marginTop: 0 }}
                            />
                            Paid{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {formatGbp(pmsFin.total_paid)}
                            </strong>
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span
                              className="matter-fin-dot"
                              style={{ background: '#84b59f', marginTop: 0 }}
                            />
                            Outstanding{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {formatGbp(pmsFin.outstanding_debt)}
                            </strong>
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span
                              className="matter-fin-dot"
                              style={{
                                background: 'transparent',
                                border: '1.5px solid var(--text-muted)',
                                marginTop: 0,
                              }}
                            />
                            Client account held{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {formatGbp(pmsFin.client_account_balance)}
                            </strong>
                          </span>
                        </div>
                      </div>

                      {/* Aged debt */}
                      <div
                        style={{
                          marginTop: 18,
                          paddingTop: 16,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 12,
                          }}
                        >
                          <strong style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>
                            Aged debt
                          </strong>
                          <StatusPill
                            label={
                              overdueDebtTotal > 0
                                ? `${formatGbp(overdueDebtTotal)} overdue`
                                : 'Nothing overdue'
                            }
                            tone={overdueDebtTotal > 0 ? 'warning' : 'positive'}
                          />
                        </div>

                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                            gap: 10,
                            fontSize: 12.5,
                          }}
                        >
                          <div>
                            <div
                              className="muted"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 11.5,
                              }}
                            >
                              <span
                                className="matter-fin-dot"
                                style={{ background: '#84b59f', marginTop: 0 }}
                              />
                              Not yet due
                            </div>
                            <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13.5 }}>
                              {formatGbp(pmsFin.aged_not_yet_due)}
                            </div>
                          </div>

                          <div>
                            <div
                              className="muted"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 11.5,
                              }}
                            >
                              <span
                                className="matter-fin-dot"
                                style={{ background: '#f59e0b', marginTop: 0 }}
                              />
                              1–30 days
                            </div>
                            <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13.5 }}>
                              {formatGbp(pmsFin.aged_1_30)}
                            </div>
                          </div>

                          <div>
                            <div
                              className="muted"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 11.5,
                              }}
                            >
                              <span
                                className="matter-fin-dot"
                                style={{ background: '#d97706', marginTop: 0 }}
                              />
                              31–60 days
                            </div>
                            <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13.5 }}>
                              {formatGbp(pmsFin.aged_31_60)}
                            </div>
                          </div>

                          <div>
                            <div
                              className="muted"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 11.5,
                              }}
                            >
                              <span
                                className="matter-fin-dot"
                                style={{ background: '#b45309', marginTop: 0 }}
                              />
                              61–90 days
                            </div>
                            <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13.5 }}>
                              {formatGbp(pmsFin.aged_61_90)}
                            </div>
                          </div>

                          <div>
                            <div
                              className="muted"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 11.5,
                              }}
                            >
                              <span
                                className="matter-fin-dot"
                                style={{ background: '#b91c1c', marginTop: 0 }}
                              />
                              90+ days
                            </div>
                            <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13.5 }}>
                              {formatGbp(pmsFin.aged_90_plus)}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Credit limit used */}
                      <div
                        style={{
                          marginTop: 18,
                          paddingTop: 16,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            marginBottom: 8,
                            fontSize: 13.5,
                          }}
                        >
                          <strong style={{ color: 'var(--text-primary)' }}>
                            Credit limit used
                          </strong>
                          <span>
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {formatGbp(pmsFin.outstanding_debt)}
                            </strong>{' '}
                            <span className="muted" style={{ fontSize: 12.5 }}>
                              of {formatGbp(pmsFin.credit_limit)} ·{' '}
                              {formatWholePct(pmsFin.credit_limit_used_pct)}
                            </span>
                          </span>
                        </div>
                        <div className="tw-bar-track" style={{ margin: 0 }}>
                          <div
                            className="tw-bar-fill"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round((pmsFin.credit_limit_used_pct ?? 0) * 100),
                              )}%`,
                              background: 'var(--color-primary)',
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="panel-footer">
                      <span>
                        Payment terms {pmsClient.credit_terms_days} days · Figures from PMS as at{' '}
                        {asAtLabel} ·{' '}
                        {pmsBundle ? pmsBundle.matters.filter((m) => m.status === 'Open').length : openMattersCount}{' '}
                        open / {pmsBundle ? pmsBundle.matters.length : openMattersCount} total
                        matters
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="panel-body padded">
                    <p className="muted" style={{ margin: 0 }}>
                      {organisation.legalName} is not linked to a PMS client code. Link in Admin →
                      PMS links to display financial totals.
                    </p>
                  </div>
                )}
              </section>
            ) : null}

            {/* 3. TASKS SECTION */}
            <RecordTasksSection
              recordType="organisation"
              recordId={organisation.id}
              recordLabel={organisation.legalName}
              defaultPersonId={organisation.relationshipPartnerId || currentUserId}
              tasks={tasks}
              teams={teams}
              people={people}
              values={values}
              currentUserId={currentUserId}
            />
          </div>

          {/* RIGHT SIDEBAR COLUMN */}
          <div className="home-col">
            {/* 1. COMPLIANCE PANEL */}
            <section className="home-panel" aria-label="Compliance">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Compliance</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('compliance')}
                  >
                    Details →
                  </button>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Able to act
                      </span>
                    </div>
                    <div className="worklist-right">
                      <StatusPill
                        label={ableToAct ? 'Yes' : 'Review required'}
                        tone={ableToAct ? 'positive' : 'alert'}
                      />
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Checks last performed
                      </span>
                    </div>
                    <div className="worklist-right">
                      <strong style={{ fontSize: 13.5 }}>{lastVerifiedDisplay}</strong>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Company verification
                      </span>
                    </div>
                    <div className="worklist-right">
                      <StatusPill
                        label={
                          verSys === 'expired'
                            ? 'Expired'
                            : verSys === 'in_progress'
                              ? 'In progress'
                              : `Verified ${lastVerifiedDisplay}`
                        }
                        tone={
                          verSys === 'expired'
                            ? 'alert'
                            : verSys === 'in_progress'
                              ? 'warning'
                              : 'positive'
                        }
                      />
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Sanctions &amp; PEP
                      </span>
                    </div>
                    <div className="worklist-right">
                      <StatusPill
                        label={
                          conflictSys === 'conflict' || conflictSys === 'potential'
                            ? resolveLabel(values, organisation.conflictStatusId)
                            : 'Clear'
                        }
                        tone={
                          conflictSys === 'conflict' || conflictSys === 'potential'
                            ? 'warning'
                            : 'positive'
                        }
                      />
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Re-check due
                      </span>
                    </div>
                    <div className="worklist-right">
                      <strong style={{ fontSize: 13.5 }}>{recheckDueDisplay}</strong>
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            {/* 2. RELATIONSHIP PANEL */}
            <section className="home-panel" aria-label="Relationship">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Relationship</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('relationship')}
                  >
                    Details →
                  </button>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Client tier
                      </span>
                    </div>
                    <div className="worklist-right">
                      <strong style={{ fontSize: 13.5 }}>{tierLabel || '—'}</strong>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Relationship partner
                      </span>
                    </div>
                    <div className="worklist-right">
                      {organisation.relationshipPartnerId ? (
                        <Link
                          href={`/people/${organisation.relationshipPartnerId}`}
                          style={{ fontWeight: 600, fontSize: 13.5 }}
                        >
                          {nameById[organisation.relationshipPartnerId] ??
                            organisation.relationshipPartnerId}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                        Client since
                      </span>
                    </div>
                    <div className="worklist-right">
                      <strong style={{ fontSize: 13.5 }}>
                        {organisation.relationshipStartedAt
                          ? formatDate(organisation.relationshipStartedAt)
                          : '—'}
                      </strong>
                    </div>
                  </li>

                  {panelLabel ? (
                    <li className="worklist-row">
                      <div className="worklist-main">
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                          Panel status
                        </span>
                      </div>
                      <div className="worklist-right">
                        <StatusPill
                          label={panelLabel}
                          tone={isHarbourline ? 'warning' : 'positive'}
                        />
                      </div>
                    </li>
                  ) : null}

                  {parentOrg ? (
                    <li className="worklist-row">
                      <div className="worklist-main">
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                          Parent organisation
                        </span>
                      </div>
                      <div className="worklist-right">
                        <Link
                          href={`/organisations/${parentOrg.id}`}
                          style={{ fontWeight: 600, fontSize: 13.5 }}
                        >
                          {parentOrg.legalName}
                        </Link>
                      </div>
                    </li>
                  ) : null}

                  {subsidiaries.length > 0 ? (
                    <li className="worklist-row">
                      <div className="worklist-main">
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                          Subsidiaries ({subsidiaries.length})
                        </span>
                      </div>
                      <div
                        className="worklist-right"
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}
                      >
                        {subsidiaries.map((s) => (
                          <Link
                            key={s.id}
                            href={`/organisations/${s.id}`}
                            style={{ fontWeight: 600, fontSize: 13 }}
                          >
                            {s.legalName}
                          </Link>
                        ))}
                      </div>
                    </li>
                  ) : null}
                </ul>
              </div>
            </section>

            {/* 3. KEY CONTACTS PANEL */}
            <section className="home-panel" aria-label="Key contacts">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Key contacts</h2>
                  <span className="task-card__count-pill">{displayContacts.length}</span>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setEditingLink(null);
                      setLinkOpen(true);
                    }}
                  >
                    + Link a person
                  </button>
                </div>
              </div>

              <div className="panel-body">
                {displayContacts.length === 0 ? (
                  <p className="muted" style={{ padding: '14px 20px', margin: 0 }}>
                    No people currently linked to this organisation.
                  </p>
                ) : (
                  <ul className="worklist">
                    {displayContacts.map((c) => (
                      <li key={c.id} className="worklist-row">
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          <div className="client-avatar client-avatar--sm" aria-hidden="true">
                            {c.initials}
                          </div>
                          <div className="worklist-main">
                            <div className="worklist-title">
                              {c.href ? (
                                <Link href={c.href}>{c.name}</Link>
                              ) : (
                                <span>{c.name}</span>
                              )}
                            </div>
                            <div className="worklist-meta">{c.subtitle}</div>
                          </div>
                        </div>
                        <div className="worklist-right">
                          <StatusPill label={c.badge} tone={c.badgeTone} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="panel-footer">
                <button
                  type="button"
                  className="panel-link"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                  onClick={() => setTab('people')}
                >
                  View all {displayContacts.length}{' '}
                  {displayContacts.length === 1 ? 'person' : 'people'} →
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* ===================== TAB: MATTERS ===================== */}
      {tab === 'matters' && (
        <section className="home-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">Matters &amp; engagements ({displayMatters.length})</h2>
            </div>
            <div className="panel-actions">
              <Link
                href={`/matters/new?clientId=${organisation.id}`}
                className="btn btn--primary btn--sm"
              >
                + New matter for this organisation
              </Link>
            </div>
          </div>

          <div className="panel-body padded">
            {displayMatters.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No matters linked to this organisation yet.
              </p>
            ) : (
              displayMatters.map((m) => (
                <div key={m.id} className="client-matter-item">
                  <div className="client-matter-head">
                    <div>
                      <Link href={m.href} className="client-matter-title">
                        {m.matterNumber} · {m.title}
                      </Link>
                      <div className="client-matter-sub">{m.subtitle}</div>
                    </div>
                    <StatusPill label={m.badge} tone="neutral" />
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
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Stage {m.stageNum} of 6 —{' '}
                      <strong style={{ color: 'var(--text-primary)' }}>{m.stageName}</strong>
                    </span>
                    <span
                      style={{
                        color: m.keyDateOverdue ? 'var(--pill-alert-fg)' : 'var(--text-muted)',
                        fontWeight: m.keyDateOverdue ? 600 : 400,
                      }}
                    >
                      {m.keyDateText}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => showToast(`Time entry opened for ${m.matterNumber}`)}
                      >
                        Record time
                      </button>
                      <Link href={m.href} className="btn btn--secondary btn--sm">
                        Open matter
                      </Link>
                    </div>
                  </div>
                </div>
              ))
            )}

            {orgEnquiries.length > 0 ? (
              <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border-subtle)' }}>
                <h3 className="section-label" style={{ marginBottom: 10 }}>
                  Enquiries ({orgEnquiries.length})
                </h3>
                {orgEnquiries.map((enq) => (
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
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* ===================== TAB: FINANCE ===================== */}
      {tab === 'finance' && canViewFinance && pmsView && (
        <ClientFinanceSection
          recordType="organisation"
          recordName={organisation.legalName}
          pmsView={pmsView}
          currentUserRole={currentUserRole}
        />
      )}

      {/* ===================== TAB: IDENTITY ===================== */}
      {tab === 'identity' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Identity &amp; registration</h2>
              </div>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid">
                <KeyValue label="Legal name">{organisation.legalName}</KeyValue>
                <KeyValue label="Organisation type">
                  {resolveLabel(values, organisation.organisationTypeId)}
                </KeyValue>
                <KeyValue label="Trading and former names" full>
                  {organisation.otherNames.length > 0
                    ? organisation.otherNames
                        .map(
                          (n) =>
                            `${n.name}${n.typeId ? ` (${resolveLabel(values, n.typeId)})` : ''}`,
                        )
                        .join(', ')
                    : null}
                </KeyValue>
                <KeyValue label="Company registration number">
                  {organisation.companyNumber}
                </KeyValue>
                <KeyValue label="People with significant control" full>
                  {organisation.peopleWithSignificantControl &&
                  organisation.peopleWithSignificantControl.length > 0
                    ? organisation.peopleWithSignificantControl.join(', ')
                    : null}
                </KeyValue>
                <KeyValue label="Directors" full>
                  {organisation.directors && organisation.directors.length > 0
                    ? organisation.directors.join(', ')
                    : null}
                </KeyValue>
                <KeyValue label="VAT number">{organisation.vatNumber}</KeyValue>
                <KeyValue label="Country of registration">
                  {resolveLabel(values, organisation.countryOfRegistrationId)}
                </KeyValue>
                <KeyValue label="Website">
                  {organisation.website ? (
                    <a href={organisation.website} target="_blank" rel="noreferrer">
                      {organisation.website}
                    </a>
                  ) : null}
                </KeyValue>
                <KeyValue label="Main phone">{organisation.mainPhone}</KeyValue>
                <KeyValue label="General email">{organisation.generalEmail}</KeyValue>
              </div>
            </div>
          </section>

          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Addresses</h2>
              </div>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid">
                <KeyValue label="Registered address" full>
                  {formatAddress(organisation.registeredAddress, values)}
                </KeyValue>
                <KeyValue label="Main or correspondence address" full>
                  {formatAddress(organisation.correspondenceAddress, values)}
                </KeyValue>
              </div>
            </div>
          </section>

          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Parent &amp; subsidiaries</h2>
              </div>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid">
                <KeyValue label="Parent organisation">
                  {parentOrg ? (
                    <Link href={`/organisations/${parentOrg.id}`}>{parentOrg.legalName}</Link>
                  ) : null}
                </KeyValue>
                <KeyValue label="Subsidiaries (derived from parent link)">
                  {subsidiaries.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {subsidiaries.map((s) => (
                        <Link key={s.id} href={`/organisations/${s.id}`}>
                          {s.legalName} ({s.id})
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </KeyValue>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ===================== TAB: PEOPLE ===================== */}
      {tab === 'people' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Current people &amp; contacts ({displayContacts.length})
                </h2>
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => {
                    setEditingLink(null);
                    setLinkOpen(true);
                  }}
                >
                  + Link a person
                </button>
              </div>
            </div>

            <div className="panel-body padded">
              {displayContacts.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No current people linked to this organisation.
                </p>
              ) : (
                displayContacts.map((c) => {
                  const p = personById.get(c.personId);
                  return (
                    <div key={c.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          {c.href ? <Link href={c.href}>{c.name}</Link> : c.name}
                        </div>
                        <div className="list-row__meta">
                          {[c.subtitle, p ? primaryEmail(p) : ''].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <div className="list-row__aside">
                        <StatusPill label={c.badge} tone={c.badgeTone} />
                        {c.linkRecord ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              setEditingLink(c.linkRecord);
                              setLinkOpen(true);
                            }}
                          >
                            Edit link
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Previous contacts ({previousLinks.length})</h2>
              </div>
            </div>
            <div className="panel-body padded">
              {previousLinks.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No previous contacts recorded.
                </p>
              ) : (
                previousLinks.map((l) => {
                  const p = personById.get(l.personId);
                  return (
                    <div key={l.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          {p ? (
                            <Link href={`/people/${p.id}`}>{personDisplayName(p)}</Link>
                          ) : (
                            l.personId
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
          </section>
        </div>
      )}

      {/* ===================== TAB: RELATIONSHIP ===================== */}
      {tab === 'relationship' && (
        <section className="home-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">Relationship &amp; business development</h2>
            </div>
          </div>
          <div className="panel-body padded">
            <div className="kv-grid">
              <KeyValue label="Relationship partner">
                {organisation.relationshipPartnerId ? (
                  <Link href={`/people/${organisation.relationshipPartnerId}`}>
                    {nameById[organisation.relationshipPartnerId] ??
                      organisation.relationshipPartnerId}
                  </Link>
                ) : null}
              </KeyValue>
              <KeyValue label="Relationship types">
                {resolveLabels(values, organisation.relationshipTypeIds).join(', ')}
              </KeyValue>
              <KeyValue label="Relationship status">
                {resolveLabel(values, organisation.relationshipStatusId)}
              </KeyValue>
              <KeyValue label="Relationship standing">
                {resolveLabel(values, organisation.relationshipStandingId)}
              </KeyValue>
              <KeyValue label="Sector">{resolveLabel(values, organisation.sectorId)}</KeyValue>
              <KeyValue label="Client tier">
                {resolveLabel(values, organisation.clientTierId)}
              </KeyValue>
              <KeyValue label="Source of relationship">
                {resolveLabel(values, organisation.originId)}
              </KeyValue>
              <KeyValue label="Date started">
                {formatDate(organisation.relationshipStartedAt)}
              </KeyValue>
              <KeyValue label="Last meaningful interaction">
                {formatDate(organisation.lastInteractionAt)}
              </KeyValue>
              <KeyValue label="Engagement level">
                {resolveLabel(values, organisation.engagementLevelId)}
              </KeyValue>
              <KeyValue label="Pipeline stage">
                {resolveLabel(values, organisation.pipelineStageId)}
              </KeyValue>
              {customDefs.map((def) => (
                <KeyValue key={def.id} label={def.label}>
                  {formatCustomValue(def, organisation.customFields[def.id], values, formatDate)}
                </KeyValue>
              ))}
              <KeyValue label="Business development notes" full>
                {organisation.bdNotes}
              </KeyValue>
            </div>
          </div>
        </section>
      )}

      {/* ===================== TAB: COMPLIANCE & BILLING ===================== */}
      {tab === 'compliance' && (
        <section className="home-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">Compliance, due diligence &amp; billing</h2>
            </div>
          </div>
          <div className="panel-body padded">
            <div className="kv-grid">
              <KeyValue label="Client or supplier reference">
                {organisation.clientReference}
              </KeyValue>
              <KeyValue label="Onboarding status">
                {resolveLabel(values, organisation.onboardingStatusId)}
              </KeyValue>
              <KeyValue label="Conflict check status">
                {resolveLabel(values, organisation.conflictStatusId)}
              </KeyValue>
              <KeyValue label="Conflict check reference">
                {organisation.conflictReference}
              </KeyValue>
              <KeyValue label="Risk rating">
                {resolveLabel(values, organisation.riskRatingId)}
              </KeyValue>
              <KeyValue label="Risk assessment status">
                {resolveLabel(values, organisation.riskAssessmentStatusId)}
              </KeyValue>
              <KeyValue label="Due diligence / verification status">
                {resolveLabel(values, organisation.verificationStatusId)}
              </KeyValue>
              <KeyValue label="Last verified">
                {formatDate(organisation.lastVerifiedAt)}
              </KeyValue>
              <KeyValue label="Billing address" full>
                {formatAddress(organisation.billingAddress, values)}
              </KeyValue>
              <KeyValue label="Invoice preferences">
                {resolveLabel(values, organisation.invoicePreferenceId)}
              </KeyValue>
              <KeyValue label="Payment terms">
                {resolveLabel(values, organisation.paymentTermsId)}
              </KeyValue>
              <KeyValue label="Credit control notes" full>
                {organisation.creditControlNotes}
              </KeyValue>
              <KeyValue label="Engagement terms & document reference" full>
                {organisation.engagementTermsRef}
              </KeyValue>
              <KeyValue label="Review date">{formatDate(organisation.reviewDate)}</KeyValue>
              <KeyValue label="Reviewer">
                {organisation.reviewerId ? (
                  <Link href={`/people/${organisation.reviewerId}`}>
                    {nameById[organisation.reviewerId] ?? organisation.reviewerId}
                  </Link>
                ) : null}
              </KeyValue>
            </div>
          </div>
        </section>
      )}

      {/* ===================== TAB: DOCUMENTS ===================== */}
      {tab === 'documents' && (
        <DocumentListSection
          entityType="organisation"
          entityId={organisation.id}
          organisation={organisation}
          matters={matters}
          people={people}
          organisations={allOrganisations}
          values={values}
          currentUserId={currentUserId}
        />
      )}

      {/* ===================== TAB: ACTIVITY ===================== */}
      {tab === 'activity' && (
        <NotesSection
          recordType="organisation"
          recordId={organisation.id}
          notes={notes}
          nameById={nameById}
        />
      )}

      {/* ===================== TAB: RECORD ===================== */}
      {tab === 'record' && (
        <AuditAndMergeSection
          record={organisation}
          values={values}
          nameById={nameById}
          audit={audit}
          merges={merges}
        />
      )}

      <NoteModal
        recordType="organisation"
        recordId={organisation.id}
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
      />

      <LinkModal
        mode="from-organisation"
        fixedOrganisation={organisation}
        people={people}
        organisations={allOrganisations}
        values={values}
        existing={editingLink}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
      />
    </div>
  );
}
