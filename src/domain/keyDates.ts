/**
 * Domain logic for Key Dates & Limitation (`src/domain/keyDates.ts`).
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - Resolves KeyDatePermission from `keyDates.permissions.roleGrants` against the user's
 *   roles (`HomeRoleKey` and `AppRole`) and per-person `permissionOverrides`.
 * - Resolves per-matter-type verification, calendar sync, reminder schedule, opening gate,
 *   and closure policies with fallback to tenant defaults.
 * - Enforces restricted (staff) matter omission at the data layer using strict
 *   `matter.restrictedAccessUserIds.includes(viewerId)`.
 */

import { ALL_KEY_DATE_PERMISSIONS as CORE_ALL_KEY_DATE_PERMISSIONS } from '@platform/core';
import { canUserAccessMatter } from './employment';
import {
  calculateLimitationDate,
  findBusinessCalendar,
  findLimitationRule,
} from './keyDateCalculator';
import type {
  CalendarSyncPolicyConfig,
  IsoDate,
  IsoDateTime,
  KeyDate,
  KeyDateCalculation,
  KeyDateCategory,
  KeyDateId,
  KeyDateNotApplicable,
  KeyDatePermission,
  KeyDatesConfig,
  KeyDateSource,
  KeyDateStatus,
  KeyDateTypeConfig,
  KeyDateTypeId,
  MatterTypeKeyDateConfig,
  PersonId,
  ReminderScheduleConfig,
  TeamId,
  VerificationPolicyConfig,
} from './keyDates.types';
import {
  IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY,
  resolvePersonPermissionSet,
} from './rbac';
import type { AuditEntry, Enquiry, Matter, Person, Task, Team } from './types';

export const ALL_KEY_DATE_PERMISSIONS: readonly KeyDatePermission[] = [
  ...CORE_ALL_KEY_DATE_PERMISSIONS,
];

export const DEFAULT_KEY_DATE_ROLE_GRANTS: Readonly<
  Record<string, readonly KeyDatePermission[]>
> = {
  fee_earner: ['keydate:view', 'keydate:edit', 'keydate:resolve'],
  legal_secretary: ['keydate:view', 'keydate:edit'],
  partner: [
    'keydate:view',
    'keydate:edit',
    'keydate:verify',
    'keydate:resolve',
    'keydate:waive',
    'keydate:override_calculation',
  ],
  team_lead: [
    'keydate:view',
    'keydate:edit',
    'keydate:verify',
    'keydate:resolve',
    'keydate:waive',
  ],
  supervisor: [
    'keydate:view',
    'keydate:edit',
    'keydate:verify',
    'keydate:resolve',
    'keydate:waive',
  ],
  risk_compliance: ['keydate:view', 'keydate:view_any_team', 'keydate:verify'],
  managing_partner: [
    'keydate:view',
    'keydate:view_any_team',
    'keydate:edit',
    'keydate:verify',
    'keydate:resolve',
    'keydate:waive',
    'keydate:override_calculation',
  ],
  admin: ['keydate:view', 'keydate:view_any_team', 'keydate:configure'],
};

export interface ResolveKeyDatePermissionsOptions {
  config?: KeyDatesConfig | null;
  roleGrants?: Record<string, readonly KeyDatePermission[]> | null;
  allPeople?: readonly Person[];
  teams?: readonly Team[];
}

function normalizeOptions(
  secondArg?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  thirdArg?: readonly Team[],
): ResolveKeyDatePermissionsOptions {
  if (!secondArg) {
    return { teams: thirdArg ?? [] };
  }
  if (Array.isArray(secondArg)) {
    return { allPeople: secondArg, teams: thirdArg ?? [] };
  }
  if ('enabled' in secondArg || 'keyDateTypes' in secondArg) {
    return {
      config: secondArg as KeyDatesConfig,
      teams: thirdArg ?? [],
    };
  }
  return secondArg as ResolveKeyDatePermissionsOptions;
}

/**
 * Collects the effective role keys (`HomeRoleKey` and `AppRole`) for a user to match against
 * `keyDates.permissions.roleGrants`.
 *
 * Strictly ignores `activeViewingRole` ("Viewing as") for security evaluation (ADR-0013).
 */
export function resolveUserRoleKeysForKeyDates(
  user: Person | null | undefined,
  teams: readonly Team[] = [],
): string[] {
  if (!user) return [];
  const roleKeys = new Set<string>();

  const rawRoles: readonly string[] = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    ...(Array.isArray((user as { homeRoles?: string[] }).homeRoles)
      ? (user as { homeRoles?: string[] }).homeRoles!
      : []),
    ...((user as { homeRole?: string }).homeRole
      ? [(user as { homeRole?: string }).homeRole!]
      : []),
  ];

  for (const r of rawRoles) {
    if (r) roleKeys.add(r);
    if (r === 'supervisor') {
      roleKeys.add('team_lead');
    }
  }

  if (user.appRole) {
    roleKeys.add(user.appRole);
    if (user.appRole === 'team_lead') {
      roleKeys.add('supervisor');
    }
    if (user.appRole === 'call_handler') {
      roleKeys.add('enquiries_coordinator');
    }
  }

  if (teams.some((t) => t.active && t.leadIds.includes(user.id))) {
    roleKeys.add('team_lead');
    roleKeys.add('supervisor');
  }

  if (roleKeys.size === 0 && user.employeeRoleId) {
    const mapped = IMMUTABLE_EMPLOYEE_ROLE_ID_TO_ROLE_KEY[user.employeeRoleId];
    if (mapped) {
      roleKeys.add(mapped);
    } else {
      const stripped = user.employeeRoleId.replace(/^(employee_role|emp_role)\./, '');
      if (stripped) roleKeys.add(stripped);
    }
  }

  return Array.from(roleKeys);
}

/**
 * Resolves the user's `KeyDatePermission[]` from `keyDates.permissions.roleGrants`
 * against the user's roles (`HomeRoleKey` and `AppRole`) and applies per-person
 * `permissionOverrides` (`grant` / `revoke`).
 */
