import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('S0-01: no client secrets or hard-coded API keys in src/', () => {
  it('contains no NEXT_PUBLIC_ variable with KEY, SECRET or TOKEN, and no Ideal Postcodes or Anthropic key literals', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const files = collectSourceFiles(srcDir);

    const nextPublicSecretPattern =
      /\bNEXT_PUBLIC_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)[A-Z0-9_]*\b/;
    const idealPostcodesKeyPattern = new RegExp(
      '\\b' + 'ak' + '_[A-Za-z0-9]{10,}\\b',
    );
    const anthropicKeyPattern = new RegExp(
      '\\b' + 'sk-ant' + '-[A-Za-z0-9_-]*',
    );

    const violations: string[] = [];

    for (const filePath of files) {
      const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
      if (relPath === 'src/server/__tests__/noClientSecrets.test.ts') {
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf8');

      const nextPublicMatch = content.match(nextPublicSecretPattern);
      if (nextPublicMatch) {
        violations.push(
          `${relPath}: forbidden client env var ${nextPublicMatch[0]}`,
        );
      }

      const akMatch = content.match(idealPostcodesKeyPattern);
      if (akMatch) {
        violations.push(`${relPath}: hard-coded Ideal Postcodes key literal`);
      }

      const skAntMatch = content.match(anthropicKeyPattern);
      if (skAntMatch) {
        violations.push(`${relPath}: Anthropic key literal`);
      }
    }

    expect(violations).toEqual([]);
  });
});
