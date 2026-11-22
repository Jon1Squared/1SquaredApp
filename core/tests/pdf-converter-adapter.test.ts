import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ errorCode: 'PDF_CONVERTER_NOT_READY' }));
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
        title: 'HTTP 503 Failure',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_CONVERTER_HTTP_ERROR',
      statusCode: 503,
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
});
