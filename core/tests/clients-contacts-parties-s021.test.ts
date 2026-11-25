import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDirectMigrationClient,
  getGlobalTenantPostgresPoolManager,
  resolveTenantFromVerifiedToken,
  TenantDocumentRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantPostgresPoolManager,
  TenantTaskWorkflowRepository,
  type DocumentLinkRecord,
  type GeneratedDocumentRecord,
  type TenantContext,
  type TenantNotificationRecord,
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
import {
  mergeRecordsAction,
  saveMatterAction,
  savePersonAction,
} from '@/app/actions';
import {
  filterEmploymentForUser,
  findOpenMattersWherePersonIsParty,
} from '@/domain/employment';
import {
  computeEnquiryConflictSnapshot,
  runEnquiryConflictSearch,
} from '@/domain/enquiries';
import { resolveListValueId } from '@/domain/lists';
import {
  CONFLICT_SEARCHED_SOURCES,
  buildEffectiveConflictParties,
  redactRecordId,
  searchMatterConflicts,
} from '@/domain/matterConflicts';
import type {
  Enquiry,
  Matter,
  Organisation,
  Person,
  PersonOrganisationLink,
  Quote,
} from '@/domain/types';
import { createCleanDeploymentStore, createSeedStore } from '@/seed/seedStoreBuilder';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { getDocumentRepository } from '@/server/documentGenerationServices';
import {
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  addNoteToRecord,
  createOrUpdateLink,
  executeMerge,
  getEmployeeDetailsForUser,
  listAuditEntriesForRecord,
  prepareEnquiryConversion,
  prepareQuoteConversionRecord,
  resetAllDemoData,
  runMatterConflictSearchRecord,
  saveEnquiryRecord,
  saveMatterRecord,
  saveOrganisationRecord,
  savePersonRecord,
  saveQuoteRecord,
  saveTaskRecord,
} from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { testDataResetContext } from '@/test/testTenantContexts';

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
    correlationId: `corr-s021-${tenantId}-${actorId}`,
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
    email: `${personId.toLowerCase()}@invented-firm.example`,
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

function makeMinimalPerson(
  id: string,
  firstName: string,
  surname: string,
  overrides: Partial<Person> = {},
): Person {
  const seed = structuredClone(
    loadCommittedSeedStore().people.find((p) => !p.isEmployee && !p.mergedIntoId)!,
  );
  return {
    ...seed,
    id,
    recordType: 'person',
    firstName,
    middleNames: '',
    surname,
    preferredName: '',
    otherNames: [],
    isEmployee: false,
    employment: null,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    possibleMatchIds: [],
    notDuplicateOf: [],
    mergedIntoId: null,
    createdFromEnquiryId: null,
    relationshipRoleIds: ['person_role.client_contact'],
    ...overrides,
  };
}

function makeMinimalOrganisation(
  id: string,
  legalName: string,
  overrides: Partial<Organisation> = {},
): Organisation {
  const seed = structuredClone(
    loadCommittedSeedStore().organisations.find((o) => !o.mergedIntoId)!,
  );
  return {
    ...seed,
    id,
    recordType: 'organisation',
    legalName,
    otherNames: [],
    parentOrganisationId: null,
    relationshipTypeIds: ['organisation_relationship_type.client'],
    tags: [],
    possibleMatchIds: [],
    notDuplicateOf: [],
    mergedIntoId: null,
    createdFromEnquiryId: null,
    ...overrides,
  };
}

function stripMatterKeys<K extends keyof Matter>(
  template: Matter,
  keys: readonly K[],
): Omit<Matter, K> {
  const copy: Partial<Matter> = { ...template };
  for (const key of keys) {
    delete copy[key];
  }
  return copy as Omit<Matter, K>;
}

async function seedTenantDbFromStore(
  tenantId: string,
  displayName: string,
): Promise<{
  ctx: TenantContext;
  session: ReturnType<typeof makeActorSession>;
  rawConfig: Record<string, unknown>;
}> {
  const rawBaseConfig = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../client-not-a-law-firm/config/base.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const rawConfig: Record<string, unknown> = {
    ...structuredClone(rawBaseConfig),
    tenantId,
    displayName,
    hostingMode: 'multi_tenant',
  };
  setActiveTenantConfigForTesting(rawConfig, {});
  const validatedConfig = getActiveTenantConfiguration();
  setActiveTenantConfigForTesting(null);

  const ctx = makeTenantCtx(tenantId, 'P-000001');
  const session = makeActorSession(
    'P-000001',
    ['admin', 'managing_partner', 'partner', 'risk_compliance', 'fee_earner'],
    tenantId,
  );
  await importFirmStoreModulesToPostgres({
    ctx,
    tenantConfig: validatedConfig,
    store: loadCommittedSeedStore(),
    clearFirst: true,
  });
  return { ctx, session, rawConfig };
}