export function resolveKeyDatePermissions(
  user: Person | null | undefined,
  optionsOrPeople?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  teamsArg?: readonly Team[],
): KeyDatePermission[] {
  if (!user) return [];
  const opts = normalizeOptions(optionsOrPeople, teamsArg);
  const teams = opts.teams ?? [];
  const customRoleGrants =
    opts.roleGrants ?? opts.config?.permissions?.roleGrants ?? null;

  const effectiveRoleGrants: Record<string, readonly KeyDatePermission[]> =
    customRoleGrants
      ? {
          ...DEFAULT_KEY_DATE_ROLE_GRANTS,
          ...customRoleGrants,
          // Keep supervisor and team_lead aligned when only one is specified in roleGrants
          supervisor:
            customRoleGrants.supervisor ??
            customRoleGrants.team_lead ??
            DEFAULT_KEY_DATE_ROLE_GRANTS.supervisor,
          team_lead:
            customRoleGrants.team_lead ??
            customRoleGrants.supervisor ??
            DEFAULT_KEY_DATE_ROLE_GRANTS.team_lead,
        }
      : DEFAULT_KEY_DATE_ROLE_GRANTS;

  const roleKeys = resolveUserRoleKeysForKeyDates(user, teams);
  const granted = new Set<KeyDatePermission>();

  for (const roleKey of roleKeys) {
    const perms = effectiveRoleGrants[roleKey];
    if (Array.isArray(perms)) {
      for (const p of perms) {
        if (ALL_KEY_DATE_PERMISSIONS.includes(p)) {
          granted.add(p);
        }
      }
    }
  }

  // If no custom roleGrants override was provided and the user has at least one role or department/relationship,
  // also honour central RBAC relationship/department grants
  if (
    !customRoleGrants &&
    (roleKeys.length > 0 || Boolean(user.departmentId))
  ) {
    const centralSet = resolvePersonPermissionSet(user, {
      allPeople: opts.allPeople,
      teams,
    });
    for (const perm of ALL_KEY_DATE_PERMISSIONS) {
      // Note: DEFAULT_RBAC_ROLES.admin has ALL_PERMISSION_KEYS, whereas keyDates.permissions.roleGrants.admin
      // defaults specifically to ['keydate:view', 'keydate:view_any_team', 'keydate:configure'].
      if (
        roleKeys.includes('admin') &&
        roleKeys.length === 1 &&
        !DEFAULT_KEY_DATE_ROLE_GRANTS.admin.includes(perm)
      ) {
        continue;
      }
      if (centralSet.has(perm)) {
        granted.add(perm);
      }
    }
  }

  // Apply explicit per-person permissionOverrides (grant, then revoke wins)
  if (user.permissionOverrides) {
    for (const g of user.permissionOverrides.grant ?? []) {
      if (ALL_KEY_DATE_PERMISSIONS.includes(g as KeyDatePermission)) {
        granted.add(g as KeyDatePermission);
      }
    }
    for (const r of user.permissionOverrides.revoke ?? []) {
      if (ALL_KEY_DATE_PERMISSIONS.includes(r as KeyDatePermission)) {
        granted.delete(r as KeyDatePermission);
      }
    }
  }

  return ALL_KEY_DATE_PERMISSIONS.filter((perm) => granted.has(perm));
}

export function hasKeyDatePermission(
  user: Person | null | undefined,
  perm: KeyDatePermission,
  optionsOrPeople?:
    | ResolveKeyDatePermissionsOptions
    | KeyDatesConfig
    | readonly Person[]
    | null,
  teamsArg?: readonly Team[],
): boolean {
  return resolveKeyDatePermissions(user, optionsOrPeople, teamsArg).includes(
    perm,
  );
}

// ============================================================================
// Matter Type & Default Policy Resolution
// ============================================================================

export function findMatterTypeKeyDateConfig(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
): MatterTypeKeyDateConfig | undefined {
  if (!config || !matterTypeId) return undefined;
  return config.matterTypes?.find((m) => m.matterTypeId === matterTypeId);
}

export function findKeyDateTypeConfig(
  config: KeyDatesConfig | null | undefined,
  keyDateTypeId: KeyDateTypeId,
): KeyDateTypeConfig | undefined {
  return config?.keyDateTypes?.find((t) => t.id === keyDateTypeId);
}

/**
 * Resolves the verification policy from `matterTypes[].verification`,
 * falling back to `defaults.verification` (off by default: `{ required: false, appliesTo: 'all' }`).
 */
export function resolveMatterTypeVerificationPolicy(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
): Required<VerificationPolicyConfig> {
  const mtConfig = findMatterTypeKeyDateConfig(config, matterTypeId);
  const rawPolicy = mtConfig?.verification ?? config?.defaults?.verification;
  return {
    required: rawPolicy?.required ?? false,
    appliesTo: rawPolicy?.appliesTo ?? 'all',
  };
}

/**
 * Determines whether two-step verification is required for a specific key date.
 *
 * Rules (§2 & §3):
 * 1. Dates calculated from a rule set with `reviewStatus: 'unreviewed'` MUST go through
 *    verification even if the matter type does not require it.
 * 2. Otherwise, check the matter type's verification policy (`all`, `critical_only`, `limitation_only`).
 */
export function isVerificationRequiredForKeyDate(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
  input: {
    category: KeyDateCategory;
    isCritical: boolean;
    ruleSetReviewStatus?: 'reviewed' | 'unreviewed';
  },
): boolean {
  if (input.ruleSetReviewStatus === 'unreviewed') {
    return true;
  }
  const policy = resolveMatterTypeVerificationPolicy(config, matterTypeId);
  if (!policy.required) {
    return false;
  }
  switch (policy.appliesTo) {
    case 'all':
      return true;
    case 'critical_only':
      return input.isCritical;
    case 'limitation_only':
      return input.category === 'limitation';
    default:
      return true;
  }
}

/**
 * Checks whether `verifier` can verify or reject a proposed key date.
 * - Must hold `keydate:verify`.
 * - Proposer can NEVER verify their own date (`proposedById !== verifier.id`).
 */
export function canUserVerifyKeyDate(
  verifier: Person | null | undefined,
  keyDate: Pick<KeyDate, 'status' | 'verification' | 'createdById'>,
  options?: ResolveKeyDatePermissionsOptions | KeyDatesConfig | null,
): { allowed: boolean; reason?: string } {
  if (!verifier) {
    return { allowed: false, reason: 'User is not authenticated.' };
  }
  if (!hasKeyDatePermission(verifier, 'keydate:verify', options)) {
    return {
      allowed: false,
      reason: 'You do not have permission (keydate:verify) to verify key dates.',
    };
  }
  if (keyDate.status !== 'awaiting_verification') {
    return {
      allowed: false,
      reason: `Key date is in status "${keyDate.status}" and is not awaiting verification.`,
    };
  }
  const proposerId = keyDate.verification.proposedById ?? keyDate.createdById;
  if (proposerId === verifier.id) {
    return {
      allowed: false,
      reason: 'The proposer of a key date cannot verify their own date.',
    };
  }
  return { allowed: true };
}

/**
 * Resolves calendar sync policy from `matterTypes[].calendarSync.enabled`,
 * falling back to `defaults.calendarSync.enabled` (default `true`).
 * Restricted (staff) matters NEVER sync.
 */
