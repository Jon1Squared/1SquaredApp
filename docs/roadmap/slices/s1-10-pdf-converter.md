# S1-10: Dedicated PDF Converter Container (Item `46`)

| | |
|---|---|
| Backlog | Item `46`, `E1`, `E5`, `E9`, `P7` |
| Decision | Stage 1 plan `S1-10` (**Option A Accepted**, 22 November 2026); [ADR 0009](../../decisions/0009-docx-library-and-pdf-conversion.md) (`LibreOfficeHttpPdfConverter`); [ADR 0024](../../decisions/0024-azure-container-apps-hosting.md) (Stage 0 exit decision D5); [ADR 0038](../../decisions/0038-intake-check-interfaces-and-manual-adapters.md) (core API `2.1.0`); [platform architecture standard](../../architecture-standard.md) §§6, 7, 13, 14 |
| Stage plan | [docs/roadmap/stage-1-plan.md](../stage-1-plan.md), WP1 (`S1-10`) |
| Branch | `s1-10-pdf-converter`, stacked on `s1-02a-scoped-queries-server`, targeting `develop` |
| Change class | Infrastructure (`docker/pdf-converter/`, `.github/workflows/ci.yml`, `core/infra/`) + Configuration options (`core/schemas/`, `core/src/config-engine/`) + Core API & domain adapter (`core/src/api/`, `core/src/domain/document-generation/`, `src/server/documentGenerationServices.ts`) |
| Layer | Infrastructure + Core (`@platform/core-api`, `@platform/core`) + Host wiring (`src/server/`) |
| Size | M |
| Depends on | `–` in dependency graph (stacked on `S1-02a` for WP1 serial order `S1-01` -> `S1-03` -> `S1-02a` -> `S1-10`; uses additive `CORE_API_VERSION = '2.1.0'` introduced in `S1-03`) |
| Blocking manual tasks | Building/pushing `pdfConverterContainerImage` in ACR and flipping `enablePdfConverterContainerApp = true` in Azure demo deployment parameters when ready (disabled by default) |
| Baseline | `develop` at `7c2ba3e` |

## Converter architecture decision (**Option A accepted**)

| Criterion | Option A: Minimal self-built `libreoffice-writer-nogui` + Node 24 HTTP wrapper *(Accepted)* | Option B: Pinned upstream Gotenberg 8 (`gotenberg/gotenberg:8.x`) *(Rejected)* |
|---|---|---|
| **Security patching** | Base `node:24-bookworm-slim` matches the existing web container (`Dockerfile:1`), rebuilds directly from this repository in CI with full control over OS updates (`apt-get upgrade`), zero third-party Docker Hub lag, non-root `USER node`, no Chromium or extra daemons. | Depends on third-party Go/Debian/Chromium/PDFtk rebuilds and ships headless Chromium (unnecessary for `.docx` -> `.pdf`). |
| **Image size & memory** | ~650–750 MB compressed (`node:24-bookworm-slim` + `libreoffice-writer-nogui` + liberation/noto fonts without GUI/Impress/Calc/Chromium); fits cleanly inside `ca-pdf` (`1.0 vCPU` / `2Gi` RAM in `platform.bicep:981-985`). | Typically ~1.5–1.8 GB due to bundled Chromium and extra engines. |
| **Licence** | Node 24 HTTP server is proprietary platform code; Debian `libreoffice-writer-nogui` is `MPL-2.0` invoked out-of-process over HTTP in a dedicated container (zero linking). | Gotenberg is `MIT` wrapping `MPL-2.0` LibreOffice + `GPL-2.0` PDFtk CLI binaries out-of-process. |
| **Attack surface** | Minimal single-purpose server exposing **only** `GET /health/live`, `GET /health/ready`, and `POST /convert` (accepts raw `.docx` bytes, checks `PK\x03\x04` header + byte limit, isolated temp dir per request cleaned in `finally`), zero URL-fetch / Chromium SSRF surface. | Richer multi-engine API (Chromium HTML/URL routes) requiring flags to harden unused attack surface. |

