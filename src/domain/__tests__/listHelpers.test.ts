import { describe, expect, it } from 'vitest';
import {
  enquiryStatusTone,
  isExceptionalUrgencyLabel,
  urgencyEdgeKind,
  urgencyTone,
} from '../badges';
import { formatKeyDateSummary, formatRelativeAge } from '../dates';

describe('shared list badge and date helpers', () => {
  it('maps urgency labels to pill tones and row left-edge kinds', () => {
    expect(urgencyTone('Emergency — today')).toBe('alert');
    expect(urgencyTone('Urgent — this week')).toBe('warning');
    expect(urgencyTone('Standard')).toBe('neutral');

    expect(isExceptionalUrgencyLabel('Emergency')).toBe(true);
    expect(isExceptionalUrgencyLabel('Urgent')).toBe(true);
    expect(isExceptionalUrgencyLabel('Standard')).toBe(false);

    expect(urgencyEdgeKind('Emergency')).toBe('emergency');
    expect(urgencyEdgeKind('Urgent')).toBe('urgent');
    expect(urgencyEdgeKind('Standard')).toBeNull();
  });

  it('maps enquiry statuses to pill tones', () => {
    expect(enquiryStatusTone('In contact')).toBe('positive');
    expect(enquiryStatusTone('Converted')).toBe('positive');
    expect(enquiryStatusTone('New')).toBe('warning');
    expect(enquiryStatusTone('Draft')).toBe('warning');
    expect(enquiryStatusTone('Assigned')).toBe('neutral');
    expect(enquiryStatusTone('Declined')).toBe('neutral');
    expect(enquiryStatusTone('Referred out')).toBe('neutral');
    expect(enquiryStatusTone('No response')).toBe('neutral');
  });

  it('formats relative age with ago suffix', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    expect(formatRelativeAge('2026-10-19T11:59:30Z', now)).toBe('Just now');
    expect(formatRelativeAge('2026-10-19T11:45:00Z', now)).toBe('15m ago');
    expect(formatRelativeAge('2026-10-19T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeAge('2026-10-17T12:00:00Z', now)).toBe('2d ago');
  });

  it('formats key date summary and flags <= 7 days as urgent red-tint', () => {
    const now = new Date(2026, 9, 19); // 19 Oct 2026
    const far = formatKeyDateSummary('2026-11-07', now);
    expect(far).not.toBeNull();
    expect(far?.text).toBe('Key date 7 Nov (19d)');
    expect(far?.isUrgentWeek).toBe(false);

    const soon = formatKeyDateSummary('2026-10-24', now);
    expect(soon?.text).toBe('Key date 24 Oct (5d)');
    expect(soon?.isUrgentWeek).toBe(true);

    expect(formatKeyDateSummary(null, now)).toBeNull();
  });
});
