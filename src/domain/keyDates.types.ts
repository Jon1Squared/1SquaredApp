/**
 * Key Dates & Limitation — domain model re-export (`src/domain/keyDates.types.ts`).
 *
 * Canonical types live in `@platform/core-api` (`core/src/api/keyDates.types.ts`)
 * so that core repositories and host services share a single definition without
 * core importing from `src/`.
 */

export * from '@platform/core-api';
