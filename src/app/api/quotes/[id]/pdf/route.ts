import { NextResponse } from 'next/server';
import { emitTenantTelemetryException } from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import { guardedRoute } from '@/server/authorize';
import { generateQuotePdfDownloadRecord } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = guardedRoute(
  'GET /api/quotes/[id]/pdf',
  async (_request, context, actor) => {
    try {
      const resolvedParams = await Promise.resolve(
        (context as { params?: Promise<{ id?: string }> | { id?: string } })?.params,
      );
      const quoteId =
        typeof resolvedParams?.id === 'string'
          ? decodeURIComponent(resolvedParams.id).trim()
          : '';
      if (!quoteId) {
        return NextResponse.json(
          { ok: false, code: 'NOT_FOUND', error: 'Quote not found.' },
          { status: 404 },
        );
      }

      const result = await generateQuotePdfDownloadRecord(quoteId, actor?.personId, {
        tenantCtx: actor?.tenantContext,
      });

      if (isActionDenied(result)) {
        const status = result.code === 'UNAUTHENTICATED' ? 401 : 403;
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
              error: 'Something went wrong while generating the quote PDF. Please try again.',
            },
            { status: 500 },
          );
        }
        const status =
          result.code === 'UNAUTHENTICATED'
            ? 401
            : result.code === 'FORBIDDEN'
              ? 403
              : result.code === 'NOT_FOUND'
                ? 404
                : 400;
        return NextResponse.json(
          { ok: false, code: result.code, error: result.message },
          { status },
        );
      }

      const rawName = result.fileName.replace(/[\r\n]/g, '_').trim() || 'Quote.pdf';
      const asciiFallback =
        rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'Quote.pdf';
      const utf8Encoded = encodeURIComponent(rawName).replace(
        /['()*!]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new NextResponse(Buffer.from(result.pdfBytes), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store, max-age=0',
        },
      });
    } catch (err) {
      if (actor?.tenantContext?.tenantId && actor?.tenantContext?.correlationId) {
        try {
          emitTenantTelemetryException({
            eventName: 'api.quotes.pdf.unhandled_error',
            tenantId: actor.tenantContext.tenantId,
            correlationId: actor.tenantContext.correlationId,
            error: err,
          });
        } catch {
          // Never fail error responses if telemetry logging fails.
        }
      }
      return NextResponse.json(
        {
          ok: false,
          code: 'INTERNAL_ERROR',
          error: 'Something went wrong while generating the quote PDF. Please try again.',
        },
        { status: 500 },
      );
    }
  },
);
