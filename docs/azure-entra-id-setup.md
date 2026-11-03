# 1Squared — Microsoft Entra ID & Azure Setup Guide

This guide provides step-by-step instructions for configuring **Microsoft Entra ID (formerly Azure AD)**, **Enterprise Application App Roles**, **Security Groups**, **Token Configuration (OIDC/JWT claims)**, **Conditional Access (MFA)**, and **Azure Key Vault** for 1Squared in both hosting models:

- **Model A (`single_tenant`)**: Dedicated deployment in a client's Azure tenant.
- **Model B (`multi_tenant`)**: 1Squared-hosted multi-tenant platform in UK South (`uksouth`) / UK West (`ukwest`).

---

## 1. Create the App Registration in Microsoft Entra ID

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) (or **Azure Portal › Microsoft Entra ID**).
2. Navigate to **Identity › Applications › App registrations** and click **+ New registration**.
3. Configure the registration:
   - **Name**: `1Squared Platform (<env>)` (e.g., `1Squared Platform (Dev)` or `1Squared Platform (Live)`)
   - **Supported account types**:
     - For **Model A (`single_tenant`)** or internal 1Squared tenant testing: **Accounts in this organizational directory only (Single tenant)**.
     - For **Model B (`multi_tenant`)** across client Entra directories: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**.
   - **Redirect URI (Web)**:
     - Local development: `http://localhost:3000/api/auth/callback/microsoft-entra-id`
     - Hosted environment: `https://<tenant-or-app-domain>/api/auth/callback/microsoft-entra-id`
4. Click **Register**.
5. On the **Overview** blade, record:
   - **Application (client) ID** (`AZURE_AD_CLIENT_ID` / `ENTRA_CLIENT_ID`)
   - **Directory (tenant) ID** (`AZURE_AD_TENANT_ID` / `ENTRA_TENANT_ID`)

---

## 2. Configure Authentication & Token Version (OIDC v2.0)

1. In your App Registration, go to **Manage › Authentication**:
   - Under **Front-channel logout URL**, enter `https://<your-domain>/api/auth/logout` (or `http://localhost:3000/api/auth/logout` for local dev).
   - Under **Implicit grant and hybrid flows**, leave both checkboxes **unchecked** (1Squared uses Authorization Code Flow with PKCE).
2. Go to **Manage › Manifest** (or **App registration manifest**):
   - Set `"accessTokenAcceptedVersion": 2` (or `"requestedAccessTokenVersion": 2` in the Microsoft Graph app manifest) so Entra ID emits **v2.0 JWT tokens** containing standard `oid`, `tid`, `roles`, `groups`, `preferred_username`, and `amr` claims.
   - Click **Save**.

---

## 3. Define 1Squared App Roles (`roles` claim)

1Squared's RBAC engine ([`DEFAULT_RBAC_IDENTITY_MAPPING`](../core/src/domain/rbac/registry.ts) and [`base.json`](../client-not-a-law-firm/config/base.json)) is pre-configured to recognise the following **10 App Role values** out of the box.

1. In your App Registration, go to **Manage › App roles**.
2. Click **+ Create app role** for each row in the table below (set **Allowed member types** to **Users/Groups** and **Do you want to enable this app role?** to **Yes**):

