import 'server-only';

/**
 * SQL-scoped per-route server page loaders and React.cache-deduplicated shell
 * loader (`S1-02b` / `B15`).
 *
 * Replaces the former whole-tenant `getAppSnapshot` request path across all 24
 * authenticated workspace routes (`src/app/(app)/**`) so each route loads only
 * its authorised slice of PostgreSQL data using verified `TenantContext`.
 */

import * as React from 'react';
import {
  DEFAULT_REGISTERS_CONFIG,
  mergeRegistersConfigurations,
  resolveEffectiveRegisterTypes,
  type ClientRateOverrideRecord,
  type ParentChainNodeSummary,
  type RbacConfiguration,
  type RegistersConfiguration,
  type RegisterTransition,
  type RegisterTypeDefinition,
  type RegisterRecord,
  type ResolvedApplicableRatesResult,
  type TenantContext,
  type WorkTypesConfiguration,
} from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import { attentionList, type AttentionItem } from '@/domain/attention';
import { addMonths, toIsoDate } from '@/domain/dates';
import { findRecordsOwnedByLeavers } from '@/domain/employment';
import {
  createDefaultRoleConfigs,
  getLeftRailVisibility,
  resolveActiveViewingRole,
  resolveEmployeeRoles,
  type LeftRailVisibility,
} from '@/domain/homeConfig';
import { sanitizePersonForClientPreview } from '@/domain/intakePreview';
import { systemKeyOf } from '@/domain/lists';
import { normaliseConversionConflictWarnings } from '@/domain/matterConflicts';
import { applyQuoteEffectiveLifecycle } from '@/domain/quotes';
import { userTeams } from '@/domain/tasks';
import { resolveSuggestedConflictReviewer } from './conflictReview';
import { getEntraEnvStatus, getEntraSession } from './entraAuth';
import {
  getFirmFinance,
  getMatterFinanceRows,
  getMyFinanceFigures,
  type FirmFinanceResult,
  type MatterFinanceRowsResult,
  type MyFinanceFiguresResult,
} from './financeServices';
import {
  AuthorisationError,
  canPersonAccessMatter,
  canUserReassignTask,
  canUserReopenEnquiry,
  canUserTakeTask,
  canUserVerifyKeyDate,
  filterEmploymentForUser,
  getActiveActorSession,
  hasPersonPermission,
  resolveConfiguredFirmPrimaryDomain,
  resolveEmployeePermissions,
  resolveKeyDatePermissions,
  resolvePersonPermissions,
  resolveUserAppRole,
  runWithActiveActorSession,
} from './rbacRuntime';
import {
  activeEmployees,
  dedupeById,
  findCandidateDuplicatesForRecord,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getKeyDateRepository,
  getKeyDatesConfig,
  getMatterKeyDatesSnapshot,
  getMatterPmsViewBundle,
  getMatterRepository,
  getMyNotificationPreferences,
  getPartyRepository,
  getPmsAdminSnapshot,
  getPmsRepository,
  getRegisterRepository,
  getTaskWorkflowRepository,
  getClientPmsViewBundle,
  isDemoModeEnabled,
  listAuditEntriesForRecord,
  listClientRateOverridesRecord,
  listFirmAuditEntriesPage,
  listMatterRateOverridesRecord,
  listRegistersWorkspaceDataRecord,
  loadEffectiveTenantRbacConfig,
  loadStaffPeople,
  loadTenantCatalogueStoreView,
  queryKeyDatesTeamDiaryRecord,
  requireAuthenticatedActor,
  resolveApplicableRatesRecord,
  resolveDefaultServiceTenantContext,
  resolveMatterSignOffEstimateGbp,
  getKeyDateExceptionsReportRecord,
  type AuthenticatedActorContext,
  type ClientPmsViewBundle,
  type InheritedParentRateOverrideView,
  type MatterPmsViewBundle,
  type PmsAdminSnapshot,
} from './services';
import {
  getActiveTenantConfiguration,
  getOutboxRepository,
  isNonLiveDemoEnvironment,
} from '@/platform/tenantRuntime';
import type {
  AppFinanceCapabilities,
  AppRole,
  AuditEntry,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  EmployeeMigrationReport,
  EmployeePermission,
  Enquiry,
  EnquirySettings,
  HomePagesConfig,
  HomeRoleKey,
  Matter,
  MatterCostsConfig,
  MatterPartyMigrationReport,
  MatterPartyTaxonomy,
  MergeHistory,
  Note,
  NotificationItem,
  Organisation,
  OrgStructureCatalogue,
  PermissionKey,
  Person,
  PersonOrganisationLink,
  PmsLink,
  Quote,
  SignOffItem,
  Task,
  Team,
} from '@/domain/types';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDateException,
  KeyDateNotApplicable,
  KeyDatePermission,
  KeyDateReminderState,
  KeyDatesConfig,
} from '@/domain/keyDates.types';
import type { TeamDiaryEntry } from '@/domain/keyDateDiary';
import type { PmsMatterFinancials } from '@/pms/types';
import type { AdminTab } from '@/components/AdminClient';

type LoadedStoreView = Awaited<ReturnType<typeof loadTenantCatalogueStoreView>>;

type CacheWrapper = <T extends (...args: never[]) => unknown>(fn: T) => T;

const reactCache: CacheWrapper =
  typeof (React as unknown as { cache?: unknown }).cache === 'function'
    ? ((React as unknown as { cache: CacheWrapper }).cache)
    : (<T extends (...args: never[]) => unknown>(fn: T): T => fn);

const getCachedAuthenticatedActor = reactCache(async () =>
  requireAuthenticatedActor(),
);

/**
 * Deduplicates `requireAuthenticatedActor()` across `(app)/layout.tsx` and the active
 * `(app)` page route within a single Next.js RSC render pass via `React.cache`.
 */
export async function withCachedPageActor<R>(
  fn: (actor: AuthenticatedActorContext) => Promise<R> | R,
): Promise<R> {
  const actor = await getCachedAuthenticatedActor();
  return runWithActiveActorSession(
    {
      tenantId: actor.tenantId,
      personId: actor.personId,
      tokenRoles: actor.session.mappedRoles,
      expiresAtMs: new Date(actor.session.expiresAt).getTime(),
      verifiedSession: actor.session,
    },
    () => fn(actor),
  );
}

/**
 * Auth-guarded wrapper for `(app)/**` pages: returns `null` when no Entra session
 * cookie exists so parallel RSC rendering alongside `(app)/layout.tsx`'s `<LoginScreen />`
 * does not raise an authentication error before login.
 */
export async function withOptionalPageActor<R>(
  fn: (actor: AuthenticatedActorContext) => Promise<R> | R,
): Promise<R | null> {
  if (!getActiveActorSession()) {
    const entraSession = await getEntraSession();
    if (!entraSession) return null;
  }
  return withCachedPageActor(fn);
}

export interface LoaderOptions {
  readonly tenantCtx?: TenantContext | null;
}

export interface ShellContextData {
  readonly ctx: TenantContext;
  readonly store: LoadedStoreView;
  readonly tenantId: string;
  readonly firm: LoadedStoreView['firm'];
  readonly firmPrimaryDomain: string;
  readonly activeTenantCfg: ReturnType<typeof getActiveTenantConfiguration>;
  readonly enableAiMatterExtraction: boolean;
  readonly aiProviderChoice: 'azure_openai_uk' | 'anthropic' | 'disabled';
  readonly enableMatterCostsGovernance: boolean;
  readonly enablePmsLiveRateSync: boolean;
  readonly currentUser: Person;
  readonly currentUserId: string;
  readonly effectiveWorkPerson: Person;
  readonly currentUserRole: AppRole;
  readonly currentUserRoles: HomeRoleKey[];
  readonly activeViewingRole: HomeRoleKey;
  readonly currentUserPermissions: PermissionKey[];
  readonly currentUserEmployeePermissions: EmployeePermission[];
  readonly currentUserKeyDatePermissions: KeyDatePermission[];
  readonly hasRestrictedMatterAccess: boolean;
  readonly canViewQuotes: boolean;
  readonly leftRailVisibility: LeftRailVisibility;
  readonly finance: AppFinanceCapabilities;
  readonly homePagesConfig: HomePagesConfig;
  readonly keyDatesConfig: KeyDatesConfig;
  readonly rbacConfig: RbacConfiguration;
  readonly orgStructure: OrgStructureCatalogue;
  readonly staffPeopleRaw: Person[];
  readonly filteredStaffPeople: Person[];
  readonly employees: Person[];
  readonly teams: Team[];
  readonly values: ChoiceValue[];
  readonly lists: ChoiceList[];
  readonly customFields: CustomFieldDefinition[];
  readonly urgentTaskBadgeCount: number;
  readonly notifications: NotificationItem[];
  readonly attention: AttentionItem[];
}

function collectStatusIdsBySystemKey(
  values: readonly ChoiceValue[],
  keys: readonly string[],
): string[] {
  const keySet = new Set(keys);
  return values
    .filter((v) => keySet.has(systemKeyOf(values as ChoiceValue[], v.id) ?? ''))
    .map((v) => v.id);
}

async function filterPeopleEmploymentForActor(params: {
  ctx: TenantContext;
  peopleToFilter: readonly Person[];
  actorRaw: Person;
  allStaffRaw: readonly Person[];
  teams: readonly Team[];
  effectiveTokenRoles: readonly string[] | undefined;
  rbacConfig: RbacConfiguration;
  hasRestrictedMatterAccess: boolean;
}): Promise<Person[]> {
  const matterRepo = getMatterRepository();
  const openMatterIdsToCheck = Array.from(
    new Set(
      params.peopleToFilter.flatMap(
        (p) => p.employment?.conflictCheckOnHire?.openMatterIds ?? [],
      ),
    ),
  );
  const visibleCheckMatters =
    openMatterIdsToCheck.length > 0
      ? await matterRepo.listMattersByIds<Matter>(
          params.ctx,
          openMatterIdsToCheck,
          {
            viewerId: params.actorRaw.id,
            hasRestrictedMatterAccess: params.hasRestrictedMatterAccess,
          },
        )
      : [];
  const visibleMatterById = new Map(visibleCheckMatters.map((m) => [m.id, m]));
  const employeeMatterVisibility = {
    canViewMatterId: (matterId: string) => visibleMatterById.has(matterId),
    visibleMatterNumberById: new Map(
      visibleCheckMatters.map((m) => [m.id, m.matterNumber] as const),
    ),
  };

  return params.peopleToFilter.map((p) => {
    if (!p.employment) return p;
    return {
      ...p,
      employment: filterEmploymentForUser(
        p.employment,
        params.actorRaw,
        [...params.allStaffRaw],
        [...params.teams],
        undefined,
        {
          tokenRoles: params.effectiveTokenRoles,
          tokenRolesActorId: params.actorRaw.id,
          config: { rbac: params.rbacConfig },
        },
        employeeMatterVisibility,
      ),
    };
  });
}

