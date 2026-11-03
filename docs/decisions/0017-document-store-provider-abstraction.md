# ADR-0017: External Document Store Provider Abstraction (`DocumentStoreProvider`)

- **Date:** 2026-11-02
- **Status:** Proposed
- **Related:** [ADR-0008](./0008-document-storage-provider-abstraction.md)

## Context

Law firms store matter files in external Document Management Systems (DMS) and cloud document repositories—most commonly SharePoint Online (Microsoft Graph), iManage Work, NetDocuments, or Azure Blob Storage.

Platform Architecture Standard Sections 2, 3, 5, 6, and 8 require:
1. **Single Core Codebase:** Domain logic, lifecycle jobs, RBAC checks, and UI screens must never branch on specific provider names (`provider === 'sharepoint'`) outside the provider registry.
2. **Explicit Identity Separation:** User browsing, uploading, downloading, co-authoring, renaming, moving, and deleting must execute under the signed-in user's own identity (`user` context), while folder provisioning, permission management, location resolution, and drift reconciliation must execute under a dedicated application identity (`provisioning` context).
3. **Coexistence with `DocumentStorageProvider` (ADR-0008):** `DocumentStorageProvider` (`core/src/api/index.ts`) is an internal object-storage contract used by the Document Generation module to store `.docx` template packages and generated blobs. External matter document repositories require rich hierarchical folder trees, per-folder ACL inheritance, native web/desktop co-authoring URLs, effective user permission inspection, and resumable large-file upload sessions.
4. **Multi-Store Support per Tenant:** A tenant may configure one or more external document stores (with at most one marked `isDefault: true`) and route matters across stores and libraries by department, team, and work type.

## Decision

### 1. Module Layout in `@platform/core`

We introduce two modules inside `core/src/` with one-way dependencies:
- `core/src/domain/documents/` — Provider-agnostic domain logic: routing engine, folder name/path renderer and sanitiser, folder template inheritance and preview engine, access policy to intended-grants compiler, matter lifecycle job handlers, permission reconciliation engine, scale guard, and RBAC/audit helpers.
- `core/src/integrations/document-stores/` — Provider registry (`DocumentStoreRegistry`), error normaliser, token cache and OBO/application credential resolvers, and the SharePoint Online adapter (`SharePointDocumentStoreProvider`).

### 2. `DocumentStoreProvider` Contract in `@platform/core-api`

`DocumentStoreProvider` is exported from `core/src/api/index.ts` (`@platform/core-api`). Every method requires an explicit, strongly typed access context—either `UserAccessContext` (`kind: 'user'`) or `ProvisioningAccessContext` (`kind: 'provisioning'`)—and receives only the tenant-scoped `TenantContext` and schema-validated store configuration (`DocumentStoreConfig`). It never accepts a tenant ID, hostname, site URL, library ID, or credential from untrusted request parameters.

```ts
export type DocumentStoreProviderType =
  | 'sharepoint'
  | 'azure_blob'
  | 'imanage'
  | 'netdocuments';

export interface DocumentStoreCapabilities {
  readonly supportsFolders: boolean;
  readonly supportsVersions: boolean;
  readonly supportsCheckInOut: boolean;
  readonly supportsUniqueFolderPermissions: boolean;
  readonly supportsWebCoAuthoring: boolean;
  readonly supportsResumableUpload: boolean;
  readonly supportsMetadataColumns: boolean;
  readonly supportsRetentionLabels: boolean;
  readonly supportsChangeTracking: boolean;
  readonly maxPathLengthChars: number;
  readonly maxSegmentLengthChars: number;
  readonly invalidNameCharsPattern: string;
}

export interface UserAccessContext {
  readonly kind: 'user';
  readonly tenant: TenantContext;
  readonly actorUserId: string;
  readonly actorEntraObjectId: string;
  readonly actorUpn?: string;
  /** Opaque assertion handle for On-Behalf-Of (OBO) exchange; never logged or serialised. */
  readonly userAssertionToken?: string;
}

export interface ProvisioningAccessContext {
  readonly kind: 'provisioning';
  readonly tenant: TenantContext;
  readonly triggeredByUserId: string | null;
  readonly triggerEvent: string;
  readonly jobId?: string;
}
```

#### User-Context Operations (`ctx: UserAccessContext`)
- `listItems(ctx, containerRef, paging?)` — Lists child folders and files with pagination (`nextCursor`).
- `getItem(ctx, itemRef)` — Fetches metadata for a single file or folder by provider item ID.
- `downloadContent(ctx, itemRef)` — Returns a `ReadableStream<Uint8Array>` of the file content.
- `uploadContent(ctx, containerRef, name, stream, sizeBytes, options)` — Supports simple upload for small files and chunked/resumable upload sessions for large files, with conflict behaviour (`'fail' | 'rename' | 'replace'`).
- `createFolder(ctx, parentRef, name)` — Creates a subfolder as the signed-in user.
- `renameItem(ctx, itemRef, newName, options?)` — Renames a file or folder.
- `moveItem(ctx, itemRef, targetParentRef, newName?)` — Moves a file or folder within the library.
- `deleteItem(ctx, itemRef)` — Deletes (moves to recycle bin) a file or folder.
- `getWebUrl(ctx, itemRef)` — Returns a deep link to open or co-author the item in the native web/desktop application.
- `getEffectiveAccess(ctx, itemRef)` — Returns `{ canView, canDownload, canUpload, canEdit, canDelete, canManagePermissions }` for the current user so the UI hides actions the store will deny.

