/**
 * S0-15 — firm audit log and key dates on PostgreSQL (`docs/roadmap/slices/s0-15-key-dates-and-audit-log.md`, Tests).
 *
 * Covers:
 * - Append-only `audit_entries` (R413): the tenant role has SELECT, INSERT only.
 * - Scoped audit queries (R413) and `getAppSnapshot().audit === []`.
 * - Same-transaction atomicity for key-date and Document Generation writes (Owner Decision 4, R405).
 * - Concurrent interleaving with per-record delta compensation (R406).
 * - Nested re-entrancy of `withJsonStoreWriteLock` without deadlock (R418).
 * - Idempotent `key-dates` / `audit` import with AU- sequence continuation.
 * - Two-tenant isolation of `TenantAuditRepository` (positive control, forged claim, tampered IDs, SET LOCAL ROLE).
 *
 * All fixtures are invented (the invented demo tenant seed data and synthetic `firm-alpha` / `firm-beta` tenants).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AdminCatchAllPage from '../../src/app/admin/[[...slug]]/page';
import {
  getPlatformTelemetryRecorder,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  type FirmAuditEntryInput,
  type TenantContext,
} from '../src/index';
import {
  executeMerge,
  getAppSnapshot,
  getKeyDatesConfig,
  listAuditEntriesForRecord,
  listFirmAuditEntriesPage,
  logEmployeeRestrictedAccess,
  resetAllDemoData,
  saveKeyDatesConfigRecord,
  saveMatterRecord,
  savePersonRecord,
  switchUserInDemoMode,
  takeTaskRecord,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
} from '../../src/server/services';
import {
  getAuditRepository,
  runUnmigratedJsonMutationWithAudit,
  stageUnmigratedAuditEntry,
} from '../../src/server/auditAdapter';
import { withJsonStoreWriteLock } from '../../src/server/storeLock';
import { uploadTemplateDraftService } from '../../src/server/documentGenerationServices';
import { buildValidDocxArchive } from '@platform/core';
import { getDocumentRepository } from '../../src/server/documentGenerationServices';
import { importFirmStoreModulesToPostgres } from '../../src/server/storePostgresImport';
import { testDataResetContext } from '../../src/test/testTenantContexts';
import { clearStoreMemoryCache, getStore, saveStore } from '../../src/server/store';
import { canUserTakeTask } from '../../src/server/rbacRuntime';
import { runWithActiveActorSession } from '../../src/domain/rbac';
import { resolveEmployeeRoles } from '../../src/domain/homeConfig';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  auditEntriesWrittenSince,
  getKeyDateRepository,
  setAuditAdapterFailureHookForTesting,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';

function runAsTestEmployee<T>(personId: string, fn: () => T): T {
  const store = getStore();
  const tenantId = getActiveTenantConfiguration().tenantId;
  const emp = store.people.find((p) => p.id === personId)!;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const roles = resolveEmployeeRoles(emp, store.teams);
  const verified = verifySignedEntraSessionCookie(
    createSignedEntraSessionCookie({
      personId: emp.id,
      oid:
        emp.entraObjectId ??
        `00000000-0000-4000-8000-${emp.id.replace(/\D/g, '').padStart(12, '0')}`,
      tid: '00000000-0000-4000-8000-000000000099',
      tenantId,
      sub: emp.id,
      email: emp.emails?.[0]?.address ?? `${emp.id.toLowerCase()}@notalawfirm.example`,
      displayName: `${emp.firstName ?? ''} ${emp.surname ?? ''}`.trim() || emp.id,
      entraRoles: roles,
      mappedRoles: roles,
      entraGroups: [],
      mfaVerified: true,
      amr: ['pwd', 'mfa'],
      authenticatedAt: nowIso,
      expiresAt,
    }),
  )!;
  return runWithActiveActorSession(
    {
      personId: emp.id,
      tenantId,
      tokenRoles: roles,
      expiresAtMs: Date.parse(expiresAt),
      verifiedSession: verified,
    },
    fn,
  );
}

function makeTenantCtx(tenantId: string, actorId = 'user-1'): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId}@${tenantId}.example.invalid`,
      roles: ['admin'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-audit-${tenantId}-${actorId}`,
  });
}

function auditInput(recordId: string, field: string, recordType = 'matter') {
  return {
    recordType,
    recordId,
    action: 'update',
    field,
    oldValue: null,
    newValue: 'invented value',
    byId: 'user-1',
    at: new Date().toISOString(),
  } as const;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`DEADLOCK_TIMEOUT: ${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
}

describe('S0-15: firm audit log on PostgreSQL (R405, R406, R413, R418)', () => {
  afterEach(() => {
    setAuditAdapterFailureHookForTesting(null);
  });

  it('R413: audit_entries is append-only — UPDATE and DELETE as role_tenant_* fail with SQLSTATE 42501', async () => {
    const repo = new TenantAuditRepository();
    const ctx = makeTenantCtx('firm-alpha');
    const appended = await repo.appendAuditEntry(ctx, auditInput('M-ALPHA-IMMUTABLE', 'Immutable row'));

    // Positive control: SELECT and INSERT are permitted for the tenant role
    const readBack = await repo.listAuditEntriesForRecord(ctx, 'matter', 'M-ALPHA-IMMUTABLE');
    expect(readBack.map((r) => r.id)).toContain(appended.id);

    await expect(
      repo.withTenantTransaction(ctx, (tx) =>
        tx.query("UPDATE public.audit_entries SET field = 'tampered' WHERE tenant_id = $1 AND id = $2", [
          ctx.tenantId,
          appended.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      repo.withTenantTransaction(ctx, (tx) =>
        tx.query('DELETE FROM public.audit_entries WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          appended.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const afterAttempts = await repo.listAuditEntriesForRecord(ctx, 'matter', 'M-ALPHA-IMMUTABLE');
    const row = afterAttempts.find((r) => r.id === appended.id);
    expect(row?.field).toBe('Immutable row');
  });

  it('R413: listAuditEntriesForRecord returns only the matching (record_type, record_id) rows bounded by limit', async () => {
    const repo = new TenantAuditRepository();
    const ctx = makeTenantCtx('firm-alpha');
    const suffix = Date.now().toString(36);
    const target = `M-SCOPED-${suffix}`;
    const other = `M-OTHER-${suffix}`;
    await repo.appendAuditEntries(ctx, [
      auditInput(target, 'First'),
      auditInput(target, 'Second'),
      auditInput(target, 'Third'),
      auditInput(other, 'Unrelated'),
      auditInput(target, 'Wrong type', 'task'),
    ]);

    const all = await repo.listAuditEntriesForRecord(ctx, 'matter', target);
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.recordType === 'matter' && r.recordId === target)).toBe(true);

    const bounded = await repo.listAuditEntriesForRecord(ctx, 'matter', target, { limit: 2 });
    expect(bounded).toHaveLength(2);
    expect(bounded.every((r) => r.recordId === target)).toBe(true);
  });

  it('R451: listFirmAuditEntriesPage orders by seq DESC alone so entries with earlier client-supplied at timestamps are never skipped across pages', async () => {
    const repo = new TenantAuditRepository();
    const ctx = makeTenantCtx('firm-alpha');
    const suffix = Date.now().toString(36);

    const [entry1] = await repo.appendAuditEntries(ctx, [
      {
        ...auditInput(`M-R451-1-${suffix}`, 'Later timestamp, earlier seq'),
        at: '2026-04-12T10:05:00.000Z',
      },
    ]);
    const [entry2] = await repo.appendAuditEntries(ctx, [
      {
        ...auditInput(`M-R451-2-${suffix}`, 'Earlier timestamp, later seq'),
        at: '2026-04-12T10:00:00.000Z',
      },
    ]);
    expect(entry1!.seq).toBeDefined();
    expect(entry2!.seq).toBeDefined();
    expect(entry2!.seq!).toBeGreaterThan(entry1!.seq!);

    const page1 = await repo.listFirmAuditEntriesPage(ctx, { limit: 1 });
    expect(page1.entries).toHaveLength(1);
    expect(page1.entries[0]!.id).toBe(entry2!.id);
    expect(page1.entries[0]!.seq).toBe(entry2!.seq);
    expect(page1.nextBeforeSeq).toBe(entry2!.seq);

    const page2 = await repo.listFirmAuditEntriesPage(ctx, {
      limit: 1,
      beforeSeq: page1.nextBeforeSeq!,
    });
    expect(page2.entries).toHaveLength(1);
    expect(page2.entries[0]!.id).toBe(entry1!.id);
    expect(page2.entries[0]!.seq).toBe(entry1!.seq);
  });

  it('R455: runtime appendAuditEntry rejects duplicate audit IDs with TENANCY_AUDIT_WRITE_ERROR while importAuditEntries remains idempotent', async () => {
    const repo = new TenantAuditRepository();
    const ctx = makeTenantCtx('firm-alpha');
    const explicitId = await repo.allocateNextAuditId(ctx);
    const recordId = `M-R455-${Date.now().toString(36)}`;

    const first = await repo.appendAuditEntry(ctx, {
      id: explicitId,
      recordType: 'matter',
      recordId,
      action: 'create',
      field: 'Original field',
      oldValue: null,
      newValue: 'Invented original value',
      byId: 'P-000001',
      at: '2026-04-12T10:00:00.000Z',
    });
    expect(first.id).toBe(explicitId);

    let duplicateErr: (Error & { code?: string }) | null = null;
    try {
      await repo.appendAuditEntry(ctx, {
        id: explicitId,
        recordType: 'matter',
        recordId,
        action: 'delete',
        field: 'Tampered field',
        oldValue: 'Invented original value',
        newValue: 'Invented forged replacement',
        byId: 'P-000001',
        at: '2026-04-12T10:01:00.000Z',
      });
    } catch (err) {
      duplicateErr = err as Error & { code?: string };
    }
    expect(duplicateErr).not.toBeNull();
    expect(duplicateErr?.code).toBe('TENANCY_AUDIT_WRITE_ERROR');
    expect(duplicateErr?.message).toContain('Duplicate or invalid firm audit entry');
    expect(duplicateErr?.message).not.toContain(explicitId);
    expect(duplicateErr?.message).not.toContain('Invented forged replacement');

    const freshRepo = new TenantAuditRepository();
    const rows = await freshRepo.listAuditEntriesForRecord(ctx, 'matter', recordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(explicitId);
    expect(rows[0]!.action).toBe('create');
    expect(rows[0]!.newValue).toBe('Invented original value');
  });

  it('R460: tenant role has UPDATE privilege on tenant_audit_id_seq only and cannot call setval on other sequences', async () => {
    const repo = new TenantAuditRepository();
    const ctx = makeTenantCtx('firm-alpha');

    const privs = await repo.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        audit_update: boolean;
        kd_update: boolean;
        kd_usage: boolean;
      }>(
        `SELECT
           has_sequence_privilege(current_user, 'public.tenant_audit_id_seq', 'UPDATE') AS audit_update,
           has_sequence_privilege(current_user, 'public.tenant_key_date_id_seq', 'UPDATE') AS kd_update,
           has_sequence_privilege(current_user, 'public.tenant_key_date_id_seq', 'USAGE') AS kd_usage`,
      );
      return res.rows[0]!;
    });
    expect(privs.audit_update).toBe(true);
    expect(privs.kd_update).toBe(false);
    expect(privs.kd_usage).toBe(true);

    await expect(
      repo.withTenantTransaction(ctx, (tx) =>
        tx.query("SELECT setval('public.tenant_key_date_id_seq', 1, false)"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('R413: scoped service queries redact staff-matter and HR rows for unauthorised viewers, and getAppSnapshot returns audit = []', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = getStore();
      const staffMatter = store.matters.find((m) => m.id === 'M-000014')!;
      staffMatter.isStaffMatter = true;
      staffMatter.responsiblePartnerId = 'P-000004';
      staffMatter.supervisingPartnerId = 'P-000004';
      staffMatter.leadFeeEarnerId = 'P-000004';
      staffMatter.teamMemberIds = ['P-000004'];
      staffMatter.restrictedAccessUserIds = ['P-000004'];
      saveStore(store);

      await getAuditRepository().appendAuditEntry(testTenantCtx('P-000004'), {
        recordType: 'matter',
        recordId: 'M-000014',
        action: 'update',
        field: 'Staff matter note',
        oldValue: null,
        newValue: 'Invented staff matter change',
        byId: 'P-000004',
        at: new Date().toISOString(),
      });

      // Authorised viewer (restricted access list) sees the row; fee earner outside the list gets []
      const allowed = await runAsTestEmployee('P-000004', () =>
        listAuditEntriesForRecord('matter', 'M-000014', 'P-000004', { limit: 200 }),
      );
      expect(allowed.some((a) => a.field === 'Staff matter note')).toBe(true);
      const denied = await runAsTestEmployee('P-000002', () =>
        listAuditEntriesForRecord('matter', 'M-000014', 'P-000002', { limit: 200 }),
      );
      expect(denied).toEqual([]);
      const deniedFirmPage = await runAsTestEmployee('P-000002', () =>
        listFirmAuditEntriesPage('P-000002', { limit: 2000 }),
      );
      expect(deniedFirmPage.code).toBe('FORBIDDEN');
      expect(deniedFirmPage.entries).toEqual([]);

      // HR sensitive access audit: visible to the HR-permitted admin, redacted for a fee earner
      const hrLog = await runAsTestEmployee('P-000004', () =>
        logEmployeeRestrictedAccess('P-000003', 'sensitive', 'P-000004', 'Viewed sensitive tab'),
      );
      expect(hrLog.error).toBeUndefined();
      const hrAllowed = await runAsTestEmployee('P-000004', () =>
        listAuditEntriesForRecord('employee_sensitive', 'P-000003', 'P-000004', { limit: 200 }),
      );
      expect(hrAllowed.some((a) => a.action === 'view-sensitive')).toBe(true);
      const hrDenied = await runAsTestEmployee('P-000002', () =>
        listAuditEntriesForRecord('employee_sensitive', 'P-000003', 'P-000002', { limit: 200 }),
      );
      expect(hrDenied).toEqual([]);

      // getAppSnapshot no longer loads the firm-wide audit table
      const snap = await runAsTestEmployee('P-000004', () => getAppSnapshot('P-000004'));
      expect(snap.audit).toEqual([]);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Owner Decision 4: a forced failure during a key-date config write commits neither the config nor audit_entries', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const kdRepo = getKeyDateRepository();
    const originalOverride = await kdRepo.getKeyDatesTenantConfig(testTenantCtx('P-000004'));
    try {
      const current = structuredClone(
        await runAsTestEmployee('P-000004', () => getKeyDatesConfig(getStore())),
      );
      expect((current.limitationRuleSets ?? []).length).toBeGreaterThan(0);
      const next = structuredClone(current);
      const firstRuleSet = next.limitationRuleSets![0]!;
      next.limitationRuleSets![0] = { ...firstRuleSet, version: firstRuleSet.version + 1 };

      const startedAt = Date.now();
      let keyDateHookFired = false;
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === 'FIRM-KEY-DATES-CONFIG')) {
          keyDateHookFired = true;
          throw new Error('SIMULATED_AUDIT_FAILURE_KEY_DATES');
        }
      });
      // The service either rethrows or returns a structured failure; either way nothing may commit
      const outcome = await runAsTestEmployee('P-000004', () =>
        saveKeyDatesConfigRecord(next, 'Forced failure test', 'P-000004', {
          mfaVerified: true,
        }),
      ).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
      expect(outcome.ok).toBe(false);
      // The failure was the forced audit failure inside the transaction, not an earlier validation error
      expect(keyDateHookFired).toBe(true);
      setAuditAdapterFailureHookForTesting(null);

      const overrideAfter = await kdRepo.getKeyDatesTenantConfig(testTenantCtx('P-000004'));
      expect(overrideAfter).toEqual(originalOverride);
      const writtenAudit = await auditEntriesWrittenSince(startedAt);
      expect(writtenAudit.some((a) => a.recordId === 'FIRM-KEY-DATES-CONFIG')).toBe(false);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      if (originalOverride) {
        await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000004'), originalOverride, 'P-000004');
      }
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Owner Decision 4 / R405: a forced failure during a Document Generation template write commits neither the template nor audit_entries', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const docRepo = getDocumentRepository();
    const ctx = testTenantCtx('P-000004');
    const code = 'TPL-S015-ATOMIC';
    expect(await docRepo.getTemplateByCode(ctx, code)).toBeNull();
    const docxBase64 = Buffer.from(
      buildValidDocxArchive({ paragraphs: [{ text: 'Dear {{client.name}}, ref {{matter.reference}}.' }] }),
    ).toString('base64');
    const startedAt = Date.now();
    let hookFired = false;
    try {
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => String(e.field ?? '').startsWith('Document Template Draft Uploaded'))) {
          hookFired = true;
          throw new Error('SIMULATED_AUDIT_FAILURE_DOCGEN');
        }
      });
      await expect(
        runAsTestEmployee('P-000004', () =>
          uploadTemplateDraftService(
            {
              code,
              name: 'Atomicity Test Template',
              description: 'Invented template for S0-15 atomicity test',
              category: 'General',
              outputDocumentType: 'Letter',
              filenamePattern: '{matter.reference}-atomic',
              availabilityRules: { sourceContexts: ['matter'] },
              fileName: 'atomic.docx',
              docxBase64,
            },
            'P-000004',
          ),
        ),
      ).rejects.toThrow();
      setAuditAdapterFailureHookForTesting(null);
      expect(hookFired).toBe(true);

      expect(await docRepo.getTemplateByCode(ctx, code)).toBeNull();
      const writtenAudit = await auditEntriesWrittenSince(startedAt);
      expect(
        writtenAudit.some((a) => String(a.field ?? '').startsWith('Document Template Draft Uploaded')),
      ).toBe(false);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R406: concurrent opA (audit append fails) and opB (succeeds) — opB JSON and audit survive, only opA delta is reverted', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const startedAt = Date.now();
      const beforeA = structuredClone(getStore().people.find((p) => p.id === 'P-000002')!);
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === 'P-000002')) {
          throw new Error('SIMULATED_AUDIT_FAILURE_OP_A');
        }
      });

      const [opA, opB] = await Promise.allSettled([
        runAsTestEmployee('P-000004', () =>
          updatePersonPermissionOverrides(
            'P-000002',
            { grant: ['risk:view'], revoke: [], reason: 'Operation A (forced to fail)' },
            'P-000004',
            { mfaVerified: true },
          ),
        ),
        runAsTestEmployee('P-000004', () =>
          updatePersonPermissionOverrides(
            'P-000005',
            { grant: ['risk:view'], revoke: [], reason: 'Operation B (succeeds)' },
            'P-000004',
            { mfaVerified: true },
          ),
        ),
      ]);
      setAuditAdapterFailureHookForTesting(null);

      expect(opA.status).toBe('rejected');
      expect(opB.status).toBe('fulfilled');
      if (opB.status === 'fulfilled') expect(opB.value.ok).toBe(true);

      // Re-read from the persisted JSON store, not the in-memory cache
      clearStoreMemoryCache();
      const reloaded = getStore();
      const afterA = reloaded.people.find((p) => p.id === 'P-000002')!;
      const afterB = reloaded.people.find((p) => p.id === 'P-000005')!;
      expect(afterA.permissionOverrides ?? null).toEqual(beforeA.permissionOverrides ?? null);
      expect(afterA.updatedAt).toBe(beforeA.updatedAt);
      expect(afterB.permissionOverrides?.grant).toContain('risk:view');
      expect(afterB.permissionOverrides?.reason).toBe('Operation B (succeeds)');

      const written = await auditEntriesWrittenSince(startedAt);
      expect(written.some((a) => a.recordId === 'P-000005')).toBe(true);
      expect(written.some((a) => a.recordId === 'P-000002')).toBe(false);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R418: nested locked calls (takeTaskRecord -> saveTaskRecord, nested runUnmigratedJsonMutationWithAudit) complete under 2s and roll back cleanly on forced failure', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = getStore();
      let pick: { taskId: string; personId: string } | null = null;
      for (const task of store.tasks) {
        if (task.assignedPersonId) continue;
        const taker = store.people.find(
          (p) => p.isEmployee && canUserTakeTask(p.id, task, store.teams, store.people, store.values),
        );
        if (taker) {
          pick = { taskId: task.id, personId: taker.id };
          break;
        }
      }
      expect(pick).not.toBeNull();
      const { taskId, personId } = pick!;

      // (a) Forced PostgreSQL audit failure: outer (take) and inner (save) deltas are both reverted
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === taskId)) {
          throw new Error('SIMULATED_AUDIT_FAILURE_NESTED');
        }
      });
      await expect(
        withTimeout(
          runAsTestEmployee(personId, () => takeTaskRecord(taskId, personId)),
          2000,
          'takeTaskRecord (forced failure)',
        ),
      ).rejects.toThrow(/SIMULATED_AUDIT_FAILURE_NESTED/);
      setAuditAdapterFailureHookForTesting(null);
      clearStoreMemoryCache();
      expect(getStore().tasks.find((t) => t.id === taskId)?.assignedPersonId ?? null).toBeNull();

      // (b) Same nested call succeeds without deadlock
      const taken = await withTimeout(
        runAsTestEmployee(personId, () => takeTaskRecord(taskId, personId)),
        2000,
        'takeTaskRecord',
      );
      expect(taken.error).toBeUndefined();
      expect(taken.task?.assignedPersonId).toBe(personId);

      // (c) Real saveMatterRecord (with sourceEnquiryId) -> finalizeEnquiryConversionToMatter -> raiseAutomaticTask
      //     nested chain (R418, R456): on a forced PostgreSQL audit failure, neither the matter nor the automatic
      //     task nor the enquiry status change survives clearStoreMemoryCache(), and no audit rows exist on a fresh connection.
      const openEnquiry = getStore().enquiries.find(
        (e) => e.status !== 'Converted' && e.status !== 'No response',
      )!;
      expect(openEnquiry).toBeDefined();
      const baseMatter = getStore().matters.find((m) => !m.isStaffMatter)!;
      const { id: _omittedMatterId, ...matterTemplate } = baseMatter;
      void _omittedMatterId;
      const conversionTitle = `R456 Enquiry Conversion Matter ${Date.now().toString(36)}`;
      const preTasksCount = getStore().tasks.length;
      const preEnquiryStatus = openEnquiry.status;
      const startedAt = Date.now();

      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === openEnquiry.id || String(e.newValue ?? '').includes(conversionTitle))) {
          throw new Error('SIMULATED_AUDIT_FAILURE_ENQUIRY_CONVERSION');
        }
      });

      await expect(
        withTimeout(
          runAsTestEmployee('P-000004', () =>
            saveMatterRecord(
              {
                ...matterTemplate,
                matterNumber: 'DRAFT',
                openedAt: null,
                fieldValues: {},
                title: conversionTitle,
                sourceEnquiryId: openEnquiry.id,
                agreedFeeCapGbp: 5000,
                feeEstimateGbp: 5000,
              },
              { byId: 'P-000004', saveMode: 'submit_cleared' },
            ),
          ),
          2000,
          'saveMatterRecord -> finalizeEnquiryConversionToMatter -> raiseAutomaticTask (forced failure)',
        ),
      ).rejects.toThrow(/SIMULATED_AUDIT_FAILURE_ENQUIRY_CONVERSION/);
      setAuditAdapterFailureHookForTesting(null);

      clearStoreMemoryCache();
      const reloadedStore = getStore();
      expect(reloadedStore.matters.some((m) => m.title === conversionTitle)).toBe(false);
      expect(reloadedStore.tasks.length).toBe(preTasksCount);
      expect(reloadedStore.enquiries.find((e) => e.id === openEnquiry.id)?.status).toBe(preEnquiryStatus);

      const freshAuditRepo = new TenantAuditRepository();
      const freshEnquiryAudit = await freshAuditRepo.listAuditEntriesForRecord(
        testTenantCtx('P-000004'),
        'enquiry',
        openEnquiry.id,
      );
      expect(freshEnquiryAudit.some((a) => Date.parse(a.at) >= startedAt)).toBe(false);
      const written = await auditEntriesWrittenSince(startedAt);
      expect(written.some((a) => String(a.newValue ?? '').includes(conversionTitle))).toBe(false);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R442: forced PostgreSQL audit failure during savePersonRecord (sensitive HR update) and updateTenantRbacConfig reverts employeeSensitiveRecords and rbacConfigOverride after clearStoreMemoryCache()', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const targetEmployeeId = 'P-000002';
      const initialStore = getStore();
      const targetPerson = structuredClone(
        initialStore.people.find((p) => p.id === targetEmployeeId)!,
      );
      const beforeSensitive = structuredClone(
        initialStore.employeeSensitiveRecords[targetEmployeeId],
      );

      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.action === 'update-sensitive')) {
          throw new Error('SIMULATED_AUDIT_FAILURE_SENSITIVE_HR');
        }
      });

      await expect(
        runAsTestEmployee('P-000004', () =>
          savePersonRecord(
            {
              ...targetPerson,
              firstName: targetPerson.firstName,
              surname: targetPerson.surname,
              dateOfBirth: targetPerson.dateOfBirth || '1985-06-15',
              isEmployee: true,
            },
            {
              id: targetEmployeeId,
              byId: 'P-000004',
              mfaVerified: true,
              worksAtFirm: true,
              sensitiveSubmitted: {
                ...(beforeSensitive ?? {}),
                reasonableAdjustmentsNeeded: 'Invented R442 rollback adjustment',
              },
            },
          ),
        ),
      ).rejects.toThrow(/SIMULATED_AUDIT_FAILURE_SENSITIVE_HR/);
      setAuditAdapterFailureHookForTesting(null);

      clearStoreMemoryCache();
      expect(getStore().employeeSensitiveRecords[targetEmployeeId]).toEqual(beforeSensitive);

      // Part 2: RBAC configuration override rollback
      const beforeRbacOverride = structuredClone(getStore().rbacConfigOverride);
      const snap = await runAsTestEmployee('P-000004', () => getAppSnapshot('P-000004'));
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === 'TENANT-RBAC-CONFIG')) {
          throw new Error('SIMULATED_AUDIT_FAILURE_RBAC_OVERRIDE');
        }
      });

      await expect(
        runAsTestEmployee('P-000004', () =>
          updateTenantRbacConfig(
            {
              identityMapping: {
                ...snap.rbacConfig.identityMapping,
                entraGroupToRoleKey: {
                  ...snap.rbacConfig.identityMapping.entraGroupToRoleKey,
                  '22222222-3333-4444-5555-666666666666': ['partner'],
                },
              },
            },
            'P-000004',
            { mfaVerified: true },
          ),
        ),
      ).rejects.toThrow(/SIMULATED_AUDIT_FAILURE_RBAC_OVERRIDE/);
      setAuditAdapterFailureHookForTesting(null);

      clearStoreMemoryCache();
      expect(getStore().rbacConfigOverride).toEqual(beforeRbacOverride);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R444: stageUnmigratedAuditEntry outside an active staging scope throws TENANCY_AUDIT_WRITE_ERROR, and switchUserInDemoMode writes an audit_entries row readable on a fresh connection', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      let outsideErr: (Error & { code?: string }) | null = null;
      try {
        stageUnmigratedAuditEntry({
          recordType: 'person',
          recordId: 'P-000002',
          action: 'update',
          field: 'Unscoped test',
          oldValue: null,
          newValue: 'invented',
          byId: 'P-000004',
        });
      } catch (err) {
        outsideErr = err as Error & { code?: string };
      }
      expect(outsideErr).not.toBeNull();
      expect(outsideErr?.code).toBe('TENANCY_AUDIT_WRITE_ERROR');
      expect(outsideErr?.message).toContain('outside an active audit staging scope');

      // Part 2: switchUserInDemoMode persists an audit_entries row on a fresh connection
      const rawBaseCfg = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBaseCfg,
        featureFlags: {
          ...(rawBaseCfg.featureFlags as Record<string, unknown>),
          enableDemoMode: true,
        },
      });
      const store = getStore();
      const adminPerson = store.people.find((p) => p.id === 'P-000001')!;
      const targetDemoPerson = store.people.find(
        (p) => p.isEmployee && p.demo && p.id !== 'P-000001' && !p.mergedIntoId,
      )!;
      expect(targetDemoPerson).toBeDefined();

      const nowMs = Date.now();
      setTestEntraSessionOverride({
        tenantId: 'not-a-law-firm',
        personId: adminPerson.id,
        oid: adminPerson.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-4333-8444-555555555555',
        sub: adminPerson.id,
        email: adminPerson.emails?.[0]?.address ?? 'dafydd@notalawfirm.example.invalid',
        displayName: 'Dafydd Llewellyn',
        entraRoles: resolveEmployeeRoles(adminPerson, store.teams),
        mappedRoles: resolveEmployeeRoles(adminPerson, store.teams),
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      });

      const startedAt = Date.now();
      const switched = await runAsTestEmployee(adminPerson.id, () =>
        switchUserInDemoMode(targetDemoPerson.id),
      );
      expect(switched.ok).toBe(true);
      expect(switched.personId).toBe(targetDemoPerson.id);

      const freshRepo = new TenantAuditRepository();
      const rows = await freshRepo.listAuditEntriesForRecord(
        testTenantCtx(adminPerson.id),
        'person',
        targetDemoPerson.id,
      );
      expect(
        rows.some(
          (r) =>
            r.field === 'Demo user switch' &&
            r.oldValue === adminPerson.id &&
            r.newValue === targetDemoPerson.id &&
            Date.parse(r.at) >= startedAt,
        ),
      ).toBe(true);
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(undefined);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R446: nested runUnmigratedJsonMutationWithAudit where outer inserts note X, inner updates X, and outer audit append fails leaves X absent after clearStoreMemoryCache() and commits no inner audit row', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const noteId = 'N-R446-OVERLAP';
      const startedAt = Date.now();

      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.recordId === 'R446-OUTER-TRIGGER')) {
          throw new Error('SIMULATED_R446_OUTER_AUDIT_FAILURE');
        }
      });

      await expect(
        runUnmigratedJsonMutationWithAudit({
          label: 'r446-outer',
          resolveCtx: () => testTenantCtx('P-000004'),
          mutate: async (outerStore) => {
            outerStore.notes.unshift({
              id: noteId,
              recordType: 'person',
              recordId: 'P-000002',
              body: 'Inserted by outer frame',
              createdById: 'P-000004',
              createdAt: new Date().toISOString(),
            } as unknown as (typeof outerStore.notes)[number]);
            saveStore(outerStore);

            await runUnmigratedJsonMutationWithAudit({
              label: 'r446-inner',
              resolveCtx: () => testTenantCtx('P-000004'),
              mutate: async (innerStore) => {
                const target = innerStore.notes.find((n) => n.id === noteId) as
                  | Record<string, unknown>
                  | undefined;
                expect(target).toBeDefined();
                target!.body = 'Updated by inner frame';
                stageUnmigratedAuditEntry({
                  recordType: 'person',
                  recordId: noteId,
                  action: 'update',
                  field: 'Inner note update',
                  oldValue: 'Inserted by outer frame',
                  newValue: 'Updated by inner frame',
                  byId: 'P-000004',
                });
                saveStore(innerStore);
              },
            });

            stageUnmigratedAuditEntry({
              recordType: 'person',
              recordId: 'R446-OUTER-TRIGGER',
              action: 'create',
              field: 'Outer note trigger',
              oldValue: null,
              newValue: noteId,
              byId: 'P-000004',
            });
          },
        }),
      ).rejects.toThrow(/SIMULATED_R446_OUTER_AUDIT_FAILURE/);
      setAuditAdapterFailureHookForTesting(null);

      clearStoreMemoryCache();
      expect(getStore().notes.some((n) => n.id === noteId)).toBe(false);

      const freshRepo = new TenantAuditRepository();
      const innerRows = await freshRepo.listAuditEntriesForRecord(
        testTenantCtx('P-000004'),
        'person',
        noteId,
      );
      expect(innerRows.filter((r) => Date.parse(r.at) >= startedAt)).toEqual([]);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R447: when a RecordDeltaCompensator undo callback throws inside withJsonStoreWriteLock, logs and emits store.compensation_failed with tenantId and correlationId (no content) and rethrows the original error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const recorder = getPlatformTelemetryRecorder();
    const beforeCount = recorder.getRecentEntries().length;
    try {
      await expect(
        runAsTestEmployee('P-000004', () =>
          withJsonStoreWriteLock(async (compensator) => {
            compensator.register('r447-failing-undo', () => {
              throw new Error('SENSITIVE_UNDO_SECRET_PAYLOAD_SHOULD_NOT_LEAK');
            });
            throw new Error('ORIGINAL_MUTATION_ERROR_R447');
          }),
        ),
      ).rejects.toThrow('ORIGINAL_MUTATION_ERROR_R447');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedRaw = String(errorSpy.mock.calls[0]?.[0] ?? '');
      const parsed = JSON.parse(loggedRaw) as {
        level?: string;
        event?: string;
        tenantId?: string;
        correlationId?: string;
      };
      expect(parsed.level).toBe('error');
      expect(parsed.event).toBe('store.compensation_failed');
      expect(parsed.tenantId).toBe('not-a-law-firm');
      expect(parsed.correlationId).toBeTruthy();
      expect(loggedRaw).not.toContain('SENSITIVE_UNDO_SECRET_PAYLOAD_SHOULD_NOT_LEAK');

      const newTelemetry = recorder.getRecentEntries().slice(beforeCount);
      const compEvents = newTelemetry.filter(
        (e) => e.eventName === 'store.compensation_failed',
      );
      expect(compEvents).toHaveLength(1);
      expect(compEvents[0]!.tenantId).toBe('not-a-law-firm');
      expect(compEvents[0]!.correlationId).toBe(parsed.correlationId);
      expect(JSON.stringify(compEvents[0])).not.toContain(
        'SENSITIVE_UNDO_SECRET_PAYLOAD_SHOULD_NOT_LEAK',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('Import idempotency: importFirmStoreModulesToPostgres([key-dates, audit]) run twice gives identical counts and the AU- sequence continues', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const ctx = testTenantCtx('P-000004');
      const auditRepo = getAuditRepository();
      const kdRepo = getKeyDateRepository();

      const first = await importFirmStoreModulesToPostgres({
        ctx,
        store: getStore(),
        modules: ['key-dates', 'audit'],
      });
      const auditCountAfterFirst = await auditRepo.countAuditEntries(ctx);
      const keyDatesAfterFirst = (await kdRepo.listAllVisibleKeyDates(ctx)).length;

      const second = await importFirmStoreModulesToPostgres({
        ctx,
        store: getStore(),
        modules: ['key-dates', 'audit'],
      });
      const auditCountAfterSecond = await auditRepo.countAuditEntries(ctx);
      const keyDatesAfterSecond = (await kdRepo.listAllVisibleKeyDates(ctx)).length;

      expect(second.counts.keyDates).toBe(first.counts.keyDates);
      expect(second.counts.keyDateNotApplicable).toBe(first.counts.keyDateNotApplicable);
      expect(second.counts.keyDateReminderStates).toBe(first.counts.keyDateReminderStates);
      expect(second.counts.keyDateCalendarSyncs).toBe(first.counts.keyDateCalendarSyncs);
      expect(second.counts.auditEntries).toBe(first.counts.auditEntries);
      expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
      expect(keyDatesAfterSecond).toBe(keyDatesAfterFirst);

      // AU- sequence continues beyond every imported ID (no reuse after re-import)
      const importedMax = Math.max(
        0,
        ...(getStore().audit ?? []).map((a) => Number.parseInt(a.id.replace(/^AU-/, ''), 10) || 0),
      );
      const appended = await auditRepo.appendAuditEntry(ctx, {
        recordType: 'matter',
        recordId: 'M-IMPORT-SEQUENCE',
        action: 'update',
        field: 'Sequence continuation',
        oldValue: null,
        newValue: 'invented',
        byId: 'P-000001',
        at: new Date().toISOString(),
      });
      const appendedNum = Number.parseInt(appended.id.replace(/^AU-/, ''), 10);
      expect(appendedNum).toBeGreaterThan(importedMax);
      expect(await auditRepo.countAuditEntries(ctx)).toBe(auditCountAfterSecond + 1);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Two-tenant isolation: TenantAuditRepository positive control, forged tenant claim, tampered record IDs and SET LOCAL ROLE per tenant', async () => {
    const repo = new TenantAuditRepository();
    const ctxA = makeTenantCtx('firm-alpha', 'user-a');
    const ctxB = makeTenantCtx('firm-beta', 'user-b');
    const recordA = `M-ALPHA-${Date.now().toString(36)}`;

    // (a) Positive control: Tenant A reads its own row
    const rowA = await repo.appendAuditEntry(ctxA, auditInput(recordA, 'Tenant A only'));
    const ownRead = await repo.listAuditEntriesForRecord(ctxA, 'matter', recordA);
    expect(ownRead.map((r) => r.id)).toContain(rowA.id);
    expect(ownRead.every((r) => r.recordId === recordA)).toBe(true);

    // (b) Forged tenant claim is rejected before any repository access
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'user-a',
          tenantId: 'firm-alpha',
          name: 'Actor user-a',
          email: 'user-a@firm-alpha.example.invalid',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-audit-forged',
        untrustedRequestTenantOverride: 'firm-beta',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // (c) Tenant B with Tenant A's tampered record ID gets [] (record and firm page)
    expect(await repo.listAuditEntriesForRecord(ctxB, 'matter', recordA)).toEqual([]);
    const pageB = await repo.listFirmAuditEntriesPage(ctxB, { limit: 2000 });
    expect(pageB.entries.some((r) => r.id === rowA.id && r.recordId === recordA)).toBe(false);

    // (d) SET LOCAL ROLE: each transaction runs as its own tenant role, which reverts on commit
    const roleA = await repo.withTenantReadTransaction(ctxA, async (tx) => {
      const res = await tx.query<{ role: string }>('SELECT current_user AS role');
      return res.rows[0]!.role;
    });
    const roleB = await repo.withTenantReadTransaction(ctxB, async (tx) => {
      const res = await tx.query<{ role: string }>('SELECT current_user AS role');
      return res.rows[0]!.role;
    });
    expect(roleA).toMatch(/^role_tenant_/);
    expect(roleB).toMatch(/^role_tenant_/);
    expect(roleA).not.toBe(roleB);
    const crossTenantRows = await repo.withTenantReadTransaction(ctxB, async (tx) => {
      const res = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM public.audit_entries WHERE tenant_id = $1',
        ['firm-alpha'],
      );
      return Number(res.rows[0]!.n);
    });
    expect(crossTenantRows).toBe(0);
  });

  it('R443: executeMerge reverts only its own per-record deltas on failure without wiping a concurrent unrelated save', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const store = getStore();
    const carys = store.people.find((p) => p.id === 'P-000001')!;
    const unrelatedPerson = store.people.find(
      (p) => !p.isEmployee && !p.mergedIntoId && p.id !== 'P-000001',
    )!;
    const candidates = store.people.filter(
      (p) =>
        !p.isEmployee &&
        !p.mergedIntoId &&
        p.id !== unrelatedPerson.id,
    );
    const survivor = candidates[0]!;
    const merged = candidates[1]!;
    const survivorBeforeName = survivor.surname;

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const verifiedSession = verifySignedEntraSessionCookie(
      createSignedEntraSessionCookie({
        personId: carys.id,
        tenantId: 'not-a-law-firm',
        oid: carys.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: carys.id,
        email: carys.emails[0]?.address ?? 'carys.hughes@notalawfirm.example',
        displayName: 'Carys Hughes',
        entraRoles: ['partner', 'managing_partner', 'admin'],
        mappedRoles: ['partner', 'managing_partner', 'admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      }),
    )!;
    const actorSession = {
      personId: carys.id,
      tenantId: 'not-a-law-firm',
      tokenRoles: verifiedSession.mappedRoles,
      expiresAtMs: Date.parse(expiresAt),
      verifiedSession,
    };

    try {
      setAuditAdapterFailureHookForTesting(({ entries }) => {
        if (entries.some((e) => e.action === 'merge' || e.action === 'merged-into')) {
          throw new Error('SIMULATED_AUDIT_FAILURE_MERGE');
        }
      });

      const [unrelatedRes, mergeOutcome] = await Promise.allSettled([
        runWithActiveActorSession(actorSession, async () =>
          savePersonRecord(
            {
              ...unrelatedPerson,
              surname: 'R443-Unrelated-Preserved',
            },
            { id: unrelatedPerson.id, byId: carys.id, mfaVerified: true },
          ),
        ),
        runWithActiveActorSession(actorSession, async () =>
          executeMerge('person', survivor.id, merged.id, carys.id),
        ),
      ]);

      expect(unrelatedRes.status).toBe('fulfilled');
      if (unrelatedRes.status === 'fulfilled') {
        expect(unrelatedRes.value.errors).toBeUndefined();
        expect(unrelatedRes.value.person?.surname).toBe('R443-Unrelated-Preserved');
      }
      expect(mergeOutcome.status).toBe('rejected');

      setAuditAdapterFailureHookForTesting(null);
      clearStoreMemoryCache();
      const reloaded = getStore();
      expect(
        reloaded.people.find((p) => p.id === unrelatedPerson.id)?.surname,
      ).toBe('R443-Unrelated-Preserved');
      expect(
        reloaded.people.find((p) => p.id === merged.id)?.mergedIntoId,
      ).toBeFalsy();
      expect(
        reloaded.people.find((p) => p.id === survivor.id)?.surname,
      ).toBe(survivorBeforeName);
      expect(
        reloaded.mergeHistory.some(
          (mh) => mh.survivorId === survivor.id && mh.mergedId === merged.id,
        ),
      ).toBe(false);
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R452: listFirmAuditEntriesPage keeps fetching until 250 visible rows are collected when 300 rows include 100 restricted rows, and AdminCatchAllPage renders the Firm audit log section with Next link', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = getStore();
      // Admin viewer P-000004 has admin:access without matter:restricted:access and is NOT on restrictedAccessUserIds for staff matter M-000014
      const adminViewer = store.people.find((p) => p.id === 'P-000004')!;
      adminViewer.permissionOverrides = {
        grant: ['admin:access'],
        revoke: ['matter:restricted:access'],
      };
      const staffMatter = store.matters.find((m) => m.id === 'M-000014')!;
      staffMatter.isStaffMatter = true;
      staffMatter.responsiblePartnerId = 'P-000001';
      staffMatter.supervisingPartnerId = 'P-000001';
      staffMatter.leadFeeEarnerId = 'P-000001';
      staffMatter.teamMemberIds = ['P-000001'];
      staffMatter.restrictedAccessUserIds = ['P-000001'];
      const visibleMatter = store.matters.find(
        (m) => m.id !== 'M-000014' && !m.isStaffMatter && !m.hasEthicalWall,
      )!;
      saveStore(store);

      const ctx = testTenantCtx('P-000001');
      const batch300: FirmAuditEntryInput[] = [];
      // Append 200 visible matter audit rows and 100 restricted staff-matter audit rows (300 total)
      for (let i = 0; i < 300; i++) {
        const isRestricted = i % 3 === 0 && batch300.filter((x) => x.recordId === staffMatter.id).length < 100;
        batch300.push({
          recordType: 'matter',
          recordId: isRestricted ? staffMatter.id : visibleMatter.id,
          action: 'update',
          field: isRestricted ? `R452-restricted-${i}` : `R452-visible-${i}`,
          oldValue: null,
          newValue: `Invented batch value ${i}`,
          byId: 'P-000001',
          at: new Date(Date.now() + i).toISOString(),
        });
      }
      // Also ensure at least 50 more visible rows exist so 300 rows (with 100 restricted) plus earlier visible rows fill 250 visible rows on page 1
      const extraVisible: FirmAuditEntryInput[] = [];
      for (let i = 0; i < 60; i++) {
        extraVisible.push({
          recordType: 'matter',
          recordId: visibleMatter.id,
          action: 'update',
          field: `R452-extra-visible-${i}`,
          oldValue: null,
          newValue: `Invented extra value ${i}`,
          byId: 'P-000001',
          at: new Date(Date.now() - 10_000 + i).toISOString(),
        });
      }
      await getAuditRepository().appendAuditEntries(ctx, [...extraVisible, ...batch300]);

      const page1 = await runAsTestEmployee('P-000004', () =>
        listFirmAuditEntriesPage('P-000004', { limit: 250 }),
      );
      expect(page1.code).toBeUndefined();
      expect(page1.entries).toHaveLength(250);
      expect(page1.entries.some((e) => e.recordId === staffMatter.id)).toBe(false);
      expect(page1.nextBeforeSeq).not.toBeNull();

      // Verify AdminCatchAllPage renders the Firm audit log section and Next pagination link
      const adminPerson = store.people.find((p) => p.id === 'P-000004')!;
      const nowMs = Date.now();
      setTestEntraSessionOverride({
        tenantId: 'not-a-law-firm',
        personId: adminPerson.id,
        oid: adminPerson.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
        tid: '11111111-2222-4333-8444-555555555555',
        sub: adminPerson.id,
        email: adminPerson.emails?.[0]?.address ?? 'sian@notalawfirm.example.invalid',
        displayName: 'Siân Phillips',
        entraRoles: ['admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      });

      const pageEl = await AdminCatchAllPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({}),
      });
      const html = renderToStaticMarkup(pageEl);
      expect(html).toContain('Firm audit log');
      expect(html).toContain('data-testid="admin-firm-audit-log"');
      expect(html).toContain(`?auditBeforeSeq=${page1.nextBeforeSeq}`);
    } finally {
      setTestEntraSessionOverride(null);
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R457: listFirmAuditEntriesPage returns FORBIDDEN for non-admins, honours active session tokenRoles, and hides staff-matter rows from non-restricted viewers while showing them to an authorised admin control', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    try {
      const store = getStore();
      const nonRestrictedAdmin = store.people.find((p) => p.id === 'P-000004')!;
      nonRestrictedAdmin.permissionOverrides = {
        grant: ['admin:access'],
        revoke: ['matter:restricted:access'],
      };
      const staffMatter = store.matters.find((m) => m.id === 'M-000014')!;
      staffMatter.isStaffMatter = true;
      staffMatter.responsiblePartnerId = 'P-000001';
      staffMatter.supervisingPartnerId = 'P-000001';
      staffMatter.leadFeeEarnerId = 'P-000001';
      staffMatter.teamMemberIds = ['P-000001'];
      staffMatter.restrictedAccessUserIds = ['P-000001'];
      saveStore(store);

      const staffMarkerField = `R457-staff-audit-${Date.now().toString(36)}`;
      await getAuditRepository().appendAuditEntry(testTenantCtx('P-000001'), {
        recordType: 'matter',
        recordId: staffMatter.id,
        action: 'update',
        field: staffMarkerField,
        oldValue: null,
        newValue: 'Invented restricted staff matter update',
        byId: 'P-000001',
        at: new Date().toISOString(),
      });

      // 1. Non-admin call returns FORBIDDEN with code and message
      const feeEarnerPage = await runAsTestEmployee('P-000002', () =>
        listFirmAuditEntriesPage('P-000002', { limit: 50 }),
      );
      expect(feeEarnerPage.code).toBe('FORBIDDEN');
      expect(feeEarnerPage.message).toContain('admin:access');
      expect(feeEarnerPage.entries).toEqual([]);

      // 2. Staff-matter audit row is hidden from an admin who is not in restrictedAccessUserIds (P-000004)
      const nonRestrictedAdminRecord = await runAsTestEmployee('P-000004', () =>
        listAuditEntriesForRecord('matter', staffMatter.id, 'P-000004', { limit: 50 }),
      );
      expect(nonRestrictedAdminRecord).toEqual([]);
      const nonRestrictedAdminPage = await runAsTestEmployee('P-000004', () =>
        listFirmAuditEntriesPage('P-000004', {
          limit: 50,
        }),
      );
      expect(nonRestrictedAdminPage.code).toBeUndefined();
      expect(
        nonRestrictedAdminPage.entries.some((e) => e.field === staffMarkerField),
      ).toBe(false);

      // 3. Admin control on restrictedAccessUserIds (P-000001) sees the staff-matter audit row in both record and firm queries
      const restrictedAdminRecord = await runAsTestEmployee('P-000001', () =>
        listAuditEntriesForRecord('matter', staffMatter.id, 'P-000001', { limit: 50 }),
      );
      expect(
        restrictedAdminRecord.some((e) => e.field === staffMarkerField),
      ).toBe(true);
      const restrictedAdminPage = await runAsTestEmployee('P-000001', () =>
        listFirmAuditEntriesPage('P-000001', {
          limit: 50,
        }),
      );
      expect(restrictedAdminPage.code).toBeUndefined();
      expect(
        restrictedAdminPage.entries.some((e) => e.field === staffMarkerField),
      ).toBe(true);

      // 4. Active session tokenRoles are honoured when options.tokenRoles is omitted
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const verifiedSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: feeEarner.id,
          tenantId: 'not-a-law-firm',
          oid: feeEarner.entraObjectId ?? '00000000-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: feeEarner.id,
          email: feeEarner.emails[0]?.address ?? 'fee@notalawfirm.example',
          displayName: 'Fee Earner',
          entraRoles: ['admin', 'risk_compliance'],
          mappedRoles: ['admin', 'risk_compliance'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: nowIso,
          expiresAt,
        }),
      )!;
      const sessionElevatedPage = await runWithActiveActorSession(
        {
          personId: feeEarner.id,
          tenantId: 'not-a-law-firm',
          tokenRoles: ['admin', 'risk_compliance'],
          expiresAtMs: Date.parse(expiresAt),
          verifiedSession,
        },
        () => listFirmAuditEntriesPage(feeEarner.id, { limit: 50 }),
      );
      expect(sessionElevatedPage.code).toBeUndefined();
      expect(
        sessionElevatedPage.entries.some((e) => e.field === staffMarkerField),
      ).toBe(true);
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R445: service functions reject with UNAUTHENTICATED when called without a verified Entra ID session or test override, and succeed with an explicit actor session', async () => {
    setTestEntraSessionOverride(undefined);
    await expect(getAppSnapshot('P-000001')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'UNAUTHENTICATED: Verified Entra ID session is required for tenant data access.',
    });

    const targetPerson = structuredClone(
      getStore().people.find((p) => !p.isEmployee && !p.mergedIntoId)!,
    );
    await expect(
      savePersonRecord(
        {
          ...targetPerson,
          surname: 'R445-Unauthenticated-Rejected',
        },
        { id: targetPerson.id, byId: 'P-000001', mfaVerified: true },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'UNAUTHENTICATED: Verified Entra ID session is required for tenant data access.',
    });

    // Positive control: explicit verified session for P-000001 succeeds
    const snap = await runAsTestEmployee('P-000001', () => getAppSnapshot('P-000001'));
    expect(snap.people.length).toBeGreaterThan(0);
  });
});
