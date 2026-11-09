/**
 * Schema-validated tenant configuration engine (`core/src/config-engine/`).
 *
 * Rules enforced:
 * - Every configuration option has a type, default, description, and validation.
 * - Unknown keys are rejected (`.strict()`).
 * - Secrets are referenced by Key Vault URI/name only; raw secrets are rejected.
 */

import { z } from 'zod';
import keyDatesJsonSchema from '../../schemas/keyDates.config.schema.json';
import tenantConfigJsonSchema from '../../schemas/tenant-config.schema.json';
import type {
  DocumentGenerationConfig,
  DocumentPermission,
  DocumentStoreConfig,
  ExtensionManifest,
  HomeRoleKey,
  HostingMode,
  KeyDatesConfiguration,
  MatterFolderTemplateNode,
  PermissionKey,
  PlatformEnvironment,
  RbacConfiguration,
  TenantConfiguration,
} from '../api/index';
import {
  findUnknownPathTokens,
  validateMatterFolderTemplatesConfig,
} from '../domain/documents/index';
import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_PERMISSION_KEYS,
  createDefaultRbacConfig,
  DEFAULT_RBAC_IDENTITY_MAPPING,
  DEFAULT_RBAC_RELATIONSHIP_GRANTS,
} from '../domain/rbac/registry';
import { RESERVED_UNSUPPORTED_DOCUMENT_STORE_PROVIDERS } from '../integrations/document-stores/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../tenancy/keyVaultSecrets';

export const ALL_HOME_ROLE_KEYS: readonly HomeRoleKey[] = ALL_BUILTIN_ROLE_KEYS;

export const DEFAULT_DOCUMENT_PERMISSION_ROLES: Record<
  DocumentPermission,
  HomeRoleKey[]
> = {
  'document_template:view': [...ALL_HOME_ROLE_KEYS],
  'document_template:build': ['admin', 'managing_partner'],
  'document_template:approve': ['admin', 'managing_partner', 'risk_compliance'],
  'document_template:view_usage': [
    'admin',
    'managing_partner',
    'risk_compliance',
    'partner',
  ],
  'document_template:view_usage_by_user': ['admin', 'managing_partner'],
  'document_template:configure': ['admin', 'managing_partner', 'risk_compliance'],
  'document:generate': [...ALL_HOME_ROLE_KEYS],
  'document:view': [...ALL_HOME_ROLE_KEYS],
  'document:download': [...ALL_HOME_ROLE_KEYS],
  'document:upload': [
    'fee_earner',
    'supervisor',
    'partner',
    'legal_secretary',
    'intake',
    'enquiries_coordinator',
    'risk_compliance',
    'managing_partner',
    'admin',
  ],
  'document:edit': [
    'fee_earner',
    'supervisor',
    'partner',
    'legal_secretary',
    'risk_compliance',
    'managing_partner',
    'admin',
  ],
  'document:delete': ['partner', 'risk_compliance', 'managing_partner', 'admin'],
  'document:provision': [
    'supervisor',
    'partner',
    'risk_compliance',
    'managing_partner',
    'admin',
  ],
  'document_store:configure': ['admin'],
  'document_access:review': ['risk_compliance', 'managing_partner', 'admin'],
  'finance:view': ['finance', 'partner', 'managing_partner', 'admin'],
};

export const DEFAULT_DOCUMENT_GENERATION_CONFIG: DocumentGenerationConfig = {
  enabled: true,
  maxTemplateSizeMb: 10,
  defaultOutputFormat: 'docx',
  allowUserFormatOverride: true,
  storageProvider: 'local-fs',
  approval: {
    requireApproval: true,
    allowSelfApproval: false,
  },
  usage: {
    retentionMonths: 24,
    lowUseThreshold: 5,
    showUserLevelDetail: true,
  },
  permissions: {
    roleDefaults: {
      'document_template:view': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:view'],
      ],
      'document_template:build': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:build'],
      ],
      'document_template:approve': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:approve'],
      ],
      'document_template:view_usage': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:view_usage'],
      ],
      'document_template:view_usage_by_user': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES[
          'document_template:view_usage_by_user'
        ],
      ],
      'document:generate': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:generate'],
      ],
      'document:view': [...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:view']],
      'document:delete': [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:delete'],
      ],
      'finance:view': [...DEFAULT_DOCUMENT_PERMISSION_ROLES['finance:view']],
    },
  },
  customDocumentTypes: [],
};

const HomeRoleKeySchema = z.enum([
  'fee_earner',
  'supervisor',
  'partner',
  'legal_secretary',
  'intake',
  'enquiries_coordinator',
  'finance',
  'risk_compliance',
  'managing_partner',
  'admin',
]);

export const PermissionKeySchema = z.enum(
  ALL_PERMISSION_KEYS as unknown as [PermissionKey, ...PermissionKey[]],
);

const DocumentRoleDefaultsSchema = z
  .object({
    'document_template:view': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:view'],
      ])
      .describe(
        'Deprecated: use rbac.roles instead. Roles permitted to view document templates.',
      ),
    'document_template:build': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:build'],
      ])
      .describe(
        'Roles permitted to upload templates, map fields, preview, submit for approval, and import/export template packages',
      ),
    'document_template:approve': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:approve'],
      ])
      .describe(
        'Roles permitted to approve, reject, retire, and roll back template versions',
      ),
    'document_template:view_usage': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document_template:view_usage'],
      ])
      .describe(
        'Roles permitted to view template usage reports at template, practice area, and team level',
      ),
    'document_template:view_usage_by_user': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES[
          'document_template:view_usage_by_user'
        ],
      ])
      .describe(
        'Roles permitted to view template usage broken down by named user (when showUserLevelDetail is also enabled)',
      ),
    'document:generate': z
      .array(HomeRoleKeySchema)
      .default(() => [
        ...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:generate'],
      ])
      .describe(
        'Roles permitted to generate documents from active templates they have access to',
      ),
    'document:view': z
      .array(HomeRoleKeySchema)
      .default(() => [...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:view']])
      .describe(
        'Roles permitted to view and download generated documents on accessible records',
      ),
    'document:delete': z
      .array(HomeRoleKeySchema)
      .default(() => [...DEFAULT_DOCUMENT_PERMISSION_ROLES['document:delete']])
      .describe('Roles permitted to delete generated documents'),
    'finance:view': z
      .array(HomeRoleKeySchema)
      .default(() => [...DEFAULT_DOCUMENT_PERMISSION_ROLES['finance:view']])
      .describe(
        'Roles permitted to read Financial-group merge fields in templates and generated documents',
      ),
  })
  .strict();

export const DocumentGenerationConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe('Master feature flag enabling the document generation module'),
    maxTemplateSizeMb: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum allowed upload size for .docx templates in MiB'),
    defaultOutputFormat: z
      .enum(['docx', 'pdf'])
      .default('docx')
      .describe('Default output format when generating documents'),
    allowUserFormatOverride: z
      .boolean()
      .default(true)
      .describe(
        'Whether users can switch between .docx and .pdf output at generation time',
      ),
    storageProvider: z
      .enum(['local-fs', 'azure-blob', 'sharepoint', 'imanage', 'netdocuments'])
      .default('local-fs')
      .describe(
        'Configured document storage provider (local-fs temporary tenant storage by default, switchable to azure-blob or DMS)',
      ),
    approval: z
      .object({
        requireApproval: z
          .boolean()
          .default(true)
          .describe(
            'Whether submitted template versions require approval before becoming Active',
          ),
        allowSelfApproval: z
          .boolean()
          .default(false)
          .describe(
            'Whether a builder who also holds document_template:approve may approve their own submitted template version',
          ),
      })
      .strict()
      .default(() => ({
        requireApproval: true,
        allowSelfApproval: false,
      })),
    usage: z
      .object({
        retentionMonths: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(24)
          .describe(
            'Number of months to retain template usage events and daily summaries [x-reserved:S0-19]',
          ),
        lowUseThreshold: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(5)
          .describe(
            'Generation count threshold below which active templates are flagged as retirement candidates',
          ),
        showUserLevelDetail: z
          .boolean()
          .default(true)
          .describe(
            'Whether usage reports may show named-user breakdowns to holders of document_template:view_usage_by_user',
          ),
      })
      .strict()
      .default(() => ({
        retentionMonths: 24,
        lowUseThreshold: 5,
        showUserLevelDetail: true,
      })),
    permissions: z
      .object({
        roleDefaults: DocumentRoleDefaultsSchema.default(() => ({
          ...DEFAULT_DOCUMENT_PERMISSION_ROLES,
        })),
      })
      .strict()
      .default(() => ({
        roleDefaults: { ...DEFAULT_DOCUMENT_PERMISSION_ROLES },
      })),
    customDocumentTypes: z
      .array(
        z
          .object({
            key: z.string().min(1).describe('Document type key'),
            label: z.string().min(1).describe('Document type display label'),
          })
          .strict(),
      )
      .default([])
      .describe(
        'Additional tenant-configured document classification types beyond core defaults [x-reserved:backlog]',
      ),
  })
  .strict();

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
    label: z
      .string()
      .min(1)
      .describe('Display label for the custom fee-earner grade'),
    hourlyRateGbp: z
      .number()
      .nonnegative()
      .describe('Standard hourly rate in GBP'),
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
    partnerRateGbp: z
      .number()
      .nonnegative()
      .default(350)
      .describe('Partner hourly rate in GBP'),
    associateRateGbp: z
      .number()
      .nonnegative()
      .default(250)
      .describe('Associate hourly rate in GBP'),
    traineeRateGbp: z
      .number()
      .nonnegative()
      .default(145)
      .describe('Trainee hourly rate in GBP'),
    customGrades: z
      .array(CustomGradeSchema)
      .default([])
      .describe('Optional additional fee-earner grade rates'),
    active: z
      .boolean()
      .default(true)
      .describe('Whether this rate card is active'),
  })
  .strict();

const DisbursementPresetSchema = z
  .object({
    id: z.string().min(1).describe('Disbursement preset identifier'),
    description: z.string().min(1).describe('Disbursement line description'),
    defaultAmountGbp: z
      .number()
      .nonnegative()
      .default(0)
      .describe('Default amount in GBP'),
    practiceAreaKey: z
      .string()
      .nullable()
      .default(null)
      .describe('Optional practice area key restriction'),
    vatApplicable: z
      .boolean()
      .default(true)
      .describe('Whether standard UK VAT applies'),
  })
  .strict();

