import {
  migrateEmployeesToEmploymentRecords,
  resolveConfiguredFirmPrimaryDomain,
} from '@/domain/employment';
import {
  createDefaultHomePagesConfig,
  createDefaultRoleConfigs,
  syncHomeRolesWithEmployeeRoles,
} from '@/domain/homeConfig';
import {
  createDefaultMatterCostsConfig,
  syncRateCardsWithPmsFeeEarners,
} from '@/domain/matterCosts';
import {
  buildDefaultMatterPartyTaxonomy,
  migrateMatterPartiesToTwoFieldModel,
} from '@/domain/matterParties';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import { computeAutomaticPmsLinks } from '@/domain/pms';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import type { KeyDate } from '@/domain/keyDates.types';
import type {
  AuditEntry,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  EmployeeMigrationReport,
  EmployeeSensitiveRecord,
  Enquiry,
  EnquirySettings,
  HomePagesConfig,
  Matter,
  MatterCostsConfig,
  MatterPartyMigrationReport,
  MatterPartyTaxonomy,
  MergeHistory,
  Note,
  NotificationItem,
  Organisation,
  OrgStructureCatalogue,
  Person,
  PersonOrganisationLink,
  PmsLink,
  Quote,
  SignOffItem,
  Task,
  TaskSettings,
  Team,
} from '@/domain/types';
import { getCachedDefaultWorkbookDataset } from '@/pms/importPms';
import { buildSeedLists } from '@/seed/lists';
import {
  buildDemoData,
  buildInitialSeedMatterPmsLinks,
  DEFAULT_ENQUIRY_SETTINGS,
  DEFAULT_TASK_SETTINGS,
  DEFAULT_USER_ID,
  FIRM,
} from '@/seed/demo';

export interface FirmStore {
  firmId: string;
  firm: typeof FIRM;
  isCleanDeployment?: boolean;
  lists: ChoiceList[];
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  orgStructure: OrgStructureCatalogue;
  matterPartyTaxonomy: MatterPartyTaxonomy;
  matterPartyMigrationReport?: MatterPartyMigrationReport;
  people: Person[];
  employeeSensitiveRecords: Record<string, EmployeeSensitiveRecord>;
  employeeMigrationReport?: EmployeeMigrationReport;
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  matters: Matter[];
  teams: Team[];
  tasks: Task[];
  enquiries: Enquiry[];
  quotes: Quote[];
  notifications: NotificationItem[];
  enquirySettings: EnquirySettings;
  taskSettings: TaskSettings;
  signOffs: SignOffItem[];
  homePagesConfig: HomePagesConfig;
  matterCostsConfig: MatterCostsConfig;
  pmsLinks: PmsLink[];
  notes: Note[];
  audit: AuditEntry[];
  mergeHistory: MergeHistory[];
  recentlyViewed: Record<string, string[]>;
  counters: Record<string, number>;
  documentTemplates?: import('@platform/core').DocumentTemplateRecord[];
  documentTemplateVersions?: import('@platform/core').DocumentTemplateVersionRecord[];
  documents?: import('@platform/core').GeneratedDocumentRecord[];
  documentLinks?: import('@platform/core').DocumentLinkRecord[];
  templateUsageEvents?: import('@platform/core').TemplateUsageEventRecord[];
  documentGenerationConfigOverride?: Partial<import('@platform/core').DocumentGenerationConfig>;
  rbacConfigOverride?: Partial<import('@platform/core').RbacConfiguration>;
  matterDocumentLocations?: import('@platform/core').MatterDocumentLocationRecord[];
  documentStoreFolderScopes?: import('@platform/core').DocumentStoreFolderScopeRecord[];
  documentLifecycleJobs?: import('@platform/core').DocumentLifecycleJobRecord[];
  documentReconciliationFindings?: import('@platform/core').DocumentReconciliationFindingRecord[];
  documentStoreAuditEvents?: import('@platform/core').DocumentStoreAuditEventRecord[];
  documentStoreConfigOverride?: {
    documentStores?: import('@platform/core').DocumentStoreConfig[];
    documentRouting?: import('@platform/core').DocumentRoutingRule[];
    matterFolderNameTemplate?: string;
    documentAccess?: import('@platform/core').DocumentAccessConfig;
    matterFolderTemplates?: import('@platform/core').MatterFolderTemplatesConfig;
  };
  keyDates?: import('@/domain/keyDates.types').KeyDate[];
  keyDateNotApplicable?: import('@/domain/keyDates.types').KeyDateNotApplicable[];
  keyDateReminderStates?: import('@/domain/keyDates.types').KeyDateReminderState[];
  keyDateCalendarSyncs?: import('@/domain/keyDates.types').KeyDateCalendarSync[];
  keyDatesConfigOverride?: import('@/domain/keyDates.types').KeyDatesConfig;
}

