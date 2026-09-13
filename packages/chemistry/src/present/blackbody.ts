/**
 * A hot surface's colour, from Planck's law rather than from a gradient somebody liked.
 *
 * **`§8.5` and `§17` both lean on this.** A char surface at 1,000 K is a dull red and at 1,300 K is
 * orange, and the reason is not a decision: at 1,000 K a blackbody puts nineteen times more power
 * at 600 nm than at 450, and by 3,000 K the two are within a factor of three. Sampling the same law
 * at three wavelengths reproduces that progression exactly, and an ember therefore has the right
 * colour without anybody having chosen one.
 *
 * **Tabulated, because `exp` may not run on a frame any more than on a tick.** 256 knots over
 * 600-4,000 K, which is every temperature a fire reaches; the ratios between channels vary smoothly
 * enough over that range that linear interpolation is invisible.
 *
 * ---
 *
 * ## What this is not, stated rather than left to be discovered
 *
 * **It samples Planck at three wavelengths; it does not integrate against the CIE colour-matching
 * functions.** A proper conversion integrates the spectrum against three overlapping curves and
 * lands in XYZ, and the chromaticity that comes out is not quite the chromaticity of three point
 * samples. What is right here is the **hue progression** — red, orange, yellow, white, in the order
 * and roughly at the temperatures a real one does it. What is approximate is the exact chromaticity.
 *
 * **Reversal:** integrate against the CIE curves, tabulated the same way, if a consumer ever needs a
 * blackbody to match a reference photograph. It is a bigger table and the same interface.
 */

/**
 * K below which nothing is emitted at all.
 *
 * **Not a fade from room temperature**, which is the tempting shape and the wrong one: a surface at
 * 400 K radiates plenty and none of it is visible, so an emissive term that faded smoothly would
 * make every warm object in a scene glow faintly in the dark. 600 K is roughly where a real surface
 * becomes visible as a dull red in an unlit room, which is the threshold this models.
 */
export const GLOW_MIN_TEMPERATURE = 600;

const TABLE_MIN = GLOW_MIN_TEMPERATURE;
const TABLE_MAX = 4000;
const KNOTS = 256;

/**
 * The three wavelengths sampled, in metres: 600, 550 and 450 nm.
 *
 * Roughly where the human red, green and blue responses peak. Point samples rather than curves —
 * see the header on what that costs.
 */
const WAVELENGTHS = [600e-9, 550e-9, 450e-9];

/** Planck's second radiation constant, `h·c/k`, in metre-kelvin. */
const C2 = 1.438776877e-2;

/**
 * Spectral radiance at a wavelength and temperature, up to constants that cancel on normalisation.
 *
 * `λ⁻⁵ / (exp(hc/λkT) − 1)`, and the leading `2hc²` is dropped because every channel carries it and
 * the result is divided by its own maximum.
 */
function planck(wavelength: number, temperature: number): number {
  const x = C2 / (wavelength * temperature);
  /* `expm1` rather than `exp(x) - 1`: at low temperature `x` is large and the subtraction is fine,
     but at high temperature it approaches zero from above and the naive form loses every digit. */
  // determinism: build-time — presentation: Planck into a glow colour, never simulation state
  return 1 / (wavelength ** 5 * Math.expm1(x));
}

/** Three channels per knot, normalised so the brightest is one. */
const TABLE = (() => {
  const table = new Float32Array(KNOTS * 3);
  for (let i = 0; i < KNOTS; i++) {
    const temperature = TABLE_MIN + ((TABLE_MAX - TABLE_MIN) * i) / (KNOTS - 1);
    let peak = 0;
    for (let c = 0; c < 3; c++) {
      const value = planck(WAVELENGTHS[c] as number, temperature);
      table[i * 3 + c] = value;
      if (value > peak) peak = value;
    }
    for (let c = 0; c < 3; c++) table[i * 3 + c] = (table[i * 3 + c] as number) / peak;
  }
  return table;
})();

/**
 * Linear RGB for a surface at `temperature`, normalised so the brightest channel is one.
 *
 * **A hue, not a brightness.** Separating them is what lets a consumer tone-map: at Stefan-Boltzmann
 * scaling a 3,000 K flame is over eighty times a 1,000 K ember, and a colour channel carrying that
 * range has nothing left for the colour. `glowIntensity` is the other half.
 *
 * Writes into `out` and allocates nothing, because this runs per parcel per frame.
 */
export function blackbodyRGB(temperature: number, out: Float32Array): void {
  const clamped =
    temperature <= TABLE_MIN ? TABLE_MIN : temperature >= TABLE_MAX ? TABLE_MAX : temperature;
  const position = ((clamped - TABLE_MIN) / (TABLE_MAX - TABLE_MIN)) * (KNOTS - 1);
  const low = Math.floor(position);
  const high = low + 1 >= KNOTS ? low : low + 1;
  const at = position - low;
  for (let c = 0; c < 3; c++) {
    out[c] = (TABLE[low * 3 + c] as number) * (1 - at) + (TABLE[high * 3 + c] as number) * at;
  }
}

/**
 * How brightly it glows, relative to 1,000 K.
 *
 * `(T/1000)⁴` — Stefan-Boltzmann, and one multiply chain rather than a `pow`. Doubling the
 * temperature is sixteen times the power, which is why an ember beside a flame is not nearly as much
 * cooler as it looks.
 *
 * Zero below `GLOW_MIN_TEMPERATURE`, for the reason that constant gives.
 */
export function glowIntensity(temperature: number): number {
  if (temperature < GLOW_MIN_TEMPERATURE) return 0;
  const t = temperature / 1000;
  const square = t * t;
  return square * square;
}
