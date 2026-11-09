import type { DocArticle } from '../registry';

export const authenticationRbacAndMfaArticle: DocArticle = {
  slug: 'authentication-rbac-and-mfa',
  title: 'Sign-in, roles & permissions (RBAC) and multi-factor authentication (MFA)',
  section: 'architecture-security',
  summary:
    'How Microsoft Entra ID OIDC sign-in and sign-out work in 1Squared, how role-based access control (RBAC) and Entra identity mapping are configured, and which administrative actions require multi-factor authentication (MFA).',
  updated: '2026-11-07',
  body: `
1Squared authenticates every user through **Microsoft Entra ID (OpenID Connect with PKCE)** and evaluates access on every server action and API route through the central **Role-Based Access Control (RBAC)** engine in \`@platform/core\`.

### How access is enforced
Every server action in \`src/app/actions.ts\` and every API route handler under \`src/app/api/\` is registered in \`src/server/actionPermissions.ts\` and wrapped by \`guardedAction\` or \`guardedRoute\` (\`src/server/authorize.ts\`, ADR 0025). On each request, the wrapper verifies the signed Entra ID session, builds the tenant context from the verified token claims, and resolves the user’s effective permissions (including the session’s real \`mfaVerified\` status) before executing the action or service check (such as \`rbac:manage_config\`, \`admin:access\`, \`matter:create\`, \`matter:edit\`, and \`matter:restricted:access\`). Automated CI guard tests verify that no server action or route handler can be added without a registered permission policy.

## 1. Signing in and signing out with Microsoft Entra ID

- **OIDC Authorization Code Flow with PKCE**: Selecting **Sign in with Microsoft** initiates a PKCE challenge (\`S256\`) with a random cryptographic \`state\` and \`nonce\` stored in a signed \`httpOnly\` cookie (\`onesquared_entra_pkce\`).
- **Cryptographic Token Verification**: On callback (\`/api/auth/callback/microsoft-entra-id\`), 1Squared exchanges the authorization code for an ID token and verifies its RS256 signature against Microsoft Entra’s JWKS discovery endpoint, along with \`aud\`, \`tid\`, \`iss\`, \`nonce\`, \`exp\`, \`nbf\`, and \`iat\` claims.
- **Signed Session Cookie**: Once verified, 1Squared issues an HMAC-SHA256 signed \`httpOnly\` session cookie (\`onesquared_entra_session\`). The acting user identity is resolved exclusively from this verified session—never from client-writable cookies, URL parameters, or form fields.
- **CSRF-Safe Sign-Out**: Signing out from the account menu submits a \`POST\` request to \`/api/auth/logout\` (\`GET\` requests return \`405 Method Not Allowed\`), clearing the session cookie immediately.
- **Demo Mode User Switching**: Switching between seeded personas (\`demo: true\`) is blocked in production (\`NODE_ENV === 'production'\`) and in \`live\` tenant environments (\`enableDemoMode\` cannot be \`true\` when \`environment === 'live'\`). The account menu hides the demo persona switcher whenever \`featureFlags.enableDemoMode\` is \`false\`. When \`featureFlags.enableDemoMode\` is enabled in a non-live, non-production tenant configuration (\`isDemoModeEnabled() === true\`; \`homePagesConfig.firmSettings.demoMode\` is derived from \`isDemoModeEnabled()\` and cannot be set independently), a signed-in user can only switch to a demo persona (\`demo: true\`) whose permissions are a subset of the permissions the signed-in user already holds and who does not have access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.
- **Role Preview ("Viewing as" Header Switcher)**: Multi-role employees can switch their active **Viewing as** role in the top bar between their assigned roles, and System Administrators holding the built-in \`admin\` role (\`canPreviewAnyHomeRole\`) can select any configured Home role in the **Viewing as** dropdown (\`switchViewingRole\` and \`resolveActiveViewingRole\`) to preview role-specific Home workspaces and left-rail navigation without changing their underlying RBAC permissions.

## 2. Employee matching, provisioning & authority modes

When a user signs in with Microsoft Entra ID, 1Squared resolves their employee record in the following order:

1. **Entra Object ID (\`oid\`)**: Matches the immutable \`entraObjectId\` bound to the employee’s Person record.
2. **First-Time Work Email Link**: If no employee record has that \`oid\`, 1Squared matches an active employee with the same primary work email **only if that employee does not already have an \`entraObjectId\` set**, binds the \`oid\`, and writes an \`Entra ID Email Link\` audit entry.
3. **Zero-Privilege Default Provisioning**: If no existing employee matches, a new employee record is provisioned with the roles configured in \`rbac.identityMapping.defaultRoleKeys\` (which defaults to \`[]\`, granting no administrative privileges until roles are assigned).

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

### Per-person permission overrides & escalation guards

In **Admin → RBAC & Entra ID**, administrators holding \`rbac:manage_user_overrides\` can grant or revoke individual permissions on a specific employee record (with live debounced effective-permission previews computed on the server via \`previewRbacOverridesAction\` and \`resolvePersonPermissions\`, requiring \`rbac:manage_user_overrides\`, \`rbac:manage_config\`, or \`admin:access\`, \`mfaVerified === true\`, and schema-valid \`rbacConfig\`) and bind their Entra Object ID. Three mandatory security invariants apply to all role and override changes:

1. **No Self-Modification**: No user—including a System Administrator—can modify their own roles or permission overrides, or add themselves as a team lead (\`leadIds\`) in **Admin → Teams** (\`saveTeamAction\` / \`saveTeamRecord\`, which enforces \`SELF_MODIFICATION_FORBIDDEN\` because team leadership grants relationship permissions such as \`employee:edit_core\`).
2. **No Granting Unheld Permissions**: A user cannot grant a permission or assign a role containing a permission that the acting user does not themselves hold.
3. **Dedicated RBAC Actions Only**: Security and role fields (\`roles\`, \`permissionOverrides\`, \`appRole\`, \`employeePermissions\`, \`documentPermissions\`, \`supportsIds\`, \`showsWorkOfId\`, and \`demo\`) can only be changed through the dedicated RBAC administration screens and actions (\`updateEmployeeRoleSetting\`, \`updateEmployeeRolesAndSupports\`, and \`updatePersonPermissionOverrides\`). Any attempt to set or change these fields through the general person save form (\`savePersonAction\` / \`savePersonRecord\`) is rejected with \`ActionDenied\`, and existing values (including \`entraObjectId\`) are preserved.
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
- Viewing or editing payroll and sensitive HR records (\`employee:payroll\`, \`employee:sensitive\`)
- Accessing staff or restricted matters (\`matter:restricted:access\`), or lifting a staff/ethical-wall restriction on a matter (\`liftMatterRestriction\`, requiring \`matter:restriction:lift\`, \`mfaVerified === true\`, and a mandatory audit reason)
- Approving document templates or configuring SharePoint stores (\`document_template:approve\`, \`document_template:configure\`, \`document_store:configure\`)
- Overriding limitation calculations, waiving key dates, or changing key date rules (\`keydate:override_calculation\`, \`keydate:waive\`, \`keydate:configure\`)
`,
};
