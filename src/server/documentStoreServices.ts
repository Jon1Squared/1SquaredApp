/**
 * Host Server Services for External Document Store Integration (`src/server/documentStoreServices.ts`).
 *
 * Bridges the Next.js host with `@platform/core` Document Store domain,
 * SharePoint provider, two-identity token service, folder template engine, lifecycle jobs, and
 * permission drift reconciliation.
 *
 * Persists all locations, folder scopes, lifecycle jobs, reconciliation findings, audit events,
 * and tenant configuration overrides solely in per-tenant PostgreSQL (`TenantDocumentStoreRepository`, `R405`).
 */

import { randomUUID } from 'node:crypto';
import {
  ALL_PERMISSION_KEYS,
  canActorAccessMatterRecord,
  DocumentStoreProviderRegistry,
  TenantDocumentStoreRepository,
  applyTemplateAdditionsToOpenMattersJob,
  buildDocumentStoreAuditEvent,
  closeMatterFolderJob,
  compileDepartmentFolderPermissions,
  compileMatterFolderPermissions,
  compileTeamFolderPermissions,
  computeAdditiveTemplateDiff,
  computeTenantLibraryScaleStatuses,
  executeUserMatterDocumentOperation,
  linkExistingMatterFolderJob,
  loadAndValidateTenantConfig,
  normaliseDocumentStoreError,
  parseSharePointLocationUrl,
  provisionMatterDocumentsJob,
  recalculateMatterPermissionsJob,
  reconcileDocumentStorePermissionsJob,
  remediateReconciliationFinding,
  reopenMatterFolderJob,
  resolveMatterDocumentRoute,
  resolveMatterFolderTemplate,
  validateDocumentConfigAgainstTenantData,
  validateMatterFolderTemplatesConfig,
  type DepartmentChangeStrategy,
  type DocumentAccessConfig,
  type DocumentConflictBehavior,
  type DocumentEffectiveAccess,
  type DocumentLifecycleDependencies,
  type DocumentLifecycleJobRecord,
  type DocumentLocationResolutionResult,
  type DocumentReconciliationFindingRecord,
  type DocumentRoutingRule,
  type DocumentStoreAuditEventRecord,
  type DocumentStoreConfig,
  type DocumentStoreConnectionTestResult,
  type DocumentStoreErrorCode,
  type DocumentStoreItem,
  type DocumentStoreListPage,
  type LibraryScopeScaleStatus,
  type MatterDocumentLocationRecord,
  type MatterFolderTemplatesConfig,
  type MatterRoutingSubject,
  type PermissionKey,
  type ProvisioningAccessContext,
  type ResolvedMatterFolderTemplate,
  type TenantConfiguration,
  type TenantContext,
  type UserAccessContext,
} from '@platform/core';
import { toMatterAccessSubject } from '@/domain/documentGeneration';
import { resolveEmployeeRoles } from '@/domain/homeConfig';
import { personDisplayName } from '@/domain/names';
import {
  getActiveActorSession,
  resolvePersonPermissions,
} from './rbacRuntime';
import type { Matter, Organisation, Person } from '@/domain/types';
import {
  createVerifiedTenantContext,
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  getMatterRepository,
  getPartyRepository,
  isNonLiveDemoEnvironment,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import {
  createVerifiedSessionActorFromEntraSession,
  type VerifiedEntraSessionPayload,
} from './entraAuth';
import { type FirmStore, getStore } from './store';

declare global {
  var __oneSquaredDocStoreRegistry: DocumentStoreProviderRegistry | undefined;
  var __oneSquaredDocStoreRepo: TenantDocumentStoreRepository | undefined;
}

export function getRegistrySingleton(): DocumentStoreProviderRegistry {
  if (!globalThis.__oneSquaredDocStoreRegistry) {
    globalThis.__oneSquaredDocStoreRegistry =
      new DocumentStoreProviderRegistry();
  }
  return globalThis.__oneSquaredDocStoreRegistry;
}

export function getRepositorySingleton(): TenantDocumentStoreRepository {
  if (!globalThis.__oneSquaredDocStoreRepo) {
    globalThis.__oneSquaredDocStoreRepo = new TenantDocumentStoreRepository();
  }
  return globalThis.__oneSquaredDocStoreRepo;
}

export function resetDocumentStoreSingletonsForTesting(): void {
  globalThis.__oneSquaredDocStoreRegistry = undefined;
  globalThis.__oneSquaredDocStoreRepo = undefined;
}

export async function loadActiveDocumentTenantConfig(
  ctx: TenantContext,
  repo: TenantDocumentStoreRepository = getRepositorySingleton(),
): Promise<TenantConfiguration> {
  const activeConfig = getActiveTenantConfiguration();
  const override = (await repo.getDocumentStoreTenantConfig(ctx)) ?? {};

  const hasOverride =
    override.documentStores !== undefined ||
    override.documentRouting !== undefined ||
    override.matterFolderNameTemplate !== undefined ||
    override.documentAccess !== undefined ||
    override.matterFolderTemplates !== undefined;
  if (!hasOverride) {
    return activeConfig;
  }

  const rawBase = getActiveTenantRawBaseConfig();
  const overlay: Record<string, unknown> = {};
  if (override.documentStores) {
    overlay.documentStores = override.documentStores;
  }
  if (override.documentRouting) {
    overlay.documentRouting = override.documentRouting;
  }
  if (override.matterFolderNameTemplate) {
    overlay.matterFolderNameTemplate = override.matterFolderNameTemplate;
  }
  if (override.documentAccess) {
    overlay.documentAccess = override.documentAccess;
  }
  if (override.matterFolderTemplates) {
    overlay.matterFolderTemplates = override.matterFolderTemplates;
  }

  const validated = loadAndValidateTenantConfig(
    rawBase,
    overlay,
    activeConfig.environment,
    activeConfig.hostingMode,
  );
  return {
    ...activeConfig,
    documentStores: validated.documentStores,
    documentRouting: validated.documentRouting,
    matterFolderNameTemplate: validated.matterFolderNameTemplate,
    documentAccess: validated.documentAccess,
    matterFolderTemplates: validated.matterFolderTemplates,
  };
}

/**
 * Resolves the department and team for a person from their employment record or configured orgStructure.
 */
export function resolvePersonOrgAssignment(
  person: Person,
  store: FirmStore = getStore(),
): { departmentId: string; teamId: string } {
  const matchedDept = store.orgStructure.departments.find(
    (d) =>
      d.id === person.employment?.departmentId ||
      d.id === person.departmentId ||
      (Boolean(person.departmentId) &&
        d.legacyChoiceValueId === person.departmentId),
  );
  const deptId = person.employment?.departmentId || matchedDept?.id || '';
  const explicitTeamId = person.employment?.teamOrPracticeGroupId ?? '';
  return { departmentId: deptId, teamId: explicitTeamId };
}

/**
 * Resolves the Entra Object ID (`oid`) and UPN for an employee record.
 */
export function resolvePersonEntraIdentity(person: Person): {
  entraObjectId: string | undefined;
  upn: string;
} {
  const primaryEmail = (
    person.emails?.find((e) => e.isPrimary)?.address ||
    person.emails?.[0]?.address ||
    ''
  ).trim();

  if (person.tags?.includes('no-entra-id') || person.entraObjectId === '') {
    return {
      entraObjectId: undefined,
      upn: primaryEmail,
    };
  }

  return {
    entraObjectId: person.entraObjectId?.trim() || undefined,
    upn: primaryEmail,
  };
}

export interface BuildTenantContextOptions {
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}

export async function buildTenantContextForUser(
  userId: string,
  store: FirmStore = getStore(),
  config: TenantConfiguration = getActiveTenantConfiguration(),
  options?: BuildTenantContextOptions,
): Promise<{
  ctx: TenantContext;
  user: Person;
  grantedPermissions: PermissionKey[];
  people: Person[];
  organisations: Organisation[];
}> {
  const trimmedId = (userId ?? '').trim();
  if (!trimmedId) {
    const err = new Error(
      `UNAUTHENTICATED: Authenticated employee "${trimmedId}" was not found.`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }

  const verifiedSession =
    options?.session ??
    (getActiveActorSession()?.verifiedSession as
      | VerifiedEntraSessionPayload
      | undefined);

  const prelimCtx = verifiedSession
    ? resolveCurrentTenantContext(
        createVerifiedSessionActorFromEntraSession(verifiedSession, {
          correlationId: options?.correlationId ?? `corr-${randomUUID()}`,
        }),
        config,
      )
    : createVerifiedTenantContext(
        {
          sub: trimmedId,
          tenantId: config.tenantId,
          roles: ['fee-earner'],
          mfaVerified: false,
        },
        config,
      );

  const partyRepo = getPartyRepository();
  const [people, organisations] = await Promise.all([
    partyRepo.listAllPeople<Person>(prelimCtx),
    partyRepo.listAllOrganisations<Organisation>(prelimCtx),
  ]);

  const user = people.find(
    (p) => p.id === trimmedId && p.isEmployee && !p.mergedIntoId,
  );
  if (!user) {
    const err = new Error(
      `UNAUTHENTICATED: Authenticated employee "${trimmedId}" was not found.`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }

  const roles = resolveEmployeeRoles(user, store.teams);
  const resolvedPerms = resolvePersonPermissions(user, {
    allPeople: people,
    teams: store.teams,
  });

  const grantedPermissions: PermissionKey[] =
    user.appRole === 'admin' || roles.includes('admin')
      ? [...ALL_PERMISSION_KEYS]
      : resolvedPerms;

  if (!verifiedSession) {
    const err = new Error(
      `UNAUTHENTICATED: Verified Entra ID session is required for employee "${user.id}".`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }
  if (verifiedSession.personId !== user.id) {
    const err = new Error(
      `TENANCY_ACTOR_MISMATCH: Verified session personId "${verifiedSession.personId}" does not match requested employee "${user.id}".`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'access_denied';
    throw err;
  }

  const effectiveCtx =
    options?.mfaVerified === false
      ? Object.freeze({ ...prelimCtx, mfaVerified: false })
      : prelimCtx;

  return {
    ctx: effectiveCtx,
    user,
    grantedPermissions,
    people,
    organisations,
  };
}

/**
 * Maps a `Matter` in `FirmStore` to its canonical `MatterRoutingSubject`.
 * Resolves department and team strictly from `matter.owningDepartmentId` and `matter.owningTeamId`
 * against the tenant's configured `orgStructure` without guessing or falling back.
 */
export function buildMatterRoutingSubject(
  matter: Matter,
  store: FirmStore = getStore(),
  people: readonly Person[] = [],
  organisations: readonly Organisation[] = [],
): MatterRoutingSubject {
  const orgDept = matter.owningDepartmentId
    ? store.orgStructure.departments.find(
        (d) =>
          d.id === matter.owningDepartmentId ||
          d.legacyChoiceValueId === matter.owningDepartmentId,
      )
    : undefined;

  const departmentId = orgDept?.id ?? '';
  const departmentCode = orgDept?.code ?? '';

  const orgTeam =
    matter.owningTeamId && departmentId
      ? store.orgStructure.teamsOrPracticeGroups.find(
          (t) =>
            t.id === matter.owningTeamId &&
            t.parentDepartmentId === departmentId,
        )
      : undefined;

  const teamId = orgTeam?.id ?? '';
  const teamCode = orgTeam?.code ?? '';

  const owningTeamMemberIds = people
    .filter((p) => {
      if (!p.isEmployee) return false;
      const assign = resolvePersonOrgAssignment(p, store);
      return (
        (Boolean(teamId) && assign.teamId === teamId) ||
        (Boolean(departmentId) && assign.departmentId === departmentId)
      );
    })
    .map((p) => p.id);

  const matterTeamMemberIds = Array.from(
    new Set(
      [
        matter.responsiblePartnerId,
        matter.supervisingPartnerId,
        matter.leadFeeEarnerId,
        ...(matter.teamMemberIds ?? []),
      ].filter((id): id is string => Boolean(id)),
    ),
  );

  const clientOrg = organisations.find((o) => o.id === matter.clientId);
  const clientNumber =
    clientOrg?.clientReference || matter.clientId || 'CLI-001';

  const statusLower = (matter.matterStatusId || '').toLowerCase();
  const isClosed =
    statusLower.includes('closed') ||
    statusLower.includes('completed') ||
    statusLower.includes('archived') ||
    Boolean(matter.closedAt);

  return {
    matterId: matter.id,
    matterNumber: matter.matterNumber || matter.id,
    clientNumber,
    matterDescription: matter.title || matter.shortDescription || 'Matter',
    departmentId,
    departmentCode,
    teamId,
    teamCode,
    workTypeId: matter.workTypeSubcategoryId || matter.practiceAreaId,
    practiceAreaId: matter.practiceAreaId,
    workTypeCode: matter.typeBadge || 'MAT',
    isRestricted: Boolean(matter.isStaffMatter || matter.hasEthicalWall),
    restrictedAccessUserIds: matter.restrictedAccessUserIds ?? [],
    owningTeamMemberIds,
    matterTeamMemberIds,
    isClosed,
  };
}

let customBeforeMatterDocumentsCloseHook:
  | DocumentLifecycleDependencies['onBeforeMatterDocumentsClose']
  | undefined;

export function setBeforeMatterDocumentsCloseHookForTesting(
  hook:
    | DocumentLifecycleDependencies['onBeforeMatterDocumentsClose']
    | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY_ERROR: setBeforeMatterDocumentsCloseHookForTesting is only permitted in test environments.',
    );
  }
  customBeforeMatterDocumentsCloseHook = hook;
}

export function buildLifecycleDependencies(
  ctx: TenantContext,
  store: FirmStore = getStore(),
  config: TenantConfiguration = getActiveTenantConfiguration(),
  people: readonly Person[] = [],
): DocumentLifecycleDependencies {
  const repo = getRepositorySingleton();
  const registry = getRegistrySingleton();

  const protectedContainerPaths = new Set<string>();
  const addProtectedPathAndPrefixes = (rawPath: string) => {
    const cleaned = rawPath.trim().replace(/^\/+|\/+$/g, '');
    if (!cleaned) return;
    const segments = cleaned.split('/').filter(Boolean);
    let prefix = '';
    for (const seg of segments) {
      if (seg.includes('{')) break;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      protectedContainerPaths.add(prefix);
    }
  };

  for (const rule of config.documentRouting ?? []) {
    if (rule.basePath) {
      addProtectedPathAndPrefixes(rule.basePath);
    }
  }

  for (const dept of store.orgStructure.departments ?? []) {
    if (dept.code) protectedContainerPaths.add(dept.code);
    if (dept.id) protectedContainerPaths.add(dept.id);
    for (const rule of config.documentRouting ?? []) {
      if (rule.basePath) {
        const renderedDept = rule.basePath
          .replace(/\{departmentCode\}/g, dept.code || '')
          .replace(/\{departmentId\}/g, dept.id || '');
        addProtectedPathAndPrefixes(renderedDept);
      }
    }
    for (const team of store.orgStructure.teamsOrPracticeGroups ?? []) {
      if (team.parentDepartmentId === dept.id) {
        if (dept.code && team.code) {
          protectedContainerPaths.add(`${dept.code}/${team.code}`);
        }
        if (dept.id && team.id) {
          protectedContainerPaths.add(`${dept.id}/${team.id}`);
        }
        for (const rule of config.documentRouting ?? []) {
          if (rule.basePath) {
            const renderedTeam = rule.basePath
              .replace(/\{departmentCode\}/g, dept.code || '')
              .replace(/\{departmentId\}/g, dept.id || '')
              .replace(/\{teamCode\}/g, team.code || '')
              .replace(/\{teamId\}/g, team.id || '');
            addProtectedPathAndPrefixes(renderedTeam);
          }
        }
      }
    }
  }

  return {
    repository: repo,
    getProvider: (storeId: string) => {
      const storeCfg = (config.documentStores ?? []).find(
        (s) => s.storeId === storeId,
      );
      if (!storeCfg) {
        throw new Error(`Document store "${storeId}" is not configured.`);
      }
      return registry.createProvider(ctx, storeCfg);
    },
    stores: config.documentStores ?? [],
    routingRules: config.documentRouting ?? [],
    accessConfig: config.documentAccess ?? {
      departmentEntraGroups: {},
      teamEntraGroups: {},
    },
    templatesConfig: config.matterFolderTemplates ?? {
      default: {
        templateId: 'tpl-default',
        version: 1,
        mode: 'replaces',
        nodes: [{ name: '01 Correspondence' }],
      },
    },
    matterFolderNameTemplate:
      config.matterFolderNameTemplate ??
      '{matterNumber} - {matterDescription}',
    protectedContainerPaths: Array.from(protectedContainerPaths),
    onBeforeMatterDocumentsClose: customBeforeMatterDocumentsCloseHook,
    resolveUserEntraObjectId: (_c: TenantContext, userId: string) => {
      const p = people.find((person) => person.id === userId);
      if (!p) return null;
      const info = resolvePersonEntraIdentity(p);
      if (!info.entraObjectId || !info.upn) return null;
      return {
        entraObjectId: info.entraObjectId,
        upn: info.upn,
        displayName: personDisplayName(p),
      };
    },
  };
}

function createAccessDeniedError(
  message: string,
): Error & { code: DocumentStoreErrorCode } {
  const err = new Error(message) as Error & { code: DocumentStoreErrorCode };
  err.code = 'access_denied';
  return err;
}

function assertAdminPermissionAndMfa(
  ctx: TenantContext,
  grantedPermissions: readonly string[],
  requiredAnyOf: readonly PermissionKey[],
): void {
  const permSet = new Set(grantedPermissions);
  const hasPermission = requiredAnyOf.some((p) => permSet.has(p));
  if (!hasPermission) {
    if (!ctx.mfaVerified) {
      throw createAccessDeniedError(
        `MFA_REQUIRED: Multi-factor authentication and ${requiredAnyOf.join(' or ')} permission are required for document store administration.`,
      );
    }
    throw createAccessDeniedError(
      `PERMISSION_DENIED: Requires ${requiredAnyOf.join(' or ')} permission.`,
    );
  }
  if (!ctx.mfaVerified) {
    throw createAccessDeniedError(
      'MFA_REQUIRED: Multi-factor authentication is required for document store administration.',
    );
  }
}

function createMatterTreeItemVerifier(
  provider: ReturnType<DocumentLifecycleDependencies['getProvider']>,
) {
  return async (
    userCtx: UserAccessContext,
    itemId: string,
    location: MatterDocumentLocationRecord,
  ): Promise<boolean> => {
    if (!itemId) return false;
    const allowedFolderIds = new Set<string>([
      location.providerFolderItemId,
      ...Object.values(location.folderItemMap ?? {}),
    ]);
    if (allowedFolderIds.has(itemId)) {
      return true;
    }

    let currentId: string | null | undefined = itemId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 25 && currentId; depth++) {
      if (allowedFolderIds.has(currentId)) {
        return true;
      }
      if (currentId === 'root' || visited.has(currentId)) {
        return false;
      }
      visited.add(currentId);
      const item = await provider.getItem(userCtx, {
        storeId: location.storeId,
        siteId: location.providerSiteId,
        driveId: location.providerDriveId,
        itemId: currentId,
      });
      if (allowedFolderIds.has(item.itemId)) {
        return true;
      }
      if (item.parentItemId && allowedFolderIds.has(item.parentItemId)) {
        return true;
      }
      currentId = item.parentItemId;
    }
    return false;
  };
}

/**
 * Seeds sample files into a newly provisioned matter folder in the mocked SharePoint store
 * only when Demo Mode (`featureFlags.enableDemoMode`) is explicitly enabled in a non-live environment (R20).
 */
async function seedSampleDocumentsForMatterLocation(
  ctx: TenantContext,
  deps: DocumentLifecycleDependencies,
  matter: Matter,
  location: MatterDocumentLocationRecord,
  config: TenantConfiguration,
): Promise<void> {
  if (location.provisioningStatus !== 'provisioned') return;
  if (!isNonLiveDemoEnvironment(config)) {
    return;
  }

  const provider = deps.getProvider(location.storeId);
  const clientCareFolderId =
    location.folderItemMap['01 Client Care'] ?? location.providerFolderItemId;
  const correspondenceFolderId =
    location.folderItemMap['02 Correspondence'] ??
    location.providerFolderItemId;
  const draftsFolderId =
    location.folderItemMap['03 Drafts'] ?? location.providerFolderItemId;

  const provCtx: ProvisioningAccessContext = {
    kind: 'provisioning',
    tenantContext: {
      ...ctx,
      actorGroups: [],
    },
    triggerEvent: 'matter.documents.demo_seed',
  };

  try {
    const existing = await provider.listItems(provCtx, {
      storeId: location.storeId,
      libraryId: location.libraryId,
      siteId: location.providerSiteId,
      driveId: location.providerDriveId,
      folderItemId: clientCareFolderId,
    });
    if (existing.items.some((i) => i.itemType === 'file')) {
      return;
    }

    const seedFile = async (
      folderItemId: string,
      fileName: string,
      text: string,
      mimeType: string,
    ) => {
      const folderListing = await provider.listItems(provCtx, {
        storeId: location.storeId,
        libraryId: location.libraryId,
        siteId: location.providerSiteId,
        driveId: location.providerDriveId,
        folderItemId,
      });
      if (folderListing.items.some((item) => item.name === fileName)) {
        return;
      }
      const bytes = new TextEncoder().encode(text);
      const uploaded = await provider.uploadContent(
        provCtx,
        {
          storeId: location.storeId,
          libraryId: location.libraryId,
          siteId: location.providerSiteId,
          driveId: location.providerDriveId,
          folderItemId,
        },
        fileName,
        bytes,
        bytes.byteLength,
        {
          conflictBehavior: 'replace',
          mimeType,
        },
      );
      await deps.repository.appendAuditEvent(
        ctx,
        buildDocumentStoreAuditEvent({
          context: ctx,
          identityUsed: 'provisioning',
          triggerEvent: 'matter.documents.demo_seed',
          action: 'document:uploaded',
          matterId: matter.id,
          storeId: location.storeId,
          libraryId: location.libraryId,
          providerItemId: uploaded.itemId,
          outcome: 'succeeded',
        }),
      );
    };

    await seedFile(
      clientCareFolderId,
      `${matter.matterNumber} - Client Care & Engagement Letter.docx`,
      `Client Care & Engagement Letter for ${matter.matterNumber} — ${matter.title}`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await seedFile(
      correspondenceFolderId,
      `${matter.matterNumber} - Initial Attendance Note.docx`,
      `Initial Client Attendance Note for ${matter.matterNumber} — ${matter.title}`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await seedFile(
      draftsFolderId,
      `${matter.matterNumber} - Working Issues List.xlsx`,
      `Working Issues List & Draft Schedule for ${matter.matterNumber}`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  } catch {
    // Non-fatal if seeding sample files is skipped
  }
}

/**
 * Ensures a matter has been provisioned in its routed document store, returning its locations.
 */
export async function ensureMatterDocumentStoreProvisioned(
  matterId: string,
  userId: string,
  options?: BuildTenantContextOptions,
): Promise<{
  locations: MatterDocumentLocationRecord[];
  jobs: DocumentLifecycleJobRecord[];
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, people, organisations } = await buildTenantContextForUser(
    userId,
    store,
    baseCfg,
    options,
  );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);

  const matter = await getMatterRepository().getMatterById<Matter>(ctx, matterId);
  if (!matter) {
    throw new Error(`Matter "${matterId}" not found.`);
  }

  let existing = await deps.repository.listMatterLocationsByMatterId(
    ctx,
    matterId,
  );

  const subject = buildMatterRoutingSubject(matter, store, people, organisations);
  if (existing.length === 0) {
    const provisioned = await provisionMatterDocumentsJob({
      ctx,
      deps,
      subject,
      triggerEvent: 'matter.documents.auto_provision',
    });
    await seedSampleDocumentsForMatterLocation(
      ctx,
      deps,
      matter,
      provisioned.location,
      config,
    );
    existing = await deps.repository.listMatterLocationsByMatterId(
      ctx,
      matterId,
    );
  } else {
    for (const loc of existing) {
      if (loc.provisioningStatus === 'provisioned') {
        try {
          const provider = deps.getProvider(loc.storeId);
          const provCtx: ProvisioningAccessContext = {
            kind: 'provisioning',
            tenantContext: ctx,
            triggerEvent: 'matter.hydrate_check',
          };
          await provider.getItem(provCtx, {
            storeId: loc.storeId,
            siteId: loc.providerSiteId,
            driveId: loc.providerDriveId,
            itemId: loc.providerFolderItemId,
          });
        } catch {
          const reprovisioned = await provisionMatterDocumentsJob({
            ctx,
            deps,
            subject,
            triggerEvent: 'matter.documents.rehydrate',
          });
          await seedSampleDocumentsForMatterLocation(
            ctx,
            deps,
            matter,
            reprovisioned.location,
            config,
          );
          existing = await deps.repository.listMatterLocationsByMatterId(
            ctx,
            matterId,
          );
        }
      }
    }
  }

  const jobs = await deps.repository.listLifecycleJobs(ctx, matterId);
  return { locations: existing, jobs };
}

async function loadMatterByIdForAccessCheck(
  ctx: TenantContext,
  matterId: string,
): Promise<Matter | null> {
  const visible = await getMatterRepository().getMatterById<Matter>(
    ctx,
    matterId,
  );
  if (visible) return visible;
  const all = await getMatterRepository().listAllMattersUnfiltered<Matter>(ctx);
  return all.find((m) => m.id === matterId) ?? null;
}

/**
 * Retries a failed or pending matter document provisioning job idempotently.
 */
export async function retryMatterDocumentProvisioning(
  matterId: string,
  userId: string,
  options?: BuildTenantContextOptions,
): Promise<{
  location: MatterDocumentLocationRecord;
  job: DocumentLifecycleJobRecord;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people, organisations } =
    await buildTenantContextForUser(
      userId,
      store,
      baseCfg,
      options,
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);

  const matter = await loadMatterByIdForAccessCheck(ctx, matterId);
  if (!matter) {
    throw new Error(`Matter "${matterId}" not found.`);
  }

  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const permSet = new Set(grantedPermissions);
  const canRetry =
    accessCheck.canAccess &&
    (!accessCheck.isRestricted ||
      accessCheck.isOnRestrictedAllowlist ||
      permSet.has('matter:restricted:access')) &&
    (permSet.has('document:edit') || permSet.has('document_store:configure'));

  if (!canRetry) {
    await deps.repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: 'matter.documents.manual_retry',
        action: 'lifecycle:matter:provisioned',
        matterId: matter.id,
        storeId: config.documentStores?.[0]?.storeId ?? 'default',
        outcome: 'denied',
        errorCode: 'access_denied',
      }),
    );
    throw createAccessDeniedError(
      'PERMISSION_DENIED: You do not have permission to retry provisioning for this matter.',
    );
  }

  const subject = buildMatterRoutingSubject(matter, store, people, organisations);
  const res = await provisionMatterDocumentsJob({
    ctx,
    deps,
    subject,
    triggerEvent: 'matter.documents.manual_retry',
  });
  await seedSampleDocumentsForMatterLocation(
    ctx,
    deps,
    matter,
    res.location,
    config,
  );
  return res;
}

