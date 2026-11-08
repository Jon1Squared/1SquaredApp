/**
 * Core domain types for 1Squared.
 * Pure TypeScript – no framework or database imports.
 * Dates are ISO strings (date-only fields use YYYY-MM-DD).
 */

export type RecordType = 'person' | 'organisation';
/** All primary record types across pillars. */
export type AnyRecordType = RecordType | 'matter' | 'enquiry' | 'task';
/** Screens / record types that support per-client custom fields. */
export type CustomFieldRecordType =
  | RecordType
  | 'enquiry'
  | 'matter'
  | 'quote'
  | 'task';

export type ListGroup =
  | 'people'
  | 'organisations'
  | 'shared'
  | 'taxonomy'
  | 'matters'
  | 'documents'
  | 'enquiries'
  | 'tasks'
  | 'custom';

/**
 * @deprecated Replaced by granular permissions (`task:claim_any`, `task:reassign_any`, `enquiry:intake_view`, `admin:access`) in `PERMISSION_REGISTRY` (ADR-0016).
 */
export type AppRole = 'call_handler' | 'fee_earner' | 'team_lead' | 'admin';

export interface ChoiceList {
  key: string;
  label: string;
  group: ListGroup;
  appliesTo: CustomFieldRecordType[];
  allowMultiple: boolean;
  hierarchical: boolean;
  description?: string;
}

export interface ChoiceValue {
  id: string;
  listKey: string;
  label: string;
  description?: string;
  guidance?: string;
  parentId?: string | null;
  sortOrder: number;
  active: boolean;
  /** Stable key used by business rules; values with a systemKey can be renamed but not deactivated. */
  systemKey?: string;
  meta?: Record<string, string>;
}

export type CustomFieldType = 'text' | 'longText' | 'number' | 'date' | 'yesNo' | 'choice';
export type FormSection =
  | 'A'
  | 'C'
  | 'D'
  | 'additional'
  | 'enquiry_caller'
  | 'enquiry_contact'
  | 'enquiry_details'
  | 'matter_overview'
  | 'matter_parties'
  | 'matter_costs'
  | 'quote_client'
  | 'quote_scope'
  | 'quote_fees'
  | 'task_details';

export interface CustomFieldDefinition {
  id: string;
  recordType: CustomFieldRecordType;
  label: string;
  fieldType: CustomFieldType;
  /** For choice fields: the ChoiceList holding the options. */
  optionsListKey?: string;
  section: FormSection;
  required: boolean;
  sortOrder: number;
  active: boolean;
}

export interface RecordBase {
  id: string;
  recordType: RecordType | 'matter';
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
  /** Ids the user has confirmed are NOT duplicates of this record. */
  notDuplicateOf: string[];
  /** Ids of records this was flagged as possibly matching. */
  possibleMatchIds: string[];
  mergedIntoId: string | null;
  lastInteractionAt: string | null;
  customFields: Record<string, unknown>;
}

export interface Email {
  id: string;
  address: string;
  typeId: string | null;
  isPrimary: boolean;
  /** True when issued by the firm (matching branding.primaryDomain); marked inactive when the person leaves. */
  firmIssued?: boolean;
  /** Defaults to true; set to false when deactivated on leaving the firm. */
  active?: boolean;
}

export interface Phone {
  id: string;
  number: string;
  typeId: string | null;
  /** True when a firm-issued extension or direct dial; marked inactive when the person leaves. */
  firmIssued?: boolean;
  /** Defaults to true; set to false when deactivated on leaving the firm. */
  active?: boolean;
}

// ------------------------------------------------------------------ Organisation Structure Reference Tables
export interface OrgLegalEntity {
  id: string; // e.g. 'LE-PV-LLP'
  name: string; // e.g. 'Pembroke Vaughan LLP'
  code: string; // e.g. 'PVLLP'
  isDefault?: boolean;
  active: boolean;
}

export interface OrgDivision {
  id: string; // e.g. 'DIV-LEGAL', 'DIV-BS'
  name: string;
  code: string;
  parentLegalEntityId: string;
  active: boolean;
}

export interface OrgDepartment {
  id: string; // e.g. 'DEPT-RE'
  name: string; // e.g. 'Real Estate'
  code: string;
  parentDivisionId: string;
  defaultCostCentreId: string;
  defaultProfitCentreId: string;
  legacyChoiceValueId?: string | null;
  active: boolean;
}

export interface OrgTeamOrPracticeGroup {
  id: string; // e.g. 'TPG-RE-COMM'
  name: string;
  code: string;
  parentDepartmentId: string;
  active: boolean;
}

export interface OrgOffice {
  id: string; // e.g. 'OFF-CDF'
  name: string; // e.g. 'Cardiff'
  code: string;
  parentLegalEntityId: string;
  address: Address;
  active: boolean;
}

export interface OrgCostCentre {
  id: string; // e.g. 'CC-RE'
  code: string; // e.g. 'CC-101'
  name: string;
  parentDepartmentId: string | null;
  active: boolean;
}

export interface OrgProfitCentre {
  id: string; // e.g. 'PC-RE'
  code: string; // e.g. 'PC-101'
  name: string;
  parentDepartmentId: string | null;
  active: boolean;
}

export interface OrgStructureCatalogue {
  legalEntities: OrgLegalEntity[];
  divisions: OrgDivision[];
  departments: OrgDepartment[];
  teamsOrPracticeGroups: OrgTeamOrPracticeGroup[];
  offices: OrgOffice[];
  costCentres: OrgCostCentre[];
  profitCentres: OrgProfitCentre[];
  /** Whether payroll runs in an external system (if true, only externalPayrollReference is stored/shown). */
  externalPayrollOnly?: boolean;
  /** Default probation period in months used to calculate probationEndDate from startDate. */
  defaultProbationMonths?: number;
}

// ------------------------------------------------------------------ Employment & HR Types
export type EngagementType =
  | 'Employee'
  | 'LLP member'
  | 'Consultant'
  | 'Contractor'
  | 'Secondee';

export type EmploymentStatus =
  | 'Pre-start'
  | 'Active'
  | 'On leave'
  | 'Serving notice'
  | 'Leaver';

export type EmployeeRoleType =
  | 'Fee earner'
  | 'Business services'
  | 'Trainee'
  | 'Apprentice'
  | 'Partner/Member';