describe('S0-21: Canonical Contact Personas, Conflict Traversal, Merge Execution & Two-Tenant Isolation', () => {
  afterEach(() => {
    setTestEntraSessionOverride(undefined);
    setActiveTenantConfigForTesting(null);
  });

  it('1. Canonical PersonRecord multi-matter multi-capacity linking, stable person_role systemKeys across clean & demo seeds, and in-transaction private_client union', async () => {
    // 1a. Verify explicit systemKeys exist on both createSeedStore and createCleanDeploymentStore
    const demoStore = createSeedStore();
    const cleanStore = createCleanDeploymentStore();
    for (const [label, store] of [
      ['demo', demoStore],
      ['clean', cleanStore],
    ] as const) {
      const expectedPersonRoles = [
        ['client_contact', 'Client contact'],
        ['private_client', 'Private client'],
        ['referrer', 'Referrer'],
        ['introducer', 'Introducer'],
        ['supplier_contact', 'Supplier contact'],
        ['counsel', 'Counsel'],
        ['expert', 'Expert'],
        ['internal_colleague', 'Internal colleague'],
        ['professional_adviser', 'Professional adviser'],
        ['opposing_party', 'Opposing party'],
      ] as const;
      for (const [sysKey, expectedLabel] of expectedPersonRoles) {
        const val = store.values.find(
          (v) => v.listKey === 'person_role' && v.systemKey === sysKey,
        );
        expect(val, `${label} store missing person_role.${sysKey}`).toBeDefined();
        expect(resolveListValueId(store.values, 'person_role', sysKey, expectedLabel)).toBe(
          val!.id,
        );
      }

      const orgRelVal = store.values.find(
        (v) => v.listKey === 'organisation_relationship_type' && v.systemKey === 'client',
      );
      expect(orgRelVal, `${label} store missing organisation_relationship_type.client`).toBeDefined();
    }

    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const session = makeActorSession('P-000001');
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const freshPoolMgr = new TenantPostgresPoolManager();

    try {
      await runWithActiveActorSession(session, async () => {
        // 1b. Create one canonical Person initially as a Client contact
        const personSave = await savePersonRecord(
          {
            firstName: 'Meredith',
            surname: 'Penn',
            otherNames: [{ id: 'on-mp-1', name: 'Meredith Aldridge', typeId: null }],
            relationshipRoleIds: ['person_role.client_contact'],
            emails: [
              {
                id: 'em-mp-1',
                address: 'meredith.penn@calderstone-invented.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
              {
                id: 'em-mp-2',
                address: 'm.aldridge@personal-invented.example',
                typeId: 'email_type.personal',
                isPrimary: false,
                active: true,
              },
            ],
          },
          { byId: 'P-000001' },
        );
        expect(personSave.errors).toBeUndefined();
        const canonicalPersonId = personSave.person.id;

        const templateMatter = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        const matterBase = stripMatterKeys(templateMatter, [
          'id',
          'rowVersion',
          'additionalClientIds',
          'instructingContactId',
          'billingContactId',
          'referrerContactId',
          'parties',
          'engagementLetterStatus',
          'engagementLetterSignedAt',
        ]);

        // 1c. Link the same canonical Person as direct Client (CL) on Matter A -> unions person_role.private_client in-tx
        const matterARes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            title: 'S0-21 Matter A Direct Private Client',
            clientId: canonicalPersonId,
            parties: [],
            conflictCheckRecord: undefined,
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(matterARes.errors).toBeUndefined();
        const matterA = matterARes.matter!;

        const personAfterMatterA = (await partyRepo.getPersonById<Person>(
          ctx,
          canonicalPersonId,
        ))!;
        expect(personAfterMatterA.relationshipRoleIds).toContain('person_role.client_contact');
        expect(personAfterMatterA.relationshipRoleIds).toContain('person_role.private_client');
        const matchingMerediths = (await partyRepo.listAllPeople<Person>(ctx)).filter(
          (p) => !p.mergedIntoId && p.firstName === 'Meredith' && p.surname === 'Penn',
        );
        expect(matchingMerediths).toHaveLength(1);

        // 1d. Link the SAME canonical Person across Matters B (OP/CAP_DEFENDANT), C (TP/CAP_EXPERT_WITNESS), D (NO/CAP_MEDIATOR)
        const otherClientOrg = await saveOrganisationRecord(
          {
            legalName: 'Bramwell Engineering PLC',
            relationshipTypeIds: ['organisation_relationship_type.client'],
          },
          { byId: 'P-000001' },
        );
        const otherClientId = otherClientOrg.organisation.id;

        const matterBRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            title: 'S0-21 Matter B Opposing Capacity',
            clientId: otherClientId,
            parties: [
              {
                id: 'mp-b-1',
                name: 'Meredith Penn',
                role: 'Opponent',
                relationshipCode: 'OP',
                capacityCodes: ['CAP_DEFENDANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: canonicalPersonId,
              },
            ],
            conflictCheckRecord: undefined,
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(matterBRes.errors).toBeUndefined();
        const matterB = matterBRes.matter!;

        const matterCRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            title: 'S0-21 Matter C Third-Party Expert Witness',
            clientId: otherClientId,
            parties: [
              {
                id: 'mp-c-1',
                name: 'Meredith Penn',
                role: 'Other party',
                relationshipCode: 'TP',
                capacityCodes: ['CAP_EXPERT_WITNESS'],
                alignment: 'third_party',
                entityType: 'person',
                linkedRecordId: canonicalPersonId,
              },
            ],
            conflictCheckRecord: undefined,
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(matterCRes.errors).toBeUndefined();

        const matterDRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            title: 'S0-21 Matter D Neutral Mediator',
            clientId: otherClientId,
            parties: [
              {
                id: 'mp-d-1',
                name: 'Meredith Penn',
                role: 'Neutral',
                relationshipCode: 'NO',
                capacityCodes: ['CAP_MEDIATOR'],
                alignment: 'neutral',
                entityType: 'person',
                linkedRecordId: canonicalPersonId,
              },
            ],
            conflictCheckRecord: undefined,
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(matterDRes.errors).toBeUndefined();

        // 1e. Editing Matter B capacity from CAP_DEFENDANT -> CAP_CLAIMANT leaves A/C/D intact
        const matterBEdit = await saveMatterRecord(
          {
            ...matterB,
            parties: [
              {
                id: 'mp-b-1',
                name: 'Meredith Penn',
                role: 'Opponent',
                relationshipCode: 'OP',
                capacityCodes: ['CAP_CLAIMANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: canonicalPersonId,
              },
            ],
          },
          {
            id: matterB.id,
            byId: 'P-000001',
            saveMode: 'draft',
            expectedRowVersion: matterB.rowVersion,
          },
        );
        expect(matterBEdit.errors).toBeUndefined();

        // Fresh pool verification across matters
        const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
        const [reloadedA, reloadedB, reloadedC, reloadedD] = await Promise.all([
          freshMatterRepo.getMatterById<Matter>(ctx, matterA.id, {
            viewerUserId: 'P-000001',
            hasRestrictedMatterAccess: true,
          }),
          freshMatterRepo.getMatterById<Matter>(ctx, matterB.id, {
            viewerUserId: 'P-000001',
            hasRestrictedMatterAccess: true,
          }),
          freshMatterRepo.getMatterById<Matter>(ctx, matterCRes.matter!.id, {
            viewerUserId: 'P-000001',
            hasRestrictedMatterAccess: true,
          }),
          freshMatterRepo.getMatterById<Matter>(ctx, matterDRes.matter!.id, {
            viewerUserId: 'P-000001',
            hasRestrictedMatterAccess: true,
          }),
        ]);
        expect(reloadedA?.clientId).toBe(canonicalPersonId);
        expect(reloadedB?.parties?.[0]?.capacityCodes).toEqual(['CAP_CLAIMANT']);
        expect(reloadedC?.parties?.[0]?.capacityCodes).toEqual(['CAP_EXPERT_WITNESS']);
        expect(reloadedD?.parties?.[0]?.capacityCodes).toEqual(['CAP_MEDIATOR']);

        // Still only 1 canonical Person row for Meredith Penn
        const afterPartiesPeople = (await partyRepo.listAllPeople<Person>(ctx)).filter(
          (p) => !p.mergedIntoId && p.firstName === 'Meredith' && p.surname === 'Penn',
        );
        expect(afterPartiesPeople).toHaveLength(1);

        // 1f. Verify in-tx private_client union in prepareEnquiryConversion and prepareQuoteConversionRecord
        const clientContactOnlyA = await savePersonRecord(
          {
            firstName: 'Tamsin',
            surname: 'Lockwood',
            relationshipRoleIds: ['person_role.client_contact'],
            emails: [
              {
                id: 'em-tl-1',
                address: 'tamsin.lockwood@invented-client.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { byId: 'P-000001' },
        );
        expect(clientContactOnlyA.errors).toBeUndefined();
        const tamsinId = clientContactOnlyA.person.id;

        const enqSave = await saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'Tamsin',
            lastName: 'Lockwood',
            email: 'tamsin.lockwood@invented-client.example',
            phone: '020 7946 0303',
            preferredContactMethodId: 'contact_method.email',
            practiceAreaId: templateMatter.practiceAreaId,
            summary: 'Private individual property instruction',
            notes: 'Client contact becoming private client via enquiry conversion.',
            urgencyId: 'urgency.normal',
            sourceId: 'record_source.website',
            assignedTeamId: templateMatter.owningTeamId ?? 'TM-000001',
            assignedToId: 'P-000001',
            linkedPersonId: tamsinId,
            privacyNoticeGiven: true,
          },
          { byId: 'P-000001' },
        );
        expect(enqSave.errors).toBeUndefined();
        const convEnqRes = await prepareEnquiryConversion(
          enqSave.enquiry!.id,
          { usePersonId: tamsinId, createForBusiness: false },
          'P-000001',
        );
        expect(convEnqRes.ok).toBe(true);
        expect(convEnqRes.clientId).toBe(tamsinId);
        const tamsinAfterEnq = (await partyRepo.getPersonById<Person>(ctx, tamsinId))!;
        expect(tamsinAfterEnq.relationshipRoleIds).toContain('person_role.client_contact');
        expect(tamsinAfterEnq.relationshipRoleIds).toContain('person_role.private_client');

        // And repeat for prepareQuoteConversionRecord with a second client_contact-only person
        const clientContactOnlyB = await savePersonRecord(
          {
            firstName: 'Quentin',
            surname: 'Barrow',
            relationshipRoleIds: ['person_role.client_contact'],
            emails: [
              {
                id: 'em-qb-1',
                address: 'quentin.barrow@invented-client.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { byId: 'P-000001' },
        );
        expect(clientContactOnlyB.errors).toBeUndefined();
        const quentinId = clientContactOnlyB.person.id;

        const quoteSave = await saveQuoteRecord(
          {
            clientType: 'existing',
            linkedPersonId: quentinId,
            prospectName: 'Quentin Barrow',
            prospectEmail: 'quentin.barrow@invented-client.example',
            practiceAreaId: templateMatter.practiceAreaId,
            scope: 'Private advisory instruction from quote',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1800,
          },
          { byId: 'P-000001' },
        );
        expect(quoteSave.error).toBeUndefined();
        const convQuoteRes = await prepareQuoteConversionRecord(
          quoteSave.quote!.id,
          'P-000001',
        );
        expect(convQuoteRes.ok).toBe(true);
        expect(convQuoteRes.clientId).toBe(quentinId);
        const quentinAfterQuote = (await partyRepo.getPersonById<Person>(ctx, quentinId))!;
        expect(quentinAfterQuote.relationshipRoleIds).toContain('person_role.client_contact');
        expect(quentinAfterQuote.relationshipRoleIds).toContain('person_role.private_client');
        const matchingQuentins = (await partyRepo.listAllPeople<Person>(ctx)).filter(
          (p) => !p.mergedIntoId && p.firstName === 'Quentin' && p.surname === 'Barrow',
        );
        expect(matchingQuentins).toHaveLength(1);
      });
    } finally {
      await freshPoolMgr.closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('2. Full conflict traversal (all 8 relationship codes, capacities, referrerContactId, secondary emails, otherNames, historical links, parentOrganisationId) & strict staff/wall (incl. empty allow-list B12) redaction', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const adminSession = makeActorSession('P-000001');
    const hrBlockedSession = makeActorSession('P-000007', ['partner', 'fee_earner']);
    const feeEarnerBlockedSession = makeActorSession('P-000008', ['fee_earner']);
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();

    try {
      await runWithActiveActorSession(adminSession, async () => {
        // Parent & subsidiary organisations
        const parentOrg = (
          await saveOrganisationRecord(
            {
              legalName: 'Halcyon Maritime Holdings Group Ltd',
              relationshipTypeIds: ['organisation_relationship_type.client'],
              website: 'https://halcyon-group.example',
            },
            { byId: 'P-000001' },
          )
        ).organisation;

        const childOrg = (
          await saveOrganisationRecord(
            {
              legalName: 'Severn Quayside Logistics Ltd',
              parentOrganisationId: parentOrg.id,
              relationshipTypeIds: ['organisation_relationship_type.counterparty'],
              website: 'https://severn-quayside.example',
            },
            { byId: 'P-000001' },
          )
        ).organisation;

        // Person with secondary email, otherNames, and a historical (isCurrent: false) link to parentOrg
        const targetPerson = (
          await savePersonRecord(
            {
              firstName: 'Harriet',
              surname: 'Dunmore',
              otherNames: [{ id: 'on-hd-1', name: 'Harriet Vance-Dunmore', typeId: null }],
              relationshipRoleIds: ['person_role.client_contact'],
              emails: [
                {
                  id: 'em-hd-1',
                  address: 'harriet.dunmore@primary-invented.example',
                  typeId: 'email_type.work',
                  isPrimary: true,
                  active: true,
                },
                {
                  id: 'em-hd-2',
                  address: 'harriet.legacy@alias-invented.example',
                  typeId: 'email_type.personal',
                  isPrimary: false,
                  active: true,
                },
              ],
            },
            { byId: 'P-000001' },
          )
        ).person;

        const histLinkRes = await createOrUpdateLink(
          {
            personId: targetPerson.id,
            organisationId: parentOrg.id,
            jobTitle: 'Former Finance Director',
            department: '',
            roleWithinOrganisation: '',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: false,
            startDate: '2020-01-01',
            endDate: '2024-06-30',
            contactStatusId: null,
          },
          'P-000001',
        );
        expect((histLinkRes as { code?: string }).code).toBeUndefined();

        // Referrer contact
        const referrerPerson = (
          await savePersonRecord(
            {
              firstName: 'Benedict',
              surname: 'Farrow',
              relationshipRoleIds: ['person_role.referrer'],
              emails: [
                {
                  id: 'em-bf-1',
                  address: 'benedict.farrow@referrer-invented.example',
                  typeId: 'email_type.work',
                  isPrimary: true,
                  active: true,
                },
              ],
            },
            { byId: 'P-000001' },
          )
        ).person;

        const templateMatter = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        const matterBase = stripMatterKeys(templateMatter, [
          'id',
          'rowVersion',
          'additionalClientIds',
          'instructingContactId',
          'billingContactId',
          'referrerContactId',
          'parties',
          'engagementLetterStatus',
          'engagementLetterSignedAt',
        ]);

        // Open matter spanning ALL 8 relationship codes + referrerContactId + CAP_EXPERT_WITNESS / CAP_MEDIATOR
        const eightCodeParties = [
          {
            id: 'mp-8-jc',
            name: 'Joint CoVenture Client Ltd',
            role: 'Joint client',
            relationshipCode: 'JC' as const,
            capacityCodes: ['CAP_JOINT_CLIENT'],
            alignment: 'aligned' as const,
            entityType: 'organisation' as const,
            linkedRecordId: null,
          },
          {
            id: 'mp-8-cc',
            name: 'Cadence Connected Witness',
            role: 'Expert witness',
            relationshipCode: 'CC' as const,
            capacityCodes: ['CAP_EXPERT_WITNESS'],
            alignment: 'aligned' as const,
            entityType: 'person' as const,
            linkedRecordId: null,
          },
          {
            id: 'mp-8-op',
            name: 'Severn Quayside Logistics Ltd',
            role: 'Opponent',
            relationshipCode: 'OP' as const,
            capacityCodes: ['CAP_DEFENDANT'],
            alignment: 'adverse' as const,
            entityType: 'organisation' as const,
            linkedRecordId: childOrg.id,
          },
          {
            id: 'mp-8-cp',
            name: 'Monmouth Adverse Adviser LLP',
            role: 'Opposing solicitor',
            relationshipCode: 'CP' as const,
            capacityCodes: ['CAP_OPPOSING_SOLICITOR'],
            alignment: 'adverse' as const,
            entityType: 'organisation' as const,
            linkedRecordId: null,
          },
          {
            id: 'mp-8-co',
            name: 'Tudor Indemnifier Corp',
            role: 'Counterparty affiliate',
            relationshipCode: 'CO' as const,
            capacityCodes: ['CAP_GUARANTOR'],
            alignment: 'adverse' as const,
            entityType: 'organisation' as const,
            linkedRecordId: null,
          },
          {
            id: 'mp-8-tp',
            name: 'Gideon Halstead',
            role: 'Third-party expert',
            relationshipCode: 'TP' as const,
            capacityCodes: ['CAP_EXPERT_WITNESS'],
            alignment: 'third_party' as const,
            entityType: 'person' as const,
            linkedRecordId: null,
          },
          {
            id: 'mp-8-no',
            name: 'Dr Iona MacLeod',
            role: 'Mediator',
            relationshipCode: 'NO' as const,
            capacityCodes: ['CAP_MEDIATOR'],
            alignment: 'neutral' as const,
            entityType: 'person' as const,
            linkedRecordId: null,
          },
        ];

        const traversalMatter = (
          await saveMatterRecord(
            {
              ...matterBase,
              matterNumber: 'DRAFT',
              title: 'S0-21 Full 8-Code Traversal Matter',
              clientId: targetPerson.id,
              referrerContactId: referrerPerson.id,
              parties: eightCodeParties,
              conflictCheckRecord: undefined,
            },
            { byId: 'P-000001', saveMode: 'draft' },
          )
        ).matter!;

        // Verify buildEffectiveConflictParties includes referrerContactId & all 8 relationship codes
        const [allPeople, allOrgs, allLinks, allMatters, allEnquiries] = await Promise.all([
          partyRepo.listAllPeople<Person>(ctx),
          partyRepo.listAllOrganisations<Organisation>(ctx),
          partyRepo.listAllLinks<PersonOrganisationLink>(ctx),
          matterRepo.listAllMattersUnfiltered<Matter>(ctx),
          getIntakeQuoteRepository().listAllEnquiriesUnfiltered<Enquiry>(ctx),
        ]);

        const effectiveParties = buildEffectiveConflictParties({
          clientId: traversalMatter.clientId,
          referrerContactId: traversalMatter.referrerContactId,
          matterParties: traversalMatter.parties,
          people: allPeople,
          organisations: allOrgs,
        });
        expect(effectiveParties.some((p) => p.linkedRecordId === referrerPerson.id)).toBe(true);
        for (const code of ['JC', 'CC', 'OP', 'CP', 'CO', 'TP', 'NO']) {
          expect(effectiveParties.some((p) => p.relationshipCode === code)).toBe(true);
        }

        // Verify Enquiry Conflict Search traverses:
        // (a) secondary email, (b) otherNames, (c) historical link, (d) parentOrganisationId,
        // (e) referrerContactId, (f) CP / CO / TP / NO / OP / CC / JC matter parties & CAP_EXPERT_WITNESS / CAP_MEDIATOR
        expect(CONFLICT_SEARCHED_SOURCES).toContain('referrer contacts');
        expect(CONFLICT_SEARCHED_SOURCES).toContain('parent organisations');

        const secondaryEmailHit = runEnquiryConflictSearch(
          {
            firstName: 'Caller',
            lastName: 'Unknown',
            email: 'harriet.legacy@alias-invented.example',
          },
          allPeople,
          allOrgs,
          allMatters,
          [],
          allEnquiries,
          null,
          allLinks,
          () => true,
          ctx.tenantId,
        );
        expect(secondaryEmailHit.allConflicts.length).toBeGreaterThan(0);

        const otherNameHit = runEnquiryConflictSearch(
          {
            otherPartiesNamed: 'Harriet Vance-Dunmore',
          },
          allPeople,
          allOrgs,
          allMatters,
          [],
          allEnquiries,
          null,
          allLinks,
          () => true,
          ctx.tenantId,
        );
        expect(
          otherNameHit.allConflicts.some((h) => h.recordId === targetPerson.id),
        ).toBe(true);
        const matterOtherNameMatches = searchMatterConflicts(
          {
            parties: [
              {
                id: 'cp-othername-1',
                name: 'Harriet Vance-Dunmore',
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          {
            matters: allMatters,
            enquiries: allEnquiries,
            people: allPeople,
            organisations: allOrgs,
            links: allLinks,
            tenantId: ctx.tenantId,
            canView: () => true,
            canViewEnquiry: () => true,
          },
        );
        expect(
          matterOtherNameMatches.some((m) => m.matchedRecordId === targetPerson.id),
        ).toBe(true);

        // Historical link from Harriet -> parentOrg triggers match against opponent childOrg -> parentOrg
        const historicalAndParentHit = runEnquiryConflictSearch(
          {
            firstName: 'Harriet',
            lastName: 'Dunmore',
            callingOnBehalfOf: 'Halcyon Maritime Holdings Group Ltd',
            otherPartiesNamed: 'Severn Quayside Logistics Ltd',
          },
          allPeople,
          allOrgs,
          allMatters,
          [],
          allEnquiries,
          null,
          allLinks,
          () => true,
          ctx.tenantId,
        );
        expect(historicalAndParentHit.hasBlockingConflict).toBe(true);

        // Expert witness (CAP_EXPERT_WITNESS on TP), Mediator (CAP_MEDIATOR on NO), Referrer, CP, CO
        const capTraversalHit = runEnquiryConflictSearch(
          {
            otherPartiesNamed:
              'Gideon Halstead, Dr Iona MacLeod, Benedict Farrow, Monmouth Adverse Adviser LLP, Tudor Indemnifier Corp, Cadence Connected Witness',
          },
          allPeople,
          allOrgs,
          allMatters,
          [],
          allEnquiries,
          null,
          allLinks,
          () => true,
          ctx.tenantId,
        );
        const capSummary = capTraversalHit.allConflicts
          .map((h) => `${h.name} | ${h.reason} | ${h.reasons.join(' ')}`)
          .join(' || ');
        expect(capSummary).toContain('Gideon Halstead');
        expect(capSummary).toContain('Iona MacLeod');
        expect(capSummary).toContain('Benedict Farrow');
        expect(capSummary).toContain('Monmouth Adverse Adviser');
        expect(capSummary).toContain('Tudor Indemnifier');
        expect(capSummary).toContain('Cadence Connected Witness');

        // Restricted matter non-leakage: Staff Matter + Empty Allow-List Ethical Wall (B12)
        const staffSecretOpponent = 'SecretStaffAdversarySurname';
        const wallSecretClient = 'SecretWallClientOrg Ltd';

        const staffMatter = (
          await saveMatterRecord(
            {
              ...matterBase,
              matterNumber: 'DRAFT',
              title: 'Confidential Staff Matter Alpha',
              isStaffMatter: true,
              restrictedAccessUserIds: ['P-000001'],
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001'],
              clientId: 'P-000001',
              parties: [
                {
                  id: 'mp-staff-op',
                  name: staffSecretOpponent,
                  role: 'Opponent',
                  relationshipCode: 'OP',
                  capacityCodes: ['CAP_DEFENDANT'],
                  alignment: 'adverse',
                  entityType: 'person',
                  linkedRecordId: null,
                },
              ],
              conflictCheckRecord: undefined,
            },
            { byId: 'P-000001', saveMode: 'draft' },
          )
        ).matter!;

        const anotherClientOrgId =
          allOrgs.find((o) => !o.mergedIntoId && o.id !== parentOrg.id)?.id ?? parentOrg.id;

        const emptyWallSaved = (
          await saveMatterRecord(
            {
              ...matterBase,
              matterNumber: 'DRAFT',
              title: 'Empty Allow-List Ethical Wall Matter',
              hasEthicalWall: true,
              restrictedAccessUserIds: [],
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001'],
              clientId: anotherClientOrgId,
              parties: [
                {
                  id: 'mp-wall-op',
                  name: wallSecretClient,
                  role: 'Opponent',
                  relationshipCode: 'OP',
                  capacityCodes: ['CAP_DEFENDANT'],
                  alignment: 'adverse',
                  entityType: 'organisation',
                  linkedRecordId: null,
                },
              ],
              conflictCheckRecord: undefined,
            },
            { byId: 'P-000001', saveMode: 'draft' },
          )
        ).matter!;
        const emptyWallMatter = await matterRepo.putMatter(
          ctx,
          {
            ...emptyWallSaved,
            hasEthicalWall: true,
            restrictedAccessUserIds: [],
          },
          {
            expectedRowVersion: emptyWallSaved.rowVersion,
            sqlRestrictedAccessUserIds: [],
          },
        );

        const latestMatters = await matterRepo.listAllMattersUnfiltered<Matter>(ctx);

        // 2a. Enquiry conflict search / snapshot for unpermitted viewer (canViewMatter returns false on restricted)
        const canBlockedView = (m: Matter) =>
          !m.isStaffMatter &&
          !m.hasEthicalWall &&
          (m.restrictedAccessUserIds?.length ?? 0) === 0;

        const restrictedEnqSnap = computeEnquiryConflictSnapshot(
          {
            firstName: 'Prospective',
            lastName: 'Caller',
            otherPartiesNamed: `${staffSecretOpponent}, ${wallSecretClient}`,
          },
          allPeople,
          allOrgs,
          latestMatters,
          [],
          {
            recordedAt: '2026-11-15T10:00:00.000Z',
            recordedById: 'P-000002',
            enquiries: allEnquiries,
            links: allLinks,
            canViewMatter: canBlockedView,
            tenantId: ctx.tenantId,
          },
        );
        const snapJson = JSON.stringify(restrictedEnqSnap);
        expect(snapJson).not.toContain('Confidential Staff Matter Alpha');
        expect(snapJson).not.toContain('Empty Allow-List Ethical Wall Matter');
        expect(snapJson).not.toContain(staffMatter.matterNumber);
        expect(snapJson).not.toContain(emptyWallMatter.matterNumber);
        expect(snapJson).not.toContain(staffMatter.id);
        expect(snapJson).not.toContain(emptyWallMatter.id);

        expect(
          restrictedEnqSnap.conflicts.some(
            (c) => c.recordId === `restricted-${redactRecordId(ctx.tenantId, staffMatter.id)}`,
          ),
        ).toBe(true);
        expect(
          restrictedEnqSnap.conflicts.some(
            (c) => c.recordId === `restricted-${redactRecordId(ctx.tenantId, emptyWallMatter.id)}`,
          ),
        ).toBe(true);

        // 2b. Matter conflict search redacts restricted hits for unpermitted viewer
        const blockedMatches = searchMatterConflicts(
          {
            parties: [
              {
                id: 'search-op-1',
                name: staffSecretOpponent,
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'search-op-2',
                name: wallSecretClient,
                entityType: 'organisation',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          {
            matters: latestMatters,
            enquiries: allEnquiries,
            people: allPeople,
            organisations: allOrgs,
            links: allLinks,
            tenantId: ctx.tenantId,
            canView: canBlockedView,
            canViewEnquiry: () => true,
          },
        );
        expect(blockedMatches.length).toBeGreaterThanOrEqual(2);
        for (const bm of blockedMatches) {
          expect(bm.restricted).toBe(true);
          expect(bm.matchedRecordId).toBe('');
          expect(bm.matterId).toBeNull();
          expect(bm.matterNumber).toBeNull();
          expect(bm.responsiblePartnerId).toBeNull();
        }
        expect(
          blockedMatches.some(
            (bm) =>
              bm.id ===
              `match-restricted-search-op-1-${redactRecordId(ctx.tenantId, `search-op-1:${staffMatter.id}`)}`,
          ),
        ).toBe(true);
        expect(
          blockedMatches.some(
            (bm) =>
              bm.id ===
              `match-restricted-search-op-2-${redactRecordId(ctx.tenantId, `search-op-2:${emptyWallMatter.id}`)}`,
          ),
        ).toBe(true);

        // Permitted oversight holder P-000001 (matter:restricted:access) sees unredacted matches
        const permittedSearch = await runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 'search-perm-1',
                name: staffSecretOpponent,
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'search-perm-2',
                name: wallSecretClient,
                entityType: 'organisation',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          'P-000001',
        );
        const staffHitForAdmin = permittedSearch.matches.find((m) => m.matterId === staffMatter.id);
        expect(staffHitForAdmin).toBeDefined();
        expect(staffHitForAdmin?.restricted).not.toBe(true);
        const wallHitForAdmin = permittedSearch.matches.find(
          (m) => m.matterId === emptyWallMatter.id,
        );
        expect(wallHitForAdmin).toBeDefined();
        expect(wallHitForAdmin?.restricted).not.toBe(true);

        // 2c. HR conflictCheckOnHire + filterEmploymentForUser + getEmployeeDetailsForUser restricted-matter redaction
        const hireCandidate = (
          await savePersonRecord(
            {
              firstName: 'Callum',
              surname: 'HireCandidate',
              relationshipRoleIds: ['person_role.client_contact'],
            },
            { byId: 'P-000001' },
          )
        ).person;
        const savedStaffHireMatter = (
          await saveMatterRecord(
            {
              ...matterBase,
              matterNumber: 'DRAFT',
              title: 'Restricted Hire Conflict Matter',
              isStaffMatter: true,
              restrictedAccessUserIds: ['P-000001'],
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: ['P-000001'],
              clientId: parentOrg.id,
              parties: [
                {
                  id: 'mp-hire-1',
                  name: 'Callum HireCandidate',
                  role: 'Opponent',
                  relationshipCode: 'OP',
                  capacityCodes: ['CAP_DEFENDANT'],
                  alignment: 'adverse',
                  entityType: 'person',
                  linkedRecordId: hireCandidate.id,
                },
              ],
              conflictCheckRecord: undefined,
            },
            { byId: 'P-000001', saveMode: 'draft' },
          )
        ).matter!;
        const staffHireMatter = await matterRepo.putMatter<Matter>(
          ctx,
          {
            ...savedStaffHireMatter,
            isStaffMatter: true,
            restrictedAccessUserIds: ['P-000001'],
          },
          {
            expectedRowVersion: savedStaffHireMatter.rowVersion,
            sqlRestrictedAccessUserIds: ['P-000001'],
          },
        );

        const latestWithHireMatter = await matterRepo.listAllMattersUnfiltered<Matter>(ctx);
        const openOnHire = findOpenMattersWherePersonIsParty(
          hireCandidate.id,
          latestWithHireMatter,
        );
        expect(openOnHire.map((m) => m.id)).toContain(staffHireMatter.id);

        // Convert hireCandidate -> employee through real savePersonRecord hire path
        const hireSave = await savePersonRecord(
          {
            firstName: hireCandidate.firstName,
            surname: hireCandidate.surname,
            dateOfBirth: '1991-04-12',
          },
          {
            id: hireCandidate.id,
            byId: 'P-000001',
            mfaVerified: true,
            worksAtFirm: true,
            employmentSubmitted: {
              engagementType: 'Employee',
              status: 'Pre-start',
              employeeNumber: 'EMP-S021-99',
              employingEntityId: 'LE-PV-LLP',
              jobTitle: 'Associate',
              gradeOrBand: 'Band 3',
              roleType: 'Fee earner',
              divisionId: 'DIV-LEGAL',
              departmentId: 'DEPT-RE',
              teamOrPracticeGroupId: 'TEAM-RE-COMM',
              officeId: 'OFF-CDF',
              costCentreId: 'CC-RE',
              profitCentreId: 'PC-RE',
              isTopOfHierarchy: false,
              lineManagerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              timesheetApproverId: 'P-000001',
              holidayApproverId: 'P-000001',
              onboardingBuddyId: null,
              effectiveFrom: '2026-11-15',
              effectiveTo: null,
              contract: {
                startDate: '2026-11-15',
                continuousServiceDate: '2026-11-15',
                contractType: 'Permanent',
                fixedTermEndDate: null,
                fte: 1,
                workingPattern: 'Full-time',
                workingPatternNotes: '',
                workLocationArrangement: 'Hybrid',
                probationPeriodMonths: 6,
                probationEndDate: '2027-05-15',
                probationEndDateOverridden: false,
                probationOutcome: 'Pending',
                noticePeriod: '3 months',
                holidayEntitlementDays: 25,
                leavingDate: null,
                leavingReasonId: null,
                eligibleForRehire: 'Yes',
                keepAsContactOnLeave: true,
                hrRetentionUntil: null,
              },
            },
          },
        );
        expect(hireSave.errors).toBeUndefined();
        expect(hireSave.person.employment?.conflictCheckOnHire?.openMatterIds).toContain(
          staffHireMatter.id,
        );

        // Viewer P-000007 (Practice Manager / partner without matter:restricted:access & not in staffHireMatter.restrictedAccessUserIds) gets redacted conflictCheckOnHire
        await runWithActiveActorSession(hrBlockedSession, async () => {
          const blockedHr = await getEmployeeDetailsForUser(hireCandidate.id, 'P-000007');
          expect(blockedHr.employment?.conflictCheckOnHire?.openMatterIds).toEqual([]);
          expect(blockedHr.employment?.conflictCheckOnHire?.riskNotes).toContain(
            'details hidden under ethical wall / staff-matter restriction',
          );
          expect(blockedHr.employment?.conflictCheckOnHire?.riskNotes).not.toContain(
            staffHireMatter.matterNumber,
          );
        });

        // Pure domain filterEmploymentForUser redaction check as well
        const unpermittedFiltered = filterEmploymentForUser(
          hireSave.person.employment,
          allPeople.find((p) => p.id === 'P-000008')!,
          allPeople,
          [],
          undefined,
          {
            tenantId: ctx.tenantId,
            config: { rbac: getActiveTenantConfiguration().rbac },
          },
          {
            canViewMatterId: (id) => id !== staffHireMatter.id && id !== emptyWallMatter.id,
          },
        );
        expect(unpermittedFiltered?.conflictCheckOnHire).toBeDefined();
        expect(unpermittedFiltered!.conflictCheckOnHire!.openMatterIds).toEqual([]);
        expect(unpermittedFiltered!.conflictCheckOnHire!.riskNotes).toContain(
          'details hidden under ethical wall / staff-matter restriction',
        );
        expect(unpermittedFiltered!.conflictCheckOnHire!.riskNotes).not.toContain(
          staffHireMatter.matterNumber,
        );

        // 2d. listAuditEntriesForRecord redacts restricted matter audit trail to unpermitted viewer P-000008
        const restrictedAuditRes = await runWithActiveActorSession(
          feeEarnerBlockedSession,
          () => listAuditEntriesForRecord('matter', staffHireMatter.id, 'P-000008'),
        );
        expect(restrictedAuditRes).toEqual([]);
      });

      // Unpermitted fee_earner P-000008 sees BOTH staffMatter and emptyWallMatter (empty allow-list B12) redacted in service conflict search
      await runWithActiveActorSession(feeEarnerBlockedSession, async () => {
        const res = await runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 's-b-1',
                name: 'SecretStaffAdversarySurname',
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 's-b-2',
                name: 'SecretWallClientOrg Ltd',
                entityType: 'organisation',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          'P-000008',
        );
        const restrictedMatches = res.matches.filter((m) => m.restricted === true);
        expect(restrictedMatches.length).toBeGreaterThanOrEqual(2);
        for (const rm of restrictedMatches) {
          expect(rm.matchedRecordId).toBe('');
          expect(rm.matterId).toBeNull();
          expect(rm.matterNumber).toBeNull();
        }
      });
    } finally {
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('3. Single-transaction executeMerge hardening (same-matter role/capacity collisions, connectedToPartyId, additionalClientIds, document_links.link_role, tasks/quotes/enquiries JSONB, boundary href P-1 vs P-10, org self-parenting & createdFromEnquiryId, refusals, real PostgreSQL trigger rollback)', async () => {
    await resetAllDemoData('P-000001', testDataResetContext());
    const ctx = makeTenantCtx('not-a-law-firm', 'P-000001');
    const session = makeActorSession('P-000001');
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const iqRepo = getIntakeQuoteRepository();
    const twRepo = getTaskWorkflowRepository();
    const docRepo = getDocumentRepository();
    const freshPoolMgr = new TenantPostgresPoolManager();

    try {
      await runWithActiveActorSession(session, async () => {
        // 3a. Refusals: employee/leaver, self-merge
        const empPerson = (await partyRepo.getPersonById<Person>(ctx, 'P-000002'))!;
        expect(empPerson.isEmployee).toBe(true);
        const survivorSeed = (
          await savePersonRecord(
            {
              firstName: 'Arthur',
              surname: 'Kensington',
              relationshipRoleIds: ['person_role.client_contact'],
            },
            { byId: 'P-000001' },
          )
        ).person;

        const selfDenied = await executeMerge('person', survivorSeed.id, survivorSeed.id, 'P-000001');
        expect(selfDenied.code).toBe('FORBIDDEN');

        const empDenied = await executeMerge('person', survivorSeed.id, empPerson.id, 'P-000001');
        expect(empDenied.code).toBe('FORBIDDEN');

        // 3b. Boundary-safe P-1 vs P-10 & survivor P-2 merge setup
        const p1 = makeMinimalPerson('P-1', 'Simeon', 'MergeSource', {
          emails: [
            {
              id: 'em-p1-1',
              address: 'simeon.unique@invented.example',
              typeId: 'email_type.work',
              isPrimary: false,
              active: true,
            },
            {
              id: 'em-p1-dup',
              address: 'shared.alias@invented.example',
              typeId: 'email_type.work',
              isPrimary: false,
              active: true,
            },
          ],
          createdFromEnquiryId: 'ENQ-000001',
        });
        const p2 = makeMinimalPerson('P-2', 'Simeon', 'Survivor', {
          emails: [
            {
              id: 'em-p2-1',
              address: 'shared.alias@invented.example',
              typeId: 'email_type.work',
              isPrimary: true,
              active: true,
            },
          ],
          createdFromEnquiryId: null,
        });
        const p10 = makeMinimalPerson('P-10', 'Unrelated', 'TenthPerson', {
          emails: [
            {
              id: 'em-p10-1',
              address: 'tenth.person@invented.example',
              typeId: 'email_type.work',
              isPrimary: true,
              active: true,
            },
          ],
        });
        await partyRepo.putPeople(ctx, [p1, p2, p10]);
        await savePersonRecord(p1, { id: 'P-1', byId: 'P-000001' });
        await savePersonRecord(p2, { id: 'P-2', byId: 'P-000001' });
        await savePersonRecord(p10, { id: 'P-10', byId: 'P-000001' });

        // Notification pointing to /people/P-1 AND /people/P-10 (prefix boundary test)
        const ntfP1: TenantNotificationRecord = {
          id: 'NTF-S021-BOUNDARY-1',
          recipientId: 'P-000001',
          kind: 'task_assigned',
          title: 'Follow up with P-1',
          detail: 'Check profile',
          recordId: 'P-1',
          href: '/people/P-1',
          read: false,
          createdAt: '2026-11-15T10:00:00.000Z',
          byId: 'P-1',
        };
        const ntfP10: TenantNotificationRecord = {
          id: 'NTF-S021-BOUNDARY-10',
          recipientId: 'P-000001',
          kind: 'task_assigned',
          title: 'Do not corrupt P-10',
          detail: 'P-10 href must remain /people/P-10',
          recordId: 'P-10',
          href: '/people/P-10',
          read: false,
          createdAt: '2026-11-15T10:00:00.000Z',
          byId: 'P-000001',
        };
        await twRepo.putNotifications(ctx, [ntfP1, ntfP10]);

        // Document links: P-1 has primary_client + recipient_party on DOC-1, while P-2 already has primary_client on DOC-1
        const genDoc: GeneratedDocumentRecord = {
          id: 'DOC-S021-MERGE-1',
          tenantId: ctx.tenantId,
          title: 'Client Care Letter',
          fileName: 'ccl.docx',
          documentType: 'letter',
          outputFormat: 'docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileSizeBytes: 1234,
          fileSha256: 'abc123',
          templateId: 'TPL-1',
          templateName: 'Client Care',
          templateVersionId: 'TPLV-1',
          templateVersionNumber: 1,
          storageProvider: 'local-fs',
          storageKey: 'docs/s021-test.docx',
          generatedByUserId: 'P-000001',
          generatedAt: '2026-11-15T10:00:00.000Z',
          primaryMatterId: 'M-000001',
          primaryClientId: 'P-1',
          recipientPartyId: 'P-1',
          isDeleted: false,
        };
        await docRepo.putDocument(ctx, genDoc);
        const dlSurvPrimary: DocumentLinkRecord = {
          id: 'DL-S021-SURV-PRIM',
          tenantId: ctx.tenantId,
          documentId: genDoc.id,
          entityType: 'person',
          entityId: 'P-2',
          linkRole: 'primary_client',
          createdAt: '2026-11-15T10:00:00.000Z',
        };
        const dlMergedPrimary: DocumentLinkRecord = {
          id: 'DL-S021-MERG-PRIM',
          tenantId: ctx.tenantId,
          documentId: genDoc.id,
          entityType: 'person',
          entityId: 'P-1',
          linkRole: 'primary_client',
          createdAt: '2026-11-15T10:01:00.000Z',
        };
        const dlMergedRecip: DocumentLinkRecord = {
          id: 'DL-S021-MERG-RECIP',
          tenantId: ctx.tenantId,
          documentId: genDoc.id,
          entityType: 'person',
          entityId: 'P-1',
          linkRole: 'recipient_party',
          createdAt: '2026-11-15T10:02:00.000Z',
        };
        await docRepo.putDocumentLink(ctx, dlSurvPrimary);
        await docRepo.putDocumentLink(ctx, dlMergedPrimary);
        await docRepo.putDocumentLink(ctx, dlMergedRecip);

        // Matter with:
        // - clientId: P-2, additionalClientIds: ['P-1', 'O-000001'] (P-2 must be excluded from additionalClientIds after merge)
        // - referrerContactId: 'P-1'
        // - parties collision: P-2 already OP/CAP_DEFENDANT; P-1 is BOTH exact duplicate OP/CAP_DEFENDANT (being connectedToPartyId target of mp-connected-adviser) AND distinct TP/CAP_EXPERT_WITNESS
        const templateMatter = (await matterRepo.getMatterById<Matter>(ctx, 'M-000001', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        const matterBase = stripMatterKeys(templateMatter, [
          'id',
          'rowVersion',
          'engagementLetterStatus',
          'engagementLetterSignedAt',
        ]);

        const mergeMatterRes = await saveMatterRecord(
          {
            ...matterBase,
            matterNumber: 'DRAFT',
            title: 'S0-21 Same-Matter Collision Matter',
            clientId: 'P-2',
            additionalClientIds: ['P-1', 'O-000001'],
            referrerContactId: 'P-1',
            parties: [
              {
                id: 'mp-surv-op',
                name: 'Simeon Survivor',
                role: 'Opponent',
                relationshipCode: 'OP',
                capacityCodes: ['CAP_DEFENDANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: 'P-2',
              },
              {
                id: 'mp-merged-dup-op',
                name: 'Simeon MergeSource',
                role: 'Opponent',
                relationshipCode: 'OP',
                capacityCodes: ['CAP_DEFENDANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: 'P-1',
              },
              {
                id: 'mp-merged-distinct-tp',
                name: 'Simeon MergeSource',
                role: 'Expert',
                relationshipCode: 'TP',
                capacityCodes: ['CAP_EXPERT_WITNESS'],
                alignment: 'third_party',
                entityType: 'person',
                linkedRecordId: 'P-1',
              },
              {
                id: 'mp-connected-adviser',
                name: 'Connected Adviser Person',
                role: 'Connected party',
                relationshipCode: 'CO',
                capacityCodes: ['CAP_ACCOUNTANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: null,
                connectedToPartyId: 'mp-merged-dup-op',
              },
            ],
            conflictCheckRecord: {
              status: 'Cleared',
              outcomeLabel: 'Cleared by fee earner',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '15 Nov 2026',
              lastRunById: 'P-000001',
              lastRunByName: 'Test Actor P-000001',
              submittedAtDisplay: null,
              submittedById: null,
              submittedByName: null,
              approvedAtDisplay: null,
              approvedById: null,
              approvedByName: null,
              parties: [
                {
                  id: 'cp-m-1',
                  name: 'Simeon MergeSource',
                  entityType: 'person',
                  role: 'Opponent',
                  linkedRecordId: 'P-1',
                },
              ],
              matches: [],
              runs: [],
              comments: [],
            },
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        expect(mergeMatterRes.errors).toBeUndefined();
        const mergeMatter = mergeMatterRes.matter!;

        // Task, Enquiry, Quote referencing P-1
        const taskRes = await saveTaskRecord(
          {
            title: 'S0-21 Task Linked To P-1 & P-2',
            description: 'Test merge sync in linked_records_json and profile_json',
            dueAt: '2026-12-01',
            assignedTeamId: templateMatter.owningTeamId ?? 'TM-000001',
            assignedPersonIds: ['P-000001'],
            linkedRecords: [
              { recordType: 'person', recordId: 'P-1' },
              { recordType: 'person', recordId: 'P-2' },
            ],
          },
          'P-000001',
        );
        const taskId = taskRes.task!.id;

        const enqRes = await saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'Simeon',
            lastName: 'MergeSource',
            email: 'simeon.unique@invented.example',
            phone: '020 7946 0404',
            preferredContactMethodId: 'contact_method.email',
            practiceAreaId: templateMatter.practiceAreaId,
            summary: 'Enquiry linked to P-1 for merge JSONB sync',
            notes: 'Notes',
            urgencyId: 'urgency.normal',
            sourceId: 'record_source.website',
            assignedTeamId: templateMatter.owningTeamId ?? 'TM-000001',
            assignedToId: 'P-000001',
            linkedPersonId: 'P-1',
            referrerPersonId: 'P-1',
            privacyNoticeGiven: true,
          },
          { byId: 'P-000001' },
        );
        const enqId = enqRes.enquiry!.id;

        const quoteRes = await saveQuoteRecord(
          {
            clientType: 'existing',
            linkedPersonId: 'P-1',
            prospectName: 'Simeon MergeSource',
            practiceAreaId: templateMatter.practiceAreaId,
            scope: 'Quote linked to P-1',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1200,
          },
          { byId: 'P-000001' },
        );
        const quoteId = quoteRes.quote!.id;
        // Inject conflictDecision referencing P-1 into quote so conflict_decision_json rewrite is exercised
        const rawQuote = (await iqRepo.getQuoteById<Quote>(ctx, quoteId, {
          viewerId: 'P-000001',
        }))!;
        await iqRepo.putQuote(ctx, {
          ...rawQuote,
          conflictDecision: {
            outcome: 'Cleared',
            decidedById: 'P-000001',
            decidedByName: 'Test Actor P-000001',
            decidedAt: '2026-11-15T10:00:00.000Z',
            sourceRecordId: 'P-1',
            matchesCount: 1,
            searchedSources: [...CONFLICT_SEARCHED_SOURCES],
            summary: 'Matched P-1 during quote intake',
          },
        });

        // 3c. Real PostgreSQL BEFORE INSERT trigger rollback test on public.merge_history (ZERO prod test hooks!)
        const directClient = await createDirectMigrationClient({ ctx });
        try {
          await directClient.query(`
            CREATE OR REPLACE FUNCTION public.s021_fail_merge_history_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              RAISE EXCEPTION 'S021_FORCED_DB_TRIGGER_ROLLBACK';
            END;
            $$;
          `);
          await directClient.query(`
            DROP TRIGGER IF EXISTS trg_s021_fail_merge_history ON public.merge_history;
            CREATE TRIGGER trg_s021_fail_merge_history
              BEFORE INSERT ON public.merge_history
              FOR EACH ROW
              EXECUTE FUNCTION public.s021_fail_merge_history_insert();
          `);

          await expect(executeMerge('person', 'P-2', 'P-1', 'P-000001')).rejects.toThrow(
            /TENANCY_DATABASE_ERROR.*SQLSTATE P0001/,
          );
        } finally {
          await directClient.query(
            `DROP TRIGGER IF EXISTS trg_s021_fail_merge_history ON public.merge_history;
             DROP FUNCTION IF EXISTS public.s021_fail_merge_history_insert();`,
          );
          await directClient.end();
        }

        // Verify ZERO partial writes leaked across fresh pool after rollback
        const freshPartyRepo = new TenantPartyRepository({ poolManager: freshPoolMgr });
        const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
        const freshDocRepo = new TenantDocumentRepository({ poolManager: freshPoolMgr });
        const freshIqRepo = new TenantIntakeQuoteRepository({ poolManager: freshPoolMgr });
        const freshTwRepo = new TenantTaskWorkflowRepository({ poolManager: freshPoolMgr });

        const p1AfterRollback = (await freshPartyRepo.getPersonById<Person>(ctx, 'P-1'))!;
        expect(p1AfterRollback.mergedIntoId).toBeNull();
        const mAfterRollback = (await freshMatterRepo.getMatterById<Matter>(ctx, mergeMatter.id, {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        expect(mAfterRollback.referrerContactId).toBe('P-1');
        expect(
          (await freshIqRepo.getEnquiryById<Enquiry>(ctx, enqId, { viewerId: 'P-000001' }))!
            .linkedPersonId,
        ).toBe('P-1');
        const docsAfterRollback = await freshDocRepo.listLinksForDocument(ctx, genDoc.id);
        expect(docsAfterRollback.filter((dl) => dl.entityId === 'P-1')).toHaveLength(2);

        // 3d. Now execute the real single-transaction merge P-1 -> P-2
        const mergeHist = await executeMerge('person', 'P-2', 'P-1', 'P-000001');
        expect(mergeHist.code).toBeUndefined();
        expect(mergeHist.survivorId).toBe('P-2');
        expect(mergeHist.mergedId).toBe('P-1');

        // Re-verify everything through fresh pool manager
        const mergedTombstone = (await freshPartyRepo.getPersonById<Person>(ctx, 'P-1'))!;
        expect(mergedTombstone.mergedIntoId).toBe('P-2');

        // Already-merged tombstone cannot be merged again
        const alreadyMergedDenied = await executeMerge('person', 'P-10', 'P-1', 'P-000001');
        expect(alreadyMergedDenied.code).toBe('FORBIDDEN');

        // Survivor inherits createdFromEnquiryId and unions person_emails cleanly
        const p2After = (await freshPartyRepo.getPersonById<Person>(ctx, 'P-2'))!;
        expect(p2After.createdFromEnquiryId).toBe('ENQ-000001');
        const p2EmailAddrs = (await freshPartyRepo.listPersonEmails(ctx, 'P-2')).map((e) =>
          e.emailLower,
        );
        expect(p2EmailAddrs).toContain('simeon.unique@invented.example');
        expect(p2EmailAddrs.filter((e) => e === 'shared.alias@invented.example')).toHaveLength(1);

        // Notification boundary href check: /people/P-1 -> /people/P-2, while /people/P-10 stays /people/P-10
        const [reloadedNtf1, reloadedNtf10] = await Promise.all([
          freshTwRepo.getNotificationById<TenantNotificationRecord>(ctx, 'NTF-S021-BOUNDARY-1'),
          freshTwRepo.getNotificationById<TenantNotificationRecord>(ctx, 'NTF-S021-BOUNDARY-10'),
        ]);
        expect(reloadedNtf1?.href).toBe('/people/P-2');
        expect(reloadedNtf1?.recordId).toBe('P-2');
        expect(reloadedNtf1?.byId).toBe('P-2');
        expect(reloadedNtf10?.href).toBe('/people/P-10');
        expect(reloadedNtf10?.recordId).toBe('P-10');

        // document_links: preserves recipient_party + keeps 1 primary_client (2 total links on DOC-1 for P-2)
        const docLinksAfter = await freshDocRepo.listLinksForDocument(ctx, genDoc.id);
        const p2DocLinks = docLinksAfter.filter((dl) => dl.entityId === 'P-2');
        expect(p2DocLinks.map((dl) => dl.linkRole).sort()).toEqual([
          'primary_client',
          'recipient_party',
        ]);
        expect(docLinksAfter.filter((dl) => dl.entityId === 'P-1')).toHaveLength(0);

        // Matter collisions:
        // - additionalClientIds excludes clientId P-2 and keeps O-000001
        // - referrerContactId repointed to P-2
        // - distinct TP/CAP_EXPERT_WITNESS preserved while duplicate OP/CAP_DEFENDANT deduplicated
        // - connectedToPartyId remapped to surviving mp-surv-op
        const mAfter = (await freshMatterRepo.getMatterById<Matter>(ctx, mergeMatter.id, {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        expect(mAfter.additionalClientIds).toEqual(['O-000001']);
        expect(mAfter.referrerContactId).toBe('P-2');
        const p2Parties = (mAfter.parties ?? []).filter((mp) => mp.linkedRecordId === 'P-2');
        expect(p2Parties).toHaveLength(2);
        expect(p2Parties.map((mp) => mp.relationshipCode).sort()).toEqual(['OP', 'TP']);
        const connectedParty = (mAfter.parties ?? []).find((mp) => mp.id === 'mp-connected-adviser');
        expect(connectedParty?.connectedToPartyId).toBe('mp-surv-op');
        expect(mAfter.conflictCheckRecord?.parties?.[0]?.linkedRecordId).toBe('P-2');

        // Tasks, Enquiries, Quotes JSONB + normalised columns synced cleanly
        const taskAfter = (await freshTwRepo.getTaskById(ctx, taskId, { viewerId: 'P-000001' }))!;
        expect(taskAfter.linkedRecords).toEqual([{ recordType: 'person', recordId: 'P-2' }]);
        const enqAfter = (await freshIqRepo.getEnquiryById<Enquiry>(ctx, enqId, {
          viewerId: 'P-000001',
        }))!;
        expect(enqAfter.linkedPersonId).toBe('P-2');
        expect(enqAfter.referrerPersonId).toBe('P-2');
        const quoteAfter = (await freshIqRepo.getQuoteById<Quote>(ctx, quoteId, {
          viewerId: 'P-000001',
        }))!;
        expect(quoteAfter.linkedPersonId).toBe('P-2');
        expect(quoteAfter.conflictDecision?.sourceRecordId).toBe('P-2');

        // Audit entry created in same transaction
        const p2Audits = await listAuditEntriesForRecord('person', 'P-2', 'P-000001');
        expect(p2Audits.some((a) => a.action === 'merge' && a.oldValue === 'P-1')).toBe(
          true,
        );

        // 3e. Organisation merge: parentOrganisationId self-parenting / cycle guard & createdFromEnquiryId
        const orgMerged = makeMinimalOrganisation('O-S021-MERG', 'Vortex Holding Old Ltd', {
          createdFromEnquiryId: enqId,
        });
        const orgSurv = makeMinimalOrganisation('O-S021-SURV', 'Vortex Holdings Group Ltd', {
          // Survivor currently points to orgMerged as its parent -> must NOT become self-parent or point to tombstone
          parentOrganisationId: orgMerged.id,
          createdFromEnquiryId: null,
        });
        await partyRepo.putOrganisations(ctx, [orgMerged, orgSurv]);
        await partyRepo.putOrganisation(ctx, {
          ...orgMerged,
          // Even if merged points to survivor as parent, survivor must NOT inherit itself as parent
          parentOrganisationId: orgSurv.id,
        });
        const orgChild = makeMinimalOrganisation('O-S021-SUB', 'Vortex Regional Subsidiary Ltd', {
          parentOrganisationId: orgMerged.id,
        });
        await partyRepo.putOrganisation(ctx, orgChild);
        await addNoteToRecord('organisation', orgMerged.id, 'Historical org note', 'P-000001');

        const orgMergeHist = await executeMerge('organisation', orgSurv.id, orgMerged.id, 'P-000001');
        expect(orgMergeHist.code).toBeUndefined();

        const survOrgAfter = (await freshPartyRepo.getOrganisationById<Organisation>(
          ctx,
          orgSurv.id,
        ))!;
        expect(survOrgAfter.parentOrganisationId).toBeNull();
        expect(survOrgAfter.createdFromEnquiryId).toBe(enqId);
        const childOrgAfter = (await freshPartyRepo.getOrganisationById<Organisation>(
          ctx,
          orgChild.id,
        ))!;
        expect(childOrgAfter.parentOrganisationId).toBe(orgSurv.id);
      });
    } finally {
      await freshPoolMgr.closeAllPools();
      await resetAllDemoData('P-000001', testDataResetContext());
    }
  });

  it('4. Two-tenant PostgreSQL isolation (P8): separate databases, forged claim rejections, unauthenticated UNAUTHENTICATED (code + message), tampered IDs, cross-tenant merge denial, and zero cross-tenant conflict leakage', async () => {
    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: 'tenant-alpha', environment: 'test' },
        { tenantId: 'tenant-bravo', environment: 'test' },
      ],
    });

    // Forged tenant / unverified token rejections
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: false as unknown as true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha-invented.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-s021-forged-1',
      }),
    ).toThrow(/TENANCY_AUTH_ERROR/i);

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'attacker',
          tenantId: 'tenant-alpha',
          name: 'Attacker',
          email: 'attacker@alpha-invented.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-s021-forged-2',
        untrustedRequestTenantOverride: 'tenant-bravo',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED/i);

    // Unauthenticated server actions must fail closed with both code and message
    setTestEntraSessionOverride(null);
    const unauthMerge = await mergeRecordsAction('person', 'P-000001', 'P-000002');
    expect(unauthMerge).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
      message: expect.any(String),
    });
    expect(unauthMerge.message!.length).toBeGreaterThan(0);

    await expect(
      saveMatterAction(
        {
          title: 'Unauthenticated Matter',
          clientId: 'P-000001',
          practiceAreaId: 'practice_area.commercial_property',
          workTypeSubcategoryId: 'work_type.commercial_property_sales_and_purchases',
        },
        { saveMode: 'draft' },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: expect.any(String),
    });

    await expect(
      savePersonAction({ firstName: 'Unauth', surname: 'Person' }, {}),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: expect.any(String),
    });
    setTestEntraSessionOverride(undefined);

    const alpha = await seedTenantDbFromStore('tenant-alpha', 'Alpha Legal LLP');
    const bravo = await seedTenantDbFromStore('tenant-bravo', 'Bravo Legal LLP');
    const freshPoolMgr = new TenantPostgresPoolManager();

    try {
      // Positive control in Tenant Alpha: save canonical person + opposing matter
      setActiveTenantConfigForTesting(alpha.rawConfig, {});
      let alphaPersonId = '';
      let alphaOrgId = '';
      let alphaMatterId = '';

      await runWithActiveActorSession(alpha.session, async () => {
        const pRes = await savePersonRecord(
          {
            firstName: 'Rowena',
            surname: 'SharedAliasTest',
            otherNames: [{ id: 'on-alpha-1', name: 'Rowena CrossCheck', typeId: null }],
            relationshipRoleIds: ['person_role.client_contact'],
            emails: [
              {
                id: 'em-alpha-1',
                address: 'identical.contact@cross-tenant.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { byId: 'P-000001' },
        );
        expect(pRes.errors).toBeUndefined();
        alphaPersonId = `ALPHA-ONLY-${pRes.person.id}`;
        await getPartyRepository().putPerson(alpha.ctx, {
          ...pRes.person,
          id: alphaPersonId,
        });

        const oRes = await saveOrganisationRecord(
          {
            legalName: 'Alpha Exclusive Industries Ltd',
            relationshipTypeIds: ['organisation_relationship_type.counterparty'],
          },
          { byId: 'P-000001' },
        );
        alphaOrgId = `ALPHA-ORG-${oRes.organisation.id}`;
        await getPartyRepository().putOrganisation(alpha.ctx, {
          ...oRes.organisation,
          id: alphaOrgId,
        });

        const mTmpl = (await getMatterRepository().getMatterById<Matter>(alpha.ctx, 'M-000001', {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }))!;
        const mBase = stripMatterKeys(mTmpl, [
          'id',
          'rowVersion',
          'engagementLetterStatus',
          'engagementLetterSignedAt',
        ]);
        const mRes = await saveMatterRecord(
          {
            ...mBase,
            matterNumber: 'DRAFT',
            title: 'Alpha Restricted Opposing Matter',
            clientId: 'O-000001',
            parties: [
              {
                id: 'mp-alpha-op',
                name: 'Rowena SharedAliasTest',
                role: 'Opponent',
                relationshipCode: 'OP',
                capacityCodes: ['CAP_DEFENDANT'],
                alignment: 'adverse',
                entityType: 'person',
                linkedRecordId: alphaPersonId,
              },
            ],
            conflictCheckRecord: undefined,
          },
          { byId: 'P-000001', saveMode: 'draft' },
        );
        alphaMatterId = mRes.matter!.id;
      });

      // Verify positive Tenant A persistence through fresh TenantPostgresPoolManager
      const freshPartyRepo = new TenantPartyRepository({ poolManager: freshPoolMgr });
      const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
      const alphaPersistedPerson = await freshPartyRepo.getPersonById<Person>(
        alpha.ctx,
        alphaPersonId,
      );
      expect(alphaPersistedPerson).not.toBeNull();
      expect(alphaPersistedPerson?.surname).toBe('SharedAliasTest');

      // Switch to Tenant Bravo:
      // 1) Tampered IDs from Alpha return null in Bravo
      expect(await freshPartyRepo.getPersonById(bravo.ctx, alphaPersonId)).toBeNull();
      expect(await freshPartyRepo.getOrganisationById(bravo.ctx, alphaOrgId)).toBeNull();
      expect(
        await freshMatterRepo.getMatterById(bravo.ctx, alphaMatterId, {
          viewerUserId: 'P-000001',
          hasRestrictedMatterAccess: true,
        }),
      ).toBeNull();

      // 2) Cross-tenant merge attempt targeting Alpha record inside Bravo fails closed
      setActiveTenantConfigForTesting(bravo.rawConfig, {});
      await runWithActiveActorSession(bravo.session, async () => {
        const bravoSurvivor = (
          await savePersonRecord(
            {
              firstName: 'BravoOnly',
              surname: 'Target',
              relationshipRoleIds: ['person_role.client_contact'],
            },
            { byId: 'P-000001' },
          )
        ).person;

        const crossMerge = await executeMerge(
          'person',
          bravoSurvivor.id,
          alphaPersonId,
          'P-000001',
        );
        expect(crossMerge.code).toBe('FORBIDDEN');

        // 3) Conflict search in Bravo MUST find ZERO Alpha matters or Alpha people/organisations
        const [bravoPeople, bravoOrgs, bravoLinks, bravoMatters, bravoEnqs] = await Promise.all([
          getPartyRepository().listAllPeople<Person>(bravo.ctx),
          getPartyRepository().listAllOrganisations<Organisation>(bravo.ctx),
          getPartyRepository().listAllLinks<PersonOrganisationLink>(bravo.ctx),
          getMatterRepository().listAllMattersUnfiltered<Matter>(bravo.ctx),
          getIntakeQuoteRepository().listAllEnquiriesUnfiltered<Enquiry>(bravo.ctx),
        ]);

        const bravoSearch = runEnquiryConflictSearch(
          {
            firstName: 'Rowena',
            lastName: 'SharedAliasTest',
            otherPartiesNamed: 'Alpha Exclusive Industries Ltd',
            email: 'identical.contact@cross-tenant.example',
          },
          bravoPeople,
          bravoOrgs,
          bravoMatters,
          [],
          bravoEnqs,
          null,
          bravoLinks,
          () => true,
          bravo.ctx.tenantId,
        );
        expect(bravoSearch.allConflicts).toEqual([]);
        expect(bravoSearch.hasBlockingConflict).toBe(false);

        const bravoMatterSearch = await runMatterConflictSearchRecord(
          {
            parties: [
              {
                id: 'bravo-search-1',
                name: 'Alpha Exclusive Industries Ltd',
                entityType: 'organisation',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'bravo-search-2',
                name: 'Rowena SharedAliasTest',
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
            ],
          },
          'P-000001',
        );
        expect(
          bravoMatterSearch.matches.some(
            (m) => m.matchedRecordId === alphaPersonId || m.matchedRecordId === alphaOrgId,
          ),
        ).toBe(false);
      });
    } finally {
      setActiveTenantConfigForTesting(null);
      await freshPoolMgr.closeAllPools();
      await getGlobalTenantPostgresPoolManager().closeAllPools();
    }
  });
});
