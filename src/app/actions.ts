'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import type {
  AppRole,
  AutoTaskTrigger,
  CapacityGroupName,
  ConflictCheckRecord,
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
  withAuthenticatedActor,
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
  KeyDateSource,
  StandstillPeriod,
  TeamDiaryQuery,
} from '@/domain/keyDates.types';
import { resolveCurrentTenantContext } from '@/platform/tenantRuntime';
import { createVerifiedSessionActorFromEntraSession } from '@/server/entraAuth';
import type { PermissionKey, RbacConfiguration } from '@/domain/rbac';

function revalidateAll() {
  try {
    revalidatePath('/', 'layout');
  } catch {
    // Ignore when called outside Next.js static generation / request context in unit tests
  }
}

function withActorId<R>(fn: (byId: string) => Promise<R> | R): Promise<R> {
  return withAuthenticatedActor((actor) => fn(actor.personId));
}

export async function switchUserAction(userId: string) {
  return withAuthenticatedActor(async () => {
    const res = await switchUserInDemoMode(userId);
    revalidateAll();
    return res;
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
  return withActorId((byId) => {
    const res = savePersonRecord(payload, { ...opts, byId });
    revalidateAll();
    return res;
  });
}

export async function logEmployeeRestrictedAccessAction(
  personId: string,
  section: 'payroll' | 'sensitive',
  fieldDetail?: string,
) {
  return withActorId((byId) => {
    const res = logEmployeeRestrictedAccess(personId, section, byId, fieldDetail);
    revalidateAll();
    return res;
  });
}

export async function revealEmployeeSensitiveRecordAction(personId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = saveOrganisationRecord(payload, { ...opts, byId });
    revalidateAll();
    return res;
  });
}

export async function saveMatterAction(
  payload: Partial<Matter> & {
    title: string;
    clientId: string;
    practiceAreaId: string;
    workTypeSubcategoryId: string;
  },
  opts: {
    id?: string;
    saveMode?: 'draft' | 'submit_cleared' | 'submit_referred';
  } = {},
) {
  return withActorId(async (byId) => {
    const res = await saveMatterRecord(payload, { ...opts, byId });
    revalidateAll();
    return res;
  });
}

export async function markEngagementLetterDraftedAction(matterId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = liftMatterRestriction(matterId, restriction, reason, byId);
    revalidateAll();
    return res;
  });
}

export async function updateMatterConflictRecordAction(
  matterId: string,
  record: ConflictCheckRecord,
) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const link = createOrUpdateLink(input, byId);
    revalidateAll();
    return link;
  });
}

export async function deleteLinkAction(linkId: string) {
  return withActorId((byId) => {
    deleteLink(linkId, byId);
    revalidateAll();
  });
}

export async function addNoteAction(recordType: RecordType | 'matter', recordId: string, text: string) {
  return withActorId((byId) => {
    const note = addNoteToRecord(recordType, recordId, text, byId);
    revalidateAll();
    return note;
  });
}

export async function dismissDuplicateAction(recordType: RecordType, recordId: string, otherId: string | null) {
  return withActorId((byId) => {
    dismissDuplicateMatch(recordType, recordId, otherId, byId);
    revalidateAll();
  });
}

export async function mergeRecordsAction(recordType: RecordType, survivorId: string, mergedId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = updateChoiceValue(id, patch, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderChoiceValueAction(id: string, direction: -1 | 1) {
  return withActorId((byId) => {
    reorderChoiceValue(id, direction, byId);
    revalidateAll();
  });
}

export async function createMatterStageGroupAction(input: {
  label: string;
  description?: string;
  mode: 'from_default' | 'scratch';
  selectedDefaultStageIds?: string[];
}) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const def = saveCustomFieldDefinition(input, byId);
    revalidateAll();
    return def;
  });
}

export async function reorderCustomFieldAction(id: string, direction: -1 | 1) {
  return withActorId((byId) => {
    reorderCustomField(id, direction, byId);
    revalidateAll();
  });
}

export async function resetDemoDataAction() {
  return withActorId((byId) => {
    resetAllDemoData(byId);
    revalidateAll();
  });
}

export async function clearAllDataAction() {
  return withActorId((byId) => {
    clearAllDataToCleanDeployment(byId);
    revalidateAll();
  });
}

export async function markNotificationReadAction(id: string) {
  return withActorId((userId) => {
    markNotificationRead(id, userId);
    revalidateAll();
  });
}

