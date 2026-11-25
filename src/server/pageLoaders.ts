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
import { redirect } from 'next/navigation';
import {
  DEFAULT_REGISTERS_CONFIG,
  mergeCddConfigurations,
  mergeRegistersConfigurations,
  resolveEffectiveMatterNumberingConfig,
  resolveEffectiveRegisterTypes,
  type CddConfiguration,
  type ClientRateOverrideRecord,
  type MatterNumberingConfig,
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
import { buildLoginRedirectPath } from '@/domain/authReturnTo';
import {
  buildHiddenClientCddSummary,
  type ClientCddCompactSummary,
  type ClientCddSummary,
} from '@/domain/cdd';
import { addDays, addMonths, toIsoDate } from '@/domain/dates';
import { findRecordsOwnedByLeavers } from '@/domain/employment';
import type { EnquiriesQueueTab } from '@/domain/enquiries';
import {
  createDefaultRoleConfigs,
  resolveActiveViewingRole,
  resolveEmployeeRoles,
  resolveHomeRoleDataNeeds,
  type LeftRailVisibility,
} from '@/domain/homeConfig';
import { sanitizePersonForClientPreview } from '@/domain/intakePreview';
import {
  parseAllowListedSort,
  type SortDirection,
} from '@/domain/listNavigationState';
import { systemKeyOf } from '@/domain/lists';
import {
  normaliseConversionConflictWarnings,
} from '@/domain/matterConflicts';
import type { MatterOpeningGateView } from '@/domain/openingGate';
import type { MatterPartyUsageCounts } from '@/domain/matterParties';
import {
  toClientPriorMatterSummary,
  type ClientPriorMatterSummary,
} from '@/domain/matterOpeningRecord';
import type { PmsLinksAdminPageData } from '@/domain/pms';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import { personDisplayName } from '@/domain/names';
import { applyQuoteEffectiveLifecycle } from '@/domain/quotes';
import { mainLinkFor } from '@/domain/searchIndex';
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
  getActiveActorSession,
  getLeftRailVisibility,
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
  buildPmsLinksAdminDataFromSnapshot,
  dedupeById,
  filterPeopleEmploymentForActor,
  findCandidateDuplicatesForRecord,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getKeyDateRepository,
  getKeyDatesConfig,
  getMatterKeyDatesSnapshot,
  getMatterOpeningGateStateRecord,
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
  listClientPriorMattersRecord,
  listClientRateOverridesRecord,
  listFirmAuditEntriesPage,
  listMatterRateOverridesRecord,
  listRegistersWorkspaceDataRecord,
  startOrLoadClientCddRecord,
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
 * Auth-guarded wrapper for `(app)/**` pages (`R716`): redirects to `/login` when
 * no Entra session cookie exists so expired sessions on soft navigation never
 * render a blank page under `(app)/layout.tsx`.
 */
export async function withOptionalPageActor<R>(
  fn: (actor: AuthenticatedActorContext) => Promise<R> | R,
  returnTo?: string,
): Promise<R> {
  if (!getActiveActorSession()) {
    const entraSession = await getEntraSession();
    if (!entraSession) {
      redirect(buildLoginRedirectPath(returnTo));
    }
  }
  return withCachedPageActor(fn);
}

export interface LoaderOptions {
  readonly tenantCtx?: TenantContext | null;
}

export const DEFAULT_LIST_PAGE_SIZE = 100;
export const MAX_LIST_PAGE_NUMBER = 100_000;
export const MAX_LIST_QUERY_LENGTH = 200;
export const LEAVER_HANDOVER_LIMIT = 500;

export interface ListPaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
}

export interface ListQueryOptions extends LoaderOptions {
  readonly page?: number;
  readonly pageSize?: number;
  readonly query?: string;
  readonly sortBy?: string;
  readonly sortDir?: SortDirection;
}

/**
 * Safely parses a URL `page` search parameter into `[1, MAX_LIST_PAGE_NUMBER]`,
 * treating non-numeric, non-finite, or negative inputs as `1` (`R729`).
 */
export function parseListPageParam(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return 1;
  if (trimmed.startsWith('-')) return 1;
  if (trimmed.length > 9) return MAX_LIST_PAGE_NUMBER;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return Math.min(MAX_LIST_PAGE_NUMBER, parsed);
}

/**
 * Safely parses a URL `pageSize` search parameter into `[1, 200]`,
 * defaulting to `DEFAULT_LIST_PAGE_SIZE` (`R729`).
 */
export function parseListPageSizeParam(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_LIST_PAGE_SIZE;
  if (trimmed.length > 6) return 200;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LIST_PAGE_SIZE;
  return Math.max(1, Math.min(200, parsed));
}

function normaliseListPagination(options?: ListQueryOptions): {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
  readonly query: string;
} {
  const rawPage =
    typeof options?.page === 'number' && Number.isFinite(options.page)
      ? Math.floor(options.page)
      : 1;
  const rawSize =
    typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)
      ? Math.floor(options.pageSize)
      : DEFAULT_LIST_PAGE_SIZE;
  const page = Math.max(1, Math.min(MAX_LIST_PAGE_NUMBER, rawPage));
  const pageSize = Math.max(1, Math.min(200, rawSize));
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    query: (options?.query ?? '').trim().slice(0, MAX_LIST_QUERY_LENGTH),
  };
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
  readonly supervisingPartnerByEmployeeId: Record<string, string>;
  readonly demoShowsWorkOfName: string | null;
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

function collectChoiceIdsBySystemKey(
  values: readonly ChoiceValue[],
  listKey: ChoiceValue['listKey'],
  keys: readonly string[],
): string[] {
  const keySet = new Set(keys);
  return values
    .filter(
      (v) =>
        v.listKey === listKey &&
        keySet.has(systemKeyOf(values as ChoiceValue[], v.id) ?? ''),
    )
    .map((v) => v.id);
}

function orderedRelationshipStatusIds(values: readonly ChoiceValue[]): string[] {
  return values
    .filter((v) => v.listKey === 'relationship_status')
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((v) => v.id);
}

/**
 * Slim shell projection for `shell.employees` (`R718`): exposes only the
 * non-sensitive directory/role fields needed by header pickers, drop-downs,
 * and department filters without `dateOfBirth`, `permissionOverrides`,
 * `entraObjectId`, `showsWorkOfId`, `supportsIds`, or `employment`.
 */
