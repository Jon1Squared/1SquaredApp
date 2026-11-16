/**
 * Teams Activity Payload Scrubber & Safe Template Builder
 * (`core/src/integrations/teams/scrubber.ts`).
 *
 * Enforces ADR 0035 §3.1:
 * - Confidential matter titles, client names, email addresses, and narrative bodies
 *   must NEVER leave the tenant boundary via Microsoft Teams Activity Feed payloads.
 * - Only safe generic British-English category labels, allow-listed identifier
 *   template parameters, and relative deep-link paths are permitted.
 */

import type {
  NotificationKind,
  OutgoingTeamsActivity,
  OutgoingTeamsActivityTemplateParameter,
} from '../../api/index';
import { TeamsIntegrationError } from './errors';

export const SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND: Readonly<
  Record<NotificationKind, string>
> = Object.freeze({
  task_assigned: 'taskAssigned',
  team_task_arrived: 'teamTaskArrived',
  task_comment: 'taskComment',
  enquiry_assigned: 'enquiryAssigned',
  task_due_soon: 'taskDueSoon',
  task_overdue: 'taskOverdue',
  approval_requested: 'approvalRequested',
  approval_decided: 'approvalDecided',
  key_date_approaching: 'keyDateApproaching',
  credit_control_escalation: 'creditControlEscalation',
  register_review_assigned: 'registerReviewAssigned',
  register_reminder: 'registerReminder',
  general: 'generalNotification',
});

export const SAFE_TEAMS_PREVIEW_BY_KIND: Readonly<
  Record<NotificationKind, string>
> = Object.freeze({
  task_assigned: 'A task has been assigned to you in 1Squared.',
  team_task_arrived: 'A new task has arrived in your team queue in 1Squared.',
  task_comment: 'A new comment was posted on a task in 1Squared.',
  enquiry_assigned: 'An enquiry has been assigned to you in 1Squared.',
  task_due_soon: 'A task due date is approaching in 1Squared.',
  task_overdue: 'A task is overdue and requires your attention in 1Squared.',
  approval_requested:
    'An approval or sign-off request requires your review in 1Squared.',
  approval_decided:
    'An approval request you submitted has been decided in 1Squared.',
  key_date_approaching: 'A key date reminder is due for review in 1Squared.',
  credit_control_escalation:
    'A credit control escalation requires review in 1Squared.',
  register_review_assigned:
    'A register record review has been assigned to you in 1Squared.',
  register_reminder:
    'A compliance register reminder requires your attention in 1Squared.',
  general: 'You have a new notification in 1Squared.',
});

export const ALLOWED_TEAMS_TEMPLATE_PARAM_NAMES: ReadonlySet<string> = new Set([
  'notificationKind',
  'recordRef',
  'notificationId',
  'categoryLabel',
  'urgencyLabel',
]);

const DISALLOWED_CONFIDENTIAL_PARAM_NAMES: ReadonlySet<string> = new Set([
  'mattertitle',
  'mattername',
  'clientname',
  'personname',
  'title',
  'detail',
  'body',
  'narrative',
  'narrativebody',
  'description',
  'subject',
  'email',
  'notes',
  'summary',
  'client',
  'matter',
]);

const ACTIVITY_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{1,63}$/;
const SAFE_RECORD_REF_PATTERN = /^[A-Z]{2,6}-\d{1,12}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAX_PREVIEW_TEXT_LENGTH = 140;
const MAX_TEMPLATE_PARAM_VALUE_LENGTH = 64;
const MAX_DEEP_LINK_LENGTH = 200;

export function validateTeamsDeepLinkPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new TeamsIntegrationError(
      'TEAMS_DEEPLINK_FORBIDDEN',
      'deepLinkPath must be a non-empty application-relative path.',
    );
  }
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    /[\r\n\0]/.test(trimmed) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.length > MAX_DEEP_LINK_LENGTH
  ) {
    throw new TeamsIntegrationError(
      'TEAMS_DEEPLINK_FORBIDDEN',
      'deepLinkPath must be an application-relative path starting with "/" without external scheme or host.',
    );
  }
  return trimmed;
}

function assertCleanTeamsText(
  value: string,
  fieldName: string,
  maxLength: number,
  forbiddenFragments?: readonly string[],
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new TeamsIntegrationError(
      'TEAMS_ACTIVITY_INVALID',
      `${fieldName} cannot be empty.`,
    );
  }
  if (/[\r\n\0]/.test(value)) {
    throw new TeamsIntegrationError(
      'TEAMS_CONTENT_SCRUB_REJECTED',
      `${fieldName} contains disallowed control characters.`,
    );
  }
  if (normalized.length > maxLength) {
    throw new TeamsIntegrationError(
      'TEAMS_CONTENT_SCRUB_REJECTED',
      `${fieldName} exceeds maximum safe redacted length (${maxLength}).`,
    );
  }
  if (EMAIL_PATTERN.test(normalized)) {
    throw new TeamsIntegrationError(
      'TEAMS_CONTENT_SCRUB_REJECTED',
      `${fieldName} cannot contain email addresses.`,
    );
  }
  const lower = normalized.toLowerCase();
  for (const fragment of forbiddenFragments ?? []) {
    const cleanFrag = fragment.trim().toLowerCase();
    if (cleanFrag.length >= 4 && lower.includes(cleanFrag)) {
      throw new TeamsIntegrationError(
        'TEAMS_CONTENT_SCRUB_REJECTED',
        `${fieldName} contains restricted or confidential text.`,
      );
    }
  }
  return normalized;
}

