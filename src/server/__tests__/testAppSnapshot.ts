/**
 * Test-only whole-snapshot helper relocated from `src/server/services.ts` in S1-02b.
 * Never import from `src/app/`, `src/components/`, or non-test `src/server/` modules.
 */
import {
  DEFAULT_REGISTERS_CONFIG,
  mergeRegistersConfigurations,
  resolveEffectiveRegisterTypes,
  type RegistersConfiguration,
} from '@platform/core';
import {
  getActiveTenantConfiguration,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getMatterRepository,
  getOutboxRepository,
  getPartyRepository,
  getPmsRepository,
  getRegisterRepository,
  getTaskWorkflowRepository,
  isNonLiveDemoEnvironment,
} from '@/platform/tenantRuntime';
import {
  activeEmployees,
  getKeyDateRepository,
  getKeyDatesConfig,
  isDemoModeEnabled,
  listFirmAuditEntriesPage,
  loadEffectiveTenantRbacConfig,
  loadTenantCatalogueStoreView,
  resolveDefaultServiceTenantContext,
  resolveMatterSignOffEstimateGbp,
} from '../services';
import {
  AuthorisationError,
  canPersonAccessMatter,
  canUserReopenEnquiry,
  canUserTakeTask,
  canUserVerifyKeyDate,
  canViewerAccessMatterKeyDates,
  filterEmploymentForUser,
  getActiveActorSession,
  getLeftRailVisibility,
  resolveConfiguredFirmPrimaryDomain,
  resolveEmployeePermissions,
  resolveKeyDatePermissions,
  resolvePersonPermissions,
  resolveUserAppRole,
  type PermissionKey,
  type RbacConfiguration,
  type ResolvePersonPermissionsOptions,
} from '../rbacRuntime';
import { resolveSuggestedConflictReviewer } from '../conflictReview';
import { attentionList } from '@/domain/attention';
import { findRecordsOwnedByLeavers } from '@/domain/employment';
import {
  createDefaultHomePagesConfig,
  resolveActiveViewingRole,
  resolveEmployeeRoles,
} from '@/domain/homeConfig';
import { resolvePermittedDiaryTeamIds } from '@/domain/keyDateDiary';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDateNotApplicable,
  KeyDateReminderState,
} from '@/domain/keyDates.types';
import { resolveEffectiveMatterCostsConfig } from '@/domain/matterCosts';
import { buildDefaultMatterPartyTaxonomy } from '@/domain/matterParties';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import { applyQuoteEffectiveLifecycle } from '@/domain/quotes';
import { countMyUrgentBadgeTasks } from '@/domain/tasks';
import { resolveEffectiveWorkTypesConfig } from '@/domain/workTypeConfig';
import type {
  AppFinanceCapabilities,
  AppRole,
  AppSnapshot,
  AuditEntry,
  EmployeeSensitiveRecord,
  Enquiry,
  HomePagesConfig,
  HomeRoleKey,
  Matter,
  MergeHistory,
  Note,
  NotificationItem,
  Organisation,
  Person,
  PersonOrganisationLink,
  Quote,
  SignOffItem,
  Task,
  Team,
} from '@/domain/types';
import type { PmsMatterFinancials } from '@/pms/types';
export async function getAppSnapshot(
  userId: string,
  options?: { tokenRoles?: readonly string[]; includeFirmAudit?: boolean },
): Promise<AppSnapshot> {
  return getAppSnapshotInScope(userId, options);
}

