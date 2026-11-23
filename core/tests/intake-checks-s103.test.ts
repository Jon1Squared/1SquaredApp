import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_API_VERSION,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  CoreEmailDispatcher,
  createTenantIntakeCheckProviders,
  drainEmailOutboxForTenant,
  drainOutboxForTenant,
  GraphAppTokenProvider,
  loadAndValidateTenantConfig,
  LocalTenantStorageProvider,
  ManualESignatureProvider,
  ManualIdentityVerificationProvider,
  ManualPaymentRequestProvider,
  ManualSanctionsPepScreeningProvider,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  resolveIntakeChecksIntegrationConfig,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantIntakeCheckRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  type EmailAttachmentRef,
  type EmailInlineAttachment,
  type IntakeEvidenceArtifactRef,
  type TenantContext,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';

function makeTenantCtx(
  tenantId: string,
  actorId = 'P-000001',
  environment: 'test' | 'dev' = 'test',
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      roles: ['admin', 'partner'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment,
    correlationId: `corr-s103-${tenantId}-${actorId}`,
  });
}

async function startLocalSmtpCatcher() {
  const messages: Array<{
    mailFrom: string;
    rcptTo: string[];
    rawData: string;
  }> = [];

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost Simple Catcher ESMTP\r\n');
    let lineBuf = '';
    let inData = false;
    let dataBuf = '';
    let mailFrom = '';
    let rcptTo: string[] = [];

    socket.on('data', (chunk: string) => {
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\r\n')) !== -1) {
        const rawLine = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 2);
        if (inData) {
          if (rawLine === '.') {
            inData = false;
            messages.push({ mailFrom, rcptTo: [...rcptTo], rawData: dataBuf });
            dataBuf = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            dataBuf += (rawLine.startsWith('..') ? rawLine.slice(1) : rawLine) + '\r\n';
          }
          continue;
        }
        const upper = rawLine.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-localhost greets test\r\n250 SIZE 10485760\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          mailFrom = rawLine.slice(10).trim().replace(/^<|>$/g, '');
          rcptTo = [];
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          rcptTo.push(rawLine.slice(8).trim().replace(/^<|>$/g, ''));
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          dataBuf = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as net.AddressInfo;

  return {
    host: '127.0.0.1',
    port: addr.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('S1-03: Intake check interfaces, manual adapters, evidence storage & outbox-held attachments (ADR 0038, S1-D1, S1-D11)', () => {
  it('exposes CORE_API_VERSION 2.1.0, evidence storage category, and deep-merged integrations.intakeChecks config with fail-closed validation', async () => {
    expect(CORE_API_VERSION).toBe('2.1.0');
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(23);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's103-evid-'));
    tempDirs.push(tmpRoot);
    const storage = new LocalTenantStorageProvider({
      rootDir: tmpRoot,
      environment: 'test',
      tokenSigningKey: 's103-test-signing-key-32-chars-min',
    });

    const ctxAlpha = makeTenantCtx('tenant-alpha', 'P-A1');
    const cleanPdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
    const stored = await storage.putObject(ctxAlpha, {
      category: 'evidence',
      objectId: 'EVID-001',
      fileName: 'passport-check-secret-filename.pdf',
      contentType: 'application/pdf',
      bytes: cleanPdf,
    });
    expect(stored.blobKey).toContain(`${ctxAlpha.blobContainerName}/evidence/`);
    expect(stored.scanStatus).toBe('clean');
    const roundTrip = await storage.getObjectBytes(ctxAlpha, { blobKey: stored.blobKey });
    expect(new Uint8Array(roundTrip)).toEqual(cleanPdf);

    // Config deep-merge preserves sibling checks when overlay sets only one check
    const mergedCfg = loadAndValidateTenantConfig(
      {
        ...notALawFirmBaseConfig,
        integrations: {
          ...(notALawFirmBaseConfig.integrations ?? {}),
          intakeChecks: {
            idVerification: { provider: 'manual' },
            sanctionsPep: { provider: 'manual' },
            eSignature: { provider: 'manual' },
            payments: { provider: 'manual' },
          },
        },
      },
      {
        environment: 'dev',
        integrations: {
          intakeChecks: {
            eSignature: { provider: 'manual' },
          },
        },
      },
      'dev',
      'multi_tenant',
    );
    const resolved = resolveIntakeChecksIntegrationConfig(mergedCfg);
    expect(resolved.idVerification.provider).toBe('manual');
    expect(resolved.sanctionsPep.provider).toBe('manual');
    expect(resolved.eSignature.provider).toBe('manual');
    expect(resolved.payments.provider).toBe('manual');

    // Unknown provider string fails closed (no sandbox/simulated adapters permitted)
    expect(() =>
      loadAndValidateTenantConfig(
        {
          ...notALawFirmBaseConfig,
          integrations: {
            ...(notALawFirmBaseConfig.integrations ?? {}),
            intakeChecks: {
              idVerification: { provider: 'sandbox' },
            },
          },
        },
        { environment: 'dev' },
        'dev',
        'multi_tenant',
      ),
    ).toThrow();
  });

  it('persists manual intake checks with bigint minor units, evidence verification, zero-PII audit entries, and two-tenant isolation', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const ctxAlpha = makeTenantCtx('tenant-alpha', 'P-ALPHA-1');
    const ctxBravo = makeTenantCtx('tenant-bravo', 'P-BRAVO-1');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    const repo = new TenantIntakeCheckRepository();
    const auditRepo = new TenantAuditRepository();
    await repo.clearTenantData(ctxAlpha);
    await repo.clearTenantData(ctxBravo);

    const storage = new LocalTenantStorageProvider({
      inMemoryOnly: true,
      environment: 'test',
      tokenSigningKey: 's103-test-signing-key-32-chars-min',
    });

    const evidBytes = new TextEncoder().encode('%PDF-1.4\n%CDD Evidence Sample');
    const storedAlphaEvid = await storage.putObject(ctxAlpha, {
      category: 'evidence',
      objectId: 'EV-ALPHA-1',
      fileName: 'Celyn-Pritchard-Passport-Private.pdf',
      contentType: 'application/pdf',
      bytes: evidBytes,
    });
    const evidRefAlpha: IntakeEvidenceArtifactRef = {
      blobKey: storedAlphaEvid.blobKey,
      sha256: storedAlphaEvid.sha256,
      contentType: 'application/pdf',
      sizeBytes: storedAlphaEvid.sizeBytes,
      scanStatus: storedAlphaEvid.scanStatus,
    };

    const storedBravoEvid = await storage.putObject(ctxBravo, {
      category: 'evidence',
      objectId: 'EV-BRAVO-1',
      fileName: 'Bravo-Evidence.pdf',
      contentType: 'application/pdf',
      bytes: evidBytes,
    });
    const evidRefBravo: IntakeEvidenceArtifactRef = {
      blobKey: storedBravoEvid.blobKey,
      sha256: storedBravoEvid.sha256,
      contentType: 'application/pdf',
      sizeBytes: storedBravoEvid.sizeBytes,
      scanStatus: storedBravoEvid.scanStatus,
    };

    const cfg = loadAndValidateTenantConfig(
      notALawFirmBaseConfig,
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    const providers = createTenantIntakeCheckProviders({
      tenantConfig: cfg,
      repository: repo,
      storageProvider: storage,
    });
    expect(providers.idVerification).toBeInstanceOf(ManualIdentityVerificationProvider);
    expect(providers.sanctionsPep).toBeInstanceOf(ManualSanctionsPepScreeningProvider);
    expect(providers.eSignature).toBeInstanceOf(ManualESignatureProvider);
    expect(providers.payments).toBeInstanceOf(ManualPaymentRequestProvider);

    const idRec = await providers.idVerification.recordManualCheck(ctxAlpha, {
      subjectType: 'person',
      subjectId: 'P-C-001',
      outcome: 'verified',
      verificationMethod: 'In-person passport & utility bill',
      referenceCode: 'CHK-ID-001',
      evidenceRefs: [evidRefAlpha],
    });
    expect(idRec.provider).toBe('manual');
    expect(idRec.recordedByPersonId).toBe('P-ALPHA-1');
    const latestId = await providers.idVerification.getLatestCheckForSubject(
      ctxAlpha,
      { subjectType: 'person', subjectId: 'P-C-001' },
    );
    expect(latestId?.id).toBe(idRec.id);

    const sanctionsRec = await providers.sanctionsPep.recordManualScreening(ctxAlpha, {
      subjectType: 'organisation',
      subjectId: 'O-C-001',
      outcome: 'clear',
      screeningScope: 'OFSI & PEP manual check',
      evidenceRefs: [evidRefAlpha],
    });
    expect(sanctionsRec.outcome).toBe('clear');

    const esigRec = await providers.eSignature.recordManualSignedDocument(ctxAlpha, {
      subjectType: 'matter',
      subjectId: 'M-000001',
      outcome: 'signed_uploaded',
      evidenceRefs: [evidRefAlpha],
    });
    expect(esigRec.outcome).toBe('signed_uploaded');

    const payReq = await providers.payments.recordManualPaymentRequest(ctxAlpha, {
      subjectType: 'matter',
      subjectId: 'M-000001',
      amountMinorUnits: BigInt(125000),
      currency: 'GBP',
      clientAccountReference: 'MAT-001-POA',
    });
    expect(payReq.amountMinorUnits).toBe(BigInt(125000));
    const payReceipt = await providers.payments.recordManualReceipt(ctxAlpha, {
      subjectType: 'matter',
      subjectId: 'M-000001',
      amountMinorUnits: BigInt(125000),
      currency: 'GBP',
      clientAccountReference: 'MAT-001-POA',
      bankStatementReference: 'BACS-99182',
      evidenceRefs: [evidRefAlpha],
    });
    expect(payReceipt.amountMinorUnits).toBe(BigInt(125000));

    // Reject negative bigint minor units
    await expect(
      providers.payments.recordManualPaymentRequest(ctxAlpha, {
        subjectType: 'matter',
        subjectId: 'M-000001',
        amountMinorUnits: BigInt(-50),
        currency: 'GBP',
        clientAccountReference: 'MAT-001-NEG',
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_AMOUNT/);

    // Verify audit entries contain zero filenames or PII
    const audits = await auditRepo.listAuditEntriesForRecord(
      ctxAlpha,
      'intake_check',
      idRec.id,
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain('Celyn-Pritchard-Passport-Private.pdf');

    // Cross-tenant evidence blobKey, pending/infected evidence, and tampered subject lookups fail closed
    await expect(
      providers.idVerification.recordManualCheck(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-002',
        outcome: 'verified',
        verificationMethod: 'Tampered cross-tenant blob',
        evidenceRefs: [evidRefBravo],
      }),
    ).rejects.toThrow(/STORAGE_TENANCY_ISOLATION_ERROR/);
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-002',
      }),
    ).toBeNull();

    await expect(
      providers.idVerification.recordManualCheck(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-003',
        outcome: 'verified',
        verificationMethod: 'Quarantined blob',
        evidenceRefs: [{ ...evidRefAlpha, scanStatus: 'quarantined' }],
      }),
    ).rejects.toThrow(/INTAKE_CHECK_UNSAFE_EVIDENCE/);

    // Bravo sees nothing created by Alpha
    const bravoReadAlpha = await providers.idVerification.getLatestCheckForSubject(
      ctxBravo,
      { subjectType: 'person', subjectId: 'P-C-001' },
    );
    expect(bravoReadAlpha).toBeNull();
    const bravoGetById = await repo.getCheckById(ctxBravo, idRec.id);
    expect(bravoGetById).toBeNull();

    // R668: Invalid intake check outcomes are refused at runtime in providers & repository with zero rows written
    await expect(
      providers.idVerification.recordManualCheck(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-INVALID-OUTCOME',
        outcome: 'clear' as never,
        verificationMethod: 'Invalid outcome check',
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_OUTCOME/);
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-INVALID-OUTCOME',
      }),
    ).toBeNull();

    await expect(
      providers.sanctionsPep.recordManualScreening(ctxAlpha, {
        subjectType: 'organisation',
        subjectId: 'O-C-INVALID-OUTCOME',
        outcome: 'verified' as never,
        screeningScope: 'Invalid outcome check',
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_OUTCOME/);
    expect(
      await providers.sanctionsPep.getLatestScreeningForSubject(ctxAlpha, {
        subjectType: 'organisation',
        subjectId: 'O-C-INVALID-OUTCOME',
      }),
    ).toBeNull();

    await expect(
      providers.eSignature.recordManualRequest(ctxAlpha, {
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-REQ',
        outcome: 'signed_uploaded' as never,
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_OUTCOME/);
    expect(
      await providers.eSignature.getLatestEnvelope(ctxAlpha, {
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-REQ',
      }),
    ).toBeNull();

    await expect(
      providers.eSignature.recordManualSignedDocument(ctxAlpha, {
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-SIGN',
        outcome: 'bogus_status' as never,
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_OUTCOME/);
    expect(
      await providers.eSignature.getLatestEnvelope(ctxAlpha, {
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-SIGN',
      }),
    ).toBeNull();

    await expect(
      repo.recordCheck(ctxAlpha, {
        checkKind: 'payment_request',
        provider: 'manual',
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-REPO',
        outcome: 'magic_paid',
        amountMinorUnits: BigInt(1000),
        currency: 'GBP',
        metadata: {},
        evidenceRefs: [],
      }),
    ).rejects.toThrow(/INTAKE_CHECK_INVALID_OUTCOME/);
    expect(
      await repo.getLatestCheckForSubject(ctxAlpha, {
        checkKind: 'payment_request',
        subjectType: 'matter',
        subjectId: 'M-INVALID-OUTCOME-REPO',
      }),
    ).toBeNull();

    // R667: Forged TenantContext claims, mismatched blob container / database / role, and tampered tokens fail closed with zero rows written
    const forgedEmptyTenantCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: '',
    }) as unknown as TenantContext;
    await expect(
      repo.recordCheck(forgedEmptyTenantCtx, {
        checkKind: 'identity_verification',
        provider: 'manual',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-EMPTY',
        outcome: 'verified',
        metadata: {},
        evidenceRefs: [],
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);

    const forgedBlobContainerCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      blobContainerName: ctxBravo.blobContainerName,
    });
    await expect(
      providers.idVerification.recordManualCheck(forgedBlobContainerCtx, {
        subjectType: 'person',
        subjectId: 'P-C-FORGED-BLOB',
        outcome: 'verified',
        verificationMethod: 'Forged blob container check',
        evidenceRefs: [evidRefBravo],
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-FORGED-BLOB',
      }),
    ).toBeNull();
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxBravo, {
        subjectType: 'person',
        subjectId: 'P-C-FORGED-BLOB',
      }),
    ).toBeNull();

    // R672: tenant-id prefix collision (tenant-alpha -> tenant-tenant-alpha- vs tenant-alpha-two -> tenant-tenant-alpha-two-test) & environment mismatch (test vs live)
    const prefixCollisionCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      blobContainerName: 'tenant-tenant-alpha-two-test',
    });
    await expect(
      storage.putObject(prefixCollisionCtx, {
        category: 'evidence',
        objectId: 'EVID-R672-PREFIX',
        fileName: 'prefix.pdf',
        contentType: 'application/pdf',
        bytes: evidBytes,
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    await expect(
      providers.idVerification.recordManualCheck(prefixCollisionCtx, {
        subjectType: 'person',
        subjectId: 'P-C-R672-PREFIX',
        outcome: 'verified',
        verificationMethod: 'Prefix collision bypass check',
        evidenceRefs: [
          {
            ...evidRefAlpha,
            blobKey: 'tenant-tenant-alpha-two-test/evidence/fake.pdf',
          },
        ],
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-R672-PREFIX',
      }),
    ).toBeNull();

    const envMismatchCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      blobContainerName: 'tenant-tenant-alpha-live',
    });
    await expect(
      storage.putObject(envMismatchCtx, {
        category: 'evidence',
        objectId: 'EVID-R672-ENV',
        fileName: 'env-mismatch.pdf',
        contentType: 'application/pdf',
        bytes: evidBytes,
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    await expect(
      providers.idVerification.recordManualCheck(envMismatchCtx, {
        subjectType: 'person',
        subjectId: 'P-C-R672-ENV',
        outcome: 'verified',
        verificationMethod: 'Env mismatch bypass check',
        evidenceRefs: [
          {
            ...evidRefAlpha,
            blobKey: 'tenant-tenant-alpha-live/evidence/fake.pdf',
          },
        ],
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    expect(
      await providers.idVerification.getLatestCheckForSubject(ctxAlpha, {
        subjectType: 'person',
        subjectId: 'P-C-R672-ENV',
      }),
    ).toBeNull();

    const forgedDbCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      postgresDatabaseName: ctxBravo.postgresDatabaseName,
    });
    await expect(
      repo.recordCheck(forgedDbCtx, {
        checkKind: 'identity_verification',
        provider: 'manual',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-DB',
        outcome: 'verified',
        metadata: {},
        evidenceRefs: [],
      }),
    ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED/);
    expect(
      await repo.getLatestCheckForSubject(ctxAlpha, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-DB',
      }),
    ).toBeNull();
    expect(
      await repo.getLatestCheckForSubject(ctxBravo, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-DB',
      }),
    ).toBeNull();

    const forgedPgRoleTenantMismatchCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      tenantId: ctxBravo.tenantId,
    });
    await expect(
      repo.recordCheck(forgedPgRoleTenantMismatchCtx, {
        checkKind: 'identity_verification',
        provider: 'manual',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ROLE',
        outcome: 'verified',
        metadata: {},
        evidenceRefs: [],
      }),
    ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED/);
    expect(
      await repo.getLatestCheckForSubject(ctxAlpha, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ROLE',
      }),
    ).toBeNull();
    expect(
      await repo.getLatestCheckForSubject(ctxBravo, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ROLE',
      }),
    ).toBeNull();

    // R684: Forged actorRoles claim (and unverified OIDC token with elevated roles) cannot bypass tenant isolation
    const forgedActorRolesCtx: TenantContext = Object.freeze({
      ...ctxAlpha,
      actorRoles: Object.freeze(['admin', 'managing_partner']),
      blobContainerName: ctxBravo.blobContainerName,
    });
    await expect(
      providers.idVerification.recordManualCheck(forgedActorRolesCtx, {
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ACTOR-ROLES',
        outcome: 'verified',
        verificationMethod: 'Forged actorRoles check',
        evidenceRefs: [evidRefBravo],
      }),
    ).rejects.toThrow(/^TENANCY_ISOLATION_ERROR/);
    expect(
      await repo.getLatestCheckForSubject(ctxAlpha, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ACTOR-ROLES',
      }),
    ).toBeNull();
    expect(
      await repo.getLatestCheckForSubject(ctxBravo, {
        checkKind: 'identity_verification',
        subjectType: 'person',
        subjectId: 'P-C-FORGED-ACTOR-ROLES',
      }),
    ).toBeNull();
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          sub: 'P-ALPHA-1',
          tenantId: ctxAlpha.tenantId,
          name: 'Alpha User',
          email: 'alpha@tenant-alpha.example',
          roles: ['admin', 'managing_partner'],
          mfaVerified: true,
        } as unknown as Parameters<typeof resolveTenantFromVerifiedToken>[0]['verifiedToken'],
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-actor-roles',
      }),
    ).toThrow(/TENANCY_AUTH_ERROR/);

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-ALPHA-1',
          tenantId: ctxAlpha.tenantId,
          name: 'Alpha User',
          email: 'alpha@tenant-alpha.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-override',
        untrustedRequestTenantOverride: ctxBravo.tenantId,
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    const alphaEvidenceToken = await storage.issueScopedDownloadToken(ctxAlpha, {
      blobKey: evidRefAlpha.blobKey,
      fileName: 'Celyn-Pritchard-Passport-Private.pdf',
    });
    await expect(
      storage.verifyScopedDownloadToken(ctxBravo, alphaEvidenceToken.token),
    ).rejects.toThrow(/STORAGE_TOKEN_FORGERY/);

    // Unknown runtime provider fails closed
    expect(() =>
      createTenantIntakeCheckProviders({
        tenantConfig: {
          ...cfg,
          integrations: {
            ...cfg.integrations,
            intakeChecks: {
              idVerification: { provider: 'simulated' as unknown as 'manual' },
              sanctionsPep: { provider: 'manual' },
              eSignature: { provider: 'manual' },
              payments: { provider: 'manual' },
            },
          },
        },
        repository: repo,
        storageProvider: storage,
      }),
    ).toThrow(/INTAKE_CHECK_PROVIDER_NOT_SUPPORTED/);
  });

  it('S1-D11: enforces 3 MB enqueue limit, stores PDFs in public.email_outbox_attachments, drains via SMTP/Graph with storageProvider: undefined, scrubs on retention, logs zero PII, and isolates two tenants', async () => {
    expect(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES).toBe(3_000_000);
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const ctxAlpha = makeTenantCtx('tenant-alpha', 'P-ALPHA-1');
    const ctxBravo = makeTenantCtx('tenant-bravo', 'P-BRAVO-1');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha, CORE_TENANT_MIGRATIONS);
    await runner.applyUp(ctxBravo, CORE_TENANT_MIGRATIONS);

    const outboxRepo = new TenantOutboxRepository();
    const auditRepo = new TenantAuditRepository();
    await outboxRepo.clearTenantData(ctxAlpha);
    await outboxRepo.clearTenantData(ctxBravo);

    // 1. Oversize cumulative inline attachments (> 3,000,000 bytes) rejected at enqueue with zero DB rows
    const oversizedPartA = new Uint8Array(1_600_000).fill(0x41);
    const oversizedPartB = new Uint8Array(1_500_000).fill(0x42);
    await expect(
      outboxRepo.enqueueEmail(ctxAlpha, {
        idempotencyKey: 's103-oversize-1',
        templateKey: 'quote_send',
        recipients: { to: ['client@invented.example'] },
        subject: 'Your quote',
        htmlBody: '<p>Attached quote</p>',
        textBody: 'Attached quote',
        attachments: [
          {
            kind: 'inline',
            fileName: 'partA.pdf',
            contentType: 'application/pdf',
            contentBytes: oversizedPartA,
          },
          {
            kind: 'inline',
            fileName: 'partB.pdf',
            contentType: 'application/pdf',
            contentBytes: oversizedPartB,
          },
        ],
      }),
    ).rejects.toThrow(/EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED/);
    expect(await outboxRepo.listOutboxRecords(ctxAlpha)).toHaveLength(0);

    // 2. Valid inline PDF stored in email_outbox_attachments + deduplicated on idempotencyKey
    const pdfPayload = new TextEncoder().encode('%PDF-1.4\n%Private Quote Payload S1D11');
    const pdfSha = crypto.createHash('sha256').update(pdfPayload).digest('hex');
    const secretFileName = 'Confidential-Client-Quote-Q2026.pdf';
    const inlineAttachment: EmailInlineAttachment = {
      kind: 'inline',
      fileName: secretFileName,
      contentType: 'application/pdf',
      contentBytes: pdfPayload,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const enqFirst = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-quote-1',
      templateKey: 'quote_send',
      recipients: { to: ['client@invented.example'] },
      subject: 'Your Fee Quote',
      htmlBody: '<p>Please find your fee quote attached.</p>',
      textBody: 'Please find your fee quote attached.',
      attachments: [inlineAttachment],
    });
    expect(enqFirst.deduplicated).toBe(false);
    expect(enqFirst.record.attachments).toEqual([
      {
        source: 'outbox',
        ordinal: 0,
        fileName: secretFileName,
        contentType: 'application/pdf',
        byteSize: pdfPayload.length,
        sha256: pdfSha,
      },
    ]);

    const enqDup = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-quote-1',
      templateKey: 'quote_send',
      recipients: { to: ['client@invented.example'] },
      subject: 'Your Fee Quote',
      htmlBody: '<p>Please find your fee quote attached.</p>',
      textBody: 'Please find your fee quote attached.',
      attachments: [inlineAttachment],
    });
    expect(enqDup.deduplicated).toBe(true);
    expect(enqDup.record.id).toBe(enqFirst.record.id);

    // 3. Cross-tenant & wrong-claim-token guards on getClaimedOutboxAttachmentBytes
    const claimedForBravoCheck = await outboxRepo.claimDueOutboxBatch(ctxAlpha, {
      claimToken: 'claim-token-alpha-check',
      limit: 5,
    });
    expect(claimedForBravoCheck).toHaveLength(1);
    const crossTenantBytes = await outboxRepo.getClaimedOutboxAttachmentBytes(
      ctxBravo,
      { outboxId: enqFirst.record.id, claimToken: 'claim-token-alpha-check' },
    );
    expect(crossTenantBytes).toEqual([]);
    const wrongClaimBytes = await outboxRepo.getClaimedOutboxAttachmentBytes(
      ctxAlpha,
      { outboxId: enqFirst.record.id, claimToken: 'wrong-claim-token' },
    );
    expect(wrongClaimBytes).toEqual([]);

    // R667: Forged TenantContext claims on getClaimedOutboxAttachmentBytes & enqueueEmail fail closed with zero rows written
    const outboxForgedEmpty = Object.freeze({
      ...ctxAlpha,
      tenantId: '',
    }) as unknown as TenantContext;
    await expect(
      outboxRepo.getClaimedOutboxAttachmentBytes(outboxForgedEmpty, {
        outboxId: enqFirst.record.id,
        claimToken: 'claim-token-alpha-check',
      }),
    ).rejects.toThrow(/TENANCY_ISOLATION_ERROR/);

    const outboxForgedDb: TenantContext = Object.freeze({
      ...ctxAlpha,
      postgresDatabaseName: ctxBravo.postgresDatabaseName,
    });
    await expect(
      outboxRepo.getClaimedOutboxAttachmentBytes(outboxForgedDb, {
        outboxId: enqFirst.record.id,
        claimToken: 'claim-token-alpha-check',
      }),
    ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED/);
    await expect(
      outboxRepo.enqueueEmail(outboxForgedDb, {
        idempotencyKey: 's103-forged-db-1',
        templateKey: 'quote_send',
        recipients: { to: ['client@invented.example'] },
        subject: 'Forged DB',
        htmlBody: '<p>Forged</p>',
        textBody: 'Forged',
        attachments: [inlineAttachment],
      }),
    ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED/);
    expect(await outboxRepo.listOutboxRecords(ctxBravo)).toHaveLength(0);

    const outboxForgedRole: TenantContext = Object.freeze({
      ...ctxAlpha,
      tenantId: ctxBravo.tenantId,
    });
    await expect(
      outboxRepo.getClaimedOutboxAttachmentBytes(outboxForgedRole, {
        outboxId: enqFirst.record.id,
        claimToken: 'claim-token-alpha-check',
      }),
    ).rejects.toThrow(/TENANCY_DATABASE_PERMISSION_DENIED/);

    // Release back to pending so drain test exercises full claim -> send flow
    await outboxRepo.markOutboxAttemptFailed(ctxAlpha, {
      id: enqFirst.record.id,
      claimToken: 'claim-token-alpha-check',
      error: new Error('TEMPORARY_SMTP_FAILURE'),
      maxAttempts: 5,
      baseBackoffSeconds: 0,
      failedAt: new Date(Date.now() - 10_000),
    });

    // 4. Drain over SMTP dev_catcher with storageProvider === undefined (retry delivery works!)
    const catcher = await startLocalSmtpCatcher();
    try {
      const cfgSmtp = loadAndValidateTenantConfig(
        {
          ...notALawFirmBaseConfig,
          integrations: {
            ...(notALawFirmBaseConfig.integrations ?? {}),
            email: {
              provider: 'dev_catcher',
              senderAddress: 'enquiries@notalawfirm.example',
              recipientAllowList: ['@invented.example'],
              devCatcher: { host: catcher.host, port: catcher.port },
            },
          },
        },
        { environment: 'test' },
        'test',
        'multi_tenant',
      );
      const dispatcherSmtp = new CoreEmailDispatcher({
        emailConfig: cfgSmtp.integrations!.email!,
        // Notice storageProvider is intentionally omitted (undefined)!
      });
      const drainSmtp = await drainEmailOutboxForTenant(ctxAlpha, {
        tenantConfig: cfgSmtp,
        emailSender: dispatcherSmtp,
        outboxRepository: outboxRepo,
        actorId: 'system:outbox-drain',
        now: new Date(),
      });
      expect(drainSmtp.sentCount).toBe(1);
      expect(catcher.messages).toHaveLength(1);
      expect(catcher.messages[0]!.rawData).toContain(secretFileName);
      expect(catcher.messages[0]!.rawData).toContain(
        Buffer.from(pdfPayload).toString('base64'),
      );
    } finally {
      await catcher.close();
    }

    // 5. Drain via Graph sendMail with storageProvider === undefined (using drainOutboxForTenant)
    const graphPayloads: Array<Record<string, unknown>> = [];

    await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-eng-graph-1',
      templateKey: 'engagement_send',
      recipients: { to: ['client2@invented.example'] },
      subject: 'Engagement Letter',
      htmlBody: '<p>Engagement attached</p>',
      textBody: 'Engagement attached',
      attachments: [inlineAttachment],
    });
    const cfgGraph = loadAndValidateTenantConfig(
      {
        ...notALawFirmBaseConfig,
        integrations: {
          ...(notALawFirmBaseConfig.integrations ?? {}),
          email: {
            provider: 'graph',
            senderAddress: 'shared@notalawfirm.example',
            recipientAllowList: ['@invented.example'],
            graph: {
              tenantId: '11111111-2222-3333-4444-555555555555',
              clientId: '22222222-3333-4444-5555-666666666666',
              certificateVaultRef: 'kv://kv-test/email-cert',
              certificateThumbprint: '0123456789ABCDEF0123456789ABCDEF01234567',
            },
          },
        },
      },
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    const graphDispatcher = new CoreEmailDispatcher({
      emailConfig: cfgGraph.integrations!.email!,
      secretReader: {
        readSecret: async () => 'mock-secret-unused-when-token-provider-injected',
      },
      graphTokenProvider: new (class extends GraphAppTokenProvider {
        public override async acquireAppToken(): Promise<string> {
          return 'mock-graph-token';
        }
      })(),
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/sendMail')) {
          graphPayloads.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({ access_token: 'mock-graph-tok', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const drainGraph = await drainOutboxForTenant(ctxAlpha, {
      tenantConfig: cfgGraph,
      emailSender: graphDispatcher,
      outboxRepository: outboxRepo,
      actorId: 'system:outbox-drain',
      now: new Date(),
    });
    expect(drainGraph.sentCount).toBe(1);
    expect(graphPayloads).toHaveLength(1);
    const msgAtts = (
      graphPayloads[0]!.message as {
        attachments?: Array<{ name?: string; contentBytes?: string; contentType?: string }>;
      }
    ).attachments!;
    expect(msgAtts).toHaveLength(1);
    expect(msgAtts[0]!.name).toBe(secretFileName);
    expect(msgAtts[0]!.contentType).toBe('application/pdf');
    expect(msgAtts[0]!.contentBytes).toBe(Buffer.from(pdfPayload).toString('base64'));

    // 6. Retention scrub deletes rows from public.email_outbox_attachments & clears metadata
    const scrubRes = await outboxRepo.scrubExpiredOutboxContent(ctxAlpha, {
      retentionDays: 30,
      now: new Date(Date.now() + 31 * 86_400_000),
    });
    expect(scrubRes.lockAcquired).toBe(true);
    expect(scrubRes.scrubbedCount).toBe(2);

    const remainingAttachmentsCount = await outboxRepo.withTenantReadTransaction(
      ctxAlpha,
      async (tx) => {
        const r = await tx.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM public.email_outbox_attachments WHERE tenant_id = $1',
          [ctxAlpha.tenantId],
        );
        return Number(r.rows[0]?.cnt ?? 0);
      },
    );
    expect(remainingAttachmentsCount).toBe(0);

    // 7. Zero filenames, raw bytes, or base64 strings appear in logs or audit_entries
    const capturedLogs = [
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
    ]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    const b64Payload = Buffer.from(pdfPayload).toString('base64');
    expect(capturedLogs).not.toContain(secretFileName);
    expect(capturedLogs).not.toContain(b64Payload);
    expect(capturedLogs).not.toContain('Private Quote Payload S1D11');

    const firstOutboxAudit = await auditRepo.listAuditEntriesForRecord(
      ctxAlpha,
      'email_outbox',
      enqFirst.record.id,
    );
    expect(JSON.stringify(firstOutboxAudit)).not.toContain(secretFileName);
    expect(JSON.stringify(firstOutboxAudit)).not.toContain(b64Payload);

    // 8. R666: Mixed attachments ([blobRef0, inlinePdf1, blobRef2]) preserve all attachments in ordinal order
    //    when drained with storageProvider, and fail closed (retried, never silently dropped) when storageProvider is undefined.
    const storageForMixed = new LocalTenantStorageProvider({
      inMemoryOnly: true,
      environment: 'test',
      tokenSigningKey: 's103-mixed-att-signing-key-32chars',
    });
    const blobBytes0 = new TextEncoder().encode('%PDF-1.4\n%Stored Blob Attachment Zero');
    const blobBytes2 = new TextEncoder().encode('%PDF-1.4\n%Stored Blob Attachment Two');
    const stored0 = await storageForMixed.putObject(ctxAlpha, {
      category: 'documents',
      objectId: 'DOC-MIXED-0',
      fileName: 'Terms-Part-Zero.pdf',
      contentType: 'application/pdf',
      bytes: blobBytes0,
    });
    const stored2 = await storageForMixed.putObject(ctxAlpha, {
      category: 'documents',
      objectId: 'DOC-MIXED-2',
      fileName: 'Schedule-Part-Two.pdf',
      contentType: 'application/pdf',
      bytes: blobBytes2,
    });
    const blobRef0: EmailAttachmentRef = {
      blobKey: stored0.blobKey,
      fileName: 'Terms-Part-Zero.pdf',
      contentType: 'application/pdf',
    };
    const inlinePdf1: EmailInlineAttachment = {
      kind: 'inline',
      fileName: 'Quote-Middle-One.pdf',
      contentType: 'application/pdf',
      contentBytes: new TextEncoder().encode('%PDF-1.4\n%Inline Quote Attachment One'),
    };
    const blobRef2: EmailAttachmentRef = {
      blobKey: stored2.blobKey,
      fileName: 'Schedule-Part-Two.pdf',
      contentType: 'application/pdf',
    };

    const enqMixed = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-r666-mixed-1',
      templateKey: 'quote_send',
      recipients: { to: ['client-mixed@invented.example'] },
      subject: 'Mixed Attachments Order Check',
      htmlBody: '<p>Three attachments in order.</p>',
      textBody: 'Three attachments in order.',
      attachments: [blobRef0, inlinePdf1, blobRef2],
    });
    expect(enqMixed.record.attachments[1]).toMatchObject({
      source: 'outbox',
      ordinal: 1,
      fileName: 'Quote-Middle-One.pdf',
    });

    // Without storageProvider, drain must fail closed & retry rather than silently dropping blobRef0/blobRef2
    const catcherNoStorage = await startLocalSmtpCatcher();
    try {
      const cfgMixed = loadAndValidateTenantConfig(
        {
          ...notALawFirmBaseConfig,
          integrations: {
            ...(notALawFirmBaseConfig.integrations ?? {}),
            email: {
              provider: 'dev_catcher',
              senderAddress: 'enquiries@notalawfirm.example',
              recipientAllowList: ['@invented.example'],
              devCatcher: { host: catcherNoStorage.host, port: catcherNoStorage.port },
            },
          },
        },
        { environment: 'test' },
        'test',
        'multi_tenant',
      );
      const drainNoStorage = await drainEmailOutboxForTenant(ctxAlpha, {
        tenantConfig: cfgMixed,
        outboxRepository: outboxRepo,
        baseBackoffSeconds: 0,
        now: new Date(),
      });
      expect(drainNoStorage.sentCount).toBe(0);
      expect(drainNoStorage.retriedCount).toBe(1);
      expect(catcherNoStorage.messages).toHaveLength(0);
    } finally {
      await catcherNoStorage.close();
    }

    // With storageProvider, Graph sendMail receives all 3 attachments in exact [blobRef0, inlinePdf1, blobRef2] order
    const mixedGraphPayloads: Array<Record<string, unknown>> = [];
    const mixedGraphDispatcher = new CoreEmailDispatcher({
      emailConfig: cfgGraph.integrations!.email!,
      storageProvider: storageForMixed,
      secretReader: { readSecret: async () => 'mock-secret' },
      graphTokenProvider: new (class extends GraphAppTokenProvider {
        public override async acquireAppToken(): Promise<string> {
          return 'mock-graph-token';
        }
      })(),
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/sendMail')) {
          mixedGraphPayloads.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(null, { status: 202 });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const drainMixedOk = await drainOutboxForTenant(ctxAlpha, {
      tenantConfig: cfgGraph,
      emailSender: mixedGraphDispatcher,
      outboxRepository: outboxRepo,
      actorId: 'system:outbox-drain',
      now: new Date(Date.now() + 5_000),
    });
    expect(drainMixedOk.sentCount).toBe(1);
    const mixedSentAtts = (
      mixedGraphPayloads[0]!.message as {
        attachments?: Array<{ name?: string; contentBytes?: string }>;
      }
    ).attachments!;
    expect(mixedSentAtts.map((a) => a.name)).toEqual([
      'Terms-Part-Zero.pdf',
      'Quote-Middle-One.pdf',
      'Schedule-Part-Two.pdf',
    ]);

    // 9. R674: Outbox attachment ordinal mismatch or metadata sha256 mismatch fails closed (never falls back cursor or sends wrong file)
    mixedGraphPayloads.length = 0;
    const enqOrdinalMismatch = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-r674-ordinal-mismatch',
      templateKey: 'quote_send',
      recipients: { to: ['client-mixed@invented.example'] },
      subject: 'Ordinal Mismatch Should Fail Closed',
      htmlBody: '<p>Ordinal mismatch.</p>',
      textBody: 'Ordinal mismatch.',
      attachments: [inlinePdf1],
    });
    await outboxRepo.withTenantTransaction(ctxAlpha, async (tx) => {
      await tx.query(
        `UPDATE public.email_outbox
            SET attachments_json = jsonb_set(attachments_json, '{0,ordinal}', '99'::jsonb)
          WHERE tenant_id = $1 AND id = $2`,
        [ctxAlpha.tenantId, enqOrdinalMismatch.record.id],
      );
    });
    const drainOrdinalMismatch = await drainOutboxForTenant(ctxAlpha, {
      tenantConfig: cfgGraph,
      emailSender: mixedGraphDispatcher,
      outboxRepository: outboxRepo,
      actorId: 'system:outbox-drain',
      baseBackoffSeconds: 60,
      now: new Date(Date.now() + 10_000),
    });
    expect(drainOrdinalMismatch.sentCount).toBe(0);
    expect(drainOrdinalMismatch.retriedCount).toBe(1);
    expect(mixedGraphPayloads).toHaveLength(0);

    const enqShaMismatch = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 's103-r674-sha-mismatch',
      templateKey: 'quote_send',
      recipients: { to: ['client-mixed@invented.example'] },
      subject: 'SHA256 Mismatch Should Fail Closed',
      htmlBody: '<p>SHA mismatch.</p>',
      textBody: 'SHA mismatch.',
      attachments: [inlinePdf1],
    });
    await outboxRepo.withTenantTransaction(ctxAlpha, async (tx) => {
      await tx.query(
        `UPDATE public.email_outbox
            SET attachments_json = jsonb_set(attachments_json, '{0,sha256}', to_jsonb($3::text))
          WHERE tenant_id = $1 AND id = $2`,
        [ctxAlpha.tenantId, enqShaMismatch.record.id, '0'.repeat(64)],
      );
    });
    const drainShaMismatch = await drainOutboxForTenant(ctxAlpha, {
      tenantConfig: cfgGraph,
      emailSender: mixedGraphDispatcher,
      outboxRepository: outboxRepo,
      actorId: 'system:outbox-drain',
      baseBackoffSeconds: 60,
      now: new Date(Date.now() + 20_000),
    });
    expect(drainShaMismatch.sentCount).toBe(0);
    expect(drainShaMismatch.retriedCount).toBe(1);
    expect(mixedGraphPayloads).toHaveLength(0);
  });
});
