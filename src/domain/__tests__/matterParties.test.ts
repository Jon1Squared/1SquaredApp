import { describe, expect, it } from 'vitest';
import {
  buildDefaultMatterPartyTaxonomy,
  CAPACITY_GROUPS,
  computeMatterPartyUsageCounts,
  getAvailableCapacitiesForParty,
  getProfilesForWorkType,
  getRelationshipAlignment,
  getWorkTypeClientCapacities,
  isCapacityTypicalForWorkType,
  isClientCapacityRequiredForWorkType,
  mapLegacyPartyRoleToTwoField,
  migrateMatterPartiesToTwoFieldModel,
  SEED_CAPACITIES,
  SEED_RELATIONSHIPS,
  WORK_TYPE_PROFILES,
} from '@/domain/matterParties';
import { buildSeedLists } from '@/seed/lists';
import { buildDemoData } from '@/seed/demo';
import type { Matter } from '@/domain/types';

describe('matterParties two-field taxonomy & migration', () => {
  const { values } = buildSeedLists();
  const taxonomy = buildDefaultMatterPartyTaxonomy(values);

  it('seeds all 8 relationships and 11 work type profiles', () => {
    expect(SEED_RELATIONSHIPS.map((r) => r.code)).toEqual([
      'CL',
      'JC',
      'CC',
      'OP',
      'CP',
      'CO',
      'TP',
      'NO',
    ]);
    expect(WORK_TYPE_PROFILES.map((p) => p.code)).toEqual([
      'ALL',
      'LIT',
      'EMP',
      'PROP',
      'CORP',
      'PC',
      'FAM',
      'INS',
      'REG',
      'CRIM',
      'CON',
    ]);
  });

  it('seeds all 70 capacities across 7 capacity groups', () => {
    expect(CAPACITY_GROUPS).toHaveLength(7);
    expect(SEED_CAPACITIES).toHaveLength(70);
    for (const cap of SEED_CAPACITIES) {
      expect(cap.code).toBeTruthy();
      expect(cap.label).toBeTruthy();
      expect(CAPACITY_GROUPS).toContain(cap.group);
      expect(cap.allowedRelationships.length).toBeGreaterThan(0);
      expect(cap.profiles.length).toBeGreaterThan(0);
    }
  });

  it('maps every active work type subcategory to at least one profile', () => {
    const subcategories = values.filter((v) => v.listKey === 'work_type' && Boolean(v.parentId));
    expect(subcategories.length).toBeGreaterThan(0);
    for (const sub of subcategories) {
      const profiles = getProfilesForWorkType(taxonomy, sub.id);
      expect(profiles.length).toBeGreaterThan(0);
    }

    const landlordTenant = subcategories.find((v) => v.label === 'Landlord & tenant')!;
    expect(getProfilesForWorkType(taxonomy, landlordTenant.id)).toEqual(['PROP', 'LIT']);

    const probate = subcategories.find((v) =>
      v.label.toLowerCase().includes('estate administration'),
    )!;
    expect(getProfilesForWorkType(taxonomy, probate.id)).toEqual(['PC']);

    const empTribunal = subcategories.find(
      (v) => v.id === 'work_type.employment_and_hr_tribunal_claims',
    )!;
    expect(getProfilesForWorkType(taxonomy, empTribunal.id)).toEqual(['EMP', 'LIT']);
  });

  it('filters capacities by relationship and work type profile, and supports showAllCapacities', () => {
    const landlordTenant = values.find(
      (v) => v.listKey === 'work_type' && v.parentId && v.label === 'Landlord & tenant',
    )!;
    const probate = values.find(
      (v) =>
        v.listKey === 'work_type' &&
        v.parentId &&
        v.label.toLowerCase().includes('estate administration'),
    )!;

    // Client capacities on Landlord & tenant should include Landlord and Tenant
    const ltClientCaps = getWorkTypeClientCapacities(taxonomy, landlordTenant.id, 'CL');
    expect(ltClientCaps.map((c) => c.code)).toContain('CAP_LANDLORD');
    expect(ltClientCaps.map((c) => c.code)).toContain('CAP_TENANT');
    expect(isClientCapacityRequiredForWorkType(taxonomy, landlordTenant.id)).toBe(true);

    // Probate OP capacities should include Beneficiary/Executor, not Employer
    const probateOpCaps = getAvailableCapacitiesForParty({
      taxonomy,
      relationshipCode: 'OP',
      workTypeSubcategoryId: probate.id,
      showAllCapacities: false,
    });
    expect(probateOpCaps.map((c) => c.code)).toContain('CAP_BENEFICIARY');
    expect(probateOpCaps.map((c) => c.code)).not.toContain('CAP_EMPLOYER');

    // With showAllCapacities = true, Employer (allowed for OP) becomes available
    const allOpCaps = getAvailableCapacitiesForParty({
      taxonomy,
      relationshipCode: 'OP',
      workTypeSubcategoryId: probate.id,
      showAllCapacities: true,
    });
    expect(allOpCaps.map((c) => c.code)).toContain('CAP_EMPLOYER');

    // Changing work type flags non-typical capacities
    expect(isCapacityTypicalForWorkType(taxonomy, 'CAP_LANDLORD', probate.id)).toBe(false);
    expect(isCapacityTypicalForWorkType(taxonomy, 'CAP_SOLICITOR', probate.id)).toBe(true);
  });

  it('computes alignment from relationship code', () => {
    expect(getRelationshipAlignment('CL')).toBe('aligned');
    expect(getRelationshipAlignment('JC')).toBe('aligned');
    expect(getRelationshipAlignment('CC')).toBe('aligned');
    expect(getRelationshipAlignment('OP')).toBe('adverse');
    expect(getRelationshipAlignment('CP')).toBe('adverse');
    expect(getRelationshipAlignment('CO')).toBe('adverse');
    expect(getRelationshipAlignment('TP')).toBe('third_party');
    expect(getRelationshipAlignment('NO')).toBe('neutral');
  });

  it('migrates legacy third-party roles and produces a migration report without deleting old values', () => {
    const sampleValues = structuredClone(values);
    const sampleMatters: Matter[] = [
      {
        id: 'M-TEST-1',
        recordType: 'matter',
        recordOwnerId: 'P-000001',
        recordStatusId: 'RS-1',
        createdById: 'P-000001',
        createdAt: '2026-10-01',
        updatedById: 'P-000001',
        updatedAt: '2026-10-01',
        sourceId: 'SRC-1',
        lastVerifiedAt: '2026-10-01',
        tags: [],
        duplicateStatusId: 'DUP-1',
        notDuplicateOf: [],
        possibleMatchIds: [],
        mergedIntoId: null,
        lastInteractionAt: '2026-10-01',
        customFields: {},
        matterNumber: 'PEN001-0001',
        title: 'Lease renewal — Unit 4',
        shortDescription: '',
        clientId: 'O-000001',
        additionalClientIds: [],
        parentMatterId: null,
        relatedMatterIds: [],
        matterStatusId: 'MS-1',
        sourceEnquiryId: null,
        practiceAreaId: 'PA-1',
        workTypeSubcategoryId: 'SUB-1',
        typeBadge: 'Transactional',
        matterTypeId: 'MT-1',
        clientTierId: null,
        clientSectorId: null,
        billingBasisId: 'BB-1',
        riskRatingId: 'RR-1',
        matterSizeId: null,
        jurisdictionGroupId: 'JG-1',
        jurisdictionIds: [],
        governingLawId: null,
        forumCourt: '',
        responsiblePartnerId: 'P-000001',
        supervisingPartnerId: 'P-000001',
        leadFeeEarnerId: 'P-000002',
        teamMemberIds: [],
        relationshipPartnerId: 'P-000001',
        instructingContactId: 'P-000011',
        billingContactId: null,
        referrerTypeId: null,
        referrerContactId: null,
        parties: [
          {
            id: 'MP-1',
            name: 'Coastline Outdoor Ltd',
            role: 'Opponent',
            linkedRecordId: 'O-000014',
          },
          {
            id: 'MP-2',
            name: 'Morgan Price Solicitors',
            role: 'Opposing solicitor',
            linkedRecordId: 'O-000008',
          },
          {
            id: 'MP-3',
            name: 'County Court at Cardiff',
            role: 'Court / tribunal',
            linkedRecordId: null,
          },
        ],
        conflictCheckStatus: 'Cleared',
        conflictCheckDate: '2026-10-01',
        conflictClearedById: 'P-000001',
        conflictNotes: '',
        amlStatus: 'Complete',
        amlCompletedAt: null,
        sourceOfFundsVerified: 'Verified',
        sourceOfWealthVerified: 'N/A',
        engagementLetterStatus: 'Signed',
        engagementLetterSentAt: null,
        engagementLetterSignedAt: null,
        feeEstimateGbp: null,
        agreedFeeCapGbp: null,
        retainerMoniesOnAccountGbp: null,
        stageId: 'ST-1',
        milestoneId: null,
        enquiryReceivedAt: '2026-10-01',
        openedAt: '2026-10-01',
        targetCompletionAt: null,
        completedAt: null,
        closedAt: null,
        retentionPeriod: '6 years',
        destructionDueAt: null,
        fieldValues: {},
      },
    ];

    const migrated = migrateMatterPartiesToTwoFieldModel(
      sampleValues,
      sampleMatters,
      taxonomy,
    );

    // Legacy values are marked inactive, not deleted
    const legacyRoleValues = migrated.values.filter((v) => v.listKey === 'matter_party_role');
    expect(legacyRoleValues.length).toBeGreaterThanOrEqual(14);
    expect(legacyRoleValues.every((v) => v.active === false)).toBe(true);

    // Migrated parties on the matter have relationshipCode + capacityCodes
    expect(migrated.matters[0].parties[0].relationshipCode).toBe('OP');
    expect(migrated.matters[0].parties[0].needsCapacityPrompt).toBe(true);
    expect(migrated.matters[0].parties[1].relationshipCode).toBe('CO');
    expect(migrated.matters[0].parties[1].capacityCodes).toEqual(['CAP_SOLICITOR']);
    expect(migrated.matters[0].parties[2].relationshipCode).toBe('NO');
    expect(migrated.matters[0].parties[2].capacityCodes).toEqual(['CAP_COURT_TRIBUNAL']);

    expect(migrated.report.migratedMatterPartiesCount).toBe(3);
    expect(migrated.report.deactivatedLegacyRolesCount).toBeGreaterThan(0);

    const usage = computeMatterPartyUsageCounts(migrated.matters);
    expect(usage.byRelationshipCode['OP']).toBe(1);
    expect(usage.byRelationshipCode['CO']).toBe(1);
    expect(usage.byCapacityCode['CAP_SOLICITOR']).toBe(1);
  });

  it('maps each of the 14 legacy roles from Section 1.5 accurately', () => {
    expect(mapLegacyPartyRoleToTwoField('Client representative')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_REPRESENTATIVE'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Decision-maker')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_DECISION_MAKER'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Opponent')).toMatchObject({
      relationshipCode: 'OP',
      capacityCodes: [],
      needsCapacityPrompt: true,
    });
    expect(mapLegacyPartyRoleToTwoField('Opposing solicitor')).toMatchObject({
      relationshipCode: 'CO',
      capacityCodes: ['CAP_SOLICITOR'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Counterparty')).toMatchObject({
      relationshipCode: 'CP',
      capacityCodes: [],
      needsCapacityPrompt: true,
    });
    expect(mapLegacyPartyRoleToTwoField('Barrister / counsel')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_BARRISTER_COUNSEL'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Expert witness')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_EXPERT_WITNESS'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Professional adviser')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_OTHER_PROFESSIONAL_ADVISER'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Witness')).toMatchObject({
      relationshipCode: 'TP',
      capacityCodes: ['CAP_WITNESS_OF_FACT'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Court / tribunal')).toMatchObject({
      relationshipCode: 'NO',
      capacityCodes: ['CAP_COURT_TRIBUNAL'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Regulator / public authority')).toMatchObject({
      relationshipCode: 'NO',
      capacityCodes: ['CAP_REGULATOR'],
      needsCapacityPrompt: false,
    });
    expect(mapLegacyPartyRoleToTwoField('Other party')).toMatchObject({
      relationshipCode: 'TP',
      capacityCodes: [],
      needsCapacityPrompt: true,
    });
    expect(mapLegacyPartyRoleToTwoField('Client contact')).toMatchObject({
      relationshipCode: 'CC',
      capacityCodes: ['CAP_REPRESENTATIVE'],
      needsCapacityPrompt: false,
    });
  });

  it('migrates all seed demo matters and produces complete migration report counts', () => {
    const seedLists = buildSeedLists();
    const demo = buildDemoData(new Date('2026-10-22T09:00:00Z'));
    const result = migrateMatterPartiesToTwoFieldModel(
      seedLists.values,
      demo.matters,
      taxonomy,
    );
    expect(result.report.deactivatedLegacyRolesCount).toBe(14);
    expect(result.report.migratedMatterPartiesCount).toBe(15);
    expect(result.report.countsByMapping['Instructing client'].count).toBe(16);
  });
});
