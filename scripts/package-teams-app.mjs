import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const TEAMS_APP_PACKAGE_FILES = [
  'manifest.json',
  'color.png',
  'outline.png',
];

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function computeCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getFixedDosTimestamp() {
  // Deterministic 2026-11-16 00:00:00 UTC DOS date/time so builds are reproducible
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 16;
  return { dosTime, dosDate };
}

export function buildTeamsAppPackageZipBuffer(
  sourceDir = path.join(
    process.cwd(),
    'core',
    'integrations',
    'teams',
    'app-package',
  ),
) {
  const { dosTime, dosDate } = getFixedDosTimestamp();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const fileName of TEAMS_APP_PACKAGE_FILES) {
    const filePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Missing required Teams app package file: ${filePath}`,
      );
    }
    const rawData = fs.readFileSync(filePath);
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const crc = computeCrc32(rawData);
    const nameBytes = Buffer.from(fileName, 'utf8');

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // deflate compression
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(8, 10); // deflate compression
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    localChunks.push(localHeader, compressedData);
    centralChunks.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(TEAMS_APP_PACKAGE_FILES.length, 8);
  eocd.writeUInt16LE(TEAMS_APP_PACKAGE_FILES.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

export function writeTeamsAppPackageZip(options = {}) {
  const sourceDir =
    options.sourceDir ??
    path.join(process.cwd(), 'core', 'integrations', 'teams', 'app-package');
  const outputPath =
    options.outputPath ??
    path.join(
      process.cwd(),
      'dist',
      'teams-app',
      'onesquared-teams-app.zip',
    );
  const zipBuffer = buildTeamsAppPackageZipBuffer(sourceDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zipBuffer);
  return { outputPath, byteLength: zipBuffer.length };
}

const isCli =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const result = writeTeamsAppPackageZip();
  console.log(
    `Packaged Teams app archive: ${result.outputPath} (${result.byteLength} bytes)`,
  );
}