export function projectEmployeeForShell(p: Person): Person {
  const projected: Person = {
    id: p.id,
    recordType: 'person',
    recordOwnerId: p.recordOwnerId,
    recordStatusId: p.recordStatusId,
    createdById: p.createdById,
    createdAt: p.createdAt,
    updatedById: p.updatedById,
    updatedAt: p.updatedAt,
    sourceId: p.sourceId,
    lastVerifiedAt: p.lastVerifiedAt,
    tags: [],
    duplicateStatusId: p.duplicateStatusId,
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: p.mergedIntoId,
    lastInteractionAt: p.lastInteractionAt,
    customFields: {},
    titleId: p.titleId,
    firstName: p.firstName,
    middleNames: p.middleNames,
    surname: p.surname,
    preferredName: p.preferredName,
    otherNames: [],
    jobTitle: p.employment?.jobTitle?.trim() || p.jobTitle || '',
    emails: [],
    phones: [],
    preferredContactMethodId: null,
    preferredLanguageId: null,
    addresses: [],
    website: '',
    relationshipOwnerId: null,
    relationshipStatusId: p.relationshipStatusId,
    relationshipStandingId: null,
    relationshipRoleIds: [],
    originId: null,
    firstKnownAt: null,
    engagementLevelId: null,
    interests: '',
    relationshipNotes: '',
    marketingConsentId: null,
    consentRecord: '',
    verificationStatusId: p.verificationStatusId,
    verifiedAt: null,
    verificationMethodId: null,
    verificationReviewerId: null,
    riskReferences: '',
    isEmployee: true,
    employeeRoleId: p.employeeRoleId,
    departmentId: p.employment?.departmentId ?? p.departmentId ?? null,
  };
  if (p.roles && p.roles.length > 0) {
    projected.roles = [...p.roles];
  }
  if (typeof p.demo === 'boolean') {
    projected.demo = p.demo;
  }
  return projected;
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

  const isStaffOrLeaver = (p: Person): boolean => Boolean(p.isEmployee || p.employment);
  const sanitizedNonStaff = loadedPeople.map((p) =>
    isStaffOrLeaver(p)
      ? p
      : sanitizePersonForClientPreview(p, { preserveNonEmployeeDob: true }),
  );
  // Any employee or leaver loaded here was not in filteredStaffPeople (rare edge case); filter safely
  const extraStaffOrLeavers = loadedPeople.filter(isStaffOrLeaver);
  const safeExtraEmployees =
    extraStaffOrLeavers.length > 0
      ? await filterPeopleEmploymentForActor({
          ctx: params.ctx,
          peopleToFilter: extraStaffOrLeavers,
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
      ...sanitizedNonStaff.filter((p) => !isStaffOrLeaver(p)),
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
    buildDefaultOrgStructure({ legalName: activeTenantCfg.displayName });

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
  const attachSelfContextFields = (filtered: Person, raw: Person): Person => ({
    ...filtered,
    ...(raw.supportsIds && raw.supportsIds.length > 0
      ? { supportsIds: [...raw.supportsIds] }
      : {}),
    ...(raw.roles && raw.roles.length > 0 ? { roles: [...raw.roles] } : {}),
  });
  const baseCurrentUser =
    filteredStaffPeople.find((p) => p.id === rawUser.id) ??
    sanitizePersonForClientPreview(rawUser);
  const filteredCurrentUser = attachSelfContextFields(baseCurrentUser, rawUser);
  const rawEffectiveWorkPerson =
    isNonLiveDemoEnvironment() && rawUser.demo && rawUser.showsWorkOfId
      ? (staffPeopleRaw.find((p) => p.id === rawUser.showsWorkOfId) ?? rawUser)
      : rawUser;
  const baseEffectiveWorkPerson =
    filteredStaffPeople.find((p) => p.id === rawEffectiveWorkPerson.id) ??
    filteredCurrentUser;
  const effectiveWorkPerson: Person = attachSelfContextFields(
    baseEffectiveWorkPerson,
    rawEffectiveWorkPerson,
  );
  const demoShowsWorkOfName =
    homePagesConfig.firmSettings.demoMode &&
    isNonLiveDemoEnvironment() &&
    rawUser.demo &&
    rawUser.showsWorkOfId
      ? personDisplayName(effectiveWorkPerson)
      : null;

  const activeEmps = activeEmployees(staffPeopleRaw, store.values);
  const canPopulateSupervisingPartners = currentUserPermissions.some(
    (p) =>
      p === 'matter:create' ||
      p === 'matter:edit' ||
      p === 'enquiry:create' ||
      p === 'enquiry:edit' ||
      p === 'quote:edit',
  );
  const supervisingPartnerByEmployeeId: Record<string, string> = {};
  if (canPopulateSupervisingPartners) {
    for (const emp of activeEmps) {
      const supId = emp.employment?.supervisingPartnerId;
      if (supId) {
        supervisingPartnerByEmployeeId[emp.id] = supId;
      }
    }
  }
  const employees = activeEmps.map(projectEmployeeForShell);

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
    supervisingPartnerByEmployeeId,
    demoShowsWorkOfName,
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
  cddQueueRecords: RegisterRecord[];
  canViewCdd: boolean;
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
  const canViewCdd = currentUserPermissions.includes('cdd:view');
  const canBypassEmployeeCddVisibility =
    currentUserPermissions.includes('risk:view') || hasRestrictedMatterAccess;
  const activeRoleCfg =
    shell.homePagesConfig.roles.find((r) => r.key === activeRoleKey) ?? null;
  const needsCddQueueOnHome =
    canViewCdd &&
    Boolean(
      activeRoleCfg &&
        (activeRoleCfg.primaryPanels.includes('aml_and_cdd_queue') ||
          activeRoleCfg.summaryPanels.includes('aml_and_cdd_queue')),
    );
  const roleDataNeeds = resolveHomeRoleDataNeeds(shell.homePagesConfig, activeRoleKey);
  const needsRegistersOnHome = canReadRegisters && roleDataNeeds.needsRegisters;
  const summaryOnlyHomeFinance = !roleDataNeeds.needsFullMatterFinance;

  const [
    matters,
    enquiries,
    tasks,
    signOffs,
    registersBundle,
    cddRecordsRaw,
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
    needsCddQueueOnHome
      ? getRegisterRepository().listVisibleRegisterRecords(ctx, currentUserId, {
          registerTypeKey: 'cdd',
          dueOrInProgressFilter: {
            inProgressStatus: 'in_progress',
            recordedStatus: 'recorded',
            dueBeforeIso: `${toIsoDate(addDays(new Date(), 30))}T23:59:59.999Z`,
          },
          orderBy: 'due_asc',
          hasRestrictedMatterAccess,
          canViewCdd: true,
          canBypassEmployeeCddVisibility,
          limit: 100,
        })
      : Promise.resolve([] as RegisterRecord[]),
    shell.finance.canViewMatter
      ? getMatterFinanceRows(ctx, undefined, { summaryOnly: summaryOnlyHomeFinance })
      : Promise.resolve(null),
    shell.finance.canViewMatter ? getMyFinanceFigures(ctx) : Promise.resolve(null),
    shell.finance.canViewFirm ? getFirmFinance(ctx) : Promise.resolve(null),
  ]);

  const cddQueueRecords = cddRecordsRaw;

  const { people, organisations } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    tasks,
    extraPersonIds: [
      ...signOffs.flatMap((s) => [s.requestedById, s.assignedPartnerId, s.approvedById]),
      ...registersBundle.registerRecords.flatMap((r) => [
        r.ownerId,
        r.assignedApproverId,
        r.createdById,
      ]),
      ...cddQueueRecords.map((r) => r.personId),
    ],
    extraOrgIds: cddQueueRecords.map((r) => r.organisationId),
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
    cddQueueRecords,
    canViewCdd,
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

export type PeopleListTabFilter = 'all' | 'external' | 'enquiry' | 'employee' | 'archived';

export interface PeopleListLoaderOptions extends ListQueryOptions {
  readonly tab?: PeopleListTabFilter;
  readonly roleFilter?: string;
  readonly statusFilter?: string;
  readonly ownerFilter?: string;
}

export type PeopleListSortColumn = 'person' | 'status';

export async function loadPeopleListPageData(
  actorId: string,
  options?: PeopleListLoaderOptions,
): Promise<{
  shell: ShellContextData;
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  enquiries: Enquiry[];
  pagination: ListPaginationMeta;
  filters: {
    readonly tab: PeopleListTabFilter;
    readonly query: string;
    readonly roleFilter: string;
    readonly statusFilter: string;
    readonly ownerFilter: string;
    readonly sortBy: PeopleListSortColumn | null;
    readonly sortDir: SortDirection | null;
  };
}> {
  const shell = await loadShellContext(actorId, options);
  const partyRepo = getPartyRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const { page, pageSize, offset, query } = normaliseListPagination(options);
  const tab: PeopleListTabFilter = options?.tab ?? 'all';
  const roleFilter = options?.roleFilter?.trim() || 'all';
  const statusFilter = options?.statusFilter?.trim() || 'all';
  const ownerFilter = options?.ownerFilter?.trim() || 'all';
  const parsedSort = parseAllowListedSort<PeopleListSortColumn>(
    options?.sortBy,
    options?.sortDir,
    ['person', 'status'],
  );
  const inactiveStatusIds = collectStatusIdsBySystemKey(shell.values, [
    'archived',
    'deceased',
    'merged',
    'dissolved',
  ]);
  const statusSortIds =
    parsedSort?.columnId === 'status'
      ? orderedRelationshipStatusIds(shell.values)
      : undefined;
  const isEnquiryOnlyView =
    tab === 'enquiry' || statusFilter === 'enquiry_stage';

  let rawPeople: Person[] = [];
  let enquiries: Enquiry[] = [];
  let totalCount = 0;
  let effectivePage = page;

  if (isEnquiryOnlyView) {
    const enqRes = await intakeRepo.listVisibleEnquiriesPageWithCount<Enquiry>(
      shell.ctx,
      shell.currentUserId,
      {
        openOnly: true,
        query,
        hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
        canViewQuotes: shell.canViewQuotes,
        limit: pageSize,
        offset,
      },
    );
    enquiries = enqRes.items;
    totalCount = enqRes.totalCount;
    effectivePage = enqRes.effectivePage;
  } else {
    const shouldIncludeSampleEnquiries =
      (tab === 'all' || tab === 'external') &&
      page === 1 &&
      statusFilter === 'all' &&
      roleFilter === 'all' &&
      ownerFilter === 'all';
    const [peopleRes, openEnqs] = await Promise.all([
      partyRepo.listPeoplePageWithCount<Person>(shell.ctx, {
        includeMerged: false,
        employeesOnly: tab === 'employee',
        nonEmployeesOnly: tab === 'external',
        archivedOnly: tab === 'archived',
        inactiveStatusIds,
        excludeInactiveStatusIds:
          tab === 'archived' ? [] : inactiveStatusIds,
        relationshipRoleId: roleFilter !== 'all' ? roleFilter : undefined,
        relationshipStatusId:
          statusFilter !== 'all' ? statusFilter : undefined,
        relationshipOwnerId: ownerFilter !== 'all' ? ownerFilter : undefined,
        query,
        sortBy: parsedSort?.columnId,
        sortDir: parsedSort?.direction,
        statusSortIds,
        limit: pageSize,
        offset,
      }),
      shouldIncludeSampleEnquiries
        ? intakeRepo.listVisibleEnquiries<Enquiry>(
            shell.ctx,
            shell.currentUserId,
            {
              openOnly: true,
              query,
              hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
              canViewQuotes: shell.canViewQuotes,
              limit: 50,
            },
          )
        : Promise.resolve<Enquiry[]>([]),
    ]);
    rawPeople = peopleRes.items;
    totalCount = peopleRes.totalCount;
    effectivePage = peopleRes.effectivePage;
    enquiries = openEnqs;
  }

  const filteredStaffById = new Map(shell.filteredStaffPeople.map((p) => [p.id, p]));
  const people = rawPeople.map((p) =>
    p.isEmployee || p.employment
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

  return {
    shell,
    people,
    organisations,
    links,
    enquiries,
    pagination: { page: effectivePage, pageSize, totalCount },
    filters: {
      tab,
      query,
      roleFilter,
      statusFilter,
      ownerFilter,
      sortBy: parsedSort?.columnId ?? null,
      sortDir: parsedSort?.direction ?? null,
    },
  };
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
      cddSummary: ClientCddSummary;
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

  const isEmployeeOrLeaver = Boolean(rawPerson.isEmployee || rawPerson.employment);
  const filteredPersonList = isEmployeeOrLeaver
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
  const canViewCdd = shell.currentUserPermissions.includes('cdd:view');

  const [
    links,
    notes,
    merges,
    directMatters,
    tasks,
    enquiries,
    autoMatchesRaw,
    explicitMatchesRaw,
    audit,
    rateBundle,
    ownedPeopleRaw,
    ownedOrgs,
    cddRes,
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
        ownerPersonId: isEmployeeOrLeaver ? person.id : undefined,
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
    isEmployeeOrLeaver
      ? partyRepo.listPeopleOwnedByPerson<Person>(ctx, person.id)
      : Promise.resolve<Person[]>([]),
    isEmployeeOrLeaver
      ? partyRepo.listOrganisationsOwnedByPerson<Organisation>(ctx, person.id)
      : Promise.resolve<Organisation[]>([]),
    canViewCdd
      ? startOrLoadClientCddRecord(
          {
            subjectType: 'person',
            subjectId: person.id,
            createIfMissing: false,
          },
          currentUserId,
          { tenantCtx: ctx, tenantConfig: shell.activeTenantCfg },
        )
      : Promise.resolve(null),
  ]);
  const cddSummary: ClientCddSummary =
    cddRes && !isActionDenied(cddRes) && cddRes.ok
      ? cddRes.summary
      : buildHiddenClientCddSummary('person', person.id);

  const mainLink = mainLinkFor(person.id, links);
  const mainOrgMatters = mainLink?.organisationId
    ? await matterRepo.listVisibleMattersForEntity<Matter>(
        ctx,
        { clientIds: [mainLink.organisationId], includeMerged: false },
        { viewerId: currentUserId, hasRestrictedMatterAccess },
      )
    : [];
  const matters = dedupeById([...directMatters, ...mainOrgMatters]);

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

  const extraOrgIds = [
    ...(pmsView?.link?.entityType === 'organisation' && pmsView.link.onesquaredId
      ? [pmsView.link.onesquaredId]
      : []),
    ...(mainLink?.organisationId ? [mainLink.organisationId] : []),
  ];
  const filteredStaffById = new Map(shell.filteredStaffPeople.map((p) => [p.id, p]));
  const safeOwnedPeople = ownedPeopleRaw.map((p) =>
    p.isEmployee || p.employment
      ? (filteredStaffById.get(p.id) ?? sanitizePersonForClientPreview(p))
      : sanitizePersonForClientPreview(p, { preserveNonEmployeeDob: true }),
  );
  const { people: referencedPeople, organisations: referencedOrgs } = await collectReferencedParties({
    ctx,
    shell,
    matters,
    enquiries,
    tasks,
    links,
    extraPersonIds: [person.id, ...duplicateCandidates.map((p) => p.id)],
    extraOrgIds,
  });
  const allPeople = dedupeById([person, ...referencedPeople, ...safeOwnedPeople]);
  const organisations = dedupeById([...referencedOrgs, ...ownedOrgs]);

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
    cddSummary,
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
      ownedPeople: Person[];
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
      ownedPeople: [],
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

  const isEmployeeOrLeaver = Boolean(rawPerson.isEmployee || rawPerson.employment);
  const filteredPersonList = isEmployeeOrLeaver
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
  const canViewEmploymentAndHandover = Boolean(existing.employment);

  const [links, ownedPeopleRaw, ownedOrgs, ownedMatters, ownedTasks, ownedEnquiries] =
    await Promise.all([
      partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, { personIds: [existing.id] }),
      canViewEmploymentAndHandover
        ? partyRepo.listPeopleOwnedByPerson<Person>(ctx, existing.id)
        : Promise.resolve<Person[]>([]),
      canViewEmploymentAndHandover
        ? partyRepo.listOrganisationsOwnedByPerson<Organisation>(ctx, existing.id)
        : Promise.resolve<Organisation[]>([]),
      matterRepo.listVisibleMattersForEntity<Matter>(
        ctx,
        {
          clientIds: [existing.id],
          partyEntityIds: [existing.id],
          contactIds: [existing.id],
          ...(canViewEmploymentAndHandover ? { ownerPersonId: existing.id } : {}),
        },
        { viewerId: currentUserId, hasRestrictedMatterAccess },
      ),
      canViewEmploymentAndHandover
        ? taskRepo.listVisibleTasks<Task>(ctx, currentUserId, {
            assignedPersonIdOrMulti: existing.id,
            hasRestrictedMatterAccess,
            limit: LEAVER_HANDOVER_LIMIT,
          })
        : Promise.resolve<Task[]>([]),
      canViewEmploymentAndHandover
        ? intakeRepo.listVisibleEnquiries<Enquiry>(ctx, currentUserId, {
            assignedToId: existing.id,
            hasRestrictedMatterAccess,
            limit: LEAVER_HANDOVER_LIMIT,
          })
        : Promise.resolve<Enquiry[]>([]),
    ]);

  const linkedOrgIds = links.map((l) => l.organisationId).filter(Boolean);
  const linkedOrgs =
    linkedOrgIds.length > 0
      ? await partyRepo.listOrganisationsByIds<Organisation>(ctx, linkedOrgIds)
      : [];
  const organisations = dedupeById([...linkedOrgs, ...ownedOrgs]);
  const filteredStaffById = new Map(shell.filteredStaffPeople.map((p) => [p.id, p]));
  const ownedPeople = canViewEmploymentAndHandover
    ? ownedPeopleRaw.map((p) =>
        p.isEmployee || p.employment
          ? (filteredStaffById.get(p.id) ?? sanitizePersonForClientPreview(p))
          : sanitizePersonForClientPreview(p, { preserveNonEmployeeDob: true }),
      )
    : [];
  // Precompute handover records across all 5 types for both saved leavers and active
  // employees whose employment status may be switched to 'Leaver' during editing (R703, R712).
  const simulatedLeaverTarget: Person = {
    ...existing,
    employment: {
      ...(existing.employment ?? ({} as Person['employment'] & object)),
      status: 'Leaver',
    } as NonNullable<Person['employment']>,
  };
  const leaverOwnedRecords = canViewEmploymentAndHandover
    ? findRecordsOwnedByLeavers(
        [simulatedLeaverTarget, ...ownedPeople],
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
    ownedPeople,
    organisations,
    matters: ownedMatters,
    enquiries: ownedEnquiries,
    leaverOwnedRecords,
  };
}

// ============================================================================
// Route 6-9: Organisations
// ============================================================================

export type OrganisationsListTabFilter =
  | 'all'
  | 'clients'
  | 'prospects'
  | 'referrers'
  | 'archived';

export interface OrganisationsListLoaderOptions extends ListQueryOptions {
  readonly tab?: OrganisationsListTabFilter;
  readonly typeFilter?: string;
  readonly statusFilter?: string;
  readonly orgTypeFilter?: string;
  readonly sectorFilter?: string;
  readonly ownerFilter?: string;
}

export type OrganisationsListSortColumn = 'organisation' | 'status';

export async function loadOrganisationsListPageData(
  actorId: string,
  options?: OrganisationsListLoaderOptions,
): Promise<{
  shell: ShellContextData;
  organisations: Organisation[];
  people: Person[];
  links: PersonOrganisationLink[];
  matters: Matter[];
  activeMatterCountsByOrgId: Record<string, number>;
  pagination: ListPaginationMeta;
  filters: {
    readonly tab: OrganisationsListTabFilter;
    readonly query: string;
    readonly typeFilter: string;
    readonly statusFilter: string;
    readonly orgTypeFilter: string;
    readonly sectorFilter: string;
    readonly ownerFilter: string;
    readonly sortBy: OrganisationsListSortColumn | null;
    readonly sortDir: SortDirection | null;
  };
}> {
  const shell = await loadShellContext(actorId, options);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const { pageSize, offset, query } = normaliseListPagination(options);
  const tab: OrganisationsListTabFilter = options?.tab ?? 'all';
  const typeFilter = options?.typeFilter?.trim() || 'all';
  const statusFilter = options?.statusFilter?.trim() || 'all';
  const orgTypeFilter = options?.orgTypeFilter?.trim() || 'all';
  const sectorFilter = options?.sectorFilter?.trim() || 'all';
  const ownerFilter = options?.ownerFilter?.trim() || 'all';
  const parsedSort = parseAllowListedSort<OrganisationsListSortColumn>(
    options?.sortBy,
    options?.sortDir,
    ['organisation', 'status'],
  );

  const inactiveStatusIds = collectStatusIdsBySystemKey(shell.values, [
    'archived',
    'deceased',
    'merged',
    'dissolved',
  ]);
  // R727 & R732: Resolve by stable ChoiceValue.systemKey rather than display labels.
  // Clients tab matches client/former_client relationship types only (not generic active relationship status).
  const clientRelTypeIds = collectChoiceIdsBySystemKey(
    shell.values,
    'organisation_relationship_type',
    ['client', 'former_client'],
  );
  const clientStatusIds: string[] = [];
  const prospectRelTypeIds = collectChoiceIdsBySystemKey(
    shell.values,
    'organisation_relationship_type',
    ['prospect'],
  );
  const prospectStatusIds = collectChoiceIdsBySystemKey(
    shell.values,
    'relationship_status',
    ['prospective'],
  );
  const closedMatterStatusIds = collectChoiceIdsBySystemKey(
    shell.values,
    'matter_status',
    ['closed', 'archived'],
  );
  const statusSortIds =
    parsedSort?.columnId === 'status'
      ? orderedRelationshipStatusIds(shell.values)
      : undefined;

  const tabFilter =
    tab === 'clients' || tab === 'prospects' || tab === 'referrers'
      ? {
          mode: tab,
          clientRelTypeIds,
          clientStatusIds,
          prospectRelTypeIds,
          prospectStatusIds,
        }
      : undefined;

  const orgRes = await partyRepo.listOrganisationsPageWithCount<Organisation>(
    shell.ctx,
    {
      includeMerged: false,
      archivedOnly: tab === 'archived',
      inactiveStatusIds,
      excludeInactiveStatusIds:
        tab === 'archived' ? [] : inactiveStatusIds,
      relationshipTypeId: typeFilter !== 'all' ? typeFilter : undefined,
      relationshipStatusId:
        statusFilter !== 'all' ? statusFilter : undefined,
      organisationTypeId: orgTypeFilter !== 'all' ? orgTypeFilter : undefined,
      sectorId: sectorFilter !== 'all' ? sectorFilter : undefined,
      relationshipPartnerId: ownerFilter !== 'all' ? ownerFilter : undefined,
      tabFilter,
      query,
      sortBy: parsedSort?.columnId,
      sortDir: parsedSort?.direction,
      statusSortIds,
      limit: pageSize,
      offset,
    },
  );
  const organisations = orgRes.items;
  const orgIds = organisations.map((o) => o.id);

  const [links, activeMatterCountsByOrgId] = await Promise.all([
    orgIds.length > 0
      ? partyRepo.listLinksForEntities<PersonOrganisationLink>(shell.ctx, {
          organisationIds: orgIds,
        })
      : Promise.resolve<PersonOrganisationLink[]>([]),
    orgIds.length > 0
      ? matterRepo.countVisibleActiveMattersByOrgIds(shell.ctx, orgIds, {
          viewerId: shell.currentUserId,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
          closedStatusIds: closedMatterStatusIds,
        })
      : Promise.resolve<Record<string, number>>({}),
  ]);
  const { people } = await collectReferencedParties({
    ctx: shell.ctx,
    shell,
    links,
    extraPersonIds: organisations.flatMap((o) => [
      o.relationshipPartnerId,
      o.recordOwnerId,
    ]),
  });

  return {
    shell,
    organisations,
    people,
    links,
    matters: [],
    activeMatterCountsByOrgId,
    pagination: {
      page: orgRes.effectivePage,
      pageSize,
      totalCount: orgRes.totalCount,
    },
    filters: {
      tab,
      query,
      typeFilter,
      statusFilter,
      orgTypeFilter,
      sectorFilter,
      ownerFilter,
      sortBy: parsedSort?.columnId ?? null,
      sortDir: parsedSort?.direction ?? null,
    },
  };
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
      cddSummary: ClientCddSummary;
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
  const canViewCdd = shell.currentUserPermissions.includes('cdd:view');

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
    cddRes,
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
    canViewCdd
      ? startOrLoadClientCddRecord(
          {
            subjectType: 'organisation',
            subjectId: organisation.id,
            createIfMissing: false,
          },
          currentUserId,
          { tenantCtx: ctx, tenantConfig: shell.activeTenantCfg },
        )
      : Promise.resolve(null),
  ]);
  const cddSummary: ClientCddSummary =
    cddRes && !isActionDenied(cddRes) && cddRes.ok
      ? cddRes.summary
      : buildHiddenClientCddSummary('organisation', organisation.id);

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
    cddSummary,
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

