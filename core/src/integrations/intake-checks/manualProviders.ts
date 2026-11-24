/**
 * Manual Stage 1 Intake Check Provider Implementations (`core/src/integrations/intake-checks/manualProviders.ts`).
 *
 * Implements ADR 0038 (`S1-D1`):
 * - Every provider records explicit staff-entered outcomes against a verified `TenantContext`,
 *   server-derived `recordedByPersonId`, server timestamp, and validated `'evidence'` storage blobs.
 * - Zero simulated/sandbox third-party adapters exist in Stage 1.
 */

import crypto from 'node:crypto';
import type {
  DocumentStorageProvider,
  ESignatureEnvelopeRecord,
  ESignatureOutcome,
  ESignatureProvider,
  IdentityVerificationOutcome,
  IdentityVerificationProvider,
  IdentityVerificationRecord,
  IntakeEvidenceArtifactRef,
  PaymentRequestOutcome,
  PaymentRequestProvider,
  PaymentRequestRecord,
  RecordManualESignatureInput,
  RecordManualIdentityVerificationInput,
  RecordManualPaymentRequestInput,
  RecordManualSanctionsPepInput,
  SanctionsPepOutcome,
  SanctionsPepScreeningProvider,
  SanctionsPepScreeningRecord,
  TenantContext,
} from '../../api/index';
import { assertBlobKeyBelongsToTenant } from '../../tenancy/blobStorage';
import {
  ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND,
  TenantIntakeCheckRepository,
  type StoredIntakeCheckRow,
} from '../../tenancy/intakeCheckRepository';

const IDENTITY_OUTCOMES = new Set(
  ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND.identity_verification,
);
const SANCTIONS_OUTCOMES = new Set(
  ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND.sanctions_pep,
);
const ESIG_REQUEST_OUTCOMES = new Set<ESignatureOutcome>([
  'requested_manual',
  'declined',
]);
const ESIG_SIGNED_OUTCOMES = new Set<ESignatureOutcome>([
  'signed_uploaded',
  'declined',
]);
const PAYMENT_OUTCOMES = new Set(
  ALLOWED_INTAKE_CHECK_OUTCOMES_BY_KIND.payment_request,
);

export class IntakeCheckIntegrationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'IntakeCheckIntegrationError';
    this.code = code;
  }
}

export interface ManualIntakeCheckProviderDependencies {
  readonly repository: TenantIntakeCheckRepository;
  readonly storageProvider: DocumentStorageProvider;
}

function assertValidContext(ctx: TenantContext): void {
  if (!ctx?.tenantId || !ctx?.actorId) {
    throw new IntakeCheckIntegrationError(
      'INTAKE_CHECK_UNAUTHENTICATED',
      'Authenticated TenantContext with actorId is required.',
    );
  }
}

export async function verifyEvidenceArtifacts(
  ctx: TenantContext,
  storageProvider: DocumentStorageProvider,
  refs: readonly IntakeEvidenceArtifactRef[] | undefined,
): Promise<IntakeEvidenceArtifactRef[]> {
  if (!refs || refs.length === 0) {
    return [];
  }
  const verified: IntakeEvidenceArtifactRef[] = [];
  for (const ref of refs) {
    if (!ref?.blobKey?.trim()) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_EVIDENCE',
        'Evidence artifact reference must carry a valid blobKey.',
      );
    }
    assertBlobKeyBelongsToTenant(ctx, ref.blobKey);
    if (ref.scanStatus !== 'clean') {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_UNSAFE_EVIDENCE',
        `Evidence artifact cannot be attached while scan status is "${String(ref.scanStatus)}".`,
      );
    }
    const scanStatus = await storageProvider.getMalwareScanStatus(ctx, ref.blobKey);
    if (scanStatus !== 'clean') {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_UNSAFE_EVIDENCE',
        `Stored evidence scan status is "${scanStatus}"; expected "clean".`,
      );
    }
    const bytes = await storageProvider.getObjectBytes(ctx, {
      blobKey: ref.blobKey,
    });
    const actualSha = crypto
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    if (ref.sha256 && ref.sha256.toLowerCase() !== actualSha.toLowerCase()) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_EVIDENCE_CHECKSUM_MISMATCH',
        'Evidence artifact checksum does not match stored object bytes.',
      );
    }
    verified.push({
      blobKey: ref.blobKey,
      sha256: actualSha,
      contentType: ref.contentType,
      sizeBytes: bytes.length,
      scanStatus: 'clean',
      ...(ref.fileName ? { fileName: ref.fileName } : {}),
      ...(ref.uploadedByActorId ? { uploadedByActorId: ref.uploadedByActorId } : {}),
      ...(ref.uploadedAt ? { uploadedAt: ref.uploadedAt } : {}),
    });
  }
  return verified;
}

