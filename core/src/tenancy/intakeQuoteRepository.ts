/**
 * Tenant-Scoped Intake & Quote Repository (`core/src/tenancy/intakeQuoteRepository.ts`).
 *
 * Enforces ADR 0028 & Platform Architecture Standard §§4, 7, 8 (`R401`, `R402`, `R403`, `S0-17a`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes
 *    inside an explicit transaction after `SET LOCAL ROLE "<role_tenant_slug_env>"`.
 * 2. Every query predicates on `tenant_id = $1` bound from verified `TenantContext.tenantId`,
 *    and every returned row is verified via `this.assertRowTenant(row, ctx)`.
 * 3. Data-layer visibility filtering hides:
 *    - Personal `Draft` enquiries belonging to another user (`created_by_id <> viewerId AND taken_by_id <> viewerId`).
 *    - Enquiries and quotes converted into (`converted_matter_id`) or referenced by (`matters.source_enquiry_id`,
 *      `matters.source_quote_id`) a restricted staff or ethical-wall matter unless `viewerId` is in
 *      `matters.restricted_access_user_ids_json` or `includeRestricted: true` is explicitly passed.
 *    - Quotes linked (`source_enquiry_id`) to an enquiry that is hidden from `viewerId`.
 * 4. Sequence allocation (`ENQ-`, `QTE-`, `QTE-YYYY-NNNN`) uses `tenant_enquiry_id_seq`,
 *    `tenant_quote_id_seq`, `tenant_record_sequences`, and `quote_reference_sequences` without `setval` (`R460`).
 */

import type {
  FirmAuditEntryInput as AppendTenantAuditEntryInput,
  TenantContext,
} from '../api/index';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  type TenantSqlClient,
} from './tenantScopedRepository';
import { TenantAuditRepository } from './auditRepository';
export interface TenantEnquiryAddressRecord {
  id: string;
  typeId: string | null;
  line1: string;
  line2: string;
  town: string;
  county: string;
  postcode: string;
  countryId: string | null;
}

export type TenantContactLogMethod =
  | 'Phone'
  | 'In person'
  | 'Video call'
  | 'Call'
  | 'Email'
  | 'Voicemail'
  | 'Meeting'
  | 'Video';

export type TenantContactLogOutcome =
  | 'Spoke'
  | 'Left Message'
  | 'Left Voicemail'
  | 'No answer'
  | 'Left message'
  | 'Voicemail left'
  | 'Email sent'
  | 'Sent email'
  | 'Meeting';

export interface TenantEnquiryConflictSnapshotHitRecord {
  recordId: string;
  recordType: 'person' | 'organisation' | 'matter';
  name: string;
  recordLabel: string;
  queryTerm: string;
  href: string;
  reason: string;
  matchedFields: string[];
  severity: 'high' | 'medium' | 'low';
  strength: number;
  blocking: boolean;
}

export interface TenantEnquiryConflictSnapshotRecord {
  recordedAt: string;
  recordedById: string;
  searchedInput: {
    firstName: string;
    lastName: string;
    callingOnBehalfOf: string;
    otherPartiesNamed: string;
    email: string;
    phone: string;
    postcode: string;
    addressLine1: string;
    addressLine2: string;
    searchedSources?: string[];
  };
  matchCount: number;
  highestSeverity: 'high' | 'medium' | 'low' | 'none';
  conflictStatus: 'Not checked' | 'Clear' | 'Check' | 'Possible conflict';
  conflicts: TenantEnquiryConflictSnapshotHitRecord[];
  knownPeople: { id: string; formattedReasons: string }[];
  knownOrganisations: { id: string; formattedReasons: string }[];
}

export interface TenantConflictDecisionRecord {
  outcome: 'Cleared' | 'Potential conflict' | 'Conflict – declined';
  decidedById: string;
  decidedByName: string;
  decidedAt: string;
  sourceRecordId: string;
  matchesCount: number;
  searchedSources: string[];
  summary: string;
  warnings?: string[];
}

export interface TenantEnquiryRecord {
  id: string;
  reference: string;
  receivedAt: string;
  takenById: string;
  channelId: string;
  firstName: string;
  lastName: string;
  callingOnBehalfOf: string;
  linkedOrganisationId: string | null;
  email: string;
  phone: string;
  preferredContactMethodId: string | null;
  bestTimeToCall: string;
  address: TenantEnquiryAddressRecord | null;
  practiceAreaId: string;
  workTypeSubcategoryId: string | null;
  summary: string;
  notes: string;
  initialNotes?: string;
  otherPartiesNamed: string;
  urgencyId: string;
  keyDate: string | null;
  keyDateLabel: string;
  keyDates?: string;
  estimatedValueGbp?: number;
  fundingBasisId?: string;
  otherParties?: unknown[];
  conflictStatusId?: string;
  conflictNotes?: string;
  sourceId: string | null;
  referrerPersonId: string | null;
  marketingCampaign?: string;
  privacyNoticeGiven: boolean;
  status:
    | 'Draft'
    | 'New'
    | 'Assigned'
    | 'In contact'
    | 'Converted'
    | 'Declined'
    | 'Referred out'
    | 'No response';
  assignedTeamId: string | null;
  routedToIntakeFallback?: boolean;
  assignedToId: string | null;
  firstContactDueAt: string | null;
  firstContactMadeAt?: string | null;
  nextActionDate: string | null;
  conflictStatus?: 'Not checked' | 'Clear' | 'Check' | 'Possible conflict';
  contactLog: Array<{
    id: string;
    at: string;
    method: TenantContactLogMethod;
    outcome: TenantContactLogOutcome;
    note: string;
    byId: string;
  }>;
  closeReasonId: string | null;
  referredToOrganisationId: string | null;
  referredToName?: string;
  closeNote?: string;
  closeNotes?: string;
  closedAt?: string | null;
  closedById?: string | null;
  nonEngagementLetterTaskId?: string | null;
  convertedMatterId: string | null;
  linkedPersonId: string | null;
  retentionUntil?: string | null;
  conflictSnapshot?: TenantEnquiryConflictSnapshotRecord | null;
  conflictDecision?: TenantConflictDecisionRecord | null;
  customFields?: Record<string, unknown>;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
  anonymisedAt?: string | null;
}

export interface TenantQuoteDisbursementRecord {
  id: string;
  description: string;
  amountExVat: number;
  vatApplicable: boolean;
}

export interface TenantQuoteVersionSnapshotRecord {
  version: number;
  status: 'Superseded';
  feeBasis: 'Fixed fee' | 'Estimate' | 'Capped fee' | 'Hourly rate with estimate';
  feeAmountExVat: number;
  hourlyRateGbp: number | null;
  vatAmount: number;
  disbursements: TenantQuoteDisbursementRecord[];
  totalIncVat: number;
  scope: string;
  assumptions: string;
  validUntil: string;
  createdAt: string;
  sentAt: string | null;
  supersededAt: string;
  byId: string;
  revisionNote?: string;
}

