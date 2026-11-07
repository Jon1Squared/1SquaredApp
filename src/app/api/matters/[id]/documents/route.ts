/**
 * Matter Documents API Route (`src/app/api/matters/[id]/documents/route.ts`).
 *
 * All user-facing document operations execute through `executeUserMatterDocumentOperation`
 * using the signed-in user's OBO delegated identity (`kind: 'user'`).
 * Never uses the application provisioning credential for user-facing requests.
 */

import { NextRequest, NextResponse } from 'next/server';
import { normaliseDocumentStoreError } from '@platform/core';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { guardedRoute } from '@/server/authorize';
import {
  browseMatterDocumentStoreFolder,
  downloadMatterStoreDocument,
  linkExistingMatterDocumentFolder,
  mutateMatterStoreItem,
  retryMatterDocumentProvisioning,
  uploadMatterStoreDocument,
} from '@/server/documentStoreServices';
import { withAuthenticatedActor } from '@/server/services';

function logMatterDocumentsRouteError(
  method: 'GET' | 'POST',
  tenantId: string,
  correlationId: string,
  code: string,
): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'matter_documents.route_error',
      route: '/api/matters/[id]/documents',
      method,
      tenantId,
      correlationId,
      code,
    }),
  );
}

const VALID_CORRELATION_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function resolveSafeCorrelationId(
  headerValue: string | null,
  fallbackPrefix: string,
): string {
  const trimmed = headerValue?.trim() ?? '';
  if (VALID_CORRELATION_ID_RE.test(trimmed)) {
    return trimmed;
  }
  return `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const GET = guardedRoute(
  'GET /api/matters/[id]/documents',
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const correlationId = resolveSafeCorrelationId(
      request.headers.get('x-correlation-id'),
      'corr-matter-docs-get',
    );
    let tenantId = 'unknown';
    try {
      tenantId = getActiveTenantConfiguration().tenantId;
      const { id: matterId } = await context.params;
      return await withAuthenticatedActor(async (actor) => {
        tenantId = actor.tenantId || tenantId;
        const userId = actor.personId;
        const session = actor.session;
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action');

        if (action === 'download') {
          const locationId = searchParams.get('locationId') ?? '';
          const itemId = searchParams.get('itemId') ?? '';
          const downloaded = await downloadMatterStoreDocument({
            matterId,
            locationId,
            itemId,
            userId,
            session,
            correlationId,
          });

          return new NextResponse(Buffer.from(downloaded.bytes), {
            status: 200,
            headers: {
              'Content-Type': downloaded.mimeType || 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(downloaded.fileName)}"`,
              'Cache-Control': 'no-store',
            },
          });
        }

        const locationId = searchParams.get('locationId') || undefined;
        const folderItemId = searchParams.get('folderItemId') || undefined;
        const cursor = searchParams.get('cursor') || undefined;

        const browseResult = await browseMatterDocumentStoreFolder({
          matterId,
          locationId,
          folderItemId,
          cursor,
          userId,
          session,
          correlationId,
        });

        return NextResponse.json({ ok: true, ...browseResult });
      });
    } catch (err) {
      const normalised = normaliseDocumentStoreError(err);
      const isUnauth =
        (err instanceof Error &&
          (err.message.startsWith('UNAUTHENTICATED:') ||
            err.message.startsWith('[UNAUTHENTICATED]'))) ||
        (err as { code?: string } | null)?.code === 'UNAUTHENTICATED';
      const code = isUnauth ? 'reauthentication_required' : normalised.code;
      logMatterDocumentsRouteError('GET', tenantId, correlationId, code);
      return NextResponse.json(
        {
          ok: false,
          code,
          error: normalised.userMessage,
          claimsChallenge: normalised.claimsChallenge,
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
  'POST /api/matters/[id]/documents',
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const correlationId = resolveSafeCorrelationId(
      request.headers.get('x-correlation-id'),
      'corr-matter-docs-post',
    );
  let tenantId = 'unknown';
  try {
    tenantId = getActiveTenantConfiguration().tenantId;
    const { id: matterId } = await context.params;
    return await withAuthenticatedActor(async (actor) => {
      tenantId = actor.tenantId || tenantId;
      const userId = actor.personId;
      const mfaVerified = actor.mfaVerified;
      const session = actor.session;
      const contentType = request.headers.get('content-type') ?? '';

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        const locationId = String(formData.get('locationId') ?? '');
        const folderItemId = String(formData.get('folderItemId') ?? '');
        const conflictBehavior =
          (formData.get('conflictBehavior') as
            | 'fail'
            | 'rename'
            | 'replace'
            | null) ?? 'rename';

        if (!file) {
          return NextResponse.json(
            { ok: false, error: 'No file supplied for upload.' },
            { status: 400 },
          );
        }

        const arrayBuffer = await file.arrayBuffer();
        const uploaded = await uploadMatterStoreDocument({
          matterId,
          locationId,
          folderItemId,
          fileName: file.name,
          bytes: new Uint8Array(arrayBuffer),
          mimeType: file.type || 'application/octet-stream',
          conflictBehavior,
          userId,
          session,
          correlationId,
        });

        return NextResponse.json({ ok: true, item: uploaded });
      }

      const body = (await request.json()) as Record<string, unknown>;
      const action = String(body.action ?? '');

      switch (action) {
        case 'upload_base64': {
          const locationId = String(body.locationId ?? '');
          const folderItemId = String(body.folderItemId ?? '');
          const fileName = String(body.fileName ?? 'Document.bin');
          const base64 = String(body.base64 ?? '');
          const mimeType = body.mimeType
            ? String(body.mimeType)
            : 'application/octet-stream';
          const conflictBehavior =
            (body.conflictBehavior as 'fail' | 'rename' | 'replace' | undefined) ??
            'rename';

          const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
          const item = await uploadMatterStoreDocument({
            matterId,
            locationId,
            folderItemId,
            fileName,
            bytes,
            mimeType,
            conflictBehavior,
            userId,
            session,
            correlationId,
          });
          return NextResponse.json({ ok: true, item });
        }

        case 'create_folder':
        case 'rename':
        case 'move':
        case 'delete':
        case 'get_web_url': {
          const res = await mutateMatterStoreItem({
            matterId,
            locationId: String(body.locationId ?? ''),
            action,
            itemId: body.itemId ? String(body.itemId) : undefined,
            parentFolderItemId: body.parentFolderItemId
              ? String(body.parentFolderItemId)
              : undefined,
            destinationFolderItemId: body.destinationFolderItemId
              ? String(body.destinationFolderItemId)
              : undefined,
            name: body.name ? String(body.name) : undefined,
            userId,
            session,
            correlationId,
          });
          return NextResponse.json({ ok: true, ...res });
        }

        case 'retry_provisioning': {
          const retried = await retryMatterDocumentProvisioning(matterId, userId, {
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, ...retried });
        }

        case 'link_existing_folder': {
          const linked = await linkExistingMatterDocumentFolder({
            matterId,
            storeId: String(body.storeId ?? ''),
            libraryId: String(body.libraryId ?? ''),
            folderUrlOrPath: String(body.folderUrlOrPath ?? ''),
            applyMissingTemplateFolders:
              body.applyMissingTemplateFolders !== false,
            userId,
            session,
            mfaVerified,
            correlationId,
          });
          return NextResponse.json({ ok: true, ...linked });
        }

        default:
          return NextResponse.json(
            { ok: false, error: `Unknown matter document action "${action}".` },
            { status: 400 },
          );
      }
    });
  } catch (err) {
    const normalised = normaliseDocumentStoreError(err);
    const isUnauth =
      err instanceof Error && err.message.startsWith('UNAUTHENTICATED:');
    const code = isUnauth ? 'reauthentication_required' : normalised.code;
    logMatterDocumentsRouteError('POST', tenantId, correlationId, code);
    return NextResponse.json(
      {
        ok: false,
        code,
        error: normalised.userMessage,
        claimsChallenge: normalised.claimsChallenge,
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