export type ContractType = 'Permanent' | 'Fixed term' | 'Temporary' | 'Zero hours';

export type WorkLocationArrangement = 'Office' | 'Hybrid' | 'Remote';

export type ProbationOutcome = 'Pending' | 'Passed' | 'Extended' | 'Failed';

export type RightToWorkMethod =
  | 'Manual document check'
  | 'Online Home Office share code'
  | 'IDSP';

export type EmployeePermission =
  | 'employee:view_core'
  | 'employee:edit_core'
  | 'employee:hr_restricted'
  | 'employee:payroll'
  | 'employee:sensitive';

export type DocumentPermission =
  | 'document_template:view'
  | 'document_template:build'
  | 'document_template:approve'
  | 'document_template:view_usage'
  | 'document_template:view_usage_by_user'
  | 'document_template:configure'
  | 'document:generate'
  | 'document:view'
  | 'document:download'
  | 'document:upload'
  | 'document:edit'
  | 'document:delete'
  | 'document:provision'
  | 'document_store:configure'
  | 'document_access:review'
  | 'finance:view';

export type KeyDatePermissionKey =
  | 'keydate:view'
  | 'keydate:view_any_team'
  | 'keydate:edit'
  | 'keydate:verify'
  | 'keydate:override_calculation'
  | 'keydate:resolve'
  | 'keydate:waive'
  | 'keydate:configure';

export type PermissionKey =
  | EmployeePermission
  | DocumentPermission
  | KeyDatePermissionKey
  | 'finance:view_matter'
  | 'finance:credit_control'
  | 'finance:manage_links'
  | 'risk:view'
  | 'matter:create'
  | 'matter:edit'
  | 'matter:costs:sign_off'
  | 'matter:reassign_ownership'
  | 'matter:restricted:access'
  | 'matter:restriction:lift'
  | 'task:claim_any'
  | 'task:reassign_any'
  | 'task:edit'
  | 'task:comment'
  | 'enquiry:intake_view'
  | 'enquiry:create'
  | 'enquiry:edit'
  | 'enquiry:assign'
  | 'enquiry:close'
  | 'enquiry:reopen'
  | 'enquiry:anonymise'
  | 'quote:view'
  | 'quote:edit'
  | 'signoff:approve'
  | 'contact:create'
  | 'contact:edit'
  | 'record:merge'
  | 'admin:access'
  | 'admin:data_reset'
  | 'rbac:manage_config'
  | 'rbac:manage_user_overrides';

export interface PersonPermissionOverrides {
  grant: PermissionKey[];
  revoke: PermissionKey[];
  reason?: string;
  updatedAt?: string;
  updatedByUserId?: string;
}

export interface EmploymentAssignmentHistoryEntry {
  id: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null when current
  jobTitle: string;
  gradeOrBand: string;
  roleType: EmployeeRoleType;
  divisionId: string | null;
  departmentId: string;
  teamOrPracticeGroupId: string | null;
  officeId: string | null;
  costCentreId: string | null;
  profitCentreId: string | null;
  lineManagerId: string | null;
  fte: number;
  changedById?: string;
  changedAt?: string;
  reason?: string;
}

export interface ChargeOutRateHistoryEntry {
  id: string;
  rateGbpPerHour: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null when current
  changedById?: string;
  changedAt?: string;
}

export interface EmploymentContractTerms {
  startDate: string; // YYYY-MM-DD (mandatory)
  continuousServiceDate: string; // YYYY-MM-DD (defaults to startDate)
  contractType: ContractType;
  fixedTermEndDate: string | null;
  fte: number; // e.g. 1.0
  workingPattern: string;
  workingPatternNotes: string;
  workLocationArrangement: WorkLocationArrangement;
  probationPeriodMonths: number;
  probationEndDate: string | null;
  probationEndDateOverridden?: boolean;
  probationOutcome: ProbationOutcome;
  noticePeriod: string;
  holidayEntitlementDays: number;
  leavingDate: string | null;
  leavingReasonId: string | null;
  eligibleForRehire: 'Yes' | 'No' | 'Conditional' | null;
  keepAsContactOnLeave?: boolean;
  hrRetentionUntil?: string | null;
}

export interface EmploymentFeeEarnerDetails {
  timekeeperCode: string; // unique
  chargeOutRateGbp: number | null;
  chargeOutRateEffectiveFrom: string | null;
  chargeOutRateHistory: ChargeOutRateHistoryEntry[];
  chargeableHoursTarget: number | null;
  billingApprovalLimitGbp: number | null;
  sraNumber: string;
  practisingCertificateStatus:
    | 'Current'
    | 'Pending renewal'
    | 'Conditions attached'
    | 'Suspended'
    | 'Not applicable'
    | '';
  practisingCertificateRenewalDate: string | null;
  admissionDate: string | null;
}

export interface EmploymentRightToWork {
  checkDate: string | null;
  method: RightToWorkMethod | '';
  documentType: string;
  expiryDate: string | null;
  followUpCheckDueDate: string | null;
  dbsCheckType: string;
  dbsCheckDate: string | null;
  dbsOutcome: string;
  dbsReference: string;
  referencesReceived: boolean | null;
  referencesReceivedDate: string | null;
}

export interface EmploymentPayrollDetails {
  externalPayrollReference: string;
  nationalInsuranceNumber: string;
  bankAccountName: string;
  bankSortCode: string;
  bankAccountNumber: string;
  buildingSocietyRollNumber?: string;
  starterDeclarationOrP45: string;
  studentLoanPlan: string;
  pensionAutoEnrolmentStatus: string;
  pensionOptOutDate: string | null;
}

export interface EmergencyContact {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  alternativePhone: string;
}

export interface EmploymentSystemsAccess {
  networkLogin: string;
  buildingPassNumber: string;
  extension: string;
  firmWorkEmail?: string;
  dataProtectionTrainingCompletedAt: string | null;
  amlTrainingCompletedAt: string | null;
  infoSecTrainingCompletedAt: string | null;
}

export interface EmploymentConflictOnHire {
  checkedAt: string;
  openMatterIds: string[];
  flaggedToRisk: boolean;
  informationBarrierConsidered: boolean;
  riskNotes: string;
}

export interface DiversityMonitoringAnswers {
  ageBand: string;
  genderIdentity: string;
  ethnicity: string;
  disability: string;
  sexualOrientation: string;
  religionOrBelief: string;
  socioEconomicBackground: string;
  caringResponsibilities: string;
}

