'use server';

import { revalidatePath } from 'next/cache';
import type {
  AppRole,
  AutoTaskTrigger,
  CapacityGroupName,
  ConflictCheckRecordInput,
  ContactLogMethod,
  ContactLogOutcome,
  CustomFieldRecordType,
  CustomFieldType,
  EmployeeSensitiveRecord,
  EmploymentRecord,
  Enquiry,
  EnquirySettings,
  FormSection,
  HomeFirmSettings,
  Matter,
  MatterCostsConfig,
  Organisation,
  OrgStructureCatalogue,
  Person,
  PmsEntityType,
  QuoteDeclineReason,
  QuoteDisbursement,
  QuoteFeeBasis,
  RecordType,
  RoleHomeConfig,
  TaskLinkedRecord,
  TaskSettings,
  TaskStatus,
  WorkTypeProfileCode,
} from '@/domain/types';
import {
  addChoiceValue,
  addHomeRole,
  addNoteToRecord,
  addTaskCommentRecord,
  anonymiseExpiredEnquiries,
  approveSignOff,
  assignEnquiryRecord,
  clearAllDataToCleanDeployment,
  closeEnquiryRecord,
  createMatterStageGroup,
  createOrUpdateLink,
  createRecordFromPms,
  deleteLink,
  deleteMatterPartyCapacity,
  deleteMatterPartyRelationship,
  discussSignOff,
  dismissDuplicateMatch,
  executeMerge,
  flagMatterWriteOff,
  getEmployeeDetailsForUser,
  isDataResetAllowedEnvironment,
  liftMatterRestriction,
  linkPmsRecord,
  logEmployeeRestrictedAccess,
  logEnquiryContactRecord,
  logQuoteFollowUpRecord,
  markAllNotificationsRead,
  markEngagementLetterDrafted,
  markNotificationRead,
  markQuoteSentRecord,
  prepareEnquiryConversion,
  prepareQuoteConversionRecord,
  reassignLeaverOwnedRecords,
  recordInvoiceCreditControlAction,
  recordQuoteOutcomeRecord,
  remindTeamLeadOverdueCompliance,
  reopenEnquiryRecord,
  reorderChoiceValue,
  reorderCustomField,
  reorderMatterPartyRelationship,
  requestMatterBill,
  rerunAutomaticPmsMatching,
  resetAllDemoData,
  resetHomePagesConfig,
  reviseQuoteRecord,
  runMatterConflictSearchRecord,
  saveCustomFieldDefinition,
  saveEnquiryRecord,
  saveEnquirySettingsRecord,
  saveHomePagesConfig,
  saveMatterCostsConfig,
  saveMatterPartyCapacity,
  saveMatterPartyRelationship,
  saveOrgStructure,
  saveMatterRecord,
  saveOrganisationRecord,
  savePersonRecord,
  saveQuoteRecord,
  type SaveQuoteInput,
  saveTaskRecord,
  saveTaskSettingsRecord,
  signOffMatterCostsRecord,
  syncMatterCostsRatesFromPms,
  updateMatterConflictRecord,
  saveTeamRecord,
  sendEnquiryEmailRecord,
  switchUserInDemoMode,
  switchViewingRole,
  takeTaskRecord,
  unlinkPmsRecord,
  updateChoiceValue,
  updateEmployeeRolesAndSupports,
  updateEmployeeRoleSetting,
  previewRbacOverrides,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
  updateWorkTypeProfiles,
  previewLimitationCalculationRecord,
  createOrProposeKeyDateRecord,
  proposeProvisionalKeyDateRecord,
  verifyProposedKeyDateRecord,
  rejectProposedKeyDateRecord,
  supersedeConfirmedKeyDateRecord,
  resolveKeyDateOutcomeRecord,
  reassignKeyDateTeamRecord,
  recordKeyDateNotApplicableRecord,
  acknowledgeKeyDateReminderRecord,
  runKeyDateReminderSchedulerRecord,
  queryKeyDatesTeamDiaryRecord,
  getKeyDateExceptionsReportRecord,
  exportKeyDateExceptionsReportRecord,
  saveKeyDatesConfigRecord,
} from '@/server/services';
import type {
  KeyDateCalculation,
  KeyDateExceptionKind,
  KeyDatesConfig,
  StandstillPeriod,
  TeamDiaryQuery,
} from '@/domain/keyDates.types';
import { buildActionDenied } from '@/domain/actionResult';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import { guardedAction } from '@/server/authorize';
import { createVerifiedSessionActorFromEntraSession } from '@/server/entraAuth';
import { getStore } from '@/server/store';
import type { PermissionKey, RbacConfiguration } from '@/domain/rbac';

function revalidateAll() {
  try {
    revalidatePath('/', 'layout');
  } catch {
    // Ignore when called outside Next.js static generation / request context in unit tests
  }
}

export async function switchUserAction(
  userId: string,
): Promise<{ ok: true; personId: string } | { ok: false; error: string }> {
  return guardedAction('switchUserAction', async () => {
    const res = await switchUserInDemoMode(userId);
    revalidateAll();
    return { ok: true, personId: res.personId };
  });
}

