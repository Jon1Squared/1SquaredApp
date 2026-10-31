/**
 * Search: builds a compact index from records and scores queries against it.
 * Runs in the browser on every keystroke, so it must stay pure and fast.
 */
import { foldForHighlight, normalisePhone, normalisePostcode, normaliseRegNumber, normaliseText } from './normalise';

export type SearchFieldKind =
  | 'name'
  | 'preferredName'
  | 'otherName'
  | 'email'
  | 'phone'
  | 'postcode'
  | 'companyNumber'
  | 'vatNumber'
  | 'matterNumber'
  | 'summary'
  | 'jobTitle'
  | 'tag'
  | 'id';

export type StatusTone = 'neutral' | 'warning' | 'alert' | 'positive';

export interface SearchField {
  kind: SearchFieldKind;
  text: string;
}

export interface SearchDoc {
  id: string;
  type: 'person' | 'organisation' | 'matter' | 'enquiry' | 'task';
  title: string;
  /** Main organisation (people) or organisation type (organisations) or client/work-type (matters). */
  subtitle: string;
  status: string;
  /** Optional pills shown only for things needing action / unusual state. */
  pills: { label: string; tone: StatusTone }[];
  fields: SearchField[];
  /** Archived / deceased / merged / dissolved records rank lower. */
  inactive: boolean;
  mergedIntoId: string | null;
  createdAt: string;
}

export const FIELD_WEIGHTS: Record<SearchFieldKind, number> = {
  name: 10,
  matterNumber: 10,
  preferredName: 9,
  otherName: 8,
  email: 8,
  phone: 8,
  companyNumber: 8,
  vatNumber: 8,
  id: 8,
  summary: 7,
  postcode: 6,
  jobTitle: 4,
  tag: 4,
};

export const FIELD_LABELS: Record<SearchFieldKind, string> = {
  name: 'Name',
  matterNumber: 'Matter no.',
  preferredName: 'Preferred name',
  otherName: 'Other name',
  email: 'Email',
  phone: 'Phone',
  postcode: 'Postcode',
  companyNumber: 'Company no.',
  vatNumber: 'VAT no.',
  summary: 'Summary',
  jobTitle: 'Job title',
  tag: 'Tag',
  id: 'ID',
};

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  titleRanges: MatchRange[];
  /** Set when the best match was in a non-title field (e.g. an email or postcode). */
  matchedField?: { kind: SearchFieldKind; label: string; text: string; ranges: MatchRange[] };
}

export interface SearchResults {
  people: SearchHit[];
  organisations: SearchHit[];
  matters: SearchHit[];
  enquiries: SearchHit[];
  tasks: SearchHit[];
  /** Flattened in display order for keyboard navigation. */
  ordered: SearchHit[];
  total: number;
}

function fieldKey(f: SearchField): string {
  switch (f.kind) {
    case 'phone':
      return normalisePhone(f.text);
    case 'postcode':
      return normalisePostcode(f.text).toLowerCase();
    case 'companyNumber':
    case 'vatNumber':
      return normaliseRegNumber(f.text).toLowerCase();
    case 'id':
    case 'matterNumber':
      return f.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    default:
      return normaliseText(f.text);
  }
}

/** Score a single query token against a normalised field value. */
function tokenScore(token: string, value: string): number {
  if (!value) return 0;
  if (value === token) return 12;
  const words = value.split(' ');
  if (words.includes(token)) return 10;
  if (words.some((w) => w.startsWith(token))) return 7;
  if (token.length >= 3 && value.includes(token)) return 3;
  return 0;
}

export function tokenise(query: string): string[] {
  return normaliseText(query).split(' ').filter(Boolean);
}

