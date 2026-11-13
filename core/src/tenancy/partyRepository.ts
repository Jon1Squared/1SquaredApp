/**
 * Tenant-Scoped Party & Directory Repository (`core/src/tenancy/partyRepository.ts`).
 *
 * Implements ADR 0028 §§2–5 & `S0-16` (`Owner Decision 1`, `Owner Decision 2`, `Owner Decision 4`, `R410`):
 * 1. Every read (`withTenantReadTransaction`) and write (`withTenantTransaction`) executes inside an
 *    explicit PostgreSQL transaction whose first statement is `SET LOCAL ROLE <role_tenant_slug_env>`.
 * 2. Every SQL statement scopes by `tenant_id = $1` and every returned row is verified via `assertRowTenant`.
 * 3. Synchronises `public.person_emails` in the same transaction as every `people` write (`R410`), indexing
 *    every active `emails[]` entry (`source = 'contact_email'`) and `employment.systems.firmWorkEmail`
 *    (`source = 'firm_work_email'`) so `findActivePeopleByEmail` preserves all-address S0-30 (`B13`) matching.
 * 4. Joins an active outer `withTenantTransaction` automatically via `TenantScopedRepository`'s
 *    `AsyncLocalStorage` so party, matter, key-date, document, and `audit_entries` writes commit or
 *    roll back atomically together.
 */

import type {
  FirmAuditEntryInput as AppendTenantAuditEntryInput,
  TenantContext,
} from '../api/index';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';
import { TenantAuditRepository } from './auditRepository';

export interface TenantEmailEntry {
  id: string;
  address: string;
  typeId: string | null;
  isPrimary: boolean;
  firmIssued?: boolean;
  active?: boolean;
}

export interface TenantPhoneEntry {
  id: string;
  number: string;
  typeId: string | null;
  firmIssued?: boolean;
  active?: boolean;
}

export interface TenantAddressEntry {
  id: string;
  typeId: string | null;
  line1: string;
  line2: string;
  town: string;
  county: string;
  postcode: string;
  countryId: string | null;
}

export interface TenantOtherNameEntry {
  id: string;
  name: string;
  typeId: string | null;
}

export interface TenantPersonRecord {
  id: string;
  recordType: 'person';
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
  titleId: string | null;
  firstName: string;
  middleNames: string;
  surname: string;
  preferredName: string;
  dateOfBirth?: string | null;
  otherNames: TenantOtherNameEntry[];
  jobTitle: string;
  emails: TenantEmailEntry[];
  phones: TenantPhoneEntry[];
  preferredContactMethodId: string | null;
  preferredLanguageId: string | null;
  addresses: TenantAddressEntry[];
  website: string;
  relationshipOwnerId: string | null;
  relationshipStatusId: string | null;
  relationshipStandingId: string | null;
  relationshipRoleIds: string[];
  originId: string | null;
  firstKnownAt: string | null;
  engagementLevelId: string | null;
  interests: string;
  relationshipNotes: string;
  marketingConsentId: string | null;
  consentRecord: string;
  verificationStatusId: string | null;
  verifiedAt: string | null;
  verificationMethodId: string | null;
  verificationReviewerId: string | null;
  riskReferences: string;
  isEmployee: boolean;
  employeeRoleId: string | null;
  departmentId: string | null;
  employment?: unknown;
  permissionOverrides?: unknown;
  entraObjectId?: string | null;
  employeePermissions?: string[];
  documentPermissions?: string[];
  appRole?: string | null;
  roles?: string[];
  demo?: boolean;
  showsWorkOfId?: string | null;
  supportsIds?: string[];
  createdFromEnquiryId?: string | null;
}

export interface TenantPersonEmailRow {
  tenantId: string;
  personId: string;
  emailLower: string;
  source: 'contact_email' | 'firm_work_email';
  isPrimary: boolean;
  active: boolean;
  updatedAt: string;
}

export interface TenantOrganisationRecord {
  id: string;
  recordType: 'organisation';
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
  legalName: string;
  otherNames: TenantOtherNameEntry[];
  organisationTypeId: string | null;
  companyNumber: string;
  vatNumber: string;
  countryOfRegistrationId: string | null;
  registeredAddress: TenantAddressEntry | null;
  correspondenceAddress: TenantAddressEntry | null;
  peopleWithSignificantControl?: string[];
  directors?: string[];
  website: string;
  mainPhone: string;
  generalEmail: string;
  parentOrganisationId: string | null;
  relationshipPartnerId: string | null;
  relationshipTypeIds: string[];
  relationshipStatusId: string | null;
  relationshipStandingId: string | null;
  sectorId: string | null;
  clientTierId: string | null;
  originId: string | null;
  relationshipStartedAt: string | null;
  engagementLevelId: string | null;
  pipelineStageId: string | null;
  bdNotes: string;
  clientReference: string;
  onboardingStatusId: string | null;
  conflictStatusId: string | null;
  conflictReference: string;
  conflictDecision?: unknown;
  riskRatingId: string | null;
  riskAssessmentStatusId: string | null;
  verificationStatusId: string | null;
  billingAddress: TenantAddressEntry | null;
  invoicePreferenceId: string | null;
  paymentTermsId: string | null;
  creditControlNotes: string;
  engagementTermsRef: string;
  reviewDate: string | null;
  reviewerId: string | null;
  createdFromEnquiryId?: string | null;
}

