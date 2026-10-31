'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search as SearchIcon, X } from 'lucide-react';
import { type MatchRange, type SearchDoc, type SearchHit, search, segments } from '@/domain/search';

export function HighlightedText({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts = segments(text, ranges);
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i}>{p.text}</mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </>
  );
}

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'warning' | 'alert' | 'positive' | 'neutral';
}) {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}

export function SearchResultRow({
  hit,
  active,
  onSelect,
  id,
}: {
  hit: SearchHit;
  active: boolean;
  onSelect?: () => void;
  id?: string;
}) {
  const href =
    hit.doc.type === 'person'
      ? `/people/${hit.doc.id}`
      : hit.doc.type === 'matter'
        ? `/matters/${hit.doc.id}`
        : hit.doc.type === 'enquiry'
          ? `/enquiries/${hit.doc.id}`
          : hit.doc.type === 'task'
            ? `/tasks/${hit.doc.id}`
            : `/organisations/${hit.doc.id}`;
  return (
    <Link
      id={id}
      href={href}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={`list-row search-result-row ${active ? 'search-result-row--active' : ''}`}
    >
      <div className="list-row__main">
        <div className="list-row__title">
          <HighlightedText text={hit.doc.title} ranges={hit.titleRanges} />
        </div>
        <div className="list-row__meta">
          <span>{hit.doc.subtitle}</span>
          {hit.doc.status ? <span> · {hit.doc.status}</span> : null}
          {hit.matchedField ? (
            <span className="matched-field-chip">
              {' · '}
              {hit.matchedField.label}:{' '}
              <HighlightedText
                text={hit.matchedField.text}
                ranges={hit.matchedField.ranges}
              />
            </span>
          ) : null}
        </div>
      </div>
      <div className="list-row__aside">
        {hit.doc.pills.map((p, idx) => (
          <StatusPill key={idx} label={p.label} tone={p.tone} />
        ))}
      </div>
    </Link>
  );
}

export function CompactHeaderSearch({
  searchIndex,
  variant = 'compact',
}: {
  searchIndex: SearchDoc[];
  variant?: 'compact' | 'hero';
}) {
  const router = useRouter();
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => search(searchIndex, query, 5), [searchIndex, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.ordered.length) {
        setActiveIndex((i) => (i + 1) % results.ordered.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.ordered.length) {
        setActiveIndex((i) => (i - 1 + results.ordered.length) % results.ordered.length);
      }
    } else if (e.key === 'Enter' && results.ordered[activeIndex]) {
      e.preventDefault();
      const target = results.ordered[activeIndex].doc;
      setOpen(false);
      setQuery('');
      router.push(
        target.type === 'person'
          ? `/people/${target.id}`
          : target.type === 'matter'
            ? `/matters/${target.id}`
            : target.type === 'enquiry'
              ? `/enquiries/${target.id}`
              : target.type === 'task'
                ? `/tasks/${target.id}`
                : `/organisations/${target.id}`,
      );
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
          type="search"
          role="combobox"
          aria-expanded={open && query.trim().length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          placeholder="Search or ask anything"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={isHero ? 'hero-search-input' : 'compact-search__input'}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            className="compact-search__clear"
            onClick={() => setQuery('')}
          >
            <X size={isHero ? 18 : 15} />
          </button>
        ) : null}
      </div>

      {open && query.trim().length > 0 ? (
        <div id={listboxId} role="listbox" className="compact-search__dropdown">
          {results.ordered.length === 0 ? (
            <div className="compact-search__empty">
              No enquiries, tasks, matters, people or organisations match &ldquo;{query}&rdquo;
            </div>
          ) : (
            <>
              {results.enquiries.length > 0 && (
                <div className="search-group">
                  <div className="section-label search-group__label">Enquiries</div>
                  {results.enquiries.map((hit) => {
                    const idx = results.ordered.indexOf(hit);
                    return (
                      <SearchResultRow
                        key={hit.doc.id}
                        hit={hit}
                        active={idx === activeIndex}
                        onSelect={() => {
                          setOpen(false);
                          setQuery('');
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {results.tasks.length > 0 && (
                <div className="search-group">
                  <div className="section-label search-group__label">Tasks</div>
                  {results.tasks.map((hit) => {
                    const idx = results.ordered.indexOf(hit);
                    return (
                      <SearchResultRow
                        key={hit.doc.id}
                        hit={hit}
                        active={idx === activeIndex}
                        onSelect={() => {
                          setOpen(false);
                          setQuery('');
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {results.matters.length > 0 && (
                <div className="search-group">
                  <div className="section-label search-group__label">Matters</div>
                  {results.matters.map((hit) => {
                    const idx = results.ordered.indexOf(hit);
                    return (
                      <SearchResultRow
                        key={hit.doc.id}
                        hit={hit}
                        active={idx === activeIndex}
                        onSelect={() => {
                          setOpen(false);
                          setQuery('');
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {results.people.length > 0 && (
                <div className="search-group">
                  <div className="section-label search-group__label">People</div>
                  {results.people.map((hit) => {
                    const idx = results.ordered.indexOf(hit);
                    return (
                      <SearchResultRow
                        key={hit.doc.id}
                        hit={hit}
                        active={idx === activeIndex}
                        onSelect={() => {
                          setOpen(false);
                          setQuery('');
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {results.organisations.length > 0 && (
                <div className="search-group">
                  <div className="section-label search-group__label">Organisations</div>
                  {results.organisations.map((hit) => {
                    const idx = results.ordered.indexOf(hit);
                    return (
                      <SearchResultRow
                        key={hit.doc.id}
                        hit={hit}
                        active={idx === activeIndex}
                        onSelect={() => {
                          setOpen(false);
                          setQuery('');
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function HeroHomeSearch({ searchIndex }: { searchIndex: SearchDoc[] }) {
  return <CompactHeaderSearch searchIndex={searchIndex} variant="hero" />;
}
