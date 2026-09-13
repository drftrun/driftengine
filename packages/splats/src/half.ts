/** IEEE 754 binary16 encoding, because a covariance term is stored as a half and JavaScript has no half. */

/*
 * One scratch pair at module scope, reinterpreting a float's bits without allocating. `packSplats`
 * calls this six times per splat, so a capture of a million splats calls it six million times in
 * one loop — an `ArrayBuffer` per call would be six million of them.
 *
 * Not a hot path in the per-frame sense: packing happens once, on load. It is a hot *loop* all the
 * same, and the house rule's reason applies to both.
 */
const scratch = new ArrayBuffer(4);
const asFloat = new Float32Array(scratch);
const asBits = new Uint32Array(scratch);

/**
 * The 16-bit pattern of the nearest half to `value`, ties to even.
 *
 * **Round to nearest even rather than truncate**, which costs a handful of operations per call and
 * buys a bounded error instead of a biased one: truncation always moves toward zero, so a sum of
 * truncated covariance terms shrinks a splat systematically rather than jittering it. What would
 * make it wrong is nothing about correctness — a truncating version is simpler and is what several
 * published viewers ship; it is half an ulp worse per term and the bias accumulates over six.
 *
 * Overflow saturates to infinity and underflow to a signed zero, which is what the format says.
 * **A covariance term small enough to underflow is a splat smaller than 8 micrometres** at a
 * capture's usual scale, and the low-pass in the vertex stage would swallow it whole.
 */
export function floatToHalf(value: number): number {
  asFloat[0] = value;
  const bits = asBits[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x007fffff;

  /* NaN keeps a non-zero mantissa so it stays NaN; infinity keeps an empty one. */
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x0200);

  /* Rebias: float32 excess-127 to float16 excess-15. */
  const rebiased = exponent - 127 + 15;

  if (rebiased >= 0x1f) return sign | 0x7c00;

  if (rebiased <= 0) {
    /* Past the subnormal range entirely — 24 bits of shift would leave nothing. */
    if (rebiased < -10) return sign;
    /* Subnormal: restore the implicit leading one, then shift it down into place. */
    const full = mantissa | 0x00800000;
    const shift = 14 - rebiased;
    const truncated = full >>> shift;
    const half = truncated & 0xffff;
    const roundBit = (full >>> (shift - 1)) & 1;
    const sticky = (full & ((1 << (shift - 1)) - 1)) === 0 ? 0 : 1;
    const round = roundBit === 1 && (sticky === 1 || (half & 1) === 1) ? 1 : 0;
    return sign | (half + round);
  }

  const truncated = (rebiased << 10) | (mantissa >>> 13);
  const roundBit = (mantissa >>> 12) & 1;
  const sticky = (mantissa & 0x0fff) === 0 ? 0 : 1;
  const round = roundBit === 1 && (sticky === 1 || (truncated & 1) === 1) ? 1 : 0;
  /* Carrying out of the mantissa lands in the exponent, which is exactly right: 65520 rounds up
     to infinity and 2047.5 rounds up to 2048, both by the same addition. */
  return (sign | (truncated + round)) & 0xffff;
}

/**
 * The number a 16-bit pattern stands for. **Tests and tools only** — nothing in a frame decodes a
 * half, because the GPU does it.
 *
 * It exists so a round-trip can be asserted against the value that went in rather than against a
 * second implementation of the encoder, which would only prove the two agree.
 */
export function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * Two halves in one `uint32`, laid out as GLSL's `packHalf2x16`.
 *
 * **`a` occupies the sixteen least significant bits**, which is the specification's wording and is
 * the one detail here that a shader cannot report going wrong: swapping them produces a covariance
 * whose terms are transposed into each other's places, which is a valid matrix and draws a
 * plausible, wrong ellipse.
 */
export function packHalf2x16(a: number, b: number): number {
  return ((floatToHalf(b) << 16) | floatToHalf(a)) >>> 0;
}
