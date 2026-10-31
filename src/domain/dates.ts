/** UK date helpers. Display format: "15 Oct 2026". */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  // Date-only strings are treated as local calendar dates.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)}, ${hh}:${mm}`;
}

/** YYYY-MM-DD for <input type="date"> and date-only storage. */
export function toIsoDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return 0;
  return Math.floor((db.getTime() - da.getTime()) / 86_400_000);
}

export function isBefore(value: string | null | undefined, ref: Date): boolean {
  const d = toDate(value);
  return !!d && d.getTime() < ref.getTime();
}

/** "3 days ago", "Today", falls back to full date after 30 days. */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return '';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((start.getTime() - dayStart.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 30) return `${diff} days ago`;
  return formatDate(d);
}

/** England & Wales bank holidays (2025-2027) for working-hours SLA calculations. */
export const EW_BANK_HOLIDAYS = new Set<string>([
  '2025-01-01',
  '2025-04-18',
  '2025-04-21',
  '2025-05-05',
  '2025-05-26',
  '2025-08-25',
  '2025-12-25',
  '2025-12-26',
  '2026-01-01',
  '2026-04-03',
  '2026-04-06',
  '2026-05-04',
  '2026-05-25',
  '2026-08-31',
  '2026-12-25',
  '2026-12-28',
  '2027-01-01',
  '2027-03-26',
  '2027-03-29',
  '2027-05-03',
  '2027-05-31',
  '2027-08-30',
  '2027-12-27',
  '2027-12-28',
]);

export interface WorkingHoursConfig {
  workDayStart: string; // e.g. "09:00"
  workDayEnd: string; // e.g. "17:30"
  workingDays: number[]; // 1..5 (Mon..Fri)
  emergencyHours: number; // default 2
}

export const DEFAULT_WORKING_HOURS: WorkingHoursConfig = {
  workDayStart: '09:00',
  workDayEnd: '17:30',
  workingDays: [1, 2, 3, 4, 5],
  emergencyHours: 2,
};

function parseHm(hm: string): { h: number; m: number; minutes: number } {
  const [hStr, mStr] = (hm || '09:00').split(':');
  const h = Number(hStr) || 0;
  const m = Number(mStr) || 0;
  return { h, m, minutes: h * 60 + m };
}

export function isWorkingDay(date: Date, workingDays: number[] = [1, 2, 3, 4, 5]): boolean {
  const dow = date.getDay();
  if (!workingDays.includes(dow)) return false;
  return !EW_BANK_HOLIDAYS.has(toIsoDate(date));
}

function nextWorkingDayStart(date: Date, cfg: WorkingHoursConfig): Date {
  const start = parseHm(cfg.workDayStart);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, start.h, start.m, 0, 0);
  while (!isWorkingDay(d, cfg.workingDays)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Add N working days and set time to end of working day (or preserve time). */
export function addWorkingDays(
  from: Date | string,
  days: number,
  cfg: WorkingHoursConfig = DEFAULT_WORKING_HOURS,
): Date {
  const base = toDate(from) ?? new Date();
  const end = parseHm(cfg.workDayEnd);
  const d = new Date(base);
  let remaining = Math.max(0, Math.round(days));
  while (!isWorkingDay(d, cfg.workingDays)) {
    d.setDate(d.getDate() + 1);
  }
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, cfg.workingDays)) {
      remaining--;
    }
  }
  d.setHours(end.h, end.m, 0, 0);
  return d;
}

/** Add N working hours within configured working hours & working days. */
export function addWorkingHours(
  from: Date | string,
  hours: number,
  cfg: WorkingHoursConfig = DEFAULT_WORKING_HOURS,
): Date {
  const base = toDate(from) ?? new Date();
  const start = parseHm(cfg.workDayStart);
  const end = parseHm(cfg.workDayEnd);
  let cursor = new Date(base);

  if (!isWorkingDay(cursor, cfg.workingDays)) {
    cursor = nextWorkingDayStart(cursor, cfg);
  } else {
    const curMin = cursor.getHours() * 60 + cursor.getMinutes();
    if (curMin < start.minutes) {
      cursor.setHours(start.h, start.m, 0, 0);
    } else if (curMin >= end.minutes) {
      cursor = nextWorkingDayStart(cursor, cfg);
    }
  }

  let minsRemaining = Math.max(1, Math.round(hours * 60));
  while (minsRemaining > 0) {
    const curMin = cursor.getHours() * 60 + cursor.getMinutes();
    const availToday = Math.max(0, end.minutes - curMin);
    if (minsRemaining <= availToday) {
      cursor.setMinutes(cursor.getMinutes() + minsRemaining);
      minsRemaining = 0;
    } else {
      minsRemaining -= availToday;
      cursor = nextWorkingDayStart(cursor, cfg);
    }
  }
  return cursor;
}

