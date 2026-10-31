/** Field-level diffing for the audit trail. */
import { fieldsFor, formatFieldValue, type FormatContext } from './fieldRegistry';
import { formatCustomValue } from './customFields';
import { formatDate } from './dates';
import type { CustomFieldDefinition, RecordType } from './types';

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * Compare two versions of a record (or link) and return one change per field.
 * Values are formatted to human-readable strings at the time of change.
 */
export function diffRecords(
  recordType: RecordType | 'link',
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  ctx: FormatContext,
  customDefs: CustomFieldDefinition[] = [],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const def of fieldsFor(recordType)) {
    const a = before ? before[def.key] : undefined;
    const b = after[def.key];
    if (same(a, b)) continue;
    if (!before && (b === null || b === undefined || b === '' || (Array.isArray(b) && b.length === 0) || b === false))
      continue;
    changes.push({
      field: def.label,
      oldValue: before ? formatFieldValue(def, a, ctx) || null : null,
      newValue: formatFieldValue(def, b, ctx) || null,
    });
  }
  if (recordType !== 'link') {
    const ca = (before?.customFields ?? {}) as Record<string, unknown>;
    const cb = (after.customFields ?? {}) as Record<string, unknown>;
    const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
    for (const k of keys) {
      if (same(ca[k], cb[k])) continue;
      const def = customDefs.find((d) => d.id === k);
      const label = def?.label ?? k;
      const fmt = (v: unknown) =>
        def ? formatCustomValue(def, v, ctx.values, formatDate) || null : v == null ? null : String(v);
      changes.push({ field: label, oldValue: before ? fmt(ca[k]) : null, newValue: fmt(cb[k]) });
    }
  }
  return changes;
}