export async function savePersonAction(
  payload: Partial<Person> & { firstName: string; surname: string },
  opts: {
    id?: string;
    customFieldsSubmitted?: Record<string, unknown>;
    flagPossibleDuplicate?: boolean;
    matchedDuplicateIds?: string[];
    worksAtFirm?: boolean;
    employmentSubmitted?: Partial<EmploymentRecord> | null;
    sensitiveSubmitted?: Partial<EmployeeSensitiveRecord> | null;
    sensitiveSectionOpened?: boolean;
    sensitiveSectionEdited?: boolean;
    keepAsContactOnLeave?: boolean;
    initialLink?: {
      organisationId: string;
      jobTitle?: string;
      department?: string;
      roleWithinOrganisation?: string;
      contactRoleIds?: string[];
      isPrimaryContact?: boolean;
      startDate?: string | null;
    } | null;
  },
) {
  return guardedAction('savePersonAction', ({ personId: byId, tenantContext }) => {
    const PERSON_SECURITY_FIELDS = [
      'roles',
      'permissionOverrides',
      'appRole',
      'employeePermissions',
      'documentPermissions',
      'supportsIds',
      'showsWorkOfId',
      'demo',
      'entraObjectId',
    ] as const;
    const forbiddenField = PERSON_SECURITY_FIELDS.find(
      (key) => payload[key] !== undefined,
    );
    if (forbiddenField) {
      const msg = `Security field "${forbiddenField}" cannot be set or modified through person save. Use the dedicated RBAC administration actions.`;
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: null as unknown as Person,
        errors: { permission: msg },
      };
    }
    const res = savePersonRecord(payload, {
      id: opts?.id,
      byId,
      mfaVerified: tenantContext.mfaVerified,
      customFieldsSubmitted: opts?.customFieldsSubmitted,
      flagPossibleDuplicate: opts?.flagPossibleDuplicate,
      matchedDuplicateIds: opts?.matchedDuplicateIds,
      worksAtFirm: opts?.worksAtFirm,
      employmentSubmitted: opts?.employmentSubmitted,
      sensitiveSubmitted: opts?.sensitiveSubmitted,
      sensitiveSectionOpened: opts?.sensitiveSectionOpened,
      sensitiveSectionEdited: opts?.sensitiveSectionEdited,
      keepAsContactOnLeave: opts?.keepAsContactOnLeave,
      initialLink: opts?.initialLink,
    });
    revalidateAll();
    return res;
  });
}

export async function logEmployeeRestrictedAccessAction(
  personId: string,
  section: 'payroll' | 'sensitive',
  fieldDetail?: string,
) {
  return guardedAction('logEmployeeRestrictedAccessAction', ({ personId: byId }) => {
    const res = logEmployeeRestrictedAccess(personId, section, byId, fieldDetail);
    revalidateAll();
    return res;
  });
}

export async function revealEmployeeSensitiveRecordAction(personId: string) {
  return guardedAction('revealEmployeeSensitiveRecordAction', ({ personId: byId }) => {
    const res = getEmployeeDetailsForUser(personId, byId, { logViewSensitive: true });
    revalidateAll();
    return {
      ok: !res.errors?.sensitivePermission && !res.errors?.notFound,
      sensitive: res.sensitive,
      errors: res.errors,
    };
  });
}

export async function reassignLeaverOwnedRecordsAction(
  fromLeaverId: string,
  toEmployeeId: string,
) {
  return guardedAction('reassignLeaverOwnedRecordsAction', ({ personId: byId }) => {
    const res = reassignLeaverOwnedRecords(fromLeaverId, toEmployeeId, byId);
    revalidateAll();
    return res;
  });
}

export async function saveOrganisationAction(
  payload: Partial<Organisation> & { legalName: string },
  opts: {
    id?: string;
    customFieldsSubmitted?: Record<string, unknown>;
    flagPossibleDuplicate?: boolean;
    matchedDuplicateIds?: string[];
  },
) {
  return guardedAction('saveOrganisationAction', ({ personId: byId }) => {
    const res = saveOrganisationRecord(payload, {
      id: opts?.id,
      byId,
      customFieldsSubmitted: opts?.customFieldsSubmitted,
      flagPossibleDuplicate: opts?.flagPossibleDuplicate,
      matchedDuplicateIds: opts?.matchedDuplicateIds,
    });
    revalidateAll();
    return res;
  });
}

export async function saveMatterAction(
  payload: Omit<
    Partial<Matter>,
    'conflictClearedById' | 'conflictCheckRecord' | 'conflictCheckStatus'
  > & {
    title: string;
    clientId: string;
    practiceAreaId: string;
    workTypeSubcategoryId: string;
    conflictCheckRecord?: ConflictCheckRecordInput;
  },
  opts: {
    id?: string;
    saveMode?: 'draft' | 'submit_cleared' | 'submit_referred';
  } = {},
) {
  return guardedAction('saveMatterAction', async ({ personId: byId }) => {
    const res = await saveMatterRecord(payload, {
      id: opts.id,
      saveMode: opts.saveMode,
      byId,
    });
    revalidateAll();
    return res;
  });
}

export async function signOffMatterCostsAction(matterId: string, note?: string) {
  return guardedAction('signOffMatterCostsAction', async (actor) => {
    const res = await signOffMatterCostsRecord(matterId, actor.personId, note);
    revalidateAll();
    return res;
  });
}

export async function markEngagementLetterDraftedAction(matterId: string) {
  return guardedAction('markEngagementLetterDraftedAction', ({ personId: byId }) => {
    const res = markEngagementLetterDrafted(matterId, byId);
    revalidateAll();
    return res;
  });
}

