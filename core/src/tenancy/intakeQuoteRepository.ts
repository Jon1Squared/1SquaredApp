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
  FeeCapLevel,
  FirmAuditEntryInput as AppendTenantAuditEntryInput,
  GradeRateResolution,
  ResolvedRateSource,
  ResolvedRateTier,
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
  vatAmount?: number;
  vatOverridden?: boolean;
}

export interface TenantQuoteVersionSnapshotRecord {
  version: number;
  status: 'Superseded';
  feeBasis:
    | 'Fixed fee'
    | 'Estimate'
    | 'Capped fee'
    | 'Hourly rate with estimate'
    | 'Conditional fee agreement (CFA)'
    | 'Damages-based agreement (DBA)';
  feeAmountExVat: number;
  hourlyRateGbp: number | null;
  vatRatePercent?: number;
  vatAmount: number;
  vatOverridden?: boolean;
  disbursements: TenantQuoteDisbursementRecord[];
  totalIncVat: number;
  scope: string;
  assumptions: string;
  validUntil: string;
  createdAt: string;
  sentAt: string | null;
  supersededAt: string;
  capturedAt?: string;
  byId: string;
  revisionNote?: string;
  rateSource?: ResolvedRateSource | 'custom_override';
  rateTier?: ResolvedRateTier;
  rateAsAtDate?: string;
  rateCardId?: string | null;
  rateCardName?: string | null;
  rateGradeKey?: string;
  rateProvenanceByGrade?: Record<string, GradeRateResolution>;
  feeArrangementCapCategoryKey?: string;
  feeArrangementPercent?: number | null;
  feeArrangementCapBaseKey?: string;
  feeArrangementCapBaseDescription?: string;
  feeArrangementAppliedCapPercent?: number | null;
  feeArrangementCapLevel?: FeeCapLevel;
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
  vatRatePercent?: number;
  vatAmount: number;
  vatOverridden?: boolean;
  disbursements: TenantQuoteDisbursementRecord[];
  totalIncVat: number;
  capturedAt?: string;
  rateSource?: ResolvedRateSource | 'custom_override';
  rateTier?: ResolvedRateTier;
  rateAsAtDate?: string;
  rateCardId?: string | null;
  rateCardName?: string | null;
  rateGradeKey?: string;
  rateProvenanceByGrade?: Record<string, GradeRateResolution>;
  feeArrangementCapCategoryKey?: string;
  feeArrangementPercent?: number | null;
  feeArrangementCapBaseKey?: string;
  feeArrangementCapBaseDescription?: string;
  feeArrangementAppliedCapPercent?: number | null;
  feeArrangementCapLevel?: FeeCapLevel;
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
    vatRatePercent:
      typeof pricing.vatRatePercent === 'number' && Number.isFinite(pricing.vatRatePercent)
        ? pricing.vatRatePercent
        : typeof profile.vatRatePercent === 'number' && Number.isFinite(profile.vatRatePercent)
          ? profile.vatRatePercent
          : 20,
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
    ...((pricing.capturedAt ?? profile.capturedAt)
      ? { capturedAt: String(pricing.capturedAt ?? profile.capturedAt) }
      : {}),
    ...((pricing.rateSource ?? profile.rateSource)
      ? {
          rateSource: (pricing.rateSource ?? profile.rateSource) as TenantQuoteRecord['rateSource'],
        }
      : {}),
    ...(typeof (pricing.rateTier ?? profile.rateTier) === 'number'
      ? { rateTier: (pricing.rateTier ?? profile.rateTier) as ResolvedRateTier }
      : {}),
    ...((pricing.rateAsAtDate ?? profile.rateAsAtDate)
      ? { rateAsAtDate: String(pricing.rateAsAtDate ?? profile.rateAsAtDate) }
      : {}),
    ...((pricing.rateCardId ?? profile.rateCardId) !== undefined
      ? {
          rateCardId: (pricing.rateCardId ?? profile.rateCardId ?? null) as string | null,
        }
      : {}),
    ...((pricing.rateCardName ?? profile.rateCardName) !== undefined
      ? {
          rateCardName: (pricing.rateCardName ?? profile.rateCardName ?? null) as string | null,
        }
      : {}),
    ...((pricing.rateGradeKey ?? profile.rateGradeKey)
      ? { rateGradeKey: String(pricing.rateGradeKey ?? profile.rateGradeKey) }
      : {}),
    ...((pricing.rateProvenanceByGrade ?? profile.rateProvenanceByGrade)
      ? {
          rateProvenanceByGrade: structuredClone(
            pricing.rateProvenanceByGrade ?? profile.rateProvenanceByGrade,
          ) as Record<string, GradeRateResolution>,
        }
      : {}),
    ...((pricing.feeArrangementCapCategoryKey ?? profile.feeArrangementCapCategoryKey)
      ? {
          feeArrangementCapCategoryKey: String(
            pricing.feeArrangementCapCategoryKey ?? profile.feeArrangementCapCategoryKey,
          ),
        }
      : {}),
    ...((pricing.feeArrangementPercent ?? profile.feeArrangementPercent) !== undefined
      ? {
          feeArrangementPercent: (pricing.feeArrangementPercent ??
            profile.feeArrangementPercent ??
            null) as number | null,
        }
      : {}),
    ...((pricing.feeArrangementCapBaseKey ?? profile.feeArrangementCapBaseKey)
      ? {
          feeArrangementCapBaseKey: String(
            pricing.feeArrangementCapBaseKey ?? profile.feeArrangementCapBaseKey,
          ),
        }
      : {}),
    ...((pricing.feeArrangementCapBaseDescription ?? profile.feeArrangementCapBaseDescription)
      ? {
          feeArrangementCapBaseDescription: String(
            pricing.feeArrangementCapBaseDescription ?? profile.feeArrangementCapBaseDescription,
          ),
        }
      : {}),
    ...((pricing.feeArrangementAppliedCapPercent ?? profile.feeArrangementAppliedCapPercent) !==
    undefined
      ? {
          feeArrangementAppliedCapPercent: (pricing.feeArrangementAppliedCapPercent ??
            profile.feeArrangementAppliedCapPercent ??
            null) as number | null,
        }
      : {}),
    ...((pricing.feeArrangementCapLevel ?? profile.feeArrangementCapLevel)
      ? {
          feeArrangementCapLevel: (pricing.feeArrangementCapLevel ??
            profile.feeArrangementCapLevel) as FeeCapLevel,
        }
      : {}),
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
 * Extracts the explicit `restrictedAccessUserIds` JSONB array configured on a matter row,
 * respecting `opening_record_json.hasRestrictedAccessUserIds` so SQL predicates never mistake
 * pre-expanded participant cache columns for an explicit allow-list (`R676`; `S1-09` adds full `S1-D12`).
 */
export function buildMatterExplicitAllowJsonSql(alias = 'm'): string {
  return `(
    CASE
      WHEN (${alias}.opening_record_json->>'hasRestrictedAccessUserIds') = 'true'
        THEN CASE
          WHEN jsonb_typeof(${alias}.opening_record_json->'restrictedAccessUserIdsFallback') = 'array'
            THEN ${alias}.opening_record_json->'restrictedAccessUserIdsFallback'
          WHEN jsonb_typeof(${alias}.restricted_access_user_ids_json) = 'array'
            THEN ${alias}.restricted_access_user_ids_json
          ELSE '[]'::jsonb
        END
      WHEN (${alias}.opening_record_json->>'hasRestrictedAccessUserIds') = 'false'
        THEN '[]'::jsonb
      WHEN jsonb_typeof(${alias}.restricted_access_user_ids_json) = 'array'
        THEN ${alias}.restricted_access_user_ids_json
      ELSE '[]'::jsonb
    END
  )`;
}

/**
 * SQL predicate returning TRUE when a restricted matter row (`alias`) is hidden from the viewer
 * at `$viewerParamIndex`, matching TypeScript `canAccessMatter` (`core/src/domain/rbac/resolver.ts`, `R676`):
 * - Unrestricted matters (`!is_staff_matter && !has_ethical_wall && len(allowJson) === 0`) are never hidden.
 * - Non-empty explicit allow-list (`len(allowJson) > 0`) is decisive for participants (excludes unlisted participants; `matter:restricted:access` holders still pass ethical walls until S1-09 (S1-D12)).
 * - Empty allow-list (`len(allowJson) === 0`) falls back to named participants (`responsible_partner_id`,
 *   `supervisor_id`, `responsible_fee_earner_id`, or `opening_record_json->'teamMemberIds'`).
 */
export function buildMatterHiddenFromViewerSql(
  alias = 'm',
  viewerParamIndex = 2,
): string {
  const p = `$${viewerParamIndex}::text`;
  const allowJson = buildMatterExplicitAllowJsonSql(alias);
  return `(
    (
      ${alias}.is_staff_matter = TRUE
      OR ${alias}.has_ethical_wall = TRUE
      OR jsonb_array_length(${allowJson}) > 0
    )
    AND (
      CASE
        WHEN jsonb_array_length(${allowJson}) > 0
          THEN NOT (${p} <> '' AND COALESCE(${allowJson} ? ${p}, FALSE))
        ELSE NOT (
          ${p} <> ''
          AND (
            COALESCE(${alias}.responsible_partner_id = ${p}, FALSE)
            OR COALESCE(${alias}.supervisor_id = ${p}, FALSE)
            OR COALESCE(${alias}.responsible_fee_earner_id = ${p}, FALSE)
            OR (
              jsonb_typeof(${alias}.opening_record_json->'teamMemberIds') = 'array'
              AND COALESCE((${alias}.opening_record_json->'teamMemberIds') ? ${p}, FALSE)
            )
          )
        )
      END
    )
  )`;
}

export function buildEnquiryDraftOnlySqlPredicate(viewerParamIndex = 2): string {
  const p = `$${viewerParamIndex}::text`;
  return `(
    e.status <> 'Draft'
    OR (
      ${p} <> ''
      AND (
        COALESCE(e.created_by_id = ${p}, FALSE)
        OR COALESCE(e.taken_by_id = ${p}, FALSE)
      )
    )
  )`;
}

export function buildQuoteDraftOnlySqlPredicate(viewerParamIndex = 2): string {
  return `(
    NOT EXISTS (
      SELECT 1 FROM enquiries e
      WHERE e.tenant_id = q.tenant_id
        AND e.id = q.source_enquiry_id
        AND NOT ${buildEnquiryDraftOnlySqlPredicate(viewerParamIndex)}
    )
  )`;
}

/**
 * Parameterized SQL predicate returning TRUE when an enquiry row `e` (`e.tenant_id = $1`)
 * is visible to `viewerId` (`$viewerParamIndex`), matching `canViewMatter` + `canViewEnquiry` (`R676`, `R685`).
 */
export function buildEnquiryVisibleSqlPredicate(viewerParamIndex = 2): string {
  return `(
    ${buildEnquiryDraftOnlySqlPredicate(viewerParamIndex)}
    AND NOT EXISTS (
      SELECT 1 FROM matters m
      WHERE m.tenant_id = e.tenant_id
        AND (m.id = e.converted_matter_id OR m.source_enquiry_id = e.id)
        AND ${buildMatterHiddenFromViewerSql('m', viewerParamIndex)}
    )
  )`;
}

/**
 * Parameterized SQL predicate returning TRUE when a quote row `q` (`q.tenant_id = $1`)
 * is visible to `viewerId` (`$viewerParamIndex`), matching `canViewMatter` + `canViewQuote` (`R676`, `R685`).
 */
export function buildQuoteVisibleSqlPredicate(viewerParamIndex = 2): string {
  return `(
    NOT EXISTS (
      SELECT 1 FROM matters m
      WHERE m.tenant_id = q.tenant_id
        AND (m.id = q.converted_matter_id OR m.source_quote_id = q.id)
        AND ${buildMatterHiddenFromViewerSql('m', viewerParamIndex)}
    )
    AND NOT EXISTS (
      SELECT 1 FROM enquiries e
      WHERE e.tenant_id = q.tenant_id
        AND e.id = q.source_enquiry_id
        AND NOT ${buildEnquiryVisibleSqlPredicate(viewerParamIndex)}
    )
  )`;
}

export const ENQUIRY_DRAFT_ONLY_SQL_PREDICATE =
  buildEnquiryDraftOnlySqlPredicate(2);

export const QUOTE_DRAFT_ONLY_SQL_PREDICATE =
  buildQuoteDraftOnlySqlPredicate(2);

export const ENQUIRY_VISIBLE_SQL_PREDICATE = buildEnquiryVisibleSqlPredicate(2);

export const QUOTE_VISIBLE_SQL_PREDICATE = buildQuoteVisibleSqlPredicate(2);

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
      `SELECT m.tenant_id, m.id
       FROM matters m
       WHERE m.tenant_id = $1
         AND ${buildMatterHiddenFromViewerSql('m', 2)}`,
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
    options?: {
      viewerId?: string;
      includeRestricted?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const hasRestrictedMatterAccess = Boolean(
        options?.hasRestrictedMatterAccess,
      );
      const viewerId = options?.viewerId ?? ctx.actorId;
      const predicate = hasRestrictedMatterAccess
        ? ENQUIRY_DRAFT_ONLY_SQL_PREDICATE
        : ENQUIRY_VISIBLE_SQL_PREDICATE;
      const res = includeRestricted
        ? await tx.query<EnquiryRow>(
            `SELECT * FROM enquiries e WHERE e.tenant_id = $1 AND e.id = $2`,
            [ctx.tenantId, enquiryId],
          )
        : await tx.query<EnquiryRow>(
            `SELECT * FROM enquiries e
             WHERE e.tenant_id = $1
               AND e.id = $3
               AND ${predicate}`,
            [ctx.tenantId, viewerId, enquiryId],
          );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      this.assertRowTenant(ctx, row.tenant_id, 'enquiries.getEnquiryById');
      const mapped = mapRowToEnquiry(row);
      if (includeRestricted || hasRestrictedMatterAccess) {
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
      statuses?: readonly string[];
      excludeStatuses?: readonly string[];
      openOnly?: boolean;
      assignedTeamId?: string;
      assignedToId?: string;
      assignedToOrTeams?: {
        readonly assignedToId?: string;
        readonly assignedTeamIds?: readonly string[];
      };
      linkedPersonId?: string;
      relatedPersonId?: string;
      linkedOrganisationId?: string;
      relatedOrganisationId?: string;
      convertedMatterId?: string;
      linkedPersonIds?: readonly string[];
      linkedOrganisationIds?: readonly string[];
      query?: string;
      excludeIds?: readonly string[];
      limit?: number;
      offset?: number;
      includeRestricted?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const hasRestrictedMatterAccess = Boolean(
        options?.hasRestrictedMatterAccess,
      );
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['e.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(
          hasRestrictedMatterAccess
            ? ENQUIRY_DRAFT_ONLY_SQL_PREDICATE
            : ENQUIRY_VISIBLE_SQL_PREDICATE,
        );
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`e.status = $${params.length}`);
      }
      const statuses = Array.from(new Set((options?.statuses ?? []).filter(Boolean)));
      if (statuses.length > 0) {
        params.push(statuses);
        clauses.push(`e.status = ANY($${params.length}::text[])`);
      }
      const excludeStatuses = new Set((options?.excludeStatuses ?? []).filter(Boolean));
      if (options?.openOnly) {
        for (const closed of ['Converted', 'Declined', 'Referred out', 'No response']) {
          excludeStatuses.add(closed);
        }
      }
      if (excludeStatuses.size > 0) {
        params.push(Array.from(excludeStatuses));
        clauses.push(`e.status <> ALL($${params.length}::text[])`);
      }
      if (options?.assignedTeamId) {
        params.push(options.assignedTeamId);
        clauses.push(`e.assigned_team_id = $${params.length}`);
      }
      if (options?.assignedToId) {
        params.push(options.assignedToId);
        clauses.push(`e.assigned_to_id = $${params.length}`);
      }
      if (options?.assignedToOrTeams) {
        const orParts: string[] = [];
        const assignedTo = options.assignedToOrTeams.assignedToId?.trim();
        const teamIds = Array.from(
          new Set((options.assignedToOrTeams.assignedTeamIds ?? []).filter(Boolean)),
        );
        if (assignedTo) {
          params.push(assignedTo);
          orParts.push(`e.assigned_to_id = $${params.length}`);
        }
        if (teamIds.length > 0) {
          params.push(teamIds);
          orParts.push(`e.assigned_team_id = ANY($${params.length}::text[])`);
        }
        if (orParts.length > 0) {
          clauses.push(`(${orParts.join(' OR ')})`);
        }
      }
      if (options?.linkedPersonId?.trim()) {
        params.push(options.linkedPersonId.trim());
        clauses.push(`e.linked_person_id = $${params.length}`);
      }
      if (options?.relatedPersonId?.trim()) {
        params.push(options.relatedPersonId.trim());
        const idx = params.length;
        clauses.push(
          `(e.linked_person_id = $${idx} OR e.referrer_person_id = $${idx} OR e.taken_by_id = $${idx} OR e.assigned_to_id = $${idx} OR e.created_by_id = $${idx})`,
        );
      }
      if (options?.linkedOrganisationId?.trim()) {
        params.push(options.linkedOrganisationId.trim());
        clauses.push(`e.linked_organisation_id = $${params.length}`);
      }
      if (options?.relatedOrganisationId?.trim()) {
        params.push(options.relatedOrganisationId.trim());
        const idx = params.length;
        clauses.push(
          `(e.linked_organisation_id = $${idx} OR e.referred_to_organisation_id = $${idx})`,
        );
      }
      if (options?.convertedMatterId?.trim()) {
        params.push(options.convertedMatterId.trim());
        clauses.push(`e.converted_matter_id = $${params.length}`);
      }
      const linkedPersonIds = Array.from(
        new Set((options?.linkedPersonIds ?? []).filter(Boolean)),
      );
      if (linkedPersonIds.length > 0) {
        params.push(linkedPersonIds);
        clauses.push(`e.linked_person_id = ANY($${params.length}::text[])`);
      }
      const linkedOrgIds = Array.from(
        new Set((options?.linkedOrganisationIds ?? []).filter(Boolean)),
      );
      if (linkedOrgIds.length > 0) {
        params.push(linkedOrgIds);
        clauses.push(`e.linked_organisation_id = ANY($${params.length}::text[])`);
      }
      const excludeIds = Array.from(
        new Set((options?.excludeIds ?? []).map((id) => id?.trim()).filter(Boolean) as string[]),
      );
      if (excludeIds.length > 0) {
        params.push(excludeIds);
        clauses.push(`e.id <> ALL($${params.length}::text[])`);
      }
      const cleanQuery = options?.query?.trim().toLowerCase() ?? '';
      if (cleanQuery) {
        params.push(`%${cleanQuery.replace(/[\\%_]/g, '\\$&')}%`);
        const pat = `$${params.length}`;
        clauses.push(
          `(
             lower(COALESCE(e.id, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(e.reference, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(e.first_name, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(e.last_name, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(trim(concat_ws(' ', NULLIF(e.first_name, ''), NULLIF(e.last_name, '')))) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(e.calling_on_behalf_of, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(e.email, '')) LIKE ${pat} ESCAPE '\\'
           )`,
        );
      }

