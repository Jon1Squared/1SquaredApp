import { NextResponse } from 'next/server';
import {
  emitTenantTelemetryException,
  type EvidenceArtifactSubjectType,
  type EvidencePurpose,
} from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import { formatEvidenceSizeLimitMb } from '@/domain/cdd';
import { guardedRoute } from '@/server/authorize';
import {
  resolveEffectiveCddMaxEvidenceBytesRecord,
  uploadEvidenceArtifactRecord,
} from '@/server/services';

export const dynamic = 'force-dynamic';

const MULTIPART_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

export const POST = guardedRoute('POST /api/evidence/upload', async (request, _context, actor) => {
  try {
    const rawContentLength = request.headers.get('content-length')?.trim() ?? '';
    if (!/^\d+$/.test(rawContentLength)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'LENGTH_REQUIRED',
          error: "The upload couldn't be checked because the file size wasn't sent. Please try again.",
        },
        { status: 411 },
      );
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'LENGTH_REQUIRED',
          error: "The upload couldn't be checked because the file size wasn't sent. Please try again.",
        },
        { status: 411 },
      );
    }

    const maxBytes = await resolveEffectiveCddMaxEvidenceBytesRecord(
      actor?.personId,
      actor?.tenantContext ? { tenantCtx: actor.tenantContext } : undefined,
    );
    if (contentLength > maxBytes + MULTIPART_ENVELOPE_OVERHEAD_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          code: 'PAYLOAD_TOO_LARGE',
          error: `This file is too large. The limit is ${formatEvidenceSizeLimitMb(maxBytes)} MB.`,
        },
        { status: 413 },
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          error: 'The uploaded file could not be read. Please try again.',
        },
        { status: 400 },
      );
    }
    const subjectTypeRaw = String(formData.get('subjectType') ?? '').trim();
    const subjectId = String(formData.get('subjectId') ?? '').trim();
    const purposeRaw = formData.get('purpose');
    const purposeStr =
      purposeRaw === null || purposeRaw === undefined
        ? undefined
        : String(purposeRaw).trim();
    const fileEntry = formData.get('file');

    if (!fileEntry || typeof fileEntry === 'string' || typeof fileEntry.arrayBuffer !== 'function') {
      return NextResponse.json(
        { ok: false, code: 'VALIDATION_ERROR', error: 'Please choose a file to attach.' },
        { status: 400 },
      );
    }

    const arrayBuf = await fileEntry.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const result = await uploadEvidenceArtifactRecord(
      {
        subjectType: subjectTypeRaw as EvidenceArtifactSubjectType,
        subjectId,
        ...(purposeStr !== undefined ? { purpose: purposeStr as EvidencePurpose } : {}),
        fileName: fileEntry.name || 'evidence.bin',
        contentType: fileEntry.type || 'application/octet-stream',
        bytes,
      },
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
            error: 'Something went wrong while uploading the file. Please try again.',
          },
          { status: 500 },
        );
      }
      const status =
        result.code === 'EVIDENCE_MALWARE_DETECTED'
          ? 422
          : result.code === 'PAYLOAD_TOO_LARGE'
            ? 413
            : result.code === 'UNSUPPORTED_MEDIA_TYPE'
              ? 415
              : result.code === 'NOT_FOUND'
                ? 404
                : result.code === 'FORBIDDEN'
                  ? 403
                  : result.code === 'UNAUTHENTICATED'
                    ? 401
                    : 400;
      return NextResponse.json(
        { ok: false, code: result.code, error: result.message },
        { status },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        artifact: result.artifact,
        evidenceRef: result.evidenceRef,
        downloadUrl: result.downloadUrl,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (err) {
    if (actor?.tenantContext?.tenantId && actor?.tenantContext?.correlationId) {
      try {
        emitTenantTelemetryException({
          eventName: 'api.evidence.upload.unhandled_error',
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
        error: 'Something went wrong while uploading the file. Please try again.',
      },
      { status: 500 },
    );
  }
});
