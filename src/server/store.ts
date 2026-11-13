import fs from 'node:fs';
import path from 'node:path';
import { migrateEmployeesToEmploymentRecords } from '@/domain/employment';
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
import {
  resolveConfiguredFirmPrimaryDomain,
} from './rbacRuntime';
import {
  getActiveTenantConfiguration,
} from '@/platform/tenantRuntime';
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
import { getPmsSource } from '@/pms/pmsSource';
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

const DATA_DIR = path.join(process.cwd(), 'data');
const RUNTIME_DATA_FILE = path.join(DATA_DIR, 'runtime-store.json');

export function resolveRuntimeStoreFilePath(): string {
  const overridePath = process.env.ONESQUARED_RUNTIME_STORE_PATH?.trim();
  if (overridePath) {
    return path.resolve(/*turbopackIgnore: true*/ process.cwd(), overridePath);
  }
  return RUNTIME_DATA_FILE;
}

function resolveReadableStorePath(): string | null {
  const runtimePath = resolveRuntimeStoreFilePath();
  if (fs.existsSync(runtimePath)) return runtimePath;
  return null;
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

declare global {
  var __oneSquaredStore: FirmStore | undefined;
  var __oneSquaredStoreMtimeMs: number | undefined;
  var __oneSquaredLastSavedStoreJson: string | undefined;
}

/**
 * Test-only helper that clears `global.__oneSquaredStore` so the next `getStore()` call reloads
 * from the persisted store (which in tests is the test-mode `global.__oneSquaredLastSavedStoreJson`
 * copy rather than disk). Throws if called outside test environments (`VITEST` or `NODE_ENV === 'test'`).
 */
export function clearStoreMemoryCache(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    throw new Error('clearStoreMemoryCache is only permitted in test environments.');
  }
  global.__oneSquaredStore = undefined;
}

