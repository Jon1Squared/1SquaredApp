/**
 * Tenant-Scoped Document Storage Providers (`core/src/tenancy/blobStorage.ts`).
 *
 * Implements `DocumentStorageProvider` from `@platform/core-api` (ADR-0008):
 * 1. `LocalTenantStorageProvider` (`providerId: 'local-fs'`, active default):
 *    - Stores files on disk in a tenant-isolated directory (`<root>/tenant-<tenantId>-<env>/`)
 *      so no Azure Blob Storage setup is required while evaluating cloud/DMS locations.
 *    - Supports an optional in-memory mode for fast, side-effect-free unit/isolation tests.
 * 2. `AzureBlobDocumentStorageProvider` (`providerId: 'azure-blob'`):
 *    - Stub placeholder for Azure Blob Storage (`tenant-<tenantId>-<env>`); throws if selected without
 *      an Azure Blob Storage SDK/connection implementation rather than writing silently to local disk.
 * 3. `LocalTenantStorageProvider` enforces:
 *    - Strict tenant container isolation (`ctx.tenantId` / `ctx.blobContainerName`).
 *    - Short-lived HMAC-signed scoped download tokens bound to `sub` and `documentId` (`issueScopedDownloadToken` / `verifyScopedDownloadToken`).
 *    - Malware / macro / EICAR test signature scanning (`scanStatus: 'pending' | 'clean' | 'infected'`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DocumentStorageProvider,
  MalwareScanStatus,
  ScopedDownloadToken,
  StorageProviderId,
  StoredBlobMetadata,
  TenantContext,
} from '../api/index';

const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function ensureValidTenantContext(ctx: TenantContext): void {
  if (!ctx?.tenantId || !ctx?.blobContainerName) {
    throw new Error(
      'STORAGE_TENANCY_ERROR: Storage operations require a valid TenantContext.',
    );
  }
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._ -]/g, '_');
  if (!base || base === '.' || base === '..') {
    return 'document.bin';
  }
  return base;
}

function assertBlobKeyBelongsToTenant(
  ctx: TenantContext,
  blobKey: string,
): void {
  ensureValidTenantContext(ctx);
  if (
    !blobKey ||
    blobKey.includes('..') ||
    blobKey.startsWith('/') ||
    blobKey.startsWith('\\')
  ) {
    throw new Error(
      `STORAGE_SECURITY_ERROR: Invalid or unsafe blob key "${blobKey}".`,
    );
  }
  const expectedPrefix = `${ctx.blobContainerName}/`;
  if (!blobKey.startsWith(expectedPrefix)) {
    throw new Error(
      `STORAGE_TENANCY_ISOLATION_ERROR: Tenant "${ctx.tenantId}" cannot access blob key "${blobKey}" outside container "${ctx.blobContainerName}".`,
    );
  }
}

/**
 * Inspects uploaded bytes for EICAR test signatures or embedded macro binaries (`vbaProject.bin`).
 */
export function scanBytesForMalwareAndMacros(
  bytes: Uint8Array,
  fileName: string,
): MalwareScanStatus {
  if (/\.docm$/i.test(fileName) || /\.dotm$/i.test(fileName)) {
    return 'infected';
  }
  const textSample = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.length, 256 * 1024)),
  );
  if (
    textSample.includes(EICAR_SIGNATURE) ||
    textSample.includes('MALWARE_TEST_PAYLOAD') ||
    textSample.includes('vbaProject.bin')
  ) {
    return 'infected';
  }
  return 'clean';
}

export interface TenantStorageProviderOptions {
  /** Root directory on disk for `local-fs` (defaults to `<cwd>/data/storage`). */
  rootDir?: string;
  /** When true, keeps blobs in memory instead of writing to disk (ideal for unit tests). */
  inMemoryOnly?: boolean;
  /** Secret key used to sign short-lived scoped download tokens. */
  tokenSigningKey?: string;
}

abstract class BaseTenantStorageProvider implements DocumentStorageProvider {
  public abstract readonly providerId: StorageProviderId;
  protected readonly rootDir: string;
  protected readonly inMemoryOnly: boolean;
  protected readonly tokenSigningKey: string;
  protected readonly memoryBlobs = new Map<string, Uint8Array>();
  protected readonly scanStatuses = new Map<string, MalwareScanStatus>();

