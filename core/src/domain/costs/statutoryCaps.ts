/**
 * Pure statutory CFA/DBA fee cap resolution and fail-closed validation
 * (`core/src/domain/costs/statutoryCaps.ts`, ADR 0034 §3 / S0-28b).
 *
 * Precedence (`R486`, WP5 owner decisions):
 * - `applicableCap = workTypeCap ?? firmCap ?? statutoryMax`, bounded above by `statutoryMax`.
 * - A work-type cap override may sit above or below the firm's general cap, provided it does
 *   not exceed the statutory maximum for its category.
 * - Every percentage is paired with and validated against its defined `capBaseKey` and
 *   `capBaseDescription`; bare percentages without matching bases are rejected fail closed.
 * - Zero override path exists above applicable caps (no Risk or Partner override).
 */

import statutoryFeeCapsJson from './statutory-fee-caps.json';
import {
  doEffectiveDateRangesOverlap,
  isRateOverrideEffectiveOnDate,
  isValidIsoCalendarDate,
} from './rates';

export const FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE =
  'FEE_CAP_CONFIG_EXCEEDS_STATUTORY' as const;
export const FEE_CAP_CATEGORY_UNMAPPED_CODE =
  'FEE_CAP_CATEGORY_UNMAPPED' as const;
export const FEE_CAP_BASE_MISMATCH_CODE = 'FEE_CAP_BASE_MISMATCH' as const;
export const FEE_CAP_EXCEEDED_WORK_TYPE_CODE =
  'FEE_CAP_EXCEEDED_WORK_TYPE' as const;
export const FEE_CAP_EXCEEDED_FIRM_CODE = 'FEE_CAP_EXCEEDED_FIRM' as const;
export const FEE_CAP_EXCEEDED_STATUTORY_CODE =
  'FEE_CAP_EXCEEDED_STATUTORY' as const;

export type FeeCapErrorCode =
  | typeof FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE
  | typeof FEE_CAP_CATEGORY_UNMAPPED_CODE
  | typeof FEE_CAP_BASE_MISMATCH_CODE
  | typeof FEE_CAP_EXCEEDED_WORK_TYPE_CODE
  | typeof FEE_CAP_EXCEEDED_FIRM_CODE
  | typeof FEE_CAP_EXCEEDED_STATUTORY_CODE;

export type FeeArrangementBasis =
  | 'conditional_fee_agreement'
  | 'damages_based_agreement';

export const STATUTORY_FEE_CAP_CATEGORY_KEYS = [
  'cfa_general_civil',
  'cfa_personal_injury',
  'dba_general_civil',
  'dba_employment',
  'dba_personal_injury',
] as const;

export type StatutoryFeeCapCategoryKey =
  (typeof STATUTORY_FEE_CAP_CATEGORY_KEYS)[number];

export interface StatutoryFeeCapRow {
  rowId: string;
  capCategoryKey: StatutoryFeeCapCategoryKey | (string & {});
  feeBasis: FeeArrangementBasis;
  caseTypeLabel: string;
  maxPercent: number;
  capBaseKey: string;
  capBaseDescription: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  legislationRef: string;
}

export interface StatutoryFeeCapsTable {
  schemaVersion: string;
  rows: StatutoryFeeCapRow[];
}

export interface FeeArrangementCapEntry {
  capCategoryKey: StatutoryFeeCapCategoryKey | (string & {});
  maxPercent: number;
  capBaseKey: string;
}

export interface WorkTypeFeeArrangementCapCategories {
  conditional_fee_agreement?: string;
  damages_based_agreement?: string;
}

export type FeeCapLevel = 'work_type' | 'firm' | 'statutory';

export interface EffectiveFeeCapResolution {
  capCategoryKey: string;
  feeBasis: FeeArrangementBasis;
  caseTypeLabel: string;
  capBaseKey: string;
  capBaseDescription: string;
  statutoryMaxPercent: number;
  firmCapPercent: number | null;
  workTypeCapPercent: number | null;
  appliedCapPercent: number;
  capLevel: FeeCapLevel;
  legislationRef: string;
  statutoryRowId: string;
}

