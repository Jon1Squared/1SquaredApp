import type { FirmStore } from './seedStoreBuilder';

export const COMMITTED_SEED_STORE_REL_PATH: string;

export function resolveCommittedSeedStorePath(rootDir?: string): string;
export function loadCommittedSeedStoreRaw(rootDir?: string): string;
export function loadCommittedSeedStore(rootDir?: string): FirmStore;