function mapIdentityRow(row: StoredIntakeCheckRow): IdentityVerificationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    checkKind: 'identity_verification',
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcome: row.outcome as IdentityVerificationOutcome,
    verificationMethod: String(row.metadata.verificationMethod ?? ''),
    referenceCode: row.referenceCode,
    expiresAt:
      typeof row.metadata.expiresAt === 'string'
        ? row.metadata.expiresAt
        : null,
    notes: typeof row.metadata.notes === 'string' ? row.metadata.notes : null,
    evidenceRefs: row.evidenceRefs,
    recordedByPersonId: row.recordedByPersonId,
    recordedAt: row.recordedAt,
    correlationId: row.correlationId,
  };
}

function mapSanctionsRow(
  row: StoredIntakeCheckRow,
): SanctionsPepScreeningRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    checkKind: 'sanctions_pep',
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcome: row.outcome as SanctionsPepOutcome,
    screeningScope: String(row.metadata.screeningScope ?? ''),
    referenceCode: row.referenceCode,
    notes: typeof row.metadata.notes === 'string' ? row.metadata.notes : null,
    evidenceRefs: row.evidenceRefs,
    recordedByPersonId: row.recordedByPersonId,
    recordedAt: row.recordedAt,
    correlationId: row.correlationId,
  };
}

function mapESignatureRow(row: StoredIntakeCheckRow): ESignatureEnvelopeRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    checkKind: 'e_signature',
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcome: row.outcome as ESignatureOutcome,
    referenceCode: row.referenceCode,
    documentId:
      typeof row.metadata.documentId === 'string'
        ? row.metadata.documentId
        : null,
    notes: typeof row.metadata.notes === 'string' ? row.metadata.notes : null,
    evidenceRefs: row.evidenceRefs,
    recordedByPersonId: row.recordedByPersonId,
    recordedAt: row.recordedAt,
    correlationId: row.correlationId,
  };
}

function mapPaymentRow(row: StoredIntakeCheckRow): PaymentRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    checkKind: 'payment_request',
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    outcome: row.outcome as PaymentRequestOutcome,
    amountMinorUnits: row.amountMinorUnits ?? BigInt(0),
    currency: row.currency ?? 'GBP',
    clientAccountReference: String(row.metadata.clientAccountReference ?? ''),
    bankStatementReference:
      typeof row.metadata.bankStatementReference === 'string'
        ? row.metadata.bankStatementReference
        : null,
    referenceCode: row.referenceCode,
    notes: typeof row.metadata.notes === 'string' ? row.metadata.notes : null,
    evidenceRefs: row.evidenceRefs,
    recordedByPersonId: row.recordedByPersonId,
    recordedAt: row.recordedAt,
    correlationId: row.correlationId,
  };
}