export interface FeeArrangementValidationInput {
  feeBasis: FeeArrangementBasis;
  workTypeId?: string | null;
  workTypeCapCategories?: WorkTypeFeeArrangementCapCategories | null;
  submittedCapCategoryKey?: string | null;
  submittedPercent: number | null | undefined;
  submittedCapBaseKey?: string | null;
  firmCaps?: readonly FeeArrangementCapEntry[] | null;
  workTypeCapOverrides?: readonly FeeArrangementCapEntry[] | null;
  asAtDate?: string | null;
  statutoryTable?: StatutoryFeeCapsTable | null;
}

export type FeeArrangementValidationResult =
  | {
      ok: true;
      resolution: EffectiveFeeCapResolution;
      acceptedPercent: number;
    }
  | {
      ok: false;
      code: FeeCapErrorCode;
      message: string;
    };

export class FeeCapValidationError extends Error {
  public readonly code: FeeCapErrorCode;

  constructor(code: FeeCapErrorCode, message: string) {
    super(message);
    this.name = 'FeeCapValidationError';
    this.code = code;
  }
}

export const STATUTORY_FEE_CAPS_TABLE: StatutoryFeeCapsTable =
  validateStatutoryFeeCapsTable(statutoryFeeCapsJson);

function todayIsoUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normaliseAsAtDate(asAtDate?: string | null): string {
  const trimmed = asAtDate?.trim();
  if (!trimmed) {
    return todayIsoUtcDate();
  }
  if (!isValidIsoCalendarDate(trimmed)) {
    throw new FeeCapValidationError(
      FEE_CAP_CATEGORY_UNMAPPED_CODE,
      `Invalid statutory fee cap effective date '${trimmed}'. Expected YYYY-MM-DD.`,
    );
  }
  return trimmed;
}

function formatCapLevelLabel(capLevel: FeeCapLevel): string {
  switch (capLevel) {
    case 'work_type':
      return 'work type cap';
    case 'firm':
      return 'firm cap';
    case 'statutory':
      return 'statutory maximum';
  }
}

export function isFeeArrangementBasis(
  basis: string | null | undefined,
): basis is FeeArrangementBasis {
  return (
    basis === 'conditional_fee_agreement' ||
    basis === 'damages_based_agreement'
  );
}

export function isStatutoryFeeCapCategoryKey(
  value: string | null | undefined,
): value is StatutoryFeeCapCategoryKey {
  return (STATUTORY_FEE_CAP_CATEGORY_KEYS as readonly string[]).includes(
    value ?? '',
  );
}

/**
 * Validates the core effective-dated statutory fee cap table structure and checks
 * that rows for the same `capCategoryKey` never overlap in effective dates.
 */