function resolveActiveFirmId(): string {
  return getActiveTenantConfiguration().tenantId;
}

export function repairOrphanTaxonomyIds(
  parsed: Pick<FirmStore, 'matters' | 'enquiries' | 'quotes'>,
  demo: Pick<FirmStore, 'matters' | 'enquiries' | 'quotes'>,
  validIds: ReadonlySet<string>,
): { repairedCount: number } {
  let repairedCount = 0;

  for (const m of demo.matters) {
    const existingMatter = parsed.matters.find(
      (x) => x.id === m.id || x.matterNumber === m.matterNumber,
    );
    if (!existingMatter) continue;
    if (existingMatter.practiceAreaId && !validIds.has(existingMatter.practiceAreaId)) {
      existingMatter.practiceAreaId = m.practiceAreaId;
      repairedCount += 1;
    }
    if (
      existingMatter.workTypeSubcategoryId &&
      !validIds.has(existingMatter.workTypeSubcategoryId)
    ) {
      existingMatter.workTypeSubcategoryId = m.workTypeSubcategoryId;
      repairedCount += 1;
    }
    if (existingMatter.stageId && !validIds.has(existingMatter.stageId)) {
      existingMatter.stageId = m.stageId;
      repairedCount += 1;
    }
    if (existingMatter.milestoneId && !validIds.has(existingMatter.milestoneId)) {
      existingMatter.milestoneId = m.milestoneId;
      repairedCount += 1;
    }
  }

  for (const enq of demo.enquiries) {
    const existingEnq = parsed.enquiries.find((x) => x.id === enq.id);
    if (!existingEnq) continue;
    if (existingEnq.practiceAreaId && !validIds.has(existingEnq.practiceAreaId)) {
      existingEnq.practiceAreaId = enq.practiceAreaId;
      repairedCount += 1;
    }
    if (
      existingEnq.workTypeSubcategoryId &&
      !validIds.has(existingEnq.workTypeSubcategoryId)
    ) {
      existingEnq.workTypeSubcategoryId = enq.workTypeSubcategoryId;
      repairedCount += 1;
    }
  }

  if (Array.isArray(parsed.quotes)) {
    for (const q of demo.quotes) {
      const existingQuote = parsed.quotes.find(
        (x) => x.id === q.id || x.reference === q.reference,
      );
      if (!existingQuote) continue;
      if (existingQuote.practiceAreaId && !validIds.has(existingQuote.practiceAreaId)) {
        existingQuote.practiceAreaId = q.practiceAreaId;
        repairedCount += 1;
      }
      if (
        existingQuote.workTypeSubcategoryId &&
        !validIds.has(existingQuote.workTypeSubcategoryId)
      ) {
        existingQuote.workTypeSubcategoryId = q.workTypeSubcategoryId;
        repairedCount += 1;
      }
    }
  }

  return { repairedCount };
}

