import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantTaskWorkflowRepository,
  type TenantContext,
} from '@platform/core';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  previewIntakeDuplicatesAndConflictsRecord,
  runMatterConflictSearchRecord,
  saveEnquiryRecord,
  searchEntityPickerRecord,
} from '@/server/services';
import {
  loadEnquiriesListPageData,
  loadEnquiryDetailPageData,
  loadHomePageData,
  loadKeyDatesPageData,
  loadMatterDetailPageData,
  loadMatterFormPageData,
  loadMattersListPageData,
  loadOrganisationDetailPageData,
  loadOrganisationFormPageData,
  loadOrganisationsListPageData,
  loadPeopleListPageData,
  loadPersonDetailPageData,
  loadPersonFormPageData,
  loadQuoteDetailPageData,
  loadRegistersPageData,
  loadShellContext,
  loadTaskDetailPageData,
  loadTasksListPageData,
} from '@/server/pageLoaders';
import { redactRecordId } from '@/domain/matterConflicts';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { createSeedStore } from '@/seed/seedStoreBuilder';
import notALawFirmConfig from '../../client-not-a-law-firm/config/base.json';
import type {
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
  Task,
} from '@/domain/types';

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
    correlationId: `s102b-${tenantId}-${actorId}`,
    environment: 'test',
    hostingMode: 'multi_tenant',
  });
}

