import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { canActorAccessGeneratedDocument } from '@platform/core';
import {
  buildDocumentActorFromPerson,
  toMatterAccessSubject,
} from '@/domain/documentGeneration';
import { AuthorisationError } from '@/domain/rbac';
import { getInitializedDocGenContext } from '@/server/documentGenerationServices';
import { withAuthenticatedActor } from '@/server/services';

export async function GET(request: Request) {
  let tenantIdForLog = 'unknown';
  let correlationIdForLog = `corr-dl-${crypto.randomUUID()}`;

  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) {
      return NextResponse.json(
        { error: 'Missing scoped download token.' },
        { status: 400 },
      );
    }

    return await withAuthenticatedActor(async (actor) => {
      const { store, ctx, user, config, repo, storage } =
        await getInitializedDocGenContext(actor.personId, actor.session);
      tenantIdForLog = ctx.tenantId;
      correlationIdForLog = ctx.correlationId;

      const verified = await storage.verifyScopedDownloadToken(ctx, token);
      if (verified.sub !== actor.personId) {
        return NextResponse.json(
          { error: 'You do not have permission to download this document.' },
          { status: 403 },
        );
      }

      if (!verified.documentId) {
        return NextResponse.json(
          { error: 'Document not found.' },
          { status: 404 },
        );
      }

      const doc = repo.getDocumentById(ctx, verified.documentId);
      if (!doc || doc.isDeleted || doc.storageKey !== verified.blobKey) {
        return NextResponse.json(
          { error: 'Document not found.' },
          { status: 404 },
        );
      }

      const linkedMatters = [];
      if (doc.primaryMatterId) {
        const m = store.matters.find((x) => x.id === doc.primaryMatterId);
        if (m) linkedMatters.push(toMatterAccessSubject(m)!);
      }
      for (const link of repo.listLinksForDocument(ctx, doc.id)) {
        if (link.entityType === 'matter') {
          const m = store.matters.find((x) => x.id === link.entityId);
          if (m && !linkedMatters.some((x) => x.id === m.id)) {
            linkedMatters.push(toMatterAccessSubject(m)!);
          }
        }
      }
      const docActor = buildDocumentActorFromPerson(user, ctx);
      if (!canActorAccessGeneratedDocument(docActor, doc, linkedMatters, config)) {
        return NextResponse.json(
          { error: 'You do not have permission to download this document.' },
          { status: 403 },
        );
      }

      const bytes = await storage.getObjectBytes(ctx, {
        blobKey: verified.blobKey,
      });

      const isPdf = verified.fileName.toLowerCase().endsWith('.pdf');
      const contentType = isPdf
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      return new NextResponse(Buffer.from(bytes), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${verified.fileName.replace(/"/g, '')}"`,
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    });
  } catch (err) {
    if (err instanceof AuthorisationError && err.code === 'UNAUTHENTICATED') {
      return NextResponse.json(
        { error: 'Authentication is required to download documents.' },
        { status: 401 },
      );
    }
    const code =
      err instanceof Error
        ? (err.message.split(':')[0]?.trim() || 'DOWNLOAD_ERROR')
        : 'DOWNLOAD_ERROR';
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'document_download_rejected',
        tenantId: tenantIdForLog,
        correlationId: correlationIdForLog,
        errorCode: code,
      }),
    );
    return NextResponse.json(
      {
        error:
          'Unable to download the requested document. The link may have expired or you may not have permission to access it.',
      },
      { status: 403 },
    );
  }
}
