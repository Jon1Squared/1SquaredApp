import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectMigrationClient,
  mergeDeclarativeTenantConfigCustomFields,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantPostgresPoolManager,
  type TenantChoiceListRecord,
  type TenantChoiceValueRecord,
  type TenantConfiguration,
  type TenantCustomFieldDefinitionRecord,
  type TenantContext,
} from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  addChoiceValueAction,
  reorderChoiceValueAction,
  reorderCustomFieldAction,
  saveCustomFieldAction,
  updateChoiceValueAction,
} from '@/app/actions';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  addChoiceValue,
  getAppSnapshot,
  getCatalogueRepository,
  reorderChoiceValue,
  reorderCustomField,
  resetAllDemoData,
  saveCustomFieldDefinition,
  saveEnquirySettingsRecord,
  saveHomePagesConfig,
  saveMatterCostsConfig,
  saveMatterPartyRelationship,
  saveOrgStructure,
  saveTaskSettingsRecord,
  updateWorkTypeProfiles,
} from '@/server/services';
import { createSeedStore, getStore, resetStore, saveStore } from '@/server/store';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';

const REPO_ROOT = path.resolve(__dirname, '../..');

afterEach(() => {
  setTestEntraSessionOverride(null);
  setActiveTenantConfigForTesting(null);
});

function makeTenantContext(
  tenantId: 'tenant-a' | 'tenant-b',
  actorId = `actor-${tenantId}`,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${tenantId}`,
      email: `actor@${tenantId}.example`,
      roles: ['admin', 'managing_partner', 'partner', 'fee_earner'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s017c-${tenantId}`,
  });
}

