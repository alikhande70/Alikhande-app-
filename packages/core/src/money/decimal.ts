/**
 * Exact decimal arithmetic on scaled bigints.
 *
 * A `Dec` is an integer `v` at scale `s`, meaning `value = v / 10^s`.
 * There is no implicit rounding anywhere in this module: any operation that
 * cannot be exact (division, rescaling down) demands an explicit target scale
 * and an explicit rounding mode.
 *
 * Rounding *direction* is a trading decision, not a formatting detail — see
 * ADR-0005. Position size rounds down so we never risk more than intended;
 * stop distance rounds out so a stop is never tighter than intended.
 *
 * IEEE-754 is banned for money, prices, sizes and risk. It is permitted only
 * for chart geometry and advisory indicator maths, via the explicitly-named
 * `unsafeToNumber`.
 */

export interface Dec {
  /** Unscaled integer value. */
  readonly v: bigint;
  /** Number of decimal places. `value = v / 10^s`. */
  readonly s: number;
}

export type RoundingMode =
  /** Toward zero (truncate). */
  | 'down'
  /** Away from zero. */
  | 'up'
  /** Toward negative infinity. */
  | 'floor'
  /** Toward positive infinity. */
  | 'ceil'
  /** Nearest; ties away from zero. */
  | 'half-up'
  /** Nearest; ties to even (banker's). */
  | 'half-even';

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

/**
 * Scale ceiling. 34 matches IEEE-754 decimal128's coefficient width and is far
 * beyond anything financial: a 5-digit FX price times a 2-digit lot size times a
 * contract size is scale 7. The ceiling exists so unbounded precision creep in an
 * intermediate expression surfaces as an error at the call site rather than as a
 * slowly growing bigint.
 */
const MAX_SCALE = 34;

const POW10: readonly bigint[] = (() => {
  const out: bigint[] = [];
  let p = 1n;
  for (let i = 0; i <= MAX_SCALE * 2 + 4; i++) {
    out.push(p);
    p *= 10n;
  }
  return out;
})();

function pow10(n: number): bigint {
  if (n < 0) throw new DecimalError(`pow10: negative exponent ${n}`);
  const cached = POW10[n];
  if (cached !== undefined) return cached;
  return 10n ** BigInt(n);
}

function assertScale(s: number): void {
  if (!Number.isInteger(s) || s < 0 || s > MAX_SCALE) {
    throw new DecimalError(`scale must be an integer in [0, ${MAX_SCALE}], got ${s}`);
  }
}

/** Construct a Dec from an unscaled bigint and a scale. */
export function raw(v: bigint, s: number): Dec {
  assertScale(s);
  return { v, s };
}

const DEC_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * Parse a plain decimal string. Scientific notation is rejected deliberately:
 * `1e-8` is ambiguous about intended precision and hides scale bugs.
 *
 * The scale of the result is the number of digits written after the point, so
 * `dec('1.50')` has scale 2 and `dec('1.5')` has scale 1. They compare equal
 * but they are not the same value object — precision is information.
 */
