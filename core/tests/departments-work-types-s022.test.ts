import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_REQUIRED_SCHEMA_VERSION,
  HomeRoleKey,
  TenantAuditRepository,
  TenantCatalogueRepository,
  TenantMatterRepository,
  TenantMigrationRunner,
  TenantPostgresPoolManager,
  TenantTaskWorkflowRepository,
  WorkTypesConfigSchema,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  validateWorkTypesConfig,
  type TenantContext,
  type WorkTypesConfiguration,
} from '../src/index';
import { provisionPostgresClusterRolesAndDatabases } from '../src/tenancy/postgresAdminBootstrap';
import { createDirectMigrationClient } from '../src/tenancy/postgresPoolManager';
import {
  saveMatterAction,
  saveWorkTypesConfigAction,
  updateMatterLifecycleStatusAction,
} from '@/app/actions';
import {
  MATTER_RISK_SECTIONS,
  resolveMatterRiskSections,
} from '@/domain/matterOpeningRecord';
import { isWorkingAtFirm } from '@/domain/employment';
import {
  DEFAULT_LEGAL_ENTITY_ID,
  DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP,
  isWorkTypeChoiceActive,
  resolveActiveWorkTypeHierarchy,
} from '@/domain/orgStructure';
import type { ChoiceValue, Matter, Task } from '@/domain/types';
import {
  calculateDestructionDate,
  formatRetentionPeriodLabel,
  resolveWorkTypeRetention,
  resolveWorkTypeRiskQuestions,
} from '@/domain/workTypeConfig';
import {
  flushStagedAuditEntries,
  getActiveTenantRawBaseConfig,
  getCatalogueRepository,
  getMatterRepository,
  getTaskWorkflowRepository,
  runWithAuditStagingScope,
  setActiveTenantConfigForTesting,
  stageAuditEntry,
} from '@/platform/tenantRuntime';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import {
  createCleanDeploymentStore,
  createSeedStore,
} from '@/seed/seedStoreBuilder';
import {
  getAppSnapshot,
  getKeyDateRepository,
  prepareEnquiryConversion,
  resetAllDemoData,
  saveMatterRecord,
  saveOrgStructure,
  saveWorkTypesConfigRecord,
  updateMatterConflictRecord,
  updateMatterLifecycleStatusRecord,
} from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import {
  auditEntriesSince,
  markAuditPosition,
  runAsTestActor,
  setTestActorSession,
  testTenantCtx,
} from '@/server/testSupport/auditTestSupport';
import { testDataResetContext } from '@/test/testTenantContexts';

const BASE_LOW_RISK_ANSWERS: Record<string, string> = {
  inScopeMlr: 'Yes, in scope',
  instructionMakesSense: 'Yes',
  moveMoneyWithoutTransaction: 'No',
  clientRelationshipStatus: 'Existing, CDD current',
  clientDealingMethod: 'Met in person',
  complexOwnershipStructure: 'No',
  thirdPartyInstructions: 'No',
  highRiskJurisdictionLink: 'No',
  crossBorderFundsOrAssets: 'No',
  holdClientMoney: 'No',
  matterFundingSource: 'The client',
  sourceOfFundsUnderstood: 'Yes',
  unusualPaymentRequests: 'No',
  regularTeamWork: 'Yes',
  capacityAndSupervision: 'Yes',
  imminentDeadlines: 'No',
  feeBasis: 'Fixed fee',
  moneyOnAccountRequested: 'Yes',
  valueOrExposure: 'Within normal range',
  limitationOfLiabilityProposed: 'No',
  reputationOrEthicalConcerns: 'No',
  sensitiveSectorOrMedia: 'No',
  specialCategoryDataOrConfidentiality: 'No',
};

