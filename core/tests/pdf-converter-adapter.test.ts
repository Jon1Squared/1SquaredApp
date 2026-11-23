import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuiltInOpenXmlPdfConverter,
  FallbackAwarePdfConverter,
  HttpPdfConverter,
  PdfConverterError,
  buildValidDocxArchive,
  loadAndValidateTenantConfig,
  selectDocumentPdfConverter,
  type PdfConverterFallbackWarningEvent,
} from '@platform/core';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';

function startFakePdfServer(
  handler: (
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        Promise.resolve(handler(req, Buffer.concat(chunks), res)).catch(
          (err) => {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end(
                err instanceof Error ? err.message : 'Fake server handler error',
              );
            }
          },
        );
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}

describe('S1-10: HttpPdfConverter, FallbackAwarePdfConverter & converter config selection', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    while (closers.length > 0) {
      const close = closers.pop()!;
      await close().catch(() => undefined);
    }
  });

  it('POSTs raw .docx bytes, forwards x-tenant-id and x-correlation-id headers, defaults timeout to 60s and maxDocxBytes to 25 MiB, returns %PDF- bytes, and logs zero title/PII', async () => {
    const sampleDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'Strictly Private Client Engagement Letter' }],
    });
    const containerPdf = new TextEncoder().encode(
      '%PDF-1.7\n%LibreOffice-Container-Rendered\n%%EOF\n',
    );
    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    let seenUrl = '';
    let seenMethod = '';
    let receivedLength = 0;

    const srv = await startFakePdfServer((req, body, res) => {
      seenUrl = req.url ?? '';
      seenMethod = req.method ?? '';
      seenHeaders.push(req.headers);
      receivedLength = body.byteLength;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.end(Buffer.from(containerPdf));
    });
    closers.push(srv.close);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const converter = new HttpPdfConverter({
      baseUrl: `${srv.baseUrl}/`,
    });
    expect(converter.timeoutMs).toBe(60_000);
    expect(converter.maxDocxBytes).toBe(25 * 1024 * 1024);

    const secretTitle = 'SECRET-MERGER-MATTER-ORION-TITLE';
    const outBytes = await converter.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: secretTitle,
      authorName: 'J. Vance Partner',
      tenantId: 'tenant-alpha',
      correlationId: 'corr-s110-1234',
    });

    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('/convert');
    expect(receivedLength).toBe(sampleDocx.byteLength);
    expect(seenHeaders[0]?.['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(seenHeaders[0]?.['x-tenant-id']).toBe('tenant-alpha');
    expect(seenHeaders[0]?.['x-correlation-id']).toBe('corr-s110-1234');
    expect(new TextDecoder('latin1').decode(outBytes)).toContain(
      'LibreOffice-Container-Rendered',
    );

    const allLogs = [
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map(String)
      .join('\n');
    expect(allLogs).not.toContain(secretTitle);
    expect(allLogs).not.toContain('J. Vance Partner');
  });

  it('tolerates slow cold-start responses inside timeoutMs and aborts cleanly with PDF_CONVERTER_TIMEOUT when exceeded', async () => {
    const sampleDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'Cold start test' }],
    });
    const slowSrv = await startFakePdfServer(async (_req, _body, res) => {
      await new Promise((r) => setTimeout(r, 150));
      if (!res.writableEnded) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.end(Buffer.from('%PDF-1.7\n%%EOF\n'));
      }
    });
    closers.push(slowSrv.close);

    const generousConverter = new HttpPdfConverter({
      baseUrl: slowSrv.baseUrl,
      timeoutMs: 1_500,
    });
    const okBytes = await generousConverter.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: 'Within Timeout',
    });
    expect(new TextDecoder('latin1').decode(okBytes).startsWith('%PDF-')).toBe(
      true,
    );

    const strictConverter = new HttpPdfConverter({
      baseUrl: slowSrv.baseUrl,
      timeoutMs: 50,
    });
    let thrown: unknown;
    try {
      await strictConverter.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: 'Exceeds Timeout',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PdfConverterError);
    expect((thrown as PdfConverterError).code).toBe('PDF_CONVERTER_TIMEOUT');
  });

  it('rejects HTTP 500/503 errors, non-%PDF- responses, and payloads exceeding maxDocxBytes', async () => {
    const sampleDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'Error case test' }],
    });

    const errorSrv = await startFakePdfServer((req, _body, res) => {
      if (req.headers['x-test-mode'] === 'bad-body') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html');
        res.end('<html>not a pdf</html>');
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ errorCode: 'PDF_CONVERTER_INTERNAL_ERROR' }));
    });
    closers.push(errorSrv.close);

    const converter = new HttpPdfConverter({
      baseUrl: errorSrv.baseUrl,
      maxDocxBytes: 256,
    });

    // Oversized payload fails closed before any network request
    const hugeBytes = new Uint8Array(512);
    hugeBytes.set([0x50, 0x4b, 0x03, 0x04], 0);
    await expect(
      converter.convertDocxToPdf({
        docxBytes: hugeBytes,
        title: 'Oversized DOCX',
      }),
    ).rejects.toMatchObject({ code: 'PDF_CONVERTER_SIZE_LIMIT' });

    const normalSizeConverter = new HttpPdfConverter({
      baseUrl: errorSrv.baseUrl,
    });
    await expect(
      normalSizeConverter.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: 'HTTP 500 Failure',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_CONVERTER_HTTP_ERROR',
      statusCode: 500,
    });

    const badBodyConverter = new HttpPdfConverter({
      baseUrl: errorSrv.baseUrl,
      fetchImpl: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            'x-test-mode': 'bad-body',
          },
        }),
    });
    await expect(
      badBodyConverter.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: 'Invalid PDF Body',
      }),
    ).rejects.toMatchObject({ code: 'PDF_CONVERTER_INVALID_OUTPUT' });
  });

  it('selects converter from tenantConfig and enforces non-silent fallback vs fail-closed modes', async () => {
    const sampleDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'Fallback mode test paragraph' }],
    });
    const baseCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
    );
    expect(baseCfg.documentGeneration.pdfConverter).toBe('builtin');
    expect(baseCfg.documentGeneration.pdfConverterFallback).toBe('builtin');

    const defaultSelected = selectDocumentPdfConverter(baseCfg);
    expect(defaultSelected).toBeInstanceOf(BuiltInOpenXmlPdfConverter);
    expect(defaultSelected.converterId).toBe('builtin-openxml-pdf');

    // Container selected with reachable server uses HTTP container output without fallback
    const containerPdf = new TextEncoder().encode('%PDF-1.7\n%CONTAINER-OK\n%%EOF\n');
    const okSrv = await startFakePdfServer((_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.end(Buffer.from(containerPdf));
    });
    closers.push(okSrv.close);

    const containerCfg = {
      ...baseCfg,
      documentGeneration: {
        ...baseCfg.documentGeneration,
        pdfConverter: 'container' as const,
        pdfConverterFallback: 'builtin' as const,
      },
    };
    const containerSelected = selectDocumentPdfConverter(containerCfg, {
      converterUrl: okSrv.baseUrl,
    });
    expect(containerSelected).toBeInstanceOf(FallbackAwarePdfConverter);
    const okOut = await containerSelected.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: 'Container Output',
      tenantId: 'tenant-alpha',
      correlationId: 'corr-ok',
    });
    expect(new TextDecoder('latin1').decode(okOut)).toContain('CONTAINER-OK');

    // Unconfigured URL + fallback:'builtin' logs structured warning (zero title/PII) and falls back
    const warnings: PdfConverterFallbackWarningEvent[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secretTitle = 'TOP-SECRET-LITIGATION-BRIEF-999';
    const unconfiguredFallback = selectDocumentPdfConverter(containerCfg, {
      converterUrl: '',
      onFallbackWarning: (evt) => warnings.push(evt),
    });
    const fallbackBytes = await unconfiguredFallback.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: secretTitle,
      tenantId: 'tenant-alpha',
      correlationId: 'corr-fallback-unconfigured',
    });
    expect(
      new TextDecoder('latin1').decode(fallbackBytes).startsWith('%PDF-1.4'),
    ).toBe(true);
    expect(warnings).toEqual([
      {
        event: 'document_generation.pdf_converter_fallback',
        tenantId: 'tenant-alpha',
        correlationId: 'corr-fallback-unconfigured',
        errorCode: 'PDF_CONVERTER_UNCONFIGURED',
        fallbackConverterId: 'builtin-openxml-pdf',
      },
    ]);

    // Default console.warn emitter also runs with zero PII/title
    const defaultLoggerFallback = selectDocumentPdfConverter(containerCfg, {
      converterUrl: 'http://127.0.0.1:1',
    });
    const fallback2Bytes = await defaultLoggerFallback.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: secretTitle,
      tenantId: 'tenant-bravo',
      correlationId: 'corr-fallback-unreachable',
    });
    expect(
      new TextDecoder('latin1').decode(fallback2Bytes).startsWith('%PDF-1.4'),
    ).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedJson = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(loggedJson).toContain('document_generation.pdf_converter_fallback');
    expect(loggedJson).toContain('tenant-bravo');
    expect(loggedJson).toContain('corr-fallback-unreachable');
    expect(loggedJson).toContain('PDF_CONVERTER_UNREACHABLE');
    expect(loggedJson).not.toContain(secretTitle);

    // fallback:'fail' throws loudly without falling back
    const failClosedCfg = {
      ...baseCfg,
      documentGeneration: {
        ...baseCfg.documentGeneration,
        pdfConverter: 'container' as const,
        pdfConverterFallback: 'fail' as const,
      },
    };
    const failClosedSelected = selectDocumentPdfConverter(failClosedCfg, {
      converterUrl: '',
    });
    await expect(
      failClosedSelected.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: secretTitle,
        tenantId: 'tenant-alpha',
        correlationId: 'corr-fail',
      }),
    ).rejects.toMatchObject({ code: 'PDF_CONVERTER_UNCONFIGURED' });
  });

  it('R679: retries HTTP 503 up to 3 times with Retry-After capped at 5s inside timeout budget, throws PDF_CONVERTER_BUSY, and maps fallback warning', async () => {
    const sampleDocx = buildValidDocxArchive({
      paragraphs: [{ text: 'R679 busy retry test' }],
    });
    const okPdf = new TextEncoder().encode('%PDF-1.7\n%RETRY-OK\n%%EOF\n');

    // 1. 503 followed by 200 succeeds on retry
    let attempt1 = 0;
    const sleepCalls1: number[] = [];
    const retrySuccessConverter = new HttpPdfConverter({
      baseUrl: 'http://pdf-converter.invalid',
      fetchImpl: (async () => {
        attempt1 += 1;
        if (attempt1 === 1) {
          return new Response(JSON.stringify({ errorCode: 'PDF_CONVERTER_BUSY' }), {
            status: 503,
            headers: { 'Retry-After': '0' },
          });
        }
        return new Response(okPdf, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        });
      }) as typeof fetch,
      sleepFn: async (ms: number) => {
        sleepCalls1.push(ms);
      },
    } as never);
    const out1 = await retrySuccessConverter.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: 'R679 Retry Success',
    });
    expect(attempt1).toBe(2);
    expect(sleepCalls1).toEqual([0]);
    expect(new TextDecoder('latin1').decode(out1)).toContain('RETRY-OK');

    // 2. Repeated 503s retry 3 times (4 total calls), cap Retry-After: 30 at 5000ms, and throw PDF_CONVERTER_BUSY
    let attempt2 = 0;
    const sleepCalls2: number[] = [];
    const busyFailConverter = new HttpPdfConverter({
      baseUrl: 'http://pdf-converter.invalid',
      timeoutMs: 30_000,
      fetchImpl: (async () => {
        attempt2 += 1;
        return new Response(JSON.stringify({ errorCode: 'PDF_CONVERTER_BUSY' }), {
          status: 503,
          headers: { 'Retry-After': '30' },
        });
      }) as typeof fetch,
      sleepFn: async (ms: number) => {
        sleepCalls2.push(ms);
      },
    } as never);
    await expect(
      busyFailConverter.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: 'R679 Busy Persistent',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_CONVERTER_BUSY',
      statusCode: 503,
      message: 'The PDF converter is busy. Please try again in a moment.',
    });
    expect(attempt2).toBe(4);
    expect(sleepCalls2).toEqual([5000, 5000, 5000]);

    // 3. Budget exhaustion: 503 Retry-After: 2 under timeoutMs: 100 stops before exceeding overall timeout budget
    let attempt3 = 0;
    const sleepCalls3: number[] = [];
    const budgetConverter = new HttpPdfConverter({
      baseUrl: 'http://pdf-converter.invalid',
      timeoutMs: 100,
      fetchImpl: (async () => {
        attempt3 += 1;
        return new Response(JSON.stringify({ errorCode: 'PDF_CONVERTER_BUSY' }), {
          status: 503,
          headers: { 'Retry-After': '2' },
        });
      }) as typeof fetch,
      sleepFn: async (ms: number) => {
        sleepCalls3.push(ms);
      },
    } as never);
    await expect(
      budgetConverter.convertDocxToPdf({
        docxBytes: sampleDocx,
        title: 'R679 Budget Exhausted',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_CONVERTER_BUSY',
      statusCode: 503,
      message: 'The PDF converter is busy. Please try again in a moment.',
    });
    expect(attempt3).toBe(1);
    expect(sleepCalls3).toEqual([]);

    // 4. pdfConverterFallback: 'builtin' maps PDF_CONVERTER_BUSY to structured fallback warning with British English message
    const baseCfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
    );
    const warnings: PdfConverterFallbackWarningEvent[] = [];
    const fallbackSelected = selectDocumentPdfConverter(
      {
        documentGeneration: {
          ...baseCfg.documentGeneration,
          pdfConverter: 'container',
          pdfConverterFallback: 'builtin',
        },
      },
      {
        converterUrl: 'http://pdf-converter.invalid',
        timeoutMs: 100,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ errorCode: 'PDF_CONVERTER_BUSY' }), {
            status: 503,
            headers: { 'Retry-After': '2' },
          })) as typeof fetch,
        onFallbackWarning: (evt) => warnings.push(evt),
      },
    );
    const fbBytes = await fallbackSelected.convertDocxToPdf({
      docxBytes: sampleDocx,
      title: 'CONFIDENTIAL-CLIENT-MATTER',
      tenantId: 'tenant-alpha',
      correlationId: 'corr-r679-fallback',
    });
    expect(new TextDecoder('latin1').decode(fbBytes).startsWith('%PDF-1.4')).toBe(
      true,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.errorCode).toBe('PDF_CONVERTER_BUSY');
    expect((warnings[0] as { message?: string })?.message).toContain(
      'The PDF converter is busy. Please try again in a moment.',
    );
  });

  describe('server.mjs process & concurrency hardening (R670, R671, R681, R682, R686)', () => {
    const tempDirs: string[] = [];
    const childProcs: ChildProcess[] = [];
    const trackedPids: number[] = [];

    afterEach(() => {
      for (const proc of childProcs.splice(0)) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already exited
        }
      }
      for (const pid of trackedPids.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already terminated
        }
      }
      for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    const reservePort = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address() as AddressInfo;
          srv.close((err) => (err ? reject(err) : resolve(port)));
        });
      });

    const waitForLive = async (baseUrl: string): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${baseUrl}/health/live`);
          if (res.status === 200) return;
        } catch {
          // Retry until server binds
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Timed out waiting for ${baseUrl}/health/live`);
    };

    const startConverterProcess = async (envOverrides: Record<string, string | undefined>) => {
      const port = await reservePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const serverScript = path.resolve(
        __dirname,
        '../../docker/pdf-converter/server.mjs',
      );
      const env: Record<string, string | undefined> = {
        ...process.env,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        ...envOverrides,
      };
      if (envOverrides.NODE_ENV === undefined) {
        delete env.NODE_ENV;
      }
      const stderrLines: string[] = [];
      const stdoutLines: string[] = [];
      const proc = spawn(process.execPath, [serverScript], {
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutLines.push(chunk.toString('utf8'));
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrLines.push(chunk.toString('utf8'));
      });
      childProcs.push(proc);
      await waitForLive(baseUrl);
      return { baseUrl, proc, port, stdoutLines, stderrLines };
    };

    const createMockSoffice = (workRoot: string) => {
      const versionLogPath = path.join(workRoot, 'version-calls.log');
      const grandchildPidPath = path.join(workRoot, 'grandchild.pid');
      const hangOnceFlagPath = path.join(workRoot, 'hang-once.flag');
      const mockSofficePath = path.join(workRoot, 'mock-soffice.mjs');
      fs.writeFileSync(
        mockSofficePath,
        [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          'const args = process.argv.slice(2);',
          "if (args.includes('--version')) {",
          "  if (process.env.MOCK_VERSION_LOG) fs.appendFileSync(process.env.MOCK_VERSION_LOG, '1\\n', 'utf8');",
          "  process.stdout.write('LibreOffice 24.8.0.0\\n');",
          '  process.exit(0);',
          '}',
          'const shouldHangOnce = Boolean(process.env.MOCK_HANG_ONCE_FILE) && fs.existsSync(process.env.MOCK_HANG_ONCE_FILE);',
          'if (shouldHangOnce) {',
          '  try { fs.unlinkSync(process.env.MOCK_HANG_ONCE_FILE); } catch {}',
          '}',
          "if (process.env.MOCK_MODE === 'hang' || shouldHangOnce) {",
          "  const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });",
          '  if (process.env.MOCK_GRANDCHILD_PID_FILE && grand.pid) {',
          '    fs.writeFileSync(process.env.MOCK_GRANDCHILD_PID_FILE, String(grand.pid), "utf8");',
          '  }',
          '  setInterval(() => {}, 60000);',
          '} else {',
          "  const outDirIdx = args.indexOf('--outdir');",
          '  const outDir = outDirIdx >= 0 ? args[outDirIdx + 1] : process.cwd();',
          '  const delay = Number(process.env.MOCK_DELAY_MS || 200);',
          '  await new Promise((r) => setTimeout(r, delay));',
          "  fs.writeFileSync(path.join(outDir, 'input.pdf'), Buffer.from('%PDF-1.4\\n1 0 obj<<>>endobj\\n%%EOF\\n'));",
          '  process.exit(0);',
          '}',
        ].join('\n'),
        'utf8',
      );
      return { mockSofficePath, versionLogPath, grandchildPidPath, hangOnceFlagPath };
    };

    it('R670/R686: enforces MAX_CONCURRENCY (503 + Retry-After + Connection: close) and caches /health/ready > probe interval', async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's110-busy-'));
      tempDirs.push(workRoot);
      const { mockSofficePath, versionLogPath } = createMockSoffice(workRoot);
      const zipBody = buildValidDocxArchive({ paragraphs: [{ text: 'Busy check' }] });

      const busySrv = await startConverterProcess({
        NODE_ENV: 'test',
        PDF_CONVERTER_MAX_CONCURRENCY: '2',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: JSON.stringify([mockSofficePath]),
        MOCK_VERSION_LOG: versionLogPath,
        MOCK_DELAY_MS: '450',
      });

      const r1 = await fetch(`${busySrv.baseUrl}/health/ready`);
      const r2 = await fetch(`${busySrv.baseUrl}/health/ready`);
      const r3 = await fetch(`${busySrv.baseUrl}/health/ready`);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      const versionCount = fs
        .readFileSync(versionLogPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean).length;
      expect(versionCount).toBe(1);

      const convertResults = await Promise.all(
        [1, 2, 3].map(async () => {
          const res = await fetch(`${busySrv.baseUrl}/convert`, {
            method: 'POST',
            headers: {
              'content-type':
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            body: Buffer.from(zipBody),
          });
          return {
            status: res.status,
            retryAfter: res.headers.get('retry-after'),
            connection: res.headers.get('connection'),
            body: Buffer.from(await res.arrayBuffer()),
          };
        }),
      );
      const okResults = convertResults.filter((r) => r.status === 200);
      const busyResults = convertResults.filter((r) => r.status === 503);
      expect(okResults).toHaveLength(2);
      expect(busyResults).toHaveLength(1);
      expect(busyResults[0]!.retryAfter).toBeTruthy();
      expect(busyResults[0]!.connection?.toLowerCase()).toBe('close');
      expect(JSON.parse(busyResults[0]!.body.toString('utf8'))).toMatchObject({
        errorCode: 'PDF_CONVERTER_BUSY',
      });
    });

    it('R670/R682: kills full process tree including spawned grandchild on timeout with >=1500ms timeout and pid-file polling', async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's110-timeout-'));
      tempDirs.push(workRoot);
      const { mockSofficePath, grandchildPidPath } = createMockSoffice(workRoot);
      const zipBody = buildValidDocxArchive({ paragraphs: [{ text: 'Timeout check' }] });

      const timeoutSrv = await startConverterProcess({
        NODE_ENV: 'test',
        PDF_CONVERTER_SOFFICE_TIMEOUT_MS: '1500',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: JSON.stringify([mockSofficePath]),
        MOCK_MODE: 'hang',
        MOCK_GRANDCHILD_PID_FILE: grandchildPidPath,
      });

      const pollGrandchildPid = (async () => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          if (fs.existsSync(grandchildPidPath)) {
            const raw = fs.readFileSync(grandchildPidPath, 'utf8').trim();
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        return 0;
      })();

      const timeoutRes = await fetch(`${timeoutSrv.baseUrl}/convert`, {
        method: 'POST',
        body: Buffer.from(zipBody),
      });
      expect(timeoutRes.status).toBe(504);
      const grandchildPid = await pollGrandchildPid;
      expect(grandchildPid).toBeGreaterThan(0);
      trackedPids.push(grandchildPid);

      await new Promise((r) => setTimeout(r, 200));
      let grandchildAlive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          grandchildAlive = false;
        }
      }
      expect(grandchildAlive).toBe(false);
    });

    it('R670/R682: returns clean 413 on oversized chunked upload and HttpPdfConverter enforces maxPdfBytes on both Content-Length and streaming bodies', async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's110-size-'));
      tempDirs.push(workRoot);
      const { mockSofficePath } = createMockSoffice(workRoot);
      const zipBody = buildValidDocxArchive({ paragraphs: [{ text: 'Size limit check' }] });

      const sizeSrv = await startConverterProcess({
        NODE_ENV: 'test',
        PDF_CONVERTER_MAX_DOCX_BYTES: '1024',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: JSON.stringify([mockSofficePath]),
      });
      const chunkedRes = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: sizeSrv.port,
              path: '/convert',
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Transfer-Encoding': 'chunked',
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                });
              });
            },
          );
          req.on('error', reject);
          req.write(Buffer.from(zipBody.subarray(0, 400)));
          req.write(Buffer.alloc(2048, 0x41));
          req.end();
        },
      );
      expect(chunkedRes.status).toBe(413);
      expect(JSON.parse(chunkedRes.body)).toMatchObject({
        errorCode: 'PDF_CONVERTER_SIZE_LIMIT',
      });

      // Declared Content-Length > maxPdfBytes fails closed immediately without reading body chunks
      let pullCalled = false;
      const declaredCappedConverter = new HttpPdfConverter({
        baseUrl: 'http://pdf.invalid',
        maxPdfBytes: 1024,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pullCalled = true;
                  controller.enqueue(Buffer.from('%PDF-1.4\n'));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
            {
              status: 200,
              headers: {
                'content-type': 'application/pdf',
                'content-length': '4096',
              },
            },
          )) as typeof fetch,
      });
      await expect(
        declaredCappedConverter.convertDocxToPdf({
          docxBytes: zipBody,
          title: 'Oversized Declared Content-Length PDF',
        }),
      ).rejects.toMatchObject({ code: 'PDF_CONVERTER_SIZE_LIMIT' });
      expect(pullCalled).toBe(false);

      // Streaming body without Content-Length exceeding maxPdfBytes fails closed
      const oversizedPdf = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.alloc(4096, 0x20),
      ]);
      const streamCappedConverter = new HttpPdfConverter({
        baseUrl: 'http://pdf.invalid',
        maxPdfBytes: 1024,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversizedPdf.subarray(0, 600));
                controller.enqueue(oversizedPdf.subarray(600));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/pdf' } },
          )) as typeof fetch,
      });
      await expect(
        streamCappedConverter.convertDocxToPdf({
          docxBytes: zipBody,
          title: 'Oversized Streaming PDF',
        }),
      ).rejects.toMatchObject({ code: 'PDF_CONVERTER_SIZE_LIMIT' });
    });

    it('R681: MAX_CONCURRENCY=1 frees slot cleanly after socket destroy() mid-upload, 504 timeout, and 413 payload refusal', async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's110-r681-'));
      tempDirs.push(workRoot);
      const { mockSofficePath, hangOnceFlagPath } = createMockSoffice(workRoot);
      const zipBody = buildValidDocxArchive({ paragraphs: [{ text: 'Slot release check' }] });

      const slotSrv = await startConverterProcess({
        NODE_ENV: 'test',
        PDF_CONVERTER_MAX_CONCURRENCY: '1',
        PDF_CONVERTER_MAX_DOCX_BYTES: String(zipBody.byteLength + 512),
        PDF_CONVERTER_SOFFICE_TIMEOUT_MS: '600',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: JSON.stringify([mockSofficePath]),
        MOCK_DELAY_MS: '50',
        MOCK_HANG_ONCE_FILE: hangOnceFlagPath,
      });

      // 1. Socket destroyed mid chunked upload must release concurrency slot
      await new Promise<void>((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: slotSrv.port,
          path: '/convert',
          method: 'POST',
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Transfer-Encoding': 'chunked',
          },
        });
        req.on('error', () => {
          // Expected when socket is forcibly destroyed
        });
        req.write(Buffer.from(zipBody.subarray(0, 64)));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 60);
      });
      await new Promise((r) => setTimeout(r, 120));

      const afterAbortRes = await fetch(`${slotSrv.baseUrl}/convert`, {
        method: 'POST',
        body: Buffer.from(zipBody),
      });
      expect(afterAbortRes.status).toBe(200);

      // 2. 504 timeout must release concurrency slot
      fs.writeFileSync(hangOnceFlagPath, 'hang-once', 'utf8');
      const timeoutRes = await fetch(`${slotSrv.baseUrl}/convert`, {
        method: 'POST',
        body: Buffer.from(zipBody),
      });
      expect(timeoutRes.status).toBe(504);

      const afterTimeoutRes = await fetch(`${slotSrv.baseUrl}/convert`, {
        method: 'POST',
        body: Buffer.from(zipBody),
      });
      expect(afterTimeoutRes.status).toBe(200);

      // 3. 413 oversized chunked refusal must release concurrency slot
      const tooBigStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: slotSrv.port,
            path: '/convert',
            method: 'POST',
            headers: {
              'Content-Type':
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.write(Buffer.from(zipBody.subarray(0, 128)));
        req.write(Buffer.alloc(zipBody.byteLength + 2048, 0x42));
        req.end();
      });
      expect(tooBigStatus).toBe(413);

      const after413Res = await fetch(`${slotSrv.baseUrl}/convert`, {
        method: 'POST',
        body: Buffer.from(zipBody),
      });
      expect(after413Res.status).toBe(200);
    });

    it('R686: ignores soffice override env hooks in production, survives malformed PRE_ARGS_JSON, aligns readiness timeout to 4500ms, and logs kill_unconfirmed guard', async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's110-r686-'));
      tempDirs.push(workRoot);
      const { mockSofficePath, versionLogPath } = createMockSoffice(workRoot);

      // 1. NODE_ENV=production ignores PDF_CONVERTER_SOFFICE_BIN & PRE_ARGS_JSON
      await startConverterProcess({
        NODE_ENV: 'production',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: JSON.stringify([mockSofficePath]),
        MOCK_VERSION_LOG: versionLogPath,
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(versionLogPath)).toBe(false);

      // 2. Non-production malformed PRE_ARGS_JSON logs structured warning and starts cleanly without crashing
      const badJsonSrv = await startConverterProcess({
        NODE_ENV: 'test',
        PDF_CONVERTER_SOFFICE_BIN: process.execPath,
        PDF_CONVERTER_SOFFICE_PRE_ARGS_JSON: '{not-valid-json',
      });
      const liveRes = await fetch(`${badJsonSrv.baseUrl}/health/live`);
      expect(liveRes.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(
        badJsonSrv.stderrLines.join('\n') + badJsonSrv.stdoutLines.join('\n'),
      ).toContain('pdf_converter.invalid_pre_args_json');

      // 3. Static checks for readiness default <5s Bicep timeout and kill_unconfirmed guard
      const serverSrc = fs.readFileSync(
        path.resolve(__dirname, '../../docker/pdf-converter/server.mjs'),
        'utf8',
      );
      expect(serverSrc).toContain('4_500');
      expect(serverSrc).toContain('pdf_converter.kill_unconfirmed');
    });
  });
});