function buildInitialPmsLinks(
  organisations: Organisation[],
  people: Person[],
  matters: Matter[],
  existingLinks: PmsLink[] = [],
  nowIso: string = new Date().toISOString(),
): PmsLink[] {
  const pmsDataset = getCachedDefaultWorkbookDataset();
  const pmsClients = pmsDataset.clients;
  const pmsFeeEarners = pmsDataset.feeEarners;
  const pmsMatters = pmsDataset.matters;

  const seededMatterLinks = buildInitialSeedMatterPmsLinks(
    matters,
    existingLinks,
    nowIso,
  );

  return computeAutomaticPmsLinks(
    seededMatterLinks,
    organisations,
    people,
    matters,
    [...pmsClients],
    [...pmsFeeEarners],
    [...pmsMatters],
    nowIso,
    true,
  );
}

export function createSeedStore(
  today: Date = new Date(),
  options?: { includeSyntheticEntraOids?: boolean },
): FirmStore {
  const seedLists = buildSeedLists();
  const demo = buildDemoData(today, options);
  const pmsLinks = buildInitialPmsLinks(
    demo.organisations,
    demo.people,
    demo.matters,
    [],
    today.toISOString(),
  );
  const tenantCfg = getActiveTenantConfiguration();
  const orgStructure = buildDefaultOrgStructure({
    legalName: tenantCfg.displayName,
  });
  const rawValues = [...seedLists.values, ...demo.customValues];
  const empMigration = migrateEmployeesToEmploymentRecords(
    demo.people,
    rawValues,
    orgStructure,
    pmsLinks,
    resolveConfiguredFirmPrimaryDomain(tenantCfg),
    today.toISOString(),
  );
  const matterPartyTaxonomy = buildDefaultMatterPartyTaxonomy(rawValues);
  const partyMigration = migrateMatterPartiesToTwoFieldModel(
    rawValues,
    demo.matters,
    matterPartyTaxonomy,
    today.toISOString(),
  );
  const pmsFeeEarners = [...getCachedDefaultWorkbookDataset().feeEarners];
  const matterCostsConfig = syncRateCardsWithPmsFeeEarners(
    createDefaultMatterCostsConfig(partyMigration.values, today.toISOString(), {
      clientProfileCode: tenantCfg.tenantId,
      displayName: tenantCfg.displayName,
      primaryDomain: tenantCfg.branding.primaryDomain,
    }),
    pmsFeeEarners,
    partyMigration.values,
    today.toISOString(),
  );
  const store: FirmStore = {
    firmId: resolveActiveFirmId(),
    firm: { ...FIRM },
    isCleanDeployment: false,
    lists: [...seedLists.lists, ...demo.customLists],
    values: partyMigration.values,
    customFields: demo.customFields,
    orgStructure,
    matterPartyTaxonomy,
    matterPartyMigrationReport: partyMigration.report,
    people: empMigration.people,
    employeeSensitiveRecords: {},
    employeeMigrationReport: empMigration.report,
    organisations: demo.organisations,
    links: demo.links,
    matters: partyMigration.matters,
    teams: demo.teams,
    tasks: demo.tasks,
    enquiries: demo.enquiries,
    quotes: demo.quotes,
    notifications: demo.notifications,
    enquirySettings: demo.enquirySettings,
    taskSettings: demo.taskSettings,
    signOffs: demo.signOffs,
    homePagesConfig: demo.homePagesConfig,
    matterCostsConfig,
    pmsLinks,
    notes: demo.notes,
    audit: demo.audit,
    mergeHistory: [],
    recentlyViewed: demo.recentlyViewed,
    counters: { ...demo.counters, PMSL: pmsLinks.length, KD: 5 },
    keyDates: buildSeedKeyDates(partyMigration.matters, demo.teams, today),
    keyDateNotApplicable: [],
    keyDateReminderStates: [],
    keyDateCalendarSyncs: [],
  };
  syncStoreFirmIdAndHomeRoles(store);
  return store;
}

