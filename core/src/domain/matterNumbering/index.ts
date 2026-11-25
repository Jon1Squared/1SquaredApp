/**
 * Configurable Matter Numbering & Opening Gate Defaults (`@platform/core`).
 *
 * Implements S1-05 (ADR 0040 & R760 Lever 3):
 * - Five core pattern tokens: `{CLIENT_REF}`, `{SEQ}` / `{SEQ:1..8}`, `{YYYY}`, `{YY}`, `{DEPT}`.
 * - Four sequence scopes: `client_ref_prefix`, `firm`, `year`, `department`.
 * - Exact byte-for-byte R745 parity on default `{CLIENT_REF}-{SEQ:4}` (using legacy cleaning -> `MAT001`
 *   with zero 64-char truncation on long client references).
 */

import type {
  MatterNumberingConfig,
  MatterNumberingSequenceScope,
  TenantConfiguration,
  WorkTypeOpeningGateConfig,
} from '../../api/index';

export const MATTER_NUMBERING_ERROR_CODES = {
  VALIDATION_ERROR: 'MATTER_NUMBERING_VALIDATION_ERROR',
  IMMUTABLE: 'MATTER_NUMBER_IMMUTABLE',
} as const;

export const SUPPORTED_MATTER_NUMBER_TOKENS = [
  'CLIENT_REF',
  'SEQ',
  'YYYY',
  'YY',
  'DEPT',
] as const;

export const MATTER_NUMBER_SEQUENCE_SCOPES: readonly MatterNumberingSequenceScope[] =
  Object.freeze(['client_ref_prefix', 'firm', 'year', 'department']);

export const DEFAULT_MATTER_NUMBERING_CONFIG: MatterNumberingConfig = Object.freeze({
  pattern: '{CLIENT_REF}-{SEQ:4}',
  sequenceScope: 'client_ref_prefix',
  emptyTokenFallback: 'MAT',
});

export const DEFAULT_WORK_TYPE_OPENING_GATE: WorkTypeOpeningGateConfig = Object.freeze({
  requireConflictCleared: false,
  requireCddComplete: false,
  allowCddOverride: true,
  requireEngagementSigned: false,
  requireFundsOnAccount: false,
});

export interface MatterNumberFormatContext {
  clientRefPrefix?: string | null;
  departmentCode?: string | null;
  nowDate?: Date;
  timeZone?: string | null;
}

export interface MatterNumberAllocationResult {
  matterNumber: string;
  sequenceKey: string;
  sequenceValue: number;
}

/**
 * Exact legacy client-reference cleaning (`core/src/tenancy/matterRepository.ts:718-722`, `R745`).
 * Uppercases, strips characters outside `[A-Z0-9_-]`, and falls back to `'MAT001'`.
 */
export function cleanLegacyClientRefPrefix(rawPrefix?: string | null): string {
  return (
    rawPrefix
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '') || 'MAT001'
  );
}

/**
 * Normalises a configurable token replacement (such as `{DEPT}`) to `[A-Z0-9_-]`
 * and falls back to `emptyTokenFallback`.
 */
export function cleanCustomTokenValue(
  rawValue?: string | null,
  fallback = DEFAULT_MATTER_NUMBERING_CONFIG.emptyTokenFallback,
): string {
  const cleanFallback =
    fallback
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '') || 'MAT';
  return (
    rawValue
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '') || cleanFallback
  );
}

export function validateMatterNumberPattern(
  pattern: string,
): { ok: true; seqPadWidth: number } | { ok: false; error: string } {
  if (typeof pattern !== 'string') {
    return { ok: false, error: 'Matter number pattern must be a string.' };
  }
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > 64) {
    return {
      ok: false,
      error: 'Matter number pattern must be between 1 and 64 characters.',
    };
  }
  if (trimmed !== pattern) {
    return {
      ok: false,
      error: 'Matter number pattern cannot start or end with whitespace.',
    };
  }

  let seqCount = 0;
  let seqPadWidth = 4;
  let literalText = '';
  let cursor = 0;

  while (cursor < trimmed.length) {
    const openIdx = trimmed.indexOf('{', cursor);
    if (openIdx === -1) {
      const rest = trimmed.slice(cursor);
      if (rest.includes('}')) {
        return {
          ok: false,
          error: 'Matter number pattern contains an unmatched "}" brace.',
        };
      }
      literalText += rest;
      break;
    }

    const literalChunk = trimmed.slice(cursor, openIdx);
    if (literalChunk.includes('}')) {
      return {
        ok: false,
        error: 'Matter number pattern contains an unmatched "}" brace.',
      };
    }
    literalText += literalChunk;

    const closeIdx = trimmed.indexOf('}', openIdx + 1);
    if (closeIdx === -1) {
      return {
        ok: false,
        error: 'Matter number pattern contains an unclosed "{" token.',
      };
    }

    const tokenBody = trimmed.slice(openIdx + 1, closeIdx);
    if (tokenBody.includes('{')) {
      return {
        ok: false,
        error: 'Matter number pattern contains nested braces.',
      };
    }

    if (tokenBody === 'SEQ') {
      seqCount += 1;
      seqPadWidth = 4;
    } else if (/^SEQ:([1-8])$/.test(tokenBody)) {
      seqCount += 1;
      seqPadWidth = Number(tokenBody.slice(4));
    } else if (
      tokenBody === 'CLIENT_REF' ||
      tokenBody === 'YYYY' ||
      tokenBody === 'YY' ||
      tokenBody === 'DEPT'
    ) {
      // Supported non-sequence token
    } else {
      return {
        ok: false,
        error: `Unsupported matter number token "{${tokenBody}}". Supported tokens: {CLIENT_REF}, {SEQ}, {SEQ:1..8}, {YYYY}, {YY}, {DEPT}.`,
      };
    }

    cursor = closeIdx + 1;
  }

  if (seqCount !== 1) {
    return {
      ok: false,
      error:
        'Matter number pattern must contain exactly one {SEQ} or {SEQ:1..8} sequence token.',
    };
  }

  if (literalText.length > 0 && !/^[A-Z0-9\-/._]+$/.test(literalText)) {
    return {
      ok: false,
      error:
        'Literal characters outside tokens in matter number patterns may only contain uppercase A-Z, digits 0-9, hyphens (-), slashes (/), dots (.), or underscores (_).',
    };
  }

  return { ok: true, seqPadWidth };
}

