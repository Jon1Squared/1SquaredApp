/**
 * Pure domain logic for Stage 1 S1-05 (ADRs 0039 & 0040):
 * - Per-work-type matter opening preconditions & partner overrides (`workTypes.*.openingGate`)
 * - Server-stamped signed engagement check (`R753`)
 * - Strictly key-based High / Critical risk identification (`R749`)
 *
 * Kept pure (no `server-only`, no repository imports) so server transactions,
 * page loaders, and client UI evaluate opening readiness identically.
 */

import type { RegisterRecord, WorkTypeOpeningGateConfig } from '@platform/core-api';
import type { CddWorkflowStatus } from './cdd';
import type { ChoiceValue, ConflictCheckStatusPill, Matter } from './types';

export type OpeningGatePreconditionKey =
  | 'conflict_cleared'
  | 'cdd_complete'
  | 'engagement_signed'
  | 'funds_on_account';

export const OPENING_GATE_OVERRIDE_ERROR_CODES = {
  FORBIDDEN: 'OPENING_GATE_OVERRIDE_FORBIDDEN',
  VALIDATION: 'OPENING_GATE_OVERRIDE_VALIDATION_ERROR',
  BLOCKED: 'MATTER_OPENING_GATE_BLOCKED',
} as const;

export const ENGAGEMENT_SIGNED_STATUSES = [
  'Signed',
  'Signed & returned',
] as const;

export type EngagementSignedStatus = (typeof ENGAGEMENT_SIGNED_STATUSES)[number];

export function isEngagementLetterSignedStatus(
  status: string | null | undefined,
): status is EngagementSignedStatus {
  return status === 'Signed' || status === 'Signed & returned';
}

export function isMatterEngagementSignedForGate(
  matter: Pick<Matter, 'engagementLetterSignedAt' | 'engagementLetterStatus'>,
): boolean {
  return (
    Boolean(matter.engagementLetterSignedAt?.trim()) ||
    isEngagementLetterSignedStatus(matter.engagementLetterStatus)
  );
}

/**
 * Resolves whether a matter risk rating requires High-Risk two-stage opening sign-off
 * (`high` or `critical` ONLY — `risk_rating.sensitive` maps to `high` CDD tier in S1-04
 * and NEVER triggers `high_risk_opening`, per ADR 0039 & R749).
 */
export function resolveMatterRiskSystemKey(
  riskRatingId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): string | null {
  const id = (riskRatingId ?? '').trim();
  if (!id) return null;
  const match =
    values.find((v) => v.listKey === 'risk_rating' && v.id === id) ??
    values.find((v) => v.id === id);
  if (match?.systemKey?.trim()) {
    return match.systemKey.trim().toLowerCase();
  }
  const lower = id.toLowerCase();
  if (lower === 'risk_rating.high') return 'high';
  if (lower === 'risk_rating.critical') return 'critical';
  if (lower === 'risk_rating.sensitive') return 'sensitive';
  if (lower === 'risk_rating.medium') return 'medium';
  if (lower === 'risk_rating.low') return 'low';
  return null;
}

export function isHighOrCriticalRiskRating(
  riskRatingId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): boolean {
  const key = resolveMatterRiskSystemKey(riskRatingId, values);
  return key === 'high' || key === 'critical';
}

export interface OpeningGateOverrideSummary {
  readonly id: string;
  readonly preconditionKey: OpeningGatePreconditionKey;
  readonly reason: string;
  readonly overriddenByPersonId: string;
  readonly overriddenByName?: string | null;
  readonly overriddenAt: string;
  readonly revokedByPersonId?: string | null;
  readonly revokedAt?: string | null;
}

export interface OpeningGatePreconditionResult {
  readonly key: OpeningGatePreconditionKey;
  readonly label: string;
  readonly required: boolean;
  readonly rawSatisfied: boolean;
  readonly overridden: boolean;
  readonly satisfied: boolean;
  readonly canOverride: boolean;
  readonly nonOverridableReason: string | null;
  readonly statusSummary: string;
  readonly activeOverride: OpeningGateOverrideSummary | null;
}