export function dec(input: string | number | bigint): Dec {
  if (typeof input === 'bigint') return { v: input, s: 0 };
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new DecimalError(
        `dec(): refusing to convert non-integer number ${input}. ` +
          `Pass a string to preserve exact intent (float64 cannot represent most decimals).`,
      );
    }
    if (!Number.isSafeInteger(input)) {
      throw new DecimalError(`dec(): ${input} exceeds the safe integer range`);
    }
    return { v: BigInt(input), s: 0 };
  }
  const trimmed = input.trim();
  const m = DEC_PATTERN.exec(trimmed);
  if (m === null) {
    throw new DecimalError(`dec(): cannot parse ${JSON.stringify(input)} as a plain decimal`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  assertScale(fracPart.length);
  const digits = intPart + fracPart;
  return { v: sign * BigInt(digits), s: fracPart.length };
}

export const ZERO: Dec = { v: 0n, s: 0 };
export const ONE: Dec = { v: 1n, s: 0 };

/** Divide `num` by `den`, rounding the quotient per `mode`. Exact for the given mode. */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new DecimalError('division by zero');
  // Normalise so the denominator is positive; track the sign of the quotient.
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const absN = negative ? -n : n;
  const q = absN / d;
  const r = absN % d;
  if (r === 0n) return negative ? -q : q;

  let magnitude: bigint;
  switch (mode) {
    case 'down':
      magnitude = q;
      break;
    case 'up':
      magnitude = q + 1n;
      break;
    case 'floor':
      magnitude = negative ? q + 1n : q;
      break;
    case 'ceil':
      magnitude = negative ? q : q + 1n;
      break;
    case 'half-up': {
      magnitude = r * 2n >= d ? q + 1n : q;
      break;
    }
    case 'half-even': {
      const twice = r * 2n;
      if (twice > d) magnitude = q + 1n;
      else if (twice < d) magnitude = q;
      else magnitude = q % 2n === 0n ? q : q + 1n;
      break;
    }
    default: {
      const exhaustive: never = mode;
      throw new DecimalError(`unknown rounding mode ${String(exhaustive)}`);
    }
  }
  return negative ? -magnitude : magnitude;
}

/**
 * Change the scale of a Dec.
 *
 * Increasing scale is always exact. Decreasing scale loses information, so a
 * rounding mode is mandatory — there is no default.
 */
export function rescale(a: Dec, targetScale: number, mode?: RoundingMode): Dec {
  assertScale(targetScale);
  if (targetScale === a.s) return a;
  if (targetScale > a.s) {
    return { v: a.v * pow10(targetScale - a.s), s: targetScale };
  }
  if (mode === undefined) {
    throw new DecimalError(
      `rescale(): reducing scale ${a.s} -> ${targetScale} discards digits; a rounding mode is required`,
    );
  }
  return { v: divRound(a.v, pow10(a.s - targetScale), mode), s: targetScale };
}

function align(a: Dec, b: Dec): { av: bigint; bv: bigint; s: number } {
  if (a.s === b.s) return { av: a.v, bv: b.v, s: a.s };
  if (a.s > b.s) return { av: a.v, bv: b.v * pow10(a.s - b.s), s: a.s };
  return { av: a.v * pow10(b.s - a.s), bv: b.v, s: b.s };
}

/** Exact addition. Result scale is `max(a.s, b.s)`. */
export function add(a: Dec, b: Dec): Dec {
  const { av, bv, s } = align(a, b);
  return { v: av + bv, s };
}

/** Exact subtraction. Result scale is `max(a.s, b.s)`. */
export function sub(a: Dec, b: Dec): Dec {
  const { av, bv, s } = align(a, b);
  return { v: av - bv, s };
}

/** Exact multiplication. Result scale is `a.s + b.s`. Rescale explicitly afterwards. */
export function mul(a: Dec, b: Dec): Dec {
  const s = a.s + b.s;
  if (s > MAX_SCALE) {
    // Still exact, but past the representable scale ceiling: round-trip through
    // an explicit rescale so the caller sees the precision decision.
    throw new DecimalError(
      `mul(): result scale ${s} exceeds max ${MAX_SCALE}; rescale an operand first`,
    );
  }
  return { v: a.v * b.v, s };
}

/** Division to an explicit scale with an explicit rounding mode. */
export function div(a: Dec, b: Dec, targetScale: number, mode: RoundingMode): Dec {
  assertScale(targetScale);
  if (b.v === 0n) throw new DecimalError('div(): division by zero');
  // a/b at scale rs => round( a.v * 10^(b.s + rs) / (b.v * 10^a.s) )
  const num = a.v * pow10(b.s + targetScale);
  const den = b.v * pow10(a.s);
  return { v: divRound(num, den, mode), s: targetScale };
}

