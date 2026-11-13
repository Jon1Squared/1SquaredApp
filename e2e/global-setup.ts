import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_TEST_AUTH_SECRET } from '../playwright.config';
import { resetRuntimeStoreFromCommittedSeed } from '../src/seed/seedFileLoader.mjs';
import type { EntraSessionPayload } from '../src/server/entraAuth';

/**
 * Playwright global setup (Slice S0-27).
 *
 * 1. Restores `data/seed-not-a-law-firm.json` into `data/runtime-store.json` so
 *    every test run starts from deterministic invented fixture data.
 * 2. Mints HMAC-SHA256 signed `onesquared_entra_session` cookies in test code
 *    only (matching `signPayload` in `src/server/entraAuth.ts`) and writes one
 *    Playwright storageState file per role under `e2e/.auth/`.
 *
 * Note: `supervisor` and `intake` have no seeded holder in
 * `data/seed-not-a-law-firm.json` and are omitted from the 8 role journeys.
 */

const ENTRA_SESSION_COOKIE = 'onesquared_entra_session';
const AUTH_DIR = path.join(process.cwd(), 'e2e', '.auth');

export interface RoleSeedActor {
  readonly stateKey: string;
  readonly roleKey: string;
  readonly personId: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly email: string;
  readonly oid: string;
  readonly mappedRoles: string[];
  readonly mfaVerified: boolean;
}

export const ROLE_SEED_ACTORS: readonly RoleSeedActor[] = [
  {
    stateKey: 'fee_earner',
    roleKey: 'fee_earner',
    personId: 'P-000002',
    displayName: 'Dafydd Evans',
    firstName: 'Dafydd',
    email: 'dafydd.evans@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000002',
    mappedRoles: ['fee_earner'],
    mfaVerified: false,
  },
  {
    stateKey: 'partner',
    roleKey: 'partner',
    personId: 'P-000001',
    displayName: 'Rhian Morgan',
    firstName: 'Rhian',
    email: 'rhian.morgan@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000001',
    mappedRoles: ['partner', 'fee_earner'],
    mfaVerified: false,
  },
  {
    stateKey: 'legal_secretary',
    roleKey: 'legal_secretary',
    personId: 'P-000010',
    displayName: 'Nia Edwards',
    firstName: 'Nia',
    email: 'nia.edwards@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000010',
    mappedRoles: ['legal_secretary', 'enquiries_coordinator'],
    mfaVerified: false,
  },
  {
    stateKey: 'enquiries_coordinator',
    roleKey: 'enquiries_coordinator',
    personId: 'P-000042',
    displayName: 'Lowri Ellis',
    firstName: 'Lowri',
    email: 'lowri.ellis@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000042',
    mappedRoles: ['enquiries_coordinator'],
    mfaVerified: false,
  },
  {
    stateKey: 'finance',
    roleKey: 'finance',
    personId: 'P-000009',
    displayName: 'Gethin Powell',
    firstName: 'Gethin',
    email: 'gethin.powell@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000009',
    mappedRoles: ['finance'],
    mfaVerified: false,
  },
  {
    stateKey: 'risk_compliance',
    roleKey: 'risk_compliance',
    personId: 'P-000003',
    displayName: 'Bethan Rees',
    firstName: 'Bethan',
    email: 'bethan.rees@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000003',
    mappedRoles: ['risk_compliance', 'fee_earner', 'partner'],
    mfaVerified: false,
  },
  {
    stateKey: 'managing_partner',
    roleKey: 'managing_partner',
    personId: 'P-000038',
    displayName: 'Gethin Lloyd',
    firstName: 'Gethin',
    email: 'gethin.lloyd@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000038',
    mappedRoles: ['managing_partner', 'partner'],
    mfaVerified: false,
  },
  {
    stateKey: 'admin',
    roleKey: 'admin',
    personId: 'P-000004',
    displayName: 'Huw Pritchard',
    firstName: 'Huw',
    email: 'huw.pritchard@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000004',
    mappedRoles: [
      'admin',
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
    ],
    mfaVerified: true,
  },
  {
    stateKey: 'admin_no_mfa',
    roleKey: 'admin',
    personId: 'P-000004',
    displayName: 'Huw Pritchard',
    firstName: 'Huw',
    email: 'huw.pritchard@notalawfirm.example',
    oid: '00000000-0000-4000-8000-000000000004',
    mappedRoles: [
      'admin',
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
    ],
    mfaVerified: false,
  },
];

function signEntraSessionPayloadForTest(
  payload: EntraSessionPayload,
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const sig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function storageStatePathFor(stateKey: string): string {
  return path.join(AUTH_DIR, `${stateKey}.json`);
}

export default async function globalSetup(): Promise<void> {
  const rootDir = process.cwd();

  // Reset runtime store from seed data before the test run via the shared seed loader
  resetRuntimeStoreFromCommittedSeed({ rootDir });
  execFileSync(
    process.execPath,
    [path.join(rootDir, 'dist', 'jobs', 'import-store.mjs'), '--clear'],
    {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PLATFORM_TENANT_PACKAGE_DIR: 'client-not-a-law-firm',
        PLATFORM_ENVIRONMENT: 'test',
        PLATFORM_POSTGRES_HOST:
          process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1',
        PLATFORM_POSTGRES_PORT: process.env.PLATFORM_POSTGRES_PORT || '5432',
        PLATFORM_POSTGRES_MIGRATE_PORT:
          process.env.PLATFORM_POSTGRES_MIGRATE_PORT || '5432',
        // Throwaway local/CI cluster credentials (R435): core has no built-in passwords.
        PLATFORM_POSTGRES_RUNTIME_PASSWORD:
          process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD ||
          'onesquared_local_runtime',
        PLATFORM_POSTGRES_MIGRATE_PASSWORD:
          process.env.PLATFORM_POSTGRES_MIGRATE_PASSWORD ||
          'onesquared_local_migrate',
      },
    },
  );

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const nowMs = Date.now();
  const authenticatedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString();

  for (const actor of ROLE_SEED_ACTORS) {
    const payload: EntraSessionPayload = {
      personId: actor.personId,
      tenantId: 'not-a-law-firm',
      oid: actor.oid,
      tid: '00000000-0000-4000-8000-000000000099',
      sub: actor.personId,
      email: actor.email,
      displayName: actor.displayName,
      mappedRoles: actor.mappedRoles,
      entraRoles: [],
      entraGroups: [],
      mfaVerified: actor.mfaVerified,
      amr: actor.mfaVerified ? ['pwd', 'mfa'] : ['pwd'],
      authenticatedAt,
      expiresAt,
    };

    const signedCookieValue = signEntraSessionPayloadForTest(
      payload,
      E2E_TEST_AUTH_SECRET,
    );

    const storageState = {
      cookies: [
        {
          name: ENTRA_SESSION_COOKIE,
          value: signedCookieValue,
          domain: 'localhost',
          path: '/',
          expires: Math.floor((nowMs + 8 * 60 * 60 * 1000) / 1000),
          httpOnly: true,
          secure: false,
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    };

    fs.writeFileSync(
      storageStatePathFor(actor.stateKey),
      JSON.stringify(storageState, null, 2),
      'utf8',
    );
  }
}
