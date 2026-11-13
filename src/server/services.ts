import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { resolveRequestCorrelationId } from './correlationId';
import { syncMatterLifecycleOnSaveSync } from './documentStoreServices';
import {
  getDocumentRepository,
  getEffectiveTenantConfig,
  repointMergedEntityForTenant,
  resolveTenantContextForStoreUser,
} from './documentGenerationServices';
import {
  guardedJob,
  type GuardedJobOptions,
} from './authorize';
import {
  appendTenantAuditEntries,
  flushStagedAuditEntries,
  getAuditRepository,
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getJobRunRepository,
  getMatterRepository,
  getPartyRepository,
  getPmsRepository,
  getTaskWorkflowRepository,
  runWithAuditStagingScope,
  stageAuditEntry,
  TenantCatalogueRepository,
  TenantJobRunRepository,
  TenantPmsRepository,
  getActiveTenantConfiguration,
  getExtensionHostLoadErrors,
  getPlatformExtensionHost,
  isNonLiveDemoEnvironment,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
export {
  getCatalogueRepository,
  getHrAndRbacRepository,
  getIntakeQuoteRepository,
  getJobRunRepository,
  getMatterRepository,
  getPartyRepository,
  getPmsRepository,
  getTaskWorkflowRepository,
  TenantCatalogueRepository,
  TenantJobRunRepository,
  TenantPmsRepository,
};
import {
  clearMigratedPostgresModulesForTenant,
  computeMatterRestrictionMetadataForStore,
  importFirmStoreModulesToPostgres,
} from './storePostgresImport';
import { attentionList } from '@/domain/attention';
import { buildActionDenied, isActionDenied, type ActionDenied } from '@/domain/actionResult';
import { diffRecords } from '@/domain/audit';
import { validateCustomFields } from '@/domain/customFields';
import {
  addDays,
  addWorkingDays,
  calculateFirstContactDue,
  formatDate,
  formatDateTime,
  toIsoDate,
  type WorkingHoursConfig,
} from '@/domain/dates';
import {
  calculateQuoteTotals,
  evaluateQuoteEffectiveStatus,
  quoteClientDisplayName,
} from '@/domain/quotes';
import {
  buildMatterRiskAssessmentSnapshot,
  conflictStatusPillFromLegacy,
  legacyConflictStatusFromRecord,
  resolveMatterConflictCheckRecord,
  resolveMatterOpeningSnapshot,
  resolveMatterRiskAssessment,
  resolveRiskRatingIdForLevel,
  validateMatterRiskAssessmentInput,
  type CustomKeyDateEntry,
  type MatterRiskAssessmentInput,
} from '@/domain/matterOpeningRecord';
import {
  buildEffectiveConflictParties,
  CONFLICT_SEARCHED_SOURCES,
  hasUnapprovedRestrictedMatches,
  reconcileServerConflictMatches,
  searchMatterConflicts,
  type MatterConflictSearchInput,
} from '@/domain/matterConflicts';
import { findOrganisationDuplicates, findPersonDuplicates } from '@/domain/duplicates';
import {
  computeEnquiryConflictSnapshot,
  enquiryDisplayName,
  getMissingRoutingFields,
  isEnquiryOpen,
  isEnquiryRouted,
  isReadyForRetentionAnonymisation,
  runEnquiryConflictSearch,
  validateEnquiryInput,
} from '@/domain/enquiries';
import type { FormatContext } from '@/domain/fieldRegistry';
import {
  canPreviewAnyHomeRole,
  createDefaultHomePagesConfig,
  createDefaultRoleConfigs,
  resolveActiveViewingRole,
  resolveEmployeeRoles,
  syncHomeRolesWithEmployeeRoles,
} from '@/domain/homeConfig';
import {
  canDeactivate,
  nextSortOrder,
  reorder,
  resolveLabel,
  systemKeyOf,
  valueBySystemKey,
} from '@/domain/lists';
import { isEmployeeOrLeaverRecord, planMerge } from '@/domain/merge';
import { personDisplayName, primaryEmail, recordDisplayName } from '@/domain/names';
import {
  buildClientFinancialsFromRows,
  computeAutomaticPmsLinks,
  findOneSquaredIdForPmsCode,
  findPmsCodeForRecord,
  isValidPmsAsAtDate,
  PMS_AS_AT_UNAVAILABLE_LABEL,
  suggestMatterMatches,
  type PmsSuggestedMatch,
} from '@/domain/pms';
import { buildSearchIndex } from '@/domain/searchIndex';
import {
  applyEffectiveDatedEmploymentHistory,
  applyLeaverEffects,
  computeStaffMatterStatus,
  createDefaultEmploymentRecord,
  emptyDiversityAnswers,
  findOpenMattersWherePersonIsParty,
  findRecordsOwnedByLeavers,
  isLeaverPerson,
  isSelectableInEmployeeDropdown,
  isWorkingAtFirm,
  maskBankDetails,
  maskNationalInsuranceNumber,
  syncPersonWorkContactFlags,
  validateEmploymentRecord,
} from '@/domain/employment';
import {
  buildDefaultOrgStructure,
  mapLegacyEmployeeRoleToRoleType,
  mapRoleTypeToLegacyEmployeeRoleId,
  resolveOrgDepartment,
} from '@/domain/orgStructure';
import {
  buildDefaultMatterPartyTaxonomy,
  computeMatterPartyUsageCounts,
  migrateMatterPartiesToTwoFieldModel,
} from '@/domain/matterParties';
import {
  createDefaultMatterCostsConfig,
  resolveMatterCostsSnapshot,
  syncRateCardsWithPmsFeeEarners,
} from '@/domain/matterCosts';
import {
  countMyUrgentBadgeTasks,
  isTaskOpen,
  resolveRoutedTeam,
} from '@/domain/tasks';
import {
  AuthorisationError,
  canPersonAccessMatter,
  canUserReassignTask,
  canUserReopenEnquiry,
  canUserTakeTask,
  canUserVerifyKeyDate,
  canViewerAccessMatterKeyDates,
  filterEmploymentForUser,
  getActiveActorSession,
  getDefaultTenantRbacConfig,
  getLeftRailVisibility,
  hasEmployeePermission,
  hasKeyDatePermission,
  hasPersonPermission,
  isJobOnlyPermissionKey,
  isRegisteredPermissionKey,
  isUserAssignablePermissionKey,
  mergeRbacConfigOverlay,
  PERMISSION_REGISTRY,
  requirePermission,
  resolveConfiguredFirmPrimaryDomain,
  resolveEmployeePermissions,
  resolveKeyDatePermissions,
  resolvePersonForEntraClaims,
  resolvePersonPermissionSet,
  resolvePersonPermissions,
  resolveUserAppRole,
  runWithActiveActorSession,
  validateUserOverrideOrRoleMutation,
  type EntraIdRawTokenClaims,
  type PermissionKey,
  type RbacConfiguration,
  type VerifiedOidcTokenClaims,
} from './rbacRuntime';
import {
  createVerifiedSessionActorFromEntraSession,
  ENTRA_SESSION_COOKIE,
  getEntraSession,
  getTestEntraSessionOverride,
  persistEntraSessionCookie,
  setTestEntraSessionOverride,
  shouldUseSecureCookies,
  type EntraSessionPayload,
  type VerifiedEntraSessionPayload,
  createSignInActorFromVerifiedOidcToken,
} from './entraAuth';
import {
  executeUsageRetentionPurgeJob,
  getActiveTenantTransactionState,
  loadActiveTenantRegistry,
  MATTER_CONCURRENCY_CONFLICT_CODE,
  MATTER_CONCURRENCY_CONFLICT_MESSAGE,
  runTenantBackgroundJob,
  sanitizeJobErrorCode,
  TenantKeyDateRepository,
  validateKeyDatesConfig,
  validateRbacConfig,
  type ControlledJobRunOutcome,
  type FirmAuditEntryInput,
  type FirmAuditEntryRecord,
  type JobRunRecord,
  type KeyDatesConfiguration,
  type TenantContext,
  type TenantRegistry,
} from '@platform/core';
import type {
  CalculationResult,
  KeyDate,
  KeyDateCalculation,
  KeyDateCalendarSync,
  KeyDateException,
  KeyDateExceptionKind,
  KeyDateNotApplicable,
  KeyDateReminderState,
  KeyDatesConfig,
  KeyDateSource,
  StandstillPeriod,
  TeamDiaryEntry,
  TeamDiaryQuery,
} from '@/domain/keyDates.types';
import {
  carryEnquiryKeyDatesToMatter,
  createOrProposeKeyDate,
  evaluateMatterKeyDateClosureGate,
  evaluateMatterKeyDateOpeningGate,
  proposeProvisionalKeyDate,
  reassignKeyDateTeamAndOwners,
  recordKeyDateNotApplicable,
  rejectProposedKeyDate,
  resolveKeyDateOutcome,
  resolveKeyDateSource,
  resolveSupersedeKeyDateSource,
  supersedeConfirmedKeyDate,
  validateKeyDateManualEntry,
  verifyProposedKeyDate,
} from '@/domain/keyDates';
import {
  calculateLimitationDate,
  findBusinessCalendar,
  findLimitationRule,
} from '@/domain/keyDateCalculator';
import {
  acknowledgeKeyDateReminderStage,
  closeReminderTaskForKeyDate,
  runTenantKeyDateReminderJob,
  syncReminderForConfirmedKeyDate,
} from '@/domain/keyDateReminders';
import {
  computeKeyDateExceptions,
  queryTeamDiaryEntries,
  resolvePermittedDiaryTeamIds,
} from '@/domain/keyDateDiary';
import {
  syncKeyDateToOutlookCalendar,
  type GraphCalendarAdapter,
} from '@/domain/keyDateCalendarSync';
import {
  stripServerOwnedFieldValues,
  type MatterOpeningGateRecord,
  type PartnerCostSignOffRecord,
} from '@/domain/matterFieldValues';
import {
  resolveConflictReviewTaskRouting,
  resolveSuggestedConflictReviewer,
} from './conflictReview';
import {
  isTenantContextInput,
  verifyFinanceActorAndPermission,
  type FinanceActorInput,
} from './financeServices';
import { buildRecordVisibility, EMPTY_HIDDEN_KEY_DATE_IDS } from './visibility';
import type {
  Address,
  AnyRecord,
  AppFinanceCapabilities,
  AppRole,
  AppSnapshot,
  AuditAction,
  AuditEntry,
  AutoTaskTrigger,
  CapacityGroupName,
  ChoiceList,
  ChoiceValue,
  ConflictCheckMatch,
  ConflictCheckParty,
  ConflictCheckRecord,
  ConflictCheckRecordInput,
  ConflictCheckRunAudit,
  ConflictCheckStatusPill,
  ContactLogEntry,
  ContactLogMethod,
  ContactLogOutcome,
  CustomFieldDefinition,
  CustomFieldRecordType,
  CustomFieldType,
  EmployeePermission,
  EmployeeSensitiveRecord,
  EmploymentRecord,
  Enquiry,
  EnquirySentEmailSnapshot,
  EnquirySettings,
  EnquiryStatus,
  FormSection,
  HomeFirmSettings,
  HomePagesConfig,
  HomeRoleKey,
  Matter,
  MatterCostsConfig,
  MatterPartyCapacityDef,
  MatterPartyMigrationReport,
  MatterPartyRelationshipDef,
  MatterPartyTaxonomy,
  MergeHistory,
  OrgStructureCatalogue,
  Note,
  NotificationItem,
  NotificationKind,
  Organisation,
  Person,
  PersonOrganisationLink,
  PmsEntityType,
  PmsLink,
  Quote,
  QuoteDeclineReason,
  QuoteDisbursement,
  QuoteFeeBasis,
  QuoteStatus,
  RecordType,
  RoleHomeConfig,
  SignOffItem,
  Task,
  TaskLinkedRecord,
  TaskSettings,
  TaskStatus,
  Team,
  WorkTypeProfileCode,
} from '@/domain/types';
import { getTenantPmsSource } from '@/pms/pmsSource';
import type {
  PmsClient,
  PmsClientFinancials,
  PmsClientFullBundle,
  PmsExtractInfo,
  PmsFeeEarner,
  PmsMatter,
  PmsMatterFinancials,
  PmsMatterFullBundle,
} from '@/pms/types';
import { DEFAULT_ENQUIRY_SETTINGS, DEFAULT_TASK_SETTINGS } from '@/seed/demo';
import { buildSeedLists, slug, vid } from '@/seed/lists';
import {
  clearStoreToCleanDeployment,
  createCleanDeploymentStore,
  createSeedStore,
  resetStore,
  type FirmStore,
} from './store';

export const USER_COOKIE = 'onesquared_user';

export interface AuthenticatedActorContext {
  personId: string;
  person: Person;
  session: VerifiedEntraSessionPayload;
  mfaVerified: boolean;
  tenantId: string;
  allPeople?: readonly Person[];
  teams?: readonly Team[];
}

export async function requireAuthenticatedActor(): Promise<AuthenticatedActorContext> {
  const activeConfig = getActiveTenantConfiguration();
  const tenantId = activeConfig.tenantId;
  const entraSession = await getEntraSession();
  if (!entraSession || !entraSession.personId || !entraSession.tenantId?.trim()) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required. Please sign in with Microsoft Entra ID.',
      tenantId,
      correlationId: 'auth-check',
      actorUserId: 'anonymous',
    });
  }
  const authCtx = resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(entraSession, {
      correlationId: 'auth-check',
    }),
    activeConfig,
  );
  const [allPeople, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(authCtx),
    getHrAndRbacRepository().listAllTeams<Team>(authCtx),
  ]);
  const loaded = allPeople.find((p) => p.id === entraSession.personId) ?? null;
  const person =
    loaded && loaded.isEmployee && !loaded.mergedIntoId ? loaded : null;
  if (!person) {
    throw new AuthorisationError({
      code: 'UNAUTHENTICATED',
      message: 'Authenticated employee record was not found or is inactive.',
      tenantId,
      correlationId: 'auth-check',
      actorUserId: entraSession.personId,
    });
  }
  const resolvedTenantId = entraSession.tenantId.trim();
  return {
    personId: person.id,
    person,
    session: entraSession,
    mfaVerified: Boolean(entraSession.mfaVerified),
    tenantId: resolvedTenantId,
    allPeople,
    teams,
  };
}

function nextMonotonicIsoTimestamp(previousIso?: string | null): string {
  const nowMs = Date.now();
  const prevMs = previousIso ? Date.parse(previousIso) : NaN;
  if (!Number.isNaN(prevMs) && nowMs <= prevMs) {
    return new Date(prevMs + 1).toISOString();
  }
  return new Date(nowMs).toISOString();
}

function touchMatter(matter: Matter, byId: string): string {
  const nextIso = nextMonotonicIsoTimestamp(matter.updatedAt);
  matter.updatedAt = nextIso;
  matter.updatedById = byId;
  return nextIso;
}

export async function withAuthenticatedActor<R>(
  fn: (actor: AuthenticatedActorContext) => Promise<R> | R,
): Promise<R> {
  const actor = await requireAuthenticatedActor();
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

export const withPageActor = withAuthenticatedActor;

export async function getCurrentUserId(): Promise<string> {
  const actor = await requireAuthenticatedActor();
  return actor.personId;
}

export function isDemoModeEnabled(): boolean {
  return isNonLiveDemoEnvironment();
}

export function isDataResetAllowedEnvironment(): boolean {
  return isNonLiveDemoEnvironment();
}

export async function switchUserInDemoMode(targetUserId: string): Promise<{
  ok: boolean;
  personId: string;
}> {
  const actor = await requireAuthenticatedActor();
  const tenantId = getActiveTenantConfiguration().tenantId;
  if (!isDemoModeEnabled()) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: 'User switching is only permitted when Demo Mode is enabled in tenant configuration (featureFlags.enableDemoMode).',
      tenantId,
      correlationId: 'auth-check',
      actorUserId: actor.personId,
    });
  }
  const ctx = resolveDefaultServiceTenantContext(null, actor.personId, {
    session: actor.session,
  });
  const [people, matters, teams, rbacConfig] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    loadEffectiveTenantRbacConfig(ctx),
  ]);
  const targetPerson = people.find(
    (p) => p.id === targetUserId && p.isEmployee && !p.mergedIntoId,
  );
  if (!targetPerson || !targetPerson.demo) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: 'User switching in Demo Mode is restricted to designated demo users.',
      tenantId,
      correlationId: 'auth-check',
      actorUserId: actor.personId,
    });
  }

  const actorPerson = people.find((p) => p.id === actor.personId) ?? null;
  const actorPerms = resolvePersonPermissionSet(actorPerson, {
    allPeople: people,
    teams,
    mfaVerified: actor.mfaVerified,
    tokenRoles: actor.session.mappedRoles,
    config: { rbac: rbacConfig },
  });
  const targetPerms = resolvePersonPermissionSet(targetPerson, {
    allPeople: people,
    teams,
    mfaVerified: true,
    config: { rbac: rbacConfig },
  });
  const missingPerm = targetPerms.permissionList.find(
    (perm) => !actorPerms.permissions.has(perm),
  );
  if (missingPerm) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message: `Cannot switch in Demo Mode to a persona holding permission '${missingPerm}' not held by the current actor.`,
      requiredPermission: missingPerm,
      tenantId,
      correlationId: 'auth-check',
      actorUserId: actor.personId,
    });
  }

  // R104: Refuse Demo Mode switch if the target persona can access any restricted/staff matter not accessible to the signed-in actor
  const restrictedMatterWithTargetAccess = matters.find(
    (m) =>
      Boolean(
        m.isStaffMatter ||
          (m.restrictedAccessUserIds && m.restrictedAccessUserIds.length > 0),
      ) &&
      canPersonAccessMatter(m, targetPerson.id, targetPerson, {
        allPeople: people,
        teams,
        config: { rbac: rbacConfig },
      }) &&
      !canPersonAccessMatter(m, actor.personId, actorPerson, {
        allPeople: people,
        teams,
        tokenRoles: actor.session.mappedRoles,
        config: { rbac: rbacConfig },
      }),
  );
  if (restrictedMatterWithTargetAccess) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message:
        'Cannot switch in Demo Mode to a persona who has access to restricted or staff matters not accessible to the current actor.',
      requiredPermission: 'matter:restricted:access',
      tenantId,
      correlationId: 'auth-check',
      actorUserId: actor.personId,
    });
  }

  const now = Date.now();
  const nextSession: EntraSessionPayload = {
    ...actor.session,
    personId: targetPerson.id,
    email: targetPerson.emails?.[0]?.address ?? actor.session.email,
    displayName: personDisplayName(targetPerson),
    mappedRoles: resolveEmployeeRoles(targetPerson, teams),
    authenticatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
  };

  await runWithAuditStagingScope(() =>
    getPartyRepository().withTenantTransaction(ctx, async () => {
      writeAudit(null, {
        recordType: 'person',
        recordId: targetPerson.id,
        action: 'update',
        field: 'Demo user switch',
        oldValue: actor.personId,
        newValue: targetPerson.id,
        byId: actor.personId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );

  await persistEntraSessionCookie(nextSession);

  return { ok: true, personId: targetPerson.id };
}

export function activeEmployees(
  peopleOrSource:
    | readonly Person[]
    | { people: readonly Person[]; values: readonly ChoiceValue[] },
  valuesArg?: readonly ChoiceValue[],
): Person[] {
  const people = Array.isArray(peopleOrSource)
    ? peopleOrSource
    : (peopleOrSource as { people: readonly Person[]; values: readonly ChoiceValue[] })
        .people;
  const values = Array.isArray(peopleOrSource)
    ? (valuesArg ?? [])
    : (peopleOrSource as { people: readonly Person[]; values: readonly ChoiceValue[] })
        .values;
  return people
    .filter(
      (p) =>
        isSelectableInEmployeeDropdown(p) &&
        !p.mergedIntoId &&
        systemKeyOf(values as ChoiceValue[], p.recordStatusId) === 'active',
    )
    .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b)));
}

export function formatContext(
  source: {
    people?: readonly Person[];
    organisations?: readonly Organisation[];
    matters?: readonly Matter[];
    enquiries?: readonly Enquiry[];
    tasks?: readonly Task[];
    teams?: readonly Team[];
    values: ChoiceValue[];
  },
  overrides?: {
    people?: readonly Person[];
    organisations?: readonly Organisation[];
    matters?: readonly Matter[];
  },
): FormatContext {
  const names = new Map<string, string>();
  for (const p of overrides?.people ?? source.people ?? []) {
    names.set(p.id, personDisplayName(p));
  }
  for (const o of overrides?.organisations ?? source.organisations ?? []) {
    names.set(o.id, o.legalName);
  }
  for (const m of overrides?.matters ?? source.matters ?? []) {
    names.set(m.id, `${m.matterNumber} — ${m.title}`);
  }
  for (const e of source.enquiries ?? []) {
    names.set(e.id, `${e.reference} — ${enquiryDisplayName(e)}`);
  }
  for (const t of source.tasks ?? []) {
    names.set(t.id, `${t.reference} — ${t.title}`);
  }
  for (const tm of source.teams ?? []) {
    names.set(tm.id, tm.name);
  }
  return {
    values: source.values,
    nameOf: (id: string) => names.get(id) ?? id,
  };
}

declare global {
  var __oneSquaredKeyDateRepo: TenantKeyDateRepository | undefined;
}

export function getKeyDateRepository(): TenantKeyDateRepository {
  if (!global.__oneSquaredKeyDateRepo) {
    global.__oneSquaredKeyDateRepo = new TenantKeyDateRepository();
  }
  return global.__oneSquaredKeyDateRepo;
}

function resolveDefaultServiceTenantContext(
  _store?: FirmStore | null,
  preferredActorId?: string | null,
  options?: {
    tenantCtx?: TenantContext | null;
    session?: VerifiedEntraSessionPayload | null;
    correlationId?: string;
  },
): TenantContext {
  if (options?.tenantCtx) {
    return options.tenantCtx;
  }
  const activeTenantConfig = getActiveTenantConfiguration();
  const activeActorSession = getActiveActorSession()?.verifiedSession as
    | VerifiedEntraSessionPayload
    | undefined;
  const candidateSession =
    options?.session ??
    activeActorSession ??
    getTestEntraSessionOverride() ??
    undefined;

  if (candidateSession) {
    const cleanActor = preferredActorId?.trim();
    if (
      cleanActor &&
      cleanActor !== 'system' &&
      candidateSession.personId !== cleanActor
    ) {
      const err = new Error(
        `TENANCY_ACTOR_MISMATCH: Verified session personId "${candidateSession.personId}" does not match requested actor "${cleanActor}".`,
      ) as Error & { code: string };
      err.code = 'TENANCY_ACTOR_MISMATCH';
      throw err;
    }
    return resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(candidateSession, {
        correlationId: options?.correlationId,
      }),
      activeTenantConfig,
    );
  }

  const err = new Error(
    'UNAUTHENTICATED: Verified Entra ID session is required for tenant data access.',
  ) as Error & { code: string };
  err.code = 'UNAUTHENTICATED';
  throw err;
}

async function loadTenantCatalogueStoreView(
  ctx: TenantContext,
  options?: { includePmsLinks?: boolean },
): Promise<FirmStore> {
  const activeTenantConfig = getActiveTenantConfiguration();
  const catSnap =
    await getCatalogueRepository().getFullCatalogueAndConfigsSnapshot<
      FirmStore['firm'],
      ChoiceList,
      ChoiceValue,
      CustomFieldDefinition
    >(ctx, activeTenantConfig);
  const seedLists = buildSeedLists();
  const nowIso = new Date().toISOString();

  const lists: ChoiceList[] = [...catSnap.lists];
  for (const l of seedLists.lists) {
    if (!lists.some((x) => x.key === l.key)) {
      lists.push(l);
    }
  }
  const mpList = lists.find((x) => x.key === 'matter_party_role');
  if (mpList && mpList.label !== 'Matter Parties') {
    mpList.label = 'Matter Parties';
  }

  let values: ChoiceValue[] = [...catSnap.values];
  for (const v of seedLists.values) {
    const existingVal = values.find((x) => x.id === v.id);
    if (!existingVal) {
      values.push(v);
    } else if (v.listKey === 'work_type' && v.meta) {
      if (
        existingVal.meta?.amlInScope === undefined ||
        existingVal.meta?.clientMoneyThresholdGbp === undefined
      ) {
        existingVal.meta = {
          ...v.meta,
          ...(existingVal.meta ?? {}),
        };
      }
    }
  }

  const orgStructure =
    (catSnap.moduleConfigs.org_structure as OrgStructureCatalogue | undefined) ??
    buildDefaultOrgStructure({
      legalName: activeTenantConfig.displayName,
    });

  const matterPartyTaxonomy =
    (catSnap.moduleConfigs.matter_party_taxonomy as MatterPartyTaxonomy | undefined) ??
    buildDefaultMatterPartyTaxonomy(values);
  let matterPartyMigrationReport = catSnap.moduleConfigs
    .matter_party_migration_report as MatterPartyMigrationReport | undefined;

  if (
    !catSnap.moduleConfigs.matter_party_taxonomy ||
    !matterPartyMigrationReport
  ) {
    const partyMig = migrateMatterPartiesToTwoFieldModel(
      values,
      [],
      matterPartyTaxonomy,
      nowIso,
    );
    values = partyMig.values;
    if (!matterPartyMigrationReport) {
      matterPartyMigrationReport = partyMig.report;
    }
  }

  const rawHomePages =
    (catSnap.moduleConfigs.home_pages as HomePagesConfig | undefined) ??
    createDefaultHomePagesConfig(
      nowIso,
      activeTenantConfig.branding.primaryDomain,
    );
  const syncedRoles = syncHomeRolesWithEmployeeRoles(
    rawHomePages.roles ?? [],
    values,
    createDefaultRoleConfigs(activeTenantConfig.branding.primaryDomain),
  );
  const homePagesConfig: HomePagesConfig = {
    ...rawHomePages,
    roles: syncedRoles,
  };

  const matterCostsConfig =
    (catSnap.moduleConfigs.matter_costs as MatterCostsConfig | undefined) ??
    syncRateCardsWithPmsFeeEarners(
      createDefaultMatterCostsConfig(values, nowIso, {
        clientProfileCode: activeTenantConfig.tenantId,
        displayName: activeTenantConfig.displayName,
        primaryDomain: activeTenantConfig.branding.primaryDomain,
      }),
      (await getTenantPmsSource(ctx)).listFeeEarners(),
      values,
    );

  const enquirySettings: EnquirySettings =
    (catSnap.moduleConfigs.enquiry_settings as EnquirySettings | undefined) ?? {
      ...DEFAULT_ENQUIRY_SETTINGS,
    };

  const taskSettings: TaskSettings =
    (catSnap.moduleConfigs.task_settings as TaskSettings | undefined) ?? {
      templates: DEFAULT_TASK_SETTINGS.templates.map((t) => ({ ...t })),
    };

  const firm = catSnap.firmProfile
    ? {
        name: catSnap.firmProfile.firm.name,
        shortName: catSnap.firmProfile.firm.shortName,
        offices: [...catSnap.firmProfile.firm.offices],
      }
    : {
        name: activeTenantConfig.displayName,
        shortName:
          activeTenantConfig.displayName.replace(/\s+LLP$/i, '').trim() ||
          activeTenantConfig.displayName,
        offices: orgStructure.offices.map((o) => o.name),
      };

  return {
    firmId: catSnap.firmProfile?.firmId ?? ctx.tenantId,
    firm,
    isCleanDeployment: catSnap.firmProfile?.isCleanDeployment ?? false,
    lists,
    values,
    customFields: catSnap.customFields,
    orgStructure,
    matterPartyTaxonomy,
    matterPartyMigrationReport,
    people: [],
    employeeSensitiveRecords: {},
    organisations: [],
    links: [],
    matters: [],
    teams: [],
    tasks: [],
    enquiries: [],
    quotes: [],
    notifications: [],
    enquirySettings,
    taskSettings,
    signOffs: [],
    homePagesConfig,
    matterCostsConfig,
    pmsLinks: options?.includePmsLinks
      ? await getPmsRepository().listPmsLinks<PmsLink>(ctx)
      : [],
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

async function loadEffectiveTenantRbacConfig(
  ctx: TenantContext,
  preloadedOverride?: Partial<RbacConfiguration> | null,
): Promise<RbacConfiguration> {
  const base = getDefaultTenantRbacConfig(ctx.tenantId);
  const override =
    preloadedOverride !== undefined
      ? preloadedOverride
      : await getHrAndRbacRepository().getRbacConfigOverride<RbacConfiguration>(
          ctx,
        );
  const effective = override ? mergeRbacConfigOverlay(base, override) : base;
  const activeSession = getActiveActorSession();
  if (activeSession && activeSession.tenantId === ctx.tenantId) {
    activeSession.effectiveRbacConfig = effective;
  }
  return effective;
}

/**
 * Recomputes and writes `is_staff_matter`, `has_ethical_wall`, and `restricted_access_user_ids_json`
 * for only the affected matter rows inside the caller's active `withTenantTransaction` (`R478`, `R479`).
 * Takes `SELECT ... FOR UPDATE` on the affected matter rows and reads `people` and `teams` inside the same
 * transaction so stale pre-transaction reads or read-only paths can never overwrite access lists.
 */
async function syncAffectedMattersRestrictionsInTx(
  ctx: TenantContext,
  options: {
    matterIds?: readonly string[];
    includeAllRestrictedMatters?: boolean;
    rbacConfig?: RbacConfiguration | null;
  } = {},
): Promise<void> {
  const activeTx = getActiveTenantTransactionState();
  if (!activeTx || activeTx.tenantId !== ctx.tenantId) {
    const err = new Error(
      `TENANCY_TRANSACTION_REQUIRED: syncAffectedMattersRestrictionsInTx requires an active withTenantTransaction for tenant "${ctx.tenantId}".`,
    ) as Error & { code: string };
    err.code = 'TENANCY_TRANSACTION_REQUIRED';
    throw err;
  }
  const matterRepo = getMatterRepository();
  const lockedMatters =
    await matterRepo.lockMattersForRestrictionRecompute<Matter>(ctx, {
      matterIds: options.matterIds,
      includeAllRestrictedMatters: options.includeAllRestrictedMatters,
    });
  if (lockedMatters.length === 0) {
    return;
  }
  const txPeople = await getPartyRepository().listAllPeople<Person>(ctx);
  const txTeams = await getHrAndRbacRepository().listAllTeams<Team>(ctx);
  const txRbacOverride =
    options.rbacConfig !== undefined
      ? options.rbacConfig
      : await getHrAndRbacRepository().getRbacConfigOverride<RbacConfiguration>(ctx);
  const baseTenantConfig = getActiveTenantConfiguration();
  const effectiveRbac = txRbacOverride
    ? mergeRbacConfigOverlay(
        getDefaultTenantRbacConfig(ctx.tenantId),
        txRbacOverride,
      )
    : getDefaultTenantRbacConfig(ctx.tenantId);
  const effectiveTenantConfig = { ...baseTenantConfig, rbac: effectiveRbac };
  for (const m of lockedMatters) {
    const meta = computeMatterRestrictionMetadataForStore(
      m,
      txPeople,
      txTeams,
      effectiveTenantConfig,
    );
    await matterRepo.updateLockedMatterRestrictionColumnsInTx(ctx, m.id, {
      isStaffMatter: Boolean(m.isStaffMatter),
      hasEthicalWall: Boolean(m.hasEthicalWall),
      sqlRestrictedAccessUserIds: meta.restrictedAccessUserIds,
    });
  }
}

async function putMatterWithInTxRestrictions(
  ctx: TenantContext,
  matter: Matter,
  options: {
    expectedRowVersion?: number | null;
    rbacConfig?: RbacConfiguration | null;
  } = {},
): Promise<Matter> {
  const activeTx = getActiveTenantTransactionState();
  if (!activeTx || activeTx.tenantId !== ctx.tenantId) {
    const err = new Error(
      `TENANCY_TRANSACTION_REQUIRED: putMatterWithInTxRestrictions requires an active withTenantTransaction for tenant "${ctx.tenantId}".`,
    ) as Error & { code: string };
    err.code = 'TENANCY_TRANSACTION_REQUIRED';
    throw err;
  }
  const matterRepo = getMatterRepository();
  await matterRepo.lockMattersForRestrictionRecompute<Matter>(ctx, {
    matterIds: [matter.id],
  });
  const txPeople = await getPartyRepository().listAllPeople<Person>(ctx);
  const txTeams = await getHrAndRbacRepository().listAllTeams<Team>(ctx);
  const txRbacOverride =
    options.rbacConfig !== undefined
      ? options.rbacConfig
      : await getHrAndRbacRepository().getRbacConfigOverride<RbacConfiguration>(ctx);
  const baseTenantConfig = getActiveTenantConfiguration();
  const effectiveRbac = txRbacOverride
    ? mergeRbacConfigOverlay(
        getDefaultTenantRbacConfig(ctx.tenantId),
        txRbacOverride,
      )
    : getDefaultTenantRbacConfig(ctx.tenantId);
  const effectiveTenantConfig = { ...baseTenantConfig, rbac: effectiveRbac };
  const meta = computeMatterRestrictionMetadataForStore(
    matter,
    txPeople,
    txTeams,
    effectiveTenantConfig,
  );
  return matterRepo.putMatter<Matter>(ctx, matter, {
    expectedRowVersion: options.expectedRowVersion,
    sqlRestrictedAccessUserIds: meta.restrictedAccessUserIds,
  });
}

function mapFirmAuditRecordToAuditEntry(rec: FirmAuditEntryRecord): AuditEntry {
  return {
    id: rec.id,
    recordType: rec.recordType as AuditEntry['recordType'],
    recordId: rec.recordId,
    action: rec.action as AuditEntry['action'],
    field: rec.field,
    oldValue: rec.oldValue,
    newValue: rec.newValue,
    byId: rec.byId,
    at: rec.at,
    ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
    ...(rec.snapshot !== undefined ? { snapshot: rec.snapshot } : {}),
  };
}

function writeAudit(
  _store: FirmStore | null | undefined,
  entry: Omit<AuditEntry, 'id' | 'at'> & { at?: string },
): AuditEntry {
  return stageAuditEntry(entry);
}

export async function getKeyDatesConfig(
  storeOrOptions?:
    | FirmStore
    | { ctx?: TenantContext; userId?: string },
): Promise<KeyDatesConfig> {
  const activeTenantConfig = getActiveTenantConfiguration();
  const isOptionsObj =
    Boolean(storeOrOptions) &&
    typeof storeOrOptions === 'object' &&
    !('lists' in (storeOrOptions as Record<string, unknown>));
  const opts = isOptionsObj
    ? (storeOrOptions as { ctx?: TenantContext; userId?: string })
    : undefined;

  const ctx =
    opts?.ctx ?? resolveDefaultServiceTenantContext(null, opts?.userId);
  const override = await getKeyDateRepository().getKeyDatesTenantConfig(ctx);
  const raw = override ?? activeTenantConfig.keyDates ?? { enabled: false };
  return validateKeyDatesConfig(raw) as unknown as KeyDatesConfig;
}

/**
 * Record-scoped audit query for profile pages (R413), hitting idx_audit_entries_tenant_record
 * and enforcing restricted-matter, task/enquiry/quote visibility, and HR payroll/sensitive permissions.
 */
export async function listAuditEntriesForRecord(
  recordType: AuditEntry['recordType'],
  recordId: string,
  viewerId: string,
  options?: { limit?: number; tokenRoles?: readonly string[] },
): Promise<AuditEntry[]> {
  let ctx: TenantContext;
  try {
    ctx = resolveDefaultServiceTenantContext(null, viewerId);
  } catch {
    return [];
  }
  const [people, matters, enquiries, quotes, tasks, teams, rbacConfig] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    getIntakeQuoteRepository().listAllEnquiriesUnfiltered<Enquiry>(ctx),
    getIntakeQuoteRepository().listAllQuotesUnfiltered<Quote>(ctx),
    getTaskWorkflowRepository().listAllTasksUnfiltered<Task>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    loadEffectiveTenantRbacConfig(ctx),
  ]);
  const viewer = people.find(
    (p) => p.id === viewerId && !p.mergedIntoId,
  );
  if (!viewer) {
    return [];
  }
  const activeSession = getActiveActorSession();
  const effectiveTokenRoles =
    options?.tokenRoles ??
    (activeSession?.personId === viewer.id ? activeSession.tokenRoles : undefined);

  const prelimVisibility = buildRecordVisibility({ teams }, viewer, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    rbacConfig,
  });
  const hiddenMatterKeyDateIds =
    await getKeyDateRepository().listHiddenKeyDateIdsForMatters(
      ctx,
      prelimVisibility.hiddenMatterIds,
    );
  const visibility = buildRecordVisibility({ teams }, viewer, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds,
    rbacConfig,
  });

  if (recordType === 'matter') {
    const m = matters.find((x) => x.id === recordId);
    if (m && !visibility.canViewMatter(m)) {
      return [];
    }
    if (prelimVisibility.hiddenMatterIds.has(recordId)) {
      return [];
    }
  } else if (recordType === 'enquiry') {
    const e = enquiries.find((x) => x.id === recordId);
    if (!e || !visibility.canViewEnquiry(e)) {
      return [];
    }
  } else if (recordType === 'quote') {
    const q = quotes.find((x) => x.id === recordId);
    if (!q || !visibility.canViewQuote(q)) {
      return [];
    }
  } else if (recordType === 'task') {
    const t = tasks.find((x) => x.id === recordId);
    if (!t || !visibility.canViewTask(t)) {
      return [];
    }
  } else if (recordType === 'key_date') {
    if (hiddenMatterKeyDateIds.has(recordId)) {
      return [];
    }
    const prefix = recordId.split(':')[0];
    if (prefix && visibility.hiddenMatterIds.has(prefix)) {
      return [];
    }
  } else if (recordType === 'employee_payroll') {
    if (!hasEmployeePermission(viewer, 'employee:payroll', people, teams, { config: { rbac: rbacConfig } })) {
      return [];
    }
  } else if (recordType === 'employee_sensitive') {
    if (!hasEmployeePermission(viewer, 'employee:sensitive', people, teams, { config: { rbac: rbacConfig } })) {
      return [];
    }
  }

  const rows = await getAuditRepository().listAuditEntriesForRecord(
    ctx,
    recordType,
    recordId,
    { limit: options?.limit ?? 200 },
  );
  return rows.map(mapFirmAuditRecordToAuditEntry);
}

/**
 * Paginated firm-wide audit query for Admin (R413, R451, R452, R457), hitting idx_audit_entries_tenant_seq,
 * enforcing admin:access, and filling each page with visible entries after redacting restricted matters,
 * hidden tasks/enquiries/quotes/key-dates, and unpermitted HR audit rows.
 */
export async function listFirmAuditEntriesPage(
  viewerId: string,
  options?: {
    limit?: number;
    beforeSeq?: number;
    tokenRoles?: readonly string[];
  },
): Promise<
  { entries: AuditEntry[]; nextBeforeSeq: number | null } & Partial<ActionDenied>
> {
  let ctx: TenantContext;
  try {
    ctx = resolveDefaultServiceTenantContext(null, viewerId);
  } catch {
    return {
      ...buildActionDenied(
        'FORBIDDEN',
        'You need "admin:access" permission to view the firm audit log.',
      ),
      entries: [],
      nextBeforeSeq: null,
    };
  }
  const [people, matters, enquiries, quotes, tasks, teams, rbacConfig] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    getIntakeQuoteRepository().listAllEnquiriesUnfiltered<Enquiry>(ctx),
    getIntakeQuoteRepository().listAllQuotesUnfiltered<Quote>(ctx),
    getTaskWorkflowRepository().listAllTasksUnfiltered<Task>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    loadEffectiveTenantRbacConfig(ctx),
  ]);
  const viewer = people.find(
    (p) => p.id === viewerId && !p.mergedIntoId,
  );
  const activeSession = getActiveActorSession();
  const effectiveTokenRoles =
    options?.tokenRoles ??
    (viewer && activeSession?.personId === viewer.id
      ? activeSession.tokenRoles
      : undefined);
  if (
    !viewer ||
    !hasPersonPermission(viewer, 'admin:access', {
      allPeople: people,
      teams,
      tokenRoles: effectiveTokenRoles,
      config: { rbac: rbacConfig },
    })
  ) {
    return {
      ...buildActionDenied(
        'FORBIDDEN',
        'You need "admin:access" permission to view the firm audit log.',
      ),
      entries: [],
      nextBeforeSeq: null,
    };
  }

  const prelimVisibility = buildRecordVisibility({ teams }, viewer, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    rbacConfig,
  });
  const hiddenMatterKeyDateIds =
    await getKeyDateRepository().listHiddenKeyDateIdsForMatters(
      ctx,
      prelimVisibility.hiddenMatterIds,
    );
  const visibility = buildRecordVisibility({ teams }, viewer, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds,
    rbacConfig,
  });
  const hiddenTaskIds = new Set(
    tasks.filter((t) => !visibility.canViewTask(t)).map((t) => t.id),
  );
  const canPayroll = hasEmployeePermission(
    viewer,
    'employee:payroll',
    people,
    teams,
    { config: { rbac: rbacConfig } },
  );
  const canSensitive = hasEmployeePermission(
    viewer,
    'employee:sensitive',
    people,
    teams,
    { config: { rbac: rbacConfig } },
  );

  const isVisibleAuditRow = (a: FirmAuditEntryRecord): boolean => {
    if (a.recordType === 'matter' && visibility.hiddenMatterIds.has(a.recordId)) {
      return false;
    }
    if (a.recordType === 'task' && hiddenTaskIds.has(a.recordId)) {
      return false;
    }
    if (a.recordType === 'enquiry' && visibility.hiddenEnquiryIds.has(a.recordId)) {
      return false;
    }
    if (a.recordType === 'quote' && visibility.hiddenQuoteIds.has(a.recordId)) {
      return false;
    }
    if (a.recordType === 'key_date') {
      if (hiddenMatterKeyDateIds.has(a.recordId)) return false;
      const prefix = a.recordId.split(':')[0];
      if (prefix && visibility.hiddenMatterIds.has(prefix)) return false;
    }
    if (a.recordType === 'employee_payroll' && !canPayroll) {
      return false;
    }
    if (a.recordType === 'employee_sensitive' && !canSensitive) {
      return false;
    }
    return true;
  };

  const targetLimit = Math.min(
    2000,
    Math.max(1, Math.floor(options?.limit ?? 250)),
  );
  const collected: FirmAuditEntryRecord[] = [];
  let cursor = options?.beforeSeq;
  let hasMoreAfterCollected = false;

  while (collected.length < targetLimit) {
    const page = await getAuditRepository().listFirmAuditEntriesPage(ctx, {
      limit: Math.max(targetLimit, 250),
      beforeSeq: cursor,
    });
    if (page.entries.length === 0) {
      hasMoreAfterCollected = false;
      break;
    }
    let stoppedMidBatch = false;
    for (let i = 0; i < page.entries.length; i++) {
      const a = page.entries[i]!;
      if (!isVisibleAuditRow(a)) continue;
      if (collected.length < targetLimit) {
        collected.push(a);
      } else {
        hasMoreAfterCollected = true;
        stoppedMidBatch = true;
        break;
      }
    }
    if (stoppedMidBatch) {
      break;
    }
    if (page.nextBeforeSeq === null) {
      hasMoreAfterCollected = false;
      break;
    }
    if (collected.length >= targetLimit) {
      hasMoreAfterCollected = true;
      break;
    }
    cursor = page.nextBeforeSeq;
  }

  const lastVisible = collected.at(-1);
  const nextBeforeSeq =
    hasMoreAfterCollected && lastVisible?.seq !== undefined
      ? lastVisible.seq
      : null;

  return {
    entries: collected.map(mapFirmAuditRecordToAuditEntry),
    nextBeforeSeq,
  };
}

function logDocumentLifecycleSyncError(
  err: unknown,
  correlationId: string,
): void {
  const tenantId = getActiveTenantConfiguration().tenantId;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'document_store.lifecycle_sync_unhandled',
      tenantId,
      correlationId,
      code: (err as { code?: string })?.code ?? 'unavailable',
    }),
  );
}

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
    matters,
    enquiries,
    quotes,
    tasks,
    signOffs,
  ] = await Promise.all([
    partyRepo.listAllPeople<Person>(snapshotTenantCtx),
    partyRepo.listAllOrganisations<Organisation>(snapshotTenantCtx),
    partyRepo.listAllLinks<PersonOrganisationLink>(snapshotTenantCtx),
    partyRepo.listAllNotes<Note>(snapshotTenantCtx),
    partyRepo.listAllMergeHistory<MergeHistory>(snapshotTenantCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(snapshotTenantCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(snapshotTenantCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(snapshotTenantCtx),
    taskRepo.listAllTasksUnfiltered<Task>(snapshotTenantCtx),
    taskRepo.listAllSignOffsUnfiltered<SignOffItem>(snapshotTenantCtx),
  ]);
  const [teams, dbEmployeeMigrationReport, dbRbacOverride] = await Promise.all([
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
  const employees = activeEmployees(people, store.values);
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
    config: { rbac: rbacConfig },
  });
  const orgStructure =
    store.orgStructure ??
    buildDefaultOrgStructure({
      legalName: getActiveTenantConfiguration().displayName,
    });

  // Filter employment records on people at the API level based on requesting user's permissions
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
        { config: { rbac: rbacConfig } },
      ),
    };
  });

  // Never bulk-return sensitive HR records in page snapshots (R63); serve only via audited per-person read service.
  const employeeSensitiveRecords: Record<string, EmployeeSensitiveRecord> = {};

  const keyDateRepo = getKeyDateRepository();

  // Data-layer record visibility filtering for the signed-in user (R152, R170, Rule 4):
  const prelimVisibility = buildRecordVisibility({ teams }, user, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    rbacConfig,
  });
  const hiddenMatterKeyDateIds = await keyDateRepo.listHiddenKeyDateIdsForMatters(
    snapshotTenantCtx,
    prelimVisibility.hiddenMatterIds,
  );
  const visibility = buildRecordVisibility({ teams }, user, {
    teams,
    people,
    matters,
    enquiries,
    quotes,
    tokenRoles: effectiveTokenRoles,
    hiddenMatterKeyDateIds,
    rbacConfig,
  });
  const visibleMatters: Matter[] = matters.filter(visibility.canViewMatter);
  const hiddenMatterIds = visibility.hiddenMatterIds;
  const hiddenMatterSourceQuoteIds = visibility.hiddenMatterSourceQuoteIds;

  // Filter enquiries: hide personal Drafts belonging to another user and enquiries converted into a hidden matter,
  // and strip hidden matter conflict hits from conflictSnapshot.
  const visibleEnquiries: Enquiry[] = enquiries
    .filter(visibility.canViewEnquiry)
    .map((e) => {
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
  const visibleEnquiryIdSet = new Set(visibleEnquiries.map((e) => e.id));
  const hiddenEnquiryIds = new Set(
    enquiries
      .filter((e) => !visibleEnquiryIdSet.has(e.id))
      .map((e) => e.id),
  );

  // Filter quotes: require quote:view and hide quotes linked to or converted into a hidden matter or hidden enquiry.
  const visibleQuotes: Quote[] = currentUserPermissions.includes('quote:view')
    ? quotes.filter(visibility.canViewQuote)
    : [];
  const visibleQuoteIdSet = new Set(visibleQuotes.map((q) => q.id));
  const hiddenQuoteIds = new Set(
    quotes
      .filter((q) => !visibleQuoteIdSet.has(q.id))
      .map((q) => q.id),
  );

  // Filter tasks: hide any task linked to a hidden matter, hidden enquiry, hidden quote, or hidden key date.
  const visibleTasks: Task[] = tasks.filter(visibility.canViewTask);
  const visibleTaskIdSet = new Set(visibleTasks.map((t) => t.id));
  const hiddenTaskIds = new Set(
    tasks.filter((t) => !visibleTaskIdSet.has(t.id)).map((t) => t.id),
  );

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
  const matterByIdForKd = new Map(matters.map((m) => [m.id, m]));
  const canViewKeyDates = currentUserKeyDatePermissions.includes('keydate:view');
  const repoVisibleKeyDates = canViewKeyDates
    ? await keyDateRepo.listAllVisibleKeyDates(snapshotTenantCtx, user.id)
    : [];
  const visibleKeyDates: KeyDate[] = repoVisibleKeyDates.filter((kd) => {
    if (!permittedDiaryTeamIds.has(kd.teamId)) return false;
    if (!kd.matterId) return true;
    const m = matterByIdForKd.get(kd.matterId);
    return canViewerAccessMatterKeyDates(m, user.id, user, people);
  });
  const visibleKeyDateIdSet = new Set(visibleKeyDates.map((kd) => kd.id));
  const repoVisibleNotApplicable = canViewKeyDates
    ? await keyDateRepo.listAllVisibleNotApplicable(snapshotTenantCtx, user.id)
    : [];
  const visibleKeyDateNotApplicable: KeyDateNotApplicable[] = repoVisibleNotApplicable.filter(
    (na) => {
      const m = matterByIdForKd.get(na.matterId);
      return canViewerAccessMatterKeyDates(m, user.id, user, people);
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

  // If the current user is a demo user with showsWorkOfId, resolve the underlying employee for personal panels
  const effectiveWorkPerson: Person =
    user.demo && user.showsWorkOfId
      ? (people.find((p) => p.id === user.showsWorkOfId) ?? user)
      : user;

  const finance: AppFinanceCapabilities = {
    canViewFirm: currentUserPermissions.includes('finance:view'),
    canViewMatter: currentUserPermissions.includes('finance:view_matter'),
    canCreditControl: currentUserPermissions.includes('finance:credit_control'),
  };

  const pmsSummaryByMatterIdForAttention: Record<string, PmsMatterFinancials> = {};
  if (finance.canViewMatter) {
    const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;
    if (!isCleanEmpty) {
      const pms = await getTenantPmsSource(snapshotTenantCtx);
      const hiddenPmsMatterCodes = new Set(
        store.pmsLinks
          .filter((l) => l.entityType === 'matter' && hiddenMatterIds.has(l.onesquaredId))
          .map((l) => l.pmsCode),
      );
      const visiblePmsLinks = store.pmsLinks.filter(
        (l) => !(l.entityType === 'matter' && hiddenMatterIds.has(l.onesquaredId)),
      );
      const allMatterFins = pms
        .getAllMatterFinancials()
        .filter((f) => !hiddenPmsMatterCodes.has(f.matter_code));
      const finByMatterCode = new Map(allMatterFins.map((f) => [f.matter_code, f]));
      for (const link of visiblePmsLinks) {
        if (link.entityType === 'matter') {
          const fin = finByMatterCode.get(link.pmsCode);
          if (fin) pmsSummaryByMatterIdForAttention[link.onesquaredId] = fin;
        }
      }
    }
  }

  const resolvedFirmName =
    activeTenantCfg.displayName || store.firm?.shortName || store.firm?.name || '';
  const searchIndex = buildSearchIndex(
    people,
    organisations,
    visibleLinks,
    store.values,
    visibleMatters,
    visibleEnquiries,
    visibleTasks,
    teams,
    resolvedFirmName,
  );
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
      !hiddenQuoteIds.has(id),
  );
  const primaryNotifications = await taskRepo.listNotificationsForUser<NotificationItem>(
    snapshotTenantCtx,
    user.id,
    { includeRestricted: true },
  );
  const effectivePersonNotifications =
    effectiveWorkPerson.id !== user.id
      ? await taskRepo.listNotificationsForUser<NotificationItem>(
          snapshotTenantCtx,
          effectiveWorkPerson.id,
          { includeRestricted: true },
        )
      : [];
  const mergedNotificationsMap = new Map<string, NotificationItem>();
  for (const n of [...primaryNotifications, ...effectivePersonNotifications]) {
    mergedNotificationsMap.set(n.id, n);
  }
  const userNotifications = Array.from(mergedNotificationsMap.values())
    .filter(
      (n) =>
        !(
          hiddenMatterIds.has(n.recordId) ||
          hiddenTaskIds.has(n.recordId) ||
          hiddenEnquiryIds.has(n.recordId) ||
          hiddenQuoteIds.has(n.recordId)
        ),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const taskBadgeCount = countMyUrgentBadgeTasks(visibleTasks, effectiveWorkPerson.id, now);

  const visibleSignOffs = signOffs.filter(
    (s) => !(s.matterId && hiddenMatterIds.has(s.matterId)),
  );
  const visibleNotes = notes.filter(
    (n) =>
      !hiddenMatterIds.has(n.recordId) &&
      !hiddenTaskIds.has(n.recordId) &&
      !hiddenEnquiryIds.has(n.recordId) &&
      !hiddenQuoteIds.has(n.recordId),
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

  // Keep quote statuses up to date when follow-up or valid-until dates pass
  for (const q of visibleQuotes) {
    const eff = evaluateQuoteEffectiveStatus(q, now);
    if (eff !== q.status) {
      q.status = eff;
      if (eff === 'Expired' && !q.timeline.some((t) => t.kind === 'expired')) {
        q.timeline.push({
          id: `QT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'expired',
          at: now.toISOString(),
          byId: null,
          title: 'Quote expired',
          detail: `Valid-until date (${q.validUntil}) passed without an outcome.`,
        });
      }
      await intakeRepo.putQuote(snapshotTenantCtx, q);
    }
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
      actorCanSignOffCosts && visibility.canViewMatter(m);
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
    currentUser: user,
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
    matterCostsConfig:
      store.matterCostsConfig ??
      createDefaultMatterCostsConfig(store.values, {
        clientProfileCode: activeTenantCfg.tenantId,
        displayName: activeTenantCfg.displayName,
        primaryDomain: activeTenantCfg.branding.primaryDomain,
      }),
    taskBadgeCount,
    notes: visibleNotes,
    audit: visibleAudit,
    mergeHistory,
    searchIndex,
    attention,
    recentIds,
  };
}

export async function recordRecentlyViewed(userId: string, recordId: string): Promise<void> {
  const ctx = resolveDefaultServiceTenantContext(null, userId);
  await getTaskWorkflowRepository().recordRecentlyViewed(ctx, userId, recordId, 8);
}

/**
 * API-level read of a person's employment and sensitive records, enforcing permissions
 * and optionally logging views of restricted payroll or sensitive sections.
 */
export async function getEmployeeDetailsForUser(
  personId: string,
  byId: string,
  opts: {
    logViewPayroll?: boolean;
    logViewSensitive?: boolean;
    beforeCommitHook?: () => Promise<void> | void;
  } = {},
): Promise<{
  employment: EmploymentRecord | null;
  sensitive: EmployeeSensitiveRecord | null;
  permissions: EmployeePermission[];
  errors?: Record<string, string>;
}> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const hrRepo = getHrAndRbacRepository();
  const [store, people, teams, rbacConfig] = await Promise.all([
    loadTenantCatalogueStoreView(ctx),
    getPartyRepository().listAllPeople<Person>(ctx),
    hrRepo.listAllTeams<Team>(ctx),
    loadEffectiveTenantRbacConfig(ctx),
  ]);
  const user = people.find((p) => p.id === byId) ?? null;
  const person = people.find((p) => p.id === personId) ?? null;
  const perms = resolveEmployeePermissions(user, people, teams, {
    config: { rbac: rbacConfig },
  });
  const errors: Record<string, string> = {};

  if (!person) {
    return { employment: null, sensitive: null, permissions: perms, errors: { notFound: 'Person not found.' } };
  }

  let sensitiveAuditWritten = false;
  let rawEmployment: EmploymentRecord | null = person.employment ?? null;
  let rawSensitive: EmployeeSensitiveRecord | null = null;

  await hrRepo.withTenantTransaction(ctx, async () => {
    const dbEmp = await hrRepo.getEmploymentRecord<EmploymentRecord>(
      ctx,
      personId,
    );
    const dbSens = await hrRepo.getSensitiveRecord<EmployeeSensitiveRecord>(
      ctx,
      personId,
    );
    if (dbEmp !== null) {
      rawEmployment = dbEmp;
    }
    if (dbSens !== null) {
      rawSensitive = dbSens;
    }

    const auditInputs: FirmAuditEntryInput[] = [];
    const nowIso = new Date().toISOString();

    if (opts.logViewPayroll) {
      if (!hasEmployeePermission(user, 'employee:payroll', people, teams, { config: { rbac: rbacConfig } })) {
        errors.payrollPermission = 'You do not have permission to view payroll details.';
      } else {
        auditInputs.push({
          recordType: 'employee_payroll',
          recordId: personId,
          action: 'view-payroll',
          field: 'Payroll & benefits',
          oldValue: null,
          newValue: `Viewed by ${user ? personDisplayName(user) : byId}`,
          byId,
          at: nowIso,
        });
      }
    }

    if (opts.logViewSensitive) {
      if (!hasEmployeePermission(user, 'employee:sensitive', people, teams, { config: { rbac: rbacConfig } })) {
        errors.sensitivePermission = 'You do not have permission to view sensitive employee information.';
      } else {
        auditInputs.push({
          recordType: 'employee_sensitive',
          recordId: personId,
          action: 'view-sensitive',
          field: 'Sensitive information',
          oldValue: null,
          newValue: `Viewed by ${user ? personDisplayName(user) : byId}`,
          byId,
          at: nowIso,
        });
        sensitiveAuditWritten = true;
      }
    }

    if (auditInputs.length > 0) {
      await hrRepo.appendHrAuditEntriesInTx(ctx, auditInputs);
    }
    if (opts.beforeCommitHook) {
      await opts.beforeCommitHook();
    }
  });

  const employment = filterEmploymentForUser(
    rawEmployment ?? undefined,
    user,
    people,
    teams,
    store.orgStructure,
    { config: { rbac: rbacConfig } },
  );
  // R103 & R130: Only return sensitive HR records when logViewSensitive: true and audit write succeeded in the same transaction
  const sensitive = sensitiveAuditWritten
    ? structuredClone(rawSensitive ?? null)
    : null;

  return {
    employment,
    sensitive,
    permissions: perms,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

/**
 * Logs every view of payroll and sensitive fields with user and timestamp to PostgreSQL audit_entries
 * in the same transaction as the HR record read.
 */
export async function logEmployeeRestrictedAccess(
  personId: string,
  section: 'payroll' | 'sensitive',
  byId: string,
  fieldDetail?: string,
): Promise<{ auditEntry?: AuditEntry; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const hrRepo = getHrAndRbacRepository();
  const [people, teams, rbacConfig] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    hrRepo.listAllTeams<Team>(ctx),
    loadEffectiveTenantRbacConfig(ctx),
  ]);
  const user = people.find((p) => p.id === byId) ?? null;
  const requiredPerm: EmployeePermission =
    section === 'payroll' ? 'employee:payroll' : 'employee:sensitive';

  if (!hasEmployeePermission(user, requiredPerm, people, teams, { config: { rbac: rbacConfig } })) {
    return { error: `Permission denied: ${requiredPerm} is required.` };
  }

  const persisted = await hrRepo.withTenantTransaction(ctx, async () => {
    if (section === 'payroll') {
      await hrRepo.getEmploymentRecord(ctx, personId);
    } else {
      await hrRepo.getSensitiveRecord(ctx, personId);
    }
    return hrRepo.appendHrAuditEntriesInTx(ctx, [
      {
        recordType: section === 'payroll' ? 'employee_payroll' : 'employee_sensitive',
        recordId: personId,
        action: section === 'payroll' ? 'view-payroll' : 'view-sensitive',
        field: fieldDetail ?? (section === 'payroll' ? 'Payroll & benefits' : 'Sensitive information'),
        oldValue: null,
        newValue: `Viewed by ${user ? personDisplayName(user) : byId}`,
        byId,
        at: new Date().toISOString(),
      },
    ]);
  });
  return { auditEntry: mapFirmAuditRecordToAuditEntry(persisted[0]!) };
}

/**
 * Reassigns records owned by a leaver to another active employee.
 */
export async function reassignLeaverOwnedRecords(
  fromLeaverId: string,
  toEmployeeId: string,
  byId: string,
): Promise<{ reassignedCount: number; errors?: Record<string, string> } & Partial<ActionDenied>> {
  const pendingLifecycleSyncs: Array<{
    matter: Matter;
    previousMatter: Matter;
    store: FirmStore;
  }> = [];
  const reassignCtx = resolveDefaultServiceTenantContext(null, byId);
  const store = await loadTenantCatalogueStoreView(reassignCtx);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const hrRepo = getHrAndRbacRepository();
  const [people, organisations, matters, tasks, enquiries, teams, rbacConfig] = await Promise.all([
    partyRepo.listAllPeople<Person>(reassignCtx),
    partyRepo.listAllOrganisations<Organisation>(reassignCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(reassignCtx),
    taskRepo.listAllTasksUnfiltered<Task>(reassignCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(reassignCtx),
    hrRepo.listAllTeams<Team>(reassignCtx),
    loadEffectiveTenantRbacConfig(reassignCtx),
  ]);
  const now = new Date().toISOString();
  const actor = people.find((p) => p.id === byId) ?? null;
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
    config: { rbac: rbacConfig },
  });
  if (
    !actorPerms.permissions.has('employee:edit_core') ||
    !actorPerms.permissions.has('matter:reassign_ownership')
  ) {
    const msg =
      'You must hold both employee:edit_core and matter:reassign_ownership to reassign records owned by a leaver.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      reassignedCount: 0,
      errors: { permission: msg },
    };
  }

  const fromLeaver = people.find((p) => p.id === fromLeaverId);
  if (!fromLeaver || !isLeaverPerson(fromLeaver)) {
    const msg = 'Source person must be an existing leaver.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      reassignedCount: 0,
      errors: { fromLeaverId: msg },
    };
  }

  const targetEmp = people.find((p) => p.id === toEmployeeId);
  if (!targetEmp || !isSelectableInEmployeeDropdown(targetEmp)) {
    const msg = 'Replacement owner must be an active employee.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      reassignedCount: 0,
      errors: { toEmployeeId: msg },
    };
  }

  const fromName = personDisplayName(fromLeaver);
  const toName = personDisplayName(targetEmp);
  let count = 0;

  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(reassignCtx, async () => {
      const changedPeople: Array<{ person: Person; prevPerson: Person }> = [];
      const changedOrganisations: Array<{
        org: Organisation;
        prevOrg: Organisation;
      }> = [];
      const changedMatters: Array<{ matter: Matter; prevMatter: Matter | null }> = [];
      const changedTasks: Array<{ task: Task; prevTask: Task }> = [];
      const changedEnquiries: Array<{ enquiry: Enquiry; prevEnquiry: Enquiry }> = [];

      for (const p of people) {
        if (p.mergedIntoId) continue;
        const prevPerson =
          p.relationshipOwnerId === fromLeaverId ||
          p.recordOwnerId === fromLeaverId ||
          p.verificationReviewerId === fromLeaverId
            ? structuredClone(p)
            : null;
        const movedRoles: string[] = [];
        if (p.relationshipOwnerId === fromLeaverId) {
          p.relationshipOwnerId = toEmployeeId;
          count++;
          movedRoles.push('Relationship owner');
        }
        if (p.recordOwnerId === fromLeaverId) {
          p.recordOwnerId = toEmployeeId;
          count++;
          movedRoles.push('Record owner');
        }
        if (p.verificationReviewerId === fromLeaverId) {
          p.verificationReviewerId = toEmployeeId;
          count++;
          movedRoles.push('Verification reviewer');
        }
        if (movedRoles.length > 0 && prevPerson) {
          p.updatedAt = now;
          p.updatedById = byId;
          changedPeople.push({ person: p, prevPerson });
          writeAudit(store, {
            recordType: 'person',
            recordId: p.id,
            action: 'assign',
            field: `Leaver reassignment (${movedRoles.join(', ')})`,
            oldValue: `${fromName} (${fromLeaverId})`,
            newValue: `${toName} (${toEmployeeId})`,
            byId,
            at: now,
          });
        }
      }

      for (const o of organisations) {
        if (o.mergedIntoId) continue;
        const prevOrg =
          o.relationshipPartnerId === fromLeaverId ||
          o.recordOwnerId === fromLeaverId ||
          o.reviewerId === fromLeaverId
            ? structuredClone(o)
            : null;
        const movedRoles: string[] = [];
        if (o.relationshipPartnerId === fromLeaverId) {
          o.relationshipPartnerId = toEmployeeId;
          count++;
          movedRoles.push('Relationship partner');
        }
        if (o.recordOwnerId === fromLeaverId) {
          o.recordOwnerId = toEmployeeId;
          count++;
          movedRoles.push('Record owner');
        }
        if (o.reviewerId === fromLeaverId) {
          o.reviewerId = toEmployeeId;
          count++;
          movedRoles.push('Reviewer');
        }
        if (movedRoles.length > 0 && prevOrg) {
          o.updatedAt = now;
          o.updatedById = byId;
          changedOrganisations.push({ org: o, prevOrg });
          writeAudit(store, {
            recordType: 'organisation',
            recordId: o.id,
            action: 'assign',
            field: `Leaver reassignment (${movedRoles.join(', ')})`,
            oldValue: `${fromName} (${fromLeaverId})`,
            newValue: `${toName} (${toEmployeeId})`,
            byId,
            at: now,
          });
        }
      }

      for (const m of matters) {
        const movedRoles: string[] = [];
        const prevMatter =
          m.responsiblePartnerId === fromLeaverId ||
          m.supervisingPartnerId === fromLeaverId ||
          m.leadFeeEarnerId === fromLeaverId
            ? structuredClone(m)
            : null;

        if (m.responsiblePartnerId === fromLeaverId) {
          m.responsiblePartnerId = toEmployeeId;
          count++;
          movedRoles.push('Responsible partner');
        }
        if (m.supervisingPartnerId === fromLeaverId) {
          m.supervisingPartnerId = toEmployeeId;
          count++;
          movedRoles.push('Supervising partner');
        }
        if (m.leadFeeEarnerId === fromLeaverId) {
          m.leadFeeEarnerId = toEmployeeId;
          count++;
          movedRoles.push('Lead fee earner');
        }
        if (movedRoles.length > 0) {
          const isRestricted =
            m.isStaffMatter ||
            m.hasEthicalWall ||
            (m.restrictedAccessUserIds?.length ?? 0) > 0;
          if (isRestricted) {
            const nextRestricted = new Set(m.restrictedAccessUserIds ?? []);
            nextRestricted.delete(fromLeaverId);
            nextRestricted.add(toEmployeeId);
            m.restrictedAccessUserIds = Array.from(nextRestricted);
          }
          touchMatter(m, byId);
          changedMatters.push({ matter: m, prevMatter });
          writeAudit(store, {
            recordType: 'matter',
            recordId: m.id,
            action: 'assign',
            field: `Leaver reassignment (${movedRoles.join(', ')})`,
            oldValue: `${fromName} (${fromLeaverId})`,
            newValue: `${toName} (${toEmployeeId})`,
            byId,
            at: now,
          });
        }
      }

      for (const t of tasks) {
        if (t.status === 'Done' || t.status === 'Cancelled') continue;
        const prevTask = structuredClone(t);
        let taskChanged = false;
        if (t.assignedPersonId === fromLeaverId) {
          t.assignedPersonId = toEmployeeId;
          count++;
          taskChanged = true;
        }
        if (Array.isArray(t.assignedPersonIds) && t.assignedPersonIds.includes(fromLeaverId)) {
          t.assignedPersonIds = Array.from(
            new Set(t.assignedPersonIds.map((id) => (id === fromLeaverId ? toEmployeeId : id))),
          );
          if (!taskChanged) {
            count++;
            taskChanged = true;
          }
        }
        if (taskChanged) {
          t.updatedAt = now;
          t.updatedById = byId;
          changedTasks.push({ task: t, prevTask });
          writeAudit(store, {
            recordType: 'task',
            recordId: t.id,
            action: 'assign',
            field: 'Leaver reassignment (Assigned to)',
            oldValue: `${fromName} (${fromLeaverId})`,
            newValue: `${toName} (${toEmployeeId})`,
            byId,
            at: now,
          });
        }
      }

      for (const e of enquiries) {
        if (!isEnquiryOpen(e)) continue;
        if (e.assignedToId === fromLeaverId) {
          const prevEnquiry = structuredClone(e);
          e.assignedToId = toEmployeeId;
          e.updatedAt = now;
          e.updatedById = byId;
          count++;
          changedEnquiries.push({ enquiry: e, prevEnquiry });
          writeAudit(store, {
            recordType: 'enquiry',
            recordId: e.id,
            action: 'assign',
            field: 'Leaver reassignment (Assigned to)',
            oldValue: `${fromName} (${fromLeaverId})`,
            newValue: `${toName} (${toEmployeeId})`,
            byId,
            at: now,
          });
        }
      }

      writeAudit(store, {
        recordType: 'person',
        recordId: fromLeaverId,
        action: 'assign',
        field: 'Leaver record reassignment',
        oldValue: fromLeaverId,
        newValue: `Reassigned ${count} record role(s) to ${toName} (${toEmployeeId})`,
        byId,
        at: now,
      });

      for (const { person: p } of changedPeople) {
        await partyRepo.putPerson(reassignCtx, p);
      }
      for (const { org: o } of changedOrganisations) {
        await partyRepo.putOrganisation(reassignCtx, o);
      }
      for (const { matter: m } of changedMatters) {
        await putMatterWithInTxRestrictions(reassignCtx, m, {
          expectedRowVersion: null,
        });
      }
      for (const { task: t } of changedTasks) {
        await taskRepo.putTask(reassignCtx, t);
      }
      for (const { enquiry: e } of changedEnquiries) {
        await intakeRepo.putEnquiry(reassignCtx, e);
      }
      await flushStagedAuditEntries(reassignCtx);

      for (const { matter: m, prevMatter } of changedMatters) {
        const isRestricted =
          m.isStaffMatter ||
          m.hasEthicalWall ||
          (m.restrictedAccessUserIds?.length ?? 0) > 0;
        if (isRestricted && prevMatter) {
          pendingLifecycleSyncs.push({
            matter: m,
            previousMatter: prevMatter,
            store,
          });
        }
      }
    }),
  );
  for (const syncItem of pendingLifecycleSyncs) {
    const syncCorrelationId = `corr-leaver-reassign-${syncItem.matter.id}-${Date.now()}`;
    try {
      void syncMatterLifecycleOnSaveSync({
        matter: syncItem.matter,
        previousMatter: syncItem.previousMatter,
        userId: byId,
        correlationId: syncCorrelationId,
        store: syncItem.store,
      }).catch((err) => {
        logDocumentLifecycleSyncError(err, syncCorrelationId);
      });
    } catch (err) {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    }
  }
  return { reassignedCount: count };
}

export async function savePersonRecord(
  input: Partial<Person> & { firstName: string; surname: string },
  opts: {
    id?: string;
    byId: string;
    mfaVerified?: boolean;
    customFieldsSubmitted?: Record<string, unknown>;
    flagPossibleDuplicate?: boolean;
    matchedDuplicateIds?: string[];
    worksAtFirm?: boolean;
    employmentSubmitted?: Partial<EmploymentRecord> | null;
    sensitiveSubmitted?: Partial<EmployeeSensitiveRecord> | null;
    sensitiveSectionOpened?: boolean;
    sensitiveSectionEdited?: boolean;
    keepAsContactOnLeave?: boolean;
    internalSystemStep?: 'enquiry_conversion' | 'quote_conversion';
    initialLink?: {
      organisationId: string;
      jobTitle?: string;
      department?: string;
      roleWithinOrganisation?: string;
      contactRoleIds?: string[];
      isPrimaryContact?: boolean;
      startDate?: string | null;
    } | null;
  },
): Promise<({ person: Person; errors?: Record<string, string> } & Partial<ActionDenied>)> {
  const pendingLifecycleSyncs: Array<{
    matter: Matter;
    previousMatter: Matter;
    store: FirmStore;
  }> = [];
  const res = await (async (): Promise<
    ({ person: Person; errors?: Record<string, string> } & Partial<ActionDenied>)
  > => {
  const personCtx = resolveDefaultServiceTenantContext(null, opts?.byId);
  const store = await loadTenantCatalogueStoreView(personCtx);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const hrRepo = getHrAndRbacRepository();
  const [people, organisations, matters, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(personCtx),
    partyRepo.listAllOrganisations<Organisation>(personCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(personCtx),
    hrRepo.listAllTeams<Team>(personCtx),
  ]);
  const now = new Date().toISOString();
  const today = toIsoDate(new Date());
  const existing = opts.id ? people.find((p) => p.id === opts.id) ?? null : null;
  const deny = (
    code: 'FORBIDDEN' | 'MFA_REQUIRED',
    message: string,
    key = 'permission',
  ) => ({
    ...buildActionDenied(code, message),
    person: existing as Person,
    errors: { [key]: message },
  });
  // Promoting a synthetic enquiry caller (`id: "ENQ-..."`) creates a new Person linked via
  // `createdFromEnquiryId`, provided the referenced enquiry actually exists in this tenant's store;
  // any unknown or tampered `opts.id` (including a tampered `ENQ-...` ID) is rejected as not found.
  const existingEnquiryForPromotion =
    opts.id && opts.id.startsWith('ENQ-')
      ? await getIntakeQuoteRepository().getEnquiryById<Enquiry>(personCtx, opts.id, {
          includeRestricted: true,
        })
      : null;
  if (opts.id && !existing && !existingEnquiryForPromotion) {
    return deny('FORBIDDEN', 'Person record not found.', 'id');
  }
  const actingUser = people.find((p) => p.id === opts.byId) ?? null;
  const rbacConfig = await loadEffectiveTenantRbacConfig(personCtx);
  const permSet = resolvePersonPermissionSet(actingUser, {
    allPeople: people,
    teams,
    targetPersonId: existing?.id,
    mfaVerified: opts.mfaVerified,
    config: { rbac: rbacConfig },
  });
  const userPerms = new Set([
    ...resolveEmployeePermissions(actingUser, people, teams, {
      targetPersonId: existing?.id,
      config: { rbac: rbacConfig },
    }),
    ...Array.from(permSet.permissions),
  ]);
  const orgStructure =
    store.orgStructure ??
    buildDefaultOrgStructure({
      legalName: getActiveTenantConfiguration().displayName,
    });

  // B11: Reject any attempt to set or change RBAC / security fields via savePersonRecord.
  const PERSON_SECURITY_FIELDS = [
    'roles',
    'permissionOverrides',
    'appRole',
    'employeePermissions',
    'documentPermissions',
    'supportsIds',
    'showsWorkOfId',
    'demo',
    'entraObjectId',
  ] as const;
  const attemptedSecurityField = PERSON_SECURITY_FIELDS.find((key) => {
    if (input[key] === undefined) return false;
    if (!existing) return true;
    // Allow unchanged values only when the caller spread an existing Person record (`{ ...existingPerson, ... }`).
    if (input.createdAt !== undefined && input.createdAt === existing.createdAt) {
      return JSON.stringify(input[key]) !== JSON.stringify(existing[key]);
    }
    return true;
  });
  if (attemptedSecurityField) {
    return deny(
      'FORBIDDEN',
      `Security field "${attemptedSecurityField}" cannot be set or modified through person save. Use the dedicated RBAC administration actions.`,
    );
  }

  if (!input.firstName?.trim() || !input.surname?.trim()) {
    return { person: existing as Person, errors: { name: 'First name and surname are required.' } };
  }

  // Determine whether the person works at the firm (or has an employment record)
  const hasEmploymentPayload =
    opts.employmentSubmitted !== undefined
      ? opts.employmentSubmitted !== null
      : input.employment !== undefined
        ? input.employment !== null
        : opts.worksAtFirm !== undefined
          ? opts.worksAtFirm
          : Boolean(input.isEmployee ?? existing?.employment ?? existing?.isEmployee);

  const rawEmpInput: Partial<EmploymentRecord> | null =
    opts.employmentSubmitted ?? input.employment ?? null;

  const effectiveDob =
    input.dateOfBirth !== undefined ? input.dateOfBirth : existing?.dateOfBirth ?? null;
  // Pure candidate ID: only allocate from PostgreSQL sequence after all permission, MFA, and validation gates pass.
  const targetPersonId = existing?.id ?? 'P-PENDING';

  let workingEmails = input.emails;
  let workingPhones = input.phones;
  let workingRelationshipRoleIds = input.relationshipRoleIds;
  let missingEmployeeRoleType = false;
  let empErrors: Record<string, string> = {};

  // Build or merge the EmploymentRecord when the person works at the firm (or is a leaver with employment history)
  let nextEmployment: EmploymentRecord | null = existing?.employment
    ? structuredClone(existing.employment)
    : null;

  if (hasEmploymentPayload || rawEmpInput) {
    const firmPrimaryDomain = resolveConfiguredFirmPrimaryDomain();
    const baseEmp =
      nextEmployment ??
      createDefaultEmploymentRecord({
        person: {
          ...existing,
          ...input,
          id: targetPersonId,
          firstName: input.firstName.trim(),
          surname: input.surname.trim(),
          jobTitle: rawEmpInput?.jobTitle ?? existing?.employment?.jobTitle ?? input.jobTitle ?? '',
        },
        allPeople: people,
        orgStructure,
        byId: opts.byId,
        nowIso: now,
        status: rawEmpInput?.status ?? (input.isEmployee ? 'Active' : 'Pre-start'),
        primaryDomain: firmPrimaryDomain,
      });

    // If legacy callers passed employeeRoleId or departmentId without rawEmpInput, map them
    const mappedLegacyRole =
      !rawEmpInput?.roleType && input.employeeRoleId
        ? mapLegacyEmployeeRoleToRoleType(input.employeeRoleId)
        : null;
    const mappedLegacyDept =
      !rawEmpInput?.departmentId && input.departmentId
        ? resolveOrgDepartment(input.departmentId, orgStructure)
        : null;

    if (input.isEmployee && !rawEmpInput && !input.employeeRoleId && !existing?.employeeRoleId && !existing?.employment?.roleType) {
      missingEmployeeRoleType = true;
    }

    const resolvedDept =
      resolveOrgDepartment(
        rawEmpInput?.departmentId ?? mappedLegacyDept?.id ?? baseEmp.departmentId,
        orgStructure,
      ) ?? null;

    const mergedLineManagerId =
      rawEmpInput?.lineManagerId !== undefined
        ? rawEmpInput.lineManagerId
        : baseEmp.lineManagerId;

    const candidateEmp: EmploymentRecord = {
      ...baseEmp,
      personId: targetPersonId,
      engagementType:
        rawEmpInput?.engagementType ??
        mappedLegacyRole?.engagementType ??
        baseEmp.engagementType,
      status: rawEmpInput?.status ?? baseEmp.status,
      employeeNumber: (rawEmpInput?.employeeNumber ?? baseEmp.employeeNumber ?? '').trim(),
      employingEntityId: rawEmpInput?.employingEntityId ?? baseEmp.employingEntityId,
      // Firm job title lives on the employment record, separate from contact person.jobTitle
      jobTitle: (
        rawEmpInput?.jobTitle ??
        existing?.employment?.jobTitle ??
        baseEmp.jobTitle ??
        ''
      ).trim(),
      gradeOrBand: rawEmpInput?.gradeOrBand ?? baseEmp.gradeOrBand,
      roleType:
        rawEmpInput?.roleType ?? mappedLegacyRole?.roleType ?? baseEmp.roleType,
      divisionId:
        rawEmpInput?.divisionId !== undefined
          ? rawEmpInput.divisionId
          : resolvedDept?.parentDivisionId ?? baseEmp.divisionId,
      departmentId:
        resolvedDept?.id ?? rawEmpInput?.departmentId ?? baseEmp.departmentId ?? '',
      teamOrPracticeGroupId:
        rawEmpInput?.teamOrPracticeGroupId !== undefined
          ? rawEmpInput.teamOrPracticeGroupId
          : baseEmp.teamOrPracticeGroupId,
      officeId:
        rawEmpInput?.officeId !== undefined ? rawEmpInput.officeId : baseEmp.officeId,
      costCentreId:
        rawEmpInput?.costCentreId !== undefined && rawEmpInput.costCentreId !== ''
          ? rawEmpInput.costCentreId
          : resolvedDept?.defaultCostCentreId ?? baseEmp.costCentreId,
      profitCentreId:
        rawEmpInput?.profitCentreId !== undefined && rawEmpInput.profitCentreId !== ''
          ? rawEmpInput.profitCentreId
          : resolvedDept?.defaultProfitCentreId ?? baseEmp.profitCentreId,
      isTopOfHierarchy:
        rawEmpInput?.isTopOfHierarchy !== undefined
          ? rawEmpInput.isTopOfHierarchy
          : baseEmp.isTopOfHierarchy,
      lineManagerId: mergedLineManagerId,
      supervisingPartnerId:
        rawEmpInput?.supervisingPartnerId !== undefined
          ? rawEmpInput.supervisingPartnerId
          : baseEmp.supervisingPartnerId,
      timesheetApproverId:
        rawEmpInput?.timesheetApproverId !== undefined && rawEmpInput.timesheetApproverId !== null
          ? rawEmpInput.timesheetApproverId
          : mergedLineManagerId,
      holidayApproverId:
        rawEmpInput?.holidayApproverId !== undefined && rawEmpInput.holidayApproverId !== null
          ? rawEmpInput.holidayApproverId
          : mergedLineManagerId,
      onboardingBuddyId:
        rawEmpInput?.onboardingBuddyId !== undefined
          ? rawEmpInput.onboardingBuddyId
          : baseEmp.onboardingBuddyId,
      effectiveFrom: rawEmpInput?.effectiveFrom || baseEmp.effectiveFrom || today,
      effectiveTo:
        rawEmpInput?.effectiveTo !== undefined ? rawEmpInput.effectiveTo : baseEmp.effectiveTo,
      contract:
        rawEmpInput?.contract !== undefined
          ? rawEmpInput.contract
            ? {
                ...baseEmp.contract!,
                ...rawEmpInput.contract,
                continuousServiceDate:
                  rawEmpInput.contract.continuousServiceDate ||
                  rawEmpInput.contract.startDate ||
                  baseEmp.contract?.continuousServiceDate ||
                  today,
              }
            : null
          : baseEmp.contract,
      feeEarner:
        rawEmpInput?.feeEarner !== undefined
          ? rawEmpInput.feeEarner
          : baseEmp.feeEarner,
      rightToWork:
        rawEmpInput?.rightToWork !== undefined
          ? rawEmpInput.rightToWork
          : baseEmp.rightToWork,
      payroll:
        rawEmpInput?.payroll !== undefined
          ? rawEmpInput.payroll
          : baseEmp.payroll,
      emergencyContacts:
        rawEmpInput?.emergencyContacts !== undefined
          ? rawEmpInput.emergencyContacts
          : baseEmp.emergencyContacts,
      systems:
        rawEmpInput?.systems !== undefined
          ? rawEmpInput.systems
          : baseEmp.systems,
      updatedById: opts.byId,
      updatedAt: now,
    };

    // Only enforce full employment field validation when employmentSubmitted was explicitly provided
    // (or when creating/editing via the full employee form)
    if (rawEmpInput) {
      empErrors = validateEmploymentRecord(candidateEmp, {
        personId: targetPersonId,
        dateOfBirth: effectiveDob,
        allPeople: people,
        orgStructure,
        requireContractStartDate: Boolean(rawEmpInput.contract),
      });
    }

    nextEmployment = applyEffectiveDatedEmploymentHistory(
      existing?.employment,
      candidateEmp,
      opts.byId,
      now,
    );
  } else if (opts.worksAtFirm === false && existing?.employment) {
    // If unchecked and status wasn't already Leaver, transition to Leaver
    const leavingRes = applyLeaverEffects(
      {
        emails: workingEmails ?? existing.emails ?? [],
        phones: workingPhones ?? existing.phones ?? [],
        relationshipRoleIds: workingRelationshipRoleIds ?? existing.relationshipRoleIds ?? [],
      },
      existing.employment,
      today,
      opts.keepAsContactOnLeave ?? true,
      resolveConfiguredFirmPrimaryDomain(),
    );
    workingEmails = leavingRes.emails;
    workingPhones = leavingRes.phones;
    workingRelationshipRoleIds = leavingRes.relationshipRoleIds;
    nextEmployment = leavingRes.employment;
  }

  // Handle conversion path 3: Status set to 'Leaver'
  if (nextEmployment && nextEmployment.status === 'Leaver') {
    const leavingDate =
      nextEmployment.contract?.leavingDate || nextEmployment.effectiveTo || today;
    const leavingRes = applyLeaverEffects(
      {
        emails: workingEmails ?? existing?.emails ?? [],
        phones: workingPhones ?? existing?.phones ?? [],
        relationshipRoleIds: workingRelationshipRoleIds ?? existing?.relationshipRoleIds ?? [],
      },
      nextEmployment,
      leavingDate,
      opts.keepAsContactOnLeave ?? nextEmployment.contract?.keepAsContactOnLeave ?? true,
      resolveConfiguredFirmPrimaryDomain(),
    );
    workingEmails = leavingRes.emails;
    workingPhones = leavingRes.phones;
    workingRelationshipRoleIds = leavingRes.relationshipRoleIds;
    nextEmployment = leavingRes.employment;
  }

  const cfValidation = validateCustomFields(
    store.customFields,
    'person',
    opts.customFieldsSubmitted ?? input.customFields ?? {},
    existing?.customFields ?? {},
    store.values,
  );

  // Handle conversion path 1: Contact or client becomes an employee (pure metadata first; store side effects run after gates pass)
  const wasWorkingAtFirm = isWorkingAtFirm(existing);
  const nowWorkingAtFirm = Boolean(nextEmployment && nextEmployment.status !== 'Leaver');
  const openMattersOnHire =
    !wasWorkingAtFirm && nowWorkingAtFirm && nextEmployment
      ? findOpenMattersWherePersonIsParty(targetPersonId, matters)
      : [];
  if (!wasWorkingAtFirm && nowWorkingAtFirm && nextEmployment) {
    nextEmployment.conflictCheckOnHire = {
      checkedAt: now,
      openMatterIds: openMattersOnHire.map((m) => m.id),
      flaggedToRisk: openMattersOnHire.length > 0,
      informationBarrierConsidered: openMattersOnHire.length > 0,
      riskNotes:
        openMattersOnHire.length > 0
          ? `Person is a party on ${openMattersOnHire.length} open matter(s) (${openMattersOnHire.map((m) => m.matterNumber).join(', ')}). Flagged to Risk & Compliance to consider an information barrier.`
          : 'No open matter conflicts detected on hire.',
    };
  }

  const defaultStatus = valueBySystemKey(store.values, 'person_record_status', 'active')!.id;
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const dupPossible = valueBySystemKey(store.values, 'duplicate_status', 'possible_match')!.id;

  const duplicateStatusId = opts.flagPossibleDuplicate
    ? dupPossible
    : input.duplicateStatusId ?? existing?.duplicateStatusId ?? dupNone;

  const matchedIds = opts.flagPossibleDuplicate
    ? Array.from(new Set([...(existing?.possibleMatchIds ?? []), ...(opts.matchedDuplicateIds ?? [])]))
    : existing?.possibleMatchIds ?? [];

  // Preserve contact jobTitle when editing employment jobTitle (never overwrite contact jobTitle with firm jobTitle)
  const contactJobTitle =
    input.jobTitle !== undefined ? input.jobTitle.trim() : existing?.jobTitle ?? '';

  // Preserve marketingConsentId: being an employee must not change Marketing consent
  const preservedMarketingConsentId =
    input.marketingConsentId !== undefined
      ? input.marketingConsentId
      : existing?.marketingConsentId ?? vid('marketing_consent', 'Not asked');

  // Preserve Client ID verificationStatusId: Right-to-work evidence must not automatically satisfy client ID verification
  const preservedVerificationStatusId =
    input.verificationStatusId !== undefined
      ? input.verificationStatusId
      : existing?.verificationStatusId ?? vid('verification_status', 'Not required');

  let person: Person = {
    id: targetPersonId,
    recordType: 'person',
    recordOwnerId: input.recordOwnerId ?? existing?.recordOwnerId ?? opts.byId,
    recordStatusId: input.recordStatusId || existing?.recordStatusId || defaultStatus,
    createdById: existing?.createdById ?? opts.byId,
    createdAt: existing?.createdAt ?? now,
    updatedById: opts.byId,
    updatedAt: now,
    sourceId: input.sourceId ?? existing?.sourceId ?? vid('data_source', 'Manual entry'),
    lastVerifiedAt: input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : existing?.lastVerifiedAt ?? today,
    tags: input.tags ?? existing?.tags ?? [],
    duplicateStatusId,
    notDuplicateOf: existing?.notDuplicateOf ?? [],
    possibleMatchIds: matchedIds,
    mergedIntoId: existing?.mergedIntoId ?? null,
    lastInteractionAt:
      input.lastInteractionAt !== undefined ? input.lastInteractionAt : existing?.lastInteractionAt ?? null,
    customFields: cfValidation.values,

    titleId: input.titleId ?? existing?.titleId ?? null,
    firstName: input.firstName.trim(),
    middleNames: (input.middleNames ?? existing?.middleNames ?? '').trim(),
    surname: input.surname.trim(),
    preferredName: (input.preferredName ?? existing?.preferredName ?? '').trim(),
    dateOfBirth: effectiveDob,
    otherNames: input.otherNames ?? existing?.otherNames ?? [],
    jobTitle: contactJobTitle,
    emails: (workingEmails ?? existing?.emails ?? []).map((e) => ({ ...e })),
    phones: (workingPhones ?? existing?.phones ?? []).map((p) => ({ ...p })),
    preferredContactMethodId: input.preferredContactMethodId ?? existing?.preferredContactMethodId ?? null,
    preferredLanguageId:
      input.preferredLanguageId ?? existing?.preferredLanguageId ?? vid('language', 'English'),
    addresses: input.addresses ?? existing?.addresses ?? [],
    website: (input.website ?? existing?.website ?? '').trim(),

    relationshipOwnerId:
      input.relationshipOwnerId !== undefined
        ? input.relationshipOwnerId
        : existing?.relationshipOwnerId ?? opts.byId,
    relationshipStatusId:
      input.relationshipStatusId !== undefined
        ? input.relationshipStatusId
        : existing?.relationshipStatusId ?? vid('relationship_status', 'Active'),
    relationshipStandingId:
      input.relationshipStandingId !== undefined
        ? input.relationshipStandingId
        : existing?.relationshipStandingId ?? null,
    relationshipRoleIds: [...(workingRelationshipRoleIds ?? existing?.relationshipRoleIds ?? [])],
    originId: input.originId !== undefined ? input.originId : existing?.originId ?? null,
    firstKnownAt: input.firstKnownAt !== undefined ? input.firstKnownAt : existing?.firstKnownAt ?? today,
    engagementLevelId:
      input.engagementLevelId !== undefined ? input.engagementLevelId : existing?.engagementLevelId ?? null,
    interests: input.interests ?? existing?.interests ?? '',
    relationshipNotes: input.relationshipNotes ?? existing?.relationshipNotes ?? '',
    marketingConsentId: preservedMarketingConsentId,
    consentRecord: input.consentRecord ?? existing?.consentRecord ?? '',

    verificationStatusId: preservedVerificationStatusId,
    verifiedAt: input.verifiedAt !== undefined ? input.verifiedAt : existing?.verifiedAt ?? null,
    verificationMethodId:
      input.verificationMethodId !== undefined ? input.verificationMethodId : existing?.verificationMethodId ?? null,
    verificationReviewerId:
      input.verificationReviewerId !== undefined
        ? input.verificationReviewerId
        : existing?.verificationReviewerId ?? null,
    riskReferences: input.riskReferences ?? existing?.riskReferences ?? '',

    isEmployee: nowWorkingAtFirm,
    employeeRoleId: nowWorkingAtFirm
      ? nextEmployment
        ? mapRoleTypeToLegacyEmployeeRoleId(
            nextEmployment.roleType,
            input.employeeRoleId ?? existing?.employeeRoleId,
          )
        : input.employeeRoleId ?? existing?.employeeRoleId ?? null
      : null,
    departmentId: nowWorkingAtFirm
      ? nextEmployment
        ? resolveOrgDepartment(nextEmployment.departmentId, orgStructure)?.legacyChoiceValueId ??
          nextEmployment.departmentId
        : input.departmentId ?? existing?.departmentId ?? null
      : null,
    employment: nextEmployment,
    ...(existing?.entraObjectId !== undefined
      ? { entraObjectId: existing.entraObjectId }
      : {}),
    ...(existing?.employeePermissions !== undefined
      ? { employeePermissions: existing.employeePermissions }
      : {}),
    ...(existing?.documentPermissions !== undefined
      ? { documentPermissions: existing.documentPermissions }
      : {}),
    ...(existing?.permissionOverrides !== undefined
      ? { permissionOverrides: existing.permissionOverrides }
      : {}),
    ...(existing?.appRole !== undefined
      ? { appRole: existing.appRole }
      : {}),
    ...(existing?.roles !== undefined
      ? { roles: existing.roles }
      : {}),
    ...(existing?.demo !== undefined
      ? { demo: existing.demo }
      : {}),
    ...(existing?.showsWorkOfId !== undefined
      ? { showsWorkOfId: existing.showsWorkOfId }
      : {}),
    ...(existing?.supportsIds !== undefined
      ? { supportsIds: existing.supportsIds }
      : {}),
    createdFromEnquiryId:
      input.createdFromEnquiryId ??
      existing?.createdFromEnquiryId ??
      (opts.id?.startsWith('ENQ-') ? opts.id : null),
  };

  if (person.employment) {
    if (
      person.employment.systems &&
      input.emails !== undefined &&
      rawEmpInput?.systems?.firmWorkEmail === undefined
    ) {
      const currentFirmEmail = (person.employment.systems.firmWorkEmail ?? '')
        .trim()
        .toLowerCase();
      const stillHasOldFirmEmail =
        Boolean(currentFirmEmail) &&
        person.emails.some(
          (e) =>
            e.active !== false &&
            e.address.trim().toLowerCase() === currentFirmEmail,
        );
      if (!stillHasOldFirmEmail) {
        const replacementPrimary =
          person.emails.find((e) => e.active !== false && e.isPrimary) ??
          person.emails.find((e) => e.active !== false) ??
          null;
        person.employment.systems = {
          ...person.employment.systems,
          firmWorkEmail: replacementPrimary?.address.trim() ?? '',
        };
      }
    }
    person = syncPersonWorkContactFlags(
      person,
      orgStructure,
      resolveConfiguredFirmPrimaryDomain(),
    );
  }

  if (person.emails.length > 0 && !person.emails.some((e) => e.active !== false && e.isPrimary)) {
    const firstActive = person.emails.find((e) => e.active !== false) ?? person.emails[0];
    firstActive.isPrimary = true;
  }

  // S0-30 (B13, R393, R398): Evaluate employee email identity changes from the FINAL synced `person`
  const normaliseActivePersonEmails = (
    emails: Person['emails'] | undefined,
  ): string[] => {
    if (!Array.isArray(emails)) return [];
    const set = new Set<string>();
    for (const em of emails) {
      if (em.active === false) continue;
      const addr = (em.address ?? '').trim().toLowerCase();
      if (addr) set.add(addr);
    }
    return Array.from(set).sort();
  };
  const isExistingEmployeeOrLeaver = Boolean(
    existing && (existing.isEmployee || existing.employment),
  );
  const isFinalEmployeeOrLeaver = Boolean(
    isExistingEmployeeOrLeaver || person.isEmployee || person.employment,
  );
  const prevActiveEmails = isExistingEmployeeOrLeaver
    ? normaliseActivePersonEmails(existing!.emails)
    : [];
  const nextActiveEmails = isFinalEmployeeOrLeaver
    ? normaliseActivePersonEmails(person.emails)
    : [];
  const prevFirmWorkEmail = isExistingEmployeeOrLeaver
    ? (existing!.employment?.systems?.firmWorkEmail ?? '').trim().toLowerCase()
    : '';
  const nextFirmWorkEmail = isFinalEmployeeOrLeaver
    ? (person.employment?.systems?.firmWorkEmail ?? '').trim().toLowerCase()
    : '';
  const isFirmWorkEmailIdentityChange =
    isFinalEmployeeOrLeaver && nextFirmWorkEmail !== prevFirmWorkEmail;
  const isEmployeeEmailIdentityChange =
    isFinalEmployeeOrLeaver &&
    (JSON.stringify(prevActiveEmails) !== JSON.stringify(nextActiveEmails) ||
      isFirmWorkEmailIdentityChange);
  const prevActiveEmailSet = new Set(prevActiveEmails);
  const addedEmployeeEmails = isFinalEmployeeOrLeaver
    ? Array.from(
        new Set([
          ...nextActiveEmails.filter((addr) => !prevActiveEmailSet.has(addr)),
          ...(isFirmWorkEmailIdentityChange && nextFirmWorkEmail
            ? [nextFirmWorkEmail]
            : []),
        ]),
      ).sort()
    : [];

  if (isEmployeeEmailIdentityChange) {
    if (!userPerms.has('employee:edit_core')) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:edit_core) to change an employee or leaver email address.',
      );
    }
    if (addedEmployeeEmails.length > 0) {
      const effectiveMfaVerified = opts.mfaVerified ?? permSet.mfaVerified;
      if (effectiveMfaVerified !== true) {
        return deny(
          'MFA_REQUIRED',
          'Multi-factor authentication (MFA) is required to change an employee or leaver email address.',
          'mfa',
        );
      }
    }
  }

  const isLegacyEmployeeFieldChange =
    (input.isEmployee !== undefined &&
      Boolean(input.isEmployee) !== Boolean(existing?.isEmployee)) ||
    (opts.worksAtFirm !== undefined &&
      Boolean(opts.worksAtFirm) !== Boolean(existing?.employment && existing.employment.status !== 'Leaver')) ||
    (opts.worksAtFirm === false && Boolean(existing?.employment || existing?.isEmployee)) ||
    (input.employeeRoleId !== undefined &&
      (input.employeeRoleId ?? null) !== (existing?.employeeRoleId ?? null)) ||
    (input.departmentId !== undefined &&
      (input.departmentId ?? null) !== (existing?.departmentId ?? null)) ||
    (input.employment !== undefined &&
      JSON.stringify(input.employment ?? null) !== JSON.stringify(existing?.employment ?? null));

  const requiresEmployeeEditCore =
    Boolean(rawEmpInput) ||
    hasEmploymentPayload ||
    isLegacyEmployeeFieldChange;

  if (requiresEmployeeEditCore) {
    if (!userPerms.has('employee:edit_core')) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:edit_core) to create or edit employment records.',
      );
    }
  } else if (!opts.internalSystemStep) {
    const requiredContactKey = existing ? 'contact:edit' : 'contact:create';
    if (!userPerms.has(requiredContactKey)) {
      return deny(
        'FORBIDDEN',
        existing
          ? 'You do not have permission (contact:edit) to edit contact records.'
          : 'You do not have permission (contact:create) to create contact records.',
      );
    }
  }

  // Enforce API-level permission checks on employment & sensitive data modifications
  if (rawEmpInput) {
    if (!userPerms.has('employee:edit_core')) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:edit_core) to create or edit employment records.',
      );
    }
    if (
      (rawEmpInput.contract !== undefined ||
        rawEmpInput.rightToWork !== undefined ||
        rawEmpInput.emergencyContacts !== undefined) &&
      !userPerms.has('employee:hr_restricted')
    ) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:hr_restricted) to edit HR restricted fields (contract, right to work, emergency contacts).',
      );
    }
    if (rawEmpInput.payroll !== undefined && !userPerms.has('employee:payroll')) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:payroll) to edit payroll and benefits fields.',
      );
    }
  }

  if (opts.sensitiveSubmitted !== undefined && opts.sensitiveSubmitted !== null) {
    if (!userPerms.has('employee:sensitive')) {
      return deny(
        'FORBIDDEN',
        'You do not have permission (employee:sensitive) to edit sensitive employee information.',
      );
    }
  }

  if (missingEmployeeRoleType) {
    return {
      person: existing as Person,
      errors: { employeeRoleId: 'An employee must have a role type.' },
    };
  }
  if (Object.keys(empErrors).length > 0) {
    return { person: existing as Person, errors: empErrors };
  }
  if (Object.keys(cfValidation.errors).length > 0) {
    return { person: existing as Person, errors: cfValidation.errors };
  }

  const changedMattersOnHire: Array<{ matter: Matter; prevMatter: Matter }> = [];
  const changedDuplicatePeople: Array<{ person: Person; prevPerson: Person }> = [];

  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(personCtx, async () => {
      if (!existing) {
        const allocatedId = await partyRepo.allocateNextPersonId(personCtx);
        person.id = allocatedId;
        if (person.employment) {
          person.employment.personId = allocatedId;
        }
      }

      if (openMattersOnHire.length > 0 && person.employment?.conflictCheckOnHire) {
        for (const m of openMattersOnHire) {
          if (m.clientId === person.id || m.additionalClientIds?.includes(person.id)) {
            const prevMatter = structuredClone(m);
            m.isStaffMatter = true;
            const allowed = new Set<string>([
              ...(m.restrictedAccessUserIds ?? []),
              ...(m.responsiblePartnerId ? [m.responsiblePartnerId] : []),
              ...(m.supervisingPartnerId ? [m.supervisingPartnerId] : []),
              ...(m.leadFeeEarnerId ? [m.leadFeeEarnerId] : []),
              ...(m.teamMemberIds ?? []),
            ]);
            m.restrictedAccessUserIds = Array.from(allowed);
            touchMatter(m, opts.byId);
            changedMattersOnHire.push({ matter: m, prevMatter });
          }
        }
        if (changedMattersOnHire.length > 0) {
          await matterRepo.lockMattersForRestrictionRecompute<Matter>(personCtx, {
            matterIds: changedMattersOnHire.map((x) => x.matter.id),
          });
        }

        const riskOfficerId =
          people.find(
            (p) =>
              isWorkingAtFirm(p) &&
              (p.roles?.includes('risk_compliance') ||
                p.employeeRoleId === 'employee_role.risk_and_compliance'),
          )?.id ?? opts.byId;
        const notifId = await getTaskWorkflowRepository().allocateNextNotificationId(personCtx);
        await getTaskWorkflowRepository().putNotification(personCtx, {
          id: notifId,
          recipientId: riskOfficerId,
          kind: 'task_assigned',
          title: `Information barrier review required: ${input.firstName.trim()} ${input.surname.trim()}`,
          detail: `${input.firstName.trim()} ${input.surname.trim()} is joining the firm and is a party on open matter(s): ${openMattersOnHire.map((m) => m.matterNumber).join(', ')}.`,
          href: `/people/${person.id}`,
          recordId: person.id,
          createdAt: now,
          read: false,
          byId: opts.byId,
        });

        writeAudit(store, {
          recordType: 'person',
          recordId: person.id,
          action: 'status-change',
          field: 'Conflict check on hire (Risk flag)',
          oldValue: 'External contact / client',
          newValue: person.employment.conflictCheckOnHire.riskNotes,
          byId: opts.byId,
          at: now,
        });
      }

      if (rawEmpInput?.payroll) {
        const oldPay = existing?.employment?.payroll;
        const newPay = nextEmployment?.payroll;
        if (JSON.stringify(oldPay ?? null) !== JSON.stringify(newPay ?? null)) {
          writeAudit(store, {
            recordType: 'employee_payroll',
            recordId: person.id,
            action: 'update-payroll',
            field: 'Payroll & benefits',
            oldValue: oldPay
              ? `NI: ${maskNationalInsuranceNumber(oldPay.nationalInsuranceNumber || '')}, Bank: ${maskBankDetails(oldPay.bankSortCode || '', oldPay.bankAccountNumber || '').accountNumber}`
              : null,
            newValue: newPay
              ? `NI: ${maskNationalInsuranceNumber(newPay.nationalInsuranceNumber || '')}, Bank: ${maskBankDetails(newPay.bankSortCode || '', newPay.bankAccountNumber || '').accountNumber}, Ref: ${newPay.externalPayrollReference || '—'}`
              : null,
            byId: opts.byId,
            at: now,
          });
        }
      }

      const oldSens = existing
        ? await hrRepo.getSensitiveRecord<EmployeeSensitiveRecord>(personCtx, person.id)
        : null;
      const canApplySensitiveSubmission =
        Boolean(opts.sensitiveSubmitted) &&
        opts.sensitiveSectionOpened !== false &&
        opts.sensitiveSectionEdited !== false &&
        (!oldSens ||
          (opts.sensitiveSectionOpened === true &&
            opts.sensitiveSectionEdited === true));

      let nextSensToPersist: EmployeeSensitiveRecord | null = null;
      if (canApplySensitiveSubmission && opts.sensitiveSubmitted) {
        const nextSens: EmployeeSensitiveRecord = {
          personId: person.id,
          reasonableAdjustmentsNeeded:
            opts.sensitiveSubmitted.reasonableAdjustmentsNeeded ??
            oldSens?.reasonableAdjustmentsNeeded ??
            '',
          diversity: {
            ...emptyDiversityAnswers(),
            ...(oldSens?.diversity ?? {}),
            ...(opts.sensitiveSubmitted.diversity ?? {}),
          },
          updatedById: opts.byId,
          updatedAt: now,
        };
        if (JSON.stringify(oldSens) !== JSON.stringify(nextSens)) {
          nextSensToPersist = nextSens;
          writeAudit(store, {
            recordType: 'employee_sensitive',
            recordId: person.id,
            action: 'update-sensitive',
            field: 'Sensitive information (special category data)',
            oldValue: oldSens ? 'Recorded' : null,
            newValue: `Updated by ${actingUser ? personDisplayName(actingUser) : opts.byId}`,
            byId: opts.byId,
            at: now,
          });
        }
      }

      const auditOldActiveEmails =
        isFirmWorkEmailIdentityChange && prevFirmWorkEmail
          ? Array.from(new Set([...prevActiveEmails, prevFirmWorkEmail])).sort()
          : prevActiveEmails;
      const auditNewActiveEmails =
        isFirmWorkEmailIdentityChange && nextFirmWorkEmail
          ? Array.from(new Set([...nextActiveEmails, nextFirmWorkEmail])).sort()
          : nextActiveEmails;

      const fmtCtx = formatContext({
        people,
        organisations,
        matters,
        enquiries: [],
        tasks: [],
        teams,
        values: store.values,
      });
      if (!existing) {
        writeAudit(store, {
          recordType: 'person',
          recordId: person.id,
          action: 'create',
          field: null,
          oldValue: null,
          newValue: personDisplayName(person),
          byId: opts.byId,
          at: now,
        });
        if (isEmployeeEmailIdentityChange) {
          writeAudit(store, {
            recordType: 'person',
            recordId: person.id,
            action: 'update',
            field: 'Employee sign-in email',
            oldValue: auditOldActiveEmails.join(', ') || null,
            newValue: auditNewActiveEmails.join(', ') || null,
            byId: opts.byId,
            at: now,
          });
        }
      } else {
        const changes = diffRecords(
          'person',
          existing as unknown as Record<string, unknown>,
          person as unknown as Record<string, unknown>,
          fmtCtx,
          store.customFields,
        );
        if (isEmployeeEmailIdentityChange) {
          writeAudit(store, {
            recordType: 'person',
            recordId: person.id,
            action: 'update',
            field: 'Employee sign-in email',
            oldValue: auditOldActiveEmails.join(', ') || null,
            newValue: auditNewActiveEmails.join(', ') || null,
            byId: opts.byId,
            at: now,
          });
        }
        for (const ch of changes) {
          writeAudit(store, {
            recordType: 'person',
            recordId: person.id,
            action: 'update',
            field: ch.field,
            oldValue: ch.oldValue,
            newValue: ch.newValue,
            byId: opts.byId,
            at: now,
          });
        }
      }

      if (opts.flagPossibleDuplicate && opts.matchedDuplicateIds?.length) {
        for (const otherId of opts.matchedDuplicateIds) {
          const other = people.find((p) => p.id === otherId);
          if (other && !other.possibleMatchIds.includes(person.id)) {
            const prevPerson = structuredClone(other);
            other.possibleMatchIds.push(person.id);
            other.duplicateStatusId = dupPossible;
            changedDuplicatePeople.push({ person: other, prevPerson });
          }
        }
      }

      await partyRepo.putPerson(personCtx, person);
      if (nextSensToPersist) {
        await hrRepo.putEmployeeSensitiveRecord(personCtx, {
          personId: person.id,
          sensitiveHr: nextSensToPersist,
          updatedById: opts.byId,
          updatedAt: now,
        });
      }
      for (const { person: dupPerson } of changedDuplicatePeople) {
        await partyRepo.putPerson(personCtx, dupPerson);
      }

      // Keep operational teams (PostgreSQL teams) synchronised with the employee's Organisation Structure Department / Team
      if (person.employment) {
        if (person.employment.status === 'Leaver') {
          for (const tm of teams) {
            const prevLen = tm.memberIds.length + tm.leadIds.length;
            tm.memberIds = tm.memberIds.filter((id) => id !== person.id);
            tm.leadIds = tm.leadIds.filter((id) => id !== person.id);
            if (tm.memberIds.length + tm.leadIds.length !== prevLen) {
              await hrRepo.putTeam(personCtx, tm);
            }
          }
        } else {
          const deptId = person.employment.departmentId;
          const tpgId = person.employment.teamOrPracticeGroupId;
          const deptObj = resolveOrgDepartment(deptId, orgStructure);
          const tpgObj = orgStructure.teamsOrPracticeGroups.find((t) => t.id === tpgId);

          const deptToTeamNameMap: Record<string, string> = {
            'DEPT-RE': 'Real Estate & Property',
            'DEPT-CORP': 'Corporate & Commercial',
            'DEPT-DR': 'Dispute Resolution & Litigation',
            'DEPT-PC': 'Private Client, Trusts & Family',
            'DEPT-EMP': 'Employment & HR',
            'DEPT-RISK': 'Risk & Compliance',
            'DEPT-FIN': 'Accounts',
            'DEPT-BD': 'Intake',
          };
          const targetTeamName = deptToTeamNameMap[deptId] ?? tpgObj?.name ?? deptObj?.name ?? '';
          if (targetTeamName) {
            const matchingTeam = teams.find(
              (tm) =>
                tm.name.toLowerCase() === targetTeamName.toLowerCase() ||
                (deptObj && tm.name.toLowerCase().includes(deptObj.name.toLowerCase())),
            );
            if (matchingTeam) {
              let teamChanged = false;
              if (!matchingTeam.memberIds.includes(person.id)) {
                matchingTeam.memberIds.push(person.id);
                teamChanged = true;
              }
              if (
                person.employment.roleType === 'Partner/Member' &&
                !matchingTeam.leadIds.includes(person.id)
              ) {
                matchingTeam.leadIds.push(person.id);
                teamChanged = true;
              }
              if (teamChanged) {
                await hrRepo.putTeam(personCtx, matchingTeam);
              }
            }
          }
        }
      }

      for (const { matter: m } of changedMattersOnHire) {
        await putMatterWithInTxRestrictions(personCtx, m, {
          expectedRowVersion: null,
        });
      }

      if (person.createdFromEnquiryId) {
        const srcEnq = await getIntakeQuoteRepository().getEnquiryById<Enquiry>(
          personCtx,
          person.createdFromEnquiryId,
          { includeRestricted: true },
        );
        if (srcEnq && !srcEnq.linkedPersonId) {
          srcEnq.linkedPersonId = person.id;
          await getIntakeQuoteRepository().putEnquiry(personCtx, srcEnq);
        }
      }

      if (!existing && opts.initialLink?.organisationId) {
        await createOrUpdateLink(
          {
            personId: person.id,
            organisationId: opts.initialLink.organisationId,
            jobTitle: opts.initialLink.jobTitle || person.jobTitle,
            department: opts.initialLink.department || '',
            roleWithinOrganisation: opts.initialLink.roleWithinOrganisation || '',
            contactRoleIds: opts.initialLink.contactRoleIds ?? [],
            isPrimaryContact: Boolean(opts.initialLink.isPrimaryContact),
            isCurrent: true,
            startDate: opts.initialLink.startDate ?? today,
            endDate: null,
            contactStatusId: vid('contact_status', 'Active'),
          },
          opts.byId,
          { internalSystemStep: true },
        );
      }

      if (
        person.isEmployee ||
        existing?.isEmployee ||
        changedMattersOnHire.length > 0
      ) {
        await syncAffectedMattersRestrictionsInTx(personCtx, {
          includeAllRestrictedMatters: true,
        });
      }
      await flushStagedAuditEntries(personCtx);
    }),
  );
  for (const { matter: m, prevMatter } of changedMattersOnHire) {
    pendingLifecycleSyncs.push({
      matter: m,
      previousMatter: prevMatter,
      store,
    });
  }
  return { person };
  })();
  for (const syncItem of pendingLifecycleSyncs) {
    const syncCorrelationId = `corr-lifecycle-sync-${syncItem.matter.id}-${Date.now()}`;
    try {
      void syncMatterLifecycleOnSaveSync({
        matter: syncItem.matter,
        previousMatter: syncItem.previousMatter,
        userId: opts.byId,
        correlationId: syncCorrelationId,
        store: syncItem.store,
      }).catch((err) => {
        logDocumentLifecycleSyncError(err, syncCorrelationId);
      });
    } catch (err) {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    }
  }
  return res;
}

export async function saveOrganisationRecord(
  input: Partial<Organisation> & { legalName: string },
  opts: {
    id?: string;
    byId: string;
    customFieldsSubmitted?: Record<string, unknown>;
    flagPossibleDuplicate?: boolean;
    matchedDuplicateIds?: string[];
    internalSystemStep?: 'enquiry_conversion' | 'quote_conversion';
  },
): Promise<{ organisation: Organisation; errors?: Record<string, string> } & Partial<ActionDenied>> {
  const orgCtx = resolveDefaultServiceTenantContext(null, opts?.byId);
  const store = await loadTenantCatalogueStoreView(orgCtx);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const [people, organisations, matters, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(orgCtx),
    partyRepo.listAllOrganisations<Organisation>(orgCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(orgCtx),
    getHrAndRbacRepository().listAllTeams<Team>(orgCtx),
  ]);
  const now = new Date().toISOString();
  const today = toIsoDate(new Date());
  const existing = opts.id ? organisations.find((o) => o.id === opts.id) ?? null : null;
  if (opts.id && !existing) {
    const msg = 'Organisation not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      organisation: null as unknown as Organisation,
      errors: { notFound: msg },
    };
  }

  if (!opts.internalSystemStep) {
    const actor = people.find((p) => p.id === opts.byId) ?? null;
    const requiredPerm = existing ? 'contact:edit' : 'contact:create';
    if (
      !hasPersonPermission(actor, requiredPerm, {
        allPeople: people,
        teams,
      })
    ) {
      const msg = `You do not have permission (${requiredPerm}) to ${existing ? 'edit' : 'create'} an organisation record.`;
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        organisation: existing as Organisation,
        errors: { permission: msg },
      };
    }
  }

  if (!input.legalName?.trim()) {
    return { organisation: existing as Organisation, errors: { legalName: 'Legal name is required.' } };
  }

  const cfValidation = validateCustomFields(
    store.customFields,
    'organisation',
    opts.customFieldsSubmitted ?? input.customFields ?? {},
    existing?.customFields ?? {},
    store.values,
  );
  if (Object.keys(cfValidation.errors).length > 0) {
    return { organisation: existing as Organisation, errors: cfValidation.errors };
  }

  const defaultStatus = valueBySystemKey(store.values, 'organisation_record_status', 'active')!.id;
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const dupPossible = valueBySystemKey(store.values, 'duplicate_status', 'possible_match')!.id;

  const duplicateStatusId = opts.flagPossibleDuplicate
    ? dupPossible
    : input.duplicateStatusId ?? existing?.duplicateStatusId ?? dupNone;

  const matchedIds = opts.flagPossibleDuplicate
    ? Array.from(new Set([...(existing?.possibleMatchIds ?? []), ...(opts.matchedDuplicateIds ?? [])]))
    : existing?.possibleMatchIds ?? [];

  let organisation!: Organisation;
  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(orgCtx, async () => {
    const allocatedId =
      existing?.id ?? (await partyRepo.allocateNextOrganisationId(orgCtx));
    organisation = {
      id: allocatedId,
      recordType: 'organisation',
      recordOwnerId: input.recordOwnerId ?? existing?.recordOwnerId ?? opts.byId,
      recordStatusId: input.recordStatusId || existing?.recordStatusId || defaultStatus,
      createdById: existing?.createdById ?? opts.byId,
      createdAt: existing?.createdAt ?? now,
      updatedById: opts.byId,
      updatedAt: now,
      sourceId: input.sourceId ?? existing?.sourceId ?? vid('data_source', 'Manual entry'),
      lastVerifiedAt: input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : existing?.lastVerifiedAt ?? today,
      tags: input.tags ?? existing?.tags ?? [],
      duplicateStatusId,
      notDuplicateOf: existing?.notDuplicateOf ?? [],
      possibleMatchIds: matchedIds,
      mergedIntoId: existing?.mergedIntoId ?? null,
      lastInteractionAt:
        input.lastInteractionAt !== undefined ? input.lastInteractionAt : existing?.lastInteractionAt ?? null,
      customFields: cfValidation.values,

      legalName: input.legalName.trim(),
      otherNames: input.otherNames ?? existing?.otherNames ?? [],
      organisationTypeId:
        input.organisationTypeId ?? existing?.organisationTypeId ?? vid('organisation_type', 'Company'),
      companyNumber: (input.companyNumber ?? existing?.companyNumber ?? '').trim(),
      vatNumber: (input.vatNumber ?? existing?.vatNumber ?? '').trim(),
      countryOfRegistrationId:
        input.countryOfRegistrationId ?? existing?.countryOfRegistrationId ?? vid('country', 'United Kingdom'),
      registeredAddress:
        input.registeredAddress !== undefined ? input.registeredAddress : existing?.registeredAddress ?? null,
      correspondenceAddress:
        input.correspondenceAddress !== undefined
          ? input.correspondenceAddress
          : existing?.correspondenceAddress ?? null,
      peopleWithSignificantControl:
        input.peopleWithSignificantControl !== undefined
          ? input.peopleWithSignificantControl
          : existing?.peopleWithSignificantControl ?? [],
      directors:
        input.directors !== undefined
          ? input.directors
          : existing?.directors ?? [],
      website: (input.website ?? existing?.website ?? '').trim(),
      mainPhone: (input.mainPhone ?? existing?.mainPhone ?? '').trim(),
      generalEmail: (input.generalEmail ?? existing?.generalEmail ?? '').trim(),
      parentOrganisationId:
        input.parentOrganisationId !== undefined ? input.parentOrganisationId : existing?.parentOrganisationId ?? null,

      relationshipPartnerId:
        input.relationshipPartnerId !== undefined
          ? input.relationshipPartnerId
          : existing?.relationshipPartnerId ?? opts.byId,
      relationshipTypeIds: input.relationshipTypeIds ?? existing?.relationshipTypeIds ?? [],
      relationshipStatusId:
        input.relationshipStatusId !== undefined
          ? input.relationshipStatusId
          : existing?.relationshipStatusId ?? vid('relationship_status', 'Active'),
      relationshipStandingId:
        input.relationshipStandingId !== undefined
          ? input.relationshipStandingId
          : existing?.relationshipStandingId ?? null,
      sectorId: input.sectorId !== undefined ? input.sectorId : existing?.sectorId ?? null,
      clientTierId: input.clientTierId !== undefined ? input.clientTierId : existing?.clientTierId ?? null,
      originId: input.originId !== undefined ? input.originId : existing?.originId ?? null,
      relationshipStartedAt:
        input.relationshipStartedAt !== undefined
          ? input.relationshipStartedAt
          : existing?.relationshipStartedAt ?? null,
      engagementLevelId:
        input.engagementLevelId !== undefined ? input.engagementLevelId : existing?.engagementLevelId ?? null,
      pipelineStageId:
        input.pipelineStageId !== undefined ? input.pipelineStageId : existing?.pipelineStageId ?? null,
      bdNotes: input.bdNotes ?? existing?.bdNotes ?? '',

      clientReference: (input.clientReference ?? existing?.clientReference ?? '').trim(),
      onboardingStatusId:
        input.onboardingStatusId !== undefined ? input.onboardingStatusId : existing?.onboardingStatusId ?? null,
      conflictStatusId:
        input.conflictStatusId !== undefined ? input.conflictStatusId : existing?.conflictStatusId ?? null,
      conflictReference: (input.conflictReference ?? existing?.conflictReference ?? '').trim(),
      riskRatingId: input.riskRatingId !== undefined ? input.riskRatingId : existing?.riskRatingId ?? null,
      riskAssessmentStatusId:
        input.riskAssessmentStatusId !== undefined
          ? input.riskAssessmentStatusId
          : existing?.riskAssessmentStatusId ?? null,
      verificationStatusId:
        input.verificationStatusId !== undefined ? input.verificationStatusId : existing?.verificationStatusId ?? null,
      billingAddress: input.billingAddress !== undefined ? input.billingAddress : existing?.billingAddress ?? null,
      invoicePreferenceId:
        input.invoicePreferenceId !== undefined ? input.invoicePreferenceId : existing?.invoicePreferenceId ?? null,
      paymentTermsId: input.paymentTermsId !== undefined ? input.paymentTermsId : existing?.paymentTermsId ?? null,
      creditControlNotes: input.creditControlNotes ?? existing?.creditControlNotes ?? '',
      engagementTermsRef: (input.engagementTermsRef ?? existing?.engagementTermsRef ?? '').trim(),
      reviewDate: input.reviewDate !== undefined ? input.reviewDate : existing?.reviewDate ?? null,
      reviewerId: input.reviewerId !== undefined ? input.reviewerId : existing?.reviewerId ?? null,
    };

    const fmtCtx = formatContext({
      people,
      organisations,
      matters,
      enquiries: [],
      tasks: [],
      teams,
      values: store.values,
    });
    if (!existing) {
      writeAudit(store, {
        recordType: 'organisation',
        recordId: organisation.id,
        action: 'create',
        field: null,
        oldValue: null,
        newValue: organisation.legalName,
        byId: opts.byId,
        at: now,
      });
    } else {
      const changes = diffRecords(
        'organisation',
        existing as unknown as Record<string, unknown>,
        organisation as unknown as Record<string, unknown>,
        fmtCtx,
        store.customFields,
      );
      for (const ch of changes) {
        writeAudit(store, {
          recordType: 'organisation',
          recordId: organisation.id,
          action: 'update',
          field: ch.field,
          oldValue: ch.oldValue,
          newValue: ch.newValue,
          byId: opts.byId,
          at: now,
        });
      }
    }

    await partyRepo.putOrganisation(orgCtx, organisation);

    if (opts.flagPossibleDuplicate && opts.matchedDuplicateIds?.length) {
      for (const otherId of opts.matchedDuplicateIds) {
        const other = organisations.find((o) => o.id === otherId);
        if (other && !other.possibleMatchIds.includes(organisation.id)) {
          other.possibleMatchIds.push(organisation.id);
          other.duplicateStatusId = dupPossible;
          await partyRepo.putOrganisation(orgCtx, other);
        }
      }
    }

    await flushStagedAuditEntries(orgCtx);
    }),
  );

  return { organisation };
}

export async function createOrUpdateLink(
  input: Omit<PersonOrganisationLink, 'id' | 'createdById' | 'createdAt' | 'updatedById' | 'updatedAt'> & {
    id?: string;
  },
  byId: string,
  opts?: { internalSystemStep?: boolean },
): Promise<PersonOrganisationLink & Partial<ActionDenied>> {
  const linkCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const now = new Date().toISOString();
  const [people, org, existing] = await Promise.all([
    partyRepo.listAllPeople<Person>(linkCtx),
    partyRepo.getOrganisationById<Organisation>(linkCtx, input.organisationId),
    input.id
      ? partyRepo.getLinkById<PersonOrganisationLink>(linkCtx, input.id)
      : Promise.resolve(null),
  ]);
  if (input.id && !existing) {
    return buildActionDenied(
      'FORBIDDEN',
      `Organisation link "${input.id}" not found.`,
    ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
  }
  const person = people.find((p) => p.id === input.personId);
  if (!person || !org) {
    return buildActionDenied(
      'FORBIDDEN',
      'Linked person or organisation not found.',
    ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
  }
  if (!opts?.internalSystemStep) {
    const teams = await getHrAndRbacRepository().listAllTeams<Team>(linkCtx);
    const actor = people.find((p) => p.id === byId) ?? null;
    const requiredPerm = existing ? 'contact:edit' : 'contact:create';
    if (
      !hasPersonPermission(actor, requiredPerm, {
        allPeople: people,
        teams,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        `You do not have permission (${requiredPerm}) to ${existing ? 'update' : 'create'} a person-organisation link.`,
      ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
    }
  }
  const label = `${person ? personDisplayName(person) : input.personId} ↔ ${org ? org.legalName : input.organisationId}`;

  let link!: PersonOrganisationLink;
  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(linkCtx, async () => {
    const allocatedId =
      existing?.id ?? (await partyRepo.allocateNextLinkId(linkCtx));
    link = {
      id: allocatedId,
      personId: input.personId,
      organisationId: input.organisationId,
      jobTitle: input.jobTitle.trim(),
      department: input.department.trim(),
      roleWithinOrganisation: input.roleWithinOrganisation.trim(),
      contactRoleIds: input.contactRoleIds,
      isPrimaryContact: input.isPrimaryContact,
      isCurrent: input.isCurrent,
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      contactStatusId: input.contactStatusId || vid('contact_status', 'Active'),
      createdById: existing?.createdById ?? byId,
      createdAt: existing?.createdAt ?? now,
      updatedById: byId,
      updatedAt: now,
    };

    await partyRepo.putLink(linkCtx, link);

    if (!existing) {
      for (const [rtype, rid] of [
        ['person', link.personId],
        ['organisation', link.organisationId],
      ] as const) {
        writeAudit(null, {
          recordType: rtype,
          recordId: rid,
          action: 'link',
          field: 'Organisation link',
          oldValue: null,
          newValue: label + (link.jobTitle ? ` (${link.jobTitle})` : ''),
          byId,
          at: now,
        });
      }
    } else {
      for (const [rtype, rid] of [
        ['person', link.personId],
        ['organisation', link.organisationId],
      ] as const) {
        writeAudit(null, {
          recordType: rtype,
          recordId: rid,
          action: 'link-update',
          field: 'Organisation link',
          oldValue: label,
          newValue: label + (link.jobTitle ? ` (${link.jobTitle})` : ''),
          byId,
          at: now,
        });
      }
    }
    await flushStagedAuditEntries(linkCtx);
    }),
  );
  return link;
}

export async function deleteLink(linkId: string, byId: string): Promise<{ ok: true } | ActionDenied> {
  const linkCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const [people, existing, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(linkCtx),
    partyRepo.getLinkById<PersonOrganisationLink>(linkCtx, linkId),
    getHrAndRbacRepository().listAllTeams<Team>(linkCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'contact:edit', {
      allPeople: people,
      teams,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (contact:edit) to delete a person-organisation link.',
    );
  }
  if (!existing) {
    return buildActionDenied('FORBIDDEN', `Organisation link "${linkId}" not found.`);
  }
  const person = people.find((p) => p.id === existing.personId);
  const org = await partyRepo.getOrganisationById<Organisation>(
    linkCtx,
    existing.organisationId,
  );
  const label = `${person ? personDisplayName(person) : existing.personId} ↔ ${org ? org.legalName : existing.organisationId}`;
  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(linkCtx, async () => {
      await partyRepo.deleteLink(linkCtx, linkId);
      for (const [rtype, rid] of [
        ['person', existing.personId],
        ['organisation', existing.organisationId],
      ] as const) {
        writeAudit(null, {
          recordType: rtype,
          recordId: rid,
          action: 'unlink',
          field: 'Organisation link',
          oldValue: label,
          newValue: null,
          byId,
        });
      }
      await flushStagedAuditEntries(linkCtx);
    }),
  );
  return { ok: true };
}

export async function addNoteToRecord(
  recordType: RecordType | 'matter',
  recordId: string,
  text: string,
  byId: string,
): Promise<Note & Partial<ActionDenied>> {
  const noteCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const [people, matters, targetOrg, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(noteCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(noteCtx),
    recordType === 'organisation'
      ? partyRepo.getOrganisationById<Organisation>(noteCtx, recordId)
      : Promise.resolve(null),
    getHrAndRbacRepository().listAllTeams<Team>(noteCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });

  const target: (AnyRecord | Matter) | undefined =
    recordType === 'person'
      ? people.find((p) => p.id === recordId)
      : recordType === 'matter'
        ? matters.find((m) => m.id === recordId)
        : (targetOrg ?? undefined);

  if (!target) {
    return buildActionDenied(
      'FORBIDDEN',
      `Target ${recordType} "${recordId}" not found.`,
    ) as unknown as Note & Partial<ActionDenied>;
  }

  if (recordType === 'matter') {
    if (
      !hasPersonPermission(actor, 'matter:edit', {
        allPeople: people,
        teams,
      }) ||
      !visibility.canViewMatter(target as Matter)
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        'You do not have permission (matter:edit) or access to add a note to this matter.',
      ) as unknown as Note & Partial<ActionDenied>;
    }
  } else if (recordType === 'organisation') {
    if (
      !hasPersonPermission(actor, 'contact:edit', {
        allPeople: people,
        teams,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        'You do not have permission (contact:edit) to add a note to this organisation.',
      ) as unknown as Note & Partial<ActionDenied>;
    }
  } else {
    const targetPerson = target as Person;
    const isEmpOrLeaver = Boolean(targetPerson.isEmployee || isLeaverPerson(targetPerson));
    const requiredPerm = isEmpOrLeaver ? 'employee:edit_core' : 'contact:edit';
    if (
      !hasPersonPermission(actor, requiredPerm, {
        allPeople: people,
        teams,
        targetPersonId: targetPerson.id,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        `You do not have permission (${requiredPerm}) to add a note to this person record.`,
      ) as unknown as Note & Partial<ActionDenied>;
    }
  }

  const now = new Date().toISOString();
  const today = toIsoDate(new Date());
  const oldInteraction = target.lastInteractionAt;
  target.lastInteractionAt = today;
  if (recordType === 'matter') {
    touchMatter(target as Matter, byId);
  } else {
    target.updatedAt = now;
    target.updatedById = byId;
  }

  let note!: Note;
  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(noteCtx, async () => {
    const noteId = await partyRepo.allocateNextNoteId(noteCtx);
    note = {
      id: noteId,
      recordType,
      recordId,
      authorId: byId,
      at: now,
      text: text.trim(),
    };
    await partyRepo.putNote(noteCtx, note);
    if (recordType === 'person') {
      await partyRepo.putPerson(noteCtx, target as Person);
    } else if (recordType === 'organisation') {
      await partyRepo.putOrganisation(noteCtx, target as Organisation);
    } else {
      await putMatterWithInTxRestrictions(noteCtx, target as Matter, {
        expectedRowVersion: null,
      });
    }
    writeAudit(null, {
      recordType,
      recordId,
      action: 'note',
      field: 'Note added',
      oldValue: oldInteraction,
      newValue: note.text.slice(0, 120),
      byId,
      at: now,
    });
    await flushStagedAuditEntries(noteCtx);
    }),
  );
  return note;
}

export async function generateMatterNumber(
  store: FirmStore | null | undefined,
  clientId: string,
  ctx?: TenantContext,
): Promise<string> {
  const effectiveCtx = ctx ?? resolveDefaultServiceTenantContext(store);
  const partyRepo = getPartyRepository();
  const [org, person] = await Promise.all([
    partyRepo.getOrganisationById<Organisation>(effectiveCtx, clientId),
    partyRepo.getPersonById<Person>(effectiveCtx, clientId),
  ]);
  let prefix = 'MAT001';
  if (org?.clientReference?.trim()) {
    prefix = org.clientReference.trim().toUpperCase();
  } else if (org) {
    prefix = org.legalName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X') + '001';
  } else if (person) {
    prefix = person.surname.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X') + '001';
  }
  return getMatterRepository().allocateNextMatterNumber(effectiveCtx, prefix);
}

function resolveMatterSignOffEstimateGbp(
  store: FirmStore,
  tenantCfg: ReturnType<typeof getActiveTenantConfiguration>,
  matter: Matter,
): {
  resolvedCosts: ReturnType<typeof resolveMatterCostsSnapshot>;
  estimatedFeeGbp: number;
} {
  const costsConfig =
    store.matterCostsConfig ??
    createDefaultMatterCostsConfig(store.values, {
      clientProfileCode: tenantCfg.tenantId,
      displayName: tenantCfg.displayName,
      primaryDomain: tenantCfg.branding.primaryDomain,
    });
  const resolvedCosts = resolveMatterCostsSnapshot({
    existing: matter,
    practiceAreaId: matter.practiceAreaId,
    config: costsConfig,
    values: store.values,
  });
  const estimatedFeeGbp = Number(
    matter.feeEstimateGbp ??
      matter.agreedFeeCapGbp ??
      resolvedCosts.totalEstimateGbp ??
      resolvedCosts.agreedCapGbp ??
      0,
  );
  return { resolvedCosts, estimatedFeeGbp };
}

async function runMatterOpeningGate(params: {
  store: FirmStore;
  matter: Matter;
  isNewMatter: boolean;
  extensionCtx: TenantContext;
  tenantCfg: ReturnType<typeof getActiveTenantConfiguration>;
  costsHookInput: {
    matterId: string;
    workBasis: ReturnType<typeof resolveMatterCostsSnapshot>['workBasis'];
    estimatedFeeGbp: number;
    disbursementsTotalGbp: number;
    partnerSignOffCompleted: boolean;
  };
  now: string;
}): Promise<{
  allowProceed: boolean;
  errors: Record<string, string>;
  governance: Awaited<
    ReturnType<ReturnType<typeof getPlatformExtensionHost>['executeMatterCostsHook']>
  > | null;
  record: MatterOpeningGateRecord;
}> {
  const {
    store,
    matter,
    isNewMatter,
    extensionCtx,
    tenantCfg,
    costsHookInput,
    now,
  } = params;
  const errors: Record<string, string> = {};

  // 1. Extension load failure on an enabled beforeMatterOpen extension fails closed.
  const loadErrors = getExtensionHostLoadErrors();
  const enabledExtSet = new Set(tenantCfg.enabledExtensions ?? []);
  const gateLoadFailure = loadErrors.find(
    (err) =>
      err.tenantId === tenantCfg.tenantId &&
      (enabledExtSet.has(err.extensionId ?? '') ||
        enabledExtSet.has(err.extensionDir)) &&
      (err.declaredHooks === null ||
        err.declaredHooks.includes('beforeMatterOpen')),
  );
  if (gateLoadFailure) {
    errors.extensions =
      "A required opening check couldn't run. Please contact your administrator.";
  }

  // 2. Key-dates opening gate (when the Key Dates module is enabled for the tenant, S0-15).
  const kdConfig = await getKeyDatesConfig({ ctx: extensionCtx });
  if (kdConfig.enabled) {
    const keyDateRepo = getKeyDateRepository();
    const targetMatterTypeId = matter.matterTypeId || matter.practiceAreaId;
    const matterKds = isNewMatter
      ? []
      : await keyDateRepo.listKeyDatesForMatter(
          extensionCtx,
          matter.id,
          extensionCtx.actorId,
        );
    const matterNas = isNewMatter
      ? []
      : await keyDateRepo.listNotApplicableForMatter(
          extensionCtx,
          matter.id,
          extensionCtx.actorId,
        );
    const openGate = evaluateMatterKeyDateOpeningGate(
      kdConfig,
      targetMatterTypeId,
      matterKds,
      matterNas,
    );
    if (!openGate.canOpen) {
      const missingLabels = openGate.missingKeyDateTypes
        .map((t) => t.label)
        .join(', ');
      errors.keyDates = isNewMatter
        ? `Save the matter as a draft and add its required key dates before opening (${missingLabels}).`
        : `Matter cannot open until required key date(s) are recorded or marked not applicable: ${missingLabels}.`;
    }
  }

  // 3. beforeMatterOpen extension hook (when Matter Costs Governance is enabled for the tenant).
  const host = getPlatformExtensionHost();
  const openGovernance =
    gateLoadFailure || !tenantCfg.featureFlags?.enableMatterCostsGovernance
      ? null
      : await host.executeMatterCostsHook(
          'beforeMatterOpen',
          extensionCtx,
          tenantCfg,
          costsHookInput,
        );

  if (openGovernance && !openGovernance.allowProceed) {
    const rawWarning = openGovernance.governanceWarnings[0] ?? '';
    const isInternalHookFailure =
      rawWarning.startsWith('Hook "beforeMatterOpen" in extension ') ||
      rawWarning.startsWith('[Extension isolated error:');
    if (isInternalHookFailure) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'before_matter_open_hook_failed',
          tenantId: extensionCtx.tenantId,
          correlationId: extensionCtx.correlationId,
          matterId: matter.id,
          errorMessage: rawWarning,
        }),
      );
    }
    errors.costsGovernance = isInternalHookFailure
      ? 'A required costs check could not run. Please contact your administrator.'
      : rawWarning ||
        'This matter needs partner sign-off on costs before it can be opened.';
  }

  const allowProceed =
    Object.keys(errors).length === 0 && Boolean(openGovernance?.allowProceed);

  return {
    allowProceed,
    errors,
    governance: openGovernance,
    record: {
      allowProceed,
      estimatedFeeGbp: costsHookInput.estimatedFeeGbp,
      checkedAt: now,
    },
  };
}

function resolveProspectiveStatusId(store: FirmStore): string {
  return (
    store.values.find(
      (v) => v.listKey === 'matter_status' && v.label === 'Prospective / Enquiry',
    )?.id ?? vid('matter_status', 'Active')
  );
}

function matterHasOpened(
  matter: Pick<Matter, 'matterStatusId' | 'matterNumber'>,
  prospectiveStatusId: string,
): boolean {
  return (
    matter.matterStatusId !== prospectiveStatusId &&
    !matter.matterNumber.startsWith('DRAFT')
  );
}

function resolveNextMatterStatusId(params: {
  input: { matterStatusId?: string | null };
  existing: Matter | null;
  existingHasOpened: boolean;
  saveMode: 'draft' | 'submit_cleared' | 'submit_referred' | undefined;
  prospectiveStatus: string;
  cmiIncompleteStatus: string;
}): string {
  const {
    input,
    existing,
    existingHasOpened,
    saveMode,
    prospectiveStatus,
    cmiIncompleteStatus,
  } = params;
  if (existingHasOpened && existing) {
    const requested = input.matterStatusId;
    return requested && requested !== prospectiveStatus
      ? requested
      : existing.matterStatusId;
  }
  if (saveMode === 'draft' || saveMode === 'submit_referred') {
    return prospectiveStatus;
  }
  if (saveMode === 'submit_cleared') {
    return input.matterStatusId && input.matterStatusId !== prospectiveStatus
      ? input.matterStatusId
      : cmiIncompleteStatus;
  }
  return input.matterStatusId || existing?.matterStatusId || cmiIncompleteStatus;
}

function feeEarnerOutcomeLabelFor(
  status: ConflictCheckStatusPill,
): ConflictCheckRecord['outcomeLabel'] {
  switch (status) {
    case 'Cleared':
      return 'Cleared by fee earner';
    case 'Referred':
      return 'Referred to risk for review';
    default:
      return 'Pending';
  }
}

function buildServerConflictCheckRecord(params: {
  submitted: ConflictCheckRecordInput | ConflictCheckRecord;
  stored: ConflictCheckRecord | null | undefined;
  storedMatterHasOpened: boolean;
  parties: ConflictCheckParty[];
  matches: ConflictCheckMatch[];
  actorId: string;
  actorDisplayName: string;
  actorHasRiskView: boolean;
  nowDisplay: string;
  saveMode?: 'draft' | 'submit_cleared' | 'submit_referred';
}): ConflictCheckRecord {
  const {
    submitted,
    stored,
    storedMatterHasOpened,
    parties,
    matches,
    actorId,
    actorDisplayName,
    actorHasRiskView,
    nowDisplay,
    saveMode,
  } = params;
  const displayNow = formatDateTime(nowDisplay) || nowDisplay;

  const isRiskDecisionStatus =
    submitted.status === 'Approved' || submitted.status === 'Declined';
  const storedIsReferred = stored?.status === 'Referred';
  const storedIsRiskLocked =
    stored?.status === 'Referred' ||
    stored?.status === 'Declined' ||
    (stored?.status === 'Approved' &&
      saveMode !== 'submit_referred' &&
      submitted.status !== 'Referred');
  const isUnauthorizedClearWithoutSaveMode =
    submitted.status === 'Cleared' &&
    saveMode !== 'submit_cleared' &&
    Boolean(stored && stored.status !== 'Cleared');
  const isOpenedMatterRegression =
    storedMatterHasOpened &&
    !actorHasRiskView &&
    submitted.status !== stored?.status &&
    saveMode !== 'submit_referred';
  const fallsBackToStored =
    (isRiskDecisionStatus && !actorHasRiskView) ||
    isUnauthorizedClearWithoutSaveMode ||
    (storedIsRiskLocked && !actorHasRiskView && submitted.status !== stored?.status) ||
    isOpenedMatterRegression;
  const status: ConflictCheckStatusPill = fallsBackToStored
    ? stored?.status ??
      (saveMode === 'submit_referred'
        ? 'Referred'
        : saveMode === 'submit_cleared'
          ? 'Cleared'
          : 'In progress')
    : saveMode === 'submit_referred'
      ? 'Referred'
      : saveMode === 'submit_cleared' &&
          (submitted.status === 'In progress' ||
            submitted.status === 'Not started' ||
            submitted.status === 'Referred')
        ? storedIsReferred && !actorHasRiskView
          ? 'Referred'
          : 'Cleared'
        : submitted.status;

  const outcomeLabel: ConflictCheckRecord['outcomeLabel'] = fallsBackToStored
    ? stored?.outcomeLabel ?? feeEarnerOutcomeLabelFor(status)
    : !actorHasRiskView
      ? feeEarnerOutcomeLabelFor(status)
      : saveMode === 'submit_referred'
        ? 'Referred to risk for review'
        : saveMode === 'submit_cleared' &&
            (submitted.status === 'In progress' ||
              submitted.status === 'Not started' ||
              submitted.status === 'Referred')
          ? status === 'Referred'
            ? 'Referred to risk for review'
            : 'Cleared by fee earner'
          : submitted.outcomeLabel;

  const storedComments = stored?.comments ?? [];
  const storedCommentIds = new Set(storedComments.map((c) => c.id));
  const newComments = (submitted.comments ?? [])
    .filter((c) => Boolean(c && typeof c.id === 'string' && !storedCommentIds.has(c.id)))
    .map((c) => ({
      ...c,
      authorId: actorId,
      authorName: actorDisplayName,
      atDisplay: displayNow,
    }));
  const comments = [...storedComments, ...newComments];

  const storedRuns = stored?.runs ?? [];
  const nextSearchTerms = parties.map((p) => p.name).filter(Boolean);
  const lastRun = storedRuns[storedRuns.length - 1];
  const lastRunTermsKey = lastRun ? lastRun.searchTerms.join('\u0000') : null;
  const nextTermsKey = nextSearchTerms.join('\u0000');
  const shouldAppendRun =
    storedRuns.length === 0 || lastRunTermsKey !== nextTermsKey;
  const serverRun: ConflictCheckRunAudit = {
    id: `run-srv-${randomUUID()}`,
    runAtDisplay: displayNow,
    runById: actorId,
    runByName: actorDisplayName,
    searchTerms: nextSearchTerms,
    partiesCount: parties.length,
    matchesCount: matches.length,
    potentialConflictsCount: matches.filter(
      (m) => m.disposition === 'potential_conflict' || m.restricted,
    ).length,
    searchedSources: [...CONFLICT_SEARCHED_SOURCES],
  };
  const runs = shouldAppendRun ? [...storedRuns, serverRun] : [...storedRuns];

  const isRiskApprovalOrDecline =
    actorHasRiskView && (status === 'Approved' || status === 'Declined');
  const isNewSubmission =
    (status === 'Cleared' ||
      status === 'Referred' ||
      saveMode === 'submit_cleared' ||
      saveMode === 'submit_referred') &&
    (!stored?.submittedAtDisplay ||
      (stored.status !== 'Cleared' && stored.status !== 'Referred'));

  const approvedRestrictedMatchIds =
    actorHasRiskView && status === 'Approved'
      ? matches.filter((m) => m.restricted).map((m) => m.id)
      : actorHasRiskView && status === 'Declined'
        ? []
        : stored?.approvedRestrictedMatchIds;

  return {
    status,
    outcomeLabel,
    declarationConfirmed: Boolean(submitted.declarationConfirmed),
    reviewerMessage: submitted.reviewerMessage ?? '',
    lastRunAtDisplay: displayNow,
    lastRunById: actorId,
    lastRunByName: actorDisplayName,
    savedDraftAtDisplay:
      saveMode === 'draft' ? displayNow : stored?.savedDraftAtDisplay ?? null,
    submittedAtDisplay: isNewSubmission
      ? displayNow
      : stored?.submittedAtDisplay ?? null,
    submittedById: isNewSubmission ? actorId : stored?.submittedById ?? null,
    submittedByName: isNewSubmission
      ? actorDisplayName
      : stored?.submittedByName ?? null,
    approvedAtDisplay:
      status === 'Referred'
        ? null
        : isRiskApprovalOrDecline
          ? displayNow
          : stored?.approvedAtDisplay ?? null,
    approvedById:
      status === 'Referred'
        ? null
        : isRiskApprovalOrDecline
          ? actorId
          : stored?.approvedById ?? null,
    approvedByName:
      status === 'Referred'
        ? null
        : isRiskApprovalOrDecline
          ? actorDisplayName
          : stored?.approvedByName ?? null,
    ...(approvedRestrictedMatchIds !== undefined
      ? { approvedRestrictedMatchIds }
      : {}),
    parties,
    matches,
    runs,
    comments,
  };
}

export async function saveMatterRecord(
  input: Omit<
    Partial<Matter>,
    'conflictClearedById' | 'conflictCheckRecord' | 'conflictCheckStatus'
  > & {
    title: string;
    clientId: string;
    practiceAreaId: string;
    workTypeSubcategoryId: string;
    conflictCheckRecord?: ConflictCheckRecordInput | ConflictCheckRecord;
    riskAssessment?: MatterRiskAssessmentInput;
  },
  opts: {
    id?: string;
    byId: string;
    saveMode?: 'draft' | 'submit_cleared' | 'submit_referred';
    source?: 'pms_import';
    expectedRowVersion?: number;
  },
): Promise<{
  matter: Matter | null;
  code?: string;
  message?: string;
  errors?: Record<string, string>;
}> {
  let resolvedMatterCtx: TenantContext | null = null;
  let pendingLifecycleSync: {
    matter: Matter;
    previousMatter: Matter;
    store: FirmStore;
  } | null = null;
  const res = await runWithAuditStagingScope(async () => {
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const activeVerifiedSession = getActiveActorSession()?.verifiedSession as
    | VerifiedEntraSessionPayload
    | undefined;
  const tenantCfg = getActiveTenantConfiguration();
  let lookupCtx: TenantContext | null = null;
  try {
    lookupCtx = resolveDefaultServiceTenantContext(null, opts.byId);
  } catch {
    if (activeVerifiedSession) {
      try {
        lookupCtx = resolveCurrentTenantContext(
          createVerifiedSessionActorFromEntraSession(activeVerifiedSession, {
            correlationId: `matter-save-lookup-${randomUUID()}`,
          }),
          tenantCfg,
        );
      } catch {
        lookupCtx = null;
      }
    }
  }
  const [store, people, organisations, links, matters, enquiries, quotes, tasks, teams, lookupRbacConfig] = lookupCtx
    ? await Promise.all([
        loadTenantCatalogueStoreView(lookupCtx),
        partyRepo.listAllPeople<Person>(lookupCtx),
        partyRepo.listAllOrganisations<Organisation>(lookupCtx),
        partyRepo.listAllLinks<PersonOrganisationLink>(lookupCtx),
        matterRepo.listAllMattersUnfiltered<Matter>(lookupCtx),
        intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(lookupCtx),
        intakeRepo.listAllQuotesUnfiltered<Quote>(lookupCtx),
        taskRepo.listAllTasksUnfiltered<Task>(lookupCtx),
        getHrAndRbacRepository().listAllTeams<Team>(lookupCtx),
        loadEffectiveTenantRbacConfig(lookupCtx),
      ])
    : [null as unknown as FirmStore, [], [], [], [], [], [], [], [], undefined];
  const existingRef = opts.id ? matters.find((m) => m.id === opts.id) ?? null : null;
  const existing = existingRef ? structuredClone(existingRef) : null;
  const existingRowVersion = existing?.rowVersion ?? 1;
  const now = nextMonotonicIsoTimestamp(existing?.updatedAt);
  const today = toIsoDate(new Date());
  if (!activeVerifiedSession) {
    return {
      matter: null,
      errors: {
        access: 'UNAUTHENTICATED: Your session has expired. Please sign in again.',
      },
    };
  }
  const actingUser = people.find((p) => p.id === opts.byId) ?? null;
  if (!actingUser || !actingUser.isEmployee) {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
      },
    };
  }
  if (activeVerifiedSession.personId !== actingUser.id) {
    return {
      matter: null,
      errors: {
        access: 'UNAUTHENTICATED: Your session has expired. Please sign in again.',
      },
    };
  }
  let extensionCtx: TenantContext;
  try {
    extensionCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(activeVerifiedSession, {
        correlationId: `matter-save-${randomUUID()}`,
      }),
      tenantCfg,
    );
  } catch {
    return {
      matter: null,
      errors: {
        access: 'UNAUTHENTICATED: Your session is invalid for this tenant. Please sign in again.',
      },
    };
  }
  const matterRbacConfig =
    lookupRbacConfig ?? (await loadEffectiveTenantRbacConfig(extensionCtx));
  if ((input as { id?: string }).id && !opts.id) {
    return {
      matter: null,
      errors: {
        id: 'Cannot save an existing matter payload without passing opts.id.',
      },
    };
  }
  if (opts.id) {
    if (
      !existing ||
      !canPersonAccessMatter(existing, opts.byId, actingUser, {
        allPeople: people,
        teams,
        config: { rbac: matterRbacConfig },
      })
    ) {
      return {
        matter: null,
        errors: {
          access: 'Matter not found or restricted.',
          permission: 'Matter not found or restricted.',
        },
      };
    }
    if (
      !hasPersonPermission(actingUser, 'matter:edit', {
        allPeople: people,
        teams,
        config: { rbac: matterRbacConfig },
      })
    ) {
      return {
        matter: null,
        errors: {
          permission: 'You do not have permission (matter:edit) to edit matters.',
        },
      };
    }
    const suppliedExpectedVersion =
      opts.expectedRowVersion !== undefined
        ? opts.expectedRowVersion
        : input.rowVersion;
    if (
      suppliedExpectedVersion !== undefined &&
      (typeof suppliedExpectedVersion !== 'number' ||
        !Number.isInteger(suppliedExpectedVersion) ||
        suppliedExpectedVersion < 1 ||
        suppliedExpectedVersion !== existingRowVersion)
    ) {
      return {
        matter: null,
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        errors: {
          conflict: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        },
      };
    }
  } else {
    if (
      !hasPersonPermission(actingUser, 'matter:create', {
        allPeople: people,
        teams,
        config: { rbac: matterRbacConfig },
      })
    ) {
      return {
        matter: null,
        errors: {
          permission: 'You do not have permission (matter:create) to create matters.',
        },
      };
    }
  }

  const isDraftSave = opts.saveMode === 'draft';

  const errors: Record<string, string> = {};
  if (!isDraftSave) {
    if (!input.title?.trim()) errors.title = 'Matter title / description is required.';
    if (!input.clientId) errors.clientId = 'Client (instructing entity or individual) is required.';
    if (!input.practiceAreaId) errors.practiceAreaId = 'Practice area is required.';
    if (!input.workTypeSubcategoryId) errors.workTypeSubcategoryId = 'Work type subcategory is required.';
  }

  // Validate questionnaire answers against MATTER_RISK_SECTIONS; discard any client-supplied sections, overallRisk or scores (S0-08 / B1)
  const rawRiskAssessmentInput =
    input.riskAssessment !== undefined
      ? input.riskAssessment
      : input.fieldValues?.['riskAssessment'];
  const incomingCustomKeyDates = Array.isArray(input.fieldValues?.['customKeyDates'])
    ? (input.fieldValues['customKeyDates'] as CustomKeyDateEntry[])
    : Array.isArray(existing?.fieldValues?.['customKeyDates'])
      ? (existing.fieldValues['customKeyDates'] as CustomKeyDateEntry[])
      : [];
  const validatedRiskAssessment = validateMatterRiskAssessmentInput(
    rawRiskAssessmentInput,
    incomingCustomKeyDates,
  );
  if (!validatedRiskAssessment.ok) {
    errors.riskAssessment = validatedRiskAssessment.error;
  }

  // Validate owningDepartmentId and owningTeamId against orgStructure and enforce matter:reassign_ownership on existing matters (R107, R134)
  const nextOwningDepartmentId =
    input.owningDepartmentId !== undefined
      ? (input.owningDepartmentId ?? '').trim() || undefined
      : existing?.owningDepartmentId || undefined;
  const nextOwningTeamId =
    input.owningTeamId !== undefined
      ? (input.owningTeamId ?? '').trim() || undefined
      : existing?.owningTeamId || undefined;

  const prevDeptId = existing?.owningDepartmentId || undefined;
  const prevTeamId = existing?.owningTeamId || undefined;
  const deptChanged =
    input.owningDepartmentId !== undefined && nextOwningDepartmentId !== prevDeptId;
  const teamChanged =
    input.owningTeamId !== undefined && nextOwningTeamId !== prevTeamId;

  const shouldValidateDept = !existing || deptChanged;
  const shouldValidateTeam = !existing || teamChanged || deptChanged;

  if (shouldValidateDept && nextOwningDepartmentId) {
    const activeDept = store.orgStructure.departments.find(
      (d) => d.id === nextOwningDepartmentId && d.active,
    );
    if (!activeDept) {
      errors.owningDepartmentId =
        'Selected owning department does not exist or is inactive.';
    }
  }
  if (shouldValidateTeam && nextOwningTeamId) {
    const activeTeam = store.orgStructure.teamsOrPracticeGroups.find(
      (t) => t.id === nextOwningTeamId && t.active,
    );
    if (!activeTeam) {
      errors.owningTeamId = 'Selected owning team does not exist or is inactive.';
    } else if (
      !nextOwningDepartmentId ||
      activeTeam.parentDepartmentId !== nextOwningDepartmentId
    ) {
      errors.owningTeamId =
        'Selected owning team does not belong to the selected owning department.';
    }
  }

  if (existing) {
    if (
      (deptChanged || teamChanged) &&
      !hasPersonPermission(actingUser, 'matter:reassign_ownership', {
        allPeople: people,
        teams,
      })
    ) {
      if (deptChanged) {
        errors.owningDepartmentId =
          'You do not have permission (matter:reassign_ownership) to change a matter’s owning department.';
      }
      if (teamChanged) {
        errors.owningTeamId =
          'You do not have permission (matter:reassign_ownership) to change a matter’s owning team.';
      }
    }
  }

  resolvedMatterCtx = extensionCtx;
  // Enforce Key Dates closure gate (§1; opening gate runs via runMatterOpeningGate)
  const kdConfig = await getKeyDatesConfig({ ctx: extensionCtx });
  if (kdConfig.enabled && !isDraftSave) {
    const targetMatterId = existing?.id;
    const targetMatterTypeId =
      input.matterTypeId ||
      existing?.matterTypeId ||
      input.practiceAreaId ||
      existing?.practiceAreaId;
    const nextStatusId = input.matterStatusId ?? existing?.matterStatusId ?? '';
    const nextStatusLabel = resolveLabel(store.values, nextStatusId) || nextStatusId;
    const isClosing =
      nextStatusLabel.toLowerCase() === 'closed' ||
      nextStatusLabel.toLowerCase() === 'archived' ||
      nextStatusId === 'matter_status.closed';

    if (targetMatterId && isClosing) {
      const matterKds = await getKeyDateRepository().listKeyDatesForMatter(
        extensionCtx,
        targetMatterId,
        extensionCtx.actorId,
      );
      const closeGate = evaluateMatterKeyDateClosureGate(
        kdConfig,
        targetMatterTypeId,
        matterKds,
      );
      if (!closeGate.canClose) {
        errors.keyDates = `Cannot close matter while ${closeGate.openKeyDates.length} key date(s) remain open (${closeGate.openKeyDates.map((d) => `${d.title} [${d.status}]`).join(', ')}). Resolve them as met, missed, or waived first.`;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { matter: null, errors };
  }

  const pendingPeople: Person[] = [];
  const pendingOrganisations: Organisation[] = [];
  const pendingEnquiryLinks: Array<{ enquiry: Enquiry; prevEnquiry: Enquiry; linkedPersonId: string }> = [];

  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const cmiIncompleteStatus =
    store.values.find((v) => v.listKey === 'matter_status' && v.label === 'CMI incomplete')?.id ??
    vid('matter_status', 'CMI incomplete');
  const prospectiveStatus = resolveProspectiveStatusId(store);

  const promoteEnquiryPersonId = async (rawId: string | null | undefined): Promise<string | null> => {
    if (!rawId) return null;
    if (!rawId.startsWith('ENQ-')) return rawId;
    const enq = enquiries.find((e) => e.id === rawId);
    if (!enq) return rawId;
    if (
      enq.linkedPersonId &&
      (people.some((p) => p.id === enq.linkedPersonId) ||
        pendingPeople.some((p) => p.id === enq.linkedPersonId))
    ) {
      return enq.linkedPersonId;
    }
    const existingPendingLink = pendingEnquiryLinks.find((l) => l.enquiry.id === enq.id);
    if (existingPendingLink) {
      return existingPendingLink.linkedPersonId;
    }
    const existingFromEnq =
      people.find((p) => p.createdFromEnquiryId === enq.id) ??
      pendingPeople.find((p) => p.createdFromEnquiryId === enq.id);
    if (existingFromEnq) {
      pendingEnquiryLinks.push({
        enquiry: enq,
        prevEnquiry: structuredClone(enq),
        linkedPersonId: existingFromEnq.id,
      });
      return existingFromEnq.id;
    }
    const newPersonId = await partyRepo.allocateNextPersonId(extensionCtx);
    const activeRecordStatus =
      valueBySystemKey(store.values, 'record_status', 'active')?.id ?? vid('record_status', 'Active');
    const newPerson: Person = {
      id: newPersonId,
      recordType: 'person',
      recordOwnerId: enq.assignedToId || opts.byId,
      recordStatusId: activeRecordStatus,
      createdById: opts.byId,
      createdAt: now,
      updatedById: opts.byId,
      updatedAt: now,
      sourceId: enq.sourceId || vid('data_source', 'Manual entry'),
      lastVerifiedAt: today,
      tags: [],
      duplicateStatusId: dupNone,
      notDuplicateOf: [],
      possibleMatchIds: [],
      mergedIntoId: null,
      lastInteractionAt: today,
      customFields: {},
      titleId: null,
      firstName: enq.firstName.trim() || 'Enquiry',
      middleNames: '',
      surname: enq.lastName.trim() || 'Contact',
      preferredName: '',
      otherNames: [],
      dateOfBirth: null,
      preferredLanguageId: null,
      jobTitle: '',
      isEmployee: false,
      employeeRoleId: null,
      departmentId: null,
      employment: null,
      emails: enq.email.trim()
        ? [
            {
              id: `e_${Date.now()}`,
              address: enq.email.trim(),
              typeId: vid('email_type', enq.callingOnBehalfOf ? 'Work' : 'Personal'),
              isPrimary: true,
            },
          ]
        : [],
      phones: enq.phone.trim()
        ? [
            {
              id: `p_${Date.now()}`,
              number: enq.phone.trim(),
              typeId: vid('phone_type', 'Mobile'),
            },
          ]
        : [],
      addresses: enq.address ? [{ ...enq.address, id: enq.address.id || `a_${Date.now()}` }] : [],
      website: '',
      preferredContactMethodId: enq.preferredContactMethodId || null,
      relationshipOwnerId: enq.assignedToId || opts.byId,
      relationshipStatusId: vid('relationship_status', 'Active'),
      relationshipStandingId: null,
      relationshipRoleIds: [
        vid('person_role', enq.callingOnBehalfOf ? 'Client contact' : 'Private client'),
      ],
      originId: enq.sourceId || null,
      firstKnownAt: today,
      engagementLevelId: null,
      interests: '',
      relationshipNotes: enq.summary || '',
      marketingConsentId: null,
      consentRecord: '',
      verificationStatusId: null,
      verifiedAt: null,
      verificationMethodId: null,
      verificationReviewerId: null,
      riskReferences: '',
      createdFromEnquiryId: enq.id,
    };
    pendingPeople.push(newPerson);
    pendingEnquiryLinks.push({
      enquiry: enq,
      prevEnquiry: structuredClone(enq),
      linkedPersonId: newPersonId,
    });
    return newPersonId;
  };

  const effectiveClientId =
    (await promoteEnquiryPersonId(
      input.clientId !== undefined ? input.clientId : existing?.clientId,
    )) ?? '';
  const rawMatterNumberInput = (input.matterNumber ?? existing?.matterNumber ?? '').trim();
  const rawMatterNumber =
    !existing &&
    rawMatterNumberInput &&
    rawMatterNumberInput !== 'DRAFT' &&
    matters.some((m) => m.matterNumber === rawMatterNumberInput)
      ? ''
      : rawMatterNumberInput;
  const matterNumber = isDraftSave
    ? rawMatterNumber || 'DRAFT'
    : !rawMatterNumber || rawMatterNumber === 'DRAFT'
      ? await generateMatterNumber(store, effectiveClientId, extensionCtx)
      : rawMatterNumber;

  // Auto-create new contacts/organisations on save for any party added by typing a new name
  const createdRecordByPartyId = new Map<string, string>();
  const resolvedParties: Matter['parties'] = [];
  for (const pt of input.parties ?? existing?.parties ?? []) {
    if (pt.linkedRecordId) {
      if (pt.linkedRecordId.startsWith('ENQ-')) {
        const promotedId = await promoteEnquiryPersonId(pt.linkedRecordId);
        if (promotedId) {
          createdRecordByPartyId.set(pt.id, promotedId);
          resolvedParties.push({ ...pt, linkedRecordId: promotedId });
          continue;
        }
      }
      resolvedParties.push(pt);
      continue;
    }
    if (!pt.name?.trim() || pt.name.trim().startsWith('[')) {
      resolvedParties.push(pt);
      continue;
    }
    const cleanName = pt.name.trim();
    const isPerson = pt.entityType === 'person';
    if (isPerson) {
      const existingPerson =
        people.find(
          (p) => !p.mergedIntoId && personDisplayName(p).toLowerCase() === cleanName.toLowerCase(),
        ) ??
        pendingPeople.find(
          (p) => !p.mergedIntoId && personDisplayName(p).toLowerCase() === cleanName.toLowerCase(),
        );
      if (existingPerson) {
        createdRecordByPartyId.set(pt.id, existingPerson.id);
        resolvedParties.push({ ...pt, linkedRecordId: existingPerson.id });
        continue;
      }
      const parts = cleanName.split(/\s+/);
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : cleanName;
      const surname = parts.length > 1 ? parts[parts.length - 1] : 'Contact';
      const newPersonId = await partyRepo.allocateNextPersonId(extensionCtx);
      const activeRecordStatus =
        valueBySystemKey(store.values, 'record_status', 'active')?.id ?? vid('record_status', 'Active');
      const newPerson: Person = {
        id: newPersonId,
        recordType: 'person',
        recordOwnerId: opts.byId,
        recordStatusId: activeRecordStatus,
        createdById: opts.byId,
        createdAt: now,
        updatedById: opts.byId,
        updatedAt: now,
        sourceId: vid('data_source', 'Manual entry'),
        lastVerifiedAt: today,
        tags: [],
        duplicateStatusId: dupNone,
        notDuplicateOf: [],
        possibleMatchIds: [],
        mergedIntoId: null,
        lastInteractionAt: today,
        customFields: {},
        titleId: null,
        firstName,
        middleNames: '',
        surname,
        preferredName: '',
        otherNames: pt.identifiers?.previousNames?.trim()
          ? [
              {
                id: `ON-${Date.now()}`,
                name: pt.identifiers.previousNames.trim(),
                typeId: vid('name_type', 'Former / Maiden Name'),
              },
            ]
          : [],
        dateOfBirth: pt.identifiers?.dateOfBirth?.trim() || null,
        preferredLanguageId: null,
        jobTitle: '',
        isEmployee: false,
        employeeRoleId: null,
        departmentId: null,
        employment: null,
        emails: [],
        phones: [],
        addresses: pt.identifiers?.town?.trim()
          ? [
              {
                id: `ADDR-${Date.now()}`,
                typeId: vid('address_type', 'Home / Residential'),
                line1: '',
                line2: '',
                town: pt.identifiers.town.trim(),
                county: '',
                postcode: '',
                countryId: vid('country', 'United Kingdom'),
              },
            ]
          : [],
        website: '',
        preferredContactMethodId: null,
        relationshipOwnerId: opts.byId,
        relationshipStatusId: vid('relationship_status', 'Active'),
        relationshipStandingId: null,
        relationshipRoleIds: [],
        originId: null,
        firstKnownAt: today,
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
      };
      pendingPeople.push(newPerson);
      createdRecordByPartyId.set(pt.id, newPersonId);
      resolvedParties.push({ ...pt, linkedRecordId: newPersonId });
    } else {
      const existingOrg =
        organisations.find(
          (o) => !o.mergedIntoId && o.legalName.toLowerCase() === cleanName.toLowerCase(),
        ) ??
        pendingOrganisations.find(
          (o) => !o.mergedIntoId && o.legalName.toLowerCase() === cleanName.toLowerCase(),
        );
      if (existingOrg) {
        createdRecordByPartyId.set(pt.id, existingOrg.id);
        resolvedParties.push({ ...pt, linkedRecordId: existingOrg.id });
        continue;
      }
      const newOrgId = await partyRepo.allocateNextOrganisationId(extensionCtx);
      const activeRecordStatus =
        valueBySystemKey(store.values, 'record_status', 'active')?.id ?? vid('record_status', 'Active');
      const newOrg: Organisation = {
        id: newOrgId,
        recordType: 'organisation',
        recordOwnerId: opts.byId,
        recordStatusId: activeRecordStatus,
        createdById: opts.byId,
        createdAt: now,
        updatedById: opts.byId,
        updatedAt: now,
        sourceId: vid('data_source', 'Manual entry'),
        lastVerifiedAt: today,
        tags: [],
        duplicateStatusId: dupNone,
        notDuplicateOf: [],
        possibleMatchIds: [],
        mergedIntoId: null,
        lastInteractionAt: today,
        customFields: {},
        legalName: cleanName,
        otherNames: [],
        organisationTypeId: vid('organisation_type', 'Company'),
        companyNumber: pt.identifiers?.companyNumber?.trim() || '',
        vatNumber: '',
        countryOfRegistrationId: vid('country', 'United Kingdom'),
        registeredAddress: pt.identifiers?.registeredTown?.trim()
          ? {
              id: `ADDR-${Date.now()}`,
              typeId: vid('address_type', 'Registered Office'),
              line1: '',
              line2: '',
              town: pt.identifiers.registeredTown.trim(),
              county: '',
              postcode: '',
              countryId: vid('country', 'United Kingdom'),
            }
          : null,
        correspondenceAddress: null,
        peopleWithSignificantControl: [],
        directors: [],
        website: '',
        mainPhone: '',
        generalEmail: '',
        parentOrganisationId: null,
        relationshipPartnerId: opts.byId,
        relationshipTypeIds: [vid('relationship_type', 'Other Party / Counterparty')],
        relationshipStatusId: vid('relationship_status', 'Active'),
        relationshipStandingId: null,
        sectorId: null,
        clientTierId: null,
        originId: null,
        relationshipStartedAt: today,
        engagementLevelId: null,
        pipelineStageId: null,
        bdNotes: '',
        clientReference: '',
        onboardingStatusId: null,
        conflictStatusId: null,
        conflictReference: '',
        riskRatingId: null,
        riskAssessmentStatusId: null,
        verificationStatusId: null,
        billingAddress: null,
        invoicePreferenceId: null,
        paymentTermsId: null,
        creditControlNotes: '',
        engagementTermsRef: '',
        reviewDate: null,
        reviewerId: null,
      };
      pendingOrganisations.push(newOrg);
      createdRecordByPartyId.set(pt.id, newOrgId);
      resolvedParties.push({ ...pt, linkedRecordId: newOrgId });
    }
  }

  const allPeopleWithPending =
    pendingPeople.length > 0 ? [...people, ...pendingPeople] : people;
  const allOrganisationsWithPending =
    pendingOrganisations.length > 0
      ? [...organisations, ...pendingOrganisations]
      : organisations;

  const effectiveResponsiblePartnerId =
    input.responsiblePartnerId !== undefined
      ? input.responsiblePartnerId
      : existing?.responsiblePartnerId ?? opts.byId;
  const effectiveSupervisingPartnerId =
    input.supervisingPartnerId !== undefined
      ? input.supervisingPartnerId
      : existing?.supervisingPartnerId ?? opts.byId;
  const effectiveLeadFeeEarnerId =
    input.leadFeeEarnerId !== undefined
      ? input.leadFeeEarnerId
      : existing?.leadFeeEarnerId ?? opts.byId;
  const effectiveTeamMemberIds = input.teamMemberIds ?? existing?.teamMemberIds ?? [];
  const resolvedAdditionalClientIds: string[] = [];
  for (const cid of input.additionalClientIds ?? existing?.additionalClientIds ?? []) {
    resolvedAdditionalClientIds.push((await promoteEnquiryPersonId(cid)) || cid);
  }
  const resolvedInstructingContactId = await promoteEnquiryPersonId(
    input.instructingContactId !== undefined
      ? input.instructingContactId
      : existing?.instructingContactId ?? null,
  );
  const resolvedBillingContactId = await promoteEnquiryPersonId(
    input.billingContactId !== undefined
      ? input.billingContactId
      : existing?.billingContactId ?? null,
  );
  const resolvedReferrerContactId = await promoteEnquiryPersonId(
    input.referrerContactId !== undefined
      ? input.referrerContactId
      : existing?.referrerContactId ?? null,
  );

  const actorHasRiskView = hasPersonPermission(actingUser, 'risk:view', {
    allPeople: allPeopleWithPending,
    teams,
  });
  const submittedConflictRecord =
    input.conflictCheckRecord === null ? undefined : input.conflictCheckRecord;
  const mappedInputConflictParties =
    submittedConflictRecord !== undefined
      ? submittedConflictRecord.parties.map((cp) =>
          !cp.linkedRecordId && createdRecordByPartyId.has(cp.id)
            ? { ...cp, linkedRecordId: createdRecordByPartyId.get(cp.id)! }
            : cp,
        )
      : existing?.conflictCheckRecord?.parties ?? [];
  const effectiveConflictParties = buildEffectiveConflictParties({
    submittedParties: mappedInputConflictParties,
    clientId: effectiveClientId,
    additionalClientIds: resolvedAdditionalClientIds,
    instructingContactId: resolvedInstructingContactId,
    billingContactId: resolvedBillingContactId,
    matterParties: resolvedParties,
    people: allPeopleWithPending,
    organisations: allOrganisationsWithPending,
  });
  const visibility = buildRecordVisibility(
    store,
    actingUser,
    {
      people: allPeopleWithPending,
      matters,
      enquiries,
      quotes,
      teams,
      hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    },
  );
  const rawServerMatches = searchMatterConflicts(
    {
      currentMatterId: existing?.id ?? null,
      sourceEnquiryId:
        input.sourceEnquiryId !== undefined
          ? input.sourceEnquiryId
          : existing?.sourceEnquiryId ?? null,
      parties: effectiveConflictParties,
      previousMatches:
        submittedConflictRecord?.matches ??
        existing?.conflictCheckRecord?.matches ??
        [],
      canReviewConditions: actorHasRiskView,
      reviewerUserId: actorHasRiskView ? opts.byId : null,
      reviewerDisplayName: actorHasRiskView ? personDisplayName(actingUser) : null,
      reviewedAtIso: now,
    },
    {
      matters,
      enquiries,
      people: allPeopleWithPending,
      organisations: allOrganisationsWithPending,
      links,
      tenantId: getActiveTenantConfiguration().tenantId,
      canView: visibility.canViewMatter,
      canViewEnquiry: visibility.canViewEnquiry,
    },
  );
  const reconciledConflictMatches = reconcileServerConflictMatches({
    serverMatches: rawServerMatches,
    submittedMatches: submittedConflictRecord?.matches,
    existingStoredMatches: existing?.conflictCheckRecord?.matches,
    canReviewConditions: actorHasRiskView,
    reviewerUserId: actorHasRiskView ? opts.byId : null,
    reviewerDisplayName: actorHasRiskView ? personDisplayName(actingUser) : null,
    reviewedAtIso: now,
  });

  const existingSnapshot = existing?.fieldValues?.['matterOpeningSnapshot'] as
    | { saveMode?: string; capturedAt?: string }
    | undefined;
  const existingHasOpened = Boolean(
    existing && matterHasOpened(existing, prospectiveStatus),
  );
  const isPmsImport = opts.source === 'pms_import';
  if (existingHasOpened && !isPmsImport) {
    if (opts.saveMode === 'draft') {
      return {
        matter: null,
        errors: {
          form: 'This matter has opened, so it can no longer be saved as a draft.',
        },
      };
    }
    if (input.matterStatusId === prospectiveStatus) {
      return {
        matter: null,
        errors: {
          matterStatusId: 'An open matter cannot be moved back to Prospective.',
        },
      };
    }
  }
  const nextStatusId = resolveNextMatterStatusId({
    input,
    existing,
    existingHasOpened,
    saveMode: opts.saveMode,
    prospectiveStatus,
    cmiIncompleteStatus,
  });
  const willOpen = !existingHasOpened && nextStatusId !== prospectiveStatus;

  const storedConflictRecord =
    existing?.conflictCheckRecord ??
    (existing
      ? resolveMatterConflictCheckRecord(
          existing,
          allPeopleWithPending,
          allOrganisationsWithPending,
        )
      : null);

  if (
    !isPmsImport &&
    storedConflictRecord?.status === 'Referred' &&
    !actorHasRiskView &&
    (opts.saveMode === 'submit_cleared' ||
      submittedConflictRecord?.status === 'Cleared')
  ) {
    return {
      matter: null,
      errors: {
        conflict:
          'This matter has been referred to Risk. Only Risk & Compliance can clear or approve it.',
      },
    };
  }

  const hasUnapprovedRestrictedMatch = hasUnapprovedRestrictedMatches(
    reconciledConflictMatches,
    storedConflictRecord?.approvedRestrictedMatchIds,
  );
  const isApprovedByRiskInThisSave =
    actorHasRiskView && submittedConflictRecord?.status === 'Approved';
  if (
    !isPmsImport &&
    hasUnapprovedRestrictedMatch &&
    !isApprovedByRiskInThisSave &&
    (opts.saveMode === 'submit_cleared' ||
      submittedConflictRecord?.status === 'Cleared' ||
      (!isDraftSave &&
        opts.saveMode !== 'submit_referred' &&
        !existing))
  ) {
    return {
      matter: null,
      errors: {
        conflict:
          'This matter must be referred to Risk because a match was found on a restricted record.',
      },
    };
  }

  const actorDisplayName = personDisplayName(actingUser);
  const resolvedConflictCheckRecord =
    submittedConflictRecord !== undefined
      ? buildServerConflictCheckRecord({
          submitted: submittedConflictRecord,
          stored: storedConflictRecord,
          storedMatterHasOpened: existingHasOpened,
          parties: effectiveConflictParties,
          matches: reconciledConflictMatches,
          actorId: opts.byId,
          actorDisplayName,
          actorHasRiskView,
          nowDisplay: now,
          saveMode: opts.saveMode,
        })
      : storedConflictRecord
        ? {
            ...storedConflictRecord,
            ...(opts.saveMode === 'submit_referred'
              ? {
                  status: 'Referred' as const,
                  outcomeLabel: 'Referred to risk for review' as const,
                  approvedAtDisplay: null,
                  approvedById: null,
                  approvedByName: null,
                }
              : opts.saveMode === 'submit_cleared' &&
                  (storedConflictRecord.status === 'In progress' ||
                    storedConflictRecord.status === 'Not started')
                ? {
                    status: 'Cleared' as const,
                    outcomeLabel: 'Cleared by fee earner' as const,
                  }
                : {}),
            parties: effectiveConflictParties,
            matches: reconciledConflictMatches,
          }
        : undefined;

  if (willOpen && !isPmsImport) {
    const fallbackStatusFromField =
      opts.saveMode === 'submit_referred'
        ? 'Pending conflict review'
        : isDraftSave
          ? existing?.conflictCheckStatus ?? 'Draft'
          : existing?.conflictCheckStatus ?? 'Clear';
    const inferredConflictStatus = conflictStatusPillFromLegacy(
      fallbackStatusFromField,
    );
    const nextConflictStatus =
      resolvedConflictCheckRecord?.status ??
      storedConflictRecord?.status ??
      inferredConflictStatus;
    const conflictAllowsOpening =
      (nextConflictStatus === 'Cleared' || nextConflictStatus === 'Approved') &&
      (!hasUnapprovedRestrictedMatch || isApprovedByRiskInThisSave);
    if (!conflictAllowsOpening) {
      return {
        matter: null,
        errors: {
          conflict:
            'This matter cannot open until its conflict check is cleared or approved by Risk.',
        },
      };
    }
  }
  const computedStaffStatus = computeStaffMatterStatus(
    {
      clientId: effectiveClientId,
      additionalClientIds: resolvedAdditionalClientIds,
      responsiblePartnerId: effectiveResponsiblePartnerId,
      supervisingPartnerId: effectiveSupervisingPartnerId,
      leadFeeEarnerId: effectiveLeadFeeEarnerId,
      teamMemberIds: effectiveTeamMemberIds,
    },
    allPeopleWithPending,
  );
  const currentStaffParticipantIds = Array.from(
    new Set(
      [effectiveClientId, ...resolvedAdditionalClientIds].filter((cid): cid is string =>
        Boolean(cid && allPeopleWithPending.some((p) => p.id === cid && isWorkingAtFirm(p))),
      ),
    ),
  );
  const priorStaffLift = existing?.restrictionLift?.staffMatter;
  const staffLiftStillApplies =
    Boolean(priorStaffLift) &&
    currentStaffParticipantIds.every((pid) =>
      priorStaffLift!.liftedParticipantIds.includes(pid),
    );
  const effectiveIsStaffMatter = staffLiftStillApplies
    ? false
    : Boolean(computedStaffStatus.isStaffMatter || existing?.isStaffMatter);

  const currentBarrierMatchIds = (resolvedConflictCheckRecord?.matches ?? [])
    .filter((m) => m.reviewerConditionType === 'information_barrier')
    .map((m) => m.id);
  const priorWallLift = existing?.restrictionLift?.ethicalWall;
  const hasUnliftedBarrierCondition = currentBarrierMatchIds.some(
    (mid) => !(priorWallLift?.liftedBarrierMatchIds ?? []).includes(mid),
  );
  const wallLiftStillApplies =
    Boolean(priorWallLift) && !hasUnliftedBarrierCondition;
  const effectiveHasEthicalWall = wallLiftStillApplies
    ? false
    : Boolean(existing?.hasEthicalWall || currentBarrierMatchIds.length > 0);
  const nextRestrictionLift: Matter['restrictionLift'] = {
    ...(staffLiftStillApplies && priorStaffLift ? { staffMatter: priorStaffLift } : {}),
    ...(wallLiftStillApplies && priorWallLift ? { ethicalWall: priorWallLift } : {}),
  };
  const effectiveRestrictedAccessUserIds =
    effectiveIsStaffMatter || effectiveHasEthicalWall
      ? Array.from(
          new Set(
            [
              effectiveResponsiblePartnerId,
              effectiveSupervisingPartnerId,
              effectiveLeadFeeEarnerId,
              ...effectiveTeamMemberIds,
            ].filter((id): id is string => Boolean(id)),
          ),
        )
      : [];

  const candidateMatterId = existing?.id ?? 'M-PENDING';
  let matter: Matter = {
    id: candidateMatterId,
    recordType: 'matter',
    rowVersion: existing?.rowVersion ?? 1,
    recordOwnerId: input.leadFeeEarnerId || input.responsiblePartnerId || existing?.recordOwnerId || opts.byId,
    recordStatusId: nextStatusId,
    createdById: existing?.createdById ?? opts.byId,
    createdAt: existing?.createdAt ?? now,
    updatedById: opts.byId,
    updatedAt: now,
    sourceId: input.sourceId ?? existing?.sourceId ?? vid('data_source', 'Manual entry'),
    lastVerifiedAt: input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : existing?.lastVerifiedAt ?? today,
    tags: input.tags ?? existing?.tags ?? [],
    duplicateStatusId: existing?.duplicateStatusId ?? dupNone,
    notDuplicateOf: existing?.notDuplicateOf ?? [],
    possibleMatchIds: existing?.possibleMatchIds ?? [],
    mergedIntoId: existing?.mergedIntoId ?? null,
    lastInteractionAt: input.lastInteractionAt !== undefined ? input.lastInteractionAt : existing?.lastInteractionAt ?? today,
    customFields: input.customFields ?? existing?.customFields ?? {},

    matterNumber,
    title: (input.title !== undefined ? input.title : existing?.title ?? '').trim(),
    shortDescription: (input.shortDescription ?? existing?.shortDescription ?? '').trim(),
    clientId: effectiveClientId,
    additionalClientIds: resolvedAdditionalClientIds,
    parentMatterId: input.parentMatterId !== undefined ? input.parentMatterId : existing?.parentMatterId ?? null,
    relatedMatterIds: input.relatedMatterIds ?? existing?.relatedMatterIds ?? [],
    matterStatusId: nextStatusId,
    sourceEnquiryId: input.sourceEnquiryId !== undefined ? input.sourceEnquiryId : existing?.sourceEnquiryId ?? null,
    sourceQuoteId: input.sourceQuoteId !== undefined ? input.sourceQuoteId : existing?.sourceQuoteId ?? null,
    practiceAreaId:
      input.practiceAreaId !== undefined
        ? input.practiceAreaId
        : existing?.practiceAreaId ?? '',
    workTypeSubcategoryId:
      input.workTypeSubcategoryId !== undefined
        ? input.workTypeSubcategoryId
        : existing?.workTypeSubcategoryId ?? '',
    typeBadge: input.typeBadge !== undefined ? input.typeBadge : existing?.typeBadge ?? '',
    matterTypeId: input.matterTypeId !== undefined ? input.matterTypeId : existing?.matterTypeId ?? '',
    clientTierId: input.clientTierId !== undefined ? input.clientTierId : existing?.clientTierId ?? null,
    clientSectorId: input.clientSectorId !== undefined ? input.clientSectorId : existing?.clientSectorId ?? null,
    billingBasisId: input.billingBasisId !== undefined ? input.billingBasisId : existing?.billingBasisId ?? '',
    riskRatingId: existing?.riskRatingId ?? '',
    matterSizeId: input.matterSizeId !== undefined ? input.matterSizeId : existing?.matterSizeId ?? null,
    jurisdictionGroupId:
      input.jurisdictionGroupId ?? existing?.jurisdictionGroupId ?? vid('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: input.jurisdictionIds ?? existing?.jurisdictionIds ?? [],
    governingLawId: input.governingLawId !== undefined ? input.governingLawId : existing?.governingLawId ?? null,
    forumCourt: (input.forumCourt ?? existing?.forumCourt ?? '').trim(),
    responsiblePartnerId:
      input.responsiblePartnerId !== undefined ? input.responsiblePartnerId : existing?.responsiblePartnerId ?? opts.byId,
    supervisingPartnerId:
      input.supervisingPartnerId !== undefined ? input.supervisingPartnerId : existing?.supervisingPartnerId ?? opts.byId,
    leadFeeEarnerId:
      input.leadFeeEarnerId !== undefined ? input.leadFeeEarnerId : existing?.leadFeeEarnerId ?? opts.byId,
    teamMemberIds: input.teamMemberIds ?? existing?.teamMemberIds ?? [],
    relationshipPartnerId:
      input.relationshipPartnerId !== undefined ? input.relationshipPartnerId : existing?.relationshipPartnerId ?? opts.byId,
    instructingContactId: resolvedInstructingContactId,
    billingContactId: resolvedBillingContactId,
    referrerTypeId: input.referrerTypeId !== undefined ? input.referrerTypeId : existing?.referrerTypeId ?? null,
    referrerContactId: resolvedReferrerContactId,
    parties: resolvedParties,
    conflictCheckStatus:
      resolvedConflictCheckRecord ?? storedConflictRecord
        ? legacyConflictStatusFromRecord(
            (resolvedConflictCheckRecord ?? storedConflictRecord)!,
          )
        : opts.saveMode === 'submit_referred'
          ? 'Pending conflict review'
          : isDraftSave
            ? existing?.conflictCheckStatus ?? 'Draft'
            : existing?.conflictCheckStatus ?? 'Clear',
    conflictCheckDate: input.conflictCheckDate !== undefined ? input.conflictCheckDate : existing?.conflictCheckDate ?? today,
    conflictClearedById: existing?.conflictClearedById ?? null,
    conflictNotes: input.conflictNotes ?? existing?.conflictNotes ?? '',
    amlStatus: (input.amlStatus || existing?.amlStatus || 'CMI incomplete').trim(),
    amlCompletedAt: input.amlCompletedAt !== undefined ? input.amlCompletedAt : existing?.amlCompletedAt ?? null,
    sourceOfFundsVerified: input.sourceOfFundsVerified ?? existing?.sourceOfFundsVerified ?? 'In progress',
    sourceOfWealthVerified: input.sourceOfWealthVerified ?? existing?.sourceOfWealthVerified ?? 'N/A',
    engagementLetterStatus: input.engagementLetterStatus ?? existing?.engagementLetterStatus ?? 'Drafting',
    engagementLetterSentAt:
      input.engagementLetterSentAt !== undefined ? input.engagementLetterSentAt : existing?.engagementLetterSentAt ?? null,
    engagementLetterSignedAt:
      input.engagementLetterSignedAt !== undefined
        ? input.engagementLetterSignedAt
        : existing?.engagementLetterSignedAt ?? null,
    feeEstimateGbp: input.feeEstimateGbp !== undefined ? input.feeEstimateGbp : existing?.feeEstimateGbp ?? null,
    agreedFeeCapGbp: input.agreedFeeCapGbp !== undefined ? input.agreedFeeCapGbp : existing?.agreedFeeCapGbp ?? null,
    retainerMoniesOnAccountGbp:
      input.retainerMoniesOnAccountGbp !== undefined
        ? input.retainerMoniesOnAccountGbp
        : existing?.retainerMoniesOnAccountGbp ?? null,
    stageId: input.stageId ?? existing?.stageId ?? vid('matter_stage', 'Stage 1 — Inception & Onboarding'),
    milestoneId: input.milestoneId !== undefined ? input.milestoneId : existing?.milestoneId ?? null,
    enquiryReceivedAt:
      input.enquiryReceivedAt !== undefined ? input.enquiryReceivedAt : existing?.enquiryReceivedAt ?? today,
    openedAt: input.openedAt !== undefined ? input.openedAt : existing?.openedAt ?? today,
    targetCompletionAt:
      input.targetCompletionAt !== undefined ? input.targetCompletionAt : existing?.targetCompletionAt ?? null,
    completedAt: input.completedAt !== undefined ? input.completedAt : existing?.completedAt ?? null,
    closedAt: input.closedAt !== undefined ? input.closedAt : existing?.closedAt ?? null,
    retentionPeriod: input.retentionPeriod ?? existing?.retentionPeriod ?? '6 years',
    destructionDueAt:
      input.destructionDueAt !== undefined ? input.destructionDueAt : existing?.destructionDueAt ?? null,
    fieldValues: {
      ...(existing?.fieldValues ?? {}),
      ...stripServerOwnedFieldValues(input.fieldValues),
    },
    conflictCheckRecord: resolvedConflictCheckRecord,
    ...(existing?.conflictDecision
      ? { conflictDecision: existing.conflictDecision }
      : {}),
    owningDepartmentId: nextOwningDepartmentId,
    owningTeamId: nextOwningTeamId,
    isStaffMatter: effectiveIsStaffMatter,
    hasEthicalWall: effectiveHasEthicalWall,
    restrictedAccessUserIds: effectiveRestrictedAccessUserIds,
    ...(Object.keys(nextRestrictionLift).length > 0
      ? { restrictionLift: nextRestrictionLift }
      : {}),
  };

  // Ensure full conflict check record, risk assessment snapshot, and immutable matter opening snapshot are persisted
  if (!matter.conflictCheckRecord) {
    matter.conflictCheckRecord =
      storedConflictRecord ??
      resolveMatterConflictCheckRecord(
        matter,
        allPeopleWithPending,
        allOrganisationsWithPending,
      );
    matter.conflictCheckStatus = legacyConflictStatusFromRecord(
      matter.conflictCheckRecord,
    );
  }
  const completedByPersonId = opts.byId;
  const completedByPerson =
    allPeopleWithPending.find((p) => p.id === completedByPersonId) ?? actingUser;
  const leadFeeEarnerPersonId =
    (input.leadFeeEarnerId !== undefined
      ? input.leadFeeEarnerId
      : existing?.leadFeeEarnerId) || null;
  const leadFeeEarnerPerson = leadFeeEarnerPersonId
    ? allPeopleWithPending.find((p) => p.id === leadFeeEarnerPersonId) ?? null
    : null;
  const fullRiskAssessment =
    validatedRiskAssessment.ok && validatedRiskAssessment.hasAnswers
      ? buildMatterRiskAssessmentSnapshot({
          answers: validatedRiskAssessment.answers,
          followUps: validatedRiskAssessment.followUps,
          customKeyDates: validatedRiskAssessment.customKeyDates,
          completedById: completedByPersonId,
          completedByName: personDisplayName(completedByPerson),
          leadFeeEarnerId: leadFeeEarnerPersonId,
          leadFeeEarnerName: leadFeeEarnerPerson
            ? personDisplayName(leadFeeEarnerPerson)
            : leadFeeEarnerPersonId,
          completedAt: now,
        })
      : resolveMatterRiskAssessment(
          matter,
          allPeopleWithPending,
          store.values,
        );
  matter.fieldValues['riskAssessment'] = fullRiskAssessment;
  matter.riskRatingId = fullRiskAssessment.overallRisk
    ? resolveRiskRatingIdForLevel(
        store.values,
        fullRiskAssessment.overallRisk,
      )
    : existing?.riskRatingId ?? '';

  // R108 & R131 & R173 & R178 & R179 & R181: Run active tenant extension hooks and unified matter opening gate
  const host = getPlatformExtensionHost();
  const { resolvedCosts, estimatedFeeGbp } = resolveMatterSignOffEstimateGbp(
    store,
    tenantCfg,
    matter,
  );
  const storedSignOff = matter.fieldValues['partnerCostSignOff'] as
    | PartnerCostSignOffRecord
    | undefined;
  if (
    matter.fieldValues['partnerCostSignOffCompleted'] &&
    (!storedSignOff || storedSignOff.signedOffEstimateGbp !== estimatedFeeGbp)
  ) {
    matter.fieldValues['partnerCostSignOffCompleted'] = false;
    delete matter.fieldValues['partnerCostSignOff'];
  }
  const partnerSignOffCompleted = Boolean(
    matter.fieldValues['partnerCostSignOffCompleted'],
  );
  const costsHookInput = {
    matterId: matter.id,
    workBasis: resolvedCosts.workBasis,
    estimatedFeeGbp,
    disbursementsTotalGbp: resolvedCosts.disbursementsTotalGbp,
    partnerSignOffCompleted,
  };
  const calcGovernance = tenantCfg.featureFlags?.enableMatterCostsGovernance
    ? await host.executeMatterCostsHook(
        'beforeMatterCostsCalculate',
        extensionCtx,
        tenantCfg,
        costsHookInput,
      )
    : {
        allowProceed: true,
        requiresPartnerSignOff: false,
        governanceWarnings: [],
        appliedTransformations: [],
      };
  const gateResult =
    !isDraftSave && !existingHasOpened && !isPmsImport
      ? await runMatterOpeningGate({
          store,
          matter,
          isNewMatter: !existing,
          extensionCtx,
          tenantCfg,
          costsHookInput,
          now,
        })
      : null;

  const shouldEnforceOpeningGate =
    !existingHasOpened &&
    (willOpen || opts.saveMode === 'submit_referred') &&
    !isPmsImport;
  if (shouldEnforceOpeningGate && gateResult && !gateResult.allowProceed) {
    return {
      matter: null,
      errors: gateResult.errors,
    };
  }

  for (const link of pendingEnquiryLinks) {
    link.enquiry.linkedPersonId = link.linkedPersonId;
  }

  matter.fieldValues['matterCostsGovernance'] =
    gateResult?.governance ?? calcGovernance;
  if (gateResult) {
    matter.fieldValues['matterOpeningGate'] = gateResult.record;
  } else if (isPmsImport && willOpen) {
    const importedGateRecord: MatterOpeningGateRecord = {
      allowProceed: true,
      estimatedFeeGbp,
      checkedAt: now,
    };
    matter.fieldValues['matterOpeningGate'] = importedGateRecord;
  } else if (!existingHasOpened) {
    const draftGateRecord: MatterOpeningGateRecord = {
      allowProceed: false,
      estimatedFeeGbp,
      checkedAt: now,
    };
    matter.fieldValues['matterOpeningGate'] = draftGateRecord;
  }

  if (!existing) {
    matter.id = await matterRepo.allocateNextMatterId(extensionCtx);
  }

  if (!existingHasOpened) {
    // Re-build fresh snapshot until the matter has actually opened (non-prospective status)
    const cleanFieldVals = { ...matter.fieldValues };
    delete cleanFieldVals['matterOpeningSnapshot'];
    const openingSnapshot = resolveMatterOpeningSnapshot(
      { ...matter, fieldValues: cleanFieldVals },
      allPeopleWithPending,
      allOrganisationsWithPending,
      store.values,
      enquiries,
      quotes,
      { riskAssessment: fullRiskAssessment },
    );
    openingSnapshot.saveMode = isDraftSave
      ? 'draft'
      : opts.saveMode ?? 'opened';
    openingSnapshot.capturedAt = now;
    openingSnapshot.capturedAtDisplay = formatDateTime(now) || now;
    matter.fieldValues['matterOpeningSnapshot'] = openingSnapshot;
  } else if (!existingSnapshot) {
    const cleanFieldVals = { ...matter.fieldValues };
    delete cleanFieldVals['matterOpeningSnapshot'];
    const backfilledSnapshot = resolveMatterOpeningSnapshot(
      {
        ...matter,
        conflictCheckRecord: storedConflictRecord ?? matter.conflictCheckRecord,
        conflictCheckStatus:
          existing?.conflictCheckStatus ?? matter.conflictCheckStatus,
        fieldValues: cleanFieldVals,
      },
      allPeopleWithPending,
      allOrganisationsWithPending,
      store.values,
      enquiries,
      quotes,
    );
    backfilledSnapshot.saveMode = 'backfilled';
    backfilledSnapshot.capturedAt = now;
    backfilledSnapshot.capturedAtDisplay = formatDateTime(now) || now;
    backfilledSnapshot.capturedById = opts.byId;
    backfilledSnapshot.capturedByName = actorDisplayName;
    backfilledSnapshot.captureNote =
      'Recorded after opening: matter opened before opening snapshots were captured.';
    matter.fieldValues['matterOpeningSnapshot'] = backfilledSnapshot;
  }

  const previousMatterSnapshot: Matter | undefined = existing ?? undefined;
  const expectedRowVersionForPut = existing
    ? (opts.expectedRowVersion ?? input.rowVersion ?? existingRowVersion)
    : undefined;
  try {
    await matterRepo.withTenantTransaction(extensionCtx, async () => {
      for (const person of pendingPeople) {
        await partyRepo.putPerson(extensionCtx, person);
      }
      for (const org of pendingOrganisations) {
        await partyRepo.putOrganisation(extensionCtx, org);
      }
      for (const link of pendingEnquiryLinks) {
        await intakeRepo.putEnquiry(extensionCtx, link.enquiry);
      }
      const saved = await putMatterWithInTxRestrictions(extensionCtx, matter, {
        expectedRowVersion: expectedRowVersionForPut,
      });
      matter = saved;

      if (!existing) {
        writeAudit(store, {
          recordType: 'matter',
          recordId: matter.id,
          action: 'create',
          field: null,
          oldValue: null,
          newValue: `${matter.matterNumber} — ${matter.title}`,
          byId: opts.byId,
          at: now,
        });
        writeAudit(store, {
          recordType: 'matter',
          recordId: matter.id,
          action: 'create',
          field: 'Conflict check record',
          oldValue: null,
          newValue: `${matter.conflictCheckRecord!.status} (${matter.conflictCheckRecord!.outcomeLabel}) · ${matter.conflictCheckRecord!.parties.length} parties checked`,
          byId: opts.byId,
          at: now,
        });
        writeAudit(store, {
          recordType: 'matter',
          recordId: matter.id,
          action: 'create',
          field: 'Matter risk assessment',
          oldValue: null,
          newValue: `Overall risk: ${fullRiskAssessment.overallRisk ?? 'Not assessed'} (${fullRiskAssessment.completedQuestions}/${fullRiskAssessment.totalQuestions} questions completed)`,
          byId: opts.byId,
          at: now,
        });
        writeAudit(store, {
          recordType: 'matter',
          recordId: matter.id,
          action: 'create',
          field: 'Matter opening snapshot (PDF)',
          oldValue: null,
          newValue: `Matter-Opening-Record-${matter.matterNumber}.pdf (Immutable historical copy captured at matter opening)`,
          byId: opts.byId,
          at: now,
        });
        if (isPmsImport && willOpen) {
          writeAudit(store, {
            recordType: 'matter',
            recordId: matter.id,
            action: 'matter-imported-open',
            field: 'PMS import',
            oldValue: null,
            newValue: `Imported already-open matter ${matter.matterNumber} from PMS (opening gate skipped)`,
            byId: opts.byId,
            at: now,
          });
        }

        if (matter.sourceEnquiryId) {
          await finalizeEnquiryConversionToMatter(
            store,
            matter.sourceEnquiryId,
            matter,
            opts.byId,
            now,
            extensionCtx,
          );
        }
        if (matter.sourceQuoteId) {
          await finalizeQuoteConversionToMatter(
            store,
            matter.sourceQuoteId,
            matter,
            opts.byId,
            now,
            extensionCtx,
          );
        }
      } else if (previousMatterSnapshot) {
        writeAudit(store, {
          recordType: 'matter',
          recordId: matter.id,
          action: 'update',
          field: 'Matter details & type-specific fields',
          oldValue: previousMatterSnapshot.title,
          newValue: `${matter.matterNumber} — ${matter.title}`,
          byId: opts.byId,
          at: now,
        });
        if (
          !existingHasOpened &&
          (opts.saveMode === 'submit_cleared' || opts.saveMode === 'submit_referred')
        ) {
          writeAudit(store, {
            recordType: 'matter',
            recordId: matter.id,
            action: 'update',
            field: 'Matter opening snapshot (PDF)',
            oldValue: null,
            newValue: `Matter-Opening-Record-${matter.matterNumber}.pdf (Immutable historical copy captured at matter opening)`,
            byId: opts.byId,
            at: now,
          });
        }

        if (matter.sourceEnquiryId) {
          await finalizeEnquiryConversionToMatter(
            store,
            matter.sourceEnquiryId,
            matter,
            opts.byId,
            now,
            extensionCtx,
          );
        }
        if (matter.sourceQuoteId) {
          await finalizeQuoteConversionToMatter(
            store,
            matter.sourceQuoteId,
            matter,
            opts.byId,
            now,
            extensionCtx,
          );
        }
      }

      // Handle To Do task creation / completion for Draft & Referred conflict checks
      const clientOrg = allOrganisationsWithPending.find((o) => o.id === matter.clientId);
      const clientPerson = allPeopleWithPending.find((p) => p.id === matter.clientId);
      const clientLabel =
        clientOrg?.legalName ||
        (clientPerson ? personDisplayName(clientPerson) : matter.title || 'Untitled matter');
      const draftTaskTitle = `Conflict check · ${clientLabel} · Draft`;

      const existingDraftTask = tasks.find(
        (t) =>
          t.status !== 'Done' &&
          t.status !== 'Cancelled' &&
          (t.title === draftTaskTitle ||
            (t.title.startsWith('Conflict check ·') &&
              t.linkedRecords.some((r) => r.recordType === 'matter' && r.recordId === matter.id))),
      );

      if (isDraftSave) {
        if (existingDraftTask) {
          existingDraftTask.title = draftTaskTitle;
          existingDraftTask.updatedAt = now;
          existingDraftTask.updatedById = opts.byId;
          await taskRepo.putTask(extensionCtx, existingDraftTask);
        } else {
          const taskId = await taskRepo.allocateNextTaskId(extensionCtx);
          const linkedRecords: TaskLinkedRecord[] = [{ recordType: 'matter', recordId: matter.id }];
          if (clientOrg) linkedRecords.push({ recordType: 'organisation', recordId: clientOrg.id });
          else if (clientPerson) linkedRecords.push({ recordType: 'person', recordId: clientPerson.id });
          const newDraftTask: Task = {
            id: taskId,
            reference: taskId,
            title: draftTaskTitle,
            description: `Saved conflict check draft for ${matter.title}. Reopen to run fresh search and submit.`,
            taskTypeId: vid('task_type', 'Conflict check'),
            priorityId: vid('task_priority', 'High'),
            dueAt: today,
            assignedTeamId: null,
            assignedPersonId: opts.byId,
            status: 'To do',
            linkedRecords,
            createdById: opts.byId,
            createdAt: now,
            updatedById: opts.byId,
            updatedAt: now,
            completedById: null,
            completedAt: null,
            comments: [],
          };
          await taskRepo.putTask(extensionCtx, newDraftTask);
        }
      } else if (opts.saveMode === 'submit_cleared' || opts.saveMode === 'submit_referred') {
        if (existingDraftTask) {
          existingDraftTask.status = 'Done';
          existingDraftTask.completedById = opts.byId;
          existingDraftTask.completedAt = now;
          existingDraftTask.updatedAt = now;
          existingDraftTask.updatedById = opts.byId;
          await taskRepo.putTask(extensionCtx, existingDraftTask);
        }
        if (opts.saveMode === 'submit_referred') {
          const riskTaskId = await taskRepo.allocateNextTaskId(extensionCtx);
          const configuredTeamKey = tenantCfg.conflictReview?.assigneeTeamKey?.trim() || null;
          const configuredRoleKey = tenantCfg.conflictReview?.assigneeRoleKey?.trim() || null;
          const { team: resolvedRiskTeam, assigneeId: assignedReviewerId } =
            resolveConflictReviewTaskRouting(
              { people: allPeopleWithPending, teams, orgStructure: store.orgStructure },
              tenantCfg.conflictReview,
              matter,
            );

          if (!assignedReviewerId) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'conflict_review_task_unassigned',
                tenantId: extensionCtx.tenantId,
                correlationId: extensionCtx.correlationId,
                matterId: matter.id,
                configuredTeamKey,
                configuredRoleKey,
                assignedTeamId: resolvedRiskTeam?.id ?? null,
              }),
            );
          }

          const isRestrictedMatter = Boolean(matter.isStaffMatter || matter.hasEthicalWall);
          const canIncludeMatterNames = !isRestrictedMatter || Boolean(assignedReviewerId);
          const linkedRecords: TaskLinkedRecord[] = [{ recordType: 'matter', recordId: matter.id }];
          if (canIncludeMatterNames) {
            if (clientOrg) linkedRecords.push({ recordType: 'organisation', recordId: clientOrg.id });
            else if (clientPerson) linkedRecords.push({ recordType: 'person', recordId: clientPerson.id });
          }
          const riskTask: Task = {
            id: riskTaskId,
            reference: riskTaskId,
            title: canIncludeMatterNames
              ? `Conflict review · ${clientLabel} — ${matter.title}`
              : `Conflict review required: ${matter.id}`,
            description: canIncludeMatterNames
              ? matter.conflictCheckRecord?.reviewerMessage ||
                `Referred to Risk & Compliance for conflict review on ${clientLabel}.`
              : `Referred for conflict review on restricted matter ${matter.id}.`,
            taskTypeId: vid('task_type', 'Conflict check'),
            priorityId: vid('task_priority', 'High'),
            dueAt: today,
            assignedTeamId: resolvedRiskTeam?.id ?? null,
            assignedPersonId: assignedReviewerId,
            status: 'To do',
            linkedRecords,
            createdById: opts.byId,
            createdAt: now,
            updatedById: opts.byId,
            updatedAt: now,
            completedById: null,
            completedAt: null,
            comments: [],
          };
          await taskRepo.putTask(extensionCtx, riskTask);
        }
      }

      await flushStagedAuditEntries(extensionCtx);
    });
  } catch (err) {
    if ((err as { code?: string })?.code === MATTER_CONCURRENCY_CONFLICT_CODE) {
      return {
        matter: null,
        code: MATTER_CONCURRENCY_CONFLICT_CODE,
        message: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        errors: {
          conflict: MATTER_CONCURRENCY_CONFLICT_MESSAGE,
        },
      };
    }
    throw err;
  }

  if (previousMatterSnapshot) {
    pendingLifecycleSync = {
      matter,
      previousMatter: previousMatterSnapshot,
      store,
    };
  }

  return { matter };
  });
  if (pendingLifecycleSync) {
    const syncItem = pendingLifecycleSync as {
      matter: Matter;
      previousMatter: Matter;
      store: FirmStore;
    };
    const syncCorrelationId = `corr-lifecycle-sync-${syncItem.matter.id}-${Date.now()}`;
    try {
      void syncMatterLifecycleOnSaveSync({
        matter: syncItem.matter,
        previousMatter: syncItem.previousMatter,
        userId: opts.byId,
        correlationId: syncCorrelationId,
        store: syncItem.store,
      }).catch((err) => {
        logDocumentLifecycleSyncError(err, syncCorrelationId);
      });
    } catch (err) {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    }
  }
  return res;
}

export async function markEngagementLetterDrafted(
  matterId: string,
  byId: string,
): Promise<{ matter: Matter | null; errors?: Record<string, string> }> {
  let ctx: TenantContext;
  try {
    ctx = resolveDefaultServiceTenantContext(null, byId);
  } catch {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
      },
    };
  }
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const [people, existing, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(ctx),
    matterRepo.getMatterById<Matter>(ctx, matterId),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actingUser = people.find((p) => p.id === byId) ?? null;
  if (
    !existing ||
    !actingUser ||
    !actingUser.isEmployee ||
    !canPersonAccessMatter(existing, byId, actingUser, {
      allPeople: people,
      teams,
    })
  ) {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
      },
    };
  }
  if (
    !hasPersonPermission(actingUser, 'matter:edit', {
      allPeople: people,
      teams,
    })
  ) {
    return {
      matter: null,
      errors: {
        permission: 'You do not have permission (matter:edit) to edit matters.',
      },
    };
  }
  if (existing.engagementLetterStatus === 'Signed') {
    return { matter: existing };
  }
  const prevStatus = existing.engagementLetterStatus;
  existing.engagementLetterStatus = 'Drafted';
  const now = touchMatter(existing, byId);
  let saved!: Matter;
  await runWithAuditStagingScope(() =>
    matterRepo.withTenantTransaction(ctx, async () => {
      saved = await putMatterWithInTxRestrictions(ctx, existing, {
        expectedRowVersion: null,
      });
      writeAudit(null, {
        recordType: 'matter',
        recordId: existing.id,
        action: 'update',
        field: 'Engagement letter status',
        oldValue: prevStatus,
        newValue: 'Drafted',
        byId,
        at: now,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return { matter: saved };
}

export async function liftMatterRestriction(
  matterId: string,
  restriction: 'staff_matter' | 'ethical_wall',
  reason: string,
  byId: string,
): Promise<{ matter: Matter | null; errors?: Record<string, string> }> {
  let prelimCtx: TenantContext;
  try {
    prelimCtx = resolveDefaultServiceTenantContext(null, byId);
  } catch {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
      },
    };
  }
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const [people, existing, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(prelimCtx),
    matterRepo.getMatterById<Matter>(prelimCtx, matterId),
    getHrAndRbacRepository().listAllTeams<Team>(prelimCtx),
  ]);
  const actingUser = people.find((p) => p.id === byId) ?? null;
  if (
    !existing ||
    !actingUser ||
    !actingUser.isEmployee ||
    !canPersonAccessMatter(existing, byId, actingUser, {
      allPeople: people,
      teams,
    })
  ) {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
      },
    };
  }
  const canLift = hasPersonPermission(actingUser, 'matter:restriction:lift', {
    allPeople: people,
    teams,
  });
  if (!canLift) {
    return {
      matter: null,
      errors: {
        permission:
          'You do not have permission (matter:restriction:lift) to lift matter restrictions.',
      },
    };
  }
  const activeVerifiedSession = getActiveActorSession()?.verifiedSession as
    | VerifiedEntraSessionPayload
    | undefined;
  if (!activeVerifiedSession || activeVerifiedSession.mfaVerified !== true) {
    return {
      matter: null,
      errors: {
        mfa: 'MFA_REQUIRED: Multi-factor authentication is required to lift a staff matter or information barrier restriction.',
      },
    };
  }
  const cleanReason = (reason ?? '').trim();
  if (!cleanReason) {
    return {
      matter: null,
      errors: {
        reason: 'A written reason is required to lift a matter restriction.',
      },
    };
  }

  const prevMatter = structuredClone(existing);
  const now = touchMatter(existing, byId);
  const fieldLabel =
    restriction === 'staff_matter' ? 'Staff matter restriction' : 'Information barrier';
  const oldVal =
    restriction === 'staff_matter'
      ? String(Boolean(existing.isStaffMatter))
      : String(Boolean(existing.hasEthicalWall));

  if (restriction === 'staff_matter') {
    const staffParticipantIds = Array.from(
      new Set(
        [existing.clientId, ...(existing.additionalClientIds ?? [])].filter(
          (cid): cid is string =>
            Boolean(cid && people.some((p) => p.id === cid && isWorkingAtFirm(p))),
        ),
      ),
    );
    existing.isStaffMatter = false;
    existing.restrictionLift = {
      ...(existing.restrictionLift ?? {}),
      staffMatter: {
        liftedAt: now,
        byId,
        liftedParticipantIds: staffParticipantIds,
      },
    };
  } else {
    const barrierMatchIds = (existing.conflictCheckRecord?.matches ?? [])
      .filter((m) => m.reviewerConditionType === 'information_barrier')
      .map((m) => m.id);
    existing.hasEthicalWall = false;
    existing.restrictionLift = {
      ...(existing.restrictionLift ?? {}),
      ethicalWall: {
        liftedAt: now,
        byId,
        liftedBarrierMatchIds: barrierMatchIds,
      },
    };
  }
  if (!existing.isStaffMatter && !existing.hasEthicalWall) {
    existing.restrictedAccessUserIds = [];
  }

  const liftCtx = resolveDefaultServiceTenantContext(null, byId, {
    session: activeVerifiedSession,
  });
  const store = await loadTenantCatalogueStoreView(liftCtx);
  let saved!: Matter;
  await runWithAuditStagingScope(() =>
    matterRepo.withTenantTransaction(liftCtx, async () => {
      saved = await putMatterWithInTxRestrictions(liftCtx, existing, {
        expectedRowVersion: null,
      });
      writeAudit(null, {
        recordType: 'matter',
        recordId: existing.id,
        action: 'matter-restriction-lift',
        field: fieldLabel,
        oldValue: oldVal,
        newValue: 'false',
        reason: cleanReason,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(liftCtx);
    }),
  );

  const syncCorrelationId = `corr-lifecycle-sync-${saved.id}-${Date.now()}`;
  try {
    void syncMatterLifecycleOnSaveSync({
      matter: saved,
      previousMatter: prevMatter,
      userId: byId,
      correlationId: syncCorrelationId,
      store,
    }).catch((err) => {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    });
  } catch (err) {
    logDocumentLifecycleSyncError(err, syncCorrelationId);
  }

  return { matter: saved };
}

export async function runMatterConflictSearchRecord(
  input: MatterConflictSearchInput,
  byId: string,
): Promise<{
  matches: ConflictCheckMatch[];
  run?: ConflictCheckRunAudit;
  matter?: Matter | null;
  errors?: Record<string, string>;
}> {
  let ctx: TenantContext;
  try {
    ctx = resolveDefaultServiceTenantContext(null, byId);
  } catch {
    return {
      matches: [],
      errors: {
        permission:
          'You do not have permission (matter:create or matter:edit) to run a matter conflict search.',
      },
    };
  }
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [people, organisations, links, matters, enquiries, quotes, teams] = await Promise.all([
    partyRepo.listAllPeople<Person>(ctx),
    partyRepo.listAllOrganisations<Organisation>(ctx),
    partyRepo.listAllLinks<PersonOrganisationLink>(ctx),
    matterRepo.listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actingUser = people.find((p) => p.id === byId) ?? null;
  if (
    !actingUser ||
    !actingUser.isEmployee ||
    (!hasPersonPermission(actingUser, 'matter:create', {
      allPeople: people,
      teams,
    }) &&
      !hasPersonPermission(actingUser, 'matter:edit', {
        allPeople: people,
        teams,
      }))
  ) {
    return {
      matches: [],
      errors: {
        permission:
          'You do not have permission (matter:create or matter:edit) to run a matter conflict search.',
      },
    };
  }
  const actorHasRiskView = hasPersonPermission(actingUser, 'risk:view', {
    allPeople: people,
    teams,
  });
  const visibility = buildRecordVisibility({ teams }, actingUser, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const nowIso = new Date().toISOString();
  const actorDisplayName = personDisplayName(actingUser);
  const matches = searchMatterConflicts(
    {
      ...input,
      canReviewConditions: actorHasRiskView,
      reviewerUserId: actorHasRiskView ? byId : null,
      reviewerDisplayName: actorHasRiskView ? actorDisplayName : null,
      reviewedAtIso: nowIso,
    },
    {
      matters,
      enquiries,
      people,
      organisations,
      links,
      tenantId: getActiveTenantConfiguration().tenantId,
      canView: visibility.canViewMatter,
      canViewEnquiry: visibility.canViewEnquiry,
    },
  );
  const displayNow = formatDateTime(nowIso) || nowIso;
  const run: ConflictCheckRunAudit = {
    id: `run-srv-${randomUUID()}`,
    runAtDisplay: displayNow,
    runById: byId,
    runByName: actorDisplayName,
    searchTerms: input.parties.map((p) => p.name).filter(Boolean),
    partiesCount: input.parties.length,
    matchesCount: matches.length,
    potentialConflictsCount: matches.filter(
      (m) => m.disposition === 'potential_conflict' || m.restricted,
    ).length,
    searchedSources: [...CONFLICT_SEARCHED_SOURCES],
  };
  let savedMatter = input.currentMatterId
    ? matters.find((m) => m.id === input.currentMatterId) ?? null
    : null;
  const hasSavedMatter = Boolean(savedMatter);
  let matterUpdated = false;
  let auditWritten = false;
  if (
    savedMatter &&
    visibility.canViewMatter(savedMatter) &&
    hasPersonPermission(actingUser, 'matter:edit', {
      allPeople: people,
      teams,
    }) &&
    savedMatter.conflictCheckRecord
  ) {
    savedMatter.conflictCheckRecord.runs = [
      ...(savedMatter.conflictCheckRecord.runs ?? []),
      run,
    ];
    savedMatter.conflictCheckRecord.lastRunAtDisplay = displayNow;
    savedMatter.conflictCheckRecord.lastRunById = byId;
    savedMatter.conflictCheckRecord.lastRunByName = actorDisplayName;
    touchMatter(savedMatter, byId);
    matterUpdated = true;
  }
  const restrictedCount = matches.filter((m) => m.restricted).length;
  await runWithAuditStagingScope(async () => {
    if (restrictedCount > 0) {
      const tenantId = getActiveTenantConfiguration().tenantId;
      const activeSession = getActiveActorSession();
      const correlationId =
        (activeSession as { correlationId?: string } | null)?.correlationId ??
        `conflict-search-${randomUUID()}`;
      if (hasSavedMatter && input.currentMatterId) {
        writeAudit(null, {
          recordType: 'matter',
          recordId: input.currentMatterId,
          action: 'update',
          field: 'Conflict check restricted match',
          oldValue: null,
          newValue: `Restricted conflict match count: ${restrictedCount} across ${input.parties.length} searched party/parties`,
          byId,
        });
        auditWritten = true;
      }
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'conflict_search_restricted_match',
          tenantId,
          correlationId,
          actorId: byId,
          matterId: hasSavedMatter ? input.currentMatterId : null,
          partiesCount: input.parties.length,
          restrictedCount,
        }),
      );
    }
    if (matterUpdated || auditWritten) {
      await matterRepo.withTenantTransaction(ctx, async () => {
        if (matterUpdated && savedMatter) {
          savedMatter = await putMatterWithInTxRestrictions(ctx, savedMatter, {
            expectedRowVersion: null,
          });
        }
        if (auditWritten) {
          await flushStagedAuditEntries(ctx);
        }
      });
    }
  });
  return { matches, run, ...(savedMatter ? { matter: savedMatter } : {}) };
}

export async function updateMatterConflictRecord(
  matterId: string,
  record: ConflictCheckRecordInput | ConflictCheckRecord,
  byId: string,
): Promise<{ matter: Matter | null; errors?: Record<string, string>; warnings?: string[] }> {
    let conflictCtx: TenantContext;
    try {
      conflictCtx = resolveDefaultServiceTenantContext(null, byId);
    } catch {
      return { matter: null };
    }
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const [store, people, organisations, links, matters, enquiries, quotes, teams] = await Promise.all([
      loadTenantCatalogueStoreView(conflictCtx),
      partyRepo.listAllPeople<Person>(conflictCtx),
      partyRepo.listAllOrganisations<Organisation>(conflictCtx),
      partyRepo.listAllLinks<PersonOrganisationLink>(conflictCtx),
      matterRepo.listAllMattersUnfiltered<Matter>(conflictCtx),
      intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(conflictCtx),
      intakeRepo.listAllQuotesUnfiltered<Quote>(conflictCtx),
      getHrAndRbacRepository().listAllTeams<Team>(conflictCtx),
    ]);
  const today = toIsoDate(new Date());
  const matter = matters.find((m) => m.id === matterId);
  const actingUser = people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actingUser, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  if (
    !matter ||
    !actingUser ||
    !actingUser.isEmployee ||
    !visibility.canViewMatter(matter) ||
    !hasPersonPermission(actingUser, 'matter:edit', {
      allPeople: people,
      teams,
    })
  ) {
    return { matter: null };
  }
  const actorHasRiskView = hasPersonPermission(actingUser, 'risk:view', {
    allPeople: people,
    teams,
  });
  if (
    (record.status === 'Approved' || record.status === 'Declined') &&
    !actorHasRiskView
  ) {
    return {
      matter: null,
      errors: {
        permission:
          'Forbidden: risk:view permission is required to approve or decline conflict reviews.',
      },
    };
  }
  const storedConflictRecord =
    matter.conflictCheckRecord ??
    resolveMatterConflictCheckRecord(matter, people, organisations);
  const prospectiveStatusId = resolveProspectiveStatusId(store);
  const opened = matterHasOpened(matter, prospectiveStatusId);
  if (
    storedConflictRecord.status === 'Referred' &&
    record.status === 'Cleared' &&
    !actorHasRiskView
  ) {
    return {
      matter: null,
      errors: {
        conflict:
          'This matter has been referred to Risk. Only Risk & Compliance can clear or approve it.',
      },
    };
  }
  if (
    opened &&
    !actorHasRiskView &&
    record.status !== storedConflictRecord.status &&
    record.status !== 'Referred'
  ) {
    return {
      matter: null,
      errors: {
        conflict:
          'This matter has opened. Its conflict check cannot be reset; it can only be referred to Risk & Compliance.',
      },
    };
  }
  const nowCheckIso = new Date().toISOString();
  const actorDisplayName = personDisplayName(actingUser);
  const effectiveParties = buildEffectiveConflictParties({
    submittedParties: record.parties,
    clientId: matter.clientId,
    additionalClientIds: matter.additionalClientIds,
    instructingContactId: matter.instructingContactId,
    billingContactId: matter.billingContactId,
    matterParties: matter.parties,
    people,
    organisations,
  });
  const rawServerMatches = searchMatterConflicts(
    {
      currentMatterId: matter.id,
      sourceEnquiryId: matter.sourceEnquiryId,
      parties: effectiveParties,
      previousMatches:
        record.matches ?? storedConflictRecord.matches ?? [],
      canReviewConditions: actorHasRiskView,
      reviewerUserId: actorHasRiskView ? byId : null,
      reviewerDisplayName: actorHasRiskView ? actorDisplayName : null,
      reviewedAtIso: nowCheckIso,
    },
    {
      matters,
      enquiries,
      people,
      organisations,
      links,
      tenantId: getActiveTenantConfiguration().tenantId,
      canView: visibility.canViewMatter,
      canViewEnquiry: visibility.canViewEnquiry,
    },
  );
  const reconciledMatches = reconcileServerConflictMatches({
    serverMatches: rawServerMatches,
    submittedMatches: record.matches,
    existingStoredMatches: storedConflictRecord.matches,
    canReviewConditions: actorHasRiskView,
    reviewerUserId: actorHasRiskView ? byId : null,
    reviewerDisplayName: actorHasRiskView ? actorDisplayName : null,
    reviewedAtIso: nowCheckIso,
  });

  if (
    record.status === 'Cleared' &&
    hasUnapprovedRestrictedMatches(
      reconciledMatches,
      storedConflictRecord.approvedRestrictedMatchIds,
    )
  ) {
    return {
      matter: null,
      errors: {
        conflict:
          'This matter must be referred to Risk because a match was found on a restricted record.',
      },
    };
  }

  const prevMatter = structuredClone(matter);
  const now = touchMatter(matter, byId);
  const sanitisedRecord = buildServerConflictCheckRecord({
    submitted: record,
    stored: storedConflictRecord,
    storedMatterHasOpened: opened,
    parties: effectiveParties,
    matches: reconciledMatches,
    actorId: byId,
    actorDisplayName,
    actorHasRiskView,
    nowDisplay: now,
    saveMode: record.status === 'Referred' ? 'submit_referred' : undefined,
  });

  matter.conflictCheckRecord = sanitisedRecord;

  const currentBarrierMatchIds = (sanitisedRecord.matches ?? [])
    .filter((m) => m.reviewerConditionType === 'information_barrier')
    .map((m) => m.id);
  const priorWallLift = matter.restrictionLift?.ethicalWall;
  const hasUnliftedBarrierCondition = currentBarrierMatchIds.some(
    (mid) => !(priorWallLift?.liftedBarrierMatchIds ?? []).includes(mid),
  );
  if (hasUnliftedBarrierCondition) {
    matter.hasEthicalWall = true;
    if (matter.restrictionLift?.ethicalWall) {
      const nextLift = { ...matter.restrictionLift };
      delete nextLift.ethicalWall;
      matter.restrictionLift = Object.keys(nextLift).length > 0 ? nextLift : undefined;
    }
    const allowed = new Set<string>(
      [
        ...(matter.restrictedAccessUserIds ?? []),
        matter.responsiblePartnerId,
        matter.supervisingPartnerId,
        matter.leadFeeEarnerId,
        ...(matter.teamMemberIds ?? []),
      ].filter((id): id is string => Boolean(id)),
    );
    matter.restrictedAccessUserIds = Array.from(allowed);
  }

  const gate = matter.fieldValues?.['matterOpeningGate'] as
    | MatterOpeningGateRecord
    | undefined;

  const warnings: string[] = [];
  matter.conflictCheckStatus = legacyConflictStatusFromRecord(sanitisedRecord);
  if (sanitisedRecord.status === 'Approved' || sanitisedRecord.status === 'Cleared') {
    if (actorHasRiskView) {
      matter.conflictClearedById = byId;
    } else {
      matter.conflictClearedById = null;
    }
    matter.conflictCheckDate = today;
    if (
      sanitisedRecord.status === 'Approved' &&
      !opened
    ) {
      const kdConfig = await getKeyDatesConfig({ ctx: conflictCtx });
      const [matterKeyDates, matterKeyDateNa] = kdConfig.enabled
        ? await Promise.all([
            getKeyDateRepository().listKeyDatesForMatter(
              conflictCtx,
              matter.id,
              byId,
            ),
            getKeyDateRepository().listNotApplicableForMatter(
              conflictCtx,
              matter.id,
              byId,
            ),
          ])
        : [[], []];
      const keyDatesOpenGate = kdConfig.enabled
        ? evaluateMatterKeyDateOpeningGate(
            kdConfig,
            matter.matterTypeId || matter.practiceAreaId,
            matterKeyDates,
            matterKeyDateNa,
          )
        : { canOpen: true, missingKeyDateTypes: [] };
      const hasPassedOpeningGate =
        matter.matterNumber !== 'DRAFT' &&
        !matter.matterNumber.startsWith('DRAFT') &&
        gate?.allowProceed === true &&
        keyDatesOpenGate.canOpen;
      if (hasPassedOpeningGate) {
        const activeStatusId = vid('matter_status', 'Active');
        matter.matterStatusId = activeStatusId;
        matter.recordStatusId = activeStatusId;
        const cleanFieldVals = { ...(matter.fieldValues ?? {}) };
        delete cleanFieldVals['matterOpeningSnapshot'];
        const openingSnapshot = resolveMatterOpeningSnapshot(
          { ...matter, fieldValues: cleanFieldVals },
          people,
          organisations,
          store.values,
          enquiries,
          quotes,
        );
        openingSnapshot.saveMode = 'opened';
        openingSnapshot.capturedAt = now;
        matter.fieldValues = {
          ...(matter.fieldValues ?? {}),
          matterOpeningSnapshot: openingSnapshot,
        };
      } else {
        warnings.push(
          'Conflict approved. The matter will open once it passes the opening checks (including partner cost sign-off and required key dates).',
        );
      }
    }
  }

  let saved!: Matter;
  await runWithAuditStagingScope(() =>
    matterRepo.withTenantTransaction(conflictCtx, async () => {
      saved = await putMatterWithInTxRestrictions(conflictCtx, matter, {
        expectedRowVersion: null,
      });
      writeAudit(store, {
        recordType: 'matter',
        recordId: matter.id,
        action: 'update',
        field: 'Conflict check record',
        oldValue: null,
        newValue: `${sanitisedRecord.status} — ${sanitisedRecord.outcomeLabel}`,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(conflictCtx);
    }),
  );

  const syncCorrelationId = `corr-lifecycle-sync-${saved.id}-${Date.now()}`;
  try {
    void syncMatterLifecycleOnSaveSync({
      matter: saved,
      previousMatter: prevMatter,
      userId: byId,
      correlationId: syncCorrelationId,
      store,
    }).catch((err) => {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    });
  } catch (err) {
    logDocumentLifecycleSyncError(err, syncCorrelationId);
  }

  return { matter: saved, ...(warnings.length > 0 ? { warnings } : {}) };
}

export async function signOffMatterCostsRecord(
  matterId: string,
  byId: string,
  note?: string,
): Promise<
  {
    matter: Matter | null;
    errors?: Record<string, string>;
    warnings?: string[];
  } & Partial<ActionDenied>
> {
  const tenantCfg = getActiveTenantConfiguration();
  if (!tenantCfg.featureFlags?.enableMatterCostsGovernance) {
    const msg =
      'Forbidden: Matter costs governance is disabled for this tenant (featureFlags.enableMatterCostsGovernance is false).';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      matter: null,
    };
  }
  let prelimCtx: TenantContext;
  try {
    prelimCtx = resolveDefaultServiceTenantContext(null, byId);
  } catch {
    return {
      matter: null,
      errors: { permission: 'Matter not found or restricted.' },
    };
  }
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, organisations, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(prelimCtx),
    partyRepo.listAllPeople<Person>(prelimCtx),
    partyRepo.listAllOrganisations<Organisation>(prelimCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(prelimCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(prelimCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(prelimCtx),
    getHrAndRbacRepository().listAllTeams<Team>(prelimCtx),
  ]);
  const matter = matters.find((m) => m.id === matterId) ?? null;
  const actingUser = people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actingUser, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  if (
    !matter ||
    !actingUser ||
    !actingUser.isEmployee ||
    !visibility.canViewMatter(matter)
  ) {
    return {
      matter: null,
      errors: { permission: 'Matter not found or restricted.' },
    };
  }
  if (
    !hasPersonPermission(actingUser, 'matter:costs:sign_off', {
      allPeople: people,
      teams,
    })
  ) {
    return {
      matter: null,
      errors: {
        permission:
          'Forbidden: matter:costs:sign_off permission is required to sign off matter costs.',
      },
    };
  }
  const activeVerifiedSession = getActiveActorSession()?.verifiedSession as
    | VerifiedEntraSessionPayload
    | undefined;
  if (!activeVerifiedSession || activeVerifiedSession.personId !== actingUser.id) {
    return {
      matter: null,
      errors: {
        access: 'UNAUTHENTICATED: Your session has expired. Please sign in again.',
      },
    };
  }
  let extensionCtx: TenantContext;
  try {
    extensionCtx = resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(activeVerifiedSession, {
        correlationId: `matter-cost-signoff-${randomUUID()}`,
      }),
      tenantCfg,
    );
  } catch {
    return {
      matter: null,
      errors: {
        access:
          'UNAUTHENTICATED: Your session is invalid for this tenant. Please sign in again.',
      },
    };
  }

  const { resolvedCosts, estimatedFeeGbp: signedOffEstimateGbp } =
    resolveMatterSignOffEstimateGbp(store, tenantCfg, matter);
  const now = touchMatter(matter, byId);
  const signOffRecord: PartnerCostSignOffRecord = {
    byId,
    byName: personDisplayName(actingUser),
    at: now,
    note: (note ?? '').trim(),
    signedOffEstimateGbp,
  };
  matter.fieldValues = {
    ...(matter.fieldValues ?? {}),
    partnerCostSignOffCompleted: true,
    partnerCostSignOff: signOffRecord,
  };

  const host = getPlatformExtensionHost();
  const hookInput = {
    matterId: matter.id,
    workBasis: resolvedCosts.workBasis,
    estimatedFeeGbp: signedOffEstimateGbp,
    disbursementsTotalGbp: resolvedCosts.disbursementsTotalGbp,
    partnerSignOffCompleted: true,
  };
  const calcGovernance = await host.executeMatterCostsHook(
    'beforeMatterCostsCalculate',
    extensionCtx,
    tenantCfg,
    hookInput,
  );
  const gateResult = await runMatterOpeningGate({
    store,
    matter,
    isNewMatter: false,
    extensionCtx,
    tenantCfg,
    costsHookInput: hookInput,
    now,
  });
  matter.fieldValues['matterCostsGovernance'] =
    gateResult.governance ?? calcGovernance;
  matter.fieldValues['matterOpeningGate'] = gateResult.record;

  const warnings: string[] = [];
  const prospectiveStatusId = vid('matter_status', 'Prospective / Enquiry');
  if (
    matter.matterNumber !== 'DRAFT' &&
    !matter.matterNumber.startsWith('DRAFT') &&
    matter.matterStatusId === prospectiveStatusId &&
    matter.conflictCheckRecord?.status === 'Approved'
  ) {
    if (gateResult.allowProceed) {
      const activeStatusId = vid('matter_status', 'Active');
      matter.matterStatusId = activeStatusId;
      matter.recordStatusId = activeStatusId;
      const cleanFieldVals = { ...matter.fieldValues };
      delete cleanFieldVals['matterOpeningSnapshot'];
      const openingSnapshot = resolveMatterOpeningSnapshot(
        { ...matter, fieldValues: cleanFieldVals },
        people,
        organisations,
        store.values,
        enquiries,
        quotes,
      );
      openingSnapshot.saveMode = 'opened';
      openingSnapshot.capturedAt = now;
      matter.fieldValues['matterOpeningSnapshot'] = openingSnapshot;
    } else {
      warnings.push(
        Object.values(gateResult.errors)[0] ??
          'The matter will open once it passes the opening checks.',
      );
    }
  } else if (!gateResult.allowProceed) {
    const firstErr = Object.values(gateResult.errors)[0];
    if (firstErr) warnings.push(firstErr);
  }

  let saved!: Matter;
  await runWithAuditStagingScope(() =>
    matterRepo.withTenantTransaction(extensionCtx, async () => {
      saved = await putMatterWithInTxRestrictions(extensionCtx, matter, {
        expectedRowVersion: null,
      });
      writeAudit(store, {
        recordType: 'matter',
        recordId: matter.id,
        action: 'update',
        field: 'Partner cost sign-off',
        oldValue: null,
        newValue: `Signed off £${signedOffEstimateGbp.toLocaleString('en-GB')} by ${signOffRecord.byName}${signOffRecord.note ? ` (${signOffRecord.note})` : ''}`,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(extensionCtx);
    }),
  );
  return { matter: saved, ...(warnings.length > 0 ? { warnings } : {}) };
}

export async function dismissDuplicateMatch(
  recordType: RecordType,
  recordId: string,
  otherId: string | null,
  byId: string,
): Promise<{ ok: true } | ActionDenied> {
  const dupCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const [store, people, organisations, teams] = await Promise.all([
    loadTenantCatalogueStoreView(dupCtx),
    partyRepo.listAllPeople<Person>(dupCtx),
    recordType === 'organisation'
      ? partyRepo.listAllOrganisations<Organisation>(dupCtx)
      : Promise.resolve([] as Organisation[]),
    getHrAndRbacRepository().listAllTeams<Team>(dupCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'record:merge', {
      allPeople: people,
      teams,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (record:merge) to dismiss duplicate matches.',
    );
  }
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const list: AnyRecord[] = recordType === 'person' ? people : organisations;
  const rec = list.find((r) => r.id === recordId);
  if (!rec) {
    return buildActionDenied('FORBIDDEN', `Target ${recordType} "${recordId}" not found.`);
  }
  if (otherId && !list.some((r) => r.id === otherId)) {
    return buildActionDenied('FORBIDDEN', `Compared ${recordType} "${otherId}" not found.`);
  }

  const changedRecords = new Map<string, AnyRecord>();
  const targets = otherId ? [otherId] : [...rec.possibleMatchIds];
  for (const tid of targets) {
    if (!rec.notDuplicateOf.includes(tid)) rec.notDuplicateOf.push(tid);
    rec.possibleMatchIds = rec.possibleMatchIds.filter((id) => id !== tid);
    const other = list.find((r) => r.id === tid);
    if (other) {
      if (!other.notDuplicateOf.includes(recordId)) other.notDuplicateOf.push(recordId);
      other.possibleMatchIds = other.possibleMatchIds.filter((id) => id !== recordId);
      if (other.possibleMatchIds.length === 0) other.duplicateStatusId = dupNone;
      changedRecords.set(other.id, other);
    }
  }
  if (rec.possibleMatchIds.length === 0) rec.duplicateStatusId = dupNone;
  changedRecords.set(rec.id, rec);

  await runWithAuditStagingScope(() =>
    partyRepo.withTenantTransaction(dupCtx, async () => {
      for (const updated of changedRecords.values()) {
        if (recordType === 'person') {
          await partyRepo.putPerson(dupCtx, updated as Person);
        } else {
          await partyRepo.putOrganisation(dupCtx, updated as Organisation);
        }
      }
      writeAudit(store, {
        recordType,
        recordId,
        action: 'duplicate',
        field: 'Duplicate status',
        oldValue: 'Possible match',
        newValue: 'Dismissed (Not a duplicate)',
        byId,
      });
      await flushStagedAuditEntries(dupCtx);
    }),
  );
  return { ok: true };
}

function mergeCollidingLinkIntoSurvivor(
  survivorLink: PersonOrganisationLink,
  mergedLink: PersonOrganisationLink,
): void {
  const becameCurrent = Boolean(mergedLink.isCurrent && !survivorLink.isCurrent);
  if (mergedLink.isCurrent) {
    survivorLink.isCurrent = true;
  }
  if (mergedLink.isPrimaryContact) {
    survivorLink.isPrimaryContact = true;
  }
  if (mergedLink.startDate) {
    if (!survivorLink.startDate || mergedLink.startDate < survivorLink.startDate) {
      survivorLink.startDate = mergedLink.startDate;
    }
  }
  if (survivorLink.isCurrent) {
    if (becameCurrent || !mergedLink.endDate) {
      survivorLink.endDate = null;
    }
  } else if (mergedLink.endDate) {
    if (!survivorLink.endDate || mergedLink.endDate > survivorLink.endDate) {
      survivorLink.endDate = mergedLink.endDate;
    }
  }
  if (!survivorLink.jobTitle && mergedLink.jobTitle) {
    survivorLink.jobTitle = mergedLink.jobTitle;
  }
  if (!survivorLink.department && mergedLink.department) {
    survivorLink.department = mergedLink.department;
  }
  if (!survivorLink.roleWithinOrganisation && mergedLink.roleWithinOrganisation) {
    survivorLink.roleWithinOrganisation = mergedLink.roleWithinOrganisation;
  }
  if (Array.isArray(mergedLink.contactRoleIds) && mergedLink.contactRoleIds.length > 0) {
    survivorLink.contactRoleIds = Array.from(
      new Set([...(survivorLink.contactRoleIds ?? []), ...mergedLink.contactRoleIds]),
    );
  }
}

function replaceRecordIdPathSegment(href: string, mergedId: string, survivorId: string): string {
  const escaped = mergedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return href.replace(new RegExp(`(?<=^|/)${escaped}(?=$|/|\\?|#)`, 'g'), survivorId);
}

export async function executeMerge(
  recordType: RecordType,
  survivorId: string,
  mergedId: string,
  byId: string,
): Promise<MergeHistory & Partial<ActionDenied>> {
  let mergeCtx: TenantContext | null = null;
  return runWithAuditStagingScope(async () => {
  const prelimCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const [store, people, organisations, links, notes, matters, teams] = await Promise.all([
    loadTenantCatalogueStoreView(prelimCtx, { includePmsLinks: true }),
    partyRepo.listAllPeople<Person>(prelimCtx),
    partyRepo.listAllOrganisations<Organisation>(prelimCtx),
    partyRepo.listAllLinks<PersonOrganisationLink>(prelimCtx),
    partyRepo.listAllNotes<Note>(prelimCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(prelimCtx),
    getHrAndRbacRepository().listAllTeams<Team>(prelimCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'record:merge', {
      allPeople: people,
      teams,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (record:merge) to merge duplicate records.',
    ) as unknown as MergeHistory & Partial<ActionDenied>;
  }
  if (survivorId === mergedId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Cannot merge a record into itself.',
    ) as unknown as MergeHistory & Partial<ActionDenied>;
  }
  const now = new Date().toISOString();
  const list: AnyRecord[] = recordType === 'person' ? people : organisations;
  const survivor = list.find((r) => r.id === survivorId);
  const merged = list.find((r) => r.id === mergedId);
  if (!survivor || !merged) {
    return buildActionDenied(
      'FORBIDDEN',
      'Record not found for merge.',
    ) as unknown as MergeHistory & Partial<ActionDenied>;
  }
  if (isEmployeeOrLeaverRecord(survivor) || isEmployeeOrLeaverRecord(merged)) {
    return buildActionDenied(
      'FORBIDDEN',
      'Employee and leaver records cannot be merged.',
    ) as unknown as MergeHistory & Partial<ActionDenied>;
  }
  if (survivor.mergedIntoId || merged.mergedIntoId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Cannot merge a record that has already been merged.',
    ) as unknown as MergeHistory & Partial<ActionDenied>;
  }

  // R271 & R272: Resolve verified tenant context before mutating any record
  mergeCtx = (await resolveTenantContextForStoreUser(store, actor!.id)).ctx;
  const plan = planMerge(survivor, merged);
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const dupMerged = valueBySystemKey(store.values, 'duplicate_status', 'merged')!.id;
  const statusMerged = valueBySystemKey(
    store.values,
    recordType === 'person' ? 'person_record_status' : 'organisation_record_status',
    'merged',
  )!.id;

  // 1. Repoint person-organisation links and merge collisions onto the survivor's link (R273)
  let linksMoved = 0;
  const nextLinks: PersonOrganisationLink[] = [];
  const linksToUpsert: PersonOrganisationLink[] = [];
  const linkIdsToDelete: string[] = [];
  for (const link of links) {
    if (recordType === 'person' && link.personId === merged.id) {
      const existingSurvivorLink =
        nextLinks.find(
          (l) =>
            l.personId === survivor.id &&
            l.organisationId === link.organisationId,
        ) ??
        links.find(
          (l) =>
            l !== link &&
            l.personId === survivor.id &&
            l.organisationId === link.organisationId,
        );
      if (existingSurvivorLink) {
        mergeCollidingLinkIntoSurvivor(existingSurvivorLink, link);
        if (!linksToUpsert.includes(existingSurvivorLink)) {
          linksToUpsert.push(existingSurvivorLink);
        }
        linkIdsToDelete.push(link.id);
        linksMoved++;
      } else {
        link.personId = survivor.id;
        nextLinks.push(link);
        linksToUpsert.push(link);
        linksMoved++;
      }
    } else if (
      recordType === 'organisation' &&
      link.organisationId === merged.id
    ) {
      const existingSurvivorLink =
        nextLinks.find(
          (l) =>
            l.organisationId === survivor.id &&
            l.personId === link.personId,
        ) ??
        links.find(
          (l) =>
            l !== link &&
            l.organisationId === survivor.id &&
            l.personId === link.personId,
        );
      if (existingSurvivorLink) {
        mergeCollidingLinkIntoSurvivor(existingSurvivorLink, link);
        if (!linksToUpsert.includes(existingSurvivorLink)) {
          linksToUpsert.push(existingSurvivorLink);
        }
        linkIdsToDelete.push(link.id);
        linksMoved++;
      } else {
        link.organisationId = survivor.id;
        nextLinks.push(link);
        linksToUpsert.push(link);
        linksMoved++;
      }
    } else {
      nextLinks.push(link);
    }
  }
  if (linksMoved > 0 && !plan.fieldsTaken.includes('Organisation links')) {
    plan.fieldsTaken.push('Organisation links');
  }

  // 2. Repoint subsidiary parent links if merging an organisation (relationshipPartnerId is never changed)
  const repointedSubsidiaries: Organisation[] = [];
  if (recordType === 'organisation') {
    for (const org of organisations) {
      if (org.parentOrganisationId === merged.id && org.id !== survivor.id) {
        org.parentOrganisationId = survivor.id;
        repointedSubsidiaries.push(org);
      }
    }
  }

  // 3. Repoint Matter references and conflict check records
  const repointedMatters: Matter[] = [];
  const repointConflictRecordObject = (
    cr:
      | {
          parties?: { linkedRecordId: string | null }[];
          matches?: { matchedRecordId: string }[];
        }
      | null
      | undefined,
  ): boolean => {
    if (!cr || typeof cr !== 'object') return false;
    let changed = false;
    if (Array.isArray(cr.parties)) {
      for (const cp of cr.parties) {
        if (cp && cp.linkedRecordId === merged.id) {
          cp.linkedRecordId = survivor.id;
          changed = true;
        }
      }
    }
    if (Array.isArray(cr.matches)) {
      for (const match of cr.matches) {
        if (match && match.matchedRecordId === merged.id) {
          match.matchedRecordId = survivor.id;
          changed = true;
        }
      }
    }
    return changed;
  };

  for (const matter of matters) {
    let matterChanged = false;
    if (matter.clientId === merged.id) {
      matter.clientId = survivor.id;
      matterChanged = true;
    }
    if (
      Array.isArray(matter.additionalClientIds) &&
      matter.additionalClientIds.includes(merged.id)
    ) {
      matter.additionalClientIds = Array.from(
        new Set(
          matter.additionalClientIds.map((id) =>
            id === merged.id ? survivor.id : id,
          ),
        ),
      );
      matterChanged = true;
    }
    if (matter.instructingContactId === merged.id) {
      matter.instructingContactId = survivor.id;
      matterChanged = true;
    }
    if (matter.billingContactId === merged.id) {
      matter.billingContactId = survivor.id;
      matterChanged = true;
    }
    if (matter.referrerContactId === merged.id) {
      matter.referrerContactId = survivor.id;
      matterChanged = true;
    }
    for (const party of matter.parties ?? []) {
      if (party.linkedRecordId === merged.id) {
        party.linkedRecordId = survivor.id;
        matterChanged = true;
      }
    }
    if (repointConflictRecordObject(matter.conflictCheckRecord)) {
      matterChanged = true;
    }
    if (matter.fieldValues && typeof matter.fieldValues === 'object') {
      if (
        repointConflictRecordObject(
          matter.fieldValues['conflictCheckRecord'] as {
            parties?: { linkedRecordId: string | null }[];
            matches?: { matchedRecordId: string }[];
          },
        )
      ) {
        matterChanged = true;
      }
      if (
        repointConflictRecordObject(
          matter.fieldValues['conflictCheck'] as {
            parties?: { linkedRecordId: string | null }[];
            matches?: { matchedRecordId: string }[];
          },
        )
      ) {
        matterChanged = true;
      }
    }
    if (matterChanged) {
      repointedMatters.push(matter);
    }
  }

    // 4-6. Enquiries (including conflict_snapshot_json), quotes, tasks (task_linked_records),
    // notifications, and recently_viewed are repointed atomically inside partyRepo.executeMergeInTransaction.

    // 7. Repoint PMS links (repointed in SQL by partyRepo.executeMergeInTransaction; record conflicts in plan & audit)
    const pmsLinkConflicts: NonNullable<MergeHistory['pmsLinkConflicts']> = [];
    const nextPmsLinks: PmsLink[] = [];
    for (const pmsLink of store.pmsLinks) {
      if (pmsLink.onesquaredId === merged.id) {
        const existingSurvivorPmsLink =
          store.pmsLinks.find(
            (other) =>
              other !== pmsLink &&
              other.entityType === pmsLink.entityType &&
              other.onesquaredId === survivor.id,
          ) ??
          nextPmsLinks.find(
            (other) =>
              other.entityType === pmsLink.entityType &&
              other.onesquaredId === survivor.id,
          );
        if (existingSurvivorPmsLink) {
          pmsLinkConflicts.push({
            keptPmsCode: existingSurvivorPmsLink.pmsCode,
            discardedPmsCode: pmsLink.pmsCode,
          });
          const conflictSummary = `PMS link conflict (kept ${existingSurvivorPmsLink.pmsCode}, discarded ${pmsLink.pmsCode})`;
          if (!plan.fieldsTaken.includes(conflictSummary)) {
            plan.fieldsTaken.push(conflictSummary);
          }
          writeAudit(store, {
            recordType,
            recordId: survivor.id,
            action: 'merge',
            field: 'PMS link conflict',
            oldValue: pmsLink.pmsCode,
            newValue: existingSurvivorPmsLink.pmsCode,
            byId,
            at: now,
          });
        } else {
          pmsLink.onesquaredId = survivor.id;
          nextPmsLinks.push(pmsLink);
          if (!plan.fieldsTaken.includes('PMS link')) {
            plan.fieldsTaken.push('PMS link');
          }
        }
      } else {
        nextPmsLinks.push(pmsLink);
      }
    }

    // 9. Copy notes to survivor
    const notesToRepoint: Note[] = [];
    for (const note of notes) {
      if (note.recordType === recordType && note.recordId === merged.id) {
        note.recordId = survivor.id;
        note.mergedFromId = merged.id;
        notesToRepoint.push(note);
      }
    }
    if (notesToRepoint.length > 0 && !plan.fieldsTaken.includes('Notes')) {
      plan.fieldsTaken.push('Notes');
    }

    // 10. Other references: Person.createdFromEnquiryId (notifications and recentlyViewed are repointed in partyRepo.executeMergeInTransaction)
    if (recordType === 'person') {
      const mergedPerson = merged as Person;
      const survivorPerson = plan.survivor as Person;
      if (mergedPerson.createdFromEnquiryId) {
        if (!survivorPerson.createdFromEnquiryId) {
          survivorPerson.createdFromEnquiryId = mergedPerson.createdFromEnquiryId;
        }
        mergedPerson.createdFromEnquiryId = null;
      }
    }

    // Update survivor
    plan.survivor.updatedAt = now;
    plan.survivor.updatedById = byId;
    plan.survivor.possibleMatchIds = plan.survivor.possibleMatchIds.filter(
      (id) => id !== merged.id,
    );
    if (plan.survivor.possibleMatchIds.length === 0) {
      plan.survivor.duplicateStatusId = dupNone;
    }

    // Mark merged record
    merged.mergedIntoId = survivor.id;
    merged.recordStatusId = statusMerged;
    merged.duplicateStatusId = dupMerged;
    merged.possibleMatchIds = [];
    merged.updatedAt = now;
    merged.updatedById = byId;

    const activeMergeCtx = mergeCtx ?? prelimCtx;
    let history!: MergeHistory;
    let mergeSqlApplied = false;
    try {
      await partyRepo.withTenantTransaction(activeMergeCtx, async () => {
        // 8. Repoint generated documents and links in the same PostgreSQL transaction (R474)
        const repoDocsUpdated = await repointMergedEntityForTenant(
          activeMergeCtx,
          recordType,
          merged.id,
          survivor.id,
        );
        if (repoDocsUpdated > 0 && !plan.fieldsTaken.includes('Generated documents')) {
          plan.fieldsTaken.push('Generated documents');
        }

        const mergeHistoryId = await partyRepo.allocateNextMergeHistoryId(activeMergeCtx);
        history = {
          id: mergeHistoryId,
          recordType,
          survivorId: survivor.id,
          mergedId: merged.id,
          mergedLabel: recordDisplayName(merged),
          byId,
          at: now,
          fieldsTaken: plan.fieldsTaken,
          ...(pmsLinkConflicts.length > 0 ? { pmsLinkConflicts } : {}),
        };

        await partyRepo.executeMergeInTransaction(activeMergeCtx, {
          recordType,
          survivor: plan.survivor,
          merged,
          linksToUpsert,
          linkIdsToDelete,
          repointedSubsidiaries,
          notesToRepoint,
          mergeHistory: history,
        });
        mergeSqlApplied = true;
        for (const m of repointedMatters) {
          await putMatterWithInTxRestrictions(activeMergeCtx, m, {
            expectedRowVersion: null,
          });
        }
        writeAudit(store, {
          recordType,
          recordId: survivor.id,
          action: 'merge',
          field: `Merged ${merged.id} (${recordDisplayName(merged)}) into ${survivor.id}`,
          oldValue: merged.id,
          newValue: plan.fieldsTaken.length
            ? `Fields taken: ${plan.fieldsTaken.join(', ')}`
            : 'No additional fields needed',
          byId,
          at: now,
        });

        writeAudit(store, {
          recordType,
          recordId: merged.id,
          action: 'merged-into',
          field: 'Merged into surviving record',
          oldValue: merged.id,
          newValue: survivor.id,
          byId,
          at: now,
        });

        await flushStagedAuditEntries(activeMergeCtx);
      });
    } catch (mergeErr) {
      if (mergeSqlApplied) {
        const session = getActiveActorSession();
        const tenantId =
          session?.tenantId ?? getActiveTenantConfiguration().tenantId;
        const correlationId = resolveRequestCorrelationId(
          (
            session?.verifiedSession as
              | { correlationId?: string }
              | undefined
          )?.correlationId,
          'corr-merge-rollback',
        );
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'merge.rollback_save_failed',
            correlationId,
            tenantId,
          }),
        );
      }
      throw mergeErr;
    }

    return history;
  });
}

export async function findCandidateDuplicatesForRecord(
  record: AnyRecord,
  options?: {
    people?: readonly Person[];
    organisations?: readonly Organisation[];
    ctx?: TenantContext;
  },
): Promise<AnyRecord[]> {
  // Same rules as the People / Organisation forms: a shared address alone isn't a duplicate.
  const notAddressOnly = (reasons: string[]) =>
    reasons.some((r) => r !== 'address' && r !== 'postcode');
  if (record.recordType === 'person') {
    const people =
      options?.people ??
      (await getPartyRepository().listAllPeople<Person>(
        options?.ctx ?? resolveDefaultServiceTenantContext(null),
      ));
    const matches = findPersonDuplicates(
      {
        id: record.id,
        firstName: record.firstName,
        preferredName: record.preferredName,
        surname: record.surname,
        emails: record.emails.map((e) => e.address),
        phones: record.phones.map((p) => p.number),
        addresses: record.addresses,
      },
      people as Person[],
      record.notDuplicateOf,
      { fuzzy: true },
    );
    return matches.filter((m) => notAddressOnly(m.reasons)).map((m) => m.record);
  }
  const organisations =
    options?.organisations ??
    (await getPartyRepository().listAllOrganisations<Organisation>(
      options?.ctx ?? resolveDefaultServiceTenantContext(null),
    ));
  const matches = findOrganisationDuplicates(
    {
      id: record.id,
      legalName: record.legalName,
      otherNames: record.otherNames.map((n) => n.name),
      companyNumber: record.companyNumber,
      emails: record.generalEmail ? [record.generalEmail] : [],
      phones: record.mainPhone ? [record.mainPhone] : [],
      addresses: [record.registeredAddress, record.correspondenceAddress].filter(
        (a): a is Address => Boolean(a),
      ),
    },
    organisations as Organisation[],
    record.notDuplicateOf,
    { fuzzy: true },
  );
  return matches.filter((m) => notAddressOnly(m.reasons)).map((m) => m.record);
}

// ------------------------------------------------------------------ Admin: Choice lists
export async function addChoiceValue(
  input: {
    listKey: string;
    label: string;
    description?: string;
    guidance?: string;
    parentId?: string | null;
    meta?: Record<string, string>;
  },
  byId: string,
): Promise<ChoiceValue> {
  const label = input.label.trim();
  if (!label) throw new Error('Label is required');
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let val!: ChoiceValue;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      let id = vid(
        input.listKey,
        (input.parentId ? slug(input.parentId) + '_' : '') + label,
      );
      let suffix = 2;
      while (store.values.some((v) => v.id === id)) {
        id = `${vid(input.listKey, label)}_${suffix++}`;
      }
      val = {
        id,
        listKey: input.listKey,
        label,
        description: input.description?.trim() || undefined,
        guidance: input.guidance?.trim() || undefined,
        parentId: input.parentId ?? null,
        sortOrder: nextSortOrder(store.values, input.listKey),
        active: true,
        meta:
          input.meta && Object.keys(input.meta).length > 0
            ? input.meta
            : undefined,
      };
      await catalogueRepo.putChoiceValue(ctx, val);
      if (input.listKey === 'employee_role' && store.homePagesConfig) {
        const nextValues = [...store.values, val];
        const nextHomePages: HomePagesConfig = {
          ...store.homePagesConfig,
          roles: syncHomeRolesWithEmployeeRoles(
            store.homePagesConfig.roles,
            nextValues,
            createDefaultRoleConfigs(
              getActiveTenantConfiguration().branding.primaryDomain,
            ),
          ),
        };
        await catalogueRepo.putHomePagesConfig(ctx, nextHomePages, byId);
      }
      writeAudit(null, {
        recordType: 'list',
        recordId: input.listKey,
        action: 'list-change',
        field: `Added value to ${input.listKey}`,
        oldValue: null,
        newValue: val.label,
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return val;
}

export async function updateChoiceValue(
  id: string,
  patch: {
    label?: string;
    description?: string;
    guidance?: string;
    active?: boolean;
    meta?: Record<string, string>;
  },
  byId: string,
): Promise<{ value?: ChoiceValue; error?: string } & Partial<ActionDenied>> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { value?: ChoiceValue; error?: string } & Partial<ActionDenied>;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const val = store.values.find((v) => v.id === id);
      if (!val) {
        result = {
          ...buildActionDenied('FORBIDDEN', 'Value not found'),
          error: 'Value not found',
        };
        return;
      }

      if (patch.active === false && val.active) {
        const check = canDeactivate(val);
        if (!check.ok) {
          result = { error: check.reason };
          return;
        }
      }

      const beforeLabel = val.label;
      const beforeActive = val.active;
      if (patch.label !== undefined && patch.label.trim()) val.label = patch.label.trim();
      if (patch.description !== undefined) val.description = patch.description.trim() || undefined;
      if (patch.guidance !== undefined) val.guidance = patch.guidance.trim() || undefined;
      if (patch.active !== undefined) val.active = patch.active;
      if (patch.meta !== undefined) {
        val.meta = { ...(val.meta ?? {}), ...patch.meta };
      }
      await catalogueRepo.putChoiceValue(ctx, val);
      if (val.listKey === 'employee_role' && store.homePagesConfig) {
        const nextHomePages: HomePagesConfig = {
          ...store.homePagesConfig,
          roles: syncHomeRolesWithEmployeeRoles(
            store.homePagesConfig.roles,
            store.values,
            createDefaultRoleConfigs(
              getActiveTenantConfiguration().branding.primaryDomain,
            ),
          ),
        };
        await catalogueRepo.putHomePagesConfig(ctx, nextHomePages, byId);
      }

      writeAudit(null, {
        recordType: 'list',
        recordId: val.listKey,
        action: 'list-change',
        field: val.id,
        oldValue: `${beforeLabel}${beforeActive ? '' : ' (inactive)'}`,
        newValue: `${val.label}${val.active ? '' : ' (inactive)'}`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { value: val };
    }),
  );
  return result;
}

export async function reorderChoiceValue(
  id: string,
  direction: -1 | 1,
  byId: string,
): Promise<{ ok: true } | ActionDenied> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result: { ok: true } | ActionDenied = { ok: true };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const target = store.values.find((v) => v.id === id);
      if (!target) {
        result = buildActionDenied('FORBIDDEN', `Choice value "${id}" not found.`);
        return;
      }
      const changed = reorder(store.values, id, direction);
      if (!changed.length) return;
      await catalogueRepo.putChoiceValues(ctx, changed);
      writeAudit(null, {
        recordType: 'list',
        recordId: target.listKey,
        action: 'list-change',
        field: `Re-ordered ${target.label}`,
        oldValue: null,
        newValue: direction === -1 ? 'Moved up' : 'Moved down',
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return result;
}

export async function createMatterStageGroup(
  input: {
    label: string;
    description?: string;
    mode: 'from_default' | 'scratch';
    selectedDefaultStageIds?: string[];
  },
  byId: string,
): Promise<ChoiceValue> {
  const label = input.label.trim();
  if (!label) throw new Error('Group name is required');
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let groupVal!: ChoiceValue;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const toUpsert: ChoiceValue[] = [];

      // Ensure Default Group exists in store.values
      const defaultGroupId = 'matter_stage_group.default_group';
      if (!store.values.some((v) => v.id === defaultGroupId)) {
        const defGroup: ChoiceValue = {
          id: defaultGroupId,
          listKey: 'matter_stage_group',
          label: 'Default Group',
          description: 'Standard firm-wide matter stage and milestone framework',
          sortOrder: 1,
          active: true,
          parentId: null,
          systemKey: 'default_group',
        };
        store.values.push(defGroup);
        toUpsert.push(defGroup);
      }
      for (const v of store.values) {
        if (v.listKey === 'matter_stage' && !v.parentId && !v.meta?.stageGroupId) {
          v.meta = { ...(v.meta ?? {}), stageGroupId: defaultGroupId };
          toUpsert.push(v);
        }
      }

      let groupId = vid('matter_stage_group', label);
      let suffix = 2;
      while (store.values.some((v) => v.id === groupId)) {
        groupId = `${vid('matter_stage_group', label)}_${suffix++}`;
      }

      groupVal = {
        id: groupId,
        listKey: 'matter_stage_group',
        label,
        description: input.description?.trim() || undefined,
        parentId: null,
        sortOrder: nextSortOrder(store.values, 'matter_stage_group'),
        active: true,
      };
      store.values.push(groupVal);
      toUpsert.push(groupVal);

      if (input.mode === 'from_default' && input.selectedDefaultStageIds?.length) {
        const selectedSet = new Set(input.selectedDefaultStageIds);
        const defaultStages = store.values
          .filter(
            (v) =>
              v.listKey === 'matter_stage' &&
              !v.parentId &&
              (v.meta?.stageGroupId ?? defaultGroupId) === defaultGroupId &&
              selectedSet.has(v.id),
          )
          .sort((a, b) => a.sortOrder - b.sortOrder);

        defaultStages.forEach((srcStage, sIdx) => {
          let newStageId = vid('matter_stage', `${slug(label)}_${srcStage.label}`);
          let stgSuffix = 2;
          while (store.values.some((v) => v.id === newStageId)) {
            newStageId = `${vid('matter_stage', `${slug(label)}_${srcStage.label}`)}_${stgSuffix++}`;
          }

          const clonedStage: ChoiceValue = {
            id: newStageId,
            listKey: 'matter_stage',
            label: srcStage.label,
            description: srcStage.description,
            guidance: srcStage.guidance,
            parentId: null,
            sortOrder: sIdx + 1,
            active: true,
            meta: { ...(srcStage.meta ?? {}), stageGroupId: groupId },
          };
          store.values.push(clonedStage);
          toUpsert.push(clonedStage);

          const srcMilestones = store.values
            .filter((v) => v.listKey === 'matter_stage' && v.parentId === srcStage.id)
            .sort((a, b) => a.sortOrder - b.sortOrder);

          srcMilestones.forEach((srcMs, mIdx) => {
            let newMsId = vid('matter_stage', `${slug(newStageId)}_${srcMs.label}`);
            let msSuffix = 2;
            while (store.values.some((v) => v.id === newMsId)) {
              newMsId = `${vid('matter_stage', `${slug(newStageId)}_${srcMs.label}`)}_${msSuffix++}`;
            }
            const clonedMs: ChoiceValue = {
              id: newMsId,
              listKey: 'matter_stage',
              label: srcMs.label,
              description: srcMs.description,
              guidance: srcMs.guidance,
              parentId: newStageId,
              sortOrder: mIdx + 1,
              active: true,
              meta: srcMs.meta ? { ...srcMs.meta } : undefined,
            };
            store.values.push(clonedMs);
            toUpsert.push(clonedMs);
          });
        });
      }

      await catalogueRepo.putChoiceValues(ctx, toUpsert);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_stage',
        action: 'list-change',
        field: 'Created matter stage group',
        oldValue: null,
        newValue: `${groupVal.label} (${input.mode === 'from_default' ? 'copied from Default Group' : 'from scratch'})`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return groupVal;
}

// ------------------------------------------------------------------ Admin: Custom fields
export async function saveCustomFieldDefinition(
  input: {
    id?: string;
    recordType: CustomFieldRecordType;
    label: string;
    fieldType: CustomFieldType;
    section: FormSection;
    required: boolean;
    active?: boolean;
    options?: string[];
  },
  byId: string,
): Promise<CustomFieldDefinition & Partial<ActionDenied>> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: CustomFieldDefinition & Partial<ActionDenied>;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const existing = input.id
        ? store.customFields.find((d) => d.id === input.id) ?? null
        : null;
      if (input.id && !existing) {
        result = buildActionDenied(
          'FORBIDDEN',
          `Custom field "${input.id}" not found.`,
        ) as unknown as CustomFieldDefinition & Partial<ActionDenied>;
        return;
      }
      const id =
        existing?.id ??
        `cf_${slug(input.label)}_${Date.now().toString(36).slice(-4)}`;

      let optionsListKey = existing?.optionsListKey;
      if (input.fieldType === 'choice') {
        optionsListKey = optionsListKey ?? id;
        if (!store.lists.some((l) => l.key === optionsListKey)) {
          const list: ChoiceList = {
            key: optionsListKey,
            label: input.label.trim(),
            group: 'custom',
            appliesTo: [input.recordType],
            allowMultiple: false,
            hierarchical: false,
          };
          await catalogueRepo.putChoiceList(ctx, list);
        }
        if (input.options?.length) {
          const existingVals = store.values.filter(
            (v) => v.listKey === optionsListKey,
          );
          const newVals: ChoiceValue[] = [];
          input.options
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((optLabel, idx) => {
              if (
                !existingVals.some(
                  (ev) => ev.label.toLowerCase() === optLabel.toLowerCase(),
                )
              ) {
                newVals.push({
                  id: vid(optionsListKey!, optLabel),
                  listKey: optionsListKey!,
                  label: optLabel,
                  sortOrder: existingVals.length + idx + 1,
                  active: true,
                  parentId: null,
                });
              }
            });
          if (newVals.length > 0) {
            await catalogueRepo.putChoiceValues(ctx, newVals);
          }
        }
      }

      const sameType = store.customFields.filter(
        (d) => d.recordType === input.recordType,
      );
      const maxOrder = sameType.length
        ? Math.max(...sameType.map((d) => d.sortOrder))
        : 0;

      const def: CustomFieldDefinition = {
        id,
        recordType: input.recordType,
        label: input.label.trim(),
        fieldType: input.fieldType,
        optionsListKey,
        section: input.section,
        required: input.required,
        sortOrder: existing?.sortOrder ?? maxOrder + 1,
        active: input.active ?? existing?.active ?? true,
      };

      await catalogueRepo.putCustomFieldDefinition(ctx, def, {
        source: 'admin',
      });

      writeAudit(null, {
        recordType: 'customField',
        recordId: def.id,
        action: 'custom-field-change' as AuditAction,
        field: `${def.recordType} · ${def.label}`,
        oldValue: existing
          ? `${existing.label} (${existing.active ? 'active' : 'inactive'})`
          : null,
        newValue: `${def.label} (${def.fieldType}, ${def.active ? 'active' : 'inactive'})`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = def;
    }),
  );
  return result;
}

export async function reorderCustomField(
  id: string,
  direction: -1 | 1,
  byId: string,
): Promise<{ ok: true } | ActionDenied> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result: { ok: true } | ActionDenied = { ok: true };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const target = store.customFields.find((d) => d.id === id);
      if (!target) {
        result = buildActionDenied('FORBIDDEN', `Custom field "${id}" not found.`);
        return;
      }
      const siblings = store.customFields
        .filter((d) => d.recordType === target.recordType)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = siblings.findIndex((d) => d.id === id);
      const swapIdx = idx + direction;
      if (swapIdx < 0 || swapIdx >= siblings.length) return;
      [siblings[idx], siblings[swapIdx]] = [siblings[swapIdx], siblings[idx]];
      siblings.forEach((d, i) => {
        d.sortOrder = i + 1;
      });
      await catalogueRepo.putCustomFieldDefinitions(ctx, siblings);
      writeAudit(null, {
        recordType: 'customField',
        recordId: target.id,
        action: 'custom-field-change',
        field: `Re-ordered ${target.label}`,
        oldValue: null,
        newValue: direction === -1 ? 'Moved up' : 'Moved down',
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return result;
}

export async function resetAllDemoData(
  byId: string,
  ctx: TenantContext,
): Promise<void> {
    const [prevProfile, prevPeople] = await Promise.all([
      getCatalogueRepository().getFirmProfile(ctx),
      getPartyRepository().listAllPeople<Person>(ctx),
    ]);
    const actor = prevPeople.find((p) => p.id === byId) ?? null;
    const actorName = actor ? personDisplayName(actor) : byId;
    const prevSeededEntraByIdAndEmail = new Map<string, string | null | undefined>();
    if (
      !prevProfile?.isCleanDeployment &&
      getActiveTenantConfiguration().environment !== 'test'
    ) {
      for (const p of prevPeople) {
        const email = primaryEmail(p).trim().toLowerCase();
        if (email) {
          prevSeededEntraByIdAndEmail.set(`${p.id}::${email}`, p.entraObjectId);
        }
      }
    }
    const fresh = resetStore();
    if (prevSeededEntraByIdAndEmail.size > 0) {
      for (const p of fresh.people) {
        const email = primaryEmail(p).trim().toLowerCase();
        const key = `${p.id}::${email}`;
        if (email && prevSeededEntraByIdAndEmail.has(key)) {
          const prevOid = prevSeededEntraByIdAndEmail.get(key);
          if (prevOid === undefined) {
            delete p.entraObjectId;
          } else {
            p.entraObjectId = prevOid;
          }
        }
      }
    }
    await importFirmStoreModulesToPostgres({ ctx, store: fresh, clearFirst: true });
    await appendTenantAuditEntries(ctx, [
      {
        recordType: 'system',
        recordId: 'demo-data',
        action: 'data-reset',
        field: 'Reset demo data',
        oldValue: null,
        newValue: `Restored initial ${fresh.firm.name} dataset (by ${actorName} [${byId}])`,
        byId,
        at: new Date().toISOString(),
      },
    ]);
}

export async function clearAllDataToCleanDeployment(
  byId: string,
  ctx: TenantContext,
): Promise<void> {
    const actor = await getPartyRepository().getPersonById<Person>(ctx, byId);
    const actorName = actor ? personDisplayName(actor) : byId;
    const clean = clearStoreToCleanDeployment();
    await clearMigratedPostgresModulesForTenant({ ctx });
    await importFirmStoreModulesToPostgres({
      ctx,
      store: clean,
      modules: ['catalogues'],
      clearFirst: false,
    });
    await appendTenantAuditEntries(ctx, [
      {
        recordType: 'system',
        recordId: 'clean-deployment',
        action: 'data-cleared',
        field: 'Clear all data to clean deployment',
        oldValue: null,
        newValue: `Cleared store to clean deployment (by ${actorName} [${byId}])`,
        byId,
        at: new Date().toISOString(),
      },
    ]);
}

// ------------------------------------------------------------------ Notifications
async function pushNotification(
  ctx: TenantContext,
  input: {
    recipientId: string;
    kind: NotificationKind;
    title: string;
    detail: string;
    href: string;
    recordId: string;
    byId: string;
    at?: string;
  },
): Promise<NotificationItem | null> {
  // Don't notify someone about an action they took themselves unless it's an overdue alert
  if (input.recipientId === input.byId && input.kind !== 'task_overdue') return null;
  const taskRepo = getTaskWorkflowRepository();
  const id = await taskRepo.allocateNextNotificationId(ctx);
  const item: NotificationItem = {
    id,
    recipientId: input.recipientId,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    href: input.href,
    recordId: input.recordId,
    createdAt: input.at ?? new Date().toISOString(),
    read: false,
    byId: input.byId,
  };
  await taskRepo.putNotification(ctx, item);
  return item;
}

export async function markNotificationRead(id: string, userId: string): Promise<void> {
  const ctx = resolveDefaultServiceTenantContext(null, userId);
  await getTaskWorkflowRepository().markNotificationRead(ctx, id, userId);
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const ctx = resolveDefaultServiceTenantContext(null, userId);
  await getTaskWorkflowRepository().markAllNotificationsRead(ctx, userId);
}

// ------------------------------------------------------------------ Admin: Teams & Settings
export async function saveTeamRecord(
  input: {
    id?: string;
    name: string;
    description?: string;
    memberIds: string[];
    leadIds: string[];
    practiceAreaIds: string[];
    active?: boolean;
  },
  byId: string,
): Promise<{ team?: Team; error?: string } & Partial<ActionDenied>> {
  const now = new Date().toISOString();
  const name = input.name.trim();
  if (!name) return { error: 'Team name is required.' };

  const teamCtx = resolveDefaultServiceTenantContext(null, byId);
  const hrRepo = getHrAndRbacRepository();
  const existing = input.id
    ? await hrRepo.getTeamById<Team>(teamCtx, input.id)
    : null;
  if (input.id && !existing) {
    const msg = `Team "${input.id}" not found.`;
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      error: msg,
    };
  }

  // S0-04: Prevent self-escalation into team leadIds (which grants team-lead permissions such as employee:edit_core).
  const isAddingSelfAsLead =
    input.leadIds.includes(byId) && !(existing?.leadIds.includes(byId) ?? false);
  if (isAddingSelfAsLead) {
    const msg =
      'SELF_MODIFICATION_FORBIDDEN: Users cannot make themselves a team lead.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      error: msg,
    };
  }

  const memberIds = Array.from(new Set([...input.memberIds, ...input.leadIds]));
  const leadIds = input.leadIds.filter((id) => memberIds.includes(id));

  let team!: Team;
  await runWithAuditStagingScope(() =>
    hrRepo.withTenantTransaction(teamCtx, async () => {
      const allocatedTeamId = existing
        ? existing.id
        : await hrRepo.allocateNextTeamId(teamCtx);
      team = {
        id: allocatedTeamId,
        name,
        description: (input.description ?? existing?.description ?? '').trim(),
        memberIds,
        leadIds,
        practiceAreaIds: input.practiceAreaIds,
        active: input.active ?? existing?.active ?? true,
        createdById: existing?.createdById ?? byId,
        createdAt: existing?.createdAt ?? now,
        updatedById: byId,
        updatedAt: now,
      };
      await hrRepo.putTeam(teamCtx, team);
      await syncAffectedMattersRestrictionsInTx(teamCtx, {
        includeAllRestrictedMatters: true,
      });
      if (!existing) {
        writeAudit(null, {
          recordType: 'team',
          recordId: team.id,
          action: 'create',
          field: 'Team created',
          oldValue: null,
          newValue: team.name,
          byId,
          at: now,
        });
      } else {
        writeAudit(null, {
          recordType: 'team',
          recordId: team.id,
          action: 'update',
          field: 'Team updated',
          oldValue: existing.name,
          newValue: `${team.name} (${team.memberIds.length} members, ${team.active ? 'active' : 'inactive'})`,
          byId,
          at: now,
        });
      }
      await flushStagedAuditEntries(teamCtx);
    }),
  );
  return { team };
}

export async function updateEmployeeRoleSetting(
  personId: string,
  appRole: AppRole | null,
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const hrRepo = getHrAndRbacRepository();
  return partyRepo.withTenantTransaction(ctx, async () => {
    const [people, teams, rbacOverride] = await Promise.all([
      partyRepo.listAllPeople<Person>(ctx),
      hrRepo.listAllTeams<Team>(ctx),
      hrRepo.getRbacConfigOverride<RbacConfiguration>(ctx),
    ]);
    const actor = people.find((p) => p.id === byId);
    const person = people.find((p) => p.id === personId && p.isEmployee);
    if (!actor) return { ok: false, error: 'Acting user not found.' };
    if (!person) return { ok: false, error: 'Employee not found.' };

    const rbacConfig = await loadEffectiveTenantRbacConfig(ctx, rbacOverride);
    const actorPerms = resolvePersonPermissionSet(actor, {
      allPeople: people,
      teams,
      mfaVerified: options.mfaVerified ?? false,
      config: { rbac: rbacConfig },
    });

    const addedRoleKeys: string[] =
      appRole === 'admin'
        ? [
            'admin',
            'managing_partner',
            'partner',
            'fee_earner',
            'legal_secretary',
            'enquiries_coordinator',
            'finance',
            'risk_compliance',
          ]
        : appRole === 'team_lead'
          ? ['partner', 'fee_earner']
          : appRole === 'call_handler'
            ? ['enquiries_coordinator']
            : appRole === 'fee_earner'
              ? ['fee_earner']
              : [];

    try {
      validateUserOverrideOrRoleMutation({
        actorPermissions: actorPerms,
        targetPersonId: person.id,
        addedRoleKeys,
        rbacConfig,
      });
    } catch (err) {
      const code = err instanceof AuthorisationError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code,
        error: code ? `${code}: ${message}` : message,
      };
    }

    const beforeJson = JSON.stringify({ appRole: person.appRole ?? null });
    person.appRole = appRole;
    person.updatedAt = new Date().toISOString();
    person.updatedById = byId;
    const afterJson = JSON.stringify({ appRole: person.appRole ?? null });
    await partyRepo.putPerson(ctx, person);
    await syncAffectedMattersRestrictionsInTx(ctx, {
      includeAllRestrictedMatters: true,
    });
    await runWithAuditStagingScope(async () => {
      writeAudit(null, {
        recordType: 'person',
        recordId: person.id,
        action: 'update',
        field: 'App role',
        oldValue: beforeJson,
        newValue: afterJson,
        byId,
      });
      await flushStagedAuditEntries(ctx);
    });
    return { ok: true };
  });
}

export async function saveEnquirySettingsRecord(
  patch: Partial<EnquirySettings>,
  byId: string,
): Promise<EnquirySettings> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let nextSettings!: EnquirySettings;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      nextSettings = {
        ...store.enquirySettings,
        ...patch,
      };
      await catalogueRepo.putEnquirySettingsConfig(ctx, nextSettings, byId);
      writeAudit(null, {
        recordType: 'system',
        recordId: 'enquiry-settings',
        action: 'update',
        field: 'Enquiry settings',
        oldValue: null,
        newValue: `Emergency ${nextSettings.emergencyHours}h · Hours ${nextSettings.workDayStart}–${nextSettings.workDayEnd} · Attempts ${nextSettings.failedAttemptsBeforeSuggestNoResponse} · Retention ${nextSettings.retentionMonths}m`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return nextSettings;
}

export async function saveTaskSettingsRecord(
  settings: TaskSettings,
  byId: string,
): Promise<TaskSettings> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      await catalogueRepo.putTaskSettingsConfig(ctx, settings, byId);
      writeAudit(null, {
        recordType: 'system',
        recordId: 'task-settings',
        action: 'update',
        field: 'Task settings',
        oldValue: null,
        newValue: 'Updated automatic task templates and due offsets',
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return settings;
}

// ------------------------------------------------------------------ Tasks
function workingHoursConfigFromStore(store: FirmStore): WorkingHoursConfig {
  return {
    workDayStart: store.enquirySettings.workDayStart || '09:00',
    workDayEnd: store.enquirySettings.workDayEnd || '17:30',
    workingDays: store.enquirySettings.workingDays || [1, 2, 3, 4, 5],
    emergencyHours: store.enquirySettings.emergencyHours || 2,
  };
}

export async function saveTaskRecord(
  input: {
    id?: string;
    title: string;
    description?: string;
    taskTypeId?: string;
    priorityId?: string;
    dueAt: string;
    assignedTeamId?: string | null;
    assignedPersonId?: string | null;
    assignedPersonIds?: string[];
    multiAssigneeMode?: 'shared' | 'separate';
    status?: TaskStatus;
    linkedRecords?: TaskLinkedRecord[];
    autoTrigger?: AutoTaskTrigger | null;
  },
  byId: string,
  opts?: { viaTakeTask?: boolean; internalSystemStep?: boolean },
): Promise<{ task?: Task; tasks?: Task[]; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const now = new Date().toISOString();
  const taskCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const [store, people, organisations, matters, enquiries, quotes, existing, teams] = await Promise.all([
    loadTenantCatalogueStoreView(taskCtx),
    partyRepo.listAllPeople<Person>(taskCtx),
    partyRepo.listAllOrganisations<Organisation>(taskCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(taskCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(taskCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(taskCtx),
    input.id
      ? taskRepo.getTaskById<Task>(taskCtx, input.id, { includeRestricted: true })
      : Promise.resolve(null),
    getHrAndRbacRepository().listAllTeams<Team>(taskCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const prelimVis = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const hiddenKdIds = await getKeyDateRepository().listHiddenKeyDateIdsForMatters(
    taskCtx,
    prelimVis.hiddenMatterIds,
  );
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: hiddenKdIds,
  });

  if (!opts?.viaTakeTask && !opts?.internalSystemStep) {
    if (
      !hasPersonPermission(actor, 'task:edit', {
        allPeople: people,
        teams,
      })
    ) {
      const msg = 'You do not have permission (task:edit) to create or edit tasks.';
      return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
    }
  }

  if (input.id && !existing) {
    const msg = 'Task not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (existing && !visibility.canViewTask(existing)) {
    const msg = 'You do not have access to this task.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const candidateLinks = input.linkedRecords ?? existing?.linkedRecords ?? [];
  for (const lr of candidateLinks) {
    if (lr.recordType === 'matter') {
      const m = matters.find((x) => x.id === lr.recordId);
      if (!m || !visibility.canViewMatter(m)) {
        const msg = 'Linked matter not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'enquiry') {
      const e = enquiries.find((x) => x.id === lr.recordId);
      if (!e || !visibility.canViewEnquiry(e)) {
        const msg = 'Linked enquiry not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'quote') {
      const q = quotes.find((x) => x.id === lr.recordId);
      if (!q || !visibility.canViewQuote(q)) {
        const msg = 'Linked quote not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'person') {
      if (!people.some((x) => x.id === lr.recordId)) {
        const msg = 'Linked person not found.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'organisation') {
      if (!organisations.some((x) => x.id === lr.recordId)) {
        const msg = 'Linked organisation not found.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    }
  }

  const title = input.title?.trim();
  if (!title) return { error: 'Task title is required.' };
  if (!input.dueAt) return { error: 'Due date is required.' };

  const cleanPersonIds = Array.from(
    new Set(
      (input.assignedPersonIds && input.assignedPersonIds.length > 0
        ? input.assignedPersonIds
        : input.assignedPersonId
          ? [input.assignedPersonId]
          : []
      ).filter(Boolean),
    ),
  );

  if (!input.assignedTeamId && cleanPersonIds.length === 0) {
    return { error: 'Task must be assigned to a team, a person, or both.' };
  }

  if (existing && !opts?.viaTakeTask && !opts?.internalSystemStep) {
    const nextTeamId =
      input.assignedTeamId !== undefined ? input.assignedTeamId : existing.assignedTeamId;
    const nextPersonId =
      cleanPersonIds[0] ??
      (input.assignedPersonId !== undefined ? input.assignedPersonId : existing.assignedPersonId);
    const nextPersonIds =
      cleanPersonIds.length > 0
        ? cleanPersonIds
        : input.assignedPersonIds !== undefined
          ? input.assignedPersonIds
          : input.assignedPersonId !== undefined
            ? input.assignedPersonId
              ? [input.assignedPersonId]
              : []
            : existing.assignedPersonIds ?? (existing.assignedPersonId ? [existing.assignedPersonId] : []);
    const existingPersonIds =
      existing.assignedPersonIds ?? (existing.assignedPersonId ? [existing.assignedPersonId] : []);
    const personIdsChanged =
      nextPersonIds.length !== existingPersonIds.length ||
      nextPersonIds.some((id, i) => id !== existingPersonIds[i]);
    const assignmentChanged =
      nextTeamId !== existing.assignedTeamId ||
      nextPersonId !== existing.assignedPersonId ||
      personIdsChanged;

    if (assignmentChanged) {
      const isSelfClaim =
        !existing.assignedPersonId &&
        nextTeamId === existing.assignedTeamId &&
        nextPersonIds.length === 1 &&
        nextPersonIds[0] === byId &&
        canUserTakeTask(byId, existing, teams, people, store.values);
      if (
        !isSelfClaim &&
        !canUserReassignTask(byId, existing, teams, people, store.values)
      ) {
        const msg = 'You do not have permission to reassign this task.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    }
  }

  // Separate task per assignee when creating a new task with multiAssigneeMode === 'separate'
  if (!existing && input.multiAssigneeMode === 'separate' && cleanPersonIds.length > 1) {
    const createdTasks: Task[] = [];
    await taskRepo.withTenantTransaction(taskCtx, async () => {
      for (const pid of cleanPersonIds) {
        const id = await taskRepo.allocateNextTaskId(taskCtx);
        const separateTask: Task = {
          id,
          reference: id,
          title,
          description: (input.description ?? '').trim(),
          taskTypeId: input.taskTypeId || vid('task_type', 'General'),
          priorityId: input.priorityId || vid('task_priority', 'Normal'),
          dueAt: input.dueAt,
          assignedTeamId: input.assignedTeamId ?? null,
          assignedPersonId: pid,
          assignedPersonIds: [pid],
          multiAssigneeMode: 'separate',
          status: input.status ?? 'To do',
          linkedRecords: input.linkedRecords ?? [],
          createdById: byId,
          createdAt: now,
          updatedById: byId,
          updatedAt: now,
          completedById: null,
          completedAt: null,
          comments: [],
          autoTrigger: input.autoTrigger ?? null,
        };
        await taskRepo.putTask(taskCtx, separateTask);
        createdTasks.push(separateTask);
        writeAudit(store, {
          recordType: 'task',
          recordId: separateTask.id,
          action: 'create',
          field: 'Task created',
          oldValue: null,
          newValue: `${separateTask.reference} — ${separateTask.title}`,
          byId,
          at: now,
        });
        await pushNotification(taskCtx, {
          recipientId: pid,
          kind: 'task_assigned',
          title: `Task assigned to you: ${separateTask.title}`,
          detail: `${separateTask.reference} · Due ${formatDate(separateTask.dueAt)}`,
          href: `/tasks/${separateTask.id}`,
          recordId: separateTask.id,
          byId,
          at: now,
        });
      }
      await flushStagedAuditEntries(taskCtx);
    });
    return { task: createdTasks[0], tasks: createdTasks };
  }

  const id = existing?.id ?? (await taskRepo.allocateNextTaskId(taskCtx));
  const status: TaskStatus = input.status ?? existing?.status ?? 'To do';
  const wasDone = existing?.status === 'Done';
  const isNowDone = status === 'Done';

  const effectivePersonId =
    cleanPersonIds[0] ??
    (input.assignedPersonId !== undefined ? input.assignedPersonId : existing?.assignedPersonId ?? null);
  const effectivePersonIds =
    cleanPersonIds.length > 0
      ? cleanPersonIds
      : existing?.assignedPersonIds ?? (effectivePersonId ? [effectivePersonId] : []);

  const task: Task = {
    id,
    reference: id,
    title,
    description: (input.description ?? existing?.description ?? '').trim(),
    taskTypeId: input.taskTypeId || existing?.taskTypeId || vid('task_type', 'General'),
    priorityId: input.priorityId || existing?.priorityId || vid('task_priority', 'Normal'),
    dueAt: input.dueAt,
    assignedTeamId:
      input.assignedTeamId !== undefined ? input.assignedTeamId : existing?.assignedTeamId ?? null,
    assignedPersonId: effectivePersonId,
    assignedPersonIds: effectivePersonIds,
    multiAssigneeMode: input.multiAssigneeMode ?? existing?.multiAssigneeMode ?? 'shared',
    status,
    linkedRecords: input.linkedRecords ?? existing?.linkedRecords ?? [],
    createdById: existing?.createdById ?? byId,
    createdAt: existing?.createdAt ?? now,
    updatedById: byId,
    updatedAt: now,
    completedById: isNowDone ? (wasDone ? existing?.completedById ?? byId : byId) : null,
    completedAt: isNowDone ? (wasDone ? existing?.completedAt ?? now : now) : null,
    comments: existing?.comments ?? [],
    autoTrigger: input.autoTrigger !== undefined ? input.autoTrigger : existing?.autoTrigger ?? null,
  };

  const ctx = formatContext(store, { people, organisations, matters });

  await taskRepo.withTenantTransaction(taskCtx, async () => {
    await taskRepo.putTask(taskCtx, task);
    if (!existing) {
      writeAudit(store, {
        recordType: 'task',
        recordId: task.id,
        action: 'create',
        field: 'Task created',
        oldValue: null,
        newValue: `${task.reference} — ${task.title}`,
        byId,
        at: now,
      });

      // Notify assignee(s) or team members
      if (effectivePersonIds.length > 0) {
        for (const pid of effectivePersonIds) {
          await pushNotification(taskCtx, {
            recipientId: pid,
            kind: 'task_assigned',
            title: `Task assigned to you: ${task.title}`,
            detail: `${task.reference} · Due ${formatDate(task.dueAt)}`,
            href: `/tasks/${task.id}`,
            recordId: task.id,
            byId,
            at: now,
          });
        }
      } else if (task.assignedTeamId) {
        const team = teams.find((tm) => tm.id === task.assignedTeamId);
        if (team) {
          for (const memberId of team.memberIds) {
            await pushNotification(taskCtx, {
              recipientId: memberId,
              kind: 'team_task_arrived',
              title: `New task in ${team.name} queue`,
              detail: `${task.reference} — ${task.title}`,
              href: `/tasks/${task.id}`,
              recordId: task.id,
              byId,
              at: now,
            });
          }
        }
      }
    } else {
      if (existing.status !== task.status) {
        writeAudit(store, {
          recordType: 'task',
          recordId: task.id,
          action: 'status-change',
          field: 'Status',
          oldValue: existing.status,
          newValue: task.status,
          byId,
          at: now,
        });
      }
      if (existing.dueAt !== task.dueAt) {
        writeAudit(store, {
          recordType: 'task',
          recordId: task.id,
          action: 'update',
          field: 'Due date',
          oldValue: formatDate(existing.dueAt),
          newValue: formatDate(task.dueAt),
          byId,
          at: now,
        });
      }
      if (
        existing.assignedPersonId !== task.assignedPersonId ||
        existing.assignedTeamId !== task.assignedTeamId
      ) {
        const oldLabel = [
          existing.assignedTeamId ? ctx.nameOf(existing.assignedTeamId) : '',
          existing.assignedPersonId ? ctx.nameOf(existing.assignedPersonId) : 'Unclaimed',
        ]
          .filter(Boolean)
          .join(' · ');
        const newLabel = [
          task.assignedTeamId ? ctx.nameOf(task.assignedTeamId) : '',
          task.assignedPersonId ? ctx.nameOf(task.assignedPersonId) : 'Unclaimed',
        ]
          .filter(Boolean)
          .join(' · ');
        writeAudit(store, {
          recordType: 'task',
          recordId: task.id,
          action: 'assign',
          field: 'Assigned to',
          oldValue: oldLabel,
          newValue: newLabel,
          byId,
          at: now,
        });

        if (task.assignedPersonId && task.assignedPersonId !== existing.assignedPersonId) {
          await pushNotification(taskCtx, {
            recipientId: task.assignedPersonId,
            kind: 'task_assigned',
            title: `Task assigned to you: ${task.title}`,
            detail: `${task.reference} · Due ${formatDate(task.dueAt)}`,
            href: `/tasks/${task.id}`,
            recordId: task.id,
            byId,
            at: now,
          });
        }
      }
    }

    // If this task is linked to a New enquiry and now has an assignedPersonId, sync the enquiry!
    if (
      task.assignedPersonId &&
      hasPersonPermission(actor, 'enquiry:assign', {
        allPeople: people,
        teams,
      })
    ) {
      for (const lr of task.linkedRecords) {
        if (lr.recordType === 'enquiry') {
          const enq = enquiries.find((e) => e.id === lr.recordId);
          if (
            enq &&
            visibility.canViewEnquiry(enq) &&
            isEnquiryRouted(enq) &&
            isEnquiryOpen(enq) &&
            (enq.status === 'New' || !enq.assignedToId)
          ) {
            const prevStatus = enq.status;
            const prevAssignee = enq.assignedToId;
            enq.assignedToId = task.assignedPersonId;
            if (enq.status === 'New') {
              enq.status = 'Assigned';
            }
            enq.updatedAt = now;
            enq.updatedById = byId;
            await intakeRepo.putEnquiry(taskCtx, enq);

            writeAudit(store, {
              recordType: 'enquiry',
              recordId: enq.id,
              action: 'assign',
              field: 'Assigned to',
              oldValue: prevAssignee ? ctx.nameOf(prevAssignee) : 'Unclaimed',
              newValue: `${ctx.nameOf(task.assignedPersonId)} (status: ${prevStatus} → ${enq.status})`,
              byId,
              at: now,
            });
          }
        }
      }
    }
    await flushStagedAuditEntries(taskCtx);
  });

  return { task };
  });
}

export async function takeTaskRecord(
  taskId: string,
  byId: string,
): Promise<{ task?: Task; error?: string } & Partial<ActionDenied>> {
    const taskCtx = resolveDefaultServiceTenantContext(null, byId);
    const partyRepo = getPartyRepository();
    const matterRepo = getMatterRepository();
    const intakeRepo = getIntakeQuoteRepository();
    const taskRepo = getTaskWorkflowRepository();
    const [store, people, matters, enquiries, quotes, existing, teams] = await Promise.all([
      loadTenantCatalogueStoreView(taskCtx),
      partyRepo.listAllPeople<Person>(taskCtx),
      matterRepo.listAllMattersUnfiltered<Matter>(taskCtx),
      intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(taskCtx),
      intakeRepo.listAllQuotesUnfiltered<Quote>(taskCtx),
      taskRepo.getTaskById<Task>(taskCtx, taskId, { includeRestricted: true }),
      getHrAndRbacRepository().listAllTeams<Team>(taskCtx),
    ]);
    const actor = people.find((p) => p.id === byId) ?? null;
    const prelimVis = buildRecordVisibility(store, actor, {
      people,
      matters,
      enquiries,
      quotes,
      teams,
      hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    });
    const hiddenKdIds = await getKeyDateRepository().listHiddenKeyDateIdsForMatters(
      taskCtx,
      prelimVis.hiddenMatterIds,
    );
    const visibility = buildRecordVisibility(store, actor, {
      people,
      matters,
      enquiries,
      quotes,
      teams,
      hiddenMatterKeyDateIds: hiddenKdIds,
    });
    if (!existing || !visibility.canViewTask(existing)) {
      const msg = 'Task not found.';
      return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
    }
    if (!canUserTakeTask(byId, existing, teams, people, store.values)) {
      const msg = 'You do not have permission to claim this task.';
      return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
    }
    return saveTaskRecord(
      {
        id: existing.id,
        title: existing.title,
        description: existing.description,
        taskTypeId: existing.taskTypeId,
        priorityId: existing.priorityId,
        dueAt: existing.dueAt,
        assignedTeamId: existing.assignedTeamId,
        assignedPersonId: byId,
        status: existing.status,
        linkedRecords: existing.linkedRecords,
      },
      byId,
      { viaTakeTask: true },
    );
}

export async function addTaskCommentRecord(
  taskId: string,
  text: string,
  byId: string,
): Promise<{ task?: Task; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const taskCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const [store, people, matters, enquiries, quotes, task, teams] = await Promise.all([
    loadTenantCatalogueStoreView(taskCtx),
    partyRepo.listAllPeople<Person>(taskCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(taskCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(taskCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(taskCtx),
    taskRepo.getTaskById<Task>(taskCtx, taskId, { includeRestricted: true }),
    getHrAndRbacRepository().listAllTeams<Team>(taskCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'task:comment', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (task:comment) to comment on tasks.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const prelimVis = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const hiddenKdIds = await getKeyDateRepository().listHiddenKeyDateIdsForMatters(
    taskCtx,
    prelimVis.hiddenMatterIds,
  );
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: hiddenKdIds,
  });
  if (!task || !visibility.canViewTask(task)) {
    const msg = 'Task not found or access denied.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Comment text is required.' };

  const now = new Date().toISOString();
  const commentId = `TC-${Date.now().toString(36)}`;
  task.comments.push({
    id: commentId,
    authorId: byId,
    at: now,
    text: trimmed,
  });
  task.updatedAt = now;
  task.updatedById = byId;

  await taskRepo.withTenantTransaction(taskCtx, async () => {
    await taskRepo.putTask(taskCtx, task);

    writeAudit(store, {
      recordType: 'task',
      recordId: task.id,
      action: 'comment',
      field: 'Comment added',
      oldValue: null,
      newValue: trimmed.slice(0, 120),
      byId,
      at: now,
    });

    const authorName = formatContext(store, { people, matters }).nameOf(byId);
    const recipients = new Set<string>();
    if (task.assignedPersonId) recipients.add(task.assignedPersonId);
    if (task.createdById) recipients.add(task.createdById);
    for (const rId of recipients) {
      await pushNotification(taskCtx, {
        recipientId: rId,
        kind: 'task_comment',
        title: `New comment on ${task.reference}`,
        detail: `${authorName}: "${trimmed.slice(0, 90)}"`,
        href: `/tasks/${task.id}`,
        recordId: task.id,
        byId,
        at: now,
      });
    }
    await flushStagedAuditEntries(taskCtx);
  });

  return { task };
  });
}

// ------------------------------------------------------------------ Enquiries & Automatic Tasks
async function raiseAutomaticTask(
  ctx: TenantContext,
  store: FirmStore,
  trigger: AutoTaskTrigger,
  vars: { name?: string; matterNumber?: string },
  opts: {
    dueAt: string;
    assignedTeamId: string | null;
    assignedPersonId: string | null;
    linkedRecords: TaskLinkedRecord[];
    description: string;
    byId: string;
    now: string;
    overridePriorityId?: string;
  },
): Promise<Task> {
  const taskRepo = getTaskWorkflowRepository();
  const tpl = store.taskSettings.templates.find((t) => t.trigger === trigger);
  const rawTitle =
    tpl?.titleTemplate ??
    (trigger === 'enquiry_contact'
      ? 'Contact new enquiry: {name}'
      : trigger === 'non_engagement_letter'
        ? 'Send non-engagement letter: {name}'
        : 'Complete matter opening: {matterNumber}');
  const title = rawTitle
    .replace('{name}', vars.name ?? '')
    .replace('{matterNumber}', vars.matterNumber ?? '')
    .trim();

  const id = await taskRepo.allocateNextTaskId(ctx);
  const task: Task = {
    id,
    reference: id,
    title,
    description: opts.description,
    taskTypeId:
      tpl?.taskTypeId ||
      (trigger === 'enquiry_contact'
        ? vid('task_type', 'Call back')
        : trigger === 'non_engagement_letter'
          ? vid('task_type', 'Send letter')
          : vid('task_type', 'Complete matter opening')),
    priorityId: opts.overridePriorityId || tpl?.priorityId || vid('task_priority', 'Normal'),
    dueAt: opts.dueAt,
    assignedTeamId: opts.assignedTeamId,
    assignedPersonId: opts.assignedPersonId,
    status: 'To do',
    linkedRecords: opts.linkedRecords,
    createdById: opts.byId,
    createdAt: opts.now,
    updatedById: opts.byId,
    updatedAt: opts.now,
    completedById: null,
    completedAt: null,
    comments: [],
    autoTrigger: trigger,
  };

  await taskRepo.putTask(ctx, task);
  writeAudit(store, {
    recordType: 'task',
    recordId: task.id,
    action: 'create',
    field: `Automatic task (${trigger})`,
    oldValue: null,
    newValue: `${task.reference} — ${task.title}`,
    byId: opts.byId,
    at: opts.now,
  });

  if (task.assignedPersonId) {
    await pushNotification(ctx, {
      recipientId: task.assignedPersonId,
      kind: 'task_assigned',
      title: `Task assigned to you: ${task.title}`,
      detail: `${task.reference} · Due ${formatDate(task.dueAt)}`,
      href: `/tasks/${task.id}`,
      recordId: task.id,
      byId: opts.byId,
      at: opts.now,
    });
  } else if (task.assignedTeamId) {
    const team = await getHrAndRbacRepository().getTeamById<Team>(ctx, task.assignedTeamId);
    if (team) {
      for (const memberId of team.memberIds) {
        await pushNotification(ctx, {
          recipientId: memberId,
          kind: 'team_task_arrived',
          title: `New task in ${team.name} queue`,
          detail: `${task.reference} — ${task.title}`,
          href: `/tasks/${task.id}`,
          recordId: task.id,
          byId: opts.byId,
          at: opts.now,
        });
      }
    }
  }

  return task;
}

async function completeOpenContactTasksForEnquiry(
  ctx: TenantContext,
  store: FirmStore,
  enquiryId: string,
  reasonLabel: string,
  byId: string,
  now: string,
): Promise<void> {
  const taskRepo = getTaskWorkflowRepository();
  const tasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
  for (const t of tasks) {
    const isLinked = t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === enquiryId);
    const isContactTask =
      t.autoTrigger === 'enquiry_contact' ||
      t.taskTypeId === vid('task_type', 'Call back') ||
      t.title.toLowerCase().startsWith('contact new enquiry');
    if (isLinked && isContactTask && isTaskOpen(t)) {
      const oldStatus = t.status;
      t.status = 'Done';
      t.completedById = byId;
      t.completedAt = now;
      t.updatedById = byId;
      t.updatedAt = now;
      await taskRepo.putTask(ctx, t);
      writeAudit(store, {
        recordType: 'task',
        recordId: t.id,
        action: 'status-change',
        field: 'Auto-completed',
        oldValue: oldStatus,
        newValue: `Done (${reasonLabel})`,
        byId,
        at: now,
      });
    }
  }
}

export async function saveEnquiryRecord(
  input: Partial<Enquiry> & {
    firstName?: string;
    lastName?: string;
    channelId?: string;
    practiceAreaId?: string;
    summary?: string;
    notes?: string;
    urgencyId?: string;
    privacyNoticeGiven?: boolean;
  },
  opts: { id?: string; byId: string; asDraft?: boolean; now?: string },
): Promise<{
  enquiry?: Enquiry;
  routedTeamName?: string;
  routedToIntakeFallback?: boolean;
  errors?: Record<string, string>;
  missingFields?: string[];
} & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async (): Promise<
    {
      enquiry?: Enquiry;
      routedTeamName?: string;
      routedToIntakeFallback?: boolean;
      errors?: Record<string, string>;
      missingFields?: string[];
    } & Partial<ActionDenied>
  > => {
  const now = opts.now ?? new Date().toISOString();
  const enqCtx = resolveDefaultServiceTenantContext(null, opts.byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, organisations, links, matters, enquiries, quotes, teams, rbacConfig] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    partyRepo.listAllPeople<Person>(enqCtx),
    partyRepo.listAllOrganisations<Organisation>(enqCtx),
    partyRepo.listAllLinks<PersonOrganisationLink>(enqCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
    loadEffectiveTenantRbacConfig(enqCtx),
  ]);
  const actor = people.find((p) => p.id === opts.byId) ?? null;
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
    rbacConfig,
  });
  const existing = opts.id ? enquiries.find((e) => e.id === opts.id) ?? null : null;
  if (opts.id && !existing) {
    const msg = 'Enquiry not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      errors: { notFound: msg },
    };
  }
  if (!existing) {
    if (
      !hasPersonPermission(actor, 'enquiry:create', {
        allPeople: people,
        teams,
        config: { rbac: rbacConfig },
      })
    ) {
      const msg = 'You do not have permission (enquiry:create) to create an enquiry.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        errors: { permission: msg },
      };
    }
  } else {
    if (
      !hasPersonPermission(actor, 'enquiry:edit', {
        allPeople: people,
        teams,
        config: { rbac: rbacConfig },
      }) ||
      !visibility.canViewEnquiry(existing)
    ) {
      const msg =
        'You do not have permission (enquiry:edit) or access to edit this enquiry.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        errors: { permission: msg },
      };
    }
    if (existing.status !== 'Draft') {
      const attemptedStatusChange =
        Boolean(opts.asDraft) ||
        (input.status !== undefined && input.status !== existing.status);
      const attemptedAssigneeChange =
        input.assignedToId !== undefined &&
        (input.assignedToId ?? null) !== (existing.assignedToId ?? null);
      const attemptedTeamChange =
        input.assignedTeamId !== undefined &&
        (input.assignedTeamId ?? null) !== (existing.assignedTeamId ?? null);
      if (attemptedStatusChange || attemptedAssigneeChange || attemptedTeamChange) {
        const msg =
          'Status and assignment on a non-draft enquiry cannot be changed through saveEnquiryRecord. Use the assign, close, or reopen actions (assignEnquiryAction, closeEnquiryAction, or reopenEnquiryAction).';
        return {
          ...buildActionDenied('FORBIDDEN', msg),
          errors: { permission: msg },
        };
      }
    }
  }
  if (
    input.linkedOrganisationId &&
    !organisations.some((o) => o.id === input.linkedOrganisationId)
  ) {
    const msg = 'Linked organisation not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      errors: { linkedOrganisationId: msg },
    };
  }
  if (
    input.linkedPersonId &&
    !people.some((p) => p.id === input.linkedPersonId)
  ) {
    const msg = 'Linked person not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      errors: { linkedPersonId: msg },
    };
  }
  const asDraft = Boolean(opts.asDraft || input.status === 'Draft');

  const mergedInput = {
    channelId: input.channelId ?? existing?.channelId ?? vid('enquiry_channel', 'Phone'),
    firstName: (input.firstName ?? existing?.firstName ?? '').trim(),
    lastName: (input.lastName ?? existing?.lastName ?? '').trim(),
    callingOnBehalfOf: (input.callingOnBehalfOf ?? existing?.callingOnBehalfOf ?? '').trim(),
    linkedOrganisationId:
      input.linkedOrganisationId !== undefined
        ? input.linkedOrganisationId
        : existing?.linkedOrganisationId ?? null,
    email: (input.email ?? existing?.email ?? '').trim(),
    phone: (input.phone ?? existing?.phone ?? '').trim(),
    preferredContactMethodId:
      input.preferredContactMethodId !== undefined
        ? input.preferredContactMethodId
        : existing?.preferredContactMethodId ?? null,
    bestTimeToCall: (input.bestTimeToCall ?? existing?.bestTimeToCall ?? '').trim(),
    address: input.address !== undefined ? input.address : existing?.address ?? null,
    practiceAreaId: (input.practiceAreaId ?? existing?.practiceAreaId ?? '').trim(),
    workTypeSubcategoryId:
      input.workTypeSubcategoryId !== undefined
        ? input.workTypeSubcategoryId
        : existing?.workTypeSubcategoryId ?? null,
    summary: (input.summary ?? existing?.summary ?? '').trim(),
    notes: (input.notes ?? existing?.notes ?? '').trim(),
    otherPartiesNamed: (input.otherPartiesNamed ?? existing?.otherPartiesNamed ?? '').trim(),
    urgencyId: input.urgencyId ?? existing?.urgencyId ?? vid('enquiry_urgency', 'Standard'),
    keyDate: input.keyDate !== undefined ? input.keyDate : existing?.keyDate ?? null,
    keyDateLabel: (input.keyDateLabel ?? existing?.keyDateLabel ?? '').trim(),
    sourceId: input.sourceId !== undefined ? input.sourceId : existing?.sourceId ?? null,
    referrerPersonId:
      input.referrerPersonId !== undefined
        ? input.referrerPersonId
        : existing?.referrerPersonId ?? null,
    privacyNoticeGiven:
      input.privacyNoticeGiven !== undefined
        ? Boolean(input.privacyNoticeGiven)
        : existing?.privacyNoticeGiven ?? false,
    linkedPersonId:
      input.linkedPersonId !== undefined ? input.linkedPersonId : existing?.linkedPersonId ?? null,
    customFields:
      input.customFields !== undefined ? input.customFields : existing?.customFields ?? {},
  };

  const cfValidation = validateCustomFields(
    store.customFields,
    'enquiry',
    mergedInput.customFields,
    existing?.customFields ?? {},
    store.values,
  );

  if (!asDraft) {
    const missingFields = getMissingRoutingFields(mergedInput, store.customFields);
    const errors: Record<string, string> = {
      ...cfValidation.errors,
      ...validateEnquiryInput(mergedInput),
    };
    if (
      existing &&
      existing.status !== 'Draft' &&
      !existing.privacyNoticeGiven &&
      !mergedInput.privacyNoticeGiven
    ) {
      delete errors.privacyNoticeGiven;
    }
    if (!mergedInput.firstName) errors.firstName = 'First name is required.';
    if (!mergedInput.lastName) errors.lastName = 'Last name is required.';

    if (missingFields.length > 0 || Object.keys(errors).length > 0) {
      return { errors, missingFields };
    }
  }

  // Server-side Quick Conflict Check snapshot (passes all matters and redacts restricted hits via canViewMatter, R257)
  const conflictSnapshot = computeEnquiryConflictSnapshot(
    {
      firstName: mergedInput.firstName,
      lastName: mergedInput.lastName,
      callingOnBehalfOf: mergedInput.callingOnBehalfOf,
      otherPartiesNamed: mergedInput.otherPartiesNamed,
      email: mergedInput.email,
      phone: mergedInput.phone,
      postcode: mergedInput.address?.postcode ?? '',
      addressLine1: mergedInput.address?.line1 ?? '',
      addressLine2: mergedInput.address?.line2 ?? '',
      linkedPersonId: mergedInput.linkedPersonId,
      linkedOrganisationId: mergedInput.linkedOrganisationId,
    },
    people,
    organisations,
    matters,
    store.values,
    {
      recordedAt: now,
      recordedById: opts.byId,
      enquiries: enquiries.filter((e) => visibility.canViewEnquiry(e)),
      excludeEnquiryId: existing?.id ?? null,
      links,
      canViewMatter: visibility.canViewMatter,
      tenantId: getActiveTenantConfiguration().tenantId,
    },
  );

  const conflictAuditSummary =
    conflictSnapshot.matchCount === 0
      ? '0 matches (none)'
      : conflictSnapshot.highestSeverity === 'high'
        ? `${conflictSnapshot.matchCount} ${conflictSnapshot.matchCount === 1 ? 'possible conflict' : 'possible conflicts'} (high severity)`
        : `${conflictSnapshot.matchCount} ${conflictSnapshot.matchCount === 1 ? 'match' : 'matches'} (${conflictSnapshot.highestSeverity} severity)`;

  return intakeRepo.withTenantTransaction(enqCtx, async () => {
  const id = existing?.id ?? (await intakeRepo.allocateNextEnquiryId(enqCtx));
  const receivedAt = input.receivedAt || existing?.receivedAt || now;

  if (asDraft) {
    const draftEnquiry: Enquiry = {
      id,
      reference: id,
      receivedAt,
      takenById: input.takenById || existing?.takenById || opts.byId,
      channelId: mergedInput.channelId,
      firstName: mergedInput.firstName,
      lastName: mergedInput.lastName,
      callingOnBehalfOf: mergedInput.callingOnBehalfOf,
      linkedOrganisationId: mergedInput.linkedOrganisationId,
      email: mergedInput.email,
      phone: mergedInput.phone,
      preferredContactMethodId: mergedInput.preferredContactMethodId,
      bestTimeToCall: mergedInput.bestTimeToCall,
      address: mergedInput.address,
      practiceAreaId: mergedInput.practiceAreaId,
      workTypeSubcategoryId: mergedInput.workTypeSubcategoryId,
      summary: mergedInput.summary.slice(0, 120),
      notes: mergedInput.notes,
      otherPartiesNamed: mergedInput.otherPartiesNamed,
      urgencyId: mergedInput.urgencyId,
      keyDate: mergedInput.keyDate,
      keyDateLabel: mergedInput.keyDateLabel,
      sourceId: mergedInput.sourceId,
      referrerPersonId: mergedInput.referrerPersonId,
      privacyNoticeGiven: mergedInput.privacyNoticeGiven,
      linkedPersonId: mergedInput.linkedPersonId,
      assignedTeamId: null,
      routedToIntakeFallback: false,
      assignedToId: null,
      status: 'Draft',
      firstContactDueAt: null,
      nextActionDate: null,
      conflictStatus: conflictSnapshot.conflictStatus,
      conflictSnapshot,
      closeReasonId: existing?.closeReasonId ?? null,
      closeNotes: existing?.closeNotes,
      referredToOrganisationId: existing?.referredToOrganisationId ?? null,
      referredToName: existing?.referredToName,
      convertedMatterId: existing?.convertedMatterId ?? null,
      contactLog: input.contactLog ?? existing?.contactLog ?? [],
      customFields: cfValidation.values,
      anonymisedAt: existing?.anonymisedAt ?? null,
      createdById: existing?.createdById ?? opts.byId,
      createdAt: existing?.createdAt ?? now,
      updatedById: opts.byId,
      updatedAt: now,
    };

    await intakeRepo.putEnquiry(enqCtx, draftEnquiry);
    if (!existing) {
      const channelLabel = resolveLabel(store.values, draftEnquiry.channelId) || 'Phone';
      const areaLabel = draftEnquiry.practiceAreaId
        ? resolveLabel(store.values, draftEnquiry.practiceAreaId)
        : '';
      writeAudit(store, {
        recordType: 'enquiry',
        recordId: draftEnquiry.id,
        action: 'create',
        field: `Initial enquiry received (${channelLabel.toLowerCase()})`,
        oldValue: null,
        newValue: [
          draftEnquiry.reference,
          areaLabel || null,
          draftEnquiry.summary ? `"${draftEnquiry.summary.slice(0, 80)}"` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        byId: draftEnquiry.takenById,
        at: receivedAt,
      });
    }

    writeAudit(store, {
      recordType: 'enquiry',
      recordId: draftEnquiry.id,
      action: existing ? 'update' : 'create',
      field: 'Enquiry saved as draft',
      oldValue: null,
      newValue: draftEnquiry.reference,
      byId: opts.byId,
      at: now,
    });

    writeAudit(store, {
      recordType: 'enquiry',
      recordId: draftEnquiry.id,
      action: 'conflict-decision',
      field: 'Quick conflict check recorded',
      oldValue: null,
      newValue: conflictAuditSummary,
      byId: opts.byId,
      at: now,
      snapshot: conflictSnapshot,
    });

    await flushStagedAuditEntries(enqCtx);
    return {
      enquiry: draftEnquiry,
      routedToIntakeFallback: false,
    };
  }

  // Routing / updating a non-draft enquiry
  const isInitialRoute = !existing || existing.status === 'Draft';
  const whCfg = workingHoursConfigFromStore(store);
  const urgencyLabel = resolveLabel(store.values, mergedInput.urgencyId) || 'Standard';

  // When routing (either brand new or transitioning from Draft -> New), calculate SLA from routing time (`now`)
  const routingTime = isInitialRoute ? now : receivedAt;
  const firstContactDueAt = isInitialRoute
    ? calculateFirstContactDue(routingTime, urgencyLabel, whCfg)
    : existing?.firstContactDueAt ?? calculateFirstContactDue(receivedAt, urgencyLabel, whCfg);

  // Route to practice area team or fallback to Intake
  let assignedTeamId = isInitialRoute
    ? input.assignedTeamId !== undefined
      ? input.assignedTeamId
      : existing?.assignedTeamId ?? null
    : existing?.assignedTeamId ?? null;
  let routedToIntakeFallback = existing?.routedToIntakeFallback ?? false;
  if (isInitialRoute && !assignedTeamId) {
    const routed = resolveRoutedTeam(mergedInput.practiceAreaId, teams);
    assignedTeamId = routed.team?.id ?? null;
    routedToIntakeFallback = routed.isFallbackIntake;
  }

  const assignedToId = isInitialRoute
    ? input.assignedToId !== undefined
      ? input.assignedToId
      : existing?.assignedToId ?? null
    : existing?.assignedToId ?? null;
  const defaultStatus: EnquiryStatus = assignedToId ? 'Assigned' : 'New';
  const nextStatus: EnquiryStatus = isInitialRoute
    ? input.status && input.status !== 'Draft'
      ? input.status
      : defaultStatus
    : existing.status;

  const enquiry: Enquiry = {
    id,
    reference: id,
    receivedAt,
    takenById: input.takenById || existing?.takenById || opts.byId,
    channelId: mergedInput.channelId,
    firstName: mergedInput.firstName,
    lastName: mergedInput.lastName,
    callingOnBehalfOf: mergedInput.callingOnBehalfOf,
    linkedOrganisationId: mergedInput.linkedOrganisationId,
    email: mergedInput.email,
    phone: mergedInput.phone,
    preferredContactMethodId: mergedInput.preferredContactMethodId,
    bestTimeToCall: mergedInput.bestTimeToCall,
    address: mergedInput.address,
    practiceAreaId: mergedInput.practiceAreaId,
    workTypeSubcategoryId: mergedInput.workTypeSubcategoryId,
    summary: mergedInput.summary.slice(0, 120),
    notes: mergedInput.notes,
    otherPartiesNamed: mergedInput.otherPartiesNamed,
    urgencyId: mergedInput.urgencyId,
    keyDate: mergedInput.keyDate,
    keyDateLabel: mergedInput.keyDateLabel,
    sourceId: mergedInput.sourceId,
    referrerPersonId: mergedInput.referrerPersonId,
    privacyNoticeGiven: mergedInput.privacyNoticeGiven,
    linkedPersonId: mergedInput.linkedPersonId,
    assignedTeamId,
    routedToIntakeFallback,
    assignedToId,
    status: nextStatus,
    firstContactDueAt,
    nextActionDate:
      input.nextActionDate !== undefined && input.nextActionDate !== null
        ? input.nextActionDate
        : existing?.nextActionDate ?? firstContactDueAt.slice(0, 10),
    conflictStatus: conflictSnapshot.conflictStatus,
    conflictSnapshot,
    closeReasonId:
      input.closeReasonId !== undefined ? input.closeReasonId : existing?.closeReasonId ?? null,
    closeNotes: input.closeNotes !== undefined ? input.closeNotes : existing?.closeNotes,
    referredToOrganisationId:
      input.referredToOrganisationId !== undefined
        ? input.referredToOrganisationId
        : existing?.referredToOrganisationId ?? null,
    referredToName:
      input.referredToName !== undefined ? input.referredToName : existing?.referredToName,
    convertedMatterId:
      input.convertedMatterId !== undefined
        ? input.convertedMatterId
        : existing?.convertedMatterId ?? null,
    contactLog: input.contactLog ?? existing?.contactLog ?? [],
    customFields: cfValidation.values,
    anonymisedAt: existing?.anonymisedAt ?? null,
    createdById: existing?.createdById ?? opts.byId,
    createdAt: existing?.createdAt ?? now,
    updatedById: opts.byId,
    updatedAt: now,
  };

  const routedTeam = teams.find((t) => t.id === enquiry.assignedTeamId);
  const practiceAreaLabel =
    resolveLabel(store.values, enquiry.practiceAreaId) || routedTeam?.name || 'Intake';

  await intakeRepo.putEnquiry(enqCtx, enquiry);
  if (!existing) {
    const channelLabel = resolveLabel(store.values, enquiry.channelId) || 'Phone';
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enquiry.id,
      action: 'create',
      field: `Initial enquiry received (${channelLabel.toLowerCase()})`,
      oldValue: null,
      newValue: [
        enquiry.reference,
        practiceAreaLabel || null,
        enquiry.summary ? `"${enquiry.summary.slice(0, 80)}"` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      byId: enquiry.takenById,
      at: receivedAt,
    });
  }

  writeAudit(store, {
    recordType: 'enquiry',
    recordId: enquiry.id,
    action: 'conflict-decision',
    field: 'Quick conflict check recorded',
    oldValue: null,
    newValue: conflictAuditSummary,
    byId: opts.byId,
    at: now,
    snapshot: conflictSnapshot,
  });

  if (isInitialRoute) {
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enquiry.id,
      action: existing ? 'status-change' : 'create',
      field: `Enquiry routed to ${practiceAreaLabel} team`,
      oldValue: existing ? 'Draft' : null,
      newValue: `${enquiry.reference} — ${enquiryDisplayName(enquiry)} (${routedTeam?.name ?? practiceAreaLabel})`,
      byId: opts.byId,
      at: now,
    });

    // Automatic task: Contact new enquiry: <name>
    const priorityId =
      urgencyLabel.toLowerCase().includes('emergency') ||
      urgencyLabel.toLowerCase().includes('urgent')
        ? vid('task_priority', 'Urgent')
        : vid('task_priority', 'Normal');

    const linkedRecords: TaskLinkedRecord[] = [{ recordType: 'enquiry', recordId: enquiry.id }];
    if (enquiry.linkedPersonId) {
      linkedRecords.push({ recordType: 'person', recordId: enquiry.linkedPersonId });
    }
    if (enquiry.linkedOrganisationId) {
      linkedRecords.push({ recordType: 'organisation', recordId: enquiry.linkedOrganisationId });
    }

    await raiseAutomaticTask(
      enqCtx,
      store,
      'enquiry_contact',
      { name: enquiryDisplayName(enquiry) },
      {
        dueAt: firstContactDueAt,
        assignedTeamId: enquiry.assignedTeamId,
        assignedPersonId: enquiry.assignedToId,
        linkedRecords,
        description: `${enquiry.summary}${enquiry.phone ? ` · Tel: ${enquiry.phone}` : ''}${enquiry.email ? ` · Email: ${enquiry.email}` : ''}`,
        byId: opts.byId,
        now,
        overridePriorityId: priorityId,
      },
    );
  } else {
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enquiry.id,
      action: 'update',
      field: 'Enquiry details updated',
      oldValue: existing?.summary ?? null,
      newValue: enquiry.summary,
      byId: opts.byId,
      at: now,
    });
  }

  await flushStagedAuditEntries(enqCtx);
  return {
    enquiry,
    routedTeamName: routedTeam?.name ?? 'Intake',
    routedToIntakeFallback,
  };
  });
  });
}

export async function assignEnquiryRecord(
  enquiryId: string,
  assignedToId: string | null,
  assignedTeamId: string | null | undefined,
  byId: string,
): Promise<{ enquiry?: Enquiry; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const [store, people, matters, enquiries, quotes, tasks, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    getPartyRepository().listAllPeople<Person>(enqCtx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    taskRepo.listAllTasksUnfiltered<Task>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:assign', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:assign) to assign enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (
    !enq ||
    (enq.convertedMatterId && visibility.hiddenMatterIds.has(enq.convertedMatterId)) ||
    visibility.hiddenMatterSourceEnquiryIds.has(enq.id)
  ) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (!isEnquiryRouted(enq)) {
    return { error: 'Cannot assign a draft or closed enquiry before it has been routed.' };
  }
  if (!visibility.canViewEnquiry(enq)) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date().toISOString();
  const ctx = formatContext(store, { people, matters });
  const oldAssignee = enq.assignedToId ? ctx.nameOf(enq.assignedToId) : 'Unassigned';
  const oldStatus = enq.status;

  if (assignedTeamId !== undefined) {
    enq.assignedTeamId = assignedTeamId;
  }
  enq.assignedToId = assignedToId;
  if (assignedToId && enq.status === 'New') {
    enq.status = 'Assigned';
  }
  enq.updatedAt = now;
  enq.updatedById = byId;

  await intakeRepo.withTenantTransaction(enqCtx, async () => {
    await intakeRepo.putEnquiry(enqCtx, enq);

    const newAssignee = assignedToId ? ctx.nameOf(assignedToId) : 'Unassigned';
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'assign',
      field: 'Assigned to',
      oldValue: `${oldAssignee} (${oldStatus})`,
      newValue: `${newAssignee} (${enq.status})`,
      byId,
      at: now,
    });

    // Automatic task rule: When enquiry is assigned to someone, the open contact task moves to them (due unchanged)
    if (assignedToId) {
      for (const t of tasks) {
        const isLinked = t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === enq.id);
        const isContactTask =
          t.autoTrigger === 'enquiry_contact' ||
          t.taskTypeId === vid('task_type', 'Call back') ||
          t.title.toLowerCase().startsWith('contact new enquiry');
        if (isLinked && isContactTask && isTaskOpen(t)) {
          const prevTaskPerson = t.assignedPersonId;
          t.assignedPersonId = assignedToId;
          if (assignedTeamId) t.assignedTeamId = assignedTeamId;
          t.updatedAt = now;
          t.updatedById = byId;
          await taskRepo.putTask(enqCtx, t);
          writeAudit(store, {
            recordType: 'task',
            recordId: t.id,
            action: 'assign',
            field: 'Assigned to (from enquiry assignment)',
            oldValue: prevTaskPerson ? ctx.nameOf(prevTaskPerson) : 'Team queue',
            newValue: newAssignee,
            byId,
            at: now,
          });
        }
      }

      await pushNotification(enqCtx, {
        recipientId: assignedToId,
        kind: 'enquiry_assigned',
        title: `Enquiry assigned to you: ${enq.reference} (${enquiryDisplayName(enq)})`,
        detail: `${resolveLabel(store.values, enq.practiceAreaId)} · ${enq.summary}`,
        href: `/enquiries/${enq.id}`,
        recordId: enq.id,
        byId,
        at: now,
      });
    }

    await flushStagedAuditEntries(enqCtx);
  });

  return { enquiry: enq };
  });
}

export async function logEnquiryContactRecord(
  enquiryId: string,
  input: {
    at?: string;
    method: ContactLogMethod;
    outcome: ContactLogOutcome;
    note: string;
  },
  byId: string,
): Promise<{ enquiry?: Enquiry; suggestNoResponse?: boolean; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    getPartyRepository().listAllPeople<Person>(enqCtx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:edit) to log contact on enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (!enq || !visibility.canViewEnquiry(enq)) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date().toISOString();
  const entry: ContactLogEntry = {
    id: `CL-${Date.now().toString(36)}`,
    at: input.at || now,
    method: input.method,
    outcome: input.outcome,
    note: input.note.trim(),
    byId,
  };
  enq.contactLog.unshift(entry);

  // If unassigned when logging contact on a routed enquiry, assign to the logger
  if (!enq.assignedToId && enq.status !== 'Draft') {
    enq.assignedToId = byId;
  }

  const prevStatus = enq.status;
  await intakeRepo.withTenantTransaction(enqCtx, async () => {
    if (input.outcome === 'Spoke' && (enq.status === 'New' || enq.status === 'Assigned')) {
      enq.status = 'In contact';
      // Complete the initial contact task once spoken
      await completeOpenContactTasksForEnquiry(
        enqCtx,
        store,
        enq.id,
        'Spoke to enquirer',
        byId,
        now,
      );
    } else if (enq.status === 'New') {
      enq.status = 'Assigned';
    }

    enq.updatedAt = now;
    enq.updatedById = byId;
    await intakeRepo.putEnquiry(enqCtx, enq);

    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'contact-log',
      field: `Contact logged (${input.method} · ${input.outcome})`,
      oldValue: prevStatus !== enq.status ? `Status: ${prevStatus}` : null,
      newValue: `${entry.note.slice(0, 100)}${prevStatus !== enq.status ? ` (Status → ${enq.status})` : ''}`,
      byId,
      at: now,
    });

    await flushStagedAuditEntries(enqCtx);
  });

  const threshold = store.enquirySettings.failedAttemptsBeforeSuggestNoResponse || 3;
  const hasSpoken = enq.contactLog.some((c) => c.outcome === 'Spoke');
  const failedCount = hasSpoken ? 0 : enq.contactLog.filter((c) => c.outcome !== 'Spoke').length;

  return {
    enquiry: enq,
    suggestNoResponse: isEnquiryOpen(enq) && failedCount >= threshold,
  };
  });
}

export async function sendEnquiryEmailRecord(
  enquiryId: string,
  input: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
  },
  byId: string,
): Promise<{ enquiry?: Enquiry; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    getPartyRepository().listAllPeople<Person>(enqCtx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:edit) to send enquiry emails.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (!enq || !visibility.canViewEnquiry(enq)) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const to = input.to.trim();
  const subject = input.subject.trim();
  if (!to) return { error: 'Recipient email address is required.' };
  if (!subject) return { error: 'Email subject is required.' };
  if (!input.bodyText.trim() && !input.bodyHtml.trim()) {
    return { error: 'Please enter a message before sending.' };
  }

  const now = new Date().toISOString();
  enq.updatedAt = now;
  enq.updatedById = byId;

  const emailSnapshot: EnquirySentEmailSnapshot = {
    kind: 'sent_email',
    to,
    subject,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText.trim(),
    sentAt: now,
    sentById: byId,
  };

  await intakeRepo.withTenantTransaction(enqCtx, async () => {
    await intakeRepo.putEnquiry(enqCtx, enq);
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'email-sent',
      field: `Email sent to ${to}`,
      oldValue: null,
      newValue: `Subject: "${subject}"${emailSnapshot.bodyText ? ` · ${emailSnapshot.bodyText.slice(0, 80)}` : ''}`,
      byId,
      at: now,
      snapshot: emailSnapshot,
    });
    await flushStagedAuditEntries(enqCtx);
  });

  return { enquiry: enq };
  });
}

export async function closeEnquiryRecord(
  enquiryId: string,
  input: {
    targetStatus: 'Declined' | 'Referred out' | 'No response';
    closeReasonId?: string | null;
    closeNotes?: string;
    referredToOrganisationId?: string | null;
    referredToName?: string;
  },
  byId: string,
): Promise<{ enquiry?: Enquiry; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    partyRepo.listAllPeople<Person>(enqCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:close', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:close) to close enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (!enq || !visibility.canViewEnquiry(enq)) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  if (input.targetStatus === 'Declined' && !input.closeReasonId) {
    return { error: 'A close reason is required when declining an enquiry.' };
  }
  if (
    input.targetStatus === 'Referred out' &&
    !input.referredToOrganisationId &&
    !input.referredToName?.trim()
  ) {
    return { error: 'Please specify the firm or service the enquiry was referred to.' };
  }
  if (input.targetStatus === 'No response' && enq.contactLog.length < 2) {
    return { error: 'At least two contact log entries are required before closing as no response.' };
  }

  const now = new Date().toISOString();
  const prevStatus = enq.status;
  enq.status = input.targetStatus;
  enq.closeReasonId =
    input.closeReasonId ||
    (input.targetStatus === 'Referred out'
      ? vid('enquiry_close_reason', 'Referred out')
      : input.targetStatus === 'No response'
        ? vid('enquiry_close_reason', 'No response')
        : enq.closeReasonId);
  if (input.closeNotes !== undefined) enq.closeNotes = input.closeNotes.trim();
  if (input.referredToOrganisationId !== undefined) {
    enq.referredToOrganisationId = input.referredToOrganisationId;
  }
  if (input.referredToName !== undefined) {
    enq.referredToName = input.referredToName.trim();
  }
  if (!enq.assignedToId) {
    enq.assignedToId = byId;
  }
  enq.updatedAt = now;
  enq.updatedById = byId;

  const reasonLabel = resolveLabel(store.values, enq.closeReasonId) || input.targetStatus;
  await intakeRepo.withTenantTransaction(enqCtx, async (tx) => {
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'status-change',
      field: `Enquiry closed (${input.targetStatus})`,
      oldValue: prevStatus,
      newValue: `${input.targetStatus} — Reason: ${reasonLabel}${enq.referredToName ? ` · Referred to: ${enq.referredToName}` : ''}`,
      byId,
      at: now,
    });

    // Complete open contact task automatically
    await completeOpenContactTasksForEnquiry(
      enqCtx,
      store,
      enq.id,
      `Enquiry closed as ${input.targetStatus}`,
      byId,
      now,
    );

    // If an enquiry-stage person record was created solely for this enquiry and has no matters or other open/converted enquiries, remove it
    if (enq.linkedPersonId) {
      const linkedId = enq.linkedPersonId;
      const linkedPerson = people.find((p) => p.id === linkedId);
      if (linkedPerson && !linkedPerson.isEmployee && linkedPerson.createdFromEnquiryId === enq.id) {
        const hasMatters = matters.some(
          (m) =>
            m.clientId === linkedId ||
            m.instructingContactId === linkedId ||
            m.billingContactId === linkedId ||
            m.referrerContactId === linkedId ||
            m.additionalClientIds?.includes(linkedId) ||
            m.parties.some((pt) => pt.linkedRecordId === linkedId),
        );
        const hasOtherActiveOrConvertedEnquiry = enquiries.some(
          (other) =>
            other.id !== enq.id &&
            (other.linkedPersonId === linkedId || other.referrerPersonId === linkedId) &&
            (isEnquiryOpen(other) || other.status === 'Converted'),
        );
        if (!hasMatters && !hasOtherActiveOrConvertedEnquiry) {
          await tx.query(
            'DELETE FROM person_organisation_links WHERE tenant_id = $1 AND person_id = $2',
            [enqCtx.tenantId, linkedId],
          );
          await tx.query('DELETE FROM people WHERE tenant_id = $1 AND id = $2', [
            enqCtx.tenantId,
            linkedId,
          ]);
          enq.linkedPersonId = null;
        }
      }
    }

    await intakeRepo.putEnquiry(enqCtx, enq);
    await flushStagedAuditEntries(enqCtx);
  });
  return { enquiry: enq };
  });
}

export async function reopenEnquiryRecord(
  enquiryId: string,
  byId: string,
): Promise<{ enquiry?: Enquiry; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    getPartyRepository().listAllPeople<Person>(enqCtx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:reopen', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:reopen) to reopen enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (!enq || !visibility.canViewEnquiry(enq)) {
    const msg = 'Enquiry not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (enq.status === 'Converted' || isEnquiryOpen(enq)) {
    const msg =
      enq.status === 'Converted'
        ? 'Converted enquiries cannot be reopened.'
        : 'Only closed enquiries (Declined, Referred out, or No response) can be reopened.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (!canUserReopenEnquiry(byId, enq, teams, people, store.values)) {
    const msg =
      'Only the assignee, the team lead for the enquiry team, Intake, or an administrator may reopen this enquiry.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date().toISOString();
  const prevStatus = enq.status;
  enq.status = enq.assignedToId ? 'Assigned' : 'New';
  enq.updatedAt = now;
  enq.updatedById = byId;

  await intakeRepo.withTenantTransaction(enqCtx, async () => {
    await intakeRepo.putEnquiry(enqCtx, enq);

    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'status-change',
      field: 'Enquiry reopened',
      oldValue: prevStatus,
      newValue: enq.status,
      byId,
      at: now,
    });

    await flushStagedAuditEntries(enqCtx);
  });

  return { enquiry: enq };
  });
}

const DECLINED_ORG_BLOCKED_REASON =
  'Client organisation has conflict status "Conflict – declined".';
const DECLINED_ORG_NAME_WARNING =
  "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.";

function assessDeclinedOrganisation(
  organisations: readonly Organisation[],
  existingOrg: Organisation | undefined,
  clientOrgName: string,
): {
  existingOrgDeclined: boolean;
  hasDeclinedOrgNameMatch: boolean;
  blockedReason: string | null;
  nameMatchWarning: string | null;
} {
  const declinedStatusId = vid('conflict_status', 'Conflict – declined');
  const existingOrgDeclined = Boolean(
    existingOrg && existingOrg.conflictStatusId === declinedStatusId,
  );
  const clientOrgNameLower = clientOrgName.trim().toLowerCase();
  const matchingOrgsByName =
    !existingOrg && clientOrgNameLower
      ? organisations.filter(
          (o) =>
            !o.mergedIntoId &&
            (o.legalName.trim().toLowerCase() === clientOrgNameLower ||
              o.otherNames.some((n) => n.name.trim().toLowerCase() === clientOrgNameLower)),
        )
      : [];
  const hasDeclinedOrgNameMatch = matchingOrgsByName.some(
    (o) => o.conflictStatusId === declinedStatusId,
  );
  return {
    existingOrgDeclined,
    hasDeclinedOrgNameMatch,
    blockedReason: existingOrgDeclined ? DECLINED_ORG_BLOCKED_REASON : null,
    nameMatchWarning: hasDeclinedOrgNameMatch ? DECLINED_ORG_NAME_WARNING : null,
  };
}

/**
 * Step 1 & 2 of Converting an enquiry to a matter:
 * - Runs the conflict check against the client and other parties named.
 * - If clear, links or creates the Person (and Organisation + contact link if calling for a business).
 * - Returns the clientId and instructingContactId so the user is routed to the pre-filled New Matter form.
 */
export async function prepareEnquiryConversion(
  enquiryId: string,
  opts: {
    usePersonId?: string | null;
    useOrganisationId?: string | null;
    createForBusiness?: boolean;
  },
  byId: string,
): Promise<{
  ok: boolean;
  conflictBlocked?: boolean;
  conflictReasons?: string[];
  conflictWarnings?: string[];
  clientId?: string;
  instructingContactId?: string | null;
  enquiryId?: string;
  error?: string;
} & Partial<Omit<ActionDenied, 'ok'>>> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, organisations, links, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    partyRepo.listAllPeople<Person>(enqCtx),
    partyRepo.listAllOrganisations<Organisation>(enqCtx),
    partyRepo.listAllLinks<PersonOrganisationLink>(enqCtx),
    matterRepo.listAllMattersUnfiltered<Matter>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'matter:create', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (matter:create) to convert an enquiry to a matter.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
      conflictReasons: [msg],
    };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const enq = enquiries.find((e) => e.id === enquiryId);
  if (!enq) return { ok: false, conflictReasons: ['Enquiry not found.'] };
  if (enq.convertedMatterId && visibility.hiddenMatterIds.has(enq.convertedMatterId)) {
    return { ok: false, conflictReasons: ['Enquiry not found.'] };
  }
  if (!isEnquiryRouted(enq)) {
    return {
      ok: false,
      conflictReasons: ['Cannot convert a draft enquiry before it has been routed.'],
    };
  }
  if (!visibility.canViewEnquiry(enq)) {
    return { ok: false, conflictReasons: ['Enquiry not found.'] };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = toIsoDate(now);
  const actorName = actor ? personDisplayName(actor) : byId;

  const conflicts = runEnquiryConflictSearch(
    {
      firstName: enq.firstName,
      lastName: enq.lastName,
      callingOnBehalfOf: enq.callingOnBehalfOf,
      otherPartiesNamed: enq.otherPartiesNamed,
      email: enq.email,
      phone: enq.phone,
      address: enq.address,
      linkedPersonId: opts.usePersonId ?? enq.linkedPersonId,
      linkedOrganisationId: opts.useOrganisationId ?? enq.linkedOrganisationId,
    },
    people,
    organisations,
    matters,
    store.values,
    enquiries.filter((e) => visibility.canViewEnquiry(e)),
    enq.id,
    links,
    visibility.canViewMatter,
    getActiveTenantConfiguration().tenantId,
  );

  const redactRestrictedMatterReasons = (rawReasons: string[]): string[] => {
    const hiddenMatters = matters.filter((m) => !visibility.canViewMatter(m));
    return rawReasons.map((reason) => {
      let safe = reason;
      for (const hm of hiddenMatters) {
        if (hm.matterNumber && safe.includes(hm.matterNumber)) {
          safe = safe.split(hm.matterNumber).join('a restricted matter');
        }
        if (hm.title && safe.includes(hm.title)) {
          safe = safe.split(hm.title).join('a restricted matter');
        }
        for (const pt of hm.parties) {
          if (pt.name && safe.includes(`"${pt.name}"`)) {
            safe = safe.split(`"${pt.name}"`).join('a party');
          }
        }
      }
      return safe;
    });
  };

  const linkedOrgId = opts.useOrganisationId ?? enq.linkedOrganisationId ?? null;
  const existingOrg = linkedOrgId
    ? organisations.find((o) => o.id === linkedOrgId)
    : undefined;
  const clientOrgName = existingOrg?.legalName || enq.callingOnBehalfOf.trim();
  const declinedOrgAssessment = assessDeclinedOrganisation(
    organisations,
    existingOrg,
    clientOrgName,
  );

  if (declinedOrgAssessment.existingOrgDeclined || conflicts.hasBlockingConflict) {
    const rawReasons: string[] = [];
    if (declinedOrgAssessment.blockedReason) {
      rawReasons.push(declinedOrgAssessment.blockedReason);
    }
    rawReasons.push(
      ...conflicts.otherPartyClientMatches.filter((h) => h.blocking).map((h) => h.reason),
      ...conflicts.clientAgainstPartyMatches.filter((h) => h.blocking).map((h) => h.reason),
    );
    const reasons = redactRestrictedMatterReasons(rawReasons);
    const blockedMatchesCount = conflicts.allConflicts.length;
    const blockedOutcome: 'Conflict – declined' | 'Potential conflict' =
      declinedOrgAssessment.existingOrgDeclined
        ? 'Conflict – declined'
        : 'Potential conflict';
    const blockedDecisionSummary = `${blockedOutcome} identified by ${actorName} on ${today} (${blockedMatchesCount} ${blockedMatchesCount === 1 ? 'match' : 'matches'})`;
    const blockedDecisionSnapshot = {
      outcome: blockedOutcome,
      decidedById: byId,
      decidedByName: actorName,
      decidedAt: nowIso,
      sourceRecordId: enq.id,
      matchesCount: blockedMatchesCount,
      searchedSources: [...CONFLICT_SEARCHED_SOURCES],
      summary: blockedDecisionSummary,
    };
    await intakeRepo.withTenantTransaction(enqCtx, async () => {
      writeAudit(store, {
        recordType: 'enquiry',
        recordId: enq.id,
        action: 'conflict-decision',
        field: 'Enquiry conversion blocked by conflict check',
        oldValue: null,
        newValue: `${blockedDecisionSummary} · ${reasons.join(' · ')}`,
        byId,
        at: nowIso,
        snapshot: blockedDecisionSnapshot,
      });
      await flushStagedAuditEntries(enqCtx);
    });
    return {
      ok: false,
      conflictBlocked: true,
      conflictReasons: reasons,
      error: reasons[0],
    };
  }

  return intakeRepo.withTenantTransaction(enqCtx, async () => {
    // Link or create Person
    let personId = opts.usePersonId || enq.linkedPersonId;
    if (!personId) {
      const createdPerson = await savePersonRecord(
        {
          firstName: enq.firstName,
          surname: enq.lastName,
          emails: enq.email
            ? [
                {
                  id: `e_${Date.now()}`,
                  address: enq.email,
                  typeId: vid('email_type', enq.callingOnBehalfOf ? 'Work' : 'Personal'),
                  isPrimary: true,
                },
              ]
            : [],
          phones: enq.phone
            ? [
                {
                  id: `p_${Date.now()}`,
                  number: enq.phone,
                  typeId: vid('phone_type', 'Mobile'),
                },
              ]
            : [],
          addresses: enq.address ? [{ ...enq.address, id: `a_${Date.now()}` }] : [],
          preferredContactMethodId: enq.preferredContactMethodId,
          originId: enq.sourceId,
          relationshipStatusId: vid('relationship_status', 'Prospective'),
          relationshipRoleIds: [
            vid('person_role', enq.callingOnBehalfOf ? 'Client contact' : 'Private client'),
          ],
          relationshipOwnerId: enq.assignedToId || byId,
          sourceId: vid('data_source', 'Manual entry'),
          createdFromEnquiryId: enq.id,
        },
        { byId, internalSystemStep: 'enquiry_conversion' },
      );
      personId = createdPerson.person.id;
    }

    enq.linkedPersonId = personId;

    const conflictWarnings = redactRestrictedMatterReasons(
      conflicts.allConflicts
        .filter((h) => !h.blocking && h.severity !== 'high')
        .map((h) => h.reason),
    );
    if (
      declinedOrgAssessment.nameMatchWarning &&
      !conflictWarnings.includes(declinedOrgAssessment.nameMatchWarning)
    ) {
      conflictWarnings.push(declinedOrgAssessment.nameMatchWarning);
    }

    const outcomeLabel: 'Cleared' | 'Potential conflict' =
      conflicts.allConflicts.length > 0 || declinedOrgAssessment.hasDeclinedOrgNameMatch
        ? 'Potential conflict'
        : 'Cleared';
    const decisionSummary = `${outcomeLabel} by ${actorName} on ${today} (${conflicts.allConflicts.length} ${conflicts.allConflicts.length === 1 ? 'match' : 'matches'})`;
    const conflictReference = `${enq.reference} · ${decisionSummary}`;
    const decisionSnapshot = {
      outcome: outcomeLabel,
      decidedById: byId,
      decidedByName: actorName,
      decidedAt: nowIso,
      sourceRecordId: enq.id,
      matchesCount: conflicts.allConflicts.length,
      searchedSources: [...CONFLICT_SEARCHED_SOURCES],
      summary: decisionSummary,
      ...(conflictWarnings.length > 0 ? { warnings: [...conflictWarnings] } : {}),
    };
    enq.conflictDecision = decisionSnapshot;

    // If enquiry was made on behalf of a business, link or create the Organisation and link caller as contact
    let clientId = personId;
    const instructingContactId: string | null = personId;

    if (opts.createForBusiness || enq.callingOnBehalfOf.trim() || opts.useOrganisationId || enq.linkedOrganisationId) {
      let orgId = opts.useOrganisationId || enq.linkedOrganisationId;

      if (!orgId && enq.callingOnBehalfOf.trim()) {
        const createdOrg = await saveOrganisationRecord(
          {
            legalName: enq.callingOnBehalfOf.trim(),
            generalEmail: enq.email,
            mainPhone: enq.phone,
            registeredAddress: enq.address,
            correspondenceAddress: enq.address,
            relationshipPartnerId: enq.assignedToId || byId,
            relationshipTypeIds: [vid('organisation_relationship_type', 'Prospect')],
            relationshipStatusId: vid('relationship_status', 'Prospective'),
            originId: enq.sourceId,
            conflictStatusId: vid('conflict_status', outcomeLabel),
            conflictReference,
            reviewDate: today,
            reviewerId: byId,
          },
          { byId, internalSystemStep: 'enquiry_conversion' },
        );
        orgId = createdOrg.organisation.id;
        const orgRecord = await partyRepo.getOrganisationById<Organisation>(enqCtx, orgId);
        if (orgRecord) {
          orgRecord.conflictDecision = decisionSnapshot;
          await partyRepo.putOrganisation(enqCtx, orgRecord);
          writeAudit(store, {
            recordType: 'organisation',
            recordId: orgId,
            action: 'conflict-decision',
            field: 'Conflict check decision recorded on enquiry conversion',
            oldValue: null,
            newValue: conflictReference,
            byId,
            at: nowIso,
            snapshot: orgRecord.conflictDecision,
          });
        }
      }

      if (orgId) {
        enq.linkedOrganisationId = orgId;
        clientId = orgId;
        const personLinks = await partyRepo.listLinksForPerson<PersonOrganisationLink>(
          enqCtx,
          personId,
        );
        const hasLink = personLinks.some(
          (l) => l.organisationId === orgId && l.isCurrent,
        );
        if (!hasLink) {
          await createOrUpdateLink(
            {
              personId,
              organisationId: orgId,
              jobTitle: '',
              department: '',
              roleWithinOrganisation: 'Instructing contact',
              contactRoleIds: [vid('contact_role', 'Key relationship contact')],
              isPrimaryContact: true,
              isCurrent: true,
              startDate: today,
              endDate: null,
              contactStatusId: vid('contact_status', 'Active'),
            },
            byId,
            { internalSystemStep: true },
          );
        }
      }
    }

    await intakeRepo.putEnquiry(enqCtx, enq);
    await flushStagedAuditEntries(enqCtx);
    return {
      ok: true,
      clientId,
      instructingContactId,
      enquiryId: enq.id,
      ...(conflictWarnings.length > 0 ? { conflictWarnings } : {}),
    };
  });
  });
}

/**
 * Step 4 & 5 of Converting an enquiry to a matter (called inside saveMatterRecord when sourceEnquiryId is set):
 * - Marks the enquiry Converted and sets convertedMatterId.
 * - Completes the open contact task.
 * - Raises the automatic "Complete matter opening" task assigned to the matter lead fee earner (5 working days).
 */
async function finalizeEnquiryConversionToMatter(
  store: FirmStore,
  enquiryId: string,
  matter: Matter,
  byId: string,
  now: string,
  ctx: TenantContext,
): Promise<void> {
  const intakeRepo = getIntakeQuoteRepository();
  const taskRepo = getTaskWorkflowRepository();
  const enq = await intakeRepo.getEnquiryById<Enquiry>(ctx, enquiryId, {
    includeRestricted: true,
  });
  if (!enq) return;

  const alreadyConvertedToThisMatter =
    enq.status === 'Converted' && enq.convertedMatterId === matter.id;
  const prevStatus = enq.status;
  enq.status = 'Converted';
  enq.convertedMatterId = matter.id;
  if (!enq.assignedToId) enq.assignedToId = matter.leadFeeEarnerId || byId;
  enq.updatedAt = now;
  enq.updatedById = byId;
  if (enq.conflictDecision && !matter.conflictDecision) {
    matter.conflictDecision = enq.conflictDecision;
  }
  await intakeRepo.putEnquiry(ctx, enq);

  if (!alreadyConvertedToThisMatter) {
    writeAudit(store, {
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'convert',
      field: 'Converted to matter',
      oldValue: prevStatus,
      newValue: `${matter.matterNumber} — ${matter.title} (${matter.id})`,
      byId,
      at: now,
    });

    writeAudit(store, {
      recordType: 'matter',
      recordId: matter.id,
      action: 'convert',
      field: 'Created from enquiry',
      oldValue: null,
      newValue: `${enq.reference} — ${enquiryDisplayName(enq)}`,
      byId,
      at: now,
    });
  }

  await completeOpenContactTasksForEnquiry(
    ctx,
    store,
    enq.id,
    `Enquiry converted to matter ${matter.matterNumber}`,
    byId,
    now,
  );

  // Carry enquiry key dates across to the converted matter in PostgreSQL (`source: 'carried_from_enquiry'`) (§1, S0-15)
  const kdConfig = await getKeyDatesConfig({ ctx });
  const existingTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
  if (kdConfig.enabled) {
    const keyDateRepo = getKeyDateRepository();
    const [existingEnquiryKds, teams] = await Promise.all([
      keyDateRepo.listKeyDatesForEnquiry(ctx, enq.id),
      getHrAndRbacRepository().listAllTeams<Team>(ctx),
    ]);
    const workingKeyDates = existingEnquiryKds.map((kd) => structuredClone(kd));
    const preAllocatedNewKdId =
      existingEnquiryKds.length === 0 && enq.keyDate
        ? await keyDateRepo.allocateNextKeyDateId(ctx)
        : null;
    const carriedAudits: AuditEntry[] = [];
    const workingTasks = existingTasks.map((t) => structuredClone(t));
    const prevTaskById = new Map(existingTasks.map((t) => [t.id, structuredClone(t)]));

    const carried = carryEnquiryKeyDatesToMatter({
      enquiry: enq,
      matter,
      tenantId: ctx.tenantId,
      keyDates: workingKeyDates,
      tasks: workingTasks,
      teams,
      config: kdConfig,
      actorId: byId,
      nowIso: now,
      nextKeyDateId: () => preAllocatedNewKdId ?? `KD-${randomUUID().slice(0, 8)}`,
      audit: carriedAudits,
      nextAuditId: () => 'AU-PENDING',
    });

    for (const wt of workingTasks) {
      const prev = prevTaskById.get(wt.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(wt)) {
        await taskRepo.putTask(ctx, wt);
      }
    }

    for (const entry of carriedAudits) {
      const { id: _unusedId, ...rest } = entry;
      void _unusedId;
      writeAudit(store, rest);
    }

    for (const carriedKd of carried) {
      await keyDateRepo.putKeyDate(ctx, carriedKd);
    }
  }

  // Automatic task: Complete matter opening (5 working days) once the matter has a real reference (or if none exists yet)
  const hasCompleteOpeningTask = existingTasks.some(
    (t) =>
      t.autoTrigger === 'complete_matter_opening' &&
      t.linkedRecords.some((lr) => lr.recordType === 'matter' && lr.recordId === matter.id),
  );
  if (!hasCompleteOpeningTask && matter.matterNumber !== 'DRAFT') {
    const whCfg = workingHoursConfigFromStore(store);
    const tpl = store.taskSettings.templates.find((t) => t.trigger === 'complete_matter_opening');
    const offsetDays = tpl?.dueWorkingDaysOffset ?? 5;
    const dueDate = toIsoDate(addWorkingDays(new Date(), offsetDays, whCfg));

    await raiseAutomaticTask(
      ctx,
      store,
      'complete_matter_opening',
      {
        name: enquiryDisplayName(enq),
        matterNumber: `${matter.matterNumber} (${enquiryDisplayName(enq)})`,
      },
      {
        dueAt: dueDate,
        assignedTeamId: enq.assignedTeamId,
        assignedPersonId: matter.leadFeeEarnerId || enq.assignedToId || byId,
        linkedRecords: [
          { recordType: 'matter', recordId: matter.id },
          { recordType: 'enquiry', recordId: enq.id },
          ...(matter.clientId.startsWith('P-')
            ? [{ recordType: 'person' as const, recordId: matter.clientId }]
            : [{ recordType: 'organisation' as const, recordId: matter.clientId }]),
        ],
        description: `Complete client due diligence (AML), issue engagement letter and confirm retainer monies on account for ${matter.matterNumber} (created from ${enq.reference}).`,
        byId,
        now,
        overridePriorityId: vid('task_priority', 'High'),
      },
    );
  }
}

/** Anonymise unconverted closed enquiries past the firm's retention period (or a specific enquiry). */
export async function anonymiseExpiredEnquiries(byId: string, specificEnquiryId?: string): Promise<number> {
  return runWithAuditStagingScope(async () => {
  const enqCtx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, enquiries, teams] = await Promise.all([
    loadTenantCatalogueStoreView(enqCtx),
    getPartyRepository().listAllPeople<Person>(enqCtx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(enqCtx),
    getHrAndRbacRepository().listAllTeams<Team>(enqCtx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
  });
  requirePermission(permSet, 'enquiry:anonymise');
  const now = new Date();
  const nowIso = now.toISOString();
  const months = store.enquirySettings.retentionMonths || 12;
  let count = 0;

  await intakeRepo.withTenantTransaction(enqCtx, async () => {
    for (const enq of enquiries) {
      const matchTarget = specificEnquiryId
        ? enq.id === specificEnquiryId && isReadyForRetentionAnonymisation(enq, months, now)
        : isReadyForRetentionAnonymisation(enq, months, now);
      if (!matchTarget || enq.anonymisedAt) continue;

      enq.firstName = 'Anonymised';
      enq.lastName = 'Enquirer';
      enq.callingOnBehalfOf = '';
      enq.email = '';
      enq.phone = '';
      enq.address = null;
      enq.otherPartiesNamed = '';
      enq.notes = '[Personal details removed under the firm data retention policy. Practice area, channel, dates and outcome retained for reporting.]';
      enq.anonymisedAt = nowIso;
      enq.updatedAt = nowIso;
      enq.updatedById = byId;
      count++;
      await intakeRepo.putEnquiry(enqCtx, enq);

      writeAudit(store, {
        recordType: 'enquiry',
        recordId: enq.id,
        action: 'update',
        field: 'Privacy retention anonymisation',
        oldValue: 'Personal details stored',
        newValue: 'Personal details removed; practice area, channel, dates and outcome kept',
        byId,
        at: nowIso,
      });
    }
    await flushStagedAuditEntries(enqCtx);
  });

  return count;
  });
}

// ============================================================================
// PMS Financial Data & Matching Services
// ============================================================================

export interface PmsGroupCompanyRow {
  organisationId: string;
  organisationName: string;
  isParent: boolean;
  pmsClientCode: string | null;
  financials: PmsClientFinancials | null;
}

export interface PmsGroupFinancials {
  parentOrganisationId: string;
  parentOrganisationName: string;
  companies: PmsGroupCompanyRow[];
  totals: {
    unbilled_wip: number;
    fees_billed: number;
    total_invoiced_inc_vat: number;
    total_paid: number;
    outstanding_debt: number;
    aged_not_yet_due: number;
    aged_1_30: number;
    aged_31_60: number;
    aged_61_90: number;
    aged_90_plus: number;
    client_account_balance: number;
    credit_limit: number;
    credit_limit_used_pct: number | null;
  };
}

export interface ClientPmsViewBundle {
  extractInfo: PmsExtractInfo;
  link: PmsLink | null;
  clientBundle: PmsClientFullBundle | null;
  pmsClient: PmsClient | null;
  oneSquaredMatterIdByPmsCode: Record<string, string>;
  groupView: PmsGroupFinancials | null;
}

export interface MatterPmsViewBundle {
  extractInfo: PmsExtractInfo;
  link: PmsLink | null;
  matterBundle: PmsMatterFullBundle | null;
  unlinkedPmsMattersForClient: PmsMatter[];
  allUnlinkedPmsMatters: PmsMatter[];
}

export async function getMatterPmsViewBundle(
  matterId: string,
  byId?: FinanceActorInput,
): Promise<MatterPmsViewBundle | ActionDenied> {
  const auth = await verifyFinanceActorAndPermission(byId, 'finance:view_matter');
  if (!auth.ok) return auth;

  const { ctx, actor, permSet, tokenRoles, visiblePmsLinks, tenantPmsLinks, people, matters, teams } = auth;
  const matter = matters.find((m) => m.id === matterId && !m.mergedIntoId);
  if (
    !matter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: people,
      teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const pms = await getTenantPmsSource(ctx);
  const extractInfo = pms.getExtractInfo();
  const link =
    visiblePmsLinks.find((l) => l.entityType === 'matter' && l.onesquaredId === matterId) ?? null;

  const canManageLinks = permSet.permissions.has('finance:manage_links');
  let allUnlinkedPmsMatters: PmsMatter[] = [];
  let unlinkedPmsMattersForClient: PmsMatter[] = [];

  if (canManageLinks) {
    const linkedPmsCodes = new Set(
      tenantPmsLinks.filter((l) => l.entityType === 'matter').map((l) => l.pmsCode),
    );
    const allPmsMatters = pms.listMatters();
    allUnlinkedPmsMatters = allPmsMatters.filter((pm) => !linkedPmsCodes.has(pm.matter_code));

    const clientEntityType: PmsEntityType = matter.clientId.startsWith('P-')
      ? 'person'
      : 'organisation';
    const pmsClientCode = findPmsCodeForRecord(visiblePmsLinks, clientEntityType, matter.clientId);
    if (pmsClientCode) {
      unlinkedPmsMattersForClient = allUnlinkedPmsMatters.filter(
        (pm) => pm.client_code === pmsClientCode,
      );
    }
  }

  if (!isValidPmsAsAtDate(extractInfo.asAtDate)) {
    return {
      extractInfo: {
        asAtDate: '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
        importedAt: extractInfo.importedAt,
      },
      link,
      matterBundle: null,
      unlinkedPmsMattersForClient,
      allUnlinkedPmsMatters,
    };
  }

  const matterBundle = link ? pms.getMatterFullBundle(link.pmsCode) : null;

  return {
    extractInfo,
    link,
    matterBundle,
    unlinkedPmsMattersForClient,
    allUnlinkedPmsMatters,
  };
}

export async function getClientPmsViewBundle(
  recordType: 'organisation' | 'person',
  recordId: string,
  byId?: FinanceActorInput,
): Promise<ClientPmsViewBundle | ActionDenied> {
  const auth = await verifyFinanceActorAndPermission(byId, 'finance:view_matter');
  if (!auth.ok) return auth;

  const { hiddenMatterIds, accessibleLinkedPmsMatterCodes, visiblePmsLinks, people, ctx } = auth;
  const organisations =
    recordType === 'organisation'
      ? await getPartyRepository().listAllOrganisations<Organisation>(ctx)
      : [];
  const targetExists =
    recordType === 'organisation'
      ? organisations.some((o) => o.id === recordId && !o.mergedIntoId)
      : people.some((p) => p.id === recordId && !p.mergedIntoId);
  if (!targetExists) {
    return buildActionDenied(
      'FORBIDDEN',
      'Client record not found or access denied.',
    );
  }

  const pms = await getTenantPmsSource(ctx);
  const extractInfo = pms.getExtractInfo();
  const link =
    visiblePmsLinks.find((l) => l.entityType === recordType && l.onesquaredId === recordId) ?? null;

  const oneSquaredMatterIdByPmsCode: Record<string, string> = {};
  for (const l of visiblePmsLinks) {
    if (l.entityType === 'matter' && !hiddenMatterIds.has(l.onesquaredId)) {
      oneSquaredMatterIdByPmsCode[l.pmsCode] = l.onesquaredId;
    }
  }

  if (!isValidPmsAsAtDate(extractInfo.asAtDate)) {
    return {
      extractInfo: {
        asAtDate: '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
        importedAt: extractInfo.importedAt,
      },
      link,
      clientBundle: null,
      pmsClient: null,
      oneSquaredMatterIdByPmsCode,
      groupView: null,
    };
  }

  const allPmsClients = pms.listClients();
  const visibleMatterFins = pms
    .getAllMatterFinancials()
    .filter((m) => accessibleLinkedPmsMatterCodes.has(m.matter_code));
  const visibleInvoices = pms
    .listAllInvoiceBalances()
    .filter((i) => accessibleLinkedPmsMatterCodes.has(i.matter_code));
  const visibleAgedDebt = pms
    .getAgedDebt()
    .filter((i) => accessibleLinkedPmsMatterCodes.has(i.matter_code));

  const pmsClient = link
    ? allPmsClients.find((c) => c.client_code === link.pmsCode) ?? null
    : null;

  const clientBundle: PmsClientFullBundle | null =
    link && pmsClient
      ? {
          extractInfo,
          summary: buildClientFinancialsFromRows(
            pmsClient,
            visibleMatterFins,
            visibleInvoices,
            extractInfo.asAtDate,
          ),
          matters: visibleMatterFins.filter((m) => m.client_code === link.pmsCode),
          invoices: visibleAgedDebt.filter((i) => i.client_code === link.pmsCode),
        }
      : null;

  let groupView: PmsGroupFinancials | null = null;
  if (recordType === 'organisation') {
    const org = organisations.find((o) => o.id === recordId);
    if (org) {
      const subsidiaries = organisations.filter(
        (o) => !o.mergedIntoId && o.parentOrganisationId === org.id,
      );
      if (subsidiaries.length > 0) {
        const groupOrgs = [org, ...subsidiaries];
        const companies: PmsGroupCompanyRow[] = groupOrgs.map((go) => {
          const code = findPmsCodeForRecord(visiblePmsLinks, 'organisation', go.id);
          const companyClient = code
            ? allPmsClients.find((c) => c.client_code === code) ?? null
            : null;
          const fin = companyClient
            ? buildClientFinancialsFromRows(
                companyClient,
                visibleMatterFins,
                visibleInvoices,
                extractInfo.asAtDate,
              )
            : null;
          return {
            organisationId: go.id,
            organisationName: go.legalName,
            isParent: go.id === org.id,
            pmsClientCode: code,
            financials: fin,
          };
        });

        const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
        const sumField = (fn: (f: PmsClientFinancials) => number) =>
          round2(companies.reduce((acc, c) => acc + (c.financials ? fn(c.financials) : 0), 0));

        const outstanding_debt = sumField((f) => f.outstanding_debt);
        const credit_limit = sumField((f) => f.credit_limit);

        groupView = {
          parentOrganisationId: org.id,
          parentOrganisationName: org.legalName,
          companies,
          totals: {
            unbilled_wip: sumField((f) => f.unbilled_wip),
            fees_billed: sumField((f) => f.fees_billed),
            total_invoiced_inc_vat: sumField((f) => f.total_invoiced_inc_vat),
            total_paid: sumField((f) => f.total_paid),
            outstanding_debt,
            aged_not_yet_due: sumField((f) => f.aged_not_yet_due),
            aged_1_30: sumField((f) => f.aged_1_30),
            aged_31_60: sumField((f) => f.aged_31_60),
            aged_61_90: sumField((f) => f.aged_61_90),
            aged_90_plus: sumField((f) => f.aged_90_plus),
            client_account_balance: sumField((f) => f.client_account_balance),
            credit_limit,
            credit_limit_used_pct: credit_limit > 0 ? outstanding_debt / credit_limit : null,
          },
        };
      }
    }
  }

  return {
    extractInfo,
    link,
    clientBundle,
    pmsClient,
    oneSquaredMatterIdByPmsCode,
    groupView,
  };
}

export interface PmsAdminSnapshot {
  extractInfo: PmsExtractInfo;
  pmsLinks: PmsLink[];
  pmsFeeEarners: PmsFeeEarner[];
  pmsClients: PmsClient[];
  pmsMatters: PmsMatter[];
  suggestedMatterMatches: PmsSuggestedMatch[];
}

export async function getPmsAdminSnapshot(byId?: FinanceActorInput): Promise<PmsAdminSnapshot> {
  const actorId = isTenantContextInput(byId)
    ? byId.actorId
    : typeof byId === 'string'
      ? byId
      : byId && 'personId' in byId
        ? byId.personId
        : getActiveActorSession()?.personId;
  const ctx = isTenantContextInput(byId)
    ? byId
    : resolveDefaultServiceTenantContext(null, actorId);
  const store = await loadTenantCatalogueStoreView(ctx, { includePmsLinks: true });
  const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;
  if (isCleanEmpty) {
    const nowIso = new Date().toISOString();
    return {
      extractInfo: {
        asAtDate: '',
        sourceFile: 'No PMS linked (Clean Client Deployment)',
        importedAt: nowIso,
      },
      pmsLinks: [],
      pmsFeeEarners: [],
      pmsClients: [],
      pmsMatters: [],
      suggestedMatterMatches: [],
    };
  }
  const [people, matters, teams, pms] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    getTenantPmsSource(ctx),
  ]);
  const actor = actorId ? people.find((p) => p.id === actorId) ?? null : null;
  const visibleMatters = actorId
    ? matters.filter((m) =>
        canPersonAccessMatter(m, actorId, actor, {
          allPeople: people,
          teams,
        }),
      )
    : matters;
  const visibleMatterIdSet = new Set(visibleMatters.map((m) => m.id));
  const hiddenPmsCodes = new Set(
    store.pmsLinks
      .filter((l) => l.entityType === 'matter' && !visibleMatterIdSet.has(l.onesquaredId))
      .map((l) => l.pmsCode),
  );
  const visiblePmsLinks = store.pmsLinks.filter(
    (l) => !(l.entityType === 'matter' && !visibleMatterIdSet.has(l.onesquaredId)),
  );
  const extractInfo = pms.getExtractInfo();
  const pmsFeeEarners = pms.listFeeEarners();
  const pmsClients = pms.listClients();
  const pmsMatters = pms.listMatters().filter((pm) => !hiddenPmsCodes.has(pm.matter_code));
  const suggestedMatterMatches = suggestMatterMatches(
    visiblePmsLinks,
    visibleMatters,
    pmsMatters,
    store.values,
  );
  return {
    extractInfo,
    pmsLinks: visiblePmsLinks,
    pmsFeeEarners,
    pmsClients,
    pmsMatters,
    suggestedMatterMatches,
  };
}

export async function linkPmsRecord(
  entityType: PmsEntityType,
  onesquaredId: string,
  pmsCode: string,
  byId: string,
  options?: { tenantCtx?: TenantContext | null },
): Promise<PmsLink> {
  const ctx = resolveDefaultServiceTenantContext(null, byId, options);
  const pmsRepo = getPmsRepository();
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  let link!: PmsLink;
  await runWithAuditStagingScope(() =>
    pmsRepo.withTenantTransaction(ctx, async () => {
      const recordExists =
        entityType === 'employee'
          ? Boolean(
              (await partyRepo.getPersonById<Person>(ctx, onesquaredId))
                ?.isEmployee,
            )
          : entityType === 'person'
            ? Boolean(await partyRepo.getPersonById<Person>(ctx, onesquaredId))
            : entityType === 'organisation'
              ? Boolean(await partyRepo.getOrganisationById(ctx, onesquaredId))
              : Boolean(
                  await matterRepo.getMatterById(ctx, onesquaredId, {
                    includeRestricted: true,
                  }),
                );
      if (!recordExists) {
        throw Object.assign(
          new Error(`NOT_FOUND: Target ${entityType} "${onesquaredId}" not found.`),
          { code: 'NOT_FOUND' as const },
        );
      }

      const now = new Date().toISOString();
      const id = await pmsRepo.allocatePmsLinkId(ctx);
      link = {
        id,
        entityType,
        onesquaredId,
        pmsCode,
        matchedBy: 'manual',
        matchedAt: now,
      };
      await pmsRepo.putPmsLink(ctx, link);

      const auditRecordType =
        entityType === 'employee'
          ? 'person'
          : entityType === 'matter'
            ? 'matter'
            : entityType;
      writeAudit(null, {
        recordType: auditRecordType,
        recordId: onesquaredId,
        action: 'link',
        field: 'PMS link',
        oldValue: null,
        newValue: `${pmsCode} (manual)`,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return link;
}

export async function unlinkPmsRecord(
  linkId: string,
  byId: string,
  options?: { tenantCtx?: TenantContext | null },
): Promise<void> {
  const ctx = resolveDefaultServiceTenantContext(null, byId, options);
  const pmsRepo = getPmsRepository();
  await runWithAuditStagingScope(() =>
    pmsRepo.withTenantTransaction(ctx, async () => {
      const existing = await pmsRepo.getPmsLinkById<PmsLink>(ctx, linkId);
      if (!existing) {
        throw Object.assign(
          new Error(`NOT_FOUND: PMS link "${linkId}" not found.`),
          { code: 'NOT_FOUND' as const },
        );
      }
      await pmsRepo.deletePmsLinkById(ctx, linkId);

      const auditRecordType =
        existing.entityType === 'employee'
          ? 'person'
          : existing.entityType === 'matter'
            ? 'matter'
            : existing.entityType;
      writeAudit(null, {
        recordType: auditRecordType,
        recordId: existing.onesquaredId,
        action: 'unlink',
        field: 'PMS link',
        oldValue: existing.pmsCode,
        newValue: null,
        byId,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
}

export async function rerunAutomaticPmsMatching(
  byId: string,
  options?: { tenantCtx?: TenantContext | null },
): Promise<{ totalLinks: number }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId, options);
  const pmsRepo = getPmsRepository();
  let totalLinks = 0;
  await pmsRepo.withTenantTransaction(ctx, async () => {
    const [existingLinks, people, organisations, matters, pms] = await Promise.all([
      pmsRepo.listPmsLinks<PmsLink>(ctx),
      getPartyRepository().listAllPeople<Person>(ctx),
      getPartyRepository().listAllOrganisations<Organisation>(ctx),
      getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
      getTenantPmsSource(ctx),
    ]);
    const now = new Date().toISOString();
    const nextLinks = computeAutomaticPmsLinks(
      existingLinks,
      organisations,
      people,
      matters,
      pms.listClients(),
      pms.listFeeEarners(),
      pms.listMatters(),
      now,
      false,
    );
    void byId;
    await pmsRepo.putPmsLinks(ctx, nextLinks, { replaceAll: true });
    totalLinks = nextLinks.length;
  });
  return { totalLinks };
}

function mapPmsPracticeAreaId(store: FirmStore, pmsPracticeArea: string): string {
  const norm = pmsPracticeArea.trim().toLowerCase();
  const paValues = store.values.filter((v) => v.listKey === 'work_type' && !v.parentId);
  const exact = paValues.find((v) => v.label.toLowerCase() === norm);
  if (exact) return exact.id;
  if (norm.includes('corporate')) return vid('work_type', 'Corporate and commercial');
  if (norm.includes('property')) return vid('work_type', 'Real estate and property');
  if (norm.includes('employment')) return vid('work_type', 'Employment and HR');
  if (norm.includes('dispute') || norm.includes('litigation'))
    return vid('work_type', 'Dispute resolution and litigation');
  if (norm.includes('private') || norm.includes('probate') || norm.includes('estate'))
    return vid('work_type', 'Private client');
  if (norm.includes('family')) return vid('work_type', 'Family');
  return paValues[0]?.id ?? vid('work_type', 'Corporate and commercial');
}

function mapPmsWorkTypeSubcategoryId(
  store: FirmStore,
  practiceAreaId: string,
  pmsWorkType: string,
): string {
  const norm = pmsWorkType.trim().toLowerCase();
  const subValues = store.values.filter(
    (v) => v.listKey === 'work_type' && v.parentId === practiceAreaId,
  );
  const exact = subValues.find((v) => v.label.toLowerCase() === norm);
  if (exact) return exact.id;
  const partial = subValues.find(
    (v) => norm.includes(v.label.toLowerCase()) || v.label.toLowerCase().includes(norm),
  );
  if (partial) return partial.id;
  return subValues[0]?.id ?? vid('work_type', 'Commercial contracts');
}

function mapPmsEmployeeRoleId(store: FirmStore, grade: string): string {
  const g = grade.toLowerCase();
  if (g.includes('partner')) return vid('employee_role', 'Partner');
  if (g.includes('senior')) return vid('employee_role', 'Senior Associate');
  if (g.includes('associate') || g.includes('solicitor')) return vid('employee_role', 'Solicitor');
  if (g.includes('trainee')) return vid('employee_role', 'Trainee Solicitor');
  if (g.includes('paralegal')) return vid('employee_role', 'Paralegal');
  const roles = store.values.filter((v) => v.listKey === 'employee_role');
  return roles[0]?.id ?? vid('employee_role', 'Solicitor');
}

export async function createRecordFromPms(
  entityType: PmsEntityType,
  pmsCode: string,
  byId: string,
  opts: { mfaVerified: boolean; tenantCtx?: TenantContext | null },
): Promise<{ ok: boolean; createdId?: string; error?: string } & Partial<Omit<ActionDenied, 'ok'>>> {
  const ctx = resolveDefaultServiceTenantContext(null, byId, {
    tenantCtx: opts?.tenantCtx,
  });
  const [store, people, teams, pms] = await Promise.all([
    loadTenantCatalogueStoreView(ctx, { includePmsLinks: true }),
    getPartyRepository().listAllPeople<Person>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    getTenantPmsSource(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const effectiveMfaVerified = opts.mfaVerified === true;
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
    mfaVerified: effectiveMfaVerified,
  });

  if (!actorPerms.permissions.has('admin:access')) {
    const msg =
      'FORBIDDEN: Permission "admin:access" is required to create records from PMS.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
    };
  }
  if (actorPerms.mfaPendingPermissions.has('admin:access')) {
    const msg =
      'MFA_REQUIRED: Multi-factor authentication (MFA) is required for administrative permission "admin:access".';
    return {
      ...buildActionDenied('MFA_REQUIRED', msg),
      ok: false,
      error: msg,
    };
  }

  if (entityType === 'employee' && !actorPerms.permissions.has('employee:edit_core')) {
    const msg =
      'FORBIDDEN: Permission "employee:edit_core" is required to create an employee record from PMS.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
    };
  }
  if (
    (entityType === 'organisation' || entityType === 'person') &&
    !actorPerms.permissions.has('contact:create')
  ) {
    const msg =
      'FORBIDDEN: Permission "contact:create" is required to create a client or contact record from PMS.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
    };
  }
  if (entityType === 'matter' && !actorPerms.permissions.has('matter:create')) {
    const msg =
      'FORBIDDEN: Permission "matter:create" is required to create a matter record from PMS.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
    };
  }

  const alreadyLinked = findOneSquaredIdForPmsCode(store.pmsLinks, entityType, pmsCode);
  if (alreadyLinked) {
    return { ok: true, createdId: alreadyLinked };
  }

  if (entityType === 'employee') {
    const fe = pms.listFeeEarners().find((f) => f.fee_earner_id === pmsCode);
    if (!fe) return { ok: false, error: `PMS fee earner ${pmsCode} not found.` };

    const paId = mapPmsPracticeAreaId(store, fe.department);

    const res = await savePersonRecord(
      {
        firstName: fe.first_name,
        surname: fe.last_name,
        isEmployee: true,
        employeeRoleId: mapPmsEmployeeRoleId(store, fe.grade),
        departmentId: paId,
        jobTitle: fe.grade,
        emails: [
          {
            id: `EM-${Date.now()}`,
            address: fe.email,
            typeId: vid('email_type', 'Work'),
            isPrimary: true,
          },
        ],
        recordStatusId: valueBySystemKey(store.values, 'person_record_status', 'active')!.id,
      },
      { byId, mfaVerified: actorPerms.mfaVerified },
    );
    if (isActionDenied(res)) {
      return {
        ...buildActionDenied(res.code, res.message),
        ok: false,
        error: res.message,
      };
    }
    if (res.errors) return { ok: false, error: Object.values(res.errors).join(' ') };

    await linkPmsRecord('employee', res.person.id, pmsCode, byId, { tenantCtx: ctx });
    return { ok: true, createdId: res.person.id };
  }

  if (entityType === 'organisation') {
    const client = pms
      .listClients()
      .find((c) => c.client_code === pmsCode && c.client_type === 'Organisation');
    if (!client) return { ok: false, error: `PMS organisation client ${pmsCode} not found.` };

    const partner1SqId =
      (client.client_partner_id
        ? findOneSquaredIdForPmsCode(store.pmsLinks, 'employee', client.client_partner_id)
        : null) ?? byId;

    const res = await saveOrganisationRecord(
      {
        legalName: client.client_name,
        organisationTypeId: vid('organisation_type', 'Private Limited Company (Ltd)'),
        relationshipStatusId: vid('relationship_status', 'Active'),
        companyNumber: client.company_number ?? '',
        generalEmail: client.email ?? '',
        mainPhone: client.phone ?? '',
        billingAddress: client.billing_address
          ? {
              id: `AD-${Date.now()}`,
              typeId: vid('address_type', 'Billing'),
              line1: client.billing_address,
              line2: '',
              town: 'Cardiff',
              county: '',
              postcode: client.postcode ?? '',
              countryId: vid('country', 'United Kingdom'),
            }
          : null,
        relationshipPartnerId: partner1SqId,
      },
      { byId },
    );
    if (res.errors) return { ok: false, error: Object.values(res.errors).join(' ') };

    await linkPmsRecord('organisation', res.organisation.id, pmsCode, byId, { tenantCtx: ctx });
    return { ok: true, createdId: res.organisation.id };
  }

  if (entityType === 'person') {
    const client = pms
      .listClients()
      .find((c) => c.client_code === pmsCode && c.client_type === 'Individual');
    if (!client) return { ok: false, error: `PMS individual client ${pmsCode} not found.` };

    const parts = client.client_name.trim().split(/\s+/);
    const firstName = parts[0] ?? client.client_name;
    const surname = parts.slice(1).join(' ') || 'Client';
    const partner1SqId =
      (client.client_partner_id
        ? findOneSquaredIdForPmsCode(store.pmsLinks, 'employee', client.client_partner_id)
        : null) ?? byId;

    const res = await savePersonRecord(
      {
        firstName,
        surname,
        isEmployee: false,
        relationshipRoleIds: [vid('person_relationship_role', 'Client (individual)')],
        emails: client.email
          ? [
              {
                id: `EM-${Date.now()}`,
                address: client.email,
                typeId: vid('email_type', 'Personal'),
                isPrimary: true,
              },
            ]
          : [],
        phones: client.phone
          ? [
              {
                id: `PH-${Date.now()}`,
                number: client.phone,
                typeId: vid('phone_type', 'Mobile'),
              },
            ]
          : [],
        addresses: client.billing_address
          ? [
              {
                id: `AD-${Date.now()}`,
                typeId: vid('address_type', 'Home'),
                line1: client.billing_address,
                line2: '',
                town: 'Cardiff',
                county: '',
                postcode: client.postcode ?? '',
                countryId: vid('country', 'United Kingdom'),
              },
            ]
          : [],
        relationshipOwnerId: partner1SqId,
      },
      { byId },
    );
    if (res.errors) return { ok: false, error: Object.values(res.errors).join(' ') };

    await linkPmsRecord('person', res.person.id, pmsCode, byId, { tenantCtx: ctx });
    return { ok: true, createdId: res.person.id };
  }

  if (entityType === 'matter') {
    const pm = pms.listMatters().find((m) => m.matter_code === pmsCode);
    if (!pm) return { ok: false, error: `PMS matter ${pmsCode} not found.` };

    // Ensure the client exists & is linked in 1Squared first
    const pmsClient = pms.listClients().find((c) => c.client_code === pm.client_code);
    const clientEntityType: PmsEntityType =
      pmsClient?.client_type === 'Individual' ? 'person' : 'organisation';
    let clientId = findOneSquaredIdForPmsCode(store.pmsLinks, clientEntityType, pm.client_code);
    if (!clientId) {
      const createdClient = await createRecordFromPms(clientEntityType, pm.client_code, byId, opts);
      if (!createdClient.ok || !createdClient.createdId) {
        return {
          ok: false,
          error: createdClient.error ?? `Could not find or create client ${pm.client_code}.`,
        };
      }
      clientId = createdClient.createdId;
    }

    // Ensure partner & lead fee earner exist or fallback cleanly (only creating employees if actor holds employee:edit_core)
    let partnerId = findOneSquaredIdForPmsCode(
      store.pmsLinks,
      'employee',
      pm.responsible_partner_id,
    );
    if (!partnerId && actorPerms.permissions.has('employee:edit_core')) {
      const createdFe = await createRecordFromPms('employee', pm.responsible_partner_id, byId, opts);
      partnerId = createdFe.createdId ?? byId;
    }
    if (!partnerId) {
      partnerId = byId;
    }

    let leadId = findOneSquaredIdForPmsCode(store.pmsLinks, 'employee', pm.fee_earner_id);
    if (!leadId && actorPerms.permissions.has('employee:edit_core')) {
      const createdLead = await createRecordFromPms('employee', pm.fee_earner_id, byId, opts);
      leadId = createdLead.createdId ?? partnerId;
    }
    if (!leadId) {
      leadId = partnerId;
    }

    const paId = mapPmsPracticeAreaId(store, pm.practice_area);
    const subId = mapPmsWorkTypeSubcategoryId(store, paId, pm.work_type);

    const statusKey =
      pm.status === 'Closed' ? 'closed' : pm.status === 'Pending' ? 'on_hold' : 'active';
    const matterStatusId =
      valueBySystemKey(store.values, 'matter_status', statusKey)?.id ??
      vid('matter_status', 'Active');

    const res = await saveMatterRecord(
      {
        matterNumber: pm.matter_code,
        title: pm.matter_description,
        clientId,
        practiceAreaId: paId,
        workTypeSubcategoryId: subId,
        matterStatusId,
        openedAt: pm.date_opened,
        closedAt: pm.date_closed,
        responsiblePartnerId: partnerId,
        leadFeeEarnerId: leadId,
        teamMemberIds: Array.from(new Set([partnerId, leadId])),
        shortDescription: `${pm.work_type} (${pm.billing_basis}) — imported from PMS (${pm.matter_code}).`,
      },
      { byId, source: 'pms_import' },
    );
    if (res.errors || !res.matter) {
      return { ok: false, error: res.errors ? Object.values(res.errors).join(' ') : 'Matter could not be saved.' };
    }

    await linkPmsRecord('matter', res.matter.id, pmsCode, byId, { tenantCtx: ctx });
    return { ok: true, createdId: res.matter.id };
  }

  return { ok: false, error: 'Unsupported entity type.' };
}

// ------------------------------------------------------------------ Role-based Home Pages & Actions

export async function switchViewingRole(
  userId: string,
  roleKey: string,
): Promise<{ ok: boolean; error?: string; roleKey?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, userId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { ok: boolean; error?: string; roleKey?: string };
  await catalogueRepo.withTenantTransaction(ctx, async () => {
    const [store, user, teams] = await Promise.all([
      loadTenantCatalogueStoreView(ctx),
      getPartyRepository().getPersonById<Person>(ctx, userId),
      getHrAndRbacRepository().listAllTeams<Team>(ctx),
    ]);
    if (!user) {
      result = { ok: false, error: 'User not found.' };
      return;
    }

    const homePagesConfig =
      store.homePagesConfig ??
      createDefaultHomePagesConfig(
        new Date().toISOString(),
        getActiveTenantConfiguration().branding.primaryDomain,
      );

    const userRoles = resolveEmployeeRoles(user, teams);
    const isValidConfiguredRole = homePagesConfig.roles.some(
      (r) => r.key === roleKey,
    );
    if (
      !userRoles.includes(roleKey) &&
      !(canPreviewAnyHomeRole(userRoles) && isValidConfiguredRole)
    ) {
      result = { ok: false, error: 'Role is not assigned to the current user.' };
      return;
    }

    const nextConfig: HomePagesConfig = {
      ...homePagesConfig,
      lastViewingRoleByUserId: {
        ...(homePagesConfig.lastViewingRoleByUserId ?? {}),
        [userId]: roleKey,
      },
    };
    await catalogueRepo.putHomePagesConfig(ctx, nextConfig, userId);
    result = { ok: true, roleKey };
  });
  return result;
}

export async function saveHomePagesConfig(
  input: {
    roles?: RoleHomeConfig[];
    firmSettings?: Partial<HomeFirmSettings>;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string; config: HomePagesConfig }> {
  const nowIso = new Date().toISOString();
  const primaryDomain = getActiveTenantConfiguration().branding.primaryDomain;
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { ok: boolean; code?: string; error?: string; config: HomePagesConfig };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, people, teams] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getPartyRepository().listAllPeople<Person>(ctx),
        getHrAndRbacRepository().listAllTeams<Team>(ctx),
      ]);
      const current =
        store.homePagesConfig ?? createDefaultHomePagesConfig(nowIso, primaryDomain);
      const actor = people.find((p) => p.id === byId) ?? null;
      const actorPerms = resolvePersonPermissionSet(actor, {
        allPeople: people,
        teams,
        mfaVerified: options.mfaVerified ?? false,
      });
      try {
        requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
      } catch (err) {
        const code = err instanceof AuthorisationError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          code,
          error: code ? `${code}: ${message}` : message,
          config: {
            ...current,
            firmSettings: {
              ...current.firmSettings,
              demoMode: isDemoModeEnabled(),
            },
          },
        };
        return;
      }

      const nextRoles = input.roles
        ? input.roles.map((r) => ({
            ...r,
            headlineCardIds: (r.headlineCardIds ?? []).slice(0, 5),
            primaryPanels: Array.from(new Set(r.primaryPanels ?? [])),
            summaryPanels: Array.from(
              new Set(
                (r.summaryPanels ?? []).filter(
                  (p) => !(r.primaryPanels ?? []).includes(p),
                ),
              ),
            ),
          }))
        : current.roles;

      const sanitizedFirmSettings = { ...(input.firmSettings ?? {}) };
      delete sanitizedFirmSettings.demoMode;
      const nextSettings: HomeFirmSettings = {
        ...current.firmSettings,
        ...sanitizedFirmSettings,
        demoMode: isDemoModeEnabled(),
      };

      const nextConfig: HomePagesConfig = {
        ...current,
        roles: nextRoles,
        firmSettings: nextSettings,
        updatedAt: nowIso,
        updatedById: byId,
      };
      await catalogueRepo.putHomePagesConfig(ctx, nextConfig, byId);

      writeAudit(null, {
        recordType: 'system',
        recordId: 'HOME-CONFIG',
        action: 'update',
        field: 'Home pages configuration',
        oldValue: null,
        newValue: `Updated role Home layouts and firm settings (demoMode=${nextSettings.demoMode})`,
        byId,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
      result = { ok: true, config: nextConfig };
    }),
  );
  return result;
}

export async function resetHomePagesConfig(
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string; config: HomePagesConfig }> {
  const nowIso = new Date().toISOString();
  const primaryDomain = getActiveTenantConfiguration().branding.primaryDomain;
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { ok: boolean; code?: string; error?: string; config: HomePagesConfig };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, people, teams] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getPartyRepository().listAllPeople<Person>(ctx),
        getHrAndRbacRepository().listAllTeams<Team>(ctx),
      ]);
      const current =
        store.homePagesConfig ?? createDefaultHomePagesConfig(nowIso, primaryDomain);
      const actor = people.find((p) => p.id === byId) ?? null;
      const actorPerms = resolvePersonPermissionSet(actor, {
        allPeople: people,
        teams,
        mfaVerified: options.mfaVerified ?? false,
      });
      try {
        requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
      } catch (err) {
        const code = err instanceof AuthorisationError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          code,
          error: code ? `${code}: ${message}` : message,
          config: {
            ...current,
            firmSettings: {
              ...current.firmSettings,
              demoMode: isDemoModeEnabled(),
            },
          },
        };
        return;
      }

      const preservedViewing = store.homePagesConfig?.lastViewingRoleByUserId ?? {};
      const defaults = createDefaultHomePagesConfig(nowIso, primaryDomain);
      defaults.lastViewingRoleByUserId = preservedViewing;
      defaults.firmSettings.demoMode = isDemoModeEnabled();
      defaults.updatedById = byId;

      defaults.roles = syncHomeRolesWithEmployeeRoles(
        defaults.roles,
        store.values,
        createDefaultRoleConfigs(primaryDomain),
      );
      await catalogueRepo.putHomePagesConfig(ctx, defaults, byId);
      writeAudit(null, {
        recordType: 'system',
        recordId: 'HOME-CONFIG',
        action: 'update',
        field: 'Home pages configuration',
        oldValue: null,
        newValue: 'Reset role Home layouts to firm defaults',
        byId,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
      result = { ok: true, config: defaults };
    }),
  );
  return result;
}

export async function addHomeRole(
  input: {
    key?: string;
    label: string;
    shortLabel?: string;
    purpose: string;
    copyFromRoleKey?: string;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string; role?: RoleHomeConfig }> {
  const nowIso = new Date().toISOString();
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { ok: boolean; code?: string; error?: string; role?: RoleHomeConfig };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, people, teams] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getPartyRepository().listAllPeople<Person>(ctx),
        getHrAndRbacRepository().listAllTeams<Team>(ctx),
      ]);
      const actor = people.find((p) => p.id === byId) ?? null;
      const actorPerms = resolvePersonPermissionSet(actor, {
        allPeople: people,
        teams,
        mfaVerified: options.mfaVerified ?? false,
      });
      try {
        requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
      } catch (err) {
        const code = err instanceof AuthorisationError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          code,
          error: code ? `${code}: ${message}` : message,
        };
        return;
      }

      const homePagesConfig =
        store.homePagesConfig ??
        createDefaultHomePagesConfig(
          nowIso,
          getActiveTenantConfiguration().branding.primaryDomain,
        );
      const cleanLabel = input.label.trim();
      if (!cleanLabel) {
        result = { ok: false, error: 'Role name is required.' };
        return;
      }

      const key = (input.key || slug(cleanLabel)).replace(/[^a-z0-9_]+/g, '_');
      if (homePagesConfig.roles.some((r) => r.key === key)) {
        result = { ok: false, error: `Role "${key}" already exists.` };
        return;
      }

      const template =
        homePagesConfig.roles.find(
          (r) => r.key === (input.copyFromRoleKey || 'fee_earner'),
        ) ?? homePagesConfig.roles[0];

      const newRole: RoleHomeConfig = {
        key,
        label: cleanLabel,
        shortLabel: (input.shortLabel || cleanLabel).trim(),
        purpose: input.purpose.trim() || template.purpose,
        headlineCardIds: [...template.headlineCardIds],
        primaryPanels: [...template.primaryPanels],
        summaryPanels: [...template.summaryPanels],
        isBuiltIn: false,
      };

      const empRoleId = `employee_role.${key}`;
      newRole.employeeRoleId = empRoleId;
      if (!store.values.some((v) => v.id === empRoleId)) {
        const newEmpRoleVal: ChoiceValue = {
          id: empRoleId,
          listKey: 'employee_role',
          label: cleanLabel,
          description: newRole.purpose,
          parentId: null,
          sortOrder: nextSortOrder(store.values, 'employee_role'),
          active: true,
        };
        await catalogueRepo.putChoiceValue(ctx, newEmpRoleVal);
      }
      const nextHomePages: HomePagesConfig = {
        ...homePagesConfig,
        roles: [...homePagesConfig.roles, newRole],
        updatedAt: nowIso,
        updatedById: byId,
      };
      await catalogueRepo.putHomePagesConfig(ctx, nextHomePages, byId);

      writeAudit(null, {
        recordType: 'system',
        recordId: `ROLE-${key}`,
        action: 'create',
        field: 'Home role',
        oldValue: null,
        newValue: `${newRole.label} (${newRole.key})`,
        byId,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
      result = { ok: true, role: newRole };
    }),
  );
  return result;
}

export async function updateEmployeeRolesAndSupports(
  personId: string,
  input: {
    roles?: string[];
    supportsIds?: string[];
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const hrRepo = getHrAndRbacRepository();
  return partyRepo.withTenantTransaction(ctx, async () => {
    const [people, teams, dbRbacOverride] = await Promise.all([
      partyRepo.listAllPeople<Person>(ctx),
      hrRepo.listAllTeams<Team>(ctx),
      hrRepo.getRbacConfigOverride<RbacConfiguration>(ctx),
    ]);
    const actor = people.find((p) => p.id === byId);
    const person = people.find((p) => p.id === personId);
    if (!actor) return { ok: false, error: 'Acting user not found.' };
    if (!person) return { ok: false, error: 'Employee not found.' };

    const rbacConfig = await loadEffectiveTenantRbacConfig(ctx, dbRbacOverride);
    const actorPerms = resolvePersonPermissionSet(actor, {
      allPeople: people,
      teams,
      mfaVerified: options.mfaVerified ?? false,
      config: { rbac: rbacConfig },
    });

    const prevRoles = new Set<string>(person.roles ?? []);
    const nextRoles =
      input.roles !== undefined
        ? Array.from(new Set(input.roles))
        : Array.from(prevRoles);
    const addedRoleKeys = nextRoles.filter((rk) => !prevRoles.has(rk));

    try {
      validateUserOverrideOrRoleMutation({
        actorPermissions: actorPerms,
        targetPersonId: person.id,
        addedRoleKeys,
        rbacConfig,
      });
    } catch (err) {
      const code = err instanceof AuthorisationError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code,
        error: code ? `${code}: ${message}` : message,
      };
    }

    const beforeJson = JSON.stringify({
      roles: person.roles ?? [],
      supportsIds: person.supportsIds ?? [],
    });

    if (input.roles && input.roles.length > 0) {
      person.roles = Array.from(new Set(input.roles));
    } else if (input.roles && input.roles.length === 0) {
      person.roles = [];
    }
    if (input.supportsIds) {
      person.supportsIds = Array.from(new Set(input.supportsIds));
    }
    person.updatedAt = new Date().toISOString();
    person.updatedById = byId;

    const afterJson = JSON.stringify({
      roles: person.roles ?? [],
      supportsIds: person.supportsIds ?? [],
    });

    await partyRepo.putPerson(ctx, person);
    await syncAffectedMattersRestrictionsInTx(ctx, {
      includeAllRestrictedMatters: true,
    });
    await runWithAuditStagingScope(async () => {
      writeAudit(null, {
        recordType: 'person',
        recordId: person.id,
        action: 'update',
        field: 'Roles & supported fee earners',
        oldValue: beforeJson,
        newValue: afterJson,
        byId,
      });

      await flushStagedAuditEntries(ctx);
    });
    return { ok: true };
  });
}

/**
 * Computes a server-side preview of a target employee's effective permissions when draft
 * `grant`/`revoke` overrides (and optional draft `rbacConfig`) are applied, using the
 * central RBAC resolver (`resolvePersonPermissions`).
 */
export async function previewRbacOverrides(
  personId: string,
  draftOverrides: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    rbacConfig?: RbacConfiguration;
  },
  byId: string,
  options?: { mfaVerified?: boolean },
): Promise<{ ok: boolean; code?: string; error?: string; permissions: PermissionKey[] }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const [people, teams, dbRbacOverride] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
    getHrAndRbacRepository().getRbacConfigOverride<RbacConfiguration>(ctx),
  ]);
  const currentRbacConfig = await loadEffectiveTenantRbacConfig(
    ctx,
    dbRbacOverride,
  );
  const actor = people.find((p) => p.id === byId);
  const target = people.find((p) => p.id === personId);
  if (!actor)
    return { ok: false, error: 'Acting user not found.', permissions: [] };
  if (!target)
    return { ok: false, error: 'Target employee not found.', permissions: [] };
  if (
    !hasPersonPermission(actor, 'admin:access', {
      allPeople: people,
      teams,
      config: { rbac: currentRbacConfig },
    }) &&
    !hasPersonPermission(actor, 'rbac:manage_user_overrides', {
      allPeople: people,
      teams,
      config: { rbac: currentRbacConfig },
    }) &&
    !hasPersonPermission(actor, 'rbac:manage_config', {
      allPeople: people,
      teams,
      config: { rbac: currentRbacConfig },
    })
  ) {
    return {
      ok: false,
      code: 'RBAC_PERMISSION_DENIED',
      error:
        'RBAC_PERMISSION_DENIED: You do not have permission to preview RBAC overrides.',
      permissions: [],
    };
  }
  if (options?.mfaVerified !== true) {
    return {
      ok: false,
      code: 'MFA_REQUIRED',
      error:
        'MFA_REQUIRED: Multi-factor authentication is required to preview RBAC overrides.',
      permissions: [],
    };
  }

  let validatedRbacConfig: RbacConfiguration | undefined;
  if (draftOverrides.rbacConfig !== undefined) {
    try {
      validatedRbacConfig = validateRbacConfig(draftOverrides.rbacConfig);
    } catch (err) {
      return {
        ok: false,
        code: 'RBAC_CONFIG_INVALID',
        error: err instanceof Error ? err.message : String(err),
        permissions: [],
      };
    }
  }

  const jobOnlyPreviewGrant = (draftOverrides.grant ?? []).find(
    isJobOnlyPermissionKey,
  );
  if (jobOnlyPreviewGrant) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: `FORBIDDEN: Permission "${jobOnlyPreviewGrant}" is reserved for background jobs (jobOnly) and cannot be granted to a user.`,
      permissions: [],
    };
  }

  const cleanGrant = Array.from(
    new Set((draftOverrides.grant ?? []).filter(isUserAssignablePermissionKey)),
  );
  const cleanRevoke = Array.from(
    new Set(
      (draftOverrides.revoke ?? [])
        .filter(isRegisteredPermissionKey)
        .filter((p) => !cleanGrant.includes(p)),
    ),
  );

  const syntheticTarget: Person = {
    ...target,
    permissionOverrides: {
      grant: cleanGrant,
      revoke: cleanRevoke,
    },
  };

  const permissions = resolvePersonPermissions(syntheticTarget, {
    allPeople: people,
    teams,
    config: { rbac: validatedRbacConfig ?? currentRbacConfig },
  });

  return { ok: true, permissions };
}

/**
 * Updates a target person's unified `permissionOverrides` (`grant` / `revoke`) and/or `entraObjectId`.
 * Enforces `rbac:manage_user_overrides` + MFA + blocks self-modification + blocks granting unheld permissions,
 * and writes a before/after audit entry (ADR-0015).
 */
export async function updatePersonPermissionOverrides(
  personId: string,
  input: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    reason?: string;
    entraObjectId?: string | null;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): Promise<{ ok: boolean; code?: string; error?: string; person?: Person }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const hrRepo = getHrAndRbacRepository();
  return partyRepo.withTenantTransaction(ctx, async () => {
    const [people, teams, dbRbacOverride] = await Promise.all([
      partyRepo.listAllPeople<Person>(ctx),
      hrRepo.listAllTeams<Team>(ctx),
      hrRepo.getRbacConfigOverride<RbacConfiguration>(ctx),
    ]);
    const actor = people.find((p) => p.id === byId);
    const target = people.find((p) => p.id === personId);
    if (!actor) return { ok: false, error: 'Acting user not found.' };
    if (!target) return { ok: false, error: 'Target employee not found.' };

    const rbacConfig = await loadEffectiveTenantRbacConfig(ctx, dbRbacOverride);
    const actorPerms = resolvePersonPermissionSet(actor, {
      allPeople: people,
      teams,
      mfaVerified: options.mfaVerified ?? false,
      config: { rbac: rbacConfig },
    });

    const cleanGrant = Array.from(
      new Set((input.grant ?? []).filter(isRegisteredPermissionKey)),
    );
    const cleanRevoke = Array.from(
      new Set((input.revoke ?? []).filter(isRegisteredPermissionKey)),
    );
    const prevGrant = new Set<PermissionKey>(
      target.permissionOverrides?.grant ?? [],
    );
    const newlyAddedPermissions = Array.from(
      new Set([
        ...cleanGrant.filter((p) => !prevGrant.has(p)),
        ...cleanGrant.filter(isJobOnlyPermissionKey),
      ]),
    );

    try {
      validateUserOverrideOrRoleMutation({
        actorPermissions: actorPerms,
        targetPersonId: target.id,
        addedPermissions: newlyAddedPermissions,
        rbacConfig,
      });
    } catch (err) {
      const code = err instanceof AuthorisationError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code,
        error: code ? `${code}: ${message}` : message,
      };
    }

    const nowIso = new Date().toISOString();
    const beforeSummary = JSON.stringify({
      permissionOverrides: target.permissionOverrides ?? null,
      entraObjectId: target.entraObjectId ?? null,
    });

    target.permissionOverrides = {
      grant: cleanGrant.filter(isUserAssignablePermissionKey),
      revoke: cleanRevoke.filter((p) => !cleanGrant.includes(p)),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      updatedAt: nowIso,
      updatedByUserId: byId,
    };
    // Clear deprecated override fields once unified permissionOverrides is saved
    delete target.employeePermissions;
    delete target.documentPermissions;

    if (input.entraObjectId !== undefined) {
      target.entraObjectId = input.entraObjectId?.trim() || null;
    }
    target.updatedAt = nowIso;
    target.updatedById = byId;

    const afterSummary = JSON.stringify({
      permissionOverrides: target.permissionOverrides,
      entraObjectId: target.entraObjectId ?? null,
    });

    await partyRepo.putPerson(ctx, target);
    await syncAffectedMattersRestrictionsInTx(ctx, {
      includeAllRestrictedMatters: true,
    });
    await runWithAuditStagingScope(async () => {
      writeAudit(null, {
        recordType: 'person',
        recordId: target.id,
        action: 'update',
        field: 'Permission overrides & Entra ID binding',
        oldValue: beforeSummary,
        newValue: afterSummary,
        byId,
        at: nowIso,
      });

      await flushStagedAuditEntries(ctx);
    });
    return { ok: true, person: target };
  });
}

/**
 * Updates the tenant's RBAC configuration (`roles`, `departmentGrants`, `relationshipGrants`, `identityMapping`).
 * Enforces `rbac:manage_config` + MFA, validates all permission and role keys, and writes a before/after audit log.
 */
export async function updateTenantRbacConfig(
  patch: Partial<RbacConfiguration> | null,
  byId: string,
  options: { mfaVerified?: boolean; expectedRowVersion?: number | null } = {},
): Promise<{ ok: boolean; code?: string; error?: string; rbacConfig?: RbacConfiguration }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const hrRepo = getHrAndRbacRepository();
  return runWithAuditStagingScope(() =>
    hrRepo.withTenantTransaction(ctx, async () => {
      const [people, teams, { override: dbRbacOverride, rowVersion }] =
        await Promise.all([
          partyRepo.listAllPeople<Person>(ctx),
          hrRepo.listAllTeams<Team>(ctx),
          hrRepo.getRbacConfigOverrideWithVersion<RbacConfiguration>(ctx),
        ]);
      const actor = people.find((p) => p.id === byId);
      if (!actor) return { ok: false, error: 'Acting user not found.' };

      const baseRbac = getDefaultTenantRbacConfig(ctx.tenantId);
      const currentRbac = dbRbacOverride
        ? mergeRbacConfigOverlay(baseRbac, dbRbacOverride)
        : baseRbac;
      const actorPerms = resolvePersonPermissionSet(actor, {
        allPeople: people,
        teams,
        mfaVerified: options.mfaVerified ?? false,
        config: { rbac: currentRbac },
      });

      try {
        requirePermission(
          actorPerms,
          'rbac:manage_config',
          'update tenant RBAC and Entra ID configuration',
        );
      } catch (err) {
        const code = err instanceof AuthorisationError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code,
          error: code ? `${code}: ${message}` : message,
        };
      }

      if (patch !== null) {
        const knownRoleKeys = new Set<string>([
          ...Object.keys(currentRbac.roles),
          ...Object.keys(patch.roles ?? {}),
        ]);

        // Validate permission keys in roles, departmentGrants, and relationshipGrants
        for (const [roleKey, roleDef] of Object.entries(patch.roles ?? {})) {
          for (const perm of roleDef?.permissions ?? []) {
            if (!isRegisteredPermissionKey(perm)) {
              return {
                ok: false,
                error: `Role "${roleKey}" references unknown permission "${perm}".`,
              };
            }
            if (isJobOnlyPermissionKey(perm)) {
              const msg = `Permission "${perm}" is reserved for background jobs (jobOnly) and cannot be granted to role "${roleKey}".`;
              return {
                ok: false,
                code: 'FORBIDDEN',
                error: `FORBIDDEN: ${msg}`,
              };
            }
          }
        }
        for (const [deptId, perms] of Object.entries(
          patch.departmentGrants ?? {},
        )) {
          for (const perm of perms ?? []) {
            if (!isRegisteredPermissionKey(perm)) {
              return {
                ok: false,
                error: `Department "${deptId}" references unknown permission "${perm}".`,
              };
            }
            if (isJobOnlyPermissionKey(perm)) {
              const msg = `Permission "${perm}" is reserved for background jobs (jobOnly) and cannot be granted to department "${deptId}".`;
              return {
                ok: false,
                code: 'FORBIDDEN',
                error: `FORBIDDEN: ${msg}`,
              };
            }
          }
        }
        for (const rule of patch.relationshipGrants ?? []) {
          for (const perm of rule?.permissions ?? []) {
            if (!isRegisteredPermissionKey(perm)) {
              return {
                ok: false,
                error: `Relationship "${rule?.relationship}" references unknown permission "${perm}".`,
              };
            }
            if (isJobOnlyPermissionKey(perm)) {
              const msg = `Permission "${perm}" is reserved for background jobs (jobOnly) and cannot be granted via relationship "${rule?.relationship}".`;
              return {
                ok: false,
                code: 'FORBIDDEN',
                error: `FORBIDDEN: ${msg}`,
              };
            }
          }
        }
        if (patch.identityMapping) {
          for (const [groupKey, rks] of Object.entries(
            patch.identityMapping.entraGroupToRoleKey ?? {},
          )) {
            for (const rk of rks) {
              if (!knownRoleKeys.has(rk)) {
                return {
                  ok: false,
                  error: `Entra group "${groupKey}" maps to unknown role key "${rk}".`,
                };
              }
            }
          }
          for (const [appRole, rks] of Object.entries(
            patch.identityMapping.entraAppRoleToRoleKey ?? {},
          )) {
            for (const rk of rks) {
              if (!knownRoleKeys.has(rk)) {
                return {
                  ok: false,
                  error: `Entra app role "${appRole}" maps to unknown role key "${rk}".`,
                };
              }
            }
          }
          if (
            'emailLinking' in patch.identityMapping &&
            patch.identityMapping.emailLinking !== undefined
          ) {
            if (
              typeof patch.identityMapping.emailLinking !== 'object' ||
              patch.identityMapping.emailLinking === null
            ) {
              return {
                ok: false,
                error: 'emailLinking must be an object.',
              };
            }
            if (
              'enabled' in patch.identityMapping.emailLinking &&
              typeof patch.identityMapping.emailLinking.enabled !== 'boolean'
            ) {
              return {
                ok: false,
                error: 'emailLinking.enabled must be a boolean.',
              };
            }
            if ('domains' in patch.identityMapping.emailLinking) {
              if (!Array.isArray(patch.identityMapping.emailLinking.domains)) {
                return {
                  ok: false,
                  error:
                    'emailLinking.domains must be an array of lower-case domain names.',
                };
              }
              for (const domain of patch.identityMapping.emailLinking.domains) {
                if (
                  typeof domain !== 'string' ||
                  !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)
                ) {
                  return {
                    ok: false,
                    error: `Invalid domain "${String(domain)}" in emailLinking.domains; each domain must be a lower-case domain name.`,
                  };
                }
              }
            }
          }
        }
      }

      const beforeJson = JSON.stringify(currentRbac);
      const nextRbac =
        patch === null ? baseRbac : mergeRbacConfigOverlay(currentRbac, patch);
      const nowIso = new Date().toISOString();
      const expectedRowVersion =
        options.expectedRowVersion !== undefined
          ? options.expectedRowVersion
          : rowVersion;

      await hrRepo.putRbacConfigOverride(
        ctx,
        patch === null ? null : nextRbac,
        {
          updatedById: byId,
          updatedAt: nowIso,
          expectedRowVersion,
        },
      );
      const activeSession = getActiveActorSession();
      if (activeSession && activeSession.tenantId === ctx.tenantId) {
        activeSession.effectiveRbacConfig = nextRbac;
      }
      await syncAffectedMattersRestrictionsInTx(ctx, {
        includeAllRestrictedMatters: true,
        rbacConfig: nextRbac,
      });
      writeAudit(null, {
        recordType: 'system',
        recordId: 'TENANT-RBAC-CONFIG',
        action: 'update',
        field: 'Tenant RBAC & Entra ID Identity Mapping',
        oldValue: beforeJson,
        newValue: JSON.stringify(nextRbac),
        byId,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
      return { ok: true, rbacConfig: nextRbac };
    }),
  );
}

export async function approveSignOff(
  signOffId: string,
  byId: string,
): Promise<{ ok: true } | ActionDenied> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const taskRepo = getTaskWorkflowRepository();
  const [people, matters, item, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    taskRepo.getSignOffById<SignOffItem>(ctx, signOffId, { includeRestricted: true }),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
  });
  if (!permSet.permissions.has('signoff:approve')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (signoff:approve) to approve sign-off requests.',
    );
  }

  if (!item) {
    return buildActionDenied('FORBIDDEN', 'Sign-off item not found or access denied.');
  }

  if (item.matterId) {
    const linkedMatter = matters.find((m) => m.id === item.matterId) ?? null;
    if (
      !linkedMatter ||
      !canPersonAccessMatter(linkedMatter, byId, actor, {
        allPeople: people,
        teams,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        'You do not have access to the matter linked to this sign-off request.',
      );
    }
  }

  if (item.assignedPartnerId && item.assignedPartnerId !== byId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Only the assigned partner may approve this sign-off request.',
    );
  }

  if (item.requestedById === byId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Self-approval is not permitted: the requester cannot approve their own sign-off.',
    );
  }

  if (item.status !== 'Pending' && item.status !== 'Discussing') {
    return buildActionDenied(
      'FORBIDDEN',
      `Cannot approve a sign-off with status "${item.status}".`,
    );
  }

  const previousStatus = item.status;
  const nowIso = new Date().toISOString();
  item.status = 'Approved';
  item.approvedById = byId;
  item.approvedAt = nowIso;

  await taskRepo.withTenantTransaction(ctx, async () => {
    await taskRepo.putSignOff(ctx, item);

    writeAudit(null, {
      recordType: item.matterId ? 'matter' : 'system',
      recordId: item.matterId ?? item.id,
      action: 'status-change',
      field: 'Partner sign-off',
      oldValue: previousStatus,
      newValue: `Approved: ${item.title}`,
      byId,
      at: nowIso,
    });

    await flushStagedAuditEntries(ctx);
  });

  return { ok: true };
  });
}


export async function discussSignOff(
  signOffId: string,
  note: string,
  byId: string,
): Promise<{ ok: true } | ActionDenied> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const taskRepo = getTaskWorkflowRepository();
  const [people, matters, item, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    taskRepo.getSignOffById<SignOffItem>(ctx, signOffId, { includeRestricted: true }),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
  });
  if (!permSet.permissions.has('signoff:approve')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (signoff:approve) to discuss sign-off requests.',
    );
  }

  if (!item) {
    return buildActionDenied('FORBIDDEN', 'Sign-off item not found or access denied.');
  }

  if (item.matterId) {
    const linkedMatter = matters.find((m) => m.id === item.matterId) ?? null;
    if (
      !linkedMatter ||
      !canPersonAccessMatter(linkedMatter, byId, actor, {
        allPeople: people,
        teams,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        'You do not have access to the matter linked to this sign-off request.',
      );
    }
  }

  if (item.assignedPartnerId && item.assignedPartnerId !== byId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Only the assigned partner may discuss this sign-off request.',
    );
  }

  if (item.requestedById === byId) {
    return buildActionDenied(
      'FORBIDDEN',
      'Self-approval is not permitted: the requester cannot discuss their own sign-off.',
    );
  }

  if (item.status !== 'Pending' && item.status !== 'Discussing') {
    return buildActionDenied(
      'FORBIDDEN',
      `Cannot discuss a sign-off with status "${item.status}".`,
    );
  }

  const previousStatus = item.status;
  const nowIso = new Date().toISOString();
  item.status = 'Discussing';
  item.discussionNote = note.trim() || 'Partner requested discussion before sign-off.';

  await taskRepo.withTenantTransaction(ctx, async () => {
    await taskRepo.putSignOff(ctx, item);

    writeAudit(null, {
      recordType: item.matterId ? 'matter' : 'system',
      recordId: item.matterId ?? item.id,
      action: 'status-change',
      field: 'Partner sign-off',
      oldValue: previousStatus,
      newValue: `Discussing: ${item.title} (${item.discussionNote})`,
      byId,
      at: nowIso,
    });

    // Create a follow-up task for the requester
    const linkedRecords: TaskLinkedRecord[] = [];
    if (item.matterId) linkedRecords.push({ recordType: 'matter', recordId: item.matterId });
    await saveTaskRecord(
      {
        title: `Discuss partner sign-off: ${item.title}`,
        description: item.discussionNote,
        taskTypeId: vid('task_type', 'Review'),
        priorityId: vid('task_priority', 'High'),
        dueAt: toIsoDate(new Date()),
        assignedPersonId: item.requestedById,
        linkedRecords,
      },
      byId,
      { internalSystemStep: true },
    );

    await flushStagedAuditEntries(ctx);
  });

  return { ok: true };
  });
}


export async function requestMatterBill(
  matterCode: string,
  byId: FinanceActorInput,
): Promise<{ ok: true; taskId?: string } | ActionDenied> {
  const auth = await verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  const { ctx, actor, tokenRoles, tenantPmsLinks, people, matters, teams } = auth;
  const linkedId = findOneSquaredIdForPmsCode(tenantPmsLinks, 'matter', matterCode);
  const targetMatter = linkedId
    ? matters.find((m) => m.id === linkedId && !m.mergedIntoId)
    : undefined;
  const pms = await getTenantPmsSource(ctx);
  const pmsMatter = linkedId ? pms.getMatterFinancials(matterCode) : null;
  if (
    !targetMatter ||
    !pmsMatter ||
    !canPersonAccessMatter(targetMatter, actor.id, actor, {
      allPeople: people,
      teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const assignedPersonId = targetMatter.leadFeeEarnerId ?? null;
  const assignedTeamId = targetMatter.owningTeamId ?? null;
  if (!assignedPersonId) {
    const tenantCfg = getActiveTenantConfiguration();
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'draft_bill_approval_task_unassigned',
        tenantId: tenantCfg.tenantId,
        correlationId: `corr-bill-task-${Date.now()}`,
      }),
    );
  }
  const linkedRecords: TaskLinkedRecord[] = [
    { recordType: 'matter', recordId: targetMatter.id },
  ];

  const res = await saveTaskRecord(
    {
      title: `Approve draft bill on ${matterCode} (${targetMatter.title})`,
      description: `Billing request raised from Home page for unbilled WIP on ${matterCode}.`,
      taskTypeId: vid('task_type', 'Review'),
      priorityId: vid('task_priority', 'High'),
      dueAt: toIsoDate(new Date()),
      assignedPersonId,
      assignedTeamId,
      linkedRecords,
    },
    actor.id,
    { internalSystemStep: true },
  );

  return { ok: true, taskId: res.task?.id };
}

export async function flagMatterWriteOff(
  matterCode: string,
  amountGbp: number,
  byId: FinanceActorInput,
): Promise<{ ok: true; signOffId?: string } | ActionDenied> {
  const auth = await verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  if (typeof amountGbp !== 'number' || !Number.isFinite(amountGbp) || amountGbp <= 0) {
    return buildActionDenied(
      'FORBIDDEN',
      'Write-off amount must be a finite number greater than 0.',
    );
  }

  const { ctx, actor, tokenRoles, tenantPmsLinks, people, matters, teams } = auth;
  const linkedId = findOneSquaredIdForPmsCode(tenantPmsLinks, 'matter', matterCode);
  const matter = linkedId
    ? matters.find((m) => m.id === linkedId && !m.mergedIntoId)
    : undefined;
  const pms = await getTenantPmsSource(ctx);
  const pmsMatter = linkedId ? pms.getMatterFinancials(matterCode) : null;
  if (
    !matter ||
    !pmsMatter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: people,
      teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const taskRepo = getTaskWorkflowRepository();
  const id = await taskRepo.allocateNextSignOffId(ctx);
  const nowIso = new Date().toISOString();
  const formattedAmt = amountGbp.toLocaleString('en-GB', {
    style: 'currency',
    currency: 'GBP',
  });
  const assignedPartnerId =
    matter.supervisingPartnerId ?? matter.responsiblePartnerId ?? null;
  if (!assignedPartnerId) {
    const tenantCfg = getActiveTenantConfiguration();
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'write_off_signoff_unassigned',
        tenantId: tenantCfg.tenantId,
        correlationId: `corr-writeoff-${Date.now()}`,
      }),
    );
  }

  const signOff: SignOffItem = {
    id,
    kind: 'write_off',
    title: `Write-off: ${formattedAmt} over cap/estimate on ${matterCode}`,
    matterNumber: matterCode,
    matterId: matter.id,
    subtitle: `${matterCode} · ${matter.title} · Flagged for partner write-off decision`,
    requestedById: actor.id,
    requestedAt: nowIso,
    assignedPartnerId,
    status: 'Pending',
  };

  await taskRepo.putSignOff(ctx, signOff);
  return { ok: true, signOffId: id };
}

export async function remindTeamLeadOverdueCompliance(
  teamId: string,
  byId: string,
): Promise<{ ok: boolean } | ActionDenied> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const [people, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: people,
    teams,
  });
  if (!permSet.permissions.has('risk:view')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (risk:view) to send overdue compliance reminders.',
    );
  }
  const team = teams.find((t) => t.id === teamId);
  if (!team) {
    return buildActionDenied('FORBIDDEN', 'Team not found.');
  }
  const leadId = team.leadIds[0] ?? null;
  if (!leadId) {
    const tenantCfg = getActiveTenantConfiguration();
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'compliance_reminder_no_team_lead',
        tenantId: tenantCfg.tenantId,
        correlationId: `corr-compliance-remind-${Date.now()}`,
        teamId: team.id,
      }),
    );
    return { ok: false };
  }
  const nowIso = new Date().toISOString();
  const taskRepo = getTaskWorkflowRepository();
  await taskRepo.withTenantTransaction(ctx, async () => {
    const notifId = await taskRepo.allocateNextNotificationId(ctx);
    await taskRepo.putNotification(ctx, {
      id: notifId,
      recipientId: leadId,
      kind: 'task_overdue',
      title: `Compliance reminder: overdue onboarding / AML tasks in ${team.name}`,
      detail: 'MLRO / COLP requested an update on overdue compliance tasks in your team.',
      href: '/tasks',
      recordId: team.id,
      createdAt: nowIso,
      read: false,
      byId,
    });

    writeAudit(null, {
      recordType: 'team',
      recordId: team.id,
      action: 'update',
      field: 'Compliance reminder',
      oldValue: null,
      newValue: `Sent overdue compliance task reminder to team lead (${leadId})`,
      byId,
      at: nowIso,
    });

    await flushStagedAuditEntries(ctx);
  });

  return { ok: true };
  });
}


export async function recordInvoiceCreditControlAction(
  input: {
    invoiceNumber: string;
    matterCode: string;
    clientCode: string;
    actionType: 'log_call' | 'send_reminder' | 'escalate';
    note?: string;
  },
  byId: FinanceActorInput,
): Promise<{ ok: true; taskId?: string } | ActionDenied> {
  const auth = await verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  const { actor, tokenRoles, tenantPmsLinks, people, matters, teams, ctx } = auth;
  const pms = await getTenantPmsSource(ctx);
  const linkedMatterId = findOneSquaredIdForPmsCode(
    tenantPmsLinks,
    'matter',
    input.matterCode,
  );

  const matter = linkedMatterId
    ? matters.find((m) => m.id === linkedMatterId && !m.mergedIntoId)
    : null;
  const pmsMatter = linkedMatterId
    ? pms.getMatterFinancials(input.matterCode)
    : null;
  if (
    !matter ||
    !pmsMatter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: people,
      teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const pmsInvoice = pms.getInvoiceBalance(input.invoiceNumber);
  if (!pmsInvoice || pmsInvoice.matter_code !== input.matterCode) {
    return buildActionDenied(
      'FORBIDDEN',
      'Invoice does not belong to the specified matter or was not found.',
    );
  }
  if (input.clientCode && input.clientCode.trim() !== pmsInvoice.client_code) {
    return buildActionDenied(
      'FORBIDDEN',
      'Client code does not match the invoice record.',
    );
  }
  const invoiceClientCode = pmsInvoice.client_code;
  const linkedOrgId = findOneSquaredIdForPmsCode(
    tenantPmsLinks,
    'organisation',
    invoiceClientCode,
  );
  const linkedPersonId = findOneSquaredIdForPmsCode(
    tenantPmsLinks,
    'person',
    invoiceClientCode,
  );

  const linkedRecords: TaskLinkedRecord[] = [
    { recordType: 'matter', recordId: matter.id },
  ];
  if (linkedOrgId) linkedRecords.push({ recordType: 'organisation', recordId: linkedOrgId });
  if (linkedPersonId) linkedRecords.push({ recordType: 'person', recordId: linkedPersonId });

  const nowIso = new Date().toISOString();

  if (input.actionType === 'escalate') {
    const partnerId =
      matter.responsiblePartnerId ?? matter.supervisingPartnerId ?? null;
    const assignedTeamId = matter.owningTeamId ?? null;
    if (!partnerId) {
      const tenantCfg = getActiveTenantConfiguration();
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'credit_control_escalation_task_unassigned',
          tenantId: tenantCfg.tenantId,
          correlationId: `corr-credit-escalate-${Date.now()}`,
        }),
      );
    }
    const res = await saveTaskRecord(
      {
        title: `Partner escalation: overdue invoice ${input.invoiceNumber} (${input.matterCode})`,
        description:
          input.note ||
          `Credit control escalated overdue invoice ${input.invoiceNumber} on ${input.matterCode} for partner review / formal letter before action.`,
        taskTypeId: vid('task_type', 'Review'),
        priorityId: vid('task_priority', 'Urgent'),
        dueAt: toIsoDate(new Date()),
        assignedPersonId: partnerId,
        assignedTeamId,
        linkedRecords,
      },
      actor.id,
      { internalSystemStep: true },
    );
    return { ok: true, taskId: res.task?.id };
  }

  const noteText =
    input.actionType === 'log_call'
      ? `Credit control call logged regarding invoice ${input.invoiceNumber} (${input.matterCode}). ${input.note ?? ''}`.trim()
      : `Credit control reminder statement sent for invoice ${input.invoiceNumber} (${input.matterCode}).`;

  // Record a note on the client or matter, persist to pms_credit_control_log, and log an audit entry in one transaction
  const targetRecordId = linkedOrgId ?? linkedPersonId ?? linkedMatterId;
  const pmsRepo = getPmsRepository();
  await runWithAuditStagingScope(() =>
    pmsRepo.withTenantTransaction(ctx, async () => {
      if (targetRecordId) {
        const partyRepo = getPartyRepository();
        const noteId = await partyRepo.allocateNextNoteId(ctx);
        await partyRepo.putNote(ctx, {
          id: noteId,
          recordType: targetRecordId.startsWith('O-')
            ? 'organisation'
            : targetRecordId.startsWith('P-')
              ? 'person'
              : 'matter',
          recordId: targetRecordId,
          authorId: actor.id,
          at: nowIso,
          text: noteText,
        });
      }

      await pmsRepo.recordCreditControlAction(ctx, {
        invoiceNumber: input.invoiceNumber,
        matterCode: input.matterCode,
        actionType: input.actionType,
        notes: noteText,
        actorName: personDisplayName(actor),
        createdAt: nowIso,
      });

      writeAudit(null, {
        recordType: linkedMatterId ? 'matter' : 'system',
        recordId: linkedMatterId ?? input.invoiceNumber,
        action: 'note',
        field: 'Credit control',
        oldValue: null,
        newValue: `${input.actionType === 'log_call' ? 'Logged chase call' : 'Sent reminder'} on ${input.invoiceNumber}`,
        byId: actor.id,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );

  return { ok: true };
}


export async function saveOrgStructure(
  nextCatalogue: OrgStructureCatalogue,
  byId: string,
): Promise<{ orgStructure: OrgStructureCatalogue }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      await catalogueRepo.putOrgStructureConfig(ctx, nextCatalogue, byId);
      writeAudit(null, {
        recordType: 'system',
        recordId: 'ORG-STRUCTURE',
        action: 'update',
        field: 'Organisation structure reference tables',
        oldValue: null,
        newValue: `Updated organisation hierarchy (${nextCatalogue.divisions.length} divisions, ${nextCatalogue.departments.length} departments, ${nextCatalogue.teamsOrPracticeGroups.length} teams/practice groups)`,
        byId,
        at: new Date().toISOString(),
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return { orgStructure: nextCatalogue };
}

export async function saveMatterPartyRelationship(
  input: {
    code: string;
    label: string;
    description?: string;
    active?: boolean;
    isNew?: boolean;
  },
  byId: string,
): Promise<{ relationship?: MatterPartyRelationshipDef; taxonomy: MatterPartyTaxonomy; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: {
    relationship?: MatterPartyRelationshipDef;
    taxonomy: MatterPartyTaxonomy;
    error?: string;
  };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const code = input.code.trim().toUpperCase();
      const label = input.label.trim();
      if (!code) {
        result = { taxonomy, error: 'Relationship code is required.' };
        return;
      }
      if (!label) {
        result = { taxonomy, error: 'Relationship label is required.' };
        return;
      }

      const existingIdx = taxonomy.relationships.findIndex((r) => r.code === code);
      if (input.isNew) {
        if (existingIdx !== -1) {
          result = {
            taxonomy,
            error: `Relationship code "${code}" already exists. Codes are immutable.`,
          };
          return;
        }
        const maxOrder = taxonomy.relationships.reduce(
          (m, r) => Math.max(m, r.sortOrder),
          0,
        );
        const created: MatterPartyRelationshipDef = {
          code,
          label,
          description: (input.description ?? '').trim(),
          sortOrder: maxOrder + 1,
          active: input.active ?? true,
        };
        taxonomy.relationships.push(created);
        await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
        writeAudit(null, {
          recordType: 'list',
          recordId: 'matter_party_role',
          action: 'list-change',
          field: `Relationship ${code}`,
          oldValue: null,
          newValue: `${code} — ${label}`,
          byId,
        });
        await flushStagedAuditEntries(ctx);
        result = { relationship: created, taxonomy };
        return;
      }

      if (existingIdx === -1) {
        result = { taxonomy, error: `Relationship "${code}" not found.` };
        return;
      }
      const existing = taxonomy.relationships[existingIdx];
      const updated: MatterPartyRelationshipDef = {
        ...existing,
        code: existing.code, // Immutable
        label,
        description:
          input.description !== undefined
            ? input.description.trim()
            : existing.description,
        active: input.active !== undefined ? input.active : existing.active,
      };
      taxonomy.relationships[existingIdx] = updated;
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Relationship ${existing.code}`,
        oldValue: `${existing.label}${existing.active ? '' : ' (inactive)'}`,
        newValue: `${updated.label}${updated.active ? '' : ' (inactive)'}`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { relationship: updated, taxonomy };
    }),
  );
  return result;
}

export async function reorderMatterPartyRelationship(
  code: string,
  direction: -1 | 1,
  byId: string,
): Promise<{ taxonomy: MatterPartyTaxonomy }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { taxonomy: MatterPartyTaxonomy };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const sorted = [...taxonomy.relationships].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      const idx = sorted.findIndex((r) => r.code === code);
      const swapIdx = idx + direction;
      if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) {
        result = { taxonomy };
        return;
      }
      [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
      sorted.forEach((r, i) => {
        r.sortOrder = i + 1;
      });
      taxonomy.relationships = sorted;
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Reordered relationship ${code}`,
        oldValue: null,
        newValue: direction === -1 ? 'Moved up' : 'Moved down',
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { taxonomy };
    }),
  );
  return result;
}

export async function deleteMatterPartyRelationship(
  code: string,
  byId: string,
): Promise<{ taxonomy: MatterPartyTaxonomy; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { taxonomy: MatterPartyTaxonomy; error?: string };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, matters] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
      ]);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const usage = computeMatterPartyUsageCounts(matters);
      const count = usage.byRelationshipCode[code] ?? 0;
      if (count > 0) {
        result = {
          taxonomy,
          error: `Relationship "${code}" is in use on ${count} matter party record(s). It can be deactivated but not deleted.`,
        };
        return;
      }
      const existing = taxonomy.relationships.find((r) => r.code === code);
      if (!existing) {
        result = { taxonomy, error: 'Relationship not found.' };
        return;
      }
      taxonomy.relationships = taxonomy.relationships.filter(
        (r) => r.code !== code,
      );
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Deleted relationship ${code}`,
        oldValue: existing.label,
        newValue: null,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { taxonomy };
    }),
  );
  return result;
}

export async function saveMatterPartyCapacity(
  input: {
    code: string;
    label: string;
    group: CapacityGroupName;
    description?: string;
    allowedRelationships: string[];
    profiles: WorkTypeProfileCode[];
    active?: boolean;
    isNew?: boolean;
  },
  byId: string,
): Promise<{ capacity?: MatterPartyCapacityDef; taxonomy: MatterPartyTaxonomy; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: {
    capacity?: MatterPartyCapacityDef;
    taxonomy: MatterPartyTaxonomy;
    error?: string;
  };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const code = input.code
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_');
      const label = input.label.trim();
      if (!code) {
        result = { taxonomy, error: 'Capacity code is required.' };
        return;
      }
      if (!label) {
        result = { taxonomy, error: 'Capacity label is required.' };
        return;
      }

      const existingIdx = taxonomy.capacities.findIndex((c) => c.code === code);
      if (input.isNew) {
        if (existingIdx !== -1) {
          result = {
            taxonomy,
            error: `Capacity code "${code}" already exists. Codes are immutable.`,
          };
          return;
        }
        const maxOrder = taxonomy.capacities.reduce(
          (m, c) => Math.max(m, c.sortOrder),
          0,
        );
        const created: MatterPartyCapacityDef = {
          code,
          label,
          group: input.group || 'Ownership, control and authority',
          description: input.description?.trim() || undefined,
          allowedRelationships: Array.from(new Set(input.allowedRelationships)),
          profiles: Array.from(new Set(input.profiles)),
          sortOrder: maxOrder + 1,
          active: input.active ?? true,
        };
        taxonomy.capacities.push(created);
        await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
        writeAudit(null, {
          recordType: 'list',
          recordId: 'matter_party_role',
          action: 'list-change',
          field: `Capacity ${code}`,
          oldValue: null,
          newValue: `${label} (${created.group})`,
          byId,
        });
        await flushStagedAuditEntries(ctx);
        result = { capacity: created, taxonomy };
        return;
      }

      if (existingIdx === -1) {
        result = { taxonomy, error: `Capacity "${code}" not found.` };
        return;
      }
      const existing = taxonomy.capacities[existingIdx];
      const updated: MatterPartyCapacityDef = {
        ...existing,
        code: existing.code, // Immutable
        label,
        group: input.group || existing.group,
        description:
          input.description !== undefined
            ? input.description.trim() || undefined
            : existing.description,
        allowedRelationships: Array.from(new Set(input.allowedRelationships)),
        profiles: Array.from(new Set(input.profiles)),
        active: input.active !== undefined ? input.active : existing.active,
      };
      taxonomy.capacities[existingIdx] = updated;
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Capacity ${existing.code}`,
        oldValue: `${existing.label}${existing.active ? '' : ' (inactive)'}`,
        newValue: `${updated.label}${updated.active ? '' : ' (inactive)'}`,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { capacity: updated, taxonomy };
    }),
  );
  return result;
}

export async function deleteMatterPartyCapacity(
  code: string,
  byId: string,
): Promise<{ taxonomy: MatterPartyTaxonomy; error?: string }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { taxonomy: MatterPartyTaxonomy; error?: string };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, matters] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
      ]);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const usage = computeMatterPartyUsageCounts(matters);
      const count = usage.byCapacityCode[code] ?? 0;
      if (count > 0) {
        result = {
          taxonomy,
          error: `Capacity "${code}" is in use on ${count} matter party record(s). It can be deactivated but not deleted.`,
        };
        return;
      }
      const existing = taxonomy.capacities.find((c) => c.code === code);
      if (!existing) {
        result = { taxonomy, error: 'Capacity not found.' };
        return;
      }
      taxonomy.capacities = taxonomy.capacities.filter((c) => c.code !== code);
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Deleted capacity ${code}`,
        oldValue: existing.label,
        newValue: null,
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { taxonomy };
    }),
  );
  return result;
}

export async function updateWorkTypeProfiles(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
  byId: string,
): Promise<{ taxonomy: MatterPartyTaxonomy }> {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  let result!: { taxonomy: MatterPartyTaxonomy };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const store = await loadTenantCatalogueStoreView(ctx);
      const taxonomy =
        store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
      const prev = taxonomy.workTypeProfiles[workTypeSubcategoryId] ?? [];
      const next = Array.from(new Set(profiles.filter((p) => p !== 'ALL')));
      taxonomy.workTypeProfiles[workTypeSubcategoryId] = next;
      await catalogueRepo.putMatterPartyTaxonomyConfig(ctx, taxonomy, byId);
      writeAudit(null, {
        recordType: 'list',
        recordId: 'matter_party_role',
        action: 'list-change',
        field: `Work type profiles: ${workTypeSubcategoryId}`,
        oldValue: prev.join(', '),
        newValue: next.join(', '),
        byId,
      });
      await flushStagedAuditEntries(ctx);
      result = { taxonomy };
    }),
  );
  return result;
}

// ============================================================================
// Quotes Services
// ============================================================================

export interface SaveQuoteInput {
  clientType: 'existing' | 'prospect';
  linkedOrganisationId?: string | null;
  linkedPersonId?: string | null;
  prospectName?: string;
  prospectOrganisationName?: string;
  prospectEmail?: string;
  prospectPhone?: string;
  linkedEnquiryId?: string | null;
  practiceAreaId: string;
  workTypeSubcategoryId?: string | null;
  scope: string;
  assumptions?: string;
  feeBasis: QuoteFeeBasis;
  feeAmountExVat: number;
  hourlyRateGbp?: number | null;
  vatAmount?: number;
  vatOverridden?: boolean;
  disbursements?: QuoteDisbursement[];
  validUntil?: string;
  feeEarnerId?: string;
  followUpAfterDays?: number;
}

export async function saveQuoteRecord(
  input: SaveQuoteInput,
  opts: { id?: string; byId: string; markAsSent?: boolean },
): Promise<{ quote?: Quote; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, opts.byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [people, organisations, matters, enquiries, quotes, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getPartyRepository().listAllOrganisations<Organisation>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === opts.byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to create or edit quotes.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const now = new Date();
  const nowIso = now.toISOString();

  const existing = opts.id ? quotes.find((q) => q.id === opts.id) : undefined;
  if (opts.id && (!existing || !visibility.canViewQuote(existing))) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const clientType = input.clientType || 'prospect';
  const linkedOrganisationId = input.linkedOrganisationId || null;
  const linkedPersonId = input.linkedPersonId || null;
  if (linkedOrganisationId && !organisations.some((o) => o.id === linkedOrganisationId)) {
    const msg = 'Linked organisation not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (linkedPersonId && !people.some((p) => p.id === linkedPersonId)) {
    const msg = 'Linked person not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (input.linkedEnquiryId) {
    const linkedEnq = enquiries.find((e) => e.id === input.linkedEnquiryId);
    if (!linkedEnq || !visibility.canViewEnquiry(linkedEnq)) {
      const msg = 'Linked enquiry not found or access denied.';
      return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
    }
  }
  const prospectName = (input.prospectName ?? '').trim();
  const prospectOrganisationName = (input.prospectOrganisationName ?? '').trim();
  const prospectEmail = (input.prospectEmail ?? '').trim();
  const prospectPhone = (input.prospectPhone ?? '').trim();

  if (clientType === 'existing' && !linkedOrganisationId && !linkedPersonId) {
    return { error: 'Please select an existing client or switch to entering a new prospect.' };
  }
  if (clientType === 'prospect' && !prospectName && !prospectOrganisationName) {
    return { error: 'Please enter the prospect name or organisation.' };
  }
  if (!input.practiceAreaId) {
    return { error: 'Please select a practice area / work type.' };
  }
  if (!input.scope?.trim()) {
    return { error: 'Please enter the description of work / scope.' };
  }

  const disbursements: QuoteDisbursement[] = (input.disbursements ?? [])
    .filter((d) => d.description.trim() || Number(d.amountExVat) > 0)
    .map((d, idx) => ({
      id: d.id || `QDISB-${Date.now()}-${idx}`,
      description: d.description.trim() || 'Disbursement',
      amountExVat: Math.max(0, Number(d.amountExVat) || 0),
      vatApplicable: Boolean(d.vatApplicable),
    }));

  const totals = calculateQuoteTotals(
    input.feeAmountExVat,
    input.vatOverridden ? input.vatAmount : null,
    disbursements,
  );

  const feeEarnerId = input.feeEarnerId || existing?.feeEarnerId || opts.byId;
  const routedTeam = resolveRoutedTeam(input.practiceAreaId, teams);
  const feeEarnerTeam = teams.find(
    (t) => t.active && t.memberIds.includes(feeEarnerId),
  );
  const assignedTeamId = routedTeam?.team?.id ?? feeEarnerTeam?.id ?? existing?.assignedTeamId ?? null;

  const followUpAfterDays = Math.max(1, Number(input.followUpAfterDays) || 7);
  const defaultValidUntil = toIsoDate(addDays(now, 30));
  const validUntil = input.validUntil || existing?.validUntil || defaultValidUntil;

  const markSent = Boolean(opts.markAsSent);
  const sentAt = markSent ? nowIso : existing?.sentAt ?? null;
  const nextFollowUpDate = markSent
    ? toIsoDate(addDays(now, followUpAfterDays))
    : existing?.nextFollowUpDate ?? null;

  let status: QuoteStatus = existing?.status ?? 'Draft';
  if (markSent) {
    status = 'Sent';
  }

  if (!existing) {
    return intakeRepo.withTenantTransaction(ctx, async () => {
      const reference = await intakeRepo.allocateNextQuoteReference(ctx, now.getFullYear());
      const timeline: Quote['timeline'] = [
        {
          id: `QT-${Date.now()}-1`,
          kind: 'created',
          at: nowIso,
          byId: opts.byId,
          title: 'Quote created (v1)',
          detail: `${input.feeBasis} — £${totals.feeAmountExVat.toLocaleString('en-GB')} + VAT`,
        },
      ];
      if (markSent) {
        timeline.push({
          id: `QT-${Date.now()}-2`,
          kind: 'sent',
          at: nowIso,
          byId: opts.byId,
          title: 'Marked as sent',
          detail: `First follow-up scheduled for ${nextFollowUpDate}`,
        });
      }

      const created: Quote = {
        id: reference,
        reference,
        version: 1,
        status,
        clientType,
        linkedOrganisationId,
        linkedPersonId,
        prospectName,
        prospectOrganisationName,
        prospectEmail,
        prospectPhone,
        linkedEnquiryId: input.linkedEnquiryId || null,
        convertedMatterId: null,
        practiceAreaId: input.practiceAreaId,
        workTypeSubcategoryId: input.workTypeSubcategoryId || null,
        scope: input.scope.trim(),
        assumptions: (input.assumptions ?? '').trim(),
        feeBasis: input.feeBasis,
        feeAmountExVat: totals.feeAmountExVat,
        hourlyRateGbp:
          input.feeBasis === 'Hourly rate with estimate'
            ? Math.max(0, Number(input.hourlyRateGbp) || 0) || null
            : null,
        vatAmount: totals.vatOnFee,
        vatOverridden: Boolean(input.vatOverridden),
        disbursements,
        totalIncVat: totals.totalIncVat,
        feeEarnerId,
        assignedTeamId,
        validUntil,
        followUpAfterDays,
        sentAt,
        nextFollowUpDate,
        outcomeAt: null,
        declineReason: null,
        followUps: [],
        versionHistory: [],
        timeline,
        createdById: opts.byId,
        createdAt: nowIso,
        updatedById: opts.byId,
        updatedAt: nowIso,
      };

      await intakeRepo.putQuote(ctx, created);
      writeAudit(null, {
        recordType: 'quote',
        recordId: created.id,
        action: 'create',
        field: markSent ? 'Quote created and marked as sent' : 'Quote saved as draft',
        oldValue: null,
        newValue: `${created.reference} — ${quoteClientDisplayName(created, people, organisations)}`,
        byId: opts.byId,
        at: nowIso,
      });
      await flushStagedAuditEntries(ctx);
      return { quote: created };
    });
  }

  // Update existing quote
  const wasSentNow = markSent && existing.status === 'Draft';
  existing.clientType = clientType;
  existing.linkedOrganisationId = linkedOrganisationId;
  existing.linkedPersonId = linkedPersonId;
  existing.prospectName = prospectName;
  existing.prospectOrganisationName = prospectOrganisationName;
  existing.prospectEmail = prospectEmail;
  existing.prospectPhone = prospectPhone;
  existing.linkedEnquiryId =
    input.linkedEnquiryId !== undefined ? input.linkedEnquiryId || null : existing.linkedEnquiryId;
  existing.practiceAreaId = input.practiceAreaId;
  existing.workTypeSubcategoryId = input.workTypeSubcategoryId || null;
  existing.scope = input.scope.trim();
  existing.assumptions = (input.assumptions ?? '').trim();
  existing.feeBasis = input.feeBasis;
  existing.feeAmountExVat = totals.feeAmountExVat;
  existing.hourlyRateGbp =
    input.feeBasis === 'Hourly rate with estimate'
      ? Math.max(0, Number(input.hourlyRateGbp) || 0) || null
      : null;
  existing.vatAmount = totals.vatOnFee;
  existing.vatOverridden = Boolean(input.vatOverridden);
  existing.disbursements = disbursements;
  existing.totalIncVat = totals.totalIncVat;
  existing.feeEarnerId = feeEarnerId;
  existing.assignedTeamId = assignedTeamId;
  existing.validUntil = validUntil;
  existing.followUpAfterDays = followUpAfterDays;
  existing.updatedById = opts.byId;
  existing.updatedAt = nowIso;

  if (wasSentNow || markSent) {
    existing.status = 'Sent';
    existing.sentAt = nowIso;
    existing.nextFollowUpDate = toIsoDate(addDays(now, followUpAfterDays));
    existing.timeline.push({
      id: `QT-${Date.now()}-sent`,
      kind: 'sent',
      at: nowIso,
      byId: opts.byId,
      title: `v${existing.version} marked as sent`,
      detail: `Follow-up scheduled for ${existing.nextFollowUpDate}`,
    });
  } else {
    existing.status = evaluateQuoteEffectiveStatus(existing, now);
  }

  await intakeRepo.withTenantTransaction(ctx, async () => {
    await intakeRepo.putQuote(ctx, existing);
    writeAudit(null, {
      recordType: 'quote',
      recordId: existing.id,
      action: 'update',
      field: wasSentNow ? 'Quote marked as sent' : 'Quote updated',
      oldValue: null,
      newValue: `${existing.reference} (v${existing.version})`,
      byId: opts.byId,
      at: nowIso,
    });
    await flushStagedAuditEntries(ctx);
  });
  return { quote: existing };
  });
}

export async function markQuoteSentRecord(
  quoteId: string,
  byId: string,
): Promise<{ quote?: Quote; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [people, matters, quotes, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to mark a quote as sent.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const followUpDays = Math.max(1, quote.followUpAfterDays || 7);
  const nextFollowUpDate = toIsoDate(addDays(now, followUpDays));

  quote.status = 'Sent';
  quote.sentAt = nowIso;
  quote.nextFollowUpDate = nextFollowUpDate;
  quote.updatedAt = nowIso;
  quote.updatedById = byId;

  quote.timeline.push({
    id: `QT-${Date.now()}`,
    kind: 'sent',
    at: nowIso,
    byId,
    title: `v${quote.version} marked as sent`,
    detail: `First follow-up scheduled for ${nextFollowUpDate} (${followUpDays} days)`,
  });

  await intakeRepo.withTenantTransaction(ctx, async () => {
    await intakeRepo.putQuote(ctx, quote);
    writeAudit(null, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'status-change',
      field: 'Mark as sent',
      oldValue: 'Draft',
      newValue: `Sent (follow-up due ${nextFollowUpDate})`,
      byId,
      at: nowIso,
    });
    await flushStagedAuditEntries(ctx);
  });

  return { quote };
  });
}

export async function logQuoteFollowUpRecord(
  quoteId: string,
  input: {
    method: ContactLogMethod;
    note: string;
    nextFollowUpDate: string | null;
  },
  byId: string,
): Promise<{ quote?: Quote; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [people, matters, quotes, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to log quote follow-ups.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (!input.note?.trim()) {
    return { error: 'Please enter a follow-up note.' };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const todayYmd = toIsoDate(now);
  const nextDate = input.nextFollowUpDate || toIsoDate(addDays(now, quote.followUpAfterDays || 7));

  quote.followUps.unshift({
    id: `QFU-${Date.now()}`,
    at: nowIso,
    method: input.method,
    note: input.note.trim(),
    nextFollowUpDate: nextDate,
    byId,
  });

  quote.nextFollowUpDate = nextDate;
  if (quote.status === 'Follow-up due' && nextDate > todayYmd) {
    quote.status = 'Sent';
  }
  quote.status = evaluateQuoteEffectiveStatus(quote, now);
  quote.updatedAt = nowIso;
  quote.updatedById = byId;

  quote.timeline.push({
    id: `QT-${Date.now()}`,
    kind: 'follow_up',
    at: nowIso,
    byId,
    title: `Follow-up logged (${input.method})`,
    detail: `${input.note.trim()}${nextDate ? ` · Next follow-up: ${nextDate}` : ''}`,
  });

  await intakeRepo.withTenantTransaction(ctx, async () => {
    await intakeRepo.putQuote(ctx, quote);
    writeAudit(null, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'contact-log',
      field: `Quote follow-up (${input.method})`,
      oldValue: null,
      newValue: input.note.trim(),
      byId,
      at: nowIso,
    });
    await flushStagedAuditEntries(ctx);
  });

  return { quote };
  });
}

export async function reviseQuoteRecord(
  quoteId: string,
  input: {
    feeBasis: QuoteFeeBasis;
    feeAmountExVat: number;
    hourlyRateGbp?: number | null;
    vatAmount?: number;
    vatOverridden?: boolean;
    disbursements?: QuoteDisbursement[];
    scope: string;
    assumptions?: string;
    validUntil?: string;
    followUpAfterDays?: number;
    revisionNote?: string;
    markAsSent?: boolean;
  },
  byId: string,
): Promise<{ quote?: Quote; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [people, matters, quotes, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to revise quotes.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Archive current version as Superseded
  quote.versionHistory.push({
    version: quote.version,
    status: 'Superseded',
    feeBasis: quote.feeBasis,
    feeAmountExVat: quote.feeAmountExVat,
    hourlyRateGbp: quote.hourlyRateGbp,
    vatAmount: quote.vatAmount,
    disbursements: structuredClone(quote.disbursements),
    totalIncVat: quote.totalIncVat,
    scope: quote.scope,
    assumptions: quote.assumptions,
    validUntil: quote.validUntil,
    createdAt: quote.createdAt,
    sentAt: quote.sentAt,
    supersededAt: nowIso,
    byId,
    revisionNote: input.revisionNote?.trim() || undefined,
  });

  const prevVersion = quote.version;
  const nextVersion = prevVersion + 1;

  const disbursements: QuoteDisbursement[] = (input.disbursements ?? quote.disbursements)
    .filter((d) => d.description.trim() || Number(d.amountExVat) > 0)
    .map((d, idx) => ({
      id: d.id || `QDISB-${Date.now()}-${idx}`,
      description: d.description.trim() || 'Disbursement',
      amountExVat: Math.max(0, Number(d.amountExVat) || 0),
      vatApplicable: Boolean(d.vatApplicable),
    }));

  const totals = calculateQuoteTotals(
    input.feeAmountExVat,
    input.vatOverridden ? input.vatAmount : null,
    disbursements,
  );

  const followUpAfterDays = Math.max(
    1,
    Number(input.followUpAfterDays) || quote.followUpAfterDays || 7,
  );

  quote.version = nextVersion;
  quote.feeBasis = input.feeBasis;
  quote.feeAmountExVat = totals.feeAmountExVat;
  quote.hourlyRateGbp =
    input.feeBasis === 'Hourly rate with estimate'
      ? Math.max(0, Number(input.hourlyRateGbp) || 0) || null
      : null;
  quote.vatAmount = totals.vatOnFee;
  quote.vatOverridden = Boolean(input.vatOverridden);
  quote.disbursements = disbursements;
  quote.totalIncVat = totals.totalIncVat;
  quote.scope = input.scope.trim();
  quote.assumptions = (input.assumptions ?? '').trim();
  quote.validUntil = input.validUntil || toIsoDate(addDays(now, 30));
  quote.followUpAfterDays = followUpAfterDays;
  quote.outcomeAt = null;
  quote.outcomeNote = undefined;
  quote.declineReason = null;
  quote.declineNote = undefined;
  quote.updatedAt = nowIso;
  quote.updatedById = byId;

  const markSent = Boolean(input.markAsSent);
  if (markSent) {
    quote.status = 'Sent';
    quote.sentAt = nowIso;
    quote.nextFollowUpDate = toIsoDate(addDays(now, followUpAfterDays));
  } else {
    quote.status = 'Draft';
    quote.sentAt = null;
    quote.nextFollowUpDate = null;
  }

  quote.timeline.push({
    id: `QT-${Date.now()}-rev`,
    kind: 'revised',
    at: nowIso,
    byId,
    title: `Revised quote to v${nextVersion} (v${prevVersion} marked Superseded)`,
    detail:
      input.revisionNote?.trim() ||
      `Updated to ${quote.feeBasis} — £${quote.feeAmountExVat.toLocaleString('en-GB')} + VAT`,
  });

  if (markSent) {
    quote.timeline.push({
      id: `QT-${Date.now()}-sent`,
      kind: 'sent',
      at: nowIso,
      byId,
      title: `v${nextVersion} marked as sent`,
      detail: `Next follow-up scheduled for ${quote.nextFollowUpDate}`,
    });
  }

  await intakeRepo.withTenantTransaction(ctx, async () => {
    await intakeRepo.putQuote(ctx, quote);
    writeAudit(null, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'update',
      field: `Quote revised to v${nextVersion}`,
      oldValue: `v${prevVersion} (Superseded)`,
      newValue: `v${nextVersion} — £${quote.feeAmountExVat.toLocaleString('en-GB')} + VAT (${quote.status})`,
      byId,
      at: nowIso,
    });
    await flushStagedAuditEntries(ctx);
  });

  return { quote };
  });
}

export async function recordQuoteOutcomeRecord(
  quoteId: string,
  input: {
    outcome: 'Accepted' | 'Declined';
    declineReason?: QuoteDeclineReason | null;
    note?: string;
  },
  byId: string,
): Promise<{ quote?: Quote; error?: string } & Partial<ActionDenied>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const intakeRepo = getIntakeQuoteRepository();
  const [people, matters, quotes, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(ctx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to record a quote outcome.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility({ teams }, actor, {
    people,
    matters,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  if (input.outcome === 'Declined') {
    if (!input.declineReason) {
      return { error: 'Please select a reason for declining the quote.' };
    }
    if (input.declineReason === 'Other' && !input.note?.trim()) {
      return { error: 'Please provide a note when selecting "Other" as the decline reason.' };
    }
  }

  const nowIso = new Date().toISOString();
  const prevStatus = quote.status;
  quote.status = input.outcome;
  quote.outcomeAt = nowIso;
  quote.nextFollowUpDate = null;
  quote.updatedAt = nowIso;
  quote.updatedById = byId;

  if (input.outcome === 'Accepted') {
    quote.outcomeNote = input.note?.trim() || undefined;
    quote.declineReason = null;
    quote.declineNote = undefined;
    quote.timeline.push({
      id: `QT-${Date.now()}`,
      kind: 'accepted',
      at: nowIso,
      byId,
      title: 'Outcome recorded: Accepted',
      detail: input.note?.trim() || 'Client accepted the quote.',
    });
  } else {
    quote.declineReason = input.declineReason!;
    quote.declineNote = input.note?.trim() || undefined;
    quote.timeline.push({
      id: `QT-${Date.now()}`,
      kind: 'declined',
      at: nowIso,
      byId,
      title: `Outcome recorded: Declined (${input.declineReason})`,
      detail: input.note?.trim() || undefined,
    });
  }

  await intakeRepo.withTenantTransaction(ctx, async () => {
    await intakeRepo.putQuote(ctx, quote);
    writeAudit(null, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'status-change',
      field: 'Quote outcome',
      oldValue: prevStatus,
      newValue:
        input.outcome === 'Declined'
          ? `Declined · ${input.declineReason}${input.note?.trim() ? ` (${input.note.trim()})` : ''}`
          : `Accepted${input.note?.trim() ? ` (${input.note.trim()})` : ''}`,
      byId,
      at: nowIso,
    });
    await flushStagedAuditEntries(ctx);
  });

  return { quote };
  });
}

/**
 * Prepare a quote for conversion to a matter:
 * Ensures a Person and/or Organisation record exists for the client/prospect,
 * links them on the quote, and returns clientId & instructingContactId for /matters/new.
 */
export async function prepareQuoteConversionRecord(
  quoteId: string,
  byId: string,
): Promise<{
  ok: boolean;
  conflictBlocked?: boolean;
  conflictReasons?: string[];
  conflictWarnings?: string[];
  clientId?: string;
  instructingContactId?: string | null;
  quoteId?: string;
  enquiryId?: string | null;
  error?: string;
} & Partial<Omit<ActionDenied, 'ok'>>> {
  return runWithAuditStagingScope(async () => {
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const partyRepo = getPartyRepository();
  const matterRepo = getMatterRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [store, people, organisations, links, matters, enquiries, quotes, teams] = await Promise.all([
    loadTenantCatalogueStoreView(ctx),
    partyRepo.listAllPeople<Person>(ctx),
    partyRepo.listAllOrganisations<Organisation>(ctx),
    partyRepo.listAllLinks<PersonOrganisationLink>(ctx),
    matterRepo.listAllMattersUnfiltered<Matter>(ctx),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx),
    intakeRepo.listAllQuotesUnfiltered<Quote>(ctx),
    getHrAndRbacRepository().listAllTeams<Team>(ctx),
  ]);
  const actor = people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'matter:create', {
      allPeople: people,
      teams,
    })
  ) {
    const msg = 'You do not have permission (matter:create) to convert a quote to a matter.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      ok: false,
      error: msg,
      conflictReasons: [msg],
    };
  }
  const visibility = buildRecordVisibility(store, actor, {
    people,
    matters,
    enquiries,
    quotes,
    teams,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    return { ok: false, error: 'Quote not found.' };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = toIsoDate(now);
  const actorName = actor ? personDisplayName(actor) : byId;
  const actorHasRiskView = hasPersonPermission(actor, 'risk:view', {
    allPeople: people,
    teams,
  });

  let personId = quote.linkedPersonId;
  let orgId = quote.linkedOrganisationId;

  // If linked to an enquiry that already has linkedPersonId / linkedOrganisationId, inherit if missing
  const linkedEnq = quote.linkedEnquiryId
    ? enquiries.find((e) => e.id === quote.linkedEnquiryId)
    : undefined;
  if (linkedEnq) {
    if (!personId && linkedEnq.linkedPersonId) personId = linkedEnq.linkedPersonId;
    if (!orgId && linkedEnq.linkedOrganisationId) orgId = linkedEnq.linkedOrganisationId;
  }

  const hasOrgName = Boolean(quote.prospectOrganisationName.trim());
  const hasPersonName = Boolean(quote.prospectName.trim());
  const existingOrg = orgId ? organisations.find((o) => o.id === orgId) : undefined;
  const existingPerson = personId ? people.find((p) => p.id === personId) : undefined;
  const clientOrgName = existingOrg?.legalName || quote.prospectOrganisationName.trim();
  const clientPersonName = existingPerson
    ? personDisplayName(existingPerson)
    : quote.prospectName.trim();

  const submittedParties: ConflictCheckParty[] = [];
  if (clientOrgName) {
    submittedParties.push({
      id: 'cp-client-1',
      name: clientOrgName,
      entityType: 'organisation',
      role: 'Client',
      linkedRecordId: orgId ?? null,
      isClientFixed: true,
    });
    if (clientPersonName) {
      submittedParties.push({
        id: 'cp-instructing-1',
        name: clientPersonName,
        entityType: 'person',
        role: 'Client contact',
        linkedRecordId: personId ?? null,
        isClientFixed: true,
      });
    }
  } else if (clientPersonName) {
    submittedParties.push({
      id: 'cp-client-1',
      name: clientPersonName,
      entityType: 'person',
      role: 'Client',
      linkedRecordId: personId ?? null,
      isClientFixed: true,
    });
  }

  const enqOtherPartyNames = (linkedEnq?.otherPartiesNamed ?? '')
    .split(/[,;/\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  enqOtherPartyNames.forEach((opName, idx) => {
    submittedParties.push({
      id: `cp-party-${idx + 1}`,
      name: opName,
      entityType: 'organisation',
      role: 'Opponent',
      linkedRecordId: null,
    });
  });

  const effectiveParties = buildEffectiveConflictParties({
    submittedParties,
    clientId: orgId || personId || null,
    instructingContactId: orgId ? personId : null,
    people,
    organisations,
  });

  const rawMatterMatches = searchMatterConflicts(
    {
      currentMatterId: null,
      sourceEnquiryId: quote.linkedEnquiryId ?? null,
      parties: effectiveParties,
      canReviewConditions: actorHasRiskView,
      reviewerUserId: actorHasRiskView ? byId : null,
      reviewerDisplayName: actorHasRiskView ? actorName : null,
      reviewedAtIso: nowIso,
    },
    {
      matters,
      enquiries,
      people,
      organisations,
      links,
      tenantId: getActiveTenantConfiguration().tenantId,
      canView: visibility.canViewMatter,
      canViewEnquiry: visibility.canViewEnquiry,
    },
  );
  const reconciledMatches = reconcileServerConflictMatches({
    serverMatches: rawMatterMatches,
    canReviewConditions: actorHasRiskView,
    reviewerUserId: actorHasRiskView ? byId : null,
    reviewerDisplayName: actorHasRiskView ? actorName : null,
    reviewedAtIso: nowIso,
  });

  const nameParts = clientPersonName.split(/\s+/).filter(Boolean);
  const firstNameForSearch = existingPerson?.firstName ?? (nameParts[0] || '');
  const lastNameForSearch = existingPerson?.surname ?? nameParts.slice(1).join(' ');
  const prelimConflicts = runEnquiryConflictSearch(
    {
      firstName: firstNameForSearch,
      lastName: lastNameForSearch,
      callingOnBehalfOf: clientOrgName,
      otherPartiesNamed: linkedEnq?.otherPartiesNamed ?? '',
      email:
        quote.prospectEmail ||
        existingPerson?.emails[0]?.address ||
        existingOrg?.generalEmail ||
        '',
      phone:
        quote.prospectPhone ||
        existingPerson?.phones[0]?.number ||
        existingOrg?.mainPhone ||
        '',
      linkedPersonId: personId ?? null,
      linkedOrganisationId: orgId ?? null,
    },
    people,
    organisations,
    matters,
    store.values,
    enquiries.filter((e) => visibility.canViewEnquiry(e)),
    quote.linkedEnquiryId ?? null,
    links,
    visibility.canViewMatter,
    getActiveTenantConfiguration().tenantId,
  );

  const hasRestrictedMatch = hasUnapprovedRestrictedMatches(reconciledMatches, []);
  const declinedOrgAssessment = assessDeclinedOrganisation(
    organisations,
    existingOrg,
    clientOrgName,
  );
  const { existingOrgDeclined, hasDeclinedOrgNameMatch } = declinedOrgAssessment;
  const isConflictBlocked =
    existingOrgDeclined ||
    hasRestrictedMatch ||
    prelimConflicts.hasBlockingConflict;

  const totalMatchesCount = Math.max(
    reconciledMatches.length,
    prelimConflicts.allConflicts.length,
  );

  if (isConflictBlocked) {
    const reasons: string[] = [];
    if (declinedOrgAssessment.blockedReason) {
      reasons.push(declinedOrgAssessment.blockedReason);
    }
    if (hasRestrictedMatch) {
      reasons.push(
        'This matter must be referred to Risk because a match was found on a restricted record.',
      );
    }
    for (const hit of prelimConflicts.allConflicts.filter((h) => h.blocking || h.severity === 'high')) {
      if (!reasons.includes(hit.reason)) {
        reasons.push(hit.reason);
      }
    }
    if (reasons.length === 0) {
      reasons.push('This quote cannot convert until its conflict check is cleared or approved by Risk.');
    }

    const decisionSummary = `Potential conflict identified by ${actorName} on ${today} (${totalMatchesCount} ${totalMatchesCount === 1 ? 'match' : 'matches'})`;
    const decisionSnapshot = {
      outcome: 'Potential conflict' as const,
      decidedById: byId,
      decidedByName: actorName,
      decidedAt: nowIso,
      sourceRecordId: quote.id,
      matchesCount: totalMatchesCount,
      searchedSources: [...CONFLICT_SEARCHED_SOURCES],
      summary: decisionSummary,
    };

    // R254: Never overwrite an existing organisation's conflict status or conflictDecision.
    // Record the blocked decision on the quote audit trail (`conflict-decision`, R258).
    await intakeRepo.withTenantTransaction(ctx, async () => {
      writeAudit(store, {
        recordType: 'quote',
        recordId: quote.id,
        action: 'conflict-decision',
        field: 'Quote conversion blocked by conflict check',
        oldValue: null,
        newValue: `${decisionSummary} · ${reasons.join(' · ')}`,
        byId,
        at: nowIso,
        snapshot: decisionSnapshot,
      });
      await flushStagedAuditEntries(ctx);
    });

    return {
      ok: false,
      conflictBlocked: true,
      conflictReasons: reasons,
      error: reasons[0],
    };
  }

  const conflictWarnings = prelimConflicts.allConflicts
    .filter((h) => !h.blocking && h.severity !== 'high')
    .map((h) => h.reason);
  if (
    declinedOrgAssessment.nameMatchWarning &&
    !conflictWarnings.includes(declinedOrgAssessment.nameMatchWarning)
  ) {
    conflictWarnings.push(declinedOrgAssessment.nameMatchWarning);
  }

  // Conflict check passed: determine outcome status from search result, not a hard-coded Cleared
  const hasNonSelfMatches =
    hasDeclinedOrgNameMatch ||
    reconciledMatches.some(
      (m) => m.matchedRecordId !== orgId && m.matchedRecordId !== personId,
    ) ||
    prelimConflicts.allConflicts.length > 0;
  const outcomeLabel: 'Cleared' | 'Potential conflict' = hasNonSelfMatches
    ? 'Potential conflict'
    : 'Cleared';
  const decisionSummary = `${outcomeLabel} by ${actorName} on ${today} (${totalMatchesCount} ${totalMatchesCount === 1 ? 'match' : 'matches'})`;
  const conflictReference = `${quote.reference} · ${decisionSummary}`;
  const decisionSnapshot = {
    outcome: outcomeLabel,
    decidedById: byId,
    decidedByName: actorName,
    decidedAt: nowIso,
    sourceRecordId: quote.id,
    matchesCount: totalMatchesCount,
    searchedSources: [...CONFLICT_SEARCHED_SOURCES],
    summary: decisionSummary,
    ...(conflictWarnings.length > 0 ? { warnings: [...conflictWarnings] } : {}),
  };

  return intakeRepo.withTenantTransaction(ctx, async () => {
    if (!personId && hasPersonName) {
      const parts = quote.prospectName.trim().split(/\s+/);
      const firstName = parts[0] || 'Client';
      const surname = parts.slice(1).join(' ') || 'Contact';

      const createdPerson = await savePersonRecord(
        {
          firstName,
          surname,
          emails: quote.prospectEmail
            ? [
                {
                  id: `em_${Date.now()}`,
                  address: quote.prospectEmail,
                  typeId: vid('email_type', hasOrgName ? 'Work' : 'Personal'),
                  isPrimary: true,
                },
              ]
            : [],
          phones: quote.prospectPhone
            ? [
                {
                  id: `ph_${Date.now()}`,
                  number: quote.prospectPhone,
                  typeId: vid('phone_type', 'Mobile'),
                },
              ]
            : [],
          relationshipStatusId: vid('relationship_status', 'Prospective'),
          relationshipRoleIds: [
            vid('person_role', hasOrgName ? 'Client contact' : 'Private client'),
          ],
          relationshipOwnerId: quote.feeEarnerId || byId,
          sourceId: vid('data_source', 'Manual entry'),
        },
        { byId, internalSystemStep: 'quote_conversion' },
      );
      personId = createdPerson.person.id;
    }

    let createdNewClientOrg = false;
    if (!orgId && hasOrgName) {
      const createdOrg = await saveOrganisationRecord(
        {
          legalName: quote.prospectOrganisationName.trim(),
          generalEmail: quote.prospectEmail,
          mainPhone: quote.prospectPhone,
          relationshipPartnerId: quote.feeEarnerId || byId,
          relationshipTypeIds: [vid('organisation_relationship_type', 'Prospect')],
          relationshipStatusId: vid('relationship_status', 'Prospective'),
          conflictStatusId: vid('conflict_status', outcomeLabel),
          conflictReference,
          reviewDate: today,
          reviewerId: byId,
        },
        { byId, internalSystemStep: 'quote_conversion' },
      );
      orgId = createdOrg.organisation.id;
      createdNewClientOrg = true;

      if (personId && orgId) {
        const personLinks = await partyRepo.listLinksForPerson<PersonOrganisationLink>(
          ctx,
          personId,
        );
        const linkExists = personLinks.some((l) => l.organisationId === orgId);
        if (!linkExists) {
          await createOrUpdateLink(
            {
              personId,
              organisationId: orgId,
              jobTitle: '',
              department: '',
              roleWithinOrganisation: 'Instructing contact',
              contactRoleIds: [vid('contact_role', 'Key relationship contact')],
              isPrimaryContact: true,
              isCurrent: true,
              startDate: today,
              endDate: null,
              contactStatusId: vid('contact_status', 'Active'),
            },
            byId,
            { internalSystemStep: true },
          );
        }
      }
    }

    // R254: Set conflict status and conflictDecision only on organisations created by this conversion.
    if (createdNewClientOrg && orgId) {
      const orgRecord = await partyRepo.getOrganisationById<Organisation>(ctx, orgId);
      if (orgRecord) {
        orgRecord.conflictStatusId = vid('conflict_status', outcomeLabel);
        orgRecord.conflictReference = conflictReference;
        orgRecord.reviewDate = today;
        orgRecord.reviewerId = byId;
        orgRecord.conflictDecision = decisionSnapshot;
        await partyRepo.putOrganisation(ctx, orgRecord);
        writeAudit(store, {
          recordType: 'organisation',
          recordId: orgId,
          action: 'conflict-decision',
          field: 'Conflict check decision recorded on quote conversion',
          oldValue: null,
          newValue: conflictReference,
          byId,
          at: nowIso,
          snapshot: decisionSnapshot,
        });
      }
    }

    writeAudit(store, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'conflict-decision',
      field: 'Conflict check completed on quote conversion',
      oldValue: null,
      newValue: conflictReference,
      byId,
      at: nowIso,
      snapshot: decisionSnapshot,
    });

    quote.conflictDecision = decisionSnapshot;
    quote.linkedPersonId = personId;
    quote.linkedOrganisationId = orgId;
    quote.updatedAt = nowIso;
    quote.updatedById = byId;

    await intakeRepo.putQuote(ctx, quote);
    await flushStagedAuditEntries(ctx);

    const clientId = orgId || personId || '';
    const instructingContactId = orgId ? personId : personId;

    return {
      ok: true,
      clientId,
      instructingContactId,
      quoteId: quote.id,
      enquiryId: quote.linkedEnquiryId,
      ...(conflictWarnings.length > 0 ? { conflictWarnings } : {}),
    };
  });
  });
}

async function finalizeQuoteConversionToMatter(
  store: FirmStore,
  quoteId: string,
  matter: Matter,
  byId: string,
  now: string,
  ctx: TenantContext,
): Promise<void> {
  const intakeRepo = getIntakeQuoteRepository();
  const quote = await intakeRepo.getQuoteById<Quote>(ctx, quoteId, {
    includeRestricted: true,
  });
  if (!quote) return;

  const alreadyConverted = quote.convertedMatterId === matter.id;
  quote.status = 'Accepted';
  quote.convertedMatterId = matter.id;
  if (!quote.outcomeAt) quote.outcomeAt = now;
  quote.nextFollowUpDate = null;
  quote.updatedAt = now;
  quote.updatedById = byId;
  if (quote.conflictDecision) {
    matter.conflictDecision = quote.conflictDecision;
  }

  if (!alreadyConverted) {
    quote.timeline.push({
      id: `QT-${Date.now()}-conv`,
      kind: 'converted',
      at: now,
      byId,
      title: `Converted to matter ${matter.matterNumber === 'DRAFT' ? '(Draft)' : matter.matterNumber}`,
      detail: `${matter.title} (${matter.id})`,
    });

    writeAudit(store, {
      recordType: 'quote',
      recordId: quote.id,
      action: 'convert',
      field: 'Converted to matter',
      oldValue: quote.reference,
      newValue: `${matter.matterNumber} — ${matter.title} (${matter.id})`,
      byId,
      at: now,
    });
  }

  await intakeRepo.putQuote(ctx, quote);

  // Also close any linked enquiry and link it to the matter
  if (quote.linkedEnquiryId) {
    if (!matter.sourceEnquiryId) {
      matter.sourceEnquiryId = quote.linkedEnquiryId;
    }
    await finalizeEnquiryConversionToMatter(
      store,
      quote.linkedEnquiryId,
      matter,
      byId,
      now,
      ctx,
    );
  }
}

export async function saveMatterCostsConfig(
  config: MatterCostsConfig,
  byId: string,
): Promise<MatterCostsConfig> {
  const tenantCfg = getActiveTenantConfiguration();
  if (!tenantCfg.featureFlags?.enableMatterCostsGovernance) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message:
        'Forbidden: Matter costs governance is disabled for this tenant (featureFlags.enableMatterCostsGovernance is false).',
      tenantId: tenantCfg.tenantId,
      correlationId: `corr-costs-cfg-${randomUUID()}`,
      actorUserId: byId,
    });
  }
  const ctx = resolveDefaultServiceTenantContext(null, byId);
  const catalogueRepo = getCatalogueRepository();
  const now = new Date().toISOString();
  const next: MatterCostsConfig = {
    ...config,
    updatedAt: now,
    updatedById: byId,
  };
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      await catalogueRepo.putMatterCostsConfig(ctx, next, byId);
      writeAudit(null, {
        recordType: 'matter',
        recordId: 'FIRM-MATTER-COSTS-CONFIG',
        action: 'update',
        field: 'Matter Costs & Rates Table Config',
        oldValue: null,
        newValue: `${next.clientProfileName} (${next.rateSourceMode}, ${next.rateCards.length} rate cards)`,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return next;
}

export async function syncMatterCostsRatesFromPms(
  byId: string,
  options?: { tenantCtx?: TenantContext | null },
): Promise<MatterCostsConfig> {
  const tenantCfg = getActiveTenantConfiguration();
  if (!tenantCfg.featureFlags?.enablePmsLiveRateSync) {
    throw new AuthorisationError({
      code: 'FORBIDDEN',
      message:
        'Forbidden: PMS live rate sync is disabled for this tenant (featureFlags.enablePmsLiveRateSync is false).',
      tenantId: tenantCfg.tenantId,
      correlationId: `corr-pms-rates-${randomUUID()}`,
      actorUserId: byId,
    });
  }
  const ctx = resolveDefaultServiceTenantContext(null, byId, options);
  const catalogueRepo = getCatalogueRepository();
  let next!: MatterCostsConfig;
  await runWithAuditStagingScope(() =>
    catalogueRepo.withTenantTransaction(ctx, async () => {
      const [store, pms] = await Promise.all([
        loadTenantCatalogueStoreView(ctx),
        getTenantPmsSource(ctx),
      ]);
      const feeEarners = pms.listFeeEarners();
      const base =
        store.matterCostsConfig ??
        createDefaultMatterCostsConfig(store.values, {
          clientProfileCode: tenantCfg.tenantId,
          displayName: tenantCfg.displayName,
          primaryDomain: tenantCfg.branding.primaryDomain,
        });
      const synced = syncRateCardsWithPmsFeeEarners(
        base,
        feeEarners,
        store.values,
      );
      const now = new Date().toISOString();
      next = {
        ...synced,
        pmsLinkActive: true,
        updatedAt: now,
        updatedById: byId,
      };
      await catalogueRepo.putMatterCostsConfig(ctx, next, byId);
      writeAudit(null, {
        recordType: 'matter',
        recordId: 'FIRM-MATTER-COSTS-CONFIG',
        action: 'update',
        field: 'PMS Rate Cards Sync',
        oldValue: base.pmsLastSyncedAt ?? 'Never',
        newValue: `Synced ${feeEarners.length} fee earner rates from PMS (${now})`,
        byId,
        at: now,
      });
      await flushStagedAuditEntries(ctx);
    }),
  );
  return next;
}

export async function resolveOrProvisionEntraEmployee(
  claims: EntraIdRawTokenClaims & Record<string, unknown>,
  options?: { correlationId?: string },
): Promise<{
  person: Person;
  verifiedToken: VerifiedOidcTokenClaims;
  rbacConfig: RbacConfiguration;
}> {
  const activeTenantConfig = getActiveTenantConfiguration();
  const activeTenantId = activeTenantConfig.tenantId;
  const correlationId = resolveRequestCorrelationId(
    options?.correlationId ??
      (getActiveActorSession() as { correlationId?: string } | null)
        ?.correlationId,
    'corr-entra-signin',
  );
  const defaultRbacConfig = getDefaultTenantRbacConfig(activeTenantId);
  const {
    verifiedToken,
  } = resolvePersonForEntraClaims({
    claims,
    people: [],
    teams: [],
    tenantId: activeTenantId,
    rbacConfig: defaultRbacConfig,
    primaryDomain: activeTenantConfig.branding.primaryDomain,
  });

  const now = new Date().toISOString();
  const oid = claims.oid?.trim() || verifiedToken.sub;
  const claimEmail = (
    claims.preferred_username ||
    claims.upn ||
    (claims.xms_edov === true ? claims.email : '') ||
    ''
  ).trim();
  const signInCtx = resolveCurrentTenantContext(
    createSignInActorFromVerifiedOidcToken(verifiedToken, {
      oid,
      email:
        verifiedToken.email ||
        `${verifiedToken.sub}@${activeTenantConfig.branding.primaryDomain}`,
      correlationId,
    }),
    activeTenantConfig,
  );
  const hrRepo = getHrAndRbacRepository();
  const [prelimPeople, prelimTeams, dbRbacOverride] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(signInCtx),
    hrRepo.listAllTeams<Team>(signInCtx),
    hrRepo.getRbacConfigOverride<RbacConfiguration>(signInCtx),
  ]);
  const rbacConfig = await loadEffectiveTenantRbacConfig(
    signInCtx,
    dbRbacOverride,
  );
  if (claimEmail) {
    await getPartyRepository().findActivePeopleByEmail(signInCtx, claimEmail);
  }
  const {
    ambiguousEmailMatchPersonIds,
    refusedPrivilegedEmailLinkPersonId,
  } = resolvePersonForEntraClaims({
    claims,
    people: prelimPeople,
    teams: prelimTeams,
    tenantId: activeTenantId,
    rbacConfig,
    primaryDomain: activeTenantConfig.branding.primaryDomain,
  });
  const authorityMode = rbacConfig.identityMapping?.authorityMode ?? 'hybrid';

  if (refusedPrivilegedEmailLinkPersonId) {
    await appendTenantAuditEntries(signInCtx, [
      {
        recordType: 'person',
        recordId: refusedPrivilegedEmailLinkPersonId,
        action: 'entra-link',
        field: 'Entra ID Email Link Refused',
        oldValue: 'unlinked',
        newValue: `Refused automatic email link for privileged employee ${refusedPrivilegedEmailLinkPersonId} (correlationId=${correlationId})`,
        byId: 'system',
        at: now,
      },
    ]);
    console.warn(
      JSON.stringify({
        event: 'ENTRA_EMAIL_LINK_PRIVILEGED_REFUSED',
        tenantId: activeTenantId,
        correlationId,
        personId: refusedPrivilegedEmailLinkPersonId,
      }),
    );
    throw new Error('Your account needs to be linked by an administrator.');
  }

  if (ambiguousEmailMatchPersonIds && ambiguousEmailMatchPersonIds.length > 1) {
    await appendTenantAuditEntries(signInCtx, [
      {
        recordType: 'person',
        recordId: ambiguousEmailMatchPersonIds[0]!,
        action: 'entra-link',
        field: 'Entra ID Email Link Ambiguous',
        oldValue: 'unlinked',
        newValue: `Refused automatic email link across ${ambiguousEmailMatchPersonIds.length} unbound employees (${ambiguousEmailMatchPersonIds.join(', ')}; correlationId=${correlationId})`,
        byId: 'system',
        at: now,
      },
    ]);
    console.warn(
      JSON.stringify({
        event: 'ENTRA_EMAIL_LINK_AMBIGUOUS',
        tenantId: activeTenantId,
        correlationId,
        candidateCount: ambiguousEmailMatchPersonIds.length,
      }),
    );
    throw new Error('Your account needs to be linked by an administrator.');
  }

  return runWithAuditStagingScope(async () => {
    const partyRepo = getPartyRepository();
    const [people, teams] = await Promise.all([
      partyRepo.listAllPeople<Person>(signInCtx),
      hrRepo.listAllTeams<Team>(signInCtx),
    ]);
    const {
      person: matchedPerson,
      matchedByEmailOnly,
    } = resolvePersonForEntraClaims({
      claims,
      people,
      teams,
      tenantId: activeTenantId,
      rbacConfig,
      primaryDomain: activeTenantConfig.branding.primaryDomain,
    });

    if (matchedPerson) {
      const prevOid = matchedPerson.entraObjectId?.trim() || null;
      const isFirstEmailLink = Boolean(matchedByEmailOnly && !prevOid && oid);
      await partyRepo.withTenantTransaction(signInCtx, async () => {
        if (isFirstEmailLink && oid) {
          matchedPerson.entraObjectId = oid;
          writeAudit(null, {
            recordType: 'person',
            recordId: matchedPerson.id,
            action: 'entra-link',
            field: 'Entra ID Email Link',
            oldValue: 'unlinked',
            newValue: `Linked employee ${matchedPerson.id} on first verified-domain sign-in`,
            byId: matchedPerson.id,
            at: now,
          });
          console.info(
            JSON.stringify({
              event: 'ENTRA_EMAIL_LINK_BOUND',
              tenantId: activeTenantId,
              correlationId,
              personId: matchedPerson.id,
            }),
          );
        }
        if (authorityMode === 'token_only') {
          matchedPerson.roles = [...verifiedToken.roles];
          matchedPerson.appRole = matchedPerson.roles.includes('admin')
            ? 'admin'
            : matchedPerson.roles.length > 0
              ? 'fee_earner'
              : null;
          if (matchedPerson.roles.length === 0) {
            matchedPerson.employeeRoleId = null;
          } else if (matchedPerson.roles.includes('admin')) {
            matchedPerson.employeeRoleId = 'employee_role.system_administrator';
          }
        }
        matchedPerson.updatedAt = now;
        await partyRepo.putPerson(signInCtx, matchedPerson);
        writeAudit(null, {
          recordType: 'person',
          recordId: matchedPerson.id,
          action: 'update',
          field: 'Entra ID OIDC Sign-In',
          oldValue: prevOid ? 'bound' : 'unlinked',
          newValue: `personId=${matchedPerson.id}; roles=${verifiedToken.roles.join(',') || 'none'}; mfa=${verifiedToken.mfaVerified}; correlationId=${correlationId}`,
          byId: matchedPerson.id,
          at: now,
        });
        await flushStagedAuditEntries(signInCtx);
      });
      return { person: matchedPerson, verifiedToken, rbacConfig };
    }

    // Provision a linked employee record for this authenticated Entra user (R52: no default 'admin' or hardcoded 'DEPT-EXEC')
    const rawName =
      (typeof claims.name === 'string' && claims.name.trim()) ||
      claimEmail.split('@')[0] ||
      'Entra User';
    const nameParts = rawName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || 'Entra';
    const surname = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'User';

    const defaultRoleKeys = rbacConfig.identityMapping?.defaultRoleKeys ?? [];
    const mappedRoles =
      verifiedToken.roles.length > 0
        ? [...verifiedToken.roles]
        : [...defaultRoleKeys];
    const isAdmin = mappedRoles.includes('admin');
    const isPartner =
      mappedRoles.includes('managing_partner') || mappedRoles.includes('partner');

    let newEmployee!: Person;
    await partyRepo.withTenantTransaction(signInCtx, async () => {
      const newId = await partyRepo.allocateNextPersonId(signInCtx);
      newEmployee = {
        id: newId,
        recordType: 'person',
        recordOwnerId: newId,
        recordStatusId: 'person_record_status.active',
        createdById: newId,
        createdAt: now,
        updatedById: newId,
        updatedAt: now,
        sourceId: null,
        lastVerifiedAt: now,
        tags: ['entra-id'],
        duplicateStatusId: 'duplicate_status.none',
        notDuplicateOf: [],
        possibleMatchIds: [],
        mergedIntoId: null,
        lastInteractionAt: now,
        customFields: {},
        titleId: null,
        firstName,
        middleNames: '',
        surname,
        preferredName: '',
        dateOfBirth: null,
        otherNames: [],
        jobTitle: isAdmin
          ? 'System Administrator (Entra ID)'
          : isPartner
            ? 'Partner (Entra ID)'
            : mappedRoles.length > 0
              ? 'Solicitor (Entra ID)'
              : 'Unassigned Employee (Entra ID)',
        emails: claimEmail
          ? [
              {
                id: `em-${newId}-1`,
                address: claimEmail,
                typeId: 'email_type.work',
                isPrimary: true,
              },
            ]
          : [],
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
        firstKnownAt: now.slice(0, 10),
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
        isEmployee: true,
        employeeRoleId: isAdmin
          ? 'employee_role.system_administrator'
          : isPartner
            ? 'employee_role.partner'
            : mappedRoles.length > 0
              ? 'employee_role.solicitor'
              : null,
        departmentId: null,
        appRole: isAdmin ? 'admin' : mappedRoles.length > 0 ? 'fee_earner' : null,
        roles: mappedRoles,
        entraObjectId: oid,
      };

      await partyRepo.putPerson(signInCtx, newEmployee);
      writeAudit(null, {
        recordType: 'person',
        recordId: newEmployee.id,
        action: 'create',
        field: 'Entra ID OIDC Provisioned Employee',
        oldValue: null,
        newValue: `personId=${newEmployee.id}; roles=${mappedRoles.join(',') || 'none'}; mfa=${verifiedToken.mfaVerified}; correlationId=${correlationId}`,
        byId: newEmployee.id,
        at: now,
      });
      await flushStagedAuditEntries(signInCtx);
    });

    return { person: newEmployee, verifiedToken, rbacConfig };
  });
}

// ============================================================================
// Key Dates & Limitation Module Service Functions (§1–§9)
// ============================================================================

function resolveActorFromPeopleForKeyDates(
  people: readonly Person[],
  byId: string,
): Person | null {
  if (!byId || !byId.trim()) return null;
  return (
    people.find((p) => p.id === byId && p.isEmployee && !p.mergedIntoId) ??
    null
  );
}

async function resolveKeyDatesActorAndData(
  store: FirmStore | null,
  byId: string,
  options?: { tenantCtx?: TenantContext | null },
): Promise<{
  ctx: TenantContext;
  actor: Person | null;
  people: Person[];
  matters: Matter[];
  teams: Team[];
} | null> {
  if (!byId || !byId.trim()) return null;
  let prelimCtx: TenantContext;
  try {
    prelimCtx = resolveDefaultServiceTenantContext(store, null, {
      tenantCtx: options?.tenantCtx,
    });
  } catch {
    return null;
  }
  const [people, matters, teams] = await Promise.all([
    getPartyRepository().listAllPeople<Person>(prelimCtx),
    getMatterRepository().listAllMattersUnfiltered<Matter>(prelimCtx),
    getHrAndRbacRepository().listAllTeams<Team>(prelimCtx),
  ]);
  const actor = resolveActorFromPeopleForKeyDates(people, byId);
  if (!actor) {
    return { ctx: prelimCtx, actor: null, people, matters, teams };
  }
  const ctx = resolveDefaultServiceTenantContext(store, actor.id, {
    tenantCtx: options?.tenantCtx,
  });
  return { ctx, actor, people, matters, teams };
}

function assertKeyDatesModuleEnabled(
  config: KeyDatesConfig,
): { ok: false; error: string } | null {
  if (!config.enabled) {
    return {
      ok: false,
      error:
        'KEY_DATES_MODULE_DISABLED: The Key Dates & Limitation module is disabled for this tenant.',
    };
  }
  return null;
}

async function commitKeyDateDomainWritesInPostgres(params: {
  ctx: TenantContext;
  keyDatesToUpsert?: readonly KeyDate[];
  notApplicableToUpsert?: readonly KeyDateNotApplicable[];
  reminderStatesToUpsert?: KeyDateReminderState[];
  calendarSyncsToUpsert?: readonly KeyDateCalendarSync[];
  tasksToUpsert?: Task[];
  tasksToDeleteIds?: readonly string[];
  notificationsToUpsert?: NotificationItem[];
  auditEntries: AuditEntry[];
  allowSystemSchedulerWrite?: boolean;
}): Promise<void> {
  const keyDateRepo = getKeyDateRepository();
  const taskRepo = getTaskWorkflowRepository();
  await keyDateRepo.withTenantTransaction(params.ctx, async (tx) => {
    for (const deletedId of params.tasksToDeleteIds ?? []) {
      await tx.query('DELETE FROM tasks WHERE tenant_id = $1 AND id = $2', [
        params.ctx.tenantId,
        deletedId,
      ]);
    }
    for (const t of params.tasksToUpsert ?? []) {
      if (t.id.startsWith('TSK-PENDING-')) {
        const oldId = t.id;
        const realId = await taskRepo.allocateNextTaskId(params.ctx);
        t.id = realId;
        t.reference = realId;
        for (const rs of params.reminderStatesToUpsert ?? []) {
          if (rs.taskId === oldId) rs.taskId = realId;
        }
        for (const a of params.auditEntries) {
          if (a.recordId === oldId) a.recordId = realId;
        }
      }
      await taskRepo.putTask(params.ctx, t);
    }
    for (const n of params.notificationsToUpsert ?? []) {
      if (n.id.startsWith('NTF-PENDING-')) {
        n.id = await taskRepo.allocateNextNotificationId(params.ctx);
      }
      await taskRepo.putNotification(params.ctx, n);
    }
    for (const kd of params.keyDatesToUpsert ?? []) {
      await keyDateRepo.putKeyDate(params.ctx, kd);
    }
    for (const na of params.notApplicableToUpsert ?? []) {
      await keyDateRepo.putNotApplicable(params.ctx, na);
    }
    for (const rs of params.reminderStatesToUpsert ?? []) {
      await keyDateRepo.putReminderState(params.ctx, rs, {
        allowSystemSchedulerWrite: params.allowSystemSchedulerWrite,
      });
    }
    for (const cs of params.calendarSyncsToUpsert ?? []) {
      await keyDateRepo.putCalendarSync(params.ctx, cs);
    }
    if (params.auditEntries.length > 0) {
      const auditInputs: FirmAuditEntryInput[] = params.auditEntries.map((a) => ({
        ...(a.id && !a.id.startsWith('AU-PENDING') ? { id: a.id } : {}),
        recordType: a.recordType,
        recordId: a.recordId,
        action: a.action,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        byId: a.byId,
        at: a.at,
        ...(a.reason !== undefined ? { reason: a.reason } : {}),
        ...(a.snapshot !== undefined ? { snapshot: a.snapshot } : {}),
      }));
      await appendTenantAuditEntries(params.ctx, auditInputs);
    }
  });
}

export async function getMatterKeyDatesSnapshot(
  matterId: string,
  userId: string,
): Promise<{
  keyDates: KeyDate[];
  keyDateNotApplicable: KeyDateNotApplicable[];
  keyDateReminderStates: KeyDateReminderState[];
  keyDateCalendarSyncs: KeyDateCalendarSync[];
  canVerifyByKeyDateId: Record<string, { allowed: boolean; reason?: string }>;
}> {
  let resolved: Awaited<ReturnType<typeof resolveKeyDatesActorAndData>> = null;
  try {
    resolved = await resolveKeyDatesActorAndData(null, userId);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.actor) {
    return {
      keyDates: [],
      keyDateNotApplicable: [],
      keyDateReminderStates: [],
      keyDateCalendarSyncs: [],
      canVerifyByKeyDateId: {},
    };
  }
  const { ctx, actor: user, people, matters, teams } = resolved;
  const config = await getKeyDatesConfig({ ctx, userId: user.id });
  if (
    !hasKeyDatePermission(user, 'keydate:view', {
      config,
      allPeople: people,
      teams,
    })
  ) {
    return {
      keyDates: [],
      keyDateNotApplicable: [],
      keyDateReminderStates: [],
      keyDateCalendarSyncs: [],
      canVerifyByKeyDateId: {},
    };
  }
  const matter = matters.find((m) => m.id === matterId);
  if (!matter || !canViewerAccessMatterKeyDates(matter, user.id, user, people)) {
    return {
      keyDates: [],
      keyDateNotApplicable: [],
      keyDateReminderStates: [],
      keyDateCalendarSyncs: [],
      canVerifyByKeyDateId: {},
    };
  }
  const keyDateRepo = getKeyDateRepository();
  const [keyDates, keyDateNotApplicable, allReminders, allCalendarSyncs] =
    await Promise.all([
      keyDateRepo.listKeyDatesForMatter(ctx, matter.id, user.id),
      keyDateRepo.listNotApplicableForMatter(ctx, matter.id, user.id),
      keyDateRepo.listAllReminderStates(ctx, user.id),
      keyDateRepo.listAllVisibleCalendarSyncs(ctx, user.id),
    ]);
  const keyDateIdSet = new Set(keyDates.map((kd) => kd.id));
  const keyDateReminderStates = allReminders.filter((rs) =>
    keyDateIdSet.has(rs.keyDateId),
  );
  const keyDateCalendarSyncs = allCalendarSyncs.filter((cs) =>
    keyDateIdSet.has(cs.keyDateId),
  );
  const canVerifyByKeyDateId: Record<
    string,
    { allowed: boolean; reason?: string }
  > = {};
  for (const kd of keyDates) {
    canVerifyByKeyDateId[kd.id] = canUserVerifyKeyDate(user, kd, {
      config,
      allPeople: people,
      teams,
    });
  }
  return {
    keyDates,
    keyDateNotApplicable,
    keyDateReminderStates,
    keyDateCalendarSyncs,
    canVerifyByKeyDateId,
  };
}

export async function previewLimitationCalculationRecord(
  input: {
    ruleSetId: string;
    ruleId: string;
    triggerValues: Record<string, string>;
    standstillPeriods?: StandstillPeriod[];
    calendarCodeOverride?: string;
  },
  byId: string,
): Promise<{ ok: boolean; result?: CalculationResult; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    if (
      !hasKeyDatePermission(actor, 'keydate:view', {
        config,
        allPeople: people,
        teams,
      })
    ) {
      return {
        ok: false,
        error:
          'KEY_DATE_PERMISSION_DENIED: You need "keydate:view" permission to preview limitation calculations.',
      };
    }
    const found = findLimitationRule(config, input.ruleSetId, input.ruleId);
    if (!found) {
      return {
        ok: false,
        error: `Rule "${input.ruleId}" in rule set "${input.ruleSetId}" was not found.`,
      };
    }
    const calCode =
      input.calendarCodeOverride ||
      found.rule.calendarId ||
      config.businessCalendars?.[0]?.id;
    const calendar = findBusinessCalendar(config, calCode);
    const result = calculateLimitationDate(
      found.rule,
      {
        ...input.triggerValues,
        ...(input.standstillPeriods ? { standstillPeriods: input.standstillPeriods } : {}),
      },
      calendar,
      { ruleSetReviewStatus: found.ruleSet.reviewStatus },
    );
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Calculation failed.',
    };
  }
}

export async function createOrProposeKeyDateRecord(
  input: {
    matterId?: string;
    enquiryId?: string;
    keyDateTypeId: string;
    title?: string;
    dueDate: string;
    dueTime?: string;
    isCritical?: boolean;
    source?: KeyDateSource;
    teamId?: string;
    responsiblePersonIds?: string[];
    calculation?: KeyDateCalculation;
    notes?: string;
    sourceDocumentId?: string;
    intent?: 'provisional' | 'propose';
  },
  byId: string,
): Promise<{
  ok: boolean;
  keyDate?: KeyDate;
  error?: string;
  denied?: true;
  code?: ActionDenied['code'];
  message?: string;
}> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const matter = input.matterId
      ? matters.find((m) => m.id === input.matterId) ?? null
      : null;
    const enquiry = input.enquiryId
      ? await getIntakeQuoteRepository().getEnquiryById<Enquiry>(ctx, input.enquiryId, {
          includeRestricted: true,
        })
      : null;

    if (
      input.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    const resolvedSource = resolveKeyDateSource({
      source: input.source,
      hasCalculation: Boolean(input.calculation),
      allowSystemSource: false,
    });
    if (!resolvedSource.ok) {
      return buildActionDenied('FORBIDDEN', resolvedSource.error);
    }
    const manualCheck = validateKeyDateManualEntry(
      config,
      input.keyDateTypeId,
      resolvedSource.source,
    );
    if (!manualCheck.ok) {
      return buildActionDenied('FORBIDDEN', manualCheck.error);
    }

    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const newKdId = await keyDateRepo.allocateNextKeyDateId(ctx);
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    const kd = createOrProposeKeyDate({
      id: newKdId,
      matter,
      enquiry,
      keyDateTypeId: input.keyDateTypeId,
      title: input.title,
      dueDate: input.dueDate,
      dueTime: input.dueTime,
      isCritical: input.isCritical,
      source: resolvedSource.source,
      teamId: input.teamId,
      responsiblePersonIds: input.responsiblePersonIds,
      calculation: input.calculation,
      notes: input.notes,
      sourceDocumentId: input.sourceDocumentId,
      intent: input.intent,
      actor,
      nowIso,
      config,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const reminderStatesWorking: KeyDateReminderState[] = [];
    const calendarSyncsWorking: KeyDateCalendarSync[] = [];
    let changedTasks: Task[] = [];
    let deletedTaskIds: string[] = [];

    if (kd.status === 'confirmed') {
      const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
      const beforeTaskJsonById = new Map(
        storeTasks.map((t) => [t.id, JSON.stringify(t)]),
      );
      let pendingTaskIdx = 0;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: reminderStatesWorking,
        matters: matter ? [matter] : [],
        people,
        audit: stagedAudit,
        nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: ctx.tenantId,
        nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
      });
      changedTasks = storeTasks.filter(
        (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
      );
      const currentIds = new Set(storeTasks.map((t) => t.id));
      deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
        (id) => !currentIds.has(id),
      );
    }

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      reminderStatesToUpsert: reminderStatesWorking,
      calendarSyncsToUpsert: calendarSyncsWorking,
      tasksToUpsert: changedTasks,
      tasksToDeleteIds: deletedTaskIds,
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to create key date.',
    };
  }
}

export async function proposeProvisionalKeyDateRecord(
  keyDateId: string,
  byId: string,
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      actor,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd, matter, enquiry } = loaded;
    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();

    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    proposeProvisionalKeyDate({
      keyDate: kd,
      actor,
      nowIso,
      config,
      matter,
      enquiry,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const existingReminder = await keyDateRepo.getReminderState(ctx, kd.id, actor.id);
    const reminderStatesWorking: KeyDateReminderState[] = existingReminder
      ? [existingReminder]
      : [];
    const existingSync = await keyDateRepo.getCalendarSync(ctx, kd.id, actor.id);
    const calendarSyncsWorking: KeyDateCalendarSync[] = existingSync
      ? [existingSync]
      : [];

    let changedTasks: Task[] = [];
    let deletedTaskIds: string[] = [];
    if (kd.status === 'confirmed') {
      const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
      const beforeTaskJsonById = new Map(
        storeTasks.map((t) => [t.id, JSON.stringify(t)]),
      );
      let pendingTaskIdx = 0;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: reminderStatesWorking,
        matters: matter ? [matter] : [],
        people,
        audit: stagedAudit,
        nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: ctx.tenantId,
        nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
      });
      changedTasks = storeTasks.filter(
        (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
      );
      const currentIds = new Set(storeTasks.map((t) => t.id));
      deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
        (id) => !currentIds.has(id),
      );
    }

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      reminderStatesToUpsert: reminderStatesWorking,
      calendarSyncsToUpsert: calendarSyncsWorking,
      tasksToUpsert: changedTasks,
      tasksToDeleteIds: deletedTaskIds,
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to propose key date.',
    };
  }
}

async function loadKeyDateForActorOrClassifyError(
  ctx: TenantContext,
  _store: FirmStore | null,
  keyDateId: string,
  actor: Person,
  people: readonly Person[],
  matters: readonly Matter[],
  _teams: readonly Team[],
): Promise<{ kd: KeyDate | null; error?: string; matter: Matter | null; enquiry: Enquiry | null }> {
  const keyDateRepo = getKeyDateRepository();
  const kd = await keyDateRepo.getKeyDateById(ctx, keyDateId, actor.id);
  if (!kd) {
    // Distinguish missing key date vs restricted/orphan matter key date (R30, R82):
    const probeExists = await keyDateRepo.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{ matter_id: string | null }>(
        'SELECT matter_id FROM key_dates WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, keyDateId],
      );
      return res.rows[0] ?? null;
    });
    if (probeExists?.matter_id) {
      return { kd: null, error: 'Matter not found or restricted.', matter: null, enquiry: null };
    }
    return { kd: null, error: 'Key date not found.', matter: null, enquiry: null };
  }
  const matter = kd.matterId
    ? matters.find((m) => m.id === kd.matterId) ?? null
    : null;
  const enquiry = kd.enquiryId
    ? await getIntakeQuoteRepository().getEnquiryById<Enquiry>(ctx, kd.enquiryId, {
        includeRestricted: true,
      })
    : null;
  if (
    kd.matterId &&
    (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, people as Person[]))
  ) {
    return { kd: null, error: 'Matter not found or restricted.', matter: null, enquiry: null };
  }
  return { kd, matter, enquiry };
}

export async function verifyProposedKeyDateRecord(
  keyDateId: string,
  byId: string,
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor: verifier, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: verifier.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      verifier,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd, matter, enquiry } = loaded;
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    verifyProposedKeyDate({
      keyDate: kd,
      verifier,
      nowIso,
      config,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const reminderStatesWorking = await keyDateRepo.listAllReminderStates(
      ctx,
      verifier.id,
    );
    const calendarSyncsWorking = await keyDateRepo.listAllVisibleCalendarSyncs(
      ctx,
      verifier.id,
    );

    const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
    const beforeTaskJsonById = new Map(
      storeTasks.map((t) => [t.id, JSON.stringify(t)]),
    );
    let pendingTaskIdx = 0;
    syncReminderForConfirmedKeyDate({
      keyDate: kd,
      config,
      tasks: storeTasks,
      reminderStates: reminderStatesWorking,
      matters: matter ? [matter] : [],
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
      todayIso,
      nowIso,
      actorId: verifier.id,
      tenantId: ctx.tenantId,
      nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
      transferredFromKeyDateId: kd.supersedesKeyDateId,
    });

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });

    const changedTasks = storeTasks.filter(
      (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
    );
    const currentIds = new Set(storeTasks.map((t) => t.id));
    const deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
      (id) => !currentIds.has(id),
    );

    const targetReminders = reminderStatesWorking.filter(
      (rs) => rs.keyDateId === kd.id || rs.keyDateId === kd.supersedesKeyDateId,
    );
    const targetSyncs = calendarSyncsWorking.filter((cs) => cs.keyDateId === kd.id);

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      reminderStatesToUpsert: targetReminders,
      calendarSyncsToUpsert: targetSyncs,
      tasksToUpsert: changedTasks,
      tasksToDeleteIds: deletedTaskIds,
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to verify key date.',
    };
  }
}

export async function rejectProposedKeyDateRecord(
  keyDateId: string,
  reason: string,
  byId: string,
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor: verifier, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: verifier.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      verifier,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd } = loaded;
    const nowIso = new Date().toISOString();
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    rejectProposedKeyDate({
      keyDate: kd,
      verifier,
      reason,
      nowIso,
      config,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to reject key date.',
    };
  }
}

export async function supersedeConfirmedKeyDateRecord(
  keyDateId: string,
  updates: {
    title?: string;
    dueDate: string;
    dueTime?: string;
    isCritical?: boolean;
    source?: 'manual' | 'calculated';
    teamId?: string;
    responsiblePersonIds?: string[];
    calculation?: KeyDateCalculation;
    notes?: string;
    intent?: 'provisional' | 'propose';
  },
  reason: string,
  byId: string,
): Promise<{
  ok: boolean;
  supersededKeyDate?: KeyDate;
  replacementKeyDate?: KeyDate;
  error?: string;
  denied?: true;
  code?: ActionDenied['code'];
  message?: string;
}> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      actor,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd: existing, matter, enquiry } = loaded;
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const resolvedSupersede = resolveSupersedeKeyDateSource({
      existingKeyDate: existing,
      updates,
      reason,
      config,
      allowSystemSource: false,
    });
    if (!resolvedSupersede.ok) {
      return buildActionDenied('FORBIDDEN', resolvedSupersede.error);
    }
    const manualCheck = validateKeyDateManualEntry(
      config,
      existing.keyDateTypeId,
      resolvedSupersede.source,
    );
    if (!manualCheck.ok) {
      return buildActionDenied('FORBIDDEN', manualCheck.error);
    }

    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const newKeyDateId = await keyDateRepo.allocateNextKeyDateId(ctx);
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    const { supersededKeyDate, replacementKeyDate } = supersedeConfirmedKeyDate({
      existingKeyDate: existing,
      newKeyDateId,
      updates,
      reason,
      actor,
      nowIso,
      config,
      matter,
      enquiry,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const reminderStatesWorking = await keyDateRepo.listAllReminderStates(
      ctx,
      actor.id,
    );
    const calendarSyncsWorking = await keyDateRepo.listAllVisibleCalendarSyncs(
      ctx,
      actor.id,
    );

    const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
    const beforeTaskJsonById = new Map(
      storeTasks.map((t) => [t.id, JSON.stringify(t)]),
    );
    let pendingTaskIdx = 0;
    syncReminderForConfirmedKeyDate({
      keyDate: replacementKeyDate,
      config,
      tasks: storeTasks,
      reminderStates: reminderStatesWorking,
      matters: matter ? [matter] : [],
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
      todayIso,
      nowIso,
      actorId: actor.id,
      tenantId: ctx.tenantId,
      nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
      transferredFromKeyDateId: supersededKeyDate.id,
    });

    await syncKeyDateToOutlookCalendar({
      keyDate: supersededKeyDate,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });
    await syncKeyDateToOutlookCalendar({
      keyDate: replacementKeyDate,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });

    const changedTasks = storeTasks.filter(
      (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
    );
    const currentIds = new Set(storeTasks.map((t) => t.id));
    const deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
      (id) => !currentIds.has(id),
    );

    await keyDateRepo.withTenantTransaction(ctx, async (tx) => {
      for (const deletedId of deletedTaskIds) {
        await tx.query('DELETE FROM tasks WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          deletedId,
        ]);
      }
      for (const t of changedTasks) {
        if (t.id.startsWith('TSK-PENDING-')) {
          const oldId = t.id;
          const realId = await taskRepo.allocateNextTaskId(ctx);
          t.id = realId;
          t.reference = realId;
          for (const rs of reminderStatesWorking) {
            if (rs.taskId === oldId) rs.taskId = realId;
          }
          for (const a of stagedAudit) {
            if (a.recordId === oldId) a.recordId = realId;
          }
        }
        await taskRepo.putTask(ctx, t);
      }

      // Insert replacement first without supersededBy link on existing, then link both cleanly
      const replacementFirst = { ...replacementKeyDate };
      await keyDateRepo.putKeyDate(ctx, {
        ...supersededKeyDate,
        supersededByKeyDateId: undefined,
      });
      await keyDateRepo.putKeyDate(ctx, replacementFirst);
      await keyDateRepo.putKeyDate(ctx, supersededKeyDate);

      if (!reminderStatesWorking.some((rs) => rs.keyDateId === supersededKeyDate.id)) {
        await keyDateRepo.removeReminderState(ctx, supersededKeyDate.id);
      }
      for (const rs of reminderStatesWorking) {
        if (
          rs.keyDateId === replacementKeyDate.id ||
          rs.keyDateId === supersededKeyDate.id
        ) {
          await keyDateRepo.putReminderState(ctx, rs);
        }
      }
      for (const cs of calendarSyncsWorking) {
        if (
          cs.keyDateId === replacementKeyDate.id ||
          cs.keyDateId === supersededKeyDate.id
        ) {
          await keyDateRepo.putCalendarSync(ctx, cs);
        }
      }
      const auditInputs: FirmAuditEntryInput[] = stagedAudit.map((a) => ({
        recordType: a.recordType,
        recordId: a.recordId,
        action: a.action,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        byId: a.byId,
        at: a.at,
        ...(a.reason !== undefined ? { reason: a.reason } : {}),
        ...(a.snapshot !== undefined ? { snapshot: a.snapshot } : {}),
      }));
      await appendTenantAuditEntries(ctx, auditInputs);
    });

    return { ok: true, supersededKeyDate, replacementKeyDate };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to supersede key date.',
    };
  }
}

export async function resolveKeyDateOutcomeRecord(
  keyDateId: string,
  input: {
    kind: 'met' | 'missed' | 'waived';
    note?: string;
    evidenceDocumentId?: string;
  },
  byId: string,
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      actor,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd, matter, enquiry } = loaded;
    const nowIso = new Date().toISOString();
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    resolveKeyDateOutcome({
      keyDate: kd,
      kind: input.kind,
      note: input.note,
      evidenceDocumentId: input.evidenceDocumentId,
      actor,
      nowIso,
      config,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const existingReminder = await keyDateRepo.getReminderState(ctx, kd.id, actor.id);
    const reminderStatesWorking = existingReminder ? [existingReminder] : [];
    const existingSync = await keyDateRepo.getCalendarSync(ctx, kd.id, actor.id);
    const calendarSyncsWorking = existingSync ? [existingSync] : [];

    const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
    const beforeTaskJsonById = new Map(
      storeTasks.map((t) => [t.id, JSON.stringify(t)]),
    );
    closeReminderTaskForKeyDate({
      keyDateId: kd.id,
      tenantId: ctx.tenantId,
      tasks: storeTasks,
      reminderStates: reminderStatesWorking,
      nowIso,
      actorId: actor.id,
    });

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      nowIso,
    });

    const changedTasks = storeTasks.filter(
      (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
    );

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      reminderStatesToUpsert: reminderStatesWorking,
      calendarSyncsToUpsert: calendarSyncsWorking,
      tasksToUpsert: changedTasks,
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to resolve key date.',
    };
  }
}

export async function reassignKeyDateTeamRecord(
  keyDateId: string,
  input: {
    teamId: string;
    responsiblePersonIds?: string[];
    reason?: string;
  },
  byId: string,
  options?: { calendarAdapter?: GraphCalendarAdapter },
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      actor,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd, matter, enquiry } = loaded;
    const nowIso = new Date().toISOString();
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    const taskRepo = getTaskWorkflowRepository();
    const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
    const beforeTaskJsonById = new Map(
      storeTasks.map((t) => [t.id, JSON.stringify(t)]),
    );
    reassignKeyDateTeamAndOwners({
      keyDate: kd,
      tenantId: ctx.tenantId,
      teamId: input.teamId,
      responsiblePersonIds: input.responsiblePersonIds,
      reason: input.reason,
      actor,
      nowIso,
      config,
      matter,
      tasks: storeTasks,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    const keyDateRepo = getKeyDateRepository();
    const existingSync = await keyDateRepo.getCalendarSync(ctx, kd.id, actor.id);
    const calendarSyncsWorking = existingSync ? [existingSync] : [];

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: calendarSyncsWorking,
      adapter: options?.calendarAdapter,
      nowIso,
    });

    const changedTasks = storeTasks.filter(
      (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
    );

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      keyDatesToUpsert: [kd],
      calendarSyncsToUpsert: calendarSyncsWorking,
      tasksToUpsert: changedTasks,
      auditEntries: stagedAudit,
    });

    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to reassign team diary.',
    };
  }
}

export async function recordKeyDateNotApplicableRecord(
  input: {
    matterId: string;
    keyDateTypeId: string;
    reason: string;
  },
  byId: string,
): Promise<{ ok: boolean; record?: KeyDateNotApplicable; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    const matter = matters.find((m) => m.id === input.matterId);
    if (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, people)) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    const keyDateRepo = getKeyDateRepository();
    const existingNaList = await keyDateRepo.listNotApplicableForMatter(
      ctx,
      matter.id,
      actor.id,
    );
    const nowIso = new Date().toISOString();
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    const rec = recordKeyDateNotApplicable({
      matterId: matter.id,
      matterTypeId: matter.matterTypeId || matter.practiceAreaId,
      keyDateTypeId: input.keyDateTypeId,
      reason: input.reason,
      actor,
      nowIso,
      config,
      notApplicableList: existingNaList,
      teams,
      people,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      notApplicableToUpsert: [rec],
      auditEntries: stagedAudit,
    });

    return { ok: true, record: rec };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Failed to record key date as not applicable.',
    };
  }
}

export async function acknowledgeKeyDateReminderRecord(
  keyDateId: string,
  byId: string,
): Promise<{ ok: boolean; reminderState?: KeyDateReminderState; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, matters, teams } = resolved;
    const config = await getKeyDatesConfig({ ctx, userId: actor.id });
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;

    if (
      !hasKeyDatePermission(actor, 'keydate:view', {
        config,
        allPeople: people,
        teams,
      })
    ) {
      return {
        ok: false,
        error:
          'KEY_DATE_PERMISSION_DENIED: You need "keydate:view" permission to acknowledge key date reminders.',
      };
    }

    const loaded = await loadKeyDateForActorOrClassifyError(
      ctx,
      null,
      keyDateId,
      actor,
      people,
      matters,
      teams,
    );
    if (!loaded.kd) {
      return { ok: false, error: loaded.error ?? 'Key date not found.' };
    }
    const { kd, matter } = loaded;

    if (kd.status !== 'confirmed') {
      return {
        ok: false,
        error: `KEY_DATE_INVALID_STATE: Reminders can only be acknowledged for confirmed key dates (current status: "${kd.status}").`,
      };
    }

    const owningTeam = teams.find((t) => t.id === kd.teamId);
    const isResponsiblePerson = kd.responsiblePersonIds.includes(actor.id);
    const isOwningTeamLead = Boolean(owningTeam?.leadIds.includes(actor.id));
    if (!isResponsiblePerson && !isOwningTeamLead) {
      return {
        ok: false,
        error:
          'KEY_DATE_PERMISSION_DENIED: Only a responsible person on the key date or the owning team lead may acknowledge a reminder stage.',
      };
    }

    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());
    const keyDateRepo = getKeyDateRepository();
    const taskRepo = getTaskWorkflowRepository();
    const existingReminder = await keyDateRepo.getReminderState(ctx, keyDateId, actor.id);
    const reminderStatesWorking: KeyDateReminderState[] = existingReminder
      ? [existingReminder]
      : [];
    const stagedAudit: AuditEntry[] = [];
    let pendingIdx = 0;

    let changedTasks: Task[] = [];
    let deletedTaskIds: string[] = [];
    if (reminderStatesWorking.length === 0) {
      const storeTasks = await taskRepo.listAllTasksUnfiltered<Task>(ctx);
      const beforeTaskJsonById = new Map(
        storeTasks.map((t) => [t.id, JSON.stringify(t)]),
      );
      let pendingTaskIdx = 0;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: reminderStatesWorking,
        matters: matter ? [matter] : [],
        people,
        audit: stagedAudit,
        nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: ctx.tenantId,
        nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
      });
      changedTasks = storeTasks.filter(
        (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
      );
      const currentIds = new Set(storeTasks.map((t) => t.id));
      deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
        (id) => !currentIds.has(id),
      );
    }

    const state = acknowledgeKeyDateReminderStage({
      keyDateId,
      actorId: actor.id,
      nowIso,
      reminderStates: reminderStatesWorking,
      audit: stagedAudit,
      nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
    });

    await commitKeyDateDomainWritesInPostgres({
      ctx,
      reminderStatesToUpsert: reminderStatesWorking,
      tasksToUpsert: changedTasks,
      tasksToDeleteIds: deletedTaskIds,
      auditEntries: stagedAudit,
    });

    return { ok: true, reminderState: state };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Failed to acknowledge key date reminder.',
    };
  }
}

export interface KeyDateRemindersJobSummary extends Record<string, number> {
  readonly evaluatedCount: number;
  readonly stagesAdvancedCount: number;
  readonly remindersSent: number;
  readonly tasksCreated: number;
  readonly notificationsCreated: number;
  readonly escalationsSent: number;
  readonly exceptionsFound: number;
}

export interface ExecuteKeyDateRemindersForTenantOptions {
  readonly triggerSource: 'scheduled' | 'manual';
  readonly triggeredById: string;
  readonly timeZone?: string;
  readonly defaultRunHourLocal?: number;
  readonly nowIso?: string;
  readonly statementTimeoutMs?: number;
  readonly onAfterWorkBeforeCommit?: (
    ctx: TenantContext,
  ) => Promise<void> | void;
}

/**
 * Single-transaction per-tenant Key Date reminder execution shared by scheduled
 * hourly ticks (`system:key-date-reminders`) and manual Admin triggers (`actor.id`)
 * (ADR 0030 §§4–6 / Slice S0-19).
 *
 * Inside one `withTenantTransaction`:
 * 1. Acquires `pg_try_advisory_xact_lock(hashtext('onesquared_job:key-date-reminders:' || tenantId))`.
 * 2. Checks `job_runs` for scheduled runs (`localHour >= 02:00` and no `status = 'succeeded'` row for `local_date`).
 * 3. Reads all inputs (`keyDates`, `reminderStates`, `tasks`, `people`, `teams`, `matters`, `config`) inside the transaction.
 * 4. Evaluates due reminders, escalations, tasks, notifications, and audit entries and writes them on the same transaction client.
 * 5. Inserts the `status = 'succeeded'` row in `job_runs` before `COMMIT` releases the advisory lock atomically.
 */
export async function executeKeyDateRemindersForTenant(
  ctx: TenantContext,
  options: ExecuteKeyDateRemindersForTenantOptions,
): Promise<
  ControlledJobRunOutcome<{
    result: ReturnType<typeof runTenantKeyDateReminderJob>;
    summary: KeyDateRemindersJobSummary;
  }>
> {
  const tenantConfig = getActiveTenantConfiguration();
  const effectiveTimeZone =
    options.timeZone?.trim() || tenantConfig.timeZone || 'Europe/London';
  const nowIso = options.nowIso ?? new Date().toISOString();

  return getJobRunRepository().executeControlledTenantJobRun(ctx, {
    jobKey: 'key-date-reminders',
    triggerSource: options.triggerSource,
    triggeredById: options.triggeredById,
    timeZone: effectiveTimeZone,
    targetLocalHour: options.defaultRunHourLocal ?? 2,
    now: new Date(nowIso),
    statementTimeoutMs: options.statementTimeoutMs,
    work: async ({ localDate }) => {
      const keyDateRepo = getKeyDateRepository();
      const taskRepo = getTaskWorkflowRepository();
      const partyRepo = getPartyRepository();
      const matterRepo = getMatterRepository();
      const hrRepo = getHrAndRbacRepository();
      const catalogueRepo = getCatalogueRepository();

      const [
        people,
        matters,
        storeTasks,
        teams,
        values,
        config,
        keyDatesWorking,
        reminderStatesWorking,
        notApplicableWorking,
        calendarSyncsWorking,
      ] = await Promise.all([
        partyRepo.listAllPeople<Person>(ctx),
        matterRepo.listAllMattersUnfiltered<Matter>(ctx),
        taskRepo.listAllTasksUnfiltered<Task>(ctx),
        hrRepo.listAllTeams<Team>(ctx),
        catalogueRepo.listAllChoiceValues<ChoiceValue>(ctx),
        getKeyDatesConfig({ ctx, userId: options.triggeredById }),
        keyDateRepo.listAllKeyDatesUnfilteredForScheduler(ctx),
        keyDateRepo.listAllReminderStatesUnfilteredForScheduler(ctx),
        keyDateRepo.listAllVisibleNotApplicable(ctx, options.triggeredById),
        keyDateRepo.listAllVisibleCalendarSyncs(ctx, options.triggeredById),
      ]);

      if (options.triggerSource === 'manual') {
        const actorInTx = resolveActorFromPeopleForKeyDates(
          people,
          options.triggeredById,
        );
        if (
          !actorInTx ||
          !hasKeyDatePermission(actorInTx, 'keydate:configure', {
            config,
            allPeople: people,
            teams,
            rbac: { tokenRoles: ctx.actorRoles },
          })
        ) {
          const permErr = new Error(
            'KEY_DATE_PERMISSION_DENIED: You need "keydate:configure" permission to trigger the key date reminder scheduler.',
          );
          (permErr as Error & { code?: string }).code =
            'KEY_DATE_PERMISSION_DENIED';
          throw permErr;
        }
      }

      const beforeReminderStageByKd = new Map(
        reminderStatesWorking.map((rs) => [
          rs.keyDateId,
          rs.currentStageDaysBefore,
        ]),
      );
      const beforeReminderJsonByKd = new Map(
        reminderStatesWorking.map((rs) => [rs.keyDateId, JSON.stringify(rs)]),
      );
      const beforeTaskJsonById = new Map(
        storeTasks.map((t) => [t.id, JSON.stringify(t)]),
      );
      const createdNotifications: NotificationItem[] = [];
      const stagedAudit: AuditEntry[] = [];
      let pendingIdx = 0;
      let pendingTaskIdx = 0;
      let pendingNotifIdx = 0;

      const result = runTenantBackgroundJob(
        {
          jobId: `keydate-reminder-scheduler:${ctx.tenantId}:${localDate}`,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          payload: { todayIso: localDate, nowIso },
        },
        (job) =>
          runTenantKeyDateReminderJob({
            tenantId: job.tenantId,
            actorId: options.triggeredById,
            todayIso: job.payload.todayIso,
            nowIso: job.payload.nowIso,
            config,
            keyDates: keyDatesWorking,
            reminderStates: reminderStatesWorking,
            tasks: storeTasks,
            matters,
            teams,
            people,
            notifications: createdNotifications,
            audit: stagedAudit,
            nextTaskId: () => `TSK-PENDING-${++pendingTaskIdx}`,
            nextNotificationId: () => `NTF-PENDING-${++pendingNotifIdx}`,
            nextAuditId: () => `AU-PENDING-${++pendingIdx}`,
          }),
      );

      const changedTasks = storeTasks.filter(
        (t) => beforeTaskJsonById.get(t.id) !== JSON.stringify(t),
      );
      const newTasksCount = changedTasks.filter((t) =>
        t.id.startsWith('TSK-PENDING-'),
      ).length;
      const currentIds = new Set(storeTasks.map((t) => t.id));
      const deletedTaskIds = [...beforeTaskJsonById.keys()].filter(
        (id) => !currentIds.has(id),
      );
      const changedReminders = reminderStatesWorking.filter(
        (rs) => beforeReminderJsonByKd.get(rs.keyDateId) !== JSON.stringify(rs),
      );

      for (const rs of changedReminders) {
        const alreadyAudited = stagedAudit.some(
          (a) => a.recordId === rs.keyDateId,
        );
        if (!alreadyAudited) {
          const prevStage = beforeReminderStageByKd.get(rs.keyDateId);
          stagedAudit.push({
            id: `AU-PENDING-${++pendingIdx}`,
            recordType: 'key_date',
            recordId: rs.keyDateId,
            action: 'update',
            field: 'currentStageDaysBefore',
            oldValue: prevStage !== undefined ? String(prevStage) : null,
            newValue: String(rs.currentStageDaysBefore),
            byId: options.triggeredById,
            at: nowIso,
            reason: `Key date reminder stage evaluated (${localDate})`,
          });
        }
      }

      await commitKeyDateDomainWritesInPostgres({
        ctx,
        reminderStatesToUpsert: changedReminders,
        tasksToUpsert: changedTasks,
        tasksToDeleteIds: deletedTaskIds,
        notificationsToUpsert: createdNotifications,
        auditEntries: stagedAudit,
        allowSystemSchedulerWrite: true,
      });

      const syntheticViewer: Person =
        people.find((p) => p.id === options.triggeredById) ??
        ({
          id: options.triggeredById,
          firstName: 'System',
          surname: 'Scheduler',
          isEmployee: true,
          roles: ['admin'],
          appRole: 'admin',
        } as unknown as Person);
      const exceptions = computeKeyDateExceptions({
        viewer: syntheticViewer,
        todayIso: localDate,
        nowIso,
        config,
        keyDates: keyDatesWorking,
        notApplicable: notApplicableWorking,
        reminderStates: reminderStatesWorking,
        calendarSyncs: calendarSyncsWorking,
        matters,
        teams,
        people,
        values,
      });

      if (options.onAfterWorkBeforeCommit) {
        await options.onAfterWorkBeforeCommit(ctx);
      }

      const summary: KeyDateRemindersJobSummary = {
        evaluatedCount: result.evaluatedCount,
        stagesAdvancedCount: result.stagesAdvancedCount,
        remindersSent: changedReminders.length,
        tasksCreated: newTasksCount,
        notificationsCreated: createdNotifications.length,
        escalationsSent: result.escalationsTriggeredCount,
        exceptionsFound: exceptions.length,
      };

      return {
        result: { result, summary },
        summary,
      };
    },
  });
}

export interface UsageRetentionPurgeJobSummary extends Record<string, number> {
  readonly purgedEventsCount: number;
  readonly purgedSummaryBucketsCount: number;
  readonly retentionMonths: number;
}

export interface ExecuteUsageRetentionPurgeForTenantOptions {
  readonly triggerSource?: 'scheduled' | 'manual';
  readonly triggeredById?: string;
  readonly timeZone?: string;
  readonly defaultRunHourLocal?: number;
  readonly nowIso?: string;
  readonly statementTimeoutMs?: number;
  readonly onAfterWorkBeforeCommit?: (
    ctx: TenantContext,
  ) => Promise<void> | void;
}

/**
 * Single-transaction per-tenant document-generation usage retention purge job
 * (`system:usage-retention-purge`, ADR 0030 §§4–6 / Slice S0-19).
 */
export async function executeUsageRetentionPurgeForTenant(
  ctx: TenantContext,
  options: ExecuteUsageRetentionPurgeForTenantOptions = {},
): Promise<
  ControlledJobRunOutcome<{
    purgedEventsCount: number;
    purgedSummaryBucketsCount: number;
    retentionMonths: number;
  }>
> {
  const tenantConfig = getActiveTenantConfiguration();
  const effectiveTimeZone =
    options.timeZone?.trim() || tenantConfig.timeZone || 'Europe/London';
  const triggeredById =
    options.triggeredById?.trim() || 'system:usage-retention-purge';
  const nowIso = options.nowIso ?? new Date().toISOString();

  return getJobRunRepository().executeControlledTenantJobRun(ctx, {
    jobKey: 'usage-retention-purge',
    triggerSource: options.triggerSource ?? 'scheduled',
    triggeredById,
    timeZone: effectiveTimeZone,
    targetLocalHour: options.defaultRunHourLocal ?? 2,
    now: new Date(nowIso),
    statementTimeoutMs: options.statementTimeoutMs,
    work: async ({ localDate }) => {
      const docRepo = getDocumentRepository();
      const effectiveConfig = await getEffectiveTenantConfig(ctx, docRepo);
      const retentionMonths =
        effectiveConfig.documentGeneration.usage.retentionMonths ??
        tenantConfig.documentGeneration.usage.retentionMonths;

      const purged = await executeUsageRetentionPurgeJob(ctx, docRepo, {
        jobId: `usage-retention-purge:${ctx.tenantId}:${localDate}`,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        payload: {
          retentionMonths,
          nowIso,
        },
      });

      await appendTenantAuditEntries(ctx, [
        {
          recordType: 'matter',
          recordId: 'FIRM-DOCGEN-USAGE-RETENTION',
          action: 'update',
          field: 'documentGeneration.usage.retentionMonths',
          oldValue: null,
          newValue: `purgedEvents=${purged.purgedEventsCount}; purgedSummaries=${purged.purgedSummaryBucketsCount}; retentionMonths=${retentionMonths}`,
          byId: triggeredById,
          at: nowIso,
          reason: `Scheduled usage retention purge (${localDate})`,
        },
      ]);

      if (options.onAfterWorkBeforeCommit) {
        await options.onAfterWorkBeforeCommit(ctx);
      }

      const summary: UsageRetentionPurgeJobSummary = {
        purgedEventsCount: purged.purgedEventsCount,
        purgedSummaryBucketsCount: purged.purgedSummaryBucketsCount,
        retentionMonths,
      };

      return {
        result: summary,
        summary,
      };
    },
  });
}

export interface ScheduledTenantJobSweepSummary {
  readonly exitCode: number;
  readonly succeededTenants: string[];
  readonly skippedTenants: Array<{
    readonly tenantId: string;
    readonly status: 'skipped' | 'already_running';
    readonly reason?: string;
  }>;
  readonly failedTenants: Array<{
    readonly tenantId: string;
    readonly errorCode?: string;
  }>;
}

export async function runScheduledKeyDateRemindersJobSweep(options?: {
  readonly registry?: TenantRegistry;
  readonly nowIso?: string;
  readonly timeoutMs?: number;
  readonly defaultRunHourLocal?: number;
  readonly guardedJobOptions?: GuardedJobOptions;
  readonly onAfterWorkBeforeCommitByTenant?: Readonly<
    Record<string, (ctx: TenantContext) => Promise<void> | void>
  >;
}): Promise<ScheduledTenantJobSweepSummary> {
  const registry = options?.registry ?? loadActiveTenantRegistry();
  const succeededTenants: string[] = [];
  const skippedTenants: Array<{
    readonly tenantId: string;
    readonly status: 'skipped' | 'already_running';
    readonly reason?: string;
  }> = [];
  const failedTenants: Array<{
    readonly tenantId: string;
    readonly errorCode?: string;
  }> = [];

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    try {
      const outcome = await guardedJob(
        'key-date-reminders',
        entry,
        async ({ tenantContext, tenantEntry, timeoutMs }) =>
          executeKeyDateRemindersForTenant(tenantContext, {
            triggerSource: 'scheduled',
            triggeredById: 'system:key-date-reminders',
            timeZone: tenantEntry.timeZone,
            defaultRunHourLocal: options?.defaultRunHourLocal ?? 2,
            nowIso: options?.nowIso,
            statementTimeoutMs: timeoutMs,
            onAfterWorkBeforeCommit:
              options?.onAfterWorkBeforeCommitByTenant?.[entry.tenantId],
          }),
        {
          registry,
          timeoutMs: options?.timeoutMs,
          ...options?.guardedJobOptions,
        },
      );
      if (outcome.outcome === 'executed') {
        succeededTenants.push(entry.tenantId);
      } else {
        skippedTenants.push({
          tenantId: entry.tenantId,
          status: outcome.outcome === 'already_running' ? 'already_running' : 'skipped',
          reason: outcome.outcome,
        });
      }
    } catch (err) {
      failedTenants.push({
        tenantId: entry.tenantId,
        errorCode: sanitizeJobErrorCode(err),
      });
    }
  }

  return {
    exitCode: failedTenants.length > 0 ? 1 : 0,
    succeededTenants,
    skippedTenants,
    failedTenants,
  };
}

export async function runScheduledUsageRetentionPurgeJobSweep(options?: {
  readonly registry?: TenantRegistry;
  readonly nowIso?: string;
  readonly timeoutMs?: number;
  readonly defaultRunHourLocal?: number;
  readonly guardedJobOptions?: GuardedJobOptions;
  readonly onAfterWorkBeforeCommitByTenant?: Readonly<
    Record<string, (ctx: TenantContext) => Promise<void> | void>
  >;
}): Promise<ScheduledTenantJobSweepSummary> {
  const registry = options?.registry ?? loadActiveTenantRegistry();
  const succeededTenants: string[] = [];
  const skippedTenants: Array<{
    readonly tenantId: string;
    readonly status: 'skipped' | 'already_running';
    readonly reason?: string;
  }> = [];
  const failedTenants: Array<{
    readonly tenantId: string;
    readonly errorCode?: string;
  }> = [];

  for (const entry of registry.tenants) {
    if (!entry.enabled) {
      continue;
    }
    try {
      const outcome = await guardedJob(
        'usage-retention-purge',
        entry,
        async ({ tenantContext, tenantEntry, timeoutMs }) =>
          executeUsageRetentionPurgeForTenant(tenantContext, {
            triggerSource: 'scheduled',
            triggeredById: 'system:usage-retention-purge',
            timeZone: tenantEntry.timeZone,
            defaultRunHourLocal: options?.defaultRunHourLocal ?? 2,
            nowIso: options?.nowIso,
            statementTimeoutMs: timeoutMs,
            onAfterWorkBeforeCommit:
              options?.onAfterWorkBeforeCommitByTenant?.[entry.tenantId],
          }),
        {
          registry,
          timeoutMs: options?.timeoutMs,
          ...options?.guardedJobOptions,
        },
      );
      if (outcome.outcome === 'executed') {
        succeededTenants.push(entry.tenantId);
      } else {
        skippedTenants.push({
          tenantId: entry.tenantId,
          status: outcome.outcome === 'already_running' ? 'already_running' : 'skipped',
          reason: outcome.outcome,
        });
      }
    } catch (err) {
      failedTenants.push({
        tenantId: entry.tenantId,
        errorCode: sanitizeJobErrorCode(err),
      });
    }
  }

  return {
    exitCode: failedTenants.length > 0 ? 1 : 0,
    succeededTenants,
    skippedTenants,
    failedTenants,
  };
}

export async function runKeyDateReminderSchedulerRecord(
  options?: {
    tenantCtx?: TenantContext | null;
    session?: VerifiedEntraSessionPayload | null;
    byId: string;
    mfaVerified?: boolean;
    nowIso?: string;
    timeZone?: string;
  } | null,
): Promise<{
  ok: boolean;
  result?: ReturnType<typeof runTenantKeyDateReminderJob>;
  jobRun?: JobRunRecord;
  jobStatus?: 'succeeded' | 'skipped' | 'already_running';
  triggeredBy?: string;
  error?: string;
}> {
  if (
    !options ||
    typeof options !== 'object' ||
    options.tenantCtx === null ||
    (!options.tenantCtx && !options.byId && !options.session)
  ) {
    runTenantBackgroundJob(
      {
        jobId: 'keydate-reminder-job:missing-context',
        tenantId: '',
        correlationId: '',
        payload: {},
      },
      () => undefined,
    );
  }

  const requestedById = (options?.byId ?? '').trim();
  const providedCtx = options?.tenantCtx ?? null;
  const verifiedSession =
    options?.session ??
    (getActiveActorSession()?.verifiedSession as
      | VerifiedEntraSessionPayload
      | undefined);

  if (providedCtx && requestedById && providedCtx.actorId !== requestedById) {
    throw new Error(
      `TENANCY_ACTOR_MISMATCH: Tenant context actorId "${providedCtx.actorId}" does not match requested actor "${requestedById}".`,
    );
  }
  if (verifiedSession && requestedById && verifiedSession.personId !== requestedById) {
    throw new Error(
      `TENANCY_ACTOR_MISMATCH: Verified session personId "${verifiedSession.personId}" does not match requested actor "${requestedById}".`,
    );
  }

  const effectiveTenantCtx =
    providedCtx ??
    (verifiedSession
      ? resolveCurrentTenantContext(
          createVerifiedSessionActorFromEntraSession(verifiedSession),
        )
      : null);

  if (
    effectiveTenantCtx &&
    requestedById &&
    effectiveTenantCtx.actorId !== requestedById
  ) {
    throw new Error(
      `TENANCY_ACTOR_MISMATCH: Tenant context actorId "${effectiveTenantCtx.actorId}" does not match requested actor "${requestedById}".`,
    );
  }

  const actorId = effectiveTenantCtx?.actorId ?? requestedById;
  // Take MFA from the verified context when present; never let a caller flag override a non-MFA context (R449).
  const mfaVerified = effectiveTenantCtx
    ? effectiveTenantCtx.mfaVerified === true && options?.mfaVerified !== false
    : options?.mfaVerified === true;

  let prelimPeople: Person[] = [];
  let prelimTeams: Team[] = [];
  try {
    const readPeopleCtx =
      effectiveTenantCtx ??
      resolveDefaultServiceTenantContext(null, null);
    [prelimPeople, prelimTeams] = await Promise.all([
      getPartyRepository().listAllPeople<Person>(readPeopleCtx),
      getHrAndRbacRepository().listAllTeams<Team>(readPeopleCtx),
    ]);
  } catch {
    prelimPeople = [];
    prelimTeams = [];
  }
  const actor = resolveActorFromPeopleForKeyDates(prelimPeople, actorId);
  if (!actor) {
    return { ok: false, error: `Unknown or unauthenticated user "${actorId}".` };
  }

  // Evaluate permission and MFA before reading any key-date repository or configuration rows from PostgreSQL (R449).
  const inMemoryKeyDatesConfig =
    getActiveTenantConfiguration().keyDates as KeyDatesConfig | undefined;
  if (
    !hasKeyDatePermission(actor, 'keydate:configure', {
      config: inMemoryKeyDatesConfig,
      allPeople: prelimPeople,
      teams: prelimTeams,
      rbac: effectiveTenantCtx
        ? { tokenRoles: effectiveTenantCtx.actorRoles }
        : undefined,
    })
  ) {
    return {
      ok: false,
      error:
        'KEY_DATE_PERMISSION_DENIED: You need "keydate:configure" permission to trigger the key date reminder scheduler.',
    };
  }

  const configurePermDef = PERMISSION_REGISTRY['keydate:configure'];
  if ((configurePermDef?.requiresMfa ?? true) && mfaVerified !== true) {
    return {
      ok: false,
      error:
        'MFA_REQUIRED: Multi-factor authentication (MFA) is required to trigger the key date reminder scheduler.',
    };
  }

  if (!effectiveTenantCtx) {
    runTenantBackgroundJob(
      {
        jobId: 'keydate-reminder-job:missing-context',
        tenantId: '',
        correlationId: '',
        payload: {},
      },
      () => undefined,
    );
  }

  try {
    const outcome = await executeKeyDateRemindersForTenant(effectiveTenantCtx!, {
      triggerSource: 'manual',
      triggeredById: actor.id,
      nowIso: options?.nowIso,
      timeZone: options?.timeZone,
    });

    if (outcome.outcome === 'executed') {
      return {
        ok: true,
        result: outcome.result.result,
        jobRun: outcome.jobRun,
        jobStatus: 'succeeded',
        triggeredBy: actor.id,
      };
    }

    return {
      ok: true,
      result: {
        tenantId: effectiveTenantCtx!.tenantId,
        evaluatedCount: 0,
        stagesAdvancedCount: 0,
        escalationsTriggeredCount: 0,
        notificationsSentCount: 0,
      },
      jobStatus:
        outcome.outcome === 'already_running' ? 'already_running' : 'skipped',
      triggeredBy: actor.id,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Failed to execute key date reminder scheduler.',
    };
  }
}

export async function queryKeyDatesTeamDiaryRecord(
  query: TeamDiaryQuery,
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): Promise<TeamDiaryEntry[]> {
  let resolved: Awaited<ReturnType<typeof resolveKeyDatesActorAndData>> = null;
  try {
    resolved = await resolveKeyDatesActorAndData(null, byId);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.actor) return [];
  const { ctx, actor: viewer, people, matters, teams } = resolved;
  const config = await getKeyDatesConfig({ ctx, userId: viewer.id });
  const keyDateRepo = getKeyDateRepository();
  const intakeRepo = getIntakeQuoteRepository();
  const [keyDates, reminderStates, enquiries] = await Promise.all([
    keyDateRepo.listAllVisibleKeyDates(ctx, viewer.id),
    keyDateRepo.listAllReminderStates(ctx, viewer.id),
    intakeRepo.listAllEnquiriesUnfiltered<Enquiry>(ctx),
  ]);
  const visibleMatters = matters.filter((m) =>
    canPersonAccessMatter(m, viewer.id, viewer, {
      allPeople: people,
      teams,
    }),
  );
  return queryTeamDiaryEntries({
    viewer,
    query,
    todayIso,
    config,
    keyDates,
    reminderStates,
    matters: visibleMatters,
    enquiries,
    teams,
    people,
  });
}

export async function getKeyDateExceptionsReportRecord(
  filter: { teamIds?: string[]; kinds?: KeyDateExceptionKind[] } = {},
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): Promise<KeyDateException[]> {
  let resolved: Awaited<ReturnType<typeof resolveKeyDatesActorAndData>> = null;
  try {
    resolved = await resolveKeyDatesActorAndData(null, byId);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.actor) return [];
  const { ctx, actor: viewer, people, matters, teams } = resolved;
  const config = await getKeyDatesConfig({ ctx, userId: viewer.id });
  const canConfigure = hasKeyDatePermission(viewer, 'keydate:configure', {
    config,
    allPeople: people,
    teams,
  });
  const keyDateRepo = getKeyDateRepository();
  const [keyDates, notApplicable, reminderStates, calendarSyncs, values] =
    await Promise.all([
      keyDateRepo.listKeyDatesForExceptionsReport(ctx, viewer.id, {
        includeMissingMatterOrphans: canConfigure,
      }),
      keyDateRepo.listAllVisibleNotApplicable(ctx, viewer.id),
      keyDateRepo.listAllReminderStates(ctx, viewer.id),
      keyDateRepo.listAllVisibleCalendarSyncs(ctx, viewer.id),
      getCatalogueRepository().listAllChoiceValues<ChoiceValue>(ctx),
    ]);
  const visibleMatters = matters.filter((m) =>
    canPersonAccessMatter(m, viewer.id, viewer, {
      allPeople: people,
      teams,
    }),
  );
  return computeKeyDateExceptions({
    viewer,
    todayIso,
    nowIso: new Date().toISOString(),
    config,
    keyDates,
    notApplicable,
    reminderStates,
    calendarSyncs,
    matters: visibleMatters,
    teams,
    people,
    values,
    filterTeamIds: filter.teamIds,
    filterKinds: filter.kinds,
  });
}

export async function exportKeyDateExceptionsReportRecord(
  filter: {
    teamIds?: string[];
    kinds?: KeyDateExceptionKind[];
    format?: 'csv' | 'json';
  } = {},
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): Promise<{ ok: boolean; content?: string; filename?: string; count?: number; error?: string }> {
  let resolved: Awaited<ReturnType<typeof resolveKeyDatesActorAndData>> = null;
  try {
    resolved = await resolveKeyDatesActorAndData(null, byId);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.actor) {
    return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
  }
  const { ctx, actor: viewer, people, teams } = resolved;
  const config = await getKeyDatesConfig({ ctx, userId: viewer.id });

  if (
    !hasKeyDatePermission(viewer, 'keydate:view_any_team', {
      config,
      allPeople: people,
      teams,
    })
  ) {
    return {
      ok: false,
      error: 'You need "keydate:view_any_team" to view or export compliance exceptions.',
    };
  }

  const exceptions = await getKeyDateExceptionsReportRecord(filter, byId, todayIso);
  const format = filter.format ?? 'csv';
  const nowIso = new Date().toISOString();

  // Audit the compliance exceptions export in PostgreSQL audit_entries (§6, R41, S0-15)
  await appendTenantAuditEntries(ctx, [
    {
      recordType: 'key_date',
      recordId: 'KEY-DATE-EXCEPTIONS-EXPORT',
      action: 'keydate-export',
      field: 'Compliance exceptions export',
      oldValue: null,
      newValue: `Exported ${exceptions.length} exception(s) as ${format.toUpperCase()}`,
      byId: viewer.id,
      at: nowIso,
      reason: `Filter teams=${filter.teamIds?.join(',') || 'all'} kinds=${filter.kinds?.join(',') || 'all'}`,
    },
  ]);

  if (format === 'json') {
    return {
      ok: true,
      content: JSON.stringify(exceptions, null, 2),
      filename: `key-date-exceptions-${todayIso}.json`,
      count: exceptions.length,
    };
  }

  const header = 'Kind,TeamId,MatterId,KeyDateId,DetectedAt,Detail';
  const escapeCsv = (val: string | undefined) =>
    `"${String(val ?? '').replace(/"/g, '""')}"`;
  const rows = exceptions.map((ex) =>
    [
      escapeCsv(ex.kind),
      escapeCsv(ex.teamId),
      escapeCsv(ex.matterId),
      escapeCsv(ex.keyDateId),
      escapeCsv(ex.detectedAt),
      escapeCsv(ex.detail),
    ].join(','),
  );
  return {
    ok: true,
    content: [header, ...rows].join('\n'),
    filename: `key-date-exceptions-${todayIso}.csv`,
    count: exceptions.length,
  };
}

export async function saveKeyDatesConfigRecord(
  newConfigInput: KeyDatesConfig,
  reason: string,
  byId: string,
  options?: { mfaVerified?: boolean } | boolean,
): Promise<{ ok: boolean; config?: KeyDatesConfig; error?: string }> {
  try {
    const resolved = await resolveKeyDatesActorAndData(null, byId);
    if (!resolved || !resolved.actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const { ctx, actor, people, teams } = resolved;
    const currentConfig = await getKeyDatesConfig({ ctx, userId: actor.id });

    if (
      !hasKeyDatePermission(actor, 'keydate:configure', {
        config: currentConfig,
        allPeople: people,
        teams,
      })
    ) {
      return {
        ok: false,
        error: 'You need "keydate:configure" permission to modify Key Dates configuration.',
      };
    }

    const mfaVerified =
      typeof options === 'boolean' ? options : options?.mfaVerified;
    const configurePermDef = PERMISSION_REGISTRY['keydate:configure'];
    if ((configurePermDef?.requiresMfa ?? true) && mfaVerified !== true) {
      return {
        ok: false,
        error:
          'MFA_REQUIRED: Multi-factor authentication (MFA) is required to modify Key Dates configuration.',
      };
    }

    for (const rs of newConfigInput.limitationRuleSets ?? []) {
      const rawStatus = (rs as { reviewStatus?: unknown }).reviewStatus;
      if (rawStatus !== 'reviewed' && rawStatus !== 'unreviewed') {
        return {
          ok: false,
          error: `Invalid reviewStatus "${String(rawStatus)}" on limitation rule set "${rs.id}". Expected "reviewed" or "unreviewed".`,
        };
      }
    }

    const validated = validateKeyDatesConfig(newConfigInput) as unknown as KeyDatesConfig;
    const nowIso = new Date().toISOString();
    const todayIso = nowIso.slice(0, 10);
    const prevRuleSetsById = new Map(
      (currentConfig.limitationRuleSets ?? []).map((rs) => [rs.id, rs]),
    );
    if (validated.limitationRuleSets) {
      validated.limitationRuleSets = validated.limitationRuleSets.map((rs) => {
        if (rs.reviewStatus === 'unreviewed') {
          const nextUnreviewed = { ...rs, reviewStatus: 'unreviewed' as const };
          delete nextUnreviewed.reviewedBy;
          delete nextUnreviewed.reviewedOn;
          return nextUnreviewed;
        }
        const prev = prevRuleSetsById.get(rs.id);
        const keepPreviousReviewer =
          prev?.reviewStatus === 'reviewed' &&
          prev.version === rs.version &&
          Boolean(prev.reviewedBy);
        return {
          ...rs,
          reviewStatus: 'reviewed' as const,
          reviewedBy: keepPreviousReviewer ? prev!.reviewedBy : actor.id,
          reviewedOn: keepPreviousReviewer
            ? (prev!.reviewedOn ?? todayIso)
            : todayIso,
        };
      });
    }

    const keyDateRepo = getKeyDateRepository();
    await keyDateRepo.withTenantTransaction(ctx, async () => {
      await keyDateRepo.putKeyDatesTenantConfig(
        ctx,
        validated as unknown as KeyDatesConfiguration,
        actor.id,
      );
      await appendTenantAuditEntries(ctx, [
        {
          recordType: 'key_date',
          recordId: 'FIRM-KEY-DATES-CONFIG',
          action: 'keydate-config-change',
          field: 'keyDates',
          oldValue: `enabled=${currentConfig.enabled}; types=${currentConfig.keyDateTypes?.length ?? 0}; ruleSets=${currentConfig.limitationRuleSets?.length ?? 0}`,
          newValue: `enabled=${validated.enabled}; types=${validated.keyDateTypes?.length ?? 0}; ruleSets=${validated.limitationRuleSets?.length ?? 0}`,
          byId: actor.id,
          at: nowIso,
          reason: reason?.trim() || 'Updated Key Dates configuration in Admin',
          snapshot: {
            before: currentConfig,
            after: validated,
          },
        },
      ]);
    });

    return { ok: true, config: validated };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Invalid Key Dates configuration.',
    };
  }
}
