import type {
  FeeArrangementCapEntry,
  TenantConfiguration,
  WorkTypeAutoTaskTemplateConfig,
  WorkTypeConfigItem,
  WorkTypeFeeArrangementCapCategoriesConfig,
  WorkTypeFeeCapOverrideConfig,
  WorkTypeRetentionConfig,
  WorkTypeRiskQuestionConfig,
  WorkTypeRiskQuestionOptionConfig,
  WorkTypesConfiguration,
} from '@platform/core-api';
import type { ChoiceValue } from './types';

export const DEFAULT_WORK_TYPE_RETENTION_YEARS = 6;

export const DEFAULT_WORK_TYPES_CONFIG: WorkTypesConfiguration = {
  defaults: {
    autoTaskTemplates: [],
    riskQuestions: [],
    retention: {
      retentionYears: DEFAULT_WORK_TYPE_RETENTION_YEARS,
      baseline: 'closed_on',
      allowMatterOverride: false,
      statutoryNote: 'Firm standard limitation and file retention policy',
    },
  },
  items: [],
};

export interface EffectiveWorkTypesResolutionInput {
  workTypeSubcategoryId?: string | null;
  practiceAreaId?: string | null;
}

export interface ResolvedWorkTypeRetention extends WorkTypeRetentionConfig {
  source: 'work_type' | 'practice_area' | 'firm_default';
  matchedWorkTypeId: string | null;
}

export interface ResolvedWorkTypeBehaviour {
  effectiveConfig: WorkTypesConfiguration;
  autoTaskTemplates: WorkTypeAutoTaskTemplateConfig[];
  autoTaskSource: 'work_type' | 'practice_area' | 'firm_default';
  riskQuestions: WorkTypeRiskQuestionConfig[];
  retention: ResolvedWorkTypeRetention;
}

function cloneAutoTaskTemplate(
  tpl: WorkTypeAutoTaskTemplateConfig,
): WorkTypeAutoTaskTemplateConfig {
  return {
    id: tpl.id,
    title: tpl.title,
    trigger: tpl.trigger,
    dueWorkingDaysOffset: tpl.dueWorkingDaysOffset,
    priorityId: tpl.priorityId,
    ownerRoleKey: tpl.ownerRoleKey,
  };
}

function cloneRiskQuestion(
  q: WorkTypeRiskQuestionConfig,
): WorkTypeRiskQuestionConfig {
  const options: WorkTypeRiskQuestionOptionConfig[] = [];
  for (const opt of q.options) {
    options.push({
      value: opt.value,
      label: opt.label,
      score: opt.score,
      riskLevel: opt.riskLevel,
    });
  }
  return {
    id: q.id,
    sectionKey: q.sectionKey,
    sectionTitle: q.sectionTitle ?? 'Work-type risk factors',
    prompt: q.prompt,
    weight: q.weight,
    required: q.required !== false,
    options,
  };
}

/**
 * Resolves the effective `workTypes` configuration for a tenant by combining
 * schema-validated declarative config (`tenantConfig.workTypes`) with any
 * tenant PostgreSQL admin overrides (`adminOverride` in `work_type_configs`).
 */
