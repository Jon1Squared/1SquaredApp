'use server';

import { revalidatePath } from 'next/cache';
import {
  MATTER_CONCURRENCY_CONFLICT_CODE,
  MATTER_CONCURRENCY_CONFLICT_MESSAGE,
  type CddClientCategoryKey,
  type CddConfiguration,
  type ChasingConfiguration,
  type ClientRateOverrideClientType,
  type EmailOutboxStatus,
  type EngagementConfiguration,
  type GlobalSearchEntityType,
  type GlobalSearchResponse,
  type IdentityVerificationOutcome,
  type IntakeEvidenceArtifactRef,
  type MatterNumberingConfig,
  type NotificationChannelFrequency,
  type NotificationKind,
  type RegisterChecklistItemStatus,
  type RegistersConfiguration,
  type SanctionsPepOutcome,
  type UserNotificationPreference,
  type WorkTypesConfiguration,
} from '@platform/core';
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
  getMyNotificationPreferences,
  isDataResetAllowedEnvironment,
  liftMatterRestriction,
  linkPmsRecord,
  logEmployeeRestrictedAccess,
  logEnquiryContactRecord,
  logQuoteFollowUpRecord,
  markAllNotificationsRead,
  markNotificationRead,
  markQuoteSentRecord,
  openProspectiveMatterRecord,
  overrideMatterOpeningPreconditionRecord,
  prepareEnquiryConversion,
  prepareQuoteConversionRecord,
  reassignLeaverOwnedRecords,
  recordEngagementLetterSignedRecord,
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
  revokeMatterOpeningOverrideRecord,
  runMatterConflictSearchRecord,
  saveCustomFieldDefinition,
  saveEnquiryRecord,
  saveEnquirySettingsRecord,
  saveHomePagesConfig,
  saveMatterCostsConfig,
  saveMatterNumberingConfigRecord,
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
  listRegistersWorkspaceDataRecord,
  searchGlobalRecords,
  getRegisterRecordDetailRecord,
  createRegisterRecordService,
  transitionRegisterRecordService,
  updateRegisterRecordDetailsService,
  saveRegistersConfigRecord,
  getKeyDateExceptionsReportRecord,
  exportKeyDateExceptionsReportRecord,
  saveKeyDatesConfigRecord,
  saveWorkTypesConfigRecord,
  updateMatterLifecycleStatusRecord,
  listClientRateOverridesRecord,
  saveClientRateOverrideRecord,
  deleteClientRateOverrideRecord,
  getEntityRecordForEditRecord,
  getExpiredEnquiriesCountRecord,
  getOutboxMessageForAdminRecord,
  completeClientCddRecord,
  listClientPriorMattersRecord,
  listOutboxMessagesForAdminRecord,
  loadPmsLinksAdminDataRecord,
  listMatterRateOverridesRecord,
  saveChasingConfigRecord,
  saveEngagementConfigRecord,
  saveMatterRateOverrideRecord,
  deleteMatterRateOverrideRecord,
  resolveApplicableRatesRecord,
  previewIntakeDuplicatesAndConflictsRecord,
  recordCddChecklistItemRecord,
  recordManualSanctionsPepRecord,
  retryCommunicationChaseRecord,
  saveCddConfigRecord,
  searchEntityPickerRecord,
  sendEngagementLetterRecord,
  sendNonEngagementLetterRecord,
  startOrLoadClientCddRecord,
  stopCommunicationChaseRecord,
  updateMyNotificationPreferences,
  type NotificationPreferenceUpdateEntry,
} from '@/server/services';
import type {
  EntityPickerSearchInput,
  EntityPickerSearchResult,
  IntakePreviewInput,
  IntakePreviewResult,
} from '@/domain/intakePreviewTypes';
import type { ClientCddCompactSummary } from '@/domain/cdd';
import type { OpeningGatePreconditionKey } from '@/domain/openingGate';
import type { ClientPriorMatterSummary } from '@/domain/matterOpeningRecord';
import type { PmsLinksAdminPageData, PmsLinksSubTab } from '@/domain/pms';
import type {
  KeyDateCalculation,
  KeyDateExceptionKind,
  KeyDatesConfig,
  StandstillPeriod,
  TeamDiaryQuery,
} from '@/domain/keyDates.types';
import { buildActionDenied, isActionDenied, type ActionDenied } from '@/domain/actionResult';
import { maskPayrollDetails } from '@/domain/employment';
import {
  getActiveTenantConfiguration,
  getMatterRepository,
  getPartyRepository,
  getPmsRepository,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import { guardedAction } from '@/server/authorize';
import { createVerifiedSessionActorFromEntraSession } from '@/server/entraAuth';
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
  return guardedAction('savePersonAction', async ({ personId: byId, tenantContext }) => {
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
    const res = await savePersonRecord(payload, {
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
  return guardedAction('logEmployeeRestrictedAccessAction', async ({ personId: byId }) => {
    const res = await logEmployeeRestrictedAccess(personId, section, byId, fieldDetail);
    revalidateAll();
    return res;
  });
}

export async function revealEmployeePayrollAction(
  personId: string,
  options?: { mode?: 'masked' | 'full' },
) {
  return guardedAction('revealEmployeePayrollAction', async ({ personId: byId }) => {
    const res = await getEmployeeDetailsForUser(personId, byId, { logViewPayroll: true });
    if (res.errors?.payrollPermission) {
      return {
        ...buildActionDenied('FORBIDDEN', res.errors.payrollPermission),
        payroll: null,
        errors: res.errors,
      };
    }
    const rawPayroll = res.employment?.payroll ?? null;
    const payroll =
      rawPayroll && options?.mode !== 'full'
        ? maskPayrollDetails(rawPayroll)
        : rawPayroll;
    return {
      ok: !res.errors?.notFound,
      payroll,
      errors: res.errors,
    };
  });
}

export async function revealEmployeeSensitiveRecordAction(personId: string) {
  return guardedAction('revealEmployeeSensitiveRecordAction', async ({ personId: byId }) => {
    const res = await getEmployeeDetailsForUser(personId, byId, { logViewSensitive: true });
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
  return guardedAction('reassignLeaverOwnedRecordsAction', async ({ personId: byId }) => {
    const res = await reassignLeaverOwnedRecords(fromLeaverId, toEmployeeId, byId);
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
  return guardedAction('saveOrganisationAction', async ({ personId: byId }) => {
    const res = await saveOrganisationRecord(payload, {
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
    expectedRowVersion?: number;
  } = {},
) {
  return guardedAction('saveMatterAction', async ({ personId: byId }) => {
    const expectedRowVersion =
      opts.expectedRowVersion !== undefined
        ? opts.expectedRowVersion
        : payload.rowVersion;
    if (opts.id) {
      if (
        typeof expectedRowVersion !== 'number' ||
        !Number.isInteger(expectedRowVersion) ||
        expectedRowVersion < 1
      ) {
        return {
          matter: null,
          code: MATTER_CONCURRENCY_CONFLICT_CODE,
          message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
          errors: {
            conflict: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
          },
        };
      }
    }
    const res = await saveMatterRecord(payload, {
      id: opts.id,
      saveMode: opts.saveMode,
      expectedRowVersion,
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

export async function liftMatterRestrictionAction(
  matterId: string,
  restriction: 'staff_matter' | 'ethical_wall',
  reason: string,
) {
  return guardedAction('liftMatterRestrictionAction', async ({ personId: byId }) => {
    const res = await liftMatterRestriction(matterId, restriction, reason, byId);
    revalidateAll();
    return res;
  });
}

export async function runMatterConflictSearchAction(
  input: Parameters<typeof runMatterConflictSearchRecord>[0],
) {
  return guardedAction('runMatterConflictSearchAction', async (actor) => {
    return runMatterConflictSearchRecord(input, actor.personId);
  });
}

export async function updateMatterConflictRecordAction(
  matterId: string,
  record: ConflictCheckRecordInput,
) {
  return guardedAction('updateMatterConflictRecordAction', async ({ personId: byId }) => {
    const res = await updateMatterConflictRecord(matterId, record, byId);
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
  return guardedAction('saveLinkAction', async ({ personId: byId }) => {
    const link = await createOrUpdateLink(input, byId);
    revalidateAll();
    return link;
  });
}

export async function deleteLinkAction(linkId: string) {
  return guardedAction('deleteLinkAction', async ({ personId: byId }) => {
    const res = await deleteLink(linkId, byId);
    revalidateAll();
    return res;
  });
}

export async function addNoteAction(recordType: RecordType | 'matter', recordId: string, text: string) {
  return guardedAction('addNoteAction', async ({ personId: byId }) => {
    const note = await addNoteToRecord(recordType, recordId, text, byId);
    revalidateAll();
    return note;
  });
}

export async function dismissDuplicateAction(recordType: RecordType, recordId: string, otherId: string | null) {
  return guardedAction('dismissDuplicateAction', async ({ personId: byId }) => {
    const res = await dismissDuplicateMatch(recordType, recordId, otherId, byId);
    revalidateAll();
    return res;
  });
}

export async function mergeRecordsAction(recordType: RecordType, survivorId: string, mergedId: string) {
  return guardedAction('mergeRecordsAction', async ({ personId: byId }) => {
    const hist = await executeMerge(recordType, survivorId, mergedId, byId);

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
  return guardedAction('addChoiceValueAction', async ({ personId: byId }) => {
    const val = await addChoiceValue(input, byId);
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
  return guardedAction('updateChoiceValueAction', async ({ personId: byId }) => {
    const res = await updateChoiceValue(id, patch, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderChoiceValueAction(id: string, direction: -1 | 1) {
  return guardedAction('reorderChoiceValueAction', async ({ personId: byId }) => {
    const res = await reorderChoiceValue(id, direction, byId);
    revalidateAll();
    return res;
  });
}

export async function createMatterStageGroupAction(input: {
  label: string;
  description?: string;
  mode: 'from_default' | 'scratch';
  selectedDefaultStageIds?: string[];
}) {
  return guardedAction('createMatterStageGroupAction', async ({ personId: byId }) => {
    const res = await createMatterStageGroup(input, byId);
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
  return guardedAction('saveCustomFieldAction', async ({ personId: byId }) => {
    const def = await saveCustomFieldDefinition(input, byId);
    revalidateAll();
    return def;
  });
}

export async function reorderCustomFieldAction(id: string, direction: -1 | 1) {
  return guardedAction('reorderCustomFieldAction', async ({ personId: byId }) => {
    const res = await reorderCustomField(id, direction, byId);
    revalidateAll();
    return res;
  });
}

export async function resetDemoDataAction() {
  return guardedAction('resetDemoDataAction', async ({ personId: byId, tenantContext }) => {
    if (!isDataResetAllowedEnvironment()) {
      const env = getActiveTenantConfiguration().environment;
      return buildActionDenied(
        'FORBIDDEN',
        env === 'live'
          ? 'Demo data reset is disabled in the live environment.'
          : 'Demo data reset is disabled when enableDemoMode is false.',
      );
    }
    await resetAllDemoData(byId, tenantContext);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function clearAllDataAction() {
  return guardedAction('clearAllDataAction', async ({ personId: byId, tenantContext }) => {
    if (!isDataResetAllowedEnvironment()) {
      const env = getActiveTenantConfiguration().environment;
      return buildActionDenied(
        'FORBIDDEN',
        env === 'live'
          ? 'Clearing all data is disabled in the live environment.'
          : 'Clearing all data is disabled when enableDemoMode is false.',
      );
    }
    await clearAllDataToCleanDeployment(byId, tenantContext);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function markNotificationReadAction(id: string) {
  return guardedAction('markNotificationReadAction', async ({ personId: userId }) => {
    await markNotificationRead(id, userId);
    revalidateAll();
  });
}

export async function markAllNotificationsReadAction() {
  return guardedAction('markAllNotificationsReadAction', async ({ personId: userId }) => {
    await markAllNotificationsRead(userId);
    revalidateAll();
  });
}

export async function saveTeamAction(input: {
  id?: string;
  name: string;
  description?: string;
  departmentId?: string | null;
  orgTeamId?: string | null;
  systemKey?: string | null;
  memberIds: string[];
  leadIds: string[];
  practiceAreaIds: string[];
  active?: boolean;
}) {
  return guardedAction('saveTeamAction', async ({ personId: byId }) => {
    const res = await saveTeamRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function updateEmployeeRoleAction(personId: string, appRole: AppRole | null) {
  return guardedAction('updateEmployeeRoleAction', async (actor) => {
    const res = await updateEmployeeRoleSetting(personId, appRole, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function saveEnquirySettingsAction(patch: Partial<EnquirySettings>) {
  return guardedAction('saveEnquirySettingsAction', async ({ personId: byId }) => {
    const res = await saveEnquirySettingsRecord(patch, byId);
    revalidateAll();
    return res;
  });
}

export async function saveTaskSettingsAction(settings: TaskSettings) {
  return guardedAction('saveTaskSettingsAction', async ({ personId: byId }) => {
    const res = await saveTaskSettingsRecord(settings, byId);
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
  return guardedAction('saveTaskAction', async ({ personId: byId }) => {
    const res = await saveTaskRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function takeTaskAction(taskId: string) {
  return guardedAction('takeTaskAction', async ({ personId: byId }) => {
    const res = await takeTaskRecord(taskId, byId);
    revalidateAll();
    return res;
  });
}

export async function addTaskCommentAction(taskId: string, text: string) {
  return guardedAction('addTaskCommentAction', async ({ personId: byId }) => {
    const res = await addTaskCommentRecord(taskId, text, byId);
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
  return guardedAction('saveEnquiryAction', async ({ personId: byId }) => {
    const res = await saveEnquiryRecord(payload, {
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
  return guardedAction('assignEnquiryAction', async ({ personId: byId }) => {
    const res = await assignEnquiryRecord(enquiryId, assignedToId, assignedTeamId, byId);
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
  return guardedAction('logEnquiryContactAction', async ({ personId: byId }) => {
    const res = await logEnquiryContactRecord(enquiryId, input, byId);
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
    submissionId?: string;
  },
) {
  return guardedAction('sendEnquiryEmailAction', async ({ personId: byId }) => {
    const res = await sendEnquiryEmailRecord(enquiryId, input, byId);
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
  return guardedAction('closeEnquiryAction', async ({ personId: byId }) => {
    const res = await closeEnquiryRecord(enquiryId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function reopenEnquiryAction(enquiryId: string) {
  return guardedAction('reopenEnquiryAction', async ({ personId: byId }) => {
    const res = await reopenEnquiryRecord(enquiryId, byId);
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
  return guardedAction('prepareEnquiryConversionAction', async ({ personId: byId }) => {
    const res = await prepareEnquiryConversion(
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

export async function anonymiseExpiredEnquiriesAction(
  specificEnquiryId?: string,
) {
  return guardedAction(
    'anonymiseExpiredEnquiriesAction',
    async ({ personId: byId, tenantContext }) => {
      const count = await anonymiseExpiredEnquiries(byId, specificEnquiryId, {
        tenantCtx: tenantContext,
      });
      revalidateAll();
      return { count };
    },
  );
}

export async function linkPmsRecordAction(
  entityType: PmsEntityType,
  onesquaredId: string,
  pmsCode: string,
) {
  return guardedAction('linkPmsRecordAction', async ({ personId: byId, tenantContext }) => {
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const recordExists =
      entityType === 'employee'
        ? Boolean(
            (await partyRepo.getPersonById<Person>(tenantContext, onesquaredId))
              ?.isEmployee,
          )
        : entityType === 'person'
          ? Boolean(await partyRepo.getPersonById<Person>(tenantContext, onesquaredId))
          : entityType === 'organisation'
            ? Boolean(await partyRepo.getOrganisationById(tenantContext, onesquaredId))
            : Boolean(await matterRepo.getMatterById(tenantContext, onesquaredId));
    if (!recordExists) {
      return buildActionDenied(
        'FORBIDDEN',
        `Target ${entityType} "${onesquaredId}" not found.`,
      );
    }
    const res = await linkPmsRecord(entityType, onesquaredId, pmsCode, byId);
    revalidateAll();
    return res;
  });
}

export async function unlinkPmsRecordAction(linkId: string) {
  return guardedAction('unlinkPmsRecordAction', async ({ personId: byId, tenantContext }) => {
    const existing = await getPmsRepository().getPmsLinkById(tenantContext, linkId);
    if (!existing) {
      return buildActionDenied('FORBIDDEN', `PMS link "${linkId}" not found.`);
    }
    await unlinkPmsRecord(linkId, byId);
    revalidateAll();
    return { ok: true as const };
  });
}

export async function rerunAutomaticPmsMatchingAction() {
  return guardedAction('rerunAutomaticPmsMatchingAction', async ({ personId: byId }) => {
    const res = await rerunAutomaticPmsMatching(byId);
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
  return guardedAction('switchViewingRoleAction', async ({ personId: userId }) => {
    const res = await switchViewingRole(userId, roleKey);
    revalidateAll();
    return res;
  });
}

export async function saveHomePagesConfigAction(input: {
  roles?: RoleHomeConfig[];
  firmSettings?: Partial<HomeFirmSettings>;
}) {
  return guardedAction('saveHomePagesConfigAction', async (actor) => {
    const res = await saveHomePagesConfig(input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function resetHomePagesConfigAction() {
  return guardedAction('resetHomePagesConfigAction', async (actor) => {
    const res = await resetHomePagesConfig(actor.personId, {
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
  return guardedAction('addHomeRoleAction', async (actor) => {
    const res = await addHomeRole(input, actor.personId, {
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
  return guardedAction('updateEmployeeRolesAndSupportsAction', async (actor) => {
    const res = await updateEmployeeRolesAndSupports(personId, input, actor.personId, {
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
  return guardedAction('updatePersonPermissionOverridesAction', async (actor) => {
    const res = await updatePersonPermissionOverrides(personId, input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function updateTenantRbacConfigAction(
  patch: Partial<RbacConfiguration>,
) {
  return guardedAction('updateTenantRbacConfigAction', async (actor) => {
    const res = await updateTenantRbacConfig(patch, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function approveSignOffAction(
  signOffId: string,
  expectedRowVersion?: number,
) {
  return guardedAction('approveSignOffAction', async ({ personId: byId }) => {
    const res = await approveSignOff(signOffId, byId, { expectedRowVersion });
    if (!isActionDenied(res)) {
      revalidateAll();
    }
    return res;
  });
}

export async function discussSignOffAction(
  signOffId: string,
  note: string,
  expectedRowVersion?: number,
) {
  return guardedAction('discussSignOffAction', async ({ personId: byId }) => {
    const res = await discussSignOff(signOffId, note, byId, {
      expectedRowVersion,
    });
    if (!isActionDenied(res)) {
      revalidateAll();
    }
    return res;
  });
}

export async function requestMatterBillAction(matterCode: string) {
  return guardedAction('requestMatterBillAction', async ({ personId: byId }) => {
    const res = await requestMatterBill(matterCode, byId);
    revalidateAll();
    return res;
  });
}

export async function flagMatterWriteOffAction(matterCode: string, amountGbp: number) {
  return guardedAction('flagMatterWriteOffAction', async ({ personId: byId }) => {
    const res = await flagMatterWriteOff(matterCode, amountGbp, byId);
    revalidateAll();
    return res;
  });
}

export async function remindTeamLeadOverdueComplianceAction(teamId: string) {
  return guardedAction('remindTeamLeadOverdueComplianceAction', async ({ personId: byId }) => {
    const res = await remindTeamLeadOverdueCompliance(teamId, byId);
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
  return guardedAction('recordInvoiceCreditControlActionAction', async ({ personId: byId }) => {
    const res = await recordInvoiceCreditControlAction(input, byId);
    revalidateAll();
    return res;
  });
}

export async function saveOrgStructureAction(nextCatalogue: OrgStructureCatalogue) {
  return guardedAction('saveOrgStructureAction', async ({ personId: byId }) => {
    const res = await saveOrgStructure(nextCatalogue, byId);
    if (!isActionDenied(res) && res.ok !== false) {
      revalidateAll();
    }
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
  return guardedAction('saveMatterPartyRelationshipAction', async ({ personId: byId }) => {
    const res = await saveMatterPartyRelationship(input, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderMatterPartyRelationshipAction(code: string, direction: -1 | 1) {
  return guardedAction('reorderMatterPartyRelationshipAction', async ({ personId: byId }) => {
    const res = await reorderMatterPartyRelationship(code, direction, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyRelationshipAction(code: string) {
  return guardedAction('deleteMatterPartyRelationshipAction', async ({ personId: byId }) => {
    const res = await deleteMatterPartyRelationship(code, byId);
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
  return guardedAction('saveMatterPartyCapacityAction', async ({ personId: byId }) => {
    const res = await saveMatterPartyCapacity(input, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyCapacityAction(code: string) {
  return guardedAction('deleteMatterPartyCapacityAction', async ({ personId: byId }) => {
    const res = await deleteMatterPartyCapacity(code, byId);
    revalidateAll();
    return res;
  });
}

export async function updateWorkTypeProfilesAction(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
) {
  return guardedAction('updateWorkTypeProfilesAction', async ({ personId: byId }) => {
    const res = await updateWorkTypeProfiles(workTypeSubcategoryId, profiles, byId);
    revalidateAll();
    return res;
  });
}

export async function saveQuoteAction(
  input: SaveQuoteInput,
  opts: { id?: string; markAsSent?: boolean; refreshVatRate?: boolean } = {},
) {
  return guardedAction('saveQuoteAction', async ({ personId: byId }) => {
    const res = await saveQuoteRecord(input, {
      id: opts?.id,
      markAsSent: opts?.markAsSent,
      refreshVatRate: opts?.refreshVatRate,
      byId,
    });
    revalidateAll();
    return res;
  });
}

export async function markQuoteSentAction(quoteId: string) {
  return guardedAction('markQuoteSentAction', async ({ personId: byId }) => {
    const res = await markQuoteSentRecord(quoteId, byId);
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
  return guardedAction('logQuoteFollowUpAction', async ({ personId: byId }) => {
    const res = await logQuoteFollowUpRecord(quoteId, input, byId);
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
    refreshVatRate?: boolean;
    rateGradeKey?: string;
    refreshRates?: boolean;
    feeArrangementCapCategoryKey?: string;
    feeArrangementPercent?: number | null;
    feeArrangementCapBaseKey?: string;
  },
) {
  return guardedAction('reviseQuoteAction', async ({ personId: byId }) => {
    const res = await reviseQuoteRecord(quoteId, input, byId);
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
  return guardedAction('recordQuoteOutcomeAction', async ({ personId: byId }) => {
    const res = await recordQuoteOutcomeRecord(quoteId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function prepareQuoteConversionAction(quoteId: string) {
  return guardedAction('prepareQuoteConversionAction', async ({ personId: byId }) => {
    const res = await prepareQuoteConversionRecord(quoteId, byId);
    revalidateAll();
    return res;
  });
}

export async function saveMatterCostsConfigAction(config: MatterCostsConfig) {
  return guardedAction('saveMatterCostsConfigAction', async ({ personId: byId }) => {
    const res = await saveMatterCostsConfig(config, byId);
    revalidateAll();
    return res;
  });
}

export async function syncMatterCostsRatesFromPmsAction() {
  return guardedAction('syncMatterCostsRatesFromPmsAction', async ({ personId: byId, mfaVerified }) => {
    const res = await syncMatterCostsRatesFromPms(byId, { mfaVerified });
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

export async function getDocumentGenerationSnapshotAction(input?: {
  readonly includeDocuments?: boolean;
  readonly entityScope?: {
    readonly entityType: 'matter' | 'organisation' | 'person';
    readonly entityId: string;
  };
}) {
  return guardedAction('getDocumentGenerationSnapshotAction', (actor) =>
    getDocumentGenerationSnapshotForUser(actor.personId, actor.session, input),
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
  return guardedAction('previewLimitationCalculationAction', async ({ personId: byId }) =>
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
  return guardedAction('recordKeyDateNotApplicableAction', async ({ personId: byId }) => {
    const res = await recordKeyDateNotApplicableRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function acknowledgeKeyDateReminderAction(keyDateId: string) {
  return guardedAction('acknowledgeKeyDateReminderAction', async ({ personId: byId }) => {
    const res = await acknowledgeKeyDateReminderRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function runKeyDateReminderSchedulerAction() {
  return guardedAction('runKeyDateReminderSchedulerAction', async (actor) => {
    const tenantCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(actor.session),
    );
    const res = await runKeyDateReminderSchedulerRecord({
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
) {
  return guardedAction('queryKeyDatesTeamDiaryAction', async ({ personId: byId }) =>
    queryKeyDatesTeamDiaryRecord(query, byId),
  );
}

export async function getKeyDateExceptionsReportAction(
  filter: { teamIds?: string[]; kinds?: KeyDateExceptionKind[] } = {},
) {
  return guardedAction('getKeyDateExceptionsReportAction', async ({ personId: byId }) =>
    getKeyDateExceptionsReportRecord(filter, byId),
  );
}

export async function exportKeyDateExceptionsReportAction(
  filter: {
    teamIds?: string[];
    kinds?: KeyDateExceptionKind[];
    format?: 'csv' | 'json';
  } = {},
) {
  return guardedAction('exportKeyDateExceptionsReportAction', async ({ personId: byId }) => {
    const res = await exportKeyDateExceptionsReportRecord(filter, byId);
    revalidateAll();
    return res;
  });
}

export async function saveKeyDatesConfigAction(
  newConfig: KeyDatesConfig,
  reason: string,
) {
  return guardedAction('saveKeyDatesConfigAction', async (actor) => {
    const res = await saveKeyDatesConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function saveWorkTypesConfigAction(
  newConfig: WorkTypesConfiguration,
  reason: string,
) {
  return guardedAction('saveWorkTypesConfigAction', async (actor) => {
    const res = await saveWorkTypesConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function updateMatterLifecycleStatusAction(
  matterId: string,
  action: 'close' | 'reopen',
  opts: {
    closedAt?: string | null;
    reason?: string;
    expectedRowVersion?: number | null;
  } = {},
) {
  return guardedAction('updateMatterLifecycleStatusAction', async ({ personId: byId }) => {
    const res = await updateMatterLifecycleStatusRecord(matterId, action, opts, byId);
    revalidateAll();
    return res;
  });
}

// ------------------------------------------------------------------ Negotiated Client, Group & Matter Rate Overrides (S0-28a)

export async function listClientRateOverridesAction(params: {
  clientType: ClientRateOverrideClientType;
  clientId: string;
}) {
  return guardedAction('listClientRateOverridesAction', async ({ personId: byId }) => {
    return listClientRateOverridesRecord(params, byId);
  });
}

export async function saveClientRateOverrideAction(input: {
  id?: string;
  clientType: ClientRateOverrideClientType;
  clientId: string;
  practiceAreaId?: string | null;
  gradeKey: string;
  rateGbp?: number;
  rateMinorUnits?: number;
  currency?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
}) {
  return guardedAction('saveClientRateOverrideAction', async ({ personId: byId }) => {
    const res = await saveClientRateOverrideRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteClientRateOverrideAction(id: string) {
  return guardedAction('deleteClientRateOverrideAction', async ({ personId: byId }) => {
    const res = await deleteClientRateOverrideRecord(id, byId);
    revalidateAll();
    return res;
  });
}

export async function listMatterRateOverridesAction(matterId: string) {
  return guardedAction('listMatterRateOverridesAction', async ({ personId: byId }) => {
    return listMatterRateOverridesRecord(matterId, byId);
  });
}

export async function saveMatterRateOverrideAction(input: {
  id?: string;
  matterId: string;
  gradeKey: string;
  rateGbp?: number;
  rateMinorUnits?: number;
  currency?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
}) {
  return guardedAction('saveMatterRateOverrideAction', async ({ personId: byId }) => {
    const res = await saveMatterRateOverrideRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterRateOverrideAction(id: string) {
  return guardedAction('deleteMatterRateOverrideAction', async ({ personId: byId }) => {
    const res = await deleteMatterRateOverrideRecord(id, byId);
    revalidateAll();
    return res;
  });
}

export async function resolveApplicableRatesAction(params: {
  matterId?: string | null;
  clientId?: string | null;
  clientType?: ClientRateOverrideClientType | null;
  practiceAreaId?: string | null;
  asAtDate?: string | null;
  rateCardId?: string | null;
  preferredSource?: 'auto' | 'app_table' | 'pms';
}) {
  return guardedAction('resolveApplicableRatesAction', async ({ personId: byId }) => {
    return resolveApplicableRatesRecord(params, byId);
  });
}

// ------------------------------------------------------------------ Configurable Registers Engine & Undertakings (S0-24)

export async function listRegistersWorkspaceAction(
  filter: {
    registerTypeKey?: string;
    status?: string;
    matterId?: string;
  } = {},
) {
  return guardedAction('listRegistersWorkspaceAction', async ({ personId: byId }) => {
    return listRegistersWorkspaceDataRecord(filter, byId);
  });
}

export async function getRegisterRecordDetailAction(recordId: string) {
  return guardedAction('getRegisterRecordDetailAction', async ({ personId: byId }) => {
    return getRegisterRecordDetailRecord(recordId, byId);
  });
}

export async function createRegisterRecordAction(input: {
  registerTypeKey: string;
  title: string;
  matterId?: string | null;
  enquiryId?: string | null;
  personId?: string | null;
  organisationId?: string | null;
  assignedApproverId?: string | null;
  dueAt?: string | null;
  reviewAt?: string | null;
  reminderScheduleDays?: readonly number[] | null;
  fieldValues?: Record<string, unknown>;
}) {
  return guardedAction('createRegisterRecordAction', async ({ personId: byId }) => {
    const res = await createRegisterRecordService(input, byId);
    revalidateAll();
    return res;
  });
}

export async function transitionRegisterRecordAction(input: {
  recordId: string;
  transitionKey: string;
  comment?: string | null;
  fieldUpdates?: Record<string, unknown>;
  expectedRowVersion?: number;
}) {
  return guardedAction('transitionRegisterRecordAction', async ({ personId: byId }) => {
    const res = await transitionRegisterRecordService(input, byId);
    revalidateAll();
    return res;
  });
}

export async function updateRegisterRecordAction(input: {
  recordId: string;
  expectedRowVersion?: number;
  title?: string;
  assignedApproverId?: string | null;
  dueAt?: string | null;
  reviewAt?: string | null;
  fieldValues?: Record<string, unknown>;
}) {
  return guardedAction('updateRegisterRecordAction', async ({ personId: byId }) => {
    const res = await updateRegisterRecordDetailsService(input, byId);
    revalidateAll();
    return res;
  });
}

export async function saveRegistersConfigAction(
  newConfig: RegistersConfiguration,
  reason: string,
) {
  return guardedAction('saveRegistersConfigAction', async (actor) => {
    const res = await saveRegistersConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function startOrLoadClientCddAction(input: {
  subjectType: 'person' | 'organisation';
  subjectId: string;
  createIfMissing?: boolean;
  clientCategory?: CddClientCategoryKey;
  upgradeToHighRisk?: boolean;
  reason?: string;
}) {
  return guardedAction('startOrLoadClientCddAction', async (actor) => {
    const res = await startOrLoadClientCddRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    if (input.createIfMissing || input.upgradeToHighRisk) {
      revalidateAll();
    }
    return res;
  });
}

export async function recordCddChecklistItemAction(input: {
  recordId: string;
  itemKey: string;
  status: RegisterChecklistItemStatus;
  note?: string;
  evidenceRefs?: readonly IntakeEvidenceArtifactRef[];
  expectedRowVersion?: number;
  linkManualIdentityCheck?: {
    verificationMethod: string;
    outcome: IdentityVerificationOutcome;
    referenceCode?: string;
    expiresAt?: string | null;
    notes?: string;
  };
}) {
  return guardedAction('recordCddChecklistItemAction', async (actor) => {
    const res = await recordCddChecklistItemRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function completeClientCddAction(input: {
  recordId: string;
  manualSummaryNote?: string;
  expectedRowVersion?: number;
}) {
  return guardedAction('completeClientCddAction', async (actor) => {
    const res = await completeClientCddRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function recordManualSanctionsPepAction(input: {
  subjectType: 'person' | 'organisation';
  subjectId: string;
  outcome: SanctionsPepOutcome;
  screeningScope: string;
  referenceCode?: string;
  notes?: string;
  evidenceRefs?: readonly IntakeEvidenceArtifactRef[];
}) {
  return guardedAction('recordManualSanctionsPepAction', async (actor) => {
    const res = await recordManualSanctionsPepRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function saveCddConfigAction(
  newConfig: CddConfiguration,
  reason: string,
) {
  return guardedAction('saveCddConfigAction', async (actor) => {
    const res = await saveCddConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function searchGlobalRecordsAction(input: {
  query: string;
  entityTypes?: readonly GlobalSearchEntityType[];
  limit?: number;
  offset?: number;
}): Promise<GlobalSearchResponse> {
  return guardedAction('searchGlobalRecordsAction', async (actor) =>
    searchGlobalRecords(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function previewIntakeDuplicatesAndConflictsAction(
  input: IntakePreviewInput,
): Promise<IntakePreviewResult | ActionDenied> {
  return guardedAction(
    'previewIntakeDuplicatesAndConflictsAction',
    async (actor) =>
      previewIntakeDuplicatesAndConflictsRecord(input, actor.personId, {
        tenantCtx: actor.tenantContext,
      }),
  );
}

export async function searchEntityPickerAction(
  input: EntityPickerSearchInput,
): Promise<EntityPickerSearchResult | ActionDenied> {
  return guardedAction('searchEntityPickerAction', async (actor) =>
    searchEntityPickerRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function getEntityRecordForEditAction(
  recordType: 'person' | 'organisation',
  recordId: string,
) {
  return guardedAction('getEntityRecordForEditAction', async (actor) =>
    getEntityRecordForEditRecord(recordType, recordId, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function listClientPriorMattersAction(
  clientIds: readonly string[],
): Promise<
  | {
      matters: ClientPriorMatterSummary[];
      cddSummaries?: Record<string, ClientCddCompactSummary>;
    }
  | ActionDenied
> {
  return guardedAction('listClientPriorMattersAction', async (actor) =>
    listClientPriorMattersRecord(clientIds, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function getMyNotificationPreferencesAction(
  targetPersonId?: string,
): Promise<{
  readonly preferences: readonly UserNotificationPreference[];
  readonly error?: string;
}> {
  return guardedAction(
    'getMyNotificationPreferencesAction',
    async (actor) => {
      if (targetPersonId && targetPersonId.trim() !== actor.personId) {
        return {
          ...buildActionDenied(
            'FORBIDDEN',
            'You can only view your own notification preferences.',
          ),
          preferences: [],
          error: 'You can only view your own notification preferences.',
        };
      }
      const preferences = await getMyNotificationPreferences(actor.personId, {
        actorPersonId: actor.personId,
        tenantCtx: actor.tenantContext,
      });
      return { preferences };
    },
  );
}

export async function updateMyNotificationPreferencesAction(input: {
  personId?: string;
  updates: readonly NotificationPreferenceUpdateEntry[];
  digestDayOfWeek?: number;
}): Promise<{
  readonly preferences: readonly UserNotificationPreference[];
  readonly saved?: boolean;
  readonly error?: string;
}> {
  return guardedAction(
    'updateMyNotificationPreferencesAction',
    async (actor) => {
      const requestedId = input.personId?.trim() || actor.personId;
      if (requestedId !== actor.personId) {
        return {
          ...buildActionDenied(
            'FORBIDDEN',
            'You can only modify your own notification preferences.',
          ),
          preferences: [],
          error: 'You can only modify your own notification preferences.',
        };
      }
      try {
        const preferences = await updateMyNotificationPreferences(
          {
            personId: actor.personId,
            updates: input.updates as Array<{
              readonly notificationKind: NotificationKind;
              readonly inAppEnabled?: boolean;
              readonly emailFrequency?: NotificationChannelFrequency;
              readonly teamsEnabled?: boolean;
            }>,
            digestDayOfWeek: input.digestDayOfWeek,
          },
          {
            actorPersonId: actor.personId,
            tenantCtx: actor.tenantContext,
          },
        );
        revalidateAll();
        return { preferences, saved: true };
      } catch (err) {
        return {
          preferences: [],
          error:
            err instanceof Error
              ? err.message
              : 'Unable to update notification preferences.',
        };
      }
    },
  );
}

export async function loadPmsLinksAdminDataAction(input: {
  readonly subTab?: PmsLinksSubTab;
  readonly query?: string;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<PmsLinksAdminPageData | ActionDenied> {
  return guardedAction('loadPmsLinksAdminDataAction', async (actor) =>
    loadPmsLinksAdminDataRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function getExpiredEnquiriesCountAction(
  retentionMonths: number,
): Promise<{ readonly count: number } | ActionDenied> {
  return guardedAction('getExpiredEnquiriesCountAction', async (actor) =>
    getExpiredEnquiriesCountRecord(retentionMonths, actor.personId, {
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function openProspectiveMatterAction(matterId: string) {
  return guardedAction('openProspectiveMatterAction', async (actor) => {
    const res = await openProspectiveMatterRecord(matterId, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function recordEngagementLetterSignedAction(input: {
  matterId: string;
  evidenceArtifactId: string;
  status?: 'Signed' | 'Signed & returned';
  note?: string;
}) {
  return guardedAction('recordEngagementLetterSignedAction', async (actor) => {
    const res = await recordEngagementLetterSignedRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function overrideMatterOpeningPreconditionAction(input: {
  matterId: string;
  preconditionKey: OpeningGatePreconditionKey;
  reason: string;
}) {
  return guardedAction(
    'overrideMatterOpeningPreconditionAction',
    async (actor) => {
      const res = await overrideMatterOpeningPreconditionRecord(
        input,
        actor.personId,
        { tenantCtx: actor.tenantContext },
      );
      revalidateAll();
      return res;
    },
  );
}

export async function revokeMatterOpeningOverrideAction(input: {
  matterId: string;
  overrideId: string;
  reason?: string;
}) {
  return guardedAction('revokeMatterOpeningOverrideAction', async (actor) => {
    const res = await revokeMatterOpeningOverrideRecord(
      input,
      actor.personId,
      { tenantCtx: actor.tenantContext },
    );
    revalidateAll();
    return res;
  });
}

export async function saveMatterNumberingConfigAction(
  newConfig: MatterNumberingConfig,
  reason: string,
) {
  return guardedAction('saveMatterNumberingConfigAction', async (actor) => {
    const res = await saveMatterNumberingConfigRecord(
      newConfig,
      reason,
      actor.personId,
      {
        mfaVerified: actor.mfaVerified,
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function sendEngagementLetterAction(input: {
  matterId: string;
  recipientEmail?: string;
  recipientName?: string;
  sourceDocumentId?: string | null;
  subject?: string;
  customIntroNote?: string;
  idempotencyKey?: string;
}) {
  return guardedAction('sendEngagementLetterAction', async (actor) => {
    const res = await sendEngagementLetterRecord(input, actor.personId, {
      tenantCtx: actor.tenantContext,
    });
    revalidateAll();
    return res;
  });
}

export async function stopCommunicationChaseAction(input: {
  chaseId: string;
}) {
  return guardedAction('stopCommunicationChaseAction', async (actor) => {
    const res = await stopCommunicationChaseRecord(
      { chaseId: input.chaseId },
      actor.personId,
      {
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function retryCommunicationChaseAction(input: {
  chaseId: string;
}) {
  return guardedAction('retryCommunicationChaseAction', async (actor) => {
    const res = await retryCommunicationChaseRecord(
      { chaseId: input.chaseId },
      actor.personId,
      {
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function sendNonEngagementLetterAction(input: {
  enquiryId: string;
  recipientEmail?: string;
  recipientName?: string;
  idempotencyKey?: string;
}) {
  return guardedAction('sendNonEngagementLetterAction', async (actor) => {
    const res = await sendNonEngagementLetterRecord(
      {
        enquiryId: input.enquiryId,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        idempotencyKey: input.idempotencyKey,
      },
      actor.personId,
      {
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function saveEngagementConfigAction(
  newConfig: Partial<EngagementConfiguration>,
  reason: string,
) {
  return guardedAction('saveEngagementConfigAction', async (actor) => {
    const res = await saveEngagementConfigRecord(
      newConfig,
      reason,
      actor.personId,
      {
        mfaVerified: actor.mfaVerified,
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function saveChasingConfigAction(
  newConfig: Partial<ChasingConfiguration>,
  reason: string,
) {
  return guardedAction('saveChasingConfigAction', async (actor) => {
    const res = await saveChasingConfigRecord(
      newConfig,
      reason,
      actor.personId,
      {
        mfaVerified: actor.mfaVerified,
        tenantCtx: actor.tenantContext,
      },
    );
    revalidateAll();
    return res;
  });
}

export async function listOutboxMessagesForAdminAction(
  filter: {
    status?: EmailOutboxStatus;
    limit?: number;
    offset?: number;
  } = {},
) {
  return guardedAction('listOutboxMessagesForAdminAction', async (actor) =>
    listOutboxMessagesForAdminRecord(filter, actor.personId, {
      mfaVerified: actor.mfaVerified,
      tenantCtx: actor.tenantContext,
    }),
  );
}

export async function getOutboxMessageForAdminAction(input: { outboxId: string }) {
  return guardedAction('getOutboxMessageForAdminAction', async (actor) => {
    const res = await getOutboxMessageForAdminRecord(input, actor.personId, {
      mfaVerified: actor.mfaVerified,
      tenantCtx: actor.tenantContext,
    });
    return res;
  });
}

