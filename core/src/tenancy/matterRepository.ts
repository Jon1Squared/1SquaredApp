/**
 * Tenant-Scoped Matter & Matter Party Repository (`core/src/tenancy/matterRepository.ts`).
 *
 * Implements ADR 0028 §§2–6 & `S0-16` (`B6`, `B12`, `R408`, `R409`, `R417`, `R448`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes inside an
 *    explicit PostgreSQL transaction whose first statement is `SET LOCAL ROLE <role_tenant_slug_env>`.
 * 2. Every SQL statement scopes by `tenant_id = $1` and every returned row is verified via `assertRowTenant`.
 * 3. Optimistic concurrency (`row_version`, `R409`, `R448`): `updateMatter` requires a positive integer
 *    `expectedRowVersion`, executes `UPDATE public.matters SET row_version = row_version + 1, ... WHERE tenant_id = $1 AND id = $2 AND row_version = $3`,
 *    and throws `MATTER_CONCURRENCY_CONFLICT` when 0 rows match an existing matter.
 * 4. Monotonic per-tenant matter numbering (`B6`): `allocateNextMatterNumber` commits autonomously on
 *    `public.matter_number_sequences` (and `public.tenant_matter_number_seq`) and `clearTenantData`
 *    preserves `matter_number_sequences` across deletions and demo resets so matter numbers are never reissued.
 * 5. Staff matters & ethical walls (`B12`): viewer-scoped queries filter out restricted matters (`is_staff_matter`
 *    or `has_ethical_wall`) at the SQL layer unless `viewerId` is present in `restricted_access_user_ids_json`
 *    (failing closed when `restricted_access_user_ids_json` is empty).
 */

import type { TenantContext } from '../api/index';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const MATTER_CONCURRENCY_CONFLICT_CODE = 'MATTER_CONCURRENCY_CONFLICT';
export const MATTER_CONCURRENCY_CONFLICT_MESSAGE =
  'MATTER_CONCURRENCY_CONFLICT: This matter was changed by someone else while you were saving. Please reload and try again.';

export function createMatterConcurrencyConflictError(): Error & {
  code: typeof MATTER_CONCURRENCY_CONFLICT_CODE;
} {
  const err = new Error(MATTER_CONCURRENCY_CONFLICT_MESSAGE) as Error & {
    code: typeof MATTER_CONCURRENCY_CONFLICT_CODE;
  };
  err.code = MATTER_CONCURRENCY_CONFLICT_CODE;
  return err;
}

export interface TenantMatterPartyRecord {
  id: string;
  name: string;
  role: string;
  linkedRecordId: string | null;
  notes?: string;
  entityType?: 'person' | 'organisation';
  relationshipCode?: string;
  capacityCodes?: string[];
  connectedToPartyId?: string | null;
  identifiers?: unknown;
  needsCapacityPrompt?: boolean;
  alignment?: 'aligned' | 'adverse' | 'third_party' | 'neutral';
}

export interface TenantMatterRecord {
  id: string;
  rowVersion?: number;
  recordType: 'matter';
  recordOwnerId: string | null;
  recordStatusId: string;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
  sourceId: string | null;
  lastVerifiedAt: string | null;
  tags: string[];
  duplicateStatusId: string;
  notDuplicateOf: string[];
  possibleMatchIds: string[];
  mergedIntoId: string | null;
  lastInteractionAt: string | null;
  customFields: Record<string, unknown>;
  matterNumber: string;
  title: string;
  shortDescription: string;
  clientId: string;
  additionalClientIds: string[];
  parentMatterId: string | null;
  relatedMatterIds: string[];
  matterStatusId: string;
  sourceEnquiryId?: string | null;
  sourceQuoteId?: string | null;
  practiceAreaId: string;
  workTypeSubcategoryId: string;
  typeBadge: string;
  matterTypeId: string;
  clientTierId: string | null;
  clientSectorId: string | null;
  billingBasisId: string;
  riskRatingId: string;
  matterSizeId: string | null;
  jurisdictionGroupId: string;
  jurisdictionIds: string[];
  governingLawId: string | null;
  forumCourt: string;
  responsiblePartnerId: string | null;
  supervisingPartnerId: string | null;
  leadFeeEarnerId: string | null;
  teamMemberIds: string[];
  relationshipPartnerId: string | null;
  instructingContactId: string | null;
  billingContactId: string | null;
  referrerTypeId: string | null;
  referrerContactId: string | null;
  parties: TenantMatterPartyRecord[];
  conflictCheckStatus: string;
  conflictCheckDate: string | null;
  conflictClearedById: string | null;
  conflictNotes: string;
  amlStatus: string;
  amlCompletedAt: string | null;
  sourceOfFundsVerified: string;
  sourceOfWealthVerified: string;
  engagementLetterStatus: string;
  engagementLetterSentAt: string | null;
  engagementLetterSignedAt: string | null;
  feeEstimateGbp: number | null;
  agreedFeeCapGbp: number | null;
  retainerMoniesOnAccountGbp: number | null;
  stageId: string;
  milestoneId: string | null;
  enquiryReceivedAt: string | null;
  openedAt: string | null;
  targetCompletionAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  retentionPeriod: string;
  destructionDueAt: string | null;
  fieldValues: Record<string, unknown>;
  conflictCheckRecord?: unknown;
  conflictDecision?: unknown;
  isStaffMatter?: boolean;
  hasEthicalWall?: boolean;
  restrictedAccessUserIds?: string[];
  restrictionLift?: unknown;
  owningDepartmentId?: string | null;
  owningTeamId?: string | null;
}

interface DbMatterRow {
  tenant_id: string;
  id: string;
  row_version: number | string;
  matter_number: string;
  title: string;
  client_type: string;
  client_id: string;
  instructing_contact_id: string | null;
  billing_contact_id: string | null;
  referrer_person_id: string | null;
  referrer_organisation_id: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  team_id: string | null;
  office_id: string | null;
  practice_area_id: string;
  work_type_subcategory_id: string;
  status_id: string;
  stage_group_id: string | null;
  current_stage_id: string;
  responsible_partner_id: string | null;
  responsible_fee_earner_id: string | null;
  supervisor_id: string | null;
  risk_rating_id: string;
  conflict_check_status: string;
  conflict_cleared_by_id: string | null;
  is_staff_matter: boolean;
  has_ethical_wall: boolean;
  source_enquiry_id: string | null;
  source_quote_id: string | null;
  opened_on: string | null;
  closed_on: string | null;
  destruction_date: string | null;
  engagement_letter_status: string;
  created_at: Date | string;
  updated_at: Date | string;
  additional_client_ids_json: string[];
  restricted_access_user_ids_json: string[];
  fields_json: Record<string, unknown>;
  custom_fields_json: Record<string, unknown>;
  conflict_check_record_json: Record<string, unknown> | null;
  risk_assessment_json: Record<string, unknown> | null;
  costs_json: Record<string, unknown> | null;
  opening_record_json: Record<string, unknown> | null;
  milestones_json: Record<string, unknown> | null;
}

interface DbMatterPartyRow {
  tenant_id: string;
  id: string;
  matter_id: string;
  entity_type: string | null;
  entity_id: string | null;
  relationship_id: string | null;
  capacity_id: string | null;
  reference: string | null;
  acting_solicitor_organisation_id: string | null;
  acting_solicitor_person_id: string | null;
  notes: string | null;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  metadata_json: Record<string, unknown>;
}