**Accepted decision:** Implement **Option A** in `docker/pdf-converter/` (`Dockerfile`, `server.mjs`, `README.md`), built and smoke-tested in GitHub CI (`.github/workflows/ci.yml`).

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **PDF conversion interface & callers (`core/src/api/index.ts:573-580`, `core/src/domain/document-generation/pdfConverter.ts:101-359`):**
   - `DocumentPdfConverter` exposes `{ readonly converterId: string; convertDocxToPdf(input: { docxBytes: Uint8Array; title: string; authorName?: string }): Promise<Uint8Array> }` and lacks optional `tenantId?: string` and `correlationId?: string` for zero-PII outbound correlation logging (`SF-8`).
   - Only `BuiltInOpenXmlPdfConverter` exists; no HTTP LibreOffice adapter or tenant-config converter factory exists.
   - Plug-in points verified:
     - `previewTemplateVersion` (`core/src/domain/document-generation/generationService.ts:295-308`, fallback `new BuiltInOpenXmlPdfConverter()` at `:296`)
     - `generateDocumentFromTemplate` (`core/src/domain/document-generation/generationService.ts:513-521`, fallback at `:514`)
     - `previewTemplateService` (`src/server/documentGenerationServices.ts:1388`, passed at `:1439`)
     - `generateDocumentService` (`src/server/documentGenerationServices.ts:1483`, passed at `:1543`)
2. **Infrastructure scaffold (`core/infra/main.bicep:54-58, 80-85`, `core/infra/modules/platform.bicep:939-1665`, `core/infra/parameters/demo.bicepparam:20`):**
   - `platform.bicep:948-996` already declares `pdfConverterContainerApp` (`ca-pdf-*`) with `external: false`, `allowInsecure: false`, `targetPort: 8080`, `enablePdfConverterContainerApp: false`, `PDF_CONVERTER_IMAGE_REQUIRED` fail-closed guard (`:208-210`), and `pdfConverterEnv` setting `DOC_CONVERTER_URL = https://${pdfConverterAppName}.internal.${containerAppsEnv.properties.defaultDomain}` (`:941`).
   - **Gaps (`SF-8`) to close in `S1-10`:**
     - `pdfConverterContainerApp` (`:977-990`) has **no `Startup`, `Liveness`, or `Readiness` probes**;
     - `scale.minReplicas` is hardcoded to `0` (`:988`) with no Bicep parameter (`pdfConverterMinReplicas`);
     - `pdfConverterEnv` (`DOC_CONVERTER_URL`) is wired onto `webContainerApp` (`:1032`), **not** onto scheduled Container Apps jobs (`keyDateRemindersJob` `:1369`, `usageRetentionPurgeJob` `:1427`, `enquiryAnonymisationJob` `:1485`, `registerRemindersJob` `:1543`, `outboxDrainJob` `:1601`, `notificationDigestsJob` `:1659`);
     - `core/schemas/tenant-config.schema.json:744-960` (`documentGeneration`) lacks `pdfConverter` and `pdfConverterFallback` settings.

## Files and changes

1. **Container image (`docker/pdf-converter/Dockerfile`, `docker/pdf-converter/server.mjs`, `docker/pdf-converter/README.md`):**
   - Minimal Debian `FROM node:24-bookworm-slim` installing `tini` (`ENTRYPOINT ["/usr/bin/tini", "--"]` as PID 1 reaper), `libreoffice-writer-nogui`, and Liberation/Noto fonts cleanly (`rm -rf /var/lib/apt/lists/*`), running as non-root `USER node` on port `8080`.
   - `server.mjs` (zero third-party npm dependencies):
     - `GET /health/live`: HTTP `200` `{"status":"live"}`.
     - `GET /health/ready`: HTTP `200` `{"status":"ready"}` once `soffice --version` readiness check succeeds (`503` otherwise) with a `4_500` ms (`4.5s`) subprocess timeout bounded inside Bicep's `5s` probe, warmed at start-up and positively cached for `60s` (`PDF_CONVERTER_READINESS_CACHE_MS`, longer than the `15s` probe interval).
     - `POST /convert`: enforces `PDF_CONVERTER_MAX_CONCURRENCY` (`2` default, returning HTTP `503` `PDF_CONVERTER_BUSY` + `Retry-After` + `Connection: close` when saturated), releases concurrency slots cleanly on `req.on('close')` / `ECONNRESET` / `req.aborted` client aborts (`CLIENT_ABORT` / `499`), enforces `MAX_DOCX_BYTES` (`25 MiB`, returning clean HTTP `413` JSON on both `Content-Length` and chunked overflows), verifies ZIP `PK\x03\x04` signature (HTTP `400`), writes to an isolated per-request temp dir (`--headless --norestore --nodefault --nolockcheck -env:UserInstallation=file:///tmp/... --convert-to pdf`), enforces `45_000` ms subprocess timeout killing the entire LibreOffice process group/tree (`SIGKILL` on `-pid` on POSIX / `taskkill /T /F` on Windows -> HTTP `504`, logging zero-PII `pdf_converter.kill_unconfirmed` if the child does not exit within the force-finish window), validates `%PDF-` output signature, returns `application/pdf`, cleans temp dir in `finally`, ignores `PDF_CONVERTER_SOFFICE_BIN` / `PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON` test hooks under `NODE_ENV=production` (catching malformed JSON with `pdf_converter.invalid_pre_args_json`), reads `x-correlation-id` / `x-tenant-id` headers when present, and logs **only** `{ event, correlationId, tenantId?, outcome, durationMs, inputBytes, outputBytes, errorCode }` (never document title or bytes).
