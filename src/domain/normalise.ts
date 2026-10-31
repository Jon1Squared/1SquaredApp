/** Text normalisation used by search and duplicate matching. */

/** Lowercase, strip accents (Tŷ → ty), replace punctuation with spaces, collapse whitespace. */
export function normaliseText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9@.+\s]/g, ' ')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Like normaliseText but keeps the character count identical, for highlight mapping. */
export function foldForHighlight(input: string): string {
  let out = '';
  for (const ch of input) {
    const folded = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    // Keep a 1:1 mapping per UTF-16 unit of the original.
    out += folded.length === ch.length ? folded : folded.slice(0, ch.length).padEnd(ch.length, ' ');
  }
  return out;
}

const ORG_SUFFIXES = new Set([
  'ltd',
  'limited',
  'llp',
  'plc',
  'lp',
  'inc',
  'cyf',
  'cyfyngedig',
  'ccc',
  'company',
  'co',
  'the',
]);

/** Organisation name key: drops legal suffixes, punctuation and simple plurals. */
export function normaliseOrgName(input: string | null | undefined): string {
  const tokens = normaliseText(input)
    .replace(/@/g, ' ')
    .split(' ')
    .filter((t) => t && !ORG_SUFFIXES.has(t))
    .map(singular);
  return tokens.join(' ');
}

function singular(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function normaliseEmail(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase();
}

/** UK-centric phone key: digits only, +44 / 0044 prefix becomes 0. */
export function normalisePhone(input: string | null | undefined): string {
  let digits = (input ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('0044')) digits = '0' + digits.slice(4);
  digits = digits.replace(/\D/g, '');
  // (0) style: 44 (0)29... → 4429 handled by +44 rule; strip duplicate leading zero
  if (digits.startsWith('00')) digits = digits.slice(1);
  return digits;
}

export function normalisePostcode(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Company / VAT numbers: alphanumerics only, uppercase, leading GB removed for VAT. */
export function normaliseRegNumber(input: string | null | undefined): string {
  return (input ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase().replace(/^GB/, '');
}

export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'btinternet.com',
  'aol.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
]);

const NAME_TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'rev',
  'sir',
  'dame',
  'lord',
  'lady',
]);

const NAME_ORG_SUFFIXES = new Set([
  'ltd',
  'limited',
  'llp',
  'plc',
  'lp',
  'inc',
  'cyf',
  'cyfyngedig',
  'ccc',
  'company',
  'co',
]);

/**
 * Normalise a person or organisation name for comparison:
 * - Lower-case and trim
 * - Strip diacritics using Unicode NFD ("Tŷ" -> "ty", "Siân" -> "sian")
 * - Treat "&" and "and" as equivalent
 * - Strip organisation suffixes (Ltd, Limited, LLP, PLC, Ltd., Co)
 * - Strip titles (Mr, Mrs, Ms, Miss, Dr)
 * - Collapse hyphens and repeated spaces
 */
export function normaliseComparableName(input: string | null | undefined): string {
  if (!input) return '';
  const cleaned = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(' ')
    .filter((t) => t && !NAME_TITLES.has(t) && !NAME_ORG_SUFFIXES.has(t));
  return tokens.join(' ');
}

/** Extract the lower-cased domain part of a syntactically valid email address, or '' if invalid. */
export function extractEmailDomain(input: string | null | undefined): string {
  const email = normaliseEmail(input);
  if (!isValidEmailFormat(email)) return '';
  const atIdx = email.lastIndexOf('@');
  return atIdx >= 0 ? email.slice(atIdx + 1) : '';
}

/** Extract the last 9 digits of a phone number after stripping spaces, brackets, dashes, and leading +44/0044/0. */
export function normalisePhoneLast9(input: string | null | undefined): string {
  const digits = normalisePhone(input).replace(/^0+/, '');
  if (digits.length < 9) return '';
  return digits.slice(-9);
}