/**
 * Calculate first-contact due datetime for an enquiry based on urgency:
 * - emergency: within `emergencyHours` working hours (default 2)
 * - urgent: end of the same working day (or next working day if received after hours)
 * - standard: end of the next working day
 */
export function calculateFirstContactDue(
  receivedAt: Date | string,
  urgencyKeyOrLabel: string,
  cfg: WorkingHoursConfig = DEFAULT_WORKING_HOURS,
): string {
  const base = toDate(receivedAt) ?? new Date();
  const norm = urgencyKeyOrLabel.toLowerCase();
  const end = parseHm(cfg.workDayEnd);

  if (norm.includes('emergency')) {
    return addWorkingHours(base, cfg.emergencyHours || 2, cfg).toISOString();
  }

  if (norm.includes('urgent')) {
    const d = new Date(base);
    const curMin = d.getHours() * 60 + d.getMinutes();
    if (isWorkingDay(d, cfg.workingDays) && curMin < end.minutes) {
      d.setHours(end.h, end.m, 0, 0);
      return d.toISOString();
    }
    const next = nextWorkingDayStart(d, cfg);
    next.setHours(end.h, end.m, 0, 0);
    return next.toISOString();
  }

  // Standard: end of the next working day
  return addWorkingDays(base, 1, cfg).toISOString();
}

/** Human-readable age string for an enquiry, e.g. "2h", "3d", "Just now". */
export function formatAge(receivedAt: string | Date, now: Date = new Date()): string {
  const d = toDate(receivedAt);
  if (!d) return '';
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Relative age string with "ago" suffix for compact list cells, e.g. "2d ago", "3h ago", "Just now". */
export function formatRelativeAge(receivedAt: string | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(receivedAt);
  if (!d) return '';
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Compact key date summary for list secondary lines, e.g. "Key date 7 Nov (19d)".
 * `isUrgentWeek` is true when the key date is 7 days or fewer away (including today/overdue).
 */
export function formatKeyDateSummary(
  keyDate: string | null | undefined,
  now: Date = new Date(),
): {
  shortDate: string;
  relativeShort: string;
  text: string;
  daysAway: number;
  isUrgentWeek: boolean;
} | null {
  const d = toDate(keyDate);
  if (!d) return null;
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startKey = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAway = Math.round((startKey.getTime() - startNow.getTime()) / 86_400_000);
  const shortDate = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const relativeShort =
    daysAway < 0
      ? `${Math.abs(daysAway)}d ago`
      : daysAway === 0
        ? 'today'
        : `${daysAway}d`;
  return {
    shortDate,
    relativeShort,
    text: `Key date ${shortDate} (${relativeShort})`,
    daysAway,
    isUrgentWeek: daysAway <= 7,
  };
}

/** Countdown label for a key date (e.g. "In 12 days", "Today", "3 days ago"). */
export function formatKeyDateCountdown(
  keyDate: string | null | undefined,
  now: Date = new Date(),
): { label: string; overdue: boolean; urgent: boolean } | null {
  const d = toDate(keyDate);
  if (!d) return null;
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startKey = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startKey.getTime() - startNow.getTime()) / 86_400_000);
  if (diffDays < 0) {
    const abs = Math.abs(diffDays);
    return { label: `${abs} ${abs === 1 ? 'day' : 'days'} ago`, overdue: true, urgent: true };
  }
  if (diffDays === 0) {
    return { label: 'Today', overdue: false, urgent: true };
  }
  if (diffDays === 1) {
    return { label: 'Tomorrow', overdue: false, urgent: true };
  }
  return {
    label: `In ${diffDays} days`,
    overdue: false,
    urgent: diffDays <= 14,
  };
}
