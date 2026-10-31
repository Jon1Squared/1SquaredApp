/** Merge planning: what the surviving record takes from the merged record. */
import { fieldsFor } from './fieldRegistry';
import { normaliseEmail, normaliseOrgName, normalisePhone, normalisePostcode, normaliseText } from './normalise';
import { personDisplayName } from './names';
import type { Address, AnyRecord, Email, OtherName, Phone } from './types';

export interface MergePlan<T extends AnyRecord> {
  survivor: T;
  fieldsTaken: string[];
}

/** Fields never copied across in a merge. */
const SKIP = new Set([
  'recordStatusId',
  'duplicateStatusId',
  'isEmployee',
  'employeeRoleId',
  'departmentId',
  'lastInteractionAt',
]);

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function unionBy<T>(a: T[], b: T[], key: (x: T) => string): { result: T[]; added: number } {
  const seen = new Set(a.map(key));
  const result = [...a];
  let added = 0;
  for (const x of b) {
    const k = key(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    result.push(x);
    added++;
  }
  return { result, added };
}

const addressKey = (a: Address) => normalisePostcode(a.postcode) + '|' + normaliseText(a.line1);

export function planMerge<T extends AnyRecord>(survivor: T, merged: T): MergePlan<T> {
  if (survivor.recordType !== merged.recordType) throw new Error('Cannot merge different record types');
  const out = structuredClone(survivor) as T & Record<string, unknown>;
  const src = merged as T & Record<string, unknown>;
  const taken: string[] = [];

  for (const def of fieldsFor(survivor.recordType)) {
    if (SKIP.has(def.key)) continue;
    const key = def.key;
    const a = out[key];
    const b = src[key];
    if (isEmpty(b)) continue;

    switch (def.kind) {
      case 'emails': {
        const incoming = (b as Email[]).map((e) => ({ ...e, isPrimary: false }));
        const { result, added } = unionBy(a as Email[], incoming, (e) => normaliseEmail(e.address));
        if (added) {
          if (!result.some((e) => e.isPrimary) && result[0]) result[0].isPrimary = true;
          out[key] = result;
          taken.push(def.label);
        }
        break;
      }
      case 'phones': {
        const { result, added } = unionBy(a as Phone[], b as Phone[], (p) => normalisePhone(p.number));
        if (added) {
          out[key] = result;
          taken.push(def.label);
        }
        break;
      }
      case 'addresses': {
        const { result, added } = unionBy(a as Address[], b as Address[], addressKey);
        if (added) {
          out[key] = result;
          taken.push(def.label);
        }
        break;
      }
      case 'otherNames': {
        const { result, added } = unionBy(a as OtherName[], b as OtherName[], (n) => normaliseText(n.name));
        if (added) {
          out[key] = result;
          taken.push(def.label);
        }
        break;
      }
      case 'choiceMulti':
      case 'tags': {
        const { result, added } = unionBy(a as string[], b as string[], (s) => s.toLowerCase());
        if (added) {
          out[key] = result;
          taken.push(def.label);
        }
        break;
      }
      default:
        if (isEmpty(a)) {
          out[key] = b;
          taken.push(def.label);
        }
    }
  }

  // Keep the merged record's name as an alternative name if it differs.
  const survivorName = survivor.recordType === 'person' ? personDisplayName(survivor) : survivor.legalName;
  const mergedName = merged.recordType === 'person' ? personDisplayName(merged) : merged.legalName;
  const nameKey = survivor.recordType === 'person' ? normaliseText : normaliseOrgName;
  if (nameKey(survivorName) !== nameKey(mergedName)) {
    const names = out.otherNames as OtherName[];
    if (!names.some((n) => nameKey(n.name) === nameKey(mergedName))) {
      out.otherNames = [...names, { id: `merged-${merged.id}`, name: mergedName, typeId: null }];
      taken.push('Alternative name');
    }
  }

  // Custom fields: fill missing values only.
  const cf = { ...(out.customFields as Record<string, unknown>) };
  let cfTaken = false;
  for (const [k, v] of Object.entries(merged.customFields ?? {})) {
    if (isEmpty(cf[k]) && !isEmpty(v)) {
      cf[k] = v;
      cfTaken = true;
    }
  }
  if (cfTaken) {
    out.customFields = cf;
    taken.push('Custom fields');
  }

  // Track history: survivor remembers the merged id so it is no longer flagged as a duplicate.
  out.possibleMatchIds = (out.possibleMatchIds as string[]).filter((id) => id !== merged.id);

  return { survivor: out as T, fieldsTaken: [...new Set(taken)] };
}
