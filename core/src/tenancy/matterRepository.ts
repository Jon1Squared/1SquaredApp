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

import type { MatterNumberingConfig, TenantContext } from '../api/index';
import {
  DEFAULT_MATTER_NUMBERING_CONFIG,
  formatMatterNumberFromSequence,
  MATTER_NUMBERING_ERROR_CODES,
  resolveMatterNumberSequenceKey,
  validateMatterNumberingConfig,
  type MatterNumberAllocationResult,
  type MatterNumberFormatContext,
} from '../domain/matterNumbering/index';
import {
  getActiveTenantTransactionState,
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

export const MATTER_CONCURRENCY_CONFLICT_CODE = 'MATTER_CONCURRENCY_CONFLICT';
export const MATTER_CONCURRENCY_CONFLICT_MESSAGE =
  'MATTER_CONCURRENCY_CONFLICT: This matter was changed by someone else while you were saving. Please reload and try again.';

export const MATTER_NUMBER_IMMUTABLE_CODE =
  MATTER_NUMBERING_ERROR_CODES.IMMUTABLE;

export const REDACTED_MATTER_CDD_STATUS = 'Not available to you' as const;

/**
 * Redacts matter-level CDD fields (`amlStatus`, `amlCompletedAt`, and
 * `fieldValues.matterOpeningSnapshot.complianceOnboarding.amlStatus`) for viewers
 * who do not hold `cdd:view` (or are restricted by employee-client CDD rules).
 */
export function redactMatterCddFields<
  TMatter extends {
    amlStatus: string;
    amlCompletedAt: string | null;
    fieldValues?: Record<string, unknown>;
  },
>(matter: TMatter): TMatter {
  const existingSnapshot = matter.fieldValues?.['matterOpeningSnapshot'];
  const snapshotObj =
    existingSnapshot && typeof existingSnapshot === 'object'
      ? (existingSnapshot as Record<string, unknown>)
      : null;
  const complianceObj =
    snapshotObj?.complianceOnboarding &&
    typeof snapshotObj.complianceOnboarding === 'object'
      ? (snapshotObj.complianceOnboarding as Record<string, unknown>)
      : null;

  const redactedFieldValues = complianceObj
    ? {
        ...(matter.fieldValues ?? {}),
        matterOpeningSnapshot: {
          ...snapshotObj,
          complianceOnboarding: {
            ...complianceObj,
            amlStatus: REDACTED_MATTER_CDD_STATUS,
          },
        },
      }
    : matter.fieldValues;

  return {
    ...matter,
    amlStatus: REDACTED_MATTER_CDD_STATUS,
    amlCompletedAt: null,
    ...(redactedFieldValues !== undefined
      ? { fieldValues: redactedFieldValues }
      : {}),
  };
}

export type OpeningGatePreconditionKey =
  | 'conflict_cleared'
  | 'cdd_complete'
  | 'engagement_signed'
  | 'funds_on_account';

export interface MatterOpeningGateOverrideRecord {
  id: string;
  tenantId: string;
  matterId: string;
  preconditionKey: OpeningGatePreconditionKey;
  reason: string;
  overriddenByPersonId: string;
  overriddenAt: string;
  revokedByPersonId: string | null;
  revokedAt: string | null;
}

interface DbMatterOpeningGateOverrideRow {
  tenant_id: string;
  id: string;
  matter_id: string;
  precondition_key: OpeningGatePreconditionKey;
  reason: string;
  overridden_by_person_id: string;
  overridden_at: Date | string;
  revoked_by_person_id: string | null;
  revoked_at: Date | string | null;
}

function mapOpeningGateOverrideRow(
  row: DbMatterOpeningGateOverrideRow,
): MatterOpeningGateOverrideRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    matterId: row.matter_id,
    preconditionKey: row.precondition_key,
    reason: row.reason,
    overriddenByPersonId: row.overridden_by_person_id,
    overriddenAt: toIsoString(row.overridden_at),
    revokedByPersonId: row.revoked_by_person_id ?? null,
    revokedAt: row.revoked_at ? toIsoString(row.revoked_at) : null,
  };
}

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
  isPmsImport?: boolean;
  isStaffMatter?: boolean;
  hasEthicalWall?: boolean;
  restrictedAccessUserIds?: string[];
  restrictionLift?: unknown;
  owningDepartmentId?: string | null;
  owningTeamId?: string | null;
  numberSequenceKey?: string | null;
  numberSequenceValue?: number | null;
}

