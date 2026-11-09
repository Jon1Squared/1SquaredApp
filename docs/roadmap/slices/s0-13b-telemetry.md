# S0-13b: Application Insights telemetry and container runtime hardening

| | |
|---|---|
| Backlog | P12, P8 |
| Decision | [ADR 0024: Host the Application on Azure Container Apps](../../decisions/0024-azure-container-apps-hosting.md) (D1, accepted 6 November 2026); Platform Architecture Standard §13 (Observability) and Rule 5 (zero personal data or client content in logs/telemetry) |
| Stage plan | `docs/roadmap/stage-0-plan.md`, phase 0B (`S0-13` second pull request `S0-13b`, WP4 Checkpoint 4a) |
| Branch | `s0-13b-telemetry`, from `s0-13-container-apps-infrastructure`, targeting `develop` |
| Change class | Core feature / observability & container runtime (`core/src/observability/`, `src/platform/`, `src/server/`, `Dockerfile`). |
| Size | M |
| Depends on | S0-13 (Application Insights resource & `APPLICATIONINSIGHTS_CONNECTION_STRING` output), S0-30 (`resolveRequestCorrelationId` in `src/server/correlationId.ts`, merged). |
| Blocking manual tasks | Azure subscription access (`docs/roadmap/stage-0-plan.md` §8) to verify live ingestion and alert rules in Azure Application Insights. |
| Baseline | `develop` at `52390b9` (stacked on `s0-13-container-apps-infrastructure`) |

## What exists today

Checked against `develop` (`52390b9`):

1. **No Application Insights / OpenTelemetry SDK or telemetry pipeline:**
   - `package.json:19-39` has no Application Insights or OpenTelemetry exporter, and `src/instrumentation.ts` does not exist.
   - Structured `JSON.stringify` `console.info` / `console.warn` / `console.error` calls are scattered across `src/platform/tenantRuntime.ts:588, 681`, `src/server/authorize.ts:60`, `src/server/services.ts:593, 4705, 6123`, `src/server/documentGenerationServices.ts:145`, and `src/app/api/matters/extract/route.ts` without a shared telemetry emitter or central PII scrubbing filter.
2. **Correlation ID helper exists (`src/server/correlationId.ts:1-20`, added in S0-30), but two legacy callers bypass it:**
   - `resolveRequestCorrelationId(requestHeaders)` (`src/server/correlationId.ts:10-20`) validates incoming `x-correlation-id` against `SAFE_CORRELATION_ID_PATTERN` (`/^[A-Za-z0-9._:-]{1,128}$/`) and mints a fresh `randomUUID()` otherwise.
   - However, `src/platform/tenantRuntime.ts:676` (`req-${Date.now()}`) and `src/server/documentGenerationServices.ts:151` (`corr-blob-key-fallback-${Date.now()}`) still synthesise ad-hoc timestamp correlation IDs instead of using `resolveRequestCorrelationId` or a UUID correlation ID, and `src/server/authorize.ts:170, 274` mints `corr-act-${randomUUID()}` / `corr-rte-${randomUUID()}` without reading request headers via `resolveRequestCorrelationId`.
3. **Production environment fallback (`P12` / `R371`):**
   - `getActiveTenantConfiguration()` in `src/platform/tenantRuntime.ts:533-540` falls back to `'dev'` whenever `process.env.PLATFORM_ENVIRONMENT` is unset (`?? 'dev'`), even when `process.env.NODE_ENV === 'production'`. Row `P12` (`docs/roadmap/feature-list.md:125`) explicitly requires refusing the `'dev'` fallback when `NODE_ENV=production`.
4. **Key Vault tenant resolution & Container image (`ADR 0024` Consequences `:56, 59`):**
   - No `Dockerfile` or `.dockerignore` exists at the repository root for building the shared Container Apps web & job image.
   - `resolveTenantKeyVaultSecretUri` / per-tenant Key Vault secret resolution has not yet been isolated behind a core helper with the ADR 0024 AG3 two-tenant test proving a request for Tenant A never resolves a secret from Tenant B's Key Vault.

## Files and changes