/**
 * Validates and normalises a `TeamsNotifier` payload before enqueue or outbound
 * transport. Rejects external deep links, confidential parameter names, email
 * addresses, overly long narrative text, or caller-specified confidential strings.
 */
export function sanitizeTeamsActivityPayload(
  activity: OutgoingTeamsActivity,
  options?: { readonly forbiddenFragments?: readonly string[] },
): OutgoingTeamsActivity {
  const idempotencyKey = activity.idempotencyKey?.trim();
  const recipientPersonId = activity.recipientPersonId?.trim();
  const activityType = activity.activityType?.trim();
  const correlationId = activity.correlationId?.trim();

  if (!idempotencyKey || !recipientPersonId || !correlationId) {
    throw new TeamsIntegrationError(
      'TEAMS_ACTIVITY_INVALID',
      'idempotencyKey, recipientPersonId, and correlationId are required.',
    );
  }
  if (!activityType || !ACTIVITY_TYPE_PATTERN.test(activityType)) {
    throw new TeamsIntegrationError(
      'TEAMS_ACTIVITY_INVALID',
      'activityType must be an alphanumeric identifier.',
    );
  }

  const deepLinkPath = validateTeamsDeepLinkPath(activity.deepLinkPath);
  const previewText = assertCleanTeamsText(
    activity.previewText,
    'previewText',
    MAX_PREVIEW_TEXT_LENGTH,
    options?.forbiddenFragments,
  );

  const sanitizedParams: OutgoingTeamsActivityTemplateParameter[] = [];
  for (const param of activity.templateParameters ?? []) {
    const name = param.name?.trim();
    if (!name) {
      throw new TeamsIntegrationError(
        'TEAMS_CONTENT_SCRUB_REJECTED',
        'Template parameter name cannot be empty.',
      );
    }
    if (
      DISALLOWED_CONFIDENTIAL_PARAM_NAMES.has(name.toLowerCase()) ||
      !ALLOWED_TEAMS_TEMPLATE_PARAM_NAMES.has(name)
    ) {
      throw new TeamsIntegrationError(
        'TEAMS_CONTENT_SCRUB_REJECTED',
        `Template parameter "${name}" is not permitted in Teams Activity payloads.`,
      );
    }
    const cleanValue = assertCleanTeamsText(
      param.value,
      `templateParameters.${name}`,
      MAX_TEMPLATE_PARAM_VALUE_LENGTH,
      options?.forbiddenFragments,
    );
    sanitizedParams.push({ name, value: cleanValue });
  }

  return {
    idempotencyKey,
    recipientPersonId,
    activityType,
    previewText,
    templateParameters: sanitizedParams,
    deepLinkPath,
    correlationId,
  };
}

/**
 * Builds a strictly redacted `OutgoingTeamsActivity` from a notification event.
 * Never copies `title`, `detail`, matter titles, client names, or narrative text.
 */
export function buildSafeTeamsActivityFromNotification(params: {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly recipientPersonId: string;
  readonly kind: NotificationKind;
  readonly href: string;
  readonly recordId?: string | null;
  readonly correlationId: string;
}): OutgoingTeamsActivity {
  const activityType =
    SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND[params.kind] ??
    SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND.general;
  const previewText =
    SAFE_TEAMS_PREVIEW_BY_KIND[params.kind] ??
    SAFE_TEAMS_PREVIEW_BY_KIND.general;

  let safeDeepLinkPath = '/';
  try {
    safeDeepLinkPath = validateTeamsDeepLinkPath(params.href || '/');
  } catch {
    safeDeepLinkPath = '/';
  }

  const templateParameters: OutgoingTeamsActivityTemplateParameter[] = [
    { name: 'notificationKind', value: params.kind },
  ];
  const trimmedRecordId = params.recordId?.trim() ?? '';
  if (trimmedRecordId && SAFE_RECORD_REF_PATTERN.test(trimmedRecordId)) {
    templateParameters.push({ name: 'recordRef', value: trimmedRecordId });
  }

  return sanitizeTeamsActivityPayload({
    idempotencyKey: `teams:${params.tenantId}:${params.notificationId}`,
    recipientPersonId: params.recipientPersonId,
    activityType,
    previewText,
    templateParameters,
    deepLinkPath: safeDeepLinkPath,
    correlationId: params.correlationId,
  });
}
