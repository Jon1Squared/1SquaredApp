import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateTenantRbacConfigAction } from '@/app/actions';
import { GET as matterDocumentsGet } from '@/app/api/matters/[id]/documents/route';
import { isActionDenied } from '@/domain/actionResult';
import {
  setActiveTenantConfigForTesting,
  getActiveTenantRawBaseConfig,
} from '@/platform/tenantRuntime';
import {
  authorizeResource,
  guardedAction,
  guardedRoute,
} from '@/server/authorize';
import {
  setTestEntraSessionOverride,
  type EntraSessionPayload,
} from '@/server/entraAuth';
import { resolvePersonPermissionSet } from '@/server/rbacRuntime';
import { getStore } from '@/server/store';

function makeSession(
  overrides: Partial<EntraSessionPayload> = {},
): EntraSessionPayload {
  return {
    personId: 'P-000002', // Dafydd Evans — fee_earner
    tenantId: 'not-a-law-firm',
    oid: '00000000-0000-4000-8000-000000000002',
    tid: '00000000-0000-4000-8000-000000000099',
    sub: 'P-000002',
    email: 'dafydd.evans@notalawfirm.example',
    displayName: 'Dafydd Evans',
    entraRoles: [],
    mappedRoles: ['fee_earner'],
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

describe('S0-02: authorize.ts runtime enforcement (ADR 0025)', () => {
  beforeEach(() => {
    setTestEntraSessionOverride(null);
    setActiveTenantConfigForTesting(null);
  });

  afterEach(() => {
    setTestEntraSessionOverride(null);
    setActiveTenantConfigForTesting(null);
    vi.restoreAllMocks();
  });

  it('1. no session gives UNAUTHENTICATED for enforcedBy: "action", and fn is not called', async () => {
    setTestEntraSessionOverride(undefined);
    const fn = vi.fn<() => { ok: boolean }>(() => ({ ok: true }));

    const result = await guardedAction('updateTenantRbacConfigAction', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(isActionDenied(result)).toBe(true);
    if (isActionDenied(result)) {
      expect(result.code).toBe('UNAUTHENTICATED');
      expect(result.error).toMatch(/^UNAUTHENTICATED:/);
    }
  });

  it('2. a missing permission gives FORBIDDEN for enforcedBy: "action", and fn is not called', async () => {
    // P-000002 is fee_earner and does not hold rbac:manage_config
    setTestEntraSessionOverride(makeSession());
    const fn = vi.fn<() => { ok: boolean }>(() => ({ ok: true }));

    const result = await guardedAction('updateTenantRbacConfigAction', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(isActionDenied(result)).toBe(true);
    if (isActionDenied(result)) {
      expect(result.code).toBe('FORBIDDEN');
      expect(result.error).toContain('rbac:manage_config');
    }

    // Pilot server action updateTenantRbacConfigAction also returns ActionDenied
    const pilotRes = await updateTenantRbacConfigAction({});
    expect(isActionDenied(pilotRes)).toBe(true);
    expect(pilotRes.ok).toBe(false);
    expect(pilotRes.code).toBe('FORBIDDEN');
  });

  it('3. an MFA-required key with mfaVerified: false gives MFA_REQUIRED', async () => {
    // P-000004 (Catrin Williams) is admin and holds rbac:manage_config, which has requiresMfa: true
    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000004',
        sub: 'P-000004',
        oid: '00000000-0000-4000-8000-000000000004',
        email: 'catrin.williams@notalawfirm.example',
        displayName: 'Catrin Williams',
        mappedRoles: ['admin'],
        mfaVerified: false,
        amr: ['pwd'],
      }),
    );

    const fn = vi.fn<() => { ok: boolean }>(() => ({ ok: true }));
    const result = await guardedAction('updateTenantRbacConfigAction', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(isActionDenied(result)).toBe(true);
    if (isActionDenied(result)) {
      expect(result.code).toBe('MFA_REQUIRED');
      expect(result.error).toMatch(/^MFA_REQUIRED:/);
    }
  });

  it('4. a viewing-as role or previewRole never grants a permission (ADR 0013)', async () => {
    const store = getStore() as ReturnType<typeof getStore> & {
      activeViewingRoleByUser?: Record<string, string>;
    };
    const feeEarner = store.people.find((p) => p.id === 'P-000002') as
      | ((typeof store.people)[number] & { activeViewingRole?: string })
      | undefined;
    const prevViewingRole = feeEarner?.activeViewingRole;
    const prevStoreViewingMap = store.activeViewingRoleByUser;
    if (feeEarner) {
      feeEarner.activeViewingRole = 'admin';
    }
    store.activeViewingRoleByUser = {
      ...(store.activeViewingRoleByUser ?? {}),
      'P-000002': 'admin',
    };

    try {
      setTestEntraSessionOverride(makeSession());
      const fn = vi.fn<(_args: { previewRole?: string }) => { ok: boolean }>(
        () => ({
          ok: true,
        }),
      );

      const result = await guardedAction('updateTenantRbacConfigAction', () =>
        fn({ previewRole: 'admin' }),
      );
      expect(fn).not.toHaveBeenCalled();
      expect(isActionDenied(result)).toBe(true);
      if (isActionDenied(result)) {
        expect(result.code).toBe('FORBIDDEN');
      }
    } finally {
      if (feeEarner) {
        feeEarner.activeViewingRole = prevViewingRole;
      }
      store.activeViewingRoleByUser = prevStoreViewingMap;
    }
  });

  it('5. the tenant context comes from the session, and a tenantId passed in arguments is ignored (forged tenant claim)', async () => {
    const baseCfg = getActiveTenantRawBaseConfig();
    setActiveTenantConfigForTesting(baseCfg);

    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000004',
        sub: 'P-000004',
        email: 'catrin.williams@notalawfirm.example',
        displayName: 'Catrin Williams',
        mappedRoles: ['admin'],
        mfaVerified: true,
      }),
    );

    const callerSuppliedArg = { tenantId: 'forged-other-tenant' };
    const observed = await guardedAction(
      'updateTenantRbacConfigAction',
      (actor) => ({
        argTenantId: callerSuppliedArg.tenantId,
        resolvedTenantId: actor.tenantContext.tenantId,
        permissionsTenantId: actor.permissions.tenantId,
      }),
    );

    expect(observed.resolvedTenantId).toBe('not-a-law-firm');
    expect(observed.permissionsTenantId).toBe('not-a-law-firm');
    expect(observed.resolvedTenantId).not.toBe(callerSuppliedArg.tenantId);

    // Forged session claiming another tenant is rejected by resolveCurrentTenantContext
    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000004',
        sub: 'P-000004',
        tenantId: 'other-tenant-id',
        mappedRoles: ['admin'],
        mfaVerified: true,
      }),
    );

    await expect(
      guardedAction('updateTenantRbacConfigAction', () => ({ ok: true })),
    ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/i);
  });

  it('6. gap and enforcedBy: "service" policies still require sign-in, and otherwise behave exactly as before, including thrown errors', async () => {
    // Unauthenticated calls to gap and enforcedBy: 'service' throw UNAUTHENTICATED without calling fn
    setTestEntraSessionOverride(undefined);
    const gapFn = vi.fn(() => 'gap-result');
    await expect(guardedAction('requestMatterBillAction', gapFn)).rejects.toThrow(
      /UNAUTHENTICATED/i,
    );
    expect(gapFn).not.toHaveBeenCalled();

    const serviceFn = vi.fn(() => 'service-result');
    await expect(guardedAction('saveMatterAction', serviceFn)).rejects.toThrow(
      /UNAUTHENTICATED/i,
    );
    expect(serviceFn).not.toHaveBeenCalled();

    // Authenticated calls pass return values and thrown errors through unchanged
    setTestEntraSessionOverride(makeSession());
    const okRes = await guardedAction('requestMatterBillAction', () => ({
      customShape: 42,
    }));
    expect(okRes).toEqual({ customShape: 42 });

    await expect(
      guardedAction('saveMatterAction', () => {
        throw new Error('CUSTOM_SERVICE_VALIDATION_FAILURE');
      }),
    ).rejects.toThrow('CUSTOM_SERVICE_VALIDATION_FAILURE');
  });

  it('7. a service that resolves permissions without passing mfaVerified sees the session’s real MFA state', async () => {
    const store = getStore();
    const adminPerson = store.people.find((p) => p.id === 'P-000004')!;

    // Session with mfaVerified: true
    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000004',
        sub: 'P-000004',
        mappedRoles: ['admin'],
        mfaVerified: true,
      }),
    );

    const mfaTrueResult = await guardedAction('saveMatterAction', () => {
      // Service resolves permissions without passing mfaVerified or context
      const perms = resolvePersonPermissionSet(adminPerson, {
        allPeople: store.people,
        teams: store.teams,
      });
      return {
        mfaVerified: perms.mfaVerified,
        adminAccessPendingMfa: perms.mfaPendingPermissions.has('admin:access'),
      };
    });
    expect(mfaTrueResult.mfaVerified).toBe(true);
    expect(mfaTrueResult.adminAccessPendingMfa).toBe(false);

    // Session with mfaVerified: false
    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000004',
        sub: 'P-000004',
        mappedRoles: ['admin'],
        mfaVerified: false,
      }),
    );

    const mfaFalseResult = await guardedAction('saveMatterAction', () => {
      const perms = resolvePersonPermissionSet(adminPerson, {
        allPeople: store.people,
        teams: store.teams,
      });
      return {
        mfaVerified: perms.mfaVerified,
        adminAccessPendingMfa: perms.mfaPendingPermissions.has('admin:access'),
      };
    });
    expect(mfaFalseResult.mfaVerified).toBe(false);
    expect(mfaFalseResult.adminAccessPendingMfa).toBe(true);
  });

  it('8. guardedRoute passes params through, and the matter documents route’s existing 401/403 responses are unchanged', async () => {
    const wrapped = guardedRoute(
      'GET /api/matters/[id]/documents',
      async (_req: Request, context: { params: Promise<{ id: string }> }) => {
        const { id } = await context.params;
        return NextResponse.json({ receivedId: id });
      },
    );

    const customRes = await wrapped(
      new Request('http://localhost:3000/api/matters/MAT-999/documents'),
      { params: Promise.resolve({ id: 'MAT-999' }) },
    );
    expect(await customRes.json()).toEqual({ receivedId: 'MAT-999' });

    // Real matter documents route keeps its existing 401 body when unauthenticated
    setTestEntraSessionOverride(undefined);
    const unauthRes = await matterDocumentsGet(
      new NextRequest('http://localhost:3000/api/matters/M-000001/documents', {
        headers: { 'x-correlation-id': 'test-corr-id-401' },
      }),
      { params: Promise.resolve({ id: 'M-000001' }) },
    );
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as {
      ok: boolean;
      code: string;
    };
    expect(unauthBody.ok).toBe(false);
    expect(unauthBody.code).toBe('reauthentication_required');

    // And existing 403 access_denied response is unchanged
    setTestEntraSessionOverride(makeSession());
    const forbiddenRes = await matterDocumentsGet(
      new NextRequest(
        'http://localhost:3000/api/matters/M-000001/documents?action=download&locationId=bad-loc&itemId=bad-item',
        {
          headers: { 'x-correlation-id': 'test-corr-id-403' },
        },
      ),
      { params: Promise.resolve({ id: 'M-000001' }) },
    );
    expect(forbiddenRes.status).toBe(403);
    const forbiddenBody = (await forbiddenRes.json()) as {
      ok: boolean;
      code: string;
    };
    expect(forbiddenBody.ok).toBe(false);
    expect(forbiddenBody.code).toBe('access_denied');
  });

  it('9. the denial log contains correlationId, tenantId, action and code, and no personal name or email address', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTestEntraSessionOverride(
      makeSession({
        personId: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
      }),
    );

    const res = await guardedAction('updateTenantRbacConfigAction', () => ({
      ok: true,
    }));
    expect(isActionDenied(res)).toBe(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedRaw = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(loggedRaw).not.toContain('Dafydd');
    expect(loggedRaw).not.toContain('Evans');
    expect(loggedRaw).not.toContain('dafydd.evans@notalawfirm.example');
    expect(loggedRaw).not.toContain('P-000002');

    const parsed = JSON.parse(loggedRaw) as {
      event: string;
      correlationId: string;
      tenantId: string;
      action: string;
      code: string;
    };
    expect(parsed.event).toBe('authorisation.denied');
    expect(parsed.tenantId).toBe('not-a-law-firm');
    expect(parsed.action).toBe('updateTenantRbacConfigAction');
    expect(parsed.code).toBe('FORBIDDEN');
    expect(parsed.correlationId).toMatch(/^corr-act-/);
  });

  it('authorizeResource enforces restricted staff matter access via canAccessMatter', async () => {
    setTestEntraSessionOverride(makeSession());
    await guardedAction('saveMatterAction', (actor) => {
      // Standard matter is accessible
      expect(() =>
        authorizeResource(actor.permissions, {
          id: 'M-OPEN-1',
          isStaffMatter: false,
        }),
      ).not.toThrow();

      // Restricted staff matter where P-000002 is not on the allow-list is denied
      expect(() =>
        authorizeResource(actor.permissions, {
          id: 'M-STAFF-1',
          isStaffMatter: true,
          restrictedAccessUserIds: ['P-000001'],
        }),
      ).toThrow(/permission to access this matter/i);
    });
  });
});