/**
 * Links an existing folder in a configured document store to a matter.
 */
export async function linkExistingMatterDocumentFolder(params: {
  matterId: string;
  storeId: string;
  libraryId: string;
  folderUrlOrPath: string;
  applyMissingTemplateFolders?: boolean;
  allowRoutingMismatchOverride?: boolean;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<{
  location: MatterDocumentLocationRecord;
  job: DocumentLifecycleJobRecord;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people, organisations } =
    await buildTenantContextForUser(
      params.userId ?? '',
      store,
      baseCfg,
      {
        session: params.session,
        mfaVerified: params.mfaVerified,
        correlationId: params.correlationId,
      },
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);

  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) {
    throw new Error(`Matter "${params.matterId}" not found.`);
  }

  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const permSet = new Set(grantedPermissions);
  const canLink =
    accessCheck.canAccess &&
    (!accessCheck.isRestricted ||
      accessCheck.isOnRestrictedAllowlist ||
      permSet.has('matter:restricted:access')) &&
    permSet.has('document_store:configure') &&
    ctx.mfaVerified;

  if (!canLink) {
    await deps.repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: 'matter.folder.linked',
        action: 'lifecycle:matter:linked',
        matterId: matter.id,
        storeId: params.storeId,
        libraryId: params.libraryId,
        outcome: 'denied',
        errorCode: 'access_denied',
      }),
    );
    throw createAccessDeniedError(
      'PERMISSION_DENIED: You do not have permission to link a document store folder to this matter.',
    );
  }

  const subject = buildMatterRoutingSubject(matter, store, people, organisations);
  return linkExistingMatterFolderJob({
    ctx,
    deps,
    subject,
    storeId: params.storeId,
    libraryId: params.libraryId,
    folderUrlOrPath: params.folderUrlOrPath,
    applyMissingTemplateFolders: params.applyMissingTemplateFolders ?? true,
    allowRoutingMismatchOverride: Boolean(
      params.allowRoutingMismatchOverride &&
        permSet.has('document_store:configure') &&
        ctx.mfaVerified,
    ),
  });
}

