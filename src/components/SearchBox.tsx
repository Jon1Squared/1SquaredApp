'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search as SearchIcon, X } from 'lucide-react';
import type {
  GlobalSearchEntityType,
  GlobalSearchHit,
  GlobalSearchResponse,
} from '@platform/core';
import { searchGlobalRecordsAction } from '@/app/actions';
import type { SearchDoc } from '@/domain/search';

const ENTITY_PLURAL_LABELS: Record<GlobalSearchEntityType, string> = {
  matter: 'Matters',
  person: 'People',
  organisation: 'Organisations',
  enquiry: 'Enquiries',
  quote: 'Quotes',
  task: 'Tasks',
  document: 'Documents',
  key_date: 'Key dates',
  register_record: 'Registers',
};

const ENTITY_SINGULAR_LABELS: Record<GlobalSearchEntityType, string> = {
  matter: 'Matter',
  person: 'Person',
  organisation: 'Organisation',
  enquiry: 'Enquiry',
  quote: 'Quote',
  task: 'Task',
  document: 'Document',
  key_date: 'Key date',
  register_record: 'Register',
};

const FACET_ORDER: readonly GlobalSearchEntityType[] = [
  'matter',
  'person',
  'organisation',
  'enquiry',
  'quote',
  'task',
  'document',
  'key_date',
  'register_record',
];

