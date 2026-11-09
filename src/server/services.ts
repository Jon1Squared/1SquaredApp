import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { syncMatterLifecycleOnSaveSync } from './documentStoreServices';
import {
  prepareMergedEntityDocumentsInStore,
  repointMergedEntityInDocRepository,
  resolveTenantContextForStoreUser,
} from './documentGenerationServices';
import { attentionList } from '@/domain/attention';
import { buildActionDenied, type ActionDenied } from '@/domain/actionResult';
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
  isRegisteredPermissionKey,
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
  setRuntimeRbacConfigOverride,
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
  persistEntraSessionCookie,
  setTestEntraSessionOverride,
  shouldUseSecureCookies,
  type EntraSessionPayload,
  type VerifiedEntraSessionPayload,
} from './entraAuth';
import {
  getActiveTenantConfiguration,
  getExtensionHostLoadErrors,
  getPlatformExtensionHost,
  isNonLiveDemoEnvironment,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import {
  runTenantBackgroundJob,
  validateKeyDatesConfig,
  validateRbacConfig,
  type TenantContext,
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
import { verifyFinanceActorAndPermission } from './financeServices';
import { buildRecordVisibility } from './visibility';
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
import { getPmsSource } from '@/pms/pmsSource';
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
import { slug, vid } from '@/seed/lists';
import {
  clearStoreToCleanDeployment,
  type FirmStore,
  getStore,
  nextId,
  nextQuoteReference,
  resetStore,
  saveStore,
} from './store';

export const USER_COOKIE = 'onesquared_user';

export interface AuthenticatedActorContext {
  personId: string;
  person: Person;
  session: VerifiedEntraSessionPayload;
  mfaVerified: boolean;
  tenantId: string;
}

export async function requireAuthenticatedActor(): Promise<AuthenticatedActorContext> {
  const tenantId = getActiveTenantConfiguration().tenantId;
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
  const store = getStore();
  const person = store.people.find(
    (p) => p.id === entraSession.personId && p.isEmployee && !p.mergedIntoId,
  );
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
  const store = getStore();
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
  const targetPerson = store.people.find(
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

  const actorPerson = store.people.find((p) => p.id === actor.personId) ?? null;
  const actorPerms = resolvePersonPermissionSet(actorPerson, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: actor.mfaVerified,
    tokenRoles: actor.session.mappedRoles,
  });
  const targetPerms = resolvePersonPermissionSet(targetPerson, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: true,
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
  const restrictedMatterWithTargetAccess = store.matters.find(
    (m) =>
      Boolean(
        m.isStaffMatter ||
          (m.restrictedAccessUserIds && m.restrictedAccessUserIds.length > 0),
      ) &&
      canPersonAccessMatter(m, targetPerson.id, targetPerson, {
        allPeople: store.people,
        teams: store.teams,
      }) &&
      !canPersonAccessMatter(m, actor.personId, actorPerson, {
        allPeople: store.people,
        teams: store.teams,
        tokenRoles: actor.session.mappedRoles,
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
    mappedRoles: resolveEmployeeRoles(targetPerson, store.teams),
    authenticatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
  };

  await persistEntraSessionCookie(nextSession);

  writeAudit(store, {
    recordType: 'person',
    recordId: targetPerson.id,
    action: 'update',
    field: 'Demo user switch',
    oldValue: actor.personId,
    newValue: targetPerson.id,
    byId: actor.personId,
  });
  saveStore(store);

  return { ok: true, personId: targetPerson.id };
}

export function activeEmployees(store: FirmStore = getStore()): Person[] {
  return store.people
    .filter(
      (p) =>
        isSelectableInEmployeeDropdown(p) &&
        !p.mergedIntoId &&
        systemKeyOf(store.values, p.recordStatusId) === 'active',
    )
    .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b)));
}

export function formatContext(store: FirmStore): FormatContext {
  const names = new Map<string, string>();
  for (const p of store.people) names.set(p.id, personDisplayName(p));
  for (const o of store.organisations) names.set(o.id, o.legalName);
  for (const m of store.matters) names.set(m.id, `${m.matterNumber} — ${m.title}`);
  for (const e of store.enquiries) names.set(e.id, `${e.reference} — ${enquiryDisplayName(e)}`);
  for (const t of store.tasks) names.set(t.id, `${t.reference} — ${t.title}`);
  for (const tm of store.teams) names.set(tm.id, tm.name);
  return {
    values: store.values,
    nameOf: (id: string) => names.get(id) ?? id,
  };
}

function writeAudit(
  store: FirmStore,
  entry: Omit<AuditEntry, 'id' | 'at'> & { at?: string },
): AuditEntry {
  const full: AuditEntry = {
    id: nextId(store, 'AU'),
    at: entry.at ?? new Date().toISOString(),
    recordType: entry.recordType,
    recordId: entry.recordId,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    byId: entry.byId,
    ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
  };
  store.audit.unshift(full);
  return full;
}

export function getKeyDatesConfig(store: FirmStore = getStore()): KeyDatesConfig {
  const activeTenantConfig = getActiveTenantConfiguration();
  const raw =
    store.keyDatesConfigOverride ??
    activeTenantConfig.keyDates ??
    { enabled: false };
  return validateKeyDatesConfig(raw) as unknown as KeyDatesConfig;
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

export function getAppSnapshot(
  userId: string,
  options?: { tokenRoles?: readonly string[] },
): AppSnapshot {
  return getAppSnapshotInScope(userId, options);
}

function getAppSnapshotInScope(
  userId: string,
  options?: { tokenRoles?: readonly string[] },
): AppSnapshot {
  const store = getStore();
  const now = new Date();
  const user = store.people.find(
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
  const employees = activeEmployees(store);
  const currentUserRole = resolveUserAppRole(user, store.teams, store.values);
  const currentUserEmployeePermissions = resolveEmployeePermissions(
    user,
    store.people,
    store.teams,
  );
  const activeSession = getActiveActorSession();
  const effectiveTokenRoles =
    options?.tokenRoles ??
    (activeSession?.personId === user.id ? activeSession.tokenRoles : undefined);
  const currentUserPermissions = resolvePersonPermissions(user, {
    allPeople: store.people,
    teams: store.teams,
    tokenRoles: effectiveTokenRoles,
  });
  const rbacConfig = getDefaultTenantRbacConfig();
  const orgStructure =
    store.orgStructure ??
    buildDefaultOrgStructure({
      legalName: getActiveTenantConfiguration().displayName,
    });

  // Filter employment records on people at the API level based on requesting user's permissions
  const filteredPeople: Person[] = store.people.map((p) => {
    if (!p.employment) return p;
    return {
      ...p,
      employment: filterEmploymentForUser(
        p.employment,
        user,
        store.people,
        store.teams,
        orgStructure,
      ),
    };
  });

  // Never bulk-return sensitive HR records in page snapshots (R63); serve only via audited per-person read service.
  const employeeSensitiveRecords: Record<string, EmployeeSensitiveRecord> = {};

  // Data-layer record visibility filtering for the signed-in user (R152, R170, Rule 4):
  const visibility = buildRecordVisibility(store, user, {
    tokenRoles: effectiveTokenRoles,
  });
  const visibleMatters: Matter[] = store.matters.filter(visibility.canViewMatter);
  const hiddenMatterIds = visibility.hiddenMatterIds;
  const hiddenMatterSourceQuoteIds = visibility.hiddenMatterSourceQuoteIds;
  const hiddenMatterKeyDateIds = new Set(
    (store.keyDates ?? [])
      .filter((kd) => Boolean(kd.matterId && hiddenMatterIds.has(kd.matterId)))
      .map((kd) => kd.id),
  );

  // Filter enquiries: hide personal Drafts belonging to another user and enquiries converted into a hidden matter,
  // and strip hidden matter conflict hits from conflictSnapshot.
  const visibleEnquiries: Enquiry[] = store.enquiries
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
    store.enquiries
      .filter((e) => !visibleEnquiryIdSet.has(e.id))
      .map((e) => e.id),
  );

  // Filter quotes: require quote:view and hide quotes linked to or converted into a hidden matter or hidden enquiry.
  const visibleQuotes: Quote[] = currentUserPermissions.includes('quote:view')
    ? (store.quotes ?? []).filter(visibility.canViewQuote)
    : [];
  const visibleQuoteIdSet = new Set(visibleQuotes.map((q) => q.id));
  const hiddenQuoteIds = new Set(
    (store.quotes ?? [])
      .filter((q) => !visibleQuoteIdSet.has(q.id))
      .map((q) => q.id),
  );

  // Filter tasks: hide any task linked to a hidden matter, hidden enquiry, hidden quote, or hidden key date.
  const visibleTasks: Task[] = store.tasks.filter(visibility.canViewTask);
  const visibleTaskIdSet = new Set(visibleTasks.map((t) => t.id));
  const hiddenTaskIds = new Set(
    store.tasks.filter((t) => !visibleTaskIdSet.has(t.id)).map((t) => t.id),
  );

  // Person-to-organisation links only connect People and Organisations.
  const visibleLinks = store.links;

  const leaverOwnedRecords = findRecordsOwnedByLeavers(
    store.people,
    store.organisations,
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
  const currentUserRoles = resolveEmployeeRoles(user, store.teams);
  const activeViewingRole = resolveActiveViewingRole(user, homePagesConfig, store.teams);
  const keyDatesConfig = getKeyDatesConfig(store);
  const currentUserKeyDatePermissions = resolveKeyDatePermissions(user, {
    config: keyDatesConfig,
    allPeople: store.people,
    teams: store.teams,
  });
  const baseRail = getLeftRailVisibility(activeViewingRole, currentUserRoles);
  const leftRailVisibility = {
    ...baseRail,
    keyDates:
      Boolean(keyDatesConfig.enabled) &&
      baseRail.keyDates &&
      currentUserKeyDatePermissions.includes('keydate:view'),
  };

  // Data-layer filtering of key dates for restricted (staff) matters and team scoping (R32, R37):
  const permittedDiaryTeamIds = new Set(
    resolvePermittedDiaryTeamIds(user, undefined, store.teams, {
      config: keyDatesConfig,
      allPeople: store.people,
      teams: store.teams,
    }),
  );
  const matterByIdForKd = new Map(store.matters.map((m) => [m.id, m]));
  const visibleKeyDates: KeyDate[] = currentUserKeyDatePermissions.includes('keydate:view')
    ? (store.keyDates ?? []).filter((kd) => {
        if (!permittedDiaryTeamIds.has(kd.teamId)) return false;
        if (!kd.matterId) return true;
        const m = matterByIdForKd.get(kd.matterId);
        return canViewerAccessMatterKeyDates(m, user.id, user, store.people);
      })
    : [];
  const visibleKeyDateIdSet = new Set(visibleKeyDates.map((kd) => kd.id));
  const visibleKeyDateNotApplicable: KeyDateNotApplicable[] = currentUserKeyDatePermissions.includes('keydate:view')
    ? (store.keyDateNotApplicable ?? []).filter((na) => {
        const m = matterByIdForKd.get(na.matterId);
        return canViewerAccessMatterKeyDates(m, user.id, user, store.people);
      })
    : [];
  const visibleKeyDateReminderStates: KeyDateReminderState[] = (store.keyDateReminderStates ?? []).filter(
    (rs) => visibleKeyDateIdSet.has(rs.keyDateId),
  );
  const visibleKeyDateCalendarSyncs: KeyDateCalendarSync[] = (store.keyDateCalendarSyncs ?? []).filter(
    (cs) => visibleKeyDateIdSet.has(cs.keyDateId),
  );

  // If the current user is a demo user with showsWorkOfId, resolve the underlying employee for personal panels
  const effectiveWorkPerson: Person =
    user.demo && user.showsWorkOfId
      ? (store.people.find((p) => p.id === user.showsWorkOfId) ?? user)
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
      const pms = getPmsSource();
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
    store.people,
    store.organisations,
    visibleLinks,
    store.values,
    visibleMatters,
    visibleEnquiries,
    visibleTasks,
    store.teams,
    resolvedFirmName,
  );
  const attention = attentionList([...store.people, ...store.organisations], store.values, now, {
    userId: effectiveWorkPerson.id,
    tasks: visibleTasks,
    enquiries: visibleEnquiries,
    teams: store.teams,
    matters: visibleMatters,
    pmsSummaryByMatterId: pmsSummaryByMatterIdForAttention,
    canViewFinance: finance.canViewMatter,
  });
  const rawRecentIds = store.recentlyViewed[user.id] ?? store.recentlyViewed[effectiveWorkPerson.id] ?? [];
  const recentIds = rawRecentIds.filter(
    (id) =>
      !hiddenMatterIds.has(id) &&
      !hiddenTaskIds.has(id) &&
      !hiddenEnquiryIds.has(id) &&
      !hiddenQuoteIds.has(id),
  );
  const userNotifications = store.notifications
    .filter(
      (n) =>
        (n.recipientId === user.id || n.recipientId === effectiveWorkPerson.id) &&
        !(
          hiddenMatterIds.has(n.recordId) ||
          hiddenTaskIds.has(n.recordId) ||
          hiddenEnquiryIds.has(n.recordId) ||
          hiddenQuoteIds.has(n.recordId)
        ),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const taskBadgeCount = countMyUrgentBadgeTasks(visibleTasks, effectiveWorkPerson.id, now);

  const visibleSignOffs = (store.signOffs ?? []).filter(
    (s) => !(s.matterId && hiddenMatterIds.has(s.matterId)),
  );
  const visibleNotes = store.notes.filter(
    (n) =>
      !hiddenMatterIds.has(n.recordId) &&
      !hiddenTaskIds.has(n.recordId) &&
      !hiddenEnquiryIds.has(n.recordId) &&
      !hiddenQuoteIds.has(n.recordId),
  );
  const visibleAudit = store.audit.filter((a) => {
    if (a.recordType === 'matter' && hiddenMatterIds.has(a.recordId)) return false;
    if (a.recordType === 'task' && hiddenTaskIds.has(a.recordId)) return false;
    if (a.recordType === 'enquiry' && hiddenEnquiryIds.has(a.recordId)) return false;
    if (a.recordType === 'quote' && hiddenQuoteIds.has(a.recordId)) return false;
    if (a.recordType === 'key_date') {
      if (hiddenMatterKeyDateIds.has(a.recordId)) return false;
      const prefix = a.recordId.split(':')[0];
      if (prefix && hiddenMatterIds.has(prefix)) return false;
    }
    return true;
  });

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
    }
  }

  const canTakeByTaskId: Record<string, boolean> = {};
  for (const t of visibleTasks) {
    canTakeByTaskId[t.id] = canUserTakeTask(
      user.id,
      t,
      store.teams,
      store.people,
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
      allPeople: store.people,
      teams: store.teams,
    });
  }

  const canReopenByEnquiryId: Record<string, boolean> = {};
  for (const eq of visibleEnquiries) {
    canReopenByEnquiryId[eq.id] =
      currentUserPermissions.includes('enquiry:reopen') &&
      canUserReopenEnquiry(
        user.id,
        eq,
        store.teams,
        store.people,
        store.values,
      );
  }

  const appRoleByPersonId: Record<string, AppRole> = {};
  const rolesByPersonId: Record<string, HomeRoleKey[]> = {};
  const permissionsByPersonId: Record<string, PermissionKey[]> = {};
  for (const emp of store.people) {
    if (!emp.isEmployee || emp.mergedIntoId) continue;
    appRoleByPersonId[emp.id] = resolveUserAppRole(
      emp,
      store.teams,
      store.values,
    );
    rolesByPersonId[emp.id] = resolveEmployeeRoles(emp, store.teams);
    permissionsByPersonId[emp.id] = resolvePersonPermissions(emp, {
      allPeople: store.people,
      teams: store.teams,
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
    store,
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
    employeeMigrationReport: store.employeeMigrationReport,
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
    organisations: store.organisations,
    links: visibleLinks,
    matters: visibleMatters,
    teams: store.teams,
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
    mergeHistory: store.mergeHistory,
    searchIndex,
    attention,
    recentIds,
  };
}

export function recordRecentlyViewed(userId: string, recordId: string): void {
  const store = getStore();
  const current = store.recentlyViewed[userId] ?? [];
  if (current[0] === recordId) {
    return;
  }
  const next = [recordId, ...current.filter((id) => id !== recordId)].slice(0, 8);
  store.recentlyViewed[userId] = next;
  saveStore(store);
}

/**
 * API-level read of a person's employment and sensitive records, enforcing permissions
 * and optionally logging views of restricted payroll or sensitive sections.
 */
export function getEmployeeDetailsForUser(
  personId: string,
  byId: string,
  opts: { logViewPayroll?: boolean; logViewSensitive?: boolean } = {},
): {
  employment: EmploymentRecord | null;
  sensitive: EmployeeSensitiveRecord | null;
  permissions: EmployeePermission[];
  errors?: Record<string, string>;
} {
  const store = getStore();
  const user = store.people.find((p) => p.id === byId) ?? null;
  const person = store.people.find((p) => p.id === personId) ?? null;
  const perms = resolveEmployeePermissions(user, store.people, store.teams);
  const errors: Record<string, string> = {};

  if (!person) {
    return { employment: null, sensitive: null, permissions: perms, errors: { notFound: 'Person not found.' } };
  }

  if (opts.logViewPayroll) {
    const payrollLogRes = logEmployeeRestrictedAccess(personId, 'payroll', byId);
    if (!payrollLogRes.auditEntry) {
      errors.payrollPermission = 'You do not have permission to view payroll details.';
    }
  }

  let sensitiveAuditWritten = false;
  if (opts.logViewSensitive) {
    const sensitiveLogRes = logEmployeeRestrictedAccess(personId, 'sensitive', byId);
    if (!sensitiveLogRes.auditEntry) {
      errors.sensitivePermission = 'You do not have permission to view sensitive employee information.';
    } else {
      sensitiveAuditWritten = true;
    }
  }

  const employment = filterEmploymentForUser(
    person.employment,
    user,
    store.people,
    store.teams,
    store.orgStructure,
  );
  // R103 & R130: Only return sensitive HR records when logViewSensitive: true and logEmployeeRestrictedAccess succeeded
  const sensitive = sensitiveAuditWritten
    ? structuredClone(store.employeeSensitiveRecords?.[personId] ?? null)
    : null;

  return {
    employment,
    sensitive,
    permissions: perms,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

/**
 * Logs every view of payroll and sensitive fields with user and timestamp.
 */
export function logEmployeeRestrictedAccess(
  personId: string,
  section: 'payroll' | 'sensitive',
  byId: string,
  fieldDetail?: string,
): { auditEntry?: AuditEntry; error?: string } {
  const store = getStore();
  const user = store.people.find((p) => p.id === byId) ?? null;
  const requiredPerm: EmployeePermission =
    section === 'payroll' ? 'employee:payroll' : 'employee:sensitive';

  if (!hasEmployeePermission(user, requiredPerm, store.people, store.teams)) {
    return { error: `Permission denied: ${requiredPerm} is required.` };
  }

  const entry = writeAudit(store, {
    recordType: section === 'payroll' ? 'employee_payroll' : 'employee_sensitive',
    recordId: personId,
    action: section === 'payroll' ? 'view-payroll' : 'view-sensitive',
    field: fieldDetail ?? (section === 'payroll' ? 'Payroll & benefits' : 'Sensitive information'),
    oldValue: null,
    newValue: `Viewed by ${user ? personDisplayName(user) : byId}`,
    byId,
  });
  saveStore(store);
  return { auditEntry: entry };
}

/**
 * Reassigns records owned by a leaver to another active employee.
 */
export function reassignLeaverOwnedRecords(
  fromLeaverId: string,
  toEmployeeId: string,
  byId: string,
): { reassignedCount: number; errors?: Record<string, string> } & Partial<ActionDenied> {
  const store = getStore();
  const now = new Date().toISOString();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
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

  const fromLeaver = store.people.find((p) => p.id === fromLeaverId);
  if (!fromLeaver || !isLeaverPerson(fromLeaver)) {
    const msg = 'Source person must be an existing leaver.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      reassignedCount: 0,
      errors: { fromLeaverId: msg },
    };
  }

  const targetEmp = store.people.find((p) => p.id === toEmployeeId);
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

  for (const p of store.people) {
    if (p.mergedIntoId) continue;
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
    if (movedRoles.length > 0) {
      p.updatedAt = now;
      p.updatedById = byId;
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

  for (const o of store.organisations) {
    if (o.mergedIntoId) continue;
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
    if (movedRoles.length > 0) {
      o.updatedAt = now;
      o.updatedById = byId;
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

  for (const m of store.matters) {
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
      if (isRestricted && prevMatter) {
        const syncCorrelationId = `corr-leaver-reassign-${m.id}-${Date.now()}`;
        try {
          void syncMatterLifecycleOnSaveSync({
            matter: m,
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
      }
    }
  }

  for (const t of store.tasks) {
    if (t.status === 'Done' || t.status === 'Cancelled') continue;
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

  for (const e of store.enquiries) {
    if (!isEnquiryOpen(e)) continue;
    if (e.assignedToId === fromLeaverId) {
      e.assignedToId = toEmployeeId;
      e.updatedAt = now;
      e.updatedById = byId;
      count++;
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

  saveStore(store);
  return { reassignedCount: count };
}

export function savePersonRecord(
  input: Partial<Person> & { firstName: string; surname: string },
  opts: {
    id?: string;
    byId: string;
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
): ({ person: Person; errors?: Record<string, string> } & Partial<ActionDenied>) {
  const store = getStore();
  const now = new Date().toISOString();
  const today = toIsoDate(new Date());
  const existing = opts.id ? store.people.find((p) => p.id === opts.id) ?? null : null;
  const actingUser = store.people.find((p) => p.id === opts.byId) ?? null;
  const permSet = resolvePersonPermissionSet(actingUser, {
    allPeople: store.people,
    teams: store.teams,
    targetPersonId: existing?.id,
  });
  const userPerms = new Set([
    ...resolveEmployeePermissions(actingUser, store.people, store.teams, {
      targetPersonId: existing?.id,
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
    const msg = `Security field "${attemptedSecurityField}" cannot be set or modified through person save. Use the dedicated RBAC administration actions.`;
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      person: existing as Person,
      errors: { permission: msg },
    };
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
      const msg =
        'You do not have permission (employee:edit_core) to create or edit employment records.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
  } else if (!opts.internalSystemStep) {
    const requiredContactKey = existing ? 'contact:edit' : 'contact:create';
    if (!userPerms.has(requiredContactKey)) {
      const msg = existing
        ? 'You do not have permission (contact:edit) to edit contact records.'
        : 'You do not have permission (contact:create) to create contact records.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
  }

  // Enforce API-level permission checks on employment & sensitive data modifications
  if (rawEmpInput) {
    if (!userPerms.has('employee:edit_core')) {
      const msg =
        'You do not have permission (employee:edit_core) to create or edit employment records.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
    if (
      (rawEmpInput.contract !== undefined ||
        rawEmpInput.rightToWork !== undefined ||
        rawEmpInput.emergencyContacts !== undefined) &&
      !userPerms.has('employee:hr_restricted')
    ) {
      const msg =
        'You do not have permission (employee:hr_restricted) to edit HR restricted fields (contract, right to work, emergency contacts).';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
    if (rawEmpInput.payroll !== undefined && !userPerms.has('employee:payroll')) {
      const msg =
        'You do not have permission (employee:payroll) to edit payroll and benefits fields.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
  }

  if (opts.sensitiveSubmitted !== undefined && opts.sensitiveSubmitted !== null) {
    if (!userPerms.has('employee:sensitive')) {
      const msg =
        'You do not have permission (employee:sensitive) to edit sensitive employee information.';
      return {
        ...buildActionDenied('FORBIDDEN', msg),
        person: existing as Person,
        errors: {
          permission: msg,
        },
      };
    }
  }

  const effectiveDob =
    input.dateOfBirth !== undefined ? input.dateOfBirth : existing?.dateOfBirth ?? null;
  const targetPersonId = existing?.id ?? nextId(store, 'P');

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
        allPeople: store.people,
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
      return {
        person: existing as Person,
        errors: { employeeRoleId: 'An employee must have a role type.' },
      };
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
      const empErrors = validateEmploymentRecord(candidateEmp, {
        personId: targetPersonId,
        dateOfBirth: effectiveDob,
        allPeople: store.people,
        orgStructure,
        requireContractStartDate: Boolean(rawEmpInput.contract),
      });
      if (Object.keys(empErrors).length > 0) {
        return { person: existing as Person, errors: empErrors };
      }
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
        emails: input.emails ?? existing.emails ?? [],
        phones: input.phones ?? existing.phones ?? [],
        relationshipRoleIds: input.relationshipRoleIds ?? existing.relationshipRoleIds ?? [],
      },
      existing.employment,
      today,
      opts.keepAsContactOnLeave ?? true,
      resolveConfiguredFirmPrimaryDomain(),
    );
    input.emails = leavingRes.emails;
    input.phones = leavingRes.phones;
    input.relationshipRoleIds = leavingRes.relationshipRoleIds;
    nextEmployment = leavingRes.employment;
  }

  // Handle conversion path 3: Status set to 'Leaver'
  if (nextEmployment && nextEmployment.status === 'Leaver') {
    const leavingDate =
      nextEmployment.contract?.leavingDate || nextEmployment.effectiveTo || today;
    const leavingRes = applyLeaverEffects(
      {
        emails: input.emails ?? existing?.emails ?? [],
        phones: input.phones ?? existing?.phones ?? [],
        relationshipRoleIds: input.relationshipRoleIds ?? existing?.relationshipRoleIds ?? [],
      },
      nextEmployment,
      leavingDate,
      opts.keepAsContactOnLeave ?? nextEmployment.contract?.keepAsContactOnLeave ?? true,
      resolveConfiguredFirmPrimaryDomain(),
    );
    input.emails = leavingRes.emails;
    input.phones = leavingRes.phones;
    input.relationshipRoleIds = leavingRes.relationshipRoleIds;
    nextEmployment = leavingRes.employment;
  }

  const cfValidation = validateCustomFields(
    store.customFields,
    'person',
    opts.customFieldsSubmitted ?? input.customFields ?? {},
    existing?.customFields ?? {},
    store.values,
  );
  if (Object.keys(cfValidation.errors).length > 0) {
    return { person: existing as Person, errors: cfValidation.errors };
  }

  // Handle conversion path 1: Contact or client becomes an employee
  const wasWorkingAtFirm = isWorkingAtFirm(existing);
  const nowWorkingAtFirm = Boolean(nextEmployment && nextEmployment.status !== 'Leaver');
  if (!wasWorkingAtFirm && nowWorkingAtFirm && nextEmployment) {
    const openMatters = findOpenMattersWherePersonIsParty(targetPersonId, store.matters);
    nextEmployment.conflictCheckOnHire = {
      checkedAt: now,
      openMatterIds: openMatters.map((m) => m.id),
      flaggedToRisk: openMatters.length > 0,
      informationBarrierConsidered: openMatters.length > 0,
      riskNotes:
        openMatters.length > 0
          ? `Person is a party on ${openMatters.length} open matter(s) (${openMatters.map((m) => m.matterNumber).join(', ')}). Flagged to Risk & Compliance to consider an information barrier.`
          : 'No open matter conflicts detected on hire.',
    };

    if (openMatters.length > 0) {
      // Flag to Risk & Compliance so an information barrier can be considered
      const riskOfficerId =
        store.people.find(
          (p) =>
            isWorkingAtFirm(p) &&
            (p.roles?.includes('risk_compliance') ||
              p.employeeRoleId === 'employee_role.risk_and_compliance'),
        )?.id ?? opts.byId;
      store.notifications.unshift({
        id: nextId(store, 'NTF'),
        recipientId: riskOfficerId,
        kind: 'task_assigned',
        title: `Information barrier review required: ${input.firstName.trim()} ${input.surname.trim()}`,
        detail: `${input.firstName.trim()} ${input.surname.trim()} is joining the firm and is a party on open matter(s): ${openMatters.map((m) => m.matterNumber).join(', ')}.`,
        href: `/people/${targetPersonId}`,
        recordId: targetPersonId,
        createdAt: now,
        read: false,
        byId: opts.byId,
      });

      writeAudit(store, {
        recordType: 'person',
        recordId: targetPersonId,
        action: 'status-change',
        field: 'Conflict check on hire (Risk flag)',
        oldValue: 'External contact / client',
        newValue: nextEmployment.conflictCheckOnHire.riskNotes,
        byId: opts.byId,
        at: now,
      });

      // Also if the person is a client on any of those open matters, mark them as staff matters with restricted access
      for (const m of openMatters) {
        if (m.clientId === targetPersonId || m.additionalClientIds?.includes(targetPersonId)) {
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
          saveStore(store);
          const syncCorrelationId = `corr-lifecycle-sync-${m.id}-${Date.now()}`;
          try {
            void syncMatterLifecycleOnSaveSync({
              matter: m,
              previousMatter: prevMatter,
              userId: opts.byId,
              correlationId: syncCorrelationId,
              store,
            }).catch((err) => {
              logDocumentLifecycleSyncError(err, syncCorrelationId);
            });
          } catch (err) {
            logDocumentLifecycleSyncError(err, syncCorrelationId);
          }
        }
      }
    }
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
    emails: input.emails ?? existing?.emails ?? [],
    phones: input.phones ?? existing?.phones ?? [],
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
    relationshipRoleIds: input.relationshipRoleIds ?? existing?.relationshipRoleIds ?? [],
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

  // Audit payroll changes with user and timestamp
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

  // Store & audit sensitive information separately from main employment record (R76).
  // Require the sensitive section to be explicitly opened and edited when updating an existing record
  // or when sensitiveSectionOpened / sensitiveSectionEdited flags are supplied.
  const canApplySensitiveSubmission =
    Boolean(opts.sensitiveSubmitted) &&
    opts.sensitiveSectionOpened !== false &&
    opts.sensitiveSectionEdited !== false &&
    (!store.employeeSensitiveRecords?.[person.id] ||
      (opts.sensitiveSectionOpened === true &&
        opts.sensitiveSectionEdited === true));

  if (canApplySensitiveSubmission && opts.sensitiveSubmitted) {
    if (!store.employeeSensitiveRecords) {
      store.employeeSensitiveRecords = {};
    }
    const oldSens = store.employeeSensitiveRecords[person.id] ?? null;
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
      store.employeeSensitiveRecords[person.id] = nextSens;
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

  const ctx = formatContext(store);
  if (!existing) {
    store.people.push(person);
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
  } else {
    const idx = store.people.findIndex((p) => p.id === existing.id);
    const changes = diffRecords(
      'person',
      existing as unknown as Record<string, unknown>,
      person as unknown as Record<string, unknown>,
      ctx,
      store.customFields,
    );
    store.people[idx] = person;
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
      const other = store.people.find((p) => p.id === otherId);
      if (other && !other.possibleMatchIds.includes(person.id)) {
        other.possibleMatchIds.push(person.id);
        other.duplicateStatusId = dupPossible;
      }
    }
  }

  if (person.createdFromEnquiryId) {
    const srcEnq = store.enquiries.find((e) => e.id === person.createdFromEnquiryId);
    if (srcEnq && !srcEnq.linkedPersonId) {
      srcEnq.linkedPersonId = person.id;
    }
  }

  if (!existing && opts.initialLink?.organisationId) {
    createOrUpdateLink(
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

  // Keep operational teams (store.teams) synchronised with the employee's Organisation Structure Department / Team
  if (person.employment) {
    if (person.employment.status === 'Leaver') {
      for (const tm of store.teams) {
        tm.memberIds = tm.memberIds.filter((id) => id !== person.id);
        tm.leadIds = tm.leadIds.filter((id) => id !== person.id);
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
        const matchingTeam = store.teams.find(
          (tm) =>
            tm.name.toLowerCase() === targetTeamName.toLowerCase() ||
            (deptObj && tm.name.toLowerCase().includes(deptObj.name.toLowerCase())),
        );
        if (matchingTeam) {
          if (!matchingTeam.memberIds.includes(person.id)) {
            matchingTeam.memberIds.push(person.id);
          }
          if (
            person.employment.roleType === 'Partner/Member' &&
            !matchingTeam.leadIds.includes(person.id)
          ) {
            matchingTeam.leadIds.push(person.id);
          }
        }
      }
    }
  }

  saveStore(store);
  return { person };
}

export function saveOrganisationRecord(
  input: Partial<Organisation> & { legalName: string },
  opts: {
    id?: string;
    byId: string;
    customFieldsSubmitted?: Record<string, unknown>;
    flagPossibleDuplicate?: boolean;
    matchedDuplicateIds?: string[];
    internalSystemStep?: 'enquiry_conversion' | 'quote_conversion';
  },
): { organisation: Organisation; errors?: Record<string, string> } & Partial<ActionDenied> {
  const store = getStore();
  const now = new Date().toISOString();
  const today = toIsoDate(new Date());
  const existing = opts.id ? store.organisations.find((o) => o.id === opts.id) ?? null : null;
  if (opts.id && !existing) {
    const msg = 'Organisation not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      organisation: null as unknown as Organisation,
      errors: { notFound: msg },
    };
  }

  if (!opts.internalSystemStep) {
    const actor = store.people.find((p) => p.id === opts.byId) ?? null;
    const requiredPerm = existing ? 'contact:edit' : 'contact:create';
    if (
      !hasPersonPermission(actor, requiredPerm, {
        allPeople: store.people,
        teams: store.teams,
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

  const organisation: Organisation = {
    id: existing?.id ?? nextId(store, 'O'),
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

  const ctx = formatContext(store);
  if (!existing) {
    store.organisations.push(organisation);
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
    const idx = store.organisations.findIndex((o) => o.id === existing.id);
    const changes = diffRecords(
      'organisation',
      existing as unknown as Record<string, unknown>,
      organisation as unknown as Record<string, unknown>,
      ctx,
      store.customFields,
    );
    store.organisations[idx] = organisation;
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

  if (opts.flagPossibleDuplicate && opts.matchedDuplicateIds?.length) {
    for (const otherId of opts.matchedDuplicateIds) {
      const other = store.organisations.find((o) => o.id === otherId);
      if (other && !other.possibleMatchIds.includes(organisation.id)) {
        other.possibleMatchIds.push(organisation.id);
        other.duplicateStatusId = dupPossible;
      }
    }
  }

  saveStore(store);
  return { organisation };
}

export function createOrUpdateLink(
  input: Omit<PersonOrganisationLink, 'id' | 'createdById' | 'createdAt' | 'updatedById' | 'updatedAt'> & {
    id?: string;
  },
  byId: string,
  opts?: { internalSystemStep?: boolean },
): PersonOrganisationLink & Partial<ActionDenied> {
  const store = getStore();
  const now = new Date().toISOString();
  const existing = input.id ? store.links.find((l) => l.id === input.id) ?? null : null;
  if (input.id && !existing) {
    return buildActionDenied(
      'FORBIDDEN',
      `Organisation link "${input.id}" not found.`,
    ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
  }
  const person = store.people.find((p) => p.id === input.personId);
  const org = store.organisations.find((o) => o.id === input.organisationId);
  if (!person || !org) {
    return buildActionDenied(
      'FORBIDDEN',
      'Linked person or organisation not found.',
    ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
  }
  if (!opts?.internalSystemStep) {
    const actor = store.people.find((p) => p.id === byId) ?? null;
    const requiredPerm = existing ? 'contact:edit' : 'contact:create';
    if (
      !hasPersonPermission(actor, requiredPerm, {
        allPeople: store.people,
        teams: store.teams,
      })
    ) {
      return buildActionDenied(
        'FORBIDDEN',
        `You do not have permission (${requiredPerm}) to ${existing ? 'update' : 'create'} a person-organisation link.`,
      ) as unknown as PersonOrganisationLink & Partial<ActionDenied>;
    }
  }
  const label = `${person ? personDisplayName(person) : input.personId} ↔ ${org ? org.legalName : input.organisationId}`;

  const link: PersonOrganisationLink = {
    id: existing?.id ?? nextId(store, 'L'),
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

  if (!existing) {
    store.links.push(link);
    for (const [rtype, rid] of [
      ['person', link.personId],
      ['organisation', link.organisationId],
    ] as const) {
      writeAudit(store, {
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
    const idx = store.links.findIndex((l) => l.id === existing.id);
    store.links[idx] = link;
    for (const [rtype, rid] of [
      ['person', link.personId],
      ['organisation', link.organisationId],
    ] as const) {
      writeAudit(store, {
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
  saveStore(store);
  return link;
}

export function deleteLink(linkId: string, byId: string): { ok: true } | ActionDenied {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'contact:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (contact:edit) to delete a person-organisation link.',
    );
  }
  const existing = store.links.find((l) => l.id === linkId);
  if (!existing) {
    return buildActionDenied('FORBIDDEN', `Organisation link "${linkId}" not found.`);
  }
  const person = store.people.find((p) => p.id === existing.personId);
  const org = store.organisations.find((o) => o.id === existing.organisationId);
  const label = `${person ? personDisplayName(person) : existing.personId} ↔ ${org ? org.legalName : existing.organisationId}`;
  store.links = store.links.filter((l) => l.id !== linkId);
  for (const [rtype, rid] of [
    ['person', existing.personId],
    ['organisation', existing.organisationId],
  ] as const) {
    writeAudit(store, {
      recordType: rtype,
      recordId: rid,
      action: 'unlink',
      field: 'Organisation link',
      oldValue: label,
      newValue: null,
      byId,
    });
  }
  saveStore(store);
  return { ok: true };
}

export function addNoteToRecord(
  recordType: RecordType | 'matter',
  recordId: string,
  text: string,
  byId: string,
): Note & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actor);

  const target: (AnyRecord | Matter) | undefined =
    recordType === 'person'
      ? store.people.find((p) => p.id === recordId)
      : recordType === 'matter'
        ? store.matters.find((m) => m.id === recordId)
        : store.organisations.find((o) => o.id === recordId);

  if (!target) {
    return buildActionDenied(
      'FORBIDDEN',
      `Target ${recordType} "${recordId}" not found.`,
    ) as unknown as Note & Partial<ActionDenied>;
  }

  if (recordType === 'matter') {
    if (
      !hasPersonPermission(actor, 'matter:edit', {
        allPeople: store.people,
        teams: store.teams,
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
        allPeople: store.people,
        teams: store.teams,
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
        allPeople: store.people,
        teams: store.teams,
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
  const note: Note = {
    id: nextId(store, 'N'),
    recordType,
    recordId,
    authorId: byId,
    at: now,
    text: text.trim(),
  };
  store.notes.unshift(note);

  const oldInteraction = target.lastInteractionAt;
  target.lastInteractionAt = today;
  if (recordType === 'matter') {
    touchMatter(target as Matter, byId);
  } else {
    target.updatedAt = now;
    target.updatedById = byId;
  }
  writeAudit(store, {
    recordType,
    recordId,
    action: 'note',
    field: 'Note added',
    oldValue: oldInteraction,
    newValue: note.text.slice(0, 120),
    byId,
    at: now,
  });
  saveStore(store);
  return note;
}

export function generateMatterNumber(store: FirmStore, clientId: string): string {
  const org = store.organisations.find((o) => o.id === clientId);
  const person = store.people.find((p) => p.id === clientId);
  let prefix = 'MAT001';
  if (org?.clientReference?.trim()) {
    prefix = org.clientReference.trim().toUpperCase();
  } else if (org) {
    prefix = org.legalName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X') + '001';
  } else if (person) {
    prefix = person.surname.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X') + '001';
  }
  const existingForClient = store.matters.filter((m) => m.clientId === clientId || m.matterNumber.startsWith(`${prefix}-`));
  let maxSeq = existingForClient.length;
  for (const m of existingForClient) {
    const match = m.matterNumber.match(/-(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
  }
  const nextSeq = maxSeq + 1;
  return `${prefix}-${String(nextSeq).padStart(4, '0')}`;
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

  // 2. Key-dates opening gate (when the Key Dates module is enabled for the tenant).
  const kdConfig = getKeyDatesConfig(store);
  if (kdConfig.enabled) {
    const targetMatterTypeId = matter.matterTypeId || matter.practiceAreaId;
    const matterKds = isNewMatter
      ? []
      : (store.keyDates ?? []).filter((kd) => kd.matterId === matter.id);
    const matterNas = isNewMatter
      ? []
      : (store.keyDateNotApplicable ?? []).filter(
          (na) => na.matterId === matter.id,
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
  },
): Promise<{ matter: Matter | null; errors?: Record<string, string> }> {
  const store = getStore();
  const existingRef = opts.id ? store.matters.find((m) => m.id === opts.id) ?? null : null;
  const existing = existingRef ? structuredClone(existingRef) : null;
  const existingUpdatedAt = existing?.updatedAt ?? null;
  const now = nextMonotonicIsoTimestamp(existing?.updatedAt);
  const today = toIsoDate(new Date());
  const actingUser = store.people.find((p) => p.id === opts.byId) ?? null;
  if (!actingUser || !actingUser.isEmployee) {
    return {
      matter: null,
      errors: {
        access: 'Matter not found or restricted.',
        permission: 'Matter not found or restricted.',
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
  const tenantCfg = getActiveTenantConfiguration();
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
        allPeople: store.people,
        teams: store.teams,
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
        allPeople: store.people,
        teams: store.teams,
      })
    ) {
      return {
        matter: null,
        errors: {
          permission: 'You do not have permission (matter:edit) to edit matters.',
        },
      };
    }
  } else {
    if (
      !hasPersonPermission(actingUser, 'matter:create', {
        allPeople: store.people,
        teams: store.teams,
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
        allPeople: store.people,
        teams: store.teams,
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

  // Enforce Key Dates closure gate (§1; opening gate runs via runMatterOpeningGate)
  const kdConfig = getKeyDatesConfig(store);
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
      const matterKds = (store.keyDates ?? []).filter(
        (kd) => kd.matterId === targetMatterId,
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
  const pendingEnquiryLinks: Array<{ enquiry: Enquiry; linkedPersonId: string }> = [];

  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const cmiIncompleteStatus =
    store.values.find((v) => v.listKey === 'matter_status' && v.label === 'CMI incomplete')?.id ??
    vid('matter_status', 'CMI incomplete');
  const prospectiveStatus = resolveProspectiveStatusId(store);

  const promoteEnquiryPersonId = (rawId: string | null | undefined): string | null => {
    if (!rawId) return null;
    if (!rawId.startsWith('ENQ-')) return rawId;
    const enq = store.enquiries.find((e) => e.id === rawId);
    if (!enq) return rawId;
    if (
      enq.linkedPersonId &&
      (store.people.some((p) => p.id === enq.linkedPersonId) ||
        pendingPeople.some((p) => p.id === enq.linkedPersonId))
    ) {
      return enq.linkedPersonId;
    }
    const existingPendingLink = pendingEnquiryLinks.find((l) => l.enquiry.id === enq.id);
    if (existingPendingLink) {
      return existingPendingLink.linkedPersonId;
    }
    const existingFromEnq =
      store.people.find((p) => p.createdFromEnquiryId === enq.id) ??
      pendingPeople.find((p) => p.createdFromEnquiryId === enq.id);
    if (existingFromEnq) {
      pendingEnquiryLinks.push({ enquiry: enq, linkedPersonId: existingFromEnq.id });
      return existingFromEnq.id;
    }
    const newPersonId = nextId(store, 'P');
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
    pendingEnquiryLinks.push({ enquiry: enq, linkedPersonId: newPersonId });
    return newPersonId;
  };

  const effectiveClientId =
    promoteEnquiryPersonId(
      input.clientId !== undefined ? input.clientId : existing?.clientId,
    ) ?? '';
  const rawMatterNumber = (input.matterNumber ?? existing?.matterNumber ?? '').trim();
  const matterNumber = isDraftSave
    ? rawMatterNumber || 'DRAFT'
    : !rawMatterNumber || rawMatterNumber === 'DRAFT'
      ? generateMatterNumber(store, effectiveClientId)
      : rawMatterNumber;

  // Auto-create new contacts/organisations on save for any party added by typing a new name
  const createdRecordByPartyId = new Map<string, string>();
  const resolvedParties = (input.parties ?? existing?.parties ?? []).map((pt) => {
    if (pt.linkedRecordId) {
      if (pt.linkedRecordId.startsWith('ENQ-')) {
        const promotedId = promoteEnquiryPersonId(pt.linkedRecordId);
        if (promotedId) {
          createdRecordByPartyId.set(pt.id, promotedId);
          return { ...pt, linkedRecordId: promotedId };
        }
      }
      return pt;
    }
    if (!pt.name?.trim() || pt.name.trim().startsWith('[')) {
      return pt;
    }
    const cleanName = pt.name.trim();
    const isPerson = pt.entityType === 'person';
    if (isPerson) {
      const existingPerson =
        store.people.find(
          (p) => !p.mergedIntoId && personDisplayName(p).toLowerCase() === cleanName.toLowerCase(),
        ) ??
        pendingPeople.find(
          (p) => !p.mergedIntoId && personDisplayName(p).toLowerCase() === cleanName.toLowerCase(),
        );
      if (existingPerson) {
        createdRecordByPartyId.set(pt.id, existingPerson.id);
        return { ...pt, linkedRecordId: existingPerson.id };
      }
      const parts = cleanName.split(/\s+/);
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : cleanName;
      const surname = parts.length > 1 ? parts[parts.length - 1] : 'Contact';
      const newPersonId = nextId(store, 'P');
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
      return { ...pt, linkedRecordId: newPersonId };
    } else {
      const existingOrg =
        store.organisations.find(
          (o) => !o.mergedIntoId && o.legalName.toLowerCase() === cleanName.toLowerCase(),
        ) ??
        pendingOrganisations.find(
          (o) => !o.mergedIntoId && o.legalName.toLowerCase() === cleanName.toLowerCase(),
        );
      if (existingOrg) {
        createdRecordByPartyId.set(pt.id, existingOrg.id);
        return { ...pt, linkedRecordId: existingOrg.id };
      }
      const newOrgId = nextId(store, 'O');
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
      return { ...pt, linkedRecordId: newOrgId };
    }
  });

  const allPeopleWithPending =
    pendingPeople.length > 0 ? [...store.people, ...pendingPeople] : store.people;
  const allOrganisationsWithPending =
    pendingOrganisations.length > 0
      ? [...store.organisations, ...pendingOrganisations]
      : store.organisations;

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
  const resolvedAdditionalClientIds = (
    input.additionalClientIds ??
    existing?.additionalClientIds ??
    []
  ).map((cid) => promoteEnquiryPersonId(cid) || cid);
  const resolvedInstructingContactId = promoteEnquiryPersonId(
    input.instructingContactId !== undefined
      ? input.instructingContactId
      : existing?.instructingContactId ?? null,
  );
  const resolvedBillingContactId = promoteEnquiryPersonId(
    input.billingContactId !== undefined
      ? input.billingContactId
      : existing?.billingContactId ?? null,
  );

  const actorHasRiskView = hasPersonPermission(actingUser, 'risk:view', {
    allPeople: allPeopleWithPending,
    teams: store.teams,
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
    { ...store, people: allPeopleWithPending },
    actingUser,
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
      matters: store.matters,
      enquiries: store.enquiries,
      people: allPeopleWithPending,
      organisations: allOrganisationsWithPending,
      links: store.links,
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

  const matter: Matter = {
    id: existing?.id ?? nextId(store, 'M'),
    recordType: 'matter',
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
    instructingContactId: promoteEnquiryPersonId(
      input.instructingContactId !== undefined ? input.instructingContactId : existing?.instructingContactId ?? null,
    ),
    billingContactId: promoteEnquiryPersonId(
      input.billingContactId !== undefined ? input.billingContactId : existing?.billingContactId ?? null,
    ),
    referrerTypeId: input.referrerTypeId !== undefined ? input.referrerTypeId : existing?.referrerTypeId ?? null,
    referrerContactId: promoteEnquiryPersonId(
      input.referrerContactId !== undefined ? input.referrerContactId : existing?.referrerContactId ?? null,
    ),
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

  if (existing) {
    const current = store.matters.find((m) => m.id === existing.id);
    if (!current || current.updatedAt !== existingUpdatedAt) {
      return {
        matter: null,
        errors: {
          conflict:
            'This matter was changed by someone else while you were saving. Please reload and try again.',
        },
      };
    }
  }

  for (const person of pendingPeople) {
    store.people.push(person);
  }
  for (const org of pendingOrganisations) {
    store.organisations.push(org);
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

  if (!existingHasOpened) {
    // Re-build fresh snapshot until the matter has actually opened (non-prospective status)
    const cleanFieldVals = { ...matter.fieldValues };
    delete cleanFieldVals['matterOpeningSnapshot'];
    const openingSnapshot = resolveMatterOpeningSnapshot(
      { ...matter, fieldValues: cleanFieldVals },
      store.people,
      store.organisations,
      store.values,
      store.enquiries,
      store.quotes,
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
      store.people,
      store.organisations,
      store.values,
      store.enquiries,
      store.quotes,
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

  if (!existing) {
    store.matters.unshift(matter);
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
      newValue: `${matter.conflictCheckRecord.status} (${matter.conflictCheckRecord.outcomeLabel}) · ${matter.conflictCheckRecord.parties.length} parties checked`,
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
      finalizeEnquiryConversionToMatter(store, matter.sourceEnquiryId, matter, opts.byId, now);
    }
    if (matter.sourceQuoteId) {
      finalizeQuoteConversionToMatter(store, matter.sourceQuoteId, matter, opts.byId, now);
    }
  } else {
    const idx = store.matters.findIndex((m) => m.id === existing.id);
    store.matters[idx] = matter;
    writeAudit(store, {
      recordType: 'matter',
      recordId: matter.id,
      action: 'update',
      field: 'Matter details & type-specific fields',
      oldValue: existing.title,
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
      finalizeEnquiryConversionToMatter(store, matter.sourceEnquiryId, matter, opts.byId, now);
    }
    if (matter.sourceQuoteId) {
      finalizeQuoteConversionToMatter(store, matter.sourceQuoteId, matter, opts.byId, now);
    }
  }

  // Handle To Do task creation / completion for Draft & Referred conflict checks
  const clientOrg = store.organisations.find((o) => o.id === matter.clientId);
  const clientPerson = store.people.find((p) => p.id === matter.clientId);
  const clientLabel =
    clientOrg?.legalName ||
    (clientPerson ? personDisplayName(clientPerson) : matter.title || 'Untitled matter');
  const draftTaskTitle = `Conflict check · ${clientLabel} · Draft`;

  const existingDraftTask = store.tasks.find(
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
    } else {
      const taskId = nextId(store, 'TSK');
      const linkedRecords: TaskLinkedRecord[] = [{ recordType: 'matter', recordId: matter.id }];
      if (clientOrg) linkedRecords.push({ recordType: 'organisation', recordId: clientOrg.id });
      else if (clientPerson) linkedRecords.push({ recordType: 'person', recordId: clientPerson.id });
      store.tasks.unshift({
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
      });
    }
  } else if (opts.saveMode === 'submit_cleared' || opts.saveMode === 'submit_referred') {
    if (existingDraftTask) {
      existingDraftTask.status = 'Done';
      existingDraftTask.completedById = opts.byId;
      existingDraftTask.completedAt = now;
      existingDraftTask.updatedAt = now;
      existingDraftTask.updatedById = opts.byId;
    }
    if (opts.saveMode === 'submit_referred') {
      const riskTaskId = nextId(store, 'TSK');
      const configuredTeamKey = tenantCfg.conflictReview?.assigneeTeamKey?.trim() || null;
      const configuredRoleKey = tenantCfg.conflictReview?.assigneeRoleKey?.trim() || null;
      const { team: resolvedRiskTeam, assigneeId: assignedReviewerId } =
        resolveConflictReviewTaskRouting(store, tenantCfg.conflictReview, matter);

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
      store.tasks.unshift({
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
      });
    }
  }

  saveStore(store);

  if (existing) {
    const syncCorrelationId = `corr-lifecycle-sync-${matter.id}-${Date.now()}`;
    try {
      void syncMatterLifecycleOnSaveSync({
        matter,
        previousMatter: existing,
        userId: opts.byId,
        correlationId: syncCorrelationId,
        store,
      }).catch((err) => {
        logDocumentLifecycleSyncError(err, syncCorrelationId);
      });
    } catch (err) {
      logDocumentLifecycleSyncError(err, syncCorrelationId);
    }
  }

  return { matter };
}

export function markEngagementLetterDrafted(
  matterId: string,
  byId: string,
): { matter: Matter | null; errors?: Record<string, string> } {
  const store = getStore();
  const existing = store.matters.find((m) => m.id === matterId) ?? null;
  const actingUser = store.people.find((p) => p.id === byId) ?? null;
  if (
    !existing ||
    !actingUser ||
    !actingUser.isEmployee ||
    !canPersonAccessMatter(existing, byId, actingUser, {
      allPeople: store.people,
      teams: store.teams,
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
      allPeople: store.people,
      teams: store.teams,
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
  writeAudit(store, {
    recordType: 'matter',
    recordId: existing.id,
    action: 'update',
    field: 'Engagement letter status',
    oldValue: prevStatus,
    newValue: 'Drafted',
    byId,
    at: now,
  });
  saveStore(store);
  return { matter: existing };
}

export function liftMatterRestriction(
  matterId: string,
  restriction: 'staff_matter' | 'ethical_wall',
  reason: string,
  byId: string,
): { matter: Matter | null; errors?: Record<string, string> } {
  const store = getStore();
  const existing = store.matters.find((m) => m.id === matterId) ?? null;
  const actingUser = store.people.find((p) => p.id === byId) ?? null;
  if (
    !existing ||
    !actingUser ||
    !actingUser.isEmployee ||
    !canPersonAccessMatter(existing, byId, actingUser, {
      allPeople: store.people,
      teams: store.teams,
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
    allPeople: store.people,
    teams: store.teams,
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
            Boolean(cid && store.people.some((p) => p.id === cid && isWorkingAtFirm(p))),
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

  writeAudit(store, {
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

  saveStore(store);

  const syncCorrelationId = `corr-lifecycle-sync-${existing.id}-${Date.now()}`;
  try {
    void syncMatterLifecycleOnSaveSync({
      matter: existing,
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

  return { matter: existing };
}

export function runMatterConflictSearchRecord(
  input: MatterConflictSearchInput,
  byId: string,
): {
  matches: ConflictCheckMatch[];
  run?: ConflictCheckRunAudit;
  errors?: Record<string, string>;
} {
  const store = getStore();
  const actingUser = store.people.find((p) => p.id === byId) ?? null;
  if (
    !actingUser ||
    !actingUser.isEmployee ||
    (!hasPersonPermission(actingUser, 'matter:create', {
      allPeople: store.people,
      teams: store.teams,
    }) &&
      !hasPersonPermission(actingUser, 'matter:edit', {
        allPeople: store.people,
        teams: store.teams,
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
    allPeople: store.people,
    teams: store.teams,
  });
  const visibility = buildRecordVisibility(store, actingUser);
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
      matters: store.matters,
      enquiries: store.enquiries,
      people: store.people,
      organisations: store.organisations,
      links: store.links,
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
  const savedMatter = input.currentMatterId
    ? store.matters.find((m) => m.id === input.currentMatterId) ?? null
    : null;
  const hasSavedMatter = Boolean(savedMatter);
  let storeModified = false;
  if (
    savedMatter &&
    visibility.canViewMatter(savedMatter) &&
    hasPersonPermission(actingUser, 'matter:edit', {
      allPeople: store.people,
      teams: store.teams,
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
    storeModified = true;
  }
  const restrictedCount = matches.filter((m) => m.restricted).length;
  if (restrictedCount > 0) {
    const tenantId = getActiveTenantConfiguration().tenantId;
    const activeSession = getActiveActorSession();
    const correlationId =
      (activeSession as { correlationId?: string } | null)?.correlationId ??
      `conflict-search-${randomUUID()}`;
    if (hasSavedMatter && input.currentMatterId) {
      writeAudit(store, {
        recordType: 'matter',
        recordId: input.currentMatterId,
        action: 'update',
        field: 'Conflict check restricted match',
        oldValue: null,
        newValue: `Restricted conflict match count: ${restrictedCount} across ${input.parties.length} searched party/parties`,
        byId,
      });
      storeModified = true;
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
  if (storeModified) {
    saveStore(store);
  }
  return { matches, run };
}

export function updateMatterConflictRecord(
  matterId: string,
  record: ConflictCheckRecordInput | ConflictCheckRecord,
  byId: string,
): { matter: Matter | null; errors?: Record<string, string>; warnings?: string[] } {
  const store = getStore();
  const today = toIsoDate(new Date());
  const matter = store.matters.find((m) => m.id === matterId);
  const actingUser = store.people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actingUser);
  if (
    !matter ||
    !actingUser ||
    !actingUser.isEmployee ||
    !visibility.canViewMatter(matter) ||
    !hasPersonPermission(actingUser, 'matter:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    return { matter: null };
  }
  const actorHasRiskView = hasPersonPermission(actingUser, 'risk:view', {
    allPeople: store.people,
    teams: store.teams,
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
    resolveMatterConflictCheckRecord(matter, store.people, store.organisations);
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
    people: store.people,
    organisations: store.organisations,
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
      matters: store.matters,
      enquiries: store.enquiries,
      people: store.people,
      organisations: store.organisations,
      links: store.links,
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
  const kdConfig = getKeyDatesConfig(store);
  const keyDatesOpenGate = kdConfig.enabled
    ? evaluateMatterKeyDateOpeningGate(
        kdConfig,
        matter.matterTypeId || matter.practiceAreaId,
        (store.keyDates ?? []).filter((kd) => kd.matterId === matter.id),
        (store.keyDateNotApplicable ?? []).filter(
          (na) => na.matterId === matter.id,
        ),
      )
    : { canOpen: true, missingKeyDateTypes: [] };
  const hasPassedOpeningGate =
    matter.matterNumber !== 'DRAFT' &&
    !matter.matterNumber.startsWith('DRAFT') &&
    gate?.allowProceed === true &&
    keyDatesOpenGate.canOpen;

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
      if (hasPassedOpeningGate) {
        const activeStatusId = vid('matter_status', 'Active');
        matter.matterStatusId = activeStatusId;
        matter.recordStatusId = activeStatusId;
        const cleanFieldVals = { ...(matter.fieldValues ?? {}) };
        delete cleanFieldVals['matterOpeningSnapshot'];
        const openingSnapshot = resolveMatterOpeningSnapshot(
          { ...matter, fieldValues: cleanFieldVals },
          store.people,
          store.organisations,
          store.values,
          store.enquiries,
          store.quotes,
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

  saveStore(store);

  const syncCorrelationId = `corr-lifecycle-sync-${matter.id}-${Date.now()}`;
  try {
    void syncMatterLifecycleOnSaveSync({
      matter,
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

  return { matter, ...(warnings.length > 0 ? { warnings } : {}) };
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
  const store = getStore();
  const matter = store.matters.find((m) => m.id === matterId) ?? null;
  const actingUser = store.people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actingUser);
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
      allPeople: store.people,
      teams: store.teams,
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
        store.people,
        store.organisations,
        store.values,
        store.enquiries,
        store.quotes,
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
  saveStore(store);
  return { matter, ...(warnings.length > 0 ? { warnings } : {}) };
}

export function dismissDuplicateMatch(
  recordType: RecordType,
  recordId: string,
  otherId: string | null,
  byId: string,
): { ok: true } | ActionDenied {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'record:merge', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (record:merge) to dismiss duplicate matches.',
    );
  }
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const list: AnyRecord[] = recordType === 'person' ? store.people : store.organisations;
  const rec = list.find((r) => r.id === recordId);
  if (!rec) {
    return buildActionDenied('FORBIDDEN', `Target ${recordType} "${recordId}" not found.`);
  }
  if (otherId && !list.some((r) => r.id === otherId)) {
    return buildActionDenied('FORBIDDEN', `Compared ${recordType} "${otherId}" not found.`);
  }

  const targets = otherId ? [otherId] : [...rec.possibleMatchIds];
  for (const tid of targets) {
    if (!rec.notDuplicateOf.includes(tid)) rec.notDuplicateOf.push(tid);
    rec.possibleMatchIds = rec.possibleMatchIds.filter((id) => id !== tid);
    const other = list.find((r) => r.id === tid);
    if (other) {
      if (!other.notDuplicateOf.includes(recordId)) other.notDuplicateOf.push(recordId);
      other.possibleMatchIds = other.possibleMatchIds.filter((id) => id !== recordId);
      if (other.possibleMatchIds.length === 0) other.duplicateStatusId = dupNone;
    }
  }
  if (rec.possibleMatchIds.length === 0) rec.duplicateStatusId = dupNone;

  writeAudit(store, {
    recordType,
    recordId,
    action: 'duplicate',
    field: 'Duplicate status',
    oldValue: 'Possible match',
    newValue: 'Dismissed (Not a duplicate)',
    byId,
  });
  saveStore(store);
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

export function executeMerge(
  recordType: RecordType,
  survivorId: string,
  mergedId: string,
  byId: string,
): MergeHistory & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'record:merge', {
      allPeople: store.people,
      teams: store.teams,
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
  const list: AnyRecord[] = recordType === 'person' ? store.people : store.organisations;
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
  const { ctx: resolvedMergeCtx } = resolveTenantContextForStoreUser(
    store,
    actor!.id,
  );
  const plan = planMerge(survivor, merged);
  const dupNone = valueBySystemKey(store.values, 'duplicate_status', 'none')!.id;
  const dupMerged = valueBySystemKey(store.values, 'duplicate_status', 'merged')!.id;
  const statusMerged = valueBySystemKey(
    store.values,
    recordType === 'person' ? 'person_record_status' : 'organisation_record_status',
    'merged',
  )!.id;

  // R272: Snapshot the store before changing anything so any failure restores the store atomically
  const storeSnapshot = structuredClone(store);

  try {
    // 1. Repoint person-organisation links and merge collisions onto the survivor's link (R273)
    let linksMoved = 0;
    const nextLinks: PersonOrganisationLink[] = [];
    for (const link of store.links) {
      if (recordType === 'person' && link.personId === merged.id) {
        const existingSurvivorLink =
          nextLinks.find(
            (l) =>
              l.personId === survivor.id &&
              l.organisationId === link.organisationId,
          ) ??
          store.links.find(
            (l) =>
              l !== link &&
              l.personId === survivor.id &&
              l.organisationId === link.organisationId,
          );
        if (existingSurvivorLink) {
          mergeCollidingLinkIntoSurvivor(existingSurvivorLink, link);
          linksMoved++;
        } else {
          link.personId = survivor.id;
          nextLinks.push(link);
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
          store.links.find(
            (l) =>
              l !== link &&
              l.organisationId === survivor.id &&
              l.personId === link.personId,
          );
        if (existingSurvivorLink) {
          mergeCollidingLinkIntoSurvivor(existingSurvivorLink, link);
          linksMoved++;
        } else {
          link.organisationId = survivor.id;
          nextLinks.push(link);
          linksMoved++;
        }
      } else {
        nextLinks.push(link);
      }
    }
    store.links = nextLinks;
    if (linksMoved > 0 && !plan.fieldsTaken.includes('Organisation links')) {
      plan.fieldsTaken.push('Organisation links');
    }

    // 2. Repoint subsidiary parent links if merging an organisation (relationshipPartnerId is never changed)
    if (recordType === 'organisation') {
      for (const org of store.organisations) {
        if (org.parentOrganisationId === merged.id && org.id !== survivor.id) {
          org.parentOrganisationId = survivor.id;
        }
      }
    }

    // 3. Repoint Matter references and conflict check records
    const repointConflictRecordObject = (
      cr:
        | {
            parties?: { linkedRecordId: string | null }[];
            matches?: { matchedRecordId: string }[];
          }
        | null
        | undefined,
    ) => {
      if (!cr || typeof cr !== 'object') return;
      if (Array.isArray(cr.parties)) {
        for (const cp of cr.parties) {
          if (cp && cp.linkedRecordId === merged.id) {
            cp.linkedRecordId = survivor.id;
          }
        }
      }
      if (Array.isArray(cr.matches)) {
        for (const match of cr.matches) {
          if (match && match.matchedRecordId === merged.id) {
            match.matchedRecordId = survivor.id;
          }
        }
      }
    };

    for (const matter of store.matters) {
      if (matter.clientId === merged.id) {
        matter.clientId = survivor.id;
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
      }
      if (matter.instructingContactId === merged.id) {
        matter.instructingContactId = survivor.id;
      }
      if (matter.billingContactId === merged.id) {
        matter.billingContactId = survivor.id;
      }
      if (matter.referrerContactId === merged.id) {
        matter.referrerContactId = survivor.id;
      }
      for (const party of matter.parties ?? []) {
        if (party.linkedRecordId === merged.id) {
          party.linkedRecordId = survivor.id;
        }
      }
      repointConflictRecordObject(matter.conflictCheckRecord);
      if (matter.fieldValues && typeof matter.fieldValues === 'object') {
        repointConflictRecordObject(
          matter.fieldValues['conflictCheckRecord'] as {
            parties?: { linkedRecordId: string | null }[];
            matches?: { matchedRecordId: string }[];
          },
        );
        repointConflictRecordObject(
          matter.fieldValues['conflictCheck'] as {
            parties?: { linkedRecordId: string | null }[];
            matches?: { matchedRecordId: string }[];
          },
        );
      }
    }

    // 4. Repoint Enquiry references and conflict snapshots
    for (const enq of store.enquiries) {
      if (enq.linkedOrganisationId === merged.id) {
        enq.linkedOrganisationId = survivor.id;
      }
      if (enq.referrerPersonId === merged.id) {
        enq.referrerPersonId = survivor.id;
      }
      if (enq.linkedPersonId === merged.id) {
        enq.linkedPersonId = survivor.id;
      }
      if (enq.referredToOrganisationId === merged.id) {
        enq.referredToOrganisationId = survivor.id;
      }
      if (enq.conflictSnapshot) {
        for (const hit of enq.conflictSnapshot.conflicts ?? []) {
          if (hit.recordId === merged.id) {
            hit.recordId = survivor.id;
            if (typeof hit.href === 'string' && hit.href.includes(merged.id)) {
              hit.href = replaceRecordIdPathSegment(hit.href, merged.id, survivor.id);
            }
          }
        }
        if (Array.isArray(enq.conflictSnapshot.knownPeople)) {
          const seen = new Set<string>();
          const nextKnownPeople: typeof enq.conflictSnapshot.knownPeople = [];
          for (const kp of enq.conflictSnapshot.knownPeople) {
            const nextIdVal = kp.id === merged.id ? survivor.id : kp.id;
            if (!seen.has(nextIdVal)) {
              seen.add(nextIdVal);
              nextKnownPeople.push({ ...kp, id: nextIdVal });
            }
          }
          enq.conflictSnapshot.knownPeople = nextKnownPeople;
        }
        if (Array.isArray(enq.conflictSnapshot.knownOrganisations)) {
          const seen = new Set<string>();
          const nextKnownOrgs: typeof enq.conflictSnapshot.knownOrganisations = [];
          for (const ko of enq.conflictSnapshot.knownOrganisations) {
            const nextIdVal = ko.id === merged.id ? survivor.id : ko.id;
            if (!seen.has(nextIdVal)) {
              seen.add(nextIdVal);
              nextKnownOrgs.push({ ...ko, id: nextIdVal });
            }
          }
          enq.conflictSnapshot.knownOrganisations = nextKnownOrgs;
        }
      }
    }

    // 5. Repoint Quote references
    for (const quote of store.quotes) {
      if (quote.linkedOrganisationId === merged.id) {
        quote.linkedOrganisationId = survivor.id;
      }
      if (quote.linkedPersonId === merged.id) {
        quote.linkedPersonId = survivor.id;
      }
    }

    // 6. Repoint Task linkedRecords (de-duplicated)
    for (const task of store.tasks) {
      if (
        Array.isArray(task.linkedRecords) &&
        task.linkedRecords.some((lr) => lr.recordId === merged.id)
      ) {
        const seen = new Set<string>();
        const nextLinkedRecords: typeof task.linkedRecords = [];
        for (const lr of task.linkedRecords) {
          const nextRecId = lr.recordId === merged.id ? survivor.id : lr.recordId;
          const key = `${lr.recordType}:${nextRecId}`;
          if (!seen.has(key)) {
            seen.add(key);
            nextLinkedRecords.push({ ...lr, recordId: nextRecId });
          }
        }
        task.linkedRecords = nextLinkedRecords;
      }
    }

    // 7. Repoint PMS links (handle collision when survivor already has a PMS link)
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
    store.pmsLinks = nextPmsLinks;

    // 9. Copy notes to survivor
    let notesMoved = 0;
    for (const note of store.notes) {
      if (note.recordType === recordType && note.recordId === merged.id) {
        note.recordId = survivor.id;
        note.mergedFromId = merged.id;
        notesMoved++;
      }
    }
    if (notesMoved > 0 && !plan.fieldsTaken.includes('Notes')) {
      plan.fieldsTaken.push('Notes');
    }

    // 10. Other references: Person.createdFromEnquiryId, store.recentlyViewed, store.notifications
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

    if (store.recentlyViewed && typeof store.recentlyViewed === 'object') {
      for (const [uid, viewedIds] of Object.entries(store.recentlyViewed)) {
        if (Array.isArray(viewedIds) && viewedIds.includes(merged.id)) {
          store.recentlyViewed[uid] = Array.from(
            new Set(
              viewedIds.map((id) => (id === merged.id ? survivor.id : id)),
            ),
          );
        }
      }
    }

    for (const notification of store.notifications ?? []) {
      if (notification.recordId === merged.id) {
        notification.recordId = survivor.id;
      }
      if (
        typeof notification.href === 'string' &&
        notification.href.includes(merged.id)
      ) {
        notification.href = replaceRecordIdPathSegment(
          notification.href,
          merged.id,
          survivor.id,
        );
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

    const sIdx = list.findIndex((r) => r.id === survivor.id);
    list[sIdx] = plan.survivor;

    // Mark merged record
    merged.mergedIntoId = survivor.id;
    merged.recordStatusId = statusMerged;
    merged.duplicateStatusId = dupMerged;
    merged.possibleMatchIds = [];
    merged.updatedAt = now;
    merged.updatedById = byId;

    const history: MergeHistory = {
      id: nextId(store, 'M'),
      recordType,
      survivorId: survivor.id,
      mergedId: merged.id,
      mergedLabel: recordDisplayName(merged),
      byId,
      at: now,
      fieldsTaken: plan.fieldsTaken,
      ...(pmsLinkConflicts.length > 0 ? { pmsLinkConflicts } : {}),
    };
    store.mergeHistory.unshift(history);

    // 8a. Prepare repointed document and documentLink arrays on store after all in-memory repointing and before saveStore (R296)
    const storeDocsPrepared = prepareMergedEntityDocumentsInStore(
      store,
      resolvedMergeCtx,
      recordType,
      merged.id,
      survivor.id,
    );
    if (storeDocsPrepared > 0 && !plan.fieldsTaken.includes('Generated documents')) {
      plan.fieldsTaken.push('Generated documents');
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

    saveStore(store);

    // 8b. Write repointed documents and links to TenantDocumentRepository after saveStore (R272)
    repointMergedEntityInDocRepository(
      store,
      actor,
      recordType,
      merged.id,
      survivor.id,
    );

    return history;
  } catch (err) {
    for (const key of Object.keys(store)) {
      delete (store as unknown as Record<string, unknown>)[key];
    }
    Object.assign(store, storeSnapshot);
    try {
      saveStore(store);
    } catch {
      const tenantId = getActiveTenantConfiguration().tenantId;
      const activeSession = getActiveActorSession();
      const correlationId =
        (activeSession as { correlationId?: string } | null)?.correlationId ??
        `merge-rollback-${randomUUID()}`;
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'merge.rollback_save_failed',
          correlationId,
          tenantId,
        }),
      );
    }
    throw err;
  }
}

export function findCandidateDuplicatesForRecord(record: AnyRecord): AnyRecord[] {
  const store = getStore();
  // Same rules as the People / Organisation forms: a shared address alone isn't a duplicate.
  const notAddressOnly = (reasons: string[]) =>
    reasons.some((r) => r !== 'address' && r !== 'postcode');
  if (record.recordType === 'person') {
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
      store.people,
      record.notDuplicateOf,
      { fuzzy: true },
    );
    return matches.filter((m) => notAddressOnly(m.reasons)).map((m) => m.record);
  }
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
    store.organisations,
    record.notDuplicateOf,
    { fuzzy: true },
  );
  return matches.filter((m) => notAddressOnly(m.reasons)).map((m) => m.record);
}

// ------------------------------------------------------------------ Admin: Choice lists
export function addChoiceValue(
  input: {
    listKey: string;
    label: string;
    description?: string;
    guidance?: string;
    parentId?: string | null;
    meta?: Record<string, string>;
  },
  byId: string,
): ChoiceValue {
  const store = getStore();
  const label = input.label.trim();
  if (!label) throw new Error('Label is required');
  let id = vid(input.listKey, (input.parentId ? slug(input.parentId) + '_' : '') + label);
  let suffix = 2;
  while (store.values.some((v) => v.id === id)) {
    id = `${vid(input.listKey, label)}_${suffix++}`;
  }
  const val: ChoiceValue = {
    id,
    listKey: input.listKey,
    label,
    description: input.description?.trim() || undefined,
    guidance: input.guidance?.trim() || undefined,
    parentId: input.parentId ?? null,
    sortOrder: nextSortOrder(store.values, input.listKey),
    active: true,
    meta: input.meta && Object.keys(input.meta).length > 0 ? input.meta : undefined,
  };
  store.values.push(val);
  if (input.listKey === 'employee_role' && store.homePagesConfig) {
    store.homePagesConfig.roles = syncHomeRolesWithEmployeeRoles(
      store.homePagesConfig.roles,
      store.values,
      createDefaultRoleConfigs(
        getActiveTenantConfiguration().branding.primaryDomain,
      ),
    );
  }
  writeAudit(store, {
    recordType: 'list',
    recordId: input.listKey,
    action: 'list-change',
    field: `Added value to ${input.listKey}`,
    oldValue: null,
    newValue: val.label,
    byId,
  });
  saveStore(store);
  return val;
}

export function updateChoiceValue(
  id: string,
  patch: {
    label?: string;
    description?: string;
    guidance?: string;
    active?: boolean;
    meta?: Record<string, string>;
  },
  byId: string,
): { value?: ChoiceValue; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const val = store.values.find((v) => v.id === id);
  if (!val) {
    return {
      ...buildActionDenied('FORBIDDEN', 'Value not found'),
      error: 'Value not found',
    };
  }

  if (patch.active === false && val.active) {
    const check = canDeactivate(val);
    if (!check.ok) return { error: check.reason };
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
  if (val.listKey === 'employee_role' && store.homePagesConfig) {
    store.homePagesConfig.roles = syncHomeRolesWithEmployeeRoles(
      store.homePagesConfig.roles,
      store.values,
      createDefaultRoleConfigs(
        getActiveTenantConfiguration().branding.primaryDomain,
      ),
    );
  }
  if (false) {
  }

  writeAudit(store, {
    recordType: 'list',
    recordId: val.listKey,
    action: 'list-change',
    field: val.id,
    oldValue: `${beforeLabel}${beforeActive ? '' : ' (inactive)'}`,
    newValue: `${val.label}${val.active ? '' : ' (inactive)'}`,
    byId,
  });
  saveStore(store);
  return { value: val };
}

export function reorderChoiceValue(id: string, direction: -1 | 1, byId: string): void {
  const store = getStore();
  const changed = reorder(store.values, id, direction);
  if (!changed.length) return;
  for (const u of changed) {
    const idx = store.values.findIndex((v) => v.id === u.id);
    if (idx !== -1) store.values[idx] = u;
  }
  const target = store.values.find((v) => v.id === id)!;
  writeAudit(store, {
    recordType: 'list',
    recordId: target.listKey,
    action: 'list-change',
    field: `Re-ordered ${target.label}`,
    oldValue: null,
    newValue: direction === -1 ? 'Moved up' : 'Moved down',
    byId,
  });
  saveStore(store);
}

export function createMatterStageGroup(
  input: {
    label: string;
    description?: string;
    mode: 'from_default' | 'scratch';
    selectedDefaultStageIds?: string[];
  },
  byId: string,
): ChoiceValue {
  const store = getStore();
  const label = input.label.trim();
  if (!label) throw new Error('Group name is required');

  // Ensure Default Group exists in store.values
  const defaultGroupId = 'matter_stage_group.default_group';
  if (!store.values.some((v) => v.id === defaultGroupId)) {
    store.values.push({
      id: defaultGroupId,
      listKey: 'matter_stage_group',
      label: 'Default Group',
      description: 'Standard firm-wide matter stage and milestone framework',
      sortOrder: 1,
      active: true,
      parentId: null,
      systemKey: 'default_group',
    });
  }
  for (const v of store.values) {
    if (v.listKey === 'matter_stage' && !v.parentId && !v.meta?.stageGroupId) {
      v.meta = { ...(v.meta ?? {}), stageGroupId: defaultGroupId };
    }
  }

  let groupId = vid('matter_stage_group', label);
  let suffix = 2;
  while (store.values.some((v) => v.id === groupId)) {
    groupId = `${vid('matter_stage_group', label)}_${suffix++}`;
  }

  const groupVal: ChoiceValue = {
    id: groupId,
    listKey: 'matter_stage_group',
    label,
    description: input.description?.trim() || undefined,
    parentId: null,
    sortOrder: nextSortOrder(store.values, 'matter_stage_group'),
    active: true,
  };
  store.values.push(groupVal);

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

      const srcMilestones = store.values
        .filter((v) => v.listKey === 'matter_stage' && v.parentId === srcStage.id)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      srcMilestones.forEach((srcMs, mIdx) => {
        let newMsId = vid('matter_stage', `${slug(newStageId)}_${srcMs.label}`);
        let msSuffix = 2;
        while (store.values.some((v) => v.id === newMsId)) {
          newMsId = `${vid('matter_stage', `${slug(newStageId)}_${srcMs.label}`)}_${msSuffix++}`;
        }
        store.values.push({
          id: newMsId,
          listKey: 'matter_stage',
          label: srcMs.label,
          description: srcMs.description,
          guidance: srcMs.guidance,
          parentId: newStageId,
          sortOrder: mIdx + 1,
          active: true,
          meta: srcMs.meta ? { ...srcMs.meta } : undefined,
        });
      });
    });
  }

  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_stage',
    action: 'list-change',
    field: 'Created matter stage group',
    oldValue: null,
    newValue: `${groupVal.label} (${input.mode === 'from_default' ? 'copied from Default Group' : 'from scratch'})`,
    byId,
  });
  saveStore(store);
  return groupVal;
}

// ------------------------------------------------------------------ Admin: Custom fields
export function saveCustomFieldDefinition(
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
): CustomFieldDefinition {
  const store = getStore();
  const existing = input.id ? store.customFields.find((d) => d.id === input.id) ?? null : null;
  const id = existing?.id ?? `cf_${slug(input.label)}_${Date.now().toString(36).slice(-4)}`;

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
      store.lists.push(list);
    }
    if (input.options?.length) {
      const existingVals = store.values.filter((v) => v.listKey === optionsListKey);
      input.options
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((optLabel, idx) => {
          if (!existingVals.some((ev) => ev.label.toLowerCase() === optLabel.toLowerCase())) {
            store.values.push({
              id: vid(optionsListKey!, optLabel),
              listKey: optionsListKey!,
              label: optLabel,
              sortOrder: existingVals.length + idx + 1,
              active: true,
              parentId: null,
            });
          }
        });
    }
  }

  const sameType = store.customFields.filter((d) => d.recordType === input.recordType);
  const maxOrder = sameType.length ? Math.max(...sameType.map((d) => d.sortOrder)) : 0;

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

  if (!existing) {
    store.customFields.push(def);
  } else {
    const idx = store.customFields.findIndex((d) => d.id === existing.id);
    store.customFields[idx] = def;
  }

  writeAudit(store, {
    recordType: 'customField',
    recordId: def.id,
    action: 'custom-field-change' as AuditAction,
    field: `${def.recordType} · ${def.label}`,
    oldValue: existing ? `${existing.label} (${existing.active ? 'active' : 'inactive'})` : null,
    newValue: `${def.label} (${def.fieldType}, ${def.active ? 'active' : 'inactive'})`,
    byId,
  });
  saveStore(store);
  return def;
}

export function reorderCustomField(id: string, direction: -1 | 1, byId: string): void {
  const store = getStore();
  const target = store.customFields.find((d) => d.id === id);
  if (!target) return;
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
  writeAudit(store, {
    recordType: 'customField',
    recordId: target.id,
    action: 'custom-field-change',
    field: `Re-ordered ${target.label}`,
    oldValue: null,
    newValue: direction === -1 ? 'Moved up' : 'Moved down',
    byId,
  });
  saveStore(store);
}

export function resetAllDemoData(byId: string): void {
  const prevStore = getStore();
  const actor = prevStore.people.find((p) => p.id === byId) ?? null;
  const actorName = actor ? personDisplayName(actor) : byId;
  const prevSeededEntraByIdAndEmail = new Map<string, string | null | undefined>();
  if (!prevStore.isCleanDeployment) {
    for (const p of prevStore.people) {
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
  writeAudit(fresh, {
    recordType: 'system',
    recordId: 'demo-data',
    action: 'data-reset',
    field: 'Reset demo data',
    oldValue: null,
    newValue: `Restored initial ${fresh.firm.name} dataset (by ${actorName} [${byId}])`,
    byId,
  });
  saveStore(fresh);
}

export function clearAllDataToCleanDeployment(byId: string = 'system'): void {
  const prevStore = getStore();
  const actor = prevStore.people.find((p) => p.id === byId) ?? null;
  const actorName = actor ? personDisplayName(actor) : byId;
  const clean = clearStoreToCleanDeployment();
  writeAudit(clean, {
    recordType: 'system',
    recordId: 'clean-deployment',
    action: 'data-cleared',
    field: 'Clear all data to clean deployment',
    oldValue: null,
    newValue: `Cleared store to clean deployment (by ${actorName} [${byId}])`,
    byId,
  });
  saveStore(clean);
}

// ------------------------------------------------------------------ Notifications
function pushNotification(
  store: FirmStore,
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
): NotificationItem | null {
  // Don't notify someone about an action they took themselves unless it's an overdue alert
  if (input.recipientId === input.byId && input.kind !== 'task_overdue') return null;
  const item: NotificationItem = {
    id: nextId(store, 'NTF'),
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
  store.notifications.unshift(item);
  return item;
}

export function markNotificationRead(id: string, userId: string): void {
  const store = getStore();
  const n = store.notifications.find((x) => x.id === id && x.recipientId === userId);
  if (n) {
    n.read = true;
    saveStore(store);
  }
}

export function markAllNotificationsRead(userId: string): void {
  const store = getStore();
  for (const n of store.notifications) {
    if (n.recipientId === userId) n.read = true;
  }
  saveStore(store);
}

// ------------------------------------------------------------------ Admin: Teams & Settings
export function saveTeamRecord(
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
): { team?: Team; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const now = new Date().toISOString();
  const name = input.name.trim();
  if (!name) return { error: 'Team name is required.' };

  const existing = input.id ? store.teams.find((t) => t.id === input.id) ?? null : null;
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

  const team: Team = {
    id: existing?.id ?? nextId(store, 'TM'),
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

  if (!existing) {
    store.teams.push(team);
    writeAudit(store, {
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
    const idx = store.teams.findIndex((t) => t.id === existing.id);
    store.teams[idx] = team;
    writeAudit(store, {
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
  saveStore(store);
  return { team };
}

export function updateEmployeeRoleSetting(
  personId: string,
  appRole: AppRole | null,
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string } {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId);
  const person = store.people.find((p) => p.id === personId && p.isEmployee);
  if (!actor) return { ok: false, error: 'Acting user not found.' };
  if (!person) return { ok: false, error: 'Employee not found.' };

  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
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
  writeAudit(store, {
    recordType: 'person',
    recordId: person.id,
    action: 'update',
    field: 'App role',
    oldValue: beforeJson,
    newValue: afterJson,
    byId,
  });
  saveStore(store);
  return { ok: true };
}

export function saveEnquirySettingsRecord(
  patch: Partial<EnquirySettings>,
  byId: string,
): EnquirySettings {
  const store = getStore();
  store.enquirySettings = {
    ...store.enquirySettings,
    ...patch,
  };
  writeAudit(store, {
    recordType: 'system',
    recordId: 'enquiry-settings',
    action: 'update',
    field: 'Enquiry settings',
    oldValue: null,
    newValue: `Emergency ${store.enquirySettings.emergencyHours}h · Hours ${store.enquirySettings.workDayStart}–${store.enquirySettings.workDayEnd} · Attempts ${store.enquirySettings.failedAttemptsBeforeSuggestNoResponse} · Retention ${store.enquirySettings.retentionMonths}m`,
    byId,
  });
  saveStore(store);
  return store.enquirySettings;
}

export function saveTaskSettingsRecord(
  settings: TaskSettings,
  byId: string,
): TaskSettings {
  const store = getStore();
  store.taskSettings = settings;
  writeAudit(store, {
    recordType: 'system',
    recordId: 'task-settings',
    action: 'update',
    field: 'Task settings',
    oldValue: null,
    newValue: 'Updated automatic task templates and due offsets',
    byId,
  });
  saveStore(store);
  return store.taskSettings;
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

export function saveTaskRecord(
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
): { task?: Task; tasks?: Task[]; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const now = new Date().toISOString();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actor);

  if (!opts?.viaTakeTask && !opts?.internalSystemStep) {
    if (
      !hasPersonPermission(actor, 'task:edit', {
        allPeople: store.people,
        teams: store.teams,
      })
    ) {
      const msg = 'You do not have permission (task:edit) to create or edit tasks.';
      return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
    }
  }

  const existing = input.id ? store.tasks.find((t) => t.id === input.id) ?? null : null;
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
      const m = store.matters.find((x) => x.id === lr.recordId);
      if (!m || !visibility.canViewMatter(m)) {
        const msg = 'Linked matter not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'enquiry') {
      const e = store.enquiries.find((x) => x.id === lr.recordId);
      if (!e || !visibility.canViewEnquiry(e)) {
        const msg = 'Linked enquiry not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'quote') {
      const q = store.quotes.find((x) => x.id === lr.recordId);
      if (!q || !visibility.canViewQuote(q)) {
        const msg = 'Linked quote not found or access denied.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'person') {
      if (!store.people.some((x) => x.id === lr.recordId)) {
        const msg = 'Linked person not found.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    } else if (lr.recordType === 'organisation') {
      if (!store.organisations.some((x) => x.id === lr.recordId)) {
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
        canUserTakeTask(byId, existing, store.teams, store.people, store.values);
      if (
        !isSelfClaim &&
        !canUserReassignTask(byId, existing, store.teams, store.people, store.values)
      ) {
        const msg = 'You do not have permission to reassign this task.';
        return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
      }
    }
  }

  // Separate task per assignee when creating a new task with multiAssigneeMode === 'separate'
  if (!existing && input.multiAssigneeMode === 'separate' && cleanPersonIds.length > 1) {
    const createdTasks: Task[] = [];
    for (const pid of cleanPersonIds) {
      const id = nextId(store, 'TSK');
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
      store.tasks.unshift(separateTask);
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
      pushNotification(store, {
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
    saveStore(store);
    return { task: createdTasks[0], tasks: createdTasks };
  }

  const id = existing?.id ?? nextId(store, 'TSK');
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

  const ctx = formatContext(store);

  if (!existing) {
    store.tasks.unshift(task);
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
        pushNotification(store, {
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
      const team = store.teams.find((tm) => tm.id === task.assignedTeamId);
      if (team) {
        for (const memberId of team.memberIds) {
          pushNotification(store, {
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
    const idx = store.tasks.findIndex((t) => t.id === existing.id);
    store.tasks[idx] = task;

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
        pushNotification(store, {
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
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    for (const lr of task.linkedRecords) {
      if (lr.recordType === 'enquiry') {
        const enq = store.enquiries.find((e) => e.id === lr.recordId);
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

  saveStore(store);
  return { task };
}

export function takeTaskRecord(
  taskId: string,
  byId: string,
): { task?: Task; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const visibility = buildRecordVisibility(store, actor);
  const existing = store.tasks.find((t) => t.id === taskId);
  if (!existing || !visibility.canViewTask(existing)) {
    const msg = 'Task not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (!canUserTakeTask(byId, existing, store.teams, store.people, store.values)) {
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

export function addTaskCommentRecord(
  taskId: string,
  text: string,
  byId: string,
): { task?: Task; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'task:comment', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (task:comment) to comment on tasks.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const task = store.tasks.find((t) => t.id === taskId);
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

  const authorName = formatContext(store).nameOf(byId);
  const recipients = new Set<string>();
  if (task.assignedPersonId) recipients.add(task.assignedPersonId);
  if (task.createdById) recipients.add(task.createdById);
  for (const rId of recipients) {
    pushNotification(store, {
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

  saveStore(store);
  return { task };
}

// ------------------------------------------------------------------ Enquiries & Automatic Tasks
function raiseAutomaticTask(
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
): Task {
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

  const id = nextId(store, 'TSK');
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

  store.tasks.unshift(task);
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
    pushNotification(store, {
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
    const team = store.teams.find((tm) => tm.id === task.assignedTeamId);
    if (team) {
      for (const memberId of team.memberIds) {
        pushNotification(store, {
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

function completeOpenContactTasksForEnquiry(
  store: FirmStore,
  enquiryId: string,
  reasonLabel: string,
  byId: string,
  now: string,
): void {
  for (const t of store.tasks) {
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

export function saveEnquiryRecord(
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
): {
  enquiry?: Enquiry;
  routedTeamName?: string;
  routedToIntakeFallback?: boolean;
  errors?: Record<string, string>;
  missingFields?: string[];
} & Partial<ActionDenied> {
  const store = getStore();
  const now = opts.now ?? new Date().toISOString();
  const actor = store.people.find((p) => p.id === opts.byId) ?? null;
  const visibility = buildRecordVisibility(store, actor);
  const existing = opts.id ? store.enquiries.find((e) => e.id === opts.id) ?? null : null;
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
        allPeople: store.people,
        teams: store.teams,
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
        allPeople: store.people,
        teams: store.teams,
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
    !store.organisations.some((o) => o.id === input.linkedOrganisationId)
  ) {
    const msg = 'Linked organisation not found.';
    return {
      ...buildActionDenied('FORBIDDEN', msg),
      errors: { linkedOrganisationId: msg },
    };
  }
  if (
    input.linkedPersonId &&
    !store.people.some((p) => p.id === input.linkedPersonId)
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
    store.people,
    store.organisations,
    store.matters,
    store.values,
    {
      recordedAt: now,
      recordedById: opts.byId,
      enquiries: store.enquiries.filter((e) => visibility.canViewEnquiry(e)),
      excludeEnquiryId: existing?.id ?? null,
      links: store.links,
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

  const id = existing?.id ?? nextId(store, 'ENQ');
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

    if (!existing) {
      store.enquiries.unshift(draftEnquiry);
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
    } else {
      const idx = store.enquiries.findIndex((e) => e.id === existing.id);
      store.enquiries[idx] = draftEnquiry;
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

    saveStore(store);
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
    const routed = resolveRoutedTeam(mergedInput.practiceAreaId, store.teams);
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

  const routedTeam = store.teams.find((t) => t.id === enquiry.assignedTeamId);
  const practiceAreaLabel =
    resolveLabel(store.values, enquiry.practiceAreaId) || routedTeam?.name || 'Intake';

  if (!existing) {
    store.enquiries.unshift(enquiry);
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
  } else {
    const idx = store.enquiries.findIndex((e) => e.id === existing.id);
    store.enquiries[idx] = enquiry;
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

    raiseAutomaticTask(
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

  saveStore(store);
  return {
    enquiry,
    routedTeamName: routedTeam?.name ?? 'Intake',
    routedToIntakeFallback,
  };
}

export function assignEnquiryRecord(
  enquiryId: string,
  assignedToId: string | null,
  assignedTeamId: string | null | undefined,
  byId: string,
): { enquiry?: Enquiry; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:assign', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:assign) to assign enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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
  const ctx = formatContext(store);
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
    for (const t of store.tasks) {
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

    pushNotification(store, {
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

  saveStore(store);
  return { enquiry: enq };
}

export function logEnquiryContactRecord(
  enquiryId: string,
  input: {
    at?: string;
    method: ContactLogMethod;
    outcome: ContactLogOutcome;
    note: string;
  },
  byId: string,
): { enquiry?: Enquiry; suggestNoResponse?: boolean; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:edit) to log contact on enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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
  if (input.outcome === 'Spoke' && (enq.status === 'New' || enq.status === 'Assigned')) {
    enq.status = 'In contact';
    // Complete the initial contact task once spoken
    completeOpenContactTasksForEnquiry(
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

  const threshold = store.enquirySettings.failedAttemptsBeforeSuggestNoResponse || 3;
  const hasSpoken = enq.contactLog.some((c) => c.outcome === 'Spoke');
  const failedCount = hasSpoken ? 0 : enq.contactLog.filter((c) => c.outcome !== 'Spoke').length;

  saveStore(store);
  return {
    enquiry: enq,
    suggestNoResponse: isEnquiryOpen(enq) && failedCount >= threshold,
  };
}

export function sendEnquiryEmailRecord(
  enquiryId: string,
  input: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
  },
  byId: string,
): { enquiry?: Enquiry; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:edit) to send enquiry emails.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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

  saveStore(store);
  return { enquiry: enq };
}

export function closeEnquiryRecord(
  enquiryId: string,
  input: {
    targetStatus: 'Declined' | 'Referred out' | 'No response';
    closeReasonId?: string | null;
    closeNotes?: string;
    referredToOrganisationId?: string | null;
    referredToName?: string;
  },
  byId: string,
): { enquiry?: Enquiry; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:close', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:close) to close enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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
  completeOpenContactTasksForEnquiry(
    store,
    enq.id,
    `Enquiry closed as ${input.targetStatus}`,
    byId,
    now,
  );

  // If an enquiry-stage person record was created solely for this enquiry and has no matters or other open/converted enquiries, remove it
  if (enq.linkedPersonId) {
    const linkedId = enq.linkedPersonId;
    const linkedPerson = store.people.find((p) => p.id === linkedId);
    if (linkedPerson && !linkedPerson.isEmployee && linkedPerson.createdFromEnquiryId === enq.id) {
      const hasMatters = store.matters.some(
        (m) =>
          m.clientId === linkedId ||
          m.instructingContactId === linkedId ||
          m.billingContactId === linkedId ||
          m.referrerContactId === linkedId ||
          m.additionalClientIds?.includes(linkedId) ||
          m.parties.some((pt) => pt.linkedRecordId === linkedId),
      );
      const hasOtherActiveOrConvertedEnquiry = store.enquiries.some(
        (other) =>
          other.id !== enq.id &&
          (other.linkedPersonId === linkedId || other.referrerPersonId === linkedId) &&
          (isEnquiryOpen(other) || other.status === 'Converted'),
      );
      if (!hasMatters && !hasOtherActiveOrConvertedEnquiry) {
        store.people = store.people.filter((p) => p.id !== linkedId);
        store.links = store.links.filter((l) => l.personId !== linkedId);
        enq.linkedPersonId = null;
      }
    }
  }

  saveStore(store);
  return { enquiry: enq };
}

export function reopenEnquiryRecord(
  enquiryId: string,
  byId: string,
): { enquiry?: Enquiry; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'enquiry:reopen', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (enquiry:reopen) to reopen enquiries.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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
  if (!canUserReopenEnquiry(byId, enq, store.teams, store.people, store.values)) {
    const msg =
      'Only the assignee, the team lead for the enquiry team, Intake, or an administrator may reopen this enquiry.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const now = new Date().toISOString();
  const prevStatus = enq.status;
  enq.status = enq.assignedToId ? 'Assigned' : 'New';
  enq.updatedAt = now;
  enq.updatedById = byId;

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

  saveStore(store);
  return { enquiry: enq };
}

const DECLINED_ORG_BLOCKED_REASON =
  'Client organisation has conflict status "Conflict – declined".';
const DECLINED_ORG_NAME_WARNING =
  "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.";

function assessDeclinedOrganisation(
  store: FirmStore,
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
      ? store.organisations.filter(
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
export function prepareEnquiryConversion(
  enquiryId: string,
  opts: {
    usePersonId?: string | null;
    useOrganisationId?: string | null;
    createForBusiness?: boolean;
  },
  byId: string,
): {
  ok: boolean;
  conflictBlocked?: boolean;
  conflictReasons?: string[];
  conflictWarnings?: string[];
  clientId?: string;
  instructingContactId?: string | null;
  enquiryId?: string;
  error?: string;
} & Partial<Omit<ActionDenied, 'ok'>> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'matter:create', {
      allPeople: store.people,
      teams: store.teams,
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
  const visibility = buildRecordVisibility(store, actor);
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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
    store.people,
    store.organisations,
    store.matters,
    store.values,
    store.enquiries.filter((e) => visibility.canViewEnquiry(e)),
    enq.id,
    store.links,
    visibility.canViewMatter,
    getActiveTenantConfiguration().tenantId,
  );

  const redactRestrictedMatterReasons = (rawReasons: string[]): string[] => {
    const hiddenMatters = store.matters.filter((m) => !visibility.canViewMatter(m));
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
    ? store.organisations.find((o) => o.id === linkedOrgId)
    : undefined;
  const clientOrgName = existingOrg?.legalName || enq.callingOnBehalfOf.trim();
  const declinedOrgAssessment = assessDeclinedOrganisation(
    store,
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
    saveStore(store);
    return {
      ok: false,
      conflictBlocked: true,
      conflictReasons: reasons,
      error: reasons[0],
    };
  }

  // Link or create Person
  let personId = opts.usePersonId || enq.linkedPersonId;
  if (!personId) {
    const createdPerson = savePersonRecord(
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
      const createdOrg = saveOrganisationRecord(
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
      const orgRecord = store.organisations.find((o) => o.id === orgId);
      if (orgRecord) {
        orgRecord.conflictDecision = decisionSnapshot;
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
      const hasLink = store.links.some(
        (l) => l.personId === personId && l.organisationId === orgId && l.isCurrent,
      );
      if (!hasLink) {
        createOrUpdateLink(
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

  saveStore(store);
  return {
    ok: true,
    clientId,
    instructingContactId,
    enquiryId: enq.id,
    ...(conflictWarnings.length > 0 ? { conflictWarnings } : {}),
  };
}

/**
 * Step 4 & 5 of Converting an enquiry to a matter (called inside saveMatterRecord when sourceEnquiryId is set):
 * - Marks the enquiry Converted and sets convertedMatterId.
 * - Completes the open contact task.
 * - Raises the automatic "Complete matter opening" task assigned to the matter lead fee earner (5 working days).
 */
function finalizeEnquiryConversionToMatter(
  store: FirmStore,
  enquiryId: string,
  matter: Matter,
  byId: string,
  now: string,
): void {
  const enq = store.enquiries.find((e) => e.id === enquiryId);
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

  completeOpenContactTasksForEnquiry(
    store,
    enq.id,
    `Enquiry converted to matter ${matter.matterNumber}`,
    byId,
    now,
  );

  // Carry enquiry key dates across to the converted matter (`source: 'carried_from_enquiry'`) (§1)
  const kdConfig = getKeyDatesConfig(store);
  if (kdConfig.enabled) {
    store.keyDates = store.keyDates ?? [];
    const { tasks: storeTasks } = store;
    carryEnquiryKeyDatesToMatter({
      enquiry: enq,
      matter,
      tenantId: store.firmId || getActiveTenantConfiguration().tenantId,
      keyDates: store.keyDates,
      tasks: storeTasks,
      teams: store.teams,
      config: kdConfig,
      actorId: byId,
      nowIso: now,
      nextKeyDateId: () => nextId(store, 'KD'),
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });
  }

  // Automatic task: Complete matter opening (5 working days) once the matter has a real reference (or if none exists yet)
  const hasCompleteOpeningTask = store.tasks.some(
    (t) =>
      t.autoTrigger === 'complete_matter_opening' &&
      t.linkedRecords.some((lr) => lr.recordType === 'matter' && lr.recordId === matter.id),
  );
  if (!hasCompleteOpeningTask && matter.matterNumber !== 'DRAFT') {
    const whCfg = workingHoursConfigFromStore(store);
    const tpl = store.taskSettings.templates.find((t) => t.trigger === 'complete_matter_opening');
    const offsetDays = tpl?.dueWorkingDaysOffset ?? 5;
    const dueDate = toIsoDate(addWorkingDays(new Date(), offsetDays, whCfg));

    raiseAutomaticTask(
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
export function anonymiseExpiredEnquiries(byId: string, specificEnquiryId?: string): number {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
  });
  requirePermission(permSet, 'enquiry:anonymise');
  const now = new Date();
  const nowIso = now.toISOString();
  const months = store.enquirySettings.retentionMonths || 12;
  let count = 0;

  for (const enq of store.enquiries) {
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

  if (count > 0) saveStore(store);
  return count;
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

export function getMatterPmsViewBundle(
  matterId: string,
  byId?: string,
): MatterPmsViewBundle | ActionDenied {
  const auth = verifyFinanceActorAndPermission(byId, 'finance:view_matter');
  if (!auth.ok) return auth;

  const { store, actor, permSet, tokenRoles, visiblePmsLinks } = auth;
  const matter = store.matters.find((m) => m.id === matterId && !m.mergedIntoId);
  if (
    !matter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: store.people,
      teams: store.teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const pms = getPmsSource();
  const extractInfo = pms.getExtractInfo();
  const link =
    visiblePmsLinks.find((l) => l.entityType === 'matter' && l.onesquaredId === matterId) ?? null;

  const canManageLinks = permSet.permissions.has('finance:manage_links');
  let allUnlinkedPmsMatters: PmsMatter[] = [];
  let unlinkedPmsMattersForClient: PmsMatter[] = [];

  if (canManageLinks) {
    const linkedPmsCodes = new Set(
      store.pmsLinks.filter((l) => l.entityType === 'matter').map((l) => l.pmsCode),
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

export function getClientPmsViewBundle(
  recordType: 'organisation' | 'person',
  recordId: string,
  byId?: string,
): ClientPmsViewBundle | ActionDenied {
  const auth = verifyFinanceActorAndPermission(byId, 'finance:view_matter');
  if (!auth.ok) return auth;

  const { store, hiddenMatterIds, accessibleLinkedPmsMatterCodes, visiblePmsLinks } = auth;
  const targetExists =
    recordType === 'organisation'
      ? store.organisations.some((o) => o.id === recordId && !o.mergedIntoId)
      : store.people.some((p) => p.id === recordId && !p.mergedIntoId);
  if (!targetExists) {
    return buildActionDenied(
      'FORBIDDEN',
      'Client record not found or access denied.',
    );
  }

  const pms = getPmsSource();
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
    const org = store.organisations.find((o) => o.id === recordId);
    if (org) {
      const subsidiaries = store.organisations.filter(
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

export function getPmsAdminSnapshot(byId?: string): PmsAdminSnapshot {
  const store = getStore();
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
  const actorId = byId || getActiveActorSession()?.personId;
  const actor = actorId ? store.people.find((p) => p.id === actorId) ?? null : null;
  const visibleMatters = actorId
    ? store.matters.filter((m) =>
        canPersonAccessMatter(m, actorId, actor, {
          allPeople: store.people,
          teams: store.teams,
        }),
      )
    : store.matters;
  const visibleMatterIdSet = new Set(visibleMatters.map((m) => m.id));
  const hiddenPmsCodes = new Set(
    store.pmsLinks
      .filter((l) => l.entityType === 'matter' && !visibleMatterIdSet.has(l.onesquaredId))
      .map((l) => l.pmsCode),
  );
  const visiblePmsLinks = store.pmsLinks.filter(
    (l) => !(l.entityType === 'matter' && !visibleMatterIdSet.has(l.onesquaredId)),
  );
  const pms = getPmsSource();
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

export function linkPmsRecord(
  entityType: PmsEntityType,
  onesquaredId: string,
  pmsCode: string,
  byId: string,
): PmsLink {
  const store = getStore();
  const now = new Date().toISOString();

  // Remove any existing link for either side of this entityType
  store.pmsLinks = store.pmsLinks.filter(
    (l) =>
      !(
        l.entityType === entityType &&
        (l.onesquaredId === onesquaredId || l.pmsCode === pmsCode)
      ),
  );

  const link: PmsLink = {
    id: nextId(store, 'PMSL'),
    entityType,
    onesquaredId,
    pmsCode,
    matchedBy: 'manual',
    matchedAt: now,
  };
  store.pmsLinks.push(link);

  const auditRecordType =
    entityType === 'employee'
      ? 'person'
      : entityType === 'matter'
        ? 'matter'
        : entityType;
  writeAudit(store, {
    recordType: auditRecordType,
    recordId: onesquaredId,
    action: 'link',
    field: 'PMS link',
    oldValue: null,
    newValue: `${pmsCode} (manual)`,
    byId,
    at: now,
  });

  saveStore(store);
  return link;
}

export function unlinkPmsRecord(linkId: string, byId: string): void {
  const store = getStore();
  const existing = store.pmsLinks.find((l) => l.id === linkId);
  if (!existing) return;
  store.pmsLinks = store.pmsLinks.filter((l) => l.id !== linkId);

  const auditRecordType =
    existing.entityType === 'employee'
      ? 'person'
      : existing.entityType === 'matter'
        ? 'matter'
        : existing.entityType;
  writeAudit(store, {
    recordType: auditRecordType,
    recordId: existing.onesquaredId,
    action: 'unlink',
    field: 'PMS link',
    oldValue: existing.pmsCode,
    newValue: null,
    byId,
  });

  saveStore(store);
}

export function rerunAutomaticPmsMatching(byId: string): { totalLinks: number } {
  const store = getStore();
  const pms = getPmsSource();
  const now = new Date().toISOString();
  store.pmsLinks = computeAutomaticPmsLinks(
    store.pmsLinks,
    store.organisations,
    store.people,
    store.matters,
    pms.listClients(),
    pms.listFeeEarners(),
    pms.listMatters(),
    now,
    false,
  );
  void byId;
  saveStore(store);
  return { totalLinks: store.pmsLinks.length };
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
): Promise<{ ok: boolean; createdId?: string; error?: string } & Partial<Omit<ActionDenied, 'ok'>>> {
  const store = getStore();
  const pms = getPmsSource();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
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
  if (
    getActiveActorSession() &&
    actorPerms.mfaPendingPermissions.has('admin:access')
  ) {
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

    const res = savePersonRecord(
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
      { byId },
    );
    if (res.errors) return { ok: false, error: Object.values(res.errors).join(' ') };

    linkPmsRecord('employee', res.person.id, pmsCode, byId);
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

    const res = saveOrganisationRecord(
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

    linkPmsRecord('organisation', res.organisation.id, pmsCode, byId);
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

    const res = savePersonRecord(
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

    linkPmsRecord('person', res.person.id, pmsCode, byId);
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
      const createdClient = await createRecordFromPms(clientEntityType, pm.client_code, byId);
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
      const createdFe = await createRecordFromPms('employee', pm.responsible_partner_id, byId);
      partnerId = createdFe.createdId ?? byId;
    }
    if (!partnerId) {
      partnerId = byId;
    }

    let leadId = findOneSquaredIdForPmsCode(store.pmsLinks, 'employee', pm.fee_earner_id);
    if (!leadId && actorPerms.permissions.has('employee:edit_core')) {
      const createdLead = await createRecordFromPms('employee', pm.fee_earner_id, byId);
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

    linkPmsRecord('matter', res.matter.id, pmsCode, byId);
    return { ok: true, createdId: res.matter.id };
  }

  return { ok: false, error: 'Unsupported entity type.' };
}

// ------------------------------------------------------------------ Role-based Home Pages & Actions

export function switchViewingRole(
  userId: string,
  roleKey: string,
): { ok: boolean; error?: string; roleKey?: string } {
  const store = getStore();
  const user = store.people.find((p) => p.id === userId);
  if (!user) return { ok: false, error: 'User not found.' };

  if (!store.homePagesConfig) {
    store.homePagesConfig = createDefaultHomePagesConfig(
      new Date().toISOString(),
      getActiveTenantConfiguration().branding.primaryDomain,
    );
  }

  const userRoles = resolveEmployeeRoles(user, store.teams);
  const isValidConfiguredRole = store.homePagesConfig.roles.some(
    (r) => r.key === roleKey,
  );
  if (
    !userRoles.includes(roleKey) &&
    !(canPreviewAnyHomeRole(userRoles) && isValidConfiguredRole)
  ) {
    return { ok: false, error: 'Role is not assigned to the current user.' };
  }

  store.homePagesConfig.lastViewingRoleByUserId = {
    ...(store.homePagesConfig.lastViewingRoleByUserId ?? {}),
    [userId]: roleKey,
  };
  saveStore(store);
  return { ok: true, roleKey };
}

export function saveHomePagesConfig(
  input: {
    roles?: RoleHomeConfig[];
    firmSettings?: Partial<HomeFirmSettings>;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string; config: HomePagesConfig } {
  const store = getStore();
  const nowIso = new Date().toISOString();
  const primaryDomain = getActiveTenantConfiguration().branding.primaryDomain;
  const current =
    store.homePagesConfig ?? createDefaultHomePagesConfig(nowIso, primaryDomain);
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
  });
  try {
    requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
  } catch (err) {
    const code = err instanceof AuthorisationError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return {
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
  }

  const nextRoles = input.roles
    ? input.roles.map((r) => ({
        ...r,
        headlineCardIds: (r.headlineCardIds ?? []).slice(0, 5),
        primaryPanels: Array.from(new Set(r.primaryPanels ?? [])),
        summaryPanels: Array.from(
          new Set((r.summaryPanels ?? []).filter((p) => !(r.primaryPanels ?? []).includes(p))),
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

  store.homePagesConfig = {
    ...current,
    roles: nextRoles,
    firmSettings: nextSettings,
    updatedAt: nowIso,
    updatedById: byId,
  };

  writeAudit(store, {
    recordType: 'system',
    recordId: 'HOME-CONFIG',
    action: 'update',
    field: 'Home pages configuration',
    oldValue: null,
    newValue: `Updated role Home layouts and firm settings (demoMode=${nextSettings.demoMode})`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true, config: store.homePagesConfig };
}

export function resetHomePagesConfig(
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string; config: HomePagesConfig } {
  const store = getStore();
  const nowIso = new Date().toISOString();
  const primaryDomain = getActiveTenantConfiguration().branding.primaryDomain;
  const current =
    store.homePagesConfig ?? createDefaultHomePagesConfig(nowIso, primaryDomain);
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
  });
  try {
    requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
  } catch (err) {
    const code = err instanceof AuthorisationError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return {
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
  store.homePagesConfig = defaults;
  writeAudit(store, {
    recordType: 'system',
    recordId: 'HOME-CONFIG',
    action: 'update',
    field: 'Home pages configuration',
    oldValue: null,
    newValue: 'Reset role Home layouts to firm defaults',
    byId,
    at: nowIso,
  });
  saveStore(store);
  return { ok: true, config: store.homePagesConfig };
}

export function addHomeRole(
  input: {
    key?: string;
    label: string;
    shortLabel?: string;
    purpose: string;
    copyFromRoleKey?: string;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string; role?: RoleHomeConfig } {
  const store = getStore();
  const nowIso = new Date().toISOString();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
  });
  try {
    requirePermission(actorPerms, 'admin:access', 'save Home pages configuration');
  } catch (err) {
    const code = err instanceof AuthorisationError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code,
      error: code ? `${code}: ${message}` : message,
    };
  }

  if (!store.homePagesConfig) {
    store.homePagesConfig = createDefaultHomePagesConfig(
      nowIso,
      getActiveTenantConfiguration().branding.primaryDomain,
    );
  }
  const cleanLabel = input.label.trim();
  if (!cleanLabel) return { ok: false, error: 'Role name is required.' };

  const key = (input.key || slug(cleanLabel)).replace(/[^a-z0-9_]+/g, '_');
  if (store.homePagesConfig.roles.some((r) => r.key === key)) {
    return { ok: false, error: `Role "${key}" already exists.` };
  }

  const template =
    store.homePagesConfig.roles.find((r) => r.key === (input.copyFromRoleKey || 'fee_earner')) ??
    store.homePagesConfig.roles[0];

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
    store.values.push({
      id: empRoleId,
      listKey: 'employee_role',
      label: cleanLabel,
      description: newRole.purpose,
      parentId: null,
      sortOrder: nextSortOrder(store.values, 'employee_role'),
      active: true,
    });
  }
  store.homePagesConfig.roles.push(newRole);
  store.homePagesConfig.updatedAt = nowIso;
  store.homePagesConfig.updatedById = byId;

  writeAudit(store, {
    recordType: 'system',
    recordId: `ROLE-${key}`,
    action: 'create',
    field: 'Home role',
    oldValue: null,
    newValue: `${newRole.label} (${newRole.key})`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true, role: newRole };
}

export function updateEmployeeRolesAndSupports(
  personId: string,
  input: {
    roles?: string[];
    supportsIds?: string[];
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string } {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId);
  const person = store.people.find((p) => p.id === personId);
  if (!actor) return { ok: false, error: 'Acting user not found.' };
  if (!person) return { ok: false, error: 'Employee not found.' };

  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
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

  writeAudit(store, {
    recordType: 'person',
    recordId: person.id,
    action: 'update',
    field: 'Roles & supported fee earners',
    oldValue: beforeJson,
    newValue: afterJson,
    byId,
  });

  saveStore(store);
  return { ok: true };
}

/**
 * Computes a server-side preview of a target employee's effective permissions when draft
 * `grant`/`revoke` overrides (and optional draft `rbacConfig`) are applied, using the
 * central RBAC resolver (`resolvePersonPermissions`).
 */
export function previewRbacOverrides(
  personId: string,
  draftOverrides: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    rbacConfig?: RbacConfiguration;
  },
  byId: string,
  options?: { mfaVerified?: boolean },
): { ok: boolean; code?: string; error?: string; permissions: PermissionKey[] } {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId);
  const target = store.people.find((p) => p.id === personId);
  if (!actor)
    return { ok: false, error: 'Acting user not found.', permissions: [] };
  if (!target)
    return { ok: false, error: 'Target employee not found.', permissions: [] };
  if (
    !hasPersonPermission(actor, 'admin:access', {
      allPeople: store.people,
      teams: store.teams,
    }) &&
    !hasPersonPermission(actor, 'rbac:manage_user_overrides', {
      allPeople: store.people,
      teams: store.teams,
    }) &&
    !hasPersonPermission(actor, 'rbac:manage_config', {
      allPeople: store.people,
      teams: store.teams,
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

  const cleanGrant = Array.from(
    new Set((draftOverrides.grant ?? []).filter(isRegisteredPermissionKey)),
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
    allPeople: store.people,
    teams: store.teams,
    ...(validatedRbacConfig
      ? { config: { rbac: validatedRbacConfig } }
      : {}),
  });

  return { ok: true, permissions };
}

/**
 * Updates a target person's unified `permissionOverrides` (`grant` / `revoke`) and/or `entraObjectId`.
 * Enforces `rbac:manage_user_overrides` + MFA + blocks self-modification + blocks granting unheld permissions,
 * and writes a before/after audit entry (ADR-0015).
 */
export function updatePersonPermissionOverrides(
  personId: string,
  input: {
    grant: PermissionKey[];
    revoke: PermissionKey[];
    reason?: string;
    entraObjectId?: string | null;
  },
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string; person?: Person } {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId);
  const target = store.people.find((p) => p.id === personId);
  if (!actor) return { ok: false, error: 'Acting user not found.' };
  if (!target) return { ok: false, error: 'Target employee not found.' };

  const rbacConfig = getDefaultTenantRbacConfig();
  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
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
  const newlyAddedPermissions = cleanGrant.filter((p) => !prevGrant.has(p));

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
    grant: cleanGrant,
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

  writeAudit(store, {
    recordType: 'person',
    recordId: target.id,
    action: 'update',
    field: 'Permission overrides & Entra ID binding',
    oldValue: beforeSummary,
    newValue: afterSummary,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true, person: target };
}

/**
 * Updates the tenant's RBAC configuration (`roles`, `departmentGrants`, `relationshipGrants`, `identityMapping`).
 * Enforces `rbac:manage_config` + MFA, validates all permission and role keys, and writes a before/after audit log.
 */
export function updateTenantRbacConfig(
  patch: Partial<RbacConfiguration>,
  byId: string,
  options: { mfaVerified?: boolean } = {},
): { ok: boolean; code?: string; error?: string; rbacConfig?: RbacConfiguration } {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId);
  if (!actor) return { ok: false, error: 'Acting user not found.' };

  const actorPerms = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    mfaVerified: options.mfaVerified ?? false,
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

  const currentRbac = getDefaultTenantRbacConfig();
  const knownRoleKeys = new Set<string>([
    ...Object.keys(currentRbac.roles),
    ...Object.keys(patch.roles ?? {}),
  ]);

  // Validate permission keys in roles and departmentGrants
  for (const [roleKey, roleDef] of Object.entries(patch.roles ?? {})) {
    for (const perm of roleDef?.permissions ?? []) {
      if (!isRegisteredPermissionKey(perm)) {
        return {
          ok: false,
          error: `Role "${roleKey}" references unknown permission "${perm}".`,
        };
      }
    }
  }
  for (const [deptId, perms] of Object.entries(patch.departmentGrants ?? {})) {
    for (const perm of perms ?? []) {
      if (!isRegisteredPermissionKey(perm)) {
        return {
          ok: false,
          error: `Department "${deptId}" references unknown permission "${perm}".`,
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
  }

  const beforeJson = JSON.stringify(currentRbac);
  const nextRbac = mergeRbacConfigOverlay(currentRbac, patch);
  store.rbacConfigOverride = nextRbac;
  setRuntimeRbacConfigOverride(nextRbac);

  writeAudit(store, {
    recordType: 'system',
    recordId: 'TENANT-RBAC-CONFIG',
    action: 'update',
    field: 'Tenant RBAC & Entra ID Identity Mapping',
    oldValue: beforeJson,
    newValue: JSON.stringify(nextRbac),
    byId,
    at: new Date().toISOString(),
  });

  saveStore(store);
  return { ok: true, rbacConfig: nextRbac };
}

export function approveSignOff(
  signOffId: string,
  byId: string,
): { ok: true } | ActionDenied {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
  });
  if (!permSet.permissions.has('signoff:approve')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (signoff:approve) to approve sign-off requests.',
    );
  }

  const item = (store.signOffs ?? []).find((s) => s.id === signOffId);
  if (!item) {
    return buildActionDenied('FORBIDDEN', 'Sign-off item not found or access denied.');
  }

  if (item.matterId) {
    const linkedMatter = store.matters.find((m) => m.id === item.matterId) ?? null;
    if (
      !linkedMatter ||
      !canPersonAccessMatter(linkedMatter, byId, actor, {
        allPeople: store.people,
        teams: store.teams,
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

  writeAudit(store, {
    recordType: item.matterId ? 'matter' : 'system',
    recordId: item.matterId ?? item.id,
    action: 'status-change',
    field: 'Partner sign-off',
    oldValue: previousStatus,
    newValue: `Approved: ${item.title}`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true };
}


export function discussSignOff(
  signOffId: string,
  note: string,
  byId: string,
): { ok: true } | ActionDenied {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
  });
  if (!permSet.permissions.has('signoff:approve')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (signoff:approve) to discuss sign-off requests.',
    );
  }

  const item = (store.signOffs ?? []).find((s) => s.id === signOffId);
  if (!item) {
    return buildActionDenied('FORBIDDEN', 'Sign-off item not found or access denied.');
  }

  if (item.matterId) {
    const linkedMatter = store.matters.find((m) => m.id === item.matterId) ?? null;
    if (
      !linkedMatter ||
      !canPersonAccessMatter(linkedMatter, byId, actor, {
        allPeople: store.people,
        teams: store.teams,
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

  writeAudit(store, {
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
  saveTaskRecord(
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

  saveStore(store);
  return { ok: true };
}


export function requestMatterBill(
  matterCode: string,
  byId: string,
): { ok: true; taskId?: string } | ActionDenied {
  const auth = verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  const { store, actor, tokenRoles } = auth;
  const linkedId = findOneSquaredIdForPmsCode(store.pmsLinks, 'matter', matterCode);
  const targetMatter = linkedId
    ? store.matters.find((m) => m.id === linkedId && !m.mergedIntoId)
    : undefined;
  const pmsMatter = linkedId ? getPmsSource().getMatterFinancials(matterCode) : null;
  if (
    !targetMatter ||
    !pmsMatter ||
    !canPersonAccessMatter(targetMatter, actor.id, actor, {
      allPeople: store.people,
      teams: store.teams,
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

  const res = saveTaskRecord(
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

export function flagMatterWriteOff(
  matterCode: string,
  amountGbp: number,
  byId: string,
): { ok: true; signOffId?: string } | ActionDenied {
  const auth = verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  if (typeof amountGbp !== 'number' || !Number.isFinite(amountGbp) || amountGbp <= 0) {
    return buildActionDenied(
      'FORBIDDEN',
      'Write-off amount must be a finite number greater than 0.',
    );
  }

  const { store, actor, tokenRoles } = auth;
  const linkedId = findOneSquaredIdForPmsCode(store.pmsLinks, 'matter', matterCode);
  const matter = linkedId
    ? store.matters.find((m) => m.id === linkedId && !m.mergedIntoId)
    : undefined;
  const pmsMatter = linkedId ? getPmsSource().getMatterFinancials(matterCode) : null;
  if (
    !matter ||
    !pmsMatter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: store.people,
      teams: store.teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const id = nextId(store, 'SO');
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

  if (!Array.isArray(store.signOffs)) store.signOffs = [];
  store.signOffs.unshift(signOff);
  saveStore(store);
  return { ok: true, signOffId: id };
}

export function remindTeamLeadOverdueCompliance(
  teamId: string,
  byId: string,
): { ok: boolean } | ActionDenied {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
  });
  if (!permSet.permissions.has('risk:view')) {
    return buildActionDenied(
      'FORBIDDEN',
      'You do not have permission (risk:view) to send overdue compliance reminders.',
    );
  }
  const team = store.teams.find((t) => t.id === teamId);
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

  store.notifications.unshift({
    id: nextId(store, 'NTF'),
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

  writeAudit(store, {
    recordType: 'team',
    recordId: team.id,
    action: 'update',
    field: 'Compliance reminder',
    oldValue: null,
    newValue: `Sent overdue compliance task reminder to team lead (${leadId})`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true };
}


export function recordInvoiceCreditControlAction(
  input: {
    invoiceNumber: string;
    matterCode: string;
    clientCode: string;
    actionType: 'log_call' | 'send_reminder' | 'escalate';
    note?: string;
  },
  byId: string,
): { ok: true; taskId?: string } | ActionDenied {
  const auth = verifyFinanceActorAndPermission(byId, 'finance:credit_control');
  if (!auth.ok) return auth;

  const { store, actor, tokenRoles } = auth;
  const linkedMatterId = findOneSquaredIdForPmsCode(
    store.pmsLinks,
    'matter',
    input.matterCode,
  );

  const matter = linkedMatterId
    ? store.matters.find((m) => m.id === linkedMatterId && !m.mergedIntoId)
    : null;
  const pmsMatter = linkedMatterId
    ? getPmsSource().getMatterFinancials(input.matterCode)
    : null;
  if (
    !matter ||
    !pmsMatter ||
    !canPersonAccessMatter(matter, actor.id, actor, {
      allPeople: store.people,
      teams: store.teams,
      tokenRoles,
    })
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Matter not found or access denied.',
    );
  }

  const pmsInvoice = getPmsSource().getInvoiceBalance(input.invoiceNumber);
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
    store.pmsLinks,
    'organisation',
    invoiceClientCode,
  );
  const linkedPersonId = findOneSquaredIdForPmsCode(
    store.pmsLinks,
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
    const res = saveTaskRecord(
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

  // Record a note on the client or matter and log an audit entry
  const targetRecordId = linkedOrgId ?? linkedPersonId ?? linkedMatterId;
  if (targetRecordId) {
    store.notes.unshift({
      id: nextId(store, 'N'),
      recordType: targetRecordId.startsWith('O-')
        ? 'organisation'
        : targetRecordId.startsWith('P-')
          ? 'person'
          : 'matter',
      recordId: targetRecordId,
      authorId: byId,
      at: nowIso,
      text:
        input.actionType === 'log_call'
          ? `Credit control call logged regarding invoice ${input.invoiceNumber} (${input.matterCode}). ${input.note ?? ''}`.trim()
          : `Credit control reminder statement sent for invoice ${input.invoiceNumber} (${input.matterCode}).`,
    });
  }

  writeAudit(store, {
    recordType: linkedMatterId ? 'matter' : 'system',
    recordId: linkedMatterId ?? input.invoiceNumber,
    action: 'note',
    field: 'Credit control',
    oldValue: null,
    newValue: `${input.actionType === 'log_call' ? 'Logged chase call' : 'Sent reminder'} on ${input.invoiceNumber}`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { ok: true };
}


export function saveOrgStructure(
  nextCatalogue: OrgStructureCatalogue,
  byId: string,
): { orgStructure: OrgStructureCatalogue } {
  const store = getStore();
  store.orgStructure = nextCatalogue;
  writeAudit(store, {
    recordType: 'system',
    recordId: 'ORG-STRUCTURE',
    action: 'update',
    field: 'Organisation structure reference tables',
    oldValue: null,
    newValue: `Updated organisation hierarchy (${nextCatalogue.divisions.length} divisions, ${nextCatalogue.departments.length} departments, ${nextCatalogue.teamsOrPracticeGroups.length} teams/practice groups)`,
    byId,
    at: new Date().toISOString(),
  });
  saveStore(store);
  return { orgStructure: store.orgStructure };
}

export function saveMatterPartyRelationship(
  input: {
    code: string;
    label: string;
    description?: string;
    active?: boolean;
    isNew?: boolean;
  },
  byId: string,
): { relationship?: MatterPartyRelationshipDef; taxonomy: MatterPartyTaxonomy; error?: string } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const code = input.code.trim().toUpperCase();
  const label = input.label.trim();
  if (!code) return { taxonomy, error: 'Relationship code is required.' };
  if (!label) return { taxonomy, error: 'Relationship label is required.' };

  const existingIdx = taxonomy.relationships.findIndex((r) => r.code === code);
  if (input.isNew) {
    if (existingIdx !== -1) {
      return { taxonomy, error: `Relationship code "${code}" already exists. Codes are immutable.` };
    }
    const maxOrder = taxonomy.relationships.reduce((m, r) => Math.max(m, r.sortOrder), 0);
    const created: MatterPartyRelationshipDef = {
      code,
      label,
      description: (input.description ?? '').trim(),
      sortOrder: maxOrder + 1,
      active: input.active ?? true,
    };
    taxonomy.relationships.push(created);
    writeAudit(store, {
      recordType: 'list',
      recordId: 'matter_party_role',
      action: 'list-change',
      field: `Relationship ${code}`,
      oldValue: null,
      newValue: `${code} — ${label}`,
      byId,
    });
    saveStore(store);
    return { relationship: created, taxonomy };
  }

  if (existingIdx === -1) {
    return { taxonomy, error: `Relationship "${code}" not found.` };
  }
  const existing = taxonomy.relationships[existingIdx];
  const updated: MatterPartyRelationshipDef = {
    ...existing,
    code: existing.code, // Immutable
    label,
    description: input.description !== undefined ? input.description.trim() : existing.description,
    active: input.active !== undefined ? input.active : existing.active,
  };
  taxonomy.relationships[existingIdx] = updated;
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Relationship ${existing.code}`,
    oldValue: `${existing.label}${existing.active ? '' : ' (inactive)'}`,
    newValue: `${updated.label}${updated.active ? '' : ' (inactive)'}`,
    byId,
  });
  saveStore(store);
  return { relationship: updated, taxonomy };
}

export function reorderMatterPartyRelationship(
  code: string,
  direction: -1 | 1,
  byId: string,
): { taxonomy: MatterPartyTaxonomy } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const sorted = [...taxonomy.relationships].sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = sorted.findIndex((r) => r.code === code);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) {
    return { taxonomy };
  }
  [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
  sorted.forEach((r, i) => {
    r.sortOrder = i + 1;
  });
  taxonomy.relationships = sorted;
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Reordered relationship ${code}`,
    oldValue: null,
    newValue: direction === -1 ? 'Moved up' : 'Moved down',
    byId,
  });
  saveStore(store);
  return { taxonomy };
}

export function deleteMatterPartyRelationship(
  code: string,
  byId: string,
): { taxonomy: MatterPartyTaxonomy; error?: string } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const usage = computeMatterPartyUsageCounts(store.matters);
  const count = usage.byRelationshipCode[code] ?? 0;
  if (count > 0) {
    return {
      taxonomy,
      error: `Relationship "${code}" is in use on ${count} matter party record(s). It can be deactivated but not deleted.`,
    };
  }
  const existing = taxonomy.relationships.find((r) => r.code === code);
  if (!existing) return { taxonomy, error: 'Relationship not found.' };
  taxonomy.relationships = taxonomy.relationships.filter((r) => r.code !== code);
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Deleted relationship ${code}`,
    oldValue: existing.label,
    newValue: null,
    byId,
  });
  saveStore(store);
  return { taxonomy };
}

export function saveMatterPartyCapacity(
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
): { capacity?: MatterPartyCapacityDef; taxonomy: MatterPartyTaxonomy; error?: string } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const label = input.label.trim();
  if (!code) return { taxonomy, error: 'Capacity code is required.' };
  if (!label) return { taxonomy, error: 'Capacity label is required.' };

  const existingIdx = taxonomy.capacities.findIndex((c) => c.code === code);
  if (input.isNew) {
    if (existingIdx !== -1) {
      return { taxonomy, error: `Capacity code "${code}" already exists. Codes are immutable.` };
    }
    const maxOrder = taxonomy.capacities.reduce((m, c) => Math.max(m, c.sortOrder), 0);
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
    writeAudit(store, {
      recordType: 'list',
      recordId: 'matter_party_role',
      action: 'list-change',
      field: `Capacity ${code}`,
      oldValue: null,
      newValue: `${label} (${created.group})`,
      byId,
    });
    saveStore(store);
    return { capacity: created, taxonomy };
  }

  if (existingIdx === -1) {
    return { taxonomy, error: `Capacity "${code}" not found.` };
  }
  const existing = taxonomy.capacities[existingIdx];
  const updated: MatterPartyCapacityDef = {
    ...existing,
    code: existing.code, // Immutable
    label,
    group: input.group || existing.group,
    description: input.description !== undefined ? input.description.trim() || undefined : existing.description,
    allowedRelationships: Array.from(new Set(input.allowedRelationships)),
    profiles: Array.from(new Set(input.profiles)),
    active: input.active !== undefined ? input.active : existing.active,
  };
  taxonomy.capacities[existingIdx] = updated;
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Capacity ${existing.code}`,
    oldValue: `${existing.label}${existing.active ? '' : ' (inactive)'}`,
    newValue: `${updated.label}${updated.active ? '' : ' (inactive)'}`,
    byId,
  });
  saveStore(store);
  return { capacity: updated, taxonomy };
}

export function deleteMatterPartyCapacity(
  code: string,
  byId: string,
): { taxonomy: MatterPartyTaxonomy; error?: string } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const usage = computeMatterPartyUsageCounts(store.matters);
  const count = usage.byCapacityCode[code] ?? 0;
  if (count > 0) {
    return {
      taxonomy,
      error: `Capacity "${code}" is in use on ${count} matter party record(s). It can be deactivated but not deleted.`,
    };
  }
  const existing = taxonomy.capacities.find((c) => c.code === code);
  if (!existing) return { taxonomy, error: 'Capacity not found.' };
  taxonomy.capacities = taxonomy.capacities.filter((c) => c.code !== code);
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Deleted capacity ${code}`,
    oldValue: existing.label,
    newValue: null,
    byId,
  });
  saveStore(store);
  return { taxonomy };
}

export function updateWorkTypeProfiles(
  workTypeSubcategoryId: string,
  profiles: WorkTypeProfileCode[],
  byId: string,
): { taxonomy: MatterPartyTaxonomy } {
  const store = getStore();
  const taxonomy = store.matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(store.values);
  store.matterPartyTaxonomy = taxonomy;
  const prev = taxonomy.workTypeProfiles[workTypeSubcategoryId] ?? [];
  const next = Array.from(new Set(profiles.filter((p) => p !== 'ALL')));
  taxonomy.workTypeProfiles[workTypeSubcategoryId] = next;
  writeAudit(store, {
    recordType: 'list',
    recordId: 'matter_party_role',
    action: 'list-change',
    field: `Work type profiles: ${workTypeSubcategoryId}`,
    oldValue: prev.join(', '),
    newValue: next.join(', '),
    byId,
  });
  saveStore(store);
  return { taxonomy };
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

export function saveQuoteRecord(
  input: SaveQuoteInput,
  opts: { id?: string; byId: string; markAsSent?: boolean },
): { quote?: Quote; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === opts.byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to create or edit quotes.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const now = new Date();
  const nowIso = now.toISOString();

  const existing = opts.id ? store.quotes.find((q) => q.id === opts.id) : undefined;
  if (opts.id && (!existing || !visibility.canViewQuote(existing))) {
    const msg = 'Quote not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }

  const clientType = input.clientType || 'prospect';
  const linkedOrganisationId = input.linkedOrganisationId || null;
  const linkedPersonId = input.linkedPersonId || null;
  if (linkedOrganisationId && !store.organisations.some((o) => o.id === linkedOrganisationId)) {
    const msg = 'Linked organisation not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (linkedPersonId && !store.people.some((p) => p.id === linkedPersonId)) {
    const msg = 'Linked person not found.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  if (input.linkedEnquiryId) {
    const linkedEnq = store.enquiries.find((e) => e.id === input.linkedEnquiryId);
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
  const routedTeam = resolveRoutedTeam(input.practiceAreaId, store.teams);
  const feeEarnerTeam = store.teams.find(
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
    const reference = nextQuoteReference(store, now.getFullYear());
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

    store.quotes.unshift(created);
    writeAudit(store, {
      recordType: 'quote',
      recordId: created.id,
      action: 'create',
      field: markSent ? 'Quote created and marked as sent' : 'Quote saved as draft',
      oldValue: null,
      newValue: `${created.reference} — ${quoteClientDisplayName(created, store.people, store.organisations)}`,
      byId: opts.byId,
      at: nowIso,
    });
    saveStore(store);
    return { quote: created };
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

  writeAudit(store, {
    recordType: 'quote',
    recordId: existing.id,
    action: 'update',
    field: wasSentNow ? 'Quote marked as sent' : 'Quote updated',
    oldValue: null,
    newValue: `${existing.reference} (v${existing.version})`,
    byId: opts.byId,
    at: nowIso,
  });
  saveStore(store);
  return { quote: existing };
}

export function markQuoteSentRecord(
  quoteId: string,
  byId: string,
): { quote?: Quote; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to mark a quote as sent.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const quote = store.quotes.find((q) => q.id === quoteId);
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

  writeAudit(store, {
    recordType: 'quote',
    recordId: quote.id,
    action: 'status-change',
    field: 'Mark as sent',
    oldValue: 'Draft',
    newValue: `Sent (follow-up due ${nextFollowUpDate})`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { quote };
}

export function logQuoteFollowUpRecord(
  quoteId: string,
  input: {
    method: ContactLogMethod;
    note: string;
    nextFollowUpDate: string | null;
  },
  byId: string,
): { quote?: Quote; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to log quote follow-ups.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const quote = store.quotes.find((q) => q.id === quoteId);
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

  writeAudit(store, {
    recordType: 'quote',
    recordId: quote.id,
    action: 'contact-log',
    field: `Quote follow-up (${input.method})`,
    oldValue: null,
    newValue: input.note.trim(),
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { quote };
}

export function reviseQuoteRecord(
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
): { quote?: Quote; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to revise quotes.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const quote = store.quotes.find((q) => q.id === quoteId);
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

  writeAudit(store, {
    recordType: 'quote',
    recordId: quote.id,
    action: 'update',
    field: `Quote revised to v${nextVersion}`,
    oldValue: `v${prevVersion} (Superseded)`,
    newValue: `v${nextVersion} — £${quote.feeAmountExVat.toLocaleString('en-GB')} + VAT (${quote.status})`,
    byId,
    at: nowIso,
  });

  saveStore(store);
  return { quote };
}

export function recordQuoteOutcomeRecord(
  quoteId: string,
  input: {
    outcome: 'Accepted' | 'Declined';
    declineReason?: QuoteDeclineReason | null;
    note?: string;
  },
  byId: string,
): { quote?: Quote; error?: string } & Partial<ActionDenied> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'quote:edit', {
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    const msg = 'You do not have permission (quote:edit) to record a quote outcome.';
    return { ...buildActionDenied('FORBIDDEN', msg), error: msg };
  }
  const visibility = buildRecordVisibility(store, actor);
  const quote = store.quotes.find((q) => q.id === quoteId);
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

  writeAudit(store, {
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

  saveStore(store);
  return { quote };
}

/**
 * Prepare a quote for conversion to a matter:
 * Ensures a Person and/or Organisation record exists for the client/prospect,
 * links them on the quote, and returns clientId & instructingContactId for /matters/new.
 */
export function prepareQuoteConversionRecord(
  quoteId: string,
  byId: string,
): {
  ok: boolean;
  conflictBlocked?: boolean;
  conflictReasons?: string[];
  conflictWarnings?: string[];
  clientId?: string;
  instructingContactId?: string | null;
  quoteId?: string;
  enquiryId?: string | null;
  error?: string;
} & Partial<Omit<ActionDenied, 'ok'>> {
  const store = getStore();
  const actor = store.people.find((p) => p.id === byId) ?? null;
  if (
    !hasPersonPermission(actor, 'matter:create', {
      allPeople: store.people,
      teams: store.teams,
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
  const visibility = buildRecordVisibility(store, actor);
  const quote = store.quotes.find((q) => q.id === quoteId);
  if (!quote || !visibility.canViewQuote(quote)) {
    return { ok: false, error: 'Quote not found.' };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = toIsoDate(now);
  const actorName = actor ? personDisplayName(actor) : byId;
  const actorHasRiskView = hasPersonPermission(actor, 'risk:view', {
    allPeople: store.people,
    teams: store.teams,
  });

  let personId = quote.linkedPersonId;
  let orgId = quote.linkedOrganisationId;

  // If linked to an enquiry that already has linkedPersonId / linkedOrganisationId, inherit if missing
  const linkedEnq = quote.linkedEnquiryId
    ? store.enquiries.find((e) => e.id === quote.linkedEnquiryId)
    : undefined;
  if (linkedEnq) {
    if (!personId && linkedEnq.linkedPersonId) personId = linkedEnq.linkedPersonId;
    if (!orgId && linkedEnq.linkedOrganisationId) orgId = linkedEnq.linkedOrganisationId;
  }

  const hasOrgName = Boolean(quote.prospectOrganisationName.trim());
  const hasPersonName = Boolean(quote.prospectName.trim());
  const existingOrg = orgId ? store.organisations.find((o) => o.id === orgId) : undefined;
  const existingPerson = personId ? store.people.find((p) => p.id === personId) : undefined;
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
    people: store.people,
    organisations: store.organisations,
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
      matters: store.matters,
      enquiries: store.enquiries,
      people: store.people,
      organisations: store.organisations,
      links: store.links,
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
    store.people,
    store.organisations,
    store.matters,
    store.values,
    store.enquiries.filter((e) => visibility.canViewEnquiry(e)),
    quote.linkedEnquiryId ?? null,
    store.links,
    visibility.canViewMatter,
    getActiveTenantConfiguration().tenantId,
  );

  const hasRestrictedMatch = hasUnapprovedRestrictedMatches(reconciledMatches, []);
  const declinedOrgAssessment = assessDeclinedOrganisation(
    store,
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
    saveStore(store);

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

  if (!personId && hasPersonName) {
    const parts = quote.prospectName.trim().split(/\s+/);
    const firstName = parts[0] || 'Client';
    const surname = parts.slice(1).join(' ') || 'Contact';

    const createdPerson = savePersonRecord(
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
    const createdOrg = saveOrganisationRecord(
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
      const linkExists = store.links.some(
        (l) => l.personId === personId && l.organisationId === orgId,
      );
      if (!linkExists) {
        createOrUpdateLink(
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
    const orgRecord = store.organisations.find((o) => o.id === orgId);
    if (orgRecord) {
      orgRecord.conflictStatusId = vid('conflict_status', outcomeLabel);
      orgRecord.conflictReference = conflictReference;
      orgRecord.reviewDate = today;
      orgRecord.reviewerId = byId;
      orgRecord.conflictDecision = decisionSnapshot;
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

  saveStore(store);

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
}

function finalizeQuoteConversionToMatter(
  store: FirmStore,
  quoteId: string,
  matter: Matter,
  byId: string,
  now: string,
): void {
  const quote = store.quotes.find((q) => q.id === quoteId);
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

  // Also close any linked enquiry and link it to the matter
  if (quote.linkedEnquiryId) {
    if (!matter.sourceEnquiryId) {
      matter.sourceEnquiryId = quote.linkedEnquiryId;
    }
    finalizeEnquiryConversionToMatter(store, quote.linkedEnquiryId, matter, byId, now);
  }
}

export function saveMatterCostsConfig(
  config: MatterCostsConfig,
  byId: string,
): MatterCostsConfig {
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
  const store = getStore();
  const now = new Date().toISOString();
  const next: MatterCostsConfig = {
    ...config,
    updatedAt: now,
    updatedById: byId,
  };
  store.matterCostsConfig = next;
  writeAudit(store, {
    recordType: 'matter',
    recordId: 'FIRM-MATTER-COSTS-CONFIG',
    action: 'update',
    field: 'Matter Costs & Rates Table Config',
    oldValue: null,
    newValue: `${next.clientProfileName} (${next.rateSourceMode}, ${next.rateCards.length} rate cards)`,
    byId,
    at: now,
  });
  saveStore(store);
  return next;
}

export function syncMatterCostsRatesFromPms(
  byId: string,
): MatterCostsConfig {
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
  const store = getStore();
  const pms = getPmsSource();
  const feeEarners = pms.listFeeEarners();
  const base =
    store.matterCostsConfig ??
    createDefaultMatterCostsConfig(store.values, {
      clientProfileCode: tenantCfg.tenantId,
      displayName: tenantCfg.displayName,
      primaryDomain: tenantCfg.branding.primaryDomain,
    });
  const synced = syncRateCardsWithPmsFeeEarners(base, feeEarners, store.values);
  const now = new Date().toISOString();
  const next: MatterCostsConfig = {
    ...synced,
    pmsLinkActive: true,
    updatedAt: now,
    updatedById: byId,
  };
  store.matterCostsConfig = next;
  writeAudit(store, {
    recordType: 'matter',
    recordId: 'FIRM-MATTER-COSTS-CONFIG',
    action: 'update',
    field: 'PMS Rate Cards Sync',
    oldValue: base.pmsLastSyncedAt ?? 'Never',
    newValue: `Synced ${feeEarners.length} fee earner rates from PMS (${now})`,
    byId,
    at: now,
  });
  saveStore(store);
  return next;
}

export function resolveOrProvisionEntraEmployee(
  claims: EntraIdRawTokenClaims & Record<string, unknown>,
): {
  person: Person;
  verifiedToken: VerifiedOidcTokenClaims;
  rbacConfig: RbacConfiguration;
} {
  const store = getStore();
  const rbacConfig = getDefaultTenantRbacConfig();
  const { person: matchedPerson, verifiedToken } = resolvePersonForEntraClaims({
    claims,
    people: store.people,
    teams: store.teams,
    rbacConfig,
  });

  const now = new Date().toISOString();
  const oid = claims.oid?.trim() || verifiedToken.sub;
  const claimEmail = (
    claims.email ||
    claims.preferred_username ||
    claims.upn ||
    ''
  ).trim();
  const authorityMode = rbacConfig.identityMapping?.authorityMode ?? 'hybrid';

  if (matchedPerson) {
    const prevOid = matchedPerson.entraObjectId?.trim() || null;
    const matchedByEmailOnly = !prevOid && Boolean(oid);
    if (matchedByEmailOnly && oid) {
      matchedPerson.entraObjectId = oid;
      writeAudit(store, {
        recordType: 'person',
        recordId: matchedPerson.id,
        action: 'update',
        field: 'Entra ID Email Link',
        oldValue: 'unlinked',
        newValue: `Linked email ${claimEmail || 'unknown'} to Entra oid=${oid}`,
        byId: matchedPerson.id,
        at: now,
      });
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
    writeAudit(store, {
      recordType: 'person',
      recordId: matchedPerson.id,
      action: 'update',
      field: 'Entra ID OIDC Sign-In',
      oldValue: prevOid ? `oid=${prevOid}` : 'unlinked',
      newValue: `oid=${oid}; roles=${verifiedToken.roles.join(',') || 'none'}; mfa=${verifiedToken.mfaVerified}`,
      byId: matchedPerson.id,
      at: now,
    });
    saveStore(store);
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

  const newId = nextId(store, 'P');
  const newEmployee: Person = {
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

  store.people.push(newEmployee);
  writeAudit(store, {
    recordType: 'person',
    recordId: newEmployee.id,
    action: 'create',
    field: 'Entra ID OIDC Provisioned Employee',
    oldValue: null,
    newValue: `oid=${oid}; roles=${mappedRoles.join(',')}; mfa=${verifiedToken.mfaVerified}`,
    byId: newEmployee.id,
    at: now,
  });
  saveStore(store);

  return { person: newEmployee, verifiedToken, rbacConfig };
}

// ============================================================================
// Key Dates & Limitation Module Service Functions (§1–§9)
// ============================================================================

function resolveActorForKeyDates(store: FirmStore, byId: string): Person | null {
  if (!byId || !byId.trim()) return null;
  return (
    store.people.find((p) => p.id === byId && p.isEmployee && !p.mergedIntoId) ??
    null
  );
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

export function getMatterKeyDatesSnapshot(
  matterId: string,
  userId: string,
): {
  keyDates: KeyDate[];
  keyDateNotApplicable: KeyDateNotApplicable[];
  keyDateReminderStates: KeyDateReminderState[];
  keyDateCalendarSyncs: KeyDateCalendarSync[];
  canVerifyByKeyDateId: Record<string, { allowed: boolean; reason?: string }>;
} {
  const store = getStore();
  const user = resolveActorForKeyDates(store, userId);
  const config = getKeyDatesConfig(store);
  if (
    !user ||
    !hasKeyDatePermission(user, 'keydate:view', {
      config,
      allPeople: store.people,
      teams: store.teams,
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
  const matter = store.matters.find((m) => m.id === matterId);
  if (!matter || !canViewerAccessMatterKeyDates(matter, user.id, user, store.people)) {
    return {
      keyDates: [],
      keyDateNotApplicable: [],
      keyDateReminderStates: [],
      keyDateCalendarSyncs: [],
      canVerifyByKeyDateId: {},
    };
  }
  const keyDates = (store.keyDates ?? []).filter((kd) => kd.matterId === matter.id);
  const keyDateIdSet = new Set(keyDates.map((kd) => kd.id));
  const keyDateNotApplicable = (store.keyDateNotApplicable ?? []).filter(
    (na) => na.matterId === matter.id,
  );
  const keyDateReminderStates = (store.keyDateReminderStates ?? []).filter((rs) =>
    keyDateIdSet.has(rs.keyDateId),
  );
  const keyDateCalendarSyncs = (store.keyDateCalendarSyncs ?? []).filter((cs) =>
    keyDateIdSet.has(cs.keyDateId),
  );
  const canVerifyByKeyDateId: Record<
    string,
    { allowed: boolean; reason?: string }
  > = {};
  for (const kd of keyDates) {
    canVerifyByKeyDateId[kd.id] = canUserVerifyKeyDate(user, kd, {
      config,
      allPeople: store.people,
      teams: store.teams,
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

export function previewLimitationCalculationRecord(
  input: {
    ruleSetId: string;
    ruleId: string;
    triggerValues: Record<string, string>;
    standstillPeriods?: StandstillPeriod[];
    calendarCodeOverride?: string;
  },
  byId: string,
): { ok: boolean; result?: CalculationResult; error?: string } {
  try {
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    if (
      !hasKeyDatePermission(actor, 'keydate:view', {
        config,
        allPeople: store.people,
        teams: store.teams,
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const matter = input.matterId
      ? store.matters.find((m) => m.id === input.matterId) ?? null
      : null;
    const enquiry = input.enquiryId
      ? store.enquiries.find((e) => e.id === input.enquiryId) ?? null
      : null;

    if (
      input.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
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

    store.keyDates = store.keyDates ?? [];
    store.keyDateReminderStates = store.keyDateReminderStates ?? [];
    store.keyDateCalendarSyncs = store.keyDateCalendarSyncs ?? [];

    const kd = createOrProposeKeyDate({
      id: nextId(store, 'KD'),
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
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    store.keyDates.unshift(kd);

    if (kd.status === 'confirmed') {
      const { tasks: storeTasks } = store;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: store.keyDateReminderStates,
        matters: matter ? [matter] : [],
        people: store.people,
        audit: store.audit,
        nextAuditId: () => nextId(store, 'AU'),
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: store.firmId,
        nextTaskId: () => nextId(store, 'TSK'),
      });
    }

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs,
      nowIso,
    });

    saveStore(store);
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    const enquiry = kd.enquiryId
      ? store.enquiries.find((e) => e.id === kd.enquiryId) ?? null
      : null;

    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    proposeProvisionalKeyDate({
      keyDate: kd,
      actor,
      nowIso,
      config,
      matter,
      enquiry,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    if (kd.status === 'confirmed') {
      const { tasks: storeTasks } = store;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: store.keyDateReminderStates ?? [],
        matters: matter ? [matter] : [],
        people: store.people,
        audit: store.audit,
        nextAuditId: () => nextId(store, 'AU'),
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: store.firmId,
        nextTaskId: () => nextId(store, 'TSK'),
      });
    }

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs ?? [],
      nowIso,
    });

    saveStore(store);
    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to propose key date.',
    };
  }
}

export async function verifyProposedKeyDateRecord(
  keyDateId: string,
  byId: string,
): Promise<{ ok: boolean; keyDate?: KeyDate; error?: string }> {
  try {
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const verifier = resolveActorForKeyDates(store, byId);
    if (!verifier) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    const enquiry = kd.enquiryId
      ? store.enquiries.find((e) => e.id === kd.enquiryId) ?? null
      : null;

    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, verifier.id, verifier, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    verifyProposedKeyDate({
      keyDate: kd,
      verifier,
      nowIso,
      config,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    store.keyDateReminderStates = store.keyDateReminderStates ?? [];
    const { tasks: storeTasks } = store;
    syncReminderForConfirmedKeyDate({
      keyDate: kd,
      config,
      tasks: storeTasks,
      reminderStates: store.keyDateReminderStates,
      matters: matter ? [matter] : [],
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
      todayIso,
      nowIso,
      actorId: verifier.id,
      tenantId: store.firmId,
      nextTaskId: () => nextId(store, 'TSK'),
      transferredFromKeyDateId: kd.supersedesKeyDateId,
    });

    store.keyDateCalendarSyncs = store.keyDateCalendarSyncs ?? [];
    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs,
      nowIso,
    });

    saveStore(store);
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const verifier = resolveActorForKeyDates(store, byId);
    if (!verifier) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, verifier.id, verifier, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    rejectProposedKeyDate({
      keyDate: kd,
      verifier,
      reason,
      nowIso,
      config,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    saveStore(store);
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const existing = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!existing) return { ok: false, error: 'Key date not found.' };

    const matter = existing.matterId
      ? store.matters.find((m) => m.id === existing.matterId) ?? null
      : null;
    const enquiry = existing.enquiryId
      ? store.enquiries.find((e) => e.id === existing.enquiryId) ?? null
      : null;

    if (
      existing.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

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

    const { supersededKeyDate, replacementKeyDate } = supersedeConfirmedKeyDate({
      existingKeyDate: existing,
      newKeyDateId: nextId(store, 'KD'),
      updates,
      reason,
      actor,
      nowIso,
      config,
      matter,
      enquiry,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    store.keyDates = store.keyDates ?? [];
    store.keyDates.unshift(replacementKeyDate);
    store.keyDateReminderStates = store.keyDateReminderStates ?? [];
    store.keyDateCalendarSyncs = store.keyDateCalendarSyncs ?? [];

    // Transfer the single reminder task to the superseding key date (never create a second task)
    const { tasks: storeTasks } = store;
    syncReminderForConfirmedKeyDate({
      keyDate: replacementKeyDate,
      config,
      tasks: storeTasks,
      reminderStates: store.keyDateReminderStates,
      matters: matter ? [matter] : [],
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
      todayIso,
      nowIso,
      actorId: actor.id,
      tenantId: store.firmId,
      nextTaskId: () => nextId(store, 'TSK'),
      transferredFromKeyDateId: supersededKeyDate.id,
    });

    await syncKeyDateToOutlookCalendar({
      keyDate: supersededKeyDate,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs,
      nowIso,
    });
    await syncKeyDateToOutlookCalendar({
      keyDate: replacementKeyDate,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs,
      nowIso,
    });

    saveStore(store);
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    const enquiry = kd.enquiryId
      ? store.enquiries.find((e) => e.id === kd.enquiryId) ?? null
      : null;

    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    resolveKeyDateOutcome({
      keyDate: kd,
      kind: input.kind,
      note: input.note,
      evidenceDocumentId: input.evidenceDocumentId,
      actor,
      nowIso,
      config,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    const { tasks: storeTasks } = store;
    closeReminderTaskForKeyDate({
      keyDateId: kd.id,
      tenantId: store.firmId || getActiveTenantConfiguration().tenantId,
      tasks: storeTasks,
      reminderStates: store.keyDateReminderStates ?? [],
      nowIso,
      actorId: actor.id,
    });

    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs ?? [],
      nowIso,
    });

    saveStore(store);
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
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    const enquiry = kd.enquiryId
      ? store.enquiries.find((e) => e.id === kd.enquiryId) ?? null
      : null;
    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    const { tasks: storeTasks } = store;
    reassignKeyDateTeamAndOwners({
      keyDate: kd,
      tenantId: store.firmId || getActiveTenantConfiguration().tenantId,
      teamId: input.teamId,
      responsiblePersonIds: input.responsiblePersonIds,
      reason: input.reason,
      actor,
      nowIso,
      config,
      matter,
      tasks: storeTasks,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    store.keyDateCalendarSyncs = store.keyDateCalendarSyncs ?? [];
    await syncKeyDateToOutlookCalendar({
      keyDate: kd,
      config,
      matter,
      enquiry,
      calendarSyncs: store.keyDateCalendarSyncs,
      adapter: options?.calendarAdapter,
      nowIso,
    });

    saveStore(store);
    return { ok: true, keyDate: kd };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to reassign team diary.',
    };
  }
}

export function recordKeyDateNotApplicableRecord(
  input: {
    matterId: string;
    keyDateTypeId: string;
    reason: string;
  },
  byId: string,
): { ok: boolean; record?: KeyDateNotApplicable; error?: string } {
  try {
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    const nowIso = new Date().toISOString();

    const matter = store.matters.find((m) => m.id === input.matterId);
    if (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people)) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    store.keyDateNotApplicable = store.keyDateNotApplicable ?? [];
    const rec = recordKeyDateNotApplicable({
      matterId: matter.id,
      matterTypeId: matter.matterTypeId || matter.practiceAreaId,
      keyDateTypeId: input.keyDateTypeId,
      reason: input.reason,
      actor,
      nowIso,
      config,
      notApplicableList: store.keyDateNotApplicable,
      teams: store.teams,
      people: store.people,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    saveStore(store);
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

export function acknowledgeKeyDateReminderRecord(
  keyDateId: string,
  byId: string,
): { ok: boolean; reminderState?: KeyDateReminderState; error?: string } {
  try {
    const store = getStore();
    const config = getKeyDatesConfig(store);
    const disabledErr = assertKeyDatesModuleEnabled(config);
    if (disabledErr) return disabledErr;
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }
    if (
      !hasKeyDatePermission(actor, 'keydate:view', {
        config,
        allPeople: store.people,
        teams: store.teams,
      })
    ) {
      return {
        ok: false,
        error:
          'KEY_DATE_PERMISSION_DENIED: You need "keydate:view" permission to acknowledge key date reminders.',
      };
    }
    const nowIso = new Date().toISOString();
    const todayIso = toIsoDate(new Date());

    const kd = (store.keyDates ?? []).find((x) => x.id === keyDateId);
    if (!kd) return { ok: false, error: 'Key date not found.' };

    const matter = kd.matterId
      ? store.matters.find((m) => m.id === kd.matterId) ?? null
      : null;
    if (
      kd.matterId &&
      (!matter || !canViewerAccessMatterKeyDates(matter, actor.id, actor, store.people))
    ) {
      return { ok: false, error: 'Matter not found or restricted.' };
    }

    if (kd.status !== 'confirmed') {
      return {
        ok: false,
        error: `KEY_DATE_INVALID_STATE: Reminders can only be acknowledged for confirmed key dates (current status: "${kd.status}").`,
      };
    }

    const owningTeam = store.teams.find((t) => t.id === kd.teamId);
    const isResponsiblePerson = kd.responsiblePersonIds.includes(actor.id);
    const isOwningTeamLead = Boolean(owningTeam?.leadIds.includes(actor.id));
    if (!isResponsiblePerson && !isOwningTeamLead) {
      return {
        ok: false,
        error:
          'KEY_DATE_PERMISSION_DENIED: Only a responsible person on the key date or the owning team lead may acknowledge a reminder stage.',
      };
    }

    store.keyDateReminderStates = store.keyDateReminderStates ?? [];
    if (!store.keyDateReminderStates.some((rs) => rs.keyDateId === keyDateId)) {
      const { tasks: storeTasks } = store;
      syncReminderForConfirmedKeyDate({
        keyDate: kd,
        config,
        tasks: storeTasks,
        reminderStates: store.keyDateReminderStates,
        matters: matter ? [matter] : [],
        people: store.people,
        audit: store.audit,
        nextAuditId: () => nextId(store, 'AU'),
        todayIso,
        nowIso,
        actorId: actor.id,
        tenantId: store.firmId,
        nextTaskId: () => nextId(store, 'TSK'),
      });
    }

    const state = acknowledgeKeyDateReminderStage({
      keyDateId,
      actorId: actor.id,
      nowIso,
      reminderStates: store.keyDateReminderStates,
      audit: store.audit,
      nextAuditId: () => nextId(store, 'AU'),
    });

    saveStore(store);
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

export function runKeyDateReminderSchedulerRecord(
  options?: {
    tenantCtx?: TenantContext | null;
    session?: VerifiedEntraSessionPayload | null;
    byId: string;
    mfaVerified: boolean;
  } | null,
): {
  ok: boolean;
  result?: ReturnType<typeof runTenantKeyDateReminderJob>;
  triggeredBy?: string;
  error?: string;
} {
  if (!options || options.tenantCtx === null || (!options.tenantCtx && !options.byId)) {
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

  const store = getStore();
  const config = getKeyDatesConfig(store);

  const byId = options?.byId ?? '';
  const providedCtx = options?.tenantCtx ?? null;
  const mfaVerified = options?.mfaVerified ?? providedCtx?.mfaVerified ?? false;

  const actor = resolveActorForKeyDates(store, byId);
  if (!actor) {
    return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
  }

  if (
    !hasKeyDatePermission(actor, 'keydate:configure', {
      config,
      allPeople: store.people,
      teams: store.teams,
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

  const nowIso = new Date().toISOString();
  const verifiedSession =
    options?.session ??
    (getActiveActorSession()?.verifiedSession as
      | VerifiedEntraSessionPayload
      | undefined);
  if (verifiedSession && verifiedSession.personId !== actor.id) {
    throw new Error(
      `TENANCY_ACTOR_MISMATCH: Verified session personId "${verifiedSession.personId}" does not match requested actor "${actor.id}".`,
    );
  }
  const effectiveTenantCtx =
    providedCtx ??
    (verifiedSession
      ? resolveCurrentTenantContext(
          createVerifiedSessionActorFromEntraSession(verifiedSession),
        )
      : null);
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

  const todayIso = toIsoDate(new Date());
  store.keyDates = store.keyDates ?? [];
  store.keyDateReminderStates = store.keyDateReminderStates ?? [];

  const { tasks: storeTasks, matters: storeMatters } = store;
  const result = runTenantBackgroundJob(
    {
      jobId: `keydate-reminder-scheduler:${effectiveTenantCtx!.tenantId}:${todayIso}`,
      tenantId: effectiveTenantCtx!.tenantId,
      correlationId: effectiveTenantCtx!.correlationId,
      payload: { todayIso, nowIso },
    },
    (job) =>
      runTenantKeyDateReminderJob({
        tenantId: job.tenantId,
        todayIso: job.payload.todayIso,
        nowIso: job.payload.nowIso,
        config,
        keyDates: store.keyDates!,
        reminderStates: store.keyDateReminderStates!,
        tasks: storeTasks,
        matters: storeMatters,
        teams: store.teams,
        people: store.people,
        notifications: store.notifications,
        audit: store.audit,
        nextTaskId: () => nextId(store, 'TSK'),
        nextNotificationId: () => nextId(store, 'NTF'),
        nextAuditId: () => nextId(store, 'AU'),
      }),
  );

  saveStore(store);
  return { ok: true, result, triggeredBy: actor.id };
}

export function queryKeyDatesTeamDiaryRecord(
  query: TeamDiaryQuery,
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): TeamDiaryEntry[] {
  const store = getStore();
  const config = getKeyDatesConfig(store);
  const viewer = resolveActorForKeyDates(store, byId);
  if (!viewer) return [];
  const visibleMatters = store.matters.filter((m) =>
    canPersonAccessMatter(m, viewer.id, viewer, {
      allPeople: store.people,
      teams: store.teams,
    }),
  );
  return queryTeamDiaryEntries({
    viewer,
    query,
    todayIso,
    config,
    keyDates: store.keyDates ?? [],
    reminderStates: store.keyDateReminderStates ?? [],
    matters: visibleMatters,
    enquiries: store.enquiries,
    teams: store.teams,
    people: store.people,
  });
}

export function getKeyDateExceptionsReportRecord(
  filter: { teamIds?: string[]; kinds?: KeyDateExceptionKind[] } = {},
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): KeyDateException[] {
  const store = getStore();
  const config = getKeyDatesConfig(store);
  const viewer = resolveActorForKeyDates(store, byId);
  if (!viewer) return [];
  const visibleMatters = store.matters.filter((m) =>
    canPersonAccessMatter(m, viewer.id, viewer, {
      allPeople: store.people,
      teams: store.teams,
    }),
  );
  return computeKeyDateExceptions({
    viewer,
    todayIso,
    nowIso: new Date().toISOString(),
    config,
    keyDates: store.keyDates ?? [],
    notApplicable: store.keyDateNotApplicable ?? [],
    reminderStates: store.keyDateReminderStates ?? [],
    calendarSyncs: store.keyDateCalendarSyncs ?? [],
    matters: visibleMatters,
    teams: store.teams,
    people: store.people,
    values: store.values,
    filterTeamIds: filter.teamIds,
    filterKinds: filter.kinds,
  });
}

export function exportKeyDateExceptionsReportRecord(
  filter: {
    teamIds?: string[];
    kinds?: KeyDateExceptionKind[];
    format?: 'csv' | 'json';
  } = {},
  byId: string,
  todayIso: string = toIsoDate(new Date()),
): { ok: boolean; content?: string; filename?: string; count?: number; error?: string } {
  const store = getStore();
  const config = getKeyDatesConfig(store);
  const viewer = resolveActorForKeyDates(store, byId);
  if (!viewer) {
    return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
  }

  if (
    !hasKeyDatePermission(viewer, 'keydate:view_any_team', {
      config,
      allPeople: store.people,
      teams: store.teams,
    })
  ) {
    return {
      ok: false,
      error: 'You need "keydate:view_any_team" to view or export compliance exceptions.',
    };
  }

  const exceptions = getKeyDateExceptionsReportRecord(filter, byId, todayIso);
  const format = filter.format ?? 'csv';
  const nowIso = new Date().toISOString();

  // Audit the compliance exceptions export (§6, R41: action is 'keydate-export')
  store.audit.unshift({
    id: nextId(store, 'AU'),
    recordType: 'key_date',
    recordId: 'KEY-DATE-EXCEPTIONS-EXPORT',
    action: 'keydate-export',
    field: 'Compliance exceptions export',
    oldValue: null,
    newValue: `Exported ${exceptions.length} exception(s) as ${format.toUpperCase()}`,
    byId: viewer.id,
    at: nowIso,
    reason: `Filter teams=${filter.teamIds?.join(',') || 'all'} kinds=${filter.kinds?.join(',') || 'all'}`,
  });
  saveStore(store);

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

export function saveKeyDatesConfigRecord(
  newConfigInput: KeyDatesConfig,
  reason: string,
  byId: string,
  options?: { mfaVerified?: boolean } | boolean,
): { ok: boolean; config?: KeyDatesConfig; error?: string } {
  try {
    const store = getStore();
    const currentConfig = getKeyDatesConfig(store);
    const actor = resolveActorForKeyDates(store, byId);
    if (!actor) {
      return { ok: false, error: `Unknown or unauthenticated user "${byId}".` };
    }

    if (
      !hasKeyDatePermission(actor, 'keydate:configure', {
        config: currentConfig,
        allPeople: store.people,
        teams: store.teams,
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

    store.keyDatesConfigOverride = validated;
    store.audit.unshift({
      id: nextId(store, 'AU'),
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
    });

    saveStore(store);
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






