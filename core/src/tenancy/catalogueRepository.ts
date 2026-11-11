/**
 * Tenant-Scoped PostgreSQL Catalogue & Configuration Repository (`core/src/tenancy/catalogueRepository.ts`).
 *
 * Implements ADR 0028 §§2–4 & `S0-17c` (`R401`, `R402`, `R403`, `R460`, `P7`):
 * - Every read runs inside `withTenantReadTransaction` (`BEGIN READ ONLY` + `SET LOCAL ROLE`).
 * - Every write runs inside `withTenantTransaction` (`BEGIN` + `SET LOCAL ROLE`).
 * - Every SQL statement includes `WHERE tenant_id = $1` AND verifies every returned row via `assertRowTenant`.
 * - Persists:
 *   1. `public.firm_profiles`: `firmId`, `isCleanDeployment`, `firm` (`firm_json`).
 *   2. `public.choice_lists`: `key`, `label`, `description`, `allow_hierarchy`, `system_locked`, `metadata_json`.
 *   3. `public.choice_values`: `id`, `list_key`, `code`, `label`, `parent_id`, `sort_order`, `active`, `metadata_json`.
 *   4. `public.custom_field_definitions`: `id`, `record_type`, `field_key`, `label`, `field_type`, `section`,
 *      `required`, `active`, `sort_order`, `source` (`'tenant_config' | 'admin'`), `options_json`
 *      — merged at runtime with declarative `tenantConfig.customFields` (`P7` / `S0-12`).
 *   5. `public.tenant_module_configs`: per-tenant module configuration payloads (`'org_structure'`,
 *      `'matter_party_taxonomy'`, `'matter_party_migration_report'`, `'home_pages'`, `'matter_costs'`,
 *      `'enquiry_settings'`, `'task_settings'`, `'counters'`, `'form_sections'`, `'dismissed_duplicates'`,
 *      `'work_type_profiles'`, `'document_generation_override'`, `'document_store_override'`).
 * - Commits catalogue/admin mutations and their `audit_entries` rows in a single PostgreSQL transaction.
 */

import type {
  FirmAuditEntryInput,
  FirmAuditEntryRecord,
  TenantConfiguration,
  TenantContext,
} from '../api/index';
import { TenantAuditRepository } from './auditRepository';import type { TenantPostgresPoolManager } from './postgresPoolManager';
import {
  TenantScopedRepository,
  type TenantSqlClient,
} from './tenantScopedRepository';

export type TenantModuleConfigKey =
  | 'org_structure'
  | 'matter_party_taxonomy'
  | 'matter_party_migration_report'
  | 'home_pages'
  | 'matter_costs'
  | 'enquiry_settings'
  | 'task_settings'
  | 'counters'
  | 'form_sections'
  | 'dismissed_duplicates'
  | 'work_type_profiles'
  | 'document_generation_override'
  | 'document_store_override'
  | (string & {});

export type TenantFirmProfilePayload = Record<string, unknown>;

export interface TenantFirmProfileRecord<TFirm = Record<string, unknown>> {
  firmId: string;
  isCleanDeployment: boolean;
  firm: TFirm;
  updatedAt?: string;
}

export interface TenantChoiceListRecord {
  key: string;
  label: string;
  description?: string;
  group?: string;
  appliesTo?: string[];
  allowMultiple?: boolean;
  hierarchical?: boolean;
  allowHierarchy?: boolean;
  systemLocked?: boolean;
  updatedAt?: string;
}

export interface TenantChoiceValueRecord {
  id: string;
  listKey: string;
  code?: string | null;
  systemKey?: string;
  label: string;
  description?: string;
  guidance?: string;
  parentId?: string | null;
  sortOrder: number;
  active: boolean;
  meta?: Record<string, string>;
  updatedAt?: string;
}

export type CustomFieldDefinitionSource = 'tenant_config' | 'admin';

export interface TenantCustomFieldDefinitionRecord {
  id: string;
  recordType: string;
  fieldKey?: string;
  label: string;
  fieldType: string;
  optionsListKey?: string;
  options?: string[];
  section: string;
  required: boolean;
  sortOrder: number;
  active: boolean;
  source?: CustomFieldDefinitionSource;
  updatedAt?: string;
}

interface FirmProfileRow {
  tenant_id: string;
  firm_id: string;
  is_clean_deployment: boolean;
  updated_at: Date | string;
  firm_json: Record<string, unknown>;
}

interface ChoiceListRow {
  tenant_id: string;
  key: string;
  label: string;
  description: string | null;
  allow_hierarchy: boolean;
  system_locked: boolean;
  updated_at: Date | string;
  metadata_json: Record<string, unknown>;
}

interface ChoiceValueRow {
  tenant_id: string;
  id: string;
  list_key: string;
  code: string | null;
  label: string;
  parent_id: string | null;
  sort_order: number | string;
  active: boolean;
  updated_at: Date | string;
  metadata_json: Record<string, unknown>;
}

interface CustomFieldDefinitionRow {
  tenant_id: string;
  id: string;
  record_type: string;
  field_key: string;
  label: string;
  field_type: string;
  section: string;
  required: boolean;
  active: boolean;
  sort_order: number | string;
  source: string;
  updated_at: Date | string;
  options_json: Record<string, unknown>;
}

interface TenantModuleConfigRow {
  tenant_id: string;
  config_key: string;
  updated_at: Date | string;
  updated_by_id: string | null;
  config_json: unknown;
}