| Display Name | Value (Exact Match Required) | Description | Maps to 1Squared `HomeRoleKey`s |
| :--- | :--- | :--- | :--- |
| `1Squared System Administrator` | `1Squared.Admin` | Full platform, configuration, RBAC, and operational administration | `["admin"]` |
| `1Squared Managing Partner` | `1Squared.ManagingPartner` | Firm-wide executive oversight across practice, finance, risk, HR, and templates | `["managing_partner", "partner"]` |
| `1Squared Partner` | `1Squared.Partner` | Departmental leadership, matter supervision, finance visibility, and team management | `["partner", "fee_earner"]` |
| `1Squared Risk & Compliance` | `1Squared.RiskCompliance` | AML/CDD oversight, conflict resolution, template approval, and staff matter access | `["risk_compliance"]` |
| `1Squared Finance` | `1Squared.Finance` | Firm-wide billing, aged debt, credit control, client/office ledgers, and payroll | `["finance"]` |
| `1Squared Fee Earner` | `1Squared.FeeEarner` | Legal matter delivery, client care, document generation, and matter financials | `["fee_earner"]` |
| `1Squared Supervisor` | `1Squared.Supervisor` | Team supervision, task routing, and matter delivery | `["supervisor", "fee_earner"]` |
| `1Squared Legal Secretary` | `1Squared.LegalSecretary` | Legal secretary / PA / support staff | `["legal_secretary"]` |
| `1Squared Enquiries Coordinator` | `1Squared.EnquiriesCoordinator` | Enquiries coordinator and intake routing | `["enquiries_coordinator"]` |
| `1Squared Intake` | `1Squared.Intake` | Call handler / initial enquiry capture | `["intake"]` |

> **Tip (Bulk Import via Manifest):** Instead of creating all 10 roles manually in the UI, you can paste the `appRoles` array directly into **Manage › Manifest** (see Section 8 below for the ready-to-paste JSON snippet).

---

## 4. Configure Optional Claims & Group Claims (`Token configuration`)

1Squared uses [`mapEntraTokenClaimsToVerifiedOidcToken`](../core/src/tenancy/index.ts) and [`resolvePersonForEntraClaims`](../src/domain/rbac.ts) to inspect `oid`, `tid`, `preferred_username`, `email`, `roles`, `groups`, and `amr`.

1. In your App Registration, go to **Manage › Token configuration**.
2. Click **+ Add optional claim**:
   - Select **ID** token, check:
     - `email`
     - `preferred_username`
     - `upn`
     - `xms_mirid` / `acct` (optional)
   - Click **Add** (and check **Turn on the Microsoft Graph email, profile permission** if prompted).
   - Repeat **+ Add optional claim** for **Access** token (`email`, `preferred_username`, `upn`).
3. **(If mapping Entra Security Groups via `rbac.identityMapping.entraGroupToRoleKey`):**
   - Click **+ Add groups claim** in **Token configuration**.
   - Select **Security groups** (or **Groups assigned to the application**, which is recommended for large firms so the token never exceeds the 200-group JWT limit).
   - Under **ID** and **Access**, keep **Group ID** selected (this emits the immutable Entra Group Object GUID in the `groups` array).
   - Click **Save**.

---

## 5. Enforce Multi-Factor Authentication (MFA) via Conditional Access

Critical permissions in 1Squared (`admin:access`, `rbac:manage_config`, `rbac:manage_user_overrides`, `document_template:approve`, `finance:manage_links`) require `mfaVerified === true` ([`PERMISSION_REGISTRY`](../core/src/domain/rbac/registry.ts)).

[`isEntraMfaVerified`](../core/src/tenancy/index.ts) automatically detects MFA from the Entra token's `amr` (`["pwd", "mfa"]`, `["ngcmfa"]`, `["fido"]`, `["hwk"]`) or `acrs` claims.

1. In the Microsoft Entra admin center, navigate to **Protection › Conditional Access › Policies**.
2. Click **+ New policy**:
   - **Name**: `Require MFA for 1Squared Platform`
   - **Users**: Select **All users** (or the pilot security group assigned to 1Squared).
   - **Target resources (Cloud apps)**: Select `1Squared Platform (<env>)`.
   - **Grant**: Select **Grant access** → check **Require multifactor authentication** (or **Require authentication strength: Multifactor authentication**).
   - **Enable policy**: Set to **On** and click **Create**.
3. Verify that **amr** claims are emitted:
   - In v2.0 tokens (`"accessTokenAcceptedVersion": 2`), Entra ID includes `"amr": ["pwd", "mfa"]` (or `"ngcmfa"` for Windows Hello / Authenticator passwordless) on ID and access tokens when MFA is satisfied.