export function validateStatutoryFeeCapsTable(
  raw: unknown,
): StatutoryFeeCapsTable {
  if (!raw || typeof raw !== 'object') {
    throw new Error('STATUTORY_FEE_CAPS_INVALID: Table must be an object.');
  }
  const candidate = raw as Partial<StatutoryFeeCapsTable>;
  if (candidate.schemaVersion !== '1.0.0') {
    throw new Error(
      `STATUTORY_FEE_CAPS_INVALID: Unsupported schemaVersion '${String(candidate.schemaVersion)}'.`,
    );
  }
  if (!Array.isArray(candidate.rows) || candidate.rows.length === 0) {
    throw new Error('STATUTORY_FEE_CAPS_INVALID: rows must be a non-empty array.');
  }

  const seenRowIds = new Set<string>();
  const rowsByCategory = new Map<string, StatutoryFeeCapRow[]>();

  for (const row of candidate.rows) {
    if (!row || typeof row !== 'object') {
      throw new Error('STATUTORY_FEE_CAPS_INVALID: Each row must be an object.');
    }
    const r = row as StatutoryFeeCapRow;
    if (typeof r.rowId !== 'string' || !r.rowId.trim()) {
      throw new Error('STATUTORY_FEE_CAPS_INVALID: rowId is required.');
    }
    if (seenRowIds.has(r.rowId)) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: Duplicate rowId '${r.rowId}'.`,
      );
    }
    seenRowIds.add(r.rowId);

    if (!isStatutoryFeeCapCategoryKey(r.capCategoryKey)) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: Unknown capCategoryKey '${String(r.capCategoryKey)}' on row '${r.rowId}'.`,
      );
    }
    if (!isFeeArrangementBasis(r.feeBasis)) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: Invalid feeBasis '${String(r.feeBasis)}' on row '${r.rowId}'.`,
      );
    }
    const expectedPrefix =
      r.feeBasis === 'conditional_fee_agreement' ? 'cfa_' : 'dba_';
    if (!r.capCategoryKey.startsWith(expectedPrefix)) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: Category '${r.capCategoryKey}' does not match feeBasis '${r.feeBasis}'.`,
      );
    }
    if (typeof r.caseTypeLabel !== 'string' || !r.caseTypeLabel.trim()) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: caseTypeLabel is required on row '${r.rowId}'.`,
      );
    }
    if (
      typeof r.maxPercent !== 'number' ||
      !Number.isFinite(r.maxPercent) ||
      r.maxPercent < 0 ||
      r.maxPercent > 100
    ) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: maxPercent must be between 0 and 100 on row '${r.rowId}'.`,
      );
    }
    if (typeof r.capBaseKey !== 'string' || !r.capBaseKey.trim()) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: capBaseKey is required on row '${r.rowId}'.`,
      );
    }
    if (
      typeof r.capBaseDescription !== 'string' ||
      !r.capBaseDescription.trim()
    ) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: capBaseDescription is required on row '${r.rowId}'.`,
      );
    }
    if (typeof r.effectiveFrom !== 'string' || !isValidIsoCalendarDate(r.effectiveFrom)) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: effectiveFrom must be a valid YYYY-MM-DD date on row '${r.rowId}'.`,
      );
    }
    if (
      r.effectiveTo !== null &&
      (typeof r.effectiveTo !== 'string' || !isValidIsoCalendarDate(r.effectiveTo))
    ) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: effectiveTo must be null or a valid YYYY-MM-DD date on row '${r.rowId}'.`,
      );
    }
    if (r.effectiveTo !== null && r.effectiveTo < r.effectiveFrom) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: effectiveTo precedes effectiveFrom on row '${r.rowId}'.`,
      );
    }
    if (typeof r.legislationRef !== 'string' || !r.legislationRef.trim()) {
      throw new Error(
        `STATUTORY_FEE_CAPS_INVALID: legislationRef is required on row '${r.rowId}'.`,
      );
    }

    const existing = rowsByCategory.get(r.capCategoryKey) ?? [];
    for (const prev of existing) {
      if (
        doEffectiveDateRangesOverlap(
          prev.effectiveFrom,
          prev.effectiveTo,
          r.effectiveFrom,
          r.effectiveTo,
        )
      ) {
        throw new Error(
          `STATUTORY_FEE_CAPS_INVALID: Overlapping effective date ranges for '${r.capCategoryKey}' (${prev.rowId} and ${r.rowId}).`,
        );
      }
    }
    existing.push(r);
    rowsByCategory.set(r.capCategoryKey, existing);
  }

  return candidate as StatutoryFeeCapsTable;
}

/**
 * Lists all active statutory fee cap rows on `asAtDate` (defaulting to today UTC).
 */
export function listActiveStatutoryFeeCaps(
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
): StatutoryFeeCapRow[] {
  const effectiveDate = normaliseAsAtDate(asAtDate);
  const resolvedTable = table ?? STATUTORY_FEE_CAPS_TABLE;
  return resolvedTable.rows
    .filter((row) =>
      isRateOverrideEffectiveOnDate(
        { effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo },
        effectiveDate,
      ),
    )
    .map((row) => ({ ...row }));
}

/**
 * Returns the active statutory fee cap row for `capCategoryKey` on `asAtDate`,
 * or `null` if none exists.
 */
export function getStatutoryFeeCap(
  capCategoryKey: string,
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
): StatutoryFeeCapRow | null {
  const key = capCategoryKey.trim();
  if (!key) return null;
  const active = listActiveStatutoryFeeCaps(asAtDate, table);
  return active.find((row) => row.capCategoryKey === key) ?? null;
}

/**
 * Builds the default firm `feeArrangementCaps` array from active statutory maximums
 * (Owner Decision 1: firm defaults equal statutory maximums with paired bases).
 */
export function createDefaultFirmFeeArrangementCaps(
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
): Array<{
  capCategoryKey: StatutoryFeeCapCategoryKey;
  maxPercent: number;
  capBaseKey: string;
}> {
  return listActiveStatutoryFeeCaps(asAtDate, table).map((row) => ({
    capCategoryKey: row.capCategoryKey as StatutoryFeeCapCategoryKey,
    maxPercent: row.maxPercent,
    capBaseKey: row.capBaseKey,
  }));
}

function validateCapEntriesAgainstStatutory(
  entries: readonly FeeArrangementCapEntry[] | null | undefined,
  scope: 'firm' | 'work_type',
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
): { ok: true; entries: FeeArrangementCapEntry[] } | { ok: false; code: FeeCapErrorCode; message: string } {
  const list = entries ?? [];
  const seenCategories = new Set<string>();
  const normalized: FeeArrangementCapEntry[] = [];
  const scopeLabel = scope === 'work_type' ? 'work type' : 'firm';

  for (const entry of list) {
    const capCategoryKey = (entry.capCategoryKey ?? '').trim();
    if (!capCategoryKey) {
      return {
        ok: false,
        code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
        message: `Each ${scopeLabel} cap entry must specify a capCategoryKey.`,
      };
    }
    if (seenCategories.has(capCategoryKey)) {
      return {
        ok: false,
        code: FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE,
        message: `Duplicate ${scopeLabel} fee cap entry for category '${capCategoryKey}'.`,
      };
    }
    seenCategories.add(capCategoryKey);

    const statutory = getStatutoryFeeCap(capCategoryKey, asAtDate, table);
    if (!statutory) {
      return {
        ok: false,
        code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
        message: `Unknown CFA/DBA statutory cap category '${capCategoryKey}'.`,
      };
    }

    const capBaseKey = (entry.capBaseKey ?? '').trim();
    if (!capBaseKey || capBaseKey !== statutory.capBaseKey) {
      return {
        ok: false,
        code: FEE_CAP_BASE_MISMATCH_CODE,
        message: `Calculation base '${capBaseKey || '(missing)'}' for '${capCategoryKey}' must match the statutory base '${statutory.capBaseKey}' (${statutory.capBaseDescription}).`,
      };
    }

    if (
      typeof entry.maxPercent !== 'number' ||
      !Number.isFinite(entry.maxPercent) ||
      entry.maxPercent < 0 ||
      entry.maxPercent > statutory.maxPercent
    ) {
      return {
        ok: false,
        code: FEE_CAP_CONFIG_EXCEEDS_STATUTORY_CODE,
        message: `Configured ${scopeLabel} cap (${entry.maxPercent}%) for '${capCategoryKey}' cannot exceed the statutory maximum of ${statutory.maxPercent}% of ${statutory.capBaseDescription}.`,
      };
    }

    normalized.push({
      capCategoryKey: statutory.capCategoryKey,
      maxPercent: entry.maxPercent,
      capBaseKey: statutory.capBaseKey,
    });
  }

  return { ok: true, entries: normalized };
}

/**
 * Validates firm-level `matterCosts.feeArrangementCaps` entries against active statutory maximums
 * and locked calculation bases. Rejects any cap above `statutoryMax` with `FEE_CAP_CONFIG_EXCEEDS_STATUTORY`.
 */
export function validateFirmFeeCapEntries(
  entries: readonly FeeArrangementCapEntry[] | null | undefined,
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
) {
  return validateCapEntriesAgainstStatutory(entries, 'firm', asAtDate, table);
}

/**
 * Validates work-type cap overrides (`R486`): overrides may be higher or lower than firm caps,
 * but are rejected fail closed if they exceed the statutory maximum (`FEE_CAP_CONFIG_EXCEEDS_STATUTORY`)
 * or mismatch the category's statutory calculation base (`FEE_CAP_BASE_MISMATCH`).
 */
export function validateWorkTypeCapOverrides(
  entries: readonly FeeArrangementCapEntry[] | null | undefined,
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
) {
  return validateCapEntriesAgainstStatutory(
    entries,
    'work_type',
    asAtDate,
    table,
  );
}

/**
 * Validates that every configured category in `workTypeCapCategories` belongs to the matching
 * fee arrangement basis in the active statutory table.
 */
export function validateWorkTypeFeeArrangementCapCategories(
  categories: WorkTypeFeeArrangementCapCategories | null | undefined,
  asAtDate?: string | null,
  table?: StatutoryFeeCapsTable | null,
): { ok: true } | { ok: false; code: FeeCapErrorCode; message: string } {
  if (!categories) {
    return { ok: true };
  }
  const checks: Array<[FeeArrangementBasis, string | undefined]> = [
    ['conditional_fee_agreement', categories.conditional_fee_agreement],
    ['damages_based_agreement', categories.damages_based_agreement],
  ];
  for (const [basis, rawCategoryKey] of checks) {
    const trimmed = rawCategoryKey?.trim();
    if (!trimmed) continue;
    const statutory = getStatutoryFeeCap(trimmed, asAtDate, table);
    if (!statutory) {
      return {
        ok: false,
        code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
        message: `Work-type cap category '${trimmed}' is not a recognised statutory CFA/DBA category.`,
      };
    }
    if (statutory.feeBasis !== basis) {
      return {
        ok: false,
        code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
        message: `Work-type cap category '${trimmed}' belongs to '${statutory.feeBasis}' and cannot be mapped to '${basis}'.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Resolves the effective cap for a statutory category under `R486`:
 * `applicableCap = workTypeCap ?? firmCap ?? statutoryMax`, bounded above by `statutoryMax`.
 */