const CustomFieldConfigEntrySchema = z
  .object({
    id: z.string().min(1).describe('Unique custom field identifier'),
    recordType: z
      .enum(['enquiry', 'person', 'organisation', 'matter', 'quote', 'task'])
      .describe('Target screen / record type for this custom field'),
    label: z
      .string()
      .min(1)
      .describe('Display label shown on the form and profile'),
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
      .describe(
        'Location / section key on the target screen where this field is rendered',
      ),
    required: z
      .boolean()
      .default(false)
      .describe(
        'Whether the client requires this field to be completed before saving/routing',
      ),
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
      .enum([
        'client_organisation',
        'client_person',
        'matter',
        'fee_estimate',
        'employee',
      ])
      .describe('Target entity type for the cross-system mapping'),
    onesquaredFieldKey: z
      .string()
      .min(1)
      .describe(
        '1Squared field key (core property, CORE-xxx code, or customField id)',
      ),
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
      .describe(
        '[x-reserved:S0-18] Whether PMS / Finance DB synchronisation is enabled for this tenant (reserved for live tenant-scoped PMS synchronisation in S0-18)',
      ),
    providerKey: z
      .string()
      .min(1)
      .default('generic_sql')
      .describe(
        '[x-reserved:S0-18] Identifier of the connected PMS / Finance adapter (reserved for S0-18)',
      ),
    syncMode: z
      .enum(['read_only', 'two_way'])
      .default('two_way')
      .describe(
        '[x-reserved:S0-18] Whether integration is read-only inbound or two-way (reserved for S0-18)',
      ),
    matterCodeAllocation: z
      .enum(['onesquared', 'pms_on_open'])
      .default('onesquared')
      .describe(
        '[x-reserved:S0-18] System responsible for allocating canonical matter numbers (reserved for S0-18)',
      ),
    clientCodeAllocation: z
      .enum(['onesquared', 'pms_on_open'])
      .default('onesquared')
      .describe(
        '[x-reserved:S0-18] System responsible for allocating canonical client codes (reserved for S0-18)',
      ),
    pollIntervalMinutes: z
      .number()
      .int()
      .positive()
      .default(15)
      .describe(
        '[x-reserved:S0-18] Inbound delta sync polling interval in minutes (reserved for S0-18)',
      ),
    fieldMappings: z
      .array(PmsFieldMappingEntrySchema)
      .default([])
      .describe(
        '[x-reserved:S0-18] Field-level mappings and System-of-Record ownership rules (reserved for S0-18)',
      ),
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
      .describe(
        'Deployment tenancy mode (Model A single_tenant or Model B multi_tenant)',
      ),
    environment: z
      .enum(['dev', 'test', 'training', 'demo', 'live'])
      .default('dev')
      .describe('Target deployment environment'),
    branding: z
      .object({
        primaryDomain: z
          .string()
          .min(1)
          .describe('Verified primary domain for the tenant'),
        accentColorHex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#1f6feb')
          .describe(
            '[x-reserved:backlog] Primary brand accent hex colour (reserved for backlog F21 tenant branding theme rendering; the demo tenant uses the standard platform theme)',
          ),
        logoAssetKey: z
          .string()
          .default('default-logo.svg')
          .describe(
            '[x-reserved:backlog] Tenant-scoped asset key for the firm logo (reserved for backlog F21 tenant firm logo rendering; the demo tenant uses the standard platform logo)',
          ),
        contactEmail: z
          .string()
          .default('')
          .optional()
          .describe(
            'Deprecated: use firm.contactEmail instead. Optional public contact email address for document headers and footers',
          ),
        website: z
          .string()
          .default('')
          .optional()
          .describe(
            'Deprecated: use firm.website instead. Optional public website URL or hostname for document headers and footers',
          ),
      })
      .strict(),
    firm: z
      .object({
        contactEmail: z
          .union([
            z.literal(''),
            z
              .string()
              .email()
              .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
          ])
          .default('')
          .describe(
            'Public firm contact email address for document headers and footers (blank if not set)',
          ),
        website: z
          .string()
          .regex(
            /^$|^(https?:\/\/)?[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\/\S*)?$/,
            'Invalid website hostname or URL',
          )
          .default('')
          .describe(
            'Public firm website URL or hostname for document headers and footers (blank if not set)',
          ),
      })
      .strict()
      .default({
        contactEmail: '',
        website: '',
      })
      .optional()
      .describe('Firm contact details for generated documents'),
    conflictReview: z
      .object({
        assigneeTeamKey: z
          .string()
          .min(1)
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,
            'Invalid assigneeTeamKey format',
          )
          .nullable()
          .default(null)
          .describe(
            'Stable team ID or organisation team code of the team that receives referred conflict reviews',
          ),
        assigneeRoleKey: z
          .string()
          .min(1)
          .regex(
            /^[a-z][a-z0-9_.:-]{1,63}$/,
            'Invalid assigneeRoleKey format',
          )
          .nullable()
          .default(null)
          .describe(
            'Optional role key or employee_role.* key used to pick an assignee within the team',
          ),
      })
      .strict()
      .default({
        assigneeTeamKey: null,
        assigneeRoleKey: null,
      })
      .optional()
      .describe(
        'Routing configuration for referred matter conflict review tasks',
      ),
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
        enableDemoMode: z
          .boolean()
          .default(false)
          .describe(
            'Enable Demo Mode user switching for designated demo personas in non-live environments',
          ),
      })
      .strict(),
    matterCosts: z
      .object({
        rateSourceMode: z
          .enum(['application_table', 'pms_when_linked'])
          .default('pms_when_linked')
          .describe(
            '[x-reserved:S0-23] Source of default fee-earner hourly rates (reserved for unifying tenant-level and runtime-store matter costs configuration in S0-23)',
          ),
        allowMatterRateOverrides: z
          .boolean()
          .default(true)
          .describe(
            '[x-reserved:S0-23] Whether fee earners can override standard rates on a matter (reserved for S0-23)',
          ),
        partnerSignOffThresholdGbp: z
          .number()
          .nonnegative()
          .default(25000)
          .describe(
            '[x-reserved:S0-23] Fee estimate or cap threshold in GBP requiring Partner cost sign-off (reserved for S0-23)',
          ),
        rateCards: z
          .array(RateCardEntrySchema)
          .default([])
          .describe(
            '[x-reserved:S0-23] Tenant-level rate cards (reserved for S0-23)',
          ),
        disbursementPresets: z
          .array(DisbursementPresetSchema)
          .default([])
          .describe(
            '[x-reserved:S0-23] Tenant-level disbursement presets (reserved for S0-23)',
          ),
      })
      .strict(),
    integrations: z
      .object({
        pmsConnectionSecretVaultRef: KeyVaultRefSchema.describe(
          '[x-reserved:S0-18] Key Vault reference for live PMS database connection secret resolution (reserved for S0-18)',
        ),
        companiesHouseApiKeyVaultRef: KeyVaultRefSchema.describe(
          '[x-reserved:S0-18] Key Vault reference for live Companies House API integration (reserved for S0-18)',
        ),
        aiProviderChoice: z
          .enum(['azure_openai_uk', 'anthropic', 'disabled'])
          .default('disabled')
          .describe('Configured AI model provider for this tenant'),
        pmsSync: PmsIntegrationSyncConfigSchema.optional().describe(
          '[x-reserved:S0-18] Two-way Finance/PMS synchronisation settings and field mappings (reserved for S0-18)',
        ),
      })
      .strict(),
    customFields: z
      .array(CustomFieldConfigEntrySchema)
      .default([])
      .describe(
        '[x-reserved:S0-17] Per-client custom fields, screen locations, and mandatory rules (reserved for S0-17)',
      ),
    enabledExtensions: z
      .array(z.string())
      .default([])
      .describe('List of extension IDs enabled for this tenant'),
    documentGeneration: DocumentGenerationConfigSchema.default(() => ({
      ...DEFAULT_DOCUMENT_GENERATION_CONFIG,
      approval: { ...DEFAULT_DOCUMENT_GENERATION_CONFIG.approval },
      usage: { ...DEFAULT_DOCUMENT_GENERATION_CONFIG.usage },
      permissions: {
        roleDefaults: { ...DEFAULT_DOCUMENT_PERMISSION_ROLES },
      },
      customDocumentTypes: [],
    })).describe(
      'Document generation feature configuration, storage provider, approval workflow, and usage reporting',
    ),
    rbac: z
      .object({
        roles: z
          .record(
            z.string().regex(/^[a-z0-9_]+$/),
            z
              .object({
                key: z
                  .string()
                  .regex(/^[a-z0-9_]+$/)
                  .describe('Stable role key identifier'),
                label: z
                  .string()
                  .min(1)
                  .describe('Human-readable display label for the role'),
                shortLabel: z
                  .string()
                  .optional()
                  .describe('Optional compact label for badges and selectors'),
                description: z
                  .string()
                  .optional()
                  .describe('Description of the role purpose'),
                isBuiltIn: z
                  .boolean()
                  .optional()
                  .describe('Whether the role is a core built-in role'),
                permissions: z
                  .array(PermissionKeySchema)
                  .describe(
                    'Registered PermissionKey strings granted to this role',
                  ),
              })
              .strict(),
          )
          .default(() => createDefaultRbacConfig().roles)
          .describe(
            'Built-in and tenant-defined custom roles mapped to canonical core permissions',
          ),
        departmentGrants: z
          .record(z.string().min(1), z.array(PermissionKeySchema))
          .default({})
          .describe(
            'Tenant department ID mapped to additional core permissions (replaces hardcoded DEPT-* checks)',
          ),
        relationshipGrants: z
          .array(
            z
              .object({
                relationship: z
                  .enum([
                    'is_team_lead_of_any_team',
                    'is_team_lead_of_target_team',
                    'is_line_manager_of_target',
                    'is_supporting_target_fee_earner',
                  ])
                  .describe('Relationship rule identifier'),
                permissions: z
                  .array(PermissionKeySchema)
                  .describe('Permissions granted when the relationship holds'),
                description: z
                  .string()
                  .optional()
                  .describe('Human-readable explanation of the rule'),
              })
              .strict(),
          )
          .default(() =>
            DEFAULT_RBAC_RELATIONSHIP_GRANTS.map((r) => ({
              ...r,
              permissions: [...r.permissions],
            })),
          )
          .describe('Permissions granted by organisational relationship'),
        identityMapping: z
          .object({
            authorityMode: z
              .enum(['token_only', 'hybrid', 'store_only'])
              .default(DEFAULT_RBAC_IDENTITY_MAPPING.authorityMode)
              .describe(
                'Source of truth for user role membership (token_only for federated Entra ID, hybrid, or store_only)',
              ),
            entraGroupToRoleKey: z
              .record(z.string().min(1), z.array(z.string().min(1)))
              .default({})
              .describe(
                'Mapping of Entra ID group object IDs to tenant role keys',
              ),
            entraAppRoleToRoleKey: z
              .record(z.string().min(1), z.array(z.string().min(1)))
              .default(() => ({
                ...DEFAULT_RBAC_IDENTITY_MAPPING.entraAppRoleToRoleKey,
              }))
              .describe(
                'Mapping of Entra ID app-role claim values to tenant role keys',
              ),
            requireMfaForAdminPermissions: z
              .boolean()
              .default(true)
              .describe(
                'Whether permissions marked requiresMfa in PERMISSION_REGISTRY require mfaVerified=true on TenantContext',
              ),
            defaultRoleKeys: z
              .array(z.string().min(1))
              .default([])
              .describe(
                'Role keys assigned to newly provisioned Entra ID users who have no mapped App Roles or Group claims',
              ),
            allowAcrsC1AsMfa: z
              .boolean()
              .default(false)
              .describe(
                'Whether to accept Authentication Context Class Reference acrs=c1 as satisfying MFA',
              ),
            emailLinking: z
              .object({
                enabled: z
                  .boolean()
                  .default(true)
                  .describe(
                    'Whether unbound non-privileged employee records may be linked by a verified directory sign-in address on first sign-in. When false, only explicit oid bindings are used.',
                  ),
                domains: z
                  .array(
                    z
                      .string()
                      .regex(
                        /^[a-z0-9.-]+\.[a-z]{2,}$/,
                        'Each emailLinking domain must be a valid lower-case domain name (e.g. "firm.co.uk")',
                      ),
                  )
                  .default([])
                  .describe(
                    "Allowed lower-case domain names for automatic email linking. An empty array means the tenant's branding.primaryDomain only.",
                  ),
              })
              .strict()
              .default({
                enabled: true,
                domains: [],
              })
              .describe(
                'Controls automatic sign-in linking by verified directory email domain for unbound employee records.',
              ),
          })
          .strict()
          .default(() => ({
            ...DEFAULT_RBAC_IDENTITY_MAPPING,
            entraGroupToRoleKey: {
              ...DEFAULT_RBAC_IDENTITY_MAPPING.entraGroupToRoleKey,
            },
            entraAppRoleToRoleKey: {
              ...DEFAULT_RBAC_IDENTITY_MAPPING.entraAppRoleToRoleKey,
            },
            defaultRoleKeys: [...(DEFAULT_RBAC_IDENTITY_MAPPING.defaultRoleKeys ?? [])],
            allowAcrsC1AsMfa: DEFAULT_RBAC_IDENTITY_MAPPING.allowAcrsC1AsMfa ?? false,
            emailLinking: {
              enabled: DEFAULT_RBAC_IDENTITY_MAPPING.emailLinking?.enabled ?? true,
              domains: [...(DEFAULT_RBAC_IDENTITY_MAPPING.emailLinking?.domains ?? [])],
            },
          })),
      })
      .strict()
      .superRefine((rbacVal, ctx) => {
        const definedRoleKeys = new Set(Object.keys(rbacVal.roles));
        for (const [groupId, mappedRoles] of Object.entries(
          rbacVal.identityMapping.entraGroupToRoleKey,
        )) {
          for (const rk of mappedRoles) {
            if (!definedRoleKeys.has(rk)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['identityMapping', 'entraGroupToRoleKey', groupId],
                message: `Unknown role key '${rk}' in entraGroupToRoleKey; must exist in rbac.roles`,
              });
            }
          }
        }
        for (const [appRole, mappedRoles] of Object.entries(
          rbacVal.identityMapping.entraAppRoleToRoleKey,
        )) {
          for (const rk of mappedRoles) {
            if (!definedRoleKeys.has(rk)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['identityMapping', 'entraAppRoleToRoleKey', appRole],
                message: `Unknown role key '${rk}' in entraAppRoleToRoleKey; must exist in rbac.roles`,
              });
            }
          }
        }
      })
      .default(() => {
        const def = createDefaultRbacConfig();
        return {
          ...def,
          identityMapping: {
            ...def.identityMapping,
            defaultRoleKeys: def.identityMapping.defaultRoleKeys ?? [],
            allowAcrsC1AsMfa: def.identityMapping.allowAcrsC1AsMfa ?? false,
            emailLinking: {
              enabled: def.identityMapping.emailLinking?.enabled ?? true,
              domains: [...(def.identityMapping.emailLinking?.domains ?? [])],
            },
          },
        };
      })
      .describe(
        'Central configuration-driven RBAC: role definitions, department grants, relationship grants, and Entra ID identity mapping',
      ),
    documentStores: z
      .array(
        z
          .object({
            storeId: z
              .string()
              .min(1)
              .describe('Unique document store identifier within the tenant'),
            displayName: z
              .string()
              .min(1)
              .describe('Human-readable display name for the document store'),
            providerType: z
              .enum(['sharepoint', 'azure_blob', 'imanage', 'netdocuments'])
              .describe(
                'External document store provider type (sharepoint supported in Phase 1; azure_blob, imanage, netdocuments reserved)',
              ),
            isDefault: z
              .boolean()
              .default(false)
              .describe(
                'Whether this store is the default store for the tenant (at most one store may be default)',
              ),
            enabled: z
              .boolean()
              .default(true)
              .describe('Whether this document store connection is enabled'),
            auth: z
              .object({
                entraTenantId: z
                  .string()
                  .min(1)
                  .describe(
                    'Target firm Microsoft Entra ID directory tenant GUID or domain',
                  ),
                credentialMode: z
                  .enum(['client_certificate', 'managed_identity'])
                  .default('client_certificate')
                  .describe(
                    'Application provisioning credential mode (client_certificate from Key Vault or managed_identity)',
                  ),
                clientId: z
                  .string()
                  .min(1)
                  .optional()
                  .describe(
                    'Entra ID application registration client ID for OBO and app-only Sites.Selected access',
                  ),
                certificateKeyVaultSecretRef: KeyVaultRefSchema.optional().describe(
                  'Key Vault reference (kv://<vault>/<secret>) holding the application certificate credential',
                ),
                managedIdentityClientId: z
                  .string()
                  .min(1)
                  .optional()
                  .describe(
                    'Optional user-assigned Managed Identity client ID for Model A hosting',
                  ),
                delegatedPermissionScope: z
                  .enum(['Files.ReadWrite.All', 'Sites.Selected'])
                  .default('Files.ReadWrite.All')
                  .describe(
                    'Delegated Microsoft Graph permission scope requested during On-Behalf-Of user token exchange',
                  ),
              })
              .strict()
              .describe('Authentication settings for delegated OBO and application provisioning'),
            sharepoint: z
              .object({
                hostname: z
                  .string()
                  .min(3)
                  .describe(
                    'SharePoint Online hostname (for example contoso.sharepoint.com)',
                  ),
                siteRelativePath: z
                  .string()
                  .regex(
                    /^\/(sites|teams)\/[A-Za-z0-9._-]+$/,
                    'siteRelativePath must start with /sites/ or /teams/',
                  )
                  .describe(
                    'SharePoint site relative path (for example /sites/PracticeRepository)',
                  ),
                siteId: z
                  .string()
                  .min(1)
                  .optional()
                  .describe('Resolved Microsoft Graph site ID'),
                libraries: z
                  .array(
                    z
                      .object({
                        libraryId: z
                          .string()
                          .min(1)
                          .describe('Stable internal library identifier'),
                        displayName: z
                          .string()
                          .min(1)
                          .describe('Document library display name in SharePoint'),
                        libraryUrlSegment: z
                          .string()
                          .min(1)
                          .describe(
                            'URL path segment of the document library under the site',
                          ),
                        driveId: z
                          .string()
                          .min(1)
                          .optional()
                          .describe('Resolved Microsoft Graph drive ID'),
                      })
                      .strict(),
                  )
                  .min(1)
                  .describe('Configured document libraries in this SharePoint site'),
              })
              .strict()
              .optional()
              .describe('SharePoint-specific site and library configuration'),
          })
          .strict(),
      )
      .optional()
      .describe(
        'Configured external document stores for the tenant (multi-store supported with at most one default)',
      ),
    documentRouting: z
      .array(
        z
          .object({
            ruleId: z
              .string()
              .min(1)
              .optional()
              .describe('Optional routing rule identifier'),
            match: z
              .union([
                z.literal('default'),
                z
                  .object({
                    departmentId: z.string().min(1).optional(),
                    teamId: z.string().min(1).optional(),
                    workTypeId: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .describe(
                'Ordered match criteria by departmentId, teamId, or workTypeId, or "default" fallback',
              ),
            storeId: z
              .string()
              .min(1)
              .describe('Target document store ID from documentStores'),
            libraryId: z
              .string()
              .min(1)
              .describe('Target document library ID on the selected store'),
            basePath: z
              .string()
              .min(1)
              .default('{departmentCode}/{teamCode}')
              .describe(
                'Base folder path template above the matter folder (supports {departmentCode}, {teamCode}, etc.)',
              ),
          })
          .strict(),
      )
      .optional()
      .describe(
        'Ordered storage routing rules mapping matters to a store, library, and basePath (first match wins)',
      ),
    matterFolderNameTemplate: z
      .string()
      .min(1)
      .default('{matterNumber} - {matterDescription}')
      .optional()
      .describe(
        'Template for naming each matter root folder (default: "{matterNumber} - {matterDescription}")',
      ),
    documentAccess: z
      .object({
        departmentEntraGroups: z
          .record(z.string().min(1), z.string().min(1))
          .default({})
          .describe(
            'Mapping of 1Squared department IDs to Microsoft Entra ID security group object IDs',
          ),
        teamEntraGroups: z
          .record(z.string().min(1), z.string().min(1))
          .default({})
          .describe(
            'Mapping of 1Squared team IDs to Microsoft Entra ID security group object IDs',
          ),
        uniqueScopeWarningThreshold: z
          .number()
          .int()
          .min(100)
          .max(50000)
          .default(4000)
          .optional()
          .describe(
            'Warning threshold for unique permission scopes per library (default: 4000, below SharePoint 5000 recommended limit)',
          ),
        autoRemediateDrift: z
          .boolean()
          .default(false)
          .optional()
          .describe(
            '[x-reserved:S0-25] Whether scheduled permission reconciliation automatically remediates detected drift (default: false; reserved for S0-25)',
          ),
        defaultPolicy: z
          .object({
            libraryRoot: z
              .array(
                z
                  .object({
                    groupId: z.string().min(1),
                    level: z.enum(['none', 'read', 'contribute', 'edit', 'manage']),
                    description: z.string().optional(),
                  })
                  .strict(),
              )
              .default([]),
            owningDepartment: z
              .enum(['none', 'read', 'contribute', 'edit', 'manage'])
              .default('read'),
            owningTeam: z
              .enum(['none', 'read', 'contribute', 'edit', 'manage'])
              .default('edit'),
            otherDepartments: z
              .enum(['none', 'read', 'contribute', 'edit', 'manage'])
              .default('none'),
            matterTeamOutsider: z
              .enum(['none', 'read', 'contribute', 'edit', 'manage'])
              .default('edit'),
            restrictedMatter: z
              .object({
                allowedUserLevel: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('edit'),
                groups: z
                  .array(
                    z
                      .object({
                        groupId: z.string().min(1),
                        level: z.enum([
                          'none',
                          'read',
                          'contribute',
                          'edit',
                          'manage',
                        ]),
                        description: z.string().optional(),
                      })
                      .strict(),
                  )
                  .default([]),
              })
              .strict(),
            closedMatter: z
              .enum(['none', 'read', 'contribute', 'edit', 'manage'])
              .default('read'),
          })
          .strict()
          .optional()
          .describe('Default access policy across all configured document stores'),
        policiesByStore: z
          .record(
            z.string().min(1),
            z
              .object({
                libraryRoot: z
                  .array(
                    z
                      .object({
                        groupId: z.string().min(1),
                        level: z.enum([
                          'none',
                          'read',
                          'contribute',
                          'edit',
                          'manage',
                        ]),
                        description: z.string().optional(),
                      })
                      .strict(),
                  )
                  .default([]),
                owningDepartment: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('read'),
                owningTeam: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('edit'),
                otherDepartments: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('none'),
                matterTeamOutsider: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('edit'),
                restrictedMatter: z
                  .object({
                    allowedUserLevel: z
                      .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                      .default('edit'),
                    groups: z
                      .array(
                        z
                          .object({
                            groupId: z.string().min(1),
                            level: z.enum([
                              'none',
                              'read',
                              'contribute',
                              'edit',
                              'manage',
                            ]),
                            description: z.string().optional(),
                          })
                          .strict(),
                      )
                      .default([]),
                  })
                  .strict(),
                closedMatter: z
                  .enum(['none', 'read', 'contribute', 'edit', 'manage'])
                  .default('read'),
              })
              .strict(),
          )
          .optional()
          .describe('Per-store access policy overrides keyed by storeId'),
      })
      .strict()
      .optional()
      .describe(
        'Inheritance-based document access policy and Entra ID security group mappings for departments and teams',
      ),
    matterFolderTemplates: ((): z.ZodType<
      NonNullable<TenantConfiguration['matterFolderTemplates']>
    > => {
      const AccessOverrideSchema = z
        .object({
          inherit: z.boolean(),
          grants: z
            .array(
              z
                .object({
                  principalType: z.enum(['group', 'user']),
                  principalId: z.string().min(1),
                  level: z.enum(['none', 'read', 'contribute', 'edit', 'manage']),
                })
                .strict(),
            )
            .optional(),
        })
        .strict();

      const FolderNodeSchema: z.ZodType<MatterFolderTemplateNode> = z.lazy(() =>
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            orderPrefix: z.enum(['none', 'two_digit']).optional(),
            access: AccessOverrideSchema.nullable().optional(),
            filingAliases: z.array(z.string().min(1)).optional(),
            children: z.array(FolderNodeSchema).optional(),
          })
          .strict(),
      );

      const OperationSchema = z
        .object({
          op: z.enum(['add', 'remove', 'rename', 'move', 'setAccess']),
          parentPath: z.string().optional(),
          path: z.string().optional(),
          newName: z.string().optional(),
          newParentPath: z.string().optional(),
          node: FolderNodeSchema.optional(),
          access: AccessOverrideSchema.nullable().optional(),
        })
        .strict();

      const TemplateDefSchema = z
        .object({
          templateId: z.string().min(1),
          version: z.number().int().min(1).default(1),
          mode: z.enum(['replaces', 'extends']).default('replaces'),
          description: z.string().optional(),
          nodes: z.array(FolderNodeSchema).optional(),
          operations: z.array(OperationSchema).optional(),
        })
        .strict();

      return z
        .object({
          default: TemplateDefSchema,
          byDepartment: z.record(z.string().min(1), TemplateDefSchema).optional(),
          byWorkType: z.record(z.string().min(1), TemplateDefSchema).optional(),
        })
        .strict();
    })()
      .optional()
      .describe(
        'Versioned matter folder templates with inheritance (workType -> department -> default)',
      ),
    keyDates: (() => {
      const IdSchema = z
        .string()
        .regex(/^[a-z0-9][a-z0-9_.-]{1,63}$/, 'Invalid keyDates ID format');

      const VerificationPolicySchema = z
        .object({
          required: z.boolean().default(false),
          appliesTo: z
            .enum(['all', 'critical_only', 'limitation_only'])
            .default('all'),
        })
        .strict();

      const CalendarSyncPolicySchema = z
        .object({
          enabled: z.boolean().default(true),
        })
        .strict();

      const TriggerFieldSchema = z
        .string()
        .regex(
          /^(accrualDate|dateOfKnowledge|claimantDateOfBirth|dateOfDeath|custom\.[a-zA-Z][a-zA-Z0-9]{0,40})$/,
          'Invalid triggerField',
        );

      const PeriodSchema = z
        .object({
          years: z.number().int().min(0).default(0),
          months: z.number().int().min(0).default(0),
          days: z.number().int().default(0),
        })
        .strict();

      const LimitationRuleSchema = z
        .object({
          id: IdSchema,
          label: z.string().min(1),
          claimType: z
            .string()
            .optional()
            .describe(
              'Optional category or cause-of-action label for the rule [x-reserved:backlog]',
            ),
          guidanceNote: z.string().optional(),
          trigger: z.union([
            z
              .object({
                kind: z.literal('single'),
                field: TriggerFieldSchema,
              })
              .strict(),
            z
              .object({
                kind: z.literal('later_of'),
                fields: z.array(TriggerFieldSchema).min(2),
              })
              .strict(),
          ]),
          period: PeriodSchema,
          countMethod: z
            .enum(['calendar', 'business_days', 'clear_days'])
            .default('calendar'),
          calendarId: z.string().optional(),
          nonWorkingDayAdjustment: z
            .enum(['none', 'next_working_day', 'previous_working_day'])
            .default('none'),
          minorityAdjustment: z
            .object({
              enabled: z.boolean().default(false),
              ageOfMajority: z.number().int().min(16).max(21).default(18),
            })
            .strict()
            .optional(),
          applyStandstillPeriods: z.boolean().default(true),
          longstop: z
            .object({
              field: TriggerFieldSchema,
              period: PeriodSchema,
            })
            .strict()
            .optional(),
        })
        .strict();

      const KeyDatePermissionEnum = z.enum([
        'keydate:view',
        'keydate:view_any_team',
        'keydate:edit',
        'keydate:verify',
        'keydate:resolve',
        'keydate:waive',
        'keydate:override_calculation',
        'keydate:configure',
      ]);

      return z
        .object({
          enabled: z.boolean().default(false),
          defaults: z
            .object({
              verification: VerificationPolicySchema.default({
                required: false,
                appliesTo: 'all',
              }),
              calendarSync: CalendarSyncPolicySchema.default({ enabled: true }),
              reminderScheduleId: z.string().default('standard'),
              teamAssignment: z
                .enum(['matter_owning_team'])
                .default('matter_owning_team')
                .describe(
                  'How the team diary is chosen for a new key date [x-reserved:backlog]',
                ),
            })
            .strict()
            .default({
              verification: { required: false, appliesTo: 'all' },
              calendarSync: { enabled: true },
              reminderScheduleId: 'standard',
              teamAssignment: 'matter_owning_team',
            }),
          keyDateTypes: z
            .array(
              z
                .object({
                  id: IdSchema,
                  label: z.string().min(1).max(100),
                  category: z.enum([
                    'limitation',
                    'court_deadline',
                    'contractual',
                    'undertaking',
                    'compliance',
                    'internal_milestone',
                  ]),
                  defaultCritical: z.boolean().default(false),
                  reminderScheduleId: z.string().optional(),
                  allowManualEntry: z.boolean().default(true),
                  allowCalculation: z.boolean().default(false),
                  active: z.boolean().default(true),
                })
                .strict(),
            )
            .default([]),
          matterTypes: z
            .array(
              z
                .object({
                  matterTypeId: z.string().min(1),
                  requiredKeyDateTypeIds: z.array(z.string()).default([]),
                  allowNotApplicable: z.boolean().default(true),
                  blockClosureWithOpenDates: z.boolean().default(true),
                  defaultRuleSetIds: z
                    .array(z.string())
                    .default([])
                    .describe(
                      'Limitation rule set IDs offered by default for matters of this type [x-reserved:backlog]',
                    ),
                  verification: VerificationPolicySchema.optional(),
                  calendarSync: CalendarSyncPolicySchema.optional(),
                })
                .strict(),
            )
            .default([]),
          reminderSchedules: z
            .array(
              z
                .object({
                  id: IdSchema,
                  label: z.string().min(1),
                  stages: z
                    .array(
                      z
                        .object({
                          daysBefore: z.number().int().min(0).max(730),
                          priority: z
                            .enum(['normal', 'high', 'urgent'])
                            .default('normal'),
                        })
                        .strict(),
                    )
                    .min(1),
                  escalation: z
                    .object({
                      afterUnacknowledgedDays: z
                        .number()
                        .int()
                        .min(1)
                        .default(2),
                      levels: z
                        .array(
                          z
                            .string()
                            .regex(
                              /^(team_leads|role:[a-z_]+)$/,
                              'Escalation level must be "team_leads" or "role:<roleKey>"',
                            ),
                        )
                        .default(['team_leads']),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            )
            .default([
              {
                id: 'standard',
                label: 'Standard',
                stages: [
                  { daysBefore: 90, priority: 'normal' },
                  { daysBefore: 60, priority: 'normal' },
                  { daysBefore: 30, priority: 'high' },
                  { daysBefore: 14, priority: 'high' },
                  { daysBefore: 7, priority: 'urgent' },
                  { daysBefore: 1, priority: 'urgent' },
                  { daysBefore: 0, priority: 'urgent' },
                ],
                escalation: {
                  afterUnacknowledgedDays: 2,
                  levels: ['team_leads', 'role:risk_compliance'],
                },
              },
            ]),
          limitationRuleSets: z
            .array(
              z
                .object({
                  id: IdSchema,
                  version: z.number().int().min(1),
                  label: z.string().min(1),
                  jurisdiction: z.enum([
                    'england_and_wales',
                    'scotland',
                    'northern_ireland',
                    'other',
                  ]),
                  reviewStatus: z
                    .enum(['unreviewed', 'reviewed'])
                    .default('unreviewed'),
                  reviewedBy: z.string().optional(),
                  reviewedOn: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
                    .optional(),
                  rules: z.array(LimitationRuleSchema).min(1),
                })
                .strict(),
            )
            .default([]),
          businessCalendars: z
            .array(
              z
                .object({
                  id: IdSchema,
                  label: z.string().min(1),
                  weekendDays: z
                    .array(z.number().int().min(0).max(6))
                    .default([0, 6]),
                  nonWorkingDates: z
                    .array(
                      z
                        .string()
                        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
                    )
                    .default([]),
                  source: z.enum(['manual', 'imported']).default('manual'),
                })
                .strict(),
            )
            .default([]),
          calendarSync: z
            .object({
              provider: z
                .enum(['microsoft_graph'])
                .default('microsoft_graph')
                .describe(
                  'External calendar provider adapter [x-reserved:backlog]',
                ),
              targets: z
                .array(z.enum(['responsible_persons', 'team_calendar']))
                .default(['responsible_persons']),
              eventTitleTemplate: z
                .string()
                .default('{{matterReference}} – {{keyDateTypeLabel}}'),
              includeMatterDescription: z.boolean().default(false),
              statusesToSync: z
                .array(
                  z.enum(['provisional', 'awaiting_verification', 'confirmed']),
                )
                .default(['confirmed']),
              teamCalendarMappings: z
                .array(
                  z
                    .object({
                      teamId: z.string().min(1),
                      groupId: z.string().min(1),
                    })
                    .strict(),
                )
                .default([]),
            })
            .strict()
            .default({
              provider: 'microsoft_graph',
              targets: ['responsible_persons'],
              eventTitleTemplate: '{{matterReference}} – {{keyDateTypeLabel}}',
              includeMatterDescription: false,
              statusesToSync: ['confirmed'],
              teamCalendarMappings: [],
            }),
          exceptions: z
            .object({
              verificationOverdueDays: z.number().int().min(1).default(3),
              criticalNoActivityDays: z.number().int().min(1).default(30),
              criticalNoActivityWindowDays: z.number().int().min(1).default(90),
            })
            .strict()
            .default({
              verificationOverdueDays: 3,
              criticalNoActivityDays: 30,
              criticalNoActivityWindowDays: 90,
            }),
          permissions: z
            .object({
              roleGrants: z
                .record(
                  z.string().regex(/^[a-z_]+$/),
                  z.array(KeyDatePermissionEnum),
                )
                .default({
                  fee_earner: [
                    'keydate:view',
                    'keydate:edit',
                    'keydate:resolve',
                  ],
                  legal_secretary: ['keydate:view', 'keydate:edit'],
                  partner: [
                    'keydate:view',
                    'keydate:edit',
                    'keydate:verify',
                    'keydate:resolve',
                    'keydate:waive',
                    'keydate:override_calculation',
                  ],
                  team_lead: [
                    'keydate:view',
                    'keydate:edit',
                    'keydate:verify',
                    'keydate:resolve',
                    'keydate:waive',
                  ],
                  risk_compliance: [
                    'keydate:view',
                    'keydate:view_any_team',
                    'keydate:verify',
                  ],
                  managing_partner: [
                    'keydate:view',
                    'keydate:view_any_team',
                    'keydate:edit',
                    'keydate:verify',
                    'keydate:resolve',
                    'keydate:waive',
                    'keydate:override_calculation',
                  ],
                  admin: [
                    'keydate:view',
                    'keydate:view_any_team',
                    'keydate:configure',
                  ],
                }),
            })
            .strict()
            .default({
              roleGrants: {
                fee_earner: ['keydate:view', 'keydate:edit', 'keydate:resolve'],
                legal_secretary: ['keydate:view', 'keydate:edit'],
                partner: [
                  'keydate:view',
                  'keydate:edit',
                  'keydate:verify',
                  'keydate:resolve',
                  'keydate:waive',
                  'keydate:override_calculation',
                ],
                team_lead: [
                  'keydate:view',
                  'keydate:edit',
                  'keydate:verify',
                  'keydate:resolve',
                  'keydate:waive',
                ],
                risk_compliance: [
                  'keydate:view',
                  'keydate:view_any_team',
                  'keydate:verify',
                ],
                managing_partner: [
                  'keydate:view',
                  'keydate:view_any_team',
                  'keydate:edit',
                  'keydate:verify',
                  'keydate:resolve',
                  'keydate:waive',
                  'keydate:override_calculation',
                ],
                admin: [
                  'keydate:view',
                  'keydate:view_any_team',
                  'keydate:configure',
                ],
              },
            }),
        })
        .strict();
    })()
      .default({
        enabled: false,
        defaults: {
          verification: { required: false, appliesTo: 'all' },
          calendarSync: { enabled: true },
          reminderScheduleId: 'standard',
          teamAssignment: 'matter_owning_team',
        },
        keyDateTypes: [],
        matterTypes: [],
        reminderSchedules: [
          {
            id: 'standard',
            label: 'Standard',
            stages: [
              { daysBefore: 90, priority: 'normal' },
              { daysBefore: 60, priority: 'normal' },
              { daysBefore: 30, priority: 'high' },
              { daysBefore: 14, priority: 'high' },
              { daysBefore: 7, priority: 'urgent' },
              { daysBefore: 1, priority: 'urgent' },
              { daysBefore: 0, priority: 'urgent' },
            ],
            escalation: {
              afterUnacknowledgedDays: 2,
              levels: ['team_leads', 'role:risk_compliance'],
            },
          },
        ],
        limitationRuleSets: [],
        businessCalendars: [],
        calendarSync: {
          provider: 'microsoft_graph',
          targets: ['responsible_persons'],
          eventTitleTemplate: '{{matterReference}} – {{keyDateTypeLabel}}',
          includeMatterDescription: false,
          statusesToSync: ['confirmed'],
          teamCalendarMappings: [],
        },
        exceptions: {
          verificationOverdueDays: 3,
          criticalNoActivityDays: 30,
          criticalNoActivityWindowDays: 90,
        },
        permissions: {
          roleGrants: {
            fee_earner: ['keydate:view', 'keydate:edit', 'keydate:resolve'],
            legal_secretary: ['keydate:view', 'keydate:edit'],
            partner: [
              'keydate:view',
              'keydate:edit',
              'keydate:verify',
              'keydate:resolve',
              'keydate:waive',
              'keydate:override_calculation',
            ],
            team_lead: [
              'keydate:view',
              'keydate:edit',
              'keydate:verify',
              'keydate:resolve',
              'keydate:waive',
            ],
            risk_compliance: [
              'keydate:view',
              'keydate:view_any_team',
              'keydate:verify',
            ],
            managing_partner: [
              'keydate:view',
              'keydate:view_any_team',
              'keydate:edit',
              'keydate:verify',
              'keydate:resolve',
              'keydate:waive',
              'keydate:override_calculation',
            ],
            admin: [
              'keydate:view',
              'keydate:view_any_team',
              'keydate:configure',
            ],
          },
        },
      })
      .describe('Key dates and limitation module configuration'),
    keyVault: z
      .object({
        vaultName: z
          .string()
          .regex(
            /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/,
            'keyVault.vaultName must be a valid 3-24 character Azure Key Vault name',
          )
          .optional()
          .describe(
            'Deployed per-tenant Azure Key Vault name (output keyVaultName from core/infra/modules/tenant.bicep)',
          ),
        vaultUri: z
          .string()
          .regex(
            /^https:\/\/[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]\.vault\.azure\.net\/?$/i,
            'keyVault.vaultUri must be formatted as https://<vault>.vault.azure.net/',
          )
          .optional()
          .describe(
            'Deployed per-tenant Azure Key Vault URI (output keyVaultUri from core/infra/modules/tenant.bicep)',
          ),
      })
      .strict()
      .optional()
      .describe(
        'Optional per-tenant Azure Key Vault deployment outputs bound from tenant.bicep (R413)',
      ),
    database: z
      .object({
        dedicatedServerHost: z
          .string()
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$/,
            'database.dedicatedServerHost must be a valid hostname',
          )
          .optional()
          .describe(
            'Optional dedicated PostgreSQL server FQDN for tenants requiring a dedicated Flexible Server or CMK (ADR 0028 Decision 1)',
          ),
      })
      .strict()
      .optional()
      .describe(
        'Optional per-tenant PostgreSQL server routing configuration (ADR 0028 Decision 1)',
      ),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.environment === 'live' && cfg.featureFlags.enableDemoMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['featureFlags', 'enableDemoMode'],
        message:
          'featureFlags.enableDemoMode cannot be true when environment is "live".',
      });
    }

    // 0. Validate per-tenant Key Vault secret-reference ownership (ADR 0024 AG3, R411, R413)
    const configVaultContext = {
      tenantId: cfg.tenantId,
      environment: cfg.environment,
      keyVaultSecretPrefix: `kv-${cfg.tenantId}-${cfg.environment}`,
      configuredKeyVault: cfg.keyVault,
    };
    const secretRefChecks: Array<{
      path: Array<string | number>;
      ref: string | undefined;
    }> = [
      {
        path: ['integrations', 'pmsConnectionSecretVaultRef'],
        ref: cfg.integrations.pmsConnectionSecretVaultRef,
      },
      {
        path: ['integrations', 'companiesHouseApiKeyVaultRef'],
        ref: cfg.integrations.companiesHouseApiKeyVaultRef,
      },
    ];
    for (let i = 0; i < (cfg.documentStores ?? []).length; i++) {
      secretRefChecks.push({
        path: ['documentStores', i, 'auth', 'certificateKeyVaultSecretRef'],
        ref: cfg.documentStores![i]!.auth.certificateKeyVaultSecretRef,
      });
    }
    if (cfg.keyVault?.vaultName && cfg.keyVault?.vaultUri) {
      const uriVault = cfg.keyVault.vaultUri
        .trim()
        .replace(/^https:\/\//i, '')
        .split('.')[0]
        ?.toLowerCase();
      if (uriVault !== cfg.keyVault.vaultName.trim().toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keyVault', 'vaultUri'],
          message:
            'keyVault.vaultName and keyVault.vaultUri must refer to the same Azure Key Vault.',
        });
      }
    }
    for (const check of secretRefChecks) {
      if (!check.ref || (!cfg.keyVault?.vaultName && !cfg.keyVault?.vaultUri)) continue;
      try {
        assertTenantOwnsKeyVaultSecretRef(
          configVaultContext,
          check.ref,
        );
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: check.path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 1. Validate documentStores
    const storeById = new Map<string, NonNullable<typeof cfg.documentStores>[number]>();
    let defaultStoreCount = 0;

    for (let i = 0; i < (cfg.documentStores ?? []).length; i++) {
      const store = cfg.documentStores![i]!;
      if (RESERVED_UNSUPPORTED_DOCUMENT_STORE_PROVIDERS.has(store.providerType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentStores', i, 'providerType'],
          message: `Document store provider "${store.providerType}" is reserved and not yet supported in Phase 1. Only "sharepoint" is currently supported.`,
        });
      }
      if (storeById.has(store.storeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentStores', i, 'storeId'],
          message: `Duplicate document storeId "${store.storeId}".`,
        });
      }
      storeById.set(store.storeId, store);

      if (store.isDefault) {
        defaultStoreCount += 1;
      }

      if (
        store.auth.credentialMode === 'client_certificate' &&
        !store.auth.certificateKeyVaultSecretRef
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentStores', i, 'auth', 'certificateKeyVaultSecretRef'],
          message:
            'SharePoint store with credentialMode "client_certificate" requires a Key Vault reference (certificateKeyVaultSecretRef).',
        });
      }

      if (store.providerType === 'sharepoint' && !store.sharepoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentStores', i, 'sharepoint'],
          message:
            'Document store with providerType "sharepoint" requires a "sharepoint" site and library configuration.',
        });
      }
    }

    if (defaultStoreCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentStores'],
        message: `At most one document store may be marked isDefault=true (found ${defaultStoreCount}).`,
      });
    }

    // 2. Validate documentRouting
    if (cfg.documentRouting && cfg.documentRouting.length > 0) {
      let hasDefaultRule = false;
      for (let i = 0; i < cfg.documentRouting.length; i++) {
        const rule = cfg.documentRouting[i]!;
        if (rule.match === 'default') {
          hasDefaultRule = true;
        }
        const targetStore = storeById.get(rule.storeId);
        if (!targetStore) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['documentRouting', i, 'storeId'],
            message: `Routing rule references unknown storeId "${rule.storeId}".`,
          });
        } else if (targetStore.sharepoint) {
          const libExists = targetStore.sharepoint.libraries.some(
            (l) => l.libraryId === rule.libraryId,
          );
          if (!libExists) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['documentRouting', i, 'libraryId'],
              message: `Routing rule references unknown libraryId "${rule.libraryId}" on store "${rule.storeId}".`,
            });
          }
        }

        const unknownBaseTokens = findUnknownPathTokens(rule.basePath);
        if (unknownBaseTokens.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['documentRouting', i, 'basePath'],
            message: `Routing basePath "${rule.basePath}" contains unknown token(s): ${unknownBaseTokens.join(', ')}.`,
          });
        }
      }

      if (!hasDefaultRule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentRouting'],
          message:
            'documentRouting must include a fallback rule with match: "default".',
        });
      }
    }

    // 3. Validate matterFolderNameTemplate
    if (cfg.matterFolderNameTemplate) {
      const unknownFolderTokens = findUnknownPathTokens(
        cfg.matterFolderNameTemplate,
      );
      if (unknownFolderTokens.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matterFolderNameTemplate'],
          message: `matterFolderNameTemplate contains unknown token(s): ${unknownFolderTokens.join(', ')}.`,
        });
      }
    }

    // 4. Validate matterFolderTemplates
    if (cfg.matterFolderTemplates) {
      const tplCheck = validateMatterFolderTemplatesConfig(
        cfg.matterFolderTemplates,
      );
      for (const err of tplCheck.errors) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['matterFolderTemplates', err.templateId, err.path],
          message: err.message,
        });
      }
    }
  });

