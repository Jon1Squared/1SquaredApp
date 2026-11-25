import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATTER_NUMBERING_CONFIG,
  DEFAULT_WORK_TYPE_OPENING_GATE,
  cleanLegacyClientRefPrefix,
  formatMatterNumberFromSequence,
  loadAndValidateTenantConfig,
  resolveEffectiveMatterNumberingConfig,
  resolveMatterNumberSequenceKey,
  validateMatterNumberPattern,
} from '../src/index';
import {
  DEFAULT_WORK_TYPES_CONFIG,
  resolveWorkTypeOpeningGate,
} from '@/domain/workTypeConfig';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';

describe('S1-05 B2 (ADR 0040): configurable matter numbering engine, R745 parity, and workType openingGate schema', () => {
  it('1. validateMatterNumberPattern accepts Lever 3 tokens and rejects unsupported tokens, multiple/missing {SEQ}, and invalid literals', () => {
    expect(validateMatterNumberPattern('{CLIENT_REF}-{SEQ:4}')).toEqual({
      ok: true,
      seqPadWidth: 4,
    });
    expect(validateMatterNumberPattern('{YYYY}/{DEPT}/{CLIENT_REF}/{SEQ:6}')).toEqual({
      ok: true,
      seqPadWidth: 6,
    });
    expect(validateMatterNumberPattern('F-{YY}.{SEQ}')).toEqual({
      ok: true,
      seqPadWidth: 4,
    });
    expect(validateMatterNumberPattern('{DEPT}_{SEQ:8}')).toEqual({
      ok: true,
      seqPadWidth: 8,
    });

    // Lever 3 deferral: {WORK_TYPE} and {ENTITY} are unsupported until B31
    expect(validateMatterNumberPattern('{WORK_TYPE}-{SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('{ENTITY}-{SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('{CLIENT_REF}').ok).toBe(false);
    expect(validateMatterNumberPattern('{SEQ}-{SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('{SEQ:9}').ok).toBe(false);
    expect(validateMatterNumberPattern('{SEQ:0}').ok).toBe(false);
    expect(validateMatterNumberPattern('{CLIENT_REF} {SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('{CLIENT_REF:4}-{SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('lower-{SEQ:4}').ok).toBe(false);
    expect(validateMatterNumberPattern('{UNCLOSED-{SEQ:4}').ok).toBe(false);
  });

  it('2. R745 exact default parity: punctuation cleaning, long >60-char prefix non-truncation, shared client_ref_prefix, and MAT001 empty fallback', () => {
    expect(DEFAULT_MATTER_NUMBERING_CONFIG).toEqual({
      pattern: '{CLIENT_REF}-{SEQ:4}',
      sequenceScope: 'client_ref_prefix',
      emptyTokenFallback: 'MAT',
    });

    // Punctuation cleaning: "O'Connor & Co." -> OCONNORCO-0001
    expect(cleanLegacyClientRefPrefix("O'Connor & Co.")).toBe('OCONNORCO');
    expect(
      formatMatterNumberFromSequence(
        DEFAULT_MATTER_NUMBERING_CONFIG,
        { clientRefPrefix: "O'Connor & Co." },
        1,
      ),
    ).toBe('OCONNORCO-0001');

    // Empty / punctuation-only fallback -> MAT001
    expect(cleanLegacyClientRefPrefix('   ')).toBe('MAT001');
    expect(cleanLegacyClientRefPrefix('!!!')).toBe('MAT001');
    expect(
      formatMatterNumberFromSequence(
        DEFAULT_MATTER_NUMBERING_CONFIG,
        { clientRefPrefix: '---?---' },
        7,
      ),
    ).toBe('-------0007');
    expect(
      formatMatterNumberFromSequence(
        DEFAULT_MATTER_NUMBERING_CONFIG,
        { clientRefPrefix: '   ' },
        7,
      ),
    ).toBe('MAT001-0007');

    // >60-char clientRef stays byte-for-byte identical under default pattern (no 64-char truncation!)
    const longClientRef = 'A'.repeat(68);
    expect(
      formatMatterNumberFromSequence(
        DEFAULT_MATTER_NUMBERING_CONFIG,
        { clientRefPrefix: longClientRef },
        12,
      ),
    ).toBe(`${longClientRef}-0012`);

    // Shared client_ref_prefix key across an organisation and a person (e.g. HUG001)
    expect(
      resolveMatterNumberSequenceKey(DEFAULT_MATTER_NUMBERING_CONFIG, {
        clientRefPrefix: 'hug001',
      }),
    ).toBe('HUG001');

    // Non-default custom patterns enforce 64-char max length
    expect(() =>
      formatMatterNumberFromSequence(
        {
          pattern: '{YYYY}/{CLIENT_REF}-{SEQ:4}',
          sequenceScope: 'year',
          emptyTokenFallback: 'MAT',
        },
        { clientRefPrefix: longClientRef, nowDate: new Date('2026-06-15T10:00:00Z') },
        1,
      ),
    ).toThrow(/MATTER_NUMBERING_VALIDATION_ERROR/);
  });

  it('3. resolves all four sequence scopes (client_ref_prefix, firm, year, department) and renders custom tokens cleanly', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const yearCfg = {
      pattern: '{YYYY}/{DEPT}/{SEQ:5}',
      sequenceScope: 'year' as const,
      emptyTokenFallback: 'GEN',
    };
    expect(resolveMatterNumberSequenceKey(yearCfg, { nowDate: now, timeZone: 'Europe/London' })).toBe(
      'YEAR:2026',
    );
    expect(
      formatMatterNumberFromSequence(
        yearCfg,
        { departmentCode: null, nowDate: now, timeZone: 'Europe/London' },
        42,
      ),
    ).toBe('2026/GEN/00042');

    const deptCfg = {
      pattern: '{DEPT}-{YY}-{SEQ:3}',
      sequenceScope: 'department' as const,
      emptyTokenFallback: 'MAT',
    };
    expect(resolveMatterNumberSequenceKey(deptCfg, { departmentCode: 'corp/ma' })).toBe(
      'DEPT:CORPMA',
    );
    expect(
      formatMatterNumberFromSequence(deptCfg, { departmentCode: 'corp/ma', nowDate: now }, 9),
    ).toBe('CORPMA-26-009');

    const firmCfg = {
      pattern: 'FIRM-{SEQ:6}',
      sequenceScope: 'firm' as const,
      emptyTokenFallback: 'MAT',
    };
    expect(resolveMatterNumberSequenceKey(firmCfg, { clientRefPrefix: 'ANY' })).toBe('FIRM');
    expect(formatMatterNumberFromSequence(firmCfg, {}, 123)).toBe('FIRM-000123');
  });

  it('4. deep-merges workTypes.*.openingGate and matterNumbering in loadAndValidateTenantConfig and resolves hierarchy cleanly', () => {
    const rawWorkTypes = (
      notALawFirmBaseConfig as {
        workTypes?: {
          defaults?: Record<string, unknown>;
          items?: Array<Record<string, unknown>>;
        };
      }
    ).workTypes;
    const rawBase: Record<string, unknown> = {
      ...notALawFirmBaseConfig,
      matterNumbering: {
        pattern: '{CLIENT_REF}-{SEQ:4}',
        sequenceScope: 'client_ref_prefix',
        emptyTokenFallback: 'MAT',
      },
      workTypes: {
        ...rawWorkTypes,
        defaults: {
          ...rawWorkTypes?.defaults,
          openingGate: {
            requireConflictCleared: true,
            requireCddComplete: false,
          },
        },
        items: [
          ...(rawWorkTypes?.items ?? []),
          {
            workTypeId: 'work_type.test_pa',
            openingGate: {
              requireCddComplete: true,
              allowCddOverride: false,
            },
          },
          {
            workTypeId: 'work_type.test_sub',
            practiceAreaId: 'work_type.test_pa',
            openingGate: {
              requireConflictCleared: true,
              requireEngagementSigned: true,
            },
          },
        ],
      },
    };
    const rawOverlay: Record<string, unknown> = {
      environment: 'test',
      matterNumbering: {
        emptyTokenFallback: 'GEN',
      },
      workTypes: {
        defaults: {
          openingGate: {
            requireFundsOnAccount: true,
          },
        },
        items: [
          {
            workTypeId: 'work_type.test_sub',
            openingGate: {
              allowCddOverride: false,
            },
          },
        ],
      },
    };

    const loaded = loadAndValidateTenantConfig(rawBase, rawOverlay, 'test');
    expect(loaded.matterNumbering).toEqual({
      pattern: '{CLIENT_REF}-{SEQ:4}',
      sequenceScope: 'client_ref_prefix',
      emptyTokenFallback: 'GEN',
    });
    expect(resolveEffectiveMatterNumberingConfig(loaded, { pattern: '{YYYY}-{SEQ:5}' })).toEqual({
      pattern: '{YYYY}-{SEQ:5}',
      sequenceScope: 'client_ref_prefix',
      emptyTokenFallback: 'GEN',
    });

    expect(loaded.workTypes?.defaults.openingGate).toEqual({
      requireConflictCleared: true,
      requireCddComplete: false,
      allowCddOverride: true,
      requireEngagementSigned: false,
      requireFundsOnAccount: true,
    });

    const subResolved = resolveWorkTypeOpeningGate(loaded.workTypes!, {
      workTypeSubcategoryId: 'work_type.test_sub',
      practiceAreaId: 'work_type.test_pa',
    });
    expect(subResolved).toEqual({
      requireConflictCleared: true,
      requireCddComplete: false,
      allowCddOverride: false,
      requireEngagementSigned: true,
      requireFundsOnAccount: false,
      source: 'work_type',
      matchedWorkTypeId: 'work_type.test_sub',
    });

    expect(resolveWorkTypeOpeningGate(DEFAULT_WORK_TYPES_CONFIG, {})).toEqual({
      ...DEFAULT_WORK_TYPE_OPENING_GATE,
      source: 'firm_default',
      matchedWorkTypeId: null,
    });
  });
});
