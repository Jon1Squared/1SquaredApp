import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDirectMigrationClient,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantPostgresPoolManager,
  TenantScopedRepository,
  type TenantContext,
} from '@platform/core';
import { resetAllDemoData } from '../../src/server/services';
import { testDataResetContext } from '../../src/test/testTenantContexts';

const REPO_ROOT = path.resolve(__dirname, '../..');

class RawAuditDeleteProbe extends TenantScopedRepository {
  public async deleteAllAuditRows(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query('DELETE FROM public.audit_entries WHERE tenant_id = $1', [
        ctx.tenantId,
      ]);
    });
  }
}

function contextFor(tenantId: string, environment: 'test' | 'live'): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: `actor-${tenantId}`,
      tenantId,
      name: `Actor ${tenantId}`,
      email: `actor@${tenantId}.example`,
      roles: ['admin'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment,
    correlationId: `corr-r453-${tenantId}-${environment}`,
  });
}

describe('S0-15: demo audit reset runs under the tenant role, never the migrate identity (R453)', () => {
  afterAll(async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
  });

  it('clears the audit log and restarts AU- ids through the non-live reset function, re-read on a fresh connection', async () => {
    const ctx = testDataResetContext();
    const repo = new TenantAuditRepository();
    await repo.appendAuditEntry(ctx, {
      recordType: 'system',
      recordId: 'r453-probe',
      action: 'probe',
      field: null,
      oldValue: null,
      newValue: null,
      byId: 'P-000004',
      at: new Date().toISOString(),
    });
    expect(await repo.countAuditEntries(ctx)).toBeGreaterThan(0);

    await repo.resetNonLiveAuditLog(ctx);

    const freshPoolMgr = new TenantPostgresPoolManager();
    try {
      const freshRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });
      expect(await freshRepo.countAuditEntries(ctx)).toBe(0);
      expect(await freshRepo.allocateNextAuditId(ctx)).toBe('AU-000001');
    } finally {
      await freshPoolMgr.closeAllPools();
    }
  });

  it('keeps audit_entries append-only for the tenant role: a direct DELETE is still denied', async () => {
    const ctx = testDataResetContext();
    await expect(
      new RawAuditDeleteProbe().deleteAllAuditRows(ctx),
    ).rejects.toMatchObject({
      code: '42501',
      message:
        'TENANCY_DATABASE_PERMISSION_DENIED: PostgreSQL permission denied during query (SQLSTATE 42501).',
    });
  });

  it('refuses a live context before touching the database', async () => {
    const liveCtx = Object.freeze({
      ...testDataResetContext(),
      environment: 'live' as const,
    });
    await expect(
      new TenantAuditRepository().resetNonLiveAuditLog(liveCtx),
    ).rejects.toMatchObject({
      code: 'LIVE_AUDIT_RESET_FORBIDDEN',
      message:
        'LIVE_AUDIT_RESET_FORBIDDEN: Immutable audit_entries cannot be cleared in the live environment.',
    });
  });

  it('creates the reset function only in non-live databases', async () => {
    const readFunction = async (ctx: TenantContext): Promise<string | null> => {
      const client = await createDirectMigrationClient({ ctx });
      try {
        const res = await client.query<{ fn: string | null }>(
          "SELECT to_regprocedure('public.reset_non_live_audit_log(text)')::text AS fn",
        );
        return res.rows[0]?.fn ?? null;
      } finally {
        await client.end();
      }
    };
    expect(await readFunction(contextFor('firm-live-test', 'live'))).toBeNull();
    // Positive control: the same migration catalogue created it in a test database.
    expect(await readFunction(testDataResetContext())).toBe(
      'reset_non_live_audit_log(text)',
    );
  });

  it('the web app never opens a migrate-identity connection', () => {
    let matches = '';
    try {
      matches = execFileSync('git', ['grep', '-n', 'createDirectMigrationClient', '--', 'src/'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch {
      matches = ''; // git grep exits 1 when nothing matches
    }
    expect(matches).toBe('');
  });
});