export function resolveMatterTypeCalendarSyncPolicy(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
  isRestrictedMatter: boolean = false,
): CalendarSyncPolicyConfig {
  if (isRestrictedMatter) {
    return { enabled: false };
  }
  const mtConfig = findMatterTypeKeyDateConfig(config, matterTypeId);
  const enabled =
    mtConfig?.calendarSync?.enabled ??
    config?.defaults?.calendarSync?.enabled ??
    true;
  return { enabled };
}

/**
 * Resolves the reminder schedule for a key date type, falling back to `defaults.reminderScheduleId` ('standard').
 */
export function resolveReminderScheduleForKeyDate(
  config: KeyDatesConfig | null | undefined,
  keyDateTypeId: KeyDateTypeId,
): ReminderScheduleConfig | undefined {
  const kdType = findKeyDateTypeConfig(config, keyDateTypeId);
  const scheduleId =
    kdType?.reminderScheduleId ??
    config?.defaults?.reminderScheduleId ??
    'standard';
  const schedules = config?.reminderSchedules ?? [];
  return (
    schedules.find((s) => s.id === scheduleId) ??
    schedules.find((s) => s.id === 'standard') ??
    schedules[0]
  );
}

// ============================================================================
// Restricted (Staff) Matter Isolation & Default Ownership Helpers
// ============================================================================

export function isMatterRestrictedForKeyDates(
  matter:
    | Pick<Matter, 'isStaffMatter' | 'restrictedAccessUserIds'>
    | null
    | undefined,
): boolean {
  if (!matter) return false;
  return Boolean(
    matter.isStaffMatter ||
      (matter as { hasEthicalWall?: boolean }).hasEthicalWall ||
      (Array.isArray(matter.restrictedAccessUserIds) &&
        matter.restrictedAccessUserIds.length > 0),
  );
}

/**
 * Evaluates whether `viewer` can access a matter's key dates by delegating to
 * `canUserAccessMatter` (`src/domain/employment.ts`, ADR-0014).
 */
export function canViewerAccessMatterKeyDates(
  matter:
    | Pick<Matter, 'id' | 'isStaffMatter' | 'restrictedAccessUserIds'>
    | null
    | undefined,
  viewerUserId: PersonId | Person | null | undefined,
  viewerPerson?: Person | null,
  people?: readonly Person[],
): boolean {
  if (!matter || !matter.id) return false;
  if (!viewerUserId) return false;
  const userId =
    typeof viewerUserId === 'string' ? viewerUserId : viewerUserId.id;
  if (!userId) return false;
  const resolvedPerson =
    typeof viewerUserId === 'object'
      ? viewerUserId
      : (viewerPerson ?? people?.find((p) => p.id === userId) ?? null);
  return canUserAccessMatter(
    matter as Matter,
    userId,
    resolvedPerson,
  );
}

/**
 * Resolves the default team diary (`Team.id`) for a matter.
 * Throws `KEY_DATE_VALIDATION_ERROR` if no active team can be resolved.
 */
export function resolveMatterOwningTeamId(
  matter: Pick<
    Matter,
    | 'owningTeamId'
    | 'practiceAreaId'
    | 'leadFeeEarnerId'
    | 'responsiblePartnerId'
    | 'supervisingPartnerId'
  >,
  teams: readonly Team[],
): TeamId {
  if (matter.owningTeamId) {
    const directMatch = teams.find(
      (t) => t.id === matter.owningTeamId && t.active,
    );
    if (directMatch) return directMatch.id;
  }

  if (matter.practiceAreaId) {
    const routed = teams.find(
      (t) => t.active && t.practiceAreaIds.includes(matter.practiceAreaId),
    );
    if (routed) return routed.id;
  }

  const candidatePersonIds = [
    matter.leadFeeEarnerId,
    matter.responsiblePartnerId,
    matter.supervisingPartnerId,
  ].filter((id): id is string => Boolean(id));

  for (const pid of candidatePersonIds) {
    const memberTeam = teams.find(
      (t) =>
        t.active && (t.memberIds.includes(pid) || t.leadIds.includes(pid)),
    );
    if (memberTeam) return memberTeam.id;
  }

  const firstActive = teams.find((t) => t.active);
  if (!firstActive) {
    throw new Error(
      'KEY_DATE_VALIDATION_ERROR: No active team could be resolved for this key date.',
    );
  }
  return firstActive.id;
}

/**
 * Resolves the default `responsiblePersonIds` for a matter (all employees listed on the matter).
 */
export function resolveMatterDefaultResponsiblePersonIds(
  matter: Pick<
    Matter,
    | 'responsiblePartnerId'
    | 'supervisingPartnerId'
    | 'leadFeeEarnerId'
    | 'teamMemberIds'
  >,
): PersonId[] {
  const ids = new Set<PersonId>();
  if (matter.leadFeeEarnerId) ids.add(matter.leadFeeEarnerId);
  if (matter.responsiblePartnerId) ids.add(matter.responsiblePartnerId);
  if (matter.supervisingPartnerId) ids.add(matter.supervisingPartnerId);
  for (const tid of matter.teamMemberIds ?? []) {
    if (tid) ids.add(tid);
  }
  return Array.from(ids);
}

// ============================================================================
// Matter Opening Gate & Closure Block Evaluators
// ============================================================================

export const OPEN_KEY_DATE_STATUSES: readonly KeyDateStatus[] = [
  'provisional',
  'awaiting_verification',
  'confirmed',
];

export function isKeyDateOpen(status: KeyDateStatus): boolean {
  return OPEN_KEY_DATE_STATUSES.includes(status);
}

/**
 * Matter opening gate (§1):
 * If the matter type lists `requiredKeyDateTypeIds`, the matter cannot open until each
 * is either added (and not superseded/waived) or recorded as `KeyDateNotApplicable` with a reason.
 */