export interface ConfigDeprecationWarning {
  path: string;
  deprecatedInVersion: string;
  removalInMajorVersion: number;
  replacementPath: string;
  message: string;
}

export function collectStructuredConfigDeprecationWarnings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
): ConfigDeprecationWarning[] {
  const structured: ConfigDeprecationWarning[] = [];
  const rawStores = Array.isArray(environmentOverlay.documentStores)
    ? (environmentOverlay.documentStores as unknown[])
    : Array.isArray(baseConfig.documentStores)
      ? (baseConfig.documentStores as unknown[])
      : typeof baseConfig.storeId === 'string' &&
          typeof baseConfig.auth === 'object' &&
          baseConfig.auth !== null
        ? [baseConfig]
        : [];

  for (const [idx, rawStore] of rawStores.entries()) {
    if (!rawStore || typeof rawStore !== 'object') continue;
    const storeObj = rawStore as Record<string, unknown>;
    const providerType = storeObj.providerType ?? 'sharepoint';
    const enabled = storeObj.enabled !== false;
    if (providerType !== 'sharepoint' || !enabled) continue;

    const authObj =
      typeof storeObj.auth === 'object' && storeObj.auth !== null
        ? (storeObj.auth as Record<string, unknown>)
        : {};
    const effectiveScope =
      authObj.delegatedPermissionScope ?? 'Files.ReadWrite.All';
    if (effectiveScope === 'Files.ReadWrite.All') {
      const pathStr = `documentStores[${idx}].auth.delegatedPermissionScope`;
      structured.push({
        path: pathStr,
        deprecatedInVersion: '1.2.0',
        removalInMajorVersion: 2,
        replacementPath: `${pathStr} = "Sites.Selected"`,
        message: `[DEPRECATED_CONFIG_KEY] ${pathStr}="Files.ReadWrite.All" is deprecated in v1.2.0 and will be removed in v2.0.0; migrate to "Sites.Selected" (ADR-0023).`,
      });
    }
  }

  return structured;
}

