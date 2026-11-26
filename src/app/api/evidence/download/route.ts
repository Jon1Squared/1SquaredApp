import { NextResponse } from 'next/server';
import { emitTenantTelemetryException } from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import { guardedRoute } from '@/server/authorize';
import { downloadEvidenceArtifactRecord } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = guardedRoute('GET /api/evidence/download', async (request, _context, actor) => {
  try {
    // R817: Ignore any `purpose` query parameter; permission and subject branching uses ONLY
    // the stored `evidence_artifacts.purpose` column resolved after token verification.
    const url = new URL(request.url);
    const token = url.searchParams.get('token')?.trim() ?? '';
    if (!token) {
      return NextResponse.json(
        { ok: false, code: 'VALIDATION_ERROR', error: 'Missing scoped evidence download token.' },
        { status: 400 },
      );
    }

    const result = await downloadEvidenceArtifactRecord(
      { token },
      actor?.personId,
      actor?.tenantContext ? { tenantCtx: actor.tenantContext } : undefined,
    );

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
            error: 'Something went wrong while downloading the file. Please try again.',
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

    const rawName = result.artifact.fileName.replace(/[\r\n]/g, '_').trim() || 'evidence.bin';
    const asciiFallback =
      rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'evidence.bin';
    const utf8Encoded = encodeURIComponent(rawName).replace(
      /['()*!]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new NextResponse(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.artifact.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err) {
    if (actor?.tenantContext?.tenantId && actor?.tenantContext?.correlationId) {
      try {
        emitTenantTelemetryException({
          eventName: 'api.evidence.download.unhandled_error',
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
        error: 'Something went wrong while downloading the file. Please try again.',
      },
      { status: 500 },
    );
  }
});
