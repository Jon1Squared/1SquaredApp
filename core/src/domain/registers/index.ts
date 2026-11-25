/**
 * Configurable Firm Registers & Undertakings Domain Engine (`core/src/domain/registers/`).
 *
 * Pure, tenant-agnostic core domain logic (ADR 0032, S0-24):
 * - Defines canonical `CORE_REGISTER_TYPES` (`sign_off`, `undertaking`, `complaint`, `breach`)
 * - Merges `tenantConfig.registers` and `tenant_module_configs['registers']` overrides cleanly
 * - Validates register record field payloads against configured `RegisterFieldDefinition` lists
 * - Enforces state-machine transition rules, direct undertaking creation (`approvalRules: null`),
 *   unconditional self-approval prohibition on approval registers, and assigned-approver matching
 * - Evaluates deterministic reminder stages (`dueDaysBefore` / `reviewDaysBefore`) in tenant local timezone
 */

import type {
  CddChecklistItemTemplate,
  CddChecklistTemplateSet,
  CddClientCategoryKey,
  CddConfiguration,
  CddRiskTierKey,
  IntakeEvidenceArtifactRef,
  PermissionKey,
  RegisterApprovalRules,
  RegisterChecklistItemValue,
  RegisterFieldDefinition,
  RegisterPermission,
  RegisterRecord,
  RegisterReminderScheduleConfig,
  RegistersConfiguration,
  RegisterStateDefinition,
  RegisterTransition,
  RegisterTransitionDefinition,
  RegisterTypeDefinition,
  RegisterTypeOverride,
  TenantConfiguration,
} from '../../api/index';

export const REGISTER_DOMAIN_ERROR_CODES = {
  VALIDATION_ERROR: 'REGISTER_VALIDATION_ERROR',
  INVALID_TRANSITION: 'REGISTER_INVALID_TRANSITION',
  SYSTEM_ONLY_TRANSITION: 'REGISTER_SYSTEM_ONLY_TRANSITION',
  SELF_APPROVAL_FORBIDDEN: 'REGISTER_SELF_APPROVAL_FORBIDDEN',
  APPROVER_MISMATCH: 'REGISTER_APPROVER_MISMATCH',
  DISTINCT_APPROVER_REQUIRED: 'REGISTER_DISTINCT_APPROVER_REQUIRED',
  CONCURRENCY_CONFLICT: 'REGISTER_CONCURRENCY_CONFLICT',
  NOT_FOUND: 'REGISTER_NOT_FOUND',
  TYPE_DISABLED: 'REGISTER_TYPE_DISABLED',
} as const;

export type RegisterDomainErrorCode =
  (typeof REGISTER_DOMAIN_ERROR_CODES)[keyof typeof REGISTER_DOMAIN_ERROR_CODES];

export function createRegisterDomainError(
  code: RegisterDomainErrorCode,
  message: string,
): Error & { code: RegisterDomainErrorCode } {
  const err = new Error(`${code}: ${message}`) as Error & {
    code: RegisterDomainErrorCode;
  };
  err.code = code;
  return err;
}

export const DEFAULT_REGISTER_REMINDER_HOUR_LOCAL = 8;
export const DEFAULT_REGISTER_DUE_DAYS_BEFORE: readonly number[] = Object.freeze([
  14, 7, 1, 0, -1, -7,
]);
export const DEFAULT_REGISTER_REVIEW_DAYS_BEFORE: readonly number[] = Object.freeze([
  14, 7, 0,
]);

export const DEFAULT_REGISTERS_CONFIG: RegistersConfiguration = Object.freeze({
  defaultReminderHourLocal: DEFAULT_REGISTER_REMINDER_HOUR_LOCAL,
  defaultDueDaysBefore: [...DEFAULT_REGISTER_DUE_DAYS_BEFORE],
  defaultReviewDaysBefore: [...DEFAULT_REGISTER_REVIEW_DAYS_BEFORE],
  customTypes: [],
  typeOverrides: {},
});

export const CORE_REGISTER_TYPES: Readonly<
  Record<
    'sign_off' | 'undertaking' | 'complaint' | 'breach' | 'cdd' | 'high_risk_opening',
    RegisterTypeDefinition
  >