---

## 6. Assign Users & Security Groups to the Enterprise Application

> **Important:** User and group assignments live under **Enterprise applications** (not **App registrations**).
> The fastest way to jump there from your App Registration is:
> 1. Click **Overview** at the top of the left-hand menu in `1Squared Platform (<env>)`.
> 2. On the right side under **Essentials**, click the blue link next to **Managed application in local directory**: **`1Squared Platform (<env>)`**.

1. Once inside the **Enterprise application** view (the breadcrumb at the top will read `Home > 1Squared > Enterprise applications > 1Squared Platform (<env>)`):
2. Go to **Manage › Properties**:
   - Set **Assignment required?** to **Yes** (recommended so only authorised firm staff can sign in).
   - Click **Save**.
3. Go to **Manage › Users and groups** and click **+ Add user/group**:
   - Select the user(s) or Entra Security Group(s) (e.g. `SG-1Squared-Partners`, `SG-1Squared-FeeEarners`, `SG-1Squared-RiskCompliance`).
   - Select the corresponding **App Role** (e.g. `1Squared Partner`) and click **Assign**.
   - *Note*: If a user holds multiple roles (for example, both `1Squared Partner` and `1Squared Risk & Compliance`), create two assignments for that user/group—Entra ID will emit both values in the JWT `roles` array (`["1Squared.Partner", "1Squared.RiskCompliance"]`), and 1Squared will union their permissions automatically.

---

## 7. Store Client Credentials in Azure Key Vault (Rule 5 Compliance)

Per Platform Architecture Standard Rule 5, **never** store client secrets in code, `.env` files committed to git, or `base.json`.

