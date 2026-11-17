import {
  createSign,
  generateKeyPairSync,
  verify as verifySignature,
  X509Certificate,
} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import {
  ALL_JOB_ONLY_PERMISSION_KEYS,
  ALL_PERMISSION_KEYS,
  ALL_USER_PERMISSION_KEYS,
  assertBlobKeyBelongsToTenant,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  CoreEmailDispatcher,
  DefaultAzureKeyVaultSecretReader,
  drainEmailOutboxForTenant,
  EmailIntegrationError,
  EMAIL_OUTBOX_AND_PREFERENCES_MIGRATION_0019,
  evaluateEmailAllowList,
  getPlatformTelemetryRecorder,
  GraphAppTokenProvider,
  loadAndValidateTenantConfig,
  LocalTenantStorageProvider,
  PERMISSION_REGISTRY,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  type KeyVaultSecretReader,
  type TenantConfiguration,
  type TenantContext,
} from '../src/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../src/tenancy/keyVaultSecrets';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { executeCliJobRunner, REGISTERED_CLI_JOBS } from '../../scripts/run-job';
import {
  getActiveTenantRawBaseConfig,
  getOutboxRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import { JOB_PERMISSIONS } from '@/server/actionPermissions';
import {
  enqueueNotificationEmailIfImmediate,
  runScheduledOutboxDrainJobSweep,
  saveTaskRecord,
} from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { setTestEntraSessionOverride } from '@/server/entraAuth';
import { setTestActorSession } from '@/server/testSupport/auditTestSupport';
import type { TenantRegistry } from '../src/index';

// ---------------------------------------------------------------------------
// Ephemeral ASN.1 DER X.509 self-signed certificate builder (zero static keys)
// ---------------------------------------------------------------------------

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(parts));
}

function derSet(...parts: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(parts));
}

function derInteger(bytes: Buffer): Buffer {
  const positive = bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return derTag(0x02, positive);
}

