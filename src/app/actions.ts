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
  getCurrentUserId,
  linkPmsRecord,
  logEmployeeRestrictedAccess,
  logEnquiryContactRecord,
  logQuoteFollowUpRecord,
  markAllNotificationsRead,
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
  switchViewingRole,
  takeTaskRecord,
  unlinkPmsRecord,
  updateChoiceValue,
  updateEmployeeRolesAndSupports,
  updateEmployeeRoleSetting,
  updateWorkTypeProfiles,
  USER_COOKIE,
} from '@/server/services';

function revalidateAll() {
  revalidatePath('/', 'layout');
}

export async function switchUserAction(userId: string) {
  const jar = await cookies();
  jar.set(USER_COOKIE, userId, { path: '/', maxAge: 60 * 60 * 24 * 365 });
  revalidateAll();
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
  const byId = await getCurrentUserId();
  const res = savePersonRecord(payload, { ...opts, byId });
  revalidateAll();
  return res;
}

export async function logEmployeeRestrictedAccessAction(
  personId: string,
  section: 'payroll' | 'sensitive',
  fieldDetail?: string,
) {
  const byId = await getCurrentUserId();
  const res = logEmployeeRestrictedAccess(personId, section, byId, fieldDetail);
  revalidateAll();
  return res;
}