export function evaluateMatterKeyDateOpeningGate(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
  matterKeyDates: readonly KeyDate[],
  notApplicableRecords: readonly KeyDateNotApplicable[],
): {
  canOpen: boolean;
  missingKeyDateTypes: Array<{ id: KeyDateTypeId; label: string }>;
} {
  if (!config?.enabled) {
    return { canOpen: true, missingKeyDateTypes: [] };
  }
  const mtConfig = findMatterTypeKeyDateConfig(config, matterTypeId);
  const requiredIds = mtConfig?.requiredKeyDateTypeIds ?? [];
  if (requiredIds.length === 0) {
    return { canOpen: true, missingKeyDateTypes: [] };
  }

  const allowNotApplicable = mtConfig?.allowNotApplicable ?? true;
  const activeKeyDateTypeIds = new Set(
    matterKeyDates
      .filter((kd) => kd.status !== 'superseded')
      .map((kd) => kd.keyDateTypeId),
  );
  const notApplicableTypeIds = new Set(
    allowNotApplicable
      ? notApplicableRecords
          .filter((na) => Boolean(na.reason?.trim()))
          .map((na) => na.keyDateTypeId)
      : [],
  );

  const missingKeyDateTypes: Array<{ id: KeyDateTypeId; label: string }> = [];
  for (const reqId of requiredIds) {
    if (!activeKeyDateTypeIds.has(reqId) && !notApplicableTypeIds.has(reqId)) {
      const kdType = findKeyDateTypeConfig(config, reqId);
      missingKeyDateTypes.push({
        id: reqId,
        label: kdType?.label ?? reqId,
      });
    }
  }

  return {
    canOpen: missingKeyDateTypes.length === 0,
    missingKeyDateTypes,
  };
}

/**
 * Matter closure gate (§1):
 * If `blockClosureWithOpenDates` is true (default true), block closure while any date on the matter
 * is `provisional`, `awaiting_verification`, or `confirmed`.
 */
export function evaluateMatterKeyDateClosureGate(
  config: KeyDatesConfig | null | undefined,
  matterTypeId: string | null | undefined,
  matterKeyDates: readonly KeyDate[],
): {
  canClose: boolean;
  openKeyDates: KeyDate[];
} {
  if (!config?.enabled) {
    return { canClose: true, openKeyDates: [] };
  }
  const mtConfig = findMatterTypeKeyDateConfig(config, matterTypeId);
  const blockClosure = mtConfig?.blockClosureWithOpenDates ?? true;
  if (!blockClosure) {
    return { canClose: true, openKeyDates: [] };
  }
  const openKeyDates = matterKeyDates.filter((kd) => isKeyDateOpen(kd.status));
  return {
    canClose: openKeyDates.length === 0,
    openKeyDates,
  };
}

// ============================================================================
// Key Date Lifecycle Operations (Create, Propose, Verify, Reject, Supersede,
// Resolve, Waive, Reassign Team, Not Applicable, Enquiry-to-Matter Carry-Over)
// ============================================================================

export interface CreateOrProposeKeyDateInput {
  id: KeyDateId;
  matter?: Matter | null;
  enquiry?: Enquiry | null;
  keyDateTypeId: KeyDateTypeId;
  title?: string;
  dueDate: IsoDate;
  dueTime?: string;
  isCritical?: boolean;
  source?: KeyDateSource;
  teamId?: TeamId;
  responsiblePersonIds?: PersonId[];
  calculation?: KeyDateCalculation;
  notes?: string;
  sourceDocumentId?: string;
  /**
   * Desired initial intent: `'provisional'` (draft/suggested) or `'propose'` (submit to confirm/verify).
   * Note: `source === 'document_extraction'` ALWAYS lands as `'provisional'`.
   */
  intent?: 'provisional' | 'propose';
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  teams: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}

