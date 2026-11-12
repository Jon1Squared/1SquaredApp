/**
 * Test-only helpers for asserting against the PostgreSQL firm audit log (`audit_entries`, S0-15)
 * and the tenant key-date repository from Vitest suites, and for setting explicit verified actor
 * sessions in unit and integration tests (`R445`).
 *
 * `audit_entries` is append-only and shared across test runs, so assertions must never assume an
 * empty table. `markAuditPosition()` records the last audit number written so far; every entry written
 * afterwards has a strictly greater `AU-` number, which lets tests isolate the rows a single action produced.
 */
import {
  TenantAuditRepository,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type TenantContext,
} from '@platform/core';
import { resolveEmployeeRoles } from '../../domain/homeConfig';
import { personDisplayName } from '../../domain/names';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
} from '../../platform/tenantRuntime';
import { runWithActiveActorSession } from '../rbacRuntime';
import {
  getAuditRepository,
  setAuditRepositoryOverrideForTesting,
} from '../auditAdapter';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
  type EntraSessionPayload,
  type VerifiedEntraSessionPayload,
} from '../entraAuth';
import {
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getKeyDateRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
} from '../services';
import { getStore } from '../store';
import { loadCommittedSeedStore } from '../../seed/seedSnapshot';
import type { Person, Team } from '../../domain/types';

let committedSeedPeopleCache: readonly Person[] | null = null;
let committedSeedTeamsCache: readonly Team[] | null = null;
function findCommittedSeedPerson(actorId: string): Person | null {
  if (!committedSeedPeopleCache) {
    const seed = loadCommittedSeedStore();
    committedSeedPeopleCache = seed.people;
    committedSeedTeamsCache = seed.teams;
  }
  return committedSeedPeopleCache.find((p) => p.id === actorId) ?? null;
}
function getCommittedSeedTeams(): readonly Team[] {
  if (!committedSeedTeamsCache) {
    const seed = loadCommittedSeedStore();
    committedSeedPeopleCache = seed.people;
    committedSeedTeamsCache = seed.teams;
  }
  return committedSeedTeamsCache;
}

export type AuditAdapterTestFailureHook = (params: {
  ctx: TenantContext;
  entries: readonly FirmAuditEntryInput[];
}) => Promise<void> | void;

let baseAuditRepoBeforeTestStub: TenantAuditRepository | null = null;

function assertTestEnvironment(callerName: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `SECURITY_ERROR: ${callerName} is only permitted when NODE_ENV === "test".`,
    );
  }
}

/**
 * Test-only helper (`R450`) that replaces `global.__oneSquaredAuditRepo` with a delegating
 * `TenantAuditRepository` stub whose `appendAuditEntries` / `appendAuditEntry` run `hook`
 * before delegating to the real repository, and restores the real repository when passed `null`.
 */
export function setAuditAdapterFailureHookForTesting(
  hook: AuditAdapterTestFailureHook | null,
): void {
  assertTestEnvironment('setAuditAdapterFailureHookForTesting');
  if (!hook) {
    if (baseAuditRepoBeforeTestStub) {
      setAuditRepositoryOverrideForTesting(null);
      baseAuditRepoBeforeTestStub = null;
    }
    return;
  }
  const delegate =
    baseAuditRepoBeforeTestStub ?? getAuditRepository();
  baseAuditRepoBeforeTestStub = delegate;

  const stub = Object.create(delegate) as TenantAuditRepository;
  stub.appendAuditEntries = async (
    ctx: TenantContext,
    entries: readonly FirmAuditEntryInput[],
  ): Promise<FirmAuditEntryRecord[]> => {
    await hook({ ctx, entries });
    return delegate.appendAuditEntries(ctx, entries);
  };
  stub.appendAuditEntry = async (
    ctx: TenantContext,
    entry: FirmAuditEntryInput,
  ): Promise<FirmAuditEntryRecord> => {
    await hook({ ctx, entries: [entry] });
    return delegate.appendAuditEntry(ctx, entry);
  };
  setAuditRepositoryOverrideForTesting(stub);
}

export interface TestActorSessionOptions {
  mfaVerified?: boolean;
  roles?: readonly string[];
  tenantId?: string;
  email?: string;
  displayName?: string;
  oid?: string;
  correlationId?: string;
}

/**
 * Builds a test `EntraSessionPayload` for an explicit `actorId` (`R445`).
 * Roles are resolved from the employee's record in `getStore()` unless explicitly overridden;
 * unknown actors receive `[]` (never a fallback `['admin']`).
 */
export function buildTestEntraSessionPayload(
  actorId: string,
  options?: TestActorSessionOptions,
): EntraSessionPayload {
  assertTestEnvironment('buildTestEntraSessionPayload');
  const cleanActorId = actorId?.trim();
  if (!cleanActorId) {
    throw new Error(
      'TEST_ACTOR_REQUIRED: buildTestEntraSessionPayload requires an explicit non-empty actorId (R445).',
    );
  }
  const tenantConfig = getActiveTenantConfiguration();
  const store = getStore();
  const person =
    store.people.find((p) => p.id === cleanActorId) ??
    findCommittedSeedPerson(cleanActorId);
  const roles = options?.roles
    ? [...options.roles]
    : person
      ? resolveEmployeeRoles(
          person,
          store.teams.length > 0 ? store.teams : [...getCommittedSeedTeams()],
        )
      : [];
  const email =
    options?.email?.trim() ||
    person?.emails?.find((e) => e.isPrimary)?.address ||
    person?.emails?.[0]?.address ||
    `${cleanActorId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@${tenantConfig.branding.primaryDomain}`;
  const displayName =
    options?.displayName?.trim() ||
    (person ? personDisplayName(person) : cleanActorId);
  const hexSuffix = cleanActorId
    .replace(/[^a-fA-F0-9]/g, '0')
    .padStart(12, '0')
    .slice(-12);
  const oid =
    options?.oid?.trim() ||
    person?.entraObjectId?.trim() ||
    `00000000-0000-4000-8000-${hexSuffix}`;
  const mfaVerified = options?.mfaVerified ?? true;
  const now = Date.now();
  return {
    personId: cleanActorId,
    tenantId: options?.tenantId?.trim() || tenantConfig.tenantId,
    oid,
    tid: '11111111-2222-3333-4444-555555555555',
    sub: cleanActorId,
    email,
    displayName,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified,
    amr: mfaVerified ? ['pwd', 'mfa'] : ['pwd'],
    authenticatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
  };
}