export async function reassignLeaverOwnedRecordsAction(
  fromLeaverId: string,
  toEmployeeId: string,
) {
  const byId = await getCurrentUserId();
  const res = reassignLeaverOwnedRecords(fromLeaverId, toEmployeeId, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = saveOrganisationRecord(payload, { ...opts, byId });
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = saveMatterRecord(payload, { ...opts, byId });
  revalidateAll();
  return res;
}

export async function updateMatterConflictRecordAction(
  matterId: string,
  record: ConflictCheckRecord,
) {
  const byId = await getCurrentUserId();
  const res = updateMatterConflictRecord(matterId, record, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const link = createOrUpdateLink(input, byId);
  revalidateAll();
  return link;
}

export async function deleteLinkAction(linkId: string) {
  const byId = await getCurrentUserId();
  deleteLink(linkId, byId);
  revalidateAll();
}

export async function addNoteAction(recordType: RecordType | 'matter', recordId: string, text: string) {
  const byId = await getCurrentUserId();
  const note = addNoteToRecord(recordType, recordId, text, byId);
  revalidateAll();
  return note;
}

export async function dismissDuplicateAction(recordType: RecordType, recordId: string, otherId: string | null) {
  const byId = await getCurrentUserId();
  dismissDuplicateMatch(recordType, recordId, otherId, byId);
  revalidateAll();
}

export async function mergeRecordsAction(recordType: RecordType, survivorId: string, mergedId: string) {
  const byId = await getCurrentUserId();
  const hist = executeMerge(recordType, survivorId, mergedId, byId);
  revalidateAll();
  return hist;
}

export async function addChoiceValueAction(input: {
  listKey: string;
  label: string;
  description?: string;
  guidance?: string;
  parentId?: string | null;
  meta?: Record<string, string>;
}) {
  const byId = await getCurrentUserId();
  const val = addChoiceValue(input, byId);
  revalidateAll();
  return val;
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
  const byId = await getCurrentUserId();
  const res = updateChoiceValue(id, patch, byId);
  revalidateAll();
  return res;
}

export async function reorderChoiceValueAction(id: string, direction: -1 | 1) {
  const byId = await getCurrentUserId();
  reorderChoiceValue(id, direction, byId);
  revalidateAll();
}

export async function createMatterStageGroupAction(input: {
  label: string;
  description?: string;
  mode: 'from_default' | 'scratch';
  selectedDefaultStageIds?: string[];
}) {
  const byId = await getCurrentUserId();
  const res = createMatterStageGroup(input, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const def = saveCustomFieldDefinition(input, byId);
  revalidateAll();
  return def;
}

export async function reorderCustomFieldAction(id: string, direction: -1 | 1) {
  const byId = await getCurrentUserId();
  reorderCustomField(id, direction, byId);
  revalidateAll();
}

export async function resetDemoDataAction() {
  const byId = await getCurrentUserId();
  resetAllDemoData(byId);
  revalidateAll();
}

export async function clearAllDataAction() {
  const byId = await getCurrentUserId();
  clearAllDataToCleanDeployment(byId);
  revalidateAll();
}

export async function markNotificationReadAction(id: string) {
  const userId = await getCurrentUserId();
  markNotificationRead(id, userId);
  revalidateAll();
}

export async function markAllNotificationsReadAction() {
  const userId = await getCurrentUserId();
  markAllNotificationsRead(userId);
  revalidateAll();
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
  const byId = await getCurrentUserId();
  const res = saveTeamRecord(input, byId);
  revalidateAll();
  return res;
}

export async function updateEmployeeRoleAction(personId: string, appRole: AppRole | null) {
  const byId = await getCurrentUserId();
  updateEmployeeRoleSetting(personId, appRole, byId);
  revalidateAll();
}

export async function saveEnquirySettingsAction(patch: Partial<EnquirySettings>) {
  const byId = await getCurrentUserId();
  const res = saveEnquirySettingsRecord(patch, byId);
  revalidateAll();
  return res;
}

export async function saveTaskSettingsAction(settings: TaskSettings) {
  const byId = await getCurrentUserId();
  const res = saveTaskSettingsRecord(settings, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = saveTaskRecord(input, byId);
  revalidateAll();
  return res;
}

export async function takeTaskAction(taskId: string) {
  const byId = await getCurrentUserId();
  const res = takeTaskRecord(taskId, byId);
  revalidateAll();
  return res;
}

export async function addTaskCommentAction(taskId: string, text: string) {
  const byId = await getCurrentUserId();
  const res = addTaskCommentRecord(taskId, text, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = saveEnquiryRecord(payload, { ...opts, byId });
  revalidateAll();
  return res;
}

export async function assignEnquiryAction(
  enquiryId: string,
  assignedToId: string | null,
  assignedTeamId?: string | null,
) {
  const byId = await getCurrentUserId();
  const res = assignEnquiryRecord(enquiryId, assignedToId, assignedTeamId, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = logEnquiryContactRecord(enquiryId, input, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = sendEnquiryEmailRecord(enquiryId, input, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = closeEnquiryRecord(enquiryId, input, byId);
  revalidateAll();
  return res;
}

export async function reopenEnquiryAction(enquiryId: string) {
  const byId = await getCurrentUserId();
  const res = reopenEnquiryRecord(enquiryId, byId);
  revalidateAll();
  return res;
}

export async function prepareEnquiryConversionAction(
  enquiryId: string,
  opts: {
    usePersonId?: string | null;
    useOrganisationId?: string | null;
    createForBusiness?: boolean;
  } = {},
) {
  const byId = await getCurrentUserId();
  const res = prepareEnquiryConversion(enquiryId, opts, byId);
  revalidateAll();
  return res;
}

export async function anonymiseExpiredEnquiriesAction(specificEnquiryId?: string) {
  const byId = await getCurrentUserId();
  const count = anonymiseExpiredEnquiries(byId, specificEnquiryId);
  revalidateAll();
  return { count };
}

export async function linkPmsRecordAction(
  entityType: PmsEntityType,
  onesquaredId: string,
  pmsCode: string,
) {
  const byId = await getCurrentUserId();
  const res = linkPmsRecord(entityType, onesquaredId, pmsCode, byId);
  revalidateAll();
  return res;
}

export async function unlinkPmsRecordAction(linkId: string) {
  const byId = await getCurrentUserId();
  unlinkPmsRecord(linkId, byId);
  revalidateAll();
}

export async function rerunAutomaticPmsMatchingAction() {
  const byId = await getCurrentUserId();
  const res = rerunAutomaticPmsMatching(byId);
  revalidateAll();
  return res;
}

export async function createRecordFromPmsAction(entityType: PmsEntityType, pmsCode: string) {
  const byId = await getCurrentUserId();
  const res = createRecordFromPms(entityType, pmsCode, byId);
  revalidateAll();
  return res;
}

export async function switchViewingRoleAction(roleKey: string) {
  const userId = await getCurrentUserId();
  let res = switchViewingRole(userId, roleKey);
  if (!res.ok && (roleKey === 'risk_compliance' || roleKey === 'fee_earner')) {
    const { getAppSnapshot: getSnap } = await import('@/server/services');
    const snap = getSnap(userId);
    const nextRoles = Array.from(new Set([...snap.currentUserRoles, roleKey]));
    updateEmployeeRolesAndSupports(userId, { roles: nextRoles }, userId);
    res = switchViewingRole(userId, roleKey);
  }
  revalidateAll();
  return res;
}

export async function saveHomePagesConfigAction(input: {
  roles?: RoleHomeConfig[];
  firmSettings?: Partial<HomeFirmSettings>;
}) {
  const byId = await getCurrentUserId();
  const res = saveHomePagesConfig(input, byId);
  revalidateAll();
  return res;
}

export async function resetHomePagesConfigAction() {
  const byId = await getCurrentUserId();
  const res = resetHomePagesConfig(byId);
  revalidateAll();
  return res;
}

export async function addHomeRoleAction(input: {
  key?: string;
  label: string;
  shortLabel?: string;
  purpose: string;
  copyFromRoleKey?: string;
}) {
  const byId = await getCurrentUserId();
  const res = addHomeRole(input, byId);
  revalidateAll();
  return res;
}

export async function updateEmployeeRolesAndSupportsAction(
  personId: string,
  input: {
    roles?: string[];
    supportsIds?: string[];
  },
) {
  const byId = await getCurrentUserId();
  const res = updateEmployeeRolesAndSupports(personId, input, byId);
  revalidateAll();
  return res;
}

export async function approveSignOffAction(signOffId: string) {
  const byId = await getCurrentUserId();
  const res = approveSignOff(signOffId, byId);
  revalidateAll();
  return res;
}

export async function discussSignOffAction(signOffId: string, note: string) {
  const byId = await getCurrentUserId();
  const res = discussSignOff(signOffId, note, byId);
  revalidateAll();
  return res;
}

export async function requestMatterBillAction(matterCode: string) {
  const byId = await getCurrentUserId();
  const res = requestMatterBill(matterCode, byId);
  revalidateAll();
  return res;
}

export async function flagMatterWriteOffAction(matterCode: string, amountGbp: number) {
  const byId = await getCurrentUserId();
  const res = flagMatterWriteOff(matterCode, amountGbp, byId);
  revalidateAll();
  return res;
}

export async function remindTeamLeadOverdueComplianceAction(teamId: string) {
  const byId = await getCurrentUserId();
  const res = remindTeamLeadOverdueCompliance(teamId, byId);
  revalidateAll();
  return res;
}

export async function recordInvoiceCreditControlActionAction(input: {
  invoiceNumber: string;
  matterCode: string;
  clientCode: string;
  actionType: 'log_call' | 'send_reminder' | 'escalate';
  note?: string;
}) {
  const byId = await getCurrentUserId();
  const res = recordInvoiceCreditControlAction(input, byId);
  revalidateAll();
  return res;
}

export async function saveOrgStructureAction(nextCatalogue: OrgStructureCatalogue) {
  const byId = await getCurrentUserId();
  const res = saveOrgStructure(nextCatalogue, byId);
  revalidateAll();
  return res;
}

export async function saveMatterPartyRelationshipAction(input: {
  code: string;
  label: string;
  description?: string;
  active?: boolean;
  isNew?: boolean;
}) {
  const byId = await getCurrentUserId();
  const res = saveMatterPartyRelationship(input, byId);
  revalidateAll();
  return res;
}

export async function reorderMatterPartyRelationshipAction(code: string, direction: -1 | 1) {
  const byId = await getCurrentUserId();
  const res = reorderMatterPartyRelationship(code, direction, byId);
  revalidateAll();
  return res;
}

export async function deleteMatterPartyRelationshipAction(code: string) {
  const byId = await getCurrentUserId();
  const res = deleteMatterPartyRelationship(code, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = saveMatterPartyCapacity(input, byId);
  revalidateAll();
  return res;
}

export async function deleteMatterPartyCapacityAction(code: string) {
  const byId = await getCurrentUserId();
  const res = deleteMatterPartyCapacity(code, byId);
  revalidateAll();
  return res;
}

export async function updateWorkTypeProfilesAction(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
) {
  const byId = await getCurrentUserId();
  const res = updateWorkTypeProfiles(workTypeSubcategoryId, profiles, byId);
  revalidateAll();
  return res;
}

export async function saveQuoteAction(
  input: SaveQuoteInput,
  opts: { id?: string; markAsSent?: boolean } = {},
) {
  const byId = await getCurrentUserId();
  const res = saveQuoteRecord(input, { ...opts, byId });
  revalidateAll();
  return res;
}

export async function markQuoteSentAction(quoteId: string) {
  const byId = await getCurrentUserId();
  const res = markQuoteSentRecord(quoteId, byId);
  revalidateAll();
  return res;
}

export async function logQuoteFollowUpAction(
  quoteId: string,
  input: {
    method: ContactLogMethod;
    note: string;
    nextFollowUpDate: string | null;
  },
) {
  const byId = await getCurrentUserId();
  const res = logQuoteFollowUpRecord(quoteId, input, byId);
  revalidateAll();
  return res;
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
  const byId = await getCurrentUserId();
  const res = reviseQuoteRecord(quoteId, input, byId);
  revalidateAll();
  return res;
}

export async function recordQuoteOutcomeAction(
  quoteId: string,
  input: {
    outcome: 'Accepted' | 'Declined';
    declineReason?: QuoteDeclineReason | null;
    note?: string;
  },
) {
  const byId = await getCurrentUserId();
  const res = recordQuoteOutcomeRecord(quoteId, input, byId);
  revalidateAll();
  return res;
}

export async function prepareQuoteConversionAction(quoteId: string) {
  const byId = await getCurrentUserId();
  const res = prepareQuoteConversionRecord(quoteId, byId);
  revalidateAll();
  return res;
}

export async function saveMatterCostsConfigAction(config: MatterCostsConfig) {
  const byId = await getCurrentUserId();
  const res = saveMatterCostsConfig(config, byId);
  revalidateAll();
  return res;
}

export async function syncMatterCostsRatesFromPmsAction() {
  const byId = await getCurrentUserId();
  const res = syncMatterCostsRatesFromPms(byId);
  revalidateAll();
  return res;
}