/** Check if an input has at least one token of 3+ characters after name normalisation. */
export function hasMinThreeCharToken(input: string | null | undefined): boolean {
  const norm = normaliseComparableName(input);
  if (!norm) return false;
  return norm.split(' ').some((t) => t.length >= 3);
}

/** Check if an email string is syntactically valid. */
export function isValidEmailFormat(input: string | null | undefined): boolean {
  const email = normaliseEmail(input);
  return /^[^\s@]+@[^\s@]+\.[a-z0-9]{2,}$/i.test(email);
}

/** Check if a phone string has 9+ digits after stripping prefix/punctuation. */
export function isValidPhoneForCheck(input: string | null | undefined): boolean {
  return normalisePhoneLast9(input).length >= 9;
}

/** Check if a postcode is a complete, valid UK postcode format. */
export function isValidUkPostcode(input: string | null | undefined): boolean {
  const pc = normalisePostcode(input);
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(pc);
}

/**
 * Optimal string alignment (Damerau-Levenshtein) distance: insertions, deletions,
 * substitutions and adjacent transpositions each cost 1 ("Kendal"/"Kendall" = 1, "Lsia"/"Lisa" = 1).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Edits tolerated for a name token: 0 for 1-3 chars, 1 for 4-7 chars, 2 for 8+ chars. */
