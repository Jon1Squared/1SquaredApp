import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RECORD_ID_RE = /\b(?:P|O|M|TM)-0000\d\d\b/;
const FAKE_SANCTIONS_CLEAR_RE =
  /Sanctions\s*&\s*PEP(?![\s\S]{0,160}resolvePersonComplianceDisplay|[\s\S]{0,160}resolveOrganisationComplianceDisplay)[\s\S]{0,160}?['"`]Clear['"`]/;

/**
 * Builds the deny list of demo literals from `data/seed-not-a-law-firm.json` and `src/seed/demo.ts`.
 */
export function buildDemoLiteralsDenyList(rootDir = process.cwd()) {
  const literals = new Set([
    'Not A Law Firm LLP',
    'Not A Law Firm',
    'Pembroke Vaughan',
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
  const normalizedFile = file.replace(/\\/g, '/');
  return allowList.some(
    (entry) =>
      entry &&
      typeof entry.file === 'string' &&
      entry.file.replace(/\\/g, '/') === normalizedFile &&
      entry.literal === literal &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0,
  );
}

/**
 * Scans a single file's text for denied demo literals, record IDs, and fake Sanctions & PEP Clear status.
 */
export function scanTextForDemoLiterals(
  file,
  text,
  denyLiterals,
  allowList = [],
) {
  const violations = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const lit of denyLiterals) {
      if (line.includes(lit) && !isAllowListed(allowList, file, lit)) {
        violations.push({
          file,
          line: lineNo,
          match: lit,
          reason: `demo literal "${lit}"`,
        });
        break;
      }
    }

    const idMatch = line.match(RECORD_ID_RE);
    if (idMatch && !isAllowListed(allowList, file, idMatch[0])) {
      violations.push({
        file,
        line: lineNo,
        match: idMatch[0],
        reason: `seed record ID "${idMatch[0]}"`,
      });
    }
  }

  const sanctionsMatch = text.match(FAKE_SANCTIONS_CLEAR_RE);
  if (
    sanctionsMatch &&
    !isAllowListed(allowList, file, 'Sanctions & PEP: Clear')
  ) {
    const prefix = text.slice(0, sanctionsMatch.index ?? 0);
    const lineNo = prefix.split(/\r?\n/).length;
    violations.push({
      file,
      line: lineNo,
      match: 'Sanctions & PEP: Clear',
      reason: '"Sanctions & PEP" next to "Clear"',
    });
  }

  return violations;
}

/**
 * Scans git-tracked files under `src/components/` and `src/domain/`, excluding `*.test.ts` and `__tests__/`.
 */
export function verifyNoDemoLiterals(rootDir = process.cwd()) {
  const denyLiterals = buildDemoLiteralsDenyList(rootDir);
  const allowList = loadDemoLiteralsAllowList(rootDir);

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
      ...scanTextForDemoLiterals(relFile, text, denyLiterals, allowList),
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
