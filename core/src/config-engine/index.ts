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
  DocumentGenerationConfig,
  DocumentPermission,
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
            'Number of months to retain template usage events and daily summaries',
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
        'Additional tenant-configured document classification types beyond core defaults',
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
        'Whether PMS / Finance DB synchronisation is enabled for this tenant',
      ),
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
      .describe(
        'Deployment tenancy mode (Model A single_tenant or Model B multi_tenant)',
      ),
    environment: z
      .enum(['dev', 'test', 'training', 'live'])
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
          .describe('Source of default fee-earner hourly rates'),
        allowMatterRateOverrides: z
          .boolean()
          .default(true)
          .describe(
            'Whether fee earners can override standard rates on a matter',
          ),
        partnerSignOffThresholdGbp: z
          .number()
          .nonnegative()
          .default(25000)
          .describe(
            'Fee estimate or cap threshold in GBP requiring Partner cost sign-off',
          ),
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
      .describe(
        'Per-client custom fields, screen locations, and mandatory rules',
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
            'Whether scheduled permission reconciliation automatically remediates detected drift (default: false)',
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
          claimType: z.string().optional(),
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
                .default('matter_owning_team'),
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
                  defaultRuleSetIds: z.array(z.string()).default([]),
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
              provider: z.enum(['microsoft_graph']).default('microsoft_graph'),
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
  return warnings;
}

export function validateTenantConfigWithWarnings(
  baseConfig: Record<string, unknown>,
  environmentOverlay: Record<string, unknown> = {},
  environmentOverride?: PlatformEnvironment,
  hostingModeOverride?: HostingMode,
): { config: TenantConfiguration; deprecationWarnings: string[] } {
  const deprecationWarnings = collectConfigDeprecationWarnings(
    baseConfig,
    environmentOverlay,
  );
  const config = loadAndValidateTenantConfig(
    baseConfig,
    environmentOverlay,
    environmentOverride,
    hostingModeOverride,
  );
  return { config, deprecationWarnings };
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

  return TenantConfigurationSchema.parse(merged);
}

export const KeyDatesConfigSubSchema = TenantConfigurationSchema.shape.keyDates;
export const RbacConfigSubSchema = TenantConfigurationSchema.shape.rbac;

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
