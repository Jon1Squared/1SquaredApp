/**
 * Configurable Registers & Undertakings Engine Contracts (`@platform/core-api`).
 *
 * Defines canonical core types for:
 * - Register RBAC & extension permissions
 * - Register type definitions (fields, state machine, transitions, approval rules, reminders)
 * - Register records, transition history rows, and reminder deduplication states
 * - Extension hook payloads (`register.beforeCreate`, `register.beforeTransition`, `register.afterTransition`)
 * - Tenant configuration subtree (`RegistersConfiguration`)
 */

import type { IntakeEvidenceArtifactRef } from './index';

export type RegisterPermission =
  | 'register:view'
  | 'register:create'
  | 'register:edit'
  | 'register:approve'
  | 'register:configure'
  | 'undertaking:manage'
  | 'cdd:view'
  | 'cdd:record';

export type RegisterExtensionPermission =
  | 'register:read'
  | 'register:write';

export type RegisterExtensionPoint =
  | 'register.beforeCreate'
  | 'register.beforeTransition'
  | 'register.afterTransition';

export type RegisterFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency_gbp'
  | 'boolean'
  | 'date'
  | 'select'
  | 'person'
  | 'checklist'
  | 'evidence';

export type RegisterStateTone =
  | 'neutral'
  | 'info'
  | 'warning'
  | 'success'
  | 'danger';

export type RegisterReminderRecipientMode =
  | 'owner_and_approver'
  | 'owner_only'
  | 'matter_team_and_owner'
  | 'client_owner_or_recent_fee_earner';

export type RegisterSubjectScope = 'matter' | 'client' | 'any';

export type RegisterChecklistItemStatus =
  | 'pending'
  | 'recorded'
  | 'not_applicable'
  | 'failed';

export interface RegisterChecklistItemValue {
  itemKey: string;
  label: string;
  required: boolean;
  status: RegisterChecklistItemStatus;
  recordedById: string | null;
  recordedByName?: string;
  recordedAt: string | null;
  note?: string;
  evidenceRefs: IntakeEvidenceArtifactRef[];
  intakeCheckRecordId?: string | null;
}

export type RegisterReminderTriggerKind = 'due' | 'review';

export type RegisterReminderSkippedReason =
  | 'no_permitted_recipients'
  | 'missing_matter'
  | 'terminal_status';

export type RegisterFieldValue =
  | string
  | number
  | boolean
  | null
  | RegisterChecklistItemValue[]
  | IntakeEvidenceArtifactRef[];
export type RegisterFieldValuesMap = Record<string, RegisterFieldValue | undefined>;

export interface RegisterFieldDefinition {
  key: string;
  label: string;
  type: RegisterFieldType;
  required?: boolean;
  description?: string;
  options?: readonly string[];
  defaultValue?: string | number | boolean;
}

export interface RegisterStateDefinition {
  key: string;
  label: string;
  isTerminal?: boolean;
  tone?: RegisterStateTone;
}

export interface RegisterTransitionDefinition {
  key: string;
  label: string;
  fromStatuses: readonly string[];
  toStatus: string;
  requiredPermission: RegisterPermission | 'signoff:approve';
  allowedRoles?: readonly string[];
  requiresComment?: boolean;
  /**
   * When true (or whenever `approvalRules` is non-null on an approval transition),
   * the creator/owner cannot perform this transition on their own record.
   */
  forbidSelfAction?: boolean;
  requireAssignedApproverMatch?: boolean;
  mustDifferFromPreviousApprover?: boolean;
  distinctFromTransitionKeys?: readonly string[];
  /** When true, only dedicated core system workflows may execute this transition directly (R765). */
  systemOnly?: boolean;
  setsDecidedAt?: boolean;
}

export interface RegisterApprovalRules {
  requireTwoPersonApproval: boolean;
  forbidSelfApproval: true;
  allowedApproverRoles?: readonly string[];
  requireAssignedApproverMatch?: boolean;
  allowAdminBypass?: boolean;
}

export interface RegisterReminderScheduleConfig {
  enabled: boolean;
  dueDaysBefore: readonly number[];
  reviewDaysBefore: readonly number[];
  recipientMode: RegisterReminderRecipientMode;
}

