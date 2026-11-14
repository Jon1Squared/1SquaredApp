/**
 * Central Permission Registry & Core Built-In Role Defaults (`core/src/domain/rbac/registry.ts`).
 *
 * Implements ADR-0010, ADR-0011, and ADR-0012:
 * - Single versioned registry of all `resource:action` permissions (`PERMISSION_REGISTRY`).
 * - Each entry declares description, sensitivity level, and whether MFA is required (`requiresMfa`).
 * - Default role-to-permission and relationship mappings that reproduce the Phase 1 baseline matrix.
 */

import type {
  DocumentPermission,
  EmployeePermission,
  HomeRoleKey,
  KeyDatePermission,
  PermissionKey,
  PermissionRegistryEntry,
  RbacConfiguration,
  RbacIdentityMappingConfig,
  RbacRelationshipGrantRule,
  RbacRoleDefinition,
} from '../../api/index';

export const ALL_BUILTIN_ROLE_KEYS: readonly HomeRoleKey[] = [
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
] as const;

export const ALL_EMPLOYEE_PERMISSIONS: readonly EmployeePermission[] = [
  'employee:view_core',
  'employee:edit_core',
  'employee:hr_restricted',
  'employee:payroll',
  'employee:sensitive',
] as const;

export const ALL_DOCUMENT_PERMISSIONS: readonly DocumentPermission[] = [
  'document_template:view',
  'document_template:build',
  'document_template:approve',
  'document_template:view_usage',
  'document_template:view_usage_by_user',
  'document_template:configure',
  'document:generate',
  'document:view',
  'document:download',
  'document:upload',
  'document:edit',
  'document:delete',
  'document:provision',
  'document_store:configure',
  'document_access:review',
  'finance:view',
] as const;

export const ALL_KEY_DATE_PERMISSIONS: readonly KeyDatePermission[] = [
  'keydate:view',
  'keydate:view_any_team',
  'keydate:edit',
  'keydate:verify',
  'keydate:resolve',
  'keydate:waive',
  'keydate:override_calculation',
  'keydate:configure',
] as const;

export const PERMISSION_REGISTRY: Readonly<
  Record<PermissionKey, PermissionRegistryEntry>
