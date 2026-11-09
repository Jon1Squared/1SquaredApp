# S0-13b: Application Insights telemetry, bundled job entry points and container runtime hardening

| | |
|---|---|
| Backlog | P12, P8 |
| Decision | [ADR 0024: Host the Application on Azure Container Apps](../../decisions/0024-azure-container-apps-hosting.md) (D1, accepted 6 November 2026); [ADR 0030](../../decisions/0030-tenant-aware-scheduler.md) §1 (container job entry point); Platform Architecture Standard §13 (Observability) and Rule 5 |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (`S0-13` second pull request `S0-13b`, WP4 Checkpoint 4a) |
| Branch | `s0-13b-telemetry`, from `s0-13-container-apps-infrastructure`, targeting `develop` |
| Change class | Core feature / observability, Key Vault reference guard, job bundling & container runtime (`core/src/observability/`, `core/src/tenancy/keyVaultSecrets.ts`, `src/platform/`, `src/server/`, `scripts/build-jobs.mjs`, `Dockerfile`). |
| Size | M |
| Depends on | S0-13 (Application Insights resource, Private Endpoint Key Vault `keyVaultUri` outputs, Container Apps & job Bicep), S0-30 (`resolveRequestCorrelationId` in `src/server/correlationId.ts`, merged). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to verify live ingestion and alert rules in Azure Application Insights and push images to ACR. |
| Baseline | `develop` at `52390b9` (stacked on `s0-13-container-apps-infrastructure`) |

## What exists today

Checked against `develop` (`52390b9`):

1. **No Application Insights / OpenTelemetry SDK or telemetry pipeline:**
   - `package.json:19-39` has no Application Insights or OpenTelemetry package, and `src/instrumentation.ts` does not exist.
   - Ad-hoc `console.info` / `console.warn` / `console.error` calls exist in `src/platform/tenantRuntime.ts:588, 681`, `src/server/authorize.ts:60`, `src/server/services.ts:593, 4705, 6123`, `src/server/documentGenerationServices.ts:145`, and `src/app/api/matters/extract/route.ts` without a shared telemetry emitter or central PII deny-list scrubber.
2. **Correlation ID helper exists (`src/server/correlationId.ts:1-20`), with legacy timestamp callers:**
   - `resolveRequestCorrelationId(requestHeaders)` (`src/server/correlationId.ts:10-20`) validates incoming `x-correlation-id` against `SAFE_CORRELATION_ID_PATTERN` (`/^[A-Za-z0-9._:-]{1,128}$/`) and mints a UUID otherwise.
   - `src/platform/tenantRuntime.ts:676` (`req-${Date.now()}`) and `src/server/documentGenerationServices.ts:151` (`corr-blob-key-fallback-${Date.now()}`) still synthesise timestamp IDs, and `src/server/authorize.ts:170, 274` mints `corr-act-${randomUUID()}` / `corr-rte-${randomUUID()}` without reading request headers through `resolveRequestCorrelationId`.
3. **Production environment fallback (`P12` / `R371`):**
   - `getActiveTenantConfiguration()` in `src/platform/tenantRuntime.ts:533-540` defaults to `'dev'` when `process.env.PLATFORM_ENVIRONMENT` is unset, even under `NODE_ENV === 'production'`.
4. **Key Vault tenant boundary (`ADR 0024` AG3, `core/src/integrations/document-stores/tokenCache.ts:544, 616`, `core/infra/main.bicep:62`):**
   - `DocumentStoreTokenService` (`tokenCache.ts:539-548, 610-650`) already passes `authConfig.certificateKeyVaultSecretRef` (`kv://<vault>/<secret>`) at runtime without verifying that `<vault>` belongs to `accessContext.tenantContext`'s own Key Vault, and `core/src/tenancy/index.ts:120` derives `kv-${tenantId}-${environment}` without accounting for Bicep's 24-character Key Vault truncation (`take('kv-${sanitizedSlug}-${environment}', 24)`, `core/infra/main.bicep:62`).