export interface TenantQuoteTimelineEventRecord {
  id: string;
  kind:
    | 'created'
    | 'sent'
    | 'follow_up'
    | 'revised'
    | 'accepted'
    | 'declined'
    | 'expired'
    | 'converted';
  at: string;
  byId: string | null;
  title: string;
  detail?: string;
}

export interface TenantQuoteRecord {
  id: string;
  reference: string;
  version: number;
  status: string;
  clientType: 'existing' | 'prospect';
  linkedOrganisationId: string | null;
  linkedPersonId: string | null;
  prospectName: string;
  prospectOrganisationName: string;
  prospectEmail: string;
  prospectPhone: string;
  linkedEnquiryId: string | null;
  convertedMatterId: string | null;
  practiceAreaId: string;
  workTypeSubcategoryId: string | null;
  scope: string;
  assumptions: string;
  feeBasis: string;
  feeAmountExVat: number;
  hourlyRateGbp: number | null;
  vatAmount: number;
  vatOverridden?: boolean;
  disbursements: TenantQuoteDisbursementRecord[];
  totalIncVat: number;
  feeEarnerId: string;
  assignedTeamId: string | null;
  validUntil: string;
  followUpAfterDays: number;
  sentAt: string | null;
  nextFollowUpDate: string | null;
  outcomeAt: string | null;
  outcomeNote?: string;
  declineReason: string | null;
  declineNote?: string;
  conflictDecision?: TenantConflictDecisionRecord | null;
  followUps: Array<{
    id: string;
    at: string;
    method: TenantContactLogMethod;
    note: string;
    nextFollowUpDate: string | null;
    byId: string;
  }>;
  versionHistory: TenantQuoteVersionSnapshotRecord[];
  timeline: TenantQuoteTimelineEventRecord[];
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

interface EnquiryRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  reference: string;
  status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  calling_on_behalf_of: string | null;
  organisation_name: string | null;
  channel_id: string | null;
  practice_area_id: string | null;
  work_type_subcategory_id: string | null;
  urgency_id: string | null;
  assigned_team_id: string | null;
  assigned_to_id: string | null;
  taken_by_id: string | null;
  created_by_id: string | null;
  updated_by_id: string | null;
  linked_person_id: string | null;
  linked_organisation_id: string | null;
  referrer_person_id: string | null;
  referred_to_organisation_id: string | null;
  converted_matter_id: string | null;
  close_reason_id: string | null;
  privacy_notice_given: boolean;
  received_at: Date | string;
  first_contact_due_at: Date | string | null;
  closed_at: Date | string | null;
  anonymised_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  summary_and_notes_json: Record<string, unknown> | null;
  contact_log_json: Array<Record<string, unknown>> | null;
  conflict_snapshot_json: Record<string, unknown> | null;
  key_dates_json: unknown;
  custom_fields_json: Record<string, string | number | boolean | string[] | null> | null;
  profile_json: Record<string, unknown> | null;
}