export function resolveEffectiveWorkTypesConfig(
  tenantConfig?: Pick<TenantConfiguration, 'workTypes'> | null,
  adminOverride?: WorkTypesConfiguration | null,
): WorkTypesConfiguration {
  const baseWorkTypes = tenantConfig?.workTypes;
  const fallbackRetention = DEFAULT_WORK_TYPES_CONFIG.defaults.retention;

  const baseDefaults = baseWorkTypes?.defaults;
  const overrideDefaults = adminOverride?.defaults;

  const defaultsRetentionSource =
    overrideDefaults?.retention ?? baseDefaults?.retention;
  const defaultsRetention: WorkTypeRetentionConfig = {
    retentionYears:
      defaultsRetentionSource?.retentionYears ??
      baseDefaults?.retention?.retentionYears ??
      fallbackRetention.retentionYears,
    baseline:
      defaultsRetentionSource?.baseline ??
      baseDefaults?.retention?.baseline ??
      fallbackRetention.baseline,
    allowMatterOverride:
      defaultsRetentionSource?.allowMatterOverride ??
      baseDefaults?.retention?.allowMatterOverride ??
      fallbackRetention.allowMatterOverride,
    statutoryNote:
      defaultsRetentionSource?.statutoryNote ??
      baseDefaults?.retention?.statutoryNote ??
      fallbackRetention.statutoryNote,
  };

  const rawDefaultTemplates =
    overrideDefaults?.autoTaskTemplates ?? baseDefaults?.autoTaskTemplates ?? [];
  const defaultAutoTaskTemplates: WorkTypeAutoTaskTemplateConfig[] = [];
  for (const tpl of rawDefaultTemplates) {
    defaultAutoTaskTemplates.push({
      id: tpl.id,
      title: tpl.title,
      trigger: tpl.trigger ?? 'matter_open',
      dueWorkingDaysOffset: tpl.dueWorkingDaysOffset ?? 5,
      priorityId: tpl.priorityId ?? 'task_priority.normal',
      ownerRoleKey: tpl.ownerRoleKey ?? 'fee_earner',
    });
  }

  const rawDefaultQuestions =
    overrideDefaults?.riskQuestions ?? baseDefaults?.riskQuestions ?? [];
  const defaultRiskQuestions: WorkTypeRiskQuestionConfig[] = [];
  for (const q of rawDefaultQuestions) {
    const clonedOptions: WorkTypeRiskQuestionOptionConfig[] = [];
    for (const opt of q.options ?? []) {
      clonedOptions.push({
        value: opt.value,
        label: opt.label,
        score: opt.score ?? 0,
        riskLevel: opt.riskLevel ?? 'low',
      });
    }
    defaultRiskQuestions.push({
      id: q.id,
      sectionKey: q.sectionKey ?? 'work_type',
      sectionTitle: q.sectionTitle ?? 'Work-type risk factors',
      prompt: q.prompt,
      weight: q.weight ?? 1,
      required: q.required !== false,
      options: clonedOptions,
    });
  }

  const mergedItemsMap = new Map<string, WorkTypeConfigItem>();
  const ingestItems = (source?: { items?: WorkTypeConfigItem[] }) => {
    if (!source?.items) return;
    for (const item of source.items) {
      if (!item || !item.workTypeId) continue;

      const itemAutoTaskTemplates: WorkTypeAutoTaskTemplateConfig[] = [];
      for (const tpl of item.autoTaskTemplates ?? []) {
        itemAutoTaskTemplates.push({
          id: tpl.id,
          title: tpl.title,
          trigger: tpl.trigger ?? 'matter_open',
          dueWorkingDaysOffset: tpl.dueWorkingDaysOffset ?? 5,
          priorityId: tpl.priorityId ?? 'task_priority.normal',
          ownerRoleKey: tpl.ownerRoleKey ?? 'fee_earner',
        });
      }

      const itemRiskQuestions: WorkTypeRiskQuestionConfig[] = [];
      for (const q of item.riskQuestions ?? []) {
        const qOptions: WorkTypeRiskQuestionOptionConfig[] = [];
        for (const opt of q.options ?? []) {
          qOptions.push({
            value: opt.value,
            label: opt.label,
            score: opt.score ?? 0,
            riskLevel: opt.riskLevel ?? 'low',
          });
        }
        itemRiskQuestions.push({
          id: q.id,
          sectionKey: q.sectionKey ?? 'work_type',
          sectionTitle: q.sectionTitle ?? 'Work-type risk factors',
          prompt: q.prompt,
          weight: q.weight ?? 1,
          required: q.required !== false,
          options: qOptions,
        });
      }

      const itemRetention = item.retention
        ? {
            retentionYears:
              item.retention.retentionYears ?? defaultsRetention.retentionYears,
            baseline: item.retention.baseline ?? defaultsRetention.baseline,
            allowMatterOverride:
              item.retention.allowMatterOverride ??
              defaultsRetention.allowMatterOverride,
            statutoryNote:
              item.retention.statutoryNote ?? defaultsRetention.statutoryNote,
          }
        : undefined;

      const cfaCat =
        item.feeArrangementCapCategories?.conditional_fee_agreement;
      const dbaCat =
        item.feeArrangementCapCategories?.damages_based_agreement;
      const itemFeeCapCategories:
        | WorkTypeFeeArrangementCapCategoriesConfig
        | undefined =
        cfaCat || dbaCat
          ? {
              ...(cfaCat ? { conditional_fee_agreement: cfaCat } : {}),
              ...(dbaCat ? { damages_based_agreement: dbaCat } : {}),
            }
          : undefined;

      const itemCapOverrides: WorkTypeFeeCapOverrideConfig[] = [];
      for (const ov of item.workTypeCapOverrides ?? []) {
        itemCapOverrides.push({
          capCategoryKey: ov.capCategoryKey,
          maxPercent: ov.maxPercent,
          capBaseKey: ov.capBaseKey,
        });
      }

      mergedItemsMap.set(item.workTypeId, {
        workTypeId: item.workTypeId,
        practiceAreaId: item.practiceAreaId ?? '',
        active: item.active !== false,
        autoTaskTemplates: itemAutoTaskTemplates,
        riskQuestions: itemRiskQuestions,
        ...(itemRetention ? { retention: itemRetention } : {}),
        ...(itemFeeCapCategories
          ? { feeArrangementCapCategories: itemFeeCapCategories }
          : {}),
        ...(itemCapOverrides.length > 0
          ? { workTypeCapOverrides: itemCapOverrides }
          : {}),
      });
    }
  };

  ingestItems(baseWorkTypes);
  ingestItems(adminOverride ?? undefined);

  return {
    defaults: {
      autoTaskTemplates: defaultAutoTaskTemplates,
      riskQuestions: defaultRiskQuestions,
      retention: defaultsRetention,
    },
    items: Array.from(mergedItemsMap.values()),
  };
}

