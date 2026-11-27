/**
 * Pure TypeScript reader for OpenXML (.xlsx) workbooks using Node's built-in
 * fs and zlib modules (no native or third-party dependencies required).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  minorUnitsToPounds,
  poundsToMinorUnits,
  type MinorUnits,
} from '@platform/core-api';

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // Find End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid XLSX zip archive: EOCD not found');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Invalid Central Directory file header signature');
    }
    const compressionMethod = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const fileNameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + fileNameLen);
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  const out = new Map<string, Buffer>();
  for (const e of entries) {
    const lh = e.localHeaderOffset;
    if (buffer.readUInt32LE(lh) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${e.name}`);
    }
    const nameLen = buffer.readUInt16LE(lh + 26);
    const extraLen = buffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const slice = buffer.subarray(dataStart, dataStart + e.compressedSize);
    if (e.compressionMethod === 0) {
      out.set(e.name, slice);
    } else if (e.compressionMethod === 8) {
      out.set(e.name, zlib.inflateRawSync(slice));
    } else {
      throw new Error(`Unsupported zip compression method ${e.compressionMethod} in ${e.name}`);
    }
  }

  return out;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1];
    const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    let combined = '';
    while ((tMatch = tRegex.exec(inner)) !== null) {
      combined += decodeXmlEntities(tMatch[1]);
    }
    strings.push(combined);
  }
  return strings;
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

export interface RawSheetCell {
  colIndex: number;
  colRef: string;
  rowNumber: number;
  rawType: string;
  value: string;
}

export interface ParsedWorkbook {
  sheetNames: string[];
  getSheetRows: (sheetName: string) => Record<string, string>[];
  getSheetMatrix: (sheetName: string) => { rowNumber: number; cells: Record<string, string> }[];
}

/** Convert an Excel 1900-epoch serial day number (e.g. 46311) to ISO YYYY-MM-DD. */
export function excelSerialToIsoDate(serialStr: string | number | null | undefined): string | null {
  if (serialStr === null || serialStr === undefined || String(serialStr).trim() === '') {
    return null;
  }
  const str = String(serialStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const serial = Number(str);
  if (!Number.isFinite(serial) || serial <= 0) {
    return str;
  }
  // Excel 1900 leap year bug adjustment: serial 25569 is 1970-01-01 UTC
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(utcMs);
  return d.toISOString().slice(0, 10);
}

export interface ParseMoneyContext {
  readonly sheet?: string;
  readonly row?: number;
  readonly column?: string;
}

function formatMoneyLocation(context?: ParseMoneyContext): string {
  if (!context) return 'money cell';
  const parts: string[] = [];
  if (context.sheet) parts.push(`sheet "${context.sheet}"`);
  if (context.row !== undefined) parts.push(`row ${context.row}`);
  if (context.column) parts.push(`column "${context.column}"`);
  return parts.length > 0 ? parts.join(', ') : 'money cell';
}

export function getXlsxRowNumber(
  row: Record<string, unknown>,
  fallbackRowNumber: number,
): number {
  const raw = (row as { __xlsxRowNumber?: unknown }).__xlsxRowNumber;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
    ? raw
    : fallbackRowNumber;
}

/**
 * Parse decimal monetary text or number to exact integer minor units (pence), avoiding floating-point drift.
 * Blank cells return 0; non-numeric / corrupt values throw a plain error naming sheet, row, and column (never logging cell values).
 */
export function parseMoneyPence(
  val: string | number | null | undefined,
  context?: ParseMoneyContext,
): MinorUnits {
  if (val === null || val === undefined) return 0 as MinorUnits;
  const location = formatMoneyLocation(context);
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(
        `Invalid monetary value at ${location}: expected a finite decimal amount.`,
      );
    }
    if (/[eE]/.test(String(val))) {
      // Excel formulas occasionally store residual IEEE-754 zero noise (~1e-14).
      if (Math.abs(val) < 1e-9) {
        return 0 as MinorUnits;
      }
      throw new Error(
        `Invalid monetary value at ${location}: scientific notation is not supported.`,
      );
    }
    try {
      return poundsToMinorUnits(val);
    } catch {
      throw new Error(
        `Invalid monetary value at ${location}: expected a valid decimal amount.`,
      );
    }
  }
  const trimmed = String(val).trim();
  if (!trimmed) return 0 as MinorUnits;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
    try {
      return poundsToMinorUnits(trimmed);
    } catch {
      throw new Error(
        `Invalid monetary value at ${location}: expected a valid decimal amount.`,
      );
    }
  }
  if (/^[-+]?\d+(?:\.\d+)?[eE][-+]?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && Math.abs(parsed) < 1e-9) {
      return 0 as MinorUnits;
    }
    throw new Error(
      `Invalid monetary value at ${location}: scientific notation is not supported.`,
    );
  }
  throw new Error(
    `Invalid monetary value at ${location}: expected a valid decimal amount.`,
  );
}

/** Round money to exact 2 decimal places via integer-pence conversion, avoiding floating-point drift. */
export function parseMoney(
  val: string | number | null | undefined,
  context?: ParseMoneyContext,
): number {
  return minorUnitsToPounds(parseMoneyPence(val, context));
}