export interface OpeningGateHighRiskSummary {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly recordId: string | null;
  readonly reference: string | null;
  readonly status:
    | 'not_required'
    | 'missing'
    | 'pending_partner'
    | 'pending_compliance'
    | 'approved'
    | 'rejected'
    | 'withdrawn';
  readonly statusLabel: string;
  readonly partnerApproverId: string | null;
  readonly partnerApproverName?: string | null;
  readonly partnerApprovedAt?: string | null;
  readonly decidedById: string | null;
  readonly decidedAt: string | null;
}

export interface OpeningGateEvaluation {
  readonly canOpen: boolean;
  readonly requiresHighRiskApproval: boolean;
  readonly highRisk: OpeningGateHighRiskSummary;
  readonly gateConfig: WorkTypeOpeningGateConfig;
  readonly preconditions: readonly OpeningGatePreconditionResult[];
  readonly blockingReasons: readonly string[];
  readonly activeOverrides: readonly OpeningGateOverrideSummary[];
}

export const OPENING_GATE_PRECONDITION_LABELS: Record<
  OpeningGatePreconditionKey,
  string
> = {
  conflict_cleared: 'Conflict check',
  cdd_complete: 'Client Due Diligence',
  engagement_signed: 'Signed engagement letter',
  funds_on_account: 'Funds on account',
};

function normaliseConflictStatusForGate(
  matter: Pick<Matter, 'conflictCheckRecord' | 'conflictCheckStatus'>,
): ConflictCheckStatusPill {
  const recStatus = matter.conflictCheckRecord?.status;
  if (
    recStatus === 'Not started' ||
    recStatus === 'In progress' ||
    recStatus === 'Cleared' ||
    recStatus === 'Referred' ||
    recStatus === 'Approved' ||
    recStatus === 'Declined'
  ) {
    return recStatus;
  }
  const legacy = (matter.conflictCheckStatus ?? '').trim();
  if (legacy === 'Cleared' || legacy === 'Clear') return 'Cleared';
  if (legacy === 'Approved') return 'Approved';
  if (legacy === 'Referred' || legacy === 'Pending conflict review') {
    return 'Referred';
  }
  if (legacy === 'Declined') return 'Declined';
  if (legacy === 'In progress' || legacy === 'Draft') return 'In progress';
  return 'Not started';
}

export interface EvaluateOpeningPreconditionsInput {
  readonly matter: Pick<
    Matter,
    | 'conflictCheckRecord'
    | 'conflictCheckStatus'
    | 'engagementLetterStatus'
    | 'engagementLetterSignedAt'
    | 'retainerMoniesOnAccountGbp'
    | 'riskRatingId'
  >;
  readonly gateConfig: WorkTypeOpeningGateConfig;
  readonly cddStatus: {
    readonly status: CddWorkflowStatus;
    readonly isExpired: boolean;
    readonly visibleToViewer?: boolean;
  };
  readonly activeOverrides: readonly OpeningGateOverrideSummary[];
  readonly highRiskRecord?: Pick<
    RegisterRecord,
    'id' | 'reference' | 'status' | 'decidedById' | 'decidedAt'
  > | null;
  readonly highRiskPartnerApprover?: {
    readonly actorId: string;
    readonly actorName?: string | null;
    readonly transitionedAt: string;
  } | null;
  readonly requiresHighRiskApproval: boolean;
  readonly fundsOnAccountSatisfied?: boolean;
}

