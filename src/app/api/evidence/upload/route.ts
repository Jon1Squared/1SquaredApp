import { NextResponse } from 'next/server';
import type { EvidenceArtifactSubjectType } from '@platform/core';
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

    const formData = await request.formData();
    const subjectTypeRaw = String(formData.get('subjectType') ?? '').trim();
    const subjectId = String(formData.get('subjectId') ?? '').trim();
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
      const status =
        result.code === 'EVIDENCE_MALWARE_DETECTED'
          ? 422
          : result.code === 'PAYLOAD_TOO_LARGE'
            ? 413
            : result.code === 'UNSUPPORTED_MEDIA_TYPE'
              ? 415
              : result.code === 'NOT_FOUND'
                ? 404
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
  } catch {
    return NextResponse.json(
      { ok: false, code: 'UPLOAD_ERROR', error: 'Unable to upload evidence file.' },
      { status: 400 },
    );
  }
});