2. **CI build & container readiness smoke step (`.github/workflows/ci.yml`):**
   - Build `onesquared-pdf:test` from `docker/pdf-converter/Dockerfile`, start `onesquared-pdf-smoke` without `--rm` (`EXIT` trap cleanup), poll `/health/ready` (up to `60s`), run a real `.docx` -> `%PDF-` `POST /convert` round-trip check, run a second timeout smoke container (`PDF_CONVERTER_SOFFICE_TIMEOUT_MS=1500`) with `scripts/smoke-pdf-converter.mjs --expect-timeout` (sending a heavy multi-table `.docx`, asserting HTTP `504`, logging a non-empty `/proc/[0-9]*/stat` snapshot, failing if empty, and asserting zero `'Z'` zombie processes), and print `docker logs --tail 200` on failure.
3. **Bicep infrastructure & `SF-8` hardening (`core/infra/main.bicep`, `core/infra/modules/platform.bicep`, `core/infra/parameters/demo.bicepparam`, `core/tests/infra-bicep-contract.test.ts`):**
   - Keep `enablePdfConverterContainerApp bool = false` default (`demo.bicepparam:20`), `external: false`, `allowInsecure: false`, and zero secrets in parameters (shared-secret Key Vault authentication on internal `/convert` is deferred to `B23` and Dockerfile SHA-256 base-image digest / package pinning is deferred to `B24`; both are also recorded in `docs/roadmap/stage-0-plan.md` §3).
   - Add configurable `@minValue(0) @maxValue(4) param pdfConverterMinReplicas int = 0` in `main.bicep` and `platform.bicep` (`minReplicas: pdfConverterMinReplicas`, `maxReplicas: 4`, plus explicit `http` scale rule `concurrentRequests: '2'` on `pdfConverterContainerApp`), keeping `demo.bicepparam` at default `0` while allowing hosted/busy environments to set `1+`.
   - Add `Startup` (`/health/live`, `initialDelaySeconds: 5`, `periodSeconds: 10`, `timeoutSeconds: 5`, `failureThreshold: 10`), `Liveness` (`/health/live`, `initialDelaySeconds: 15`, `periodSeconds: 30`, `timeoutSeconds: 5`, `failureThreshold: 3`), and `Readiness` (`/health/ready`, `initialDelaySeconds: 10`, `periodSeconds: 15`, `timeoutSeconds: 5`, `failureThreshold: 3`) probes on `pdfConverterContainerApp` (`core/infra/modules/platform.bicep`).
   - Inject `pdfConverterEnv` (`concat(runtimeCommonEnv, pdfConverterEnv)`) onto **all 7** scheduled Container Apps jobs (`keyDateRemindersJob`, `usageRetentionPurgeJob`, `enquiryAnonymisationJob`, `registerRemindersJob`, `outboxDrainJob`, `notificationDigestsJob`, `quoteExpiryJob`) alongside `webContainerApp` when `deployApps && enablePdfConverterContainerApp`.
