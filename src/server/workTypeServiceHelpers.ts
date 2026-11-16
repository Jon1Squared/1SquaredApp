/**
 * Server-side helpers for Slice S0-22 (`Departments and Work Types`):
 * - Idempotent work-type auto-task instantiation inside PG transactions (Driver a)
 * - Server-authoritative matter retention & destruction_date computation (Driver c)
 * - Bidirectional Department <-> Practice-Area taxonomy synchronisation (P13)
 */
import type {
  TenantContext,
  TenantTaskRecord,
  WorkTypeAutoTaskTemplateConfig,
  WorkTypeAutoTaskTrigger,
  WorkTypesConfiguration,
} from '@platform/core';
import type {
  AuditEntry,
  ChoiceValue,
  Matter,
  NotificationItem,
  NotificationKind,
  OrgStructureCatalogue,
  Person,
  Task,
  Team,
} from '@/domain/types';
import { addWorkingDays, formatDate, toIsoDate, type WorkingHoursConfig } from '@/domain/dates';
import { isLeaverPerson } from '@/domain/employment';
import { resolveEmployeeRoles } from '@/domain/homeConfig';
import {
  calculateDestructionDate,
  formatRetentionPeriodLabel,
  isClosedOrArchivedMatterStatus,
  resolveWorkTypeAutoTaskTemplates,
  resolveWorkTypeRetention,
} from '@/domain/workTypeConfig';
import { canPersonAccessMatter } from './rbacRuntime';

interface TaskRepoInTx {
  allocateNextTaskId: (ctx: TenantContext) => Promise<string>;
  putTask: (
    ctx: TenantContext,
    task: TenantTaskRecord,
  ) => Promise<TenantTaskRecord>;
}

const PRIORITY_SUFFIX_LABEL: Record<string, string> = {
  'task_priority.low': 'Low',
  'task_priority.normal': 'Normal',
  'task_priority.high': 'High',
  'task_priority.urgent': 'Urgent',
};

export function resolveWorkTypeTaskPriorityId(
  configuredPriorityId: string,
  values: readonly ChoiceValue[],
): string {
  const byExactId = values.find(
    (v) => v.listKey === 'task_priority' && v.id === configuredPriorityId,
  );
  if (byExactId) return byExactId.id;
  const desiredLabel = PRIORITY_SUFFIX_LABEL[configuredPriorityId] ?? 'Normal';
  const byLabel = values.find(
    (v) =>
      v.listKey === 'task_priority' &&
      v.label.toLowerCase() === desiredLabel.toLowerCase(),
  );
  if (byLabel) return byLabel.id;
  const normalFallback = values.find(
    (v) => v.listKey === 'task_priority' && v.label.toLowerCase() === 'normal',
  );
  return normalFallback?.id ?? configuredPriorityId ?? 'task_priority.normal';
}

export function resolveWorkTypeTaskTypeId(values: readonly ChoiceValue[]): string {
  const preferred = values.find(
    (v) =>
      v.listKey === 'task_type' &&
      v.active &&
      v.label.toLowerCase() === 'complete matter opening',
  );
  if (preferred) return preferred.id;
  const firstActive = values.find((v) => v.listKey === 'task_type' && v.active);
  return firstActive?.id ?? 'task_type.complete_matter_opening';
}

