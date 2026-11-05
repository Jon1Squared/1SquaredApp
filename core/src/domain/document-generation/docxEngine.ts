/**
 * OpenXML `.docx` ZIP Processor and Split-Run Coalescing Basic-Merge Engine
 * (`core/src/domain/document-generation/docxEngine.ts`).
 *
 * Rules enforced (ADR-0007 & ADR-0009):
 * 1. Handles placeholders split across multiple Word `<w:r>` and `<w:t>` runs (e.g. by spellcheck/rsid).
 * 2. Preserves the first run's `<w:rPr>` character formatting when coalescing split runs.
 * 3. Rejects reserved `{% ... %}` block syntax with a clear validation error (`RESERVED_BLOCK_SYNTAX_UNSUPPORTED`).
 * 4. Rejects `.docm`, macro-containing archives (`vbaProject.bin`), non-ZIP files, and Zip-Bomb payloads.
 * 5. XML-escapes all merged values so field values can never inject WordprocessingML markup.
 */

import zlib from 'node:zlib';
import type {
  DocumentGenerationEngine,
  ExtractedPlaceholder,
  PlaceholderFilterName,
  TemplatePlaceholderMapping,
} from '../../api/index';
import {
  applyPlaceholderFilter,
  parsePlaceholderExpression,
} from './filters';

