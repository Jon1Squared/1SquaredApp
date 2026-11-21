# ADR 0037: Extension API v2.0.0 — Least-Privilege Configuration Context

- **Date:** 2026-11-21
- **Status:** Accepted (2026-11-21)
- **Related:** [ADR 0003: Field Catalogue Versioned Contract](./0003-field-catalogue-versioned-contract.md), [ADR 0022: Key Dates and Limitation Module](./0022-key-dates-and-limitation-module.md), [Extension API v2.0.0 Migration Guide](../../core/docs/extension-api-v2-migration.md), [Platform Architecture Standard](../architecture-standard.md) §§5, 6, 7

## Context

In `ExtensionExecutionContext` (`core/src/api/index.ts`), `config` was originally declared as a required property (`readonly config: TenantConfiguration`) and passed unconditionally by `ExtensionHost` to every registered extension hook—even when the extension's `manifest.json` did not declare `'config:read'`.

During Stage 0 exit hardening (`R593`), `ExtensionHost` was updated to enforce manifest permissions strictly: `ctx.config` is now populated only when `'config:read'` is present in `manifest.permissions` (otherwise `ctx.config` is `undefined`), and every hook runner verifies that the invoked hook name is declared in `manifest.hooks`. Narrowing `ExtensionExecutionContext.config` from required to optional (`readonly config?: TenantConfiguration`) is a breaking change for any caller reading `ctx.config.x` under `strictNullChecks` or at runtime without `'config:read'`.

Platform Architecture Standard §6 and Rule 7 require breaking public contract changes to advance the major version of `CORE_API_VERSION`, provide a deprecation period in normal releases, and supply migration guidance.

## Decision

1. **Major version bump (`CORE_API_VERSION = '2.0.0'`):** Advance `CORE_API_VERSION` in `core/src/api/index.ts` from `'1.1.0'` to `'2.0.0'`. Compatible extension manifests must declare `"supportedCoreApiRange": "^2.0.0"` (for example `client-not-a-law-firm/extensions/nalf-matter-costs-governance/manifest.json`).
2. **Fail-closed compatibility gate:** `ExtensionHost.registerExtension` retains its strict major-version check (`isCoreApiRangeCompatible`), rejecting any `1.x` manifest at registration with `EXTENSION_COMPATIBILITY_ERROR` rather than executing hooks with an unexpected `undefined` `ctx.config`.
3. **Recorded Stage 0 Rule 7 deprecation exception:** Wait-free immediate transition from `1.1.0` to `2.0.0` (without a overlapping deprecation period supporting unprivileged `config` reads) is explicitly recorded as an exception because:
   - The platform is in **Stage 0** with zero live client deployments and zero third-party or client-owned extensions in production—only the in-repo invented fixture extension (`nalf-matter-costs-governance`) exists.
   - Delaying enforcement of `config:read` to preserve backward compatibility would weaken tenant security boundaries (exposing Key Vault secret references, allow-lists, and module flags to extensions that never requested configuration read access).
4. **Migration documentation:** Publish upgrade instructions in [`core/docs/extension-api-v2-migration.md`](../../core/docs/extension-api-v2-migration.md) and [`core/docs/CHANGELOG.md`](../../core/docs/CHANGELOG.md).

## Consequences

- Extensions that do not need tenant configuration do not receive `ctx.config` and do not need `'config:read'`.
- Extensions reading `ctx.config` must declare `'config:read'` in `manifest.permissions`, guard `ctx.config` as optional under TypeScript `strictNullChecks`, and declare `"supportedCoreApiRange": "^2.0.0"`.
- Future breaking changes to `@platform/core-api` after Stage 0 (once external client repositories exist) must provide a documented deprecation period and major version transition path under Rule 7.
