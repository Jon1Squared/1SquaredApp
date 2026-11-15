import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function collectCodeFiles(dir: string, ignoreDirs: ReadonlySet<string> = new Set()): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectCodeFiles(fullPath, ignoreDirs));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') ||
        entry.name.endsWith('.tsx') ||
        entry.name.endsWith('.mts') ||
        entry.name.endsWith('.mjs'))
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('S0-20: Permanent retirement of transitional JSON store, SQLite PMS cache, firebase-admin, and bridge schema artefacts', () => {
  it('deletes retired transitional store files, SQLite PMS cache, store-import CLI script, and runtime-store.json', () => {
    const retiredPaths = [
      'src/server/store.ts',
      'src/server/storeLock.ts',
      'src/server/auditAdapter.ts',
      'src/server/recordDeltaCompensator.ts',
      'scripts/import-store-to-postgres.ts',
      'data/pms/pms-demo.sqlite',
      'data/runtime-store.json',
    ];

    for (const relPath of retiredPaths) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, relPath)),
        `${relPath} must not exist`,
      ).toBe(false);
    }

    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/seed/seedStoreBuilder.ts')),
      'src/seed/seedStoreBuilder.ts must exist as the pure seed store builder',
    ).toBe(true);
  });

  it('removes firebase-admin and db:import from package.json', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkgJson.dependencies?.['firebase-admin']).toBeUndefined();
    expect(pkgJson.devDependencies?.['firebase-admin']).toBeUndefined();
    expect(pkgJson.scripts?.['db:import']).toBeUndefined();
  });

  it('contains zero references to retired JSON store APIs, SQLite PMS source, or runtime-store.json across src/ and core/src/', () => {
    const files = [
      ...collectCodeFiles(path.join(REPO_ROOT, 'src'), new Set(['docs'])),
      ...collectCodeFiles(path.join(REPO_ROOT, 'core', 'src')),
    ];

    const forbiddenPatterns: ReadonlyArray<{ label: string; regex: RegExp }> = [
      { label: 'getStore(', regex: /(?<!\.)\bgetStore\s*\((?!\)\s*:)/ },
      { label: 'saveStore(', regex: /\bsaveStore\s*\(/ },
      { label: 'withJsonStoreWriteLock', regex: /\bwithJsonStoreWriteLock\b/ },
      {
        label: 'runUnmigratedJsonMutationWithAudit',
        regex: /\brunUnmigratedJsonMutationWithAudit\b/,
      },
      { label: 'RecordDeltaCompensator', regex: /\bRecordDeltaCompensator\b/ },
      { label: 'DemoDbPmsSource', regex: /\bDemoDbPmsSource\b/ },
      { label: 'pms-demo.sqlite', regex: /pms-demo\.sqlite/ },
      { label: 'runtime-store.json', regex: /runtime-store\.json/ },
      { label: 'trySyncToFirestore', regex: /\btrySyncToFirestore\b/ },
      { label: '@/server/store', regex: /['"]@\/server\/store['"]/ },
    ];

    for (const filePath of files) {
      const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      const content = fs.readFileSync(filePath, 'utf8');
      for (const { label, regex } of forbiddenPatterns) {
        expect(
          regex.test(content),
          `${relPath} must not reference ${label}`,
        ).toBe(false);
      }
    }
  });

  it('contains zero runtime reads or writes to people.employment_json or matter_restriction_metadata outside historical migrations', () => {
    const files = [
      ...collectCodeFiles(path.join(REPO_ROOT, 'src'), new Set(['docs'])),
      ...collectCodeFiles(path.join(REPO_ROOT, 'core', 'src')),
    ];

    for (const filePath of files) {
      const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (relPath === 'core/src/tenancy/migrations/index.ts') {
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      expect(
        content.includes('matter_restriction_metadata'),
        `${relPath} must not reference retired table matter_restriction_metadata`,
      ).toBe(false);
      expect(
        /people\.employment_json|p\.employment_json/.test(content),
        `${relPath} must not reference retired column people.employment_json`,
      ).toBe(false);
    }
  });

  it('marks ADR 0001 as Superseded by ADR 0028 and ADR 0026 and aligns slice plan S0-20 with migration 0015', () => {
    const adr0001 = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/decisions/0001-shared-repo-and-transitional-store.md'),
      'utf8',
    );
    expect(adr0001).toContain(
      'Superseded by ADR 0028 (runtime persistence) and ADR 0026 (demo seeding)',
    );

    const sliceDoc = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/roadmap/slices/s0-20-retire-json-store.md'),
      'utf8',
    );
    expect(sliceDoc).toContain('0015_transitional_bridges_contract');
    expect(sliceDoc).not.toContain('0014_transitional_bridges_contract');
  });
});
