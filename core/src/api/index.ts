/**
 * @platform/core-api
 * Public API and extension contract for the Platform.
 * Extensions may ONLY import from this package, never from core internals.
 */

export const CORE_VERSION = '1.0.0';
export const CORE_API_VERSION = '1.0.0';

export type HostingMode = 'single_tenant' | 'multi_tenant';
export type PlatformEnvironment = 'dev' | 'test' | 'training' | 'live';

export type ExtensionPermission =
  | 'matter:read'
  | 'matter:costs:validate'
  | 'matter:open:gate'
  | 'config:read'
  | 'audit:write'
  | 'pms:sync';

export type ExtensionHookName =
  | 'beforeMatterCostsCalculate'
  | 'afterMatterCostsCalculate'
  | 'beforeMatterOpen'
  | 'afterMatterOpen'
  | 'onPmsOutboundCommand';

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
  readonly actorRoles: readonly string[];
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
  };
  featureFlags: {
    enableMatterCostsGovernance: boolean;
    enablePmsLiveRateSync: boolean;
    enableAiMatterExtraction: boolean;
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
    aiProviderChoice: 'azure_openai_uk' | 'disabled';
    pmsSync?: PmsIntegrationSyncConfig;
  };
  customFields: CustomFieldConfigEntry[];
  enabledExtensions: string[];
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
  };
}
