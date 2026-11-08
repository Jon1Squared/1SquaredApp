'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar } from 'lucide-react';
import type { PillTone, UrgencyEdgeKind } from '@/domain/badges';
import { formatDate, formatKeyDateSummary } from '@/domain/dates';
import { resolveLabel } from '@/domain/lists';
import { extractCriticalDates } from '@/domain/matters';
import { hrefForId, personDisplayName } from '@/domain/names';
import { formatGbp, formatPmsAsAtLabel, formatWholePct } from '@/domain/pms';
import { isTaskOpen } from '@/domain/tasks';
import type { ChoiceValue, Matter, Organisation, Person, Task } from '@/domain/types';
import type { PmsMatterFinancials } from '@/pms/types';
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

interface MattersListClientProps {
  matters: Matter[];
  people: Person[];
  organisations: Organisation[];
  tasks?: Task[];
  values: ChoiceValue[];
  currentUserId?: string;
  canViewFinance?: boolean;
  pmsSummaryByMatterId?: Record<string, PmsMatterFinancials>;
  pmsAsAtDate?: string;
}

type MattersTab = 'all' | 'mine' | 'Transactional' | 'Contentious' | 'Advisory';

const STATUS_SORT_ORDER: Record<string, number> = {
  'cmi incomplete': 0,
  active: 1,
  'pre-engagement': 2,
  'on hold': 3,
  closing: 4,
  closed: 5,
  archived: 6,
};

function matterStatusTone(statusLabel: string): PillTone {
  const l = statusLabel.toLowerCase();
  if (l === 'active') return 'positive';
  if (
    l.includes('cmi incomplete') ||
    l.includes('incomplete') ||
    l.includes('pending') ||
    l.includes('hold') ||
    l.includes('pre') ||
    l.includes('closing')
  ) {
    return 'warning';
  }
  return 'neutral';
}