export function collectConfigDeprecationWarnings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
): string[] {
  const warnings: string[] = [];
  const baseDocGen = baseConfig.documentGeneration as
    | Record<string, unknown>
    | undefined;
  const overlayDocGen = environmentOverlay.documentGeneration as
    | Record<string, unknown>
    | undefined;
  const hasBaseRoleDefaults = Boolean(
    (baseDocGen?.permissions as Record<string, unknown> | undefined)
      ?.roleDefaults,
  );
  const hasOverlayRoleDefaults = Boolean(
    (overlayDocGen?.permissions as Record<string, unknown> | undefined)
      ?.roleDefaults,
  );

  if (hasBaseRoleDefaults || hasOverlayRoleDefaults) {
    warnings.push(
      '[DEPRECATED_CONFIG_KEY] documentGeneration.permissions.roleDefaults is deprecated and replaced by rbac.roles (ADR-0011). It has no effect when rbac.roles is configured and will be removed in v2.0.0.',
    );
  }

  const baseBranding = baseConfig.branding as
    | Record<string, unknown>
    | undefined;
  const overlayBranding = environmentOverlay.branding as
    | Record<string, unknown>
    | undefined;
  if (
    typeof baseBranding?.contactEmail === 'string' &&
    baseBranding.contactEmail.trim() !== ''
  ) {
    warnings.push(
      '[DEPRECATED_CONFIG_KEY] branding.contactEmail is deprecated; use firm.contactEmail instead.',
    );
  } else if (
    typeof overlayBranding?.contactEmail === 'string' &&
    overlayBranding.contactEmail.trim() !== ''
  ) {
    warnings.push(
      '[DEPRECATED_CONFIG_KEY] branding.contactEmail is deprecated; use firm.contactEmail instead.',
    );
  }
  if (
    typeof baseBranding?.website === 'string' &&
    baseBranding.website.trim() !== ''
  ) {
    warnings.push(
      '[DEPRECATED_CONFIG_KEY] branding.website is deprecated; use firm.website instead.',
    );
  } else if (
    typeof overlayBranding?.website === 'string' &&
    overlayBranding.website.trim() !== ''
  ) {
    warnings.push(
      '[DEPRECATED_CONFIG_KEY] branding.website is deprecated; use firm.website instead.',
    );
  }

  for (const w of collectStructuredConfigDeprecationWarnings(
    baseConfig,
    environmentOverlay,
  )) {
    warnings.push(w.message);
  }

  return warnings;
}

