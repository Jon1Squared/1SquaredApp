'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';

interface InfoPopoverProps {
  /** Accessible name for the "i" button, e.g. "About the quick conflict check". */
  label: string;
  /** Heading shown at the top of the panel. */
  title: string;
  /** Short summary content. */
  children: React.ReactNode;
  /** Optional link to the full System documentation article. */
  docHref?: string;
  docLabel?: string;
  /** Which edge of the button the panel lines up with. */
  align?: 'left' | 'right';
}

/**
 * Small "i" button that opens a summary panel, with an optional link to a System documentation
 * article. Closes on outside click or Escape and returns focus to the button.
 */
export function InfoPopover({
  label,
  title,
  children,
  docHref,
  docLabel = 'Read how this works',
  align = 'left',
}: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="info-popover" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="info-popover__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={title}
          className={`info-popover__panel info-popover__panel--${align}`}
        >
          <div className="info-popover__title">{title}</div>
          <div className="info-popover__body">{children}</div>
          {docHref ? (
            <Link href={docHref} className="info-popover__link" onClick={() => setOpen(false)}>
              {docLabel} →
            </Link>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
