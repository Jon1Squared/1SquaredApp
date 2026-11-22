# S1-10: Dedicated PDF Converter Container (Item `46`)

| | |
|---|---|
| Backlog | Item `46`, `E1`, `E5`, `E9` |
| Decision | [ADR 0009](../../decisions/0009-docx-library-and-pdf-conversion.md) (`LibreOfficeHttpPdfConverter`), [ADR 0024](../../decisions/0024-azure-container-apps-hosting.md) (`Stage 0 exit decision D5`), [platform architecture standard](../../architecture-standard.md) §§6, 7, 13, 14 |
| Stage plan | `docs/roadmap/stage-1-plan.md`, WP1 (`S1-10`) |
| Branch | `s1-10-pdf-converter`, stacked on `s1-03-intake-check-interfaces`, targeting `develop` |
| Change class | Infrastructure (`docker/pdf-converter/`, `.github/workflows/ci.yml`, `core/infra/`) + Configuration option (`core/schemas/`, `core/src/config-engine/`) + Core integration/domain adapter (`core/src/domain/document-generation/`, `src/server/documentGenerationServices.ts`) |
| Layer | Infrastructure + Core (`@platform/core`, `@platform/core-api`) + Host wiring (`src/server/`) |
| Size | M |
| Depends on | `–` in dependency graph (stacked on `S1-03` for WP1 serial review) |
| Blocking manual tasks | Building/pushing `pdfConverterContainerImage` in ACR and flipping `enablePdfConverterContainerApp = true` in Azure demo deployment (optional at first; disabled by default) |
| Baseline | `develop` at `7c2ba3e` |

## Converter architecture choice & trade-offs (`Stage1-WP1-prompt.md` line `122`)

| Criterion | Option A: Minimal self-built `libreoffice-writer-nogui` + Node 24 HTTP wrapper *(Recommended)* | Option B: Pinned upstream Gotenberg 8 (`gotenberg/gotenberg:8.x`) |
|---|---|---|
| **Security patching** | Base `node:24-bookworm-slim` matches our existing web container (`Dockerfile:1`), rebuilds directly from our repository in CI with full control over OS updates (`apt-get upgrade`), zero third-party Docker Hub supply-chain lag, non-root `USER node`, no Chromium or extra daemons installed. | Requires tracking third-party Go/Debian/Chromium/PDFtk CVE releases and pulling an upstream image that bundles headless Chromium (not needed for `.docx` → `.pdf`) alongside LibreOffice. |
| **Image size & memory** | ~650–750 MB compressed (`node:24-bookworm-slim` + `libreoffice-writer-nogui` + liberation/noto fonts without GUI/Impress/Calc/Chromium); comfortably fits `ca-pdf` (`1.0 vCPU` / `2Gi` RAM in `platform.bicep:981-985`). | Typically ~1.5–1.8 GB because official images ship Chromium, unoconv/uno, and PDFtk alongside LibreOffice. |
| **Licence** | Node 24 HTTP server is proprietary platform code; Debian `libreoffice-writer-nogui` is `MPL-2.0` invoked out-of-process over HTTP as a separate container process (zero linking or viral copyleft risk). | Gotenberg is `MIT`, wrapping `MPL-2.0` LibreOffice + `GPL-2.0` PDFtk CLI binaries out-of-process. |
| **Attack surface** | Minimal single-purpose server exposing **only** `GET /health/live`, `GET /health/ready`, and `POST /convert` (accepts raw `.docx` bytes, rejects non-ZIP/oversized payloads, isolated per-request temp dir cleaned in `finally`), no URL-fetching / Chromium SSRF surface. | Richer multi-engine API (Chromium HTML/URL routes) requiring flags (`--chromium-disable-javascript`, etc.) to harden unused attack surface. |

**Recommendation:** Use **Option A** — a minimal Debian `node:24-bookworm-slim` + `libreoffice-writer-nogui` HTTP wrapper in `docker/pdf-converter/` (`Dockerfile` + `server.mjs`), built and smoke-tested in GitHub CI (`ci.yml`) on every PR.

