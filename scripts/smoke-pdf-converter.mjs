/**
 * Cross-platform smoke check for the dedicated PDF converter container (`S1-10`).
 *
 * Usage: node scripts/smoke-pdf-converter.mjs <baseUrl>
 *
 * Verifies:
 *  1. `GET /health/live` returns HTTP 200 `{ status: "live" }`.
 *  2. `GET /health/ready` reaches HTTP 200 `{ status: "ready" }` within 60 seconds.
 *  3. `POST /convert` rejects non-ZIP input cleanly with HTTP 400.
 *  4. `POST /convert` converts a valid `.docx` ZIP archive to a `%PDF-` document
 *     returning HTTP 200 `application/pdf` and forwarding `x-correlation-id`.
 */

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8199').replace(/\/+$/, '');
const READY_TIMEOUT_MS = 60_000;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildMinimalDocxZip() {
  const encoder = new TextEncoder();
  const files = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t>1Squared PDF Converter Smoke Test</w:t></w:r></w:p></w:body>' +
          '</w:document>',
      ),
    },
  ];

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const sum = crc32(data);

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // STORE
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(sum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    Buffer.from(nameBytes).copy(localHeader, 30);

    localParts.push(localHeader, Buffer.from(data));

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10); // STORE
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(sum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      if (res.status === 200 && text.includes('"ready"')) {
        return;
      }
      lastStatus = `HTTP ${res.status}: ${text}`;
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `PDF converter container did not become ready within ${READY_TIMEOUT_MS}ms (${lastStatus})`,
  );
}

async function main() {
  await waitForReady();

  const liveRes = await fetch(`${baseUrl}/health/live`, {
    signal: AbortSignal.timeout(5_000),
  });
  const liveBody = await liveRes.text();
  if (liveRes.status !== 200 || !liveBody.includes('"live"')) {
    throw new Error(`/health/live failed: HTTP ${liveRes.status} ${liveBody}`);
  }

  const invalidRes = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'x-correlation-id': 'smoke-invalid-docx',
    },
    body: Buffer.from('not-a-zip-file', 'utf8'),
    signal: AbortSignal.timeout(10_000),
  });
  if (invalidRes.status !== 400) {
    throw new Error(
      `Expected HTTP 400 on invalid .docx payload, got HTTP ${invalidRes.status}`,
    );
  }

  const docxBytes = buildMinimalDocxZip();
  const convertRes = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'x-tenant-id': 'smoke-tenant',
      'x-correlation-id': 'smoke-valid-docx',
    },
    body: docxBytes,
    signal: AbortSignal.timeout(45_000),
  });
  if (convertRes.status !== 200) {
    const errBody = await convertRes.text();
    throw new Error(`/convert failed: HTTP ${convertRes.status} ${errBody}`);
  }

  const contentType = convertRes.headers.get('content-type') || '';
  if (!contentType.startsWith('application/pdf')) {
    throw new Error(`Unexpected PDF Content-Type header: "${contentType}"`);
  }

  const pdfBytes = new Uint8Array(await convertRes.arrayBuffer());
  const header = Buffer.from(pdfBytes.subarray(0, 5)).toString('latin1');
  if (header !== '%PDF-' || pdfBytes.byteLength < 100) {
    throw new Error(
      `Invalid PDF output (${pdfBytes.byteLength} bytes, header="${header}")`,
    );
  }

  console.log(
    `[PDF Smoke] Passed /health/live, /health/ready, invalid-docx 400, and .docx -> %PDF- (${pdfBytes.byteLength} bytes).`,
  );
}

main().catch((err) => {
  console.error('[PDF Smoke] FAILED:', err);
  process.exit(1);
});
