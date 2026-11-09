import fs from 'node:fs';
import path from 'node:path';

export const COMMITTED_SEED_STORE_REL_PATH = 'data/seed-not-a-law-firm.json';
export const DEFAULT_RUNTIME_STORE_REL_PATH = 'data/runtime-store.json';

export function resolveCommittedSeedStorePath(rootDir = process.cwd()) {
  return path.resolve(rootDir, COMMITTED_SEED_STORE_REL_PATH);
}

export function resolveRuntimeStorePath(
  rootDir = process.cwd(),
  env = process.env,
) {
  const overridePath = env.ONESQUARED_RUNTIME_STORE_PATH?.trim();
  if (overridePath) {
    return path.resolve(rootDir, overridePath);
  }
  return path.resolve(rootDir, DEFAULT_RUNTIME_STORE_REL_PATH);
}

export function loadCommittedSeedStoreRaw(rootDir = process.cwd()) {
  const seedPath = resolveCommittedSeedStorePath(rootDir);
  return fs.readFileSync(seedPath, 'utf8');
}

export function loadCommittedSeedStore(rootDir = process.cwd()) {
  const raw = loadCommittedSeedStoreRaw(rootDir);
  return JSON.parse(raw);
}

export function resetRuntimeStoreFromCommittedSeed(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimePath =
    options.runtimeStorePath ?? resolveRuntimeStorePath(rootDir, options.env);
  const raw = loadCommittedSeedStoreRaw(rootDir);
  const targetDir = path.dirname(runtimePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(runtimePath, raw, 'utf8');
  return JSON.parse(raw);
}