/**
 * Synchronises matter lifecycle changes (team, restriction, department, closure, reopening)
 * to its linked document store folders.
 */
export async function syncMatterLifecycleToDocumentStore(params: {
  matterId: string;
  event: 'updated' | 'closed' | 'reopened';
  departmentChangeStrategy?: DepartmentChangeStrategy;
  userId: string;
}): Promise<{
  locations: MatterDocumentLocationRecord[];
  jobs: DocumentLifecycleJobRecord[];
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, people, organisations } = await buildTenantContextForUser(
    params.userId,
    store,
    baseCfg,
  );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);

  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) {
    return { locations: [], jobs: [] };
  }

  const subject = buildMatterRoutingSubject(matter, store, people, organisations);
  if (params.event === 'closed') {
    return closeMatterFolderJob({ ctx, deps, subject });
  }
  if (params.event === 'reopened') {
    return reopenMatterFolderJob({ ctx, deps, subject });
  }
  return recalculateMatterPermissionsJob({
    ctx,
    deps,
    subject,
    departmentChangeStrategy:
      params.departmentChangeStrategy ?? 'repermission_in_place',
  });
}

const pendingLifecycleSyncPromises = new Set<Promise<void>>();

export async function flushDocumentLifecycleSyncForTesting(): Promise<void> {
  while (pendingLifecycleSyncPromises.size > 0) {
    const batch = Array.from(pendingLifecycleSyncPromises);
    await Promise.allSettled(batch);
  }
}

