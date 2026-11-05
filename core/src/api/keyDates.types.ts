/**
 * Key Dates & Limitation — domain model (`@platform/core-api`)
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - No client names, IDs or client-specific conditions.
 * - All persistence goes through the tenant-scoped data layer. Records do not
 *   carry tenantId because each tenant has its own database (§8). Background
 *   jobs, queue messages and cache keys MUST carry tenantId.
 * - Statutory periods are NOT defined here. They live in tenant configuration
 *   (limitation rule sets) so each firm owns and signs off its own rules.
 *
 * Dates are ISO calendar dates (YYYY-MM-DD) unless named ...At, which are
 * ISO 8601 timestamps in UTC.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type KeyDateId = string;
export type KeyDateTypeId = string; // from config keyDates.keyDateTypes[].id
export type MatterTypeId = string; // from config keyDates.matterTypes[].matterTypeId
export type RuleSetId = string;
export type RuleId = string;
export type PersonId = string;
export type TeamId = string;
export type IsoDate = string; // YYYY-MM-DD
export type IsoDateTime = string; // ISO 8601, UTC

// ---------------------------------------------------------------------------
// Key date
// ---------------------------------------------------------------------------

export type KeyDateCategory =
  | 'limitation'
  | 'court_deadline'
  | 'contractual'
  | 'undertaking'
  | 'compliance'
  | 'internal_milestone';

export type KeyDateStatus =
  | 'provisional' // entered or calculated, not yet relied upon
  | 'awaiting_verification' // proposed; matter type requires a second person
  | 'confirmed' // live date, drives reminders and calendar sync
  | 'met' // action taken in time
  | 'missed' // date passed without action (outcome required)
  | 'waived' // no longer applies (reason required)
  | 'superseded'; // replaced by a newer key date (never deleted)

export type KeyDateSource =
  | 'manual'
  | 'calculated'
  | 'court_order'
  | 'document_extraction' // always lands as 'provisional'
  | 'carried_from_enquiry';

export interface KeyDate {
  id: KeyDateId;

  /** Exactly one of matterId / enquiryId is set. Enquiry dates are re-linked
   *  to the matter on conversion (source becomes 'carried_from_enquiry'). */
  matterId?: string;
  enquiryId?: string;

  keyDateTypeId: KeyDateTypeId;
  category: KeyDateCategory; // denormalised from the type for querying
  title: string;
  dueDate: IsoDate;
  /** Optional local time for court deadlines, e.g. "16:00" (Europe/London). */
  dueTime?: string;
  isCritical: boolean;
  status: KeyDateStatus;
  source: KeyDateSource;

  /**
   * Team diary that owns this date. Required. This is the "backup owner":
   * every member of the team can see and act on it in the team diary.
   * Defaults to the matter's owning team.
   */
  teamId: TeamId;

  /**
   * People responsible. Defaults to the employees listed on the matter
   * (minimum two on a matter). Must contain at least one person.
   */
  responsiblePersonIds: PersonId[];

  calculation?: KeyDateCalculation;
  verification: KeyDateVerification;
  outcome?: KeyDateOutcome;

  supersedesKeyDateId?: KeyDateId;
  supersededByKeyDateId?: KeyDateId;

  notes?: string;
  sourceDocumentId?: string;

  createdById: PersonId;
  createdAt: IsoDateTime;
  updatedById: PersonId;
  updatedAt: IsoDateTime;
  /** Optimistic concurrency. Increment on every write. */
  version: number;
}

// ---------------------------------------------------------------------------
// Calculation (limitation and other rule-based dates)
// ---------------------------------------------------------------------------

export interface KeyDateTriggerValues {
  accrualDate?: IsoDate;
  dateOfKnowledge?: IsoDate;
  /** Personal data: only captured where a rule needs a minority adjustment. */
  claimantDateOfBirth?: IsoDate;
  dateOfDeath?: IsoDate;
  standstillPeriods?: StandstillPeriod[];
  /** Named triggers defined by a configured rule (custom trigger fields). */
  custom?: Record<string, IsoDate>;
}