export function resolveAssigneeForWorkTypeAutoTask(
  template: WorkTypeAutoTaskTemplateConfig,
  matter: Matter,
  people: readonly Person[],
  teams: readonly Team[],
): { assignedPersonId: string | null; assignedTeamId: string | null } {
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const assignedTeamId = matter.owningTeamId || null;
  const matterPreferredIds: string[] = [];

  if (
    template.ownerRoleKey === 'partner' ||
    template.ownerRoleKey === 'managing_partner'
  ) {
    for (const id of [
      matter.responsiblePartnerId,
      matter.supervisingPartnerId,
      matter.leadFeeEarnerId,
      ...(matter.teamMemberIds ?? []),
    ]) {
      if (id && !matterPreferredIds.includes(id)) matterPreferredIds.push(id);
    }
  } else if (template.ownerRoleKey === 'supervisor') {
    for (const id of [
      matter.supervisingPartnerId,
      matter.responsiblePartnerId,
      matter.leadFeeEarnerId,
      ...(matter.teamMemberIds ?? []),
    ]) {
      if (id && !matterPreferredIds.includes(id)) matterPreferredIds.push(id);
    }
  } else {
    for (const id of [
      matter.leadFeeEarnerId,
      matter.supervisingPartnerId,
      matter.responsiblePartnerId,
      ...(matter.teamMemberIds ?? []),
    ]) {
      if (id && !matterPreferredIds.includes(id)) matterPreferredIds.push(id);
    }
  }

  const team = assignedTeamId ? teams.find((t) => t.id === assignedTeamId) : undefined;
  const teamCandidateIds = (team?.memberIds ?? []).filter(
    (id) => !matterPreferredIds.includes(id),
  );
  const firmCandidateIds = people
    .filter(
      (p) =>
        p.isEmployee &&
        !p.mergedIntoId &&
        !matterPreferredIds.includes(p.id) &&
        !teamCandidateIds.includes(p.id),
    )
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));

  const orderedCandidateIds = [
    ...matterPreferredIds,
    ...teamCandidateIds,
    ...firmCandidateIds,
  ];

  const isEligiblePerson = (person: Person | undefined): person is Person =>
    Boolean(
      person &&
        person.isEmployee &&
        !person.mergedIntoId &&
        !isLeaverPerson(person) &&
        canPersonAccessMatter(matter, person.id, person, {
          allPeople: [...people],
          teams: [...teams],
        }),
    );

  // 1. First pass: honour configured ownerRoleKey + strict matter visibility gate.
  for (const candidateId of orderedCandidateIds) {
    const candidate = peopleById.get(candidateId);
    if (!isEligiblePerson(candidate)) continue;
    const roles = resolveEmployeeRoles(candidate, [...teams]);
    if (roles.includes(template.ownerRoleKey)) {
      return { assignedPersonId: candidate.id, assignedTeamId };
    }
  }

  // 2. Safe fallback: assign to an authorised matter lead/partner (never leak restricted matters outside the ACL).
  for (const fallbackId of [
    matter.leadFeeEarnerId,
    matter.responsiblePartnerId,
    matter.supervisingPartnerId,
  ]) {
    if (!fallbackId) continue;
    const candidate = peopleById.get(fallbackId);
    if (isEligiblePerson(candidate)) {
      return { assignedPersonId: candidate.id, assignedTeamId };
    }
  }

  return { assignedPersonId: null, assignedTeamId };
}