function buildSeedKeyDates(
  matters: Matter[],
  teams: Team[],
  today: Date,
): KeyDate[] {
  if (matters.length === 0) return [];
  const nowIso = today.toISOString();
  const defaultTeamId = teams.find((t) => t.active)?.id ?? 'TM-000001';
  const m0 = matters[0]!;
  const m1 = matters[1] ?? m0;
  const m2 = matters[2] ?? m0;
  const m4 = matters[4] ?? m0;
  const m6 = matters[6] ?? m0;
  const m0LeadId = m0.leadFeeEarnerId || m0.responsiblePartnerId || m0.createdById;
  const m0PartnerId = m0.responsiblePartnerId || m0.leadFeeEarnerId || m0.createdById;
  const m1LeadId = m1.leadFeeEarnerId || m1.responsiblePartnerId || m1.createdById;
  const m2LeadId = m2.leadFeeEarnerId || m2.responsiblePartnerId || m2.createdById;
  const m2PartnerId = m2.responsiblePartnerId || m2.leadFeeEarnerId || m2.createdById;
  const m4LeadId = m4.leadFeeEarnerId || m4.responsiblePartnerId || m4.createdById;
  const m4PartnerId = m4.responsiblePartnerId || m4.leadFeeEarnerId || m4.createdById;
  const m6LeadId = m6.leadFeeEarnerId || m6.responsiblePartnerId || m6.createdById;
  const m6PartnerId = m6.responsiblePartnerId || m6.leadFeeEarnerId || m6.createdById;
  const addDaysIso = (d: number) => {
    const dt = new Date(today.getTime());
    dt.setUTCDate(dt.getUTCDate() + d);
    return dt.toISOString().slice(0, 10);
  };

  return [
    {
      id: 'KD-000001',
      matterId: m0.id,
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Primary Limitation Date (Simple Contract)',
      dueDate: addDaysIso(45),
      isCritical: true,
      status: 'confirmed',
      source: 'calculated',
      teamId:
        teams.find((t) => m0.leadFeeEarnerId && t.memberIds.includes(m0.leadFeeEarnerId))?.id ??
        defaultTeamId,
      responsiblePersonIds: Array.from(
        new Set(
          [m0.leadFeeEarnerId, m0.responsiblePartnerId].filter((x): x is string => Boolean(x)),
        ),
      ),
      calculation: {
        ruleSetId: 'ew-sample',
        ruleSetVersion: 1,
        ruleSetReviewStatus: 'reviewed',
        ruleId: 'contract-simple',
        triggers: { accrualDate: '2020-12-18' },
        calculatedDate: addDaysIso(45),
        explanation: [
          'Rule: Simple contract (Limitation Act 1980 s.5) (v1, status: reviewed)',
          'Trigger (single): Date cause of action accrued (accrual_date) = 2020-12-18',
          'Base period (+6 years (calendar)): 2020-12-18 -> ' + addDaysIso(45),
        ],
        overridden: false,
      },
      verification: {
        required: true,
        proposedById: m0LeadId,
        proposedAt: nowIso,
        verifiedById: m0PartnerId,
        verifiedAt: nowIso,
      },
      notes: 'Confirmed against signed supply agreement.',
      createdById: m0LeadId,
      createdAt: nowIso,
      updatedById: m0PartnerId,
      updatedAt: nowIso,
      version: 2,
    },
    {
      id: 'KD-000002',
      matterId: m1.id,
      keyDateTypeId: 'court_deadline',
      category: 'court_deadline',
      title: 'CMC Witness Statements Exchange',
      dueDate: addDaysIso(14),
      dueTime: '16:00',
      isCritical: true,
      status: 'awaiting_verification',
      source: 'manual',
      teamId:
        teams.find((t) => m1.leadFeeEarnerId && t.memberIds.includes(m1.leadFeeEarnerId))?.id ??
        defaultTeamId,
      responsiblePersonIds: Array.from(
        new Set(
          [m1.leadFeeEarnerId, m1.responsiblePartnerId].filter((x): x is string => Boolean(x)),
        ),
      ),
      verification: {
        required: true,
        proposedById: m1LeadId,
        proposedAt: nowIso,
      },
      notes: 'Per sealed Case Management Order.',
      createdById: m1LeadId,
      createdAt: nowIso,
      updatedById: m1LeadId,
      updatedAt: nowIso,
      version: 1,
    },
    {
      id: 'KD-000003',
      matterId: m2.id,
      keyDateTypeId: 'contract_date',
      category: 'contractual',
      title: 'Longstop Completion Date',
      dueDate: addDaysIso(28),
      isCritical: false,
      status: 'confirmed',
      source: 'manual',
      teamId:
        teams.find((t) => m2.leadFeeEarnerId && t.memberIds.includes(m2.leadFeeEarnerId))?.id ??
        defaultTeamId,
      responsiblePersonIds: Array.from(
        new Set(
          [m2.leadFeeEarnerId, m2.responsiblePartnerId].filter((x): x is string => Boolean(x)),
        ),
      ),
      verification: {
        required: false,
        proposedById: m2LeadId,
        proposedAt: nowIso,
        verifiedById: m2PartnerId,
        verifiedAt: nowIso,
      },
      createdById: m2LeadId,
      createdAt: nowIso,
      updatedById: m2PartnerId,
      updatedAt: nowIso,
      version: 1,
    },
    {
      id: 'KD-000004',
      matterId: m4.id,
      keyDateTypeId: 'court_deadline',
      category: 'court_deadline',
      title: 'Adjudicator Decision Deadline (28-day statutory period)',
      dueDate: addDaysIso(9),
      dueTime: '17:00',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId:
        teams.find((t) => m4.leadFeeEarnerId && t.memberIds.includes(m4.leadFeeEarnerId))?.id ??
        defaultTeamId,
      responsiblePersonIds: Array.from(
        new Set(
          [m4.leadFeeEarnerId, m4.responsiblePartnerId].filter((x): x is string => Boolean(x)),
        ),
      ),
      verification: {
        required: true,
        proposedById: m4LeadId,
        proposedAt: nowIso,
        verifiedById: m4PartnerId,
        verifiedAt: nowIso,
      },
      notes: 'Statutory 28-day adjudication decision deadline from Referral Notice.',
      createdById: m4LeadId,
      createdAt: nowIso,
      updatedById: m4PartnerId,
      updatedAt: nowIso,
      version: 1,
    },
    {
      id: 'KD-000005',
      matterId: m6.id,
      keyDateTypeId: 'court_deadline',
      category: 'court_deadline',
      title: 'Employment Tribunal Preliminary Hearing (Bristol ET)',
      dueDate: addDaysIso(12),
      dueTime: '10:00',
      isCritical: true,
      status: 'confirmed',
      source: 'manual',
      teamId:
        teams.find((t) => m6.leadFeeEarnerId && t.memberIds.includes(m6.leadFeeEarnerId))?.id ??
        defaultTeamId,
      responsiblePersonIds: Array.from(
        new Set(
          [m6.leadFeeEarnerId, m6.responsiblePartnerId].filter((x): x is string => Boolean(x)),
        ),
      ),
      verification: {
        required: true,
        proposedById: m6LeadId,
        proposedAt: nowIso,
        verifiedById: m6PartnerId,
        verifiedAt: nowIso,
      },
      notes: 'Listed before Employment Judge for case management directions.',
      createdById: m6LeadId,
      createdAt: nowIso,
      updatedById: m6PartnerId,
      updatedAt: nowIso,
      version: 1,
    },
  ];
}