> = Object.freeze({
  sign_off: {
    key: 'sign_off',
    label: 'Sign-Off',
    pluralLabel: 'Sign-Offs',
    description:
      'Partner sign-offs for write-offs requiring two-person approval.',
    isCore: true,
    enabled: true,
    referencePrefix: 'SO',
    initialStatus: 'pending_approval',
    createPermission: 'register:create',
    editPermission: 'register:edit',
    requireMatterLink: false,
    approvalRules: {
      requireTwoPersonApproval: true,
      forbidSelfApproval: true,
      allowedApproverRoles: [
        'partner',
        'managing_partner',
        'risk_compliance',
        'supervisor',
      ],
      requireAssignedApproverMatch: true,
    },
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [7, 1, 0],
      reviewDaysBefore: [],
      recipientMode: 'owner_and_approver',
    },
    states: [
      { key: 'pending_approval', label: 'Pending approval', isTerminal: false, tone: 'warning' },
      { key: 'discussing', label: 'Discussing', isTerminal: false, tone: 'info' },
      { key: 'approved', label: 'Approved', isTerminal: true, tone: 'success' },
      { key: 'rejected', label: 'Rejected', isTerminal: true, tone: 'danger' },
    ],
    transitions: [
      {
        key: 'discuss',
        label: 'Request discussion',
        fromStatuses: ['pending_approval', 'discussing'],
        toStatus: 'discussing',
        requiredPermission: 'register:approve',
        forbidSelfAction: true,
        requireAssignedApproverMatch: true,
      },
      {
        key: 'resubmit',
        label: 'Resubmit for approval',
        fromStatuses: ['discussing'],
        toStatus: 'pending_approval',
        requiredPermission: 'register:edit',
      },
      {
        key: 'approve',
        label: 'Approve',
        fromStatuses: ['pending_approval', 'discussing'],
        toStatus: 'approved',
        requiredPermission: 'register:approve',
        forbidSelfAction: true,
        requireAssignedApproverMatch: true,
        setsDecidedAt: true,
      },
      {
        key: 'reject',
        label: 'Reject',
        fromStatuses: ['pending_approval', 'discussing'],
        toStatus: 'rejected',
        requiredPermission: 'register:approve',
        requiresComment: true,
        forbidSelfAction: true,
        requireAssignedApproverMatch: true,
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'signOffKind',
        label: 'Sign-off category',
        type: 'select',
        required: true,
        options: ['write_off', 'matter_opening'],
        defaultValue: 'write_off',
      },
      {
        key: 'matterNumber',
        label: 'Matter reference',
        type: 'text',
      },
      {
        key: 'subtitle',
        label: 'Context summary',
        type: 'text',
      },
      {
        key: 'amountGbp',
        label: 'Amount (GBP)',
        type: 'currency_gbp',
      },
      {
        key: 'discussionNote',
        label: 'Discussion note',
        type: 'textarea',
      },
    ],
    showInNavigation: true,
  },
  undertaking: {
    key: 'undertaking',
    label: 'Undertaking',
    pluralLabel: 'Undertakings',
    description:
      'Solicitor and firm undertakings created directly by practising fee earners with discharge tracking and reminders.',
    isCore: true,
    enabled: true,
    referencePrefix: 'UND',
    initialStatus: 'open',
    createPermission: 'undertaking:manage',
    editPermission: 'undertaking:manage',
    requireMatterLink: false,
    // ADR 0032 Amendment 2: direct undertaking creation without two-person partner approval
    approvalRules: null,
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [14, 7, 1, 0, -1, -7],
      reviewDaysBefore: [14, 7, 0],
      recipientMode: 'matter_team_and_owner',
    },
    states: [
      { key: 'open', label: 'Open', isTerminal: false, tone: 'info' },
      { key: 'varied', label: 'Varied', isTerminal: false, tone: 'warning' },
      { key: 'overdue', label: 'Overdue', isTerminal: false, tone: 'danger' },
      { key: 'discharged', label: 'Discharged', isTerminal: true, tone: 'success' },
      { key: 'cancelled', label: 'Cancelled', isTerminal: true, tone: 'neutral' },
    ],
    transitions: [
      {
        key: 'vary',
        label: 'Record variation',
        fromStatuses: ['open', 'overdue'],
        toStatus: 'varied',
        requiredPermission: 'undertaking:manage',
        requiresComment: true,
      },
      {
        key: 'reopen',
        label: 'Reopen undertaking',
        fromStatuses: ['varied', 'overdue'],
        toStatus: 'open',
        requiredPermission: 'undertaking:manage',
      },
      {
        key: 'mark_overdue',
        label: 'Mark overdue',
        fromStatuses: ['open', 'varied'],
        toStatus: 'overdue',
        requiredPermission: 'undertaking:manage',
      },
      {
        key: 'discharge',
        label: 'Discharge undertaking',
        fromStatuses: ['open', 'varied', 'overdue'],
        toStatus: 'discharged',
        requiredPermission: 'undertaking:manage',
        setsDecidedAt: true,
      },
      {
        key: 'cancel',
        label: 'Cancel / withdraw',
        fromStatuses: ['open', 'varied', 'overdue'],
        toStatus: 'cancelled',
        requiredPermission: 'undertaking:manage',
        requiresComment: true,
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'recipientName',
        label: 'Recipient / counterparty',
        type: 'text',
        required: true,
        description: 'Firm, lender, or party receiving the benefit of the undertaking.',
      },
      {
        key: 'undertakingTerms',
        label: 'Terms of undertaking',
        type: 'textarea',
        required: true,
        description: 'Exact wording and scope of the professional undertaking.',
      },
      {
        key: 'givenByPersonId',
        label: 'Given by fee earner',
        type: 'person',
        required: true,
      },
      {
        key: 'dischargeCriteria',
        label: 'Discharge conditions',
        type: 'textarea',
      },
      {
        key: 'dischargeEvidence',
        label: 'Discharge confirmation',
        type: 'textarea',
      },
      {
        key: 'variationSummary',
        label: 'Variation note',
        type: 'textarea',
      },
    ],
    showInNavigation: true,
  },
  complaint: {
    key: 'complaint',
    label: 'Client Complaint',
    pluralLabel: 'Complaints',
    description:
      'First-tier client complaints, investigation ownership, and LeO escalation timeframe tracking.',
    isCore: true,
    enabled: true,
    referencePrefix: 'CMP',
    initialStatus: 'open',
    createPermission: 'register:create',
    editPermission: 'register:edit',
    requireMatterLink: false,
    approvalRules: null,
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [14, 7, 1, 0, -1],
      reviewDaysBefore: [7, 0],
      recipientMode: 'owner_and_approver',
    },
    states: [
      { key: 'open', label: 'Open', isTerminal: false, tone: 'warning' },
      { key: 'investigating', label: 'Under investigation', isTerminal: false, tone: 'info' },
      { key: 'resolved', label: 'Resolved', isTerminal: true, tone: 'success' },
      { key: 'closed', label: 'Closed', isTerminal: true, tone: 'neutral' },
    ],
    transitions: [
      {
        key: 'investigate',
        label: 'Begin investigation',
        fromStatuses: ['open'],
        toStatus: 'investigating',
        requiredPermission: 'register:edit',
      },
      {
        key: 'resolve',
        label: 'Mark resolved',
        fromStatuses: ['open', 'investigating'],
        toStatus: 'resolved',
        requiredPermission: 'register:approve',
        requiresComment: true,
        setsDecidedAt: true,
      },
      {
        key: 'close',
        label: 'Close complaint',
        fromStatuses: ['open', 'investigating', 'resolved'],
        toStatus: 'closed',
        requiredPermission: 'register:approve',
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'complainantName',
        label: 'Complainant name',
        type: 'text',
        required: true,
      },
      {
        key: 'complaintSummary',
        label: 'Summary of complaint',
        type: 'textarea',
        required: true,
      },
      {
        key: 'resolutionNotes',
        label: 'Outcome / resolution summary',
        type: 'textarea',
      },
    ],
    showInNavigation: true,
  },
  breach: {
    key: 'breach',
    label: 'Compliance Breach',
    pluralLabel: 'Breaches & Incidents',
    description:
      'COLP, COFA, and SRA regulatory breach register requiring independent compliance sign-off to close.',
    isCore: true,
    enabled: true,
    referencePrefix: 'BRC',
    initialStatus: 'logged',
    createPermission: 'register:create',
    editPermission: 'register:edit',
    requireMatterLink: false,
    approvalRules: {
      requireTwoPersonApproval: true,
      forbidSelfApproval: true,
      allowedApproverRoles: ['risk_compliance', 'managing_partner', 'partner'],
      requireAssignedApproverMatch: false,
    },
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [7, 1, 0],
      reviewDaysBefore: [30, 7, 0],
      recipientMode: 'owner_and_approver',
    },
    states: [
      { key: 'logged', label: 'Logged', isTerminal: false, tone: 'danger' },
      { key: 'remediation', label: 'Remediation in progress', isTerminal: false, tone: 'warning' },
      { key: 'closed', label: 'Closed', isTerminal: true, tone: 'success' },
    ],
    transitions: [
      {
        key: 'start_remediation',
        label: 'Start remediation',
        fromStatuses: ['logged'],
        toStatus: 'remediation',
        requiredPermission: 'register:edit',
      },
      {
        key: 'close_breach',
        label: 'Sign off & close',
        fromStatuses: ['logged', 'remediation'],
        toStatus: 'closed',
        requiredPermission: 'register:approve',
        requiresComment: true,
        forbidSelfAction: true,
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'regulatoryCategory',
        label: 'Regulatory category',
        type: 'select',
        required: true,
        options: ['COLP', 'COFA', 'AML / CFT', 'Confidentiality / Security', 'Other'],
        defaultValue: 'COLP',
      },
      {
        key: 'breachSummary',
        label: 'Incident summary',
        type: 'textarea',
        required: true,
      },
      {
        key: 'materialityAssessment',
        label: 'Materiality assessment',
        type: 'select',
        options: ['Non-material', 'Material - SRA report required'],
        defaultValue: 'Non-material',
      },
      {
        key: 'remediationPlan',
        label: 'Remediation plan',
        type: 'textarea',
      },
    ],
    showInNavigation: true,
  },
  cdd: {
    key: 'cdd',
    label: 'Client Due Diligence',
    pluralLabel: 'Client Due Diligence',
    description:
      'Client-subject due diligence checklists, manual ID and sanctions/PEP evidence, and scheduled re-check tracking.',
    isCore: true,
    enabled: true,
    referencePrefix: 'CDD',
    initialStatus: 'in_progress',
    viewPermission: 'cdd:view',
    createPermission: 'cdd:record',
    editPermission: 'cdd:record',
    subjectScope: 'client',
    requireMatterLink: false,
    systemCreatedOnly: true,
    approvalRules: null,
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [30, 7, 0, -7, -30],
      reviewDaysBefore: [],
      recipientMode: 'client_owner_or_recent_fee_earner',
    },
    states: [
      { key: 'in_progress', label: 'In progress', isTerminal: false, tone: 'warning' },
      { key: 'recorded', label: 'Recorded', isTerminal: false, tone: 'success' },
      { key: 'archived', label: 'Archived', isTerminal: true, tone: 'neutral' },
      { key: 'superseded', label: 'Superseded', isTerminal: true, tone: 'neutral' },
    ],
    transitions: [
      {
        key: 'record_cdd',
        label: 'Mark CDD recorded',
        fromStatuses: ['in_progress', 'recorded'],
        toStatus: 'recorded',
        requiredPermission: 'cdd:record',
        systemOnly: true,
        setsDecidedAt: true,
      },
      {
        key: 'upgrade_to_high_risk',
        label: 'Upgrade to High-risk CDD',
        fromStatuses: ['in_progress', 'recorded'],
        toStatus: 'in_progress',
        requiredPermission: 'cdd:record',
        systemOnly: true,
      },
      {
        key: 'archive_cdd',
        label: 'Archive CDD record',
        fromStatuses: ['in_progress', 'recorded'],
        toStatus: 'archived',
        requiredPermission: 'cdd:record',
        requiresComment: true,
        setsDecidedAt: true,
      },
      {
        key: 'supersede_cdd',
        label: 'Supersede CDD record',
        fromStatuses: ['in_progress', 'recorded'],
        toStatus: 'superseded',
        requiredPermission: 'cdd:record',
        requiresComment: true,
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'clientCategory',
        label: 'Client CDD category',
        type: 'select',
        required: true,
        options: ['individual', 'company_or_llp', 'trust_charity_or_partnership'],
      },
      {
        key: 'riskTier',
        label: 'CDD tier',
        type: 'select',
        required: true,
        options: ['standard', 'high'],
        defaultValue: 'standard',
      },
      {
        key: 'checklistItems',
        label: 'CDD checklist items',
        type: 'checklist',
        required: true,
      },
      {
        key: 'supportingEvidence',
        label: 'Supporting evidence',
        type: 'evidence',
        required: false,
      },
      {
        key: 'manualSummaryNote',
        label: 'Compliance notes',
        type: 'textarea',
        required: false,
      },
    ],
    showInNavigation: true,
  },
  high_risk_opening: {
    key: 'high_risk_opening',
    label: 'High-Risk Matter Opening',
    pluralLabel: 'High-Risk Matter Openings',
    description:
      'Mandatory two-stage sign-off (Partner followed by a different Risk & Compliance officer) before opening High- or Critical-risk matters.',
    isCore: true,
    enabled: true,
    referencePrefix: 'HRO',
    initialStatus: 'pending_partner',
    createPermission: 'register:create',
    editPermission: 'register:edit',
    subjectScope: 'matter',
    requireMatterLink: true,
    systemCreatedOnly: true,
    approvalRules: {
      requireTwoPersonApproval: true,
      forbidSelfApproval: true,
      requireAssignedApproverMatch: false,
      allowAdminBypass: false,
    },
    reminderSchedule: {
      enabled: true,
      dueDaysBefore: [7, 1, 0],
      reviewDaysBefore: [],
      recipientMode: 'owner_and_approver',
    },
    states: [
      { key: 'pending_partner', label: 'Pending Partner approval', isTerminal: false, tone: 'warning' },
      { key: 'pending_compliance', label: 'Pending Risk & Compliance approval', isTerminal: false, tone: 'info' },
      { key: 'approved', label: 'Approved', isTerminal: true, tone: 'success' },
      { key: 'rejected', label: 'Rejected', isTerminal: true, tone: 'danger' },
      { key: 'withdrawn', label: 'Withdrawn', isTerminal: true, tone: 'neutral' },
    ],
    transitions: [
      {
        key: 'partner_approve',
        label: 'Partner approve',
        fromStatuses: ['pending_partner'],
        toStatus: 'pending_compliance',
        requiredPermission: 'register:approve',
        allowedRoles: ['partner', 'managing_partner'],
        forbidSelfAction: true,
        requiresComment: false,
      },
      {
        key: 'compliance_approve',
        label: 'Compliance approve',
        fromStatuses: ['pending_compliance'],
        toStatus: 'approved',
        requiredPermission: 'register:approve',
        allowedRoles: ['risk_compliance'],
        forbidSelfAction: true,
        mustDifferFromPreviousApprover: true,
        distinctFromTransitionKeys: ['partner_approve'],
        setsDecidedAt: true,
      },
      {
        key: 'reject_opening',
        label: 'Reject high-risk opening',
        fromStatuses: ['pending_partner', 'pending_compliance'],
        toStatus: 'rejected',
        requiredPermission: 'register:approve',
        allowedRoles: ['partner', 'managing_partner', 'risk_compliance'],
        forbidSelfAction: true,
        requiresComment: true,
        setsDecidedAt: true,
      },
      {
        key: 'withdraw_opening',
        label: 'Withdraw high-risk opening',
        fromStatuses: ['pending_partner', 'pending_compliance'],
        toStatus: 'withdrawn',
        requiredPermission: 'register:edit',
        systemOnly: true,
        setsDecidedAt: true,
      },
    ],
    fields: [
      {
        key: 'matterNumber',
        label: 'Matter number',
        type: 'text',
        required: false,
      },
      {
        key: 'riskLevel',
        label: 'Risk rating',
        type: 'text',
        required: false,
      },
      {
        key: 'submittedById',
        label: 'Submitted by',
        type: 'person',
        required: false,
      },
    ],
    showInNavigation: true,
  },
});

