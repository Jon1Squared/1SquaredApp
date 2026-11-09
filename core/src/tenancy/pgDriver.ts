/**
 * Internal `pg` driver loader isolated strictly within `core/src/tenancy/` (Owner Decision 2).
 *
 * Keeps Next.js `[Client Component Browser]` builds free of Node-only `pg` internals (`net`, `tls`, `dns`)
 * while `pgNodePreload.ts` statically binds `pg` for Next.js server instrumentation and bundled CLI jobs.
 */

import type * as PgTypes from 'pg';

export type PgModule = typeof PgTypes;

let registeredPgModule: PgModule | null = null;

export function registerPgModule(mod: PgModule): void {
  registeredPgModule = mod;
}

export async function loadPgModule(): Promise<PgModule> {
  if (registeredPgModule) {
    return registeredPgModule;
  }
  if (typeof window !== 'undefined') {
    throw new Error(
      'TENANCY_BROWSER_FORBIDDEN: PostgreSQL driver cannot be loaded in a browser runtime.',
    );
  }
  const pgSpecifier = ['p', 'g'].join('');
  const imported = (await import(
    /* webpackIgnore: true */ pgSpecifier
  )) as PgModule & { default?: PgModule };
  const resolved = (
    imported.Pool ? imported : (imported.default ?? imported)
  ) as PgModule;
  registeredPgModule = resolved;
  return resolved;
}
