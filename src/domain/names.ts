import type { AnyRecord, Organisation, Person } from './types';

export function personDisplayName(
  p?: Pick<Person, 'firstName' | 'surname' | 'preferredName'> | null,
): string {
  if (!p) return '';
  const first = p.preferredName?.trim() || p.firstName?.trim() || '';
  return [first, p.surname?.trim()].filter(Boolean).join(' ');
}

export function personFullName(
  p: Pick<Person, 'firstName' | 'middleNames' | 'surname'>,
  title?: string,
): string {
  return [title, p.firstName, p.middleNames, p.surname].map((s) => s?.trim()).filter(Boolean).join(' ');
}

export function recordDisplayName(r: AnyRecord): string {
  return r.recordType === 'person' ? personDisplayName(r) : (r as Organisation).legalName;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function primaryEmail(p: Person): string {
  return (p.emails.find((e) => e.isPrimary) ?? p.emails[0])?.address ?? '';
}

export function primaryPhone(p: Person): string {
  return p.phones[0]?.number ?? '';
}

export function recordHref(r: { id: string; recordType: string }): string {
  if (r.recordType === 'matter') return `/matters/${r.id}`;
  if (r.recordType === 'enquiry') return `/enquiries/${r.id}`;
  if (r.recordType === 'task') return `/tasks/${r.id}`;
  return r.recordType === 'person' ? `/people/${r.id}` : `/organisations/${r.id}`;
}

export function hrefForId(id: string): string {
  if (id.startsWith('M-')) return `/matters/${id}`;
  if (id.startsWith('ENQ-')) return `/enquiries/${id}`;
  if (id.startsWith('TSK-')) return `/tasks/${id}`;
  return id.startsWith('P-') ? `/people/${id}` : `/organisations/${id}`;
}