4. **Core API `2.1.0` addition, config options & `HttpPdfConverter` (`core/schemas/`, `core/src/config-engine/`, `core/src/api/`, `core/src/domain/document-generation/`, `src/server/`):**
   - `core/src/api/index.ts:573-580`: add optional `readonly tenantId?: string; readonly correlationId?: string;` on `DocumentPdfConverter.convertDocxToPdf` input (part of the additive `CORE_API_VERSION = '2.1.0'` surface introduced in `S1-03`; note in `core/docs/CHANGELOG.md`).
   - `core/schemas/tenant-config.schema.json` & `core/src/config-engine/index.ts` (including nested `documentGeneration` merge in `loadAndValidateTenantConfig`): add backward-compatible options under `documentGeneration`:
     - `pdfConverter`: `'builtin' | 'container'` (default `'builtin'`)
     - `pdfConverterFallback`: `'builtin' | 'fail'` (default `'builtin'`)
   - `core/src/domain/document-generation/pdfConverter.ts`:
     - `HttpPdfConverter`: `AbortController` timeout defaulting to **`60_000` ms** (explicitly sizing `15s` headroom above the `45s` `soffice` subprocess timeout so Container Apps `minReplicas: 0` cold starts succeed cleanly), automatic HTTP `503` retry loop (up to 3 retries honouring `Retry-After` capped at `5s` within the overall `60s` budget) throwing `PDF_CONVERTER_BUSY` (`'The PDF converter is busy. Please try again in a moment.'`) once exhausted, `25 MiB` `.docx` ceiling, declared `Content-Length` + streaming `50 MiB` (`maxPdfBytes`) PDF response ceiling, `%PDF-` response validation, forwarding `x-tenant-id` / `x-correlation-id` headers when present, typed `PDF_CONVERTER_*` errors, and configurable constructor `timeoutMs` / `maxPdfBytes`.
     - `FallbackAwarePdfConverter`: emits structured zero-PII warning `document_generation.pdf_converter_fallback` (`tenantId`, `correlationId`, `errorCode` — never document title/content) when falling back to `BuiltInOpenXmlPdfConverter`, or throws cleanly when `pdfConverterFallback === 'fail'`.
     - `selectDocumentPdfConverter(tenantConfig, options)` reading both `pdfConverter` and `pdfConverterFallback`, plus `formatPdfConverterUserMessage(code)` British English user messages.
   - Plug into `generationService.ts:296, 514` and `src/server/documentGenerationServices.ts`, passing `tenantConfig`, `process.env.DOC_CONVERTER_URL`, `tenantId`, and `correlationId`; `generateDocumentService` catches `PdfConverterError` outside its rolled-back transaction and returns `{ status: 'converter_busy' | 'converter_failed', errorCode, message }` cleanly to `DocumentGenerationModal` (`R688`).

## Tests

*(Record fail-first evidence before implementation in `Stage1-WP1-report.md`.)*

1. **HTTP converter adapter unit tests (`core/tests/pdf-converter-adapter.test.ts`):**
   - Against an in-process `node:http` test server:
     - `200` valid `%PDF-` returns bytes cleanly and transmits `x-correlation-id` and `x-tenant-id` headers (zero document title/PII in logs);
     - Cold-start / slow response within `timeoutMs` (`60_000` ms default; tested with short injected `timeoutMs`) succeeds; exceeding `timeoutMs` aborts cleanly (`PDF_CONVERTER_TIMEOUT`);
     - HTTP `500` / `503` / non-`%PDF-` output / oversized payload fail cleanly (`PDF_CONVERTER_HTTP_ERROR` / `PDF_CONVERTER_INVALID_OUTPUT` / `PDF_CONVERTER_SIZE_LIMIT`);
     - Unreachable / missing `DOC_CONVERTER_URL` with `pdfConverter: 'container'` falls back to `BuiltInOpenXmlPdfConverter` with `document_generation.pdf_converter_fallback` log when `pdfConverterFallback: 'builtin'`, and fails loudly when `pdfConverterFallback: 'fail'`.
2. **Configuration & selection tests (`core/tests/document-generation.test.ts` & `core/tests/tenant-config-usage.test.ts`):**
   - `pdfConverter` (`'builtin' | 'container'`) and `pdfConverterFallback` (`'builtin' | 'fail'`) select the expected converter in `previewTemplateService` and `generateDocumentService`; `tenant-config-usage.test.ts` confirms every new schema leaf is read in runtime code.