## What exists today

Checked against `develop` (`7c2ba3e`):

1. **PDF conversion interface & callers (`core/src/api/index.ts:573-580`, `core/src/domain/document-generation/pdfConverter.ts:101-359`):**
   - `DocumentPdfConverter` exposes `{ readonly converterId: string; convertDocxToPdf(input: { docxBytes: Uint8Array; title: string; authorName?: string }): Promise<Uint8Array> }` (currently lacks optional `{ tenantId?: string; correlationId?: string }` for zero-PII outbound correlation logging).
   - Only `BuiltInOpenXmlPdfConverter` exists; no HTTP LibreOffice adapter or tenant-config converter factory exists.
   - Plug-in points verified:
     - `previewTemplateVersion` (`core/src/domain/document-generation/generationService.ts:295-308`, fallback `new BuiltInOpenXmlPdfConverter()` at **`:296`**)
     - `generateDocumentFromTemplate` (`core/src/domain/document-generation/generationService.ts:513-521`, fallback at **`:514`**)
     - `previewTemplateService` (`src/server/documentGenerationServices.ts:1388`, passed at **`:1439`**)
     - `generateDocumentService` (`src/server/documentGenerationServices.ts:1483`, passed at **`:1543`**)
2. **Infrastructure scaffold (`core/infra/main.bicep:80-85, 190-191, 250`, `core/infra/modules/platform.bicep:54-58, 177, 208-210, 939-996, 1032`, `core/infra/parameters/demo.bicepparam:20`):**
   - `platform.bicep:948-996` already declares `pdfConverterContainerApp` (`ca-pdf-*`) with `external: false`, `allowInsecure: false`, `targetPort: 8080`, `enablePdfConverterContainerApp: false`, `PDF_CONVERTER_IMAGE_REQUIRED` fail-closed guard (`:208-210`), and `pdfConverterEnv` setting `DOC_CONVERTER_URL = https://${pdfConverterAppName}.internal.${containerAppsEnv.properties.defaultDomain}` (`:941`).
   - **Gaps to close in `S1-10`:**
     - `pdfConverterContainerApp` (`:977-986`) has **no `Startup`, `Liveness`, or `Readiness` probes**;
     - `pdfConverterEnv` (`DOC_CONVERTER_URL`) is concatenated **only** onto `webContainerApp` (`:1032`), **not** onto Container Apps jobs (`caj-*`);
     - `core/schemas/tenant-config.schema.json:744-960` (`documentGeneration`) has **no** `pdfConverter` or fallback setting yet.

## Files and changes

1. **Container image (`docker/pdf-converter/Dockerfile`, `docker/pdf-converter/server.mjs`, `docker/pdf-converter/README.md`):**
   - Multi-step or slim `FROM node:24-bookworm-slim` installing `libreoffice-writer-nogui` + clean liberation fonts, running as non-root `USER node` on port `8080`.
   - `server.mjs` (zero external npm dependencies needed):
     - `GET /health/live`: HTTP `200` `{"status":"live"}`.
     - `GET /health/ready`: HTTP `200` `{"status":"ready"}` once `soffice --version` check succeeds (HTTP `503` otherwise).
     - `POST /convert`: enforces `MAX_DOCX_BYTES` (e.g. 25 MiB, HTTP `413`), checks `PK\x03\x04` header (HTTP `400`), writes input to a unique per-request temp dir (`--headless --norestore --nodefault --nolockcheck -env:UserInstallation=file:///tmp/... --convert-to pdf`), enforces conversion timeout (`45s` max subprocess, HTTP `504`), validates output `%PDF-` magic header, returns `application/pdf`, cleans temp dir in `finally`, and logs **only** `{ correlationId, tenantIdHeader?, outcome, durationMs, inputBytes, outputBytes, errorCode }` (never document title or contents).