1. In your App Registration, go to **Manage › Certificates & secrets**:
   - For production (**Live / Test / Training**): Prefer **Workload Identity Federation / Managed Identity** or upload an X.509 certificate stored in Azure Key Vault.
   - If using a Client Secret during initial setup: Click **+ New client secret**, copy the **Value** immediately, and store it in your tenant/environment Azure Key Vault (`kv-<tenantSlug>-<environment>`, provisioned by [`core/infra/main.bicep`](../core/infra/main.bicep)):
     ```powershell
     az keyvault secret set `
       --vault-name "kv-not-a-law-firm-dev" `
       --name "entra-oidc-client-secret" `
       --value "<paste-secret-value>"
     ```
2. Configure the runtime environment variables in your Azure App Service / Container App (referencing Key Vault via `@Microsoft.KeyVault(SecretUri=...)`):
   - `ENTRA_TENANT_ID`: `<Directory (tenant) GUID>`
   - `ENTRA_CLIENT_ID`: `<Application (client) GUID>`
   - `ENTRA_CLIENT_SECRET`: `@Microsoft.KeyVault(VaultName=kv-not-a-law-firm-dev;SecretName=entra-oidc-client-secret)`
   - `PLATFORM_ENVIRONMENT`: `dev` (or `test` | `training` | `live`)
   - `PLATFORM_HOSTING_MODE`: `single_tenant` or `multi_tenant`

---

## 8. Link Entra ID Groups & Employees Inside 1Squared

Once the Azure App Registration is live:

1. **Map Entra Security Group GUIDs (Optional):**
   - Open **Administration › RBAC & Entra ID › 3. 1Squared Entra ID Mapping** (`/admin/rbac-and-entra`).
   - Paste any Entra Security Group Object GUIDs into **Entra Security Group Object ID Mappings** (`entraGroupToRoleKey`) and select the target 1Squared role keys, then click **Save Entra ID Mapping**.
2. **Match Employees to Entra Users:**
   - When an employee signs in via Entra ID, [`resolvePersonForEntraClaims`](../src/domain/rbac.ts) matches them in two ways:
     1. **Primary (Immutable):** Matches `Person.entraObjectId` against the JWT `oid` claim. You can pre-bind an employee's `oid` in **Administration › RBAC & Entra ID › 4. Per-Employee Overrides**.
     2. **Fallback (Automatic on First Sign-In):** Matches the employee's active work email in 1Squared against the JWT `email` / `preferred_username` / `upn` claim.
3. **Select Role Authority Mode (`authorityMode`):**
   - Keep **`hybrid`** during initial rollout (combines Entra token roles/groups with existing `Person.roles` in 1Squared so no user loses access during migration).
   - Switch to **`token_only`** once all firm staff have their App Roles or Security Groups assigned in Entra ID, making Microsoft Entra ID the sole source of role assignments.

---

## 9. SharePoint Online Document Store Integration (OBO + `Sites.Selected`)

For full step-by-step instructions on configuring the **two-identity SharePoint Document Store Integration** (delegated user On-Behalf-Of token exchange + application-only `Sites.Selected` certificate provisioning in Azure Key Vault), see:

- [SharePoint Document Store Setup & Operations Runbook](./sharepoint-document-store-runbook.md)
- [ADR-0018: Two-Identity Authentication Model](./decisions/0018-two-identity-authentication-model.md)

---

## Appendix: Ready-to-Paste `appRoles` Manifest JSON

In **App registrations › Manage › Manifest**, you can paste these entries into the `"appRoles"` array (generating a unique GUID for each `"id"`):

```json
[
  {
    "allowedMemberTypes": ["User"],
    "description": "Full platform, configuration, RBAC, and operational administration",
    "displayName": "1Squared System Administrator",
    "id": "a1000000-0000-0000-0000-000000000001",
    "isEnabled": true,
    "value": "1Squared.Admin"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Firm-wide executive oversight across practice, finance, risk, HR, and templates",
    "displayName": "1Squared Managing Partner",
    "id": "a1000000-0000-0000-0000-000000000002",
    "isEnabled": true,
    "value": "1Squared.ManagingPartner"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Departmental leadership, matter supervision, finance visibility, and team management",
    "displayName": "1Squared Partner",
    "id": "a1000000-0000-0000-0000-000000000003",
    "isEnabled": true,
    "value": "1Squared.Partner"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "AML/CDD oversight, conflict resolution, template approval, and staff matter access",
    "displayName": "1Squared Risk & Compliance",
    "id": "a1000000-0000-0000-0000-000000000004",
    "isEnabled": true,
    "value": "1Squared.RiskCompliance"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Firm-wide billing, aged debt, credit control, client/office ledgers, and payroll",
    "displayName": "1Squared Finance",
    "id": "a1000000-0000-0000-0000-000000000005",
    "isEnabled": true,
    "value": "1Squared.Finance"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Legal matter delivery, client care, document generation, and matter financials",
    "displayName": "1Squared Fee Earner",
    "id": "a1000000-0000-0000-0000-000000000006",
    "isEnabled": true,
    "value": "1Squared.FeeEarner"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Team supervision, task routing, and matter delivery",
    "displayName": "1Squared Supervisor",
    "id": "a1000000-0000-0000-0000-000000000007",
    "isEnabled": true,
    "value": "1Squared.Supervisor"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Legal secretary / PA / support staff",
    "displayName": "1Squared Legal Secretary",
    "id": "a1000000-0000-0000-0000-000000000008",
    "isEnabled": true,
    "value": "1Squared.LegalSecretary"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Enquiries coordinator and intake routing",
    "displayName": "1Squared Enquiries Coordinator",
    "id": "a1000000-0000-0000-0000-000000000009",
    "isEnabled": true,
    "value": "1Squared.EnquiriesCoordinator"
  },
  {
    "allowedMemberTypes": ["User"],
    "description": "Call handler / initial enquiry capture",
    "displayName": "1Squared Intake",
    "id": "a1000000-0000-0000-0000-000000000010",
    "isEnabled": true,
    "value": "1Squared.Intake"
  }
]
```