export interface TenantPersonOrganisationLinkRecord {
  id: string;
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
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface TenantNoteRecord {
  id: string;
  recordType: 'person' | 'organisation' | 'matter' | 'enquiry';
  recordId: string;
  authorId: string;
  at: string;
  text: string;
  mergedFromId?: string | null;
}

export interface TenantMergeHistoryRecord {
  id: string;
  recordType: 'person' | 'organisation';
  survivorId: string;
  mergedId: string;
  mergedLabel: string;
  byId: string;
  at: string;
  fieldsTaken: string[];
  pmsLinkConflicts?: Array<{
    keptPmsCode: string;
    discardedPmsCode: string;
  }>;
}

interface DbPersonRow {
  tenant_id: string;
  id: string;
  first_name: string;
  preferred_name: string;
  other_names: string;
  surname: string;
  title_id: string | null;
  date_of_birth: string | null;
  is_employee: boolean;
  employee_role_id: string | null;
  app_role: string | null;
  entra_object_id: string | null;
  primary_email_lower: string | null;
  job_title: string;
  department_id: string | null;
  office_id: string | null;
  supervisor_id: string | null;
  is_fee_earner: boolean;
  default_hourly_rate_gbp: string | number | null;
  client_status_id: string | null;
  aml_status_id: string | null;
  id_verified_on: string | null;
  id_expiry_date: string | null;
  created_from_enquiry_id: string | null;
  merged_into_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  emails_json: TenantEmailEntry[];
  phones_json: TenantPhoneEntry[];
  addresses_json: TenantAddressEntry[];
  relationship_role_ids_json: string[];
  roles_json: string[] | null;
  permission_overrides_json: Record<string, unknown> | null;
  dismissed_duplicate_ids_json: string[];
  custom_fields_json: Record<string, unknown>;
  profile_json: Record<string, unknown>;
  employment_json: Record<string, unknown> | null;
}

interface DbOrganisationRow {
  tenant_id: string;
  id: string;
  legal_name: string;
  trading_name: string;
  organisation_type_id: string | null;
  company_number: string;
  vat_number: string;
  client_reference: string;
  general_email: string;
  main_phone: string;
  website: string;
  parent_organisation_id: string | null;
  relationship_partner_id: string | null;
  conflict_status: string | null;
  aml_status_id: string | null;
  client_status_id: string | null;
  created_from_enquiry_id: string | null;
  merged_into_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  registered_address_json: TenantAddressEntry | null;
  trading_address_json: TenantAddressEntry | null;
  relationship_type_ids_json: string[];
  sector_ids_json: string[];
  dismissed_duplicate_ids_json: string[];
  custom_fields_json: Record<string, unknown>;
  profile_json: Record<string, unknown>;
}

interface DbLinkRow {
  tenant_id: string;
  id: string;
  person_id: string;
  organisation_id: string;
  job_title: string;
  department: string;
  role_within_organisation: string;
  is_primary_contact: boolean;
  is_current: boolean;
  start_date: string | null;
  end_date: string | null;
  contact_status_id: string | null;
  notes: string;
  created_at: Date | string;
  updated_at: Date | string;
  contact_role_ids_json: string[];
  profile_json: Record<string, unknown>;
}

interface DbNoteRow {
  tenant_id: string;
  id: string;
  record_type: string;
  record_id: string;
  body: string;
  visibility: string;
  pinned: boolean;
  created_by_id: string;
  merged_from_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbMergeHistoryRow {
  tenant_id: string;
  id: string;
  record_type: string;
  survivor_id: string;
  merged_id: string;
  merged_by_id: string;
  merged_at: Date | string;
  summary_json: TenantMergeHistoryRecord;
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

function resolvePrimaryEmailLower(emails: readonly TenantEmailEntry[] | undefined): string | null {
  if (!Array.isArray(emails) || emails.length === 0) {
    return null;
  }
  const primary = emails.find((e) => e.isPrimary && e.active !== false && e.address?.trim());
  const firstActive = emails.find((e) => e.active !== false && e.address?.trim());
  const fallback = emails.find((e) => e.address?.trim());
  const chosen = (primary ?? firstActive ?? fallback)?.address?.trim().toLowerCase();
  return chosen || null;
}

function mapPersonRow<TPerson extends TenantPersonRecord = TenantPersonRecord>(
  row: DbPersonRow,
): TPerson {
  const prof = (row.profile_json ?? {}) as Record<string, unknown>;
  const out: TenantPersonRecord = {
    id: row.id,
    recordType: 'person',
    recordOwnerId: (prof.recordOwnerId as string | null) ?? null,
    recordStatusId: (prof.recordStatusId as string) ?? 'record_status.active',
    createdById: (prof.createdById as string) ?? 'system',
    createdAt: (prof.createdAt as string) ?? toIsoString(row.created_at),
    updatedById: (prof.updatedById as string) ?? 'system',
    updatedAt: (prof.updatedAt as string) ?? toIsoString(row.updated_at),
    sourceId: (prof.sourceId as string | null) ?? null,
    lastVerifiedAt: (prof.lastVerifiedAt as string | null) ?? null,
    tags: Array.isArray(prof.tags) ? [...(prof.tags as string[])] : [],
    duplicateStatusId:
      (prof.duplicateStatusId as string) ?? 'duplicate_status.unique',
    notDuplicateOf: Array.isArray(row.dismissed_duplicate_ids_json)
      ? [...row.dismissed_duplicate_ids_json]
      : [],
    possibleMatchIds: Array.isArray(prof.possibleMatchIds)
      ? [...(prof.possibleMatchIds as string[])]
      : [],
    mergedIntoId: row.merged_into_id ?? null,
    lastInteractionAt: (prof.lastInteractionAt as string | null) ?? null,
    customFields:
      row.custom_fields_json && typeof row.custom_fields_json === 'object'
        ? structuredClone(row.custom_fields_json)
        : {},
    titleId: row.title_id ?? null,
    firstName: row.first_name ?? '',
    middleNames: (prof.middleNames as string) ?? '',
    surname: row.surname ?? '',
    preferredName: row.preferred_name ?? '',
    otherNames: Array.isArray(prof.otherNames)
      ? structuredClone(prof.otherNames as TenantOtherNameEntry[])
      : [],
    jobTitle: row.job_title ?? '',
    emails: Array.isArray(row.emails_json)
      ? structuredClone(row.emails_json)
      : [],
    phones: Array.isArray(row.phones_json)
      ? structuredClone(row.phones_json)
      : [],
    preferredContactMethodId:
      (prof.preferredContactMethodId as string | null) ?? null,
    preferredLanguageId: (prof.preferredLanguageId as string | null) ?? null,
    addresses: Array.isArray(row.addresses_json)
      ? structuredClone(row.addresses_json)
      : [],
    website: (prof.website as string) ?? '',
    relationshipOwnerId: (prof.relationshipOwnerId as string | null) ?? null,
    relationshipStatusId:
      row.client_status_id ??
      ((prof.relationshipStatusId as string | null) ?? null),
    relationshipStandingId:
      (prof.relationshipStandingId as string | null) ?? null,
    relationshipRoleIds: Array.isArray(row.relationship_role_ids_json)
      ? [...row.relationship_role_ids_json]
      : [],
    originId: (prof.originId as string | null) ?? null,
    firstKnownAt: (prof.firstKnownAt as string | null) ?? null,
    engagementLevelId: (prof.engagementLevelId as string | null) ?? null,
    interests: (prof.interests as string) ?? '',
    relationshipNotes: (prof.relationshipNotes as string) ?? '',
    marketingConsentId: (prof.marketingConsentId as string | null) ?? null,
    consentRecord: (prof.consentRecord as string) ?? '',
    verificationStatusId:
      row.aml_status_id ??
      ((prof.verificationStatusId as string | null) ?? null),
    verifiedAt:
      row.id_verified_on ?? ((prof.verifiedAt as string | null) ?? null),
    verificationMethodId: (prof.verificationMethodId as string | null) ?? null,
    verificationReviewerId:
      (prof.verificationReviewerId as string | null) ?? null,
    riskReferences: (prof.riskReferences as string) ?? '',
    isEmployee: Boolean(row.is_employee),
    employeeRoleId: row.employee_role_id ?? null,
    departmentId: row.department_id ?? null,
  };

  if (prof.hasDateOfBirth !== false && (row.date_of_birth !== null || prof.hasDateOfBirth === true)) {
    out.dateOfBirth = row.date_of_birth;
  }
  if (row.employment_json !== null || prof.hasEmployment === true) {
    out.employment =
      row.employment_json !== null
        ? structuredClone(row.employment_json)
        : null;
  }
  if (row.permission_overrides_json !== null || prof.hasPermissionOverrides === true) {
    out.permissionOverrides =
      row.permission_overrides_json !== null
        ? structuredClone(row.permission_overrides_json)
        : null;
  }
  if (row.entra_object_id !== null || prof.hasEntraObjectId === true) {
    out.entraObjectId = row.entra_object_id;
  }
  if (Array.isArray(prof.employeePermissions)) {
    out.employeePermissions = [...(prof.employeePermissions as string[])];
  }
  if (Array.isArray(prof.documentPermissions)) {
    out.documentPermissions = [...(prof.documentPermissions as string[])];
  }
  if (row.app_role !== null || prof.hasAppRole === true) {
    out.appRole = row.app_role;
  }
  if (Array.isArray(row.roles_json)) {
    out.roles = [...row.roles_json];
  }
  if (typeof prof.demo === 'boolean') {
    out.demo = prof.demo;
  }
  if (prof.showsWorkOfId !== undefined) {
    out.showsWorkOfId = (prof.showsWorkOfId as string | null) ?? null;
  }
  if (Array.isArray(prof.supportsIds)) {
    out.supportsIds = [...(prof.supportsIds as string[])];
  }
  if (row.created_from_enquiry_id !== null || prof.hasCreatedFromEnquiryId === true) {
    out.createdFromEnquiryId = row.created_from_enquiry_id;
  }

  return out as TPerson;
}

function mapOrganisationRow<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
  row: DbOrganisationRow,
): TOrg {
  const prof = (row.profile_json ?? {}) as Record<string, unknown>;
  const out: TenantOrganisationRecord = {
    id: row.id,
    recordType: 'organisation',
    recordOwnerId: (prof.recordOwnerId as string | null) ?? null,
    recordStatusId: (prof.recordStatusId as string) ?? 'record_status.active',
    createdById: (prof.createdById as string) ?? 'system',
    createdAt: (prof.createdAt as string) ?? toIsoString(row.created_at),
    updatedById: (prof.updatedById as string) ?? 'system',
    updatedAt: (prof.updatedAt as string) ?? toIsoString(row.updated_at),
    sourceId: (prof.sourceId as string | null) ?? null,
    lastVerifiedAt: (prof.lastVerifiedAt as string | null) ?? null,
    tags: Array.isArray(prof.tags) ? [...(prof.tags as string[])] : [],
    duplicateStatusId:
      (prof.duplicateStatusId as string) ?? 'duplicate_status.unique',
    notDuplicateOf: Array.isArray(row.dismissed_duplicate_ids_json)
      ? [...row.dismissed_duplicate_ids_json]
      : [],
    possibleMatchIds: Array.isArray(prof.possibleMatchIds)
      ? [...(prof.possibleMatchIds as string[])]
      : [],
    mergedIntoId: row.merged_into_id ?? null,
    lastInteractionAt: (prof.lastInteractionAt as string | null) ?? null,
    customFields:
      row.custom_fields_json && typeof row.custom_fields_json === 'object'
        ? structuredClone(row.custom_fields_json)
        : {},
    legalName: row.legal_name ?? '',
    otherNames: Array.isArray(prof.otherNames)
      ? structuredClone(prof.otherNames as TenantOtherNameEntry[])
      : [],
    organisationTypeId: row.organisation_type_id ?? null,
    companyNumber: row.company_number ?? '',
    vatNumber: row.vat_number ?? '',
    countryOfRegistrationId:
      (prof.countryOfRegistrationId as string | null) ?? null,
    registeredAddress:
      row.registered_address_json !== null
        ? structuredClone(row.registered_address_json)
        : null,
    correspondenceAddress:
      row.trading_address_json !== null
        ? structuredClone(row.trading_address_json)
        : null,
    website: row.website ?? '',
    mainPhone: row.main_phone ?? '',
    generalEmail: row.general_email ?? '',
    parentOrganisationId: row.parent_organisation_id ?? null,
    relationshipPartnerId: row.relationship_partner_id ?? null,
    relationshipTypeIds: Array.isArray(row.relationship_type_ids_json)
      ? [...row.relationship_type_ids_json]
      : [],
    relationshipStatusId:
      row.client_status_id ??
      ((prof.relationshipStatusId as string | null) ?? null),
    relationshipStandingId:
      (prof.relationshipStandingId as string | null) ?? null,
    sectorId:
      Array.isArray(row.sector_ids_json) && row.sector_ids_json.length > 0
        ? (row.sector_ids_json[0] ?? null)
        : ((prof.sectorId as string | null) ?? null),
    clientTierId: (prof.clientTierId as string | null) ?? null,
    originId: (prof.originId as string | null) ?? null,
    relationshipStartedAt:
      (prof.relationshipStartedAt as string | null) ?? null,
    engagementLevelId: (prof.engagementLevelId as string | null) ?? null,
    pipelineStageId: (prof.pipelineStageId as string | null) ?? null,
    bdNotes: (prof.bdNotes as string) ?? '',
    clientReference: row.client_reference ?? '',
    onboardingStatusId: (prof.onboardingStatusId as string | null) ?? null,
    conflictStatusId:
      row.conflict_status ??
      ((prof.conflictStatusId as string | null) ?? null),
    conflictReference: (prof.conflictReference as string) ?? '',
    riskRatingId: (prof.riskRatingId as string | null) ?? null,
    riskAssessmentStatusId:
      (prof.riskAssessmentStatusId as string | null) ?? null,
    verificationStatusId:
      row.aml_status_id ??
      ((prof.verificationStatusId as string | null) ?? null),
    billingAddress:
      prof.billingAddress !== undefined && prof.billingAddress !== null
        ? structuredClone(prof.billingAddress as TenantAddressEntry)
        : null,
    invoicePreferenceId: (prof.invoicePreferenceId as string | null) ?? null,
    paymentTermsId: (prof.paymentTermsId as string | null) ?? null,
    creditControlNotes: (prof.creditControlNotes as string) ?? '',
    engagementTermsRef: (prof.engagementTermsRef as string) ?? '',
    reviewDate: (prof.reviewDate as string | null) ?? null,
    reviewerId: (prof.reviewerId as string | null) ?? null,
  };

  if (Array.isArray(prof.peopleWithSignificantControl)) {
    out.peopleWithSignificantControl = [
      ...(prof.peopleWithSignificantControl as string[]),
    ];
  }
  if (Array.isArray(prof.directors)) {
    out.directors = [...(prof.directors as string[])];
  }
  if (prof.conflictDecision !== undefined) {
    out.conflictDecision =
      prof.conflictDecision !== null
        ? structuredClone(prof.conflictDecision as Record<string, unknown>)
        : null;
  }
  if (row.created_from_enquiry_id !== null || prof.hasCreatedFromEnquiryId === true) {
    out.createdFromEnquiryId = row.created_from_enquiry_id;
  }

  return out as TOrg;
}

function mapLinkRow<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
  row: DbLinkRow,
): TLink {
  const prof = (row.profile_json ?? {}) as Record<string, unknown>;
  const out: TenantPersonOrganisationLinkRecord = {
    id: row.id,
    personId: row.person_id,
    organisationId: row.organisation_id,
    jobTitle: row.job_title ?? '',
    department: row.department ?? '',
    roleWithinOrganisation: row.role_within_organisation ?? '',
    contactRoleIds: Array.isArray(row.contact_role_ids_json)
      ? [...row.contact_role_ids_json]
      : [],
    isPrimaryContact: Boolean(row.is_primary_contact),
    isCurrent: Boolean(row.is_current),
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    contactStatusId: row.contact_status_id ?? null,
    createdById: (prof.createdById as string) ?? 'system',
    createdAt: (prof.createdAt as string) ?? toIsoString(row.created_at),
    updatedById: (prof.updatedById as string) ?? 'system',
    updatedAt: (prof.updatedAt as string) ?? toIsoString(row.updated_at),
  };
  return out as TLink;
}

function mapNoteRow<TNote extends TenantNoteRecord = TenantNoteRecord>(
  row: DbNoteRow,
): TNote {
  const out: TenantNoteRecord = {
    id: row.id,
    recordType: row.record_type as TenantNoteRecord['recordType'],
    recordId: row.record_id,
    authorId: row.created_by_id,
    at: toIsoString(row.created_at),
    text: row.body ?? '',
    ...(row.merged_from_id !== null ? { mergedFromId: row.merged_from_id } : {}),
  };
  return out as TNote;
}

function mapMergeHistoryRow<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
  row: DbMergeHistoryRow,
): TMerge {
  const summary =
    row.summary_json && typeof row.summary_json === 'object'
      ? structuredClone(row.summary_json)
      : ({} as Partial<TenantMergeHistoryRecord>);
  const out: TenantMergeHistoryRecord = {
    id: row.id,
    recordType: (row.record_type as 'person' | 'organisation') ?? 'person',
    survivorId: row.survivor_id,
    mergedId: row.merged_id,
    mergedLabel: summary.mergedLabel ?? row.merged_id,
    byId: row.merged_by_id,
    at: summary.at ?? toIsoString(row.merged_at),
    fieldsTaken: Array.isArray(summary.fieldsTaken)
      ? [...summary.fieldsTaken]
      : [],
    ...(Array.isArray(summary.pmsLinkConflicts)
      ? { pmsLinkConflicts: structuredClone(summary.pmsLinkConflicts) }
      : {}),
  };
  return out as TMerge;
}

