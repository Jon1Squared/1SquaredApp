/**
 * Idempotent one-off store-to-PostgreSQL importer and clean-slate reset helper (`src/server/storePostgresImport.ts`).
 *
 * Implements the release cut-over data import contract (`docs/runbooks/store-cut-over.md`, ADR 0028 §5, `R405`, `R407`):
 * - Imports Document Generation metadata (`documents`), Document Store metadata (`document-store`),
 *   and Key Dates (`key-dates`) into the tenant's isolated PostgreSQL database through
 *   `TenantScopedRepository` subclasses (`SET LOCAL ROLE` inside explicit transactions).
 * - Verifies imported row counts on a fresh repository instance.
 * - Never logs personal data, client content, SQL text, or row payloads.
 */

import {
  TenantDocumentRepository,
  TenantDocumentStoreRepository,
  TenantKeyDateRepository,
  type TenantContext,
} from '@platform/core';
import { getStore, type FirmStore } from './store';

export type ImportableStoreModule =
  | 'documents'
  | 'document-store'
  | 'key-dates';

export const DEFAULT_S014_IMPORT_MODULES: readonly ImportableStoreModule[] = [
  'documents',
  'document-store',
];

export interface ImportStoreModulesOptions {
  /**
   * The caller's verified tenant context (R433): the signed-in user's context from
   * `guardedAction`, or a job entry point's system context (`scripts/`, ADR 0030 §3).
   * There is no default tenant.
   */
  ctx: TenantContext;
  store?: FirmStore;
  modules?: readonly ImportableStoreModule[];
  clearFirst?: boolean;
}

export interface ImportStoreModulesResult {
  tenantId: string;
  environment: string;
  modules: ImportableStoreModule[];
  counts: {
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
  };
}

export async function clearMigratedPostgresModulesForTenant(options: {
  ctx: TenantContext;
  modules?: readonly ImportableStoreModule[];
}): Promise<void> {
  const { ctx } = options;
  const modules = options.modules ?? DEFAULT_S014_IMPORT_MODULES;

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
}

export async function importFirmStoreModulesToPostgres(
  options: ImportStoreModulesOptions,
): Promise<ImportStoreModulesResult> {
  const { ctx } = options;
  const store = options.store ?? getStore();
  const modules: ImportableStoreModule[] = [
    ...(options.modules ?? DEFAULT_S014_IMPORT_MODULES),
  ];

  if (options.clearFirst) {
    await clearMigratedPostgresModulesForTenant({ ctx, modules });
  }

  const counts: ImportStoreModulesResult['counts'] = {
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
  };

  if (modules.includes('documents')) {
    const docRepo = new TenantDocumentRepository();

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
      if (p.isEmployee && !p.mergedIntoId && oid && !p.tags?.includes('no-entra-id')) {
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
      await docStoreRepo.putFolderScope(ctx, { ...s, tenantId: ctx.tenantId });
      counts.documentStoreFolderScopes += 1;
    }

    const jobs = (store.documentLifecycleJobs ?? []).filter(
      (j) => !j.tenantId || j.tenantId === ctx.tenantId,
    );
    for (const j of jobs) {
      await docStoreRepo.putLifecycleJob(ctx, { ...j, tenantId: ctx.tenantId });
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

    for (const m of store.matters ?? []) {
      const isRestricted = Boolean(m.isStaffMatter || m.hasEthicalWall);
      const allowIds = isRestricted
        ? Array.from(
            new Set(
              [
                ...(m.restrictedAccessUserIds ?? []),
                m.responsiblePartnerId,
                m.supervisingPartnerId,
                m.leadFeeEarnerId,
                ...(m.teamMemberIds ?? []),
              ].filter((x): x is string => Boolean(x)),
            ),
          )
        : (m.restrictedAccessUserIds ?? []);
      await keyDateRepo.setMatterRestriction(ctx, {
        matterId: m.id,
        isRestricted,
        restrictedAccessUserIds: allowIds,
      });
    }

    if (store.keyDatesConfigOverride !== undefined) {
      await keyDateRepo.putKeyDatesTenantConfig(
        ctx,
        store.keyDatesConfigOverride as unknown as import('@platform/core').KeyDatesConfiguration,
        'system-store-import',
      );
      counts.hasKeyDatesConfigOverride = true;
    }

    const keyDates = store.keyDates ?? [];
    // Pass 1: insert without self-referential supersession links
    for (const kd of keyDates) {
      const firstPass = { ...kd };
      delete firstPass.supersedesKeyDateId;
      delete firstPass.supersededByKeyDateId;
      await keyDateRepo.putKeyDate(ctx, firstPass);
      counts.keyDates += 1;
    }
    // Pass 2: apply supersession links once all target rows exist
    for (const kd of keyDates) {
      if (kd.supersedesKeyDateId || kd.supersededByKeyDateId) {
        await keyDateRepo.putKeyDate(ctx, kd);
      }
    }

    for (const na of store.keyDateNotApplicable ?? []) {
      await keyDateRepo.putNotApplicable(ctx, na);
      counts.keyDateNotApplicable += 1;
    }
    for (const rs of store.keyDateReminderStates ?? []) {
      await keyDateRepo.putReminderState(ctx, rs);
      counts.keyDateReminderStates += 1;
    }
    for (const cs of store.keyDateCalendarSyncs ?? []) {
      await keyDateRepo.putCalendarSync(ctx, cs);
      counts.keyDateCalendarSyncs += 1;
    }
  }

  return {
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    modules,
    counts,
  };
}
