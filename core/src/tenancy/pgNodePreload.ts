/**
 * Server/CLI preload binding `pg` into `pgDriver.ts` (`core/src/tenancy/pgNodePreload.ts`).
 *
 * Imported only by Node server entry points (`src/instrumentation.ts`, `scripts/run-job.ts`,
 * `scripts/import-store-to-postgres.ts`), never by client-facing barrel files.
 */

import * as pg from 'pg';
import { registerPgModule, type PgModule } from './pgDriver';

const rawMod = pg as unknown as PgModule & { default?: PgModule };
const resolved = (rawMod.Pool ? rawMod : (rawMod.default ?? rawMod)) as PgModule;

registerPgModule(resolved);