5. **Container image & compiled job entry points (`R404`):**
   - Neither `Dockerfile` / `.dockerignore` nor a bundler step for CLI jobs exists; `tsx` (`package.json:36`) is a `devDependency` and Next.js `output: 'standalone'` omits `scripts/`.

## Files and changes

1. **OpenTelemetry / Application Insights emitter (`package.json`, `core/src/observability/telemetry.ts` — new, exported via `core/src/index.ts`, R413):**
   - Add **`@azure/monitor-opentelemetry`** and **`@opentelemetry/api`** to `dependencies` in `package.json`.
   - Implement `PlatformTelemetryRecorder`, `emitTenantTelemetryEvent`, `emitTenantTelemetryException`, `emitPlatformStartupTelemetry`, and `sanitizeTelemetryProperties`:
     - Exports to Azure Application Insights when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (opt-in in Model A per `docs/architecture-standard.md:119`; zero network calls when unset in `dev`/`test`).
     - **Tenant-scoped vs start-up events (R413):** `emitTenantTelemetryEvent` / `emitTenantTelemetryException` require non-empty `tenantId` and `correlationId` (throwing/refusing if `tenantId` is missing). Process start-up and shutdown lifecycle events before any request exists go exclusively through `emitPlatformStartupTelemetry`, which sets `scope: 'platform_startup'`, `tenantId: hostingMode === 'single_tenant' ? configuredTenantId : 'platform'`, and a UUID `correlationId` from `resolveRequestCorrelationId(null)`.
     - **Recursive personal-data & client-content deny-list scrubber (Standard §13, Rule 5):** strips keys matching a case-insensitive deny-list across nested objects/arrays (`email`, `upn`, `preferred_username`, `entraObjectId`, `oid`, `sub`, `firstName`, `lastName`, `surname`, `preferredName`, `otherNames`, `displayName`, `name`, `phone`, `phones`, `mobile`, `address`, `addresses`, `line1`, `line2`, `postcode`, `dateOfBirth`, `dob`, `niNumber`, `nationalInsuranceNumber`, `passportNumber`, `bankAccount`, `accountNumber`, `sortCode`, `salary`, `payroll`, `sensitive`, `notes`, `summary`, `description`, `scope` on record payloads, `assumptions`, `body`, `bodyHtml`, `bodyText`, `prompt`, `documentText`, `extractedText`, `matterTitle`, `title`, `legalName`, `sql`, `parameters`, `values`, `authorization`, `cookie`, `set-cookie`, `secret`, `token`, `apiKey`, `password`) and redacts email-like patterns and bearer/cookie tokens in `Error.message` strings.
2. **`src/server/telemetry.ts` and `src/instrumentation.ts` (new):**
   - `register()` in `src/instrumentation.ts` initialises `@azure/monitor-opentelemetry` when `APPLICATIONINSIGHTS_CONNECTION_STRING` is present and emits a single sanitised start-up event via `emitPlatformStartupTelemetry`.
   - Request/action/route helpers resolve correlation IDs **exclusively through `resolveRequestCorrelationId`** (`src/server/correlationId.ts:10-20`, reading Next.js `await headers()` in request scope and `resolveRequestCorrelationId(null)` outside HTTP scope).
3. **Correlation ID & production `PLATFORM_ENVIRONMENT` hardening (`src/platform/tenantRuntime.ts`, `src/server/authorize.ts`, `src/server/documentGenerationServices.ts`):**
   - Update `src/server/authorize.ts:170, 274`, `src/platform/tenantRuntime.ts:676`, and `src/server/documentGenerationServices.ts:151` to obtain correlation IDs via `resolveRequestCorrelationId` and emit sanitised telemetry.
   - **`P12` / `R371` fail-closed environment check (`src/platform/tenantRuntime.ts:531-544`):** when `process.env.NODE_ENV === 'production'` and `process.env.PLATFORM_ENVIRONMENT` is missing, blank, or invalid, throw `TENANT_CONFIG_ERROR: PLATFORM_ENVIRONMENT must be explicitly set in production` instead of defaulting to `'dev'`.
