/**
 * Idempotent one-off store-to-PostgreSQL importer and clean-slate reset helper (`src/server/storePostgresImport.ts`).
 *
 * Implements the release cut-over data import contract (`docs/runbooks/store-cut-over.md`, ADR 0028 §5, `R405`, `R407`, `R413`):
 * - Imports Document Generation metadata (`documents`), Document Store metadata (`document-store`),
 *   Key Dates (`key-dates`), and the append-only firm Audit Log (`audit`) into the tenant's isolated
 *   PostgreSQL database through `TenantScopedRepository` subclasses (`SET LOCAL ROLE` inside explicit transactions).
 * - Verifies imported row counts on a fresh repository instance.
 * - Never logs personal data, client content, SQL text, or row payloads.
 */

import {
  TenantAuditRepository,
  TenantDocumentRepository,
  TenantDocumentStoreRepository,
  TenantKeyDateRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  type FirmAuditEntryInput,
  type MatterRestrictionMetadata,
  type TenantConfiguration,
  type TenantContext,
  type TenantMatterRecord,
  type TenantMergeHistoryRecord,
  type TenantNoteRecord,
  type TenantOrganisationRecord,
  type TenantPersonOrganisationLinkRecord,
  type TenantPersonRecord,
} from '@platform/core';
import { isMatterRestrictedForKeyDates } from '@/domain/keyDates';
import { canPersonAccessMatter } from '@/domain/rbac';
import type { Matter, Person, Team } from '@/domain/types';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import { getStore, type FirmStore } from './store';

export type ImportableStoreModule =
  | 'parties'
  | 'matters'
  | 'documents'
  | 'document-store'
  | 'key-dates'
  | 'audit';

export const ALL_IMPORTABLE_MODULES: readonly ImportableStoreModule[] = [
  'parties',
  'matters',
  'documents',
  'document-store',
  'key-dates',
  'audit',
];

export const DEFAULT_S014_IMPORT_MODULES: readonly ImportableStoreModule[] = [
  'documents',
  'document-store',
];

export const DEFAULT_MIGRATED_POSTGRES_MODULES: readonly ImportableStoreModule[] =
  ALL_IMPORTABLE_MODULES;

export interface ImportStoreModulesOptions {
  /**
   * The caller's verified tenant context (R433): the signed-in user's context from
   * `guardedAction`, or a job entry point's system context (`scripts/`, ADR 0030 §3).
   * There is no default tenant.
   */
  ctx: TenantContext;
  /** Tenant configuration for restriction rules; must belong to `ctx.tenantId`. */
  tenantConfig?: TenantConfiguration;
  store?: FirmStore;
  modules?: readonly ImportableStoreModule[];
  clearFirst?: boolean;
}

export interface ImportStoreModulesResult {
  tenantId: string;
  environment: string;
  modules: ImportableStoreModule[];
  counts: {
    people: number;
    personEmails: number;
    organisations: number;
    links: number;
    notes: number;
    mergeHistory: number;
    matters: number;
    matterParties: number;
    matterNumberSequences: number;
    documentTemplates: number;
    documentTemplateVersions: number;
    documents: number;
    documentLinks: number;
    templateUsageEvents: number;
    hasDocumentGenerationConfigOverride: boolean;
    matterDocumentLocations: number;
    documentStoreFolderScopes: number;
    documentLifecycleJobs: number;
    documentReconciliationFindings: number;
    documentStoreAuditEvents: number;
    hasDocumentStoreConfigOverride: boolean;
    keyDates: number;
    keyDateNotApplicable: number;
    keyDateReminderStates: number;
    keyDateCalendarSyncs: number;
    hasKeyDatesConfigOverride: boolean;
    auditEntries: number;
  };
}

/**
 * Computes the authoritative `MatterRestrictionMetadata` for `TenantKeyDateRepository`
 * (`matter_restriction_metadata` table), respecting staff matters (`isStaffMatter`),
 * fail-closed ethical walls (`hasEthicalWall`, `B12`), and `canPersonAccessMatter`.
 */
