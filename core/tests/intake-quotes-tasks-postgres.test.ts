import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantIntakeQuoteRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantTaskWorkflowRepository,
  type TenantContext,
  type TenantEnquiryRecord,
  type TenantMatterRecord,
  type TenantNotificationRecord,
  type TenantPersonRecord,
  type TenantQuoteRecord,
  type TenantSignOffRecord,
  type TenantTaskRecord,
} from '@platform/core';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import {
  getActiveTenantConfiguration,
  getIntakeQuoteRepository,
  getMatterRepository,
  getPartyRepository,
  getTaskWorkflowRepository,
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  approveSignOff,
  discussSignOff,
  getAppSnapshot,
  listFirmAuditEntriesPage,
  prepareEnquiryConversion,
  resetAllDemoData,
  saveEnquiryRecord,
  saveMatterRecord,
  saveQuoteRecord,
  saveTaskRecord,
} from '@/server/services';
import { getStore } from '@/server/store';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { setAuditAdapterFailureHookForTesting } from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';
import type { Matter } from '@/domain/types';

function makeTenantCtx(
  tenantId: string,
  actorId = 'P-000001',
  roles: readonly string[] = [
    'admin',
    'managing_partner',
    'partner',
    'risk_compliance',
    'fee_earner',
  ],
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      roles,
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s017a-${tenantId}-${actorId}`,
  });
}

function makeActorSession(
  personId: string,
  roles: string[] = [
    'admin',
    'managing_partner',
    'partner',
    'risk_compliance',
    'fee_earner',
  ],
  tenantId = 'not-a-law-firm',
) {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const cookieVal = createSignedEntraSessionCookie({
    personId,
    tenantId,
    oid: `00000000-0000-4000-8000-${personId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: personId,
    email: `${personId.toLowerCase()}@notalawfirm.example`,
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

function makeSampleEnquiry(
  id: string,
  overrides: Partial<TenantEnquiryRecord> = {},
): TenantEnquiryRecord {
  const nowIso = '2026-11-11T10:00:00.000Z';
  return {
    id,
    reference: id,
    receivedAt: nowIso,
    takenById: 'P-ALPHA-1',
    channelId: 'enquiry_channel.phone',
    firstName: 'Eleanor',
    lastName: 'Vance',
    callingOnBehalfOf: '',
    linkedOrganisationId: null,
    email: 'eleanor.vance@invented.example',
    phone: '020 7946 0101',
    preferredContactMethodId: 'contact_method.email',
    bestTimeToCall: 'Morning',
    address: {
      id: 'ADDR-1',
      typeId: null,
      line1: '10 Invented Way',
      line2: '',
      town: 'London',
      county: 'Greater London',
      postcode: 'EC1A 1BB',
      countryId: null,
    },
    practiceAreaId: 'practice_area.commercial_property',
    workTypeSubcategoryId: null,
    summary: 'Lease renewal enquiry for invented commercial unit',
    notes: 'Initial call notes',
    initialNotes: 'Initial call notes',
    otherPartiesNamed: '',
    urgencyId: 'urgency.normal',
    keyDate: null,
    keyDateLabel: '',
    keyDates: '2026-12-01',
    estimatedValueGbp: 4500,
    fundingBasisId: 'funding_basis.private',
    otherParties: [],
    conflictStatusId: 'conflict_status.not_checked',
    conflictNotes: '',
    sourceId: 'record_source.website',
    referrerPersonId: null,
    marketingCampaign: '',
    assignedTeamId: 'TM-000001',
    assignedToId: 'P-ALPHA-1',
    status: 'New',
    firstContactDueAt: '2026-11-12T10:00:00.000Z',
    firstContactMadeAt: null,
    nextActionDate: null,
    contactLog: [],
    closeReasonId: null,
    closeNote: '',
    closedAt: null,
    closedById: null,
    referredToOrganisationId: null,
    nonEngagementLetterTaskId: null,
    linkedPersonId: null,
    convertedMatterId: null,
    privacyNoticeGiven: true,
    retentionUntil: '2028-11-11',
    anonymisedAt: null,
    createdById: 'P-ALPHA-1',
    createdAt: nowIso,
    updatedById: 'P-ALPHA-1',
    updatedAt: nowIso,
    customFields: {},
    ...overrides,
  };
}

function makeSampleQuote(
  id: string,
  overrides: Partial<TenantQuoteRecord> = {},
): TenantQuoteRecord {
  const nowIso = '2026-11-11T10:00:00.000Z';
  return {
    id,
    reference: id,
    version: 1,
    status: 'Sent',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Eleanor Vance',
    prospectOrganisationName: 'Vance Holdings Ltd',
    prospectEmail: 'eleanor.vance@invented.example',
    prospectPhone: '020 7946 0101',
    linkedEnquiryId: null,
    convertedMatterId: null,
    practiceAreaId: 'practice_area.commercial_property',
    workTypeSubcategoryId: null,
    scope: 'Commercial lease review and report on title',
    assumptions: 'Standard institutional lease',
    feeBasis: 'Fixed fee',
    feeAmountExVat: 2500,
    hourlyRateGbp: null,
    vatAmount: 500,
    vatOverridden: false,
    disbursements: [
      {
        id: 'DISB-1',
        description: 'Land Registry search',
        amountExVat: 50,
        vatApplicable: false,
      },
    ],
    totalIncVat: 3050,
    feeEarnerId: 'P-ALPHA-1',
    assignedTeamId: 'TM-000001',
    validUntil: '2026-12-11',
    followUpAfterDays: 5,
    sentAt: nowIso,
    nextFollowUpDate: '2026-11-16',
    outcomeAt: null,
    declineReason: null,
    followUps: [],
    versionHistory: [],
    timeline: [],
    createdById: 'P-ALPHA-1',
    createdAt: nowIso,
    updatedById: 'P-ALPHA-1',
    updatedAt: nowIso,
    ...overrides,
  };
}

function makeSampleTask(
  id: string,
  overrides: Partial<TenantTaskRecord> = {},
): TenantTaskRecord {
  const nowIso = '2026-11-11T10:00:00.000Z';
  return {
    id,
    reference: id,
    title: 'Follow up with prospect',
    description: 'Call prospect regarding quote',
    taskTypeId: 'task_type.follow_up',
    priorityId: 'task_priority.normal',
    status: 'To do',
    dueAt: '2026-11-15',
    assignedPersonId: 'P-ALPHA-1',
    assignedPersonIds: ['P-ALPHA-1'],
    assignedTeamId: 'TM-000001',
    linkedRecords: [],
    checklist: [],
    comments: [],
    createdById: 'P-ALPHA-1',
    createdAt: nowIso,
    updatedById: 'P-ALPHA-1',
    updatedAt: nowIso,
    completedAt: null,
    completedById: null,
    ...overrides,
  };
}

describe('S0-17a: Intake (enquiries), quotes, tasks, notifications, sign-offs and recently viewed on PostgreSQL', () => {
  afterEach(() => {
    setAuditAdapterFailureHookForTesting(null);
    setTestEntraSessionOverride(undefined);
  });

  it('Two-tenant isolation & R460 sequence privileges: TenantIntakeQuoteRepository and TenantTaskWorkflowRepository enforce positive control, forged claims, tampered IDs, SET LOCAL ROLE on a single connection, and fresh-connection reads', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });
    const ctxA = makeTenantCtx('tenant-alpha', 'P-ALPHA-1');
    const ctxB = makeTenantCtx('tenant-bravo', 'P-BRAVO-1');

    // Forged claim without __verifiedByOidcMiddleware or with untrustedRequestTenantOverride is rejected
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: false as unknown as true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-s017a-1',
      }),
    ).toThrow(
      /TENANCY_AUTH_ERROR: Tenant context can only be resolved from a verified OIDC token/i,
    );
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forged-s017a-2',
        untrustedRequestTenantOverride: 'tenant-bravo',
      }),
    ).toThrow(
      /TENANCY_FORGERY_DETECTED.*Request attempted to override authenticated token tenantId/i,
    );

    const iqRepo = new TenantIntakeQuoteRepository();
    const twRepo = new TenantTaskWorkflowRepository();

    await twRepo.clearTenantData(ctxA);
    await iqRepo.clearTenantData(ctxA);
    await twRepo.clearTenantData(ctxB);
    await iqRepo.clearTenantData(ctxB);

    // Sequence allocation & R460 privilege enforcement (USAGE, SELECT only — setval denied with 42501)
    const enqIdA = await iqRepo.allocateNextEnquiryId(ctxA);
    const qteIdA = await iqRepo.allocateNextQuoteId(ctxA);
    const qteRefA = await iqRepo.allocateNextQuoteReference(ctxA, 2026);
    const tskIdA = await twRepo.allocateNextTaskId(ctxA);
    const ntfIdA = await twRepo.allocateNextNotificationId(ctxA);
    const soIdA = await twRepo.allocateNextSignOffId(ctxA);

    expect(enqIdA).toMatch(/^ENQ-\d{6}$/);
    expect(qteIdA).toMatch(/^QTE-\d{6}$/);
    expect(qteRefA).toMatch(/^QTE-2026-\d{4}$/);
    expect(tskIdA).toMatch(/^TSK-\d{6}$/);
    expect(ntfIdA).toMatch(/^NTF-\d{6}$/);
    expect(soIdA).toMatch(/^SO-\d{6}$/);

    for (const seqName of [
      'tenant_enquiry_id_seq',
      'tenant_quote_id_seq',
      'tenant_task_id_seq',
      'tenant_notification_id_seq',
      'tenant_sign_off_id_seq',
    ]) {
      await expect(
        iqRepo.withTenantTransaction(ctxA, async (tx) => {
          await tx.query(`SELECT setval('public.${seqName}', 999999, true)`);
        }),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(
          /TENANCY_DATABASE_PERMISSION_DENIED.*SQLSTATE 42501/i,
        ),
      });
    }

    // Positive control in Tenant A
    const enqA = makeSampleEnquiry('ENQ-ISO-ALPHA-1');
    const qteA = makeSampleQuote('QTE-2026-9001', {
      linkedEnquiryId: enqA.id,
    });
    const tskA = makeSampleTask('TSK-ISO-ALPHA-1', {
      linkedRecords: [
        { recordType: 'enquiry', recordId: enqA.id },
        { recordType: 'quote', recordId: qteA.id },
      ],
    });
    const ntfA: TenantNotificationRecord = {
      id: 'NTF-ISO-ALPHA-1',
      recipientId: 'P-ALPHA-1',
      kind: 'task_assigned',
      title: 'Alpha task assigned',
      detail: 'Follow up on Alpha quote',
      href: `/tasks?task=${tskA.id}`,
      recordId: tskA.id,
      createdAt: '2026-11-11T10:05:00.000Z',
      read: false,
      byId: 'P-ALPHA-1',
    };
    const soA: TenantSignOffRecord = {
      id: 'SO-ISO-ALPHA-1',
      kind: 'new_matter_approval',
      title: 'Alpha matter opening sign-off',
      summary: 'Partner approval required',
      matterId: null,
      requestedById: 'P-ALPHA-1',
      requestedAt: '2026-11-11T10:06:00.000Z',
      approverRole: 'partner',
      status: 'pending',
    };

    await iqRepo.putEnquiry(ctxA, enqA);
    await iqRepo.putQuote(ctxA, qteA);
    await twRepo.putTask(ctxA, tskA);
    await twRepo.putNotification(ctxA, ntfA);
    await twRepo.putSignOff(ctxA, soA);
    await twRepo.putRecentlyViewedForUser(ctxA, 'P-ALPHA-1', [
      enqA.id,
      qteA.id,
      tskA.id,
    ]);

    expect((await iqRepo.getEnquiryById(ctxA, enqA.id))?.id).toBe(enqA.id);
    expect((await iqRepo.getQuoteById(ctxA, qteA.id))?.id).toBe(qteA.id);
    expect((await twRepo.getTaskById(ctxA, tskA.id))?.id).toBe(tskA.id);
    expect(await twRepo.listNotificationsForUser(ctxA, 'P-ALPHA-1')).toHaveLength(1);
    expect((await twRepo.getSignOffById(ctxA, soA.id))?.id).toBe(soA.id);
    expect(await twRepo.getRecentlyViewedForUser(ctxA, 'P-ALPHA-1')).toEqual([
      enqA.id,
      qteA.id,
      tskA.id,
    ]);

    // Tenant B cannot read or mutate Tenant A's records by ID
    expect(await iqRepo.getEnquiryById(ctxB, enqA.id)).toBeNull();
    expect(await iqRepo.getQuoteById(ctxB, qteA.id)).toBeNull();
    expect(await twRepo.getTaskById(ctxB, tskA.id)).toBeNull();
    expect(await twRepo.listNotificationsForUser(ctxB, 'P-ALPHA-1')).toEqual([]);
    expect(await twRepo.getSignOffById(ctxB, soA.id)).toBeNull();
    expect(await twRepo.getRecentlyViewedForUser(ctxB, 'P-ALPHA-1')).toEqual([]);
    expect(await iqRepo.deleteEnquiryById(ctxB, enqA.id)).toBe(false);
    expect(await iqRepo.deleteQuoteById(ctxB, qteA.id)).toBe(false);
    expect(await twRepo.deleteTaskById(ctxB, tskA.id)).toBe(false);
    expect(await twRepo.deleteNotificationById(ctxB, ntfA.id)).toBe(false);
    expect(await twRepo.deleteSignOffById(ctxB, soA.id)).toBe(false);

    // Single-connection SET LOCAL ROLE switching between roles
    const roleA = await iqRepo.withTenantReadTransaction(ctxA, async (tx) => {
      const r = await tx.query<{ current_user: string }>(
        'SELECT current_user',
      );
      return r.rows[0]?.current_user;
    });
    const roleB = await iqRepo.withTenantReadTransaction(ctxB, async (tx) => {
      const r = await tx.query<{ current_user: string }>(
        'SELECT current_user',
      );
      return r.rows[0]?.current_user;
    });
    expect(roleA).toBe('role_tenant_tenant_alpha_test');
    expect(roleB).toBe('role_tenant_tenant_bravo_test');
    expect(roleA).not.toBe(roleB);

    // Fresh-connection verification on a brand-new pool manager
    const freshPoolMgr = new TenantPostgresPoolManager();
    try {
      const freshIqRepo = new TenantIntakeQuoteRepository({
        poolManager: freshPoolMgr,
      });
      const freshTwRepo = new TenantTaskWorkflowRepository({
        poolManager: freshPoolMgr,
      });

      expect(await freshIqRepo.listVisibleEnquiries(ctxA, 'P-ALPHA-1')).toHaveLength(1);
      expect(await freshIqRepo.listVisibleQuotes(ctxA, 'P-ALPHA-1')).toHaveLength(1);
      expect(await freshTwRepo.listVisibleTasks(ctxA, 'P-ALPHA-1')).toHaveLength(1);
      expect(await freshTwRepo.listVisibleSignOffs(ctxA, 'P-ALPHA-1')).toHaveLength(1);

      expect(await freshIqRepo.listVisibleEnquiries(ctxB, 'P-BRAVO-1')).toEqual([]);
      expect(await freshIqRepo.listVisibleQuotes(ctxB, 'P-BRAVO-1')).toEqual([]);
      expect(await freshTwRepo.listVisibleTasks(ctxB, 'P-BRAVO-1')).toEqual([]);
      expect(await freshTwRepo.listVisibleSignOffs(ctxB, 'P-BRAVO-1')).toEqual([]);
    } finally {
      await freshPoolMgr.closeAllPools();
    }
  });

  it('Staff-matter & ethical-wall linkage filtering: enquiries, quotes, tasks, notifications, sign-offs and recentlyViewed linked to a restricted matter or personal draft enquiry are hidden from non-restricted viewers and visible to authorised viewers in the same test', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'tenant-alpha', environment: 'test' }],
    });
    const ctxAllowed = makeTenantCtx('tenant-alpha', 'P-ALLOWED');
    const ctxBlocked = makeTenantCtx('tenant-alpha', 'P-BLOCKED');

    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const keyDateRepo = new TenantKeyDateRepository();
    const iqRepo = new TenantIntakeQuoteRepository();
    const twRepo = new TenantTaskWorkflowRepository();

    await twRepo.clearTenantData(ctxAllowed);
    await iqRepo.clearTenantData(ctxAllowed);
    await matterRepo.clearTenantData(ctxAllowed, { resetMatterNumberSequences: true });
    await partyRepo.clearTenantData(ctxAllowed);

    // Create a restricted staff/ethical-wall matter accessible only to P-ALLOWED
    const seedMatter = structuredClone(getStore().matters[0]!);
    const restrictedMatter: TenantMatterRecord = {
      ...seedMatter,
      id: 'M-RESTRICTED-1',
      rowVersion: 1,
      matterNumber: 'MAT-26-0001',
      title: 'Restricted Staff Investigation',
      isStaffMatter: true,
      hasEthicalWall: true,
      restrictedAccessUserIds: ['P-ALLOWED'],
      sourceEnquiryId: 'ENQ-CONVERTED-RESTRICTED',
      sourceQuoteId: 'QTE-CONVERTED-RESTRICTED',
      parties: [],
    };
    await matterRepo.createMatter(ctxAllowed, restrictedMatter, {
      sqlRestrictedAccessUserIds: ['P-ALLOWED'],
    });
    await keyDateRepo.setMatterRestriction(ctxAllowed, {
      matterId: restrictedMatter.id,
      isRestricted: true,
      restrictedAccessUserIds: ['P-ALLOWED'],
    });

    // 1. Enquiry converted into restricted matter
    const convertedRestrictedEnq = makeSampleEnquiry('ENQ-CONVERTED-RESTRICTED', {
      status: 'Converted',
      convertedMatterId: restrictedMatter.id,
    });
    // 2. Personal Draft enquiry belonging to P-ALLOWED
    const draftEnq = makeSampleEnquiry('ENQ-PERSONAL-DRAFT', {
      status: 'Draft',
      takenById: 'P-ALLOWED',
      createdById: 'P-ALLOWED',
    });
    // 3. Open enquiry with a conflict hit referencing restrictedMatter
    const openEnqWithRestrictedHit = makeSampleEnquiry('ENQ-OPEN-WITH-HIT', {
      status: 'New',
      conflictSnapshot: {
        recordedAt: '2026-11-11T09:30:00.000Z',
        recordedById: 'P-ALLOWED',
        searchedInput: {
          firstName: 'Eleanor',
          lastName: 'Vance',
          callingOnBehalfOf: '',
          otherPartiesNamed: '',
          email: 'eleanor.vance@invented.example',
          phone: '020 7946 0101',
          postcode: 'EC1A 1BB',
          addressLine1: '10 Invented Way',
          addressLine2: '',
        },
        matchCount: 2,
        highestSeverity: 'high',
        conflictStatus: 'Possible conflict',
        conflicts: [
          {
            recordType: 'matter',
            recordId: restrictedMatter.id,
            name: 'Restricted Staff Investigation',
            recordLabel: 'Restricted Staff Investigation',
            queryTerm: 'Investigation',
            reason: 'Matched title',
            matchedFields: ['title'],
            severity: 'high',
            strength: 90,
            blocking: true,
            href: `/matters/${restrictedMatter.id}`,
          },
          {
            recordType: 'person',
            recordId: 'P-PUBLIC-1',
            name: 'Public Contact',
            recordLabel: 'Public Contact',
            queryTerm: 'Public',
            reason: 'Matched surname',
            matchedFields: ['surname'],
            severity: 'medium',
            strength: 60,
            blocking: false,
            href: '/people/P-PUBLIC-1',
          },
        ],
        knownPeople: [],
        knownOrganisations: [],
      },
    });
    await iqRepo.putEnquiries(ctxAllowed, [
      convertedRestrictedEnq,
      draftEnq,
      openEnqWithRestrictedHit,
    ]);

    // 4. Quote converted into restricted matter & quote linked to hidden draft enquiry
    const convertedRestrictedQuote = makeSampleQuote('QTE-CONVERTED-RESTRICTED', {
      status: 'Converted',
      convertedMatterId: restrictedMatter.id,
    });
    const quoteOnDraftEnq = makeSampleQuote('QTE-ON-DRAFT-ENQ', {
      status: 'Draft',
      linkedEnquiryId: draftEnq.id,
    });
    const publicQuote = makeSampleQuote('QTE-PUBLIC-1', {
      status: 'Sent',
      linkedEnquiryId: openEnqWithRestrictedHit.id,
    });
    await iqRepo.putQuotes(ctxAllowed, [
      convertedRestrictedQuote,
      quoteOnDraftEnq,
      publicQuote,
    ]);

    // 5. Tasks linked to restricted matter, hidden enquiry, hidden quote, and public enquiry
    const taskOnRestrictedMatter = makeSampleTask('TSK-ON-RESTRICTED-MATTER', {
      linkedRecords: [{ recordType: 'matter', recordId: restrictedMatter.id }],
    });
    const taskOnRestrictedEnq = makeSampleTask('TSK-ON-RESTRICTED-ENQ', {
      linkedRecords: [
        { recordType: 'enquiry', recordId: convertedRestrictedEnq.id },
      ],
    });
    const taskOnRestrictedQuote = makeSampleTask('TSK-ON-RESTRICTED-QTE', {
      linkedRecords: [
        { recordType: 'quote', recordId: convertedRestrictedQuote.id },
      ],
    });
    const publicTask = makeSampleTask('TSK-PUBLIC-1', {
      linkedRecords: [
        { recordType: 'enquiry', recordId: openEnqWithRestrictedHit.id },
      ],
    });
    await twRepo.putTasks(ctxAllowed, [
      taskOnRestrictedMatter,
      taskOnRestrictedEnq,
      taskOnRestrictedQuote,
      publicTask,
    ]);

    // 6. Sign-off on restricted matter vs unrestricted sign-off
    const restrictedSignOff: TenantSignOffRecord = {
      id: 'SO-RESTRICTED-1',
      kind: 'bill_request',
      title: 'Restricted bill request',
      summary: 'Bill on restricted staff matter',
      matterId: restrictedMatter.id,
      requestedById: 'P-ALLOWED',
      requestedAt: '2026-11-11T10:00:00.000Z',
      approverRole: 'partner',
      status: 'pending',
    };
    const publicSignOff: TenantSignOffRecord = {
      id: 'SO-PUBLIC-1',
      kind: 'new_matter_approval',
      title: 'Public sign-off',
      summary: 'General sign-off',
      matterId: null,
      requestedById: 'P-ALLOWED',
      requestedAt: '2026-11-11T10:01:00.000Z',
      approverRole: 'partner',
      status: 'pending',
    };
    await twRepo.putSignOffs(ctxAllowed, [restrictedSignOff, publicSignOff]);

    // 7. Notifications & recently viewed for both viewers
    await twRepo.putNotifications(ctxAllowed, [
      {
        id: 'NTF-BLOCKED-RESTRICTED',
        recipientId: 'P-BLOCKED',
        kind: 'task_assigned',
        title: 'Secret task',
        detail: 'Should be hidden',
        href: `/matters/${restrictedMatter.id}`,
        recordId: restrictedMatter.id,
        createdAt: '2026-11-11T10:02:00.000Z',
        read: false,
      },
      {
        id: 'NTF-BLOCKED-PUBLIC',
        recipientId: 'P-BLOCKED',
        kind: 'task_assigned',
        title: 'Public task',
        detail: 'Visible',
        href: `/tasks?task=${publicTask.id}`,
        recordId: publicTask.id,
        createdAt: '2026-11-11T10:03:00.000Z',
        read: false,
      },
      {
        id: 'NTF-ALLOWED-RESTRICTED',
        recipientId: 'P-ALLOWED',
        kind: 'task_assigned',
        title: 'Allowed secret task',
        detail: 'Visible to P-ALLOWED',
        href: `/matters/${restrictedMatter.id}`,
        recordId: restrictedMatter.id,
        createdAt: '2026-11-11T10:04:00.000Z',
        read: false,
      },
    ]);
    await twRepo.putRecentlyViewedForUser(ctxAllowed, 'P-BLOCKED', [
      restrictedMatter.id,
      convertedRestrictedEnq.id,
      convertedRestrictedQuote.id,
      taskOnRestrictedMatter.id,
      publicTask.id,
    ]);
    await twRepo.putRecentlyViewedForUser(ctxAllowed, 'P-ALLOWED', [
      restrictedMatter.id,
      convertedRestrictedEnq.id,
      convertedRestrictedQuote.id,
      taskOnRestrictedMatter.id,
      publicTask.id,
    ]);

    // Non-restricted viewer (P-BLOCKED) assertions
    const blockedEnquiries = await iqRepo.listVisibleEnquiries(
      ctxBlocked,
      'P-BLOCKED',
    );
    expect(blockedEnquiries.map((e) => e.id)).toEqual(['ENQ-OPEN-WITH-HIT']);
    expect(
      blockedEnquiries[0]?.conflictSnapshot?.conflicts?.map(
        (c: { recordId: string }) => c.recordId,
      ),
    ).toEqual(['P-PUBLIC-1']);
    expect(
      await iqRepo.getEnquiryById(ctxBlocked, convertedRestrictedEnq.id, {
        viewerId: 'P-BLOCKED',
      }),
    ).toBeNull();
    expect(
      await iqRepo.getEnquiryById(ctxBlocked, draftEnq.id, {
        viewerId: 'P-BLOCKED',
      }),
    ).toBeNull();

    const blockedQuotes = await iqRepo.listVisibleQuotes(ctxBlocked, 'P-BLOCKED');
    expect(blockedQuotes.map((q) => q.id)).toEqual(['QTE-PUBLIC-1']);
    expect(
      await iqRepo.getQuoteById(ctxBlocked, convertedRestrictedQuote.id, {
        viewerId: 'P-BLOCKED',
      }),
    ).toBeNull();

    const blockedTasks = await twRepo.listVisibleTasks(ctxBlocked, 'P-BLOCKED');
    expect(blockedTasks.map((t) => t.id)).toEqual(['TSK-PUBLIC-1']);
    expect(
      await twRepo.getTaskById(ctxBlocked, taskOnRestrictedMatter.id, {
        viewerId: 'P-BLOCKED',
      }),
    ).toBeNull();

    const blockedSignOffs = await twRepo.listVisibleSignOffs(
      ctxBlocked,
      'P-BLOCKED',
    );
    expect(blockedSignOffs.map((s) => s.id)).toEqual(['SO-PUBLIC-1']);

    const blockedNotifications = await twRepo.listNotificationsForUser(
      ctxBlocked,
      'P-BLOCKED',
      { viewerId: 'P-BLOCKED' },
    );
    expect(blockedNotifications.map((n) => n.id)).toEqual(['NTF-BLOCKED-PUBLIC']);

    const blockedRecent = await twRepo.getRecentlyViewedForUser(
      ctxBlocked,
      'P-BLOCKED',
      { viewerId: 'P-BLOCKED' },
    );
    expect(blockedRecent).toEqual(['TSK-PUBLIC-1']);

    // Authorised control viewer (P-ALLOWED) assertions in the same test
    const allowedEnquiries = await iqRepo.listVisibleEnquiries(
      ctxAllowed,
      'P-ALLOWED',
    );
    expect(allowedEnquiries.map((e) => e.id).sort()).toEqual([
      'ENQ-CONVERTED-RESTRICTED',
      'ENQ-OPEN-WITH-HIT',
      'ENQ-PERSONAL-DRAFT',
    ]);
    const allowedOpenEnq = allowedEnquiries.find(
      (e) => e.id === 'ENQ-OPEN-WITH-HIT',
    );
    expect(
      allowedOpenEnq?.conflictSnapshot?.conflicts
        ?.map((c: { recordId: string }) => c.recordId)
        .sort(),
    ).toEqual(['M-RESTRICTED-1', 'P-PUBLIC-1']);

    const allowedQuotes = await iqRepo.listVisibleQuotes(ctxAllowed, 'P-ALLOWED');
    expect(allowedQuotes.map((q) => q.id).sort()).toEqual([
      'QTE-CONVERTED-RESTRICTED',
      'QTE-ON-DRAFT-ENQ',
      'QTE-PUBLIC-1',
    ]);

    const allowedTasks = await twRepo.listVisibleTasks(ctxAllowed, 'P-ALLOWED');
    expect(allowedTasks.map((t) => t.id).sort()).toEqual([
      'TSK-ON-RESTRICTED-ENQ',
      'TSK-ON-RESTRICTED-MATTER',
      'TSK-ON-RESTRICTED-QTE',
      'TSK-PUBLIC-1',
    ]);

    const allowedSignOffs = await twRepo.listVisibleSignOffs(
      ctxAllowed,
      'P-ALLOWED',
    );
    expect(allowedSignOffs.map((s) => s.id).sort()).toEqual([
      'SO-PUBLIC-1',
      'SO-RESTRICTED-1',
    ]);

    const allowedNotifications = await twRepo.listNotificationsForUser(
      ctxAllowed,
      'P-ALLOWED',
      { viewerId: 'P-ALLOWED' },
    );
    expect(allowedNotifications.map((n) => n.id)).toEqual([
      'NTF-ALLOWED-RESTRICTED',
    ]);

    const allowedRecent = await twRepo.getRecentlyViewedForUser(
      ctxAllowed,
      'P-ALLOWED',
      { viewerId: 'P-ALLOWED' },
    );
    expect(allowedRecent).toEqual([
      restrictedMatter.id,
      convertedRestrictedEnq.id,
      convertedRestrictedQuote.id,
      taskOnRestrictedMatter.id,
      publicTask.id,
    ]);
  });

  it('Same-transaction atomicity: saveEnquiryRecord, saveQuoteRecord, saveTaskRecord, approveSignOff, discussSignOff, anonymiseExpiredEnquiries, and saveMatterRecord conversion roll back data + automatic tasks + audit_entries together on failure', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const session = makeActorSession('P-000001');
    setTestEntraSessionOverride(session.verifiedSession);

    const freshPoolMgr = new TenantPostgresPoolManager();
    const freshIqRepo = new TenantIntakeQuoteRepository({
      poolManager: freshPoolMgr,
    });
    const freshTwRepo = new TenantTaskWorkflowRepository({
      poolManager: freshPoolMgr,
    });
    const freshMatterRepo = new TenantMatterRepository({
      poolManager: freshPoolMgr,
    });
    const freshAuditRepo = new TenantAuditRepository({
      poolManager: freshPoolMgr,
    });

    try {
      await runWithActiveActorSession(session, async () => {
        // 1. saveEnquiryRecord rollback on audit failure
        const enqCountBefore = (await freshIqRepo.listAllEnquiriesUnfiltered(ctx))
          .length;
        setAuditAdapterFailureHookForTesting(() => {
          throw new Error('SIMULATED_S017A_ENQUIRY_AUDIT_FAILURE');
        });
        await expect(
          saveEnquiryRecord(
            {
              takenById: 'P-000001',
              channelId: 'enquiry_channel.phone',
              firstName: 'RolledBack',
              lastName: 'Enquirer',
              callingOnBehalfOf: '',
              linkedOrganisationId: null,
              email: 'rolledback.enquirer@invented.example',
              phone: '020 7946 0999',
              preferredContactMethodId: 'contact_method.email',
              bestTimeToCall: 'Anytime',
              address: null,
              practiceAreaId: 'practice_area.commercial_property',
              workTypeSubcategoryId: null,
              summary: 'Should roll back on audit failure',
              notes: 'Initial high-level enquiry notes for rollback test.',
              otherPartiesNamed: '',
              urgencyId: 'urgency.normal',
              keyDate: null,
              keyDateLabel: '',
              sourceId: 'record_source.website',
              referrerPersonId: null,
              assignedTeamId: 'TM-000001',
              assignedToId: 'P-000001',
              privacyNoticeGiven: true,
              customFields: {},
            },
            { byId: 'P-000001' },
          ),
        ).rejects.toThrow(/SIMULATED_S017A_ENQUIRY_AUDIT_FAILURE/);
        setAuditAdapterFailureHookForTesting(null);

        expect((await freshIqRepo.listAllEnquiriesUnfiltered(ctx)).length).toBe(
          enqCountBefore,
        );
        expect(
          getStore().enquiries.some((e) => e.firstName === 'RolledBack'),
        ).toBe(false);

        // 2. saveQuoteRecord rollback on audit failure
        const quoteCountBefore = (await freshIqRepo.listAllQuotesUnfiltered(ctx))
          .length;
        setAuditAdapterFailureHookForTesting(() => {
          throw new Error('SIMULATED_S017A_QUOTE_AUDIT_FAILURE');
        });
        await expect(
          saveQuoteRecord(
            {
              clientType: 'prospect',
              prospectName: 'RolledBack Prospect',
              prospectEmail: 'rolledback.prospect@invented.example',
              practiceAreaId: 'practice_area.commercial_property',
              scope: 'Rolled back quote scope',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1800,
              disbursements: [],
              feeEarnerId: 'P-000001',
            },
            { byId: 'P-000001', markAsSent: true },
          ),
        ).rejects.toThrow(/SIMULATED_S017A_QUOTE_AUDIT_FAILURE/);
        setAuditAdapterFailureHookForTesting(null);

        expect((await freshIqRepo.listAllQuotesUnfiltered(ctx)).length).toBe(
          quoteCountBefore,
        );
        expect(
          getStore().quotes.some((q) => q.prospectName === 'RolledBack Prospect'),
        ).toBe(false);

        // 3. saveTaskRecord rollback on audit failure
        const taskCountBefore = (await freshTwRepo.listAllTasksUnfiltered(ctx))
          .length;
        setAuditAdapterFailureHookForTesting(() => {
          throw new Error('SIMULATED_S017A_TASK_AUDIT_FAILURE');
        });
        await expect(
          saveTaskRecord(
            {
              title: 'RolledBack Task Title',
              description: 'Should roll back',
              taskTypeId: 'task_type.general',
              priorityId: 'task_priority.normal',
              status: 'To do',
              dueAt: '2026-12-01',
              assignedPersonId: 'P-000001',
              assignedTeamId: 'TM-000001',
              linkedRecords: [],
            },
            'P-000001',
          ),
        ).rejects.toThrow(/SIMULATED_S017A_TASK_AUDIT_FAILURE/);
        setAuditAdapterFailureHookForTesting(null);

        expect((await freshTwRepo.listAllTasksUnfiltered(ctx)).length).toBe(
          taskCountBefore,
        );
        expect(
          getStore().tasks.some((t) => t.title === 'RolledBack Task Title'),
        ).toBe(false);

        // 4. approveSignOff & discussSignOff rollback on audit failure
        const pendingSignOff = (
          await freshTwRepo.listAllSignOffsUnfiltered(ctx)
        ).find((s) => s.status === 'Pending');
        expect(pendingSignOff).toBeDefined();
        setAuditAdapterFailureHookForTesting(() => {
          throw new Error('SIMULATED_S017A_SIGNOFF_AUDIT_FAILURE');
        });
        await expect(
          approveSignOff(pendingSignOff!.id, 'P-000001'),
        ).rejects.toThrow(/SIMULATED_S017A_SIGNOFF_AUDIT_FAILURE/);
        await expect(
          discussSignOff(pendingSignOff!.id, 'Discuss note', 'P-000001'),
        ).rejects.toThrow(/SIMULATED_S017A_SIGNOFF_AUDIT_FAILURE/);
        setAuditAdapterFailureHookForTesting(null);

        const freshSignOff = await freshTwRepo.getSignOffById(
          ctx,
          pendingSignOff!.id,
          { includeRestricted: true },
        );
        expect(freshSignOff?.status).toBe('Pending');

        // 5. saveMatterRecord conversion atomicity (matter + enquiry conversion + automatic tasks + audit_entries)
        const createdEnqRes = await saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'ConvertAtomicity',
            lastName: 'Client',
            callingOnBehalfOf: '',
            linkedOrganisationId: 'O-000001',
            email: 'convert.atomicity@invented.example',
            phone: '020 7946 0888',
            preferredContactMethodId: 'contact_method.email',
            bestTimeToCall: 'Morning',
            address: null,
            practiceAreaId: 'practice_area.commercial_property',
            workTypeSubcategoryId: null,
            summary: 'Enquiry for atomic conversion test',
            notes: 'Enquiry high-level notes for atomic conversion test.',
            otherPartiesNamed: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000001',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000001' },
        );
        expect(createdEnqRes.enquiry).toBeDefined();
        const convEnqId = createdEnqRes.enquiry!.id;

        const prepRes = await prepareEnquiryConversion(
          convEnqId,
          { useOrganisationId: 'O-000001' },
          'P-000001',
        );
        expect(prepRes.ok).toBe(true);

        const baseMatter = (
          await freshMatterRepo.listAllMattersUnfiltered<Matter>(ctx)
        ).find((m) => !m.isStaffMatter)!;
        const { id: _omittedMatterId, ...matterTemplate } = baseMatter;
        void _omittedMatterId;

        const mattersBeforeConv = (
          await freshMatterRepo.listAllMattersUnfiltered(ctx)
        ).length;
        const tasksBeforeConv = (await freshTwRepo.listAllTasksUnfiltered(ctx))
          .length;

        // Fail when the matter creation audit entry is staged/appended at the end of saveMatterRecord
        setAuditAdapterFailureHookForTesting(({ entries }) => {
          if (entries.some((e) => e.recordType === 'matter')) {
            throw new Error('SIMULATED_S017A_CONVERSION_MATTER_AUDIT_FAILURE');
          }
        });

        await expect(
          saveMatterRecord(
            {
              ...matterTemplate,
              matterNumber: 'DRAFT',
              openedAt: null,
              fieldValues: {},
              title: 'Atomic Conversion Matter That Fails',
              sourceEnquiryId: convEnqId,
              agreedFeeCapGbp: 5000,
              feeEstimateGbp: 5000,
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        ).rejects.toThrow(/SIMULATED_S017A_CONVERSION_MATTER_AUDIT_FAILURE/);
        setAuditAdapterFailureHookForTesting(null);

        // Verify on fresh connection that matter, enquiry conversion state, and automatic tasks all rolled back together
        expect(
          (await freshMatterRepo.listAllMattersUnfiltered(ctx)).length,
        ).toBe(mattersBeforeConv);
        expect((await freshTwRepo.listAllTasksUnfiltered(ctx)).length).toBe(
          tasksBeforeConv,
        );
        const freshEnqAfterRollback = await freshIqRepo.getEnquiryById(
          ctx,
          convEnqId,
          { includeRestricted: true },
        );
        expect(freshEnqAfterRollback?.status).not.toBe('Converted');
        expect(freshEnqAfterRollback?.convertedMatterId).toBeNull();

        // 6. anonymiseExpiredEnquiries same-transaction atomicity
        const expiredEnq = makeSampleEnquiry('ENQ-EXPIRED-ATOM-1', {
          status: 'Declined',
          closedAt: '2020-01-01T10:00:00.000Z',
          retentionUntil: '2022-01-01',
          firstName: 'SensitiveFirst',
          lastName: 'SensitiveLast',
          email: 'sensitive@invented.example',
        });
        await getIntakeQuoteRepository().putEnquiry(ctx, expiredEnq);

        // Repository-level atomic rollback when audit entry is invalid
        await expect(
          freshIqRepo.anonymiseExpiredEnquiries(ctx, {
            asOfIso: '2026-11-11T12:00:00.000Z',
            byId: 'P-000001',
            specificEnquiryId: expiredEnq.id,
            auditEntries: [
              {
                recordType: 'enquiry',
                recordId: '',
                action: 'anonymise',
                field: 'Personal data',
                oldValue: 'Retained',
                newValue: 'Anonymised',
                byId: 'P-000001',
              },
            ],
          }),
        ).rejects.toThrow();

        const stillUnanonymised = await freshIqRepo.getEnquiryById(
          ctx,
          expiredEnq.id,
          { includeRestricted: true },
        );
        expect(stillUnanonymised?.firstName).toBe('SensitiveFirst');
        expect(stillUnanonymised?.anonymisedAt).toBeNull();

        // Positive control: anonymiseExpiredEnquiries commits enquiry + audit_entries together
        const anonResult = await freshIqRepo.anonymiseExpiredEnquiries(ctx, {
          asOfIso: '2026-11-11T12:00:00.000Z',
          byId: 'P-000001',
          specificEnquiryId: expiredEnq.id,
        });
        expect(anonResult.map((e) => e.id)).toEqual([expiredEnq.id]);
        const afterAnon = await freshIqRepo.getEnquiryById(ctx, expiredEnq.id, {
          includeRestricted: true,
        });
        expect(afterAnon?.firstName).toBe('Anonymised');
        expect(afterAnon?.lastName).toBe('Enquirer');
        expect(afterAnon?.anonymisedAt).toBe('2026-11-11T12:00:00.000Z');
        const anonAudit = await freshAuditRepo.listAuditEntriesForRecord(
          ctx,
          'enquiry',
          expiredEnq.id,
        );
        expect(
          anonAudit.some((a) => a.field === 'Privacy retention anonymisation'),
        ).toBe(true);
      });
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await freshPoolMgr.closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('Merge repointing in one PostgreSQL transaction: executeMergeInTransaction repoints enquiries, quotes, tasks, notifications and recently_viewed atomically and rolls back all tables on failure', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [{ tenantId: 'tenant-alpha', environment: 'test' }],
    });
    const ctx = makeTenantCtx('tenant-alpha', 'P-ALPHA-1');

    const partyRepo = new TenantPartyRepository();
    const matterRepo = new TenantMatterRepository();
    const iqRepo = new TenantIntakeQuoteRepository();
    const twRepo = new TenantTaskWorkflowRepository();

    await twRepo.clearTenantData(ctx);
    await iqRepo.clearTenantData(ctx);
    await matterRepo.clearTenantData(ctx, { resetMatterNumberSequences: true });
    await partyRepo.clearTenantData(ctx);

    const nowIso = '2026-11-11T11:00:00.000Z';
    const survivorPerson: TenantPersonRecord = {
      id: 'P-SURVIVOR',
      recordType: 'person',
      recordOwnerId: 'P-ALPHA-1',
      recordStatusId: 'record_status.active',
      createdById: 'P-ALPHA-1',
      createdAt: nowIso,
      updatedById: 'P-ALPHA-1',
      updatedAt: nowIso,
      sourceId: null,
      lastVerifiedAt: null,
      tags: [],
      duplicateStatusId: 'duplicate_status.unique',
      notDuplicateOf: [],
      possibleMatchIds: ['P-MERGED'],
      mergedIntoId: null,
      lastInteractionAt: null,
      customFields: {},
      titleId: null,
      firstName: 'Arthur',
      middleNames: '',
      surname: 'Pendleton',
      preferredName: '',
      dateOfBirth: null,
      otherNames: [],
      jobTitle: 'Director',
      emails: [
        {
          id: 'em-surv',
          address: 'arthur@pendleton.example',
          typeId: 'email_type.work',
          isPrimary: true,
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
      relationshipRoleIds: [],
      originId: null,
      firstKnownAt: null,
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
      isEmployee: false,
      employeeRoleId: null,
      departmentId: null,
      appRole: null,
    };
    const mergedPerson: TenantPersonRecord = {
      ...survivorPerson,
      id: 'P-MERGED',
      possibleMatchIds: ['P-SURVIVOR'],
      emails: [
        {
          id: 'em-mrg',
          address: 'a.pendleton@duplicate.example',
          typeId: 'email_type.personal',
          isPrimary: true,
        },
      ],
    };
    await partyRepo.putPeople(ctx, [survivorPerson, mergedPerson]);

    const enqToRepoint = makeSampleEnquiry('ENQ-MERGE-1', {
      linkedPersonId: 'P-MERGED',
      referrerPersonId: 'P-MERGED',
      conflictSnapshot: {
        recordedAt: nowIso,
        recordedById: 'P-ALPHA-1',
        searchedInput: {
          firstName: 'Arthur',
          lastName: 'Pendleton',
          callingOnBehalfOf: '',
          otherPartiesNamed: '',
          email: 'eleanor.vance@invented.example',
          phone: '020 7946 0101',
          postcode: 'EC1A 1BB',
          addressLine1: '10 Invented Way',
          addressLine2: '',
        },
        matchCount: 1,
        highestSeverity: 'medium',
        conflictStatus: 'Check',
        conflicts: [
          {
            recordType: 'person',
            recordId: 'P-MERGED',
            name: 'Arthur Pendleton',
            recordLabel: 'Arthur Pendleton',
            queryTerm: 'Pendleton',
            reason: 'Duplicate person',
            matchedFields: ['surname'],
            severity: 'medium',
            strength: 70,
            blocking: false,
            href: '/people/P-MERGED',
          },
        ],
        knownPeople: [{ id: 'P-MERGED', formattedReasons: 'Arthur Pendleton' }],
        knownOrganisations: [],
      },
    });
    const quoteToRepoint = makeSampleQuote('QTE-MERGE-1', {
      clientType: 'existing',
      linkedPersonId: 'P-MERGED',
    });
    const taskToRepoint = makeSampleTask('TSK-MERGE-1', {
      linkedRecords: [
        { recordType: 'person', recordId: 'P-MERGED' },
        { recordType: 'person', recordId: 'P-SURVIVOR' },
      ],
    });
    const ntfToRepoint: TenantNotificationRecord = {
      id: 'NTF-MERGE-1',
      recipientId: 'P-ALPHA-1',
      kind: 'task_assigned',
      title: 'Review person P-MERGED',
      detail: 'Merge candidate',
      href: '/people/P-MERGED',
      recordId: 'P-MERGED',
      createdAt: nowIso,
      read: false,
    };

    await iqRepo.putEnquiry(ctx, enqToRepoint);
    await iqRepo.putQuote(ctx, quoteToRepoint);
    await twRepo.putTask(ctx, taskToRepoint);
    await twRepo.putNotification(ctx, ntfToRepoint);
    await twRepo.putRecentlyViewedForUser(ctx, 'P-ALPHA-1', [
      'P-MERGED',
      'P-SURVIVOR',
    ]);

    // 1. Forced audit failure rolls back the entire merge transaction across all tables
    await expect(
      partyRepo.executeMergeInTransaction(ctx, {
        recordType: 'person',
        survivor: {
          ...survivorPerson,
          possibleMatchIds: [],
        },
        merged: {
          ...mergedPerson,
          mergedIntoId: 'P-SURVIVOR',
          recordStatusId: 'record_status.merged',
          duplicateStatusId: 'duplicate_status.merged',
          possibleMatchIds: [],
        },
        mergeHistory: {
          id: 'MRG-ROLLBACK-1',
          recordType: 'person',
          survivorId: 'P-SURVIVOR',
          mergedId: 'P-MERGED',
          mergedLabel: 'Arthur Pendleton',
          byId: 'P-ALPHA-1',
          at: nowIso,
          fieldsTaken: ['Emails'],
        },
        auditEntries: [
          {
            id: 'AU-DUP-MERGE-FAIL',
            recordType: 'person',
            recordId: 'P-SURVIVOR',
            action: 'merge',
            field: 'Merged record',
            oldValue: 'P-MERGED',
            newValue: 'P-SURVIVOR',
            byId: 'P-ALPHA-1',
          },
          {
            id: 'AU-DUP-MERGE-FAIL',
            recordType: 'person',
            recordId: 'P-SURVIVOR',
            action: 'merge',
            field: 'Duplicate audit id triggers rollback after repoints',
            oldValue: 'P-MERGED',
            newValue: 'P-SURVIVOR',
            byId: 'P-ALPHA-1',
          },
        ],
      }),
    ).rejects.toThrow();

    expect(
      (await iqRepo.getEnquiryById(ctx, 'ENQ-MERGE-1'))?.linkedPersonId,
    ).toBe('P-MERGED');
    expect(
      (await iqRepo.getQuoteById(ctx, 'QTE-MERGE-1'))?.linkedPersonId,
    ).toBe('P-MERGED');
    expect(
      (await twRepo.getTaskById(ctx, 'TSK-MERGE-1'))?.linkedRecords.map(
        (lr) => lr.recordId,
      ),
    ).toEqual(['P-MERGED', 'P-SURVIVOR']);
    expect(await twRepo.getRecentlyViewedForUser(ctx, 'P-ALPHA-1')).toEqual([
      'P-MERGED',
      'P-SURVIVOR',
    ]);

    // 2. Positive control: valid merge commits all repointed S0-17a tables + audit_entries atomically
    await partyRepo.executeMergeInTransaction(ctx, {
      recordType: 'person',
      survivor: {
        ...survivorPerson,
        possibleMatchIds: [],
      },
      merged: {
        ...mergedPerson,
        mergedIntoId: 'P-SURVIVOR',
        recordStatusId: 'record_status.merged',
        duplicateStatusId: 'duplicate_status.merged',
        possibleMatchIds: [],
      },
      mergeHistory: {
        id: 'MRG-OK-1',
        recordType: 'person',
        survivorId: 'P-SURVIVOR',
        mergedId: 'P-MERGED',
        mergedLabel: 'Arthur Pendleton',
        byId: 'P-ALPHA-1',
        at: nowIso,
        fieldsTaken: ['Emails'],
      },
      auditEntries: [
        {
          recordType: 'person',
          recordId: 'P-SURVIVOR',
          action: 'merge',
          field: 'Merged P-MERGED into P-SURVIVOR',
          oldValue: 'P-MERGED',
          newValue: 'P-SURVIVOR',
          byId: 'P-ALPHA-1',
        },
      ],
    });

    const repointedEnq = await iqRepo.getEnquiryById(ctx, 'ENQ-MERGE-1');
    expect(repointedEnq?.linkedPersonId).toBe('P-SURVIVOR');
    expect(repointedEnq?.referrerPersonId).toBe('P-SURVIVOR');
    expect(repointedEnq?.conflictSnapshot?.conflicts?.[0]?.recordId).toBe(
      'P-SURVIVOR',
    );
    expect(repointedEnq?.conflictSnapshot?.conflicts?.[0]?.href).toBe(
      '/people/P-SURVIVOR',
    );
    expect(repointedEnq?.conflictSnapshot?.knownPeople?.[0]?.id).toBe(
      'P-SURVIVOR',
    );

    const repointedQuote = await iqRepo.getQuoteById(ctx, 'QTE-MERGE-1');
    expect(repointedQuote?.linkedPersonId).toBe('P-SURVIVOR');

    // Task linked_records de-duplicated ('person:P-MERGED' + 'person:P-SURVIVOR' -> single 'person:P-SURVIVOR')
    const repointedTask = await twRepo.getTaskById(ctx, 'TSK-MERGE-1');
    expect(repointedTask?.linkedRecords).toEqual([
      { recordType: 'person', recordId: 'P-SURVIVOR' },
    ]);

    const repointedNotifs = await twRepo.listNotificationsForUser(
      ctx,
      'P-ALPHA-1',
      { includeRestricted: true },
    );
    expect(repointedNotifs[0]?.recordId).toBe('P-SURVIVOR');
    expect(repointedNotifs[0]?.href).toBe('/people/P-SURVIVOR');

    // Recently viewed de-duplicated to ['P-SURVIVOR']
    expect(
      await twRepo.getRecentlyViewedForUser(ctx, 'P-ALPHA-1', {
        includeRestricted: true,
      }),
    ).toEqual(['P-SURVIVOR']);
  });

  it('Import idempotency: importFirmStoreModulesToPostgres([parties, matters, intake, quotes, tasks]) run twice produces identical row counts and sequences continue past imported high-water marks', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = testDataResetContext();
    const seedStore = loadCommittedSeedStore();

    const run1 = await importFirmStoreModulesToPostgres({
      ctx,
      store: seedStore,
      modules: ['parties', 'matters', 'intake', 'quotes', 'tasks'],
    });
    const run2 = await importFirmStoreModulesToPostgres({
      ctx,
      store: seedStore,
      modules: ['parties', 'matters', 'intake', 'quotes', 'tasks'],
    });

    expect(run2).toEqual(run1);
    expect(run1.counts.enquiries).toBe(seedStore.enquiries.length);
    expect(run1.counts.quotes).toBe(seedStore.quotes.length);
    expect(run1.counts.tasks).toBe(seedStore.tasks.length);
    expect(run1.counts.notifications).toBe(seedStore.notifications.length);
    expect(run1.counts.signOffs).toBe(seedStore.signOffs.length);
    expect(run1.counts.recentlyViewed).toBe(
      Object.keys(seedStore.recentlyViewed ?? {}).length,
    );

    const nextEnqId = await getIntakeQuoteRepository().allocateNextEnquiryId(ctx);
    expect(seedStore.enquiries.some((e) => e.id === nextEnqId)).toBe(false);

    const nextQteRef =
      await getIntakeQuoteRepository().allocateNextQuoteReference(
        ctx,
        new Date().getFullYear(),
      );
    expect(seedStore.quotes.some((q) => q.reference === nextQteRef)).toBe(false);

    const nextTaskId = await getTaskWorkflowRepository().allocateNextTaskId(ctx);
    expect(seedStore.tasks.some((t) => t.id === nextTaskId)).toBe(false);

    const nextNtfId =
      await getTaskWorkflowRepository().allocateNextNotificationId(ctx);
    expect(seedStore.notifications.some((n) => n.id === nextNtfId)).toBe(false);

    const nextSoId =
      await getTaskWorkflowRepository().allocateNextSignOffId(ctx);
    expect(seedStore.signOffs.some((s) => s.id === nextSoId)).toBe(false);

    await getGlobalTenantPostgresPoolManager().closeAllPools();
  });

  it('R465: Cold-start / new-replica survival preserves enquiries, quotes, and tasks written via services across vi.resetModules() without running clearTenantData', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const carysSession = makeActorSession('P-000001');

    // 1. Write an enquiry, quote, and task through the services
    const savedEnqRes = await runWithActiveActorSession(carysSession, () =>
      saveEnquiryRecord(
        {
          takenById: 'P-000001',
          channelId: 'enquiry_channel.phone',
          firstName: 'ColdStart',
          lastName: 'EnquirySurvivor',
          callingOnBehalfOf: '',
          linkedOrganisationId: 'O-000001',
          email: 'coldstart.enquiry@invented.example',
          phone: '020 7946 0465',
          preferredContactMethodId: 'contact_method.email',
          bestTimeToCall: 'Morning',
          address: null,
          practiceAreaId: 'practice_area.commercial_property',
          workTypeSubcategoryId: null,
          summary: 'R465 Cold Start Enquiry Survival Summary',
          notes: 'R465 Cold Start Enquiry Survival Notes.',
          otherPartiesNamed: '',
          urgencyId: 'urgency.normal',
          keyDate: null,
          keyDateLabel: '',
          sourceId: 'record_source.website',
          referrerPersonId: null,
          assignedTeamId: 'TM-000001',
          assignedToId: 'P-000001',
          privacyNoticeGiven: true,
          customFields: {},
        },
        { byId: 'P-000001' },
      ),
    );
    expect(savedEnqRes.errors).toBeUndefined();
    const enquiryId = savedEnqRes.enquiry!.id;

    const savedQuoteRes = await runWithActiveActorSession(carysSession, () =>
      saveQuoteRecord(
        {
          clientType: 'prospect',
          prospectName: 'R465 ColdStart Quote Prospect',
          prospectEmail: 'coldstart.quote@invented.example',
          practiceAreaId: 'practice_area.commercial_property',
          scope: 'R465 Cold Start Quote Scope',
          feeBasis: 'Fixed fee',
          feeAmountExVat: 2400,
          disbursements: [],
          feeEarnerId: 'P-000001',
        },
        { byId: 'P-000001', markAsSent: true },
      ),
    );
    expect(savedQuoteRes.error).toBeUndefined();
    const quoteId = savedQuoteRes.quote!.id;

    const savedTaskRes = await runWithActiveActorSession(carysSession, () =>
      saveTaskRecord(
        {
          title: 'R465 Cold Start Task Title',
          description: 'Task that must survive cold start',
          taskTypeId: 'task_type.general',
          priorityId: 'task_priority.normal',
          status: 'To do',
          dueAt: '2026-12-15',
          assignedPersonId: 'P-000001',
          assignedTeamId: 'TM-000001',
          linkedRecords: [{ recordType: 'enquiry', recordId: enquiryId }],
        },
        'P-000001',
      ),
    );
    expect(savedTaskRes.error).toBeUndefined();
    const taskId = savedTaskRes.task!.id;

    // 2. Simulate a restart: vi.resetModules(), clear every __oneSquared* global, unset ONESQUARED_RUNTIME_STORE_PATH
    const savedRuntimeStoreEnv = process.env.ONESQUARED_RUNTIME_STORE_PATH;
    await getGlobalTenantPostgresPoolManager().closeAllPools();

    try {
      delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      vi.resetModules();
      for (const key of Object.keys(globalThis)) {
        if (key.startsWith('__oneSquared')) {
          delete (globalThis as Record<string, unknown>)[key];
        }
      }

      const freshCore = await import('@platform/core');
      const clearIntakeSpy = vi.spyOn(
        freshCore.TenantIntakeQuoteRepository.prototype,
        'clearTenantData',
      );
      const clearTaskSpy = vi.spyOn(
        freshCore.TenantTaskWorkflowRepository.prototype,
        'clearTenantData',
      );
      const clearPartySpy = vi.spyOn(
        freshCore.TenantPartyRepository.prototype,
        'clearTenantData',
      );
      const clearMatterSpy = vi.spyOn(
        freshCore.TenantMatterRepository.prototype,
        'clearTenantData',
      );

      const freshEntraAuth = await import('@/server/entraAuth');
      const freshRbacRuntime = await import('@/server/rbacRuntime');
      const freshServices = await import('@/server/services');

      const freshCookie = freshEntraAuth.createSignedEntraSessionCookie(
        carysSession.verifiedSession,
      );
      const freshVerified =
        freshEntraAuth.verifySignedEntraSessionCookie(freshCookie)!;
      const freshCarysSession = {
        ...carysSession,
        verifiedSession: freshVerified,
      };

      // 3. Read all three back through the services on the cold-started module graph
      const snapshotAfterColdStart = await freshRbacRuntime.runWithActiveActorSession(
        freshCarysSession,
        () => freshServices.getAppSnapshot('P-000001'),
      );

      // 4. Assert enquiry, quote, and task are unchanged and no clearTenantData ran
      const readBackEnq = snapshotAfterColdStart.enquiries.find(
        (e) => e.id === enquiryId,
      );
      const readBackQuote = snapshotAfterColdStart.quotes.find(
        (q) => q.id === quoteId,
      );
      const readBackTask = snapshotAfterColdStart.tasks.find(
        (t) => t.id === taskId,
      );
      expect(readBackEnq).toBeDefined();
      expect(readBackEnq?.firstName).toBe('ColdStart');
      expect(readBackEnq?.lastName).toBe('EnquirySurvivor');
      expect(readBackQuote).toBeDefined();
      expect(readBackQuote?.prospectName).toBe('R465 ColdStart Quote Prospect');
      expect(readBackTask).toBeDefined();
      expect(readBackTask?.title).toBe('R465 Cold Start Task Title');

      expect(clearIntakeSpy).not.toHaveBeenCalled();
      expect(clearTaskSpy).not.toHaveBeenCalled();
      expect(clearPartySpy).not.toHaveBeenCalled();
      expect(clearMatterSpy).not.toHaveBeenCalled();

      await freshCore.getGlobalTenantPostgresPoolManager().closeAllPools();
    } finally {
      if (savedRuntimeStoreEnv !== undefined) {
        process.env.ONESQUARED_RUNTIME_STORE_PATH = savedRuntimeStoreEnv;
      } else {
        delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
      }
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R466: Two isolated module instances (replicas) sharing one database see Replica A new enquiry, quote, and task straight away without process-level cache', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const carysSession = makeActorSession('P-000001');

    // Load Replica A and Replica B from separate vi.resetModules() module graphs
    vi.resetModules();
    const replicaAEntra = await import('@/server/entraAuth');
    const replicaARbac = await import('@/server/rbacRuntime');
    const replicaAServices = await import('@/server/services');
    const replicaACore = await import('@platform/core');
    const replicaASession = {
      ...carysSession,
      verifiedSession: replicaAEntra.verifySignedEntraSessionCookie(
        replicaAEntra.createSignedEntraSessionCookie(carysSession.verifiedSession),
      )!,
    };

    vi.resetModules();
    for (const key of Object.keys(globalThis)) {
      if (key.startsWith('__oneSquared')) {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
    const replicaBEntra = await import('@/server/entraAuth');
    const replicaBRbac = await import('@/server/rbacRuntime');
    const replicaBServices = await import('@/server/services');
    const replicaBCore = await import('@platform/core');
    const replicaBSession = {
      ...carysSession,
      verifiedSession: replicaBEntra.verifySignedEntraSessionCookie(
        replicaBEntra.createSignedEntraSessionCookie(carysSession.verifiedSession),
      )!,
    };

    try {
      // 1. Replica B reads initial snapshot before Replica A writes
      const snapBInitial = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () => replicaBServices.getAppSnapshot('P-000001'),
      );
      const initialEnqCount = snapBInitial.enquiries.length;
      const initialQuoteCount = snapBInitial.quotes.length;
      const initialTaskCount = snapBInitial.tasks.length;

      // 2. Replica A creates a new enquiry, a new quote, and a new task
      const newEnqFromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.saveEnquiryRecord(
            {
              takenById: 'P-000001',
              channelId: 'enquiry_channel.phone',
              firstName: 'ReplicaA',
              lastName: 'ImmediateEnquiry',
              callingOnBehalfOf: '',
              linkedOrganisationId: 'O-000001',
              email: 'replicaa.enquiry@invented.example',
              phone: '020 7946 0466',
              preferredContactMethodId: 'contact_method.email',
              bestTimeToCall: 'Afternoon',
              address: null,
              practiceAreaId: 'practice_area.commercial_property',
              workTypeSubcategoryId: null,
              summary: 'Replica A newly created enquiry',
              notes: 'Replica A newly created enquiry notes.',
              otherPartiesNamed: '',
              urgencyId: 'urgency.normal',
              keyDate: null,
              keyDateLabel: '',
              sourceId: 'record_source.website',
              referrerPersonId: null,
              assignedTeamId: 'TM-000001',
              assignedToId: 'P-000001',
              privacyNoticeGiven: true,
              customFields: {},
            },
            { byId: 'P-000001' },
          ),
      );
      expect(newEnqFromA.errors).toBeUndefined();
      const newEnqId = newEnqFromA.enquiry!.id;

      const newQuoteFromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.saveQuoteRecord(
            {
              clientType: 'prospect',
              prospectName: 'Replica A Immediate Prospect',
              prospectEmail: 'replicaa.quote@invented.example',
              practiceAreaId: 'practice_area.commercial_property',
              scope: 'Replica A quote scope',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 3200,
              disbursements: [],
              feeEarnerId: 'P-000001',
            },
            { byId: 'P-000001', markAsSent: true },
          ),
      );
      expect(newQuoteFromA.error).toBeUndefined();
      const newQuoteId = newQuoteFromA.quote!.id;

      const newTaskFromA = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () =>
          replicaAServices.saveTaskRecord(
            {
              title: 'Replica A Immediate Task',
              description: 'Created on Replica A',
              taskTypeId: 'task_type.general',
              priorityId: 'task_priority.normal',
              status: 'To do',
              dueAt: '2026-12-20',
              assignedPersonId: 'P-000001',
              assignedTeamId: 'TM-000001',
              linkedRecords: [],
            },
            'P-000001',
          ),
      );
      expect(newTaskFromA.error).toBeUndefined();
      const newTaskId = newTaskFromA.task!.id;

      // 3. Instance B sees Instance A's new enquiry, quote, and task straight away
      const snapBAfterA = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () => replicaBServices.getAppSnapshot('P-000001'),
      );
      expect(snapBAfterA.enquiries.some((e) => e.id === newEnqId)).toBe(true);
      expect(snapBAfterA.quotes.some((q) => q.id === newQuoteId)).toBe(true);
      expect(snapBAfterA.tasks.some((t) => t.id === newTaskId)).toBe(true);
      expect(snapBAfterA.enquiries.length).toBeGreaterThan(initialEnqCount);
      expect(snapBAfterA.quotes.length).toBe(initialQuoteCount + 1);
      expect(snapBAfterA.tasks.length).toBeGreaterThan(initialTaskCount);

      // 4. Saving an unrelated enquiry on Replica B does not overwrite or lose Replica A's new enquiry, quote, or task
      const existingEnqInB = snapBInitial.enquiries.find(
        (e) => e.id === 'ENQ-000001',
      )!;
      const updateEnq1FromB = await replicaBRbac.runWithActiveActorSession(
        replicaBSession,
        () =>
          replicaBServices.saveEnquiryRecord(
            {
              ...existingEnqInB,
              summary: 'Replica B Updated ENQ-000001 Summary',
            },
            { id: 'ENQ-000001', byId: 'P-000001' },
          ),
      );
      expect(updateEnq1FromB.errors).toBeUndefined();

      const snapAVerify = await replicaARbac.runWithActiveActorSession(
        replicaASession,
        () => replicaAServices.getAppSnapshot('P-000001'),
      );
      expect(snapAVerify.enquiries.some((e) => e.id === newEnqId)).toBe(true);
      expect(snapAVerify.quotes.some((q) => q.id === newQuoteId)).toBe(true);
      expect(snapAVerify.tasks.some((t) => t.id === newTaskId)).toBe(true);
      expect(
        snapAVerify.enquiries.find((e) => e.id === 'ENQ-000001')?.summary,
      ).toBe('Replica B Updated ENQ-000001 Summary');
    } finally {
      await replicaACore.getGlobalTenantPostgresPoolManager().closeAllPools();
      await replicaBCore.getGlobalTenantPostgresPoolManager().closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('R467: Services-level two-tenant test in one process (Model B configuration) interleaves enquiry, quote, and task saves and reads across Tenant A and Tenant B with zero cross-tenant leakage', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
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
    const validatedConfigA = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(rawConfigB, {});
    const validatedConfigB = getActiveTenantConfiguration();
    setActiveTenantConfigForTesting(null);

    const sessionA = makeActorSession(
      'P-000001',
      ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
      'tenant-a',
    );
    const sessionB = makeActorSession(
      'P-000001',
      ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
      'tenant-b',
    );
    const ctxA = makeTenantCtx('tenant-a', 'P-000001');
    const ctxB = makeTenantCtx('tenant-b', 'P-000001');
    const seedStore = loadCommittedSeedStore();

    try {
      await getTaskWorkflowRepository().clearTenantData(ctxA);
      await getIntakeQuoteRepository().clearTenantData(ctxA);
      await getMatterRepository().clearTenantData(ctxA);
      await getPartyRepository().clearTenantData(ctxA);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxA);
      await importFirmStoreModulesToPostgres({
        ctx: ctxA,
        tenantConfig: validatedConfigA,
        store: seedStore,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks'],
      });

      await getTaskWorkflowRepository().clearTenantData(ctxB);
      await getIntakeQuoteRepository().clearTenantData(ctxB);
      await getMatterRepository().clearTenantData(ctxB);
      await getPartyRepository().clearTenantData(ctxB);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxB);
      await importFirmStoreModulesToPostgres({
        ctx: ctxB,
        tenantConfig: validatedConfigB,
        store: seedStore,
        modules: ['parties', 'matters', 'intake', 'quotes', 'tasks'],
      });

      // Step 1: Tenant A saves an enquiry, quote, and task via services
      setActiveTenantConfigForTesting(rawConfigA, {});
      const enqARes = await runWithActiveActorSession(sessionA, () =>
        saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'TenantAOnlyEnqFirst',
            lastName: 'TenantAOnlyEnqLast',
            callingOnBehalfOf: '',
            linkedOrganisationId: 'O-000001',
            email: 'tenanta.enq@invented.example',
            phone: '020 7946 0111',
            preferredContactMethodId: 'contact_method.email',
            bestTimeToCall: 'Morning',
            address: null,
            practiceAreaId: 'practice_area.commercial_property',
            workTypeSubcategoryId: null,
            summary: 'Tenant A Exclusive Enquiry Summary',
            notes: 'Tenant A Exclusive Enquiry Notes.',
            otherPartiesNamed: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000001',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000001' },
        ),
      );
      expect(enqARes.errors).toBeUndefined();

      const quoteARes = await runWithActiveActorSession(sessionA, () =>
        saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Tenant A Exclusive Quote Prospect',
            prospectEmail: 'tenanta.quote@invented.example',
            practiceAreaId: 'practice_area.commercial_property',
            scope: 'Tenant A Exclusive Quote Scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 4100,
            disbursements: [],
            feeEarnerId: 'P-000001',
          },
          { byId: 'P-000001', markAsSent: true },
        ),
      );
      expect(quoteARes.error).toBeUndefined();

      const taskARes = await runWithActiveActorSession(sessionA, () =>
        saveTaskRecord(
          {
            title: 'Tenant A Exclusive Task Title',
            description: 'Tenant A Exclusive Task Description',
            taskTypeId: 'task_type.general',
            priorityId: 'task_priority.normal',
            status: 'To do',
            dueAt: '2026-12-22',
            assignedPersonId: 'P-000001',
            assignedTeamId: 'TM-000001',
            linkedRecords: [],
          },
          'P-000001',
        ),
      );
      expect(taskARes.error).toBeUndefined();

      // Step 2: Interleave Tenant B saves in the same process
      setActiveTenantConfigForTesting(rawConfigB, {});
      const enqBRes = await runWithActiveActorSession(sessionB, () =>
        saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'TenantBOnlyEnqFirst',
            lastName: 'TenantBOnlyEnqLast',
            callingOnBehalfOf: '',
            linkedOrganisationId: 'O-000001',
            email: 'tenantb.enq@invented.example',
            phone: '020 7946 0222',
            preferredContactMethodId: 'contact_method.email',
            bestTimeToCall: 'Afternoon',
            address: null,
            practiceAreaId: 'practice_area.commercial_property',
            workTypeSubcategoryId: null,
            summary: 'Tenant B Exclusive Enquiry Summary',
            notes: 'Tenant B Exclusive Enquiry Notes.',
            otherPartiesNamed: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000001',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000001' },
        ),
      );
      expect(enqBRes.errors).toBeUndefined();

      const quoteBRes = await runWithActiveActorSession(sessionB, () =>
        saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Tenant B Exclusive Quote Prospect',
            prospectEmail: 'tenantb.quote@invented.example',
            practiceAreaId: 'practice_area.commercial_property',
            scope: 'Tenant B Exclusive Quote Scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 5200,
            disbursements: [],
            feeEarnerId: 'P-000001',
          },
          { byId: 'P-000001', markAsSent: true },
        ),
      );
      expect(quoteBRes.error).toBeUndefined();

      const taskBRes = await runWithActiveActorSession(sessionB, () =>
        saveTaskRecord(
          {
            title: 'Tenant B Exclusive Task Title',
            description: 'Tenant B Exclusive Task Description',
            taskTypeId: 'task_type.general',
            priorityId: 'task_priority.normal',
            status: 'To do',
            dueAt: '2026-12-23',
            assignedPersonId: 'P-000001',
            assignedTeamId: 'TM-000001',
            linkedRecords: [],
          },
          'P-000001',
        ),
      );
      expect(taskBRes.error).toBeUndefined();

      // Step 3: Read Tenant A snapshot & audit and assert positive and negative controls
      setActiveTenantConfigForTesting(rawConfigA, {});
      const snapA = await runWithActiveActorSession(sessionA, () =>
        getAppSnapshot('P-000001'),
      );
      const auditA = await runWithActiveActorSession(sessionA, () =>
        listFirmAuditEntriesPage('P-000001', { limit: 200 }),
      );

      expect(
        snapA.enquiries.some((e) => e.firstName === 'TenantAOnlyEnqFirst'),
      ).toBe(true);
      expect(
        snapA.quotes.some(
          (q) => q.prospectName === 'Tenant A Exclusive Quote Prospect',
        ),
      ).toBe(true);
      expect(
        snapA.tasks.some((t) => t.title === 'Tenant A Exclusive Task Title'),
      ).toBe(true);
      expect(
        auditA.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant A Exclusive'),
        ),
      ).toBe(true);

      expect(
        snapA.enquiries.some((e) => e.firstName === 'TenantBOnlyEnqFirst'),
      ).toBe(false);
      expect(
        snapA.quotes.some(
          (q) => q.prospectName === 'Tenant B Exclusive Quote Prospect',
        ),
      ).toBe(false);
      expect(
        snapA.tasks.some((t) => t.title === 'Tenant B Exclusive Task Title'),
      ).toBe(false);
      expect(
        auditA.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant B Exclusive'),
        ),
      ).toBe(false);

      // Step 4: Read Tenant B snapshot & audit and assert positive and negative controls
      setActiveTenantConfigForTesting(rawConfigB, {});
      const snapB = await runWithActiveActorSession(sessionB, () =>
        getAppSnapshot('P-000001'),
      );
      const auditB = await runWithActiveActorSession(sessionB, () =>
        listFirmAuditEntriesPage('P-000001', { limit: 200 }),
      );

      expect(
        snapB.enquiries.some((e) => e.firstName === 'TenantBOnlyEnqFirst'),
      ).toBe(true);
      expect(
        snapB.quotes.some(
          (q) => q.prospectName === 'Tenant B Exclusive Quote Prospect',
        ),
      ).toBe(true);
      expect(
        snapB.tasks.some((t) => t.title === 'Tenant B Exclusive Task Title'),
      ).toBe(true);
      expect(
        auditB.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant B Exclusive'),
        ),
      ).toBe(true);

      expect(
        snapB.enquiries.some((e) => e.firstName === 'TenantAOnlyEnqFirst'),
      ).toBe(false);
      expect(
        snapB.quotes.some(
          (q) => q.prospectName === 'Tenant A Exclusive Quote Prospect',
        ),
      ).toBe(false);
      expect(
        snapB.tasks.some((t) => t.title === 'Tenant A Exclusive Task Title'),
      ).toBe(false);
      expect(
        auditB.entries.some((a) =>
          String(a.newValue ?? '').includes('Tenant A Exclusive'),
        ),
      ).toBe(false);
    } finally {
      setActiveTenantConfigForTesting(null);
      await getTaskWorkflowRepository().clearTenantData(ctxA);
      await getIntakeQuoteRepository().clearTenantData(ctxA);
      await getMatterRepository().clearTenantData(ctxA);
      await getPartyRepository().clearTenantData(ctxA);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxA);
      await getTaskWorkflowRepository().clearTenantData(ctxB);
      await getIntakeQuoteRepository().clearTenantData(ctxB);
      await getMatterRepository().clearTenantData(ctxB);
      await getPartyRepository().clearTenantData(ctxB);
      await new TenantAuditRepository().resetNonLiveAuditLog(ctxB);
      await resetAllDemoData('P-000001', testDataResetContext());
      await getGlobalTenantPostgresPoolManager().closeAllPools();
    }
  });
});