function toIsoString(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? String(val) : parsed.toISOString();
}

function safeTimestampIso(val: string | null | undefined): string {
  if (!val) return new Date().toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

function slugifyChoiceToken(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Merges declarative `tenantConfig.customFields` (`P7` / `S0-12`) with PostgreSQL
 * `custom_field_definitions`, `choice_lists`, and `choice_values`.
 *
 * Precedence rules:
 * - Declarative `tenantConfig.customFields` provide baseline custom fields (`source: 'tenant_config'`)
 *   and ensure any `choice` field's `optionsListKey` and `options` exist in `lists` and `values`.
 * - Admin rows persisted in `custom_field_definitions` (`source: 'admin'`) override a declarative
 *   field of the same `id` (allowing admins to toggle `active`, reorder, or relabel) and add any
 *   admin-created custom fields.
 */
export function mergeDeclarativeTenantConfigCustomFields<
  TCustomField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  TList extends TenantChoiceListRecord = TenantChoiceListRecord,
  TValue extends TenantChoiceValueRecord = TenantChoiceValueRecord,
>(
  tenantConfig: Pick<TenantConfiguration, 'customFields'> | null | undefined,
  dbCustomFields: readonly TCustomField[],
  dbLists: readonly TList[],
  dbValues: readonly TValue[],
): {
  customFields: TCustomField[];
  lists: TList[];
  values: TValue[];
} {
  const mergedLists: TList[] = dbLists.map((l) => structuredClone(l));
  const mergedValues: TValue[] = dbValues.map((v) => structuredClone(v));
  const dbFieldsById = new Map<string, TCustomField>();
  for (const d of dbCustomFields) {
    dbFieldsById.set(d.id, structuredClone(d));
  }

  const declarativeEntries = tenantConfig?.customFields ?? [];
  const mergedFieldsById = new Map<string, TCustomField>();

  for (const cf of declarativeEntries) {
    if (!cf || typeof cf.id !== 'string' || !cf.id.trim()) continue;
    const cfId = cf.id.trim();
    const cfRecordType = cf.recordType;
    const cfLabel = cf.label.trim();
    const cfFieldType = cf.fieldType;
    const cfSection = cf.section;
    const cfRequired = Boolean(cf.required);
    const cfSortOrder =
      typeof cf.sortOrder === 'number' && Number.isFinite(cf.sortOrder)
        ? cf.sortOrder
        : 1;
    const cfActive = cf.active !== undefined ? Boolean(cf.active) : true;
    const cfOptions = Array.isArray(cf.options)
      ? cf.options.map((opt) => String(opt).trim()).filter(Boolean)
      : undefined;
    const resolvedOptionsListKey =
      cfFieldType === 'choice'
        ? (cf.optionsListKey?.trim() || cfId)
        : cf.optionsListKey?.trim();

    if (cfFieldType === 'choice' && resolvedOptionsListKey) {
      if (!mergedLists.some((l) => l.key === resolvedOptionsListKey)) {
        mergedLists.push({
          key: resolvedOptionsListKey,
          label: cfLabel,
          group: 'custom',
          appliesTo: [cfRecordType],
          allowMultiple: false,
          hierarchical: false,
        } as unknown as TList);
      }
      if (cfOptions && cfOptions.length > 0) {
        const existingForList = mergedValues.filter(
          (v) => v.listKey === resolvedOptionsListKey,
        );
        cfOptions.forEach((optLabel, idx) => {
          const alreadyExists = existingForList.some(
            (ev) => ev.label.toLowerCase() === optLabel.toLowerCase(),
          );
          if (!alreadyExists) {
            const valId = `${resolvedOptionsListKey}.${slugifyChoiceToken(optLabel)}`;
            if (!mergedValues.some((v) => v.id === valId)) {
              const newVal = {
                id: valId,
                listKey: resolvedOptionsListKey,
                label: optLabel,
                sortOrder: existingForList.length + idx + 1,
                active: true,
                parentId: null,
              } as unknown as TValue;
              mergedValues.push(newVal);
              existingForList.push(newVal);
            }
          }
        });
      }
    }

    const existingDbField = dbFieldsById.get(cfId);
    if (existingDbField) {
      mergedFieldsById.set(cfId, existingDbField);
    } else {
      const declarativeDef = {
        id: cfId,
        recordType: cfRecordType,
        label: cfLabel,
        fieldType: cfFieldType,
        ...(resolvedOptionsListKey
          ? { optionsListKey: resolvedOptionsListKey }
          : {}),
        ...(cfOptions && cfOptions.length > 0 ? { options: cfOptions } : {}),
        section: cfSection,
        required: cfRequired,
        sortOrder: cfSortOrder,
        active: cfActive,
      } as unknown as TCustomField;
      mergedFieldsById.set(cfId, declarativeDef);
    }
  }

  for (const [id, dbField] of dbFieldsById.entries()) {
    if (!mergedFieldsById.has(id)) {
      mergedFieldsById.set(id, dbField);
    }
  }

  return {
    customFields: Array.from(mergedFieldsById.values()),
    lists: mergedLists,
    values: mergedValues,
  };
}

export class TenantCatalogueRepository extends TenantScopedRepository {
  private readonly auditRepo: TenantAuditRepository;

  public constructor(options: { poolManager?: TenantPostgresPoolManager } = {}) {
    super(options);
    this.auditRepo = new TenantAuditRepository(options);
  }

  private mapChoiceListRow<TList extends TenantChoiceListRecord>(
    ctx: TenantContext,
    row: ChoiceListRow,
  ): TList {
    this.assertRowTenant(ctx, row.tenant_id, 'choice_lists');
    const meta =
      row.metadata_json && typeof row.metadata_json === 'object'
        ? structuredClone(row.metadata_json)
        : {};
    const hydrated: Record<string, unknown> = {
      ...meta,
      key: row.key,
      label: row.label,
      hierarchical: Boolean(
        meta.hierarchical ?? row.allow_hierarchy ?? false,
      ),
    };
    if (row.description !== null && row.description !== undefined) {
      hydrated.description = row.description;
    } else if (hydrated.description === null) {
      delete hydrated.description;
    }
    return hydrated as TList;
  }

  private mapChoiceValueRow<TVal extends TenantChoiceValueRecord>(
    ctx: TenantContext,
    row: ChoiceValueRow,
  ): TVal {
    this.assertRowTenant(ctx, row.tenant_id, 'choice_values');
    const meta =
      row.metadata_json && typeof row.metadata_json === 'object'
        ? structuredClone(row.metadata_json)
        : {};
    const hydrated: Record<string, unknown> = {
      ...meta,
      id: row.id,
      listKey: row.list_key,
      label: row.label,
      parentId: row.parent_id ?? null,
      sortOrder: Number(row.sort_order),
      active: Boolean(row.active),
    };
    if (row.code && !hydrated.systemKey) {
      hydrated.systemKey = row.code;
    }
    return hydrated as TVal;
  }

  private mapCustomFieldRow<TField extends TenantCustomFieldDefinitionRecord>(
    ctx: TenantContext,
    row: CustomFieldDefinitionRow,
  ): TField {
    this.assertRowTenant(ctx, row.tenant_id, 'custom_field_definitions');
    const opts =
      row.options_json && typeof row.options_json === 'object'
        ? structuredClone(row.options_json)
        : {};
    const hydrated: Record<string, unknown> = {
      ...opts,
      id: row.id,
      recordType: row.record_type,
      label: row.label,
      fieldType: row.field_type,
      section: row.section,
      required: Boolean(row.required),
      sortOrder: Number(row.sort_order),
      active: Boolean(row.active),
    };
    if (opts.source !== undefined) {
      hydrated.source = opts.source;
    }
    return hydrated as TField;
  }

  // ============================================================================
  // 1. Firm Profiles (`firm_profiles`)
  // ============================================================================

  public async getFirmProfile<TFirm = Record<string, unknown>>(
    ctx: TenantContext,
  ): Promise<TenantFirmProfileRecord<TFirm> | null> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<FirmProfileRow>(
        `SELECT tenant_id, firm_id, is_clean_deployment, updated_at, firm_json
           FROM public.firm_profiles
          WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'firm_profiles');
      return {
        firmId: row.firm_id,
        isCleanDeployment: Boolean(row.is_clean_deployment),
        firm: structuredClone(row.firm_json) as TFirm,
        updatedAt: toIsoString(row.updated_at),
      };
    });
  }

  public async putFirmProfile<TFirm = Record<string, unknown>>(
    ctx: TenantContext,
    input: {
      firmId: string;
      isCleanDeployment?: boolean;
      firm: TFirm;
      updatedAt?: string;
    },
  ): Promise<TenantFirmProfileRecord<TFirm>> {
    if (!input.firmId?.trim()) {
      const err = new Error(
        'FIRM_PROFILE_VALIDATION_ERROR: firmId is required.',
      ) as Error & { code: string };
      err.code = 'FIRM_PROFILE_VALIDATION_ERROR';
      throw err;
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      const updatedAtIso = safeTimestampIso(input.updatedAt);
      const isClean = Boolean(input.isCleanDeployment ?? false);
      const res = await tx.query<FirmProfileRow>(
        `INSERT INTO public.firm_profiles (
           tenant_id, firm_id, is_clean_deployment, updated_at, firm_json
         ) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           firm_id = EXCLUDED.firm_id,
           is_clean_deployment = EXCLUDED.is_clean_deployment,
           updated_at = EXCLUDED.updated_at,
           firm_json = EXCLUDED.firm_json
         RETURNING tenant_id, firm_id, is_clean_deployment, updated_at, firm_json`,
        [
          ctx.tenantId,
          input.firmId.trim(),
          isClean,
          updatedAtIso,
          JSON.stringify(input.firm ?? {}),
        ],
      );
      const row = res.rows[0]!;
      this.assertRowTenant(ctx, row.tenant_id, 'firm_profiles');      return {
        firmId: row.firm_id,
        isCleanDeployment: Boolean(row.is_clean_deployment),
        firm: structuredClone(row.firm_json) as TFirm,
        updatedAt: toIsoString(row.updated_at),
      };
    });
  }

  public async deleteFirmProfile(ctx: TenantContext): Promise<boolean> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.firm_profiles
          WHERE tenant_id = $1
          RETURNING tenant_id`,
        [ctx.tenantId],
      );
      if (res.rows[0]) {
        this.assertRowTenant(ctx, res.rows[0].tenant_id, 'firm_profiles');        return true;
      }
      return false;
    });
  }

  // ============================================================================
  // 2. Choice Lists (`choice_lists`)
  // ============================================================================

  private async upsertChoiceListInTx<TList extends TenantChoiceListRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    list: TList,
  ): Promise<TList> {
    if (!list.key?.trim() || !list.label?.trim()) {
      const err = new Error(
        'CHOICE_LIST_VALIDATION_ERROR: Choice list key and label are required.',
      ) as Error & { code: string };
      err.code = 'CHOICE_LIST_VALIDATION_ERROR';
      throw err;
    }
    const allowHierarchy = Boolean(
      list.hierarchical ?? list.allowHierarchy ?? false,
    );
    const systemLocked = Boolean(list.systemLocked ?? false);
    const updatedAtIso = safeTimestampIso(list.updatedAt);

    const res = await tx.query<ChoiceListRow>(
      `INSERT INTO public.choice_lists (
         tenant_id, key, label, description, allow_hierarchy, system_locked, updated_at, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         allow_hierarchy = EXCLUDED.allow_hierarchy,
         system_locked = EXCLUDED.system_locked,
         updated_at = EXCLUDED.updated_at,
         metadata_json = EXCLUDED.metadata_json
       RETURNING tenant_id, key, label, description, allow_hierarchy, system_locked, updated_at, metadata_json`,
      [
        ctx.tenantId,
        list.key.trim(),
        list.label.trim(),
        typeof list.description === 'string' ? list.description : null,
        allowHierarchy,
        systemLocked,
        updatedAtIso,
        JSON.stringify(list),
      ],
    );
    return this.mapChoiceListRow<TList>(ctx, res.rows[0]!);
  }

  public async listAllChoiceLists<
    TList extends TenantChoiceListRecord = TenantChoiceListRecord,
  >(ctx: TenantContext): Promise<TList[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<ChoiceListRow>(
        `SELECT tenant_id, key, label, description, allow_hierarchy, system_locked, updated_at, metadata_json
           FROM public.choice_lists
          WHERE tenant_id = $1
          ORDER BY key ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => this.mapChoiceListRow<TList>(ctx, row));
    });
  }

  public async getChoiceListByKey<
    TList extends TenantChoiceListRecord = TenantChoiceListRecord,
  >(ctx: TenantContext, key: string): Promise<TList | null> {
    if (!key?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<ChoiceListRow>(
        `SELECT tenant_id, key, label, description, allow_hierarchy, system_locked, updated_at, metadata_json
           FROM public.choice_lists
          WHERE tenant_id = $1 AND key = $2`,
        [ctx.tenantId, key.trim()],
      );
      const row = res.rows[0];
      return row ? this.mapChoiceListRow<TList>(ctx, row) : null;
    });
  }

  public async putChoiceList<
    TList extends TenantChoiceListRecord = TenantChoiceListRecord,
  >(ctx: TenantContext, list: TList): Promise<TList> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const saved = await this.upsertChoiceListInTx(tx, ctx, list);      return saved;
    });
  }

  public async putChoiceLists<
    TList extends TenantChoiceListRecord = TenantChoiceListRecord,
  >(ctx: TenantContext, lists: readonly TList[]): Promise<TList[]> {
    if (lists.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TList[] = [];
      for (const l of lists) {
        out.push(await this.upsertChoiceListInTx(tx, ctx, l));
      }      return out;
    });
  }

  public async deleteChoiceListByKey(
    ctx: TenantContext,
    key: string,
  ): Promise<boolean> {
    if (!key?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.choice_lists
          WHERE tenant_id = $1 AND key = $2
          RETURNING tenant_id`,
        [ctx.tenantId, key.trim()],
      );
      if (res.rows[0]) {
        this.assertRowTenant(ctx, res.rows[0].tenant_id, 'choice_lists');        return true;
      }
      return false;
    });
  }

  // ============================================================================
  // 3. Choice Values (`choice_values`)
  // ============================================================================

  private async upsertChoiceValueInTx<TVal extends TenantChoiceValueRecord>(
    tx: TenantSqlClient,
    ctx: TenantContext,
    val: TVal,
  ): Promise<TVal> {
    if (!val.id?.trim() || !val.listKey?.trim() || !val.label?.trim()) {
      const err = new Error(
        'CHOICE_VALUE_VALIDATION_ERROR: Choice value id, listKey, and label are required.',
      ) as Error & { code: string };
      err.code = 'CHOICE_VALUE_VALIDATION_ERROR';
      throw err;
    }
    const code =
      typeof val.systemKey === 'string' && val.systemKey.trim()
        ? val.systemKey.trim()
        : typeof val.code === 'string' && val.code.trim()
          ? val.code.trim()
          : null;
    const sortOrder =
      typeof val.sortOrder === 'number' && Number.isFinite(val.sortOrder)
        ? Math.floor(val.sortOrder)
        : 1;
    const active = val.active !== undefined ? Boolean(val.active) : true;
    const updatedAtIso = safeTimestampIso(val.updatedAt);

    const res = await tx.query<ChoiceValueRow>(
      `INSERT INTO public.choice_values (
         tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         list_key = EXCLUDED.list_key,
         code = EXCLUDED.code,
         label = EXCLUDED.label,
         parent_id = EXCLUDED.parent_id,
         sort_order = EXCLUDED.sort_order,
         active = EXCLUDED.active,
         updated_at = EXCLUDED.updated_at,
         metadata_json = EXCLUDED.metadata_json
       RETURNING tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json`,
      [
        ctx.tenantId,
        val.id.trim(),
        val.listKey.trim(),
        code,
        val.label.trim(),
        val.parentId ?? null,
        sortOrder,
        active,
        updatedAtIso,
        JSON.stringify(val),
      ],
    );
    return this.mapChoiceValueRow<TVal>(ctx, res.rows[0]!);
  }

  public async listAllChoiceValues<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext): Promise<TVal[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<ChoiceValueRow>(
        `SELECT tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
           FROM public.choice_values
          WHERE tenant_id = $1
          ORDER BY list_key ASC, sort_order ASC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => this.mapChoiceValueRow<TVal>(ctx, row));
    });
  }

  public async listChoiceValuesForList<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext, listKey: string): Promise<TVal[]> {
    if (!listKey?.trim()) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<ChoiceValueRow>(
        `SELECT tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
           FROM public.choice_values
          WHERE tenant_id = $1 AND list_key = $2
          ORDER BY sort_order ASC, id ASC`,
        [ctx.tenantId, listKey.trim()],
      );
      return res.rows.map((row) => this.mapChoiceValueRow<TVal>(ctx, row));
    });
  }

  public async getChoiceValueById<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext, id: string): Promise<TVal | null> {
    if (!id?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<ChoiceValueRow>(
        `SELECT tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
           FROM public.choice_values
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const row = res.rows[0];
      return row ? this.mapChoiceValueRow<TVal>(ctx, row) : null;
    });
  }

  public async putChoiceValue<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext, val: TVal): Promise<TVal> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const saved = await this.upsertChoiceValueInTx(tx, ctx, val);      return saved;
    });
  }

  public async updateExistingChoiceValue<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext, id: string, patch: Partial<TVal>): Promise<TVal> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const existingRes = await tx.query<ChoiceValueRow>(
        `SELECT tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
           FROM public.choice_values
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const existingRow = existingRes.rows[0];
      if (!existingRow) {
        const err = new Error(
          `CHOICE_VALUE_NOT_FOUND: Choice value "${id}" was not found in tenant "${ctx.tenantId}".`,
        ) as Error & { code: string };
        err.code = 'NOT_FOUND';
        throw err;
      }
      const existing = this.mapChoiceValueRow<TVal>(ctx, existingRow);
      const merged = {
        ...existing,
        ...patch,
        id: existing.id,
        listKey: existing.listKey,
      } as TVal;
      const saved = await this.upsertChoiceValueInTx(tx, ctx, merged);      return saved;
    });
  }

  public async putChoiceValues<
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
  >(ctx: TenantContext, values: readonly TVal[]): Promise<TVal[]> {
    if (values.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TVal[] = [];
      for (const v of values) {
        out.push(await this.upsertChoiceValueInTx(tx, ctx, v));
      }      return out;
    });
  }

  public async deleteChoiceValueById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    if (!id?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.choice_values
          WHERE tenant_id = $1 AND id = $2
          RETURNING tenant_id`,
        [ctx.tenantId, id.trim()],
      );
      if (res.rows[0]) {
        this.assertRowTenant(ctx, res.rows[0].tenant_id, 'choice_values');        return true;
      }
      return false;
    });
  }

  // ============================================================================
  // 4. Custom Field Definitions (`custom_field_definitions`)
  // ============================================================================

  private async upsertCustomFieldInTx<
    TField extends TenantCustomFieldDefinitionRecord,
  >(
    tx: TenantSqlClient,
    ctx: TenantContext,
    def: TField,
    options?: { source?: CustomFieldDefinitionSource },
  ): Promise<TField> {
    if (
      !def.id?.trim() ||
      !def.recordType?.trim() ||
      !def.label?.trim() ||
      !def.fieldType?.trim() ||
      !def.section?.trim()
    ) {
      const err = new Error(
        'CUSTOM_FIELD_VALIDATION_ERROR: Custom field id, recordType, label, fieldType, and section are required.',
      ) as Error & { code: string };
      err.code = 'CUSTOM_FIELD_VALIDATION_ERROR';
      throw err;
    }

    const fieldKey = (def.fieldKey ?? def.id).trim();
    const required = Boolean(def.required ?? false);
    const active = def.active !== undefined ? Boolean(def.active) : true;
    const sortOrder =
      typeof def.sortOrder === 'number' && Number.isFinite(def.sortOrder)
        ? Math.floor(def.sortOrder)
        : 1;
    const source: CustomFieldDefinitionSource =
      options?.source ?? def.source ?? 'admin';
    const updatedAtIso = safeTimestampIso(def.updatedAt);

    const res = await tx.query<CustomFieldDefinitionRow>(
      `INSERT INTO public.custom_field_definitions (
         tenant_id, id, record_type, field_key, label, field_type, section,
         required, active, sort_order, source, updated_at, options_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         record_type = EXCLUDED.record_type,
         field_key = EXCLUDED.field_key,
         label = EXCLUDED.label,
         field_type = EXCLUDED.field_type,
         section = EXCLUDED.section,
         required = EXCLUDED.required,
         active = EXCLUDED.active,
         sort_order = EXCLUDED.sort_order,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at,
         options_json = EXCLUDED.options_json
       RETURNING tenant_id, id, record_type, field_key, label, field_type, section,
                 required, active, sort_order, source, updated_at, options_json`,
      [
        ctx.tenantId,
        def.id.trim(),
        def.recordType.trim(),
        fieldKey,
        def.label.trim(),
        def.fieldType.trim(),
        def.section.trim(),
        required,
        active,
        sortOrder,
        source,
        updatedAtIso,
        JSON.stringify(def),
      ],
    );
    return this.mapCustomFieldRow<TField>(ctx, res.rows[0]!);
  }

  public async listAllCustomFieldDefinitions<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(ctx: TenantContext): Promise<TField[]> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<CustomFieldDefinitionRow>(
        `SELECT tenant_id, id, record_type, field_key, label, field_type, section,
                required, active, sort_order, source, updated_at, options_json
           FROM public.custom_field_definitions
          WHERE tenant_id = $1
          ORDER BY record_type ASC, sort_order ASC, id ASC`,
        [ctx.tenantId],
      );
      return res.rows.map((row) => this.mapCustomFieldRow<TField>(ctx, row));
    });
  }

  public async listCustomFieldDefinitionsForRecordType<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(ctx: TenantContext, recordType: string): Promise<TField[]> {
    if (!recordType?.trim()) return [];
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<CustomFieldDefinitionRow>(
        `SELECT tenant_id, id, record_type, field_key, label, field_type, section,
                required, active, sort_order, source, updated_at, options_json
           FROM public.custom_field_definitions
          WHERE tenant_id = $1 AND record_type = $2
          ORDER BY sort_order ASC, id ASC`,
        [ctx.tenantId, recordType.trim()],
      );
      return res.rows.map((row) => this.mapCustomFieldRow<TField>(ctx, row));
    });
  }

  public async getCustomFieldDefinitionById<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(ctx: TenantContext, id: string): Promise<TField | null> {
    if (!id?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<CustomFieldDefinitionRow>(
        `SELECT tenant_id, id, record_type, field_key, label, field_type, section,
                required, active, sort_order, source, updated_at, options_json
           FROM public.custom_field_definitions
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const row = res.rows[0];
      return row ? this.mapCustomFieldRow<TField>(ctx, row) : null;
    });
  }

  public async putCustomFieldDefinition<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(
    ctx: TenantContext,
    def: TField,
    options?: { source?: CustomFieldDefinitionSource },
  ): Promise<TField> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const saved = await this.upsertCustomFieldInTx(tx, ctx, def, options);      return saved;
    });
  }

  public async updateExistingCustomFieldDefinition<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(ctx: TenantContext, id: string, patch: Partial<TField>): Promise<TField> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const existingRes = await tx.query<CustomFieldDefinitionRow>(
        `SELECT tenant_id, id, record_type, field_key, label, field_type, section,
                required, active, sort_order, source, updated_at, options_json
           FROM public.custom_field_definitions
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id.trim()],
      );
      const existingRow = existingRes.rows[0];
      if (!existingRow) {
        const err = new Error(
          `CUSTOM_FIELD_NOT_FOUND: Custom field "${id}" was not found in tenant "${ctx.tenantId}".`,
        ) as Error & { code: string };
        err.code = 'NOT_FOUND';
        throw err;
      }
      const existing = this.mapCustomFieldRow<TField>(ctx, existingRow);
      const merged = {
        ...existing,
        ...patch,
        id: existing.id,
      } as TField;
      const saved = await this.upsertCustomFieldInTx(tx, ctx, merged);      return saved;
    });
  }

  public async putCustomFieldDefinitions<
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(
    ctx: TenantContext,
    defs: readonly TField[],
    options?: { source?: CustomFieldDefinitionSource },
  ): Promise<TField[]> {
    if (defs.length === 0) return [];
    return this.withTenantTransaction(ctx, async (tx) => {
      const out: TField[] = [];
      for (const d of defs) {
        out.push(await this.upsertCustomFieldInTx(tx, ctx, d, options));
      }      return out;
    });
  }

  public async deleteCustomFieldDefinitionById(
    ctx: TenantContext,
    id: string,
  ): Promise<boolean> {
    if (!id?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.custom_field_definitions
          WHERE tenant_id = $1 AND id = $2
          RETURNING tenant_id`,
        [ctx.tenantId, id.trim()],
      );
      if (res.rows[0]) {
        this.assertRowTenant(
          ctx,
          res.rows[0].tenant_id,
          'custom_field_definitions',
        );        return true;
      }
      return false;
    });
  }

  // ============================================================================
  // 5. Tenant Module Configs (`tenant_module_configs`)
  // ============================================================================

  public async getModuleConfig<TConfig = unknown>(
    ctx: TenantContext,
    configKey: TenantModuleConfigKey,
  ): Promise<TConfig | null> {
    if (!configKey?.trim()) return null;
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<TenantModuleConfigRow>(
        `SELECT tenant_id, config_key, updated_at, updated_by_id, config_json
           FROM public.tenant_module_configs
          WHERE tenant_id = $1 AND config_key = $2`,
        [ctx.tenantId, configKey.trim()],
      );
      const row = res.rows[0];
      if (!row) return null;
      this.assertRowTenant(ctx, row.tenant_id, 'tenant_module_configs');
      return structuredClone(row.config_json) as TConfig;
    });
  }

  public async listAllModuleConfigs(
    ctx: TenantContext,
  ): Promise<Record<string, unknown>> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<TenantModuleConfigRow>(
        `SELECT tenant_id, config_key, updated_at, updated_by_id, config_json
           FROM public.tenant_module_configs
          WHERE tenant_id = $1
          ORDER BY config_key ASC`,
        [ctx.tenantId],
      );
      const out: Record<string, unknown> = {};
      for (const row of res.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'tenant_module_configs');
        out[row.config_key] = structuredClone(row.config_json);
      }
      return out;
    });
  }

  public async putModuleConfig<TConfig = unknown>(
    ctx: TenantContext,
    configKey: TenantModuleConfigKey,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    if (!configKey?.trim()) {
      const err = new Error(
        'CATALOGUE_CONFIG_VALIDATION_ERROR: configKey is required.',
      ) as Error & { code: string };
      err.code = 'CATALOGUE_CONFIG_VALIDATION_ERROR';
      throw err;
    }
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<TenantModuleConfigRow>(
        `INSERT INTO public.tenant_module_configs (
           tenant_id, config_key, updated_at, updated_by_id, config_json
         ) VALUES ($1, $2, NOW(), $3, $4::jsonb)
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET
           updated_at = NOW(),
           updated_by_id = EXCLUDED.updated_by_id,
           config_json = EXCLUDED.config_json
         RETURNING tenant_id, config_key, updated_at, updated_by_id, config_json`,
        [
          ctx.tenantId,
          configKey.trim(),
          updatedById,
          JSON.stringify(config ?? null),
        ],
      );
      const row = res.rows[0]!;
      this.assertRowTenant(ctx, row.tenant_id, 'tenant_module_configs');      return structuredClone(row.config_json) as TConfig;
    });
  }

  public async deleteModuleConfig(
    ctx: TenantContext,
    configKey: TenantModuleConfigKey,
  ): Promise<boolean> {
    if (!configKey?.trim()) return false;
    return this.withTenantTransaction(ctx, async (tx) => {
      const res = await tx.query<{ tenant_id: string }>(
        `DELETE FROM public.tenant_module_configs
          WHERE tenant_id = $1 AND config_key = $2
          RETURNING tenant_id`,
        [ctx.tenantId, configKey.trim()],
      );
      if (res.rows[0]) {
        this.assertRowTenant(
          ctx,
          res.rows[0].tenant_id,
          'tenant_module_configs',
        );        return true;
      }
      return false;
    });
  }

  public async getOrgStructureConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'org_structure');
  }

  public async putOrgStructureConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(ctx, 'org_structure', config, updatedById);
  }

  public async getMatterPartyTaxonomyConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'matter_party_taxonomy');
  }

  public async putMatterPartyTaxonomyConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(
      ctx,
      'matter_party_taxonomy',
      config,
      updatedById,
    );
  }

  public async getMatterPartyMigrationReport<TReport = unknown>(
    ctx: TenantContext,
  ): Promise<TReport | null> {
    return this.getModuleConfig<TReport>(ctx, 'matter_party_migration_report');
  }

  public async putMatterPartyMigrationReport<TReport = unknown>(
    ctx: TenantContext,
    report: TReport,
    updatedById = 'system',
  ): Promise<TReport> {
    return this.putModuleConfig(
      ctx,
      'matter_party_migration_report',
      report,
      updatedById,
    );
  }

  public async getHomePagesConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'home_pages');
  }

  public async putHomePagesConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(ctx, 'home_pages', config, updatedById);
  }

  public async getMatterCostsConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'matter_costs');
  }

  public async putMatterCostsConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(ctx, 'matter_costs', config, updatedById);
  }

  public async getEnquirySettingsConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'enquiry_settings');
  }

  public async putEnquirySettingsConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(ctx, 'enquiry_settings', config, updatedById);
  }

  public async getTaskSettingsConfig<TConfig = unknown>(
    ctx: TenantContext,
  ): Promise<TConfig | null> {
    return this.getModuleConfig<TConfig>(ctx, 'task_settings');
  }

  public async putTaskSettingsConfig<TConfig = unknown>(
    ctx: TenantContext,
    config: TConfig,
    updatedById = 'system',
  ): Promise<TConfig> {
    return this.putModuleConfig(ctx, 'task_settings', config, updatedById);
  }

  public async getCountersConfig(
    ctx: TenantContext,
  ): Promise<Record<string, number> | null> {
    return this.getModuleConfig<Record<string, number>>(ctx, 'counters');
  }

  public async putCountersConfig(
    ctx: TenantContext,
    counters: Record<string, number>,
    updatedById = 'system',
  ): Promise<Record<string, number>> {
    return this.putModuleConfig(ctx, 'counters', counters, updatedById);
  }

  public async getFullCatalogueAndConfigsSnapshot<
    TFirm = Record<string, unknown>,
    TList extends TenantChoiceListRecord = TenantChoiceListRecord,
    TVal extends TenantChoiceValueRecord = TenantChoiceValueRecord,
    TField extends TenantCustomFieldDefinitionRecord = TenantCustomFieldDefinitionRecord,
  >(
    ctx: TenantContext,
    tenantConfig?: Pick<TenantConfiguration, 'customFields'> | null,
  ): Promise<{
    firmProfile: TenantFirmProfileRecord<TFirm> | null;
    lists: TList[];
    values: TVal[];
    customFields: TField[];
    moduleConfigs: Record<string, unknown>;
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const [fpRes, clRes, cvRes, cfRes, mcRes] = await Promise.all([
        tx.query<FirmProfileRow>(
          `SELECT tenant_id, firm_id, is_clean_deployment, updated_at, firm_json
             FROM public.firm_profiles
            WHERE tenant_id = $1`,
          [ctx.tenantId],
        ),
        tx.query<ChoiceListRow>(
          `SELECT tenant_id, key, label, description, allow_hierarchy, system_locked, updated_at, metadata_json
             FROM public.choice_lists
            WHERE tenant_id = $1
            ORDER BY key ASC`,
          [ctx.tenantId],
        ),
        tx.query<ChoiceValueRow>(
          `SELECT tenant_id, id, list_key, code, label, parent_id, sort_order, active, updated_at, metadata_json
             FROM public.choice_values
            WHERE tenant_id = $1
            ORDER BY list_key ASC, sort_order ASC, id ASC`,
          [ctx.tenantId],
        ),
        tx.query<CustomFieldDefinitionRow>(
          `SELECT tenant_id, id, record_type, field_key, label, field_type, section,
                  required, active, sort_order, source, updated_at, options_json
             FROM public.custom_field_definitions
            WHERE tenant_id = $1
            ORDER BY record_type ASC, sort_order ASC, id ASC`,
          [ctx.tenantId],
        ),
        tx.query<TenantModuleConfigRow>(
          `SELECT tenant_id, config_key, updated_at, updated_by_id, config_json
             FROM public.tenant_module_configs
            WHERE tenant_id = $1
            ORDER BY config_key ASC`,
          [ctx.tenantId],
        ),
      ]);
      const fpRow = fpRes.rows[0];
      let firmProfile: TenantFirmProfileRecord<TFirm> | null = null;
      if (fpRow) {
        this.assertRowTenant(ctx, fpRow.tenant_id, 'firm_profiles');
        firmProfile = {
          firmId: fpRow.firm_id,
          isCleanDeployment: Boolean(fpRow.is_clean_deployment),
          firm: structuredClone(fpRow.firm_json) as TFirm,
          updatedAt: toIsoString(fpRow.updated_at),
        };
      }
      const rawLists = clRes.rows.map((r) =>
        this.mapChoiceListRow<TList>(ctx, r),
      );
      const rawValues = cvRes.rows.map((r) =>
        this.mapChoiceValueRow<TVal>(ctx, r),
      );
      const rawFields = cfRes.rows.map((r) =>
        this.mapCustomFieldRow<TField>(ctx, r),
      );
      const merged = mergeDeclarativeTenantConfigCustomFields(
        tenantConfig,
        rawFields,
        rawLists,
        rawValues,
      );
      const moduleConfigs: Record<string, unknown> = {};
      for (const row of mcRes.rows) {
        this.assertRowTenant(ctx, row.tenant_id, 'tenant_module_configs');
        moduleConfigs[row.config_key] = structuredClone(row.config_json);
      }
      return {
        firmProfile,
        lists: merged.lists,
        values: merged.values,
        customFields: merged.customFields,
        moduleConfigs,
      };
    });
  }

  // ============================================================================
  // 6. Audit & Diagnostics
  // ============================================================================

  public async appendCatalogueAuditEntriesInTx(
    ctx: TenantContext,
    entries: readonly FirmAuditEntryInput[],
  ): Promise<FirmAuditEntryRecord[]> {
    if (entries.length === 0) return [];
    return this.auditRepo.appendAuditEntries(ctx, entries);
  }

  public async countAllTenantCatalogueRows(ctx: TenantContext): Promise<{
    hasFirmProfile: boolean;
    choiceLists: number;
    choiceValues: number;
    customFieldDefinitions: number;
    moduleConfigs: number;
    moduleConfigKeys: string[];
  }> {
    return this.withTenantReadTransaction(ctx, async (tx) => {
      const res = await tx.query<{
        fp_cnt: number;
        cl_cnt: number;
        cv_cnt: number;
        cf_cnt: number;
        mc_cnt: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM public.firm_profiles WHERE tenant_id = $1) AS fp_cnt,
           (SELECT COUNT(*)::int FROM public.choice_lists WHERE tenant_id = $1) AS cl_cnt,
           (SELECT COUNT(*)::int FROM public.choice_values WHERE tenant_id = $1) AS cv_cnt,
           (SELECT COUNT(*)::int FROM public.custom_field_definitions WHERE tenant_id = $1) AS cf_cnt,
           (SELECT COUNT(*)::int FROM public.tenant_module_configs WHERE tenant_id = $1) AS mc_cnt`,
        [ctx.tenantId],
      );
      const keysRes = await tx.query<{ config_key: string }>(
        `SELECT config_key
           FROM public.tenant_module_configs
          WHERE tenant_id = $1
          ORDER BY config_key ASC`,
        [ctx.tenantId],
      );
      const row = res.rows[0];
      return {
        hasFirmProfile: Number(row?.fp_cnt ?? 0) > 0,
        choiceLists: Number(row?.cl_cnt ?? 0),
        choiceValues: Number(row?.cv_cnt ?? 0),
        customFieldDefinitions: Number(row?.cf_cnt ?? 0),
        moduleConfigs: Number(row?.mc_cnt ?? 0),
        moduleConfigKeys: keysRes.rows.map((r) => r.config_key),
      };
    });
  }

  public async clearTenantData(ctx: TenantContext): Promise<void> {
    await this.withTenantTransaction(ctx, async (tx) => {
      await tx.query(
        'DELETE FROM public.tenant_module_configs WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.custom_field_definitions WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.choice_values WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.choice_lists WHERE tenant_id = $1',
        [ctx.tenantId],
      );
      await tx.query(
        'DELETE FROM public.firm_profiles WHERE tenant_id = $1',
        [ctx.tenantId],
      );    });
  }
}
