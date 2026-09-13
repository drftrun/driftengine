import { describe, expect, it } from 'vitest';
import {
  GAS_CONSTANT,
  cardinalRate,
  rateAt,
  tabulateArrhenius,
  tabulateCardinal,
} from './rates.ts';

/** The closed form the table stands in for. */
const arrhenius = (A: number, Ea: number, n: number, t: number): number =>
  A * t ** n * Math.exp(-Ea / (GAS_CONSTANT * t));

describe('the rate tables', () => {
  it('agrees with the closed form across the whole range', () => {
    /*
     * The tabulation exists so that `exp` never runs on a tick — it is the single easiest place in
     * the engine to lose determinism between platforms, and it would be called once per reaction
     * per shell per parcel per substep. What that costs is interpolation error, and this is where
     * it is measured rather than assumed.
     */
    const cases: readonly (readonly [number, number, number])[] = [
      [2.8e19, 242400, 0], // cellulose to active cellulose
      [3.28e14, 196500, 0], // the volatile branch
      [1.3e10, 150500, 0], // the char branch
      [9.6e8, 107600, 0], // lignin
      [1e7, 60000, 0.5], // something with a temperature prefactor
    ];
    for (const [A, Ea, n] of cases) {
      const table = tabulateArrhenius(A, Ea, n);
      let worst = 0;
      for (let t = 250; t <= 3400; t += 7.3) {
        const exact = arrhenius(A, Ea, n, t);
        if (exact === 0) continue;
        const drift = Math.abs(rateAt(table, t) - exact) / exact;
        if (drift > worst) worst = drift;
      }
      expect(worst, `A=${A} Ea=${Ea} n=${n}`).toBeLessThan(0.005);
    }
  });

  it('is exact at a knot, not merely close', () => {
    const table = tabulateArrhenius(3.28e14, 196500, 0);
    /* The knots are uniform in 1/T, so this is where one lands. */
    const inverse =
      table.inverseMin + (table.inverseMax - table.inverseMin) * (100 / (table.knots - 1));
    const t = 1 / inverse;
    expect(rateAt(table, t) / arrhenius(3.28e14, 196500, 0, t)).toBeCloseTo(1, 9);
  });

  it('clamps outside its range rather than extrapolating an exponential', () => {
    const table = tabulateArrhenius(1e10, 150000, 0);
    expect(rateAt(table, 100)).toBe(rateAt(table, table.minTemperature));
    expect(rateAt(table, 9000)).toBe(rateAt(table, table.maxTemperature));
  });

  it('rises monotonically with temperature, as an Arrhenius rate must', () => {
    const table = tabulateArrhenius(3.28e14, 196500, 0);
    let previous = -1;
    for (let t = 250; t <= 3400; t += 11) {
      const rate = rateAt(table, t);
      expect(rate).toBeGreaterThanOrEqual(previous);
      previous = rate;
    }
  });

  it('never returns a negative rate', () => {
    const table = tabulateArrhenius(2.8e19, 242400, 0);
    for (let t = 200; t <= 3500; t += 3.7) expect(rateAt(table, t)).toBeGreaterThanOrEqual(0);
  });
});

describe('cardinalRate', () => {
  /*
   * **Enzyme-catalysed rates are peaked, not monotonic**, and modelling decay with Arrhenius gives
   * compost that gets hotter forever — the single most common mistake in this area, and one worth
   * refusing structurally rather than by remembering.
   */
  const MIN = 273.15;
  const OPT = 308.15;
  const MAX = 318.15;

  it('is zero at and outside both ends', () => {
    expect(cardinalRate(MIN, MIN, OPT, MAX)).toBe(0);
    expect(cardinalRate(MAX, MIN, OPT, MAX)).toBe(0);
    expect(cardinalRate(MIN - 20, MIN, OPT, MAX)).toBe(0);
    expect(cardinalRate(MAX + 50, MIN, OPT, MAX)).toBe(0);
  });

  it('is one at the optimum and never above it', () => {
    expect(cardinalRate(OPT, MIN, OPT, MAX)).toBeCloseTo(1, 9);
    for (let t = MIN; t <= MAX; t += 0.25) {
      expect(cardinalRate(t, MIN, OPT, MAX)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('falls off a cliff above the optimum and climbs slowly below it', () => {
    /* The asymmetry is the point: an enzyme denatures far faster than it warms up. */
    const below = cardinalRate(OPT - 5, MIN, OPT, MAX);
    const above = cardinalRate(OPT + 5, MIN, OPT, MAX);
    expect(above).toBeLessThan(below);
  });

  it('tabulates to the same shape', () => {
    const table = tabulateCardinal(1e-4, MIN, OPT, MAX);
    /*
     * Within 0.1% rather than exact, and the optimum is the worst place in the whole table to ask:
     * a peak is where a linearly-interpolated curve always undershoots, because the two knots
     * either side of it are both below it. Everywhere else on this curve is straighter.
     */
    expect(Math.abs(rateAt(table, OPT) - 1e-4) / 1e-4).toBeLessThan(0.001);
    expect(rateAt(table, MAX + 10)).toBe(0);
    expect(rateAt(table, MIN - 10)).toBe(0);
  });

  it('refuses cardinal temperatures that are not in order, naming them', () => {
    expect(() => tabulateCardinal(1, 310, 300, 320)).toThrow(/310/);
    expect(() => tabulateCardinal(1, 270, 300, 290)).toThrow(/290/);
  });
});
