import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalTenantStorageProvider,
  getPlatformTelemetryRecorder,
  type TenantContext,
} from '@platform/core';
import { testTenantCtx } from '@/server/testSupport/auditTestSupport';
import { storeEvidenceBlobAndCreateArtifact } from '../evidenceUploadStore';

function makeTestContext(correlationId: string): TenantContext {
  return {
    ...testTenantCtx('P-000010', { roles: ['legal_secretary'] }),
    correlationId,
  };
}

describe('storeEvidenceBlobAndCreateArtifact (R807)', () => {
  afterEach(() => {
    getPlatformTelemetryRecorder().clearForTesting();
  });

  it('deletes the stored blob and returns EVIDENCE_MALWARE_DETECTED when post-storage scan is not clean', async () => {
    const ctx = makeTestContext('corr-r807-post-scan');
    const storage = new LocalTenantStorageProvider({ inMemoryOnly: true });
    let storedBlobKey = '';

    const wrappedStorage = {
      async putObject(
        putCtx: TenantContext,
        input: Parameters<LocalTenantStorageProvider['putObject']>[1],
      ) {
        const stored = await storage.putObject(putCtx, input);
        storedBlobKey = stored.blobKey;
        storage.setMalwareScanStatusForBlob(putCtx, stored.blobKey, 'infected');
        return { ...stored, scanStatus: 'infected' as const };
      },
      deleteObject: storage.deleteObject.bind(storage),
    };

    let createCalled = false;
    const res = await storeEvidenceBlobAndCreateArtifact({
      ctx,
      storage: wrappedStorage,
      objectId: 'person-P-000015-postscan',
      fileName: 'secret-passport.pdf',
      contentType: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.4\n%Sample'),
      createArtifact: async () => {
        createCalled = true;
        return { id: 'EVD-NEVER' };
      },
    });

    expect(createCalled).toBe(false);
    expect(res).toEqual({
      ok: false,
      code: 'EVIDENCE_MALWARE_DETECTED',
      message: "This file failed a security check and can't be attached.",
    });
    expect(storedBlobKey).toBeTruthy();
    await expect(
      storage.getObjectBytes(ctx, { blobKey: storedBlobKey }),
    ).rejects.toThrow();
  });

  it('deletes the stored blob, emits a filename-free warning, and rethrows when createArtifact throws', async () => {
    const correlationId = 'corr-r807-db-failure';
    const ctx = makeTestContext(correlationId);
    const storage = new LocalTenantStorageProvider({ inMemoryOnly: true });
    let storedBlobKey = '';

    const wrappedStorage = {
      async putObject(
        putCtx: TenantContext,
        input: Parameters<LocalTenantStorageProvider['putObject']>[1],
      ) {
        const stored = await storage.putObject(putCtx, input);
        storedBlobKey = stored.blobKey;
        return stored;
      },
      deleteObject: storage.deleteObject.bind(storage),
    };

    await expect(
      storeEvidenceBlobAndCreateArtifact({
        ctx,
        storage: wrappedStorage,
        objectId: 'person-P-000015-dbfail',
        fileName: 'sensitive-passport-name.pdf',
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.4\n%Sample'),
        createArtifact: async () => {
          throw new Error('Synthetic DB insert failure');
        },
      }),
    ).rejects.toThrow('Synthetic DB insert failure');

    expect(storedBlobKey).toBeTruthy();
    await expect(
      storage.getObjectBytes(ctx, { blobKey: storedBlobKey }),
    ).rejects.toThrow();

    const entries = getPlatformTelemetryRecorder().getRecentEntries({
      tenantId: ctx.tenantId,
      correlationId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'event',
      eventName: 'evidence.upload.artifact_insert_failed_cleanup',
      severity: 'warn',
      tenantId: ctx.tenantId,
      correlationId,
    });
    expect(JSON.stringify(entries[0])).not.toContain('sensitive-passport-name.pdf');
    expect(JSON.stringify(entries[0])).not.toContain(storedBlobKey);
  });

  it('swallows deleteObject failures while still emitting telemetry and rethrowing the insert error', async () => {
    const correlationId = 'corr-r807-delete-fails';
    const ctx = makeTestContext(correlationId);
    const storage = new LocalTenantStorageProvider({ inMemoryOnly: true });

    const wrappedStorage = {
      putObject: storage.putObject.bind(storage),
      async deleteObject(): Promise<void> {
        throw new Error('Blob delete transient error');
      },
    };

    await expect(
      storeEvidenceBlobAndCreateArtifact({
        ctx,
        storage: wrappedStorage,
        objectId: 'person-P-000015-delfail',
        fileName: 'hidden-name.pdf',
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.4\n%Sample'),
        createArtifact: async () => {
          throw new Error('Primary insert error');
        },
      }),
    ).rejects.toThrow('Primary insert error');

    const entries = getPlatformTelemetryRecorder().getRecentEntries({
      tenantId: ctx.tenantId,
      correlationId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.severity).toBe('warn');
    expect(entries[0]?.tenantId).toBe(ctx.tenantId);
    expect(entries[0]?.correlationId).toBe(correlationId);
    expect(JSON.stringify(entries[0])).not.toContain('hidden-name.pdf');
  });
});
