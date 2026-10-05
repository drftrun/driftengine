/**
 * rgb9e5: three 9-bit mantissas over one shared 5-bit exponent, an unsigned float colour in four
 * bytes. `EXT_texture_shared_exponent`'s encoding, the one a GPU's `rgb9e5ufloat` reads, written
 * out so a lightmap page can hold its irradiance in four bytes a texel against a half float's eight.
 *
 * **What it gives up**: precision in the smaller channels, which share the largest one's exponent —
 * a channel a thousandth of its neighbour keeps about one bit — and anything negative or past
 * 65,408, which it clamps. Light is neither, and a bake's colours rarely span more than a few
 * octaves within one texel, so a lightmap loses nothing visible; a value that needs each channel
 * exact wants a format of its own.
 *
 * The bits, low to high: red in 0–8, green in 9–17, blue in 18–26, the exponent in 27–31, biased by
 * 15, and a value is `mantissa * 2^(exponent - 15 - 9)`.
 */

const BIAS = 15;
const MANTISSA_BITS = 9;
const MANTISSA_VALUES = 1 << MANTISSA_BITS;
const MAX_EXPONENT = 31;

/** The largest value the format holds: 511/512 of 2^16. */
export const RGB9E5_MAX = ((MANTISSA_VALUES - 1) / MANTISSA_VALUES) * 2 ** (MAX_EXPONENT - BIAS);

const clampChannel = (v: number): number => (v > 0 ? Math.min(v, RGB9E5_MAX) : 0);

/** One colour packed into its 32 bits, rounding to nearest; NaN and negatives are zero. */
export function packRgb9e5(red: number, green: number, blue: number): number {
  const r = clampChannel(red);
  const g = clampChannel(green);
  const b = clampChannel(blue);
  const largest = Math.max(r, g, b);
  let exponent = Math.max(-BIAS - 1, Math.floor(Math.log2(largest))) + 1 + BIAS;
  let scale = 2 ** (exponent - BIAS - MANTISSA_BITS);
  /* Rounding the largest channel up to 512 needs one more exponent, which the spec allows for. */
  if (Math.floor(largest / scale + 0.5) === MANTISSA_VALUES) {
    exponent += 1;
    scale *= 2;
  }
  /* Inline rather than a helper: a page packs millions of texels, and a closure a call is one each. */
  const mr = Math.min(MANTISSA_VALUES - 1, Math.floor(r / scale + 0.5));
  const mg = Math.min(MANTISSA_VALUES - 1, Math.floor(g / scale + 0.5));
  const mb = Math.min(MANTISSA_VALUES - 1, Math.floor(b / scale + 0.5));
  return (mr | (mg << 9) | (mb << 18) | (exponent << 27)) >>> 0;
}

/** A packed colour's three channels, into `out[at…at+2]`. */
export function unpackRgb9e5(bits: number, out: { [index: number]: number }, at = 0): void {
  const scale = 2 ** ((bits >>> 27) - BIAS - MANTISSA_BITS);
  out[at] = (bits & 511) * scale;
  out[at + 1] = ((bits >>> 9) & 511) * scale;
  out[at + 2] = ((bits >>> 18) & 511) * scale;
}