1. **`core/src/observability/telemetry.ts` (new, exported via `core/src/index.ts`):**
   - Provides a platform-owned, dependency-light telemetry emitter and processor (`PlatformTelemetryRecorder`, `emitPlatformTelemetryEvent`, `emitPlatformTelemetryException`, `sanitizeTelemetryProperties`) supporting:
     - Optional Application Insights export when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (and opt-in in Model A per `docs/architecture-standard.md:119`; silent/no-op network export when unset in `dev`/`test`).
     - Mandatory `tenantId` and `correlationId` tags on every emitted event, metric, dependency span, and exception (refusing or flagging events missing either field).
     - **Recursive personal-data & client-content deny-list scrubber (Standard §13, Rule 5):** strips any key matching a case-insensitive deny-list (and nested object/array entries or URL query strings) before anything reaches logs or Application Insights, including: `email`, `upn`, `preferred_username`, `entraObjectId`, `oid`, `sub`, `firstName`, `lastName`, `surname`, `preferredName`, `otherNames`, `displayName`, `name`, `phone`, `phones`, `mobile`, `address`, `addresses`, `line1`, `line2`, `postcode`, `dateOfBirth`, `dob`, `niNumber`, `nationalInsuranceNumber`, `passportNumber`, `bankAccount`, `accountNumber`, `sortCode`, `salary`, `payroll`, `sensitive`, `notes`, `summary`, `description`, `scope`, `assumptions`, `body`, `bodyHtml`, `bodyText`, `prompt`, `documentText`, `extractedText`, `matterTitle`, `title`, `legalName`, `sql`, `parameters`, `values`, `authorization`, `cookie`, `set-cookie`, `secret`, `token`, `apiKey`, `password`. Also scrubs email-like patterns and bearer/cookie tokens in free-text error messages so client content or SQL parameters never leak via thrown `Error.message` strings.
2. **`src/server/telemetry.ts` and `src/instrumentation.ts` (new):**
   - Wires the Next.js server runtime (`register()` in `src/instrumentation.ts`) to initialise the Application Insights / OpenTelemetry exporter when `APPLICATIONINSIGHTS_CONNECTION_STRING` is configured.
   - Provides `recordRequestTelemetry` / `recordServerErrorTelemetry` helpers for `src/server/authorize.ts` (`guardedAction`, `guardedRoute`, and `guardedJob` in S0-19) that **read request correlation IDs exclusively through `resolveRequestCorrelationId`** (`src/server/correlationId.ts:10-20`, passing `await headers()` in Next.js request scope and falling back to `resolveRequestCorrelationId(null)` outside HTTP request scope).
3. **Correlation ID & production `PLATFORM_ENVIRONMENT` hardening (`src/platform/tenantRuntime.ts`, `src/server/authorize.ts`, `src/server/documentGenerationServices.ts`):**
   - Update `src/server/authorize.ts:170, 274` to obtain `correlationId` via `resolveRequestCorrelationId` (from Next.js `headers()` when available) and emit structured telemetry via `src/server/telemetry.ts` on action/route execution, authorisation denial, and unhandled errors.
   - Replace ad-hoc `req-${Date.now()}` in `src/platform/tenantRuntime.ts:676` and `corr-blob-key-fallback-${Date.now()}` in `src/server/documentGenerationServices.ts:151` with `resolveRequestCorrelationId` / UUID correlation IDs and route their logs through the sanitised telemetry helper.
   - **`P12` / `R371` fail-closed environment check (`src/platform/tenantRuntime.ts:531-544`):** extract `resolveConfiguredEnvironment()` so that when `process.env.NODE_ENV === 'production'` and `process.env.PLATFORM_ENVIRONMENT` is missing, blank, or invalid, it throws `TENANT_CONFIG_ERROR: PLATFORM_ENVIRONMENT must be explicitly set in production` instead of silently defaulting to `'dev'`. Also require explicit `PLATFORM_HOSTING_MODE` or validate it strictly. (Update `npm run build` / `e2e/start-server.mjs` / `playwright.config.ts` check if any production-mode script omits `PLATFORM_ENVIRONMENT` — `.github/workflows/ci.yml:76, 87` and `scripts/verify-ci.mjs` already set `PLATFORM_ENVIRONMENT` explicitly.)
