import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as D from './decimal.js';

const d = D.dec;
const s = D.toString;

describe('dec() parsing', () => {
  it('parses plain decimals preserving written scale', () => {
    expect(d('1.2345')).toEqual({ v: 12345n, s: 4 });
    expect(d('1.50')).toEqual({ v: 150n, s: 2 });
    expect(d('1.5')).toEqual({ v: 15n, s: 1 });
    expect(d('-0.001')).toEqual({ v: -1n, s: 3 });
    expect(d('0')).toEqual({ v: 0n, s: 0 });
    expect(d('-0')).toEqual({ v: 0n, s: 0 });
    expect(d('+7.25')).toEqual({ v: 725n, s: 2 });
  });

  it('treats 1.50 and 1.5 as equal in value but distinct in precision', () => {
    expect(D.eq(d('1.50'), d('1.5'))).toBe(true);
    expect(d('1.50').s).not.toBe(d('1.5').s);
  });

  it('rejects scientific notation, which hides scale intent', () => {
    expect(() => d('1e-8')).toThrow(D.DecimalError);
    expect(() => d('1E5')).toThrow(D.DecimalError);
  });

  it('rejects garbage rather than coercing it', () => {
    for (const bad of ['', 'abc', '1.2.3', '--1', '1,5', 'NaN', 'Infinity', ' ']) {
      expect(() => d(bad), `should reject ${JSON.stringify(bad)}`).toThrow(D.DecimalError);
    }
  });

  it('refuses non-integer float input so float error cannot enter the system', () => {
    expect(() => d(0.1)).toThrow(/refusing to convert non-integer/);
    expect(d(42)).toEqual({ v: 42n, s: 0 });
  });

  it('accepts bigint directly at scale 0', () => {
    expect(d(9007199254740993n)).toEqual({ v: 9007199254740993n, s: 0 });
  });
});

describe('exactness where float64 fails', () => {
  it('0.1 + 0.2 === 0.3 exactly', () => {
    expect(s(D.add(d('0.1'), d('0.2')))).toBe('0.3');
    // The canonical demonstration that this module exists for a reason:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('accumulates a hundred 0.01s to exactly 1.00', () => {
    let acc = d('0.00');
    for (let i = 0; i < 100; i++) acc = D.add(acc, d('0.01'));
    expect(s(acc)).toBe('1.00');
  });

  it('handles notionals beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = d('90071992547409910.12');
    expect(s(D.add(big, d('0.01')))).toBe('90071992547409910.13');
  });
});

describe('arithmetic scale rules', () => {
  it('add/sub take the max scale', () => {
    expect(D.add(d('1.5'), d('2.25'))).toEqual({ v: 375n, s: 2 });
    expect(D.sub(d('1.5'), d('2.25'))).toEqual({ v: -75n, s: 2 });
  });

  it('mul sums the scales', () => {
    expect(D.mul(d('1.5'), d('2.25'))).toEqual({ v: 3375n, s: 3 });
  });

  it('mul refuses to silently exceed the scale ceiling', () => {
    const deep = D.raw(1n, 30);
    expect(() => D.mul(deep, deep)).toThrow(/exceeds max/);
  });

  it('div requires an explicit scale and mode', () => {
    expect(s(D.div(d('1'), d('3'), 5, 'down'))).toBe('0.33333');
    expect(s(D.div(d('2'), d('3'), 5, 'half-up'))).toBe('0.66667');
    expect(s(D.div(d('2'), d('3'), 5, 'down'))).toBe('0.66666');
  });

  it('div by zero throws rather than producing Infinity', () => {
    expect(() => D.div(d('1'), d('0'), 2, 'down')).toThrow(D.DecimalError);
  });
});

