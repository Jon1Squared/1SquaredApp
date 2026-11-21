# Migration Guide: `@platform/core-api` v1.x to v2.0.0

This guide explains how to update extensions written against `@platform/core-api` `1.x` (`1.0.0` / `1.1.0`) for compatibility with `CORE_API_VERSION = '2.0.0'` ([ADR 0037](../../docs/decisions/0037-extension-api-v2-least-privilege-config-context.md)).

## Summary of Breaking Changes

1. **`ExtensionExecutionContext.config` is now optional (`readonly config?: TenantConfiguration`):**
   - `ExtensionHost` now enforces the `'config:read'` extension permission strictly at runtime.
   - Extensions whose `manifest.json` omits `'config:read'` receive `ctx.config === undefined`.
   - Note that for `beforeMatterOpen`, an unhandled `TypeError` when dereferencing `ctx.config` blocks matter opening (`allowProceed: false`).
2. **`supportedCoreApiRange` enforces full semantic version ranges:**
   - `CORE_API_VERSION` has moved from `'1.1.0'` to `'2.0.0'`.
   - `ExtensionHost.registerExtension` and `isCoreApiRangeCompatible` evaluate full semantic version ranges via `semver.satisfies(validVersion, validRange, { includePrerelease: false })` (such as `^2.0.0`, `>=2.0.0 <3.0.0`, or `~2.0.0`).
   - Unbounded wildcards (`supportedCoreApiRange: '*'`, `'x'`, `'X'`, or `'*.*'`) and incompatible ranges (such as `^1.0.0`, `^1.1.0`, or `^2.2.0` against `2.1.0`) fail closed at registration with `EXTENSION_COMPATIBILITY_ERROR`.
3. **`manifest.hooks` is checked across every hook runner:**
   - Hook runners (`executeMatterCostsHook`, `executeMatterCostsHookSync`, `executeFieldProviders`, `executeKeyDate*`, `executeRegister*`, `executePmsOutboundCommandHook`, `executeMatterDocumentsLifecycleHook`) execute an enabled extension only if the invoked hook name appears in `manifest.hooks`.

## Required Extension Changes

1. **Update `manifest.json`:**
   - Change `"supportedCoreApiRange"` from `"^1.0.0"` to `"^2.0.0"`.
   - Add `"config:read"` to `"permissions"` **only if** your hooks genuinely inspect `ctx.config`.
   - Verify `"hooks"` lists every hook exported by `src/index.ts`.
   - Re-run `npm run generate:extensions` after updating `manifest.json`.
2. **Guard optional `ctx.config` access in TypeScript:**
   - Update callers from `ctx.config.matterCosts` to optional chaining (`ctx.config?.matterCosts`) or handle the absent-config branch cleanly without throwing.

### Example (`manifest.json`)

```json
{
  "supportedCoreApiRange": "^2.0.0",
  "permissions": [
    "matter:read",
    "config:read"
  ],
  "hooks": ["beforeMatterOpen"]
}
```
