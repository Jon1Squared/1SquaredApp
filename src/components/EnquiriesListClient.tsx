'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar, MoreHorizontal } from 'lucide-react';
import {
  enquiryStatusTone,
  isExceptionalUrgencyLabel,
  quoteStatusTone,
  urgencyEdgeKind,
  urgencyTone,
} from '@/domain/badges';
import { formatDate, formatDateTime, formatKeyDateSummary } from '@/domain/dates';
import {
  enquiryDisplayName,
  filterEnquiriesForTab,
  urgencyRank,
  type EnquiriesQueueTab,
} from '@/domain/enquiries';
import { resolveLabel, valuesForList } from '@/domain/lists';
import { personDisplayName } from '@/domain/names';
import {
  evaluateQuoteEffectiveStatus,
  filterQuotesForTab,
  formatGbp,
  isQuoteExpired,
  isQuoteFollowUpDueThisWeek,
  isQuoteFollowUpDueToday,
  isQuoteFollowUpOverdue,
  QUOTE_FEE_BASES,
  quoteClientDisplayName,
  quoteWorkTypeSummary,
  sortIntakeQueue,
  type IntakeQueueRow,
} from '@/domain/quotes';
import { isTaskOpen, userTeams } from '@/domain/tasks';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
  Task,
  Team,
} from '@/domain/types';
import {
  DataList,
  DataListFilterBar,
  PersonChip,
  RelativeTime,
  useListDensity,
  type ActiveFilterChipItem,
  type DataListColumn,
  type DataListSortState,
} from './DataList';
import { StatusPill } from './SearchBox';

interface Props {
  enquiries: Enquiry[];
  quotes?: Quote[];
  tasks: Task[];
  teams: Team[];
  people: Person[];
  organisations?: Organisation[];
  matters?: Matter[];
  values: ChoiceValue[];
  currentUserId: string;
}

const STATUS_SORT_ORDER: Record<string, number> = {
  New: 1,
  'Follow-up due': 2,
  Assigned: 3,
  Sent: 4,
  'In contact': 5,
  Draft: 6,
  Accepted: 7,
  Converted: 8,
  Declined: 9,
  'Referred out': 10,
  'No response': 11,
  Expired: 12,
  Superseded: 13,
};

