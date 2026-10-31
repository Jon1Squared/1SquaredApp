'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { formatDateTime, formatRelativeAge } from '@/domain/dates';
import { initials } from '@/domain/names';

export type DataListDensity = 'comfortable' | 'compact';
export type ColumnPriority = 1 | 2 | 3;
export type RowUrgencyEdge = 'emergency' | 'urgent' | null;

export interface DataListSortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface DataListColumn<T> {
  /** Unique column identifier. */
  id: string;
  /** Column header text. */
  header: string;
  /** CSS width for table-layout: fixed (e.g. "20%", "110px"). */
  width: string;
  /** Responsive visibility priority: 1 = always visible, 2 = hidden <1024px, 3 = hidden <1280px. */
  priority: ColumnPriority;
  /** Renders the primary line of the cell. */
  renderPrimary: (row: T) => React.ReactNode;
  /** Optional renderer for the secondary line under the primary line. */
  renderSecondary?: (row: T) => React.ReactNode;
  /** Number of lines to clamp text to (default 1 per line). */
  truncate?: 1 | 2 | boolean;
  /** Whether clicking the column header sorts by this column. */
  sortable?: boolean;
  /** Optional secondary sort target for merged columns (e.g. sorting by Age inside the Status column). */
  secondarySortable?: {
    id: string;
    header: string;
  };
  /** Native tooltip text for the cell (used when values truncate). */
  tooltip?: (row: T) => string | undefined;
  /** Keep secondary line visible even in compact density (e.g. for time-critical key dates). */
  keepSecondaryInCompact?: boolean;
  /** Optional text alignment. */
  align?: 'left' | 'right';
}

export interface ListCellProps {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  truncate?: 1 | 2 | boolean;
  tooltip?: string;
  keepSecondaryInCompact?: boolean;
}

/**
 * Two-line cell layout (primary line + optional secondary line) with line clamping and native tooltip.
 * Never exceeds two lines of text.
 */
export function ListCell({
  primary,
  secondary,
  truncate = 1,
  tooltip,
  keepSecondaryInCompact = false,
}: ListCellProps) {
  const clampClass =
    truncate === 2
      ? 'data-list-cell__line--clamp-2'
      : truncate
        ? 'data-list-cell__line--clamp-1'
        : '';

  const hasSecondary =
    secondary !== undefined && secondary !== null && secondary !== false && secondary !== '';

  return (
    <div className="data-list-cell" title={tooltip || undefined}>
      <div className={`data-list-cell__primary ${clampClass}`}>{primary}</div>
      {hasSecondary ? (
        <div
          className={`data-list-cell__secondary ${clampClass} ${
            keepSecondaryInCompact ? 'data-list-cell__secondary--keep-compact' : ''
          }`}
        >
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

export interface RelativeTimeProps {
  value: string | Date | null | undefined;
  /** Optional extra context appended to the absolute date tooltip (e.g. channel name). */
  tooltipDetail?: string;
  now?: Date;
}

/**
 * Displays relative age ("2d ago") with the absolute date/time (and optional detail) in a native tooltip.
 */
export function RelativeTime({ value, tooltipDetail, now }: RelativeTimeProps) {
  if (!value) return <span className="muted">—</span>;
  const rel = formatRelativeAge(value, now);
  const abs = formatDateTime(value);
  const title = [abs, tooltipDetail].filter(Boolean).join(' · ');
  const iso = typeof value === 'string' ? value : value.toISOString();

  return (
    <time dateTime={iso} title={title || undefined} className="relative-time">
      {rel}
    </time>
  );
}

export interface PersonChipProps {
  name?: string | null;
  emptyLabel?: string;
}

/**
 * Displays a person as a compact initials avatar + truncated name, or italic grey "Unassigned" when empty.
 */
export function PersonChip({ name, emptyLabel = 'Unassigned' }: PersonChipProps) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return <span className="person-chip__empty">{emptyLabel}</span>;
  }
  return (
    <span className="person-chip" title={trimmed}>
      <span className="person-chip__avatar" aria-hidden="true">
        {initials(trimmed)}
      </span>
      <span className="person-chip__name">{trimmed}</span>
    </span>
  );
}

/**
 * Hook to persist Comfortable / Compact list density per user in localStorage.
 */
export function useListDensity(
  userId: string,
  defaultDensity: DataListDensity = 'comfortable',
): [DataListDensity, (next: DataListDensity) => void] {
  const storageKey = `onesquared:list-density:${userId || 'default'}`;
  const [density, setDensityState] = useState<DataListDensity>(defaultDensity);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === 'compact' || saved === 'comfortable') {
        setDensityState(saved);
      }
    } catch {
      // Ignore storage access errors
    }
  }, [storageKey]);

  const setDensity = (next: DataListDensity) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Ignore storage access errors
    }
  };

  return [density, setDensity];
}