/**
 * Creates a clean, empty store representing a brand-new tenant deployment
 * with zero client records, zero employees, zero matters, zero enquiries,
 * zero quotes, zero tasks, zero teams, zero PMS links, and zero audit history,
 * while retaining the Core taxonomy/lists and default tenant configuration.
 */
export function createCleanDeploymentStore(today: Date = new Date()): FirmStore {
  const nowIso = today.toISOString();
  const seedLists = buildSeedLists();
  const tenantCfg = getActiveTenantConfiguration();
  const orgStructure = buildDefaultOrgStructure({
    legalName: tenantCfg.displayName,
  });
  const matterPartyTaxonomy = buildDefaultMatterPartyTaxonomy(seedLists.values);
  const partyMigration = migrateMatterPartiesToTwoFieldModel(
    seedLists.values,
    [],
    matterPartyTaxonomy,
    nowIso,
  );
  const homePagesConfig = createDefaultHomePagesConfig(
    nowIso,
    tenantCfg.branding.primaryDomain,
  );
  homePagesConfig.firmSettings.demoMode = false;
  const matterCostsConfig = createDefaultMatterCostsConfig(
    partyMigration.values,
    nowIso,
    {
      clientProfileCode: tenantCfg.tenantId,
      displayName: tenantCfg.displayName,
      primaryDomain: tenantCfg.branding.primaryDomain,
    },
  );

  return {
    firmId: resolveActiveFirmId(),
    firm: {
      name: tenantCfg.displayName,
      shortName: tenantCfg.displayName.replace(/\s+LLP$/i, '').trim() || tenantCfg.displayName,
      offices: orgStructure.offices.map((o) => o.name),
    },
    isCleanDeployment: true,
    lists: seedLists.lists,
    values: partyMigration.values,
    customFields: [],
    orgStructure,
    matterPartyTaxonomy,
    matterPartyMigrationReport: partyMigration.report,
    people: [],
    employeeSensitiveRecords: {},
    employeeMigrationReport: {
      migratedAt: nowIso,
      migratedCount: 0,
      unmappedRecords: [],
    },
    organisations: [],
    links: [],
    matters: [],
    teams: [],
    tasks: [],
    enquiries: [],
    quotes: [],
    notifications: [],
    enquirySettings: { ...DEFAULT_ENQUIRY_SETTINGS },
    taskSettings: {
      templates: DEFAULT_TASK_SETTINGS.templates.map((t) => ({ ...t })),
    },
    signOffs: [],
    homePagesConfig,
    matterCostsConfig,
    pmsLinks: [],
    notes: [],
    audit: [],
    mergeHistory: [],
    recentlyViewed: {},
    counters: {},
    keyDates: [],
    keyDateNotApplicable: [],
    keyDateReminderStates: [],
    keyDateCalendarSyncs: [],
  };
}

