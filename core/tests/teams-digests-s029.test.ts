import { execFileSync } from 'node:child_process';
import {
  generateKeyPairSync,
  X509Certificate,
  createSign,
} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_JOB_ONLY_PERMISSION_KEYS,
  ALL_NOTIFICATION_KINDS,
  ALL_PERMISSION_KEYS,
  ALL_USER_PERMISSION_KEYS,
  buildSafeTeamsActivityFromNotification,
  CORE_REQUIRED_SCHEMA_VERSION,
  CORE_TENANT_MIGRATIONS,
  CoreTeamsNotifier,
  DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND,
  DEFAULT_RBAC_ROLES,
  drainOutboxForTenant,
  drainTeamsOutboxForTenant,
  evaluateTeamsRecipientAllowList,
  getPlatformTelemetryRecorder,
  GraphAppTokenProvider,
  loadAndValidateTenantConfig,
  PERMISSION_REGISTRY,
  resolveTenantFromVerifiedToken,
  resolveTenantIsoWeekday,
  resolveTenantLocalDateAndHour,
  SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND,
  sanitizeTeamsActivityPayload,
  TeamsIntegrationError,
  TEAMS_OUTBOX_AND_DIGESTS_MIGRATION_0020,
  TenantAuditRepository,
  TenantHrAndRbacRepository,
  TenantJobRunRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantOutboxRepository,
  TenantPartyRepository,
  TenantRegisterRepository,
  TenantTaskWorkflowRepository,
  type FetchLike,
  type KeyVaultSecretReader,
  type TenantConfiguration,
  type TenantContext,
  type TenantRegistry,
  type TeamsNotifier,
} from '../src/index';
import { resolvePersonPermissionSet } from '@/domain/rbac';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { REGISTERED_CLI_JOBS } from '../../scripts/run-job';
import {
  getActiveTenantRawBaseConfig,
  getMatterRepository,
  getOutboxRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  getMyNotificationPreferencesAction,
  updateMyNotificationPreferencesAction,
} from '@/app/actions';
import { JOB_PERMISSIONS } from '@/server/actionPermissions';
import { setTestEntraSessionOverride } from '@/server/entraAuth';
import { runAsTestActor, setTestActorSession } from '@/server/testSupport/auditTestSupport';
import {
  createRegisterRecordService,
  enqueueNotificationTeamsActivityIfEnabled,
  executeNotificationDigestsForTenant,
  getMyNotificationPreferences,
  markNotificationRead,
  runScheduledNotificationDigestsJobSweep,
  runScheduledOutboxDrainJobSweep,
  transitionRegisterRecordService,
  updateMyNotificationPreferences,
  updatePersonPermissionOverrides,
  updateRegisterRecordDetailsService,
  updateTenantRbacConfig,
} from '@/server/services';
import type { NotificationItem, Person } from '@/domain/types';

// ---------------------------------------------------------------------------
// Ephemeral ASN.1 DER self-signed cert builder (zero static keys)
// ---------------------------------------------------------------------------

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
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
  readonly thumbprintHex: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const sha256WithRsaAlgId = derSequence(
    derOid('2a864886f70d01010b'),
    Buffer.from([0x05, 0x00]),
  );
  const name = derSequence(derSet(derSequence(derOid('550403'), derUtf8(commonName))));
  const now = Date.now();
  const validity = derSequence(
    derUtcTime(new Date(now - 60_000)),
    derUtcTime(new Date(now + 3600_000)),
  );
  const tbs = derSequence(
    derTag(0xa0, derInteger(Buffer.from([0x02]))),
    derInteger(Buffer.from([0x01, 0x02, 0x03, 0x04])),
    sha256WithRsaAlgId,
    name,
    validity,
    name,
    spkiDer,
  );
  const signer = createSign('RSA-SHA256');
  signer.update(tbs);
  signer.end();
  const sig = signer.sign(privateKey);
  const certDer = derSequence(tbs, sha256WithRsaAlgId, derBitString(sig));
  const certBase64 = certDer.toString('base64').replace(/.{1,64}/g, '$&\n').trim();
  const certPem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----\n`;
  const thumbprintHex = new X509Certificate(certPem).fingerprint.replace(/:/g, '').toUpperCase();
  return { certPem, privateKeyPem, thumbprintHex };
}

async function startEphemeralHttpCatcher(): Promise<{
  readonly endpointUrl: string;
  readonly captured: Array<{ readonly headers: http.IncomingHttpHeaders; readonly body: unknown }>;
  close: () => Promise<void>;
}> {
  const captured: Array<{ readonly headers: http.IncomingHttpHeaders; readonly body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.push({
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requestId: `dc-${captured.length}` }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  return {
    endpointUrl: `http://127.0.0.1:${addr.port}/teams-activity`,
    captured,
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
      name: 'Test Colleague',
      email: 'alice.colleague@notalawfirm.example',
      roles: ['admin'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: env,
    correlationId: `corr-s029-${tenantId}-${Date.now()}`,
  });
}

function makeEmployeeRecord(overrides: {
  readonly id: string;
  readonly firstName: string;
  readonly surname: string;
  readonly email: string;
  readonly entraObjectId?: string | null;
  readonly roles?: string[];
  readonly appRole?: string;
  readonly isEmployee?: boolean;
  readonly status?: 'Active' | 'Leaver';
}): Person {
  const nowIso = '2026-01-10T09:00:00.000Z';
  return {
    id: overrides.id,
    recordType: 'person',
    recordOwnerId: 'P-000001',
    recordStatusId: 'record_status.active',
    createdById: 'P-000001',
    createdAt: nowIso,
    updatedById: 'P-000001',
    updatedAt: nowIso,
    sourceId: null,
    lastVerifiedAt: nowIso,
    tags: [],
    duplicateStatusId: 'duplicate_status.unique',
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    titleId: null,
    firstName: overrides.firstName,
    middleNames: '',
    surname: overrides.surname,
    preferredName: '',
    otherNames: [],
    jobTitle: 'Solicitor',
    emails: [
      {
        typeId: 'email_type.work',
        address: overrides.email,
        isPrimary: true,
        active: true,
        isWorkContact: true,
      },
    ],
    phones: [],
    preferredContactMethodId: null,
    preferredLanguageId: null,
    addresses: [],
    website: '',
    relationshipOwnerId: null,
    relationshipStatusId: null,
    relationshipStandingId: null,
    relationshipRoleIds: ['person_role.employee'],
    originId: null,
    firstKnownAt: nowIso,
    engagementLevelId: null,
    interests: '',
    relationshipNotes: '',
    marketingConsentId: null,
    consentRecord: '',
    verificationStatusId: null,
    verifiedAt: null,
    verificationMethodId: null,
    verificationReviewerId: null,
    riskReferences: '',
    isEmployee: overrides.isEmployee ?? true,
    employeeRoleId: 'employee_role.fee_earner',
    departmentId: 'DEPT-DISP',
    roles: overrides.roles ?? ['fee_earner'],
    appRole: (overrides.appRole ?? 'fee_earner') as Person['appRole'],
    entraObjectId:
      overrides.entraObjectId === undefined ? undefined : overrides.entraObjectId,
    employment: {
      employeeNumber: `EMP-${overrides.id}`,
      status: overrides.status ?? 'Active',
      contractType: 'Permanent',
      workLocationArrangement: 'Hybrid',
      startDate: '2025-01-01',
      probationEndDate: null,
      probationOutcome: null,
      leavingDate: overrides.status === 'Leaver' ? '2026-01-15' : null,
      exitReasonId: null,
      assignments: [],
      hoursAndPattern: {
        contractedHoursPerWeek: 37.5,
        fte: 1,
        workingDays: [1, 2, 3, 4, 5],
        partTime: false,
      },
      practising: {
        isRegulatedLegalProfessional: true,
        practisingCertificateHeld: true,
      },
      absenceSummary: {
        annualLeaveEntitlementDays: 25,
        leaveYearStartMonth: 1,
      },
      systems: {
        entraUsername: overrides.email,
        firmWorkEmail: overrides.email,
        dmsUserId: null,
        pmsFeeEarnerCode: null,
        entraObjectId: overrides.entraObjectId ?? null,
      },
    },
  } as unknown as Person;
}

async function setupCleanMigratedTenant(
  tenantId: string,
  env: 'test' | 'dev' | 'demo' = 'test',
): Promise<TenantContext> {
  await provisionPostgresClusterRolesAndDatabases({
    tenants: [{ tenantId, environment: env }],
  });
  const ctx = makeTenantContext(tenantId, env);
  const runner = new TenantMigrationRunner();
  await runner.applyUp(ctx, CORE_TENANT_MIGRATIONS);

  await new TenantJobRunRepository().clearTenantJobRuns(ctx);
  await new TenantOutboxRepository().clearTenantData(ctx);
  await new TenantTaskWorkflowRepository().clearTenantData(ctx);
  await new TenantMatterRepository().clearTenantData(ctx);
  await new TenantKeyDateRepository().clearTenantData(ctx);
  await new TenantHrAndRbacRepository().clearTenantData(ctx);
  await new TenantPartyRepository().clearTenantData(ctx);
  return ctx;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  setActiveTenantConfigForTesting(null);
  setTestEntraSessionOverride(undefined);
  getPlatformTelemetryRecorder().clearForTesting();
  for (const close of activeClosers.splice(0)) {
    await close();
  }
});