#### Provisioning-Context Operations (`ctx: ProvisioningAccessContext`)
- `testConnection(ctx, options?)` — Verifies application (and optionally delegated user) connectivity, returning structured non-sensitive diagnostics.
- `resolveLocation(ctx, input)` — Parses a pasted browser URL (e.g. a SharePoint library view URL), resolves stable provider IDs (`siteId`, `driveId`, `webUrl`, `displayName`), and returns them for admin confirmation.
- `ensureFolderTree(ctx, rootRef, tree)` — Idempotently creates a nested folder hierarchy and returns a map of relative paths to stable provider `itemId`s.
- `getPermissions(ctx, itemRef)` — Returns current grants, whether inheritance is broken (`inheritsFromParent: boolean`), and any detected sharing links (`sharingLinks`).
- `setPermissions(ctx, itemRef, intendedGrants, options: { inherit: boolean })` — Breaks or restores inheritance and reconciles explicit principal grants to match `intendedGrants`.
- `resolvePrincipal(ctx, ref)` — Resolves a 1Squared `Person` (by `entraObjectId` or UPN) or configured group ID to a verified provider principal.

### 3. Provider Registry & Normalised Domain Errors

- `DocumentStoreRegistry` maps `provider: 'sharepoint'` to `SharePointDocumentStoreProvider`.
- `azure_blob`, `imanage`, and `netdocuments` are reserved in the schema enum and rejected by the config validator and registry with a clear `"Provider '<type>' is reserved in the schema and not yet supported in this release"` error.
- All provider exceptions are normalised into `DocumentStoreError` with canonical codes:
  - `not_found`
  - `access_denied`
  - `conflict`
  - `throttled` (carrying `retryAfterSeconds`)
  - `unavailable`
  - `misconfigured`
  - `reauthentication_required` (carrying optional OAuth `claimsChallenge`)

### 4. Phase 2 Non-Breaking Extensibility

To guarantee Phase 2 capabilities require zero breaking changes to `DocumentStoreProvider`, tenant configuration, or database tables:
- **Retention labels on matter closure:** `DocumentStoreCapabilities.supportsRetentionLabels` is declared now; `MatterDocumentLocation` includes an optional `retentionLabelId` column; matter closure executes an optional `applyRetentionLabel` lifecycle hook.
- **SharePoint metadata columns & content types:** `DocumentItemMetadata` includes `customMetadata?: Record<string, unknown>` and `contentTypeId?: string`.
- **Search within a matter's documents:** Optional `searchItems?(ctx: UserAccessContext, scopeRef, query, paging)` method on `DocumentStoreProvider`.
- **Change notifications & delta sync:** Optional `getChanges?(ctx: ProvisioningAccessContext, containerRef, deltaToken)` method and `delta_sync_cursor` column on `matter_document_locations`.
- **Email filing from Outlook:** Folder nodes support optional `filingAliases?: string[]` in templates so an Outlook add-in can target canonical folders (e.g., `Correspondence`).
- **External client sharing:** Permission reconciliation already distinguishes internal principal grants from `sharingLinks` so controlled external guest sharing can be policy-gated in Phase 2.
- **Document templates & precedent generation:** `GeneratedDocumentRecord` (`ADR-0008`) already carries `storageProvider`, `externalId`, and `externalVersion` so generated documents can be saved directly into the matter's routed `DocumentStoreProvider` folder.
- **Other providers (`azure_blob`, `imanage`, `netdocuments`):** Container/item references use provider-agnostic `{ storeId, libraryId, itemId, path }` tuples.

## Alternatives Considered

1. **Extend `DocumentStorageProvider` (ADR-0008) in place.**
   - *Rejected:* `DocumentStorageProvider` is a flat blob store for internal template binaries and generated artefacts using platform-scoped SAS tokens. Mixing user-delegated DMS folder hierarchies and ACL inheritance into `DocumentStorageProvider` would violate single responsibility and break backward compatibility.
2. **Pass a boolean `asAdmin: boolean` flag instead of `UserAccessContext | ProvisioningAccessContext`.**
   - *Rejected:* Separate discriminated union types make it impossible to accidentally call a user operation with provisioning credentials or vice versa, and allow static and runtime assertions that user-facing HTTP routes never construct a `ProvisioningAccessContext`.

## Consequences

- Domain services and React components depend exclusively on `DocumentStoreProvider` and `DocumentStoreCapabilities`.
- In Phase 1, `SharePointDocumentStoreProvider` is mock-backed via `MockSharePointGraphBackend`, which enforces tenant partitioning, inheritance vs explicit folder ACLs, resumable chunked uploads, and HTTP 429 retry semantics without external network dependencies. Live Microsoft Graph HTTP transport and certificate/Managed Identity token exchange via Key Vault are scheduled for Phase 2 via injectable `oboExchangeHandler` / `appTokenHandler` and Graph transport adapters.
- Adding iManage Work, NetDocuments, or Azure Blob Storage in Phase 2 requires only a new adapter class registered in `DocumentStoreRegistry`.