function findMatchingWorkTypeItems(
  config: WorkTypesConfiguration,
  input: EffectiveWorkTypesResolutionInput,
): {
  subItem: WorkTypeConfigItem | undefined;
  paItem: WorkTypeConfigItem | undefined;
} {
  const activeItems = config.items.filter((i) => i.active !== false);
  const subId = (input.workTypeSubcategoryId ?? '').trim();
  const paId = (input.practiceAreaId ?? '').trim();
  const subItem = subId
    ? activeItems.find((i) => i.workTypeId === subId)
    : undefined;
  const paItem =
    paId && paId !== subId
      ? activeItems.find((i) => i.workTypeId === paId)
      : paId
        ? activeItems.find((i) => i.workTypeId === paId)
        : undefined;
  return { subItem, paItem };
}

export function resolveWorkTypeAutoTaskTemplates(
  config: WorkTypesConfiguration,
  input: EffectiveWorkTypesResolutionInput,
): {
  templates: WorkTypeAutoTaskTemplateConfig[];
  source: 'work_type' | 'practice_area' | 'firm_default';
} {
  const { subItem, paItem } = findMatchingWorkTypeItems(config, input);
  if ((subItem?.autoTaskTemplates?.length ?? 0) > 0) {
    return {
      templates: (subItem!.autoTaskTemplates ?? []).map(cloneAutoTaskTemplate),
      source: 'work_type',
    };
  }
  if ((paItem?.autoTaskTemplates?.length ?? 0) > 0) {
    return {
      templates: (paItem!.autoTaskTemplates ?? []).map(cloneAutoTaskTemplate),
      source: 'practice_area',
    };
  }
  return {
    templates: (config.defaults.autoTaskTemplates ?? []).map(
      cloneAutoTaskTemplate,
    ),
    source: 'firm_default',
  };
}

export function resolveWorkTypeRiskQuestions(
  config: WorkTypesConfiguration,
  input: EffectiveWorkTypesResolutionInput,
): WorkTypeRiskQuestionConfig[] {
  const { subItem, paItem } = findMatchingWorkTypeItems(config, input);
  const byId = new Map<string, WorkTypeRiskQuestionConfig>();

  for (const q of config.defaults.riskQuestions ?? []) {
    byId.set(q.id, cloneRiskQuestion(q));
  }
  for (const q of paItem?.riskQuestions ?? []) {
    byId.set(q.id, cloneRiskQuestion(q));
  }
  for (const q of subItem?.riskQuestions ?? []) {
    byId.set(q.id, cloneRiskQuestion(q));
  }

  return Array.from(byId.values());
}

export function resolveWorkTypeRetention(
  config: WorkTypesConfiguration,
  input: EffectiveWorkTypesResolutionInput,
): ResolvedWorkTypeRetention {
  const { subItem, paItem } = findMatchingWorkTypeItems(config, input);
  if (subItem?.retention) {
    return {
      ...subItem.retention,
      source: 'work_type',
      matchedWorkTypeId: subItem.workTypeId,
    };
  }
  if (paItem?.retention) {
    return {
      ...paItem.retention,
      source: 'practice_area',
      matchedWorkTypeId: paItem.workTypeId,
    };
  }
  return {
    ...config.defaults.retention,
    source: 'firm_default',
    matchedWorkTypeId: null,
  };
}

