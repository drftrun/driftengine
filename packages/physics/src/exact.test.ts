/**
 * Two questions, and they are not the same question.
 *
 * **Is it correct?** Checked against `Math.*`, which is a good implementation on this engine. Within
 * a couple of ulps is the bar; these land within one.
 *
 * **Is it *fixed*?** Checked against committed bit patterns. That is the property the whole
 * apparatus exists for, and `Math.*` cannot be the reference for it, because the entire point is
 * that `Math.*` is allowed to differ between engines. So the reference is a table, and the table is
 * the thing another machine compares against.
 *
 * The golden table caught three wrong coefficients while it was being written — `S2`, `C1` and
 * `P0`, each transcribed one repeated digit short of fdlibm's — which the accuracy check found
 * first, at nineteen ulps *inside* [-π, π] where no range reduction is involved. That is why both
 * tests are here: the accuracy check says the function is right, and the table says it will not
 * quietly become a different function.
 *
 * `scripts/exactness-cross.mjs` prints the same table for pasting from another machine.
 */
import { describe, expect, it } from 'vitest';
import { exactAcos, exactCos, exactExp, exactLog, exactSin } from './exact.ts';

const view = new DataView(new ArrayBuffer(8));

/** A double's exact bit pattern, which is the only unambiguous way to write one down. */
function bits(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

/** How far apart two doubles are, in units of the last place of the larger. */
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  return Math.abs(a - b) / (scale * Number.EPSILON);
}

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: exactSin,
  cos: exactCos,
  exp: exactExp,
  acos: exactAcos,
  log: exactLog,
};

/**
 * **Measured on V8 / x86-64 on 2026-09-03, and these are the numbers another machine must match.**
 *
 * Every entry is produced by the code beside it, not by `Math.*`. A change to any coefficient, to
 * the range reduction, or to the order of operations in a Horner chain moves one of these, which is
 * exactly what should fail a suite.
 */
const GOLDEN: readonly (readonly [string, number, string])[] = [
  ['sin', 0, '0000000000000000'],
  ['sin', 0.5, '3fdeaee8744b05f0'],
  ['sin', 1, '3feaed548f090cee'],
  ['sin', -1, 'bfeaed548f090cee'],
  ['sin', 1.5707963267948966, '3ff0000000000000'],
  ['sin', 3.141592653589793, '3ca1a62633145c07'],
  ['sin', -3.141592653589793, 'bca1a62633145c07'],
  ['sin', 6.283185307179586, 'bcb1a62633145c07'],
  ['sin', 10, 'bfe1689ef5f34f53'],
  ['sin', -10, '3fe1689ef5f34f53'],
  ['sin', 100.5, 'bf9fb3f833470ff1'],
  ['sin', -377.77, 'bfe67abf74fc58a9'],
  ['sin', 1000, '3fea75cc150a206c'],
  ['cos', 0, '3ff0000000000000'],
  ['cos', 0.5, '3fec1528065b7d50'],
  ['cos', 1, '3fe14a280fb5068c'],
  ['cos', -1, '3fe14a280fb5068c'],
  ['cos', 1.5707963267948966, '3c91a62633145c07'],
  ['cos', 3.141592653589793, 'bff0000000000000'],
  ['cos', -3.141592653589793, 'bff0000000000000'],
  ['cos', 6.283185307179586, '3ff0000000000000'],
  ['cos', 10, 'bfead9ac890c6b1f'],
  ['cos', -10, 'bfead9ac890c6b1f'],
  ['cos', 100.5, '3feffc12adaecec1'],
  ['cos', -377.77, '3fe6c63e5ee8570d'],
  ['cos', 1000, '3fe1ff026793f1bb'],
  ['exp', 0, '3ff0000000000000'],
  ['exp', 1, '4005bf0a8b14576a'],
  ['exp', -1, '3fd78b56362cef38'],
  ['exp', 0.5, '3ffa61298e1e069c'],
  ['exp', -0.5, '3fe368b2fc6f960a'],
  ['exp', 5, '40628d389970338f'],
  ['exp', -5, '3f7b993fe00d5376'],
  ['exp', 20, '41bceb088b68e804'],
  ['exp', -20, '3e21b48655f37267'],
  ['exp', 100, '48f3494a9b171bf5'],
  ['exp', -100, '36ea8c1f14e2af5d'],
  ['exp', 709, '7fdd422d2be5dc9b'],
  ['exp', -700, '00d14f2b0fb9307f'],
  ['acos', 1, '0000000000000000'],
  ['acos', -1, '400921fb54442d18'],
  ['acos', 0, '3ff921fb54442d18'],
  ['acos', 0.5, '3ff0c152382d7366'],
  ['acos', -0.5, '4000c152382d7365'],
  ['acos', 0.7071067811865476, '3fe921fb54442d17'],
  ['acos', -0.7071067811865476, '4002d97c7f3321d2'],
  ['acos', 0.9999999, '3f3d4effc851e7f2'],
  ['acos', -0.9999999, '40092110dc45ea89'],
  ['acos', 0.25, '3ff51700e0c14b25'],
  ['acos', -0.75, '400359d26f93b6c3'],
  ['log', 5e-324, 'c0874385446d71c3'],
  ['log', 1e-310, 'c0864e69394d9508'],
  ['log', 0.00001, 'c027069e2aa2aa5b'],
  ['log', 0.1, 'c0026bb1bbb55515'],
  ['log', 0.5, 'bfe62e42fefa39ef'],
  ['log', 0.7071067811865476, 'bfd62e42fefa39ee'],
  ['log', 1.0000004768371582, '3e9fffff800002ab'],
  ['log', 1.0001, '3f1a368d0657fcd4'],
  ['log', 1.5, '3fd9f323ecbf984c'],
  ['log', 2.718281828459045, '3ff0000000000000'],
  ['log', 3, '3ff193ea7aad030a'],
  ['log', 100, '40126bb1bbb55516'],
  ['log', 10000000000, '4037069e2aa2aa5b'],
  ['log', 1.7976931348623157e308, '40862e42fefa39ef'],
];