export type MattersListTabFilter =
  | 'all'
  | 'mine'
  | 'Transactional'
  | 'Contentious'
  | 'Advisory';

export interface MattersListLoaderOptions extends ListQueryOptions {
  readonly tab?: MattersListTabFilter;
  readonly practiceAreaId?: string;
  readonly statusFilter?: string;
  readonly feeEarnerFilter?: string;
  readonly billingBasisFilter?: string;
}

export type MattersListSortColumn = 'matter' | 'status' | 'openedAt';

const MATTER_STATUS_SORT_SYSTEM_KEYS = [
  'cmi_incomplete',
  'active',
  'prospective',
  'on_hold',
  'completed',
  'closed',
  'archived',
  'aborted',
] as const;

export async function loadMattersListPageData(
  actorId: string,
  options?: MattersListLoaderOptions,
): Promise<{
  shell: ShellContextData;
  matters: Matter[];
  people: Person[];
  organisations: Organisation[];
  tasks: Task[];
  matterFinance?: MatterFinanceRowsResult;
  pagination: ListPaginationMeta;
  filters: {
    readonly tab: MattersListTabFilter;
    readonly query: string;
    readonly practiceAreaId: string;
    readonly statusFilter: string;
    readonly feeEarnerFilter: string;
    readonly billingBasisFilter: string;
    readonly sortBy: MattersListSortColumn | null;
    readonly sortDir: SortDirection | null;
  };
}> {
  const shell = await loadShellContext(actorId, options);
  const matterRepo = getMatterRepository();
  const taskRepo = getTaskWorkflowRepository();
  const { pageSize, offset, query } = normaliseListPagination(options);
  const tab: MattersListTabFilter = options?.tab ?? 'all';
  const practiceAreaId = options?.practiceAreaId?.trim() || 'all';
  const statusFilter = options?.statusFilter?.trim() || 'all';
  const feeEarnerFilter = options?.feeEarnerFilter?.trim() || 'all';
  const billingBasisFilter = options?.billingBasisFilter?.trim() || 'all';
  const parsedSort = parseAllowListedSort<MattersListSortColumn>(
    options?.sortBy,
    options?.sortDir,
    ['matter', 'status', 'openedAt'],
  );

  // R727: Resolve CMI-incomplete & status sort rank order via stable systemKey.
  const cmiIncompleteStatusIds = collectChoiceIdsBySystemKey(
    shell.values,
    'matter_status',
    ['cmi_incomplete'],
  );
  const statusSortIds =
    parsedSort?.columnId === 'status'
      ? MATTER_STATUS_SORT_SYSTEM_KEYS.flatMap((key) =>
          collectChoiceIdsBySystemKey(shell.values, 'matter_status', [key]),
        )
      : undefined;
  const cleanMatterQuery = query.toLowerCase();
  const matchingPracticeAreaIds = cleanMatterQuery
    ? shell.values
        .filter(
          (v) =>
            v.listKey === 'work_type' &&
            !v.parentId &&
            v.label.toLowerCase().includes(cleanMatterQuery),
        )
        .map((v) => v.id)
    : [];
  const matchingWorkTypeIds = cleanMatterQuery
    ? shell.values
        .filter(
          (v) =>
            v.listKey === 'work_type' &&
            Boolean(v.parentId) &&
            v.label.toLowerCase().includes(cleanMatterQuery),
        )
        .map((v) => v.id)
    : [];

  const pageRes = await matterRepo.listVisibleMattersPageWithCount<Matter>(
    shell.ctx,
    {
      viewerId: shell.currentUserId,
      hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
      includeMerged: false,
      sortOrder: 'id_asc',
      sortBy: parsedSort?.columnId,
      sortDir: parsedSort?.direction,
      statusSortIds,
      limit: pageSize,
      offset,
      query,
      matchingPracticeAreaIds,
      matchingWorkTypeIds,
      mineOnly: tab === 'mine',
      typeBadge:
        tab === 'Transactional' || tab === 'Contentious' || tab === 'Advisory'
          ? tab
          : undefined,
      practiceAreaId: practiceAreaId !== 'all' ? practiceAreaId : undefined,
      statusId: statusFilter !== 'all' ? statusFilter : undefined,
      cmiIncompleteStatusIds,
      leadFeeEarnerId:
        feeEarnerFilter !== 'all' ? feeEarnerFilter : undefined,
      billingBasisId:
        billingBasisFilter !== 'all' ? billingBasisFilter : undefined,
    },
  );
  const matters = pageRes.items;
  const matterIds = matters.map((m) => m.id);
  const [tasks, matterFinanceRes] = await Promise.all([
    matterIds.length > 0
      ? taskRepo.listVisibleTasks<Task>(shell.ctx, shell.currentUserId, {
          linkedRecordIds: matterIds,
          openOnly: true,
          hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
        })
      : Promise.resolve<Task[]>([]),
    matterIds.length > 0 && shell.finance.canViewMatter
      ? getMatterFinanceRows(shell.ctx, matterIds, { summaryOnly: true })
      : Promise.resolve(null),
  ]);
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
    pagination: {
      page: pageRes.effectivePage,
      pageSize,
      totalCount: pageRes.totalCount,
    },
    filters: {
      tab,
      query,
      practiceAreaId,
      statusFilter,
      feeEarnerFilter,
      billingBasisFilter,
      sortBy: parsedSort?.columnId ?? null,
      sortDir: parsedSort?.direction ?? null,
    },
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
      clientMatters: ClientPriorMatterSummary[];
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
      openingGateState?: MatterOpeningGateView;
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
    const initialClientIds = resolveInitialMatterClientIds({
      existingMatter: matter,
      initialQuote,
      initialEnquiry,
    });
    const [links, clientMattersRaw] = await Promise.all([
      clientIdsForLinks.length > 0
        ? partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
            organisationIds: clientIdsForLinks.filter((x) => x.startsWith('O-')),
            personIds: clientIdsForLinks.filter((x) => x.startsWith('P-')),
          })
        : Promise.resolve<PersonOrganisationLink[]>([]),
      initialClientIds.length > 0
        ? matterRepo.listVisibleMattersForEntity<Matter>(
            ctx,
            { clientIds: initialClientIds, includeMerged: false },
            { viewerId: currentUserId, hasRestrictedMatterAccess },
          )
        : Promise.resolve<Matter[]>([]),
    ]);
    const clientMatters = clientMattersRaw.map(toClientPriorMatterSummary);
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
      clientMatters,
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
    openingGateRes,
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
    getMatterOpeningGateStateRecord(matter.id, currentUserId),
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

  const openingGateState: MatterOpeningGateView | undefined =
    openingGateRes && !isActionDenied(openingGateRes) && openingGateRes.ok
      ? {
          evaluation: openingGateRes.evaluation,
          isProspective: openingGateRes.isProspective,
          highRiskRecord: openingGateRes.highRiskRecord,
          canOverridePermission: openingGateRes.canOverridePermission,
          canEditMatter: openingGateRes.canEditMatter,
        }
      : undefined;

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
    extraPersonIds: [
      ...notes.map((n) => n.authorId),
      openingGateState?.evaluation.highRisk.partnerApproverId,
    ],
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
    openingGateState,
    pmsView:
      pmsViewRes && !isActionDenied(pmsViewRes) ? pmsViewRes : undefined,
    canTakeByTaskId,
  };
}