export function computeMatterRestrictionMetadataForStore(
  matter: Matter,
  people: readonly Person[],
  teams: readonly Team[],
  tenantConfig?: TenantConfiguration,
): MatterRestrictionMetadata {
  const isRestricted = isMatterRestrictedForKeyDates(matter);
  if (!isRestricted) {
    return {
      matterId: matter.id,
      isRestricted: false,
      restrictedAccessUserIds: [],
    };
  }
  const effectiveTenantConfig = tenantConfig ?? getActiveTenantConfiguration();
  const permittedIds = new Set<string>(matter.restrictedAccessUserIds ?? []);
  for (const person of people) {
    if (!person.isEmployee || person.mergedIntoId) continue;
    if (
      canPersonAccessMatter(matter, person.id, person, {
        allPeople: people,
        teams,
        config: effectiveTenantConfig,
        tenantId: effectiveTenantConfig.tenantId,
      })
    ) {
      permittedIds.add(person.id);
    }
  }
  return {
    matterId: matter.id,
    isRestricted: true,
    restrictedAccessUserIds: Array.from(permittedIds),
  };
}

export async function clearMigratedPostgresModulesForTenant(options: {
  ctx: TenantContext;
  modules?: readonly ImportableStoreModule[];
  resetMatterNumberSequences?: boolean;
}): Promise<void> {
  const { ctx } = options;
  const modules = options.modules ?? DEFAULT_MIGRATED_POSTGRES_MODULES;

  if (modules.includes('documents')) {
    const docRepo = new TenantDocumentRepository();
    await docRepo.offboardTenantData(ctx);
  }
  if (modules.includes('document-store')) {
    const docStoreRepo = new TenantDocumentStoreRepository();
    await docStoreRepo.clearTenantData(ctx);
  }
  if (modules.includes('key-dates')) {
    const keyDateRepo = new TenantKeyDateRepository();
    await keyDateRepo.clearTenantData(ctx);
  }
  if (modules.includes('matters')) {
    const matterRepo = new TenantMatterRepository();
    await matterRepo.clearTenantData(ctx, {
      ...(options.resetMatterNumberSequences !== undefined
        ? { resetMatterNumberSequences: options.resetMatterNumberSequences }
        : {}),
    });
  }
  if (modules.includes('parties')) {
    const partyRepo = new TenantPartyRepository();
    await partyRepo.clearTenantData(ctx);
  }
  if (modules.includes('audit')) {
    // R453: runs under the caller's tenant role through the non-live reset function (0008).
    await new TenantAuditRepository().resetNonLiveAuditLog(ctx);
  }
}