4. **Configured Key Vault URI guard (`core/src/tenancy/keyVaultSecrets.ts`, `core/schemas/tenant-config.schema.json`, `core/src/config-engine/index.ts`, `core/src/integrations/document-stores/tokenCache.ts`, R411, R413):**
   - Add additive optional `keyVault?: { vaultUri?: string; vaultName?: string }` to `core/schemas/tenant-config.schema.json` (populated from `tenant.bicep`'s `keyVaultUri` / `keyVaultName` deployment outputs so 24-character truncated Azure Key Vault names at `core/infra/main.bicep:62` are taken from configuration/deployment output rather than re-derived, R413; exercised in `core/tests/tenant-config-usage.test.ts`).
   - Limit `core/src/tenancy/keyVaultSecrets.ts` strictly to what live runtime callers and ADR 0024 AG3 need (zero dead/test-only helpers, R411): `assertTenantOwnsKeyVaultSecretRef(ctx, secretRef, configuredVault)` parses `kv://<vault>/<secret>` (or `https://<vault>.vault.azure.net/secrets/<secret>`) and throws `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED` unless `<vault>` matches the calling `TenantContext`'s configured Key Vault (`configuredVault` or `ctx.keyVaultSecretPrefix`).
   - **Live runtime callers wired in S0-13b:**
     1. `DocumentStoreTokenService.acquireDelegatedUserToken` (`core/src/integrations/document-stores/tokenCache.ts:539-548`) and `acquireProvisioningToken` (`:610-650`), checking `authConfig.certificateKeyVaultSecretRef` against `accessContext.tenantContext` before invoking `oboExchangeHandler` or `appTokenHandler`.
     2. `validateTenantConfig` (`core/src/config-engine/index.ts:1923-1933`), verifying every configured `kv://` reference in a tenant package matches that tenant's configured vault.
5. **Container image & bundled job/import entry points (`Dockerfile`, `.dockerignore`, `next.config.ts`, `scripts/build-jobs.mjs`, `scripts/run-job.ts`, `.github/workflows/ci.yml`, R404):**
   - Add `esbuild` (`devDependencies`) and `scripts/build-jobs.mjs` (`npm run build:jobs`, invoked automatically from `npm run build`) compiling `scripts/run-job.ts` (initially supporting `--list`, extended with `migrate` in S0-14 and scheduled jobs in S0-19/S0-19b) into self-contained Node 24 ESM bundle **`dist/jobs/run-job.mjs`** (and `dist/jobs/import-store.mjs` once added in S0-14), requiring zero `tsx` or TypeScript sources in the runtime image.
   - Add `output: 'standalone'` in `next.config.ts` and a multi-stage Node 24 `Dockerfile` + `.dockerignore` running as non-root user (`node`) that copies `.next/standalone`, `.next/static`, `public`, `dist/jobs/`, `core/schemas/`, and tenant config directories, baking zero `.env*` files, secrets, or `data/runtime-store.json`.
   - Add a `docker build` + **`docker run --rm <image> node dist/jobs/run-job.mjs --list`** verification step in `.github/workflows/ci.yml` (R404).
   - Add `APPLICATIONINSIGHTS_CONNECTION_STRING=""` placeholder to `.env.example`.

## Tests

- **Unit tests (`core/tests/telemetry.test.ts` & `src/server/__tests__/telemetry.test.ts` — new):**
  - Request/action/route events carry `tenantId` and `correlationId` resolved strictly via `resolveRequestCorrelationId` (valid header preserved; malformed header replaced with UUID); missing `tenantId` on `emitTenantTelemetryEvent` throws; `emitPlatformStartupTelemetry` tags start-up events cleanly without a user request.
  - Deny-list fields (top-level, nested, arrays, emails/tokens in `Error.message`) are stripped while safe operational fields survive (positive control).
  - Unset `APPLICATIONINSIGHTS_CONNECTION_STRING` performs zero network calls.
  - `getActiveTenantConfiguration()` under `NODE_ENV=production` with `PLATFORM_ENVIRONMENT` unset throws `TENANT_CONFIG_ERROR` (`R371`), and succeeds when explicitly set (positive control).
- **Container & contract tests:**
  - `Dockerfile` / `.dockerignore` contract test + CI `docker build` running `node dist/jobs/run-job.mjs --list` inside the built image (R404).
  - `core/tests/tenant-config-usage.test.ts` exercises optional `keyVault.vaultUri` / `keyVault.vaultName` (including a >24-char slug truncated vault name, R413).
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & ADR 0024 AG3):**
  - **Telemetry isolation:** concurrent Tenant A and Tenant B requests emit isolated `tenantId` + `correlationId` tags; forged `tenantId` fails with `TENANCY_FORGERY_DETECTED` and zero PII logged; valid Tenant A call succeeds (positive control).
  - **Key Vault secret-reference isolation (AG3 via `DocumentStoreTokenService`):** Tenant A calling `acquireDelegatedUserToken` / `acquireProvisioningToken` with a `certificateKeyVaultSecretRef` pointing at Tenant B's Key Vault (`kv://kv-tenantb-test/...`, including 24-char truncated vault names) fails closed with `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`; forged tenant claim fails with `TENANCY_FORGERY_DETECTED`; Tenant A using its own configured vault succeeds (positive control).