export interface ZipArchiveEntry {
  fileName: string;
  compressionMethod: number;
  data: Uint8Array;
}

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MiB ceiling against zip-bombs
const MAX_COMPRESSION_RATIO = 100;
const MAX_ZIP_ENTRIES = 2000;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (crc ^ bytes[i]!) & 0xff;
    crc = (CRC32_TABLE[idx]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXmlText(xmlText: string): string {
  return xmlText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Reads a `.docx` ZIP archive (supporting both Store method 0 and Deflate method 8)
 * while enforcing Zip-Bomb and Macro rejection rules.
 */
export function readAndValidateDocxZip(
  docxBytes: Uint8Array,
  maxSizeMb = 10,
): Map<string, ZipArchiveEntry> {
  if (!docxBytes || docxBytes.length < 4) {
    throw new Error(
      'DOCX_INVALID_FILE: Uploaded file is empty or not a valid .docx archive.',
    );
  }

  const maxAllowedBytes = maxSizeMb * 1024 * 1024;
  if (docxBytes.length > maxAllowedBytes) {
    throw new Error(
      `DOCX_SIZE_LIMIT_EXCEEDED: Template size (${(docxBytes.length / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed ${maxSizeMb} MB.`,
    );
  }

  // Verify PK\x03\x04 local file header magic bytes
  if (
    docxBytes[0] !== 0x50 ||
    docxBytes[1] !== 0x4b ||
    docxBytes[2] !== 0x03 ||
    docxBytes[3] !== 0x04
  ) {
    throw new Error(
      'DOCX_INVALID_SIGNATURE: File is not a valid OpenXML ZIP archive (.docx required).',
    );
  }

  const view = new DataView(
    docxBytes.buffer,
    docxBytes.byteOffset,
    docxBytes.byteLength,
  );

  // Locate End of Central Directory (EOCD) record (0x06054b50)
  let eocdOffset = -1;
  const minEocdSearch = Math.max(0, docxBytes.length - 65557);
  for (let i = docxBytes.length - 22; i >= minEocdSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error(
      'DOCX_CORRUPT_ARCHIVE: Missing ZIP End of Central Directory record.',
    );
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(
      `DOCX_SECURITY_ZIP_BOMB: Archive contains too many entries (${totalEntries}).`,
    );
  }

  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let cursor = centralDirOffset;
  let cumulativeUncompressedBytes = 0;
  const entries = new Map<string, ZipArchiveEntry>();
  const decoder = new TextDecoder('utf-8');

  for (let idx = 0; idx < totalEntries; idx++) {
    if (
      cursor + 46 > docxBytes.length ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new Error(
        'DOCX_CORRUPT_ARCHIVE: Invalid Central Directory file header.',
      );
    }

    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const fileNameBytes = docxBytes.subarray(
      cursor + 46,
      cursor + 46 + fileNameLen,
    );
    const fileName = decoder.decode(fileNameBytes);

    if (fileName.includes('..') || fileName.startsWith('/')) {
      throw new Error(
        `DOCX_SECURITY_PATH_TRAVERSAL: Unsafe archive entry path "${fileName}".`,
      );
    }

    if (
      /vbaProject\.bin$/i.test(fileName) ||
      /vbaData\.xml$/i.test(fileName) ||
      /\.bin$/i.test(fileName)
    ) {
      throw new Error(
        'DOCX_MACRO_REJECTED: Macro-enabled Word files (.docm / VBA projects) are prohibited.',
      );
    }

    cumulativeUncompressedBytes += uncompressedSize;
    if (cumulativeUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        'DOCX_SECURITY_ZIP_BOMB: Uncompressed archive payload exceeds maximum safety threshold.',
      );
    }

    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO &&
      uncompressedSize > 1024 * 1024
    ) {
      throw new Error(
        'DOCX_SECURITY_ZIP_BOMB: Suspicious compression ratio detected.',
      );
    }

    // Read from local file header
    if (
      localHeaderOffset + 30 > docxBytes.length ||
      view.getUint32(localHeaderOffset, true) !== 0x04034b50
    ) {
      throw new Error('DOCX_CORRUPT_ARCHIVE: Invalid Local File Header.');
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawCompressed = docxBytes.subarray(
      dataStart,
      dataStart + compressedSize,
    );

    let data: Uint8Array;
    if (compressionMethod === 0) {
      data = new Uint8Array(rawCompressed);
    } else if (compressionMethod === 8) {
      const inflated = zlib.inflateRawSync(rawCompressed, {
        maxOutputLength: MAX_UNCOMPRESSED_BYTES,
      });
      data = new Uint8Array(
        inflated.buffer,
        inflated.byteOffset,
        inflated.byteLength,
      );
    } else {
      throw new Error(
        `DOCX_UNSUPPORTED_COMPRESSION: Unsupported ZIP compression method ${compressionMethod} on entry "${fileName}".`,
      );
    }

    entries.set(fileName, {
      fileName,
      compressionMethod,
      data,
    });

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  const contentTypesEntry = entries.get('[Content_Types].xml');
  if (!contentTypesEntry) {
    throw new Error(
      'DOCX_INVALID_STRUCTURE: Archive is missing [Content_Types].xml.',
    );
  }
  const contentTypesXml = decoder.decode(contentTypesEntry.data);
  if (/macroEnabled/i.test(contentTypesXml)) {
    throw new Error(
      'DOCX_MACRO_REJECTED: Macro-enabled Word content type (.docm) is prohibited.',
    );
  }

  if (!entries.has('word/document.xml')) {
    throw new Error(
      'DOCX_INVALID_STRUCTURE: Archive is missing word/document.xml.',
    );
  }

  return entries;
}

/**
 * Serializes a map of `ZipArchiveEntry` items back into a standard OpenXML `.docx` ZIP archive.
 */
export function writeDocxZip(entries: Map<string, ZipArchiveEntry>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries.values()) {
    const nameBytes = encoder.encode(entry.fileName);
    const uncompressed = entry.data;
    const crc = crc32(uncompressed);

    const compressedBuf =
      entry.compressionMethod === 8
        ? zlib.deflateRawSync(uncompressed)
        : Buffer.from(uncompressed);
    const compressed = new Uint8Array(
      compressedBuf.buffer,
      compressedBuf.byteOffset,
      compressedBuf.byteLength,
    );
    const method = entry.compressionMethod === 8 ? 8 : 0;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, uncompressed.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, uncompressed.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, compressed);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
    count++;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

interface TextNodeLocation {
  startInXml: number;
  endInXml: number;
  openTagEndInXml: number;
  closeTagStartInXml: number;
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Coalesces `<w:t>` text nodes inside a single `<w:p>...</w:p>` block so that placeholders
 * like `{{ matter.reference }}` split across multiple `<w:r>` runs (with intervening `<w:proofErr/>`
 * or `<w:rPr>` tags) are reassembled into a single `<w:t>` node on the first run of the span.
 */
export function coalesceSplitRunsInParagraphXml(paragraphXml: string): string {
  // Strip <w:proofErr .../> tags that Word inserts inside words
  const cleanedParagraph = paragraphXml.replace(/<w:proofErr\b[^>]*\/>/g, '');

  const wtRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const nodes: TextNodeLocation[] = [];
  let fullText = '';
  let match: RegExpExecArray | null;

  while ((match = wtRegex.exec(cleanedParagraph)) !== null) {
    const fullMatch = match[0];
    const innerXml = match[1] ?? '';
    const decodedText = unescapeXmlText(innerXml);
    const startInXml = match.index;
    const endInXml = startInXml + fullMatch.length;
    const openTagEndInXml = startInXml + fullMatch.indexOf('>') + 1;
    const closeTagStartInXml = endInXml - '</w:t>'.length;

    const charStart = fullText.length;
    fullText += decodedText;
    const charEnd = fullText.length;

    nodes.push({
      startInXml,
      endInXml,
      openTagEndInXml,
      closeTagStartInXml,
      text: decodedText,
      charStart,
      charEnd,
    });
  }

  if (nodes.length <= 1) {
    return cleanedParagraph;
  }

  // Locate any `{{ ... }}` or `{% ... %}` spans across the concatenated paragraph text
  const tokenRegex = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/g;
  const updatedTexts = nodes.map((n) => n.text);
  let coalescedAny = false;
  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = tokenRegex.exec(fullText)) !== null) {
    const spanStart = tokenMatch.index;
    const spanEnd = spanStart + tokenMatch[0].length;

    const firstNodeIdx = nodes.findIndex(
      (n) => n.charEnd > spanStart && n.charStart <= spanStart,
    );
    const lastNodeIdx = nodes.findIndex(
      (n) => n.charEnd >= spanEnd && n.charStart < spanEnd,
    );

    if (
      firstNodeIdx !== -1 &&
      lastNodeIdx !== -1 &&
      lastNodeIdx > firstNodeIdx
    ) {
      coalescedAny = true;
      // Merge the entire text across [firstNodeIdx .. lastNodeIdx] into firstNodeIdx
      let combined = '';
      for (let i = firstNodeIdx; i <= lastNodeIdx; i++) {
        combined += updatedTexts[i];
        if (i > firstNodeIdx) {
          updatedTexts[i] = '';
        }
      }
      updatedTexts[firstNodeIdx] = combined;
    }
  }

  if (!coalescedAny) {
    return cleanedParagraph;
  }

  // Rebuild paragraph XML replacing each <w:t>...</w:t> with its updated text
  let rebuilt = '';
  let lastXmlPos = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    rebuilt += cleanedParagraph.slice(lastXmlPos, node.startInXml);
    rebuilt += `<w:t xml:space="preserve">${escapeXmlText(updatedTexts[i]!)}</w:t>`;
    lastXmlPos = node.endInXml;
  }
  rebuilt += cleanedParagraph.slice(lastXmlPos);
  return rebuilt;
}