function resolveInitialMatterClientIds(params: {
  readonly existingMatter?: Matter | null;
  readonly clientId?: string | null;
  readonly initialQuote?: Quote | null;
  readonly initialEnquiry?: Enquiry | null;
}): string[] {
  const { existingMatter, clientId, initialQuote, initialEnquiry } = params;
  if (existingMatter?.clientId) {
    const extraFromProp = existingMatter.additionalClientIds ?? [];
    const extraFromFields =
      (existingMatter.fieldValues?.['additionalClientIds'] as string[] | undefined) ?? [];
    return Array.from(
      new Set(
        [existingMatter.clientId, ...extraFromProp, ...extraFromFields].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    );
  }
  if (clientId) return [clientId];
  if (initialQuote?.linkedOrganisationId) return [initialQuote.linkedOrganisationId];
  if (initialQuote?.linkedPersonId) return [initialQuote.linkedPersonId];
  if (initialEnquiry?.linkedOrganisationId) return [initialEnquiry.linkedOrganisationId];
  if (initialEnquiry?.linkedPersonId) return [initialEnquiry.linkedPersonId];
  return [];
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
  clientMatters: ClientPriorMatterSummary[];
  initialCddSummaries: Record<string, ClientCddCompactSummary>;
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
  const initialClientIds = resolveInitialMatterClientIds({
    existingMatter,
    clientId: params.clientId,
    initialQuote: initialQuoteDirect,
    initialEnquiry,
  });
  const [links, clientPriorRes] = await Promise.all([
    orgIdsForLinks.length > 0
      ? partyRepo.listLinksForEntities<PersonOrganisationLink>(ctx, {
          organisationIds: orgIdsForLinks,
        })
      : Promise.resolve<PersonOrganisationLink[]>([]),
    initialClientIds.length > 0
      ? listClientPriorMattersRecord(initialClientIds, currentUserId)
      : Promise.resolve<{
          matters: ClientPriorMatterSummary[];
          cddSummaries: Record<string, ClientCddCompactSummary>;
        }>({ matters: [], cddSummaries: {} }),
  ]);
  const clientMatters = !isActionDenied(clientPriorRes) ? clientPriorRes.matters : [];
  const initialCddSummaries =
    !isActionDenied(clientPriorRes) ? clientPriorRes.cddSummaries : {};
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
    clientMatters,
    initialCddSummaries,
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

export interface EnquiriesListLoaderOptions extends ListQueryOptions {
  readonly tab?: EnquiriesQueueTab | 'all';
  readonly typeFilter?: 'all' | 'enquiry' | 'quote';
  readonly urgencyFilter?: string;
  readonly statusFilter?: string;
  readonly practiceAreaFilter?: string;
  readonly teamFilter?: string;
  readonly channelFilter?: string;
  readonly feeBasisFilter?: string;
  readonly feeEarnerFilter?: string;
  readonly validUntilFrom?: string;
  readonly validUntilTo?: string;
  readonly followUpDueFilter?: 'all' | 'overdue' | 'today' | 'this_week';
}

export type EnquiriesListSortColumn = 'urgency' | 'status' | 'receivedAt';

export async function loadEnquiriesListPageData(
  actorId: string,
  options?: EnquiriesListLoaderOptions,
): Promise<{
  shell: ShellContextData;
  enquiries: Enquiry[];
  quotes: Quote[];
  orderedQueueItems: ReadonlyArray<{
    readonly kind: 'enquiry' | 'quote';
    readonly id: string;
  }>;
  tasks: Task[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  pagination: ListPaginationMeta;
  enquiriesPagination: ListPaginationMeta;
  quotesPagination: ListPaginationMeta;
  filters: {
    readonly tab: EnquiriesQueueTab;
    readonly query: string;
    readonly typeFilter: 'all' | 'enquiry' | 'quote';
    readonly urgencyFilter: string;
    readonly statusFilter: string;
    readonly practiceAreaFilter: string;
    readonly teamFilter: string;
    readonly channelFilter: string;
    readonly feeBasisFilter: string;
    readonly feeEarnerFilter: string;
    readonly validUntilFrom: string;
    readonly validUntilTo: string;
    readonly followUpDueFilter: 'all' | 'overdue' | 'today' | 'this_week';
    readonly sortBy: EnquiriesListSortColumn | null;
    readonly sortDir: SortDirection | null;
  };
}> {
  const shell = await loadShellContext(actorId, options);
  const { ctx, currentUserId, hasRestrictedMatterAccess } = shell;
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const matterRepo = getMatterRepository();
  const { pageSize, offset, query } = normaliseListPagination(options);

  const requestedTab = options?.tab ?? 'all';
  const uiTab: EnquiriesQueueTab = requestedTab === 'all' ? 'open' : requestedTab;
  const typeFilter: 'all' | 'enquiry' | 'quote' =
    options?.typeFilter ?? 'all';
  const urgencyFilter = options?.urgencyFilter?.trim() || 'all';
  const statusFilter = options?.statusFilter?.trim() || 'all';
  const practiceAreaFilter = options?.practiceAreaFilter?.trim() || 'all';
  const teamFilter = options?.teamFilter?.trim() || 'all';
  const channelFilter = options?.channelFilter?.trim() || 'all';
  const feeBasisFilter = options?.feeBasisFilter?.trim() || 'all';
  const feeEarnerFilter = options?.feeEarnerFilter?.trim() || 'all';
  const validUntilFrom = options?.validUntilFrom?.trim() || '';
  const validUntilTo = options?.validUntilTo?.trim() || '';
  const followUpDueFilter: 'all' | 'overdue' | 'today' | 'this_week' =
    options?.followUpDueFilter ?? 'all';
  const parsedSort = parseAllowListedSort<EnquiriesListSortColumn>(
    options?.sortBy,
    options?.sortDir,
    ['urgency', 'status', 'receivedAt'],
  );

  const myTeamIds = userTeams(currentUserId, shell.teams).map((t) => t.id);
  const now = new Date();
  const todayYmd = toIsoDate(now);
  const weekEndYmd = toIsoDate(addDays(now, 7));

  const quoteOnlyFilterActive =
    typeFilter === 'quote' ||
    requestedTab === 'open_quotes' ||
    feeBasisFilter !== 'all' ||
    Boolean(validUntilFrom) ||
    Boolean(validUntilTo) ||
    followUpDueFilter !== 'all' ||
    statusFilter.startsWith('quote:');
  const enquiryOnlyFilterActive =
    typeFilter === 'enquiry' || statusFilter.startsWith('enquiry:');

  const shouldQueryEnquiries = !quoteOnlyFilterActive;
  const shouldQueryQuotes = shell.canViewQuotes && !enquiryOnlyFilterActive;

  const emergencyUrgencyIds = collectChoiceIdsBySystemKey(
    shell.values,
    'enquiry_urgency',
    ['emergency'],
  );
  const urgentUrgencyIds = collectChoiceIdsBySystemKey(
    shell.values,
    'enquiry_urgency',
    ['urgent'],
  );
  const standardUrgencyIds = collectChoiceIdsBySystemKey(
    shell.values,
    'enquiry_urgency',
    ['standard'],
  );

  const queueRes = await intakeRepo.listVisibleIntakeQueuePageWithCount<
    Enquiry,
    Quote
  >(ctx, currentUserId, {
    includeEnquiries: shouldQueryEnquiries,
    includeQuotes: shouldQueryQuotes,
    hasRestrictedMatterAccess,
    todayYmd,
    emergencyUrgencyIds,
    urgentUrgencyIds,
    standardUrgencyIds,
    sortBy: parsedSort?.columnId,
    sortDir: parsedSort?.direction,
    limit: pageSize,
    offset,
    enquiryOptions: {
      query,
      canViewQuotes: shell.canViewQuotes,
      ...(requestedTab === 'drafts'
        ? { status: 'Draft', createdOrTakenById: currentUserId }
        : requestedTab === 'team'
          ? {
              openOnly: true,
              excludeStatuses: ['Draft'],
              assignedTeamIds: myTeamIds,
              requireAssignedTeam: myTeamIds.length === 0,
            }
          : requestedTab === 'mine'
            ? {
                openOnly: true,
                excludeStatuses: ['Draft'],
                assignedToId: currentUserId,
              }
            : requestedTab === 'open'
              ? { openOnly: true, excludeStatuses: ['Draft'] }
              : requestedTab === 'closed'
                ? {
                    statuses: [
                      'Converted',
                      'Declined',
                      'Referred out',
                      'No response',
                    ],
                  }
                : {}),
      ...(practiceAreaFilter !== 'all' ? { practiceAreaId: practiceAreaFilter } : {}),
      ...(teamFilter !== 'all' ? { assignedTeamId: teamFilter } : {}),
      ...(urgencyFilter !== 'all' ? { urgencyId: urgencyFilter } : {}),
      ...(channelFilter !== 'all' ? { channelId: channelFilter } : {}),
      ...(feeEarnerFilter !== 'all' ? { assignedToId: feeEarnerFilter } : {}),
      ...(statusFilter.startsWith('enquiry:')
        ? { status: statusFilter.slice('enquiry:'.length) }
        : {}),
    },
    quoteOptions: {
      query,
      ...(statusFilter === 'quote:Superseded'
        ? { supersededInHistoryOnly: true }
        : requestedTab === 'drafts'
          ? { status: 'Draft', createdOrPreparedById: currentUserId }
          : requestedTab === 'team'
            ? {
                effectiveOpenTodayYmd: todayYmd,
                assignedTeamIds: myTeamIds,
                requireAssignedTeam: myTeamIds.length === 0,
              }
            : requestedTab === 'mine'
              ? {
                  effectiveOpenTodayYmd: todayYmd,
                  feeEarnerId: currentUserId,
                }
              : requestedTab === 'open' || requestedTab === 'open_quotes'
                ? { effectiveOpenTodayYmd: todayYmd }
                : requestedTab === 'closed'
                  ? { effectiveClosedTodayYmd: todayYmd }
                  : {}),
      ...(practiceAreaFilter !== 'all' ? { practiceAreaId: practiceAreaFilter } : {}),
      ...(teamFilter !== 'all' ? { assignedTeamId: teamFilter } : {}),
      ...(urgencyFilter !== 'all' ? { urgencyId: urgencyFilter } : {}),
      ...(channelFilter !== 'all' ? { channelId: channelFilter } : {}),
      ...(feeBasisFilter !== 'all' ? { feeBasis: feeBasisFilter } : {}),
      ...(feeEarnerFilter !== 'all' ? { feeEarnerId: feeEarnerFilter } : {}),
      ...(validUntilFrom ? { validUntilFrom } : {}),
      ...(validUntilTo ? { validUntilTo } : {}),
      ...(followUpDueFilter !== 'all'
        ? {
            followUpDue: {
              mode: followUpDueFilter,
              todayYmd,
              weekEndYmd,
            },
          }
        : {}),
      ...(statusFilter.startsWith('quote:') &&
      statusFilter !== 'quote:Superseded'
        ? statusFilter === 'quote:Expired'
          ? { effectiveExpiredTodayYmd: todayYmd }
          : { status: statusFilter.slice('quote:'.length) }
        : {}),
    },
  });

  const enquiries = queueRes.enquiries;
  const quotes = queueRes.quotes;
  for (const q of quotes) {
    applyQuoteEffectiveLifecycle(q, now, { appendExpiredTimeline: false });
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

  const effectivePage = queueRes.effectivePage;
  const enquiriesPagination: ListPaginationMeta = {
    page: effectivePage,
    pageSize,
    totalCount: queueRes.enquiriesTotalCount,
  };
  const quotesPagination: ListPaginationMeta = {
    page: effectivePage,
    pageSize,
    totalCount: queueRes.quotesTotalCount,
  };

  return {
    shell,
    enquiries,
    quotes,
    orderedQueueItems: queueRes.orderedQueueItems,
    tasks,
    people,
    organisations,
    matters,
    pagination: {
      page: effectivePage,
      pageSize,
      totalCount: queueRes.totalCount,
    },
    enquiriesPagination,
    quotesPagination,
    filters: {
      tab: uiTab,
      query,
      typeFilter,
      urgencyFilter,
      statusFilter,
      practiceAreaFilter,
      teamFilter,
      channelFilter,
      feeBasisFilter,
      feeEarnerFilter,
      validUntilFrom,
      validUntilTo,
      followUpDueFilter,
      sortBy: parsedSort?.columnId ?? null,
      sortDir: parsedSort?.direction ?? null,
    },
  };
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

export type TasksListTabFilter = 'my' | 'team' | 'created' | 'all';

export interface TasksListLoaderOptions extends ListQueryOptions {
  readonly tab?: TasksListTabFilter;
  readonly statusFilter?: string;
  readonly priorityFilter?: string;
  readonly typeFilter?: string;
  readonly teamFilter?: string;
  readonly recordTypeFilter?: string;
}

export type TasksListSortColumn = 'priority' | 'status' | 'dueAt';

export function formatTenantLocalIsoSeconds(
  date: Date,
  timeZone = 'Europe/London',
): string {
  const cleanTz = timeZone.trim() || 'Europe/London';
  let effectiveTimeZone = 'Europe/London';
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: cleanTz });
    effectiveTimeZone = cleanTz;
  } catch {
    effectiveTimeZone = 'Europe/London';
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: effectiveTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const rawHour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const hour = rawHour === '24' ? '00' : rawHour.padStart(2, '0');
  const minute = (parts.find((p) => p.type === 'minute')?.value ?? '00').padStart(2, '0');
  const second = (parts.find((p) => p.type === 'second')?.value ?? '00').padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export async function loadTasksListPageData(
  actorId: string,
  options?: TasksListLoaderOptions,
): Promise<{
  shell: ShellContextData;
  tasks: Task[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes: Quote[];
  pagination: ListPaginationMeta;
  filters: {
    readonly tab: TasksListTabFilter;
    readonly query: string;
    readonly statusFilter: string;
    readonly priorityFilter: string;
    readonly typeFilter: string;
    readonly teamFilter: string;
    readonly recordTypeFilter: string;
    readonly sortBy: TasksListSortColumn | null;
    readonly sortDir: SortDirection | null;
  };
}> {
  const shell = await loadShellContext(actorId, options);
  const taskRepo = getTaskWorkflowRepository();
  const { pageSize, offset, query } = normaliseListPagination(options);
  const tab: TasksListTabFilter = options?.tab ?? 'all';
  const statusFilter = options?.statusFilter?.trim() || 'open';
  const priorityFilter = options?.priorityFilter?.trim() || 'all';
  const typeFilter = options?.typeFilter?.trim() || 'all';
  const teamFilter = options?.teamFilter?.trim() || 'all';
  const recordTypeFilter = options?.recordTypeFilter?.trim() || 'all';
  const parsedSort = parseAllowListedSort<TasksListSortColumn>(
    options?.sortBy,
    options?.sortDir,
    ['priority', 'status', 'dueAt'],
  );
  const myTeamIds = userTeams(shell.currentUserId, shell.teams).map((t) => t.id);
  const now = new Date();
  const overdueNowUtcIso = now.toISOString();
  const tenantTimeZone = getActiveTenantConfiguration().timeZone || 'Europe/London';
  const overdueNowLocalIso = formatTenantLocalIsoSeconds(now, tenantTimeZone);
  const urgentPriorityIds = collectChoiceIdsBySystemKey(
    shell.values,
    'task_priority',
    ['urgent'],
  );
  const highPriorityIds = collectChoiceIdsBySystemKey(
    shell.values,
    'task_priority',
    ['high'],
  );
  const lowPriorityIds = collectChoiceIdsBySystemKey(
    shell.values,
    'task_priority',
    ['low'],
  );

  const pageRes = await taskRepo.listVisibleTasksPageWithCount<Task>(
    shell.ctx,
    shell.currentUserId,
    {
      hasRestrictedMatterAccess: shell.hasRestrictedMatterAccess,
      statusFilter,
      overdueNowLocalIso,
      overdueNowUtcIso,
      tabFilter:
        tab !== 'all'
          ? { mode: tab, actorId: shell.currentUserId, teamIds: myTeamIds }
          : undefined,
      priorityId: priorityFilter !== 'all' ? priorityFilter : undefined,
      taskTypeId: typeFilter !== 'all' ? typeFilter : undefined,
      assignedTeamId: teamFilter !== 'all' ? teamFilter : undefined,
      recordType: recordTypeFilter !== 'all' ? recordTypeFilter : undefined,
      query,
      sortBy: parsedSort?.columnId,
      sortDir: parsedSort?.direction,
      urgentPriorityIds,
      highPriorityIds,
      lowPriorityIds,
      limit: pageSize,
      offset,
    },
  );
  const tasks = pageRes.items;
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

  return {
    shell,
    tasks,
    people,
    organisations,
    matters,
    enquiries,
    quotes,
    pagination: {
      page: pageRes.effectivePage,
      pageSize,
      totalCount: pageRes.totalCount,
    },
    filters: {
      tab,
      query,
      statusFilter,
      priorityFilter,
      typeFilter,
      teamFilter,
      recordTypeFilter,
      sortBy: parsedSort?.columnId ?? null,
      sortDir: parsedSort?.direction ?? null,
    },
  };
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
  const clientLabelsById: Record<string, string> = {};
  if (!isActionDenied(data) && data.ok) {
    const partyRepo = getPartyRepository();
    const personIds = Array.from(
      new Set(data.records.map((r) => r.personId).filter((x): x is string => Boolean(x))),
    );
    const orgIds = Array.from(
      new Set(
        data.records.map((r) => r.organisationId).filter((x): x is string => Boolean(x)),
      ),
    );
    const [clientPeople, clientOrgs] = await Promise.all([
      personIds.length > 0
        ? partyRepo.listPeopleByIds<Person>(shell.ctx, personIds)
        : Promise.resolve<Person[]>([]),
      orgIds.length > 0
        ? partyRepo.listOrganisationsByIds<Organisation>(shell.ctx, orgIds)
        : Promise.resolve<Organisation[]>([]),
    ]);
    for (const p of clientPeople) {
      clientLabelsById[p.id] = personDisplayName(p);
    }
    for (const o of clientOrgs) {
      clientLabelsById[o.id] = o.legalName;
    }
  }
  return { shell, data, clientLabelsById };
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
      initialPmsLinksData?: PmsLinksAdminPageData;
      expiredUnconvertedEnquiriesCount: number;
      matterPartyUsageCounts: MatterPartyUsageCounts;
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
      cddConfig: CddConfiguration;
      workTypesConfig: WorkTypesConfiguration;
      matterNumberingConfig: MatterNumberingConfig;
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

  const retentionCutoffIso = addMonths(
    new Date(),
    -Math.max(1, Math.floor(shell.store.enquirySettings.retentionMonths || 12)),
  ).toISOString();

  const [
    firmAuditPage,
    pmsAdminResult,
    dbEmployeeMigrationReport,
    registersMeta,
    dbCddOverride,
    dbMatterNumberingOverride,
    expiredUnconvertedEnquiriesCount,
    matterPartyUsageCounts,
  ] = await Promise.all([
    listFirmAuditEntriesPage(actorId, {
      limit: 250,
      ...(Number.isFinite(parsedBeforeSeq) ? { beforeSeq: parsedBeforeSeq } : {}),
    }),
    getPmsAdminSnapshot(ctx),
    getHrAndRbacRepository().getEmployeeMigrationReport<EmployeeMigrationReport>(ctx),
    resolveRegistersSummary(ctx, activeTenantCfg),
    getCatalogueRepository().getModuleConfig<CddConfiguration>(ctx, 'cdd'),
    getCatalogueRepository().getMatterNumberingConfig<MatterNumberingConfig>(ctx),
    getIntakeQuoteRepository().countEnquiriesReadyForRetention(
      ctx,
      retentionCutoffIso,
    ),
    getMatterRepository().getMatterPartyUsageSummary(ctx),
  ]);

  const pmsAdmin = isActionDenied(pmsAdminResult) ? undefined : pmsAdminResult;
  const initialTab: AdminTab =
    first === 'pms-links' && !pmsAdmin ? 'lists' : initialTabWithoutPms;

  let initialPmsLinksData: PmsLinksAdminPageData | undefined;
  if (initialTab === 'pms-links' && pmsAdmin) {
    const pmsDataRes = await buildPmsLinksAdminDataFromSnapshot(
      ctx,
      actorId,
      shell.hasRestrictedMatterAccess,
      pmsAdmin,
      { subTab: 'organisations', query: '', page: 1, pageSize: 50 },
    );
    if (!isActionDenied(pmsDataRes)) {
      initialPmsLinksData = pmsDataRes;
    }
  }

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

  const isLiveEnvironment = activeTenantCfg.environment === 'live';
  const canManageRbacAdmin = shell.currentUserPermissions.some(
    (p) => p === 'rbac:manage_user_overrides' || p === 'rbac:manage_config',
  );
  const rawStaffById = new Map(shell.staffPeopleRaw.map((p) => [p.id, p]));
  const adminPeople = shell.filteredStaffPeople.map((p) => {
    const raw = rawStaffById.get(p.id);
    if (!raw) return p;
    return {
      ...p,
      emails: structuredClone(raw.emails ?? []),
      ...(raw.roles !== undefined ? { roles: [...raw.roles] } : {}),
      ...(!isLiveEnvironment && raw.showsWorkOfId !== undefined
        ? { showsWorkOfId: raw.showsWorkOfId }
        : {}),
      ...(!isLiveEnvironment && raw.supportsIds !== undefined
        ? { supportsIds: [...raw.supportsIds] }
        : {}),
      ...(canManageRbacAdmin
        ? {
            permissionOverrides: raw.permissionOverrides ?? null,
            entraObjectId: raw.entraObjectId ?? null,
          }
        : {}),
    };
  });

  return {
    shell,
    initialTab,
    lists: shell.lists,
    values: shell.values,
    customFields: shell.customFields,
    people: adminPeople,
    organisations: [],
    matters: [],
    enquiries: [],
    teams,
    enquirySettings: shell.store.enquirySettings,
    taskSettings: shell.store.taskSettings,
    pmsAdmin,
    initialPmsLinksData,
    expiredUnconvertedEnquiriesCount,
    matterPartyUsageCounts,
    isLiveEnvironment,
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
    cddConfig: mergeCddConfigurations(activeTenantCfg.cdd, dbCddOverride),
    workTypesConfig: shell.store.workTypesConfig!,
    matterNumberingConfig: resolveEffectiveMatterNumberingConfig(
      activeTenantCfg,
      dbMatterNumberingOverride,
    ),
    entraEnvStatus: getEntraEnvStatus(),
    firmAuditPage,
  };
}