2. **CI build & container readiness smoke step (`.github/workflows/ci.yml`):**
   - Build `onesquared-pdf:test` from `docker/pdf-converter/Dockerfile`, start `onesquared-pdf-smoke` without `--rm` (`EXIT` trap cleanup), wait up to 60 seconds on `/health/ready`, perform a tiny valid `.docx` -> `%PDF-` `POST /convert` round-trip smoke check, and print `docker logs --tail 200 onesquared-pdf-smoke` if it fails.
3. **Bicep infrastructure (`core/infra/modules/platform.bicep`, `core/infra/main.bicep`, `core/tests/infra-bicep-contract.test.ts`):**
   - Keep `enablePdfConverterContainerApp bool = false` default (`demo.bicepparam:20`), `external: false`, `allowInsecure: false`, and zero secrets in parameters.
   - Add `Startup` (`/health/live`, initialDelaySeconds `5`, periodSeconds `10`, timeoutSeconds `5`, failureThreshold `10`), `Liveness` (`/health/live`, initialDelaySeconds `15`, periodSeconds `30`, timeoutSeconds `5`, failureThreshold `3`), and `Readiness` (`/health/ready`, initialDelaySeconds `10`, periodSeconds `15`, timeoutSeconds `5`, failureThreshold `3`) probes on `pdfConverterContainerApp` (`core/infra/modules/platform.bicep:977-986`), keeping resource declarations cleanly ordered for `infra-bicep-contract.test.ts`.
   - Wire `pdfConverterEnv` (`DOC_CONVERTER_URL`) into **all** `Microsoft.App/jobs` containers alongside `webContainerApp` (`:1032`) when `deployApps && enablePdfConverterContainerApp`.
4. **Configuration & HTTP `DocumentPdfConverter` adapter (`core/schemas/`, `core/src/config-engine/`, `core/src/api/`, `core/src/domain/document-generation/`, `src/server/`):**
   - `core/schemas/tenant-config.schema.json` & `core/src/config-engine/index.ts` (including nested `documentGeneration` merge in `loadAndValidateTenantConfig`): add additive backward-compatible options under `documentGeneration`:
     - `pdfConverter`: `'builtin' | 'container'` (default `'builtin'`)
     - `pdfConverterFallback`: `'builtin' | 'fail'` (default `'builtin'`, controls behaviour when `'container'` is selected and `DOC_CONVERTER_URL` is unreachable/unconfigured/5xx)
   - `core/src/api/index.ts:573-580`: add optional `tenantId?: string; correlationId?: string;` to `DocumentPdfConverter.convertDocxToPdf` input.
   - `core/src/domain/document-generation/pdfConverter.ts`: implement `HttpPdfConverter` (with timeout via `AbortController`, byte-size limit, `%PDF-` response check, typed `PDF_CONVERTER_*` errors), `FallbackAwarePdfConverter` (explicitly logging `document_generation.pdf_converter_fallback` with `tenantId`, `correlationId`, `errorCode` — never silent, never document content — or failing cleanly when `pdfConverterFallback === 'fail'`), and `selectDocumentPdfConverter(tenantConfig, options)` helper.
   - Plug into `generationService.ts:296, 514` (keeping `BuiltInOpenXmlPdfConverter` fallback when optional dependency omitted) and `src/server/documentGenerationServices.ts:1388` (`1439`) & `:1483` (`1543`) (passing `tenantConfig`, `process.env.DOC_CONVERTER_URL`, `tenantId`, `correlationId`).

## Tests

*(Record fail-first evidence before implementation in `Stage1-WP1-report.md`.)*

1. **HTTP converter adapter unit tests (`core/tests/pdf-converter-adapter.test.ts`):**
   - Against an in-process fake HTTP `node:http` server:
     - `200` valid PDF (`%PDF-`) returns bytes cleanly and sends `x-correlation-id`;
     - Request timeout aborts cleanly via `AbortController` (`PDF_CONVERTER_TIMEOUT`);
     - HTTP `500` / `503` / non-PDF payload fails cleanly (`PDF_CONVERTER_HTTP_ERROR` / `PDF_CONVERTER_INVALID_OUTPUT`);
     - Oversized input or oversized response fails before/at limit (`PDF_CONVERTER_SIZE_LIMIT`);
     - Unreachable / missing `DOC_CONVERTER_URL` with `pdfConverter: 'container'`: falls back to `BuiltInOpenXmlPdfConverter` and logs `document_generation.pdf_converter_fallback` (zero document content/title) when `pdfConverterFallback: 'builtin'`, and fails loudly when `pdfConverterFallback: 'fail'`.
