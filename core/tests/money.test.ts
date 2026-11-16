import { describe, expect, it } from 'vitest';
import * as coreApi from '@platform/core-api';
import * as corePkg from '@platform/core';
import {
  calculateVatMinorUnits,
  gbpToPence,
  minorUnitsToPounds,
  minorUnitsToPoundsString,
  penceToGbp,
  percentToBasisPoints,
  poundsToMinorUnits,
  roundHalfAwayFromZeroFromBasisPoints,
  sumMinorUnits,
} from '../src/domain/money/index';

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
    ] as const;

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
});