> = {
  'employee:view_core': {
    key: 'employee:view_core',
    domain: 'employee',
    description:
      'View core employee directory and business contact fields (name, job title, work email/phone, department, office).',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'employee:edit_core': {
    key: 'employee:edit_core',
    domain: 'employee',
    description:
      'Create and edit core employment, team membership, and line management fields.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'employee:hr_restricted': {
    key: 'employee:hr_restricted',
    domain: 'employee',
    description:
      'View and edit HR-restricted employment fields (contracts, notice periods, appraisals, leave, right-to-work, personal contact details).',
    sensitivity: 'confidential',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'employee:payroll': {
    key: 'employee:payroll',
    domain: 'employee',
    description:
      'View and edit payroll, salary, bank sort code/account number, NI number, tax code, and pension fields.',
    sensitivity: 'confidential',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'employee:sensitive': {
    key: 'employee:sensitive',
    domain: 'employee',
    description:
      'View and edit special-category diversity monitoring, medical/workplace adjustments, and criminal check fields.',
    sensitivity: 'critical',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_template:view': {
    key: 'document_template:view',
    domain: 'document_template',
    description:
      'View document templates, versions, and placeholder mappings in the template library.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_template:build': {
    key: 'document_template:build',
    domain: 'document_template',
    description:
      'Upload .docx templates, map placeholders, configure prompted fields, export/import template packages, and submit drafts for approval.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_template:approve': {
    key: 'document_template:approve',
    domain: 'document_template',
    description:
      'Approve or reject submitted template versions, retire active templates, and roll back to prior approved versions.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'document_template:view_usage': {
    key: 'document_template:view_usage',
    domain: 'document_template',
    description:
      'View aggregate template usage dashboards, 30/90-day metrics, low-use retirement candidates, and blocked-field diagnostics.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_template:view_usage_by_user': {
    key: 'document_template:view_usage_by_user',
    domain: 'document_template',
    description:
      'View and export per-user template usage breakdowns (when documentGeneration.usage.showUserLevelDetail is also enabled).',
    sensitivity: 'confidential',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_template:configure': {
    key: 'document_template:configure',
    domain: 'document_template',
    description:
      'Edit default, department, and work-type matter folder templates and apply additive folder updates to open matters.',
    sensitivity: 'restricted',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'document:generate': {
    key: 'document:generate',
    domain: 'document',
    description:
      'Preview and generate documents from active templates on accessible matters and clients.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:view': {
    key: 'document:view',
    domain: 'document',
    description:
      'View matter document folders, file listings, and generated documents on accessible matters and clients.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:download': {
    key: 'document:download',
    domain: 'document',
    description:
      'Download matter documents or open them in native desktop/web applications.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:upload': {
    key: 'document:upload',
    domain: 'document',
    description:
      'Upload documents and create subfolders within accessible matter document stores.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:edit': {
    key: 'document:edit',
    domain: 'document',
    description:
      'Rename, move, or overwrite/version documents and folders within accessible matter document stores.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:delete': {
    key: 'document:delete',
    domain: 'document',
    description:
      'Delete saved or uploaded documents and folders from a matter or client record (subject to audit logging).',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document:provision': {
    key: 'document:provision',
    domain: 'document',
    description:
      'Manually provision a matter folder tree, retry failed provisioning jobs, or link an existing document store folder.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'document_store:configure': {
    key: 'document_store:configure',
    domain: 'admin',
    description:
      'Configure external document stores, SharePoint connections, storage routing rules, Entra group mappings, and access policies.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'document_access:review': {
    key: 'document_access:review',
    domain: 'risk',
    description:
      'View document store permission reconciliation drift findings, sharing link alerts, and trigger remediation.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'finance:view': {
    key: 'finance:view',
    domain: 'finance',
    description:
      'Access firm-wide Finance workspace, billing/aged-debt queues, and Financial-group document merge fields.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'finance:view_matter': {
    key: 'finance:view_matter',
    domain: 'finance',
    description:
      'View matter and client financial tabs, WIP, client balances, and financial attention alerts on accessible records.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'finance:credit_control': {
    key: 'finance:credit_control',
    domain: 'finance',
    description:
      'Record credit control chase actions, request matter bills, and flag write-offs.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'finance:manage_links': {
    key: 'finance:manage_links',
    domain: 'finance',
    description:
      'Link or unlink Practice Management System (PMS) client and matter codes.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'risk:view': {
    key: 'risk:view',
    domain: 'risk',
    description:
      'Access Risk & Compliance workspace, CDD/AML oversight queues, conflict overrides, and compliance reminders.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'matter:create': {
    key: 'matter:create',
    domain: 'matter',
    description:
      'Create and open new matters, including draft conflict checks and enquiry/quote conversions.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'matter:edit': {
    key: 'matter:edit',
    domain: 'matter',
    description:
      'Edit matter details, participants, conflict check records, and commercial fields on accessible matters.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'matter:reassign_ownership': {
    key: 'matter:reassign_ownership',
    domain: 'matter',
    description:
      'Change the owning department or owning team/practice group on an existing matter (re-permissioning linked document store folders).',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'matter:restricted:access': {
    key: 'matter:restricted:access',
    domain: 'matter',
    description:
      'Oversight access to restricted staff matters (isStaffMatter) and their linked documents.',
    sensitivity: 'confidential',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'matter:restriction:lift': {
    key: 'matter:restriction:lift',
    domain: 'matter',
    description:
      'Lift a staff matter restriction or information barrier (ethical wall) on an accessible matter, requiring MFA and a recorded reason.',
    sensitivity: 'restricted',
    requiresMfa: true,
    sinceVersion: '1.1.0',
  },
  'matter:costs:sign_off': {
    key: 'matter:costs:sign_off',
    domain: 'matter',
    description:
      'Sign off matter fee estimates that exceed the configured partner cost sign-off threshold.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'task:claim_any': {
    key: 'task:claim_any',
    domain: 'task',
    description: 'Take or claim unassigned tasks across any team.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'task:reassign_any': {
    key: 'task:reassign_any',
    domain: 'task',
    description: 'Reassign tasks across any user or team.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'task:edit': {
    key: 'task:edit',
    domain: 'task',
    description:
      'Create and edit tasks, subtasks, status, and linked records on accessible tasks.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'task:comment': {
    key: 'task:comment',
    domain: 'task',
    description: 'Post comments on accessible tasks.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:intake_view': {
    key: 'enquiry:intake_view',
    domain: 'enquiry',
    description:
      'Default to the intake/call-handler view and workflow on the Enquiries queue.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.0.0',
  },
  'enquiry:create': {
    key: 'enquiry:create',
    domain: 'enquiry',
    description: 'Create new client enquiries.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:edit': {
    key: 'enquiry:edit',
    domain: 'enquiry',
    description:
      'Edit accessible enquiries, log contact attempts, and send enquiry emails.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:assign': {
    key: 'enquiry:assign',
    domain: 'enquiry',
    description:
      'Assign or reassign accessible enquiries to a fee earner or team.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:close': {
    key: 'enquiry:close',
    domain: 'enquiry',
    description: 'Decline or close accessible enquiries.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:reopen': {
    key: 'enquiry:reopen',
    domain: 'enquiry',
    description:
      'Reopen closed unconverted enquiries on accessible records.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'enquiry:anonymise': {
    key: 'enquiry:anonymise',
    domain: 'enquiry',
    description:
      'Anonymise personal data on closed unconverted enquiries that have passed their retention period.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'quote:view': {
    key: 'quote:view',
    domain: 'quote',
    description: 'View fee quotes on accessible enquiries and matters.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'quote:edit': {
    key: 'quote:edit',
    domain: 'quote',
    description:
      'Create, edit, send, revise, log follow-ups, and record outcomes on accessible fee quotes.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'signoff:approve': {
    key: 'signoff:approve',
    domain: 'signoff',
    description:
      'Approve or request discussion on partner sign-off items (write-offs, high-risk matter openings, and undertakings).',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'contact:create': {
    key: 'contact:create',
    domain: 'contact',
    description:
      'Create non-employee people, organisations, and person-to-organisation links.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'contact:edit': {
    key: 'contact:edit',
    domain: 'contact',
    description:
      'Edit non-employee people, organisations, and person-to-organisation links.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'record:merge': {
    key: 'record:merge',
    domain: 'contact',
    description:
      'Dismiss duplicate flags and merge duplicate non-employee person or organisation records.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'admin:access': {
    key: 'admin:access',
    domain: 'admin',
    description:
      'Access Administration screens and modify firm reference lists, routing rules, org structure, and Home layouts.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'admin:data_reset': {
    key: 'admin:data_reset',
    domain: 'admin',
    description:
      'Reset demo data or clear all data to a clean deployment in non-live environments.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.1.0',
  },
  'rbac:manage_config': {
    key: 'rbac:manage_config',
    domain: 'rbac',
    description:
      'Modify tenant RBAC role mappings, department grants, relationship grants, and document generation security settings.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'rbac:manage_user_overrides': {
    key: 'rbac:manage_user_overrides',
    domain: 'rbac',
    description:
      'Grant or revoke per-person permission overrides and modify another user’s assigned security roles.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.0.0',
  },
  'keydate:view': {
    key: 'keydate:view',
    domain: 'keydate',
    description:
      'View key dates on accessible matters and enquiries, and view own teams’ diaries.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:view_any_team': {
    key: 'keydate:view_any_team',
    domain: 'keydate',
    description:
      'Select and view any team diary and access the compliance exceptions report.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:edit': {
    key: 'keydate:edit',
    domain: 'keydate',
    description:
      'Create, edit, propose, supersede, and mark key dates as not applicable on accessible matters and enquiries.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:verify': {
    key: 'keydate:verify',
    domain: 'keydate',
    description:
      'Perform second-person verification (confirm or reject) on proposed key dates where the user is not the proposer.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:resolve': {
    key: 'keydate:resolve',
    domain: 'keydate',
    description:
      'Resolve key dates as met or missed and acknowledge key date reminder stages.',
    sensitivity: 'standard',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:waive': {
    key: 'keydate:waive',
    domain: 'keydate',
    description:
      'Waive a key date with an audited reason.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:override_calculation': {
    key: 'keydate:override_calculation',
    domain: 'keydate',
    description:
      'Override a rule-calculated limitation or key date with a mandatory audited reason.',
    sensitivity: 'restricted',
    requiresMfa: false,
    sinceVersion: '1.1.0',
  },
  'keydate:configure': {
    key: 'keydate:configure',
    domain: 'keydate',
    description:
      'Configure key date types, matter type rules, reminder schedules, limitation rule sets, and business calendars.',
    sensitivity: 'critical',
    requiresMfa: true,
    sinceVersion: '1.1.0',
  },
  'tenant:migrate': {
    key: 'tenant:migrate',
    domain: 'tenancy',
    module: 'tenancy',
    description:
      'Execute per-tenant PostgreSQL schema migrations inside the guardedJob migration runner (ADR 0030; job-only, never granted to any user role).',
    sensitivity: 'critical',
    requiresMfa: false,
    jobOnly: true,
    sinceVersion: '1.1.0',
  },
  'keydate:run_reminders': {
    key: 'keydate:run_reminders',
    domain: 'keydate',
    module: 'key_dates',
    description:
      'Execute the scheduled daily key-date reminder and escalation job across provisioned tenants (ADR 0030; job-only, never granted to any user role).',
    sensitivity: 'critical',
    requiresMfa: false,
    jobOnly: true,
    sinceVersion: '1.1.0',
  },
  'document_generation:purge_usage': {
    key: 'document_generation:purge_usage',
    domain: 'document_template',
    module: 'document_generation',
    description:
      'Execute the scheduled document template usage retention purge job across provisioned tenants (ADR 0030; job-only, never granted to any user role).',
    sensitivity: 'critical',
    requiresMfa: false,
    jobOnly: true,
    sinceVersion: '1.1.0',
  },
};

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  Object.keys(PERMISSION_REGISTRY) as PermissionKey[],
);

export const ALL_USER_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  Object.values(PERMISSION_REGISTRY)
    .filter((entry) => !entry.jobOnly)
    .map((entry) => entry.key),
);

export const ALL_JOB_ONLY_PERMISSION_KEYS: readonly PermissionKey[] =
  Object.freeze(
    Object.values(PERMISSION_REGISTRY)
      .filter((entry) => entry.jobOnly === true)
      .map((entry) => entry.key),
  );

const PERMISSION_KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);
const JOB_ONLY_PERMISSION_KEY_SET = new Set<string>(
  ALL_JOB_ONLY_PERMISSION_KEYS,
);

export function isRegisteredPermissionKey(
  value: string,
): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

export function isJobOnlyPermissionKey(
  value: string,
): value is PermissionKey {
  return JOB_ONLY_PERMISSION_KEY_SET.has(value);
}

export function isUserAssignablePermissionKey(
  value: string,
): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value) && !JOB_ONLY_PERMISSION_KEY_SET.has(value);
}

export function getPermissionRegistryEntry(
  key: PermissionKey,
): PermissionRegistryEntry {
  return PERMISSION_REGISTRY[key];
}

export const DEFAULT_RBAC_ROLES: Readonly<
  Record<HomeRoleKey, RbacRoleDefinition>
> = {
  admin: {
    key: 'admin',
    label: 'System Administrator',
    shortLabel: 'Admin',
    description:
      'Full platform, configuration, RBAC, and operational administration.',
    isBuiltIn: true,
    permissions: [...ALL_USER_PERMISSION_KEYS],
  },
  managing_partner: {
    key: 'managing_partner',
    label: 'Managing Partner / Practice Manager',
    shortLabel: 'Managing partner',
    description:
      'Firm-wide executive oversight across practice, finance, risk, HR, and document templates.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'employee:edit_core',
      'employee:hr_restricted',
      'employee:payroll',
      'employee:sensitive',
      'document_template:view',
      'document_template:build',
      'document_template:approve',
      'document_template:view_usage',
      'document_template:view_usage_by_user',
      'document_template:configure',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'document:delete',
      'document:provision',
      'document_store:configure',
      'document_access:review',
      'finance:view',
      'finance:view_matter',
      'finance:credit_control',
      'risk:view',
      'matter:create',
      'matter:edit',
      'matter:reassign_ownership',
      'matter:restricted:access',
      'matter:restriction:lift',
      'matter:costs:sign_off',
      'task:claim_any',
      'task:reassign_any',
      'task:edit',
      'task:comment',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'signoff:approve',
      'contact:create',
      'contact:edit',
      'record:merge',
      'admin:access',
      'keydate:view',
      'keydate:view_any_team',
      'keydate:edit',
      'keydate:verify',
      'keydate:resolve',
      'keydate:waive',
      'keydate:override_calculation',
    ],
  },
  partner: {
    key: 'partner',
    label: 'Partner / Head of Department',
    shortLabel: 'Partner',
    description:
      'Departmental leadership, matter supervision, finance visibility, and HR/team management.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'employee:edit_core',
      'employee:hr_restricted',
      'document_template:view',
      'document_template:view_usage',
      'document_template:configure',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'document:delete',
      'document:provision',
      'finance:view',
      'finance:view_matter',
      'finance:credit_control',
      'matter:create',
      'matter:edit',
      'matter:reassign_ownership',
      'matter:costs:sign_off',
      'task:claim_any',
      'task:edit',
      'task:comment',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'signoff:approve',
      'contact:create',
      'contact:edit',
      'admin:access',
      'keydate:view',
      'keydate:edit',
      'keydate:verify',
      'keydate:resolve',
      'keydate:waive',
      'keydate:override_calculation',
    ],
  },
  risk_compliance: {
    key: 'risk_compliance',
    label: 'Risk & Compliance (MLRO / COLP)',
    shortLabel: 'Risk & compliance',
    description:
      'AML/CDD oversight, conflict resolution, template approval, HR restricted compliance, and staff matter oversight.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'employee:edit_core',
      'employee:hr_restricted',
      'employee:sensitive',
      'document_template:view',
      'document_template:approve',
      'document_template:view_usage',
      'document_template:configure',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'document:delete',
      'document:provision',
      'document_access:review',
      'finance:view_matter',
      'risk:view',
      'matter:edit',
      'matter:restricted:access',
      'matter:restriction:lift',
      'task:edit',
      'task:comment',
      'enquiry:edit',
      'enquiry:close',
      'enquiry:anonymise',
      'quote:view',
      'contact:edit',
      'record:merge',
      'keydate:view',
      'keydate:view_any_team',
      'keydate:verify',
    ],
  },
  finance: {
    key: 'finance',
    label: 'Finance / Accounts / Credit Control',
    shortLabel: 'Finance',
    description:
      'Firm-wide billing, aged debt, credit control, client/office account balances, and employee payroll.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'employee:payroll',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'finance:view',
      'finance:view_matter',
      'finance:credit_control',
      'task:edit',
      'task:comment',
    ],
  },
  fee_earner: {
    key: 'fee_earner',
    label: 'Fee Earner',
    shortLabel: 'Fee earner',
    description:
      'Legal matter delivery, client care, document generation, and matter financial visibility.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'finance:view_matter',
      'matter:create',
      'matter:edit',
      'task:edit',
      'task:comment',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'contact:create',
      'contact:edit',
      'keydate:view',
      'keydate:edit',
      'keydate:resolve',
    ],
  },
  supervisor: {
    key: 'supervisor',
    label: 'Team Supervisor',
    shortLabel: 'Supervisor',
    description: 'Team supervision, task routing, and matter delivery.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'employee:edit_core',
      'employee:hr_restricted',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'document:delete',
      'document:provision',
      'finance:view_matter',
      'matter:create',
      'matter:edit',
      'matter:reassign_ownership',
      'task:claim_any',
      'task:reassign_any',
      'task:edit',
      'task:comment',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'contact:create',
      'contact:edit',
      'keydate:view',
      'keydate:edit',
      'keydate:verify',
      'keydate:resolve',
      'keydate:waive',
    ],
  },
  legal_secretary: {
    key: 'legal_secretary',
    label: 'Legal Secretary / PA',
    shortLabel: 'Legal secretary',
    description:
      'Administrative and document production support for fee earners.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'document:upload',
      'document:edit',
      'document:provision',
      'matter:create',
      'matter:edit',
      'task:edit',
      'task:comment',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'contact:create',
      'contact:edit',
      'keydate:view',
      'keydate:edit',
    ],
  },
  enquiries_coordinator: {
    key: 'enquiries_coordinator',
    label: 'Enquiries Coordinator',
    shortLabel: 'Enquiries',
    description:
      'New client intake, enquiry triage, and initial correspondence.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'matter:create',
      'task:edit',
      'task:comment',
      'enquiry:intake_view',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'contact:create',
      'contact:edit',
    ],
  },
  intake: {
    key: 'intake',
    label: 'Intake Coordinator',
    shortLabel: 'Intake',
    description:
      'New client intake, enquiry triage, and initial correspondence.',
    isBuiltIn: true,
    permissions: [
      'employee:view_core',
      'document_template:view',
      'document:generate',
      'document:view',
      'document:download',
      'task:edit',
      'task:comment',
      'enquiry:intake_view',
      'enquiry:create',
      'enquiry:edit',
      'enquiry:assign',
      'enquiry:close',
      'enquiry:reopen',
      'quote:view',
      'quote:edit',
      'contact:create',
      'contact:edit',
    ],
  },
};

export const DEFAULT_RBAC_RELATIONSHIP_GRANTS: readonly RbacRelationshipGrantRule[] =
  [
    {
      relationship: 'is_team_lead_of_any_team',
      permissions: [
        'employee:view_core',
        'employee:edit_core',
        'task:claim_any',
        'enquiry:assign',
        'enquiry:reopen',
        'keydate:view',
        'keydate:edit',
        'keydate:verify',
        'keydate:resolve',
        'keydate:waive',
      ],
      description:
        'Team leads and line managers can view and edit core employment records, claim unassigned tasks, assign/reopen enquiries, and verify/manage key dates.',
    },
    {
      relationship: 'is_line_manager_of_target',
      permissions: ['employee:view_core', 'employee:edit_core'],
      description:
        'Line managers and supervising partners can view and edit core employment records.',
    },
    {
      relationship: 'is_team_lead_of_target_team',
      permissions: ['task:reassign_any'],
      description:
        'Team leads can reassign tasks belonging to teams they lead.',
    },
  ] as const;

export const DEFAULT_RBAC_IDENTITY_MAPPING: RbacIdentityMappingConfig = {
  authorityMode: 'hybrid',
  entraGroupToRoleKey: {},
  entraAppRoleToRoleKey: {
    'Platform.Admin': ['admin'],
    'Platform.ManagingPartner': ['managing_partner', 'partner'],
    'Platform.Partner': ['partner'],
    'Platform.RiskCompliance': ['risk_compliance'],
    'Platform.Finance': ['finance'],
    'Platform.FeeEarner': ['fee_earner'],
    'Platform.Supervisor': ['supervisor'],
    'Platform.LegalSecretary': ['legal_secretary'],
    'Platform.EnquiriesCoordinator': ['enquiries_coordinator'],
    '1Squared.Admin': ['admin'],
    '1Squared.ManagingPartner': ['managing_partner', 'partner'],
    '1Squared.Partner': ['partner', 'fee_earner'],
    '1Squared.RiskCompliance': ['risk_compliance'],
    '1Squared.Finance': ['finance'],
    '1Squared.FeeEarner': ['fee_earner'],
    '1Squared.Supervisor': ['supervisor', 'fee_earner'],
    '1Squared.LegalSecretary': ['legal_secretary'],
    '1Squared.EnquiriesCoordinator': ['enquiries_coordinator'],
    '1Squared.Intake': ['intake'],
  },
  requireMfaForAdminPermissions: true,
  defaultRoleKeys: [],
  allowAcrsC1AsMfa: false,
  emailLinking: {
    enabled: true,
    domains: [],
  },
};

export function createDefaultRbacConfig(): RbacConfiguration {
  const roles: Record<string, RbacRoleDefinition> = {};
  for (const [key, def] of Object.entries(DEFAULT_RBAC_ROLES)) {
    roles[key] = {
      ...def,
      permissions: [...def.permissions],
    };
  }
  return {
    roles,
    departmentGrants: {},
    relationshipGrants: DEFAULT_RBAC_RELATIONSHIP_GRANTS.map((rule) => ({
      ...rule,
      permissions: [...rule.permissions],
    })),
    identityMapping: {
      authorityMode: DEFAULT_RBAC_IDENTITY_MAPPING.authorityMode,
      entraGroupToRoleKey: {
        ...DEFAULT_RBAC_IDENTITY_MAPPING.entraGroupToRoleKey,
      },
      entraAppRoleToRoleKey: Object.fromEntries(
        Object.entries(
          DEFAULT_RBAC_IDENTITY_MAPPING.entraAppRoleToRoleKey,
        ).map(([k, v]) => [k, [...v]]),
      ),
      requireMfaForAdminPermissions:
        DEFAULT_RBAC_IDENTITY_MAPPING.requireMfaForAdminPermissions,
      defaultRoleKeys: [...(DEFAULT_RBAC_IDENTITY_MAPPING.defaultRoleKeys ?? [])],
      allowAcrsC1AsMfa: DEFAULT_RBAC_IDENTITY_MAPPING.allowAcrsC1AsMfa ?? false,
      emailLinking: {
        enabled: DEFAULT_RBAC_IDENTITY_MAPPING.emailLinking?.enabled ?? true,
        domains: [...(DEFAULT_RBAC_IDENTITY_MAPPING.emailLinking?.domains ?? [])],
      },
    },
  };
}
