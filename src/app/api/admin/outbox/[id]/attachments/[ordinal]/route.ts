import { NextResponse } from 'next/server';
import { emitTenantTelemetryException } from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import { guardedRoute } from '@/server/authorize';
import { downloadOutboxAttachmentForAdminRecord } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * R823 & R826: Downloads an inline attachment from a linked outbox message non-destructively
 * (no status mutation) for an MFA-verified administrator whose visibility includes the
 * underlying matter, quote, or enquiry. Unlinked, hidden, or cross-tenant IDs fail closed
 * with uniform 404 NOT_FOUND, and every download writes an audit entry.
 */
export const GET = guardedRoute(
  'GET /api/admin/outbox/[id]/attachments/[ordinal]',
  async (_request, context, actor) => {
    try {
      const resolvedParams = await Promise.resolve(
        (context as { params?: Promise<{ id?: string; ordinal?: string }> | { id?: string; ordinal?: string } })?.params,
      );
      const outboxId = String(resolvedParams?.id ?? '').trim();
      const ordinalRaw = String(resolvedParams?.ordinal ?? '').trim();
      if (!outboxId || !/^\d+$/.test(ordinalRaw)) {
        return NextResponse.json(
          { ok: false, code: 'NOT_FOUND', error: 'Outbox attachment was not found.' },
          { status: 404 },
        );
      }
      const ordinal = Number(ordinalRaw);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        return NextResponse.json(
          { ok: false, code: 'NOT_FOUND', error: 'Outbox attachment was not found.' },
          { status: 404 },
        );
      }

      const result = await downloadOutboxAttachmentForAdminRecord(
        { outboxId, ordinal },
        actor?.personId,
        actor?.tenantContext
          ? {
              tenantCtx: actor.tenantContext,
              mfaVerified: actor.mfaVerified,
            }
          : undefined,
      );

      if (isActionDenied(result)) {
        const status =
          result.code === 'UNAUTHENTICATED'
            ? 401
            : result.code === 'MFA_REQUIRED' || result.code === 'FORBIDDEN'
              ? 403
              : 404;
        return NextResponse.json(
          { ok: false, denied: true, code: result.code, error: result.message },
          { status },
        );
      }
      if (!result.ok) {
        if (result.code === 'INTERNAL_ERROR') {
          return NextResponse.json(
            {
              ok: false,
              code: 'INTERNAL_ERROR',
              error: 'Something went wrong while downloading the attachment. Please try again.',
            },
            { status: 500 },
          );
        }
        const status =
          result.code === 'UNAUTHENTICATED'
            ? 401
            : result.code === 'MFA_REQUIRED' || result.code === 'FORBIDDEN'
              ? 403
              : result.code === 'NOT_FOUND'
                ? 404
                : 400;
        return NextResponse.json(
          { ok: false, code: result.code, error: result.message },
          { status },
        );
      }

      const rawName =
        result.attachment.fileName.replace(/[\r\n]/g, '_').trim() || 'attachment.pdf';
      const asciiFallback =
        rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'attachment.pdf';
      const utf8Encoded = encodeURIComponent(rawName).replace(
        /['()*!]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new NextResponse(Buffer.from(result.attachment.contentBytes), {
        status: 200,
        headers: {
          'Content-Type': result.attachment.contentType || 'application/pdf',
          'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    } catch (err) {
      if (actor?.tenantContext?.tenantId && actor?.tenantContext?.correlationId) {
        try {
          emitTenantTelemetryException({
            eventName: 'api.admin.outbox.attachment.unhandled_error',
            tenantId: actor.tenantContext.tenantId,
            correlationId: actor.tenantContext.correlationId,
            error: err,
          });
        } catch {
          // Never mask unhandled errors behind telemetry failures.
        }
      }
      return NextResponse.json(
        {
          ok: false,
          code: 'INTERNAL_ERROR',
          error: 'Something went wrong while downloading the attachment. Please try again.',
        },
        { status: 500 },
      );
    }
  },
);