export interface StandstillPeriod {
  from: IsoDate;
  to: IsoDate;
  reference: string; // agreement reference or document ID
}

export interface KeyDateCalculation {
  ruleSetId: RuleSetId;
  ruleSetVersion: number;
  ruleId: RuleId;
  /** Review status of the rule set at the time of calculation. */
  ruleSetReviewStatus: 'reviewed' | 'unreviewed';
  triggers: KeyDateTriggerValues;
  /** The engine's result before any override. */
  calculatedDate: IsoDate;
  /** Human-readable steps, e.g. "Minority: ran from 18th birthday",
   *  "Rolled forward from bank holiday 2026-12-28". */
  explanation: string[];
  overridden: boolean;
  overrideReason?: string; // required when overridden
}

/** Pure output of the calculation engine. No side effects, no I/O. */
export interface CalculationResult {
  date: IsoDate;
  explanation: string[];
  warnings: string[]; // e.g. "Rule set unreviewed", "Trigger missing"
}

// ---------------------------------------------------------------------------
// Verification (two-step, required per matter type)
// ---------------------------------------------------------------------------

export interface KeyDateVerification {
  /** Resolved from matter type config when the date is proposed. */
  required: boolean;
  proposedById?: PersonId;
  proposedAt?: IsoDateTime;
  verifiedById?: PersonId; // must differ from proposedById
  verifiedAt?: IsoDateTime;
  rejectedById?: PersonId;
  rejectedAt?: IsoDateTime;
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface KeyDateOutcome {
  kind: 'met' | 'missed' | 'waived';
  resolvedById: PersonId;
  resolvedAt: IsoDateTime;
  /** Required for 'missed' and 'waived'. */
  note?: string;
  evidenceDocumentId?: string;
}

// ---------------------------------------------------------------------------
// Reminders — ONE reminder task per key date, advanced in place
// ---------------------------------------------------------------------------

export interface KeyDateReminderState {
  keyDateId: KeyDateId;
  taskId: string;
  /** Idempotency key for the scheduler: `keydate-reminder:${tenantId}:${keyDateId}`. */
  idempotencyKey: string;
  reminderScheduleId: string;
  /** Current stage, by daysBefore value. 0 = due today; negative = overdue. */
  currentStageDaysBefore: number;
  stageEnteredAt: IsoDateTime;
  acknowledgedById?: PersonId;
  acknowledgedAt?: IsoDateTime;
  /** 0 = team and responsible people; 1+ = escalation levels from config. */
  escalationLevel: number;
  lastNotifiedAt?: IsoDateTime;
  /** Reason the reminder task was skipped (e.g. restricted matter with no permitted assignees). */
  lastSkippedReason?: 'no_permitted_assignees' | 'missing_matter';
}

// ---------------------------------------------------------------------------
// Calendar sync
// ---------------------------------------------------------------------------

export type CalendarSyncState =
  | 'disabled' // matter type has sync off, or restricted matter
  | 'pending'
  | 'synced'
  | 'failed';

export interface KeyDateCalendarSync {
  keyDateId: KeyDateId;
  state: CalendarSyncState;
  /** External event IDs per target (person mailbox or team group calendar). */
  externalEvents: { target: string; eventId: string }[];
  lastSyncedAt?: IsoDateTime;
  lastError?: string; // no client content in error text
  attempts: number;
}

// ---------------------------------------------------------------------------
// Matter-level "not applicable" record for required dates
// ---------------------------------------------------------------------------

export interface KeyDateNotApplicable {
  matterId: string;
  keyDateTypeId: KeyDateTypeId;
  reason: string;
  recordedById: PersonId;
  recordedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type KeyDatePermission =
  | 'keydate:view'
  | 'keydate:view_any_team'
  | 'keydate:edit'
  | 'keydate:verify'
  | 'keydate:resolve'
  | 'keydate:waive'
  | 'keydate:override_calculation'
  | 'keydate:configure';

export type KeyDateExtensionPermission = 'keydate:read' | 'keydate:write';

// ---------------------------------------------------------------------------
// Team diary (read model)
// ---------------------------------------------------------------------------

export interface TeamDiaryQuery {
  /** Users without keydate:view_any_team may only pass teams they belong to. */
  teamIds?: TeamId[];
  from?: IsoDate;
  to?: IsoDate;
  categories?: KeyDateCategory[];
  statuses?: KeyDateStatus[];
  criticalOnly?: boolean;
  awaitingVerificationOnly?: boolean;
}

export interface TeamDiaryEntry {
  keyDateId: KeyDateId;
  teamId: TeamId;
  matterId?: string;
  enquiryId?: string;
  matterReference?: string;
  matterDescription?: string;
  dueDate: IsoDate;
  dueTime?: string;
  daysRemaining: number;
  category: KeyDateCategory;
  keyDateTypeLabel: string;
  title: string;
  status: KeyDateStatus;
  isCritical: boolean;
  responsiblePersonIds: PersonId[];
  verificationPending: boolean;
  reminderStageDaysBefore?: number;
  reminderAcknowledged?: boolean;
}

// ---------------------------------------------------------------------------
// Exception reporting (compliance)
// ---------------------------------------------------------------------------

export type KeyDateExceptionKind =
  | 'matter_missing_required_date'
  | 'verification_overdue'
  | 'critical_date_no_recent_activity'
  | 'closed_matter_open_dates'
  | 'calculated_from_unreviewed_rules'
  | 'reminder_escalated_unacknowledged'
  | 'restricted_matter_no_permitted_assignee'
  | 'orphan_key_date_missing_matter'
  | 'calendar_sync_failed'
  | 'past_due_unresolved';

export interface KeyDateException {
  kind: KeyDateExceptionKind;
  teamId: TeamId;
  matterId?: string;
  keyDateId?: KeyDateId;
  detectedAt: IsoDateTime;
  detail: string; // no client content beyond matter reference
}

// ---------------------------------------------------------------------------
// Audit (append-only, uses the platform's immutable audit log)
// ---------------------------------------------------------------------------

export type KeyDateAuditAction =
  | 'keydate-create'
  | 'keydate-update'
  | 'keydate-propose'
  | 'keydate-verify'
  | 'keydate-reject'
  | 'keydate-override-calculation'
  | 'keydate-supersede'
  | 'keydate-resolve'
  | 'keydate-waive'
  | 'keydate-reassign-team'
  | 'keydate-not-applicable'
  | 'keydate-reminder-acknowledge'
  | 'keydate-reminder-escalate'
  | 'keydate-config-change'
  | 'keydate-export';

// ---------------------------------------------------------------------------
// Extension points (core extension API, additive minor version)
// ---------------------------------------------------------------------------

export type KeyDateExtensionPoint =
  | 'keyDate.beforeCreate'
  | 'keyDate.afterStatusChange'
  | 'keyDate.calculateCustomRule';

// ---------------------------------------------------------------------------
// Configuration types (matching schemas/keyDates.config.schema.json)
// ---------------------------------------------------------------------------

export type VerificationAppliesTo = 'all' | 'critical_only' | 'limitation_only';

export interface VerificationPolicyConfig {
  required: boolean;
  appliesTo?: VerificationAppliesTo;
}

export interface CalendarSyncPolicyConfig {
  enabled: boolean;
}

export interface KeyDateDefaultsConfig {
  verification?: VerificationPolicyConfig;
  calendarSync?: CalendarSyncPolicyConfig;
  reminderScheduleId?: string;
  teamAssignment?: 'matter_owning_team';
}

export interface KeyDateTypeConfig {
  id: KeyDateTypeId;
  label: string;
  category: KeyDateCategory;
  defaultCritical?: boolean;
  reminderScheduleId?: string;
  allowManualEntry?: boolean;
  allowCalculation?: boolean;
  active?: boolean;
}

export interface MatterTypeKeyDateConfig {
  matterTypeId: MatterTypeId;
  requiredKeyDateTypeIds?: KeyDateTypeId[];
  allowNotApplicable?: boolean;
  blockClosureWithOpenDates?: boolean;
  defaultRuleSetIds?: RuleSetId[];
  verification?: VerificationPolicyConfig;
  calendarSync?: CalendarSyncPolicyConfig;
}

export type ReminderPriority = 'normal' | 'high' | 'urgent';

export interface ReminderStageConfig {
  daysBefore: number;
  priority?: ReminderPriority;
}

export interface ReminderEscalationConfig {
  afterUnacknowledgedDays?: number;
  levels?: string[]; // 'team_leads' | 'role:<roleKey>'
}

export interface ReminderScheduleConfig {
  id: string;
  label: string;
  stages: ReminderStageConfig[];
  escalation?: ReminderEscalationConfig;
}

export type TriggerFieldKey =
  | 'accrualDate'
  | 'dateOfKnowledge'
  | 'claimantDateOfBirth'
  | 'dateOfDeath'
  | `custom.${string}`;

export type LimitationRuleTriggerConfig =
  | { kind: 'single'; field: TriggerFieldKey }
  | { kind: 'later_of'; fields: TriggerFieldKey[] };

export interface LimitationPeriodConfig {
  years?: number;
  months?: number;
  days?: number;
}

export type CountMethod = 'calendar' | 'business_days' | 'clear_days';
export type NonWorkingDayAdjustment =
  | 'none'
  | 'next_working_day'
  | 'previous_working_day';

export interface MinorityAdjustmentConfig {
  enabled?: boolean;
  ageOfMajority?: number;
}

export interface LongstopConfig {
  field: TriggerFieldKey;
  period: LimitationPeriodConfig;
}

export interface LimitationRuleConfig {
  id: RuleId;
  label: string;
  claimType?: string;
  guidanceNote?: string;
  trigger: LimitationRuleTriggerConfig;
  period: LimitationPeriodConfig;
  countMethod?: CountMethod;
  calendarId?: string;
  nonWorkingDayAdjustment?: NonWorkingDayAdjustment;
  minorityAdjustment?: MinorityAdjustmentConfig;
  applyStandstillPeriods?: boolean;
  longstop?: LongstopConfig;
}

export type RuleSetJurisdiction =
  | 'england_and_wales'
  | 'scotland'
  | 'northern_ireland'
  | 'other';

export interface LimitationRuleSetConfig {
  id: RuleSetId;
  version: number;
  label: string;
  jurisdiction: RuleSetJurisdiction;
  reviewStatus: 'unreviewed' | 'reviewed';
  reviewedBy?: string;
  reviewedOn?: IsoDate;
  rules: LimitationRuleConfig[];
}

export interface BusinessCalendarConfig {
  id: string;
  label: string;
  weekendDays?: number[]; // 0 = Sunday, 6 = Saturday
  nonWorkingDates?: IsoDate[];
  source?: 'manual' | 'imported';
}

export interface TeamCalendarMappingConfig {
  teamId: string;
  groupId: string;
}

export interface KeyDateCalendarSyncProviderConfig {
  provider?: 'microsoft_graph';
  targets?: Array<'responsible_persons' | 'team_calendar'>;
  eventTitleTemplate?: string;
  includeMatterDescription?: boolean;
  statusesToSync?: Array<'provisional' | 'awaiting_verification' | 'confirmed'>;
  teamCalendarMappings?: TeamCalendarMappingConfig[];
}

export interface KeyDateExceptionsConfig {
  verificationOverdueDays?: number;
  criticalNoActivityDays?: number;
  criticalNoActivityWindowDays?: number;
}

export interface KeyDatePermissionsConfig {
  roleGrants?: Record<string, KeyDatePermission[]>;
}

export interface KeyDatesConfig {
  enabled: boolean;
  defaults?: KeyDateDefaultsConfig;
  keyDateTypes?: KeyDateTypeConfig[];
  matterTypes?: MatterTypeKeyDateConfig[];
  reminderSchedules?: ReminderScheduleConfig[];
  limitationRuleSets?: LimitationRuleSetConfig[];
  businessCalendars?: BusinessCalendarConfig[];
  calendarSync?: KeyDateCalendarSyncProviderConfig;
  exceptions?: KeyDateExceptionsConfig;
  permissions?: KeyDatePermissionsConfig;
}