export interface ResolvedWorkTypeFeeArrangementSettings {
  effectiveWorkTypeId: string;
  feeArrangementCapCategories: WorkTypeFeeArrangementCapCategoriesConfig;
  workTypeCapOverrides: FeeArrangementCapEntry[];
  matchedSource: 'work_type' | 'practice_area' | 'none';
}

/**
 * Resolves CFA/DBA category mappings and per-work-type cap overrides (`R486`),
 * allowing subcategory-level settings to override parent practice-area rules while
 * preserving unmapped slots as `undefined` so validation fails closed.
 */
export function resolveWorkTypeFeeArrangementSettings(
  config: WorkTypesConfiguration,
  input: EffectiveWorkTypesResolutionInput,
): ResolvedWorkTypeFeeArrangementSettings {
  const { subItem, paItem } = findMatchingWorkTypeItems(config, input);
  const effectiveWorkTypeId =
    (subItem?.workTypeId ??
      paItem?.workTypeId ??
      (input.workTypeSubcategoryId ?? '').trim()) ||
    (input.practiceAreaId ?? '').trim();

  const conditional_fee_agreement =
    subItem?.feeArrangementCapCategories?.conditional_fee_agreement ??
    paItem?.feeArrangementCapCategories?.conditional_fee_agreement;
  const damages_based_agreement =
    subItem?.feeArrangementCapCategories?.damages_based_agreement ??
    paItem?.feeArrangementCapCategories?.damages_based_agreement;

  const overridesByCategory = new Map<string, FeeArrangementCapEntry>();
  for (const ov of paItem?.workTypeCapOverrides ?? []) {
    overridesByCategory.set(ov.capCategoryKey, {
      capCategoryKey: ov.capCategoryKey,
      maxPercent: ov.maxPercent,
      capBaseKey: ov.capBaseKey,
    });
  }
  for (const ov of subItem?.workTypeCapOverrides ?? []) {
    overridesByCategory.set(ov.capCategoryKey, {
      capCategoryKey: ov.capCategoryKey,
      maxPercent: ov.maxPercent,
      capBaseKey: ov.capBaseKey,
    });
  }

  return {
    effectiveWorkTypeId,
    feeArrangementCapCategories: {
      ...(conditional_fee_agreement ? { conditional_fee_agreement } : {}),
      ...(damages_based_agreement ? { damages_based_agreement } : {}),
    },
    workTypeCapOverrides: Array.from(overridesByCategory.values()),
    matchedSource: subItem ? 'work_type' : paItem ? 'practice_area' : 'none',
  };
}

export function resolveWorkTypeBehaviour(
  tenantConfig: Pick<TenantConfiguration, 'workTypes'> | null | undefined,
  adminOverride: WorkTypesConfiguration | null | undefined,
  input: EffectiveWorkTypesResolutionInput,
): ResolvedWorkTypeBehaviour {
  const effectiveConfig = resolveEffectiveWorkTypesConfig(
    tenantConfig,
    adminOverride,
  );
  const autoTasks = resolveWorkTypeAutoTaskTemplates(effectiveConfig, input);
  const riskQuestions = resolveWorkTypeRiskQuestions(effectiveConfig, input);
  const retention = resolveWorkTypeRetention(effectiveConfig, input);
  return {
    effectiveConfig,
    autoTaskTemplates: autoTasks.templates,
    autoTaskSource: autoTasks.source,
    riskQuestions,
    retention,
  };
}