export class TenantPartyRepository extends TenantScopedRepository {
  // ============================================================================
  // Per-Tenant Sequence Allocation (`P-`, `O-`, `L-`, `N-`, `MRG-`)
  // ============================================================================

  private async allocateSequenceIdsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    params: {
      prefix: 'P' | 'O' | 'L' | 'N' | 'MRG';
      sequenceName: string;
      tableName: string;
      regexPattern: string;
      substringStart: number;
      count: number;
    },
  ): Promise<string[]> {
    const n = Math.max(0, Math.floor(params.count));
    if (n === 0) return [];

    const maxRes = await tx.query<{ max_num: string | number }>(
      `SELECT GREATEST(
         COALESCE(
           (SELECT MAX(CASE WHEN id ~ $2 THEN SUBSTRING(id FROM ${params.substringStart})::bigint ELSE 0 END)
            FROM public.${params.tableName}
            WHERE tenant_id = $1),
           0
         ),
         COALESCE(
           (SELECT last_value FROM public.tenant_record_sequences WHERE tenant_id = $1 AND counter_key = $3),
           0
         )
       ) AS max_num`,
      [ctx.tenantId, params.regexPattern, params.prefix],
    );
    let currentHigh = Number(maxRes.rows[0]?.max_num ?? 0);

    const allocated: string[] = [];
    for (let i = 0; i < n; i++) {
      let seqVal = 0;
      do {
        const nextRes = await tx.query<{ val: string | number }>(
          `SELECT nextval('public.${params.sequenceName}')::bigint AS val`,
        );
        seqVal = Number(nextRes.rows[0]?.val ?? 1);
      } while (seqVal <= currentHigh);
      currentHigh = seqVal;
      allocated.push(`${params.prefix}-${String(seqVal).padStart(6, '0')}`);
    }

    await tx.query(
      `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
       VALUES ($1, $2, $3::bigint)
       ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
         last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
      [ctx.tenantId, params.prefix, currentHigh],
    );

    return allocated;
  }

  public async allocateNextPersonId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextPersonIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextPersonIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateSequenceIdsInTx(tx, ctx, {
        prefix: 'P',
        sequenceName: 'tenant_person_id_seq',
        tableName: 'people',
        regexPattern: '^P-[0-9]+$',
        substringStart: 3,
        count,
      }),
    );
  }

  public async allocateNextOrganisationId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextOrganisationIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextOrganisationIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateSequenceIdsInTx(tx, ctx, {
        prefix: 'O',
        sequenceName: 'tenant_organisation_id_seq',
        tableName: 'organisations',
        regexPattern: '^O-[0-9]+$',
        substringStart: 3,
        count,
      }),
    );
  }

  public async allocateNextLinkId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextLinkIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextLinkIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateSequenceIdsInTx(tx, ctx, {
        prefix: 'L',
        sequenceName: 'tenant_link_id_seq',
        tableName: 'person_organisation_links',
        regexPattern: '^L-[0-9]+$',
        substringStart: 3,
        count,
      }),
    );
  }

  public async allocateNextNoteId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextNoteIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextNoteIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateSequenceIdsInTx(tx, ctx, {
        prefix: 'N',
        sequenceName: 'tenant_note_id_seq',
        tableName: 'notes',
        regexPattern: '^N-[0-9]+$',
        substringStart: 3,
        count,
      }),
    );
  }

  public async allocateNextMergeHistoryId(ctx: TenantContext): Promise<string> {
    const ids = await this.allocateNextMergeHistoryIds(ctx, 1);
    return ids[0]!;
  }

  public async allocateNextMergeHistoryIds(
    ctx: TenantContext,
    count: number,
  ): Promise<string[]> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.allocateSequenceIdsInTx(tx, ctx, {
        prefix: 'MRG',
        sequenceName: 'tenant_merge_history_id_seq',
        tableName: 'merge_history',
        regexPattern: '^MRG-[0-9]+$',
        substringStart: 5,
        count,
      }),
    );
  }

  // ============================================================================
  // People & `person_emails` (`R410`)
  // ============================================================================

  private async syncPersonEmailsInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    person: TenantPersonRecord,
  ): Promise<void> {
    await tx.query(
      'DELETE FROM public.person_emails WHERE tenant_id = $1 AND person_id = $2',
      [ctx.tenantId, person.id],
    );

    const isTombstoned = Boolean(person.mergedIntoId);
    const contactEmailsByLower = new Map<
      string,
      { isPrimary: boolean; active: boolean }
    >();

    for (const entry of person.emails ?? []) {
      const lower = entry.address?.trim().toLowerCase();
      if (!lower) continue;
      const entryActive = !isTombstoned && entry.active !== false;
      const entryPrimary = Boolean(entry.isPrimary);
      const existing = contactEmailsByLower.get(lower);
      if (!existing) {
        contactEmailsByLower.set(lower, {
          isPrimary: entryPrimary,
          active: entryActive,
        });
      } else {
        contactEmailsByLower.set(lower, {
          isPrimary: existing.isPrimary || entryPrimary,
          active: existing.active || entryActive,
        });
      }
    }

    for (const [emailLower, meta] of contactEmailsByLower.entries()) {
      await tx.query(
        `INSERT INTO public.person_emails (
           tenant_id, person_id, email_lower, source, is_primary, active, updated_at
         ) VALUES ($1, $2, $3, 'contact_email', $4, $5, NOW())
         ON CONFLICT (tenant_id, person_id, email_lower, source) DO UPDATE SET
           is_primary = EXCLUDED.is_primary,
           active = EXCLUDED.active,
           updated_at = NOW()`,
        [ctx.tenantId, person.id, emailLower, meta.isPrimary, meta.active],
      );
    }

    const employment = person.employment as
      | {
          status?: string;
          systems?: { firmWorkEmail?: string | null } | null;
        }
      | null
      | undefined;
    const firmWorkEmailLower =
      employment?.systems?.firmWorkEmail?.trim().toLowerCase() ?? '';
    if (firmWorkEmailLower) {
      const isActiveWorkEmail =
        !isTombstoned && employment?.status !== 'Leaver';
      await tx.query(
        `INSERT INTO public.person_emails (
           tenant_id, person_id, email_lower, source, is_primary, active, updated_at
         ) VALUES ($1, $2, $3, 'firm_work_email', FALSE, $4, NOW())
         ON CONFLICT (tenant_id, person_id, email_lower, source) DO UPDATE SET
           active = EXCLUDED.active,
           updated_at = NOW()`,
        [ctx.tenantId, person.id, firmWorkEmailLower, isActiveWorkEmail],
      );
    }
  }

  private async upsertPersonInTx<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    person: TPerson,
  ): Promise<TPerson> {
    const employment = (person.employment ?? null) as Record<string, unknown> | null;
    const feeEarner = (employment?.feeEarner ?? null) as Record<string, unknown> | null;
    const rightToWork = (employment?.rightToWork ?? null) as Record<string, unknown> | null;
    const roleType = employment?.roleType as string | undefined;

    const officeId = (employment?.officeId as string | null) ?? null;
    const supervisorId =
      (employment?.supervisingPartnerId as string | null) ??
      (employment?.lineManagerId as string | null) ??
      null;
    const isFeeEarner = Boolean(
      roleType === 'Fee earner' ||
        roleType === 'Partner/Member' ||
        feeEarner !== null,
    );
    const defaultHourlyRateGbp =
      typeof feeEarner?.chargeOutRateGbp === 'number'
        ? feeEarner.chargeOutRateGbp
        : null;
    const idExpiryDate = (rightToWork?.expiryDate as string | null) ?? null;

    const profileJson: Record<string, unknown> = {
      recordOwnerId: person.recordOwnerId ?? null,
      recordStatusId: person.recordStatusId ?? 'record_status.active',
      createdById: person.createdById ?? 'system',
      createdAt: person.createdAt,
      updatedById: person.updatedById ?? 'system',
      updatedAt: person.updatedAt,
      sourceId: person.sourceId ?? null,
      lastVerifiedAt: person.lastVerifiedAt ?? null,
      tags: person.tags ?? [],
      duplicateStatusId: person.duplicateStatusId ?? 'duplicate_status.unique',
      possibleMatchIds: person.possibleMatchIds ?? [],
      lastInteractionAt: person.lastInteractionAt ?? null,
      middleNames: person.middleNames ?? '',
      otherNames: person.otherNames ?? [],
      preferredContactMethodId: person.preferredContactMethodId ?? null,
      preferredLanguageId: person.preferredLanguageId ?? null,
      website: person.website ?? '',
      relationshipOwnerId: person.relationshipOwnerId ?? null,
      relationshipStatusId: person.relationshipStatusId ?? null,
      relationshipStandingId: person.relationshipStandingId ?? null,
      originId: person.originId ?? null,
      firstKnownAt: person.firstKnownAt ?? null,
      engagementLevelId: person.engagementLevelId ?? null,
      interests: person.interests ?? '',
      relationshipNotes: person.relationshipNotes ?? '',
      marketingConsentId: person.marketingConsentId ?? null,
      consentRecord: person.consentRecord ?? '',
      verificationStatusId: person.verificationStatusId ?? null,
      verifiedAt: person.verifiedAt ?? null,
      verificationMethodId: person.verificationMethodId ?? null,
      verificationReviewerId: person.verificationReviewerId ?? null,
      riskReferences: person.riskReferences ?? '',
      hasDateOfBirth: Object.prototype.hasOwnProperty.call(person, 'dateOfBirth'),
      hasEmployment: Object.prototype.hasOwnProperty.call(person, 'employment'),
      hasPermissionOverrides: Object.prototype.hasOwnProperty.call(
        person,
        'permissionOverrides',
      ),
      hasEntraObjectId: Object.prototype.hasOwnProperty.call(
        person,
        'entraObjectId',
      ),
      hasAppRole: Object.prototype.hasOwnProperty.call(person, 'appRole'),
      hasCreatedFromEnquiryId: Object.prototype.hasOwnProperty.call(
        person,
        'createdFromEnquiryId',
      ),
      ...(person.employeePermissions !== undefined
        ? { employeePermissions: person.employeePermissions }
        : {}),
      ...(person.documentPermissions !== undefined
        ? { documentPermissions: person.documentPermissions }
        : {}),
      ...(person.demo !== undefined ? { demo: person.demo } : {}),
      ...(person.showsWorkOfId !== undefined
        ? { showsWorkOfId: person.showsWorkOfId }
        : {}),
      ...(person.supportsIds !== undefined
        ? { supportsIds: person.supportsIds }
        : {}),
    };

    const otherNamesSummary = (person.otherNames ?? [])
      .map((o) => o.name)
      .filter(Boolean)
      .join('; ');
    const cleanEntraOid = person.entraObjectId?.trim() || null;

    const res = await tx.query<DbPersonRow>(
      `INSERT INTO public.people (
         tenant_id, id, first_name, preferred_name, other_names, surname,
         title_id, date_of_birth, is_employee, employee_role_id, app_role,
         entra_object_id, primary_email_lower, job_title, department_id,
         office_id, supervisor_id, is_fee_earner, default_hourly_rate_gbp,
         client_status_id, aml_status_id, id_verified_on, id_expiry_date,
         created_from_enquiry_id, merged_into_id, created_at, updated_at,
         emails_json, phones_json, addresses_json, relationship_role_ids_json,
         roles_json, permission_overrides_json, dismissed_duplicate_ids_json,
         custom_fields_json, profile_json, employment_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21, $22, $23,
         $24, $25, $26::timestamptz, $27::timestamptz,
         $28::jsonb, $29::jsonb, $30::jsonb, $31::jsonb,
         $32::jsonb, $33::jsonb, $34::jsonb,
         $35::jsonb, $36::jsonb, $37::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         preferred_name = EXCLUDED.preferred_name,
         other_names = EXCLUDED.other_names,
         surname = EXCLUDED.surname,
         title_id = EXCLUDED.title_id,
         date_of_birth = EXCLUDED.date_of_birth,
         is_employee = EXCLUDED.is_employee,
         employee_role_id = EXCLUDED.employee_role_id,
         app_role = EXCLUDED.app_role,
         entra_object_id = EXCLUDED.entra_object_id,
         primary_email_lower = EXCLUDED.primary_email_lower,
         job_title = EXCLUDED.job_title,
         department_id = EXCLUDED.department_id,
         office_id = EXCLUDED.office_id,
         supervisor_id = EXCLUDED.supervisor_id,
         is_fee_earner = EXCLUDED.is_fee_earner,
         default_hourly_rate_gbp = EXCLUDED.default_hourly_rate_gbp,
         client_status_id = EXCLUDED.client_status_id,
         aml_status_id = EXCLUDED.aml_status_id,
         id_verified_on = EXCLUDED.id_verified_on,
         id_expiry_date = EXCLUDED.id_expiry_date,
         created_from_enquiry_id = EXCLUDED.created_from_enquiry_id,
         merged_into_id = EXCLUDED.merged_into_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         emails_json = EXCLUDED.emails_json,
         phones_json = EXCLUDED.phones_json,
         addresses_json = EXCLUDED.addresses_json,
         relationship_role_ids_json = EXCLUDED.relationship_role_ids_json,
         roles_json = EXCLUDED.roles_json,
         permission_overrides_json = EXCLUDED.permission_overrides_json,
         dismissed_duplicate_ids_json = EXCLUDED.dismissed_duplicate_ids_json,
         custom_fields_json = EXCLUDED.custom_fields_json,
         profile_json = EXCLUDED.profile_json,
         employment_json = EXCLUDED.employment_json
       RETURNING *`,
      [
        ctx.tenantId,
        person.id,
        person.firstName ?? '',
        person.preferredName ?? '',
        otherNamesSummary,
        person.surname ?? '',
        person.titleId ?? null,
        person.dateOfBirth ?? null,
        Boolean(person.isEmployee),
        person.employeeRoleId ?? null,
        person.appRole ?? null,
        cleanEntraOid,
        resolvePrimaryEmailLower(person.emails),
        person.jobTitle ?? '',
        person.departmentId ?? null,
        officeId,
        supervisorId,
        isFeeEarner,
        defaultHourlyRateGbp,
        person.relationshipStatusId ?? null,
        person.verificationStatusId ?? null,
        person.verifiedAt ?? null,
        idExpiryDate,
        person.createdFromEnquiryId ?? null,
        person.mergedIntoId ?? null,
        safePgTimestampIso(person.createdAt),
        safePgTimestampIso(person.updatedAt),
        JSON.stringify(person.emails ?? []),
        JSON.stringify(person.phones ?? []),
        JSON.stringify(person.addresses ?? []),
        JSON.stringify(person.relationshipRoleIds ?? []),
        person.roles !== undefined ? JSON.stringify(person.roles) : null,
        person.permissionOverrides !== undefined &&
        person.permissionOverrides !== null
          ? JSON.stringify(person.permissionOverrides)
          : null,
        JSON.stringify(person.notDuplicateOf ?? []),
        JSON.stringify(person.customFields ?? {}),
        JSON.stringify(profileJson),
        person.employment !== undefined && person.employment !== null
          ? JSON.stringify(person.employment)
          : null,
      ],
    );

    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Person row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'Person');
    await this.syncPersonEmailsInTx(tx, ctx, person);
    return mapPersonRow<TPerson>(saved);
  }

  public async putPerson<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    person: TPerson,
  ): Promise<TPerson> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.upsertPersonInTx<TPerson>(tx, ctx, person),
    );
  }

  public async putPeople<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    people: readonly TPerson[],
  ): Promise<TPerson[]> {
    if (people.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TPerson[] = [];
      let maxNum = 0;
      for (const person of people) {
        out.push(await this.upsertPersonInTx<TPerson>(tx, ctx, person));
        const match = /^P-(\d+)$/.exec(person.id);
        if (match?.[1]) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      if (maxNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'P', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxNum],
        );
      }
      return out;
    });
  }

  public async getPersonById<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    id: string,
  ): Promise<TPerson | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonRow>(
        'SELECT * FROM public.people WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'Person');
      return mapPersonRow<TPerson>(row);
    });
  }

  public async getPersonByEntraObjectId<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    entraObjectId: string,
  ): Promise<TPerson | null> {
    const cleanOid = entraObjectId?.trim();
    if (!cleanOid) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonRow>(
        `SELECT *
         FROM public.people
         WHERE tenant_id = $1
           AND lower(entra_object_id) = lower($2)
           AND merged_into_id IS NULL
         ORDER BY id ASC
         LIMIT 1`,
        [ctx.tenantId, cleanOid],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'Person');
      return mapPersonRow<TPerson>(row);
    });
  }

  public async findActivePeopleByEmail<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    email: string,
  ): Promise<TPerson[]> {
    const cleanLower = email?.trim().toLowerCase();
    if (!cleanLower) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonRow>(
        `SELECT p.*
         FROM public.people p
         WHERE p.tenant_id = $1
           AND p.merged_into_id IS NULL
           AND EXISTS (
             SELECT 1
             FROM public.person_emails pe
             WHERE pe.tenant_id = p.tenant_id
               AND pe.person_id = p.id
               AND pe.email_lower = $2
               AND pe.active = TRUE
           )
         ORDER BY p.id ASC`,
        [ctx.tenantId, cleanLower],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Person');
        return mapPersonRow<TPerson>(row);
      });
    });
  }

  public async listPersonEmails(
    ctx: TenantContext,
    personId: string,
  ): Promise<TenantPersonEmailRow[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        tenant_id: string;
        person_id: string;
        email_lower: string;
        source: 'contact_email' | 'firm_work_email';
        is_primary: boolean;
        active: boolean;
        updated_at: Date | string;
      }>(
        `SELECT *
         FROM public.person_emails
         WHERE tenant_id = $1 AND person_id = $2
         ORDER BY email_lower ASC, source ASC`,
        [ctx.tenantId, personId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'PersonEmail');
        return {
          tenantId: row.tenant_id,
          personId: row.person_id,
          emailLower: row.email_lower,
          source: row.source,
          isPrimary: Boolean(row.is_primary),
          active: Boolean(row.active),
          updatedAt: toIsoString(row.updated_at),
        };
      });
    });
  }

  public async listAllPeople<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    options?: { includeMerged?: boolean; employeesOnly?: boolean },
  ): Promise<TPerson[]> {
    const includeMerged = options?.includeMerged ?? true;
    const employeesOnly = options?.employeesOnly ?? false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      if (!includeMerged) {
        clauses.push('merged_into_id IS NULL');
      }
      if (employeesOnly) {
        clauses.push('is_employee = TRUE');
      }
      const res = await tx.query<DbPersonRow>(
        `SELECT *
         FROM public.people
         WHERE ${clauses.join(' AND ')}
         ORDER BY id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Person');
        return mapPersonRow<TPerson>(row);
      });
    });
  }

  public async deletePersonById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.person_emails WHERE tenant_id = $1 AND person_id = $2',
        [ctx.tenantId, id],
      );
      const del = await tx.query(
        'DELETE FROM public.people WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Organisations
  // ============================================================================

  private async upsertOrganisationInTx<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    org: TOrg,
  ): Promise<TOrg> {
    const profileJson: Record<string, unknown> = {
      recordOwnerId: org.recordOwnerId ?? null,
      recordStatusId: org.recordStatusId ?? 'record_status.active',
      createdById: org.createdById ?? 'system',
      createdAt: org.createdAt,
      updatedById: org.updatedById ?? 'system',
      updatedAt: org.updatedAt,
      sourceId: org.sourceId ?? null,
      lastVerifiedAt: org.lastVerifiedAt ?? null,
      tags: org.tags ?? [],
      duplicateStatusId: org.duplicateStatusId ?? 'duplicate_status.unique',
      possibleMatchIds: org.possibleMatchIds ?? [],
      lastInteractionAt: org.lastInteractionAt ?? null,
      otherNames: org.otherNames ?? [],
      countryOfRegistrationId: org.countryOfRegistrationId ?? null,
      relationshipStatusId: org.relationshipStatusId ?? null,
      relationshipStandingId: org.relationshipStandingId ?? null,
      sectorId: org.sectorId ?? null,
      clientTierId: org.clientTierId ?? null,
      originId: org.originId ?? null,
      relationshipStartedAt: org.relationshipStartedAt ?? null,
      engagementLevelId: org.engagementLevelId ?? null,
      pipelineStageId: org.pipelineStageId ?? null,
      bdNotes: org.bdNotes ?? '',
      onboardingStatusId: org.onboardingStatusId ?? null,
      conflictStatusId: org.conflictStatusId ?? null,
      conflictReference: org.conflictReference ?? '',
      riskRatingId: org.riskRatingId ?? null,
      riskAssessmentStatusId: org.riskAssessmentStatusId ?? null,
      verificationStatusId: org.verificationStatusId ?? null,
      billingAddress: org.billingAddress ?? null,
      invoicePreferenceId: org.invoicePreferenceId ?? null,
      paymentTermsId: org.paymentTermsId ?? null,
      creditControlNotes: org.creditControlNotes ?? '',
      engagementTermsRef: org.engagementTermsRef ?? '',
      reviewDate: org.reviewDate ?? null,
      reviewerId: org.reviewerId ?? null,
      hasCreatedFromEnquiryId: Object.prototype.hasOwnProperty.call(
        org,
        'createdFromEnquiryId',
      ),
      ...(org.peopleWithSignificantControl !== undefined
        ? { peopleWithSignificantControl: org.peopleWithSignificantControl }
        : {}),
      ...(org.directors !== undefined ? { directors: org.directors } : {}),
      ...(org.conflictDecision !== undefined
        ? { conflictDecision: org.conflictDecision }
        : {}),
    };

    const tradingName = org.otherNames?.[0]?.name ?? '';
    const sectorIds = org.sectorId ? [org.sectorId] : [];

    const res = await tx.query<DbOrganisationRow>(
      `INSERT INTO public.organisations (
         tenant_id, id, legal_name, trading_name, organisation_type_id,
         company_number, vat_number, client_reference, general_email,
         main_phone, website, parent_organisation_id, relationship_partner_id,
         conflict_status, aml_status_id, client_status_id, created_from_enquiry_id,
         merged_into_id, created_at, updated_at, registered_address_json,
         trading_address_json, relationship_type_ids_json, sector_ids_json,
         dismissed_duplicate_ids_json, custom_fields_json, profile_json
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16, $17,
         $18, $19::timestamptz, $20::timestamptz, $21::jsonb,
         $22::jsonb, $23::jsonb, $24::jsonb,
         $25::jsonb, $26::jsonb, $27::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         legal_name = EXCLUDED.legal_name,
         trading_name = EXCLUDED.trading_name,
         organisation_type_id = EXCLUDED.organisation_type_id,
         company_number = EXCLUDED.company_number,
         vat_number = EXCLUDED.vat_number,
         client_reference = EXCLUDED.client_reference,
         general_email = EXCLUDED.general_email,
         main_phone = EXCLUDED.main_phone,
         website = EXCLUDED.website,
         parent_organisation_id = EXCLUDED.parent_organisation_id,
         relationship_partner_id = EXCLUDED.relationship_partner_id,
         conflict_status = EXCLUDED.conflict_status,
         aml_status_id = EXCLUDED.aml_status_id,
         client_status_id = EXCLUDED.client_status_id,
         created_from_enquiry_id = EXCLUDED.created_from_enquiry_id,
         merged_into_id = EXCLUDED.merged_into_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         registered_address_json = EXCLUDED.registered_address_json,
         trading_address_json = EXCLUDED.trading_address_json,
         relationship_type_ids_json = EXCLUDED.relationship_type_ids_json,
         sector_ids_json = EXCLUDED.sector_ids_json,
         dismissed_duplicate_ids_json = EXCLUDED.dismissed_duplicate_ids_json,
         custom_fields_json = EXCLUDED.custom_fields_json,
         profile_json = EXCLUDED.profile_json
       RETURNING *`,
      [
        ctx.tenantId,
        org.id,
        org.legalName ?? '',
        tradingName,
        org.organisationTypeId ?? null,
        org.companyNumber ?? '',
        org.vatNumber ?? '',
        org.clientReference ?? '',
        org.generalEmail ?? '',
        org.mainPhone ?? '',
        org.website ?? '',
        org.parentOrganisationId ?? null,
        org.relationshipPartnerId ?? null,
        org.conflictStatusId ?? null,
        org.verificationStatusId ?? null,
        org.relationshipStatusId ?? null,
        org.createdFromEnquiryId ?? null,
        org.mergedIntoId ?? null,
        safePgTimestampIso(org.createdAt),
        safePgTimestampIso(org.updatedAt),
        org.registeredAddress ? JSON.stringify(org.registeredAddress) : null,
        org.correspondenceAddress
          ? JSON.stringify(org.correspondenceAddress)
          : null,
        JSON.stringify(org.relationshipTypeIds ?? []),
        JSON.stringify(sectorIds),
        JSON.stringify(org.notDuplicateOf ?? []),
        JSON.stringify(org.customFields ?? {}),
        JSON.stringify(profileJson),
      ],
    );

    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Organisation row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'Organisation');
    return mapOrganisationRow<TOrg>(saved);
  }

  public async putOrganisation<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    org: TOrg,
  ): Promise<TOrg> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.upsertOrganisationInTx<TOrg>(tx, ctx, org),
    );
  }

  public async putOrganisations<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    orgs: readonly TOrg[],
  ): Promise<TOrg[]> {
    if (orgs.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TOrg[] = [];
      let maxNum = 0;
      for (const org of orgs) {
        out.push(await this.upsertOrganisationInTx<TOrg>(tx, ctx, org));
        const match = /^O-(\d+)$/.exec(org.id);
        if (match?.[1]) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      if (maxNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'O', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxNum],
        );
      }
      return out;
    });
  }

  public async getOrganisationById<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    id: string,
  ): Promise<TOrg | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbOrganisationRow>(
        'SELECT * FROM public.organisations WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
      return mapOrganisationRow<TOrg>(row);
    });
  }

  public async listAllOrganisations<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    options?: { includeMerged?: boolean },
  ): Promise<TOrg[]> {
    const includeMerged = options?.includeMerged ?? true;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbOrganisationRow>(
        includeMerged
          ? 'SELECT * FROM public.organisations WHERE tenant_id = $1 ORDER BY id ASC'
          : 'SELECT * FROM public.organisations WHERE tenant_id = $1 AND merged_into_id IS NULL ORDER BY id ASC',
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
        return mapOrganisationRow<TOrg>(row);
      });
    });
  }

  public async deleteOrganisationById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.organisations WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Person–Organisation Links (`person_organisation_links`)
  // ============================================================================

  private async upsertLinkInTx<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    link: TLink,
  ): Promise<TLink> {
    const profileJson = {
      createdById: link.createdById ?? 'system',
      createdAt: link.createdAt,
      updatedById: link.updatedById ?? 'system',
      updatedAt: link.updatedAt,
    };

    const res = await tx.query<DbLinkRow>(
      `INSERT INTO public.person_organisation_links (
         tenant_id, id, person_id, organisation_id, job_title, department,
         role_within_organisation, is_primary_contact, is_current, start_date,
         end_date, contact_status_id, notes, created_at, updated_at,
         contact_role_ids_json, profile_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, '', $13::timestamptz, $14::timestamptz,
         $15::jsonb, $16::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         person_id = EXCLUDED.person_id,
         organisation_id = EXCLUDED.organisation_id,
         job_title = EXCLUDED.job_title,
         department = EXCLUDED.department,
         role_within_organisation = EXCLUDED.role_within_organisation,
         is_primary_contact = EXCLUDED.is_primary_contact,
         is_current = EXCLUDED.is_current,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         contact_status_id = EXCLUDED.contact_status_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         contact_role_ids_json = EXCLUDED.contact_role_ids_json,
         profile_json = EXCLUDED.profile_json
       RETURNING *`,
      [
        ctx.tenantId,
        link.id,
        link.personId,
        link.organisationId,
        link.jobTitle ?? '',
        link.department ?? '',
        link.roleWithinOrganisation ?? '',
        Boolean(link.isPrimaryContact),
        Boolean(link.isCurrent),
        link.startDate ?? null,
        link.endDate ?? null,
        link.contactStatusId ?? null,
        safePgTimestampIso(link.createdAt),
        safePgTimestampIso(link.updatedAt),
        JSON.stringify(link.contactRoleIds ?? []),
        JSON.stringify(profileJson),
      ],
    );

    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: PersonOrganisationLink row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'PersonOrganisationLink');
    return mapLinkRow<TLink>(saved);
  }

  public async putLink<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    link: TLink,
  ): Promise<TLink> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.upsertLinkInTx<TLink>(tx, ctx, link),
    );
  }

  public async putLinks<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    links: readonly TLink[],
  ): Promise<TLink[]> {
    if (links.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TLink[] = [];
      let maxNum = 0;
      for (const link of links) {
        out.push(await this.upsertLinkInTx<TLink>(tx, ctx, link));
        const match = /^L-(\d+)$/.exec(link.id);
        if (match?.[1]) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      if (maxNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'L', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxNum],
        );
      }
      return out;
    });
  }

  public async getLinkById<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    id: string,
  ): Promise<TLink | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbLinkRow>(
        'SELECT * FROM public.person_organisation_links WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'PersonOrganisationLink');
      return mapLinkRow<TLink>(row);
    });
  }

  public async listAllLinks<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    filter?: { personId?: string; organisationId?: string },
  ): Promise<TLink[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.personId) {
        values.push(filter.personId);
        clauses.push(`person_id = $${values.length}`);
      }
      if (filter?.organisationId) {
        values.push(filter.organisationId);
        clauses.push(`organisation_id = $${values.length}`);
      }
      const res = await tx.query<DbLinkRow>(
        `SELECT *
         FROM public.person_organisation_links
         WHERE ${clauses.join(' AND ')}
         ORDER BY id ASC`,
        values,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'PersonOrganisationLink');
        return mapLinkRow<TLink>(row);
      });
    });
  }

  public async deleteLinkById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.person_organisation_links WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  public async deleteLink(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.deleteLinkById(ctx, id);
  }

  public async listLinksForPerson<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    personId: string,
  ): Promise<TLink[]> {
    return this.listAllLinks<TLink>(ctx, { personId });
  }

  // ============================================================================
  // Notes (`notes`)
  // ============================================================================

  private async upsertNoteInTx<TNote extends TenantNoteRecord = TenantNoteRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    note: TNote,
  ): Promise<TNote> {
    const safeAt = safePgTimestampIso(note.at);
    const res = await tx.query<DbNoteRow>(
      `INSERT INTO public.notes (
         tenant_id, id, record_type, record_id, body, visibility,
         pinned, created_by_id, merged_from_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'standard',
         FALSE, $6, $7, $8::timestamptz, $8::timestamptz
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         record_type = EXCLUDED.record_type,
         record_id = EXCLUDED.record_id,
         body = EXCLUDED.body,
         created_by_id = EXCLUDED.created_by_id,
         merged_from_id = EXCLUDED.merged_from_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        ctx.tenantId,
        note.id,
        note.recordType,
        note.recordId,
        note.text ?? '',
        note.authorId ?? 'system',
        note.mergedFromId ?? null,
        safeAt,
      ],
    );
    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Note row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'Note');
    return mapNoteRow<TNote>(saved);
  }

  public async putNote<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    note: TNote,
  ): Promise<TNote> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.upsertNoteInTx<TNote>(tx, ctx, note),
    );
  }

  public async putNotes<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    notes: readonly TNote[],
  ): Promise<TNote[]> {
    if (notes.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TNote[] = [];
      let maxNum = 0;
      for (const note of notes) {
        out.push(await this.upsertNoteInTx<TNote>(tx, ctx, note));
        const match = /^N-(\d+)$/.exec(note.id);
        if (match?.[1]) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      if (maxNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'N', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxNum],
        );
      }
      return out;
    });
  }

  public async getNoteById<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    id: string,
  ): Promise<TNote | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbNoteRow>(
        'SELECT * FROM public.notes WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'Note');
      return mapNoteRow<TNote>(row);
    });
  }

  public async listAllNotes<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    filter?: { recordType?: string; recordId?: string },
  ): Promise<TNote[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.recordType) {
        values.push(filter.recordType);
        clauses.push(`record_type = $${values.length}`);
      }
      if (filter?.recordId) {
        values.push(filter.recordId);
        clauses.push(`record_id = $${values.length}`);
      }
      const res = await tx.query<DbNoteRow>(
        `SELECT *
         FROM public.notes
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC`,
        values,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Note');
        return mapNoteRow<TNote>(row);
      });
    });
  }

  public async listNotesForRecord<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    recordType: string,
    recordId: string,
  ): Promise<TNote[]> {
    return this.listAllNotes<TNote>(ctx, { recordType, recordId });
  }

  public async deleteNoteById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.notes WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  // ============================================================================
  // Merge History (`merge_history`)
  // ============================================================================

  private async upsertMergeHistoryInTx<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    record: TMerge,
  ): Promise<TMerge> {
    const safeAt = safePgTimestampIso(record.at);
    const res = await tx.query<DbMergeHistoryRow>(
      `INSERT INTO public.merge_history (
         tenant_id, id, record_type, survivor_id, merged_id,
         merged_by_id, merged_at, summary_json
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7::timestamptz, $8::jsonb
       )
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         record_type = EXCLUDED.record_type,
         survivor_id = EXCLUDED.survivor_id,
         merged_id = EXCLUDED.merged_id,
         merged_by_id = EXCLUDED.merged_by_id,
         merged_at = EXCLUDED.merged_at,
         summary_json = EXCLUDED.summary_json
       RETURNING *`,
      [
        ctx.tenantId,
        record.id,
        record.recordType,
        record.survivorId,
        record.mergedId,
        record.byId,
        safeAt,
        JSON.stringify(record),
      ],
    );
    const saved = res.rows[0];
    if (!saved) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: MergeHistory row could not be persisted.',
      );
    }
    this.assertRowTenant(ctx, saved.tenant_id, 'MergeHistory');
    return mapMergeHistoryRow<TMerge>(saved);
  }

  public async deleteMergeHistoryById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const del = await tx.query(
        'DELETE FROM public.merge_history WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      );
      return del.rowCount > 0;
    });
  }

  public async putMergeHistory<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
    ctx: TenantContext,
    record: TMerge,
  ): Promise<TMerge> {
    return this.withTenantTransaction(ctx, (tx) =>
      this.upsertMergeHistoryInTx<TMerge>(tx, ctx, record),
    );
  }

  public async putMergeHistoryRecords<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
    ctx: TenantContext,
    records: readonly TMerge[],
  ): Promise<TMerge[]> {
    if (records.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TMerge[] = [];
      let maxNum = 0;
      for (const rec of records) {
        out.push(await this.upsertMergeHistoryInTx<TMerge>(tx, ctx, rec));
        const match = /^MRG-(\d+)$/.exec(rec.id);
        if (match?.[1]) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      if (maxNum > 0) {
        await tx.query(
          `INSERT INTO public.tenant_record_sequences (tenant_id, counter_key, last_value)
           VALUES ($1, 'MRG', $2::bigint)
           ON CONFLICT (tenant_id, counter_key) DO UPDATE SET
             last_value = GREATEST(public.tenant_record_sequences.last_value, EXCLUDED.last_value)`,
          [ctx.tenantId, maxNum],
        );
      }
      return out;
    });
  }

  public async listAllMergeHistory<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
    ctx: TenantContext,
    filter?: { recordType?: string; survivorId?: string; mergedId?: string },
  ): Promise<TMerge[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['tenant_id = $1'];
      const values: unknown[] = [ctx.tenantId];
      if (filter?.recordType) {
        values.push(filter.recordType);
        clauses.push(`record_type = $${values.length}`);
      }
      if (filter?.survivorId) {
        values.push(filter.survivorId);
        clauses.push(`survivor_id = $${values.length}`);
      }
      if (filter?.mergedId) {
        values.push(filter.mergedId);
        clauses.push(`merged_id = $${values.length}`);
      }
      const res = await tx.query<DbMergeHistoryRow>(
        `SELECT *
         FROM public.merge_history
         WHERE ${clauses.join(' AND ')}
         ORDER BY merged_at DESC, id DESC`,
        values,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'MergeHistory');
        return mapMergeHistoryRow<TMerge>(row);
      });
    });
  }

  /**
   * Atomically executes a person or organisation merge in a single PostgreSQL transaction (`S0-16`, `S0-17a`),
   * repointing all references across `people`, `organisations`, `person_organisation_links`, `notes`,
   * `matters`, `matter_parties`, `key_dates`, `document_links`, `enquiries`, `quotes`, `tasks`,
   * `task_linked_records`, `notifications`, `sign_offs`, `recently_viewed`, `merge_history`, and `audit_entries`.
   */
  public async executeMergeInTransaction(
    ctx: TenantContext,
    params: {
      recordType: 'person' | 'organisation';
      survivorId?: string;
      mergedId?: string;
      survivor?: TenantPersonRecord | TenantOrganisationRecord;
      merged?: TenantPersonRecord | TenantOrganisationRecord;
      survivorPerson?: TenantPersonRecord;
      mergedPerson?: TenantPersonRecord;
      survivorOrganisation?: TenantOrganisationRecord;
      mergedOrganisation?: TenantOrganisationRecord;
      linksToUpsert?: readonly TenantPersonOrganisationLinkRecord[];
      linkIdsToDelete?: readonly string[];
      repointedSubsidiaries?: readonly TenantOrganisationRecord[];
      notesToRepoint?: readonly TenantNoteRecord[];
      mergeHistory?: TenantMergeHistoryRecord;
      auditEntries?: readonly AppendTenantAuditEntryInput[];
    },
  ): Promise<void> {
    const { recordType } = params;
    const survivorPerson =
      params.survivorPerson ??
      (recordType === 'person'
        ? (params.survivor as TenantPersonRecord | undefined)
        : undefined);
    const mergedPerson =
      params.mergedPerson ??
      (recordType === 'person'
        ? (params.merged as TenantPersonRecord | undefined)
        : undefined);
    const survivorOrganisation =
      params.survivorOrganisation ??
      (recordType === 'organisation'
        ? (params.survivor as TenantOrganisationRecord | undefined)
        : undefined);
    const mergedOrganisation =
      params.mergedOrganisation ??
      (recordType === 'organisation'
        ? (params.merged as TenantOrganisationRecord | undefined)
        : undefined);
    const survivorId =
      params.survivorId ??
      survivorPerson?.id ??
      survivorOrganisation?.id ??
      params.mergeHistory?.survivorId ??
      '';
    const mergedId =
      params.mergedId ??
      mergedPerson?.id ??
      mergedOrganisation?.id ??
      params.mergeHistory?.mergedId ??
      '';
    if (!survivorId?.trim() || !mergedId?.trim() || survivorId === mergedId) {
      throw new Error(
        'PARTY_MERGE_VALIDATION_ERROR: Distinct survivorId and mergedId are required for executeMergeInTransaction.',
      );
    }

    await this.withTenantTransaction(ctx, async (tx) => {
      // 1. Update survivor & tombstone merged party
      if (recordType === 'person') {
        if (survivorPerson) {
          await this.upsertPersonInTx(tx, ctx, survivorPerson);
        }
        if (mergedPerson) {
          await this.upsertPersonInTx(tx, ctx, {
            ...mergedPerson,
            mergedIntoId: survivorId,
          });
        } else {
          await tx.query(
            `UPDATE public.people
             SET merged_into_id = $2, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $3`,
            [ctx.tenantId, survivorId, mergedId],
          );
          await tx.query(
            `UPDATE public.person_emails
             SET active = FALSE, updated_at = NOW()
             WHERE tenant_id = $1 AND person_id = $2`,
            [ctx.tenantId, mergedId],
          );
        }
      } else {
        if (survivorOrganisation) {
          await this.upsertOrganisationInTx(tx, ctx, survivorOrganisation);
        }
        if (mergedOrganisation) {
          await this.upsertOrganisationInTx(tx, ctx, {
            ...mergedOrganisation,
            mergedIntoId: survivorId,
          });
        } else {
          await tx.query(
            `UPDATE public.organisations
             SET merged_into_id = $2, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $3`,
            [ctx.tenantId, survivorId, mergedId],
          );
        }
        if (params.repointedSubsidiaries) {
          for (const sub of params.repointedSubsidiaries) {
            await this.upsertOrganisationInTx(tx, ctx, sub);
          }
        } else {
          // Repoint child organisations' parent_organisation_id (avoiding self-parenting)
          await tx.query(
            `UPDATE public.organisations
             SET parent_organisation_id = CASE WHEN id = $2 THEN NULL ELSE $2 END,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND parent_organisation_id = $3`,
            [ctx.tenantId, survivorId, mergedId],
          );
        }
      }

      // 2. Repoint person_organisation_links (deduplicating colliding links)
      if (params.linkIdsToDelete || params.linksToUpsert) {
        for (const linkId of params.linkIdsToDelete ?? []) {
          await tx.query(
            'DELETE FROM public.person_organisation_links WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, linkId],
          );
        }
        for (const link of params.linksToUpsert ?? []) {
          await this.upsertLinkInTx(tx, ctx, link);
        }
      } else if (recordType === 'person') {
        await tx.query(
          `DELETE FROM public.person_organisation_links l_merged
           USING public.person_organisation_links l_surv
           WHERE l_merged.tenant_id = $1
             AND l_surv.tenant_id = $1
             AND l_merged.person_id = $3
             AND l_surv.person_id = $2
             AND l_merged.organisation_id = l_surv.organisation_id
             AND l_merged.is_current = l_surv.is_current`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.person_organisation_links
           SET person_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND person_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      } else {
        await tx.query(
          `DELETE FROM public.person_organisation_links l_merged
           USING public.person_organisation_links l_surv
           WHERE l_merged.tenant_id = $1
             AND l_surv.tenant_id = $1
             AND l_merged.organisation_id = $3
             AND l_surv.organisation_id = $2
             AND l_merged.person_id = l_surv.person_id
             AND l_merged.is_current = l_surv.is_current`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.person_organisation_links
           SET organisation_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND organisation_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      }

      // 3. Repoint notes
      if (params.notesToRepoint) {
        for (const note of params.notesToRepoint) {
          await this.upsertNoteInTx(tx, ctx, note);
        }
      } else {
        await tx.query(
          `UPDATE public.notes
           SET record_id = $2
           WHERE tenant_id = $1 AND record_type = $3 AND record_id = $4`,
          [ctx.tenantId, survivorId, recordType, mergedId],
        );
      }

      // 4. Repoint matters & matter_parties
      await tx.query(
        `UPDATE public.matters
         SET client_id = $2, updated_at = NOW()
         WHERE tenant_id = $1 AND client_id = $3`,
        [ctx.tenantId, survivorId, mergedId],
      );
      if (recordType === 'person') {
        await tx.query(
          `UPDATE public.matters
           SET instructing_contact_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND instructing_contact_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.matters
           SET billing_contact_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND billing_contact_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.matters
           SET referrer_person_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND referrer_person_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.matter_parties
           SET acting_solicitor_person_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND acting_solicitor_person_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      } else {
        await tx.query(
          `UPDATE public.matters
           SET referrer_organisation_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND referrer_organisation_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
        await tx.query(
          `UPDATE public.matter_parties
           SET acting_solicitor_organisation_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND acting_solicitor_organisation_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      }
      await tx.query(
        `UPDATE public.matter_parties
         SET entity_id = $2, updated_at = NOW()
         WHERE tenant_id = $1 AND entity_type = $3 AND entity_id = $4`,
        [ctx.tenantId, survivorId, recordType, mergedId],
      );

      // 6. Repoint documents & document_links
      await tx.query(
        `UPDATE public.documents
         SET primary_client_id = CASE WHEN primary_client_id = $3 THEN $2 ELSE primary_client_id END,
             recipient_party_id = CASE WHEN recipient_party_id = $3 THEN $2 ELSE recipient_party_id END
         WHERE tenant_id = $1 AND (primary_client_id = $3 OR recipient_party_id = $3)`,
        [ctx.tenantId, survivorId, mergedId],
      );
      await tx.query(
        `DELETE FROM public.document_links dl_merged
         USING public.document_links dl_surv
         WHERE dl_merged.tenant_id = $1
           AND dl_surv.tenant_id = $1
           AND dl_merged.document_id = dl_surv.document_id
           AND dl_merged.entity_type = $2
           AND dl_surv.entity_type = $2
           AND dl_merged.entity_id = $3
           AND dl_surv.entity_id = $4`,
        [ctx.tenantId, recordType, mergedId, survivorId],
      );
      await tx.query(
        `UPDATE public.document_links
         SET entity_id = $2
         WHERE tenant_id = $1 AND entity_type = $3 AND entity_id = $4`,
        [ctx.tenantId, survivorId, recordType, mergedId],
      );

      // 7. Repoint enquiries (`S0-17a`)
      if (recordType === 'person') {
        await tx.query(
          `UPDATE public.enquiries
           SET linked_person_id = CASE WHEN linked_person_id = $3 THEN $2 ELSE linked_person_id END,
               referrer_person_id = CASE WHEN referrer_person_id = $3 THEN $2 ELSE referrer_person_id END,
               updated_at = NOW()
           WHERE tenant_id = $1 AND (linked_person_id = $3 OR referrer_person_id = $3)`,
          [ctx.tenantId, survivorId, mergedId],
        );
      } else {
        await tx.query(
          `UPDATE public.enquiries
           SET linked_organisation_id = CASE WHEN linked_organisation_id = $3 THEN $2 ELSE linked_organisation_id END,
               referred_to_organisation_id = CASE WHEN referred_to_organisation_id = $3 THEN $2 ELSE referred_to_organisation_id END,
               updated_at = NOW()
           WHERE tenant_id = $1 AND (linked_organisation_id = $3 OR referred_to_organisation_id = $3)`,
          [ctx.tenantId, survivorId, mergedId],
        );
      }
      const enqSnapRes = await tx.query<{
        tenant_id: string;
        id: string;
        conflict_snapshot_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, conflict_snapshot_json
         FROM public.enquiries
         WHERE tenant_id = $1 AND conflict_snapshot_json IS NOT NULL
         FOR UPDATE`,
        [ctx.tenantId],
      );
      for (const enqRow of enqSnapRes.rows) {
        this.assertRowTenant(
          ctx,
          enqRow.tenant_id,
          'enquiries.executeMergeInTransaction',
        );
        const snap = enqRow.conflict_snapshot_json;
        if (!snap || typeof snap !== 'object') continue;
        let snapChanged = false;
        const clonedSnap = structuredClone(snap) as {
          conflicts?: Array<{
            recordType?: string;
            recordId?: string;
            href?: string;
          }>;
          knownPeople?: Array<{ id?: string }>;
          knownOrganisations?: Array<{ id?: string }>;
          searchedInput?: {
            knownPeople?: Array<{ id?: string }>;
            knownOrganisations?: Array<{ id?: string }>;
          };
        };
        if (Array.isArray(clonedSnap.conflicts)) {
          for (const hit of clonedSnap.conflicts) {
            if (hit.recordId === mergedId) {
              hit.recordId = survivorId;
              if (typeof hit.href === 'string') {
                hit.href = hit.href.split(mergedId).join(survivorId);
              }
              snapChanged = true;
            }
          }
        }
        if (recordType === 'person') {
          for (const holder of [clonedSnap, clonedSnap.searchedInput]) {
            if (holder && Array.isArray(holder.knownPeople)) {
              const seen = new Set<string>();
              const deduped: Array<{ id?: string }> = [];
              for (const kp of holder.knownPeople) {
                const nextId = kp.id === mergedId ? survivorId : kp.id;
                if (kp.id === mergedId) {
                  snapChanged = true;
                }
                if (typeof nextId === 'string' && seen.has(nextId)) {
                  snapChanged = true;
                  continue;
                }
                if (typeof nextId === 'string') {
                  seen.add(nextId);
                }
                deduped.push({ ...kp, id: nextId });
              }
              holder.knownPeople = deduped;
            }
          }
        }
        if (recordType === 'organisation') {
          for (const holder of [clonedSnap, clonedSnap.searchedInput]) {
            if (holder && Array.isArray(holder.knownOrganisations)) {
              const seen = new Set<string>();
              const deduped: Array<{ id?: string }> = [];
              for (const ko of holder.knownOrganisations) {
                const nextId = ko.id === mergedId ? survivorId : ko.id;
                if (ko.id === mergedId) {
                  snapChanged = true;
                }
                if (typeof nextId === 'string' && seen.has(nextId)) {
                  snapChanged = true;
                  continue;
                }
                if (typeof nextId === 'string') {
                  seen.add(nextId);
                }
                deduped.push({ ...ko, id: nextId });
              }
              holder.knownOrganisations = deduped;
            }
          }
        }
        if (snapChanged) {
          await tx.query(
            `UPDATE public.enquiries
             SET conflict_snapshot_json = $3::jsonb, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, enqRow.id, JSON.stringify(clonedSnap)],
          );
        }
      }

      // 8. Repoint quotes (`S0-17a`)
      if (recordType === 'person') {
        await tx.query(
          `UPDATE public.quotes
           SET client_person_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND client_person_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      } else {
        await tx.query(
          `UPDATE public.quotes
           SET client_organisation_id = $2, updated_at = NOW()
           WHERE tenant_id = $1 AND client_organisation_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      }

      // 9. Repoint task_linked_records & tasks (`S0-17a`)
      await tx.query(
        `DELETE FROM public.task_linked_records tlr_merged
         USING public.task_linked_records tlr_surv
         WHERE tlr_merged.tenant_id = $1
           AND tlr_surv.tenant_id = $1
           AND tlr_merged.task_id = tlr_surv.task_id
           AND tlr_merged.record_type = $2
           AND tlr_surv.record_type = $2
           AND tlr_merged.record_id = $3
           AND tlr_surv.record_id = $4`,
        [ctx.tenantId, recordType, mergedId, survivorId],
      );
      await tx.query(
        `UPDATE public.task_linked_records
         SET record_id = $4
         WHERE tenant_id = $1 AND record_type = $2 AND record_id = $3`,
        [ctx.tenantId, recordType, mergedId, survivorId],
      );

      // 10. Repoint notifications (`S0-17a`)
      await tx.query(
        `UPDATE public.notifications
         SET record_id = $2,
             href = REPLACE(href, $3, $2)
         WHERE tenant_id = $1 AND record_id = $3`,
        [ctx.tenantId, survivorId, mergedId],
      );

      // 11. Repoint recently_viewed (`S0-17a`)
      const rvRes = await tx.query<{
        tenant_id: string;
        user_id: string;
        items_json: string[] | null;
      }>(
        `SELECT tenant_id, user_id, items_json
         FROM public.recently_viewed
         WHERE tenant_id = $1 AND items_json ? $2
         FOR UPDATE`,
        [ctx.tenantId, mergedId],
      );
      for (const rvRow of rvRes.rows) {
        this.assertRowTenant(ctx, rvRow.tenant_id, 'recently_viewed.executeMergeInTransaction');
        const items = Array.isArray(rvRow.items_json) ? rvRow.items_json : [];
        const deduped: string[] = [];
        for (const item of items) {
          const mapped = item === mergedId ? survivorId : item;
          if (!deduped.includes(mapped)) {
            deduped.push(mapped);
          }
        }
        await tx.query(
          `UPDATE public.recently_viewed
           SET items_json = $3::jsonb, updated_at = NOW()
           WHERE tenant_id = $1 AND user_id = $2`,
          [ctx.tenantId, rvRow.user_id, JSON.stringify(deduped)],
        );
      }

      // 12. Record merge_history & audit_entries in the same transaction
      if (params.mergeHistory) {
        await this.upsertMergeHistoryInTx(tx, ctx, params.mergeHistory);
      }
      if (params.auditEntries?.length) {
        const auditRepo = new TenantAuditRepository();
        await auditRepo.appendAuditEntries(ctx, params.auditEntries);
      }
    });
  }

  // ============================================================================
  // Counts & Clear
  // ============================================================================

  public async countAllTenantPartyRows(ctx: TenantContext): Promise<{
    people: number;
    personEmails: number;
    organisations: number;
    links: number;
    notes: number;
    mergeHistory: number;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        p_cnt: number;
        pe_cnt: number;
        o_cnt: number;
        l_cnt: number;
        n_cnt: number;
        mrg_cnt: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM public.people WHERE tenant_id = $1) AS p_cnt,
           (SELECT COUNT(*)::int FROM public.person_emails WHERE tenant_id = $1) AS pe_cnt,
           (SELECT COUNT(*)::int FROM public.organisations WHERE tenant_id = $1) AS o_cnt,
           (SELECT COUNT(*)::int FROM public.person_organisation_links WHERE tenant_id = $1) AS l_cnt,
           (SELECT COUNT(*)::int FROM public.notes WHERE tenant_id = $1) AS n_cnt,
           (SELECT COUNT(*)::int FROM public.merge_history WHERE tenant_id = $1) AS mrg_cnt`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      return {
        people: Number(row?.p_cnt ?? 0),
        personEmails: Number(row?.pe_cnt ?? 0),
        organisations: Number(row?.o_cnt ?? 0),
        links: Number(row?.l_cnt ?? 0),
        notes: Number(row?.n_cnt ?? 0),
        mergeHistory: Number(row?.mrg_cnt ?? 0),
      };
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('DELETE FROM public.merge_history WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM public.notes WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        'DELETE FROM public.person_organisation_links WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query('DELETE FROM public.organisations WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM public.person_emails WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query('DELETE FROM public.people WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
      await tx.query(
        `DELETE FROM public.tenant_record_sequences
         WHERE tenant_id = $1 AND counter_key IN ('P', 'O', 'L', 'N', 'MRG')`,
        [ctx.tenantId],
      );
    });
  }
}

export { TenantPartyRepository as TenantDirectoryRepository };
