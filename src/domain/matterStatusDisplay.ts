import type { PillTone } from './badges';
import { resolveLabel } from './lists';
import type { ChoiceValue, Matter } from './types';

/**
 * Pure domain helpers for consistent matter status pill, CMI-incomplete
 * classification, and search/list badge resolution (R810).
 */

export function resolveMatterStatusSystemKey(
  statusId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): string | null {
  const id = (statusId ?? '').trim();
  if (!id) return null;
  const match =
    values.find((v) => v.listKey === 'matter_status' && v.id === id) ??
    values.find((v) => v.id === id);
  if (match?.systemKey?.trim()) {
    return match.systemKey.trim().toLowerCase();
  }
  if (
    id === 'matter_status.prospective_enquiry' ||
    id === 'matter_status.prospective'
  ) {
    return 'prospective';
  }
  if (id === 'matter_status.cmi_incomplete') return 'cmi_incomplete';
  if (id === 'matter_status.active') return 'active';
  if (id === 'matter_status.on_hold') return 'on_hold';
  if (id === 'matter_status.completed') return 'completed';
  if (id === 'matter_status.closed') return 'closed';
  if (id === 'matter_status.archived') return 'archived';
  if (id === 'matter_status.aborted_lost') return 'aborted';
  return null;
}

export function isMatterOpenedViaOpeningGate(
  matter: Pick<Matter, 'fieldValues' | 'isPmsImport'>,
): boolean {
  if (matter.isPmsImport === true) return false;
  const gateRecord = matter.fieldValues?.['matterOpeningGate'] as
    | { openedViaGate?: unknown }
    | undefined;
  return gateRecord?.openedViaGate === true;
}

export function isMatterCmiIncompleteStatus(
  matter: Pick<
    Matter,
    'matterStatusId' | 'amlStatus' | 'fieldValues' | 'isPmsImport'
  >,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): boolean {
  const sysKey = resolveMatterStatusSystemKey(matter.matterStatusId, values);
  if (sysKey === 'cmi_incomplete') {
    return true;
  }
  if (sysKey === 'active') {
    if (isMatterOpenedViaOpeningGate(matter)) {
      return false;
    }
    return matter.amlStatus === 'Pending' || matter.amlStatus === 'CMI incomplete';
  }
  return false;
}

export interface MatterStatusPillDisplay {
  readonly label: string;
  readonly tone: PillTone;
  readonly isCmiIncomplete: boolean;
  readonly isConflictFlagged: boolean;
}

export function resolveMatterStatusPill(
  matter: Pick<
    Matter,
    | 'matterStatusId'
    | 'amlStatus'
    | 'conflictCheckStatus'
    | 'fieldValues'
    | 'isPmsImport'
  >,
  values: ChoiceValue[] = [],
): MatterStatusPillDisplay {
  const isConflictFlagged = (matter.conflictCheckStatus ?? '')
    .toLowerCase()
    .includes('conflict');
  const isCmiIncomplete = isMatterCmiIncompleteStatus(matter, values);
  if (isConflictFlagged) {
    return {
      label: 'Conflict flagged',
      tone: 'alert',
      isCmiIncomplete,
      isConflictFlagged: true,
    };
  }
  const sysKey = resolveMatterStatusSystemKey(matter.matterStatusId, values);
  if (sysKey === 'prospective') {
    return {
      label: 'Prospective',
      tone: 'warning',
      isCmiIncomplete: false,
      isConflictFlagged: false,
    };
  }
  if (isCmiIncomplete) {
    return {
      label: 'CMI incomplete',
      tone: 'warning',
      isCmiIncomplete: true,
      isConflictFlagged: false,
    };
  }
  if (sysKey === 'active') {
    return {
      label: 'Open',
      tone: 'positive',
      isCmiIncomplete: false,
      isConflictFlagged: false,
    };
  }
  const rawLabel = resolveLabel(values, matter.matterStatusId) || 'Active';
  const lower = rawLabel.toLowerCase();
  const tone: PillTone =
    sysKey === 'on_hold' ||
    lower.includes('hold') ||
    lower.includes('closing') ||
    lower.includes('pre')
      ? 'warning'
      : 'neutral';
  return {
    label: rawLabel,
    tone,
    isCmiIncomplete: false,
    isConflictFlagged: false,
  };
}
