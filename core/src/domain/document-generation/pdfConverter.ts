/**
 * Active OpenXML-to-PDF Converter (`core/src/domain/document-generation/pdfConverter.ts`).
 *
 * Implements `DocumentPdfConverter` from `@platform/core-api` (ADR-0009):
 * 1. `BuiltInOpenXmlPdfConverter`: Runs in-process with zero external service dependencies,
 *    parsing the merged `.docx` WordprocessingML AST (headers, footers, headings, bold/italic
 *    runs, line breaks `<w:br/>`, and `<w:tbl>` tables) and generating a valid multi-page
 *    PDF 1.4 document with Helvetica / Helvetica-Bold / Helvetica-Oblique typography,
 *    word-wrapped lines, bordered tables, and `Page X of Y` footers.
 * 2. Active from day one so users can generate and download `.pdf` or `.docx` out of the box.
 */

import type {
  DocumentPdfConverter,
  DocumentPdfConverterFallbackMode,
  TenantConfiguration,
} from '../../api/index';
import { readAndValidateDocxZip, unescapeXmlText } from './docxEngine';

export const DEFAULT_HTTP_PDF_CONVERTER_TIMEOUT_MS = 60_000;
export const DEFAULT_HTTP_PDF_CONVERTER_MAX_DOCX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_HTTP_PDF_CONVERTER_MAX_PDF_BYTES = 50 * 1024 * 1024;

export type PdfConverterErrorCode =
  | 'PDF_CONVERTER_UNCONFIGURED'
  | 'PDF_CONVERTER_SIZE_LIMIT'
  | 'PDF_CONVERTER_TIMEOUT'
  | 'PDF_CONVERTER_UNREACHABLE'
  | 'PDF_CONVERTER_HTTP_ERROR'
  | 'PDF_CONVERTER_INVALID_OUTPUT';

export class PdfConverterError extends Error {
  public readonly code: PdfConverterErrorCode;
  public readonly statusCode?: number;

  public constructor(
    code: PdfConverterErrorCode,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = 'PdfConverterError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface PdfConverterFallbackWarningEvent {
  readonly event: 'document_generation.pdf_converter_fallback';
  readonly tenantId?: string;
  readonly correlationId?: string;
  readonly errorCode: string;
  readonly fallbackConverterId: string;
}

function defaultEmitFallbackWarning(event: PdfConverterFallbackWarningEvent): void {
  // Structured log intentionally excludes document title, filename, and content (S1-10, Rule 10 / Standard §14).
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: event.event,
      ...(event.tenantId ? { tenantId: event.tenantId } : {}),
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      errorCode: event.errorCode,
      fallbackConverterId: event.fallbackConverterId,
    }),
  );
}

function hasPdfMagicSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

interface PdfRenderLine {
  text: string;
  font: 'F1' | 'F2' | 'F3'; // F1 = Helvetica, F2 = Helvetica-Bold, F3 = Helvetica-Oblique
  fontSize: number;
  lineHeight: number;
  indentPt?: number;
  isRuleAfter?: boolean;
  isTableLine?: boolean;
}

function sanitizePdfLiteral(input: string): string {
  return input
    .replace(/£/g, '\xA3')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/•/g, '*')
    .replace(/[^\x20-\x7E\xA3]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapTextToWidth(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [''];
  if (trimmed.length <= maxChars) return [trimmed];

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function extractPlainLinesFromParagraphXml(pXml: string): {
  lines: string[];
  headingLevel: 0 | 1 | 2;
  isBold: boolean;
  isItalic: boolean;
} {
  let headingLevel: 0 | 1 | 2 = 0;
  if (/w:pStyle\s+w:val="Heading1"/i.test(pXml)) {
    headingLevel = 1;
  } else if (/w:pStyle\s+w:val="Heading2"/i.test(pXml)) {
    headingLevel = 2;
  }

  const isBold = headingLevel > 0 || /<w:b\b/i.test(pXml);
  const isItalic = !isBold && /<w:i\b/i.test(pXml);

  // Convert <w:br/> tags into newline markers before extracting <w:t>
  const normalizedXml = pXml.replace(
    /<w:br\b[^>]*\/>/g,
    '<w:t>\n</w:t>',
  );

  let rawText = '';
  const wtRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = wtRegex.exec(normalizedXml)) !== null) {
    rawText += unescapeXmlText(m[1] ?? '');
  }

  return {
    lines: rawText.split(/\r?\n/),
    headingLevel,
    isBold,
    isItalic,
  };
}

