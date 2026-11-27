/**
 * Pure domain logic for Stage 1 S1-05 (ADRs 0039 & 0040):
 * - Per-work-type matter opening preconditions & partner overrides (`workTypes.*.openingGate`)
 * - Server-stamped signed engagement check (`R753`)
 * - Strictly key-based High / Critical risk identification (`R749`)
 *
 * Kept pure (no `server-only`, no repository imports) so server transactions,
 * page loaders, and client UI evaluate opening readiness identically.
 */

import { getEngagementStatusRank, type RegisterRecord } from '@platform/core-api';
import type { CddWorkflowStatus } from './cdd';
import { hasUnapprovedRestrictedMatches } from './matterConflicts';
import type { WorkTypeOpeningGateFields } from './workTypeConfig';
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

export function getEngagementLetterStatusRank(
  status: string | null | undefined,
): 0 | 1 | 2 | 3 {
  return getEngagementStatusRank(status);
}

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
  readonly rawSatisfied: boolean | null;
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

export interface OpeningGateHighRiskRecordView {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly rowVersion: number;
  readonly partnerApproverName: string | null;
  readonly complianceApproverName: string | null;
  readonly decidedAt: string | null;
}

export interface OpeningGateEvaluation {
  readonly canOpen: boolean;
  readonly requiresHighRiskApproval: boolean;
  readonly highRisk: OpeningGateHighRiskSummary;
  readonly gateConfig: WorkTypeOpeningGateFields;
  readonly preconditions: readonly OpeningGatePreconditionResult[];
  readonly blockingReasons: readonly string[];
  readonly activeOverrides: readonly OpeningGateOverrideSummary[];
}