interface QuoteRow extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  quote_reference: string;
  version: number;
  status: string;
  fee_basis: string;
  client_type: string | null;
  client_person_id: string | null;
  client_organisation_id: string | null;
  prospect_name: string | null;
  source_enquiry_id: string | null;
  converted_matter_id: string | null;
  practice_area_id: string | null;
  work_type_subcategory_id: string | null;
  prepared_by_id: string | null;
  assigned_team_id: string | null;
  fee_total_ex_vat_gbp: string | number;
  total_inc_vat_gbp: string | number;
  payment_on_account_gbp: string | number | null;
  valid_until: string | null;
  sent_at: Date | string | null;
  outcome_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  pricing_breakdown_json: Record<string, unknown> | null;
  follow_ups_json: Array<Record<string, unknown>> | null;
  version_history_json: Array<Record<string, unknown>> | null;
  conflict_decision_json: Record<string, unknown> | null;
  custom_fields_json: Record<string, unknown> | null;
  profile_json: Record<string, unknown> | null;
}

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toNullableIsoString(
  value: Date | string | null | undefined,
  fallback?: string | null,
): string | null {
  if (fallback !== undefined && fallback !== null) {
    return fallback;
  }
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function createIntakeQuoteError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

function mapRowToEnquiry(row: EnquiryRow): TenantEnquiryRecord {
  const profile =
    row.profile_json && typeof row.profile_json === 'object'
      ? (structuredClone(row.profile_json) as Partial<TenantEnquiryRecord>)
      : {};
  const summaryNotes =
    row.summary_and_notes_json && typeof row.summary_and_notes_json === 'object'
      ? row.summary_and_notes_json
      : {};
  const contactLog = Array.isArray(row.contact_log_json)
    ? (structuredClone(row.contact_log_json) as Array<Record<string, unknown>>)
    : Array.isArray(profile.contactLog)
      ? structuredClone(profile.contactLog)
      : [];
  const customFields =
    row.custom_fields_json && typeof row.custom_fields_json === 'object'
      ? structuredClone(row.custom_fields_json)
      : (profile.customFields ?? {});

  const conflictSnapshot =
    row.conflict_snapshot_json && typeof row.conflict_snapshot_json === 'object'
      ? (structuredClone(
          row.conflict_snapshot_json,
        ) as unknown as TenantEnquiryRecord['conflictSnapshot'])
      : profile.conflictSnapshot;

  return {
    ...profile,
    id: row.id,
    reference: row.reference || profile.reference || row.id,
    receivedAt:
      typeof profile.receivedAt === 'string' && profile.receivedAt
        ? profile.receivedAt
        : toIsoString(row.received_at),
    takenById: row.taken_by_id ?? profile.takenById ?? '',
    channelId: row.channel_id ?? profile.channelId ?? '',
    firstName: row.first_name ?? profile.firstName ?? '',
    lastName: row.last_name ?? profile.lastName ?? '',
    callingOnBehalfOf: row.calling_on_behalf_of ?? profile.callingOnBehalfOf ?? '',
    linkedOrganisationId:
      row.linked_organisation_id !== undefined
        ? row.linked_organisation_id
        : (profile.linkedOrganisationId ?? null),
    email: row.email ?? profile.email ?? '',
    phone: row.phone ?? profile.phone ?? '',
    preferredContactMethodId: profile.preferredContactMethodId ?? null,
    bestTimeToCall: profile.bestTimeToCall ?? '',
    address: profile.address !== undefined ? profile.address : null,
    practiceAreaId: row.practice_area_id ?? profile.practiceAreaId ?? '',
    workTypeSubcategoryId:
      row.work_type_subcategory_id !== undefined
        ? row.work_type_subcategory_id
        : (profile.workTypeSubcategoryId ?? null),
    summary:
      typeof summaryNotes.summary === 'string'
        ? summaryNotes.summary
        : (profile.summary ?? ''),
    notes:
      typeof summaryNotes.notes === 'string'
        ? summaryNotes.notes
        : (profile.notes ?? ''),
    otherPartiesNamed:
      typeof summaryNotes.otherPartiesNamed === 'string'
        ? summaryNotes.otherPartiesNamed
        : (profile.otherPartiesNamed ?? ''),
    urgencyId: row.urgency_id ?? profile.urgencyId ?? '',
    keyDate: profile.keyDate ?? null,
    keyDateLabel: profile.keyDateLabel ?? '',
    sourceId: profile.sourceId ?? null,
    referrerPersonId:
      row.referrer_person_id !== undefined
        ? row.referrer_person_id
        : (profile.referrerPersonId ?? null),
    privacyNoticeGiven: Boolean(row.privacy_notice_given),
    status: (row.status || profile.status || 'New') as TenantEnquiryRecord['status'],
    assignedTeamId:
      row.assigned_team_id !== undefined
        ? row.assigned_team_id
        : (profile.assignedTeamId ?? null),
    assignedToId:
      row.assigned_to_id !== undefined
        ? row.assigned_to_id
        : (profile.assignedToId ?? null),
    firstContactDueAt: toNullableIsoString(
      row.first_contact_due_at,
      profile.firstContactDueAt,
    ),
    firstContactMadeAt: profile.firstContactMadeAt ?? null,
    nextActionDate: profile.nextActionDate ?? null,
    contactLog: contactLog as TenantEnquiryRecord['contactLog'],
    closeReasonId:
      row.close_reason_id !== undefined
        ? row.close_reason_id
        : (profile.closeReasonId ?? null),
    referredToOrganisationId:
      row.referred_to_organisation_id !== undefined
        ? row.referred_to_organisation_id
        : (profile.referredToOrganisationId ?? null),
    closeNote:
      typeof summaryNotes.closeNote === 'string'
        ? summaryNotes.closeNote
        : (profile.closeNote ?? ''),
    closedAt: toNullableIsoString(row.closed_at, profile.closedAt),
    closedById: profile.closedById ?? null,
    nonEngagementLetterTaskId: profile.nonEngagementLetterTaskId ?? null,
    convertedMatterId:
      row.converted_matter_id !== undefined
        ? row.converted_matter_id
        : (profile.convertedMatterId ?? null),
    linkedPersonId:
      row.linked_person_id !== undefined
        ? row.linked_person_id
        : (profile.linkedPersonId ?? null),
    ...(conflictSnapshot !== undefined ? { conflictSnapshot } : {}),
    ...(profile.conflictDecision !== undefined
      ? { conflictDecision: structuredClone(profile.conflictDecision) }
      : {}),
    customFields,
    createdById: row.created_by_id ?? profile.createdById ?? '',
    createdAt:
      typeof profile.createdAt === 'string' && profile.createdAt
        ? profile.createdAt
        : toIsoString(row.created_at),
    updatedById: row.updated_by_id ?? profile.updatedById ?? '',
    updatedAt:
      typeof profile.updatedAt === 'string' && profile.updatedAt
        ? profile.updatedAt
        : toIsoString(row.updated_at),
    anonymisedAt:
      row.anonymised_at !== null && row.anonymised_at !== undefined
        ? toIsoString(row.anonymised_at)
        : (profile.anonymisedAt ?? null),
  };
}

function mapRowToQuote(row: QuoteRow): TenantQuoteRecord {
  const profile =
    row.profile_json && typeof row.profile_json === 'object'
      ? (structuredClone(row.profile_json) as Partial<TenantQuoteRecord>)
      : {};
  const pricing =
    row.pricing_breakdown_json && typeof row.pricing_breakdown_json === 'object'
      ? row.pricing_breakdown_json
      : {};
  const followUps = Array.isArray(row.follow_ups_json)
    ? (structuredClone(row.follow_ups_json) as Array<Record<string, unknown>>)
    : Array.isArray(profile.followUps)
      ? structuredClone(profile.followUps)
      : [];
  const versionHistory = Array.isArray(row.version_history_json)
    ? (structuredClone(row.version_history_json) as Array<Record<string, unknown>>)
    : Array.isArray(profile.versionHistory)
      ? structuredClone(profile.versionHistory)
      : [];
  const conflictDecision =
    row.conflict_decision_json && typeof row.conflict_decision_json === 'object'
      ? structuredClone(row.conflict_decision_json)
      : profile.conflictDecision;

  return {
    ...profile,
    id: row.id,
    reference: row.quote_reference || profile.reference || row.id,
    version: Number(row.version ?? profile.version ?? 1),
    status: row.status || profile.status || 'Draft',
    clientType:
      row.client_type === 'existing' || row.client_type === 'prospect'
        ? row.client_type
        : (profile.clientType ?? 'prospect'),
    linkedOrganisationId:
      row.client_organisation_id !== undefined
        ? row.client_organisation_id
        : (profile.linkedOrganisationId ?? null),
    linkedPersonId:
      row.client_person_id !== undefined
        ? row.client_person_id
        : (profile.linkedPersonId ?? null),
    prospectName: row.prospect_name ?? profile.prospectName ?? '',
    prospectOrganisationName: profile.prospectOrganisationName ?? '',
    prospectEmail: profile.prospectEmail ?? '',
    prospectPhone: profile.prospectPhone ?? '',
    linkedEnquiryId:
      row.source_enquiry_id !== undefined
        ? row.source_enquiry_id
        : (profile.linkedEnquiryId ?? null),
    convertedMatterId:
      row.converted_matter_id !== undefined
        ? row.converted_matter_id
        : (profile.convertedMatterId ?? null),
    practiceAreaId: row.practice_area_id ?? profile.practiceAreaId ?? '',
    workTypeSubcategoryId:
      row.work_type_subcategory_id !== undefined
        ? row.work_type_subcategory_id
        : (profile.workTypeSubcategoryId ?? null),
    scope:
      typeof pricing.scope === 'string' ? pricing.scope : (profile.scope ?? ''),
    assumptions:
      typeof pricing.assumptions === 'string'
        ? pricing.assumptions
        : (profile.assumptions ?? ''),
    feeBasis: row.fee_basis || profile.feeBasis || 'Fixed fee',
    feeAmountExVat: Number(
      row.fee_total_ex_vat_gbp ?? profile.feeAmountExVat ?? 0,
    ),
    hourlyRateGbp:
      pricing.hourlyRateGbp !== undefined
        ? (pricing.hourlyRateGbp as number | null)
        : (profile.hourlyRateGbp ?? null),
    vatAmount: Number(pricing.vatAmount ?? profile.vatAmount ?? 0),
    vatOverridden: Boolean(pricing.vatOverridden ?? profile.vatOverridden ?? false),
    disbursements: Array.isArray(pricing.disbursements)
      ? (structuredClone(
          pricing.disbursements,
        ) as TenantQuoteDisbursementRecord[])
      : Array.isArray(profile.disbursements)
        ? structuredClone(profile.disbursements)
        : [],
    totalIncVat: Number(row.total_inc_vat_gbp ?? profile.totalIncVat ?? 0),
    feeEarnerId: row.prepared_by_id ?? profile.feeEarnerId ?? '',
    assignedTeamId:
      row.assigned_team_id !== undefined
        ? row.assigned_team_id
        : (profile.assignedTeamId ?? null),
    validUntil: row.valid_until ?? profile.validUntil ?? '',
    followUpAfterDays: Number(profile.followUpAfterDays ?? 7),
    sentAt: toNullableIsoString(row.sent_at, profile.sentAt),
    nextFollowUpDate: profile.nextFollowUpDate ?? null,
    outcomeAt: toNullableIsoString(row.outcome_at, profile.outcomeAt),
    ...(profile.outcomeNote !== undefined
      ? { outcomeNote: profile.outcomeNote }
      : {}),
    declineReason: profile.declineReason ?? null,
    ...(profile.declineNote !== undefined
      ? { declineNote: profile.declineNote }
      : {}),
    ...(conflictDecision !== undefined
      ? { conflictDecision: conflictDecision as TenantQuoteRecord['conflictDecision'] }
      : {}),
    followUps: followUps as TenantQuoteRecord['followUps'],
    versionHistory: versionHistory as TenantQuoteRecord['versionHistory'],
    timeline: Array.isArray(profile.timeline)
      ? structuredClone(profile.timeline)
      : [],
    createdById: profile.createdById ?? row.prepared_by_id ?? '',
    createdAt:
      typeof profile.createdAt === 'string' && profile.createdAt
        ? profile.createdAt
        : toIsoString(row.created_at),
    updatedById: profile.updatedById ?? row.prepared_by_id ?? '',
    updatedAt:
      typeof profile.updatedAt === 'string' && profile.updatedAt
        ? profile.updatedAt
        : toIsoString(row.updated_at),
  };
}

/**
 * SQL predicate returning TRUE when an enquiry row `e` (`e.tenant_id = $1`) is visible to `viewerId` (`$2`).
 * - Personal `Draft` enquiries are visible only to `created_by_id = $2` or `taken_by_id = $2`.
 * - Any enquiry converted into or referenced by (`matters.source_enquiry_id`) a restricted staff or
 *   ethical-wall matter is hidden unless `$2` is listed in `matters.restricted_access_user_ids_json`.
 */
export const ENQUIRY_VISIBLE_SQL_PREDICATE = `(
  (e.status <> 'Draft' OR COALESCE(e.created_by_id, '') = $2 OR COALESCE(e.taken_by_id, '') = $2)
  AND NOT EXISTS (
    SELECT 1 FROM matters m
    WHERE m.tenant_id = e.tenant_id
      AND (m.id = e.converted_matter_id OR m.source_enquiry_id = e.id)
      AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
      AND NOT (m.restricted_access_user_ids_json ? $2)
  )
)`;

/**
 * SQL predicate returning TRUE when a quote row `q` (`q.tenant_id = $1`) is visible to `viewerId` (`$2`).
 * - Any quote converted into or referenced by (`matters.source_quote_id`) a restricted matter is hidden
 *   unless `$2` is in `matters.restricted_access_user_ids_json`.
 * - Any quote linked (`q.source_enquiry_id`) to an enquiry that is hidden from `$2` is also hidden.
 */
export const QUOTE_VISIBLE_SQL_PREDICATE = `(
  NOT EXISTS (
    SELECT 1 FROM matters m
    WHERE m.tenant_id = q.tenant_id
      AND (m.id = q.converted_matter_id OR m.source_quote_id = q.id)
      AND (m.is_staff_matter = TRUE OR m.has_ethical_wall = TRUE)
      AND NOT (m.restricted_access_user_ids_json ? $2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM enquiries e
    WHERE e.tenant_id = q.tenant_id
      AND e.id = q.source_enquiry_id
      AND NOT ${ENQUIRY_VISIBLE_SQL_PREDICATE}
  )
)`;

export class TenantIntakeQuoteRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(options?: {
    poolManager?: TenantPostgresPoolManager;
    requiredSchemaVersion?: string;
    statementTimeoutMs?: number;
  }) {
    super(options);
    this.auditRepo = new TenantAuditRepository(options);
  }

  private async listHiddenRestrictedMatterIdsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    viewerId: string,
  ): Promise<Set<string>> {
    const res = await tx.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id
       FROM matters
       WHERE tenant_id = $1
         AND (is_staff_matter = TRUE OR has_ethical_wall = TRUE)
         AND NOT (restricted_access_user_ids_json ? $2)`,
      [ctx.tenantId, viewerId],
    );
    const ids = new Set<string>();
    for (const row of res.rows) {
      this.assertRowTenant(ctx, row.tenant_id, 'matters.restricted_check');
      ids.add(row.id);
    }
    return ids;
  }

  private sanitizeEnquiryConflictSnapshotForViewer(
    enquiry: TenantEnquiryRecord,
    hiddenMatterIds: ReadonlySet<string>,
  ): TenantEnquiryRecord {
    if (
      !enquiry.conflictSnapshot?.conflicts?.length ||
      hiddenMatterIds.size === 0
    ) {
      return enquiry;
    }
    const filteredConflicts = enquiry.conflictSnapshot.conflicts.filter(
      (c: { recordType?: string; recordId: string }) =>
        !(c.recordType === 'matter' && hiddenMatterIds.has(c.recordId)),
    );
    if (filteredConflicts.length === enquiry.conflictSnapshot.conflicts.length) {
      return enquiry;
    }
    return {
      ...enquiry,
      conflictSnapshot: {
        ...enquiry.conflictSnapshot,
        conflicts: filteredConflicts,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Sequence Allocation (`ENQ-`, `QTE-`, `QTE-YYYY-NNNN`, `R460`)
  // ---------------------------------------------------------------------------

  public async allocateNextEnquiryIds(
    ctx: TenantContext,
    count: number,
    options?: { padDigits?: number },
  ): Promise<string[]> {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount === 0) {
      return [];
    }
    const padDigits = options?.padDigits ?? 6;
    return this.withTenantTransaction(ctx, async (tx) => {
      const results: string[] = [];
      for (let i = 0; i < safeCount; i++) {
        const res = await tx.query<{ tenant_id: string; last_value: string }>(
          `WITH seq AS (
             SELECT nextval('tenant_enquiry_id_seq') AS val
           ),
           max_existing AS (
             SELECT COALESCE(
               MAX(SUBSTRING(id FROM '^ENQ-([0-9]+)$')::bigint),
               0
             ) AS max_id
             FROM enquiries
             WHERE tenant_id = $1 AND id ~ '^ENQ-[0-9]+$'
           )
           INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value)
           SELECT $1, 'ENQ', GREATEST((SELECT val FROM seq), (SELECT max_id FROM max_existing) + 1)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE
             SET last_value = GREATEST(
               tenant_record_sequences.last_value + 1,
               EXCLUDED.last_value,
               (SELECT max_id FROM max_existing) + 1
             )
           RETURNING tenant_id, last_value::text AS last_value`,
          [ctx.tenantId],
        );
        const row = res.rows[0];
        if (!row) {
          throw createIntakeQuoteError(
            'INTAKE_SEQUENCE_ERROR',
            'Failed to allocate next enquiry ID.',
          );
        }
        this.assertRowTenant(ctx, row.tenant_id, 'tenant_record_sequences.ENQ');
        results.push(`ENQ-${String(Number(row.last_value)).padStart(padDigits, '0')}`);
      }
      return results;
    });
  }

  public async allocateNextEnquiryId(
    ctx: TenantContext,
    options?: { padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextEnquiryIds(ctx, 1, options);
    return id!;
  }

  public async allocateNextQuoteIds(
    ctx: TenantContext,
    count: number,
    options?: { padDigits?: number },
  ): Promise<string[]> {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount === 0) {
      return [];
    }
    const padDigits = options?.padDigits ?? 6;
    return this.withTenantTransaction(ctx, async (tx) => {
      const results: string[] = [];
      for (let i = 0; i < safeCount; i++) {
        const res = await tx.query<{ tenant_id: string; last_value: string }>(
          `WITH seq AS (
             SELECT nextval('tenant_quote_id_seq') AS val
           ),
           max_existing AS (
             SELECT COALESCE(
               MAX(SUBSTRING(id FROM '^QTE-([0-9]+)$')::bigint),
               0
             ) AS max_id
             FROM quotes
             WHERE tenant_id = $1 AND id ~ '^QTE-[0-9]+$'
           )
           INSERT INTO tenant_record_sequences (tenant_id, counter_key, last_value)
           SELECT $1, 'QTE', GREATEST((SELECT val FROM seq), (SELECT max_id FROM max_existing) + 1)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE
             SET last_value = GREATEST(
               tenant_record_sequences.last_value + 1,
               EXCLUDED.last_value,
               (SELECT max_id FROM max_existing) + 1
             )
           RETURNING tenant_id, last_value::text AS last_value`,
          [ctx.tenantId],
        );
        const row = res.rows[0];
        if (!row) {
          throw createIntakeQuoteError(
            'QUOTE_SEQUENCE_ERROR',
            'Failed to allocate next quote ID.',
          );
        }
        this.assertRowTenant(ctx, row.tenant_id, 'tenant_record_sequences.QTE');
        results.push(`QTE-${String(Number(row.last_value)).padStart(padDigits, '0')}`);
      }
      return results;
    });
  }

  public async allocateNextQuoteId(
    ctx: TenantContext,
    options?: { padDigits?: number },
  ): Promise<string> {
    const [id] = await this.allocateNextQuoteIds(ctx, 1, options);
    return id!;
  }

  public async allocateNextQuoteReferences(
    ctx: TenantContext,
    year: number,
    count: number,
  ): Promise<string[]> {
    const safeYear = Math.floor(year);
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount === 0) {
      return [];
    }
    const pattern = `^QTE-${safeYear}-([0-9]+)$`;
    return this.withTenantTransaction(ctx, async (tx) => {
      const results: string[] = [];
      for (let i = 0; i < safeCount; i++) {
        const res = await tx.query<{ tenant_id: string; last_number: string }>(
          `WITH seq AS (
             SELECT nextval('tenant_quote_id_seq') AS val
           ),
           max_existing AS (
             SELECT COALESCE(
               MAX(SUBSTRING(quote_reference FROM $3)::bigint),
               0
             ) AS max_num
             FROM quotes
             WHERE tenant_id = $1 AND quote_reference ~ $3
           )
           INSERT INTO quote_reference_sequences (tenant_id, year, last_number, updated_at)
           SELECT $1, $2, GREATEST(1, (SELECT max_num FROM max_existing) + 1), NOW()
           ON CONFLICT (tenant_id, year) DO UPDATE
             SET last_number = GREATEST(
               quote_reference_sequences.last_number + 1,
               (SELECT max_num FROM max_existing) + 1
             ),
             updated_at = NOW()
           RETURNING tenant_id, last_number::text AS last_number`,
          [ctx.tenantId, safeYear, pattern],
        );
        const row = res.rows[0];
        if (!row) {
          throw createIntakeQuoteError(
            'QUOTE_SEQUENCE_ERROR',
            'Failed to allocate next quote reference.',
          );
        }
        this.assertRowTenant(ctx, row.tenant_id, 'quote_reference_sequences');
        results.push(
          `QTE-${safeYear}-${String(Number(row.last_number)).padStart(4, '0')}`,
        );
      }
      return results;
    });
  }

  public async allocateNextQuoteReference(
    ctx: TenantContext,
    year = new Date().getUTCFullYear(),
  ): Promise<string> {
    const [ref] = await this.allocateNextQuoteReferences(ctx, year, 1);
    return ref!;
  }

  // ---------------------------------------------------------------------------
  // Enquiries CRUD & Queries
  // ---------------------------------------------------------------------------

  public async upsertEnquiryInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    enquiry: TenantEnquiryRecord,
  ): Promise<void> {
    if (!enquiry?.id?.trim()) {
      throw createIntakeQuoteError('INTAKE_VALIDATION_ERROR', 'Enquiry id is required.');
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM enquiries WHERE id = $1`,
      [enquiry.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        throw createIntakeQuoteError(
          'TENANCY_CROSS_TENANT_RECORD_ACCESS',
          `Enquiry "${enquiry.id}" belongs to another tenant.`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const receivedAt = enquiry.receivedAt || nowIso;
    const createdAt = enquiry.createdAt || receivedAt;
    const updatedAt = enquiry.updatedAt || nowIso;
    const summaryAndNotes = {
      summary: enquiry.summary ?? '',
      notes: enquiry.notes ?? '',
      otherPartiesNamed: enquiry.otherPartiesNamed ?? '',
      closeNote: enquiry.closeNote ?? '',
    };
    const keyDatesJson = enquiry.keyDate
      ? [{ keyDate: enquiry.keyDate, keyDateLabel: enquiry.keyDateLabel ?? '' }]
      : [];

    await tx.query(
      `INSERT INTO enquiries (
         tenant_id, id, reference, status, first_name, last_name,
         email, phone, postcode, calling_on_behalf_of, organisation_name,
         channel_id, practice_area_id, work_type_subcategory_id, urgency_id,
         assigned_team_id, assigned_to_id, taken_by_id, created_by_id, updated_by_id,
         linked_person_id, linked_organisation_id, referrer_person_id,
         referred_to_organisation_id, converted_matter_id, close_reason_id,
         privacy_notice_given, received_at, first_contact_due_at, closed_at,
         anonymised_at, created_at, updated_at,
         summary_and_notes_json, contact_log_json, conflict_snapshot_json,
         key_dates_json, custom_fields_json, profile_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18, $19, $20,
         $21, $22, $23,
         $24, $25, $26,
         $27, $28::timestamptz, $29::timestamptz, $30::timestamptz,
         $31::timestamptz, $32::timestamptz, $33::timestamptz,
         $34::jsonb, $35::jsonb, $36::jsonb,
         $37::jsonb, $38::jsonb, $39::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         reference = EXCLUDED.reference,
         status = EXCLUDED.status,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         postcode = EXCLUDED.postcode,
         calling_on_behalf_of = EXCLUDED.calling_on_behalf_of,
         organisation_name = EXCLUDED.organisation_name,
         channel_id = EXCLUDED.channel_id,
         practice_area_id = EXCLUDED.practice_area_id,
         work_type_subcategory_id = EXCLUDED.work_type_subcategory_id,
         urgency_id = EXCLUDED.urgency_id,
         assigned_team_id = EXCLUDED.assigned_team_id,
         assigned_to_id = EXCLUDED.assigned_to_id,
         taken_by_id = EXCLUDED.taken_by_id,
         created_by_id = EXCLUDED.created_by_id,
         updated_by_id = EXCLUDED.updated_by_id,
         linked_person_id = EXCLUDED.linked_person_id,
         linked_organisation_id = EXCLUDED.linked_organisation_id,
         referrer_person_id = EXCLUDED.referrer_person_id,
         referred_to_organisation_id = EXCLUDED.referred_to_organisation_id,
         converted_matter_id = EXCLUDED.converted_matter_id,
         close_reason_id = EXCLUDED.close_reason_id,
         privacy_notice_given = EXCLUDED.privacy_notice_given,
         received_at = EXCLUDED.received_at,
         first_contact_due_at = EXCLUDED.first_contact_due_at,
         closed_at = EXCLUDED.closed_at,
         anonymised_at = EXCLUDED.anonymised_at,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         summary_and_notes_json = EXCLUDED.summary_and_notes_json,
         contact_log_json = EXCLUDED.contact_log_json,
         conflict_snapshot_json = EXCLUDED.conflict_snapshot_json,
         key_dates_json = EXCLUDED.key_dates_json,
         custom_fields_json = EXCLUDED.custom_fields_json,
         profile_json = EXCLUDED.profile_json`,
      [
        ctx.tenantId,
        enquiry.id,
        enquiry.reference || enquiry.id,
        enquiry.status || 'New',
        enquiry.firstName ?? '',
        enquiry.lastName ?? '',
        enquiry.email || null,
        enquiry.phone || null,
        enquiry.address?.postcode || null,
        enquiry.callingOnBehalfOf || null,
        enquiry.callingOnBehalfOf || null,
        enquiry.channelId || null,
        enquiry.practiceAreaId || null,
        enquiry.workTypeSubcategoryId ?? null,
        enquiry.urgencyId || null,
        enquiry.assignedTeamId ?? null,
        enquiry.assignedToId ?? null,
        enquiry.takenById || null,
        enquiry.createdById || null,
        enquiry.updatedById || null,
        enquiry.linkedPersonId ?? null,
        enquiry.linkedOrganisationId ?? null,
        enquiry.referrerPersonId ?? null,
        enquiry.referredToOrganisationId ?? null,
        enquiry.convertedMatterId ?? null,
        enquiry.closeReasonId ?? null,
        Boolean(enquiry.privacyNoticeGiven),
        receivedAt,
        enquiry.firstContactDueAt ?? null,
        enquiry.closedAt ?? null,
        enquiry.anonymisedAt ?? null,
        createdAt,
        updatedAt,
        JSON.stringify(summaryAndNotes),
        JSON.stringify(enquiry.contactLog ?? []),
        enquiry.conflictSnapshot !== undefined && enquiry.conflictSnapshot !== null
          ? JSON.stringify(enquiry.conflictSnapshot)
          : null,
        JSON.stringify(keyDatesJson),
        JSON.stringify(enquiry.customFields ?? {}),
        JSON.stringify(enquiry),
      ],
    );  }

  public async putEnquiry<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    enquiry: TenantEnquiryRecord,
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertEnquiryInTx(tx, ctx, enquiry);
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      const res = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, enquiry.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw createIntakeQuoteError('INTAKE_WRITE_ERROR', 'Failed to read saved enquiry.');
      }
      this.assertRowTenant(ctx, row.tenant_id, 'enquiries.putEnquiry');
      return mapRowToEnquiry(row) as unknown as T;
    });
  }

  public async putEnquiries(
    ctx: TenantContext,
    enquiries: readonly TenantEnquiryRecord[],
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const enquiry of enquiries) {
        await this.upsertEnquiryInTx(tx, ctx, enquiry);
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getEnquiryById<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    enquiryId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const res = includeRestricted
        ? await tx.query<EnquiryRow>(
            `SELECT * FROM enquiries e WHERE e.tenant_id = $1 AND e.id = $2`,
            [ctx.tenantId, enquiryId],
          )
        : await tx.query<EnquiryRow>(
            `SELECT * FROM enquiries e
             WHERE e.tenant_id = $1
               AND e.id = $3
               AND ${ENQUIRY_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, enquiryId],
          );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'enquiries.getEnquiryById');
      const mapped = mapRowToEnquiry(row);
      if (includeRestricted) {
        return mapped as unknown as T;
      }
      const hiddenMatterIds = await this.listHiddenRestrictedMatterIdsInTx(
        tx,
        ctx,
        viewerId,
      );
      return this.sanitizeEnquiryConflictSnapshotForViewer(
        mapped,
        hiddenMatterIds,
      ) as unknown as T;
    });
  }

  public async listVisibleEnquiries<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    viewerId: string,
    options?: {
      status?: string;
      assignedTeamId?: string;
      assignedToId?: string;
      includeRestricted?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['e.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(ENQUIRY_VISIBLE_SQL_PREDICATE);
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`e.status = $${params.length}`);
      }
      if (options?.assignedTeamId) {
        params.push(options.assignedTeamId);
        clauses.push(`e.assigned_team_id = $${params.length}`);
      }
      if (options?.assignedToId) {
        params.push(options.assignedToId);
        clauses.push(`e.assigned_to_id = $${params.length}`);
      }

      const res = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries e
         WHERE ${clauses.join(' AND ')}
         ORDER BY e.received_at DESC, e.id ASC`,
        params,
      );
      const hiddenMatterIds = includeRestricted
        ? new Set<string>()
        : await this.listHiddenRestrictedMatterIdsInTx(tx, ctx, viewerId);

      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'enquiries.listVisibleEnquiries');
        const mapped = mapRowToEnquiry(row);
        return (
          includeRestricted
            ? mapped
            : this.sanitizeEnquiryConflictSnapshotForViewer(mapped, hiddenMatterIds)
        ) as unknown as T;
      });
    });
  }

  public async listAllEnquiriesUnfiltered<T = TenantEnquiryRecord>(
    ctx: TenantContext,
  ): Promise<T[]> {
    return (await this.listVisibleEnquiries(ctx, ctx.actorId, {
      includeRestricted: true,
    })) as unknown as T[];
  }

  public async deleteEnquiryById(
    ctx: TenantContext,
    enquiryId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM enquiries WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, enquiryId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'enquiries.deleteEnquiryById');
      }      return res.rowCount > 0;
    });
  }

  /**
   * Anonymises unconverted closed enquiries past the retention cutoff (`retentionMonths`)
   * and writes `audit_entries` in the same PostgreSQL transaction (`S0-17a`).
   */
  public async anonymiseExpiredEnquiries<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    params: {
      byId: string;
      retentionMonths?: number;
      now?: Date;
      asOfIso?: string;
      specificEnquiryId?: string;
      auditEntries?: readonly AppendTenantAuditEntryInput[];
    },
  ): Promise<T[]> {
    const now = params.now
      ? params.now
      : params.asOfIso
        ? new Date(params.asOfIso)
        : new Date();
    const nowIso = now.toISOString();
    const months = Math.max(1, Math.floor(params.retentionMonths || 12));
    const cutoff = new Date(now.getTime());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const cutoffIso = cutoff.toISOString();

    return this.withTenantTransaction(ctx, async (tx) => {
      const queryParams: unknown[] = [ctx.tenantId, cutoffIso];
      let targetClause = '';
      if (params.specificEnquiryId) {
        queryParams.push(params.specificEnquiryId);
        targetClause = `AND e.id = $${queryParams.length}`;
      }

      const candidateRes = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries e
         WHERE e.tenant_id = $1
           AND (e.status IN ('Declined', 'Referred out', 'No response') OR e.status LIKE 'Closed%')
           AND e.converted_matter_id IS NULL
           AND e.anonymised_at IS NULL
           AND e.closed_at IS NOT NULL
           AND e.closed_at <= $2::timestamptz
           ${targetClause}
         ORDER BY e.closed_at ASC, e.id ASC
         FOR UPDATE`,
        queryParams,
      );

      if (candidateRes.rows.length === 0) {
        return [];
      }

      const anonymised: TenantEnquiryRecord[] = [];
      const auditEntries: AppendTenantAuditEntryInput[] = [];
      const retentionNote =
        '[Personal details removed under the firm data retention policy. Practice area, channel, dates and outcome retained for reporting.]';

      for (const row of candidateRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'enquiries.anonymiseExpiredEnquiries');
        const current = mapRowToEnquiry(row);
        const updated: TenantEnquiryRecord = {
          ...current,
          firstName: 'Anonymised',
          lastName: 'Enquirer',
          callingOnBehalfOf: '',
          email: '',
          phone: '',
          address: null,
          otherPartiesNamed: '',
          notes: retentionNote,
          anonymisedAt: nowIso,
          updatedAt: nowIso,
          updatedById: params.byId,
        };
        await this.upsertEnquiryInTx(tx, ctx, updated);
        anonymised.push(updated);
        auditEntries.push({
          recordType: 'enquiry',
          recordId: updated.id,
          action: 'update',
          field: 'Privacy retention anonymisation',
          oldValue: 'Personal details stored',
          newValue:
            'Personal details removed; practice area, channel, dates and outcome kept',
          byId: params.byId,
          at: nowIso,
        });
      }

      if (params.auditEntries?.length) {
        auditEntries.push(...params.auditEntries);
      }

      await this.auditRepo.appendAuditEntries(ctx, auditEntries);
      return anonymised as unknown as T[];
    });
  }

  // ---------------------------------------------------------------------------
  // Quotes CRUD & Queries
  // ---------------------------------------------------------------------------

  public async upsertQuoteInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    quote: TenantQuoteRecord,
  ): Promise<void> {
    if (!quote?.id?.trim()) {
      throw createIntakeQuoteError('QUOTE_VALIDATION_ERROR', 'Quote id is required.');
    }
    const existingCheck = await tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM quotes WHERE id = $1`,
      [quote.id],
    );
    for (const r of existingCheck.rows) {
      if (r.tenant_id !== ctx.tenantId) {
        throw createIntakeQuoteError(
          'TENANCY_CROSS_TENANT_RECORD_ACCESS',
          `Quote "${quote.id}" belongs to another tenant.`,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const createdAt = quote.createdAt || nowIso;
    const updatedAt = quote.updatedAt || nowIso;
    const pricingBreakdown = {
      scope: quote.scope ?? '',
      assumptions: quote.assumptions ?? '',
      hourlyRateGbp: quote.hourlyRateGbp ?? null,
      vatAmount: Number(quote.vatAmount ?? 0),
      vatOverridden: Boolean(quote.vatOverridden),
      disbursements: quote.disbursements ?? [],
    };

    await tx.query(
      `INSERT INTO quotes (
         tenant_id, id, quote_reference, version, status, fee_basis,
         client_type, client_person_id, client_organisation_id, prospect_name,
         source_enquiry_id, converted_matter_id, practice_area_id, work_type_subcategory_id,
         prepared_by_id, assigned_team_id, fee_total_ex_vat_gbp, total_inc_vat_gbp,
         payment_on_account_gbp, valid_until, sent_at, outcome_at,
         created_at, updated_at,
         pricing_breakdown_json, follow_ups_json, version_history_json,
         conflict_decision_json, custom_fields_json, profile_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18,
         $19, $20, $21::timestamptz, $22::timestamptz,
         $23::timestamptz, $24::timestamptz,
         $25::jsonb, $26::jsonb, $27::jsonb,
         $28::jsonb, $29::jsonb, $30::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         quote_reference = EXCLUDED.quote_reference,
         version = EXCLUDED.version,
         status = EXCLUDED.status,
         fee_basis = EXCLUDED.fee_basis,
         client_type = EXCLUDED.client_type,
         client_person_id = EXCLUDED.client_person_id,
         client_organisation_id = EXCLUDED.client_organisation_id,
         prospect_name = EXCLUDED.prospect_name,
         source_enquiry_id = EXCLUDED.source_enquiry_id,
         converted_matter_id = EXCLUDED.converted_matter_id,
         practice_area_id = EXCLUDED.practice_area_id,
         work_type_subcategory_id = EXCLUDED.work_type_subcategory_id,
         prepared_by_id = EXCLUDED.prepared_by_id,
         assigned_team_id = EXCLUDED.assigned_team_id,
         fee_total_ex_vat_gbp = EXCLUDED.fee_total_ex_vat_gbp,
         total_inc_vat_gbp = EXCLUDED.total_inc_vat_gbp,
         payment_on_account_gbp = EXCLUDED.payment_on_account_gbp,
         valid_until = EXCLUDED.valid_until,
         sent_at = EXCLUDED.sent_at,
         outcome_at = EXCLUDED.outcome_at,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         pricing_breakdown_json = EXCLUDED.pricing_breakdown_json,
         follow_ups_json = EXCLUDED.follow_ups_json,
         version_history_json = EXCLUDED.version_history_json,
         conflict_decision_json = EXCLUDED.conflict_decision_json,
         custom_fields_json = EXCLUDED.custom_fields_json,
         profile_json = EXCLUDED.profile_json`,
      [
        ctx.tenantId,
        quote.id,
        quote.reference || quote.id,
        Number(quote.version ?? 1),
        quote.status || 'Draft',
        quote.feeBasis || 'Fixed fee',
        quote.clientType || 'prospect',
        quote.linkedPersonId ?? null,
        quote.linkedOrganisationId ?? null,
        quote.prospectName || null,
        quote.linkedEnquiryId ?? null,
        quote.convertedMatterId ?? null,
        quote.practiceAreaId || null,
        quote.workTypeSubcategoryId ?? null,
        quote.feeEarnerId || null,
        quote.assignedTeamId ?? null,
        Number(quote.feeAmountExVat ?? 0),
        Number(quote.totalIncVat ?? 0),
        null,
        quote.validUntil || null,
        quote.sentAt ?? null,
        quote.outcomeAt ?? null,
        createdAt,
        updatedAt,
        JSON.stringify(pricingBreakdown),
        JSON.stringify(quote.followUps ?? []),
        JSON.stringify(quote.versionHistory ?? []),
        quote.conflictDecision !== undefined && quote.conflictDecision !== null
          ? JSON.stringify(quote.conflictDecision)
          : null,
        JSON.stringify({}),
        JSON.stringify(quote),
      ],
    );  }

  public async putQuote<T = TenantQuoteRecord>(
    ctx: TenantContext,
    quote: TenantQuoteRecord,
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await this.upsertQuoteInTx(tx, ctx, quote);
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
      const res = await tx.query<QuoteRow>(
        `SELECT * FROM quotes WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, quote.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw createIntakeQuoteError('QUOTE_WRITE_ERROR', 'Failed to read saved quote.');
      }
      this.assertRowTenant(ctx, row.tenant_id, 'quotes.putQuote');
      return mapRowToQuote(row) as unknown as T;
    });
  }

  public async putQuotes(
    ctx: TenantContext,
    quotes: readonly TenantQuoteRecord[],
    options?: { auditEntries?: readonly AppendTenantAuditEntryInput[] },
  ): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      for (const quote of quotes) {
        await this.upsertQuoteInTx(tx, ctx, quote);
      }
      if (options?.auditEntries?.length) {
        await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
      }
    });
  }

  public async getQuoteById<T = TenantQuoteRecord>(
    ctx: TenantContext,
    quoteId: string,
    options?: { viewerId?: string; includeRestricted?: boolean },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = options?.viewerId ?? ctx.actorId;
      const res = includeRestricted
        ? await tx.query<QuoteRow>(
            `SELECT * FROM quotes q WHERE q.tenant_id = $1 AND q.id = $2`,
            [ctx.tenantId, quoteId],
          )
        : await tx.query<QuoteRow>(
            `SELECT * FROM quotes q
             WHERE q.tenant_id = $1
               AND q.id = $3
               AND ${QUOTE_VISIBLE_SQL_PREDICATE}`,
            [ctx.tenantId, viewerId, quoteId],
          );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'quotes.getQuoteById');
      return mapRowToQuote(row) as unknown as T;
    });
  }

  public async listVisibleQuotes<T = TenantQuoteRecord>(
    ctx: TenantContext,
    viewerId: string,
    options?: {
      status?: string;
      sourceEnquiryId?: string;
      includeRestricted?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['q.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(QUOTE_VISIBLE_SQL_PREDICATE);
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`q.status = $${params.length}`);
      }
      if (options?.sourceEnquiryId) {
        params.push(options.sourceEnquiryId);
        clauses.push(`q.source_enquiry_id = $${params.length}`);
      }

      const res = await tx.query<QuoteRow>(
        `SELECT * FROM quotes q
         WHERE ${clauses.join(' AND ')}
         ORDER BY q.created_at DESC, q.id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'quotes.listVisibleQuotes');
        return mapRowToQuote(row) as unknown as T;
      });
    });
  }

  public async listAllQuotesUnfiltered<T = TenantQuoteRecord>(
    ctx: TenantContext,
  ): Promise<T[]> {
    return (await this.listVisibleQuotes(ctx, ctx.actorId, {
      includeRestricted: true,
    })) as unknown as T[];
  }

  public async deleteQuoteById(
    ctx: TenantContext,
    quoteId: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM quotes WHERE tenant_id = $1 AND id = $2 RETURNING tenant_id`,
        [ctx.tenantId, quoteId],
      );
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'quotes.deleteQuoteById');
      }      return res.rowCount > 0;
    });
  }

  public async countAllTenantIntakeQuoteRows(ctx: TenantContext): Promise<{
    enquiries: number;
    quotes: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [enqRes, qteRes] = await Promise.all([
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM enquiries WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM quotes WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
      ]);
      return {
        enquiries: Number(enqRes.rows[0]?.count ?? 0),
        quotes: Number(qteRes.rows[0]?.count ?? 0),
      };
    });
  }

  public async clearTenantData(
    ctx: TenantContext,
    options?: { includeEnquiries?: boolean; includeQuotes?: boolean },
  ): Promise<void> {
    const includeEnquiries = options?.includeEnquiries ?? true;
    const includeQuotes = options?.includeQuotes ?? true;
    await this.withTenantTransaction(ctx, async (tx) => {
      if (includeQuotes) {
        await tx.query(`DELETE FROM quotes WHERE tenant_id = $1`, [ctx.tenantId]);
        await tx.query(
          `DELETE FROM quote_reference_sequences WHERE tenant_id = $1`,
          [ctx.tenantId],
        );
        await tx.query(
          `DELETE FROM tenant_record_sequences WHERE tenant_id = $1 AND counter_key = 'QTE'`,
          [ctx.tenantId],
        );
      }
      if (includeEnquiries) {
        await tx.query(`DELETE FROM enquiries WHERE tenant_id = $1`, [ctx.tenantId]);
        await tx.query(
          `DELETE FROM tenant_record_sequences WHERE tenant_id = $1 AND counter_key = 'ENQ'`,
          [ctx.tenantId],
        );
      }    });
  }
}
