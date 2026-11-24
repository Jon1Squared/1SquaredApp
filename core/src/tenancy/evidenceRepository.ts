/**
 * Tenant-Scoped Evidence Artifact Repository (`core/src/tenancy/evidenceRepository.ts`).
 *
 * Indexes uploaded `'evidence'` blobs (`tenant-<tenantId>-<env>/evidence/...`) in
 * `public.evidence_artifacts` (migration `0025`, ADR 0039) so `/api/evidence/upload` and
 * `/api/evidence/download` enforce tenant ownership, subject scoping, checksum integrity,
 * clean malware scan status, and zero-PII audit trails inside `withTenantTransaction`.
 */

import type {
  EvidenceArtifactRecord,
  EvidenceArtifactSubjectType,
  FirmAuditEntryInput,
  MalwareScanStatus,
  TenantContext,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  toIsoString,
  type TenantSqlClient,
} from './tenantScopedRepository';

interface DbEvidenceArtifactRow {
  tenant_id: string;
  id: string;
  blob_key: string;
  subject_type: EvidenceArtifactSubjectType;
  subject_id: string;
  file_name: string;
  content_type: string;
  byte_size: number | string;
  sha256: string;
  scan_status: MalwareScanStatus;
  uploaded_by_person_id: string;
  uploaded_at: Date | string;
}

function mapEvidenceArtifactRow(row: DbEvidenceArtifactRow): EvidenceArtifactRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    blobKey: row.blob_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    scanStatus: row.scan_status,
    uploadedByPersonId: row.uploaded_by_person_id,
    uploadedAt: toIsoString(row.uploaded_at) ?? new Date().toISOString(),
  };
}

export class TenantEvidenceArtifactRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(
    options: {
      poolManager?: TenantPostgresPoolManager;
      auditRepo?: TenantAuditRepository;
    } = {},
  ) {
    super({ poolManager: options.poolManager });
    this.auditRepo =
      options.auditRepo ??
      new TenantAuditRepository({ poolManager: this.poolManager });
  }

  private async allocateArtifactIdInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
  ): Promise<string> {
    const maxRes = await tx.query<{ max_num: string | null }>(
      `SELECT MAX(substring(id from '^EVD-([0-9]+)$')::bigint)::text AS max_num
       FROM public.evidence_artifacts
       WHERE tenant_id = $1 AND id ~ '^EVD-[0-9]+$'`,
      [ctx.tenantId],
    );
    const maxExisting = Number(maxRes.rows[0]?.max_num ?? '0') || 0;
    const seqRes = await tx.query<{ next_val: string }>(
      `SELECT nextval('public.tenant_evidence_artifact_id_seq')::text AS next_val`,
    );
    const seqNum = Number(seqRes.rows[0]?.next_val ?? '1') || 1;
    const num = Math.max(maxExisting + 1, seqNum);
    return `EVD-${String(num).padStart(6, '0')}`;
  }

  public async createArtifactInTx(
    tx: TenantSqlClient,
    ctx: TenantContext,
    input: {
      readonly id?: string;
      readonly blobKey: string;
      readonly subjectType: EvidenceArtifactSubjectType;
      readonly subjectId: string;
      readonly fileName: string;
      readonly contentType: string;
      readonly byteSize: number;
      readonly sha256: string;
      readonly scanStatus: MalwareScanStatus;
      readonly uploadedByPersonId: string;
      readonly uploadedAt?: string;
    },
    options?: {
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<EvidenceArtifactRecord> {
    if (input.scanStatus !== 'clean') {
      const err = new Error(
        `EVIDENCE_MALWARE_DETECTED: Cannot persist evidence artifact with scanStatus "${input.scanStatus}".`,
      ) as Error & { code: string };
      err.code = 'EVIDENCE_MALWARE_DETECTED';
      throw err;
    }
    const id = input.id?.trim() || (await this.allocateArtifactIdInTx(tx, ctx));
    const uploadedAt = input.uploadedAt || new Date().toISOString();
    const res = await tx.query<DbEvidenceArtifactRow>(
      `INSERT INTO public.evidence_artifacts (
         tenant_id, id, blob_key, subject_type, subject_id,
         file_name, content_type, byte_size, sha256, scan_status,
         uploaded_by_person_id, uploaded_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::bigint, $9, $10,
         $11, $12::timestamptz
       )
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        input.blobKey,
        input.subjectType,
        input.subjectId,
        input.fileName,
        input.contentType,
        Math.floor(input.byteSize),
        input.sha256,
        input.scanStatus,
        input.uploadedByPersonId,
        uploadedAt,
      ],
    );
    const inserted = res.rows[0]!;
    this.assertRowTenant(ctx, inserted.tenant_id, 'evidence_artifacts.create');

    if (options?.auditEntries?.length) {
      await this.auditRepo.appendAuditEntries(ctx, options.auditEntries);
    }

    return mapEvidenceArtifactRow(inserted);
  }

  public async createArtifact(
    ctx: TenantContext,
    input: {
      readonly id?: string;
      readonly blobKey: string;
      readonly subjectType: EvidenceArtifactSubjectType;
      readonly subjectId: string;
      readonly fileName: string;
      readonly contentType: string;
      readonly byteSize: number;
      readonly sha256: string;
      readonly scanStatus: MalwareScanStatus;
      readonly uploadedByPersonId: string;
      readonly uploadedAt?: string;
    },
    options?: {
      auditEntries?: readonly FirmAuditEntryInput[];
    },
  ): Promise<EvidenceArtifactRecord> {
    return this.withTenantTransaction(ctx, async (tx) =>
      this.createArtifactInTx(tx, ctx, input, options),
    );
  }

  public async getArtifactById(
    ctx: TenantContext,
    artifactId: string,
  ): Promise<EvidenceArtifactRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEvidenceArtifactRow>(
        `SELECT *
         FROM public.evidence_artifacts
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [ctx.tenantId, artifactId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'evidence_artifacts.getById');
      return mapEvidenceArtifactRow(row);
    });
  }

  public async getArtifactByBlobKey(
    ctx: TenantContext,
    blobKey: string,
  ): Promise<EvidenceArtifactRecord | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEvidenceArtifactRow>(
        `SELECT *
         FROM public.evidence_artifacts
         WHERE tenant_id = $1 AND blob_key = $2
         LIMIT 1`,
        [ctx.tenantId, blobKey],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'evidence_artifacts.getByBlobKey');
      return mapEvidenceArtifactRow(row);
    });
  }

  public async listArtifactsForSubject(
    ctx: TenantContext,
    params: {
      readonly subjectType: EvidenceArtifactSubjectType;
      readonly subjectId: string;
    },
  ): Promise<EvidenceArtifactRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEvidenceArtifactRow>(
        `SELECT *
         FROM public.evidence_artifacts
         WHERE tenant_id = $1
           AND subject_type = $2
           AND subject_id = $3
         ORDER BY uploaded_at DESC, id DESC`,
        [ctx.tenantId, params.subjectType, params.subjectId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'evidence_artifacts.listForSubject');
        return mapEvidenceArtifactRow(row);
      });
    });
  }

  public async listAllArtifactsUnfiltered(
    ctx: TenantContext,
  ): Promise<EvidenceArtifactRecord[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<DbEvidenceArtifactRow>(
        `SELECT *
         FROM public.evidence_artifacts
         WHERE tenant_id = $1
         ORDER BY uploaded_at DESC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => {
        this.assertRowTenant(ctx, row.tenant_id, 'evidence_artifacts.listAllUnfiltered');
        return mapEvidenceArtifactRow(row);
      });
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        `DELETE FROM public.evidence_artifacts WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
    });
  }
}
