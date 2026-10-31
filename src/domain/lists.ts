/** Choice list resolution. Records store value ids; labels are resolved at render time. */
import type { ChoiceList, ChoiceValue, ListCatalogue } from './types';

export interface ResolvedValue {
  id: string;
  label: string;
  active: boolean;
  missing: boolean;
}

export function valueById(values: ChoiceValue[], id: string | null | undefined): ChoiceValue | undefined {
  if (!id) return undefined;
  return values.find((v) => v.id === id);
}

export function resolveValue(values: ChoiceValue[], id: string | null | undefined): ResolvedValue | null {
  if (!id) return null;
  const v = valueById(values, id);
  if (!v) return { id, label: 'Unknown value', active: false, missing: true };
  return { id, label: v.label, active: v.active, missing: false };
}

export function resolveLabel(values: ChoiceValue[], id: string | null | undefined): string {
  return resolveValue(values, id)?.label ?? '';
}

export function resolveLabels(values: ChoiceValue[], ids: string[] | null | undefined): string[] {
  return (ids ?? []).map((id) => resolveLabel(values, id)).filter(Boolean);
}

export function valuesForList(values: ChoiceValue[], listKey: string): ChoiceValue[] {
  return values.filter((v) => v.listKey === listKey).sort(bySortOrder);
}

export function bySortOrder(a: ChoiceValue, b: ChoiceValue): number {
  return a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);
}

/**
 * Options to offer in a picker: active values plus any inactive values already
 * selected on the record (so existing data stays visible).
 */
export function optionsFor(
  values: ChoiceValue[],
  listKey: string,
  currentIds: string | string[] | null | undefined = [],
): ChoiceValue[] {
  const current = new Set(Array.isArray(currentIds) ? currentIds : currentIds ? [currentIds] : []);
  return valuesForList(values, listKey).filter((v) => v.active || current.has(v.id));
}

/** Find a value by its stable systemKey (used by business rules, never labels). */
export function valueBySystemKey(
  values: ChoiceValue[],
  listKey: string,
  systemKey: string,
): ChoiceValue | undefined {
  return values.find((v) => v.listKey === listKey && v.systemKey === systemKey);
}

export function systemKeyOf(values: ChoiceValue[], id: string | null | undefined): string | undefined {
  return valueById(values, id)?.systemKey;
}

export interface TreeNode {
  value: ChoiceValue;
  children: ChoiceValue[];
}

/** Two-level hierarchy (work type, document type, jurisdiction, matter stage, audience). */
export function buildTree(values: ChoiceValue[], listKey: string): TreeNode[] {
  const all = valuesForList(values, listKey);
  const parents = all.filter((v) => !v.parentId);
  return parents.map((p) => ({ value: p, children: all.filter((c) => c.parentId === p.id) }));
}

export function listByKey(lists: ChoiceList[], key: string): ChoiceList | undefined {
  return lists.find((l) => l.key === key);
}

/** Validation for admin edits. */
export function canDeactivate(value: ChoiceValue): { ok: boolean; reason?: string } {
  if (value.systemKey) {
    return { ok: false, reason: 'This value drives system behaviour. You can rename it but not deactivate it.' };
  }
  return { ok: true };
}

export function nextSortOrder(values: ChoiceValue[], listKey: string): number {
  const list = values.filter((v) => v.listKey === listKey);
  return list.length ? Math.max(...list.map((v) => v.sortOrder)) + 1 : 1;
}

/** Move a value up/down within its list (and parent, for hierarchies). Returns updated values. */
export function reorder(values: ChoiceValue[], id: string, direction: -1 | 1): ChoiceValue[] {
  const target = values.find((v) => v.id === id);
  if (!target) return [];
  const siblings = valuesForList(values, target.listKey).filter(
    (v) => (v.parentId ?? null) === (target.parentId ?? null),
  );
  const idx = siblings.findIndex((v) => v.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= siblings.length) return [];
  const reordered = [...siblings];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  return reordered
    .map((v, i) => ({ ...v, sortOrder: i + 1 }))
    .filter((v) => siblings.find((s) => s.id === v.id)!.sortOrder !== v.sortOrder);
}

export function catalogueLabel(cat: ListCatalogue, id: string | null | undefined): string {
  return resolveLabel(cat.values, id);
}