export class ManualIdentityVerificationProvider
  implements IdentityVerificationProvider
{
  public readonly providerId = 'manual' as const;
  private readonly deps: ManualIntakeCheckProviderDependencies;

  public constructor(deps: ManualIntakeCheckProviderDependencies) {
    this.deps = deps;
  }

  public async recordManualCheck(
    ctx: TenantContext,
    input: RecordManualIdentityVerificationInput,
  ): Promise<IdentityVerificationRecord> {
    assertValidContext(ctx);
    if (typeof input.outcome !== 'string' || !IDENTITY_OUTCOMES.has(input.outcome)) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_OUTCOME',
        `Invalid identity verification outcome "${String(input.outcome)}".`,
      );
    }
    const evidenceRefs = await verifyEvidenceArtifacts(
      ctx,
      this.deps.storageProvider,
      input.evidenceRefs,
    );
    const saved = await this.deps.repository.recordCheck(ctx, {
      checkKind: 'identity_verification',
      provider: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      referenceCode: input.referenceCode ?? null,
      metadata: {
        verificationMethod: input.verificationMethod,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      },
      evidenceRefs,
    });
    return mapIdentityRow(saved);
  }

  public async getLatestCheckForSubject(
    ctx: TenantContext,
    subject: {
      readonly subjectType: 'person' | 'organisation' | 'matter' | 'quote';
      readonly subjectId: string;
    },
  ): Promise<IdentityVerificationRecord | null> {
    assertValidContext(ctx);
    const latest = await this.deps.repository.getLatestCheckForSubject(ctx, {
      checkKind: 'identity_verification',
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    });
    return latest ? mapIdentityRow(latest) : null;
  }
}

export class ManualSanctionsPepScreeningProvider
  implements SanctionsPepScreeningProvider
{
  public readonly providerId = 'manual' as const;
  private readonly deps: ManualIntakeCheckProviderDependencies;

  public constructor(deps: ManualIntakeCheckProviderDependencies) {
    this.deps = deps;
  }

  public async recordManualScreening(
    ctx: TenantContext,
    input: RecordManualSanctionsPepInput,
  ): Promise<SanctionsPepScreeningRecord> {
    assertValidContext(ctx);
    if (typeof input.outcome !== 'string' || !SANCTIONS_OUTCOMES.has(input.outcome)) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_OUTCOME',
        `Invalid sanctions/PEP screening outcome "${String(input.outcome)}".`,
      );
    }
    const evidenceRefs = await verifyEvidenceArtifacts(
      ctx,
      this.deps.storageProvider,
      input.evidenceRefs,
    );
    const saved = await this.deps.repository.recordCheck(ctx, {
      checkKind: 'sanctions_pep',
      provider: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      referenceCode: input.referenceCode ?? null,
      metadata: {
        screeningScope: input.screeningScope,
        notes: input.notes ?? null,
      },
      evidenceRefs,
    });
    return mapSanctionsRow(saved);
  }

  public async getLatestScreeningForSubject(
    ctx: TenantContext,
    subject: {
      readonly subjectType: 'person' | 'organisation' | 'matter' | 'quote';
      readonly subjectId: string;
    },
  ): Promise<SanctionsPepScreeningRecord | null> {
    assertValidContext(ctx);
    const latest = await this.deps.repository.getLatestCheckForSubject(ctx, {
      checkKind: 'sanctions_pep',
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    });
    return latest ? mapSanctionsRow(latest) : null;
  }
}

export class ManualESignatureProvider implements ESignatureProvider {
  public readonly providerId = 'manual' as const;
  private readonly deps: ManualIntakeCheckProviderDependencies;

  public constructor(deps: ManualIntakeCheckProviderDependencies) {
    this.deps = deps;
  }

