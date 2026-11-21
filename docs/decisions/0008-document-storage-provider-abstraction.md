# ADR-0008: Document Storage Provider Abstraction, Transitional Local Tenant Storage, and Azure Blob Isolation

- **Date:** 2026-04-20
- **Status:** Accepted (2026-11-20; Stage 0 exit decision D4 (ADR 0008) exception recorded below)

> **Implementation notes (2026-11-20):** References below to [ADR 0001](./0001-shared-repo-and-transitional-store.md) are superseded by [ADR 0028](./0028-tenant-database-and-repositories.md) and [ADR 0026](./0026-separate-demo-tenant.md). See **Stage 0 Exception & Removal Condition (Stage 0 exit decision D4 (ADR 0008), 20 November 2026)** at the end of this record: `LocalTenantStorageProvider` (`local-fs`) fails closed in `live`, reads/writes on disk without retaining `memoryBlobs`, returns `'pending'` for unknown scan keys, and runs on a single-replica demo container until `azure-blob` is implemented before the first hosted client.

## Context

Generated documents and uploaded `.docx` template binaries must be stored in tenant-isolated containers (`docs/architecture-standard.md` Section 8.2) and scanned before becoming usable. In addition:

1. **Immediate Local / Transitional Storage Need:** In accordance with ADR-0001 (`docs/decisions/0001-shared-repo-and-transitional-store.md`), Azure Blob Storage is not yet provisioned for local/early-stage environments. We need a temporary, zero-Azure-dependency storage provider (`local-fs`) that stores template binaries and generated `.docx`/`.pdf` files on disk in a tenant-isolated directory (`data/storage/tenant-<slug>-<env>/`) while enforcing the exact same `DocumentStorageProvider` contract, tenant isolation checks, and short-lived scoped download tokens.
2. **Future Storage & DMS Providers:** When the firm chooses its permanent cloud/DMS storage location—whether Azure Blob Storage (`azure-blob`), SharePoint Online (`sharepoint`), iManage Work (`imanage`), or NetDocuments (`netdocuments`)—switching providers must be a tenant configuration change (`documentGeneration.storageProvider`) requiring no changes to templates, generated document records, or UI screens.

## Decision

### 1. `DocumentStorageProvider` Interface in `@platform/core-api`

We define a tenant-scoped storage contract in `core/src/api/index.ts`:

```ts
export type StorageProviderId =
  | 'local-fs'
  | 'azure-blob'
  | 'sharepoint'
  | 'imanage'
  | 'netdocuments';

export type MalwareScanStatus = 'pending' | 'clean' | 'infected' | 'failed';

export interface StoredBlobMetadata {
  storageProvider: StorageProviderId;
  containerName: string;
  blobKey: string;
  externalId?: string;
  externalVersion?: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  scanStatus: MalwareScanStatus;
  scannedAt?: string;
}

export interface ScopedDownloadToken {
  url: string;
  token: string;
  expiresAt: string;
  tenantId: string;
  blobKey: string;
}

export interface DocumentStorageProvider {
  readonly providerId: StorageProviderId;
  putObject(
    ctx: TenantContext,
    input: {
      category: 'templates' | 'documents';
      objectId: string;
      fileName: string;
      contentType: string;
      bytes: Uint8Array;
      metadata?: Record<string, string>;
    }
  ): Promise<StoredBlobMetadata>;
  getObjectBytes(ctx: TenantContext, ref: { blobKey: string; externalId?: string }): Promise<Uint8Array>;
  issueScopedDownloadToken(
    ctx: TenantContext,
    ref: { blobKey: string; externalId?: string; fileName: string },
    ttlSeconds?: number
  ): Promise<ScopedDownloadToken>;
  verifyScopedDownloadToken(
    ctx: TenantContext,
    token: string
  ): Promise<{ blobKey: string; fileName: string }>;
  deleteObject(ctx: TenantContext, ref: { blobKey: string; externalId?: string }): Promise<void>;
  getMalwareScanStatus(ctx: TenantContext, blobKey: string): Promise<MalwareScanStatus>;
}
```

### 2. Transitional Local Tenant Storage Provider (`local-fs`, Active Default Now)