function makeVerifiedTenantCtx(
  tenantId: string,
  actorId = 'P-000004',
  roles: readonly string[] = ['admin', 'partner', 'fee_earner', 'risk_compliance'],
  mfaVerified = true,
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      name: `Test Actor ${actorId}`,
      email: `${actorId.toLowerCase()}@${tenantId}.example`,
      tenantId,
      roles,
      mfaVerified,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s022-${tenantId}-${actorId}`,
  });
}

function cloneBaseWorkTypesConfig(): WorkTypesConfiguration {
  const raw = getActiveTenantRawBaseConfig();
  return structuredClone(raw.workTypes as WorkTypesConfiguration);
}

async function queryDirectSql<T extends Record<string, unknown>>(
  ctx: TenantContext,
  sqlText: string,
  params: readonly unknown[],
): Promise<T[]> {
  const client = await createDirectMigrationClient({ ctx });
  try {
    const res = await client.query<T>(sqlText, [...params]);
    return res.rows;
  } finally {
    await client.end();
  }
}

describe('S0-22: Departments & Work Types (Schema-Driven Auto-Tasks, Risk Scoring & Retention Dates)', () => {
  const openPoolManagers: TenantPostgresPoolManager[] = [];

  afterEach(async () => {
    setTestActorSession(null);
    setActiveTenantConfigForTesting(null);
    while (openPoolManagers.length > 0) {
      const mgr = openPoolManagers.pop();
      if (mgr) {
        await mgr.closeAllPools();
      }
    }
  });

  it('1. Config schema & Zod engine: validates workTypes, reserves workTypeCapOverrides, preserves overlays, and rejects invalid definitions', () => {
    const baseRaw = getActiveTenantRawBaseConfig();
    const baseCfg = loadAndValidateTenantConfig(baseRaw, {}, 'test', 'multi_tenant');

    expect(baseCfg.workTypes).toBeDefined();
    expect(baseCfg.workTypes?.defaults.retention.retentionYears).toBe(6);
    expect(baseCfg.workTypes?.items.length).toBeGreaterThanOrEqual(4);

    // Overlay merges and preserves workTypes + active workTypeCapOverrides (S0-28b)
    const overlaid = loadAndValidateTenantConfig(
      baseRaw,
      {
        workTypes: {
          items: [
            {
              workTypeId: 'work_type.corporate_and_commercial_shareholder_agreements',
              practiceAreaId: 'work_type.corporate_and_commercial',
              active: true,
              autoTaskTemplates: [],
              riskQuestions: [],
              retention: {
                retentionYears: 9,
                baseline: 'closed_on',
                allowMatterOverride: false,
                statutoryNote: 'Shareholder governance nine-year retention',
              },
              feeArrangementCapCategories: {
                conditional_fee_agreement: 'cfa_personal_injury',
              },
              workTypeCapOverrides: [
                {
                  capCategoryKey: 'cfa_personal_injury',
                  maxPercent: 20,
                  capBaseKey:
                    'general_damages_and_past_pecuniary_losses_net_of_benefits',
                },
              ],
            },
          ],
        },
      },
      'test',
      'multi_tenant',
    );

    const addedItem = overlaid.workTypes?.items.find(
      (item) =>
        item.workTypeId ===
        'work_type.corporate_and_commercial_shareholder_agreements',
    );
    expect(addedItem?.retention?.retentionYears).toBe(9);
    expect(addedItem?.feeArrangementCapCategories).toEqual({
      conditional_fee_agreement: 'cfa_personal_injury',
    });
    expect(addedItem?.workTypeCapOverrides).toEqual([
      {
        capCategoryKey: 'cfa_personal_injury',
        maxPercent: 20,
        capBaseKey: 'general_damages_and_past_pecuniary_losses_net_of_benefits',
      },
    ]);

    // Reject zero, negative, fractional, and >100 retentionYears
    for (const badYears of [0, -2, 101, 5.5]) {
      expect(() =>
        validateWorkTypesConfig({
          defaults: {
            ...baseCfg.workTypes!.defaults,
            retention: { retentionYears: badYears, baseline: 'closed_on' },
          },
          items: [],
        }),
      ).toThrow();
    }

    // Reject negative dueWorkingDaysOffset
    expect(() =>
      WorkTypesConfigSchema.parse({
        defaults: {
          autoTaskTemplates: [
            {
              id: 'bad-offset',
              title: 'Invalid offset task',
              trigger: 'matter_open',
              dueWorkingDaysOffset: -1,
              priorityId: 'task_priority.normal',
              ownerRoleKey: 'fee_earner',
            },
          ],
          retention: { retentionYears: 6, baseline: 'closed_on' },
        },
        items: [],
      }),
    ).toThrow();

    // Reject invalid trigger & unknown RBAC ownerRoleKey
    expect(() =>
      validateWorkTypesConfig({
        defaults: {
          autoTaskTemplates: [
            {
              id: 'bad-trigger',
              title: 'Invalid trigger',
              trigger: 'matter_close',
              dueWorkingDaysOffset: 1,
              priorityId: 'task_priority.normal',
              ownerRoleKey: 'fee_earner',
            },
          ],
          retention: { retentionYears: 6, baseline: 'closed_on' },
        },
        items: [],
      }),
    ).toThrow();

    expect(() =>
      validateWorkTypesConfig({
        defaults: {
          autoTaskTemplates: [
            {
              id: 'bad-role',
              title: 'Unknown role task',
              trigger: 'matter_open',
              dueWorkingDaysOffset: 1,
              priorityId: 'task_priority.normal',
              ownerRoleKey: 'made_up_role' as HomeRoleKey,
            },
          ],
          retention: { retentionYears: 6, baseline: 'closed_on' },
        },
        items: [],
      }),
    ).toThrow();

    // Reject malformed riskQuestions (weight out of range, <2 options, negative score)
    expect(() =>
      validateWorkTypesConfig({
        defaults: {
          autoTaskTemplates: [],
          riskQuestions: [
            {
              id: 'badWeight',
              sectionKey: 'work_type',
              prompt: 'Bad weight?',
              weight: 15,
              options: [
                { value: 'a', label: 'A', score: 1, riskLevel: 'low' },
                { value: 'b', label: 'B', score: 2, riskLevel: 'high' },
              ],
            },
          ],
          retention: { retentionYears: 6, baseline: 'closed_on' },
        },
        items: [],
      }),
    ).toThrow();

    expect(() =>
      validateWorkTypesConfig({
        defaults: {
          autoTaskTemplates: [],
          riskQuestions: [
            {
              id: 'tooFewOpts',
              sectionKey: 'work_type',
              prompt: 'Only one option?',
              weight: 1,
              options: [{ value: 'only', label: 'Only', score: 1, riskLevel: 'low' }],
            },
          ],
          retention: { retentionYears: 6, baseline: 'closed_on' },
        },
        items: [],
      }),
    ).toThrow();
  });

  it('2. Driver (a): idempotent PG auto-tasks on BOTH direct opening and conflict/costs-approved opening, fallback hierarchy & staff-matter ACLs', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignored, ...matterTemplate } = baseMatter;
    void _ignored;

    const twRepo = getTaskWorkflowRepository();

    await runAsTestActor('P-000001', async () => {
      // (A) Direct opening on Commercial Property triggers Commercial Property templates idempotently
      const directRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          title: 'S0-22 Direct Commercial Property Opening',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
          leadFeeEarnerId: 'P-000002',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );

      expect(directRes.errors).toBeUndefined();
      const directMatter = directRes.matter!;
      expect(directMatter.matterStatusId).toBe('matter_status.active');

      const directTasksFirst = await twRepo.listVisibleTasks<Task>(ctx, 'P-000001', {
        linkedRecordType: 'matter',
        linkedRecordId: directMatter.id,
      });
      const autoTasksFirst = directTasksFirst.filter(
        (t) => t.autoTrigger === 'work_type_auto_task',
      );
      expect(autoTasksFirst.map((t) => t.idempotencyKey).sort()).toEqual([
        `worktype-open:${directMatter.id}:cp-source-of-funds`,
        `worktype-open:${directMatter.id}:cp-title-and-searches`,
      ]);
      const searchesTask = autoTasksFirst.find((t) =>
        t.idempotencyKey?.endsWith(':cp-title-and-searches'),
      )!;
      expect(searchesTask.assignedPersonId).toBe('P-000002');
      expect(searchesTask.priorityId).toBe('task_priority.high');

      // Re-saving same active matter is idempotent (no duplicate auto-tasks)
      const resaveRes = await saveMatterRecord(
        {
          ...directMatter,
          title: 'S0-22 Direct Commercial Property Opening Updated',
        },
        {
          id: directMatter.id,
          byId: 'P-000001',
          saveMode: 'submit_cleared',
          expectedRowVersion: directMatter.rowVersion ?? 1,
        },
      );
      expect(resaveRes.errors).toBeUndefined();
      const directTasksSecond = await twRepo.listVisibleTasks<Task>(ctx, 'P-000001', {
        linkedRecordType: 'matter',
        linkedRecordId: directMatter.id,
      });
      expect(
        directTasksSecond.filter((t) => t.autoTrigger === 'work_type_auto_task'),
      ).toHaveLength(autoTasksFirst.length);

      // (B) Conflict-referred matter must NOT create opening auto-tasks until Risk & Compliance approves it
      const referredRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          title: 'S0-22 Conflict Referred Employment Tribunal Matter',
          practiceAreaId: 'work_type.employment_and_hr',
          workTypeSubcategoryId: 'work_type.employment_and_hr_tribunal_claims',
          leadFeeEarnerId: 'P-000002',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000003',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          conflictCheckRecord: {
            ...(matterTemplate.conflictCheckRecord ?? {
              parties: [],
              matches: [],
              runs: [],
              comments: [],
            }),
            status: 'Referred',
            outcomeLabel: 'Referred to risk for review',
            declarationConfirmed: true,
            reviewerMessage: 'Potential party name match requires Risk & Compliance sign-off.',
            lastRunAtDisplay: '2026-11-15 10:00',
            lastRunById: 'P-000001',
            lastRunByName: 'Rhian Morgan',
          },
          fieldValues: {
            riskAssessment: {
              answers: { ...BASE_LOW_RISK_ANSWERS },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_referred' },
      );

      expect(referredRes.errors).toBeUndefined();
      const referredMatter = referredRes.matter!;
      expect(referredMatter.conflictCheckStatus).toBe('Pending conflict review');
      expect(referredMatter.conflictCheckRecord?.status).toBe('Referred');

      const tasksBeforeApproval = await twRepo.listAllTasksUnfiltered<Task>(ctx);
      expect(
        tasksBeforeApproval.filter(
          (t) =>
            t.autoTrigger === 'work_type_auto_task' &&
            t.linkedRecords.some(
              (l) => l.recordType === 'matter' && l.recordId === referredMatter.id,
            ),
        ),
      ).toHaveLength(0);

      // Risk & Compliance (P-000003) approves conflict -> triggers work-type opening tasks
      await runAsTestActor('P-000003', async () => {
        const approveRes = await updateMatterConflictRecord(
          referredMatter.id,
          {
            ...(referredMatter.conflictCheckRecord ?? {
              status: 'Referred',
              outcomeLabel: 'Referred to risk for review',
              declarationConfirmed: true,
              reviewerMessage: '',
              lastRunAtDisplay: '2026-11-15 10:00',
              lastRunById: 'P-000001',
              lastRunByName: 'Rhian Morgan',
              matches: [],
              parties: [],
              runs: [],
              comments: [],
            }),
            status: 'Approved',
            outcomeLabel: 'Approved by Risk & Compliance',
            reviewerMessage: 'Approved following ethical barrier check.',
          },
          'P-000003',
        );
        expect(approveRes.errors).toBeUndefined();
        expect(approveRes.matter?.conflictCheckStatus).toBe('Approved by Risk & Compliance');
        expect(approveRes.matter?.conflictCheckRecord?.status).toBe('Approved');
      });

      const tasksAfterApproval = await twRepo.listAllTasksUnfiltered<Task>(ctx);
      const tribunalAutoTasks = tasksAfterApproval.filter(
        (t) =>
          t.autoTrigger === 'work_type_auto_task' &&
          t.linkedRecords.some(
            (l) => l.recordType === 'matter' && l.recordId === referredMatter.id,
          ),
      );
      expect(tribunalAutoTasks.map((t) => t.idempotencyKey).sort()).toEqual([
        `worktype-open:${referredMatter.id}:emp-acas-limitation-diary`,
      ]);

      // (C) Enquiry conversion opening (ENQ-000004 is Commercial Property)
      const prepRes = await prepareEnquiryConversion('ENQ-000004', {}, 'P-000001');
      expect(prepRes.ok).toBe(true);
      const enqConvRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          sourceEnquiryId: 'ENQ-000004',
          clientId: prepRes.clientId!,
          title: 'S0-22 Converted Commercial Property Matter',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(enqConvRes.errors).toBeUndefined();
      const convTasks = (await twRepo.listAllTasksUnfiltered<Task>(ctx)).filter(
        (t) =>
          t.autoTrigger === 'work_type_auto_task' &&
          t.linkedRecords.some(
            (l) => l.recordType === 'matter' && l.recordId === enqConvRes.matter!.id,
          ),
      );
      expect(convTasks.some((t) => t.idempotencyKey?.endsWith(':cp-title-and-searches'))).toBe(
        true,
      );

      // (D) Fallback hierarchy: Private Client Wills (no override in base.json) resolves firm defaults,
      // and a restricted Staff Matter locks auto-tasks to restrictedAccessUserIds (server-derived when client is an active employee)
      const staffClient = seed.people.find(
        (p) =>
          p.isEmployee &&
          isWorkingAtFirm(p) &&
          p.id !== 'P-000001' &&
          p.id !== 'P-000002' &&
          p.id !== 'P-000003',
      )!;
      const fallbackRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          title: 'S0-22 Fallback + Restricted Staff Matter',
          clientId: staffClient.id,
          additionalClientIds: [],
          practiceAreaId: 'work_type.private_client',
          workTypeSubcategoryId: 'work_type.private_client_wills_and_codicils',
          leadFeeEarnerId: 'P-000001',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          teamMemberIds: [],
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: { ...BASE_LOW_RISK_ANSWERS },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(fallbackRes.errors).toBeUndefined();
      const restrictedMatter = fallbackRes.matter!;

      const visibleToAllowed = await twRepo.listVisibleTasks<Task>(ctx, 'P-000001', {
        linkedRecordType: 'matter',
        linkedRecordId: restrictedMatter.id,
      });
      const fallbackAuto = visibleToAllowed.filter(
        (t) => t.autoTrigger === 'work_type_auto_task',
      );
      expect(fallbackAuto.map((t) => t.idempotencyKey)).toEqual([
        `worktype-open:${restrictedMatter.id}:firm-opening-file-setup`,
      ]);
      expect(restrictedMatter.isStaffMatter).toBe(true);
      expect(restrictedMatter.restrictedAccessUserIds).toContain('P-000001');
      expect(restrictedMatter.restrictedAccessUserIds).not.toContain('P-000002');
      expect(fallbackAuto[0].assignedPersonId).toBe('P-000001');

      // Unauthorised user (P-000002 Dafydd) cannot see restricted staff matter's auto-tasks
      const visibleToUnauthorised = await twRepo.listVisibleTasks<Task>(ctx, 'P-000002', {
        linkedRecordType: 'matter',
        linkedRecordId: restrictedMatter.id,
      });
      expect(visibleToUnauthorised).toHaveLength(0);
    });
  });

  it('3. Driver (b): work-type risk questions, required-answer validation, server-side scoring override & PostgreSQL risk_assessment_json persistence', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignored, ...matterTemplate } = baseMatter;
    void _ignored;

    const workTypesCfg = cloneBaseWorkTypesConfig();
    const maQuestions = resolveWorkTypeRiskQuestions(workTypesCfg, {
      workTypeSubcategoryId: 'work_type.corporate_and_commercial_mergers_and_acquisitions',
      practiceAreaId: 'work_type.corporate_and_commercial',
    });
    expect(maQuestions.some((q) => q.id === 'maCrossBorderComplexity')).toBe(true);

    const sections = resolveMatterRiskSections(maQuestions);
    expect(sections.length).toBeGreaterThan(MATTER_RISK_SECTIONS.length);
    expect(sections.some((s) => s.id === 'work_type_risk_factors')).toBe(true);

    await runAsTestActor('P-000004', async () => {
      // Configure maCrossBorderComplexity as required for non-draft opening submission
      const requiredCfg = cloneBaseWorkTypesConfig();
      const maCfgItem = requiredCfg.items.find(
        (i) => i.workTypeId === 'work_type.corporate_and_commercial_mergers_and_acquisitions',
      )!;
      maCfgItem.riskQuestions![0].required = true;
      const cfgSaveRes = await saveWorkTypesConfigRecord(
        requiredCfg,
        'Require M&A cross-border risk question',
        'P-000004',
        { mfaVerified: true },
      );
      expect(cfgSaveRes.ok).toBe(true);
    }, { mfaVerified: true });

    await runAsTestActor('P-000001', async () => {
      // Submitting without required maCrossBorderComplexity answer must be rejected
      const missingRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          title: 'S0-22 Missing Required M&A Question',
          practiceAreaId: 'work_type.corporate_and_commercial',
          workTypeSubcategoryId:
            'work_type.corporate_and_commercial_mergers_and_acquisitions',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: { ...BASE_LOW_RISK_ANSWERS },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(missingRes.matter).toBeNull();
      expect(missingRes.errors?.riskAssessment).toBeDefined();

      // Client sends tampered Low scores/sections/overallRisk with High-risk answer
      const scoredRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: null,
          title: 'S0-22 Server Scored High-Risk M&A Matter',
          practiceAreaId: 'work_type.corporate_and_commercial',
          workTypeSubcategoryId:
            'work_type.corporate_and_commercial_mergers_and_acquisitions',
          riskRatingId: 'risk_rating.low',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              overallRisk: 'Low',
              totalScore: 0,
              completedQuestions: 99,
              sections: [{ id: 'forged', title: 'Client Forged Section' }],
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                maCrossBorderComplexity: 'multi_jurisdiction_regulated',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );

      expect(scoredRes.errors).toBeUndefined();
      const saved = scoredRes.matter!;
      expect(saved.riskRatingId).toBe('risk_rating.high');
      const snap = saved.fieldValues.__riskAssessmentSnapshot as {
        overallRisk: string;
        totalScore?: number;
        workTypeSubcategoryId?: string;
        sections: Array<{
          id: string;
          questions: Array<{ id: string; score?: number; weight?: number }>;
        }>;
      };
      expect(snap.overallRisk).toBe('High');
      expect(snap.workTypeSubcategoryId).toBe(
        'work_type.corporate_and_commercial_mergers_and_acquisitions',
      );
      expect(snap.sections.some((s) => s.id === 'forged')).toBe(false);
      const wtSec = snap.sections.find((s) => s.id === 'work_type_risk_factors');
      const maQSnap = wtSec?.questions.find((q) => q.id === 'maCrossBorderComplexity');
      expect(maQSnap?.weight).toBe(2);
      expect(maQSnap?.score).toBe(10);
      expect(snap.totalScore).toBeGreaterThanOrEqual(10);

      // Direct PostgreSQL check against public.matters.risk_assessment_json
      const pgRows = await queryDirectSql<{
        risk_rating_id: string;
        risk_assessment_json: {
          overallRisk?: string;
          totalScore?: number;
          workTypeSubcategoryId?: string;
        } | null;
      }>(
        ctx,
        `SELECT risk_rating_id, risk_assessment_json
         FROM public.matters
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, saved.id],
      );
      expect(pgRows).toHaveLength(1);
      expect(pgRows[0].risk_rating_id).toBe('risk_rating.high');
      expect(pgRows[0].risk_assessment_json?.overallRisk).toBe('High');
      expect(pgRows[0].risk_assessment_json?.workTypeSubcategoryId).toBe(
        'work_type.corporate_and_commercial_mergers_and_acquisitions',
      );
    });
  });

  it('4. Driver (c): retention calculation (incl. 29 Feb leap years), Close & Reopen lifecycle, Key Dates gate, PG destruction_date, zero deletions & PG TX rollback', async () => {
    // Leap year UTC calendar addition
    expect(calculateDestructionDate('2024-02-29', 1)).toBe('2025-02-28');
    expect(calculateDestructionDate('2024-02-29', 4)).toBe('2028-02-29');
    expect(calculateDestructionDate('2024-02-29', 12)).toBe('2036-02-29');
    expect(calculateDestructionDate('2025-05-10', 6)).toBe('2031-05-10');
    expect(formatRetentionPeriodLabel(12)).toBe('12 years');

    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const matterRepo = getMatterRepository();
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignored, ...matterTemplate } = baseMatter;
    void _ignored;

    await runAsTestActor('P-000001', async () => {
      // Key Dates closure gate blocks closing M-000001 because KD-000001 is open/confirmed
      const gatedClose = await updateMatterLifecycleStatusRecord(
        'M-000001',
        'close',
        { closedAt: '2026-11-15', reason: 'Attempt premature close' },
        'P-000001',
      );
      expect(gatedClose.matter).toBeNull();
      expect(gatedClose.errors?.keyDates).toBeTruthy();

      // Open a clean Commercial Property matter (12-year retention) with no open Key Dates
      const openRes = await saveMatterRecord(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: '2024-02-01',
          title: 'S0-22 Commercial Lease For Retention Closure',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId: 'work_type.real_estate_and_property_commercial_property',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'submit_cleared' },
      );
      expect(openRes.errors).toBeUndefined();
      const targetMatter = openRes.matter!;

      const countBeforeRes = await queryDirectSql<{ cnt: string }>(
        ctx,
        'SELECT COUNT(*)::text AS cnt FROM public.matters WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      const matterCountBefore = Number(countBeforeRes[0].cnt);

      // Force PG rollback via a temporary database trigger on audit_entries during Close
      const migClient = await createDirectMigrationClient({ ctx });
      try {
        await migClient.query(`
          CREATE OR REPLACE FUNCTION public.s022_fail_test_audit_insert()
          RETURNS trigger AS $$
          BEGIN
            IF NEW.reason LIKE '%s022-rollback-trigger%' THEN
              RAISE EXCEPTION 'PG_TEST_FORCED_ROLLBACK_S022';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await migClient.query(`
          DROP TRIGGER IF EXISTS trg_s022_fail_audit_insert ON public.audit_entries;
          CREATE TRIGGER trg_s022_fail_audit_insert
          BEFORE INSERT ON public.audit_entries
          FOR EACH ROW EXECUTE FUNCTION public.s022_fail_test_audit_insert();
        `);

        await expect(
          updateMatterLifecycleStatusRecord(
            targetMatter.id,
            'close',
            {
              closedAt: '2024-02-29',
              reason: 's022-rollback-trigger test closure',
              expectedRowVersion: targetMatter.rowVersion ?? 1,
            },
            'P-000001',
          ),
        ).rejects.toThrow(/TENANCY_DATABASE_ERROR.*P0001/i);
      } finally {
        await migClient.query(
          'DROP TRIGGER IF EXISTS trg_s022_fail_audit_insert ON public.audit_entries;',
        );
        await migClient.query(
          'DROP FUNCTION IF EXISTS public.s022_fail_test_audit_insert();',
        );
        await migClient.end();
      }

      // Verify clean rollback: matter remains Active with destruction_date NULL
      const afterRollbackRow = await queryDirectSql<{
        status_id: string;
        destruction_date: string | null;
      }>(
        ctx,
        `SELECT status_id, destruction_date::text
         FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, targetMatter.id],
      );
      expect(afterRollbackRow[0].status_id).toBe('matter_status.active');
      expect(afterRollbackRow[0].destruction_date).toBeNull();

      // Now close via lifecycle action on leap day 2024-02-29 (12 yrs -> 2036-02-29)
      setTestActorSession('P-000001', { mfaVerified: true });
      const auditMarkClose = await markAuditPosition();
      const closedRes = await updateMatterLifecycleStatusAction(
        targetMatter.id,
        'close',
        {
          closedAt: '2024-02-29',
          reason: 'Completion concluded cleanly',
          expectedRowVersion: targetMatter.rowVersion ?? 1,
        },
      );
      expect(closedRes.errors).toBeUndefined();
      const closedMatter = closedRes.matter!;
      expect(closedMatter.matterStatusId).toBe('matter_status.closed');
      expect(closedMatter.closedAt).toBe('2024-02-29');
      expect(closedMatter.retentionPeriod).toBe('12 years');
      expect(closedMatter.destructionDueAt).toBe('2036-02-29');

      // Verify PG columns and zero deletions
      const pgAfterClose = await queryDirectSql<{
        status_id: string;
        closed_on: string | null;
        destruction_date: string | null;
      }>(
        ctx,
        `SELECT status_id, closed_on::text, destruction_date::text
         FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, targetMatter.id],
      );
      expect(pgAfterClose[0].status_id).toBe('matter_status.closed');
      expect(pgAfterClose[0].closed_on).toBe('2024-02-29');
      expect(pgAfterClose[0].destruction_date).toBe('2036-02-29');

      const countAfterClose = await queryDirectSql<{ cnt: string }>(
        ctx,
        'SELECT COUNT(*)::text AS cnt FROM public.matters WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      expect(Number(countAfterClose[0].cnt)).toBe(matterCountBefore);

      const closeAudit = await auditEntriesSince(auditMarkClose);
      expect(
        closeAudit.some(
          (a) =>
            a.recordType === 'matter' &&
            a.recordId === targetMatter.id &&
            a.newValue?.includes('Closed') &&
            a.newValue?.includes('2036-02-29'),
        ),
      ).toBe(true);

      // Reopen clears closedAt and destructionDueAt / PG destruction_date
      const auditMarkReopen = await markAuditPosition();
      const reopenedRes = await updateMatterLifecycleStatusAction(
        targetMatter.id,
        'reopen',
        {
          reason: 'Supplemental post-completion deed required',
          expectedRowVersion: closedMatter.rowVersion,
        },
      );
      expect(reopenedRes.errors).toBeUndefined();
      expect(reopenedRes.matter?.matterStatusId).toBe('matter_status.active');
      expect(reopenedRes.matter?.closedAt ?? null).toBeNull();
      expect(reopenedRes.matter?.destructionDueAt ?? null).toBeNull();

      const reloaded = await matterRepo.getMatterById<Matter>(ctx, targetMatter.id);
      expect(reloaded?.destructionDueAt ?? null).toBeNull();

      const reopenAudit = await auditEntriesSince(auditMarkReopen);
      expect(
        reopenAudit.some(
          (a) =>
            a.recordType === 'matter' &&
            a.recordId === targetMatter.id &&
            a.newValue?.includes('Cleared') &&
            a.reason?.includes('Supplemental post-completion deed required'),
        ),
      ).toBe(true);
    });
  });

  it('5. Admin MFA / RBAC enforcement on work-type configuration writes', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000004');
    const nextCfg = cloneBaseWorkTypesConfig();
    nextCfg.defaults.retention.retentionYears = 8;

    // Unauthenticated caller -> UNAUTHENTICATED from guardedAction
    setTestActorSession(null);
    const unauthRes = (await saveWorkTypesConfigAction(nextCfg, 'No session')) as {
      ok: boolean;
      denied?: boolean;
      code?: string;
      message?: string;
    };
    expect(unauthRes.ok).toBe(false);
    expect(unauthRes.denied).toBe(true);
    expect(unauthRes.code).toBe('UNAUTHENTICATED');
    expect(unauthRes.message).toMatch(/Authentication is required/i);

    // Non-admin fee earner -> FORBIDDEN from guardedAction
    setTestActorSession('P-000002');
    const deniedFeeEarner = await runAsTestActor('P-000002', async () =>
      saveWorkTypesConfigAction(nextCfg, 'Fee earner attempt'),
    );
    expect((deniedFeeEarner as { ok: boolean; code?: string }).ok).toBe(false);
    expect((deniedFeeEarner as { code?: string }).code).toBe('FORBIDDEN');

    // Admin without MFA -> MFA_REQUIRED (both guardedAction & direct service check)
    setTestActorSession('P-000004', { mfaVerified: false });
    const noMfaActionRes = (await runAsTestActor(
      'P-000004',
      async () => saveWorkTypesConfigAction(nextCfg, 'Missing MFA action attempt'),
      { mfaVerified: false },
    )) as { ok: boolean; code?: string; denied?: boolean };
    expect(noMfaActionRes.ok).toBe(false);
    expect(noMfaActionRes.code).toBe('MFA_REQUIRED');

    const noMfaRes = await runAsTestActor(
      'P-000004',
      async () => saveWorkTypesConfigRecord(nextCfg, 'Missing MFA attempt', 'P-000004', { mfaVerified: false }),
      { mfaVerified: false },
    );
    expect(noMfaRes.ok).toBe(false);
    expect(noMfaRes.code).toBe('MFA_REQUIRED');

    // Admin with MFA -> persisted to PostgreSQL + audited
    setTestActorSession('P-000004', { mfaVerified: true });
    const auditBefore = await markAuditPosition();
    const okRes = await runAsTestActor(
      'P-000004',
      async () => saveWorkTypesConfigAction(nextCfg, 'Updated firm retention to 8 years'),
      { mfaVerified: true },
    );
    expect(okRes.ok).toBe(true);

    const persisted = await getCatalogueRepository().getWorkTypeConfigs<WorkTypesConfiguration>(
      ctx,
    );
    expect(persisted?.defaults.retention.retentionYears).toBe(8);

    const auditRows = await auditEntriesSince(auditBefore);
    expect(
      auditRows.some(
        (a) =>
          a.recordId === 'FIRM-WORK-TYPES-CONFIG' &&
          a.newValue?.includes('defaultsRetention=8') &&
          a.reason?.includes('8 years'),
      ),
    ).toBe(true);

    // Malformed payload with MFA -> rejected
    const badCfg = cloneBaseWorkTypesConfig();
    badCfg.defaults.retention.retentionYears = 0;
    const invalidRes = await runAsTestActor(
      'P-000004',
      async () => saveWorkTypesConfigAction(badCfg, 'Zero retention should fail'),
      { mfaVerified: true },
    );
    expect(invalidRes.ok).toBe(false);
  });

  it('6. P13 neutralisation, all 10 practice areas mapped bidirectionally, seeded closure dates & admin/intake/matter active sync', async () => {
    expect(DEFAULT_LEGAL_ENTITY_ID).toBe('LE-PRIMARY');

    const cleanStore = createCleanDeploymentStore();
    expect(cleanStore.orgStructure.legalEntities.some((le) => le.id === 'LE-PRIMARY')).toBe(
      true,
    );
    expect(
      cleanStore.orgStructure.legalEntities.every((le) =>
        ['LE-PRIMARY', 'LE-SERV', 'LE-TRUST'].includes(le.id),
      ),
    ).toBe(true);
    expect(cleanStore.orgStructure.offices).toHaveLength(0);
    expect(JSON.stringify(cleanStore.orgStructure)).not.toMatch(
      /LE-PV-LLP|OFF-CDF|Cardiff|Bristol|London/,
    );

    const seedStore = createSeedStore();
    const committedStore = loadCommittedSeedStore();

    // All 10 seeded taxonomy practice areas carry explicit meta.departmentId -> active OrgDepartment
    const practiceAreas = seedStore.values.filter(
      (v) => v.listKey === 'work_type' && !v.parentId,
    );
    expect(practiceAreas).toHaveLength(10);
    expect(Object.keys(DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP)).toHaveLength(10);
    for (const pa of practiceAreas) {
      expect(pa.meta?.departmentId).toBe(DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP[pa.id]);
      expect(
        seedStore.orgStructure.departments.some((d) => d.id === pa.meta?.departmentId),
      ).toBe(true);
    }

    // Seeded closed demo matters M-000012 (12 yrs) & M-000014 (6 yrs) have destructionDueAt
    for (const s of [seedStore, committedStore]) {
      const m12 = s.matters.find((m) => m.id === 'M-000012')!;
      const m14 = s.matters.find((m) => m.id === 'M-000014')!;
      expect(m12.closedAt).toBeTruthy();
      expect(m12.destructionDueAt).toBe(calculateDestructionDate(m12.closedAt!, 12));
      expect(m14.closedAt).toBeTruthy();
      expect(m14.destructionDueAt).toBe(calculateDestructionDate(m14.closedAt!, 6));
    }

    // Deactivating DEPT-RE in saveOrgStructure synchronises active work-type visibility while preserving legacy choice IDs
    await resetAllDemoData('P-000004', testDataResetContext());
    await runAsTestActor('P-000004', async () => {
      const beforeSnap = await getAppSnapshot('P-000004');
      const nextOrg = structuredClone(beforeSnap.orgStructure);
      const reDept = nextOrg.departments.find((d) => d.id === 'DEPT-RE')!;
      reDept.active = false;
      const saveOrgRes = await saveOrgStructure(nextOrg, 'P-000004');
      expect(
        saveOrgRes.orgStructure.departments.find((d) => d.id === 'DEPT-RE')?.active,
      ).toBe(false);

      const afterSnap = await getAppSnapshot('P-000004');
      const workTypeValues = afterSnap.values.filter((v) => v.listKey === 'work_type');
      expect(
        isWorkTypeChoiceActive(
          'work_type.real_estate_and_property',
          workTypeValues,
          afterSnap.orgStructure,
        ),
      ).toBe(false);
      expect(
        isWorkTypeChoiceActive(
          'work_type.real_estate_and_property_commercial_property',
          workTypeValues,
          afterSnap.orgStructure,
        ),
      ).toBe(false);

      const hierarchy = resolveActiveWorkTypeHierarchy(
        workTypeValues,
        afterSnap.orgStructure,
      );
      expect(
        hierarchy.activePracticeAreas.some(
          (pa) => pa.id === 'work_type.real_estate_and_property',
        ),
      ).toBe(false);
      expect(
        hierarchy.activePracticeAreas.some(
          (pa) => pa.id === 'work_type.corporate_and_commercial',
        ),
      ).toBe(true);
    });
  });

  it('7. Real two-tenant PostgreSQL isolation (tenant-alpha vs tenant-bravo): custom work-type rules, forged claims & zero cross-tenant leakage', async () => {
    const tenantAlpha = 'tenant-alpha';
    const tenantBravo = 'tenant-bravo';

    await provisionPostgresClusterRolesAndDatabases({
      tenants: [
        { tenantId: tenantAlpha, environment: 'test' },
        { tenantId: tenantBravo, environment: 'test' },
      ],
    });

    const ctxAlpha = makeVerifiedTenantCtx(tenantAlpha, 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);
    const ctxBravo = makeVerifiedTenantCtx(tenantBravo, 'P-000004', [
      'admin',
      'partner',
      'fee_earner',
      'risk_compliance',
    ]);

    const runner = new TenantMigrationRunner();
    await runner.applyUp(ctxAlpha);
    await runner.applyUp(ctxBravo);

    // Verify invalid / forged TenantContext claims fail closed with explicit error codes & messages
    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: false as unknown as true,
          sub: 'P-000004',
          name: 'Unauth',
          email: 'u@example',
          tenantId: tenantAlpha,
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-unauth',
      }),
    ).toThrow(/TENANCY_AUTH_ERROR/);

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000004',
          name: 'EmptyClaim',
          email: 'u@example',
          tenantId: '',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-empty-claim',
      }),
    ).toThrow(/TENANCY_CLAIM_ERROR/);

    expect(() =>
      resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-000004',
          name: 'Forged',
          email: 'forged@alpha.example',
          tenantId: tenantAlpha,
          roles: ['admin'],
          mfaVerified: true,
        },
        untrustedRequestTenantOverride: tenantBravo,
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-forge',
      }),
    ).toThrow(/TENANCY_FORGERY_DETECTED.*override/i);

    // Seed both tenants cleanly from independent seed stores
    const rawBase = getActiveTenantRawBaseConfig();
    const alphaRaw = { ...structuredClone(rawBase), tenantId: tenantAlpha, displayName: 'Tenant Alpha LLP' };
    const bravoRaw = { ...structuredClone(rawBase), tenantId: tenantBravo, displayName: 'Tenant Bravo LLP' };
    const alphaValidated = loadAndValidateTenantConfig(
      alphaRaw,
      {},
      'test',
      'multi_tenant',
    );
    const bravoValidated = loadAndValidateTenantConfig(
      bravoRaw,
      {},
      'test',
      'multi_tenant',
    );

    const alphaSeed = createSeedStore();
    const bravoSeed = createSeedStore();
    await importFirmStoreModulesToPostgres({
      ctx: ctxAlpha,
      tenantConfig: alphaValidated,
      store: alphaSeed,
      clearFirst: true,
    });
    await importFirmStoreModulesToPostgres({
      ctx: ctxBravo,
      tenantConfig: bravoValidated,
      store: bravoSeed,
      clearFirst: true,
    });

    // Save Tenant Alpha custom workTypes config (15-yr M&A retention + Alpha task + Alpha risk question)
    const alphaCustomWorkTypes = structuredClone(
      alphaValidated.workTypes!,
    ) as WorkTypesConfiguration;
    const alphaMa = alphaCustomWorkTypes.items.find(
      (i) => i.workTypeId === 'work_type.corporate_and_commercial_mergers_and_acquisitions',
    )!;
    alphaMa.autoTaskTemplates = [
      ...(alphaMa.autoTaskTemplates ?? []),
      {
        id: 'alpha-special-compliance',
        title: 'Alpha Special Compliance Check',
        trigger: 'matter_open',
        dueWorkingDaysOffset: 1,
        priorityId: 'task_priority.urgent',
        ownerRoleKey: 'risk_compliance',
      },
    ];
    alphaMa.riskQuestions = [
      ...(alphaMa.riskQuestions ?? []),
      {
        id: 'alphaSanctionsCheck',
        sectionKey: 'work_type',
        sectionTitle: 'Work-type risk factors',
        prompt: 'Tenant Alpha dual-use sanctions exposure?',
        weight: 3,
        required: true,
        options: [
          { value: 'none', label: 'None identified', score: 1, riskLevel: 'low' },
          { value: 'flagged', label: 'Dual-use nexus', score: 5, riskLevel: 'high' },
        ],
      },
    ];
    alphaMa.retention = { retentionYears: 15, baseline: 'closed_on' };

    setActiveTenantConfigForTesting(alphaRaw);
    setTestActorSession('P-000004', { tenantId: tenantAlpha, mfaVerified: true });
    let alphaMatterId = '';
    await runAsTestActor(
      'P-000004',
      async () => {
        const cfgSave = await saveWorkTypesConfigAction(
          alphaCustomWorkTypes,
          'Alpha specific rules',
        );
        expect(cfgSave.ok).toBe(true);

        const { id: _omitted, ...m4Template } = alphaSeed.matters.find(
          (m) => m.id === 'M-000004',
        )!;
        void _omitted;

        const openAlpha = await saveMatterRecord(
          {
            ...m4Template,
            matterNumber: 'DRAFT',
            openedAt: '2026-11-01',
            title: 'Alpha Isolated M&A Deal',
            practiceAreaId: 'work_type.corporate_and_commercial',
            workTypeSubcategoryId:
              'work_type.corporate_and_commercial_mergers_and_acquisitions',
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            fieldValues: {
              riskAssessment: {
                answers: {
                  ...BASE_LOW_RISK_ANSWERS,
                  maCrossBorderComplexity: 'domestic_standard',
                  alphaSanctionsCheck: 'flagged',
                },
              },
            },
          },
          { byId: 'P-000004', saveMode: 'submit_cleared' },
        );
        expect(openAlpha.errors).toBeUndefined();
        alphaMatterId = openAlpha.matter!.id;
        expect(openAlpha.matter!.riskRatingId).toBe('risk_rating.high');

        const closeAlpha = await updateMatterLifecycleStatusAction(
          alphaMatterId,
          'close',
          {
            closedAt: '2026-11-15',
            reason: 'Alpha completion',
            expectedRowVersion: openAlpha.matter!.rowVersion ?? 1,
          },
        );
        expect(closeAlpha.errors).toBeUndefined();
        expect(closeAlpha.matter?.destructionDueAt).toBe('2041-11-15');
      },
      { tenantId: tenantAlpha, mfaVerified: true },
    );

    // Fresh TenantPostgresPoolManager verifies complete Tenant Alpha vs Tenant Bravo isolation
    const freshPoolMgr = new TenantPostgresPoolManager();
    openPoolManagers.push(freshPoolMgr);
    const freshCatRepo = new TenantCatalogueRepository({ poolManager: freshPoolMgr });
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
    const freshTwRepo = new TenantTaskWorkflowRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    const alphaDbCfg = await freshCatRepo.getWorkTypeConfigs<WorkTypesConfiguration>(ctxAlpha);
    const bravoDbCfg = await freshCatRepo.getWorkTypeConfigs<WorkTypesConfiguration>(ctxBravo);
    expect(
      (alphaDbCfg?.items ?? []).find(
        (i) => i.workTypeId === 'work_type.corporate_and_commercial_mergers_and_acquisitions',
      )?.retention?.retentionYears,
    ).toBe(15);
    expect(bravoDbCfg).toBeNull();

    const alphaMatterDb = await freshMatterRepo.getMatterById<Matter>(ctxAlpha, alphaMatterId);
    expect(alphaMatterDb?.destructionDueAt).toBe('2041-11-15');
    expect(
      await freshMatterRepo.getMatterById<Matter>(ctxBravo, alphaMatterId),
    ).toBeNull();
    expect(
      await freshMatterRepo.getMatterById<Matter>(ctxAlpha, 'M-TAMPERED-999'),
    ).toBeNull();

    const alphaTasks = await freshTwRepo.listAllTasksUnfiltered<Task>(ctxAlpha);
    const bravoTasks = await freshTwRepo.listAllTasksUnfiltered<Task>(ctxBravo);
    expect(
      alphaTasks.some((t) => t.title === 'Alpha Special Compliance Check'),
    ).toBe(true);
    expect(
      bravoTasks.some((t) => t.title === 'Alpha Special Compliance Check'),
    ).toBe(false);

    // Switch active config to Tenant Bravo and verify Bravo retains base 7-year M&A policy with zero Alpha rules
    setActiveTenantConfigForTesting(bravoRaw);
    setTestActorSession('P-000004', { tenantId: tenantBravo, mfaVerified: true });
    await runAsTestActor(
      'P-000004',
      async () => {
        const bravoRetention = resolveWorkTypeRetention(bravoValidated.workTypes!, {
          workTypeSubcategoryId: 'work_type.corporate_and_commercial_mergers_and_acquisitions',
          practiceAreaId: 'work_type.corporate_and_commercial',
        });
        expect(bravoRetention.retentionYears).toBe(7);

        const bravoSnap = await getAppSnapshot('P-000004');
        expect(
          (bravoSnap.workTypesConfig?.items ?? [])
            .find(
              (i) =>
                i.workTypeId === 'work_type.corporate_and_commercial_mergers_and_acquisitions',
            )
            ?.retention?.retentionYears,
        ).toBe(7);
      },
      { tenantId: tenantBravo, mfaVerified: true },
    );

    const bravoAudits = await freshAuditRepo.listAuditEntriesForRecord(
      ctxBravo,
      'system',
      'FIRM-WORK-TYPES-CONFIG',
    );
    expect(bravoAudits).toHaveLength(0);

    // Forged TenantContext (tenantId swapped to Bravo while pointing at Alpha's DB) fails closed
    const forgedCtx = Object.freeze({
      ...ctxAlpha,
      tenantId: tenantBravo,
    }) as TenantContext;
    await expect(freshCatRepo.getWorkTypeConfigs(forgedCtx)).rejects.toThrow();

    expect(runner).toBeDefined();
    expect(CORE_REQUIRED_SCHEMA_VERSION).toBe('0020');
  });

  it('10. R495: ignores client destructionDueAt and retentionPeriod on create and update, rejects non-closing/future/pre-open closedAt with code and message, and audits old/new values', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignoredId, ...matterTemplate } = baseMatter;
    void _ignoredId;

    setTestActorSession('P-000001', { mfaVerified: true });
    await runAsTestActor('P-000001', async () => {
      // 1. Create with forged destructionDueAt, retentionPeriod, and non-closing closedAt -> rejected for closedAt
      const badCreateClosed = await saveMatterAction(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: '2026-06-15',
          closedAt: '2026-06-20',
          destructionDueAt: '2027-01-01',
          retentionPeriod: '1 year',
          title: 'R495 Create Reject Non-Closing ClosedAt',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId:
            'work_type.real_estate_and_property_commercial_property',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { saveMode: 'submit_cleared' },
      );
      expect(badCreateClosed.matter).toBeNull();
      expect(badCreateClosed.code).toBe('INVALID_CLOSURE_DATE');
      expect(badCreateClosed.message).toContain('INVALID_CLOSURE_DATE');

      // 2. Create with forged destructionDueAt and retentionPeriod (no closedAt) -> client values ignored; server sets 12 years and null destructionDueAt
      const createAuditMark = await markAuditPosition();
      const createdRes = await saveMatterAction(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: '2026-06-15',
          closedAt: null,
          destructionDueAt: '2027-01-01',
          retentionPeriod: '1 year',
          title: 'R495 Server Owned Retention Matter',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId:
            'work_type.real_estate_and_property_commercial_property',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { saveMode: 'submit_cleared' },
      );
      expect(createdRes.errors).toBeUndefined();
      const created = createdRes.matter!;
      expect(created.retentionPeriod).toBe('12 years');
      expect(created.destructionDueAt).toBeNull();
      expect(created.closedAt).toBeNull();

      const pgAfterCreate = await queryDirectSql<{
        retention_period: string | null;
        destruction_date: string | null;
        closed_on: string | null;
      }>(
        ctx,
        `SELECT milestones_json->>'retentionPeriod' AS retention_period,
                destruction_date::text,
                closed_on::text
           FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, created.id],
      );
      expect(pgAfterCreate[0].retention_period).toBe('12 years');
      expect(pgAfterCreate[0].destruction_date).toBeNull();
      expect(pgAfterCreate[0].closed_on).toBeNull();

      const createAudits = await auditEntriesSince(createAuditMark);
      expect(
        createAudits.some(
          (a) =>
            a.recordId === created.id &&
            a.field === 'Matter closure & retention' &&
            a.oldValue === null &&
            a.newValue?.includes('12 years'),
        ),
      ).toBe(true);

      // 3. Update with forged destructionDueAt, retentionPeriod, and non-closing closedAt -> rejected
      const badUpdateClosedAt = await saveMatterAction(
        {
          ...created,
          closedAt: '2026-06-20',
          destructionDueAt: '2027-01-01',
          retentionPeriod: '1 year',
        },
        { id: created.id, expectedRowVersion: created.rowVersion ?? 1 },
      );
      expect(badUpdateClosedAt.matter).toBeNull();
      expect(badUpdateClosedAt.code).toBe('INVALID_CLOSURE_DATE');
      expect(badUpdateClosedAt.message).toContain('INVALID_CLOSURE_DATE');

      // 4. Update with forged destructionDueAt and retentionPeriod -> ignored on update, server keeps 12 years & null destruction_date
      const updateIgnoredRes = await saveMatterAction(
        {
          ...created,
          title: 'R495 Server Owned Retention Matter Updated',
          closedAt: null,
          destructionDueAt: '2027-01-01',
          retentionPeriod: '1 year',
        },
        { id: created.id, expectedRowVersion: created.rowVersion ?? 1 },
      );
      expect(updateIgnoredRes.errors).toBeUndefined();
      const updated = updateIgnoredRes.matter!;
      expect(updated.retentionPeriod).toBe('12 years');
      expect(updated.destructionDueAt).toBeNull();
      const pgAfterUpdate = await queryDirectSql<{
        status_id: string;
        retention_period: string | null;
        destruction_date: string | null;
      }>(
        ctx,
        `SELECT status_id, milestones_json->>'retentionPeriod' AS retention_period, destruction_date::text
           FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, updated.id],
      );
      expect(pgAfterUpdate[0].status_id).toBe('matter_status.active');
      expect(pgAfterUpdate[0].retention_period).toBe('12 years');
      expect(pgAfterUpdate[0].destruction_date).toBeNull();

      // 5. Future closedAt rejected in both updateMatterLifecycleStatusAction and saveMatterAction
      const futureLifecycle = await updateMatterLifecycleStatusAction(
        updated.id,
        'close',
        { closedAt: '2099-01-01', expectedRowVersion: updated.rowVersion ?? 1 },
      );
      expect(futureLifecycle.matter).toBeNull();
      expect(futureLifecycle.code).toBe('INVALID_CLOSURE_DATE');
      expect(futureLifecycle.message).toContain('cannot be in the future');

      const futureSave = await saveMatterAction(
        {
          ...updated,
          matterStatusId: 'matter_status.closed',
          closedAt: '2099-01-01',
          destructionDueAt: '2027-01-01',
          retentionPeriod: '1 year',
        },
        { id: updated.id, expectedRowVersion: updated.rowVersion ?? 1 },
      );
      expect(futureSave.matter).toBeNull();
      expect(futureSave.code).toBe('INVALID_CLOSURE_DATE');
      expect(futureSave.message).toContain('cannot be in the future');

      // 6. closedAt before openedAt rejected in both actions, DB stays active & unscheduled
      const preOpenLifecycle = await updateMatterLifecycleStatusAction(
        updated.id,
        'close',
        { closedAt: '2026-06-14', expectedRowVersion: updated.rowVersion ?? 1 },
      );
      expect(preOpenLifecycle.matter).toBeNull();
      expect(preOpenLifecycle.code).toBe('INVALID_CLOSURE_DATE');
      expect(preOpenLifecycle.message).toContain('earlier than the matter opened date');

      const preOpenSave = await saveMatterAction(
        {
          ...updated,
          matterStatusId: 'matter_status.closed',
          closedAt: '2026-06-14',
        },
        { id: updated.id, expectedRowVersion: updated.rowVersion ?? 1 },
      );
      expect(preOpenSave.matter).toBeNull();
      expect(preOpenSave.code).toBe('INVALID_CLOSURE_DATE');
      expect(preOpenSave.message).toContain('earlier than the matter opened date');

      const pgStillOpen = await queryDirectSql<{
        status_id: string;
        closed_on: string | null;
        destruction_date: string | null;
      }>(
        ctx,
        `SELECT status_id, closed_on::text, destruction_date::text
           FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, updated.id],
      );
      expect(pgStillOpen[0].status_id).toBe('matter_status.active');
      expect(pgStillOpen[0].closed_on).toBeNull();
      expect(pgStillOpen[0].destruction_date).toBeNull();

      // 7. Valid close audits old/new values and rejects non-closing closedAt on reopen
      const closeAuditMark = await markAuditPosition();
      const validClose = await updateMatterLifecycleStatusAction(
        updated.id,
        'close',
        { closedAt: '2026-07-01', expectedRowVersion: updated.rowVersion ?? 1 },
      );
      expect(validClose.errors).toBeUndefined();
      expect(validClose.matter?.destructionDueAt).toBe('2038-07-01');
      expect(validClose.matter?.retentionPeriod).toBe('12 years');

      const closeAudits = await auditEntriesSince(closeAuditMark);
      expect(
        closeAudits.some(
          (a) =>
            a.recordId === updated.id &&
            a.oldValue?.includes('Retention: 12 years') &&
            a.oldValue?.includes('Destruction due: None') &&
            a.newValue?.includes('Closed: 2026-07-01') &&
            a.newValue?.includes('Destruction due: 2038-07-01'),
        ),
      ).toBe(true);

      const badReopenWithDate = await updateMatterLifecycleStatusAction(
        updated.id,
        'reopen',
        {
          closedAt: '2026-07-02',
          expectedRowVersion: validClose.matter!.rowVersion ?? 1,
        },
      );
      expect(badReopenWithDate.matter).toBeNull();
      expect(badReopenWithDate.code).toBe('INVALID_CLOSURE_DATE');
      expect(badReopenWithDate.message).toContain('only be supplied when closing');
    });
  });

  it('11. R496: resolves closure and active statuses strictly by systemKey when display labels differ and fails closed with MATTER_STATUS_NOT_CONFIGURED when absent', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignoredId, ...matterTemplate } = baseMatter;
    void _ignoredId;
    const catRepo = getCatalogueRepository();

    setTestActorSession('P-000001', { mfaVerified: true });
    await runAsTestActor('P-000001', async () => {
      const openRes = await saveMatterAction(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: '2026-06-01',
          title: 'R496 SystemKey Status Matter',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: { answers: { ...BASE_LOW_RISK_ANSWERS } },
          },
        },
        { saveMode: 'submit_cleared' },
      );
      expect(openRes.errors).toBeUndefined();
      let currentMatter = openRes.matter!;

      // Rename Active -> 'Open – live' and Closed -> 'Closed – archived' while keeping systemKey
      const statuses = await catRepo.listChoiceValuesForList<ChoiceValue>(
        ctx,
        'matter_status',
      );
      const activeVal = statuses.find((v) => v.systemKey === 'active')!;
      const closedVal = statuses.find((v) => v.systemKey === 'closed')!;
      await catRepo.putChoiceValue(ctx, { ...activeVal, label: 'Open – live' });
      await catRepo.putChoiceValue(ctx, { ...closedVal, label: 'Closed – archived' });

      const closedRenamed = await updateMatterLifecycleStatusAction(
        currentMatter.id,
        'close',
        { closedAt: '2026-08-01', expectedRowVersion: currentMatter.rowVersion ?? 1 },
      );
      expect(closedRenamed.errors).toBeUndefined();
      expect(closedRenamed.matter?.matterStatusId).toBe(closedVal.id);
      currentMatter = closedRenamed.matter!;

      const reopenedRenamed = await updateMatterLifecycleStatusAction(
        currentMatter.id,
        'reopen',
        { expectedRowVersion: currentMatter.rowVersion ?? 1 },
      );
      expect(reopenedRenamed.errors).toBeUndefined();
      expect(reopenedRenamed.matter?.matterStatusId).toBe(activeVal.id);
      currentMatter = reopenedRenamed.matter!;

      // Replace default closed row with a custom ID holding systemKey: 'closed'
      const customClosed: ChoiceValue = {
        id: 'matter_status.custom_archived_closure',
        listKey: 'matter_status',
        label: 'Archived File',
        sortOrder: 99,
        active: true,
        systemKey: 'closed',
      };
      await catRepo.putChoiceValue(ctx, { ...closedVal, active: false });
      await catRepo.putChoiceValue(ctx, customClosed);

      const closedCustom = await updateMatterLifecycleStatusAction(
        currentMatter.id,
        'close',
        { closedAt: '2026-08-02', expectedRowVersion: currentMatter.rowVersion ?? 1 },
      );
      expect(closedCustom.errors).toBeUndefined();
      expect(closedCustom.matter?.matterStatusId).toBe(customClosed.id);
      currentMatter = closedCustom.matter!;

      const reopenedFromCustom = await updateMatterLifecycleStatusAction(
        currentMatter.id,
        'reopen',
        { expectedRowVersion: currentMatter.rowVersion ?? 1 },
      );
      expect(reopenedFromCustom.errors).toBeUndefined();
      expect(reopenedFromCustom.matter?.matterStatusId).toBe(activeVal.id);
      currentMatter = reopenedFromCustom.matter!;

      // Remove/deactivate all 'closed' statuses -> fail closed with MATTER_STATUS_NOT_CONFIGURED
      await catRepo.putChoiceValue(ctx, { ...customClosed, active: false });
      const missingStatusClose = await updateMatterLifecycleStatusAction(
        currentMatter.id,
        'close',
        { closedAt: '2026-08-03', expectedRowVersion: currentMatter.rowVersion ?? 1 },
      );
      expect(missingStatusClose.matter).toBeNull();
      expect(missingStatusClose.code).toBe('MATTER_STATUS_NOT_CONFIGURED');
      expect(missingStatusClose.message).toContain('MATTER_STATUS_NOT_CONFIGURED');

      const pgUnchanged = await queryDirectSql<{ status_id: string }>(
        ctx,
        'SELECT status_id FROM public.matters WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, currentMatter.id],
      );
      expect(pgUnchanged[0].status_id).toBe(activeVal.id);
    });
  });

  it('12. R497: in-transaction reads block closure when an open key date commits after close begins and observe concurrent retention updates', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignoredId, ...matterTemplate } = baseMatter;
    void _ignoredId;
    const kdRepo = getKeyDateRepository();
    const catRepo = getCatalogueRepository();

    setTestActorSession('P-000001', { mfaVerified: true });
    await runAsTestActor('P-000001', async () => {
      const openRes = await saveMatterAction(
        {
          ...matterTemplate,
          matterNumber: 'DRAFT',
          openedAt: '2026-06-01',
          title: 'R497 In-Tx KeyDate & Retention Race Matter',
          practiceAreaId: 'work_type.real_estate_and_property',
          workTypeSubcategoryId:
            'work_type.real_estate_and_property_commercial_property',
          agreedFeeCapGbp: 5000,
          feeEstimateGbp: 5000,
          fieldValues: {
            riskAssessment: {
              answers: {
                ...BASE_LOW_RISK_ANSWERS,
                propertyDevelopmentEnvironmental: 'standard_occupied_title',
              },
            },
          },
        },
        { saveMode: 'submit_cleared' },
      );
      expect(openRes.errors).toBeUndefined();
      const targetMatter = openRes.matter!;

      // Part A: Key date commits on an autonomous connection after close check starts
      const origGetKdConfig = kdRepo.getKeyDatesTenantConfig.bind(kdRepo);
      let injectedKeyDate = false;
      const kdSpy = vi
        .spyOn(kdRepo, 'getKeyDatesTenantConfig')
        .mockImplementation(async (callCtx: TenantContext) => {
          const cfg = await origGetKdConfig(callCtx);
          if (!injectedKeyDate) {
            injectedKeyDate = true;
            const nowIso = new Date().toISOString();
            await kdRepo.withAutonomousTenantTransaction(ctx, async () => {
              await kdRepo.putKeyDate(ctx, {
                id: 'KD-R497-CONCURRENT-01',
                matterId: targetMatter.id,
                keyDateTypeId: 'kd-type-limitation',
                category: 'limitation',
                title: 'R497 Concurrent Open Key Date',
                dueDate: '2027-07-01',
                isCritical: true,
                status: 'confirmed',
                source: 'manual',
                teamId: 'TM-000001',
                responsiblePersonIds: ['P-000001'],
                verification: {
                  required: true,
                  proposedById: 'P-000001',
                  proposedAt: nowIso,
                  verifiedById: 'P-000001',
                  verifiedAt: nowIso,
                },
                createdById: 'P-000001',
                createdAt: nowIso,
                updatedById: 'P-000001',
                updatedAt: nowIso,
                version: 1,
              });
            });
          }
          return cfg;
        });

      let raceCloseRes: Awaited<ReturnType<typeof updateMatterLifecycleStatusAction>>;
      try {
        raceCloseRes = await updateMatterLifecycleStatusAction(
          targetMatter.id,
          'close',
          { closedAt: '2026-11-10', expectedRowVersion: targetMatter.rowVersion ?? 1 },
        );
      } finally {
        kdSpy.mockRestore();
      }

      expect(injectedKeyDate).toBe(true);
      expect(raceCloseRes!.matter).toBeNull();
      expect(raceCloseRes!.code).toBe('OPEN_KEY_DATES_BLOCK_CLOSURE');
      expect(raceCloseRes!.message).toContain('OPEN_KEY_DATES_BLOCK_CLOSURE');

      const pgAfterKdRace = await queryDirectSql<{
        status_id: string;
        closed_on: string | null;
        destruction_date: string | null;
      }>(
        ctx,
        `SELECT status_id, closed_on::text, destruction_date::text
           FROM public.matters WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, targetMatter.id],
      );
      expect(pgAfterKdRace[0].status_id).toBe('matter_status.active');
      expect(pgAfterKdRace[0].closed_on).toBeNull();
      expect(pgAfterKdRace[0].destruction_date).toBeNull();

      // Mark the injected key date met, then simulate concurrent retention update after close transaction begins
      const injectedKd = (
        await kdRepo.listKeyDatesForMatter(ctx, targetMatter.id, 'P-000001')
      ).find((d) => d.id === 'KD-R497-CONCURRENT-01')!;
      await kdRepo.putKeyDate(ctx, { ...injectedKd, status: 'met' });

      const updatedWorkTypes = cloneBaseWorkTypesConfig();
      const cpItem = updatedWorkTypes.items.find(
        (i) =>
          i.workTypeId ===
          'work_type.real_estate_and_property_commercial_property',
      )!;
      cpItem.retention = {
        ...cpItem.retention,
        retentionYears: 20,
        baseline: 'closed_on',
      };

      const origListChoices = catRepo.listAllChoiceValues.bind(catRepo);
      let updatedRetentionConcurrently = false;
      const catSpy = vi
        .spyOn(catRepo, 'listAllChoiceValues')
        .mockImplementation(async (callCtx: TenantContext) => {
          const vals = await origListChoices(callCtx);
          if (!updatedRetentionConcurrently) {
            updatedRetentionConcurrently = true;
            await catRepo.withAutonomousTenantTransaction(ctx, async () => {
              await catRepo.putWorkTypeConfigs(ctx, updatedWorkTypes, 'P-000001');
            });
          }
          return vals;
        });

      let closeWithUpdatedRetention: Awaited<
        ReturnType<typeof updateMatterLifecycleStatusAction>
      >;
      try {
        closeWithUpdatedRetention = await updateMatterLifecycleStatusAction(
          targetMatter.id,
          'close',
          { closedAt: '2026-11-10', expectedRowVersion: targetMatter.rowVersion ?? 1 },
        );
      } finally {
        catSpy.mockRestore();
      }

      expect(updatedRetentionConcurrently).toBe(true);
      expect(closeWithUpdatedRetention!.errors).toBeUndefined();
      expect(closeWithUpdatedRetention!.matter?.retentionPeriod).toBe('20 years');
      expect(closeWithUpdatedRetention!.matter?.destructionDueAt).toBe('2046-11-10');
    });
  });

  it('13. S1: discards staged audit entries on non-concurrency transaction failure so the same audit scope stays clean for subsequent saves', async () => {
    await resetAllDemoData('P-000004', testDataResetContext());
    const ctx = testTenantCtx('P-000001');
    const seed = loadCommittedSeedStore();
    const baseMatter = seed.matters.find((m) => m.id === 'M-000004')!;
    const { id: _ignoredId, ...matterTemplate } = baseMatter;
    void _ignoredId;

    setTestActorSession('P-000001', { mfaVerified: true });
    await runAsTestActor('P-000001', async () => {
      const migClient = await createDirectMigrationClient({ ctx });
      let secondSaveMatterId = '';
      const beforeS1Mark = await markAuditPosition();

      try {
        await migClient.query(`
          CREATE OR REPLACE FUNCTION public.s022_fail_s1_task_insert()
          RETURNS trigger AS $$
          BEGIN
            IF NEW.description LIKE '%S022_S1_TRIGGER_FAIL%' THEN
              RAISE EXCEPTION 'PG_TEST_FORCED_S1_FAILURE';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await migClient.query(`
          DROP TRIGGER IF EXISTS trg_s022_fail_s1_task ON public.tasks;
          CREATE TRIGGER trg_s022_fail_s1_task
          BEFORE INSERT ON public.tasks
          FOR EACH ROW EXECUTE FUNCTION public.s022_fail_s1_task_insert();
        `);

        await expect(
          runWithAuditStagingScope(async () => {
            await expect(
              saveMatterRecord(
                {
                  ...matterTemplate,
                  matterNumber: 'DRAFT',
                  openedAt: '2026-06-01',
                  title: 'S022_S1_TRIGGER_FAIL Rollback Matter',
                  agreedFeeCapGbp: 5000,
                  feeEstimateGbp: 5000,
                  fieldValues: {
                    riskAssessment: { answers: { ...BASE_LOW_RISK_ANSWERS } },
                  },
                },
                { byId: 'P-000001', saveMode: 'draft' },
              ),
            ).rejects.toThrow(/(?:TENANCY_DATABASE_ERROR.*P0001|PG_TEST_FORCED_S1_FAILURE)/i);

            // Flush an outer staged entry inside the SAME staging scope;
            // without S1 cleanup, the rolled-back save's staged entries would leak here.
            await getMatterRepository().withTenantTransaction(ctx, async () => {
              stageAuditEntry({
                recordType: 'matter',
                recordId: 'M-S022-S1-OUTER',
                action: 'update',
                field: 'S1 outer staging scope verification',
                oldValue: null,
                newValue: 'S022_S1_OUTER_FLUSH_CLEAN',
                byId: 'P-000001',
              });
              await flushStagedAuditEntries(ctx);
            });
          }),
        ).resolves.toBeUndefined();

        const secondRes = await saveMatterRecord(
          {
            ...matterTemplate,
            matterNumber: 'DRAFT',
            openedAt: '2026-06-01',
            title: 'S022_S1_CLEAN_SECOND_SAVE',
            agreedFeeCapGbp: 5000,
            feeEstimateGbp: 5000,
            fieldValues: {
              riskAssessment: { answers: { ...BASE_LOW_RISK_ANSWERS } },
            },
          },
          { byId: 'P-000001', saveMode: 'submit_cleared' },
        );
        expect(secondRes.errors).toBeUndefined();
        expect(secondRes.matter?.title).toBe('S022_S1_CLEAN_SECOND_SAVE');
        secondSaveMatterId = secondRes.matter!.id;
      } finally {
        await migClient.query(
          'DROP TRIGGER IF EXISTS trg_s022_fail_s1_task ON public.tasks;',
        );
        await migClient.query(
          'DROP FUNCTION IF EXISTS public.s022_fail_s1_task_insert();',
        );
        await migClient.end();
      }

      const entriesAfterS1 = await auditEntriesSince(beforeS1Mark);
      expect(
        entriesAfterS1.some((e) =>
          String(e.newValue ?? '').includes('S022_S1_TRIGGER_FAIL'),
        ),
      ).toBe(false);
      expect(
        entriesAfterS1.some((e) =>
          String(e.newValue ?? '').includes('S022_S1_OUTER_FLUSH_CLEAN'),
        ),
      ).toBe(true);
      expect(
        entriesAfterS1.some(
          (e) =>
            e.recordId === secondSaveMatterId &&
            String(e.newValue ?? '').includes('S022_S1_CLEAN_SECOND_SAVE'),
        ),
      ).toBe(true);
    });
  });
});