/**
 * Updates document store location records and applies permission changes through `DocumentStoreProvider.setPermissions`
 * via the canonical lifecycle jobs (`closeMatterFolderJob`, `reopenMatterFolderJob`, `recalculateMatterPermissionsJob`,
 * all executed through `runTenantBackgroundJob`).
 * Fails closed synchronously with `UNAUTHENTICATED` if `userId` is missing or unknown; logs and records failed jobs &
 * reconciliation findings on provider failure without writing premature `succeeded` records.
 */
export function syncMatterLifecycleOnSaveSync(params: {
  matter: Matter;
  previousMatter?: Matter | null;
  departmentChangeStrategy?: DepartmentChangeStrategy;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  correlationId?: string;
  store?: FirmStore;
}): Promise<void> {
  const trimmedUserId = (params.userId ?? '').trim();
  if (!trimmedUserId) {
    const err = new Error(
      `UNAUTHENTICATED: Authenticated employee "${trimmedUserId}" was not found.`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }
  const verifiedSession =
    params.session ??
    (getActiveActorSession()?.verifiedSession as
      | VerifiedEntraSessionPayload
      | undefined);
  if (!verifiedSession) {
    const err = new Error(
      `UNAUTHENTICATED: Verified Entra ID session is required for employee "${trimmedUserId}".`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'reauthentication_required';
    throw err;
  }

  const store = params.store ?? getStore();
  const baseCfg = getActiveTenantConfiguration();

  const runPromise = (async () => {
    const { ctx, people, organisations } = await buildTenantContextForUser(
      trimmedUserId,
      store,
      baseCfg,
      {
        session: params.session,
        correlationId: params.correlationId,
      },
    );
    const repo = getRepositorySingleton();
    const config = await loadActiveDocumentTenantConfig(ctx, repo);
    const deps = buildLifecycleDependencies(ctx, store, config, people);
    const existingLocs = await deps.repository.listMatterLocationsByMatterId(
      ctx,
      params.matter.id,
    );
    if (existingLocs.length === 0) {
      return;
    }

    const jobIdsBefore = new Set(
      (await deps.repository.listLifecycleJobs(ctx, params.matter.id)).map(
        (j) => j.id,
      ),
    );
    let event: 'updated' | 'closed' | 'reopened' = 'updated';
    try {
      const subject = buildMatterRoutingSubject(
        params.matter,
        store,
        people,
        organisations,
      );
      const prevClosed = params.previousMatter
        ? buildMatterRoutingSubject(
            params.previousMatter,
            store,
            people,
            organisations,
          ).isClosed
        : false;
      event =
        !prevClosed && subject.isClosed
          ? 'closed'
          : prevClosed && !subject.isClosed
            ? 'reopened'
            : 'updated';

      if (event === 'closed') {
        await closeMatterFolderJob({ ctx, deps, subject });
      } else if (event === 'reopened') {
        await reopenMatterFolderJob({ ctx, deps, subject });
      } else {
        await recalculateMatterPermissionsJob({
          ctx,
          deps,
          subject,
          departmentChangeStrategy:
            params.departmentChangeStrategy ?? 'repermission_in_place',
        });
      }
    } catch (err) {
      const normalised = normaliseDocumentStoreError(err);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'document_store.lifecycle_sync_failed',
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          code: normalised.code,
        }),
      );
      const jobsAfter = await deps.repository.listLifecycleJobs(
        ctx,
        params.matter.id,
      );
      const hasNewFailedJob = jobsAfter.some(
        (j) => !jobIdsBefore.has(j.id) && j.status === 'failed',
      );
      if (!hasNewFailedJob) {
        const nowIso = new Date().toISOString();
        const jobType =
          event === 'closed'
            ? 'close_matter_folder'
            : event === 'reopened'
              ? 'reopen_matter_folder'
              : 'recalculate_permissions';
        await deps.repository.putLifecycleJob(ctx, {
          id: `job-lifecycle-fail-${randomUUID()}`,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          storeId: existingLocs[0]?.storeId ?? 'default',
          matterId: params.matter.id,
          jobType,
          status: 'failed',
          attemptCount: 1,
          maxAttempts: 3,
          triggeredByUserId: ctx.actorId ?? null,
          triggerEvent: `matter.lifecycle.${event}`,
          payload: { event },
          result: null,
          lastErrorCode: normalised.code,
          lastErrorMessage: normalised.code,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
  })();

  pendingLifecycleSyncPromises.add(runPromise);
  void runPromise
    .finally(() => {
      pendingLifecycleSyncPromises.delete(runPromise);
    })
    .catch(() => {});
  return runPromise;
}

function checkMatterAccessForActor(
  user: Person,
  matter: Matter,
  store: FirmStore,
  config: TenantConfiguration,
): {
  canAccess: boolean;
  isRestricted: boolean;
  isOnRestrictedAllowlist: boolean;
} {
  const roles = resolveEmployeeRoles(user, store.teams);
  const isRestricted = Boolean(matter.isStaffMatter || matter.hasEthicalWall);
  const allowlist = new Set(
    [
      ...(matter.restrictedAccessUserIds ?? []),
      matter.responsiblePartnerId,
      matter.supervisingPartnerId,
      matter.leadFeeEarnerId,
      ...(matter.teamMemberIds ?? []),
    ].filter((x): x is string => Boolean(x)),
  );
  const isOnRestrictedAllowlist = isRestricted && allowlist.has(user.id);
  const subject = toMatterAccessSubject(matter);

  const activeActorSession = getActiveActorSession();
  const canAccess = canActorAccessMatterRecord(
    {
      id: user.id,
      tenantId: config.tenantId,
      roles,
      tokenRoles:
        activeActorSession && activeActorSession.personId === user.id
          ? activeActorSession.tokenRoles
          : [],
      departmentId: user.departmentId ?? user.employment?.departmentId ?? null,
      permissionOverrides: user.permissionOverrides ?? null,
      documentPermissions: user.documentPermissions,
    },
    subject
      ? {
          ...subject,
          restrictedAccessUserIds: isRestricted
            ? Array.from(allowlist)
            : (matter.restrictedAccessUserIds ?? []),
        }
      : null,
    config,
  );

  return { canAccess, isRestricted, isOnRestrictedAllowlist };
}

/**
 * Lists items and effective access inside a matter's document store folder **as the signed-in user**
 * (using the OBO delegated identity).
 */
export async function browseMatterDocumentStoreFolder(params: {
  matterId: string;
  locationId?: string;
  folderItemId?: string;
  cursor?: string;
  pageSize?: number;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  correlationId?: string;
}): Promise<{
  requiresEntraSignIn?: boolean;
  entraSignInExplanation?: string;
  stores: DocumentStoreConfig[];
  locations: MatterDocumentLocationRecord[];
  activeLocation: MatterDocumentLocationRecord | null;
  currentFolder: DocumentStoreItem | null;
  itemsPage: DocumentStoreListPage | null;
  effectiveAccess: DocumentEffectiveAccess | null;
  isRestrictedMatter: boolean;
  isClosedMatter: boolean;
  jobs: DocumentLifecycleJobRecord[];
  errorCode?: string;
  errorMessage?: string;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people, organisations } =
    await buildTenantContextForUser(
      params.userId ?? '',
      store,
      baseCfg,
      { session: params.session, correlationId: params.correlationId },
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);

  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) {
    throw new Error(`Matter "${params.matterId}" not found.`);
  }

  // 1. Check 1Squared RBAC + matter access FIRST before any Entra check, location read, or provisioning/seeding!
  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const permSet = new Set(grantedPermissions);
  const hasViewPerm = permSet.has('document:view');
  const blockedByRestricted =
    accessCheck.isRestricted &&
    !accessCheck.isOnRestrictedAllowlist &&
    !permSet.has('matter:restricted:access');

  if (!hasViewPerm || blockedByRestricted || !accessCheck.canAccess) {
    const denyReason = !hasViewPerm
      ? 'rbac_denied'
      : blockedByRestricted
        ? 'restricted_matter_denied'
        : 'matter_access_denied';
    await deps.repository.appendAuditEvent(
      ctx,
      buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: 'user.document:listed',
        action: 'document:listed',
        matterId: matter.id,
        storeId: config.documentStores?.[0]?.storeId ?? 'default',
        libraryId:
          config.documentStores?.[0]?.sharepoint?.libraries?.[0]?.libraryId ??
          'default',
        providerItemId: params.folderItemId ?? null,
        outcome: 'denied',
        errorCode: denyReason,
      }),
    );
    return {
      stores: [],
      locations: [],
      activeLocation: null,
      currentFolder: null,
      itemsPage: null,
      effectiveAccess: null,
      isRestrictedMatter: false,
      isClosedMatter: false,
      jobs: [],
      errorCode: 'access_denied',
      errorMessage:
        'You do not have permission to view or modify this folder or document.',
    };
  }

  const subject = buildMatterRoutingSubject(matter, store, people, organisations);

  if (!ctx.entraObjectId) {
    const [existingLocs, existingJobs] = await Promise.all([
      deps.repository.listMatterLocationsByMatterId(ctx, params.matterId),
      deps.repository.listLifecycleJobs(ctx, params.matterId),
    ]);
    return {
      requiresEntraSignIn: true,
      entraSignInExplanation:
        'Document store browsing and editing require you to sign in with your firm Microsoft Entra ID account so SharePoint can enforce your individual permissions and audit trail.',
      stores: config.documentStores ?? [],
      locations: existingLocs,
      activeLocation: existingLocs[0] ?? null,
      currentFolder: null,
      itemsPage: null,
      effectiveAccess: null,
      isRestrictedMatter: subject.isRestricted,
      isClosedMatter: subject.isClosed,
      jobs: existingJobs,
    };
  }

  const { locations, jobs } = await ensureMatterDocumentStoreProvisioned(
    params.matterId,
    user.id,
    {
      session: params.session,
      correlationId: ctx.correlationId,
    },
  );

  const requestedLocation = params.locationId
    ? await deps.repository.getMatterLocationById(ctx, params.locationId)
    : undefined;

  const activeLocation =
    (params.locationId
      ? locations.find((l) => l.id === params.locationId)
      : undefined) ??
    locations.find((l) => {
      const st = (config.documentStores ?? []).find(
        (s) => s.storeId === l.storeId,
      );
      return st?.isDefault;
    }) ??
    locations[0] ??
    null;

  if (
    !params.locationId &&
    (!activeLocation || activeLocation.provisioningStatus !== 'provisioned')
  ) {
    return {
      stores: config.documentStores ?? [],
      locations,
      activeLocation,
      currentFolder: null,
      itemsPage: null,
      effectiveAccess: null,
      isRestrictedMatter: subject.isRestricted,
      isClosedMatter: subject.isClosed,
      jobs,
    };
  }

  const fallbackStoreId =
    activeLocation?.storeId ??
    requestedLocation?.storeId ??
    config.documentStores?.[0]?.storeId ??
    'default';
  const fallbackLibraryId =
    activeLocation?.libraryId ??
    requestedLocation?.libraryId ??
    config.documentStores?.[0]?.sharepoint?.libraries?.[0]?.libraryId ??
    'default';

  const targetFolderId =
    params.folderItemId || activeLocation?.providerFolderItemId || 'root';
  const provider = deps.getProvider(fallbackStoreId);

  try {
    const result = await executeUserMatterDocumentOperation(
      {
        ctx,
        requiredPermission: 'document:view',
        grantedPermissions,
        matterId: matter.id,
        canAccessMatterIn1Squared: accessCheck.canAccess,
        isRestrictedMatter: accessCheck.isRestricted,
        isUserOnRestrictedAllowlist: accessCheck.isOnRestrictedAllowlist,
        storeId: fallbackStoreId,
        libraryId: fallbackLibraryId,
        providerItemId: targetFolderId,
        locationId: params.locationId ?? activeLocation?.id,
        location: params.locationId
          ? (requestedLocation ?? null)
          : activeLocation,
        targetItemIds: [targetFolderId],
        verifyItemInMatterTree: createMatterTreeItemVerifier(provider),
        auditAction: 'document:listed',
        repository: deps.repository,
      },
      async (userCtx) => {
        const loc = activeLocation!;
        const [currentFolder, itemsPage, effectiveAccess] = await Promise.all([
          provider.getItem(userCtx, {
            storeId: loc.storeId,
            siteId: loc.providerSiteId,
            driveId: loc.providerDriveId,
            itemId: targetFolderId,
          }),
          provider.listItems(
            userCtx,
            {
              storeId: loc.storeId,
              libraryId: loc.libraryId,
              siteId: loc.providerSiteId,
              driveId: loc.providerDriveId,
              folderItemId: targetFolderId,
            },
            { pageSize: params.pageSize ?? 100, cursor: params.cursor },
          ),
          provider.getEffectiveAccess(userCtx, {
            storeId: loc.storeId,
            siteId: loc.providerSiteId,
            driveId: loc.providerDriveId,
            itemId: targetFolderId,
          }),
        ]);
        return { currentFolder, itemsPage, effectiveAccess };
      },
    );

    return {
      stores: config.documentStores ?? [],
      locations,
      activeLocation,
      currentFolder: result.currentFolder,
      itemsPage: result.itemsPage,
      effectiveAccess: result.effectiveAccess,
      isRestrictedMatter: subject.isRestricted,
      isClosedMatter: subject.isClosed,
      jobs,
    };
  } catch (err) {
    const normalised = normaliseDocumentStoreError(err);
    const isAccessDenied = normalised.code === 'access_denied';
    return {
      stores: isAccessDenied ? [] : (config.documentStores ?? []),
      locations: isAccessDenied ? [] : locations,
      activeLocation: isAccessDenied ? null : activeLocation,
      currentFolder: null,
      itemsPage: null,
      effectiveAccess: null,
      isRestrictedMatter: isAccessDenied ? false : subject.isRestricted,
      isClosedMatter: isAccessDenied ? false : subject.isClosed,
      jobs: isAccessDenied ? [] : jobs,
      errorCode: normalised.code,
      errorMessage: normalised.userMessage,
    };
  }
}

