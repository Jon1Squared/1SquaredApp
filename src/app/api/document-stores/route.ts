/**
 * Admin API Route for Document Stores, Routing & Access, Folder Templates, and Access Review
 * (`src/app/api/document-stores/route.ts`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { normaliseDocumentStoreError } from '@platform/core';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { guardedRoute } from '@/server/authorize';
import { resolveRequestCorrelationId } from '@/server/correlationId';
import {
  applyAdminTemplateAdditionsToOpenMatters,
  getDocumentStoresAdminDashboard,
  previewAdminMatterFolderTemplate,
  remediateAdminReconciliationFinding,
  resolveAdminSharePointLocationUrl,
  runAdminDocumentReconciliationScan,
  saveAdminDocumentStoreConfiguration,
  testAdminDocumentStoreConnection,
} from '@/server/documentStoreServices';
import { withAuthenticatedActor } from '@/server/services';

function logDocumentStoreRouteError(
  route: string,
  method: 'GET' | 'POST',
  tenantId: string,
  correlationId: string,
  code: string,
): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'document_store.route_error',
      route,
      method,
      tenantId,
      correlationId,
      code,
    }),
  );
}

export const GET = guardedRoute(
  'GET /api/document-stores',
  async (request: NextRequest) => {
    const correlationId = resolveRequestCorrelationId(
      request.headers.get('x-correlation-id'),
      'corr-doc-stores-get',
    );
    let tenantId = 'unknown';
    try {
      tenantId = getActiveTenantConfiguration().tenantId;
      return await withAuthenticatedActor(async (actor) => {
        tenantId = actor.tenantId || tenantId;
        const userId = actor.personId;
        const mfaVerified = actor.mfaVerified;
        const { searchParams } = new URL(request.url);
        const mode = searchParams.get('mode');

        if (mode === 'preview_template') {
          const departmentId = searchParams.get('departmentId') || undefined;
          const workTypeId = searchParams.get('workTypeId') || undefined;
          const preview = previewAdminMatterFolderTemplate({
            departmentId,
            workTypeId,
            userId,
            session: actor.session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, preview });
        }

        const dashboard = getDocumentStoresAdminDashboard(userId, {
          session: actor.session,
          mfaVerified,
          correlationId,
        });
        return NextResponse.json({ ok: true, dashboard });
      });
    } catch (err) {
      const normalised = normaliseDocumentStoreError(err);
      const isUnauth =
        (err instanceof Error &&
          (err.message.startsWith('UNAUTHENTICATED:') ||
            err.message.startsWith('[UNAUTHENTICATED]'))) ||
        (err as { code?: string } | null)?.code === 'UNAUTHENTICATED';
      const code = isUnauth ? 'reauthentication_required' : normalised.code;
      logDocumentStoreRouteError(
        '/api/document-stores',
        'GET',
        tenantId,
        correlationId,
        code,
      );
      return NextResponse.json(
        {
          ok: false,
          code,
          error: normalised.userMessage,
        },
        {
          status: isUnauth
            ? 401
            : normalised.code === 'access_denied'
              ? 403
              : 400,
        },
      );
    }
  },
);

export const POST = guardedRoute(
  'POST /api/document-stores',
  async (request: NextRequest) => {
    const correlationId = resolveRequestCorrelationId(
      request.headers.get('x-correlation-id'),
      'corr-doc-stores-post',
    );
  let tenantId = 'unknown';
  try {
    tenantId = getActiveTenantConfiguration().tenantId;
    return await withAuthenticatedActor(async (actor) => {
      tenantId = actor.tenantId || tenantId;
      const userId = actor.personId;
      const mfaVerified = actor.mfaVerified;
      const session = actor.session;
      const body = (await request.json()) as Record<string, unknown>;
      const action = String(body.action ?? '');

      switch (action) {
        case 'test_connection': {
          const storeId = String(body.storeId ?? '');
          const result = await testAdminDocumentStoreConnection({
            storeId,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          const dashboard = getDocumentStoresAdminDashboard(userId, {
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, result, dashboard });
        }

        case 'resolve_location': {
          const rawUrlOrPath = String(body.rawUrlOrPath ?? '');
          const storeId = body.storeId ? String(body.storeId) : undefined;
          const resolved = await resolveAdminSharePointLocationUrl({
            storeId,
            rawUrlOrPath,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, ...resolved });
        }

        case 'save_config': {
          const section = body.section as
            | 'stores'
            | 'routing_and_access'
            | 'templates';
          const dashboard = saveAdminDocumentStoreConfiguration({
            section,
            documentStores: body.documentStores as never,
            documentRouting: body.documentRouting as never,
            matterFolderNameTemplate: body.matterFolderNameTemplate as never,
            documentAccess: body.documentAccess as never,
            matterFolderTemplates: body.matterFolderTemplates as never,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, dashboard });
        }

        case 'preview_template': {
          const preview = previewAdminMatterFolderTemplate({
            departmentId: body.departmentId
              ? String(body.departmentId)
              : undefined,
            workTypeId: body.workTypeId ? String(body.workTypeId) : undefined,
            templatesConfigOverride: body.templatesConfig as never,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, preview });
        }

        case 'apply_template_additions': {
          const applied = await applyAdminTemplateAdditionsToOpenMatters(userId, {
            session,
            mfaVerified,
            correlationId,
          });
          const dashboard = getDocumentStoresAdminDashboard(userId, {
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, applied, dashboard });
        }

        case 'run_reconciliation': {
          const storeId = body.storeId ? String(body.storeId) : undefined;
          const autoRemediate = Boolean(body.autoRemediate);
          const scan = await runAdminDocumentReconciliationScan({
            storeId,
            autoRemediate,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          const dashboard = getDocumentStoresAdminDashboard(userId, {
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, scan, dashboard });
        }

        case 'remediate_finding': {
          const findingId = String(body.findingId ?? '');
          const finding = await remediateAdminReconciliationFinding({
            findingId,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          const dashboard = getDocumentStoresAdminDashboard(userId, {
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, finding, dashboard });
        }

        default:
          return NextResponse.json(
            { ok: false, error: `Unknown action "${action}".` },
            { status: 400 },
          );
      }
    });
  } catch (err) {
    const normalised = normaliseDocumentStoreError(err);
    const isUnauth =
      err instanceof Error && err.message.startsWith('UNAUTHENTICATED:');
    const code = isUnauth ? 'reauthentication_required' : normalised.code;
    logDocumentStoreRouteError(
      '/api/document-stores',
      'POST',
      tenantId,
      correlationId,
      code,
    );
    return NextResponse.json(
      {
        ok: false,
        code,
        error: normalised.userMessage,
      },
      {
        status: isUnauth
          ? 401
          : normalised.code === 'access_denied'
            ? 403
            : 400,
      },
    );
  }
});
