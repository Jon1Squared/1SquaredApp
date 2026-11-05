/**
 * Placeholder expression parser and formatting filters (`core/src/domain/document-generation/filters.ts`).
 *
 * Supported filters (ADR-0007):
 * - `date` (e.g. `{{ matter.openDate | date:"d MMMM yyyy" }}`)
 * - `currency` (e.g. `{{ financial.feeEstimate | currency }}` -> `£15,000.00`)
 * - `upper` (uppercase)
 * - `title` (Title Case)
 * - `words` (amount or number in English words)
 * - `address_single` (single-line comma-separated address)
 * - `address_multi` (multi-line newline-separated address, rendered as `<w:br/>` in Word)
 */

import type {
  PlaceholderFilterName,
  StructuredAddressValue,
} from '../../api/index';

const VALID_FILTERS = new Set<PlaceholderFilterName>([
  'date',
  'currency',
  'upper',
  'title',
  'words',
  'address_single',
  'address_multi',
]);

export interface ParsedPlaceholderToken {
  identifier: string;
  inlineFilter?: {
    name: PlaceholderFilterName;
    arg?: string;
  };
  invalidFilterName?: string;
}

/**
 * Parses the inner expression of `{{ ... }}`, e.g.:
 * - `matter.reference`
 * - `matter.openDate | date:"d MMMM yyyy"`
 * - `financial.feeEstimate | currency`
 */
export function parsePlaceholderExpression(
  rawInner: string,
): ParsedPlaceholderToken {
  const trimmed = rawInner.trim();
  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx === -1) {
    return { identifier: trimmed };
  }

  const identifier = trimmed.slice(0, pipeIdx).trim();
  const filterSpec = trimmed.slice(pipeIdx + 1).trim();
  const colonIdx = filterSpec.indexOf(':');

  let filterNameRaw = filterSpec;
  let filterArg: string | undefined;

  if (colonIdx !== -1) {
    filterNameRaw = filterSpec.slice(0, colonIdx).trim();
    const rawArg = filterSpec.slice(colonIdx + 1).trim();
    filterArg = rawArg.replace(/^["']|["']$/g, '');
  }

  const normalisedFilter = filterNameRaw.toLowerCase() as PlaceholderFilterName;
  if (!VALID_FILTERS.has(normalisedFilter)) {
    return {
      identifier,
      invalidFilterName: filterNameRaw,
    };
  }

  return {
    identifier,
    inlineFilter: {
      name: normalisedFilter,
      arg: filterArg,
    },
  };
}

const MONTH_NAMES_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatDateValue(
  value: unknown,
  pattern = 'd MMMM yyyy',
): string {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value).trim();
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T00:00:00Z` : str,
  );
  if (Number.isNaN(parsed.getTime())) {
    return str;
  }

  const day = parsed.getUTCDate();
  const dd = String(day).padStart(2, '0');
  const monthIdx = parsed.getUTCMonth();
  const mm = String(monthIdx + 1).padStart(2, '0');
  const yyyy = String(parsed.getUTCFullYear());
  const mmmm = MONTH_NAMES_FULL[monthIdx] ?? '';
  const mmm = MONTH_NAMES_SHORT[monthIdx] ?? '';

  switch (pattern.trim()) {
    case 'dd/MM/yyyy':
      return `${dd}/${mm}/${yyyy}`;
    case 'yyyy-MM-dd':
      return `${yyyy}-${mm}-${dd}`;
    case 'd MMM yyyy':
      return `${day} ${mmm} ${yyyy}`;
    case 'dd MMMM yyyy':
      return `${dd} ${mmmm} ${yyyy}`;
    case 'd MMMM yyyy':
    default:
      return `${day} ${mmmm} ${yyyy}`;
  }
}

export function formatCurrencyGbp(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const cleaned =
    typeof value === 'number'
      ? value
      : Number.parseFloat(String(value).replace(/[£,\s]/g, ''));
  if (Number.isNaN(cleaned)) {
    return String(value);
  }
  const negative = cleaned < 0;
  const abs = Math.abs(cleaned);
  const [whole, decimals = '00'] = abs.toFixed(2).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}£${withCommas}.${decimals}`;
}