function makeHostActorAndContext(actorPersonId = 'P-000001') {
  const cfg = getActiveTenantConfiguration();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const roles = [
    'admin',
    'managing_partner',
    'partner',
    'fee_earner',
    'enquiries_coordinator',
    'finance',
    'risk_compliance',
  ];
  const cookieVal = createSignedEntraSessionCookie({
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    oid: `00000000-0000-4000-8000-${actorPersonId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: actorPersonId,
    email: `${actorPersonId.toLowerCase()}@${cfg.branding.primaryDomain}`,
    displayName: `Test Actor ${actorPersonId}`,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verified = verifySignedEntraSessionCookie(cookieVal)!;
  setTestEntraSessionOverride(verified);
  const ctx = resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verified, {
      correlationId: `corr-s017c-host-${actorPersonId}`,
    }),
    cfg,
  );
  const actorSession = {
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    tokenRoles: verified.mappedRoles,
    mfaVerified: true,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession: verified,
  };
  return { ctx, actorSession };
}

describe('S0-17c: PostgreSQL Catalogues & Tenant Module Configs Repository, Declarative customFields (P7), and Audit Atomicity', () => {
  it('enforces two-tenant isolation, forged-claim rejection, tampered ID rejection, single-connection SET LOCAL ROLE, and R402 privileges across firm_profiles, choice_lists, choice_values, custom_field_definitions, and tenant_module_configs', async () => {
    const ctxA = makeTenantContext('tenant-a');
    const ctxB = makeTenantContext('tenant-b');
    const poolMgr = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
    const repo = new TenantCatalogueRepository({ poolManager: poolMgr });

    try {
      await repo.clearTenantData(ctxA);
      await repo.clearTenantData(ctxB);

      // 1. Firm profiles
      await repo.putFirmProfile(ctxA, {
        firmId: 'tenant-a-firm',
        isCleanDeployment: false,
        firm: {
          legalName: 'Tenant A Legal LLP',
          tradingName: 'Tenant A Legal',
        },
      });
      await repo.putFirmProfile(ctxB, {
        firmId: 'tenant-b-firm',
        isCleanDeployment: true,
        firm: {
          legalName: 'Tenant B Chambers LLP',
          tradingName: 'Tenant B Chambers',
        },
      });

      // 2. Choice lists & values
      const listA: TenantChoiceListRecord = {
        key: 'client_tier',
        label: 'Client Tier A',
        description: 'Tenant A client tiers',
        group: 'crm',
        appliesTo: ['organisation'],
        allowMultiple: false,
        hierarchical: false,
      };
      const listB: TenantChoiceListRecord = {
        key: 'client_tier',
        label: 'Client Tier B',
        description: 'Tenant B client tiers',
        group: 'crm',
        appliesTo: ['organisation'],
        allowMultiple: false,
        hierarchical: false,
      };
      await repo.putChoiceLists(ctxA, [listA]);
      await repo.putChoiceLists(ctxB, [listB]);

      const valA: TenantChoiceValueRecord = {
        id: 'client_tier.platinum_a',
        listKey: 'client_tier',
        label: 'Platinum A',
        parentId: null,
        sortOrder: 1,
        active: true,
      };
      const valB: TenantChoiceValueRecord = {
        id: 'client_tier.gold_b',
        listKey: 'client_tier',
        label: 'Gold B',
        parentId: null,
        sortOrder: 1,
        active: true,
      };
      await repo.putChoiceValues(ctxA, [valA]);
      await repo.putChoiceValues(ctxB, [valB]);

      // 3. Custom field definitions
      const cfA: TenantCustomFieldDefinitionRecord = {
        id: 'cf_a_sector_code',
        recordType: 'organisation',
        label: 'Sector Code A',
        fieldType: 'text',
        section: 'A',
        required: true,
        sortOrder: 1,
        active: true,
      };
      const cfB: TenantCustomFieldDefinitionRecord = {
        id: 'cf_b_region_code',
        recordType: 'organisation',
        label: 'Region Code B',
        fieldType: 'text',
        section: 'A',
        required: false,
        sortOrder: 1,
        active: true,
      };
      await repo.putCustomFieldDefinitions(ctxA, [cfA]);
      await repo.putCustomFieldDefinitions(ctxB, [cfB]);

      // 4. Tenant module configs
      await repo.putOrgStructureConfig(
        ctxA,
        { departments: [{ id: 'DEPT-A', code: 'CORP-A', name: 'Corporate A' }] },
        ctxA.actorId,
      );
      await repo.putOrgStructureConfig(
        ctxB,
        { departments: [{ id: 'DEPT-B', code: 'DISP-B', name: 'Disputes B' }] },
        ctxB.actorId,
      );
      await repo.putEnquirySettingsConfig(
        ctxA,
        { roundRobinCursorByTeamId: { 'TM-A': 2 } },
        ctxA.actorId,
      );
      await repo.putTaskSettingsConfig(
        ctxA,
        { dueSoonDays: 5 },
        ctxA.actorId,
      );
      await repo.putCountersConfig(ctxA, { person: 42, matter: 19 }, ctxA.actorId);

      // Positive control on fresh connections: Tenant A sees only Tenant A rows; Tenant B sees only Tenant B rows
      const freshRepo = new TenantCatalogueRepository();
      const profileA = await freshRepo.getFirmProfile<{ legalName: string }>(ctxA);
      const profileB = await freshRepo.getFirmProfile<{ legalName: string }>(ctxB);
      expect(profileA?.firm.legalName).toBe('Tenant A Legal LLP');
      expect(profileB?.firm.legalName).toBe('Tenant B Chambers LLP');

      const listsA = await freshRepo.listAllChoiceLists(ctxA);
      const listsB = await freshRepo.listAllChoiceLists(ctxB);
      expect(listsA.map((l) => l.label)).toEqual(['Client Tier A']);
      expect(listsB.map((l) => l.label)).toEqual(['Client Tier B']);

      const valuesA = await freshRepo.listAllChoiceValues(ctxA);
      const valuesB = await freshRepo.listAllChoiceValues(ctxB);
      expect(valuesA.map((v) => v.id)).toEqual(['client_tier.platinum_a']);
      expect(valuesB.map((v) => v.id)).toEqual(['client_tier.gold_b']);
      expect(await freshRepo.getChoiceValueById(ctxA, 'client_tier.gold_b')).toBeNull();
      expect(await freshRepo.getChoiceValueById(ctxB, 'client_tier.platinum_a')).toBeNull();

      const cfsA = await freshRepo.listAllCustomFieldDefinitions(ctxA);
      const cfsB = await freshRepo.listAllCustomFieldDefinitions(ctxB);
      expect(cfsA.map((d) => d.id)).toEqual(['cf_a_sector_code']);
      expect(cfsB.map((d) => d.id)).toEqual(['cf_b_region_code']);
      expect(await freshRepo.getCustomFieldDefinitionById(ctxA, 'cf_b_region_code')).toBeNull();

      expect(await freshRepo.getOrgStructureConfig(ctxA)).toEqual({
        departments: [{ id: 'DEPT-A', code: 'CORP-A', name: 'Corporate A' }],
      });
      expect(await freshRepo.getOrgStructureConfig(ctxB)).toEqual({
        departments: [{ id: 'DEPT-B', code: 'DISP-B', name: 'Disputes B' }],
      });
      expect(await freshRepo.getEnquirySettingsConfig(ctxB)).toBeNull();
      expect(await freshRepo.getCountersConfig(ctxA)).toEqual({
        person: 42,
        matter: 19,
      });

      // Tampered cross-tenant IDs fail closed with NOT_FOUND
      await expect(
        freshRepo.updateExistingChoiceValue(ctxA, 'client_tier.gold_b', {
          label: 'Tampered',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        freshRepo.updateExistingCustomFieldDefinition(ctxA, 'cf_b_region_code', {
          label: 'Tampered',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Forged tenant claims fail closed with TENANCY_FORGERY_DETECTED / TENANCY_ISOLATION_ERROR
      expect(() =>
        resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: 'actor-a',
            tenantId: 'tenant-a',
            name: 'Actor A',
            email: 'actor@tenant-a.example',
            roles: ['admin'],
            mfaVerified: true,
          },
          hostingMode: 'multi_tenant',
          environment: 'test',
          correlationId: 'corr-forged-s017c',
          untrustedRequestTenantOverride: 'tenant-b',
        }),
      ).toThrow(/TENANCY_FORGERY_DETECTED/);

      const invalidCtx = Object.freeze({
        ...ctxA,
        tenantId: '',
      }) as unknown as TenantContext;
      await expect(freshRepo.listAllChoiceLists(invalidCtx)).rejects.toThrow(
        /TENANCY_ISOLATION_ERROR/,
      );

      // Single-connection role switching & R402 table privilege verification on raw connection
      const { pool: poolA } = await poolMgr.getPoolForTenant(ctxA);
      const rawClient = await poolA.connect();
      try {
        for (const tableName of [
          'firm_profiles',
          'choice_lists',
          'choice_values',
          'custom_field_definitions',
          'tenant_module_configs',
        ]) {
          await expect(
            rawClient.query(`SELECT * FROM public.${tableName}`),
          ).rejects.toMatchObject({
            code: '42501',
            message: expect.stringMatching(
              new RegExp(
                `permission denied for (table ${tableName}|schema public)`,
                'i',
              ),
            ),
          });
        }

        // Cross-tenant role on Tenant A's database is denied (42501)
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_b_test"');
        await expect(
          rawClient.query('SELECT * FROM public.choice_values'),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(
            /permission denied for (table choice_values|schema public)/i,
          ),
        });
        await rawClient.query('ROLLBACK');
      } finally {
        rawClient.release();
      }
    } finally {
      await poolMgr.closeAllPools();
    }
  });

  it('activates declarative tenantConfig.customFields (P7 / S0-12) at runtime, synthesises choice lists/values, and respects admin overrides in custom_field_definitions', async () => {
    const dbLists: TenantChoiceListRecord[] = [
      {
        key: 'work_type',
        label: 'Work Type',
        group: 'matter',
        appliesTo: ['matter'],
        allowMultiple: false,
        hierarchical: true,
      },
    ];
    const dbValues: TenantChoiceValueRecord[] = [];
    const dbFields: TenantCustomFieldDefinitionRecord[] = [
      {
        id: 'cf_admin_overridden',
        recordType: 'matter',
        label: 'Admin Customised Label',
        fieldType: 'text',
        section: 'matter_overview',
        required: true,
        sortOrder: 9,
        active: true,
      },
    ];

    const merged = mergeDeclarativeTenantConfigCustomFields(
      {
        customFields: [
          {
            id: 'cf_declarative_funding_tier',
            recordType: 'matter',
            label: 'Declarative Funding Tier',
            fieldType: 'choice',
            section: 'matter_funding',
            required: true,
            sortOrder: 1,
            active: true,
            options: ['Tier 1', 'Tier 2'],
          },
          {
            id: 'cf_admin_overridden',
            recordType: 'matter',
            label: 'Original Config Label',
            fieldType: 'text',
            section: 'matter_overview',
            required: false,
            sortOrder: 2,
            active: true,
          },
        ],
      },
      dbFields,
      dbLists,
      dbValues,
    );

    expect(merged.customFields).toHaveLength(2);
    const declField = merged.customFields.find(
      (f) => f.id === 'cf_declarative_funding_tier',
    );
    expect(declField).toMatchObject({
      id: 'cf_declarative_funding_tier',
      label: 'Declarative Funding Tier',
      fieldType: 'choice',
      optionsListKey: 'cf_declarative_funding_tier',
      required: true,
    });

    // Admin DB definition takes precedence over declarative config with the same id
    const overriddenField = merged.customFields.find(
      (f) => f.id === 'cf_admin_overridden',
    );
    expect(overriddenField?.label).toBe('Admin Customised Label');
    expect(overriddenField?.required).toBe(true);
    expect(overriddenField?.sortOrder).toBe(9);

    // Choice list and choice values were synthesised for the declarative choice field
    expect(
      merged.lists.some((l) => l.key === 'cf_declarative_funding_tier'),
    ).toBe(true);
    expect(
      merged.values
        .filter((v) => v.listKey === 'cf_declarative_funding_tier')
        .map((v) => v.label),
    ).toEqual(['Tier 1', 'Tier 2']);
  });

  it('persists firm profile, choice lists/values, custom fields, and all tenant module configs to PostgreSQL in the same transaction as audit_entries, and rolls back both on forced failure', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    await runWithActiveActorSession(actorSession, async () => {
      const store = resetStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store,
        modules: [
          'parties',
          'matters',
          'intake',
          'quotes',
          'tasks',
          'hr',
          'catalogues',
        ],
        clearFirst: true,
      });

      const catRepo = getCatalogueRepository();
      const auditRepo = new TenantAuditRepository();

      // 1. Mutate firm profile, choice value, custom field, and module configs via services & actions
      await catRepo.putFirmProfile(ctx, {
        firmId: store.firmId ?? ctx.tenantId,
        isCleanDeployment: Boolean(store.isCleanDeployment),
        firm: {
          ...store.firm,
          tradingName: 'Tenant Alpha Practice (Updated S0-17c)',
        },
      });
      expect(
        (await catRepo.getFirmProfile<{ tradingName: string }>(ctx))?.firm
          .tradingName,
      ).toBe('Tenant Alpha Practice (Updated S0-17c)');

      const addedChoice = await addChoiceValueAction({
        listKey: 'person_role',
        label: 'S0-17c PostgreSQL Advisor',
      });
      expect(isActionDenied(addedChoice)).toBe(false);
      const addedChoiceVal = addedChoice as TenantChoiceValueRecord;
      expect(
        (await catRepo.getChoiceValueById(ctx, addedChoiceVal.id))?.label,
      ).toBe('S0-17c PostgreSQL Advisor');

      const reorderedChoice = await reorderChoiceValueAction(
        addedChoiceVal.id,
        -1,
      );
      expect(reorderedChoice).toEqual({ ok: true });

      const updatedChoice = await updateChoiceValueAction(addedChoiceVal.id, {
        label: 'S0-17c Senior PostgreSQL Advisor',
      });
      expect(isActionDenied(updatedChoice)).toBe(false);
      expect(
        (await catRepo.getChoiceValueById(ctx, addedChoiceVal.id))?.label,
      ).toBe('S0-17c Senior PostgreSQL Advisor');

      const savedCf = await saveCustomFieldAction({
        recordType: 'matter',
        label: 'S0-17c Matter Priority Code',
        fieldType: 'text',
        section: 'matter_overview',
        required: false,
      });
      expect(isActionDenied(savedCf)).toBe(false);
      const savedCfDef = savedCf as TenantCustomFieldDefinitionRecord;
      expect(
        (await catRepo.getCustomFieldDefinitionById(ctx, savedCfDef.id))?.label,
      ).toBe('S0-17c Matter Priority Code');

      const reorderedCf = await reorderCustomFieldAction(savedCfDef.id, -1);
      expect(reorderedCf).toEqual({ ok: true });

      await saveEnquirySettingsRecord(
        { retentionMonths: 18 },
        'P-000001',
      );
      expect(await catRepo.getEnquirySettingsConfig(ctx)).toMatchObject({
        retentionMonths: 18,
      });

      await saveTaskSettingsRecord(
        {
          ...store.taskSettings,
        },
        'P-000001',
      );
      expect(await catRepo.getTaskSettingsConfig(ctx)).toMatchObject({
        templates: expect.any(Array),
      });

      await saveOrgStructure(store.orgStructure, 'P-000001');
      await updateWorkTypeProfiles(
        'work_type.commercial_property',
        ['PROP'],
        'P-000001',
      );
      await saveHomePagesConfig(
        {
          firmSettings: {
            ...store.homePagesConfig.firmSettings,
            wipAgeThresholdDays: 45,
          },
        },
        'P-000001',
        { mfaVerified: true },
      );
      await saveMatterCostsConfig(store.matterCostsConfig, 'P-000001');
      expect(
        await catRepo.getHomePagesConfig<{
          firmSettings: { wipAgeThresholdDays: number };
        }>(ctx),
      ).toMatchObject({
        firmSettings: {
          wipAgeThresholdDays: 45,
        },
      });

      // 2. Forced failure inside a single PostgreSQL transaction rolls back BOTH the catalogue row and the audit entry
      const auditCountBefore = await auditRepo.countAuditEntries(ctx);
      await expect(
        catRepo.withTenantTransaction(ctx, async () => {
          await catRepo.putChoiceValue(ctx, {
            id: 'person_role.rollback_test_s017c',
            listKey: 'person_role',
            label: 'Should Roll Back',
            parentId: null,
            sortOrder: 999,
            active: true,
          });
          await catRepo.appendCatalogueAuditEntriesInTx(ctx, [
            {
              recordType: 'list',
              recordId: 'person_role',
              action: 'list-change',
              field: 'Added rollback test value',
              oldValue: null,
              newValue: 'Should Roll Back',
              byId: 'P-000001',
            },
          ]);
          throw new Error('CATALOGUE_FORCED_AUDIT_ROLLBACK');
        }),
      ).rejects.toThrow('CATALOGUE_FORCED_AUDIT_ROLLBACK');

      // Verify on a fresh direct connection that neither the choice_values row nor the audit_entries row persisted
      const directClient = await createDirectMigrationClient({ ctx });
      try {
        const valRes = await directClient.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
             FROM public.choice_values
            WHERE tenant_id = $1 AND id = 'person_role.rollback_test_s017c'`,
          [ctx.tenantId],
        );
        expect(Number(valRes.rows[0]?.cnt)).toBe(0);
      } finally {
        await directClient.end();
      }
      const auditCountAfter = await auditRepo.countAuditEntries(ctx);
      expect(auditCountAfter).toBe(auditCountBefore);

      void addChoiceValue;
      void saveCustomFieldDefinition;
    });
  });

  it('survives a cold start / new replica (R465) and is immediately visible to a second replica (R466) without data/runtime-store.json', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    try {
      await runWithActiveActorSession(actorSession, async () => {
        await resetAllDemoData('P-000001', ctx);

        // 1. Write choice value, custom field, org structure change, and home pages config change via services
        const choiceVal = await addChoiceValue(
          {
            listKey: 'person_role',
            label: 'R465 Cold Start Specialist',
          },
          'P-000001',
        );
        const cfDef = await saveCustomFieldDefinition(
          {
            recordType: 'matter',
            label: 'R465 Cold Start Reference',
            fieldType: 'text',
            section: 'matter_overview',
            required: false,
          },
          'P-000001',
        );
        expect(isActionDenied(cfDef)).toBe(false);

        const snapBefore = await getAppSnapshot('P-000001');
        const updatedOrg = {
          ...snapBefore.orgStructure,
          departments: [
            ...snapBefore.orgStructure.departments,
            {
              id: 'DEPT-R465-COLD',
              code: 'R465',
              name: 'R465 Cold Start Department',
              parentDivisionId: 'DIV-LEGAL',
              defaultCostCentreId: 'CC-RE',
              defaultProfitCentreId: 'PC-RE',
              active: true,
            },
          ],
        };
        await saveOrgStructure(updatedOrg, 'P-000001');
        await saveHomePagesConfig(
          {
            firmSettings: {
              ...snapBefore.homePagesConfig.firmSettings,
              wipAgeThresholdDays: 77,
            },
          },
          'P-000001',
          { mfaVerified: true },
        );

        // 2. R466 Two-replica visibility: clear any in-process state without touching runtime-store.json
        const snapReplicaB = await getAppSnapshot('P-000001');
        expect(
          snapReplicaB.values.some(
            (v) =>
              v.id === choiceVal.id && v.label === 'R465 Cold Start Specialist',
          ),
        ).toBe(true);
        expect(
          snapReplicaB.customFields.some(
            (f) => f.id === cfDef.id && f.label === 'R465 Cold Start Reference',
          ),
        ).toBe(true);
        expect(
          snapReplicaB.orgStructure.departments.some(
            (d) => d.id === 'DEPT-R465-COLD',
          ),
        ).toBe(true);
        expect(
          snapReplicaB.homePagesConfig.firmSettings.wipAgeThresholdDays,
        ).toBe(77);

        // 3. R465 Cold-start survival: clear __oneSquared* globals, reset modules, and re-import services
        vi.resetModules();
        for (const k of Object.keys(globalThis)) {
          if (k.startsWith('__oneSquared')) {
            delete (globalThis as Record<string, unknown>)[k];
          }
        }
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;

        const replicaBServices = await import('@/server/services');
        const replicaBRbac = await import('@/server/rbacRuntime');
        const replicaBEntra = await import('@/server/entraAuth');

        const clearSpy = vi.spyOn(
          replicaBServices.getCatalogueRepository(),
          'clearTenantData',
        );

        const cfgB = getActiveTenantConfiguration();
        const cookieB = replicaBEntra.createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: cfgB.tenantId,
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000001',
          email: `p-000001@${cfgB.branding.primaryDomain}`,
          displayName: 'Test Actor P-000001',
          entraRoles: ['admin', 'managing_partner', 'partner'],
          mappedRoles: ['admin', 'managing_partner', 'partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const verifiedB =
          replicaBEntra.verifySignedEntraSessionCookie(cookieB)!;
        replicaBEntra.setTestEntraSessionOverride(verifiedB);

        await replicaBRbac.runWithActiveActorSession(
          {
            personId: 'P-000001',
            tenantId: cfgB.tenantId,
            tokenRoles: verifiedB.mappedRoles,
            mfaVerified: true,
            expiresAtMs: Date.now() + 3600_000,
            verifiedSession: verifiedB,
          },
          async () => {
            const snapAfterRestart =
              await replicaBServices.getAppSnapshot('P-000001');
            expect(
              snapAfterRestart.values.some(
                (v) =>
                  v.id === choiceVal.id &&
                  v.label === 'R465 Cold Start Specialist',
              ),
            ).toBe(true);
            expect(
              snapAfterRestart.customFields.some(
                (f) =>
                  f.id === cfDef.id && f.label === 'R465 Cold Start Reference',
              ),
            ).toBe(true);
            expect(
              snapAfterRestart.orgStructure.departments.some(
                (d) => d.id === 'DEPT-R465-COLD',
              ),
            ).toBe(true);
            expect(
              snapAfterRestart.homePagesConfig.firmSettings.wipAgeThresholdDays,
            ).toBe(77);
            expect(clearSpy).not.toHaveBeenCalled();
          },
        );
      });
    } finally {
      await resetAllDemoData('P-000001', ctx);
    }
  });

  it('enforces services-level Model B two-tenant isolation and cross-tenant ID rejection across catalogues and module configs (R467)', async () => {
    const rawBaseConfig = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const rawConfigA: Record<string, unknown> = {
      ...structuredClone(rawBaseConfig),
      tenantId: 'tenant-a',
      displayName: 'Tenant A Law LLP',
      hostingMode: 'multi_tenant',
    };
    const rawConfigB: Record<string, unknown> = {
      ...structuredClone(rawBaseConfig),
      tenantId: 'tenant-b',
      displayName: 'Tenant B Chambers LLP',
      hostingMode: 'multi_tenant',
    };
    setActiveTenantConfigForTesting(rawConfigA, {});
    const tenantACfg: TenantConfiguration = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(rawConfigB, {});
    const tenantBCfg: TenantConfiguration = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(null);

    const ctxA = makeTenantContext('tenant-a', 'P-000001');
    const ctxB = makeTenantContext('tenant-b', 'P-000001');

    const runInTenant = async <T>(
      rawCfg: Record<string, unknown>,
      cfg: TenantConfiguration,
      fn: () => Promise<T>,
    ): Promise<T> => {
      setActiveTenantConfigForTesting(rawCfg, {});
      const roles = [
        'admin',
        'managing_partner',
        'partner',
        'fee_earner',
        'enquiries_coordinator',
        'finance',
        'risk_compliance',
      ];
      const cookie = createSignedEntraSessionCookie({
        personId: 'P-000001',
        tenantId: cfg.tenantId,
        oid: '00000000-0000-4000-8000-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-000001',
        email: `p1@${cfg.branding.primaryDomain}`,
        displayName: `Actor ${cfg.tenantId}`,
        entraRoles: roles,
        mappedRoles: roles,
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const verified = verifySignedEntraSessionCookie(cookie)!;
      setTestEntraSessionOverride(verified);
      return runWithActiveActorSession(
        {
          personId: 'P-000001',
          tenantId: cfg.tenantId,
          tokenRoles: roles,
          mfaVerified: true,
          expiresAtMs: Date.now() + 3600_000,
          verifiedSession: verified,
        },
        fn,
      );
    };

    try {
      const seedA = createSeedStore();
      const seedB = createSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx: ctxA,
        store: seedA,
        tenantConfig: tenantACfg,
        modules: [
          'parties',
          'matters',
          'intake',
          'quotes',
          'tasks',
          'hr',
          'catalogues',
        ],
        clearFirst: true,
      });
      await importFirmStoreModulesToPostgres({
        ctx: ctxB,
        store: seedB,
        tenantConfig: tenantBCfg,
        modules: [
          'parties',
          'matters',
          'intake',
          'quotes',
          'tasks',
          'hr',
          'catalogues',
        ],
        clearFirst: true,
      });

      // Interleave service writes across Tenant A and Tenant B in the same process
      const tenantAResults = await runInTenant(
        rawConfigA,
        tenantACfg,
        async () => {
          const choiceA = await addChoiceValue(
            { listKey: 'person_role', label: 'Tenant A Exclusive Role' },
            'P-000001',
          );
          const cfA = await saveCustomFieldDefinition(
            {
              recordType: 'matter',
              label: 'Tenant A Matter Code',
              fieldType: 'text',
              section: 'matter_overview',
              required: false,
            },
            'P-000001',
          );
          const snapA = await getAppSnapshot('P-000001');
          await saveOrgStructure(
            {
              ...snapA.orgStructure,
              departments: [
                ...snapA.orgStructure.departments,
                {
                  id: 'DEPT-TENANT-A-ONLY',
                  code: 'TENA',
                  name: 'Tenant A Department',
                  parentDivisionId: 'DIV-LEGAL',
                  defaultCostCentreId: 'CC-RE',
                  defaultProfitCentreId: 'PC-RE',
                  active: true,
                },
              ],
            },
            'P-000001',
          );
          await saveMatterPartyRelationship(
            {
              code: 'TENA_PARTY',
              label: 'Tenant A Custom Party',
              description: 'Tenant A only',
              active: true,
              isNew: true,
            },
            'P-000001',
          );
          await saveHomePagesConfig(
            {
              firmSettings: {
                ...snapA.homePagesConfig.firmSettings,
                wipAgeThresholdDays: 61,
              },
            },
            'P-000001',
            { mfaVerified: true },
          );
          await saveMatterCostsConfig(
            {
              ...snapA.matterCostsConfig,
              sectionTitle: 'Tenant A Matter Costs',
            },
            'P-000001',
          );
          await saveEnquirySettingsRecord({ retentionMonths: 14 }, 'P-000001');
          await saveTaskSettingsRecord(
            {
              templates: snapA.taskSettings.templates.map((t) =>
                t.trigger === 'complete_matter_opening'
                  ? { ...t, label: 'Tenant A Template', dueWorkingDaysOffset: 11 }
                  : t,
              ),
            },
            'P-000001',
          );
          return { choiceA, cfA };
        },
      );

      const tenantBResults = await runInTenant(
        rawConfigB,
        tenantBCfg,
        async () => {
          const choiceB = await addChoiceValue(
            { listKey: 'person_role', label: 'Tenant B Exclusive Role' },
            'P-000001',
          );
          const cfB = await saveCustomFieldDefinition(
            {
              recordType: 'matter',
              label: 'Tenant B Matter Code',
              fieldType: 'text',
              section: 'matter_overview',
              required: false,
            },
            'P-000001',
          );
          const snapB = await getAppSnapshot('P-000001');
          await saveHomePagesConfig(
            {
              firmSettings: {
                ...snapB.homePagesConfig.firmSettings,
                wipAgeThresholdDays: 88,
              },
            },
            'P-000001',
            { mfaVerified: true },
          );
          await saveEnquirySettingsRecord({ retentionMonths: 36 }, 'P-000001');
          return { choiceB, cfB };
        },
      );

      // Verify Tenant A and Tenant B snapshots are strictly isolated
      await runInTenant(rawConfigA, tenantACfg, async () => {
        const snapA = await getAppSnapshot('P-000001');
        expect(
          snapA.values.some((v) => v.id === tenantAResults.choiceA.id),
        ).toBe(true);
        expect(
          snapA.values.some((v) => v.id === tenantBResults.choiceB.id),
        ).toBe(false);
        expect(
          snapA.customFields.some((f) => f.id === tenantAResults.cfA.id),
        ).toBe(true);
        expect(
          snapA.customFields.some((f) => f.id === tenantBResults.cfB.id),
        ).toBe(false);
        expect(
          snapA.orgStructure.departments.some(
            (d) => d.id === 'DEPT-TENANT-A-ONLY',
          ),
        ).toBe(true);
        expect(
          snapA.matterPartyTaxonomy.relationships.some(
            (r) => r.code === 'TENA_PARTY',
          ),
        ).toBe(true);
        expect(snapA.homePagesConfig.firmSettings.wipAgeThresholdDays).toBe(61);
        expect(snapA.matterCostsConfig.sectionTitle).toBe(
          'Tenant A Matter Costs',
        );
        expect(snapA.enquirySettings.retentionMonths).toBe(14);
        expect(
          snapA.taskSettings.templates.some(
            (t) =>
              t.trigger === 'complete_matter_opening' &&
              t.label === 'Tenant A Template' &&
              t.dueWorkingDaysOffset === 11,
          ),
        ).toBe(true);

        // Cross-tenant ID tampering from Tenant A against Tenant B's choice value and custom field is rejected with FORBIDDEN
        const tamperChoiceReorder = await reorderChoiceValue(
          tenantBResults.choiceB.id,
          -1,
          'P-000001',
        );
        expect(isActionDenied(tamperChoiceReorder)).toBe(true);

        const tamperCfSave = await saveCustomFieldDefinition(
          {
            id: tenantBResults.cfB.id,
            recordType: 'matter',
            label: 'Tampered From Tenant A',
            fieldType: 'text',
            section: 'matter_overview',
            required: false,
          },
          'P-000001',
        );
        expect(isActionDenied(tamperCfSave)).toBe(true);

        const tamperCfReorder = await reorderCustomField(
          tenantBResults.cfB.id,
          -1,
          'P-000001',
        );
        expect(isActionDenied(tamperCfReorder)).toBe(true);
      });

      await runInTenant(rawConfigB, tenantBCfg, async () => {
        const snapB = await getAppSnapshot('P-000001');
        expect(
          snapB.values.some((v) => v.id === tenantBResults.choiceB.id),
        ).toBe(true);
        expect(
          snapB.values.some((v) => v.id === tenantAResults.choiceA.id),
        ).toBe(false);
        expect(
          snapB.customFields.some(
            (f) =>
              f.id === tenantBResults.cfB.id &&
              f.label === 'Tenant B Matter Code',
          ),
        ).toBe(true);
        expect(
          snapB.customFields.some((f) => f.id === tenantAResults.cfA.id),
        ).toBe(false);
        expect(
          snapB.orgStructure.departments.some(
            (d) => d.id === 'DEPT-TENANT-A-ONLY',
          ),
        ).toBe(false);
        expect(
          snapB.matterPartyTaxonomy.relationships.some(
            (r) => r.code === 'TENA_PARTY',
          ),
        ).toBe(false);
        expect(snapB.homePagesConfig.firmSettings.wipAgeThresholdDays).toBe(88);
        expect(snapB.enquirySettings.retentionMonths).toBe(36);
        expect(
          snapB.taskSettings.templates.some(
            (t) => t.label === 'Tenant A Template',
          ),
        ).toBe(false);
      });
    } finally {
      setActiveTenantConfigForTesting(null);
      setTestEntraSessionOverride(null);
    }
  });

  it('never writes migrated S0-17c catalogue or module config keys to data/runtime-store.json (R468) and enforces R466/R470 code contracts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1sq-r468-cat-'));
    const runtimeStorePath = path.join(tmpDir, 'runtime-store.json');
    const prevStorePath = process.env.ONESQUARED_RUNTIME_STORE_PATH;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.ONESQUARED_RUNTIME_STORE_PATH = runtimeStorePath;
      (process.env as Record<string, string | undefined>).NODE_ENV =
        'development';
      saveStore(getStore());
      expect(fs.existsSync(runtimeStorePath)).toBe(true);
      const writtenJson = JSON.parse(
        fs.readFileSync(runtimeStorePath, 'utf8'),
      ) as Record<string, unknown>;
      const forbiddenStoreKeys = [
        'firmId',
        'isCleanDeployment',
        'firm',
        'lists',
        'values',
        'customFields',
        'orgStructure',
        'matterPartyTaxonomy',
        'matterPartyMigrationReport',
        'homePagesConfig',
        'matterCostsConfig',
        'enquirySettings',
        'taskSettings',
        'counters',
      ];
      for (const key of forbiddenStoreKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(writtenJson, key),
          `Expected data/runtime-store.json not to contain migrated key "${key}"`,
        ).toBe(false);
      }
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        prevNodeEnv;
      if (prevStorePath === undefined) {
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      } else {
        process.env.ONESQUARED_RUNTIME_STORE_PATH = prevStorePath;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // R466: Zero __oneSquared* globals in core/src/tenancy/catalogueRepository.ts
    const catRepoSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'core/src/tenancy/catalogueRepository.ts'),
      'utf8',
    );
    expect(catRepoSrc).not.toMatch(/__oneSquared/);

    // R470: Zero getSynchronizedTenantStoreSnapshot in src/ or core/
    const servicesSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/server/services.ts'),
      'utf8',
    );
    expect(servicesSrc).not.toContain('getSynchronizedTenantStoreSnapshot');

    const storeSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/server/store.ts'),
      'utf8',
    );
    expect(storeSrc).toContain('MOVED_TO_POSTGRES_STORE_KEYS');
    for (const movedKey of [
      'firmId',
      'firm',
      'isCleanDeployment',
      'lists',
      'values',
      'customFields',
      'formSections',
      'orgStructure',
      'matterPartyTaxonomy',
      'matterPartyMigrationReport',
      'homePagesConfig',
      'matterCostsConfig',
      'enquirySettings',
      'taskSettings',
      'dismissedDuplicates',
      'workTypeProfiles',
      'counters',
    ]) {
      expect(storeSrc).toContain(`'${movedKey}'`);
    }

    const forbiddenGetSaveFiles = [
      'src/server/authorize.ts',
      'src/server/documentGenerationServices.ts',
      'src/server/documentStoreServices.ts',
      'src/app/api/matters/extract/route.ts',
    ];
    for (const relPath of forbiddenGetSaveFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      expect(
        /\b(getStore|saveStore)\b/.test(content),
        `Expected zero getStore/saveStore references in ${relPath}`,
      ).toBe(false);
    }

    const actionsSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/app/actions.ts'),
      'utf8',
    );
    const getStoreMatches = [...actionsSrc.matchAll(/\bgetStore\s*\(/g)];
    expect(getStoreMatches.length).toBeLessThanOrEqual(1);
  });
});
