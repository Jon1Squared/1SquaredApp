# ADR-0018: Two-Identity Authentication Model (Delegated User OBO and Application Provisioning)

- **Date:** 2026-11-02
- **Status:** Accepted
- **Related:** [ADR-0012](../../../docs/decisions/0012-role-source-of-truth-and-entra-identity-mapping.md), [ADR-0017](./0017-document-store-provider-abstraction.md)

## Context

Law firms require that when a fee earner, partner, or support staff member views, uploads, downloads, edits, renames, moves, or deletes a matter document from inside 1Squared:
1. The external document store (SharePoint Online) must enforce **that individual user's own permissions** in real time.
2. SharePoint's native version history and Microsoft Purview audit trail must record **the individual user's Entra identity**, never a shared service account.
3. Conversely, users must not be granted direct SharePoint site-administration rights just so 1Squared can create department/team/matter folder structures or manage ACL exceptions when a matter opens or changes team.

In addition, 1Squared supports both **Model A (`single_tenant`, client-hosted Azure)** and **Model B (`multi_tenant`, 1Squared-hosted)** with a single build artefact (`docs/architecture-standard.md` Section 7).

## Decision

### 1. Strict Separation of Two Identities

Every interaction with SharePoint Online uses one of two strictly separated identities:

| Context | Identity Type | Flow / Credential | Permitted Operations | Forbidden Operations |
| :--- | :--- | :--- | :--- | :--- |
| `user` (`UserAccessContext`) | Signed-in user (Delegated) | OAuth 2.0 On-Behalf-Of (OBO) flow (`urn:ietf:params:oauth:grant-type:jwt-bearer`) | `listItems`, `getItem`, `downloadContent`, `uploadContent`, `createFolder`, `renameItem`, `moveItem`, `deleteItem`, `getWebUrl`, `getEffectiveAccess` | Breaking/restoring ACL inheritance, granting/revoking permissions, background jobs |
| `provisioning` (`ProvisioningAccessContext`) | Application identity (App-only) | Certificate in Azure Key Vault (`credentialRef`) or Managed Identity (Model A) | `testConnection`, `resolveLocation`, `ensureFolderTree`, `getPermissions`, `setPermissions`, `resolvePrincipal` | Any user-facing browse, search, download, upload, rename, move, or delete endpoint |

An architectural invariant enforced in code and verified by security tests is: **user-facing HTTP routes and server actions never instantiate or invoke `ProvisioningAccessContext` for file/folder access**.

### 2. Evaluation of Delegated Microsoft Graph Permissions (`user` Context)

We evaluated Microsoft Graph's delegated permission scopes for SharePoint `driveItem` access:
1. **`Sites.Selected` (Delegated):** Microsoft Graph exposes `Sites.Selected` as both an application permission and a delegated permission. When granted as a delegated permission and paired with a site-level permission grant (`POST /sites/{siteId}/permissions` granting `read` or `write` to the 1Squared client application), the OBO token is restricted to **only** the SharePoint sites explicitly authorised for 1Squared, while SharePoint still enforces the signed-in user's own item/folder ACLs (`effectivePermissions = intersection(userSharePointACL, appDelegatedScope)`).
2. **`Files.ReadWrite.All` (Delegated):** Also enforces the signed-in user's own SharePoint ACLs (the user cannot access any site or file they do not already have SharePoint rights to), but allows the OBO token to reach any SharePoint site or OneDrive the user has access to across the tenant.

