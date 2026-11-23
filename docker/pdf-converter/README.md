# 1Squared Dedicated PDF Converter Container (`docker/pdf-converter/`)

Internal-only stateless container image running headless LibreOffice Writer (`libreoffice-writer-nogui`) behind a zero-dependency Node.js 24 HTTP server (`server.mjs`) for high-fidelity `.docx` to `.pdf` conversion (`S1-10`, backlog item `46`, [ADR 0009](../../docs/decisions/0009-docx-library-and-pdf-conversion.md)).

## Design choices (Option A)

- **Base image**: `node:24-bookworm-slim` + `tini` (`ENTRYPOINT ["/usr/bin/tini", "--"]` PID 1 init reaping child processes) + Debian `libreoffice-writer-nogui`, `fonts-liberation2`, and `fonts-noto-core`, updated directly from APT with `rm -rf /var/lib/apt/lists/*` (no Chromium GUI or external binaries; base-image SHA-256 digest and package pinning deferred to `B24`).
- **Least privilege & concurrency**: runs as non-root `USER node` on internal Container Apps ingress (`external: false`, `allowInsecure: false`, port `8080`), enforcing an explicit Container Apps `http` scale rule (`concurrentRequests: '2'`) alongside in-process `PDF_CONVERTER_MAX_CONCURRENCY` (`2` default, returning HTTP `503` `PDF_CONVERTER_BUSY` + `Retry-After` + `Connection: close` when full) and releasing concurrency slots cleanly when a caller aborts an upload mid-stream (`req.on('close')` -> `499 CLIENT_ABORT`).
- **Isolation & clean process-tree timeouts**: each `POST /convert` request writes to an isolated temporary directory (`os.tmpdir()`) with a dedicated `-env:UserInstallation=file://...` UNO profile that is deleted unconditionally in `finally`; subprocess timeouts kill the entire LibreOffice process tree cleanly (`SIGKILL` on `-pid` on POSIX / `taskkill /T /F` on Windows, logging zero-PII `pdf_converter.kill_unconfirmed` if exit confirmation does not arrive). Under `NODE_ENV=production`, test override hooks (`PDF_CONVERTER_SOFFICE_BIN`, `PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON`) are ignored (and malformed JSON logs `pdf_converter.invalid_pre_args_json` rather than crashing).
- **Zero-PII logs**: structured JSON logs emit only `{ timestamp, level, event, correlationId, tenantId?, outcome, statusCode, durationMs, inputBytes, outputBytes, errorCode? }` — never document titles, filenames, or contents.

## Endpoints

| Method & path | Behaviour |
|---|---|
| `GET /health/live` | Returns `200 {"status":"live"}` immediately for Container Apps startup/liveness probes. |
| `GET /health/ready` | Runs `soffice --headless --version` (`4.5s` default timeout, warmed on startup and positively cached for `60s`, longer than the `15s` readiness probe interval) and returns `200 {"status":"ready"}` or `503 {"status":"unready","errorCode":"PDF_CONVERTER_NOT_READY"}`. |
| `POST /convert` | Enforces `PDF_CONVERTER_MAX_CONCURRENCY` (`503` + `Retry-After` + `Connection: close` when full, freeing slots on `499` client aborts), accepts raw `.docx` bytes up to `PDF_CONVERTER_MAX_DOCX_BYTES` (`25 MiB` default, clean HTTP `413` on both declared and chunked overflows), verifies ZIP signature `PK\x03\x04` (`400` otherwise), renders `.pdf` via headless `soffice` within `PDF_CONVERTER_SOFFICE_TIMEOUT_MS` (`45s` default, `504` on timeout with full process-group kill), validates `%PDF-`, and returns `application/pdf`. |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Internal HTTP listen port. |
| `HOSTNAME` | `0.0.0.0` | Internal HTTP bind host. |
| `PDF_CONVERTER_MAX_DOCX_BYTES` | `26214400` (`25 MiB`) | Maximum accepted `.docx` request payload size. |
| `PDF_CONVERTER_MAX_CONCURRENCY` | `2` | Maximum concurrent `.docx` → `.pdf` conversions inside a replica (`503` + `Retry-After` when full). |
| `PDF_CONVERTER_SOFFICE_TIMEOUT_MS` | `45000` (`45s`) | Headless `soffice` subprocess timeout (gives 15s headroom under the client `60s` timeout). |
| `PDF_CONVERTER_READINESS_TIMEOUT_MS` | `4500` (`4.5s`) | Subprocess timeout for `/health/ready` (bounded inside Bicep's `5s` readiness probe). |
| `PDF_CONVERTER_READINESS_CACHE_MS` | `60000` (`60s`) | Positive cache TTL for `/health/ready` (exceeds the `15s` probe interval). |

## Local build and smoke test

```bash
docker build -f docker/pdf-converter/Dockerfile -t onesquared-pdf:test docker/pdf-converter
docker run -d --name onesquared-pdf-smoke -p 127.0.0.1:8199:8080 onesquared-pdf:test
node scripts/smoke-pdf-converter.mjs http://127.0.0.1:8199
docker rm -f onesquared-pdf-smoke

# Forced-timeout + PID 1 tini zombie check:
docker run -d --name onesquared-pdf-timeout -e PDF_CONVERTER_SOFFICE_TIMEOUT_MS=100 -p 127.0.0.1:8198:8080 onesquared-pdf:test
node scripts/smoke-pdf-converter.mjs --expect-timeout http://127.0.0.1:8198
docker exec onesquared-pdf-timeout ps -eo stat | grep -c '^Z'
docker rm -f onesquared-pdf-timeout
```

> Publishing this image to Azure Container Registry and enabling `enablePdfConverterContainerApp = true` in `core/infra/parameters/demo.bicepparam` remain owner deployment tasks in `docs/roadmap/stage-1-plan.md` §8.
