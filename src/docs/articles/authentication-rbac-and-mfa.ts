import type { DocArticle } from '../registry';

export const authenticationRbacAndMfaArticle: DocArticle = {
  slug: 'authentication-rbac-and-mfa',
  title: 'Sign-in, roles & permissions (RBAC) and multi-factor authentication (MFA)',
  section: 'architecture-security',
  summary:
    'How Microsoft Entra ID OIDC sign-in and sign-out work in 1Squared, how role-based access control (RBAC) and Entra identity mapping are configured, and which administrative actions require multi-factor authentication (MFA).',
  updated: '2026-11-13',
  body: `
1Squared authenticates every user through **Microsoft Entra ID (OpenID Connect with PKCE)** and evaluates access on every server action and API route through the central **Role-Based Access Control (RBAC)** engine in \`@platform/core\`.

### How access is enforced
Every server action in \`src/app/actions.ts\` and every API route handler under \`src/app/api/\` is registered in \`src/server/actionPermissions.ts\` and wrapped by \`guardedAction\` or \`guardedRoute\` (\`src/server/authorize.ts\`, ADR 0025). Unattended Container Apps jobs are registered in \`JOB_PERMISSIONS\` (\`src/server/actionPermissions.ts\`) and wrapped per tenant by \`guardedJob\` (\`src/server/authorize.ts\` and \`scripts/run-job.ts\`, ADR 0030). On each user request, the wrapper verifies the signed Entra ID session, builds the tenant context from the verified token claims, and resolves the user’s effective permissions (including the session’s real \`mfaVerified\` status) before executing the action or service check (such as \`rbac:manage_config\`, \`admin:access\`, \`matter:create\`, \`matter:edit\`, and \`matter:restricted:access\`). Automated CI guard tests verify that no server action, route handler, or background job can be added without a registered permission policy.

## 1. Signing in and signing out with Microsoft Entra ID

- **OIDC Authorization Code Flow with PKCE**: Selecting **Sign in with Microsoft** initiates a PKCE challenge (\`S256\`) with a random cryptographic \`state\` and \`nonce\` stored in a signed \`httpOnly\` cookie (\`onesquared_entra_pkce\`).
- **Cryptographic Token Verification**: On callback (\`/api/auth/callback/microsoft-entra-id\`), 1Squared exchanges the authorization code for an ID token and verifies its RS256 signature against Microsoft Entra’s JWKS discovery endpoint, along with \`aud\`, \`tid\`, \`iss\`, \`nonce\`, \`exp\`, \`nbf\`, and \`iat\` claims.
- **Signed Session Cookie**: Once verified, 1Squared issues an HMAC-SHA256 signed \`httpOnly\` session cookie (\`onesquared_entra_session\`). The acting user identity is resolved exclusively from this verified session—never from client-writable cookies, URL parameters, or form fields.
- **CSRF-Safe Sign-Out**: Signing out from the account menu submits a \`POST\` request to \`/api/auth/logout\` (\`GET\` requests return \`405 Method Not Allowed\`), clearing the session cookie immediately.
- **Demo Mode User Switching**: Switching between seeded personas (\`demo: true\`) is governed by tenant configuration (\`isNonLiveDemoEnvironment()\`), not by \`NODE_ENV\` or the build type (Rule 6; see [Demo environment](/docs/demo-environment)). It is allowed only when the tenant \`environment\` is \`dev\`, \`test\`, \`training\`, or \`demo\` (never \`live\`, where \`enableDemoMode\` cannot be \`true\`) and \`featureFlags.enableDemoMode\` is \`true\`. The account menu hides the demo persona switcher whenever \`featureFlags.enableDemoMode\` is \`false\`. When \`isDemoModeEnabled() === true\` (\`homePagesConfig.firmSettings.demoMode\` is derived from \`isDemoModeEnabled()\` and cannot be set independently), a signed-in user can only switch to a demo persona (\`demo: true\`) whose permissions are a subset of the permissions the signed-in user already holds and who does not have access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.
- **Role Preview ("Viewing as" Header Switcher)**: Multi-role employees can switch their active **Viewing as** role in the top bar between their assigned roles, and System Administrators holding the built-in \`admin\` role (\`canPreviewAnyHomeRole\`) can select any configured Home role in the **Viewing as** dropdown (\`switchViewingRole\` and \`resolveActiveViewingRole\`) to preview role-specific Home workspaces and left-rail navigation without changing their underlying RBAC permissions.

## 2. Employee matching, provisioning & authority modes

When a user signs in with Microsoft Entra ID, 1Squared resolves their employee record in the following order:

1. **Entra Object ID (\`oid\`)**: Matches the immutable \`entraObjectId\` bound to the employee’s Person record.
2. **Verified-Domain First-Time Work Email Link (\`rbac.identityMapping.emailLinking\`, S0-30)**: If no employee record has that \`oid\` and \`rbac.identityMapping.emailLinking.enabled\` is \`true\` (default), 1Squared links by email only when **all** of the following conditions hold:
   - **Verified identifier in an allowed linking domain**: 1Squared prefers the directory sign-in name (\`preferred_username\` or \`upn\`) over \`email\`, and only accepts \`email\` when the token marks it as domain-verified (\`xms_edov === true\`). The address’s domain must belong to \`rbac.identityMapping.emailLinking.domains\` (or the tenant’s \`branding.primaryDomain\` when \`domains\` is \`[]\`).
   - **Single unbound employee match (\`public.person_emails\`, \`R410\`, \`S0-16\`)**: Exactly one active employee without an existing \`entraObjectId\` matches the normalised active email address across all active contact emails (\`person.emails\`) and \`employment.systems.firmWorkEmail\` indexed in PostgreSQL \`public.person_emails\` (\`TenantPartyRepository.findActivePeopleByEmail\`, refreshed in the same transaction on every person write). If more than one unbound employee shares the address, none is bound, no duplicate employee is provisioned, an \`Entra ID Email Link Ambiguous\` audit entry (\`action: 'entra-link'\`) is recorded with the matching person IDs and \`correlationId\` only (never logging the email address or \`oid\`), and sign-in is denied with \`"Your account needs to be linked by an administrator."\`.
   - **Non-privileged target only**: Automatic email linking never binds an employee whose resolved roles or permissions include any permission with \`requiresMfa: true\` or \`sensitivity: 'critical'\` (such as \`admin\`, System Administrator, Managing Partner, Partner, or Risk & Compliance). When a sign-in matches an unbound privileged employee by email, 1Squared refuses the link without provisioning a duplicate record, records an \`Entra ID Email Link Refused\` audit entry (\`action: 'entra-link'\`) with \`personId\` and \`correlationId\` only, and denies sign-in with \`"Your account needs to be linked by an administrator."\`. Privileged employees must be bound explicitly by an administrator via \`updatePersonPermissionOverrides\` (**Admin → RBAC & Entra ID**, requiring \`rbac:manage_user_overrides\` and MFA) or during demo provisioning via \`seed:demo --entra-map\`.
   - **Distinct Audit Action**: When an eligible employee is linked on first sign-in, 1Squared binds their \`entraObjectId\` and records an audit entry with \`action: 'entra-link'\` and field \`Entra ID Email Link\`. Server logs record only \`personId\`, \`correlationId\`, and \`tenantId\`.
3. **Zero-Privilege Default Provisioning**: If no existing employee matches, a new employee record is provisioned using only verified token identifiers (\`preferred_username\`, \`upn\`, or \`email\` when \`xms_edov === true\`) and the roles configured in \`rbac.identityMapping.defaultRoleKeys\` (which defaults to \`[]\`, granting no administrative privileges until roles are assigned).

### Setting or changing an employee’s sign-in email (S0-30)

Adding, changing, or removing any active email address (\`person.emails\` or \`person.employment.systems.firmWorkEmail\` after employment defaults and work-contact sync, including addresses synthesised on new or promoted employees) on a record that is, was, or will be an employee or leaver (including creating a new employee, promoting an existing contact to an employee, marking a leaver, or creating an employee from PMS via \`createRecordFromPms\`) is treated as an **identity change** in \`savePersonRecord\` and \`savePersonAction\`:
- Every employee or leaver email change requires \`employee:edit_core\` (users holding only \`contact:edit\` receive \`ActionDenied\` with \`FORBIDDEN\`).
- **Multi-factor authentication (\`mfaVerified === true\`) is required when adding or changing a sign-in address to a new value** (including creating or promoting an employee, replacing an address, or setting a new \`firmWorkEmail\`), returning \`ActionDenied\` (\`MFA_REQUIRED\`) with no partial changes written when MFA is missing. Removing or deactivating an address (such as marking an employee as a leaver, removing a secondary address, or clearing \`firmWorkEmail\`) does not require MFA, while still requiring \`employee:edit_core\`.
- Normalised active addresses (trimmed, lower-case, \`active !== false\`) are compared, so reordering addresses or changing an email type label does not trigger an identity change.
- Allowed changes (both additions and removals) write a dedicated audit entry with field \`Employee sign-in email\` showing the previous and new active addresses, while preserving any existing \`entraObjectId\` binding.

### Authority modes (\`hybrid\` vs \`token_only\`)

Administrators can configure \`rbac.identityMapping.authorityMode\` in **Admin → RBAC & Entra ID**:

| Authority Mode | How Roles Are Resolved |
| --- | --- |
| \`hybrid\` (default) | Combines roles mapped from the current Entra ID token (\`groups\` and \`roles\` claims) with the roles stored on the employee’s 1Squared profile, resolved strictly from the active \`AsyncLocalStorage\` request scope (\`runWithActiveActorSession\`) for that exact \`(tenantId, personId)\` (honouring the verified session’s expiry), with no server-wide mutable session map and without permanently overwriting stored 1Squared roles or leaking across concurrent requests. |
| \`token_only\` | Uses exclusively the roles mapped from the Microsoft Entra ID token on each sign-in (including replacing stored roles with \`[]\` if all Entra roles are removed). |

## 3. Roles, permissions & per-person overrides

Permissions are grouped into built-in and custom roles in the tenant RBAC configuration:

- **Core Administration & RBAC**: \`admin:access\`, \`admin:data_reset\` (granted to \`admin\` only, requiring MFA), \`rbac:manage_config\`, \`rbac:manage_user_overrides\`
- **Employee & HR Records**: \`employee:view_core\`, \`employee:edit_core\`, \`employee:hr_restricted\`, \`employee:payroll\`, \`employee:sensitive\`
- **Contacts & Organisations**: \`contact:create\`, \`contact:edit\`
- **Matters, Sign-offs & Restricted Matters**: \`matter:create\`, \`matter:edit\`, \`matter:reassign_ownership\` (granted to \`supervisor\`, \`partner\`, \`managing_partner\`, and \`admin\`, and not granted automatically to team leads via \`is_team_lead_of_any_team\`), \`matter:restricted:access\`, \`matter:restriction:lift\` (granted to \`managing_partner\`, \`risk_compliance\`, and \`admin\`, requiring MFA), \`matter:costs:sign_off\` (granted to \`partner\`, \`managing_partner\`, and \`admin\` to sign off high-value matter fee estimates via \`signOffMatterCostsRecord\` / \`signOffMatterCostsAction\`), \`signoff:approve\` (granted to \`partner\`, \`managing_partner\`, and \`admin\` for partner sign-off items)
- **Enquiries, Finance & Risk**: \`enquiry:intake_view\`, \`enquiry:anonymise\` (granted to \`risk_compliance\` and \`admin\`), \`finance:view\` (firm-wide PMS roll-ups via \`getFirmFinance\`, excluding restricted matters), \`finance:view_matter\` (matter-level and client PMS figures via \`getMatterFinanceRows\`, \`getMyFinanceFigures\`, \`getMatterPmsViewBundle\`, and \`getClientPmsViewBundle\`), \`finance:credit_control\` (required by \`requestMatterBillAction\`, \`flagMatterWriteOffAction\`, and \`recordInvoiceCreditControlActionAction\`, along with matter access; see [Finance data and permissions](/docs/finance-data-and-permissions)), \`finance:manage_links\`, \`risk:view\`
- **Document Templates & SharePoint DMS**: \`document_template:view\`, \`document_template:build\`, \`document_template:approve\`, \`document_template:view_usage\`, \`document_template:view_usage_by_user\`, \`document_template:configure\`, \`document:generate\`, \`document:view\`, \`document:download\`, \`document:upload\`, \`document:edit\`, \`document:delete\`, \`document:provision\`, \`document_store:configure\`, \`document_access:review\`
- **Key Dates & Limitation**: \`keydate:view\`, \`keydate:view_any_team\`, \`keydate:edit\`, \`keydate:verify\`, \`keydate:override_calculation\`, \`keydate:resolve\`, \`keydate:waive\`, \`keydate:configure\`
- **Background Job-Only Permissions (\`jobOnly: true\`, ADR 0030)**: \`tenant:migrate\`, \`keydate:run_reminders\`, \`document_generation:purge_usage\`, and \`enquiry:run_retention_anonymise\`. These four permissions are reserved exclusively for unattended background jobs executed through \`guardedJob(jobKey, ...)\` (\`system:migrate\`, \`system:key-date-reminders\`, \`system:usage-retention-purge\`, and \`system:enquiry-retention-anonymise\`). No built-in or custom role (\`admin\` included) holds any \`jobOnly\` permission (\`ALL_USER_PERMISSION_KEYS\` vs \`ALL_JOB_ONLY_PERMISSION_KEYS\`), and \`resolvePermissions\`, \`resolvePersonPermissionSet\`, \`updatePersonPermissionOverrides\`, and \`updateTenantRbacConfig\` strip or reject any attempt to grant a \`jobOnly\` permission to a person, role, or department (\`FORBIDDEN\`).

### Per-person permission overrides & escalation guards

In **Admin → RBAC & Entra ID**, administrators holding \`rbac:manage_user_overrides\` can grant or revoke individual permissions on a specific employee record (with live debounced effective-permission previews computed on the server via \`previewRbacOverridesAction\` and \`resolvePersonPermissions\`, requiring \`rbac:manage_user_overrides\`, \`rbac:manage_config\`, or \`admin:access\`, \`mfaVerified === true\`, and schema-valid \`rbacConfig\`) and bind their Entra Object ID. Three mandatory security invariants apply to all role and override changes:

1. **No Self-Modification**: No user—including a System Administrator—can modify their own roles or permission overrides, or add themselves as a team lead (\`leadIds\`) in **Admin → Teams** (\`saveTeamAction\` / \`saveTeamRecord\`, which enforces \`SELF_MODIFICATION_FORBIDDEN\` because team leadership grants relationship permissions such as \`employee:edit_core\`).
2. **No Granting Unheld Permissions**: A user cannot grant a permission or assign a role containing a permission that the acting user does not themselves hold.
3. **Dedicated RBAC Actions Only**: Security and role fields (\`roles\`, \`permissionOverrides\`, \`appRole\`, \`employeePermissions\`, \`documentPermissions\`, \`supportsIds\`, \`showsWorkOfId\`, \`demo\`, and \`entraObjectId\`) can only be changed through the dedicated RBAC administration screens and actions (\`updateEmployeeRoleSetting\`, \`updateEmployeeRolesAndSupports\`, and \`updatePersonPermissionOverrides\`). Any attempt to set or change these fields through the general person save form (\`savePersonAction\` / \`savePersonRecord\`) is rejected with \`ActionDenied\`, and existing values (including \`entraObjectId\`) are preserved.
4. **Before/After Audit Trail**: Every change to employee roles, \`appRole\`, \`permissionOverrides\`, or tenant RBAC configuration writes a structured before/after JSON audit entry.

## 4. Multi-factor authentication (MFA) enforcement

1Squared inspects the \`amr\` (Authentication Methods References) claim in the verified Microsoft Entra ID token for \`mfa\`, \`fido\`, \`rsa\`, \`hwk\`, or \`ngcmfa\` (and optionally \`acrs: c1\` only when \`allowAcrsC1AsMfa\` is enabled in tenant configuration).

Even if a user holds an administrative or partner role, **MFA verification (\`mfaVerified === true\`) is strictly required** before the server permits any high-privilege action, including:

- Accessing the \`/admin\` console and saving any administrative configuration (\`admin:access\`, enforced at the action boundary via \`guardedAction\`):
  - **Choice lists & matter stage groups**: adding, updating, or reordering list values (\`addChoiceValueAction\`, \`updateChoiceValueAction\`, \`reorderChoiceValueAction\`) and creating matter stage groups (\`createMatterStageGroupAction\`).
  - **Custom fields**: creating, updating, or reordering custom field definitions (\`saveCustomFieldAction\`, \`reorderCustomFieldAction\`).
  - **Teams & firm settings**: creating or updating teams (\`saveTeamAction\`, which also prevents an administrator from adding themselves to \`leadIds\`), enquiry settings (\`saveEnquirySettingsAction\`), automatic task templates (\`saveTaskSettingsAction\`), and the organisation structure hierarchy (\`saveOrgStructureAction\`).
  - **Matter party taxonomy & work-type profiles**: saving, reordering, or deleting matter party relationships and capacities (\`saveMatterPartyRelationshipAction\`, \`reorderMatterPartyRelationshipAction\`, \`deleteMatterPartyRelationshipAction\`, \`saveMatterPartyCapacityAction\`, \`deleteMatterPartyCapacityAction\`) and updating work-type profile mappings (\`updateWorkTypeProfilesAction\`).
  - **Matter costs & PMS rate sync**: saving matter costs configuration and rate cards (\`saveMatterCostsConfigAction\`) and pulling fee earner rates from the PMS (\`syncMatterCostsRatesFromPmsAction\`).
  - **Creating 1Squared records from PMS**: \`createRecordFromPmsAction\` requires \`admin:access\` with MFA plus the record-specific creation permission (\`employee:edit_core\` for employees, \`matter:create\` for matters, and \`contact:create\` for people and organisations).
- Linking, unlinking, or re-running automatic Practice Management System (PMS) record matching (\`linkPmsRecordAction\`, \`unlinkPmsRecordAction\`, and \`rerunAutomaticPmsMatchingAction\`, which require \`finance:manage_links\` with MFA)
- Resetting or clearing non-live environment data (\`admin:data_reset\`, restricted to \`admin\` only with MFA)
- Modifying tenant RBAC roles or Entra ID mappings (\`rbac:manage_config\`)
- Changing an employee’s roles or permission overrides (\`rbac:manage_user_overrides\`)
- Adding or changing an employee’s or leaver’s sign-in email address to a new value (\`employee:edit_core\` with \`mfaVerified === true\` in \`savePersonAction\` / \`savePersonRecord\`; removing or deactivating an address still requires \`employee:edit_core\` and is audited, without requiring MFA)
- Viewing or editing payroll and sensitive HR records (\`employee:payroll\`, \`employee:sensitive\`)
- Accessing staff or restricted matters (\`matter:restricted:access\`), or lifting a staff/ethical-wall restriction on a matter (\`liftMatterRestriction\`, requiring \`matter:restriction:lift\`, \`mfaVerified === true\`, and a mandatory audit reason)
- Approving document templates or configuring SharePoint stores (\`document_template:approve\`, \`document_template:configure\`, \`document_store:configure\`)
- Overriding limitation calculations, waiving key dates, or changing key date rules (\`keydate:override_calculation\`, \`keydate:waive\`, \`keydate:configure\`)
`,
};
