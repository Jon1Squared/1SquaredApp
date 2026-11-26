import 'server-only';

import {
  redactMatterCddFields,
  REDACTED_MATTER_CDD_STATUS,
} from '@platform/core';
import type { Matter } from '@/domain/types';

export { REDACTED_MATTER_CDD_STATUS };

/**
 * Redacts matter-level CDD outcome fields (`amlStatus`, `amlCompletedAt`, and
 * `fieldValues.matterOpeningSnapshot.complianceOnboarding.amlStatus`) on a single
 * `Matter` before returning it to a viewer without `cdd:view` (or restricted by
 * employee-client CDD rules).
 */
export function redactMatterCddForUnpermittedViewer(matter: Matter): Matter {
  return redactMatterCddFields(matter);
}

function isMatterLikeRecord(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  amlStatus: string;
  amlCompletedAt: string | null;
  fieldValues?: Record<string, unknown>;
} {
  if (value.recordType === 'matter') {
    return typeof value.amlStatus === 'string';
  }
  return (
    typeof value.amlStatus === 'string' &&
    'amlCompletedAt' in value &&
    typeof value.matterStatusId === 'string'
  );
}

function isClientPriorMatterSummaryLike(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.clientId === 'string' &&
    value.recordType === undefined &&
    'amlStatus' in value &&
    !('matterStatusId' in value)
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isShellSubtree(key: string, value: unknown): boolean {
  if (key === 'ctx' || key === 'store') {
    return true;
  }
  return (
    key === 'shell' &&
    typeof value === 'object' &&
    value !== null &&
    'staffPeopleRaw' in value
  );
}

/**
 * Shared browser-boundary choke point (`R812`): walks any page loader or server
 * action payload returned to a caller without `cdd:view` and guarantees no
 * `Matter` or `ClientPriorMatterSummary` leaks matter-level CDD outcomes.
 */
export function redactMatterCddInBrowserPayload<T>(
  payload: T,
  canViewCdd: boolean,
): T {
  if (canViewCdd || payload === null || typeof payload !== 'object') {
    return payload;
  }

  const visited = new WeakMap<object, unknown>();

  const visit = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (visited.has(value)) {
      return visited.get(value);
    }
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error ||
      ArrayBuffer.isView(value) ||
      value instanceof Map ||
      value instanceof Set
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      let changed = false;
      const mapped = new Array<unknown>(value.length);
      visited.set(value, mapped);
      for (let i = 0; i < value.length; i += 1) {
        const prevItem = value[i];
        const nextItem = visit(prevItem);
        mapped[i] = nextItem;
        if (nextItem !== prevItem) {
          changed = true;
        }
      }
      const resolved = changed ? mapped : value;
      visited.set(value, resolved);
      return resolved;
    }

    if (!isPlainObject(value)) {
      return value;
    }

    if (isMatterLikeRecord(value)) {
      const redacted = redactMatterCddFields(value);
      visited.set(value, redacted);
      return redacted;
    }

    if (isClientPriorMatterSummaryLike(value)) {
      const rest = { ...value };
      delete rest.amlStatus;
      visited.set(value, rest);
      return rest;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    visited.set(value, out);
    for (const [k, prevChild] of Object.entries(value)) {
      const nextChild = isShellSubtree(k, prevChild)
        ? prevChild
        : visit(prevChild);
      out[k] = nextChild;
      if (nextChild !== prevChild) {
        changed = true;
      }
    }
    const resolved = changed ? out : value;
    visited.set(value, resolved);
    return resolved;
  };

  return visit(payload) as T;
}