2. **Configuration & selection tests (`core/tests/document-generation.test.ts` & `core/tests/tenant-config-usage.test.ts`):**
   - Configuration (`pdfConverter: 'builtin' | 'container'`, `pdfConverterFallback`) selects the expected converter in `previewTemplateService` and `generateDocumentService`; `tenant-config-usage.test.ts` verifies both new schema leaves are referenced in runtime code.
3. **Bicep contract tests (`core/tests/infra-bicep-contract.test.ts`):**
   - `bicep build`, `bicep lint`, and `bicep build-params` pass.
   - Contract test verifies `ca-pdf` has `external: false`, `allowInsecure: false`, valid probe bounds, `enablePdfConverterContainerApp: false` default (`demo.bicepparam`), `PDF_CONVERTER_IMAGE_REQUIRED` guard, and `DOC_CONVERTER_URL` wired on both `webContainerApp` and Container Apps jobs without secrets.

## Help and documentation (rule 11)

- `src/docs/articles/document-generation.ts`: document `Built-in OpenXML` vs `Dedicated Container` converter modes, fallback behaviour, limits, and fidelity differences.
- `src/docs/articles/tenant-settings.ts`: document `documentGeneration.pdfConverter` and `documentGeneration.pdfConverterFallback`.
- `src/docs/articles/deployment-and-security.ts`: document `ca-pdf` internal-only Container App (`DOC_CONVERTER_URL`), non-root LibreOffice image build, and zero-PII conversion logging.
- `docs/roadmap/feature-list.md`: update row `46` (`Completed` once image + CI smoke + adapter + Bicep pass, noting `enablePdfConverterContainerApp = false` default in `demo.bicepparam` until pushed to ACR), `E1`, `E5`, `E9`, and `P7`.
- `docs/release-notes.md`: add `S1-10` entry under `Unreleased`.

## Acceptance criteria

- `docker/pdf-converter/Dockerfile` builds in CI, passes `/health/ready` and a `.docx` → `.pdf` smoke conversion in CI, and Bicep wires `ca-pdf` with internal-only ingress, probes, disabled default, and `DOC_CONVERTER_URL` on web app + jobs.
- `previewTemplateService` and `generateDocumentService` honour `documentGeneration.pdfConverter` / `pdfConverterFallback` with timeouts, size limits, zero-PII logging, and non-silent fallback, covered by fake-HTTP, config-selection, and Bicep contract tests.

## Manual blockers

- Pushing the converter image to demo ACR (`acronesquareddemo2lwvta`) and enabling `enablePdfConverterContainerApp = true` in Azure demo deployment parameters (`Stage 1 plan` §8).

## Rollback

- Default remains `enablePdfConverterContainerApp = false` and `documentGeneration.pdfConverter = 'builtin'`, so existing runtime behaviour is unaffected if disabled; revert `s1-10-pdf-converter` cleanly with zero database migrations.

## Pull request description must state

- **Change class:** Infrastructure (`docker/pdf-converter/`, `.github/workflows/ci.yml`, `core/infra/`), configuration options (`documentGeneration.pdfConverter`, `documentGeneration.pdfConverterFallback`), and Core/Host PDF converter adapter (item `46`).
- **Both hosting models:** Identical `HttpPdfConverter` + internal `ca-pdf` container design across `Model A` (`single_tenant`) and `Model B` (`multi_tenant`), with per-request isolated temp directories and zero persisted state or PII.
- **Migration and rollback:** No database migration; `git revert` restores `BuiltInOpenXmlPdfConverter`-only behaviour immediately.
