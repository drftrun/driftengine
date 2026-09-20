/**
 * IEEE 754 binary16 — half precision — on a platform that has no type for it.
 *
 * **The half-precision network path needs a reference, and the reference needs this.** A shader
 * declared `enable f16` computes in sixteen bits, and the only way to say what it should have
 * produced is to round the same arithmetic to the same sixteen bits here. Node 22 has no
 * `Float16Array` and no `Math.f16round`, so the rounding is written out: one sign bit, five exponent
 * bits biased by fifteen, ten mantissa bits, ties to even, overflow to infinity.
 *
 * **What the format cannot hold is the reason the path is optional.** The largest finite value is
 * 65,504 and the smallest normal one is 2^-14, so a network whose activations leave that range is
 * wrong in half precision in a way no tolerance covers — `activationBound` in `inference.ts` is what
 * a consumer asks before choosing it.
 */

/** The largest finite half-precision value. */
export const HALF_MAX = 65504;

/* One scratch view, so reading a double's exponent allocates nothing. */
const BITS = new DataView(new ArrayBuffer(8));

/*
 * Round to the nearest integer, a tie to the even one. `Math.round` rounds a tie up, which is not
 * what any floating-point format does and would make every tie in the tests an error of one unit.
 */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The sixteen bits a value rounds to, as an unsigned integer. */
export function toHalfBits(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  if (magnitude < 2 ** -14) {
    /*
     * Subnormal: the value in units of 2^-24, which is the mantissa directly. A result of 1,024 is
     * the smallest normal value, and its bits are exactly 1,024 — the carry is free.
     */
    return sign | roundEven(magnitude * 2 ** 24);
  }
  /*
   * The exponent from the double's own bits rather than from `Math.log2`, which the language
   * leaves approximate — exact here, because every magnitude this far down the function is a normal
   * double.
   */
  BITS.setFloat64(0, magnitude);
  let exponent = ((BITS.getUint16(0) >> 4) & 0x7ff) - 1023;
  let mantissa = roundEven((magnitude / 2 ** exponent - 1) * 1024);
  if (mantissa === 1024) {
    mantissa = 0;
    exponent += 1;
  }
  /*
   * Overflow is decided here and only here. 65,520 is halfway between the largest finite value and
   * 2^16, its mantissa rounds up to the carry above, and the exponent it lands on is 16.
   */
  if (exponent > 15) return sign | 0x7c00;
  return sign | ((exponent + 15) << 10) | mantissa;
}

/** The value sixteen bits hold. */
export function fromHalfBits(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** The nearest half-precision value, as a number. */
export function roundHalf(value: number): number {
  return fromHalfBits(toHalfBits(value));
}

/** A whole weight array as half-precision bits, each weight rounded on its own. */
export function halfWeights(weights: Float32Array): Uint16Array {
  const out = new Uint16Array(weights.length);
  for (let i = 0; i < weights.length; i += 1) out[i] = toHalfBits(weights[i] as number);
  return out;
}