**Decision:** Default to **delegated `Sites.Selected`** as the primary recommended scope (`userAccess.delegatedScope: 'Sites.Selected' | 'Files.ReadWrite.All'`, defaulting to `'Sites.Selected'`). Because both permissions evaluate the intersection of the app's delegated grant and the user's SharePoint permissions, `Sites.Selected` provides the narrowest blast radius (restricting the app to the firm's designated matter repository site(s) only), while `Files.ReadWrite.All` remains configurable for firms that prefer not to create a second site-permission grant for the delegated client ID.

### 3. Application Provisioning Permission (`provisioning` Context)

- The provisioning identity uses **application `Sites.Selected`** (`https://graph.microsoft.com/.default`) authenticated with an X.509 certificate stored in Azure Key Vault (`credentialRef: "kv://<vault>/<secret>"`) or, in Model A (`single_tenant`), an Azure Managed Identity when configured.
- The firm's SharePoint administrator grants the provisioning app `fullcontrol` on the specific target SharePoint site(s) only via `POST /sites/{siteId}/permissions` (`roles: ["fullcontrol"]`).
- `fullcontrol` at the site level is required by Microsoft Graph / SharePoint REST API to manage folder role assignments and break/restore role inheritance (`setPermissions`).
- Tenant-wide `Sites.FullControl.All` and `Sites.ReadWrite.All` application permissions are **never** requested or used.

### 4. Both Hosting Models with One Build

- **Model A (`single_tenant`):** Supports either a Managed Identity or a single-tenant Entra App Registration in the client's Entra ID tenant, with certificates stored in the client's Key Vault.
- **Model B (`multi_tenant`):** Supports either a per-tenant App Registration or a multi-tenant App Registration consented in the client's Entra ID tenant (`entraTenantId`), with per-tenant certificates stored in our Key Vault under `kv-<tenantId>-<env>`.

### 5. Per-Tenant, Per-User Encrypted Token Cache & Claims Challenges

- Delegated OBO tokens and application tokens are cached in memory (and encrypted with AES-256-GCM using a tenant-scoped key when persisted) keyed strictly by:
  - User OBO token cache key: `tenant:${tenantId}:obo:${entraTenantId}:${actorEntraObjectId}:${storeId}:${scope}`
  - Provisioning token cache key: `tenant:${tenantId}:app:${entraTenantId}:${storeId}`
- Token caches are never shared across tenants or users. Access tokens are never written to logs, audit records, database tables, or browser responses.
- **Conditional Access & MFA Claims Challenges:** When Entra ID returns `interaction_required`, `invalid_grant` with suberror `conditional_access`, or an HTTP `401` `WWW-Authenticate: Bearer ... claims="..."` header from Microsoft Graph, the provider normalises this to `DocumentStoreError({ code: 'reauthentication_required', claimsChallenge })` so the UI prompts the user to re-authenticate with the required claims challenge.

### 6. `VerifiedOidcTokenClaims`, `TenantContext`, and `Person.entraObjectId`

- `VerifiedOidcTokenClaims` and `TenantContext` carry `entraObjectId` (`oid`), `entraTenantId` (`tid`), and `actorUpn` (`upn` / `preferred_username`).
- On Entra OIDC sign-in, `Person.entraObjectId` is automatically populated from the verified `oid` claim if not already set.
- For employees who have not yet signed in when added to a restricted matter or matter team exception, `resolvePrincipal` resolves their `entraObjectId` via Microsoft Graph (`GET /users/{upn}?$select=id,userPrincipalName`) using their primary firm email/UPN and caches it on `Person.entraObjectId`.
- If a user is browsing in local demo mode without an Entra identity (`!ctx.entraObjectId`), the Matter Documents tab displays a clear explanation that Microsoft Entra ID sign-in is required to access external SharePoint documents as themselves.

## Alternatives Considered

1. **Use the application identity for all file operations and filter in 1Squared.**
   - *Rejected:* Violates the core requirement that SharePoint enforces each user's own permissions and records the individual user in SharePoint's native audit log and version history.
2. **Use `Sites.FullControl.All` for provisioning.**
   - *Rejected:* Violates least privilege (Rule 8). Law firm IT and information security teams rightly reject tenant-wide `Sites.FullControl.All` when only specific matter document sites should be accessible.

## Consequences

- User actions are double-enforced (1Squared RBAC/matter access AND SharePoint per-user ACLs via OBO) and attributed to the real user in SharePoint.
- Provisioning actions run only in background jobs and admin connection/location tools, with audit records capturing both the provisioning application identity and the triggering 1Squared user or lifecycle event.
