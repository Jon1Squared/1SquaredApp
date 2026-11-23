/**
 * Zero-dependency Node.js HTTP wrapper around headless LibreOffice Writer
 * (`libreoffice-writer-nogui`) for internal DOCX -> PDF conversion (`S1-10`).
 *
 * Security & privacy invariants:
 * - Exposes ONLY `GET /health/live`, `GET /health/ready`, and `POST /convert`.
 * - Enforces byte ceiling (`MAX_DOCX_BYTES`, default 25 MiB), ZIP magic check
 *   (`PK\x03\x04`), parallel concurrency cap (`MAX_CONCURRENCY`, default 2, HTTP 503),
 *   per-request isolated temporary directory + UNO profile, and process-tree
 *   subprocess timeout (`45s` default inside Container App `60s` client budget).
 * - Structured JSON logs emit only operational metadata (`correlationId`, optional
 *   sanitised `tenantId`, byte sizes, timing, HTTP status, and error codes).
 *   Never logs headers, document titles, filenames, or document bytes.
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8080);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const MAX_DOCX_BYTES = Number(
  process.env.PDF_CONVERTER_MAX_DOCX_BYTES || 25 * 1024 * 1024,
);
const MAX_CONCURRENCY = Math.max(
  1,
  Math.floor(Number(process.env.PDF_CONVERTER_MAX_CONCURRENCY || 2)),
);
const SOFFICE_TIMEOUT_MS = Number(
  process.env.PDF_CONVERTER_SOFFICE_TIMEOUT_MS || 45_000,
);
const READINESS_PROBE_TIMEOUT_MS = Number(
  process.env.PDF_CONVERTER_READINESS_TIMEOUT_MS || 4_500,
);
const READINESS_CACHE_MS = Math.max(
  1_000,
  Number(process.env.PDF_CONVERTER_READINESS_CACHE_MS || 60_000),
);
const IS_PRODUCTION_ENV = process.env.NODE_ENV === 'production';
// Test-only LibreOffice override hooks (`R686`): ignored when NODE_ENV=production.
const SOFFICE_BIN =
  !IS_PRODUCTION_ENV && process.env.PDF_CONVERTER_SOFFICE_BIN
    ? process.env.PDF_CONVERTER_SOFFICE_BIN
    : 'soffice';
let SOFFICE_PRE_ARGS = [];
if (!IS_PRODUCTION_ENV && process.env.PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON) {
  try {
    const parsedArgs = JSON.parse(
      process.env.PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON,
    );
    if (Array.isArray(parsedArgs)) {
      SOFFICE_PRE_ARGS = parsedArgs.map((arg) => String(arg));
    } else {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'pdf_converter.invalid_pre_args_json',
          reason: 'Expected JSON array',
        }),
      );
    }
  } catch {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'pdf_converter.invalid_pre_args_json',
        reason: 'Malformed JSON',
      }),
    );
  }
}
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

let cachedReadyAt = 0;
let readyCheckInFlight = null;
let activeConversions = 0;

function sanitizeIdentifier(rawValue) {
  if (typeof rawValue !== 'string') return undefined;
  const trimmed = rawValue.trim();
  return SAFE_ID_RE.test(trimmed) ? trimmed : undefined;
}

function logEvent(fields) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (fields.level === 'error' || fields.level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function hasZipLocalHeader(buf) {
  return (
    buf.byteLength >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function hasPdfSignature(buf) {
  return (
    buf.byteLength >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  );
}

async function checkSofficeReady() {
  const now = Date.now();
  if (cachedReadyAt > 0 && now - cachedReadyAt < READINESS_CACHE_MS) {
    return true;
  }
  if (readyCheckInFlight) {
    return readyCheckInFlight;
  }
  readyCheckInFlight = execFileAsync(
    SOFFICE_BIN,
    [...SOFFICE_PRE_ARGS, '--headless', '--version'],
    {
      timeout: READINESS_PROBE_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    },
  )
    .then(() => {
      cachedReadyAt = Date.now();
      return true;
    })
    .finally(() => {
      readyCheckInFlight = null;
    });
  return readyCheckInFlight;
}

function readRequestBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader !== undefined) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        const err = new Error('DOCX payload exceeds maximum allowed size');
        err.code = 'SIZE_LIMIT';
        req.resume();
        reject(err);
        return;
      }
    }

    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        const err = new Error('DOCX payload exceeds maximum allowed size');
        err.code = 'SIZE_LIMIT';
        req.resume();
        fail(err);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };

    const onError = (err) => {
      if (
        (err && typeof err === 'object' && err.code === 'ECONNRESET') ||
        req.aborted
      ) {
        const abortErr = new Error('Client aborted request body upload');
        abortErr.code = 'CLIENT_ABORT';
        fail(abortErr);
        return;
      }
      fail(err);
    };

    const onClose = () => {
      if (!settled && !req.complete) {
        const abortErr = new Error('Client aborted request body upload');
        abortErr.code = 'CLIENT_ABORT';
        fail(abortErr);
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function runSofficeConvert(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE_BIN, [...SOFFICE_PRE_ARGS, ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.stdout) child.stdout.resume();
    if (child.stderr) child.stderr.resume();

    let timedOut = false;
    let settled = false;
    let forceFinishTimer = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      if (err) reject(err);
      else resolve();
    };

    const killProcessTree = () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          try {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            // Best-effort process tree termination
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Best-effort process group termination
          }
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree();
      forceFinishTimer = setTimeout(() => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'pdf_converter.kill_unconfirmed',
            pid: child.pid ?? null,
          }),
        );
        const timeoutErr = new Error(
          `soffice timed out after ${timeoutMs} ms`,
        );
        timeoutErr.code = 'ETIMEDOUT';
        timeoutErr.killed = true;
        finish(timeoutErr);
      }, 1_500);
    }, timeoutMs);

    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (timedOut) {
        const timeoutErr = new Error(
          `soffice timed out after ${timeoutMs} ms`,
        );
        timeoutErr.code = 'ETIMEDOUT';
        timeoutErr.killed = true;
        finish(timeoutErr);
        return;
      }
      if (code !== 0) {
        const exitErr = new Error(
          `soffice exited with code ${code ?? 'null'} (signal ${signal ?? 'none'})`,
        );
        exitErr.code = 'RENDER_FAILED';
        finish(exitErr);
        return;
      }
      finish(null);
    });
  });
}

async function convertDocxBufferToPdf(docxBuffer) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onesquared-pdf-'));
  try {
    const profileDir = path.join(workDir, 'profile');
    await fs.mkdir(profileDir, { recursive: true });
    const inputPath = path.join(workDir, 'input.docx');
    const outputPath = path.join(workDir, 'input.pdf');
    await fs.writeFile(inputPath, docxBuffer);

    const profileUri = pathToFileURL(profileDir).href;
    await runSofficeConvert(
      [
        '--headless',
        '--norestore',
        '--nodefault',
        '--nolockcheck',
        `-env:UserInstallation=${profileUri}`,
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        inputPath,
      ],
      SOFFICE_TIMEOUT_MS,
    );

    const pdfBytes = await fs.readFile(outputPath);
    if (!hasPdfSignature(pdfBytes)) {
      const invalidErr = new Error(
        'LibreOffice output did not begin with %PDF- signature',
      );
      invalidErr.code = 'INVALID_OUTPUT';
      throw invalidErr;
    }
    return pdfBytes;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const correlationId =
    sanitizeIdentifier(req.headers['x-correlation-id']) ?? crypto.randomUUID();
  const tenantId = sanitizeIdentifier(req.headers['x-tenant-id']);
  const requestPath = (req.url || '/').split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  if (requestPath === '/health/live') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(
        res,
        405,
        { errorCode: 'METHOD_NOT_ALLOWED' },
        { Allow: 'GET, HEAD' },
      );
      return;
    }
    sendJson(res, 200, { status: 'live' });
    return;
  }

  if (requestPath === '/health/ready') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(
        res,
        405,
        { errorCode: 'METHOD_NOT_ALLOWED' },
        { Allow: 'GET, HEAD' },
      );
      return;
    }
    try {
      await checkSofficeReady();
      sendJson(res, 200, { status: 'ready' });
    } catch {
      logEvent({
        level: 'error',
        event: 'pdf_converter.readiness_failed',
        correlationId,
        outcome: 'unready',
        statusCode: 503,
        durationMs: Date.now() - startedAt,
        inputBytes: 0,
        outputBytes: 0,
        errorCode: 'PDF_CONVERTER_NOT_READY',
      });
      sendJson(res, 503, {
        status: 'unready',
        errorCode: 'PDF_CONVERTER_NOT_READY',
      });
    }
    return;
  }

  if (requestPath === '/convert') {
    if (method !== 'POST') {
      sendJson(res, 405, { errorCode: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
      return;
    }

    if (activeConversions >= MAX_CONCURRENCY) {
      req.resume();
      logEvent({
        level: 'warn',
        event: 'pdf_converter.rejected_busy',
        correlationId,
        ...(tenantId ? { tenantId } : {}),
        outcome: 'busy',
        statusCode: 503,
        durationMs: Date.now() - startedAt,
        inputBytes: 0,
        outputBytes: 0,
        errorCode: 'PDF_CONVERTER_BUSY',
      });
      sendJson(
        res,
        503,
        { errorCode: 'PDF_CONVERTER_BUSY' },
        { 'Retry-After': '2', Connection: 'close' },
      );
      return;
    }

    activeConversions += 1;
    let inputBytes = 0;
    try {
      const docxBuffer = await readRequestBodyWithLimit(req, MAX_DOCX_BYTES);
      inputBytes = docxBuffer.byteLength;

      if (!hasZipLocalHeader(docxBuffer)) {
        logEvent({
          level: 'warn',
          event: 'pdf_converter.request_rejected',
          correlationId,
          ...(tenantId ? { tenantId } : {}),
          outcome: 'rejected',
          statusCode: 400,
          durationMs: Date.now() - startedAt,
          inputBytes,
          outputBytes: 0,
          errorCode: 'PDF_CONVERTER_INVALID_DOCX',
        });
        sendJson(res, 400, {
          errorCode: 'PDF_CONVERTER_INVALID_DOCX',
          message: 'Request body must be a valid .docx ZIP archive',
        });
        return;
      }

      const pdfBuffer = await convertDocxBufferToPdf(docxBuffer);
      logEvent({
        level: 'info',
        event: 'pdf_converter.converted',
        correlationId,
        ...(tenantId ? { tenantId } : {}),
        outcome: 'converted',
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        inputBytes,
        outputBytes: pdfBuffer.byteLength,
      });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBuffer.byteLength),
        'Cache-Control': 'no-store',
        'x-correlation-id': correlationId,
      });
      res.end(pdfBuffer);
    } catch (err) {
      const isClientAbort =
        (err &&
          typeof err === 'object' &&
          (err.code === 'CLIENT_ABORT' || err.code === 'ECONNRESET')) ||
        req.aborted;
      if (isClientAbort) {
        logEvent({
          level: 'warn',
          event: 'pdf_converter.client_aborted',
          correlationId,
          ...(tenantId ? { tenantId } : {}),
          outcome: 'aborted',
          statusCode: 499,
          durationMs: Date.now() - startedAt,
          inputBytes,
          outputBytes: 0,
          errorCode: 'PDF_CONVERTER_CLIENT_ABORT',
        });
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
        return;
      }

      const isSizeLimit =
        err && typeof err === 'object' && err.code === 'SIZE_LIMIT';
      const isTimeout =
        err &&
        typeof err === 'object' &&
        (err.killed === true ||
          err.signal === 'SIGTERM' ||
          err.code === 'ETIMEDOUT');

      const statusCode = isSizeLimit ? 413 : isTimeout ? 504 : 500;
      const errorCode = isSizeLimit
        ? 'PDF_CONVERTER_SIZE_LIMIT'
        : isTimeout
          ? 'PDF_CONVERTER_TIMEOUT'
          : 'PDF_CONVERTER_RENDER_FAILED';

      logEvent({
        level: isSizeLimit ? 'warn' : 'error',
        event: 'pdf_converter.conversion_failed',
        correlationId,
        ...(tenantId ? { tenantId } : {}),
        outcome: 'failed',
        statusCode,
        durationMs: Date.now() - startedAt,
        inputBytes,
        outputBytes: 0,
        errorCode,
      });
      sendJson(
        res,
        statusCode,
        { errorCode },
        isSizeLimit ? { Connection: 'close' } : {},
      );
    } finally {
      activeConversions = Math.max(0, activeConversions - 1);
    }
    return;
  }

  sendJson(res, 404, { errorCode: 'NOT_FOUND' });
});

server.headersTimeout = 15_000;
server.requestTimeout = SOFFICE_TIMEOUT_MS + 30_000;

server.listen(PORT, HOSTNAME, () => {
  checkSofficeReady().catch(() => {});
  logEvent({
    level: 'info',
    event: 'pdf_converter.started',
    correlationId: 'startup',
    outcome: 'listening',
    statusCode: 200,
    durationMs: 0,
    inputBytes: 0,
    outputBytes: 0,
  });
});

function handleShutdown(signal) {
  logEvent({
    level: 'info',
    event: 'pdf_converter.stopping',
    correlationId: signal,
    outcome: 'stopping',
    statusCode: 200,
    durationMs: 0,
    inputBytes: 0,
    outputBytes: 0,
  });
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