async function collectReferencedParties(params: {
  ctx: TenantContext;
  shell: ShellContextData;
  matters?: readonly Matter[];
  enquiries?: readonly Enquiry[];
  quotes?: readonly Quote[];
  tasks?: readonly Task[];
  links?: readonly PersonOrganisationLink[];
  keyDates?: readonly KeyDate[];
  extraPersonIds?: readonly (string | null | undefined)[];
  extraOrgIds?: readonly (string | null | undefined)[];
}): Promise<{ people: Person[]; organisations: Organisation[] }> {
  const personIds = new Set<string>();
  const orgIds = new Set<string>();

  const addMaybeId = (id: string | null | undefined) => {
    const clean = id?.trim();
    if (!clean) return;
    if (clean.startsWith('P-')) personIds.add(clean);
    else if (clean.startsWith('O-')) orgIds.add(clean);
  };

  for (const m of params.matters ?? []) {
    addMaybeId(m.clientId);
    for (const acId of m.additionalClientIds ?? []) addMaybeId(acId);
    for (const pt of m.parties ?? []) {
      addMaybeId(pt.linkedRecordId);
    }
    addMaybeId(m.instructingContactId);
    addMaybeId(m.billingContactId);
    addMaybeId(m.referrerContactId);
    addMaybeId(m.responsiblePartnerId);
    addMaybeId(m.leadFeeEarnerId);
    addMaybeId(m.supervisingPartnerId);
    for (const tmId of m.teamMemberIds ?? []) addMaybeId(tmId);
  }

  for (const e of params.enquiries ?? []) {
    addMaybeId(e.linkedPersonId);
    addMaybeId(e.linkedOrganisationId);
    addMaybeId(e.referrerPersonId);
    addMaybeId(e.referredToOrganisationId);
    addMaybeId(e.assignedToId);
    addMaybeId(e.takenById);
  }

  for (const q of params.quotes ?? []) {
    addMaybeId(q.linkedPersonId);
    addMaybeId(q.linkedOrganisationId);
    addMaybeId(q.createdById);
    addMaybeId(q.updatedById);
  }

  for (const t of params.tasks ?? []) {
    addMaybeId(t.assignedPersonId);
    for (const aid of t.assignedPersonIds ?? []) addMaybeId(aid);
    addMaybeId(t.createdById);
    addMaybeId(t.completedById);
    for (const lr of t.linkedRecords ?? []) {
      if (lr.recordType === 'person') addMaybeId(lr.recordId);
      else if (lr.recordType === 'organisation') addMaybeId(lr.recordId);
    }
  }

  for (const l of params.links ?? []) {
    addMaybeId(l.personId);
    addMaybeId(l.organisationId);
  }

  for (const kd of params.keyDates ?? []) {
    for (const pid of kd.responsiblePersonIds ?? []) addMaybeId(pid);
    addMaybeId(kd.verification?.verifiedById);
    addMaybeId(kd.createdById);
  }

  for (const id of params.extraPersonIds ?? []) addMaybeId(id);
  for (const id of params.extraOrgIds ?? []) addMaybeId(id);

  const existingStaffById = new Set(params.shell.filteredStaffPeople.map((p) => p.id));
  const missingPersonIds = Array.from(personIds).filter((id) => !existingStaffById.has(id));
  const targetOrgIds = Array.from(orgIds);

  const partyRepo = getPartyRepository();
  const [loadedPeople, loadedOrgs] = await Promise.all([
    missingPersonIds.length > 0
      ? partyRepo.listPeopleByIds<Person>(params.ctx, missingPersonIds)
      : Promise.resolve<Person[]>([]),
    targetOrgIds.length > 0
      ? partyRepo.listOrganisationsByIds<Organisation>(params.ctx, targetOrgIds)
      : Promise.resolve<Organisation[]>([]),
  ]);

  const sanitizedNonStaff = loadedPeople.map((p) =>
    p.isEmployee
      ? p
      : sanitizePersonForClientPreview(p, { preserveNonEmployeeDob: true }),
  );
  // Any employee loaded here was not in filteredStaffPeople (rare edge case); filter safely
  const safeExtraEmployees = loadedPeople.some((p) => p.isEmployee)
    ? await filterPeopleEmploymentForActor({
        ctx: params.ctx,
        peopleToFilter: loadedPeople.filter((p) => p.isEmployee),
        actorRaw:
          params.shell.staffPeopleRaw.find((p) => p.id === params.shell.currentUserId) ??
          params.shell.currentUser,
        allStaffRaw: params.shell.staffPeopleRaw,
        teams: params.shell.teams,
        effectiveTokenRoles: undefined,
        rbacConfig: params.shell.rbacConfig,
        hasRestrictedMatterAccess: params.shell.hasRestrictedMatterAccess,
      })
    : [];

  return {
    people: dedupeById([
      ...params.shell.filteredStaffPeople,
      ...safeExtraEmployees,
      ...sanitizedNonStaff.filter((p) => !p.isEmployee),
    ]),
    organisations: loadedOrgs,
  };
}

async function resolveRegistersSummary(
  ctx: TenantContext,
  activeTenantCfg: ReturnType<typeof getActiveTenantConfiguration>,
): Promise<{
  registersConfig: RegistersConfiguration;
  registerTypes: RegisterTypeDefinition[];
}> {
  const dbRegOverride = await getCatalogueRepository().getModuleConfig<RegistersConfiguration>(
    ctx,
    'registers',
  );
  return {
    registersConfig: mergeRegistersConfigurations(
      activeTenantCfg.registers ?? DEFAULT_REGISTERS_CONFIG,
      dbRegOverride,
    ),
    registerTypes: resolveEffectiveRegisterTypes(
      activeTenantCfg.registers ?? DEFAULT_REGISTERS_CONFIG,
      dbRegOverride,
    ),
  };
}

async function loadShellContextUncached(
  actorId: string,
  options?: LoaderOptions,
): Promise<ShellContextData> {
  const now = new Date();
  const todayIso = toIsoDate(now);
  const cleanActorId = actorId?.trim() ?? '';
  if (!cleanActorId) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required.',
      tenantId: getActiveTenantConfiguration().tenantId,
      correlationId: 'shell-loader',
      actorUserId: 'anonymous',
    });
  }

  const ctx = resolveDefaultServiceTenantContext(null, cleanActorId, {
    tenantCtx: options?.tenantCtx,
  });
  const hrRepo = getHrAndRbacRepository();
  const partyRepo = getPartyRepository();
  const taskRepo = getTaskWorkflowRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const matterRepo = getMatterRepository();

  const [store, staffPeopleRaw, teams, dbRbacOverride, keyDatesConfig, userNotifPrefs] =
    await Promise.all([
      loadTenantCatalogueStoreView(ctx, { includePmsLinks: false }),
      loadStaffPeople(ctx),
      hrRepo.listAllTeams<Team>(ctx),
      hrRepo.getRbacConfigOverride<RbacConfiguration>(ctx),
      getKeyDatesConfig({ ctx, userId: cleanActorId }),
      getOutboxRepository().listNotificationPreferencesForUser(ctx, cleanActorId),
    ]);

  const rbacConfig = await loadEffectiveTenantRbacConfig(ctx, dbRbacOverride);
  const rawUser = staffPeopleRaw.find(
    (p) => p.id === cleanActorId && !p.mergedIntoId,
  );
  if (!rawUser) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: `Authenticated user "${cleanActorId}" was not found or is inactive.`,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      actorUserId: cleanActorId,
    });
  }

  const activeSession = getActiveActorSession();
  const effectiveTokenRoles =
    activeSession && activeSession.personId === rawUser.id
      ? activeSession.tokenRoles
      : undefined;
  const currentUserRole = resolveUserAppRole(rawUser, teams, store.values, {
    config: { rbac: rbacConfig },
  });
  const currentUserRoles = resolveEmployeeRoles(rawUser, teams);
  const currentUserPermissions = resolvePersonPermissions(rawUser, {
    allPeople: staffPeopleRaw,
    teams,
    tokenRoles: effectiveTokenRoles,
    tokenRolesActorId: rawUser.id,
    config: { rbac: rbacConfig },
  });
  const currentUserEmployeePermissions = resolveEmployeePermissions(
    rawUser,
    staffPeopleRaw,
    teams,
    { config: { rbac: rbacConfig } },
  );
  const currentUserKeyDatePermissions = resolveKeyDatePermissions(rawUser, {
    config: keyDatesConfig,
    allPeople: staffPeopleRaw,
    teams,
    rbac: { config: { rbac: rbacConfig } },
  });

  const activeTenantCfg = getActiveTenantConfiguration();
  const orgStructure =
    store.orgStructure ??
    ({
      legalEntities: [],
      divisions: [],
      departments: [],
      teamsOrPracticeGroups: [],
      offices: [],
      costCentres: [],
      profitCentres: [],
    } satisfies OrgStructureCatalogue);

  const homePagesConfig: HomePagesConfig = {
    ...store.homePagesConfig,
    firmSettings: {
      ...store.homePagesConfig.firmSettings,
      demoMode: isDemoModeEnabled(),
    },
  };
  const activeViewingRole = resolveActiveViewingRole(rawUser, homePagesConfig, teams);
  const baseRail = getLeftRailVisibility(activeViewingRole, currentUserRoles, {
    config: { rbac: rbacConfig },
  });
  const leftRailVisibility: LeftRailVisibility = {
    ...baseRail,
    keyDates:
      Boolean(keyDatesConfig.enabled) &&
      baseRail.keyDates &&
      currentUserKeyDatePermissions.includes('keydate:view'),
  };

  const hasRestrictedMatterAccess = currentUserPermissions.includes(
    'matter:restricted:access',
  );
  const canViewQuotes = currentUserPermissions.includes('quote:view');
  const finance: AppFinanceCapabilities = {
    canViewFirm: currentUserPermissions.includes('finance:view'),
    canViewMatter: currentUserPermissions.includes('finance:view_matter'),
    canCreditControl: currentUserPermissions.includes('finance:credit_control'),
  };

  const filteredStaffPeople = await filterPeopleEmploymentForActor({
    ctx,
    peopleToFilter: staffPeopleRaw,
    actorRaw: rawUser,
    allStaffRaw: staffPeopleRaw,
    teams,
    effectiveTokenRoles,
    rbacConfig,
    hasRestrictedMatterAccess,
  });
  const filteredCurrentUser =
    filteredStaffPeople.find((p) => p.id === rawUser.id) ?? rawUser;
  const effectiveWorkPerson: Person =
    isNonLiveDemoEnvironment() && rawUser.demo && rawUser.showsWorkOfId
      ? (filteredStaffPeople.find((p) => p.id === rawUser.showsWorkOfId) ??
        filteredCurrentUser)
      : filteredCurrentUser;
  const employees = activeEmployees(filteredStaffPeople, store.values);

  const inactiveRecordStatusIds = collectStatusIdsBySystemKey(store.values, [
    'archived',
    'deceased',
    'merged',
    'dissolved',
  ]);
  const possibleDuplicateStatusIds = collectStatusIdsBySystemKey(store.values, [
    'possible_match',
  ]);
  const expiredVerificationStatusIds = collectStatusIdsBySystemKey(
    store.values,
    ['expired'],
  );
  const potentialConflictStatusIds = collectStatusIdsBySystemKey(store.values, [
    'potential_conflict',
  ]);
  const staleBeforeIso = toIsoDate(addMonths(now, -12));
  const workTeamIds = userTeams(effectiveWorkPerson.id, teams).map((t) => t.id);

  const [
    urgentTaskBadgeCount,
    primaryNotifications,
    effectiveNotifications,
    attentionPeople,
    attentionOrgs,
    attentionOverdueTasks,
    attentionOpenEnquiries,
    ownAttentionMatters,
    attentionPmsLinks,
  ] = await Promise.all([
    taskRepo.countUrgentBadgeTasksForUser(ctx, effectiveWorkPerson.id, {
      viewerId: rawUser.id,
      hasRestrictedMatterAccess,
      todayIso,
    }),
    taskRepo.listNotificationsForUser<NotificationItem>(ctx, rawUser.id, {
      viewerId: rawUser.id,
      hasRestrictedMatterAccess,
      limit: 30,
    }),
    effectiveWorkPerson.id !== rawUser.id
      ? taskRepo.listNotificationsForUser<NotificationItem>(
          ctx,
          effectiveWorkPerson.id,
          {
            viewerId: rawUser.id,
            hasRestrictedMatterAccess,
            limit: 30,
          },
        )
      : Promise.resolve<NotificationItem[]>([]),
    partyRepo.listPeopleRequiringAttention<Person>(ctx, {
      inactiveRecordStatusIds,
      possibleDuplicateStatusIds,
      expiredVerificationStatusIds,
      staleBeforeIso,
      limit: 100,
    }),
    partyRepo.listOrganisationsRequiringAttention<Organisation>(ctx, {
      inactiveRecordStatusIds,
      possibleDuplicateStatusIds,
      expiredVerificationStatusIds,
      potentialConflictStatusIds,
      reviewBeforeIso: todayIso,
      staleBeforeIso,
      limit: 100,
    }),
    taskRepo.listVisibleTasks<Task>(ctx, rawUser.id, {
      openOnly: true,
      overdueBeforeIso: todayIso,
      assignedPersonIdOrMulti: effectiveWorkPerson.id,
      hasRestrictedMatterAccess,
      limit: 50,
    }),
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, rawUser.id, {
      openOnly: true,
      assignedToOrTeams: {
        assignedToId: effectiveWorkPerson.id,
        assignedTeamIds: workTeamIds,
      },
      hasRestrictedMatterAccess,
      limit: 50,
    }),
    finance.canViewMatter
      ? matterRepo.listVisibleMattersForEntity<Matter>(
          ctx,
          { ownerPersonId: effectiveWorkPerson.id, includeMerged: false },
          { viewerId: rawUser.id, hasRestrictedMatterAccess },
        )
      : Promise.resolve<Matter[]>([]),
    finance.canViewMatter
      ? getPmsRepository().listPmsLinks<PmsLink>(ctx)
      : Promise.resolve<PmsLink[]>([]),
  ]);

  let pmsSummaryByMatterIdForAttention: Record<string, PmsMatterFinancials> = {};
  if (finance.canViewMatter && ownAttentionMatters.length > 0 && attentionPmsLinks.length > 0) {
    const ownMatterIds = new Set(ownAttentionMatters.map((m) => m.id));
    const relevantLinks = attentionPmsLinks.filter(
      (l) => l.entityType === 'matter' && ownMatterIds.has(l.onesquaredId),
    );
    const pmsCodes = Array.from(new Set(relevantLinks.map((l) => l.pmsCode)));
    if (pmsCodes.length > 0) {
      const finRows = await getPmsRepository().getMatterFinanceSummaryRows(ctx, pmsCodes);
      const finByCode = new Map(finRows.map((f) => [f.matter_code, f]));
      pmsSummaryByMatterIdForAttention = {};
      for (const link of relevantLinks) {
        const fin = finByCode.get(link.pmsCode);
        if (fin) {
          pmsSummaryByMatterIdForAttention[link.onesquaredId] = fin as unknown as PmsMatterFinancials;
        }
      }
    }
  }

  const inAppDisabledKinds = new Set(
    userNotifPrefs
      .filter((p) => !p.inAppEnabled)
      .map((p) => p.notificationKind),
  );
  const mergedNotifMap = new Map<string, NotificationItem>();
  for (const n of [...primaryNotifications, ...effectiveNotifications]) {
    mergedNotifMap.set(n.id, n);
  }
  const notifications = Array.from(mergedNotifMap.values())
    .filter(
      (n) =>
        !inAppDisabledKinds.has(n.kind) &&
        (canViewQuotes || !n.recordId.startsWith('QUO-')),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30);

  const sanitizedAttentionPeople = attentionPeople.map((p) =>
    sanitizePersonForClientPreview(p),
  );
  const attention = attentionList(
    [...sanitizedAttentionPeople, ...attentionOrgs],
    store.values,
    now,
    {
      userId: effectiveWorkPerson.id,
      tasks: attentionOverdueTasks,
      enquiries: attentionOpenEnquiries,
      teams,
      matters: ownAttentionMatters,
      pmsSummaryByMatterId: pmsSummaryByMatterIdForAttention,
      canViewFinance: finance.canViewMatter,
    },
  );

  return {
    ctx,
    store,
    tenantId: ctx.tenantId,
    firm: store.firm,
    firmPrimaryDomain: resolveConfiguredFirmPrimaryDomain(),
    activeTenantCfg,
    enableAiMatterExtraction: Boolean(
      activeTenantCfg.featureFlags?.enableAiMatterExtraction,
    ),
    aiProviderChoice:
      activeTenantCfg.integrations?.aiProviderChoice === 'azure_openai_uk' ||
      activeTenantCfg.integrations?.aiProviderChoice === 'anthropic'
        ? activeTenantCfg.integrations.aiProviderChoice
        : 'disabled',
    enableMatterCostsGovernance: Boolean(
      activeTenantCfg.featureFlags?.enableMatterCostsGovernance,
    ),
    enablePmsLiveRateSync: Boolean(activeTenantCfg.featureFlags?.enablePmsLiveRateSync),
    currentUser: filteredCurrentUser,
    currentUserId: rawUser.id,
    effectiveWorkPerson,
    currentUserRole,
    currentUserRoles,
    activeViewingRole,
    currentUserPermissions,
    currentUserEmployeePermissions,
    currentUserKeyDatePermissions,
    hasRestrictedMatterAccess,
    canViewQuotes,
    leftRailVisibility,
    finance,
    homePagesConfig,
    keyDatesConfig,
    rbacConfig,
    orgStructure,
    staffPeopleRaw,
    filteredStaffPeople,
    employees,
    teams,
    values: store.values,
    lists: store.lists,
    customFields: store.customFields,
    urgentTaskBadgeCount,
    notifications,
    attention,
  };
}