/**
 * Coalesces split runs across all `<w:p>` paragraphs in a WordprocessingML XML part.
 */
export function coalesceSplitRunsInXmlPart(xmlPart: string): string {
  return xmlPart.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) =>
    coalesceSplitRunsInParagraphXml(paragraphXml),
  );
}

function isWordContentXmlPart(fileName: string): boolean {
  return (
    fileName === 'word/document.xml' ||
    /^word\/header\d*\.xml$/.test(fileName) ||
    /^word\/footer\d*\.xml$/.test(fileName)
  );
}

function renderValueIntoWordXml(escapedOrMultiLineText: string): string {
  if (!escapedOrMultiLineText.includes('\n')) {
    return escapeXmlText(escapedOrMultiLineText);
  }
  const lines = escapedOrMultiLineText.split(/\r?\n/);
  return lines
    .map((line) => escapeXmlText(line))
    .join('</w:t><w:br/><w:t xml:space="preserve">');
}

export class BasicMergeEngine implements DocumentGenerationEngine {
  public readonly engineId = 'basic-merge';
  public readonly supportedVersion = '1.0.0';
  private readonly maxTemplateSizeMb: number;

  constructor(options?: { maxTemplateSizeMb?: number }) {
    this.maxTemplateSizeMb = options?.maxTemplateSizeMb ?? 10;
  }

