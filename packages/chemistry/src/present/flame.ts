/**
 * What a flame looks like, from what it is doing.
 *
 * **Nothing here is an art direction.** Its height is the published plume correlation over its own
 * heat release; its colour is `§8.4`'s argument that a luminous flame is orange because it contains
 * incandescent soot and a clean one is blue because it does not. A gas ring is short and blue and a
 * bonfire is tall and orange for the reasons they actually are.
 */
import { blackbodyRGB } from './blackbody.ts';

/**
 * `Q^(2/5)`, tabulated, because `pow` is a transcendental and this runs per fire per frame.
 *
 * Knots uniform in `Q^(1/2)` rather than in `Q`, which puts them where the curve bends: the
 * two-fifths power changes fastest near zero, and uniform-in-Q knots would spend three hundred of
 * them on the flat end and none on the part where a fire grows from nothing.
 */
const POWER_MIN = 0;
const POWER_MAX = 20000;
const POWER_KNOTS = 512;
const POWER_TABLE = (() => {
  const table = new Float64Array(POWER_KNOTS);
  const rootMax = Math.sqrt(POWER_MAX);
  for (let i = 0; i < POWER_KNOTS; i++) {
    const root = (rootMax * i) / (POWER_KNOTS - 1);
    // determinism: build-time — presentation: a flame-height lookup table, built once
    table[i] = (root * root) ** 0.4;
  }
  return table;
})();

function twoFifths(kilowatts: number): number {
  if (!(kilowatts > POWER_MIN)) return 0;
  if (kilowatts >= POWER_MAX) return POWER_TABLE[POWER_KNOTS - 1] as number;
  const position = (Math.sqrt(kilowatts) / Math.sqrt(POWER_MAX)) * (POWER_KNOTS - 1);
  const low = Math.floor(position);
  const at = position - low;
  return (POWER_TABLE[low] as number) * (1 - at) + (POWER_TABLE[low + 1] as number) * at;
}

/**
 * Metres of visible flame over a fire of `kilowatts` on a base `diameter` metres across.
 *
 * **Heskestad's correlation, `L = 0.235·Q^(2/5) − 1.02·D`**, which is the standard flame-height
 * relation in fire engineering and is here verbatim. A 100 kW campfire over a 0.3 m base stands
 * 1.18 m; a megawatt over a metre stands 2.71.
 *
 * **The two-fifths power is the interesting part**: ten times the fire is two and a half times the
 * flame, which is why a large fire looks less impressive than its output suggests and why the
 * flames over a room fire are shorter than people draw them.
 *
 * Clamped at zero, and a negative result is physics rather than a domain error: a few kilowatts
 * spread over a metre is a smouldering surface with no standing flame over it at all.
 */
export function flameHeight(kilowatts: number, diameter: number): number {
  const height = 0.235 * twoFifths(kilowatts) - 1.02 * diameter;
  return height > 0 ? height : 0;
}

/**
 * Where soot starts forming, as an equivalence ratio.
 *
 * `§8.4`'s table: below stoichiometric there is enough oxygen to burn everything and the flame is
 * clean; between 1.5 and 3 it is the classic luminous orange. One below the other is the onset.
 */
const SOOT_ONSET = 1.0;
const SOOT_FULL = 3.0;

/**
 * How luminous the soot makes a flame, 0 to 1, from the equivalence ratio.
 *
 * Zero for a lean flame — there is no soot in one, which is why a gas ring is nearly invisible in
 * daylight — climbing through the band where soot forms. Above `SOOT_FULL` the flame is too rich to
 * burn at all and what leaves is smoke, which `§8.4` says and the field's own chemistry produces;
 * this stays at one rather than pretending to model that.
 */
export function sootLuminosity(equivalenceRatio: number): number {
  if (!(equivalenceRatio > SOOT_ONSET)) return 0;
  const share = (equivalenceRatio - SOOT_ONSET) / (SOOT_FULL - SOOT_ONSET);
  return share > 1 ? 1 : share;
}

/**
 * Linear RGB of the CH* and C₂* chemiluminescence a clean flame is seen by.
 *
 * 431 nm and 516 nm, which is genuinely blue-green, and it is what you are looking at when you look
 * at a gas ring. A fixed colour rather than a curve because it is two emission *lines* rather than a
 * continuum — that is the whole difference between it and the blackbody term.
 */
const CHEMILUMINESCENCE = [0.12, 0.45, 1.0];

/**
 * A flame's linear RGB: incandescent soot mixed with chemiluminescence by the equivalence ratio.
 *
 * `§8.4` again — the model computes φ and the soot mass, and this maps them. The result is that
 * **nobody chose a flame colour**: a methanol flame is nearly invisible, a candle is orange, a
 * bunsen burner with its collar open is blue, and all three come out of one ratio.
 *
 * Writes into `out`, allocates nothing.
 */
export function flameColour(
  equivalenceRatio: number,
  temperature: number,
  out: Float32Array,
): void {
  const soot = sootLuminosity(equivalenceRatio);
  blackbodyRGB(temperature, out);
  for (let c = 0; c < 3; c++) {
    out[c] = (out[c] as number) * soot + (CHEMILUMINESCENCE[c] as number) * (1 - soot);
  }
}
