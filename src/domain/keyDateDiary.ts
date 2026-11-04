/**
 * Team Diary & Compliance Exceptions Read Models (`src/domain/keyDateDiary.ts`).
 *
 * Classification: Core feature (Platform Architecture Standard §14).
 * - Enforces team diary permissions (`keydate:view`, `keydate:view_any_team`).
 * - Enforces restricted (staff) matter omission at the data layer: entries and exceptions for
 *   restricted matters are returned ONLY if `matter.restrictedAccessUserIds.includes(viewer.id)`.
 * - Computes all 8 `KeyDateExceptionKind` compliance exceptions without leaking client personal data.
 */

import {
  canViewerAccessMatterKeyDates,
  evaluateMatterKeyDateOpeningGate,
  findKeyDateTypeConfig,
  hasKeyDatePermission,
  isKeyDateOpen,
  resolveMatterOwningTeamId,
  type ResolveKeyDatePermissionsOptions,
} from './keyDates';
import { diffCalendarDays } from './keyDateCalculator';
import type {
  IsoDate,
  IsoDateTime,
  KeyDate,
  KeyDateCalendarSync,
  KeyDateException,
  KeyDateExceptionKind,
  KeyDateNotApplicable,
  KeyDateReminderState,
  KeyDatesConfig,
  TeamDiaryEntry,
  TeamDiaryQuery,
  TeamId,
} from './keyDates.types';
export type { TeamDiaryEntry, TeamDiaryQuery };
import type { ChoiceValue, Enquiry, Matter, Person, Team } from './types';

const STABLE_ACTIVE_MATTER_STATUS_KEYS = new Set([
  'matter_status.active',
  'matter_status.open',
  'matter_status.on_hold',
  'active',
  'open',
  'on_hold',
  'ms-active',
  'ms-open',
]);

const STABLE_CLOSED_MATTER_STATUS_KEYS = new Set([
  'matter_status.closed',
  'matter_status.archived',
  'matter_status.completed',
  'matter_status.aborted',
  'closed',
  'archived',
  'completed',
  'aborted',
  'ms-closed',
  'ms-archived',
]);

function resolveMatterStatusKeys(
  matter: Matter,
  values?: readonly ChoiceValue[],
): string[] {
  const keys: string[] = [];
  const statusId = matter.matterStatusId?.trim();
  if (statusId) {
    keys.push(statusId.toLowerCase());
    if (values) {
      const val = values.find((v) => v.id === statusId);
      if (val?.systemKey) {
        keys.push(val.systemKey.toLowerCase());
        keys.push(`matter_status.${val.systemKey.toLowerCase()}`);
      }
    }
  }
  return keys;
}

export function isMatterInActiveStatus(
  matter: Matter,
  values?: readonly ChoiceValue[],
): boolean {
  if (matter.closedAt) return false;
  return resolveMatterStatusKeys(matter, values).some((k) =>
    STABLE_ACTIVE_MATTER_STATUS_KEYS.has(k),
  );
}

export function isMatterInClosedStatus(
  matter: Matter,
  values?: readonly ChoiceValue[],
): boolean {
  if (matter.closedAt) return true;
  return resolveMatterStatusKeys(matter, values).some((k) =>
    STABLE_CLOSED_MATTER_STATUS_KEYS.has(k),
  );
}

/**
 * Returns the IDs of teams that `viewer` belongs to (as member or lead).
 */
export function getUserOwnTeamIds(
  viewer: Person | null | undefined,
  teams: readonly Team[],
): TeamId[] {
  if (!viewer) return [];
  return teams
    .filter(
      (t) =>
        t.active &&
        (t.memberIds.includes(viewer.id) || t.leadIds.includes(viewer.id)),
    )
    .map((t) => t.id);
}

/**
 * Resolves the effective `teamIds` a viewer is permitted to query in the Team Diary.
 * - Users without `keydate:view_any_team` are restricted to their own teams.
 * - Users with `keydate:view_any_team` may select any team(s), or all active teams when `requestedTeamIds` is empty.
 */
