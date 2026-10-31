/** Custom field validation against the active definitions. */
import type { ChoiceValue, CustomFieldDefinition, RecordType } from './types';

export interface CustomFieldValidation {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

export function activeDefinitions(defs: CustomFieldDefinition[], recordType: RecordType): CustomFieldDefinition[] {
  return defs
    .filter((d) => d.recordType === recordType && d.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validate and coerce submitted values.
 * - Values for inactive/unknown definitions already on the record are preserved untouched.
 * - Empty values are removed.
 */
export function validateCustomFields(
  defs: CustomFieldDefinition[],
  recordType: RecordType,
  submitted: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  values: ChoiceValue[] = [],
): CustomFieldValidation {
  const active = activeDefinitions(defs, recordType);
  const activeIds = new Set(active.map((d) => d.id));
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  // Preserve data for definitions that are no longer active.
  for (const [k, v] of Object.entries(existing)) {
    if (!activeIds.has(k)) out[k] = v;
  }

  for (const def of active) {
    const raw = submitted[def.id];
    if (isEmpty(raw) || (def.fieldType === 'yesNo' && raw === '')) {
      if (def.required && def.fieldType !== 'yesNo') errors[def.id] = `${def.label} is required`;
      continue;
    }
    switch (def.fieldType) {
      case 'text':
      case 'longText': {
        const s = String(raw).trim();
        if (def.fieldType === 'text' && s.length > 500) errors[def.id] = 'Too long (max 500 characters)';
        else out[def.id] = s;
        break;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
        if (!Number.isFinite(n)) errors[def.id] = 'Enter a number';
        else out[def.id] = n;
        break;
      }
      case 'date': {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s).getTime())) errors[def.id] = 'Enter a valid date';
        else out[def.id] = s;
        break;
      }
      case 'yesNo': {
        const b = raw === true || raw === 'true' || raw === 'yes' || raw === 'on';
        const f = raw === false || raw === 'false' || raw === 'no';
        if (!b && !f) errors[def.id] = 'Choose yes or no';
        else out[def.id] = b;
        break;
      }
      case 'choice': {
        const id = String(raw);
        const v = values.find((x) => x.id === id && x.listKey === def.optionsListKey);
        const wasSelected = existing[def.id] === id;
        if (!v || (!v.active && !wasSelected)) errors[def.id] = 'Choose a valid option';
        else out[def.id] = id;
        break;
      }
    }
  }
  return { values: out, errors };
}

export function formatCustomValue(
  def: CustomFieldDefinition,
  value: unknown,
  values: ChoiceValue[],
  formatDate: (s: string) => string,
): string {
  if (isEmpty(value)) return '';
  switch (def.fieldType) {
    case 'yesNo':
      return value === true ? 'Yes' : value === false ? 'No' : '';
    case 'date':
      return formatDate(String(value));
    case 'number':
      return Number(value).toLocaleString('en-GB');
    case 'choice':
      return values.find((v) => v.id === value)?.label ?? 'Unknown value';
    default:
      return String(value);
  }
}
