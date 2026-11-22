'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';

export interface UnmappedFormErrorEntry {
  readonly key: string;
  readonly message: string;
}

/**
 * Collects server validation/opening error entries whose keys are not rendered
 * inline on currently visible fields, preserving key order and deduplicating
 * identical error messages (`R656`).
 */
export function collectUnmappedFormErrors(
  errors: Record<string, string> | null | undefined,
  mappedFieldKeys: ReadonlySet<string>,
): UnmappedFormErrorEntry[] {
  if (!errors) return [];
  const list: UnmappedFormErrorEntry[] = [];
  const seenMessages = new Set<string>();
  for (const [key, rawMsg] of Object.entries(errors)) {
    if (mappedFieldKeys.has(key)) continue;
    const message = typeof rawMsg === 'string' ? rawMsg.trim() : '';
    if (!message || seenMessages.has(message)) continue;
    seenMessages.add(message);
    list.push({ key, message });
  }
  return list;
}

export function FormServerErrorSummary({
  errors,
  title,
  dataTestId,
  containerRef,
}: {
  errors: readonly UnmappedFormErrorEntry[];
  title: string;
  dataTestId: string;
  containerRef?: React.RefObject<HTMLElement | null>;
}) {
  if (errors.length === 0) return null;

  return (
    <section
      ref={containerRef}
      role="alert"
      aria-live="assertive"
      data-testid={dataTestId}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 10,
        background: '#fef2f2',
        border: '1px solid #ef4444',
        color: '#991b1b',
        fontSize: 13.5,
        marginBottom: 14,
      }}
    >
      <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: errors.length > 1 ? 4 : 2 }}>
          {title}
        </div>
        {errors.length === 1 ? (
          <div data-error-key={errors[0]!.key}>{errors[0]!.message}</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {errors.map((entry) => (
              <li key={entry.key} data-error-key={entry.key}>
                {entry.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