export function EnquiriesListClient({
  enquiries,
  quotes = [],
  tasks,
  teams,
  people,
  organisations = [],
  values,
  currentUserId,
}: Props) {
  const router = useRouter();
  const now = useMemo(() => new Date(), []);

  const myTeams = useMemo(() => userTeams(currentUserId, teams), [currentUserId, teams]);
  const myTeamIds = useMemo(() => new Set(myTeams.map((t) => t.id)), [myTeams]);

  const [tab, setTab] = useState<EnquiriesQueueTab>('team');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'enquiry' | 'quote'>('all');
  const [urgencyFilter, setUrgencyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [practiceAreaFilter, setPracticeAreaFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [feeBasisFilter, setFeeBasisFilter] = useState('all');
  const [feeEarnerFilter, setFeeEarnerFilter] = useState('all');
  const [validUntilFrom, setValidUntilFrom] = useState('');
  const [validUntilTo, setValidUntilTo] = useState('');
  const [followUpDueFilter, setFollowUpDueFilter] = useState<
    'all' | 'overdue' | 'today' | 'this_week'
  >('all');
  const [sort, setSort] = useState<DataListSortState | null>(null);
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

  // Per-row actions menu state
  const [openRowMenuId, setOpenRowMenuId] = useState<string | null>(null);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (openRowMenuId) {
        const el = (target as HTMLElement | null)?.closest?.('[data-row-menu]');
        if (!el) {
          setOpenRowMenuId(null);
        }
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [openRowMenuId]);

  const practiceAreas = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => !v.parentId && v.active),
    [values],
  );
  const urgencies = useMemo(
    () => valuesForList(values, 'enquiry_urgency').filter((v) => v.active),
    [values],
  );
  const channels = useMemo(
    () => valuesForList(values, 'enquiry_channel').filter((v) => v.active),
    [values],
  );
  const feeEarners = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId && !p.demo)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  // Map linked quotes per enquiry id
  const quotesByEnquiryId = useMemo(() => {
    const map = new Map<string, Quote[]>();
    for (const q of quotes) {
      if (!q.linkedEnquiryId) continue;
      const list = map.get(q.linkedEnquiryId) ?? [];
      list.push(q);
      map.set(q.linkedEnquiryId, list);
    }
    return map;
  }, [quotes]);

  const enquiryById = useMemo(() => {
    const map = new Map<string, Enquiry>();
    for (const e of enquiries) {
      map.set(e.id, e);
    }
    return map;
  }, [enquiries]);

  const nameOfPerson = (id: string | null | undefined) => {
    if (!id) return '';
    const p = people.find((x) => x.id === id);
    return p ? personDisplayName(p) : id;
  };

  const nextActionDetailsForEnquiry = (
    e: Enquiry,
  ): { primary: React.ReactNode; secondary?: React.ReactNode; fullTooltip: string } => {
    if (e.status === 'Draft') {
      return {
        primary: 'Complete draft & route',
        fullTooltip: 'Complete draft & route',
      };
    }
    const openTask = tasks.find(
      (t) =>
        isTaskOpen(t) &&
        t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === e.id),
    );
    if (openTask) {
      const dueStr = openTask.dueAt.includes('T')
        ? formatDateTime(openTask.dueAt)
        : formatDate(openTask.dueAt);
      const dueSecondary = `Due ${formatDate(openTask.dueAt)}`;
      return {
        primary: openTask.title,
        secondary: dueSecondary,
        fullTooltip: `${openTask.title} — Due ${dueStr}`,
      };
    }
    if (e.nextActionDate) {
      const dueSecondary = `Due ${formatDate(e.nextActionDate)}`;
      return {
        primary: 'Follow up with client',
        secondary: dueSecondary,
        fullTooltip: `Follow up with client — ${dueSecondary}`,
      };
    }
    return {
      primary: '—',
      fullTooltip: '',
    };
  };

  const closedOutcomeDetailsForEnquiry = (
    e: Enquiry,
  ): { primary: React.ReactNode; secondary: React.ReactNode; fullTooltip: string } => {
    const closedDate = formatDate(e.updatedAt || e.receivedAt) || '—';
    const closeReason = e.closeReasonId ? resolveLabel(values, e.closeReasonId) : '';
    let outcome: string = e.status;
    if (e.status === 'Converted') {
      outcome = 'Converted to matter';
    } else if (e.status === 'Declined' && closeReason) {
      outcome = `Declined · ${closeReason}`;
    } else if (e.status === 'Referred out') {
      outcome = e.referredToName ? `Referred out · ${e.referredToName}` : 'Referred out';
    }
    return {
      primary: closedDate,
      secondary: outcome,
      fullTooltip: `${closedDate} — ${outcome}${e.closeNotes ? `: ${e.closeNotes}` : ''}`,
    };
  };

  const followUpOrOutcomeDetailsForQuote = (
    q: Quote,
  ): { primary: React.ReactNode; secondary?: React.ReactNode; fullTooltip: string } => {
    const effStatus = evaluateQuoteEffectiveStatus(q, now);
    const expired = isQuoteExpired(q, now);
    const overdue = isQuoteFollowUpOverdue(q, now);

    if (effStatus === 'Draft') {
      return {
        primary: 'Complete & send quote',
        secondary: q.validUntil ? `Valid until ${formatDate(q.validUntil)}` : undefined,
        fullTooltip: `Complete & send quote · Valid until ${formatDate(q.validUntil)}`,
      };
    }

    if (effStatus === 'Accepted' || effStatus === 'Declined' || effStatus === 'Expired' || effStatus === 'Superseded') {
      const outcomeDate = formatDate(q.outcomeAt || q.updatedAt || q.createdAt) || '—';
      let outcomeText = effStatus as string;
      if (effStatus === 'Accepted') {
        outcomeText = q.convertedMatterId ? 'Accepted · Converted to matter' : 'Accepted · Ready to convert';
      } else if (effStatus === 'Declined') {
        outcomeText = q.declineReason ? `Declined · ${q.declineReason}` : 'Declined';
      } else if (effStatus === 'Expired') {
        outcomeText = `Expired ${formatDate(q.validUntil)}`;
      }
      return {
        primary: expired ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              background: 'rgba(100, 116, 139, 0.14)',
              color: '#64748b',
              border: '1px solid rgba(100, 116, 139, 0.3)',
            }}
          >
            Expired {formatDate(q.validUntil)}
          </span>
        ) : (
          outcomeDate
        ),
        secondary: expired ? `Sent ${formatDate(q.sentAt)}` : outcomeText,
        fullTooltip: `${outcomeDate} — ${outcomeText}`,
      };
    }

    // Open quote (Sent or Follow-up due)
    const followUpStr = q.nextFollowUpDate ? formatDate(q.nextFollowUpDate) : 'Not scheduled';
    const validStr = q.validUntil ? `Valid until ${formatDate(q.validUntil)}` : undefined;

    return {
      primary: overdue ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            background: 'rgba(217, 119, 6, 0.15)',
            color: '#b45309',
            border: '1px solid rgba(217, 119, 6, 0.4)',
          }}
        >
          Follow-up overdue · {followUpStr}
        </span>
      ) : (
        <span>Follow-up {followUpStr}</span>
      ),
      secondary: validStr,
      fullTooltip: `Next follow-up: ${followUpStr}${validStr ? ` · ${validStr}` : ''}`,
    };
  };

  const tabEnquiries = useMemo(
    () => filterEnquiriesForTab(enquiries, tab, currentUserId, myTeamIds),
    [enquiries, tab, myTeamIds, currentUserId],
  );

  const tabQuotes = useMemo(
    () => filterQuotesForTab(quotes, tab, currentUserId, myTeamIds, now),
    [quotes, tab, currentUserId, myTeamIds, now],
  );

  const matchesStatusFilter = (kind: 'enquiry' | 'quote', status: string, quote?: Quote): boolean => {
    if (statusFilter === 'all') return true;
    if (statusFilter.startsWith('enquiry:')) {
      if (kind !== 'enquiry') return false;
      return status === statusFilter.slice('enquiry:'.length);
    }
    if (statusFilter.startsWith('quote:')) {
      if (kind !== 'quote') return false;
      const target = statusFilter.slice('quote:'.length);
      if (target === 'Superseded' && quote) {
        return status === 'Superseded' || quote.versionHistory.some((v) => v.status === 'Superseded');
      }
      return status === target;
    }
    return status === statusFilter;
  };

  const filtered = useMemo<IntakeQueueRow[]>(() => {
    const rows: IntakeQueueRow[] = [];

    if (typeFilter === 'all' || typeFilter === 'enquiry') {
      for (const e of tabEnquiries) {
        // Quote-only filters exclude enquiries when active
        if (feeBasisFilter !== 'all') continue;
        if (validUntilFrom || validUntilTo) continue;
        if (followUpDueFilter !== 'all') continue;

        if (practiceAreaFilter !== 'all' && e.practiceAreaId !== practiceAreaFilter) continue;
        if (teamFilter !== 'all' && e.assignedTeamId !== teamFilter) continue;
        if (urgencyFilter !== 'all' && e.urgencyId !== urgencyFilter) continue;
        if (!matchesStatusFilter('enquiry', e.status)) continue;
        if (channelFilter !== 'all' && e.channelId !== channelFilter) continue;
        if (feeEarnerFilter !== 'all' && e.assignedToId !== feeEarnerFilter) continue;

        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const linkedQuoteRefs = (quotesByEnquiryId.get(e.id) ?? [])
            .map((qt) => qt.reference)
            .join(' ');
          const hay =
            `${e.reference} ${e.firstName} ${e.lastName} ${e.callingOnBehalfOf} ${e.summary} ${e.email} ${e.phone} ${linkedQuoteRefs}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        rows.push({ kind: 'enquiry', id: e.id, enquiry: e });
      }
    }

    if (typeFilter === 'all' || typeFilter === 'quote') {
      // If user explicitly filters by Quote: Superseded, also include quotes with Superseded version history
      const candidateQuotes =
        statusFilter === 'quote:Superseded'
          ? quotes
          : tabQuotes;

      for (const qt of candidateQuotes) {
        const effStatus = evaluateQuoteEffectiveStatus(qt, now);

        if (practiceAreaFilter !== 'all' && qt.practiceAreaId !== practiceAreaFilter) continue;
        if (teamFilter !== 'all' && qt.assignedTeamId !== teamFilter) continue;
        if (urgencyFilter !== 'all') {
          const linkedEnq = qt.linkedEnquiryId ? enquiryById.get(qt.linkedEnquiryId) : null;
          if (!linkedEnq || linkedEnq.urgencyId !== urgencyFilter) continue;
        }
        if (!matchesStatusFilter('quote', effStatus, qt)) continue;
        if (channelFilter !== 'all') {
          const linkedEnq = qt.linkedEnquiryId ? enquiryById.get(qt.linkedEnquiryId) : null;
          if (!linkedEnq || linkedEnq.channelId !== channelFilter) continue;
        }
        if (feeBasisFilter !== 'all' && qt.feeBasis !== feeBasisFilter) continue;
        if (feeEarnerFilter !== 'all' && qt.feeEarnerId !== feeEarnerFilter) continue;
        if (validUntilFrom && qt.validUntil < validUntilFrom) continue;
        if (validUntilTo && qt.validUntil > validUntilTo) continue;

        if (followUpDueFilter === 'overdue' && !isQuoteFollowUpOverdue(qt, now)) continue;
        if (followUpDueFilter === 'today' && !isQuoteFollowUpDueToday(qt, now)) continue;
        if (followUpDueFilter === 'this_week' && !isQuoteFollowUpDueThisWeek(qt, now)) continue;

        if (searchQuery.trim()) {
          const sq = searchQuery.toLowerCase();
          const clientName = quoteClientDisplayName(qt, people, organisations);
          const workSummary = quoteWorkTypeSummary(qt, values);
          const linkedEnqRef = qt.linkedEnquiryId ?? '';
          const hay =
            `${qt.reference} ${clientName} ${qt.prospectName} ${qt.prospectOrganisationName} ${qt.prospectEmail} ${qt.prospectPhone} ${qt.scope} ${workSummary} ${linkedEnqRef}`.toLowerCase();
          if (!hay.includes(sq)) continue;
        }

        rows.push({ kind: 'quote', id: qt.id, quote: qt });
      }
    }

    const defaultSorted = sortIntakeQueue(rows, values, now);
    if (!sort) return defaultSorted;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...defaultSorted].sort((a, b) => {
      if (sort.columnId === 'urgency') {
        const rA = a.kind === 'enquiry' ? urgencyRank(a.enquiry.urgencyId, values) : 2;
        const rB = b.kind === 'enquiry' ? urgencyRank(b.enquiry.urgencyId, values) : 2;
        if (rA !== rB) return (rA - rB) * dir;
      } else if (sort.columnId === 'status') {
        const stA =
          a.kind === 'enquiry'
            ? a.enquiry.status
            : evaluateQuoteEffectiveStatus(a.quote, now);
        const stB =
          b.kind === 'enquiry'
            ? b.enquiry.status
            : evaluateQuoteEffectiveStatus(b.quote, now);
        const sA = STATUS_SORT_ORDER[stA] ?? 99;
        const sB = STATUS_SORT_ORDER[stB] ?? 99;
        if (sA !== sB) return (sA - sB) * dir;
      } else if (sort.columnId === 'receivedAt') {
        const tA = new Date(
          a.kind === 'enquiry' ? a.enquiry.receivedAt : a.quote.createdAt,
        ).getTime();
        const tB = new Date(
          b.kind === 'enquiry' ? b.enquiry.receivedAt : b.quote.createdAt,
        ).getTime();
        if (tA !== tB) return (tA - tB) * dir;
      }
      const timeA = new Date(
        a.kind === 'enquiry' ? a.enquiry.receivedAt : a.quote.createdAt,
      ).getTime();
      const timeB = new Date(
        b.kind === 'enquiry' ? b.enquiry.receivedAt : b.quote.createdAt,
      ).getTime();
      return timeA - timeB;
    });
  }, [
    tabEnquiries,
    tabQuotes,
    quotes,
    typeFilter,
    practiceAreaFilter,
    teamFilter,
    urgencyFilter,
    statusFilter,
    channelFilter,
    feeBasisFilter,
    feeEarnerFilter,
    validUntilFrom,
    validUntilTo,
    followUpDueFilter,
    searchQuery,
    quotesByEnquiryId,
    enquiryById,
    people,
    organisations,
    values,
    sort,
    now,
  ]);

  const columns = useMemo<DataListColumn<IntakeQueueRow>[]>(() => {
    const itemCol: DataListColumn<IntakeQueueRow> = {
      id: 'enquiry',
      header: 'Client / Prospect',
      width: '22%',
      priority: 1,
      keepSecondaryInCompact: true,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          const linkedQuotes = quotesByEnquiryId.get(enq.id) ?? [];
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  display: 'inline-block',
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--surface-subtle, rgba(15, 23, 42, 0.06))',
                  color: 'var(--text-secondary, #475569)',
                  border: '1px solid var(--border, rgba(15, 23, 42, 0.12))',
                  flexShrink: 0,
                }}
              >
                Enquiry
              </span>
              <Link href={`/enquiries/${enq.id}`}>
                {enquiryDisplayName(enq, 'Unnamed enquiry')}
              </Link>
              {linkedQuotes.length > 0 ? (
                <Link
                  href={`/quotes/${linkedQuotes[0].id}`}
                  title={`${linkedQuotes.length} linked quote${linkedQuotes.length === 1 ? '' : 's'}: ${linkedQuotes.map((q) => q.reference).join(', ')}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: 999,
                    background: 'rgba(15, 118, 110, 0.12)',
                    color: '#0f766e',
                    border: '1px solid rgba(15, 118, 110, 0.3)',
                    textDecoration: 'none',
                  }}
                >
                  Quoted ({linkedQuotes.length})
                </Link>
              ) : null}
            </span>
          );
        }

        const qt = row.quote;
        const expired = isQuoteExpired(qt, now);
        const clientLabel = quoteClientDisplayName(qt, people, organisations);
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              opacity: expired ? 0.72 : 1,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                padding: '1px 6px',
                borderRadius: 4,
                background: expired
                  ? 'rgba(100, 116, 139, 0.12)'
                  : 'rgba(15, 118, 110, 0.1)',
                color: expired ? '#64748b' : '#0f766e',
                border: expired
                  ? '1px solid rgba(100, 116, 139, 0.25)'
                  : '1px solid rgba(15, 118, 110, 0.25)',
                flexShrink: 0,
              }}
            >
              Quote
            </span>
            <Link href={`/quotes/${qt.id}`}>{clientLabel}</Link>
          </span>
        );
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry') {
          return row.enquiry.reference;
        }
        const qt = row.quote;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>
              {qt.reference}
              {qt.version > 1 ? ` (v${qt.version})` : ''}
            </span>
            {qt.linkedEnquiryId ? (
              <>
                <span>·</span>
                <Link
                  href={`/enquiries/${qt.linkedEnquiryId}`}
                  style={{ color: 'var(--brand, #0f766e)', fontWeight: 500 }}
                  title={`Linked to enquiry ${qt.linkedEnquiryId}`}
                >
                  {qt.linkedEnquiryId}
                </Link>
              </>
            ) : null}
          </span>
        );
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          return `${enquiryDisplayName(enq, 'Unnamed enquiry')} (${enq.reference})`;
        }
        const qt = row.quote;
        return `${quoteClientDisplayName(qt, people, organisations)} (${qt.reference}${qt.version > 1 ? ` v${qt.version}` : ''})`;
      },
    };

    const summaryCol: DataListColumn<IntakeQueueRow> = {
      id: 'summary',
      header: 'Summary / Work type',
      width: '25%',
      priority: 1,
      keepSecondaryInCompact: true,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry') {
          return row.enquiry.summary || <span className="muted">—</span>;
        }
        const qt = row.quote;
        const expired = isQuoteExpired(qt, now);
        const wt = quoteWorkTypeSummary(qt, values);
        return (
          <span style={expired ? { color: '#64748b' } : undefined}>
            <strong>{wt}</strong>
            {qt.scope ? ` — ${qt.scope}` : ''}
          </span>
        );
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          const kd = formatKeyDateSummary(enq.keyDate);
          if (!kd) return undefined;
          return (
            <span
              className={`key-date-inline ${kd.isUrgentWeek ? 'key-date-inline--urgent' : ''}`}
            >
              <Calendar size={11} aria-hidden="true" />
              <span>{kd.text}</span>
            </span>
          );
        }
        const qt = row.quote;
        const expired = isQuoteExpired(qt, now);
        return (
          <span style={expired ? { color: '#64748b', fontWeight: 600 } : undefined}>
            Valid until {formatDate(qt.validUntil) || '—'}
            {expired ? ' (Expired)' : ''}
          </span>
        );
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          const kd = formatKeyDateSummary(enq.keyDate);
          const kdPart = kd
            ? ` · ${kd.text}${enq.keyDateLabel ? ` (${enq.keyDateLabel})` : ''}`
            : '';
          return `${enq.summary || ''}${kdPart}` || undefined;
        }
        const qt = row.quote;
        return `${quoteWorkTypeSummary(qt, values)} — ${qt.scope}`;
      },
    };

    const urgencyOrFeeCol: DataListColumn<IntakeQueueRow> = {
      id: 'urgency',
      header: 'Urgency / Fee (ex VAT)',
      width: '135px',
      priority: 1,
      sortable: true,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry') {
          const urgLabel = resolveLabel(values, row.enquiry.urgencyId) || 'Standard';
          if (!isExceptionalUrgencyLabel(urgLabel)) {
            return <span className="muted" style={{ fontSize: 12 }}>Standard</span>;
          }
          return <StatusPill label={urgLabel} tone={urgencyTone(urgLabel)} />;
        }
        const qt = row.quote;
        const expired = isQuoteExpired(qt, now);
        return (
          <span
            style={{
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: expired ? '#64748b' : undefined,
            }}
          >
            {formatGbp(qt.feeAmountExVat)}
          </span>
        );
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry') return undefined;
        return row.quote.feeBasis;
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry') {
          return resolveLabel(values, row.enquiry.urgencyId) || 'Standard';
        }
        return `${formatGbp(row.quote.feeAmountExVat)} ex VAT · ${row.quote.feeBasis}`;
      },
    };

    const statusCol: DataListColumn<IntakeQueueRow> = {
      id: 'status',
      header: 'Status',
      width: '130px',
      priority: 1,
      sortable: true,
      secondarySortable: { id: 'receivedAt', header: 'Age' },
      renderPrimary: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          return <StatusPill label={enq.status} tone={enquiryStatusTone(enq.status)} />;
        }
        const qt = row.quote;
        const effStatus = evaluateQuoteEffectiveStatus(qt, now);
        if (effStatus === 'Expired') {
          return (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 9px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: 'rgba(100, 116, 139, 0.14)',
                color: '#64748b',
                border: '1px solid rgba(100, 116, 139, 0.3)',
              }}
            >
              Expired
            </span>
          );
        }
        return <StatusPill label={effStatus} tone={quoteStatusTone(effStatus)} />;
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          return (
            <RelativeTime
              value={enq.receivedAt}
              tooltipDetail={resolveLabel(values, enq.channelId)}
            />
          );
        }
        const qt = row.quote;
        return <RelativeTime value={qt.createdAt} tooltipDetail={`Quote ${qt.reference}`} />;
      },
    };

    const assignedCol: DataListColumn<IntakeQueueRow> = {
      id: 'assignedTo',
      header: 'Assigned / Fee earner',
      width: '150px',
      priority: 2,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry') {
          const enq = row.enquiry;
          const personLabel = enq.assignedToId ? nameOfPerson(enq.assignedToId) : '';
          return <PersonChip name={personLabel} emptyLabel="Unassigned" />;
        }
        const qt = row.quote;
        const feLabel = qt.feeEarnerId ? nameOfPerson(qt.feeEarnerId) : '';
        return <PersonChip name={feLabel} emptyLabel="Unassigned" />;
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry') {
          return row.enquiry.assignedToId ? nameOfPerson(row.enquiry.assignedToId) : 'Unassigned';
        }
        return row.quote.feeEarnerId ? nameOfPerson(row.quote.feeEarnerId) : 'Unassigned';
      },
    };

    const nextActionOrClosedCol: DataListColumn<IntakeQueueRow> =
      tab === 'closed'
        ? {
            id: 'closed',
            header: 'Closed / Outcome',
            width: '19%',
            priority: 2,
            keepSecondaryInCompact: true,
            renderPrimary: (row) =>
              row.kind === 'enquiry'
                ? closedOutcomeDetailsForEnquiry(row.enquiry).primary
                : followUpOrOutcomeDetailsForQuote(row.quote).primary,
            renderSecondary: (row) =>
              row.kind === 'enquiry'
                ? closedOutcomeDetailsForEnquiry(row.enquiry).secondary
                : followUpOrOutcomeDetailsForQuote(row.quote).secondary,
            tooltip: (row) =>
              row.kind === 'enquiry'
                ? closedOutcomeDetailsForEnquiry(row.enquiry).fullTooltip
                : followUpOrOutcomeDetailsForQuote(row.quote).fullTooltip,
          }
        : {
            id: 'nextAction',
            header: 'Next action / Follow-up',
            width: '19%',
            priority: 2,
            keepSecondaryInCompact: true,
            renderPrimary: (row) =>
              row.kind === 'enquiry'
                ? nextActionDetailsForEnquiry(row.enquiry).primary
                : followUpOrOutcomeDetailsForQuote(row.quote).primary,
            renderSecondary: (row) =>
              row.kind === 'enquiry'
                ? nextActionDetailsForEnquiry(row.enquiry).secondary
                : followUpOrOutcomeDetailsForQuote(row.quote).secondary,
            tooltip: (row) =>
              row.kind === 'enquiry'
                ? nextActionDetailsForEnquiry(row.enquiry).fullTooltip || undefined
                : followUpOrOutcomeDetailsForQuote(row.quote).fullTooltip || undefined,
          };

    const practiceAreaAndActionsCol: DataListColumn<IntakeQueueRow> = {
      id: 'practiceArea',
      header: 'Practice area',
      width: '150px',
      priority: 3,
      renderPrimary: (row) => {
        const paId =
          row.kind === 'enquiry' ? row.enquiry.practiceAreaId : row.quote.practiceAreaId;
        const paLabel = resolveLabel(values, paId);
        const menuOpen = openRowMenuId === row.id;

        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {paLabel || <span className="muted">—</span>}
            </span>
            <div
              className="popover-anchor"
              data-row-menu="true"
              style={{ flexShrink: 0, position: 'relative' }}
            >
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label={`Actions for ${row.id}`}
                aria-expanded={menuOpen}
                style={{ padding: '2px 6px', minHeight: 24 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenRowMenuId((prev) => (prev === row.id ? null : row.id));
                }}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
              {menuOpen ? (
                <div
                  className="popover-menu"
                  role="menu"
                  style={{ right: 0, top: '100%', zIndex: 40, minWidth: 175 }}
                >
                  {row.kind === 'enquiry' ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="popover-menu__item"
                        onClick={() => {
                          setOpenRowMenuId(null);
                          router.push(`/enquiries/${row.enquiry.id}`);
                        }}
                      >
                        Open enquiry
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="popover-menu__item"
                        onClick={() => {
                          setOpenRowMenuId(null);
                          router.push(`/quotes/new?enquiryId=${row.enquiry.id}`);
                        }}
                      >
                        Create quote
                      </button>
                      {row.enquiry.status !== 'Draft' && row.enquiry.status !== 'Converted' ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="popover-menu__item"
                          onClick={() => {
                            setOpenRowMenuId(null);
                            router.push(`/matters/new?enquiryId=${row.enquiry.id}`);
                          }}
                        >
                          Convert to matter
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="popover-menu__item"
                        onClick={() => {
                          setOpenRowMenuId(null);
                          router.push(`/quotes/${row.quote.id}`);
                        }}
                      >
                        Open quote
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="popover-menu__item"
                        onClick={() => {
                          setOpenRowMenuId(null);
                          router.push(`/quotes/${row.quote.id}?action=revise`);
                        }}
                      >
                        Revise quote
                      </button>
                      {row.quote.status === 'Accepted' && !row.quote.convertedMatterId ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="popover-menu__item"
                          onClick={() => {
                            setOpenRowMenuId(null);
                            router.push(`/quotes/${row.quote.id}?action=convert`);
                          }}
                        >
                          Convert to matter
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        );
      },
      tooltip: (row) => {
        const paId =
          row.kind === 'enquiry' ? row.enquiry.practiceAreaId : row.quote.practiceAreaId;
        return resolveLabel(values, paId) || undefined;
      },
    };

    if (tab === 'drafts') {
      return [
        itemCol,
        summaryCol,
        urgencyOrFeeCol,
        statusCol,
        nextActionOrClosedCol,
        practiceAreaAndActionsCol,
      ];
    }

    return [
      itemCol,
      summaryCol,
      urgencyOrFeeCol,
      statusCol,
      assignedCol,
      nextActionOrClosedCol,
      practiceAreaAndActionsCol,
    ];
  }, [tab, values, people, organisations, tasks, quotesByEnquiryId, openRowMenuId, now, router]);

  const teamQueueCount =
    filterEnquiriesForTab(enquiries, 'team', currentUserId, myTeamIds).length +
    filterQuotesForTab(quotes, 'team', currentUserId, myTeamIds, now).length;
  const mineCount =
    filterEnquiriesForTab(enquiries, 'mine', currentUserId, myTeamIds).length +
    filterQuotesForTab(quotes, 'mine', currentUserId, myTeamIds, now).length;
  const draftsCount =
    filterEnquiriesForTab(enquiries, 'drafts', currentUserId, myTeamIds).length +
    filterQuotesForTab(quotes, 'drafts', currentUserId, myTeamIds, now).length;
  const allOpenCount =
    filterEnquiriesForTab(enquiries, 'open', currentUserId, myTeamIds).length +
    filterQuotesForTab(quotes, 'open', currentUserId, myTeamIds, now).length;
  const openQuotesCount = filterQuotesForTab(
    quotes,
    'open_quotes',
    currentUserId,
    myTeamIds,
    now,
  ).length;
  const closedCount =
    filterEnquiriesForTab(enquiries, 'closed', currentUserId, myTeamIds).length +
    filterQuotesForTab(quotes, 'closed', currentUserId, myTeamIds, now).length;

  const statusChipLabel = (raw: string): string => {
    if (raw.startsWith('enquiry:')) return `Enquiry · ${raw.slice('enquiry:'.length)}`;
    if (raw.startsWith('quote:')) return `Quote · ${raw.slice('quote:'.length)}`;
    return raw;
  };

  return (
    <div className="page-list">
      <div className="page-header">
        <div>
          <h1>Enquiries &amp; Quotes</h1>
        </div>
      </div>

      <div className="tabs-bar">
        <div
          role="tablist"
          aria-label="Enquiries and quotes queues"
          style={{ display: 'flex', alignItems: 'center', gap: 24 }}
        >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'team'}
          className={`tab-btn ${tab === 'team' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('team')}
        >
          Team queue ({teamQueueCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mine'}
          className={`tab-btn ${tab === 'mine' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('mine')}
        >
          Mine ({mineCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'drafts'}
          className={`tab-btn ${tab === 'drafts' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('drafts')}
        >
          My drafts ({draftsCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'open'}
          className={`tab-btn ${tab === 'open' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('open')}
        >
          All open ({allOpenCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'open_quotes'}
          className={`tab-btn ${tab === 'open_quotes' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('open_quotes')}
        >
          Open quotes ({openQuotesCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'closed'}
          className={`tab-btn ${tab === 'closed' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('closed')}
        >
          Closed ({closedCount})
        </button>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingBottom: 6,
            flexShrink: 0,
          }}
        >
          <Link href="/enquiries/new" className="btn btn--primary">
            + New enquiry
          </Link>
          <Link href="/quotes/new" className="btn btn--primary">
            + New quote
          </Link>
        </div>
      </div>

      <DataListFilterBar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search reference, linked enquiry, name, summary…"
        searchAriaLabel="Search enquiries and quotes"
        primaryFilters={
          <>
            <select
              id="enq-filter-type"
              name="enquiriesFilterType"
              aria-label="Filter by type"
              className="field-select list-filter-row__select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | 'enquiry' | 'quote')}
            >
              <option value="all">All types</option>
              <option value="enquiry">Enquiries</option>
              <option value="quote">Quotes</option>
            </select>
            <select
              id="enq-filter-urgency"
              name="enquiriesFilterUrgency"
              aria-label="Filter by urgency"
              className="field-select list-filter-row__select"
              value={urgencyFilter}
              onChange={(e) => setUrgencyFilter(e.target.value)}
            >
              <option value="all">All urgencies</option>
              {urgencies.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
            <select
              id="enq-filter-status"
              name="enquiriesFilterStatus"
              aria-label="Filter by status"
              className="field-select list-filter-row__select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <optgroup label="Enquiry">
                <option value="enquiry:Draft">Draft</option>
                <option value="enquiry:New">New</option>
                <option value="enquiry:Assigned">Assigned</option>
                <option value="enquiry:In contact">In contact</option>
                <option value="enquiry:Converted">Converted</option>
                <option value="enquiry:Declined">Declined</option>
                <option value="enquiry:Referred out">Referred out</option>
                <option value="enquiry:No response">No response</option>
              </optgroup>
              <optgroup label="Quote">
                <option value="quote:Draft">Draft</option>
                <option value="quote:Sent">Sent</option>
                <option value="quote:Follow-up due">Follow-up due</option>
                <option value="quote:Accepted">Accepted</option>
                <option value="quote:Declined">Declined</option>
                <option value="quote:Expired">Expired</option>
                <option value="quote:Superseded">Superseded</option>
              </optgroup>
            </select>
          </>
        }
        moreFiltersActiveCount={
          [
            practiceAreaFilter !== 'all',
            teamFilter !== 'all',
            channelFilter !== 'all',
            feeBasisFilter !== 'all',
            feeEarnerFilter !== 'all',
            Boolean(validUntilFrom || validUntilTo),
            followUpDueFilter !== 'all',
          ].filter(Boolean).length
        }
        moreFiltersContent={
          <>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-pa">
                Practice area
              </label>
              <select
                id="enq-filter-pa"
                name="enquiriesFilterPracticeArea"
                aria-label="Filter by practice area"
                className="field-select"
                value={practiceAreaFilter}
                onChange={(e) => setPracticeAreaFilter(e.target.value)}
              >
                <option value="all">All practice areas</option>
                {practiceAreas.map((pa) => (
                  <option key={pa.id} value={pa.id}>
                    {pa.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-team">
                Team
              </label>
              <select
                id="enq-filter-team"
                name="enquiriesFilterTeam"
                aria-label="Filter by team"
                className="field-select"
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
              >
                <option value="all">All teams</option>
                {teams
                  .filter((t) => t.active)
                  .map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-channel">
                Channel
              </label>
              <select
                id="enq-filter-channel"
                name="enquiriesFilterChannel"
                aria-label="Filter by channel"
                className="field-select"
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
              >
                <option value="all">All channels</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-fee-basis">
                Fee basis
              </label>
              <select
                id="enq-filter-fee-basis"
                name="enquiriesFilterFeeBasis"
                aria-label="Filter by fee basis"
                className="field-select"
                value={feeBasisFilter}
                onChange={(e) => setFeeBasisFilter(e.target.value)}
              >
                <option value="all">All fee bases</option>
                {QUOTE_FEE_BASES.map((fb) => (
                  <option key={fb} value={fb}>
                    {fb}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-fee-earner">
                Fee earner
              </label>
              <select
                id="enq-filter-fee-earner"
                name="enquiriesFilterFeeEarner"
                aria-label="Filter by fee earner"
                className="field-select"
                value={feeEarnerFilter}
                onChange={(e) => setFeeEarnerFilter(e.target.value)}
              >
                <option value="all">All fee earners</option>
                {feeEarners.map((fe) => (
                  <option key={fe.id} value={fe.id}>
                    {personDisplayName(fe)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-valid-from">
                Valid until (from / to)
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  id="enq-filter-valid-from"
                  type="date"
                  aria-label="Valid until from date"
                  className="field-input"
                  value={validUntilFrom}
                  onChange={(e) => setValidUntilFrom(e.target.value)}
                />
                <span className="muted">–</span>
                <input
                  id="enq-filter-valid-to"
                  type="date"
                  aria-label="Valid until to date"
                  className="field-input"
                  value={validUntilTo}
                  onChange={(e) => setValidUntilTo(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="enq-filter-followup-due">
                Follow-up due
              </label>
              <select
                id="enq-filter-followup-due"
                name="enquiriesFilterFollowUpDue"
                aria-label="Filter by follow-up due"
                className="field-select"
                value={followUpDueFilter}
                onChange={(e) =>
                  setFollowUpDueFilter(
                    e.target.value as 'all' | 'overdue' | 'today' | 'this_week',
                  )
                }
              >
                <option value="all">All</option>
                <option value="overdue">Overdue</option>
                <option value="today">Today</option>
                <option value="this_week">This week</option>
              </select>
            </div>
          </>
        }
        activeChips={[
          ...(typeFilter !== 'all'
            ? [
                {
                  key: 'type',
                  label: 'Type',
                  valueLabel: typeFilter === 'enquiry' ? 'Enquiries' : 'Quotes',
                  onRemove: () => setTypeFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(urgencyFilter !== 'all'
            ? [
                {
                  key: 'urgency',
                  label: 'Urgency',
                  valueLabel: resolveLabel(values, urgencyFilter),
                  onRemove: () => setUrgencyFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(statusFilter !== 'all'
            ? [
                {
                  key: 'status',
                  label: 'Status',
                  valueLabel: statusChipLabel(statusFilter),
                  onRemove: () => setStatusFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(practiceAreaFilter !== 'all'
            ? [
                {
                  key: 'practiceArea',
                  label: 'Practice area',
                  valueLabel: resolveLabel(values, practiceAreaFilter),
                  onRemove: () => setPracticeAreaFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(teamFilter !== 'all'
            ? [
                {
                  key: 'team',
                  label: 'Team',
                  valueLabel: teams.find((t) => t.id === teamFilter)?.name ?? teamFilter,
                  onRemove: () => setTeamFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(channelFilter !== 'all'
            ? [
                {
                  key: 'channel',
                  label: 'Channel',
                  valueLabel: resolveLabel(values, channelFilter),
                  onRemove: () => setChannelFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(feeBasisFilter !== 'all'
            ? [
                {
                  key: 'feeBasis',
                  label: 'Fee basis',
                  valueLabel: feeBasisFilter,
                  onRemove: () => setFeeBasisFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(feeEarnerFilter !== 'all'
            ? [
                {
                  key: 'feeEarner',
                  label: 'Fee earner',
                  valueLabel: nameOfPerson(feeEarnerFilter),
                  onRemove: () => setFeeEarnerFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(validUntilFrom || validUntilTo
            ? [
                {
                  key: 'validUntil',
                  label: 'Valid until',
                  valueLabel: `${validUntilFrom || '…'} to ${validUntilTo || '…'}`,
                  onRemove: () => {
                    setValidUntilFrom('');
                    setValidUntilTo('');
                  },
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(followUpDueFilter !== 'all'
            ? [
                {
                  key: 'followUpDue',
                  label: 'Follow-up due',
                  valueLabel:
                    followUpDueFilter === 'overdue'
                      ? 'Overdue'
                      : followUpDueFilter === 'today'
                        ? 'Today'
                        : 'This week',
                  onRemove: () => setFollowUpDueFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
        ]}
        onClearAll={() => {
          setTypeFilter('all');
          setUrgencyFilter('all');
          setStatusFilter('all');
          setPracticeAreaFilter('all');
          setTeamFilter('all');
          setChannelFilter('all');
          setFeeBasisFilter('all');
          setFeeEarnerFilter('all');
          setValidUntilFrom('');
          setValidUntilTo('');
          setFollowUpDueFilter('all');
          setSearchQuery('');
        }}
        density={density}
        onDensityChange={setDensity}
      />

      <DataList
        columns={columns}
        rows={filtered}
        getRowId={(row) => `${row.kind}:${row.id}`}
        getRowUrgency={(row) => {
          if (row.kind === 'enquiry') {
            return urgencyEdgeKind(resolveLabel(values, row.enquiry.urgencyId));
          }
          if (isQuoteFollowUpOverdue(row.quote, now)) {
            return 'urgent';
          }
          return null;
        }}
        onRowClick={(row) =>
          router.push(
            row.kind === 'enquiry'
              ? `/enquiries/${row.enquiry.id}`
              : `/quotes/${row.quote.id}`,
          )
        }
        sort={sort}
        onSortChange={setSort}
        defaultSortLabel="Default order"
        density={density}
        emptyMessage="No enquiries or quotes match the selected queue and filters."
        ariaLabel="Enquiries and quotes queue"
        renderMobileCard={(row) => {
          if (row.kind === 'enquiry') {
            const enq = row.enquiry;
            const urgLabel = resolveLabel(values, enq.urgencyId) || 'Standard';
            const personLabel = enq.assignedToId ? nameOfPerson(enq.assignedToId) : '';
            const linkedQuotes = quotesByEnquiryId.get(enq.id) ?? [];
            return (
              <>
                <div className="data-list__card-top">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="status-pill status-pill--neutral">Enquiry</span>
                    <Link href={`/enquiries/${enq.id}`} style={{ fontWeight: 600 }}>
                      {enquiryDisplayName(enq, 'Unnamed enquiry')}
                    </Link>
                    {linkedQuotes.length > 0 ? (
                      <span className="status-pill status-pill--positive">
                        Quoted ({linkedQuotes.length})
                      </span>
                    ) : null}
                  </span>
                  {isExceptionalUrgencyLabel(urgLabel) ? (
                    <StatusPill label={urgLabel} tone={urgencyTone(urgLabel)} />
                  ) : null}
                </div>
                <div className="data-list__card-summary">{enq.summary || '—'}</div>
                <div className="data-list__card-footer">
                  <StatusPill label={enq.status} tone={enquiryStatusTone(enq.status)} />
                  <RelativeTime
                    value={enq.receivedAt}
                    tooltipDetail={resolveLabel(values, enq.channelId)}
                  />
                  <span>·</span>
                  <PersonChip name={personLabel} emptyLabel="Unassigned" />
                </div>
              </>
            );
          }

          const qt = row.quote;
          const effStatus = evaluateQuoteEffectiveStatus(qt, now);
          const feLabel = qt.feeEarnerId ? nameOfPerson(qt.feeEarnerId) : '';
          return (
            <>
              <div className="data-list__card-top">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="status-pill status-pill--neutral">Quote</span>
                  <Link href={`/quotes/${qt.id}`} style={{ fontWeight: 600 }}>
                    {quoteClientDisplayName(qt, people, organisations)}
                  </Link>
                </span>
                <span style={{ fontWeight: 700 }}>{formatGbp(qt.feeAmountExVat)}</span>
              </div>
              <div className="data-list__card-summary">
                {qt.reference}
                {qt.version > 1 ? ` (v${qt.version})` : ''} · {quoteWorkTypeSummary(qt, values)} —{' '}
                {qt.feeBasis}
              </div>
              <div className="data-list__card-footer">
                <StatusPill label={effStatus} tone={quoteStatusTone(effStatus)} />
                <span>Valid until {formatDate(qt.validUntil)}</span>
                <span>·</span>
                <PersonChip name={feLabel} emptyLabel="Unassigned" />
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
