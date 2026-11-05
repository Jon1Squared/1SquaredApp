# ADR-0003: Field Catalogue as a Versioned Public Contract and HR/Payroll Exclusions

- **Date:** 2026-04-20
- **Status:** Proposed

## Context

Document templates reference merge fields (`{{ matter.reference }}`, `{{ client.name }}`, `{{ financial.wipBalance }}`, etc.) that survive across template versions, exported template packages, and platform upgrades. In addition, tenants configure custom fields (`CustomFieldDefinition`), and client extensions may contribute calculated or domain-specific merge fields via a `FieldProvider` extension point.

At the same time, the platform stores highly sensitive employee records protected by `employee:payroll`, `employee:hr_restricted`, and `employee:sensitive` (see `docs/rbac-reference.md` and `src/domain/employment.ts`). Allowing template builders to map sensitive HR, payroll, or diversity data into client/matter document templates would create a severe data-leakage vector.

## Decision

### 1. Versioned Public Field Catalogue Contract

The core defines a canonical **Field Catalogue** in `@platform/core` (`core/src/domain/document-generation/fieldCatalogue.ts`) whose types are exported from `@platform/core-api`. Each `FieldCatalogueEntry` specifies:

- `key`: Dot-namespaced canonical identifier (e.g., `matter.reference`, `client.primaryAddress`, `financial.totalUnbilledWip`, `feeEarner.fullName`, `firm.registeredName`, `user.fullName`, `date.today`, `party.recipient.name`).
- `displayName`: Human-readable label for the field chooser and mapping UI.
- `description`: Guidance on what the field resolves to.
- `group`: One of `'Client' | 'Matter' | 'Financial' | 'Fee Earner' | 'Firm' | 'User' | 'Date' | 'Party' | 'Custom'`.
- `dataType`: `'text' | 'date' | 'currency' | 'number' | 'boolean' | 'address'`.
- `requiredPermission`: The permission needed to view/resolve the field in the field chooser, preview, and generation (`'document:generate'` for general client/matter fields on accessible records, `'finance:view'` for all `Financial` group fields, `'employee:view_core'` for `Fee Earner` and `User` employment attributes).
- `sinceVersion`: SemVer string (e.g., `'0.1.0'`).
- `deprecated`: Optional `{ sinceVersion: string; replacementKey?: string; reason: string }`.
- `resolver`: Pure tenant-scoped resolver function taking the record context (`Client`, `Matter`, `FinancialSnapshot`, `FeeEarner`, `Firm`, `CurrentUser`, `PartyRecipient`, `TenantCustomFields`).

### 2. Backward-Compatibility Rules (Standard Section 6 & 7)

- Canonical field keys are a **public contract** governed by `CORE_API_VERSION`.
- Within a major version, changes to the Field Catalogue are strictly **additive**.
- Existing keys cannot be removed or have their data type incompatibly altered within a major version. If a field is superseded, it is marked `deprecated` while keeping its resolver active so existing approved templates continue to generate identically.

### 3. Dynamic Tenant Custom Fields and Extension Field Providers

- **Tenant Custom Fields:** Custom fields configured for the tenant (`custom.client.<key>`, `custom.matter.<key>`) are automatically projected into the `Custom` group of the tenant's active Field Catalogue with their configured data type and display label.
- **Extension Field Providers:** Client extensions may register a `FieldProvider` hook on `@platform/core-api`:
  - The extension manifest (`core/schemas/extension-manifest.schema.json`) must declare the new `'document:fields:provide'` permission alongside the relevant entity read permission (`'matter:read'`, `'client:read'`, `'person:read'`, or `'finance:view'`).
  - Contributed field keys must be namespaced under `ext.<extensionName>.<fieldKey>` so they never collide with core or custom fields.
  - The `ExtensionHost` executes field providers within the configured hook timeout (`500 ms` default) and isolates any thrown error so a broken extension cannot crash core document generation.

### 4. Strict Exclusion of Sensitive HR, Payroll, and Diversity Fields

The Field Catalogue enforces an explicit architectural blocklist:

- **No field protected by `employee:payroll`, `employee:hr_restricted`, or `employee:sensitive` may ever be registered in the Field Catalogue, exposed by a `FieldProvider` extension, or resolved during merge.**
- Specifically excluded categories:
  - **Payroll & Bank (`employee:payroll`):** Salary, hourly cost/charge rates from HR payroll, NI number, tax code, bank sort code/account number, pension contributions, bonus/commission arrangements.
  - **HR Restricted (`employee:hr_restricted`):** Employment contract terms, notice periods, probation status, disciplinary/grievance records, sickness/absence history, performance appraisals, right-to-work document references, emergency contact details, home address, personal phone/email.
  - **Sensitive / Special Category (`employee:sensitive`):** Diversity and inclusion monitoring data (ethnicity, religion, sexual orientation, disability), workplace adjustments, medical/health notes, criminal record / DBS checks.
- **Permitted Fee Earner & Author (`User`) fields** are restricted strictly to public business identity fields readable under `employee:view_core`:
  - Full name (`fullName`), business job title (`jobTitle`), business email (`workEmail`), business direct dial (`workPhone`), office name/address (`officeName`, `officeAddress`), department/practice area display name (`departmentName`), and regulator/SRA roll number if public (`regulatorId`).

## Alternatives Considered

1. **Allow HR fields in the catalogue but gate them at runtime with `hasEmployeePermission(user, 'employee:payroll')`.**
   - *Rejected:* Even if an administrator or managing partner holds `employee:payroll`, client/matter templates are shared artefacts used across the firm to generate external client correspondence. Including payroll or HR fields in the client/matter merge catalogue creates an unacceptable risk of accidental disclosure in client documents.
2. **Allow un-namespaced extension field keys.**
   - *Rejected:* Could collide with future core Field Catalogue additions and break backward compatibility on upgrade.

## Consequences

- Template builders can rely on stable `{{ group.field }}` keys across upgrades and tenant environments.
- Sensitive employee data is structurally unreachable from the document generation subsystem, reinforced by automated security unit tests asserting zero overlap with `employee:payroll`, `employee:hr_restricted`, and `employee:sensitive` fields.