export function isLeapYearUtc(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Pure UTC calendar year addition for retention calculations.
 * Clamps 29 Feb to 28 Feb when the target expiry year is not a leap year.
 */
export function calculateDestructionDate(
  closedOnIso: string,
  retentionYears: number,
): string {
  const trimmed = (closedOnIso ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid closure date "${closedOnIso}" for destruction_date calculation.`,
    );
  }
  if (!Number.isInteger(retentionYears) || retentionYears < 1 || retentionYears > 100) {
    throw new Error(
      `Invalid retentionYears ${retentionYears}; must be an integer between 1 and 100.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const targetYear = year + retentionYears;
  const adjustedDay =
    month === 2 && day === 29 && !isLeapYearUtc(targetYear) ? 28 : day;

  return `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(adjustedDay).padStart(2, '0')}`;
}

export function formatRetentionPeriodLabel(retentionYears: number): string {
  return retentionYears === 1 ? '1 year' : `${retentionYears} years`;
}

export function isClosedMatterStatus(
  statusId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): boolean {
  if (!statusId) return false;
  const cv =
    values.find((v) => v.listKey === 'matter_status' && v.id === statusId) ??
    values.find((v) => v.id === statusId);
  if (cv) {
    return cv.systemKey ? cv.systemKey === 'closed' : cv.id === 'matter_status.closed';
  }
  return statusId === 'matter_status.closed';
}

export function isClosedOrArchivedMatterStatus(
  statusId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): boolean {
  if (!statusId) return false;
  if (isClosedMatterStatus(statusId, values)) return true;
  const cv =
    values.find((v) => v.listKey === 'matter_status' && v.id === statusId) ??
    values.find((v) => v.id === statusId);
  if (cv) {
    return cv.systemKey ? cv.systemKey === 'archived' : cv.id === 'matter_status.archived';
  }
  return statusId === 'matter_status.archived';
}

export function isProspectiveMatterStatus(
  statusId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey'>[] = [],
): boolean {
  if (!statusId) return false;
  const cv =
    values.find((v) => v.listKey === 'matter_status' && v.id === statusId) ??
    values.find((v) => v.id === statusId);
  if (cv) {
    return cv.systemKey
      ? cv.systemKey === 'prospective'
      : cv.id === 'matter_status.prospective';
  }
  return statusId === 'matter_status.prospective';
}

/**
 * Resolves a tenant's active matter status by stable `systemKey` (or canonical ID
 * when `systemKey` is absent). Never matches display labels and never falls back to a
 * hard-coded ID when absent or deactivated.
 */
export function resolveMatterLifecycleTargetStatusId(
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'systemKey' | 'active'>[],
  targetSystemKey: 'closed' | 'active',
): string | null {
  const activeStatuses = values.filter(
    (v) => v.listKey === 'matter_status' && v.active !== false,
  );
  const bySystemKey = activeStatuses.find((v) => v.systemKey === targetSystemKey);
  if (bySystemKey) return bySystemKey.id;
  const canonicalId = `matter_status.${targetSystemKey}`;
  const byCanonicalId = activeStatuses.find(
    (v) => !v.systemKey && v.id === canonicalId,
  );
  return byCanonicalId?.id ?? null;
}

/**
 * Validates a matter closure date (`YYYY-MM-DD`) against real calendar validity,
 * the matter's opened date (`openedAt <= closedAt`), and the tenant's local today
 * (`closedAt <= tenantTodayIso`).
 */
export function validateMatterClosureDate(params: {
  rawClosedAt?: string | null;
  openedAt?: string | null;
  tenantTodayIso: string;
  timeZone?: string;
}):
  | { ok: true; closedAt: string }
  | { ok: false; code: 'INVALID_CLOSURE_DATE'; message: string } {
  const trimmed = (params.rawClosedAt ?? '').trim();
  const candidate = trimmed || params.tenantTodayIso;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE_DATE',
      message: 'INVALID_CLOSURE_DATE: Closure date must be formatted as YYYY-MM-DD.',
    };
  }
  const [year, month, day] = candidate.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE_DATE',
      message: 'INVALID_CLOSURE_DATE: Closure date must be a valid calendar date.',
    };
  }
  if (candidate > params.tenantTodayIso) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE_DATE',
      message: `INVALID_CLOSURE_DATE: Closure date (${candidate}) cannot be in the future (today in ${params.timeZone || 'Europe/London'} is ${params.tenantTodayIso}).`,
    };
  }
  const openedDateIso = (params.openedAt ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openedDateIso)) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE_DATE',
      message:
        'INVALID_CLOSURE_DATE: Cannot close a matter before it has a valid opened date.',
    };
  }
  if (candidate < openedDateIso) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE_DATE',
      message: `INVALID_CLOSURE_DATE: Closure date (${candidate}) cannot be earlier than the matter opened date (${openedDateIso}).`,
    };
  }
  return { ok: true, closedAt: candidate };
}
