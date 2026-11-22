/**
 * Zero-dependency Node.js HTTP wrapper around headless LibreOffice Writer
 * (`libreoffice-writer-nogui`) for internal DOCX -> PDF conversion (`S1-10`).
 *
 * Security & privacy invariants:
 * - Exposes ONLY `GET /health/live`, `GET /health/ready`, and `POST /convert`.
 * - Enforces byte ceiling (`MAX_DOCX_BYTES`, default 25 MiB), ZIP magic check
 *   (`PK\x03\x04`), per-request isolated temporary directory + UNO profile, and
 *   subprocess timeout (`45s` default inside Container App `60s` client budget).
 * - Structured JSON logs emit only operational metadata (`correlationId`, optional
 *   sanitised `tenantId`, byte sizes, timing, HTTP status, and error codes).
 *   Never logs headers, document titles, filenames, or document bytes.
 */

import { execFile } from 'node:child_process';
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
const SOFFICE_TIMEOUT_MS = Number(
  process.env.PDF_CONVERTER_SOFFICE_TIMEOUT_MS || 45_000,
);
const READINESS_PROBE_TIMEOUT_MS = Number(
  process.env.PDF_CONVERTER_READINESS_TIMEOUT_MS || 10_000,
);
const READINESS_CACHE_MS = 5_000;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

let cachedReadyAt = 0;

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
  if (now - cachedReadyAt < READINESS_CACHE_MS) {
    return true;
  }
  await execFileAsync('soffice', ['--headless', '--version'], {
    timeout: READINESS_PROBE_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  });
  cachedReadyAt = Date.now();
  return true;
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

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        const err = new Error('DOCX payload exceeds maximum allowed size');
        err.code = 'SIZE_LIMIT';
        req.destroy();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });

    req.on('error', (err) => {
      fail(err);
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
    await execFileAsync(
      'soffice',
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
      {
        timeout: SOFFICE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
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
      sendJson(res, statusCode, { errorCode });
    }
    return;
  }

  sendJson(res, 404, { errorCode: 'NOT_FOUND' });
});

server.headersTimeout = 15_000;
server.requestTimeout = SOFFICE_TIMEOUT_MS + 30_000;

server.listen(PORT, HOSTNAME, () => {
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