export function MattersListClient({
  matters = [],
  people,
  organisations,
  tasks = [],
  values,
  currentUserId = '',
  canViewFinance = false,
  pmsSummaryByMatterId = {},
  pmsAsAtDate = '2026-10-16',
}: MattersListClientProps) {
  const router = useRouter();

  const [tab, setTab] = useState<MattersTab>('all');
  const [query, setQuery] = useState('');
  const [practiceAreaId, setPracticeAreaId] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [feeEarnerFilter, setFeeEarnerFilter] = useState('all');
  const [billingBasisFilter, setBillingBasisFilter] = useState('all');
  const [showPmsColumns, setShowPmsColumns] = useState(true);
  const [sort, setSort] = useState<DataListSortState | null>(null);
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

  const clientNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of organisations) map.set(o.id, o.legalName);
    for (const p of people) map.set(p.id, personDisplayName(p));
    return map;
  }, [organisations, people]);

  const practiceAreas = useMemo(
    () =>
      values
        .filter((v) => v.listKey === 'work_type' && !v.parentId && v.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [values],
  );

  const matterStatuses = useMemo(
    () =>
      values
        .filter((v) => v.listKey === 'matter_status' && v.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [values],
  );

  const billingBases = useMemo(
    () =>
      values
        .filter((v) => v.listKey === 'billing_basis' && v.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [values],
  );

  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const isMyMatter = (m: Matter): boolean => {
    if (!currentUserId) return false;
    return (
      m.leadFeeEarnerId === currentUserId ||
      m.responsiblePartnerId === currentUserId ||
      m.supervisingPartnerId === currentUserId ||
      m.teamMemberIds.includes(currentUserId)
    );
  };

  const tabMatters = useMemo(() => {
    if (tab === 'mine') return matters.filter(isMyMatter);
    if (tab === 'Transactional' || tab === 'Contentious' || tab === 'Advisory') {
      return matters.filter((m) => m.typeBadge === tab);
    }
    return matters;
  }, [matters, tab, currentUserId]);

  const filteredMatters = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = tabMatters.filter((m) => {
      if (practiceAreaId !== 'all' && m.practiceAreaId !== practiceAreaId) return false;
      if (statusFilter !== 'all') {
        const filterLabel = resolveLabel(values, statusFilter);
        const isCmiFilter = filterLabel === 'CMI incomplete';
        const isMatterCmi =
          m.matterStatusId === statusFilter ||
          (isCmiFilter &&
            (m.amlStatus === 'Pending' || m.amlStatus === 'CMI incomplete'));
        if (!isMatterCmi && m.matterStatusId !== statusFilter) return false;
      }
      if (feeEarnerFilter !== 'all' && m.leadFeeEarnerId !== feeEarnerFilter) return false;
      if (billingBasisFilter !== 'all' && m.billingBasisId !== billingBasisFilter) {
        return false;
      }
      if (q) {
        const clientName = (clientNameMap.get(m.clientId) ?? '').toLowerCase();
        const subcat = resolveLabel(values, m.workTypeSubcategoryId).toLowerCase();
        const practice = resolveLabel(values, m.practiceAreaId).toLowerCase();
        const hay =
          `${m.matterNumber} ${m.title} ${m.shortDescription} ${clientName} ${practice} ${subcat} ${m.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!sort) return list;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sort.columnId === 'matter') {
        return a.matterNumber.localeCompare(b.matterNumber) * dir;
      }
      if (sort.columnId === 'status') {
        const sA =
          STATUS_SORT_ORDER[resolveLabel(values, a.matterStatusId).toLowerCase()] ?? 99;
        const sB =
          STATUS_SORT_ORDER[resolveLabel(values, b.matterStatusId).toLowerCase()] ?? 99;
        if (sA !== sB) return (sA - sB) * dir;
      }
      if (sort.columnId === 'openedAt') {
        const tA = new Date(a.openedAt || a.createdAt).getTime();
        const tB = new Date(b.openedAt || b.createdAt).getTime();
        if (tA !== tB) return (tA - tB) * dir;
      }
      if (sort.columnId === 'financials') {
        const wA = pmsSummaryByMatterId[a.id]?.unbilled_wip ?? a.feeEstimateGbp ?? -1;
        const wB = pmsSummaryByMatterId[b.id]?.unbilled_wip ?? b.feeEstimateGbp ?? -1;
        if (wA !== wB) return (wA - wB) * dir;
      }
      return a.matterNumber.localeCompare(b.matterNumber);
    });
  }, [
    tabMatters,
    practiceAreaId,
    statusFilter,
    feeEarnerFilter,
    billingBasisFilter,
    query,
    clientNameMap,
    values,
    sort,
    pmsSummaryByMatterId,
  ]);

  const getMatterUrgency = (m: Matter): UrgencyEdgeKind => {
    if (m.conflictCheckStatus.toLowerCase().includes('conflict')) return 'emergency';
    const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
    const criticalDates = extractCriticalDates(m, subcatLabel);
    const nextCrit = criticalDates[0]?.date ?? m.targetCompletionAt;
    const kd = formatKeyDateSummary(nextCrit);
    const statusLabel = resolveLabel(values, m.matterStatusId);
    if (
      kd?.isUrgentWeek ||
      statusLabel === 'CMI incomplete' ||
      m.amlStatus === 'CMI incomplete' ||
      m.amlStatus === 'Pending'
    ) {
      return 'urgent';
    }
    return null;
  };

  const columns = useMemo<DataListColumn<Matter>[]>(() => {
    const matterCol: DataListColumn<Matter> = {
      id: 'matter',
      header: 'Matter',
      width: '24%',
      priority: 1,
      sortable: true,
      renderPrimary: (m) => <Link href={`/matters/${m.id}`}>{m.title}</Link>,
      renderSecondary: (m) => m.matterNumber,
      tooltip: (m) => `${m.title} (${m.matterNumber})`,
    };

    const clientCol: DataListColumn<Matter> = {
      id: 'client',
      header: 'Client',
      width: '20%',
      priority: 1,
      renderPrimary: (m) => {
        const clientLabel = clientNameMap.get(m.clientId) ?? m.clientId;
        return <Link href={hrefForId(m.clientId)}>{clientLabel}</Link>;
      },
      renderSecondary: (m) =>
        resolveLabel(values, m.workTypeSubcategoryId) ||
        resolveLabel(values, m.practiceAreaId),
      tooltip: (m) => {
        const clientLabel = clientNameMap.get(m.clientId) ?? m.clientId;
        const subcat = resolveLabel(values, m.workTypeSubcategoryId);
        return subcat ? `${clientLabel} · ${subcat}` : clientLabel;
      },
    };

    const stageCol: DataListColumn<Matter> = {
      id: 'stage',
      header: 'Stage & key date',
      width: '20%',
      priority: 1,
      keepSecondaryInCompact: true,
      renderPrimary: (m) =>
        resolveLabel(values, m.stageId) || <span className="muted">—</span>,
      renderSecondary: (m) => {
        const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
        const criticalDates = extractCriticalDates(m, subcatLabel);
        const nextDate = criticalDates[0]?.date ?? m.targetCompletionAt;
        const kd = formatKeyDateSummary(nextDate);
        if (!kd) return undefined;
        return (
          <span
            className={`key-date-inline ${kd.isUrgentWeek ? 'key-date-inline--urgent' : ''}`}
          >
            <Calendar size={11} aria-hidden="true" />
            <span>{kd.text}</span>
          </span>
        );
      },
      tooltip: (m) => {
        const stageLabel = resolveLabel(values, m.stageId) || '—';
        const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
        const criticalDates = extractCriticalDates(m, subcatLabel);
        const nextCrit = criticalDates[0];
        if (nextCrit) {
          return `${stageLabel} · ${nextCrit.label}: ${formatDate(nextCrit.date)}`;
        }
        return stageLabel;
      },
    };

    const statusCol: DataListColumn<Matter> = {
      id: 'status',
      header: 'Status',
      width: '135px',
      priority: 1,
      sortable: true,
      secondarySortable: { id: 'openedAt', header: 'Age' },
      renderPrimary: (m) => {
        if (m.conflictCheckStatus.toLowerCase().includes('conflict')) {
          return <StatusPill label="Conflict flagged" tone="alert" />;
        }
        const statusLabel = resolveLabel(values, m.matterStatusId) || 'Active';
        if (
          statusLabel === 'CMI incomplete' ||
          m.amlStatus === 'CMI incomplete' ||
          m.amlStatus === 'Pending'
        ) {
          return <StatusPill label="CMI incomplete" tone="warning" />;
        }
        return <StatusPill label={statusLabel} tone={matterStatusTone(statusLabel)} />;
      },
      renderSecondary: (m) => (
        <RelativeTime value={m.openedAt || m.createdAt} tooltipDetail={m.typeBadge} />
      ),
    };

    const feeEarnerCol: DataListColumn<Matter> = {
      id: 'feeEarner',
      header: 'Fee earner',
      width: '150px',
      priority: 2,
      renderPrimary: (m) => {
        const earner = people.find((p) => p.id === m.leadFeeEarnerId);
        const label = earner ? personDisplayName(earner) : '';
        return <PersonChip name={label} emptyLabel="Unassigned" />;
      },
      tooltip: (m) => {
        const earner = people.find((p) => p.id === m.leadFeeEarnerId);
        return earner ? personDisplayName(earner) : 'Unassigned';
      },
    };

    const financialsOrWorkCol: DataListColumn<Matter> =
      canViewFinance && showPmsColumns
        ? {
            id: 'financials',
            header: 'WIP / Debt',
            width: '150px',
            priority: 2,
            sortable: true,
            renderPrimary: (m) => {
              const pmsFin = pmsSummaryByMatterId[m.id];
              if (pmsFin) {
                return `WIP ${formatGbp(pmsFin.unbilled_wip)}`;
              }
              if (m.feeEstimateGbp != null) {
                return `Est. £${m.feeEstimateGbp.toLocaleString('en-GB')}`;
              }
              return <span className="muted">—</span>;
            },
            renderSecondary: (m) => {
              const pmsFin = pmsSummaryByMatterId[m.id];
              if (pmsFin) {
                if (pmsFin.outstanding_debt > 0) {
                  return `Debt ${formatGbp(pmsFin.outstanding_debt)}`;
                }
                if (pmsFin.estimate_used_pct > 0) {
                  return `${formatWholePct(pmsFin.estimate_used_pct)} est. used`;
                }
              }
              return resolveLabel(values, m.billingBasisId) || undefined;
            },
            tooltip: (m) => {
              const pmsFin = pmsSummaryByMatterId[m.id];
              if (!pmsFin) return resolveLabel(values, m.billingBasisId) || undefined;
              return `WIP: ${formatGbp(pmsFin.unbilled_wip)} · Outstanding: ${formatGbp(
                pmsFin.outstanding_debt,
              )} · Estimate used: ${formatWholePct(pmsFin.estimate_used_pct)}`;
            },
          }
        : {
            id: 'openWork',
            header: 'Open work',
            width: '160px',
            priority: 2,
            renderPrimary: (m) => {
              const openTask = tasks.find(
                (t) =>
                  isTaskOpen(t) &&
                  t.linkedRecords.some(
                    (lr) => lr.recordType === 'matter' && lr.recordId === m.id,
                  ),
              );
              return openTask ? openTask.title : <span className="muted">—</span>;
            },
            renderSecondary: (m) => {
              const count = tasks.filter(
                (t) =>
                  isTaskOpen(t) &&
                  t.linkedRecords.some(
                    (lr) => lr.recordType === 'matter' && lr.recordId === m.id,
                  ),
              ).length;
              return count > 0 ? `${count} open task${count === 1 ? '' : 's'}` : undefined;
            },
          };

    const practiceAreaCol: DataListColumn<Matter> = {
      id: 'practiceArea',
      header: 'Practice area',
      width: '140px',
      priority: 3,
      renderPrimary: (m) =>
        resolveLabel(values, m.practiceAreaId) || <span className="muted">—</span>,
      tooltip: (m) => resolveLabel(values, m.practiceAreaId) || undefined,
    };

    return [
      matterCol,
      clientCol,
      stageCol,
      statusCol,
      feeEarnerCol,
      financialsOrWorkCol,
      practiceAreaCol,
    ];
  }, [
    values,
    people,
    clientNameMap,
    canViewFinance,
    showPmsColumns,
    pmsSummaryByMatterId,
    tasks,
  ]);

  const mineCount = useMemo(() => matters.filter(isMyMatter).length, [matters, currentUserId]);
  const transactionalCount = useMemo(
    () => matters.filter((m) => m.typeBadge === 'Transactional').length,
    [matters],
  );
  const contentiousCount = useMemo(
    () => matters.filter((m) => m.typeBadge === 'Contentious').length,
    [matters],
  );
  const advisoryCount = useMemo(
    () => matters.filter((m) => m.typeBadge === 'Advisory').length,
    [matters],
  );

  return (
    <div className="page-list">
      <div className="page-header">
        <div>
          <h1>Matters</h1>
        </div>
      </div>

      <div className="tabs-bar">
        <div
          role="tablist"
          aria-label="Matter views"
          style={{ display: 'flex', alignItems: 'center', gap: 24 }}
        >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'all'}
              className={`tab-btn ${tab === 'all' ? 'tab-btn--active' : ''}`}
              onClick={() => setTab('all')}
            >
              All matters ({matters.length})
            </button>
            {currentUserId ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'mine'}
                className={`tab-btn ${tab === 'mine' ? 'tab-btn--active' : ''}`}
                onClick={() => setTab('mine')}
              >
                My matters ({mineCount})
              </button>
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'Transactional'}
              className={`tab-btn ${tab === 'Transactional' ? 'tab-btn--active' : ''}`}
              onClick={() => setTab('Transactional')}
            >
              Transactional ({transactionalCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'Contentious'}
              className={`tab-btn ${tab === 'Contentious' ? 'tab-btn--active' : ''}`}
              onClick={() => setTab('Contentious')}
            >
              Contentious ({contentiousCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'Advisory'}
              className={`tab-btn ${tab === 'Advisory' ? 'tab-btn--active' : ''}`}
              onClick={() => setTab('Advisory')}
            >
              Advisory ({advisoryCount})
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
              <Link href="/matters/new" className="btn btn--primary">
                + New matter
              </Link>
            </div>
          </div>

          <DataListFilterBar
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder="Search matter number, title, client, work type…"
            searchAriaLabel="Search matters"
            primaryFilters={
              <>
                <select
                  id="matters-filter-practice-area"
                  name="mattersFilterPracticeArea"
                  aria-label="Filter by practice area"
                  className="field-select list-filter-row__select"
                  value={practiceAreaId}
                  onChange={(e) => setPracticeAreaId(e.target.value)}
                >
                  <option value="all">All practice areas</option>
                  {practiceAreas.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.label}
                    </option>
                  ))}
                </select>
                <select
                  id="matters-filter-status"
                  name="mattersFilterStatus"
                  aria-label="Filter by matter status"
                  className="field-select list-filter-row__select"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {matterStatuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </>
            }
            moreFiltersActiveCount={
              [
                feeEarnerFilter !== 'all',
                billingBasisFilter !== 'all',
                canViewFinance && !showPmsColumns,
              ].filter(Boolean).length
            }
            moreFiltersContent={
              <>
                <div className="field">
                  <label className="field-label" htmlFor="matter-filter-fe">
                    Lead fee earner
                  </label>
                  <select
                    id="matter-filter-fe"
                    name="mattersFilterFeeEarner"
                    aria-label="Filter by lead fee earner"
                    className="field-select"
                    value={feeEarnerFilter}
                    onChange={(e) => setFeeEarnerFilter(e.target.value)}
                  >
                    <option value="all">All fee earners</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {personDisplayName(emp)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="matter-filter-billing">
                    Billing basis
                  </label>
                  <select
                    id="matter-filter-billing"
                    name="mattersFilterBillingBasis"
                    aria-label="Filter by billing basis"
                    className="field-select"
                    value={billingBasisFilter}
                    onChange={(e) => setBillingBasisFilter(e.target.value)}
                  >
                    <option value="all">All billing bases</option>
                    {billingBases.map((bb) => (
                      <option key={bb.id} value={bb.id}>
                        {bb.label}
                      </option>
                    ))}
                  </select>
                </div>
                {canViewFinance ? (
                  <div className="field">
                    <label className="checkbox-pill" style={{ cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={showPmsColumns}
                        onChange={(e) => setShowPmsColumns(e.target.checked)}
                      />
                      <span>Show PMS financials (as at {formatPmsAsAtLabel(pmsAsAtDate)})</span>
                    </label>
                  </div>
                ) : null}
              </>
            }
            activeChips={[
              ...(practiceAreaId !== 'all'
                ? [
                    {
                      key: 'practiceArea',
                      label: 'Practice area',
                      valueLabel: resolveLabel(values, practiceAreaId),
                      onRemove: () => setPracticeAreaId('all'),
                    } satisfies ActiveFilterChipItem,
                  ]
                : []),
              ...(statusFilter !== 'all'
                ? [
                    {
                      key: 'status',
                      label: 'Status',
                      valueLabel: resolveLabel(values, statusFilter),
                      onRemove: () => setStatusFilter('all'),
                    } satisfies ActiveFilterChipItem,
                  ]
                : []),
              ...(feeEarnerFilter !== 'all'
                ? [
                    {
                      key: 'feeEarner',
                      label: 'Fee earner',
                      valueLabel: (() => {
                        const fe = people.find((p) => p.id === feeEarnerFilter);
                        return fe ? personDisplayName(fe) : feeEarnerFilter;
                      })(),
                      onRemove: () => setFeeEarnerFilter('all'),
                    } satisfies ActiveFilterChipItem,
                  ]
                : []),
              ...(billingBasisFilter !== 'all'
                ? [
                    {
                      key: 'billingBasis',
                      label: 'Billing basis',
                      valueLabel: resolveLabel(values, billingBasisFilter),
                      onRemove: () => setBillingBasisFilter('all'),
                    } satisfies ActiveFilterChipItem,
                  ]
                : []),
            ]}
            onClearAll={() => {
              setPracticeAreaId('all');
              setStatusFilter('all');
              setFeeEarnerFilter('all');
              setBillingBasisFilter('all');
              setQuery('');
            }}
            density={density}
            onDensityChange={setDensity}
          />

          <DataList
            columns={columns}
            rows={filteredMatters}
            getRowId={(m) => m.id}
            getRowUrgency={getMatterUrgency}
            onRowClick={(m) => router.push(`/matters/${m.id}`)}
            sort={sort}
            onSortChange={setSort}
            defaultSortLabel="Default order"
            density={density}
            emptyMessage="No matters match the selected view and filters."
            ariaLabel="Matters list"
            renderMobileCard={(m) => {
              const clientLabel = clientNameMap.get(m.clientId) ?? m.clientId;
              const statusLabel = resolveLabel(values, m.matterStatusId) || 'Active';
              const isCmiIncomplete =
                statusLabel === 'CMI incomplete' ||
                m.amlStatus === 'CMI incomplete' ||
                m.amlStatus === 'Pending';
              const pillLabel = m.conflictCheckStatus.toLowerCase().includes('conflict')
                ? 'Conflict flagged'
                : isCmiIncomplete
                  ? 'CMI incomplete'
                  : statusLabel;
              const pillTone: PillTone = m.conflictCheckStatus.toLowerCase().includes('conflict')
                ? 'alert'
                : isCmiIncomplete
                  ? 'warning'
                  : matterStatusTone(statusLabel);
              const earner = people.find((p) => p.id === m.leadFeeEarnerId);
              const earnerLabel = earner ? personDisplayName(earner) : '';
              return (
                <>
                  <div className="data-list__card-top">
                    <Link href={`/matters/${m.id}`} style={{ fontWeight: 600 }}>
                      {m.title}
                    </Link>
                    <StatusPill label={pillLabel} tone={pillTone} />
                  </div>
                  <div className="data-list__card-summary">
                    {m.matterNumber} · {clientLabel}
                  </div>
                  <div className="data-list__card-footer">
                    <RelativeTime value={m.openedAt || m.createdAt} />
                    <span>·</span>
                    <PersonChip name={earnerLabel} emptyLabel="Unassigned" />
                  </div>
                </>
              );
            }}
          />
    </div>
  );
}
