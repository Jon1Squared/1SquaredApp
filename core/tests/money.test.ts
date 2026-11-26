import { describe, expect, it } from 'vitest';
import * as coreApi from '@platform/core-api';
import * as corePkg from '@platform/core';
import {
  calculateVatMinorUnits,
  formatMinorUnitsGbp,
  gbpToPence,
  minorUnitsToPgBigInt,
  minorUnitsToPounds,
  minorUnitsToPoundsString,
  penceToGbp,
  percentToBasisPoints,
  pgBigIntToMinorUnits,
  poundsToMinorUnits,
  roundHalfAwayFromZeroFromBasisPoints,
  subtractMinorUnits,
  sumMinorUnits,
} from '../src/domain/money/index';
import {
  createDirectMigrationClient,
  resolveTenantFromVerifiedToken,
} from '@platform/core';

describe('core minor-unit money module', () => {
  it('re-exports all public helpers from @platform/core-api and @platform/core', () => {
    const expectedNames = [
      'poundsToMinorUnits',
      'gbpToPence',
      'minorUnitsToPounds',
      'penceToGbp',
      'minorUnitsToPoundsString',
      'percentToBasisPoints',
      'roundHalfAwayFromZeroFromBasisPoints',
      'calculateVatMinorUnits',
      'sumMinorUnits',
      'pgBigIntToMinorUnits',
      'minorUnitsToPgBigInt',
      'subtractMinorUnits',
      'formatMinorUnitsGbp',
    ] as const;

    expect(coreApi.CORE_API_VERSION).toBe('2.3.0');
    for (const name of expectedNames) {
      expect(typeof (coreApi as Record<string, unknown>)[name]).toBe('function');
      expect(typeof (corePkg as Record<string, unknown>)[name]).toBe('function');
    }
  });

  describe('poundsToMinorUnits & gbpToPence', () => {
    it('parses decimal strings and numbers without binary float multiplication bugs', () => {
      expect(poundsToMinorUnits('0')).toBe(0);
      expect(poundsToMinorUnits('0.1')).toBe(10);
      expect(poundsToMinorUnits('0.2')).toBe(20);
      expect(poundsToMinorUnits('19.99')).toBe(1999);
      expect(poundsToMinorUnits(19.99)).toBe(1999);
      expect(poundsToMinorUnits('1.005')).toBe(101);
      expect(poundsToMinorUnits(1.005)).toBe(101);
      expect(poundsToMinorUnits('19.985')).toBe(1999);
      expect(poundsToMinorUnits('35.855')).toBe(3586);
      expect(poundsToMinorUnits('1.2349')).toBe(123);
      expect(poundsToMinorUnits('1.2350')).toBe(124);
      expect(poundsToMinorUnits('+42.5')).toBe(4250);
      expect(poundsToMinorUnits('  12.34  ')).toBe(1234);
      expect(poundsToMinorUnits(100)).toBe(10000);
      expect(gbpToPence('25000.00')).toBe(2500000);
    });

    it('rounds negative values half away from zero and normalises negative zero', () => {
      expect(poundsToMinorUnits('-0.005')).toBe(-1);
      expect(poundsToMinorUnits('-1.005')).toBe(-101);
      expect(poundsToMinorUnits('-19.994')).toBe(-1999);
      expect(poundsToMinorUnits('-19.995')).toBe(-2000);
      expect(Object.is(poundsToMinorUnits('-0.00'), 0)).toBe(true);
      expect(Object.is(poundsToMinorUnits('-0.004'), 0)).toBe(true);
      expect(Object.is(poundsToMinorUnits(-0), 0)).toBe(true);
    });

    it('handles safe integer boundary and rejects overflows', () => {
      expect(poundsToMinorUnits('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
      expect(poundsToMinorUnits('-90071992547409.91')).toBe(Number.MIN_SAFE_INTEGER);
      expect(() => poundsToMinorUnits('90071992547409.92')).toThrow(RangeError);
      expect(() => poundsToMinorUnits('-90071992547409.92')).toThrow(RangeError);
    });

    it('rejects non-finite, exponential, and malformed inputs', () => {
      for (const bad of [
        NaN,
        Infinity,
        -Infinity,
        'NaN',
        'Infinity',
        '1e2',
        '1E-5',
        1e-7,
        1e21,
        '.5',
        '5.',
        '',
        '   ',
        '£10.00',
        '1,000.00',
        '10.00.00',
        'abc',
      ]) {
        expect(() => poundsToMinorUnits(bad)).toThrow();
      }
    });
  });

  describe('minorUnitsToPounds & minorUnitsToPoundsString', () => {
    it('formats positive, zero, negative, and safe-max minor units cleanly', () => {
      expect(minorUnitsToPoundsString(0)).toBe('0.00');
      expect(minorUnitsToPoundsString(5)).toBe('0.05');
      expect(minorUnitsToPoundsString(-5)).toBe('-0.05');
      expect(minorUnitsToPoundsString(1999)).toBe('19.99');
      expect(minorUnitsToPoundsString(-12345)).toBe('-123.45');
      expect(minorUnitsToPoundsString(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');

      expect(minorUnitsToPounds(0)).toBe(0);
      expect(Object.is(minorUnitsToPounds(-0), 0)).toBe(true);
      expect(minorUnitsToPounds(1999)).toBe(19.99);
      expect(penceToGbp(-505)).toBe(-5.05);
    });

    it('rejects non-safe-integer minor unit inputs', () => {
      expect(() => minorUnitsToPoundsString(12.34)).toThrow(RangeError);
      expect(() => minorUnitsToPounds(NaN)).toThrow(RangeError);
      expect(() => minorUnitsToPoundsString(Infinity)).toThrow(RangeError);
      expect(() => minorUnitsToPounds(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    });
  });

  describe('percentToBasisPoints', () => {
    it('parses non-negative decimal percentages into integer basis points', () => {
      expect(percentToBasisPoints(20)).toBe(2000);
      expect(percentToBasisPoints('20')).toBe(2000);
      expect(percentToBasisPoints(17.5)).toBe(1750);
      expect(percentToBasisPoints('5')).toBe(500);
      expect(percentToBasisPoints(0)).toBe(0);
      expect(percentToBasisPoints(100)).toBe(10000);
      expect(percentToBasisPoints('0.125')).toBe(13);
      expect(percentToBasisPoints('0.124')).toBe(12);
      expect(percentToBasisPoints(' +5.0 ')).toBe(500);
    });

    it('rejects negative, exponential, non-finite, and malformed percentages', () => {
      for (const bad of [-1, '-0.01', '-0', NaN, Infinity, '1e2', 1e-7, '20%', '.5', '']) {
        expect(() => percentToBasisPoints(bad)).toThrow();
      }
    });
  });

  describe('roundHalfAwayFromZeroFromBasisPoints & calculateVatMinorUnits', () => {
    it('computes VAT and percentages with symmetric half-away-from-zero rounding', () => {
      expect(calculateVatMinorUnits(10000, 2000)).toBe(2000);
      expect(calculateVatMinorUnits(25, 2000)).toBe(5);
      // 10p * 5% = 0.5p -> rounds half away from zero to 1p
      expect(calculateVatMinorUnits(10, 500)).toBe(1);
      // 25p * 5% = 1.25p -> 1p
      expect(calculateVatMinorUnits(25, 500)).toBe(1);
      // -3p * 50% = -1.5p -> rounds away from zero to -2p
      expect(roundHalfAwayFromZeroFromBasisPoints(-3, 5000)).toBe(-2);
      expect(calculateVatMinorUnits(-25, 2000)).toBe(-5);
      expect(calculateVatMinorUnits(0, 2000)).toBe(0);
      expect(calculateVatMinorUnits(1999, 0)).toBe(0);
    });

    it('preserves full precision via BigInt before dividing by 10000 and rejects overflows', () => {
      expect(roundHalfAwayFromZeroFromBasisPoints(Number.MAX_SAFE_INTEGER, 10000)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(() =>
        roundHalfAwayFromZeroFromBasisPoints(Number.MAX_SAFE_INTEGER, 20000),
      ).toThrow(RangeError);
      expect(() => roundHalfAwayFromZeroFromBasisPoints(100, -1)).toThrow(RangeError);
      expect(() => roundHalfAwayFromZeroFromBasisPoints(10.5, 2000)).toThrow(RangeError);
    });
  });

  describe('sumMinorUnits', () => {
    it('adds pence without 0.1 + 0.2 floating-point drift', () => {
      const totalMinor = sumMinorUnits([poundsToMinorUnits('0.10'), poundsToMinorUnits('0.20')]);
      expect(totalMinor).toBe(30);
      expect(minorUnitsToPoundsString(totalMinor)).toBe('0.30');
      expect(minorUnitsToPounds(totalMinor)).toBe(0.3);
      expect(sumMinorUnits([])).toBe(0);
      expect(sumMinorUnits([1000, -250, 50])).toBe(800);
    });

    it('rejects non-integers and overflows', () => {
      expect(() => sumMinorUnits([100, 1.5])).toThrow(RangeError);
      expect(() => sumMinorUnits([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
    });
  });

  describe('pgBigIntToMinorUnits, minorUnitsToPgBigInt, subtractMinorUnits, and formatMinorUnitsGbp', () => {
    it('parses pg BIGINT strings, bigints, and safe integers while rejecting fractional or out-of-range inputs', () => {
      expect(pgBigIntToMinorUnits('0')).toBe(0);
      expect(Object.is(pgBigIntToMinorUnits('-0'), 0)).toBe(true);
      expect(pgBigIntToMinorUnits('  +1999  ')).toBe(1999);
      expect(pgBigIntToMinorUnits('-45000')).toBe(-45000);
      expect(pgBigIntToMinorUnits(BigInt(9007199254740991))).toBe(Number.MAX_SAFE_INTEGER);
      expect(pgBigIntToMinorUnits(BigInt(-9007199254740991))).toBe(Number.MIN_SAFE_INTEGER);
      expect(pgBigIntToMinorUnits(123456)).toBe(123456);
      expect(Object.is(pgBigIntToMinorUnits(-0), 0)).toBe(true);

      for (const bad of ['12.34', '1e5', 'abc', '', '   ', '9007199254740992', '-9007199254740992', 12.5, NaN, Infinity]) {
        expect(() => pgBigIntToMinorUnits(bad)).toThrow();
      }

      expect(minorUnitsToPgBigInt(0)).toBe('0');
      expect(minorUnitsToPgBigInt(-0)).toBe('0');
      expect(minorUnitsToPgBigInt(1999)).toBe('1999');
      expect(minorUnitsToPgBigInt(-505)).toBe('-505');
      expect(minorUnitsToPgBigInt(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
      expect(() => minorUnitsToPgBigInt(12.34)).toThrow(RangeError);
    });

    it('subtracts minor units without float drift and rejects safe-integer overflow', () => {
      expect(subtractMinorUnits(30, 10)).toBe(20);
      expect(Object.is(subtractMinorUnits(500, 500), 0)).toBe(true);
      expect(subtractMinorUnits(100, 250)).toBe(-150);
      expect(() => subtractMinorUnits(Number.MAX_SAFE_INTEGER, -1)).toThrow(RangeError);
      expect(() => subtractMinorUnits(Number.MIN_SAFE_INTEGER, 1)).toThrow(RangeError);
      expect(() => subtractMinorUnits(10.5, 5)).toThrow(RangeError);
    });

    it('formats GBP currency purely from integer pence with brackets and omitZeroPence options', () => {
      expect(formatMinorUnitsGbp(0)).toBe('£0.00');
      expect(formatMinorUnitsGbp(-0)).toBe('£0.00');
      expect(formatMinorUnitsGbp(0, { accountingBrackets: true })).toBe('£0.00');
      expect(formatMinorUnitsGbp(0, { omitZeroPence: true })).toBe('£0');
      expect(formatMinorUnitsGbp(5)).toBe('£0.05');
      expect(formatMinorUnitsGbp(-5)).toBe('-£0.05');
      expect(formatMinorUnitsGbp(-5, { accountingBrackets: true })).toBe('(£0.05)');
      expect(formatMinorUnitsGbp(120000)).toBe('£1,200.00');
      expect(formatMinorUnitsGbp(120000, { omitZeroPence: true })).toBe('£1,200');
      expect(formatMinorUnitsGbp(123456789)).toBe('£1,234,567.89');
      expect(formatMinorUnitsGbp(-123456789, { accountingBrackets: true })).toBe('(£1,234,567.89)');
      expect(formatMinorUnitsGbp(Number.MAX_SAFE_INTEGER)).toBe('£90,071,992,547,409.91');
      expect(formatMinorUnitsGbp(Number.MIN_SAFE_INTEGER, { accountingBrackets: true })).toBe(
        '(£90,071,992,547,409.91)',
      );
      expect(() => formatMinorUnitsGbp(12.34)).toThrow(RangeError);
    });
  });

  describe('S1-12 property-style rounding & PostgreSQL ROUND((col::numeric) * 100)::bigint parity', () => {
    it('matches exact symmetric half-away-from-zero across 10,500+ deterministic amounts and PostgreSQL 16', async () => {
      let seed = 0x15a2d001;
      const nextRand = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const fixedCases: Array<{ readonly text: string; readonly num?: number; readonly expected: number }> = [
        { text: '0.00', num: 0, expected: 0 },
        { text: '-0.00', num: -0, expected: 0 },
        { text: '0.004', num: 0.004, expected: 0 },
        { text: '-0.004', num: -0.004, expected: 0 },
        { text: '0.005', num: 0.005, expected: 1 },
        { text: '-0.005', num: -0.005, expected: -1 },
        { text: '1.005', num: 1.005, expected: 101 },
        { text: '-1.005', num: -1.005, expected: -101 },
        { text: '19.985', num: 19.985, expected: 1999 },
        { text: '-19.985', num: -19.985, expected: -1999 },
        { text: '19.995', num: 19.995, expected: 2000 },
        { text: '-19.995', num: -19.995, expected: -2000 },
        { text: '35.855', num: 35.855, expected: 3586 },
        { text: '-35.855', num: -35.855, expected: -3586 },
        { text: String(0.1 + 0.2), expected: 30 },
        { text: '100000000.00', num: 100000000, expected: 10000000000 },
        { text: '-100000000.995', num: -100000000.995, expected: -10000000100 },
      ];

      for (const c of fixedCases) {
        const res = poundsToMinorUnits(c.text);
        expect(res).toBe(c.expected);
        expect(Object.is(res, -0)).toBe(false);
        if (c.num !== undefined) {
          expect(poundsToMinorUnits(c.num)).toBe(c.expected);
        }
      }

      const referenceHalfAway = (decimalText: string): number => {
        const neg = decimalText.startsWith('-');
        const unsigned = neg || decimalText.startsWith('+') ? decimalText.slice(1) : decimalText;
        const [wholePart = '0', fracPart = ''] = unsigned.split('.');
        const fracTwo = fracPart.slice(0, 2).padEnd(2, '0');
        const roundUp =
          fracPart.length >= 3 && fracPart.charCodeAt(2) >= 53 ? BigInt(1) : BigInt(0);
        const mag = BigInt(wholePart) * BigInt(100) + BigInt(fracTwo) + roundUp;
        return mag === BigInt(0) ? 0 : Number(neg ? -mag : mag);
      };

      const generatedTexts: string[] = [];
      for (let i = 0; i < 10_500; i += 1) {
        const sign = i % 3 === 0 ? '-' : '';
        const wholeMax = i % 10 === 0 ? 100_000_000 : i % 4 === 0 ? 100_000 : 1_000;
        const whole = Math.floor(nextRand() * wholeMax);
        const fracDigits =
          i % 5 === 0
            ? `${Math.floor(nextRand() * 100).toString().padStart(2, '0')}5`
            : Math.floor(nextRand() * 10_000)
                .toString()
                .padStart(4, '0');
        const text = `${sign}${whole}.${fracDigits}`;
        const tsPence = poundsToMinorUnits(text);
        expect(tsPence).toBe(referenceHalfAway(text));
        expect(Object.is(tsPence, -0)).toBe(false);
        expect(minorUnitsToPgBigInt(tsPence)).toBe(String(tsPence));
        expect(pgBigIntToMinorUnits(minorUnitsToPgBigInt(tsPence))).toBe(tsPence);
        if (i < 500) {
          generatedTexts.push(text);
        }
      }

      // Prove exact parity against PostgreSQL 16 `ROUND((col::numeric) * 100)::bigint`
      const ctx = resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'P-MONEY-TEST',
          tenantId: 'not-a-law-firm',
          name: 'Money Tester',
          email: 'money-tester@notalawfirm.example',
          roles: ['admin'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'test',
        correlationId: 'corr-money-pg-parity',
      });
      const client = await createDirectMigrationClient({ ctx });
      try {
        const numericFloats = fixedCases
          .filter((c): c is { text: string; num: number; expected: number } => c.num !== undefined)
          .map((c) => c.num);
        const pgFloatRes = await client.query<{ raw_num: number; pg_pence: string }>(
          `SELECT v AS raw_num, ROUND((v::numeric) * 100)::bigint::text AS pg_pence
             FROM unnest($1::double precision[]) AS t(v)`,
          [numericFloats],
        );
        expect(pgFloatRes.rows).toHaveLength(numericFloats.length);
        for (let i = 0; i < numericFloats.length; i += 1) {
          const row = pgFloatRes.rows[i]!;
          expect(pgBigIntToMinorUnits(row.pg_pence)).toBe(
            poundsToMinorUnits(numericFloats[i]!),
          );
        }

        // Exact generated decimals stored as DOUBLE PRECISION vs PostgreSQL ROUND((col::numeric) * 100)::bigint
        const generatedDoublePairs = generatedTexts
          .map((t) => Number(t))
          .filter((n) => Number.isFinite(n));
        const pgGenRes = await client.query<{ pg_pence: string }>(
          `SELECT ROUND((v::numeric) * 100)::bigint::text AS pg_pence
             FROM unnest($1::double precision[]) AS t(v)`,
          [generatedDoublePairs],
        );
        expect(pgGenRes.rows).toHaveLength(generatedDoublePairs.length);
        for (let i = 0; i < generatedDoublePairs.length; i += 1) {
          expect(pgBigIntToMinorUnits(pgGenRes.rows[i]!.pg_pence)).toBe(
            poundsToMinorUnits(generatedDoublePairs[i]!),
          );
        }
      } finally {
        await client.end().catch(() => {});
      }
    });
  });
});
