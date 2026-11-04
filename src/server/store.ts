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
  setRuntimeRbacConfigOverride,
} from './rbacRuntime';
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
const SEED_DATA_FILE = path.join(DATA_DIR, 'seed-not-a-law-firm.json');
const RUNTIME_DATA_FILE = path.join(DATA_DIR, 'runtime-store.json');

function resolveReadableStorePath(): string | null {
  if (fs.existsSync(RUNTIME_DATA_FILE)) return RUNTIME_DATA_FILE;
  if (fs.existsSync(SEED_DATA_FILE)) return SEED_DATA_FILE;
  return null;
}

function resolveActiveFirmId(): string {
  return getActiveTenantConfiguration().tenantId;
}

declare global {
  var __oneSquaredStore: FirmStore | undefined;
  var __oneSquaredStoreMtimeMs: number | undefined;
}

function buildInitialPmsLinks(
  organisations: Organisation[],
  people: Person[],
  matters: Matter[],
  existingLinks: PmsLink[] = [],
): PmsLink[] {
  const pms = getPmsSource();
  const pmsClients = pms.listClients();
  const pmsFeeEarners = pms.listFeeEarners();
  const pmsMatters = pms.listMatters();
  const nowIso = new Date().toISOString();

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

export function createSeedStore(today: Date = new Date()): FirmStore {
  const seedLists = buildSeedLists();
  const demo = buildDemoData(today);
  const pmsLinks = buildInitialPmsLinks(demo.organisations, demo.people, demo.matters);
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
    counters: { ...demo.counters, PMSL: pmsLinks.length, KD: 4 },
    keyDates: buildSeedKeyDates(partyMigration.matters, demo.teams, today),
    keyDateNotApplicable: [],
    keyDateReminderStates: [],
    keyDateCalendarSyncs: [],
  };
  migrateFirmBrandingToNotALawFirm(store);
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
  const m0LeadId = m0.leadFeeEarnerId || m0.responsiblePartnerId || m0.createdById;
  const m0PartnerId = m0.responsiblePartnerId || m0.leadFeeEarnerId || m0.createdById;
  const m1LeadId = m1.leadFeeEarnerId || m1.responsiblePartnerId || m1.createdById;
  const m2LeadId = m2.leadFeeEarnerId || m2.responsiblePartnerId || m2.createdById;
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
        verifiedById: m2LeadId,
        verifiedAt: nowIso,
      },
      createdById: m2LeadId,
      createdAt: nowIso,
      updatedById: m2LeadId,
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
    firm: FIRM,
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

let firestoreSynced = false;

async function trySyncToFirestore(store: FirmStore): Promise<void> {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return;
  }
  try {
    const { getApps, initializeApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        initializeApp({
          credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
          projectId: process.env.FIREBASE_PROJECT_ID || 'onesquared-poc',
        });
      } else {
        initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'onesquared-poc' });
      }
    }
    const db = getFirestore();
    await db
      .collection('firms')
      .doc(store.firmId)
      .set(
        {
          firm: store.firm,
          counters: store.counters,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    firestoreSynced = true;
  } catch {
    // Fallback to local store when Firestore API or credentials are not active
  }
}

function isStoreDemoModeEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  const activeTenantConfig = getActiveTenantConfiguration();
  if (activeTenantConfig.environment === 'live') {
    return false;
  }
  return Boolean(activeTenantConfig.featureFlags?.enableDemoMode);
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

