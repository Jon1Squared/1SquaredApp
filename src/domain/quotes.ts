/**
 * Domain rules for Quotes and the combined Enquiries & Quotes intake queue:
 * calculations, automatic status transitions (Follow-up due, Expired),
 * tab filtering, and 3-tier default queue ordering.
 */
import {
  calculateVatMinorUnits,
  type FeeArrangementBasis,
  minorUnitsToPounds,
  percentToBasisPoints,
  poundsToMinorUnits,
  sumMinorUnits,
} from '@platform/core-api';
import { addDays, toIsoDate } from './dates';
import { type EnquiriesQueueTab, urgencyRank } from './enquiries';
import { resolveLabel } from './lists';
import { personDisplayName } from './names';
import type {
  ChoiceValue,
  Enquiry,
  Organisation,
  Person,
  Quote,
  QuoteDeclineReason,
  QuoteDisbursement,
  QuoteFeeBasis,
  QuoteStatus,
} from './types';

export const QUOTE_FEE_BASES: QuoteFeeBasis[] = [
  'Fixed fee',
  'Estimate',
  'Capped fee',
  'Hourly rate with estimate',
  'Conditional fee agreement (CFA)',
  'Damages-based agreement (DBA)',
];

export function mapQuoteFeeBasisToArrangementBasis(
  feeBasis: QuoteFeeBasis | string | null | undefined,
): FeeArrangementBasis | null {
  if (feeBasis === 'Conditional fee agreement (CFA)') {
    return 'conditional_fee_agreement';
  }
  if (feeBasis === 'Damages-based agreement (DBA)') {
    return 'damages_based_agreement';
  }
  return null;
}

export const QUOTE_DECLINE_REASONS: QuoteDeclineReason[] = [
  'Price',
  'Timing',
  'Instructed another firm',
  'No longer needed',
  'Other',
];

export const OPEN_QUOTE_STATUSES = new Set<QuoteStatus>(['Sent', 'Follow-up due']);

export const CLOSED_QUOTE_STATUSES = new Set<QuoteStatus>([
  'Accepted',
  'Declined',
  'Expired',
  'Superseded',
]);

function toNonNegativeMinorUnits(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num < 1e-6) return 0;
  const raw = String(num);
  if (/[eE]/.test(raw)) {
    return poundsToMinorUnits(num.toFixed(4));
  }
  return poundsToMinorUnits(raw);
}

export function roundCurrency(value: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (Math.abs(num) < 1e-6) return 0;
  const raw = String(num);
  if (/[eE]/.test(raw)) {
    return minorUnitsToPounds(poundsToMinorUnits(num.toFixed(4)));
  }
  return minorUnitsToPounds(poundsToMinorUnits(raw));
}

export function formatGbp(amount: number | null | undefined, includePence = false): string {
  const num = Number(amount ?? 0);
  if (!Number.isFinite(num)) return '£0';
  const hasDecimals = Math.abs(num - Math.round(num)) > 0.001;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: includePence || hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(num);
}

export interface QuoteTotals {
  feeAmountExVat: number;
  vatOnFee: number;
  disbursementsExVat: number;
  vatOnDisbursements: number;
  totalExVat: number;
  totalVat: number;
  totalIncVat: number;
}

/**
 * Calculate VAT and totals for a quote using exact integer minor units (pence).
 * Supports per-quote VAT rate (default 20%) and per-disbursement VAT overrides.
 */