export function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function integerToWordsUnderThousand(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) {
    const ten = Math.floor(n / 10);
    const rem = n % 10;
    return rem === 0 ? `${TENS[ten]}` : `${TENS[ten]}-${ONES[rem]}`;
  }
  const hundred = Math.floor(n / 100);
  const rem = n % 100;
  return rem === 0
    ? `${ONES[hundred]} hundred`
    : `${ONES[hundred]} hundred and ${integerToWordsUnderThousand(rem)}`;
}

export function integerToEnglishWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  const rounded = Math.floor(Math.abs(n));
  if (rounded === 0) return 'zero';

  const parts: string[] = [];
  const millions = Math.floor(rounded / 1_000_000);
  const thousands = Math.floor((rounded % 1_000_000) / 1_000);
  const remainder = rounded % 1_000;

  if (millions > 0) {
    parts.push(`${integerToWordsUnderThousand(millions)} million`);
  }
  if (thousands > 0) {
    parts.push(`${integerToWordsUnderThousand(thousands)} thousand`);
  }
  if (remainder > 0) {
    if (parts.length > 0 && remainder < 100) {
      parts.push(`and ${integerToWordsUnderThousand(remainder)}`);
    } else {
      parts.push(integerToWordsUnderThousand(remainder));
    }
  }

  const joined = parts.join(' ');
  return n < 0 ? `minus ${joined}` : joined;
}

export function formatAmountInWords(
  value: unknown,
  isCurrency = true,
): string {
  if (value === null || value === undefined || value === '') return '';
  const num =
    typeof value === 'number'
      ? value
      : Number.parseFloat(String(value).replace(/[£,\s]/g, ''));
  if (Number.isNaN(num)) return String(value);

  const abs = Math.abs(num);
  const whole = Math.floor(abs + 1e-9);
  const pence = Math.round((abs - whole) * 100);

  if (!isCurrency && pence === 0) {
    return integerToEnglishWords(num);
  }

  const poundsWords = integerToEnglishWords(whole);
  const poundUnit = whole === 1 ? 'pound' : 'pounds';

  if (pence === 0) {
    return `${poundsWords} ${poundUnit}`;
  }

  const penceWords = integerToEnglishWords(pence);
  const penceUnit = pence === 1 ? 'penny' : 'pence';
  return `${poundsWords} ${poundUnit} and ${penceWords} ${penceUnit}`;
}

export function extractAddressLines(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'object') {
    const addr = value as StructuredAddressValue;
    return [
      addr.line1,
      addr.line2,
      addr.city,
      addr.county,
      addr.postcode,
      addr.country && addr.country !== 'United Kingdom'
        ? addr.country
        : undefined,
    ]
      .map((s) => (s ? String(s).trim() : ''))
      .filter(Boolean);
  }
  return [String(value)];
}

export function applyPlaceholderFilter(
  rawValue: unknown,
  filterName?: PlaceholderFilterName,
  filterArg?: string,
): string {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return '';
  }

  switch (filterName) {
    case 'date':
      return formatDateValue(rawValue, filterArg || 'd MMMM yyyy');
    case 'currency':
      return formatCurrencyGbp(rawValue);
    case 'upper':
      return String(rawValue).toUpperCase();
    case 'title':
      return toTitleCase(String(rawValue));
    case 'words':
      return formatAmountInWords(rawValue, true);
    case 'address_single':
      return extractAddressLines(rawValue).join(', ');
    case 'address_multi':
      return extractAddressLines(rawValue).join('\n');
    default: {
      if (typeof rawValue === 'object') {
        return extractAddressLines(rawValue).join(', ');
      }
      return String(rawValue);
    }
  }
}