export function neg(a: Dec): Dec {
  return { v: -a.v, s: a.s };
}

export function abs(a: Dec): Dec {
  return a.v < 0n ? { v: -a.v, s: a.s } : a;
}

/** -1, 0 or 1. */
export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const { av, bv } = align(a, b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export const eq = (a: Dec, b: Dec): boolean => cmp(a, b) === 0;
export const lt = (a: Dec, b: Dec): boolean => cmp(a, b) === -1;
export const lte = (a: Dec, b: Dec): boolean => cmp(a, b) !== 1;
export const gt = (a: Dec, b: Dec): boolean => cmp(a, b) === 1;
export const gte = (a: Dec, b: Dec): boolean => cmp(a, b) !== -1;
export const isZero = (a: Dec): boolean => a.v === 0n;
export const isNegative = (a: Dec): boolean => a.v < 0n;
export const isPositive = (a: Dec): boolean => a.v > 0n;

export function min(a: Dec, b: Dec): Dec {
  return cmp(a, b) <= 0 ? a : b;
}

export function max(a: Dec, b: Dec): Dec {
  return cmp(a, b) >= 0 ? a : b;
}

export function sum(values: readonly Dec[]): Dec {
  let acc: Dec = ZERO;
  for (const v of values) acc = add(acc, v);
  return acc;
}

/** Sign of the value: -1, 0 or 1. */
export function sign(a: Dec): -1 | 0 | 1 {
  if (a.v < 0n) return -1;
  if (a.v > 0n) return 1;
  return 0;
}

/**
 * Round `a` to the nearest multiple of `step`, in the given direction.
 * `step` must be strictly positive. Used for tick and lot-step snapping.
 */
export function quantize(a: Dec, step: Dec, mode: RoundingMode): Dec {
  if (step.v <= 0n) throw new DecimalError('quantize(): step must be > 0');
  const scale = Math.max(a.s, step.s);
  const av = rescale(a, scale).v;
  const sv = rescale(step, scale).v;
  const units = divRound(av, sv, mode);
  return { v: units * sv, s: scale };
}

/** Whether `a` is an exact multiple of `step`. */
export function isMultipleOf(a: Dec, step: Dec): boolean {
  if (step.v <= 0n) throw new DecimalError('isMultipleOf(): step must be > 0');
  const scale = Math.max(a.s, step.s);
  return rescale(a, scale).v % rescale(step, scale).v === 0n;
}

/**
 * Canonical string form. Always includes exactly `s` decimal places.
 *
 * biome-ignore lint/suspicious/noShadowRestrictedNames: this is a module-level
 * named export on a namespace that is always imported qualified (`D.toString`),
 * not a binding that shadows `Object.prototype.toString` at any call site.
 * Renaming it to `format` would read worse everywhere it is used.
 */
export function toString(a: Dec): string {
  const negative = a.v < 0n;
  const digits = (negative ? -a.v : a.v).toString().padStart(a.s + 1, '0');
  const cut = digits.length - a.s;
  const intPart = digits.slice(0, cut);
  const fracPart = digits.slice(cut);
  const body = a.s === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
}

/** Strip trailing zeros without changing the value. */
export function normalize(a: Dec): Dec {
  let { v, s } = a;
  while (s > 0 && v % 10n === 0n) {
    v /= 10n;
    s -= 1;
  }
  return { v, s };
}

/**
 * Lossy conversion to float64. Named to be greppable.
 *
 * Legitimate uses: chart pixel geometry, advisory indicator maths, telemetry.
 * Never for money, prices compared to ticks, order sizes, or risk figures.
 */
export function unsafeToNumber(a: Dec): number {
  return Number(a.v) / Number(pow10(a.s));
}

/** JSON wire form: a plain decimal string. Preserves scale exactly. */
export function toJSON(a: Dec): string {
  return toString(a);
}

export function fromJSON(s: string): Dec {
  return dec(s);
}