export function calculateQuoteTotals(
  feeAmountExVat: number,
  vatOnFee: number | null | undefined,
  disbursements: QuoteDisbursement[] = [],
  vatRatePercent = 20,
): QuoteTotals {
  const safeVatPercent =
    typeof vatRatePercent === 'number' &&
    Number.isFinite(vatRatePercent) &&
    vatRatePercent >= 0
      ? vatRatePercent
      : 20;
  const vatBasisPoints = percentToBasisPoints(safeVatPercent);
  const feeExMinor = toNonNegativeMinorUnits(feeAmountExVat);
  const feeVatMinor =
    vatOnFee !== null && vatOnFee !== undefined && Number.isFinite(Number(vatOnFee))
      ? toNonNegativeMinorUnits(vatOnFee)
      : calculateVatMinorUnits(feeExMinor, vatBasisPoints);

  const disbExMinorList: number[] = [];
  const disbVatMinorList: number[] = [];

  for (const d of disbursements) {
    const amtMinor = toNonNegativeMinorUnits(d.amountExVat);
    disbExMinorList.push(amtMinor);
    if (
      d.vatOverridden &&
      d.vatAmount !== undefined &&
      d.vatAmount !== null &&
      Number.isFinite(Number(d.vatAmount))
    ) {
      disbVatMinorList.push(toNonNegativeMinorUnits(d.vatAmount));
    } else if (d.vatApplicable) {
      disbVatMinorList.push(calculateVatMinorUnits(amtMinor, vatBasisPoints));
    }
  }

  const disbExMinor = sumMinorUnits(disbExMinorList);
  const disbVatMinor = sumMinorUnits(disbVatMinorList);
  const totalExMinor = sumMinorUnits([feeExMinor, disbExMinor]);
  const totalVatMinor = sumMinorUnits([feeVatMinor, disbVatMinor]);
  const totalIncMinor = sumMinorUnits([totalExMinor, totalVatMinor]);

  return {
    feeAmountExVat: minorUnitsToPounds(feeExMinor),
    vatOnFee: minorUnitsToPounds(feeVatMinor),
    disbursementsExVat: minorUnitsToPounds(disbExMinor),
    vatOnDisbursements: minorUnitsToPounds(disbVatMinor),
    totalExVat: minorUnitsToPounds(totalExMinor),
    totalVat: minorUnitsToPounds(totalVatMinor),
    totalIncVat: minorUnitsToPounds(totalIncMinor),
  };
}

/**
 * Evaluate the effective status of a quote given the current date:
 * - When the valid-until date passes with no outcome on a Sent / Follow-up due quote -> 'Expired'
 * - When the follow-up date passes on a Sent quote -> 'Follow-up due'
 */
export function evaluateQuoteEffectiveStatus(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): QuoteStatus {
  const todayYmd = toIsoDate(now);
  if (quote.status === 'Sent' || quote.status === 'Follow-up due') {
    if (quote.validUntil && quote.validUntil < todayYmd) {
      return 'Expired';
    }
    if (
      quote.status === 'Sent' &&
      quote.nextFollowUpDate &&
      quote.nextFollowUpDate <= todayYmd
    ) {
      return 'Follow-up due';
    }
  }
  return quote.status;
}

export function isQuoteOpen(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  const eff = evaluateQuoteEffectiveStatus(quote, now);
  return OPEN_QUOTE_STATUSES.has(eff);
}

export function isQuoteClosed(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  const eff = evaluateQuoteEffectiveStatus(quote, now);
  return CLOSED_QUOTE_STATUSES.has(eff);
}

/**
 * True when an open quote (Sent or Follow-up due) has a follow-up date on or before today
 * (or strictly before today for overdue).
 * We treat nextFollowUpDate < todayYmd (or status === 'Follow-up due' with nextFollowUpDate <= todayYmd)
 * as having an overdue / due follow-up.
 */
export function isQuoteFollowUpOverdue(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  const eff = evaluateQuoteEffectiveStatus(quote, now);
  if (eff !== 'Sent' && eff !== 'Follow-up due') return false;
  if (!quote.nextFollowUpDate) return eff === 'Follow-up due';
  const todayYmd = toIsoDate(now);
  return quote.nextFollowUpDate < todayYmd || (eff === 'Follow-up due' && quote.nextFollowUpDate <= todayYmd);
}

export function isQuoteFollowUpDueToday(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  const eff = evaluateQuoteEffectiveStatus(quote, now);
  if (eff !== 'Sent' && eff !== 'Follow-up due') return false;
  if (!quote.nextFollowUpDate) return false;
  const todayYmd = toIsoDate(now);
  return quote.nextFollowUpDate === todayYmd;
}

export function isQuoteFollowUpDueThisWeek(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  const eff = evaluateQuoteEffectiveStatus(quote, now);
  if (eff !== 'Sent' && eff !== 'Follow-up due') return false;
  if (!quote.nextFollowUpDate) return false;
  const todayYmd = toIsoDate(now);
  const weekEndYmd = toIsoDate(addDays(now, 7));
  return quote.nextFollowUpDate >= todayYmd && quote.nextFollowUpDate <= weekEndYmd;
}

export function isQuoteExpired(
  quote: Pick<Quote, 'status' | 'validUntil' | 'nextFollowUpDate'>,
  now: Date = new Date(),
): boolean {
  return evaluateQuoteEffectiveStatus(quote, now) === 'Expired';
}