function resolveTenantYearParts(
  nowDate?: Date,
  timeZone?: string | null,
): { yyyy: string; yy: string } {
  const safeDate = nowDate && !Number.isNaN(nowDate.getTime()) ? nowDate : new Date();
  const tz = (timeZone ?? '').trim() || 'UTC';
  let yyyy = '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
    }).formatToParts(safeDate);
    yyyy = parts.find((p) => p.type === 'year')?.value ?? '';
  } catch {
    yyyy = String(safeDate.getUTCFullYear());
  }
  if (!/^\d{4}$/.test(yyyy)) {
    yyyy = String(safeDate.getUTCFullYear()).padStart(4, '0');
  }
  return {
    yyyy,
    yy: yyyy.slice(-2),
  };
}

export function resolveEffectiveMatterNumberingConfig(
  tenantConfig?: Pick<TenantConfiguration, 'matterNumbering'> | null,
  moduleOverride?: Partial<MatterNumberingConfig> | null,
): MatterNumberingConfig {
  const rawPattern =
    moduleOverride?.pattern ??
    tenantConfig?.matterNumbering?.pattern ??
    DEFAULT_MATTER_NUMBERING_CONFIG.pattern;
  const rawScope =
    moduleOverride?.sequenceScope ??
    tenantConfig?.matterNumbering?.sequenceScope ??
    DEFAULT_MATTER_NUMBERING_CONFIG.sequenceScope;
  const rawFallback =
    moduleOverride?.emptyTokenFallback ??
    tenantConfig?.matterNumbering?.emptyTokenFallback ??
    DEFAULT_MATTER_NUMBERING_CONFIG.emptyTokenFallback;

  return {
    pattern: rawPattern,
    sequenceScope: rawScope,
    emptyTokenFallback: cleanCustomTokenValue(
      rawFallback,
      DEFAULT_MATTER_NUMBERING_CONFIG.emptyTokenFallback,
    ),
  };
}

export function resolveMatterNumberSequenceKey(
  config: MatterNumberingConfig,
  ctx: MatterNumberFormatContext,
): string {
  switch (config.sequenceScope) {
    case 'client_ref_prefix':
      return cleanLegacyClientRefPrefix(ctx.clientRefPrefix);
    case 'firm':
      return 'FIRM';
    case 'year': {
      const { yyyy } = resolveTenantYearParts(ctx.nowDate, ctx.timeZone);
      return `YEAR:${yyyy}`;
    }
    case 'department': {
      const dept = cleanCustomTokenValue(
        ctx.departmentCode,
        config.emptyTokenFallback,
      );
      return `DEPT:${dept}`;
    }
  }
}

export function formatMatterNumberFromSequence(
  config: MatterNumberingConfig,
  ctx: MatterNumberFormatContext,
  sequenceValue: number,
): string {
  const validation = validateMatterNumberPattern(config.pattern);
  if (!validation.ok) {
    throw new Error(
      `${MATTER_NUMBERING_ERROR_CODES.VALIDATION_ERROR}: ${validation.error}`,
    );
  }
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1) {
    throw new Error(
      `${MATTER_NUMBERING_ERROR_CODES.VALIDATION_ERROR}: Sequence value must be a positive integer.`,
    );
  }

  const seqText = String(sequenceValue).padStart(validation.seqPadWidth, '0');

  // Exact R745 parity on default `{CLIENT_REF}-{SEQ:4}`: preserve legacy cleaning & no truncation.
  if (config.pattern === DEFAULT_MATTER_NUMBERING_CONFIG.pattern) {
    const cleanPrefix = cleanLegacyClientRefPrefix(ctx.clientRefPrefix);
    return `${cleanPrefix}-${seqText}`;
  }

  const { yyyy, yy } = resolveTenantYearParts(ctx.nowDate, ctx.timeZone);
  const clientRef = cleanLegacyClientRefPrefix(ctx.clientRefPrefix);
  const dept = cleanCustomTokenValue(
    ctx.departmentCode,
    config.emptyTokenFallback,
  );

  const rendered = config.pattern.replace(/\{([A-Z_]+)(?::([1-8]))?\}/g, (_match, name: string) => {
    switch (name) {
      case 'CLIENT_REF':
        return clientRef;
      case 'YYYY':
        return yyyy;
      case 'YY':
        return yy;
      case 'DEPT':
        return dept;
      case 'SEQ':
        return seqText;
      default:
        return '';
    }
  });

  if (rendered.length > 64) {
    throw new Error(
      `${MATTER_NUMBERING_ERROR_CODES.VALIDATION_ERROR}: Rendered matter number "${rendered.slice(0, 24)}..." exceeds 64 characters (${rendered.length}).`,
    );
  }

  return rendered;
}