function migrateFirmBrandingToNotALawFirm(store: FirmStore): boolean {
  let changed = false;
  const activeFirmId = resolveActiveFirmId();
  if (store.firmId !== activeFirmId) {
    store.firmId = activeFirmId;
    changed = true;
  }
  if (syncStoreHomePageRoles(store)) {
    changed = true;
  }
  if (!isStoreDemoModeEnabled() || store.isCleanDeployment) {
    return changed;
  }
  const tenantCfg = getActiveTenantConfiguration();
  const targetDomain = resolveConfiguredFirmPrimaryDomain(tenantCfg);
  if (!store.firm || store.firm.name !== FIRM.name || store.firm.shortName !== FIRM.shortName) {
    store.firm = { ...FIRM };
    changed = true;
  }
  if (store.orgStructure && Array.isArray(store.orgStructure.legalEntities)) {
    const defaultEntities = buildDefaultOrgStructure({
      legalName: tenantCfg.displayName,
    }).legalEntities;
    for (const defLe of defaultEntities) {
      const existingLe = store.orgStructure.legalEntities.find((le) => le.id === defLe.id);
      if (existingLe && existingLe.name.includes('Pembroke Vaughan')) {
        existingLe.name = defLe.name;
        existingLe.code = defLe.code;
        changed = true;
      }
    }
  }
  if (Array.isArray(store.people)) {
    for (const p of store.people) {
      if (Array.isArray(p.emails)) {
        for (const em of p.emails) {
          if (em.address.toLowerCase().includes('@pembrokevaughan.example')) {
            em.address = em.address.replace(
              /@pembrokevaughan\.example/gi,
              `@${targetDomain}`,
            );
            changed = true;
          }
        }
        // Deduplicate emails if migration collapsed an existing + newly added email
        const seen = new Set<string>();
        p.emails = p.emails.filter((em) => {
          const lower = em.address.toLowerCase();
          if (seen.has(lower)) return false;
          seen.add(lower);
          return true;
        });
      }
      if (p.employment?.systems?.firmWorkEmail?.toLowerCase().includes('@pembrokevaughan')) {
        p.employment.systems.firmWorkEmail = p.employment.systems.firmWorkEmail.replace(
          /@pembrokevaughan\.example/gi,
          `@${targetDomain}`,
        );
        changed = true;
      }
    }
  }
  if (store.homePagesConfig && Array.isArray(store.homePagesConfig.roles)) {
    for (const r of store.homePagesConfig.roles) {
      if (r.demoUserEmail?.toLowerCase().includes('@pembrokevaughan.example')) {
        r.demoUserEmail = r.demoUserEmail.replace(
          /@pembrokevaughan\.example/gi,
          `@${targetDomain}`,
        );
        changed = true;
      }
    }
  }
  if (
    store.matterCostsConfig &&
    (store.matterCostsConfig.clientProfileCode === 'BASE-STANDARD' ||
      store.matterCostsConfig.clientProfileName.includes('Pembroke Vaughan') ||
      store.matterCostsConfig.clientProfileName.includes('Standard Base Platform'))
  ) {
    store.matterCostsConfig.clientProfileCode = tenantCfg.tenantId;
    store.matterCostsConfig.clientProfileName = `${tenantCfg.displayName} — Client Configuration (${tenantCfg.branding.primaryDomain})`;
    changed = true;
  }
  return changed;
}

