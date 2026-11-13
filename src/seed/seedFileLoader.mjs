import fs from 'node:fs';
import path from 'node:path';

export const COMMITTED_SEED_STORE_REL_PATH = 'data/seed-not-a-law-firm.json';

export function resolveCommittedSeedStorePath(rootDir = process.cwd()) {
  return path.resolve(rootDir, COMMITTED_SEED_STORE_REL_PATH);
}

export function loadCommittedSeedStoreRaw(rootDir = process.cwd()) {
  const seedPath = resolveCommittedSeedStorePath(rootDir);
  return fs.readFileSync(seedPath, 'utf8');
}

export function loadCommittedSeedStore(rootDir = process.cwd()) {
  const raw = loadCommittedSeedStoreRaw(rootDir);
  return JSON.parse(raw);
}
