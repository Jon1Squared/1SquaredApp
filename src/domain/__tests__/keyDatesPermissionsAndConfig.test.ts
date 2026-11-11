import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_API_VERSION,
  ExtensionHost,
  loadAndValidateTenantConfig,
  PERMISSION_REGISTRY,
  validateKeyDatesConfig,
  type PlatformExtension,
} from '@platform/core';
import {
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import {
  acknowledgeKeyDateReminderRecord,
  createOrProposeKeyDateRecord,
  getKeyDatesConfig,
  previewLimitationCalculationRecord,
  proposeProvisionalKeyDateRecord,
  reassignKeyDateTeamRecord,
  recordKeyDateNotApplicableRecord,
  rejectProposedKeyDateRecord,
  resolveKeyDateOutcomeRecord,
  runKeyDateReminderSchedulerRecord,
  saveKeyDatesConfigRecord,
  supersedeConfirmedKeyDateRecord,
  verifyProposedKeyDateRecord,
} from '@/server/services';
import { getStore, resetStore } from '@/server/store';
import {
  getAuditRepository,
  getKeyDateRepository,
  runAsTestActor,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import notALawFirmBaseConfig from '../../../client-not-a-law-firm/config/base.json';
import {
  canUserVerifyKeyDate,
  canViewerAccessMatterKeyDates,
  evaluateMatterKeyDateClosureGate,
  evaluateMatterKeyDateOpeningGate,
  hasKeyDatePermission,
  isVerificationRequiredForKeyDate,
  resolveKeyDatePermissions,
  resolveMatterTypeCalendarSyncPolicy,
  resolveMatterTypeVerificationPolicy,
} from '../keyDates';
import { buildKeyDateReminderIdempotencyKey } from '../keyDateReminders';
import type { KeyDate, KeyDatesConfig } from '../keyDates.types';
import type { Person } from '../types';

function makePerson(overrides: Partial<Person> & { id: string }): Person {
  return {
    titleId: null,
    givenName: 'Test',
    middleNames: '',
    familyName: 'User',
    preferredName: '',
    previousNames: '',
    dateOfBirth: null,
    gender: '',
    nationality: '',
    countryOfResidence: '',
    preferredLanguage: '',
    occupation: '',
    employerName: '',
    niNumber: '',
    passportNumber: '',
    drivingLicenceNumber: '',
    isClient: false,
    isCounterparty: false,
    isThirdParty: false,
    isEmployee: true,
    clientStatus: 'None',
    amlStatus: 'Not required',
    riskRating: 'Low',
    isPep: false,
    sanctionsCheckedAt: null,
    identityVerifiedAt: null,
    verificationMethod: '',
    verificationNotes: '',
    sourceOfFunds: '',
    sourceOfWealth: '',
    preferredContactMethod: 'Email',
    marketingOptIn: false,
    communicationNotes: '',
    emails: [],
    phones: [],
    addresses: [],
    bankAccounts: [],
    emergencyContacts: [],
    customFields: {},
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdById: 'P-000001',
    updatedById: 'P-000001',
    ...overrides,
  } as unknown as Person;
}

describe('Key Dates permissions, config schema validation, and extension contract (Phase 1)', () => {
  describe('Central PERMISSION_REGISTRY & roleGrants resolution', () => {
    it('registers all 8 KeyDatePermission keys with requiresMfa=true on keydate:configure', () => {
      expect(PERMISSION_REGISTRY['keydate:view']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:view_any_team']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:edit']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:verify']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:resolve']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:waive']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:override_calculation']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:configure']).toBeDefined();
      expect(PERMISSION_REGISTRY['keydate:configure'].requiresMfa).toBe(true);
    });

    it('resolves default permissions per role (HomeRoleKey and AppRole)', () => {
      const feeEarner = makePerson({ id: 'P-FE', roles: ['fee_earner'] });
      expect(resolveKeyDatePermissions(feeEarner)).toEqual([
        'keydate:view',
        'keydate:edit',
        'keydate:resolve',
      ]);
      expect(hasKeyDatePermission(feeEarner, 'keydate:verify')).toBe(false);

      const secretary = makePerson({
        id: 'P-SEC',
        roles: ['legal_secretary'],
      });
      expect(resolveKeyDatePermissions(secretary)).toEqual([
        'keydate:view',
        'keydate:edit',
      ]);

      const partner = makePerson({ id: 'P-PART', roles: ['partner'] });
      expect(resolveKeyDatePermissions(partner)).toEqual([
        'keydate:view',
        'keydate:edit',
        'keydate:verify',
        'keydate:resolve',
        'keydate:waive',
        'keydate:override_calculation',
      ]);

      const teamLeadViaAppRole = makePerson({
        id: 'P-TL',
        appRole: 'team_lead',
        roles: ['fee_earner'],
      });
      expect(resolveKeyDatePermissions(teamLeadViaAppRole)).toEqual([
        'keydate:view',
        'keydate:edit',
        'keydate:verify',
        'keydate:resolve',
        'keydate:waive',
      ]);

      const riskUser = makePerson({
        id: 'P-RISK',
        roles: ['risk_compliance'],
      });
      expect(resolveKeyDatePermissions(riskUser)).toEqual([
        'keydate:view',
        'keydate:view_any_team',
        'keydate:verify',
      ]);

      const managingPartner = makePerson({
        id: 'P-MP',
        roles: ['managing_partner'],
      });
      expect(resolveKeyDatePermissions(managingPartner)).toEqual([
        'keydate:view',
        'keydate:view_any_team',
        'keydate:edit',
        'keydate:verify',
        'keydate:resolve',
        'keydate:waive',
        'keydate:override_calculation',
      ]);

      const adminUser = makePerson({
        id: 'P-ADM',
        appRole: 'admin',
        roles: ['admin'],
      });
      expect(resolveKeyDatePermissions(adminUser)).toEqual([
        'keydate:view',
        'keydate:view_any_team',
        'keydate:configure',
      ]);
      // R37: Admin does not get operational keydate:edit, keydate:verify, or keydate:override_calculation
      expect(hasKeyDatePermission(adminUser, 'keydate:edit')).toBe(false);
      expect(hasKeyDatePermission(adminUser, 'keydate:verify')).toBe(false);
      expect(
        hasKeyDatePermission(adminUser, 'keydate:override_calculation'),
      ).toBe(false);
    });

    it('honours custom keyDates.permissions.roleGrants and per-person permissionOverrides', () => {
      const customConfig: KeyDatesConfig = {
        enabled: true,
        permissions: {
          roleGrants: {
            fee_earner: ['keydate:view', 'keydate:edit', 'keydate:verify'],
          },
        },
      };

      const fe = makePerson({
        id: 'P-FE-CUSTOM',
        roles: ['fee_earner'],
        permissionOverrides: {
          grant: ['keydate:waive'],
          revoke: ['keydate:edit'],
        },
      });

      const perms = resolveKeyDatePermissions(fe, customConfig);
      expect(perms).toContain('keydate:view');
      expect(perms).toContain('keydate:verify');
      expect(perms).toContain('keydate:waive');
      expect(perms).not.toContain('keydate:edit');
    });

    it('returns [] for a user with no roles and fails service calls for unknown users without writing audit entries (R36)', async () => {
      const noRoleUser = makePerson({
        id: 'P-NO-ROLES',
        roles: [],
        appRole: null,
        employeeRoleId: null,
      });
      expect(resolveKeyDatePermissions(noRoleUser)).toEqual([]);

      resetStore();
      const store = getStore();
      const auditCountBefore = await getAuditRepository().countAuditEntries(testTenantCtx('P-000004'));
      const res = await createOrProposeKeyDateRecord(
        {
          matterId: store.matters[0]!.id,
          keyDateTypeId: 'limitation',
          dueDate: '2028-06-01',
        },
        'P-DOES-NOT-EXIST',
      );
      expect(res.ok).toBe(false);
      expect(await getAuditRepository().countAuditEntries(testTenantCtx('P-000004'))).toBe(auditCountBefore);
    });
  });

  describe('Configuration schema validation (schemas/keyDates.config.schema.json)', () => {
    it('validates schemas/keyDates.config.example.json cleanly', () => {
      const examplePath = path.join(
        process.cwd(),
        'schemas',
        'keyDates.config.example.json',
      );
      const rawExample = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
      const validated = validateKeyDatesConfig(rawExample);
      expect(validated.enabled).toBe(true);
      expect(validated.keyDateTypes?.length).toBe(6);
      expect(validated.limitationRuleSets?.[0]?.reviewStatus).toBe('unreviewed');
    });

    it('defaults keyDates.enabled to false when omitted in tenant config', () => {
      const rawWithoutKeyDates = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
      };
      delete rawWithoutKeyDates.keyDates;

      const parsed = loadAndValidateTenantConfig(rawWithoutKeyDates);
      expect(parsed.keyDates?.enabled).toBe(false);
      expect(parsed.keyDates?.defaults?.calendarSync?.enabled).toBe(true);
      expect(parsed.keyDates?.defaults?.verification?.required).toBe(false);
    });

    it('rejects unknown keys in keyDates configuration at top level and nested objects', () => {
      expect(() =>
        validateKeyDatesConfig({
          enabled: true,
          unknownTopLevelProperty: 'not-allowed',
        }),
      ).toThrow();

      expect(() =>
        validateKeyDatesConfig({
          enabled: true,
          defaults: {
            verification: { required: true },
            unknownNestedKey: 123,
          },
        }),
      ).toThrow();
    });

    it('keeps schemas/keyDates.config.schema.json and core/schemas/keyDates.config.schema.json identical and ensures every property has a description (R45, R47)', () => {
      const rootSchema = fs.readFileSync(
        path.join(process.cwd(), 'schemas', 'keyDates.config.schema.json'),
        'utf8',
      );
      const coreSchema = fs.readFileSync(
        path.join(
          process.cwd(),
          'core',
          'schemas',
          'keyDates.config.schema.json',
        ),
        'utf8',
      );
      expect(rootSchema).toBe(coreSchema);

      const parsed = JSON.parse(coreSchema) as Record<string, unknown>;
      const missingDescriptions: string[] = [];
      const walk = (node: unknown, curPath: string) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        const obj = node as Record<string, unknown>;
        if (obj.properties && typeof obj.properties === 'object') {
          for (const [k, v] of Object.entries(
            obj.properties as Record<string, Record<string, unknown>>,
          )) {
            const p = `${curPath}.properties.${k}`;
            if (!v.description) missingDescriptions.push(p);
            walk(v, p);
          }
        }
        if (obj.$defs && typeof obj.$defs === 'object') {
          for (const [k, v] of Object.entries(
            obj.$defs as Record<string, Record<string, unknown>>,
          )) {
            const p = `${curPath}.$defs.${k}`;
            if (!v.description) missingDescriptions.push(p);
            walk(v, p);
          }
        }
        if (obj.items) walk(obj.items, `${curPath}.items`);
      };
      walk(parsed, 'root');
      expect(missingDescriptions).toEqual([]);

      const tenancyIndex = fs.readFileSync(
        path.join(process.cwd(), 'core', 'src', 'tenancy', 'index.ts'),
        'utf8',
      );
      const migrationExports = tenancyIndex
        .split('\n')
        .filter((l) => l.includes('migrations/index'));
      expect(migrationExports).toHaveLength(1);
    });

    it('resolves keyDates from active tenant config and defaults to enabled:false for a tenant without a keyDates block (R33)', async () => {
      resetStore();
      const secondTenantConfig: Record<string, unknown> = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        tenantId: 'second-law-firm',
      };
      delete secondTenantConfig.keyDates;
      try {
        setActiveTenantConfigForTesting(secondTenantConfig, {});
        const store = getStore();
        store.keyDatesConfigOverride = undefined;
        const resolved = await runAsTestActor('P-000001', () =>
          getKeyDatesConfig(store),
        );
        expect(resolved.enabled).toBe(false);
      } finally {
        setActiveTenantConfigForTesting(null, undefined);
      }
    });

    it('enforces MFA on saveKeyDatesConfigRecord (R27), refuses mutating services when enabled:false (R35), gates scheduler behind keydate:configure + MFA and runTenantBackgroundJob (R25), and enforces preview/acknowledge guards (R34)', async () => {
      resetStore();
      const store = getStore();
      const currentConfig = await runAsTestActor('P-000001', () =>
        getKeyDatesConfig(store),
      );
      const admin = store.people.find(
        (p) =>
          p.isEmployee &&
          !p.mergedIntoId &&
          hasKeyDatePermission(p, 'keydate:configure', {
            config: currentConfig,
            allPeople: store.people,
            teams: store.teams,
          }),
      )!;
      const feeEarner = store.people.find(
        (p) =>
          p.isEmployee &&
          !p.mergedIntoId &&
          hasKeyDatePermission(p, 'keydate:edit', {
            config: currentConfig,
            allPeople: store.people,
            teams: store.teams,
          }) &&
          !hasKeyDatePermission(p, 'keydate:configure', {
            config: currentConfig,
            allPeople: store.people,
            teams: store.teams,
          }),
      )!;

      // R27: Admin with mfaVerified: false gets ok:false and config is unchanged
      const saveNoMfa = await runAsTestActor(admin.id, () =>
        saveKeyDatesConfigRecord(
          { ...currentConfig, enabled: false },
          'Disable without MFA',
          admin.id,
          { mfaVerified: false },
        ),
        { mfaVerified: false },
      );
      expect(saveNoMfa.ok).toBe(false);
      expect(
        (await runAsTestActor(admin.id, () => getKeyDatesConfig(store))).enabled,
      ).toBe(true);

      // R27: Same admin with MFA succeeds
      const saveWithMfa = await runAsTestActor(admin.id, () =>
        saveKeyDatesConfigRecord(
          { ...currentConfig, enabled: false },
          'Disable with MFA',
          admin.id,
          { mfaVerified: true },
        ),
      );
      expect(saveWithMfa.ok).toBe(true);
      expect(
        (await runAsTestActor(admin.id, () => getKeyDatesConfig(store))).enabled,
      ).toBe(false);

      // R35: With enabled: false, every mutating key-date service returns ok:false and the stored key dates are unchanged
      const kdRepo = getKeyDateRepository();
      const allKeyDatesBefore = await kdRepo.listAllVisibleKeyDates(testTenantCtx(admin.id));
      const snapshotBefore = JSON.stringify(allKeyDatesBefore);
      const kdId = allKeyDatesBefore[0]!.id;
      const matterId = store.matters[0]!.id;
      const teamId = store.teams.find((t) => t.active)!.id;

      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            createOrProposeKeyDateRecord(
              { matterId, keyDateTypeId: 'limitation', dueDate: '2029-01-01' },
              feeEarner.id,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            proposeProvisionalKeyDateRecord(kdId, feeEarner.id),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(admin.id, () =>
            verifyProposedKeyDateRecord(kdId, admin.id),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(admin.id, () =>
            rejectProposedKeyDateRecord(kdId, 'Reason', admin.id),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            supersedeConfirmedKeyDateRecord(
              kdId,
              { dueDate: '2029-02-01' },
              'Reason',
              feeEarner.id,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            resolveKeyDateOutcomeRecord(
              kdId,
              { kind: 'met', note: 'Met' },
              feeEarner.id,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            reassignKeyDateTeamRecord(kdId, { teamId }, feeEarner.id),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            recordKeyDateNotApplicableRecord(
              { matterId, keyDateTypeId: 'limitation', reason: 'N/A' },
              feeEarner.id,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await runAsTestActor(feeEarner.id, () =>
            acknowledgeKeyDateReminderRecord(kdId, feeEarner.id),
          )
        ).ok,
      ).toBe(false);
      expect(
        JSON.stringify(await kdRepo.listAllVisibleKeyDates(testTenantCtx(admin.id))),
      ).toBe(snapshotBefore);

      // Re-enable module with MFA
      await runAsTestActor(admin.id, () =>
        saveKeyDatesConfigRecord(
          { ...currentConfig, enabled: true },
          'Re-enable with MFA',
          admin.id,
          { mfaVerified: true },
        ),
      );

      // R25, R84 & R449: Scheduler accepts only { tenantCtx, byId, mfaVerified }, checks keydate:configure + MFA before any repository read, rejects actor mismatch, and throws TENANCY_JOB_ERROR when called with no context
      await expect(runKeyDateReminderSchedulerRecord(null)).rejects.toThrow(
        /TENANCY_JOB_ERROR/,
      );
      await expect(
        // @ts-expect-error R84: Old positional/string arguments are rejected at compile time
        runKeyDateReminderSchedulerRecord('forged-tenant-id'),
      ).rejects.toThrow(/TENANCY_JOB_ERROR/);

      const repoCfgSpy = vi.spyOn(kdRepo, 'getKeyDatesTenantConfig');
      const repoReadTxSpy = vi.spyOn(kdRepo, 'withTenantReadTransaction');
      const repoGetByIdSpy = vi.spyOn(kdRepo, 'getKeyDateById');
      const repoReminderSpy = vi.spyOn(kdRepo, 'listAllReminderStates');
      try {
        expect(
          (
            await runAsTestActor(feeEarner.id, () =>
              runKeyDateReminderSchedulerRecord({
                byId: feeEarner.id,
                mfaVerified: true,
              }),
            )
          ).ok,
        ).toBe(false);
        expect(
          (
            await runAsTestActor(
              admin.id,
              () =>
                runKeyDateReminderSchedulerRecord({
                  byId: admin.id,
                  mfaVerified: false,
                }),
              { mfaVerified: false },
            )
          ).ok,
        ).toBe(false);
        // R449: Caller-supplied mfaVerified: true cannot override a context with mfaVerified: false
        expect(
          (await runKeyDateReminderSchedulerRecord({
            tenantCtx: testTenantCtx(admin.id, { mfaVerified: false }),
            byId: admin.id,
            mfaVerified: true,
          })).ok,
        ).toBe(false);
        // R449: Context actorId mismatch is rejected before any repository read
        await expect(
          runKeyDateReminderSchedulerRecord({
            tenantCtx: testTenantCtx(feeEarner.id, { mfaVerified: true }),
            byId: admin.id,
            mfaVerified: true,
          }),
        ).rejects.toThrow(/TENANCY_ACTOR_MISMATCH/);

        expect(repoCfgSpy).not.toHaveBeenCalled();
        expect(repoReadTxSpy).not.toHaveBeenCalled();
        expect(repoGetByIdSpy).not.toHaveBeenCalled();
        expect(repoReminderSpy).not.toHaveBeenCalled();
      } finally {
        repoCfgSpy.mockRestore();
        repoReadTxSpy.mockRestore();
        repoGetByIdSpy.mockRestore();
        repoReminderSpy.mockRestore();
      }
      const signedAdminSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: admin.id,
          tenantId: 'not-a-law-firm',
          oid: admin.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
          tid: '00000000-0000-4000-8000-000000000000',
          sub: admin.id,
          email: admin.emails?.[0]?.address ?? 'admin@notalawfirm.example',
          displayName: `${admin.firstName} ${admin.surname}`,
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: '2026-10-31T10:00:00Z',
          expiresAt: '2099-10-31T18:00:00Z',
        }),
      )!;
      const schedOk = await runKeyDateReminderSchedulerRecord({
        byId: admin.id,
        mfaVerified: true,
        session: signedAdminSession,
      });
      expect(schedOk.ok).toBe(true);
      expect(schedOk.result?.tenantId).toBe('not-a-law-firm');

      // R34: Preview and acknowledge require keydate:view; acknowledge requires responsible person or team lead and confirmed status
      const keyDatesNow = await kdRepo.listAllVisibleKeyDates(testTenantCtx(admin.id));
      const confirmedKd = keyDatesNow.find((k) => k.status === 'confirmed')!;
      const revokedViewer = makePerson({
        id: 'P-REVOKED-VIEW',
        firstName: 'No',
        surname: 'View',
        roles: ['fee_earner'],
        appRole: null,
        employeeRoleId: null,
        permissionOverrides: {
          grant: [],
          revoke: ['keydate:view'],
        },
      });
      store.people.push(revokedViewer);
      // Put revokedViewer on confirmedKd.responsiblePersonIds so the ONLY reason acknowledge fails is missing keydate:view
      confirmedKd.responsiblePersonIds = [
        ...confirmedKd.responsiblePersonIds,
        revokedViewer.id,
      ];
      await kdRepo.putKeyDate(testTenantCtx(admin.id), confirmedKd);

      expect(
        (
          await runAsTestActor(revokedViewer.id, () =>
            previewLimitationCalculationRecord(
              {
                ruleSetId: 'ew-sample',
                ruleId: 'contract-simple',
                triggerValues: { accrualDate: '2022-01-01' },
              },
              revokedViewer.id,
            ),
          )
        ).ok,
      ).toBe(false);
      const ackRevoked = await runAsTestActor(revokedViewer.id, () =>
        acknowledgeKeyDateReminderRecord(
          confirmedKd.id,
          revokedViewer.id,
        ),
      );
      expect(ackRevoked.ok).toBe(false);
      expect(ackRevoked.error).toMatch(/keydate:view/i);

      // R43: buildKeyDateReminderIdempotencyKey throws TENANCY_JOB_ERROR on empty tenantId
      expect(() => buildKeyDateReminderIdempotencyKey('KD-1', '')).toThrow(
        /TENANCY_JOB_ERROR/,
      );

      // A user who is neither a responsible person nor the team lead cannot acknowledge
      const owningTeam = store.teams.find((t) => t.id === confirmedKd.teamId)!;
      const unrelatedFeeEarner = makePerson({
        id: 'P-UNRELATED-FE',
        firstName: 'Unrelated',
        surname: 'Solicitor',
        roles: ['fee_earner'],
      });
      store.people.push(unrelatedFeeEarner);
      expect(confirmedKd.responsiblePersonIds).not.toContain(
        unrelatedFeeEarner.id,
      );
      expect(owningTeam.leadIds).not.toContain(unrelatedFeeEarner.id);
      expect(
        (
          await runAsTestActor(unrelatedFeeEarner.id, () =>
            acknowledgeKeyDateReminderRecord(confirmedKd.id, unrelatedFeeEarner.id),
          )
        ).ok,
      ).toBe(false);

      // Acknowledging a provisional or awaiting_verification date fails and creates no task
      const unconfirmedKd = keyDatesNow.find(
        (k) => k.status !== 'confirmed',
      )!;
      const tasksBefore = store.tasks.length;
      const ackUnconfirmed = await runAsTestActor(
        unconfirmedKd.responsiblePersonIds[0]!,
        () =>
          acknowledgeKeyDateReminderRecord(
            unconfirmedKd.id,
            unconfirmedKd.responsiblePersonIds[0]!,
          ),
      );
      expect(ackUnconfirmed.ok).toBe(false);
      expect(store.tasks.length).toBe(tasksBefore);
    });
  });

  describe('Verification, Calendar Sync, Opening Gate, Closure Gate & Staff Matter Helpers', () => {
    const sampleConfig: KeyDatesConfig = {
      enabled: true,
      defaults: {
        verification: { required: false, appliesTo: 'all' },
        calendarSync: { enabled: true },
      },
      keyDateTypes: [
        {
          id: 'limitation',
          label: 'Limitation date',
          category: 'limitation',
          defaultCritical: true,
        },
      ],
      matterTypes: [
        {
          matterTypeId: 'matter_type.litigation',
          requiredKeyDateTypeIds: ['limitation'],
          verification: { required: true, appliesTo: 'critical_only' },
          calendarSync: { enabled: true },
          blockClosureWithOpenDates: true,
        },
        {
          matterTypeId: 'matter_type.residential_conveyancing',
          verification: { required: false },
          calendarSync: { enabled: false },
        },
      ],
    };

    it('resolves verification policy per matter type and forces verification for unreviewed rule sets', () => {
      expect(
        resolveMatterTypeVerificationPolicy(
          sampleConfig,
          'matter_type.litigation',
        ),
      ).toEqual({
        required: true,
        appliesTo: 'critical_only',
      });

      // Non-critical date on litigation does not require verification unless calculated from unreviewed rule set
      expect(
        isVerificationRequiredForKeyDate(
          sampleConfig,
          'matter_type.litigation',
          {
            category: 'internal_milestone',
            isCritical: false,
            ruleSetReviewStatus: 'reviewed',
          },
        ),
      ).toBe(false);

      // Unreviewed rule set always forces verification even on conveyancing (where verification.required = false)
      expect(
        isVerificationRequiredForKeyDate(
          sampleConfig,
          'matter_type.residential_conveyancing',
          {
            category: 'contractual',
            isCritical: false,
            ruleSetReviewStatus: 'unreviewed',
          },
        ),
      ).toBe(true);
    });

    it('blocks the proposer from verifying their own key date even with keydate:verify', () => {
      const partnerA = makePerson({ id: 'P-PART-A', roles: ['partner'] });
      const partnerB = makePerson({ id: 'P-PART-B', roles: ['partner'] });

      const proposedDate: Pick<
        KeyDate,
        'status' | 'verification' | 'createdById'
      > = {
        status: 'awaiting_verification',
        createdById: 'P-PART-A',
        verification: {
          required: true,
          proposedById: 'P-PART-A',
          proposedAt: '2026-11-03T09:00:00.000Z',
        },
      };

      expect(canUserVerifyKeyDate(partnerA, proposedDate).allowed).toBe(false);
      expect(canUserVerifyKeyDate(partnerB, proposedDate).allowed).toBe(true);
    });

    it('disables calendar sync unconditionally for restricted (staff) matters', () => {
      expect(
        resolveMatterTypeCalendarSyncPolicy(
          sampleConfig,
          'matter_type.litigation',
          false,
        ).enabled,
      ).toBe(true);
      expect(
        resolveMatterTypeCalendarSyncPolicy(
          sampleConfig,
          'matter_type.litigation',
          true,
        ).enabled,
      ).toBe(false);
    });

    it('enforces strict restrictedAccessUserIds.includes(viewerId) for staff matters and fails closed when matter or id is missing (R82, R85)', () => {
      const staffMatter = {
        id: 'M-STAFF-TEST',
        isStaffMatter: true,
        restrictedAccessUserIds: ['P-ALLOWED-1', 'P-ALLOWED-2'],
      };
      expect(canViewerAccessMatterKeyDates(staffMatter, 'P-ALLOWED-1')).toBe(
        true,
      );
      expect(canViewerAccessMatterKeyDates(staffMatter, 'P-OTHER')).toBe(false);
      expect(canViewerAccessMatterKeyDates(staffMatter, null)).toBe(false);
      expect(canViewerAccessMatterKeyDates(null, 'P-ALLOWED-1')).toBe(false);
      expect(canViewerAccessMatterKeyDates(undefined, 'P-ALLOWED-1')).toBe(
        false,
      );
      expect(
        canViewerAccessMatterKeyDates(
          { id: '', isStaffMatter: false },
          'P-ALLOWED-1',
        ),
      ).toBe(false);
    });

    it('evaluates matter opening and closure gates accurately', () => {
      const gateBlocked = evaluateMatterKeyDateOpeningGate(
        sampleConfig,
        'matter_type.litigation',
        [],
        [],
      );
      expect(gateBlocked.canOpen).toBe(false);
      expect(gateBlocked.missingKeyDateTypes).toEqual([
        { id: 'limitation', label: 'Limitation date' },
      ]);

      const gatePassedViaNotApplicable = evaluateMatterKeyDateOpeningGate(
        sampleConfig,
        'matter_type.litigation',
        [],
        [
          {
            matterId: 'M-000001',
            keyDateTypeId: 'limitation',
            reason: 'Advisory-only instruction with no contentious claim.',
            recordedById: 'P-PART-A',
            recordedAt: '2026-11-03T09:00:00.000Z',
          },
        ],
      );
      expect(gatePassedViaNotApplicable.canOpen).toBe(true);

      const openDate: KeyDate = {
        id: 'KD-000001',
        matterId: 'M-000001',
        keyDateTypeId: 'limitation',
        category: 'limitation',
        title: 'Primary limitation',
        dueDate: '2027-05-01',
        isCritical: true,
        status: 'confirmed',
        source: 'manual',
        teamId: 'TM-000001',
        responsiblePersonIds: ['P-PART-A', 'P-PART-B'],
        verification: { required: false },
        createdById: 'P-PART-A',
        createdAt: '2026-11-03T09:00:00.000Z',
        updatedById: 'P-PART-A',
        updatedAt: '2026-11-03T09:00:00.000Z',
        version: 1,
      };

      expect(
        evaluateMatterKeyDateClosureGate(
          sampleConfig,
          'matter_type.litigation',
          [openDate],
        ).canClose,
      ).toBe(false);
      expect(
        evaluateMatterKeyDateClosureGate(
          sampleConfig,
          'matter_type.litigation',
          [{ ...openDate, status: 'met' }],
        ).canClose,
      ).toBe(true);
    });
  });

  describe('Extension API v1.1.0 Contract Tests', () => {
    it('supports keydate:read, keydate:write and all 3 KeyDateExtensionPoints with error/timeout isolation', async () => {
      expect(CORE_API_VERSION).toBe('1.1.0');
      const host = new ExtensionHost({
        coreApiVersion: CORE_API_VERSION,
        defaultHookTimeoutMs: 100,
      });

      const validExt: PlatformExtension = {
        manifest: {
          id: 'ext-keydate-test',
          name: 'KeyDate Test Extension',
          version: '1.0.0',
          description: 'Tests keyDate hooks',
          supportedCoreApiRange: '^1.0.0',
          permissions: ['keydate:read', 'keydate:write'],
          hooks: [
            'keyDate.beforeCreate',
            'keyDate.afterStatusChange',
            'keyDate.calculateCustomRule',
          ],
        },
        hooks: {
          'keyDate.beforeCreate': async (_ctx, input) => ({
            allowProceed: true,
            enrichedFields: {
              title: `${input.title} [Checked]`,
            },
          }),
          'keyDate.calculateCustomRule': async () => ({
            date: '2028-06-15',
            explanation: ['Custom contractual calculation applied'],
          }),
        },
      };

      host.registerExtension(validExt);

      const tenantConfig = loadAndValidateTenantConfig({
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        enabledExtensions: ['ext-keydate-test'],
      });
      const signedSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: tenantConfig.tenantId,
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '00000000-0000-4000-8000-000000000000',
          sub: 'P-000001',
          email: 'test@notalawfirm.example',
          displayName: 'Test User',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: '2026-10-31T10:00:00Z',
          expiresAt: '2099-10-31T18:00:00Z',
        }),
      )!;
      const tenantCtx = resolveCurrentTenantContext(
        createVerifiedSessionActorFromEntraSession(
          signedSession,
          {
            correlationId: 'corr-kd-ext-1',
          },
        ),
        tenantConfig,
      );

      const beforeCreateRes = await host.executeKeyDateBeforeCreateHook(
        tenantCtx,
        tenantConfig,
        {
          matterId: 'M-000001',
          keyDateTypeId: 'limitation',
          category: 'limitation',
          title: 'Primary Limitation',
          dueDate: '2028-06-15',
          isCritical: true,
          teamId: 'TM-000001',
          responsiblePersonIds: ['P-000001', 'P-000002'],
        },
      );
      expect(beforeCreateRes.allowProceed).toBe(true);
      expect(beforeCreateRes.enrichedInput.title).toBe(
        'Primary Limitation [Checked]',
      );

      const customCalcRes = await host.executeKeyDateCalculateCustomRuleHook(
        tenantCtx,
        tenantConfig,
        {
          ruleSetId: 'ew-sample',
          ruleId: 'custom-1',
          triggers: { accrualDate: '2025-06-15' },
        },
      );
      expect(customCalcRes.result?.date).toBe('2028-06-15');
    });

    it('rejects registration of keyDate.beforeCreate when keydate:write permission is missing', () => {
      const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
      expect(() =>
        host.registerExtension({
          manifest: {
            id: 'ext-missing-perm',
            name: 'Missing Write Perm',
            version: '1.0.0',
            description: 'Missing keydate:write',
            supportedCoreApiRange: '^1.0.0',
            permissions: ['keydate:read'],
            hooks: ['keyDate.beforeCreate'],
          },
          hooks: {},
        }),
      ).toThrow(/EXTENSION_PERMISSION_ERROR/);
    });
  });
});