const CORE_REGISTER_KEY_SET = new Set<string>(Object.keys(CORE_REGISTER_TYPES));

function cloneStateDefinition(stateDef: RegisterStateDefinition): RegisterStateDefinition {
  return {
    key: stateDef.key,
    label: stateDef.label,
    isTerminal: stateDef.isTerminal ?? false,
    tone: stateDef.tone ?? 'neutral',
  };
}

function cloneFieldDefinition(fieldDef: RegisterFieldDefinition): RegisterFieldDefinition {
  return {
    key: fieldDef.key,
    label: fieldDef.label,
    type: fieldDef.type,
    required: fieldDef.required ?? false,
    ...(fieldDef.description !== undefined ? { description: fieldDef.description } : {}),
    ...(fieldDef.options ? { options: [...fieldDef.options] } : {}),
    ...(fieldDef.defaultValue !== undefined ? { defaultValue: fieldDef.defaultValue } : {}),
  };
}

function cloneTransitionDefinition(
  transitionDef: RegisterTransitionDefinition,
): RegisterTransitionDefinition {
  return {
    key: transitionDef.key,
    label: transitionDef.label,
    fromStatuses: [...transitionDef.fromStatuses],
    toStatus: transitionDef.toStatus,
    requiredPermission: transitionDef.requiredPermission,
    ...(transitionDef.allowedRoles
      ? { allowedRoles: [...transitionDef.allowedRoles] }
      : {}),
    requiresComment: transitionDef.requiresComment ?? false,
    forbidSelfAction: transitionDef.forbidSelfAction ?? false,
    requireAssignedApproverMatch: transitionDef.requireAssignedApproverMatch ?? false,
    ...(transitionDef.mustDifferFromPreviousApprover !== undefined
      ? { mustDifferFromPreviousApprover: Boolean(transitionDef.mustDifferFromPreviousApprover) }
      : {}),
    ...(transitionDef.distinctFromTransitionKeys
      ? { distinctFromTransitionKeys: [...transitionDef.distinctFromTransitionKeys] }
      : {}),
    ...(transitionDef.systemOnly !== undefined
      ? { systemOnly: Boolean(transitionDef.systemOnly) }
      : {}),
    setsDecidedAt: transitionDef.setsDecidedAt ?? false,
  };
}

function cloneApprovalRules(
  approvalRules: RegisterApprovalRules | null,
): RegisterApprovalRules | null {
  if (!approvalRules) return null;
  if (approvalRules.forbidSelfApproval !== true) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      'Register approvalRules must unconditionally enforce forbidSelfApproval: true.',
    );
  }
  return {
    requireTwoPersonApproval: Boolean(approvalRules.requireTwoPersonApproval),
    forbidSelfApproval: true,
    ...(approvalRules.allowedApproverRoles
      ? { allowedApproverRoles: [...approvalRules.allowedApproverRoles] }
      : {}),
    requireAssignedApproverMatch: Boolean(approvalRules.requireAssignedApproverMatch),
    ...(approvalRules.allowAdminBypass !== undefined
      ? { allowAdminBypass: Boolean(approvalRules.allowAdminBypass) }
      : {}),
  };
}

function cloneReminderSchedule(
  reminderSchedule: RegisterReminderScheduleConfig,
  defaultDueDays: readonly number[],
  defaultReviewDays: readonly number[],
): RegisterReminderScheduleConfig {
  return {
    enabled: Boolean(reminderSchedule.enabled),
    dueDaysBefore: [...(reminderSchedule.dueDaysBefore ?? defaultDueDays)],
    reviewDaysBefore: [...(reminderSchedule.reviewDaysBefore ?? defaultReviewDays)],
    recipientMode: reminderSchedule.recipientMode ?? 'owner_and_approver',
  };
}