4. **Per-tenant Key Vault secret resolver (`core/src/tenancy/keyVaultSecrets.ts` — new, exported via `@platform/core`):**
   - Resolves a tenant's Key Vault URI (`https://kv-<sanitizedTenantId>-<environment>.vault.azure.net/`) and secret identifier strictly from `TenantContext` (`tenantId`) + validated `TenantConfiguration` (`integrations.pmsConnectionSecretVaultRef`, etc.), rejecting any vault URI or secret reference belonging to a different tenant (`TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`) so in hosted multi-tenant mode (where the shared Managed Identity has `Key Vault Secrets User` on each tenant vault per ADR 0024 AG3) Tenant A can never resolve a secret from Tenant B's vault.
5. **Container image build (`Dockerfile`, `.dockerignore`, `next.config.ts`, `.github/workflows/ci.yml`):**
   - Configure `next.config.ts` (`output: 'standalone'`) or a multi-stage Node 24 Alpine/bookworm-slim `Dockerfile` + `.dockerignore` running as non-root user (`node`), capable of serving both the Next.js web app (`PORT=3000`) and Container Apps jobs (`node scripts/run-job.mjs <jobKey>`), baking zero `.env*` files, secrets, or local `data/runtime-store.json` into the image.
   - Add a `docker build` smoke verification step in `.github/workflows/ci.yml` (and conditional check in `scripts/verify-ci.mjs` when Docker is available; publishing to ACR gated on Azure registry configuration).
   - Add `APPLICATIONINSIGHTS_CONNECTION_STRING=""` (empty non-secret placeholder with Model A opt-in comment) to `.env.example`.

## Tests

- **Unit tests (`core/tests/telemetry.test.ts` and `src/server/__tests__/telemetry.test.ts` — new):**
  - Every emitted event, dependency span, and exception carries both `tenantId` and `correlationId`.
  - Correlation IDs on `guardedAction` and `guardedRoute` are read exclusively via `resolveRequestCorrelationId`: valid `x-correlation-id` header is preserved; malformed/oversized/injection header (`"bad id\n..."`) is rejected and replaced with a UUID; missing header mints a UUID.
  - Every field on the personal-data & client-content deny-list (top-level, nested objects, arrays, Error messages containing email addresses or SQL parameter dumps) is stripped/redacted before reaching the telemetry sink or log output, while safe operational fields (`event`, `action`, `code`, `durationMs`, `statusCode`, `recordType`, `recordId`) are preserved (positive control).
  - When `APPLICATIONINSIGHTS_CONNECTION_STRING` is unset (or telemetry opt-out is configured in Model A), zero network calls are attempted and the application runs normally.
  - `getActiveTenantConfiguration()` under `NODE_ENV=production` with `PLATFORM_ENVIRONMENT` unset throws `TENANT_CONFIG_ERROR` (`R371`), and succeeds when `PLATFORM_ENVIRONMENT=live` or `test` is explicitly set (positive control).
- **Contract tests:**
  - `Dockerfile` / `.dockerignore` contract test verifying `.env*`, `.git`, `node_modules`, and `data/runtime-store.json` are excluded in `.dockerignore` and the container runs as non-root on Node 24.
- **Two-tenant isolation tests (`core/tests/isolation.test.ts`, Rule 9 & ADR 0024 AG3):**
  - **Telemetry tenant isolation:** concurrent `AsyncLocalStorage` requests for Tenant A and Tenant B emit telemetry events stamped with their own `tenantId` and `correlationId` with zero cross-request bleed; a forged tenant claim on `guardedAction`/`guardedRoute` is rejected with `TENANCY_FORGERY_DETECTED` (or `UNAUTHENTICATED`), emits a denial event with zero PII, and a valid Tenant A call in the same test succeeds (positive control).
  - **Key Vault secret resolution isolation (ADR 0024 AG3):** Tenant A context attempting to resolve a secret URI or `VaultRef` pointing at Tenant B's Key Vault (`kv-tenantb-...`) fails closed with `TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED`; forged tenant claim fails with `TENANCY_FORGERY_DETECTED`; Tenant A resolving its own vault reference succeeds (positive control).