      let sql = `SELECT * FROM enquiries e
         WHERE ${clauses.join(' AND ')}
         ORDER BY e.received_at DESC, e.id ASC`;
      if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
        params.push(Math.max(1, Math.min(500, Math.floor(options.limit))));
        sql += ` LIMIT $${params.length}`;
      }
      if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
        params.push(Math.max(0, Math.floor(options.offset)));
        sql += ` OFFSET $${params.length}`;
      }

      const res = await tx.query<EnquiryRow>(sql, params);
      const hiddenMatterIds =
        includeRestricted || hasRestrictedMatterAccess
          ? new Set<string>()
          : await this.listHiddenRestrictedMatterIdsInTx(tx, ctx, viewerId);

      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'enquiries.listVisibleEnquiries');
        const mapped = mapRowToEnquiry(row);
        return (
          includeRestricted || hasRestrictedMatterAccess
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
      vatRatePercent:
        typeof quote.vatRatePercent === 'number' && Number.isFinite(quote.vatRatePercent)
          ? quote.vatRatePercent
          : 20,
      vatAmount: Number(quote.vatAmount ?? 0),
      vatOverridden: Boolean(quote.vatOverridden),
      disbursements: quote.disbursements ?? [],
      ...(quote.capturedAt ? { capturedAt: quote.capturedAt } : {}),
      ...(quote.rateSource ? { rateSource: quote.rateSource } : {}),
      ...(typeof quote.rateTier === 'number' ? { rateTier: quote.rateTier } : {}),
      ...(quote.rateAsAtDate ? { rateAsAtDate: quote.rateAsAtDate } : {}),
      ...(quote.rateCardId !== undefined ? { rateCardId: quote.rateCardId } : {}),
      ...(quote.rateCardName !== undefined ? { rateCardName: quote.rateCardName } : {}),
      ...(quote.rateGradeKey ? { rateGradeKey: quote.rateGradeKey } : {}),
      ...(quote.rateProvenanceByGrade
        ? { rateProvenanceByGrade: quote.rateProvenanceByGrade }
        : {}),
      ...(quote.feeArrangementCapCategoryKey
        ? { feeArrangementCapCategoryKey: quote.feeArrangementCapCategoryKey }
        : {}),
      ...(quote.feeArrangementPercent !== undefined
        ? { feeArrangementPercent: quote.feeArrangementPercent }
        : {}),
      ...(quote.feeArrangementCapBaseKey
        ? { feeArrangementCapBaseKey: quote.feeArrangementCapBaseKey }
        : {}),
      ...(quote.feeArrangementCapBaseDescription
        ? { feeArrangementCapBaseDescription: quote.feeArrangementCapBaseDescription }
        : {}),
      ...(quote.feeArrangementAppliedCapPercent !== undefined
        ? { feeArrangementAppliedCapPercent: quote.feeArrangementAppliedCapPercent }
        : {}),
      ...(quote.feeArrangementCapLevel
        ? { feeArrangementCapLevel: quote.feeArrangementCapLevel }
        : {}),
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
    options?: {
      viewerId?: string;
      includeRestricted?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const hasRestrictedMatterAccess = Boolean(
        options?.hasRestrictedMatterAccess,
      );
      const viewerId = options?.viewerId ?? ctx.actorId;
      const predicate = hasRestrictedMatterAccess
        ? QUOTE_DRAFT_ONLY_SQL_PREDICATE
        : QUOTE_VISIBLE_SQL_PREDICATE;
      const res = includeRestricted
        ? await tx.query<QuoteRow>(
            `SELECT * FROM quotes q WHERE q.tenant_id = $1 AND q.id = $2`,
            [ctx.tenantId, quoteId],
          )
        : await tx.query<QuoteRow>(
            `SELECT * FROM quotes q
             WHERE q.tenant_id = $1
               AND q.id = $3
               AND ${predicate}`,
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
      statuses?: readonly string[];
      excludeStatuses?: readonly string[];
      sourceEnquiryId?: string;
      convertedMatterId?: string;
      linkedPersonId?: string;
      linkedOrganisationId?: string;
      query?: string;
      excludeIds?: readonly string[];
      limit?: number;
      offset?: number;
      includeRestricted?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const hasRestrictedMatterAccess = Boolean(
        options?.hasRestrictedMatterAccess,
      );
      const params: unknown[] = includeRestricted
        ? [ctx.tenantId]
        : [ctx.tenantId, viewerId];
      const clauses: string[] = ['q.tenant_id = $1'];
      if (!includeRestricted) {
        clauses.push(
          hasRestrictedMatterAccess
            ? QUOTE_DRAFT_ONLY_SQL_PREDICATE
            : QUOTE_VISIBLE_SQL_PREDICATE,
        );
      }
      if (options?.status) {
        params.push(options.status);
        clauses.push(`q.status = $${params.length}`);
      }
      const statuses = Array.from(new Set((options?.statuses ?? []).filter(Boolean)));
      if (statuses.length > 0) {
        params.push(statuses);
        clauses.push(`q.status = ANY($${params.length}::text[])`);
      }
      const excludeStatuses = Array.from(
        new Set((options?.excludeStatuses ?? []).filter(Boolean)),
      );
      if (excludeStatuses.length > 0) {
        params.push(excludeStatuses);
        clauses.push(`q.status <> ALL($${params.length}::text[])`);
      }
      if (options?.sourceEnquiryId) {
        params.push(options.sourceEnquiryId);
        clauses.push(`q.source_enquiry_id = $${params.length}`);
      }
      if (options?.convertedMatterId?.trim()) {
        params.push(options.convertedMatterId.trim());
        clauses.push(`q.converted_matter_id = $${params.length}`);
      }
      if (options?.linkedPersonId?.trim()) {
        params.push(options.linkedPersonId.trim());
        clauses.push(`q.client_person_id = $${params.length}`);
      }
      if (options?.linkedOrganisationId?.trim()) {
        params.push(options.linkedOrganisationId.trim());
        clauses.push(`q.client_organisation_id = $${params.length}`);
      }
      const excludeIds = Array.from(
        new Set((options?.excludeIds ?? []).map((id) => id?.trim()).filter(Boolean) as string[]),
      );
      if (excludeIds.length > 0) {
        params.push(excludeIds);
        clauses.push(`q.id <> ALL($${params.length}::text[])`);
      }
      const cleanQuery = options?.query?.trim().toLowerCase() ?? '';
      if (cleanQuery) {
        params.push(`%${cleanQuery.replace(/[\\%_]/g, '\\$&')}%`);
        const pat = `$${params.length}`;
        clauses.push(
          `(
             lower(COALESCE(q.id, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(q.quote_reference, '')) LIKE ${pat} ESCAPE '\\'
             OR lower(COALESCE(q.prospect_name, '')) LIKE ${pat} ESCAPE '\\'
           )`,
        );
      }

      let sql = `SELECT * FROM quotes q
         WHERE ${clauses.join(' AND ')}
         ORDER BY q.created_at DESC, q.id ASC`;
      if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
        params.push(Math.max(1, Math.min(500, Math.floor(options.limit))));
        sql += ` LIMIT $${params.length}`;
      }
      if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
        params.push(Math.max(0, Math.floor(options.offset)));
        sql += ` OFFSET $${params.length}`;
      }

      const res = await tx.query<QuoteRow>(sql, params);
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

  /**
   * Loads open quotes (`Sent` or `Follow-up due`) whose `valid_until` date is strictly
   * before `localDateYmd` for unattended lifecycle expiry (`quote-expiry` job, R663).
   */
  public async listOverdueQuotesForLifecycleSweep<T = TenantQuoteRecord>(
    ctx: TenantContext,
    localDateYmd: string,
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<QuoteRow>(
        `SELECT * FROM quotes q
         WHERE q.tenant_id = $1
           AND q.status IN ('Sent', 'Follow-up due')
           AND q.valid_until IS NOT NULL
           AND q.valid_until <> ''
           AND q.valid_until < $2
         ORDER BY q.id ASC`,
        [ctx.tenantId, localDateYmd],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'quotes.listOverdueQuotesForLifecycleSweep',
        );
        return mapRowToQuote(row) as unknown as T;
      });
    });
  }

  /**
   * Atomically locks and expires a single quote only if it is still open (`Sent` or
   * `Follow-up due`) with `valid_until < localDate` (`R675`). Uses `FOR UPDATE SKIP LOCKED`
   * so concurrent status changes or another worker never get overwritten or stall the sweep.
   */
  public async expireQuoteIfOverdue<
    T extends { status: string; timeline?: unknown[]; updatedAt?: string } = TenantQuoteRecord,
  >(
    ctx: TenantContext,
    quoteId: string,
    options: {
      readonly localDate: string;
      readonly applyTransition: (quote: T) => {
        readonly shouldPersist: boolean;
        readonly previousStatus: string;
      };
      readonly onPersistedInTx?: (
        expiredQuote: T,
        previousStatus: string,
      ) => Promise<void>;
    },
  ): Promise<{ expired: boolean; previousStatus: string | null; quote: T | null }> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<QuoteRow>(
        `SELECT * FROM quotes q
         WHERE q.tenant_id = $1
           AND q.id = $2
           AND q.status IN ('Sent', 'Follow-up due')
           AND NULLIF(q.valid_until, '') IS NOT NULL
           AND q.valid_until < $3
         FOR UPDATE SKIP LOCKED`,
        [ctx.tenantId, quoteId, options.localDate],
      );
      if (res.rows.length === 0) {
        return { expired: false, previousStatus: null, quote: null };
      }
      const row = res.rows[0]!;
      this.assertRowTenant(
        ctx,
        row.tenant_id,
        'quotes.expireQuoteIfOverdue',
      );
      const freshQuote = mapRowToQuote(row) as unknown as T;
      const { shouldPersist, previousStatus } = options.applyTransition(freshQuote);
      if (!shouldPersist) {
        return { expired: false, previousStatus, quote: null };
      }
      await this.upsertQuoteInTx(
        tx,
        ctx,
        freshQuote as unknown as TenantQuoteRecord,
      );
      await options.onPersistedInTx?.(freshQuote, previousStatus);
      return { expired: true, previousStatus, quote: freshQuote };
    });
  }

  // ---------------------------------------------------------------------------
  // S1-02a Scoped Intake & Quote Lookups
  // ---------------------------------------------------------------------------

  public async getQuoteByIdOrReference<T = TenantQuoteRecord>(
    ctx: TenantContext,
    idOrReference: string,
    options?: {
      viewerId?: string;
      includeRestricted?: boolean;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T | null> {
    if (!idOrReference?.trim()) return null;
    const key = idOrReference.trim();
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const hasRestrictedMatterAccess = Boolean(
        options?.hasRestrictedMatterAccess,
      );
      const viewerId = options?.viewerId ?? ctx.actorId;
      const predicate = hasRestrictedMatterAccess
        ? QUOTE_DRAFT_ONLY_SQL_PREDICATE
        : QUOTE_VISIBLE_SQL_PREDICATE;
      const res = includeRestricted
        ? await tx.query<QuoteRow>(
            `SELECT * FROM quotes q WHERE q.tenant_id = $1 AND (q.id = $2 OR q.quote_reference = $2) LIMIT 1`,
            [ctx.tenantId, key],
          )
        : await tx.query<QuoteRow>(
            `SELECT * FROM quotes q
             WHERE q.tenant_id = $1
               AND (q.id = $3 OR q.quote_reference = $3)
               AND ${predicate}
             LIMIT 1`,
            [ctx.tenantId, viewerId, key],
          );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'quotes.getQuoteByIdOrReference');
      return mapRowToQuote(row) as unknown as T;
    });
  }

  public async listEnquiriesByIds<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    enquiryIds: readonly string[],
    options?: {
      includeRestricted?: boolean;
      viewerId?: string;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T[]> {
    const cleanIds = Array.from(
      new Set(enquiryIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = (options?.viewerId ?? ctx.actorId ?? '').trim() || '__none__';
      const sqlParams: unknown[] = [ctx.tenantId, cleanIds];
      const whereClauses = ['e.tenant_id = $1', 'e.id = ANY($2::text[])'];
      if (!includeRestricted) {
        sqlParams.push(viewerId);
        const vIdx = sqlParams.length;
        const pred = options?.hasRestrictedMatterAccess
          ? buildEnquiryDraftOnlySqlPredicate(vIdx)
          : buildEnquiryVisibleSqlPredicate(vIdx);
        whereClauses.push(pred);
      }
      const res = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries e
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY e.id ASC`,
        sqlParams,
      );
      const hiddenMatterIds =
        includeRestricted || options?.hasRestrictedMatterAccess
          ? new Set<string>()
          : await this.listHiddenRestrictedMatterIdsInTx(tx, ctx, viewerId);
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'enquiries.listEnquiriesByIds');
        const mapped = mapRowToEnquiry(row);
        return (
          includeRestricted || options?.hasRestrictedMatterAccess
            ? mapped
            : this.sanitizeEnquiryConflictSnapshotForViewer(mapped, hiddenMatterIds)
        ) as unknown as T;
      });
    });
  }

  public async listQuotesByIds<T = TenantQuoteRecord>(
    ctx: TenantContext,
    quoteIds: readonly string[],
    options?: {
      includeRestricted?: boolean;
      viewerId?: string;
      hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T[]> {
    const cleanIds = Array.from(
      new Set(quoteIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const includeRestricted = Boolean(options?.includeRestricted);
      const viewerId = (options?.viewerId ?? ctx.actorId ?? '').trim() || '__none__';
      const sqlParams: unknown[] = [ctx.tenantId, cleanIds];
      const whereClauses = ['q.tenant_id = $1', 'q.id = ANY($2::text[])'];
      if (!includeRestricted) {
        sqlParams.push(viewerId);
        const vIdx = sqlParams.length;
        whereClauses.push(
          options?.hasRestrictedMatterAccess
            ? buildQuoteDraftOnlySqlPredicate(vIdx)
            : buildQuoteVisibleSqlPredicate(vIdx),
        );
      }
      const res = await tx.query<QuoteRow>(
        `SELECT * FROM quotes q
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY q.id ASC`,
        sqlParams,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'quotes.listQuotesByIds');
        return mapRowToQuote(row) as unknown as T;
      });
    });
  }

  public async listEnquiriesForOwnerOrMatters<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    filter: {
      readonly ownerPersonId?: string;
      readonly matterIds?: readonly string[];
      readonly clientPersonIds?: readonly string[];
      readonly clientOrgIds?: readonly string[];
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const orClauses: string[] = [];
      const params: unknown[] = [ctx.tenantId];
      if (filter.ownerPersonId?.trim()) {
        params.push(filter.ownerPersonId.trim());
        const idx = params.length;
        orClauses.push(
          `(e.assigned_to_id = $${idx} OR e.taken_by_id = $${idx} OR e.created_by_id = $${idx} OR e.linked_person_id = $${idx})`,
        );
      }
      const mIds = Array.from(
        new Set((filter.matterIds ?? []).filter(Boolean)),
      );
      if (mIds.length > 0) {
        params.push(mIds);
        orClauses.push(`e.converted_matter_id = ANY($${params.length}::text[])`);
      }
      const pIds = Array.from(
        new Set((filter.clientPersonIds ?? []).filter(Boolean)),
      );
      if (pIds.length > 0) {
        params.push(pIds);
        const idx = params.length;
        orClauses.push(
          `(e.linked_person_id = ANY($${idx}::text[]) OR e.summary_and_notes_json->>'referrerPersonId' = ANY($${idx}::text[]))`,
        );
      }
      const oIds = Array.from(
        new Set((filter.clientOrgIds ?? []).filter(Boolean)),
      );
      if (oIds.length > 0) {
        params.push(oIds);
        orClauses.push(`e.linked_organisation_id = ANY($${params.length}::text[])`);
      }
      if (orClauses.length === 0) return [];
      const res = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries e
         WHERE e.tenant_id = $1 AND (${orClauses.join(' OR ')})
         ORDER BY e.id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'enquiries.listEnquiriesForOwnerOrMatters',
        );
        return mapRowToEnquiry(row) as unknown as T;
      });
    });
  }

  public async findSqlConflictEnquiryCandidates<T = TenantEnquiryRecord>(
    ctx: TenantContext,
    params: {
      readonly terms?: readonly string[];
      readonly emails?: readonly string[];
      readonly phones?: readonly string[];
      readonly linkedPersonIds?: readonly string[];
      readonly linkedOrganisationIds?: readonly string[];
      readonly excludeEnquiryId?: string | null;
      readonly includeAll?: boolean;
      readonly viewerId?: string;
      readonly hasRestrictedMatterAccess?: boolean;
    },
  ): Promise<T[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const orClauses: string[] = [];
      const sqlParams: unknown[] = [ctx.tenantId];

      const pIds = Array.from(
        new Set((params.linkedPersonIds ?? []).map((x) => x.trim()).filter(Boolean)),
      );
      if (pIds.length > 0) {
        sqlParams.push(pIds);
        const idx = sqlParams.length;
        orClauses.push(
          `(e.linked_person_id = ANY($${idx}::text[]) OR e.referrer_person_id = ANY($${idx}::text[]) OR e.summary_and_notes_json->>'referrerPersonId' = ANY($${idx}::text[]))`,
        );
      }
      const oIds = Array.from(
        new Set((params.linkedOrganisationIds ?? []).map((x) => x.trim()).filter(Boolean)),
      );
      if (oIds.length > 0) {
        sqlParams.push(oIds);
        orClauses.push(`e.linked_organisation_id = ANY($${sqlParams.length}::text[])`);
      }
      const emails = Array.from(
        new Set((params.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
      );
      if (emails.length > 0) {
        sqlParams.push(emails);
        orClauses.push(`lower(COALESCE(e.email, '')) = ANY($${sqlParams.length}::text[])`);
      }
      const terms = Array.from(
        new Set((params.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2)),
      );
      for (const term of terms) {
        const escaped = term.replace(/[\\%_]/g, '\\$&');
        sqlParams.push(`%${escaped}%`, term);
        const likeIdx = sqlParams.length - 1;
        const trgmIdx = sqlParams.length;
        const enqOtherExpr = `COALESCE(e.summary_and_notes_json->>'otherPartiesNamed', e.profile_json->>'otherPartiesNamed', '')`;
        const enqConcatLower = `lower(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '') || ' ' || COALESCE(e.calling_on_behalf_of, '') || ' ' || COALESCE(e.organisation_name, '') || ' ' || ${enqOtherExpr})`;
        orClauses.push(
          `(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '') ILIKE $${likeIdx} OR COALESCE(e.calling_on_behalf_of, '') ILIKE $${likeIdx} OR COALESCE(e.organisation_name, '') ILIKE $${likeIdx} OR ${enqOtherExpr} ILIKE $${likeIdx} OR word_similarity($${trgmIdx}, ${enqConcatLower}) >= 0.28 OR word_similarity(${enqConcatLower}, $${trgmIdx}) >= 0.28 OR (length(trim(COALESCE(e.calling_on_behalf_of, ''))) >= 3 AND strpos(lower($${trgmIdx}), lower(trim(COALESCE(e.calling_on_behalf_of, '')))) > 0) OR (length(trim(COALESCE(e.organisation_name, ''))) >= 3 AND strpos(lower($${trgmIdx}), lower(trim(COALESCE(e.organisation_name, '')))) > 0))`,
        );
      }
      for (const ph of params.phones ?? []) {
        const digits = ph.replace(/\D/g, '');
        if (digits.length >= 7) {
          const suffix = digits.slice(-7);
          sqlParams.push(`%${suffix}%`);
          orClauses.push(
            `regexp_replace(COALESCE(e.phone, ''), '[^0-9]', '', 'g') LIKE $${sqlParams.length}`,
          );
        }
      }
      if (orClauses.length === 0) return [];

      const whereClauses: string[] = ['e.tenant_id = $1', `(${orClauses.join(' OR ')})`];
      if (params.excludeEnquiryId?.trim()) {
        sqlParams.push(params.excludeEnquiryId.trim());
        whereClauses.push(`e.id <> $${sqlParams.length}`);
      }
      if (!params.includeAll) {
        sqlParams.push(params.viewerId ?? ctx.actorId);
        const vIdx = sqlParams.length;
        const pred = params.hasRestrictedMatterAccess
          ? buildEnquiryDraftOnlySqlPredicate(vIdx)
          : buildEnquiryVisibleSqlPredicate(vIdx);
        whereClauses.push(pred);
      }

      const res = await tx.query<EnquiryRow>(
        `SELECT * FROM enquiries e
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY e.received_at DESC, e.id ASC`,
        sqlParams,
      );
      const hiddenMatterIds =
        params.includeAll || params.hasRestrictedMatterAccess
          ? new Set<string>()
          : await this.listHiddenRestrictedMatterIdsInTx(
              tx,
              ctx,
              params.viewerId ?? ctx.actorId,
            );
      return res.rows.map((row) => {
        this.assertRowTenant(
          ctx,
          row.tenant_id,
          'enquiries.findSqlConflictEnquiryCandidates',
        );
        const mapped = mapRowToEnquiry(row);
        return (
          params.includeAll || params.hasRestrictedMatterAccess
            ? mapped
            : this.sanitizeEnquiryConflictSnapshotForViewer(mapped, hiddenMatterIds)
        ) as unknown as T;
      });
    });
  }

  public async listHiddenEnquiryIds(
    ctx: TenantContext,
    viewerId: string,
    options?: { hasRestrictedMatterAccess?: boolean; ids?: readonly string[] },
  ): Promise<string[]> {
    const filterIds = options?.ids
      ? Array.from(new Set(options.ids.map((id) => id?.trim()).filter(Boolean) as string[]))
      : null;
    if (filterIds && filterIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const pred = options?.hasRestrictedMatterAccess
        ? ENQUIRY_DRAFT_ONLY_SQL_PREDICATE
        : ENQUIRY_VISIBLE_SQL_PREDICATE;
      const res = filterIds
        ? await tx.query<{ tenant_id: string; id: string }>(
            `SELECT e.tenant_id, e.id FROM enquiries e
             WHERE e.tenant_id = $1 AND e.id = ANY($3::text[]) AND NOT ${pred}
             ORDER BY e.id ASC`,
            [ctx.tenantId, viewerId, filterIds],
          )
        : await tx.query<{ tenant_id: string; id: string }>(
            `SELECT e.tenant_id, e.id FROM enquiries e
             WHERE e.tenant_id = $1 AND NOT ${pred}
             ORDER BY e.id ASC`,
            [ctx.tenantId, viewerId],
          );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'enquiries.listHiddenEnquiryIds');
        return r.id;
      });
    });
  }

  public async isEnquiryHiddenFromViewer(
    ctx: TenantContext,
    enquiryId: string,
    viewerId: string,
    options?: { hasRestrictedMatterAccess?: boolean },
  ): Promise<boolean> {
    const cleanId = enquiryId?.trim();
    if (!cleanId) return false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const pred = options?.hasRestrictedMatterAccess
        ? ENQUIRY_DRAFT_ONLY_SQL_PREDICATE
        : ENQUIRY_VISIBLE_SQL_PREDICATE;
      const res = await tx.query<{ is_hidden: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM enquiries e
           WHERE e.tenant_id = $1 AND e.id = $3 AND NOT ${pred}
         ) AS is_hidden`,
        [ctx.tenantId, viewerId, cleanId],
      );
      return Boolean(res.rows[0]?.is_hidden);
    });
  }

  public async listHiddenQuoteIds(
    ctx: TenantContext,
    viewerId: string,
    options?: { hasRestrictedMatterAccess?: boolean; ids?: readonly string[] },
  ): Promise<string[]> {
    const filterIds = options?.ids
      ? Array.from(new Set(options.ids.map((id) => id?.trim()).filter(Boolean) as string[]))
      : null;
    if (filterIds && filterIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const pred = options?.hasRestrictedMatterAccess
        ? QUOTE_DRAFT_ONLY_SQL_PREDICATE
        : QUOTE_VISIBLE_SQL_PREDICATE;
      const res = filterIds
        ? await tx.query<{ tenant_id: string; id: string }>(
            `SELECT q.tenant_id, q.id FROM quotes q
             WHERE q.tenant_id = $1 AND q.id = ANY($3::text[]) AND NOT ${pred}
             ORDER BY q.id ASC`,
            [ctx.tenantId, viewerId, filterIds],
          )
        : await tx.query<{ tenant_id: string; id: string }>(
            `SELECT q.tenant_id, q.id FROM quotes q
             WHERE q.tenant_id = $1 AND NOT ${pred}
             ORDER BY q.id ASC`,
            [ctx.tenantId, viewerId],
          );
      return res.rows.map((r) => {
        this.assertRowTenant(ctx, r.tenant_id, 'quotes.listHiddenQuoteIds');
        return r.id;
      });
    });
  }

  public async isQuoteHiddenFromViewer(
    ctx: TenantContext,
    quoteId: string,
    viewerId: string,
    options?: { hasRestrictedMatterAccess?: boolean },
  ): Promise<boolean> {
    const cleanId = quoteId?.trim();
    if (!cleanId) return false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const pred = options?.hasRestrictedMatterAccess
        ? QUOTE_DRAFT_ONLY_SQL_PREDICATE
        : QUOTE_VISIBLE_SQL_PREDICATE;
      const res = await tx.query<{ is_hidden: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM quotes q
           WHERE q.tenant_id = $1 AND q.id = $3 AND NOT ${pred}
         ) AS is_hidden`,
        [ctx.tenantId, viewerId, cleanId],
      );
      return Boolean(res.rows[0]?.is_hidden);
    });
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
