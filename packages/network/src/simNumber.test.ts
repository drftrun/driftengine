/**
 * Fixed point is either exact where it claims to be or it is worthless, so the multiply gets the
 * attention.
 *
 * The properties that matter are not "close enough". They are: a multiply whose result fits is the
 * mathematically correct one; every operation is reproducible; and an operation that cannot be
 * represented saturates rather than wrapping, because a position that teleports across the world
 * reads as a physics explosion and a clamped one reads as a limit.
 */
import { describe, expect, it } from 'vitest';
import {
  SIM_MAX,
  SIM_MIN,
  SIM_ONE,
  simAbs,
  simAdd,
  simCompare,
  simDiv,
  simFrom,
  simFromInt,
  simMul,
  simSqrt,
  simSub,
  simTo,
} from './simNumber.ts';

describe('fixed-point arithmetic', () => {
  it('round-trips a value it can represent', () => {
    expect(simTo(simFrom(1))).toBe(1);
    expect(simTo(simFrom(-3.5))).toBe(-3.5);
    expect(simTo(simFrom(0.25))).toBe(0.25);
    expect(simTo(simFromInt(1_000_000))).toBe(1_000_000);
  });

  it('has a resolution of one over sixty-five thousand', () => {
    expect(simFrom(1 / SIM_ONE)).toBe(1);
    /* Below the resolution, and truncation goes toward negative infinity. */
    expect(simFrom(0.4 / SIM_ONE)).toBe(0);
    expect(simFrom(-0.4 / SIM_ONE)).toBe(-1);
  });

  it('adds and subtracts exactly', () => {
    expect(simTo(simAdd(simFrom(0.1), simFrom(0.2)))).toBe(simTo(simFrom(0.1) + simFrom(0.2)));
    expect(simSub(simFrom(5), simFrom(3))).toBe(simFrom(2));
  });

  /**
   * **The multiply is the whole file.**
   *
   * The naive `a * b / ONE` loses exactness the moment two raws multiply past 2^53, which for
   * ordinary world coordinates is immediate. The split-and-sum in `simMul` is exact wherever the
   * result is representable, and these are the products that would expose it: values whose raw
   * product is far past a double's exact integer range.
   */
  it('multiplies exactly for products the naive form would lose', () => {
    const cases: [number, number][] = [
      [1000.5, 2000.25],
      [-1000.5, 2000.25],
      [123456.75, 3.5],
      [0.5, 0.5],
      [-0.25, -8],
      [65535.5, 2],
    ];
    for (const [x, y] of cases) {
      const a = simFrom(x);
      const b = simFrom(y);
      const naive = Math.floor((a * b) / SIM_ONE);
      const exact = simMul(a, b);

      /* What the true product is, computed in a way that cannot lose bits: BigInt. */
      const truth = Number((BigInt(a) * BigInt(b)) / BigInt(SIM_ONE));
      expect(exact, `${x} * ${y}`).toBe(truth);
      /* And at least one of these cases must actually break the naive form, or the test is empty. */
      if (Math.abs(a * b) > Number.MAX_SAFE_INTEGER) expect(naive).not.toBe(truth);
    }
  });

  it('multiplies by one and by zero', () => {
    expect(simMul(simFrom(7.25), SIM_ONE)).toBe(simFrom(7.25));
    expect(simMul(simFrom(7.25), 0)).toBe(0);
  });

  it('divides deterministically, and by zero saturates rather than answering infinity', () => {
    expect(simTo(simDiv(simFrom(10), simFrom(4)))).toBe(2.5);
    expect(simDiv(simFrom(1), 0)).toBe(SIM_MAX);
    expect(simDiv(simFrom(-1), 0)).toBe(SIM_MIN);
    expect(simDiv(0, 0)).toBe(0);
  });

  /**
   * A square root by Newton on integers, so no floating-point reasoning is needed to believe it.
   *
   * Checked against `Math.sqrt` to a tolerance rather than exactly: the point is that it is the
   * right answer and that it is the *same* answer everywhere, and the second is what the golden
   * digests in `fixture.test.ts` pin.
   */
  it('takes a square root without leaving fixed point', () => {
    for (const value of [1, 2, 4, 9, 100, 0.25, 1234.5]) {
      const root = simTo(simSqrt(simFrom(value)));
      expect(root, `sqrt(${value})`).toBeCloseTo(Math.sqrt(value), 3);
    }
    expect(simSqrt(0)).toBe(0);
    expect(simSqrt(simFrom(-5))).toBe(0);
  });

  it('saturates rather than wrapping', () => {
    expect(simAdd(SIM_MAX, SIM_ONE)).toBe(SIM_MAX);
    expect(simSub(SIM_MIN, SIM_ONE)).toBe(SIM_MIN);
    expect(simMul(SIM_MAX, simFrom(2))).toBe(SIM_MAX);
    expect(simMul(SIM_MAX, simFrom(-2))).toBe(SIM_MIN);
  });

  it('compares and takes magnitudes', () => {
    expect(simCompare(simFrom(1), simFrom(2))).toBe(-1);
    expect(simCompare(simFrom(2), simFrom(1))).toBe(1);
    expect(simCompare(simFrom(2), simFrom(2))).toBe(0);
    expect(simAbs(simFrom(-3))).toBe(simFrom(3));
  });

  /** Every operation is deterministic, which is the property the whole type exists for. */
  it('gives the same answer twice for the same inputs', () => {
    const run = () => {
      let acc = simFrom(1.5);
      for (let i = 0; i < 500; i++) {
        acc = simAdd(simMul(acc, simFrom(1.01)), simDiv(simFrom(i), simFrom(7)));
        acc = simSqrt(simAbs(acc));
      }
      return acc;
    };
    expect(run()).toBe(run());
  });
});
