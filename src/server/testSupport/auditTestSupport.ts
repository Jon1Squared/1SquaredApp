/**
 * Test-only helpers for asserting against the PostgreSQL firm audit log (`audit_entries`, S0-15)
 * and the tenant key-date repository from Vitest suites.
 *
 * `audit_entries` is append-only and shared across test runs, so assertions must never assume an
 * empty table. `markAuditPosition()` records the last audit number written so far; every entry written
 * afterwards has a strictly greater `AU-` number, which lets tests isolate the rows a single action produced.
 *
 * These helpers read through the tenant-scoped repositories with a test tenant context built by
 * `resolveDirectTestServiceTenantContext` (which throws outside `NODE_ENV === "test"`).
 */
import type { FirmAuditEntryRecord, TenantContext } from '../../../core/src/api/index';
import { resolveDirectTestServiceTenantContext } from '../../platform/tenantRuntime';
import { getAuditRepository } from '../auditAdapter';
import { getKeyDateRepository } from '../services';

export function testTenantCtx(actorId = 'P-000001'): TenantContext {
  return resolveDirectTestServiceTenantContext({
    actorId,
    roles: ['admin'],
    mfaVerified: true,
  });
}

function auditNumber(id: string): number {
  const match = /^AU-(\d+)$/.exec(id);
  return match?.[1] ? Number.parseInt(match[1], 10) : -1;
}

/**
 * Returns the number of the last audit entry written so far; every entry written afterwards has a
 * strictly greater number. `allocateNextAuditId` peeks (it does not reserve), so the next entry
 * written receives exactly that ID — hence the `- 1`.
 */
export async function markAuditPosition(): Promise<number> {
  const id = await getAuditRepository().allocateNextAuditId(testTenantCtx());
  return auditNumber(id) - 1;
}

/** All audit entries for one record (unfiltered by viewer permissions), newest first. */
export async function auditEntriesForRecord(
  recordType: string,
  recordId: string,
  since?: number,
): Promise<FirmAuditEntryRecord[]> {
  const rows = await getAuditRepository().listAuditEntriesForRecord(
    testTenantCtx(),
    recordType,
    recordId,
    { limit: 1000 },
  );
  return since === undefined ? rows : rows.filter((r) => auditNumber(r.id) > since);
}

/** Firm-wide audit entries written after `since` (unfiltered by viewer permissions). */
export async function auditEntriesSince(since: number): Promise<FirmAuditEntryRecord[]> {
  const ctx = testTenantCtx();
  const out: FirmAuditEntryRecord[] = [];
  let beforeSeq: number | undefined;
  // Entries are ordered by `at`, which may be a faked historical time, so scan pages fully.
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
  const ctx = testTenantCtx();
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

export { getAuditRepository, getKeyDateRepository };
