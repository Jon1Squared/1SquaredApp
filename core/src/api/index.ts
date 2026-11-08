/**
 * @platform/core-api
 * Public API and extension contract for the Platform.
 * Extensions may ONLY import from this package, never from core internals.
 */

export const CORE_VERSION = '1.1.0';
export const CORE_API_VERSION = '1.1.0';

export type HostingMode = 'single_tenant' | 'multi_tenant';
export type PlatformEnvironment = 'dev' | 'test' | 'training' | 'live';

export type HomeRoleKey =
  | 'fee_earner'
  | 'supervisor'
  | 'partner'
  | 'legal_secretary'
  | 'intake'
  | 'enquiries_coordinator'
  | 'finance'
  | 'risk_compliance'
  | 'managing_partner'
  | 'admin';

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

import type {
  KeyDateExtensionPermission,
  KeyDateExtensionPoint,
  KeyDatePermission,
} from './keyDates.types';
export * from './keyDates.types';

export type PermissionKey =
  | EmployeePermission
  | DocumentPermission
  | KeyDatePermission
  | 'finance:view_matter'
  | 'finance:credit_control'
  | 'finance:manage_links'
  | 'risk:view'
  | 'matter:create'
  | 'matter:edit'
  | 'matter:reassign_ownership'
  | 'matter:restricted:access'
  | 'matter:restriction:lift'
  | 'matter:costs:sign_off'
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

export type PermissionDomain =
  | 'employee'
  | 'document_template'
  | 'document'
  | 'keydate'
  | 'finance'
  | 'risk'
  | 'matter'
  | 'task'
  | 'enquiry'
  | 'quote'
  | 'signoff'
  | 'contact'
  | 'admin'
  | 'rbac';

export type PermissionSensitivity =
  | 'standard'
  | 'restricted'
  | 'confidential'
  | 'critical';

export interface PermissionRegistryEntry {
  readonly key: PermissionKey;
  readonly domain: PermissionDomain;
  readonly description: string;
  readonly sensitivity: PermissionSensitivity;
  readonly requiresMfa: boolean;
  readonly sinceVersion: string;
  readonly deprecated?: {
    readonly sinceVersion: string;
    readonly replacementKey?: PermissionKey;
    readonly reason: string;
  };
}

export interface PersonPermissionOverrides {
  /** Explicit permissions granted to this person on top of role/department/relationship defaults. */
  grant: PermissionKey[];
  /** Explicit permissions revoked from this person (revoke always wins over grants and defaults). */
  revoke: PermissionKey[];
  reason?: string;
  updatedAt?: string;
  updatedByUserId?: string;
}

export type RelationshipRuleKey =
  | 'is_team_lead_of_any_team'
  | 'is_team_lead_of_target_team'
  | 'is_line_manager_of_target'
  | 'is_supporting_target_fee_earner';

export interface RbacRoleDefinition {
  key: string;
  label: string;
  shortLabel?: string;
  description?: string;
  isBuiltIn?: boolean;
  permissions: PermissionKey[];
}

export interface RbacRelationshipGrantRule {
  relationship: RelationshipRuleKey;
  permissions: PermissionKey[];
  description?: string;
}

export interface RbacIdentityMappingConfig {
  authorityMode: 'token_only' | 'hybrid' | 'store_only';
  entraGroupToRoleKey: Record<string, string[]>;
  entraAppRoleToRoleKey: Record<string, string[]>;
  requireMfaForAdminPermissions: boolean;
  defaultRoleKeys?: string[];
  allowAcrsC1AsMfa?: boolean;
}

export interface RbacConfiguration {
  roles: Record<string, RbacRoleDefinition>;
  departmentGrants: Record<string, PermissionKey[]>;
  relationshipGrants: RbacRelationshipGrantRule[];
  identityMapping: RbacIdentityMappingConfig;
}

export type ExtensionPermission =
  | 'matter:read'
  | 'client:read'
  | 'person:read'
  | 'finance:view'
  | 'document:fields:provide'
  | 'document:read'
  | 'document:write'
  | 'matter:costs:validate'
  | 'matter:open:gate'
  | 'config:read'
  | 'audit:write'
  | 'pms:sync'
  | KeyDateExtensionPermission;

export type ExtensionHookName =
  | 'beforeMatterCostsCalculate'
  | 'afterMatterCostsCalculate'
  | 'beforeMatterOpen'
  | 'afterMatterOpen'
  | 'onPmsOutboundCommand'
  | 'provideDocumentFields'
  | 'afterMatterDocumentsProvisioned'
  | 'beforeMatterDocumentsClose'
  | KeyDateExtensionPoint;

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  supportedCoreApiRange: string;
  permissions: readonly ExtensionPermission[];
  hooks: readonly ExtensionHookName[];
  uiSlots?: readonly string[];
  hookTimeoutMs?: number;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorEmail: string;
  readonly actorUpn?: string;
  readonly actorRoles: readonly string[];
  readonly actorGroups?: readonly string[];
  readonly entraObjectId?: string;
  readonly entraTenantId?: string;
  readonly mfaVerified: boolean;
  readonly hostingMode: HostingMode;
  readonly environment: PlatformEnvironment;
  readonly correlationId: string;
  readonly postgresDatabaseName: string;
  readonly blobContainerName: string;
  readonly keyVaultSecretPrefix: string;
}

export interface RateCardConfigEntry {
  id: string;
  name: string;
  practiceAreaKey: string | null;
  pmsDepartmentCode: string;
  partnerRateGbp: number;
  associateRateGbp: number;
  traineeRateGbp: number;
  customGrades: {
    id: string;
    label: string;
    hourlyRateGbp: number;
  }[];
  active: boolean;
}

