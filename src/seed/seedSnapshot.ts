import fs from 'node:fs';
import path from 'node:path';
import { createSeedStore, type FirmStore } from '@/server/store';
import {
  COMMITTED_SEED_STORE_REL_PATH,
  DEFAULT_RUNTIME_STORE_REL_PATH,
  loadCommittedSeedStore,
  loadCommittedSeedStoreRaw,
  resetRuntimeStoreFromCommittedSeed,
  resolveCommittedSeedStorePath,
  resolveRuntimeStorePath as resolveRuntimeStorePathMjs,
} from './seedFileLoader.mjs';

export {
  COMMITTED_SEED_STORE_REL_PATH,
  DEFAULT_RUNTIME_STORE_REL_PATH,
  loadCommittedSeedStore,
  loadCommittedSeedStoreRaw,
  resetRuntimeStoreFromCommittedSeed,
  resolveCommittedSeedStorePath,
};

export function resolveRuntimeStorePath(
  rootDir: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveRuntimeStorePathMjs(rootDir, env as NodeJS.ProcessEnv);
}

/**
 * Fixed reference date used to generate the committed demo seed snapshot
 * (`data/seed-not-a-law-firm.json`) so `buildDemoData` and the committed JSON
 * cannot drift.
 */
export const DEMO_SEED_SNAPSHOT_DATE = new Date('2026-11-08T09:00:00.000Z');

export function buildCommittedSeedStoreSnapshot(): FirmStore {
  return createSeedStore(DEMO_SEED_SNAPSHOT_DATE, {
    includeSyntheticEntraOids: true,
  });
}

export function writeCommittedSeedStoreSnapshot(
  rootDir: string = process.cwd(),
): { path: string; store: FirmStore } {
  const store = buildCommittedSeedStoreSnapshot();
  const targetPath = resolveCommittedSeedStorePath(rootDir);
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  return { path: targetPath, store };
}

export function applyEntraObjectIdMapToStore(
  store: FirmStore,
  entraMap: Record<string, string>,
): { mappedCount: number } {
  if (!entraMap || typeof entraMap !== 'object' || Array.isArray(entraMap)) {
    throw new Error('Entra map must be a JSON object mapping person IDs to Entra Object IDs.');
  }

  const personById = new Map(store.people.map((person) => [person.id, person]));
  for (const [personId, oid] of Object.entries(entraMap)) {
    if (!personById.has(personId)) {
      throw new Error(`Entra map references unknown person ID: ${personId}`);
    }
    if (typeof oid !== 'string' || oid.trim().length === 0) {
      throw new Error(`Entra map has an empty or non-string Object ID for person ID: ${personId}`);
    }
  }

  let mappedCount = 0;
  for (const person of store.people) {
    if (Object.prototype.hasOwnProperty.call(entraMap, person.id)) {
      person.entraObjectId = entraMap[person.id]!.trim();
      mappedCount += 1;
    } else {
      delete person.entraObjectId;
    }
  }

  return { mappedCount };
}
