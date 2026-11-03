# ADR-0020: Storing Document References Rather Than Copies and Zero-PII Telemetry

- **Date:** 2026-11-02
- **Status:** Proposed
- **Related:** [ADR-0017](./0017-document-store-provider-abstraction.md), [ADR-0018](./0018-two-identity-authentication-model.md)

## Context

Law firms use SharePoint Online (or iManage / NetDocuments) as their authoritative system of record for matter files. Copying or caching matter document contents, or persisting confidential client/matter file names in platform logs and telemetry, creates three unacceptable risks:
1. **Split Brain / Version Drift:** Co-authoring in Word Online or desktop Office updates the file directly in SharePoint; any copy held in 1Squared would immediately become stale.
2. **Data Protection & UK GDPR Compliance (`docs/architecture-standard.md` Section 10):** Matter file names and folder paths routinely contain client names, opposing party names, property addresses, and sensitive matter descriptions (e.g. `10042-0001 Smith v Jones - Settlement Agreement.docx`).
3. **Security Bypass Risk:** Caching document content or folder listings across users could leak files to a user whose SharePoint permissions were revoked.

## Decision

### 1. Store Only Structural References (`MatterDocumentLocation`), Never Content Copies

- 1Squared never stores matter document file bytes in PostgreSQL, local disk, Redis, or platform caches.
- In the tenant database, `matter_document_locations` stores only the link between a `Matter` and its provisioned/linked root folder in a configured document store:
  - `id`, `tenant_id`, `matter_id`, `store_id`, `library_id`
  - `provider_site_id`, `provider_drive_id`, `provider_folder_item_id`
  - `relative_path` (encrypted/tenant-scoped inside the tenant's own isolated database only, used for routing comparison)
  - `template_id`, `template_version`
  - `provisioning_status` (`'pending' | 'provisioned' | 'failed'`), `last_error_code`, `last_error_message`
  - `has_unique_permissions`, `unique_scope_count`
  - `retention_label_id` (Phase 2 hook), `delta_sync_cursor` (Phase 2 hook)
- Live folder contents (`listItems`), item metadata (`getItem`), and effective user permissions (`getEffectiveAccess`) are queried on demand from the provider through the signed-in user's OBO identity.
- File downloads (`downloadContent`) and uploads (`uploadContent`) stream directly between the browser, the 1Squared API, and Microsoft Graph without buffering to disk or caching.

### 2. Provider Item IDs Only in Logs, Telemetry, and Audit Records

- Structured application logs and telemetry include:
  - `correlationId`
  - `tenantId`
  - `storeId`, `libraryId`
  - `matterId`
  - `providerItemId` (the opaque Microsoft Graph `driveItem.id`)
  - `identityKind` (`'user'` or `'provisioning'`)
  - `actorId`
  - `operation` and `outcome` (`'succeeded' | 'denied' | 'failed'`)
- **Forbidden in logs, telemetry, and error messages:** File names, folder names, relative paths, SharePoint search queries, and document body content. A log sanitiser strips any URL paths or file names before emitting log events.
- Immutable audit entries (`document_store_audit_events`) record:
  - `id`, `tenant_id`, `correlation_id`, `occurred_at`
  - `actor_user_id`, `identity_used` (`'user' | 'provisioning'`), `trigger_event`
  - `action` (config change, connection test, lifecycle provision/move/close/reopen/link, permission update, reconciliation run/remediation, document upload/download/rename/move/delete)
  - `matter_id`, `store_id`, `library_id`, `provider_item_id`
  - `outcome`, `error_code`, and structured non-sensitive metadata (e.g. before/after config or permission grant counts/principal IDs, never file names).

### 3. Phase 2 Readiness for Search and Activity Feeds

- **Search within a matter's documents (Phase 2):** Delegated to Microsoft Graph Search / Drive search (`GET /drives/{driveId}/items/{matterFolderItemId}/search(q='...')`) using the user's OBO token, avoiding any platform-side full-text index of client document contents.
- **Change notifications & delta sync (Phase 2):** Uses `GET /drives/{driveId}/items/{matterFolderItemId}/delta` with `delta_sync_cursor` on `matter_document_locations` to record activity-feed references by `providerItemId` and resolve display names live only for users authorised to view the item.

## Alternatives Considered

1. **Sync a shadow table of all `driveItem` file names and metadata into PostgreSQL.**
   - *Rejected for Phase 1:* Syncing all file names into PostgreSQL duplicates confidential client metadata, requires continuous webhook/delta maintenance, and risks showing a user file names in 1Squared that SharePoint would hide from them. Querying the matter folder live via OBO guarantees real-time accuracy and permission enforcement.
2. **Proxy uploads through a temporary local disk staging folder.**
   - *Rejected:* Streaming chunks directly to Microsoft Graph's upload session (`createUploadSession`) avoids writing confidential legal documents to application container storage.

## Consequences

- SharePoint Online remains the single source of truth for document contents, versions, co-authoring locks, and ACLs.
- Platform logs and telemetry contain zero client names, file names, or folder paths.