- **Guard & E2E tests:**
  - `src/server/__tests__/actionPermissionGuard.test.ts` passes with `MAX_KNOWN_GAPS = 0`.
  - `npm run e2e` (9 Playwright role journey tests, running against production `next start` with `PLATFORM_ENVIRONMENT=test`) passes.

## Help and documentation (rule 11)

- **`src/docs/articles/deployment-and-security.ts`:**
  - Document Application Insights observability (`tenantId` + `correlationId` on every event, recursive PII/client-content deny-list, Model A opt-in telemetry ownership per Standard §13), per-tenant Key Vault URI isolation, and mandatory explicit `PLATFORM_ENVIRONMENT` in production builds.
- **`src/docs/articles/tenant-settings.ts` and `docs/deployment-and-security-architecture-guide.md`:**
  - Document `APPLICATIONINSIGHTS_CONNECTION_STRING` (optional/client-owned in Model A) and production `PLATFORM_ENVIRONMENT` enforcement.
- **`docs/release-notes.md`:**
  - Record Application Insights telemetry, PII deny-list scrubbing, container `Dockerfile`, AG3 Key Vault isolation test, and production `PLATFORM_ENVIRONMENT` fail-closed enforcement (`S0-13b`).
- **`docs/roadmap/feature-list.md`:**
  - Update row **P12** (`Infrastructure gaps`, recording completion of all repo-side infrastructure, container, telemetry, and `R371` items; note Azure live deployment verification blocker if subscription access is still pending) and row **P8** (`Two-tenant tests`, adding telemetry and Key Vault isolation tests).

## Acceptance criteria

- Application Insights telemetry is emitted for requests, actions, jobs, and errors with `tenantId` and `correlationId` on every event.
- Correlation IDs are resolved exclusively through `resolveRequestCorrelationId` (`src/server/correlationId.ts`).
- All personal data, client matter content, secrets, and SQL parameters on the deny-list are stripped before export or logging, proven by automated tests.
- `NODE_ENV=production` without an explicit valid `PLATFORM_ENVIRONMENT` fails closed (`R371`).
- Two-tenant Key Vault secret-resolution and telemetry isolation tests pass in `core/tests/isolation.test.ts`.
- `Dockerfile` builds cleanly in CI, `npm run ci` passes, and Help, release notes, and `feature-list.md` are updated.

## Manual blockers

- **Azure subscription access (`docs/roadmap/stage-0-plan.md` §8):** Verifying live Application Insights ingestion, KQL dashboards, and Azure Monitor alert delivery against a real workspace waits on Azure subscription access.
- **Azure Container Registry (`ACR`) push:** Pushing built images to ACR waits on Azure subscription provisioning; `docker build` verification runs in CI without Azure credentials.

## Rollback

- No database schema or stored data changes.
- Unsetting `APPLICATIONINSIGHTS_CONNECTION_STRING` immediately disables external telemetry export without redeploying; reverting the `s0-13b-telemetry` merge commit cleanly restores pre-telemetry behaviour (ensure `PLATFORM_ENVIRONMENT` remains set in any production environment, as CI already does).

## Pull request description must state

- **Change class:** Core observability & runtime hardening (`core/src/observability/`, `core/src/tenancy/keyVaultSecrets.ts`, `src/platform/tenantRuntime.ts`, `src/server/authorize.ts`, `Dockerfile`).
- **Both hosting models:** In Model B (hosted), `APPLICATIONINSIGHTS_CONNECTION_STRING` sends PII-scrubbed operational telemetry stamped with `tenantId` and `correlationId` to 1Squared's UK Log Analytics workspace. In Model A (single-tenant client Azure), telemetry is opt-in and directed to the firm's own Application Insights resource (or disabled altogether when `APPLICATIONINSIGHTS_CONNECTION_STRING` is unset).
- **Migration and rollback:** No database migration. Rollback is unsetting `APPLICATIONINSIGHTS_CONNECTION_STRING` or `git revert`.
- **Manual blockers:** Live Application Insights alert verification and ACR image push wait on Azure subscription access (`stage-0-plan.md` §8).