async function getAppSnapshotInScope(
  userId: string,
  options?: { tokenRoles?: readonly string[]; includeFirmAudit?: boolean },
): Promise<AppSnapshot> {
  const now = new Date();
  if (!userId || !userId.trim()) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: `Authenticated user "${userId}" was not found or is inactive.`,
      tenantId: getActiveTenantConfiguration().tenantId,
      correlationId: 'app-snapshot',
      actorUserId: userId || 'anonymous',
    });
  }
  const snapshotTenantCtx = resolveDefaultServiceTenantContext(null, userId);
  const store = await loadTenantCatalogueStoreView(snapshotTenantCtx, {
    includePmsLinks: true,
  });
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const hrRepo = getHrAndRbacRepository();
  const [
    people,
    organisations,
    links,
    notes,
    mergeHistory,
    teams,
    dbEmployeeMigrationReport,
    dbRbacOverride,
  ] = await Promise.all([
    partyRepo.listAllPeople<Person>(snapshotTenantCtx),
    partyRepo.listAllOrganisations<Organisation>(snapshotTenantCtx),
    partyRepo.listAllLinks<PersonOrganisationLink>(snapshotTenantCtx),
    partyRepo.listAllNotes<Note>(snapshotTenantCtx),
    partyRepo.listAllMergeHistory<MergeHistory>(snapshotTenantCtx),
    hrRepo.listAllTeams<Team>(snapshotTenantCtx),
    hrRepo.getEmployeeMigrationReport<
      import('@/domain/types').EmployeeMigrationReport
    >(snapshotTenantCtx),
    hrRepo.getRbacConfigOverride<RbacConfiguration>(snapshotTenantCtx),
  ]);
  const rbacConfig = await loadEffectiveTenantRbacConfig(
    snapshotTenantCtx,
    dbRbacOverride,
  );
  const user = people.find(
    (p) => p.id === userId && !p.mergedIntoId,
  );
  if (!user) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: `Authenticated user "${userId}" was not found or is inactive.`,
      tenantId: getActiveTenantConfiguration().tenantId,
      correlationId: 'app-snapshot',
      actorUserId: userId || 'anonymous',
    });
  }
  const currentUserRole = resolveUserAppRole(user, teams, store.values, {
    config: { rbac: rbacConfig },
  });
  const currentUserEmployeePermissions = resolveEmployeePermissions(
    user,
    people,
    teams,
    { config: { rbac: rbacConfig } },
  );
  const activeSession = getActiveActorSession();
  const effectiveTokenRoles =
    options?.tokenRoles ??
    (activeSession?.personId === user.id ? activeSession?.tokenRoles : undefined);
  const currentUserPermissions = resolvePersonPermissions(user, {
    allPeople: people,
    teams,
    tokenRoles: effectiveTokenRoles,
    tokenRolesActorId: user.id,
    config: { rbac: rbacConfig },
  });
  const orgStructure =
    store.orgStructure ??
    buildDefaultOrgStructure({
      legalName: getActiveTenantConfiguration().displayName,
    });

  // Never bulk-return sensitive HR records in page snapshots (R63); serve only via audited per-person read service.
  const employeeSensitiveRecords: Record<string, EmployeeSensitiveRecord> = {};

  const keyDateRepo = getKeyDateRepository();
  const hasRestrictedAccess = currentUserPermissions.includes(
    'matter:restricted:access',
  );
  const canViewQuotes = currentUserPermissions.includes('quote:view');

  // Data-layer SQL visibility filtering for the signed-in user (S1-02a, R152, R170, Rule 4):
  const [
    visibleMatters,
    hiddenMatterIdList,
    rawVisibleEnquiries,
    hiddenEnquiryIdList,
    visibleQuotes,
    hiddenQuoteIdList,
    rawVisibleTasks,
    hiddenTaskIdList,
    visibleSignOffs,
  ] = await Promise.all([
    matterRepo.listVisibleMatters<Matter>(snapshotTenantCtx, {
      viewerId: user.id,
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    matterRepo.listHiddenRestrictedMatterIds(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    intakeRepo.listVisibleEnquiries<Enquiry>(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    intakeRepo.listHiddenEnquiryIds(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    canViewQuotes
      ? intakeRepo.listVisibleQuotes<Quote>(snapshotTenantCtx, user.id, {
          hasRestrictedMatterAccess: hasRestrictedAccess,
        })
      : Promise.resolve<Quote[]>([]),
    intakeRepo.listHiddenQuoteIds(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    taskRepo.listVisibleTasks<Task>(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    taskRepo.listHiddenTaskIds(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
    taskRepo.listVisibleSignOffs<SignOffItem>(snapshotTenantCtx, user.id, {
      hasRestrictedMatterAccess: hasRestrictedAccess,
    }),
  ]);

  const hiddenMatterIds = new Set(hiddenMatterIdList);
  const hiddenMatterKeyDateIds = await keyDateRepo.listHiddenKeyDateIdsForMatters(
    snapshotTenantCtx,
    hiddenMatterIds,
  );
  const hiddenEnquiryIds = new Set(hiddenEnquiryIdList);
  const hiddenQuoteIds = new Set(hiddenQuoteIdList);
  const hiddenTaskIds = new Set(hiddenTaskIdList);

  const visibleTasks: Task[] = [];
  for (const t of rawVisibleTasks) {
    const linksToHiddenKd =
      Boolean(t.linkedKeyDateId && hiddenMatterKeyDateIds.has(t.linkedKeyDateId)) ||
      t.linkedRecords.some(
        (lr) =>
          (lr as { recordType: string }).recordType === 'key_date' &&
          hiddenMatterKeyDateIds.has(lr.recordId),
      );
    if (linksToHiddenKd) {
      hiddenTaskIds.add(t.id);
    } else {
      visibleTasks.push(t);
    }
  }

  // Only conflictCheckOnHire.openMatterIds visible to the signed-in user are exposed via filterEmploymentForUser.
  // Any hidden restricted matter IDs in employment.conflictCheckOnHire.openMatterIds return false from canViewMatterId.
  const visibleMatterById = new Map(visibleMatters.map((m) => [m.id, m]));
  const employeeMatterVisibility = {
    canViewMatterId: (matterId: string) => visibleMatterById.has(matterId),
    visibleMatterNumberById: new Map(
      visibleMatters.map((m) => [m.id, m.matterNumber] as const),
    ),
  };

  // Filter employment records on people at the API level based on requesting user's permissions and matter visibility
  const filteredPeople: Person[] = people.map((p) => {
    if (!p.employment) return p;
    return {
      ...p,
      employment: filterEmploymentForUser(
        p.employment,
        user,
        people,
        teams,
        orgStructure,
        {
          tokenRoles: effectiveTokenRoles,
          tokenRolesActorId: user.id,
          config: { rbac: rbacConfig },
        },
        employeeMatterVisibility,
      ),
    };
  });
  const filteredCurrentUser: Person =
    filteredPeople.find((p) => p.id === user.id) ??
    (user.employment
      ? {
          ...user,
          employment: filterEmploymentForUser(
            user.employment,
            user,
            people,
            teams,
            orgStructure,
            {
              tokenRoles: effectiveTokenRoles,
              tokenRolesActorId: user.id,
              config: { rbac: rbacConfig },
            },
            employeeMatterVisibility,
          ),
        }
      : user);
  const employees = activeEmployees(filteredPeople, store.values);

  const hiddenMatterSourceQuoteIds = new Set<string>();
  for (const q of visibleQuotes) {
    if (q.convertedMatterId && hiddenMatterIds.has(q.convertedMatterId)) {
      hiddenMatterSourceQuoteIds.add(q.id);
    }
  }

  // Strip hidden matter conflict hits from conflictSnapshot.
  const visibleEnquiries: Enquiry[] = rawVisibleEnquiries.map((e) => {
    if (
      !e.conflictSnapshot?.conflicts?.length ||
      hiddenMatterIds.size === 0
    ) {
      return e;
    }
    const filteredConflicts = e.conflictSnapshot.conflicts.filter(
      (c) => !(c.recordType === 'matter' && hiddenMatterIds.has(c.recordId)),
    );
    if (filteredConflicts.length === e.conflictSnapshot.conflicts.length) {
      return e;
    }
    return {
      ...e,
      conflictSnapshot: {
        ...e.conflictSnapshot,
        conflicts: filteredConflicts,
      },
    };
  });

  // Person-to-organisation links only connect People and Organisations.
  const visibleLinks = links;

  const leaverOwnedRecords = findRecordsOwnedByLeavers(
    people,
    organisations,
    visibleMatters,
    visibleTasks,
    visibleEnquiries,
  );

  const activeTenantCfg = getActiveTenantConfiguration();
  const rawHomePagesConfig =
    store.homePagesConfig ??
    createDefaultHomePagesConfig(
      now.toISOString(),
      activeTenantCfg.branding.primaryDomain,
    );
  const homePagesConfig: HomePagesConfig = {
    ...rawHomePagesConfig,
    firmSettings: {
      ...rawHomePagesConfig.firmSettings,
      demoMode: isDemoModeEnabled(),
    },
  };
  const currentUserRoles = resolveEmployeeRoles(user, teams);
  const activeViewingRole = resolveActiveViewingRole(user, homePagesConfig, teams);
  const keyDatesConfig = await getKeyDatesConfig({ ctx: snapshotTenantCtx, userId: user.id });
  const currentUserKeyDatePermissions = resolveKeyDatePermissions(user, {
    config: keyDatesConfig,
    allPeople: people,
    teams,
    rbac: { config: { rbac: rbacConfig } },
  });
  const baseRail = getLeftRailVisibility(activeViewingRole, currentUserRoles, {
    config: { rbac: rbacConfig },
  });
  const leftRailVisibility = {
    ...baseRail,
    keyDates:
      Boolean(keyDatesConfig.enabled) &&
      baseRail.keyDates &&
      currentUserKeyDatePermissions.includes('keydate:view'),
  };

  // Data-layer filtering of key dates from TenantKeyDateRepository for restricted matters & team scoping (R32, R37, S0-15):
  const permittedDiaryTeamIds = new Set(
    resolvePermittedDiaryTeamIds(user, undefined, teams, {
      config: keyDatesConfig,
      allPeople: people,
      teams,
    }),
  );
  const matterByIdForKd = visibleMatterById;
  const canViewKeyDates = currentUserKeyDatePermissions.includes('keydate:view');
  const repoVisibleKeyDates = canViewKeyDates
    ? await keyDateRepo.listAllVisibleKeyDates(snapshotTenantCtx, user.id)
    : [];
  const snapshotKdRbacOptions: ResolvePersonPermissionsOptions = {
    allPeople: people,
    teams,
    tokenRoles: effectiveTokenRoles,
    context: snapshotTenantCtx,
    tokenRolesActorId: user.id,
    config: { rbac: rbacConfig },
    tenantId: snapshotTenantCtx.tenantId,
  };
  const visibleKeyDates: KeyDate[] = repoVisibleKeyDates.filter((kd) => {
    if (!permittedDiaryTeamIds.has(kd.teamId)) return false;
    if (!kd.matterId) return true;
    const m = matterByIdForKd.get(kd.matterId);
    return canViewerAccessMatterKeyDates(m, user.id, user, people, snapshotKdRbacOptions);
  });
  const visibleKeyDateIdSet = new Set(visibleKeyDates.map((kd) => kd.id));
  const repoVisibleNotApplicable = canViewKeyDates
    ? await keyDateRepo.listAllVisibleNotApplicable(snapshotTenantCtx, user.id)
    : [];
  const visibleKeyDateNotApplicable: KeyDateNotApplicable[] = repoVisibleNotApplicable.filter(
    (na) => {
      const m = matterByIdForKd.get(na.matterId);
      return canViewerAccessMatterKeyDates(m, user.id, user, people, snapshotKdRbacOptions);
    },
  );
  const repoReminderStates = canViewKeyDates
    ? await keyDateRepo.listAllReminderStates(snapshotTenantCtx, user.id)
    : [];
  const visibleKeyDateReminderStates: KeyDateReminderState[] = repoReminderStates.filter(
    (rs) => visibleKeyDateIdSet.has(rs.keyDateId),
  );
  const repoCalendarSyncs = canViewKeyDates
    ? await keyDateRepo.listAllVisibleCalendarSyncs(snapshotTenantCtx, user.id)
    : [];
  const visibleKeyDateCalendarSyncs: KeyDateCalendarSync[] = repoCalendarSyncs.filter(
    (cs) => visibleKeyDateIdSet.has(cs.keyDateId),
  );

  // If the current user is a demo user with showsWorkOfId in a non-live demo environment, resolve the underlying filtered employee for personal panels
  const effectiveWorkPerson: Person =
    isNonLiveDemoEnvironment() && user.demo && user.showsWorkOfId
      ? (filteredPeople.find((p) => p.id === user.showsWorkOfId) ??
        filteredCurrentUser)
      : filteredCurrentUser;

  const finance: AppFinanceCapabilities = {
    canViewFirm: currentUserPermissions.includes('finance:view'),
    canViewMatter: currentUserPermissions.includes('finance:view_matter'),
    canCreditControl: currentUserPermissions.includes('finance:credit_control'),
  };

  const pmsSummaryByMatterIdForAttention: Record<string, PmsMatterFinancials> = {};
  if (finance.canViewMatter) {
    const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;
    if (!isCleanEmpty) {
      const visiblePmsLinks = store.pmsLinks.filter(
        (l) => !(l.entityType === 'matter' && hiddenMatterIds.has(l.onesquaredId)),
      );
      const visibleMatterPmsCodes = visiblePmsLinks
        .filter((l) => l.entityType === 'matter')
        .map((l) => l.pmsCode);
      const allMatterFins = await getPmsRepository().getMatterFinanceSummaryRows(
        snapshotTenantCtx,
        visibleMatterPmsCodes,
      );
      const finByMatterCode = new Map(
        allMatterFins.map((f) => [
          f.matter_code,
          f as unknown as PmsMatterFinancials,
        ]),
      );
      for (const link of visiblePmsLinks) {
        if (link.entityType === 'matter') {
          const fin = finByMatterCode.get(link.pmsCode);
          if (fin) pmsSummaryByMatterIdForAttention[link.onesquaredId] = fin;
        }
      }
    }
  }

  const attention = attentionList([...people, ...organisations], store.values, now, {
    userId: effectiveWorkPerson.id,
    tasks: visibleTasks,
    enquiries: visibleEnquiries,
    teams,
    matters: visibleMatters,
    pmsSummaryByMatterId: pmsSummaryByMatterIdForAttention,
    canViewFinance: finance.canViewMatter,
  });
  const primaryRecentIds = await taskRepo.getRecentlyViewedForUser(
    snapshotTenantCtx,
    user.id,
    { includeRestricted: true },
  );
  const rawRecentIds =
    primaryRecentIds.length > 0 || effectiveWorkPerson.id === user.id
      ? primaryRecentIds
      : await taskRepo.getRecentlyViewedForUser(
          snapshotTenantCtx,
          effectiveWorkPerson.id,
          { includeRestricted: true },
        );
  const recentIds = rawRecentIds.filter(
    (id) =>
      !hiddenMatterIds.has(id) &&
      !hiddenTaskIds.has(id) &&
      !hiddenEnquiryIds.has(id) &&
      !hiddenQuoteIds.has(id) &&
      (canViewQuotes || !id.startsWith('QUO-')),
  );
  const [primaryNotifications, effectivePersonNotifications, userNotifPrefs] =
    await Promise.all([
      taskRepo.listNotificationsForUser<NotificationItem>(
        snapshotTenantCtx,
        user.id,
        { includeRestricted: true },
      ),
      effectiveWorkPerson.id !== user.id
        ? taskRepo.listNotificationsForUser<NotificationItem>(
            snapshotTenantCtx,
            effectiveWorkPerson.id,
            { includeRestricted: true },
          )
        : Promise.resolve([]),
      getOutboxRepository().listNotificationPreferencesForUser(
        snapshotTenantCtx,
        user.id,
      ),
    ]);
  const inAppDisabledKinds = new Set(
    userNotifPrefs
      .filter((p) => !p.inAppEnabled)
      .map((p) => p.notificationKind),
  );
  const mergedNotificationsMap = new Map<string, NotificationItem>();
  for (const n of [...primaryNotifications, ...effectivePersonNotifications]) {
    mergedNotificationsMap.set(n.id, n);
  }
  const userNotifications = Array.from(mergedNotificationsMap.values())
    .filter(
      (n) =>
        !inAppDisabledKinds.has(n.kind) &&
        !(
          (n.matterId && hiddenMatterIds.has(n.matterId)) ||
          hiddenMatterIds.has(n.recordId) ||
          hiddenTaskIds.has(n.recordId) ||
          hiddenEnquiryIds.has(n.recordId) ||
          hiddenQuoteIds.has(n.recordId) ||
          (!canViewQuotes && n.recordId.startsWith('QUO-'))
        ),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const taskBadgeCount = countMyUrgentBadgeTasks(visibleTasks, effectiveWorkPerson.id, now);

  const visibleNotes = notes.filter(
    (n) =>
      !hiddenMatterIds.has(n.recordId) &&
      !hiddenTaskIds.has(n.recordId) &&
      !hiddenEnquiryIds.has(n.recordId) &&
      !hiddenQuoteIds.has(n.recordId) &&
      (canViewQuotes ||
        (!n.recordId.startsWith('QUO-') &&
          (n.recordType as string) !== 'quote')),
  );
  // R413: Do not load the firm-wide audit_entries table on every page snapshot;
  // profile pages use listAuditEntriesForRecord and Admin uses listFirmAuditEntriesPage.
  const visibleAudit: AuditEntry[] = options?.includeFirmAudit
    ? (
        await listFirmAuditEntriesPage(user.id, {
          limit: 250,
          tokenRoles: effectiveTokenRoles,
        })
      ).entries
    : [];

  // Derive expired quote display status in-memory only (read path must remain side-effect free).
  for (const q of visibleQuotes) {
    applyQuoteEffectiveLifecycle(q, now, { appendExpiredTimeline: false });
  }

  const canTakeByTaskId: Record<string, boolean> = {};
  for (const t of visibleTasks) {
    canTakeByTaskId[t.id] = canUserTakeTask(
      user.id,
      t,
      teams,
      people,
      store.values,
      currentUserPermissions,
    );
  }

  const canVerifyByKeyDateId: Record<
    string,
    { allowed: boolean; reason?: string }
  > = {};
  for (const kd of visibleKeyDates) {
    canVerifyByKeyDateId[kd.id] = canUserVerifyKeyDate(user, kd, {
      config: keyDatesConfig,
      allPeople: people,
      teams,
    });
  }

  const canReopenByEnquiryId: Record<string, boolean> = {};
  for (const eq of visibleEnquiries) {
    canReopenByEnquiryId[eq.id] =
      currentUserPermissions.includes('enquiry:reopen') &&
      canUserReopenEnquiry(
        user.id,
        eq,
        teams,
        people,
        store.values,
      );
  }

  const appRoleByPersonId: Record<string, AppRole> = {};
  const rolesByPersonId: Record<string, HomeRoleKey[]> = {};
  const permissionsByPersonId: Record<string, PermissionKey[]> = {};
  for (const emp of people) {
    if (!emp.isEmployee || emp.mergedIntoId) continue;
    appRoleByPersonId[emp.id] = resolveUserAppRole(
      emp,
      teams,
      store.values,
      { config: { rbac: rbacConfig } },
    );
    rolesByPersonId[emp.id] = resolveEmployeeRoles(emp, teams);
    permissionsByPersonId[emp.id] = resolvePersonPermissions(emp, {
      allPeople: people,
      teams,
      config: { rbac: rbacConfig },
    });
  }

  const canSignOffCostsByMatterId: Record<string, boolean> = {};
  const signOffEstimateGbpByMatterId: Record<string, number> = {};
  const actorCanSignOffCosts = currentUserPermissions.includes('matter:costs:sign_off');
  for (const m of visibleMatters) {
    canSignOffCostsByMatterId[m.id] =
      actorCanSignOffCosts &&
      canPersonAccessMatter(m, user.id, user, {
        allPeople: people,
        teams,
        config: { rbac: rbacConfig },
      });
    signOffEstimateGbpByMatterId[m.id] = resolveMatterSignOffEstimateGbp(
      store,
      activeTenantCfg,
      m,
    ).estimatedFeeGbp;
  }

  const conflictReviewCfg = activeTenantCfg.conflictReview;
  const riskReviewer = resolveSuggestedConflictReviewer(
    { teams, orgStructure },
    conflictReviewCfg,
    rolesByPersonId,
    employees,
  );
  const practiceManager =
    employees.find(
      (e) =>
        rolesByPersonId[e.id]?.includes('managing_partner') ||
        e.employeeRoleId === 'employee_role.practice_manager',
    ) ?? null;
  const suggestedMatterGovernanceAssignees = {
    riskReviewerId: riskReviewer?.id ?? null,
    practiceManagerId: practiceManager?.id ?? null,
  };

  const firmPrimaryDomain = resolveConfiguredFirmPrimaryDomain();

  return {
    firm: store.firm,
    tenantId: activeTenantCfg.tenantId,
    firmPrimaryDomain,
    enableAiMatterExtraction: Boolean(activeTenantCfg.featureFlags?.enableAiMatterExtraction),
    aiProviderChoice: activeTenantCfg.integrations?.aiProviderChoice ?? 'disabled',
    enableMatterCostsGovernance: Boolean(activeTenantCfg.featureFlags?.enableMatterCostsGovernance),
    enablePmsLiveRateSync: Boolean(activeTenantCfg.featureFlags?.enablePmsLiveRateSync),
    currentUser: filteredCurrentUser,
    currentUserId: user.id,
    currentUserRole,
    currentUserRoles,
    currentUserEmployeePermissions,
    currentUserPermissions,
    currentUserKeyDatePermissions,
    canTakeByTaskId,
    canVerifyByKeyDateId,
    canReopenByEnquiryId,
    canSignOffCostsByMatterId,
    signOffEstimateGbpByMatterId,
    suggestedMatterGovernanceAssignees,
    appRoleByPersonId,
    rolesByPersonId,
    permissionsByPersonId,
    keyDatesConfig,
    keyDates: visibleKeyDates,
    keyDateNotApplicable: visibleKeyDateNotApplicable,
    keyDateReminderStates: visibleKeyDateReminderStates,
    keyDateCalendarSyncs: visibleKeyDateCalendarSyncs,
    rbacConfig,
    orgStructure,
    matterPartyTaxonomy: store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values),
    matterPartyMigrationReport: store.matterPartyMigrationReport,
    employeeSensitiveRecords,
    employeeMigrationReport: dbEmployeeMigrationReport ?? undefined,
    leaverOwnedRecords,
    activeViewingRole,
    leftRailVisibility,
    effectiveWorkPerson,
    homePagesConfig,
    signOffs: visibleSignOffs,
    finance,
    employees,
    lists: store.lists,
    values: store.values,
    customFields: store.customFields,
    people: filteredPeople,
    organisations,
    links: visibleLinks,
    matters: visibleMatters,
    teams,
    tasks: visibleTasks,
    enquiries: visibleEnquiries,
    quotes: visibleQuotes,
    notifications: userNotifications,
    enquirySettings: store.enquirySettings,
    taskSettings: store.taskSettings,
    matterCostsConfig: resolveEffectiveMatterCostsConfig(
      activeTenantCfg,
      store.matterCostsConfig,
      {
        values: store.values,
        clientProfileCode: activeTenantCfg.tenantId,
        displayName: activeTenantCfg.displayName,
        primaryDomain: activeTenantCfg.branding.primaryDomain,
      },
    ),
    workTypesConfig:
      store.workTypesConfig ??
      resolveEffectiveWorkTypesConfig(activeTenantCfg, store.workTypeConfigsOverride ?? null),
    ...(await (async () => {
      const canReadRegisters =
        currentUserPermissions.includes('register:view') ||
        currentUserPermissions.includes('undertaking:manage');
      const dbRegOverride = await getCatalogueRepository().getModuleConfig<RegistersConfiguration>(
        snapshotTenantCtx,
        'registers',
      );
      const effectiveRegistersCfg = mergeRegistersConfigurations(
        activeTenantCfg.registers ?? DEFAULT_REGISTERS_CONFIG,
        dbRegOverride,
      );
      const effectiveRegTypes = resolveEffectiveRegisterTypes(
        activeTenantCfg.registers ?? DEFAULT_REGISTERS_CONFIG,
        dbRegOverride,
      );
      const visibleRegRecords = canReadRegisters
        ? await getRegisterRepository().listVisibleRegisterRecords(snapshotTenantCtx, userId)
        : [];
      return {
        registersConfig: effectiveRegistersCfg,
        registerTypes: effectiveRegTypes,
        registerRecords: visibleRegRecords,
      };
    })()),
    taskBadgeCount,
    notes: visibleNotes,
    audit: visibleAudit,
    mergeHistory,
    searchIndex: [],
    attention,
    recentIds,
  };
}