export interface MatterOpeningGateView {
  readonly evaluation: OpeningGateEvaluation;
  readonly isProspective: boolean;
  readonly highRiskRecord: OpeningGateHighRiskRecordView | null;
  readonly canOverridePermission: boolean;
  readonly canEditMatter: boolean;
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
  matter: Pick<Matter, 'conflictCheckRecord'>,
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
  > & {
    readonly leadFeeEarnerId?: string | null;
    readonly responsiblePartnerId?: string | null;
  };
  readonly gateConfig: WorkTypeOpeningGateFields;
  readonly cddStatus: {
    readonly status: CddWorkflowStatus;
    readonly isExpired: boolean;
    readonly insufficientTier?: boolean;
    readonly visibleToViewer?: boolean;
    readonly missingClientNames?: readonly string[];
    readonly expiredClientNames?: readonly string[];
    readonly insufficientTierClientNames?: readonly string[];
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
  const hasUnapprovedRestricted = hasUnapprovedRestrictedMatches(
    matter.conflictCheckRecord?.matches ?? [],
    matter.conflictCheckRecord?.approvedRestrictedMatchIds,
  );
  const conflictRawSatisfied =
    (conflictPill === 'Cleared' || conflictPill === 'Approved') &&
    !hasUnapprovedRestricted;
  const conflictPolicyDisallowsOverride = !gateConfig.allowConflictOverride;
  const conflictNonOverridable =
    conflictPill === 'Referred' ||
    conflictPill === 'Declined' ||
    hasUnapprovedRestricted ||
    conflictPolicyDisallowsOverride;
  const conflictOverride = !conflictNonOverridable
    ? activeByKey.get('conflict_cleared') ?? null
    : null;
  const conflictCanOverride =
    !conflictRawSatisfied && !conflictNonOverridable;
  const conflictSatisfied =
    conflictRawSatisfied || Boolean(conflictOverride);

  const conflictNonOverridableReason = !conflictNonOverridable
    ? null
    : hasUnapprovedRestricted
      ? 'Conflict check has an unapproved restricted match; it must be reviewed by Risk & Compliance.'
      : conflictPill === 'Referred' || conflictPill === 'Declined'
        ? `Conflict status "${conflictPill}" cannot be overridden; it must be reviewed by Risk & Compliance.`
        : 'Incomplete conflict checks cannot be overridden for this work type.';

  const conflictStatusSummary = conflictRawSatisfied
    ? `${conflictPill}`
    : conflictOverride
      ? `${conflictPill} (overridden by partner)`
      : conflictPill === 'Referred'
        ? 'Referred to Risk & Compliance — override not permitted'
        : conflictPill === 'Declined'
          ? 'Declined by Risk & Compliance — override not permitted'
          : hasUnapprovedRestricted
            ? 'Unapproved restricted conflict match — Risk & Compliance review required'
            : `Not cleared (${conflictPill})`;

  const conflictResult: OpeningGatePreconditionResult = {
    key: 'conflict_cleared',
    label: OPENING_GATE_PRECONDITION_LABELS.conflict_cleared,
    required: true,
    rawSatisfied: conflictRawSatisfied,
    overridden: !conflictRawSatisfied && Boolean(conflictOverride),
    satisfied: conflictSatisfied,
    canOverride: conflictCanOverride,
    nonOverridableReason: conflictNonOverridableReason,
    statusSummary: conflictStatusSummary,
    activeOverride: conflictOverride,
  };

  const cddRawSatisfied =
    cddStatus.status === 'recorded' &&
    !cddStatus.isExpired &&
    !cddStatus.insufficientTier;
  const cddAllowOverride = Boolean(gateConfig.allowCddOverride);
  const cddOverride = cddAllowOverride
    ? activeByKey.get('cdd_complete') ?? null
    : null;
  const cddSatisfied =
    !gateConfig.requireCddComplete || cddRawSatisfied || Boolean(cddOverride);
  const cddMasked = cddStatus.visibleToViewer === false;

  const missingNames = cddStatus.missingClientNames ?? [];
  const expiredNames = cddStatus.expiredClientNames ?? [];
  const insufficientNames = cddStatus.insufficientTierClientNames ?? [];
  const cddDetailClients = [
    ...(insufficientNames.length > 0
      ? [`upgrade to High-risk CDD needed for ${insufficientNames.join(', ')}`]
      : []),
    ...(expiredNames.length > 0
      ? [`expired for ${expiredNames.join(', ')}`]
      : []),
    ...(missingNames.length > 0
      ? [`not recorded for ${missingNames.join(', ')}`]
      : []),
  ];

  const cddStatusSummary = cddMasked
    ? 'Not available to you'
    : cddRawSatisfied
      ? 'Recorded and valid'
      : cddOverride
        ? 'Incomplete (overridden by partner)'
        : cddDetailClients.length > 0
          ? cddDetailClients.join('; ')
          : cddStatus.insufficientTier
            ? 'High-risk CDD upgrade required'
            : cddStatus.isExpired
              ? 'Expired — re-check required'
              : cddStatus.status === 'in_progress'
                ? 'In progress'
                : 'Not started';

  const cddResult: OpeningGatePreconditionResult = cddMasked
    ? {
        key: 'cdd_complete',
        label: OPENING_GATE_PRECONDITION_LABELS.cdd_complete,
        required: gateConfig.requireCddComplete,
        rawSatisfied: null,
        overridden: false,
        satisfied: cddSatisfied,
        canOverride: false,
        nonOverridableReason:
          'You cannot override a client due diligence requirement that is not available to you.',
        statusSummary: 'Not available to you',
        activeOverride: null,
      }
    : {
        key: 'cdd_complete',
        label: OPENING_GATE_PRECONDITION_LABELS.cdd_complete,
        required: gateConfig.requireCddComplete,
        rawSatisfied: cddRawSatisfied,
        overridden: !cddRawSatisfied && Boolean(cddOverride),
        satisfied: cddSatisfied,
        canOverride: !cddRawSatisfied && cddAllowOverride,
        nonOverridableReason: cddAllowOverride
          ? null
          : 'Client Due Diligence is mandatory for this work type and cannot be overridden.',
        statusSummary: cddStatusSummary,
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

  const partnerIsMatterLeadOrResponsible = Boolean(
    highRiskPartnerApprover?.actorId &&
      (highRiskPartnerApprover.actorId === matter.leadFeeEarnerId ||
        highRiskPartnerApprover.actorId === matter.responsiblePartnerId),
  );
  const complianceIsMatterLeadOrResponsible = Boolean(
    hroStatus === 'approved' &&
      highRiskRecord?.decidedById &&
      (highRiskRecord.decidedById === matter.leadFeeEarnerId ||
        highRiskRecord.decidedById === matter.responsiblePartnerId),
  );
  const hroApproverIsMatterLeadOrResponsible =
    partnerIsMatterLeadOrResponsible || complianceIsMatterLeadOrResponsible;
  const highRiskSatisfied =
    !requiresHighRiskApproval ||
    (hroStatus === 'approved' && !hroApproverIsMatterLeadOrResponsible);
  const highRiskStatusLabel = ((): string => {
    if (
      requiresHighRiskApproval &&
      hroStatus === 'approved' &&
      hroApproverIsMatterLeadOrResponsible
    ) {
      return 'Independent partner and Risk & Compliance approval required (neither stage may be approved by the lead fee earner or responsible partner)';
    }
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
      if (check.key === 'cdd_complete' && cddMasked) {
        blockingReasons.push(
          'Client due diligence is not complete for one or more clients.',
        );
      } else {
        blockingReasons.push(`${check.label}: ${check.statusSummary}`);
      }
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
    activeOverrides: Array.from(activeByKey.values()).filter(
      (o) => !(cddMasked && o.preconditionKey === 'cdd_complete'),
    ),
  };
}

export const OPENING_GATE_INCONSISTENT_CODE = 'OPENING_GATE_INCONSISTENT' as const;

export const OPENING_GATE_INCONSISTENT_USER_MESSAGE =
  "This matter can't be opened yet. Refresh the page and check the opening checklist.";

export function createOpeningGateInconsistentError(): Error & {
  code: typeof OPENING_GATE_INCONSISTENT_CODE;
} {
  const err = new Error(OPENING_GATE_INCONSISTENT_USER_MESSAGE) as Error & {
    code: typeof OPENING_GATE_INCONSISTENT_CODE;
  };
  err.code = OPENING_GATE_INCONSISTENT_CODE;
  return err;
}

/**
 * Formats action/service error responses from matter opening, engagement,
 * override, or high-risk approval flows into plain British English without
 * exposing internal permission keys or engine role diagnostics (R784).
 */
export function formatOpeningGateActionError(
  err: {
    readonly code?: string;
    readonly message?: string;
    readonly error?: string;
  } | null | undefined,
  fallback = 'This action could not be completed. Check your permissions and try again.',
): string {
  const code = (err?.code ?? '').trim();
  const raw = (err?.message ?? err?.error ?? '').trim();

  if (code === OPENING_GATE_INCONSISTENT_CODE) {
    return OPENING_GATE_INCONSISTENT_USER_MESSAGE;
  }
  if (code === 'MFA_REQUIRED' || /multi-factor authentication/i.test(raw)) {
    return 'Please complete multi-factor authentication before performing this action.';
  }
  if (code === 'MATTER_CONCURRENCY_CONFLICT') {
    return 'This matter changed while you were working. Refresh and try again.';
  }
  if (code === 'REGISTER_SELF_APPROVAL_FORBIDDEN') {
    return 'You cannot approve a High-risk matter opening for a matter where you submitted the record, lead the work, or are the responsible partner.';
  }
  if (code === 'REGISTER_DISTINCT_APPROVER_REQUIRED') {
    return 'Risk & Compliance approval must be completed by a different person from the Partner approver.';
  }
  if (code === 'REGISTER_APPROVER_MISMATCH' || /allowedRoles|allowedApproverRoles/i.test(raw)) {
    return 'Your role cannot complete this approval stage.';
  }
  if (code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    if (raw && !/[a-z_]+:[a-z_]+/i.test(raw)) {
      return raw;
    }
    return 'You do not have permission to carry out this action.';
  }
  if (raw) {
    const cleaned = raw
      .replace(/\s*\([a-z][a-z0-9_]*(?::[a-z0-9_]+)+\)/gi, '')
      .replace(/\b[a-z][a-z0-9_]*(?::[a-z0-9_]+)+\b/gi, 'required permission')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }
  return fallback;
}

export type OpeningGateCddOutcomeStatus =
  | 'Verified'
  | 'Overridden'
  | 'Not required';

/**
 * Computes the server-stamped matter `amlStatus` recorded when a prospective
 * matter opens through the opening gate (R810, R813 fail closed).
 */
export function resolveOpeningGateCddOutcome(params: {
  readonly gateConfig: Pick<WorkTypeOpeningGateFields, 'requireCddComplete'>;
  readonly cddRawSatisfied: boolean;
  readonly hasActiveCddOverride: boolean;
}): OpeningGateCddOutcomeStatus {
  if (!params.gateConfig.requireCddComplete) {
    return 'Not required';
  }
  if (params.cddRawSatisfied) {
    return 'Verified';
  }
  if (params.hasActiveCddOverride) {
    return 'Overridden';
  }
  throw createOpeningGateInconsistentError();
}