- **Guard & E2E tests:** `actionPermissionGuard.test.ts` (`MAX_KNOWN_GAPS = 0`) and `npm run e2e` (9 journeys) pass.

## Help and documentation (rule 11)

- **`src/docs/articles/deployment-and-security.ts`, `src/docs/articles/tenant-settings.ts`, and `docs/deployment-and-security-architecture-guide.md`:** Document `@azure/monitor-opentelemetry` telemetry (`tenantId`, `correlationId`, start-up events, PII deny-list, Model A opt-in), `keyVault.vaultUri` deployment output binding, `dist/jobs/run-job.mjs` bundling, and mandatory production `PLATFORM_ENVIRONMENT`.
- **`docs/release-notes.md` and `docs/roadmap/feature-list.md`:** Record `S0-13b` and update **P12** and **P8**.

## Acceptance criteria

- `@azure/monitor-opentelemetry` emits sanitised telemetry with `tenantId` and `correlationId` (via `resolveRequestCorrelationId`), handling start-up events via `emitPlatformStartupTelemetry` and scrubbing all deny-list fields.
- `NODE_ENV=production` without an explicit valid `PLATFORM_ENVIRONMENT` fails closed (`R371`).
- `DocumentStoreTokenService` and config validation enforce per-tenant Key Vault ownership via `keyVaultSecrets.ts` using configured/output vault names (`R411`, `R413`), proven by two-tenant isolation tests.
- `Dockerfile` compiles and runs `node dist/jobs/run-job.mjs --list` in CI (`R404`), and `npm run ci` passes.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Live Application Insights ingestion/alert verification and ACR push wait on subscription access.

## Rollback

- No database changes. Unsetting `APPLICATIONINSIGHTS_CONNECTION_STRING` disables telemetry export immediately; `git revert` cleanly reverts `s0-13b-telemetry` (remove optional `keyVault` from any config first if added).

## Pull request description must state

- **Change class:** Core observability, Key Vault boundary check, job bundling, and container packaging (`core/src/observability/`, `core/src/tenancy/keyVaultSecrets.ts`, `src/platform/`, `src/server/`, `Dockerfile`).
- **Both hosting models:** Model B exports PII-scrubbed telemetry stamped with `tenantId` and `correlationId` to 1Squared's UK Log Analytics workspace; Model A telemetry is opt-in to the client's workspace or disabled when unset. Both run the identical standalone container image (`dist/jobs/run-job.mjs` for jobs).
- **Migration and rollback:** No database migration; unset `APPLICATIONINSIGHTS_CONNECTION_STRING` or `git revert`.
- **Manual blockers:** Live Application Insights alert verification and ACR push wait on Azure subscription access (`stage-0-plan.md` §8).