  public async recordManualRequest(
    ctx: TenantContext,
    input: RecordManualESignatureInput,
  ): Promise<ESignatureEnvelopeRecord> {
    const resolvedOutcome: ESignatureOutcome =
      input.outcome === undefined ? 'requested_manual' : input.outcome;
    if (!ESIG_REQUEST_OUTCOMES.has(resolvedOutcome)) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_OUTCOME',
        `Invalid e-signature request outcome "${String(input.outcome)}".`,
      );
    }
    return this.recordEnvelope(ctx, {
      ...input,
      outcome: resolvedOutcome,
    });
  }

  public async recordManualSignedDocument(
    ctx: TenantContext,
    input: RecordManualESignatureInput,
  ): Promise<ESignatureEnvelopeRecord> {
    const resolvedOutcome: ESignatureOutcome =
      input.outcome === undefined ? 'signed_uploaded' : input.outcome;
    if (!ESIG_SIGNED_OUTCOMES.has(resolvedOutcome)) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_OUTCOME',
        `Invalid e-signature signed-document outcome "${String(input.outcome)}".`,
      );
    }
    return this.recordEnvelope(ctx, {
      ...input,
      outcome: resolvedOutcome,
    });
  }

  private async recordEnvelope(
    ctx: TenantContext,
    input: RecordManualESignatureInput,
  ): Promise<ESignatureEnvelopeRecord> {
    assertValidContext(ctx);
    const evidenceRefs = await verifyEvidenceArtifacts(
      ctx,
      this.deps.storageProvider,
      input.evidenceRefs,
    );
    const saved = await this.deps.repository.recordCheck(ctx, {
      checkKind: 'e_signature',
      provider: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      referenceCode: input.referenceCode ?? null,
      metadata: {
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
      },
      evidenceRefs,
    });
    return mapESignatureRow(saved);
  }

  public async getLatestEnvelope(
    ctx: TenantContext,
    subject: {
      readonly subjectType: 'person' | 'organisation' | 'matter' | 'quote';
      readonly subjectId: string;
    },
  ): Promise<ESignatureEnvelopeRecord | null> {
    assertValidContext(ctx);
    const latest = await this.deps.repository.getLatestCheckForSubject(ctx, {
      checkKind: 'e_signature',
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    });
    return latest ? mapESignatureRow(latest) : null;
  }
}

export class ManualPaymentRequestProvider implements PaymentRequestProvider {
  public readonly providerId = 'manual' as const;
  private readonly deps: ManualIntakeCheckProviderDependencies;

  public constructor(deps: ManualIntakeCheckProviderDependencies) {
    this.deps = deps;
  }

  public async recordManualPaymentRequest(
    ctx: TenantContext,
    input: RecordManualPaymentRequestInput,
  ): Promise<PaymentRequestRecord> {
    return this.recordPaymentEntry(ctx, input, 'requested_manual');
  }

  public async recordManualReceipt(
    ctx: TenantContext,
    input: RecordManualPaymentRequestInput,
  ): Promise<PaymentRequestRecord> {
    return this.recordPaymentEntry(ctx, input, 'receipt_recorded_manual');
  }

  private async recordPaymentEntry(
    ctx: TenantContext,
    input: RecordManualPaymentRequestInput,
    outcome: PaymentRequestOutcome,
  ): Promise<PaymentRequestRecord> {
    assertValidContext(ctx);
    if (!PAYMENT_OUTCOMES.has(outcome)) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_OUTCOME',
        `Invalid payment request outcome "${String(outcome)}".`,
      );
    }
    if (
      typeof input.amountMinorUnits !== 'bigint' ||
      input.amountMinorUnits < BigInt(0)
    ) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_AMOUNT',
        'Payment amounts must be non-negative bigint integer minor units (pence).',
      );
    }
    if (!input.clientAccountReference?.trim()) {
      throw new IntakeCheckIntegrationError(
        'INTAKE_CHECK_INVALID_REFERENCE',
        'Client account payment reference is required.',
      );
    }
    const evidenceRefs = await verifyEvidenceArtifacts(
      ctx,
      this.deps.storageProvider,
      input.evidenceRefs,
    );
    const saved = await this.deps.repository.recordCheck(ctx, {
      checkKind: 'payment_request',
      provider: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency ?? 'GBP',
      referenceCode: input.referenceCode ?? null,
      metadata: {
        clientAccountReference: input.clientAccountReference.trim(),
        bankStatementReference: input.bankStatementReference?.trim() || null,
        notes: input.notes ?? null,
      },
      evidenceRefs,
    });
    return mapPaymentRow(saved);
  }

  public async getPaymentRequest(
    ctx: TenantContext,
    id: string,
  ): Promise<PaymentRequestRecord | null> {
    assertValidContext(ctx);
    const found = await this.deps.repository.getCheckById(ctx, id);
    if (!found || found.checkKind !== 'payment_request') {
      return null;
    }
    return mapPaymentRow(found);
  }
}