export interface DisbursementPresetConfigEntry {
  id: string;
  description: string;
  defaultAmountGbp: number;
  practiceAreaKey: string | null;
  vatApplicable: boolean;
}

export type CustomFieldScreenType =
  | 'enquiry'
  | 'person'
  | 'organisation'
  | 'matter'
  | 'quote'
  | 'task';

export interface CustomFieldConfigEntry {
  id: string;
  recordType: CustomFieldScreenType;
  label: string;
  fieldType: 'text' | 'longText' | 'number' | 'date' | 'yesNo' | 'choice';
  optionsListKey?: string;
  options?: string[];
  section: string;
  required: boolean;
  sortOrder: number;
  active: boolean;
}

export type PmsFieldOwnershipDirection =
  | 'onesquared_master'
  | 'pms_master'
  | 'bidirectional';

export type PmsSyncEntityType =
  | 'client_organisation'
  | 'client_person'
  | 'matter'
  | 'fee_estimate'
  | 'employee';

export interface PmsFieldMappingEntry {
  id: string;
  entityType: PmsSyncEntityType;
  /** 1Squared field key (core property name, CORE-xxx code, or customField id) */
  onesquaredFieldKey: string;
  /** Third-party Finance/PMS DB column or API property path */
  externalFieldKey: string;
  /** System of Record ownership governing sync direction */
  ownership: PmsFieldOwnershipDirection;
  active: boolean;
}

export interface PmsIntegrationSyncConfig {
  enabled: boolean;
  providerKey: string;
  syncMode: 'read_only' | 'two_way';
  matterCodeAllocation: 'onesquared' | 'pms_on_open';
  clientCodeAllocation: 'onesquared' | 'pms_on_open';
  pollIntervalMinutes: number;
  fieldMappings: PmsFieldMappingEntry[];
}

export type PmsOutboundCommandType =
  | 'upsert_client'
  | 'open_matter'
  | 'update_matter_commercials'
  | 'revise_fee_estimate';

export interface PmsOutboundCommand<TPayload = Record<string, unknown>> {
  id: string;
  tenantId: string;
  correlationId: string;
  commandType: PmsOutboundCommandType;
  entityType: 'organisation' | 'person' | 'matter';
  onesquaredId: string;
  externalPmsCode: string | null;
  payload: TPayload;
  mappedFields: Record<string, unknown>;
  createdAt: string;
  createdById: string;
}

export interface PmsOutboundSyncResult {
  commandId: string;
  status: 'Synced' | 'Pending' | 'Failed';
  allocatedExternalPmsCode?: string | null;
  syncedAt: string;
  errorMessage?: string | null;
}

export type DocumentOutputFormat = 'docx' | 'pdf';

export type StorageProviderId =
  | 'local-fs'
  | 'azure-blob'
  | 'sharepoint'
  | 'imanage'
  | 'netdocuments';

export type MalwareScanStatus = 'pending' | 'clean' | 'infected' | 'failed';

export type GenerationEngineId = 'basic-merge' | (string & {});

export type FieldGroup =
  | 'Client'
  | 'Matter'
  | 'Financial'
  | 'Fee Earner'
  | 'Firm'
  | 'User'
  | 'Date'
  | 'Party'
  | 'Custom';

export type FieldDataType =
  | 'text'
  | 'date'
  | 'currency'
  | 'number'
  | 'boolean'
  | 'address';

export type FieldRequiredPermission =
  | 'document:generate'
  | 'finance:view'
  | 'employee:view_core';

export interface StructuredAddressValue {
  line1?: string;
  line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
}

export interface FieldResolutionContext {
  tenantId: string;
  nowIso?: string;
  client?: Record<string, unknown> | null;
  matter?: Record<string, unknown> | null;
  financial?: Record<string, unknown> | null;
  feeEarner?: Record<string, unknown> | null;
  firm?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  recipientParty?: Record<string, unknown> | null;
  counterparty?: Record<string, unknown> | null;
  customFields?: Record<string, unknown> | null;
  extensionFields?: Record<string, unknown> | null;
  promptedValues?: Record<string, unknown> | null;
}

export interface FieldCatalogueEntry {
  key: string;
  displayName: string;
  description: string;
  group: FieldGroup;
  dataType: FieldDataType;
  requiredPermission: FieldRequiredPermission;
  sinceVersion: string;
  deprecated?: {
    sinceVersion: string;
    replacementKey?: string;
    reason: string;
  };
  sampleValue?: string;
  resolve: (ctx: FieldResolutionContext) => unknown;
}

export interface ExtensionProvidedFieldDefinition {
  key: string;
  displayName: string;
  description: string;
  group: FieldGroup;
  dataType: FieldDataType;
  requiredPermission: FieldRequiredPermission;
  requiredEntityPermission:
    | 'matter:read'
    | 'client:read'
    | 'person:read'
    | 'finance:view';
}

export interface FieldProviderHookInput {
  sourceEntityType: 'matter' | 'client';
  matterId?: string;
  clientId?: string;
  matter?: Readonly<Record<string, unknown>> | null;
  client?: Readonly<Record<string, unknown>> | null;
}

export interface FieldProviderHookResult {
  definitions: ExtensionProvidedFieldDefinition[];
  values: Record<string, unknown>;
}

export type PlaceholderFilterName =
  | 'date'
  | 'currency'
  | 'upper'
  | 'title'
  | 'words'
  | 'address_single'
  | 'address_multi';

export interface ExtractedPlaceholder {
  rawToken: string;
  identifier: string;
  inlineFilter?: {
    name: PlaceholderFilterName;
    arg?: string;
  };
  locations: Array<{
    partName: string;
    paragraphIndex: number;
  }>;
}

export type PromptedFieldType = 'text' | 'date' | 'number' | 'choice';