/**
 * Performs a delegated user-context file upload into a matter folder.
 */
export async function uploadMatterStoreDocument(params: {
  matterId: string;
  locationId: string;
  folderItemId: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  conflictBehavior?: DocumentConflictBehavior;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  correlationId?: string;
}): Promise<DocumentStoreItem> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people } =
    await buildTenantContextForUser(
      params.userId ?? '',
      store,
      baseCfg,
      { session: params.session, correlationId: params.correlationId },
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) throw new Error('Matter not found.');

  const loc = await deps.repository.getMatterLocationById(
    ctx,
    params.locationId,
  );
  const matterLoc =
    loc?.matterId === matter.id
      ? loc
      : ((await deps.repository.listMatterLocationsByMatterId(ctx, matter.id))[0] ??
        loc);
  const fallbackStoreId =
    matterLoc?.storeId ?? config.documentStores?.[0]?.storeId ?? 'default';
  const fallbackLibraryId =
    matterLoc?.libraryId ??
    config.documentStores?.[0]?.sharepoint?.libraries?.[0]?.libraryId ??
    'default';

  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const provider = deps.getProvider(fallbackStoreId);

  return executeUserMatterDocumentOperation(
    {
      ctx,
      requiredPermission: 'document:upload',
      grantedPermissions,
      matterId: matter.id,
      canAccessMatterIn1Squared: accessCheck.canAccess,
      isRestrictedMatter: accessCheck.isRestricted,
      isUserOnRestrictedAllowlist: accessCheck.isOnRestrictedAllowlist,
      storeId: fallbackStoreId,
      libraryId: fallbackLibraryId,
      providerItemId: params.folderItemId,
      locationId: params.locationId,
      location: loc ?? null,
      targetItemIds: [params.folderItemId],
      verifyItemInMatterTree: createMatterTreeItemVerifier(provider),
      auditAction: 'document:uploaded',
      repository: deps.repository,
    },
    async (userCtx) =>
      provider.uploadContent(
        userCtx,
        {
          storeId: loc!.storeId,
          libraryId: loc!.libraryId,
          siteId: loc!.providerSiteId,
          driveId: loc!.providerDriveId,
          folderItemId: params.folderItemId,
        },
        params.fileName,
        params.bytes,
        params.bytes.byteLength,
        {
          conflictBehavior: params.conflictBehavior ?? 'rename',
          mimeType: params.mimeType,
        },
      ),
  );
}