function derBitString(bytes: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

function derOid(encodedHex: string): Buffer {
  return derTag(0x06, Buffer.from(encodedHex, 'hex'));
}

function derUtf8(value: string): Buffer {
  return derTag(0x0c, Buffer.from(value, 'utf8'));
}

function derUtcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function generateEphemeralSelfSignedCertAndKey(commonName = 'notalawfirm.example'): {
  readonly certPem: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly thumbprintHex: string;
  readonly pkcs12Base64: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const pkcs8KeyDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  // sha256WithRSAEncryption: 1.2.840.113549.1.1.11
  const sha256WithRsaAlgId = derSequence(
    derOid('2a864886f70d01010b'),
    Buffer.from([0x05, 0x00]),
  );
  // commonName: 2.5.4.3
  const name = derSequence(
    derSet(derSequence(derOid('550403'), derUtf8(commonName))),
  );
  const now = Date.now();
  const validity = derSequence(
    derUtcTime(new Date(now - 60_000)),
    derUtcTime(new Date(now + 3600_000)),
  );
  const tbsCertificate = derSequence(
    derTag(0xa0, derInteger(Buffer.from([0x02]))), // v3
    derInteger(Buffer.from([0x01, 0x02, 0x03, 0x04])),
    sha256WithRsaAlgId,
    name,
    validity,
    name,
    spkiDer,
  );

  const signer = createSign('RSA-SHA256');
  signer.update(tbsCertificate);
  signer.end();
  const sig = signer.sign(privateKey);

  const certDer = derSequence(
    tbsCertificate,
    sha256WithRsaAlgId,
    derBitString(sig),
  );
  const certBase64 = certDer.toString('base64').replace(/.{1,64}/g, '$&\n').trim();
  const certPem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----\n`;

  // Unencrypted passwordless PKCS#12 PFX matching Azure Key Vault default application/x-pkcs12 secret format
  const keyBag = derSequence(
    derOid('2a864886f70d010c0a0101'),
    derTag(0xa0, pkcs8KeyDer),
  );
  const certBag = derSequence(
    derOid('2a864886f70d010c0a0103'),
    derTag(
      0xa0,
      derSequence(
        derOid('2a864886f70d01091601'),
        derTag(0xa0, derTag(0x04, certDer)),
      ),
    ),
  );
  const safeContents = derSequence(keyBag, certBag);
  const safeContentInfo = derSequence(
    derOid('2a864886f70d010701'),
    derTag(0xa0, derTag(0x04, safeContents)),
  );
  const authSafe = derSequence(safeContentInfo);
  const pfxDer = derSequence(
    derInteger(Buffer.from([0x03])),
    derSequence(
      derOid('2a864886f70d010701'),
      derTag(0xa0, derTag(0x04, authSafe)),
    ),
  );

  const parsed = new X509Certificate(certPem);
  const thumbprintHex = parsed.fingerprint.replace(/:/g, '').toUpperCase();

  return {
    certPem,
    privateKeyPem,
    publicKeyPem,
    thumbprintHex,
    pkcs12Base64: pfxDer.toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// Ephemeral TCP SMTP Catcher server (local Mailpit-compatible protocol test)
// ---------------------------------------------------------------------------

interface CapturedSmtpMessage {
  readonly mailFrom: string;
  readonly rcptTo: string[];
  readonly rawData: string;
}

async function startEphemeralSmtpCatcher(): Promise<{
  readonly port: number;
  readonly host: string;
  readonly messages: CapturedSmtpMessage[];
  close: () => Promise<void>;
}> {
  const messages: CapturedSmtpMessage[] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let inData = false;
    let dataBuf = '';
    let mailFrom = '';
    let rcptTo: string[] = [];

    socket.write('220 localhost ESMTP DevCatcher Ready\r\n');

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const rawLine = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);

        if (inData) {
          if (rawLine === '.') {
            inData = false;
            messages.push({
              mailFrom,
              rcptTo: [...rcptTo],
              rawData: dataBuf,
            });
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

function makeTenantContext(
  tenantId: string,
  env: 'dev' | 'test' | 'demo' | 'live' = 'test',
  actorId = 'P-000001',
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: 'Test User',
      email: 'test.user@notalawfirm.example',
      roles: ['admin'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: env,
    correlationId: `corr-s026-${tenantId}-${Date.now()}`,
  });
}

async function setupMigratedTenant(
  tenantId: string,
  env: 'test' | 'dev' | 'demo' = 'test',
): Promise<TenantContext> {
  await provisionPostgresClusterRolesAndDatabases({
    tenants: [{ tenantId, environment: env }],
  });
  const ctx = makeTenantContext(tenantId, env);
  const runner = new TenantMigrationRunner();
  await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);
  return ctx;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const activeTempDirs: string[] = [];
const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  setActiveTenantConfigForTesting(null);
  setTestEntraSessionOverride(undefined);
  getPlatformTelemetryRecorder().clearForTesting();
  for (const close of activeClosers.splice(0)) {
    await close();
  }
  for (const dir of activeTempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('S0-26: Email & Notifications (ADR 0027 Outbox, Graph Cert Auth, Allow-List & outbox-drain)', () => {
  it('1. Migration 0019, RBAC 66+8=74 totals, JOB_PERMISSIONS/REGISTERED_CLI_JOBS, and demo/dev/test config overlays', async () => {
    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0019');
    expect(EMAIL_OUTBOX_AND_PREFERENCES_MIGRATION_0019.version).toBe('0019');
    expect(EMAIL_OUTBOX_AND_PREFERENCES_MIGRATION_0019.dependsOn).toEqual([
      '0018',
    ]);

    expect(ALL_PERMISSION_KEYS).toHaveLength(74);
    expect(ALL_USER_PERMISSION_KEYS).toHaveLength(66);
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toHaveLength(8);
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toContain('notification:drain_outbox');
    expect(PERMISSION_REGISTRY['notification:drain_outbox'].jobOnly).toBe(true);
    expect(PERMISSION_REGISTRY['notification:drain_outbox'].sensitivity).toBe(
      'critical',
    );
    expect(JOB_PERMISSIONS['outbox-drain'].permission).toBe(
      'notification:drain_outbox',
    );
    expect(JOB_PERMISSIONS['outbox-drain'].jobOnly).toBe(true);

    const cliOutboxJob = REGISTERED_CLI_JOBS.find(
      (job) => job.name === 'outbox-drain',
    );
    expect(cliOutboxJob).toMatchObject({
      name: 'outbox-drain',
      mode: 'scheduled',
      schedule: '*/5 * * * *',
    });

    const cliListStdout: string[] = [];
    const listExitCode = await executeCliJobRunner(
      ['node', 'run-job.mjs', '--list'],
      { stdout: (line) => cliListStdout.push(line) },
    );
    expect(listExitCode).toBe(0);
    expect(cliListStdout.join('')).toContain('outbox-drain');

    const rootDir = path.resolve(__dirname, '..', '..');
    const baseCfg = readJson(
      path.join(rootDir, 'client-not-a-law-firm', 'config', 'base.json'),
    );
    const demoOverlay = readJson(
      path.join(
        rootDir,
        'client-not-a-law-firm',
        'config',
        'environments',
        'demo.json',
      ),
    );
    const devOverlay = readJson(
      path.join(
        rootDir,
        'client-not-a-law-firm',
        'config',
        'environments',
        'dev.json',
      ),
    );

    const demoCfg = loadAndValidateTenantConfig(baseCfg, demoOverlay, 'demo');
    expect(demoCfg.keyVault).toEqual({
      vaultName: 'kvnotalawfi2cdo3cw7vuafm',
      vaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
    });
    expect(demoCfg.integrations.email?.provider).toBe('disabled');
    expect(demoCfg.integrations.email?.senderAddress).toBe(
      'noreply@notalawfirm.example',
    );
    expect(demoCfg.integrations.email?.outboxContentRetentionDays).toBe(30);
    expect(demoCfg.integrations.email?.recipientAllowList).toEqual([
      '@1squared.co.uk',
      '@notalawfirm.example',
    ]);
    expect(demoCfg.integrations.email?.recipientAllowListVaultRef).toBe(
      'kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist',
    );
    expect(demoCfg.integrations.email?.graph).toEqual({
      tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
      clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
      certificateVaultRef: 'kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate',
      certificateThumbprint: 'C5428D7F519AE513A5B8CE027D291876CEDA40D3',
    });

    const devCfg = loadAndValidateTenantConfig(baseCfg, devOverlay, 'dev');
    expect(devCfg.integrations.email?.provider).toBe('disabled');
    expect(devCfg.integrations.email?.devCatcher).toEqual({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
    });

    // dev_catcher rejected in live environment
    expect(() =>
      loadAndValidateTenantConfig(
        baseCfg,
        {
          integrations: {
            pmsConnectionSecretVaultRef:
              'kv://kv-notalawfirm-live/pms-connection-string',
            companiesHouseApiKeyVaultRef:
              'kv://kv-notalawfirm-live/companies-house-api-key',
            aiProviderChoice: 'disabled',
            email: {
              provider: 'dev_catcher',
              senderAddress: 'noreply@notalawfirm.example',
            },
          },
        },
        'live',
      ),
    ).toThrow(/dev_catcher.*forbidden in live/);

    // Cross-tenant Key Vault ref in email config fails ownership validation
    expect(() =>
      loadAndValidateTenantConfig(
        baseCfg,
        {
          keyVault: {
            vaultName: 'kv-notalawfirm-test',
          },
          integrations: {
            pmsConnectionSecretVaultRef:
              'kv://kv-notalawfirm-test/pms-connection-string',
            companiesHouseApiKeyVaultRef:
              'kv://kv-notalawfirm-test/companies-house-api-key',
            aiProviderChoice: 'disabled',
            email: {
              provider: 'graph',
              senderAddress: 'noreply@notalawfirm.example',
              recipientAllowList: ['@notalawfirm.example'],
              graph: {
                tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
                clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
                certificateVaultRef: 'kv://kv-other-tenant-test/graph-cert',
                certificateThumbprint:
                  'C5428D7F519AE513A5B8CE027D291876CEDA40D3',
              },
            },
          },
        },
        'test',
      ),
    ).toThrow(/TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED/);
  });

  it('2. GraphAppTokenProvider: Key Vault ownership, SHA-1 thumbprint check, RS256 JWT assertion, encrypted AES-256-GCM 300s-skew cache & tenant isolation', async () => {
    const cert = generateEphemeralSelfSignedCertAndKey();
    const ctxAlpha = makeTenantContext('alpha-firm', 'test');
    const ctxBravo = makeTenantContext('bravo-firm', 'test');

    let secretReads = 0;
    let tokenFetches = 0;
    let currentClockMs = 1_763_000_000_000;
    let lastClientAssertionJwt = '';

    const secretReader: KeyVaultSecretReader = {
      async readSecret(ctx, ref) {
        secretReads += 1;
        if (ref.includes('alpha-firm')) {
          return `${cert.certPem}\n${cert.privateKeyPem}`;
        }
        return `${cert.certPem}\n${cert.privateKeyPem}`;
      },
    };

    const fetchFn = async (url: string | URL, init?: RequestInit) => {
      tokenFetches += 1;
      const params = new URLSearchParams(String(init?.body ?? ''));
      lastClientAssertionJwt = params.get('client_assertion') ?? '';
      return new Response(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: `graph-secret-access-token-${tokenFetches}-${String(url).includes('alpha') ? 'a' : 't'}`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const tokenProvider = new GraphAppTokenProvider({
      secretReader,
      fetchFn,
      now: () => currentClockMs,
    });

    const alphaGraphCfg = {
      tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
      clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
      certificateVaultRef: 'kv://kv-alphafirm-test/graph-mail-certificate',
      certificateThumbprint: cert.thumbprintHex,
    };

    // Cross-tenant KV ref rejected before reading secret or calling Entra
    await expect(
      tokenProvider.acquireAppToken(ctxAlpha, {
        ...alphaGraphCfg,
        certificateVaultRef: 'kv://kv-bravofirm-test/graph-mail-certificate',
      }),
    ).rejects.toThrow(/TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED/);
    expect(secretReads).toBe(0);
    expect(tokenFetches).toBe(0);

    // Thumbprint mismatch fails closed before contacting Entra
    await expect(
      tokenProvider.acquireAppToken(ctxAlpha, {
        ...alphaGraphCfg,
        certificateThumbprint: '0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/GRAPH_CERT_THUMBPRINT_MISMATCH/);
    expect(secretReads).toBe(1);
    expect(tokenFetches).toBe(0);

    // Valid RS256 token acquisition + signature verification
    const tok1 = await tokenProvider.acquireAppToken(ctxAlpha, alphaGraphCfg);
    expect(tok1).toContain('graph-secret-access-token-1');
    expect(secretReads).toBe(2);
    expect(tokenFetches).toBe(1);

    const [hdrB64, payB64, sigB64] = lastClientAssertionJwt.split('.');
    expect(hdrB64 && payB64 && sigB64).toBeTruthy();
    const hdrJson = JSON.parse(
      Buffer.from(hdrB64!, 'base64url').toString('utf8'),
    ) as Record<string, string>;
    const payJson = JSON.parse(
      Buffer.from(payB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(hdrJson.alg).toBe('RS256');
    expect(hdrJson.x5t).toBe(
      Buffer.from(cert.thumbprintHex, 'hex').toString('base64url'),
    );
    expect(payJson.iss).toBe(alphaGraphCfg.clientId);
    expect(payJson.sub).toBe(alphaGraphCfg.clientId);
    expect(payJson.aud).toBe(
      `https://login.microsoftonline.com/${alphaGraphCfg.tenantId}/oauth2/v2.0/token`,
    );
    const sigValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${hdrB64}.${payB64}`, 'utf8'),
      cert.publicKeyPem,
      Buffer.from(sigB64!, 'base64url'),
    );
    expect(sigValid).toBe(true);

    // Cache stores encrypted ciphertext only (never plaintext access token or key)
    const meta = tokenProvider.inspectCacheMetadata(ctxAlpha, alphaGraphCfg);
    expect(meta.exists).toBe(true);
    expect(meta.ciphertextHex).toBeTruthy();
    expect(
      Buffer.from(meta.ciphertextHex!, 'hex').toString('utf8'),
    ).not.toContain('graph-secret-access-token');

    // Cache HIT when 400s (> 300s skew) remain before expiry
    currentClockMs += 3_200_000;
    const tokCached = await tokenProvider.acquireAppToken(
      ctxAlpha,
      alphaGraphCfg,
    );
    expect(tokCached).toBe(tok1);
    expect(tokenFetches).toBe(1);
    expect(secretReads).toBe(2);

    // Different tenant must NOT reuse alpha's cached token
    const bravoGraphCfg = {
      ...alphaGraphCfg,
      certificateVaultRef: 'kv://kv-bravofirm-test/graph-mail-certificate',
    };
    const tokBravo = await tokenProvider.acquireAppToken(
      ctxBravo,
      bravoGraphCfg,
    );
    expect(tokBravo).not.toBe(tok1);
    expect(tokenFetches).toBe(2);

    // Cache MISS & refresh once inside 300,000 ms (5-minute) early expiry skew
    currentClockMs += 101_000; // 3301s elapsed -> 299s left < 300s skew
    const tokRefreshed = await tokenProvider.acquireAppToken(
      ctxAlpha,
      alphaGraphCfg,
    );
    expect(tokRefreshed).not.toBe(tok1);
    expect(tokenFetches).toBe(3);
  });

  it('3. All-adapter non-live allow-list, real TCP dev_catcher MIME delivery, Graph sendMail payload, ACS fail-closed & attachment blob isolation', async () => {
    const tmpStorageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 's026-blob-test-'),
    );
    activeTempDirs.push(tmpStorageDir);
    const storageProvider = new LocalTenantStorageProvider(tmpStorageDir);

    const catcher = await startEphemeralSmtpCatcher();
    activeClosers.push(catcher.close);

    const ctx = makeTenantContext('alpha-firm', 'test');
    const otherCtx = makeTenantContext('bravo-firm', 'test');

    const storedAtt = await storageProvider.putObject(ctx, {
      category: 'documents',
      objectId: 'DOC-S026-1',
      fileName: 'brief.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('Confidential test attachment body.'),
    });
    const otherTenantAtt = await storageProvider.putObject(otherCtx, {
      category: 'documents',
      objectId: 'DOC-OTHER-1',
      fileName: 'secret.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('Other firm bytes!'),
    });

    // DocumentStorageProvider.getObjectBytes & assertBlobKeyBelongsToTenant reject cross-tenant blob keys
    expect(() =>
      assertBlobKeyBelongsToTenant(ctx, otherTenantAtt.blobKey),
    ).toThrow(/STORAGE_TENANCY_ISOLATION_ERROR/);
    await expect(
      storageProvider.getObjectBytes(ctx, { blobKey: otherTenantAtt.blobKey }),
    ).rejects.toThrow(/STORAGE_TENANCY_ISOLATION_ERROR/);

    const sameBytes = await storageProvider.getObjectBytes(ctx, {
      blobKey: storedAtt.blobKey,
    });
    expect(new TextDecoder().decode(sameBytes)).toBe(
      'Confidential test attachment body.',
    );

    const cert = generateEphemeralSelfSignedCertAndKey();
    let kvAllowListReads = 0;
    const secretReader: KeyVaultSecretReader = {
      async readSecret(_c, ref) {
        if (ref.endsWith('graph-mail-certificate')) {
          return `${cert.certPem}\n${cert.privateKeyPem}`;
        }
        if (ref.endsWith('email-recipient-allowlist')) {
          kvAllowListReads += 1;
          return JSON.stringify(['vip.tester@external-pilot.test']);
        }
        throw new Error('MISSING_SECRET');
      },
    };

    const graphRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('login.microsoftonline.com')) {
        return new Response(
          JSON.stringify({ expires_in: 3600, access_token: 'mock-graph-tok' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      graphRequests.push({
        url: target,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('', {
        status: 202,
        headers: { 'request-id': 'graph-msg-202' },
      });
    };

    // A. dev_catcher delivers MIME email with attachments + Reply-To for allow-listed recipients over real TCP
    const smtpDispatcher = new CoreEmailDispatcher({
      emailConfig: {
        provider: 'dev_catcher',
        senderAddress: 'noreply@notalawfirm.example',
        replyTo: 'support@notalawfirm.example',
        recipientAllowList: ['@notalawfirm.example'],
        recipientAllowListVaultRef:
          'kv://kv-alphafirm-test/email-recipient-allowlist',
        devCatcher: { host: catcher.host, port: catcher.port, secure: false },
      },
      secretReader,
      storageProvider,
      fetchFn,
    });

    const smtpRes = await smtpDispatcher.send(ctx, {
      templateKey: 'notification.task_assigned',
      recipients: {
        to: ['alice@notalawfirm.example'],
        cc: ['vip.tester@external-pilot.test'],
      },
      subject: 'Task Assigned: Check Title',
      htmlBody: '<p>Task assigned.</p>',
      textBody: 'Task assigned.',
      attachments: [
        {
          blobKey: storedAtt.blobKey,
          fileName: 'brief.txt',
          contentType: 'text/plain',
        },
      ],
    });
    expect(smtpRes.status).toBe('sent');
    expect(smtpRes.provider).toBe('dev_catcher');
    expect(kvAllowListReads).toBe(1);
    expect(catcher.messages).toHaveLength(1);
    expect(catcher.messages[0]!.mailFrom).toBe('noreply@notalawfirm.example');
    expect(catcher.messages[0]!.rcptTo).toEqual([
      'alice@notalawfirm.example',
      'vip.tester@external-pilot.test',
    ]);
    expect(catcher.messages[0]!.rawData).toContain(
      'Reply-To: <support@notalawfirm.example>',
    );
    expect(catcher.messages[0]!.rawData).toContain(
      Buffer.from('Confidential test attachment body.').toString('base64'),
    );

    // B. Disallowed recipients blocked BEFORE touching transport on ALL 3 active adapters
    for (const adapterCfg of [
      {
        provider: 'dev_catcher' as const,
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@notalawfirm.example'],
        devCatcher: { host: '127.0.0.1', port: 1, secure: false }, // Closed port — must NEVER be dialed
      },
      {
        provider: 'graph' as const,
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@1squared.co.uk'],
        graph: {
          tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
          clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
          certificateVaultRef: 'kv://kv-alphafirm-test/graph-mail-certificate',
          certificateThumbprint: cert.thumbprintHex,
        },
      },
      {
        provider: 'acs' as const,
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@notalawfirm.example'],
        acs: { connectionVaultRef: 'kv://kv-alphafirm-test/acs-conn' },
      },
    ]) {
      const dispatcher = new CoreEmailDispatcher({
        emailConfig: adapterCfg,
        secretReader,
        storageProvider,
        fetchFn,
      });
      // Includes domain-suffix lookalike attack (@evil-1squared.co.uk)
      const blocked = await dispatcher.send(ctx, {
        templateKey: 'test.blocked',
        recipients: {
          to: ['victim@evil-1squared.co.uk', 'outside@attacker.invalid'],
        },
        subject: 'Blocked',
        htmlBody: '<p>No</p>',
        textBody: 'No',
      });
      expect(blocked.status).toBe('dropped_allowlist');
      expect(blocked.provider).toBe(adapterCfg.provider);
      expect(blocked.blockedRecipients).toEqual([
        'victim@evil-1squared.co.uk',
        'outside@attacker.invalid',
      ]);
    }
    expect(graphRequests).toHaveLength(0);
    expect(catcher.messages).toHaveLength(1);

    // C. Empty allow-list & unreadable Key Vault secret fail closed in non-live
    const emptyAllowListDecision = await evaluateEmailAllowList(
      ctx,
      { provider: 'graph', recipientAllowList: [] },
      { to: ['user@notalawfirm.example'] },
    );
    expect(emptyAllowListDecision.allowed).toBe(false);
    expect(emptyAllowListDecision.reason).toBe('EMAIL_ALLOWLIST_EMPTY');

    const unreadableKvDecision = await evaluateEmailAllowList(
      ctx,
      {
        provider: 'graph',
        recipientAllowList: ['@notalawfirm.example'],
        recipientAllowListVaultRef: 'kv://kv-alphafirm-test/missing-allowlist',
      },
      { to: ['user@notalawfirm.example'] },
      { secretReader },
    );
    expect(unreadableKvDecision.allowed).toBe(false);
    expect(unreadableKvDecision.reason).toBe('EMAIL_ALLOWLIST_VAULT_UNREADABLE');

    // D. Allowed recipient reaches ACS adapter -> fail-closed EMAIL_PROVIDER_NOT_IMPLEMENTED
    const acsDispatcher = new CoreEmailDispatcher({
      emailConfig: {
        provider: 'acs',
        senderAddress: 'noreply@notalawfirm.example',
        recipientAllowList: ['@notalawfirm.example'],
        acs: { connectionVaultRef: 'kv://kv-alphafirm-test/acs-conn' },
      },
      storageProvider,
    });
    await expect(
      acsDispatcher.send(ctx, {
        templateKey: 'test.acs',
        recipients: { to: ['user@notalawfirm.example'] },
        subject: 'ACS Test',
        htmlBody: '<p>ACS</p>',
        textBody: 'ACS',
      }),
    ).rejects.toThrow(/EMAIL_PROVIDER_NOT_IMPLEMENTED/);

    // E. Allowed recipient on Graph posts expected JSON & attachment bytes
    const graphDispatcher = new CoreEmailDispatcher({
      emailConfig: {
        provider: 'graph',
        senderAddress: 'notifications@1squared.co.uk',
        replyTo: 'reply@notalawfirm.example',
        recipientAllowList: ['@1squared.co.uk'],
        graph: {
          tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
          clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
          certificateVaultRef: 'kv://kv-alphafirm-test/graph-mail-certificate',
          certificateThumbprint: cert.thumbprintHex,
        },
      },
      secretReader,
      storageProvider,
      fetchFn,
    });
    const graphRes = await graphDispatcher.send(ctx, {
      templateKey: 'test.graph',
      recipients: { to: ['pilot.user@1squared.co.uk'] },
      subject: 'Graph Hello',
      htmlBody: '<p>Hello Graph</p>',
      textBody: 'Hello Graph',
      attachments: [
        {
          blobKey: storedAtt.blobKey,
          fileName: 'brief.txt',
          contentType: 'text/plain',
        },
      ],
    });
    expect(graphRes.status).toBe('sent');
    expect(graphRes.providerMessageId).toBe('graph-msg-202');
    expect(graphRequests).toHaveLength(1);
    expect(graphRequests[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/users/notifications%401squared.co.uk/sendMail',
    );
    expect(graphRequests[0]!.body.saveToSentItems).toBe(false);

    // F. Disabled adapter returns cleanly without network/KV
    const disabledDispatcher = new CoreEmailDispatcher({
      emailConfig: { provider: 'disabled' },
    });
    expect(
      await disabledDispatcher.send(ctx, {
        templateKey: 'test.disabled',
        recipients: { to: ['nobody@invalid.test'] },
        subject: 'Disabled',
        htmlBody: '<p>No</p>',
        textBody: 'No',
      }),
    ).toEqual({
      status: 'disabled',
      provider: 'disabled',
      providerMessageId: null,
    });
  });

  it('4. PostgreSQL outbox lifecycle: idempotency, FOR UPDATE SKIP LOCKED claims, 5-min stale reclaim, backoff -> failed_permanent, 30-day scrub & zero PII', async () => {
    const ctx = await setupMigratedTenant('s026-outbox-pg', 'test');
    const outboxRepo = new TenantOutboxRepository();
    const auditRepo = new TenantAuditRepository();
    await outboxRepo.clearTenantData(ctx);

    const piiRecipient = 'sensitive.client.name@notalawfirm.example';
    const piiSubject = 'SECRET MATTER SUBJECT REF-9988';
    const piiBody = 'Confidential body text with client details.';

    // 1. Enqueue + idempotency deduplication
    const enq1 = await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 'idem-001',
      templateKey: 'notification.task_assigned',
      recipients: { to: [piiRecipient] },
      subject: piiSubject,
      htmlBody: `<p>${piiBody}</p>`,
      textBody: piiBody,
      createdByPersonId: 'P-000001',
    });
    expect(enq1.deduplicated).toBe(false);
    expect(enq1.record.status).toBe('pending');

    const enqDup = await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 'idem-001',
      templateKey: 'notification.task_assigned',
      recipients: { to: [piiRecipient] },
      subject: 'DIFFERENT IGNORED',
      htmlBody: '<p>X</p>',
      textBody: 'X',
    });
    expect(enqDup.deduplicated).toBe(true);
    expect(enqDup.record.id).toBe(enq1.record.id);

    // 2. Concurrent claim exclusion + 5-min stale 'sending' lease reclamation
    const t0 = new Date(Date.now() + 5_000);
    const claim1 = await outboxRepo.claimDueOutboxBatch(ctx, { now: t0 });
    expect(claim1).toHaveLength(1);
    const staleClaimToken = claim1[0]!.claimToken!;

    const claimConcurrent = await outboxRepo.claimDueOutboxBatch(ctx, {
      now: new Date(t0.getTime() + 60_000),
    });
    expect(claimConcurrent).toHaveLength(0);

    // Past 5 minutes (6 mins later), stale 'sending' row is reclaimed with new token
    const tReclaim = new Date(t0.getTime() + 6 * 60_000);
    const claim2 = await outboxRepo.claimDueOutboxBatch(ctx, { now: tReclaim });
    expect(claim2).toHaveLength(1);
    expect(claim2[0]!.claimToken).not.toBe(staleClaimToken);

    // Stale worker cannot mutate reclaimed row
    const staleAttempt = await outboxRepo.markOutboxSent(ctx, {
      id: enq1.record.id,
      claimToken: staleClaimToken,
      providerMessageId: 'should-fail',
    });
    expect(staleAttempt.updated).toBe(false);

    // Release active claim back to pending via attempt 1 failure before drain retry loop
    const firstFail = await outboxRepo.markOutboxAttemptFailed(ctx, {
      id: enq1.record.id,
      claimToken: claim2[0]!.claimToken!,
      error: new EmailIntegrationError('SMTP_DOWN', 'Temporary failure'),
      maxAttempts: 5,
      baseBackoffSeconds: 60,
      failedAt: tReclaim,
    });
    expect(firstFail.updated).toBe(true);
    expect(firstFail.permanentFailure).toBe(false);
    expect(firstFail.record?.attemptCount).toBe(1);
    expect(firstFail.record?.status).toBe('pending');

    // 3. Exponential backoff retries via drainEmailOutboxForTenant until permanent failure on attempt 5
    const baseCfg = getActiveTenantRawBaseConfig();
    const tenantConfig: TenantConfiguration = loadAndValidateTenantConfig(
      baseCfg,
      {
        integrations: {
          pmsConnectionSecretVaultRef:
            'kv://kv-notalawfirm-test/pms-connection-string',
          companiesHouseApiKeyVaultRef:
            'kv://kv-notalawfirm-test/companies-house-api-key',
          aiProviderChoice: 'disabled',
          email: {
            provider: 'dev_catcher',
            senderAddress: 'noreply@notalawfirm.example',
            outboxContentRetentionDays: 30,
            recipientAllowList: ['@notalawfirm.example'],
          },
        },
      },
      'test',
    );

    const failingSender = {
      provider: 'dev_catcher' as const,
      async send() {
        throw new EmailIntegrationError(
          'SMTP_TRANSIENT_503',
          `Mail relay error referencing ${piiRecipient}`,
        );
      },
    };

    let simNow = new Date(tReclaim.getTime() + 600_000);
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      const res = await drainEmailOutboxForTenant(ctx, {
        tenantConfig,
        outboxRepository: outboxRepo,
        emailSender: failingSender,
        now: simNow,
      });
      expect(res.retriedCount).toBe(1);
      expect(res.failedPermanentCount).toBe(0);
      simNow = new Date(simNow.getTime() + 3600_000);
    }

    // Attempt 5 -> 'failed_permanent' + audit + error telemetry 'outbox.delivery.failed_permanent'
    const permRes = await drainEmailOutboxForTenant(ctx, {
      tenantConfig,
      outboxRepository: outboxRepo,
      emailSender: failingSender,
      now: simNow,
    });
    expect(permRes.failedPermanentCount).toBe(1);

    const finalFailed = await outboxRepo.getOutboxRecordById(
      ctx,
      enq1.record.id,
    );
    expect(finalFailed?.status).toBe('failed_permanent');
    expect(finalFailed?.attemptCount).toBe(5);

    const permTelemetry = getPlatformTelemetryRecorder()
      .getRecentEntries({ tenantId: ctx.tenantId })
      .filter((e) => e.eventName === 'outbox.delivery.failed_permanent');
    expect(permTelemetry).toHaveLength(1);
    expect(permTelemetry[0]!.severity).toBe('error');

    // Verify ZERO PII in telemetry & audit logs
    const telemetryJson = JSON.stringify(
      getPlatformTelemetryRecorder().getRecentEntries({ tenantId: ctx.tenantId }),
    );
    expect(telemetryJson).not.toContain(piiRecipient);
    expect(telemetryJson).not.toContain(piiSubject);
    expect(telemetryJson).not.toContain(piiBody);

    const auditEntries = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'email_outbox',
      enq1.record.id,
      { limit: 20 },
    );
    const permAudit = auditEntries.find(
      (a) => a.action === 'email-send-failed-permanent',
    );
    expect(permAudit).toBeDefined();
    const auditJson = JSON.stringify(auditEntries);
    expect(auditJson).not.toContain(piiRecipient);
    expect(auditJson).not.toContain(piiSubject);
    expect(auditJson).not.toContain(piiBody);

    // 4. Retention scrub after 30 days leaves pending rows intact, clears terminal PII/content
    const stillPending = await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 'idem-pending-keep',
      templateKey: 'notification.general',
      recipients: { to: ['keep@notalawfirm.example'] },
      subject: 'Keep Pending',
      htmlBody: '<p>Keep</p>',
      textBody: 'Keep',
      nextAttemptAt: new Date(simNow.getTime() + 40 * 86_400_000).toISOString(),
    });

    const scrubTime = new Date(simNow.getTime() + 31 * 86_400_000);
    const scrubDrain = await drainEmailOutboxForTenant(ctx, {
      tenantConfig,
      outboxRepository: outboxRepo,
      emailSender: failingSender,
      now: scrubTime,
    });
    expect(scrubDrain.scrubbedCount).toBe(1);

    const scrubbedRow = await outboxRepo.getOutboxRecordById(
      ctx,
      enq1.record.id,
    );
    expect(scrubbedRow?.contentScrubbedAt).toBe(scrubTime.toISOString());
    expect(scrubbedRow?.subject).toBeNull();
    expect(scrubbedRow?.htmlBody).toBeNull();
    expect(scrubbedRow?.textBody).toBeNull();
    expect(scrubbedRow?.recipients.to).toEqual([]);

    const keptRow = await outboxRepo.getOutboxRecordById(
      ctx,
      stillPending.record.id,
    );
    expect(keptRow?.contentScrubbedAt).toBeNull();
    expect(keptRow?.subject).toBe('Keep Pending');
  });

  it('5. Notification preferences & pushNotification immediate email hook + multi-run outbox-drain job sweep without daily job_runs block', async () => {
    const tenantId = 'not-a-law-firm';
    const ctx = await setupMigratedTenant(tenantId, 'test');

    const seedStore = createSeedStore(new Date(), {
      includeSyntheticEntraOids: false,
    });
    await importFirmStoreModulesToPostgres({
      ctx,
      store: seedStore,
      clearFirst: true,
    });

    const people = await getPartyRepository().listAllPeople(ctx);
    const recipient = people.find(
      (p) => p.id !== 'P-000001' && (p.emails?.length ?? 0) > 0,
    )!;
    const recipientEmail = recipient.emails[0]!.address;

    const outboxRepo = getOutboxRepository();
    await outboxRepo.clearTenantData(ctx);

    // 1. Default provider='disabled': creating notification leaves outbox untouched
    setTestActorSession('P-000001', { roles: ['admin'], mfaVerified: true });
    await getTaskWorkflowRepository().clearTenantData(ctx);
    const disabledTaskRes = await saveTaskRecord(
      {
        title: 'Task while email disabled',
        assignedPersonId: recipient.id,
        dueAt: '2026-12-01',
      },
      'P-000001',
    );
    expect((disabledTaskRes as { task?: unknown }).task).toBeDefined();
    expect(await outboxRepo.listOutboxRecords(ctx)).toHaveLength(0);

    // 2. Notification preference default check + update + direct immediate enqueue hook
    const taskAssignedPref = await outboxRepo.getNotificationPreference(
      ctx,
      recipient.id,
      'task_assigned',
    );
    expect(taskAssignedPref.emailFrequency).toBe('immediate');

    const commentPref = await outboxRepo.getNotificationPreference(
      ctx,
      recipient.id,
      'task_comment',
    );
    expect(commentPref.emailFrequency).toBe('daily_digest');

    const catcher = await startEphemeralSmtpCatcher();
    activeClosers.push(catcher.close);
    const baseCfg = getActiveTenantRawBaseConfig();
    const devCatcherOverlay = {
      integrations: {
        pmsConnectionSecretVaultRef:
          'kv://kv-notalawfirm-test/pms-connection-string',
        companiesHouseApiKeyVaultRef:
          'kv://kv-notalawfirm-test/companies-house-api-key',
        aiProviderChoice: 'disabled',
        email: {
          provider: 'dev_catcher',
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: [
            '@notalawfirm.example',
            `@${recipientEmail.split('@')[1]}`,
          ],
          devCatcher: { host: catcher.host, port: catcher.port, secure: false },
        },
      },
    };
    const activeDevCatcherCfg = loadAndValidateTenantConfig(
      baseCfg,
      devCatcherOverlay,
      'test',
    );
    setActiveTenantConfigForTesting(baseCfg, devCatcherOverlay);

    // daily_digest notification skips immediate enqueue
    const digestEnq = await enqueueNotificationEmailIfImmediate(ctx, {
      id: 'NTF-COMMENT-1',
      recipientId: recipient.id,
      kind: 'task_comment',
      title: 'Digest only comment',
      detail: 'Should stay in daily digest',
      href: '/tasks/TSK-1',
      recordId: 'TSK-1',
      createdAt: new Date().toISOString(),
      read: false,
      byId: 'P-000001',
    });
    expect(digestEnq).toBeNull();

    // Update user preference to 'immediate' -> enqueue + best-effort post-commit drain delivers!
    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: recipient.id,
      notificationKind: 'task_comment',
      emailFrequency: 'immediate',
      digestDayOfWeek: 3,
    });
    const immediateEnq = await enqueueNotificationEmailIfImmediate(ctx, {
      id: 'NTF-COMMENT-2',
      recipientId: recipient.id,
      kind: 'task_comment',
      title: 'Immediate comment alert',
      detail: 'Escaped <script>alert(1)</script> body',
      href: '/tasks/TSK-2',
      recordId: 'TSK-2',
      createdAt: new Date().toISOString(),
      read: false,
      byId: 'P-000001',
    });
    expect(immediateEnq).toBeDefined();
    expect(catcher.messages).toHaveLength(1);
    const htmlPartMatch =
      /Content-Type: text\/html[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/.exec(
        catcher.messages[0]!.rawData,
      );
    expect(htmlPartMatch?.[1]).toBeTruthy();
    const decodedHtml = Buffer.from(
      htmlPartMatch![1]!.replace(/[\r\n]/g, ''),
      'base64',
    ).toString('utf8');
    expect(decodedHtml).toContain('&lt;script&gt;');

    // End-to-end host workflow: saveTaskRecord atomically enqueues task_assigned email inside its DB TX
    const sentTaskRes = await saveTaskRecord(
      {
        title: 'Task triggering real SMTP delivery',
        assignedPersonId: recipient.id,
        dueAt: '2026-12-05',
      },
      'P-000001',
    );
    expect((sentTaskRes as { task?: unknown }).task).toBeDefined();
    const pendingFromTask = await outboxRepo.listOutboxRecords(ctx, {
      status: 'pending',
    });
    expect(pendingFromTask).toHaveLength(1);
    expect(pendingFromTask[0]!.templateKey).toBe('notification.task_assigned');

    // 3. Scheduled outbox-drain job sweep via guardedJob runs multiple times same day (bypasses daily gate)
    await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 'sweep-msg-1',
      templateKey: 'notification.approval_requested',
      recipients: { to: ['approver@notalawfirm.example'] },
      subject: 'Approval Needed 1',
      htmlBody: '<p>Approve 1</p>',
      textBody: 'Approve 1',
    });

    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        {
          tenantId,
          slug: 'not_a_law_firm',
          environment: 'test',
          postgresHost: 'localhost',
          postgresDatabaseName: 'pg_tenant_not_a_law_firm_test',
          postgresRoleName: 'role_tenant_not_a_law_firm_test',
          keyVaultUri: 'https://kv-notalawfirm-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
      ],
    };

    const sweep1 = await runScheduledOutboxDrainJobSweep({
      registry,
      tenantConfigOverrideByTenantId: { [tenantId]: activeDevCatcherCfg },
    });
    expect(sweep1.exitCode).toBe(0);
    expect(sweep1.resultsByTenant[tenantId]?.sentCount).toBe(2);
    expect(catcher.messages).toHaveLength(3);

    await outboxRepo.enqueueEmail(ctx, {
      idempotencyKey: 'sweep-msg-2',
      templateKey: 'notification.approval_requested',
      recipients: { to: ['approver2@notalawfirm.example'] },
      subject: 'Approval Needed 2',
      htmlBody: '<p>Approve 2</p>',
      textBody: 'Approve 2',
    });

    // Second sweep on SAME local date must ALSO drain (ADR 0027 §6.4 variant!)
    const sweep2 = await runScheduledOutboxDrainJobSweep({
      registry,
      tenantConfigOverrideByTenantId: { [tenantId]: activeDevCatcherCfg },
    });
    expect(sweep2.exitCode).toBe(0);
    expect(sweep2.resultsByTenant[tenantId]?.sentCount).toBe(1);
    expect(catcher.messages).toHaveLength(4);

    // Restore clean seeded demo state + empty outbox on not-a-law-firm
    await outboxRepo.clearTenantData(ctx);
    await importFirmStoreModulesToPostgres({
      ctx,
      store: seedStore,
      clearFirst: true,
    });
  });

  it('6. Real two-tenant PostgreSQL isolation (tenant-alpha vs tenant-bravo): outbox, claims, preferences, tampered IDs & forged claims', async () => {
    const ctxAlpha = await setupMigratedTenant('tenant-alpha', 'test');
    const ctxBravo = await setupMigratedTenant('tenant-bravo', 'test');
    const outboxRepo = new TenantOutboxRepository();

    await outboxRepo.clearTenantData(ctxAlpha);
    await outboxRepo.clearTenantData(ctxBravo);

    const alphaMsg = await outboxRepo.enqueueEmail(ctxAlpha, {
      idempotencyKey: 'alpha-only-1',
      templateKey: 'notification.task_assigned',
      recipients: { to: ['alpha@notalawfirm.example'] },
      subject: 'Alpha Confidential Subject',
      htmlBody: '<p>Alpha</p>',
      textBody: 'Alpha',
      createdByPersonId: 'P-ALPHA',
    });

    await outboxRepo.upsertNotificationPreference(ctxAlpha, {
      personId: 'P-SHARED-1',
      notificationKind: 'task_comment',
      emailFrequency: 'none',
      teamsEnabled: true,
      digestDayOfWeek: 5,
    });

    // Bravo sees zero outbox rows from Alpha and default preference for P-SHARED-1
    expect(await outboxRepo.listOutboxRecords(ctxBravo)).toHaveLength(0);
    expect(
      await outboxRepo.getOutboxRecordById(ctxBravo, alphaMsg.record.id),
    ).toBeNull();
    expect(await outboxRepo.claimDueOutboxBatch(ctxBravo)).toHaveLength(0);

    const bravoPref = await outboxRepo.getNotificationPreference(
      ctxBravo,
      'P-SHARED-1',
      'task_comment',
    );
    expect(bravoPref.tenantId).toBe('tenant-bravo');
    expect(bravoPref.emailFrequency).toBe('daily_digest');
    expect(bravoPref.teamsEnabled).toBe(false);

    // Tampered claim/outbox ID against wrong tenant fails closed
    const alphaClaim = await outboxRepo.claimDueOutboxBatch(ctxAlpha);
    expect(alphaClaim).toHaveLength(1);
    const crossTenantMark = await outboxRepo.markOutboxSent(ctxBravo, {
      id: alphaMsg.record.id,
      claimToken: alphaClaim[0]!.claimToken!,
      providerMessageId: 'forged',
    });
    expect(crossTenantMark.updated).toBe(false);

    const alphaVerify = await outboxRepo.getOutboxRecordById(
      ctxAlpha,
      alphaMsg.record.id,
    );
    expect(alphaVerify?.status).toBe('sending');

    // Forged claim token check: wrong tenant context cannot enqueue/query across DB role
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: false as unknown as true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@invalid.test',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-1',
      }),
    ).toThrow(/TENANCY_AUTH_ERROR/);
  });

  it('R498: demo-environment TenantContext resolves certificateVaultRef and all demo kv:// references against https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/ while refusing Tenant B', async () => {
    const rootDir = process.cwd();
    const baseCfg = JSON.parse(
      fs.readFileSync(
        path.join(rootDir, 'client-not-a-law-firm', 'config', 'base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const demoOverlay = JSON.parse(
      fs.readFileSync(
        path.join(
          rootDir,
          'client-not-a-law-firm',
          'config',
          'environments',
          'demo.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;

    const demoCfg = loadAndValidateTenantConfig(baseCfg, demoOverlay, 'demo');
    expect(demoCfg.keyVault).toEqual({
      vaultName: 'kvnotalawfi2cdo3cw7vuafm',
      vaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
    });

    const demoCtx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'demo-verifier',
        tenantId: demoCfg.tenantId,
        name: 'Demo Verifier',
        email: 'demo.verifier@notalawfirm.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: demoCfg.hostingMode,
      environment: demoCfg.environment,
      correlationId: 'corr-r498-demo',
      configuredKeyVault: demoCfg.keyVault,
    });

    const tenantBCtx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'tenant-b-user',
        tenantId: 'pembroke-vaughan',
        name: 'Tenant B User',
        email: 'user@pembroke-vaughan.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'demo',
      correlationId: 'corr-r498-tenant-b',
      configuredKeyVault: {
        vaultName: 'kvpembrokevaughandemo01',
        vaultUri: 'https://kvpembrokevaughandemo01.vault.azure.net/',
      },
    });

    // Every configured kv:// reference in demo.json passes demoCtx ownership checks and is refused for Tenant B
    const demoSecretRefs = [
      demoCfg.integrations.pmsConnectionSecretVaultRef,
      demoCfg.integrations.companiesHouseApiKeyVaultRef,
      demoCfg.integrations.email?.recipientAllowListVaultRef,
      demoCfg.integrations.email?.graph?.certificateVaultRef,
      demoCfg.documentStores?.[0]?.auth.certificateKeyVaultSecretRef,
    ].filter((r): r is string => typeof r === 'string' && r.length > 0);
    expect(demoSecretRefs).toHaveLength(5);

    for (const ref of demoSecretRefs) {
      expect(assertTenantOwnsKeyVaultSecretRef(demoCtx, ref).vaultName).toBe(
        'kvnotalawfi2cdo3cw7vuafm',
      );
      expect(() => assertTenantOwnsKeyVaultSecretRef(tenantBCtx, ref)).toThrow(
        /TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED/,
      );
    }

    const cert = generateEphemeralSelfSignedCertAndKey('graph-mail.1squared.co.uk');
    let kvTokenRequests = 0;
    const requestedUrls: string[] = [];
    const credential: TokenCredential = {
      async getToken() {
        kvTokenRequests += 1;
        return {
          token: 'mock-kv-bearer-token',
          expiresOnTimestamp: Date.now() + 3600_000,
        };
      },
    };
    const kvReader = new DefaultAzureKeyVaultSecretReader({
      credential,
      fetchFn: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        return new Response(
          JSON.stringify({ value: `${cert.privateKeyPem}\n${cert.certPem}` }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    const certRef = demoCfg.integrations.email!.graph!.certificateVaultRef;
    expect(certRef).toBe(
      'kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate',
    );

    // Tenant B must fail closed before credential.getToken or fetch is ever invoked
    await expect(kvReader.readSecret(tenantBCtx, certRef)).rejects.toThrow(
      /TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED/,
    );
    expect(kvTokenRequests).toBe(0);
    expect(requestedUrls).toHaveLength(0);

    // Demo TenantContext resolves to the real vault HTTPS URL and signs assertion from PEM
    let capturedAssertion = '';
    const tokenProvider = new GraphAppTokenProvider({
      secretReader: kvReader,
      fetchFn: async (_url, init) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        capturedAssertion = params.get('client_assertion') ?? '';
        return new Response(
          JSON.stringify({ access_token: 'demo-graph-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const graphToken = await tokenProvider.acquireAppToken(demoCtx, {
      ...demoCfg.integrations.email!.graph!,
      certificateThumbprint: cert.thumbprintHex,
    });
    expect(graphToken).toBe('demo-graph-token');
    expect(kvTokenRequests).toBe(1);
    expect(requestedUrls).toEqual([
      'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/secrets/graph-mail-certificate?api-version=7.4',
    ]);

    const [hdrB64, payB64, sigB64] = capturedAssertion.split('.');
    expect(hdrB64 && payB64 && sigB64).toBeTruthy();
    expect(
      verifySignature(
        'RSA-SHA256',
        Buffer.from(`${hdrB64}.${payB64}`, 'utf8'),
        cert.publicKeyPem,
        Buffer.from(sigB64!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('R500: GraphAppTokenProvider signs a valid RS256 assertion from a PEM secret, rejects PKCS#12 and non-PEM secrets with GRAPH_CERT_FORMAT_UNSUPPORTED, and rejects thumbprint mismatches', async () => {
    const cert = generateEphemeralSelfSignedCertAndKey('graph-mail.1squared.co.uk');
    const otherCert = generateEphemeralSelfSignedCertAndKey('other.1squared.co.uk');
    const demoCtx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'demo-verifier',
        tenantId: 'not-a-law-firm',
        name: 'Demo Verifier',
        email: 'demo.verifier@notalawfirm.example',
        roles: ['admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'demo',
      correlationId: 'corr-r500-demo',
      configuredKeyVault: {
        vaultName: 'kvnotalawfi2cdo3cw7vuafm',
        vaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
      },
    });

    const baseGraphCfg = {
      tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
      clientId: 'fcdf1a96-eb5d-4ee9-8b7b-4cf6c88c64a1',
      certificateVaultRef: 'kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate',
      certificateThumbprint: cert.thumbprintHex,
    };

    let currentSecret = `${cert.privateKeyPem}\n${cert.certPem}`;
    let entraRequests = 0;
    let lastAssertion = '';

    const provider = new GraphAppTokenProvider({
      secretReader: {
        readSecret: async () => currentSecret,
      },
      fetchFn: async (_url, init) => {
        entraRequests += 1;
        lastAssertion =
          new URLSearchParams(String(init?.body ?? '')).get('client_assertion') ?? '';
        return new Response(
          JSON.stringify({ access_token: 'r500-pem-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    // 1. PKCS#12 secret is rejected with stable GRAPH_CERT_FORMAT_UNSUPPORTED
    currentSecret = cert.pkcs12Base64;
    await expect(
      provider.acquireAppToken(demoCtx, baseGraphCfg),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmailIntegrationError &&
        err.code === 'GRAPH_CERT_FORMAT_UNSUPPORTED',
    );
    expect(entraRequests).toBe(0);

    // Non-PEM plain text / JSON secrets are also rejected with GRAPH_CERT_FORMAT_UNSUPPORTED
    currentSecret = JSON.stringify({
      certificatePem: cert.certPem,
      privateKeyPem: cert.privateKeyPem,
    });
    await expect(
      provider.acquireAppToken(demoCtx, baseGraphCfg),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmailIntegrationError &&
        err.code === 'GRAPH_CERT_FORMAT_UNSUPPORTED',
    );
    expect(entraRequests).toBe(0);

    // 2. Thumbprint mismatch on PEM secret is still rejected with GRAPH_CERT_THUMBPRINT_MISMATCH
    currentSecret = `${otherCert.privateKeyPem}\n${otherCert.certPem}`;
    await expect(
      provider.acquireAppToken(demoCtx, baseGraphCfg),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmailIntegrationError &&
        err.code === 'GRAPH_CERT_THUMBPRINT_MISMATCH',
    );
    expect(entraRequests).toBe(0);

    // 3. Valid unencrypted PEM secret signs a verifiable RS256 client assertion
    currentSecret = `${cert.privateKeyPem}\n${cert.certPem}`;
    const token = await provider.acquireAppToken(demoCtx, baseGraphCfg);
    expect(token).toBe('r500-pem-token');
    expect(entraRequests).toBe(1);

    const [hdrB64, payB64, sigB64] = lastAssertion.split('.');
    expect(hdrB64 && payB64 && sigB64).toBeTruthy();
    expect(
      verifySignature(
        'RSA-SHA256',
        Buffer.from(`${hdrB64}.${payB64}`, 'utf8'),
        cert.publicKeyPem,
        Buffer.from(sigB64!, 'base64url'),
      ),
    ).toBe(true);
  });
});