export async function instantiateWorkTypeAutoTasksInTx(params: {
  ctx: TenantContext;
  matter: Matter;
  people: readonly Person[];
  teams: readonly Team[];
  existingTasks: readonly Task[];
  workTypesConfig: WorkTypesConfiguration;
  values: readonly ChoiceValue[];
  workingHoursConfig: WorkingHoursConfig;
  trigger: WorkTypeAutoTaskTrigger;
  byId: string;
  nowIso: string;
  taskRepo: TaskRepoInTx;
  writeAuditFn: (entry: Omit<AuditEntry, 'id'>) => void;
  pushNotificationFn: (
    ctx: TenantContext,
    input: {
      recipientId: string;
      kind: NotificationKind;
      title: string;
      detail: string;
      href: string;
      recordId: string;
      byId: string;
      at?: string;
    },
  ) => Promise<NotificationItem | null>;
}): Promise<{ createdTasks: Task[]; source: 'work_type' | 'practice_area' | 'firm_default' }> {
  const {
    ctx,
    matter,
    people,
    teams,
    existingTasks,
    workTypesConfig,
    values,
    workingHoursConfig,
    trigger,
    byId,
    nowIso,
    taskRepo,
    writeAuditFn,
    pushNotificationFn,
  } = params;

  const resolved = resolveWorkTypeAutoTaskTemplates(workTypesConfig, {
    workTypeSubcategoryId: matter.workTypeSubcategoryId,
    practiceAreaId: matter.practiceAreaId,
  });
  const activeTemplates = resolved.templates.filter((t) => t.trigger === trigger);
  if (activeTemplates.length === 0) {
    return { createdTasks: [], source: resolved.source };
  }

  const existingKeys = new Set<string>();
  for (const task of existingTasks) {
    if (task.idempotencyKey) existingKeys.add(task.idempotencyKey);
    if (task.systemKey) existingKeys.add(task.systemKey);
  }

  const taskTypeId = resolveWorkTypeTaskTypeId(values);
  const createdTasks: Task[] = [];
  const baseDate = new Date(nowIso);

  for (const tpl of activeTemplates) {
    const idempotencyKey = `worktype-open:${matter.id}:${tpl.id}`;
    if (existingKeys.has(idempotencyKey)) continue;

    const title = tpl.title
      .replaceAll('{matterNumber}', matter.matterNumber || matter.id)
      .replaceAll('{title}', matter.title || '')
      .trim();
    const dueAt = toIsoDate(
      addWorkingDays(baseDate, tpl.dueWorkingDaysOffset, workingHoursConfig),
    );
    const priorityId = resolveWorkTypeTaskPriorityId(tpl.priorityId, values);
    const { assignedPersonId, assignedTeamId } = resolveAssigneeForWorkTypeAutoTask(
      tpl,
      matter,
      people,
      teams,
    );

    const taskId = await taskRepo.allocateNextTaskId(ctx);
    const linkedRecords: Task['linkedRecords'] = [
      { recordType: 'matter', recordId: matter.id },
      ...(matter.clientId
        ? [
            matter.clientId.startsWith('P-')
              ? { recordType: 'person' as const, recordId: matter.clientId }
              : { recordType: 'organisation' as const, recordId: matter.clientId },
          ]
        : []),
    ];

    const task: Task = {
      id: taskId,
      reference: taskId,
      title,
      description: `Schema-driven work-type task (${tpl.id}) generated on matter opening for ${matter.matterNumber || matter.id}.`,
      taskTypeId,
      priorityId,
      dueAt,
      assignedTeamId,
      assignedPersonId,
      status: 'To do',
      linkedRecords,
      createdById: byId,
      createdAt: nowIso,
      updatedById: byId,
      updatedAt: nowIso,
      completedById: null,
      completedAt: null,
      comments: [],
      autoTrigger: 'work_type_auto_task',
      idempotencyKey,
      systemKey: idempotencyKey,
    };

    await taskRepo.putTask(ctx, task as TenantTaskRecord);
    existingKeys.add(idempotencyKey);
    createdTasks.push(task);

    writeAuditFn({
      recordType: 'task',
      recordId: task.id,
      action: 'create',
      field: `Work-type automatic task (${trigger})`,
      oldValue: null,
      newValue: `${task.reference} — ${task.title}`,
      byId,
      at: nowIso,
    });

    if (task.assignedPersonId) {
      await pushNotificationFn(ctx, {
        recipientId: task.assignedPersonId,
        kind: 'task_assigned',
        title: `Task assigned to you: ${task.title}`,
        detail: `${task.reference} · Due ${formatDate(task.dueAt)}`,
        href: `/tasks/${task.id}`,
        recordId: task.id,
        byId,
        at: nowIso,
      });
    }
  }

  return { createdTasks, source: resolved.source };
}

export interface ServerWorkTypeRetentionOutcome {
  readonly isClosingTransition: boolean;
  readonly isReopeningTransition: boolean;
  readonly isClosedNow: boolean;
  readonly closedAt: string | null;
  readonly destructionDueAt: string | null;
  readonly retentionPeriod: string;
  readonly retentionYears: number;
  readonly source: 'work_type' | 'practice_area' | 'firm_default';
}