export async function liftMatterRestrictionAction(
  matterId: string,
  restriction: 'staff_matter' | 'ethical_wall',
  reason: string,
) {
  return guardedAction('liftMatterRestrictionAction', ({ personId: byId }) => {
    const res = liftMatterRestriction(matterId, restriction, reason, byId);
    revalidateAll();
    return res;
  });
}

export async function runMatterConflictSearchAction(
  input: Parameters<typeof runMatterConflictSearchRecord>[0],
) {
  return guardedAction('runMatterConflictSearchAction', (actor) => {
    return runMatterConflictSearchRecord(input, actor.personId);
  });
}

export async function updateMatterConflictRecordAction(
  matterId: string,
  record: ConflictCheckRecordInput,
) {
  return guardedAction('updateMatterConflictRecordAction', ({ personId: byId }) => {
    const res = updateMatterConflictRecord(matterId, record, byId);
    revalidateAll();
    return res;
  });
}

export async function saveLinkAction(input: {
  id?: string;
  personId: string;
  organisationId: string;
  jobTitle: string;
  department: string;
  roleWithinOrganisation: string;
  contactRoleIds: string[];
  isPrimaryContact: boolean;
  isCurrent: boolean;
  startDate: string | null;
  endDate: string | null;
  contactStatusId: string | null;
}) {
  return guardedAction('saveLinkAction', ({ personId: byId }) => {
    const link = createOrUpdateLink(input, byId);
    revalidateAll();
    return link;
  });
}

export async function deleteLinkAction(linkId: string) {
  return guardedAction('deleteLinkAction', ({ personId: byId }) => {
    const res = deleteLink(linkId, byId);
    revalidateAll();
    return res;
  });
}

export async function addNoteAction(recordType: RecordType | 'matter', recordId: string, text: string) {
  return guardedAction('addNoteAction', ({ personId: byId }) => {
    const note = addNoteToRecord(recordType, recordId, text, byId);
    revalidateAll();
    return note;
  });
}

export async function dismissDuplicateAction(recordType: RecordType, recordId: string, otherId: string | null) {
  return guardedAction('dismissDuplicateAction', ({ personId: byId }) => {
    const res = dismissDuplicateMatch(recordType, recordId, otherId, byId);
    revalidateAll();
    return res;
  });
}

export async function mergeRecordsAction(recordType: RecordType, survivorId: string, mergedId: string) {
  return guardedAction('mergeRecordsAction', ({ personId: byId }) => {
    const hist = executeMerge(recordType, survivorId, mergedId, byId);
    revalidateAll();
    return hist;
  });
}

export async function addChoiceValueAction(input: {
  listKey: string;
  label: string;
  description?: string;
  guidance?: string;
  parentId?: string | null;
  meta?: Record<string, string>;
}) {
  return guardedAction('addChoiceValueAction', ({ personId: byId }) => {
    const val = addChoiceValue(input, byId);
    revalidateAll();
    return val;
  });
}