export function createOrProposeKeyDate(
  input: CreateOrProposeKeyDateInput,
): KeyDate {
  const {
    id,
    matter,
    enquiry,
    keyDateTypeId,
    dueDate,
    dueTime,
    calculation,
    notes,
    sourceDocumentId,
    actor,
    nowIso,
    config,
    teams,
    people = [],
    audit,
    nextAuditId,
  } = input;

  if (!hasKeyDatePermission(actor, 'keydate:edit', { config, allPeople: people, teams })) {
    throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:edit" to create a key date.');
  }

  if ((matter && enquiry) || (!matter && !enquiry)) {
    throw new Error('KEY_DATE_ENTITY_ERROR: Exactly one of matter or enquiry must be supplied.');
  }

  const kdType = findKeyDateTypeConfig(config, keyDateTypeId);
  const category: KeyDateCategory = kdType?.category ?? 'internal_milestone';
  const title = input.title?.trim() || kdType?.label || keyDateTypeId;
  const isCritical = input.isCritical ?? kdType?.defaultCritical ?? false;

  // R28: Server-side recalculation, ruleSetReviewStatus lookup from tenant config, and override permission check
  if (input.source === 'calculated' && !calculation) {
    throw new Error(
      'KEY_DATE_VALIDATION_ERROR: A calculation payload is required when source is "calculated".',
    );
  }

  let resolvedCalculation: KeyDateCalculation | undefined;
  if (calculation) {
    const foundRule =
      findLimitationRule(config, calculation.ruleSetId, calculation.ruleId) ??
      (() => {
        for (const rs of config.limitationRuleSets ?? []) {
          const r = rs.rules.find((rule) => rule.id === calculation.ruleId);
          if (r) return { ruleSet: rs, rule: r };
        }
        return undefined;
      })();

    if (!foundRule) {
      throw new Error(
        `KEY_DATE_VALIDATION_ERROR: Unknown limitation ruleSetId "${calculation.ruleSetId}" or ruleId "${calculation.ruleId}".`,
      );
    }

    const calendar = findBusinessCalendar(config, foundRule.rule.calendarId);
    const calcResult = calculateLimitationDate({
      rule: foundRule.rule,
      triggers: calculation.triggers,
      calendar,
      ruleSetReviewStatus: foundRule.ruleSet.reviewStatus,
    });
    const effectiveCalculatedDate = calcResult.date;
    const effectiveReviewStatus = foundRule.ruleSet.reviewStatus;
    const effectiveVersion = foundRule.ruleSet.version;
    const effectiveExplanation = calcResult.explanation;

    const isOverridden = Boolean(
      calculation.overridden || dueDate !== effectiveCalculatedDate,
    );
    if (isOverridden) {
      if (
        !hasKeyDatePermission(actor, 'keydate:override_calculation', {
          config,
          allPeople: people,
          teams,
        })
      ) {
        throw new Error(
          'KEY_DATE_PERMISSION_ERROR: You need "keydate:override_calculation" to override a calculated key date.',
        );
      }
      const cleanOverrideReason = calculation.overrideReason?.trim();
      if (!cleanOverrideReason) {
        throw new Error(
          'KEY_DATE_OVERRIDE_REASON_REQUIRED: A reason is required when overriding a calculated key date.',
        );
      }
      resolvedCalculation = {
        ...calculation,
        ruleSetId: foundRule.ruleSet.id,
        ruleSetVersion: effectiveVersion,
        ruleSetReviewStatus: effectiveReviewStatus,
        calculatedDate: effectiveCalculatedDate,
        explanation: effectiveExplanation,
        overridden: true,
        overrideReason: cleanOverrideReason,
      };
    } else {
      resolvedCalculation = {
        ...calculation,
        ruleSetId: foundRule.ruleSet.id,
        ruleSetVersion: effectiveVersion,
        ruleSetReviewStatus: effectiveReviewStatus,
        calculatedDate: effectiveCalculatedDate,
        explanation: effectiveExplanation,
        overridden: false,
        overrideReason: undefined,
      };
    }
  }

  const source: KeyDateSource =
    input.source === 'document_extraction' ||
    input.source === 'carried_from_enquiry'
      ? input.source
      : resolvedCalculation
        ? 'calculated'
        : (input.source ?? 'manual');

  const resolvedFallbackTeamId = (): TeamId => {
    if (matter) {
      return resolveMatterOwningTeamId(matter, teams);
    }
    if (
      enquiry?.assignedTeamId &&
      teams.some((t) => t.id === enquiry.assignedTeamId && t.active)
    ) {
      return enquiry.assignedTeamId;
    }
    const firstActive = teams.find((t) => t.active);
    if (!firstActive) {
      throw new Error(
        'KEY_DATE_VALIDATION_ERROR: No active team could be resolved for this key date.',
      );
    }
    return firstActive.id;
  };

  const teamId: TeamId = input.teamId?.trim() || resolvedFallbackTeamId();
  if (!teams.some((t) => t.id === teamId && t.active)) {
    throw new Error(
      `KEY_DATE_VALIDATION_ERROR: Team "${teamId}" is not an active team.`,
    );
  }

  const defaultResponsibles = matter
    ? resolveMatterDefaultResponsiblePersonIds(matter)
    : enquiry?.assignedToId
      ? [enquiry.assignedToId]
      : [actor.id];

  const responsiblePersonIds =
    input.responsiblePersonIds && input.responsiblePersonIds.length > 0
      ? Array.from(new Set(input.responsiblePersonIds.filter(Boolean)))
      : defaultResponsibles.length > 0
        ? defaultResponsibles
        : [actor.id];

  if (people.length > 0) {
    for (const pid of responsiblePersonIds) {
      const person = people.find(
        (p) =>
          p.id === pid &&
          p.isEmployee &&
          !p.mergedIntoId &&
          p.recordStatusId !== 'record_status.archived' &&
          (p.employment as { employmentStatus?: string } | undefined)?.employmentStatus !== 'Leaver',
      );
      if (!person) {
        throw new Error(
          `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" is not an active employee.`,
        );
      }
      if (matter && !canViewerAccessMatterKeyDates(matter, person, person, people)) {
        throw new Error(
          `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" does not have access to restricted matter "${matter.id}".`,
        );
      }
    }
  } else if (matter) {
    for (const pid of responsiblePersonIds) {
      if (!canViewerAccessMatterKeyDates(matter, pid)) {
        throw new Error(
          `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" does not have access to restricted matter "${matter.id}".`,
        );
      }
    }
  }

  const matterTypeId =
    matter?.matterTypeId ?? matter?.practiceAreaId ?? enquiry?.practiceAreaId ?? undefined;
  const verificationRequired = isVerificationRequiredForKeyDate(
    config,
    matterTypeId,
    {
      category,
      isCritical,
      ruleSetReviewStatus: resolvedCalculation?.ruleSetReviewStatus,
    },
  );

  // Dates extracted from documents ALWAYS land as 'provisional'
  let status: KeyDateStatus;
  if (source === 'document_extraction' || input.intent === 'provisional') {
    status = 'provisional';
  } else if (verificationRequired) {
    status = 'awaiting_verification';
  } else {
    status = 'confirmed';
  }

  const keyDate: KeyDate = {
    id,
    ...(matter ? { matterId: matter.id } : {}),
    ...(enquiry ? { enquiryId: enquiry.id } : {}),
    keyDateTypeId,
    category,
    title,
    dueDate,
    ...(dueTime ? { dueTime } : {}),
    isCritical,
    status,
    source,
    teamId,
    responsiblePersonIds,
    ...(resolvedCalculation ? { calculation: resolvedCalculation } : {}),
    verification: {
      required: verificationRequired,
      ...(status === 'awaiting_verification' || status === 'confirmed'
        ? {
            proposedById: actor.id,
            proposedAt: nowIso,
          }
        : {}),
      ...(status === 'confirmed' && !verificationRequired
        ? {
            verifiedById: actor.id,
            verifiedAt: nowIso,
          }
        : {}),
    },
    ...(notes ? { notes } : {}),
    ...(sourceDocumentId ? { sourceDocumentId } : {}),
    createdById: actor.id,
    createdAt: nowIso,
    updatedById: actor.id,
    updatedAt: nowIso,
    version: 1,
  };

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: status === 'awaiting_verification' ? 'keydate-propose' : 'keydate-create',
    field: 'status',
    oldValue: null,
    newValue: keyDate.status,
    byId: actor.id,
    at: nowIso,
    snapshot: { before: null, after: structuredClone(keyDate) },
  });

  if (resolvedCalculation?.overridden) {
    audit.push({
      id: nextAuditId(),
      recordType: 'key_date',
      recordId: keyDate.id,
      action: 'keydate-override-calculation',
      field: 'dueDate',
      oldValue: resolvedCalculation.calculatedDate,
      newValue: keyDate.dueDate,
      byId: actor.id,
      at: nowIso,
      reason: resolvedCalculation.overrideReason ?? null,
      snapshot: {
        calculatedDate: resolvedCalculation.calculatedDate,
        overriddenDate: keyDate.dueDate,
        reason: resolvedCalculation.overrideReason,
      },
    });
  }

  return keyDate;
}