export interface DataListProps<T> {
  columns: DataListColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Optional callback returning 'emergency' | 'urgent' | null to render the 4px left urgency edge. */
  getRowUrgency?: (row: T) => RowUrgencyEdge;
  /** Currently active/selected row ID (e.g. open in the preview drawer). */
  selectedRowId?: string | null;
  /** Called when a row is clicked or activated via Enter/Space. */
  onRowClick?: (row: T) => void;
  /** Current active sort state; null means default queue order. */
  sort?: DataListSortState | null;
  /** Called when the user clicks a sortable header or resets to default order. */
  onSortChange?: (next: DataListSortState | null) => void;
  /** Label for resetting sort to default order. */
  defaultSortLabel?: string;
  /** Row density ('comfortable' ~60px or 'compact' ~44px). */
  density?: DataListDensity;
  /** Message displayed when rows is empty. */
  emptyMessage?: string;
  /** Accessible label for the table. */
  ariaLabel?: string;
  /** Optional custom mobile card renderer for viewports below 768px. */
  renderMobileCard?: (row: T) => React.ReactNode;
}

function isInteractiveTarget(target: EventTarget | null, rowEl: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const interactive = target.closest('a, button, input, select, textarea, [role="button"]');
  return Boolean(interactive && interactive !== rowEl);
}

/**
 * Generic, data-driven list component.
 * Renders a fixed-layout table above 768px (with priority-based column hiding at <1280px and <1024px)
 * and switches to a stacked card list below 768px.
 */