export function resolveEffectiveFeeCaps(params: {
  capCategoryKey: string;
  firmCaps?: readonly FeeArrangementCapEntry[] | null;
  workTypeCapOverrides?: readonly FeeArrangementCapEntry[] | null;
  asAtDate?: string | null;
  statutoryTable?: StatutoryFeeCapsTable | null;
}):
  | { ok: true; resolution: EffectiveFeeCapResolution }
  | { ok: false; code: FeeCapErrorCode; message: string } {
  const statutory = getStatutoryFeeCap(
    params.capCategoryKey,
    params.asAtDate,
    params.statutoryTable,
  );
  if (!statutory) {
    return {
      ok: false,
      code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
      message: `No statutory fee cap category matches '${params.capCategoryKey}'.`,
    };
  }

  const firmEntry = (params.firmCaps ?? []).find(
    (entry) => entry.capCategoryKey === statutory.capCategoryKey,
  );
  const workTypeEntry = (params.workTypeCapOverrides ?? []).find(
    (entry) => entry.capCategoryKey === statutory.capCategoryKey,
  );

  if (firmEntry && firmEntry.capBaseKey.trim() !== statutory.capBaseKey) {
    return {
      ok: false,
      code: FEE_CAP_BASE_MISMATCH_CODE,
      message: `Firm cap configuration base '${firmEntry.capBaseKey}' does not match statutory base '${statutory.capBaseKey}'.`,
    };
  }
  if (workTypeEntry && workTypeEntry.capBaseKey.trim() !== statutory.capBaseKey) {
    return {
      ok: false,
      code: FEE_CAP_BASE_MISMATCH_CODE,
      message: `Work-type cap override base '${workTypeEntry.capBaseKey}' does not match statutory base '${statutory.capBaseKey}'.`,
    };
  }

  const firmCapPercent =
    firmEntry && typeof firmEntry.maxPercent === 'number'
      ? firmEntry.maxPercent
      : null;
  const workTypeCapPercent =
    workTypeEntry && typeof workTypeEntry.maxPercent === 'number'
      ? workTypeEntry.maxPercent
      : null;

  let rawAppliedPercent: number;
  let candidateLevel: FeeCapLevel;

  if (workTypeCapPercent !== null) {
    rawAppliedPercent = workTypeCapPercent;
    candidateLevel = 'work_type';
  } else if (firmCapPercent !== null) {
    rawAppliedPercent = firmCapPercent;
    candidateLevel =
      firmCapPercent < statutory.maxPercent ? 'firm' : 'statutory';
  } else {
    rawAppliedPercent = statutory.maxPercent;
    candidateLevel = 'statutory';
  }

  const boundedAbove = rawAppliedPercent > statutory.maxPercent;
  const appliedCapPercent = boundedAbove
    ? statutory.maxPercent
    : rawAppliedPercent;
  const capLevel: FeeCapLevel = boundedAbove ? 'statutory' : candidateLevel;

  return {
    ok: true,
    resolution: {
      capCategoryKey: statutory.capCategoryKey,
      feeBasis: statutory.feeBasis,
      caseTypeLabel: statutory.caseTypeLabel,
      capBaseKey: statutory.capBaseKey,
      capBaseDescription: statutory.capBaseDescription,
      statutoryMaxPercent: statutory.maxPercent,
      firmCapPercent,
      workTypeCapPercent,
      appliedCapPercent,
      capLevel,
      legislationRef: statutory.legislationRef,
      statutoryRowId: statutory.rowId,
    },
  };
}

