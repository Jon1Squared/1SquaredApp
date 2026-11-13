import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_JOB_ONLY_PERMISSION_KEYS,
  ALL_PERMISSION_KEYS,
  ALL_USER_PERMISSION_KEYS,
  AuthorisationError,
  DEFAULT_RBAC_ROLES,
  getPlatformTelemetryRecorder,
  loadAndValidateTenantConfig,
  PERMISSION_REGISTRY,
  resolvePermissions,
  type TenantConfiguration,
  type TenantRegistryEntry,
} from '@platform/core';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getAuditRepository,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getJobRunRepository,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import { getDefaultTenantRbacConfig } from '../../src/server/rbacRuntime';
import {
  runEnquiryRetentionAnonymisationForTenant,
  runScheduledEnquiryRetentionAnonymisationJobSweep,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
} from '../../src/server/services';
import { guardedAction, guardedJob } from '../../src/server/authorize';
import { anonymiseExpiredEnquiriesAction } from '../../src/app/actions';
import { executeCliJobRunner } from '../../scripts/run-job';
import {
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';
import { isActionDenied } from '../../src/domain/actionResult';
import type { Enquiry, EnquirySettings } from '../../src/domain/types';

function makeTestRegistryEntry(
  tenantId = 'not-a-law-firm',
  slug = 'not_a_law_firm',
  timeZone = 'Europe/London',
): TenantRegistryEntry {
  const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
  return {
    tenantId,
    slug,
    environment: 'test',
    postgresHost: host,
    postgresDatabaseName: `pg_tenant_${slug}_test`,
    postgresRoleName: `role_tenant_${slug}_test`,
    keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
    packageDir: 'client-not-a-law-firm',
    timeZone,
    enabled: true,
  };
}

async function runActionAsTestActor<R>(
  actorId: string,
  fn: () => Promise<R>,
  options?: { roles?: string[]; mfaVerified?: boolean },
): Promise<R> {
  setTestActorSession(actorId, options);
  try {
    return await runAsTestActor(actorId, fn, options);
  } finally {
    setTestActorSession(null);
  }
}

function makeTestEnquiry(
  id: string,
  overrides: Partial<Enquiry> = {},
): Enquiry {
  return {
    id,
    reference: id,
    receivedAt: '2024-01-10T10:00:00.000Z',
    takenById: 'P-000001',
    channelId: 'enquiry_channel.phone',
    firstName: 'Cordelia',
    lastName: 'Pemberton-Test',
    callingOnBehalfOf: 'Pemberton Invented Holdings Ltd',
    linkedOrganisationId: 'O-000001',
    email: 'cordelia.pemberton@invented-prospect.example',
    phone: '07700 900456',
    preferredContactMethodId: 'contact_method.email',
    bestTimeToCall: 'Morning',
    address: {
      id: `addr-${id}`,
      typeId: null,
      line1: '42 Invented Crescent',
      line2: 'Suite 4',
      town: 'Bristol',
      county: 'Avon',
      postcode: 'BS1 4AA',
      countryId: null,
    },
    practiceAreaId: 'work_type.commercial_property',
    workTypeSubcategoryId: null,
    summary: 'Commercial lease review enquiry',
    notes: 'Sensitive initial call notes about Cordelia Pemberton-Test at 42 Invented Crescent.',
    otherPartiesNamed: 'Counterparty Invented Estates Ltd',
    urgencyId: 'enquiry_urgency.standard',
    keyDate: null,
    keyDateLabel: '',
    sourceId: 'origin.website',
    referrerPersonId: null,
    privacyNoticeGiven: true,
    linkedPersonId: 'P-000001',
    assignedTeamId: 'TM-000001',
    assignedToId: 'P-000001',
    status: 'Declined',
    firstContactDueAt: '2024-01-11T10:00:00.000Z',
    nextActionDate: null,
    conflictStatus: 'Clear',
    conflictSnapshot: {
      recordedAt: '2024-01-10T10:00:00.000Z',
      recordedById: 'P-000001',
      searchedInput: {
        firstName: 'Cordelia',
        lastName: 'Pemberton-Test',
        callingOnBehalfOf: 'Pemberton Invented Holdings Ltd',
        otherPartiesNamed: 'Counterparty Invented Estates Ltd',
        email: 'cordelia.pemberton@invented-prospect.example',
        phone: '07700 900456',
        postcode: 'BS1 4AA',
        addressLine1: '42 Invented Crescent',
        addressLine2: 'Suite 4',
      },
      matchCount: 0,
      highestSeverity: 'none',
      conflictStatus: 'Clear',
      conflicts: [],
      knownPeople: [],
      knownOrganisations: [],
    },
    closeReasonId: 'enquiry_close_reason.declined_capacity',
    closeNotes: 'Closed after call with Cordelia Pemberton-Test.',
    referredToOrganisationId: null,
    convertedMatterId: null,
    contactLog: [
      {
        id: `cl-${id}`,
        at: '2024-01-10T11:00:00.000Z',
        method: 'Phone',
        outcome: 'Spoke',
        note: 'Spoke to Cordelia Pemberton-Test on 07700 900456',
        byId: 'P-000001',
      },
    ],
    customFields: {},
    anonymisedAt: null,
    createdById: 'P-000001',
    createdAt: '2024-01-10T10:00:00.000Z',
    updatedById: 'P-000001',
    updatedAt: '2024-01-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('S0-19b: Automated enquiry retention anonymisation job (ADR 0030, B3, R404, R412, R419)', () => {
  beforeEach(async () => {
    setActiveTenantConfigForTesting(null);
    setTestActorSession(null);
    const ctx = testTenantCtx('P-000001', {
      roles: ['admin', 'managing_partner'],
      mfaVerified: true,
    });
    await getJobRunRepository().clearTenantJobRuns(ctx);
  });

  describe('1. Job-only permission enquiry:run_retention_anonymise & guardedJob enforcement', () => {
    it('ensures no role (admin included) holds enquiry:run_retention_anonymise, rejects granting it via overrides/RBAC config/R477 DB rows, blocks interactive users from guardedJob, and records byId: system:enquiry-retention-anonymise on scheduled runs', async () => {
      expect(ALL_JOB_ONLY_PERMISSION_KEYS).toContain(
        'enquiry:run_retention_anonymise',
      );
      expect(PERMISSION_REGISTRY['enquiry:run_retention_anonymise']).toMatchObject({
        key: 'enquiry:run_retention_anonymise',
        domain: 'enquiry',
        module: 'enquiries',
        description: expect.stringContaining(
          'scheduled daily enquiry retention anonymisation job',
        ),
        sensitivity: 'critical',
        requiresMfa: false,
        jobOnly: true,
      });
      expect(ALL_USER_PERMISSION_KEYS).not.toContain(
        'enquiry:run_retention_anonymise',
      );

      // 1. No built-in role (including admin) holds enquiry:run_retention_anonymise
      for (const roleKey of ALL_BUILTIN_ROLE_KEYS) {
        expect(DEFAULT_RBAC_ROLES[roleKey].permissions).not.toContain(
          'enquiry:run_retention_anonymise',
        );
      }

      // 2. resolvePermissions and resolvePersonPermissionSet strip enquiry:run_retention_anonymise even if injected in config or overrides
      const baseConfig = loadAndValidateTenantConfig({
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        tenantId: 'not-a-law-firm',
      });
      const craftedConfig = {
        ...baseConfig,
        rbac: {
          ...getDefaultTenantRbacConfig(),
          roles: {
            ...getDefaultTenantRbacConfig().roles,
            admin: {
              ...getDefaultTenantRbacConfig().roles.admin,
              permissions: [...ALL_PERMISSION_KEYS],
            },
          },
        },
      } as unknown as TenantConfiguration;

      const resolvedAdmin = resolvePermissions({
        context: {
          tenantId: 'not-a-law-firm',
          correlationId: 'corr-enq-job-perm-admin',
          actorId: 'P-000001',
          actorRoles: ['admin'],
          mfaVerified: true,
        },
        actor: {
          userId: 'P-000001',
          roles: ['admin'],
          permissionOverrides: {
            grant: ['enquiry:run_retention_anonymise'],
            revoke: [],
          },
        },
        config: craftedConfig,
      });
      expect(resolvedAdmin.has('enquiry:run_retention_anonymise')).toBe(false);

      // 3. updatePersonPermissionOverrides refuses granting enquiry:run_retention_anonymise with FORBIDDEN
      const overrideAttempt = await runAsTestActor(
        'P-000001',
        async () =>
          updatePersonPermissionOverrides(
            'P-000002',
            {
              grant: ['enquiry:run_retention_anonymise'],
              revoke: [],
              reason: 'Attempted escalation to enquiry:run_retention_anonymise',
            },
            'P-000001',
            { mfaVerified: true },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(overrideAttempt.ok).toBe(false);
      expect(overrideAttempt.code).toBe('FORBIDDEN');

      // 4. updateTenantRbacConfig refuses granting enquiry:run_retention_anonymise in roles or departmentGrants with FORBIDDEN
      const rbacRoleAttempt = await runAsTestActor(
        'P-000001',
        async () =>
          updateTenantRbacConfig(
            {
              roles: {
                ...getDefaultTenantRbacConfig().roles,
                admin: {
                  ...getDefaultTenantRbacConfig().roles.admin,
                  permissions: [
                    ...ALL_USER_PERMISSION_KEYS,
                    'enquiry:run_retention_anonymise',
                  ],
                },
              },
            },
            'P-000001',
            { mfaVerified: true },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(rbacRoleAttempt.ok).toBe(false);
      expect(rbacRoleAttempt.code).toBe('FORBIDDEN');

      const rbacDeptAttempt = await runAsTestActor(
        'P-000001',
        async () =>
          updateTenantRbacConfig(
            {
              departmentGrants: {
                'DEPT-CORP': ['enquiry:run_retention_anonymise'],
              },
            },
            'P-000001',
            { mfaVerified: true },
          ),
        { roles: ['admin', 'managing_partner'], mfaVerified: true },
      );
      expect(rbacDeptAttempt.ok).toBe(false);
      expect(rbacDeptAttempt.code).toBe('FORBIDDEN');

      // 5. R477 per-request RBAC override path in buildGuardedActorContext strips enquiry:run_retention_anonymise even if persisted directly in PostgreSQL
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const hrRepo = getHrAndRbacRepository();
      const priorRbacOverride =
        await hrRepo.getRbacConfigOverrideWithVersion(ctx);
      try {
        await hrRepo.putRbacConfigOverride(
          ctx,
          {
            ...getDefaultTenantRbacConfig(),
            roles: {
              ...getDefaultTenantRbacConfig().roles,
              admin: {
                ...getDefaultTenantRbacConfig().roles.admin,
                permissions: [...ALL_PERMISSION_KEYS],
              },
            },
            departmentGrants: {
              'DEPT-EXEC': ['enquiry:run_retention_anonymise'],
            },
          },
          {
            updatedById: 'P-000001',
            updatedAt: new Date().toISOString(),
            expectedRowVersion: priorRbacOverride.rowVersion,
          },
        );

        setTestActorSession('P-000001', {
          roles: ['admin', 'managing_partner'],
          mfaVerified: true,
        });
        const actorCtx = await guardedAction(
          'runKeyDateReminderSchedulerAction',
          async (guardedActor) => guardedActor,
        );
        expect(actorCtx).not.toBeNull();
        expect(
          actorCtx.permissions.has('enquiry:run_retention_anonymise'),
        ).toBe(false);
      } finally {
        const currentRbac = await hrRepo.getRbacConfigOverrideWithVersion(ctx);
        await hrRepo.putRbacConfigOverride(ctx, priorRbacOverride.override, {
          updatedById: 'P-000001',
          updatedAt: new Date().toISOString(),
          expectedRowVersion: currentRbac.rowVersion,
        });
        setTestActorSession(null);
      }

      // 6. Interactive users cannot call guardedJob('enquiry-retention-anonymise', ...) or forge a scheduled run context
      const registry = {
        schemaVersion: '1.0.0' as const,
        environment: 'test' as const,
        hostingMode: 'single_tenant' as const,
        tenants: [makeTestRegistryEntry()],
      };
      await expect(
        guardedJob(
          'enquiry-retention-anonymise',
          'not-a-law-firm',
          async () => 'never-reached',
          {
            registry,
            overrideActorSub: 'P-000001',
          },
        ),
      ).rejects.toThrow(AuthorisationError);

      await expect(
        guardedJob(
          'enquiry-retention-anonymise',
          'not-a-law-firm',
          async () => 'never-reached',
          {
            registry,
            overrideJobPermissions: ['keydate:run_reminders'],
          },
        ),
      ).rejects.toThrow(AuthorisationError);

      await expect(
        runEnquiryRetentionAnonymisationForTenant(ctx, {
          triggerSource: 'scheduled',
          actorId: 'P-000001',
          nowIso: '2026-07-10T01:15:00.000Z',
        }),
      ).rejects.toThrow(AuthorisationError);

      // 7. Without an interactive override, guardedJob constructs synthetic actor system:enquiry-retention-anonymise holding only enquiry:run_retention_anonymise
      const jobActorInfo = await guardedJob(
        'enquiry-retention-anonymise',
        'not-a-law-firm',
        async ({ tenantContext }) => ({
          actorId: tenantContext.actorId,
          actorSub: tenantContext.actorSub,
          actorRoles: [...tenantContext.actorRoles],
          jobPermissions: [...(tenantContext.jobPermissions ?? [])],
        }),
        { registry },
      );
      expect(jobActorInfo).toEqual({
        actorId: 'system:enquiry-retention-anonymise',
        actorSub: 'system:enquiry-retention-anonymise',
        actorRoles: [],
        jobPermissions: ['enquiry:run_retention_anonymise'],
      });
    });
  });

  describe('2. B3 retention enforcement in BOTH scheduled & manual modes (all 5 cases)', () => {
    it('enforces isReadyForRetentionAnonymisation across all 5 B3 cases in both scheduled and manual modes, preserving reporting fields and scrubbing personal data + auditing in the same transaction', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const intakeRepo = getIntakeQuoteRepository();
      const catalogueRepo = getCatalogueRepository();
      const auditRepo = getAuditRepository();
      const jobRunRepo = getJobRunRepository();

      const priorSettings =
        await catalogueRepo.getEnquirySettingsConfig<EnquirySettings>(ctx);
      const priorEnquiries =
        await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);

      const nowIso = '2026-06-15T02:30:00.000Z'; // 03:30 BST (>= 02:00 local)
      // Retention = 12 months -> cutoff is 2025-06-15T02:30:00.000Z

      const seedFiveCases = async (prefix: string) => {
        // (a) Closed unconverted enquiry past retentionMonths -> MUST be anonymised + audited
        const caseAExpiredClosed = makeTestEnquiry(`${prefix}-A-EXPIRED`, {
          status: 'Declined',
          receivedAt: '2025-01-10T10:00:00.000Z',
          convertedMatterId: null,
          anonymisedAt: null,
        });
        // (b) Closed unconverted enquiry 1 day inside retentionMonths -> MUST remain untouched
        const caseBInsideCutoff = makeTestEnquiry(`${prefix}-B-INSIDE-1D`, {
          status: 'Referred out',
          receivedAt: '2025-06-16T10:00:00.000Z', // 1 day inside the 12-month cutoff
          convertedMatterId: null,
          anonymisedAt: null,
        });
        // (c) Converted enquiry past retentionMonths -> MUST remain untouched
        const caseCConverted = makeTestEnquiry(`${prefix}-C-CONVERTED`, {
          status: 'Converted',
          receivedAt: '2024-01-10T10:00:00.000Z',
          convertedMatterId: 'M-000001',
          anonymisedAt: null,
        });
        // (d) Open enquiry ('In contact') past retentionMonths -> MUST remain untouched
        const caseDOpen = makeTestEnquiry(`${prefix}-D-OPEN`, {
          status: 'In contact',
          receivedAt: '2024-01-10T10:00:00.000Z',
          convertedMatterId: null,
          anonymisedAt: null,
        });
        // (e) Already-anonymised enquiry past retentionMonths -> MUST be skipped
        const caseEAlreadyAnon = makeTestEnquiry(`${prefix}-E-ALREADY-ANON`, {
          status: 'No response',
          receivedAt: '2024-01-10T10:00:00.000Z',
          firstName: 'Anonymised',
          lastName: 'Enquirer',
          callingOnBehalfOf: '',
          email: '',
          phone: '',
          address: null,
          otherPartiesNamed: '',
          notes:
            '[Personal details removed under the firm data retention policy. Practice area, channel, dates and outcome retained for reporting.]',
          anonymisedAt: '2026-01-01T02:00:00.000Z',
        });

        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, [
          caseAExpiredClosed,
          caseBInsideCutoff,
          caseCConverted,
          caseDOpen,
          caseEAlreadyAnon,
        ]);

        return {
          caseAExpiredClosed,
          caseBInsideCutoff,
          caseCConverted,
          caseDOpen,
          caseEAlreadyAnon,
        };
      };

      try {
        await catalogueRepo.putEnquirySettingsConfig<EnquirySettings>(
          ctx,
          {
            ...(priorSettings ?? {
              emergencyHours: 4,
              urgentSameDayEnd: true,
              standardNextDayEnd: true,
              workDayStart: '09:00',
              workDayEnd: '17:30',
              workingDays: [1, 2, 3, 4, 5],
              failedAttemptsBeforeSuggestNoResponse: 3,
              retentionMonths: 12,
            }),
            retentionMonths: 12,
          },
          'P-000001',
        );

        // -------------------------------------------------------------------
        // Mode 1: Scheduled mode (runScheduledEnquiryRetentionAnonymisationJobSweep)
        // -------------------------------------------------------------------
        await jobRunRepo.clearTenantJobRuns(ctx);
        const scheduledCases = await seedFiveCases('ENQ-SCHED');
        const registry = {
          schemaVersion: '1.0.0' as const,
          environment: 'test' as const,
          hostingMode: 'single_tenant' as const,
          tenants: [makeTestRegistryEntry()],
        };

        const sweepSummary =
          await runScheduledEnquiryRetentionAnonymisationJobSweep({
            registry,
            nowIso,
          });
        expect(sweepSummary.exitCode).toBe(0);
        expect(sweepSummary.succeededTenants).toEqual(['not-a-law-firm']);

        // Verify Case (a): anonymised + audited with byId: 'system:enquiry-retention-anonymise'
        const schedAfterA = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          scheduledCases.caseAExpiredClosed.id,
          { includeRestricted: true },
        ))!;
        expect(schedAfterA.anonymisedAt).toBe(nowIso);
        expect(schedAfterA.firstName).toBe('Anonymised');
        expect(schedAfterA.lastName).toBe('Enquirer');
        expect(schedAfterA.callingOnBehalfOf).toBe('');
        expect(schedAfterA.email).toBe('');
        expect(schedAfterA.phone).toBe('');
        expect(schedAfterA.address).toBeNull();
        expect(schedAfterA.otherPartiesNamed).toBe('');
        expect(schedAfterA.closeNotes).toBe('');
        expect(schedAfterA.linkedPersonId).toBeNull();
        expect(schedAfterA.linkedOrganisationId).toBeNull();
        expect(schedAfterA.conflictSnapshot).toBeNull();
        expect(schedAfterA.contactLog.every((c) => c.note === '')).toBe(true);
        // Aggregate reporting fields preserved:
        expect(schedAfterA.practiceAreaId).toBe(
          'work_type.commercial_property',
        );
        expect(schedAfterA.channelId).toBe('enquiry_channel.phone');
        expect(schedAfterA.sourceId).toBe('origin.website');
        expect(schedAfterA.closeReasonId).toBe(
          'enquiry_close_reason.declined_capacity',
        );
        expect(schedAfterA.status).toBe('Declined');

        const schedAuditA = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          scheduledCases.caseAExpiredClosed.id,
        );
        const anonAuditsA = schedAuditA.filter(
          (a) => a.field === 'Privacy retention anonymisation',
        );
        expect(anonAuditsA).toHaveLength(1);
        expect(anonAuditsA[0]!.byId).toBe('system:enquiry-retention-anonymise');
        expect(JSON.stringify(anonAuditsA[0])).not.toContain('Cordelia');
        expect(JSON.stringify(anonAuditsA[0])).not.toContain('Pemberton-Test');
        expect(JSON.stringify(anonAuditsA[0])).not.toContain('07700 900456');

        // Verify Cases (b), (c), (d): untouched
        for (const untouchedId of [
          scheduledCases.caseBInsideCutoff.id,
          scheduledCases.caseCConverted.id,
          scheduledCases.caseDOpen.id,
        ]) {
          const enqAfter = (await intakeRepo.getEnquiryById<Enquiry>(
            ctx,
            untouchedId,
            { includeRestricted: true },
          ))!;
          expect(enqAfter.anonymisedAt).toBeNull();
          expect(enqAfter.firstName).toBe('Cordelia');
          expect(enqAfter.lastName).toBe('Pemberton-Test');
          expect(enqAfter.email).toBe(
            'cordelia.pemberton@invented-prospect.example',
          );
          const audits = await auditRepo.listAuditEntriesForRecord(
            ctx,
            'enquiry',
            untouchedId,
          );
          expect(
            audits.filter((a) => a.field === 'Privacy retention anonymisation'),
          ).toHaveLength(0);
        }

        // Verify Case (e): already-anonymised enquiry skipped (anonymisedAt unchanged, zero new audit entries)
        const schedAfterE = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          scheduledCases.caseEAlreadyAnon.id,
          { includeRestricted: true },
        ))!;
        expect(schedAfterE.anonymisedAt).toBe('2026-01-01T02:00:00.000Z');
        const schedAuditE = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          scheduledCases.caseEAlreadyAnon.id,
        );
        expect(
          schedAuditE.filter(
            (a) => a.field === 'Privacy retention anonymisation',
          ),
        ).toHaveLength(0);

        // -------------------------------------------------------------------
        // Mode 2: Manual mode (anonymiseExpiredEnquiriesAction — bulk & single)
        // -------------------------------------------------------------------
        await jobRunRepo.clearTenantJobRuns(ctx);
        const manualCases = await seedFiveCases('ENQ-MAN');

        // Even when specificEnquiryId is explicitly passed for (b), (c), (d), or (e), B3 refuses to anonymise them!
        for (const ineligibleId of [
          manualCases.caseBInsideCutoff.id,
          manualCases.caseCConverted.id,
          manualCases.caseDOpen.id,
          manualCases.caseEAlreadyAnon.id,
        ]) {
          const singleRes = await runActionAsTestActor(
            'P-000003',
            async () =>
              anonymiseExpiredEnquiriesAction(ineligibleId, { nowIso }),
            { roles: ['risk_compliance'], mfaVerified: true },
          );
          expect(isActionDenied(singleRes)).toBe(false);
          if (!isActionDenied(singleRes)) {
            expect(singleRes.count).toBe(0);
          }
        }

        // Bulk manual run anonymises ONLY Case (a) and leaves (b), (c), (d), (e) untouched/skipped
        const bulkRes = await runActionAsTestActor(
          'P-000003',
          async () => anonymiseExpiredEnquiriesAction(undefined, { nowIso }),
          { roles: ['risk_compliance'], mfaVerified: true },
        );
        expect(isActionDenied(bulkRes)).toBe(false);
        if (!isActionDenied(bulkRes)) {
          expect(bulkRes.count).toBe(1);
        }

        const manAfterA = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          manualCases.caseAExpiredClosed.id,
          { includeRestricted: true },
        ))!;
        expect(manAfterA.anonymisedAt).toBe(nowIso);
        expect(manAfterA.firstName).toBe('Anonymised');
        expect(manAfterA.lastName).toBe('Enquirer');

        const manAuditA = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          manualCases.caseAExpiredClosed.id,
        );
        const manAnonAuditsA = manAuditA.filter(
          (a) => a.field === 'Privacy retention anonymisation',
        );
        expect(manAnonAuditsA).toHaveLength(1);
        expect(manAnonAuditsA[0]!.byId).toBe('P-000003');

        for (const untouchedId of [
          manualCases.caseBInsideCutoff.id,
          manualCases.caseCConverted.id,
          manualCases.caseDOpen.id,
        ]) {
          const enqAfter = (await intakeRepo.getEnquiryById<Enquiry>(
            ctx,
            untouchedId,
            { includeRestricted: true },
          ))!;
          expect(enqAfter.anonymisedAt).toBeNull();
          expect(enqAfter.firstName).toBe('Cordelia');
        }
      } finally {
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, priorEnquiries);
        if (priorSettings) {
          await catalogueRepo.putEnquirySettingsConfig(
            ctx,
            priorSettings,
            'P-000001',
          );
        }
        await jobRunRepo.clearTenantJobRuns(ctx);
      }
    });
  });

  describe('3. Manual buttons record in job_runs (R412) & single vs bulk scope semantics', () => {
    it('records trigger_source = manual in job_runs for both single and bulk manual runs; single-enquiry manual run does NOT suppress the daily scheduled sweep, whereas bulk manual run DOES satisfy that local_date check', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const intakeRepo = getIntakeQuoteRepository();
      const catalogueRepo = getCatalogueRepository();
      const jobRunRepo = getJobRunRepository();

      const priorSettings =
        await catalogueRepo.getEnquirySettingsConfig<EnquirySettings>(ctx);
      const priorEnquiries =
        await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);

      try {
        await catalogueRepo.putEnquirySettingsConfig<EnquirySettings>(
          ctx,
          {
            ...(priorSettings ?? {
              emergencyHours: 4,
              urgentSameDayEnd: true,
              standardNextDayEnd: true,
              workDayStart: '09:00',
              workDayEnd: '17:30',
              workingDays: [1, 2, 3, 4, 5],
              failedAttemptsBeforeSuggestNoResponse: 3,
              retentionMonths: 12,
            }),
            retentionMonths: 12,
          },
          'P-000001',
        );

        const exp1 = makeTestEnquiry('ENQ-SCOPE-EXP-1', {
          status: 'Declined',
          receivedAt: '2024-03-01T10:00:00.000Z',
        });
        const exp2 = makeTestEnquiry('ENQ-SCOPE-EXP-2', {
          status: 'No response',
          receivedAt: '2024-04-01T10:00:00.000Z',
        });
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, [exp1, exp2]);
        await jobRunRepo.clearTenantJobRuns(ctx);

        // 1. Unauthorized actor (fee_earner without enquiry:anonymise) is denied and writes 0 job_runs rows
        const deniedRes = await runActionAsTestActor(
          'P-000002',
          async () => anonymiseExpiredEnquiriesAction(exp1.id),
          { roles: ['fee_earner'], mfaVerified: false },
        );
        expect(isActionDenied(deniedRes)).toBe(true);
        if (isActionDenied(deniedRes)) {
          expect(deniedRes.code).toBe('FORBIDDEN');
        }
        expect(
          await jobRunRepo.listJobRuns(ctx, {
            jobKey: 'enquiry-retention-anonymise',
          }),
        ).toHaveLength(0);

        // 2. Single-enquiry manual run on 2026-07-10 anonymises exp1 and writes trigger_source = 'manual', scope = 'single'
        const day1ManualNowIso = '2026-07-10T01:15:00.000Z'; // 02:15 BST -> local_date 2026-07-10
        const singleRes = await runActionAsTestActor(
          'P-000003',
          async () =>
            anonymiseExpiredEnquiriesAction(exp1.id, {
              nowIso: day1ManualNowIso,
            }),
          { roles: ['risk_compliance'], mfaVerified: true },
        );
        expect(isActionDenied(singleRes)).toBe(false);
        if (!isActionDenied(singleRes)) {
          expect(singleRes.count).toBe(1);
        }

        let runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.triggerSource).toBe('manual');
        expect(runs[0]!.triggeredById).toBe('P-000003');
        expect(runs[0]!.status).toBe('succeeded');
        expect(runs[0]!.localDate).toBe('2026-07-10');
        expect(runs[0]!.summary).toEqual({
          evaluatedCount: 1,
          anonymisedCount: 1,
          retentionMonths: 12,
          scope: 'single',
        });

        // 3. Subsequent scheduled tick on the SAME local_date (2026-07-10) is NOT suppressed by the single-enquiry manual run -> anonymises remaining exp2!
        const registry = {
          schemaVersion: '1.0.0' as const,
          environment: 'test' as const,
          hostingMode: 'single_tenant' as const,
          tenants: [makeTestRegistryEntry()],
        };
        const day1ScheduledNowIso = '2026-07-10T02:15:00.000Z'; // 03:15 BST -> local_date 2026-07-10
        const sweepDay1 =
          await runScheduledEnquiryRetentionAnonymisationJobSweep({
            registry,
            nowIso: day1ScheduledNowIso,
          });
        expect(sweepDay1.exitCode).toBe(0);
        expect(sweepDay1.succeededTenants).toEqual(['not-a-law-firm']);

        const exp2After = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          exp2.id,
          { includeRestricted: true },
        ))!;
        expect(exp2After.anonymisedAt).toBe(day1ScheduledNowIso);

        runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(2);
        const scheduledRunDay1 = runs.find(
          (r) => r.triggerSource === 'scheduled',
        )!;
        expect(scheduledRunDay1.triggeredById).toBe(
          'system:enquiry-retention-anonymise',
        );
        expect(scheduledRunDay1.summary).toEqual({
          evaluatedCount: 2,
          anonymisedCount: 1,
          retentionMonths: 12,
          scope: 'bulk',
        });

        // 4. On local_date 2026-07-11, run a BULK manual run first -> subsequent scheduled tick on 2026-07-11 skips cleanly (already_succeeded_today)
        const exp3 = makeTestEnquiry('ENQ-SCOPE-EXP-3', {
          status: 'Declined',
          receivedAt: '2024-05-01T10:00:00.000Z',
        });
        await intakeRepo.putEnquiry(ctx, exp3);

        const day2ManualBulkNowIso = '2026-07-11T01:10:00.000Z'; // 02:10 BST -> local_date 2026-07-11
        const bulkRes = await runActionAsTestActor(
          'P-000003',
          async () =>
            anonymiseExpiredEnquiriesAction(undefined, {
              nowIso: day2ManualBulkNowIso,
            }),
          { roles: ['risk_compliance'], mfaVerified: true },
        );
        expect(isActionDenied(bulkRes)).toBe(false);
        if (!isActionDenied(bulkRes)) {
          expect(bulkRes.count).toBe(1);
        }

        const day2ScheduledNowIso = '2026-07-11T02:10:00.000Z'; // 03:10 BST -> local_date 2026-07-11
        const sweepDay2 =
          await runScheduledEnquiryRetentionAnonymisationJobSweep({
            registry,
            nowIso: day2ScheduledNowIso,
          });
        expect(sweepDay2.exitCode).toBe(0);
        expect(sweepDay2.skippedTenants).toEqual([
          {
            tenantId: 'not-a-law-firm',
            status: 'skipped',
            reason: 'already_succeeded_today',
          },
        ]);

        // Also verify before_target_hour on local_date 2026-07-12 before 02:00 local time
        const day3Before2amIso = '2026-07-12T00:15:00.000Z'; // 01:15 BST (< 02:00 local)
        const sweepDay3Early =
          await runScheduledEnquiryRetentionAnonymisationJobSweep({
            registry,
            nowIso: day3Before2amIso,
          });
        expect(sweepDay3Early.exitCode).toBe(0);
        expect(sweepDay3Early.skippedTenants).toEqual([
          {
            tenantId: 'not-a-law-firm',
            status: 'skipped',
            reason: 'before_window',
          },
        ]);
      } finally {
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, priorEnquiries);
        if (priorSettings) {
          await catalogueRepo.putEnquirySettingsConfig(
            ctx,
            priorSettings,
            'P-000001',
          );
        }
        await jobRunRepo.clearTenantJobRuns(ctx);
      }
    });
  });

  describe('4. Concurrent scheduled + manual lock contention (Promise.all) & two isolated module graphs (vi.resetModules())', () => {
    it('ensures a scheduled run and a manual bulk anonymiseExpiredEnquiriesAction started together (Promise.all) contend on pg_try_advisory_xact_lock and anonymise/audit each eligible enquiry exactly once', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const intakeRepo = getIntakeQuoteRepository();
      const catalogueRepo = getCatalogueRepository();
      const auditRepo = getAuditRepository();
      const jobRunRepo = getJobRunRepository();

      const priorSettings =
        await catalogueRepo.getEnquirySettingsConfig<EnquirySettings>(ctx);
      const priorEnquiries =
        await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);

      try {
        await catalogueRepo.putEnquirySettingsConfig<EnquirySettings>(
          ctx,
          {
            ...(priorSettings ?? {
              emergencyHours: 4,
              urgentSameDayEnd: true,
              standardNextDayEnd: true,
              workDayStart: '09:00',
              workDayEnd: '17:30',
              workingDays: [1, 2, 3, 4, 5],
              failedAttemptsBeforeSuggestNoResponse: 3,
              retentionMonths: 12,
            }),
            retentionMonths: 12,
          },
          'P-000001',
        );

        const targetEnq = makeTestEnquiry('ENQ-CONCURRENT-PROMISE-ALL', {
          status: 'Declined',
          receivedAt: '2024-02-01T10:00:00.000Z',
        });
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, [targetEnq]);
        await jobRunRepo.clearTenantJobRuns(ctx);

        let releaseHold!: () => void;
        const holdPromise = new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
        let enteredScheduledTx!: () => void;
        const enteredScheduledPromise = new Promise<void>((resolve) => {
          enteredScheduledTx = resolve;
        });

        const nowIso = '2026-08-15T02:05:00.000Z';
        const registry = {
          schemaVersion: '1.0.0' as const,
          environment: 'test' as const,
          hostingMode: 'single_tenant' as const,
          tenants: [makeTestRegistryEntry()],
        };

        const scheduledPromise = guardedJob(
          'enquiry-retention-anonymise',
          'not-a-law-firm',
          async ({ tenantContext }) =>
            runEnquiryRetentionAnonymisationForTenant(tenantContext, {
              triggerSource: 'scheduled',
              actorId: 'system:enquiry-retention-anonymise',
              nowIso,
              onAfterWorkBeforeCommit: async () => {
                enteredScheduledTx();
                await holdPromise;
              },
            }),
          { registry },
        );

        await enteredScheduledPromise;

        // Start manual bulk anonymiseExpiredEnquiriesAction while scheduled run holds pg_try_advisory_xact_lock
        const manualPromise = runActionAsTestActor(
          'P-000003',
          async () => {
            try {
              return await anonymiseExpiredEnquiriesAction(undefined, {
                nowIso,
              });
            } finally {
              releaseHold();
            }
          },
          { roles: ['risk_compliance'], mfaVerified: true },
        );

        const [scheduledOutcome, manualRes] = await Promise.all([
          scheduledPromise,
          manualPromise,
        ]);

        expect(scheduledOutcome.outcome).toBe('executed');
        expect(isActionDenied(manualRes)).toBe(false);
        if (!isActionDenied(manualRes)) {
          // Manual run saw advisory lock held and returned 0 without duplicate work
          expect(manualRes.count).toBe(0);
        }

        // Enquiry was anonymised and audited EXACTLY ONCE
        const afterEnq = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          targetEnq.id,
          { includeRestricted: true },
        ))!;
        expect(afterEnq.anonymisedAt).toBe(nowIso);
        const audits = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          targetEnq.id,
        );
        const anonAudits = audits.filter(
          (a) => a.field === 'Privacy retention anonymisation',
        );
        expect(anonAudits).toHaveLength(1);

        const runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.summary.anonymisedCount).toBe(1);
      } finally {
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, priorEnquiries);
        if (priorSettings) {
          await catalogueRepo.putEnquirySettingsConfig(
            ctx,
            priorSettings,
            'P-000001',
          );
        }
        await jobRunRepo.clearTenantJobRuns(ctx);
      }
    });

    it('synchronises two separate processes (vi.resetModules()) running enquiry-retention-anonymise for the same tenant via PostgreSQL pg_try_advisory_xact_lock and job_runs with zero in-process state (Lessons 1 & 2)', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const intakeRepo = getIntakeQuoteRepository();
      const catalogueRepo = getCatalogueRepository();
      const jobRunRepo = getJobRunRepository();

      const priorSettings =
        await catalogueRepo.getEnquirySettingsConfig<EnquirySettings>(ctx);
      const priorEnquiries =
        await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);

      try {
        await catalogueRepo.putEnquirySettingsConfig<EnquirySettings>(
          ctx,
          {
            ...(priorSettings ?? {
              emergencyHours: 4,
              urgentSameDayEnd: true,
              standardNextDayEnd: true,
              workDayStart: '09:00',
              workDayEnd: '17:30',
              workingDays: [1, 2, 3, 4, 5],
              failedAttemptsBeforeSuggestNoResponse: 3,
              retentionMonths: 12,
            }),
            retentionMonths: 12,
          },
          'P-000001',
        );
        const targetEnq = makeTestEnquiry('ENQ-TWO-PROCESSES-1', {
          status: 'Declined',
          receivedAt: '2024-01-15T10:00:00.000Z',
        });
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, [targetEnq]);
        await jobRunRepo.clearTenantJobRuns(ctx);

        const modA = await import('../../src/server/services');
        const authA = await import('../../src/server/authorize');
        vi.resetModules();
        const modB = await import('../../src/server/services');
        const authB = await import('../../src/server/authorize');
        expect(modA.runEnquiryRetentionAnonymisationForTenant).not.toBe(
          modB.runEnquiryRetentionAnonymisationForTenant,
        );

        let releaseHoldA!: () => void;
        const holdPromiseA = new Promise<void>((resolve) => {
          releaseHoldA = resolve;
        });
        let enteredWorkA!: () => void;
        const enteredPromiseA = new Promise<void>((resolve) => {
          enteredWorkA = resolve;
        });

        const nowIso = '2026-08-20T02:10:00.000Z';
        const registry = {
          schemaVersion: '1.0.0' as const,
          environment: 'test' as const,
          hostingMode: 'single_tenant' as const,
          tenants: [makeTestRegistryEntry()],
        };

        // Process A starts and holds the transaction advisory lock in PostgreSQL
        const runAPromise = authA.guardedJob(
          'enquiry-retention-anonymise',
          'not-a-law-firm',
          async ({ tenantContext }) =>
            modA.runEnquiryRetentionAnonymisationForTenant(tenantContext, {
              triggerSource: 'scheduled',
              actorId: 'system:enquiry-retention-anonymise',
              nowIso,
              onAfterWorkBeforeCommit: async () => {
                enteredWorkA();
                await holdPromiseA;
              },
            }),
          { registry },
        );

        try {
          await enteredPromiseA;

          // Process B (isolated module graph) runs while Process A holds the PostgreSQL lock -> returns already_running
          const outBWhileRunning = await authB.guardedJob(
            'enquiry-retention-anonymise',
            'not-a-law-firm',
            async ({ tenantContext }) =>
              modB.runEnquiryRetentionAnonymisationForTenant(tenantContext, {
                triggerSource: 'scheduled',
                actorId: 'system:enquiry-retention-anonymise',
                nowIso,
              }),
            { registry },
          );
          expect(outBWhileRunning.outcome).toBe('already_running');

          // Release Process A so it commits enquiries + audit_entries + job_runs together
          releaseHoldA();
          const outA = await runAPromise;
          expect(outA.outcome).toBe('executed');

          // Process B runs again after Process A commits -> sees job_runs succeeded row in PostgreSQL and skips (already_succeeded_today)
          const outBAfterCommit = await authB.guardedJob(
            'enquiry-retention-anonymise',
            'not-a-law-firm',
            async ({ tenantContext }) =>
              modB.runEnquiryRetentionAnonymisationForTenant(tenantContext, {
                triggerSource: 'scheduled',
                actorId: 'system:enquiry-retention-anonymise',
                nowIso,
              }),
            { registry },
          );
          expect(outBAfterCommit.outcome).toBe('already_succeeded_today');
        } finally {
          releaseHoldA();
          await runAPromise.catch(() => {});
        }

        const runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe('succeeded');
        expect(runs[0]!.summary.anonymisedCount).toBe(1);
      } finally {
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, priorEnquiries);
        if (priorSettings) {
          await catalogueRepo.putEnquirySettingsConfig(
            ctx,
            priorSettings,
            'P-000001',
          );
        }
        await jobRunRepo.clearTenantJobRuns(ctx);
      }
    });
  });

  describe('5. Retry after failure, transactional rollback, CLI runner & zero PII in job_runs / audit_entries / telemetry', () => {
    it('rolls back both enquiries updates and audit_entries on failure, writes status = failed in job_runs, retries on the next hourly tick, and emits zero PII in job_runs, audit_entries, or telemetry', async () => {
      const ctx = testTenantCtx('P-000001', {
        roles: ['admin', 'managing_partner'],
        mfaVerified: true,
      });
      const intakeRepo = getIntakeQuoteRepository();
      const catalogueRepo = getCatalogueRepository();
      const auditRepo = getAuditRepository();
      const jobRunRepo = getJobRunRepository();
      const telemetry = getPlatformTelemetryRecorder();

      const priorSettings =
        await catalogueRepo.getEnquirySettingsConfig<EnquirySettings>(ctx);
      const priorEnquiries =
        await intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx);

      try {
        await catalogueRepo.putEnquirySettingsConfig<EnquirySettings>(
          ctx,
          {
            ...(priorSettings ?? {
              emergencyHours: 4,
              urgentSameDayEnd: true,
              standardNextDayEnd: true,
              workDayStart: '09:00',
              workDayEnd: '17:30',
              workingDays: [1, 2, 3, 4, 5],
              failedAttemptsBeforeSuggestNoResponse: 3,
              retentionMonths: 12,
            }),
            retentionMonths: 12,
          },
          'P-000001',
        );

        const sensitiveEnq = makeTestEnquiry('ENQ-ROLLBACK-ZERO-PII', {
          status: 'Declined',
          receivedAt: '2024-01-10T10:00:00.000Z',
          firstName: 'SecretProspectFirstName',
          lastName: 'SecretProspectLastName',
          callingOnBehalfOf: 'SecretCompanyHoldingsLtd',
          email: 'secret.prospect@invented-domain.example',
          phone: '07700 999888',
          notes: 'Confidential prospect notes with 07700 999888',
        });
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, [sensitiveEnq]);
        await jobRunRepo.clearTenantJobRuns(ctx);
        telemetry.clearForTesting();

        const registry = {
          schemaVersion: '1.0.0' as const,
          environment: 'test' as const,
          hostingMode: 'single_tenant' as const,
          tenants: [makeTestRegistryEntry()],
        };
        const tick1NowIso = '2026-09-10T01:15:00.000Z'; // 02:15 BST on 2026-09-10

        // 1. Force a failure AFTER enquiries update and audit_entries insert inside the transaction
        await expect(
          guardedJob(
            'enquiry-retention-anonymise',
            'not-a-law-firm',
            async ({ tenantContext }) =>
              runEnquiryRetentionAnonymisationForTenant(tenantContext, {
                triggerSource: 'scheduled',
                actorId: 'system:enquiry-retention-anonymise',
                nowIso: tick1NowIso,
                onAfterWorkBeforeCommit: async () => {
                  const err = new Error(
                    'Simulated database failure for <secret.prospect@invented-domain.example>',
                  ) as Error & { code?: string };
                  err.code = 'SIMULATED_ANONYMISE_TX_FAILURE';
                  throw err;
                },
              }),
            { registry },
          ),
        ).rejects.toThrow(/Simulated database failure/);

        // Verify BOTH the enquiry update AND the audit_entries insert rolled back!
        const enqAfterRollback = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          sensitiveEnq.id,
          { includeRestricted: true },
        ))!;
        expect(enqAfterRollback.anonymisedAt).toBeNull();
        expect(enqAfterRollback.firstName).toBe('SecretProspectFirstName');
        expect(enqAfterRollback.lastName).toBe('SecretProspectLastName');
        expect(enqAfterRollback.email).toBe(
          'secret.prospect@invented-domain.example',
        );

        const auditsAfterRollback = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          sensitiveEnq.id,
        );
        expect(
          auditsAfterRollback.filter(
            (a) => a.field === 'Privacy retention anonymisation',
          ),
        ).toHaveLength(0);

        // Verify a status = 'failed' row was recorded in job_runs with errorCode only (zero error message / PII)
        let runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe('failed');
        expect(runs[0]!.errorCode).toBe('SIMULATED_ANONYMISE_TX_FAILURE');
        expect(JSON.stringify(runs[0])).not.toContain(
          'secret.prospect@invented-domain.example',
        );
        expect(JSON.stringify(runs[0])).not.toContain('7700 999888');

        // 2. Next hourly tick on the SAME local_date retries via CLI runner and succeeds!
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        const exitCode = await executeCliJobRunner(
          [
            'node',
            'dist/jobs/run-job.mjs',
            'enquiry-retention-anonymise',
            '--now',
            '2026-09-10T02:15:00.000Z',
          ],
          {
            stdout: (line) => stdoutLines.push(line),
            stderr: (line) => stderrLines.push(line),
          },
        );
        expect(exitCode).toBe(0);
        expect(stderrLines).toHaveLength(0);

        const enqAfterRetry = (await intakeRepo.getEnquiryById<Enquiry>(
          ctx,
          sensitiveEnq.id,
          { includeRestricted: true },
        ))!;
        expect(enqAfterRetry.anonymisedAt).toBe('2026-09-10T02:15:00.000Z');
        expect(enqAfterRetry.firstName).toBe('Anonymised');
        expect(enqAfterRetry.lastName).toBe('Enquirer');
        expect(enqAfterRetry.email).toBe('');
        expect(enqAfterRetry.phone).toBe('');

        runs = await jobRunRepo.listJobRuns(ctx, {
          jobKey: 'enquiry-retention-anonymise',
        });
        expect(runs).toHaveLength(2);
        expect(runs.map((r) => r.status).sort()).toEqual([
          'failed',
          'succeeded',
        ]);

        const succeededRun = runs.find((r) => r.status === 'succeeded')!;
        expect(succeededRun.summary).toEqual({
          evaluatedCount: 1,
          anonymisedCount: 1,
          retentionMonths: 12,
          scope: 'bulk',
        });

        const auditsAfterRetry = await auditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          sensitiveEnq.id,
        );
        const anonAudits = auditsAfterRetry.filter(
          (a) => a.field === 'Privacy retention anonymisation',
        );
        expect(anonAudits).toHaveLength(1);
        expect(anonAudits[0]!.byId).toBe('system:enquiry-retention-anonymise');

        // 3. Assert ZERO PII in job_runs, audit_entries, CLI stdout, and telemetry events
        const piiTokens = [
          'SecretProspectFirstName',
          'SecretProspectLastName',
          'SecretCompanyHoldingsLtd',
          'secret.prospect@invented-domain.example',
          '07700 999888',
          '42 Invented Crescent',
        ];
        const combinedArtifacts = JSON.stringify({
          succeededRun,
          anonAudits,
          stdoutLines,
          telemetryEvents: telemetry.getRecentEntries(),
        });
        for (const token of piiTokens) {
          expect(combinedArtifacts).not.toContain(token);
        }
      } finally {
        await intakeRepo.clearTenantData(ctx, {
          includeEnquiries: true,
          includeQuotes: false,
        });
        await intakeRepo.putEnquiries(ctx, priorEnquiries);
        if (priorSettings) {
          await catalogueRepo.putEnquirySettingsConfig(
            ctx,
            priorSettings,
            'P-000001',
          );
        }
        await jobRunRepo.clearTenantJobRuns(ctx);
      }
    });
  });
});
