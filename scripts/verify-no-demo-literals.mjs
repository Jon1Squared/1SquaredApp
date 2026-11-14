import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const RECORD_ID_RE = /\b(?:P|O|M|TM)-0000\d\d\b/g;
const MATTER_CODE_RE = /\b(?<!#)[A-Z]{3}\d{3}-\d{4}\b/g;
const PMS_HARDCODED_MONTH_RE = /['"`]20\d\d-\d\d['"`]/g;
const FAKE_SANCTIONS_CLEAR_RE =
  /(?:Sanctions\s*(?:&(?:amp;)?|and|\/|\+)\s*PEP|PEP\s*(?:&(?:amp;)?|and|\/|\+)\s*Sanctions)[\s\S]{0,160}?['"`>:\u2013\u2014-](?:[\s\u00A0]|&nbsp;)*(?:all(?:[\s\u00A0]|&nbsp;)+)?clear(?:ed)?\b(?:(?:[\s\u00A0]|&nbsp;)*['"`<])?/gi;

/**
 * Loads PMS client codes and fee-earner codes from `data/pms/1Squared_PMS_Demo_Data.xlsx`.
 */
export function loadPmsDemoCodes(rootDir = process.cwd()) {
  const codes = new Set();
  const workbookPath = path.resolve(rootDir, 'data/pms/1Squared_PMS_Demo_Data.xlsx');
  if (fs.existsSync(workbookPath)) {
    const buf = fs.readFileSync(workbookPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd !== -1) {
      const total = buf.readUInt16LE(eocd + 10);
      let ptr = buf.readUInt32LE(eocd + 16);
      for (let i = 0; i < total; i++) {
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const lh = buf.readUInt32LE(ptr + 42);
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        ptr += 46 + nameLen + extraLen + commentLen;
        if (name === 'xl/sharedStrings.xml') {
          const lhName = buf.readUInt16LE(lh + 26);
          const lhExtra = buf.readUInt16LE(lh + 28);
          const slice = buf.subarray(
            lh + 30 + lhName + lhExtra,
            lh + 30 + lhName + lhExtra + compSize,
          );
          const xml = (method === 8 ? zlib.inflateRawSync(slice) : slice).toString('utf8');
          for (const m of xml.matchAll(/<t(?:\s+[^>]*)?>((?:FE\d{3}|[A-Z]{3}\d{3}))<\/t>/g)) {
            if (m[1]) codes.add(m[1]);
          }
          break;
        }
      }
    }
  }
  return codes;
}

/**
 * Builds the regex matching PMS demo client and fee-earner codes from the prefixes
 * loaded from `data/pms/1Squared_PMS_Demo_Data.xlsx` (`loadPmsDemoCodes()`), without a hand-written prefix list (R375).
 */
export function buildPmsCodeRegex(pmsCodes = loadPmsDemoCodes()) {
  const clientPrefixes = new Set();
  let hasFeeEarnerPrefix = false;
  for (const code of pmsCodes) {
    if (typeof code !== 'string') continue;
    const match = /^([A-Z]{2,3})\d{3}$/.exec(code.trim());
    if (!match) continue;
    if (match[1] === 'FE') {
      hasFeeEarnerPrefix = true;
    } else {
      clientPrefixes.add(match[1]);
    }
  }
  const parts = [];
  if (hasFeeEarnerPrefix) {
    parts.push('FE\\d{3}');
  }
  if (clientPrefixes.size > 0) {
    const alternation = Array.from(clientPrefixes).sort().join('|');
    parts.push(`(?:${alternation})\\d{3}(?!-\\d{4}\\b)`);
  }
  if (parts.length === 0) {
    return null;
  }
  return new RegExp(`\\b(?<!#)(?:${parts.join('|')})\\b`, 'g');
}

/**
 * Builds the deny list of demo literals from `data/seed-not-a-law-firm.json`, `src/seed/demo.ts`, and `data/pms/1Squared_PMS_Demo_Data.xlsx`.
 */
export function buildDemoLiteralsDenyList(rootDir = process.cwd()) {
  const literals = new Set([
    'Not A Law Firm LLP',
    'Not A Law Firm',
    'Pembroke Vaughan',
    'Victoria Pembroke',
    'Marcus Vaughan',
    '42 Lincoln',
    'SRA-612048',
    'OC391042',
    'GB 942 1104 22',
    '7946 0800',
    'Assign to Dafydd',
    '2026-10',
  ]);

  const seedJsonPath = path.resolve(rootDir, 'data/seed-not-a-law-firm.json');
  if (fs.existsSync(seedJsonPath)) {
    const seed = JSON.parse(fs.readFileSync(seedJsonPath, 'utf8'));
    for (const p of seed.people ?? []) {
      const fullName = `${p.firstName ?? ''} ${p.surname ?? ''}`.trim();
      if (fullName.length >= 5) {
        literals.add(fullName);
      }
    }
    for (const o of seed.organisations ?? []) {
      const legalName = (o.legalName ?? '').trim();
      if (legalName.length >= 4) {
        literals.add(legalName);
      }
      const tradingName = (o.tradingName ?? '').trim();
      if (tradingName.length >= 4) {
        literals.add(tradingName);
      }
    }
    for (const m of seed.matters ?? []) {
      const matterNumber = (m.matterNumber ?? '').trim();
      if (matterNumber.length >= 4) {
        literals.add(matterNumber);
      }
    }
  }

  const demoTsPath = path.resolve(rootDir, 'src/seed/demo.ts');
  if (fs.existsSync(demoTsPath)) {
    const demoSource = fs.readFileSync(demoTsPath, 'utf8');
    for (const m of demoSource.matchAll(
      /firstName:\s*['"]([^'"]+)['"]\s*,\s*surname:\s*['"]([^'"]+)['"]/g,
    )) {
      const fullName = `${m[1]} ${m[2]}`.trim();
      if (fullName.length >= 5) {
        literals.add(fullName);
      }
    }
    for (const m of demoSource.matchAll(/legalName:\s*['"]([^'"]+)['"]/g)) {
      const legalName = m[1].trim();
      if (legalName.length >= 4) {
        literals.add(legalName);
      }
    }
    for (const m of demoSource.matchAll(/matterNumber:\s*['"]([^'"]+)['"]/g)) {
      const matterNumber = m[1].trim();
      if (matterNumber.length >= 4) {
        literals.add(matterNumber);
      }
    }
  }

  // Sort longest first so 'Not A Law Firm LLP' is checked before 'Not A Law Firm'
  return [...literals].sort((a, b) => b.length - a.length);
}

/**
 * Loads the allow-list from `scripts/demo-literals-allowlist.json`.
 */
export function loadDemoLiteralsAllowList(rootDir = process.cwd()) {
  const allowPath = path.resolve(rootDir, 'scripts/demo-literals-allowlist.json');
  if (!fs.existsSync(allowPath)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

function isAllowListed(allowList, file, literal) {
  if (!literal || literal === 'Sanctions & PEP: Clear' || literal === '*') {
    return false;
  }
  const normalizedFile = file.replace(/\\/g, '/');
  return allowList.some(
    (entry) =>
      entry &&
      typeof entry.file === 'string' &&
      entry.file.trim().length > 0 &&
      entry.file.replace(/\\/g, '/') === normalizedFile &&
      typeof entry.literal === 'string' &&
      entry.literal.trim().length > 0 &&
      entry.literal !== 'Sanctions & PEP: Clear' &&
      entry.literal !== '*' &&
      entry.literal === literal &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0,
  );
}

/**
 * Scans a single file's text for denied demo literals, record IDs, matter/PMS codes, and fake Sanctions & PEP Clear status.
 */
export function scanTextForDemoLiterals(
  file,
  text,
  denyLiterals,
  allowList = [],
  pmsCodes = loadPmsDemoCodes(),
) {
  const violations = [];
  const pmsCodeRegex = buildPmsCodeRegex(pmsCodes);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const reportedOnLine = new Set();

    const recordViolation = (match, reason) => {
      if (reportedOnLine.has(match)) return;
      reportedOnLine.add(match);
      violations.push({
        file,
        line: lineNo,
        match,
        reason,
      });
    };

    for (const lit of denyLiterals) {
      if (line.includes(lit) && !isAllowListed(allowList, file, lit)) {
        // Avoid substring match when a shorter literal is part of an already-reported longer literal on the same line
        if ([...reportedOnLine].some((prev) => prev.includes(lit))) {
          continue;
        }
        recordViolation(lit, `demo literal "${lit}"`);
      }
    }

    for (const idMatch of line.matchAll(RECORD_ID_RE)) {
      const token = idMatch[0];
      if (!isAllowListed(allowList, file, token)) {
        recordViolation(token, `seed record ID "${token}"`);
      }
    }

    for (const matterCodeMatch of line.matchAll(MATTER_CODE_RE)) {
      const token = matterCodeMatch[0];
      if (!isAllowListed(allowList, file, token)) {
        recordViolation(token, `matter code "${token}"`);
      }
    }

    if (pmsCodeRegex) {
      for (const pmsCodeMatch of line.matchAll(pmsCodeRegex)) {
        const token = pmsCodeMatch[0];
        if (!isAllowListed(allowList, file, token)) {
          const label = pmsCodes.has(token) ? `PMS demo code "${token}"` : `PMS-style code "${token}"`;
          recordViolation(token, label);
        }
      }
    }

    if (file.replace(/\\/g, '/').endsWith('src/domain/pms.ts')) {
      for (const monthMatch of line.matchAll(PMS_HARDCODED_MONTH_RE)) {
        const token = monthMatch[0];
        if (!isAllowListed(allowList, file, token)) {
          recordViolation(token, `hard-coded month literal ${token} in pms.ts`);
        }
      }
    }
  }

  for (const sanctionsMatch of text.matchAll(FAKE_SANCTIONS_CLEAR_RE)) {
    const matchedSnippet = sanctionsMatch[0].trim();
    if (!isAllowListed(allowList, file, matchedSnippet)) {
      const prefix = text.slice(0, sanctionsMatch.index ?? 0);
      const lineNo = prefix.split(/\r?\n/).length;
      violations.push({
        file,
        line: lineNo,
        match: matchedSnippet,
        reason: `"Sanctions/PEP" next to "Clear": ${matchedSnippet}`,
      });
    }
  }

  return violations;
}

/**
 * Scans git-tracked files under `src/components/` and `src/domain/`, excluding `*.test.ts` and `__tests__/`.
 */
export function verifyNoDemoLiterals(rootDir = process.cwd()) {
  const denyLiterals = buildDemoLiteralsDenyList(rootDir);
  const allowList = loadDemoLiteralsAllowList(rootDir);
  const pmsCodes = loadPmsDemoCodes(rootDir);

  const trackedFiles = execFileSync(
    'git',
    ['ls-files', 'src/components/', 'src/domain/'],
    {
      cwd: rootDir,
      encoding: 'utf8',
    },
  )
    .split(/\r?\n/)
    .filter(
      (f) =>
        f &&
        /\.(ts|tsx|js|jsx)$/i.test(f) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx') &&
        !f.includes('__tests__/'),
    );

  const violations = [];
  for (const relFile of trackedFiles) {
    const fullPath = path.resolve(rootDir, relFile);
    if (!fs.existsSync(fullPath)) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    violations.push(
      ...scanTextForDemoLiterals(relFile, text, denyLiterals, allowList, pmsCodes),
    );
  }

  return violations;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const violations = verifyNoDemoLiterals();
  if (violations.length > 0) {
    console.error(
      'ERROR: Demo literals found in product code:\n' +
        violations
          .map((v) => `  ${v.file}:${v.line}: ${v.reason}`)
          .join('\n'),
    );
    process.exit(1);
  }
}