const SEARCH_PAGE_SIZE = 20;
const DEBOUNCE_DELAY_MS = 200;

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'warning' | 'alert' | 'positive' | 'neutral';
}) {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = Array.from(
    new Set(
      query
        .trim()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  );
  if (terms.length === 0 || !text) {
    return <>{text}</>;
  }
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const lowerTerms = new Set(terms.map((t) => t.toLowerCase()));
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, idx) =>
        lowerTerms.has(part.toLowerCase()) ? (
          <mark key={idx} className="search-highlight">
            {part}
          </mark>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function SearchResultRow({
  hit,
  query,
  active,
  onPick,
  onHover,
}: {
  hit: GlobalSearchHit;
  query: string;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <Link
      href={hit.href}
      onClick={onPick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={active}
      className={`list-row search-result-row ${active ? 'search-result-row--active' : ''}`}
    >
      <div className="list-row__main">
        <div className="list-row__title">
          <HighlightedText text={hit.title} query={query} />
        </div>
        <div className="list-row__meta">
          <HighlightedText text={hit.subtitle} query={query} />
        </div>
      </div>
      <div className="list-row__aside">
        <span className="search-type-pill">
          {ENTITY_SINGULAR_LABELS[hit.entityType]}
        </span>
        {hit.statusLabel ? (
          <StatusPill label={hit.statusLabel} tone={hit.badgeTone} />
        ) : null}
      </div>
    </Link>
  );
}

export function CompactHeaderSearch({
  variant = 'header',
}: {
  searchIndex?: SearchDoc[];
  variant?: 'header' | 'hero';
}) {
  const router = useRouter();
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<GlobalSearchEntityType | 'all'>('all');
  const [response, setResponse] = useState<GlobalSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const runSearch = useCallback(
    async (
      rawQuery: string,
      filterType: GlobalSearchEntityType | 'all',
      offset: number,
      append: boolean,
    ) => {
      const trimmed = rawQuery.trim();
      if (trimmed.length < 2) {
        setResponse(null);
        setLoading(false);
        setLoadingMore(false);
        setErrorMessage(null);
        return;
      }

      const reqId = ++requestSeqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setErrorMessage(null);

      try {
        const res = await searchGlobalRecordsAction({
          query: rawQuery,
          entityTypes: filterType === 'all' ? undefined : [filterType],
          limit: SEARCH_PAGE_SIZE,
          offset,
        });
        if (requestSeqRef.current !== reqId) return;

        setResponse((prev) => {
          if (append && prev) {
            const seen = new Set(prev.hits.map((h) => `${h.entityType}:${h.id}`));
            const appendedHits = res.hits.filter(
              (h) => !seen.has(`${h.entityType}:${h.id}`),
            );
            return {
              ...res,
              hits: [...prev.hits, ...appendedHits],
            };
          }
          return res;
        });
        if (!append) {
          setActiveIdx(0);
        }
      } catch {
        if (requestSeqRef.current !== reqId) return;
        setErrorMessage('Search could not be completed. Please try again.');
      } finally {
        if (requestSeqRef.current === reqId) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const hits = response?.hits ?? [];
  const trimmedQuery = query.trim();
  const showDropdown = open && trimmedQuery.length > 0;

  const totalAcrossAllTypes = response
    ? FACET_ORDER.reduce((sum, key) => sum + (response.countsByType[key] ?? 0), 0)
    : 0;

  function handleQueryChange(nextValue: string) {
    setQuery(nextValue);
    setOpen(true);
    setActiveIdx(0);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (nextValue.trim().length < 2) {
      ++requestSeqRef.current;
      setLoading(false);
      setLoadingMore(false);
      setErrorMessage(null);
      setResponse(null);
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    debounceTimerRef.current = setTimeout(() => {
      void runSearch(nextValue, selectedType, 0, false);
    }, DEBOUNCE_DELAY_MS);
  }

  function handleSelectFacet(nextType: GlobalSearchEntityType | 'all') {
    setSelectedType(nextType);
    setActiveIdx(0);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (query.trim().length >= 2) {
      void runSearch(query, nextType, 0, false);
    }
  }

  function handleClear() {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    ++requestSeqRef.current;
    setQuery('');
    setSelectedType('all');
    setResponse(null);
    setLoading(false);
    setLoadingMore(false);
    setErrorMessage(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || hits.length === 0) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[activeIdx]) {
      e.preventDefault();
      setOpen(false);
      router.push(hits[activeIdx].href);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const isHero = variant === 'hero';

  return (
    <div className={isHero ? 'hero-search-wrap' : 'compact-search'} ref={wrapRef}>
      <div className={isHero ? 'hero-search-box' : 'compact-search__box'}>
        <SearchIcon
          size={isHero ? 21 : 17}
          className="compact-search__icon"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-label="Global search"
          placeholder={
            isHero
              ? 'Search people, organisations, matters, enquiries, quotes, tasks, documents, key dates or registers...'
              : 'Search people, organisations, matters, quotes, documents...'
          }
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={isHero ? 'hero-search-input' : 'compact-search__input'}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={handleClear}
            className="compact-search__clear"
          >
            <X size={15} />
          </button>
        ) : null}
      </div>

      {showDropdown ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Global search results"
          className="compact-search__dropdown"
        >
          {trimmedQuery.length < 2 ? (
            <div className="compact-search__empty">
              Enter at least two characters to search across permitted records.
            </div>
          ) : (
            <>
              {response ? (
                <div className="search-facets" role="group" aria-label="Filter results by record type">
                  <button
                    type="button"
                    onClick={() => handleSelectFacet('all')}
                    className={`search-facet-pill ${
                      selectedType === 'all' ? 'search-facet-pill--active' : ''
                    }`}
                  >
                    All ({totalAcrossAllTypes})
                  </button>
                  {FACET_ORDER.map((typeKey) => {
                    const count = response.countsByType[typeKey] ?? 0;
                    if (count === 0 && selectedType !== typeKey) {
                      return null;
                    }
                    return (
                      <button
                        key={typeKey}
                        type="button"
                        onClick={() => handleSelectFacet(typeKey)}
                        className={`search-facet-pill ${
                          selectedType === typeKey ? 'search-facet-pill--active' : ''
                        }`}
                      >
                        {ENTITY_PLURAL_LABELS[typeKey]} ({count})
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {loading ? (
                <div className="compact-search__empty" role="status">
                  Searching records...
                </div>
              ) : errorMessage ? (
                <div className="compact-search__empty" role="alert">
                  {errorMessage}
                </div>
              ) : hits.length === 0 ? (
                <div className="compact-search__empty">
                  No matching permitted records found for &ldquo;{trimmedQuery}&rdquo;.
                </div>
              ) : (
                <>
                  <div className="search-status-row">
                    Showing {hits.length} of {response?.totalCount ?? hits.length}{' '}
                    {(response?.totalCount ?? hits.length) === 1 ? 'result' : 'results'}
                  </div>
                  <div className="list-group">
                    {hits.map((hit, idx) => (
                      <SearchResultRow
                        key={`${hit.entityType}:${hit.id}`}
                        hit={hit}
                        query={trimmedQuery}
                        active={idx === activeIdx}
                        onHover={() => setActiveIdx(idx)}
                        onPick={() => setOpen(false)}
                      />
                    ))}
                  </div>
                  {response?.hasMore ? (
                    <div className="search-footer">
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() =>
                          void runSearch(query, selectedType, hits.length, true)
                        }
                        className="search-load-more"
                      >
                        {loadingMore
                          ? 'Loading more...'
                          : `Load more results (${(response.totalCount ?? 0) - hits.length} remaining)`}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function HeroHomeSearch(props: { searchIndex?: SearchDoc[] }) {
  return <CompactHeaderSearch searchIndex={props.searchIndex} variant="hero" />;
}