const loadShellContextCached = reactCache((actorId: string) =>
  loadShellContextUncached(actorId),
);

/**
 * Loads the light navigation shell (employees only, notifications, urgent badge count,
 * SQL-scoped attention alerts), deduplicated within a single request via `React.cache`.
 */
export async function loadShellContext(
  actorId: string,
  options?: LoaderOptions,
): Promise<ShellContextData> {
  return options?.tenantCtx
    ? loadShellContextUncached(actorId, options)
    : loadShellContextCached(actorId);
}

// ============================================================================
// Route 1: Home (`/`)
// ============================================================================

export async function loadHomePageData(
  actorId: string,
  searchParams?: { readonly view?: string; readonly previewRole?: string },
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  activeRoleKey: string;
  signOffs: SignOffItem[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  tasks: Task[];
  registerTypes: RegisterTypeDefinition[];
  registerRecords: RegisterRecord[];
  matterFinance?: MatterFinanceRowsResult;
  myFinance?: MyFinanceFiguresResult;
  firmFinance?: FirmFinanceResult;
}> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess, activeTenantCfg, currentUserPermissions } =
    shell;
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();

  const requestedRole = searchParams?.previewRole || searchParams?.view;
  const activeRoleKey =
    requestedRole && shell.homePagesConfig.roles.some((r) => r.key === requestedRole)
      ? requestedRole
      : shell.activeViewingRole;

  const canReadRegisters =
    currentUserPermissions.includes('register:view') ||
    currentUserPermissions.includes('undertaking:manage');
  const needsRegistersOnHome =
    canReadRegisters &&
    !['enquiries_coordinator', 'intake', 'legal_secretary'].includes(activeRoleKey);

  const summaryOnlyHomeFinance = !['finance', 'partner', 'managing_partner', 'supervisor', 'fee_earner'].includes(
    activeRoleKey,
  );

  const [
    matters,
    enquiries,
    tasks,
    signOffs,
    registersBundle,
    matterFinanceRes,
    myFinanceRes,
    firmFinanceRes,
  ] = await Promise.all([
    matterRepo.listVisibleMatters<Matter>(ctx, {
      viewerId: currentUserId,
      hasRestrictedMatterAccess,
    }),
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
      hasRestrictedMatterAccess,
    }),
    taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
      hasRestrictedMatterAccess,
    }),
    taskRepo.listVisibleSignOffs<SignOffItem>(ctx, currentUserId, {
      hasRestrictedMatterAccess,
    }),
    needsRegistersOnHome
      ? Promise.all([
          resolveRegistersSummary(ctx, activeTenantCfg),
          getRegisterRepository().listVisibleRegisterRecords(ctx, currentUserId, {
            hasRestrictedMatterAccess,
            limit: 200,
          }),
        ]).then(([meta, registerRecords]) => ({ ...meta, registerRecords }))
      : Promise.resolve({
          registersConfig: activeTenantCfg.registers ?? DEFAULT_REGISTERS_CONFIG,
          registerTypes: [] as RegisterTypeDefinition[],
          registerRecords: [] as RegisterRecord[],
        }),
    shell.finance.canViewMatter
      ? getMatterFinanceRows(ctx, undefined, { summaryOnly: summaryOnlyHomeFinance })
      : Promise.resolve(null),
    shell.finance.canViewMatter ? getMyFinanceFigures(ctx) : Promise.resolve(null),
    shell.finance.canViewFirm ? getFirmFinance(ctx) : Promise.resolve(null),
  ]);

  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    tasks,
    extraPersonIds: [
      ...signOffs.flatMap((s) => [s.requestedById, s.assignedPartnerId, s.approvedById]),
      ...registersBundle.registerRecords.flatMap((r) => [
        r.assignedApproverId,
        r.createdById,
      ]),
    ],
  });

  return {
    shell,
    activeRoleKey,
    signOffs,
    people,
    organisations,
    matters,
    enquiries,
    tasks,
    registerTypes: registersBundle.registerTypes,
    registerRecords: registersBundle.registerRecords,
    matterFinance:
      matterFinanceRes && !isActionDenied(matterFinanceRes)
        ? matterFinanceRes
        : undefined,
    myFinance:
      myFinanceRes && !isActionDenied(myFinanceRes) ? myFinanceRes : undefined,
    firmFinance:
      firmFinanceRes && !isActionDenied(firmFinanceRes)
        ? firmFinanceRes
        : undefined,
  };
}

// ============================================================================
// Route 2-5: People (`/people`, `/people/[id]`, `/people/new`, `/people/[id]/edit`)
// ============================================================================

export async function loadPeopleListPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  enquiries: Enquiry[];
}> {
  const shell = await loadShellContext(actorId, options);
  const partyRepo = getPartyRepository();
  const intakeRepo = getIntakeQuoteRepository();

  const [rawPeople, enquiries] = await Promise.all([
    partyRepo.listPeoplePage<Person>(shell.ctx, { includeMerged: false, limit: 500 }),
    intakeRepo.listVisibleEnquiries<Enquiry>(shell.ctx, shell.currentUserId, {
      hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
      limit: 500,
    }),
  ]);

  const filteredStaffById = new Map(shell.filteredStaffPeople.map((p) => [p.id, p]));
  const people = rawPeople.map((p) =>
    p.isEmployee
      ? (filteredStaffById.get(p.id) ?? sanitizePersonForClientPreview(p))
      : sanitizePersonForClientPreview(p, { preserveNonEmployeeDob: true }),
  );
  const links =
    people.length > 0
      ? await partyRepo.listLinksForEntities<PersonOrganisationLink>(shell.ctx, {
          personIds: people.map((p) => p.id),
        })
      : [];
  const orgIds = Array.from(
    new Set([
      ...links.map((l) => l.organisationId).filter(Boolean),
      ...enquiries
        .map((e) => e.linkedOrganisationId)
        .filter((x): x is string => Boolean(x)),
    ]),
  );
  const organisations =
    orgIds.length > 0
      ? await partyRepo.listOrganisationsByIds<Organisation>(shell.ctx, orgIds)
      : [];

  return { shell, people, organisations, links, enquiries };
}

export async function loadPersonDetailPageData(
  actorId: string,
  id: string,
  options?: LoaderOptions,
): Promise<
  | { redirectTo: string }
  | {
      shell: ShellContextData;
      person: Person;
      allPeople: Person[];
      organisations: Organisation[];
      links: PersonOrganisationLink[];
      matters: Matter[];
      tasks: Task[];
      enquiries: Enquiry[];
      notes: Note[];
      audit: AuditEntry[];
      merges: MergeHistory[];
      duplicateCandidates: Person[];
      pmsView?: ClientPmsViewBundle;
      canViewNegotiatedRates: boolean;
      canManageNegotiatedRates: boolean;
      clientRateOverrides: ClientRateOverrideRecord[];
      rateCustomGrades: Array<{ id: string; label: string }>;
      canViewPayroll: boolean;
      canViewOwnNotificationPreferences: boolean;
      canManageOwnNotificationPreferences: boolean;
      initialNotificationPreferences?: Awaited<
        ReturnType<typeof getMyNotificationPreferences>
      >;
      canTakeByTaskId: Record<string, boolean>;
    }
  | null
> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();

  if (id.startsWith('ENQ-')) {
    const enquiry = await intakeRepo.getEnquiryById<Enquiry>(ctx, id, {
      viewerId: currentUserId,
      hasRestrictedMatterAccess,
    });
    if (!enquiry) return null;
    if (enquiry.linkedPersonId) {
      return { redirectTo: `/people/${enquiry.linkedPersonId}` };
    }
    return { redirectTo: `/enquiries/${enquiry.id}` };
  }

  const rawPerson = await partyRepo.getPersonById<Person>(ctx, id);
  if (!rawPerson) return null;
  if (rawPerson.mergedIntoId) {
    return { redirectTo: `/people/${rawPerson.mergedIntoId}` };
  }

  const filteredPersonList = rawPerson.isEmployee
    ? await filterPeopleEmploymentForActor({
        ctx,
        peopleToFilter: [rawPerson],
        actorRaw:
          shell.staffPeopleRaw.find((p) => p.id === currentUserId) ??
          shell.currentUser,
        allStaffRaw: shell.staffPeopleRaw,
        teams: shell.teams,
        effectiveTokenRoles:
          getActiveActorSession()?.personId === currentUserId
            ? getActiveActorSession()?.tokenRoles
            : undefined,
        rbacConfig: shell.rbacConfig,
        hasRestrictedMatterAccess,
      })
    : [sanitizePersonForClientPreview(rawPerson, { preserveNonEmployeeDob: true })];
  const person = filteredPersonList[0]!;

  const canViewNegotiatedRates = shell.currentUserPermissions.some((p) =>
    [
      'finance:view',
      'finance:view_matter',
      'finance:credit_control',
      'admin:access',
    ].includes(p),
  );
  const canManageNegotiatedRates = shell.currentUserPermissions.some((p) =>
    ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'].includes(p),
  );

  const [
    links,
    notes,
    merges,
    matters,
    tasks,
    enquiries,
    autoMatchesRaw,
    explicitMatchesRaw,
    audit,
    rateBundle,
  ] = await Promise.all([
    partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, { personIds: [person.id] }),
    partyRepo.listNotesForRecord<Note>(ctx, 'person', person.id),
    partyRepo.listMergeHistoryForEntity<MergeHistory>(ctx, 'person', person.id),
    matterRepo.listVisibleMattersForEntity<Matter>(
      ctx,
      {
        clientIds: [person.id],
        partyEntityIds: [person.id],
        contactIds: [person.id],
        ownerPersonId: person.isEmployee ? person.id : undefined,
      },
      { viewerId: currentUserId, hasRestrictedMatterAccess },
    ),
    taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
      linkedRecordType: 'person',
      linkedRecordId: person.id,
      hasRestrictedMatterAccess,
    }),
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
      relatedPersonId: person.id,
      hasRestrictedMatterAccess,
    }),
    findCandidateDuplicatesForRecord(person, { ctx }) as Promise<Person[]>,
    person.possibleMatchIds.length > 0
      ? partyRepo.listPeopleByIds<Person>(ctx, person.possibleMatchIds)
      : Promise.resolve<Person[]>([]),
    listAuditEntriesForRecord('person', person.id, currentUserId, { limit: 200 }),
    canViewNegotiatedRates
      ? listClientRateOverridesRecord({ clientType: 'person', clientId: person.id }, currentUserId)
      : Promise.resolve(null),
  ]);

  let pmsView: ClientPmsViewBundle | undefined;
  if (shell.finance.canViewMatter) {
    const personPmsRes = await getClientPmsViewBundle('person', person.id, ctx);
    const personPmsView = !isActionDenied(personPmsRes) ? personPmsRes : undefined;
    const primaryOrgLink =
      links.find((l) => l.personId === person.id && l.isCurrent && l.isPrimaryContact) ??
      links.find((l) => l.personId === person.id && l.isCurrent);
    if (personPmsView?.clientBundle || !primaryOrgLink) {
      pmsView = personPmsView;
    } else {
      const orgPmsRes = await getClientPmsViewBundle(
        'organisation',
        primaryOrgLink.organisationId,
        ctx,
      );
      pmsView = !isActionDenied(orgPmsRes) ? orgPmsRes : personPmsView;
    }
  }

  const duplicateCandidates = dedupeById([
    ...explicitMatchesRaw.filter((p) => !p.mergedIntoId),
    ...autoMatchesRaw,
  ]).map((p) => sanitizePersonForClientPreview(p));

  const extraOrgIds =
    pmsView?.link?.entityType === 'organisation' && pmsView.link.onesquaredId
      ? [pmsView.link.onesquaredId]
      : [];
  const { people: referencedPeople, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    tasks,
    links,
    extraPersonIds: [person.id, ...duplicateCandidates.map((p) => p.id)],
    extraOrgIds,
  });
  const allPeople = dedupeById([person, ...referencedPeople]);

  const canTakeByTaskId: Record<string, boolean> = {};
  for (const t of tasks) {
    canTakeByTaskId[t.id] = canUserTakeTask(
      currentUserId,
      t,
      shell.teams,
      allPeople,
      shell.values,
      shell.currentUserPermissions,
    );
  }

  const rateCustomGrades = Array.from(
    new Map(
      (shell.store.matterCostsConfig.rateCards ?? [])
        .flatMap((rc) => rc.customGrades ?? [])
        .map((cg) => [cg.id, { id: cg.id, label: cg.label }]),
    ).values(),
  );

  const isOwnEmployeeProfile =
    person.id === currentUserId && Boolean(person.isEmployee);
  const canViewOwnNotificationPreferences =
    isOwnEmployeeProfile &&
    shell.currentUserPermissions.includes('notification:view_own');
  const canManageOwnNotificationPreferences =
    isOwnEmployeeProfile &&
    shell.currentUserPermissions.includes('notification:manage_own_preferences');
  const canViewPayroll = shell.currentUserPermissions.includes('employee:payroll');
  const initialNotificationPreferences = canViewOwnNotificationPreferences
    ? await getMyNotificationPreferences(person.id, {
        actorPersonId: currentUserId,
      }).catch(() => undefined)
    : undefined;

  return {
    shell,
    person,
    allPeople,
    organisations,
    links,
    matters,
    tasks,
    enquiries,
    notes,
    audit,
    merges,
    duplicateCandidates,
    pmsView,
    canViewNegotiatedRates,
    canManageNegotiatedRates,
    clientRateOverrides:
      rateBundle && !isActionDenied(rateBundle) ? rateBundle.overrides : [],
    rateCustomGrades,
    canViewPayroll,
    canViewOwnNotificationPreferences,
    canManageOwnNotificationPreferences,
    initialNotificationPreferences,
    canTakeByTaskId,
  };
}

export async function loadPersonFormPageData(
  actorId: string,
  id?: string,
  options?: LoaderOptions,
): Promise<
  | { redirectTo: string }
  | {
      shell: ShellContextData;
      existing: Person | null;
      organisations: Organisation[];
      matters: Matter[];
      enquiries: Enquiry[];
      leaverOwnedRecords: ReturnType<typeof findRecordsOwnedByLeavers>;
    }
  | null
> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();

  if (!id) {
    return {
      shell,
      existing: null,
      organisations: [],
      matters: [],
      enquiries: [],
      leaverOwnedRecords: [],
    };
  }

  const rawPerson = await partyRepo.getPersonById<Person>(ctx, id);
  if (!rawPerson) return null;
  if (rawPerson.mergedIntoId) {
    return { redirectTo: `/people/${rawPerson.mergedIntoId}/edit` };
  }

  const filteredPersonList = rawPerson.isEmployee
    ? await filterPeopleEmploymentForActor({
        ctx,
        peopleToFilter: [rawPerson],
        actorRaw:
          shell.staffPeopleRaw.find((p) => p.id === currentUserId) ??
          shell.currentUser,
        allStaffRaw: shell.staffPeopleRaw,
        teams: shell.teams,
        effectiveTokenRoles:
          getActiveActorSession()?.personId === currentUserId
            ? getActiveActorSession()?.tokenRoles
            : undefined,
        rbacConfig: shell.rbacConfig,
        hasRestrictedMatterAccess,
      })
    : [sanitizePersonForClientPreview(rawPerson, { preserveNonEmployeeDob: true })];
  const existing = filteredPersonList[0]!;

  const [links, ownedPeople, ownedOrgs, ownedMatters, ownedTasks, ownedEnquiries] =
    await Promise.all([
      partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, { personIds: [existing.id] }),
      existing.isEmployee
        ? partyRepo.listPeopleOwnedByPerson<Person>(ctx, existing.id)
        : Promise.resolve<Person[]>([]),
      existing.isEmployee
        ? partyRepo.listOrganisationsOwnedByPerson<Organisation>(ctx, existing.id)
        : Promise.resolve<Organisation[]>([]),
      existing.isEmployee
        ? matterRepo.listVisibleMattersForEntity<Matter>(
            ctx,
            { ownerPersonId: existing.id },
            { viewerId: currentUserId, hasRestrictedMatterAccess },
          )
        : Promise.resolve<Matter[]>([]),
      existing.isEmployee
        ? taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
            assignedPersonIdOrMulti: existing.id,
            hasRestrictedMatterAccess,
          })
        : Promise.resolve<Task[]>([]),
      existing.isEmployee
        ? intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
            assignedToId: existing.id,
            hasRestrictedMatterAccess,
          })
        : Promise.resolve<Enquiry[]>([]),
    ]);

  const linkedOrgIds = links.map((l) => l.organisationId).filter(Boolean);
  const linkedOrgs =
    linkedOrgIds.length > 0
      ? await partyRepo.listOrganisationsByIds<Organisation>(ctx, linkedOrgIds)
      : [];
  const organisations = dedupeById([...linkedOrgs, ...ownedOrgs]);
  const leaverOwnedRecords = existing.isEmployee
    ? findRecordsOwnedByLeavers(
        [existing, ...ownedPeople],
        ownedOrgs,
        ownedMatters,
        ownedTasks,
        ownedEnquiries,
        existing.id,
      )
    : [];

  return {
    shell,
    existing,
    organisations,
    matters: ownedMatters,
    enquiries: ownedEnquiries,
    leaverOwnedRecords,
  };
}

// ============================================================================
// Route 6-9: Organisations
// ============================================================================

export async function loadOrganisationsListPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  organisations: Organisation[];
  people: Person[];
  links: PersonOrganisationLink[];
  matters: Matter[];
}> {
  const shell = await loadShellContext(actorId, options);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();

  const [organisations, matters] = await Promise.all([
    partyRepo.listOrganisationsPage<Organisation>(shell.ctx, {
      includeMerged: false,
      limit: 500,
    }),
    matterRepo.listVisibleMatters<Matter>(shell.ctx, {
      viewerId: shell.currentUserId,
      hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
      limit: 500,
    }),
  ]);
  const links =
    organisations.length > 0
      ? await partyRepo.listLinksForEntities<PersonOrganisationLink>(shell.ctx, {
          organisationIds: organisations.map((o) => o.id),
        })
      : [];
  const { people } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters,
    links,
    extraPersonIds: organisations.flatMap((o) => [
      o.relationshipPartnerId,
      o.recordOwnerId,
    ]),
  });

  return { shell, organisations, people, links, matters };
}

export async function loadOrganisationDetailPageData(
  actorId: string,
  id: string,
  options?: LoaderOptions,
): Promise<
  | { redirectTo: string }
  | {
      shell: ShellContextData;
      organisation: Organisation;
      allOrganisations: Organisation[];
      people: Person[];
      links: PersonOrganisationLink[];
      matters: Matter[];
      tasks: Task[];
      enquiries: Enquiry[];
      notes: Note[];
      audit: AuditEntry[];
      merges: MergeHistory[];
      duplicateCandidates: Organisation[];
      pmsView?: ClientPmsViewBundle;
      canViewNegotiatedRates: boolean;
      canManageNegotiatedRates: boolean;
      clientRateOverrides: ClientRateOverrideRecord[];
      parentRateChain: ParentChainNodeSummary[];
      inheritedParentRateOverrides: InheritedParentRateOverrideView[];
      rateCustomGrades: Array<{ id: string; label: string }>;
      canTakeByTaskId: Record<string, boolean>;
    }
  | null
> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();

  const organisation = await partyRepo.getOrganisationById<Organisation>(ctx, id);
  if (!organisation) return null;
  if (organisation.mergedIntoId) {
    return { redirectTo: `/organisations/${organisation.mergedIntoId}` };
  }

  const canViewNegotiatedRates = shell.currentUserPermissions.some((p) =>
    [
      'finance:view',
      'finance:view_matter',
      'finance:credit_control',
      'admin:access',
    ].includes(p),
  );
  const canManageNegotiatedRates = shell.currentUserPermissions.some((p) =>
    ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'].includes(p),
  );

  const [
    groupOrgs,
    links,
    notes,
    merges,
    matters,
    tasks,
    enquiries,
    autoMatchesRaw,
    explicitMatchesRaw,
    audit,
    pmsViewRes,
    rateBundle,
  ] = await Promise.all([
    partyRepo.expandCorporateGroupOrganisationIds<Organisation>(ctx, [organisation.id]),
    partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
      organisationIds: [organisation.id],
    }),
    partyRepo.listNotesForRecord<Note>(ctx, 'organisation', organisation.id),
    partyRepo.listMergeHistoryForEntity<MergeHistory>(ctx, 'organisation', organisation.id),
    matterRepo.listVisibleMattersForEntity<Matter>(
      ctx,
      {
        clientIds: [organisation.id],
        partyEntityIds: [organisation.id],
        contactIds: [organisation.id],
      },
      { viewerId: currentUserId, hasRestrictedMatterAccess },
    ),
    taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
      linkedRecordType: 'organisation',
      linkedRecordId: organisation.id,
      hasRestrictedMatterAccess,
    }),
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
      relatedOrganisationId: organisation.id,
      hasRestrictedMatterAccess,
    }),
    findCandidateDuplicatesForRecord(organisation, { ctx }) as Promise<Organisation[]>,
    organisation.possibleMatchIds.length > 0
      ? partyRepo.listOrganisationsByIds<Organisation>(ctx, organisation.possibleMatchIds)
      : Promise.resolve<Organisation[]>([]),
    listAuditEntriesForRecord('organisation', organisation.id, currentUserId, {
      limit: 200,
    }),
    shell.finance.canViewMatter
      ? getClientPmsViewBundle('organisation', organisation.id, ctx)
      : Promise.resolve(null),
    canViewNegotiatedRates
      ? listClientRateOverridesRecord(
          { clientType: 'organisation', clientId: organisation.id },
          currentUserId,
        )
      : Promise.resolve(null),
  ]);

  const pmsView =
    pmsViewRes && !isActionDenied(pmsViewRes) ? pmsViewRes : undefined;
  const duplicateCandidates = dedupeById([
    ...explicitMatchesRaw.filter((o) => !o.mergedIntoId),
    ...autoMatchesRaw,
  ]);
  const extraOrgIds = [
    organisation.id,
    organisation.parentOrganisationId,
    ...(pmsView?.link?.entityType === 'organisation' ? [pmsView.link.onesquaredId] : []),
  ];
  const { people, organisations: refOrgs } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    tasks,
    links,
    extraPersonIds: [
      organisation.relationshipPartnerId,
      organisation.recordOwnerId,
      organisation.reviewerId,
    ],
    extraOrgIds,
  });
  const allOrganisations = dedupeById([
    organisation,
    ...groupOrgs,
    ...duplicateCandidates,
    ...refOrgs,
  ]);

  const canTakeByTaskId: Record<string, boolean> = {};
  for (const t of tasks) {
    canTakeByTaskId[t.id] = canUserTakeTask(
      currentUserId,
      t,
      shell.teams,
      people,
      shell.values,
      shell.currentUserPermissions,
    );
  }
  const rateCustomGrades = Array.from(
    new Map(
      (shell.store.matterCostsConfig.rateCards ?? [])
        .flatMap((rc) => rc.customGrades ?? [])
        .map((cg) => [cg.id, { id: cg.id, label: cg.label }]),
    ).values(),
  );

  return {
    shell,
    organisation,
    allOrganisations,
    people,
    links,
    matters,
    tasks,
    enquiries,
    notes,
    audit,
    merges,
    duplicateCandidates,
    pmsView,
    canViewNegotiatedRates,
    canManageNegotiatedRates,
    clientRateOverrides:
      rateBundle && !isActionDenied(rateBundle) ? rateBundle.overrides : [],
    parentRateChain:
      rateBundle && !isActionDenied(rateBundle) ? rateBundle.parentChain : [],
    inheritedParentRateOverrides:
      rateBundle && !isActionDenied(rateBundle)
        ? rateBundle.inheritedOverrides
        : [],
    rateCustomGrades,
    canTakeByTaskId,
  };
}

export async function loadOrganisationFormPageData(
  actorId: string,
  id?: string,
  options?: LoaderOptions,
): Promise<
  | { redirectTo: string }
  | {
      shell: ShellContextData;
      existing: Organisation | null;
      allOrganisations: Organisation[];
    }
  | null
> {
  const shell = await loadShellContext(actorId, options);
  const partyRepo = getPartyRepository();
  if (!id) {
    return { shell, existing: null, allOrganisations: [] };
  }
  const existing = await partyRepo.getOrganisationById<Organisation>(shell.ctx, id);
  if (!existing) return null;
  if (existing.mergedIntoId) {
    return { redirectTo: `/organisations/${existing.mergedIntoId}/edit` };
  }
  const parentOrgs = existing.parentOrganisationId
    ? await partyRepo.listOrganisationsByIds<Organisation>(shell.ctx, [
        existing.parentOrganisationId,
      ])
    : [];
  return {
    shell,
    existing,
    allOrganisations: dedupeById([existing, ...parentOrgs]),
  };
}

// ============================================================================
// Route 10-13: Matters
// ============================================================================

export async function loadMattersListPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  matters: Matter[];
  people: Person[];
  organisations: Organisation[];
  tasks: Task[];
  matterFinance?: MatterFinanceRowsResult;
}> {
  const shell = await loadShellContext(actorId, options);
  const matterRepo = getMatterRepository();
  const taskRepo = getTaskWorkflowRepository();

  const [matters, matterFinanceRes] = await Promise.all([
    matterRepo.listVisibleMatters<Matter>(shell.ctx, {
      viewerId: shell.currentUserId,
      hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
    }),
    shell.finance.canViewMatter
      ? getMatterFinanceRows(shell.ctx, undefined, { summaryOnly: true })
      : Promise.resolve(null),
  ]);
  const matterIds = matters.map((m) => m.id);
  const tasks =
    matterIds.length > 0
      ? await taskRepo.listVisibleTasks<Task>(shell.ctx, shell.currentUserId, {
          linkedRecordIds: matterIds,
          openOnly: true,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
        })
      : [];
  const { people, organisations } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters,
    tasks,
  });

  return {
    shell,
    matters,
    people,
    organisations,
    tasks,
    matterFinance:
      matterFinanceRes && !isActionDenied(matterFinanceRes)
        ? matterFinanceRes
        : undefined,
  };
}

export async function loadMatterDetailPageData(
  actorId: string,
  id: string,
  searchTab?: string,
  options?: LoaderOptions,
): Promise<
  | {
      kind: 'form';
      shell: ShellContextData;
      matter: Matter;
      initialEnquiry: Enquiry | null;
      initialQuote: Quote | null;
      isReopenedDraft: boolean;
      initialResolvedRates: ResolvedApplicableRatesResult | null;
      initialMatterRateOverrides: Awaited<ReturnType<typeof listMatterRateOverridesRecord>>['overrides'];
      people: Person[];
      organisations: Organisation[];
      links: PersonOrganisationLink[];
      canSignOffCosts: boolean;
      canManageMatterRateOverrides: boolean;
      initialSignOffEstimateGbp: number;
      suggestedMatterGovernanceAssignees: {
        riskReviewerId: string | null;
        practiceManagerId: string | null;
      };
    }
  | {
      kind: 'profile';
      shell: ShellContextData;
      matter: Matter;
      people: Person[];
      organisations: Organisation[];
      tasks: Task[];
      enquiries: Enquiry[];
      quotes: Quote[];
      notes: Note[];
      audit: AuditEntry[];
      keyDates: KeyDate[];
      keyDateNotApplicable: KeyDateNotApplicable[];
      keyDateReminderStates: KeyDateReminderState[];
      keyDateCalendarSyncs: KeyDateCalendarSync[];
      canVerifyByKeyDateId: Record<string, { allowed: boolean; reason?: string }>;
      registersConfig: RegistersConfiguration;
      registerTypes: RegisterTypeDefinition[];
      matterRegisterRecords: RegisterRecord[];
      matterRegisterTransitions: Record<string, RegisterTransition[]>;
      pmsView?: MatterPmsViewBundle;
      canTakeByTaskId: Record<string, boolean>;
    }
  | null
> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const matterRepo = getMatterRepository();
  const partyRepo = getPartyRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();

  const matter = await matterRepo.getMatterById<Matter>(ctx, id, {
    viewerId: currentUserId,
    hasRestrictedMatterAccess,
  });
  if (!matter) return null;

  const isDraftOrPending =
    matter.matterNumber === 'DRAFT' ||
    matter.conflictCheckStatus === 'Draft' ||
    (matter.conflictCheckStatus === 'Pending conflict review' && !searchTab);

  if (isDraftOrPending) {
    const [
      quotesById,
      quotesByConverted,
      enquiriesById,
      enquiriesByConverted,
      matterRateOverridesRes,
    ] = await Promise.all([
      shell.canViewQuotes && matter.sourceQuoteId
        ? intakeRepo.listQuotesByIds<Quote>(ctx, [matter.sourceQuoteId], {
            viewerId: currentUserId,
            hasRestrictedMatterAccess,
          })
        : Promise.resolve<Quote[]>([]),
      shell.canViewQuotes
        ? intakeRepo.listVisibleQuotes<Quote>(ctx, currentUserId, {
            convertedMatterId: matter.id,
            hasRestrictedMatterAccess,
          })
        : Promise.resolve<Quote[]>([]),
      matter.sourceEnquiryId
        ? intakeRepo.listEnquiriesByIds<Enquiry>(ctx, [matter.sourceEnquiryId], {
            viewerId: currentUserId,
            hasRestrictedMatterAccess,
          })
        : Promise.resolve<Enquiry[]>([]),
      intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
        convertedMatterId: matter.id,
        hasRestrictedMatterAccess,
      }),
      listMatterRateOverridesRecord(matter.id, currentUserId),
    ]);
    const initialQuote = quotesById[0] ?? quotesByConverted[0] ?? null;
    if (initialQuote) {
      applyQuoteEffectiveLifecycle(initialQuote, new Date(), {
        appendExpiredTimeline: false,
      });
    }
    let initialEnquiry: Enquiry | null =
      enquiriesById[0] ?? enquiriesByConverted[0] ?? null;
    if (!initialEnquiry && initialQuote?.linkedEnquiryId) {
      initialEnquiry = await intakeRepo.getEnquiryById<Enquiry>(
        ctx,
        initialQuote.linkedEnquiryId,
        { viewerId: currentUserId, hasRestrictedMatterAccess },
      );
    }

    const clientOrgCheck = matter.clientId?.startsWith('O-');
    const initialRatesRes = await resolveApplicableRatesRecord(
      {
        matterId: matter.id,
        clientId: matter.clientId || null,
        clientType: clientOrgCheck
          ? 'organisation'
          : matter.clientId
            ? 'person'
            : null,
        practiceAreaId: matter.practiceAreaId || null,
      },
      currentUserId,
    );
    const clientIdsForLinks = [
      matter.clientId,
      ...(matter.additionalClientIds ?? []),
    ].filter((cid): cid is string => Boolean(cid));
    const links =
      clientIdsForLinks.length > 0
        ? await partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
            organisationIds: clientIdsForLinks.filter((x) => x.startsWith('O-')),
            personIds: clientIdsForLinks.filter((x) => x.startsWith('P-')),
          })
        : [];
    const { people, organisations } = await collectReferencedParties({
      ctx,
      shell,
      matters: [matter],
      enquiries: initialEnquiry ? [initialEnquiry] : [],
      quotes: initialQuote ? [initialQuote] : [],
      links,
    });
    const rolesByPersonId: Record<string, HomeRoleKey[]> = {};
    for (const emp of shell.staffPeopleRaw) {
      if (!emp.isEmployee || emp.mergedIntoId) continue;
      rolesByPersonId[emp.id] = resolveEmployeeRoles(emp, shell.teams);
    }
    const riskReviewer = resolveSuggestedConflictReviewer(
      { teams: shell.teams, orgStructure: shell.orgStructure },
      shell.activeTenantCfg.conflictReview,
      rolesByPersonId,
      shell.employees,
    );
    const practiceManager =
      shell.employees.find(
        (e) =>
          rolesByPersonId[e.id]?.includes('managing_partner') ||
          e.employeeRoleId === 'employee_role.practice_manager',
      ) ?? null;

    return {
      kind: 'form',
      shell,
      matter,
      initialEnquiry,
      initialQuote,
      isReopenedDraft:
        matter.matterNumber === 'DRAFT' || matter.conflictCheckStatus === 'Draft',
      initialResolvedRates:
        initialRatesRes && !isActionDenied(initialRatesRes)
          ? (initialRatesRes.resolved ?? null)
          : null,
      initialMatterRateOverrides:
        matterRateOverridesRes && !isActionDenied(matterRateOverridesRes)
          ? matterRateOverridesRes.overrides
          : [],
      people,
      organisations,
      links,
      canSignOffCosts:
        shell.currentUserPermissions.includes('matter:costs:sign_off') &&
        canPersonAccessMatter(matter, currentUserId, shell.currentUser, {
          allPeople: shell.staffPeopleRaw,
          teams: shell.teams,
          config: { rbac: shell.rbacConfig },
        }),
      canManageMatterRateOverrides: shell.currentUserPermissions.some((p) =>
        ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'].includes(p),
      ),
      initialSignOffEstimateGbp: resolveMatterSignOffEstimateGbp(
        shell.store,
        shell.activeTenantCfg,
        matter,
      ).estimatedFeeGbp,
      suggestedMatterGovernanceAssignees: {
        riskReviewerId: riskReviewer?.id ?? null,
        practiceManagerId: practiceManager?.id ?? null,
      },
    };
  }

  const [
    pmsViewRes,
    matterKeyDates,
    audit,
    matterRegistersRes,
    tasks,
    notes,
    enquiriesById,
    enquiriesByConverted,
    quotesById,
    quotesByConverted,
    registersMeta,
  ] = await Promise.all([
    shell.finance.canViewMatter
      ? getMatterPmsViewBundle(matter.id, currentUserId)
      : Promise.resolve(null),
    getMatterKeyDatesSnapshot(matter.id, currentUserId),
    listAuditEntriesForRecord('matter', matter.id, currentUserId, { limit: 200 }),
    listRegistersWorkspaceDataRecord({ matterId: matter.id }, currentUserId),
    taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
      linkedRecordType: 'matter',
      linkedRecordId: matter.id,
      hasRestrictedMatterAccess,
    }),
    partyRepo.listNotesForRecord<Note>(ctx, 'matter', matter.id),
    matter.sourceEnquiryId
      ? intakeRepo.listEnquiriesByIds<Enquiry>(ctx, [matter.sourceEnquiryId], {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Enquiry[]>([]),
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
      convertedMatterId: matter.id,
      hasRestrictedMatterAccess,
    }),
    shell.canViewQuotes && matter.sourceQuoteId
      ? intakeRepo.listQuotesByIds<Quote>(ctx, [matter.sourceQuoteId], {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Quote[]>([]),
    shell.canViewQuotes
      ? intakeRepo.listVisibleQuotes<Quote>(ctx, currentUserId, {
          convertedMatterId: matter.id,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Quote[]>([]),
    resolveRegistersSummary(ctx, shell.activeTenantCfg),
  ]);

  const enquiries = dedupeById([...enquiriesById, ...enquiriesByConverted]);
  const quotes = dedupeById([...quotesById, ...quotesByConverted]);
  for (const q of quotes) {
    applyQuoteEffectiveLifecycle(q, new Date(), { appendExpiredTimeline: false });
  }
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters: [matter],
    enquiries,
    quotes,
    tasks,
    keyDates: matterKeyDates.keyDates,
    extraPersonIds: notes.map((n) => n.authorId),
  });
  const canTakeByTaskId: Record<string, boolean> = {};
  for (const t of tasks) {
    canTakeByTaskId[t.id] = canUserTakeTask(
      currentUserId,
      t,
      shell.teams,
      people,
      shell.values,
      shell.currentUserPermissions,
    );
  }

  return {
    kind: 'profile',
    shell,
    matter,
    people,
    organisations,
    tasks,
    enquiries,
    quotes,
    notes,
    audit,
    keyDates: matterKeyDates.keyDates,
    keyDateNotApplicable: matterKeyDates.keyDateNotApplicable,
    keyDateReminderStates: matterKeyDates.keyDateReminderStates,
    keyDateCalendarSyncs: matterKeyDates.keyDateCalendarSyncs,
    canVerifyByKeyDateId: matterKeyDates.canVerifyByKeyDateId,
    registersConfig: registersMeta.registersConfig,
    registerTypes: registersMeta.registerTypes,
    matterRegisterRecords:
      matterRegistersRes && !isActionDenied(matterRegistersRes) && matterRegistersRes.ok
        ? matterRegistersRes.records
        : [],
    matterRegisterTransitions:
      matterRegistersRes && !isActionDenied(matterRegistersRes) && matterRegistersRes.ok
        ? matterRegistersRes.transitionsByRecordId
        : {},
    pmsView:
      pmsViewRes && !isActionDenied(pmsViewRes) ? pmsViewRes : undefined,
    canTakeByTaskId,
  };
}

export async function loadMatterFormPageData(
  actorId: string,
  params: {
    readonly editId?: string;
    readonly clientId?: string;
    readonly subcategory?: string;
    readonly enquiryId?: string;
    readonly fromEnquiry?: string;
    readonly quoteId?: string;
    readonly instructingContactId?: string;
    readonly draftId?: string;
  },
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  existing: Matter | null;
  initialEnquiry: Enquiry | null;
  initialQuote: Quote | null;
  isReopenedDraft: boolean;
  initialConflictWarnings: string[];
  initialResolvedRates: ResolvedApplicableRatesResult | null;
  initialMatterRateOverrides: Awaited<ReturnType<typeof listMatterRateOverridesRecord>>['overrides'];
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  canSignOffCosts: boolean;
  initialSignOffEstimateGbp: number | null;
  suggestedMatterGovernanceAssignees: {
    riskReviewerId: string | null;
    practiceManagerId: string | null;
  };
} | null> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const matterRepo = getMatterRepository();
  const partyRepo = getPartyRepository();
  const intakeRepo = getIntakeQuoteRepository();

  const targetMatterId = params.editId ?? params.draftId ?? null;
  const [existingMatter, initialQuoteDirect] = await Promise.all([
    targetMatterId
      ? matterRepo.getMatterById<Matter>(ctx, targetMatterId, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter | null>(null),
    params.quoteId && shell.canViewQuotes
      ? intakeRepo.getQuoteByIdOrReference<Quote>(ctx, params.quoteId, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Quote | null>(null),
  ]);
  if (params.editId && !existingMatter) return null;
  if (initialQuoteDirect) {
    applyQuoteEffectiveLifecycle(initialQuoteDirect, new Date(), {
      appendExpiredTimeline: false,
    });
  }

  const resolvedEnquiryId =
    params.enquiryId ??
    params.fromEnquiry ??
    initialQuoteDirect?.linkedEnquiryId ??
    existingMatter?.sourceEnquiryId ??
    undefined;
  const initialEnquiry = resolvedEnquiryId
    ? await intakeRepo.getEnquiryById<Enquiry>(ctx, resolvedEnquiryId, {
        viewerId: currentUserId,
        hasRestrictedMatterAccess,
      })
    : null;

  const rateClientId =
    existingMatter?.clientId ??
    params.clientId ??
    initialQuoteDirect?.linkedOrganisationId ??
    initialQuoteDirect?.linkedPersonId ??
    null;
  const ratePracticeAreaId =
    existingMatter?.practiceAreaId ?? initialQuoteDirect?.practiceAreaId ?? null;

  const [initialRatesRes, matterRateOverridesRes] = await Promise.all([
    rateClientId || ratePracticeAreaId || existingMatter?.id
      ? resolveApplicableRatesRecord(
          {
            matterId: existingMatter?.id ?? null,
            clientId: rateClientId,
            clientType: rateClientId?.startsWith('O-')
              ? 'organisation'
              : rateClientId
                ? 'person'
                : null,
            practiceAreaId: ratePracticeAreaId,
          },
          currentUserId,
        )
      : Promise.resolve(null),
    existingMatter?.id
      ? listMatterRateOverridesRecord(existingMatter.id, currentUserId)
      : Promise.resolve(null),
  ]);

  const orgIdsForLinks = Array.from(
    new Set(
      [
        existingMatter?.clientId,
        ...(existingMatter?.additionalClientIds ?? []),
        params.clientId,
        initialQuoteDirect?.linkedOrganisationId,
        initialEnquiry?.linkedOrganisationId,
      ].filter((id): id is string => Boolean(id && id.startsWith('O-'))),
    ),
  );
  const links =
    orgIdsForLinks.length > 0
      ? await partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
          organisationIds: orgIdsForLinks,
        })
      : [];
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters: existingMatter ? [existingMatter] : [],
    enquiries: initialEnquiry ? [initialEnquiry] : [],
    quotes: initialQuoteDirect ? [initialQuoteDirect] : [],
    links,
    extraPersonIds: [params.clientId, params.instructingContactId],
    extraOrgIds: [params.clientId],
  });

  const rolesByPersonId: Record<string, HomeRoleKey[]> = {};
  for (const emp of shell.staffPeopleRaw) {
    if (!emp.isEmployee || emp.mergedIntoId) continue;
    rolesByPersonId[emp.id] = resolveEmployeeRoles(emp, shell.teams);
  }
  const riskReviewer = resolveSuggestedConflictReviewer(
    { teams: shell.teams, orgStructure: shell.orgStructure },
    shell.activeTenantCfg.conflictReview,
    rolesByPersonId,
    shell.employees,
  );
  const practiceManager =
    shell.employees.find(
      (e) =>
        rolesByPersonId[e.id]?.includes('managing_partner') ||
        e.employeeRoleId === 'employee_role.practice_manager',
    ) ?? null;

  const canSignOffCosts = existingMatter
    ? shell.currentUserPermissions.includes('matter:costs:sign_off') &&
      canPersonAccessMatter(existingMatter, currentUserId, shell.currentUser, {
        allPeople: shell.staffPeopleRaw,
        teams: shell.teams,
        config: { rbac: shell.rbacConfig },
      })
    : false;
  const initialSignOffEstimateGbp = existingMatter
    ? resolveMatterSignOffEstimateGbp(shell.store, shell.activeTenantCfg, existingMatter)
        .estimatedFeeGbp
    : null;

  return {
    shell,
    existing: existingMatter,
    initialEnquiry,
    initialQuote: initialQuoteDirect,
    isReopenedDraft: Boolean(
      params.draftId && existingMatter && !params.editId,
    ),
    initialConflictWarnings: normaliseConversionConflictWarnings(
      initialQuoteDirect?.conflictDecision?.warnings ??
        initialEnquiry?.conflictDecision?.warnings,
    ),
    initialResolvedRates:
      initialRatesRes && !isActionDenied(initialRatesRes)
        ? (initialRatesRes.resolved ?? null)
        : null,
    initialMatterRateOverrides:
      matterRateOverridesRes && !isActionDenied(matterRateOverridesRes)
        ? matterRateOverridesRes.overrides
        : [],
    people,
    organisations,
    links,
    canSignOffCosts,
    initialSignOffEstimateGbp,
    suggestedMatterGovernanceAssignees: {
      riskReviewerId: riskReviewer?.id ?? null,
      practiceManagerId: practiceManager?.id ?? null,
    },
  };
}

// ============================================================================
// Route 14-16: Enquiries (`/enquiries`, `/enquiries/[id]`, `/enquiries/new`)
// ============================================================================