export function allowedNameEdits(length: number): number {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

/** Edit distance between two tokens if within the tolerance for the shorter token, else null. */
function tokenFuzzyDistance(a: string, b: string): number | null {
  const dist = editDistance(a, b);
  return dist <= allowedNameEdits(Math.min(a.length, b.length)) ? dist : null;
}

/**
 * True when two person names are a likely misspelling of each other but NOT an exact match.
 * Compares first token with first token and last token with last token (after normaliseComparableName).
 * Requires a first name and a surname on both sides, each within tolerance, max 2 edits in total.
 * A surname on its own never fuzzy-matches, which keeps common surnames from flooding results.
 */
export function personNamesFuzzyMatch(
  query: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const q = normaliseComparableName(query).split(' ').filter(Boolean);
  const t = normaliseComparableName(target).split(' ').filter(Boolean);
  if (q.length < 2 || t.length < 2) return false;
  const firstDist = tokenFuzzyDistance(q[0]!, t[0]!);
  const lastDist = tokenFuzzyDistance(q[q.length - 1]!, t[t.length - 1]!);
  if (firstDist === null || lastDist === null) return false;
  const total = firstDist + lastDist;
  return total > 0 && total <= 2;
}

/**
 * True when two organisation names are a likely misspelling of each other but NOT an exact match
 * ("Castel Homes" vs "Castell Homes Ltd"). Compares the suffix-stripped names as whole strings.
 */
export function organisationNamesFuzzyMatch(
  query: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const q = normaliseComparableName(query);
  const t = normaliseComparableName(target);
  if (!q || !t || q === t) return false;
  const shorter = Math.min(q.replace(/ /g, '').length, t.replace(/ /g, '').length);
  if (shorter < 5) return false;
  const allowed = shorter <= 11 ? 1 : 2;
  return editDistance(q, t) <= allowed;
}

// ------------------------------------------------------------------ Sound-alike matching

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (ch: string | undefined) => Boolean(ch && VOWELS.has(ch));

/**
 * Phonetic key for a single name token, based on the Metaphone algorithm with tweaks for
 * British and Welsh names. Words that sound alike share a key:
 * Davies/Davis = "TFS", Smith/Smyth = "SM0", Rhys/Reece = "RS", Catherine/Kathryn = "K0RN",
 * Thompson/Thomson = "0MSN", Philips/Phillips = "FLPS".
 */
export function phoneticKey(input: string | null | undefined): string {
  let w = (input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w) return '';

  // Initial letter exceptions
  if (/^(kn|gn|pn|wr|ps)/.test(w)) w = w.slice(1);
  if (w.startsWith('x')) w = `s${w.slice(1)}`;
  if (w.startsWith('wh')) w = `w${w.slice(2)}`;
  if (w.startsWith('mc')) w = `mac${w.slice(2)}`;

  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const prev = w[i - 1];
    const next = w[i + 1];
    const next2 = w[i + 2];

    // Doubled letters sound once (except "cc" as in "Accra")
    if (c === prev && c !== 'c') continue;

    if (isVowel(c)) {
      // Keep the opening vowel itself so "Elin" (ELN) and "Alun" (ALN) stay distinct
      if (i === 0) out += c.toUpperCase();
      continue;
    }

    switch (c) {
      case 'b':
        if (!(prev === 'm' && i === w.length - 1)) out += 'B';
        break;
      case 'c':
        if (next === 'i' && next2 === 'a') out += 'X';
        else if (next === 'h') out += prev === 's' ? 'K' : 'X';
        else if (next === 'i' || next === 'e' || next === 'y') {
          if (prev !== 's') out += 'S';
        } else out += 'K';
        break;
      case 'd':
        if (next === 'g' && (next2 === 'e' || next2 === 'i' || next2 === 'y')) out += 'J';
        else out += 'T';
        break;
      case 'g':
        if (next === 'h' && !(i + 2 >= w.length || isVowel(next2))) break; // "Hughes", "Leigh"
        if (next === 'n' && (i + 2 === w.length || (next2 === 'e' && w[i + 3] === 'd'))) break;
        if (prev === 'g') break;
        if (next === 'e' || next === 'i' || next === 'y') out += 'J';
        else out += 'K';
        break;
      case 'h':
        // Silent after these letters, or when not followed by a vowel ("John", "Rhys")
        if (prev && 'cgpstrw'.includes(prev)) break;
        if (!isVowel(next) && next !== 'y') break;
        if (isVowel(prev) && !isVowel(next)) break;
        out += 'H';
        break;
      case 'k':
        if (prev !== 'c') out += 'K';
        break;
      case 'p':
        if (next === 'h') out += 'F';
        else if (prev === 'm' && (next === 's' || next === 't')) break; // "Thompson"
        else out += 'P';
        break;
      case 'q':
        out += 'K';
        break;
      case 's':
        if (next === 'h' || (next === 'i' && (next2 === 'o' || next2 === 'a'))) out += 'X';
        else out += 'S';
        break;
      case 't':
        if (next === 'i' && (next2 === 'o' || next2 === 'a')) out += 'X';
        else if (next === 'h') out += '0';
        else if (!(next === 'c' && next2 === 'h')) out += 'T';
        break;
      case 'v':
        out += 'F';
        break;
      case 'w':
      case 'y':
        if (isVowel(next)) out += c.toUpperCase();
        break;
      case 'x':
        out += 'KS';
        break;
      case 'z':
        out += 'S';
        break;
      default:
        out += c.toUpperCase();
    }
  }
  // Collapse repeated codes ("ck" -> K, "Kendall" -> KNTL)
  return out.replace(/(.)\1+/g, '$1');
}

/** Consonant-and-vowel skeleton for short names: drop h/w/y and collapse doubled letters. */
function shortNameSkeleton(token: string): string {
  return token.replace(/[hwy]/g, '').replace(/(.)\1+/g, '$1');
}

/**
 * Do two single name tokens sound alike? Tokens of 4+ letters compare phonetic keys.
 * Shorter tokens only match if they differ by silent letters (Jon/John) so that
 * different short names (Tim/Tom, Ian/Ann) don't match.
 */
export function tokensSoundAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return shortNameSkeleton(a) === shortNameSkeleton(b);
  const ka = phoneticKey(a);
  return ka.length >= 2 && ka === phoneticKey(b);
}