describe('reproducible transcendentals', () => {
  it('produce the committed bits', () => {
    const wrong: string[] = [];
    for (const [name, input, expected] of GOLDEN) {
      const actual = bits((FUNCTIONS[name] as (x: number) => number)(input));
      if (actual !== expected) wrong.push(`${name}(${input}): ${actual} against ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  it('has a golden entry for every function, and enough of them to be a table', () => {
    for (const name of Object.keys(FUNCTIONS)) {
      const rows = GOLDEN.filter(([fn]) => fn === name);
      expect(rows.length, `${name} has ${rows.length} golden rows`).toBeGreaterThanOrEqual(10);
    }
  });

  /**
   * Correct as well as fixed. A function that reproducibly answers the wrong number is worse than
   * one that answers the right number differently on two machines, because it is wrong everywhere.
   */
  it('agree with the platform to within a unit in the last place', () => {
    let worst = 0;
    for (let i = -2000; i <= 2000; i++) {
      const x = i * 0.37;
      worst = Math.max(worst, ulps(exactSin(x), Math.sin(x)), ulps(exactCos(x), Math.cos(x)));
    }
    for (let i = -700; i <= 700; i++) {
      const x = i * 1.013;
      worst = Math.max(worst, ulps(exactExp(x), Math.exp(x)));
    }
    for (let i = -1000; i <= 1000; i++) {
      worst = Math.max(worst, ulps(exactAcos(x_(i)), Math.acos(x_(i))));
    }
    /* From a subnormal to near the largest double, and densely either side of one. */
    for (let x = 1e-310; x < 1e300; x *= 1.37)
      worst = Math.max(worst, ulps(exactLog(x), Math.log(x)));
    for (let i = -1000; i <= 1000; i++) {
      const x = 1 + i * 1.3e-4;
      worst = Math.max(worst, ulps(exactLog(x), Math.log(x)));
    }
    expect(worst).toBeLessThan(2);
  });

  it('holds accuracy through the range reduction, not only near zero', () => {
    /* At 740 radians a two-piece reduction is 18.5 ulps out. This is the assertion that noticed. */
    for (const x of [377.77, -539.83, 640.1, 1000, -1000]) {
      expect(ulps(exactSin(x), Math.sin(x)), `sin(${x})`).toBeLessThan(2);
      expect(ulps(exactCos(x), Math.cos(x)), `cos(${x})`).toBeLessThan(2);
    }
  });

  it('answers the exact values at the points that have them', () => {
    expect(exactSin(0)).toBe(0);
    expect(exactCos(0)).toBe(1);
    expect(exactExp(0)).toBe(1);
    expect(exactAcos(1)).toBe(0);
    expect(exactAcos(-1)).toBe(Math.PI);
    expect(exactLog(1)).toBe(0);
    /* ECMAScript fixes these two as the doubles nearest ln 2 and ln 10. */
    expect(exactLog(2)).toBe(Math.LN2);
    expect(exactLog(10)).toBe(Math.LN10);
  });

  it('refuses a domain it has no answer for, the way Math does', () => {
    expect(exactAcos(1.5)).toBeNaN();
    expect(exactAcos(-1.5)).toBeNaN();
    expect(exactAcos(Number.NaN)).toBeNaN();
    expect(exactSin(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(exactCos(Number.NEGATIVE_INFINITY)).toBeNaN();
    expect(exactLog(-1)).toBeNaN();
    expect(exactLog(Number.NaN)).toBeNaN();
    expect(exactLog(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(exactLog(-0)).toBe(Number.NEGATIVE_INFINITY);
    expect(exactLog(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('saturates exp rather than producing a wrong finite number', () => {
    expect(exactExp(1000)).toBe(Number.POSITIVE_INFINITY);
    expect(exactExp(-1000)).toBe(0);
    expect(exactExp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(exactExp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(exactExp(Number.NaN)).toBeNaN();
  });

  /*
   * **That this file reaches only arithmetic and `sqrt` is asserted by `scripts/determinism.mjs`**,
   * which scans `packages/core/src/math` among its thirteen simulation roots. A second check here
   * would read the source from disk, which a browser-target test cannot do without `node:fs` — and
   * would be a worse instrument anyway, since the gate sees every file rather than this one.
   */
});

/** The acos sweep's argument, kept out of the loop above so the range is obvious. */
function x_(i: number): number {
  return i / 1000;
}
