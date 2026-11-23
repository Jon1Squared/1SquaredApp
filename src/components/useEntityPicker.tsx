'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { searchEntityPickerAction } from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import type {
  EntityPickerOption,
  EntityPickerSearchInput,
  EntityPickerType,
} from '@/domain/intakePreviewTypes';

export const ENTITY_PICKER_DEBOUNCE_MS = 280;

export interface UseEntityPickerOptions {
  readonly enabled?: boolean;
  readonly debounceMs?: number;
}

export interface UseEntityPickerResult {
  readonly items: EntityPickerOption[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Debounced C2 scoped entity picker hook calling `searchEntityPickerAction`
 * with monotonic sequence cancellation so stale responses are ignored.
 */
export function useEntityPicker(
  input: EntityPickerSearchInput,
  options?: UseEntityPickerOptions,
): UseEntityPickerResult {
  const enabled = options?.enabled ?? true;
  const debounceMs = options?.debounceMs ?? ENTITY_PICKER_DEBOUNCE_MS;
  const serialized = useMemo(() => JSON.stringify(input), [input]);
  const stableInput = useMemo<EntityPickerSearchInput>(
    () => JSON.parse(serialized) as EntityPickerSearchInput,
    [serialized],
  );

  const [items, setItems] = useState<EntityPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      seqRef.current += 1;
      const resetTimer = setTimeout(() => {
        setItems([]);
        setLoading(false);
        setError(null);
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    let cancelled = false;
    const seq = ++seqRef.current;

    const timer = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      void searchEntityPickerAction(stableInput)
        .then((res) => {
          if (cancelled || seq !== seqRef.current) return;
          if (isActionDenied(res)) {
            setItems([]);
            setError(res.message);
          } else {
            setItems(res.items);
            setError(null);
          }
          setLoading(false);
        })
        .catch(() => {
          if (cancelled || seq !== seqRef.current) return;
          setError('Unable to search records.');
          setLoading(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, debounceMs, stableInput]);

  return { items, loading, error };
}

export interface EntitySearchSelectProps {
  readonly id?: string;
  readonly className?: string;
  readonly entityTypes: readonly EntityPickerType[];
  readonly value: string;
  readonly onChange: (value: string, picked?: EntityPickerOption) => void;
  readonly emptyLabel: string;
  readonly initialOptions?: readonly EntityPickerOption[];
  readonly excludeIds?: readonly string[];
  readonly employeesOnly?: boolean;
  readonly nonEmployeesOnly?: boolean;
  readonly excludeDemo?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly searchPlaceholder?: string;
  readonly searchAriaLabel?: string;
  readonly autoload?: boolean;
  readonly limit?: number;
}

/**
 * Reusable `<select>` backed by debounced server-side SQL `searchEntityPickerAction`
 * (`280ms`), merging any pre-hydrated/suggested options with remote hits so
 * already-selected and suggested records remain selectable without full-directory props.
 */
export function EntitySearchSelect({
  id,
  className = 'field-select',
  entityTypes,
  value,
  onChange,
  emptyLabel,
  initialOptions = [],
  excludeIds = [],
  employeesOnly,
  nonEmployeesOnly,
  excludeDemo,
  disabled = false,
  required = false,
  searchPlaceholder = 'Filter records from directory…',
  searchAriaLabel = 'Search directory options',
  autoload = true,
  limit = 25,
}: EntitySearchSelectProps) {
  const [query, setQuery] = useState('');
  const [activated, setActivated] = useState(autoload);

  const pickerInput = useMemo<EntityPickerSearchInput>(
    () => ({
      entityTypes,
      query,
      limit,
      excludeIds,
      employeesOnly,
      nonEmployeesOnly,
      excludeDemo,
    }),
    [
      entityTypes,
      query,
      limit,
      excludeIds,
      employeesOnly,
      nonEmployeesOnly,
      excludeDemo,
    ],
  );

  const { items: remoteItems, loading } = useEntityPicker(pickerInput, {
    enabled: !disabled && (activated || query.trim().length > 0),
    debounceMs: query.trim().length > 0 ? ENTITY_PICKER_DEBOUNCE_MS : 0,
  });

  const mergedOptions = useMemo(() => {
    const byId = new Map<string, EntityPickerOption>();
    for (const opt of initialOptions) {
      byId.set(opt.id, opt);
    }
    for (const opt of remoteItems) {
      if (!byId.has(opt.id)) {
        byId.set(opt.id, opt);
      }
    }
    return Array.from(byId.values());
  }, [initialOptions, remoteItems]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        type="search"
        className="field-input"
        style={{ fontSize: 12.5, padding: '6px 10px' }}
        placeholder={searchPlaceholder}
        aria-label={searchAriaLabel}
        value={query}
        disabled={disabled}
        onFocus={() => setActivated(true)}
        onChange={(e) => {
          setActivated(true);
          setQuery(e.target.value);
        }}
      />
      <select
        id={id}
        className={className}
        value={value}
        disabled={disabled}
        required={required}
        onFocus={() => setActivated(true)}
        onChange={(e) => {
          const nextId = e.target.value;
          const picked = mergedOptions.find((o) => o.id === nextId);
          onChange(nextId, picked);
        }}
      >
        <option value="">{emptyLabel}</option>
        {mergedOptions.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
      {loading ? (
        <span className="muted" style={{ fontSize: 11.5 }}>
          Searching…
        </span>
      ) : null}
    </div>
  );
}
