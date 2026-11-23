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
import {
  syncPersonFirmWorkEmailInTx,
  upsertPersonEmploymentAndPayrollInTx,
} from './hrRbacRepository';
import { doEffectiveDateRangesOverlap } from '../domain/costs/rates';
import {
  INVALID_PARENT_ORGANISATION_CODE,
  ORGANISATION_PARENT_CYCLE_CODE,
} from './rateOverrideRepository';
import {
  computeOrganisationLookupKeys,
  computePersonLookupKeys,
  extractEmailDomainKey,
  extractTokenPhoneticKeys,
  FREE_EMAIL_DOMAINS_SET,
  normaliseComparableNameKey,
  normalisePhoneLast9Key,
  normalisePostcodeKey,
  normaliseRegNumberKey,
} from './candidateKeys';

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function replaceRecordIdPathSegment(
  href: string,
  mergedId: string,
  survivorId: string,
): string {
  if (!href || !mergedId || mergedId === survivorId) return href;
  const escaped = mergedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return href
    .replace(new RegExp(`(^|\\/)${escaped}(?=$|[/?#])`, 'g'), `$1${survivorId}`)
    .replace(new RegExp(`(=)${escaped}(?=$|[&#])`, 'g'), `$1${survivorId}`);
}

const MERGE_REPOINT_ID_KEYS = new Set([
  'id',
  'linkedRecordId',
  'recordId',
  'matchedId',
  'matchedRecordId',
  'sourceRecordId',
  'entityId',
  'actingSolicitorId',
  'actingSolicitorPersonId',
  'actingSolicitorOrganisationId',
  'clientId',
  'clientPersonId',
  'clientOrganisationId',
  'instructingContactId',
  'billingContactId',
  'referrerContactId',
  'linkedPersonId',
  'referrerPersonId',
  'linkedOrganisationId',
  'referredToOrganisationId',
]);

const MERGE_REPOINT_ID_ARRAY_KEYS = new Set([
  'additionalClientIds',
]);

function repointJsonIdFieldsInValue(
  value: unknown,
  mergedId: string,
  survivorId: string,
  options?: {
    allowDirectIdField?: boolean;
    extraExcludeClientId?: string;
    repointAnyStringValue?: boolean;
  },
): { value: unknown; changed: boolean } {
  if (typeof value === 'string' && options?.repointAnyStringValue && value === mergedId) {
    return { value: survivorId, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const res = repointJsonIdFieldsInValue(item, mergedId, survivorId, options);
      if (res.changed) changed = true;
      return res.value;
    });
    return { value: changed ? mapped : value, changed };
  }
  if (!value || typeof value !== 'object') {
    return { value, changed: false };
  }
  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'href' && typeof v === 'string') {
      const nextHref = replaceRecordIdPathSegment(v, mergedId, survivorId);
      if (nextHref !== v) changed = true;
      out[k] = nextHref;
    } else if (k === 'connectedToPartyId' && v === `client-${mergedId}`) {
      changed = true;
      out[k] = `client-${survivorId}`;
    } else if (MERGE_REPOINT_ID_ARRAY_KEYS.has(k) && Array.isArray(v)) {
      const nextArr: string[] = [];
      let arrChanged = false;
      for (const raw of v) {
        if (typeof raw !== 'string') continue;
        const mapped = raw === mergedId ? survivorId : raw;
        if (raw === mergedId) arrChanged = true;
        if (options?.extraExcludeClientId && mapped === options.extraExcludeClientId) {
          arrChanged = true;
          continue;
        }
        if (!nextArr.includes(mapped)) {
          nextArr.push(mapped);
        } else {
          arrChanged = true;
        }
      }
      if (arrChanged || nextArr.length !== v.length) changed = true;
      out[k] = arrChanged || nextArr.length !== v.length ? nextArr : v;
    } else if (MERGE_REPOINT_ID_KEYS.has(k) && typeof v === 'string') {
      if (k === 'id' && options?.allowDirectIdField === false) {
        if (v === `client-${mergedId}`) {
          changed = true;
          out[k] = `client-${survivorId}`;
        } else {
          out[k] = v;
        }
      } else if (v === mergedId) {
        changed = true;
        out[k] = survivorId;
      } else {
        out[k] = v;
      }
    } else {
      const nested = repointJsonIdFieldsInValue(v, mergedId, survivorId, options);
      if (nested.changed) changed = true;
      out[k] = nested.value;
    }
  }
  return { value: changed ? out : value, changed };
}

function rewriteConflictSnapshotJson(
  snap: Record<string, unknown>,
  recordType: 'person' | 'organisation',
  mergedId: string,
  survivorId: string,
): { next: Record<string, unknown>; changed: boolean } {
  let snapChanged = false;
  const clonedSnap = structuredClone(snap) as {
    conflicts?: Array<Record<string, unknown> & {
      recordType?: string;
      recordId?: string;
      href?: string;
      reasons?: string[];
      matchedFields?: string[];
    }>;
    knownPeople?: Array<{ id?: string }>;
    knownOrganisations?: Array<{ id?: string }>;
    searchedInput?: {
      knownPeople?: Array<{ id?: string }>;
      knownOrganisations?: Array<{ id?: string }>;
    };
  };
  if (Array.isArray(clonedSnap.conflicts)) {
    const byKey = new Map<string, (typeof clonedSnap.conflicts)[number]>();
    const dedupedConflicts: typeof clonedSnap.conflicts = [];
    for (const hit of clonedSnap.conflicts) {
      const nextHit = { ...hit };
      if (nextHit.recordId === mergedId && (!nextHit.recordType || nextHit.recordType === recordType)) {
        nextHit.recordId = survivorId;
        snapChanged = true;
      }
      if (typeof nextHit.href === 'string') {
        const nextHref = replaceRecordIdPathSegment(nextHit.href, mergedId, survivorId);
        if (nextHref !== nextHit.href) {
          nextHit.href = nextHref;
          snapChanged = true;
        }
      }
      const key =
        typeof nextHit.recordId === 'string' && typeof nextHit.recordType === 'string'
          ? `${nextHit.recordType}:${nextHit.recordId}`
          : '';
      if (key && byKey.has(key)) {
        const existing = byKey.get(key)!;
        if (Array.isArray(nextHit.reasons)) {
          const prevReasons = Array.isArray(existing.reasons) ? existing.reasons : [];
          existing.reasons = Array.from(new Set([...prevReasons, ...nextHit.reasons]));
        }
        if (Array.isArray(nextHit.matchedFields)) {
          const prevFields = Array.isArray(existing.matchedFields) ? existing.matchedFields : [];
          existing.matchedFields = Array.from(new Set([...prevFields, ...nextHit.matchedFields]));
        }
        snapChanged = true;
      } else {
        if (key) byKey.set(key, nextHit);
        dedupedConflicts.push(nextHit);
      }
    }
    clonedSnap.conflicts = dedupedConflicts;
  }
  const remapKnown = (listKey: 'knownPeople' | 'knownOrganisations') => {
    for (const holder of [clonedSnap, clonedSnap.searchedInput]) {
      const list = holder?.[listKey];
      if (holder && Array.isArray(list)) {
        const seen = new Set<string>();
        const deduped: Array<{ id?: string }> = [];
        for (const item of list) {
          const nextId = item.id === mergedId ? survivorId : item.id;
          if (item.id === mergedId) snapChanged = true;
          if (typeof nextId === 'string' && seen.has(nextId)) {
            snapChanged = true;
            continue;
          }
          if (typeof nextId === 'string') seen.add(nextId);
          deduped.push({ ...item, id: nextId });
        }
        holder[listKey] = deduped;
      }
    }
  };
  if (recordType === 'person') remapKnown('knownPeople');
  if (recordType === 'organisation') remapKnown('knownOrganisations');
  return {
    next: clonedSnap as unknown as Record<string, unknown>,
    changed: snapChanged,
  };
}

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
  joined_employment_json?: Record<string, unknown> | null;
  joined_payroll_json?: Record<string, unknown> | null;
}

const PEOPLE_EXPLICIT_COLUMNS = `
  tenant_id, id, first_name, preferred_name, other_names, surname,
  title_id, date_of_birth, is_employee, employee_role_id, app_role,
  entra_object_id, primary_email_lower, job_title, department_id,
  office_id, supervisor_id, is_fee_earner, default_hourly_rate_gbp,
  client_status_id, aml_status_id, id_verified_on, id_expiry_date,
  created_from_enquiry_id, merged_into_id, created_at, updated_at,
  emails_json, phones_json, addresses_json, relationship_role_ids_json,
  roles_json, permission_overrides_json, dismissed_duplicate_ids_json,
  custom_fields_json, profile_json
`;

const PEOPLE_JOINED_SELECT_COLUMNS = `
  p.tenant_id, p.id, p.first_name, p.preferred_name, p.other_names, p.surname,
  p.title_id, p.date_of_birth, p.is_employee, p.employee_role_id, p.app_role,
  p.entra_object_id, p.primary_email_lower, p.job_title, p.department_id,
  p.office_id, p.supervisor_id, p.is_fee_earner, p.default_hourly_rate_gbp,
  p.client_status_id, p.aml_status_id, p.id_verified_on, p.id_expiry_date,
  p.created_from_enquiry_id, p.merged_into_id, p.created_at, p.updated_at,
  p.emails_json, p.phones_json, p.addresses_json, p.relationship_role_ids_json,
  p.roles_json, p.permission_overrides_json, p.dismissed_duplicate_ids_json,
  p.custom_fields_json, p.profile_json,
  eer.employment_json AS joined_employment_json,
  esr.payroll_json AS joined_payroll_json
`;

