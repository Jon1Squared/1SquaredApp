import { NextResponse } from 'next/server';
import { isActionDenied } from '@/domain/actionResult';
import { guardedRoute } from '@/server/authorize';
import { downloadEvidenceArtifactRecord } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = guardedRoute('GET /api/evidence/download', async (request, _context, actor) => {
  try {
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

    const safeFileName = result.artifact.fileName.replace(/["\r\n]/g, '_');
    return new NextResponse(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.artifact.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFileName}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to download evidence file.';
    return NextResponse.json(
      { ok: false, code: 'DOWNLOAD_ERROR', error: message },
      { status: 403 },
    );
  }
});
