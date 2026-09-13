/**
 * Reaction rates as tables, because `exp` may not run on a tick.
 *
 * **The reasoning is `§7`'s and it is a hard rule rather than a preference.** `AGENTS.md` already
 * made this call once, for the tyre curve: Pacejka is `sin(atan(…))` and both were banned from the
 * tick, so the curve became a table and the API came out better than the closed form. The same
 * applies here with more force. `exp(−Ea/RT)` would be evaluated once per reaction per shell per
 * parcel per substep — a hundred times the tyre call count — and it varies by twenty orders of
 * magnitude over the range of interest, which makes it the single easiest place in the engine to
 * lose determinism to one platform's `exp` differing in the last bit.
 *
 * **Knots are uniform in `1/T`, and that is a departure from the design worth recording.** `§7`
 * says "512 logarithmically-spaced knots, log-`k` stored so the interpolation is in the variable
 * that is nearly linear" — and `ln k = ln A + n·ln T − Ea/(R·T)` is not nearly linear in `ln T`, it
 * is *exactly* linear in `1/T` for the `n = 0` form that almost every rate in the library uses. So
 * the knots are uniform in `1/T`, which puts the interpolation error where the design wanted it.
 *
 * **But `k` is stored rather than `ln k`, and that is the other half of the correction.** The
 * design's own sentence would need an `exp` at every lookup, which is the thing the paragraph above
 * it forbids — the two halves of `§7` contradict each other, and this is the resolution. Storing
 * `k` and interpolating linearly costs a real interpolation error, bounded by about `δ²/8` where
 * `δ` is the change in `ln k` across one knot. At 1,024 knots over 200–3500 K that is under half a
 * percent for every activation energy in the library, **which is comfortably inside the uncertainty
 * in the activation energies themselves** — literature values for cellulose pyrolysis differ by
 * several percent between studies. `rates.test.ts` measures it rather than trusting this paragraph.
 */

/** J/(mol·K). */
export const GAS_CONSTANT = 8.314462618;

const DEFAULT_MIN = 200;
const DEFAULT_MAX = 3500;
const DEFAULT_KNOTS = 1024;

export interface RateTable {
  readonly minTemperature: number;
  readonly maxTemperature: number;
  /** `1 / maxTemperature`: the low end of the knot axis. */
  readonly inverseMin: number;
  /** `1 / minTemperature`: the high end of it. */
  readonly inverseMax: number;
  readonly knots: number;
  /** Rate at each knot, ascending in `1/T` — so descending in temperature. */
  readonly rate: Float64Array;
}

function tabulate(
  at: (temperature: number) => number,
  min: number,
  max: number,
  knots: number,
): RateTable {
  if (!(max > min) || !(min > 0)) {
    throw new Error(
      `a rate table spans ${min}..${max} K, which is not an ascending positive range`,
    );
  }
  const inverseMin = 1 / max;
  const inverseMax = 1 / min;
  const rate = new Float64Array(knots);
  for (let i = 0; i < knots; i++) {
    const inverse = inverseMin + ((inverseMax - inverseMin) * i) / (knots - 1);
    rate[i] = at(1 / inverse);
  }
  return { minTemperature: min, maxTemperature: max, inverseMin, inverseMax, knots, rate };
}

/** `k(T) = A · T^n · exp(−Ea / R·T)`, sampled once so the tick never evaluates it. */
export function tabulateArrhenius(
  A: number,
  activationEnergy: number,
  n = 0,
  min = DEFAULT_MIN,
  max = DEFAULT_MAX,
  knots = DEFAULT_KNOTS,
): RateTable {
  return tabulate(
    // determinism: build-time — the Arrhenius table is built once so exp never runs on a tick
    (t) => A * t ** n * Math.exp(-activationEnergy / (GAS_CONSTANT * t)),
    min,
    max,
    knots,
  );
}

/**
 * The peaked curve an enzyme-catalysed rate actually follows, normalised to one at the optimum.
 *
 * Zero at both cardinal ends, one at `optimum`, and **asymmetric in the right direction**: a slow
 * climb and a sharp fall, because an enzyme denatures far faster than it warms up. Modelling decay
 * or fermentation with Arrhenius instead gives compost that gets hotter forever, which is the most
 * common mistake in this area and is refused here structurally rather than by remembering.
 */
export function cardinalRate(
  temperature: number,
  min: number,
  optimum: number,
  max: number,
): number {
  if (temperature <= min || temperature >= max) return 0;
  const above = temperature - min;
  const numerator = above * above * (temperature - max);
  const denominator =
    (optimum - min) *
    ((optimum - min) * (temperature - optimum) -
      (optimum - max) * (optimum + min - 2 * temperature));
  if (denominator === 0) return 0;
  const value = numerator / denominator;
  return value > 0 ? value : 0;
}

/** A cardinal curve scaled to a peak rate, tabulated the same way an Arrhenius one is. */
export function tabulateCardinal(
  peak: number,
  min: number,
  optimum: number,
  max: number,
  low = DEFAULT_MIN,
  high = DEFAULT_MAX,
  knots = DEFAULT_KNOTS,
): RateTable {
  if (!(min < optimum)) {
    throw new Error(
      `cardinal temperatures are out of order: minimum ${min} is not below optimum ${optimum}`,
    );
  }
  if (!(optimum < max)) {
    throw new Error(
      `cardinal temperatures are out of order: maximum ${max} is not above optimum ${optimum}`,
    );
  }
  return tabulate((t) => peak * cardinalRate(t, min, optimum, max), low, high, knots);
}

/**
 * The rate at a temperature.
 *
 * Two multiplications, a floor and a lerp. Clamped at both ends rather than extrapolated: linearly
 * extrapolating an exponential is how a rate table produces a number with nothing behind it.
 */
export function rateAt(table: RateTable, temperature: number): number {
  if (temperature <= table.minTemperature) return table.rate[table.knots - 1] as number;
  if (temperature >= table.maxTemperature) return table.rate[0] as number;

  const position =
    ((1 / temperature - table.inverseMin) / (table.inverseMax - table.inverseMin)) *
    (table.knots - 1);
  const low = Math.floor(position);
  const high = low + 1;
  if (high >= table.knots) return table.rate[table.knots - 1] as number;
  const at = position - low;
  return (table.rate[low] as number) * (1 - at) + (table.rate[high] as number) * at;
}
