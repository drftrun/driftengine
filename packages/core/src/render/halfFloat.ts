/** IEEE 754 binary16 conversion, shared by everything that has to hand a device half floats. */

/** IEEE 754 binary16, via a float32 view, which is the only exact way to read the bits. */
const conversion = new ArrayBuffer(4);
const asFloat = new Float32Array(conversion);
const asUint = new Uint32Array(conversion);

export function halfBits(value: number): number {
  asFloat[0] = value;
  const bits = asUint[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  /* Infinity and NaN carry straight across; a NaN must stay a NaN rather than becoming infinity. */
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);

  /* Rebias 127 to 15. Above half's range saturates to infinity rather than wrapping to zero. */
  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    /*
     * Subnormal. An environment's darkest texels live here, and flushing them to zero is what
     * makes a night sky's gradient band — so they are shifted rather than discarded.
     */
    if (exponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - exponent;
    return sign | (mantissa >>> shift);
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/** A whole array of floats as binary16, which is what a `r16float` or `rgba16float` upload wants. */
export function toHalfFloats(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = halfBits(values[i] ?? 0);
  return out;
}