3. **Bicep contract tests (`core/tests/infra-bicep-contract.test.ts`):**
   - `az bicep build` and `az bicep lint` pass.
   - Contract assertions verify `docker/pdf-converter/Dockerfile` uses `tini` (`ENTRYPOINT ["/usr/bin/tini", "--"]`), `ca-pdf` has `external: false`, `allowInsecure: false`, valid `Startup` / `Liveness` / `Readiness` probe bounds, `pdfConverterMinReplicas` parameter (`default: 0`), `enablePdfConverterContainerApp: false` default (`demo.bicepparam`), `PDF_CONVERTER_IMAGE_REQUIRED` guard, and `DOC_CONVERTER_URL` wired onto `webContainerApp` **and** all 7 scheduled Container Apps jobs without secrets.

## Help and documentation (rule 11)

- `src/docs/articles/document-generation.ts`: document `Built-in OpenXML` vs `Dedicated Container` converter modes, cold-start timeout/fallback behaviour, and fidelity differences.
- `src/docs/articles/tenant-settings.ts`: document `documentGeneration.pdfConverter` and `documentGeneration.pdfConverterFallback`.
- `src/docs/articles/deployment-and-security.ts`: document `ca-pdf` internal-only Container App (`DOC_CONVERTER_URL`), `pdfConverterMinReplicas`, health probes, job injection, non-root LibreOffice image build, and zero-PII logging.
- `core/docs/CHANGELOG.md`: note optional `tenantId` / `correlationId` on `DocumentPdfConverter.convertDocxToPdf` under v`2.1.0`.
- `docs/roadmap/feature-list.md`: update row `46` (`Completed` once image + CI smoke + adapter + Bicep pass, noting `enablePdfConverterContainerApp = false` default in `demo.bicepparam` until pushed to ACR), `E1`, `E5`, `E9`, and `P7`.
- `docs/release-notes.md`: add `S1-10` entry under `Unreleased`.

## Acceptance criteria

- `docker/pdf-converter/Dockerfile` builds in CI, passes `/health/ready` and a `.docx` -> `.pdf` smoke conversion in CI, and Bicep wires `ca-pdf` with internal-only ingress, `Startup`/`Liveness`/`Readiness` probes, configurable `pdfConverterMinReplicas`, explicit `http` concurrency scaling (`concurrentRequests: '2'`), disabled default, and `DOC_CONVERTER_URL` on `webContainerApp` plus all 7 scheduled Container Apps jobs.
- `previewTemplateService` and `generateDocumentService` honour `documentGeneration.pdfConverter` / `pdfConverterFallback` with cold-start-tolerant timeouts, size limits, optional `tenantId`/`correlationId` correlation logging, and non-silent fallback, covered by unit, config-selection, and Bicep contract tests.

## Manual blockers

- Pushing the converter image to demo ACR (`acronesquareddemo2lwvta`) and enabling `enablePdfConverterContainerApp = true` in Azure demo deployment parameters (`Stage 1 plan` §8). Demo tenant uses the container converter with built-in fallback; enabled at deploy time (`client-not-a-law-firm/config/environments/demo.json`, Decision `A4`).

## Rollback

- Default remains `enablePdfConverterContainerApp = false` and `documentGeneration.pdfConverter = 'builtin'`; revert `s1-10-pdf-converter` cleanly with zero database migrations.

## Pull request description must state

- **Change class:** Infrastructure (`docker/pdf-converter/`, `.github/workflows/ci.yml`, `core/infra/`), configuration options (`documentGeneration.pdfConverter`, `documentGeneration.pdfConverterFallback`, `pdfConverterMinReplicas`), and Core/Host PDF converter adapter (item `46`).
- **Both hosting models:** Identical `HttpPdfConverter` + internal `ca-pdf` container architecture across Model A (`single_tenant`) and Model B (`multi_tenant`), with per-request isolated temp directories and zero persisted state or PII.
- **Migration and rollback:** No database migration; `git revert` restores `BuiltInOpenXmlPdfConverter`-only behaviour cleanly.