const PEOPLE_LEFT_JOIN_HR = `
  FROM public.people p
  LEFT JOIN public.employee_employment_records eer
    ON eer.tenant_id = p.tenant_id AND eer.person_id = p.id
  LEFT JOIN public.employee_sensitive_records esr
    ON esr.tenant_id = p.tenant_id AND esr.person_id = p.id
`;

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
  const joinedEmp = row.joined_employment_json ?? null;
  if (joinedEmp !== null || prof.hasEmployment === true) {
    if (joinedEmp !== null) {
      const clonedEmp = structuredClone(joinedEmp);
      if (
        row.joined_payroll_json !== undefined &&
        row.joined_payroll_json !== null
      ) {
        clonedEmp.payroll = structuredClone(row.joined_payroll_json);
      } else if (row.joined_payroll_json === null) {
        delete clonedEmp.payroll;
      }
      out.employment = clonedEmp;
    } else {
      out.employment = null;
    }
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
      "DELETE FROM public.person_emails WHERE tenant_id = $1 AND person_id = $2 AND source = 'contact_email'",
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
    const personLookupKeys = computePersonLookupKeys(person);

    const res = await tx.query<DbPersonRow>(
      `INSERT INTO public.people (${PEOPLE_EXPLICIT_COLUMNS},
         phone_last9_keys, postcode_keys, phonetic_keys
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21, $22, $23,
         $24, $25, $26::timestamptz, $27::timestamptz,
         $28::jsonb, $29::jsonb, $30::jsonb, $31::jsonb,
         $32::jsonb, $33::jsonb, $34::jsonb,
         $35::jsonb, $36::jsonb,
         $37::text[], $38::text[], $39::text[]
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
         phone_last9_keys = EXCLUDED.phone_last9_keys,
         postcode_keys = EXCLUDED.postcode_keys,
         phonetic_keys = EXCLUDED.phonetic_keys
       RETURNING ${PEOPLE_EXPLICIT_COLUMNS}`,
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
        personLookupKeys.phoneLast9Keys,
        personLookupKeys.postcodeKeys,
        personLookupKeys.phoneticKeys,
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

    const isTombstoned = Boolean(person.mergedIntoId);
    if (person.employment !== undefined && person.employment !== null) {
      await upsertPersonEmploymentAndPayrollInTx(
        tx,
        ctx,
        person.id,
        person.employment as Record<string, unknown>,
        {
          updatedById: person.updatedById,
          updatedAt: person.updatedAt,
          isMergedOrTombstoned: isTombstoned,
        },
      );
      const empObj = person.employment as Record<string, unknown>;
      saved.joined_employment_json = structuredClone(empObj);
      if (empObj.payroll && typeof empObj.payroll === 'object') {
        saved.joined_payroll_json = structuredClone(
          empObj.payroll as Record<string, unknown>,
        );
      }
    } else if (person.employment === null) {
      await syncPersonFirmWorkEmailInTx(tx, ctx, person.id, null, {
        isMergedOrTombstoned: isTombstoned,
      });
      saved.joined_employment_json = null;
    } else {
      const hrRes = await tx.query<{
        tenant_id: string;
        employment_json: Record<string, unknown> | null;
        payroll_json: Record<string, unknown> | null;
      }>(
        `SELECT eer.tenant_id, eer.employment_json, esr.payroll_json
         FROM public.employee_employment_records eer
         LEFT JOIN public.employee_sensitive_records esr
           ON esr.tenant_id = eer.tenant_id AND esr.person_id = eer.person_id
         WHERE eer.tenant_id = $1 AND eer.person_id = $2`,
        [ctx.tenantId, person.id],
      );
      const hrRow = hrRes.rows[0];
      if (hrRow) {
        this.assertRowTenant(
          ctx,
          hrRow.tenant_id,
          'employee_employment_records',
        );
        saved.joined_employment_json = hrRow.employment_json;
        saved.joined_payroll_json = hrRow.payroll_json;
        await syncPersonFirmWorkEmailInTx(
          tx,
          ctx,
          person.id,
          hrRow.employment_json,
          { isMergedOrTombstoned: isTombstoned },
        );
      }
    }

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
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
         WHERE p.tenant_id = $1 AND p.id = $2`,
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
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
         WHERE p.tenant_id = $1
           AND lower(p.entra_object_id) = lower($2)
           AND p.merged_into_id IS NULL
         ORDER BY p.id ASC
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
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
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
    options?: {
      includeMerged?: boolean;
      employeesOnly?: boolean;
      employeesAndLeaversOnly?: boolean;
    },
  ): Promise<TPerson[]> {
    const includeMerged = options?.includeMerged ?? true;
    const employeesOnly = options?.employeesOnly ?? false;
    const employeesAndLeaversOnly = options?.employeesAndLeaversOnly ?? false;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses = ['p.tenant_id = $1'];
      if (!includeMerged) {
        clauses.push('p.merged_into_id IS NULL');
      }
      if (employeesOnly) {
        clauses.push('p.is_employee = TRUE');
      } else if (employeesAndLeaversOnly) {
        clauses.push(
          `(p.is_employee = TRUE OR EXISTS (SELECT 1 FROM public.employee_employment_records eer_chk WHERE eer_chk.tenant_id = p.tenant_id AND eer_chk.person_id = p.id))`,
        );
      }
      const res = await tx.query<DbPersonRow>(
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.id ASC`,
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

  /**
   * Validates that setting `parentOrganisationId` on `organisationId` points to an active
   * (`merged_into_id IS NULL`) organisation in the tenant and introduces no direct or
   * transitive hierarchy cycles (`ORGANISATION_PARENT_CYCLE` / `INVALID_PARENT_ORGANISATION`).
   */
  public async validateOrganisationParentLinkInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    organisationId: string | null | undefined,
    parentOrganisationId: string | null | undefined,
  ): Promise<void> {
    const parentId = parentOrganisationId?.trim() || null;
    if (!parentId) {
      return;
    }
    const selfId = organisationId?.trim() || null;
    if (selfId && parentId === selfId) {
      const err = new Error(
        `${ORGANISATION_PARENT_CYCLE_CODE}: An organisation cannot be its own parent.`,
      ) as Error & { code: string };
      err.code = ORGANISATION_PARENT_CYCLE_CODE;
      throw err;
    }

    const initialRes = await tx.query<{
      tenant_id: string;
      id: string;
      merged_into_id: string | null;
      parent_organisation_id: string | null;
    }>(
      `SELECT tenant_id, id, merged_into_id, parent_organisation_id
       FROM public.organisations
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, parentId],
    );
    const initialRow = initialRes.rows[0];
    if (!initialRow) {
      const err = new Error(
        `${INVALID_PARENT_ORGANISATION_CODE}: Parent organisation "${parentId}" was not found in this tenant.`,
      ) as Error & { code: string };
      err.code = INVALID_PARENT_ORGANISATION_CODE;
      throw err;
    }
    this.assertRowTenant(ctx, initialRow.tenant_id, 'organisations.validateParentLinkInitial');
    if (initialRow.merged_into_id) {
      const err = new Error(
        `${INVALID_PARENT_ORGANISATION_CODE}: Parent organisation "${parentId}" has been merged/deactivated and cannot be linked as a parent group.`,
      ) as Error & { code: string };
      err.code = INVALID_PARENT_ORGANISATION_CODE;
      throw err;
    }

    const visited = new Set<string>([initialRow.id]);
    let cursorParentId = initialRow.parent_organisation_id;
    let hops = 0;

    while (cursorParentId && hops < 50) {
      hops += 1;
      if (selfId && cursorParentId === selfId) {
        const err = new Error(
          `${ORGANISATION_PARENT_CYCLE_CODE}: Linking "${parentId}" as parent of "${selfId}" would create a cyclic organisation hierarchy.`,
        ) as Error & { code: string };
        err.code = ORGANISATION_PARENT_CYCLE_CODE;
        throw err;
      }
      if (visited.has(cursorParentId)) {
        const err = new Error(
          `${ORGANISATION_PARENT_CYCLE_CODE}: Organisation parent hierarchy contains a cycle at "${cursorParentId}".`,
        ) as Error & { code: string };
        err.code = ORGANISATION_PARENT_CYCLE_CODE;
        throw err;
      }
      visited.add(cursorParentId);

      const ancestorRes = await tx.query<{
        tenant_id: string;
        id: string;
        merged_into_id: string | null;
        parent_organisation_id: string | null;
      }>(
        `SELECT tenant_id, id, merged_into_id, parent_organisation_id
         FROM public.organisations
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, cursorParentId],
      );
      const ancestor = ancestorRes.rows[0];
      if (!ancestor) {
        break;
      }
      this.assertRowTenant(ctx, ancestor.tenant_id, 'organisations.validateParentLinkAncestor');
      if (ancestor.merged_into_id) {
        break;
      }
      cursorParentId = ancestor.parent_organisation_id;
    }
  }

  public async validateOrganisationParentLink(
    ctx: TenantContext,
    organisationId: string | null | undefined,
    parentOrganisationId: string | null | undefined,
  ): Promise<void> {
    await this.withTenantReadTransaction(ctx, (tx) =>
      this.validateOrganisationParentLinkInTx(tx, ctx, organisationId, parentOrganisationId),
    );
  }

  private async upsertOrganisationInTx<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    org: TOrg,
  ): Promise<TOrg> {
    if (org.parentOrganisationId && org.parentOrganisationId === org.id) {
      const err = new Error(
        `${ORGANISATION_PARENT_CYCLE_CODE}: Organisation "${org.id}" cannot reference itself as its parent organisation.`,
      ) as Error & { code: string };
      err.code = ORGANISATION_PARENT_CYCLE_CODE;
      throw err;
    }
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
    const orgLookupKeys = computeOrganisationLookupKeys(org);

    const res = await tx.query<DbOrganisationRow>(
      `INSERT INTO public.organisations (
         tenant_id, id, legal_name, trading_name, organisation_type_id,
         company_number, vat_number, client_reference, general_email,
         main_phone, website, parent_organisation_id, relationship_partner_id,
         conflict_status, aml_status_id, client_status_id, created_from_enquiry_id,
         merged_into_id, created_at, updated_at, registered_address_json,
         trading_address_json, relationship_type_ids_json, sector_ids_json,
         dismissed_duplicate_ids_json, custom_fields_json, profile_json,
         norm_company_number, email_domains, phone_last9_keys, postcode_keys, phonetic_keys
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16, $17,
         $18, $19::timestamptz, $20::timestamptz, $21::jsonb,
         $22::jsonb, $23::jsonb, $24::jsonb,
         $25::jsonb, $26::jsonb, $27::jsonb,
         $28, $29::text[], $30::text[], $31::text[], $32::text[]
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
         profile_json = EXCLUDED.profile_json,
         norm_company_number = EXCLUDED.norm_company_number,
         email_domains = EXCLUDED.email_domains,
         phone_last9_keys = EXCLUDED.phone_last9_keys,
         postcode_keys = EXCLUDED.postcode_keys,
         phonetic_keys = EXCLUDED.phonetic_keys
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
        orgLookupKeys.normCompanyNumber,
        orgLookupKeys.emailDomains,
        orgLookupKeys.phoneLast9Keys,
        orgLookupKeys.postcodeKeys,
        orgLookupKeys.phoneticKeys,
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
   * repointing all client/party references across `people`, `person_emails`, `organisations`,
   * `person_organisation_links`, `notes`, `matters` (incrementing `row_version`), `matter_parties`,
   * `documents`, `document_links`, `enquiries`, `quotes`, `tasks`, `task_linked_records`, `notifications`,
   * `recently_viewed`, `teams`, `employee_sensitive_records`, `employee_employment_records`, `pms_links`,
   * `client_rate_overrides`, `register_records` (incrementing `row_version`), `merge_history`, and
   * `audit_entries`.
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
      const targetTable =
        recordType === 'person' ? 'public.people' : 'public.organisations';
      const lockIds = [survivorId, mergedId].sort();
      const lockedTargets = await tx.query<{
        tenant_id: string;
        id: string;
        merged_into_id: string | null;
        parent_organisation_id?: string | null;
      }>(
        recordType === 'organisation'
          ? `SELECT tenant_id, id, merged_into_id, parent_organisation_id
             FROM public.organisations
             WHERE tenant_id = $1 AND id = ANY($2::text[])
             ORDER BY id ASC
             FOR UPDATE`
          : `SELECT tenant_id, id, merged_into_id
             FROM public.people
             WHERE tenant_id = $1 AND id = ANY($2::text[])
             ORDER BY id ASC
             FOR UPDATE`,
        [ctx.tenantId, lockIds],
      );
      const lockedById = new Map<string, (typeof lockedTargets.rows)[number]>();
      for (const row of lockedTargets.rows) {
        this.assertRowTenant(ctx, row.tenant_id, `${targetTable}.executeMergeInTransaction`);
        lockedById.set(row.id, row);
        if (row.id === survivorId && row.merged_into_id) {
          throw new Error(
            `PARTY_MERGE_VALIDATION_ERROR: Survivor "${survivorId}" is already merged into "${row.merged_into_id}".`,
          );
        }
        if (row.id === mergedId && row.merged_into_id) {
          throw new Error(
            `PARTY_MERGE_VALIDATION_ERROR: Record "${mergedId}" is already merged into "${row.merged_into_id}".`,
          );
        }
      }
      if (!survivorPerson && !survivorOrganisation && !lockedById.has(survivorId)) {
        throw new Error(
          `PARTY_MERGE_VALIDATION_ERROR: Survivor "${survivorId}" was not found in tenant.`,
        );
      }
      if (!mergedPerson && !mergedOrganisation && !lockedById.has(mergedId)) {
        throw new Error(
          `PARTY_MERGE_VALIDATION_ERROR: Merge target "${mergedId}" was not found in tenant.`,
        );
      }

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
        const mergedParentBefore =
          mergedOrganisation?.parentOrganisationId ??
          lockedById.get(mergedId)?.parent_organisation_id ??
          null;
        const safeInheritedParent =
          mergedParentBefore && mergedParentBefore !== survivorId && mergedParentBefore !== mergedId
            ? mergedParentBefore
            : null;
        if (survivorOrganisation) {
          const cleanParent =
            survivorOrganisation.parentOrganisationId === survivorId ||
            survivorOrganisation.parentOrganisationId === mergedId
              ? safeInheritedParent
              : survivorOrganisation.parentOrganisationId;
          await this.upsertOrganisationInTx(tx, ctx, {
            ...survivorOrganisation,
            parentOrganisationId: cleanParent,
          });
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
            const subParent =
              sub.id === survivorId &&
              (sub.parentOrganisationId === survivorId || sub.parentOrganisationId === mergedId)
                ? safeInheritedParent
                : sub.parentOrganisationId === mergedId && sub.id !== survivorId
                  ? survivorId
                  : sub.parentOrganisationId;
            await this.upsertOrganisationInTx(tx, ctx, {
              ...sub,
              parentOrganisationId: subParent,
            });
          }
        } else {
          // Repoint child organisations' parent_organisation_id (avoiding self-parenting)
          await tx.query(
            `UPDATE public.organisations
             SET parent_organisation_id = CASE WHEN id = $2 THEN $4 ELSE $2 END,
                 profile_json = jsonb_set(
                   profile_json,
                   '{parentOrganisationId}',
                   CASE WHEN id = $2 THEN COALESCE(to_jsonb($4::text), 'null'::jsonb) ELSE to_jsonb($2::text) END,
                   true
                 ),
                 updated_at = NOW()
             WHERE tenant_id = $1 AND parent_organisation_id = $3`,
            [ctx.tenantId, survivorId, mergedId, safeInheritedParent],
          );
        }
        // Final belt-and-braces guard against self-parenting or pointing to tombstone
        await tx.query(
          `UPDATE public.organisations
           SET parent_organisation_id = $4,
               profile_json = jsonb_set(
                 profile_json,
                 '{parentOrganisationId}',
                 COALESCE(to_jsonb($4::text), 'null'::jsonb),
                 true
               ),
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2
             AND (
               parent_organisation_id IN ($2, $3)
               OR profile_json->>'parentOrganisationId' IN ($2, $3)
             )`,
          [ctx.tenantId, survivorId, mergedId, safeInheritedParent],
        );
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
      const likeMergedPattern = `%${escapeSqlLikePattern(mergedId)}%`;
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

      const matterJsonRows = await tx.query<{
        tenant_id: string;
        id: string;
        client_id: string;
        additional_client_ids_json: unknown;
        conflict_check_record_json: Record<string, unknown> | null;
        opening_record_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, client_id, additional_client_ids_json,
                conflict_check_record_json, opening_record_json
         FROM public.matters
         WHERE tenant_id = $1
           AND (
             additional_client_ids_json ? $3
             OR (client_id = $2 AND additional_client_ids_json ? $2)
             OR (conflict_check_record_json IS NOT NULL AND conflict_check_record_json::text LIKE $4 ESCAPE '\\')
             OR (opening_record_json IS NOT NULL AND opening_record_json::text LIKE $4 ESCAPE '\\')
           )
         FOR UPDATE`,
        [ctx.tenantId, survivorId, mergedId, likeMergedPattern],
      );
      for (const mRow of matterJsonRows.rows) {
        this.assertRowTenant(ctx, mRow.tenant_id, 'matters.executeMergeInTransaction');
        let matterChanged = false;
        const rawAdditional = Array.isArray(mRow.additional_client_ids_json)
          ? (mRow.additional_client_ids_json as unknown[])
          : [];
        const nextAdditional: string[] = [];
        for (const entry of rawAdditional) {
          if (typeof entry !== 'string') continue;
          const mapped = entry === mergedId ? survivorId : entry;
          if (entry === mergedId) matterChanged = true;
          if (mapped === mRow.client_id) {
            matterChanged = true;
            continue;
          }
          if (!nextAdditional.includes(mapped)) {
            nextAdditional.push(mapped);
          } else {
            matterChanged = true;
          }
        }

        let nextConflictCheck = mRow.conflict_check_record_json;
        if (nextConflictCheck && typeof nextConflictCheck === 'object') {
          const repointed = repointJsonIdFieldsInValue(
            nextConflictCheck,
            mergedId,
            survivorId,
            { allowDirectIdField: false, extraExcludeClientId: mRow.client_id },
          );
          if (repointed.changed) {
            nextConflictCheck = repointed.value as Record<string, unknown>;
            matterChanged = true;
          }
        }

        let nextOpeningRecord = mRow.opening_record_json;
        if (nextOpeningRecord && typeof nextOpeningRecord === 'object') {
          const repointed = repointJsonIdFieldsInValue(
            nextOpeningRecord,
            mergedId,
            survivorId,
            { allowDirectIdField: false, extraExcludeClientId: mRow.client_id },
          );
          if (repointed.changed) {
            nextOpeningRecord = repointed.value as Record<string, unknown>;
            matterChanged = true;
          }
        }

        if (matterChanged) {
          await tx.query(
            `UPDATE public.matters
             SET additional_client_ids_json = $3::jsonb,
                 conflict_check_record_json = $4::jsonb,
                 opening_record_json = $5::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              mRow.id,
              JSON.stringify(nextAdditional),
              nextConflictCheck ? JSON.stringify(nextConflictCheck) : null,
              nextOpeningRecord ? JSON.stringify(nextOpeningRecord) : null,
            ],
          );
        }
      }

      // Repoint & de-duplicate exact same-matter collisions on matter_parties while preserving distinct roles/capacities
      const mpRows = await tx.query<{
        tenant_id: string;
        id: string;
        matter_id: string;
        entity_type: string | null;
        entity_id: string | null;
        relationship_id: string | null;
        capacity_id: string | null;
        acting_solicitor_person_id: string | null;
        acting_solicitor_organisation_id: string | null;
        sort_order: number;
        metadata_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, matter_id, entity_type, entity_id,
                relationship_id, capacity_id,
                acting_solicitor_person_id, acting_solicitor_organisation_id,
                sort_order, metadata_json
         FROM public.matter_parties
         WHERE tenant_id = $1
           AND matter_id IN (
             SELECT DISTINCT matter_id
             FROM public.matter_parties
             WHERE tenant_id = $1
               AND (
                 (entity_type = $2 AND entity_id = $3)
                 OR acting_solicitor_person_id = $3
                 OR acting_solicitor_organisation_id = $3
                 OR metadata_json::text LIKE $4 ESCAPE '\\'
               )
           )
         ORDER BY matter_id ASC, sort_order ASC, id ASC
         FOR UPDATE`,
        [ctx.tenantId, recordType, mergedId, likeMergedPattern],
      );
      const mpByMatter = new Map<string, (typeof mpRows.rows)[number][]>();
      for (const mp of mpRows.rows) {
        this.assertRowTenant(ctx, mp.tenant_id, 'matter_parties.executeMergeInTransaction');
        const list = mpByMatter.get(mp.matter_id) ?? [];
        list.push(mp);
        mpByMatter.set(mp.matter_id, list);
      }
      const deletedMatterPartyRowIds: string[] = [];
      for (const [, rows] of mpByMatter) {
        const survivingSignatures = new Map<string, string>();
        const deletedMetaIdToSurvivorMetaId = new Map<string, string>();
        const prepared: Array<{
          row: (typeof rows)[number];
          nextEntityId: string | null;
          nextMeta: Record<string, unknown>;
          metaChanged: boolean;
          entityChanged: boolean;
        }> = [];

        const makeSignature = (
          row: (typeof rows)[number],
          entityId: string | null,
          meta: Record<string, unknown>,
        ): string | null => {
          if (row.entity_type !== recordType || entityId !== survivorId) return null;
          const relCode =
            typeof meta.relationshipCode === 'string' && meta.relationshipCode
              ? meta.relationshipCode
              : (row.relationship_id ?? '');
          const capCodes =
            Array.isArray(meta.capacityCodes) && meta.capacityCodes.length > 0
              ? [...meta.capacityCodes].map(String).sort().join('|')
              : (row.capacity_id ?? '');
          const roleFallback =
            !meta.relationshipCode && typeof meta.role === 'string'
              ? meta.role.trim().toLowerCase()
              : '';
          return `${row.entity_type}:${entityId}:${relCode}:${capCodes}:${roleFallback}`;
        };

        // First register already-surviving rows for survivorId so their party IDs win on collision
        for (const r of rows) {
          const meta =
            r.metadata_json && typeof r.metadata_json === 'object'
              ? (structuredClone(r.metadata_json) as Record<string, unknown>)
              : {};
          if (r.entity_type === recordType && r.entity_id === survivorId) {
            const sig = makeSignature(r, r.entity_id, meta);
            const metaId = typeof meta.id === 'string' && meta.id ? meta.id : r.id;
            if (sig && !survivingSignatures.has(sig)) {
              survivingSignatures.set(sig, metaId);
            }
          }
        }

        for (const r of rows) {
          let entityChanged = false;
          let nextEntityId = r.entity_id;
          if (r.entity_type === recordType && r.entity_id === mergedId) {
            nextEntityId = survivorId;
            entityChanged = true;
          }
          const baseMeta =
            r.metadata_json && typeof r.metadata_json === 'object'
              ? (structuredClone(r.metadata_json) as Record<string, unknown>)
              : {};
          const repointedMeta = repointJsonIdFieldsInValue(baseMeta, mergedId, survivorId, {
            allowDirectIdField: false,
          });
          const nextMeta = repointedMeta.value as Record<string, unknown>;
          const metaChanged = repointedMeta.changed;

          const sig = makeSignature(r, nextEntityId, nextMeta);
          const metaId = typeof nextMeta.id === 'string' && nextMeta.id ? nextMeta.id : r.id;
          if (sig) {
            const existingMetaId = survivingSignatures.get(sig);
            if (existingMetaId && r.entity_id === mergedId) {
              deletedMatterPartyRowIds.push(r.id);
              deletedMetaIdToSurvivorMetaId.set(metaId, existingMetaId);
              continue;
            }
            if (!existingMetaId) {
              survivingSignatures.set(sig, metaId);
            }
          }

          prepared.push({
            row: r,
            nextEntityId,
            nextMeta,
            metaChanged,
            entityChanged,
          });
        }

        for (const item of prepared) {
          let finalMetaChanged = item.metaChanged;
          if (
            typeof item.nextMeta.connectedToPartyId === 'string' &&
            deletedMetaIdToSurvivorMetaId.has(item.nextMeta.connectedToPartyId)
          ) {
            item.nextMeta.connectedToPartyId = deletedMetaIdToSurvivorMetaId.get(
              item.nextMeta.connectedToPartyId,
            );
            finalMetaChanged = true;
          }
          if (item.entityChanged || finalMetaChanged) {
            await tx.query(
              `UPDATE public.matter_parties
               SET entity_id = $3,
                   metadata_json = $4::jsonb,
                   updated_at = NOW()
               WHERE tenant_id = $1 AND id = $2`,
              [
                ctx.tenantId,
                item.row.id,
                item.nextEntityId,
                JSON.stringify(item.nextMeta),
              ],
            );
          }
        }
      }
      if (deletedMatterPartyRowIds.length > 0) {
        await tx.query(
          `DELETE FROM public.matter_parties
           WHERE tenant_id = $1 AND id = ANY($2::text[])`,
          [ctx.tenantId, deletedMatterPartyRowIds],
        );
      }

      // 6. Repoint documents & document_links (preserve distinct link_role entries per document)
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
           AND dl_surv.entity_id = $4
           AND dl_merged.link_role = dl_surv.link_role`,
        [ctx.tenantId, recordType, mergedId, survivorId],
      );
      await tx.query(
        `UPDATE public.document_links
         SET entity_id = $2
         WHERE tenant_id = $1 AND entity_type = $3 AND entity_id = $4`,
        [ctx.tenantId, survivorId, recordType, mergedId],
      );

      // 7. Repoint enquiries (`S0-17a` + `S0-21` profile_json & snapshot sync)
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
        profile_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, conflict_snapshot_json, profile_json
         FROM public.enquiries
         WHERE tenant_id = $1
           AND (
             conflict_snapshot_json IS NOT NULL
             OR profile_json::text LIKE $2 ESCAPE '\\'
           )
         FOR UPDATE`,
        [ctx.tenantId, likeMergedPattern],
      );
      for (const enqRow of enqSnapRes.rows) {
        this.assertRowTenant(
          ctx,
          enqRow.tenant_id,
          'enquiries.executeMergeInTransaction',
        );
        let rowChanged = false;
        let nextSnap = enqRow.conflict_snapshot_json;
        if (nextSnap && typeof nextSnap === 'object') {
          const snapRes = rewriteConflictSnapshotJson(
            nextSnap,
            recordType,
            mergedId,
            survivorId,
          );
          if (snapRes.changed) {
            nextSnap = snapRes.next;
            rowChanged = true;
          }
        }

        let nextProfile = enqRow.profile_json;
        if (nextProfile && typeof nextProfile === 'object') {
          const clonedProfile = structuredClone(nextProfile) as Record<string, unknown>;
          let profChanged = false;
          if (recordType === 'person') {
            for (const field of ['linkedPersonId', 'referrerPersonId']) {
              if (clonedProfile[field] === mergedId) {
                clonedProfile[field] = survivorId;
                profChanged = true;
              }
            }
          } else {
            for (const field of ['linkedOrganisationId', 'referredToOrganisationId']) {
              if (clonedProfile[field] === mergedId) {
                clonedProfile[field] = survivorId;
                profChanged = true;
              }
            }
          }
          if (
            clonedProfile.conflictSnapshot &&
            typeof clonedProfile.conflictSnapshot === 'object'
          ) {
            const profSnapRes = rewriteConflictSnapshotJson(
              clonedProfile.conflictSnapshot as Record<string, unknown>,
              recordType,
              mergedId,
              survivorId,
            );
            if (profSnapRes.changed) {
              clonedProfile.conflictSnapshot = profSnapRes.next;
              profChanged = true;
            }
          }
          if (profChanged) {
            nextProfile = clonedProfile;
            rowChanged = true;
          }
        }

        if (rowChanged) {
          await tx.query(
            `UPDATE public.enquiries
             SET conflict_snapshot_json = $3::jsonb,
                 profile_json = $4::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              enqRow.id,
              nextSnap ? JSON.stringify(nextSnap) : null,
              JSON.stringify(nextProfile ?? {}),
            ],
          );
        }
      }

      // 8. Repoint quotes (`S0-17a` + `S0-21` profile_json & conflict_decision_json sync)
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
      const quoteRows = await tx.query<{
        tenant_id: string;
        id: string;
        conflict_decision_json: Record<string, unknown> | null;
        profile_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, conflict_decision_json, profile_json
         FROM public.quotes
         WHERE tenant_id = $1
           AND (
             (conflict_decision_json IS NOT NULL AND conflict_decision_json::text LIKE $2 ESCAPE '\\')
             OR profile_json::text LIKE $2 ESCAPE '\\'
           )
         FOR UPDATE`,
        [ctx.tenantId, likeMergedPattern],
      );
      for (const qRow of quoteRows.rows) {
        this.assertRowTenant(ctx, qRow.tenant_id, 'quotes.executeMergeInTransaction');
        let qChanged = false;
        let nextDecision = qRow.conflict_decision_json;
        if (nextDecision && typeof nextDecision === 'object') {
          const res = repointJsonIdFieldsInValue(nextDecision, mergedId, survivorId, {
            allowDirectIdField: false,
          });
          if (res.changed) {
            nextDecision = res.value as Record<string, unknown>;
            qChanged = true;
          }
        }
        let nextProfile = qRow.profile_json;
        if (nextProfile && typeof nextProfile === 'object') {
          const res = repointJsonIdFieldsInValue(nextProfile, mergedId, survivorId, {
            allowDirectIdField: false,
          });
          if (res.changed) {
            nextProfile = res.value as Record<string, unknown>;
            qChanged = true;
          }
        }
        if (qChanged) {
          await tx.query(
            `UPDATE public.quotes
             SET conflict_decision_json = $3::jsonb,
                 profile_json = $4::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              qRow.id,
              nextDecision ? JSON.stringify(nextDecision) : null,
              JSON.stringify(nextProfile ?? {}),
            ],
          );
        }
      }

      // 9. Repoint task_linked_records & tasks JSONB (`S0-17a` + `S0-21`)
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
      const taskRows = await tx.query<{
        tenant_id: string;
        id: string;
        linked_records_json: Array<{ recordType?: string; recordId?: string }> | null;
        profile_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, linked_records_json, profile_json
         FROM public.tasks
         WHERE tenant_id = $1
           AND (
             linked_records_json::text LIKE $2 ESCAPE '\\'
             OR profile_json::text LIKE $2 ESCAPE '\\'
           )
         FOR UPDATE`,
        [ctx.tenantId, likeMergedPattern],
      );
      const remapTaskLinks = (
        arr: unknown,
      ): { next: Array<{ recordType: string; recordId: string }>; changed: boolean } => {
        if (!Array.isArray(arr)) return { next: [], changed: false };
        let changed = false;
        const seen = new Set<string>();
        const out: Array<{ recordType: string; recordId: string }> = [];
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as { recordType?: string; recordId?: string };
          const rType = typeof rec.recordType === 'string' ? rec.recordType : '';
          let rId = typeof rec.recordId === 'string' ? rec.recordId : '';
          if (rType === recordType && rId === mergedId) {
            rId = survivorId;
            changed = true;
          }
          const key = `${rType}:${rId}`;
          if (seen.has(key)) {
            changed = true;
            continue;
          }
          seen.add(key);
          out.push({ recordType: rType, recordId: rId });
        }
        return { next: out, changed };
      };
      for (const tRow of taskRows.rows) {
        this.assertRowTenant(ctx, tRow.tenant_id, 'tasks.executeMergeInTransaction');
        let taskChanged = false;
        let nextLinkedJson = tRow.linked_records_json ?? [];
        if (Array.isArray(tRow.linked_records_json)) {
          const remapped = remapTaskLinks(tRow.linked_records_json);
          if (remapped.changed) {
            nextLinkedJson = remapped.next;
            taskChanged = true;
          }
        }
        let nextProfile = tRow.profile_json;
        if (nextProfile && typeof nextProfile === 'object') {
          const clonedProf = structuredClone(nextProfile) as Record<string, unknown>;
          let profChanged = false;
          if (Array.isArray(clonedProf.linkedRecords)) {
            const remappedProf = remapTaskLinks(clonedProf.linkedRecords);
            if (remappedProf.changed) {
              clonedProf.linkedRecords = remappedProf.next;
              profChanged = true;
            }
          }
          if (profChanged) {
            nextProfile = clonedProf;
            taskChanged = true;
          }
        }
        if (taskChanged) {
          await tx.query(
            `UPDATE public.tasks
             SET linked_records_json = $3::jsonb,
                 profile_json = $4::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              tRow.id,
              JSON.stringify(nextLinkedJson),
              JSON.stringify(nextProfile ?? {}),
            ],
          );
        }
      }

      // 10. Repoint notifications (`S0-17a` + `S0-21` path-boundary href & metadata_json sync)
      const notifRows = await tx.query<{
        tenant_id: string;
        id: string;
        record_id: string;
        href: string;
        by_id: string | null;
        metadata_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, record_id, href, by_id, metadata_json
         FROM public.notifications
         WHERE tenant_id = $1
           AND (
             record_id = $2
             OR by_id = $2
             OR href LIKE $3 ESCAPE '\\'
             OR metadata_json::text LIKE $3 ESCAPE '\\'
           )
         FOR UPDATE`,
        [ctx.tenantId, mergedId, likeMergedPattern],
      );
      for (const nRow of notifRows.rows) {
        this.assertRowTenant(ctx, nRow.tenant_id, 'notifications.executeMergeInTransaction');
        const nextRecordId = nRow.record_id === mergedId ? survivorId : nRow.record_id;
        const nextById = nRow.by_id === mergedId ? survivorId : nRow.by_id;
        const nextHref =
          typeof nRow.href === 'string'
            ? replaceRecordIdPathSegment(nRow.href, mergedId, survivorId)
            : nRow.href;
        let metaChanged = false;
        let nextMeta = nRow.metadata_json;
        if (nextMeta && typeof nextMeta === 'object') {
          const clonedMeta = structuredClone(nextMeta) as Record<string, unknown>;
          if (clonedMeta.recordId === mergedId) {
            clonedMeta.recordId = survivorId;
            metaChanged = true;
          }
          if (clonedMeta.byId === mergedId) {
            clonedMeta.byId = survivorId;
            metaChanged = true;
          }
          if (typeof clonedMeta.href === 'string') {
            const mappedMetaHref = replaceRecordIdPathSegment(
              clonedMeta.href,
              mergedId,
              survivorId,
            );
            if (mappedMetaHref !== clonedMeta.href) {
              clonedMeta.href = mappedMetaHref;
              metaChanged = true;
            }
          }
          if (metaChanged) {
            nextMeta = clonedMeta;
          }
        }
        if (
          nextRecordId !== nRow.record_id ||
          nextById !== nRow.by_id ||
          nextHref !== nRow.href ||
          metaChanged
        ) {
          await tx.query(
            `UPDATE public.notifications
             SET record_id = $3,
                 href = $4,
                 by_id = $5,
                 metadata_json = $6::jsonb
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              nRow.id,
              nextRecordId,
              nextHref,
              nextById,
              JSON.stringify(nextMeta ?? {}),
            ],
          );
        }
      }

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

      // 12. Repoint teams, employee_employment_records, and employee_sensitive_records (`S0-17b`)
      if (recordType === 'person') {
        const teamRes = await tx.query<{
          tenant_id: string;
          id: string;
          member_ids_json: string[] | null;
          lead_ids_json: string[] | null;
          payload_json: Record<string, unknown> | null;
        }>(
          `SELECT tenant_id, id, member_ids_json, lead_ids_json, payload_json
           FROM public.teams
           WHERE tenant_id = $1
             AND (member_ids_json ? $2 OR lead_ids_json ? $2)
           FOR UPDATE`,
          [ctx.tenantId, mergedId],
        );
        for (const teamRow of teamRes.rows) {
          this.assertRowTenant(ctx, teamRow.tenant_id, 'teams.executeMergeInTransaction');
          const remapIds = (arr: string[] | null | undefined): string[] => {
            if (!Array.isArray(arr)) return [];
            const out: string[] = [];
            for (const item of arr) {
              const mapped = item === mergedId ? survivorId : item;
              if (!out.includes(mapped)) out.push(mapped);
            }
            return out;
          };
          const nextMembers = remapIds(teamRow.member_ids_json);
          const nextLeads = remapIds(teamRow.lead_ids_json);
          const nextPayload: Record<string, unknown> =
            teamRow.payload_json && typeof teamRow.payload_json === 'object'
              ? { ...teamRow.payload_json, memberIds: nextMembers, leadIds: nextLeads }
              : { id: teamRow.id, memberIds: nextMembers, leadIds: nextLeads };
          await tx.query(
            `UPDATE public.teams
             SET member_ids_json = $3::jsonb,
                 lead_ids_json = $4::jsonb,
                 payload_json = $5::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              teamRow.id,
              JSON.stringify(nextMembers),
              JSON.stringify(nextLeads),
              JSON.stringify(nextPayload),
            ],
          );
        }

        // Preserve merged person's sensitive HR / payroll onto survivor if survivor has none
        await tx.query(
          `INSERT INTO public.employee_sensitive_records (
             tenant_id, person_id, updated_at, updated_by_id, payroll_json, sensitive_hr_json
           )
           SELECT
             tenant_id, $2, NOW(), updated_by_id, payroll_json, sensitive_hr_json
           FROM public.employee_sensitive_records
           WHERE tenant_id = $1 AND person_id = $3
           ON CONFLICT (tenant_id, person_id) DO UPDATE SET
             payroll_json = COALESCE(public.employee_sensitive_records.payroll_json, EXCLUDED.payroll_json),
             sensitive_hr_json = COALESCE(public.employee_sensitive_records.sensitive_hr_json, EXCLUDED.sensitive_hr_json),
             updated_at = NOW()`,
          [ctx.tenantId, survivorId, mergedId],
        );

        // Repoint manager / supervisor / approver person references inside employee_employment_records
        const empRows = await tx.query<{
          tenant_id: string;
          person_id: string;
          employment_json: Record<string, unknown> | null;
        }>(
          `SELECT tenant_id, person_id, employment_json
           FROM public.employee_employment_records
           WHERE tenant_id = $1
           FOR UPDATE`,
          [ctx.tenantId],
        );
        for (const empRow of empRows.rows) {
          this.assertRowTenant(
            ctx,
            empRow.tenant_id,
            'employee_employment_records.executeMergeInTransaction',
          );
          const emp = empRow.employment_json;
          if (!emp || typeof emp !== 'object') continue;
          let empChanged = false;
          const nextEmp = structuredClone(emp) as Record<string, unknown>;
          for (const key of [
            'supervisorPersonId',
            'lineManagerPersonId',
            'approverPersonId',
            'secondaryApproverPersonId',
          ]) {
            if (nextEmp[key] === mergedId) {
              nextEmp[key] = survivorId;
              empChanged = true;
            }
          }
          if (empChanged) {
            await tx.query(
              `UPDATE public.employee_employment_records
               SET employment_json = $3::jsonb, updated_at = NOW()
               WHERE tenant_id = $1 AND person_id = $2`,
              [ctx.tenantId, empRow.person_id, JSON.stringify(nextEmp)],
            );
          }
        }
      }

      // 12b. Repoint pms_links (`S0-18`), discarding colliding links where survivor already has one for the same entity_type
      await tx.query(
        `DELETE FROM public.pms_links pl_merged
         USING public.pms_links pl_surv
         WHERE pl_merged.tenant_id = $1
           AND pl_surv.tenant_id = $1
           AND pl_merged.onesquared_id = $3
           AND pl_surv.onesquared_id = $2
           AND pl_merged.entity_type = pl_surv.entity_type`,
        [ctx.tenantId, survivorId, mergedId],
      );
      await tx.query(
        `UPDATE public.pms_links
         SET onesquared_id = $2,
             payload_json = jsonb_set(payload_json, '{onesquaredId}', to_jsonb($2::text), true)
         WHERE tenant_id = $1 AND onesquared_id = $3`,
        [ctx.tenantId, survivorId, mergedId],
      );

      // 12b. Reconcile negotiated client_rate_overrides (`S0-28a`):
      //      Repoint non-overlapping merged overrides to survivor; preserve survivor on overlapping
      //      (practice_area_id, grade_key, effective_from..effective_to) ranges and remove colliding rows.
      const overrideRowsRes = await tx.query<{
        tenant_id: string;
        id: string;
        client_type: string;
        client_id: string;
        practice_area_id: string | null;
        grade_key: string;
        effective_from_ymd: string;
        effective_to_ymd: string | null;
      }>(
        `SELECT tenant_id, id, client_type, client_id, practice_area_id, grade_key,
                TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from_ymd,
                TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to_ymd
         FROM public.client_rate_overrides
         WHERE tenant_id = $1 AND client_id = ANY($2::text[])
         ORDER BY CASE WHEN client_id = $3 THEN 0 ELSE 1 END, effective_from ASC, id ASC
         FOR UPDATE`,
        [ctx.tenantId, [survivorId, mergedId], survivorId],
      );
      const acceptedSurvivorOverrides: Array<{
        practiceAreaId: string | null;
        gradeKey: string;
        effectiveFrom: string;
        effectiveTo: string | null;
      }> = [];
      const mergedOverridesToCheck: Array<{
        id: string;
        practiceAreaId: string | null;
        gradeKey: string;
        effectiveFrom: string;
        effectiveTo: string | null;
      }> = [];
      for (const row of overrideRowsRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'client_rate_overrides.executeMergeInTransaction');
        const normalised = {
          id: row.id,
          practiceAreaId: row.practice_area_id ?? null,
          gradeKey: row.grade_key,
          effectiveFrom: row.effective_from_ymd,
          effectiveTo: row.effective_to_ymd ?? null,
        };
        if (row.client_id === survivorId) {
          acceptedSurvivorOverrides.push(normalised);
        } else if (row.client_id === mergedId) {
          mergedOverridesToCheck.push(normalised);
        }
      }

      const repointedOverrideIds: string[] = [];
      const droppedOverrideIds: string[] = [];
      for (const mergedOvr of mergedOverridesToCheck) {
        const collidesWithSurvivor = acceptedSurvivorOverrides.some(
          (survOvr) =>
            survOvr.practiceAreaId === mergedOvr.practiceAreaId &&
            survOvr.gradeKey === mergedOvr.gradeKey &&
            doEffectiveDateRangesOverlap(
              survOvr.effectiveFrom,
              survOvr.effectiveTo,
              mergedOvr.effectiveFrom,
              mergedOvr.effectiveTo,
            ),
        );
        if (collidesWithSurvivor) {
          await tx.query(
            `DELETE FROM public.client_rate_overrides
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, mergedOvr.id],
          );
          droppedOverrideIds.push(mergedOvr.id);
        } else {
          await tx.query(
            `UPDATE public.client_rate_overrides
             SET client_id = $2,
                 client_type = $3,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $4`,
            [ctx.tenantId, survivorId, recordType, mergedOvr.id],
          );
          acceptedSurvivorOverrides.push(mergedOvr);
          repointedOverrideIds.push(mergedOvr.id);
        }
      }

      // 12c. Repoint register_records (`R515` / `R551` / `R565` / `S0-24`):
      //      Repoint person_id / organisation_id foreign-reference columns plus any matching JSON IDs
      //      (including nested `{ id: <mergedId> }` objects) in field_values_json, bumping row_version.
      if (recordType === 'person') {
        await tx.query(
          `UPDATE public.register_records
           SET person_id = $2, row_version = row_version + 1, updated_at = NOW()
           WHERE tenant_id = $1 AND person_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      } else {
        await tx.query(
          `UPDATE public.register_records
           SET organisation_id = $2, row_version = row_version + 1, updated_at = NOW()
           WHERE tenant_id = $1 AND organisation_id = $3`,
          [ctx.tenantId, survivorId, mergedId],
        );
      }
      const regRows = await tx.query<{
        tenant_id: string;
        id: string;
        field_values_json: Record<string, unknown> | null;
      }>(
        `SELECT tenant_id, id, field_values_json
         FROM public.register_records
         WHERE tenant_id = $1
           AND field_values_json::text LIKE $2 ESCAPE '\\'
         FOR UPDATE`,
        [ctx.tenantId, likeMergedPattern],
      );
      for (const regRow of regRows.rows) {
        this.assertRowTenant(ctx, regRow.tenant_id, 'register_records.executeMergeInTransaction');
        const fv = regRow.field_values_json;
        if (!fv || typeof fv !== 'object') continue;
        const repointed = repointJsonIdFieldsInValue(fv, mergedId, survivorId, {
          allowDirectIdField: true,
          repointAnyStringValue: true,
        });
        if (repointed.changed) {
          await tx.query(
            `UPDATE public.register_records
             SET field_values_json = $3::jsonb, row_version = row_version + 1, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, regRow.id, JSON.stringify(repointed.value ?? {})],
          );
        }
      }

      // 13. Record merge_history & audit_entries in the same transaction
      if (params.mergeHistory) {
        await this.upsertMergeHistoryInTx(tx, ctx, params.mergeHistory);
      }
      const extraOverrideMergeAudit: AppendTenantAuditEntryInput[] =
        repointedOverrideIds.length > 0 || droppedOverrideIds.length > 0
          ? [
              {
                recordType,
                recordId: survivorId,
                action: 'merge',
                field: 'clientRateOverrides',
                oldValue: mergedId,
                newValue: survivorId,
                reason: `Reconciled negotiated client rate overrides on merge of ${mergedId} into ${survivorId}: repointed [${repointedOverrideIds.join(', ') || 'none'}], superseded overlapping [${droppedOverrideIds.join(', ') || 'none'}].`,
                byId: params.mergeHistory?.byId ?? ctx.actorId ?? 'system',
                at: params.mergeHistory?.at ?? new Date().toISOString(),
              },
            ]
          : [];
      const combinedAuditEntries = [
        ...(params.auditEntries ?? []),
        ...extraOverrideMergeAudit,
      ];
      if (combinedAuditEntries.length > 0) {
        const auditRepo = new TenantAuditRepository();
        await auditRepo.appendAuditEntries(ctx, combinedAuditEntries);
      }
    });
  }

  // ============================================================================
  // S1-02a Scoped Lookups & Candidate Graph Selection
  // ============================================================================

  public async listPeopleByIds<TPerson extends TenantPersonRecord = TenantPersonRecord>(
    ctx: TenantContext,
    personIds: readonly string[],
  ): Promise<TPerson[]> {
    const cleanIds = Array.from(
      new Set(personIds.map((id) => id?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonRow>(
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
         WHERE p.tenant_id = $1
           AND p.id = ANY($2::text[])
         ORDER BY p.id ASC`,
        [ctx.tenantId, cleanIds],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Person');
        return mapPersonRow<TPerson>(row);
      });
    });
  }

  public async listOrganisationsByIds<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    organisationIds: readonly string[],
  ): Promise<TOrg[]> {
    const cleanIds = Array.from(
      new Set(organisationIds.map((id) => id?.trim()).filter(Boolean) as string[]),
    );
    if (cleanIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbOrganisationRow>(
        `SELECT * FROM public.organisations
         WHERE tenant_id = $1 AND id = ANY($2::text[])
         ORDER BY id ASC`,
        [ctx.tenantId, cleanIds],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
        return mapOrganisationRow<TOrg>(row);
      });
    });
  }

  public async listLinksForEntities<TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord>(
    ctx: TenantContext,
    filter: {
      readonly personIds?: readonly string[];
      readonly organisationIds?: readonly string[];
    },
  ): Promise<TLink[]> {
    const pIds = Array.from(
      new Set((filter.personIds ?? []).map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    const oIds = Array.from(
      new Set((filter.organisationIds ?? []).map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (pIds.length === 0 && oIds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const clauses: string[] = [];
      const params: unknown[] = [ctx.tenantId];
      if (pIds.length > 0) {
        params.push(pIds);
        clauses.push(`person_id = ANY($${params.length}::text[])`);
      }
      if (oIds.length > 0) {
        params.push(oIds);
        clauses.push(`organisation_id = ANY($${params.length}::text[])`);
      }
      const res = await tx.query<DbLinkRow>(
        `SELECT * FROM public.person_organisation_links
         WHERE tenant_id = $1 AND (${clauses.join(' OR ')})
         ORDER BY id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Link');
        return mapLinkRow<TLink>(row);
      });
    });
  }

  public async listNotesForRecords<TNote extends TenantNoteRecord = TenantNoteRecord>(
    ctx: TenantContext,
    records: readonly { readonly recordType: string; readonly recordId: string }[],
  ): Promise<TNote[]> {
    const clean = records.filter((r) => r.recordType?.trim() && r.recordId?.trim());
    if (clean.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const recordIds = Array.from(new Set(clean.map((r) => r.recordId)));
      const recordTypes = Array.from(new Set(clean.map((r) => r.recordType)));
      const res = await tx.query<DbNoteRow>(
        `SELECT * FROM public.notes
         WHERE tenant_id = $1
           AND record_type = ANY($2::text[])
           AND record_id = ANY($3::text[])
         ORDER BY created_at DESC, id DESC`,
        [ctx.tenantId, recordTypes, recordIds],
      );
      const wanted = new Set(clean.map((r) => `${r.recordType}::${r.recordId}`));
      return res.rows
        .filter((row) => {
          this.assertRowTenant(ctx, row.tenant_id, 'Note');
          return wanted.has(`${row.record_type}::${row.record_id}`);
        })
        .map((row) => mapNoteRow<TNote>(row));
    });
  }

  public async listMergeHistoryForEntity<TMerge extends TenantMergeHistoryRecord = TenantMergeHistoryRecord>(
    ctx: TenantContext,
    entityId: string,
    recordType?: string,
  ): Promise<TMerge[]> {
    if (!entityId?.trim()) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const params: unknown[] = [ctx.tenantId, entityId.trim()];
      let typeClause = '';
      if (recordType) {
        params.push(recordType);
        typeClause = ` AND record_type = $${params.length}`;
      }
      const res = await tx.query<DbMergeHistoryRow>(
        `SELECT * FROM public.merge_history
         WHERE tenant_id = $1
           AND (survivor_id = $2 OR merged_id = $2)${typeClause}
         ORDER BY merged_at DESC, id DESC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'MergeHistory');
        return mapMergeHistoryRow<TMerge>(row);
      });
    });
  }

  public async expandCorporateGroupOrganisationIds<TOrg extends TenantOrganisationRecord = TenantOrganisationRecord>(
    ctx: TenantContext,
    seedOrganisationIds: readonly string[],
  ): Promise<TOrg[]> {
    const cleanSeeds = Array.from(
      new Set(seedOrganisationIds.map((x) => x?.trim()).filter(Boolean) as string[]),
    );
    if (cleanSeeds.length === 0) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbOrganisationRow>(
        `WITH RECURSIVE
         ancestors(id, depth) AS (
           SELECT id, 0
           FROM public.organisations
           WHERE tenant_id = $1 AND id = ANY($2::text[]) AND merged_into_id IS NULL
           UNION ALL
           SELECT parent.id, a.depth + 1
           FROM ancestors a
           JOIN public.organisations child
             ON child.tenant_id = $1 AND child.id = a.id
           JOIN public.organisations parent
             ON parent.tenant_id = $1 AND parent.id = child.parent_organisation_id
           WHERE parent.merged_into_id IS NULL AND a.depth < 10
         ),
         descendants(id, depth) AS (
           SELECT id, 0
           FROM public.organisations
           WHERE tenant_id = $1 AND id = ANY($2::text[]) AND merged_into_id IS NULL
           UNION ALL
           SELECT child.id, d.depth + 1
           FROM descendants d
           JOIN public.organisations child
             ON child.tenant_id = $1 AND child.parent_organisation_id = d.id
           WHERE child.merged_into_id IS NULL AND d.depth < 10
         ),
         all_group_ids AS (
           SELECT id FROM ancestors
           UNION
           SELECT id FROM descendants
         )
         SELECT o.*
         FROM public.organisations o
         JOIN all_group_ids g ON o.id = g.id
         WHERE o.tenant_id = $1
         ORDER BY o.id ASC`,
        [ctx.tenantId, cleanSeeds],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
        return mapOrganisationRow<TOrg>(row);
      });
    });
  }

  public async findSqlDuplicateCandidates<
    TRecord extends TenantPersonRecord | TenantOrganisationRecord =
      | TenantPersonRecord
      | TenantOrganisationRecord,
  >(
    ctx: TenantContext,
    query:
      | {
          readonly kind: 'person';
          readonly id?: string;
          readonly firstName?: string;
          readonly preferredName?: string;
          readonly surname?: string;
          readonly otherNames?: readonly string[];
          readonly emails?: readonly string[];
          readonly phones?: readonly string[];
          readonly postcodes?: readonly string[];
          readonly fuzzy?: boolean;
          readonly includeMerged?: boolean;
        }
      | {
          readonly kind: 'organisation';
          readonly id?: string;
          readonly legalName?: string;
          readonly otherNames?: readonly string[];
          readonly companyNumber?: string;
          readonly companyNumbers?: readonly string[];
          readonly emails?: readonly string[];
          readonly phones?: readonly string[];
          readonly postcodes?: readonly string[];
          readonly fuzzy?: boolean;
          readonly includeMerged?: boolean;
        },
  ): Promise<TRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      if (query.kind === 'person') {
        const emails = Array.from(
          new Set(
            (query.emails ?? [])
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean),
          ),
        );
        const phoneLast9s = Array.from(
          new Set(
            (query.phones ?? []).map(normalisePhoneLast9Key).filter(Boolean),
          ),
        );
        const postcodes = Array.from(
          new Set(
            (query.postcodes ?? []).map(normalisePostcodeKey).filter(Boolean),
          ),
        );
        const nameTexts = [
          query.firstName,
          query.preferredName,
          query.surname,
          ...(query.otherNames ?? []),
        ].filter(Boolean) as string[];
        const phoneticOnly = extractTokenPhoneticKeys(nameTexts).filter(
          (k) => k.startsWith('P:') || k.startsWith('S:'),
        );
        const surnameTokens = [query.surname]
          .map(normaliseComparableNameKey)
          .filter(Boolean);
        const firstTokens = [query.firstName, query.preferredName]
          .map(normaliseComparableNameKey)
          .filter(Boolean);
        const fullTerms = Array.from(
          new Set(
            [
              `${query.firstName ?? ''} ${query.surname ?? ''}`.trim(),
              `${query.preferredName ?? ''} ${query.surname ?? ''}`.trim(),
              query.firstName?.trim() ?? '',
              query.surname?.trim() ?? '',
              ...(query.otherNames ?? []).map((n) => n.trim()),
            ].filter((t) => t.length >= 2),
          ),
        );

        const orClauses: string[] = [];
        const params: unknown[] = [ctx.tenantId];

        if (query.id?.trim()) {
          params.push(query.id.trim());
          orClauses.push(`p.id = $${params.length}`);
        }
        if (emails.length > 0) {
          params.push(emails);
          const idx = params.length;
          orClauses.push(
            `(p.primary_email_lower = ANY($${idx}::text[]) OR EXISTS (SELECT 1 FROM public.person_emails pe WHERE pe.tenant_id = p.tenant_id AND pe.person_id = p.id AND pe.active = TRUE AND pe.email_lower = ANY($${idx}::text[])))`,
          );
        }
        if (phoneLast9s.length > 0) {
          params.push(phoneLast9s);
          orClauses.push(`p.phone_last9_keys && $${params.length}::text[]`);
        }
        if (postcodes.length > 0) {
          params.push(postcodes);
          orClauses.push(`p.postcode_keys && $${params.length}::text[]`);
        }
        if (phoneticOnly.length > 0 && surnameTokens.length > 0) {
          const surnameKeys = extractTokenPhoneticKeys(surnameTokens).filter(
            (k) => !k.startsWith('I:'),
          );
          if (surnameKeys.length > 0) {
            params.push(surnameKeys);
            orClauses.push(`p.phonetic_keys && $${params.length}::text[]`);
          }
        } else if (phoneticOnly.length > 0 && fullTerms.length > 0) {
          params.push(phoneticOnly);
          orClauses.push(`p.phonetic_keys && $${params.length}::text[]`);
        }
        // Initial + surname or first-token matches when both exist (e.g. "J. Smith" vs "John Smith")
        if (firstTokens.length > 0 && surnameTokens.length > 0) {
          const firstInitials = firstTokens
            .map((t) => `I:${t[0]}`)
            .filter(Boolean);
          const surnameKeys = extractTokenPhoneticKeys(surnameTokens).filter(
            (k) => !k.startsWith('I:'),
          );
          if (firstInitials.length > 0 && surnameKeys.length > 0) {
            params.push(firstInitials, surnameKeys);
            orClauses.push(
              `(p.phonetic_keys && $${params.length - 1}::text[] AND p.phonetic_keys && $${params.length}::text[])`,
            );
          }
        }
        for (const term of fullTerms) {
          params.push(`%${escapeSqlLikePattern(term)}%`);
          const likeIdx = params.length;
          params.push(term);
          const termIdx = params.length;
          const pConcat = `lower(COALESCE(p.first_name, '') || ' ' || COALESCE(p.preferred_name, '') || ' ' || COALESCE(p.other_names, '') || ' ' || COALESCE(p.surname, ''))`;
          const pFull = `lower(trim(COALESCE(p.first_name, '') || ' ' || COALESCE(p.surname, '')))`;
          const pPref = `lower(trim(COALESCE(p.preferred_name, '') || ' ' || COALESCE(p.surname, '')))`;
          const pOther = `lower(trim(COALESCE(p.other_names, '')))`;
          orClauses.push(
            `(COALESCE(p.first_name, '') || ' ' || COALESCE(p.surname, '') ILIKE $${likeIdx} OR COALESCE(p.preferred_name, '') || ' ' || COALESCE(p.surname, '') ILIKE $${likeIdx} OR COALESCE(p.other_names, '') ILIKE $${likeIdx} OR word_similarity($${termIdx}, ${pConcat}) >= 0.28 OR word_similarity(${pConcat}, $${termIdx}) >= 0.28 OR (length(${pFull}) >= 3 AND strpos(lower($${termIdx}), ${pFull}) > 0) OR (length(${pPref}) >= 3 AND strpos(lower($${termIdx}), ${pPref}) > 0) OR (length(${pOther}) >= 3 AND strpos(lower($${termIdx}), ${pOther}) > 0))`,
          );
        }

        if (orClauses.length === 0) return [];
        const mergedClause = query.includeMerged
          ? ''
          : ' AND p.merged_into_id IS NULL';
        const res = await tx.query<DbPersonRow>(
          `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
           ${PEOPLE_LEFT_JOIN_HR}
           WHERE p.tenant_id = $1${mergedClause}
             AND (${orClauses.join(' OR ')})
           ORDER BY p.id ASC`,
          params,
        );
        return res.rows.map((row) => {
          this.assertRowTenant(ctx, row.tenant_id, 'Person');
          return mapPersonRow<TenantPersonRecord>(row) as TRecord;
        });
      }

      // Organisation candidate lookup
      const companyNos = Array.from(
        new Set(
          [query.companyNumber, ...(query.companyNumbers ?? [])]
            .map(normaliseRegNumberKey)
            .filter(Boolean),
        ),
      );
      const emails = Array.from(
        new Set(
          (query.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
        ),
      );
      const emailDomains = Array.from(
        new Set(
          emails
            .map(extractEmailDomainKey)
            .filter((d) => d && !FREE_EMAIL_DOMAINS_SET.has(d)),
        ),
      );
      const phoneLast9s = Array.from(
        new Set(
          (query.phones ?? []).map(normalisePhoneLast9Key).filter(Boolean),
        ),
      );
      const postcodes = Array.from(
        new Set(
          (query.postcodes ?? []).map(normalisePostcodeKey).filter(Boolean),
        ),
      );
      const orgNames = [query.legalName, ...(query.otherNames ?? [])]
        .map((n) => n?.trim() ?? '')
        .filter((n) => n.length >= 2);
      const phoneticKeys = extractTokenPhoneticKeys(orgNames).filter(
        (k) => !k.startsWith('I:'),
      );

      const orClauses: string[] = [];
      const params: unknown[] = [ctx.tenantId];

      if (query.id?.trim()) {
        params.push(query.id.trim());
        orClauses.push(`id = $${params.length}`);
      }
      if (companyNos.length > 0) {
        params.push(companyNos);
        orClauses.push(`norm_company_number = ANY($${params.length}::text[])`);
      }
      if (emails.length > 0) {
        params.push(emails);
        orClauses.push(`lower(general_email) = ANY($${params.length}::text[])`);
      }
      if (emailDomains.length > 0) {
        params.push(emailDomains);
        orClauses.push(`email_domains && $${params.length}::text[]`);
      }
      if (phoneLast9s.length > 0) {
        params.push(phoneLast9s);
        orClauses.push(`phone_last9_keys && $${params.length}::text[]`);
      }
      if (postcodes.length > 0) {
        params.push(postcodes);
        orClauses.push(`postcode_keys && $${params.length}::text[]`);
      }
      if (phoneticKeys.length > 0) {
        params.push(phoneticKeys);
        orClauses.push(`phonetic_keys && $${params.length}::text[]`);
      }
      for (const name of orgNames) {
        const comp = normaliseComparableNameKey(name);
        const searchTerm = comp || name;
        params.push(`%${escapeSqlLikePattern(searchTerm)}%`, searchTerm);
        const likeIdx = params.length - 1;
        const trgmIdx = params.length;
        const orgConcat = `lower(COALESCE(legal_name, '') || ' ' || COALESCE(trading_name, ''))`;
        const otherNameValueSql = `COALESCE(elem->>'name', CASE WHEN jsonb_typeof(elem) = 'string' THEN elem #>> '{}' ELSE '' END)`;
        orClauses.push(
          `(legal_name ILIKE $${likeIdx} OR trading_name ILIKE $${likeIdx} OR word_similarity($${trgmIdx}, ${orgConcat}) >= 0.28 OR word_similarity(${orgConcat}, $${trgmIdx}) >= 0.28 OR similarity(lower(legal_name), $${trgmIdx}) >= 0.25 OR (length(trim(legal_name)) >= 3 AND strpos(lower($${trgmIdx}), lower(trim(legal_name))) > 0) OR (length(trim(trading_name)) >= 3 AND strpos(lower($${trgmIdx}), lower(trim(trading_name))) > 0) OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(profile_json->'otherNames') = 'array' THEN profile_json->'otherNames' ELSE '[]'::jsonb END) AS elem WHERE ${otherNameValueSql} ILIKE $${likeIdx} OR word_similarity($${trgmIdx}, lower(${otherNameValueSql})) >= 0.28 OR word_similarity(lower(${otherNameValueSql}), $${trgmIdx}) >= 0.28 OR similarity(lower(${otherNameValueSql}), $${trgmIdx}) >= 0.25 OR (length(trim(${otherNameValueSql})) >= 3 AND strpos(lower($${trgmIdx}), lower(trim(${otherNameValueSql}))) > 0)))`,
        );
      }

      if (orClauses.length === 0) return [];
      const mergedClause = query.includeMerged
        ? ''
        : ' AND merged_into_id IS NULL';
      const res = await tx.query<DbOrganisationRow>(
        `SELECT * FROM public.organisations
         WHERE tenant_id = $1${mergedClause}
           AND (${orClauses.join(' OR ')})
         ORDER BY id ASC`,
        params,
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
        return mapOrganisationRow<TenantOrganisationRecord>(row) as TRecord;
      });
    });
  }

  public async findSqlConflictCandidates<
    TPerson extends TenantPersonRecord = TenantPersonRecord,
    TOrg extends TenantOrganisationRecord = TenantOrganisationRecord,
    TLink extends TenantPersonOrganisationLinkRecord = TenantPersonOrganisationLinkRecord,
  >(
    ctx: TenantContext,
    params: {
      readonly terms?: readonly string[];
      readonly emails?: readonly string[];
      readonly phones?: readonly string[];
      readonly postcodes?: readonly string[];
      readonly companyNumbers?: readonly string[];
      readonly linkedPersonIds?: readonly string[];
      readonly linkedOrganisationIds?: readonly string[];
    },
  ): Promise<{
    readonly people: TPerson[];
    readonly organisations: TOrg[];
    readonly links: TLink[];
    readonly directPersonIds: string[];
    readonly directOrganisationIds: string[];
  }> {
    const cleanTerms = Array.from(
      new Set((params.terms ?? []).map((t) => t.trim()).filter(Boolean)),
    );
    const cleanEmails = Array.from(
      new Set((params.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    );
    const cleanPhones = Array.from(
      new Set((params.phones ?? []).map(normalisePhoneLast9Key).filter(Boolean)),
    );
    const cleanPostcodes = Array.from(
      new Set((params.postcodes ?? []).map(normalisePostcodeKey).filter(Boolean)),
    );
    const cleanCompanyNos = Array.from(
      new Set((params.companyNumbers ?? []).map(normaliseRegNumberKey).filter(Boolean)),
    );
    const seedPersonIds = new Set(
      (params.linkedPersonIds ?? []).map((x) => x.trim()).filter(Boolean),
    );
    const seedOrgIds = new Set(
      (params.linkedOrganisationIds ?? []).map((x) => x.trim()).filter(Boolean),
    );

    const personMap = new Map<string, TPerson>();
    const orgMap = new Map<string, TOrg>();

    const expandMergeHistoryIds = async (
      personIds: Set<string>,
      orgIds: Set<string>,
    ): Promise<void> => {
      const checkedIds = new Set<string>();
      for (let hop = 0; hop < 3; hop += 1) {
        const frontier = [
          ...Array.from(personIds),
          ...Array.from(orgIds),
        ].filter((id) => id && !checkedIds.has(id));
        if (frontier.length === 0) break;
        for (const id of frontier) checkedIds.add(id);
        const mergeLists = await Promise.all(
          frontier.map((id) => this.listMergeHistoryForEntity(ctx, id)),
        );
        let discoveredNew = false;
        for (const list of mergeLists) {
          for (const mh of list) {
            if (mh.recordType === 'person') {
              if (mh.survivorId && !personIds.has(mh.survivorId)) {
                personIds.add(mh.survivorId);
                discoveredNew = true;
              }
              if (mh.mergedId && !personIds.has(mh.mergedId)) {
                personIds.add(mh.mergedId);
                discoveredNew = true;
              }
            } else if (mh.recordType === 'organisation') {
              if (mh.survivorId && !orgIds.has(mh.survivorId)) {
                orgIds.add(mh.survivorId);
                discoveredNew = true;
              }
              if (mh.mergedId && !orgIds.has(mh.mergedId)) {
                orgIds.add(mh.mergedId);
                discoveredNew = true;
              }
            }
          }
        }
        if (!discoveredNew) break;
      }
    };

    // Step 1: Traverse multi-hop merge history chains BEFORE loading seed people/organisations
    if (seedPersonIds.size > 0 || seedOrgIds.size > 0) {
      await expandMergeHistoryIds(seedPersonIds, seedOrgIds);
      const [directPeople, directOrgs] = await Promise.all([
        this.listPeopleByIds<TPerson>(ctx, Array.from(seedPersonIds)),
        this.listOrganisationsByIds<TOrg>(ctx, Array.from(seedOrgIds)),
      ]);
      for (const p of directPeople) personMap.set(p.id, p);
      for (const o of directOrgs) orgMap.set(o.id, o);
    }

    // Step 2: Query people & organisations matching terms/emails/phones/postcodes/companyNos
    for (const term of cleanTerms) {
      const tokens = normaliseComparableNameKey(term).split(' ').filter(Boolean);
      const firstNameGuess = tokens.length >= 2 ? tokens[0] : term;
      const surnameGuess = tokens.length >= 2 ? tokens[tokens.length - 1] : undefined;
      const [pHits, oHits] = await Promise.all([
        this.findSqlDuplicateCandidates<TPerson>(ctx, {
          kind: 'person',
          firstName: firstNameGuess,
          surname: surnameGuess,
          otherNames: [term],
          emails: cleanEmails,
          phones: cleanPhones,
          postcodes: cleanPostcodes,
          fuzzy: true,
          includeMerged: true,
        }),
        this.findSqlDuplicateCandidates<TOrg>(ctx, {
          kind: 'organisation',
          legalName: term,
          otherNames: [term],
          companyNumbers: cleanCompanyNos,
          emails: cleanEmails,
          phones: cleanPhones,
          postcodes: cleanPostcodes,
          fuzzy: true,
          includeMerged: true,
        }),
      ]);
      for (const p of pHits) personMap.set(p.id, p);
      for (const o of oHits) orgMap.set(o.id, o);
    }

    if (
      cleanTerms.length === 0 &&
      (cleanEmails.length > 0 ||
        cleanPhones.length > 0 ||
        cleanPostcodes.length > 0 ||
        cleanCompanyNos.length > 0)
    ) {
      const [pHits, oHits] = await Promise.all([
        this.findSqlDuplicateCandidates<TPerson>(ctx, {
          kind: 'person',
          emails: cleanEmails,
          phones: cleanPhones,
          postcodes: cleanPostcodes,
          includeMerged: true,
        }),
        this.findSqlDuplicateCandidates<TOrg>(ctx, {
          kind: 'organisation',
          companyNumbers: cleanCompanyNos,
          emails: cleanEmails,
          phones: cleanPhones,
          postcodes: cleanPostcodes,
          includeMerged: true,
        }),
      ]);
      for (const p of pHits) personMap.set(p.id, p);
      for (const o of oHits) orgMap.set(o.id, o);
    }

    // Expand merge chains for any Step 2 hits so merged hits resolve their survivors & prior siblings
    if (personMap.size > 0 || orgMap.size > 0) {
      const chainPersonIds = new Set(personMap.keys());
      const chainOrgIds = new Set(orgMap.keys());
      await expandMergeHistoryIds(chainPersonIds, chainOrgIds);
      const missingChainPersonIds = Array.from(chainPersonIds).filter(
        (id) => !personMap.has(id),
      );
      const missingChainOrgIds = Array.from(chainOrgIds).filter(
        (id) => !orgMap.has(id),
      );
      if (missingChainPersonIds.length > 0 || missingChainOrgIds.length > 0) {
        const [chainPeople, chainOrgs] = await Promise.all([
          this.listPeopleByIds<TPerson>(ctx, missingChainPersonIds),
          this.listOrganisationsByIds<TOrg>(ctx, missingChainOrgIds),
        ]);
        for (const p of chainPeople) personMap.set(p.id, p);
        for (const o of chainOrgs) orgMap.set(o.id, o);
      }
    }

    const directPersonIds = Array.from(personMap.keys());
    const directOrganisationIds = Array.from(orgMap.keys());

    // Step 3: Expand corporate groups (ancestors & descendants) and 2-hop person-organisation links
    if (orgMap.size > 0) {
      const groupOrgs = await this.expandCorporateGroupOrganisationIds<TOrg>(
        ctx,
        Array.from(orgMap.keys()),
      );
      for (const o of groupOrgs) orgMap.set(o.id, o);
    }

    const linksHop1 = await this.listLinksForEntities<TLink>(ctx, {
      personIds: Array.from(personMap.keys()),
      organisationIds: Array.from(orgMap.keys()),
    });

    const missingPersonIds = new Set<string>();
    const missingOrgIds = new Set<string>();
    for (const ln of linksHop1) {
      if (ln.personId && !personMap.has(ln.personId)) missingPersonIds.add(ln.personId);
      if (ln.organisationId && !orgMap.has(ln.organisationId)) {
        missingOrgIds.add(ln.organisationId);
      }
    }

    if (missingPersonIds.size > 0 || missingOrgIds.size > 0) {
      const [extraPeople, extraOrgs, groupOrgsHop2] = await Promise.all([
        this.listPeopleByIds<TPerson>(ctx, Array.from(missingPersonIds)),
        this.listOrganisationsByIds<TOrg>(ctx, Array.from(missingOrgIds)),
        missingOrgIds.size > 0
          ? this.expandCorporateGroupOrganisationIds<TOrg>(
              ctx,
              Array.from(missingOrgIds),
            )
          : Promise.resolve([]),
      ]);
      for (const p of extraPeople) personMap.set(p.id, p);
      for (const o of extraOrgs) orgMap.set(o.id, o);
      for (const o of groupOrgsHop2) orgMap.set(o.id, o);
    }

    // Fetch all links touching the expanded person/org closure so searchMatterConflicts link checks are complete
    const allLinks = await this.listLinksForEntities<TLink>(ctx, {
      personIds: Array.from(personMap.keys()),
      organisationIds: Array.from(orgMap.keys()),
    });

    return {
      people: Array.from(personMap.values()),
      organisations: Array.from(orgMap.values()),
      links: allLinks,
      directPersonIds,
      directOrganisationIds,
    };
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

  public async listPeopleOwnedByPerson<
    TPerson extends TenantPersonRecord = TenantPersonRecord,
  >(ctx: TenantContext, ownerPersonId: string): Promise<TPerson[]> {
    const cleanId = ownerPersonId?.trim();
    if (!cleanId) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbPersonRow>(
        `SELECT ${PEOPLE_JOINED_SELECT_COLUMNS}
         ${PEOPLE_LEFT_JOIN_HR}
         WHERE p.tenant_id = $1
           AND p.merged_into_id IS NULL
           AND (
             p.profile_json->>'recordOwnerId' = $2
             OR p.profile_json->>'relationshipOwnerId' = $2
             OR p.profile_json->>'verificationReviewerId' = $2
           )
         ORDER BY p.id ASC`,
        [ctx.tenantId, cleanId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Person');
        return mapPersonRow<TPerson>(row);
      });
    });
  }

  public async listOrganisationsOwnedByPerson<
    TOrg extends TenantOrganisationRecord = TenantOrganisationRecord,
  >(ctx: TenantContext, ownerPersonId: string): Promise<TOrg[]> {
    const cleanId = ownerPersonId?.trim();
    if (!cleanId) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbOrganisationRow>(
        `SELECT * FROM public.organisations
         WHERE tenant_id = $1
           AND merged_into_id IS NULL
           AND (
             relationship_partner_id = $2
             OR profile_json->>'recordOwnerId' = $2
             OR profile_json->>'reviewerId' = $2
           )
         ORDER BY id ASC`,
        [ctx.tenantId, cleanId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'Organisation');
        return mapOrganisationRow<TOrg>(row);
      });
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
      await tx.query(
        'DELETE FROM public.employee_sensitive_records WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.employee_employment_records WHERE tenant_id = $1',
        [ctx.tenantId],
      );
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
