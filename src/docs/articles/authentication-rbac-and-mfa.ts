import type { DocArticle } from '../registry';

export const authenticationRbacAndMfaArticle: DocArticle = {
  slug: 'authentication-rbac-and-mfa',
  title: 'Sign-in, roles & permissions (RBAC) and multi-factor authentication (MFA)',
  section: 'architecture-security',
  summary:
    'How Microsoft Entra ID OIDC sign-in and sign-out work in 1Squared, how role-based access control (RBAC) and Entra identity mapping are configured, and which administrative actions require multi-factor authentication (MFA).',
  updated: '2026-11-04',
  body: `
1Squared authenticates every user through **Microsoft Entra ID (OpenID Connect with PKCE)** and evaluates access on every server action and API route through the central **Role-Based Access Control (RBAC)** engine in \`@platform/core\`.

## 1. Signing in and signing out with Microsoft Entra ID

- **OIDC Authorization Code Flow with PKCE**: Selecting **Sign in with Microsoft** initiates a PKCE challenge (\`S256\`) with a random cryptographic \`state\` and \`nonce\` stored in a signed \`httpOnly\` cookie (\`onesquared_entra_pkce\`).
- **Cryptographic Token Verification**: On callback (\`/api/auth/callback/microsoft-entra-id\`), 1Squared exchanges the authorization code for an ID token and verifies its RS256 signature against Microsoft Entra’s JWKS discovery endpoint, along with \`aud\`, \`tid\`, \`iss\`, \`nonce\`, \`exp\`, \`nbf\`, and \`iat\` claims.
- **Signed Session Cookie**: Once verified, 1Squared issues an HMAC-SHA256 signed \`httpOnly\` session cookie (\`onesquared_entra_session\`). The acting user identity is resolved exclusively from this verified session—never from client-writable cookies, URL parameters, or form fields.
- **CSRF-Safe Sign-Out**: Signing out from the account menu submits a \`POST\` request to \`/api/auth/logout\` (\`GET\` requests return \`405 Method Not Allowed\`), clearing the session cookie immediately.
- **Demo Mode User Switching**: Switching between seeded personas (\`demo: true\`) is blocked in production (\`NODE_ENV === 'production'\`) and in \`live\` tenant environments (\`enableDemoMode\` cannot be \`true\` when \`environment === 'live'\`). When \`featureFlags.enableDemoMode\` is enabled in a non-live, non-production tenant configuration (\`isDemoModeEnabled() === true\`; \`homePagesConfig.firmSettings.demoMode\` is derived from \`isDemoModeEnabled()\` and cannot be set independently), a signed-in user can only switch to a demo persona (\`demo: true\`) whose permissions are a subset of the permissions the signed-in user already holds and who does not have access to any restricted or staff matter (\`restrictedAccessUserIds\`) that the signed-in user cannot access.

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

- **Core Administration & RBAC**: \`admin:access\`, \`rbac:manage_config\`, \`rbac:manage_user_overrides\`
- **Employee & HR Records**: \`employee:view_core\`, \`employee:edit_core\`, \`employee:hr_restricted\`, \`employee:payroll\`, \`employee:sensitive\`
- **Matters & Restricted Matters**: \`matter:create\`, \`matter:edit\`, \`matter:reassign_ownership\` (granted to \`partner\`, \`managing_partner\`, and \`admin\`, and not granted automatically to team leads via \`is_team_lead_of_any_team\`), \`matter:restricted:access\`
- **Finance & Risk**: \`finance:view\`, \`finance:view_matter\`, \`finance:credit_control\`, \`finance:manage_links\`, \`risk:view\`
- **Document Templates & SharePoint DMS**: \`document_template:view\`, \`document_template:build\`, \`document_template:approve\`, \`document_template:view_usage\`, \`document_template:view_usage_by_user\`, \`document_template:configure\`, \`document:generate\`, \`document:view\`, \`document:download\`, \`document:upload\`, \`document:edit\`, \`document:delete\`, \`document:provision\`, \`document_store:configure\`, \`document_access:review\`
- **Key Dates & Limitation**: \`keydate:view\`, \`keydate:view_any_team\`, \`keydate:edit\`, \`keydate:verify\`, \`keydate:override_calculation\`, \`keydate:resolve\`, \`keydate:waive\`, \`keydate:configure\`

### Per-person permission overrides & escalation guards

In **Admin → RBAC & Entra ID**, administrators holding \`rbac:manage_user_overrides\` can grant or revoke individual permissions on a specific employee record (with live effective-permission previews computed on the server via \`previewRbacOverridesAction\` and \`resolvePersonPermissions\`) and bind their Entra Object ID. Three mandatory security invariants apply to all role and override changes:

1. **No Self-Modification**: No user—including a System Administrator—can modify their own roles or permission overrides.
2. **No Granting Unheld Permissions**: A user cannot grant a permission or assign a role containing a permission that the acting user does not themselves hold.
3. **Before/After Audit Trail**: Every change to employee roles, \`appRole\`, \`permissionOverrides\`, or tenant RBAC configuration writes a structured before/after JSON audit entry.

## 4. Multi-factor authentication (MFA) enforcement

1Squared inspects the \`amr\` (Authentication Methods References) claim in the verified Microsoft Entra ID token for \`mfa\`, \`fido\`, \`rsa\`, \`hwk\`, or \`ngcmfa\` (and optionally \`acrs: c1\` only when \`allowAcrsC1AsMfa\` is enabled in tenant configuration).

Even if a user holds an administrative or partner role, **MFA verification (\`mfaVerified === true\`) is strictly required** before the server permits any high-privilege action, including:

- Accessing the \`/admin\` console (\`admin:access\`)
- Modifying tenant RBAC roles or Entra ID mappings (\`rbac:manage_config\`)
- Changing an employee’s roles or permission overrides (\`rbac:manage_user_overrides\`)
- Viewing or editing payroll and sensitive HR records (\`employee:payroll\`, \`employee:sensitive\`)
- Accessing staff or restricted matters (\`matter:restricted:access\`), or lifting a staff/ethical-wall restriction on a matter (\`liftMatterRestriction\`, requiring \`admin:access\` or \`matter:restricted:access\`, \`mfaVerified === true\`, and a mandatory audit reason)
- Approving document templates or configuring SharePoint stores (\`document_template:approve\`, \`document_template:configure\`, \`document_store:configure\`)
- Overriding limitation calculations, waiving key dates, or changing key date rules (\`keydate:override_calculation\`, \`keydate:waive\`, \`keydate:configure\`)
`,
};