export function resolvePermittedDiaryTeamIds(
  viewer: Person | null | undefined,
  requestedTeamIds: readonly TeamId[] | undefined,
  teams: readonly Team[],
  permissionOptions?: ResolveKeyDatePermissionsOptions | KeyDatesConfig | null,
): TeamId[] {
  if (!viewer || !hasKeyDatePermission(viewer, 'keydate:view', permissionOptions)) {
    return [];
  }
  const canViewAny = hasKeyDatePermission(
    viewer,
    'keydate:view_any_team',
    permissionOptions,
  );
  const ownTeamIds = getUserOwnTeamIds(viewer, teams);

  if (canViewAny) {
    if (requestedTeamIds && requestedTeamIds.length > 0) {
      return Array.from(new Set(requestedTeamIds));
    }
    return teams.filter((t) => t.active).map((t) => t.id);
  }

  const ownSet = new Set(ownTeamIds);
  if (requestedTeamIds && requestedTeamIds.length > 0) {
    return requestedTeamIds.filter((tid) => ownSet.has(tid));
  }
  return ownTeamIds;
}

export interface QueryTeamDiaryParams {
  viewer: Person | null | undefined;
  query: TeamDiaryQuery;
  todayIso: IsoDate;
  config: KeyDatesConfig;
  keyDates: readonly KeyDate[];
  reminderStates?: readonly KeyDateReminderState[];
  matters?: readonly Matter[];
  enquiries?: readonly Enquiry[];
  teams: readonly Team[];
  people?: readonly Person[];
}

/**
 * Data-layer query for the Team Diary.
 * - Enforces `keydate:view` and team scoping (`keydate:view_any_team` vs own teams).
 * - Enforces restricted (staff) matter omission at the data layer: returns an entry ONLY if
 *   `matter.restrictedAccessUserIds.includes(viewer.id)`. Otherwise omits it completely with no placeholder.
 */
export function queryTeamDiaryEntries(
  params: QueryTeamDiaryParams,
): TeamDiaryEntry[] {
  const {
    viewer,
    query,
    todayIso,
    config,
    keyDates,
    reminderStates = [],
    matters = [],
    enquiries = [],
    teams,
    people = [],
  } = params;

  if (!config?.enabled || !viewer) {
    return [];
  }

  const permOpts: ResolveKeyDatePermissionsOptions = {
    config,
    allPeople: people,
    teams,
  };
  if (!hasKeyDatePermission(viewer, 'keydate:view', permOpts)) {
    return [];
  }

  const permittedTeamIds = resolvePermittedDiaryTeamIds(
    viewer,
    query.teamIds,
    teams,
    permOpts,
  );
  if (permittedTeamIds.length === 0) {
    return [];
  }
  const teamSet = new Set(permittedTeamIds);
  const categorySet = query.categories?.length
    ? new Set(query.categories)
    : null;
  const statusSet = query.statuses?.length ? new Set(query.statuses) : null;

  const matterById = new Map<string, Matter>();
  for (const m of matters) {
    matterById.set(m.id, m);
  }
  const enquiryById = new Map<string, Enquiry>();
  for (const e of enquiries) {
    enquiryById.set(e.id, e);
  }
  const reminderByKeyDateId = new Map<string, KeyDateReminderState>();
  for (const rs of reminderStates) {
    reminderByKeyDateId.set(rs.keyDateId, rs);
  }

  const entries: TeamDiaryEntry[] = [];

  for (const kd of keyDates) {
    // Never show superseded dates in the live diary unless explicitly requested in `statuses`
    if (kd.status === 'superseded' && !statusSet?.has('superseded')) {
      continue;
    }

    const matter = kd.matterId ? matterById.get(kd.matterId) : undefined;
    // Data-layer staff matter & missing matter exclusion: omit completely with no placeholder (R82)
    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, viewer.id, viewer, people))
    ) {
      continue;
    }

    if (!teamSet.has(kd.teamId)) continue;
    if ((query.from && kd.dueDate < query.from) || (query.to && kd.dueDate > query.to)) continue;
    if (categorySet && !categorySet.has(kd.category)) continue;
    if (statusSet && !statusSet.has(kd.status)) continue;
    if (query.criticalOnly && !kd.isCritical) continue;
    if (
      query.awaitingVerificationOnly &&
      kd.status !== 'awaiting_verification'
    ) {
      continue;
    }

    const enquiry = kd.enquiryId ? enquiryById.get(kd.enquiryId) : undefined;
    const kdType = findKeyDateTypeConfig(config, kd.keyDateTypeId);
    const reminder = reminderByKeyDateId.get(kd.id);

    entries.push({
      keyDateId: kd.id,
      teamId: kd.teamId,
      matterId: kd.matterId,
      enquiryId: kd.enquiryId,
      matterReference:
        (matter as { reference?: string } | undefined)?.reference ??
        matter?.matterNumber ??
        enquiry?.reference,
      matterDescription:
        matter?.title ??
        (enquiry as { subject?: string } | undefined)?.subject ??
        enquiry?.summary,
      dueDate: kd.dueDate,
      dueTime: kd.dueTime,
      daysRemaining: diffCalendarDays(todayIso, kd.dueDate),
      category: kd.category,
      keyDateTypeLabel: kdType?.label ?? kd.keyDateTypeId,
      title: kd.title,
      status: kd.status,
      isCritical: kd.isCritical,
      responsiblePersonIds: [...kd.responsiblePersonIds],
      verificationPending: kd.status === 'awaiting_verification',
      reminderStageDaysBefore: reminder?.currentStageDaysBefore,
      reminderAcknowledged: reminder ? Boolean(reminder.acknowledgedAt) : undefined,
    });
  }

  return entries.sort((a, b) => {
    const cmp = a.dueDate.localeCompare(b.dueDate);
    if (cmp !== 0) return cmp;
    if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1;
    return a.keyDateId.localeCompare(b.keyDateId);
  });
}

