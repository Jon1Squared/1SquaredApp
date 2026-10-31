# Agent rules for this project

All code in this repository must follow the Platform Architecture Standard in `docs/architecture-standard.md`. Every pull request is reviewed independently against that standard. Changes that break these rules will be rejected, so follow them from the start.

## Architecture rules

1. Never put client-specific code, names or IDs in the core.
2. Client differences are configuration (schema-validated) or extensions (public extension points only). Never fork the core or add client-specific branches or conditions.
3. Extensions import only from the core's public API package, never from core internals.
4. All data access goes through the tenant-scoped data layer (`core/src/tenancy/`). The tenant comes only from the authenticated token, never from a URL, form field or user-controlled header.
5. No secrets, keys or client data in code, logs, tests or config files. Secrets are referenced from Key Vault.
6. The same build must run single-tenant (client Azure) and multi-tenant (hosted). Tenancy mode is configuration, not code.
7. Configuration schema and extension API changes must be backward compatible within a major version: additive first, deprecate before removing.
8. Database migrations must be backward compatible (expand, then contract), reversible, and tracked per tenant.
9. Any change touching data access needs two-tenant isolation tests, including tampered record IDs and forged tenant claims.
10. If a request conflicts with these rules, stop and explain before coding.

## Before you write code

- Classify the change: core feature, core extension point, configuration option, client extension, client configuration or infrastructure.
- Choose the least invasive mechanism: existing configuration, then a core feature behind a flag or option, then a client extension on a published extension point. If the core lacks the extension point you need, propose a generic one as a separate core change. Never reach into core internals.
- If the change is structural or needs an exception to the standard, draft an architecture decision record in `docs/decisions/` first.
- See `docs/decisions/0001-shared-repo-and-transitional-store.md` for the approved early-stage coexistence of the Next.js host (`src/`), transitional local JSON store (`src/server/store.ts`), and invented test fixtures (`Not A Law Firm LLP` / `Pembroke Vaughan`).

## While you write code

- Cache keys, queue messages, search entries and background jobs always include the tenant ID. Jobs refuse to run without one.
- Files go in the tenant's own storage container, accessed with short-lived scoped tokens.
- Logs include a correlation ID and tenant ID, and never client content or personal data.
- New configuration options need a schema entry with type, default, description and validation.
- Extensions need a manifest (name, version, supported core API range, permissions, extension points) and hooks with timeouts and error isolation.
- Infrastructure changes are Bicep only, in `core/infra/`.
- Test fixtures use invented data only. Never real client names or data.

## Before you open a pull request

- Work on a feature branch and target `develop`. Never commit directly to `main` or `develop`.
- Add tests (unit, contract and two-tenant isolation tests where relevant) and make sure CI passes.
- Update documentation and release notes.
- In the PR description, state the change class, how it works in both hosting models, and any migration or rollback steps.