export interface ConfigReservedSettingNotice {
  path: string;
  forSlice: string;
  reason: string;
  message: string;
}

const EXTERNAL_CONFIG_JSON_SCHEMAS: Readonly<
  Record<string, Record<string, unknown>>
> = {
  './keyDates.config.schema.json': keyDatesJsonSchema as unknown as Record<
    string,
    unknown
  >,
};

function extractReservedSettingsFromSchema(
  node: Record<string, unknown>,
  prefix = '',
  rootSchema: Record<string, unknown> = tenantConfigJsonSchema as unknown as Record<
    string,
    unknown
  >,
  inheritedReserved?: { for: string; reason: string },
): Array<{ path: string; forSlice: string; reason: string }> {
  const results: Array<{ path: string; forSlice: string; reason: string }> = [];
  if (!node || typeof node !== 'object') {
    return results;
  }

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ref.startsWith('#/$defs/')) {
      const defName = ref.slice('#/$defs/'.length);
      const defs = rootSchema.$defs as
        | Record<string, Record<string, unknown>>
        | undefined;
      const target = defs?.[defName];
      if (target) {
        const rest = { ...node };
        delete rest.$ref;
        return extractReservedSettingsFromSchema(
          { ...target, ...rest },
          prefix,
          rootSchema,
          inheritedReserved,
        );
      }
    } else if (ref in EXTERNAL_CONFIG_JSON_SCHEMAS) {
      const extSchema = EXTERNAL_CONFIG_JSON_SCHEMAS[ref]!;
      const rest = { ...node };
      delete rest.$ref;
      return extractReservedSettingsFromSchema(
        { ...extSchema, ...rest },
        prefix,
        extSchema,
        inheritedReserved,
      );
    }
  }

  const ownReserved =
    node['x-reserved'] && typeof node['x-reserved'] === 'object'
      ? (node['x-reserved'] as { for: string; reason: string })
      : undefined;
  if (ownReserved && prefix) {
    results.push({
      path: prefix,
      forSlice: ownReserved.for,
      reason: ownReserved.reason,
    });
    return results;
  }

  const nodeReserved = ownReserved ?? inheritedReserved;

  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(
      node.properties as Record<string, Record<string, unknown>>,
    )) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      const children = extractReservedSettingsFromSchema(
        child,
        childPath,
        rootSchema,
        nodeReserved,
      );
      if (children.length === 0) {
        const leafReserved =
          (child['x-reserved'] && typeof child['x-reserved'] === 'object'
            ? (child['x-reserved'] as { for: string; reason: string })
            : undefined) ?? nodeReserved;
        if (leafReserved) {
          results.push({
            path: childPath,
            forSlice: leafReserved.for,
            reason: leafReserved.reason,
          });
        }
      } else {
        results.push(...children);
      }
    }
    return results;
  }

  if (node.items && typeof node.items === 'object') {
    const children = extractReservedSettingsFromSchema(
      node.items as Record<string, unknown>,
      `${prefix}[]`,
      rootSchema,
      nodeReserved,
    );
    if (children.length > 0) {
      results.push(...children);
      return results;
    }
  }

  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object'
  ) {
    const children = extractReservedSettingsFromSchema(
      node.additionalProperties as Record<string, unknown>,
      `${prefix}.*`,
      rootSchema,
      nodeReserved,
    );
    if (children.length > 0) {
      results.push(...children);
      return results;
    }
  }

  if (Array.isArray(node.oneOf)) {
    for (const variant of node.oneOf as Record<string, unknown>[]) {
      results.push(
        ...extractReservedSettingsFromSchema(
          variant,
          prefix,
          rootSchema,
          nodeReserved,
        ),
      );
    }
  }

  return results;
}