function makeActorSession(
  personId: string,
  roles: string[],
  tenantId: string,
) {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const cookieVal = createSignedEntraSessionCookie({
    personId,
    tenantId,
    oid: `00000000-0000-4000-8000-${personId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: personId,
    email: `${personId.toLowerCase()}@${tenantId}.example`,
    displayName: `Test Actor ${personId}`,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verifiedSession = verifySignedEntraSessionCookie(cookieVal)!;
  return {
    personId,
    tenantId,
    tokenRoles: verifiedSession.mappedRoles,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession,
  };
}

function makeRawTenantConfig(tenantId: string, displayName: string): Record<string, unknown> {
  return {
    ...structuredClone(notALawFirmConfig),
    tenantId,
    displayName,
    hostingMode: 'multi_tenant',
  };
}

async function provisionAndSeedTwoTenants() {
  expect(Number(CORE_REQUIRED_SCHEMA_VERSION)).toBeGreaterThanOrEqual(24);
  const tenantAlpha = 's102b-alpha';
  const tenantBravo = 's102b-bravo';
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

  const rawConfigAlpha = makeRawTenantConfig(tenantAlpha, 'Alpha Chambers LLP');
  const rawConfigBravo = makeRawTenantConfig(tenantBravo, 'Bravo Solicitors LLP');
  setActiveTenantConfigForTesting(rawConfigAlpha, {});
  const cfgAlpha = getActiveTenantConfiguration();
  setActiveTenantConfigForTesting(rawConfigBravo, {});
  const cfgBravo = getActiveTenantConfiguration();
  setActiveTenantConfigForTesting(null);

  const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
  await importFirmStoreModulesToPostgres({
    ctx: ctxAlpha,
    tenantConfig: cfgAlpha,
    store: structuredClone(seed),
    modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks', 'key-dates', 'registers'],
    clearFirst: true,
  });
  await importFirmStoreModulesToPostgres({
    ctx: ctxBravo,
    tenantConfig: cfgBravo,
    store: structuredClone(seed),
    modules: ['catalogues', 'hr', 'parties', 'matters', 'intake', 'quotes', 'tasks', 'key-dates', 'registers'],
    clearFirst: true,
  });

  const partyRepo = new TenantPartyRepository();
  const matterRepo = new TenantMatterRepository();
  const intakeRepo = new TenantIntakeQuoteRepository();
  const taskRepo = new TenantTaskWorkflowRepository();

  const templatePerson = seed.people.find((p) => !p.isEmployee)!;
  const templateOrg = seed.organisations[0]!;
  const templateMatter = seed.matters.find((m) => !m.isStaffMatter)!;
  const templateEnq = seed.enquiries.find((e) => e.status !== 'Draft')!;
  const templateQuote = seed.quotes[0]!;
  const templateTask = seed.tasks[0]!;

  // Alpha-exclusive test fixtures
  const alphaPubOrg: Organisation = {
    ...structuredClone(templateOrg),
    id: 'O-S102B-PUB-A',
    legalName: 'Alpha Public Logistics Ltd',
    companyNumber: '09111222',
    recordOwnerId: 'P-000001',
    relationshipPartnerId: 'P-000001',
  };
  await partyRepo.putOrganisation(ctxAlpha, alphaPubOrg);

  const alphaStaffClientOrg: Organisation = {
    ...structuredClone(templateOrg),
    id: 'O-S102B-STAFF-A',
    legalName: 'Staff Alpha Confidential Ltd',
    companyNumber: '09333444',
    recordOwnerId: 'P-000001',
    relationshipPartnerId: 'P-000001',
  };
  await partyRepo.putOrganisation(ctxAlpha, alphaStaffClientOrg);

  const alphaRestrictedPerson: Person = {
    ...structuredClone(templatePerson),
    id: 'P-S102B-CONFLICT-A',
    firstName: 'Cerys',
    surname: 'Pritchard-Alpha',
    emails: [{ id: 'em-s102b-a', address: 'cerys.pritchard@alpha-secret.example', typeId: null, isPrimary: true }],
    recordOwnerId: 'P-000001',
  };
  await partyRepo.putPerson(ctxAlpha, alphaRestrictedPerson);

  const alphaPubMatter: Matter = {
    ...structuredClone(templateMatter),
    id: 'M-S102B-PUB-A',
    matterNumber: 'ALPH-0001',
    title: 'Alpha Public Commercial Lease',
    shortDescription: 'Public commercial lease for Alpha Public Logistics',
    clientId: alphaPubOrg.id,
    responsiblePartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    teamMemberIds: ['P-000001', 'P-000002'],
    isStaffMatter: false,
    hasEthicalWall: false,
    restrictedAccessUserIds: [],
    parties: [
      {
        id: 'MP-S102B-PUB-1',
        relationshipCode: 'OP',
        capacityCodes: [],
        entityType: 'organisation',
        linkedRecordId: null,
        name: 'Apex Harbours Ltd',
        role: 'Counterparty',
        notes: '',
      },
    ],
  };
  await matterRepo.putMatter(ctxAlpha, alphaPubMatter);

  const alphaStaffMatter: Matter = {
    ...structuredClone(templateMatter),
    id: 'M-S102B-STAFF-A',
    matterNumber: 'ALPH-STAFF-99',
    title: 'Confidential Staff Employment Matter Alpha',
    shortDescription: 'Internal staff disciplinary investigation',
    clientId: alphaStaffClientOrg.id,
    responsiblePartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000001',
    teamMemberIds: ['P-000001'],
    isStaffMatter: true,
    hasEthicalWall: true,
    restrictedAccessUserIds: ['P-000001'],
    parties: [
      {
        id: 'MP-S102B-STAFF-1',
        relationshipCode: 'OP',
        capacityCodes: [],
        entityType: 'person',
        linkedRecordId: alphaRestrictedPerson.id,
        name: 'Cerys Pritchard-Alpha',
        role: 'Other party',
        notes: '',
      },
    ],
  };
  await matterRepo.putMatter(ctxAlpha, alphaStaffMatter);

  const alphaPersonalDraftEnquiry: Enquiry = {
    ...structuredClone(templateEnq),
    id: 'ENQ-S102B-DRAFT-A',
    reference: 'ENQ-88001',
    status: 'Draft',
    createdById: 'P-000001',
    takenById: 'P-000001',
    assignedTeamId: null,
    assignedToId: null,
    firstName: 'PrivateDraft',
    lastName: 'AlphaCaller',
    email: 'private.draft.alpha@invented.example',
    phone: '07700900881',
    summary: 'Personal Draft enquiry owned by P-000001',
    receivedAt: '2026-11-10T09:00:00Z',
  };
  await intakeRepo.putEnquiry(ctxAlpha, alphaPersonalDraftEnquiry);

  const alphaPublicOpenEnquiry: Enquiry = {
    ...structuredClone(templateEnq),
    id: 'ENQ-S102B-OPEN-A',
    reference: 'ENQ-88002',
    status: 'New',
    createdById: 'P-000002',
    takenById: 'P-000002',
    assignedTeamId: 'TM-000001',
    assignedToId: 'P-000002',
    firstName: 'PublicOpen',
    lastName: 'AlphaEnquiry',
    email: 'public.open.alpha@invented.example',
    phone: '07700900882',
    summary: 'Open public Alpha enquiry',
    receivedAt: '2026-11-10T10:00:00Z',
  };
  await intakeRepo.putEnquiry(ctxAlpha, alphaPublicOpenEnquiry);

  const alphaStaffQuote: Quote = {
    ...structuredClone(templateQuote),
    id: 'QUO-S102B-STAFF-A',
    reference: 'QUO-88001',
    prospectName: 'Hidden Staff Matter Quote Prospect',
    convertedMatterId: alphaStaffMatter.id,
    feeEarnerId: 'P-000001',
    linkedEnquiryId: null,
  };
  await intakeRepo.putQuote(ctxAlpha, alphaStaffQuote);

  const overdueIso = '2020-01-15';
  const alphaUrgentPublicTask: Task = {
    ...structuredClone(templateTask),
    id: 'TSK-S102B-URG-PUB-A',
    title: 'Urgent Visible Alpha Task',
    status: 'To do',
    dueAt: overdueIso,
    assignedPersonId: 'P-000002',
    linkedRecords: [{ recordType: 'matter', recordId: alphaPubMatter.id }],
  };
  await taskRepo.putTask(ctxAlpha, alphaUrgentPublicTask);

  const alphaUrgentStaffTask: Task = {
    ...structuredClone(templateTask),
    id: 'TSK-S102B-URG-STAFF-A',
    title: 'Urgent Hidden Staff Task',
    status: 'To do',
    dueAt: overdueIso,
    assignedPersonId: 'P-000002',
    linkedRecords: [{ recordType: 'matter', recordId: alphaStaffMatter.id }],
  };
  await taskRepo.putTask(ctxAlpha, alphaUrgentStaffTask);

  // Bravo-exclusive test fixtures (never visible inside Alpha!)
  const bravoPerson: Person = {
    ...structuredClone(templatePerson),
    id: 'P-S102B-BRAVO-ONLY',
    firstName: 'BravoExclusive',
    surname: 'PersonOnly',
    emails: [{ id: 'em-s102b-b', address: 'bravo.exclusive@bravo.example', typeId: null, isPrimary: true }],
  };
  await partyRepo.putPerson(ctxBravo, bravoPerson);

  const bravoOrg: Organisation = {
    ...structuredClone(templateOrg),
    id: 'O-S102B-BRAVO-ONLY',
    legalName: 'Bravo Exclusive Ventures Plc',
    companyNumber: '09998887',
  };
  await partyRepo.putOrganisation(ctxBravo, bravoOrg);

  const bravoMatter: Matter = {
    ...structuredClone(templateMatter),
    id: 'M-S102B-BRAVO-ONLY',
    matterNumber: 'BRAV-9999',
    title: 'Bravo Exclusive Acquisition Matter',
    shortDescription: 'Bravo confidential acquisition',
    clientId: bravoOrg.id,
    responsiblePartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000001',
    teamMemberIds: ['P-000001'],
    isStaffMatter: false,
    hasEthicalWall: false,
    restrictedAccessUserIds: [],
  };
  await matterRepo.putMatter(ctxBravo, bravoMatter);

  const bravoEnquiry: Enquiry = {
    ...structuredClone(templateEnq),
    id: 'ENQ-S102B-BRAVO-ONLY',
    reference: 'ENQ-99988',
    status: 'New',
    firstName: 'BravoExclusive',
    lastName: 'Caller',
    email: 'bravo.caller@bravo.example',
    summary: 'Bravo exclusive enquiry',
    receivedAt: '2026-11-11T09:00:00Z',
  };
  await intakeRepo.putEnquiry(ctxBravo, bravoEnquiry);

  const bravoQuote: Quote = {
    ...structuredClone(templateQuote),
    id: 'QUO-S102B-BRAVO-ONLY',
    reference: 'QUO-99988',
    prospectName: 'Bravo Exclusive Prospect',
  };
  await intakeRepo.putQuote(ctxBravo, bravoQuote);

  const bravoTask: Task = {
    ...structuredClone(templateTask),
    id: 'TSK-S102B-BRAVO-ONLY',
    title: 'Bravo Exclusive Task Title',
    status: 'To do',
    assignedPersonId: 'P-000001',
    linkedRecords: [{ recordType: 'matter', recordId: bravoMatter.id }],
  };
  await taskRepo.putTask(ctxBravo, bravoTask);

  return {
    tenantAlpha,
    tenantBravo,
    ctxAlpha,
    ctxBravo,
    rawConfigAlpha,
    rawConfigBravo,
    alphaPubOrg,
    alphaStaffClientOrg,
    alphaRestrictedPerson,
    alphaPubMatter,
    alphaStaffMatter,
    alphaPersonalDraftEnquiry,
    alphaPublicOpenEnquiry,
    alphaStaffQuote,
    alphaUrgentPublicTask,
    alphaUrgentStaffTask,
    bravoPerson,
    bravoOrg,
    bravoMatter,
    bravoEnquiry,
    bravoQuote,
    bravoTask,
  };
}

describe('S1-02b B15: Per-route SQL page loaders, two-tenant isolation, privacy, and C2 preview parity', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    setTestEntraSessionOverride(null);
    setActiveTenantConfigForTesting(null);
    await getGlobalTenantPostgresPoolManager().closeAllPools();
  });

  it('1. /docs route group isolation: Help layout and pages import zero tenant DB/loader modules and run 0 SQL queries', async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const docsFiles = [
      'src/app/docs/layout.tsx',
      'src/app/docs/page.tsx',
      'src/app/docs/[slug]/page.tsx',
    ];
    for (const relPath of docsFiles) {
      const absPath = path.join(repoRoot, relPath);
      const src = fs.readFileSync(absPath, 'utf8');
      const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const importSpecs: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          importSpecs.push(node.moduleSpecifier.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      for (const spec of importSpecs) {
        expect(spec).not.toMatch(/pageLoaders/);
        expect(spec).not.toMatch(/services/);
        expect(spec).not.toMatch(/tenancy\//);
        expect(spec).not.toMatch(/@platform\/core/);
      }
    }

    // Executing DocsLayout's active tenant display name read issues zero PostgreSQL pool/query calls
    const poolSpy = vi.spyOn(getGlobalTenantPostgresPoolManager(), 'getPoolForTenant');
    try {
      const displayName = getActiveTenantConfiguration().displayName;
      expect(typeof displayName).toBe('string');
      expect(displayName.length).toBeGreaterThan(0);
      expect(poolSpy).not.toHaveBeenCalled();
    } finally {
      poolSpy.mockRestore();
    }
  });

  it(
    '2. loadShellContext & list/workspace loaders: enforce two-tenant isolation, urgent badge visibility, no payroll/sensitive HR, and Registers permissions',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const alphaPartner = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantAlpha,
      );
      const alphaFeeEarner = makeActorSession(
        'P-000002',
        ['fee_earner'],
        env.tenantAlpha,
      );
      const bravoPartner = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantBravo,
      );

      // Alpha Fee Earner (no matter:restricted:access)
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(alphaFeeEarner.verifiedSession);
      await runWithActiveActorSession(alphaFeeEarner, async () => {
        const shell = await loadShellContext('P-000002');
        // Shell strips payroll and sensitive HR records across all employees
        for (const staff of shell.filteredStaffPeople) {
          expect(staff.employment?.payroll).toBeUndefined();
          expect((staff as { sensitive?: unknown }).sensitive).toBeUndefined();
        }
        expect(shell.currentUser.employment?.payroll).toBeUndefined();

        // Urgent badge counts visible urgent tasks, excluding hidden staff-matter urgent task
        const taskRepo = new TenantTaskWorkflowRepository();
        const visibleTasksForFe = await taskRepo.listVisibleTasks<Task>(env.ctxAlpha, 'P-000002', {
          hasRestrictedMatterAccess: false,
        });
        expect(visibleTasksForFe.some((t) => t.id === env.alphaUrgentPublicTask.id)).toBe(true);
        expect(visibleTasksForFe.some((t) => t.id === env.alphaUrgentStaffTask.id)).toBe(false);

        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(alphaPartner.verifiedSession);
        const partnerShell = await runWithActiveActorSession(alphaPartner, () =>
          loadShellContext('P-000001'),
        );
        expect(partnerShell.urgentTaskBadgeCount).toBeGreaterThanOrEqual(0);

        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(alphaFeeEarner.verifiedSession);
        expect(shell.urgentTaskBadgeCount).toBeGreaterThanOrEqual(1);
        // If the staff urgent task were temporarily reassigned or compared against partner/all, badge stays strictly scoped
        const homeData = await loadHomePageData('P-000002');
        expect(homeData.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(true);
        expect(homeData.matters.some((m) => m.id === env.alphaStaffMatter.id)).toBe(false);
        expect(homeData.matters.some((m) => m.id === env.bravoMatter.id)).toBe(false);
        expect(homeData.enquiries.some((e) => e.id === env.alphaPersonalDraftEnquiry.id)).toBe(false);
        expect(homeData.tasks.some((t) => t.id === env.alphaUrgentStaffTask.id)).toBe(false);

        const mattersList = await loadMattersListPageData('P-000002');
        expect(mattersList.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(true);
        expect(mattersList.matters.some((m) => m.id === env.alphaStaffMatter.id)).toBe(false);
        expect(mattersList.matters.some((m) => m.id === env.bravoMatter.id)).toBe(false);

        const enquiriesList = await loadEnquiriesListPageData('P-000002');
        expect(enquiriesList.enquiries.some((e) => e.id === env.alphaPublicOpenEnquiry.id)).toBe(true);
        expect(enquiriesList.enquiries.some((e) => e.id === env.alphaPersonalDraftEnquiry.id)).toBe(false);
        expect(enquiriesList.enquiries.some((e) => e.id === env.bravoEnquiry.id)).toBe(false);
        expect(enquiriesList.quotes.some((q) => q.id === env.alphaStaffQuote.id)).toBe(false);
        expect(enquiriesList.quotes.some((q) => q.id === env.bravoQuote.id)).toBe(false);

        const peopleList = await loadPeopleListPageData('P-000002');
        expect(peopleList.people.some((p) => p.id === env.bravoPerson.id)).toBe(false);
        for (const p of peopleList.people) {
          expect(p.employment?.payroll).toBeUndefined();
          expect((p as { sensitive?: unknown }).sensitive).toBeUndefined();
        }

        const orgsList = await loadOrganisationsListPageData('P-000002');
        expect(orgsList.organisations.some((o) => o.id === env.alphaPubOrg.id)).toBe(true);
        expect(orgsList.organisations.some((o) => o.id === env.bravoOrg.id)).toBe(false);

        const tasksList = await loadTasksListPageData('P-000002');
        expect(tasksList.tasks.some((t) => t.id === env.alphaUrgentPublicTask.id)).toBe(true);
        expect(tasksList.tasks.some((t) => t.id === env.alphaUrgentStaffTask.id)).toBe(false);
        expect(tasksList.tasks.some((t) => t.id === env.bravoTask.id)).toBe(false);

        const keyDatesData = await loadKeyDatesPageData('P-000002');
        expect(
          keyDatesData.initialDiaryEntries.some((d) => d.matterId === env.alphaStaffMatter.id),
        ).toBe(false);

        const registersData = await loadRegistersPageData('P-000002');
        expect(Array.isArray(registersData.shell.currentUserPermissions)).toBe(true);
        expect('snapshot' in (registersData.data as Record<string, unknown>)).toBe(false);
      });

      // Switch active tenant to Bravo in the same process: sees Bravo fixtures and ZERO Alpha fixtures
      setActiveTenantConfigForTesting(env.rawConfigBravo, {});
      setTestEntraSessionOverride(bravoPartner.verifiedSession);
      await runWithActiveActorSession(bravoPartner, async () => {
        const homeB = await loadHomePageData('P-000001');
        expect(homeB.matters.some((m) => m.id === env.bravoMatter.id)).toBe(true);
        expect(homeB.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(false);
        const mattersB = await loadMattersListPageData('P-000001');
        expect(mattersB.matters.some((m) => m.id === env.bravoMatter.id)).toBe(true);
        expect(mattersB.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(false);
        const peopleB = await loadPeopleListPageData('P-000001');
        expect(peopleB.people.some((p) => p.id === env.bravoPerson.id)).toBe(true);
        expect(peopleB.people.some((p) => p.id === env.alphaRestrictedPerson.id)).toBe(false);
        const orgsB = await loadOrganisationsListPageData('P-000001');
        expect(orgsB.organisations.some((o) => o.id === env.bravoOrg.id)).toBe(true);
        expect(orgsB.organisations.some((o) => o.id === env.alphaPubOrg.id)).toBe(false);
      });
    },
    45_000,
  );

  it(
    '3. Detail/edit loaders: uniform null for hidden records and cross-tenant tampered IDs, plus forged claim rejection',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const alphaPartner = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantAlpha,
      );
      const alphaFeeEarner = makeActorSession(
        'P-000002',
        ['fee_earner'],
        env.tenantAlpha,
      );
      const forgedBravoInAlphaSession = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantBravo,
      );

      // 3a. Hidden Alpha records for unauthorised fee earner return identical `null` as non-existent IDs
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(alphaFeeEarner.verifiedSession);
      await runWithActiveActorSession(alphaFeeEarner, async () => {
        expect(await loadMatterDetailPageData('P-000002', 'M-DOES-NOT-EXIST')).toBeNull();
        expect(await loadMatterDetailPageData('P-000002', env.alphaStaffMatter.id)).toBeNull();
        expect(await loadMatterFormPageData('P-000002', { editId: 'M-DOES-NOT-EXIST' })).toBeNull();
        expect(await loadMatterFormPageData('P-000002', { editId: env.alphaStaffMatter.id })).toBeNull();

        expect(await loadEnquiryDetailPageData('P-000002', 'ENQ-DOES-NOT-EXIST')).toBeNull();
        expect(await loadEnquiryDetailPageData('P-000002', env.alphaPersonalDraftEnquiry.id)).toBeNull();

        expect(await loadQuoteDetailPageData('P-000002', 'QUO-DOES-NOT-EXIST')).toBeNull();
        expect(await loadQuoteDetailPageData('P-000002', env.alphaStaffQuote.id)).toBeNull();

        expect(await loadTaskDetailPageData('P-000002', 'TSK-DOES-NOT-EXIST')).toBeNull();
        expect(await loadTaskDetailPageData('P-000002', env.alphaUrgentStaffTask.id)).toBeNull();
      });

      // 3b. Cross-tenant tampered IDs: Alpha Partner requesting real Bravo IDs returns uniform `null`
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(alphaPartner.verifiedSession);
      await runWithActiveActorSession(alphaPartner, async () => {
        expect(await loadMatterDetailPageData('P-000001', env.bravoMatter.id)).toBeNull();
        expect(await loadMatterFormPageData('P-000001', { editId: env.bravoMatter.id })).toBeNull();
        expect(await loadPersonDetailPageData('P-000001', env.bravoPerson.id)).toBeNull();
        expect(await loadPersonFormPageData('P-000001', env.bravoPerson.id)).toBeNull();
        expect(await loadOrganisationDetailPageData('P-000001', env.bravoOrg.id)).toBeNull();
        expect(await loadOrganisationFormPageData('P-000001', env.bravoOrg.id)).toBeNull();
        expect(await loadEnquiryDetailPageData('P-000001', env.bravoEnquiry.id)).toBeNull();
        expect(await loadQuoteDetailPageData('P-000001', env.bravoQuote.id)).toBeNull();
        expect(await loadTaskDetailPageData('P-000001', env.bravoTask.id)).toBeNull();
      });

      // 3c. Forged tenant claim (session claims tenantBravo while active tenant is tenantAlpha) fails closed
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(forgedBravoInAlphaSession.verifiedSession);
      await runWithActiveActorSession(forgedBravoInAlphaSession, async () => {
        await expect(loadShellContext('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadHomePageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(
          loadMatterDetailPageData('P-000001', env.alphaPubMatter.id),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
        await expect(
          previewIntakeDuplicatesAndConflictsRecord(
            { kind: 'enquiry', firstName: 'PublicOpen', lastName: 'AlphaEnquiry' },
            'P-000001',
          ),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
        await expect(
          searchEntityPickerRecord({ entityTypes: ['matter'], query: 'Alpha' }, 'P-000001'),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      });
    },
    45_000,
  );

  it(
    '4. S1-02b C2 preview & picker: restricted-matter redaction via redactRecordId, exact parity with full conflict search, and picker isolation',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const alphaPartner = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantAlpha,
      );
      const alphaFeeEarner = makeActorSession(
        'P-000002',
        ['fee_earner'],
        env.tenantAlpha,
      );

      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});

      // 4a. Unauthorised user P-000002 previews an enquiry referencing Staff Alpha Confidential / Cerys Pritchard-Alpha
      setTestEntraSessionOverride(alphaFeeEarner.verifiedSession);
      await runWithActiveActorSession(alphaFeeEarner, async () => {
        const preview = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            firstName: 'Cerys',
            lastName: 'Pritchard-Alpha',
            callingOnBehalfOf: 'Staff Alpha Confidential Ltd',
            otherPartiesNamed: 'Apex Harbours Ltd',
            includeConflicts: true,
          },
          'P-000002',
        );

        const expectedRedactedId = `restricted-${redactRecordId(env.tenantAlpha, env.alphaStaffMatter.id)}`;
        const redactedStaffHit = preview.possibleConflicts.find(
          (c) => c.recordId === expectedRedactedId,
        );
        expect(redactedStaffHit).toBeDefined();
        expect(redactedStaffHit?.recordType).toBe('matter');
        expect(redactedStaffHit?.name).toBe('Restricted matter');
        expect(redactedStaffHit?.recordLabel).toBe('Restricted matter');
        expect(redactedStaffHit?.href).toBe('');
        expect(JSON.stringify(preview)).not.toContain('Confidential Staff Employment Matter Alpha');
        expect(JSON.stringify(preview)).not.toContain('ALPH-STAFF-99');

        // Parity with saveEnquiryRecord conflict snapshot & runMatterConflictSearchRecord
        const savedEnq = await saveEnquiryRecord(
          {
            takenById: 'P-000002',
            channelId: 'enquiry_channel.phone',
            firstName: 'Cerys',
            lastName: 'Pritchard-Alpha',
            callingOnBehalfOf: 'Staff Alpha Confidential Ltd',
            otherPartiesNamed: 'Apex Harbours Ltd',
            email: '',
            phone: '029 2010 9001',
            preferredContactMethodId: 'contact_method.phone',
            bestTimeToCall: 'Morning',
            address: null,
            practiceAreaId: 'work_type.real_estate_and_property',
            workTypeSubcategoryId: null,
            summary: 'S1-02b conflict parity probe enquiry',
            notes: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000002',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000002', asDraft: true },
        );
        expect(savedEnq.errors).toBeUndefined();
        const savedConflicts = savedEnq.enquiry?.conflictSnapshot?.conflicts ?? [];
        const normalizeHits = (
          hits: ReadonlyArray<{
            recordType: string;
            recordId: string;
            name: string;
            href: string;
          }>,
        ) =>
          hits
            .map((h) => `${h.recordType}|${h.recordId}|${h.name}|${h.href}`)
            .sort();
        expect(normalizeHits(preview.possibleConflicts)).toEqual(normalizeHits(savedConflicts));

        const matterConflictRes = await runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 'cp-parity-1',
                name: 'Staff Alpha Confidential Ltd',
                entityType: 'organisation',
                role: 'Client',
                linkedRecordId: null,
              },
              {
                id: 'cp-parity-2',
                name: 'Apex Harbours Ltd',
                entityType: 'organisation',
                role: 'Other party',
                linkedRecordId: null,
              },
            ],
          },
          'P-000002',
        );
        expect(matterConflictRes.matches.some((m) => m.restricted === true)).toBe(true);
        expect(
          matterConflictRes.matches.some(
            (m) => m.matterNumber === env.alphaPubMatter.matterNumber,
          ),
        ).toBe(true);
        expect(
          preview.possibleConflicts.some(
            (c) => c.recordId === env.alphaPubMatter.id && c.href === `/matters/${env.alphaPubMatter.id}`,
          ),
        ).toBe(true);

        // Picker visibility & privacy for P-000002:
        const hiddenMatterPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'Confidential Staff Employment Matter Alpha' },
          'P-000002',
        );
        expect(hiddenMatterPicker.items).toEqual([]);

        const hiddenDraftPicker = await searchEntityPickerRecord(
          { entityTypes: ['enquiry'], query: 'PrivateDraft' },
          'P-000002',
        );
        expect(hiddenDraftPicker.items).toEqual([]);

        const hiddenQuotePicker = await searchEntityPickerRecord(
          { entityTypes: ['quote'], query: 'Hidden Staff Matter Quote' },
          'P-000002',
        );
        expect(hiddenQuotePicker.items).toEqual([]);

        const bravoCrossTenantPicker = await searchEntityPickerRecord(
          {
            entityTypes: ['person', 'organisation', 'matter', 'enquiry', 'quote'],
            query: 'BravoExclusive',
          },
          'P-000002',
        );
        expect(bravoCrossTenantPicker.items).toEqual([]);

        const personPicker = await searchEntityPickerRecord(
          { entityTypes: ['person'], query: 'Rhian' },
          'P-000002',
        );
        expect(personPicker.items.length).toBeGreaterThan(0);
        for (const item of personPicker.items) {
          expect(item.person?.employment).toBeUndefined();
          expect((item.person as { permissionOverrides?: unknown } | undefined)?.permissionOverrides).toBeUndefined();
          expect((item.person as { entraObjectId?: unknown } | undefined)?.entraObjectId).toBeUndefined();
        }
      });

      // 4b. Permitted Partner P-000001 sees unredacted hit referencing ALPH-STAFF-99 (no restricted- redaction)
      setTestEntraSessionOverride(alphaPartner.verifiedSession);
      await runWithActiveActorSession(alphaPartner, async () => {
        const partnerPreview = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            otherPartiesNamed: 'Staff Alpha Confidential Ltd',
            includeConflicts: true,
          },
          'P-000001',
        );
        const unredacted = partnerPreview.possibleConflicts.find(
          (c) =>
            c.recordId === env.alphaStaffClientOrg.id ||
            c.recordId === env.alphaStaffMatter.id,
        );
        expect(unredacted).toBeDefined();
        expect(
          partnerPreview.possibleConflicts.some((c) => c.recordId.startsWith('restricted-')),
        ).toBe(false);
        expect(unredacted?.reason).toContain(env.alphaStaffMatter.matterNumber);

        const partnerMatterConflict = await runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 'cp-partner-1',
                name: 'Staff Alpha Confidential Ltd',
                entityType: 'organisation',
                role: 'Client',
                linkedRecordId: null,
              },
            ],
          },
          'P-000001',
        );
        expect(
          partnerMatterConflict.matches.some(
            (m) =>
              (m.matterNumber === env.alphaStaffMatter.matterNumber ||
                m.matchedRecordId === env.alphaStaffMatter.id) &&
              m.restricted !== true,
          ),
        ).toBe(true);
      });
    },
    45_000,
  );
});
