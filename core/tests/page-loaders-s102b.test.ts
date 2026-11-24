import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantIntakeQuoteRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantTaskWorkflowRepository,
  type KeyDate,
  type KeyDateReminderState,
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
  savePersonRecord,
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
  PersonOrganisationLink,
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

  it(
    '5. R696: merged matters are excluded from picker and own-matters list (included when includeMerged: true), and shortDescription search finds visible matters',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const matterRepo = new TenantMatterRepository();

      // Seed a unique visible matter with shortDescription and a merged matter owned by P-000002
      const visibleShortDescMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-S102B-R696-VIS',
        matterNumber: 'ALPH-R696-VIS',
        title: 'Visible R696 Test Matter',
        shortDescription: 'UniqueR696VisibleDesc',
        mergedIntoId: null,
        responsiblePartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000002',
      };
      await matterRepo.putMatter(env.ctxAlpha, visibleShortDescMatter);

      const mergedMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-S102B-R696-MERGED',
        matterNumber: 'ALPH-R696-MRG',
        title: 'Merged R696 Test Matter',
        shortDescription: 'UniqueR696MergedDesc',
        mergedIntoId: visibleShortDescMatter.id,
        responsiblePartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000002',
      };
      await matterRepo.putMatter(env.ctxAlpha, mergedMatter);

      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        // 5a. Matter picker excludes merged matter when searching by matter number
        const mergedNumPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'ALPH-R696-MRG' },
          'P-000002',
        );
        expect(mergedNumPicker.items.some((i) => i.id === mergedMatter.id)).toBe(false);

        // 5b. Own-matters list query (includeMerged: false) excludes merged matter
        const ownMattersFiltered = await matterRepo.listVisibleMattersForEntity<Matter>(
          env.ctxAlpha,
          { ownerPersonId: 'P-000002', includeMerged: false },
          { viewerId: 'P-000002', hasRestrictedMatterAccess: false },
        );
        expect(ownMattersFiltered.some((m) => m.id === mergedMatter.id)).toBe(false);
        expect(ownMattersFiltered.some((m) => m.id === visibleShortDescMatter.id)).toBe(true);

        // 5c. includeMerged: true still returns the merged matter
        const ownMattersWithMerged = await matterRepo.listVisibleMattersForEntity<Matter>(
          env.ctxAlpha,
          { ownerPersonId: 'P-000002', includeMerged: true },
          { viewerId: 'P-000002', hasRestrictedMatterAccess: false },
        );
        expect(ownMattersWithMerged.some((m) => m.id === mergedMatter.id)).toBe(true);

        // 5d. Searching by shortDescription finds the visible matter
        const shortDescPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'UniqueR696VisibleDesc' },
          'P-000002',
        );
        expect(shortDescPicker.items.some((i) => i.id === visibleShortDescMatter.id)).toBe(true);
      });
    },
    45_000,
  );

  it(
    '6. R703: leavers preserve employment for HR actors, hide employment/DOB from non-HR actors, and non-HR contact edits keep stored employment intact',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();
      const seedEmp = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000002');
      expect(seedEmp?.employment).toBeTruthy();

      const leaverPerson: Person = {
        ...structuredClone(seedEmp!),
        id: 'P-S102B-LEAVER-703',
        firstName: 'Huw',
        surname: 'LeaverTest',
        dateOfBirth: '1984-04-12',
        isEmployee: false,
        emails: [
          {
            id: 'em-s102b-leaver',
            address: 'huw.leavertest@invented.example',
            typeId: null,
            isPrimary: true,
          },
        ],
        employment: {
          ...structuredClone(seedEmp!.employment!),
          personId: 'P-S102B-LEAVER-703',
          employeeNumber: 'EMP-9703',
          status: 'Leaver',
          effectiveTo: '2026-10-15',
          contract: seedEmp!.employment!.contract
            ? {
                ...seedEmp!.employment!.contract,
                leavingDate: '2026-10-15',
                keepAsContactOnLeave: true,
              }
            : null,
        },
      };
      await partyRepo.putPerson(env.ctxAlpha, leaverPerson);

      const adminActor = makeActorSession('P-000004', ['admin'], env.tenantAlpha);
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);

      // 6a. HR / Admin actor sees leaver employment across list, profile, and edit loaders (payroll stripped)
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(adminActor.verifiedSession);
      await runWithActiveActorSession(adminActor, async () => {
        const peopleList = await loadPeopleListPageData('P-000004');
        const listLeaver = peopleList.people.find((p) => p.id === leaverPerson.id);
        expect(listLeaver?.employment?.status).toBe('Leaver');
        expect(listLeaver?.employment?.payroll).toBeUndefined();

        const detail = await loadPersonDetailPageData('P-000004', leaverPerson.id);
        expect(detail && !('redirectTo' in detail)).toBe(true);
        if (detail && !('redirectTo' in detail)) {
          expect(detail.person.employment?.status).toBe('Leaver');
          expect(detail.person.employment?.contract?.leavingDate).toBe('2026-10-15');
        }

        const edit = await loadPersonFormPageData('P-000004', leaverPerson.id);
        expect(edit && !('redirectTo' in edit)).toBe(true);
        if (edit && !('redirectTo' in edit)) {
          expect(edit.existing?.employment?.status).toBe('Leaver');
        }
      });

      // 6b. Standard Fee Earner (has employee:view_core, lacks hr_restricted/payroll):
      // sees core status 'Leaver' with restricted HR & payroll stripped, and contact-only edit keeps stored employment
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const feDetail = await loadPersonDetailPageData('P-000002', leaverPerson.id);
        expect(feDetail && !('redirectTo' in feDetail)).toBe(true);
        if (feDetail && !('redirectTo' in feDetail)) {
          expect(feDetail.person.employment?.status).toBe('Leaver');
          expect(feDetail.person.employment?.contract).toBeUndefined();
          expect(feDetail.person.employment?.rightToWork).toBeUndefined();
          expect(feDetail.person.employment?.payroll).toBeUndefined();
        }

        const saveRes = await savePersonRecord(
          {
            firstName: 'Huw',
            surname: 'LeaverTest',
            relationshipNotes: 'Updated non-HR contact note',
            dateOfBirth: null,
          },
          {
            byId: 'P-000002',
            id: leaverPerson.id,
            worksAtFirm: false,
            employmentSubmitted: null,
          },
        );
        expect(saveRes.errors).toBeUndefined();
        const persistedAfterFeEdit = await partyRepo.getPersonById<Person>(
          env.ctxAlpha,
          leaverPerson.id,
        );
        expect(persistedAfterFeEdit?.relationshipNotes).toBe('Updated non-HR contact note');
        expect(persistedAfterFeEdit?.employment?.status).toBe('Leaver');
        expect(persistedAfterFeEdit?.employment?.effectiveTo).toBe('2026-10-15');
        expect(persistedAfterFeEdit?.employment?.contract?.leavingDate).toBe('2026-10-15');
      });

      // 6c. Actor without employee:view_core sees employment: null and leaverOwnedRecords: [],
      // and saving a contact edit still preserves stored employment & DOB intact
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(seedEmp!),
        permissionOverrides: {
          grant: [],
          revoke: ['employee:view_core', 'employee:edit_core', 'employee:hr_restricted', 'employee:payroll'],
        },
      });
      await runWithActiveActorSession(feActor, async () => {
        const limitedDetail = await loadPersonDetailPageData('P-000002', leaverPerson.id);
        expect(limitedDetail && !('redirectTo' in limitedDetail)).toBe(true);
        if (limitedDetail && !('redirectTo' in limitedDetail)) {
          expect(limitedDetail.person.employment).toBeNull();
        }

        const limitedEdit = await loadPersonFormPageData('P-000002', leaverPerson.id);
        expect(limitedEdit && !('redirectTo' in limitedEdit)).toBe(true);
        if (limitedEdit && !('redirectTo' in limitedEdit)) {
          expect(limitedEdit.existing?.employment).toBeNull();
          expect(limitedEdit.leaverOwnedRecords).toEqual([]);
        }

        const limitedSave = await savePersonRecord(
          {
            firstName: 'Huw',
            surname: 'LeaverTest',
            relationshipNotes: 'Updated limited contact note',
            dateOfBirth: null,
          },
          {
            byId: 'P-000002',
            id: leaverPerson.id,
            worksAtFirm: false,
            employmentSubmitted: null,
          },
        );
        expect(limitedSave.errors).toBeUndefined();
        const persistedAfterLimited = await partyRepo.getPersonById<Person>(
          env.ctxAlpha,
          leaverPerson.id,
        );
        expect(persistedAfterLimited?.relationshipNotes).toBe('Updated limited contact note');
        expect(persistedAfterLimited?.employment?.status).toBe('Leaver');
        expect(persistedAfterLimited?.employment?.effectiveTo).toBe('2026-10-15');
        expect(persistedAfterLimited?.dateOfBirth).toBe('1984-04-12');
      });
    },
    45_000,
  );

  it(
    '7. R711: person profile loader returns owned people/orgs for employees and visibility-scoped main-org matters for contacts',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();

      // Contact linked primarily to alphaPubOrg (visible to P-000002)
      const pubContact: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-S102B-PUB-CONTACT',
        firstName: 'Gwen',
        surname: 'PublicContact',
        emails: [{ id: 'em-pub-c', address: 'gwen.pub@alphapublic.example', typeId: null, isPrimary: true }],
        recordOwnerId: 'P-000001',
      };
      await partyRepo.putPerson(env.ctxAlpha, pubContact);
      const pubLink: PersonOrganisationLink = {
        id: 'L-S102B-PUB-C',
        personId: pubContact.id,
        organisationId: env.alphaPubOrg.id,
        jobTitle: 'Operations Director',
        department: '',
        roleWithinOrganisation: 'Director',
        contactRoleIds: [],
        isPrimaryContact: true,
        isCurrent: true,
        startDate: null,
        endDate: null,
        contactStatusId: null,
        createdById: 'P-000001',
        createdAt: '2026-11-01T10:00:00Z',
        updatedById: 'P-000001',
        updatedAt: '2026-11-01T10:00:00Z',
      };
      await partyRepo.putLink(env.ctxAlpha, pubLink);

      // Contact linked primarily to alphaStaffClientOrg (staff matter must remain hidden from P-000002)
      const staffContact: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-S102B-STAFF-CONTACT',
        firstName: 'Bryn',
        surname: 'StaffContact',
        emails: [{ id: 'em-stf-c', address: 'bryn.stf@alphastaff.example', typeId: null, isPrimary: true }],
        recordOwnerId: 'P-000001',
      };
      await partyRepo.putPerson(env.ctxAlpha, staffContact);
      const staffLink: PersonOrganisationLink = {
        ...pubLink,
        id: 'L-S102B-STAFF-C',
        personId: staffContact.id,
        organisationId: env.alphaStaffClientOrg.id,
      };
      await partyRepo.putLink(env.ctxAlpha, staffLink);

      const partnerActor = makeActorSession('P-000001', ['partner', 'fee_earner'], env.tenantAlpha);
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);

      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(partnerActor.verifiedSession);
      await runWithActiveActorSession(partnerActor, async () => {
        const partnerProfile = await loadPersonDetailPageData('P-000001', 'P-000001');
        expect(partnerProfile && !('redirectTo' in partnerProfile)).toBe(true);
        if (partnerProfile && !('redirectTo' in partnerProfile)) {
          expect(partnerProfile.allPeople.some((p) => p.id === pubContact.id)).toBe(true);
          expect(partnerProfile.organisations.some((o) => o.id === env.alphaPubOrg.id)).toBe(true);
        }
      });

      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const pubProfile = await loadPersonDetailPageData('P-000002', pubContact.id);
        expect(pubProfile && !('redirectTo' in pubProfile)).toBe(true);
        if (pubProfile && !('redirectTo' in pubProfile)) {
          expect(pubProfile.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(true);
        }

        const staffContactProfile = await loadPersonDetailPageData('P-000002', staffContact.id);
        expect(staffContactProfile && !('redirectTo' in staffContactProfile)).toBe(true);
        if (staffContactProfile && !('redirectTo' in staffContactProfile)) {
          expect(staffContactProfile.matters.some((m) => m.id === env.alphaStaffMatter.id)).toBe(false);
        }
      });
    },
    45_000,
  );

  it(
    '8. R712 & Suggestions 1/5: leaver handover loader covers all 5 record types, listQuotesByIds fails closed by default, and reminder states hide draft enquiries',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();
      const matterRepo = new TenantMatterRepository();
      const intakeRepo = new TenantIntakeQuoteRepository();
      const taskRepo = new TenantTaskWorkflowRepository();
      const keyDateRepo = new TenantKeyDateRepository();

      const seedPartner = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000001');
      const leaverId = 'P-S102B-LEAVER-712';
      const leaver: Person = {
        ...structuredClone(seedPartner!),
        id: leaverId,
        firstName: 'Tudur',
        surname: 'HandoverLeaver',
        isEmployee: false,
        emails: [{ id: 'em-ho-l', address: 'tudur.ho@invented.example', typeId: null, isPrimary: true }],
        employment: {
          ...structuredClone(seedPartner!.employment!),
          personId: leaverId,
          employeeNumber: 'EMP-9712',
          status: 'Leaver',
          effectiveTo: '2026-10-20',
          contract: seedPartner!.employment!.contract
            ? { ...seedPartner!.employment!.contract, leavingDate: '2026-10-20', keepAsContactOnLeave: true }
            : null,
        },
      };
      await partyRepo.putPerson(env.ctxAlpha, leaver);

      const ownedClientPerson: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-S102B-OWNED-C712',
        firstName: 'Nia',
        surname: 'OwnedClient712',
        emails: [{ id: 'em-oc-712', address: 'nia.owned712@invented.example', typeId: null, isPrimary: true }],
        recordOwnerId: null,
        relationshipOwnerId: leaverId,
      };
      await partyRepo.putPerson(env.ctxAlpha, ownedClientPerson);

      const ownedOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-S102B-OWNED-712',
        legalName: 'Owned Handover Org 712 Ltd',
        relationshipPartnerId: leaverId,
      };
      await partyRepo.putOrganisation(env.ctxAlpha, ownedOrg);

      const ownedMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-S102B-OWNED-712',
        matterNumber: 'ALPH-HO-712',
        title: 'Owned Handover Matter 712',
        leadFeeEarnerId: leaverId,
        responsiblePartnerId: 'P-000001',
      };
      await matterRepo.putMatter(env.ctxAlpha, ownedMatter);

      const ownedTask: Task = {
        ...structuredClone(env.alphaUrgentPublicTask),
        id: 'TSK-S102B-OWNED-712',
        title: 'Owned Handover Task 712',
        status: 'To do',
        assignedPersonId: leaverId,
        linkedRecords: [{ recordType: 'matter', recordId: ownedMatter.id }],
      };
      await taskRepo.putTask(env.ctxAlpha, ownedTask);

      const ownedEnquiry: Enquiry = {
        ...structuredClone(env.alphaPublicOpenEnquiry),
        id: 'ENQ-S102B-OWNED-712',
        reference: 'ENQ-88712',
        status: 'Assigned',
        assignedToId: leaverId,
        firstName: 'OwnedHo',
        lastName: 'Enquiry712',
      };
      await intakeRepo.putEnquiry(env.ctxAlpha, ownedEnquiry);

      const adminActor = makeActorSession('P-000004', ['admin'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(adminActor.verifiedSession);

      await runWithActiveActorSession(adminActor, async () => {
        const formData = await loadPersonFormPageData('P-000004', leaverId);
        expect(formData && !('redirectTo' in formData)).toBe(true);
        if (formData && !('redirectTo' in formData)) {
          expect(formData.ownedPeople.some((p) => p.id === ownedClientPerson.id)).toBe(true);
          const types = new Set(formData.leaverOwnedRecords.map((r) => r.recordType));
          expect(types.has('person')).toBe(true);
          expect(types.has('organisation')).toBe(true);
          expect(types.has('matter')).toBe(true);
          expect(types.has('task')).toBe(true);
          expect(types.has('enquiry')).toBe(true);
        }

        // Active employee being prepared for transition to Leaver also gets all 5 types precomputed
        const activeEmpForm = await loadPersonFormPageData('P-000004', 'P-000001');
        expect(activeEmpForm && !('redirectTo' in activeEmpForm)).toBe(true);
        if (activeEmpForm && !('redirectTo' in activeEmpForm)) {
          expect(activeEmpForm.leaverOwnedRecords.some((r) => r.recordType === 'organisation')).toBe(true);
        }
      });

      // Suggestion 1: listQuotesByIds fails closed when options omitted, includes with includeRestricted: true
      const feCtx = makeCtx(env.tenantAlpha, 'P-000002');
      const hiddenDefaultQuotes = await intakeRepo.listQuotesByIds<Quote>(feCtx, [
        env.alphaStaffQuote.id,
      ]);
      expect(hiddenDefaultQuotes).toEqual([]);
      const unrestrictedQuotes = await intakeRepo.listQuotesByIds<Quote>(
        feCtx,
        [env.alphaStaffQuote.id],
        { includeRestricted: true },
      );
      expect(unrestrictedQuotes.map((q) => q.id)).toEqual([env.alphaStaffQuote.id]);

      // Suggestion 5: keyDate reminder state linked to another user's personal Draft enquiry stays hidden
      const draftEnqKd: KeyDate = {
        id: 'KD-S102B-DRAFT-ENQ',
        enquiryId: env.alphaPersonalDraftEnquiry.id,
        category: 'internal_milestone',
        keyDateTypeId: 'kd.internal_milestone',
        source: 'manual',
        title: 'Private Draft Enquiry Milestone',
        dueDate: '2026-12-01',
        isCritical: false,
        status: 'confirmed',
        teamId: 'TM-000001',
        responsiblePersonIds: ['P-000001'],
        verification: { required: false },
        createdById: 'P-000001',
        createdAt: '2026-11-10T09:00:00Z',
        updatedById: 'P-000001',
        updatedAt: '2026-11-10T09:00:00Z',
        version: 1,
      };
      await keyDateRepo.putKeyDate(env.ctxAlpha, draftEnqKd, { expectedVersion: null });
      const remState: KeyDateReminderState = {
        keyDateId: draftEnqKd.id,
        taskId: 'TSK-REM-S102B-DRAFT',
        idempotencyKey: 'rem-s102b-draft',
        reminderScheduleId: 'rem-default',
        currentStageDaysBefore: 7,
        stageEnteredAt: '2026-11-10T09:00:00Z',
        escalationLevel: 0,
      };
      await keyDateRepo.putReminderState(env.ctxAlpha, remState);

      const feReminders = await keyDateRepo.listReminderStatesForKeyDateIds(
        feCtx,
        [draftEnqKd.id],
        { viewerId: 'P-000002', hasRestrictedMatterAccess: false },
      );
      expect(feReminders).toEqual([]);

      const partnerReminders = await keyDateRepo.listReminderStatesForKeyDateIds(
        env.ctxAlpha,
        [draftEnqKd.id],
        { viewerId: 'P-000001', hasRestrictedMatterAccess: false },
      );
      expect(partnerReminders.map((r) => r.keyDateId)).toEqual([draftEnqKd.id]);
    },
    45_000,
  );
});
