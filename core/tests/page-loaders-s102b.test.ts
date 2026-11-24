import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantCatalogueRepository,
  TenantIntakeQuoteRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPartyRepository,
  TenantPmsRepository,
  TenantRegisterRepository,
  TenantTaskWorkflowRepository,
  type KeyDate,
  type KeyDateReminderState,
  type TenantContext,
} from '@platform/core';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { LoginScreen } from '@/components/LoginScreen';
import DocsLayout from '@/app/docs/layout';
import DocArticlePage from '@/app/docs/[slug]/page';
import LoginPage from '@/app/login/page';
import { ACTION_PERMISSIONS } from '@/server/actionPermissions';
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
import { isActionDenied } from '@/domain/actionResult';
import {
  getEntityRecordForEditRecord,
  getExpiredEnquiriesCountRecord,
  listClientPriorMattersRecord,
  loadPmsLinksAdminDataRecord,
  previewIntakeDuplicatesAndConflictsRecord,
  resetConflictPreviewRateLimiterForTests,
  runMatterConflictSearchRecord,
  saveEnquiryRecord,
  saveOrganisationRecord,
  savePersonRecord,
  searchEntityPickerRecord,
} from '@/server/services';
import { getPlatformTelemetryRecorder } from '@/server/telemetry';
import {
  loadAdminPageData,
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
  loadQuoteFormPageData,
  loadRegistersPageData,
  loadShellContext,
  loadTaskDetailPageData,
  loadTaskFormPageData,
  loadTasksListPageData,
  MAX_LIST_PAGE_NUMBER,
  MAX_LIST_QUERY_LENGTH,
  parseListPageParam,
  parseListPageSizeParam,
  withOptionalPageActor,
} from '@/server/pageLoaders';
import { isReadyForRetentionAnonymisation } from '@/domain/enquiries';
import { computeMatterPartyUsageCounts } from '@/domain/matterParties';
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

  it('1. /docs route group isolation & R706/R716 auth redirects: Help pages stay DB-free, DocsLayout rejects unmapped/leaver sessions, and expired sessions redirect to /login', async () => {
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
        expect(spec).not.toMatch(/tenancy\//);
        expect(spec).not.toMatch(/@platform\/core/);
        if (
          (relPath === 'src/app/docs/layout.tsx' ||
            relPath === 'src/app/docs/[slug]/page.tsx') &&
          /services/.test(spec)
        ) {
          expect(spec).toBe('@/server/services');
        } else {
          expect(spec).not.toMatch(/services/);
        }
      }
    }

    // Signed-out DocsLayout and DocArticlePage return LoginScreen with zero PostgreSQL pool/query calls
    const env = await provisionAndSeedTwoTenants();
    setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
    setTestEntraSessionOverride(null);
    const poolSpy = vi.spyOn(getGlobalTenantPostgresPoolManager(), 'getPoolForTenant');
    try {
      const signedOutEl = await DocsLayout({
        children: React.createElement('div', null, 'Protected Help Content'),
      });
      expect((signedOutEl as React.ReactElement).type).toBe(LoginScreen);

      const signedOutSlugEl = await DocArticlePage({
        params: Promise.resolve({ slug: 'matter-opening-and-risk' }),
      });
      expect((signedOutSlugEl as React.ReactElement).type).toBe(LoginScreen);
      expect((signedOutSlugEl as React.ReactElement<{ initialReturnTo?: string }>).props.initialReturnTo).toBe(
        '/docs/matter-opening-and-risk',
      );
      expect(poolSpy).not.toHaveBeenCalled();
    } finally {
      poolSpy.mockRestore();
    }

    // R706: Unmapped session and leaver session (isEmployee: false) cannot load /docs children
    const unmappedSession = makeActorSession('P-UNMAPPED-999', [], env.tenantAlpha);
    setTestEntraSessionOverride(unmappedSession.verifiedSession);
    const unmappedEl = await runWithActiveActorSession(unmappedSession, () =>
      DocsLayout({
        children: React.createElement('div', null, 'Protected Help Content'),
      }),
    );
    const unmappedHtml = renderToStaticMarkup(unmappedEl as React.ReactElement);
    expect(unmappedHtml).toContain('Access unavailable');
    expect(unmappedHtml).toContain('/api/auth/logout');
    expect(unmappedHtml).not.toContain('Protected Help Content');

    // Seed a leaver (isEmployee: false) in Alpha and prove DocsLayout + /docs/[slug] block them too
    const partyRepo = new TenantPartyRepository();
    const leaverPerson: Person = {
      ...structuredClone(env.alphaRestrictedPerson),
      id: 'P-S102B-LEAVER',
      firstName: 'Former',
      surname: 'Employee',
      isEmployee: false,
      mergedIntoId: null,
    };
    await partyRepo.putPerson(env.ctxAlpha, leaverPerson);
    const leaverSession = makeActorSession(leaverPerson.id, [], env.tenantAlpha);
    setTestEntraSessionOverride(leaverSession.verifiedSession);
    const [leaverEl, leaverSlugEl] = await runWithActiveActorSession(leaverSession, () =>
      Promise.all([
        DocsLayout({
          children: React.createElement('div', null, 'Protected Help Content'),
        }),
        DocArticlePage({
          params: Promise.resolve({ slug: 'matter-opening-and-risk' }),
        }),
      ]),
    );
    const leaverHtml = renderToStaticMarkup(leaverEl as React.ReactElement);
    expect(leaverHtml).toContain('Access unavailable');
    expect(leaverHtml).not.toContain('Protected Help Content');
    const leaverSlugHtml = renderToStaticMarkup(leaverSlugEl as React.ReactElement);
    expect(leaverSlugHtml).toContain('Access unavailable');
    expect(leaverSlugHtml).not.toContain('Matter opening wizard');

    // Positive control: active employee renders /docs children and /docs/[slug]
    const activeSession = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
    setTestEntraSessionOverride(activeSession.verifiedSession);
    const [activeEl, activeSlugEl] = await runWithActiveActorSession(activeSession, () =>
      Promise.all([
        DocsLayout({
          children: React.createElement('div', null, 'Protected Help Content'),
        }),
        DocArticlePage({
          params: Promise.resolve({ slug: 'matter-opening-and-risk' }),
        }),
      ]),
    );
    const activeHtml = renderToStaticMarkup(activeEl as React.ReactElement);
    expect(activeHtml).toContain('Protected Help Content');
    expect(activeHtml).not.toContain('Access unavailable');
    const activeSlugHtml = renderToStaticMarkup(activeSlugEl as React.ReactElement);
    expect(activeSlugHtml).toContain('Matter opening wizard');
    expect(activeSlugHtml).not.toContain('Access unavailable');

    // R716 & Suggestion 9: withOptionalPageActor redirects expired/missing sessions to /login with validated returnTo; LoginPage preserves safe returnTo and rejects external redirects
    setTestEntraSessionOverride(null);
    let redirectDigest = '';
    try {
      await withOptionalPageActor(async () => 'never-reached', '/matters/M-000001?tab=costs');
    } catch (err) {
      redirectDigest = String((err as { digest?: unknown })?.digest ?? '');
    }
    expect(redirectDigest).toContain('NEXT_REDIRECT');
    expect(redirectDigest).toContain('/login?returnTo=%2Fmatters%2FM-000001%3Ftab%3Dcosts');

    const loginSignedOutEl = await LoginPage({
      searchParams: Promise.resolve({ returnTo: '/matters/M-000001' }),
    });
    expect((loginSignedOutEl as React.ReactElement).type).toBe(LoginScreen);
    expect((loginSignedOutEl as React.ReactElement<{ initialReturnTo?: string }>).props.initialReturnTo).toBe(
      '/matters/M-000001',
    );

    setTestEntraSessionOverride(activeSession.verifiedSession);
    let loginRedirectDigest = '';
    try {
      await LoginPage();
    } catch (err) {
      loginRedirectDigest = String((err as { digest?: unknown })?.digest ?? '');
    }
    expect(loginRedirectDigest).toContain('NEXT_REDIRECT');
    expect(loginRedirectDigest).toContain(';/;');

    let safeReturnRedirectDigest = '';
    try {
      await LoginPage({ searchParams: Promise.resolve({ returnTo: '/matters/M-000001' }) });
    } catch (err) {
      safeReturnRedirectDigest = String((err as { digest?: unknown })?.digest ?? '');
    }
    expect(safeReturnRedirectDigest).toContain('NEXT_REDIRECT');
    expect(safeReturnRedirectDigest).toContain(';/matters/M-000001;');

    let blockedReturnRedirectDigest = '';
    try {
      await LoginPage({ searchParams: Promise.resolve({ returnTo: '//evil.com' }) });
    } catch (err) {
      blockedReturnRedirectDigest = String((err as { digest?: unknown })?.digest ?? '');
    }
    expect(blockedReturnRedirectDigest).toContain('NEXT_REDIRECT');
    expect(blockedReturnRedirectDigest).toContain(';/;');

    // R730: dot-segment payloads resolving to scheme-relative //evil.com must fall back to '/'
    let dotSegmentRedirectDigest = '';
    try {
      await LoginPage({ searchParams: Promise.resolve({ returnTo: '/.//evil.com' }) });
    } catch (err) {
      dotSegmentRedirectDigest = String((err as { digest?: unknown })?.digest ?? '');
    }
    expect(dotSegmentRedirectDigest).toContain('NEXT_REDIRECT');
    expect(dotSegmentRedirectDigest).toContain(';/;');
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

        // R708: Exact urgent badge count via countUrgentBadgeTasksForUser, excluding hidden staff urgent task
        const taskRepo = new TenantTaskWorkflowRepository();
        const visibleTasksForFe = await taskRepo.listVisibleTasks<Task>(env.ctxAlpha, 'P-000002', {
          hasRestrictedMatterAccess: false,
        });
        expect(visibleTasksForFe.some((t) => t.id === env.alphaUrgentPublicTask.id)).toBe(true);
        expect(visibleTasksForFe.some((t) => t.id === env.alphaUrgentStaffTask.id)).toBe(false);

        const todayIso = new Date().toISOString().slice(0, 10);
        const [feExpectedBadge, feUnrestrictedBadge, partnerExpectedBadge] = await Promise.all([
          taskRepo.countUrgentBadgeTasksForUser(env.ctxAlpha, 'P-000002', {
            viewerId: 'P-000002',
            hasRestrictedMatterAccess: false,
            todayIso,
          }),
          taskRepo.countUrgentBadgeTasksForUser(env.ctxAlpha, 'P-000002', {
            viewerId: 'P-000002',
            hasRestrictedMatterAccess: true,
            todayIso,
          }),
          taskRepo.countUrgentBadgeTasksForUser(env.ctxAlpha, 'P-000001', {
            viewerId: 'P-000001',
            hasRestrictedMatterAccess: true,
            todayIso,
          }),
        ]);
        expect(shell.urgentTaskBadgeCount).toBe(feExpectedBadge);
        expect(feUnrestrictedBadge).toBe(feExpectedBadge + 1);

        // Seed public + staff-matter key dates so key-dates isolation has both negative and positive controls (R708)
        const keyDateRepo = new TenantKeyDateRepository();
        const publicKd: KeyDate = {
          id: 'KD-S102B-PUB-A',
          matterId: env.alphaPubMatter.id,
          category: 'internal_milestone',
          keyDateTypeId: 'kd.internal_milestone',
          source: 'manual',
          title: 'Public Matter Alpha Key Date',
          dueDate: '2026-12-01',
          isCritical: false,
          status: 'confirmed',
          teamId: 'TM-000001',
          responsiblePersonIds: ['P-000001', 'P-000002'],
          verification: { required: false },
          createdById: 'P-000001',
          createdAt: '2026-11-10T09:00:00Z',
          updatedById: 'P-000001',
          updatedAt: '2026-11-10T09:00:00Z',
          version: 1,
        };
        const staffKd: KeyDate = {
          ...publicKd,
          id: 'KD-S102B-STAFF-A',
          matterId: env.alphaStaffMatter.id,
          title: 'Staff Matter Hidden Key Date',
        };
        await keyDateRepo.putKeyDate(env.ctxAlpha, publicKd, { expectedVersion: null });
        await keyDateRepo.putKeyDate(env.ctxAlpha, staffKd, { expectedVersion: null });

        // R726: Seed a public undertaking register record in Alpha so /registers and Home register panels have positive controls
        const regRepo = new TenantRegisterRepository();
        await regRepo.createRegisterRecord(env.ctxAlpha, {
          id: 'REG-S102B-PUB-1',
          registerTypeKey: 'undertaking',
          reference: 'UND-S102B-1',
          title: 'R726 Alpha Public Undertaking',
          status: 'open',
          matterId: env.alphaPubMatter.id,
          createdById: 'P-000001',
          ownerId: 'P-000001',
          fieldValues: {
            undertakingTerms: 'Hold completion funds to order',
            giverPersonId: 'P-000001',
          },
        });

        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(alphaPartner.verifiedSession);
        const [partnerShell, partnerKeyDates, partnerRegisters] = await runWithActiveActorSession(
          alphaPartner,
          () =>
            Promise.all([
              loadShellContext('P-000001'),
              loadKeyDatesPageData('P-000001'),
              loadRegistersPageData('P-000001'),
            ]),
        );
        expect(partnerShell.urgentTaskBadgeCount).toBe(partnerExpectedBadge);
        expect(
          partnerKeyDates.initialDiaryEntries.some((d) => d.matterId === env.alphaStaffMatter.id),
        ).toBe(true);
        expect(
          partnerKeyDates.initialDiaryEntries.some((d) => d.matterId === env.alphaPubMatter.id),
        ).toBe(true);
        expect(partnerRegisters.data).toMatchObject({ ok: true });
        expect(
          (partnerRegisters.data as { records: Array<{ id: string }> }).records.some(
            (r) => r.id === 'REG-S102B-PUB-1',
          ),
        ).toBe(true);

        // Positive control for Home registerRecords (risk_compliance renders Home register panels, R726)
        const riskActor = makeActorSession(
          'P-000003',
          ['risk_compliance', 'fee_earner', 'partner'],
          env.tenantAlpha,
        );
        setTestEntraSessionOverride(riskActor.verifiedSession);
        const riskHome = await runWithActiveActorSession(riskActor, () =>
          loadHomePageData('P-000003'),
        );
        expect(riskHome.registerTypes.length).toBeGreaterThan(0);
        expect(
          riskHome.registerRecords.some((r) => r.id === 'REG-S102B-PUB-1'),
        ).toBe(true);

        // User without register:view or undertaking:manage is refused on /registers and gets empty registers on Home (R708)
        const regPartyRepo = new TenantPartyRepository();
        const baseFinanceUser = (await regPartyRepo.getPersonById<Person>(
          env.ctxAlpha,
          'P-000009',
        ))!;
        await regPartyRepo.putPerson(env.ctxAlpha, {
          ...structuredClone(baseFinanceUser),
          id: 'P-S102B-NO-REG',
          roles: ['finance'],
          permissionOverrides: {
            grant: [],
            revoke: ['register:view', 'undertaking:manage'],
          },
        });
        const noRegActor = makeActorSession('P-S102B-NO-REG', [], env.tenantAlpha);
        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(noRegActor.verifiedSession);
        const [noRegRegisters, noRegHome] = await runWithActiveActorSession(noRegActor, () =>
          Promise.all([
            loadRegistersPageData('P-S102B-NO-REG'),
            loadHomePageData('P-S102B-NO-REG'),
          ]),
        );
        expect(noRegRegisters.shell.currentUserPermissions).not.toContain('register:view');
        expect(noRegRegisters.data).toMatchObject({ ok: false, code: 'FORBIDDEN' });
        expect(noRegHome.registerRecords).toEqual([]);
        expect(noRegHome.registerTypes).toEqual([]);

        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(alphaFeeEarner.verifiedSession);
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
        expect(
          keyDatesData.initialDiaryEntries.some((d) => d.matterId === env.alphaPubMatter.id),
        ).toBe(true);

        const registersData = await loadRegistersPageData('P-000002');
        expect(registersData.data).toMatchObject({ ok: true });
        expect(
          (registersData.data as { records: Array<{ id: string }> }).records.some(
            (r) => r.id === 'REG-S102B-PUB-1',
          ),
        ).toBe(true);
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
    '3. Detail/edit loaders: uniform null & positive controls for [id] routes, tampered query-string IDs, and forged claim rejection on list/detail loaders',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const intakeRepo = new TenantIntakeQuoteRepository();
      const alphaPublicQuote: Quote = {
        ...structuredClone(env.alphaStaffQuote),
        id: 'QUO-S102B-PUB-A',
        reference: 'QUO-88002',
        prospectName: 'Public Alpha Quote Prospect',
        convertedMatterId: null,
        linkedEnquiryId: env.alphaPublicOpenEnquiry.id,
        feeEarnerId: 'P-000002',
      };
      await intakeRepo.putQuote(env.ctxAlpha, alphaPublicQuote);

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

      // 3a. Hidden Alpha records return identical `null` as non-existent IDs; positive controls return real records; tampered query-string IDs stay isolated (R708)
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

        // Positive controls for every [id] detail/edit loader
        const pubMatterDetail = await loadMatterDetailPageData('P-000002', env.alphaPubMatter.id);
        expect(pubMatterDetail?.matter.id).toBe(env.alphaPubMatter.id);
        const pubMatterEdit = await loadMatterFormPageData('P-000002', {
          editId: env.alphaPubMatter.id,
        });
        expect(pubMatterEdit?.existing?.id).toBe(env.alphaPubMatter.id);

        const pubPersonDetail = await loadPersonDetailPageData('P-000002', 'P-000002');
        expect(pubPersonDetail && !('redirectTo' in pubPersonDetail)).toBe(true);
        if (pubPersonDetail && !('redirectTo' in pubPersonDetail)) {
          expect(pubPersonDetail.person.id).toBe('P-000002');
        }
        const pubPersonEdit = await loadPersonFormPageData('P-000002', 'P-000002');
        expect(pubPersonEdit && !('redirectTo' in pubPersonEdit)).toBe(true);
        if (pubPersonEdit && !('redirectTo' in pubPersonEdit)) {
          expect(pubPersonEdit.existing?.id).toBe('P-000002');
        }

        const pubOrgDetail = await loadOrganisationDetailPageData('P-000002', env.alphaPubOrg.id);
        expect(pubOrgDetail && !('redirectTo' in pubOrgDetail)).toBe(true);
        if (pubOrgDetail && !('redirectTo' in pubOrgDetail)) {
          expect(pubOrgDetail.organisation.id).toBe(env.alphaPubOrg.id);
        }
        const pubOrgEdit = await loadOrganisationFormPageData('P-000002', env.alphaPubOrg.id);
        expect(pubOrgEdit && !('redirectTo' in pubOrgEdit)).toBe(true);
        if (pubOrgEdit && !('redirectTo' in pubOrgEdit)) {
          expect(pubOrgEdit.existing?.id).toBe(env.alphaPubOrg.id);
        }

        const pubEnqDetail = await loadEnquiryDetailPageData('P-000002', env.alphaPublicOpenEnquiry.id);
        expect(pubEnqDetail?.enquiry.id).toBe(env.alphaPublicOpenEnquiry.id);
        const pubQuoteDetail = await loadQuoteDetailPageData('P-000002', alphaPublicQuote.id);
        expect(pubQuoteDetail?.quote.id).toBe(alphaPublicQuote.id);
        const pubTaskDetail = await loadTaskDetailPageData('P-000002', env.alphaUrgentPublicTask.id);
        expect(pubTaskDetail?.task.id).toBe(env.alphaUrgentPublicTask.id);

        // Tampered query-string IDs on form loaders (hidden Alpha + cross-tenant Bravo) + positive controls
        expect(
          (await loadMatterFormPageData('P-000002', { enquiryId: env.alphaPersonalDraftEnquiry.id }))
            ?.initialEnquiry,
        ).toBeNull();
        expect(
          (await loadMatterFormPageData('P-000002', { enquiryId: env.bravoEnquiry.id }))
            ?.initialEnquiry,
        ).toBeNull();
        expect(
          (await loadMatterFormPageData('P-000002', { enquiryId: env.alphaPublicOpenEnquiry.id }))
            ?.initialEnquiry?.id,
        ).toBe(env.alphaPublicOpenEnquiry.id);

        expect(
          (await loadMatterFormPageData('P-000002', { quoteId: env.alphaStaffQuote.id }))
            ?.initialQuote,
        ).toBeNull();
        expect(
          (await loadMatterFormPageData('P-000002', { quoteId: env.bravoQuote.id }))
            ?.initialQuote,
        ).toBeNull();
        expect(
          (await loadMatterFormPageData('P-000002', { quoteId: alphaPublicQuote.id }))
            ?.initialQuote?.id,
        ).toBe(alphaPublicQuote.id);

        expect(
          (await loadMatterFormPageData('P-000002', { draftId: env.alphaStaffMatter.id }))
            ?.existing,
        ).toBeNull();
        expect(
          (await loadMatterFormPageData('P-000002', { draftId: env.bravoMatter.id }))
            ?.existing,
        ).toBeNull();

        const tamperedBravoClientForm = await loadMatterFormPageData('P-000002', {
          clientId: env.bravoOrg.id,
        });
        expect(
          tamperedBravoClientForm?.organisations.some((o) => o.id === env.bravoOrg.id),
        ).toBe(false);
        const tamperedBravoPersonForm = await loadMatterFormPageData('P-000002', {
          clientId: env.bravoPerson.id,
        });
        expect(
          tamperedBravoPersonForm?.people.some((p) => p.id === env.bravoPerson.id),
        ).toBe(false);

        expect(
          (await loadQuoteFormPageData('P-000002', env.alphaPersonalDraftEnquiry.id))
            ?.initialEnquiry,
        ).toBeNull();
        expect(
          (await loadQuoteFormPageData('P-000002', env.bravoEnquiry.id))
            ?.initialEnquiry,
        ).toBeNull();
        expect(
          (await loadQuoteFormPageData('P-000002', env.alphaPublicOpenEnquiry.id))
            ?.initialEnquiry?.id,
        ).toBe(env.alphaPublicOpenEnquiry.id);

        const taskFormStaff = await loadTaskFormPageData('P-000002', {
          recordType: 'matter',
          recordId: env.alphaStaffMatter.id,
        });
        expect(taskFormStaff.matters.some((m) => m.id === env.alphaStaffMatter.id)).toBe(false);
        const taskFormBravo = await loadTaskFormPageData('P-000002', {
          recordType: 'matter',
          recordId: env.bravoMatter.id,
        });
        expect(taskFormBravo.matters.some((m) => m.id === env.bravoMatter.id)).toBe(false);
        const taskFormPub = await loadTaskFormPageData('P-000002', {
          recordType: 'matter',
          recordId: env.alphaPubMatter.id,
        });
        expect(taskFormPub.matters.some((m) => m.id === env.alphaPubMatter.id)).toBe(true);
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

      // 3c. Forged tenant claim (session claims tenantBravo while active tenant is tenantAlpha) fails closed across all loaders
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(forgedBravoInAlphaSession.verifiedSession);
      await runWithActiveActorSession(forgedBravoInAlphaSession, async () => {
        await expect(loadShellContext('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadHomePageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadPeopleListPageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadOrganisationsListPageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadMattersListPageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadEnquiriesListPageData('P-000001')).rejects.toThrow(
          /TENANCY_FORGERY_DETECTED/,
        );
        await expect(loadTasksListPageData('P-000001')).rejects.toThrow(
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
        if (isActionDenied(preview)) throw new Error(preview.error);

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

        // Picker visibility & privacy + positive controls for P-000002 (R708):
        const alphaPublicQuoteInTest4: Quote = {
          ...structuredClone(env.alphaStaffQuote),
          id: 'QUO-S102B-PUB-PICKER',
          reference: 'QUO-88003',
          prospectName: 'Public Alpha Quote Picker',
          convertedMatterId: null,
          linkedEnquiryId: env.alphaPublicOpenEnquiry.id,
          feeEarnerId: 'P-000002',
        };
        await new TenantIntakeQuoteRepository().putQuote(
          env.ctxAlpha,
          alphaPublicQuoteInTest4,
        );

        const hiddenMatterPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'Confidential Staff Employment Matter Alpha' },
          'P-000002',
        );
        if (isActionDenied(hiddenMatterPicker)) throw new Error(hiddenMatterPicker.error);
        expect(hiddenMatterPicker.items).toEqual([]);
        const visibleMatterPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: env.alphaPubMatter.matterNumber },
          'P-000002',
        );
        if (isActionDenied(visibleMatterPicker)) throw new Error(visibleMatterPicker.error);
        expect(visibleMatterPicker.items.some((i) => i.id === env.alphaPubMatter.id)).toBe(true);

        const hiddenDraftPicker = await searchEntityPickerRecord(
          { entityTypes: ['enquiry'], query: 'PrivateDraft' },
          'P-000002',
        );
        if (isActionDenied(hiddenDraftPicker)) throw new Error(hiddenDraftPicker.error);
        expect(hiddenDraftPicker.items).toEqual([]);
        const visibleEnquiryPicker = await searchEntityPickerRecord(
          { entityTypes: ['enquiry'], query: 'PublicOpen' },
          'P-000002',
        );
        if (isActionDenied(visibleEnquiryPicker)) throw new Error(visibleEnquiryPicker.error);
        expect(
          visibleEnquiryPicker.items.some((i) => i.id === env.alphaPublicOpenEnquiry.id),
        ).toBe(true);

        const hiddenQuotePicker = await searchEntityPickerRecord(
          { entityTypes: ['quote'], query: 'Hidden Staff Matter Quote' },
          'P-000002',
        );
        if (isActionDenied(hiddenQuotePicker)) throw new Error(hiddenQuotePicker.error);
        expect(hiddenQuotePicker.items).toEqual([]);
        const visibleQuotePicker = await searchEntityPickerRecord(
          { entityTypes: ['quote'], query: 'Public Alpha Quote Picker' },
          'P-000002',
        );
        if (isActionDenied(visibleQuotePicker)) throw new Error(visibleQuotePicker.error);
        expect(
          visibleQuotePicker.items.some((i) => i.id === alphaPublicQuoteInTest4.id),
        ).toBe(true);

        const bravoCrossTenantPicker = await searchEntityPickerRecord(
          {
            entityTypes: ['person', 'organisation', 'matter', 'enquiry', 'quote'],
            query: 'BravoExclusive',
          },
          'P-000002',
        );
        if (isActionDenied(bravoCrossTenantPicker)) throw new Error(bravoCrossTenantPicker.error);
        expect(bravoCrossTenantPicker.items).toEqual([]);

        const personPicker = await searchEntityPickerRecord(
          { entityTypes: ['person'], query: 'Rhian' },
          'P-000002',
        );
        if (isActionDenied(personPicker)) throw new Error(personPicker.error);
        expect(personPicker.items.length).toBeGreaterThan(0);
        for (const item of personPicker.items) {
          expect((item.person as { employment?: unknown } | undefined)?.employment).toBeUndefined();
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
        if (isActionDenied(partnerPreview)) throw new Error(partnerPreview.error);
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
        if (isActionDenied(mergedNumPicker)) throw new Error(mergedNumPicker.error);
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
        if (isActionDenied(shortDescPicker)) throw new Error(shortDescPicker.error);
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
        entraObjectId: '00000000-0000-4000-8000-000000009718',
        permissionOverrides: {
          grant: ['matter:edit'],
          revoke: [],
          reason: 'R718 sensitive override test fixture',
        },
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

      // 6a. HR / Admin actor sees leaver employment across list, profile, and edit loaders (payroll, overrides & Entra OID stripped)
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(adminActor.verifiedSession);
      await runWithActiveActorSession(adminActor, async () => {
        const peopleList = await loadPeopleListPageData('P-000004');
        const listLeaver = peopleList.people.find((p) => p.id === leaverPerson.id);
        expect(listLeaver?.employment?.status).toBe('Leaver');
        expect(listLeaver?.employment?.payroll).toBeUndefined();
        expect(listLeaver?.permissionOverrides).toBeUndefined();
        expect(listLeaver?.entraObjectId).toBeUndefined();

        const detail = await loadPersonDetailPageData('P-000004', leaverPerson.id);
        expect(detail && !('redirectTo' in detail)).toBe(true);
        if (detail && !('redirectTo' in detail)) {
          expect(detail.person.employment?.status).toBe('Leaver');
          expect(detail.person.employment?.contract?.leavingDate).toBe('2026-10-15');
          expect(detail.person.dateOfBirth).toBe('1984-04-12');
          expect(detail.person.permissionOverrides).toBeUndefined();
          expect(detail.person.entraObjectId).toBeUndefined();
        }

        const edit = await loadPersonFormPageData('P-000004', leaverPerson.id);
        expect(edit && !('redirectTo' in edit)).toBe(true);
        if (edit && !('redirectTo' in edit)) {
          expect(edit.existing?.employment?.status).toBe('Leaver');
          expect(edit.existing?.dateOfBirth).toBe('1984-04-12');
          expect(edit.existing?.permissionOverrides).toBeUndefined();
          expect(edit.existing?.entraObjectId).toBeUndefined();
        }
      });

      // 6b. Standard Fee Earner (has employee:view_core, lacks employee:hr_restricted/payroll):
      // sees core status 'Leaver' with DOB, restricted HR, payroll, overrides & Entra OID stripped, and contact-only edit keeps stored employment
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
          expect(feDetail.person.dateOfBirth).toBeUndefined();
          expect(feDetail.person.permissionOverrides).toBeUndefined();
          expect(feDetail.person.entraObjectId).toBeUndefined();
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

      // 6c. Actor without employee:view_core sees employment: null, leaverOwnedRecords: [],
      // and NO dateOfBirth, permissionOverrides, or entraObjectId;
      // saving a contact edit (even with a non-null dateOfBirth, R728) still preserves stored employment & DOB intact
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
          expect(limitedDetail.person.dateOfBirth).toBeUndefined();
          expect(limitedDetail.person.permissionOverrides).toBeUndefined();
          expect(limitedDetail.person.entraObjectId).toBeUndefined();
        }

        const limitedEdit = await loadPersonFormPageData('P-000002', leaverPerson.id);
        expect(limitedEdit && !('redirectTo' in limitedEdit)).toBe(true);
        if (limitedEdit && !('redirectTo' in limitedEdit)) {
          expect(limitedEdit.existing?.employment).toBeNull();
          expect(limitedEdit.existing?.dateOfBirth).toBeUndefined();
          expect(limitedEdit.existing?.permissionOverrides).toBeUndefined();
          expect(limitedEdit.existing?.entraObjectId).toBeUndefined();
          expect(limitedEdit.leaverOwnedRecords).toEqual([]);
        }

        const limitedSave = await savePersonRecord(
          {
            firstName: 'Huw',
            surname: 'LeaverTest',
            relationshipNotes: 'Updated limited contact note',
            dateOfBirth: '1999-01-01',
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

  it(
    '9. R697: Home finance panels load from configured panels/cards for admin, support, and custom roles while summary-only roles stay summary-only',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const cfgAlpha = getActiveTenantConfiguration();
      const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
      await importFirmStoreModulesToPostgres({
        ctx: env.ctxAlpha,
        tenantConfig: cfgAlpha,
        store: structuredClone(seed),
        modules: ['pms'],
        clearFirst: false,
      });

      const partyRepo = new TenantPartyRepository();
      const catRepo = new TenantCatalogueRepository();

      // Grant support persona P-000010 (legal_secretary) matter finance viewing permission as a client firm might
      const supportPerson = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000010');
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(supportPerson!),
        permissionOverrides: {
          grant: ['finance:view_matter'],
          revoke: [],
        },
      });

      // Add a custom role with aged_debt_by_age_band to home_pages config
      const nextHomeConfig = structuredClone(seed.homePagesConfig);
      nextHomeConfig.roles.push({
        key: 'custom_debt_analyst',
        label: 'Custom Debt Analyst',
        shortLabel: 'Debt analyst',
        purpose: 'Monitors aged debt by band.',
        designNumber: '09',
        demoUserEmail: '',
        headlineCardIds: ['fe_open_matters'],
        primaryPanels: ['aged_debt_by_age_band'],
        summaryPanels: [],
        isBuiltIn: false,
      });
      await catRepo.putModuleConfig(
        env.ctxAlpha,
        'home_pages',
        nextHomeConfig,
        'P-000004',
      );

      const adminActor = makeActorSession(
        'P-000004',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner', 'legal_secretary', 'finance'],
        env.tenantAlpha,
      );
      const supportActor = makeActorSession('P-000010', ['legal_secretary'], env.tenantAlpha);
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);

      // 9a. Admin role sees non-empty pmsAgedDebt
      setTestEntraSessionOverride(adminActor.verifiedSession);
      await runWithActiveActorSession(adminActor, async () => {
        const adminHome = await loadHomePageData('P-000004', { previewRole: 'admin' });
        expect(adminHome.matterFinance?.pmsAgedDebt.length ?? 0).toBeGreaterThan(0);

        // 9b. Custom role configured with aged_debt_by_age_band gets non-empty pmsAgedDebt
        const customHome = await loadHomePageData('P-000004', {
          previewRole: 'custom_debt_analyst',
        });
        expect(customHome.matterFinance?.pmsAgedDebt.length ?? 0).toBeGreaterThan(0);
      });

      // 9c. Support persona (legal_secretary) sees non-empty pmsAllDisbursements for ls_unbilled_disb & disbursements_and_invoices_to_log
      setTestEntraSessionOverride(supportActor.verifiedSession);
      await runWithActiveActorSession(supportActor, async () => {
        const supportHome = await loadHomePageData('P-000010', { previewRole: 'legal_secretary' });
        expect(supportHome.matterFinance?.pmsAllDisbursements.length ?? 0).toBeGreaterThan(0);
      });

      // 9d. Role with no full-finance panels/cards (fee_earner) stays summary-only
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const feHome = await loadHomePageData('P-000002', { previewRole: 'fee_earner' });
        expect(feHome.matterFinance).toBeDefined();
        expect(feHome.matterFinance?.allMatterFins.length ?? 0).toBeGreaterThan(0);
        expect(feHome.matterFinance?.pmsAgedDebt).toEqual([]);
        expect(feHome.matterFinance?.pmsAllDisbursements).toEqual([]);
        expect(feHome.matterFinance?.pmsInvoices).toEqual([]);
      });
    },
    45_000,
  );

  it(
    '10. R698: loadMatterFormPageData returns visible prior client matters (excluding restricted & cross-tenant) for CDD pre-fill',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const matterRepo = new TenantMatterRepository();

      const verifiedPriorMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-S102B-R698-PRIOR',
        matterNumber: 'ALPH-R698-01',
        title: 'Earlier Verified Matter for Alpha Public Org',
        clientId: env.alphaPubOrg.id,
        conflictCheckStatus: 'Clear',
        amlStatus: 'Verified',
        isStaffMatter: false,
        hasEthicalWall: false,
        restrictedAccessUserIds: [],
      };
      await matterRepo.putMatter(env.ctxAlpha, verifiedPriorMatter);

      const restrictedPriorMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-S102B-R698-STAFF',
        matterNumber: 'ALPH-R698-STF',
        title: 'Hidden Restricted Prior Matter for Alpha Public Org',
        clientId: env.alphaPubOrg.id,
        conflictCheckStatus: 'Clear',
        amlStatus: 'Verified',
        isStaffMatter: true,
        hasEthicalWall: true,
        restrictedAccessUserIds: ['P-000001'],
      };
      await matterRepo.putMatter(env.ctxAlpha, restrictedPriorMatter);

      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        const formData = await loadMatterFormPageData('P-000002', {
          clientId: env.alphaPubOrg.id,
        });
        expect(formData).not.toBeNull();
        const clientMatters =
          formData && 'clientMatters' in formData
            ? ((formData as { clientMatters?: ReadonlyArray<{ id: string }> }).clientMatters ?? [])
            : [];
        expect(clientMatters.some((m) => m.id === verifiedPriorMatter.id)).toBe(true);
        expect(clientMatters.some((m) => m.id === restrictedPriorMatter.id)).toBe(false);
        expect(clientMatters.some((m) => m.id === env.bravoMatter.id)).toBe(false);
      });
    },
    45_000,
  );

  it(
    '11. R704: rejects malformed/NaN/oversized preview & picker inputs with VALIDATION_ERROR and caps candidate SQL queries',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();
      const intakeRepo = new TenantIntakeQuoteRepository();

      // Seed 4 matching people and 4 matching enquiries to test SQL LIMIT cap
      for (let i = 1; i <= 4; i++) {
        await partyRepo.putPerson(env.ctxAlpha, {
          ...structuredClone(env.alphaRestrictedPerson),
          id: `P-R704-CAP-${i}`,
          firstName: 'CapCheck',
          surname: `Alpha${i}`,
          emails: [{ id: `em-cap-${i}`, address: `capcheck${i}@alpha.test`, typeId: null, isPrimary: true }],
        });
        await intakeRepo.putEnquiry(env.ctxAlpha, {
          ...structuredClone(env.alphaPublicOpenEnquiry),
          id: `ENQ-R704-CAP-${i}`,
          reference: `ENQ-R704-CAP-${i}`,
          firstName: 'CapCheckEnq',
          lastName: `Alpha${i}`,
          status: 'New',
          assignedToId: 'P-000002',
        });
      }

      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        const badKind = await previewIntakeDuplicatesAndConflictsRecord(
          { kind: 'invalid_kind' as unknown as 'enquiry', firstName: 'Test' },
          'P-000002',
        );
        expect(isActionDenied(badKind)).toBe(true);
        if (isActionDenied(badKind)) expect(badKind.code).toBe('VALIDATION_ERROR');

        const badArrayType = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            emails: 'not-an-array' as unknown as string[],
          },
          'P-000002',
        );
        expect(isActionDenied(badArrayType)).toBe(true);
        if (isActionDenied(badArrayType)) expect(badArrayType.code).toBe('VALIDATION_ERROR');

        const tooManyEmails = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            emails: Array.from({ length: 21 }, (_, idx) => `u${idx}@alpha.test`),
          },
          'P-000002',
        );
        expect(isActionDenied(tooManyEmails)).toBe(true);
        if (isActionDenied(tooManyEmails)) expect(tooManyEmails.code).toBe('VALIDATION_ERROR');

        const tooLongString = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            firstName: 'x'.repeat(201),
          },
          'P-000002',
        );
        expect(isActionDenied(tooLongString)).toBe(true);
        if (isActionDenied(tooLongString)) expect(tooLongString.code).toBe('VALIDATION_ERROR');

        const nanLimitPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'Alpha', limit: Number.NaN },
          'P-000002',
        );
        expect(isActionDenied(nanLimitPicker)).toBe(true);
        if (isActionDenied(nanLimitPicker)) expect(nanLimitPicker.code).toBe('VALIDATION_ERROR');

        const stringLimitPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'Alpha', limit: 'x' as unknown as number },
          'P-000002',
        );
        expect(isActionDenied(stringLimitPicker)).toBe(true);
        if (isActionDenied(stringLimitPicker)) expect(stringLimitPicker.code).toBe('VALIDATION_ERROR');

        const overLimitPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: 'Alpha', limit: 51 },
          'P-000002',
        );
        expect(isActionDenied(overLimitPicker)).toBe(true);
        if (isActionDenied(overLimitPicker)) expect(overLimitPicker.code).toBe('VALIDATION_ERROR');

        const badEntityTypePicker = await searchEntityPickerRecord(
          { entityTypes: ['secret_table' as unknown as 'matter'], query: 'Alpha' },
          'P-000002',
        );
        expect(isActionDenied(badEntityTypePicker)).toBe(true);
        if (isActionDenied(badEntityTypePicker)) expect(badEntityTypePicker.code).toBe('VALIDATION_ERROR');

        // Candidate queries honor explicit SQL LIMIT cap
        const cappedPeople = await partyRepo.findSqlDuplicateCandidates<Person>(env.ctxAlpha, {
          kind: 'person',
          firstName: 'CapCheck',
          limit: 2,
        });
        expect(cappedPeople).toHaveLength(2);

        const cappedEnqs = await intakeRepo.findSqlConflictEnquiryCandidates<Enquiry>(env.ctxAlpha, {
          terms: ['CapCheckEnq'],
          viewerId: 'P-000002',
          hasRestrictedMatterAccess: false,
          limit: 2,
        });
        expect(cappedEnqs).toHaveLength(2);
      });
    },
    45_000,
  );

  it(
    '12. R705: restricts conflict previews to permitted intake kinds & permissions, enforces 30/min rate limit, and emits tenant+correlation-only telemetry on restricted hits',
    async () => {
      resetConflictPreviewRateLimiterForTests();
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();

      // Actor with employee:edit_core ONLY (all 5 conflict-preview permissions revoked)
      const seedFe = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000002');
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(seedFe!),
        permissionOverrides: {
          grant: ['employee:edit_core'],
          revoke: [
            'enquiry:create',
            'enquiry:edit',
            'quote:edit',
            'matter:create',
            'matter:edit',
          ],
        },
      });
      const hrOnlyActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(hrOnlyActor.verifiedSession);

      await runWithActiveActorSession(hrOnlyActor, async () => {
        const hrPreview = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            callingOnBehalfOf: 'Staff Alpha Confidential Ltd',
            includeConflicts: true,
          },
          'P-000002',
        );
        if (isActionDenied(hrPreview)) throw new Error(hrPreview.error);
        expect(hrPreview.conflictSearch).toBeNull();
        expect(hrPreview.possibleConflicts).toEqual([]);
      });

      // Restore normal partner/FE permissions on P-000001 and P-000002
      const partnerActor = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantAlpha,
      );
      setTestEntraSessionOverride(partnerActor.verifiedSession);

      await runWithActiveActorSession(partnerActor, async () => {
        // Disallowed kind 'person' or 'organisation' never returns conflictSearch/possibleConflicts even when includeConflicts=true
        const personKindRes = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'person',
            firstName: 'Cerys',
            surname: 'Pritchard-Alpha',
            includeConflicts: true,
          },
          'P-000001',
        );
        if (isActionDenied(personKindRes)) throw new Error(personKindRes.error);
        expect(personKindRes.conflictSearch).toBeNull();
        expect(personKindRes.possibleConflicts).toEqual([]);
      });

      // Restore P-000002 overrides to normal fee_earner so we can verify restricted telemetry & rate limit
      await partyRepo.putPerson(env.ctxAlpha, seedFe!);
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        const telemetryRecorder = getPlatformTelemetryRecorder();
        telemetryRecorder.clearForTesting();

        // 1st call returns restricted match and emits tenant+correlation-only telemetry event
        const firstHit = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            callingOnBehalfOf: 'Staff Alpha Confidential Ltd',
            includeConflicts: true,
          },
          'P-000002',
        );
        if (isActionDenied(firstHit)) throw new Error(firstHit.error);
        expect(firstHit.possibleConflicts.some((c) => c.recordId.startsWith('restricted-'))).toBe(true);

        const restrictedEvents = telemetryRecorder
          .getRecentEntries({ tenantId: env.tenantAlpha })
          .filter((e) => e.eventName === 'conflict.preview.restricted_match');
        expect(restrictedEvents.length).toBeGreaterThanOrEqual(1);
        const latestEvent = restrictedEvents[restrictedEvents.length - 1]!;
        expect(latestEvent.tenantId).toBe(env.tenantAlpha);
        expect(latestEvent.correlationId).toBeTruthy();
        expect(Object.keys(latestEvent.properties ?? {})).toEqual([]);

        // Next 29 calls succeed (total 30 within 60s window), 31st trips RATE_LIMITED
        for (let i = 0; i < 29; i++) {
          const okRes = await previewIntakeDuplicatesAndConflictsRecord(
            {
              kind: 'enquiry',
              callingOnBehalfOf: 'Alpha Public Client',
              includeConflicts: true,
            },
            'P-000002',
          );
          expect(isActionDenied(okRes)).toBe(false);
        }
        const rateLimited = await previewIntakeDuplicatesAndConflictsRecord(
          {
            kind: 'enquiry',
            callingOnBehalfOf: 'Alpha Public Client',
            includeConflicts: true,
          },
          'P-000002',
        );
        expect(isActionDenied(rateLimited)).toBe(true);
        if (isActionDenied(rateLimited)) {
          expect(rateLimited.code).toBe('RATE_LIMITED');
        }
      });
      resetConflictPreviewRateLimiterForTests();
    },
    45_000,
  );

  it(
    '13. R710 & R715: pickers strip restricted/conflict/fieldValues/quote/full-matter payloads, hydrate edit record via RBAC, and classify corporateRelation structurally',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();

      // Build parent <- targetOrg -> child and sister sibling, plus a director & contact link
      const parentOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R715-PARENT',
        legalName: 'R715 Holding Group PLC',
        parentOrganisationId: null,
      };
      const targetOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R715-TARGET',
        legalName: 'R715 Operating Subsidiary Ltd',
        parentOrganisationId: parentOrg.id,
      };
      const childOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R715-CHILD',
        legalName: 'R715 Trading Child Ltd',
        parentOrganisationId: targetOrg.id,
      };
      const sisterOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R715-SISTER',
        legalName: 'R715 Sister Company Ltd',
        parentOrganisationId: parentOrg.id,
      };
      for (const org of [parentOrg, targetOrg, childOrg, sisterOrg]) {
        await partyRepo.putOrganisation(env.ctxAlpha, org);
      }

      const directorPerson: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-R715-DIR',
        firstName: 'Gareth',
        surname: 'DirectorLink',
        jobTitle: 'Managing Associate',
        isEmployee: false,
      };
      const contactPerson: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-R715-CON',
        firstName: 'Nia',
        surname: 'ContactLink',
        jobTitle: 'Office Manager',
        isEmployee: false,
      };
      await partyRepo.putPerson(env.ctxAlpha, directorPerson);
      await partyRepo.putPerson(env.ctxAlpha, contactPerson);

      await partyRepo.putLink(env.ctxAlpha, {
        id: 'L-R715-DIR',
        personId: directorPerson.id,
        organisationId: targetOrg.id,
        jobTitle: 'Non-Executive Director',
        department: 'Board',
        roleWithinOrganisation: 'Director',
        contactRoleIds: [],
        isPrimaryContact: true,
        isCurrent: true,
        startDate: '2026-01-01',
        endDate: null,
        contactStatusId: null,
        createdById: 'P-000001',
        createdAt: '2026-01-01',
        updatedById: 'P-000001',
        updatedAt: '2026-01-01',
      });
      await partyRepo.putLink(env.ctxAlpha, {
        id: 'L-R715-CON',
        personId: contactPerson.id,
        organisationId: targetOrg.id,
        jobTitle: 'Office Manager',
        department: 'Operations',
        roleWithinOrganisation: 'Primary Contact',
        contactRoleIds: [],
        isPrimaryContact: false,
        isCurrent: true,
        startDate: '2026-01-01',
        endDate: null,
        contactStatusId: null,
        createdById: 'P-000001',
        createdAt: '2026-01-01',
        updatedById: 'P-000001',
        updatedAt: '2026-01-01',
      });

      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        // R710: Slim picker payload across matter, enquiry, quote, person, organisation
        const matterPicker = await searchEntityPickerRecord(
          { entityTypes: ['matter'], query: env.alphaPubMatter.matterNumber },
          'P-000002',
        );
        if (isActionDenied(matterPicker)) throw new Error(matterPicker.error);
        expect(matterPicker.items.length).toBeGreaterThan(0);
        const mItem = matterPicker.items[0]!;
        expect(mItem.matterSummary?.id).toBe(env.alphaPubMatter.id);
        expect(mItem.matterSummary?.teamMemberIds).toBeDefined();
        const serializedMatter = JSON.stringify(mItem);
        expect(serializedMatter).not.toContain('restrictedAccessUserIds');
        expect(serializedMatter).not.toContain('conflictCheckRecord');
        expect(serializedMatter).not.toContain('fieldValues');

        const enqAndQuotePicker = await searchEntityPickerRecord(
          { entityTypes: ['enquiry', 'quote'], query: 'Alpha' },
          'P-000002',
        );
        if (isActionDenied(enqAndQuotePicker)) throw new Error(enqAndQuotePicker.error);
        const serializedEnqQuote = JSON.stringify(enqAndQuotePicker);
        expect(serializedEnqQuote).not.toContain('conflictSnapshot');
        expect(serializedEnqQuote).not.toContain('conflictDecision');
        expect(serializedEnqQuote).not.toContain('"quote":');

        // R710: Full-record hydration helper works for authorised actors and strips RBAC/payroll fields
        const hydratedOrg = await getEntityRecordForEditRecord(
          'organisation',
          targetOrg.id,
          'P-000002',
        );
        expect(isActionDenied(hydratedOrg)).toBe(false);
        if (!isActionDenied(hydratedOrg) && hydratedOrg.recordType === 'organisation') {
          expect(hydratedOrg.organisation?.id).toBe(targetOrg.id);
        }

        const hydratedStaff = await getEntityRecordForEditRecord(
          'person',
          'P-000001',
          'P-000002',
        );
        expect(isActionDenied(hydratedStaff)).toBe(false);
        if (!isActionDenied(hydratedStaff) && hydratedStaff.recordType === 'person') {
          expect(hydratedStaff.person?.id).toBe('P-000001');
          expect((hydratedStaff.person as { permissionOverrides?: unknown } | undefined)?.permissionOverrides).toBeUndefined();
          expect((hydratedStaff.person as { entraObjectId?: unknown } | undefined)?.entraObjectId).toBeUndefined();
          expect(hydratedStaff.person?.employment?.payroll).toBeUndefined();
        }

        // R715: Corporate group & link relation classification uses stable keys
        const corpGroupPicker = await searchEntityPickerRecord(
          {
            entityTypes: ['person', 'organisation'],
            query: '',
            corporateGroupOfOrgId: targetOrg.id,
            limit: 50,
          },
          'P-000002',
        );
        if (isActionDenied(corpGroupPicker)) throw new Error(corpGroupPicker.error);
        const byId = new Map(corpGroupPicker.items.map((i) => [i.id, i]));
        expect(byId.get(parentOrg.id)?.corporateRelation).toBe('parent');
        expect(byId.get(childOrg.id)?.corporateRelation).toBe('subsidiary');
        expect(byId.get(sisterOrg.id)?.corporateRelation).toBe('group');
        expect(byId.get(directorPerson.id)?.corporateRelation).toBe('director');
        expect(byId.get(contactPerson.id)?.corporateRelation).toBe('contact');
      });
    },
    45_000,
  );

  it(
    '14. R714: savePersonRecord and saveOrganisationRecord auto-flag server-detected duplicates even when client flags/matchedDuplicateIds are omitted',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();

      const feActor = makeActorSession(
        'P-000002',
        ['fee_earner'],
        env.tenantAlpha,
      );
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);

      await runWithActiveActorSession(feActor, async () => {
        const basePersonRes = await savePersonRecord(
          {
            firstName: 'Sioned',
            surname: 'Pryce',
            emails: [
              {
                id: 'em-sioned-1',
                address: 'sioned.pryce@alpha-test.example',
                typeId: null,
                isPrimary: true,
              },
            ],
            phones: [],
          },
          { byId: 'P-000002' },
        );
        expect(basePersonRes.errors).toBeUndefined();
        const existingPersonId = basePersonRes.person.id;

        // Save second matching Person with client flags omitted (simulating pending preview)
        const secondPersonRes = await savePersonRecord(
          {
            firstName: 'Sioned',
            surname: 'Pryce',
            emails: [
              {
                id: 'em-sioned-2',
                address: 'sioned.pryce.alt@alpha-test.example',
                typeId: null,
                isPrimary: true,
              },
            ],
            phones: [],
          },
          {
            byId: 'P-000002',
            flagPossibleDuplicate: false,
            matchedDuplicateIds: [],
          },
        );
        expect(secondPersonRes.errors).toBeUndefined();
        expect(secondPersonRes.person.duplicateStatusId).toBe(
          'duplicate_status.possible_match',
        );
        expect(secondPersonRes.person.possibleMatchIds).toContain(existingPersonId);

        const reloadedBasePerson = await partyRepo.getPersonById<Person>(
          env.ctxAlpha,
          existingPersonId,
        );
        expect(reloadedBasePerson?.duplicateStatusId).toBe(
          'duplicate_status.possible_match',
        );
        expect(reloadedBasePerson?.possibleMatchIds).toContain(
          secondPersonRes.person.id,
        );

        const baseOrgRes = await saveOrganisationRecord(
          {
            legalName: 'Cymru Quarry Services Ltd',
            companyNumber: '09988776',
          },
          { byId: 'P-000002' },
        );
        expect(baseOrgRes.errors).toBeUndefined();
        const existingOrgId = baseOrgRes.organisation.id;

        // Save second matching Organisation without client flag/IDs
        const secondOrgRes = await saveOrganisationRecord(
          {
            legalName: 'Cymru Quarry Services Limited',
            companyNumber: '',
          },
          {
            byId: 'P-000002',
            flagPossibleDuplicate: false,
            matchedDuplicateIds: [],
          },
        );
        expect(secondOrgRes.errors).toBeUndefined();
        expect(secondOrgRes.organisation.duplicateStatusId).toBe(
          'duplicate_status.possible_match',
        );
        expect(secondOrgRes.organisation.possibleMatchIds).toContain(
          existingOrgId,
        );

        const reloadedBaseOrg = await partyRepo.getOrganisationById<Organisation>(
          env.ctxAlpha,
          existingOrgId,
        );
        expect(reloadedBaseOrg?.duplicateStatusId).toBe(
          'duplicate_status.possible_match',
        );
        expect(reloadedBaseOrg?.possibleMatchIds).toContain(
          secondOrgRes.organisation.id,
        );
      });
    },
    45_000,
  );

  it(
    '15. R700: /admin/pms-links, retention count, and matter party usage counts work identically from SQL regardless of landing tab and without loading full client arrays',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const cfgAlpha = getActiveTenantConfiguration();
      const seed = createSeedStore(new Date('2026-11-01T10:00:00Z'));
      await importFirmStoreModulesToPostgres({
        ctx: env.ctxAlpha,
        tenantConfig: cfgAlpha,
        store: structuredClone(seed),
        modules: ['pms'],
        clearFirst: false,
      });

      const partyRepo = new TenantPartyRepository();
      const matterRepo = new TenantMatterRepository();
      const intakeRepo = new TenantIntakeQuoteRepository();

      // Seed unlinked non-merged records in Alpha
      await partyRepo.putOrganisation(env.ctxAlpha, {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R700-UNLINKED',
        legalName: 'Unlinked Cambria Quarry Ltd',
        companyNumber: '07778889',
        mergedIntoId: null,
      });
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-R700-UNLINKED',
        firstName: 'Elen',
        surname: 'Davies-R700',
        isEmployee: false,
        mergedIntoId: null,
      });

      // Seed closed unconverted enquiries past retention period + negative controls (open, converted, recent closed, already anonymised)
      await intakeRepo.putEnquiry(env.ctxAlpha, {
        ...structuredClone(env.alphaPublicOpenEnquiry),
        id: 'ENQ-R700-EXP-1',
        reference: 'ENQ-R700-EXP-1',
        status: 'Declined',
        convertedMatterId: null,
        anonymisedAt: null,
        receivedAt: '2022-01-15T10:00:00.000Z',
        closedAt: '2022-02-01T10:00:00.000Z',
      });
      await intakeRepo.putEnquiry(env.ctxAlpha, {
        ...structuredClone(env.alphaPublicOpenEnquiry),
        id: 'ENQ-R700-EXP-2',
        reference: 'ENQ-R700-EXP-2',
        status: 'No response',
        convertedMatterId: null,
        anonymisedAt: null,
        receivedAt: '2022-03-10T10:00:00.000Z',
        closedAt: '2022-03-25T10:00:00.000Z',
      });
      await intakeRepo.putEnquiry(env.ctxAlpha, {
        ...structuredClone(env.alphaPublicOpenEnquiry),
        id: 'ENQ-R700-CONV-OLD',
        reference: 'ENQ-R700-CONV-OLD',
        status: 'Converted',
        convertedMatterId: 'M-000001',
        anonymisedAt: null,
        receivedAt: '2020-01-01T00:00:00.000Z',
      });
      await intakeRepo.putEnquiry(env.ctxAlpha, {
        ...structuredClone(env.alphaPublicOpenEnquiry),
        id: 'ENQ-R700-ANON-OLD',
        reference: 'ENQ-R700-ANON-OLD',
        status: 'Declined',
        convertedMatterId: null,
        anonymisedAt: '2024-01-01T00:00:00.000Z',
        receivedAt: '2021-01-01T00:00:00.000Z',
      });

      const allMatters = await matterRepo.listAllMattersUnfiltered<Matter>(env.ctxAlpha);
      const expectedUsageCounts = computeMatterPartyUsageCounts(allMatters);
      const allEnquiries = await intakeRepo.listVisibleEnquiries<Enquiry>(
        env.ctxAlpha,
        'P-000001',
        { includeRestricted: true },
      );
      const retentionMonths = seed.enquirySettings.retentionMonths || 12;
      const now = new Date();
      const expectedRetentionCount = allEnquiries.filter((e) =>
        isReadyForRetentionAnonymisation(e, retentionMonths, now),
      ).length;
      expect(expectedRetentionCount).toBeGreaterThanOrEqual(2);

      const adminActor = makeActorSession(
        'P-000001',
        ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
        env.tenantAlpha,
      );
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(adminActor.verifiedSession);

      await runWithActiveActorSession(adminActor, async () => {
        const pmsLanding = await loadAdminPageData('P-000001', {
          slug: ['pms-links'],
          mfaVerified: true,
        });
        expect('redirectTo' in pmsLanding).toBe(false);
        if ('redirectTo' in pmsLanding) return;

        // No 500-capped client arrays required
        expect(pmsLanding.matters).toEqual([]);
        expect(pmsLanding.organisations).toEqual([]);
        expect(pmsLanding.enquiries).toEqual([]);

        // Landing on /admin/pms-links directly exposes unlinked orgs + linked display labels (never raw IDs)
        const landingAny = pmsLanding as unknown as {
          initialPmsLinksData?: {
            unlinkedOrganisationsPage?: { items: Array<{ id: string }>; totalCount: number };
            linkedRecordTitles?: Record<string, { label: string }>;
          };
          expiredUnconvertedEnquiriesCount?: number;
          matterPartyUsageCounts?: unknown;
        };
        expect(landingAny.initialPmsLinksData).toBeDefined();
        expect(
          landingAny.initialPmsLinksData?.unlinkedOrganisationsPage?.items.some(
            (o) => o.id === 'O-R700-UNLINKED',
          ),
        ).toBe(true);
        expect(landingAny.expiredUnconvertedEnquiriesCount).toBe(expectedRetentionCount);
        expect(landingAny.matterPartyUsageCounts).toEqual(expectedUsageCounts);

        // Landing on enquiry-settings still gets SQL counts without enquiries/matters
        const enqLanding = await loadAdminPageData('P-000001', {
          slug: ['enquiry-settings'],
          mfaVerified: true,
        });
        expect('redirectTo' in enqLanding).toBe(false);
        if ('redirectTo' in enqLanding) return;
        expect(
          (enqLanding as unknown as { expiredUnconvertedEnquiriesCount?: number })
            .expiredUnconvertedEnquiriesCount,
        ).toBe(expectedRetentionCount);

        // Linked display titles resolve non-raw labels for PMS links
        for (const l of pmsLanding.initialPmsLinksData?.pmsAdmin.pmsLinks ?? []) {
          const titleMeta =
            pmsLanding.initialPmsLinksData?.linkedRecordTitles[l.onesquaredId];
          if (titleMeta) {
            expect(titleMeta.label).not.toBe('');
            expect(titleMeta.href).toMatch(/^\//);
          }
        }

        // Server search & sub-tab fetching via loadPmsLinksAdminDataRecord (no 500 cap, zero Bravo data)
        const searchedOrgs = await loadPmsLinksAdminDataRecord(
          { subTab: 'organisations', query: 'Cambria', page: 1, pageSize: 25 },
          'P-000001',
        );
        expect(isActionDenied(searchedOrgs)).toBe(false);
        if (!isActionDenied(searchedOrgs)) {
          expect(
            searchedOrgs.unlinkedOrganisationsPage.items.map((o) => o.id),
          ).toEqual(['O-R700-UNLINKED']);
          expect(searchedOrgs.unlinkedOrganisationsPage.totalCount).toBe(1);
        }

        const unlinkedPeopleRes = await loadPmsLinksAdminDataRecord(
          { subTab: 'people', query: 'Davies-R700', page: 1, pageSize: 25 },
          'P-000001',
        );
        expect(isActionDenied(unlinkedPeopleRes)).toBe(false);
        if (!isActionDenied(unlinkedPeopleRes)) {
          expect(
            unlinkedPeopleRes.unlinkedPeoplePage.items.map((p) => p.id),
          ).toEqual(['P-R700-UNLINKED']);
          expect(
            unlinkedPeopleRes.unlinkedPeoplePage.items.some(
              (p) => p.id === env.bravoPerson.id,
            ),
          ).toBe(false);
          expect(unlinkedPeopleRes.linkedRecordTitles[env.bravoPerson.id]).toBeUndefined();
        }

        expect(
          searchedOrgs &&
            !isActionDenied(searchedOrgs) &&
            searchedOrgs.linkedRecordTitles[env.bravoOrg.id],
        ).toBeUndefined();

        const adminMattersRes = await loadPmsLinksAdminDataRecord(
          { subTab: 'matters', page: 1, pageSize: 100 },
          'P-000001',
        );
        expect(isActionDenied(adminMattersRes)).toBe(false);
        if (!isActionDenied(adminMattersRes)) {
          expect(
            adminMattersRes.unlinkedMattersPage.items.some(
              (m) => m.id === env.bravoMatter.id,
            ),
          ).toBe(false);
          expect(adminMattersRes.linkedRecordTitles[env.bravoMatter.id]).toBeUndefined();
        }

        const sqlCountRes = await getExpiredEnquiriesCountRecord(
          retentionMonths,
          'P-000001',
        );
        expect(isActionDenied(sqlCountRes)).toBe(false);
        if (!isActionDenied(sqlCountRes)) {
          expect(sqlCountRes.count).toBe(expectedRetentionCount);
        }
      });

      // R726: finance:manage_links actor WITHOUT matter:restricted:access on matters sub-tab
      // sees linked/unlinked public matters but zero restricted matters and zero Bravo data.
      const pmsRepo = new TenantPmsRepository();
      const linkedPubMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-R700-LINKED-PUB',
        matterNumber: 'ALPH-R700-PUB',
        title: 'Alpha R700 Linked Public Matter',
      };
      const linkedStaffMatter: Matter = {
        ...structuredClone(env.alphaStaffMatter),
        id: 'M-R700-LINKED-STAFF',
        matterNumber: 'ALPH-R700-STAFF',
        title: 'Alpha R700 Linked Restricted Staff Matter',
        isStaffMatter: true,
        hasEthicalWall: true,
        restrictedAccessUserIds: ['P-000001'],
      };
      await Promise.all([
        matterRepo.putMatter(env.ctxAlpha, linkedPubMatter),
        matterRepo.putMatter(env.ctxAlpha, linkedStaffMatter),
      ]);
      await Promise.all([
        pmsRepo.putPmsLink(env.ctxAlpha, {
          id: 'PMSL-R700-PUB',
          entityType: 'matter',
          onesquaredId: linkedPubMatter.id,
          pmsCode: 'MAT-R700-PUB',
          matchedBy: 'manual',
          matchedAt: '2026-11-10T10:00:00.000Z',
          syncStatus: 'Synced',
        }),
        pmsRepo.putPmsLink(env.ctxAlpha, {
          id: 'PMSL-R700-STAFF',
          entityType: 'matter',
          onesquaredId: linkedStaffMatter.id,
          pmsCode: 'MAT-R700-STAFF',
          matchedBy: 'manual',
          matchedAt: '2026-11-10T10:00:00.000Z',
          syncStatus: 'Synced',
        }),
      ]);
      const baseFinanceEmp = (await partyRepo.getPersonById<Person>(
        env.ctxAlpha,
        'P-000009',
      ))!;
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(baseFinanceEmp),
        id: 'P-S102B-PMS-NOMAT',
        roles: ['finance'],
        permissionOverrides: {
          grant: ['finance:manage_links'],
          revoke: ['matter:restricted:access'],
        },
      });
      const pmsNoMatActor = makeActorSession('P-S102B-PMS-NOMAT', [], env.tenantAlpha);
      setTestEntraSessionOverride(pmsNoMatActor.verifiedSession);
      await runWithActiveActorSession(pmsNoMatActor, async () => {
        const mattersSubTab = await loadPmsLinksAdminDataRecord(
          { subTab: 'matters', page: 1, pageSize: 100 },
          'P-S102B-PMS-NOMAT',
        );
        expect(isActionDenied(mattersSubTab)).toBe(false);
        if (!isActionDenied(mattersSubTab)) {
          const unlinkedIds = mattersSubTab.unlinkedMattersPage.items.map((m) => m.id);
          expect(unlinkedIds).toContain(env.alphaPubMatter.id);
          expect(unlinkedIds).not.toContain(env.alphaStaffMatter.id);
          expect(unlinkedIds).not.toContain(env.bravoMatter.id);
          expect(mattersSubTab.linkedRecordTitles[linkedPubMatter.id]).toBeDefined();
          expect(mattersSubTab.linkedRecordTitles[linkedStaffMatter.id]).toBeUndefined();
          expect(mattersSubTab.linkedRecordTitles[env.bravoMatter.id]).toBeUndefined();
        }
      });

      // Unauthorised fee_earner is denied PMS links data and retention count
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const deniedPms = await loadPmsLinksAdminDataRecord({}, 'P-000002');
        expect(isActionDenied(deniedPms)).toBe(true);
        const deniedRet = await getExpiredEnquiriesCountRecord(12, 'P-000002');
        expect(isActionDenied(deniedRet)).toBe(true);
      });
    },
    45_000,
  );

  it(
    '16. R702: server paging, SQL total counts, server search/filters, and open-tasks-first across list loaders',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const taskRepo = new TenantTaskWorkflowRepository();
      const olderOpenId = 'TSK-R702-OPEN-1';
      const doneIds = ['TSK-R702-DONE-1', 'TSK-R702-DONE-2', 'TSK-R702-DONE-3'];

      await taskRepo.putTask(env.ctxAlpha, {
        ...structuredClone(env.alphaUrgentPublicTask),
        id: olderOpenId,
        reference: 'TSK-R702-OPEN',
        title: 'R702-Older-Open-Task',
        description: 'Older open task must never drop behind newer done tasks',
        status: 'To do',
        taskTypeId: 'tt_general',
        priorityId: 'tp_normal',
        dueAt: '2020-01-15T09:00:00Z',
        assignedTeamId: null,
        assignedPersonId: 'P-000001',
        assignedPersonIds: ['P-000001'],
        createdById: 'P-000001',
        createdAt: '2020-01-01T09:00:00Z',
        updatedAt: '2020-01-01T09:00:00Z',
        completedAt: null,
        completedById: null,
        linkedRecords: [],
      });

      for (const [idx, id] of doneIds.entries()) {
        await taskRepo.putTask(env.ctxAlpha, {
          ...structuredClone(env.alphaUrgentPublicTask),
          id,
          reference: `TSK-R702-DONE-${idx + 1}`,
          title: `R702-Done-Task-${idx + 1}`,
          description: 'Newer completed task for R702 paging test',
          status: 'Done',
          taskTypeId: 'tt_general',
          priorityId: 'tp_normal',
          dueAt: `2099-05-0${idx + 1}T09:00:00Z`,
          assignedTeamId: null,
          assignedPersonId: 'P-000001',
          assignedPersonIds: ['P-000001'],
          createdById: 'P-000001',
          createdAt: `2099-05-0${idx + 1}T09:00:00Z`,
          updatedAt: `2099-05-0${idx + 1}T09:00:00Z`,
          completedAt: `2099-05-0${idx + 1}T10:00:00Z`,
          completedById: 'P-000001',
          linkedRecords: [],
        });
      }

      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);
      await runWithActiveActorSession(partnerActor, async () => {
        // Tasks: default is open tasks first (newer done tasks never push open tasks off page 1)
        const openTasksPage = await loadTasksListPageData('P-000001', {
          page: 1,
          pageSize: 2,
          query: 'R702-',
        });
        expect(openTasksPage.tasks.map((t) => t.id)).toEqual([olderOpenId]);
        expect(openTasksPage.pagination.totalCount).toBe(1);
        expect(openTasksPage.pagination.page).toBe(1);
        expect(openTasksPage.pagination.pageSize).toBe(2);

        const donePage1 = await loadTasksListPageData('P-000001', {
          page: 1,
          pageSize: 2,
          statusFilter: 'done',
          query: 'R702-',
        });
        const donePage2 = await loadTasksListPageData('P-000001', {
          page: 2,
          pageSize: 2,
          statusFilter: 'done',
          query: 'R702-',
        });
        expect(donePage1.tasks).toHaveLength(2);
        expect(donePage2.tasks).toHaveLength(1);
        expect(donePage1.pagination.totalCount).toBe(3);
        const allDoneIds = [...donePage1.tasks, ...donePage2.tasks].map((t) => t.id);
        expect(new Set(allDoneIds)).toEqual(new Set(doneIds));

        const allTasksPage1 = await loadTasksListPageData('P-000001', {
          page: 1,
          pageSize: 2,
          statusFilter: 'all',
          query: 'R702-',
        });
        expect(allTasksPage1.tasks[0]?.id).toBe(olderOpenId);
        expect(allTasksPage1.pagination.totalCount).toBe(4);

        // People: server paging + server query
        const peopleP1 = await loadPeopleListPageData('P-000001', { page: 1, pageSize: 2 });
        const peopleP2 = await loadPeopleListPageData('P-000001', { page: 2, pageSize: 2 });
        expect(peopleP1.people).toHaveLength(2);
        expect(peopleP2.people.length).toBeGreaterThan(0);
        expect(peopleP1.pagination.totalCount).toBeGreaterThan(2);
        const p1Ids = new Set(peopleP1.people.map((p) => p.id));
        expect(peopleP2.people.some((p) => p1Ids.has(p.id))).toBe(false);

        const searchPersonTarget = peopleP2.people[0]!;
        const peopleSearched = await loadPeopleListPageData('P-000001', {
          page: 1,
          pageSize: 2,
          query: searchPersonTarget.surname,
        });
        expect(peopleSearched.people.some((p) => p.id === searchPersonTarget.id)).toBe(true);

        // Organisations: server paging + SQL active matter counts
        const orgsP1 = await loadOrganisationsListPageData('P-000001', {
          page: 1,
          pageSize: 2,
        });
        const orgsP2 = await loadOrganisationsListPageData('P-000001', {
          page: 2,
          pageSize: 2,
        });
        expect(orgsP1.organisations.length).toBeLessThanOrEqual(2);
        expect(orgsP1.pagination.totalCount).toBeGreaterThan(2);
        const o1Ids = new Set(orgsP1.organisations.map((o) => o.id));
        expect(orgsP2.organisations.some((o) => o1Ids.has(o.id))).toBe(false);
        const pubOrgPage = await loadOrganisationsListPageData('P-000001', {
          page: 1,
          pageSize: 5,
          query: env.alphaPubOrg.legalName,
        });
        expect(pubOrgPage.activeMatterCountsByOrgId[env.alphaPubOrg.id]).toBeGreaterThanOrEqual(1);

        // Matters: server paging + server search + visibility enforcement
        const mattersP1 = await loadMattersListPageData('P-000001', {
          page: 1,
          pageSize: 2,
        });
        const mattersP2 = await loadMattersListPageData('P-000001', {
          page: 2,
          pageSize: 2,
        });
        expect(mattersP1.matters).toHaveLength(2);
        expect(mattersP1.pagination.totalCount).toBeGreaterThan(2);
        const m1Ids = new Set(mattersP1.matters.map((m) => m.id));
        expect(mattersP2.matters.some((m) => m1Ids.has(m.id))).toBe(false);
        const searchMatterTarget = mattersP2.matters[0]!;
        const mattersSearched = await loadMattersListPageData('P-000001', {
          page: 1,
          pageSize: 2,
          query: searchMatterTarget.matterNumber,
        });
        expect(mattersSearched.matters.some((m) => m.id === searchMatterTarget.id)).toBe(true);

        // Enquiries: server paging + server search
        const enqP1 = await loadEnquiriesListPageData('P-000001', {
          page: 1,
          pageSize: 1,
          tab: 'all',
          typeFilter: 'enquiry',
        });
        const enqP2 = await loadEnquiriesListPageData('P-000001', {
          page: 2,
          pageSize: 1,
          tab: 'all',
          typeFilter: 'enquiry',
        });
        expect(enqP1.enquiries).toHaveLength(1);
        expect(enqP2.enquiries).toHaveLength(1);
        expect(enqP1.enquiriesPagination.totalCount).toBeGreaterThanOrEqual(2);
        expect(enqP2.enquiries[0]!.id).not.toBe(enqP1.enquiries[0]!.id);
        const enqSearched = await loadEnquiriesListPageData('P-000001', {
          page: 1,
          pageSize: 1,
          tab: 'all',
          typeFilter: 'enquiry',
          query: enqP2.enquiries[0]!.reference,
        });
        expect(enqSearched.enquiries.some((e) => e.id === enqP2.enquiries[0]!.id)).toBe(true);
      });

      // Restricted matter stays excluded from counts & server search for excluded fee earner
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const hiddenSearch = await loadMattersListPageData('P-000002', {
          page: 1,
          pageSize: 10,
          query: env.alphaStaffMatter.matterNumber,
        });
        expect(
          hiddenSearch.matters.some((m) => m.id === env.alphaStaffMatter.id),
        ).toBe(false);
      });
    },
    45_000,
  );

  it(
    '17. R717: getEntityRecordForEditRecord redacts restricted matter references in conflictCheckOnHire for non-participants',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();
      const seedEmp = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000002');
      expect(seedEmp?.employment).toBeTruthy();

      const targetEmpId = 'P-R717-EMP';
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(seedEmp!),
        id: targetEmpId,
        firstName: 'R717',
        surname: 'ConflictEmp',
        emails: [
          {
            id: 'em-r717-emp',
            address: 'r717.emp@invented.example',
            typeId: null,
            isPrimary: true,
          },
        ],
        employment: {
          ...structuredClone(seedEmp!.employment!),
          personId: targetEmpId,
          employeeNumber: 'EMP-9717',
          conflictCheckOnHire: {
            checkedAt: '2026-11-20T10:00:00Z',
            openMatterIds: [env.alphaStaffMatter.id, env.alphaPubMatter.id],
            flaggedToRisk: true,
            informationBarrierConsidered: true,
            riskNotes: `Person is a party on 2 open matter(s) (${env.alphaStaffMatter.matterNumber}, ${env.alphaPubMatter.matterNumber}).`,
          },
        },
      });

      // Non-participant holding employee:view_core + contact:edit (standard fee_earner has both, lacks matter:restricted:access)
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const editRes = await getEntityRecordForEditRecord(
          'person',
          targetEmpId,
          'P-000002',
        );
        expect(isActionDenied(editRes)).toBe(false);
        if (!isActionDenied(editRes)) {
          const check = editRes.person?.employment?.conflictCheckOnHire;
          expect(check).toBeTruthy();
          expect(check?.openMatterIds).not.toContain(env.alphaStaffMatter.id);
          expect(check?.openMatterIds).toContain(env.alphaPubMatter.id);
          expect(check?.riskNotes).not.toContain(env.alphaStaffMatter.matterNumber);
          expect(check?.riskNotes).toContain(env.alphaPubMatter.matterNumber);
        }
      });

      // Positive control: participant / restricted-matter holder sees both matters
      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);
      await runWithActiveActorSession(partnerActor, async () => {
        const partnerRes = await getEntityRecordForEditRecord(
          'person',
          targetEmpId,
          'P-000001',
        );
        expect(isActionDenied(partnerRes)).toBe(false);
        if (!isActionDenied(partnerRes)) {
          const check = partnerRes.person?.employment?.conflictCheckOnHire;
          expect(check?.openMatterIds).toContain(env.alphaStaffMatter.id);
          expect(check?.riskNotes).toContain(env.alphaStaffMatter.matterNumber);
        }

        // R726: cross-tenant Bravo person/org requested from Alpha returns null
        const crossTenantPerson = await getEntityRecordForEditRecord(
          'person',
          env.bravoPerson.id,
          'P-000001',
        );
        expect(crossTenantPerson).toEqual({ recordType: 'person', person: null });

        const crossTenantOrg = await getEntityRecordForEditRecord(
          'organisation',
          env.bravoOrg.id,
          'P-000001',
        );
        expect(crossTenantOrg).toEqual({
          recordType: 'organisation',
          organisation: null,
        });
      });

      // R726: forged Bravo tenant claim while active tenant is Alpha is rejected fail closed
      const forgedBravoClaim = makeActorSession(
        'P-000001',
        ['partner'],
        env.tenantBravo,
      );
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(forgedBravoClaim.verifiedSession);
      await runWithActiveActorSession(forgedBravoClaim, async () => {
        await expect(
          getEntityRecordForEditRecord('person', targetEmpId, 'P-000001'),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      });
    },
    45_000,
  );

  it(
    '18. R718: shell.employees never leaks dateOfBirth, permissionOverrides, entraObjectId, showsWorkOfId, or employment',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      const partyRepo = new TenantPartyRepository();
      const emp = await partyRepo.getPersonById<Person>(env.ctxAlpha, 'P-000002');
      expect(emp).toBeTruthy();
      await partyRepo.putPerson(env.ctxAlpha, {
        ...structuredClone(emp!),
        dateOfBirth: '1988-07-19',
        entraObjectId: '00000000-0000-4000-8000-000000009719',
        permissionOverrides: {
          grant: ['matter:edit'],
          revoke: [],
          reason: 'R718 shell strip verification',
        },
        showsWorkOfId: 'P-000001',
      });

      for (const actorSpec of [
        { id: 'P-000001', roles: ['partner', 'admin'] },
        { id: 'P-000002', roles: ['fee_earner'] },
      ]) {
        const session = makeActorSession(actorSpec.id, actorSpec.roles, env.tenantAlpha);
        setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
        setTestEntraSessionOverride(session.verifiedSession);
        await runWithActiveActorSession(session, async () => {
          const shell = await loadShellContext(actorSpec.id);
          expect(shell.employees.length).toBeGreaterThan(0);
          for (const e of shell.employees) {
            expect('dateOfBirth' in e).toBe(false);
            expect('permissionOverrides' in e).toBe(false);
            expect('entraObjectId' in e).toBe(false);
            expect('showsWorkOfId' in e).toBe(false);
            expect('employment' in e).toBe(false);
            expect(e.dateOfBirth).toBeUndefined();
            expect(e.permissionOverrides).toBeUndefined();
            expect(e.entraObjectId).toBeUndefined();
            expect(e.showsWorkOfId).toBeUndefined();
            expect(e.employment).toBeUndefined();
          }
        });
      }
    },
    45_000,
  );

  it(
    '19. R719: server search matches promised non-name fields with matching SQL totalCount across Tasks, Matters, People, and Organisations',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const matterRepo = new TenantMatterRepository();
      const taskRepo = new TenantTaskWorkflowRepository();
      const partyRepo = new TenantPartyRepository();

      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);

      // Unique matter number + unique task linked record + unique town + unique postcode
      const shell = await runWithActiveActorSession(partnerActor, () =>
        loadShellContext('P-000001'),
      );
      const distinctiveWorkType = shell.values.find(
        (v) => v.listKey === 'work_type' && !v.parentId && v.label.trim().length >= 5,
      );
      expect(distinctiveWorkType).toBeTruthy();

      const uniqueMatterNum = 'R719-MAT-9042';
      const uniqueMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-R719-SEARCH',
        matterNumber: uniqueMatterNum,
        title: 'Unrelated Title For R719 Verification',
        shortDescription: 'Unrelated description',
        practiceAreaId: distinctiveWorkType!.id,
      };
      await matterRepo.putMatter(env.ctxAlpha, uniqueMatter);

      const linkedTask: Task = {
        ...structuredClone(env.alphaUrgentPublicTask),
        id: 'TSK-R719-LINKED',
        reference: 'TSK-9719',
        title: 'Chase counterpart signature',
        description: 'Plain task body without matter ref',
        status: 'To do',
        linkedRecords: [{ recordType: 'matter', recordId: uniqueMatter.id }],
      };
      await taskRepo.putTask(env.ctxAlpha, linkedTask);

      const townPerson: Person = {
        ...structuredClone(env.alphaRestrictedPerson),
        id: 'P-R719-TOWN',
        firstName: 'Owain',
        surname: 'Llewellyn-Sample',
        emails: [
          {
            id: 'em-r719-town',
            address: 'owain.r719@invented.example',
            typeId: null,
            isPrimary: true,
          },
        ],
        addresses: [
          {
            id: 'addr-r719-town',
            typeId: null,
            line1: '12 Pier Street',
            line2: '',
            town: 'Aberystwyth-R719',
            county: 'Ceredigion',
            postcode: 'SY23 2LN',
            countryId: null,
          },
        ],
      };
      await partyRepo.putPerson(env.ctxAlpha, townPerson);

      const postcodeOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R719-POSTCODE',
        legalName: 'Ceredigion Marine Services Ltd',
        companyNumber: '09719001',
        registeredAddress: {
          id: 'oaddr-r719',
          typeId: null,
          line1: 'Harbour Quay',
          line2: '',
          town: 'Cardigan',
          county: 'Ceredigion',
          postcode: 'SA43 9R7',
          countryId: null,
        },
      };
      await partyRepo.putOrganisation(env.ctxAlpha, postcodeOrg);

      await runWithActiveActorSession(partnerActor, async () => {
        // Task search by linked matter number
        const taskSearch = await loadTasksListPageData('P-000001', {
          page: 1,
          pageSize: 10,
          tab: 'all',
          statusFilter: 'open',
          query: uniqueMatterNum,
        });
        expect(taskSearch.tasks.map((t) => t.id)).toEqual([linkedTask.id]);
        expect(taskSearch.pagination.totalCount).toBe(1);

        // Matter search by practice-area label
        const matterSearch = await loadMattersListPageData('P-000001', {
          page: 1,
          pageSize: 50,
          query: distinctiveWorkType!.label,
        });
        expect(matterSearch.matters.some((m) => m.id === uniqueMatter.id)).toBe(true);
        expect(matterSearch.pagination.totalCount).toBeGreaterThanOrEqual(
          matterSearch.matters.length,
        );

        // Person search by town
        const personSearch = await loadPeopleListPageData('P-000001', {
          page: 1,
          pageSize: 10,
          query: 'Aberystwyth-R719',
        });
        expect(personSearch.people.map((p) => p.id)).toEqual([townPerson.id]);
        expect(personSearch.pagination.totalCount).toBe(1);

        // Organisation search by postcode
        const orgSearch = await loadOrganisationsListPageData('P-000001', {
          page: 1,
          pageSize: 10,
          query: 'SA43 9R7',
        });
        expect(orgSearch.organisations.map((o) => o.id)).toEqual([postcodeOrg.id]);
        expect(orgSearch.pagination.totalCount).toBe(1);
      });
    },
    45_000,
  );

  it(
    '20. R720: /enquiries "all" unified UNION ALL paging with unequal counts returns exact bounded non-empty pages covering the full union',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const intakeRepo = new TenantIntakeQuoteRepository();
      const marker = 'R720-UNION-MARKER';

      const createdKeys: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const id = `ENQ-R720-${i}`;
        createdKeys.push(`enquiry:${id}`);
        await intakeRepo.putEnquiry(env.ctxAlpha, {
          ...structuredClone(env.alphaPublicOpenEnquiry),
          id,
          reference: `ENQ-720${i}`,
          status: 'New',
          firstName: `Enq${i}`,
          lastName: 'R720Union',
          summary: `${marker} Enquiry ${i}`,
          receivedAt: `2026-11-0${i}T09:00:00Z`,
          convertedMatterId: null,
        });
      }
      for (let j = 1; j <= 7; j++) {
        const id = `QUO-R720-${j}`;
        createdKeys.push(`quote:${id}`);
        await intakeRepo.putQuote(env.ctxAlpha, {
          ...structuredClone(env.alphaStaffQuote),
          id,
          reference: `QTE-2026-720${j}`,
          status: 'Sent',
          validUntil: '2099-12-31',
          convertedMatterId: null,
          linkedEnquiryId: null,
          prospectName: `QuoteProspect${j} R720`,
          scope: `${marker} Quote ${j}`,
          createdAt: `2026-11-1${j}T10:00:00Z`,
          sentAt: `2026-11-1${j}T10:05:00Z`,
          nextFollowUpDate: '2099-12-01',
        });
      }

      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);
      await runWithActiveActorSession(partnerActor, async () => {
        const p1 = await loadEnquiriesListPageData('P-000001', {
          page: 1,
          pageSize: 4,
          tab: 'all',
          query: marker,
        });
        const p2 = await loadEnquiriesListPageData('P-000001', {
          page: 2,
          pageSize: 4,
          tab: 'all',
          query: marker,
        });
        const p3 = await loadEnquiriesListPageData('P-000001', {
          page: 3,
          pageSize: 4,
          tab: 'all',
          query: marker,
        });

        expect(p1.pagination.totalCount).toBe(10);
        expect(p1.enquiriesPagination.totalCount).toBe(3);
        expect(p1.quotesPagination.totalCount).toBe(7);

        expect(p1.orderedQueueItems).toHaveLength(4);
        expect(p1.enquiries.length + p1.quotes.length).toBe(4);
        expect(p2.orderedQueueItems).toHaveLength(4);
        expect(p2.enquiries.length + p2.quotes.length).toBe(4);
        expect(p3.orderedQueueItems).toHaveLength(2);
        expect(p3.enquiries.length + p3.quotes.length).toBe(2);

        const unionKeys = [
          ...p1.orderedQueueItems,
          ...p2.orderedQueueItems,
          ...p3.orderedQueueItems,
        ].map((r) => `${r.kind}:${r.id}`);
        expect(unionKeys).toHaveLength(10);
        expect(new Set(unionKeys)).toEqual(new Set(createdKeys));
      });
    },
    45_000,
  );

  it(
    '21. R722 & R731: table-driven server sorting maintains monotonic ordering across pages for every allow-listed sort key in both directions',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);

      await runWithActiveActorSession(partnerActor, async () => {
        const shell = await loadShellContext('P-000001');
        const values = shell.values;
        const relStatusOrder = values
          .filter((v) => v.listKey === 'relationship_status')
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((v) => v.id);
        const matterStatusOrder = [
          'cmi_incomplete',
          'active',
          'prospective',
          'on_hold',
          'completed',
          'closed',
          'archived',
          'aborted',
        ].flatMap((sysKey) =>
          values
            .filter(
              (v) =>
                v.listKey === 'matter_status' &&
                (v.systemKey === sysKey ||
                  values.find((x) => x.id === v.id)?.systemKey === sysKey),
            )
            .map((v) => v.id),
        );
        const relStatusRank = (statusId: string | null | undefined): number => {
          if (!statusId) return 0;
          const idx = relStatusOrder.indexOf(statusId);
          return idx >= 0 ? idx + 1 : 9999;
        };
        const matterStatusRank = (statusId: string): number => {
          if (matterStatusOrder.length === 0) return 0;
          const idx = matterStatusOrder.indexOf(statusId);
          return idx >= 0 ? idx + 1 : 999;
        };
        const urgencyRankMap = (urgencyId: string): number => {
          const val = values.find((v) => v.id === urgencyId);
          switch (val?.systemKey) {
            case 'emergency':
              return 0;
            case 'urgent':
              return 1;
            case 'standard':
              return 2;
            default:
              return 3;
          }
        };
        const intakeStatusRank = (kind: 'enquiry' | 'quote', item: Enquiry | Quote): number => {
          const st =
            kind === 'quote'
              ? (() => {
                  const q = item as Quote;
                  if (
                    (q.status === 'Sent' || q.status === 'Follow-up due') &&
                    q.validUntil &&
                    q.validUntil < new Date().toISOString().slice(0, 10)
                  ) {
                    return 'Expired';
                  }
                  return q.status;
                })()
              : (item as Enquiry).status;
          switch (st) {
            case 'New':
              return 1;
            case 'Follow-up due':
              return 2;
            case 'Assigned':
              return 3;
            case 'Sent':
              return 4;
            case 'In contact':
              return 5;
            case 'Draft':
              return 6;
            case 'Accepted':
              return 7;
            case 'Converted':
              return 8;
            case 'Declined':
              return 9;
            case 'Referred out':
              return 10;
            case 'No response':
              return 11;
            case 'Expired':
              return 12;
            case 'Superseded':
              return 13;
            default:
              return 99;
          }
        };
        const taskPriorityRank = (priorityId: string): number => {
          const key = values.find((v) => v.id === priorityId)?.systemKey;
          if (key === 'urgent') return 1;
          if (key === 'high') return 2;
          if (key === 'low') return 4;
          return 3;
        };
        const taskStatusRank = (task: Task): number => {
          if (task.status === 'In progress') return 1;
          if (task.status === 'To do') return 2;
          if (task.status === 'Waiting') return 3;
          if (task.status === 'Done') return 4;
          return 5;
        };

        const assertMonotonicKey = (
          label: string,
          dir: 'asc' | 'desc',
          a: number | string,
          b: number | string,
        ) => {
          if (typeof a === 'number' && typeof b === 'number') {
            expect(dir === 'asc' ? a <= b : a >= b, `${label} (${dir}): ${a} vs ${b}`).toBe(true);
            return;
          }
          const sa = String(a);
          const sb = String(b);
          expect(dir === 'asc' ? sa <= sb : sa >= sb, `${label} (${dir}): ${sa} vs ${sb}`).toBe(true);
        };

        const sortCases: Array<{
          readonly label: string;
          readonly run: (
            sortDir: 'asc' | 'desc',
          ) => Promise<{
            readonly p1Rows: Array<{ readonly id: string; readonly key: number | string | null }>;
            readonly p2Rows: Array<{ readonly id: string; readonly key: number | string | null }>;
            readonly nullsLast?: boolean;
          }>;
        }> = [
          ...(['matter', 'status', 'openedAt'] as const).map((sortBy) => ({
            label: `matters:${sortBy}`,
            run: async (sortDir: 'asc' | 'desc') => {
              const p1 = await loadMattersListPageData('P-000001', {
                page: 1,
                pageSize: 2,
                sortBy,
                sortDir,
              });
              const p2 = await loadMattersListPageData('P-000001', {
                page: 2,
                pageSize: 2,
                sortBy,
                sortDir,
              });
              const extractKey = (m: Matter): string | number => {
                if (sortBy === 'matter') return m.matterNumber.toLowerCase();
                if (sortBy === 'status') return matterStatusRank(m.matterStatusId);
                return m.openedAt || m.createdAt;
              };
              return {
                p1Rows: p1.matters.map((m) => ({ id: m.id, key: extractKey(m) })),
                p2Rows: p2.matters.map((m) => ({ id: m.id, key: extractKey(m) })),
              };
            },
          })),
          ...(['priority', 'status', 'dueAt'] as const).map((sortBy) => ({
            label: `tasks:${sortBy}`,
            run: async (sortDir: 'asc' | 'desc') => {
              const p1 = await loadTasksListPageData('P-000001', {
                page: 1,
                pageSize: 2,
                tab: 'all',
                statusFilter: 'all',
                sortBy,
                sortDir,
              });
              const p2 = await loadTasksListPageData('P-000001', {
                page: 2,
                pageSize: 2,
                tab: 'all',
                statusFilter: 'all',
                sortBy,
                sortDir,
              });
              const extractKey = (t: Task): string | number | null => {
                if (sortBy === 'priority') return taskPriorityRank(t.priorityId);
                if (sortBy === 'status') return taskStatusRank(t);
                return t.dueAt ? t.dueAt : null;
              };
              return {
                p1Rows: p1.tasks.map((t) => ({ id: t.id, key: extractKey(t) })),
                p2Rows: p2.tasks.map((t) => ({ id: t.id, key: extractKey(t) })),
                nullsLast: sortBy === 'dueAt',
              };
            },
          })),
          ...(['urgency', 'status', 'receivedAt'] as const).map((sortBy) => ({
            label: `enquiries:${sortBy}`,
            run: async (sortDir: 'asc' | 'desc') => {
              const p1 = await loadEnquiriesListPageData('P-000001', {
                page: 1,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const p2 = await loadEnquiriesListPageData('P-000001', {
                page: 2,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const mapPageRows = (res: Awaited<ReturnType<typeof loadEnquiriesListPageData>>) => {
                const enqById = new Map(res.enquiries.map((e) => [e.id, e]));
                const quoteById = new Map(res.quotes.map((q) => [q.id, q]));
                return res.orderedQueueItems.map((ref) => {
                  if (ref.kind === 'enquiry') {
                    const e = enqById.get(ref.id)!;
                    const key =
                      sortBy === 'urgency'
                        ? urgencyRankMap(e.urgencyId)
                        : sortBy === 'status'
                          ? intakeStatusRank('enquiry', e)
                          : Date.parse(e.receivedAt || e.createdAt);
                    return { id: `enquiry:${e.id}`, key };
                  }
                  const q = quoteById.get(ref.id)!;
                  const key =
                    sortBy === 'urgency'
                      ? 2
                      : sortBy === 'status'
                        ? intakeStatusRank('quote', q)
                        : Date.parse(q.createdAt);
                  return { id: `quote:${q.id}`, key };
                });
              };
              return {
                p1Rows: mapPageRows(p1),
                p2Rows: mapPageRows(p2),
              };
            },
          })),
          ...(['person', 'status'] as const).map((sortBy) => ({
            label: `people:${sortBy}`,
            run: async (sortDir: 'asc' | 'desc') => {
              const p1 = await loadPeopleListPageData('P-000001', {
                page: 1,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const p2 = await loadPeopleListPageData('P-000001', {
                page: 2,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const extractKey = (p: Person): string | number =>
                sortBy === 'person'
                  ? `${p.surname.toLowerCase()}\u0000${p.firstName.toLowerCase()}`
                  : relStatusRank(p.relationshipStatusId);
              return {
                p1Rows: p1.people.map((p) => ({ id: p.id, key: extractKey(p) })),
                p2Rows: p2.people.map((p) => ({ id: p.id, key: extractKey(p) })),
              };
            },
          })),
          ...(['organisation', 'status'] as const).map((sortBy) => ({
            label: `organisations:${sortBy}`,
            run: async (sortDir: 'asc' | 'desc') => {
              const p1 = await loadOrganisationsListPageData('P-000001', {
                page: 1,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const p2 = await loadOrganisationsListPageData('P-000001', {
                page: 2,
                pageSize: 2,
                tab: 'all',
                sortBy,
                sortDir,
              });
              const extractKey = (o: Organisation): string | number =>
                sortBy === 'organisation'
                  ? o.legalName.toLowerCase()
                  : relStatusRank(o.relationshipStatusId);
              return {
                p1Rows: p1.organisations.map((o) => ({ id: o.id, key: extractKey(o) })),
                p2Rows: p2.organisations.map((o) => ({ id: o.id, key: extractKey(o) })),
              };
            },
          })),
        ];

        for (const testCase of sortCases) {
          for (const dir of ['asc', 'desc'] as const) {
            const { p1Rows, p2Rows, nullsLast } = await testCase.run(dir);
            expect(p1Rows, `${testCase.label} (${dir}) p1`).toHaveLength(2);
            expect(p2Rows.length, `${testCase.label} (${dir}) p2`).toBeGreaterThan(0);
            const p1Ids = new Set(p1Rows.map((r) => r.id));
            expect(p2Rows.some((r) => p1Ids.has(r.id)), `${testCase.label} (${dir}) distinct pages`).toBe(false);

            const lastP1 = p1Rows[p1Rows.length - 1]!.key;
            const firstP2 = p2Rows[0]!.key;
            if (nullsLast) {
              if (lastP1 === null) {
                expect(firstP2, `${testCase.label} (${dir}) NULLS LAST`).toBeNull();
              } else if (firstP2 !== null) {
                assertMonotonicKey(testCase.label, dir, lastP1, firstP2);
              }
            } else if (testCase.label === 'tasks:status') {
              // Overdue open tasks share rank 0 (before non-overdue rank 1..5); within non-overdue rows compare rank
              if (dir === 'asc') {
                expect((lastP1 as number) <= (firstP2 as number) || (lastP1 as number) === 0 || (firstP2 as number) === 0).toBe(true);
              } else {
                expect((lastP1 as number) >= (firstP2 as number) || (firstP2 as number) === 0).toBe(true);
              }
            } else {
              assertMonotonicKey(testCase.label, dir, lastP1!, firstP2!);
            }
          }
        }
      });
    },
    60_000,
  );

  it(
    '22. R727, R729 & R732: systemKey tabs/filters scope Clients to client relationship types only, and oversized page/query inputs clamp without 500 errors',
    async () => {
      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const partyRepo = new TenantPartyRepository();

      // R727: Organisation tagged solely with system-key choice IDs resolves under clients tab
      const clientOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R727-CLIENT',
        legalName: 'R727 SystemKey Client Ltd',
        relationshipTypeIds: ['organisation_relationship_type.client'],
        relationshipStatusId: 'relationship_status.active',
      };
      await partyRepo.putOrganisation(env.ctxAlpha, clientOrg);

      // R732: Active opposing-solicitors organisation must NEVER appear in Clients, MUST appear in Referrers & others
      const opposingOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R732-OPPOSING',
        legalName: 'R732 Opposing Solicitors LLP',
        relationshipTypeIds: ['organisation_relationship_type.opposing_solicitors'],
        relationshipStatusId: 'relationship_status.active',
      };
      await partyRepo.putOrganisation(env.ctxAlpha, opposingOrg);

      expect(parseListPageParam('99999999999999999999')).toBe(MAX_LIST_PAGE_NUMBER);
      expect(parseListPageParam('not-a-number')).toBe(1);
      expect(parseListPageParam('-42')).toBe(1);
      expect(parseListPageSizeParam('9999')).toBe(200);

      const partnerActor = makeActorSession('P-000001', ['partner'], env.tenantAlpha);
      setTestEntraSessionOverride(partnerActor.verifiedSession);
      await runWithActiveActorSession(partnerActor, async () => {
        const clientsTab = await loadOrganisationsListPageData('P-000001', {
          tab: 'clients',
          query: 'R727 SystemKey Client Ltd',
        });
        expect(clientsTab.organisations.map((o) => o.id)).toEqual([clientOrg.id]);

        const clientsOpposingSearch = await loadOrganisationsListPageData('P-000001', {
          tab: 'clients',
          query: 'R732 Opposing',
        });
        expect(clientsOpposingSearch.organisations).toEqual([]);
        expect(clientsOpposingSearch.pagination.totalCount).toBe(0);

        const clientsUnfiltered = await loadOrganisationsListPageData('P-000001', {
          tab: 'clients',
          pageSize: 200,
        });
        expect(clientsUnfiltered.organisations.some((o) => o.id === opposingOrg.id)).toBe(false);

        const prospectsTab = await loadOrganisationsListPageData('P-000001', {
          tab: 'prospects',
          pageSize: 200,
        });
        expect(prospectsTab.organisations.some((o) => o.id === clientOrg.id)).toBe(false);
        expect(prospectsTab.organisations.some((o) => o.id === opposingOrg.id)).toBe(false);

        const referrersOpposingSearch = await loadOrganisationsListPageData('P-000001', {
          tab: 'referrers',
          query: 'R732 Opposing',
        });
        expect(referrersOpposingSearch.organisations.map((o) => o.id)).toEqual([opposingOrg.id]);
        expect(referrersOpposingSearch.pagination.totalCount).toBe(1);

        const referrersTab = await loadOrganisationsListPageData('P-000001', {
          tab: 'referrers',
          pageSize: 200,
        });
        expect(referrersTab.organisations.some((o) => o.id === clientOrg.id)).toBe(false);
        expect(referrersTab.organisations.some((o) => o.id === opposingOrg.id)).toBe(true);

        const allOrgsTab = await loadOrganisationsListPageData('P-000001', {
          tab: 'all',
          pageSize: 200,
        });
        expect(
          clientsUnfiltered.pagination.totalCount +
            prospectsTab.pagination.totalCount +
            referrersTab.pagination.totalCount,
        ).toBeGreaterThanOrEqual(allOrgsTab.pagination.totalCount);

        const clampedPageRes = await loadMattersListPageData('P-000001', {
          page: 99999999999999999999,
          pageSize: 2,
        });
        const expectedLastPage = Math.max(
          1,
          Math.ceil(clampedPageRes.pagination.totalCount / 2),
        );
        expect(clampedPageRes.pagination.page).toBe(expectedLastPage);
        expect(clampedPageRes.matters.length).toBeGreaterThan(0);

        const oversizedQuery = 'a'.repeat(500);
        const cappedQueryRes = await loadMattersListPageData('P-000001', {
          page: Number.NaN,
          pageSize: 2,
          query: oversizedQuery,
        });
        expect(cappedQueryRes.pagination.page).toBe(1);
        expect(cappedQueryRes.filters.query.length).toBe(MAX_LIST_QUERY_LENGTH);
      });
    },
    45_000,
  );

  it(
    '23. R726: listClientPriorMattersRecord excludes staff/walled matters for non-participants, returns [] for tampered/cross-tenant IDs, and rejects forged claims',
    async () => {
      expect(ACTION_PERMISSIONS.listClientPriorMattersAction).toEqual({
        kind: 'permission',
        key: { anyOf: ['matter:create', 'matter:edit'] },
        enforcedBy: 'action',
      });

      const env = await provisionAndSeedTwoTenants();
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      const partyRepo = new TenantPartyRepository();
      const matterRepo = new TenantMatterRepository();

      const clientOrg: Organisation = {
        ...structuredClone(env.alphaPubOrg),
        id: 'O-R726-CLIENT',
        legalName: 'R726 Prior Matter Client Ltd',
      };
      await partyRepo.putOrganisation(env.ctxAlpha, clientOrg);

      const pubMatter: Matter = {
        ...structuredClone(env.alphaPubMatter),
        id: 'M-R726-PUB',
        matterNumber: 'R726-0001',
        title: 'R726 Visible Prior Matter',
        clientId: clientOrg.id,
        responsiblePartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000002',
        teamMemberIds: ['P-000001', 'P-000002'],
        isStaffMatter: false,
        hasEthicalWall: false,
        restrictedAccessUserIds: [],
      };
      const staffMatter: Matter = {
        ...structuredClone(env.alphaStaffMatter),
        id: 'M-R726-STAFF',
        matterNumber: 'R726-STAFF',
        title: 'R726 Hidden Staff Prior Matter',
        clientId: clientOrg.id,
        responsiblePartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000001',
        teamMemberIds: ['P-000001'],
        isStaffMatter: true,
        hasEthicalWall: false,
        restrictedAccessUserIds: ['P-000001'],
      };
      const wallMatter: Matter = {
        ...structuredClone(env.alphaStaffMatter),
        id: 'M-R726-WALL',
        matterNumber: 'R726-WALL',
        title: 'R726 Hidden Walled Prior Matter',
        clientId: clientOrg.id,
        responsiblePartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000001',
        teamMemberIds: ['P-000001'],
        isStaffMatter: false,
        hasEthicalWall: true,
        restrictedAccessUserIds: ['P-000001'],
      };
      await Promise.all([
        matterRepo.putMatter(env.ctxAlpha, pubMatter),
        matterRepo.putMatter(env.ctxAlpha, staffMatter),
        matterRepo.putMatter(env.ctxAlpha, wallMatter),
      ]);

      // Non-participant fee earner sees only the public prior matter (positive control + staff/wall exclusion)
      const feActor = makeActorSession('P-000002', ['fee_earner'], env.tenantAlpha);
      setTestEntraSessionOverride(feActor.verifiedSession);
      await runWithActiveActorSession(feActor, async () => {
        const res = await listClientPriorMattersRecord([clientOrg.id], 'P-000002');
        expect(isActionDenied(res)).toBe(false);
        if (!isActionDenied(res)) {
          const ids = res.matters.map((m) => m.id);
          expect(ids).toEqual([pubMatter.id]);
          expect(ids).not.toContain(staffMatter.id);
          expect(ids).not.toContain(wallMatter.id);
        }

        // Tampered ID and cross-tenant Bravo client ID both return []
        const tampered = await listClientPriorMattersRecord(
          ['O-NONEXISTENT-999'],
          'P-000002',
        );
        expect(tampered).toEqual({ matters: [] });

        const crossTenant = await listClientPriorMattersRecord(
          [env.bravoOrg.id, env.bravoPerson.id],
          'P-000002',
        );
        expect(crossTenant).toEqual({ matters: [] });
      });

      // Forged Bravo tenant claim while active tenant is Alpha is rejected
      const forgedActor = makeActorSession('P-000002', ['fee_earner'], env.tenantBravo);
      setActiveTenantConfigForTesting(env.rawConfigAlpha, {});
      setTestEntraSessionOverride(forgedActor.verifiedSession);
      await runWithActiveActorSession(forgedActor, async () => {
        await expect(
          listClientPriorMattersRecord([clientOrg.id], 'P-000002'),
        ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
      });
    },
    45_000,
  );
});
