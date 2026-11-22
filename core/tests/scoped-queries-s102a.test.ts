import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPmsRepository,
  type TenantContext,
} from '@platform/core';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { setTestEntraSessionOverride } from '@/server/entraAuth';
import {
  getAppSnapshot,
  getClientPmsViewBundle,
  markQuoteSentRecord,
  runMatterConflictSearchRecord,
  findCandidateDuplicatesForRecord,
} from '@/server/services';
import { verifyFinanceActorAndPermission } from '@/server/financeServices';
import { computeMatterPartyUsageCounts } from '@/domain/matterParties';
import { loadAndValidateTenantConfig } from '../src/config-engine';
import notALawFirmConfig from '../../client-not-a-law-firm/config/base.json';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import type { Matter, Organisation, Person } from '@/domain/types';

function makeCtx(tenantId: string, actorId = 'P-000001'): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      roles: ['Admin', 'Partner'],
      mfaVerified: true,
    },
    correlationId: `s102a-${tenantId}-${actorId}`,
    environment: 'test',
    hostingMode: 'multi_tenant',
  });
}

describe('S1-02a B15: SQL-scoped repositories, Draft privacy, candidate parity, and zero write-on-read', () => {
  const originalConfig = getActiveTenantConfiguration();

  afterEach(async () => {
    setTestEntraSessionOverride(null);
    setActiveTenantConfigForTesting(originalConfig as unknown as Record<string, unknown>);
    await getGlobalTenantPostgresPoolManager().closeAllPools();
  });

  it('1. Migration 0024, employeesAndLeaversOnly filtering, and personal Draft privacy vs hasRestrictedMatterAccess', async () => {
    expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(24);

    const tenantAlpha = 's102a-alpha';
    const tenantBravo = 's102a-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeCtx(tenantAlpha, 'P-000001');
    const ctxBravo = makeCtx(tenantBravo, 'P-000001');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();

    // Seed an external contact vs employee + leaver via seed store into Alpha & Bravo
    const cfgAlpha = loadAndValidateTenantConfig(
      { ...notALawFirmConfig, tenantId: tenantAlpha },
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    setActiveTenantConfigForTesting(cfgAlpha as unknown as Record<string, unknown>);
    const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: cfgAlpha as never,
      store: seed,
      modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks'],
      clearFirst: true,
    });

    const staffOnly = await (
      partyRepo as unknown as {
        listAllPeople: (
          ctx: TenantContext,
          opts?: { employeesAndLeaversOnly?: boolean },
        ) => Promise<Array<{ id: string; isEmployee?: boolean }>>;
      }
    ).listAllPeople(ctxAlpha, { employeesAndLeaversOnly: true });
    expect(staffOnly.length).toBeGreaterThan(0);
    expect(staffOnly.length).toBeLessThan(seed.people.length);
    expect(staffOnly.every((p) => Boolean(p.isEmployee))).toBe(true);

    // Personal Draft privacy vs hasRestrictedMatterAccess
    const creatorId = 'P-000002';
    const restrictedPartnerId = 'P-000001';
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-S102A-DRAFT-PRIVATE',
      reference: 'ENQ-999001',
      status: 'Draft',
      createdById: creatorId,
      takenById: creatorId,
      firstName: 'Secret',
      lastName: 'Drafter',
      email: 'draft@invented.example',
      phone: '07700900111',
      receivedAt: '2026-11-01T10:00:00Z',
    } as never);

    // Restricted matter + linked submitted enquiry + linked quote
    await matterRepo.putMatter(ctxAlpha, {
      id: 'M-S102A-RESTRICTED',
      matterNumber: 'MAT-S102A-R1',
      title: 'Restricted Matter S102A',
      shortDescription: 'Confidential',
      clientId: seed.matters[0]!.clientId,
      responsiblePartnerId: creatorId,
      isStaffMatter: true,
      hasEthicalWall: false,
      restrictedAccessUserIds: [creatorId],
      parties: [],
    } as never);
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-S102A-RESTRICTED-REF',
      reference: 'ENQ-999002',
      status: 'Assigned',
      createdById: creatorId,
      takenById: creatorId,
      firstName: 'Referred',
      lastName: 'Client',
      convertedMatterId: 'M-S102A-RESTRICTED',
      receivedAt: '2026-11-01T10:05:00Z',
    } as never);

    const listAsRestrictedHolder = await (
      intakeRepo as unknown as {
        listVisibleEnquiries: (
          ctx: TenantContext,
          viewerId: string,
          opts?: { hasRestrictedMatterAccess?: boolean },
        ) => Promise<Array<{ id: string }>>;
      }
    ).listVisibleEnquiries(ctxAlpha, restrictedPartnerId, {
      hasRestrictedMatterAccess: true,
    });
    const visibleIds = listAsRestrictedHolder.map((e) => e.id);
    // Restricted-matter permission DOES allow restricted-matter-linked submitted enquiry...
    expect(visibleIds).toContain('ENQ-S102A-RESTRICTED-REF');
    // ...but MUST NEVER expose another user's personal Draft enquiry!
    expect(visibleIds).not.toContain('ENQ-S102A-DRAFT-PRIVATE');

    // Cross-tenant tampered enquiry/matter lookup returns null and never touches Bravo
    const crossEnq = await intakeRepo.getEnquiryById(
      ctxBravo,
      'ENQ-S102A-RESTRICTED-REF',
      { includeRestricted: true },
    );
    expect(crossEnq).toBeNull();
  });

  it('2. getAppSnapshotInScope removes putQuote write-on-read and reflects Expired display status read-only', async () => {
    const tenantId = 's102a-alpha';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId, environment: 'test' }],
    });
    const ctx = makeCtx(tenantId, 'P-000001');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctx);

    const cfg = loadAndValidateTenantConfig(
      { ...notALawFirmConfig, tenantId },
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    setActiveTenantConfigForTesting(cfg as unknown as Record<string, unknown>);

    const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
    await importFirmStoreModulesToPostgres({
      ctx,
      tenantConfig: cfg as never,
      store: seed,
      modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks'],
      clearFirst: true,
    });

    const intakeRepo = new TenantIntakeQuoteRepository();
    await intakeRepo.putQuote(ctx, {
      id: 'QT-S102A-EXP',
      reference: 'Q-99901',
      status: 'Sent',
      validUntil: '2020-01-01',
      preparedById: 'P-000001',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
      timeline: [],
    } as never);

    setTestEntraSessionOverride({
      personId: 'P-000001',
      tenantId,
      oid: 'oid-s102a-p1',
      tid: 'tid-s102a',
      sub: 'P-000001',
      email: 'p1@notalawfirm.example',
      displayName: 'Partner One',
      entraRoles: ['Admin', 'Partner'],
      mappedRoles: ['Admin', 'Partner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const snap = await getAppSnapshot('P-000001');
    const returnedQuote = snap.quotes.find((q) => q.id === 'QT-S102A-EXP');
    expect(returnedQuote?.status).toBe('Expired');

    // Persisted DB row MUST remain untouched ('Sent') with zero write-on-read!
    const persistedAfterRead = await intakeRepo.getQuoteById<{
      status: string;
    }>(ctx, 'QT-S102A-EXP', { includeRestricted: true });
    expect(persistedAfterRead?.status).toBe('Sent');
  });

  it('3. Candidate parity (trigram typo, Metaphone sound-alike, phone last-9, company number, corporate group), PMS SQL rollups, and forged-claim rejection', async () => {
    const tenantAlpha = 's102a-alpha';
    const tenantBravo = 's102a-bravo';
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });
    const ctxAlpha = makeCtx(tenantAlpha, 'P-000001');
    const ctxBravo = makeCtx(tenantBravo, 'P-000001');
    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    const cfgAlpha = loadAndValidateTenantConfig(
      { ...notALawFirmConfig, tenantId: tenantAlpha },
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    const cfgBravo = loadAndValidateTenantConfig(
      { ...notALawFirmConfig, tenantId: tenantBravo },
      { environment: 'test' },
      'test',
      'multi_tenant',
    );
    setActiveTenantConfigForTesting(cfgAlpha as unknown as Record<string, unknown>);
    const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: cfgAlpha as never,
      store: seed,
      modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks'],
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: cfgBravo as never,
      store: seed,
      modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks'],
      clearFirst: true,
    });

    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const pmsRepo = new TenantPmsRepository() as unknown as {
      listFeeEarnersOnly: (ctx: TenantContext) => Promise<unknown[]>;
      getFirmFinanceRollupsSql: (ctx: TenantContext) => Promise<unknown>;
    };
    expect(typeof pmsRepo.listFeeEarnersOnly).toBe('function');
    expect(typeof pmsRepo.getFirmFinanceRollupsSql).toBe('function');

    // Seed invented person & corporate-group org + multi-capacity matter in Alpha only
    const basePerson = structuredClone(
      seed.people.find((p) => !p.isEmployee) ?? seed.people[0]!,
    ) as Person;
    const alphaOnlyPerson: Person = {
      ...basePerson,
      id: 'P-S102A-FUZZY-1',
      firstName: 'Jonathan',
      surname: 'Thompson',
      preferredName: '',
      isEmployee: false,
      emails: [
        {
          id: 'em-s102a-1',
          address: 'j.thompson@invented.example',
          typeId: 'email_type.personal',
          isPrimary: true,
        },
      ],
      phones: [
        {
          id: 'ph-s102a-1',
          number: '07700 900123',
          typeId: 'phone_type.mobile',
        },
      ],
      notDuplicateOf: [],
    };
    await partyRepo.putPerson(ctxAlpha, alphaOnlyPerson);

    const parentOrg: Organisation = {
      ...(structuredClone(seed.organisations[0]!) as Organisation),
      id: 'O-S102A-PARENT',
      legalName: 'S102A Alpha Holdings Ltd',
      companyNumber: '09988776',
      parentOrganisationId: null,
      notDuplicateOf: [],
    };
    const subOrg: Organisation = {
      ...(structuredClone(seed.organisations[0]!) as Organisation),
      id: 'O-S102A-SUB',
      legalName: 'S102A Alpha Subsidiary Ltd',
      companyNumber: '09988777',
      parentOrganisationId: 'O-S102A-PARENT',
      notDuplicateOf: [],
    };
    await partyRepo.putOrganisation(ctxAlpha, parentOrg);
    await partyRepo.putOrganisation(ctxAlpha, subOrg);

    // SQL candidate recall matches Metaphone/trigram typo + normalised phone last-9
    const dupCandidates = await partyRepo.findSqlDuplicateCandidates<Person>(
      ctxAlpha,
      {
        kind: 'person',
        id: 'P-S102A-PROBE',
        firstName: 'Jon',
        surname: 'Thompsn',
        phones: ['+44 7700 900123'],
        fuzzy: true,
      },
    );
    expect(dupCandidates.some((p) => p.id === 'P-S102A-FUZZY-1')).toBe(true);

    setTestEntraSessionOverride({
      personId: 'P-000002',
      tenantId: tenantAlpha,
      oid: 'oid-s102a-p2',
      tid: 'tid-s102a',
      sub: 'P-000002',
      email: 'p2@notalawfirm.example',
      displayName: 'Fee Earner Two',
      entraRoles: [],
      mappedRoles: [],
      entraGroups: [],
      mfaVerified: false,
      amr: [],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const dupServiceHits = await findCandidateDuplicatesForRecord(
      {
        ...alphaOnlyPerson,
        id: 'P-S102A-NEW-PROBE',
        firstName: 'Jon',
        surname: 'Thompsn',
        emails: [],
        phones: [
          {
            id: 'ph-s102a-probe',
            number: '+44 7700 900123',
            typeId: 'phone_type.mobile',
          },
        ],
      },
      { ctx: ctxAlpha },
    );
    expect(dupServiceHits.some((r) => r.id === 'P-S102A-FUZZY-1')).toBe(true);

    // Restricted matter conflict redaction + corporate group link in Alpha
    const alphaRestrictedMatter: Matter = {
      ...(structuredClone(seed.matters[0]!) as Matter),
      id: 'M-S102A-CONFLICT-R',
      matterNumber: 'MAT-S102A-CR1',
      title: 'Confidential Staff Acquisition',
      clientId: 'O-S102A-SUB',
      responsiblePartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000001',
      teamMemberIds: ['P-000001'],
      isStaffMatter: true,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-000001'],
      parties: [
        {
          id: 'mp-s102a-1',
          relationshipCode: 'OP',
          capacityCodes: ['CAP_WITNESS', 'CAP_EXPERT'],
          entityType: 'person',
          linkedRecordId: 'P-S102A-FUZZY-1',
          name: 'Jonathan Thompson',
          role: 'Other party',
          notes: '',
        },
      ],
    };
    await matterRepo.putMatter(ctxAlpha, alphaRestrictedMatter);

    const conflictRes = await runMatterConflictSearchRecord(
      {
        currentMatterId: seed.matters[0]!.id,
        parties: [
          {
            id: 'cp-probe-parent',
            name: 'S102A Alpha Holdings Ltd',
            entityType: 'organisation',
            role: 'Client',
            linkedRecordId: 'O-S102A-PARENT',
          },
        ],
      },
      'P-000002',
    );
    const restrictedHit = conflictRes.matches.find((m) => m.restricted === true);
    expect(restrictedHit).toBeDefined();
    expect(restrictedHit?.matchedRecordId).toBe('');
    expect(restrictedHit?.matchedRecordName).toBe('Match on a restricted matter');
    expect(restrictedHit?.matterNumber).toBeNull();
    expect(JSON.stringify(restrictedHit)).not.toContain('Confidential Staff Acquisition');

    // SQL countMatterPartyUsages matches computeMatterPartyUsageCounts across CL + multi-capacity matter_parties
    const allAlphaMatters = await matterRepo.listAllMattersUnfiltered<Matter>(ctxAlpha);
    const domainUsage = computeMatterPartyUsageCounts(allAlphaMatters);
    const sqlClCount = await matterRepo.countMatterPartyUsages(ctxAlpha, {
      relationshipTypeId: 'CL',
    });
    const sqlExpertCount = await matterRepo.countMatterPartyUsages(ctxAlpha, {
      capacityId: 'CAP_EXPERT',
    });
    expect(sqlClCount).toBe(domainUsage.byRelationshipCode['CL'] ?? 0);
    expect(sqlExpertCount).toBe(domainUsage.byCapacityCode['CAP_EXPERT'] ?? 0);

    // Tampered cross-tenant ID & forged tenant claims fail closed
    setActiveTenantConfigForTesting(cfgBravo as unknown as Record<string, unknown>);
    setTestEntraSessionOverride({
      personId: 'P-000001',
      tenantId: tenantBravo,
      oid: 'oid-s102a-bravo-p1',
      tid: 'tid-s102a-bravo',
      sub: 'P-000001',
      email: 'p1@notalawfirm.example',
      displayName: 'Partner One',
      entraRoles: ['Admin', 'Partner'],
      mappedRoles: ['Admin', 'Partner'],
      entraGroups: [],
      mfaVerified: true,
      amr: ['mfa'],
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const crossTenantOrgRes = await getClientPmsViewBundle(
      'organisation',
      'O-S102A-SUB',
      'P-000001',
    );
    expect('code' in crossTenantOrgRes && crossTenantOrgRes.code).toBe('FORBIDDEN');

    const crossQuoteRes = await markQuoteSentRecord('QT-NONEXISTENT-999', 'P-000001');
    expect(crossQuoteRes.code).toBe('FORBIDDEN');

    const forgedCtx = {
      ...ctxBravo,
      tenantId: tenantAlpha,
    } as TenantContext;
    await expect(
      verifyFinanceActorAndPermission(forgedCtx, 'finance:view'),
    ).rejects.toThrow();
  });
});
