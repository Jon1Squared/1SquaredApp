import type { EnquiryStatus, QuoteStatus } from './types';

export type PillTone = 'warning' | 'alert' | 'positive' | 'neutral';
export type UrgencyEdgeKind = 'emergency' | 'urgent' | null;

/**
 * Shared urgency pill colour mapping.
 * Emergency -> red-tint alert pill; Urgent -> amber warning pill; Standard -> neutral.
 */
export function urgencyTone(label: string | null | undefined): PillTone {
  const l = (label ?? '').toLowerCase();
  if (l.includes('emergency')) return 'alert';
  if (l.includes('urgent')) return 'warning';
  return 'neutral';
}

/**
 * Returns true only for Emergency and Urgent urgencies.
 * Normal/Standard urgency shows no badge in compact list rows.
 */
export function isExceptionalUrgencyLabel(label: string | null | undefined): boolean {
  const l = (label ?? '').toLowerCase();
  return l.includes('emergency') || l.includes('urgent');
}

/**
 * Drives the 4px left-edge indicator on list rows for Emergency and Urgent items.
 */
export function urgencyEdgeKind(label: string | null | undefined): UrgencyEdgeKind {
  const l = (label ?? '').toLowerCase();
  if (l.includes('emergency')) return 'emergency';
  if (l.includes('urgent')) return 'urgent';
  return null;
}

/**
 * Shared enquiry status pill colour mapping.
 */
export function enquiryStatusTone(status: EnquiryStatus | string): PillTone {
  if (status === 'Converted' || status === 'In contact') return 'positive';
  if (status === 'New' || status === 'Draft') return 'warning';
  return 'neutral';
}

/**
 * Shared quote status pill colour mapping.
 */
export function quoteStatusTone(status: QuoteStatus | string): PillTone {
  if (status === 'Accepted' || status === 'Sent') return 'positive';
  if (status === 'Follow-up due' || status === 'Draft') return 'warning';
  return 'neutral';
}