export async function importFirmStoreModulesToPostgres(
  options: ImportStoreModulesOptions,
): Promise<ImportStoreModulesResult> {
  const { ctx } = options;
  const tenantConfig = options.tenantConfig ?? getActiveTenantConfiguration();
  if (tenantConfig.tenantId !== ctx.tenantId) {
    throw new Error(
      'STORE_IMPORT_TENANT_MISMATCH: Tenant configuration does not belong to the caller tenant context.',
    );
  }
  const store = options.store ?? getStore();
  const modules: ImportableStoreModule[] = [
    ...(options.modules ?? DEFAULT_MIGRATED_POSTGRES_MODULES),
  ];

  if (options.clearFirst) {
    await clearMigratedPostgresModulesForTenant({ ctx, modules });
  }

  const counts: ImportStoreModulesResult['counts'] = {
    people: 0,
    personEmails: 0,
    organisations: 0,
    links: 0,
    notes: 0,
    mergeHistory: 0,
    matters: 0,
    matterParties: 0,
    matterNumberSequences: 0,
    documentTemplates: 0,
    documentTemplateVersions: 0,
    documents: 0,
    documentLinks: 0,
    templateUsageEvents: 0,
    hasDocumentGenerationConfigOverride: false,
    matterDocumentLocations: 0,
    documentStoreFolderScopes: 0,
    documentLifecycleJobs: 0,
    documentReconciliationFindings: 0,
    documentStoreAuditEvents: 0,
    hasDocumentStoreConfigOverride: false,
    keyDates: 0,
    keyDateNotApplicable: 0,
    keyDateReminderStates: 0,
    keyDateCalendarSyncs: 0,
    hasKeyDatesConfigOverride: false,
    auditEntries: 0,
  };

  if (modules.includes('parties')) {
    const partyRepo = new TenantPartyRepository();
    const people = (store.people ?? []) as unknown as TenantPersonRecord[];
    const organisations = (store.organisations ??
      []) as unknown as TenantOrganisationRecord[];
    const links = (store.links ??
      []) as unknown as TenantPersonOrganisationLinkRecord[];
    const notes = (store.notes ?? []) as unknown as TenantNoteRecord[];
    const mergeHistory = (store.mergeHistory ??
      []) as unknown as TenantMergeHistoryRecord[];

    await partyRepo.withTenantTransaction(ctx, async () => {
      for (const person of people) {
        await partyRepo.putPerson(ctx, person);
        counts.people += 1;
      }
      for (const org of organisations) {
        await partyRepo.putOrganisation(ctx, org);
        counts.organisations += 1;
      }
      for (const link of links) {
        await partyRepo.putLink(ctx, link);
        counts.links += 1;
      }
      for (const note of notes) {
        await partyRepo.putNote(ctx, note);
        counts.notes += 1;
      }
      for (const mh of mergeHistory) {
        await partyRepo.putMergeHistory(ctx, mh);
        counts.mergeHistory += 1;
      }
    });

    const verifyPartyRepo = new TenantPartyRepository();
    const verifiedPartyCounts =
      await verifyPartyRepo.countAllTenantPartyRows(ctx);
    counts.personEmails = verifiedPartyCounts.personEmails;
    if (
      verifiedPartyCounts.people < counts.people ||
      verifiedPartyCounts.organisations < counts.organisations ||
      verifiedPartyCounts.links < counts.links ||
      verifiedPartyCounts.notes < counts.notes ||
      verifiedPartyCounts.mergeHistory < counts.mergeHistory
    ) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection parties row counts did not match imported totals.',
      );
    }
  }

  if (modules.includes('matters')) {
    const matterRepo = new TenantMatterRepository();
    const people = store.people ?? [];
    const teams = store.teams ?? [];
    const matters = (store.matters ?? []) as unknown as TenantMatterRecord[];
    const sqlRestrictions = new Map<string, readonly string[]>();
    for (const m of store.matters ?? []) {
      const meta = computeMatterRestrictionMetadataForStore(
        m,
        people,
        teams,
        tenantConfig,
      );
      sqlRestrictions.set(m.id, meta.restrictedAccessUserIds);
    }

    await matterRepo.withTenantTransaction(ctx, async () => {
      const importedMatters = await matterRepo.importMatters(ctx, matters, {
        sqlRestrictedAccessUserIdsByMatterId: sqlRestrictions,
      });
      const rvMap = new Map<string, number>();
      for (const im of importedMatters) {
        rvMap.set(im.id, im.rowVersion ?? 1);
      }
      for (const m of store.matters ?? []) {
        m.rowVersion = rvMap.get(m.id) ?? m.rowVersion ?? 1;
      }
    });
    counts.matters = matters.length;

    const verifyMatterRepo = new TenantMatterRepository();
    const verifiedMatterCounts =
      await verifyMatterRepo.countAllTenantMatterRows(ctx);
    counts.matterParties = verifiedMatterCounts.matterParties;
    counts.matterNumberSequences = verifiedMatterCounts.matterNumberSequences;
    if (verifiedMatterCounts.matters < counts.matters) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection matters row count did not match imported total.',
      );
    }
  }

  if (modules.includes('documents')) {
    const docRepo = new TenantDocumentRepository();

    await docRepo.withTenantTransaction(ctx, async () => {
      if (store.documentGenerationConfigOverride !== undefined) {
        await docRepo.putDocumentGenerationTenantConfig(
          ctx,
          store.documentGenerationConfigOverride,
          'system-store-import',
        );
        counts.hasDocumentGenerationConfigOverride = true;
      }

      const templates = (store.documentTemplates ?? []).filter(
        (t) => !t.tenantId || t.tenantId === ctx.tenantId,
      );
      for (const t of templates) {
        await docRepo.putTemplate(ctx, { ...t, tenantId: ctx.tenantId });
        counts.documentTemplates += 1;
      }

      const versions = (store.documentTemplateVersions ?? []).filter(
        (v) => !v.tenantId || v.tenantId === ctx.tenantId,
      );
      for (const v of versions) {
        await docRepo.putTemplateVersion(ctx, { ...v, tenantId: ctx.tenantId });
        counts.documentTemplateVersions += 1;
      }

      const docs = (store.documents ?? []).filter(
        (d) => !d.tenantId || d.tenantId === ctx.tenantId,
      );
      for (const d of docs) {
        await docRepo.putDocument(ctx, { ...d, tenantId: ctx.tenantId });
        counts.documents += 1;
      }

      const validDocIds = new Set(
        (await docRepo.listDocuments(ctx, { includeDeleted: true })).map(
          (d) => d.id,
        ),
      );
      const links = (store.documentLinks ?? []).filter(
        (l) =>
          (!l.tenantId || l.tenantId === ctx.tenantId) &&
          validDocIds.has(l.documentId),
      );
      for (const l of links) {
        await docRepo.putDocumentLink(ctx, { ...l, tenantId: ctx.tenantId });
        counts.documentLinks += 1;
      }

      const validTemplateIds = new Set(
        (await docRepo.listTemplates(ctx)).map((t) => t.id),
      );
      const validVersionIds = new Set(
        (await docRepo.listAllTemplateVersions(ctx)).map((v) => v.id),
      );
      const usageEvents = (store.templateUsageEvents ?? []).filter(
        (ev) =>
          (!ev.tenantId || ev.tenantId === ctx.tenantId) &&
          validTemplateIds.has(ev.templateId) &&
          validVersionIds.has(ev.templateVersionId),
      );
      for (const ev of usageEvents) {
        await docRepo.putUsageEvent(ctx, { ...ev, tenantId: ctx.tenantId });
        counts.templateUsageEvents += 1;
      }
    });

    // Verify counts via a fresh repository instance
    const verifyDocRepo = new TenantDocumentRepository();
    const [
      verifiedTemplates,
      verifiedVersions,
      verifiedDocs,
      verifiedLinks,
      verifiedEvents,
    ] = await Promise.all([
      verifyDocRepo.listTemplates(ctx),
      verifyDocRepo.listAllTemplateVersions(ctx),
      verifyDocRepo.listDocuments(ctx, { includeDeleted: true }),
      verifyDocRepo.listAllDocumentLinks(ctx),
      verifyDocRepo.listUsageEvents(ctx),
    ]);

    if (
      verifiedTemplates.length < counts.documentTemplates ||
      verifiedVersions.length < counts.documentTemplateVersions ||
      verifiedDocs.length < counts.documents ||
      verifiedLinks.length < counts.documentLinks ||
      verifiedEvents.length < counts.templateUsageEvents
    ) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection document metadata row counts did not match imported totals.',
      );
    }
  }

  if (modules.includes('document-store')) {
    const docStoreRepo = new TenantDocumentStoreRepository();

    await docStoreRepo.withTenantTransaction(ctx, async () => {
      if (
        store.documentStoreConfigOverride &&
        Object.keys(store.documentStoreConfigOverride).length > 0
      ) {
        await docStoreRepo.putDocumentStoreTenantConfig(
          ctx,
          store.documentStoreConfigOverride,
          'system-store-import',
        );
        counts.hasDocumentStoreConfigOverride = true;
      }

      const nowIso = new Date().toISOString();
      for (const p of store.people ?? []) {
        const oid = p.entraObjectId?.trim();
        if (
          p.isEmployee &&
          !p.mergedIntoId &&
          oid &&
          !p.tags?.includes('no-entra-id')
        ) {
          const upn =
            p.emails?.find((e) => e.isPrimary)?.address ||
            p.emails?.[0]?.address ||
            null;
          await docStoreRepo.putPersonEntraIdentity(ctx, {
            tenantId: ctx.tenantId,
            personId: p.id,
            entraObjectId: oid,
            ...(upn ? { upn } : {}),
            populatedSource: 'admin_provisioned',
            updatedAt: nowIso,
          });
        }
      }

      const locations = (store.matterDocumentLocations ?? []).filter(
        (loc) => !loc.tenantId || loc.tenantId === ctx.tenantId,
      );
      for (const loc of locations) {
        await docStoreRepo.putMatterLocation(ctx, {
          ...loc,
          tenantId: ctx.tenantId,
        });
        counts.matterDocumentLocations += 1;
      }

      const scopes = (store.documentStoreFolderScopes ?? []).filter(
        (s) => !s.tenantId || s.tenantId === ctx.tenantId,
      );
      for (const s of scopes) {
        await docStoreRepo.putFolderScope(ctx, {
          ...s,
          tenantId: ctx.tenantId,
        });
        counts.documentStoreFolderScopes += 1;
      }

      const jobs = (store.documentLifecycleJobs ?? []).filter(
        (j) => !j.tenantId || j.tenantId === ctx.tenantId,
      );
      for (const j of jobs) {
        await docStoreRepo.putLifecycleJob(ctx, {
          ...j,
          tenantId: ctx.tenantId,
        });
        counts.documentLifecycleJobs += 1;
      }

      const findings = (store.documentReconciliationFindings ?? []).filter(
        (f) => !f.tenantId || f.tenantId === ctx.tenantId,
      );
      for (const f of findings) {
        await docStoreRepo.putReconciliationFinding(ctx, {
          ...f,
          tenantId: ctx.tenantId,
        });
        counts.documentReconciliationFindings += 1;
      }

      const auditEvents = (store.documentStoreAuditEvents ?? []).filter(
        (ev) => !ev.tenantId || ev.tenantId === ctx.tenantId,
      );
      for (const ev of auditEvents) {
        await docStoreRepo.appendAuditEvent(ctx, {
          ...ev,
          tenantId: ctx.tenantId,
        });
        counts.documentStoreAuditEvents += 1;
      }
    });

    const verifyDocStoreRepo = new TenantDocumentStoreRepository();
    const [
      verifiedLocations,
      verifiedScopes,
      verifiedJobs,
      verifiedFindings,
      verifiedAudits,
    ] = await Promise.all([
      verifyDocStoreRepo.listAllMatterLocations(ctx),
      verifyDocStoreRepo.listFolderScopes(ctx),
      verifyDocStoreRepo.listLifecycleJobs(ctx),
      verifyDocStoreRepo.listReconciliationFindings(ctx),
      verifyDocStoreRepo.listAuditEvents(ctx),
    ]);

    if (
      verifiedLocations.length < counts.matterDocumentLocations ||
      verifiedScopes.length < counts.documentStoreFolderScopes ||
      verifiedJobs.length < counts.documentLifecycleJobs ||
      verifiedFindings.length < counts.documentReconciliationFindings ||
      verifiedAudits.length < counts.documentStoreAuditEvents
    ) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection document store metadata row counts did not match imported totals.',
      );
    }
  }

  if (modules.includes('key-dates')) {
    const keyDateRepo = new TenantKeyDateRepository();
    const matters =
      (store.matters?.length ?? 0) > 0
        ? store.matters!
        : ((await new TenantMatterRepository().listAllMattersUnfiltered(
            ctx,
          )) as unknown as Matter[]);
    const matterIdSet = new Set(matters.map((m) => m.id));

    await keyDateRepo.withTenantTransaction(ctx, async () => {
      if (store.keyDatesConfigOverride !== undefined) {
        await keyDateRepo.putKeyDatesTenantConfig(
          ctx,
          store.keyDatesConfigOverride as unknown as import('@platform/core').KeyDatesConfiguration,
          'system-store-import',
        );
        counts.hasKeyDatesConfigOverride = true;
      }

      const keyDates = (store.keyDates ?? []).filter(
        (kd) => !kd.matterId || matterIdSet.has(kd.matterId),
      );
      const importedKeyDateIds = new Set<string>();
      // Pass 1: insert without self-referential supersession links
      for (const kd of keyDates) {
        const firstPass = { ...kd };
        delete firstPass.supersedesKeyDateId;
        delete firstPass.supersededByKeyDateId;
        await keyDateRepo.putKeyDate(ctx, firstPass);
        importedKeyDateIds.add(kd.id);
        counts.keyDates += 1;
      }
      // Pass 2: apply supersession links once all target rows exist
      for (const kd of keyDates) {
        if (kd.supersedesKeyDateId || kd.supersededByKeyDateId) {
          await keyDateRepo.putKeyDate(ctx, kd);
        }
      }

      for (const na of store.keyDateNotApplicable ?? []) {
        if (!matterIdSet.has(na.matterId)) continue;
        await keyDateRepo.putNotApplicable(ctx, na);
        counts.keyDateNotApplicable += 1;
      }
      for (const rs of store.keyDateReminderStates ?? []) {
        if (!importedKeyDateIds.has(rs.keyDateId)) continue;
        await keyDateRepo.putReminderState(ctx, rs);
        counts.keyDateReminderStates += 1;
      }
      for (const cs of store.keyDateCalendarSyncs ?? []) {
        if (!importedKeyDateIds.has(cs.keyDateId)) continue;
        await keyDateRepo.putCalendarSync(ctx, cs);
        counts.keyDateCalendarSyncs += 1;
      }
    });

    const verifyKdRepo = new TenantKeyDateRepository();
    const verifiedKdCounts = await verifyKdRepo.countAllTenantKeyDateRows(ctx);
    if (
      verifiedKdCounts.keyDates < counts.keyDates ||
      verifiedKdCounts.notApplicable < counts.keyDateNotApplicable ||
      verifiedKdCounts.reminderStates < counts.keyDateReminderStates ||
      verifiedKdCounts.calendarSyncs < counts.keyDateCalendarSyncs ||
      (counts.hasKeyDatesConfigOverride && !verifiedKdCounts.hasConfigOverride)
    ) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection key dates row counts did not match imported totals.',
      );
    }
  }

  if (modules.includes('audit')) {
    const auditRepo = new TenantAuditRepository();
    const rawEntries = store.audit ?? [];
    // Deduplicate by id and insert oldest-first so BIGSERIAL `seq` preserves chronological order
    const seenIds = new Set<string>();
    const chronologicalEntries: FirmAuditEntryInput[] = [];
    for (let i = rawEntries.length - 1; i >= 0; i--) {
      const entry = rawEntries[i]!;
      if (!entry.id || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      chronologicalEntries.push({
        id: entry.id,
        recordType: entry.recordType,
        recordId: entry.recordId,
        action: entry.action,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        byId: entry.byId,
        at: entry.at,
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
      });
    }

    await auditRepo.importAuditEntries(ctx, chronologicalEntries);
    counts.auditEntries = chronologicalEntries.length;

    const verifyAuditRepo = new TenantAuditRepository();
    const verifiedAuditCount = await verifyAuditRepo.countAuditEntries(ctx);
    if (verifiedAuditCount < counts.auditEntries) {
      throw new Error(
        'STORE_IMPORT_VERIFICATION_FAILED: Fresh-connection audit_entries row count did not match imported total.',
      );
    }
  }

  return {
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    modules,
    counts,
  };
}