  constructor(options?: TenantStorageProviderOptions | string) {
    const resolvedOptions: TenantStorageProviderOptions | undefined =
      typeof options === 'string' ? { tokenSigningKey: options } : options;
    this.rootDir =
      resolvedOptions?.rootDir ?? path.join(process.cwd(), 'data', 'storage');
    this.inMemoryOnly = resolvedOptions?.inMemoryOnly ?? false;
    if (resolvedOptions && 'tokenSigningKey' in resolvedOptions) {
      const explicitKey = resolvedOptions.tokenSigningKey?.trim() ?? '';
      if (explicitKey.length < 16) {
        throw new Error(
          'STORAGE_CONFIG_ERROR: tokenSigningKey must be at least 16 characters.',
        );
      }
      this.tokenSigningKey = explicitKey;
    } else if (Boolean(process.env.VITEST || process.env.NODE_ENV === 'test')) {
      this.tokenSigningKey = 'test-only-ephemeral-blob-signing-key-not-for-prod';
    } else {
      throw new Error(
        'STORAGE_CONFIG_ERROR: tokenSigningKey is required outside test environments and must be supplied from Key Vault or environment configuration.',
      );
    }
  }

  public async putObject(
    ctx: TenantContext,
    input: {
      category: 'templates' | 'documents';
      objectId: string;
      fileName: string;
      contentType: string;
      bytes: Uint8Array;
      metadata?: Record<string, string>;
    },
  ): Promise<StoredBlobMetadata> {
    ensureValidTenantContext(ctx);
    const safeName = sanitizeFileName(input.fileName);
    const safeId = input.objectId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const blobKey = `${ctx.blobContainerName}/${input.category}/${safeId}/${safeName}`;

    const sha256 = crypto
      .createHash('sha256')
      .update(input.bytes)
      .digest('hex');
    const scanStatus = scanBytesForMalwareAndMacros(input.bytes, safeName);
    const scannedAt = new Date().toISOString();

    this.scanStatuses.set(blobKey, scanStatus);
    this.memoryBlobs.set(blobKey, new Uint8Array(input.bytes));

    if (!this.inMemoryOnly) {
      const fullPath = path.join(this.rootDir, ...blobKey.split('/'));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, input.bytes);
    }

    return {
      storageProvider: this.providerId,
      containerName: ctx.blobContainerName,
      blobKey,
      sizeBytes: input.bytes.length,
      sha256,
      contentType: input.contentType,
      scanStatus,
      scannedAt,
    };
  }

  public async getObjectBytes(
    ctx: TenantContext,
    ref: { blobKey: string; externalId?: string },
  ): Promise<Uint8Array> {
    assertBlobKeyBelongsToTenant(ctx, ref.blobKey);

    const status = await this.getMalwareScanStatus(ctx, ref.blobKey);
    if (status === 'infected') {
      throw new Error(
        `STORAGE_MALWARE_BLOCKED: Blob "${ref.blobKey}" failed malware scanning and is quarantined.`,
      );
    }

    const inMem = this.memoryBlobs.get(ref.blobKey);
    if (inMem) {
      return new Uint8Array(inMem);
    }

    if (!this.inMemoryOnly) {
      const fullPath = path.join(this.rootDir, ...ref.blobKey.split('/'));
      if (fs.existsSync(fullPath)) {
        const buf = fs.readFileSync(fullPath);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
    }

    throw new Error(`STORAGE_NOT_FOUND: Blob "${ref.blobKey}" was not found.`);
  }

  public async issueScopedDownloadToken(
    ctx: TenantContext,
    ref: {
      blobKey: string;
      externalId?: string;
      fileName: string;
      documentId?: string;
    },
    ttlSeconds = 300,
  ): Promise<ScopedDownloadToken> {
    assertBlobKeyBelongsToTenant(ctx, ref.blobKey);

    const status = await this.getMalwareScanStatus(ctx, ref.blobKey);
    if (status !== 'clean') {
      throw new Error(
        `STORAGE_MALWARE_GATE: Cannot issue download token for blob "${ref.blobKey}" with scanStatus "${status}".`,
      );
    }

    const expiresAtMs = Date.now() + Math.max(10, ttlSeconds) * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const payload = JSON.stringify({
      tenantId: ctx.tenantId,
      containerName: ctx.blobContainerName,
      blobKey: ref.blobKey,
      fileName: sanitizeFileName(ref.fileName),
      sub: ctx.actorId,
      ...(ref.documentId ? { documentId: ref.documentId } : {}),
      exp: expiresAtMs,
    });
    const encodedPayload = Buffer.from(payload, 'utf-8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', `${this.tokenSigningKey}:${ctx.tenantId}`)
      .update(encodedPayload)
      .digest('base64url');
    const token = `${encodedPayload}.${signature}`;

    return {
      url: `/api/documents/download?token=${encodeURIComponent(token)}`,
      token,
      expiresAt,
      tenantId: ctx.tenantId,
      blobKey: ref.blobKey,
      sub: ctx.actorId,
      ...(ref.documentId ? { documentId: ref.documentId } : {}),
    };
  }

  public async verifyScopedDownloadToken(
    ctx: TenantContext,
    token: string,
  ): Promise<{
    blobKey: string;
    fileName: string;
    sub: string;
    documentId?: string;
  }> {
    ensureValidTenantContext(ctx);
    const parts = token?.split('.') ?? [];
    if (parts.length !== 2) {
      throw new Error('STORAGE_TOKEN_INVALID: Malformed scoped download token.');
    }
    const [encodedPayload, signature] = parts as [string, string];
    const expectedSig = crypto
      .createHmac('sha256', `${this.tokenSigningKey}:${ctx.tenantId}`)
      .update(encodedPayload)
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      throw new Error(
        'STORAGE_TOKEN_FORGERY: Scoped download token signature mismatch or cross-tenant token rejected.',
      );
    }

    const decoded = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf-8'),
    ) as {
      tenantId: string;
      containerName: string;
      blobKey: string;
      fileName: string;
      sub?: string;
      documentId?: string;
      exp: number;
    };

    if (decoded.tenantId !== ctx.tenantId) {
      throw new Error(
        'STORAGE_TENANCY_ISOLATION_ERROR: Scoped token belongs to a different tenant.',
      );
    }

    if (!decoded.sub || decoded.sub !== ctx.actorId) {
      throw new Error(
        'STORAGE_TOKEN_ACTOR_MISMATCH: Scoped download token was issued to a different user.',
      );
    }

    if (Date.now() > decoded.exp) {
      throw new Error(
        'STORAGE_TOKEN_EXPIRED: Scoped download token has expired.',
      );
    }

    assertBlobKeyBelongsToTenant(ctx, decoded.blobKey);
    return {
      blobKey: decoded.blobKey,
      fileName: decoded.fileName,
      sub: decoded.sub,
      ...(decoded.documentId ? { documentId: decoded.documentId } : {}),
    };
  }

  public async deleteObject(
    ctx: TenantContext,
    ref: { blobKey: string; externalId?: string },
  ): Promise<void> {
    assertBlobKeyBelongsToTenant(ctx, ref.blobKey);
    this.memoryBlobs.delete(ref.blobKey);
    this.scanStatuses.delete(ref.blobKey);

    if (!this.inMemoryOnly) {
      const fullPath = path.join(this.rootDir, ...ref.blobKey.split('/'));
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  }

  public async getMalwareScanStatus(
    ctx: TenantContext,
    blobKey: string,
  ): Promise<MalwareScanStatus> {
    assertBlobKeyBelongsToTenant(ctx, blobKey);
    const cached = this.scanStatuses.get(blobKey);
    if (cached) return cached;

    if (!this.inMemoryOnly) {
      const fullPath = path.join(this.rootDir, ...blobKey.split('/'));
      if (fs.existsSync(fullPath)) {
        const buf = fs.readFileSync(fullPath);
        const bytes = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        );
        const status = scanBytesForMalwareAndMacros(
          bytes,
          path.basename(fullPath),
        );
        this.scanStatuses.set(blobKey, status);
        return status;
      }
    }

    return 'clean';
  }

  /** Helper for tests or Defender webhook callbacks to update scan status. */
  public setMalwareScanStatusForBlob(
    ctx: TenantContext,
    blobKey: string,
    status: MalwareScanStatus,
  ): void {
    assertBlobKeyBelongsToTenant(ctx, blobKey);
    this.scanStatuses.set(blobKey, status);
  }
}

