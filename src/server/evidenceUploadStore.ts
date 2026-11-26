import {
  emitTenantTelemetryEvent,
  type DocumentStorageProvider,
  type StoredBlobMetadata,
  type TenantContext,
} from '@platform/core';

export interface StoreEvidenceBlobAndCreateArtifactParams<TArtifact> {
  readonly ctx: TenantContext;
  readonly storage: Pick<DocumentStorageProvider, 'putObject' | 'deleteObject'>;
  readonly objectId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly createArtifact: (stored: StoredBlobMetadata) => Promise<TArtifact>;
}

export type StoreEvidenceBlobAndCreateArtifactResult<TArtifact> =
  | {
      readonly ok: true;
      readonly stored: StoredBlobMetadata;
      readonly artifact: TArtifact;
    }
  | {
      readonly ok: false;
      readonly code: 'EVIDENCE_MALWARE_DETECTED';
      readonly message: string;
    };

async function bestEffortDeleteEvidenceBlob(
  ctx: TenantContext,
  storage: Pick<DocumentStorageProvider, 'deleteObject'>,
  blobKey: string,
): Promise<boolean> {
  try {
    await storage.deleteObject(ctx, { blobKey });
    return true;
  } catch {
    return false;
  }
}

function emitCleanupWarning(
  eventName: string,
  ctx: TenantContext,
): void {
  try {
    emitTenantTelemetryEvent({
      eventName,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      severity: 'warning',
    });
  } catch {
    // Never mask upload validation or database failures when telemetry context is invalid.
  }
}

/**
 * Persists an evidence blob, verifies its post-storage scan status, and writes its
 * database metadata row, cleaning up the blob if post-storage screening fails or
 * if creating the database record throws (R807).
 */
export async function storeEvidenceBlobAndCreateArtifact<TArtifact>(
  params: StoreEvidenceBlobAndCreateArtifactParams<TArtifact>,
): Promise<StoreEvidenceBlobAndCreateArtifactResult<TArtifact>> {
  const { ctx, storage, objectId, fileName, contentType, bytes, createArtifact } =
    params;

  const stored = await storage.putObject(ctx, {
    category: 'evidence',
    objectId,
    fileName,
    contentType,
    bytes,
  });

  if (stored.scanStatus !== 'clean') {
    const deleted = await bestEffortDeleteEvidenceBlob(
      ctx,
      storage,
      stored.blobKey,
    );
    if (!deleted) {
      emitCleanupWarning('evidence.upload.post_scan_cleanup_failed', ctx);
    }
    return {
      ok: false,
      code: 'EVIDENCE_MALWARE_DETECTED',
      message: "This file failed a security check and can't be attached.",
    };
  }

  try {
    const artifact = await createArtifact(stored);
    return { ok: true, stored, artifact };
  } catch (err) {
    await bestEffortDeleteEvidenceBlob(ctx, storage, stored.blobKey);
    emitCleanupWarning('evidence.upload.artifact_insert_failed_cleanup', ctx);
    throw err;
  }
}