export function proposeProvisionalKeyDate(params: {
  keyDate: KeyDate;
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  matter?: Matter | null;
  enquiry?: Enquiry | null;
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate {
  const {
    keyDate,
    actor,
    nowIso,
    config,
    matter,
    enquiry,
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  if (!hasKeyDatePermission(actor, 'keydate:edit', { config, allPeople: people, teams })) {
    throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:edit" to propose a key date.');
  }
  if (keyDate.status !== 'provisional') {
    throw new Error(
      `KEY_DATE_STATUS_ERROR: Only a provisional key date can be proposed (current status: "${keyDate.status}").`,
    );
  }

  const before = structuredClone(keyDate);
  const matterTypeId =
    matter?.matterTypeId ?? matter?.practiceAreaId ?? enquiry?.practiceAreaId ?? undefined;
  const verificationRequired = isVerificationRequiredForKeyDate(
    config,
    matterTypeId,
    {
      category: keyDate.category,
      isCritical: keyDate.isCritical,
      ruleSetReviewStatus: keyDate.calculation?.ruleSetReviewStatus,
    },
  );

  keyDate.verification = {
    required: verificationRequired,
    proposedById: actor.id,
    proposedAt: nowIso,
    ...(verificationRequired
      ? {}
      : {
          verifiedById: actor.id,
          verifiedAt: nowIso,
        }),
  };
  keyDate.status = verificationRequired ? 'awaiting_verification' : 'confirmed';
  keyDate.updatedById = actor.id;
  keyDate.updatedAt = nowIso;
  keyDate.version += 1;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: 'keydate-propose',
    field: 'status',
    oldValue: before.status,
    newValue: keyDate.status,
    byId: actor.id,
    at: nowIso,
    snapshot: { before, after: structuredClone(keyDate) },
  });

  return keyDate;
}

export function verifyProposedKeyDate(params: {
  keyDate: KeyDate;
  verifier: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate {
  const {
    keyDate,
    verifier,
    nowIso,
    config,
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  const check = canUserVerifyKeyDate(verifier, keyDate, {
    config,
    allPeople: people,
    teams,
  });
  if (!check.allowed) {
    throw new Error(`KEY_DATE_VERIFY_ERROR: ${check.reason}`);
  }

  const before = structuredClone(keyDate);
  keyDate.status = 'confirmed';
  keyDate.verification = {
    ...keyDate.verification,
    verifiedById: verifier.id,
    verifiedAt: nowIso,
    rejectedById: undefined,
    rejectedAt: undefined,
    rejectionReason: undefined,
  };
  keyDate.updatedById = verifier.id;
  keyDate.updatedAt = nowIso;
  keyDate.version += 1;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: 'keydate-verify',
    field: 'status',
    oldValue: before.status,
    newValue: 'confirmed',
    byId: verifier.id,
    at: nowIso,
    snapshot: { before, after: structuredClone(keyDate) },
  });

  return keyDate;
}

export function rejectProposedKeyDate(params: {
  keyDate: KeyDate;
  verifier: Person;
  reason: string;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate {
  const {
    keyDate,
    verifier,
    reason,
    nowIso,
    config,
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  const check = canUserVerifyKeyDate(verifier, keyDate, {
    config,
    allPeople: people,
    teams,
  });
  if (!check.allowed) {
    throw new Error(`KEY_DATE_REJECT_ERROR: ${check.reason}`);
  }

  const cleanReason = reason?.trim();
  if (!cleanReason) {
    throw new Error('KEY_DATE_REJECT_REASON_REQUIRED: A reason is required when rejecting a proposed key date.');
  }

  const before = structuredClone(keyDate);
  keyDate.status = 'provisional';
  keyDate.verification = {
    ...keyDate.verification,
    rejectedById: verifier.id,
    rejectedAt: nowIso,
    rejectionReason: cleanReason,
  };
  keyDate.updatedById = verifier.id;
  keyDate.updatedAt = nowIso;
  keyDate.version += 1;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: 'keydate-reject',
    field: 'status',
    oldValue: before.status,
    newValue: 'provisional',
    byId: verifier.id,
    at: nowIso,
    reason: cleanReason,
    snapshot: { before, after: structuredClone(keyDate) },
  });

  return keyDate;
}

/**
 * Supersedes a confirmed key date with a new key date (never deleting the old record).
 * Requires `keydate:edit` and a non-empty `reason`.
 */
export function supersedeConfirmedKeyDate(params: {
  existingKeyDate: KeyDate;
  newKeyDateId: KeyDateId;
  updates: {
    title?: string;
    dueDate: IsoDate;
    dueTime?: string;
    isCritical?: boolean;
    teamId?: TeamId;
    responsiblePersonIds?: PersonId[];
    calculation?: KeyDateCalculation;
    notes?: string;
    source?: KeyDateSource;
    intent?: 'provisional' | 'propose';
  };
  reason: string;
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  matter?: Matter | null;
  enquiry?: Enquiry | null;
  teams: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): { supersededKeyDate: KeyDate; replacementKeyDate: KeyDate } {
  const {
    existingKeyDate,
    newKeyDateId,
    updates,
    reason,
    actor,
    nowIso,
    config,
    matter,
    enquiry,
    teams,
    people = [],
    audit,
    nextAuditId,
  } = params;

  if (!hasKeyDatePermission(actor, 'keydate:edit', { config, allPeople: people, teams })) {
    throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:edit" to supersede a key date.');
  }
  const cleanReason = reason?.trim();
  if (!cleanReason) {
    throw new Error('KEY_DATE_SUPERSEDE_REASON_REQUIRED: A reason is required when editing/superseding a confirmed key date.');
  }

  const beforeOld = structuredClone(existingKeyDate);
  const carriedCalculation = updates.calculation
    ? updates.calculation
    : existingKeyDate.calculation
      ? {
          ...existingKeyDate.calculation,
          overrideReason:
            existingKeyDate.calculation.overrideReason || cleanReason,
        }
      : undefined;

  const replacementKeyDate = createOrProposeKeyDate({
    id: newKeyDateId,
    matter,
    enquiry,
    keyDateTypeId: existingKeyDate.keyDateTypeId,
    title: updates.title ?? existingKeyDate.title,
    dueDate: updates.dueDate,
    dueTime: updates.dueTime ?? existingKeyDate.dueTime,
    isCritical: updates.isCritical ?? existingKeyDate.isCritical,
    source:
      updates.source ??
      (carriedCalculation ? 'calculated' : existingKeyDate.source),
    teamId: updates.teamId ?? existingKeyDate.teamId,
    responsiblePersonIds:
      updates.responsiblePersonIds ?? existingKeyDate.responsiblePersonIds,
    calculation: carriedCalculation,
    notes: updates.notes ?? existingKeyDate.notes,
    sourceDocumentId: existingKeyDate.sourceDocumentId,
    intent: updates.intent ?? 'propose',
    actor,
    nowIso,
    config,
    teams,
    people,
    audit,
    nextAuditId,
  });
  replacementKeyDate.supersedesKeyDateId = existingKeyDate.id;

  existingKeyDate.status = 'superseded';
  existingKeyDate.supersededByKeyDateId = newKeyDateId;
  existingKeyDate.updatedById = actor.id;
  existingKeyDate.updatedAt = nowIso;
  existingKeyDate.version += 1;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: existingKeyDate.id,
    action: 'keydate-supersede',
    field: 'status',
    oldValue: beforeOld.status,
    newValue: 'superseded',
    byId: actor.id,
    at: nowIso,
    reason: cleanReason,
    snapshot: {
      before: beforeOld,
      after: structuredClone(existingKeyDate),
      replacementKeyDateId: replacementKeyDate.id,
    },
  });

  return {
    supersededKeyDate: existingKeyDate,
    replacementKeyDate,
  };
}

/**
 * Resolves a key date as `'met'`, `'missed'`, or `'waived'`.
 * - `'met'` and `'missed'` require `keydate:resolve`.
 * - `'waived'` requires `keydate:waive`.
 * - `'missed'` and `'waived'` require a non-empty `note` (reason).
 */
export function resolveKeyDateOutcome(params: {
  keyDate: KeyDate;
  kind: 'met' | 'missed' | 'waived';
  note?: string;
  evidenceDocumentId?: string;
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate {
  const {
    keyDate,
    kind,
    note,
    evidenceDocumentId,
    actor,
    nowIso,
    config,
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  const permOpts = { config, allPeople: people, teams };
  if (kind === 'waived') {
    if (!hasKeyDatePermission(actor, 'keydate:waive', permOpts)) {
      throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:waive" to waive a key date.');
    }
  } else {
    if (!hasKeyDatePermission(actor, 'keydate:resolve', permOpts)) {
      throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:resolve" to mark a key date as met or missed.');
    }
  }

  const cleanNote = note?.trim();
  if ((kind === 'missed' || kind === 'waived') && !cleanNote) {
    throw new Error(
      `KEY_DATE_OUTCOME_NOTE_REQUIRED: A reason/outcome note is required when marking a key date as "${kind}".`,
    );
  }

  const before = structuredClone(keyDate);
  keyDate.status = kind;
  keyDate.outcome = {
    kind,
    resolvedById: actor.id,
    resolvedAt: nowIso,
    ...(cleanNote ? { note: cleanNote } : {}),
    ...(evidenceDocumentId ? { evidenceDocumentId } : {}),
  };
  keyDate.updatedById = actor.id;
  keyDate.updatedAt = nowIso;
  keyDate.version += 1;

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: kind === 'waived' ? 'keydate-waive' : 'keydate-resolve',
    field: 'status',
    oldValue: before.status,
    newValue: kind,
    byId: actor.id,
    at: nowIso,
    reason: cleanNote ?? null,
    snapshot: { before, after: structuredClone(keyDate) },
  });

  return keyDate;
}

/**
 * Reassigns the team diary (`teamId`) and/or `responsiblePersonIds` of a key date.
 */
export function reassignKeyDateTeamAndOwners(params: {
  keyDate: KeyDate;
  teamId: TeamId;
  responsiblePersonIds?: PersonId[];
  reason?: string;
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  matter?: Matter | null;
  tasks?: Task[];
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate {
  const {
    keyDate,
    teamId,
    responsiblePersonIds,
    reason,
    actor,
    nowIso,
    config,
    matter = null,
    tasks = [],
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  if (!hasKeyDatePermission(actor, 'keydate:edit', { config, allPeople: people, teams })) {
    throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:edit" to reassign a key date team diary.');
  }
  const cleanTeamId = teamId?.trim();
  if (!cleanTeamId) {
    throw new Error('KEY_DATE_VALIDATION_ERROR: teamId is required.');
  }
  if (!teams.some((t) => t.id === cleanTeamId && t.active)) {
    throw new Error(
      `KEY_DATE_VALIDATION_ERROR: Team "${cleanTeamId}" is not an active team.`,
    );
  }

  let nextResponsibles = keyDate.responsiblePersonIds;
  if (responsiblePersonIds && responsiblePersonIds.length > 0) {
    nextResponsibles = Array.from(
      new Set(responsiblePersonIds.filter(Boolean)),
    );
    if (people.length > 0) {
      for (const pid of nextResponsibles) {
        const person = people.find(
          (p) =>
            p.id === pid &&
            p.isEmployee &&
            !p.mergedIntoId &&
            p.recordStatusId !== 'record_status.archived' &&
            (p.employment as { employmentStatus?: string } | undefined)?.employmentStatus !== 'Leaver',
        );
        if (!person) {
          throw new Error(
            `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" is not an active employee.`,
          );
        }
        if (
          matter &&
          !canViewerAccessMatterKeyDates(matter, person, person, people)
        ) {
          throw new Error(
            `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" does not have access to restricted matter "${matter.id}".`,
          );
        }
      }
    } else if (matter) {
      for (const pid of nextResponsibles) {
        if (!canViewerAccessMatterKeyDates(matter, pid)) {
          throw new Error(
            `KEY_DATE_VALIDATION_ERROR: Responsible person "${pid}" does not have access to restricted matter "${matter.id}".`,
          );
        }
      }
    }
  }

  const before = structuredClone(keyDate);
  keyDate.teamId = cleanTeamId;
  keyDate.responsiblePersonIds = nextResponsibles;
  keyDate.updatedById = actor.id;
  keyDate.updatedAt = nowIso;
  keyDate.version += 1;

  // Sync linked reminder task's assignedTeamId and assignedPersonIds (filtered for restricted matter access)
  const linkedTask = tasks.find(
    (t) =>
      t.linkedKeyDateId === keyDate.id ||
      t.idempotencyKey === `keydate-reminder:${keyDate.id}` ||
      Boolean(t.idempotencyKey?.endsWith(`:${keyDate.id}`)),
  );
  if (linkedTask) {
    const permittedTaskAssignees = matter
      ? keyDate.responsiblePersonIds.filter((pid) => {
          const person = people.find((p) => p.id === pid) ?? null;
          return canViewerAccessMatterKeyDates(matter, pid, person, people);
        })
      : [...keyDate.responsiblePersonIds];
    linkedTask.assignedTeamId = keyDate.teamId;
    linkedTask.assignedPersonIds = permittedTaskAssignees;
    linkedTask.assignedPersonId = permittedTaskAssignees[0] ?? null;
    linkedTask.updatedById = actor.id;
    linkedTask.updatedAt = nowIso;
  }

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: keyDate.id,
    action: 'keydate-reassign-team',
    field: 'teamId',
    oldValue: before.teamId,
    newValue: keyDate.teamId,
    byId: actor.id,
    at: nowIso,
    reason: reason?.trim() || null,
    snapshot: { before, after: structuredClone(keyDate) },
  });

  return keyDate;
}

/**
 * Records that a required key date type does not apply to a matter, with an audited reason.
 */
export function recordKeyDateNotApplicable(params: {
  matterId: string;
  matterTypeId?: string | null;
  keyDateTypeId: KeyDateTypeId;
  reason: string;
  actor: Person;
  nowIso: IsoDateTime;
  config: KeyDatesConfig;
  notApplicableList: KeyDateNotApplicable[];
  teams?: readonly Team[];
  people?: readonly Person[];
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDateNotApplicable {
  const {
    matterId,
    matterTypeId,
    keyDateTypeId,
    reason,
    actor,
    nowIso,
    config,
    notApplicableList,
    teams = [],
    people = [],
    audit,
    nextAuditId,
  } = params;

  if (!hasKeyDatePermission(actor, 'keydate:edit', { config, allPeople: people, teams })) {
    throw new Error('KEY_DATE_PERMISSION_ERROR: You need "keydate:edit" to record a key date type as not applicable.');
  }

  const mtConfig = findMatterTypeKeyDateConfig(config, matterTypeId);
  if (mtConfig && mtConfig.allowNotApplicable === false) {
    throw new Error(
      `KEY_DATE_NOT_APPLICABLE_DISALLOWED: Matter type "${matterTypeId}" does not allow marking required key dates as not applicable.`,
    );
  }

  const cleanReason = reason?.trim();
  if (!cleanReason) {
    throw new Error(
      'KEY_DATE_REASON_REQUIRED: A reason is required when recording a key date type as not applicable.',
    );
  }

  const existingIdx = notApplicableList.findIndex(
    (na) => na.matterId === matterId && na.keyDateTypeId === keyDateTypeId,
  );
  const before = existingIdx >= 0 ? { ...notApplicableList[existingIdx]! } : null;

  const record: KeyDateNotApplicable = {
    matterId,
    keyDateTypeId,
    reason: cleanReason,
    recordedById: actor.id,
    recordedAt: nowIso,
  };

  if (existingIdx >= 0) {
    notApplicableList[existingIdx] = record;
  } else {
    notApplicableList.push(record);
  }

  audit.push({
    id: nextAuditId(),
    recordType: 'key_date',
    recordId: `${matterId}:${keyDateTypeId}`,
    action: 'keydate-not-applicable',
    field: keyDateTypeId,
    oldValue: before?.reason ?? null,
    newValue: cleanReason,
    byId: actor.id,
    at: nowIso,
    reason: cleanReason,
    snapshot: { before, after: record },
  });

  return record;
}

/**
 * On conversion from an enquiry to a matter (§1):
 * Carries all key dates from the enquiry onto the newly converted matter
 * with `source: 'carried_from_enquiry'`, defaulting `teamId` to the matter's owning team
 * and `responsiblePersonIds` to the matter's employees.
 */
export function carryEnquiryKeyDatesToMatter(params: {
  enquiry: Pick<Enquiry, 'id' | 'keyDate' | 'keyDateLabel'>;
  matter: Matter;
  keyDates: KeyDate[];
  tasks?: Task[];
  teams: readonly Team[];
  config: KeyDatesConfig;
  actorId: PersonId;
  nowIso: IsoDateTime;
  nextKeyDateId: () => string;
  audit: AuditEntry[];
  nextAuditId: () => string;
}): KeyDate[] {
  const {
    enquiry,
    matter,
    keyDates,
    tasks = [],
    teams,
    config,
    actorId,
    nowIso,
    nextKeyDateId,
    audit,
    nextAuditId,
  } = params;

  const matterTeamId = resolveMatterOwningTeamId(matter, teams);
  const matterResponsibles = resolveMatterDefaultResponsiblePersonIds(matter);
  const carried: KeyDate[] = [];

  for (const kd of keyDates) {
    if (kd.enquiryId !== enquiry.id) continue;
    const before = structuredClone(kd);
    delete kd.enquiryId;
    kd.matterId = matter.id;
    kd.source = 'carried_from_enquiry';
    if (!kd.teamId) {
      kd.teamId = matterTeamId;
    }
    if (!kd.responsiblePersonIds || kd.responsiblePersonIds.length < 2) {
      kd.responsiblePersonIds = Array.from(
        new Set([...(kd.responsiblePersonIds ?? []), ...matterResponsibles]),
      );
    }
    kd.updatedById = actorId;
    kd.updatedAt = nowIso;
    kd.version += 1;

    // Update linked reminder task to point to the matter
    const linkedTask = tasks.find(
      (t) =>
        t.linkedKeyDateId === kd.id ||
        t.idempotencyKey === `keydate-reminder:${kd.id}`,
    );
    if (linkedTask) {
      linkedTask.linkedRecords = [{ recordType: 'matter', recordId: matter.id }];
      linkedTask.assignedTeamId = kd.teamId;
      linkedTask.assignedPersonIds = [...kd.responsiblePersonIds];
      linkedTask.assignedPersonId = kd.responsiblePersonIds[0] ?? null;
    }

    audit.push({
      id: nextAuditId(),
      recordType: 'key_date',
      recordId: kd.id,
      action: 'keydate-update',
      field: 'matterId',
      oldValue: enquiry.id,
      newValue: matter.id,
      byId: actorId,
      at: nowIso,
      reason: 'Carried from enquiry on conversion to matter',
      snapshot: { before, after: structuredClone(kd) },
    });

    carried.push(kd);
  }

  // If the enquiry had a legacy scalar `enquiry.keyDate` and no structured KeyDate was created yet,
  // carry it over as a provisional KeyDate with `source: 'carried_from_enquiry'`
  if (carried.length === 0 && enquiry.keyDate && config?.enabled) {
    const defaultType =
      config.keyDateTypes?.[0] ?? {
        id: 'limitation',
        label: 'Limitation date',
        category: 'limitation' as const,
        defaultCritical: true,
      };
    const seeded: KeyDate = {
      id: nextKeyDateId(),
      matterId: matter.id,
      keyDateTypeId: defaultType.id,
      category: defaultType.category,
      title: enquiry.keyDateLabel?.trim() || defaultType.label,
      dueDate: enquiry.keyDate,
      isCritical: defaultType.defaultCritical ?? true,
      status: 'provisional',
      source: 'carried_from_enquiry',
      teamId: matterTeamId,
      responsiblePersonIds:
        matterResponsibles.length > 0 ? matterResponsibles : [actorId],
      verification: {
        required: isVerificationRequiredForKeyDate(
          config,
          matter.matterTypeId ?? matter.practiceAreaId,
          {
            category: defaultType.category,
            isCritical: defaultType.defaultCritical ?? true,
          },
        ),
      },
      createdById: actorId,
      createdAt: nowIso,
      updatedById: actorId,
      updatedAt: nowIso,
      version: 1,
    };
    keyDates.push(seeded);
    audit.push({
      id: nextAuditId(),
      recordType: 'key_date',
      recordId: seeded.id,
      action: 'keydate-create',
      field: 'source',
      oldValue: null,
      newValue: 'carried_from_enquiry',
      byId: actorId,
      at: nowIso,
      reason: 'Carried from enquiry scalar keyDate on conversion to matter',
      snapshot: { before: null, after: structuredClone(seeded) },
    });
    carried.push(seeded);
  }

  return carried;
}