export class LocalTenantStorageProvider extends BaseTenantStorageProvider {
  public readonly providerId: StorageProviderId = 'local-fs';
}

export class AzureBlobDocumentStorageProvider implements DocumentStorageProvider {
  public readonly providerId: StorageProviderId = 'azure-blob';

  constructor(_options?: TenantStorageProviderOptions) {
    throw new Error(
      'STORAGE_PROVIDER_NOT_SUPPORTED: AzureBlobDocumentStorageProvider ("azure-blob") requires an Azure Storage account and user-delegation SAS client and is not supported in local mode.',
    );
  }

  public async putObject(): Promise<StoredBlobMetadata> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }

  public async getObjectBytes(): Promise<Uint8Array> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }

  public async issueScopedDownloadToken(): Promise<ScopedDownloadToken> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }

  public async verifyScopedDownloadToken(): Promise<{
    blobKey: string;
    fileName: string;
    sub: string;
    documentId?: string;
  }> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }

  public async deleteObject(): Promise<void> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }

  public async getMalwareScanStatus(): Promise<MalwareScanStatus> {
    throw new Error('STORAGE_PROVIDER_NOT_SUPPORTED');
  }
}

export function createDocumentStorageProvider(
  providerId: StorageProviderId | 'azure_blob' = 'local-fs',
  options?: TenantStorageProviderOptions | string,
): DocumentStorageProvider {
  const resolvedOptions =
    typeof options === 'string' ? { tokenSigningKey: options } : options;
  switch (providerId) {
    case 'azure-blob':
    case 'azure_blob':
      return new AzureBlobDocumentStorageProvider(resolvedOptions);
    case 'local-fs':
    default:
      return new LocalTenantStorageProvider(resolvedOptions);
  }
}
