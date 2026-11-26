import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformTelemetryRecorder } from '@platform/core';
import { setActiveTenantConfigForTesting } from '@/platform/tenantRuntime';
import * as servicesModule from '@/server/services';
import {
  runAsTestActor,
  setTestActorSession,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';
import * as uploadRoute from '../upload/route';
import * as downloadRoute from '../download/route';

async function runAsActionActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { roles?: readonly string[]; mfaVerified?: boolean },
): Promise<R> {
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    setTestActorSession(null);
  }
}

async function buildMultipartUploadRequest(
  form: FormData,
  opts?: { correlationId?: string },
): Promise<Request> {
  const serialized = new Response(form);
  const contentType = serialized.headers.get('content-type') || 'multipart/form-data';
  const rawBody = await serialized.arrayBuffer();
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('content-length', String(rawBody.byteLength));
  if (opts?.correlationId) {
    headers.set('x-correlation-id', opts.correlationId);
  }
  return new Request('http://localhost/api/evidence/upload', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

describe('Evidence API routes fault & status handling (R808)', () => {
  beforeAll(async () => {
    await servicesModule.resetAllDemoData('P-000004', testDataResetContext());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    getPlatformTelemetryRecorder().clearForTesting();
  });

  it('returns 400 on malformed multipart body without logging an unhandled server exception', async () => {
    const corrId = 'corr-r808-malformed-form';
    const badReq = new Request('http://localhost/api/evidence/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----r808broken',
        'content-length': '64',
        'x-correlation-id': corrId,
      },
      body: 'not-valid-multipart-content',
    });

    const res = await runAsActionActor(
      'P-000010',
      () => uploadRoute.POST(badReq),
      { roles: ['legal_secretary'], mfaVerified: false },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code?: string; error?: string };
    expect(body).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'The uploaded file could not be read. Please try again.',
    });
    expect(
      getPlatformTelemetryRecorder().getRecentEntries({
        tenantId: 'not-a-law-firm',
        correlationId: corrId,
      }),
    ).toHaveLength(0);
  });

  it('returns 500 with a plain message when uploadEvidenceArtifactRecord returns INTERNAL_ERROR or throws', async () => {
    const goodForm = new FormData();
    goodForm.set('subjectType', 'person');
    goodForm.set('subjectId', 'P-000015');
    goodForm.set(
      'file',
      new File([new TextEncoder().encode('%PDF-1.4\n%Sample')], 'sample-doc.pdf', {
        type: 'application/pdf',
      }),
    );

    vi.spyOn(servicesModule, 'uploadEvidenceArtifactRecord').mockResolvedValueOnce({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Raw internal detail that must not reach callers',
      error: 'INTERNAL_ERROR: Raw internal detail that must not reach callers',
    });

    const internalResultRes = await runAsActionActor(
      'P-000010',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(goodForm)),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(internalResultRes.status).toBe(500);
    const internalResultJson = (await internalResultRes.json()) as {
      ok: boolean;
      code?: string;
      error?: string;
    };
    expect(internalResultJson).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Something went wrong while uploading the file. Please try again.',
    });

    const corrId = 'corr-r808-upload-throw';
    vi.spyOn(servicesModule, 'uploadEvidenceArtifactRecord').mockRejectedValueOnce(
      new Error('sensitive postgres stack detail on upload'),
    );

    const thrownRes = await runAsActionActor(
      'P-000010',
      async () =>
        uploadRoute.POST(
          await buildMultipartUploadRequest(goodForm, { correlationId: corrId }),
        ),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(thrownRes.status).toBe(500);
    const thrownText = await thrownRes.text();
    expect(thrownText).not.toContain('sensitive postgres stack detail');
    expect(JSON.parse(thrownText)).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Something went wrong while uploading the file. Please try again.',
    });

    const entries = getPlatformTelemetryRecorder().getRecentEntries({
      tenantId: 'not-a-law-firm',
      correlationId: corrId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'exception',
      eventName: 'api.evidence.upload.unhandled_error',
      tenantId: 'not-a-law-firm',
      correlationId: corrId,
    });
  });

  it('returns 500 with a plain message and telemetry when downloadEvidenceArtifactRecord returns INTERNAL_ERROR or throws', async () => {
    vi.spyOn(servicesModule, 'downloadEvidenceArtifactRecord').mockResolvedValueOnce({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Raw storage error that must not reach callers',
      error: 'INTERNAL_ERROR: Raw storage error that must not reach callers',
    });

    const internalResultRes = await runAsActionActor(
      'P-000010',
      () =>
        downloadRoute.GET(
          new Request('http://localhost/api/evidence/download?token=stub-token', {
            method: 'GET',
          }),
        ),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(internalResultRes.status).toBe(500);
    expect(await internalResultRes.json()).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Something went wrong while downloading the file. Please try again.',
    });

    const corrId = 'corr-r808-download-throw';
    vi.spyOn(servicesModule, 'downloadEvidenceArtifactRecord').mockRejectedValueOnce(
      new Error('sensitive blob IO failure on download'),
    );

    const thrownRes = await runAsActionActor(
      'P-000010',
      () =>
        downloadRoute.GET(
          new Request('http://localhost/api/evidence/download?token=stub-token', {
            method: 'GET',
            headers: { 'x-correlation-id': corrId },
          }),
        ),
      { roles: ['legal_secretary'], mfaVerified: false },
    );
    expect(thrownRes.status).toBe(500);
    const thrownText = await thrownRes.text();
    expect(thrownText).not.toContain('sensitive blob IO failure');
    expect(JSON.parse(thrownText)).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Something went wrong while downloading the file. Please try again.',
    });

    const entries = getPlatformTelemetryRecorder().getRecentEntries({
      tenantId: 'not-a-law-firm',
      correlationId: corrId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'exception',
      eventName: 'api.evidence.download.unhandled_error',
      tenantId: 'not-a-law-firm',
      correlationId: corrId,
    });
  });

  it('preserves existing 401, 403, 404, 413, 415, and 422 status codes on upload and download routes', async () => {
    const form = new FormData();
    form.set('subjectType', 'person');
    form.set('subjectId', 'P-000015');
    form.set(
      'file',
      new File([new TextEncoder().encode('%PDF-1.4\n%Sample')], 'sample-doc.pdf', {
        type: 'application/pdf',
      }),
    );

    // 401 unauthenticated
    const unauthUpload = await uploadRoute.POST(await buildMultipartUploadRequest(form));
    expect(unauthUpload.status).toBe(401);
    const unauthDownload = await downloadRoute.GET(
      new Request('http://localhost/api/evidence/download?token=invalid', { method: 'GET' }),
    );
    expect(unauthDownload.status).toBe(401);

    // 403 forbidden (finance user P-000009 lacks cdd:record and cdd:view)
    const financeUpload = await runAsActionActor(
      'P-000009',
      async () => uploadRoute.POST(await buildMultipartUploadRequest(form)),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(financeUpload.status).toBe(403);
    const financeDownload = await runAsActionActor(
      'P-000009',
      () =>
        downloadRoute.GET(
          new Request('http://localhost/api/evidence/download?token=invalid', {
            method: 'GET',
          }),
        ),
      { roles: ['finance'], mfaVerified: false },
    );
    expect(financeDownload.status).toBe(403);

    // 404, 413, 415, 422 from upload service codes + 403/404 from download service codes
    for (const [code, expectedStatus] of [
      ['NOT_FOUND', 404],
      ['PAYLOAD_TOO_LARGE', 413],
      ['UNSUPPORTED_MEDIA_TYPE', 415],
      ['EVIDENCE_MALWARE_DETECTED', 422],
    ] as const) {
      vi.spyOn(servicesModule, 'uploadEvidenceArtifactRecord').mockResolvedValueOnce({
        ok: false,
        code,
        message: 'Expected denial',
        error: `${code}: Expected denial`,
      });
      const r = await runAsActionActor(
        'P-000010',
        async () => uploadRoute.POST(await buildMultipartUploadRequest(form)),
        { roles: ['legal_secretary'], mfaVerified: false },
      );
      expect(r.status).toBe(expectedStatus);
    }

    for (const [code, expectedStatus] of [
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
    ] as const) {
      vi.spyOn(servicesModule, 'downloadEvidenceArtifactRecord').mockResolvedValueOnce({
        ok: false,
        code,
        message: 'Expected denial',
        error: `${code}: Expected denial`,
      });
      const r = await runAsActionActor(
        'P-000010',
        () =>
          downloadRoute.GET(
            new Request('http://localhost/api/evidence/download?token=stub', {
              method: 'GET',
            }),
          ),
        { roles: ['legal_secretary'], mfaVerified: false },
      );
      expect(r.status).toBe(expectedStatus);
    }
  });
});