export async function loadEnquiriesListPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  enquiries: Enquiry[];
  quotes: Quote[];
  tasks: Task[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
}> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const matterRepo = getMatterRepository();

  const [enquiries, quotes] = await Promise.all([
    intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
      hasRestrictedMatterAccess,
      limit: 500,
    }),
    shell.canViewQuotes
      ? intakeRepo.listVisibleQuotes<Quote>(ctx, currentUserId, {
          hasRestrictedMatterAccess,
          limit: 500,
        })
      : Promise.resolve<Quote[]>([]),
  ]);
  for (const q of quotes) {
    applyQuoteEffectiveLifecycle(q, new Date(), { appendExpiredTimeline: false });
  }
  const linkedTargetIds = [
    ...enquiries.map((e) => e.id),
    ...quotes.map((q) => q.id),
  ];
  const convertedMatterIds = Array.from(
    new Set(
      [
        ...enquiries.map((e) => e.convertedMatterId),
        ...quotes.map((q) => q.convertedMatterId),
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const [tasks, matters] = await Promise.all([
    linkedTargetIds.length > 0
      ? taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
          linkedRecordIds: linkedTargetIds,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Task[]>([]),
    convertedMatterIds.length > 0
      ? matterRepo.listMattersByIds<Matter>(ctx, convertedMatterIds, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter[]>([]),
  ]);
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    quotes,
    tasks,
  });

  return { shell, enquiries, quotes, tasks, people, organisations, matters };
}

export async function loadEnquiryDetailPageData(
  actorId: string,
  id: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  enquiry: Enquiry;
  quotes: Quote[];
  tasks: Task[];
  audit: AuditEntry[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  canReopen: boolean;
  canAnonymise: boolean;
  keyDates: KeyDate[];
  keyDateReminderStates: KeyDateReminderState[];
  keyDateCalendarSyncs: KeyDateCalendarSync[];
  canVerifyByKeyDateId: Record<string, { allowed: boolean; reason?: string }>;
} | null> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const matterRepo = getMatterRepository();
  const keyDateRepo = getKeyDateRepository();

  const enquiry = await intakeRepo.getEnquiryById<Enquiry>(ctx, id, {
    viewerId: currentUserId,
    hasRestrictedMatterAccess,
  });
  if (!enquiry) return null;

  const [quotes, tasks, audit, convertedMatter, keyDates] = await Promise.all([
    shell.canViewQuotes
      ? intakeRepo.listVisibleQuotes<Quote>(ctx, currentUserId, {
          sourceEnquiryId: enquiry.id,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Quote[]>([]),
    taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
      linkedRecordType: 'enquiry',
      linkedRecordId: enquiry.id,
      hasRestrictedMatterAccess,
    }),
    listAuditEntriesForRecord('enquiry', enquiry.id, currentUserId, { limit: 200 }),
    enquiry.convertedMatterId
      ? matterRepo.getMatterById<Matter>(ctx, enquiry.convertedMatterId, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter | null>(null),
    keyDateRepo.listKeyDatesForEnquiry(ctx, enquiry.id, currentUserId),
  ]);
  for (const q of quotes) {
    applyQuoteEffectiveLifecycle(q, new Date(), { appendExpiredTimeline: false });
  }
  const keyDateIds = keyDates.map((kd) => kd.id);
  const [keyDateReminderStates, keyDateCalendarSyncs] =
    keyDateIds.length > 0
      ? await Promise.all([
          keyDateRepo.listReminderStatesForKeyDateIds(ctx, keyDateIds, currentUserId),
          keyDateRepo.listCalendarSyncsForKeyDateIds(ctx, keyDateIds, currentUserId),
        ])
      : [[], []];

  const matters = convertedMatter ? [convertedMatter] : [];
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries: [enquiry],
    quotes,
    tasks,
    keyDates,
    extraPersonIds: enquiry.conflictSnapshot?.knownPeople.map((k) => k.id),
    extraOrgIds: enquiry.conflictSnapshot?.knownOrganisations.map((k) => k.id),
  });

  const canVerifyByKeyDateId: Record<string, { allowed: boolean; reason?: string }> =
    {};
  for (const kd of keyDates) {
    canVerifyByKeyDateId[kd.id] = canUserVerifyKeyDate(shell.currentUser, kd, {
      config: shell.keyDatesConfig,
      allPeople: shell.staffPeopleRaw,
      teams: shell.teams,
    });
  }

  const canReopen =
    shell.currentUserPermissions.includes('enquiry:reopen') &&
    canUserReopenEnquiry(
      currentUserId,
      enquiry,
      shell.teams,
      shell.staffPeopleRaw,
      shell.values,
    );

  return {
    shell,
    enquiry,
    quotes,
    tasks,
    audit,
    people,
    organisations,
    matters,
    canReopen,
    canAnonymise: shell.currentUserPermissions.includes('enquiry:anonymise'),
    keyDates,
    keyDateReminderStates,
    keyDateCalendarSyncs,
    canVerifyByKeyDateId,
  };
}

export async function loadEnquiryFormPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{ shell: ShellContextData }> {
  const shell = await loadShellContext(actorId, options);
  return { shell };
}

// ============================================================================
// Route 17-18: Quotes (`/quotes/new`, `/quotes/[id]`)
// ============================================================================

export async function loadQuoteDetailPageData(
  actorId: string,
  id: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  quote: Quote;
  enquiries: Enquiry[];
  matters: Matter[];
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  initialResolvedRates: ResolvedApplicableRatesResult | null;
} | null> {
  const shell = await loadShellContext(actorId, options);
  if (!shell.canViewQuotes) return null;
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const intakeRepo = getIntakeQuoteRepository();
  const matterRepo = getMatterRepository();
  const partyRepo = getPartyRepository();

  const quote = await intakeRepo.getQuoteByIdOrReference<Quote>(ctx, id, {
    viewerId: currentUserId,
    hasRestrictedMatterAccess,
  });
  if (!quote) return null;
  applyQuoteEffectiveLifecycle(quote, new Date(), { appendExpiredTimeline: false });

  const rateClientId = quote.linkedOrganisationId ?? quote.linkedPersonId ?? null;
  const rateClientType = quote.linkedOrganisationId
    ? 'organisation'
    : quote.linkedPersonId
      ? 'person'
      : null;

  const [linkedEnquiry, convertedMatter, ratesRes, links] = await Promise.all([
    quote.linkedEnquiryId
      ? intakeRepo.getEnquiryById<Enquiry>(ctx, quote.linkedEnquiryId, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Enquiry | null>(null),
    quote.convertedMatterId
      ? matterRepo.getMatterById<Matter>(ctx, quote.convertedMatterId, {
          viewerId: currentUserId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter | null>(null),
    rateClientId || quote.practiceAreaId
      ? resolveApplicableRatesRecord(
          {
            clientId: rateClientId,
            clientType: rateClientType,
            practiceAreaId: quote.practiceAreaId,
          },
          currentUserId,
        )
      : Promise.resolve(null),
    quote.linkedOrganisationId || quote.linkedPersonId
      ? partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
          organisationIds: quote.linkedOrganisationId ? [quote.linkedOrganisationId] : [],
          personIds: quote.linkedPersonId ? [quote.linkedPersonId] : [],
        })
      : Promise.resolve<PersonOrganisationLink[]>([]),
  ]);

  const enquiries = linkedEnquiry ? [linkedEnquiry] : [];
  const matters = convertedMatter ? [convertedMatter] : [];
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    quotes: [quote],
    links,
  });

  return {
    shell,
    quote,
    enquiries,
    matters,
    people,
    organisations,
    links,
    initialResolvedRates:
      ratesRes && !isActionDenied(ratesRes) ? (ratesRes.resolved ?? null) : null,
  };
}

export async function loadQuoteFormPageData(
  actorId: string,
  enquiryId?: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  initialEnquiry: Enquiry | null;
  initialResolvedRates: ResolvedApplicableRatesResult | null;
  enquiries: Enquiry[];
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
} | null> {
  const shell = await loadShellContext(actorId, options);
  if (
    !shell.currentUserPermissions.includes('quote:view') ||
    !shell.currentUserPermissions.includes('quote:edit')
  ) {
    return null;
  }
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const intakeRepo = getIntakeQuoteRepository();
  const partyRepo = getPartyRepository();

  const initialEnquiry = enquiryId
    ? await intakeRepo.getEnquiryById<Enquiry>(ctx, enquiryId, {
        viewerId: currentUserId,
        hasRestrictedMatterAccess,
      })
    : null;
  const rateClientId =
    initialEnquiry?.linkedOrganisationId ?? initialEnquiry?.linkedPersonId ?? null;
  const rateClientType = initialEnquiry?.linkedOrganisationId
    ? 'organisation'
    : initialEnquiry?.linkedPersonId
      ? 'person'
      : null;

  const [ratesRes, links] = await Promise.all([
    rateClientId || initialEnquiry?.practiceAreaId
      ? resolveApplicableRatesRecord(
          {
            clientId: rateClientId,
            clientType: rateClientType,
            practiceAreaId: initialEnquiry?.practiceAreaId ?? null,
          },
          currentUserId,
        )
      : Promise.resolve(null),
    initialEnquiry?.linkedOrganisationId || initialEnquiry?.linkedPersonId
      ? partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
          organisationIds: initialEnquiry.linkedOrganisationId
            ? [initialEnquiry.linkedOrganisationId]
            : [],
          personIds: initialEnquiry.linkedPersonId
            ? [initialEnquiry.linkedPersonId]
            : [],
        })
      : Promise.resolve<PersonOrganisationLink[]>([]),
  ]);

  const enquiries = initialEnquiry ? [initialEnquiry] : [];
  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    enquiries,
    links,
  });

  return {
    shell,
    initialEnquiry,
    initialResolvedRates:
      ratesRes && !isActionDenied(ratesRes) ? (ratesRes.resolved ?? null) : null,
    enquiries,
    people,
    organisations,
    links,
  };
}

// ============================================================================
// Route 19-21: Tasks (`/tasks`, `/tasks/[id]`, `/tasks/new`)
// ============================================================================

async function hydrateLinkedRecordsForTasks(
  ctx: TenantContext,
  viewerId: string,
  hasRestrictedMatterAccess: boolean,
  canViewQuotes: boolean,
  tasks: readonly Task[],
  extraLinkedRecord?: { recordType: string; recordId: string } | null,
): Promise<{
  matters: Matter[];
  enquiries: Enquiry[];
  quotes: Quote[];
  extraPersonIds: string[];
  extraOrgIds: string[];
}> {
  const matterIds = new Set<string>();
  const enquiryIds = new Set<string>();
  const quoteIds = new Set<string>();
  const extraPersonIds: string[] = [];
  const extraOrgIds: string[] = [];

  const collectRef = (recordType: string, recordId: string) => {
    if (!recordId) return;
    if (recordType === 'matter') matterIds.add(recordId);
    else if (recordType === 'enquiry') enquiryIds.add(recordId);
    else if (recordType === 'quote') quoteIds.add(recordId);
    else if (recordType === 'person') extraPersonIds.push(recordId);
    else if (recordType === 'organisation') extraOrgIds.push(recordId);
  };

  for (const t of tasks) {
    for (const lr of t.linkedRecords) {
      collectRef(lr.recordType, lr.recordId);
    }
  }
  if (extraLinkedRecord) {
    collectRef(extraLinkedRecord.recordType, extraLinkedRecord.recordId);
  }

  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [matters, enquiries, quotes] = await Promise.all([
    matterIds.size > 0
      ? matterRepo.listMattersByIds<Matter>(ctx, Array.from(matterIds), {
          viewerId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter[]>([]),
    enquiryIds.size > 0
      ? intakeRepo.listEnquiriesByIds<Enquiry>(ctx, Array.from(enquiryIds), {
          viewerId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Enquiry[]>([]),
    quoteIds.size > 0 && canViewQuotes
      ? intakeRepo.listQuotesByIds<Quote>(ctx, Array.from(quoteIds), {
          viewerId,
          hasRestrictedMatterAccess,
        })
      : Promise.resolve<Quote[]>([]),
  ]);
  return { matters, enquiries, quotes, extraPersonIds, extraOrgIds };
}

export async function loadTasksListPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  tasks: Task[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes: Quote[];
}> {
  const shell = await loadShellContext(actorId, options);
  const taskRepo = getTaskWorkflowRepository();
  const tasks = await taskRepo.listVisibleTasks<Task>(shell.ctx, shell.currentUserId, {
    hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
    limit: 500,
  });
  const { matters, enquiries, quotes, extraPersonIds, extraOrgIds } =
    await hydrateLinkedRecordsForTasks(
      shell.ctx,
      shell.currentUserId,
      shell.hasRestrictedMatterAccess,
      shell.canViewQuotes,
      tasks,
    );
  const { people, organisations } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters,
    enquiries,
    quotes,
    tasks,
    extraPersonIds,
    extraOrgIds,
  });

  return { shell, tasks, people, organisations, matters, enquiries, quotes };
}

export async function loadTaskDetailPageData(
  actorId: string,
  id: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  task: Task;
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes: Quote[];
  audit: AuditEntry[];
  canTake: boolean;
  canReassign: boolean;
} | null> {
  const shell = await loadShellContext(actorId, options);
  const taskRepo = getTaskWorkflowRepository();
  const task = await taskRepo.getTaskById<Task>(shell.ctx, id, {
    viewerId: shell.currentUserId,
    hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
  });
  if (!task) return null;

  const [audit, hydrated] = await Promise.all([
    listAuditEntriesForRecord('task', task.id, shell.currentUserId, { limit: 200 }),
    hydrateLinkedRecordsForTasks(
      shell.ctx,
      shell.currentUserId,
      shell.hasRestrictedMatterAccess,
      shell.canViewQuotes,
      [task],
    ),
  ]);
  const { people, organisations } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters: hydrated.matters,
    enquiries: hydrated.enquiries,
    quotes: hydrated.quotes,
    tasks: [task],
    extraPersonIds: [...hydrated.extraPersonIds, ...audit.map((a) => a.byId)],
    extraOrgIds: hydrated.extraOrgIds,
  });

  const canTake = canUserTakeTask(
    shell.currentUserId,
    task,
    shell.teams,
    people,
    shell.values,
    shell.currentUserPermissions,
  );
  const canReassign = canUserReassignTask(
    shell.currentUserId,
    task,
    shell.teams,
    people,
    shell.values,
    shell.currentUserPermissions,
  );

  return {
    shell,
    task,
    people,
    organisations,
    matters: hydrated.matters,
    enquiries: hydrated.enquiries,
    quotes: hydrated.quotes,
    audit,
    canTake,
    canReassign,
  };
}