/**
 * Downloads a file from a matter's document store folder as the signed-in user.
 */
export async function downloadMatterStoreDocument(params: {
  matterId: string;
  locationId: string;
  itemId: string;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  correlationId?: string;
}): Promise<{
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people } =
    await buildTenantContextForUser(
      params.userId ?? '',
      store,
      baseCfg,
      { session: params.session, correlationId: params.correlationId },
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) throw new Error('Matter not found.');

  const loc = await deps.repository.getMatterLocationById(
    ctx,
    params.locationId,
  );
  const matterLoc =
    loc?.matterId === matter.id
      ? loc
      : ((await deps.repository.listMatterLocationsByMatterId(ctx, matter.id))[0] ??
        loc);
  const fallbackStoreId =
    matterLoc?.storeId ?? config.documentStores?.[0]?.storeId ?? 'default';
  const fallbackLibraryId =
    matterLoc?.libraryId ??
    config.documentStores?.[0]?.sharepoint?.libraries?.[0]?.libraryId ??
    'default';

  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const provider = deps.getProvider(fallbackStoreId);

  const dl = await executeUserMatterDocumentOperation(
    {
      ctx,
      requiredPermission: 'document:download',
      grantedPermissions,
      matterId: matter.id,
      canAccessMatterIn1Squared: accessCheck.canAccess,
      isRestrictedMatter: accessCheck.isRestricted,
      isUserOnRestrictedAllowlist: accessCheck.isOnRestrictedAllowlist,
      storeId: fallbackStoreId,
      libraryId: fallbackLibraryId,
      providerItemId: params.itemId,
      locationId: params.locationId,
      location: loc ?? null,
      targetItemIds: [params.itemId],
      verifyItemInMatterTree: createMatterTreeItemVerifier(provider),
      auditAction: 'document:downloaded',
      repository: deps.repository,
    },
    async (userCtx) =>
      provider.downloadContent(userCtx, {
        storeId: loc!.storeId,
        siteId: loc!.providerSiteId,
        driveId: loc!.providerDriveId,
        itemId: params.itemId,
      }),
  );

  const reader = dl.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  return {
    bytes,
    fileName: dl.fileName,
    mimeType: dl.mimeType,
  };
}

/**
 * Performs folder creation, rename, move, delete, or getWebUrl as the signed-in user.
 */