function buildInitialPmsLinks(
  organisations: Organisation[],
  people: Person[],
  matters: Matter[],
  existingLinks: PmsLink[] = [],
  nowIso: string = new Date().toISOString(),
): PmsLink[] {
  const pms = getPmsSource();
  const pmsClients = pms.listClients();
  const pmsFeeEarners = pms.listFeeEarners();
  const pmsMatters = pms.listMatters();

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
    pmsClients,
    pmsFeeEarners,
    pmsMatters,
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
  const pmsFeeEarners = getPmsSource().listFeeEarners();
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

function hasInvalidSupervisingPartner(person: Person, allPeople: Person[]): boolean {
  const supId = person.employment?.supervisingPartnerId;
  if (!supId) return false;
  const sup = allPeople.find((sp) => sp.id === supId);
  return !sup || (!sup.isEmployee && !sup.employment);
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

export function getStore(): FirmStore {
  const isTestEnv = Boolean(
    (process.env.VITEST || process.env.NODE_ENV === 'test') &&
      !process.env.ONESQUARED_RUNTIME_STORE_PATH,
  );
  const activeStorePath = resolveReadableStorePath();
  if (!isTestEnv && activeStorePath) {
    try {
      const diskMtimeMs = fs.statSync(activeStorePath).mtimeMs;
      if (global.__oneSquaredStore && global.__oneSquaredStoreMtimeMs !== diskMtimeMs) {
        global.__oneSquaredStore = undefined;
      }
    } catch {
      // ignore stat errors
    }
  }
  if (
    global.__oneSquaredStore &&
    Array.isArray(global.__oneSquaredStore.matters) &&
    Array.isArray(global.__oneSquaredStore.enquiries) &&
    Array.isArray(global.__oneSquaredStore.tasks) &&
    Array.isArray(global.__oneSquaredStore.teams) &&
    Array.isArray(global.__oneSquaredStore.pmsLinks) &&
    Array.isArray(global.__oneSquaredStore.signOffs) &&
    global.__oneSquaredStore.homePagesConfig
  ) {
    const seedLists = buildSeedLists();
    let addedSeedItems = false;
    const activeFirmId = resolveActiveFirmId();
    if (global.__oneSquaredStore.firmId !== activeFirmId) {
      global.__oneSquaredStore.firmId = activeFirmId;
      addedSeedItems = true;
    }
    if (syncStoreHomePageRoles(global.__oneSquaredStore)) {
      addedSeedItems = true;
    }
    for (const l of seedLists.lists) {
      if (!global.__oneSquaredStore.lists.some((x) => x.key === l.key)) {
        global.__oneSquaredStore.lists.push(l);
        addedSeedItems = true;
      }
    }
    for (const v of seedLists.values) {
      const existingVal = global.__oneSquaredStore.values.find((x) => x.id === v.id);
      if (!existingVal) {
        global.__oneSquaredStore.values.push(v);
        addedSeedItems = true;
      } else if (v.listKey === 'work_type' && v.meta) {
        if (
          existingVal.meta?.amlInScope === undefined ||
          existingVal.meta?.clientMoneyThresholdGbp === undefined
        ) {
          existingVal.meta = {
            ...v.meta,
            ...(existingVal.meta ?? {}),
          };
          addedSeedItems = true;
        }
      }
    }
    if (!global.__oneSquaredStore.orgStructure) {
      global.__oneSquaredStore.orgStructure = buildDefaultOrgStructure({
        legalName: getActiveTenantConfiguration().displayName,
      });
      addedSeedItems = true;
    }
    if (!global.__oneSquaredStore.employeeSensitiveRecords) {
      global.__oneSquaredStore.employeeSensitiveRecords = {};
      addedSeedItems = true;
    }
    if (
      global.__oneSquaredStore.people.some(
        (p) =>
          (p.isEmployee && !p.employment) ||
          hasInvalidSupervisingPartner(p, global.__oneSquaredStore!.people) ||
          (p.employment?.divisionId === 'DIV-LEGAL' && !p.employment.supervisingPartnerId),
      )
    ) {
      const empMig = migrateEmployeesToEmploymentRecords(
        global.__oneSquaredStore.people,
        global.__oneSquaredStore.values,
        global.__oneSquaredStore.orgStructure,
        global.__oneSquaredStore.pmsLinks,
        resolveConfiguredFirmPrimaryDomain(),
      );
      global.__oneSquaredStore.people = empMig.people;
      global.__oneSquaredStore.employeeMigrationReport = empMig.report;
      addedSeedItems = true;
    }
    const mpList = global.__oneSquaredStore.lists.find((x) => x.key === 'matter_party_role');
    if (mpList && mpList.label !== 'Matter Parties') {
      mpList.label = 'Matter Parties';
      addedSeedItems = true;
    }
    if (
      !global.__oneSquaredStore.matterPartyTaxonomy ||
      !global.__oneSquaredStore.matterPartyMigrationReport ||
      global.__oneSquaredStore.values.some((v) => v.listKey === 'matter_party_role' && v.active)
    ) {
      const taxonomy =
        global.__oneSquaredStore.matterPartyTaxonomy ??
        buildDefaultMatterPartyTaxonomy(global.__oneSquaredStore.values);
      const partyMig = migrateMatterPartiesToTwoFieldModel(
        global.__oneSquaredStore.values,
        global.__oneSquaredStore.matters,
        taxonomy,
      );
      global.__oneSquaredStore.matterPartyTaxonomy = taxonomy;
      global.__oneSquaredStore.values = partyMig.values;
      global.__oneSquaredStore.matters = partyMig.matters;
      global.__oneSquaredStore.matterPartyMigrationReport = partyMig.report;
      addedSeedItems = true;
    }
    if (!global.__oneSquaredStore.matterCostsConfig) {
      const tenantCfg = getActiveTenantConfiguration();
      global.__oneSquaredStore.matterCostsConfig = syncRateCardsWithPmsFeeEarners(
        createDefaultMatterCostsConfig(global.__oneSquaredStore.values, {
          clientProfileCode: tenantCfg.tenantId,
          displayName: tenantCfg.displayName,
          primaryDomain: tenantCfg.branding.primaryDomain,
        }),
        getPmsSource().listFeeEarners(),
        global.__oneSquaredStore.values,
      );
      addedSeedItems = true;
    }
    if (addedSeedItems) {
      saveStore(global.__oneSquaredStore);
    }
    return global.__oneSquaredStore;
  }
  if (!isTestEnv && activeStorePath) {
    try {
      const raw = fs.readFileSync(activeStorePath, 'utf8');
      const parsed = JSON.parse(raw) as FirmStore;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('Root JSON value must be an object.');
      }
      let migrated = false;
      const seedLists = buildSeedLists();

      if (!Array.isArray(parsed.organisations)) parsed.organisations = [];
      if (!Array.isArray(parsed.people)) parsed.people = [];
      if (!Array.isArray(parsed.links)) parsed.links = [];
      if (!Array.isArray(parsed.matters)) parsed.matters = [];
      if (!Array.isArray(parsed.teams)) parsed.teams = [];
      if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
      if (!Array.isArray(parsed.enquiries)) parsed.enquiries = [];
      if (!Array.isArray(parsed.quotes)) parsed.quotes = [];
      if (!Array.isArray(parsed.notifications)) parsed.notifications = [];
      if (!Array.isArray(parsed.signOffs)) parsed.signOffs = [];
      if (!parsed.recentlyViewed || typeof parsed.recentlyViewed !== 'object') {
        parsed.recentlyViewed = {};
      }
      if (!Array.isArray(parsed.pmsLinks)) parsed.pmsLinks = [];
      if (!Array.isArray(parsed.notes)) parsed.notes = [];
      if (!Array.isArray(parsed.audit)) parsed.audit = [];
      if (!Array.isArray(parsed.mergeHistory)) parsed.mergeHistory = [];
      if (!parsed.counters) parsed.counters = {};

      if (!parsed.enquirySettings) {
        parsed.enquirySettings = { ...DEFAULT_ENQUIRY_SETTINGS };
        migrated = true;
      }

      if (!parsed.taskSettings) {
        parsed.taskSettings = {
          templates: DEFAULT_TASK_SETTINGS.templates.map((t) => ({ ...t })),
        };
        migrated = true;
      }

      if (!parsed.homePagesConfig || !Array.isArray(parsed.homePagesConfig.roles)) {
        parsed.homePagesConfig = createDefaultHomePagesConfig(
          new Date().toISOString(),
          getActiveTenantConfiguration().branding.primaryDomain,
        );
        migrated = true;
      } else if (!parsed.homePagesConfig.updatedById || parsed.homePagesConfig.updatedById === 'system') {
        for (const r of parsed.homePagesConfig.roles) {
          if (r.isBuiltIn && (r.primaryPanels.includes('my_tasks_today') || r.summaryPanels.includes('my_tasks_today')) && !r.primaryPanels.includes('to_do') && !r.summaryPanels.includes('to_do')) {
            r.primaryPanels = r.primaryPanels
              .map((p) => (p === 'my_tasks_today' ? 'to_do' : p))
              .filter((p) => p !== 'key_dates_and_deadlines');
            r.summaryPanels = r.summaryPanels
              .map((p) => (p === 'my_tasks_today' ? 'to_do' : p))
              .filter((p) => p !== 'key_dates_and_deadlines');
            migrated = true;
          }
        }
      }

      for (const l of seedLists.lists) {
        if (!parsed.lists.some((x) => x.key === l.key)) {
          parsed.lists.push(l);
          migrated = true;
        }
      }
      for (const v of seedLists.values) {
        const existingVal = parsed.values.find((x) => x.id === v.id);
        if (!existingVal) {
          parsed.values.push(v);
          migrated = true;
        } else if (v.listKey === 'work_type' && v.meta) {
          if (
            existingVal.meta?.amlInScope === undefined ||
            existingVal.meta?.clientMoneyThresholdGbp === undefined
          ) {
            existingVal.meta = {
              ...v.meta,
              ...(existingVal.meta ?? {}),
            };
            migrated = true;
          }
        }
      }

      if (!parsed.orgStructure) {
        parsed.orgStructure = buildDefaultOrgStructure({
          legalName: getActiveTenantConfiguration().displayName,
        });
        migrated = true;
      }
      if (!parsed.employeeSensitiveRecords) {
        parsed.employeeSensitiveRecords = {};
        migrated = true;
      }
      if (
        parsed.people.some(
          (p) =>
            (p.isEmployee && !p.employment) ||
            hasInvalidSupervisingPartner(p, parsed.people) ||
            (p.employment?.divisionId === 'DIV-LEGAL' && !p.employment.supervisingPartnerId),
        )
      ) {
        const empMig = migrateEmployeesToEmploymentRecords(
          parsed.people,
          parsed.values,
          parsed.orgStructure,
          parsed.pmsLinks,
          resolveConfiguredFirmPrimaryDomain(),
        );
        parsed.people = empMig.people;
        parsed.employeeMigrationReport = empMig.report;
        migrated = true;
      }

      const parsedMpList = parsed.lists.find((x) => x.key === 'matter_party_role');
      if (parsedMpList && parsedMpList.label !== 'Matter Parties') {
        parsedMpList.label = 'Matter Parties';
        migrated = true;
      }

      if (
        !parsed.matterPartyTaxonomy ||
        !parsed.matterPartyMigrationReport ||
        parsed.values.some((v) => v.listKey === 'matter_party_role' && v.active)
      ) {
        const taxonomy =
          parsed.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(parsed.values);
        const partyMig = migrateMatterPartiesToTwoFieldModel(
          parsed.values,
          parsed.matters,
          taxonomy,
        );
        parsed.matterPartyTaxonomy = taxonomy;
        parsed.values = partyMig.values;
        parsed.matters = partyMig.matters;
        parsed.matterPartyMigrationReport = partyMig.report;
        migrated = true;
      }

      if (!parsed.matterCostsConfig) {
        const tenantCfg = getActiveTenantConfiguration();
        parsed.matterCostsConfig = syncRateCardsWithPmsFeeEarners(
          createDefaultMatterCostsConfig(parsed.values, {
            clientProfileCode: tenantCfg.tenantId,
            displayName: tenantCfg.displayName,
            primaryDomain: tenantCfg.branding.primaryDomain,
          }),
          getPmsSource().listFeeEarners(),
          parsed.values,
        );
        migrated = true;
      }

      if (!Array.isArray(parsed.keyDates)) {
        parsed.keyDates = [];
        migrated = true;
      }
      if (!Array.isArray(parsed.keyDateNotApplicable)) {
        parsed.keyDateNotApplicable = [];
        migrated = true;
      }
      if (!Array.isArray(parsed.keyDateReminderStates)) {
        parsed.keyDateReminderStates = [];
        migrated = true;
      }
      if (!Array.isArray(parsed.keyDateCalendarSyncs)) {
        parsed.keyDateCalendarSyncs = [];
        migrated = true;
      }

      if (syncStoreFirmIdAndHomeRoles(parsed)) {
        migrated = true;
      }

      if (migrated) {
        saveStore(parsed);
      }
      global.__oneSquaredStore = parsed;
      try {
        const currentPath = resolveReadableStorePath();
        if (currentPath) {
          global.__oneSquaredStoreMtimeMs = fs.statSync(currentPath).mtimeMs;
        }
      } catch {
        // ignore stat errors
      }
      return global.__oneSquaredStore;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Refusing to load corrupted runtime store file at ${activeStorePath}: not valid JSON.`,
        );
      }
      const code =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'UNKNOWN_ERROR';
      throw new Error(
        `Failed to load runtime store file at ${activeStorePath} (code: ${code}).`,
      );
    }
  }
  if (isTestEnv && global.__oneSquaredLastSavedStoreJson) {
    try {
      const parsed = JSON.parse(global.__oneSquaredLastSavedStoreJson) as FirmStore;
      if (!Array.isArray(parsed.organisations)) parsed.organisations = [];
      if (!Array.isArray(parsed.people)) parsed.people = [];
      if (!Array.isArray(parsed.links)) parsed.links = [];
      if (!Array.isArray(parsed.matters)) parsed.matters = [];
      if (!Array.isArray(parsed.teams)) parsed.teams = [];
      if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
      if (!Array.isArray(parsed.enquiries)) parsed.enquiries = [];
      if (!Array.isArray(parsed.quotes)) parsed.quotes = [];
      if (!Array.isArray(parsed.notifications)) parsed.notifications = [];
      if (!Array.isArray(parsed.signOffs)) parsed.signOffs = [];
      if (!parsed.recentlyViewed || typeof parsed.recentlyViewed !== 'object') {
        parsed.recentlyViewed = {};
      }
      if (
        !parsed.employeeSensitiveRecords ||
        typeof parsed.employeeSensitiveRecords !== 'object'
      ) {
        parsed.employeeSensitiveRecords = {};
      }
      if (!Array.isArray(parsed.notes)) parsed.notes = [];
      if (!Array.isArray(parsed.audit)) parsed.audit = [];
      if (!Array.isArray(parsed.mergeHistory)) parsed.mergeHistory = [];
      if (!Array.isArray(parsed.keyDates)) parsed.keyDates = [];
      if (!Array.isArray(parsed.keyDateNotApplicable)) parsed.keyDateNotApplicable = [];
      if (!Array.isArray(parsed.keyDateReminderStates)) parsed.keyDateReminderStates = [];
      if (!Array.isArray(parsed.keyDateCalendarSyncs)) parsed.keyDateCalendarSyncs = [];
      global.__oneSquaredStore = parsed;
      return global.__oneSquaredStore;
    } catch {
      // fall through to fresh seed store
    }
  }
  const fresh = createCleanDeploymentStore(new Date());
  saveStore(fresh);
  return fresh;
}

const MOVED_TO_POSTGRES_STORE_KEYS: ReadonlySet<string> = new Set([
  'audit',
  'documentTemplates',
  'documentTemplateVersions',
  'documents',
  'documentLinks',
  'templateUsageEvents',
  'documentGenerationConfigOverride',
  'matterDocumentLocations',
  'documentStoreFolderScopes',
  'documentLifecycleJobs',
  'documentReconciliationFindings',
  'documentStoreAuditEvents',
  'documentStoreConfigOverride',
  'keyDates',
  'keyDateNotApplicable',
  'keyDateReminderStates',
  'keyDateCalendarSyncs',
  'keyDatesConfigOverride',
  'people',
  'organisations',
  'links',
  'matters',
  'notes',
  'mergeHistory',
  'tasks',
  'enquiries',
  'quotes',
  'notifications',
  'signOffs',
  'recentlyViewed',
  'teams',
  'employeeSensitiveRecords',
  'employeeMigrationReport',
  'rbacConfigOverride',
]);

function serializeUnmigratedStoreForPersistence(
  store: FirmStore,
  space?: number,
): string {
  const unmigratedCopy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store)) {
    if (!MOVED_TO_POSTGRES_STORE_KEYS.has(key)) {
      unmigratedCopy[key] = value;
    }
  }
  return JSON.stringify(unmigratedCopy, null, space);
}

export function saveStore(store: FirmStore): void {
  global.__oneSquaredStore = store;
  if (
    (process.env.VITEST || process.env.NODE_ENV === 'test') &&
    !process.env.ONESQUARED_RUNTIME_STORE_PATH
  ) {
    global.__oneSquaredLastSavedStoreJson =
      serializeUnmigratedStoreForPersistence(store);
    return;
  }
  try {
    const targetPath = resolveRuntimeStoreFilePath();
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(
        tmpPath,
        serializeUnmigratedStoreForPersistence(store, 2),
        'utf8',
      );
      fs.renameSync(tmpPath, targetPath);
    } catch (writeErr) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw writeErr;
    }
    global.__oneSquaredStoreMtimeMs = fs.statSync(targetPath).mtimeMs;
  } catch {
    // ignore read-only fs errors in serverless environments
  }
}

export function resetStore(): FirmStore {
  const includeSyntheticEntraOids =
    getActiveTenantConfiguration().environment === 'test';
  const fresh = createSeedStore(new Date(), { includeSyntheticEntraOids });
  saveStore(fresh);
  return fresh;
}

export function clearStoreToCleanDeployment(): FirmStore {
  const clean = createCleanDeploymentStore(new Date());
  saveStore(clean);
  return clean;
}

export function nextId(
  store: FirmStore,
  prefix: 'P' | 'O' | 'L' | 'N' | 'AU' | 'M' | 'TM' | 'TSK' | 'ENQ' | 'NTF' | 'PMSL' | 'SO' | 'KD',
): string {
  const n = (store.counters[prefix] ?? 0) + 1;
  store.counters[prefix] = n;
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

export function nextQuoteReference(store: FirmStore, year: number = new Date().getFullYear()): string {
  const n = (store.counters.QTE ?? 0) + 1;
  store.counters.QTE = n;
  return `QTE-${year}-${String(n).padStart(4, '0')}`;
}

export { DEFAULT_USER_ID };