describe('rounding modes', () => {
  const cases: Array<[string, D.RoundingMode, string]> = [
    ['2.5', 'down', '2'],
    ['2.5', 'up', '3'],
    ['2.5', 'floor', '2'],
    ['2.5', 'ceil', '3'],
    ['2.5', 'half-up', '3'],
    ['2.5', 'half-even', '2'],
    ['3.5', 'half-even', '4'],
    ['-2.5', 'down', '-2'],
    ['-2.5', 'up', '-3'],
    ['-2.5', 'floor', '-3'],
    ['-2.5', 'ceil', '-2'],
    ['-2.5', 'half-up', '-3'],
    ['-2.5', 'half-even', '-2'],
    ['-2.4', 'floor', '-3'],
    ['-2.6', 'ceil', '-2'],
  ];
  for (const [input, mode, expected] of cases) {
    it(`rescale(${input}, 0, '${mode}') === ${expected}`, () => {
      expect(s(D.rescale(d(input), 0, mode))).toBe(expected);
    });
  }

  it('refuses to reduce scale without an explicit mode', () => {
    expect(() => D.rescale(d('1.234'), 1)).toThrow(/rounding mode is required/);
  });

  it('increases scale losslessly without a mode', () => {
    expect(D.rescale(d('1.5'), 4)).toEqual({ v: 15000n, s: 4 });
  });
});

describe('quantize — tick and lot-step snapping', () => {
  it('snaps a price down to a 5-digit tick', () => {
    expect(s(D.quantize(d('1.234567'), d('0.00001'), 'down'))).toBe('1.234560');
  });

  it('snaps volume down to lot step so risk is never exceeded', () => {
    expect(s(D.quantize(d('0.376'), d('0.01'), 'down'))).toBe('0.370');
  });

  it('snaps a stop outward (away from entry) via floor/ceil', () => {
    // Long: stop sits below entry, so it must not move up -> floor.
    expect(s(D.quantize(d('1.23456'), d('0.0001'), 'floor'))).toBe('1.23450');
    // Short: stop sits above entry, so it must not move down -> ceil.
    expect(s(D.quantize(d('1.23456'), d('0.0001'), 'ceil'))).toBe('1.23460');
    // The invariant that actually matters: the snapped stop is never tighter.
    const entry = d('1.30000');
    const rawStop = d('1.23456');
    const snapped = D.quantize(rawStop, d('0.0001'), 'floor');
    expect(D.gte(D.sub(entry, snapped), D.sub(entry, rawStop))).toBe(true);
  });

  it('handles negatives per mode', () => {
    // -1.234567 / 0.0001 = -12345.67
    expect(s(D.quantize(d('-1.234567'), d('0.0001'), 'floor'))).toBe('-1.234600'); // -12346
    expect(s(D.quantize(d('-1.234567'), d('0.0001'), 'ceil'))).toBe('-1.234500'); // -12345
    expect(s(D.quantize(d('-1.234567'), d('0.0001'), 'down'))).toBe('-1.234500'); // toward zero
    expect(s(D.quantize(d('-1.234567'), d('0.0001'), 'up'))).toBe('-1.234600'); // away from zero
  });

  it('rejects a non-positive step', () => {
    expect(() => D.quantize(d('1'), d('0'), 'down')).toThrow(D.DecimalError);
    expect(() => D.quantize(d('1'), d('-1'), 'down')).toThrow(D.DecimalError);
  });

  it('isMultipleOf detects off-tick prices', () => {
    expect(D.isMultipleOf(d('1.2340'), d('0.0001'))).toBe(true);
    expect(D.isMultipleOf(d('1.23405'), d('0.0001'))).toBe(false);
    expect(D.isMultipleOf(d('0.30'), d('0.10'))).toBe(true);
  });
});