export async function mutateMatterStoreItem(params: {
  matterId: string;
  locationId: string;
  action: 'create_folder' | 'rename' | 'move' | 'delete' | 'get_web_url';
  itemId?: string;
  parentFolderItemId?: string;
  destinationFolderItemId?: string;
  name?: string;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  correlationId?: string;
}): Promise<{
  item?: DocumentStoreItem;
  webUrl?: string;
  openInAppUrl?: string;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, user, grantedPermissions, people } =
    await buildTenantContextForUser(
      params.userId ?? '',
      store,
      baseCfg,
      { session: params.session, correlationId: params.correlationId },
    );
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const matter = await loadMatterByIdForAccessCheck(ctx, params.matterId);
  if (!matter) throw new Error('Matter not found.');

  const loc = await deps.repository.getMatterLocationById(
    ctx,
    params.locationId,
  );
  const matterLoc =
    loc?.matterId === matter.id
      ? loc
      : ((await deps.repository.listMatterLocationsByMatterId(ctx, matter.id))[0] ??
        loc);
  const fallbackStoreId =
    matterLoc?.storeId ?? config.documentStores?.[0]?.storeId ?? 'default';
  const fallbackLibraryId =
    matterLoc?.libraryId ??
    config.documentStores?.[0]?.sharepoint?.libraries?.[0]?.libraryId ??
    'default';

  const accessCheck = checkMatterAccessForActor(user, matter, store, config);
  const provider = deps.getProvider(fallbackStoreId);

  const permMap = {
    create_folder: 'document:upload' as const,
    rename: 'document:edit' as const,
    move: 'document:edit' as const,
    delete: 'document:delete' as const,
    get_web_url: 'document:view' as const,
  };
  const auditMap = {
    create_folder: 'document:folder_created' as const,
    rename: 'document:renamed' as const,
    move: 'document:moved' as const,
    delete: 'document:deleted' as const,
    get_web_url: 'document:listed' as const,
  };

  return executeUserMatterDocumentOperation(
    {
      ctx,
      requiredPermission: permMap[params.action],
      grantedPermissions,
      matterId: matter.id,
      canAccessMatterIn1Squared: accessCheck.canAccess,
      isRestrictedMatter: accessCheck.isRestricted,
      isUserOnRestrictedAllowlist: accessCheck.isOnRestrictedAllowlist,
      storeId: fallbackStoreId,
      libraryId: fallbackLibraryId,
      providerItemId: params.itemId ?? params.parentFolderItemId ?? null,
      locationId: params.locationId,
      location: loc ?? null,
      targetItemIds: [
        params.itemId,
        params.parentFolderItemId,
        params.destinationFolderItemId,
      ],
      verifyItemInMatterTree: createMatterTreeItemVerifier(provider),
      auditAction: auditMap[params.action],
      repository: deps.repository,
    },
    async (userCtx) => {
      const verifiedLoc = loc!;
      switch (params.action) {
        case 'create_folder': {
          const item = await provider.createFolder(
            userCtx,
            {
              storeId: verifiedLoc.storeId,
              libraryId: verifiedLoc.libraryId,
              siteId: verifiedLoc.providerSiteId,
              driveId: verifiedLoc.providerDriveId,
              folderItemId:
                params.parentFolderItemId ?? verifiedLoc.providerFolderItemId,
            },
            params.name ?? 'New Folder',
            'fail',
          );
          return { item };
        }
        case 'rename': {
          const item = await provider.renameItem(
            userCtx,
            {
              storeId: verifiedLoc.storeId,
              siteId: verifiedLoc.providerSiteId,
              driveId: verifiedLoc.providerDriveId,
              itemId: params.itemId!,
            },
            params.name ?? 'Renamed',
          );
          return { item };
        }
        case 'move': {
          const item = await provider.moveItem(
            userCtx,
            {
              storeId: verifiedLoc.storeId,
              siteId: verifiedLoc.providerSiteId,
              driveId: verifiedLoc.providerDriveId,
              itemId: params.itemId!,
            },
            {
              storeId: verifiedLoc.storeId,
              libraryId: verifiedLoc.libraryId,
              siteId: verifiedLoc.providerSiteId,
              driveId: verifiedLoc.providerDriveId,
              folderItemId:
                params.destinationFolderItemId ??
                verifiedLoc.providerFolderItemId,
            },
            params.name,
          );
          return { item };
        }
        case 'delete': {
          await provider.deleteItem(userCtx, {
            storeId: verifiedLoc.storeId,
            siteId: verifiedLoc.providerSiteId,
            driveId: verifiedLoc.providerDriveId,
            itemId: params.itemId!,
          });
          return {};
        }
        case 'get_web_url': {
          const urls = await provider.getWebUrl(userCtx, {
            storeId: verifiedLoc.storeId,
            siteId: verifiedLoc.providerSiteId,
            driveId: verifiedLoc.providerDriveId,
            itemId: params.itemId!,
          });
          return urls;
        }
      }
    },
  );
}

// ============================================================================
// Admin Operations (Stores, Connection Test, URL Resolution, Routing, Templates, Access Review)
// ============================================================================

export interface DocumentStoresAdminDashboardData {
  config: {
    documentStores: DocumentStoreConfig[];
    documentRouting: DocumentRoutingRule[];
    matterFolderNameTemplate: string;
    documentAccess: DocumentAccessConfig;
    matterFolderTemplates: MatterFolderTemplatesConfig;
  };
  catalog: {
    departments: { id: string; code: string; name: string }[];
    teams: {
      id: string;
      code: string;
      name: string;
      parentDepartmentId: string;
    }[];
    workTypes: { id: string; label: string; parentId: string | null }[];
  };
  libraryScaleStatuses: LibraryScopeScaleStatus[];
  reconciliationFindings: DocumentReconciliationFindingRecord[];
  recentJobs: DocumentLifecycleJobRecord[];
  recentAuditEvents: DocumentStoreAuditEventRecord[];
  permissions: {
    canConfigureStores: boolean;
    canConfigureTemplates: boolean;
    canReviewAccess: boolean;
  };
}

export async function getDocumentStoresAdminDashboard(
  userId: string,
  options?: BuildTenantContextOptions,
): Promise<DocumentStoresAdminDashboardData> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions } = await buildTenantContextForUser(
    userId,
    store,
    baseCfg,
    options,
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_store:configure',
    'document_template:configure',
    'document_access:review',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const permSet = new Set(grantedPermissions);

  const workTypes = store.values
    .filter((v) => v.listKey === 'work_type' && v.active)
    .map((v) => ({
      id: v.id,
      label: v.label,
      parentId: v.parentId ?? null,
    }));

  const [
    libraryScaleStatuses,
    reconciliationFindings,
    allJobs,
    recentAuditEvents,
  ] = await Promise.all([
    computeTenantLibraryScaleStatuses({
      ctx,
      repository: repo,
      stores: config.documentStores ?? [],
      warningThreshold: config.documentAccess?.uniqueScopeWarningThreshold,
    }),
    repo.listReconciliationFindings(ctx),
    repo.listLifecycleJobs(ctx),
    repo.listAuditEvents(ctx, { limit: 40 }),
  ]);

  return {
    config: {
      documentStores: config.documentStores ?? [],
      documentRouting: config.documentRouting ?? [],
      matterFolderNameTemplate:
        config.matterFolderNameTemplate ??
        '{matterNumber} - {matterDescription}',
      documentAccess: config.documentAccess ?? {
        departmentEntraGroups: {},
        teamEntraGroups: {},
      },
      matterFolderTemplates: config.matterFolderTemplates ?? {
        default: {
          templateId: 'tpl-firm-default',
          version: 1,
          mode: 'replaces',
          nodes: [],
        },
      },
    },
    catalog: {
      departments: store.orgStructure.departments.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
      })),
      teams: store.orgStructure.teamsOrPracticeGroups.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        parentDepartmentId: t.parentDepartmentId,
      })),
      workTypes,
    },
    libraryScaleStatuses,
    reconciliationFindings,
    recentJobs: allJobs.slice(0, 30),
    recentAuditEvents,
    permissions: {
      canConfigureStores: permSet.has('document_store:configure'),
      canConfigureTemplates: permSet.has('document_template:configure'),
      canReviewAccess: permSet.has('document_access:review'),
    },
  };
}

export async function testAdminDocumentStoreConnection(params: {
  storeId: string;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<DocumentStoreConnectionTestResult> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions, people } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_store:configure',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);
  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const provider = deps.getProvider(params.storeId);

  const provCtx: ProvisioningAccessContext = {
    kind: 'provisioning',
    tenantContext: ctx,
    triggeredByUserId: ctx.actorId,
    triggerEvent: 'admin.store.test_connection',
  };

  const res = await provider.testConnection(provCtx);
  await deps.repository.appendAuditEvent(
    ctx,
    buildDocumentStoreAuditEvent({
      context: ctx,
      identityUsed: 'provisioning',
      triggerEvent: 'admin.store.test_connection',
      action: 'store:connection:tested',
      storeId: params.storeId,
      outcome: res.ok ? 'succeeded' : 'failed',
      errorCode: res.errorCode ?? null,
    }),
  );
  return res;
}