function syncStoreHomePageRoles(store: FirmStore): boolean {
  if (!store.homePagesConfig || !Array.isArray(store.homePagesConfig.roles)) {
    return false;
  }
  const syncedRoles = syncHomeRolesWithEmployeeRoles(
    store.homePagesConfig.roles,
    store.values ?? [],
    createDefaultRoleConfigs(getActiveTenantConfiguration().branding.primaryDomain),
  );
  if (
    syncedRoles.length !== store.homePagesConfig.roles.length ||
    syncedRoles.some(
      (r, i) =>
        r.key !== store.homePagesConfig.roles[i]?.key ||
        r.label !== store.homePagesConfig.roles[i]?.label ||
        r.employeeRoleId !== store.homePagesConfig.roles[i]?.employeeRoleId,
    )
  ) {
    store.homePagesConfig.roles = syncedRoles;
    return true;
  }
  return false;
}

function syncStoreFirmIdAndHomeRoles(store: FirmStore): boolean {
  let changed = false;
  const activeFirmId = resolveActiveFirmId();
  if (store.firmId !== activeFirmId) {
    store.firmId = activeFirmId;
    changed = true;
  }
  if (syncStoreHomePageRoles(store)) {
    changed = true;
  }
  return changed;
}

export { DEFAULT_USER_ID };
