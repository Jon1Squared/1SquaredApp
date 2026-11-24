/**
 * Pure domain types and display/formatting helpers for Client Due Diligence (CDD)
 * (`src/domain/cdd.ts`, S1-04, ADR 0039).
 *
 * Kept pure (no `server-only`, no repository imports) so server services,
 * SQL-scoped page loaders, client components, and domain tests share identical shapes.
 */

import type {
  CddClientCategoryKey,
  CddRiskTierKey,
  IdentityVerificationRecord,
  IntakeEvidenceArtifactRef,
  RegisterChecklistItemValue,
  RegisterRecord,
  SanctionsPepScreeningRecord,
} from '@platform/core';

export interface CddEvidenceDownloadableRef extends IntakeEvidenceArtifactRef {
  readonly artifactId?: string;
  readonly downloadUrl?: string;
}

export type CddWorkflowStatus =
  | 'not_started'
  | 'in_progress'
  | 'recorded'
  | 'archived'
  | 'superseded';

export interface ClientCddCompactSummary {
  readonly visible: boolean;
  readonly subjectType: 'person' | 'organisation';
  readonly subjectId: string;
  readonly hasRecord: boolean;
  readonly recordId: string | null;
  readonly status: CddWorkflowStatus;
  readonly riskTier: CddRiskTierKey;
  readonly recordedByName: string | null;
  readonly recordedAt: string | null;
  readonly dueAt: string | null;
  readonly isExpired: boolean;
}

export interface ClientCddSummary extends ClientCddCompactSummary {
  readonly record: RegisterRecord | null;
  readonly clientCategory: CddClientCategoryKey | null;
  readonly derivedRiskTier: CddRiskTierKey;
  readonly needsUpgradeToHighRisk: boolean;
  readonly checklistItems: RegisterChecklistItemValue[];
  readonly evidenceRefs: CddEvidenceDownloadableRef[];
  readonly requiredTotal: number;
  readonly requiredCompleted: number;
  readonly manualSummaryNote: string;
  readonly latestIdentityCheck: IdentityVerificationRecord | null;
  readonly latestSanctionsCheck: SanctionsPepScreeningRecord | null;
  readonly canRecord: boolean;
}

const UK_SHORT_MONTHS = [
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
] as const;

export function formatUkShortDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate?.trim()) return '';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate.slice(0, 10);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = UK_SHORT_MONTHS[d.getUTCMonth()] ?? 'Jan';
  const year = d.getUTCFullYear();
  return `${day} ${mon} ${year}`;
}

export function isCddDueExpired(
  dueAt: string | null | undefined,
  nowYmd: string = new Date().toISOString().slice(0, 10),
): boolean {
  if (!dueAt?.trim()) return false;
  return dueAt.slice(0, 10) < nowYmd;
}

export function buildCddStatusDisplayText(
  summary: Pick<
    ClientCddCompactSummary,
    'visible' | 'hasRecord' | 'status' | 'recordedByName' | 'recordedAt' | 'dueAt' | 'isExpired'
  >,
): string {
  if (!summary.visible) {
    return '';
  }
  if (!summary.hasRecord || summary.status === 'not_started') {
    return 'CDD not started';
  }
  if (summary.status === 'recorded') {
    const by = summary.recordedByName?.trim() || 'Authorised user';
    const when = formatUkShortDate(summary.recordedAt);
    const duePart = summary.dueAt
      ? summary.isExpired
        ? ` — Re-check overdue (was due ${formatUkShortDate(summary.dueAt)})`
        : ` — Next re-check ${formatUkShortDate(summary.dueAt)}`
      : '';
    return `Recorded manually by ${by}${when ? ` on ${when}` : ''}${duePart}`;
  }
  if (summary.status === 'in_progress') {
    return 'CDD in progress';
  }
  if (summary.status === 'archived') {
    return 'CDD archived';
  }
  return 'CDD superseded';
}

export function buildHiddenClientCddSummary(
  subjectType: 'person' | 'organisation',
  subjectId: string,
): ClientCddSummary {
  return {
    visible: false,
    subjectType,
    subjectId,
    hasRecord: false,
    recordId: null,
    record: null,
    status: 'not_started',
    clientCategory: null,
    riskTier: 'standard',
    derivedRiskTier: 'standard',
    needsUpgradeToHighRisk: false,
    checklistItems: [],
    evidenceRefs: [],
    recordedByName: null,
    recordedAt: null,
    dueAt: null,
    isExpired: false,
    requiredTotal: 0,
    requiredCompleted: 0,
    manualSummaryNote: '',
    latestIdentityCheck: null,
    latestSanctionsCheck: null,
    canRecord: false,
  };
}