function safePgTimestampIso(iso: string | undefined | null): string {
  if (!iso || typeof iso !== 'string') {
    return new Date().toISOString();
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? new Date().toISOString()
    : new Date(parsed).toISOString();
}

function mapPartyRow(row: DbMatterPartyRow): TenantMatterPartyRecord {
  const meta = (row.metadata_json ?? {}) as Record<string, unknown>;
  const rawPartyId =
    typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : row.id;
  const out: TenantMatterPartyRecord = {
    id: rawPartyId,
    name: (meta.name as string) ?? '',
    role: (meta.role as string) ?? row.relationship_id ?? '',
    linkedRecordId: row.entity_id ?? ((meta.linkedRecordId as string | null) ?? null),
  };
  if (row.notes !== null && row.notes !== undefined) {
    out.notes = row.notes;
  } else if (typeof meta.notes === 'string') {
    out.notes = meta.notes;
  }
  if (row.entity_type === 'person' || row.entity_type === 'organisation') {
    out.entityType = row.entity_type;
  } else if (meta.entityType === 'person' || meta.entityType === 'organisation') {
    out.entityType = meta.entityType;
  }
  if (row.relationship_id) {
    out.relationshipCode = row.relationship_id;
  } else if (typeof meta.relationshipCode === 'string') {
    out.relationshipCode = meta.relationshipCode;
  }
  if (Array.isArray(meta.capacityCodes)) {
    out.capacityCodes = [...(meta.capacityCodes as string[])];
  } else if (row.capacity_id) {
    out.capacityCodes = [row.capacity_id];
  }
  if (meta.connectedToPartyId !== undefined) {
    out.connectedToPartyId = (meta.connectedToPartyId as string | null) ?? null;
  }
  if (meta.identifiers && typeof meta.identifiers === 'object') {
    out.identifiers = structuredClone(meta.identifiers as Record<string, unknown>);
  }
  if (typeof meta.needsCapacityPrompt === 'boolean') {
    out.needsCapacityPrompt = meta.needsCapacityPrompt;
  }
  if (
    meta.alignment === 'aligned' ||
    meta.alignment === 'adverse' ||
    meta.alignment === 'third_party' ||
    meta.alignment === 'neutral'
  ) {
    out.alignment = meta.alignment;
  }
  return out;
}

function mapMatterRow<TMatter extends TenantMatterRecord = TenantMatterRecord>(
  row: DbMatterRow,
  partyRows: readonly DbMatterPartyRow[],
): TMatter {
  const opening = (row.opening_record_json ?? {}) as Record<string, unknown>;
  const costs = (row.costs_json ?? {}) as Record<string, unknown>;
  const milestones = (row.milestones_json ?? {}) as Record<string, unknown>;

  const parties: TenantMatterPartyRecord[] =
    partyRows.length > 0
      ? partyRows.map(mapPartyRow)
      : Array.isArray(opening.partiesFallback)
        ? structuredClone(opening.partiesFallback as TenantMatterPartyRecord[])
        : [];

  const out: TenantMatterRecord = {
    id: row.id,
    rowVersion: Math.max(1, Number(row.row_version ?? 1)),
    recordType: 'matter',
    recordOwnerId: (opening.recordOwnerId as string | null) ?? null,
    recordStatusId: (opening.recordStatusId as string) ?? 'record_status.active',
    createdById: (opening.createdById as string) ?? 'system',
    createdAt: (opening.createdAt as string) ?? toIsoString(row.created_at),
    updatedById: (opening.updatedById as string) ?? 'system',
    updatedAt: (opening.updatedAt as string) ?? toIsoString(row.updated_at),
    sourceId: (opening.sourceId as string | null) ?? null,
    lastVerifiedAt: (opening.lastVerifiedAt as string | null) ?? null,
    tags: Array.isArray(opening.tags) ? [...(opening.tags as string[])] : [],
    duplicateStatusId:
      (opening.duplicateStatusId as string) ?? 'duplicate_status.unique',
    notDuplicateOf: Array.isArray(opening.notDuplicateOf)
      ? [...(opening.notDuplicateOf as string[])]
      : [],
    possibleMatchIds: Array.isArray(opening.possibleMatchIds)
      ? [...(opening.possibleMatchIds as string[])]
      : [],
    mergedIntoId: (opening.mergedIntoId as string | null) ?? null,
    lastInteractionAt: (opening.lastInteractionAt as string | null) ?? null,
    customFields:
      row.custom_fields_json && typeof row.custom_fields_json === 'object'
        ? structuredClone(row.custom_fields_json)
        : {},
    matterNumber: row.matter_number ?? 'DRAFT',
    title: row.title ?? '',
    shortDescription: (opening.shortDescription as string) ?? '',
    clientId: row.client_id ?? '',
    additionalClientIds: Array.isArray(row.additional_client_ids_json)
      ? [...row.additional_client_ids_json]
      : [],
    parentMatterId: (opening.parentMatterId as string | null) ?? null,
    relatedMatterIds: Array.isArray(opening.relatedMatterIds)
      ? [...(opening.relatedMatterIds as string[])]
      : [],
    matterStatusId: row.status_id ?? '',
    practiceAreaId: row.practice_area_id ?? '',
    workTypeSubcategoryId: row.work_type_subcategory_id ?? '',
    typeBadge: (opening.typeBadge as string) ?? '',
    matterTypeId: (opening.matterTypeId as string) ?? '',
    clientTierId: (opening.clientTierId as string | null) ?? null,
    clientSectorId: (opening.clientSectorId as string | null) ?? null,
    billingBasisId:
      (costs.billingBasisId as string) ??
      ((opening.billingBasisId as string) ?? ''),
    riskRatingId: row.risk_rating_id ?? '',
    matterSizeId: (opening.matterSizeId as string | null) ?? null,
    jurisdictionGroupId: (opening.jurisdictionGroupId as string) ?? '',
    jurisdictionIds: Array.isArray(opening.jurisdictionIds)
      ? [...(opening.jurisdictionIds as string[])]
      : [],
    governingLawId: (opening.governingLawId as string | null) ?? null,
    forumCourt: (opening.forumCourt as string) ?? '',
    responsiblePartnerId: row.responsible_partner_id ?? null,
    supervisingPartnerId: row.supervisor_id ?? null,
    leadFeeEarnerId: row.responsible_fee_earner_id ?? null,
    teamMemberIds: Array.isArray(opening.teamMemberIds)
      ? [...(opening.teamMemberIds as string[])]
      : [],
    relationshipPartnerId: (opening.relationshipPartnerId as string | null) ?? null,
    instructingContactId: row.instructing_contact_id ?? null,
    billingContactId: row.billing_contact_id ?? null,
    referrerTypeId: (opening.referrerTypeId as string | null) ?? null,
    referrerContactId:
      row.referrer_person_id ??
      row.referrer_organisation_id ??
      ((opening.referrerContactId as string | null) ?? null),
    parties,
    conflictCheckStatus: row.conflict_check_status ?? '',
    conflictCheckDate: (opening.conflictCheckDate as string | null) ?? null,
    conflictClearedById: row.conflict_cleared_by_id ?? null,
    conflictNotes: (opening.conflictNotes as string) ?? '',
    amlStatus: (opening.amlStatus as string) ?? '',
    amlCompletedAt: (opening.amlCompletedAt as string | null) ?? null,
    sourceOfFundsVerified: (opening.sourceOfFundsVerified as string) ?? '',
    sourceOfWealthVerified: (opening.sourceOfWealthVerified as string) ?? '',
    engagementLetterStatus: row.engagement_letter_status ?? '',
    engagementLetterSentAt:
      (opening.engagementLetterSentAt as string | null) ?? null,
    engagementLetterSignedAt:
      (opening.engagementLetterSignedAt as string | null) ?? null,
    feeEstimateGbp:
      costs.feeEstimateGbp !== undefined
        ? (costs.feeEstimateGbp as number | null)
        : ((opening.feeEstimateGbp as number | null) ?? null),
    agreedFeeCapGbp:
      costs.agreedFeeCapGbp !== undefined
        ? (costs.agreedFeeCapGbp as number | null)
        : ((opening.agreedFeeCapGbp as number | null) ?? null),
    retainerMoniesOnAccountGbp:
      costs.retainerMoniesOnAccountGbp !== undefined
        ? (costs.retainerMoniesOnAccountGbp as number | null)
        : ((opening.retainerMoniesOnAccountGbp as number | null) ?? null),
    stageId: row.current_stage_id ?? ((milestones.stageId as string) ?? ''),
    milestoneId: (milestones.milestoneId as string | null) ?? null,
    enquiryReceivedAt: (milestones.enquiryReceivedAt as string | null) ?? null,
    openedAt: row.opened_on ?? ((milestones.openedAt as string | null) ?? null),
    targetCompletionAt:
      (milestones.targetCompletionAt as string | null) ?? null,
    completedAt: (milestones.completedAt as string | null) ?? null,
    closedAt: row.closed_on ?? ((milestones.closedAt as string | null) ?? null),
    retentionPeriod: (milestones.retentionPeriod as string) ?? '',
    destructionDueAt:
      row.destruction_date ??
      ((milestones.destructionDueAt as string | null) ?? null),
    fieldValues:
      row.fields_json && typeof row.fields_json === 'object'
        ? structuredClone(row.fields_json)
        : {},
  };

  if (row.source_enquiry_id !== null || opening.hasSourceEnquiryId === true) {
    out.sourceEnquiryId = row.source_enquiry_id;
  }
  if (row.source_quote_id !== null || opening.hasSourceQuoteId === true) {
    out.sourceQuoteId = row.source_quote_id;
  }
  if (row.conflict_check_record_json !== null) {
    out.conflictCheckRecord = structuredClone(row.conflict_check_record_json);
  }
  if (opening.conflictDecision !== undefined) {
    out.conflictDecision =
      opening.conflictDecision !== null
        ? structuredClone(opening.conflictDecision as Record<string, unknown>)
        : null;
  }
  if (row.is_staff_matter || opening.hasIsStaffMatter === true) {
    out.isStaffMatter = Boolean(row.is_staff_matter);
  }
  if (row.has_ethical_wall || opening.hasEthicalWallFlag === true) {
    out.hasEthicalWall = Boolean(row.has_ethical_wall);
  }
  if (
    Array.isArray(opening.restrictedAccessUserIdsFallback) &&
    opening.hasRestrictedAccessUserIds === true
  ) {
    out.restrictedAccessUserIds = [
      ...(opening.restrictedAccessUserIdsFallback as string[]),
    ];
  } else if (
    (Array.isArray(row.restricted_access_user_ids_json) &&
      row.restricted_access_user_ids_json.length > 0) ||
    opening.hasRestrictedAccessUserIds === true ||
    row.is_staff_matter ||
    row.has_ethical_wall
  ) {
    out.restrictedAccessUserIds = Array.isArray(
      row.restricted_access_user_ids_json,
    )
      ? [...row.restricted_access_user_ids_json]
      : [];
  }
  if (opening.restrictionLift && typeof opening.restrictionLift === 'object') {
    out.restrictionLift = structuredClone(
      opening.restrictionLift as Record<string, unknown>,
    );
  }
  if (row.department_id !== null || opening.hasOwningDepartmentId === true) {
    out.owningDepartmentId = row.department_id;
  }
  if (row.team_id !== null || opening.hasOwningTeamId === true) {
    out.owningTeamId = row.team_id;
  }

  return out as TMatter;
}

function buildMatterDbParameters(
  ctx: TenantContext,
  matter: TenantMatterRecord,
  sqlRestrictedAccessUserIds?: readonly string[],
) {
  const clientType = matter.clientId?.startsWith('P-')
    ? 'person'
    : 'organisation';
  const referrerPersonId = matter.referrerContactId?.startsWith('P-')
    ? matter.referrerContactId
    : null;
  const referrerOrganisationId = matter.referrerContactId?.startsWith('O-')
    ? matter.referrerContactId
    : null;
  const legalEntityId =
    typeof matter.fieldValues?.['CORE-068'] === 'string'
      ? (matter.fieldValues['CORE-068'] as string)
      : null;
  const officeId =
    typeof matter.fieldValues?.['CORE-070'] === 'string'
      ? (matter.fieldValues['CORE-070'] as string)
      : null;

  const costsJson: Record<string, unknown> = {
    billingBasisId: matter.billingBasisId ?? '',
    feeEstimateGbp: matter.feeEstimateGbp ?? null,
    agreedFeeCapGbp: matter.agreedFeeCapGbp ?? null,
    retainerMoniesOnAccountGbp: matter.retainerMoniesOnAccountGbp ?? null,
  };

  const milestonesJson: Record<string, unknown> = {
    stageId: matter.stageId ?? '',
    milestoneId: matter.milestoneId ?? null,
    enquiryReceivedAt: matter.enquiryReceivedAt ?? null,
    openedAt: matter.openedAt ?? null,
    targetCompletionAt: matter.targetCompletionAt ?? null,
    completedAt: matter.completedAt ?? null,
    closedAt: matter.closedAt ?? null,
    retentionPeriod: matter.retentionPeriod ?? '',
    destructionDueAt: matter.destructionDueAt ?? null,
  };

  const openingRecordJson: Record<string, unknown> = {
    recordOwnerId: matter.recordOwnerId ?? null,
    recordStatusId: matter.recordStatusId ?? 'record_status.active',
    createdById: matter.createdById ?? 'system',
    createdAt: matter.createdAt,
    updatedById: matter.updatedById ?? 'system',
    updatedAt: matter.updatedAt,
    sourceId: matter.sourceId ?? null,
    lastVerifiedAt: matter.lastVerifiedAt ?? null,
    tags: matter.tags ?? [],
    duplicateStatusId: matter.duplicateStatusId ?? 'duplicate_status.unique',
    notDuplicateOf: matter.notDuplicateOf ?? [],
    possibleMatchIds: matter.possibleMatchIds ?? [],
    mergedIntoId: matter.mergedIntoId ?? null,
    lastInteractionAt: matter.lastInteractionAt ?? null,
    shortDescription: matter.shortDescription ?? '',
    parentMatterId: matter.parentMatterId ?? null,
    relatedMatterIds: matter.relatedMatterIds ?? [],
    typeBadge: matter.typeBadge ?? '',
    matterTypeId: matter.matterTypeId ?? '',
    clientTierId: matter.clientTierId ?? null,
    clientSectorId: matter.clientSectorId ?? null,
    billingBasisId: matter.billingBasisId ?? '',
    matterSizeId: matter.matterSizeId ?? null,
    jurisdictionGroupId: matter.jurisdictionGroupId ?? '',
    jurisdictionIds: matter.jurisdictionIds ?? [],
    governingLawId: matter.governingLawId ?? null,
    forumCourt: matter.forumCourt ?? '',
    teamMemberIds: matter.teamMemberIds ?? [],
    relationshipPartnerId: matter.relationshipPartnerId ?? null,
    referrerTypeId: matter.referrerTypeId ?? null,
    referrerContactId: matter.referrerContactId ?? null,
    conflictCheckDate: matter.conflictCheckDate ?? null,
    conflictNotes: matter.conflictNotes ?? '',
    amlStatus: matter.amlStatus ?? '',
    amlCompletedAt: matter.amlCompletedAt ?? null,
    sourceOfFundsVerified: matter.sourceOfFundsVerified ?? '',
    sourceOfWealthVerified: matter.sourceOfWealthVerified ?? '',
    engagementLetterSentAt: matter.engagementLetterSentAt ?? null,
    engagementLetterSignedAt: matter.engagementLetterSignedAt ?? null,
    feeEstimateGbp: matter.feeEstimateGbp ?? null,
    agreedFeeCapGbp: matter.agreedFeeCapGbp ?? null,
    retainerMoniesOnAccountGbp: matter.retainerMoniesOnAccountGbp ?? null,
    partiesFallback: matter.parties ?? [],
    hasSourceEnquiryId: matter.sourceEnquiryId !== undefined,
    hasSourceQuoteId: matter.sourceQuoteId !== undefined,
    hasIsStaffMatter: matter.isStaffMatter !== undefined,
    hasEthicalWallFlag: matter.hasEthicalWall !== undefined,
    hasRestrictedAccessUserIds: matter.restrictedAccessUserIds !== undefined,
    ...(matter.restrictedAccessUserIds !== undefined
      ? {
          restrictedAccessUserIdsFallback:
            matter.restrictedAccessUserIds ?? [],
        }
      : {}),
    hasOwningDepartmentId: matter.owningDepartmentId !== undefined,
    hasOwningTeamId: matter.owningTeamId !== undefined,
    ...(matter.conflictDecision !== undefined
      ? { conflictDecision: matter.conflictDecision }
      : {}),
    ...(matter.restrictionLift !== undefined
      ? { restrictionLift: matter.restrictionLift }
      : {}),
  };

  const riskAssessmentJson =
    matter.fieldValues?.__riskAssessmentSnapshot &&
    typeof matter.fieldValues.__riskAssessmentSnapshot === 'object'
      ? (matter.fieldValues.__riskAssessmentSnapshot as Record<string, unknown>)
      : null;

  return {
    tenantId: ctx.tenantId,
    id: matter.id,
    matterNumber: matter.matterNumber ?? 'DRAFT',
    title: matter.title ?? '',
    clientType,
    clientId: matter.clientId ?? '',
    instructingContactId: matter.instructingContactId ?? null,
    billingContactId: matter.billingContactId ?? null,
    referrerPersonId,
    referrerOrganisationId,
    legalEntityId,
    departmentId: matter.owningDepartmentId ?? null,
    teamId: matter.owningTeamId ?? null,
    officeId,
    practiceAreaId: matter.practiceAreaId ?? '',
    workTypeSubcategoryId: matter.workTypeSubcategoryId ?? '',
    statusId: matter.matterStatusId ?? '',
    stageGroupId: null as string | null,
    currentStageId: matter.stageId ?? '',
    responsiblePartnerId: matter.responsiblePartnerId ?? null,
    responsibleFeeEarnerId: matter.leadFeeEarnerId ?? null,
    supervisorId: matter.supervisingPartnerId ?? null,
    riskRatingId: matter.riskRatingId ?? '',
    conflictCheckStatus: matter.conflictCheckStatus ?? '',
    conflictClearedById: matter.conflictClearedById ?? null,
    isStaffMatter: Boolean(matter.isStaffMatter),
    hasEthicalWall: Boolean(matter.hasEthicalWall),
    sourceEnquiryId: matter.sourceEnquiryId ?? null,
    sourceQuoteId: matter.sourceQuoteId ?? null,
    openedOn: matter.openedAt ?? null,
    closedOn: matter.closedAt ?? null,
    destructionDate: matter.destructionDueAt ?? null,
    engagementLetterStatus: matter.engagementLetterStatus ?? '',
    createdAt: safePgTimestampIso(matter.createdAt),
    updatedAt: safePgTimestampIso(matter.updatedAt),
    additionalClientIdsJson: JSON.stringify(matter.additionalClientIds ?? []),
    restrictedAccessUserIdsJson: JSON.stringify(
      sqlRestrictedAccessUserIds ?? matter.restrictedAccessUserIds ?? [],
    ),
    fieldsJson: JSON.stringify(matter.fieldValues ?? {}),
    customFieldsJson: JSON.stringify(matter.customFields ?? {}),
    conflictCheckRecordJson: matter.conflictCheckRecord
      ? JSON.stringify(matter.conflictCheckRecord)
      : null,
    riskAssessmentJson: riskAssessmentJson
      ? JSON.stringify(riskAssessmentJson)
      : null,
    costsJson: JSON.stringify(costsJson),
    openingRecordJson: JSON.stringify(openingRecordJson),
    milestonesJson: JSON.stringify(milestonesJson),
  };
}

export class TenantMatterRepository extends TenantScopedRepository {
  // ============================================================================
  // Per-Tenant Matter ID (`M-`) & Monotonic Matter Number (`B6`) Allocation
  // ============================================================================

  public async allocateNextMatterId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextMatterIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextMatterIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const maxRes = await tx.query<{ max_num: string | number }>(
        `SELECT GREATEST(
           COALESCE(
             (SELECT MAX(CASE WHEN id ~ '^M-[0-9]+$' THEN SUBSTRING(id FROM 3)::bigint ELSE 0 END)
              FROM public.matters
              WHERE tenant_id = $1),
             0
           ),
           COALESCE(
             (SELECT last_value FROM public.tenant_record_sequences WHERE tenant_id = $1 AND counter_key = 'M'),
             0
           )
         ) AS max_num`,
        [ctx.tenantId],
      );
      let currentHigh = Number(maxRes.rows[0]?.max_num ?? 0);

      const allocated: string[] = [];
      for (let i = 0; i < n; i++) {
        let seqVal = 0;
        do {
          const nextRes = await tx.query<{ val: string | number }>(
            "SELECT nextval('public.tenant_matter_id_seq')::bigint AS val",
          );
          seqVal = Number(nextRes.rows[0]?.val ?? 1);
        } while (seqVal <= currentHigh);
        currentHigh = seqVal;
        allocated.push(`M-${String(seqVal).padStart(6, '0')}`);
      }

      await tx.query(
        `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
         VALUES ($1, 'M', $2::bigint)
         ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
           last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
        [ctx.tenantId, currentHigh],
      );

      return allocated;
    });
  }

  /**
   * Allocates the next monotonic matter number (`<PREFIX>-NNNN`) for `prefix` (`B6`).
   * Commits autonomously on `public.matter_number_sequences` (and advances `public.tenant_matter_number_seq`)
   * so numbers are never reissued even when an opening is vetoed, a transaction rolls back, a matter is
   * deleted, or `resetAllDemoData` runs.
   */
  public async allocateNextMatterNumber(
    ctx: TenantContext,
    prefix = 'MAT001',
  ): Promise<string> {
    const cleanPrefix =
      prefix
        ?.trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '') || 'MAT001';

    return this.withAutonomousTenantTransaction(ctx, async (tx) => {
      await tx.query(
        "SELECT nextval('public.tenant_matter_number_seq')::bigint",
      );

      const maxExistingRes = await tx.query<{ max_suffix: string | number }>(
        `SELECT COALESCE(
           MAX(
             CASE
               WHEN matter_number ~ ('^' || $2 || '-[0-9]+$')
               THEN SUBSTRING(matter_number FROM (char_length($2) + 2))::bigint
               ELSE 0
             END
           ),
           0
         ) AS max_suffix
         FROM public.matters
         WHERE tenant_id = $1`,
        [ctx.tenantId, cleanPrefix],
      );
      const maxExisting = Number(maxExistingRes.rows[0]?.max_suffix ?? 0);

      const seqRes = await tx.query<{
        tenant_id: string;
        last_number: string | number;
      }>(
        `INSERT INTO public.matter_number_sequences (tenant_id, prefix, last_number, updated_at)
         VALUES ($1, $2, $3::bigint + 1, NOW())
         ON CONFLICT (tenant_id, prefix) DO UPDATE SET
           last_number = GREATEST(public.matter_number_sequences.last_number + 1, $3::bigint + 1),
           updated_at = NOW()
         RETURNING tenant_id, last_number`,
        [ctx.tenantId, cleanPrefix, maxExisting],
      );
      const row = seqRes.rows[0];
      if (!row) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Could not allocate matter number from matter_number_sequences.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'MatterNumberSequence');
      const nextNum = Number(row.last_number);
      return `${cleanPrefix}-${String(nextNum).padStart(4, '0')}`;
    });
  }

  // ============================================================================
  // Matter Parties Sync
  // ============================================================================

  private async syncMatterPartiesInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matter: TenantMatterRecord,
  ): Promise<DbMatterPartyRow[]> {
    await tx.query(
      'DELETE FROM public.matter_parties WHERE tenant_id = $1 AND matter_id = $2',
      [ctx.tenantId, matter.id],
    );

    const parties = matter.parties ?? [];
    if (parties.length === 0) {
      return [];
    }

    const inserted: DbMatterPartyRow[] = [];
    const safeAt = safePgTimestampIso(matter.updatedAt || matter.createdAt);
    for (let idx = 0; idx < parties.length; idx++) {
      const party = parties[idx]!;
      const rawId = party.id?.trim() || `pt-${idx + 1}`;
      const rowId = rawId.startsWith(`${matter.id}:`)
        ? rawId
        : `${matter.id}:${rawId}`;
      const entityType =
        party.entityType ??
        (party.linkedRecordId?.startsWith('P-')
          ? 'person'
          : party.linkedRecordId?.startsWith('O-')
            ? 'organisation'
            : null);
      const relationshipId = party.relationshipCode ?? party.role ?? null;
      const capacityId = party.capacityCodes?.[0] ?? null;

      const res = await tx.query<DbMatterPartyRow>(
        `INSERT INTO public.matter_parties (
           tenant_id, id, matter_id, entity_type, entity_id,
           relationship_id, capacity_id, reference,
           acting_solicitor_organisation_id, acting_solicitor_person_id,
           notes, sort_order, created_at, updated_at, metadata_json
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, NULL,
           NULL, NULL,
           $8, $9, $10::timestamptz, $10::timestamptz, $11::jsonb
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           matter_id = EXCLUDED.matter_id,
           entity_type = EXCLUDED.entity_type,
           entity_id = EXCLUDED.entity_id,
           relationship_id = EXCLUDED.relationship_id,
           capacity_id = EXCLUDED.capacity_id,
           notes = EXCLUDED.notes,
           sort_order = EXCLUDED.sort_order,
           updated_at = EXCLUDED.updated_at,
           metadata_json = EXCLUDED.metadata_json
         RETURNING *`,
        [
          ctx.tenantId,
          rowId,
          matter.id,
          entityType,
          party.linkedRecordId ?? null,
          relationshipId,
          capacityId,
          party.notes ?? null,
          idx,
          safeAt,
          JSON.stringify(party),
        ],
      );
      const row = res.rows[0];
      if (row) {
        this.assertRowTenant(ctx, row.tenant_id, 'MatterParty');
        inserted.push(row);
      }
    }
    return inserted;
  }

  private async loadPartiesByMatterIdsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterIds: readonly string[],
  ): Promise<Map<string, DbMatterPartyRow[]>> {
    const map = new Map<string, DbMatterPartyRow[]>();
    if (matterIds.length === 0) return map;
    const res = await tx.query<DbMatterPartyRow>(
      `SELECT *
       FROM public.matter_parties
       WHERE tenant_id = $1
         AND matter_id = ANY($2::text[])
       ORDER BY matter_id ASC, sort_order ASC, id ASC`,
      [ctx.tenantId, [...matterIds]],
    );
    for (const row of res.rows) {
      this.assertRowTenant(ctx, row.tenant_id, 'MatterParty');
      const list = map.get(row.matter_id) ?? [];
      list.push(row);
      map.set(row.matter_id, list);
    }
    return map;
  }

  private async advanceMatterNumberHighWaterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterNumber: string,
  ): Promise<void> {
    if (!matterNumber || matterNumber === 'DRAFT') return;
    const match = /^([A-Z0-9_-]+)-(\d+)$/i.exec(matterNumber.trim());
    if (!match?.[1] || !match?.[2]) return;
    const prefix = match[1].toUpperCase();
    const num = Number.parseInt(match[2], 10);
    if (!Number.isFinite(num) || num <= 0) return;
    await tx.query(
      `INSERT INTO public.matter_number_sequences (tenant_id, prefix, last_number, updated_at)
       VALUES ($1, $2, $3::bigint, NOW())
       ON CONFLICT (tenant_id, prefix) DO UPDATE SET
         last_number = GREATEST(public.matter_number_sequences.last_number, EXCLUDED.last_number),
         updated_at = NOW()`,
      [ctx.tenantId, prefix, num],
    );
  }

  // ============================================================================
  // Create, Update (`row_version` R409 / R448), & Import
  // ============================================================================

  public async createMatter<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    matter: TMatter,
    options?: { sqlRestrictedAccessUserIds?: readonly string[] },
  ): Promise<TMatter> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const p = buildMatterDbParameters(
        ctx,
        matter,
        options?.sqlRestrictedAccessUserIds,
      );
      const res = await tx.query<DbMatterRow>(
        `INSERT INTO public.matters (
           tenant_id, id, row_version, matter_number, title, client_type,
           client_id, instructing_contact_id, billing_contact_id,
           referrer_person_id, referrer_organisation_id, legal_entity_id,
           department_id, team_id, office_id, practice_area_id,
           work_type_subcategory_id, status_id, stage_group_id, current_stage_id,
           responsible_partner_id, responsible_fee_earner_id, supervisor_id,
           risk_rating_id, conflict_check_status, conflict_cleared_by_id,
           is_staff_matter, has_ethical_wall, source_enquiry_id, source_quote_id,
           opened_on, closed_on, destruction_date, engagement_letter_status,
           created_at, updated_at, additional_client_ids_json,
           restricted_access_user_ids_json, fields_json, custom_fields_json,
           conflict_check_record_json, risk_assessment_json, costs_json,
           opening_record_json, milestones_json
         ) VALUES (
           $1, $2, 1, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11,
           $12, $13, $14, $15,
           $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24, $25,
           $26, $27, $28, $29,
           $30, $31, $32, $33,
           $34::timestamptz, $35::timestamptz, $36::jsonb,
           $37::jsonb, $38::jsonb, $39::jsonb,
           $40::jsonb, $41::jsonb, $42::jsonb,
           $43::jsonb, $44::jsonb
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           row_version = 1,
           matter_number = EXCLUDED.matter_number,
           title = EXCLUDED.title,
           client_type = EXCLUDED.client_type,
           client_id = EXCLUDED.client_id,
           instructing_contact_id = EXCLUDED.instructing_contact_id,
           billing_contact_id = EXCLUDED.billing_contact_id,
           referrer_person_id = EXCLUDED.referrer_person_id,
           referrer_organisation_id = EXCLUDED.referrer_organisation_id,
           legal_entity_id = EXCLUDED.legal_entity_id,
           department_id = EXCLUDED.department_id,
           team_id = EXCLUDED.team_id,
           office_id = EXCLUDED.office_id,
           practice_area_id = EXCLUDED.practice_area_id,
           work_type_subcategory_id = EXCLUDED.work_type_subcategory_id,
           status_id = EXCLUDED.status_id,
           stage_group_id = EXCLUDED.stage_group_id,
           current_stage_id = EXCLUDED.current_stage_id,
           responsible_partner_id = EXCLUDED.responsible_partner_id,
           responsible_fee_earner_id = EXCLUDED.responsible_fee_earner_id,
           supervisor_id = EXCLUDED.supervisor_id,
           risk_rating_id = EXCLUDED.risk_rating_id,
           conflict_check_status = EXCLUDED.conflict_check_status,
           conflict_cleared_by_id = EXCLUDED.conflict_cleared_by_id,
           is_staff_matter = EXCLUDED.is_staff_matter,
           has_ethical_wall = EXCLUDED.has_ethical_wall,
           source_enquiry_id = EXCLUDED.source_enquiry_id,
           source_quote_id = EXCLUDED.source_quote_id,
           opened_on = EXCLUDED.opened_on,
           closed_on = EXCLUDED.closed_on,
           destruction_date = EXCLUDED.destruction_date,
           engagement_letter_status = EXCLUDED.engagement_letter_status,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           additional_client_ids_json = EXCLUDED.additional_client_ids_json,
           restricted_access_user_ids_json = EXCLUDED.restricted_access_user_ids_json,
           fields_json = EXCLUDED.fields_json,
           custom_fields_json = EXCLUDED.custom_fields_json,
           conflict_check_record_json = EXCLUDED.conflict_check_record_json,
           risk_assessment_json = EXCLUDED.risk_assessment_json,
           costs_json = EXCLUDED.costs_json,
           opening_record_json = EXCLUDED.opening_record_json,
           milestones_json = EXCLUDED.milestones_json
         WHERE public.matters.client_id = 'O-KEYDATE-STUB'
         RETURNING *`,
        [
          p.tenantId,
          p.id,
          p.matterNumber,
          p.title,
          p.clientType,
          p.clientId,
          p.instructingContactId,
          p.billingContactId,
          p.referrerPersonId,
          p.referrerOrganisationId,
          p.legalEntityId,
          p.departmentId,
          p.teamId,
          p.officeId,
          p.practiceAreaId,
          p.workTypeSubcategoryId,
          p.statusId,
          p.stageGroupId,
          p.currentStageId,
          p.responsiblePartnerId,
          p.responsibleFeeEarnerId,
          p.supervisorId,
          p.riskRatingId,
          p.conflictCheckStatus,
          p.conflictClearedById,
          p.isStaffMatter,
          p.hasEthicalWall,
          p.sourceEnquiryId,
          p.sourceQuoteId,
          p.openedOn,
          p.closedOn,
          p.destructionDate,
          p.engagementLetterStatus,
          p.createdAt,
          p.updatedAt,
          p.additionalClientIdsJson,
          p.restrictedAccessUserIdsJson,
          p.fieldsJson,
          p.customFieldsJson,
          p.conflictCheckRecordJson,
          p.riskAssessmentJson,
          p.costsJson,
          p.openingRecordJson,
          p.milestonesJson,
        ],
      );

      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Matter row could not be created.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'Matter');
      const partyRows = await this.syncMatterPartiesInTx(tx, ctx, matter);
      await this.advanceMatterNumberHighWaterInTx(tx, ctx, p.matterNumber);

      const idMatch = /^M-(\d+)$/.exec(matter.id);
      if (idMatch?.[1]) {
        const idNum = Number.parseInt(idMatch[1], 10);
        if (Number.isFinite(idNum) && idNum > 0) {
          await tx.query(
            `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
             VALUES ($1, 'M', $2::bigint)
             ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
               last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
            [ctx.tenantId, idNum],
          );
        }
      }

      return mapMatterRow<TMatter>(saved, partyRows);
    });
  }

  /**
   * Updates an existing matter using optimistic concurrency (`row_version`, `R409`, `R448`).
   * Rejects missing, non-integer, or stale `expectedRowVersion` with `MATTER_CONCURRENCY_CONFLICT`.
   */
  public async updateMatter<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    matter: TMatter,
    expectedRowVersionOrOptions?:
      | number
      | undefined
      | null
      | {
          expectedRowVersion?: number | null;
          sqlRestrictedAccessUserIds?: readonly string[];
        },
    options?: { sqlRestrictedAccessUserIds?: readonly string[] },
  ): Promise<TMatter> {
    const isOptsObj =
      typeof expectedRowVersionOrOptions === 'object' &&
      expectedRowVersionOrOptions !== null;
    const expectedRowVersion = isOptsObj
      ? expectedRowVersionOrOptions.expectedRowVersion
      : expectedRowVersionOrOptions;
    const effectiveSqlRestricted = isOptsObj
      ? expectedRowVersionOrOptions.sqlRestrictedAccessUserIds ??
        options?.sqlRestrictedAccessUserIds
      : options?.sqlRestrictedAccessUserIds;
    if (
      typeof expectedRowVersion !== 'number' ||
      !Number.isInteger(expectedRowVersion) ||
      expectedRowVersion < 1
    ) {
      throw createMatterConcurrencyConflictError();
    }

    return this.withTenantTransaction(ctx, async (tx) => {
      const p = buildMatterDbParameters(
        ctx,
        matter,
        effectiveSqlRestricted,
      );
      const res = await tx.query<DbMatterRow>(
        `UPDATE public.matters SET
           row_version = row_version + 1,
           matter_number = $4,
           title = $5,
           client_type = $6,
           client_id = $7,
           instructing_contact_id = $8,
           billing_contact_id = $9,
           referrer_person_id = $10,
           referrer_organisation_id = $11,
           legal_entity_id = $12,
           department_id = $13,
           team_id = $14,
           office_id = $15,
           practice_area_id = $16,
           work_type_subcategory_id = $17,
           status_id = $18,
           stage_group_id = $19,
           current_stage_id = $20,
           responsible_partner_id = $21,
           responsible_fee_earner_id = $22,
           supervisor_id = $23,
           risk_rating_id = $24,
           conflict_check_status = $25,
           conflict_cleared_by_id = $26,
           is_staff_matter = $27,
           has_ethical_wall = $28,
           source_enquiry_id = $29,
           source_quote_id = $30,
           opened_on = $31,
           closed_on = $32,
           destruction_date = $33,
           engagement_letter_status = $34,
           created_at = $35::timestamptz,
           updated_at = $36::timestamptz,
           additional_client_ids_json = $37::jsonb,
           restricted_access_user_ids_json = $38::jsonb,
           fields_json = $39::jsonb,
           custom_fields_json = $40::jsonb,
           conflict_check_record_json = $41::jsonb,
           risk_assessment_json = $42::jsonb,
           costs_json = $43::jsonb,
           opening_record_json = $44::jsonb,
           milestones_json = $45::jsonb
         WHERE tenant_id = $1
           AND id = $2
           AND row_version = $3
         RETURNING *`,
        [
          p.tenantId,
          p.id,
          expectedRowVersion,
          p.matterNumber,
          p.title,
          p.clientType,
          p.clientId,
          p.instructingContactId,
          p.billingContactId,
          p.referrerPersonId,
          p.referrerOrganisationId,
          p.legalEntityId,
          p.departmentId,
          p.teamId,
          p.officeId,
          p.practiceAreaId,
          p.workTypeSubcategoryId,
          p.statusId,
          p.stageGroupId,
          p.currentStageId,
          p.responsiblePartnerId,
          p.responsibleFeeEarnerId,
          p.supervisorId,
          p.riskRatingId,
          p.conflictCheckStatus,
          p.conflictClearedById,
          p.isStaffMatter,
          p.hasEthicalWall,
          p.sourceEnquiryId,
          p.sourceQuoteId,
          p.openedOn,
          p.closedOn,
          p.destructionDate,
          p.engagementLetterStatus,
          p.createdAt,
          p.updatedAt,
          p.additionalClientIdsJson,
          p.restrictedAccessUserIdsJson,
          p.fieldsJson,
          p.customFieldsJson,
          p.conflictCheckRecordJson,
          p.riskAssessmentJson,
          p.costsJson,
          p.openingRecordJson,
          p.milestonesJson,
        ],
      );

      const updated = res.rows[0];
      if (!updated) {
        const existsRes = await tx.query<{
          tenant_id: string;
          row_version: number;
        }>(
          'SELECT tenant_id, row_version FROM public.matters WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, matter.id],
        );
        const existingRow = existsRes.rows[0];
        if (existingRow) {
          this.assertRowTenant(ctx, existingRow.tenant_id, 'Matter');
          throw createMatterConcurrencyConflictError();
        }
        const notFoundErr = new Error(
          `MATTER_NOT_FOUND: Matter "${matter.id}" was not found in tenant "${ctx.tenantId}".`,
        ) as Error & { code: string };
        notFoundErr.code = 'MATTER_NOT_FOUND';
        throw notFoundErr;
      }

      this.assertRowTenant(ctx, updated.tenant_id, 'Matter');
      const partyRows = await this.syncMatterPartiesInTx(tx, ctx, matter);
      await this.advanceMatterNumberHighWaterInTx(tx, ctx, p.matterNumber);
      return mapMatterRow<TMatter>(updated, partyRows);
    });
  }

  public async putMatter<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    matter: TMatter,
    options?: {
      expectedRowVersion?: number | null;
      sqlRestrictedAccessUserIds?: readonly string[];
    },
  ): Promise<TMatter> {
    if (
      options?.expectedRowVersion !== undefined &&
      options?.expectedRowVersion !== null
    ) {
      return this.updateMatter<TMatter>(ctx, matter, options.expectedRowVersion, {
        sqlRestrictedAccessUserIds: options.sqlRestrictedAccessUserIds,
      });
    }
    if (options?.expectedRowVersion === undefined) {
      return this.createMatter<TMatter>(ctx, matter, {
        sqlRestrictedAccessUserIds: options?.sqlRestrictedAccessUserIds,
      });
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      const p = buildMatterDbParameters(
        ctx,
        matter,
        options?.sqlRestrictedAccessUserIds,
      );
      const res = await tx.query<DbMatterRow>(
        `INSERT INTO public.matters (
           tenant_id, id, row_version, matter_number, title, client_type,
           client_id, instructing_contact_id, billing_contact_id,
           referrer_person_id, referrer_organisation_id, legal_entity_id,
           department_id, team_id, office_id, practice_area_id,
           work_type_subcategory_id, status_id, stage_group_id, current_stage_id,
           responsible_partner_id, responsible_fee_earner_id, supervisor_id,
           risk_rating_id, conflict_check_status, conflict_cleared_by_id,
           is_staff_matter, has_ethical_wall, source_enquiry_id, source_quote_id,
           opened_on, closed_on, destruction_date, engagement_letter_status,
           created_at, updated_at, additional_client_ids_json,
           restricted_access_user_ids_json, fields_json, custom_fields_json,
           conflict_check_record_json, risk_assessment_json, costs_json,
           opening_record_json, milestones_json
         ) VALUES (
           $1, $2, 1, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11,
           $12, $13, $14, $15,
           $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24, $25,
           $26, $27, $28, $29,
           $30, $31, $32, $33,
           $34::timestamptz, $35::timestamptz, $36::jsonb,
           $37::jsonb, $38::jsonb, $39::jsonb,
           $40::jsonb, $41::jsonb, $42::jsonb,
           $43::jsonb, $44::jsonb
         )
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           row_version = COALESCE(public.matters.row_version, 0) + 1,
           matter_number = EXCLUDED.matter_number,
           title = EXCLUDED.title,
           client_type = EXCLUDED.client_type,
           client_id = EXCLUDED.client_id,
           instructing_contact_id = EXCLUDED.instructing_contact_id,
           billing_contact_id = EXCLUDED.billing_contact_id,
           referrer_person_id = EXCLUDED.referrer_person_id,
           referrer_organisation_id = EXCLUDED.referrer_organisation_id,
           legal_entity_id = EXCLUDED.legal_entity_id,
           department_id = EXCLUDED.department_id,
           team_id = EXCLUDED.team_id,
           office_id = EXCLUDED.office_id,
           practice_area_id = EXCLUDED.practice_area_id,
           work_type_subcategory_id = EXCLUDED.work_type_subcategory_id,
           status_id = EXCLUDED.status_id,
           stage_group_id = EXCLUDED.stage_group_id,
           current_stage_id = EXCLUDED.current_stage_id,
           responsible_partner_id = EXCLUDED.responsible_partner_id,
           responsible_fee_earner_id = EXCLUDED.responsible_fee_earner_id,
           supervisor_id = EXCLUDED.supervisor_id,
           risk_rating_id = EXCLUDED.risk_rating_id,
           conflict_check_status = EXCLUDED.conflict_check_status,
           conflict_cleared_by_id = EXCLUDED.conflict_cleared_by_id,
           is_staff_matter = EXCLUDED.is_staff_matter,
           has_ethical_wall = EXCLUDED.has_ethical_wall,
           source_enquiry_id = EXCLUDED.source_enquiry_id,
           source_quote_id = EXCLUDED.source_quote_id,
           opened_on = EXCLUDED.opened_on,
           closed_on = EXCLUDED.closed_on,
           destruction_date = EXCLUDED.destruction_date,
           engagement_letter_status = EXCLUDED.engagement_letter_status,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           additional_client_ids_json = EXCLUDED.additional_client_ids_json,
           restricted_access_user_ids_json = EXCLUDED.restricted_access_user_ids_json,
           fields_json = EXCLUDED.fields_json,
           custom_fields_json = EXCLUDED.custom_fields_json,
           conflict_check_record_json = EXCLUDED.conflict_check_record_json,
           risk_assessment_json = EXCLUDED.risk_assessment_json,
           costs_json = EXCLUDED.costs_json,
           opening_record_json = EXCLUDED.opening_record_json,
           milestones_json = EXCLUDED.milestones_json
         RETURNING *`,
        [
          p.tenantId,
          p.id,
          p.matterNumber,
          p.title,
          p.clientType,
          p.clientId,
          p.instructingContactId,
          p.billingContactId,
          p.referrerPersonId,
          p.referrerOrganisationId,
          p.legalEntityId,
          p.departmentId,
          p.teamId,
          p.officeId,
          p.practiceAreaId,
          p.workTypeSubcategoryId,
          p.statusId,
          p.stageGroupId,
          p.currentStageId,
          p.responsiblePartnerId,
          p.responsibleFeeEarnerId,
          p.supervisorId,
          p.riskRatingId,
          p.conflictCheckStatus,
          p.conflictClearedById,
          p.isStaffMatter,
          p.hasEthicalWall,
          p.sourceEnquiryId,
          p.sourceQuoteId,
          p.openedOn,
          p.closedOn,
          p.destructionDate,
          p.engagementLetterStatus,
          p.createdAt,
          p.updatedAt,
          p.additionalClientIdsJson,
          p.restrictedAccessUserIdsJson,
          p.fieldsJson,
          p.customFieldsJson,
          p.conflictCheckRecordJson,
          p.riskAssessmentJson,
          p.costsJson,
          p.openingRecordJson,
          p.milestonesJson,
        ],
      );
      const saved = res.rows[0];
      if (!saved) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Matter row could not be persisted.',
        );
      }
      this.assertRowTenant(ctx, saved.tenant_id, 'Matter');
      const partyRows = await this.syncMatterPartiesInTx(tx, ctx, matter);
      await this.advanceMatterNumberHighWaterInTx(tx, ctx, p.matterNumber);
      return mapMatterRow<TMatter>(saved, partyRows);
    });
  }

  /**
   * Idempotent seed / cut-over import path (`storePostgresImport.ts`).
   * Preserves existing `row_version` on re-import (`COALESCE(public.matters.row_version, 1)`)
   * and advances `matter_number_sequences` via `GREATEST(...)` (`B6`).
   */
  public async importMatters<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    matters: readonly TMatter[],
    options?: {
      sqlRestrictedAccessUserIdsByMatterId?: ReadonlyMap<
        string,
        readonly string[]
      >;
    },
  ): Promise<TMatter[]> {
    if (matters.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TMatter[] = [];
      let maxIdNum = 0;

      for (const matter of matters) {
        const p = buildMatterDbParameters(
          ctx,
          matter,
          options?.sqlRestrictedAccessUserIdsByMatterId?.get(matter.id),
        );
        const explicitVersion =
          typeof matter.rowVersion === 'number' &&
          Number.isInteger(matter.rowVersion) &&
          matter.rowVersion >= 1
            ? matter.rowVersion
            : 1;

        const res = await tx.query<DbMatterRow>(
          `INSERT INTO public.matters (
             tenant_id, id, row_version, matter_number, title, client_type,
             client_id, instructing_contact_id, billing_contact_id,
             referrer_person_id, referrer_organisation_id, legal_entity_id,
             department_id, team_id, office_id, practice_area_id,
             work_type_subcategory_id, status_id, stage_group_id, current_stage_id,
             responsible_partner_id, responsible_fee_earner_id, supervisor_id,
             risk_rating_id, conflict_check_status, conflict_cleared_by_id,
             is_staff_matter, has_ethical_wall, source_enquiry_id, source_quote_id,
             opened_on, closed_on, destruction_date, engagement_letter_status,
             created_at, updated_at, additional_client_ids_json,
             restricted_access_user_ids_json, fields_json, custom_fields_json,
             conflict_check_record_json, risk_assessment_json, costs_json,
             opening_record_json, milestones_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19, $20,
             $21, $22, $23,
             $24, $25, $26,
             $27, $28, $29, $30,
             $31, $32, $33, $34,
             $35::timestamptz, $36::timestamptz, $37::jsonb,
             $38::jsonb, $39::jsonb, $40::jsonb,
             $41::jsonb, $42::jsonb, $43::jsonb,
             $44::jsonb, $45::jsonb
           )
           ON CONFLICT (tenant_id, id) DO UPDATE SET
             row_version = COALESCE(public.matters.row_version, EXCLUDED.row_version, 1),
             matter_number = EXCLUDED.matter_number,
             title = EXCLUDED.title,
             client_type = EXCLUDED.client_type,
             client_id = EXCLUDED.client_id,
             instructing_contact_id = EXCLUDED.instructing_contact_id,
             billing_contact_id = EXCLUDED.billing_contact_id,
             referrer_person_id = EXCLUDED.referrer_person_id,
             referrer_organisation_id = EXCLUDED.referrer_organisation_id,
             legal_entity_id = EXCLUDED.legal_entity_id,
             department_id = EXCLUDED.department_id,
             team_id = EXCLUDED.team_id,
             office_id = EXCLUDED.office_id,
             practice_area_id = EXCLUDED.practice_area_id,
             work_type_subcategory_id = EXCLUDED.work_type_subcategory_id,
             status_id = EXCLUDED.status_id,
             stage_group_id = EXCLUDED.stage_group_id,
             current_stage_id = EXCLUDED.current_stage_id,
             responsible_partner_id = EXCLUDED.responsible_partner_id,
             responsible_fee_earner_id = EXCLUDED.responsible_fee_earner_id,
             supervisor_id = EXCLUDED.supervisor_id,
             risk_rating_id = EXCLUDED.risk_rating_id,
             conflict_check_status = EXCLUDED.conflict_check_status,
             conflict_cleared_by_id = EXCLUDED.conflict_cleared_by_id,
             is_staff_matter = EXCLUDED.is_staff_matter,
             has_ethical_wall = EXCLUDED.has_ethical_wall,
             source_enquiry_id = EXCLUDED.source_enquiry_id,
             source_quote_id = EXCLUDED.source_quote_id,
             opened_on = EXCLUDED.opened_on,
             closed_on = EXCLUDED.closed_on,
             destruction_date = EXCLUDED.destruction_date,
             engagement_letter_status = EXCLUDED.engagement_letter_status,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at,
             additional_client_ids_json = EXCLUDED.additional_client_ids_json,
             restricted_access_user_ids_json = EXCLUDED.restricted_access_user_ids_json,
             fields_json = EXCLUDED.fields_json,
             custom_fields_json = EXCLUDED.custom_fields_json,
             conflict_check_record_json = EXCLUDED.conflict_check_record_json,
             risk_assessment_json = EXCLUDED.risk_assessment_json,
             costs_json = EXCLUDED.costs_json,
             opening_record_json = EXCLUDED.opening_record_json,
             milestones_json = EXCLUDED.milestones_json
           RETURNING *`,
          [
            p.tenantId,
            p.id,
            explicitVersion,
            p.matterNumber,
            p.title,
            p.clientType,
            p.clientId,
            p.instructingContactId,
            p.billingContactId,
            p.referrerPersonId,
            p.referrerOrganisationId,
            p.legalEntityId,
            p.departmentId,
            p.teamId,
            p.officeId,
            p.practiceAreaId,
            p.workTypeSubcategoryId,
            p.statusId,
            p.stageGroupId,
            p.currentStageId,
            p.responsiblePartnerId,
            p.responsibleFeeEarnerId,
            p.supervisorId,
            p.riskRatingId,
            p.conflictCheckStatus,
            p.conflictClearedById,
            p.isStaffMatter,
            p.hasEthicalWall,
            p.sourceEnquiryId,
            p.sourceQuoteId,
            p.openedOn,
            p.closedOn,
            p.destructionDate,
            p.engagementLetterStatus,
            p.createdAt,
            p.updatedAt,
            p.additionalClientIdsJson,
            p.restrictedAccessUserIdsJson,
            p.fieldsJson,
            p.customFieldsJson,
            p.conflictCheckRecordJson,
            p.riskAssessmentJson,
            p.costsJson,
            p.openingRecordJson,
            p.milestonesJson,
          ],
        );

        const saved = res.rows[0];
        if (!saved) {
          throw new Error(
            'TENANCY_ISOLATION_ERROR: Matter row could not be imported.',
          );
        }
        this.assertRowTenant(ctx, saved.tenant_id, 'Matter');
        const partyRows = await this.syncMatterPartiesInTx(tx, ctx, matter);
        await this.advanceMatterNumberHighWaterInTx(tx, ctx, p.matterNumber);
        out.push(mapMatterRow<TMatter>(saved, partyRows));

        const idMatch = /^M-(\d+)$/.exec(matter.id);
        if (idMatch?.[1]) {
          const idNum = Number.parseInt(idMatch[1], 10);
          if (Number.isFinite(idNum) && idNum > maxIdNum) maxIdNum = idNum;
        }
      }

      if (maxIdNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'M', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxIdNum],
        );
      }

      return out;
    });
  }

  // ============================================================================
  // Staff-Matter & Ethical-Wall Restricted Queries (`B12`)
  // ============================================================================

  private canViewerAccessMatterRow(row: DbMatterRow, viewerId: string): boolean {
    if (!row.is_staff_matter && !row.has_ethical_wall) {
      return true;
    }
    if (!viewerId) {
      return false;
    }
    const allowed = Array.isArray(row.restricted_access_user_ids_json)
      ? row.restricted_access_user_ids_json
      : [];
    return allowed.includes(viewerId);
  }

  public async getMatterById<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    id: string,
    options?: {
      viewerId?: string;
      viewerUserId?: string;
      includeRestricted?: boolean;
      hasRestrictedAccessPermission?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<TMatter | null> {
    const viewerId = options?.viewerUserId ?? options?.viewerId ?? ctx.actorId;
    const includeRestricted =
      options?.hasRestrictedMatterAccess ??
      options?.hasRestrictedAccessPermission ??
      options?.includeRestricted ??
      false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterRow>(
        "SELECT * FROM public.matters WHERE tenant_id = $1 AND id = $2 AND client_id <> 'O-KEYDATE-STUB'",
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'Matter');
      if (!includeRestricted && !this.canViewerAccessMatterRow(row, viewerId)) {
        return null;
      }
      const partiesMap = await this.loadPartiesByMatterIdsInTx(tx, ctx, [
        row.id,
      ]);
      return mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []);
    });
  }

  public async listVisibleMatters<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    viewerOrOptions:
      | string
      | {
          viewerId?: string;
          viewerUserId?: string;
          includeRestricted?: boolean;
          hasRestrictedAccessPermission?: boolean;
          hasRestrictedMatterAccess?: boolean;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    const viewerId =
      typeof viewerOrOptions === 'string'
        ? viewerOrOptions
        : viewerOrOptions?.viewerUserId ??
          viewerOrOptions?.viewerId ??
          ctx.actorId;
    const includeRestricted =
      typeof viewerOrOptions === 'object' && viewerOrOptions !== null
        ? Boolean(
            viewerOrOptions.hasRestrictedMatterAccess ??
              viewerOrOptions.hasRestrictedAccessPermission ??
              viewerOrOptions.includeRestricted,
          )
        : false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = includeRestricted
        ? await tx.query<DbMatterRow>(
            `SELECT *
             FROM public.matters
             WHERE tenant_id = $1
               AND client_id <> 'O-KEYDATE-STUB'
             ORDER BY id ASC`,
            [ctx.tenantId],
          )
        : await tx.query<DbMatterRow>(
            `SELECT *
             FROM public.matters
             WHERE tenant_id = $1
               AND client_id <> 'O-KEYDATE-STUB'
               AND (
                 (is_staff_matter = FALSE AND has_ethical_wall = FALSE)
                 OR restricted_access_user_ids_json ? $2
               )
             ORDER BY id ASC`,
            [ctx.tenantId, viewerId],
          );
      const visibleRows = res.rows.filter((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Matter');
        return includeRestricted || this.canViewerAccessMatterRow(row, viewerId);
      });
      const partiesMap = await this.loadPartiesByMatterIdsInTx(
        tx,
        ctx,
        visibleRows.map((r) => r.id),
      );
      return visibleRows.map((row) =>
        mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
      );
    });
  }

  public async listAllMattersUnfiltered<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
  ): Promise<TMatter[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterRow>(
        "SELECT * FROM public.matters WHERE tenant_id = $1 AND client_id <> 'O-KEYDATE-STUB' ORDER BY id ASC",
        [ctx.tenantId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'Matter');
      }
      const partiesMap = await this.loadPartiesByMatterIdsInTx(
        tx,
        ctx,
        res.rows.map((r) => r.id),
      );
      return res.rows.map((row) =>
        mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
      );
    });
  }

  public async listAllMatters<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
  ): Promise<TMatter[]> {
    return this.listAllMattersUnfiltered<TMatter>(ctx);
  }

  public async searchVisibleMatters<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    query: string,
    viewerOrOptions:
      | string
      | {
          viewerId?: string;
          viewerUserId?: string;
          includeRestricted?: boolean;
          hasRestrictedAccessPermission?: boolean;
          hasRestrictedMatterAccess?: boolean;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    const cleanQuery = query?.trim().toLowerCase() ?? '';
    const visible = await this.listVisibleMatters<TMatter>(
      ctx,
      viewerOrOptions,
    );
    if (!cleanQuery) return visible;
    return visible.filter(
      (m) =>
        m.matterNumber.toLowerCase().includes(cleanQuery) ||
        m.title.toLowerCase().includes(cleanQuery) ||
        m.shortDescription.toLowerCase().includes(cleanQuery) ||
        m.parties.some((p) => p.name.toLowerCase().includes(cleanQuery)),
    );
  }

  public async exportVisibleMatters<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    viewerOrOptions:
      | string
      | {
          viewerId?: string;
          viewerUserId?: string;
          includeRestricted?: boolean;
          hasRestrictedAccessPermission?: boolean;
          hasRestrictedMatterAccess?: boolean;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    return this.listVisibleMatters<TMatter>(ctx, viewerOrOptions);
  }

  public async deleteMatterById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.matter_parties WHERE tenant_id = $1 AND matter_id = $2',
        [ctx.tenantId, id],
      );
      const del = await tx.query(
        'DELETE FROM public.matters WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  public async countAllTenantMatterRows(ctx: TenantContext): Promise<{
    matters: number;
    matterParties: number;
    matterNumberSequences: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        m_cnt: number;
        mp_cnt: number;
        seq_cnt: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM public.matters WHERE tenant_id = $1 AND client_id <> 'O-KEYDATE-STUB') AS m_cnt,
           (SELECT COUNT(*)::int FROM public.matter_parties WHERE tenant_id = $1) AS mp_cnt,
           (SELECT COUNT(*)::int FROM public.matter_number_sequences WHERE tenant_id = $1) AS seq_cnt`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      return {
        matters: Number(row?.m_cnt ?? 0),
        matterParties: Number(row?.mp_cnt ?? 0),
        matterNumberSequences: Number(row?.seq_cnt ?? 0),
      };
    });
  }

  /**
   * Clears `matter_parties` and `matters` for `ctx.tenantId`.
   * Preserves `matter_number_sequences` by default (`B6`) so matter numbers never go backwards
   * across matter deletions or `resetAllDemoData` demo resets.
   */
  public async clearTenantData(
    ctx: TenantContext,
    options?: { resetMatterNumberSequences?: boolean },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('DELETE FROM public.matter_parties WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM public.matters WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        "DELETE FROM public.tenant_record_sequences WHERE tenant_id = $1 AND counter_key = 'M'",
        [ctx.tenantId],
      );
      if (options?.resetMatterNumberSequences) {
        await tx.query(
          'DELETE FROM public.matter_number_sequences WHERE tenant_id = $1',
          [ctx.tenantId],
        );
      }
    });
  }
}
