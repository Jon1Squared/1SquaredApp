/**
 * Zero-PII Document Store Audit & Telemetry Helper (`core/src/domain/documents/audit.ts`).
 *
 * Implements Section 2, Section 9, Section 10 & ADR-0020:
 * - Audit entries for provisioning actions record both the application identity (`identityUsed: 'provisioning'`)
 *   and the 1Squared user or event that triggered them (`actorUserId`, `triggerEvent`).
 * - Never logs or persists file names, folder names, relative paths, document content, or access tokens.
 * - Uses `providerItemId`, `matterId`, `storeId`, `libraryId`, `tenantId`, and `correlationId` only.
 */

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../api/index';
import type {
  DocumentStoreAuditAction,
  DocumentStoreAuditEventRecord,
} from './types';

const FORBIDDEN_AUDIT_METADATA_KEYS = new Set([
  'filename',
  'file_name',
  'foldername',
  'folder_name',
  'name',
  'path',
  'relativepath',
  'relative_path',
  'basepath',
  'base_path',
  'weburl',
  'web_url',
  'content',
  'body',
  'accesstoken',
  'access_token',
  'token',
  'authorization',
  'clientsecret',
  'client_secret',
  'assertion',
  'userassertion',
  'matterdescription',
  'clientname',
]);

/**
 * Redacts any forbidden keys (such as file names, folder names, paths, URLs, or tokens)
 * from structured audit or log metadata so client content never leaks into logs or audit rows.
 */
export function sanitiseAuditMetadata(
  rawMetadata?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!rawMetadata) return {};
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawMetadata)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (FORBIDDEN_AUDIT_METADATA_KEYS.has(normalizedKey)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitiseAuditMetadata(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

export interface CreateDocumentAuditEventParams {
  context: Pick<TenantContext, 'tenantId' | 'correlationId'> & {
    actorId?: string | null;
    actorUserId?: string | null;
  };
  identityUsed: 'user' | 'provisioning';
  triggerEvent: string;
  action: DocumentStoreAuditAction;
  matterId?: string | null;
  storeId?: string | null;
  libraryId?: string | null;
  providerItemId?: string | null;
  outcome: 'succeeded' | 'denied' | 'failed';
  errorCode?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
  occurredAt?: string;
}

/**
 * Creates an immutable, zero-PII `DocumentStoreAuditEventRecord`.
 */
export function buildDocumentStoreAuditEvent(
  params: CreateDocumentAuditEventParams,
): DocumentStoreAuditEventRecord {
  if (!params.context.tenantId) {
    throw new Error('TENANT_ISOLATION_VIOLATION: Audit event requires tenantId.');
  }

  return {
    id: `doc-audit-${randomUUID()}`,
    tenantId: params.context.tenantId,
    correlationId: params.context.correlationId || `corr-${randomUUID()}`,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    actorUserId:
      params.context.actorId ?? params.context.actorUserId ?? null,
    identityUsed: params.identityUsed,
    triggerEvent: params.triggerEvent,
    action: params.action,
    matterId: params.matterId ?? null,
    storeId: params.storeId ?? null,
    libraryId: params.libraryId ?? null,
    providerItemId: params.providerItemId ?? null,
    outcome: params.outcome,
    errorCode: params.errorCode ?? null,
    metadata: sanitiseAuditMetadata(params.metadata),
  };
}
