/**
 * @platform/core/testing barrel export (`core/src/testing.ts`).
 *
 * Exports test harnesses and mock backends (such as `MockSharePointGraphBackend`)
 * separately from the production `@platform/core` entry point (R23).
 */

export * from './integrations/document-stores/mockSharePointGraph';
