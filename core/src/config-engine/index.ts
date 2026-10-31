/**
 * Schema-validated tenant configuration engine (`core/src/config-engine/`).
 *
 * Rules enforced:
 * - Every configuration option has a type, default, description, and validation.
 * - Unknown keys are rejected (`.strict()`).
 * - Secrets are referenced by Key Vault URI/name only; raw secrets are rejected.
 */

import { z } from 'zod';
import type {
  HostingMode,
  PlatformEnvironment,
  TenantConfiguration,
} from '../api/index';

const KeyVaultRefSchema = z
  .string()
  .regex(
    /^kv:\/\/[a-z0-9-]+\/[a-z0-9-]+$/i,
    'Integration secrets must be Key Vault references formatted as kv://<vault>/<secret-name>',
  )
  .describe('Key Vault secret reference URI (never a raw secret value)');

const CustomGradeSchema = z
  .object({
    id: z.string().min(1).describe('Unique grade identifier'),
    label: z.string().min(1).describe('Display label for the custom fee-earner grade'),
    hourlyRateGbp: z.number().nonnegative().describe('Standard hourly rate in GBP'),
  })
  .strict();

const RateCardEntrySchema = z
  .object({
    id: z.string().min(1).describe('Rate card identifier'),
    name: z.string().min(1).describe('Rate card display name'),
    practiceAreaKey: z
      .string()
      .nullable()
      .default(null)
      .describe('Optional practice area key mapped to this rate card'),
    pmsDepartmentCode: z
      .string()
      .default('Standard')
      .describe('Department code in the practice management system'),
    partnerRateGbp: z.number().nonnegative().default(350).describe('Partner hourly rate in GBP'),
    associateRateGbp: z.number().nonnegative().default(250).describe('Associate hourly rate in GBP'),
    traineeRateGbp: z.number().nonnegative().default(145).describe('Trainee hourly rate in GBP'),
    customGrades: z
      .array(CustomGradeSchema)
      .default([])
      .describe('Optional additional fee-earner grade rates'),
    active: z.boolean().default(true).describe('Whether this rate card is active'),
  })
  .strict();

const DisbursementPresetSchema = z
  .object({
    id: z.string().min(1).describe('Disbursement preset identifier'),
    description: z.string().min(1).describe('Disbursement line description'),
    defaultAmountGbp: z.number().nonnegative().default(0).describe('Default amount in GBP'),
    practiceAreaKey: z
      .string()
      .nullable()
      .default(null)
      .describe('Optional practice area key restriction'),
    vatApplicable: z.boolean().default(true).describe('Whether standard UK VAT applies'),
  })
  .strict();

const CustomFieldConfigEntrySchema = z
  .object({
    id: z.string().min(1).describe('Unique custom field identifier'),
    recordType: z
      .enum(['enquiry', 'person', 'organisation', 'matter', 'quote', 'task'])
      .describe('Target screen / record type for this custom field'),
    label: z.string().min(1).describe('Display label shown on the form and profile'),
    fieldType: z
      .enum(['text', 'longText', 'number', 'date', 'yesNo', 'choice'])
      .describe('Input control and validation data type'),
    optionsListKey: z
      .string()
      .optional()
      .describe('Choice list key when fieldType is choice'),
    options: z
      .array(z.string())
      .optional()
      .describe('Selectable option labels when fieldType is choice'),
    section: z
      .string()
      .default('additional')
      .describe('Location / section key on the target screen where this field is rendered'),
    required: z
      .boolean()
      .default(false)
      .describe('Whether the client requires this field to be completed before saving/routing'),
    sortOrder: z
      .number()
      .int()
      .nonnegative()
      .default(1)
      .describe('Display order within the target screen section'),
    active: z
      .boolean()
      .default(true)
      .describe('Whether the custom field is currently active'),
  })
  .strict();

const PmsFieldMappingEntrySchema = z
  .object({
    id: z.string().min(1).describe('Unique field mapping identifier'),
    entityType: z
      .enum(['client_organisation', 'client_person', 'matter', 'fee_estimate', 'employee'])
      .describe('Target entity type for the cross-system mapping'),
    onesquaredFieldKey: z
      .string()
      .min(1)
      .describe('1Squared field key (core property, CORE-xxx code, or customField id)'),
    externalFieldKey: z
      .string()
      .min(1)
      .describe('Third-party Finance/PMS DB column or API property path'),
    ownership: z
      .enum(['onesquared_master', 'pms_master', 'bidirectional'])
      .default('onesquared_master')
      .describe('System of Record ownership governing sync direction'),
    active: z.boolean().default(true).describe('Whether this mapping is active'),
  })
  .strict();

const PmsIntegrationSyncConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe('Whether PMS / Finance DB synchronisation is enabled for this tenant'),
    providerKey: z
      .string()
      .min(1)
      .default('generic_sql')
      .describe('Identifier of the connected PMS / Finance adapter'),
    syncMode: z
      .enum(['read_only', 'two_way'])
      .default('two_way')
      .describe('Whether integration is read-only inbound or two-way'),
    matterCodeAllocation: z
      .enum(['onesquared', 'pms_on_open'])
      .default('onesquared')
      .describe('System responsible for allocating canonical matter numbers'),
    clientCodeAllocation: z
      .enum(['onesquared', 'pms_on_open'])
      .default('onesquared')
      .describe('System responsible for allocating canonical client codes'),
    pollIntervalMinutes: z
      .number()
      .int()
      .positive()
      .default(15)
      .describe('Inbound delta sync polling interval in minutes'),
    fieldMappings: z
      .array(PmsFieldMappingEntrySchema)
      .default([])
      .describe('Field-level mappings and System-of-Record ownership rules'),
  })
  .strict();

export const TenantConfigurationSchema = z
  .object({
    schemaVersion: z
      .string()
      .default('1.0.0')
      .describe('Semantic version of the configuration schema'),
    tenantId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/)
      .describe('Unique immutable tenant slug'),
    displayName: z.string().min(1).describe('Tenant display name'),
    hostingMode: z
      .enum(['single_tenant', 'multi_tenant'])
      .default('multi_tenant')
      .describe('Deployment tenancy mode (Model A single_tenant or Model B multi_tenant)'),
    environment: z
      .enum(['dev', 'test', 'training', 'live'])
      .default('dev')
      .describe('Target deployment environment'),
    branding: z
      .object({
        primaryDomain: z.string().min(1).describe('Verified primary domain for the tenant'),
        accentColorHex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#1f6feb')
          .describe('Primary brand accent hex colour'),
        logoAssetKey: z
          .string()
          .default('default-logo.svg')
          .describe('Tenant-scoped asset key for the firm logo'),
      })
      .strict(),
    featureFlags: z
      .object({
        enableMatterCostsGovernance: z
          .boolean()
          .default(true)
          .describe('Enable matter cost threshold governance checks'),
        enablePmsLiveRateSync: z
          .boolean()
          .default(true)
          .describe('Allow syncing hourly rates from the connected PMS'),
        enableAiMatterExtraction: z
          .boolean()
          .default(false)
          .describe('Enable AI-assisted matter field extraction'),
      })
      .strict(),
    matterCosts: z
      .object({
        rateSourceMode: z
          .enum(['application_table', 'pms_when_linked'])
          .default('pms_when_linked')
          .describe('Source of default fee-earner hourly rates'),
        allowMatterRateOverrides: z
          .boolean()
          .default(true)
          .describe('Whether fee earners can override standard rates on a matter'),
        partnerSignOffThresholdGbp: z
          .number()
          .nonnegative()
          .default(25000)
          .describe('Fee estimate or cap threshold in GBP requiring Partner cost sign-off'),
        rateCards: z.array(RateCardEntrySchema).default([]),
        disbursementPresets: z.array(DisbursementPresetSchema).default([]),
      })
      .strict(),
    integrations: z
      .object({
        pmsConnectionSecretVaultRef: KeyVaultRefSchema,
        companiesHouseApiKeyVaultRef: KeyVaultRefSchema,
        aiProviderChoice: z
          .enum(['azure_openai_uk', 'disabled'])
          .default('disabled')
          .describe('Configured AI model provider for this tenant'),
        pmsSync: PmsIntegrationSyncConfigSchema.optional().describe(
          'Two-way Finance/PMS synchronisation settings and field mappings',
        ),
      })
      .strict(),
    customFields: z
      .array(CustomFieldConfigEntrySchema)
      .default([])
      .describe('Per-client custom fields, screen locations, and mandatory rules'),
    enabledExtensions: z
      .array(z.string())
      .default([])
      .describe('List of extension IDs enabled for this tenant'),
  })
  .strict();

export function loadAndValidateTenantConfig(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
  environmentOverride?: PlatformEnvironment,
  hostingModeOverride?: HostingMode,
): TenantConfiguration {
  const merged: Record<string, unknown> = {
    ...baseConfig,
    ...environmentOverlay,
    branding: {
      ...(baseConfig.branding as Record<string, unknown> | undefined),
      ...(environmentOverlay.branding as Record<string, unknown> | undefined),
    },
    featureFlags: {
      ...(baseConfig.featureFlags as Record<string, unknown> | undefined),
      ...(environmentOverlay.featureFlags as Record<string, unknown> | undefined),
    },
    matterCosts: {
      ...(baseConfig.matterCosts as Record<string, unknown> | undefined),
      ...(environmentOverlay.matterCosts as Record<string, unknown> | undefined),
    },
    integrations: {
      ...(baseConfig.integrations as Record<string, unknown> | undefined),
      ...(environmentOverlay.integrations as Record<string, unknown> | undefined),
    },
  };

  if (environmentOverride) {
    merged.environment = environmentOverride;
  }
  if (hostingModeOverride) {
    merged.hostingMode = hostingModeOverride;
  }

  return TenantConfigurationSchema.parse(merged);
}