export interface EmployeeSensitiveRecord {
  personId: string;
  reasonableAdjustmentsNeeded: string;
  diversity: DiversityMonitoringAnswers;
  updatedById: string;
  updatedAt: string;
}

export interface EmploymentRecord {
  id: string; // EMP-xxxxxx or EREC-xxxxxx
  personId: string;
  // Core employment
  engagementType: EngagementType;
  status: EmploymentStatus;
  employeeNumber: string; // unique
  employingEntityId: string; // defaults to 'LE-PV-LLP'
  jobTitle: string; // Firm job title (distinct from contact jobTitle)
  gradeOrBand: string;
  roleType: EmployeeRoleType;
  divisionId: string | null;
  departmentId: string; // OrgDepartment.id
  teamOrPracticeGroupId: string | null; // OrgTeamOrPracticeGroup.id
  officeId: string | null; // OrgOffice.id
  costCentreId: string | null; // OrgCostCentre.id
  profitCentreId: string | null; // OrgProfitCentre.id
  isTopOfHierarchy?: boolean;
  lineManagerId: string | null;
  supervisingPartnerId: string | null;
  timesheetApproverId: string | null;
  holidayApproverId: string | null;
  onboardingBuddyId: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null when active
  assignmentHistory: EmploymentAssignmentHistoryEntry[];
  // Optional/restricted sub-sections
  contract?: EmploymentContractTerms | null;
  feeEarner?: EmploymentFeeEarnerDetails | null;
  rightToWork?: EmploymentRightToWork | null;
  payroll?: EmploymentPayrollDetails | null;
  emergencyContacts?: EmergencyContact[];
  systems?: EmploymentSystemsAccess | null;
  conflictCheckOnHire?: EmploymentConflictOnHire | null;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

export interface UnmappedEmployeeMigrationItem {
  personId: string;
  personName: string;
  field: 'employeeRoleId' | 'departmentId';
  rawValue: string;
  reason: string;
}

export interface EmployeeMigrationReport {
  migratedAt: string;
  migratedCount: number;
  unmappedRecords: UnmappedEmployeeMigrationItem[];
}

export interface Address {
  id: string;
  typeId: string | null;
  line1: string;
  line2: string;
  town: string;
  county: string;
  postcode: string;
  countryId: string | null;
}

export interface OtherName {
  id: string;
  name: string;
  typeId: string | null;
}

export interface Person extends RecordBase {
  recordType: 'person';
  // A. Personal details
  titleId: string | null;
  firstName: string;
  middleNames: string;
  surname: string;
  preferredName: string;
  dateOfBirth?: string | null;
  otherNames: OtherName[];
  jobTitle: string;
  emails: Email[];
  phones: Phone[];
  preferredContactMethodId: string | null;
  preferredLanguageId: string | null;
  addresses: Address[];
  website: string;
  // C. Relationship management
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
  // D. Compliance and administration
  verificationStatusId: string | null;
  verifiedAt: string | null;
  verificationMethodId: string | null;
  verificationReviewerId: string | null;
  riskReferences: string;
  // Employee / Engagement at the firm
  isEmployee: boolean;
  employeeRoleId: string | null;
  departmentId: string | null;
  /** Related employment record attached to the person (never a separate duplicate person). */
  employment?: EmploymentRecord | null;
  /** Explicit employee data permissions for this user (overrides role defaults when present). */
  permissionOverrides?: PersonPermissionOverrides | null;
  /** Immutable Microsoft Entra ID Object GUID (`oid` claim) for federated OIDC identity matching. */
  entraObjectId?: string | null;
  employeePermissions?: EmployeePermission[];
  /** Explicit document generation permissions for this user (overrides role defaults when present). */
  documentPermissions?: DocumentPermission[];
  /** Explicit app permission role for Enquiries & Tasks (falls back to employeeRole + team lead status). */
  appRole?: AppRole | null;
  /** Role keys for Role-based Home pages (first role is the user's Home role). */
  roles?: string[];
  /** True for demo accounts (Felicity, Patrick, Simone, Ethel, Frank, Rita, Martha, Adam). */
  demo?: boolean;
  /** For demo accounts: the real employee whose work is displayed on personal panels. */
  showsWorkOfId?: string | null;
  /** For legal secretaries: the fee earners and partners they support. */
  supportsIds?: string[];
  /** If created while converting an enquiry, holds ENQ-xxxxxx */
  createdFromEnquiryId?: string | null;
}

export interface OrganisationConflictDecision {
  outcome: 'Cleared' | 'Potential conflict';
  decidedById: string;
  decidedByName: string;
  decidedAt: string;
  sourceRecordId: string;
  matchesCount: number;
  searchedSources: string[];
  summary: string;
}

export interface Organisation extends RecordBase {
  recordType: 'organisation';
  // A. Identity
  legalName: string;
  otherNames: OtherName[];
  organisationTypeId: string | null;
  companyNumber: string;
  vatNumber: string;
  countryOfRegistrationId: string | null;
  registeredAddress: Address | null;
  correspondenceAddress: Address | null;
  peopleWithSignificantControl?: string[];
  directors?: string[];
  website: string;
  mainPhone: string;
  generalEmail: string;
  parentOrganisationId: string | null;
  // C. Commercial relationship
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
  // D. Legal, financial and compliance
  clientReference: string;
  onboardingStatusId: string | null;
  conflictStatusId: string | null;
  conflictReference: string;
  conflictDecision?: OrganisationConflictDecision | null;
  riskRatingId: string | null;
  riskAssessmentStatusId: string | null;
  verificationStatusId: string | null;
  billingAddress: Address | null;
  invoicePreferenceId: string | null;
  paymentTermsId: string | null;
  creditControlNotes: string;
  engagementTermsRef: string;
  reviewDate: string | null;
  reviewerId: string | null;
}

export type AnyRecord = Person | Organisation;

export type MatterPartyRelationshipCode =
  | 'CL'
  | 'JC'
  | 'CC'
  | 'OP'
  | 'CP'
  | 'CO'
  | 'TP'
  | 'NO'
  | string;

export type WorkTypeProfileCode =
  | 'ALL'
  | 'LIT'
  | 'EMP'
  | 'PROP'
  | 'CORP'
  | 'PC'
  | 'FAM'
  | 'INS'
  | 'REG'
  | 'CRIM'
  | 'CON';

export type CapacityGroupName =
  | 'Ownership, control and authority'
  | 'Legal and professional advisers'
  | 'Disputes'
  | 'Transactional, corporate and property'
  | 'Employment'
  | 'Private client and family'
  | 'Neutral and official'
  | string;

export type MatterPartyAlignment = 'aligned' | 'adverse' | 'third_party' | 'neutral';

export interface MatterPartyRelationshipDef {
  code: string; // Immutable code e.g. CL, JC, CC, OP, CP, CO, TP, NO
  label: string;
  description: string;
  sortOrder: number;
  active: boolean;
}

export interface WorkTypeProfileDef {
  code: WorkTypeProfileCode;
  covers: string;
}

export interface MatterPartyCapacityDef {
  code: string; // Immutable code e.g. CAP_REPRESENTATIVE
  label: string;
  group: CapacityGroupName;
  description?: string;
  allowedRelationships: string[]; // Relationship codes e.g. ['CC', 'CO', 'TP']
  profiles: WorkTypeProfileCode[]; // Profile codes e.g. ['ALL'] or ['PROP', 'LIT']
  sortOrder: number;
  active: boolean;
}

export interface MatterPartyTaxonomy {
  relationships: MatterPartyRelationshipDef[];
  capacities: MatterPartyCapacityDef[];
  /** Keyed by workTypeSubcategoryId (e.g. 'work_type.real_estate_and_property_landlord_and_tenant') */
  workTypeProfiles: Record<string, WorkTypeProfileCode[]>;
}

export interface MatterPartyIdentifiers {
  companyNumber?: string;
  registeredTown?: string;
  dateOfBirth?: string;
  previousNames?: string;
  town?: string;
}

export interface MatterPartyMigrationMappingEntry {
  legacyRole: string;
  relationshipCode: string;
  capacityCode: string | null;
  capacityLabel: string;
  count: number;
}

export interface MatterPartyMigrationReport {
  migratedAt: string;
  deactivatedLegacyRolesCount: number;
  migratedMatterPartiesCount: number;
  migratedConflictPartiesCount: number;
  countsByMapping: Record<string, MatterPartyMigrationMappingEntry>;
}

export interface MatterParty {
  id: string;
  name: string;
  role: string;
  linkedRecordId: string | null; // P-xxxxxx or O-xxxxxx
  notes?: string;
  entityType?: ConflictPartyEntityType;
  relationshipCode?: MatterPartyRelationshipCode;
  capacityCodes?: string[];
  connectedToPartyId?: string | null;
  identifiers?: MatterPartyIdentifiers;
  needsCapacityPrompt?: boolean;
  alignment?: MatterPartyAlignment;
}

export type ConflictPartyEntityType = 'person' | 'organisation';

export type ConflictPartyRole =
  | 'Client'
  | 'Client contact'
  | 'Opponent'
  | 'Opposing solicitor'
  | 'Other party'
  | 'Related party'
  | string;

export type ConflictMatchStrength = 'Exact' | 'Close' | 'Possible';

export type ConflictMatchDisposition =
  | 'not_the_same'
  | 'same_no_conflict'
  | 'potential_conflict';

export type ConflictReviewerDecisionType =
  | 'approve'
  | 'approve_with_conditions'
  | 'decline';

export type ConflictConditionType = 'consent_obtained' | 'information_barrier';

export type ConflictCheckStatusPill =
  | 'Not started'
  | 'In progress'
  | 'Cleared'
  | 'Referred'
  | 'Approved'
  | 'Declined';

export interface ConflictCheckParty {
  id: string;
  name: string;
  entityType: ConflictPartyEntityType;
  role: ConflictPartyRole;
  linkedRecordId: string | null;
  subtitle?: string;
  isClientFixed?: boolean;
  relatedEntitiesIncluded?: boolean;
  parentPartyId?: string | null;
  relationshipCode?: MatterPartyRelationshipCode;
  capacityCodes?: string[];
  connectedToPartyId?: string | null;
  identifiers?: MatterPartyIdentifiers;
  needsCapacityPrompt?: boolean;
  alignment?: MatterPartyAlignment;
}

export interface ConflictCheckMatch {
  id: string;
  partyId: string;
  partyName: string;
  matchedRecordId: string;
  matchedRecordName: string;
  matchedRecordType: 'person' | 'organisation' | 'matter';
  strength: ConflictMatchStrength;
  whereFound: string;
  matterId?: string | null;
  matterNumber?: string | null;
  responsiblePartnerId: string | null;
  responsiblePartnerName: string;
  dateLabel: string;
  matchedOn?: string;
  restricted?: boolean;
  disposition: ConflictMatchDisposition | null;
  note: string;
  reviewerDecision?: ConflictReviewerDecisionType | null;
  reviewerConditionType?: ConflictConditionType | null;
  reviewerNote?: string;
  reviewedById?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
}

export interface ConflictCheckRunAudit {
  id: string;
  runAtDisplay: string;
  runById: string;
  runByName: string;
  searchTerms: string[];
  partiesCount: number;
  matchesCount: number;
  potentialConflictsCount: number;
  searchedSources?: string[];
}

export interface ConflictReviewerComment {
  id: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  atDisplay: string;
  text: string;
}

export interface ConflictCheckRecord {
  status: ConflictCheckStatusPill;
  outcomeLabel:
    | 'Cleared by fee earner'
    | 'Referred to risk for review'
    | 'Approved by Risk & Compliance'
    | 'Approved with conditions'
    | 'Declined by Risk & Compliance'
    | 'Pending';
  declarationConfirmed: boolean;
  reviewerMessage: string;
  lastRunAtDisplay: string | null;
  lastRunById: string | null;
  lastRunByName: string | null;
  savedDraftAtDisplay?: string | null;
  submittedAtDisplay?: string | null;
  submittedById?: string | null;
  submittedByName?: string | null;
  approvedAtDisplay?: string | null;
  approvedById?: string | null;
  approvedByName?: string | null;
  /** Server-owned list of restricted match IDs present when Risk & Compliance approved this record. */
  approvedRestrictedMatchIds?: string[];
  parties: ConflictCheckParty[];
  matches: ConflictCheckMatch[];
  runs: ConflictCheckRunAudit[];
  comments: ConflictReviewerComment[];
}

export type ConflictCheckRecordInput = Omit<
  ConflictCheckRecord,
  | 'approvedById'
  | 'approvedByName'
  | 'approvedAtDisplay'
  | 'submittedById'
  | 'approvedRestrictedMatchIds'
>;

export interface Matter extends RecordBase {
  recordType: 'matter';
  // CORE-001..008 Identification
  matterNumber: string; // e.g. PEN001-0004
  title: string; // CORE-002
  shortDescription: string; // CORE-003
  clientId: string; // CORE-004 (P-xxxxxx or O-xxxxxx)
  additionalClientIds: string[]; // CORE-005
  parentMatterId: string | null; // CORE-006
  relatedMatterIds: string[]; // CORE-007
  matterStatusId: string; // CORE-008
  /** If created by converting an enquiry, holds ENQ-xxxxxx */
  sourceEnquiryId?: string | null;
  /** If created by converting a quote, holds QTE-YYYY-NNNN */
  sourceQuoteId?: string | null;
  // CORE-009..021 Classification
  practiceAreaId: string; // CORE-009 (work_type parent id)
  workTypeSubcategoryId: string; // CORE-010 (work_type child id)
  typeBadge: string; // CORE-011 Derived from subcategory
  matterTypeId: string; // CORE-012
  clientTierId: string | null; // CORE-013
  clientSectorId: string | null; // CORE-014
  billingBasisId: string; // CORE-015
  riskRatingId: string; // CORE-016
  matterSizeId: string | null; // CORE-017
  jurisdictionGroupId: string; // CORE-018
  jurisdictionIds: string[]; // CORE-019
  governingLawId: string | null; // CORE-020
  forumCourt: string; // CORE-021
  // CORE-022..030 People
  responsiblePartnerId: string | null; // CORE-022
  supervisingPartnerId: string | null; // CORE-023
  leadFeeEarnerId: string | null; // CORE-024
  teamMemberIds: string[]; // CORE-025
  relationshipPartnerId: string | null; // CORE-026
  instructingContactId: string | null; // CORE-027
  billingContactId: string | null; // CORE-028
  referrerTypeId: string | null; // CORE-029
  referrerContactId: string | null; // CORE-030
  // CORE-031..036 Parties & Conflicts
  parties: MatterParty[]; // CORE-031 / CORE-032
  conflictCheckStatus: string; // CORE-033
  conflictCheckDate: string | null; // CORE-034
  conflictClearedById: string | null; // CORE-035
  conflictNotes: string; // CORE-036
  // CORE-037..044 Compliance & Onboarding
  amlStatus: string; // CORE-037
  amlCompletedAt: string | null; // CORE-038
  sourceOfFundsVerified: string; // CORE-039
  sourceOfWealthVerified: string; // CORE-040
  engagementLetterStatus: string; // CORE-041
  engagementLetterSentAt: string | null; // CORE-042
  engagementLetterSignedAt: string | null; // CORE-043
  // CORE-045..054 Financial
  feeEstimateGbp: number | null; // CORE-045
  agreedFeeCapGbp: number | null; // CORE-046
  retainerMoniesOnAccountGbp: number | null; // CORE-047
  // CORE-055..067 Lifecycle
  stageId: string; // CORE-055
  milestoneId: string | null; // CORE-056
  enquiryReceivedAt: string | null; // CORE-057
  openedAt: string | null; // CORE-058
  targetCompletionAt: string | null; // CORE-059
  completedAt: string | null; // CORE-060
  closedAt: string | null; // CORE-061
  retentionPeriod: string; // CORE-062
  destructionDueAt: string | null; // CORE-063
  // All Core (CORE-001..075), Field Group (FG01..FG09) and Subcategory-specific fields stored keyed by Field ID
  fieldValues: Record<string, unknown>;
  /** Full built-in conflict check snapshot & audit record */
  conflictCheckRecord?: ConflictCheckRecord;
  /** True when the client is a current employee of the firm; restricts browsing to authorized staff. */
  isStaffMatter?: boolean;
  /** True when an ethical wall / information barrier applies to this matter. */
  hasEthicalWall?: boolean;
  /** User IDs permitted to view/access this matter when isStaffMatter or hasEthicalWall is true. */
  restrictedAccessUserIds?: string[];
  /** Recorded restriction lifts so ordinary saves do not reinstate lifted restrictions unless a new trigger occurs. */
  restrictionLift?: {
    ethicalWall?: {
      liftedAt: string;
      byId: string;
      liftedBarrierMatchIds: string[];
    };
    staffMatter?: {
      liftedAt: string;
      byId: string;
      liftedParticipantIds: string[];
    };
  };
  /** Optional explicit owning OrgDepartment ID (e.g. 'DEPT-RE') for document routing & security. */
  owningDepartmentId?: string | null;
  /** Optional explicit owning OrgTeamOrPracticeGroup ID (e.g. 'TPG-RE-RES') for document routing & security. */
  owningTeamId?: string | null;
}

// ------------------------------------------------------------------ Teams
export interface Team {
  id: string; // TM-000001
  name: string;
  description: string;
  memberIds: string[]; // Employee P-xxxxxx ids
  leadIds: string[]; // Must be subset of memberIds
  practiceAreaIds: string[]; // work_type top-level ChoiceValue ids
  active: boolean;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ Tasks
export type TaskStatus = 'To do' | 'In progress' | 'Waiting' | 'Done' | 'Cancelled';

export type TaskLinkedRecordType = 'enquiry' | 'quote' | 'matter' | 'person' | 'organisation';

export interface TaskLinkedRecord {
  recordType: TaskLinkedRecordType;
  recordId: string;
}

export interface TaskComment {
  id: string;
  authorId: string;
  at: string;
  text: string;
}

export type AutoTaskTrigger = 'enquiry_contact' | 'non_engagement_letter' | 'complete_matter_opening';

export interface Task {
  id: string; // TSK-000001
  reference: string; // TSK-000001
  title: string;
  description: string;
  taskTypeId: string; // task_type picklist id
  priorityId: string; // task_priority picklist id
  dueAt: string; // YYYY-MM-DD or full ISO datetime
  assignedTeamId: string | null;
  assignedPersonId: string | null;
  assignedPersonIds?: string[];
  multiAssigneeMode?: 'shared' | 'separate';
  status: TaskStatus;
  linkedRecords: TaskLinkedRecord[];
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
  completedById: string | null;
  completedAt: string | null;
  comments: TaskComment[];
  autoTrigger?: AutoTaskTrigger | null;
  linkedKeyDateId?: string | null;
  idempotencyKey?: string | null;
}

// ------------------------------------------------------------------ Enquiries
export type EnquiryStatus =
  | 'Draft'
  | 'New'
  | 'Assigned'
  | 'In contact'
  | 'Converted'
  | 'Declined'
  | 'Referred out'
  | 'No response';

export type EnquiryConflictStatus = 'Not checked' | 'Clear' | 'Check' | 'Possible conflict';

export interface EnquiryConflictSnapshotHit {
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

export interface EnquiryConflictSnapshot {
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
  conflictStatus: EnquiryConflictStatus;
  conflicts: EnquiryConflictSnapshotHit[];
  knownPeople: { id: string; formattedReasons: string }[];
  knownOrganisations: { id: string; formattedReasons: string }[];
}

export type ContactLogMethod =
  | 'Phone'
  | 'In person'
  | 'Video call'
  | 'Call'
  | 'Email'
  | 'Voicemail'
  | 'Meeting'
  | 'Video';
export type ContactLogOutcome =
  | 'Spoke'
  | 'Left Message'
  | 'Left Voicemail'
  | 'No answer'
  | 'Left message'
  | 'Voicemail left'
  | 'Email sent'
  | 'Sent email'
  | 'Meeting';

export interface EnquirySentEmailSnapshot {
  kind: 'sent_email';
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sentAt: string;
  sentById: string;
}

export interface ContactLogEntry {
  id: string;
  at: string; // ISO datetime
  method: ContactLogMethod;
  outcome: ContactLogOutcome;
  note: string;
  byId: string;
}

export interface Enquiry {
  id: string; // ENQ-000001
  reference: string; // ENQ-000001
  receivedAt: string; // ISO datetime
  takenById: string; // Employee id
  channelId: string; // enquiry_channel picklist id
  firstName: string;
  lastName: string;
  callingOnBehalfOf: string; // Text if business name not yet an Organisation
  linkedOrganisationId: string | null; // O-xxxxxx
  email: string;
  phone: string;
  preferredContactMethodId: string | null; // contact_method picklist id
  bestTimeToCall: string;
  address: Address | null;
  practiceAreaId: string; // work_type top-level id
  workTypeSubcategoryId: string | null; // work_type child id
  summary: string; // Max 120 chars
  notes: string; // High-level facts only
  otherPartiesNamed: string;
  urgencyId: string; // enquiry_urgency picklist id
  keyDate: string | null; // YYYY-MM-DD
  keyDateLabel: string; // e.g. Dismissal date
  sourceId: string | null; // origin picklist id (taxonomy Axis 7)
  referrerPersonId: string | null; // P-xxxxxx when referral
  privacyNoticeGiven: boolean;
  linkedPersonId: string | null; // P-xxxxxx
  assignedTeamId: string | null; // TM-xxxxxx
  routedToIntakeFallback?: boolean; // True when practice area had no active team
  assignedToId: string | null; // Employee P-xxxxxx
  status: EnquiryStatus;
  firstContactDueAt: string | null; // ISO datetime from urgency SLA
  nextActionDate: string | null; // YYYY-MM-DD
  conflictStatus?: EnquiryConflictStatus;
  conflictSnapshot?: EnquiryConflictSnapshot | null;
  closeReasonId: string | null; // enquiry_close_reason picklist id
  closeNotes?: string;
  referredToOrganisationId: string | null; // O-xxxxxx
  referredToName?: string;
  convertedMatterId: string | null; // M-xxxxxx
  contactLog: ContactLogEntry[];
  customFields?: Record<string, unknown>;
  anonymisedAt?: string | null;
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ Quotes
export type QuoteStatus =
  | 'Draft'
  | 'Sent'
  | 'Follow-up due'
  | 'Accepted'
  | 'Declined'
  | 'Expired'
  | 'Superseded';

export type QuoteFeeBasis =
  | 'Fixed fee'
  | 'Estimate'
  | 'Capped fee'
  | 'Hourly rate with estimate';

export type QuoteDeclineReason =
  | 'Price'
  | 'Timing'
  | 'Instructed another firm'
  | 'No longer needed'
  | 'Other';

export interface QuoteDisbursement {
  id: string;
  description: string;
  amountExVat: number;
  vatApplicable: boolean;
}

export interface QuoteFollowUpEntry {
  id: string;
  at: string; // ISO datetime
  method: ContactLogMethod;
  note: string;
  nextFollowUpDate: string | null; // YYYY-MM-DD
  byId: string;
}

export interface QuoteVersionSnapshot {
  version: number;
  status: 'Superseded';
  feeBasis: QuoteFeeBasis;
  feeAmountExVat: number;
  hourlyRateGbp: number | null;
  vatAmount: number;
  disbursements: QuoteDisbursement[];
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

export interface QuoteTimelineEvent {
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

export interface Quote {
  id: string; // QTE-2026-0001
  reference: string; // QTE-YYYY-NNNN
  version: number; // 1, 2, 3...
  status: QuoteStatus;
  clientType: 'existing' | 'prospect';
  linkedOrganisationId: string | null;
  linkedPersonId: string | null;
  prospectName: string;
  prospectOrganisationName: string;
  prospectEmail: string;
  prospectPhone: string;
  linkedEnquiryId: string | null; // ENQ-xxxxxx
  convertedMatterId: string | null; // M-xxxxxx
  practiceAreaId: string; // work_type parent id
  workTypeSubcategoryId: string | null; // work_type child id
  scope: string;
  assumptions: string;
  feeBasis: QuoteFeeBasis;
  feeAmountExVat: number;
  hourlyRateGbp: number | null;
  vatAmount: number;
  vatOverridden?: boolean;
  disbursements: QuoteDisbursement[];
  totalIncVat: number;
  feeEarnerId: string; // P-xxxxxx
  assignedTeamId: string | null; // TM-xxxxxx
  validUntil: string; // YYYY-MM-DD
  followUpAfterDays: number; // default 7
  sentAt: string | null; // ISO datetime
  nextFollowUpDate: string | null; // YYYY-MM-DD
  outcomeAt: string | null;
  outcomeNote?: string;
  declineReason: QuoteDeclineReason | null;
  declineNote?: string;
  followUps: QuoteFollowUpEntry[];
  versionHistory: QuoteVersionSnapshot[];
  timeline: QuoteTimelineEvent[];
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ Admin Settings & Notifications
export interface EnquirySettings {
  emergencyHours: number; // default 2 working hours
  urgentSameDayEnd: boolean; // default true (end of same working day)
  standardNextDayEnd: boolean; // default true (end of next working day)
  workDayStart: string; // default "09:00"
  workDayEnd: string; // default "17:30"
  workingDays: number[]; // default [1, 2, 3, 4, 5] (Mon-Fri)
  failedAttemptsBeforeSuggestNoResponse: number; // default 3
  retentionMonths: number; // default 12
}

export interface AutoTaskTemplateSetting {
  trigger: AutoTaskTrigger;
  label: string;
  titleTemplate: string;
  taskTypeId: string;
  priorityId: string;
  dueWorkingDaysOffset: number; // Used for non_engagement_letter (2) and complete_matter_opening (5)
}

export interface TaskSettings {
  templates: AutoTaskTemplateSetting[];
}

export type NotificationKind =
  | 'task_assigned'
  | 'team_task_arrived'
  | 'task_comment'
  | 'enquiry_assigned'
  | 'task_overdue';

export interface NotificationItem {
  id: string; // NTF-000001
  recipientId: string; // Employee P-xxxxxx
  kind: NotificationKind;
  title: string;
  detail: string;
  href: string;
  recordId: string;
  createdAt: string;
  read: boolean;
  byId: string;
}

export interface PersonOrganisationLink {
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

export interface Note {
  id: string;
  recordType: RecordType | 'matter' | 'enquiry';
  recordId: string;
  authorId: string;
  at: string;
  text: string;
  mergedFromId?: string | null;
}

export type AuditAction =
  | 'create'
  | 'update'
  | 'link'
  | 'unlink'
  | 'link-update'
  | 'merge'
  | 'merged-into'
  | 'note'
  | 'duplicate'
  | 'list-change'
  | 'custom-field-change'
  | 'status-change'
  | 'assign'
  | 'contact-log'
  | 'email-sent'
  | 'convert'
  | 'comment'
  | 'view-payroll'
  | 'view-sensitive'
  | 'update-payroll'
  | 'update-sensitive'
  | 'keydate-create'
  | 'keydate-update'
  | 'keydate-propose'
  | 'keydate-verify'
  | 'keydate-reject'
  | 'keydate-override-calculation'
  | 'keydate-supersede'
  | 'keydate-resolve'
  | 'keydate-waive'
  | 'keydate-reassign-team'
  | 'keydate-not-applicable'
  | 'keydate-reminder-acknowledge'
  | 'keydate-reminder-escalate'
  | 'keydate-config-change'
  | 'keydate-export'
  | 'matter-restriction-lift'
  | 'matter-imported-open'
  | 'data-reset'
  | 'data-cleared'
  | 'conflict-decision';

export interface AuditEntry {
  id: string;
  recordType:
    | RecordType
    | 'matter'
    | 'enquiry'
    | 'quote'
    | 'task'
    | 'team'
    | 'list'
    | 'customField'
    | 'system'
    | 'employee_payroll'
    | 'employee_sensitive'
    | 'key_date';
  recordId: string;
  action: AuditAction;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  byId: string;
  at: string;
  reason?: string | null;
  snapshot?: unknown;
}

export interface MergeHistory {
  id: string;
  recordType: RecordType;
  survivorId: string;
  mergedId: string;
  mergedLabel: string;
  byId: string;
  at: string;
  fieldsTaken: string[];
}

/** Everything needed to resolve list values and custom fields. */
export interface ListCatalogue {
  lists: ChoiceList[];
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
}

// ------------------------------------------------------------------ PMS Links
export type PmsEntityType = 'organisation' | 'person' | 'employee' | 'matter';

export type PmsMatchedBy = 'auto_company_number' | 'auto_email' | 'seed' | 'manual';

export interface PmsLink {
  id: string; // PMSL-000001
  entityType: PmsEntityType;
  onesquaredId: string;
  pmsCode: string;
  matchedBy: PmsMatchedBy;
  matchedAt: string;
  matchedByUserId?: string | null;
  syncDirection?: 'inbound' | 'outbound' | 'bidirectional';
  syncStatus?: 'Synced' | 'Pending' | 'Failed';
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}

// ------------------------------------------------------------------ Role-based Home Pages
export type BuiltInHomeRoleKey =
  | 'fee_earner'
  | 'supervisor'
  | 'intake'
  | 'partner'
  | 'legal_secretary'
  | 'enquiries_coordinator'
  | 'finance'
  | 'risk_compliance'
  | 'managing_partner'
  | 'admin';

export type HomeRoleKey = BuiltInHomeRoleKey | string;

export type PanelId =
  | 'to_do'
  | 'my_tasks_today'
  | 'my_enquiries_awaiting_contact'
  | 'my_active_matters'
  | 'my_time_and_wip'
  | 'key_dates_and_deadlines'
  | 'waiting_on_client'
  | 'team_enquiries_and_unassigned_tasks'
  | 'team_tasks_for_supported_fee_earners'
  | 'documents_and_correspondence_queue'
  | 'matter_openings_in_progress'
  | 'upcoming_completions_and_filings'
  | 'disbursements_and_invoices_to_log'
  | 'quick_enquiry_capture'
  | 'callback_sla_queue'
  | 'unassigned_enquiries'
  | 'awaiting_fee_earner_response'
  | 'todays_outcomes_and_conversion'
  | 'referral_sources_this_month'
  | 'matters_needing_partner_attention'
  | 'sign_offs_and_approvals'
  | 'team_workload_and_utilisation'
  | 'wip_ready_to_bill_and_aged_debt'
  | 'enquiries_and_conversion_by_practice_area'
  | 'key_client_and_referrer_touchpoints'
  | 'aged_debt_by_age_band'
  | 'overdue_invoices_worklist'
  | 'wip_ready_to_bill'
  | 'client_account_reconciliation_and_exceptions'
  | 'disbursements_awaiting_billing'
  | 'cash_collection_vs_target'
  | 'aml_and_cdd_queue'
  | 'conflict_checks_awaiting_decision'
  | 'high_risk_matters_and_pep_register'
  | 'undertakings_and_file_reviews'
  | 'complaints_incidents_and_breaches'
  | 'overdue_compliance_tasks_by_team'
  | 'firm_financial_pulse'
  | 'performance_by_department'
  | 'utilisation_and_realisation_by_grade'
  | 'enquiries_conversion_and_pipeline'
  | 'top_clients_and_concentration'
  | 'firm_risk_and_exceptions_register';

export type PanelPlacement = 'primary' | 'summary' | 'off';

export type PanelCategory =
  | 'Tasks, enquiries & daily work'
  | 'Intake & conversion'
  | 'Secretarial & matter support'
  | 'Partner oversight'
  | 'Finance & credit control'
  | 'Risk & compliance'
  | 'Firm-wide executive';

export interface RoleHomeConfig {
  /** Linked ChoiceValue ID from `employee_role` in the People taxonomy (`employee_role.<slug>`). */
  employeeRoleId?: string;
  key: HomeRoleKey;
  label: string;
  shortLabel: string;
  purpose: string;
  designNumber?: string; // e.g. '01'..'07'
  demoUserEmail?: string;
  /** Up to 5 headline figure card IDs shown at the top of the page. */
  headlineCardIds: string[];
  /** Ordered list of panel IDs placed in the primary (left/main) column. */
  primaryPanels: PanelId[];
  /** Ordered list of panel IDs placed in the summary (right/side) column. */
  summaryPanels: PanelId[];
  isBuiltIn?: boolean;
}

export interface HomeFirmSettings {
  /** Whether demo mode is active (shows demo user switcher & demo banners). Default false. */
  demoMode: boolean;
  /** Default daily chargeable pace override in hours (null means calculate from PMS annual_target_hours / 230). */
  workingDayPaceHours: number | null;
  /** Unbilled WIP age threshold in days (default 60). */
  wipAgeThresholdDays: number;
  /** Overdue debt threshold in days (default 30). */
  debtOverdueThresholdDays: number;
  /** Callback SLA overdue threshold in minutes (default 0 = immediate). */
  callbackSlaOverdueMinutes: number;
}

export interface HomePagesConfig {
  roles: RoleHomeConfig[];
  firmSettings: HomeFirmSettings;
  /** Per-user remembered "Viewing as" role key. */
  lastViewingRoleByUserId: Record<string, string>;
  updatedAt: string;
  updatedById: string;
}

export type SignOffKind = 'write_off' | 'matter_opening' | 'undertaking';

export interface SignOffItem {
  id: string; // SO-000001
  kind: SignOffKind;
  title: string;
  matterNumber: string;
  matterId: string | null;
  subtitle: string;
  requestedById: string;
  requestedAt: string;
  assignedPartnerId: string | null;
  status: 'Pending' | 'Approved' | 'Discussing';
  approvedById?: string | null;
  approvedAt?: string | null;
  discussionNote?: string;
}

// ------------------------------------------------------------------ Matter Costs & Multi-Client Customisable Rates Table
export type MatterCostWorkBasis = 'fixed_fee' | 'hourly_rates' | 'capped';

export type RateTableSourceMode = 'app_table' | 'pms_when_linked' | 'pms_only';

export interface CustomGradeRateRow {
  id: string;
  label: string;
  hourlyRateGbp: number;
  pmsGradeMatch?: string;
  pmsRateGbp?: number | null;
}

export interface RateCardEntry {
  id: string; // e.g. 'RC-DEFAULT', 'RC-EMP'
  name: string; // e.g. 'Firm Standard Rate Card', 'Employment & HR Rate Card'
  practiceAreaId: string | null; // null = firm-wide default; or work_type parent id
  pmsDepartmentCode?: string | null; // Optional department name/code in PMS
  partnerRateGbp: number;
  associateRateGbp: number;
  traineeRateGbp: number;
  /** Optional PMS-synced rates (populated when PMS link is active / synced) */
  pmsPartnerRateGbp?: number | null;
  pmsAssociateRateGbp?: number | null;
  pmsTraineeRateGbp?: number | null;
  pmsLastSyncedAt?: string | null;
  /** Client-specific custom fee-earner grades beyond Partner / Associate / Trainee */
  customGrades?: CustomGradeRateRow[];
  active: boolean;
}

export interface DisbursementPresetItem {
  id: string;
  description: string;
  defaultAmountGbp: number;
  vatApplicable?: boolean;
  practiceAreaId?: string | null;
}

export interface MatterDisbursementEntry {
  id: string;
  description: string;
  amountGbp: number;
  vatApplicable?: boolean;
}

export interface MatterCostsSnapshot {
  workBasis: MatterCostWorkBasis;
  rateSource: 'app_table' | 'pms' | 'custom_override';
  rateCardId: string;
  rateCardName: string;
  partnerRateGbp: number | null;
  associateRateGbp: number | null;
  traineeRateGbp: number | null;
  customGrades?: CustomGradeRateRow[];
  totalEstimateGbp: number | null;
  agreedCapGbp?: number | null;
  disbursements: MatterDisbursementEntry[];
  disbursementsTotalGbp: number;
  paymentOnAccountRequired: 'Yes' | 'No' | '';
  paymentOnAccountAmountGbp: number | null;
  notes?: string;
  updatedAt?: string;
}

/**
 * Multi-client tenant customisation configuration for Matter Costs and Hourly Rate Tables.
 * Keeps the base platform identical across all clients while allowing each client firm
 * to configure their own rate tables, PMS sync mode, custom grades, and disbursement presets.
 */
export interface MatterCostsConfig {
  clientProfileCode: string; // e.g. 'BASE-STANDARD'
  clientProfileName: string; // e.g. 'Pembroke Vaughan LLP'
  sectionTitle: string; // default 'Matter Costs'
  rateSourceMode: RateTableSourceMode; // 'app_table' | 'pms_when_linked' | 'pms_only'
  pmsLinkActive: boolean; // Whether a live/imported PMS rate link is enabled
  pmsLastSyncedAt?: string | null;
  allowMatterRateOverrides: boolean; // Whether fee earners can override looked-up rates on a matter
  defaultPaymentOnAccount: 'Yes' | 'No' | '';
  defaultPaymentOnAccountAmountGbp?: number;
  rateCards: RateCardEntry[];
  disbursementPresets: DisbursementPresetItem[];
  updatedAt: string;
  updatedById: string;
}