  public async extractPlaceholders(docxBytes: Uint8Array): Promise<{
    placeholders: ExtractedPlaceholder[];
    validationErrors: Array<{ code: string; message: string; token?: string }>;
  }> {
    const entries = readAndValidateDocxZip(docxBytes, this.maxTemplateSizeMb);
    const decoder = new TextDecoder('utf-8');
    const byIdentifier = new Map<string, ExtractedPlaceholder>();
    const validationErrors: Array<{
      code: string;
      message: string;
      token?: string;
    }> = [];

    for (const [partName, entry] of entries.entries()) {
      if (!isWordContentXmlPart(partName)) continue;

      const rawXml = decoder.decode(entry.data);
      const coalescedXml = coalesceSplitRunsInXmlPart(rawXml);

      const paragraphMatches = coalescedXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [
        coalescedXml,
      ];

      paragraphMatches.forEach((pXml, paragraphIndex) => {
        // Extract plain text of paragraph from <w:t> nodes
        let paragraphText = '';
        const wtRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
        let m: RegExpExecArray | null;
        while ((m = wtRegex.exec(pXml)) !== null) {
          paragraphText += unescapeXmlText(m[1] ?? '');
        }

        // 1. Check for reserved `{% ... %}` block syntax
        const blockRegex = /\{%[\s\S]*?%\}/g;
        let blockMatch: RegExpExecArray | null;
        while ((blockMatch = blockRegex.exec(paragraphText)) !== null) {
          const rawBlock = blockMatch[0];
          validationErrors.push({
            code: 'RESERVED_BLOCK_SYNTAX_UNSUPPORTED',
            message: `Block tag "${rawBlock}" is reserved for the future conditional/repeating engine and is not permitted in a basic-merge template.`,
            token: rawBlock,
          });
        }

        // 2. Extract `{{ ... }}` placeholders
        const placeholderRegex = /\{\{([\s\S]*?)\}\}/g;
        let phMatch: RegExpExecArray | null;
        while ((phMatch = placeholderRegex.exec(paragraphText)) !== null) {
          const rawToken = phMatch[0];
          const inner = phMatch[1] ?? '';
          const parsed = parsePlaceholderExpression(inner);

          if (!parsed.identifier) {
            validationErrors.push({
              code: 'EMPTY_PLACEHOLDER_TOKEN',
              message: `Empty placeholder "${rawToken}" found in ${partName}.`,
              token: rawToken,
            });
            continue;
          }

          if (parsed.invalidFilterName) {
            validationErrors.push({
              code: 'UNSUPPORTED_PLACEHOLDER_FILTER',
              message: `Filter "${parsed.invalidFilterName}" in placeholder "${rawToken}" is not supported.`,
              token: rawToken,
            });
          }

          const existing = byIdentifier.get(parsed.identifier);
          if (existing) {
            existing.locations.push({ partName, paragraphIndex });
            if (!existing.inlineFilter && parsed.inlineFilter) {
              existing.inlineFilter = parsed.inlineFilter;
            }
          } else {
            byIdentifier.set(parsed.identifier, {
              rawToken,
              identifier: parsed.identifier,
              inlineFilter: parsed.inlineFilter,
              locations: [{ partName, paragraphIndex }],
            });
          }
        }
      });
    }

    return {
      placeholders: Array.from(byIdentifier.values()),
      validationErrors,
    };
  }

  public async render(input: {
    docxBytes: Uint8Array;
    resolvedValues: Record<string, unknown>;
    mappings: Record<string, TemplatePlaceholderMapping>;
  }): Promise<{
    outputBytes: Uint8Array;
    missingRequiredFields: string[];
    warnings: string[];
  }> {
    const entries = readAndValidateDocxZip(
      input.docxBytes,
      this.maxTemplateSizeMb,
    );
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    // First verify there are no reserved {% ... %} tags
    const extraction = await this.extractPlaceholders(input.docxBytes);
    const blockError = extraction.validationErrors.find(
      (e) => e.code === 'RESERVED_BLOCK_SYNTAX_UNSUPPORTED',
    );
    if (blockError) {
      throw new Error(`${blockError.code}: ${blockError.message}`);
    }

    const missingRequiredSet = new Set<string>();
    const warnings: string[] = [];

    // Check required mappings up front and also during token substitution
    for (const placeholder of extraction.placeholders) {
      const id = placeholder.identifier;
      const mapping = input.mappings[id];
      const lookupKey =
        mapping?.sourceType === 'prompted'
          ? `prompted.${mapping.promptedKey ?? id}`
          : (mapping?.catalogueKey ?? id);

      const rawVal =
        input.resolvedValues[lookupKey] ?? input.resolvedValues[id];
      const isEmpty =
        rawVal === undefined ||
        rawVal === null ||
        (typeof rawVal === 'string' && rawVal.trim() === '');

      if (isEmpty && mapping?.required && !mapping.fallbackText) {
        missingRequiredSet.add(lookupKey);
      }
    }

    if (missingRequiredSet.size > 0) {
      return {
        outputBytes: new Uint8Array(0),
        missingRequiredFields: Array.from(missingRequiredSet),
        warnings,
      };
    }

    for (const [partName, entry] of entries.entries()) {
      if (!isWordContentXmlPart(partName)) continue;

      const rawXml = decoder.decode(entry.data);
      const coalescedXml = coalesceSplitRunsInXmlPart(rawXml);

      const mergedXml = coalescedXml.replace(
        /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g,
        (fullWtTag, innerXml: string) => {
          const decoded = unescapeXmlText(innerXml);
          if (!decoded.includes('{{')) {
            return fullWtTag;
          }

          const replacedXmlContent = decoded
            .split(/(\{\{[\s\S]*?\}\})/g)
            .map((segment) => {
              if (!segment.startsWith('{{') || !segment.endsWith('}}')) {
                return escapeXmlText(segment);
              }
              const inner = segment.slice(2, -2);
              const parsed = parsePlaceholderExpression(inner);
              const id = parsed.identifier;
              const mapping = input.mappings[id];

              const lookupKey =
                mapping?.sourceType === 'prompted'
                  ? `prompted.${mapping.promptedKey ?? id}`
                  : (mapping?.catalogueKey ?? id);

              const rawVal =
                input.resolvedValues[lookupKey] ?? input.resolvedValues[id];
              const isEmpty =
                rawVal === undefined ||
                rawVal === null ||
                (typeof rawVal === 'string' && rawVal.trim() === '');

              if (isEmpty) {
                if (mapping?.fallbackText !== undefined && mapping.fallbackText !== '') {
                  return renderValueIntoWordXml(mapping.fallbackText);
                }
                if (mapping?.required) {
                  missingRequiredSet.add(lookupKey);
                }
                return '';
              }

              const activeFilter: PlaceholderFilterName | undefined =
                mapping?.formatFilter ?? parsed.inlineFilter?.name;
              const activeArg: string | undefined =
                mapping?.formatArg ?? parsed.inlineFilter?.arg;

              const formatted = applyPlaceholderFilter(
                rawVal,
                activeFilter,
                activeArg,
              );
              return renderValueIntoWordXml(formatted);
            })
            .join('');

          return `<w:t xml:space="preserve">${replacedXmlContent}</w:t>`;
        },
      );

      entries.set(partName, {
        ...entry,
        data: encoder.encode(mergedXml),
      });
    }

    const outputBytes = writeDocxZip(entries);
    return {
      outputBytes,
      missingRequiredFields: Array.from(missingRequiredSet),
      warnings,
    };
  }
}

