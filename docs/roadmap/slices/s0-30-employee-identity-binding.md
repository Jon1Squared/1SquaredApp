# S0-30: Employee identity binding

| | |
|---|---|
| Backlog | B13 (new), P1, P8 |
| Decision | No new decision record. The configuration change is additive (rule 7) and follows the existing `rbac.identityMapping` settings. Owner approved adding this slice on 9 November 2026. |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0A |
| Branch | `s0-30-employee-identity-binding`, from `develop`, targeting `develop` |
| Change class | Core feature fix (security), plus one additive configuration option. Layers: `src/server` (person save, sign-in binding), `src/domain/rbac.ts`, `core/schemas/tenant-config.schema.json`. |
| Size | M |
| Depends on | S0-03 (person save permissions, merged). Independent of WP3; it touches none of the WP3 files except possibly `src/server/services.ts`, in different functions. |
| Blocking manual tasks | None. |
| Must land before | The demo deployment (S0-11b manual task), and any real tenant's onboarding. |
| Baseline | `develop` at `147ac61` |

## The problem

An employee persona that hasn't signed in yet can be taken over by any user who can edit contacts. Found in the WP3 second retest (R373), and Claude Code confirmed both code paths. It was not introduced by WP3.

1. **Editing an employee's email needs only `contact:edit`.**
   - `savePersonRecord` (`src/server/services.ts:1555`) requires `employee:edit_core` only when employee status, role, department or employment changes (`isLegacyEmployeeFieldChange`, `requiresEmployeeEditCore`).
   - Changing `emails` on an employee record falls through to the `contact:edit` check.
   - `contact:edit` is held by fee_earner, legal_secretary, enquiries_coordinator, intake, supervisor, partner, risk_compliance and managing_partner.
2. **Sign-in links by email to any unbound employee.**
   - `resolvePersonForEntraClaims` (`src/domain/rbac.ts:586`, matching at ~`:625-643`) matches an active employee with no `entraObjectId` whose active email equals the token's `email`, `preferred_username` or `upn` claim.
   - The sign-in service (`src/server/services.ts:~12307`) then writes the token's `oid` onto that person.
   - From then on, the user has that employee's stored roles. In `hybrid` and `store_only` modes that includes the system administrator role.