export function DataList<T>({
  columns,
  rows,
  getRowId,
  getRowUrgency,
  selectedRowId = null,
  onRowClick,
  sort = null,
  onSortChange,
  defaultSortLabel = 'Default order',
  density = 'comfortable',
  emptyMessage = 'No items match the current filters.',
  ariaLabel,
  renderMobileCard,
}: DataListProps<T>) {
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const lastSelectedIdRef = useRef<string | null>(null);

  // Restore focus to the row when the preview drawer closes
  useEffect(() => {
    if (selectedRowId) {
      lastSelectedIdRef.current = selectedRowId;
    } else if (lastSelectedIdRef.current) {
      const prevId = lastSelectedIdRef.current;
      lastSelectedIdRef.current = null;
      const el = rowRefs.current.get(prevId);
      if (el) {
        el.focus();
      }
    }
  }, [selectedRowId]);

  const handleHeaderSort = (colId: string) => {
    if (!onSortChange) return;
    if (!sort || sort.columnId !== colId) {
      onSortChange({ columnId: colId, direction: 'asc' });
    } else if (sort.direction === 'asc') {
      onSortChange({ columnId: colId, direction: 'desc' });
    } else {
      onSortChange(null);
    }
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLElement>, index: number, row: T) => {
    if (isInteractiveTarget(e.target, e.currentTarget)) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextRow = rows[index + 1];
      if (nextRow) {
        const nextId = getRowId(nextRow);
        rowRefs.current.get(nextId)?.focus();
        if (selectedRowId) {
          onRowClick?.(nextRow);
        }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevRow = rows[index - 1];
      if (prevRow) {
        const prevId = getRowId(prevRow);
        rowRefs.current.get(prevId)?.focus();
        if (selectedRowId) {
          onRowClick?.(prevRow);
        }
      }
    }
  };

  if (rows.length === 0) {
    return <p className="data-list__empty muted">{emptyMessage}</p>;
  }

  return (
    <div className={`data-list data-list--${density}`} data-density={density}>
      {sort && onSortChange ? (
        <div className="data-list__sort-bar">
          <span className="muted">
            Sorted by{' '}
            <strong>
              {columns.find((c) => c.id === sort.columnId)?.header ??
                columns.find((c) => c.secondarySortable?.id === sort.columnId)?.secondarySortable
                  ?.header ??
                sort.columnId}
            </strong>{' '}
            ({sort.direction === 'asc' ? 'ascending' : 'descending'})
          </span>
          <button
            type="button"
            className="data-list__sort-reset"
            onClick={() => onSortChange(null)}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {defaultSortLabel}
          </button>
        </div>
      ) : null}

      <div className="data-list__table-wrap">
        <table className="data-list__table" aria-label={ariaLabel}>
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.id}
                className={`data-list__col data-list__col--p${col.priority}`}
                style={{ width: col.width }}
              />
            ))}
          </colgroup>
          <thead>
            <tr className="data-list__head-row">
              {columns.map((col) => {
                const isSorted = sort?.columnId === col.id;
                const isSecondarySorted =
                  Boolean(col.secondarySortable) && sort?.columnId === col.secondarySortable?.id;
                const ariaSort = isSorted || isSecondarySorted
                  ? sort?.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : col.sortable
                    ? 'none'
                    : undefined;

                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={ariaSort}
                    data-priority={col.priority}
                    className={`data-list__th data-list__col--p${col.priority} ${
                      col.align === 'right' ? 'data-list__th--right' : ''
                    }`}
                    style={{ width: col.width }}
                  >
                    {col.sortable && onSortChange ? (
                      <span className="data-list__th-sort-group">
                        <button
                          type="button"
                          className={`data-list__sort-btn ${
                            isSorted ? 'data-list__sort-btn--active' : ''
                          }`}
                          onClick={() => handleHeaderSort(col.id)}
                        >
                          <span>{col.header}</span>
                          {isSorted ? (
                            sort?.direction === 'asc' ? (
                              <ArrowUp size={13} aria-hidden="true" />
                            ) : (
                              <ArrowDown size={13} aria-hidden="true" />
                            )
                          ) : (
                            <ArrowUpDown
                              size={12}
                              className="data-list__sort-icon-idle"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        {col.secondarySortable ? (
                          <>
                            <span className="data-list__th-sep" aria-hidden="true">
                              /
                            </span>
                            <button
                              type="button"
                              className={`data-list__sort-btn ${
                                isSecondarySorted ? 'data-list__sort-btn--active' : ''
                              }`}
                              onClick={() => handleHeaderSort(col.secondarySortable!.id)}
                            >
                              <span>{col.secondarySortable.header}</span>
                              {isSecondarySorted ? (
                                sort?.direction === 'asc' ? (
                                  <ArrowUp size={13} aria-hidden="true" />
                                ) : (
                                  <ArrowDown size={13} aria-hidden="true" />
                                )
                              ) : null}
                            </button>
                          </>
                        ) : null}
                      </span>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const rowId = getRowId(row);
              const urgencyEdge = getRowUrgency ? getRowUrgency(row) : null;
              const isSelected = selectedRowId === rowId;

              const rowClasses = [
                'data-list__row',
                urgencyEdge ? `data-list__row--${urgencyEdge}` : '',
                isSelected ? 'data-list__row--selected' : '',
                onRowClick ? 'data-list__row--clickable' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <tr
                  key={rowId}
                  ref={(el) => {
                    if (el) rowRefs.current.set(rowId, el);
                    else rowRefs.current.delete(rowId);
                  }}
                  tabIndex={0}
                  aria-selected={isSelected}
                  data-row-id={rowId}
                  data-urgency={urgencyEdge ?? undefined}
                  className={rowClasses}
                  onClick={(e) => {
                    if (isInteractiveTarget(e.target, e.currentTarget)) return;
                    onRowClick?.(row);
                  }}
                  onKeyDown={(e) => handleRowKeyDown(e, idx, row)}
                >
                  {columns.map((col) => {
                    const primary = col.renderPrimary(row);
                    const secondary = col.renderSecondary ? col.renderSecondary(row) : undefined;
                    const tip = col.tooltip ? col.tooltip(row) : undefined;

                    return (
                      <td
                        key={col.id}
                        data-priority={col.priority}
                        className={`data-list__td data-list__col--p${col.priority} ${
                          col.align === 'right' ? 'data-list__td--right' : ''
                        }`}
                      >
                        <ListCell
                          primary={primary}
                          secondary={secondary}
                          truncate={col.truncate ?? 1}
                          tooltip={tip}
                          keepSecondaryInCompact={col.keepSecondaryInCompact}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Stacked card layout for viewports below 768px */}
      <div className="data-list__cards" role="list" aria-label={ariaLabel}>
        {rows.map((row, idx) => {
          const rowId = getRowId(row);
          const urgencyEdge = getRowUrgency ? getRowUrgency(row) : null;
          const isSelected = selectedRowId === rowId;

          const cardClasses = [
            'data-list__card',
            urgencyEdge ? `data-list__card--${urgencyEdge}` : '',
            isSelected ? 'data-list__card--selected' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={rowId}
              role="listitem"
              tabIndex={0}
              data-row-id={rowId}
              className={cardClasses}
              onClick={(e) => {
                if (isInteractiveTarget(e.target, e.currentTarget)) return;
                onRowClick?.(row);
              }}
              onKeyDown={(e) => handleRowKeyDown(e, idx, row)}
            >
              {renderMobileCard ? (
                renderMobileCard(row)
              ) : (
                <div className="data-list__card-default">
                  <div className="data-list__card-top">
                    {columns[0]?.renderPrimary(row)}
                    {columns[2]?.renderPrimary(row)}
                  </div>
                  {columns[1] ? (
                    <div className="data-list__card-summary">
                      {columns[1].renderPrimary(row)}
                    </div>
                  ) : null}
                  <div className="data-list__card-footer">
                    {columns[3]?.renderPrimary(row)}
                    {columns[3]?.renderSecondary?.(row)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface PreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  footerActions?: React.ReactNode;
  ariaLabel?: string;
  children: React.ReactNode;
}

/**
 * Right-hand 420px preview drawer for inspecting full row detail without leaving the list.
 * Supports Escape to close and Up/Down arrow keys to step through rows while open.
 */
export function PreviewDrawer({
  open,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  title,
  subtitle,
  badges,
  footerActions,
  ariaLabel = 'Row preview',
  children,
}: PreviewDrawerProps) {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inInput = Boolean(
        target && target.closest('input, select, textarea, [contenteditable="true"]'),
      );

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (!inInput && e.key === 'ArrowDown') {
        if (hasNext && onNext) {
          e.preventDefault();
          onNext();
        }
      } else if (!inInput && e.key === 'ArrowUp') {
        if (hasPrev && onPrev) {
          e.preventDefault();
          onPrev();
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, onPrev, onNext, hasPrev, hasNext]);

  if (!open) return null;

  return (
    <aside
      className="preview-drawer"
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
    >
      <div className="preview-drawer__header">
        <div className="preview-drawer__title-wrap">
          {subtitle ? <div className="preview-drawer__subtitle">{subtitle}</div> : null}
          <h2 className="preview-drawer__title">{title}</h2>
          {badges ? <div className="preview-drawer__badges">{badges}</div> : null}
        </div>
        <div className="preview-drawer__nav">
          {onPrev || onNext ? (
            <>
              <button
                type="button"
                className="icon-btn preview-drawer__icon-btn"
                aria-label="Previous row (Up arrow)"
                title="Previous row (↑)"
                disabled={!hasPrev}
                onClick={onPrev}
              >
                <ChevronUp size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-btn preview-drawer__icon-btn"
                aria-label="Next row (Down arrow)"
                title="Next row (↓)"
                disabled={!hasNext}
                onClick={onNext}
              >
                <ChevronDown size={18} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="icon-btn preview-drawer__icon-btn"
            aria-label="Close preview (Escape)"
            title="Close preview (Esc)"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="preview-drawer__body">{children}</div>

      {footerActions ? (
        <div className="preview-drawer__footer">{footerActions}</div>
      ) : null}
    </aside>
  );
}

export function PreviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="preview-section">
      <h3 className="section-label preview-section__title">{title}</h3>
      <dl className="preview-section__grid">{children}</dl>
    </section>
  );
}

export function PreviewField({
  label,
  children,
  fullWidth = false,
}: {
  label: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div className={`preview-field ${fullWidth ? 'preview-field--full' : ''}`}>
      <dt className="preview-field__label">{label}</dt>
      <dd className="preview-field__value">{children}</dd>
    </div>
  );
}

export interface ActiveFilterChipItem {
  key: string;
  label: string;
  valueLabel: string;
  onRemove: () => void;
}

export interface DataListFilterBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  /** Visible primary filter selects (up to two selects inline on the bar). */
  primaryFilters?: React.ReactNode;
  /** Additional filter controls rendered inside the "Filters" popover. */
  moreFiltersContent?: React.ReactNode;
  /** Count of active filters inside the "Filters" popover. */
  moreFiltersActiveCount?: number;
  /** Active filter chips rendered in a removable strip below the bar. */
  activeChips?: ActiveFilterChipItem[];
  /** Clears all active filters. */
  onClearAll?: () => void;
  /** Current list density. */
  density?: DataListDensity;
  /** Updates list density. */
  onDensityChange?: (density: DataListDensity) => void;
}

/**
 * Reusable single-row list filter bar with flex-grow search, inline primary selects,
 * "Filters" popover with active badge count, removable filter chips, and density toggle.
 */
export function DataListFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  searchAriaLabel = 'Search list',
  primaryFilters,
  moreFiltersContent,
  moreFiltersActiveCount = 0,
  activeChips = [],
  onClearAll,
  density,
  onDensityChange,
}: DataListFilterBarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [popoverOpen]);

  return (
    <div className="list-toolbar">
      <div className="list-filter-row">
        <div className="list-filter-row__search">
          <input
            type="search"
            aria-label={searchAriaLabel}
            className="field-input list-filter-row__search-input"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {primaryFilters}

        {moreFiltersContent ? (
          <div className="popover-anchor" ref={popoverRef}>
            <button
              type="button"
              aria-expanded={popoverOpen}
              aria-haspopup="dialog"
              className={`btn btn--secondary list-filter-row__more-btn ${
                moreFiltersActiveCount > 0 ? 'list-filter-row__more-btn--active' : ''
              }`}
              onClick={() => setPopoverOpen((prev) => !prev)}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span>Filters</span>
              {moreFiltersActiveCount > 0 ? (
                <span
                  className="filter-count-badge"
                  aria-label={`${moreFiltersActiveCount} active hidden filters`}
                >
                  {moreFiltersActiveCount}
                </span>
              ) : null}
            </button>

            {popoverOpen ? (
              <div
                role="dialog"
                aria-label="Additional filters"
                className="popover-menu list-filter-popover"
              >
                <div className="list-filter-popover__header">
                  <span className="list-filter-popover__title">More filters</span>
                  <button
                    type="button"
                    className="icon-btn list-filter-popover__close"
                    aria-label="Close filters popover"
                    onClick={() => setPopoverOpen(false)}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
                <div className="list-filter-popover__body">{moreFiltersContent}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        {density && onDensityChange ? (
          <div className="density-toggle" role="group" aria-label="Row density">
            <button
              type="button"
              aria-pressed={density === 'comfortable'}
              className={`density-toggle__btn ${
                density === 'comfortable' ? 'density-toggle__btn--active' : ''
              }`}
              onClick={() => onDensityChange('comfortable')}
            >
              Comfortable
            </button>
            <button
              type="button"
              aria-pressed={density === 'compact'}
              className={`density-toggle__btn ${
                density === 'compact' ? 'density-toggle__btn--active' : ''
              }`}
              onClick={() => onDensityChange('compact')}
            >
              Compact
            </button>
          </div>
        ) : null}
      </div>

      {activeChips.length > 0 ? (
        <div className="list-active-chips" aria-label="Active filters">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip"
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}: ${chip.valueLabel}`}
            >
              <span className="filter-chip__label">{chip.label}:</span>
              <span className="filter-chip__value">{chip.valueLabel}</span>
              <X size={13} aria-hidden="true" />
            </button>
          ))}
          {onClearAll ? (
            <button
              type="button"
              className="filter-chips-clear"
              onClick={onClearAll}
            >
              Clear all
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