describe('S0-29: Teams Activity Notifier, Daily/Weekly Digests & Self-Service Notification Preferences', () => {
  it('1. Migration 0020, RBAC 70+10=80 (admin invariant), JOB_PERMISSIONS/CLI/Bicep & demo Teams config', () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(22);
    expect(TEAMS_OUTBOX_AND_DIGESTS_MIGRATION_0020.version).toBe('0020');
    expect(TEAMS_OUTBOX_AND_DIGESTS_MIGRATION_0020.dependsOn).toEqual(['0019']);

    expect(ALL_PERMISSION_KEYS).toHaveLength(82);
    expect(ALL_USER_PERMISSION_KEYS).toHaveLength(71);
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toHaveLength(11);
    expect(ALL_USER_PERMISSION_KEYS).toContain('notification:view_own');
    expect(ALL_USER_PERMISSION_KEYS).toContain('notification:manage_own_preferences');
    expect(ALL_JOB_ONLY_PERMISSION_KEYS).toContain('notification:send_digests');
    expect(PERMISSION_REGISTRY['notification:send_digests'].jobOnly).toBe(true);
    expect(PERMISSION_REGISTRY['notification:send_digests'].sensitivity).toBe('critical');

    for (const roleKey of ALL_BUILTIN_ROLE_KEYS) {
      const perms = DEFAULT_RBAC_ROLES[roleKey].permissions;
      expect(perms).toContain('notification:view_own');
      expect(perms).toContain('notification:manage_own_preferences');
      expect(perms).not.toContain('notification:send_digests');
    }
    expect(DEFAULT_RBAC_ROLES.admin.permissions).not.toContain(
      'matter:opening_gate:override',
    );
    expect(DEFAULT_RBAC_ROLES.admin.permissions).toHaveLength(
      ALL_USER_PERMISSION_KEYS.length - 4,
    );

    expect(JOB_PERMISSIONS['notification-digests']).toMatchObject({
      kind: 'job',
      permission: 'notification:send_digests',
      jobOnly: true,
    });
    const cliJob = REGISTERED_CLI_JOBS.find((j) => j.name === 'notification-digests');
    expect(cliJob).toMatchObject({
      name: 'notification-digests',
      mode: 'scheduled',
      schedule: '0 * * * *',
    });

    const platformBicep = fs.readFileSync(
      path.join(process.cwd(), 'core/infra/modules/platform.bicep'),
      'utf8',
    );
    expect(platformBicep).toContain("var notificationDigestsJobName = take('caj-ntf-dig-${environment}', 32)");
    expect(platformBicep).toContain("'notification-digests'");

    // Demo overlay validation with Teams client ID 76474047-ac1f-49ee-83f3-5a2a58c2b3f8
    const baseRaw = getActiveTenantRawBaseConfig();
    const demoRaw = readJson(
      path.join(process.cwd(), 'client-not-a-law-firm/config/environments/demo.json'),
    );
    const demoCfg = loadAndValidateTenantConfig(baseRaw, demoRaw);
    expect(demoCfg.notifications?.digestHourLocal).toBe(8);
    expect(demoCfg.keyVault).toEqual({
      vaultName: 'kvnotalawfi2cdo3cw7vuafm',
      vaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
    });
    expect(demoCfg.integrations.pmsConnectionSecretVaultRef).toBe(
      'kv://kvnotalawfi2cdo3cw7vuafm/pms-connection-string',
    );
    expect(demoCfg.integrations.companiesHouseApiKeyVaultRef).toBe(
      'kv://kvnotalawfi2cdo3cw7vuafm/companies-house-api-key',
    );
    expect(demoCfg.integrations.email).toMatchObject({
      provider: 'disabled',
      senderAddress: 'notifications@1squared.co.uk',
      recipientAllowList: ['@1squared.co.uk'],
      recipientAllowListVaultRef:
        'kv://kvnotalawfi2cdo3cw7vuafm/email-recipient-allowlist',
      graph: {
        certificateVaultRef:
          'kv://kvnotalawfi2cdo3cw7vuafm/graph-mail-certificate',
        certificateThumbprint: 'C5428D7F519AE513A5B8CE027D291876CEDA40D3',
      },
    });
    expect(demoCfg.documentStores?.[0]?.auth.certificateKeyVaultSecretRef).toBe(
      'kv://kvnotalawfi2cdo3cw7vuafm/sp-provisioning-cert',
    );
    expect(demoCfg.integrations.teams).toMatchObject({
      provider: 'graph',
      teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
      recipientAllowList: ['@1squared.co.uk'],
      recipientAllowListVaultRef: 'kv://kvnotalawfi2cdo3cw7vuafm/teams-recipient-allowlist',
      graph: {
        clientId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
        certificateVaultRef: 'kv://kvnotalawfi2cdo3cw7vuafm/graph-teams-client-cert',
        certificateThumbprint: '6A23E571EA3F43D1DB39C187A201B40454159D3B',
      },
    });

    // Reject dev_catcher in live & graph without certificateThumbprint & wrong-tenant KV ref
    expect(() =>
      loadAndValidateTenantConfig(baseRaw, {
        environment: 'live',
        integrations: {
          teams: {
            provider: 'dev_catcher',
            devCatcher: { endpointUrl: 'http://127.0.0.1:4125/teams' },
          },
        },
      }),
    ).toThrow(/forbidden in live/i);

    expect(() =>
      loadAndValidateTenantConfig(baseRaw, {
        environment: 'test',
        integrations: {
          teams: {
            provider: 'graph',
            graph: {
              tenantId: '11111111-1111-1111-1111-111111111111',
              clientId: '22222222-2222-2222-2222-222222222222',
              certificateVaultRef: 'kv://kv-notalawfirm-test/teams-cert',
            },
          },
        },
      }),
    ).toThrow(/certificateThumbprint/i);

    expect(() =>
      loadAndValidateTenantConfig(baseRaw, {
        environment: 'demo',
        keyVault: {
          vaultName: 'kvnotalawfi2cdo3cw7vuafm',
          vaultUri: 'https://kvnotalawfi2cdo3cw7vuafm.vault.azure.net/',
        },
        integrations: {
          teams: {
            provider: 'disabled',
            recipientAllowListVaultRef: 'kv://kv-other-tenant-demo/teams-allow',
          },
        },
      }),
    ).toThrow(/Key Vault/i);
  });

  it('2. S4 defaults across all 13 kinds, self-service preferences CRUD, self-only & jobOnly guards, and digest_sent_at preservation on markNotificationRead', async () => {
    const ctxAdmin = await setupCleanMigratedTenant('s029-prefs');
    setActiveTenantConfigForTesting({
      ...(structuredClone(getActiveTenantRawBaseConfig()) as Record<string, unknown>),
      tenantId: 's029-prefs',
    });
    const partyRepo = getPartyRepository();
    const outboxRepo = getOutboxRepository();
    const taskRepo = getTaskWorkflowRepository();
    const auditRepo = new TenantAuditRepository();

    const admin = makeEmployeeRecord({
      id: 'P-000001',
      firstName: 'Aldous',
      surname: 'Vane',
      email: 'aldous.vane@notalawfirm.example',
      roles: ['admin'],
      appRole: 'admin',
      entraObjectId: 'oid-aldous-001',
    });
    const alice = makeEmployeeRecord({
      id: 'P-000002',
      firstName: 'Alice',
      surname: 'Hughes',
      email: 'alice.hughes@notalawfirm.example',
      roles: ['fee_earner'],
      appRole: 'fee_earner',
      entraObjectId: 'oid-alice-002',
    });
    await partyRepo.putPeople(ctxAdmin, [admin, alice]);

    const ctxAlice = makeTenantContext('s029-prefs', 'test', 'P-000002');
    const defaultsAlice = await getMyNotificationPreferences('P-000002', {
      actorPersonId: 'P-000002',
      tenantCtx: ctxAlice,
    });
    expect(defaultsAlice).toHaveLength(13);
    expect(ALL_NOTIFICATION_KINDS).toHaveLength(13);
    const byKind = new Map(defaultsAlice.map((p) => [p.notificationKind, p]));
    expect(byKind.get('task_assigned')?.emailFrequency).toBe('immediate');
    expect(byKind.get('task_overdue')?.emailFrequency).toBe('immediate');
    expect(byKind.get('enquiry_assigned')?.emailFrequency).toBe('immediate');
    expect(byKind.get('approval_requested')?.emailFrequency).toBe('immediate');
    expect(byKind.get('approval_decided')?.emailFrequency).toBe('immediate');
    expect(byKind.get('register_review_assigned')?.emailFrequency).toBe('immediate');
    expect(byKind.get('team_task_arrived')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('task_comment')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('task_due_soon')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('key_date_approaching')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('credit_control_escalation')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('register_reminder')?.emailFrequency).toBe('daily_digest');
    expect(byKind.get('general')?.emailFrequency).toBe('daily_digest');
    for (const p of defaultsAlice) {
      expect(p.inAppEnabled).toBe(true);
      expect(p.teamsEnabled).toBe(false);
    }
    expect(DEFAULT_NOTIFICATION_PREFERENCES_BY_KIND.register_reminder.emailFrequency).toBe(
      'daily_digest',
    );

    // Self-only enforcement: even admin cannot read or write Alice's preferences via self-service
    await expect(
      getMyNotificationPreferences('P-000002', {
        actorPersonId: 'P-000001',
        tenantCtx: ctxAdmin,
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      updateMyNotificationPreferences(
        {
          personId: 'P-000002',
          updates: [{ notificationKind: 'task_comment', teamsEnabled: true }],
        },
        { actorPersonId: 'P-000001', tenantCtx: ctxAdmin },
      ),
    ).rejects.toThrow(/FORBIDDEN/);

    // Invalid working day (Saturday = 6, Sunday = 0) rejected cleanly
    await expect(
      updateMyNotificationPreferences(
        { personId: 'P-000002', updates: [], digestDayOfWeek: 6 },
        { actorPersonId: 'P-000002', tenantCtx: ctxAlice },
      ),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_INVALID/);

    // Valid self-service update writes preferences + same-TX zero-PII audit
    const updated = await updateMyNotificationPreferences(
      {
        personId: 'P-000002',
        digestDayOfWeek: 5,
        updates: [
          {
            notificationKind: 'task_comment',
            emailFrequency: 'weekly_digest',
            teamsEnabled: true,
            inAppEnabled: false,
          },
          { notificationKind: 'general', emailFrequency: 'none' },
        ],
      },
      { actorPersonId: 'P-000002', tenantCtx: ctxAlice },
    );
    const updatedComment = updated.find((p) => p.notificationKind === 'task_comment');
    expect(updatedComment).toMatchObject({
      inAppEnabled: false,
      emailFrequency: 'weekly_digest',
      teamsEnabled: true,
      digestDayOfWeek: 5,
    });

    const auditEntries = await auditRepo.listAuditEntriesForRecord(
      ctxAlice,
      'notification_preferences',
      'P-000002',
    );
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(auditEntries)).not.toContain('alice.hughes@notalawfirm.example');

    // Guarded Server Action self-only & RBAC checks
    setActiveTenantConfigForTesting(getActiveTenantRawBaseConfig(), {
      tenantId: 's029-prefs',
      environment: 'test',
    });
    setTestActorSession('P-000002', {
      email: 'alice.hughes@notalawfirm.example',
      roles: ['fee_earner'],
      mfaVerified: true,
    });

    const crossActionGet = await getMyNotificationPreferencesAction('P-000001');
    expect(crossActionGet).toMatchObject({ denied: true, code: 'FORBIDDEN' });
    const ownActionGet = await getMyNotificationPreferencesAction('P-000002');
    expect(ownActionGet.preferences).toHaveLength(13);

    const actionSave = await updateMyNotificationPreferencesAction({
      personId: 'P-000002',
      digestDayOfWeek: 3,
      updates: [{ notificationKind: 'task_due_soon', emailFrequency: 'weekly_digest' }],
    });
    expect(actionSave.saved).toBe(true);
    expect(
      actionSave.preferences.find((p) => p.notificationKind === 'task_due_soon')
        ?.digestDayOfWeek,
    ).toBe(3);

    // Job-only notification:send_digests cannot be granted to any user or role
    await expect(
      updatePersonPermissionOverrides(
        'P-000002',
        { grant: ['notification:send_digests'], revoke: [], reason: 'Attempt bypass' },
        'P-000001',
        { mfaVerified: true },
      ),
    ).rejects.toThrow();

    const fullDefaultRbac = {
      roles: DEFAULT_RBAC_ROLES,
      departmentGrants: {},
      relationshipGrants: [],
      identityMapping: {
        authorityMode: 'hybrid' as const,
        entraGroupToRoleKey: {},
        entraAppRoleToRoleKey: {},
        defaultRoleKeys: ['fee_earner' as const],
        requireMfaForAdminPermissions: true,
      },
    };
    await expect(
      updateTenantRbacConfig(
        {
          ...fullDefaultRbac,
          roles: {
            ...DEFAULT_RBAC_ROLES,
            fee_earner: {
              ...DEFAULT_RBAC_ROLES.fee_earner,
              permissions: [
                ...DEFAULT_RBAC_ROLES.fee_earner.permissions,
                'notification:send_digests',
              ],
            },
          },
        },
        'P-000001',
        { mfaVerified: true },
      ),
    ).rejects.toThrow();

    const effectiveAdmin = resolvePersonPermissionSet(admin, {
      allPeople: [admin, alice],
      teams: [],
      tenantId: 's029-prefs',
      config: { rbac: fullDefaultRbac },
    });
    expect(effectiveAdmin.permissions.has('notification:send_digests')).toBe(false);

    // COALESCE invariant: markNotificationRead preserves digest_sent_at & matter_id
    const sentStamp = '2026-03-30T08:00:00.000Z';
    await taskRepo.putNotification(ctxAlice, {
      id: 'NTF-900001',
      recipientId: 'P-000002',
      kind: 'task_due_soon',
      title: 'Preserved Notification',
      detail: 'Test detail',
      href: '/matters/MAT-000010',
      recordId: 'TSK-000010',
      matterId: 'MAT-000010',
      digestSentAt: sentStamp,
      createdAt: '2026-03-29T10:00:00.000Z',
      read: false,
      byId: 'P-000001',
    });
    await taskRepo.markNotificationRead(ctxAlice, 'NTF-900001', 'P-000002');
    const afterRead = await taskRepo.getNotificationById<{
      read: boolean;
      digestSentAt?: string | null;
      matterId?: string | null;
    }>(ctxAlice, 'NTF-900001');
    expect(afterRead?.read).toBe(true);
    expect(afterRead?.digestSentAt).toBe(sentStamp);
    expect(afterRead?.matterId).toBe('MAT-000010');
    await markNotificationRead('NTF-900001', 'P-000002');
    expect(outboxRepo).toBeDefined();
  });

  it('3. Mon-Fri & GMT/BST DST digest scheduler (March/October 2026), weekly schedule, idempotency, and revoked restricted-matter suppression', async () => {
    const ctx = await setupCleanMigratedTenant('s029-digest');
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const taskRepo = getTaskWorkflowRepository();
    const outboxRepo = getOutboxRepository();
    const auditRepo = new TenantAuditRepository();

    const digestOverlay = {
      tenantId: 's029-digest',
      environment: 'test',
      timeZone: 'Europe/London',
      notifications: { digestHourLocal: 8 },
      integrations: {
        email: {
          provider: 'disabled',
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@notalawfirm.example'],
        },
      },
    };
    const baseCfg = loadAndValidateTenantConfig(getActiveTenantRawBaseConfig(), digestOverlay);
    setActiveTenantConfigForTesting(getActiveTenantRawBaseConfig(), digestOverlay);

    const alice = makeEmployeeRecord({
      id: 'P-000002',
      firstName: 'Alice',
      surname: 'Hughes',
      email: 'alice.hughes@notalawfirm.example',
      roles: ['fee_earner'],
      entraObjectId: 'oid-alice-digest',
    });
    await partyRepo.putPerson(ctx, alice);

    // Saturday & Sunday skip cleanly BEFORE any public.job_runs row
    expect(resolveTenantIsoWeekday(new Date('2026-03-28T09:00:00.000Z'), 'Europe/London')).toBe(6);
    expect(resolveTenantIsoWeekday(new Date('2026-03-29T09:00:00.000Z'), 'Europe/London')).toBe(7);

    const satSkip = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-03-28T09:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(satSkip).toMatchObject({ outcome: 'outside_working_days', isoWeekday: 6 });
    const sunSkip = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-03-29T09:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(sunSkip).toMatchObject({ outcome: 'outside_working_days', isoWeekday: 7 });

    const runsAfterWeekend = await taskRepo.withTenantReadTransaction(ctx, async (tx) => {
      const r = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.job_runs WHERE tenant_id = $1 AND job_key = 'notification-digests'`,
        [ctx.tenantId],
      );
      return Number(r.rows[0]?.count ?? 0);
    });
    expect(runsAfterWeekend).toBe(0);

    // Spring-forward BST transition: 2026-03-30 (Monday in BST = UTC+1)
    // 06:59Z is 07:59 BST -> before_window; 07:00Z is 08:00 BST -> executes
    expect(resolveTenantLocalDateAndHour(new Date('2026-03-30T06:59:00.000Z'), 'Europe/London')).toMatchObject({
      localDate: '2026-03-30',
      localHour: 7,
    });
    const springBefore = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-03-30T06:59:00.000Z'),
      drainAfterCommit: false,
    });
    expect(springBefore.outcome).toBe('before_window');

    // Create two matters: ordinary + one that gets restricted AFTER notification creation (revocation check!)
    await matterRepo.putMatter(ctx, {
      id: 'MAT-000100',
      matterNumber: 'NLF-2026-0100',
      description: 'Ordinary Dispute Matter',
      clientId: 'ORG-1',
      statusId: 'matter_status.open',
      practiceAreaId: 'practice_area.dispute_resolution',
      teamId: 'TEAM-1',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-01-10T09:00:00.000Z',
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
    } as never);

    await matterRepo.putMatter(ctx, {
      id: 'MAT-000200',
      matterNumber: 'NLF-2026-0200',
      description: 'Confidential Wall Matter Title Secret',
      clientId: 'ORG-2',
      statusId: 'matter_status.open',
      practiceAreaId: 'practice_area.dispute_resolution',
      teamId: 'TEAM-1',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-01-10T09:00:00.000Z',
      isStaffMatter: true,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-000001'], // Alice's access revoked before digest runs!
    } as never);

    // Preferences: Alice wants task_due_soon as daily_digest, task_comment as weekly_digest on Wednesday (3), general as none
    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: 'P-000002',
      notificationKind: 'task_comment',
      emailFrequency: 'weekly_digest',
      digestDayOfWeek: 3, // Wednesday
    });
    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: 'P-000002',
      notificationKind: 'general',
      emailFrequency: 'none',
    });

    // Enqueue 4 notifications for Alice:
    // 1. Ordinary daily_digest -> should appear in Monday digest
    await taskRepo.putNotification(ctx, {
      id: 'NTF-100001',
      recipientId: 'P-000002',
      kind: 'task_due_soon',
      title: 'Ordinary Deadline Reminder',
      detail: 'Witness statement due soon',
      href: '/matters/MAT-000100',
      recordId: 'TSK-000100',
      matterId: 'MAT-000100',
      createdAt: '2026-03-30T06:00:00.000Z',
      read: false,
      byId: 'P-000001',
    });
    // 2. Revoked restricted matter -> MUST be suppressed by digest job & UI listNotificationsForUser
    await taskRepo.putNotification(ctx, {
      id: 'NTF-100002',
      recipientId: 'P-000002',
      kind: 'key_date_approaching',
      title: 'Confidential Wall Matter Title Secret Deadline',
      detail: 'Secret restricted details must never email',
      href: '/matters/MAT-000200',
      recordId: 'MAT-000200',
      matterId: 'MAT-000200',
      createdAt: '2026-03-30T06:05:00.000Z',
      read: false,
      byId: 'P-000001',
    });
    // 3. Weekly digest item on Monday (today is 1, user chose Wednesday 3) -> MUST defer until Wednesday!
    await taskRepo.putNotification(ctx, {
      id: 'NTF-100003',
      recipientId: 'P-000002',
      kind: 'task_comment',
      title: 'Weekly Summary Comment',
      detail: 'Comment queued for Wednesday weekly digest',
      href: '/matters/MAT-000100',
      recordId: 'TSK-000101',
      matterId: 'MAT-000100',
      createdAt: '2026-03-30T06:10:00.000Z',
      read: false,
      byId: 'P-000001',
    });
    // 4. Opted-out ('none') -> never emailed
    await taskRepo.putNotification(ctx, {
      id: 'NTF-100004',
      recipientId: 'P-000002',
      kind: 'general',
      title: 'Opted Out General Notice',
      detail: 'Should not be emailed',
      href: '/tasks',
      recordId: 'GEN-1',
      createdAt: '2026-03-30T06:15:00.000Z',
      read: false,
      byId: 'P-000001',
    });

    // Verify DB visibility filtering also hides NTF-100002 by matter_id
    const visibleNotifsForAlice = await taskRepo.listNotificationsForUser<NotificationItem>(
      ctx,
      'P-000002',
    );
    expect(visibleNotifsForAlice.map((n) => n.id)).not.toContain('NTF-100002');

    // Run Monday 2026-03-30 at 07:00Z (= 08:00 BST!)
    const mondayRun = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-03-30T07:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(mondayRun.outcome).toBe('executed');
    if (mondayRun.outcome === 'executed') {
      expect(mondayRun.result).toMatchObject({
        localDate: '2026-03-30',
        isoWeekday: 1,
        digestEmailsQueued: 1,
        digestedNotificationCount: 1,
        suppressedRevokedCount: 1,
        deferredWeeklyCount: 1,
        nonDigestMarkedCount: 1,
      });
    }

    const outboxAfterMon = await outboxRepo.listOutboxRecords(ctx);
    expect(outboxAfterMon).toHaveLength(1);
    expect(outboxAfterMon[0]!.templateKey).toBe('notification-digest-daily');
    expect(outboxAfterMon[0]!.idempotencyKey).toBe(
      'digest:s029-digest:P-000002:2026-03-30',
    );
    expect(outboxAfterMon[0]!.htmlBody).toContain('Ordinary Deadline Reminder');
    expect(outboxAfterMon[0]!.htmlBody).not.toContain('Confidential Wall Matter Title Secret');
    expect(outboxAfterMon[0]!.htmlBody).not.toContain('Weekly Summary Comment');
    expect(outboxAfterMon[0]!.htmlBody).not.toContain('Opted Out General Notice');

    // Zero-PII audit check for notification-digest-queued
    const digestAudit = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'notification_digest',
      'DIGEST-2026-03-30',
    );
    expect(digestAudit.length).toBeGreaterThanOrEqual(1);
    const latestDigestAudit = digestAudit[digestAudit.length - 1]!;
    expect(latestDigestAudit.action).toBe('notification-digest-queued');
    expect(JSON.stringify(digestAudit)).not.toContain('alice.hughes@notalawfirm.example');
    expect(JSON.stringify(digestAudit)).not.toContain('Confidential Wall Matter Title Secret');

    // Re-running on same day -> already_succeeded_today, no duplicate email
    const mondaySecond = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-03-30T08:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(mondaySecond.outcome).toBe('already_succeeded_today');
    expect(await outboxRepo.listOutboxRecords(ctx)).toHaveLength(1);

    // Verify NTF-100003 (weekly) stayed digest_sent_at=NULL until Wednesday 2026-04-01 (07:00Z = 08:00 BST)
    const wedRun = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-04-01T07:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(wedRun.outcome).toBe('executed');
    if (wedRun.outcome === 'executed') {
      expect(wedRun.result.digestEmailsQueued).toBe(1);
      expect(wedRun.result.digestedNotificationCount).toBe(1);
    }
    const wedOutbox = (await outboxRepo.listOutboxRecords(ctx)).find(
      (r) => r.idempotencyKey === 'digest:s029-digest:P-000002:2026-04-01',
    );
    expect(wedOutbox?.templateKey).toBe('notification-digest-weekly');
    expect(wedOutbox?.htmlBody).toContain('Weekly Summary Comment');

    // Autumn fall-back GMT transition: 2026-10-26 (Monday in GMT = UTC+0)
    // 07:59Z = 07:59 GMT -> before_window; 08:00Z = 08:00 GMT -> executes!
    const autumnBefore = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-10-26T07:59:00.000Z'),
      drainAfterCommit: false,
    });
    expect(autumnBefore.outcome).toBe('before_window');

    const autumnRun = await executeNotificationDigestsForTenant(ctx, {
      tenantConfig: baseCfg,
      now: new Date('2026-10-26T08:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(autumnRun.outcome).toBe('executed');
    if (autumnRun.outcome === 'executed') {
      expect(autumnRun.result.localDate).toBe('2026-10-26');
    }
  });

  it('4. TeamsNotifier (disabled, unbound, leaver, non-live allow-list, content scrubbing, dev_catcher HTTP, and mocked Graph /sendActivityNotification)', async () => {
    const ctx = await setupCleanMigratedTenant('s029-teams');
    const partyRepo = getPartyRepository();
    const auditRepo = new TenantAuditRepository();
    const cert = generateEphemeralSelfSignedCertAndKey('notalawfirm.example');
    const catcher = await startEphemeralHttpCatcher();
    activeClosers.push(catcher.close);

    const boundAllowed = makeEmployeeRecord({
      id: 'P-000001',
      firstName: 'Aldous',
      surname: 'Vane',
      email: 'aldous.vane@notalawfirm.example',
      entraObjectId: 'oid-aldous-teams',
    });
    const unboundEmp = makeEmployeeRecord({
      id: 'P-000002',
      firstName: 'Unbound',
      surname: 'User',
      email: 'unbound.user@notalawfirm.example',
      entraObjectId: null,
    });
    const blockedDomainEmp = makeEmployeeRecord({
      id: 'P-000003',
      firstName: 'External',
      surname: 'Blocked',
      email: 'external.user@otherfirm.invalid',
      entraObjectId: 'oid-blocked-003',
    });
    const leaverWithOid = makeEmployeeRecord({
      id: 'P-000004',
      firstName: 'Former',
      surname: 'Staff',
      email: 'former.staff@notalawfirm.example',
      entraObjectId: 'oid-leaver-004',
      status: 'Leaver',
    });
    await partyRepo.putPeople(ctx, [
      boundAllowed,
      unboundEmp,
      blockedDomainEmp,
      leaverWithOid,
    ]);

    // 1. Scrubber invariants
    expect(() =>
      sanitizeTeamsActivityPayload({
        idempotencyKey: 'k-1',
        recipientPersonId: 'P-000001',
        activityType: 'taskAssigned',
        previewText: 'Confidential Client Merger',
        templateParameters: [{ name: 'matterTitle', value: 'Secret M&A Deal' }],
        deepLinkPath: '/tasks/TSK-1',
        correlationId: 'corr-1',
      }),
    ).toThrow(/TEAMS_CONTENT_SCRUB_REJECTED/);

    expect(() =>
      sanitizeTeamsActivityPayload({
        idempotencyKey: 'k-2',
        recipientPersonId: 'P-000001',
        activityType: 'taskAssigned',
        previewText: 'Email aldous@notalawfirm.example now',
        templateParameters: [],
        deepLinkPath: '/tasks/TSK-1',
        correlationId: 'corr-1',
      }),
    ).toThrow(/TEAMS_CONTENT_SCRUB_REJECTED/);

    expect(() =>
      sanitizeTeamsActivityPayload({
        idempotencyKey: 'k-3',
        recipientPersonId: 'P-000001',
        activityType: 'taskAssigned',
        previewText: 'A task was assigned.',
        templateParameters: [],
        deepLinkPath: 'https://evil.example/phish',
        correlationId: 'corr-1',
      }),
    ).toThrow(/TEAMS_DEEPLINK_FORBIDDEN/);

    const safeBuilt = buildSafeTeamsActivityFromNotification({
      tenantId: 's029-teams',
      notificationId: 'NTF-000011',
      recipientPersonId: 'P-000001',
      kind: 'approval_requested',
      href: '/matters/MAT-000555',
      recordId: 'MAT-000555',
      correlationId: 'corr-safe',
    });
    expect(safeBuilt.previewText).not.toContain('Confidential');
    expect(safeBuilt.deepLinkPath).toBe('/matters/MAT-000555');

    // 2. Empty allow-list fails closed in non-live
    const emptyAllowEval = await evaluateTeamsRecipientAllowList(
      ctx,
      { provider: 'dev_catcher', recipientAllowList: ['*', '@*'] },
      'P-000001',
    );
    expect(emptyAllowEval).toMatchObject({
      allowed: false,
      outcome: 'dropped_not_allow_listed',
    });

    // 3. dev_catcher HTTP delivery, unbound drop, leaver drop, allow-list block + zero-PII audit
    const baseRaw = getActiveTenantRawBaseConfig();
    const devCatcherCfg = loadAndValidateTenantConfig(baseRaw, {
      tenantId: 's029-teams',
      environment: 'test',
      integrations: {
        teams: {
          provider: 'dev_catcher',
          teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
          recipientAllowList: ['@notalawfirm.example'],
          devCatcher: { endpointUrl: catcher.endpointUrl },
        },
      },
    });
    const catcherNotifier = new CoreTeamsNotifier(devCatcherCfg);

    const unboundRes = await catcherNotifier.sendActivity(ctx, {
      ...safeBuilt,
      idempotencyKey: 'teams:unbound',
      recipientPersonId: 'P-000002',
    });
    expect(unboundRes.outcome).toBe('dropped_unbound');

    const leaverRes = await catcherNotifier.sendActivity(ctx, {
      ...safeBuilt,
      idempotencyKey: 'teams:leaver',
      recipientPersonId: 'P-000004',
    });
    expect(leaverRes.outcome).toBe('dropped_unbound');

    const blockedKey = `teams:blocked:${Date.now()}`;
    const blockedRes = await catcherNotifier.sendActivity(ctx, {
      ...safeBuilt,
      idempotencyKey: blockedKey,
      recipientPersonId: 'P-000003',
    });
    expect(blockedRes.outcome).toBe('dropped_not_allow_listed');
    const blockAudit = await auditRepo.listAuditEntriesForRecord(
      ctx,
      'teams_activity_outbox',
      blockedKey,
    );
    expect(blockAudit).toHaveLength(1);
    expect(blockAudit[0]!.action).toBe('teams-notification-dropped-allowlist');
    expect(JSON.stringify(blockAudit)).not.toContain('external.user@otherfirm.invalid');

    const sentCatcher = await catcherNotifier.sendActivity(ctx, safeBuilt);
    expect(sentCatcher).toMatchObject({ outcome: 'sent', providerRequestId: 'dc-1' });
    expect(catcher.captured).toHaveLength(1);
    expect(catcher.captured[0]!.body).toMatchObject({
      entraObjectId: 'oid-aldous-teams',
      activityType: 'approvalRequested',
      deepLinkPath: '/matters/MAT-000555',
      teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
    });

    // 4. Mocked Graph dispatch + Key Vault secret & allow-list + GraphAppTokenProvider RS256 assertion
    const secretReader: KeyVaultSecretReader = {
      readSecret: async (_c, ref) => {
        if (ref === 'kv://kv-s029-teams-test/graph-teams-client-cert') {
          return `${cert.certPem}\n${cert.privateKeyPem}`;
        }
        if (ref === 'kv://kv-s029-teams-test/teams-recipient-allowlist') {
          return JSON.stringify(['@notalawfirm.example']);
        }
        throw new Error(`Unexpected secret ref ${ref}`);
      },
    };
    const graphCalls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchMock: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      graphCalls.push({ url, init });
      if (url.includes('login.microsoftonline.com')) {
        return new Response(
          JSON.stringify({ access_token: 'mock-graph-token-alpha', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(null, { status: 204 });
    };

    const graphCfg = loadAndValidateTenantConfig(baseRaw, {
      tenantId: 's029-teams',
      environment: 'test',
      integrations: {
        teams: {
          provider: 'graph',
          teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
          recipientAllowListVaultRef: 'kv://kv-s029-teams-test/teams-recipient-allowlist',
          graph: {
            tenantId: 'f8218d9a-e055-463f-add2-f03679aad7f2',
            clientId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
            certificateVaultRef: 'kv://kv-s029-teams-test/graph-teams-client-cert',
            certificateThumbprint: cert.thumbprintHex,
          },
        },
      },
    });
    const tokenProvider = new GraphAppTokenProvider({
      secretReader,
      fetchFn: fetchMock,
    });
    const graphNotifier = new CoreTeamsNotifier(graphCfg, {
      secretReader,
      tokenProvider,
      fetchImpl: fetchMock,
    });

    const graphSent = await graphNotifier.sendActivity(ctx, {
      ...safeBuilt,
      idempotencyKey: 'teams:graph-1',
    });
    expect(graphSent.outcome).toBe('sent');
    const activityReq = graphCalls.find((c) => c.url.includes('/sendActivityNotification'));
    expect(activityReq?.url).toBe(
      'https://graph.microsoft.com/v1.0/users/oid-aldous-teams/teamwork/sendActivityNotification',
    );
    expect((activityReq?.init?.headers as Record<string, string>)?.authorization).toBe(
      'Bearer mock-graph-token-alpha',
    );
    const parsedGraphBody = JSON.parse(String(activityReq?.init?.body ?? '{}')) as {
      templateParameters?: unknown[];
    };
    expect(parsedGraphBody.templateParameters).toEqual([]);

    // Disabled TeamsNotifier throws TEAMS_PROVIDER_DISABLED
    const disabledNotifier = new CoreTeamsNotifier(
      loadAndValidateTenantConfig(baseRaw, { tenantId: 's029-teams', environment: 'test' }),
    );
    await expect(disabledNotifier.sendActivity(ctx, safeBuilt)).rejects.toThrow(
      TeamsIntegrationError,
    );
  });

  it('5. Outbox hook, shared outbox-drain (email + Teams retry -> failed_permanent -> scrub) & scheduled sweep', async () => {
    const ctx = await setupCleanMigratedTenant('s029-drain');
    const partyRepo = getPartyRepository();
    const outboxRepo = getOutboxRepository();
    const catcher = await startEphemeralHttpCatcher();
    activeClosers.push(catcher.close);

    const alice = makeEmployeeRecord({
      id: 'P-000001',
      firstName: 'Alice',
      surname: 'Drain',
      email: 'alice.drain@notalawfirm.example',
      entraObjectId: 'oid-alice-drain',
    });
    await partyRepo.putPerson(ctx, alice);

    const teamsActiveCfg: TenantConfiguration = loadAndValidateTenantConfig(
      getActiveTenantRawBaseConfig(),
      {
        tenantId: 's029-drain',
        environment: 'test',
        integrations: {
          email: { provider: 'disabled', outboxContentRetentionDays: 30 },
          teams: {
            provider: 'dev_catcher',
            teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
            recipientAllowList: ['@notalawfirm.example'],
            devCatcher: { endpointUrl: catcher.endpointUrl },
          },
        },
      },
    );

    // Not opted in -> teamsEnabled defaults false -> skipped
    const skippedEnqueue = await enqueueNotificationTeamsActivityIfEnabled(
      ctx,
      {
        id: 'NTF-500001',
        recipientId: 'P-000001',
        kind: 'task_assigned',
        title: 'Secret Matter Title',
        detail: 'Sensitive client detail',
        href: '/tasks/TSK-500',
        recordId: 'TSK-500',
        createdAt: '2026-04-02T09:00:00.000Z',
        read: false,
        byId: 'P-000002',
      },
      { tenantConfig: teamsActiveCfg, drainImmediately: false },
    );
    expect(skippedEnqueue).toBeNull();

    // Opt in -> enqueues scrubbed row into teams_activity_outbox
    await outboxRepo.upsertNotificationPreference(ctx, {
      personId: 'P-000001',
      notificationKind: 'task_assigned',
      teamsEnabled: true,
    });
    const enq = await enqueueNotificationTeamsActivityIfEnabled(
      ctx,
      {
        id: 'NTF-500002',
        recipientId: 'P-000001',
        kind: 'task_assigned',
        title: 'Project Falcon Secret Client',
        detail: 'Narrative must never appear in Teams',
        href: '/tasks/TSK-501',
        recordId: 'TSK-501',
        createdAt: '2026-04-02T09:01:00.000Z',
        read: false,
        byId: 'P-000002',
      },
      { tenantConfig: teamsActiveCfg, drainImmediately: false },
    );
    expect(enq).not.toBeNull();
    expect(enq?.previewText).not.toContain('Project Falcon');
    expect(enq?.previewText).not.toContain('Narrative');

    // Combined drain (email disabled + Teams dev_catcher enabled)
    // Use real wall-clock + 5s because enqueueNotificationTeamsActivityIfEnabled sets next_attempt_at = NOW().
    const drainRes = await drainOutboxForTenant(ctx, {
      tenantConfig: teamsActiveCfg,
      outboxRepository: outboxRepo,
      now: new Date(Date.now() + 5_000),
    });
    expect(drainRes.teams.sentCount).toBe(1);
    expect(catcher.captured).toHaveLength(1);

    // Retry -> failed_permanent -> 30-day scrub
    const failingNotifier: TeamsNotifier = {
      provider: 'dev_catcher',
      sendActivity: async () => {
        throw new Error('TEAMS_TRANSIENT_TIMEOUT: upstream timed out');
      },
    };
    let simNow = new Date('2026-04-03T10:00:00.000Z');
    const failingRow = await outboxRepo.enqueueTeamsActivity(ctx, {
      idempotencyKey: 'teams:fail-perm',
      recipientPersonId: 'P-000001',
      activityType: 'taskOverdue',
      previewText: 'A task is overdue.',
      templateParameters: [{ name: 'notificationKind', value: 'task_overdue' }],
      deepLinkPath: '/tasks/TSK-999',
      correlationId: 'corr-fail-perm',
      nextAttemptAt: simNow.toISOString(),
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const step = await drainTeamsOutboxForTenant(ctx, {
        tenantConfig: teamsActiveCfg,
        outboxRepository: outboxRepo,
        teamsNotifier: failingNotifier,
        now: simNow,
      });
      expect(step.retriedCount).toBe(1);
      expect(step.failedPermanentCount).toBe(0);
      simNow = new Date(simNow.getTime() + 3600_000);
    }

    const permStep = await drainTeamsOutboxForTenant(ctx, {
      tenantConfig: teamsActiveCfg,
      outboxRepository: outboxRepo,
      teamsNotifier: failingNotifier,
      now: simNow,
    });
    expect(permStep.failedPermanentCount).toBe(1);
    const failedRow = await outboxRepo.getTeamsOutboxRecordById(
      ctx,
      failingRow.record.id,
    );
    expect(failedRow?.status).toBe('failed_permanent');
    expect(failedRow?.attemptCount).toBe(5);

    const permTelemetry = getPlatformTelemetryRecorder()
      .getRecentEntries()
      .find(
        (e) =>
          e.kind === 'exception' &&
          e.eventName === 'outbox.delivery.failed_permanent' &&
          e.properties?.channel === 'teams',
      );
    expect(permTelemetry).toBeDefined();

    // Advance 31 days past both simNow and real wall clock -> scrub clears previewText & templateParameters on both rows
    const scrubNow = new Date(
      Math.max(simNow.getTime(), Date.now()) + 31 * 86_400_000,
    );
    const scrubRes = await drainTeamsOutboxForTenant(ctx, {
      tenantConfig: teamsActiveCfg,
      outboxRepository: outboxRepo,
      teamsNotifier: failingNotifier,
      now: scrubNow,
    });
    expect(scrubRes.scrubbedCount).toBeGreaterThanOrEqual(2);
    const scrubbedRow = await outboxRepo.getTeamsOutboxRecordById(
      ctx,
      failingRow.record.id,
    );
    expect(scrubbedRow?.previewText).toBeNull();
    expect(scrubbedRow?.templateParameters).toEqual([]);
    expect(scrubbedRow?.contentScrubbedAt).not.toBeNull();

    // Sweep runner covers both email + teams via outbox-drain
    const registry: TenantRegistry = {
      schemaVersion: '1.0.0',
      environment: 'test',
      hostingMode: 'multi_tenant',
      tenants: [
        {
          tenantId: 's029-drain',
          slug: 's029_drain',
          environment: 'test',
          postgresHost: 'localhost',
          postgresDatabaseName: 'pg_tenant_s029_drain_test',
          postgresRoleName: 'role_tenant_s029_drain_test',
          keyVaultUri: 'https://kv-s029-drain-test.vault.azure.net/',
          packageDir: 'client-not-a-law-firm',
          timeZone: 'Europe/London',
          enabled: true,
        },
      ],
    };
    const sweep = await runScheduledOutboxDrainJobSweep({
      registry,
      tenantConfigOverrideByTenantId: { 's029-drain': teamsActiveCfg },
    });
    expect(sweep.exitCode).toBe(0);
    expect(sweep.resultsByTenant['s029-drain']?.teams).toBeDefined();

    const digestSweep = await runScheduledNotificationDigestsJobSweep({
      registry,
      tenantConfigOverrideByTenantId: { 's029-drain': teamsActiveCfg },
      now: new Date('2026-04-05T09:00:00.000Z'), // Sunday skip
    });
    expect(digestSweep.exitCode).toBe(0);
    expect(digestSweep.skippedTenants[0]?.reason).toBe('outside_working_days');
  });

  it('6. Model B Two-Tenant Isolation across teams_activity_outbox, preferences, digest job, and Graph token cache', async () => {
    const ctxAlpha = await setupCleanMigratedTenant('s029-alpha');
    const ctxBravo = await setupCleanMigratedTenant('s029-bravo');
    const outboxRepo = getOutboxRepository();
    const partyRepo = getPartyRepository();
    const taskRepo = getTaskWorkflowRepository();

    const empAlpha = makeEmployeeRecord({
      id: 'P-000001',
      firstName: 'Alpha',
      surname: 'User',
      email: 'alpha@notalawfirm.example',
      entraObjectId: 'oid-alpha-001',
    });
    const empBravo = makeEmployeeRecord({
      id: 'P-000001',
      firstName: 'Bravo',
      surname: 'User',
      email: 'bravo@notalawfirm.example',
      entraObjectId: 'oid-bravo-001',
    });
    await partyRepo.putPerson(ctxAlpha, empAlpha);
    await partyRepo.putPerson(ctxBravo, empBravo);

    // Custom pref + Teams outbox + undigested notification on Alpha only
    await outboxRepo.upsertNotificationPreference(ctxAlpha, {
      personId: 'P-000001',
      notificationKind: 'task_comment',
      emailFrequency: 'weekly_digest',
      teamsEnabled: true,
      digestDayOfWeek: 4,
    });
    const alphaEnq = await outboxRepo.enqueueTeamsActivity(ctxAlpha, {
      idempotencyKey: 'alpha-only-teams',
      recipientPersonId: 'P-000001',
      activityType: 'taskComment',
      previewText: 'A comment was added in Alpha.',
      deepLinkPath: '/tasks/TSK-1',
      correlationId: 'corr-alpha',
    });
    await taskRepo.putNotification(ctxAlpha, {
      id: 'NTF-800001',
      recipientId: 'P-000001',
      kind: 'task_due_soon',
      title: 'Alpha Confidential Title',
      detail: 'Alpha detail',
      href: '/tasks/TSK-1',
      recordId: 'TSK-1',
      createdAt: '2026-04-06T06:00:00.000Z',
      read: false,
      byId: 'P-000002',
    });

    // Fresh reads on Bravo see zero Alpha preferences, zero Alpha Teams outbox rows, zero Alpha emails
    const bravoPref = await outboxRepo.getNotificationPreference(
      ctxBravo,
      'P-000001',
      'task_comment',
    );
    expect(bravoPref.emailFrequency).toBe('daily_digest');
    expect(bravoPref.teamsEnabled).toBe(false);
    expect(await outboxRepo.listTeamsOutboxRecords(ctxBravo)).toHaveLength(0);
    expect(
      await outboxRepo.getTeamsOutboxRecordById(ctxBravo, alphaEnq.record.id),
    ).toBeNull();

    // Digest job on Bravo compiles 0 Alpha items
    const bravoDigest = await executeNotificationDigestsForTenant(ctxBravo, {
      tenantConfig: loadAndValidateTenantConfig(getActiveTenantRawBaseConfig(), {
        tenantId: 's029-bravo',
        environment: 'test',
      }),
      now: new Date('2026-04-06T08:00:00.000Z'),
      drainAfterCommit: false,
    });
    expect(bravoDigest.outcome).toBe('executed');
    if (bravoDigest.outcome === 'executed') {
      expect(bravoDigest.result.undigestedExamined).toBe(0);
      expect(bravoDigest.result.digestEmailsQueued).toBe(0);
    }

    // Forged token claim targeting Bravo with Alpha context is rejected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000001',
          tenantId: 's029-alpha',
          name: 'Spoof',
          email: 'spoof@notalawfirm.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'single_tenant',
        environment: 'test',
        correlationId: 'corr-forged',
        untrustedRequestTenantOverride: 's029-bravo',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/);

    // Graph token cache isolation between Alpha and Bravo
    const cert = generateEphemeralSelfSignedCertAndKey('notalawfirm.example');
    const sharedProvider = new GraphAppTokenProvider({
      secretReader: {
        readSecret: async (c) => {
          expect(['s029-alpha', 's029-bravo']).toContain(c.tenantId);
          return `${cert.certPem}\n${cert.privateKeyPem}`;
        },
      },
      fetchFn: async (_url, init) => {
        const body = String(init?.body ?? '');
        const token = body.includes('client-alpha') ? 'tok-alpha' : 'tok-bravo';
        return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const tokAlpha = await sharedProvider.acquireAppToken(ctxAlpha, {
      tenantId: 'entra-alpha',
      clientId: 'client-alpha',
      certificateVaultRef: 'kv://kv-s029-alpha-test/teams-cert',
      certificateThumbprint: cert.thumbprintHex,
    });
    const tokBravo = await sharedProvider.acquireAppToken(ctxBravo, {
      tenantId: 'entra-bravo',
      clientId: 'client-bravo',
      certificateVaultRef: 'kv://kv-s029-bravo-test/teams-cert',
      certificateThumbprint: cert.thumbprintHex,
    });
    expect(tokAlpha).toBe('tok-alpha');
    expect(tokBravo).toBe('tok-bravo');
  });

  it('R499: Teams app-package manifest.json, icons, and teams:package zip include every activityType the notifier can post', () => {
    const pkgDir = path.join(
      process.cwd(),
      'core',
      'integrations',
      'teams',
      'app-package',
    );
    const manifestRaw = fs.readFileSync(
      path.join(pkgDir, 'manifest.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestRaw) as {
      $schema: string;
      manifestVersion: string;
      id: string;
      icons: { color: string; outline: string };
      webApplicationInfo?: { id: string; resource: string };
      activities?: {
        activityTypes?: Array<{
          type: string;
          description: string;
          templateText: string;
        }>;
      };
    };

    expect(manifest.$schema).toContain('/teams/v1.16/');
    expect(manifest.manifestVersion).toBe('1.16');
    expect(manifest.id).toBe('76474047-ac1f-49ee-83f3-5a2a58c2b3f8');
    expect(manifest.webApplicationInfo?.id).toBe(
      '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
    );
    expect(manifest.icons).toEqual({
      color: 'color.png',
      outline: 'outline.png',
    });

    const expectedActivityTypes = new Set(
      Object.values(SAFE_TEAMS_ACTIVITY_TYPE_BY_KIND),
    );
    const declaredTypes = new Map(
      (manifest.activities?.activityTypes ?? []).map((entry) => [
        entry.type,
        entry,
      ]),
    );
    expect(declaredTypes.size).toBe(expectedActivityTypes.size);
    for (const kind of ALL_NOTIFICATION_KINDS) {
      const built = buildSafeTeamsActivityFromNotification({
        tenantId: 'r499-contract',
        notificationId: `NTF-${kind}`,
        recipientPersonId: 'P-000001',
        kind,
        href: '/home',
        correlationId: `corr-${kind}`,
      });
      const entry = declaredTypes.get(built.activityType);
      expect(entry, `Missing activityType "${built.activityType}" in manifest.json`).toBeDefined();
      expect(entry!.description.length).toBeGreaterThan(0);
      expect(entry!.description.length).toBeLessThanOrEqual(128);
      expect(entry!.templateText).toContain('{actor}');
      expect(entry!.templateText.length).toBeLessThanOrEqual(128);
      const customPlaceholders = [...entry!.templateText.matchAll(/\{([^}]+)\}/g)]
        .map((m) => m[1])
        .filter((name) => name !== 'actor');
      expect(customPlaceholders).toEqual([]);
    }

    // PNG binary header + dimension checks (192x192 color, 32x32 white-on-transparent outline)
    const parsePngHeaderAndPixels = (pngBuf: Buffer) => {
      expect(pngBuf.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(pngBuf.subarray(12, 16).toString('ascii')).toBe('IHDR');
      const width = pngBuf.readUInt32BE(16);
      const height = pngBuf.readUInt32BE(20);
      const colorType = pngBuf[25];
      const idatChunks: Buffer[] = [];
      let pos = 8;
      while (pos < pngBuf.length) {
        const len = pngBuf.readUInt32BE(pos);
        const type = pngBuf.subarray(pos + 4, pos + 8).toString('ascii');
        if (type === 'IDAT') {
          idatChunks.push(pngBuf.subarray(pos + 8, pos + 8 + len));
        }
        pos += 12 + len;
      }
      return {
        width,
        height,
        colorType,
        rawScanlines: zlib.inflateSync(Buffer.concat(idatChunks)),
      };
    };

    const colorPng = parsePngHeaderAndPixels(
      fs.readFileSync(path.join(pkgDir, 'color.png')),
    );
    expect(colorPng.width).toBe(192);
    expect(colorPng.height).toBe(192);
    expect(colorPng.colorType).toBe(6);

    const outlinePng = parsePngHeaderAndPixels(
      fs.readFileSync(path.join(pkgDir, 'outline.png')),
    );
    expect(outlinePng.width).toBe(32);
    expect(outlinePng.height).toBe(32);
    expect(outlinePng.colorType).toBe(6);
    const stride = 1 + 32 * 4;
    let opaqueOutlinePixels = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const idx = y * stride + 1 + x * 4;
        const r = outlinePng.rawScanlines[idx];
        const g = outlinePng.rawScanlines[idx + 1];
        const b = outlinePng.rawScanlines[idx + 2];
        const a = outlinePng.rawScanlines[idx + 3];
        if (a > 0) {
          expect([r, g, b]).toEqual([255, 255, 255]);
          opaqueOutlinePixels += 1;
        }
      }
    }
    expect(opaqueOutlinePixels).toBeGreaterThan(50);

    // Run package script and verify ZIP has the 3 files at root (no folder prefixes)
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'package-teams-app.mjs')],
      { encoding: 'utf8' },
    );
    const zipPath = path.join(
      process.cwd(),
      'dist',
      'teams-app',
      'onesquared-teams-app.zip',
    );
    const zipBuf = fs.readFileSync(zipPath);
    const rootEntryNames: string[] = [];
    let zipCursor = 0;
    let extractedManifest: Buffer | null = null;
    while (zipCursor + 4 <= zipBuf.length && zipBuf.readUInt32LE(zipCursor) === 0x04034b50) {
      const compSize = zipBuf.readUInt32LE(zipCursor + 18);
      const nameLen = zipBuf.readUInt16LE(zipCursor + 26);
      const extraLen = zipBuf.readUInt16LE(zipCursor + 28);
      const name = zipBuf
        .subarray(zipCursor + 30, zipCursor + 30 + nameLen)
        .toString('utf8');
      expect(name).not.toContain('/');
      rootEntryNames.push(name);
      const dataStart = zipCursor + 30 + nameLen + extraLen;
      if (name === 'manifest.json') {
        extractedManifest = zlib.inflateRawSync(
          zipBuf.subarray(dataStart, dataStart + compSize),
        );
      }
      zipCursor = dataStart + compSize;
    }
    expect(rootEntryNames).toEqual(['manifest.json', 'color.png', 'outline.png']);
    expect(extractedManifest?.toString('utf8')).toBe(manifestRaw);
  });

  it('R646: dispatches approval_requested, approval_decided, and register_review_assigned notifications respecting preferences and restricted-matter isolation across two tenants', async () => {
    const ctxAlpha = await setupCleanMigratedTenant('s029-r646-alpha', 'test');
    const ctxBravo = await setupCleanMigratedTenant('s029-r646-bravo', 'test');
    const regRepo = new TenantRegisterRepository();
    await regRepo.clearTenantData(ctxAlpha);
    await regRepo.clearTenantData(ctxBravo);

    const baseRaw = getActiveTenantRawBaseConfig();
    const alphaOverlay = {
      tenantId: 's029-r646-alpha',
      environment: 'test' as const,
      integrations: {
        email: {
          provider: 'dev_catcher' as const,
          senderAddress: 'noreply@notalawfirm.example',
          recipientAllowList: ['@notalawfirm.example'],
          devCatcher: { host: '127.0.0.1', port: 1025, secure: false },
        },
        teams: {
          provider: 'dev_catcher' as const,
          teamsAppId: '76474047-ac1f-49ee-83f3-5a2a58c2b3f8',
          recipientAllowList: ['@notalawfirm.example'],
          devCatcher: { endpointUrl: 'http://127.0.0.1:1099/teams' },
        },
      },
    };
    const bravoOverlay = {
      ...alphaOverlay,
      tenantId: 's029-r646-bravo',
    };
    const alphaCfg = loadAndValidateTenantConfig(baseRaw, alphaOverlay);
    const bravoCfg = loadAndValidateTenantConfig(baseRaw, bravoOverlay);
    setActiveTenantConfigForTesting(baseRaw, alphaOverlay);

    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const taskRepo = getTaskWorkflowRepository();
    const outboxRepo = getOutboxRepository();

    const seedActors = async (ctx: TenantContext) => {
      await partyRepo.putPerson(
        ctx,
        makeEmployeeRecord({
          id: 'P-000001',
          firstName: 'Rhian',
          surname: 'Morgan',
          email: 'rhian.morgan@notalawfirm.example',
          roles: ['partner', 'fee_earner'],
          appRole: 'partner',
          entraObjectId: 'oid-r646-p1',
        }),
      );
      await partyRepo.putPerson(
        ctx,
        makeEmployeeRecord({
          id: 'P-000002',
          firstName: 'Dafydd',
          surname: 'Evans',
          email: 'dafydd.evans@notalawfirm.example',
          roles: ['fee_earner'],
          appRole: 'fee_earner',
          entraObjectId: 'oid-r646-p2',
        }),
      );
      await partyRepo.putPerson(
        ctx,
        makeEmployeeRecord({
          id: 'P-000005',
          firstName: 'Elin',
          surname: 'Davies',
          email: 'elin.davies@notalawfirm.example',
          roles: ['partner', 'risk_compliance'],
          appRole: 'partner',
          entraObjectId: 'oid-r646-p5',
        }),
      );
    };

    await seedActors(ctxAlpha);
    await seedActors(ctxBravo);

    await matterRepo.putMatter(ctxAlpha, {
      id: 'M-R646-PUB',
      matterNumber: 'PUB-2026-0001',
      title: 'Public Commercial Matter',
      description: 'Accessible matter for R646 notifications',
      clientId: 'ORG-1',
      statusId: 'matter_status.active',
      practiceAreaId: 'practice_area.dispute_resolution',
      teamId: 'TM-000001',
      responsiblePartnerId: 'P-000001',
      supervisingPartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000002',
      teamMemberIds: ['P-000001', 'P-000002', 'P-000005'],
      createdById: 'P-000001',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedById: 'P-000001',
      updatedAt: '2026-01-10T09:00:00.000Z',
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
    } as never);

    await matterRepo.putMatter(ctxAlpha, {
      id: 'M-R646-WALL',
      matterNumber: 'WAL-2026-0002',
      title: 'Restricted Ethical Wall Matter',
      description: 'Strictly accessible to P-000005 only',
      clientId: 'ORG-2',
      statusId: 'matter_status.active',
      practiceAreaId: 'practice_area.dispute_resolution',
      teamId: 'TM-000001',
      responsiblePartnerId: 'P-000005',
      supervisingPartnerId: 'P-000005',
      leadFeeEarnerId: 'P-000005',
      teamMemberIds: ['P-000005'],
      createdById: 'P-000005',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedById: 'P-000005',
      updatedAt: '2026-01-10T09:00:00.000Z',
      isStaffMatter: true,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-000005'],
    } as never);

    for (const pid of ['P-000001', 'P-000002', 'P-000005']) {
      for (const kind of [
        'approval_requested',
        'approval_decided',
        'register_review_assigned',
      ] as const) {
        await outboxRepo.upsertNotificationPreference(ctxAlpha, {
          personId: pid,
          notificationKind: kind,
          emailFrequency: 'immediate',
          teamsEnabled: true,
        });
      }
    }

    const actorCtx = (actorId: string, roles: string[]): TenantContext =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: actorId,
          tenantId: 's029-r646-alpha',
          name: actorId,
          email: `${actorId.toLowerCase()}@notalawfirm.example`,
          roles,
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: `corr-r646-${actorId}-${Date.now()}`,
      });

    // 1. approval_requested on create (sign_off -> P-000001)
    const signOffCreated = await runAsTestActor('P-000002', () =>
      createRegisterRecordService(
        {
          registerTypeKey: 'sign_off',
          title: 'R646 Accessible Write-off Sign-Off',
          matterId: 'M-R646-PUB',
          assignedApproverId: 'P-000001',
          fieldValues: { signOffKind: 'write_off', amountGbp: 500 },
        },
        'P-000002',
        {
          tenantCtx: actorCtx('P-000002', ['fee_earner']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(signOffCreated.ok).toBe(true);
    if (!signOffCreated.ok) throw new Error(signOffCreated.message);

    const p1NotifsAfterCreate = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000001');
    const reqNotif = p1NotifsAfterCreate.find(
      (n) => n.kind === 'approval_requested' && n.recordId === signOffCreated.record.id,
    );
    expect(reqNotif).toBeDefined();

    // 2. approval_decided on discuss & approve (sign_off -> P-000002)
    const discussed = await runAsTestActor('P-000001', () =>
      transitionRegisterRecordService(
        {
          recordId: signOffCreated.record.id,
          transitionKey: 'discuss',
          comment: 'Please check time ledger first',
          expectedRowVersion: signOffCreated.record.rowVersion,
        },
        'P-000001',
        {
          tenantCtx: actorCtx('P-000001', ['partner', 'fee_earner']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(discussed.ok).toBe(true);
    if (!discussed.ok) throw new Error(discussed.message);

    const approved = await runAsTestActor('P-000001', () =>
      transitionRegisterRecordService(
        {
          recordId: signOffCreated.record.id,
          transitionKey: 'approve',
          comment: 'Approved for billing',
          expectedRowVersion: discussed.record.rowVersion,
        },
        'P-000001',
        {
          tenantCtx: actorCtx('P-000001', ['partner', 'fee_earner']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(approved.ok).toBe(true);

    const p2NotifsAfterDecide = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000002');
    const decidedNotifs = p2NotifsAfterDecide.filter(
      (n) => n.kind === 'approval_decided' && n.recordId === signOffCreated.record.id,
    );
    expect(decidedNotifs.length).toBeGreaterThanOrEqual(2);

    // 3. register_review_assigned on create (P-000001) and update (P-000005)
    const complaintCreated = await runAsTestActor('P-000002', () =>
      createRegisterRecordService(
        {
          registerTypeKey: 'complaint',
          title: 'R646 Fee Complaint Review',
          matterId: 'M-R646-PUB',
          assignedApproverId: 'P-000001',
          reviewAt: '2026-06-20T09:00:00.000Z',
          fieldValues: {
            complainantName: 'Test Client',
            complaintSummary: 'Billing query requiring review',
          },
        },
        'P-000002',
        {
          tenantCtx: actorCtx('P-000002', ['fee_earner']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(complaintCreated.ok).toBe(true);
    if (!complaintCreated.ok) throw new Error(complaintCreated.message);

    const p1ReviewNotifs = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000001');
    expect(
      p1ReviewNotifs.some(
        (n) =>
          n.kind === 'register_review_assigned' && n.recordId === complaintCreated.record.id,
      ),
    ).toBe(true);

    const complaintReassigned = await runAsTestActor('P-000002', () =>
      updateRegisterRecordDetailsService(
        {
          recordId: complaintCreated.record.id,
          expectedRowVersion: complaintCreated.record.rowVersion,
          assignedApproverId: 'P-000005',
        },
        'P-000002',
        {
          tenantCtx: actorCtx('P-000002', ['fee_earner']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(complaintReassigned.ok).toBe(true);

    const p5ReviewNotifs = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000005');
    expect(
      p5ReviewNotifs.some(
        (n) =>
          n.kind === 'register_review_assigned' && n.recordId === complaintCreated.record.id,
      ),
    ).toBe(true);

    // Outbox verification for immediate + Teams preferences on accessible notifications
    const alphaOutboxCounts = await outboxRepo.withTenantReadTransaction(ctxAlpha, async (tx) => {
      const emailRes = await tx.query<{ template_key: string }>(
        `SELECT template_key FROM public.email_outbox WHERE tenant_id = $1`,
        [ctxAlpha.tenantId],
      );
      const teamsRes = await tx.query<{ recipient_person_id: string }>(
        `SELECT recipient_person_id FROM public.teams_activity_outbox WHERE tenant_id = $1`,
        [ctxAlpha.tenantId],
      );
      return {
        emailTemplates: emailRes.rows.map((r) => r.template_key),
        teamsRecipients: teamsRes.rows.map((r) => r.recipient_person_id),
      };
    });
    expect(alphaOutboxCounts.emailTemplates).toContain('notification.approval_requested');
    expect(alphaOutboxCounts.emailTemplates).toContain('notification.approval_decided');
    expect(alphaOutboxCounts.emailTemplates).toContain('notification.register_review_assigned');
    expect(alphaOutboxCounts.teamsRecipients).toContain('P-000001');
    expect(alphaOutboxCounts.teamsRecipients).toContain('P-000002');

    // 4. Restricted-matter negative controls: unpermitted P-000001 / P-000002 receive ZERO rows
    const walledSignOff = await runAsTestActor('P-000005', () =>
      createRegisterRecordService(
        {
          registerTypeKey: 'sign_off',
          title: 'Walled Sign-off Negative Control',
          matterId: 'M-R646-WALL',
          assignedApproverId: 'P-000001',
          fieldValues: { signOffKind: 'write_off', amountGbp: 999 },
        },
        'P-000005',
        {
          tenantCtx: actorCtx('P-000005', ['partner', 'risk_compliance']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(walledSignOff.ok).toBe(true);
    if (!walledSignOff.ok) throw new Error(walledSignOff.message);

    const walledComplaint = await runAsTestActor('P-000005', () =>
      createRegisterRecordService(
        {
          registerTypeKey: 'complaint',
          title: 'Walled Complaint Negative Control',
          matterId: 'M-R646-WALL',
          assignedApproverId: 'P-000002',
          reviewAt: '2026-06-25T09:00:00.000Z',
          fieldValues: {
            complainantName: 'Confidential Client',
            complaintSummary: 'Must not leak to P-000002',
          },
        },
        'P-000005',
        {
          tenantCtx: actorCtx('P-000005', ['partner', 'risk_compliance']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(walledComplaint.ok).toBe(true);
    if (!walledComplaint.ok) throw new Error(walledComplaint.message);

    const walledBreachId = await regRepo.allocateNextRecordId(ctxAlpha, { idPrefix: 'REG' });
    const walledBreachRef = await regRepo.allocateNextRecordId(ctxAlpha, { idPrefix: 'BRC' });
    await regRepo.createRegisterRecord(ctxAlpha, {
      id: walledBreachId,
      registerTypeKey: 'breach',
      reference: walledBreachRef,
      title: 'Walled Breach Decision Negative Control',
      status: 'logged',
      matterId: 'M-R646-WALL',
      ownerId: 'P-000002',
      assignedApproverId: 'P-000005',
      fieldValues: {
        regulatoryCategory: 'Confidentiality / Security',
        breachSummary: 'Walled breach incident for R646 negative control.',
      },
      createdById: 'P-000002',
    });
    const walledDecided = await runAsTestActor('P-000005', () =>
      transitionRegisterRecordService(
        {
          recordId: walledBreachId,
          transitionKey: 'close_breach',
          comment: 'Closed by COLP',
        },
        'P-000005',
        {
          tenantCtx: actorCtx('P-000005', ['partner', 'risk_compliance']),
          tenantConfig: alphaCfg,
        },
      ),
    );
    expect(walledDecided.ok).toBe(true);

    const p1AllNotifs = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000001');
    const p2AllNotifs = await taskRepo.listNotificationsForUser(ctxAlpha, 'P-000002');
    expect(p1AllNotifs.some((n) => n.recordId === walledSignOff.record.id)).toBe(false);
    expect(p2AllNotifs.some((n) => n.recordId === walledComplaint.record.id)).toBe(false);
    expect(p2AllNotifs.some((n) => n.recordId === walledBreachId)).toBe(false);

    const walledOutboxLeaks = await outboxRepo.withTenantReadTransaction(ctxAlpha, async (tx) => {
      const walledIds = [walledSignOff.record.id, walledComplaint.record.id, walledBreachId];
      const eRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.email_outbox WHERE tenant_id = $1 AND (subject ILIKE '%Walled%' OR text_body ~ $2)`,
        [ctxAlpha.tenantId, walledIds.join('|')],
      );
      const tRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.teams_activity_outbox WHERE tenant_id = $1 AND deep_link_path ~ $2`,
        [ctxAlpha.tenantId, walledIds.join('|')],
      );
      return Number(eRes.rows[0]?.count ?? 0) + Number(tRes.rows[0]?.count ?? 0);
    });
    expect(walledOutboxLeaks).toBe(0);

    // 5. Two-tenant isolation: Tenant Bravo has zero notifications or outbox rows from Alpha
    const bravoCounts = await outboxRepo.withTenantReadTransaction(ctxBravo, async (tx) => {
      const nRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.notifications WHERE tenant_id = $1`,
        [ctxBravo.tenantId],
      );
      const eRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.email_outbox WHERE tenant_id = $1`,
        [ctxBravo.tenantId],
      );
      const tRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.teams_activity_outbox WHERE tenant_id = $1`,
        [ctxBravo.tenantId],
      );
      return (
        Number(nRes.rows[0]?.count ?? 0) +
        Number(eRes.rows[0]?.count ?? 0) +
        Number(tRes.rows[0]?.count ?? 0)
      );
    });
    expect(bravoCounts).toBe(0);
    expect(bravoCfg.tenantId).toBe('s029-r646-bravo');
  });
});