3. **Attack:**
   1. A fee earner changes the email of an unbound employee (a colleague who hasn't signed in yet, or a seeded admin persona in the demo) to the address of a second account they control in the same Entra tenant.
   2. They sign in with that account.
   3. They are bound to that employee and get its roles.
4. **Exposure:**
   - Every live tenant during onboarding, while employees are still unbound.
   - The demo tenant permanently: after S0-11b, `seed:demo` without `--entra-map` and every in-app reset leave all personas unbound.

The `email` claim in Entra ID is not always verified (for example for guest or B2C-style accounts), so matching on it alone is weak even without the edit step.

## What exists today

- **The admin binding path already exists.** `updatePersonPermissionOverrides` (`src/server/services.ts:10100`) sets `entraObjectId`, requires `rbac:manage_user_overrides` (`requiresMfa: true`, `sensitivity: 'critical'`), blocks self-modification, and writes a before/after audit entry.
- **Email linking on sign-in** writes an audit entry with `action: 'update'`, field "Entra ID Email Link".
- **`rbac.identityMapping`** in `core/schemas/tenant-config.schema.json:~750` has `authorityMode`, `entraGroupToRoleKey` and `entraAppRoleToRoleKey`.
- **`branding.primaryDomain`** is required in tenant configuration.

## Files and changes

1. **Person save** (`src/server/services.ts`, `savePersonRecord`, and `savePersonAction` in `src/app/actions.ts`):
   - Treat any change to `emails` on a record that is, or was, an employee or leaver as an identity change. It requires:
     - `employee:edit_core`
     - `mfaVerified === true` (administrative action, CLAUDE.md "Tenancy and identity")
   - Compare normalised addresses (trimmed, lower case, active only), so reordering or editing a label isn't an identity change.
   - Deny with `ActionDenied` (`FORBIDDEN`, or `MFA_REQUIRED` if that code exists) and a clear message. Write no partial change.
   - Write a dedicated audit entry for an allowed change: field "Employee sign-in email", old and new address. Audit entries are not logs, but nothing goes to the server logs.
   - When an employee's email changes and the record has an `entraObjectId`, keep the binding: the binding is by `oid`, so the email change doesn't move it.
   - Find every other path that can change an employee's emails (person merge refuses employees; check enquiry or quote conversion, imports, the HR screens and any bulk update) and apply the same rule, or confirm it can't touch employees. List them in the PR description.
2. **Sign-in binding** (`src/domain/rbac.ts`, `resolvePersonForEntraClaims`; the sign-in service in `src/server/services.ts`):
   1. **Verified domains only.** Email-first linking happens only when the claim's domain is in the tenant's linking domains (see the configuration change below). Otherwise there is no match and no binding: the user is treated as unmatched, as today when no person matches.
   2. **Prefer the verified identifier.** Match on `preferred_username` / `upn` (the directory sign-in name) before `email`. Use `email` only when it is in a linking domain and the token marks it verified, if the claim set exposes that (for example `xms_edov`). If not, don't use `email` for linking.
   3. **Never email-link a privileged persona.** If the matched person's resolved roles or permissions include any permission with `requiresMfa: true` or `sensitivity: 'critical'` (for example admin, system administrator or anyone holding `rbac:manage_user_overrides`), don't bind by email. An administrator binds them explicitly through `updatePersonPermissionOverrides` (Admin → Users) or `seed:demo --entra-map`.
   4. **Exactly one match.** If more than one unbound employee has the address, bind none, and audit the ambiguity without the address.
   5. **Audit.** Write the email link with a distinct audit action, for example `entra-link` added to `AuditAction` (additive), so it can be reviewed and reported.
   6. **Logging.** Log only the person ID, correlation ID and tenant ID, never the email or `oid`.
3. **Configuration** (`core/schemas/tenant-config.schema.json`, `rbac.identityMapping`), additive with a schema entry, default, description and validation:
   - `emailLinking.enabled`: boolean, default `true`. When `false`, only `oid` bindings are used.
   - `emailLinking.domains`: array of lower-case domain names, default `[]`. An empty array means "the tenant's `branding.primaryDomain` only".
   - Update `client-not-a-law-firm/config/base.json` only if the test tenant needs a non-default value (it shouldn't). Document the setting in `src/docs/articles/tenant-settings.ts`.
   - Make sure the settings-usage test (`core/tests/tenant-config-usage.test.ts`) sees both leaves used at runtime.
4. **Demo** (if S0-11b has merged first, otherwise note it for S0-11b):
   - The runbook (`docs/runbooks/demo-deployment.md`) says admin personas must be bound with `--entra-map`, because they will never link by email.
   - `seed:demo` without `--entra-map` prints a warning that privileged personas stay unbound.

## Tests

- **Unit / service tests** (`core/tests/rbac.test.ts` or a new `src/server/__tests__/identityBinding.test.ts`):
  - A `contact:edit`-only actor (for example fee_earner) changing an employee's primary email gets `FORBIDDEN`, and the stored emails are unchanged.
  - An `employee:edit_core` actor without MFA gets denied. With MFA, the change is allowed and audited.
  - A `contact:edit` actor can still change a non-employee contact's email (positive control).
  - Reordering an employee's emails or changing a label isn't treated as an identity change.
  - Sign-in with an email in a linking domain binds an ordinary unbound employee (positive control) and writes an `entra-link` audit entry.
  - Sign-in with an email outside the linking domains doesn't bind.
  - Sign-in matching a privileged persona (admin, system administrator) by email doesn't bind.
  - Two unbound employees with the same address: no binding.
  - `emailLinking.enabled: false`: no email binding; `oid` bindings still work.
  - **End-to-end attack:** a fee earner edits P-000004's email (denied). Then, directly in the store, set the email to an attacker address and sign in as that address. P-000004 must not bind, because it is privileged.
- **Two-tenant tests** (`core/tests/isolation.test.ts`, rule 9):
  - A forged tenant claim on the person save and on sign-in binding is refused, with the specific code asserted.
  - A tampered person ID (an ID not in the active tenant) is refused with `NOT_FOUND` or the service's equivalent.
  - A positive control in the same test: the valid tenant A call succeeds.
- **Config tests:** schema validation accepts the new settings and rejects a non-string domain.
- **Guard test:** any new or changed action keeps its policy in `src/server/actionPermissions.ts`. `MAX_KNOWN_GAPS` must not go up.

## Help and documentation (rule 11)

- **Help article** on users and sign-in (find the existing one in `src/docs/registry.ts`, for example the user management or RBAC article). Explain:
  - who can change an employee's sign-in email
  - when sign-in links by email, and when it doesn't (other domains, privileged roles, duplicates)
  - how an administrator binds a person explicitly
- **`src/docs/articles/tenant-settings.ts`:** the two new settings.
- **`docs/rbac-reference.md`:** the binding rules.
- **`docs/release-notes.md`:** the behaviour change. Some users who previously linked automatically (administrators, or anyone outside the primary domain) now need an administrator to bind them.
- **`docs/roadmap/feature-list.md`:** B13 row (status, "What exists", "What's missing").

## Acceptance criteria

- A user without `employee:edit_core` and MFA can't change an employee's email by any path.
- Sign-in never binds by email to a privileged persona, to an address outside the linking domains, or when the address is ambiguous.
- Existing `oid` bindings are unaffected.
- The demo runbook and `seed:demo` reflect that privileged personas need `--entra-map`.
- All tests above pass, `npm run ci` passes, and the help articles are updated.

## Pull request description must state

- **Change class:** core feature fix (security) plus an additive configuration option.
- **Both hosting models:** the change is per tenant through configuration and behaves the same in single-tenant and multi-tenant deployments.
- **Migration and rollback:** no data migration. Existing bindings stay. `rbac.identityMapping` has `additionalProperties: false`, so an older build rejects the new keys. Deploy code before setting the new keys. To roll back, remove any `emailLinking` settings from tenant configuration first, then revert the code.
- **Every path checked** that can change an employee's emails (from step 1).
- **Behaviour change:** who now needs explicit binding.