export interface RegisterTypeDefinition {
  key: string;
  label: string;
  pluralLabel: string;
  description: string;
  isCore: boolean;
  enabled: boolean;
  referencePrefix: string;
  initialStatus: string;
  viewPermission?: RegisterPermission;
  createPermission: RegisterPermission;
  editPermission: RegisterPermission;
  subjectScope?: RegisterSubjectScope;
  requireMatterLink?: boolean;
  /**
   * `null` for direct creation registers such as `undertaking` (no two-person partner approval gate).
   */
  approvalRules: RegisterApprovalRules | null;
  reminderSchedule: RegisterReminderScheduleConfig;
  states: readonly RegisterStateDefinition[];
  transitions: readonly RegisterTransitionDefinition[];
  fields: readonly RegisterFieldDefinition[];
  showInNavigation?: boolean;
}

export interface RegisterTypeOverride {
  enabled?: boolean;
  label?: string;
  pluralLabel?: string;
  description?: string;
  showInNavigation?: boolean;
  reminderSchedule?: Partial<RegisterReminderScheduleConfig>;
  additionalFields?: readonly RegisterFieldDefinition[];
}

export interface RegistersConfiguration {
  defaultReminderHourLocal?: number;
  defaultDueDaysBefore?: readonly number[];
  defaultReviewDaysBefore?: readonly number[];
  customTypes?: readonly RegisterTypeDefinition[];
  typeOverrides?: Readonly<Record<string, RegisterTypeOverride>>;
}

export interface RegisterRecord {
  id: string;
  tenantId: string;
  registerTypeKey: string;
  reference: string;
  title: string;
  status: string;
  matterId: string | null;
  enquiryId: string | null;
  personId: string | null;
  organisationId: string | null;
  ownerId: string | null;
  assignedApproverId: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  dueAt: string | null;
  reviewAt: string | null;
  reminderScheduleDays: readonly number[] | null;
  fieldValues: Record<string, unknown>;
  rowVersion: number;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface RegisterTransition {
  id: string;
  tenantId: string;
  registerRecordId: string;
  registerTypeKey: string;
  transitionKey: string;
  fromStatus: string;
  toStatus: string;
  actorId: string;
  comment: string | null;
  payload: Record<string, unknown>;
  correlationId: string;
  transitionedAt: string;
}

export interface RegisterReminderState {
  tenantId: string;
  registerRecordId: string;
  idempotencyKey: string;
  triggerKind: RegisterReminderTriggerKind;
  stageDaysBefore: number;
  lastNotifiedAt: string | null;
  lastSkippedReason: RegisterReminderSkippedReason | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface RegisterBeforeCreateHookInput {
  tenantId: string;
  actorId: string;
  correlationId: string;
  registerType: RegisterTypeDefinition;
  draft: {
    registerTypeKey: string;
    title: string;
    matterId: string | null;
    enquiryId: string | null;
    personId: string | null;
    organisationId: string | null;
    ownerId: string | null;
    assignedApproverId: string | null;
    dueAt: string | null;
    reviewAt: string | null;
    fieldValues: Record<string, unknown>;
  };
}

export interface RegisterBeforeCreateHookResult {
  fieldValues?: Record<string, unknown>;
  dueAt?: string | null;
  reviewAt?: string | null;
}

export interface RegisterBeforeTransitionHookInput {
  tenantId: string;
  actorId: string;
  correlationId: string;
  registerType: RegisterTypeDefinition;
  record: RegisterRecord;
  transition: RegisterTransitionDefinition;
  comment: string | null;
  fieldUpdates?: Record<string, unknown>;
}

export interface RegisterBeforeTransitionHookResult {
  fieldUpdates?: Record<string, unknown>;
}

export interface RegisterAfterTransitionHookInput {
  tenantId: string;
  actorId: string;
  correlationId: string;
  registerType: RegisterTypeDefinition;
  previousRecord: RegisterRecord;
  updatedRecord: RegisterRecord;
  transition: RegisterTransition;
}