/**
 * Helper to build a valid OpenXML `.docx` file from structured paragraphs, headers, footers,
 * and optional raw XML paragraphs (used for seeding default templates and unit testing split runs).
 */
export function buildValidDocxArchive(options: {
  paragraphs?: Array<{
    text?: string;
    rawRunsXml?: string;
    heading?: 'Heading1' | 'Heading2';
    bold?: boolean;
  }>;
  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
  headerText?: string;
  footerText?: string;
  compressionMethod?: 0 | 8;
  extraEntries?: Array<{ fileName: string; data: Uint8Array }>;
}): Uint8Array {
  const encoder = new TextEncoder();
  const method = options.compressionMethod ?? 8;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t xml:space="preserve">${escapeXmlText(options.headerText ?? '')}</w:t></w:r></w:p>
</w:hdr>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t xml:space="preserve">${escapeXmlText(options.footerText ?? '')}</w:t></w:r></w:p>
</w:ftr>`;

  const bodyParts: string[] = [];

  for (const p of options.paragraphs ?? []) {
    const pPr = p.heading ? `<w:pPr><w:pStyle w:val="${p.heading}"/></w:pPr>` : '';
    if (p.rawRunsXml) {
      bodyParts.push(`<w:p>${pPr}${p.rawRunsXml}</w:p>`);
    } else {
      const rPr = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
      bodyParts.push(
        `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(p.text ?? '')}</w:t></w:r></w:p>`,
      );
    }
  }

  for (const tbl of options.tables ?? []) {
    const headerRow = `<w:tr>${tbl.headers
      .map(
        (h) =>
          `<w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXmlText(h)}</w:t></w:r></w:p></w:tc>`,
      )
      .join('')}</w:tr>`;
    const dataRows = tbl.rows
      .map(
        (r) =>
          `<w:tr>${r
            .map(
              (c) =>
                `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXmlText(c)}</w:t></w:r></w:p></w:tc>`,
            )
            .join('')}</w:tr>`,
      )
      .join('');
    bodyParts.push(`<w:tbl>${headerRow}${dataRows}</w:tbl>`);
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyParts.join('\n    ')}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHeader1"/>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const entries = new Map<string, ZipArchiveEntry>();
  const addEntry = (fileName: string, xml: string) => {
    entries.set(fileName, {
      fileName,
      compressionMethod: method,
      data: encoder.encode(xml),
    });
  };

  addEntry('[Content_Types].xml', contentTypesXml);
  addEntry('_rels/.rels', rootRelsXml);
  addEntry('word/_rels/document.xml.rels', docRelsXml);
  addEntry('word/header1.xml', headerXml);
  addEntry('word/footer1.xml', footerXml);
  addEntry('word/document.xml', documentXml);

  for (const extra of options.extraEntries ?? []) {
    entries.set(extra.fileName, {
      fileName: extra.fileName,
      compressionMethod: method,
      data: extra.data,
    });
  }

  return writeDocxZip(entries);
}