/**
 * Validates submitted CFA/DBA terms against the work type's mapped statutory category,
 * mandatory calculation base (`capBaseKey`), and resolved `R486` cap (`workType ?? firm ?? statutory`).
 * Fails closed when work type / category is unmapped (`FEE_CAP_CATEGORY_UNMAPPED`), base mismatches
 * (`FEE_CAP_BASE_MISMATCH`), or percentage exceeds applicable cap (`FEE_CAP_EXCEEDED_*`).
 */
export function validateFeeArrangementTerms(
  input: FeeArrangementValidationInput,
): FeeArrangementValidationResult {
  const workTypeId = input.workTypeId?.trim() ?? '';
  if (!workTypeId) {
    return {
      ok: false,
      code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
      message: `A work type with a configured CFA/DBA statutory cap category is required before agreeing a ${
        input.feeBasis === 'conditional_fee_agreement' ? 'CFA' : 'DBA'
      } fee arrangement.`,
    };
  }

  const mappedCategoryKey =
    input.feeBasis === 'conditional_fee_agreement'
      ? input.workTypeCapCategories?.conditional_fee_agreement?.trim()
      : input.workTypeCapCategories?.damages_based_agreement?.trim();

  if (!mappedCategoryKey) {
    return {
      ok: false,
      code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
      message: `Work type '${workTypeId}' does not have a mapped ${
        input.feeBasis === 'conditional_fee_agreement' ? 'CFA' : 'DBA'
      } cap category in work-type configuration.`,
    };
  }

  const submittedCategory = input.submittedCapCategoryKey?.trim();
  if (submittedCategory && submittedCategory !== mappedCategoryKey) {
    return {
      ok: false,
      code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
      message: `Submitted cap category '${submittedCategory}' does not match work type '${workTypeId}' mapped category '${mappedCategoryKey}'.`,
    };
  }

  const capResult = resolveEffectiveFeeCaps({
    capCategoryKey: mappedCategoryKey,
    firmCaps: input.firmCaps,
    workTypeCapOverrides: input.workTypeCapOverrides,
    asAtDate: input.asAtDate,
    statutoryTable: input.statutoryTable,
  });
  if (!capResult.ok) {
    return capResult;
  }

  const { resolution } = capResult;
  if (resolution.feeBasis !== input.feeBasis) {
    return {
      ok: false,
      code: FEE_CAP_CATEGORY_UNMAPPED_CODE,
      message: `Mapped cap category '${resolution.capCategoryKey}' is valid for '${resolution.feeBasis}', not '${input.feeBasis}'.`,
    };
  }

  const submittedBase = input.submittedCapBaseKey?.trim() ?? '';
  if (!submittedBase || submittedBase !== resolution.capBaseKey) {
    return {
      ok: false,
      code: FEE_CAP_BASE_MISMATCH_CODE,
      message: `Fee percentage calculation base '${submittedBase || '(missing)'}' does not match the required base '${resolution.capBaseKey}' (${resolution.capBaseDescription}) for '${resolution.capCategoryKey}'.`,
    };
  }

  const pct = input.submittedPercent;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) {
    return {
      ok: false,
      code: FEE_CAP_EXCEEDED_STATUTORY_CODE,
      message: `Fee percentage must be a finite number between 0% and the applicable ${formatCapLevelLabel(resolution.capLevel)} of ${resolution.appliedCapPercent}% of ${resolution.capBaseDescription}.`,
    };
  }

  if (pct > resolution.statutoryMaxPercent) {
    return {
      ok: false,
      code: FEE_CAP_EXCEEDED_STATUTORY_CODE,
      message: `Submitted percentage of ${pct}% exceeds the statutory maximum of ${resolution.statutoryMaxPercent}% of ${resolution.capBaseDescription} for '${resolution.capCategoryKey}'.`,
    };
  }

  if (pct > resolution.appliedCapPercent) {
    const code: FeeCapErrorCode =
      resolution.capLevel === 'work_type'
        ? FEE_CAP_EXCEEDED_WORK_TYPE_CODE
        : resolution.capLevel === 'firm'
          ? FEE_CAP_EXCEEDED_FIRM_CODE
          : FEE_CAP_EXCEEDED_STATUTORY_CODE;
    return {
      ok: false,
      code,
      message: `Submitted percentage of ${pct}% exceeds the ${formatCapLevelLabel(resolution.capLevel)} of ${resolution.appliedCapPercent}% of ${resolution.capBaseDescription} for '${resolution.capCategoryKey}'.`,
    };
  }

  return {
    ok: true,
    resolution,
    acceptedPercent: pct,
  };
}