export function computeServerWorkTypeRetentionState(params: {
  prevMatter: Matter | null | undefined;
  nextStatusId: string;
  closedAtInput?: string | null;
  workTypeSubcategoryId?: string | null;
  practiceAreaId?: string | null;
  workTypesConfig: WorkTypesConfiguration;
  values: readonly ChoiceValue[];
  todayIso: string;
}): ServerWorkTypeRetentionOutcome {
  const {
    prevMatter,
    nextStatusId,
    closedAtInput,
    workTypeSubcategoryId,
    practiceAreaId,
    workTypesConfig,
    values,
    todayIso,
  } = params;

  const wasClosed = prevMatter
    ? isClosedOrArchivedMatterStatus(prevMatter.matterStatusId, values)
    : false;
  const isClosedNow = isClosedOrArchivedMatterStatus(nextStatusId, values);
  const isClosingTransition = isClosedNow && !wasClosed;
  const isReopeningTransition = wasClosed && !isClosedNow;

  const retention = resolveWorkTypeRetention(workTypesConfig, {
    workTypeSubcategoryId,
    practiceAreaId,
  });
  const retentionLabel = formatRetentionPeriodLabel(retention.retentionYears);

  if (isClosedNow) {
    const rawClosedAt =
      (closedAtInput && closedAtInput.trim()) ||
      (prevMatter?.closedAt && prevMatter.closedAt.trim()) ||
      todayIso;
    const closedAt = rawClosedAt.slice(0, 10) || todayIso;

    const destructionDueAt = calculateDestructionDate(
      closedAt,
      retention.retentionYears,
    );

    return {
      isClosingTransition,
      isReopeningTransition: false,
      isClosedNow: true,
      closedAt,
      destructionDueAt,
      retentionPeriod: retentionLabel,
      retentionYears: retention.retentionYears,
      source: retention.source,
    };
  }

  return {
    isClosingTransition: false,
    isReopeningTransition,
    isClosedNow: false,
    closedAt: null,
    destructionDueAt: null,
    retentionPeriod: retentionLabel,
    retentionYears: retention.retentionYears,
    source: retention.source,
  };
}

export function syncPracticeAreasFromOrgStructure(
  orgStructure: OrgStructureCatalogue,
  values: readonly ChoiceValue[],
): ChoiceValue[] {
  const validDeptIds = new Set(orgStructure.departments.map((d) => d.id));
  const deptByPracticeAreaId = new Map<string, string>();
  for (const dept of orgStructure.departments) {
    for (const paId of dept.practiceAreaIds ?? []) {
      if (!deptByPracticeAreaId.has(paId)) {
        deptByPracticeAreaId.set(paId, dept.id);
      }
    }
  }

  const changedValues: ChoiceValue[] = [];
  for (const value of values) {
    if (value.listKey !== 'work_type' || value.parentId) continue;
    const mappedDeptId = deptByPracticeAreaId.get(value.id);
    const currentDeptId = value.meta?.departmentId;

    if (mappedDeptId && currentDeptId !== mappedDeptId) {
      value.meta = { ...(value.meta ?? {}), departmentId: mappedDeptId };
      changedValues.push(value);
    } else if (!mappedDeptId && currentDeptId && !validDeptIds.has(currentDeptId)) {
      const nextMeta = { ...(value.meta ?? {}) };
      delete nextMeta.departmentId;
      value.meta = Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
      changedValues.push(value);
    } else if (!mappedDeptId && currentDeptId && validDeptIds.has(currentDeptId)) {
      const ownerDept = orgStructure.departments.find((d) => d.id === currentDeptId);
      if (ownerDept && Array.isArray(ownerDept.practiceAreaIds)) {
        // Explicit practiceAreaIds array on departments is the source of truth when edited in Admin.
        const nextMeta = { ...(value.meta ?? {}) };
        delete nextMeta.departmentId;
        value.meta = Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
        changedValues.push(value);
      }
    }
  }
  return changedValues;
}

export function syncOrgDepartmentsForPracticeAreaValue(
  orgStructure: OrgStructureCatalogue,
  practiceAreaValue: ChoiceValue,
): boolean {
  if (practiceAreaValue.listKey !== 'work_type' || practiceAreaValue.parentId) {
    return false;
  }
  const desiredDeptId = practiceAreaValue.meta?.departmentId;
  let changed = false;

  for (const dept of orgStructure.departments) {
    const currentIds = Array.isArray(dept.practiceAreaIds) ? dept.practiceAreaIds : [];
    const hasPa = currentIds.includes(practiceAreaValue.id);
    if (dept.id === desiredDeptId && !hasPa) {
      dept.practiceAreaIds = [...currentIds, practiceAreaValue.id];
      changed = true;
    } else if (dept.id !== desiredDeptId && hasPa) {
      dept.practiceAreaIds = currentIds.filter((id) => id !== practiceAreaValue.id);
      changed = true;
    }
  }
  return changed;
}