export const RESERVED_TENANT_CONFIG_SETTINGS: readonly {
  path: string;
  forSlice: string;
  reason: string;
}[] = extractReservedSettingsFromSchema(
  tenantConfigJsonSchema as unknown as Record<string, unknown>,
);

function hasNestedConfigValue(
  obj: Record<string, unknown> | undefined,
  dottedPath: string,
): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const parts = dottedPath.split('.');
  const walk = (cur: unknown, idx: number): boolean => {
    if (idx >= parts.length) return cur !== undefined;
    if (!cur || typeof cur !== 'object') return false;
    const part = parts[idx]!;
    if (part === '*') {
      return Object.values(cur as Record<string, unknown>).some((v) =>
        walk(v, idx + 1),
      );
    }
    if (part.endsWith('[]')) {
      const arrayKey = part.slice(0, -2);
      const arr = (cur as Record<string, unknown>)[arrayKey];
      if (!Array.isArray(arr) || arr.length === 0) return false;
      return arr.some((item) => walk(item, idx + 1));
    }
    if (!(part in (cur as Record<string, unknown>))) {
      return false;
    }
    return walk((cur as Record<string, unknown>)[part], idx + 1);
  };
  return walk(obj, 0);
}

export function collectStructuredConfigReservedSettings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
): ConfigReservedSettingNotice[] {
  const notices: ConfigReservedSettingNotice[] = [];
  for (const entry of RESERVED_TENANT_CONFIG_SETTINGS) {
    if (
      hasNestedConfigValue(baseConfig, entry.path) ||
      hasNestedConfigValue(environmentOverlay, entry.path)
    ) {
      notices.push({
        path: entry.path,
        forSlice: entry.forSlice,
        reason: entry.reason,
        message: `[RESERVED_CONFIG_KEY] ${entry.path} is reserved for ${entry.forSlice}: ${entry.reason}`,
      });
    }
  }
  return notices;
}