export interface PromptedFieldDefinition {
  key: string;
  label: string;
  fieldType: PromptedFieldType;
  required: boolean;
  options?: string[];
  defaultValue?: string;
  helpText?: string;
}

export interface TemplatePlaceholderMapping {
  placeholder: string;
  sourceType: 'catalogue' | 'prompted';
  catalogueKey?: string;
  promptedKey?: string;
  formatFilter?: PlaceholderFilterName;
  formatArg?: string;
  fallbackText?: string;
  required: boolean;
}

export interface DocumentGenerationEngine {
  readonly engineId: GenerationEngineId;
  readonly supportedVersion: string;
  extractPlaceholders(docxBytes: Uint8Array): Promise<{
    placeholders: ExtractedPlaceholder[];
    validationErrors: Array<{ code: string; message: string; token?: string }>;
  }>;
  render(input: {
    docxBytes: Uint8Array;
    resolvedValues: Record<string, unknown>;
    mappings: Record<string, TemplatePlaceholderMapping>;
  }): Promise<{
    outputBytes: Uint8Array;
    missingRequiredFields: string[];
    warnings: string[];
  }>;
}

export interface DocumentPdfConverter {
  readonly converterId: string;
  convertDocxToPdf(input: {
    docxBytes: Uint8Array;
    title: string;
    authorName?: string;
  }): Promise<Uint8Array>;
}

export interface StoredBlobMetadata {
  storageProvider: StorageProviderId;
  containerName: string;
  blobKey: string;
  externalId?: string;
  externalVersion?: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  scanStatus: MalwareScanStatus;
  scannedAt?: string;
}

export interface ScopedDownloadToken {
  url: string;
  token: string;
  expiresAt: string;
  tenantId: string;
  blobKey: string;
  sub?: string;
  documentId?: string;
}

export interface DocumentStorageProvider {
  readonly providerId: StorageProviderId;
  putObject(
    ctx: TenantContext,
    input: {
      category: 'templates' | 'documents';
      objectId: string;
      fileName: string;
      contentType: string;
      bytes: Uint8Array;
      metadata?: Record<string, string>;
    },
  ): Promise<StoredBlobMetadata>;
  getObjectBytes(
    ctx: TenantContext,
    ref: { blobKey: string; externalId?: string },
  ): Promise<Uint8Array>;
  issueScopedDownloadToken(
    ctx: TenantContext,
    ref: {
      blobKey: string;
      externalId?: string;
      fileName: string;
      documentId?: string;
    },
    ttlSeconds?: number,
  ): Promise<ScopedDownloadToken>;
  verifyScopedDownloadToken(
    ctx: TenantContext,
    token: string,
  ): Promise<{
    blobKey: string;
    fileName: string;
    sub: string;
    documentId?: string;
  }>;
  deleteObject(
    ctx: TenantContext,
    ref: { blobKey: string; externalId?: string },
  ): Promise<void>;
  getMalwareScanStatus(
    ctx: TenantContext,
    blobKey: string,
  ): Promise<MalwareScanStatus>;
}

export type TemplateStatus =
  | 'Draft'
  | 'Submitted'
  | 'Active'
  | 'Rejected'
  | 'Retired';

export interface TemplateAvailabilityRules {
  sourceContexts: Array<'matter' | 'client'>;
  practiceAreaKeys?: string[];
  matterTypeKeys?: string[];
  clientTypes?: Array<'Organisation' | 'Person'>;
  allowedRoleKeys?: HomeRoleKey[];
}