export class BuiltInOpenXmlPdfConverter implements DocumentPdfConverter {
  public readonly converterId = 'builtin-openxml-pdf';

  public async convertDocxToPdf(input: {
    docxBytes: Uint8Array;
    title: string;
    authorName?: string;
  }): Promise<Uint8Array> {
    const entries = readAndValidateDocxZip(input.docxBytes, 50);
    const decoder = new TextDecoder('utf-8');

    const headerEntry = entries.get('word/header1.xml');
    const footerEntry = entries.get('word/footer1.xml');
    const docEntry = entries.get('word/document.xml');

    const headerText = headerEntry
      ? extractPlainLinesFromParagraphXml(decoder.decode(headerEntry.data)).lines
          .join(' ')
          .trim()
      : '';
    const footerText = footerEntry
      ? extractPlainLinesFromParagraphXml(decoder.decode(footerEntry.data)).lines
          .join(' ')
          .trim()
      : '';

    const docXml = docEntry ? decoder.decode(docEntry.data) : '';
    const renderLines: PdfRenderLine[] = [];

    // Tokenize body children in order: either <w:tbl>...</w:tbl> or <w:p>...</w:p>
    const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
    let blockMatch: RegExpExecArray | null;

    while ((blockMatch = blockRegex.exec(docXml)) !== null) {
      const block = blockMatch[0];
      if (block.startsWith('<w:tbl')) {
        // Parse table rows and cells
        const rowMatches = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
        rowMatches.forEach((trXml, rowIdx) => {
          const cellMatches = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
          const cellTexts = cellMatches.map((tcXml) => {
            const pMatches = tcXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [tcXml];
            return pMatches
              .map((p) => extractPlainLinesFromParagraphXml(p).lines.join(' ').trim())
              .filter(Boolean)
              .join(' ');
          });
          const formattedRow = `| ${cellTexts.join(' | ')} |`;
          for (const wrapped of wrapTextToWidth(formattedRow, 86)) {
            renderLines.push({
              text: wrapped,
              font: rowIdx === 0 ? 'F2' : 'F1',
              fontSize: 9.5,
              lineHeight: 13,
              isTableLine: true,
            });
          }
        });
        renderLines.push({
          text: '',
          font: 'F1',
          fontSize: 10,
          lineHeight: 8,
        });
      } else {
        const parsed = extractPlainLinesFromParagraphXml(block);
        const fontSize =
          parsed.headingLevel === 1
            ? 15
            : parsed.headingLevel === 2
              ? 12.5
              : 10.5;
        const lineHeight =
          parsed.headingLevel === 1
            ? 20
            : parsed.headingLevel === 2
              ? 17
              : 14;
        const maxChars =
          parsed.headingLevel === 1
            ? 62
            : parsed.headingLevel === 2
              ? 74
              : 84;
        const font: 'F1' | 'F2' | 'F3' = parsed.isBold
          ? 'F2'
          : parsed.isItalic
            ? 'F3'
            : 'F1';

        for (const rawLine of parsed.lines) {
          if (!rawLine.trim()) {
            renderLines.push({
              text: '',
              font: 'F1',
              fontSize: 10,
              lineHeight: 8,
            });
            continue;
          }
          const wrappedLines = wrapTextToWidth(rawLine, maxChars);
          wrappedLines.forEach((wLine, idx) => {
            renderLines.push({
              text: wLine,
              font,
              fontSize,
              lineHeight,
              isRuleAfter:
                parsed.headingLevel === 1 && idx === wrappedLines.length - 1,
            });
          });
        }
      }
    }

    if (renderLines.length === 0) {
      renderLines.push({
        text: input.title || 'Generated Document',
        font: 'F2',
        fontSize: 14,
        lineHeight: 18,
      });
    }

    // Paginate onto A4 portrait pages (595.28 x 841.89 pt)
    const pageTopY = 775;
    const pageBottomY = 65;
    const leftMarginX = 52;
    const rightMarginX = 543;

    const pages: PdfRenderLine[][] = [];
    let currentPage: PdfRenderLine[] = [];
    let currentY = pageTopY;

    for (const line of renderLines) {
      if (currentY - line.lineHeight < pageBottomY && currentPage.length > 0) {
        pages.push(currentPage);
        currentPage = [];
        currentY = pageTopY;
      }
      currentPage.push(line);
      currentY -= line.lineHeight;
    }
    if (currentPage.length > 0 || pages.length === 0) {
      pages.push(currentPage);
    }

    // Build PDF 1.4 objects
    // Obj 1: Catalog
    // Obj 2: Pages
    // Obj 3: Font F1 (Helvetica)
    // Obj 4: Font F2 (Helvetica-Bold)
    // Obj 5: Font F3 (Helvetica-Oblique)
    // Obj 6..: Page + Content stream pairs
    const objects: string[] = [];
    const pageObjectIds: number[] = [];

    objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
    objects.push(''); // Placeholder for Obj 2 (Pages)
    objects.push(
      '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj',
    );
    objects.push(
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj',
    );
    objects.push(
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\nendobj',
    );

    let nextObjId = 6;

    pages.forEach((pageLines, pageIdx) => {
      const pageObjId = nextObjId++;
      const contentObjId = nextObjId++;
      pageObjectIds.push(pageObjId);

      const streamCommands: string[] = [];

      // Header banner if present
      if (headerText) {
        streamCommands.push('BT');
        streamCommands.push('/F1 8.5 Tf');
        streamCommands.push('0.35 0.40 0.47 rg');
        streamCommands.push(`1 0 0 1 ${leftMarginX} 804 Tm`);
        streamCommands.push(`(${sanitizePdfLiteral(headerText)}) Tj`);
        streamCommands.push('ET');
        streamCommands.push('0.82 0.85 0.90 RG 0.5 w');
        streamCommands.push(`${leftMarginX} 796 m ${rightMarginX} 796 l S`);
      }

      // Main page body
      let cursorY = pageTopY;
      streamCommands.push('0.06 0.09 0.16 rg');

      for (const line of pageLines) {
        cursorY -= line.lineHeight;
        if (line.text) {
          streamCommands.push('BT');
          streamCommands.push(`/${line.font} ${line.fontSize} Tf`);
          streamCommands.push(
            `1 0 0 1 ${leftMarginX + (line.indentPt ?? 0)} ${cursorY.toFixed(2)} Tm`,
          );
          streamCommands.push(`(${sanitizePdfLiteral(line.text)}) Tj`);
          streamCommands.push('ET');
        }
        if (line.isRuleAfter) {
          const ruleY = (cursorY - 4).toFixed(2);
          streamCommands.push('0.75 0.80 0.86 RG 0.75 w');
          streamCommands.push(
            `${leftMarginX} ${ruleY} m ${rightMarginX} ${ruleY} l S`,
          );
          cursorY -= 4;
        }
      }

      // Footer & Page X of Y
      const footerLabel = footerText
        ? `${footerText}   |   Page ${pageIdx + 1} of ${pages.length}`
        : `Page ${pageIdx + 1} of ${pages.length}`;
      streamCommands.push('0.82 0.85 0.90 RG 0.5 w');
      streamCommands.push(`${leftMarginX} 48 m ${rightMarginX} 48 l S`);
      streamCommands.push('BT');
      streamCommands.push('/F1 8.5 Tf');
      streamCommands.push('0.35 0.40 0.47 rg');
      streamCommands.push(`1 0 0 1 ${leftMarginX} 34 Tm`);
      streamCommands.push(`(${sanitizePdfLiteral(footerLabel)}) Tj`);
      streamCommands.push('ET');

      const streamBody = streamCommands.join('\n');
      objects.push(
        `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj`,
      );
      objects.push(
        `${contentObjId} 0 obj\n<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream\nendobj`,
      );
    });

    objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>\nendobj`;

    let pdfContent = '%PDF-1.4\n';
    const offsets: number[] = [0];
    for (const obj of objects) {
      offsets.push(pdfContent.length);
      pdfContent += `${obj}\n`;
    }

    const xrefOffset = pdfContent.length;
    pdfContent += `xref\n0 ${objects.length + 1}\n`;
    pdfContent += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      const off = String(offsets[i] ?? 0).padStart(10, '0');
      pdfContent += `${off} 00000 n \n`;
    }

    pdfContent += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return new TextEncoder().encode(pdfContent);
  }
}

export class HttpPdfConverter implements DocumentPdfConverter {
  public readonly converterId = 'libreoffice-http-pdf';
  public readonly baseUrl: string;
  public readonly timeoutMs: number;
  public readonly maxDocxBytes: number;
  public readonly maxPdfBytes: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: {
    baseUrl: string;
    timeoutMs?: number;
    maxDocxBytes?: number;
    maxPdfBytes?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_HTTP_PDF_CONVERTER_TIMEOUT_MS;
    this.maxDocxBytes =
      options.maxDocxBytes ?? DEFAULT_HTTP_PDF_CONVERTER_MAX_DOCX_BYTES;
    this.maxPdfBytes =
      options.maxPdfBytes ?? DEFAULT_HTTP_PDF_CONVERTER_MAX_PDF_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async convertDocxToPdf(input: {
    docxBytes: Uint8Array;
    title: string;
    authorName?: string;
    readonly tenantId?: string;
    readonly correlationId?: string;
  }): Promise<Uint8Array> {
    if (!this.baseUrl) {
      throw new PdfConverterError(
        'PDF_CONVERTER_UNCONFIGURED',
        'DOC_CONVERTER_URL is not configured for container PDF conversion.',
      );
    }

    if (input.docxBytes.byteLength > this.maxDocxBytes) {
      throw new PdfConverterError(
        'PDF_CONVERTER_SIZE_LIMIT',
        `DOCX payload (${input.docxBytes.byteLength} bytes) exceeds maximum PDF converter limit (${this.maxDocxBytes} bytes).`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new PdfConverterError(
          'PDF_CONVERTER_TIMEOUT',
          `PDF converter container request timed out after ${this.timeoutMs} ms.`,
        ),
      );
    }, this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      if (input.tenantId?.trim()) {
        headers['x-tenant-id'] = input.tenantId.trim();
      }
      if (input.correlationId?.trim()) {
        headers['x-correlation-id'] = input.correlationId.trim();
      }

      const response = await this.fetchImpl(`${this.baseUrl}/convert`, {
        method: 'POST',
        headers,
        body: Buffer.from(input.docxBytes),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PdfConverterError(
          'PDF_CONVERTER_HTTP_ERROR',
          `PDF converter container responded with HTTP ${response.status}.`,
          response.status,
        );
      }

      const contentLengthHeader = response.headers?.get('content-length');
      if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
        const declaredPdfLength = Number(contentLengthHeader);
        if (
          Number.isFinite(declaredPdfLength) &&
          declaredPdfLength > this.maxPdfBytes
        ) {
          response.body?.cancel().catch(() => {});
          throw new PdfConverterError(
            'PDF_CONVERTER_SIZE_LIMIT',
            `PDF response (${declaredPdfLength} bytes) exceeds maximum limit (${this.maxPdfBytes} bytes).`,
          );
        }
      }

      let pdfBytes: Uint8Array;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          totalBytes += value.byteLength;
          if (totalBytes > this.maxPdfBytes) {
            reader.cancel().catch(() => {});
            controller.abort(
              new PdfConverterError(
                'PDF_CONVERTER_SIZE_LIMIT',
                `PDF response exceeds maximum limit (${this.maxPdfBytes} bytes).`,
              ),
            );
            throw new PdfConverterError(
              'PDF_CONVERTER_SIZE_LIMIT',
              `PDF response (${totalBytes} bytes) exceeds maximum limit (${this.maxPdfBytes} bytes).`,
            );
          }
          chunks.push(value);
        }
        pdfBytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          pdfBytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        pdfBytes = new Uint8Array(await response.arrayBuffer());
        if (pdfBytes.byteLength > this.maxPdfBytes) {
          throw new PdfConverterError(
            'PDF_CONVERTER_SIZE_LIMIT',
            `PDF response (${pdfBytes.byteLength} bytes) exceeds maximum limit (${this.maxPdfBytes} bytes).`,
          );
        }
      }

      if (!hasPdfMagicSignature(pdfBytes)) {
        throw new PdfConverterError(
          'PDF_CONVERTER_INVALID_OUTPUT',
          'PDF converter container response did not start with a valid %PDF- header.',
        );
      }

      return pdfBytes;
    } catch (err) {
      if (err instanceof PdfConverterError) {
        throw err;
      }
      if (controller.signal.aborted || isAbortLikeError(err)) {
        throw new PdfConverterError(
          'PDF_CONVERTER_TIMEOUT',
          `PDF converter container request timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new PdfConverterError(
        'PDF_CONVERTER_UNREACHABLE',
        'PDF converter container could not be reached over DOC_CONVERTER_URL.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FallbackAwarePdfConverter implements DocumentPdfConverter {
  public readonly converterId: string;
  private readonly primary: DocumentPdfConverter;
  private readonly fallback: DocumentPdfConverter;
  private readonly fallbackMode: DocumentPdfConverterFallbackMode;
  private readonly onFallbackWarning: (
    event: PdfConverterFallbackWarningEvent,
  ) => void;

  public constructor(options: {
    primary: DocumentPdfConverter;
    fallback: DocumentPdfConverter;
    fallbackMode: DocumentPdfConverterFallbackMode;
    onFallbackWarning?: (event: PdfConverterFallbackWarningEvent) => void;
  }) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.fallbackMode = options.fallbackMode;
    this.onFallbackWarning =
      options.onFallbackWarning ?? defaultEmitFallbackWarning;
    this.converterId = `${options.primary.converterId}+fallback:${options.fallbackMode}`;
  }

  public async convertDocxToPdf(input: {
    docxBytes: Uint8Array;
    title: string;
    authorName?: string;
    readonly tenantId?: string;
    readonly correlationId?: string;
  }): Promise<Uint8Array> {
    try {
      return await this.primary.convertDocxToPdf(input);
    } catch (err) {
      if (this.fallbackMode === 'fail') {
        throw err;
      }
      const errorCode =
        err instanceof PdfConverterError ? err.code : 'PDF_CONVERTER_FAILED';
      this.onFallbackWarning({
        event: 'document_generation.pdf_converter_fallback',
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        errorCode,
        fallbackConverterId: this.fallback.converterId,
      });
      return this.fallback.convertDocxToPdf(input);
    }
  }
}

export function selectDocumentPdfConverter(
  tenantConfig: Pick<TenantConfiguration, 'documentGeneration'>,
  options?: {
    converterUrl?: string;
    timeoutMs?: number;
    maxDocxBytes?: number;
    maxPdfBytes?: number;
    fetchImpl?: typeof fetch;
    onFallbackWarning?: (event: PdfConverterFallbackWarningEvent) => void;
  },
): DocumentPdfConverter {
  const converterMode = tenantConfig.documentGeneration.pdfConverter ?? 'builtin';
  const fallbackMode =
    tenantConfig.documentGeneration.pdfConverterFallback ?? 'builtin';

  const builtin = new BuiltInOpenXmlPdfConverter();
  if (converterMode !== 'container') {
    return builtin;
  }

  const baseUrl = (options?.converterUrl ?? process.env.DOC_CONVERTER_URL ?? '').trim();
  const primary = new HttpPdfConverter({
    baseUrl,
    timeoutMs: options?.timeoutMs,
    maxDocxBytes: options?.maxDocxBytes,
    maxPdfBytes: options?.maxPdfBytes,
    fetchImpl: options?.fetchImpl,
  });

  return new FallbackAwarePdfConverter({
    primary,
    fallback: builtin,
    fallbackMode,
    onFallbackWarning: options?.onFallbackWarning,
  });
}