export function evaluateOpeningPreconditions(
  params: EvaluateOpeningPreconditionsInput,
): OpeningGateEvaluation {
  const {
    matter,
    gateConfig,
    cddStatus,
    activeOverrides,
    highRiskRecord,
    highRiskPartnerApprover,
    requiresHighRiskApproval,
    fundsOnAccountSatisfied = false,
  } = params;

  const activeByKey = new Map<OpeningGatePreconditionKey, OpeningGateOverrideSummary>();
  for (const ovr of activeOverrides) {
    if (!ovr.revokedAt && !activeByKey.has(ovr.preconditionKey)) {
      activeByKey.set(ovr.preconditionKey, ovr);
    }
  }

  const conflictPill = normaliseConflictStatusForGate(matter);
  const conflictRawSatisfied =
    conflictPill === 'Cleared' || conflictPill === 'Approved';
  const conflictNonOverridable =
    conflictPill === 'Referred' || conflictPill === 'Declined';
  const conflictOverride = !conflictNonOverridable
    ? activeByKey.get('conflict_cleared') ?? null
    : null;
  const conflictCanOverride =
    !conflictRawSatisfied && !conflictNonOverridable;
  const conflictSatisfied =
    !gateConfig.requireConflictCleared ||
    conflictRawSatisfied ||
    Boolean(conflictOverride);

  const conflictResult: OpeningGatePreconditionResult = {
    key: 'conflict_cleared',
    label: OPENING_GATE_PRECONDITION_LABELS.conflict_cleared,
    required: gateConfig.requireConflictCleared,
    rawSatisfied: conflictRawSatisfied,
    overridden: !conflictRawSatisfied && Boolean(conflictOverride),
    satisfied: conflictSatisfied,
    canOverride: conflictCanOverride,
    nonOverridableReason: conflictNonOverridable
      ? `Conflict status "${conflictPill}" cannot be overridden; it must be reviewed by Risk & Compliance.`
      : null,
    statusSummary: conflictRawSatisfied
      ? `${conflictPill}`
      : conflictOverride
        ? `${conflictPill} (overridden by partner)`
        : conflictPill === 'Referred'
          ? 'Referred to Risk & Compliance — override not permitted'
          : conflictPill === 'Declined'
            ? 'Declined by Risk & Compliance — override not permitted'
            : `Not cleared (${conflictPill})`,
    activeOverride: conflictOverride,
  };

  const cddRawSatisfied =
    cddStatus.status === 'recorded' && !cddStatus.isExpired;
  const cddAllowOverride = Boolean(gateConfig.allowCddOverride);
  const cddOverride = cddAllowOverride
    ? activeByKey.get('cdd_complete') ?? null
    : null;
  const cddSatisfied =
    !gateConfig.requireCddComplete || cddRawSatisfied || Boolean(cddOverride);
  const cddMasked = cddStatus.visibleToViewer === false;

  const cddResult: OpeningGatePreconditionResult = {
    key: 'cdd_complete',
    label: OPENING_GATE_PRECONDITION_LABELS.cdd_complete,
    required: gateConfig.requireCddComplete,
    rawSatisfied: cddRawSatisfied,
    overridden: !cddRawSatisfied && Boolean(cddOverride),
    satisfied: cddSatisfied,
    canOverride: !cddRawSatisfied && cddAllowOverride,
    nonOverridableReason: cddAllowOverride
      ? null
      : 'Client Due Diligence is mandatory for this high-ML-risk work type and cannot be overridden.',
    statusSummary: cddRawSatisfied
      ? 'Recorded and valid'
      : cddOverride
        ? 'Incomplete (overridden by partner)'
        : cddMasked
          ? cddAllowOverride
            ? 'Incomplete (restricted client CDD)'
            : 'Incomplete — override not permitted (restricted client CDD)'
          : cddStatus.isExpired
            ? 'Expired — re-check required'
            : cddStatus.status === 'in_progress'
              ? 'In progress'
              : 'Not started',
    activeOverride: cddOverride,
  };

  const engagementRawSatisfied = isMatterEngagementSignedForGate(matter);
  const engagementOverride = activeByKey.get('engagement_signed') ?? null;
  const engagementSatisfied =
    !gateConfig.requireEngagementSigned ||
    engagementRawSatisfied ||
    Boolean(engagementOverride);

  const engagementResult: OpeningGatePreconditionResult = {
    key: 'engagement_signed',
    label: OPENING_GATE_PRECONDITION_LABELS.engagement_signed,
    required: gateConfig.requireEngagementSigned,
    rawSatisfied: engagementRawSatisfied,
    overridden: !engagementRawSatisfied && Boolean(engagementOverride),
    satisfied: engagementSatisfied,
    canOverride: !engagementRawSatisfied,
    nonOverridableReason: null,
    statusSummary: engagementRawSatisfied
      ? `Signed${matter.engagementLetterSignedAt ? ` (${matter.engagementLetterSignedAt.slice(0, 10)})` : ''}`
      : engagementOverride
        ? 'Awaiting signature (overridden by partner)'
        : `Awaiting signed engagement (${matter.engagementLetterStatus || 'Not sent'})`,
    activeOverride: engagementOverride,
  };

  const fundsRawSatisfied = Boolean(fundsOnAccountSatisfied);
  const fundsOverride = activeByKey.get('funds_on_account') ?? null;
  const fundsSatisfied =
    !gateConfig.requireFundsOnAccount ||
    fundsRawSatisfied ||
    Boolean(fundsOverride);

  const fundsResult: OpeningGatePreconditionResult = {
    key: 'funds_on_account',
    label: OPENING_GATE_PRECONDITION_LABELS.funds_on_account,
    required: gateConfig.requireFundsOnAccount,
    rawSatisfied: fundsRawSatisfied,
    overridden: !fundsRawSatisfied && Boolean(fundsOverride),
    satisfied: fundsSatisfied,
    canOverride: !fundsRawSatisfied,
    nonOverridableReason: null,
    statusSummary: fundsRawSatisfied
      ? 'Funds received'
      : fundsOverride
        ? 'Awaiting funds (overridden by partner)'
        : 'Not yet required / awaiting cleared funds',
    activeOverride: fundsOverride,
  };

  const hroStatus = ((): OpeningGateHighRiskSummary['status'] => {
    if (!requiresHighRiskApproval) return 'not_required';
    const raw = highRiskRecord?.status;
    if (
      raw === 'pending_partner' ||
      raw === 'pending_compliance' ||
      raw === 'approved' ||
      raw === 'rejected' ||
      raw === 'withdrawn'
    ) {
      return raw;
    }
    return 'missing';
  })();

  const highRiskSatisfied = !requiresHighRiskApproval || hroStatus === 'approved';
  const highRiskStatusLabel = ((): string => {
    switch (hroStatus) {
      case 'not_required':
        return 'Not required';
      case 'pending_partner':
        return 'Pending Partner approval';
      case 'pending_compliance':
        return 'Pending Risk & Compliance approval';
      case 'approved':
        return 'Approved (Partner + Risk & Compliance)';
      case 'rejected':
        return 'Rejected — cannot open without re-submission';
      case 'withdrawn':
        return 'Withdrawn';
      case 'missing':
      default:
        return 'Pending two-stage High-risk approval';
    }
  })();

  const highRisk: OpeningGateHighRiskSummary = {
    required: requiresHighRiskApproval,
    satisfied: highRiskSatisfied,
    recordId: highRiskRecord?.id ?? null,
    reference: highRiskRecord?.reference ?? null,
    status: hroStatus,
    statusLabel: highRiskStatusLabel,
    partnerApproverId: highRiskPartnerApprover?.actorId ?? null,
    partnerApproverName: highRiskPartnerApprover?.actorName ?? null,
    partnerApprovedAt: highRiskPartnerApprover?.transitionedAt ?? null,
    decidedById: highRiskRecord?.decidedById ?? null,
    decidedAt: highRiskRecord?.decidedAt ?? null,
  };

  const preconditions = [
    conflictResult,
    cddResult,
    engagementResult,
    fundsResult,
  ] as const;

  const blockingReasons: string[] = [];
  for (const check of preconditions) {
    if (check.required && !check.satisfied) {
      blockingReasons.push(`${check.label}: ${check.statusSummary}`);
    }
  }
  if (requiresHighRiskApproval && !highRiskSatisfied) {
    blockingReasons.push(`High-risk opening sign-off: ${highRiskStatusLabel}`);
  }

  const canOpen =
    preconditions.every((p) => p.satisfied) && highRiskSatisfied;

  return {
    canOpen,
    requiresHighRiskApproval,
    highRisk,
    gateConfig,
    preconditions,
    blockingReasons,
    activeOverrides: Array.from(activeByKey.values()),
  };
}