/** Score one doc. Every token must match at least one field. */
export function scoreDoc(doc: SearchDoc, query: string): Omit<SearchHit, 'doc'> | null {
  const tokens = tokenise(query);
  if (!tokens.length) return null;
  const compactQuery = query.replace(/\s+/g, '').toLowerCase();
  const digitQuery = normalisePhone(query);
  const regQuery = normaliseRegNumber(query).toLowerCase();

  let total = 0;
  let bestField: { field: SearchField; score: number } | null = null;
  const perField = new Map<SearchField, number>();

  // Whole-query matches for compact identifier fields (phones, postcodes, numbers, ids).
  for (const f of doc.fields) {
    const key = fieldKey(f);
    let s = 0;
    if (f.kind === 'phone' && digitQuery.length >= 4 && key.includes(digitQuery)) s = key === digitQuery ? 12 : 9;
    if (f.kind === 'postcode' && compactQuery.length >= 3 && key.startsWith(compactQuery)) s = key === compactQuery ? 12 : 9;
    if ((f.kind === 'companyNumber' || f.kind === 'vatNumber') && regQuery.length >= 4 && key.includes(regQuery))
      s = key === regQuery ? 12 : 9;
    if ((f.kind === 'id' || f.kind === 'matterNumber') && key.includes(compactQuery.replace(/[^a-z0-9]/g, '')) && compactQuery.length >= 3)
      s = 12;
    if (f.kind === 'email' && normaliseText(query) && key.includes(normaliseText(query)) && query.includes('@'))
      s = 12;
    if (s) {
      const weighted = s * FIELD_WEIGHTS[f.kind] * tokens.length;
      perField.set(f, weighted);
    }
  }

  if (perField.size) {
    for (const [f, s] of perField) {
      total = Math.max(total, s);
      if (!bestField || s > bestField.score) bestField = { field: f, score: s };
    }
  } else {
    for (const token of tokens) {
      let best = 0;
      for (const f of doc.fields) {
        const s = tokenScore(token, fieldKey(f)) * FIELD_WEIGHTS[f.kind];
        if (s > 0) perField.set(f, (perField.get(f) ?? 0) + s);
        if (s > best) best = s;
      }
      if (best === 0) return null;
      total += best;
    }
    for (const [f, s] of perField) {
      if (!bestField || s > bestField.score) bestField = { field: f, score: s };
    }
    // Bonus when the full phrase appears in the title.
    if (normaliseText(doc.title).includes(tokens.join(' '))) total += 15;
  }

  if (doc.inactive) total *= 0.85;
  if (doc.mergedIntoId) total *= 0.6;

  const titleRanges = highlightRanges(doc.title, tokens);
  let matchedField: SearchHit['matchedField'];
  if (bestField && bestField.field.kind !== 'name') {
    const titleScore = perFieldScore(perField, doc.fields, 'name');
    if (bestField.score > titleScore) {
      const f = bestField.field;
      matchedField = {
        kind: f.kind,
        label: FIELD_LABELS[f.kind],
        text: f.text,
        ranges: highlightRanges(f.text, tokens, query),
      };
    }
  }

  return { score: total, titleRanges, matchedField };
}

function perFieldScore(map: Map<SearchField, number>, fields: SearchField[], kind: SearchFieldKind): number {
  let s = 0;
  for (const f of fields) if (f.kind === kind) s = Math.max(s, map.get(f) ?? 0);
  return s;
}

/**
 * Compute highlight ranges in the ORIGINAL text (accents preserved) for each token.
 * Prefers matches at word starts.
 */
export function highlightRanges(text: string, tokens: string[], rawQuery?: string): MatchRange[] {
  const folded = foldForHighlight(text);
  const ranges: MatchRange[] = [];
  const candidates = [...tokens];
  if (rawQuery) {
    const rq = rawQuery.trim().toLowerCase();
    if (rq && !candidates.includes(rq)) candidates.unshift(rq);
  }
  for (const token of candidates) {
    if (!token) continue;
    let idx = -1;
    let from = 0;
    // Prefer word-start match
    while ((idx = folded.indexOf(token, from)) !== -1) {
      const prev = idx === 0 ? ' ' : folded[idx - 1];
      if (!/[a-z0-9]/.test(prev)) break;
      from = idx + 1;
    }
    if (idx === -1 && token.length >= 3) idx = folded.indexOf(token);
    if (idx !== -1) ranges.push({ start: idx, end: idx + token.length });
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function search(index: SearchDoc[], query: string, limitPerGroup = 8): SearchResults {
  const empty: SearchResults = {
    people: [],
    organisations: [],
    matters: [],
    enquiries: [],
    tasks: [],
    ordered: [],
    total: 0,
  };
  if (!query.trim()) return empty;
  const hits: SearchHit[] = [];
  for (const doc of index) {
    const r = scoreDoc(doc, query);
    if (r) hits.push({ doc, ...r });
  }
  hits.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
  const people = hits.filter((h) => h.doc.type === 'person');
  const organisations = hits.filter((h) => h.doc.type === 'organisation');
  const matters = hits.filter((h) => h.doc.type === 'matter');
  const enquiries = hits.filter((h) => h.doc.type === 'enquiry');
  const tasks = hits.filter((h) => h.doc.type === 'task');
  // Show the group containing the top hit first.
  const topType = hits[0]?.doc.type;
  const p = people.slice(0, limitPerGroup);
  const o = organisations.slice(0, limitPerGroup);
  const m = matters.slice(0, limitPerGroup);
  const e = enquiries.slice(0, limitPerGroup);
  const t = tasks.slice(0, limitPerGroup);
  const ordered =
    topType === 'organisation'
      ? [...o, ...p, ...m, ...e, ...t]
      : topType === 'matter'
        ? [...m, ...p, ...o, ...e, ...t]
        : topType === 'enquiry'
          ? [...e, ...p, ...o, ...m, ...t]
          : topType === 'task'
            ? [...t, ...e, ...m, ...p, ...o]
            : [...p, ...o, ...m, ...e, ...t];
  return {
    people: p,
    organisations: o,
    matters: m,
    enquiries: e,
    tasks: t,
    ordered,
    total: hits.length,
  };
}

/** Split text into plain / highlighted segments for rendering. */
export function segments(text: string, ranges: MatchRange[]): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start), match: false });
    out.push({ text: text.slice(r.start, r.end), match: true });
    pos = r.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), match: false });
  return out;
}