export function validateRegisterTypeDefinition(
  customRegisterType: RegisterTypeDefinition,
  defaultDueDays: readonly number[] = DEFAULT_REGISTER_DUE_DAYS_BEFORE,
  defaultReviewDays: readonly number[] = DEFAULT_REGISTER_REVIEW_DAYS_BEFORE,
): RegisterTypeDefinition {
  if (!customRegisterType.key || !/^[a-z][a-z0-9_]{1,47}$/.test(customRegisterType.key)) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Invalid register type key "${customRegisterType.key}".`,
    );
  }
  const states = (customRegisterType.states ?? []).map(cloneStateDefinition);
  if (states.length === 0) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Register type "${customRegisterType.key}" must declare at least one state.`,
    );
  }
  const stateKeySet = new Set(states.map((s) => s.key));
  if (!stateKeySet.has(customRegisterType.initialStatus)) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Register type "${customRegisterType.key}" initialStatus "${customRegisterType.initialStatus}" is not in states.`,
    );
  }
  const transitions = (customRegisterType.transitions ?? []).map(cloneTransitionDefinition);
  const transitionKeys = new Set<string>();
  for (const t of transitions) {
    if (transitionKeys.has(t.key)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Register type "${customRegisterType.key}" contains duplicate transition key "${t.key}".`,
      );
    }
    transitionKeys.add(t.key);
    if (!stateKeySet.has(t.toStatus)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Transition "${t.key}" on register "${customRegisterType.key}" points to unknown toStatus "${t.toStatus}".`,
      );
    }
    for (const fromStatus of t.fromStatuses) {
      if (!stateKeySet.has(fromStatus)) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
          `Transition "${t.key}" on register "${customRegisterType.key}" references unknown fromStatus "${fromStatus}".`,
        );
      }
    }
  }
  const fields = (customRegisterType.fields ?? []).map(cloneFieldDefinition);
  const fieldKeys = new Set<string>();
  for (const f of fields) {
    if (fieldKeys.has(f.key)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Register type "${customRegisterType.key}" contains duplicate field key "${f.key}".`,
      );
    }
    fieldKeys.add(f.key);
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Select field "${f.key}" on register "${customRegisterType.key}" must define at least one option.`,
      );
    }
  }
  return {
    key: customRegisterType.key,
    label: customRegisterType.label,
    pluralLabel: customRegisterType.pluralLabel,
    description: customRegisterType.description,
    isCore: Boolean(customRegisterType.isCore),
    enabled: customRegisterType.enabled ?? true,
    referencePrefix: customRegisterType.referencePrefix,
    initialStatus: customRegisterType.initialStatus,
    ...(customRegisterType.viewPermission !== undefined
      ? { viewPermission: customRegisterType.viewPermission }
      : {}),
    createPermission: customRegisterType.createPermission,
    editPermission: customRegisterType.editPermission,
    ...(customRegisterType.subjectScope !== undefined
      ? { subjectScope: customRegisterType.subjectScope }
      : {}),
    requireMatterLink: Boolean(customRegisterType.requireMatterLink),
    ...(customRegisterType.systemCreatedOnly !== undefined
      ? { systemCreatedOnly: Boolean(customRegisterType.systemCreatedOnly) }
      : {}),
    approvalRules: cloneApprovalRules(customRegisterType.approvalRules),
    reminderSchedule: cloneReminderSchedule(
      customRegisterType.reminderSchedule,
      defaultDueDays,
      defaultReviewDays,
    ),
    states,
    transitions,
    fields,
    showInNavigation: customRegisterType.showInNavigation ?? true,
  };
}

function applyRegisterTypeOverride(
  baseType: RegisterTypeDefinition,
  typeOverride: RegisterTypeOverride,
): RegisterTypeDefinition {
  if (
    baseType.key === 'cdd' &&
    (typeOverride.additionalFields?.length ?? 0) > 0
  ) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `System-managed register "${baseType.key}" does not allow firm-defined additionalFields.`,
    );
  }
  if (baseType.key === 'high_risk_opening' && typeOverride.enabled === false) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      'Core register "high_risk_opening" cannot be disabled (core-locked governance rule).',
    );
  }
  const nextFields = baseType.fields.map(cloneFieldDefinition);
  const existingKeys = new Set(nextFields.map((f) => f.key));
  for (const extraField of typeOverride.additionalFields ?? []) {
    if (existingKeys.has(extraField.key)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Cannot override core field "${extraField.key}" on register "${baseType.key}" via additionalFields.`,
      );
    }
    existingKeys.add(extraField.key);
    nextFields.push(cloneFieldDefinition(extraField));
  }
  const rsOverride = typeOverride.reminderSchedule;
  return {
    ...baseType,
    enabled: typeOverride.enabled ?? baseType.enabled,
    label: typeOverride.label ?? baseType.label,
    pluralLabel: typeOverride.pluralLabel ?? baseType.pluralLabel,
    description: typeOverride.description ?? baseType.description,
    showInNavigation: typeOverride.showInNavigation ?? baseType.showInNavigation,
    ...(baseType.key === 'high_risk_opening' || baseType.key === 'cdd'
      ? { systemCreatedOnly: true }
      : baseType.systemCreatedOnly !== undefined
        ? { systemCreatedOnly: baseType.systemCreatedOnly }
        : {}),
    reminderSchedule: {
      enabled: rsOverride?.enabled ?? baseType.reminderSchedule.enabled,
      dueDaysBefore: rsOverride?.dueDaysBefore
        ? [...rsOverride.dueDaysBefore]
        : [...baseType.reminderSchedule.dueDaysBefore],
      reviewDaysBefore: rsOverride?.reviewDaysBefore
        ? [...rsOverride.reviewDaysBefore]
        : [...baseType.reminderSchedule.reviewDaysBefore],
      recipientMode: rsOverride?.recipientMode ?? baseType.reminderSchedule.recipientMode,
    },
    fields: nextFields,
  };
}

export function mergeRegistersConfigurations(
  baseConfig?: RegistersConfiguration | null,
  overrideConfig?: RegistersConfiguration | null,
): RegistersConfiguration {
  const base = baseConfig ?? DEFAULT_REGISTERS_CONFIG;
  const override = overrideConfig ?? null;

  const customByKey = new Map<string, RegisterTypeDefinition>();
  for (const item of base.customTypes ?? []) {
    customByKey.set(item.key, item);
  }
  for (const item of override?.customTypes ?? []) {
    customByKey.set(item.key, item);
  }

  const mergedOverrides: Record<string, RegisterTypeOverride> = {};
  for (const [k, v] of Object.entries(base.typeOverrides ?? {})) {
    mergedOverrides[k] = { ...v };
  }
  for (const [k, v] of Object.entries(override?.typeOverrides ?? {})) {
    mergedOverrides[k] = {
      ...(mergedOverrides[k] ?? {}),
      ...v,
      ...(mergedOverrides[k]?.reminderSchedule || v.reminderSchedule
        ? {
            reminderSchedule: {
              ...(mergedOverrides[k]?.reminderSchedule ?? {}),
              ...(v.reminderSchedule ?? {}),
            },
          }
        : {}),
      ...(v.additionalFields !== undefined
        ? { additionalFields: [...v.additionalFields] }
        : {}),
    };
  }

  return {
    defaultReminderHourLocal:
      override?.defaultReminderHourLocal ??
      base.defaultReminderHourLocal ??
      DEFAULT_REGISTER_REMINDER_HOUR_LOCAL,
    defaultDueDaysBefore: override?.defaultDueDaysBefore
      ? [...override.defaultDueDaysBefore]
      : base.defaultDueDaysBefore
        ? [...base.defaultDueDaysBefore]
        : [...DEFAULT_REGISTER_DUE_DAYS_BEFORE],
    defaultReviewDaysBefore: override?.defaultReviewDaysBefore
      ? [...override.defaultReviewDaysBefore]
      : base.defaultReviewDaysBefore
        ? [...base.defaultReviewDaysBefore]
        : [...DEFAULT_REGISTER_REVIEW_DAYS_BEFORE],
    customTypes: [...customByKey.values()],
    typeOverrides: mergedOverrides,
  };
}