export async function updateChoiceValueAction(
  id: string,
  patch: {
    label?: string;
    description?: string;
    guidance?: string;
    active?: boolean;
    meta?: Record<string, string>;
  },
) {
  return guardedAction('updateChoiceValueAction', ({ personId: byId }) => {
    const res = updateChoiceValue(id, patch, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderChoiceValueAction(id: string, direction: -1 | 1) {
  return guardedAction('reorderChoiceValueAction', ({ personId: byId }) => {
    const store = getStore();
    if (!store.values.some((v) => v.id === id)) {
      return buildActionDenied('FORBIDDEN', `Choice value "${id}" not found.`);
    }
    reorderChoiceValue(id, direction, byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function createMatterStageGroupAction(input: {
  label: string;
  description?: string;
  mode: 'from_default' | 'scratch';
  selectedDefaultStageIds?: string[];
}) {
  return guardedAction('createMatterStageGroupAction', ({ personId: byId }) => {
    const res = createMatterStageGroup(input, byId);
    revalidateAll();
    return res;
  });
}

export async function saveCustomFieldAction(input: {
  id?: string;
  recordType: CustomFieldRecordType;
  label: string;
  fieldType: CustomFieldType;
  section: FormSection;
  required: boolean;
  active?: boolean;
  options?: string[];
}) {
  return guardedAction('saveCustomFieldAction', ({ personId: byId }) => {
    if (input.id && !getStore().customFields.some((d) => d.id === input.id)) {
      return buildActionDenied('FORBIDDEN', `Custom field "${input.id}" not found.`);
    }
    const def = saveCustomFieldDefinition(input, byId);
    revalidateAll();
    return def;
  });
}

export async function reorderCustomFieldAction(id: string, direction: -1 | 1) {
  return guardedAction('reorderCustomFieldAction', ({ personId: byId }) => {
    if (!getStore().customFields.some((d) => d.id === id)) {
      return buildActionDenied('FORBIDDEN', `Custom field "${id}" not found.`);
    }
    reorderCustomField(id, direction, byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function resetDemoDataAction() {
  return guardedAction('resetDemoDataAction', ({ personId: byId }) => {
    if (!isDataResetAllowedEnvironment()) {
      const env = getActiveTenantConfiguration().environment;
      return buildActionDenied(
        'FORBIDDEN',
        env === 'live'
          ? 'Demo data reset is disabled in the live environment.'
          : 'Demo data reset is disabled when enableDemoMode is false.',
      );
    }
    resetAllDemoData(byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function clearAllDataAction() {
  return guardedAction('clearAllDataAction', ({ personId: byId }) => {
    if (!isDataResetAllowedEnvironment()) {
      const env = getActiveTenantConfiguration().environment;
      return buildActionDenied(
        'FORBIDDEN',
        env === 'live'
          ? 'Clearing all data is disabled in the live environment.'
          : 'Clearing all data is disabled when enableDemoMode is false.',
      );
    }
    clearAllDataToCleanDeployment(byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function markNotificationReadAction(id: string) {
  return guardedAction('markNotificationReadAction', ({ personId: userId }) => {
    markNotificationRead(id, userId);
    revalidateAll();
  });
}

export async function markAllNotificationsReadAction() {
  return guardedAction('markAllNotificationsReadAction', ({ personId: userId }) => {
    markAllNotificationsRead(userId);
    revalidateAll();
  });
}

export async function saveTeamAction(input: {
  id?: string;
  name: string;
  description?: string;
  memberIds: string[];
  leadIds: string[];
  practiceAreaIds: string[];
  active?: boolean;
}) {
  return guardedAction('saveTeamAction', ({ personId: byId }) => {
    const res = saveTeamRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function updateEmployeeRoleAction(personId: string, appRole: AppRole | null) {
  return guardedAction('updateEmployeeRoleAction', (actor) => {
    const res = updateEmployeeRoleSetting(personId, appRole, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function saveEnquirySettingsAction(patch: Partial<EnquirySettings>) {
  return guardedAction('saveEnquirySettingsAction', ({ personId: byId }) => {
    const res = saveEnquirySettingsRecord(patch, byId);
    revalidateAll();
    return res;
  });
}

export async function saveTaskSettingsAction(settings: TaskSettings) {
  return guardedAction('saveTaskSettingsAction', ({ personId: byId }) => {
    const res = saveTaskSettingsRecord(settings, byId);
    revalidateAll();
    return res;
  });
}

export async function saveTaskAction(input: {
  id?: string;
  title: string;
  description?: string;
  taskTypeId?: string;
  priorityId?: string;
  dueAt: string;
  assignedTeamId?: string | null;
  assignedPersonId?: string | null;
  assignedPersonIds?: string[];
  multiAssigneeMode?: 'shared' | 'separate';
  status?: TaskStatus;
  linkedRecords?: TaskLinkedRecord[];
  autoTrigger?: AutoTaskTrigger | null;
}) {
  return guardedAction('saveTaskAction', ({ personId: byId }) => {
    const res = saveTaskRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function takeTaskAction(taskId: string) {
  return guardedAction('takeTaskAction', ({ personId: byId }) => {
    const res = takeTaskRecord(taskId, byId);
    revalidateAll();
    return res;
  });
}

export async function addTaskCommentAction(taskId: string, text: string) {
  return guardedAction('addTaskCommentAction', ({ personId: byId }) => {
    const res = addTaskCommentRecord(taskId, text, byId);
    revalidateAll();
    return res;
  });
}

export async function saveEnquiryAction(
  payload: Partial<Enquiry> & {
    firstName?: string;
    lastName?: string;
    channelId?: string;
    practiceAreaId?: string;
    summary?: string;
    notes?: string;
    urgencyId?: string;
    privacyNoticeGiven?: boolean;
  },
  opts: { id?: string; asDraft?: boolean } = {},
) {
  return guardedAction('saveEnquiryAction', ({ personId: byId }) => {
    const res = saveEnquiryRecord(payload, {
      id: opts.id,
      asDraft: opts.asDraft,
      byId,
    });
    revalidateAll();
    return res;
  });
}

export async function assignEnquiryAction(
  enquiryId: string,
  assignedToId: string | null,
  assignedTeamId?: string | null,
) {
  return guardedAction('assignEnquiryAction', ({ personId: byId }) => {
    const res = assignEnquiryRecord(enquiryId, assignedToId, assignedTeamId, byId);
    revalidateAll();
    return res;
  });
}

export async function logEnquiryContactAction(
  enquiryId: string,
  input: {
    at?: string;
    method: ContactLogMethod;
    outcome: ContactLogOutcome;
    note: string;
  },
) {
  return guardedAction('logEnquiryContactAction', ({ personId: byId }) => {
    const res = logEnquiryContactRecord(enquiryId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function sendEnquiryEmailAction(
  enquiryId: string,
  input: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
  },
) {
  return guardedAction('sendEnquiryEmailAction', ({ personId: byId }) => {
    const res = sendEnquiryEmailRecord(enquiryId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function closeEnquiryAction(
  enquiryId: string,
  input: {
    targetStatus: 'Declined' | 'Referred out' | 'No response';
    closeReasonId?: string | null;
    closeNotes?: string;
    referredToOrganisationId?: string | null;
    referredToName?: string;
  },
) {
  return guardedAction('closeEnquiryAction', ({ personId: byId }) => {
    const res = closeEnquiryRecord(enquiryId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function reopenEnquiryAction(enquiryId: string) {
  return guardedAction('reopenEnquiryAction', ({ personId: byId }) => {
    const res = reopenEnquiryRecord(enquiryId, byId);
    revalidateAll();
    return res;
  });
}

export async function prepareEnquiryConversionAction(
  enquiryId: string,
  opts: {
    usePersonId?: string | null;
    useOrganisationId?: string | null;
    createForBusiness?: boolean;
  } = {},
) {
  return guardedAction('prepareEnquiryConversionAction', ({ personId: byId }) => {
    const res = prepareEnquiryConversion(
      enquiryId,
      {
        usePersonId: opts?.usePersonId,
        useOrganisationId: opts?.useOrganisationId,
        createForBusiness: opts?.createForBusiness,
      },
      byId,
    );
    revalidateAll();
    return res;
  });
}

export async function anonymiseExpiredEnquiriesAction(specificEnquiryId?: string) {
  return guardedAction('anonymiseExpiredEnquiriesAction', ({ personId: byId }) => {
    const count = anonymiseExpiredEnquiries(byId, specificEnquiryId);
    revalidateAll();
    return { count };
  });
}

export async function linkPmsRecordAction(
  entityType: PmsEntityType,
  onesquaredId: string,
  pmsCode: string,
) {
  return guardedAction('linkPmsRecordAction', ({ personId: byId }) => {
    const store = getStore();
    const recordExists =
      entityType === 'employee'
        ? store.people.some((p) => p.id === onesquaredId && p.isEmployee)
        : entityType === 'person'
          ? store.people.some((p) => p.id === onesquaredId)
          : entityType === 'organisation'
            ? store.organisations.some((o) => o.id === onesquaredId)
            : store.matters.some((m) => m.id === onesquaredId);
    if (!recordExists) {
      return buildActionDenied(
        'FORBIDDEN',
        `Target ${entityType} "${onesquaredId}" not found.`,
      );
    }
    const res = linkPmsRecord(entityType, onesquaredId, pmsCode, byId);
    revalidateAll();
    return res;
  });
}

export async function unlinkPmsRecordAction(linkId: string) {
  return guardedAction('unlinkPmsRecordAction', ({ personId: byId }) => {
    if (!getStore().pmsLinks.some((l) => l.id === linkId)) {
      return buildActionDenied('FORBIDDEN', `PMS link "${linkId}" not found.`);
    }
    unlinkPmsRecord(linkId, byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function rerunAutomaticPmsMatchingAction() {
  return guardedAction('rerunAutomaticPmsMatchingAction', ({ personId: byId }) => {
    const res = rerunAutomaticPmsMatching(byId);
    revalidateAll();
    return res;
  });
}

export async function createRecordFromPmsAction(entityType: PmsEntityType, pmsCode: string) {
  return guardedAction('createRecordFromPmsAction', async ({ personId: byId, mfaVerified }) => {
    const res = await createRecordFromPms(entityType, pmsCode, byId, { mfaVerified });
    revalidateAll();
    return res;
  });
}

export async function switchViewingRoleAction(roleKey: string) {
  return guardedAction('switchViewingRoleAction', ({ personId: userId }) => {
    const res = switchViewingRole(userId, roleKey);
    revalidateAll();
    return res;
  });
}

export async function saveHomePagesConfigAction(input: {
  roles?: RoleHomeConfig[];
  firmSettings?: Partial<HomeFirmSettings>;
}) {
  return guardedAction('saveHomePagesConfigAction', (actor) => {
    const res = saveHomePagesConfig(input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function resetHomePagesConfigAction() {
  return guardedAction('resetHomePagesConfigAction', (actor) => {
    const res = resetHomePagesConfig(actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function addHomeRoleAction(input: {
  key?: string;
  label: string;
  shortLabel?: string;
  purpose: string;
  copyFromRoleKey?: string;
}) {
  return guardedAction('addHomeRoleAction', (actor) => {
    const res = addHomeRole(input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function updateEmployeeRolesAndSupportsAction(
  personId: string,
  input: {
    roles?: string[];
    supportsIds?: string[];
  },
) {
  return guardedAction('updateEmployeeRolesAndSupportsAction', (actor) => {
    const res = updateEmployeeRolesAndSupports(personId, input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function previewRbacOverridesAction(
  personId: string,
  draftOverrides: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    rbacConfig?: RbacConfiguration;
  },
) {
  return guardedAction('previewRbacOverridesAction', (actor) =>
    previewRbacOverrides(personId, draftOverrides, actor.personId, {
      mfaVerified: actor.session.mfaVerified === true,
    }),
  );
}

export async function updatePersonPermissionOverridesAction(
  personId: string,
  input: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    reason?: string;
    entraObjectId?: string | null;
  },
) {
  return guardedAction('updatePersonPermissionOverridesAction', (actor) => {
    const res = updatePersonPermissionOverrides(personId, input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function updateTenantRbacConfigAction(
  patch: Partial<RbacConfiguration>,
) {
  return guardedAction('updateTenantRbacConfigAction', (actor) => {
    const res = updateTenantRbacConfig(patch, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function approveSignOffAction(signOffId: string) {
  return guardedAction('approveSignOffAction', ({ personId: byId }) => {
    const res = approveSignOff(signOffId, byId);
    revalidateAll();
    return res;
  });
}

export async function discussSignOffAction(signOffId: string, note: string) {
  return guardedAction('discussSignOffAction', ({ personId: byId }) => {
    const res = discussSignOff(signOffId, note, byId);
    revalidateAll();
    return res;
  });
}

export async function requestMatterBillAction(matterCode: string) {
  return guardedAction('requestMatterBillAction', ({ personId: byId }) => {
    const res = requestMatterBill(matterCode, byId);
    revalidateAll();
    return res;
  });
}

export async function flagMatterWriteOffAction(matterCode: string, amountGbp: number) {
  return guardedAction('flagMatterWriteOffAction', ({ personId: byId }) => {
    const res = flagMatterWriteOff(matterCode, amountGbp, byId);
    revalidateAll();
    return res;
  });
}

export async function remindTeamLeadOverdueComplianceAction(teamId: string) {
  return guardedAction('remindTeamLeadOverdueComplianceAction', ({ personId: byId }) => {
    const res = remindTeamLeadOverdueCompliance(teamId, byId);
    revalidateAll();
    return res;
  });
}

export async function recordInvoiceCreditControlActionAction(input: {
  invoiceNumber: string;
  matterCode: string;
  clientCode: string;
  actionType: 'log_call' | 'send_reminder' | 'escalate';
  note?: string;
}) {
  return guardedAction('recordInvoiceCreditControlActionAction', ({ personId: byId }) => {
    const res = recordInvoiceCreditControlAction(input, byId);
    revalidateAll();
    return res;
  });
}

export async function saveOrgStructureAction(nextCatalogue: OrgStructureCatalogue) {
  return guardedAction('saveOrgStructureAction', ({ personId: byId }) => {
    const res = saveOrgStructure(nextCatalogue, byId);
    revalidateAll();
    return res;
  });
}

export async function saveMatterPartyRelationshipAction(input: {
  code: string;
  label: string;
  description?: string;
  active?: boolean;
  isNew?: boolean;
}) {
  return guardedAction('saveMatterPartyRelationshipAction', ({ personId: byId }) => {
    const res = saveMatterPartyRelationship(input, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderMatterPartyRelationshipAction(code: string, direction: -1 | 1) {
  return guardedAction('reorderMatterPartyRelationshipAction', ({ personId: byId }) => {
    const res = reorderMatterPartyRelationship(code, direction, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyRelationshipAction(code: string) {
  return guardedAction('deleteMatterPartyRelationshipAction', ({ personId: byId }) => {
    const res = deleteMatterPartyRelationship(code, byId);
    revalidateAll();
    return res;
  });
}

export async function saveMatterPartyCapacityAction(input: {
  code: string;
  label: string;
  group: CapacityGroupName;
  description?: string;
  allowedRelationships: string[];
  profiles: WorkTypeProfileCode[];
  active?: boolean;
  isNew?: boolean;
}) {
  return guardedAction('saveMatterPartyCapacityAction', ({ personId: byId }) => {
    const res = saveMatterPartyCapacity(input, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyCapacityAction(code: string) {
  return guardedAction('deleteMatterPartyCapacityAction', ({ personId: byId }) => {
    const res = deleteMatterPartyCapacity(code, byId);
    revalidateAll();
    return res;
  });
}

export async function updateWorkTypeProfilesAction(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
) {
  return guardedAction('updateWorkTypeProfilesAction', ({ personId: byId }) => {
    const res = updateWorkTypeProfiles(workTypeSubcategoryId, profiles, byId);
    revalidateAll();
    return res;
  });
}

export async function saveQuoteAction(
  input: SaveQuoteInput,
  opts: { id?: string; markAsSent?: boolean } = {},
) {
  return guardedAction('saveQuoteAction', ({ personId: byId }) => {
    const res = saveQuoteRecord(input, {
      id: opts?.id,
      markAsSent: opts?.markAsSent,
      byId,
    });
    revalidateAll();
    return res;
  });
}

export async function markQuoteSentAction(quoteId: string) {
  return guardedAction('markQuoteSentAction', ({ personId: byId }) => {
    const res = markQuoteSentRecord(quoteId, byId);
    revalidateAll();
    return res;
  });
}

export async function logQuoteFollowUpAction(
  quoteId: string,
  input: {
    method: ContactLogMethod;
    note: string;
    nextFollowUpDate: string | null;
  },
) {
  return guardedAction('logQuoteFollowUpAction', ({ personId: byId }) => {
    const res = logQuoteFollowUpRecord(quoteId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function reviseQuoteAction(
  quoteId: string,
  input: {
    feeBasis: QuoteFeeBasis;
    feeAmountExVat: number;
    hourlyRateGbp?: number | null;
    vatAmount?: number;
    vatOverridden?: boolean;
    disbursements?: QuoteDisbursement[];
    scope: string;
    assumptions?: string;
    validUntil?: string;
    followUpAfterDays?: number;
    revisionNote?: string;
    markAsSent?: boolean;
  },
) {
  return guardedAction('reviseQuoteAction', ({ personId: byId }) => {
    const res = reviseQuoteRecord(quoteId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function recordQuoteOutcomeAction(
  quoteId: string,
  input: {
    outcome: 'Accepted' | 'Declined';
    declineReason?: QuoteDeclineReason | null;
    note?: string;
  },
) {
  return guardedAction('recordQuoteOutcomeAction', ({ personId: byId }) => {
    const res = recordQuoteOutcomeRecord(quoteId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function prepareQuoteConversionAction(quoteId: string) {
  return guardedAction('prepareQuoteConversionAction', ({ personId: byId }) => {
    const res = prepareQuoteConversionRecord(quoteId, byId);
    revalidateAll();
    return res;
  });
}

export async function saveMatterCostsConfigAction(config: MatterCostsConfig) {
  return guardedAction('saveMatterCostsConfigAction', ({ personId: byId }) => {
    const res = saveMatterCostsConfig(config, byId);
    revalidateAll();
    return res;
  });
}

export async function syncMatterCostsRatesFromPmsAction() {
  return guardedAction('syncMatterCostsRatesFromPmsAction', ({ personId: byId }) => {
    const res = syncMatterCostsRatesFromPms(byId);
    revalidateAll();
    return res;
  });
}

// ------------------------------------------------------------------ Document Generation Actions
import {
  approveTemplateVersionService,
  deleteGeneratedDocumentService,
  downloadGeneratedDocumentService,
  exportTemplatePackageService,
  generateDocumentService,
  getDocumentGenerationSnapshotForUser,
  getTemplateUsageReportService,
  importTemplatePackageService,
  previewTemplateService,
  rejectTemplateVersionService,
  retireTemplateService,
  rollbackTemplateVersionService,
  submitTemplateVersionService,
  updateDocumentGenerationConfigService,
  updateTemplateDraftService,
  uploadTemplateDraftService,
} from '@/server/documentGenerationServices';
import type {
  DocumentGenerationConfig,
  DocumentOutputFormat,
  PromptedFieldDefinition,
  TemplateAvailabilityRules,
  TemplatePackageManifest,
  TemplatePlaceholderMapping,
  TemplateUsageReportFilter,
} from '@platform/core';

export async function getDocumentGenerationSnapshotAction() {
  return guardedAction('getDocumentGenerationSnapshotAction', (actor) =>
    getDocumentGenerationSnapshotForUser(actor.personId, actor.session),
  );
}

export async function uploadTemplateDraftAction(input: {
  templateId?: string;
  code: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  outputDocumentType: string;
  filenamePattern: string;
  availabilityRules: TemplateAvailabilityRules;
  fileName: string;
  docxBase64: string;
  fieldMappings?: Record<string, TemplatePlaceholderMapping>;
  promptedFields?: PromptedFieldDefinition[];
  changeNote?: string;
}) {
  return guardedAction('uploadTemplateDraftAction', async (actor) => {
    const res = await uploadTemplateDraftService(
      input,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function updateTemplateDraftAction(input: {
  versionId: string;
  fieldMappings: Record<string, TemplatePlaceholderMapping>;
  promptedFields: PromptedFieldDefinition[];
  templateMetadata?: {
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    outputDocumentType?: string;
    filenamePattern?: string;
    availabilityRules?: TemplateAvailabilityRules;
  };
  changeNote?: string;
}) {
  return guardedAction('updateTemplateDraftAction', async (actor) => {
    const res = await updateTemplateDraftService(
      input,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function submitTemplateVersionAction(
  versionId: string,
  changeNote?: string,
) {
  return guardedAction('submitTemplateVersionAction', async (actor) => {
    const res = await submitTemplateVersionService(
      versionId,
      changeNote,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function approveTemplateVersionAction(versionId: string) {
  return guardedAction('approveTemplateVersionAction', async (actor) => {
    const res = await approveTemplateVersionService(
      versionId,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function rejectTemplateVersionAction(
  versionId: string,
  rejectionReason: string,
) {
  return guardedAction('rejectTemplateVersionAction', async (actor) => {
    const res = await rejectTemplateVersionService(
      versionId,
      rejectionReason,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function retireTemplateAction(templateId: string) {
  return guardedAction('retireTemplateAction', async (actor) => {
    const res = await retireTemplateService(
      templateId,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function rollbackTemplateVersionAction(
  templateId: string,
  targetVersionId: string,
) {
  return guardedAction('rollbackTemplateVersionAction', async (actor) => {
    const res = await rollbackTemplateVersionService(
      templateId,
      targetVersionId,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function exportTemplatePackageAction(
  templateId: string,
  versionId?: string,
) {
  return guardedAction('exportTemplatePackageAction', (actor) =>
    exportTemplatePackageService(
      templateId,
      versionId,
      actor.personId,
      actor.session,
    ),
  );
}

export async function importTemplatePackageAction(pkg: TemplatePackageManifest) {
  return guardedAction('importTemplatePackageAction', async (actor) => {
    const res = await importTemplatePackageService(
      pkg,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function previewTemplateAction(input: {
  versionId: string;
  matterId?: string | null;
  organisationId?: string | null;
  personId?: string | null;
  recipientPartyId?: string | null;
  promptedValues?: Record<string, unknown>;
  outputFormat?: DocumentOutputFormat;
}) {
  return guardedAction('previewTemplateAction', async (actor) => {
    const res = await previewTemplateService(
      input,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function generateDocumentAction(input: {
  templateId: string;
  sourceEntityType: 'matter' | 'client';
  matterId?: string | null;
  organisationId?: string | null;
  personId?: string | null;
  recipientPartyId?: string | null;
  recipientPartyEntityType?: 'organisation' | 'person' | null;
  promptedValues?: Record<string, unknown>;
  outputFormat?: DocumentOutputFormat;
}) {
  return guardedAction('generateDocumentAction', async (actor) => {
    const res = await generateDocumentService(
      input,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function downloadGeneratedDocumentAction(documentId: string) {
  return guardedAction('downloadGeneratedDocumentAction', (actor) =>
    downloadGeneratedDocumentService(documentId, actor.personId, actor.session),
  );
}

export async function deleteGeneratedDocumentAction(documentId: string) {
  return guardedAction('deleteGeneratedDocumentAction', async (actor) => {
    const res = await deleteGeneratedDocumentService(
      documentId,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

export async function getTemplateUsageReportAction(
  filter: TemplateUsageReportFilter = {},
) {
  return guardedAction('getTemplateUsageReportAction', (actor) =>
    getTemplateUsageReportService(filter, actor.personId, actor.session),
  );
}

export async function updateDocumentGenerationConfigAction(patch: Partial<DocumentGenerationConfig>) {
  return guardedAction('updateDocumentGenerationConfigAction', async (actor) => {
    const res = await updateDocumentGenerationConfigService(
      patch,
      actor.personId,
      actor.session,
    );
    revalidateAll();
    return res;
  });
}

// ============================================================================
// Key Dates & Limitation Server Actions (§1–§9)
// ============================================================================

export async function previewLimitationCalculationAction(input: {
  ruleSetId: string;
  ruleId: string;
  triggerValues: Record<string, string>;
  standstillPeriods?: StandstillPeriod[];
  calendarCodeOverride?: string;
}) {
  return guardedAction('previewLimitationCalculationAction', ({ personId: byId }) =>
    previewLimitationCalculationRecord(input, byId),
  );
}

export async function createOrProposeKeyDateAction(input: {
  matterId?: string;
  enquiryId?: string;
  keyDateTypeId: string;
  title?: string;
  dueDate: string;
  dueTime?: string;
  isCritical?: boolean;
  source?: 'manual' | 'calculated';
  teamId?: string;
  responsiblePersonIds?: string[];
  calculation?: KeyDateCalculation;
  notes?: string;
  sourceDocumentId?: string;
  intent?: 'provisional' | 'propose';
}) {
  return guardedAction('createOrProposeKeyDateAction', async ({ personId: byId }) => {
    const res = await createOrProposeKeyDateRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function proposeProvisionalKeyDateAction(keyDateId: string) {
  return guardedAction('proposeProvisionalKeyDateAction', async ({ personId: byId }) => {
    const res = await proposeProvisionalKeyDateRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function verifyProposedKeyDateAction(keyDateId: string) {
  return guardedAction('verifyProposedKeyDateAction', async ({ personId: byId }) => {
    const res = await verifyProposedKeyDateRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function rejectProposedKeyDateAction(
  keyDateId: string,
  reason: string,
) {
  return guardedAction('rejectProposedKeyDateAction', async ({ personId: byId }) => {
    const res = await rejectProposedKeyDateRecord(keyDateId, reason, byId);
    revalidateAll();
    return res;
  });
}

export async function supersedeConfirmedKeyDateAction(
  keyDateId: string,
  updates: {
    title?: string;
    dueDate: string;
    dueTime?: string;
    isCritical?: boolean;
    teamId?: string;
    responsiblePersonIds?: string[];
    calculation?: KeyDateCalculation;
    notes?: string;
    intent?: 'provisional' | 'propose';
  },
  reason: string,
) {
  return guardedAction('supersedeConfirmedKeyDateAction', async ({ personId: byId }) => {
    const res = await supersedeConfirmedKeyDateRecord(
      keyDateId,
      updates,
      reason,
      byId,
    );
    revalidateAll();
    return res;
  });
}

export async function resolveKeyDateOutcomeAction(
  keyDateId: string,
  input: {
    kind: 'met' | 'missed' | 'waived';
    note?: string;
    evidenceDocumentId?: string;
  },
) {
  return guardedAction('resolveKeyDateOutcomeAction', async ({ personId: byId }) => {
    const res = await resolveKeyDateOutcomeRecord(keyDateId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function reassignKeyDateTeamAction(
  keyDateId: string,
  input: {
    teamId: string;
    responsiblePersonIds?: string[];
    reason?: string;
  },
) {
  return guardedAction('reassignKeyDateTeamAction', async ({ personId: byId }) => {
    const res = await reassignKeyDateTeamRecord(keyDateId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function recordKeyDateNotApplicableAction(input: {
  matterId: string;
  keyDateTypeId: string;
  reason: string;
}) {
  return guardedAction('recordKeyDateNotApplicableAction', ({ personId: byId }) => {
    const res = recordKeyDateNotApplicableRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function acknowledgeKeyDateReminderAction(keyDateId: string) {
  return guardedAction('acknowledgeKeyDateReminderAction', ({ personId: byId }) => {
    const res = acknowledgeKeyDateReminderRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function runKeyDateReminderSchedulerAction() {
  return guardedAction('runKeyDateReminderSchedulerAction', (actor) => {
    const tenantCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(actor.session),
    );
    const res = runKeyDateReminderSchedulerRecord({
      tenantCtx,
      session: actor.session,
      byId: actor.personId,
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function queryKeyDatesTeamDiaryAction(
  query: TeamDiaryQuery,
  todayIso?: string,
) {
  return guardedAction('queryKeyDatesTeamDiaryAction', ({ personId: byId }) =>
    queryKeyDatesTeamDiaryRecord(query, byId, todayIso),
  );
}

export async function getKeyDateExceptionsReportAction(
  filter: { teamIds?: string[]; kinds?: KeyDateExceptionKind[] } = {},
  todayIso?: string,
) {
  return guardedAction('getKeyDateExceptionsReportAction', ({ personId: byId }) =>
    getKeyDateExceptionsReportRecord(filter, byId, todayIso),
  );
}

export async function exportKeyDateExceptionsReportAction(
  filter: {
    teamIds?: string[];
    kinds?: KeyDateExceptionKind[];
    format?: 'csv' | 'json';
  } = {},
  todayIso?: string,
) {
  return guardedAction('exportKeyDateExceptionsReportAction', ({ personId: byId }) => {
    const res = exportKeyDateExceptionsReportRecord(filter, byId, todayIso);
    revalidateAll();
    return res;
  });
}

export async function saveKeyDatesConfigAction(
  newConfig: KeyDatesConfig,
  reason: string,
) {
  return guardedAction('saveKeyDatesConfigAction', (actor) => {
    const res = saveKeyDatesConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}