- Consistent with ADR-0001, `LocalTenantStorageProvider` (`providerId: 'local-fs'`) is the default storage provider while Azure Blob Storage or a DMS is being evaluated (`documentGeneration.storageProvider` defaults to `'local-fs'`).
- **Per-tenant directory isolation:** Files are written under `<workspace>/data/storage/tenant-${ctx.tenantSlug}-${environment}/templates/...` and `.../documents/...` (gitignored so tenant files are never committed to Git).
- **Strict path-traversal & cross-tenant protection:** Every `blobKey` is canonicalized and verified to reside inside the caller's resolved `tenant-${ctx.tenantSlug}-${environment}` root. Any attempt to pass `..` or another tenant's container/key throws a tenant isolation error.
- **Short-lived scoped download tokens:** `issueScopedDownloadToken` generates an HMAC-SHA256 signed token bound to `(ctx.tenantId, blobKey, fileName, expiresAt)` with a default 5-minute TTL (`300s`).
- **Built-in synchronous security & malware signature scan:** On upload, the provider inspects the archive for macro payloads (`vbaProject.bin`, `.docm`), zip-bomb ratios, and standard anti-malware test signatures (e.g., EICAR) before setting `scanStatus: 'clean'` or `'infected'`.

### 3. Azure Blob Storage Provider (`azure-blob`) & Future DMS Readiness

- `AzureBlobDocumentStorageProvider` (`providerId: 'azure-blob'`) implements the exact same interface using per-tenant containers (`tenant-${ctx.tenantSlug}-${environment}`), short-lived SAS tokens, and Microsoft Defender for Storage scan status tags.
- Every record in the `documents` table includes `storage_provider`, `storage_key`, `external_id`, and `external_version` so migrating from `'local-fs'` to `'azure-blob'`, `'sharepoint'`, `'imanage'`, or `'netdocuments'` is a configuration change.

## Alternatives Considered

1. **Require Azure Blob Storage to be provisioned before using Document Generation.**
   - *Rejected:* Blocks immediate local and early-stage usage while storage locations are still under evaluation.
2. **Store binary `.docx` and `.pdf` files directly inside `data/pembroke-vaughan.json`.**
   - *Rejected:* Embedding multi-megabyte binary files inside the JSON state file would degrade JSON serialization performance and fail to model container/blob storage semantics (`blobKey`, `sha256`, scoped tokens). Separate tenant-scoped directory storage under `data/storage/tenant-<slug>-<env>/` mirrors cloud object storage cleanly.

## Consequences

- **The application works out of the box today using the tenant-isolated `local-fs` provider (`data/storage/tenant-<slug>-<env>/`) with zero Azure setup required.**
- Switching to Azure Blob Storage or a DMS later requires only changing `documentGeneration.storageProvider` in tenant configuration.

## Stage 0 Exception & Removal Condition (Stage 0 exit decision D4 (ADR 0008), 20 November 2026)

1. **Supersession of ADR 0001:** References above to ADR 0001 are superseded by [ADR 0028](./0028-tenant-database-and-repositories.md) and [ADR 0026](./0026-separate-demo-tenant.md); document metadata and template records live in per-tenant PostgreSQL (`TenantDocumentRepository`).
2. **Stage 0 `local-fs` exception (`R578`):** `AzureBlobDocumentStorageProvider` (`azure-blob`) remains unimplemented (`STORAGE_PROVIDER_NOT_SUPPORTED`) in Stage 0. For Stage 0 only:
   - `LocalTenantStorageProvider` (`local-fs`) and `assertRuntimeStorageAllowedForActiveTenant` **refuse to run when the environment is `live`** (`STORAGE_LIVE_LOCAL_FS_FORBIDDEN` at runtime startup, provider instantiation, `/api/health/ready`, and config saves).
   - When `inMemoryOnly: false`, `LocalTenantStorageProvider` reads and writes strictly on disk (`memoryBlobs` stays empty) and returns `'pending'` (never `'clean'`) for unknown blob keys (`R579`).
   - Any deployment configured with `documentStorageProvider == 'local-fs'` across any environment (`dev`, `test`, `training`, or `demo`) is pinned to **one replica** (`webMinReplicas <= 1`, `webMaxReplicas == 1`, guarded in `core/infra/modules/platform.bicep` by `LOCAL_FS_SINGLE_REPLICA_REQUIRED`, while `STORAGE_LIVE_LOCAL_FS_FORBIDDEN` blocks `local-fs` in `live`), and the container image grants `USER node` write ownership of `/app/data/storage` (`Dockerfile`).
3. **Removal condition (recorded on `docs/roadmap/stage-0-plan.md`):** Before onboarding the first hosted live client, implement `AzureBlobDocumentStorageProvider` (`azure-blob`) backed by the per-tenant Azure Blob containers (`modules/tenant.bicep`) with short-lived user-delegation SAS tokens and Microsoft Defender for Storage scan status integration, then remove this exception and allow multi-replica scaling.