export interface DocumentTemplateRecord {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  outputDocumentType: string;
  filenamePattern: string;
  availabilityRules: TemplateAvailabilityRules;
  activeVersionId: string | null;
  status: TemplateStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentTemplateVersionRecord {
  id: string;
  tenantId: string;
  templateId: string;
  versionNumber: number;
  engine: GenerationEngineId;
  status: TemplateStatus;
  storageProvider: StorageProviderId;
  blobKey: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  scanStatus: MalwareScanStatus;
  extractedPlaceholders: ExtractedPlaceholder[];
  fieldMappings: Record<string, TemplatePlaceholderMapping>;
  promptedFields: PromptedFieldDefinition[];
  createdByUserId: string;
  createdAt: string;
  submittedByUserId?: string | null;
  submittedAt?: string | null;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  changeNote?: string | null;
}

export interface GeneratedDocumentRecord {
  id: string;
  tenantId: string;
  title: string;
  fileName: string;
  documentType: string;
  outputFormat: DocumentOutputFormat;
  mimeType: string;
  fileSizeBytes: number;
  fileSha256: string;
  templateId: string;
  templateName: string;
  templateVersionId: string;
  templateVersionNumber: number;
  storageProvider: StorageProviderId;
  storageKey: string;
  externalId?: string | null;
  externalVersion?: string | null;
  generatedByUserId: string;
  generatedByName?: string;
  generatedAt: string;
  primaryMatterId?: string | null;
  primaryClientId?: string | null;
  recipientPartyId?: string | null;
  isDeleted: boolean;
  deletedByUserId?: string | null;
  deletedAt?: string | null;
}

export interface DocumentLinkRecord {
  id: string;
  tenantId: string;
  documentId: string;
  entityType: 'matter' | 'organisation' | 'person';
  entityId: string;
  linkRole: 'source_matter' | 'primary_client' | 'recipient_party';
  createdAt: string;
}

export type TemplateUsageEventType =
  | 'generated'
  | 'previewed'
  | 'blocked_missing_required'
  | 'blocked_permission';

export interface TemplateUsageEventRecord {
  id: string;
  tenantId: string;
  templateId: string;
  templateVersionId: string;
  versionNumber: number;
  eventType: TemplateUsageEventType;
  occurredAt: string;
  actorUserId: string;
  actorRoleKey: string;
  teamId?: string | null;
  practiceAreaId?: string | null;
  matterTypeId?: string | null;
  sourceEntityType: 'matter' | 'client' | 'template_builder';
  outputFormat: DocumentOutputFormat;
  missingFieldKeys: string[];
  durationMs: number;
  correlationId: string;
}

export interface TemplateUsageDailySummaryRecord {
  tenantId: string;
  bucketDate: string;
  templateId: string;
  templateVersionId: string;
  practiceAreaId: string;
  matterTypeId: string;
  teamId: string;
  generatedCount: number;
  previewedCount: number;
  blockedMissingRequiredCount: number;
  blockedPermissionCount: number;
  lastGeneratedAt: string | null;
}

export interface TemplatePackageManifest {
  packageFormatVersion: '1.0';
  exportedAt: string;
  template: {
    code: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    outputDocumentType: string;
    filenamePattern: string;
    availabilityRules: TemplateAvailabilityRules;
  };
  version: {
    engine: GenerationEngineId;
    fileName: string;
    fileSha256: string;
    docxBase64: string;
    fieldMappings: Record<string, TemplatePlaceholderMapping>;
    promptedFields: PromptedFieldDefinition[];
    changeNote?: string;
  };
}

export interface DocumentGenerationConfig {
  enabled: boolean;
  maxTemplateSizeMb: number;
  defaultOutputFormat: DocumentOutputFormat;
  allowUserFormatOverride: boolean;
  storageProvider: StorageProviderId;
  approval: {
    requireApproval: boolean;
    allowSelfApproval: boolean;
  };
  usage: {
    retentionMonths: number;
    lowUseThreshold: number;
    showUserLevelDetail: boolean;
  };
  /**
   * @deprecated Replaced by `rbac.roles` (ADR-0011). Retained in v1.x for backward compatibility;
   * emits a deprecation warning when supplied in raw tenant config.
   */
  permissions?: {
    roleDefaults: Partial<Record<DocumentPermission, string[]>>;
  };
  customDocumentTypes: Array<{
    key: string;
    label: string;
  }>;
}

export interface TenantConfiguration {
  schemaVersion: string;
  tenantId: string;
  displayName: string;
  hostingMode: HostingMode;
  environment: PlatformEnvironment;
  branding: {
    primaryDomain: string;
    accentColorHex: string;
    logoAssetKey: string;
    contactEmail?: string;
    website?: string;
  };
  firm?: {
    contactEmail?: string;
    website?: string;
  };
  conflictReview?: {
    assigneeTeamKey?: string | null;
    assigneeRoleKey?: string | null;
  };
  featureFlags: {
    enableMatterCostsGovernance: boolean;
    enablePmsLiveRateSync: boolean;
    enableAiMatterExtraction: boolean;
    enableDemoMode?: boolean;
  };
  matterCosts: {
    rateSourceMode: 'application_table' | 'pms_when_linked';
    allowMatterRateOverrides: boolean;
    partnerSignOffThresholdGbp: number;
    rateCards: RateCardConfigEntry[];
    disbursementPresets: DisbursementPresetConfigEntry[];
  };
  integrations: {
    pmsConnectionSecretVaultRef: string;
    companiesHouseApiKeyVaultRef: string;
    aiProviderChoice: 'azure_openai_uk' | 'anthropic' | 'disabled';
    pmsSync?: PmsIntegrationSyncConfig;
  };
  customFields: CustomFieldConfigEntry[];
  enabledExtensions: string[];
  documentGeneration: DocumentGenerationConfig;
  rbac: RbacConfiguration;
  documentStores?: DocumentStoreConfig[];
  documentRouting?: DocumentRoutingRule[];
  documentAccess?: DocumentAccessConfig;
  matterFolderNameTemplate?: string;
  matterFolderTemplates?: MatterFolderTemplatesConfig;
  keyDates?: KeyDatesConfiguration;
}

// ------------------------------------------------------------------ External Document Store Integration Contracts (ADR-0017 .. ADR-0021)

export type DocumentStoreProviderType =
  | 'sharepoint'
  | 'azure_blob'
  | 'imanage'
  | 'netdocuments';

export type DocumentAccessLevel =
  | 'none'
  | 'read'
  | 'contribute'
  | 'edit'
  | 'manage';

export type DocumentConflictBehavior = 'fail' | 'rename' | 'replace';

export type DocumentStoreErrorCode =
  | 'not_found'
  | 'access_denied'
  | 'conflict'
  | 'throttled'
  | 'unavailable'
  | 'misconfigured'
  | 'invalid_path'
  | 'reauthentication_required';

export type DocumentStoreErrorReason =
  | 'site_access_not_granted'
  | 'site_grant_role_insufficient'
  | 'excess_permissions_consented'
  | 'site_or_drive_mismatch';

export type SharePointRoleVerificationStatus =
  | 'verified'
  | 'not_verified'
  | 'insufficient';

export interface DocumentStoreCapabilities {
  readonly versions: boolean;
  readonly checkInOut: boolean;
  readonly uniqueFolderPermissions: boolean;
  readonly metadataColumns: boolean;
  readonly retentionLabels: boolean;
  readonly changeTracking: boolean;
  readonly resumableLargeUpload: boolean;
  readonly deepLinkCoAuthoring: boolean;
  readonly maxPathLengthChars: number;
  readonly maxSegmentLengthChars: number;
}

export interface UserAccessContext {
  readonly kind: 'user';
  readonly tenantContext: TenantContext;
  readonly actorUserId?: string;
  readonly entraObjectId: string;
  readonly userUpn?: string;
  /**
   * Incoming verified user OIDC/OAuth token assertion used strictly for server-side
   * On-Behalf-Of (OBO) exchange. Never logged, persisted to DB, or returned to client.
   */
  readonly userAssertionToken?: string;
}

export interface ProvisioningAccessContext {
  readonly kind: 'provisioning';
  readonly tenantContext: TenantContext;
  readonly triggeredByUserId?: string | null;
  readonly triggerEvent: string;
  readonly jobId?: string;
}

export type DocumentAccessContext =
  | UserAccessContext
  | ProvisioningAccessContext;

export type DocumentStoreAccessContext = DocumentAccessContext;

export interface DocumentStoreContainerRef {
  readonly storeId: string;
  readonly libraryId?: string;
  readonly siteId: string;
  readonly driveId: string;
  readonly folderItemId?: string;
  readonly relativePath?: string;
}

export interface DocumentStoreItemRef {
  readonly storeId: string;
  readonly libraryId?: string;
  readonly siteId: string;
  readonly driveId: string;
  readonly itemId: string;
}

export interface DocumentStoreItem {
  readonly itemId: string;
  readonly storeId: string;
  readonly siteId: string;
  readonly driveId: string;
  readonly parentItemId: string | null;
  readonly itemType: 'file' | 'folder';
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
  readonly webUrl: string;
  readonly eTag?: string;
  readonly versionLabel?: string;
  readonly createdAt: string;
  readonly createdByDisplayName?: string;
  readonly lastModifiedAt: string;
  readonly lastModifiedByDisplayName?: string;
  readonly childCount?: number;
  readonly hasUniquePermissions?: boolean;
  /** Phase 2 hook: SharePoint/DMS metadata columns */
  readonly customMetadata?: Record<string, unknown>;
  /** Phase 2 hook: SharePoint/DMS content type identifier */
  readonly contentTypeId?: string;
  /** Phase 2 hook: Applied retention label */
  readonly retentionLabel?: string | null;
}

export interface DocumentStorePagingOptions {
  readonly pageSize?: number;
  readonly cursor?: string | null;
}

export interface DocumentStoreListPage {
  readonly items: DocumentStoreItem[];
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

export type DocumentStoreListResult = DocumentStoreListPage;

export interface DocumentEffectiveAccess {
  readonly level: DocumentAccessLevel;
  readonly canRead: boolean;
  readonly canDownload: boolean;
  readonly canUpload: boolean;
  readonly canCreateFolder: boolean;
  readonly canRename: boolean;
  readonly canMove: boolean;
  readonly canDelete: boolean;
  readonly canManagePermissions: boolean;
}

export interface DocumentUploadOptions {
  readonly conflictBehavior?: DocumentConflictBehavior;
  readonly mimeType?: string;
  readonly contentType?: string;
  readonly ifMatchETag?: string;
  readonly chunkSizeBytes?: number;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  /** Phase 2 hook: Optional metadata columns to set on upload */
  readonly customMetadata?: Record<string, unknown>;
}

export interface DocumentStoreConnectionTestResult {
  readonly ok: boolean;
  readonly providerType: DocumentStoreProviderType;
  readonly storeId: string;
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly errorCode?: DocumentStoreErrorCode;
  readonly errorReason?: string;
  readonly errorReasonCode?: DocumentStoreErrorReason;
  readonly roleVerificationStatus?: SharePointRoleVerificationStatus;
  readonly warnings?: readonly string[];
  readonly checks: {
    readonly credentialsValid: boolean;
    readonly targetSiteReachable: boolean;
    readonly librariesFound: boolean;
    readonly permissionManagementSupported: boolean;
  };
}

export interface DocumentLocationResolutionInput {
  readonly storeId?: string;
  readonly libraryId?: string;
  readonly rawUrlOrPath: string;
}

export type ResolveDocumentLocationInput = DocumentLocationResolutionInput;

export interface DocumentLocationResolutionResult {
  readonly resolved: boolean;
  readonly libraryId?: string;
  readonly siteId?: string;
  readonly driveId?: string;
  readonly libraryName?: string;
  readonly folderItemId?: string;
  readonly relativePath?: string;
  readonly webUrl?: string;
  readonly errorCode?: DocumentStoreErrorCode;
  readonly errorMessage?: string;
}

export type ResolvedDocumentStoreLocation = DocumentLocationResolutionResult;

export interface DocumentStoreFolderTreeNode {
  readonly name: string;
  readonly relativePath: string;
  readonly description?: string;
  readonly children?: DocumentStoreFolderTreeNode[];
}

export type DocumentFolderTreeNodeInput = DocumentStoreFolderTreeNode;

export interface DocumentFolderEnsureResult {
  readonly rootFolderItemId: string;
  readonly rootWebUrl: string;
  /** Map of relative path (e.g. "01 Correspondence" or "02 Documents/Drafts") to provider itemId */
  readonly folderItemMap: Record<string, string>;
}

export type EnsuredFolderTreeResult = DocumentFolderEnsureResult;

export type DocumentPrincipalType = 'group' | 'user';

export interface DocumentPrincipalRef {
  readonly principalType: DocumentPrincipalType;
  /** Entra Object GUID (`oid` or Group Object ID) */
  readonly entraObjectId: string;
  /** 1Squared Person ID, Department ID, Team ID, or named group key */
  readonly internalId?: string;
  /** User Principal Name / work email for resolving users who have not yet signed in */
  readonly upn?: string;
  readonly displayName?: string;
}

export interface DocumentPrincipalLookupInput {
  readonly principalType: DocumentPrincipalType;
  readonly entraObjectId?: string;
  readonly upn?: string;
  readonly internalId?: string;
  readonly displayName?: string;
}

export type ResolvedDocumentPrincipal = DocumentPrincipalRef;

export interface DocumentPermissionGrant {
  readonly principal: DocumentPrincipalRef;
  readonly level: DocumentAccessLevel;
}

export interface DocumentPermissionSharingLink {
  readonly linkId: string;
  readonly scope: 'anonymous' | 'organization' | 'users';
  readonly type: 'view' | 'edit' | 'embed' | string;
  readonly webUrl?: string;
}

export type DetectedSharingLink = DocumentPermissionSharingLink;

export interface DocumentPermissionSnapshot {
  readonly itemId: string;
  readonly inheritsFromParent: boolean;
  readonly grants: DocumentPermissionGrant[];
  readonly sharingLinks: DocumentPermissionSharingLink[];
}

export type DocumentItemPermissionsState = DocumentPermissionSnapshot;

export interface DocumentStoreProvider {
  readonly providerType: DocumentStoreProviderType;
  readonly storeId: string;
  readonly capabilities: DocumentStoreCapabilities;