interface DbMatterRow {
  tenant_id: string;
  id: string;
  row_version: number | string;
  matter_number: string;
  number_sequence_key: string | null;
  number_sequence_value: string | number | null;
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
  if (opening.hasRestrictedAccessUserIds === true) {
    out.restrictedAccessUserIds = Array.isArray(
      opening.restrictedAccessUserIdsFallback,
    )
      ? [...(opening.restrictedAccessUserIdsFallback as string[])]
      : Array.isArray(row.restricted_access_user_ids_json)
        ? [...row.restricted_access_user_ids_json]
        : [];
  } else if (
    opening.hasRestrictedAccessUserIds === undefined &&
    ((Array.isArray(row.restricted_access_user_ids_json) &&
      row.restricted_access_user_ids_json.length > 0) ||
      row.is_staff_matter ||
      row.has_ethical_wall)
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
  if (opening.isPmsImport === true) {
    out.isPmsImport = true;
  }
  if (row.department_id !== null || opening.hasOwningDepartmentId === true) {
    out.owningDepartmentId = row.department_id;
  }
  if (row.team_id !== null || opening.hasOwningTeamId === true) {
    out.owningTeamId = row.team_id;
  }
  if (row.number_sequence_key !== null && row.number_sequence_key !== undefined) {
    out.numberSequenceKey = row.number_sequence_key;
  }
  if (row.number_sequence_value !== null && row.number_sequence_value !== undefined) {
    out.numberSequenceValue = Number(row.number_sequence_value);
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
    ...(matter.isPmsImport === true ? { isPmsImport: true } : {}),
  };

  const riskAssessmentJson =
    matter.fieldValues?.__riskAssessmentSnapshot &&
    typeof matter.fieldValues.__riskAssessmentSnapshot === 'object'
      ? (matter.fieldValues.__riskAssessmentSnapshot as Record<string, unknown>)
      : matter.fieldValues?.riskAssessment &&
          typeof matter.fieldValues.riskAssessment === 'object'
        ? (matter.fieldValues.riskAssessment as Record<string, unknown>)
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
      sqlRestrictedAccessUserIds ??
        ((matter.restrictedAccessUserIds?.length ?? 0) > 0
          ? Array.from(
              new Set(
                (matter.restrictedAccessUserIds ?? []).filter(
                  (id): id is string => Boolean(id),
                ),
              ),
            )
          : matter.isStaffMatter || matter.hasEthicalWall
            ? Array.from(
                new Set(
                  [
                    matter.responsiblePartnerId,
                    matter.supervisingPartnerId,
                    matter.leadFeeEarnerId,
                    ...(matter.teamMemberIds ?? []),
                  ].filter((id): id is string => Boolean(id)),
                ),
              )
            : []),
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
    numberSequenceKey: matter.numberSequenceKey ?? null,
    numberSequenceValue: matter.numberSequenceValue ?? null,
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
   * Allocates the next monotonic matter number using tenant `matterNumbering` configuration
   * (`ADR 0040`, `S1-05`) while committing autonomously on `public.matter_number_sequences`.
   */
  public async allocateNextMatterNumberWithConfig(
    ctx: TenantContext,
    config: MatterNumberingConfig = DEFAULT_MATTER_NUMBERING_CONFIG,
    formatCtx: MatterNumberFormatContext = {},
  ): Promise<MatterNumberAllocationResult> {
    const configCheck = validateMatterNumberingConfig(config);
    if (!configCheck.ok) {
      throw new Error(
        `${MATTER_NUMBERING_ERROR_CODES.VALIDATION_ERROR}: ${configCheck.error}`,
      );
    }
    const sequenceKey = resolveMatterNumberSequenceKey(config, formatCtx);
    // Validate custom pattern length before touching the monotonic sequence.
    formatMatterNumberFromSequence(config, formatCtx, 1);

    return this.withAutonomousTenantTransaction(ctx, async (tx) => {
      await tx.query(
        "SELECT nextval('public.tenant_matter_number_seq')::bigint",
      );

      const includeLegacySuffixRegex =
        config.sequenceScope === 'client_ref_prefix';
      const maxExistingRes = await tx.query<{ max_suffix: string | number }>(
        `SELECT COALESCE(
           MAX(
             CASE
               WHEN number_sequence_key = $2 AND number_sequence_value IS NOT NULL
               THEN number_sequence_value
               WHEN $3::boolean AND matter_number ~ ('^' || $2 || '-[0-9]+$')
               THEN SUBSTRING(matter_number FROM (char_length($2) + 2))::bigint
               ELSE 0
             END
           ),
           0
         ) AS max_suffix
         FROM public.matters
         WHERE tenant_id = $1`,
        [ctx.tenantId, sequenceKey, includeLegacySuffixRegex],
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
        [ctx.tenantId, sequenceKey, maxExisting],
      );
      const row = seqRes.rows[0];
      if (!row) {
        throw new Error(
          'TENANCY_ISOLATION_ERROR: Could not allocate matter number from matter_number_sequences.',
        );
      }
      this.assertRowTenant(ctx, row.tenant_id, 'MatterNumberSequence');
      const sequenceValue = Number(row.last_number);
      const matterNumber = formatMatterNumberFromSequence(
        config,
        formatCtx,
        sequenceValue,
      );
      return {
        matterNumber,
        sequenceKey,
        sequenceValue,
      };
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
    const result = await this.allocateNextMatterNumberWithConfig(
      ctx,
      DEFAULT_MATTER_NUMBERING_CONFIG,
      { clientRefPrefix: prefix },
    );
    return result.matterNumber;
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
    sequenceKey?: string | null,
    sequenceValue?: number | null,
  ): Promise<void> {
    if (
      sequenceKey &&
      typeof sequenceValue === 'number' &&
      Number.isInteger(sequenceValue) &&
      sequenceValue > 0
    ) {
      await tx.query(
        `INSERT INTO public.matter_number_sequences (tenant_id, prefix, last_number, updated_at)
         VALUES ($1, $2, $3::bigint, NOW())
         ON CONFLICT (tenant_id, prefix) DO UPDATE SET
           last_number = GREATEST(public.matter_number_sequences.last_number, EXCLUDED.last_number),
           updated_at = NOW()`,
        [ctx.tenantId, sequenceKey, sequenceValue],
      );
      return;
    }
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
      await tx.query(
        'SELECT id FROM public.matters WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, matter.id],
      );
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
           opening_record_json, milestones_json, number_sequence_key, number_sequence_value
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
           $43::jsonb, $44::jsonb, $45, $46::bigint
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
           milestones_json = EXCLUDED.milestones_json,
           number_sequence_key = COALESCE(EXCLUDED.number_sequence_key, public.matters.number_sequence_key),
           number_sequence_value = COALESCE(EXCLUDED.number_sequence_value, public.matters.number_sequence_value)
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
          p.numberSequenceKey,
          p.numberSequenceValue,
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
      await this.advanceMatterNumberHighWaterInTx(
        tx,
        ctx,
        p.matterNumber,
        p.numberSequenceKey,
        p.numberSequenceValue,
      );

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
      const existingLockRes = await tx.query<{
        id: string;
        matter_number: string;
      }>(
        'SELECT id, matter_number FROM public.matters WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, matter.id],
      );
      const existingLockRow = existingLockRes.rows[0];
      if (existingLockRow) {
        const prevNum = (existingLockRow.matter_number ?? '').trim();
        const nextNum = (matter.matterNumber ?? '').trim();
        if (prevNum && !prevNum.startsWith('DRAFT') && nextNum !== prevNum) {
          const immutErr = new Error(
            `${MATTER_NUMBER_IMMUTABLE_CODE}: Existing permanent matter number "${prevNum}" cannot be changed to "${nextNum}".`,
          ) as Error & { code: string };
          immutErr.code = MATTER_NUMBER_IMMUTABLE_CODE;
          throw immutErr;
        }
      }
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
           milestones_json = $45::jsonb,
           number_sequence_key = COALESCE($46, public.matters.number_sequence_key),
           number_sequence_value = COALESCE($47::bigint, public.matters.number_sequence_value)
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
          p.numberSequenceKey,
          p.numberSequenceValue,
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
      await this.advanceMatterNumberHighWaterInTx(
        tx,
        ctx,
        p.matterNumber,
        p.numberSequenceKey,
        p.numberSequenceValue,
      );
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
      const existingPutRes = await tx.query<{
        id: string;
        matter_number: string;
      }>(
        'SELECT id, matter_number FROM public.matters WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, matter.id],
      );
      const existingPutRow = existingPutRes.rows[0];
      if (existingPutRow) {
        const prevNum = (existingPutRow.matter_number ?? '').trim();
        const nextNum = (matter.matterNumber ?? '').trim();
        if (prevNum && !prevNum.startsWith('DRAFT') && nextNum !== prevNum) {
          const immutErr = new Error(
            `${MATTER_NUMBER_IMMUTABLE_CODE}: Existing permanent matter number "${prevNum}" cannot be changed to "${nextNum}".`,
          ) as Error & { code: string };
          immutErr.code = MATTER_NUMBER_IMMUTABLE_CODE;
          throw immutErr;
        }
      }
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
           opening_record_json, milestones_json, number_sequence_key, number_sequence_value
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
           $43::jsonb, $44::jsonb, $45, $46::bigint
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
           milestones_json = EXCLUDED.milestones_json,
           number_sequence_key = COALESCE(EXCLUDED.number_sequence_key, public.matters.number_sequence_key),
           number_sequence_value = COALESCE(EXCLUDED.number_sequence_value, public.matters.number_sequence_value)
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
          p.numberSequenceKey,
          p.numberSequenceValue,
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
      await this.advanceMatterNumberHighWaterInTx(
        tx,
        ctx,
        p.matterNumber,
        p.numberSequenceKey,
        p.numberSequenceValue,
      );
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
             opening_record_json, milestones_json, number_sequence_key, number_sequence_value
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
             $44::jsonb, $45::jsonb, $46, $47::bigint
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
             milestones_json = EXCLUDED.milestones_json,
             number_sequence_key = COALESCE(EXCLUDED.number_sequence_key, public.matters.number_sequence_key),
             number_sequence_value = COALESCE(EXCLUDED.number_sequence_value, public.matters.number_sequence_value)
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
            p.numberSequenceKey,
            p.numberSequenceValue,
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
        await this.advanceMatterNumberHighWaterInTx(
          tx,
          ctx,
          p.matterNumber,
          p.numberSequenceKey,
          p.numberSequenceValue,
        );
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
    const allowed = Array.isArray(row.restricted_access_user_ids_json)
      ? row.restricted_access_user_ids_json
      : [];
    if (!row.is_staff_matter && !row.has_ethical_wall && allowed.length === 0) {
      return true;
    }
    if (!viewerId) {
      return false;
    }
    return allowed.includes(viewerId);
  }

  public async existsMatterNumber(
    ctx: TenantContext,
    matterNumber: string,
  ): Promise<boolean> {
    const clean = matterNumber?.trim();
    if (!clean) return false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM public.matters WHERE tenant_id = $1 AND matter_number = $2 AND client_id <> 'O-KEYDATE-STUB' LIMIT 1",
        [ctx.tenantId, clean],
      );
      if (res.rows[0]) {
        this.assertRowTenant(ctx, res.rows[0].tenant_id, 'Matter');
        return true;
      }
      return false;
    });
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
      canViewCdd?: boolean;
    },
  ): Promise<TMatter | null> {
    const viewerId = options?.viewerUserId ?? options?.viewerId ?? ctx.actorId;
    const includeRestricted =
      options?.hasRestrictedMatterAccess ??
      options?.hasRestrictedAccessPermission ??
      options?.includeRestricted ??
      false;
    const canViewCdd = options?.canViewCdd !== false;
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
      const matter = mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []);
      return this.applyMatterCddVisibility(matter, canViewCdd);
    });
  }

  private applyMatterCddVisibility<TMatter extends TenantMatterRecord>(
    matter: TMatter,
    canViewCdd: boolean,
  ): TMatter {
    return canViewCdd ? matter : redactMatterCddFields(matter);
  }

  private resolveMatterViewerOptions(
    ctx: TenantContext,
    viewerOrOptions?:
      | string
      | {
          viewerId?: string;
          viewerUserId?: string;
          includeRestricted?: boolean;
          hasRestrictedAccessPermission?: boolean;
          hasRestrictedMatterAccess?: boolean;
          canViewCdd?: boolean;
          limit?: number;
          offset?: number;
        },
  ): {
    viewerId: string;
    includeRestricted: boolean;
    canViewCdd: boolean;
    limit: number | null;
    offset: number | null;
  } {
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
    const canViewCdd =
      typeof viewerOrOptions === 'object' &&
      viewerOrOptions !== null &&
      viewerOrOptions.canViewCdd === false
        ? false
        : true;
    const limit =
      typeof viewerOrOptions === 'object' &&
      viewerOrOptions !== null &&
      typeof viewerOrOptions.limit === 'number' &&
      Number.isFinite(viewerOrOptions.limit)
        ? Math.max(1, Math.min(500, Math.floor(viewerOrOptions.limit)))
        : null;
    const offset =
      typeof viewerOrOptions === 'object' &&
      viewerOrOptions !== null &&
      typeof viewerOrOptions.offset === 'number' &&
      Number.isFinite(viewerOrOptions.offset)
        ? Math.max(0, Math.floor(viewerOrOptions.offset))
        : null;
    return { viewerId, includeRestricted, canViewCdd, limit, offset };
  }

  private buildMatterEntityFilterClauses(
    filters: {
      readonly ids?: readonly string[];
      readonly matterIds?: readonly string[];
      readonly clientIds?: readonly string[];
      readonly partyEntityIds?: readonly string[];
      readonly contactIds?: readonly string[];
      readonly sourceEnquiryIds?: readonly string[];
      readonly sourceQuoteIds?: readonly string[];
      readonly ownerPersonId?: string;
      readonly conflictReferenceEntityId?: string;
      readonly includeMerged?: boolean;
    },
    params: unknown[],
  ): { orClauses: string[]; andClauses: string[] } {
    const ids = Array.from(
      new Set([...(filters.ids ?? []), ...(filters.matterIds ?? [])].filter(Boolean)),
    );
    const clientIds = Array.from(new Set((filters.clientIds ?? []).filter(Boolean)));
    const partyEntityIds = Array.from(
      new Set((filters.partyEntityIds ?? []).filter(Boolean)),
    );
    const contactIds = Array.from(new Set((filters.contactIds ?? []).filter(Boolean)));
    const sourceEnquiryIds = Array.from(
      new Set((filters.sourceEnquiryIds ?? []).filter(Boolean)),
    );
    const sourceQuoteIds = Array.from(
      new Set((filters.sourceQuoteIds ?? []).filter(Boolean)),
    );
    const ownerPersonId = filters.ownerPersonId?.trim();
    const conflictReferenceEntityId = filters.conflictReferenceEntityId?.trim();
    const orClauses: string[] = [];
    const andClauses: string[] = [];
    if (filters.includeMerged === false) {
      andClauses.push("NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL");
    }
    if (ids.length > 0) {
      params.push(ids);
      orClauses.push(`m.id = ANY($${params.length}::text[])`);
    }
    if (clientIds.length > 0) {
      params.push(clientIds);
      const idx = params.length;
      orClauses.push(
        `(m.client_id = ANY($${idx}::text[]) OR COALESCE(m.additional_client_ids_json, '[]'::jsonb) ?| $${idx}::text[])`,
      );
    }
    if (partyEntityIds.length > 0) {
      params.push(partyEntityIds);
      const idx = params.length;
      orClauses.push(
        `(m.client_id = ANY($${idx}::text[]) OR COALESCE(m.additional_client_ids_json, '[]'::jsonb) ?| $${idx}::text[] OR EXISTS (SELECT 1 FROM public.matter_parties mp WHERE mp.tenant_id = m.tenant_id AND mp.matter_id = m.id AND (mp.entity_id = ANY($${idx}::text[]) OR mp.acting_solicitor_person_id = ANY($${idx}::text[]) OR mp.acting_solicitor_organisation_id = ANY($${idx}::text[]))))`,
      );
    }
    if (contactIds.length > 0) {
      params.push(contactIds);
      const idx = params.length;
      orClauses.push(
        `(m.opening_record_json->>'instructingContactId' = ANY($${idx}::text[]) OR m.opening_record_json->>'billingContactId' = ANY($${idx}::text[]) OR m.opening_record_json->>'referrerContactId' = ANY($${idx}::text[]) OR m.instructing_contact_id = ANY($${idx}::text[]) OR m.billing_contact_id = ANY($${idx}::text[]) OR m.referrer_person_id = ANY($${idx}::text[]) OR m.referrer_organisation_id = ANY($${idx}::text[]) OR m.fields_json->>'referrerContactId' = ANY($${idx}::text[]))`,
      );
    }
    if (sourceEnquiryIds.length > 0) {
      params.push(sourceEnquiryIds);
      orClauses.push(`m.source_enquiry_id = ANY($${params.length}::text[])`);
    }
    if (sourceQuoteIds.length > 0) {
      params.push(sourceQuoteIds);
      orClauses.push(`m.source_quote_id = ANY($${params.length}::text[])`);
    }
    if (ownerPersonId) {
      params.push(ownerPersonId);
      const idx = params.length;
      orClauses.push(
        `(m.responsible_partner_id = $${idx} OR m.responsible_fee_earner_id = $${idx} OR m.supervisor_id = $${idx})`,
      );
    }
    if (conflictReferenceEntityId) {
      const escaped = conflictReferenceEntityId.replace(/[\\%_]/g, '\\$&');
      params.push(`%${escaped}%`);
      const idx = params.length;
      orClauses.push(
        `(m.conflict_check_record_json::text ILIKE $${idx} ESCAPE '\\' OR COALESCE(m.fields_json->'conflictCheckRecord', '{}'::jsonb)::text ILIKE $${idx} ESCAPE '\\' OR COALESCE(m.fields_json->'conflictCheck', '{}'::jsonb)::text ILIKE $${idx} ESCAPE '\\')`,
      );
    }
    return { orClauses, andClauses };
  }

  /**
   * Lists visible tenant matters for a viewer.
   * Note: SQL `LIMIT` / `OFFSET` runs BEFORE the TypeScript `canViewerAccessMatterRow` re-check,
   * so the SQL WHERE visibility predicate and `canViewerAccessMatterRow` must remain identical.
   */
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
          canViewCdd?: boolean;
          includeMerged?: boolean;
          limit?: number;
          offset?: number;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    const { viewerId, includeRestricted, canViewCdd, limit, offset } =
      this.resolveMatterViewerOptions(ctx, viewerOrOptions);
    const includeMerged =
      typeof viewerOrOptions === 'object' && viewerOrOptions !== null
        ? viewerOrOptions.includeMerged
        : undefined;
    const mergedClause =
      includeMerged === false
        ? "\n             AND NULLIF(COALESCE(opening_record_json->>'mergedIntoId', ''), '') IS NULL"
        : '';
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = includeRestricted ? [ctx.tenantId] : [ctx.tenantId, viewerId];
      let sql = includeRestricted
        ? `SELECT *
           FROM public.matters
           WHERE tenant_id = $1
             AND client_id <> 'O-KEYDATE-STUB'${mergedClause}
           ORDER BY id ASC`
        : `SELECT *
           FROM public.matters
           WHERE tenant_id = $1
             AND client_id <> 'O-KEYDATE-STUB'${mergedClause}
             AND (
               (
                 is_staff_matter = FALSE
                 AND has_ethical_wall = FALSE
                 AND jsonb_array_length(COALESCE(restricted_access_user_ids_json, '[]'::jsonb)) = 0
               )
               OR restricted_access_user_ids_json ? $2
             )
           ORDER BY id ASC`;
      if (limit !== null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      if (offset !== null) {
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
      }
      const res = await tx.query<DbMatterRow>(sql, params);
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
        this.applyMatterCddVisibility(
          mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
          canViewCdd,
        ),
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

  public async listMattersUnfilteredByIdsOrSources<
    TMatter extends TenantMatterRecord = TenantMatterRecord,
  >(
    ctx: TenantContext,
    filters: {
      readonly ids?: readonly string[];
      readonly matterIds?: readonly string[];
      readonly clientIds?: readonly string[];
      readonly partyEntityIds?: readonly string[];
      readonly contactIds?: readonly string[];
      readonly sourceEnquiryIds?: readonly string[];
      readonly sourceQuoteIds?: readonly string[];
      readonly ownerPersonId?: string;
      readonly conflictReferenceEntityId?: string;
    },
  ): Promise<TMatter[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId];
      const { orClauses } = this.buildMatterEntityFilterClauses(filters, params);
      if (orClauses.length === 0) return [];
      const res = await tx.query<DbMatterRow>(
        `SELECT m.* FROM public.matters m
         WHERE m.tenant_id = $1
           AND m.client_id <> 'O-KEYDATE-STUB'
           AND (${orClauses.join(' OR ')})
         ORDER BY m.id ASC`,
        params,
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

  /**
   * Lists matters related to an entity/owner/source filter with viewer visibility enforcement (`S1-02b`).
   */
  public async listVisibleMattersForEntity<
    TMatter extends TenantMatterRecord = TenantMatterRecord,
  >(
    ctx: TenantContext,
    filters: {
      readonly ids?: readonly string[];
      readonly matterIds?: readonly string[];
      readonly clientIds?: readonly string[];
      readonly partyEntityIds?: readonly string[];
      readonly contactIds?: readonly string[];
      readonly sourceEnquiryIds?: readonly string[];
      readonly sourceQuoteIds?: readonly string[];
      readonly ownerPersonId?: string;
      readonly conflictReferenceEntityId?: string;
      readonly includeMerged?: boolean;
      readonly limit?: number;
    },
    viewerOrOptions:
      | string
      | {
          viewerId?: string;
          viewerUserId?: string;
          includeRestricted?: boolean;
          hasRestrictedAccessPermission?: boolean;
          hasRestrictedMatterAccess?: boolean;
          canViewCdd?: boolean;
          limit?: number;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    const resolved = this.resolveMatterViewerOptions(ctx, viewerOrOptions);
    const limit =
      typeof filters.limit === 'number' && Number.isFinite(filters.limit)
        ? Math.max(1, Math.min(500, Math.floor(filters.limit)))
        : resolved.limit;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = resolved.includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, resolved.viewerId];
      const { orClauses, andClauses } = this.buildMatterEntityFilterClauses(
        filters,
        params,
      );
      if (orClauses.length === 0) return [];
      const clauses = [
        'm.tenant_id = $1',
        "m.client_id <> 'O-KEYDATE-STUB'",
        `(${orClauses.join(' OR ')})`,
        ...andClauses,
      ];
      if (!resolved.includeRestricted) {
        clauses.push(`(
          (
            m.is_staff_matter = FALSE
            AND m.has_ethical_wall = FALSE
            AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
          )
          OR m.restricted_access_user_ids_json ? $2
        )`);
      }
      let sql = `SELECT m.* FROM public.matters m
         WHERE ${clauses.join(' AND ')}
         ORDER BY m.id ASC`;
      if (limit !== null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      const res = await tx.query<DbMatterRow>(sql, params);
      const visibleRows = res.rows.filter((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Matter');
        return (
          resolved.includeRestricted ||
          this.canViewerAccessMatterRow(row, resolved.viewerId)
        );
      });
      const partiesMap = await this.loadPartiesByMatterIdsInTx(
        tx,
        ctx,
        visibleRows.map((r) => r.id),
      );
      return visibleRows.map((row) =>
        this.applyMatterCddVisibility(
          mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
          resolved.canViewCdd,
        ),
      );
    });
  }

  /**
   * Locks (`SELECT ... FOR UPDATE`) and returns only the affected matter rows inside an active
   * tenant transaction so restriction metadata (`is_staff_matter`, `has_ethical_wall`,
   * `restricted_access_user_ids_json`) can be recomputed from in-transaction inputs (`R478`).
   */
  public async lockMattersForRestrictionRecompute<
    TMatter extends TenantMatterRecord = TenantMatterRecord,
  >(
    ctx: TenantContext,
    options?: {
      matterIds?: readonly string[];
      includeAllRestrictedMatters?: boolean;
    },
  ): Promise<TMatter[]> {
    const activeTx = getActiveTenantTransactionState();
    if (!activeTx || activeTx.tenantId !== ctx.tenantId) {
      const err = new Error(
        `TENANCY_TRANSACTION_REQUIRED: lockMattersForRestrictionRecompute requires an active withTenantTransaction for tenant "${ctx.tenantId}".`,
      ) as Error & { code: string };
      err.code = 'TENANCY_TRANSACTION_REQUIRED';
      throw err;
    }
    const explicitIds = Array.from(
      new Set((options?.matterIds ?? []).filter(Boolean)),
    );
    const includeAllRestricted = Boolean(options?.includeAllRestrictedMatters);
    if (!includeAllRestricted && explicitIds.length === 0) {
      return [];
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = includeAllRestricted
        ? await tx.query<DbMatterRow>(
            `SELECT *
               FROM public.matters
              WHERE tenant_id = $1
                AND client_id <> 'O-KEYDATE-STUB'
                AND (
                  is_staff_matter = TRUE
                  OR has_ethical_wall = TRUE
                  OR jsonb_array_length(COALESCE(restricted_access_user_ids_json, '[]'::jsonb)) > 0
                  OR id = ANY($2::text[])
                )
              ORDER BY id ASC
                FOR UPDATE`,
            [ctx.tenantId, explicitIds],
          )
        : await tx.query<DbMatterRow>(
            `SELECT *
               FROM public.matters
              WHERE tenant_id = $1
                AND client_id <> 'O-KEYDATE-STUB'
                AND id = ANY($2::text[])
              ORDER BY id ASC
                FOR UPDATE`,
            [ctx.tenantId, explicitIds],
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

  /**
   * Updates restriction columns on a matter row that was locked via `SELECT ... FOR UPDATE`
   * in the same active tenant transaction (`R478`).
   */
  public async updateLockedMatterRestrictionColumnsInTx(
    ctx: TenantContext,
    matterId: string,
    params: {
      isStaffMatter: boolean;
      hasEthicalWall: boolean;
      sqlRestrictedAccessUserIds: readonly string[];
    },
  ): Promise<void> {
    const activeTx = getActiveTenantTransactionState();
    if (!activeTx || activeTx.tenantId !== ctx.tenantId) {
      const err = new Error(
        `TENANCY_TRANSACTION_REQUIRED: updateLockedMatterRestrictionColumnsInTx requires an active withTenantTransaction for tenant "${ctx.tenantId}".`,
      ) as Error & { code: string };
      err.code = 'TENANCY_TRANSACTION_REQUIRED';
      throw err;
    }
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE public.matters
            SET is_staff_matter = $3,
                has_ethical_wall = $4,
                restricted_access_user_ids_json = $5::jsonb
          WHERE tenant_id = $1
            AND id = $2`,
        [
          ctx.tenantId,
          matterId,
          Boolean(params.isStaffMatter),
          Boolean(params.hasEthicalWall),
          JSON.stringify([...params.sqlRestrictedAccessUserIds]),
        ],
      );
    });
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
          canViewCdd?: boolean;
          includeMerged?: boolean;
          excludeIds?: readonly string[];
          limit?: number;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    const cleanQuery = query?.trim().toLowerCase() ?? '';
    const optsObj =
      typeof viewerOrOptions === 'object' && viewerOrOptions !== null
        ? viewerOrOptions
        : undefined;
    const excludeIds = Array.from(
      new Set((optsObj?.excludeIds ?? []).map((id) => id?.trim()).filter(Boolean) as string[]),
    );
    const { viewerId, includeRestricted, canViewCdd, limit } =
      this.resolveMatterViewerOptions(ctx, viewerOrOptions);
    if (!cleanQuery && excludeIds.length === 0 && optsObj?.includeMerged === undefined) {
      return this.listVisibleMatters<TMatter>(ctx, viewerOrOptions);
    }
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses = [
        'm.tenant_id = $1',
        "m.client_id <> 'O-KEYDATE-STUB'",
      ];
      if (!includeRestricted) {
        clauses.push(`(
          (
            m.is_staff_matter = FALSE
            AND m.has_ethical_wall = FALSE
            AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
          )
          OR m.restricted_access_user_ids_json ? $2
        )`);
      }
      if (optsObj?.includeMerged === false) {
        clauses.push("NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL");
      }
      if (excludeIds.length > 0) {
        params.push(excludeIds);
        clauses.push(`m.id <> ALL($${params.length}::text[])`);
      }
      if (cleanQuery) {
        const likePattern = `%${cleanQuery.replace(/[\\%_]/g, '\\$&')}%`;
        params.push(likePattern);
        const patternParam = `$${params.length}`;
        clauses.push(`(
          lower(COALESCE(m.id, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.matter_number, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.title, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.opening_record_json->>'shortDescription', '')) LIKE ${patternParam} ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM public.matter_parties mp
            WHERE mp.tenant_id = m.tenant_id
              AND mp.matter_id = m.id
              AND lower(COALESCE(mp.metadata_json->>'name', '')) LIKE ${patternParam} ESCAPE '\\'
          )
        )`);
      }
      let sql = `SELECT m.*
         FROM public.matters m
         WHERE ${clauses.join(' AND ')}
         ORDER BY m.id ASC`;
      if (limit !== null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      const res = await tx.query<DbMatterRow>(sql, params);
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
        this.applyMatterCddVisibility(
          mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
          canViewCdd,
        ),
      );
    });
  }

  // ============================================================================
  // S1-02a Scoped Matter Queries
  // ============================================================================

  public async listMattersByIds<TMatter extends TenantMatterRecord = TenantMatterRecord>(
    ctx: TenantContext,
    matterIds: readonly string[],
    viewerOrOptions?: {
      viewerId?: string;
      viewerUserId?: string;
      includeRestricted?: boolean;
      hasRestrictedAccessPermission?: boolean;
      hasRestrictedMatterAccess?: boolean;
      canViewCdd?: boolean;
    },
  ): Promise<TMatter[]> {
    const cleanIds = Array.from(
      new Set(matterIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    const viewerId =
      viewerOrOptions?.viewerUserId ??
      viewerOrOptions?.viewerId ??
      ctx.actorId;
    const includeRestricted = Boolean(
      viewerOrOptions?.hasRestrictedMatterAccess ??
        viewerOrOptions?.hasRestrictedAccessPermission ??
        viewerOrOptions?.includeRestricted,
    );
    const canViewCdd = viewerOrOptions?.canViewCdd !== false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbMatterRow>(
        `SELECT * FROM public.matters
         WHERE tenant_id = $1
           AND client_id <> 'O-KEYDATE-STUB'
           AND id = ANY($2::text[])
         ORDER BY id ASC`,
        [ctx.tenantId, cleanIds],
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
        this.applyMatterCddVisibility(
          mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
          canViewCdd,
        ),
      );
    });
  }

  public async listMatterIdsMatchingCandidateGraph(
    ctx: TenantContext,
    params: {
      readonly candidateEntityIds?: readonly string[];
      readonly candidateTerms?: readonly string[];
    },
  ): Promise<string[]> {
    const entityIds = Array.from(
      new Set((params.candidateEntityIds ?? []).filter(Boolean)),
    );
    const terms = Array.from(
      new Set(
        (params.candidateTerms ?? [])
          .map((t) => t.trim())
          .filter((t) => t.length >= 2),
      ),
    );
    if (entityIds.length === 0 && terms.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const orClauses: string[] = [];
      const sqlParams: unknown[] = [ctx.tenantId];
      if (entityIds.length > 0) {
        sqlParams.push(entityIds);
        const idx = sqlParams.length;
        orClauses.push(
          `(m.client_id = ANY($${idx}::text[]) OR COALESCE(m.additional_client_ids_json, '[]'::jsonb) ?| $${idx}::text[] OR m.opening_record_json->>'instructingContactId' = ANY($${idx}::text[]) OR m.opening_record_json->>'billingContactId' = ANY($${idx}::text[]) OR m.opening_record_json->>'referrerContactId' = ANY($${idx}::text[]) OR m.instructing_contact_id = ANY($${idx}::text[]) OR m.billing_contact_id = ANY($${idx}::text[]) OR m.referrer_person_id = ANY($${idx}::text[]) OR m.referrer_organisation_id = ANY($${idx}::text[]) OR m.fields_json->>'referrerContactId' = ANY($${idx}::text[]) OR EXISTS (SELECT 1 FROM public.matter_parties mp WHERE mp.tenant_id = m.tenant_id AND mp.matter_id = m.id AND (mp.entity_id = ANY($${idx}::text[]) OR mp.acting_solicitor_person_id = ANY($${idx}::text[]) OR mp.acting_solicitor_organisation_id = ANY($${idx}::text[]))))`,
        );
      }
      for (const term of terms) {
        const escaped = term.replace(/[\\%_]/g, '\\$&');
        sqlParams.push(`%${escaped}%`, term);
        const likeIdx = sqlParams.length - 1;
        const trgmIdx = sqlParams.length;
        const mpNameLower = `lower(COALESCE(mp.metadata_json->>'name', ''))`;
        const mpNameTrimLower = `lower(trim(COALESCE(mp.metadata_json->>'name', '')))`;
        orClauses.push(
          `EXISTS (SELECT 1 FROM public.matter_parties mp WHERE mp.tenant_id = m.tenant_id AND mp.matter_id = m.id AND (COALESCE(mp.metadata_json->>'name', '') ILIKE $${likeIdx} OR word_similarity($${trgmIdx}, ${mpNameLower}) >= 0.28 OR word_similarity(${mpNameLower}, $${trgmIdx}) >= 0.28 OR (length(${mpNameTrimLower}) >= 3 AND strpos(lower($${trgmIdx}), ${mpNameTrimLower}) > 0)))`,
        );
      }
      const res = await tx.query<{ tenant_id: string; id: string }>(
        `SELECT m.tenant_id, m.id FROM public.matters m
         WHERE m.tenant_id = $1
           AND m.client_id <> 'O-KEYDATE-STUB'
           AND (${orClauses.join(' OR ')})
         ORDER BY m.id ASC`,
        sqlParams,
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'Matter');
        return r.id;
      });
    });
  }

  public async listVisibleMattersPageWithCount<
    TMatter extends TenantMatterRecord = TenantMatterRecord,
  >(
    ctx: TenantContext,
    viewerOrOptions?: {
      viewerId?: string;
      viewerUserId?: string;
      includeRestricted?: boolean;
      hasRestrictedAccessPermission?: boolean;
      hasRestrictedMatterAccess?: boolean;
      canViewCdd?: boolean;
      includeMerged?: boolean;
      excludeIds?: readonly string[];
      query?: string;
      matchingPracticeAreaIds?: readonly string[];
      matchingWorkTypeIds?: readonly string[];
      statusId?: string;
      cmiIncompleteStatusIds?: readonly string[];
      activeStatusIds?: readonly string[];
      practiceAreaId?: string;
      typeBadge?: string;
      billingBasisId?: string;
      mineOnly?: boolean;
      responsiblePartnerId?: string;
      leadFeeEarnerId?: string;
      staffRestrictedOnly?: boolean;
      sortOrder?: 'id_asc' | 'updated_desc';
      sortBy?: 'matter' | 'status' | 'openedAt';
      sortDir?: 'asc' | 'desc';
      statusSortIds?: readonly string[];
      limit?: number;
      offset?: number;
    },
  ): Promise<{
    readonly items: TMatter[];
    readonly totalCount: number;
    readonly effectivePage: number;
  }> {
    const cleanQuery = viewerOrOptions?.query?.trim().toLowerCase() ?? '';
    const matchingPracticeAreaIds = Array.from(
      new Set((viewerOrOptions?.matchingPracticeAreaIds ?? []).filter(Boolean)),
    );
    const matchingWorkTypeIds = Array.from(
      new Set((viewerOrOptions?.matchingWorkTypeIds ?? []).filter(Boolean)),
    );
    const statusSortIds = Array.from(
      new Set((viewerOrOptions?.statusSortIds ?? []).filter(Boolean)),
    );
    const excludeIds = Array.from(
      new Set(
        (viewerOrOptions?.excludeIds ?? [])
          .map((id) => id?.trim())
          .filter(Boolean) as string[],
      ),
    );
    const statusId = viewerOrOptions?.statusId?.trim() || undefined;
    const cmiIncompleteStatusIds = Array.from(
      new Set(
        (viewerOrOptions?.cmiIncompleteStatusIds ?? [])
          .map((id) => id?.trim())
          .filter(Boolean) as string[],
      ),
    );
    const activeStatusIds = Array.from(
      new Set(
        (viewerOrOptions?.activeStatusIds ?? [])
          .map((id) => id?.trim())
          .filter(Boolean) as string[],
      ),
    );
    const practiceAreaId = viewerOrOptions?.practiceAreaId?.trim() || undefined;
    const typeBadge = viewerOrOptions?.typeBadge?.trim() || undefined;
    const billingBasisId = viewerOrOptions?.billingBasisId?.trim() || undefined;
    const mineOnly = Boolean(viewerOrOptions?.mineOnly);
    const responsiblePartnerId =
      viewerOrOptions?.responsiblePartnerId?.trim() || undefined;
    const leadFeeEarnerId =
      viewerOrOptions?.leadFeeEarnerId?.trim() || undefined;
    const staffRestrictedOnly = Boolean(viewerOrOptions?.staffRestrictedOnly);
    const { viewerId, includeRestricted, canViewCdd } = this.resolveMatterViewerOptions(
      ctx,
      viewerOrOptions ?? ctx.actorId,
    );
    const limit =
      typeof viewerOrOptions?.limit === 'number' &&
      Number.isFinite(viewerOrOptions.limit)
        ? Math.max(1, Math.min(500, Math.floor(viewerOrOptions.limit)))
        : 50;
    const offset =
      typeof viewerOrOptions?.offset === 'number' &&
      Number.isFinite(viewerOrOptions.offset)
        ? Math.max(0, Math.floor(viewerOrOptions.offset))
        : 0;
    const dirSql = viewerOrOptions?.sortDir === 'desc' ? 'DESC' : 'ASC';
    const defaultSortSql =
      viewerOrOptions?.sortOrder === 'updated_desc'
        ? 'm.updated_at DESC, m.id ASC'
        : 'm.id ASC';

    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses = ['m.tenant_id = $1', "m.client_id <> 'O-KEYDATE-STUB'"];
      if (!includeRestricted) {
        // Must remain identical to canViewerAccessMatterRow (`Suggestion 2`).
        clauses.push(`(
          (
            m.is_staff_matter = FALSE
            AND m.has_ethical_wall = FALSE
            AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
          )
          OR m.restricted_access_user_ids_json ? $2
        )`);
      }
      if (viewerOrOptions?.includeMerged === false) {
        clauses.push(
          "NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL",
        );
      }
      if (excludeIds.length > 0) {
        params.push(excludeIds);
        clauses.push(`m.id <> ALL($${params.length}::text[])`);
      }
      if (statusId) {
        params.push(statusId);
        const sIdx = params.length;
        if (cmiIncompleteStatusIds.includes(statusId)) {
          const legacyActiveClause =
            activeStatusIds.length > 0
              ? (() => {
                  params.push(activeStatusIds);
                  return `m.status_id = ANY($${params.length}::text[])`;
                })()
              : "m.status_id = 'matter_status.active'";
          clauses.push(
            `(
              m.status_id = $${sIdx}
              OR (
                ${legacyActiveClause}
                AND COALESCE(m.fields_json->'matterOpeningGate'->>'openedViaGate', 'false') <> 'true'
                AND m.opening_record_json->>'amlStatus' IN ('Pending', 'CMI incomplete')
              )
            )`,
          );
        } else {
          clauses.push(`m.status_id = $${sIdx}`);
        }
      }
      if (practiceAreaId) {
        params.push(practiceAreaId);
        clauses.push(`m.practice_area_id = $${params.length}`);
      }
      if (typeBadge) {
        params.push(typeBadge);
        clauses.push(`m.opening_record_json->>'typeBadge' = $${params.length}`);
      }
      if (billingBasisId) {
        params.push(billingBasisId);
        clauses.push(`m.opening_record_json->>'billingBasisId' = $${params.length}`);
      }
      if (mineOnly) {
        params.push(viewerId);
        const vIdx = params.length;
        clauses.push(
          `(
            m.responsible_fee_earner_id = $${vIdx}
            OR m.responsible_partner_id = $${vIdx}
            OR m.supervisor_id = $${vIdx}
            OR (m.opening_record_json->'teamMemberIds') ? $${vIdx}
          )`,
        );
      }
      if (responsiblePartnerId) {
        params.push(responsiblePartnerId);
        clauses.push(`m.responsible_partner_id = $${params.length}`);
      }
      if (leadFeeEarnerId) {
        params.push(leadFeeEarnerId);
        clauses.push(`m.responsible_fee_earner_id = $${params.length}`);
      }
      if (staffRestrictedOnly) {
        clauses.push(
          `(m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE OR jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) > 0)`,
        );
      }
      if (cleanQuery) {
        const likePattern = `%${cleanQuery.replace(/[\\%_]/g, '\\$&')}%`;
        params.push(likePattern);
        const patternParam = `$${params.length}`;
        let practiceAreaClause = '';
        if (matchingPracticeAreaIds.length > 0) {
          params.push(matchingPracticeAreaIds);
          practiceAreaClause = `\n          OR m.practice_area_id = ANY($${params.length}::text[])`;
        }
        let workTypeClause = '';
        if (matchingWorkTypeIds.length > 0) {
          params.push(matchingWorkTypeIds);
          workTypeClause = `\n          OR m.work_type_subcategory_id = ANY($${params.length}::text[])`;
        }
        clauses.push(`(
          lower(COALESCE(m.id, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.matter_number, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.title, '')) LIKE ${patternParam} ESCAPE '\\'
          OR lower(COALESCE(m.opening_record_json->>'shortDescription', '')) LIKE ${patternParam} ESCAPE '\\'${practiceAreaClause}${workTypeClause}
          OR EXISTS (
            SELECT 1 FROM public.people cp
            WHERE cp.tenant_id = m.tenant_id AND cp.id = m.client_id
              AND lower(trim(concat_ws(' ', NULLIF(cp.first_name, ''), NULLIF(cp.surname, '')))) LIKE ${patternParam} ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM public.organisations co
            WHERE co.tenant_id = m.tenant_id AND co.id = m.client_id
              AND lower(COALESCE(co.legal_name, '')) LIKE ${patternParam} ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM public.matter_parties mp
            WHERE mp.tenant_id = m.tenant_id
              AND mp.matter_id = m.id
              AND lower(COALESCE(mp.metadata_json->>'name', '')) LIKE ${patternParam} ESCAPE '\\'
          )
        )`);
      }

      const whereSql = clauses.join(' AND ');
      const countRes = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM public.matters m WHERE ${whereSql}`,
        params,
      );
      const totalCount = Number(countRes.rows[0]?.cnt ?? 0);
      const totalPages = totalCount > 0 ? Math.ceil(totalCount / limit) : 1;
      const effectivePage =
        totalCount === 0
          ? 1
          : Math.min(Math.floor(offset / limit) + 1, totalPages);
      const effectiveOffset =
        totalCount > 0 && offset >= totalCount
          ? (totalPages - 1) * limit
          : offset;

      const pageParams: unknown[] = [...params];
      let sortSql = defaultSortSql;
      if (viewerOrOptions?.sortBy === 'matter') {
        sortSql = `lower(COALESCE(m.matter_number, '')) ${dirSql}, m.id ASC`;
      } else if (viewerOrOptions?.sortBy === 'openedAt') {
        sortSql = `COALESCE(NULLIF(m.opened_on, ''), to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) ${dirSql}, m.id ASC`;
      } else if (viewerOrOptions?.sortBy === 'status') {
        if (statusSortIds.length > 0) {
          pageParams.push(statusSortIds);
          sortSql = `COALESCE(NULLIF(array_position($${pageParams.length}::text[], m.status_id), 0), 999) ${dirSql}, lower(COALESCE(m.matter_number, '')) ASC, m.id ASC`;
        } else {
          sortSql = `lower(COALESCE(m.status_id, '')) ${dirSql}, m.id ASC`;
        }
      }

      pageParams.push(limit, effectiveOffset);
      const res = await tx.query<DbMatterRow>(
        `SELECT m.*
         FROM public.matters m
         WHERE ${whereSql}
         ORDER BY ${sortSql}
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
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
      return {
        items: visibleRows.map((row) =>
          this.applyMatterCddVisibility(
            mapMatterRow<TMatter>(row, partiesMap.get(row.id) ?? []),
            canViewCdd,
          ),
        ),
        totalCount,
        effectivePage,
      };
    });
  }

  /**
   * Counts visible, unmerged, non-closed matters per organisation `client_id` in SQL (`R702`)
   * so `/organisations` avoids fetching a capped full-tenant matters array solely for row counts.
   */
  public async countVisibleActiveMattersByOrgIds(
    ctx: TenantContext,
    organisationIds: readonly string[],
    options?: {
      readonly viewerId?: string;
      readonly viewerUserId?: string;
      readonly includeRestricted?: boolean;
      readonly hasRestrictedMatterAccess?: boolean;
      readonly closedStatusIds?: readonly string[];
    },
  ): Promise<Record<string, number>> {
    const cleanOrgIds = Array.from(
      new Set(
        organisationIds
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (cleanOrgIds.length === 0) return {};
    const closedStatusIds = Array.from(
      new Set(
        (options?.closedStatusIds ?? [])
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const { viewerId, includeRestricted } = this.resolveMatterViewerOptions(
      ctx,
      options ?? ctx.actorId,
    );
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId, cleanOrgIds]
        : [ctx.tenantId, cleanOrgIds, viewerId];
      const clauses = [
        'm.tenant_id = $1',
        "m.client_id <> 'O-KEYDATE-STUB'",
        'm.client_id = ANY($2::text[])',
        "NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL",
      ];
      if (!includeRestricted) {
        clauses.push(`(
          (
            m.is_staff_matter = FALSE
            AND m.has_ethical_wall = FALSE
            AND jsonb_array_length(COALESCE(m.restricted_access_user_ids_json, '[]'::jsonb)) = 0
          )
          OR m.restricted_access_user_ids_json ? $3
        )`);
      }
      if (closedStatusIds.length > 0) {
        params.push(closedStatusIds);
        clauses.push(
          `(m.status_id IS NULL OR m.status_id <> ALL($${params.length}::text[]))`,
        );
      }
      const res = await tx.query<{ client_id: string; cnt: number }>(
        `SELECT m.client_id, COUNT(*)::int AS cnt
         FROM public.matters m
         WHERE ${clauses.join(' AND ')}
         GROUP BY m.client_id`,
        params,
      );
      const out: Record<string, number> = {};
      for (const row of res.rows) {
        out[row.client_id] = Number(row.cnt ?? 0);
      }
      return out;
    });
  }

  /**
   * Aggregates matter party relationship, capacity, and work-type usage counts
   * across all non-stub, unmerged tenant matters in SQL (`R700`), matching
   * `computeMatterPartyUsageCounts`.
   */
  public async getMatterPartyUsageSummary(ctx: TenantContext): Promise<{
    readonly byRelationshipCode: Record<string, number>;
    readonly byCapacityCode: Record<string, number>;
    readonly byWorkTypeSubcategoryId: Record<string, number>;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [relRes, capRes, subRes] = await Promise.all([
        tx.query<{ code: string; cnt: number }>(
          `WITH active_matters AS (
             SELECT *
             FROM public.matters m
             WHERE m.tenant_id = $1
               AND m.client_id <> 'O-KEYDATE-STUB'
               AND NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL
           ),
           rel_entries AS (
             SELECT 'CL'::text AS code
             FROM active_matters m
             WHERE m.client_id IS NOT NULL AND m.client_id <> ''
             UNION ALL
             SELECT 'JC'::text AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(m.additional_client_ids_json) = 'array'
                 THEN m.additional_client_ids_json
                 ELSE '[]'::jsonb
               END
             ) AS jc
             UNION ALL
             SELECT 'CC'::text AS code
             FROM active_matters m
             WHERE m.instructing_contact_id IS NOT NULL
               AND m.instructing_contact_id <> ''
               AND m.instructing_contact_id IS DISTINCT FROM m.client_id
             UNION ALL
             SELECT NULLIF(COALESCE(mp.metadata_json->>'relationshipCode', mp.relationship_id), '') AS code
             FROM active_matters m
             JOIN public.matter_parties mp
               ON mp.tenant_id = m.tenant_id AND mp.matter_id = m.id
             UNION ALL
             SELECT NULLIF(cp->>'relationshipCode', '') AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(m.conflict_check_record_json->'parties') = 'array'
                 THEN m.conflict_check_record_json->'parties'
                 ELSE '[]'::jsonb
               END
             ) cp
             WHERE COALESCE((cp->>'isClientFixed')::boolean, false) = false
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.matter_parties mp2
                 WHERE mp2.tenant_id = m.tenant_id
                   AND mp2.matter_id = m.id
                   AND COALESCE(
                     mp2.metadata_json->>'id',
                     CASE
                       WHEN mp2.id LIKE m.id || ':%'
                       THEN substr(mp2.id, char_length(m.id) + 2)
                       ELSE mp2.id
                     END
                   ) = cp->>'id'
               )
           )
           SELECT code, COUNT(*)::int AS cnt
           FROM rel_entries
           WHERE code IS NOT NULL AND code <> ''
           GROUP BY code`,
          [ctx.tenantId],
        ),
        tx.query<{ code: string; cnt: number }>(
          `WITH active_matters AS (
             SELECT *
             FROM public.matters m
             WHERE m.tenant_id = $1
               AND m.client_id <> 'O-KEYDATE-STUB'
               AND NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL
           ),
           cap_entries AS (
             SELECT cap_code AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(m.fields_json->'clientCapacityCodes') = 'array'
                 THEN m.fields_json->'clientCapacityCodes'
                 ELSE '[]'::jsonb
               END
             ) cap_code
             WHERE m.client_id IS NOT NULL AND m.client_id <> ''
             UNION ALL
             SELECT cap_code AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(m.additional_client_ids_json) = 'array'
                 THEN m.additional_client_ids_json
                 ELSE '[]'::jsonb
               END
             ) jc_id
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(m.fields_json->'jointClientCapacityCodes'->jc_id) = 'array'
                 THEN m.fields_json->'jointClientCapacityCodes'->jc_id
                 ELSE '[]'::jsonb
               END
             ) cap_code
             UNION ALL
             SELECT cap_code AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(m.fields_json->'instructingContactCapacityCodes') = 'array'
                 THEN m.fields_json->'instructingContactCapacityCodes'
                 ELSE '["CAP_REPRESENTATIVE","CAP_DECISION_MAKER"]'::jsonb
               END
             ) cap_code
             WHERE m.instructing_contact_id IS NOT NULL
               AND m.instructing_contact_id <> ''
               AND m.instructing_contact_id IS DISTINCT FROM m.client_id
             UNION ALL
             SELECT cap_code AS code
             FROM active_matters m
             JOIN public.matter_parties mp
               ON mp.tenant_id = m.tenant_id AND mp.matter_id = m.id
             CROSS JOIN LATERAL (
               SELECT jsonb_array_elements_text(mp.metadata_json->'capacityCodes') AS cap_code
               WHERE jsonb_typeof(mp.metadata_json->'capacityCodes') = 'array'
               UNION ALL
               SELECT mp.capacity_id AS cap_code
               WHERE jsonb_typeof(mp.metadata_json->'capacityCodes') IS DISTINCT FROM 'array'
                 AND mp.capacity_id IS NOT NULL AND mp.capacity_id <> ''
             ) mp_caps
             UNION ALL
             SELECT cap_code AS code
             FROM active_matters m
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(m.conflict_check_record_json->'parties') = 'array'
                 THEN m.conflict_check_record_json->'parties'
                 ELSE '[]'::jsonb
               END
             ) cp
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(cp->'capacityCodes') = 'array'
                 THEN cp->'capacityCodes'
                 ELSE '[]'::jsonb
               END
             ) cap_code
             WHERE COALESCE((cp->>'isClientFixed')::boolean, false) = false
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.matter_parties mp2
                 WHERE mp2.tenant_id = m.tenant_id
                   AND mp2.matter_id = m.id
                   AND COALESCE(
                     mp2.metadata_json->>'id',
                     CASE
                       WHEN mp2.id LIKE m.id || ':%'
                       THEN substr(mp2.id, char_length(m.id) + 2)
                       ELSE mp2.id
                     END
                   ) = cp->>'id'
               )
           )
           SELECT code, COUNT(*)::int AS cnt
           FROM cap_entries
           WHERE code IS NOT NULL AND code <> ''
           GROUP BY code`,
          [ctx.tenantId],
        ),
        tx.query<{ code: string; cnt: number }>(
          `SELECT m.work_type_subcategory_id AS code, COUNT(*)::int AS cnt
           FROM public.matters m
           WHERE m.tenant_id = $1
             AND m.client_id <> 'O-KEYDATE-STUB'
             AND NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL
             AND m.work_type_subcategory_id IS NOT NULL
             AND m.work_type_subcategory_id <> ''
           GROUP BY m.work_type_subcategory_id`,
          [ctx.tenantId],
        ),
      ]);

      const byRelationshipCode: Record<string, number> = {};
      for (const row of relRes.rows) {
        if (row.code) byRelationshipCode[row.code] = Number(row.cnt);
      }
      const byCapacityCode: Record<string, number> = {};
      for (const row of capRes.rows) {
        if (row.code) byCapacityCode[row.code] = Number(row.cnt);
      }
      const byWorkTypeSubcategoryId: Record<string, number> = {};
      for (const row of subRes.rows) {
        if (row.code) byWorkTypeSubcategoryId[row.code] = Number(row.cnt);
      }
      return {
        byRelationshipCode,
        byCapacityCode,
        byWorkTypeSubcategoryId,
      };
    });
  }

  public async countMatterPartyUsages(
    ctx: TenantContext,
    filter: { readonly relationshipTypeId?: string; readonly capacityId?: string },
  ): Promise<number> {
    const rel = filter.relationshipTypeId?.trim() || undefined;
    const cap = filter.capacityId?.trim() || undefined;
    if (!rel && !cap) return 0;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      if (rel && !cap) {
        const res = await tx.query<{ cnt: number }>(
          `SELECT COALESCE(SUM(
             (CASE WHEN $2 = 'CL' AND m.client_id IS NOT NULL AND m.client_id <> '' THEN 1 ELSE 0 END)
             + (CASE WHEN $2 = 'JC' AND jsonb_typeof(m.additional_client_ids_json) = 'array'
                     THEN jsonb_array_length(m.additional_client_ids_json) ELSE 0 END)
             + (CASE WHEN $2 = 'CC' AND m.instructing_contact_id IS NOT NULL AND m.instructing_contact_id <> ''
                          AND m.instructing_contact_id IS DISTINCT FROM m.client_id THEN 1 ELSE 0 END)
             + (SELECT COUNT(*)::int
                FROM public.matter_parties mp
                WHERE mp.tenant_id = m.tenant_id
                  AND mp.matter_id = m.id
                  AND COALESCE(mp.metadata_json->>'relationshipCode', mp.relationship_id) = $2)
             + (SELECT COUNT(*)::int
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(m.conflict_check_record_json->'parties') = 'array'
                    THEN m.conflict_check_record_json->'parties'
                    ELSE '[]'::jsonb
                  END
                ) cp
                WHERE COALESCE((cp->>'isClientFixed')::boolean, false) = false
                  AND cp->>'relationshipCode' = $2
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.matter_parties mp2
                    WHERE mp2.tenant_id = m.tenant_id
                      AND mp2.matter_id = m.id
                      AND COALESCE(
                        mp2.metadata_json->>'id',
                        CASE
                          WHEN mp2.id LIKE m.id || ':%'
                          THEN substr(mp2.id, char_length(m.id) + 2)
                          ELSE mp2.id
                        END
                      ) = cp->>'id'
                  ))
           ), 0)::int AS cnt
           FROM public.matters m
           WHERE m.tenant_id = $1
             AND m.client_id <> 'O-KEYDATE-STUB'
             AND NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL`,
          [ctx.tenantId, rel],
        );
        return Number(res.rows[0]?.cnt ?? 0);
      }
      if (cap && !rel) {
        const res = await tx.query<{ cnt: number }>(
          `SELECT COALESCE(SUM(
             (CASE WHEN m.client_id IS NOT NULL AND m.client_id <> ''
                        AND jsonb_typeof(m.fields_json->'clientCapacityCodes') = 'array'
                        AND (m.fields_json->'clientCapacityCodes') ? $2 THEN 1 ELSE 0 END)
             + (CASE WHEN jsonb_typeof(m.additional_client_ids_json) = 'array'
                          AND jsonb_typeof(m.fields_json->'jointClientCapacityCodes') = 'object'
                     THEN (
                       SELECT COUNT(*)::int
                       FROM jsonb_array_elements_text(m.additional_client_ids_json) jc_id
                       WHERE jsonb_typeof(m.fields_json->'jointClientCapacityCodes'->jc_id) = 'array'
                         AND (m.fields_json->'jointClientCapacityCodes'->jc_id) ? $2
                     )
                     ELSE 0 END)
             + (CASE WHEN m.instructing_contact_id IS NOT NULL AND m.instructing_contact_id <> ''
                          AND m.instructing_contact_id IS DISTINCT FROM m.client_id
                          AND (
                            CASE
                              WHEN jsonb_typeof(m.fields_json->'instructingContactCapacityCodes') = 'array'
                              THEN m.fields_json->'instructingContactCapacityCodes'
                              ELSE '["CAP_REPRESENTATIVE","CAP_DECISION_MAKER"]'::jsonb
                            END
                          ) ? $2 THEN 1 ELSE 0 END)
             + (SELECT COUNT(*)::int
                FROM public.matter_parties mp
                WHERE mp.tenant_id = m.tenant_id
                  AND mp.matter_id = m.id
                  AND (
                    (jsonb_typeof(mp.metadata_json->'capacityCodes') = 'array' AND (mp.metadata_json->'capacityCodes') ? $2)
                    OR (jsonb_typeof(mp.metadata_json->'capacityCodes') IS DISTINCT FROM 'array' AND mp.capacity_id = $2)
                  ))
             + (SELECT COUNT(*)::int
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(m.conflict_check_record_json->'parties') = 'array'
                    THEN m.conflict_check_record_json->'parties'
                    ELSE '[]'::jsonb
                  END
                ) cp
                WHERE COALESCE((cp->>'isClientFixed')::boolean, false) = false
                  AND jsonb_typeof(cp->'capacityCodes') = 'array'
                  AND (cp->'capacityCodes') ? $2
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.matter_parties mp2
                    WHERE mp2.tenant_id = m.tenant_id
                      AND mp2.matter_id = m.id
                      AND COALESCE(
                        mp2.metadata_json->>'id',
                        CASE
                          WHEN mp2.id LIKE m.id || ':%'
                          THEN substr(mp2.id, char_length(m.id) + 2)
                          ELSE mp2.id
                        END
                      ) = cp->>'id'
                  ))
           ), 0)::int AS cnt
           FROM public.matters m
           WHERE m.tenant_id = $1
             AND m.client_id <> 'O-KEYDATE-STUB'
             AND NULLIF(COALESCE(m.opening_record_json->>'mergedIntoId', ''), '') IS NULL`,
          [ctx.tenantId, cap],
        );
        return Number(res.rows[0]?.cnt ?? 0);
      }
      const res = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM public.matter_parties mp
         WHERE mp.tenant_id = $1
           AND COALESCE(mp.metadata_json->>'relationshipCode', mp.relationship_id) = $2
           AND (
             (jsonb_typeof(mp.metadata_json->'capacityCodes') = 'array' AND (mp.metadata_json->'capacityCodes') ? $3)
             OR (jsonb_typeof(mp.metadata_json->'capacityCodes') IS DISTINCT FROM 'array' AND mp.capacity_id = $3)
           )`,
        [ctx.tenantId, rel, cap],
      );
      return Number(res.rows[0]?.cnt ?? 0);
    });
  }

  public async listHiddenRestrictedMatterIds(
    ctx: TenantContext,
    viewerId: string,
    options?: { hasRestrictedMatterAccess?: boolean },
  ): Promise<string[]> {
    if (options?.hasRestrictedMatterAccess) {
      return [];
    }
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id
         FROM public.matters
         WHERE tenant_id = $1
           AND client_id <> 'O-KEYDATE-STUB'
           AND (
             is_staff_matter = TRUE
             OR has_ethical_wall = TRUE
             OR jsonb_array_length(COALESCE(restricted_access_user_ids_json, '[]'::jsonb)) > 0
           )
           AND NOT (restricted_access_user_ids_json ? $2)
         ORDER BY id ASC`,
        [ctx.tenantId, viewerId],
      );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'Matter');
        return r.id;
      });
    });
  }

  public async hasVisibleRestrictedMatterForViewer(
    ctx: TenantContext,
    viewerId: string,
    hasRestrictedMatterAccess = false,
  ): Promise<boolean> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string; id: string }>(
        hasRestrictedMatterAccess
          ? `SELECT tenant_id, id FROM public.matters
             WHERE tenant_id = $1
               AND client_id <> 'O-KEYDATE-STUB'
               AND is_staff_matter = TRUE
             LIMIT 1`
          : `SELECT tenant_id, id FROM public.matters
             WHERE tenant_id = $1
               AND client_id <> 'O-KEYDATE-STUB'
               AND is_staff_matter = TRUE
               AND restricted_access_user_ids_json ? $2
             LIMIT 1`,
        hasRestrictedMatterAccess ? [ctx.tenantId] : [ctx.tenantId, viewerId],
      );
      for (const r of res.rows) {
        this.assertRowTenant(ctx, r.tenant_id, 'Matter');
      }
      return res.rows.length > 0;
    });
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
          canViewCdd?: boolean;
        } = ctx.actorId,
  ): Promise<TMatter[]> {
    return this.listVisibleMatters<TMatter>(ctx, viewerOrOptions);
  }

  public async deleteMatterById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      // R752: Auto-withdraw any pending High-Risk opening approvals when a prospective matter is deleted/abandoned
      // (approved records are historical and never withdrawn).
      const pendingHroRes = await tx.query<{
        tenant_id: string;
        id: string;
        status: string;
      }>(
        `SELECT tenant_id, id, status
           FROM public.register_records
          WHERE tenant_id = $1
            AND matter_id = $2
            AND register_type_key = 'high_risk_opening'
            AND status IN ('pending_partner', 'pending_compliance')
            FOR UPDATE`,
        [ctx.tenantId, id],
      );
      if (pendingHroRes.rows.length > 0) {
        const nowIso = new Date().toISOString();
        const actorId = ctx.actorId || 'system';
        for (const hroRow of pendingHroRes.rows) {
          this.assertRowTenant(ctx, hroRow.tenant_id, 'RegisterRecord');
          await tx.query(
            `UPDATE public.register_records
                SET status = 'withdrawn',
                    decided_by_id = $3,
                    decided_at = $4::timestamptz,
                    updated_by_id = $3,
                    updated_at = $4::timestamptz,
                    row_version = row_version + 1
              WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, hroRow.id, actorId, nowIso],
          );
          const trSeqRes = await tx.query<{ max_num: string | null; next_val: string }>(
            `SELECT (
               SELECT MAX(substring(rt.id from '^RT-([0-9]+)$')::bigint)::text
                 FROM public.register_transitions rt
                WHERE rt.tenant_id = $1 AND rt.id ~ '^RT-[0-9]+$'
             ) AS max_num,
             nextval('public.tenant_register_transition_id_seq')::text AS next_val`,
            [ctx.tenantId],
          );
          const maxNum = Number(trSeqRes.rows[0]?.max_num ?? '0') || 0;
          const seqNum = Number(trSeqRes.rows[0]?.next_val ?? '1') || 1;
          const trId = `RT-${String(Math.max(maxNum + 1, seqNum)).padStart(6, '0')}`;
          await tx.query(
            `INSERT INTO public.register_transitions (
               tenant_id, id, register_record_id, register_type_key,
               transition_key, from_status, to_status, actor_id,
               comment, payload_json, correlation_id, transitioned_at
             ) VALUES (
               $1, $2, $3, 'high_risk_opening',
               'withdraw_opening', $4, 'withdrawn', $5,
               $6, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              ctx.tenantId,
              trId,
              hroRow.id,
              hroRow.status,
              actorId,
              'Withdrawn automatically when prospective matter was deleted.',
              JSON.stringify({ systemAction: 'deleteMatterById', matterId: id }),
              ctx.correlationId,
              nowIso,
            ],
          );
        }
      }

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
   * Advances `engagement_letter_status` to `'Drafted'` inside an existing tenant transaction when
   * generating a Client Care Letter (`B2`), refusing to regress `'Drafted'`, `'Sent'`,
   * `'Sent to client'`, `'Signed'`, `'Signed & returned'`, or already-sent/signed matters.
   */
  public async markEngagementLetterDraftedIfEligible<
    TMatter extends TenantMatterRecord = TenantMatterRecord,
  >(
    ctx: TenantContext,
    params: { matterId: string; updatedById: string },
  ): Promise<{
    matter: TMatter | null;
    updated: boolean;
    previousStatus: string;
  }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const selectRes = await tx.query<DbMatterRow>(
        `SELECT *
           FROM public.matters
          WHERE tenant_id = $1
            AND id = $2
            AND client_id <> 'O-KEYDATE-STUB'
            FOR UPDATE`,
        [ctx.tenantId, params.matterId],
      );
      const row = selectRes.rows[0];
      if (!row) {
        return { matter: null, updated: false, previousStatus: '' };
      }
      this.assertRowTenant(ctx, row.tenant_id, 'Matter');
      const partiesMap = await this.loadPartiesByMatterIdsInTx(tx, ctx, [
        row.id,
      ]);
      const parties = partiesMap.get(row.id) ?? [];
      const existing = mapMatterRow<TMatter>(row, parties);
      const previousStatus = existing.engagementLetterStatus ?? '';
      const protectedStatuses = new Set([
        'Drafted',
        'Sent',
        'Sent to client',
        'Signed',
        'Signed & returned',
      ]);
      if (
        protectedStatuses.has(previousStatus) ||
        Boolean(existing.engagementLetterSentAt) ||
        Boolean(existing.engagementLetterSignedAt)
      ) {
        return { matter: existing, updated: false, previousStatus };
      }

      const nowIso = new Date().toISOString();
      const updatedOpening = {
        ...((row.opening_record_json ?? {}) as Record<string, unknown>),
        updatedById: params.updatedById,
        updatedAt: nowIso,
      };
      const updateRes = await tx.query<DbMatterRow>(
        `UPDATE public.matters
            SET row_version = row_version + 1,
                engagement_letter_status = 'Drafted',
                updated_at = $3::timestamptz,
                opening_record_json = $4::jsonb
          WHERE tenant_id = $1
            AND id = $2
          RETURNING *`,
        [ctx.tenantId, params.matterId, nowIso, JSON.stringify(updatedOpening)],
      );
      const updatedRow = updateRes.rows[0]!;
      this.assertRowTenant(ctx, updatedRow.tenant_id, 'Matter');
      return {
        matter: mapMatterRow<TMatter>(updatedRow, parties),
        updated: true,
        previousStatus,
      };
    });
  }

  // ============================================================================
  // Opening Gate Overrides (`0026_opening_gate_overrides_and_numbering_expand`)
  // ============================================================================

  public async listOpeningGateOverridesForMatterInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    matterId: string,
    options?: { activeOnly?: boolean; forUpdate?: boolean },
  ): Promise<MatterOpeningGateOverrideRecord[]> {
    const activeClause = options?.activeOnly ? ' AND revoked_at IS NULL' : '';
    const lockClause = options?.forUpdate ? ' FOR UPDATE' : '';
    const res = await tx.query<DbMatterOpeningGateOverrideRow>(
      `SELECT tenant_id, id, matter_id, precondition_key, reason,
              overridden_by_person_id, overridden_at,
              revoked_by_person_id, revoked_at
         FROM public.matter_opening_gate_overrides
        WHERE tenant_id = $1 AND matter_id = $2${activeClause}
        ORDER BY overridden_at DESC, id DESC${lockClause}`,
      [ctx.tenantId, matterId],
    );
    return res.rows.map((row) => {
      this.assertRowTenant(ctx, row.tenant_id, 'MatterOpeningGateOverride');
      return mapOpeningGateOverrideRow(row);
    });
  }

  public async listOpeningGateOverridesForMatter(
    ctx: TenantContext,
    matterId: string,
    options?: { activeOnly?: boolean },
  ): Promise<MatterOpeningGateOverrideRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) =>
      this.listOpeningGateOverridesForMatterInTx(tx, ctx, matterId, options),
    );
  }

  public async insertOpeningGateOverrideInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      matterId: string;
      preconditionKey: OpeningGatePreconditionKey;
      reason: string;
      overriddenByPersonId: string;
      overriddenAtIso?: string;
    },
  ): Promise<MatterOpeningGateOverrideRecord> {
    const cleanReason = input.reason?.trim() ?? '';
    if (cleanReason.length < 10) {
      throw new Error(
        'OPENING_GATE_OVERRIDE_VALIDATION_ERROR: An opening gate override requires a reason of at least 10 characters.',
      );
    }
    const seqRes = await tx.query<{ seq_val: string | number }>(
      "SELECT nextval('public.tenant_opening_override_id_seq')::bigint AS seq_val",
    );
    const seqNum = Number(seqRes.rows[0]?.seq_val ?? 1);
    const id = `OVR-${String(seqNum).padStart(6, '0')}`;
    const overriddenAtIso = safePgTimestampIso(input.overriddenAtIso);
    const res = await tx.query<DbMatterOpeningGateOverrideRow>(
      `INSERT INTO public.matter_opening_gate_overrides (
         tenant_id, id, matter_id, precondition_key, reason,
         overridden_by_person_id, overridden_at, revoked_by_person_id, revoked_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::timestamptz, NULL, NULL
       )
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        input.matterId,
        input.preconditionKey,
        cleanReason,
        input.overriddenByPersonId,
        overriddenAtIso,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Could not insert opening gate override row.',
      );
    }
    this.assertRowTenant(ctx, row.tenant_id, 'MatterOpeningGateOverride');
    return mapOpeningGateOverrideRow(row);
  }

  public async insertOpeningGateOverride(
    ctx: TenantContext,
    input: {
      matterId: string;
      preconditionKey: OpeningGatePreconditionKey;
      reason: string;
      overriddenByPersonId: string;
      overriddenAtIso?: string;
    },
  ): Promise<MatterOpeningGateOverrideRecord> {
    return this.withTenantTransaction(ctx, async (tx) =>
      this.insertOpeningGateOverrideInTx(tx, ctx, input),
    );
  }

  public async revokeOpeningGateOverrideInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      overrideId: string;
      matterId: string;
      revokedByPersonId: string;
      revokedAtIso?: string;
    },
  ): Promise<MatterOpeningGateOverrideRecord | null> {
    const revokedAtIso = safePgTimestampIso(params.revokedAtIso);
    const res = await tx.query<DbMatterOpeningGateOverrideRow>(
      `UPDATE public.matter_opening_gate_overrides
          SET revoked_by_person_id = $4,
              revoked_at = $5::timestamptz
        WHERE tenant_id = $1
          AND id = $2
          AND matter_id = $3
          AND revoked_at IS NULL
        RETURNING *`,
      [
        ctx.tenantId,
        params.overrideId,
        params.matterId,
        params.revokedByPersonId,
        revokedAtIso,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    this.assertRowTenant(ctx, row.tenant_id, 'MatterOpeningGateOverride');
    return mapOpeningGateOverrideRow(row);
  }

  public async revokeOpeningGateOverride(
    ctx: TenantContext,
    params: {
      overrideId: string;
      matterId: string;
      revokedByPersonId: string;
      revokedAtIso?: string;
    },
  ): Promise<MatterOpeningGateOverrideRecord | null> {
    return this.withTenantTransaction(ctx, async (tx) =>
      this.revokeOpeningGateOverrideInTx(tx, ctx, params),
    );
  }

  /**
   * Clears `matter_opening_gate_overrides`, `matter_parties`, and `matters` for `ctx.tenantId`.
   * Preserves `matter_number_sequences` by default (`B6`) so matter numbers never go backwards
   * across matter deletions or `resetAllDemoData` demo resets.
   */
  public async clearTenantData(
    ctx: TenantContext,
    options?: { resetMatterNumberSequences?: boolean },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.matter_opening_gate_overrides WHERE tenant_id = $1',
        [ctx.tenantId],
      );
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