export async function markAllNotificationsReadAction() {
  return withActorId((userId) => {
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
  return withActorId((byId) => {
    const res = saveTeamRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function updateEmployeeRoleAction(personId: string, appRole: AppRole | null) {
  return withAuthenticatedActor((actor) => {
    const res = updateEmployeeRoleSetting(personId, appRole, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function saveEnquirySettingsAction(patch: Partial<EnquirySettings>) {
  return withActorId((byId) => {
    const res = saveEnquirySettingsRecord(patch, byId);
    revalidateAll();
    return res;
  });
}

export async function saveTaskSettingsAction(settings: TaskSettings) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = saveTaskRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function takeTaskAction(taskId: string) {
  return withActorId((byId) => {
    const res = takeTaskRecord(taskId, byId);
    revalidateAll();
    return res;
  });
}

export async function addTaskCommentAction(taskId: string, text: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = saveEnquiryRecord(payload, { ...opts, byId });
    revalidateAll();
    return res;
  });
}

export async function assignEnquiryAction(
  enquiryId: string,
  assignedToId: string | null,
  assignedTeamId?: string | null,
) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = closeEnquiryRecord(enquiryId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function reopenEnquiryAction(enquiryId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = prepareEnquiryConversion(enquiryId, opts, byId);
    revalidateAll();
    return res;
  });
}

export async function anonymiseExpiredEnquiriesAction(specificEnquiryId?: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = linkPmsRecord(entityType, onesquaredId, pmsCode, byId);
    revalidateAll();
    return res;
  });
}

export async function unlinkPmsRecordAction(linkId: string) {
  return withActorId((byId) => {
    unlinkPmsRecord(linkId, byId);
    revalidateAll();
  });
}

export async function rerunAutomaticPmsMatchingAction() {
  return withActorId((byId) => {
    const res = rerunAutomaticPmsMatching(byId);
    revalidateAll();
    return res;
  });
}

export async function createRecordFromPmsAction(entityType: PmsEntityType, pmsCode: string) {
  return withActorId(async (byId) => {
    const res = await createRecordFromPms(entityType, pmsCode, byId);
    revalidateAll();
    return res;
  });
}

export async function switchViewingRoleAction(roleKey: string) {
  return withActorId((userId) => {
    const res = switchViewingRole(userId, roleKey);
    revalidateAll();
    return res;
  });
}

export async function saveHomePagesConfigAction(input: {
  roles?: RoleHomeConfig[];
  firmSettings?: Partial<HomeFirmSettings>;
}) {
  return withAuthenticatedActor((actor) => {
    const res = saveHomePagesConfig(input, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function resetHomePagesConfigAction() {
  return withAuthenticatedActor((actor) => {
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
  return withAuthenticatedActor((actor) => {
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
  return withAuthenticatedActor((actor) => {
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
  return withAuthenticatedActor((actor) =>
    previewRbacOverrides(personId, draftOverrides, actor.personId),
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
  return withAuthenticatedActor((actor) => {
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
  return withAuthenticatedActor((actor) => {
    const res = updateTenantRbacConfig(patch, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}

export async function approveSignOffAction(signOffId: string) {
  return withActorId((byId) => {
    const res = approveSignOff(signOffId, byId);
    revalidateAll();
    return res;
  });
}

export async function discussSignOffAction(signOffId: string, note: string) {
  return withActorId((byId) => {
    const res = discussSignOff(signOffId, note, byId);
    revalidateAll();
    return res;
  });
}

export async function requestMatterBillAction(matterCode: string) {
  return withActorId((byId) => {
    const res = requestMatterBill(matterCode, byId);
    revalidateAll();
    return res;
  });
}

export async function flagMatterWriteOffAction(matterCode: string, amountGbp: number) {
  return withActorId((byId) => {
    const res = flagMatterWriteOff(matterCode, amountGbp, byId);
    revalidateAll();
    return res;
  });
}

export async function remindTeamLeadOverdueComplianceAction(teamId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = recordInvoiceCreditControlAction(input, byId);
    revalidateAll();
    return res;
  });
}

export async function saveOrgStructureAction(nextCatalogue: OrgStructureCatalogue) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = saveMatterPartyRelationship(input, byId);
    revalidateAll();
    return res;
  });
}

export async function reorderMatterPartyRelationshipAction(code: string, direction: -1 | 1) {
  return withActorId((byId) => {
    const res = reorderMatterPartyRelationship(code, direction, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyRelationshipAction(code: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = saveMatterPartyCapacity(input, byId);
    revalidateAll();
    return res;
  });
}

export async function deleteMatterPartyCapacityAction(code: string) {
  return withActorId((byId) => {
    const res = deleteMatterPartyCapacity(code, byId);
    revalidateAll();
    return res;
  });
}

export async function updateWorkTypeProfilesAction(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
) {
  return withActorId((byId) => {
    const res = updateWorkTypeProfiles(workTypeSubcategoryId, profiles, byId);
    revalidateAll();
    return res;
  });
}

export async function saveQuoteAction(
  input: SaveQuoteInput,
  opts: { id?: string; markAsSent?: boolean } = {},
) {
  return withActorId((byId) => {
    const res = saveQuoteRecord(input, { ...opts, byId });
    revalidateAll();
    return res;
  });
}

export async function markQuoteSentAction(quoteId: string) {
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
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
  return withActorId((byId) => {
    const res = recordQuoteOutcomeRecord(quoteId, input, byId);
    revalidateAll();
    return res;
  });
}

export async function prepareQuoteConversionAction(quoteId: string) {
  return withActorId((byId) => {
    const res = prepareQuoteConversionRecord(quoteId, byId);
    revalidateAll();
    return res;
  });
}

export async function saveMatterCostsConfigAction(config: MatterCostsConfig) {
  return withActorId((byId) => {
    const res = saveMatterCostsConfig(config, byId);
    revalidateAll();
    return res;
  });
}

export async function syncMatterCostsRatesFromPmsAction() {
  return withActorId((byId) => {
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
  return withAuthenticatedActor((actor) =>
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor((actor) =>
    exportTemplatePackageService(
      templateId,
      versionId,
      actor.personId,
      actor.session,
    ),
  );
}

export async function importTemplatePackageAction(pkg: TemplatePackageManifest) {
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor((actor) =>
    downloadGeneratedDocumentService(documentId, actor.personId, actor.session),
  );
}

export async function deleteGeneratedDocumentAction(documentId: string) {
  return withAuthenticatedActor(async (actor) => {
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
  return withAuthenticatedActor((actor) =>
    getTemplateUsageReportService(filter, actor.personId, actor.session),
  );
}

export async function updateDocumentGenerationConfigAction(patch: Partial<DocumentGenerationConfig>) {
  return withAuthenticatedActor(async (actor) => {
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
  return withActorId((byId) =>
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
  source?: KeyDateSource;
  teamId?: string;
  responsiblePersonIds?: string[];
  calculation?: KeyDateCalculation;
  notes?: string;
  sourceDocumentId?: string;
  intent?: 'provisional' | 'propose';
}) {
  return withActorId(async (byId) => {
    const res = await createOrProposeKeyDateRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function proposeProvisionalKeyDateAction(keyDateId: string) {
  return withActorId(async (byId) => {
    const res = await proposeProvisionalKeyDateRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function verifyProposedKeyDateAction(keyDateId: string) {
  return withActorId(async (byId) => {
    const res = await verifyProposedKeyDateRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function rejectProposedKeyDateAction(
  keyDateId: string,
  reason: string,
) {
  return withActorId(async (byId) => {
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
  return withActorId(async (byId) => {
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
  return withActorId(async (byId) => {
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
  return withActorId(async (byId) => {
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
  return withActorId((byId) => {
    const res = recordKeyDateNotApplicableRecord(input, byId);
    revalidateAll();
    return res;
  });
}

export async function acknowledgeKeyDateReminderAction(keyDateId: string) {
  return withActorId((byId) => {
    const res = acknowledgeKeyDateReminderRecord(keyDateId, byId);
    revalidateAll();
    return res;
  });
}

export async function runKeyDateReminderSchedulerAction() {
  return withAuthenticatedActor((actor) => {
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
  return withActorId((byId) =>
    queryKeyDatesTeamDiaryRecord(query, byId, todayIso),
  );
}

export async function getKeyDateExceptionsReportAction(
  filter: { teamIds?: string[]; kinds?: KeyDateExceptionKind[] } = {},
  todayIso?: string,
) {
  return withActorId((byId) =>
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
  return withActorId((byId) => {
    const res = exportKeyDateExceptionsReportRecord(filter, byId, todayIso);
    revalidateAll();
    return res;
  });
}

export async function saveKeyDatesConfigAction(
  newConfig: KeyDatesConfig,
  reason: string,
) {
  return withAuthenticatedActor((actor) => {
    const res = saveKeyDatesConfigRecord(newConfig, reason, actor.personId, {
      mfaVerified: actor.mfaVerified,
    });
    revalidateAll();
    return res;
  });
}