export interface ComputeKeyDateExceptionsParams {
  viewer: Person | null | undefined;
  todayIso: IsoDate;
  nowIso?: IsoDateTime;
  config: KeyDatesConfig;
  keyDates: readonly KeyDate[];
  notApplicable?: readonly KeyDateNotApplicable[];
  reminderStates?: readonly KeyDateReminderState[];
  calendarSyncs?: readonly KeyDateCalendarSync[];
  matters?: readonly Matter[];
  values?: readonly ChoiceValue[];
  teams: readonly Team[];
  people?: readonly Person[];
  filterTeamIds?: readonly TeamId[];
  filterKinds?: readonly KeyDateExceptionKind[];
}

/**
 * Computes the compliance exceptions report for users with `keydate:view_any_team`.
 * Covers all 8 `KeyDateExceptionKind` values and enforces data-layer restricted (staff) matter omission.
 */
export function computeKeyDateExceptions(
  params: ComputeKeyDateExceptionsParams,
): KeyDateException[] {
  const {
    viewer,
    todayIso,
    nowIso = `${todayIso}T09:00:00.000Z`,
    config,
    keyDates,
    notApplicable = [],
    reminderStates = [],
    calendarSyncs = [],
    matters = [],
    values,
    teams,
    people = [],
    filterTeamIds,
    filterKinds,
  } = params;

  if (!config?.enabled || !viewer) {
    return [];
  }

  const permOpts: ResolveKeyDatePermissionsOptions = {
    config,
    allPeople: people,
    teams,
  };
  if (!hasKeyDatePermission(viewer, 'keydate:view_any_team', permOpts)) {
    return [];
  }

  const teamFilter =
    filterTeamIds && filterTeamIds.length > 0 ? new Set(filterTeamIds) : null;
  const kindFilter =
    filterKinds && filterKinds.length > 0 ? new Set(filterKinds) : null;

  const verificationOverdueDays =
    config.exceptions?.verificationOverdueDays ?? 3;
  const criticalNoActivityDays =
    config.exceptions?.criticalNoActivityDays ?? 30;
  const criticalNoActivityWindowDays =
    config.exceptions?.criticalNoActivityWindowDays ?? 90;

  const matterById = new Map<string, Matter>();
  for (const m of matters) {
    matterById.set(m.id, m);
  }
  const reminderByKeyDateId = new Map<string, KeyDateReminderState>();
  for (const rs of reminderStates) {
    reminderByKeyDateId.set(rs.keyDateId, rs);
  }
  const syncByKeyDateId = new Map<string, KeyDateCalendarSync>();
  for (const cs of calendarSyncs) {
    syncByKeyDateId.set(cs.keyDateId, cs);
  }

  const exceptions: KeyDateException[] = [];
  const pushException = (ex: KeyDateException) => {
    if (teamFilter && !teamFilter.has(ex.teamId)) return;
    if (kindFilter && !kindFilter.has(ex.kind)) return;
    exceptions.push(ex);
  };

  // 1 & 4. Matter-level checks: `matter_missing_required_date` and `closed_matter_open_dates`
  for (const matter of matters) {
    // Enforce restricted (staff) matter omission in the data layer
    if (!canViewerAccessMatterKeyDates(matter, viewer.id, viewer, people)) {
      continue;
    }

    const matterKeyDates = keyDates.filter((kd) => kd.matterId === matter.id);
    const matterNotApplicable = notApplicable.filter(
      (na) => na.matterId === matter.id,
    );
    const matterTeamId = resolveMatterOwningTeamId(matter, teams);
    const matterTypeId = matter.matterTypeId ?? matter.practiceAreaId;
    const matterRef =
      (matter as { reference?: string }).reference ?? matter.matterNumber ?? matter.id;

    if (isMatterInActiveStatus(matter, values)) {
      const gate = evaluateMatterKeyDateOpeningGate(
        config,
        matterTypeId,
        matterKeyDates,
        matterNotApplicable,
      );
      if (!gate.canOpen) {
        for (const missing of gate.missingKeyDateTypes) {
          pushException({
            kind: 'matter_missing_required_date',
            teamId: matterTeamId,
            matterId: matter.id,
            detectedAt: nowIso,
            detail: `Matter ${matterRef} is open without required key date "${missing.label}" (${missing.id}) or a recorded not-applicable reason.`,
          });
        }
      }
    }

    if (isMatterInClosedStatus(matter, values)) {
      const openDates = matterKeyDates.filter((kd) => isKeyDateOpen(kd.status));
      for (const kd of openDates) {
        pushException({
          kind: 'closed_matter_open_dates',
          teamId: kd.teamId || matterTeamId,
          matterId: matter.id,
          keyDateId: kd.id,
          detectedAt: nowIso,
          detail: `Closed matter ${matterRef} has unresolved key date "${kd.title}" in status "${kd.status}" (due ${kd.dueDate}).`,
        });
      }
    }
  }

  // 2, 3, 5, 6, 7, 8. Key-date-level checks
  for (const kd of keyDates) {
    if (kd.status === 'superseded') continue;

    const matter = kd.matterId ? matterById.get(kd.matterId) : undefined;
    // Enforce restricted (staff) matter and missing matter omission in the data layer (R82, R115, R129)
    if (kd.matterId && !matter) {
      if (hasKeyDatePermission(viewer, 'keydate:configure', permOpts)) {
        pushException({
          kind: 'orphan_key_date_missing_matter',
          teamId: kd.teamId,
          keyDateId: kd.id,
          detectedAt: nowIso,
          detail: `Orphan key date ${kd.id} references a missing matter record.`,
        });
      }
      continue;
    }
    if (
      kd.matterId &&
      matter &&
      !canViewerAccessMatterKeyDates(matter, viewer.id, viewer, people)
    ) {
      continue;
    }
    const refLabel =
      (matter as { reference?: string } | undefined)?.reference ??
      matter?.matterNumber ??
      kd.matterId ??
      kd.enquiryId ??
      kd.id;

    // 2. verification_overdue
    if (kd.status === 'awaiting_verification') {
      const proposedIso = (
        kd.verification.proposedAt ?? kd.createdAt
      ).slice(0, 10);
      const daysWaiting = diffCalendarDays(proposedIso, todayIso);
      if (daysWaiting >= verificationOverdueDays) {
        pushException({
          kind: 'verification_overdue',
          teamId: kd.teamId,
          matterId: kd.matterId,
          keyDateId: kd.id,
          detectedAt: nowIso,
          detail: `Key date "${kd.title}" on ${refLabel} has been awaiting verification for ${daysWaiting} days (threshold: ${verificationOverdueDays} days).`,
        });
      }
    }

    // 3. critical_date_no_recent_activity
    if (kd.isCritical && kd.status === 'confirmed') {
      const daysUntilDue = diffCalendarDays(todayIso, kd.dueDate);
      if (daysUntilDue >= 0 && daysUntilDue <= criticalNoActivityWindowDays) {
        const lastKeyDateTouch = kd.updatedAt.slice(0, 10);
        const lastMatterTouch = matter?.updatedAt
          ? matter.updatedAt.slice(0, 10)
          : lastKeyDateTouch;
        const mostRecentTouch =
          lastKeyDateTouch > lastMatterTouch
            ? lastKeyDateTouch
            : lastMatterTouch;
        const daysSinceActivity = diffCalendarDays(mostRecentTouch, todayIso);
        if (daysSinceActivity >= criticalNoActivityDays) {
          pushException({
            kind: 'critical_date_no_recent_activity',
            teamId: kd.teamId,
            matterId: kd.matterId,
            keyDateId: kd.id,
            detectedAt: nowIso,
            detail: `Critical key date "${kd.title}" on ${refLabel} is due in ${daysUntilDue} days (${kd.dueDate}) with no recorded activity for ${daysSinceActivity} days.`,
          });
        }
      }
    }

    // 5. calculated_from_unreviewed_rules
    if (
      isKeyDateOpen(kd.status) &&
      kd.calculation?.ruleSetReviewStatus === 'unreviewed'
    ) {
      pushException({
        kind: 'calculated_from_unreviewed_rules',
        teamId: kd.teamId,
        matterId: kd.matterId,
        keyDateId: kd.id,
        detectedAt: nowIso,
        detail: `Key date "${kd.title}" on ${refLabel} was calculated using unreviewed rule set "${kd.calculation.ruleSetId}" (v${kd.calculation.ruleSetVersion}).`,
      });
    }

    // 6. reminder_escalated_unacknowledged & restricted_matter_no_permitted_assignee (R99)
    const reminder = reminderByKeyDateId.get(kd.id);
    if (
      kd.status === 'confirmed' &&
      reminder &&
      reminder.lastSkippedReason === 'no_permitted_assignees'
    ) {
      pushException({
        kind: 'restricted_matter_no_permitted_assignee',
        teamId: kd.teamId,
        matterId: kd.matterId,
        keyDateId: kd.id,
        detectedAt: nowIso,
        detail: `Restricted matter key date "${kd.title}" on ${refLabel} has no responsible person permitted to access the matter; reminder task creation was skipped.`,
      });
    }
    if (
      kd.status === 'confirmed' &&
      reminder &&
      !reminder.lastSkippedReason &&
      reminder.escalationLevel > 0 &&
      !reminder.acknowledgedAt
    ) {
      pushException({
        kind: 'reminder_escalated_unacknowledged',
        teamId: kd.teamId,
        matterId: kd.matterId,
        keyDateId: kd.id,
        detectedAt: nowIso,
        detail: `Reminder for "${kd.title}" on ${refLabel} is unacknowledged at escalation level ${reminder.escalationLevel}.`,
      });
    }

    // 7. calendar_sync_failed
    const syncState = syncByKeyDateId.get(kd.id);
    if (syncState && syncState.state === 'failed') {
      pushException({
        kind: 'calendar_sync_failed',
        teamId: kd.teamId,
        matterId: kd.matterId,
        keyDateId: kd.id,
        detectedAt: nowIso,
        detail: `Outlook calendar sync failed for "${kd.title}" on ${refLabel} (${syncState.attempts} attempt(s)): ${syncState.lastError ?? 'Graph API error'}.`,
      });
    }

    // 8. past_due_unresolved
    if (kd.status === 'confirmed' && kd.dueDate < todayIso) {
      const daysOverdue = diffCalendarDays(kd.dueDate, todayIso);
      pushException({
        kind: 'past_due_unresolved',
        teamId: kd.teamId,
        matterId: kd.matterId,
        keyDateId: kd.id,
        detectedAt: nowIso,
        detail: `Confirmed key date "${kd.title}" on ${refLabel} passed ${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'} ago (${kd.dueDate}) and has not been resolved as met or missed.`,
      });
    }
  }

  return exceptions;
}