export function collectConfigReservedSettings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
): string[] {
  return collectStructuredConfigReservedSettings(
    baseConfig,
    environmentOverlay,
  ).map((n) => n.message);
}

export function validateTenantConfigWithWarnings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
  environmentOverride?: PlatformEnvironment,
  hostingModeOverride?: HostingMode,
): {
  config: TenantConfiguration;
  deprecationWarnings: string[];
  structuredDeprecationWarnings: ConfigDeprecationWarning[];
  reservedSettings: string[];
  structuredReservedSettings: ConfigReservedSettingNotice[];
} {
  const deprecationWarnings = collectConfigDeprecationWarnings(
    baseConfig,
    environmentOverlay,
  );
  const structuredDeprecationWarnings =
    collectStructuredConfigDeprecationWarnings(baseConfig, environmentOverlay);
  const reservedSettings = collectConfigReservedSettings(
    baseConfig,
    environmentOverlay,
  );
  const structuredReservedSettings =
    collectStructuredConfigReservedSettings(baseConfig, environmentOverlay);
  const config = loadAndValidateTenantConfig(
    baseConfig,
    environmentOverlay,
    environmentOverride,
    hostingModeOverride,
  );
  return {
    config,
    deprecationWarnings,
    structuredDeprecationWarnings,
    reservedSettings,
    structuredReservedSettings,
  };
}

