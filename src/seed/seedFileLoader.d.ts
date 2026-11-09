import type { FirmStore } from '@/server/store';

export const COMMITTED_SEED_STORE_REL_PATH: string;
export const DEFAULT_RUNTIME_STORE_REL_PATH: string;

export function resolveCommittedSeedStorePath(rootDir?: string): string;
export function resolveRuntimeStorePath(
  rootDir?: string,
  env?: Partial<NodeJS.ProcessEnv>,
): string;
export function loadCommittedSeedStoreRaw(rootDir?: string): string;
export function loadCommittedSeedStore(rootDir?: string): FirmStore;
export function resetRuntimeStoreFromCommittedSeed(options?: {
  rootDir?: string;
  runtimeStorePath?: string;
  env?: Partial<NodeJS.ProcessEnv>;
}): FirmStore;