describe('toString / round-trip', () => {
  it('always renders exactly `s` decimal places', () => {
    expect(s(D.raw(5n, 3))).toBe('0.005');
    expect(s(D.raw(-5n, 3))).toBe('-0.005');
    expect(s(D.raw(0n, 2))).toBe('0.00');
    expect(s(D.raw(1000n, 2))).toBe('10.00');
  });

  it('normalize strips trailing zeros without changing value', () => {
    expect(D.normalize(d('1.500'))).toEqual({ v: 15n, s: 1 });
    expect(D.normalize(d('100'))).toEqual({ v: 100n, s: 0 });
    expect(D.eq(D.normalize(d('1.500')), d('1.5'))).toBe(true);
  });

  it('survives a JSON round trip exactly', () => {
    for (const x of ['0', '-0.001', '1.2345', '999999999999999999.99']) {
      expect(s(D.fromJSON(D.toJSON(d(x))))).toBe(s(d(x)));
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based tests: the algebraic laws that everything above depends on.
// ---------------------------------------------------------------------------

const arbDec = fc
  .tuple(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), fc.integer({ min: 0, max: 12 }))
  .map(([v, sc]) => D.raw(v, sc));

describe('algebraic properties', () => {
  it('addition is commutative', () => {
    fc.assert(
      fc.property(arbDec, arbDec, (a, b) => {
        expect(D.eq(D.add(a, b), D.add(b, a))).toBe(true);
      }),
    );
  });

  it('addition is associative', () => {
    fc.assert(
      fc.property(arbDec, arbDec, arbDec, (a, b, c) => {
        expect(D.eq(D.add(D.add(a, b), c), D.add(a, D.add(b, c)))).toBe(true);
      }),
    );
  });

  it('a - a is zero for all a', () => {
    fc.assert(
      fc.property(arbDec, (a) => {
        expect(D.isZero(D.sub(a, a))).toBe(true);
      }),
    );
  });

  it('multiplication distributes over addition', () => {
    fc.assert(
      fc.property(arbDec, arbDec, arbDec, (a, b, c) => {
        expect(D.eq(D.mul(a, D.add(b, c)), D.add(D.mul(a, b), D.mul(a, c)))).toBe(true);
      }),
    );
  });

  it('toString round-trips through dec() for every value', () => {
    fc.assert(
      fc.property(arbDec, (a) => {
        expect(D.eq(d(D.toString(a)), a)).toBe(true);
      }),
    );
  });

  it('cmp is a total order consistent with sub', () => {
    fc.assert(
      fc.property(arbDec, arbDec, (a, b) => {
        expect(D.cmp(a, b)).toBe(D.sign(D.sub(a, b)));
      }),
    );
  });

  it('quantize(down) never increases magnitude beyond the input', () => {
    fc.assert(
      fc.property(arbDec, fc.integer({ min: 0, max: 8 }), (a, e) => {
        const step = D.raw(1n, e);
        const q = D.quantize(a, step, 'down');
        expect(D.lte(D.abs(q), D.abs(a))).toBe(true);
        expect(D.isMultipleOf(q, step)).toBe(true);
      }),
    );
  });

  it('quantize(floor) <= input <= quantize(ceil)', () => {
    fc.assert(
      fc.property(arbDec, fc.integer({ min: 0, max: 8 }), (a, e) => {
        const step = D.raw(1n, e);
        expect(D.lte(D.quantize(a, step, 'floor'), a)).toBe(true);
        expect(D.gte(D.quantize(a, step, 'ceil'), a)).toBe(true);
      }),
    );
  });

  it('div then mul recovers the numerator within one ulp of the target scale', () => {
    fc.assert(
      fc.property(
        arbDec,
        arbDec.filter((x) => !D.isZero(x)),
        (a, b) => {
          const scale = 20;
          const q = D.div(a, b, scale, 'down');
          const back = D.mul(q, b);
          const err = D.abs(D.sub(back, a));
          // Truncating division: error < |b| * 10^-scale
          const ulp = D.mul(D.abs(b), D.raw(1n, scale));
          expect(D.lte(err, ulp)).toBe(true);
        },
      ),
    );
  });
});