export function resolveEffectiveRegisterTypes(
  tenantRegistersConfig?: RegistersConfiguration | null,
  moduleOverrideConfig?: RegistersConfiguration | null,
): RegisterTypeDefinition[] {
  const merged = mergeRegistersConfigurations(tenantRegistersConfig, moduleOverrideConfig);
  const defaultDueDays = merged.defaultDueDaysBefore ?? DEFAULT_REGISTER_DUE_DAYS_BEFORE;
  const defaultReviewDays = merged.defaultReviewDaysBefore ?? DEFAULT_REGISTER_REVIEW_DAYS_BEFORE;

  const resolvedMap = new Map<string, RegisterTypeDefinition>();
  for (const coreType of Object.values(CORE_REGISTER_TYPES)) {
    resolvedMap.set(
      coreType.key,
      validateRegisterTypeDefinition(coreType, defaultDueDays, defaultReviewDays),
    );
  }

  for (const customRegisterType of merged.customTypes ?? []) {
    if (CORE_REGISTER_KEY_SET.has(customRegisterType.key)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Custom register type "${customRegisterType.key}" collides with a reserved core register key; use typeOverrides instead.`,
      );
    }
    const validatedCustom = validateRegisterTypeDefinition(
      { ...customRegisterType, isCore: false },
      defaultDueDays,
      defaultReviewDays,
    );
    resolvedMap.set(validatedCustom.key, validatedCustom);
  }

  for (const [key, typeOverride] of Object.entries(merged.typeOverrides ?? {})) {
    const target = resolvedMap.get(key);
    if (!target) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `typeOverrides references unknown register key "${key}".`,
      );
    }
    resolvedMap.set(key, applyRegisterTypeOverride(target, typeOverride));
  }

  return [...resolvedMap.values()];
}

export function findEffectiveRegisterType(
  registerTypeKey: string,
  tenantRegistersConfig?: RegistersConfiguration | null,
  moduleOverrideConfig?: RegistersConfiguration | null,
): RegisterTypeDefinition | null {
  const all = resolveEffectiveRegisterTypes(tenantRegistersConfig, moduleOverrideConfig);
  return all.find((t) => t.key === registerTypeKey) ?? null;
}

export function validateRegisterFieldValues(params: {
  registerType: RegisterTypeDefinition;
  fieldValues: Record<string, unknown>;
  applyDefaults: boolean;
  enforceRequired?: boolean;
}): Record<string, unknown> {
  const { registerType, fieldValues, applyDefaults, enforceRequired = true } = params;
  const next: Record<string, unknown> = { ...(fieldValues ?? {}) };

  for (const fieldDef of registerType.fields) {
    let val = next[fieldDef.key];
    if ((val === undefined || val === null || val === '') && applyDefaults && fieldDef.defaultValue !== undefined) {
      val = fieldDef.defaultValue;
      next[fieldDef.key] = val;
    }

    const isEmpty =
      val === undefined ||
      val === null ||
      (typeof val === 'string' && val.trim().length === 0) ||
      (Array.isArray(val) && val.length === 0);

    if (isEmpty) {
      if (enforceRequired && fieldDef.required) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
          `Field "${fieldDef.label}" (${fieldDef.key}) is required for ${registerType.label}.`,
        );
      }
      continue;
    }

    switch (fieldDef.type) {
      case 'text':
      case 'textarea':
      case 'person': {
        if (typeof val !== 'string') {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be a string.`,
          );
        }
        next[fieldDef.key] = val.trim();
        break;
      }
      case 'number':
      case 'currency_gbp': {
        const numeric = typeof val === 'string' ? Number(val) : val;
        if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be a finite number.`,
          );
        }
        next[fieldDef.key] = numeric;
        break;
      }
      case 'boolean': {
        if (typeof val !== 'boolean') {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be a boolean.`,
          );
        }
        break;
      }
      case 'date': {
        if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(val)) {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be an ISO date string (YYYY-MM-DD).`,
          );
        }
        break;
      }
      case 'select': {
        if (typeof val !== 'string' || (fieldDef.options && !fieldDef.options.includes(val))) {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" value "${String(val)}" is not an allowed option.`,
          );
        }
        break;
      }
      case 'checklist': {
        if (!Array.isArray(val)) {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be an array of checklist items.`,
          );
        }
        const VALID_STATUSES = new Set(['pending', 'recorded', 'not_applicable', 'failed']);
        const normalisedItems: RegisterChecklistItemValue[] = [];
        for (const rawItem of val) {
          if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Checklist entry in field "${fieldDef.key}" must be an object.`,
            );
          }
          const item = rawItem as Record<string, unknown>;
          const itemKey = typeof item.itemKey === 'string' ? item.itemKey.trim() : '';
          const label = typeof item.label === 'string' ? item.label.trim() : '';
          const status = typeof item.status === 'string' ? item.status : '';
          if (!itemKey || !label || typeof item.required !== 'boolean' || !VALID_STATUSES.has(status)) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Checklist item "${itemKey || 'unknown'}" in field "${fieldDef.key}" has invalid structure or status.`,
            );
          }
          const trimmedNote = typeof item.note === 'string' ? item.note.trim() : '';
          if ((status === 'not_applicable' || status === 'failed') && trimmedNote.length === 0) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Checklist item "${label}" requires a note when marked "${status}".`,
            );
          }
          if (!Array.isArray(item.evidenceRefs)) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Checklist item "${itemKey}" evidenceRefs must be an array.`,
            );
          }
          for (const rawRef of item.evidenceRefs) {
            if (
              !rawRef ||
              typeof rawRef !== 'object' ||
              Array.isArray(rawRef) ||
              typeof (rawRef as { blobKey?: unknown }).blobKey !== 'string' ||
              !(rawRef as { blobKey: string }).blobKey.trim()
            ) {
              throw createRegisterDomainError(
                REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
                `Checklist item "${itemKey}" contains an invalid evidence reference.`,
              );
            }
          }
          normalisedItems.push({
            itemKey,
            label,
            required: item.required,
            status: status as RegisterChecklistItemValue['status'],
            recordedById: typeof item.recordedById === 'string' ? item.recordedById : null,
            ...(typeof item.recordedByName === 'string' && item.recordedByName.trim()
              ? { recordedByName: item.recordedByName.trim() }
              : {}),
            recordedAt: typeof item.recordedAt === 'string' ? item.recordedAt : null,
            ...(trimmedNote ? { note: trimmedNote } : {}),
            evidenceRefs: item.evidenceRefs as IntakeEvidenceArtifactRef[],
            ...(item.intakeCheckRecordId !== undefined
              ? {
                  intakeCheckRecordId:
                    typeof item.intakeCheckRecordId === 'string'
                      ? item.intakeCheckRecordId
                      : null,
                }
              : {}),
          });
        }
        next[fieldDef.key] = normalisedItems;
        break;
      }
      case 'evidence': {
        if (!Array.isArray(val)) {
          throw createRegisterDomainError(
            REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
            `Field "${fieldDef.key}" must be an array of verified evidence references.`,
          );
        }
        const VALID_SCANS = new Set(['clean', 'pending', 'infected', 'quarantined']);
        for (const rawRef of val) {
          if (!rawRef || typeof rawRef !== 'object' || Array.isArray(rawRef)) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Evidence entry in field "${fieldDef.key}" must be an object.`,
            );
          }
          const ref = rawRef as Partial<IntakeEvidenceArtifactRef>;
          if (
            typeof ref.blobKey !== 'string' ||
            !ref.blobKey.trim() ||
            typeof ref.sha256 !== 'string' ||
            !ref.sha256.trim() ||
            typeof ref.contentType !== 'string' ||
            !ref.contentType.trim() ||
            typeof ref.sizeBytes !== 'number' ||
            !Number.isFinite(ref.sizeBytes) ||
            ref.sizeBytes <= 0 ||
            typeof ref.scanStatus !== 'string' ||
            !VALID_SCANS.has(ref.scanStatus)
          ) {
            throw createRegisterDomainError(
              REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
              `Evidence reference in field "${fieldDef.key}" is missing required integrity metadata.`,
            );
          }
        }
        break;
      }
    }
  }

  return next;
}