export async function resolveAdminSharePointLocationUrl(params: {
  storeId?: string;
  rawUrlOrPath: string;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<{
  parsed: ReturnType<typeof parseSharePointLocationUrl>;
  resolution?: DocumentLocationResolutionResult;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions, people } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_store:configure',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);

  const parsed = parseSharePointLocationUrl(params.rawUrlOrPath);
  if (!parsed.valid) {
    return { parsed };
  }

  const targetStoreId = params.storeId ?? config.documentStores?.[0]?.storeId;
  if (!targetStoreId) {
    return { parsed };
  }

  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const provider = deps.getProvider(targetStoreId);
  const provCtx: ProvisioningAccessContext = {
    kind: 'provisioning',
    tenantContext: ctx,
    triggeredByUserId: ctx.actorId,
    triggerEvent: 'admin.store.resolve_location',
  };

  const resolution = await provider.resolveLocation(provCtx, {
    storeId: targetStoreId,
    rawUrlOrPath: params.rawUrlOrPath,
  });

  await deps.repository.appendAuditEvent(
    ctx,
    buildDocumentStoreAuditEvent({
      context: ctx,
      identityUsed: 'provisioning',
      triggerEvent: 'admin.store.resolve_location',
      action: 'store:location:resolved',
      storeId: targetStoreId,
      providerItemId: resolution.folderItemId ?? null,
      outcome: resolution.resolved ? 'succeeded' : 'failed',
      errorCode: resolution.errorCode ?? null,
    }),
  );

  return { parsed, resolution };
}

export async function saveAdminDocumentStoreConfiguration(params: {
  section: 'stores' | 'routing_and_access' | 'templates';
  documentStores?: DocumentStoreConfig[];
  documentRouting?: DocumentRoutingRule[];
  matterFolderNameTemplate?: string;
  documentAccess?: DocumentAccessConfig;
  matterFolderTemplates?: MatterFolderTemplatesConfig;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<DocumentStoresAdminDashboardData> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );

  if (params.section === 'stores' || params.section === 'routing_and_access') {
    assertAdminPermissionAndMfa(ctx, grantedPermissions, [
      'document_store:configure',
    ]);
  }
  if (params.section === 'templates') {
    assertAdminPermissionAndMfa(ctx, grantedPermissions, [
      'document_template:configure',
    ]);
  }

  const repo = getRepositorySingleton();
  const currentConfig = await loadActiveDocumentTenantConfig(ctx, repo);
  const currentOverride =
    (await repo.getDocumentStoreTenantConfig(ctx)) ?? {};

  const nextOverride = {
    ...currentOverride,
    ...(params.documentStores !== undefined
      ? { documentStores: params.documentStores }
      : {}),
    ...(params.documentRouting !== undefined
      ? { documentRouting: params.documentRouting }
      : {}),
    ...(params.matterFolderNameTemplate !== undefined
      ? { matterFolderNameTemplate: params.matterFolderNameTemplate }
      : {}),
    ...(params.documentAccess !== undefined
      ? { documentAccess: params.documentAccess }
      : {}),
    ...(params.matterFolderTemplates !== undefined
      ? { matterFolderTemplates: params.matterFolderTemplates }
      : {}),
  };

  const rawBase = getActiveTenantRawBaseConfig();
  const validated = loadAndValidateTenantConfig(
    rawBase,
    nextOverride,
    currentConfig.environment,
    currentConfig.hostingMode,
  );

  const workTypeIds = store.values
    .filter((v) => v.listKey === 'work_type')
    .map((v) => v.id);

  const catalogCheck = validateDocumentConfigAgainstTenantData(validated, {
    departmentIds: store.orgStructure.departments.map((d) => d.id),
    teamIds: store.orgStructure.teamsOrPracticeGroups.map((t) => t.id),
    workTypeIds,
  });
  if (!catalogCheck.valid) {
    throw new Error(catalogCheck.errors.join(' '));
  }

  await repo.putDocumentStoreTenantConfig(ctx, nextOverride, ctx.actorId);

  const actionMap = {
    stores: 'config:stores:updated' as const,
    routing_and_access: 'config:access:updated' as const,
    templates: 'config:templates:updated' as const,
  };

  const storeScopeMetadata =
    params.section === 'stores' && params.documentStores
      ? {
          delegatedPermissionScopes: Object.fromEntries(
            params.documentStores.map((ds) => [
              ds.storeId,
              ds.auth?.delegatedPermissionScope ?? 'Files.ReadWrite.All',
            ]),
          ),
        }
      : undefined;

  await repo.appendAuditEvent(
    ctx,
    buildDocumentStoreAuditEvent({
      context: ctx,
      identityUsed: 'user',
      triggerEvent: `admin.${params.section}.saved`,
      action: actionMap[params.section],
      outcome: 'succeeded',
      ...(storeScopeMetadata ? { metadata: storeScopeMetadata } : {}),
    }),
  );

  return getDocumentStoresAdminDashboard(params.userId ?? '', {
    session: params.session,
    mfaVerified: params.mfaVerified,
  });
}

export async function previewAdminMatterFolderTemplate(params: {
  departmentId?: string;
  workTypeId?: string;
  templatesConfigOverride?: MatterFolderTemplatesConfig;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<
  ResolvedMatterFolderTemplate & {
    validation: ReturnType<typeof validateMatterFolderTemplatesConfig>;
  }
> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_template:configure',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);

  const templatesConfig =
    params.templatesConfigOverride ??
    config.matterFolderTemplates ?? {
      default: {
        templateId: 'tpl-firm-default',
        version: 1,
        mode: 'replaces',
        nodes: [],
      },
    };

  const validation = validateMatterFolderTemplatesConfig(templatesConfig);
  const resolved = resolveMatterFolderTemplate({
    templatesConfig,
    departmentId: params.departmentId,
    workTypeId: params.workTypeId,
  });

  return {
    ...resolved,
    validation,
  };
}

export async function applyAdminTemplateAdditionsToOpenMatters(
  userId: string,
  options?: BuildTenantContextOptions,
): Promise<{
  job: DocumentLifecycleJobRecord;
  updatedMatterCount: number;
  addedFoldersByMatterId: Record<string, string[]>;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions, people, organisations } =
    await buildTenantContextForUser(
      userId,
      store,
      baseCfg,
      options,
    );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_template:configure',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);

  const deps = buildLifecycleDependencies(ctx, store, config, people);
  const allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);
  const openSubjects = allMatters
    .map((m) => buildMatterRoutingSubject(m, store, people, organisations))
    .filter((s) => !s.isClosed);

  const res = await applyTemplateAdditionsToOpenMattersJob({
    ctx,
    deps,
    openMatterSubjects: openSubjects,
  });

  return {
    job: res.job,
    updatedMatterCount: Object.keys(res.addedFoldersByMatterId).length,
    addedFoldersByMatterId: res.addedFoldersByMatterId,
  };
}

export async function runAdminDocumentReconciliationScan(params: {
  storeId?: string;
  autoRemediate?: boolean;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<{
  findings: DocumentReconciliationFindingRecord[];
  remediatedCount: number;
}> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions, people } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_access:review',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);

  const deps = buildLifecycleDependencies(ctx, store, config, people);
  return reconcileDocumentStorePermissionsJob({
    ctx,
    deps: {
      repository: deps.repository,
      getProvider: deps.getProvider,
      stores: deps.stores,
      autoRemediate: params.autoRemediate ?? false,
    },
    storeId: params.storeId,
    autoRemediate: params.autoRemediate,
    triggerEvent: 'admin.access_review.manual_scan',
  });
}

export async function remediateAdminReconciliationFinding(params: {
  findingId: string;
  userId?: string;
  session?: VerifiedEntraSessionPayload;
  mfaVerified?: boolean;
  correlationId?: string;
}): Promise<DocumentReconciliationFindingRecord> {
  const store = getStore();
  const baseCfg = getActiveTenantConfiguration();
  const { ctx, grantedPermissions, people } = await buildTenantContextForUser(
    params.userId ?? '',
    store,
    baseCfg,
    {
      session: params.session,
      mfaVerified: params.mfaVerified,
      correlationId: params.correlationId,
    },
  );
  assertAdminPermissionAndMfa(ctx, grantedPermissions, [
    'document_access:review',
  ]);
  const repo = getRepositorySingleton();
  const config = await loadActiveDocumentTenantConfig(ctx, repo);

  const deps = buildLifecycleDependencies(ctx, store, config, people);
  return remediateReconciliationFinding({
    ctx,
    deps: {
      repository: deps.repository,
      getProvider: deps.getProvider,
      stores: deps.stores,
    },
    findingId: params.findingId,
  });
}

export type UnusedHelperRef =
  | typeof compileDepartmentFolderPermissions
  | typeof compileTeamFolderPermissions
  | typeof compileMatterFolderPermissions
  | typeof computeAdditiveTemplateDiff
  | typeof resolveMatterDocumentRoute;