export function getStore(): FirmStore {
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
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
      let migrated = false;
      const seedLists = buildSeedLists();

      if (!parsed.isCleanDeployment) {
        const demo = buildDemoData(new Date());

        if (!Array.isArray(parsed.matters) || parsed.matters.length === 0) {
          parsed.matters = demo.matters;
          parsed.counters = { ...parsed.counters, M: demo.counters.M };
          migrated = true;
        }

        if (!Array.isArray(parsed.teams) || parsed.teams.length === 0) {
          parsed.teams = demo.teams;
          parsed.counters = { ...parsed.counters, TM: demo.counters.TM };
          migrated = true;
        }

        if (!Array.isArray(parsed.enquiries) || parsed.enquiries.length === 0) {
          parsed.enquiries = demo.enquiries;
          parsed.counters = { ...parsed.counters, ENQ: demo.counters.ENQ };
          migrated = true;
        }

        // Ensure PMS-aligned demo organisations, people, and matters are present
        for (const demoOrg of demo.organisations) {
          const existingOrg = parsed.organisations.find((x) => x.id === demoOrg.id);
          if (!existingOrg) {
            parsed.organisations.push(demoOrg);
            migrated = true;
          } else if (existingOrg.companyNumber !== demoOrg.companyNumber && demoOrg.id <= 'O-000007') {
            existingOrg.companyNumber = demoOrg.companyNumber;
            existingOrg.legalName = demoOrg.legalName;
            existingOrg.otherNames = demoOrg.otherNames;
            migrated = true;
          }
        }

        for (const p of demo.people) {
          const existingPerson = parsed.people.find(
            (x) =>
              x.id === p.id ||
              (p.emails[0] &&
                x.emails.some((e) => e.address.toLowerCase() === p.emails[0].address.toLowerCase())),
          );
          if (!existingPerson) {
            parsed.people.push(p);
            parsed.counters.P = Math.max(parsed.counters.P ?? 0, demo.counters.P);
            migrated = true;
          } else {
            // Ensure PMS matching emails and role/demo metadata exist on seeded employees
            for (const em of p.emails) {
              if (!existingPerson.emails.some((e) => e.address.toLowerCase() === em.address.toLowerCase())) {
                existingPerson.emails.push(em);
                migrated = true;
              }
            }
            if (p.roles && (!existingPerson.roles || existingPerson.roles.length === 0)) {
              existingPerson.roles = p.roles;
              migrated = true;
            }
            if (p.demo !== undefined && existingPerson.demo !== p.demo) {
              existingPerson.demo = p.demo;
              existingPerson.showsWorkOfId = p.showsWorkOfId ?? null;
              migrated = true;
            }
            if (p.supportsIds && (!existingPerson.supportsIds || existingPerson.supportsIds.length === 0)) {
              existingPerson.supportsIds = p.supportsIds;
              migrated = true;
            }
          }
        }

        // Sync team memberships for newly added employees/demo users
        for (const demoTeam of demo.teams) {
          const existingTeam = parsed.teams.find((t) => t.id === demoTeam.id || t.name === demoTeam.name);
          if (existingTeam) {
            for (const memberId of demoTeam.memberIds) {
              if (!existingTeam.memberIds.includes(memberId)) {
                existingTeam.memberIds.push(memberId);
                migrated = true;
              }
            }
            for (const leadId of demoTeam.leadIds) {
              if (!existingTeam.leadIds.includes(leadId)) {
                existingTeam.leadIds.push(leadId);
                migrated = true;
              }
            }
          }
        }

        for (const m of demo.matters) {
          const existingMatter = parsed.matters.find(
            (x) => x.id === m.id || x.matterNumber === m.matterNumber,
          );
          if (!existingMatter) {
            parsed.matters.push(m);
            parsed.counters.M = Math.max(parsed.counters.M ?? 0, demo.counters.M);
            migrated = true;
          } else if (m.fieldValues && Object.keys(m.fieldValues).length > 0) {
            existingMatter.fieldValues = {
              ...existingMatter.fieldValues,
              ...m.fieldValues,
            };
            migrated = true;
          }
        }

        for (const enq of demo.enquiries) {
          const existingEnq = parsed.enquiries.find((x) => x.id === enq.id);
          if (!existingEnq) {
            parsed.enquiries.push(enq);
            parsed.counters.ENQ = Math.max(parsed.counters.ENQ ?? 0, demo.counters.ENQ);
            migrated = true;
          } else if (enq.id === 'ENQ-000009' && existingEnq.keyDate !== enq.keyDate) {
            existingEnq.keyDate = enq.keyDate;
            migrated = true;
          }
        }

        if (!Array.isArray(parsed.quotes) || parsed.quotes.length === 0) {
          parsed.quotes = demo.quotes;
          parsed.counters = { ...parsed.counters, QTE: demo.counters.QTE };
          migrated = true;
        } else {
          for (const q of demo.quotes) {
            if (!parsed.quotes.some((x) => x.id === q.id || x.reference === q.reference)) {
              parsed.quotes.push(q);
              parsed.counters.QTE = Math.max(parsed.counters.QTE ?? 0, demo.counters.QTE);
              migrated = true;
            }
          }
        }

        if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
          parsed.tasks = demo.tasks;
          parsed.counters = { ...parsed.counters, TSK: demo.counters.TSK };
          migrated = true;
        } else {
          for (const t of demo.tasks) {
            if (!parsed.tasks.some((x) => x.id === t.id)) {
              parsed.tasks.push(t);
              parsed.counters.TSK = Math.max(parsed.counters.TSK ?? 0, demo.counters.TSK);
              migrated = true;
            }
          }
        }

        if (!Array.isArray(parsed.notifications)) {
          parsed.notifications = demo.notifications;
          parsed.counters = { ...parsed.counters, NTF: demo.counters.NTF };
          migrated = true;
        }

        if (!Array.isArray(parsed.signOffs) || parsed.signOffs.length === 0) {
          parsed.signOffs = demo.signOffs;
          parsed.counters = { ...parsed.counters, SO: demo.signOffs.length };
          migrated = true;
        }

        const refreshedPmsLinks = buildInitialPmsLinks(
          parsed.organisations,
          parsed.people,
          parsed.matters,
          Array.isArray(parsed.pmsLinks) ? parsed.pmsLinks : [],
        );
        if (!Array.isArray(parsed.pmsLinks) || refreshedPmsLinks.length !== parsed.pmsLinks.length) {
          parsed.pmsLinks = refreshedPmsLinks;
          parsed.counters = { ...parsed.counters, PMSL: parsed.pmsLinks.length };
          migrated = true;
        }
      }

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
        parsed.keyDates = buildSeedKeyDates(parsed.matters, parsed.teams, new Date());
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

      if (migrateFirmBrandingToNotALawFirm(parsed)) {
        migrated = true;
      }

      if (migrated) {
        saveStore(parsed);
      }
      setRuntimeRbacConfigOverride(parsed.rbacConfigOverride);
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
    } catch {
      // recreate if corrupted
    }
  }
  const fresh = createSeedStore(new Date());
  saveStore(fresh);
  return fresh;
}

export function saveStore(store: FirmStore): void {
  global.__oneSquaredStore = store;
  setRuntimeRbacConfigOverride(store.rbacConfigOverride);
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    global.__oneSquaredStoreMtimeMs = fs.statSync(RUNTIME_DATA_FILE).mtimeMs;
  } catch {
    // ignore read-only fs errors in serverless environments
  }
  if (!firestoreSynced) {
    void trySyncToFirestore(store);
  }
}

export function resetStore(): FirmStore {
  const fresh = createSeedStore(new Date());
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