  // ---------------- User-context operations (always acting as the signed-in user via OBO) ----------------
  listItems(
    ctx: DocumentAccessContext,
    containerRef: DocumentStoreContainerRef,
    paging?: DocumentStorePagingOptions,
  ): Promise<DocumentStoreListPage>;

  getItem(
    ctx: DocumentAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentStoreItem>;

  downloadContent(
    ctx: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    eTag?: string;
  }>;

  uploadContent(
    ctx: DocumentAccessContext,
    containerRef: DocumentStoreContainerRef,
    name: string,
    stream: ReadableStream<Uint8Array> | Uint8Array,
    sizeBytes: number,
    options?: DocumentUploadOptions,
  ): Promise<DocumentStoreItem>;

  createFolder(
    ctx: UserAccessContext,
    containerRef: DocumentStoreContainerRef,
    name: string,
    conflictBehavior?: DocumentConflictBehavior,
  ): Promise<DocumentStoreItem>;

  renameItem(
    ctx: UserAccessContext,
    itemRef: DocumentStoreItemRef,
    newName: string,
  ): Promise<DocumentStoreItem>;

  moveItem(
    ctx: DocumentAccessContext,
    itemRef: DocumentStoreItemRef,
    targetContainerRef: DocumentStoreContainerRef,
    newName?: string,
  ): Promise<DocumentStoreItem>;

  deleteItem(
    ctx: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<void>;

  getWebUrl(
    ctx: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<{ webUrl: string; openInAppUrl?: string }>;

  getEffectiveAccess(
    ctx: UserAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentEffectiveAccess>;

  // ---------------- Provisioning-context operations (always acting as application identity) ----------------
  testConnection(
    ctx: ProvisioningAccessContext,
  ): Promise<DocumentStoreConnectionTestResult>;

  resolveLocation(
    ctx: ProvisioningAccessContext,
    input: DocumentLocationResolutionInput,
  ): Promise<DocumentLocationResolutionResult>;

  ensureFolderTree(
    ctx: ProvisioningAccessContext,
    rootRef: DocumentStoreContainerRef,
    tree: readonly DocumentStoreFolderTreeNode[],
  ): Promise<DocumentFolderEnsureResult>;

  getPermissions(
    ctx: ProvisioningAccessContext,
    itemRef: DocumentStoreItemRef,
  ): Promise<DocumentPermissionSnapshot>;

  setPermissions(
    ctx: ProvisioningAccessContext,
    itemRef: DocumentStoreItemRef,
    intendedGrants: readonly DocumentPermissionGrant[],
    options: { inherit: boolean },
  ): Promise<DocumentPermissionSnapshot>;

  resolvePrincipal(
    ctx: ProvisioningAccessContext,
    lookup: DocumentPrincipalLookupInput,
  ): Promise<DocumentPrincipalRef | null>;

  // ---------------- Phase 2 Optional Extension Capabilities (non-breaking) ----------------
  searchItems?(
    ctx: UserAccessContext,
    scopeRef: DocumentStoreContainerRef,
    query: string,
    paging?: DocumentStorePagingOptions,
  ): Promise<DocumentStoreListPage>;

  getChanges?(
    ctx: ProvisioningAccessContext,
    containerRef: DocumentStoreContainerRef,
    deltaToken?: string | null,
  ): Promise<{
    items: DocumentStoreItem[];
    deletedItemIds: string[];
    nextDeltaToken: string;
  }>;

  applyRetentionLabel?(
    ctx: ProvisioningAccessContext,
    itemRef: DocumentStoreItemRef,
    retentionLabelName: string | null,
  ): Promise<void>;
}

/**
 * Phase 2 design interface (`ADR-0019`): Synchronises 1Squared department and team memberships
 * to Microsoft Entra ID Security Groups. Exported in Phase 1 so Phase 2 requires no breaking changes.
 */
export interface GroupMembershipSync {
  previewGroupSync(
    ctx: ProvisioningAccessContext,
    input: {
      groupObjectId: string;
      expectedMemberEntraObjectIds: readonly string[];
    },
  ): Promise<{
    toAddEntraObjectIds: string[];
    toRemoveEntraObjectIds: string[];
  }>;

  reconcileGroupMembership(
    ctx: ProvisioningAccessContext,
    input: {
      groupObjectId: string;
      expectedMemberEntraObjectIds: readonly string[];
      dryRun?: boolean;
    },
  ): Promise<{
    addedCount: number;
    removedCount: number;
  }>;
}

// ---------------- Tenant Configuration Types for Document Stores, Routing, Access & Templates ----------------

export interface SharePointLibraryConfig {
  libraryId: string;
  displayName: string;
  libraryUrlSegment: string;
  driveId?: string;
}

export interface SharePointStoreConfig {
  hostname: string;
  siteRelativePath: string;
  siteId?: string;
  libraries: SharePointLibraryConfig[];
}

export interface DocumentStoreAuthConfig {
  entraTenantId: string;
  credentialMode: 'client_certificate' | 'managed_identity';
  clientId?: string;
  certificateKeyVaultSecretRef?: string;
  managedIdentityClientId?: string;
  delegatedPermissionScope: 'Files.ReadWrite.All' | 'Sites.Selected';
}

export interface DocumentStoreConfig {
  storeId: string;
  displayName: string;
  providerType: DocumentStoreProviderType;
  isDefault: boolean;
  enabled: boolean;
  auth: DocumentStoreAuthConfig;
  sharepoint?: SharePointStoreConfig;
}

export interface DocumentRoutingMatchCriteria {
  departmentId?: string;
  teamId?: string;
  workTypeId?: string;
}

export interface DocumentRoutingRule {
  ruleId?: string;
  match: 'default' | DocumentRoutingMatchCriteria;
  storeId: string;
  libraryId: string;
  basePath: string;
}

export interface DocumentAccessGroupGrantRule {
  groupId: string;
  level: DocumentAccessLevel;
  description?: string;
}

export interface DocumentAccessPolicyConfig {
  libraryRoot: DocumentAccessGroupGrantRule[];
  owningDepartment: DocumentAccessLevel;
  owningTeam: DocumentAccessLevel;
  otherDepartments: DocumentAccessLevel;
  matterTeamOutsider: DocumentAccessLevel;
  restrictedMatter: {
    allowedUserLevel: DocumentAccessLevel;
    groups: DocumentAccessGroupGrantRule[];
  };
  closedMatter: DocumentAccessLevel;
}

export interface DocumentAccessConfig {
  departmentEntraGroups: Record<string, string>;
  teamEntraGroups: Record<string, string>;
  uniqueScopeWarningThreshold?: number;
  autoRemediateDrift?: boolean;
  defaultPolicy?: DocumentAccessPolicyConfig;
  policiesByStore?: Record<string, DocumentAccessPolicyConfig>;
}

export interface MatterFolderNodeAccessOverride {
  inherit: boolean;
  grants?: Array<{
    principalType: DocumentPrincipalType;
    principalId: string;
    level: DocumentAccessLevel;
  }>;
}

export interface MatterFolderTemplateNode {
  name: string;
  description?: string;
  orderPrefix?: 'none' | 'two_digit';
  access?: MatterFolderNodeAccessOverride | null;
  filingAliases?: string[];
  children?: MatterFolderTemplateNode[];
}

export interface MatterFolderTemplateOperation {
  op: 'add' | 'remove' | 'rename' | 'move' | 'setAccess';
  parentPath?: string;
  path?: string;
  newName?: string;
  newParentPath?: string;
  node?: MatterFolderTemplateNode;
  access?: MatterFolderNodeAccessOverride | null;
}

export interface MatterFolderTemplateDefinition {
  templateId: string;
  version: number;
  mode: 'replaces' | 'extends';
  description?: string;
  nodes?: MatterFolderTemplateNode[];
  operations?: MatterFolderTemplateOperation[];
}

export type MatterFolderTemplateOverlay = MatterFolderTemplateDefinition;

export interface MatterFolderTemplatesConfig {
  default: MatterFolderTemplateDefinition;
  byDepartment?: Record<string, MatterFolderTemplateDefinition>;
  byWorkType?: Record<string, MatterFolderTemplateDefinition>;
}

export interface MatterDocumentsLifecycleHookInput {
  matterId: string;
  storeId: string;
  libraryId: string;
  rootFolderItemId: string;
  templateId?: string;
  templateVersion?: number;
  closedAt?: string;
  retentionPeriod?: string;
}

export type MatterDocumentsProvisionedHookInput =
  MatterDocumentsLifecycleHookInput;
export type MatterDocumentsCloseHookInput = MatterDocumentsLifecycleHookInput;

export interface MatterDocumentsCloseHookResult {
  /** Phase 2 hook: Optional retention label to apply on matter closure */
  retentionLabelToApply?: string | null;
}

export interface MatterCostsHookInput {
  matterId: string;
  workBasis: 'hourly_rates' | 'fixed_fee' | 'capped';
  estimatedFeeGbp: number;
  disbursementsTotalGbp: number;
  partnerSignOffCompleted: boolean;
}

export interface MatterCostsHookResult {
  requiresPartnerSignOff: boolean;
  governanceWarnings: string[];
  allowProceed: boolean;
}

export interface ExtensionExecutionContext {
  readonly tenant: Pick<
    TenantContext,
    'tenantId' | 'hostingMode' | 'environment' | 'correlationId' | 'actorRoles'
  >;
  readonly config: Readonly<TenantConfiguration>;
}

export interface PlatformExtension {
  readonly manifest: ExtensionManifest;
  readonly hooks: {
    beforeMatterCostsCalculate?: (
      ctx: ExtensionExecutionContext,
      input: MatterCostsHookInput,
    ) => Promise<MatterCostsHookResult> | MatterCostsHookResult;
    beforeMatterOpen?: (
      ctx: ExtensionExecutionContext,
      input: MatterCostsHookInput,
    ) => Promise<MatterCostsHookResult> | MatterCostsHookResult;
    onPmsOutboundCommand?: (
      ctx: ExtensionExecutionContext,
      command: PmsOutboundCommand,
    ) => Promise<PmsOutboundSyncResult> | PmsOutboundSyncResult;
    provideDocumentFields?: (
      ctx: ExtensionExecutionContext,
      input: FieldProviderHookInput,
    ) => Promise<FieldProviderHookResult> | FieldProviderHookResult;
    afterMatterDocumentsProvisioned?: (
      ctx: ExtensionExecutionContext,
      input: MatterDocumentsLifecycleHookInput,
    ) => Promise<void> | void;
    beforeMatterDocumentsClose?: (
      ctx: ExtensionExecutionContext,
      input: MatterDocumentsLifecycleHookInput,
    ) =>
      | Promise<MatterDocumentsCloseHookResult | void>
      | MatterDocumentsCloseHookResult
      | void;
    'keyDate.beforeCreate'?: (
      ctx: ExtensionExecutionContext,
      input: KeyDateBeforeCreateHookInput,
    ) => Promise<KeyDateBeforeCreateHookResult> | KeyDateBeforeCreateHookResult;
    'keyDate.afterStatusChange'?: (
      ctx: ExtensionExecutionContext,
      input: KeyDateAfterStatusChangeHookInput,
    ) => Promise<void> | void;
    'keyDate.calculateCustomRule'?: (
      ctx: ExtensionExecutionContext,
      input: KeyDateCalculateCustomRuleHookInput,
    ) =>
      | Promise<KeyDateCalculateCustomRuleHookResult>
      | KeyDateCalculateCustomRuleHookResult;
  };
}

// ---------------- Key Dates & Limitation Configuration and Extension Hook Contracts ----------------

export interface KeyDateBeforeCreateHookInput {
  matterId?: string;
  enquiryId?: string;
  keyDateTypeId: string;
  category: string;
  title: string;
  dueDate: string;
  dueTime?: string;
  isCritical: boolean;
  teamId: string;
  responsiblePersonIds: string[];
  notes?: string;
}

export interface KeyDateBeforeCreateHookResult {
  allowProceed: boolean;
  rejectionReason?: string;
  enrichedFields?: Partial<
    Pick<
      KeyDateBeforeCreateHookInput,
      'title' | 'dueDate' | 'dueTime' | 'isCritical' | 'notes'
    >
  >;
}

export interface KeyDateAfterStatusChangeHookInput {
  keyDateId: string;
  matterId?: string;
  enquiryId?: string;
  keyDateTypeId: string;
  previousStatus?: string;
  newStatus: string;
  dueDate: string;
  changedById: string;
  changedAt: string;
}

export interface KeyDateCalculateCustomRuleHookInput {
  ruleSetId: string;
  ruleId: string;
  triggers: Record<string, unknown>;
}

export interface KeyDateCalculateCustomRuleHookResult {
  date: string;
  explanation: string[];
  warnings?: string[];
}

export interface KeyDatesConfiguration {
  enabled: boolean;
  defaults?: {
    verification?: {
      required: boolean;
      appliesTo?: 'all' | 'critical_only' | 'limitation_only';
    };
    calendarSync?: {
      enabled: boolean;
    };
    reminderScheduleId?: string;
    teamAssignment?: 'matter_owning_team';
  };
  keyDateTypes?: Array<{
    id: string;
    label: string;
    category:
      | 'limitation'
      | 'court_deadline'
      | 'contractual'
      | 'undertaking'
      | 'compliance'
      | 'internal_milestone';
    defaultCritical?: boolean;
    reminderScheduleId?: string;
    allowManualEntry?: boolean;
    allowCalculation?: boolean;
    active?: boolean;
  }>;
  matterTypes?: Array<{
    matterTypeId: string;
    requiredKeyDateTypeIds?: string[];
    allowNotApplicable?: boolean;
    blockClosureWithOpenDates?: boolean;
    defaultRuleSetIds?: string[];
    verification?: {
      required: boolean;
      appliesTo?: 'all' | 'critical_only' | 'limitation_only';
    };
    calendarSync?: {
      enabled: boolean;
    };
  }>;
  reminderSchedules?: Array<{
    id: string;
    label: string;
    stages: Array<{
      daysBefore: number;
      priority?: 'normal' | 'high' | 'urgent';
    }>;
    escalation?: {
      afterUnacknowledgedDays?: number;
      levels?: string[];
    };
  }>;
  limitationRuleSets?: Array<{
    id: string;
    version: number;
    label: string;
    jurisdiction: 'england_and_wales' | 'scotland' | 'northern_ireland' | 'other';
    reviewStatus: 'unreviewed' | 'reviewed';
    reviewedBy?: string;
    reviewedOn?: string;
    rules: Array<{
      id: string;
      label: string;
      claimType?: string;
      guidanceNote?: string;
      trigger:
        | { kind: 'single'; field: string }
        | { kind: 'later_of'; fields: string[] };
      period: {
        years?: number;
        months?: number;
        days?: number;
      };
      countMethod?: 'calendar' | 'business_days' | 'clear_days';
      calendarId?: string;
      nonWorkingDayAdjustment?: 'none' | 'next_working_day' | 'previous_working_day';
      minorityAdjustment?: {
        enabled?: boolean;
        ageOfMajority?: number;
      };
      applyStandstillPeriods?: boolean;
      longstop?: {
        field: string;
        period: {
          years?: number;
          months?: number;
          days?: number;
        };
      };
    }>;
  }>;
  businessCalendars?: Array<{
    id: string;
    label: string;
    weekendDays?: number[];
    nonWorkingDates?: string[];
    source?: 'manual' | 'imported';
  }>;
  calendarSync?: {
    provider?: 'microsoft_graph';
    targets?: Array<'responsible_persons' | 'team_calendar'>;
    eventTitleTemplate?: string;
    includeMatterDescription?: boolean;
    statusesToSync?: Array<'provisional' | 'awaiting_verification' | 'confirmed'>;
    teamCalendarMappings?: Array<{
      teamId: string;
      groupId: string;
    }>;
  };
  exceptions?: {
    verificationOverdueDays?: number;
    criticalNoActivityDays?: number;
    criticalNoActivityWindowDays?: number;
  };
  permissions?: {
    roleGrants?: Record<string, KeyDatePermission[]>;
  };
}

