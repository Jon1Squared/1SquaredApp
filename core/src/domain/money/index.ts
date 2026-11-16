/**
 * Pure integer minor-unit money module (pence for GBP).
 *
 * Uses exact decimal string parsing and BigInt arithmetic so binary
 * floating-point inaccuracies never enter fee, disbursement, or VAT sums.
 */

const CANONICAL_DECIMAL_RE = /^\s*([-+]?)(\d+)(?:\.(\d+))?\s*$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_HUNDRED = BigInt(100);
const BIGINT_HALF_BPS_DENOM = BigInt(5000);
const BIGINT_BPS_DENOM = BigInt(10000);

/** Integer monetary amount in currency minor units (e.g. pence for GBP). */
export type MinorUnits = number;

/** Non-negative percentage expressed in basis points (1% = 100 bps). */
export type BasisPoints = number;

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (received ${String(value)})`);
  }
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds safe integer range`);
  }
  return Number(value);
}

function parseScaledHundredths(
  input: string | number,
  label: string,
  allowNegative: boolean,
): bigint {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new TypeError(`${label} must be a string or finite number`);
  }
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new RangeError(`${label} must be finite (received ${String(input)})`);
  }

  const raw = typeof input === 'number' ? String(input) : input;
  if (/[eE]/.test(raw)) {
    throw new RangeError(`${label} must not use exponential notation (received "${raw}")`);
  }

  const match = CANONICAL_DECIMAL_RE.exec(raw);
  if (!match) {
    throw new RangeError(`${label} must be a canonical decimal value (received "${raw}")`);
  }

  const [, signChar, wholeStr, fracStr = ''] = match;
  if (!allowNegative && signChar === '-') {
    throw new RangeError(`${label} must not be negative (received "${raw}")`);
  }

  const whole = BigInt(wholeStr);
  const twoDigits = fracStr.slice(0, 2).padEnd(2, '0');
  const thirdDigit = fracStr.length >= 3 ? fracStr.charCodeAt(2) - 48 : 0;

  let magnitude = whole * BIGINT_HUNDRED + BigInt(twoDigits);
  if (thirdDigit >= 5) {
    magnitude += BIGINT_ONE;
  }

  if (magnitude === BIGINT_ZERO) {
    return BIGINT_ZERO;
  }

  return signChar === '-' ? -magnitude : magnitude;
}

/**
 * Convert a decimal GBP string or finite number into exact integer pence
 * using string parsing and half-away-from-zero rounding on the 3rd decimal place.
 */
export function poundsToMinorUnits(input: string | number): MinorUnits {
  const scaled = parseScaledHundredths(input, 'Monetary amount', true);
  return toSafeNumber(scaled, 'Monetary minor units');
}

/** Alias for {@link poundsToMinorUnits}. */
export const gbpToPence = poundsToMinorUnits;

/**
 * Convert an integer minor-unit amount (pence) to its canonical two-decimal
 * string representation in pounds (e.g. `1999` -> `'19.99'`, `-5` -> `'-0.05'`).
 */
export function minorUnitsToPoundsString(minorUnits: MinorUnits): string {
  assertSafeInteger(minorUnits, 'minorUnits');
  if (minorUnits === 0) {
    return '0.00';
  }
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const pence = abs % 100;
  const pounds = Math.trunc((abs - pence) / 100);
  return `${sign}${pounds}.${String(pence).padStart(2, '0')}`;
}

/**
 * Convert an integer minor-unit amount (pence) to a decimal GBP number for UI/JSON boundary display.
 */
export function minorUnitsToPounds(minorUnits: MinorUnits): number {
  assertSafeInteger(minorUnits, 'minorUnits');
  if (minorUnits === 0) {
    return 0;
  }
  return Number(minorUnitsToPoundsString(minorUnits));
}

/** Alias for {@link minorUnitsToPounds}. */
export const penceToGbp = minorUnitsToPounds;

/**
 * Parse a non-negative decimal percentage (e.g. `20`, `17.5`, `'5'`) into integer basis points (`1% = 100 bps`).
 */
export function percentToBasisPoints(percent: string | number): BasisPoints {
  const scaled = parseScaledHundredths(percent, 'Percentage', false);
  return toSafeNumber(scaled, 'Basis points');
}

/**
 * Multiply an integer minor-unit amount by non-negative basis points and divide by 10,000
 * using BigInt arithmetic and symmetric half-away-from-zero rounding.
 */
export function roundHalfAwayFromZeroFromBasisPoints(
  amountMinorUnits: MinorUnits,
  basisPoints: BasisPoints,
): MinorUnits {
  assertSafeInteger(amountMinorUnits, 'amountMinorUnits');
  assertSafeInteger(basisPoints, 'basisPoints');
  if (basisPoints < 0) {
    throw new RangeError(`basisPoints must be non-negative (received ${basisPoints})`);
  }

  const product = BigInt(amountMinorUnits) * BigInt(basisPoints);
  if (product === BIGINT_ZERO) {
    return 0;
  }

  const absProduct = product < BIGINT_ZERO ? -product : product;
  const roundedAbs = (absProduct + BIGINT_HALF_BPS_DENOM) / BIGINT_BPS_DENOM;
  const rounded = product < BIGINT_ZERO ? -roundedAbs : roundedAbs;
  return toSafeNumber(rounded, 'Rounded minor units');
}

/**
 * Compute VAT minor units for a net minor-unit amount and VAT rate in basis points.
 */
export function calculateVatMinorUnits(
  netMinorUnits: MinorUnits,
  vatRateBasisPoints: BasisPoints,
): MinorUnits {
  return roundHalfAwayFromZeroFromBasisPoints(netMinorUnits, vatRateBasisPoints);
}

/**
 * Sum an array of integer minor-unit amounts without floating-point drift.
 */
export function sumMinorUnits(amounts: readonly MinorUnits[]): MinorUnits {
  let total = BIGINT_ZERO;
  for (let i = 0; i < amounts.length; i += 1) {
    const amount = amounts[i]!;
    assertSafeInteger(amount, `amounts[${i}]`);
    total += BigInt(amount);
  }
  return toSafeNumber(total, 'Summed minor units');
}