export async function loadTaskFormPageData(
  actorId: string,
  initialLinkedRecord?: { recordType: string; recordId: string } | null,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes: Quote[];
}> {
  const shell = await loadShellContext(actorId, options);
  const hydrated = await hydrateLinkedRecordsForTasks(
    shell.ctx,
    shell.currentUserId,
    shell.hasRestrictedMatterAccess,
    shell.canViewQuotes,
    [],
    initialLinkedRecord,
  );
  const { people, organisations } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters: hydrated.matters,
    enquiries: hydrated.enquiries,
    quotes: hydrated.quotes,
    extraPersonIds: hydrated.extraPersonIds,
    extraOrgIds: hydrated.extraOrgIds,
  });

  return {
    shell,
    people,
    organisations,
    matters: hydrated.matters,
    enquiries: hydrated.enquiries,
    quotes: hydrated.quotes,
  };
}

// ============================================================================
// Route 22: Key Dates (`/key-dates`)
// ============================================================================

export async function loadKeyDatesPageData(
  actorId: string,
  options?: LoaderOptions,
): Promise<{
  shell: ShellContextData;
  userDefaultTeamIds: string[];
  initialDiaryEntries: TeamDiaryEntry[];
  initialExceptions: KeyDateException[];
  matters: Matter[];
  enquiries: Enquiry[];
  people: Person[];
}> {
  const shell = await loadShellContext(actorId, options);
  const userDefaultTeamIds = userTeams(shell.effectiveWorkPerson.id, shell.teams).map(
    (t) => t.id,
  );
  const canViewAnyTeam =
    shell.currentUserKeyDatePermissions.includes('keydate:view_any_team');

  const [initialDiaryEntries, initialExceptions] = await Promise.all([
    queryKeyDatesTeamDiaryRecord(
      {
        teamIds: canViewAnyTeam ? shell.teams.map((t) => t.id) : userDefaultTeamIds,
      },
      shell.currentUserId,
    ),
    canViewAnyTeam
      ? getKeyDateExceptionsReportRecord({}, shell.currentUserId)
      : Promise.resolve<KeyDateException[]>([]),
  ]);

  const matterIds = Array.from(
    new Set(
      [
        ...initialDiaryEntries.map((e) => e.matterId),
        ...initialExceptions.map((e) => e.matterId),
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const enquiryIds = Array.from(
    new Set(
      initialDiaryEntries
        .map((e) => e.enquiryId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [matters, enquiries] = await Promise.all([
    matterIds.length > 0
      ? matterRepo.listMattersByIds<Matter>(shell.ctx, matterIds, {
          viewerId: shell.currentUserId,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
        })
      : Promise.resolve<Matter[]>([]),
    enquiryIds.length > 0
      ? intakeRepo.listEnquiriesByIds<Enquiry>(shell.ctx, enquiryIds, {
          viewerId: shell.currentUserId,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
        })
      : Promise.resolve<Enquiry[]>([]),
  ]);
  const { people } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    matters,
    enquiries,
    extraPersonIds: initialDiaryEntries.flatMap((e) => e.responsiblePersonIds ?? []),
  });

  return {
    shell,
    userDefaultTeamIds,
    initialDiaryEntries,
    initialExceptions,
    matters,
    enquiries,
    people,
  };
}

// ============================================================================
// Route 23: Registers (`/registers`)
// ============================================================================

export async function loadRegistersPageData(
  actorId: string,
  options?: LoaderOptions,
) {
  const shell = await loadShellContext(actorId, options);
  const data = await listRegistersWorkspaceDataRecord({}, shell.currentUserId);
  return { shell, data };
}

// ============================================================================
// Route 24: Admin (`/admin/[[...slug]]`)
// ============================================================================

export async function loadAdminPageData(
  actorId: string,
  params: {
    readonly slug?: string[];
    readonly section?: string;
    readonly auditBeforeSeq?: string;
    readonly beforeSeq?: string;
    readonly mfaVerified: boolean;
  },
  options?: LoaderOptions,
): Promise<
  | { redirectTo: string }
  | {
      shell: ShellContextData;
      initialTab: AdminTab;
      lists: ChoiceList[];
      values: ChoiceValue[];
      customFields: CustomFieldDefinition[];
      people: Person[];
      organisations: Organisation[];
      matters: Matter[];
      enquiries: Enquiry[];
      teams: Team[];
      enquirySettings: EnquirySettings;
      taskSettings: LoadedStoreView['taskSettings'];
      pmsAdmin?: PmsAdminSnapshot;
      isLiveEnvironment: boolean;
      defaultRoleConfigs: ReturnType<typeof createDefaultRoleConfigs>;
      orgStructure: OrgStructureCatalogue;
      matterPartyTaxonomy: MatterPartyTaxonomy;
      matterPartyMigrationReport?: MatterPartyMigrationReport;
      matterCostsConfig: MatterCostsConfig;
      appRoleByPersonId: Record<string, AppRole>;
      rolesByPersonId: Record<string, HomeRoleKey[]>;
      permissionsByPersonId: Record<string, PermissionKey[]>;
      employeeMigrationReport?: EmployeeMigrationReport;
      registersConfig: RegistersConfiguration;
      registerTypes: RegisterTypeDefinition[];
      workTypesConfig: WorkTypesConfiguration;
      entraEnvStatus: ReturnType<typeof getEntraEnvStatus>;
      firmAuditPage: Awaited<ReturnType<typeof listFirmAuditEntriesPage>>;
    }
> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUser, teams, rbacConfig, activeTenantCfg } = shell;

  const canAccessAdmin = hasPersonPermission(currentUser, 'admin:access', {
    allPeople: shell.staffPeopleRaw,
    teams,
    mfaVerified: params.mfaVerified,
    enforceMfa: true,
  });
  if (!canAccessAdmin) {
    return { redirectTo: '/' };
  }

  const rawBeforeSeq = params.auditBeforeSeq ?? params.beforeSeq;
  const parsedBeforeSeq = rawBeforeSeq ? Number.parseInt(rawBeforeSeq, 10) : NaN;

  const first = params.slug?.[0];
  const initialTabWithoutPms: AdminTab =
    params.section === 'homePages' || params.section === 'home-pages'
      ? 'home-pages'
      : first === 'teams'
        ? 'org-structure'
        : first === 'home-pages' ||
            first === 'rbac-and-entra' ||
            first === 'org-structure' ||
            first === 'rates-and-costs' ||
            first === 'document-templates' ||
            first === 'document-stores' ||
            first === 'key-dates' ||
            first === 'registers' ||
            first === 'work-types' ||
            first === 'lists' ||
            first === 'custom-fields' ||
            first === 'enquiry-settings' ||
            first === 'task-settings' ||
            first === 'employees' ||
            first === 'demo-data' ||
            first === 'pms-links'
          ? (first as AdminTab)
          : 'lists';

  const needsWhereUsedSample = initialTabWithoutPms === 'lists';
  const needsEnquiriesForAdmin =
    initialTabWithoutPms === 'lists' || initialTabWithoutPms === 'enquiry-settings';

  const [
    firmAuditPage,
    pmsAdminResult,
    dbEmployeeMigrationReport,
    registersMeta,
    boundedPeople,
    boundedOrgs,
    boundedMatters,
    boundedEnquiries,
  ] = await Promise.all([
    listFirmAuditEntriesPage(actorId, {
      limit: 250,
      ...(Number.isFinite(parsedBeforeSeq) ? { beforeSeq: parsedBeforeSeq } : {}),
    }),
    getPmsAdminSnapshot(actorId),
    getHrAndRbacRepository().getEmployeeMigrationReport<EmployeeMigrationReport>(ctx),
    resolveRegistersSummary(ctx, activeTenantCfg),
    needsWhereUsedSample
      ? getPartyRepository().listPeoplePage<Person>(ctx, { limit: 500 })
      : Promise.resolve<Person[]>([]),
    needsWhereUsedSample
      ? getPartyRepository().listOrganisationsPage<Organisation>(ctx, { limit: 500 })
      : Promise.resolve<Organisation[]>([]),
    needsWhereUsedSample
      ? getMatterRepository().listVisibleMatters<Matter>(ctx, {
          viewerId: actorId,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
          limit: 500,
        })
      : Promise.resolve<Matter[]>([]),
    needsEnquiriesForAdmin
      ? getIntakeQuoteRepository().listVisibleEnquiries<Enquiry>(ctx, actorId, {
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
          limit: 500,
        })
      : Promise.resolve<Enquiry[]>([]),
  ]);

  const pmsAdmin = isActionDenied(pmsAdminResult) ? undefined : pmsAdminResult;
  const initialTab: AdminTab =
    first === 'pms-links' && !pmsAdmin ? 'lists' : initialTabWithoutPms;

  const appRoleByPersonId: Record<string, AppRole> = {};
  const rolesByPersonId: Record<string, HomeRoleKey[]> = {};
  const permissionsByPersonId: Record<string, PermissionKey[]> = {};
  for (const emp of shell.staffPeopleRaw) {
    if (!emp.isEmployee || emp.mergedIntoId) continue;
    appRoleByPersonId[emp.id] = resolveUserAppRole(emp, teams, shell.values, {
      config: { rbac: rbacConfig },
    });
    rolesByPersonId[emp.id] = resolveEmployeeRoles(emp, teams);
    permissionsByPersonId[emp.id] = resolvePersonPermissions(emp, {
      allPeople: shell.staffPeopleRaw,
      teams,
      config: { rbac: rbacConfig },
    });
  }

  const staffById = new Set(shell.filteredStaffPeople.map((p) => p.id));
  const combinedPeople = dedupeById([
    ...shell.filteredStaffPeople,
    ...boundedPeople
      .filter((p) => !staffById.has(p.id))
      .map((p) => sanitizePersonForClientPreview(p)),
  ]);

  return {
    shell,
    initialTab,
    lists: shell.lists,
    values: shell.values,
    customFields: shell.customFields,
    people: combinedPeople,
    organisations: boundedOrgs,
    matters: boundedMatters,
    enquiries: boundedEnquiries,
    teams,
    enquirySettings: shell.store.enquirySettings,
    taskSettings: shell.store.taskSettings,
    pmsAdmin,
    isLiveEnvironment: activeTenantCfg.environment === 'live',
    defaultRoleConfigs: createDefaultRoleConfigs(
      activeTenantCfg.branding.primaryDomain,
    ),
    orgStructure: shell.orgStructure,
    matterPartyTaxonomy: shell.store.matterPartyTaxonomy,
    matterPartyMigrationReport: shell.store.matterPartyMigrationReport,
    matterCostsConfig: shell.store.matterCostsConfig,
    appRoleByPersonId,
    rolesByPersonId,
    permissionsByPersonId,
    employeeMigrationReport: dbEmployeeMigrationReport ?? undefined,
    registersConfig: registersMeta.registersConfig,
    registerTypes: registersMeta.registerTypes,
    workTypesConfig: shell.store.workTypesConfig!,
    entraEnvStatus: getEntraEnvStatus(),
    firmAuditPage,
  };
}