export function quoteClientDisplayName(
  quote: Pick<
    Quote,
    | 'linkedOrganisationId'
    | 'linkedPersonId'
    | 'prospectName'
    | 'prospectOrganisationName'
  >,
  people: Person[],
  organisations: Organisation[],
): string {
  const org = quote.linkedOrganisationId
    ? organisations.find((o) => o.id === quote.linkedOrganisationId)
    : null;
  const person = quote.linkedPersonId
    ? people.find((p) => p.id === quote.linkedPersonId)
    : null;

  const pName = person ? personDisplayName(person) : quote.prospectName.trim();
  const oName = org ? org.legalName : quote.prospectOrganisationName.trim();

  if (pName && oName && pName.toLowerCase() !== oName.toLowerCase()) {
    return `${pName} (${oName})`;
  }
  return oName || pName || 'Unnamed prospect';
}

export function quoteWorkTypeSummary(quote: Quote, values: ChoiceValue[]): string {
  const pa = quote.practiceAreaId ? resolveLabel(values, quote.practiceAreaId) : '';
  const sub = quote.workTypeSubcategoryId
    ? resolveLabel(values, quote.workTypeSubcategoryId)
    : '';
  return sub || pa || 'Legal services';
}

/**
 * Filter quotes for a tab on the combined Enquiries & Quotes list.
 */
export function filterQuotesForTab(
  quotes: Quote[],
  tab: EnquiriesQueueTab,
  currentUserId: string,
  myTeamIds: Set<string>,
  now: Date = new Date(),
): Quote[] {
  if (tab === 'drafts') {
    return quotes.filter(
      (q) =>
        evaluateQuoteEffectiveStatus(q, now) === 'Draft' &&
        (!currentUserId || q.feeEarnerId === currentUserId || q.createdById === currentUserId),
    );
  }
  if (tab === 'open_quotes') {
    return quotes.filter((q) => isQuoteOpen(q, now));
  }
  if (tab === 'team') {
    return quotes.filter(
      (q) =>
        isQuoteOpen(q, now) &&
        Boolean(q.assignedTeamId) &&
        (myTeamIds.size === 0 || myTeamIds.has(q.assignedTeamId!)),
    );
  }
  if (tab === 'mine') {
    return quotes.filter((q) => isQuoteOpen(q, now) && q.feeEarnerId === currentUserId);
  }
  if (tab === 'open') {
    return quotes.filter((q) => isQuoteOpen(q, now));
  }
  // 'closed'
  return quotes.filter((q) => isQuoteClosed(q, now));
}

export type IntakeQueueRow =
  | { kind: 'enquiry'; id: string; enquiry: Enquiry }
  | { kind: 'quote'; id: string; quote: Quote };

/**
 * Combined intake queue ordering:
 * 1. Urgent and emergency enquiries (Emergency first, then Urgent, oldest first)
 * 2. Quotes with overdue follow-ups, most overdue first
 * 3. Everything else, oldest first
 */
export function sortIntakeQueue(
  rows: IntakeQueueRow[],
  values: ChoiceValue[],
  now: Date = new Date(),
): IntakeQueueRow[] {
  const getTier = (row: IntakeQueueRow): 1 | 2 | 3 => {
    if (row.kind === 'enquiry') {
      const rank = urgencyRank(row.enquiry.urgencyId, values);
      if (rank === 0 || rank === 1) return 1;
      return 3;
    }
    if (isQuoteFollowUpOverdue(row.quote, now)) {
      return 2;
    }
    return 3;
  };

  const getTimestamp = (row: IntakeQueueRow): number => {
    const iso = row.kind === 'enquiry' ? row.enquiry.receivedAt : row.quote.createdAt;
    return new Date(iso).getTime();
  };

  return [...rows].sort((a, b) => {
    const tierA = getTier(a);
    const tierB = getTier(b);
    if (tierA !== tierB) return tierA - tierB;

    if (tierA === 1 && a.kind === 'enquiry' && b.kind === 'enquiry') {
      const rA = urgencyRank(a.enquiry.urgencyId, values);
      const rB = urgencyRank(b.enquiry.urgencyId, values);
      if (rA !== rB) return rA - rB;
      return getTimestamp(a) - getTimestamp(b);
    }

    if (tierA === 2 && a.kind === 'quote' && b.kind === 'quote') {
      // Most overdue first -> earliest nextFollowUpDate first
      const fA = a.quote.nextFollowUpDate
        ? new Date(a.quote.nextFollowUpDate).getTime()
        : 0;
      const fB = b.quote.nextFollowUpDate
        ? new Date(b.quote.nextFollowUpDate).getTime()
        : 0;
      if (fA !== fB) return fA - fB;
      return getTimestamp(a) - getTimestamp(b);
    }

    return getTimestamp(a) - getTimestamp(b);
  });
}