export function validateRegisterCreateInput(params: {
  registerType: RegisterTypeDefinition;
  title: string;
  matterId: string | null;
  personId?: string | null;
  organisationId?: string | null;
  dueAt: string | null;
  reviewAt: string | null;
  fieldValues: Record<string, unknown>;
}): {
  title: string;
  matterId: string | null;
  personId: string | null;
  organisationId: string | null;
  dueAt: string | null;
  reviewAt: string | null;
  fieldValues: Record<string, unknown>;
} {
  const { registerType, title, matterId, dueAt, reviewAt, fieldValues } = params;
  const personId = params.personId?.trim() || null;
  const organisationId = params.organisationId?.trim() || null;
  const cleanMatterId = matterId?.trim() || null;
  if (!registerType.enabled) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.TYPE_DISABLED,
      `Register type "${registerType.key}" is disabled for this tenant.`,
    );
  }
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Title is required when creating a ${registerType.label} record.`,
    );
  }
  const subjectScope = registerType.subjectScope ?? (registerType.requireMatterLink ? 'matter' : 'any');
  if (subjectScope === 'client') {
    if (cleanMatterId) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Client-scoped register type "${registerType.key}" cannot link directly to a matterId.`,
      );
    }
    const hasPerson = Boolean(personId);
    const hasOrg = Boolean(organisationId);
    if (hasPerson === hasOrg) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `Client-scoped register type "${registerType.key}" requires exactly one of personId or organisationId.`,
      );
    }
  } else if ((registerType.requireMatterLink || subjectScope === 'matter') && !cleanMatterId) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Register type "${registerType.key}" requires a linked matter.`,
    );
  }
  const normaliseIso = (val: string | null, label: string): string | null => {
    if (!val || !val.trim()) return null;
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
        `${label} must be a valid ISO timestamp or date.`,
      );
    }
    return d.toISOString();
  };
  const normalisedFields = validateRegisterFieldValues({
    registerType,
    fieldValues,
    applyDefaults: true,
    enforceRequired: true,
  });
  return {
    title: cleanTitle,
    matterId: cleanMatterId,
    personId,
    organisationId,
    dueAt: normaliseIso(dueAt, 'dueAt'),
    reviewAt: normaliseIso(reviewAt, 'reviewAt'),
    fieldValues: normalisedFields,
  };
}

export function actorCanViewRegisterType(
  actorPermissionSet: ReadonlySet<PermissionKey>,
  registerType: Pick<RegisterTypeDefinition, 'key' | 'viewPermission'>,
): boolean {
  if (registerType.viewPermission) {
    return actorPermissionSet.has(registerType.viewPermission as PermissionKey);
  }
  if (actorPermissionSet.has('register:view')) {
    return true;
  }
  return registerType.key === 'undertaking' && actorPermissionSet.has('undertaking:manage');
}

export function actorCanExecuteRegisterTransition(
  actorPermissionSet: ReadonlySet<PermissionKey>,
  registerType: RegisterTypeDefinition,
  transition: RegisterTransitionDefinition,
): boolean {
  if (actorPermissionSet.has(transition.requiredPermission as PermissionKey)) {
    return true;
  }
  if (
    registerType.key === 'sign_off' &&
    transition.requiredPermission === 'register:approve' &&
    actorPermissionSet.has('signoff:approve')
  ) {
    return true;
  }
  return false;
}

export function validateRegisterTransitionExecution(params: {
  registerType: RegisterTypeDefinition;
  record: RegisterRecord;
  transitionKey: string;
  actorId: string;
  actorRoles: readonly string[];
  actorPermissionSet: ReadonlySet<PermissionKey>;
  comment: string | null;
  expectedRowVersion?: number;
  viaDedicatedWorkflow?: boolean;
  priorTransitions?: readonly Pick<RegisterTransition, 'transitionKey' | 'actorId'>[];
}): {
  transition: RegisterTransitionDefinition;
  nextStatus: string;
  targetState: RegisterStateDefinition;
} {
  const {
    registerType,
    record,
    transitionKey,
    actorId,
    actorRoles,
    actorPermissionSet,
    comment,
    expectedRowVersion,
    viaDedicatedWorkflow = false,
    priorTransitions = [],
  } = params;

  if (!registerType.enabled) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.TYPE_DISABLED,
      `Register type "${registerType.key}" is disabled for this tenant.`,
    );
  }

  if (expectedRowVersion !== undefined && record.rowVersion !== expectedRowVersion) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.CONCURRENCY_CONFLICT,
      `Register record "${record.id}" has been modified concurrently (expected version ${expectedRowVersion}, actual ${record.rowVersion}).`,
    );
  }

  const transition = registerType.transitions.find((t) => t.key === transitionKey);
  if (!transition) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.INVALID_TRANSITION,
      `Transition "${transitionKey}" is not defined on register "${registerType.key}".`,
    );
  }

  if (transition.systemOnly && !viaDedicatedWorkflow) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.SYSTEM_ONLY_TRANSITION,
      `Transition "${transition.key}" on register "${registerType.key}" may only be executed through its dedicated workflow.`,
    );
  }

  if (viaDedicatedWorkflow && !transition.systemOnly) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.INVALID_TRANSITION,
      `Transition "${transition.key}" on register "${registerType.key}" is not a dedicated workflow transition.`,
    );
  }

  if (!actorCanExecuteRegisterTransition(actorPermissionSet, registerType, transition)) {
    const err = new Error(
      `FORBIDDEN: Missing permission "${transition.requiredPermission}" for transition "${transition.key}" on register "${registerType.key}".`,
    ) as Error & { code: string; requiredPermission: PermissionKey };
    err.code = 'FORBIDDEN';
    err.requiredPermission = transition.requiredPermission as PermissionKey;
    throw err;
  }

  if (!transition.fromStatuses.includes(record.status)) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.INVALID_TRANSITION,
      `Cannot execute transition "${transition.key}" from status "${record.status}".`,
    );
  }

  const targetState = registerType.states.find((s) => s.key === transition.toStatus);
  if (!targetState) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.INVALID_TRANSITION,
      `Target status "${transition.toStatus}" does not exist on register "${registerType.key}".`,
    );
  }

  if (!viaDedicatedWorkflow) {
    const mustBlockSelfAction =
      transition.forbidSelfAction ||
      Boolean(registerType.approvalRules && transition.requiredPermission !== registerType.editPermission);

    if (mustBlockSelfAction && (record.ownerId === actorId || record.createdById === actorId)) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
        `Self-approval or self-sign-off is forbidden on ${registerType.label} "${record.reference}".`,
      );
    }

    const mustMatchAssignedApprover =
      Boolean(transition.requireAssignedApproverMatch) ||
      Boolean(registerType.approvalRules?.requireAssignedApproverMatch);

    if (
      mustMatchAssignedApprover &&
      transition.forbidSelfAction &&
      record.assignedApproverId &&
      record.assignedApproverId !== actorId
    ) {
      throw createRegisterDomainError(
        REGISTER_DOMAIN_ERROR_CODES.APPROVER_MISMATCH,
        `Only the assigned approver (${record.assignedApproverId}) may perform transition "${transition.key}".`,
      );
    }

    const allowAdminBypass = registerType.approvalRules?.allowAdminBypass !== false;

    if (
      transition.allowedRoles?.length &&
      (!allowAdminBypass || !actorRoles.includes('admin'))
    ) {
      const allowedTransitionSet = new Set(transition.allowedRoles);
      const hasAllowedTransitionRole = actorRoles.some((r) => allowedTransitionSet.has(r));
      if (!hasAllowedTransitionRole) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.APPROVER_MISMATCH,
          `Actor roles [${actorRoles.join(', ')}] do not satisfy allowedRoles for transition "${transition.key}" on "${registerType.key}".`,
        );
      }
    }

    if (
      registerType.approvalRules?.allowedApproverRoles?.length &&
      transition.forbidSelfAction &&
      (!allowAdminBypass || !actorRoles.includes('admin'))
    ) {
      const allowedSet = new Set(registerType.approvalRules.allowedApproverRoles);
      const hasAllowedRole = actorRoles.some((r) => allowedSet.has(r));
      if (!hasAllowedRole) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.APPROVER_MISMATCH,
          `Actor roles [${actorRoles.join(', ')}] do not satisfy allowedApproverRoles for "${registerType.key}".`,
        );
      }
    }

    if (transition.mustDifferFromPreviousApprover) {
      const targetKeySet = transition.distinctFromTransitionKeys?.length
        ? new Set(transition.distinctFromTransitionKeys)
        : null;
      const CYCLE_RESET_TRANSITION_KEYS = new Set([
        'reopen',
        'resubmit',
        'request_changes',
        'withdraw',
        'withdraw_opening',
      ]);
      const transitionDefByKey = new Map(
        registerType.transitions.map((t) => [t.key, t] as const),
      );
      let activeCycleStartIndex = 0;
      for (let idx = priorTransitions.length - 1; idx >= 0; idx -= 1) {
        const prior = priorTransitions[idx];
        const priorDef = transitionDefByKey.get(prior.transitionKey);
        if (
          CYCLE_RESET_TRANSITION_KEYS.has(prior.transitionKey) ||
          priorDef?.toStatus === registerType.initialStatus
        ) {
          activeCycleStartIndex = idx + 1;
          break;
        }
      }
      const activeCycleTransitions = priorTransitions.slice(activeCycleStartIndex);
      const sameActorAlreadyApproved = activeCycleTransitions.some((prior) => {
        if (prior.actorId !== actorId) return false;
        if (targetKeySet) {
          return targetKeySet.has(prior.transitionKey);
        }
        const priorDef = transitionDefByKey.get(prior.transitionKey);
        return Boolean(
          priorDef &&
            (priorDef.forbidSelfAction ||
              priorDef.requiredPermission !== registerType.editPermission),
        );
      });
      if (sameActorAlreadyApproved) {
        throw createRegisterDomainError(
          REGISTER_DOMAIN_ERROR_CODES.DISTINCT_APPROVER_REQUIRED,
          `Transition "${transition.key}" requires a different approver from the previous approval stage on ${registerType.label} "${record.reference}".`,
        );
      }
    }
  }

  if (transition.requiresComment && (!comment || !comment.trim())) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `A comment is required for transition "${transition.label}".`,
    );
  }

  return {
    transition,
    nextStatus: transition.toStatus,
    targetState,
  };
}

export interface EvaluatedRegisterReminderCandidate {
  registerRecordId: string;
  registerTypeKey: string;
  reference: string;
  title: string;
  triggerKind: 'due' | 'review';
  stageDaysBefore: number;
  targetLocalYmd: string;
  idempotencyKey: string;
  isOverdue: boolean;
}

export function resolveIsoTimestampToLocalYmd(
  isoTimestamp: string,
  timeZone: string,
): string {
  const d = new Date(isoTimestamp);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function diffCalendarDaysYmd(targetYmd: string, currentLocalYmd: string): number {
  const targetMs = Date.parse(`${targetYmd}T00:00:00Z`);
  const currentMs = Date.parse(`${currentLocalYmd}T00:00:00Z`);
  return Math.round((targetMs - currentMs) / 86_400_000);
}

export function evaluateRegisterDueAndReviewReminders(params: {
  record: RegisterRecord;
  registerType: RegisterTypeDefinition;
  registersConfig: RegistersConfiguration;
  localDateYmd: string;
  timeZone: string;
}): EvaluatedRegisterReminderCandidate[] {
  const { record, registerType, registersConfig, localDateYmd, timeZone } = params;
  if (!registerType.enabled || !registerType.reminderSchedule.enabled) {
    return [];
  }
  const currentState = registerType.states.find((s) => s.key === record.status);
  if (currentState?.isTerminal) {
    return [];
  }

  const dueOffsets =
    record.reminderScheduleDays && record.reminderScheduleDays.length > 0
      ? record.reminderScheduleDays
      : registerType.reminderSchedule.dueDaysBefore.length > 0
        ? registerType.reminderSchedule.dueDaysBefore
        : (registersConfig.defaultDueDaysBefore ?? DEFAULT_REGISTER_DUE_DAYS_BEFORE);

  const reviewOffsets =
    registerType.reminderSchedule.reviewDaysBefore.length > 0
      ? registerType.reminderSchedule.reviewDaysBefore
      : (registersConfig.defaultReviewDaysBefore ?? DEFAULT_REGISTER_REVIEW_DAYS_BEFORE);

  const candidates: EvaluatedRegisterReminderCandidate[] = [];

  if (record.dueAt) {
    const dueLocalYmd = resolveIsoTimestampToLocalYmd(record.dueAt, timeZone);
    const daysRemaining = diffCalendarDaysYmd(dueLocalYmd, localDateYmd);
    if (dueOffsets.includes(daysRemaining)) {
      candidates.push({
        registerRecordId: record.id,
        registerTypeKey: record.registerTypeKey,
        reference: record.reference,
        title: record.title,
        triggerKind: 'due',
        stageDaysBefore: daysRemaining,
        targetLocalYmd: dueLocalYmd,
        idempotencyKey: `${record.id}:due:${daysRemaining}:${dueLocalYmd}`,
        isOverdue: daysRemaining < 0,
      });
    }
  }

  if (record.reviewAt) {
    const reviewLocalYmd = resolveIsoTimestampToLocalYmd(record.reviewAt, timeZone);
    const daysRemaining = diffCalendarDaysYmd(reviewLocalYmd, localDateYmd);
    if (reviewOffsets.includes(daysRemaining)) {
      candidates.push({
        registerRecordId: record.id,
        registerTypeKey: record.registerTypeKey,
        reference: record.reference,
        title: record.title,
        triggerKind: 'review',
        stageDaysBefore: daysRemaining,
        targetLocalYmd: reviewLocalYmd,
        idempotencyKey: `${record.id}:review:${daysRemaining}:${reviewLocalYmd}`,
        isOverdue: daysRemaining < 0,
      });
    }
  }

  return candidates;
}

export function getEffectiveReminderHourLocal(
  registers?: RegistersConfiguration | null,
): number {
  return registers?.defaultReminderHourLocal ?? DEFAULT_REGISTER_REMINDER_HOUR_LOCAL;
}

export function getDefaultDueAndReviewDaysForConfig(
  registers?: RegistersConfiguration | null,
): { dueDaysBefore: readonly number[]; reviewDaysBefore: readonly number[]; customTypes: readonly RegisterTypeDefinition[]; typeOverrides: Readonly<Record<string, RegisterTypeOverride>> } {
  return {
    dueDaysBefore: registers?.defaultDueDaysBefore ?? DEFAULT_REGISTER_DUE_DAYS_BEFORE,
    reviewDaysBefore: registers?.defaultReviewDaysBefore ?? DEFAULT_REGISTER_REVIEW_DAYS_BEFORE,
    customTypes: registers?.customTypes ?? [],
    typeOverrides: registers?.typeOverrides ?? {},
  };
}

export function isRegisterPermission(key: string): key is RegisterPermission {
  return (
    key === 'register:view' ||
    key === 'register:create' ||
    key === 'register:edit' ||
    key === 'register:approve' ||
    key === 'register:configure' ||
    key === 'undertaking:manage' ||
    key === 'cdd:view' ||
    key === 'cdd:record'
  );
}

// ============================================================================
// Client Due Diligence (CDD) Configuration & Checklist Helpers (ADR 0039, S1-04)
// ============================================================================

export const DEFAULT_CDD_RECHECK_MONTHS_STANDARD = 36;
export const DEFAULT_CDD_RECHECK_MONTHS_HIGH = 12;
export const DEFAULT_CDD_REMINDER_DAYS_BEFORE: readonly number[] = Object.freeze([
  14, 7, 0,
]);
export const DEFAULT_CDD_MAX_EVIDENCE_BYTES = 10_485_760;

export interface ResolvedCddConfiguration {
  readonly enabled: boolean;
  readonly clientTypeMapping: Readonly<Record<string, CddClientCategoryKey>>;
  readonly riskTierMapping: Readonly<Record<string, CddRiskTierKey>>;
  readonly checklists: Readonly<Partial<Record<CddClientCategoryKey, CddChecklistTemplateSet>>>;
  readonly recheckIntervalsMonths: {
    readonly standard: number;
    readonly high: number;
  };
  readonly reminderScheduleDaysBefore: readonly number[];
  readonly maxEvidenceFileSizeBytes: number;
}

export function mergeCddConfigurations(
  baseConfig?: CddConfiguration | null,
  overrideConfig?: CddConfiguration | null,
): CddConfiguration {
  const baseChecklists = baseConfig?.checklists ?? {};
  const overrideChecklists = overrideConfig?.checklists ?? {};
  const mergedChecklists: Partial<Record<CddClientCategoryKey, CddChecklistTemplateSet>> = {};
  const categoryKeys: CddClientCategoryKey[] = [
    'individual',
    'company_or_llp',
    'trust_charity_or_partnership',
  ];
  for (const key of categoryKeys) {
    const b = baseChecklists[key];
    const o = overrideChecklists[key];
    if (b || o) {
      mergedChecklists[key] = {
        standard: [...(o?.standard ?? b?.standard ?? [])],
        highAdditional: [...(o?.highAdditional ?? b?.highAdditional ?? [])],
      };
    }
  }
  const baseIntervals = baseConfig?.recheckIntervalsMonths;
  const overrideIntervals = overrideConfig?.recheckIntervalsMonths;
  return {
    enabled: overrideConfig?.enabled ?? baseConfig?.enabled ?? true,
    clientTypeMapping: {
      ...(baseConfig?.clientTypeMapping ?? {}),
      ...(overrideConfig?.clientTypeMapping ?? {}),
    },
    riskTierMapping: {
      ...(baseConfig?.riskTierMapping ?? {}),
      ...(overrideConfig?.riskTierMapping ?? {}),
    },
    checklists: mergedChecklists,
    recheckIntervalsMonths: {
      standard:
        overrideIntervals?.standard ??
        baseIntervals?.standard ??
        DEFAULT_CDD_RECHECK_MONTHS_STANDARD,
      high:
        overrideIntervals?.high ??
        baseIntervals?.high ??
        DEFAULT_CDD_RECHECK_MONTHS_HIGH,
    },
    reminderScheduleDaysBefore: [
      ...(overrideConfig?.reminderScheduleDaysBefore ??
        baseConfig?.reminderScheduleDaysBefore ??
        DEFAULT_CDD_REMINDER_DAYS_BEFORE),
    ],
    maxEvidenceFileSizeBytes:
      overrideConfig?.maxEvidenceFileSizeBytes ??
      baseConfig?.maxEvidenceFileSizeBytes ??
      DEFAULT_CDD_MAX_EVIDENCE_BYTES,
  };
}

export function resolveEffectiveCddConfig(
  config?: Pick<TenantConfiguration, 'cdd'> | null,
  overrideConfig?: CddConfiguration | null,
): ResolvedCddConfiguration {
  const cdd = config?.cdd;
  const baseRecheck = cdd?.recheckIntervalsMonths;
  const merged = mergeCddConfigurations(
    {
      enabled: cdd?.enabled,
      clientTypeMapping: cdd?.clientTypeMapping,
      riskTierMapping: cdd?.riskTierMapping,
      checklists: cdd?.checklists,
      recheckIntervalsMonths: baseRecheck
        ? {
            standard: baseRecheck.standard,
            high: baseRecheck.high,
          }
        : undefined,
      reminderScheduleDaysBefore: cdd?.reminderScheduleDaysBefore,
      maxEvidenceFileSizeBytes: cdd?.maxEvidenceFileSizeBytes,
    },
    overrideConfig,
  );
  const recheckIntervalsMonths = {
    standard:
      merged.recheckIntervalsMonths?.standard ??
      DEFAULT_CDD_RECHECK_MONTHS_STANDARD,
    high:
      merged.recheckIntervalsMonths?.high ?? DEFAULT_CDD_RECHECK_MONTHS_HIGH,
  };
  return {
    enabled: merged.enabled ?? true,
    clientTypeMapping: merged.clientTypeMapping ?? {},
    riskTierMapping: merged.riskTierMapping ?? {},
    checklists: merged.checklists ?? {},
    recheckIntervalsMonths,
    reminderScheduleDaysBefore:
      merged.reminderScheduleDaysBefore ?? [...DEFAULT_CDD_REMINDER_DAYS_BEFORE],
    maxEvidenceFileSizeBytes:
      merged.maxEvidenceFileSizeBytes ?? DEFAULT_CDD_MAX_EVIDENCE_BYTES,
  };
}

export function resolveCddChecklistTemplatesForClient(
  config: Pick<TenantConfiguration, 'cdd'> | null | undefined,
  category: CddClientCategoryKey,
  tier: CddRiskTierKey,
  overrideConfig?: CddConfiguration | null,
): CddChecklistItemTemplate[] {
  const effective = resolveEffectiveCddConfig(config, overrideConfig);
  const templateSet = effective.checklists[category];
  if (!templateSet) {
    return [];
  }
  const standardItems: CddChecklistItemTemplate[] = (templateSet.standard ?? []).map(
    (item) => ({
      itemKey: item.itemKey,
      label: item.label,
      ...(item.description !== undefined ? { description: item.description } : {}),
      required: item.required,
      requiresEvidence: item.requiresEvidence,
      ...(item.linkedIntakeCheckKind !== undefined
        ? { linkedIntakeCheckKind: item.linkedIntakeCheckKind }
        : {}),
    }),
  );
  if (tier !== 'high') {
    return standardItems;
  }
  const highItems: CddChecklistItemTemplate[] = (
    templateSet.highAdditional ?? []
  ).map((item) => ({
    itemKey: item.itemKey,
    label: item.label,
    ...(item.description !== undefined ? { description: item.description } : {}),
    required: item.required,
    requiresEvidence: item.requiresEvidence,
    ...(item.linkedIntakeCheckKind !== undefined
      ? { linkedIntakeCheckKind: item.linkedIntakeCheckKind }
      : {}),
  }));
  return [...standardItems, ...highItems];
}

export function resolveClientCddCategory(
  cddConfig: Pick<ResolvedCddConfiguration, 'clientTypeMapping'>,
  params: {
    subjectType: 'person' | 'organisation';
    organisationTypeSystemKey?: string | null;
    explicitCategory?: CddClientCategoryKey | null;
  },
): CddClientCategoryKey | null {
  if (params.subjectType === 'person') {
    return 'individual';
  }
  const sysKey = params.organisationTypeSystemKey?.trim();
  if (sysKey && cddConfig.clientTypeMapping[sysKey]) {
    return cddConfig.clientTypeMapping[sysKey];
  }
  return params.explicitCategory ?? null;
}

export function resolveClientCddRiskTier(
  cddConfig: Pick<ResolvedCddConfiguration, 'riskTierMapping'>,
  riskRatingSystemKeys: readonly (string | null | undefined)[],
): CddRiskTierKey {
  for (const rawKey of riskRatingSystemKeys) {
    const key = rawKey?.trim().toLowerCase();
    if (!key) continue;
    const mapped = cddConfig.riskTierMapping[key];
    if (mapped === 'high' || (!mapped && (key === 'high' || key === 'critical' || key === 'sensitive'))) {
      return 'high';
    }
  }
  return 'standard';
}

export function calculateCddNextReviewDueIso(
  completedAtIso: string,
  tier: CddRiskTierKey,
  cddConfig: Pick<ResolvedCddConfiguration, 'recheckIntervalsMonths'>,
): string {
  const recheckIntervalsMonths = cddConfig.recheckIntervalsMonths;
  const months =
    tier === 'high'
      ? recheckIntervalsMonths.high
      : recheckIntervalsMonths.standard;
  const baseDate = new Date(completedAtIso);
  if (Number.isNaN(baseDate.getTime())) {
    throw createRegisterDomainError(
      REGISTER_DOMAIN_ERROR_CODES.VALIDATION_ERROR,
      `Invalid completedAt timestamp "${completedAtIso}" when computing CDD re-check due date.`,
    );
  }
  const targetYear = baseDate.getUTCFullYear();
  const targetMonthIndex = baseDate.getUTCMonth() + months;
  const targetDay = baseDate.getUTCDate();
  const endOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0),
  ).getUTCDate();
  const clampedDay = Math.min(targetDay, endOfTargetMonth);
  const due = new Date(
    Date.UTC(targetYear, targetMonthIndex, clampedDay, 23, 59, 59, 999),
  );
  return due.toISOString();
}

export function buildCddChecklistItemsForTier(params: {
  config?: Pick<TenantConfiguration, 'cdd'> | null;
  overrideConfig?: CddConfiguration | null;
  category: CddClientCategoryKey;
  tier: CddRiskTierKey;
  existingItems?: readonly RegisterChecklistItemValue[];
}): RegisterChecklistItemValue[] {
  const templates = resolveCddChecklistTemplatesForClient(
    params.config,
    params.category,
    params.tier,
    params.overrideConfig,
  );
  const existingByKey = new Map(
    (params.existingItems ?? []).map((item) => [item.itemKey, item]),
  );
  const result: RegisterChecklistItemValue[] = [];
  const includedKeys = new Set<string>();
  for (const tpl of templates) {
    includedKeys.add(tpl.itemKey);
    const prev = existingByKey.get(tpl.itemKey);
    if (prev) {
      result.push({
        ...prev,
        label: tpl.label,
        required: tpl.required,
      });
    } else {
      result.push({
        itemKey: tpl.itemKey,
        label: tpl.label,
        required: tpl.required,
        status: 'pending',
        recordedById: null,
        recordedAt: null,
        evidenceRefs: [],
        intakeCheckRecordId: null,
      });
    }
  }
  // Preserve any custom/previously recorded items on upgrade
  for (const prev of params.existingItems ?? []) {
    if (!includedKeys.has(prev.itemKey)) {
      result.push({
        ...prev,
        evidenceRefs: [...prev.evidenceRefs],
      });
    }
  }
  return result;
}
