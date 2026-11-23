import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantHrAndRbacRepository,
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
  buildRecordVisibility,
  EMPTY_HIDDEN_KEY_DATE_IDS,
} from '@/server/visibility';
import {
  extractConflictSignalsFromParties,
  getAppSnapshot,
  getClientPmsViewBundle,
  loadFullConflictSearchGraph,
  loadScopedConflictSearchGraphForParity,
  markQuoteSentRecord,
  runMatterConflictSearchRecord,
  findCandidateDuplicatesForRecord,
} from '@/server/services';
import { searchMatterConflicts } from '@/domain/matterConflicts';
import { runEnquiryConflictSearch } from '@/domain/enquiries';
import { verifyFinanceActorAndPermission } from '@/server/financeServices';
import { computeMatterPartyUsageCounts } from '@/domain/matterParties';
import { loadAndValidateTenantConfig } from '../src/config-engine';
import notALawFirmConfig from '../../client-not-a-law-firm/config/base.json';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import type { ConflictCheckParty, Enquiry, Matter, Organisation, Person, Team } from '@/domain/types';

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

  it('R662: findSqlConflictCandidates traverses multi-hop merge_history chains before hydrating people and organisations across two tenants', async () => {
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
    await partyRepo.clearTenantData(ctxAlpha);
    await partyRepo.clearTenantData(ctxBravo);

    await partyRepo.putPerson(ctxAlpha, {
      id: 'P-R662-OLDEST',
      recordType: 'person',
      firstName: 'OldestAlias',
      surname: 'MergeChainOne',
      mergedIntoId: 'P-R662-MID',
      emails: [],
      phones: [],
      addresses: [],
      relationshipRoleIds: [],
      notDuplicateOf: [],
    } as never);
    await partyRepo.putPerson(ctxAlpha, {
      id: 'P-R662-MID',
      recordType: 'person',
      firstName: 'MiddleAlias',
      surname: 'MergeChainTwo',
      mergedIntoId: 'P-R662-SURVIVOR',
      emails: [],
      phones: [],
      addresses: [],
      relationshipRoleIds: [],
      notDuplicateOf: [],
    } as never);
    await partyRepo.putPerson(ctxAlpha, {
      id: 'P-R662-SURVIVOR',
      recordType: 'person',
      firstName: 'SurvivorActual',
      surname: 'MergeChainThree',
      mergedIntoId: null,
      emails: [],
      phones: [],
      addresses: [],
      relationshipRoleIds: [],
      notDuplicateOf: [],
    } as never);

    await partyRepo.putMergeHistory(ctxAlpha, {
      id: 'MRG-R662-1',
      recordType: 'person',
      mergedId: 'P-R662-OLDEST',
      survivorId: 'P-R662-MID',
      byId: 'P-000001',
      at: '2026-11-01T10:00:00Z',
    } as never);
    await partyRepo.putMergeHistory(ctxAlpha, {
      id: 'MRG-R662-2',
      recordType: 'person',
      mergedId: 'P-R662-MID',
      survivorId: 'P-R662-SURVIVOR',
      byId: 'P-000001',
      at: '2026-11-01T11:00:00Z',
    } as never);

    const bySeedId = await partyRepo.findSqlConflictCandidates(ctxAlpha, {
      linkedPersonIds: ['P-R662-OLDEST'],
    });
    const bySeedIds = bySeedId.people.map((p) => p.id);
    expect(bySeedIds).toContain('P-R662-OLDEST');
    expect(bySeedIds).toContain('P-R662-MID');
    expect(bySeedIds).toContain('P-R662-SURVIVOR');

    const byMergedTerm = await partyRepo.findSqlConflictCandidates(ctxAlpha, {
      terms: ['OldestAlias MergeChainOne'],
    });
    const byTermIds = byMergedTerm.people.map((p) => p.id);
    expect(byTermIds).toContain('P-R662-OLDEST');
    expect(byTermIds).toContain('P-R662-SURVIVOR');

    // Second tenant isolation: Bravo sees zero Alpha merge chain records
    const bravoBySeed = await partyRepo.findSqlConflictCandidates(ctxBravo, {
      linkedPersonIds: ['P-R662-OLDEST'],
    });
    expect(bravoBySeed.people).toEqual([]);
  });

  it('R665: findSqlDuplicateCandidates preserves reverse containment (short stored name in long query) and non-UK/partial/billingAddress postcodes across two tenants', async () => {
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
    await partyRepo.clearTenantData(ctxAlpha);
    await partyRepo.clearTenantData(ctxBravo);

    await partyRepo.putOrganisation(ctxAlpha, {
      id: 'O-R665-SHORT',
      recordType: 'organisation',
      legalName: 'Ace',
      otherNames: [{ id: 'on-r665', name: 'OakFormer' }],
      registeredAddress: { line1: '350 5th Ave', postcode: '10001' },
      billingAddress: { line1: '10 Rue de Rivoli', postcode: '75008' },
      relationshipTypeIds: [],
      notDuplicateOf: [],
    } as never);

    await partyRepo.putPerson(ctxAlpha, {
      id: 'P-R665-NONUK',
      recordType: 'person',
      firstName: 'Aoife',
      surname: 'Murphy',
      emails: [],
      phones: [],
      addresses: [
        { id: 'ad-1', line1: '14 St Stephen Green', postcode: 'D02 X285' },
        { id: 'ad-2', line1: '2 Queen St', postcode: 'CF10' },
      ],
      relationshipRoleIds: [],
      notDuplicateOf: [],
    } as never);

    // Reverse substring containment: short stored name inside long query string
    const reverseLegal = await partyRepo.findSqlDuplicateCandidates<Organisation>(
      ctxAlpha,
      {
        kind: 'organisation',
        legalName: 'Acewidgets International Holdings Group',
        fuzzy: true,
      },
    );
    expect(reverseLegal.some((o) => o.id === 'O-R665-SHORT')).toBe(true);

    const reverseOther = await partyRepo.findSqlDuplicateCandidates<Organisation>(
      ctxAlpha,
      {
        kind: 'organisation',
        legalName: 'Oakformer International Holdings Group',
        fuzzy: true,
      },
    );
    expect(reverseOther.some((o) => o.id === 'O-R665-SHORT')).toBe(true);

    // Non-UK postcodes (registeredAddress + billingAddress) & partial UK postcode
    const byUsZip = await partyRepo.findSqlDuplicateCandidates<Organisation>(
      ctxAlpha,
      { kind: 'organisation', postcodes: ['10001'], fuzzy: true },
    );
    expect(byUsZip.some((o) => o.id === 'O-R665-SHORT')).toBe(true);

    const byBillingFr = await partyRepo.findSqlDuplicateCandidates<Organisation>(
      ctxAlpha,
      { kind: 'organisation', postcodes: ['75008'], fuzzy: true },
    );
    expect(byBillingFr.some((o) => o.id === 'O-R665-SHORT')).toBe(true);

    const byEircode = await partyRepo.findSqlDuplicateCandidates<Person>(
      ctxAlpha,
      { kind: 'person', postcodes: ['D02 X285'], fuzzy: true },
    );
    expect(byEircode.some((p) => p.id === 'P-R665-NONUK')).toBe(true);

    const byPartialUk = await partyRepo.findSqlDuplicateCandidates<Person>(
      ctxAlpha,
      { kind: 'person', postcodes: ['CF10'], fuzzy: true },
    );
    expect(byPartialUk.some((p) => p.id === 'P-R665-NONUK')).toBe(true);

    // Second tenant isolation
    expect(
      await partyRepo.findSqlDuplicateCandidates(ctxBravo, {
        kind: 'organisation',
        legalName: 'Acewidgets International Holdings Group',
        postcodes: ['10001', '75008'],
        fuzzy: true,
      }),
    ).toEqual([]);
  });

  it('R659: 8-scenario two-tenant conflict parity harness (full graph vs scoped candidate pre-filter + live Option 1 redaction)', async () => {
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
    const intakeRepo = new TenantIntakeQuoteRepository();
    const hrRepo = new TenantHrAndRbacRepository();

    const basePerson = structuredClone(
      seed.people.find((p) => !p.isEmployee) ?? seed.people[0]!,
    ) as Person;
    const baseOrg = structuredClone(seed.organisations[0]!) as Organisation;
    const rawBaseMatter = structuredClone(seed.matters[0]!) as Matter;
    const baseMatter: Matter = {
      ...rawBaseMatter,
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      sourceEnquiryId: null,
    };

    // Neutral unlinked client org so Scenarios 1–6 do not share links with seed O-000001
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R659-NEUTRAL-CLIENT',
      legalName: 'Neutral Fixture Client Corp',
      otherNames: [],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: null,
      notDuplicateOf: [],
    });

    // Scenario 1: Linked person -> org counterpart matched against a FREE-TEXT matter party
    await partyRepo.putPerson(ctxAlpha, {
      ...basePerson,
      id: 'P-R659-LNK-1',
      firstName: 'Celyn',
      surname: 'Owen',
      emails: [],
      phones: [],
      addresses: [],
      notDuplicateOf: [],
    });
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R659-LNK-CO',
      legalName: 'Snowdonia Counterpart Logistics Ltd',
      otherNames: [],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: null,
      notDuplicateOf: [],
    });
    await partyRepo.putLink(ctxAlpha, {
      id: 'LNK-R659-1',
      personId: 'P-R659-LNK-1',
      organisationId: 'O-R659-LNK-CO',
      jobTitle: 'Director',
      department: '',
      roleWithinOrganisation: 'Director',
      isPrimaryContact: true,
      isCurrent: true,
      startDate: '2024-01-01',
      endDate: null,
      contactStatusId: null,
      contactRoleIds: [],
      notes: '',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    } as never);
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S1-FREE',
      matterNumber: 'MAT-R659-01',
      title: 'Scenario 1 Link Counterpart Free Text Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [
        {
          id: 'mp-r659-s1',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'organisation',
          linkedRecordId: null,
          name: 'Snowdonia Counterpart Logistics Ltd',
          role: 'Opponent',
          notes: '',
        },
      ],
    });

    // Scenario 2: Referrer person on matter & referrer person on enquiry
    await partyRepo.putPerson(ctxAlpha, {
      ...basePerson,
      id: 'P-R659-REF',
      firstName: 'Huw',
      surname: 'ReferrerTarget',
      emails: [],
      phones: [],
      addresses: [],
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S2-REF',
      matterNumber: 'MAT-R659-02',
      title: 'Scenario 2 Matter Referrer',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: 'P-R659-REF',
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [],
    });
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R659-S2-REF',
      reference: 'ENQ-R659-02',
      status: 'Assigned',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Client',
      lastName: 'OnRefEnq',
      email: 'client-ref-enq@invented.example',
      phone: '',
      referrerPersonId: 'P-R659-REF',
      otherPartiesNamed: 'Huw ReferrerTarget',
      summary: 'Scenario 2 Referrer Enquiry',
      receivedAt: '2026-11-02T10:00:00Z',
    } as never);

    // Scenario 3: > 8 parties/terms (hit on party #10)
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S3-TENPLUS',
      matterNumber: 'MAT-R659-03',
      title: 'Scenario 3 Tenth Party Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [
        {
          id: 'mp-r659-s3',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'organisation',
          linkedRecordId: null,
          name: 'Decimus Tenth Party Target Ltd',
          role: 'Opponent',
          notes: '',
        },
      ],
    });

    // Scenario 4: Linked organisation's former name held as separate record in otherNames
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R659-S4-LINKED',
      legalName: 'Calderwood Current Co Ltd',
      otherNames: [{ id: 'on-r659-s4', typeId: 'ont-former', name: 'Meridian Former Legacy Co' }],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: null,
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S4-FORMER',
      matterNumber: 'MAT-R659-04',
      title: 'Scenario 4 Former Name Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [
        {
          id: 'mp-r659-s4',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'organisation',
          linkedRecordId: null,
          name: 'Meridian Former Legacy Co',
          role: 'Opponent',
          notes: '',
        },
      ],
    });

    // Scenario 4b (R685): Former name held as a separate linked organisation record under O-R659-S4-LINKED
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R685-FORMER-LINKED',
      legalName: 'Meridian Legacy Subsidiary Ltd',
      otherNames: [
        { id: 'on-r685-s4b', typeId: 'ont-former', name: 'Meridian Former Standalone Corp' },
      ],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: 'O-R659-S4-LINKED',
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R685-S4B-ORG',
      matterNumber: 'MAT-R685-4B',
      title: 'Scenario 4b Linked Former Org Matter',
      clientId: 'O-R685-FORMER-LINKED',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [],
    });

    // Scenario 5: previousNames with separators ("Meyrick, Bowen; Parry / Pritchard")
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S5-PREVSEP',
      matterNumber: 'MAT-R659-05',
      title: 'Scenario 5 Separator PreviousNames Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [
        {
          id: 'mp-r659-s5',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'person',
          linkedRecordId: null,
          name: 'Bowen',
          role: 'Opponent',
          notes: '',
        },
      ],
    });

    // Scenario 6: Email-address party
    await partyRepo.putPerson(ctxAlpha, {
      ...basePerson,
      id: 'P-R659-S6-EMAIL',
      firstName: 'Hidden',
      surname: 'EmailOwner',
      emails: [
        {
          id: 'em-r659-s6',
          address: 'conflict-email-hit@invented.example',
          typeId: 'email_type.work',
          isPrimary: true,
        },
      ],
      phones: [],
      addresses: [],
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S6-EMAIL',
      matterNumber: 'MAT-R659-06',
      title: 'Scenario 6 Email Hit Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [
        {
          id: 'mp-r659-s6',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'person',
          linkedRecordId: 'P-R659-S6-EMAIL',
          name: 'Hidden EmailOwner',
          role: 'Opponent',
          notes: '',
        },
      ],
    });

    // Scenario 7: Company number (second company number in multi-party input)
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R659-S7-COMPNO',
      legalName: 'Zirconium Distinct Enterprise Ltd',
      otherNames: [],
      companyNumber: '09222333',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: null,
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S7-COMPNO',
      matterNumber: 'MAT-R659-07',
      title: 'Scenario 7 Company Number Matter',
      clientId: 'O-R659-S7-COMPNO',
      additionalClientIds: [],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: false,
      hasEthicalWall: false,
      restrictedAccessUserIds: [],
      parties: [],
    });

    // Scenario 8: Restricted + ethical wall matter + restricted enquiry
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R659-S8-WALL',
      legalName: 'Walled Restricted Target Group',
      otherNames: [],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      notDuplicateOf: [],
    });
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R659-S8-WALL',
      matterNumber: 'MAT-R659-08',
      title: 'Confidential Staff Ethical Wall Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      responsiblePartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000001',
      teamMemberIds: ['P-000001'],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      isStaffMatter: true,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-000001'],
      parties: [
        {
          id: 'mp-r659-s8',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'organisation',
          linkedRecordId: 'O-R659-S8-WALL',
          name: 'Walled Restricted Target Group',
          role: 'Opponent',
          notes: '',
        },
      ],
    });
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R659-S8-PRIV',
      reference: 'ENQ-R659-08',
      status: 'Draft',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Private',
      lastName: 'DraftWall',
      otherPartiesNamed: 'Walled Restricted Target Group',
      summary: 'Private Draft Wall Enquiry',
      receivedAt: '2026-11-02T11:00:00Z',
    } as never);

    // R676 Fixture A: Staff matter with EMPTY allow-list where P-000002 is responsiblePartnerId
    await matterRepo.putMatter(
      ctxAlpha,
      {
        ...baseMatter,
        id: 'M-R676-STAFF-EMPTY',
        matterNumber: 'MAT-R676-SE',
        title: 'Staff Empty Allowlist Matter',
        clientId: 'O-R659-NEUTRAL-CLIENT',
        additionalClientIds: [],
        responsiblePartnerId: 'P-000002',
        supervisingPartnerId: null,
        leadFeeEarnerId: 'P-000002',
        teamMemberIds: ['P-000002'],
        instructingContactId: null,
        billingContactId: null,
        referrerContactId: null,
        sourceEnquiryId: 'ENQ-R676-STAFF-EMPTY',
        isStaffMatter: true,
        hasEthicalWall: false,
        restrictedAccessUserIds: [],
        parties: [
          {
            id: 'mp-r676-se',
            relationshipCode: 'OP',
            capacityCodes: [],
            entityType: 'person',
            linkedRecordId: null,
            name: 'Bramwell EmptyAllowStaff',
            role: 'Opponent',
            notes: '',
          },
        ],
      },
      { sqlRestrictedAccessUserIds: [] },
    );
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R676-STAFF-EMPTY',
      reference: 'ENQ-R676-SE',
      status: 'Converted',
      createdById: 'P-000001',
      takenById: 'P-000001',
      convertedMatterId: 'M-R676-STAFF-EMPTY',
      firstName: 'Bramwell',
      lastName: 'EmptyAllowStaff',
      summary: 'Staff Empty Allowlist Converted Source Enquiry',
      receivedAt: '2026-11-02T11:05:00Z',
    } as never);

    // R676 Fixture B: Ethical wall with explicit non-empty allow-list ['P-000001'] where P-000002 is responsiblePartnerId (S1-D12: explicit allow-list wins)
    await matterRepo.putMatter(ctxAlpha, {
      ...baseMatter,
      id: 'M-R676-WALL-EXPLICIT',
      matterNumber: 'MAT-R676-WE',
      title: 'Wall Explicit Allowlist Matter',
      clientId: 'O-R659-NEUTRAL-CLIENT',
      additionalClientIds: [],
      responsiblePartnerId: 'P-000002',
      supervisingPartnerId: null,
      leadFeeEarnerId: 'P-000002',
      teamMemberIds: ['P-000002'],
      instructingContactId: null,
      billingContactId: null,
      referrerContactId: null,
      sourceEnquiryId: 'ENQ-R676-WALL-EXPLICIT',
      isStaffMatter: false,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-000001'],
      parties: [
        {
          id: 'mp-r676-we',
          relationshipCode: 'OP',
          capacityCodes: [],
          entityType: 'person',
          linkedRecordId: null,
          name: 'Cromwell WallExplicitTarget',
          role: 'Opponent',
          notes: '',
        },
      ],
    });
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R676-WALL-EXPLICIT',
      reference: 'ENQ-R676-WE',
      status: 'Converted',
      createdById: 'P-000001',
      takenById: 'P-000001',
      convertedMatterId: 'M-R676-WALL-EXPLICIT',
      firstName: 'Cromwell',
      lastName: 'WallExplicitTarget',
      summary: 'Explicit Wall Converted Source Enquiry',
      receivedAt: '2026-11-02T11:10:00Z',
    } as never);

    const parties: ConflictCheckParty[] = [
      // #1 Link counterpart (S1)
      {
        id: 'cp-r659-1',
        name: 'Celyn Owen',
        entityType: 'person',
        role: 'Client',
        linkedRecordId: 'P-R659-LNK-1',
        isClientFixed: true,
      },
      // #2-#9 Filler parties + Referrer (S2) + Former Name Linked Org (S4) + PreviousNames w/ separators (S5) + Email party (S6) + 2 companyNumbers (S7)
      {
        id: 'cp-r659-2',
        name: 'Huw ReferrerTarget',
        entityType: 'person',
        role: 'Referrer',
        linkedRecordId: 'P-R659-REF',
      },
      {
        id: 'cp-r659-3',
        name: 'Calderwood Current Co Ltd',
        entityType: 'organisation',
        role: 'Client',
        linkedRecordId: 'O-R659-S4-LINKED',
      },
      {
        id: 'cp-r659-4',
        name: 'Kestrel Random Witness',
        entityType: 'person',
        role: 'Witness',
        linkedRecordId: null,
        identifiers: { previousNames: 'Meyrick, Bowen; Parry / Pritchard' },
      },
      {
        id: 'cp-r659-5',
        name: 'conflict-email-hit@invented.example',
        entityType: 'person',
        role: 'Other party',
        linkedRecordId: null,
      },
      {
        id: 'cp-r659-6',
        name: 'Quartz First Reg Co',
        entityType: 'organisation',
        role: 'Other party',
        linkedRecordId: null,
        identifiers: { companyNumber: '99111222' },
      },
      {
        id: 'cp-r659-7',
        name: 'Cobalt Unmatched Label Co',
        entityType: 'organisation',
        role: 'Other party',
        linkedRecordId: null,
        identifiers: { companyNumber: '09222333' },
      },
      {
        id: 'cp-r659-8',
        name: 'Walled Restricted Target Group',
        entityType: 'organisation',
        role: 'Client',
        linkedRecordId: null,
        isClientFixed: true,
      },
      {
        id: 'cp-r659-9',
        name: 'Filler Ninth Party Corp',
        entityType: 'organisation',
        role: 'Witness',
        linkedRecordId: null,
      },
      // #10 Hit beyond 8-term cap (S3)
      {
        id: 'cp-r659-10',
        name: 'Decimus Tenth Party Target Ltd',
        entityType: 'organisation',
        role: 'Opponent',
        linkedRecordId: null,
      },
      {
        id: 'cp-r659-11',
        name: 'Eleventh Filler Person',
        entityType: 'person',
        role: 'Witness',
        linkedRecordId: null,
      },
      {
        id: 'cp-r676-12',
        name: 'Bramwell EmptyAllowStaff',
        entityType: 'person',
        role: 'Other party',
        linkedRecordId: null,
      },
      {
        id: 'cp-r676-13',
        name: 'Cromwell WallExplicitTarget',
        entityType: 'person',
        role: 'Other party',
        linkedRecordId: null,
      },
      {
        id: 'cp-r685-14',
        name: 'Meridian Former Standalone Corp',
        entityType: 'organisation',
        role: 'Other party',
        linkedRecordId: null,
      },
    ];

    const staffPeople = await partyRepo.listAllPeople<Person>(ctxAlpha, {
      employeesAndLeaversOnly: true,
    });
    const teams = await hrRepo.listAllTeams<Team>(ctxAlpha);
    const signals = extractConflictSignalsFromParties(parties);

    const loadPreS102aConflictGraph = async (viewerId: string) => {
      const [peopleRaw, organisations, links, matters, enquiries] = await Promise.all([
        partyRepo.listAllPeople<Person>(ctxAlpha),
        partyRepo.listAllOrganisations<Organisation>(ctxAlpha),
        partyRepo.listAllLinks<PersonOrganisationLink>(ctxAlpha),
        matterRepo.listAllMattersUnfiltered<Matter>(ctxAlpha),
        intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctxAlpha),
      ]);
      const byId = new Map<string, Person>();
      for (const p of [...staffPeople, ...peopleRaw]) {
        if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      }
      const allPeopleOut = Array.from(byId.values());
      const viewerPerson = allPeopleOut.find((p) => p.id === viewerId) ?? null;
      const legacyVis = buildRecordVisibility({ teams }, viewerPerson, {
        hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
        teams,
        people: allPeopleOut,
        matters,
        enquiries,
      });
      return {
        people: allPeopleOut,
        organisations,
        links,
        matters,
        enquiries,
        canViewMatter: legacyVis.canViewMatter,
        canViewEnquiry: legacyVis.canViewEnquiry,
      };
    };

    const compareForViewer = async (
      viewerId: string,
      opts: {
        canSeeWall: boolean;
        canSeePrivateDraft: boolean;
        canSeeStaffEmpty: boolean;
        canSeeExplicitWall: boolean;
      },
    ) => {
      const [preS102aGraph, fullGraph, scopedGraph] = await Promise.all([
        loadPreS102aConflictGraph(viewerId),
        loadFullConflictSearchGraph(ctxAlpha, signals, viewerId, staffPeople, teams),
        loadScopedConflictSearchGraphForParity(ctxAlpha, signals, viewerId, staffPeople, teams),
      ]);

      const runMatters = (graph: typeof fullGraph) =>
        searchMatterConflicts(
          { parties },
          {
            matters: graph.matters,
            enquiries: graph.enquiries,
            people: graph.people,
            organisations: graph.organisations,
            links: graph.links,
            tenantId: tenantAlpha,
            canView: graph.canViewMatter,
            canViewEnquiry: graph.canViewEnquiry,
          },
        );

      const preS102aMatches = runMatters(preS102aGraph);
      const fullMatches = runMatters(fullGraph);
      const scopedMatches = runMatters(scopedGraph);

      const normalizeMatches = (list: typeof fullMatches) =>
        [...list]
          .map((m) => ({
            partyId: m.partyId,
            matchedRecordId: m.matchedRecordId,
            matchedRecordName: m.matchedRecordName,
            whereFound: m.whereFound,
            matterId: m.matterId,
            restricted: Boolean(m.restricted),
          }))
          .sort((a, b) =>
            `${a.partyId}:${a.matterId ?? ''}:${a.matchedRecordId}:${a.whereFound}:${a.matchedRecordName}`.localeCompare(
              `${b.partyId}:${b.matterId ?? ''}:${b.matchedRecordId}:${b.whereFound}:${b.matchedRecordName}`,
            ),
          );

      // Verify all scenarios produced expected hits and redaction in legacy preS102a first
      const preSerialized = JSON.stringify(preS102aMatches);
      expect(preSerialized).toContain('M-R659-S1-FREE');
      expect(preSerialized).toContain('M-R659-S2-REF');
      expect(preSerialized).toContain('M-R659-S3-TENPLUS');
      expect(preSerialized).toContain('M-R659-S4-FORMER');
      expect(preSerialized).toContain('M-R685-S4B-ORG');
      expect(preSerialized).toContain('M-R659-S5-PREVSEP');
      expect(preSerialized).toContain('M-R659-S6-EMAIL');
      expect(preSerialized).toContain('M-R659-S7-COMPNO');
      if (opts.canSeeWall) {
        expect(preSerialized).toContain('M-R659-S8-WALL');
      } else {
        expect(preSerialized).not.toContain('Confidential Staff Ethical Wall Matter');
        expect(preS102aMatches.some((m) => m.restricted && m.whereFound.includes('Restricted matter'))).toBe(true);
      }
      if (opts.canSeePrivateDraft) {
        expect(preSerialized).toContain('Private Draft Wall Enquiry');
      } else {
        expect(preSerialized).not.toContain('Private Draft Wall Enquiry');
        expect(preS102aMatches.some((m) => m.restricted && m.whereFound.includes('Restricted enquiry'))).toBe(true);
      }
      if (opts.canSeeStaffEmpty) {
        expect(preSerialized).toContain('M-R676-STAFF-EMPTY');
        expect(preSerialized).toContain('ENQ-R676-STAFF-EMPTY');
      } else {
        expect(preSerialized).not.toContain('Staff Empty Allowlist Matter');
        expect(preSerialized).not.toContain('Staff Empty Allowlist Converted Source Enquiry');
      }
      if (opts.canSeeExplicitWall) {
        expect(preSerialized).toContain('M-R676-WALL-EXPLICIT');
        expect(preSerialized).toContain('ENQ-R676-WALL-EXPLICIT');
      } else {
        expect(preSerialized).not.toContain('Wall Explicit Allowlist Matter');
        expect(preSerialized).not.toContain('Explicit Wall Converted Source Enquiry');
      }

      // Assert exact 3-arm parity: preS102a === full === scoped (hits AND redaction)
      expect(normalizeMatches(fullMatches)).toEqual(normalizeMatches(preS102aMatches));
      expect(normalizeMatches(scopedMatches)).toEqual(normalizeMatches(fullMatches));
    };

    // Unauthorised participant fee earner (P-000002): sees M-R676-STAFF-EMPTY (empty allow-list fallback), redacted walls & non-allow-listed explicit wall
    await compareForViewer('P-000002', {
      canSeeWall: false,
      canSeePrivateDraft: false,
      canSeeStaffEmpty: true,
      canSeeExplicitWall: false,
    });
    // Unrelated fee earner without matter:restricted:access (P-000006): redacted on staff-empty and all walls
    await compareForViewer('P-000006', {
      canSeeWall: false,
      canSeePrivateDraft: false,
      canSeeStaffEmpty: false,
      canSeeExplicitWall: false,
    });
    // Partner on explicit wall allow-list without matter:restricted:access (P-000001): sees S8 wall, own Draft, & explicit wall, but NOT unrelated staff-empty matter
    await compareForViewer('P-000001', {
      canSeeWall: true,
      canSeePrivateDraft: true,
      canSeeStaffEmpty: false,
      canSeeExplicitWall: true,
    });
    // Risk & Compliance oversight holder with matter:restricted:access (P-000003): sees all restricted matters & converted enquiries, while P-000001's personal Draft remains hidden
    await compareForViewer('P-000003', {
      canSeeWall: true,
      canSeePrivateDraft: false,
      canSeeStaffEmpty: true,
      canSeeExplicitWall: true,
    });

    // Live Option 1 check: runMatterConflictCheckRecord uses loadFullConflictSearchGraph with P-000002 redaction
    setTestEntraSessionOverride({
      personId: 'P-000002',
      tenantId: tenantAlpha,
      oid: 'oid-r659-p2',
      tid: 'tid-r659',
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
    const liveMatterRes = await runMatterConflictSearchRecord({ parties }, 'P-000002');
    expect(JSON.stringify(liveMatterRes.matches)).toContain('M-R659-S3-TENPLUS');
    expect(JSON.stringify(liveMatterRes.matches)).not.toContain(
      'Confidential Staff Ethical Wall Matter',
    );

    // Enquiry conflict search parity (preS102a vs Full vs Scoped, filtering enquiries by canViewEnquiry matching live services.ts)
    const enqInput = {
      firstName: 'Huw',
      lastName: 'ReferrerTarget',
      callingOnBehalfOf: 'Snowdonia Counterpart Logistics Ltd',
      otherPartiesNamed:
        'Meyrick, Bowen; Decimus Tenth Party Target Ltd; Bramwell EmptyAllowStaff; Cromwell WallExplicitTarget; Private DraftWall; Meridian Former Standalone Corp',
      email: 'conflict-email-hit@invented.example',
    };
    const enqSignals: ReturnType<typeof extractConflictSignalsFromParties> = {
      terms: [
        enqInput.firstName,
        enqInput.lastName,
        `${enqInput.firstName} ${enqInput.lastName}`,
        enqInput.callingOnBehalfOf,
        ...enqInput.otherPartiesNamed.split(/[,;/\n]+/).map((s) => s.trim()),
      ].filter(Boolean),
      emails: [enqInput.email],
    };
    const [preEnqGraph, fullEnqGraph, scopedEnqGraph] = await Promise.all([
      loadPreS102aConflictGraph('P-000002'),
      loadFullConflictSearchGraph(ctxAlpha, enqSignals, 'P-000002', staffPeople, teams),
      loadScopedConflictSearchGraphForParity(ctxAlpha, enqSignals, 'P-000002', staffPeople, teams),
    ]);
    const runEnqArm = (graph: typeof fullEnqGraph) =>
      runEnquiryConflictSearch(
        enqInput,
        graph.people,
        graph.organisations,
        graph.matters,
        seed.values,
        graph.enquiries.filter((e) => graph.canViewEnquiry(e)),
        null,
        graph.links,
        graph.canViewMatter,
        tenantAlpha,
      );
    const preEnqHits = runEnqArm(preEnqGraph);
    const fullEnqHits = runEnqArm(fullEnqGraph);
    const scopedEnqHits = runEnqArm(scopedEnqGraph);

    const normalizeEnqHits = (res: typeof fullEnqHits) =>
      res.allConflicts.map((h) => `${h.recordType}:${h.recordId}:${h.reason}`).sort();

    expect(normalizeEnqHits(fullEnqHits)).toEqual(normalizeEnqHits(preEnqHits));
    expect(normalizeEnqHits(scopedEnqHits)).toEqual(normalizeEnqHits(fullEnqHits));
    expect(fullEnqHits.allConflicts.length).toBeGreaterThan(0);
    // P-000002 CAN see ENQ-R676-STAFF-EMPTY (participant on empty-allow-list staff matter) & Scenario 4b linked org
    expect(fullEnqHits.allConflicts.some((h) => h.recordId === 'ENQ-R676-STAFF-EMPTY')).toBe(true);
    expect(fullEnqHits.allConflicts.some((h) => h.recordId === 'O-R685-FORMER-LINKED')).toBe(true);
    // P-000002 MUST NOT see ENQ-R676-WALL-EXPLICIT (excluded from explicit allow-list) or ENQ-R659-S8-PRIV (another user's Draft)
    expect(fullEnqHits.allConflicts.some((h) => h.recordId === 'ENQ-R676-WALL-EXPLICIT')).toBe(false);
    expect(fullEnqHits.allConflicts.some((h) => h.recordId === 'ENQ-R659-S8-PRIV')).toBe(false);

    // Second-tenant isolation: Bravo sees ZERO Alpha Scenario 1-8 hits
    const bravoStaff = await partyRepo.listAllPeople<Person>(ctxBravo, {
      employeesAndLeaversOnly: true,
    });
    const bravoTeams = await hrRepo.listAllTeams<Team>(ctxBravo);
    const bravoFull = await loadFullConflictSearchGraph(
      ctxBravo,
      signals,
      'P-000001',
      bravoStaff,
      bravoTeams,
    );
    const bravoScoped = await loadScopedConflictSearchGraphForParity(
      ctxBravo,
      signals,
      'P-000001',
      bravoStaff,
      bravoTeams,
    );
    const bravoMatchesFull = searchMatterConflicts(
      { parties },
      {
        matters: bravoFull.matters,
        enquiries: bravoFull.enquiries,
        people: bravoFull.people,
        organisations: bravoFull.organisations,
        links: bravoFull.links,
        tenantId: tenantBravo,
        canView: bravoFull.canViewMatter,
        canViewEnquiry: bravoFull.canViewEnquiry,
      },
    );
    const bravoMatchesScoped = searchMatterConflicts(
      { parties },
      {
        matters: bravoScoped.matters,
        enquiries: bravoScoped.enquiries,
        people: bravoScoped.people,
        organisations: bravoScoped.organisations,
        links: bravoScoped.links,
        tenantId: tenantBravo,
        canView: bravoScoped.canViewMatter,
        canViewEnquiry: bravoScoped.canViewEnquiry,
      },
    );
    expect(bravoMatchesScoped.map((m) => m.id).sort()).toEqual(
      bravoMatchesFull.map((m) => m.id).sort(),
    );
    const bravoFullJson = JSON.stringify(bravoMatchesFull);
    const bravoScopedJson = JSON.stringify(bravoMatchesScoped);
    expect(bravoFullJson).not.toContain('R659');
    expect(bravoScopedJson).not.toContain('R659');
    expect(bravoFullJson).not.toContain('Confidential Staff Ethical Wall Matter');
    expect(bravoScopedJson).not.toContain('Confidential Staff Ethical Wall Matter');
    expect(bravoFullJson).not.toContain('Private Draft Wall Enquiry');
    expect(bravoScopedJson).not.toContain('Private Draft Wall Enquiry');
  });

  it('R664: listEnquiriesByIds enforces ENQUIRY_VISIBLE_SQL_PREDICATE and ENQUIRY_DRAFT_ONLY_SQL_PREDICATE when includeRestricted is false across two tenants', async () => {
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

    const matterRepo = new TenantMatterRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();
    const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));

    await matterRepo.putMatter(ctxAlpha, {
      ...(structuredClone(seed.matters[0]!) as Matter),
      id: 'M-R664-RESTRICTED',
      matterNumber: 'MAT-R664-R1',
      title: 'R664 Restricted Matter',
      responsiblePartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000001',
      teamMemberIds: ['P-000001'],
      isStaffMatter: true,
      hasEthicalWall: false,
      restrictedAccessUserIds: ['P-000001'],
      parties: [],
    });
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R664-DRAFT',
      reference: 'ENQ-R664-D1',
      status: 'Draft',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Private',
      lastName: 'DraftOwner',
      summary: 'User A Private Draft',
      receivedAt: '2026-11-01T10:00:00Z',
    } as never);
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R664-RESTRICTED',
      reference: 'ENQ-R664-R1',
      status: 'Assigned',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Restricted',
      lastName: 'LinkedMatter',
      convertedMatterId: 'M-R664-RESTRICTED',
      summary: 'Restricted Matter Linked Enquiry',
      receivedAt: '2026-11-01T10:05:00Z',
    } as never);
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R664-PUBLIC',
      reference: 'ENQ-R664-P1',
      status: 'Assigned',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Open',
      lastName: 'PublicEnq',
      summary: 'Open Assigned Enquiry',
      receivedAt: '2026-11-01T10:10:00Z',
    } as never);

    const targetIds = ['ENQ-R664-DRAFT', 'ENQ-R664-RESTRICTED', 'ENQ-R664-PUBLIC'];

    const userBVisible = await intakeRepo.listEnquiriesByIds<Enquiry>(
      ctxAlpha,
      targetIds,
      { viewerId: 'P-000002' },
    );
    expect(userBVisible.map((e) => e.id)).toEqual(['ENQ-R664-PUBLIC']);

    const restrictedHolderVisible = await (
      intakeRepo as unknown as {
        listEnquiriesByIds: (
          ctx: TenantContext,
          ids: readonly string[],
          opts?: {
            includeRestricted?: boolean;
            viewerId?: string;
            hasRestrictedMatterAccess?: boolean;
          },
        ) => Promise<Enquiry[]>;
      }
    ).listEnquiriesByIds(ctxAlpha, targetIds, {
      viewerId: 'P-000002',
      hasRestrictedMatterAccess: true,
    });
    expect(restrictedHolderVisible.map((e) => e.id)).toEqual([
      'ENQ-R664-PUBLIC',
      'ENQ-R664-RESTRICTED',
    ]);

    const ownerVisible = await intakeRepo.listEnquiriesByIds<Enquiry>(
      ctxAlpha,
      targetIds,
      { viewerId: 'P-000001' },
    );
    expect(ownerVisible.map((e) => e.id)).toEqual([
      'ENQ-R664-DRAFT',
      'ENQ-R664-PUBLIC',
      'ENQ-R664-RESTRICTED',
    ]);

    const bravoVisible = await intakeRepo.listEnquiriesByIds<Enquiry>(
      ctxBravo,
      targetIds,
      { viewerId: 'P-000001', includeRestricted: true },
    );
    expect(bravoVisible).toEqual([]);
  });

  it('R663: quote-expiry scheduled job persists Expired status, Quote expired timeline, zero-PII audit & job_runs across two tenants idempotently', async () => {
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

    const tenancyMod = await import('../src/tenancy/index');
    const coreMod = await import('../src/index');
    const runtimeMod = await import('../../src/platform/tenantRuntime');
    const authorizeMod = await import('../../src/server/authorize');
    const permsMod = await import('../../src/server/actionPermissions');
    const servicesMod = (await import('../../src/server/services')) as Record<string, unknown>;

    const intakeRepo = new TenantIntakeQuoteRepository();
    const jobRunRepo = new tenancyMod.TenantJobRunRepository();
    const auditRepo = new tenancyMod.TenantAuditRepository();

    await jobRunRepo.clearTenantJobRuns(ctxAlpha);
    await jobRunRepo.clearTenantJobRuns(ctxBravo);

    const buildQuote = (id: string, overrides: Record<string, unknown>) => ({
      id,
      reference: id,
      clientType: 'person' as const,
      clientFirstName: 'ConfidentialAlice',
      clientLastName: 'SecretQuoteClient',
      clientEmail: 'alice.secret@example.invalid',
      departmentId: 'DEPT-DISP',
      matterTypeId: 'MT-DISP-01',
      title: `Quote ${id}`,
      status: 'Sent',
      feeBasis: 'fixed' as const,
      estimatedFeeExVat: 1500,
      estimatedDisbursementsExVat: 0,
      vatRatePercent: 20,
      validUntil: '2026-10-01',
      ownerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-09-01T09:00:00Z',
      updatedAt: '2026-09-01T09:00:00Z',
      sentAt: '2026-09-01T10:00:00Z',
      timeline: [],
      ...overrides,
    });

    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R663-A-SENT', { status: 'Sent', validUntil: '2026-10-01' }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R663-A-FOLLOW', { status: 'Follow-up due', validUntil: '2026-10-15' }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R663-A-DRAFT', { status: 'Draft', validUntil: '2026-10-01', sentAt: null }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R663-A-FUTURE', { status: 'Sent', validUntil: '2099-12-31' }) as never);
    await intakeRepo.putQuote(ctxBravo, buildQuote('QUO-R663-B-SENT', { status: 'Sent', validUntil: '2026-10-01' }) as never);

    const jobPolicy = (permsMod.JOB_PERMISSIONS as Record<string, { permission?: string; jobOnly?: boolean } | undefined>)['quote-expiry'];
    expect(jobPolicy?.permission).toBe('quote:run_expiry');
    expect(jobPolicy?.jobOnly).toBe(true);

    const host = process.env.PLATFORM_POSTGRES_HOST?.trim() || '127.0.0.1';
    const makeRegistryEntry = (tenantId: string, enabled: boolean) => {
      const slug = tenantId.replace(/-/g, '_');
      return {
        tenantId,
        slug,
        environment: 'test' as const,
        postgresHost: host,
        postgresDatabaseName: `pg_tenant_${slug}_test`,
        postgresRoleName: `role_tenant_${slug}_test`,
        keyVaultUri: `https://kv-${slug.replace(/_/g, '')}-test.vault.azure.net/`,
        packageDir: 'client-not-a-law-firm',
        timeZone: 'Europe/London',
        enabled,
      };
    };

    const rawBase = structuredClone(runtimeMod.getActiveTenantRawBaseConfig()) as Record<string, unknown>;
    const alphaCfg = coreMod.loadAndValidateTenantConfig(
      rawBase,
      { tenantId: tenantAlpha, environment: 'test' },
      'test',
      'multi_tenant',
    );
    const bravoCfg = coreMod.loadAndValidateTenantConfig(
      rawBase,
      { tenantId: tenantBravo, environment: 'test' },
      'test',
      'multi_tenant',
    );

    const registryAlphaOnly = {
      schemaVersion: '1.0.0',
      environment: 'test' as const,
      hostingMode: 'multi_tenant' as const,
      tenants: [
        makeRegistryEntry(tenantAlpha, true),
        makeRegistryEntry(tenantBravo, false),
      ],
    };

    await expect(
      authorizeMod.guardedJob('quote-expiry' as never, 'unregistered-evil-tenant', async () => 'no', {
        registry: registryAlphaOnly,
      }),
    ).rejects.toMatchObject({ code: 'TENANCY_UNREGISTERED_JOB_TENANT' });

    const runSweep = servicesMod.runScheduledQuoteExpiryJobSweep as
      | ((options?: Record<string, unknown>) => Promise<{
          exitCode: number;
          succeededTenants: string[];
          skippedTenants: Array<{ tenantId: string; status: string; reason?: string }>;
          failedTenants: Array<{ tenantId: string; errorCode?: string }>;
        }>)
      | undefined;
    expect(typeof runSweep).toBe('function');

    const firstSweep = await runSweep!({
      registry: registryAlphaOnly,
      defaultRunHourLocal: 0,
      tenantConfigOverrideByTenantId: {
        [tenantAlpha]: alphaCfg,
        [tenantBravo]: bravoCfg,
      },
    });
    expect(firstSweep.exitCode).toBe(0);
    expect(firstSweep.succeededTenants).toEqual([tenantAlpha]);

    const expiredAlpha = await intakeRepo.listVisibleQuotes<{
      id: string;
      status: string;
      timeline: Array<{ kind: string; title: string }>;
    }>(ctxAlpha, 'P-000001', { status: 'Expired' });
    const expiredIds = expiredAlpha.map((q) => q.id).sort();
    expect(expiredIds).toContain('QUO-R663-A-FOLLOW');
    expect(expiredIds).toContain('QUO-R663-A-SENT');
    for (const id of ['QUO-R663-A-SENT', 'QUO-R663-A-FOLLOW']) {
      const q = expiredAlpha.find((item) => item.id === id);
      expect(q?.status).toBe('Expired');
      const expEvents = q?.timeline.filter((t) => t.kind === 'expired' && t.title === 'Quote expired') ?? [];
      expect(expEvents).toHaveLength(1);
    }

    const alphaDraft = await intakeRepo.getQuoteById<{ status: string; timeline: Array<{ kind: string }> }>(
      ctxAlpha,
      'QUO-R663-A-DRAFT',
      { includeRestricted: true },
    );
    expect(alphaDraft?.status).toBe('Draft');
    expect(alphaDraft?.timeline.some((t) => t.kind === 'expired')).toBe(false);

    const alphaFuture = await intakeRepo.getQuoteById<{ status: string }>(
      ctxAlpha,
      'QUO-R663-A-FUTURE',
      { includeRestricted: true },
    );
    expect(alphaFuture?.status).toBe('Sent');

    // Bravo remained disabled in registryAlphaOnly so its overdue quote must remain untouched
    const bravoOverdue = await intakeRepo.getQuoteById<{ status: string }>(
      ctxBravo,
      'QUO-R663-B-SENT',
      { includeRestricted: true },
    );
    expect(bravoOverdue?.status).toBe('Sent');

    const jobRunsAlpha = await jobRunRepo.listJobRuns(ctxAlpha, { jobKey: 'quote-expiry', status: 'succeeded' });
    expect(jobRunsAlpha.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(jobRunsAlpha)).not.toContain('ConfidentialAlice');
    expect(JSON.stringify(jobRunsAlpha)).not.toContain('SecretQuoteClient');

    const auditsAlpha = await auditRepo.listAuditEntriesForRecord(ctxAlpha, 'quote', 'QUO-R663-A-SENT');
    expect(auditsAlpha.some((a) => a.field === 'Quote lifecycle status' && a.newValue === 'Expired')).toBe(true);
    expect(JSON.stringify(auditsAlpha)).not.toContain('ConfidentialAlice');
    expect(JSON.stringify(auditsAlpha)).not.toContain('SecretQuoteClient');

    // Second scheduled sweep on same day skips Alpha (already_succeeded_today) and executes Bravo if enabled
    const secondSweep = await runSweep!({
      registry: registryAlphaOnly,
      defaultRunHourLocal: 0,
      tenantConfigOverrideByTenantId: {
        [tenantAlpha]: alphaCfg,
        [tenantBravo]: bravoCfg,
      },
    });
    expect(secondSweep.exitCode).toBe(0);
    expect(secondSweep.skippedTenants.some((s) => s.tenantId === tenantAlpha)).toBe(true);

    // Manual execution on Alpha is idempotent: 0 newly expired, timeline length remains 1
    const execManual = servicesMod.executeQuoteExpiryForTenant as (
      ctx: TenantContext,
      opts: Record<string, unknown>,
    ) => Promise<{
      outcome: string;
      result?: { summary: { expiredCount: number } };
    }>;
    const manualSecond = await execManual(ctxAlpha, {
      triggerSource: 'manual',
      triggeredById: 'system:quote-expiry',
      defaultRunHourLocal: 0,
      tenantConfig: alphaCfg,
    });
    expect(manualSecond.outcome).toBe('executed');
    expect(manualSecond.result?.summary.expiredCount).toBe(0);
    const reloadedSent = await intakeRepo.getQuoteById<{ timeline: Array<{ kind: string }> }>(
      ctxAlpha,
      'QUO-R663-A-SENT',
      { includeRestricted: true },
    );
    expect(reloadedSent?.timeline.filter((t) => t.kind === 'expired')).toHaveLength(1);

    // Direct helper check: read-only projection updates status without appending timeline; write mode appends once
    const quotesDomain = await import('../../src/domain/quotes');
    const helperQuoteRead = buildQuote('QUO-R663-HELPER-READ', { status: 'Sent', validUntil: '2026-10-01' });
    const readOutcome = quotesDomain.applyQuoteEffectiveLifecycle(helperQuoteRead as never, new Date('2026-11-23T12:00:00Z'), {
      appendExpiredTimeline: false,
    });
    expect(readOutcome).toEqual({ changed: true, newlyExpired: false });
    expect(helperQuoteRead.status).toBe('Expired');
    expect(helperQuoteRead.timeline).toHaveLength(0);

    const writeOutcome = quotesDomain.applyQuoteEffectiveLifecycle(
      buildQuote('QUO-R663-HELPER-WRITE', { status: 'Sent', validUntil: '2026-10-01' }) as never,
      new Date('2026-11-23T12:00:00Z'),
      { appendExpiredTimeline: true },
    );
    expect(writeOutcome).toEqual({ changed: true, newlyExpired: true });
  });

  it('R671: enforces per-ID EXISTS hidden enquiry/quote checks, single-record PMS code lookups, stop-word filtering, and high-cardinality warning (>500, no truncation) across two tenants', async () => {
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

    const tenancyMod = await import('../src/tenancy/index');
    const matterRepo = new TenantMatterRepository();
    const intakeRepo = new TenantIntakeQuoteRepository();
    const partyRepo = new tenancyMod.TenantPartyRepository();
    const pmsRepo = new tenancyMod.TenantPmsRepository();
    const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));

    // 1. Per-ID EXISTS hidden checks (Draft vs restricted matter vs public, Alpha vs Bravo)
    await matterRepo.putMatter(ctxAlpha, {
      ...(structuredClone(seed.matters[0]!) as Matter),
      id: 'M-R671-REST',
      matterNumber: 'MAT-R671-R1',
      title: 'R671 Restricted Matter',
      responsiblePartnerId: 'P-000001',
      leadFeeEarnerId: 'P-000001',
      teamMemberIds: ['P-000001'],
      isStaffMatter: true,
      hasEthicalWall: false,
      restrictedAccessUserIds: ['P-000001'],
      parties: [],
    });
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R671-DRAFT',
      reference: 'ENQ-R671-D1',
      status: 'Draft',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Private',
      lastName: 'Draft',
      summary: 'Draft summary',
      receivedAt: '2026-11-01T10:00:00Z',
    } as never);
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R671-REST',
      reference: 'ENQ-R671-R1',
      status: 'Assigned',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Rest',
      lastName: 'Enquiry',
      convertedMatterId: 'M-R671-REST',
      summary: 'Restricted summary',
      receivedAt: '2026-11-01T10:05:00Z',
    } as never);
    await intakeRepo.putEnquiry(ctxAlpha, {
      id: 'ENQ-R671-PUB',
      reference: 'ENQ-R671-P1',
      status: 'Assigned',
      createdById: 'P-000001',
      takenById: 'P-000001',
      firstName: 'Public',
      lastName: 'Enquiry',
      summary: 'Public summary',
      receivedAt: '2026-11-01T10:10:00Z',
    } as never);
    await intakeRepo.putQuote(ctxAlpha, {
      id: 'QUO-R671-REST',
      reference: 'QUO-R671-R1',
      clientType: 'person',
      clientFirstName: 'Rest',
      clientLastName: 'Quote',
      departmentId: 'DEPT-DISP',
      matterTypeId: 'MT-DISP-01',
      title: 'Restricted Quote',
      status: 'Sent',
      feeBasis: 'fixed',
      estimatedFeeExVat: 1000,
      estimatedDisbursementsExVat: 0,
      vatRatePercent: 20,
      validUntil: '2099-12-31',
      ownerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z',
      linkedEnquiryId: 'ENQ-R671-REST',
      timeline: [],
    } as never);
    await intakeRepo.putQuote(ctxAlpha, {
      id: 'QUO-R671-PUB',
      reference: 'QUO-R671-P1',
      clientType: 'person',
      clientFirstName: 'Pub',
      clientLastName: 'Quote',
      departmentId: 'DEPT-DISP',
      matterTypeId: 'MT-DISP-01',
      title: 'Public Quote',
      status: 'Sent',
      feeBasis: 'fixed',
      estimatedFeeExVat: 1000,
      estimatedDisbursementsExVat: 0,
      vatRatePercent: 20,
      validUntil: '2099-12-31',
      ownerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z',
      timeline: [],
    } as never);

    const typedIntake = intakeRepo as unknown as {
      isEnquiryHiddenFromViewer?: (
        ctx: TenantContext,
        id: string,
        viewerId: string,
        opts?: { hasRestrictedMatterAccess?: boolean },
      ) => Promise<boolean>;
      isQuoteHiddenFromViewer?: (
        ctx: TenantContext,
        id: string,
        viewerId: string,
        opts?: { hasRestrictedMatterAccess?: boolean },
      ) => Promise<boolean>;
    };
    expect(typeof typedIntake.isEnquiryHiddenFromViewer).toBe('function');
    expect(typeof typedIntake.isQuoteHiddenFromViewer).toBe('function');
    expect(
      await typedIntake.isEnquiryHiddenFromViewer!(ctxAlpha, 'ENQ-R671-DRAFT', 'P-000002', {
        hasRestrictedMatterAccess: false,
      }),
    ).toBe(true);
    expect(
      await typedIntake.isEnquiryHiddenFromViewer!(ctxAlpha, 'ENQ-R671-DRAFT', 'P-000002', {
        hasRestrictedMatterAccess: true,
      }),
    ).toBe(true);
    expect(
      await typedIntake.isEnquiryHiddenFromViewer!(ctxAlpha, 'ENQ-R671-REST', 'P-000002', {
        hasRestrictedMatterAccess: false,
      }),
    ).toBe(true);
    expect(
      await typedIntake.isEnquiryHiddenFromViewer!(ctxAlpha, 'ENQ-R671-REST', 'P-000002', {
        hasRestrictedMatterAccess: true,
      }),
    ).toBe(false);
    expect(
      await typedIntake.isEnquiryHiddenFromViewer!(ctxAlpha, 'ENQ-R671-PUB', 'P-000002'),
    ).toBe(false);
    expect(
      await typedIntake.isQuoteHiddenFromViewer!(ctxAlpha, 'QUO-R671-REST', 'P-000002', {
        hasRestrictedMatterAccess: false,
      }),
    ).toBe(true);
    expect(
      await typedIntake.isQuoteHiddenFromViewer!(ctxAlpha, 'QUO-R671-REST', 'P-000002', {
        hasRestrictedMatterAccess: true,
      }),
    ).toBe(false);
    expect(
      await typedIntake.isQuoteHiddenFromViewer!(ctxAlpha, 'QUO-R671-PUB', 'P-000002'),
    ).toBe(false);
    expect(
      await intakeRepo.getEnquiryById(ctxBravo, 'ENQ-R671-PUB', { includeRestricted: true }),
    ).toBeNull();

    // 2. Single-record PMS code lookups & unlinked matters across two tenants
    await pmsRepo.importExtractDataset(ctxAlpha, {
      extractInfo: {
        asAtDate: '2026-11-01',
        importedAt: '2026-11-01T09:00:00Z',
        sourceFile: 'r671-pms.xlsx',
      },
      feeEarners: [],
      clients: [
        {
          client_code: 'PMS-C-R671',
          client_name: 'R671 Single Lookup Ltd',
          client_type: 'Organisation',
          client_partner_id: '',
          email: '',
          phone: '',
          billing_address: '',
          postcode: '',
          company_number: '',
          credit_terms_days: 30,
          credit_limit: 0,
          rate_discount_pct: 0,
          date_opened: '2026-10-01',
          sector: 'Legal',
          crm_match_on: 'email',
          status: 'Active',
        },
      ],
      matters: [
        {
          matter_code: 'PMS-M-R671',
          client_code: 'PMS-C-R671',
          matter_description: 'R671 Unlinked Matter',
          practice_area: 'Corporate and commercial',
          work_type: 'Share purchase',
          fee_earner_id: '',
          responsible_partner_id: '',
          billing_basis: 'Hourly Rate',
          fixed_fee_amount: 0,
          fee_estimate: 5000,
          estimate_alert_pct: 80,
          date_opened: '2026-10-01',
          date_closed: null,
          status: 'Open',
          billing_frequency: 'Monthly',
          client_reference: '',
          third_party_payer: '',
        },
      ],
      feeEstimates: [],
      timeEntries: [],
      disbursements: [],
      invoices: [],
      payments: [],
      clientAccount: [],
    });

    const typedPms = pmsRepo as unknown as {
      getClientByCode?: (ctx: TenantContext, code: string) => Promise<{ client_code: string } | null>;
      getMatterByCode?: (ctx: TenantContext, code: string) => Promise<{ matter_code: string } | null>;
      listUnlinkedMatters?: (ctx: TenantContext) => Promise<Array<{ matter_code: string }>>;
    };
    expect(typeof typedPms.getClientByCode).toBe('function');
    expect(typeof typedPms.getMatterByCode).toBe('function');
    expect(typeof typedPms.listUnlinkedMatters).toBe('function');
    expect((await typedPms.getClientByCode!(ctxAlpha, 'PMS-C-R671'))?.client_code).toBe('PMS-C-R671');
    expect((await typedPms.getMatterByCode!(ctxAlpha, 'PMS-M-R671'))?.matter_code).toBe('PMS-M-R671');
    expect((await typedPms.listUnlinkedMatters!(ctxAlpha)).some((m) => m.matter_code === 'PMS-M-R671')).toBe(true);
    expect(await typedPms.getClientByCode!(ctxBravo, 'PMS-C-R671')).toBeNull();
    expect(await typedPms.getMatterByCode!(ctxBravo, 'PMS-M-R671')).toBeNull();

    // 3. Stop-word-only terms skip unnecessary name queries while non-stop words match
    const { vi } = await import('vitest');
    const baseOrg = structuredClone(seed.organisations[0]!) as Organisation;
    await partyRepo.putOrganisation(ctxAlpha, {
      ...baseOrg,
      id: 'O-R671-SHOP',
      legalName: 'Acme Law Shop Ltd',
      otherNames: [],
      companyNumber: '',
      generalEmail: '',
      mainPhone: '',
      website: '',
      registeredAddress: null,
      correspondenceAddress: null,
      billingAddress: null,
      parentOrganisationId: null,
      notDuplicateOf: [],
    });
    const dupSpy = vi.spyOn(partyRepo, 'findSqlDuplicateCandidates');
    try {
      await partyRepo.findSqlConflictCandidates(ctxAlpha, {
        terms: ['the', 'and', 'limited', 'llp', 'ltd', 'plc'],
      });
      expect(dupSpy).not.toHaveBeenCalled();

      dupSpy.mockClear();
      const nonStopRes = await partyRepo.findSqlConflictCandidates(ctxAlpha, {
        terms: ['The Law Shop'],
      });
      expect(dupSpy).toHaveBeenCalled();
      expect(nonStopRes.organisations.some((o) => o.id === 'O-R671-SHOP')).toBe(true);
    } finally {
      dupSpy.mockRestore();
    }

    // 4. High-cardinality > 500 candidate warning without truncation and with zero PII
    const basePerson = structuredClone(seed.people.find((p) => !p.isEmployee) ?? seed.people[0]!) as Person;
    const bulkPeople: Person[] = Array.from({ length: 505 }, (_, i) => ({
      ...basePerson,
      id: `P-R671-HC-${String(i).padStart(4, '0')}`,
      firstName: `Person${i}`,
      surname: 'HighCardR671',
      isEmployee: false,
      emails: [],
      phones: [],
      addresses: [],
      notDuplicateOf: [],
    }));
    await partyRepo.putPeople(ctxAlpha, bulkPeople);

    const warnMessages: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });
    try {
      const candidates = await partyRepo.findSqlDuplicateCandidates<Person>(ctxAlpha, {
        kind: 'person',
        surname: 'HighCardR671',
        fuzzy: false,
      });
      expect(candidates.length).toBeGreaterThanOrEqual(505);
      const hcWarn = warnMessages.find((msg) => msg.includes('tenancy.candidate_query.high_cardinality'));
      expect(hcWarn).toBeDefined();
      expect(hcWarn).toContain(tenantAlpha);
      expect(hcWarn).not.toContain('HighCardR671');
      expect(hcWarn).not.toContain('Person0');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('R675: quote-expiry runs atomic conditional FOR UPDATE SKIP LOCKED updates across concurrent workers and outcomes across two tenants', async () => {
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

    const tenancyMod = await import('../src/tenancy/index');
    const coreMod = await import('../src/index');
    const runtimeMod = await import('../../src/platform/tenantRuntime');
    const servicesMod = (await import('../../src/server/services')) as Record<string, unknown>;
    const intakeRepo = new TenantIntakeQuoteRepository();
    const auditRepo = new tenancyMod.TenantAuditRepository();
    const jobRunRepo = new tenancyMod.TenantJobRunRepository();

    await jobRunRepo.clearTenantJobRuns(ctxAlpha);
    await jobRunRepo.clearTenantJobRuns(ctxBravo);

    const buildQuote = (id: string, overrides: Record<string, unknown>) => ({
      id,
      reference: id,
      clientType: 'person' as const,
      clientFirstName: 'RaceCheck',
      clientLastName: 'ConfidentialQuote',
      clientEmail: 'race.check@example.invalid',
      departmentId: 'DEPT-DISP',
      matterTypeId: 'MT-DISP-01',
      title: `Quote ${id}`,
      status: 'Sent',
      feeBasis: 'fixed' as const,
      estimatedFeeExVat: 1500,
      estimatedDisbursementsExVat: 0,
      vatRatePercent: 20,
      validUntil: '2026-10-01',
      ownerId: 'P-000001',
      createdById: 'P-000001',
      createdAt: '2026-09-01T09:00:00Z',
      updatedAt: '2026-09-01T09:00:00Z',
      sentAt: '2026-09-01T10:00:00Z',
      timeline: [],
      ...overrides,
    });

    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R675-A-ACCEPT', { status: 'Sent', validUntil: '2026-10-01' }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R675-A-EXTEND', { status: 'Sent', validUntil: '2026-10-01' }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R675-A-DUP', { status: 'Follow-up due', validUntil: '2026-10-05' }) as never);
    await intakeRepo.putQuote(ctxAlpha, buildQuote('QUO-R675-A-OK', { status: 'Sent', validUntil: '2026-10-01' }) as never);
    await intakeRepo.putQuote(ctxBravo, buildQuote('QUO-R675-B-LOCKED', { status: 'Sent', validUntil: '2026-10-01' }) as never);
    await intakeRepo.putQuote(ctxBravo, buildQuote('QUO-R675-B-RACE', { status: 'Sent', validUntil: '2026-10-01' }) as never);

    const countExpiryAudits = async (ctx: TenantContext, quoteId: string): Promise<number> => {
      const entries = await auditRepo.listAuditEntriesForRecord(ctx, 'quote', quoteId);
      return entries.filter((a) => a.field === 'Quote lifecycle status' && a.newValue === 'Expired').length;
    };
    const acceptAuditsBefore = await countExpiryAudits(ctxAlpha, 'QUO-R675-A-ACCEPT');
    const extendAuditsBefore = await countExpiryAudits(ctxAlpha, 'QUO-R675-A-EXTEND');
    const dupAuditsBefore = await countExpiryAudits(ctxAlpha, 'QUO-R675-A-DUP');
    const okAuditsBefore = await countExpiryAudits(ctxAlpha, 'QUO-R675-A-OK');

    const rawBase = structuredClone(runtimeMod.getActiveTenantRawBaseConfig()) as Record<string, unknown>;
    const alphaCfg = coreMod.loadAndValidateTenantConfig(
      rawBase,
      { tenantId: tenantAlpha, environment: 'test' },
      'test',
      'multi_tenant',
    );
    const bravoCfg = coreMod.loadAndValidateTenantConfig(
      rawBase,
      { tenantId: tenantBravo, environment: 'test' },
      'test',
      'multi_tenant',
    );

    const secondPoolManager = new tenancyMod.TenantPostgresPoolManager();
    const independentIntakeRepo = new TenantIntakeQuoteRepository({ poolManager: secondPoolManager });
    const execManual = servicesMod.executeQuoteExpiryForTenant as (
      ctx: TenantContext,
      opts: Record<string, unknown>,
    ) => Promise<{
      outcome: string;
      result?: { summary: { expiredCount: number } };
    }>;

    try {
      const seenHooks: string[] = [];
      const firstRun = await execManual(ctxAlpha, {
        triggerSource: 'manual',
        triggeredById: 'system:quote-expiry-worker-1',
        defaultRunHourLocal: 0,
        tenantConfig: alphaCfg,
        statementTimeoutMs: 3000,
        onBeforeExpireQuote: async (quoteId: string) => {
          seenHooks.push(quoteId);
          if (quoteId === 'QUO-R675-A-ACCEPT') {
            const existing = await independentIntakeRepo.getQuoteById<Record<string, unknown>>(
              ctxAlpha,
              quoteId,
              { includeRestricted: true },
            );
            await independentIntakeRepo.putQuote(ctxAlpha, {
              ...(existing as Record<string, unknown>),
              status: 'Accepted',
              outcomeAt: '2026-11-23T10:00:00Z',
              updatedAt: '2026-11-23T10:00:00Z',
            } as never);
          } else if (quoteId === 'QUO-R675-A-EXTEND') {
            const existing = await independentIntakeRepo.getQuoteById<Record<string, unknown>>(
              ctxAlpha,
              quoteId,
              { includeRestricted: true },
            );
            await independentIntakeRepo.putQuote(ctxAlpha, {
              ...(existing as Record<string, unknown>),
              validUntil: '2099-12-31',
              updatedAt: '2026-11-23T10:00:00Z',
            } as never);
          } else if (quoteId === 'QUO-R675-A-DUP') {
            // Simulate another independent worker expiring the quote before worker 1 persists
            const existing = await independentIntakeRepo.getQuoteById<Record<string, unknown>>(
              ctxAlpha,
              quoteId,
              { includeRestricted: true },
            );
            await independentIntakeRepo.putQuote(ctxAlpha, {
              ...(existing as Record<string, unknown>),
              status: 'Expired',
              timeline: [
                {
                  id: `QT-EXP-${quoteId}`,
                  kind: 'expired',
                  at: '2026-11-23T10:00:00Z',
                  byId: null,
                  title: 'Quote expired',
                  detail: 'Expired by worker 2.',
                },
              ],
              updatedAt: '2026-11-23T10:00:00Z',
            } as never);
          }
        },
      });

      expect(seenHooks).toContain('QUO-R675-A-ACCEPT');
      expect(seenHooks).toContain('QUO-R675-A-EXTEND');
      expect(seenHooks).toContain('QUO-R675-A-DUP');
      expect(seenHooks).toContain('QUO-R675-A-OK');
      expect(firstRun.outcome).toBe('executed');
      // Worker 1 expires only QUO-R675-A-OK (worker 2 expired QUO-R675-A-DUP; ACCEPT & EXTEND were updated concurrently).
      expect(firstRun.result?.summary.expiredCount).toBe(1);

      const acceptedQuote = await intakeRepo.getQuoteById<{ status: string; timeline: Array<{ kind: string }> }>(
        ctxAlpha,
        'QUO-R675-A-ACCEPT',
        { includeRestricted: true },
      );
      expect(acceptedQuote?.status).toBe('Accepted');
      expect(acceptedQuote?.timeline.some((t) => t.kind === 'expired')).toBe(false);
      expect((await countExpiryAudits(ctxAlpha, 'QUO-R675-A-ACCEPT')) - acceptAuditsBefore).toBe(0);

      const extendedQuote = await intakeRepo.getQuoteById<{ status: string; validUntil: string; timeline: Array<{ kind: string }> }>(
        ctxAlpha,
        'QUO-R675-A-EXTEND',
        { includeRestricted: true },
      );
      expect(extendedQuote?.status).toBe('Sent');
      expect(extendedQuote?.validUntil).toBe('2099-12-31');
      expect(extendedQuote?.timeline.some((t) => t.kind === 'expired')).toBe(false);
      expect((await countExpiryAudits(ctxAlpha, 'QUO-R675-A-EXTEND')) - extendAuditsBefore).toBe(0);

      const dupQuote = await intakeRepo.getQuoteById<{ status: string; timeline: Array<{ kind: string }> }>(
        ctxAlpha,
        'QUO-R675-A-DUP',
        { includeRestricted: true },
      );
      expect(dupQuote?.status).toBe('Expired');
      expect(dupQuote?.timeline.filter((t) => t.kind === 'expired')).toHaveLength(1);
      expect((await countExpiryAudits(ctxAlpha, 'QUO-R675-A-DUP')) - dupAuditsBefore).toBe(0);

      const okQuote = await intakeRepo.getQuoteById<{ status: string; timeline: Array<{ kind: string }> }>(
        ctxAlpha,
        'QUO-R675-A-OK',
        { includeRestricted: true },
      );
      expect(okQuote?.status).toBe('Expired');
      expect(okQuote?.timeline.filter((t) => t.kind === 'expired')).toHaveLength(1);
      expect((await countExpiryAudits(ctxAlpha, 'QUO-R675-A-OK')) - okAuditsBefore).toBe(1);

      // Bravo's overdue quotes remained completely untouched by Alpha's sweep, and SKIP LOCKED skips an uncommitted FOR UPDATE lock cleanly.
      const bravoBefore = await intakeRepo.getQuoteById<{ status: string }>(ctxBravo, 'QUO-R675-B-LOCKED', { includeRestricted: true });
      expect(bravoBefore?.status).toBe('Sent');

      const { applyQuoteEffectiveLifecycle } = await import('../../src/domain/quotes');
      const [race1, race2] = await Promise.all([
        intakeRepo.expireQuoteIfOverdue(ctxBravo, 'QUO-R675-B-RACE', {
          localDate: '2026-11-23',
          applyTransition: (q) => {
            const prev = q.status;
            const { changed, newlyExpired } = applyQuoteEffectiveLifecycle(q as never, new Date('2026-11-23T09:00:00Z'), {
              appendExpiredTimeline: true,
            });
            q.updatedAt = '2026-11-23T09:00:00Z';
            return { shouldPersist: changed || newlyExpired, previousStatus: prev };
          },
        }),
        independentIntakeRepo.expireQuoteIfOverdue(ctxBravo, 'QUO-R675-B-RACE', {
          localDate: '2026-11-23',
          applyTransition: (q) => {
            const prev = q.status;
            const { changed, newlyExpired } = applyQuoteEffectiveLifecycle(q as never, new Date('2026-11-23T09:00:00Z'), {
              appendExpiredTimeline: true,
            });
            q.updatedAt = '2026-11-23T09:00:00Z';
            return { shouldPersist: changed || newlyExpired, previousStatus: prev };
          },
        }),
      ]);
      expect([race1.expired, race2.expired].filter(Boolean)).toHaveLength(1);

      await independentIntakeRepo.withTenantTransaction(ctxBravo, async (tx) => {
        await tx.query('SELECT id FROM quotes WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctxBravo.tenantId, 'QUO-R675-B-LOCKED']);
        await execManual(ctxBravo, {
          triggerSource: 'manual',
          triggeredById: 'system:quote-expiry-locked',
          defaultRunHourLocal: 0,
          statementTimeoutMs: 2000,
          tenantConfig: bravoCfg,
        });
        const lockedQuoteState = await intakeRepo.getQuoteById<{ status: string }>(ctxBravo, 'QUO-R675-B-LOCKED', { includeRestricted: true });
        expect(lockedQuoteState?.status).toBe('Sent');
        throw new Error('__RELEASE_LOCK_ROLLBACK__');
      }).catch((err: Error) => {
        if (err.message !== '__RELEASE_LOCK_ROLLBACK__') throw err;
      });

      const unlockedRun = await execManual(ctxBravo, {
        triggerSource: 'manual',
        triggeredById: 'system:quote-expiry-unlocked',
        defaultRunHourLocal: 0,
        tenantConfig: bravoCfg,
      });
      expect(unlockedRun.result?.summary.expiredCount).toBe(1);
      const bravoAfter = await intakeRepo.getQuoteById<{ status: string }>(ctxBravo, 'QUO-R675-B-LOCKED', { includeRestricted: true });
      expect(bravoAfter?.status).toBe('Expired');
    } finally {
      await secondPoolManager.closeAllPools();
    }
  }, 30_000);
});