/**
 * True when two person names sound alike but are not spelt the same
 * (first token vs first token, last token vs last token). A lone surname never matches.
 */
export function personNamesSoundAlike(
  query: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const qn = normaliseComparableName(query);
  const tn = normaliseComparableName(target);
  if (!qn || !tn || qn === tn) return false;
  const q = qn.split(' ');
  const t = tn.split(' ');
  if (q.length < 2 || t.length < 2) return false;
  return tokensSoundAlike(q[0]!, t[0]!) && tokensSoundAlike(q[q.length - 1]!, t[t.length - 1]!);
}

/** True when two organisation names sound alike word-for-word but are not spelt the same. */
export function organisationNamesSoundAlike(
  query: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const qn = normaliseComparableName(query);
  const tn = normaliseComparableName(target);
  if (!qn || !tn || qn === tn) return false;
  if (qn.replace(/ /g, '').length < 5) return false;
  const q = qn.split(' ');
  const t = tn.split(' ');
  if (q.length !== t.length) return false;
  return q.every((tok, i) => tokensSoundAlike(tok, t[i]!));
}

export type LooseNameMatch = 'similar spelling' | 'sounds like';

/** Classify a non-exact person name match: misspelling first, then sound-alike. */
export function personNameLooseMatch(
  query: string | null | undefined,
  target: string | null | undefined,
): LooseNameMatch | null {
  if (personNamesFuzzyMatch(query, target)) return 'similar spelling';
  if (personNamesSoundAlike(query, target)) return 'sounds like';
  return null;
}

/** Classify a non-exact organisation name match: misspelling first, then sound-alike. */
export function organisationNameLooseMatch(
  query: string | null | undefined,
  target: string | null | undefined,
): LooseNameMatch | null {
  if (organisationNamesFuzzyMatch(query, target)) return 'similar spelling';
  if (organisationNamesSoundAlike(query, target)) return 'sounds like';
  return null;
}

// ------------------------------------------------------------------ Address matching

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  rd: 'road',
  st: 'street',
  ave: 'avenue',
  av: 'avenue',
  ln: 'lane',
  cres: 'crescent',
  cresc: 'crescent',
  dr: 'drive',
  ct: 'court',
  pl: 'place',
  sq: 'square',
  terr: 'terrace',
  ter: 'terrace',
  gdns: 'gardens',
  cl: 'close',
  hse: 'house',
  bldg: 'building',
  apt: 'flat',
  apartment: 'flat',
};

/** Normalise an address line: lower case, no accents/punctuation, common abbreviations expanded. */
export function normaliseAddressLine(input: string | null | undefined): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ADDRESS_ABBREVIATIONS[t] ?? t)
    .join(' ');
}

export interface AddressLike {
  line1?: string | null;
  line2?: string | null;
  postcode?: string | null;
}

/**
 * Same address: identical valid UK postcode AND the first line of one address matches the start
 * of the other (so "3 Bute Dock Chambers" matches "3 Bute Dock Chambers, Mount Stuart Square",
 * but "1 High Street" does not match "12 High Street").
 */
export function addressesMatch(a: AddressLike, b: AddressLike): boolean {
  if (!isValidUkPostcode(a.postcode) || !isValidUkPostcode(b.postcode)) return false;
  if (normalisePostcode(a.postcode) !== normalisePostcode(b.postcode)) return false;
  const aLine = normaliseAddressLine(a.line1);
  const bLine = normaliseAddressLine(b.line1);
  if (aLine.length < 3 || bLine.length < 3) return false;
  const aFull = normaliseAddressLine(`${a.line1 ?? ''} ${a.line2 ?? ''}`);
  const bFull = normaliseAddressLine(`${b.line1 ?? ''} ${b.line2 ?? ''}`);
  const startsWithLine = (full: string, line: string) => full === line || full.startsWith(`${line} `);
  return startsWithLine(bFull, aLine) || startsWithLine(aFull, bLine);
}