export function openXlsxWorkbook(filePath: string): ParsedWorkbook {
  const buf = fs.readFileSync(filePath);
  const files = readZipEntries(buf);

  const wbXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const ssXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sharedStrings = ssXml ? parseSharedStrings(ssXml) : [];

  // Map r:id -> target path
  const relMap = new Map<string, string>();
  const relRegex = /<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?\/?>/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRegex.exec(relsXml)) !== null) {
    relMap.set(relMatch[1], relMatch[2]);
  }
  // Also handle attributes in different order
  const relTagRegex = /<Relationship\b([^>]+)\/?>/g;
  while ((relMatch = relTagRegex.exec(relsXml)) !== null) {
    const attrs = relMatch[1];
    const idM = /\bId="([^"]+)"/.exec(attrs);
    const targetM = /\bTarget="([^"]+)"/.exec(attrs);
    if (idM && targetM) {
      relMap.set(idM[1], targetM[1]);
    }
  }

  // Map sheet name -> worksheet XML path
  const sheetTargetByName = new Map<string, string>();
  const sheetNames: string[] = [];
  const sheetTagRegex = /<sheet\b([^>]+)\/?>/g;
  let shMatch: RegExpExecArray | null;
  while ((shMatch = sheetTagRegex.exec(wbXml)) !== null) {
    const attrs = shMatch[1];
    const nameM = /\bname="([^"]+)"/.exec(attrs);
    const ridM = /\br:id="([^"]+)"/.exec(attrs);
    if (nameM && ridM) {
      const sheetName = decodeXmlEntities(nameM[1]);
      const target = relMap.get(ridM[1]);
      if (target) {
        const normalizedTarget = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('xl/')
            ? target
            : `xl/${target}`;
        sheetTargetByName.set(sheetName, normalizedTarget);
        sheetNames.push(sheetName);
      }
    }
  }

  function getSheetMatrix(sheetName: string): { rowNumber: number; cells: Record<string, string> }[] {
    const target = sheetTargetByName.get(sheetName);
    if (!target) {
      throw new Error(`Worksheet "${sheetName}" not found in workbook`);
    }
    const xml = files.get(target)?.toString('utf8');
    if (!xml) {
      throw new Error(`Worksheet XML "${target}" missing from archive`);
    }

    const rows: { rowNumber: number; cells: Record<string, string> }[] = [];
    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rowRegex.exec(xml)) !== null) {
      const rowAttrs = rMatch[1];
      const rowInner = rMatch[2];
      const rNumM = /\br="(\d+)"/.exec(rowAttrs);
      const rowNumber = rNumM ? parseInt(rNumM[1], 10) : rows.length + 1;
      const cells: Record<string, string> = {};

      const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = cellRegex.exec(rowInner)) !== null) {
        const cAttrs = cMatch[1];
        const cInner = cMatch[2] ?? '';
        const refM = /\br="([A-Z]+)\d+"/.exec(cAttrs);
        if (!refM) continue;
        const colRef = refM[1];
        const typeM = /\bt="([^"]+)"/.exec(cAttrs);
        const cellType = typeM ? typeM[1] : '';

        let val = '';
        if (cellType === 'inlineStr') {
          const tM = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/.exec(cInner);
          val = tM ? decodeXmlEntities(tM[1]) : '';
        } else {
          const vM = /<v>([\s\S]*?)<\/v>/.exec(cInner);
          const rawV = vM ? decodeXmlEntities(vM[1]) : '';
          if (cellType === 's') {
            const ssIdx = parseInt(rawV, 10);
            val = Number.isFinite(ssIdx) ? (sharedStrings[ssIdx] ?? '') : '';
          } else {
            val = rawV;
          }
        }
        cells[colRef] = val;
      }
      rows.push({ rowNumber, cells });
    }
    return rows;
  }

  function getSheetRows(sheetName: string): Record<string, string>[] {
    const matrix = getSheetMatrix(sheetName);
    if (matrix.length === 0) return [];
    const headerRow = matrix[0];
    const colToName: Record<string, string> = {};
    for (const [colRef, headerText] of Object.entries(headerRow.cells)) {
      const trimmed = headerText.trim();
      if (trimmed) {
        colToName[colRef] = trimmed;
      }
    }
    const dataRows: Record<string, string>[] = [];
    for (let i = 1; i < matrix.length; i++) {
      const row = matrix[i];
      const obj: Record<string, string> = {};
      let hasAnyValue = false;
      for (const [colRef, colName] of Object.entries(colToName)) {
        const v = (row.cells[colRef] ?? '').trim();
        obj[colName] = v;
        if (v !== '') hasAnyValue = true;
      }
      if (hasAnyValue) {
        Object.defineProperty(obj, '__xlsxRowNumber', {
          value: row.rowNumber,
          enumerable: false,
          configurable: true,
        });
        dataRows.push(obj);
      }
    }
    return dataRows;
  }

  return {
    sheetNames,
    getSheetRows,
    getSheetMatrix,
  };
}

// Suppress unused helper lint warning if any
void colLettersToIndex;