export function makeVerifiedTestEntraSession(
  actorId: string,
  options?: TestActorSessionOptions,
): VerifiedEntraSessionPayload {
  const payload = buildTestEntraSessionPayload(actorId, options);
  const signed = createSignedEntraSessionCookie(payload);
  const verified = verifySignedEntraSessionCookie(signed);
  if (!verified) {
    throw new Error(
      `Failed to verify signed test Entra session cookie for actor "${actorId}".`,
    );
  }
  return verified;
}

export function setTestActorSession(
  actorId: string | null,
  options?: TestActorSessionOptions,
): void {
  assertTestEnvironment('setTestActorSession');
  if (actorId === null) {
    setTestEntraSessionOverride(null);
    return;
  }
  setTestEntraSessionOverride(buildTestEntraSessionPayload(actorId, options));
}

export function runAsTestActor<R>(
  actorId: string,
  fn: () => Promise<R> | R,
  options?: TestActorSessionOptions,
): Promise<R> | R {
  const verifiedSession = makeVerifiedTestEntraSession(actorId, options);
  return runWithActiveActorSession(
    {
      tenantId: verifiedSession.tenantId,
      personId: verifiedSession.personId,
      tokenRoles: verifiedSession.mappedRoles,
      expiresAtMs: new Date(verifiedSession.expiresAt).getTime(),
      verifiedSession,
      ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
    },
    fn,
  );
}

export function testTenantCtx(
  actorId: string,
  overrides?: { mfaVerified?: boolean; roles?: readonly string[] },
): TenantContext {
  const verifiedSession = makeVerifiedTestEntraSession(actorId, overrides);
  return resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verifiedSession),
  );
}

function auditInspectorTenantCtx(): TenantContext {
  const verifiedSession = makeVerifiedTestEntraSession(
    'system:audit-test-inspector',
    { roles: [], mfaVerified: false },
  );
  return resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verifiedSession),
  );
}

function auditNumber(id: string): number {
  const match = /^AU-(\d+)$/.exec(id);
  return match?.[1] ? Number.parseInt(match[1], 10) : -1;
}

/**
 * Advances `tenant_audit_id_seq` by one via `allocateNextAuditId` (`nextval`) and returns the number
 * immediately preceding that reserved sequence value (`id - 1`), so every entry written afterwards
 * has a strictly greater `AU-` number.
 */
export async function markAuditPosition(): Promise<number> {
  const id = await getAuditRepository().allocateNextAuditId(
    auditInspectorTenantCtx(),
  );
  return auditNumber(id) - 1;
}

/** All audit entries for one record (unfiltered by viewer permissions), newest first. */
export async function auditEntriesForRecord(
  recordType: string,
  recordId: string,
  since?: number,
): Promise<FirmAuditEntryRecord[]> {
  const rows = await getAuditRepository().listAuditEntriesForRecord(
    auditInspectorTenantCtx(),
    recordType,
    recordId,
    { limit: 1000 },
  );
  return since === undefined ? rows : rows.filter((r) => auditNumber(r.id) > since);
}

/** Firm-wide audit entries written after `since` (unfiltered by viewer permissions). */
export async function auditEntriesSince(since: number): Promise<FirmAuditEntryRecord[]> {
  const ctx = auditInspectorTenantCtx();
  const out: FirmAuditEntryRecord[] = [];
  let beforeSeq: number | undefined;
  // Entries are ordered by `seq DESC` (R451), so scan pages fully.
  for (let i = 0; i < 50; i++) {
    const page = await getAuditRepository().listFirmAuditEntriesPage(ctx, {
      limit: 2000,
      beforeSeq,
    });
    out.push(...page.entries.filter((r) => auditNumber(r.id) > since));
    if (page.nextBeforeSeq === null) break;
    beforeSeq = page.nextBeforeSeq;
  }
  return out;
}

/**
 * Firm-wide audit entries whose server write time (`at`) is at or after `sinceMs`. Use this when the
 * test calls `resetAllDemoData` between taking the mark and acting, because the demo reset re-imports
 * `audit_entries` and restarts the AU- sequence, which invalidates ID-based marks.
 */
export async function auditEntriesWrittenSince(sinceMs: number): Promise<FirmAuditEntryRecord[]> {
  const ctx = auditInspectorTenantCtx();
  const out: FirmAuditEntryRecord[] = [];
  let beforeSeq: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await getAuditRepository().listFirmAuditEntriesPage(ctx, {
      limit: 2000,
      beforeSeq,
    });
    out.push(...page.entries.filter((r) => Date.parse(r.at) >= sinceMs));
    if (page.nextBeforeSeq === null) break;
    beforeSeq = page.nextBeforeSeq;
  }
  return out;
}

export {
  getAuditRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getKeyDateRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
};