export function loadAndValidateTenantConfig(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
  environmentOverride?: PlatformEnvironment,
  hostingModeOverride?: HostingMode,
): TenantConfiguration {
  const baseDocGen = baseConfig.documentGeneration as
    | Record<string, unknown>
    | undefined;
  const overlayDocGen = environmentOverlay.documentGeneration as
    | Record<string, unknown>
    | undefined;
  const baseRbac = baseConfig.rbac as Record<string, unknown> | undefined;
  const overlayRbac = environmentOverlay.rbac as
    | Record<string, unknown>
    | undefined;

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

  const baseFirm = baseConfig.firm as Record<string, unknown> | undefined;
  const overlayFirm = environmentOverlay.firm as
    | Record<string, unknown>
    | undefined;
  if (baseFirm || overlayFirm) {
    merged.firm = {
      ...(baseFirm ?? {}),
      ...(overlayFirm ?? {}),
    };
  }

  const baseConflictReview = baseConfig.conflictReview as
    | Record<string, unknown>
    | undefined;
  const overlayConflictReview = environmentOverlay.conflictReview as
    | Record<string, unknown>
    | undefined;
  if (baseConflictReview || overlayConflictReview) {
    merged.conflictReview = {
      ...(baseConflictReview ?? {}),
      ...(overlayConflictReview ?? {}),
    };
  }

  if (baseDocGen || overlayDocGen) {
    merged.documentGeneration = {
      ...(baseDocGen ?? {}),
      ...(overlayDocGen ?? {}),
      approval: {
        ...((baseDocGen?.approval as Record<string, unknown> | undefined) ??
          {}),
        ...((overlayDocGen?.approval as Record<string, unknown> | undefined) ??
          {}),
      },
      usage: {
        ...((baseDocGen?.usage as Record<string, unknown> | undefined) ?? {}),
        ...((overlayDocGen?.usage as Record<string, unknown> | undefined) ??
          {}),
      },
      permissions: {
        ...((baseDocGen?.permissions as Record<string, unknown> | undefined) ??
          {}),
        ...((overlayDocGen?.permissions as
          | Record<string, unknown>
          | undefined) ?? {}),
      },
    };
  }

  const defaultRbac = createDefaultRbacConfig();
  if (baseRbac || overlayRbac) {
    const mergedRoles: Record<string, unknown> = {
      ...defaultRbac.roles,
      ...((baseRbac?.roles as Record<string, unknown> | undefined) ?? {}),
      ...((overlayRbac?.roles as Record<string, unknown> | undefined) ?? {}),
    };
    merged.rbac = {
      ...defaultRbac,
      ...(baseRbac ?? {}),
      ...(overlayRbac ?? {}),
      roles: mergedRoles,
      departmentGrants: {
        ...defaultRbac.departmentGrants,
        ...((baseRbac?.departmentGrants as
          | Record<string, unknown>
          | undefined) ?? {}),
        ...((overlayRbac?.departmentGrants as
          | Record<string, unknown>
          | undefined) ?? {}),
      },
      relationshipGrants:
        (overlayRbac?.relationshipGrants as unknown[] | undefined) ??
        (baseRbac?.relationshipGrants as unknown[] | undefined) ??
        defaultRbac.relationshipGrants,
      identityMapping: {
        ...defaultRbac.identityMapping,
        ...((baseRbac?.identityMapping as
          | Record<string, unknown>
          | undefined) ?? {}),
        ...((overlayRbac?.identityMapping as
          | Record<string, unknown>
          | undefined) ?? {}),
        emailLinking: {
          ...defaultRbac.identityMapping.emailLinking,
          ...(((baseRbac?.identityMapping as Record<string, unknown> | undefined)
            ?.emailLinking as Record<string, unknown> | undefined) ?? {}),
          ...(((overlayRbac?.identityMapping as
            | Record<string, unknown>
            | undefined)?.emailLinking as Record<string, unknown> | undefined) ??
            {}),
        },
      },
    };
  } else {
    // Transitional migration path: if `rbac` is not present in raw config, but deprecated
    // `documentGeneration.permissions.roleDefaults` was supplied, project `roleDefaults` into `defaultRbac.roles`.
    const legacyRoleDefaults = (
      merged.documentGeneration as
        | { permissions?: { roleDefaults?: Record<string, string[]> } }
        | undefined
    )?.permissions?.roleDefaults;
    if (legacyRoleDefaults) {
      const migratedRbac: RbacConfiguration = createDefaultRbacConfig();
      const docPermKeys = Object.keys(legacyRoleDefaults);
      for (const roleDef of Object.values(migratedRbac.roles)) {
        roleDef.permissions = roleDef.permissions.filter(
          (p) => !docPermKeys.includes(p),
        );
      }
      for (const [permKey, roleKeys] of Object.entries(legacyRoleDefaults)) {
        if (!Array.isArray(roleKeys)) continue;
        for (const rk of roleKeys) {
          if (migratedRbac.roles[rk]) {
            if (
              !migratedRbac.roles[rk].permissions.includes(
                permKey as PermissionKey,
              )
            ) {
              migratedRbac.roles[rk].permissions.push(permKey as PermissionKey);
            }
          }
        }
      }
      merged.rbac = migratedRbac;
    }
  }

  if (environmentOverride) {
    merged.environment = environmentOverride;
  }
  if (hostingModeOverride) {
    merged.hostingMode = hostingModeOverride;
  }

  const baseKeyDates = baseConfig.keyDates as
    | Record<string, unknown>
    | undefined;
  const overlayKeyDates = environmentOverlay.keyDates as
    | Record<string, unknown>
    | undefined;
  if (baseKeyDates || overlayKeyDates) {
    merged.keyDates = {
      ...(baseKeyDates ?? {}),
      ...(overlayKeyDates ?? {}),
    };
  }

  const baseKeyVault = baseConfig.keyVault as
    | Record<string, unknown>
    | undefined;
  const overlayKeyVault = environmentOverlay.keyVault as
    | Record<string, unknown>
    | undefined;
  if (baseKeyVault || overlayKeyVault) {
    merged.keyVault = {
      ...(baseKeyVault ?? {}),
      ...(overlayKeyVault ?? {}),
    };
  }

  const baseDatabase = baseConfig.database as
    | Record<string, unknown>
    | undefined;
  const overlayDatabase = environmentOverlay.database as
    | Record<string, unknown>
    | undefined;
  if (baseDatabase || overlayDatabase) {
    merged.database = {
      ...(baseDatabase ?? {}),
      ...(overlayDatabase ?? {}),
    };
  }

  return TenantConfigurationSchema.parse(merged);
}

export const KeyDatesConfigSubSchema = TenantConfigurationSchema.shape.keyDates;
export const RbacConfigSubSchema = TenantConfigurationSchema.shape.rbac;
export const ConflictReviewConfigSubSchema =
  TenantConfigurationSchema.shape.conflictReview;
export const FirmConfigSubSchema = TenantConfigurationSchema.shape.firm;
export const DocumentStoreConfigSubSchema =
  TenantConfigurationSchema.shape.documentStores.unwrap().element;

/**
 * Validates a standalone `DocumentStoreConfig` entry against `DocumentStoreConfigSubSchema`
 * (rejecting unknown keys and applying defaults) and returns any structured deprecation warnings.
 */
export function validateDocumentStoreConfig(
  rawStore: Record<string, unknown>,
): {
  store: DocumentStoreConfig;
  deprecationWarnings: ConfigDeprecationWarning[];
} {
  const store = DocumentStoreConfigSubSchema.parse(
    rawStore,
  ) as DocumentStoreConfig;
  const deprecationWarnings = collectStructuredConfigDeprecationWarnings({
    documentStores: [rawStore],
  });
  return { store, deprecationWarnings };
}

/**
 * Validates a standalone `keyDates` configuration object against `keyDates.config.schema.json`
 * (rejecting unknown keys and applying defaults).
 */
export function validateKeyDatesConfig(
  rawKeyDatesConfig: unknown,
): KeyDatesConfiguration {
  if (
    typeof rawKeyDatesConfig !== 'object' ||
    rawKeyDatesConfig === null ||
    Array.isArray(rawKeyDatesConfig)
  ) {
    throw new Error('KEY_DATES_CONFIG_INVALID: keyDates configuration must be a JSON object.');
  }
  return KeyDatesConfigSubSchema.parse(rawKeyDatesConfig);
}

/**
 * Validates a standalone `rbac` configuration object against the core RBAC schema.
 */
export function validateRbacConfig(
  rawRbacConfig: unknown,
): RbacConfiguration {
  if (
    typeof rawRbacConfig !== 'object' ||
    rawRbacConfig === null ||
    Array.isArray(rawRbacConfig)
  ) {
    throw new Error('RBAC_CONFIG_INVALID: rbac configuration must be a JSON object.');
  }
  return RbacConfigSubSchema.parse(rawRbacConfig);
}

/**
 * Validates that department IDs, team IDs, and work type IDs referenced in `documentRouting`,
 * `documentAccess`, and `matterFolderTemplates` exist in the tenant's organisational structure and choice lists.
 */
export function validateDocumentConfigAgainstTenantData(
  config: Pick<
    TenantConfiguration,
    | 'documentRouting'
    | 'documentAccess'
    | 'matterFolderTemplates'
  >,
  tenantCatalog: {
    departmentIds: ReadonlySet<string> | readonly string[];
    teamIds: ReadonlySet<string> | readonly string[];
    workTypeIds: ReadonlySet<string> | readonly string[];
  },
): {
  valid: boolean;
  errors: string[];
} {
  const deptSet =
    tenantCatalog.departmentIds instanceof Set
      ? tenantCatalog.departmentIds
      : new Set(tenantCatalog.departmentIds);
  const teamSet =
    tenantCatalog.teamIds instanceof Set
      ? tenantCatalog.teamIds
      : new Set(tenantCatalog.teamIds);
  const workTypeSet =
    tenantCatalog.workTypeIds instanceof Set
      ? tenantCatalog.workTypeIds
      : new Set(tenantCatalog.workTypeIds);

  const errors: string[] = [];

  for (const [idx, rule] of (config.documentRouting ?? []).entries()) {
    if (rule.match === 'default') continue;
    if (rule.match.departmentId && !deptSet.has(rule.match.departmentId)) {
      errors.push(
        `documentRouting[${idx}].match.departmentId references unknown department "${rule.match.departmentId}".`,
      );
    }
    if (rule.match.teamId && !teamSet.has(rule.match.teamId)) {
      errors.push(
        `documentRouting[${idx}].match.teamId references unknown team "${rule.match.teamId}".`,
      );
    }
    if (rule.match.workTypeId && !workTypeSet.has(rule.match.workTypeId)) {
      errors.push(
        `documentRouting[${idx}].match.workTypeId references unknown work type "${rule.match.workTypeId}".`,
      );
    }
  }

  for (const deptId of Object.keys(
    config.documentAccess?.departmentEntraGroups ?? {},
  )) {
    if (!deptSet.has(deptId)) {
      errors.push(
        `documentAccess.departmentEntraGroups references unknown department "${deptId}".`,
      );
    }
  }

  for (const teamId of Object.keys(
    config.documentAccess?.teamEntraGroups ?? {},
  )) {
    if (!teamSet.has(teamId)) {
      errors.push(
        `documentAccess.teamEntraGroups references unknown team "${teamId}".`,
      );
    }
  }

  for (const deptId of Object.keys(
    config.matterFolderTemplates?.byDepartment ?? {},
  )) {
    if (!deptSet.has(deptId)) {
      errors.push(
        `matterFolderTemplates.byDepartment references unknown department "${deptId}".`,
      );
    }
  }

  for (const wtId of Object.keys(
    config.matterFolderTemplates?.byWorkType ?? {},
  )) {
    if (!workTypeSet.has(wtId)) {
      errors.push(
        `matterFolderTemplates.byWorkType references unknown work type "${wtId}".`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export const ExtensionPermissionSchema = z.enum([
  'matter:read',
  'client:read',
  'person:read',
  'finance:view',
  'document:fields:provide',
  'document:read',
  'document:write',
  'matter:costs:validate',
  'matter:open:gate',
  'config:read',
  'audit:write',
  'pms:sync',
  'keydate:read',
  'keydate:write',
]);

export const ExtensionHookPointSchema = z.enum([
  'beforeMatterCostsCalculate',
  'afterMatterCostsCalculate',
  'beforeMatterOpen',
  'afterMatterOpen',
  'onPmsOutboundCommand',
  'provideDocumentFields',
  'afterMatterDocumentsProvisioned',
  'beforeMatterDocumentsClose',
  'keyDate.beforeCreate',
  'keyDate.afterStatusChange',
  'keyDate.calculateCustomRule',
]);

export const ExtensionManifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    supportedCoreApiRange: z.string().min(1),
    permissions: z.array(ExtensionPermissionSchema),
    hooks: z.array(ExtensionHookPointSchema),
    uiSlots: z.array(z.string()).optional(),
    hookTimeoutMs: z.number().int().positive().default(2000).optional(),
  })
  .strict();

export function validateExtensionManifest(
  rawManifest: unknown,
): ExtensionManifest {
  const parsed = ExtensionManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new Error(
      `EXTENSION_MANIFEST_ERROR: Invalid extension manifest: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
