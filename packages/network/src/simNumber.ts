/**
 * Fixed-point arithmetic, 48.16, for a simulation that wants determinism by construction.
 *
 * **Opt-in, and the gate is the default.** `scripts/determinism.mjs` plus `math/exact.ts` make a
 * floating-point simulation reproducible across engines, and that is the recommended path: it costs
 * nothing, changes no stored replay, and is what every package in this repository already does.
 * This exists for a consumer who would rather not depend on an argument about IEEE 754 at all.
 *
 * **A value is an integer held in a double**, scaled by 2^16. Add, subtract, compare and negate are
 * integer operations and are exact by inspection. Multiply and divide are where a fixed-point
 * library is either right or quietly wrong, so they are §2 and §3 below.
 *
 * ---
 *
 * ## 1. Why 48.16 and not 32.32
 *
 * A double holds integers exactly to 2^53. Spending 32 bits on the fraction leaves 21 for the
 * integer part — about two million, which as metres is a world 2,000 km across but as *raw values*
 * leaves almost nothing for intermediate results. 16 fractional bits give a resolution of 15
 * micrometres and an integer range of ±2^37, which is more world than anybody has and enough
 * headroom that a multiply's terms stay exact.
 *
 * ## 2. Multiplication is exact wherever its result is representable
 *
 * The naive `a * b / ONE` overflows immediately: two raws of 2^40 multiply to 2^80 and a double
 * stops being exact at 2^53. The fix is to split both operands at the fixed point —
 * `a = A·2^16 + α` — and sum four terms:
 *
 * ```text
 * a·b/2^16  =  A·B·2^16  +  A·β  +  α·B  +  ⌊α·β/2^16⌋
 * ```
 *
 * Every term is exact for a reason: `A·β` and `α·B` are at most 2^37·2^16 = 2^53; `α·β` is at most
 * 2^32; and `A·B·2^16` is the result's own integer part, so it is exact exactly when the result is
 * representable. **The domain is therefore "results that fit", which is the only domain a caller
 * can reason about.**
 *
 * The low term truncates toward negative infinity, which is a decision and not a rounding accident:
 * `Math.floor` is exactly specified, `Math.round` is too, and either is reproducible — but flooring
 * is the one that makes the decomposition's arithmetic hold, because `α` and `β` are defined as the
 * remainders a floor produces.
 *
 * ## 3. Division is deterministic rather than exact, and that is the honest word
 *
 * `⌊(a/b)·2^16⌋` uses one IEEE division, which every conforming engine rounds identically, then an
 * exact multiplication by a power of two and an exactly specified floor. The result may differ by a
 * unit in the last place from the true quotient. **It cannot differ between machines**, which is the
 * property this file exists for. A caller wanting exact division wants rationals, which is a
 * different library.
 *
 * ## 4. Overflow saturates, and says so
 *
 * A result outside the representable range clamps to the end of it. Not a throw, because
 * `AGENTS.md` forbids one in a frame loop; not a wrap, because a position that teleports from one
 * edge of the world to the other is a bug that looks like a physics explosion. Saturation is
 * deterministic, which is the one property that must not be given up — every peer saturates
 * identically, so a session stays in agreement even while it is wrong.
 */

/** Fractional bits. The whole format is this number. */
export const SIM_FRACTION_BITS = 16;

/** One, as a raw value. */
export const SIM_ONE = 65536;

/** The largest and smallest representable raws, which is a double's exact integer range. */
export const SIM_MAX = 9007199254740991;
export const SIM_MIN = -9007199254740991;

/** A fixed-point value: an integer, scaled by `SIM_ONE`, carried in a double. */
export type Sim = number;

/** From an ordinary number. Truncates toward negative infinity, as everything here does. */
export function simFrom(value: number): Sim {
  return clamp(Math.floor(value * SIM_ONE));
}

/** Back to an ordinary number. Exact: a division by a power of two. */
export function simTo(value: Sim): number {
  return value / SIM_ONE;
}

/** From an integer, exactly, with no rounding to think about. */
export function simFromInt(value: number): Sim {
  return clamp(Math.trunc(value) * SIM_ONE);
}

export function simAdd(a: Sim, b: Sim): Sim {
  return clamp(a + b);
}

export function simSub(a: Sim, b: Sim): Sim {
  return clamp(a - b);
}

export function simNeg(a: Sim): Sim {
  return -a;
}

export function simAbs(a: Sim): Sim {
  return a < 0 ? -a : a;
}

export function simMin(a: Sim, b: Sim): Sim {
  return a < b ? a : b;
}

export function simMax(a: Sim, b: Sim): Sim {
  return a > b ? a : b;
}

/** -1, 0 or 1. Present so a caller compares through this file rather than by hand. */
export function simCompare(a: Sim, b: Sim): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Multiply. Exact wherever the result is representable; see §2 of the header.
 *
 * The split is at the fixed point, so `high` is the integer part and `low` the fractional part
 * scaled — both non-negative for a negative operand too, because `Math.floor` goes toward negative
 * infinity and the remainder is taken against that.
 */
export function simMul(a: Sim, b: Sim): Sim {
  const aHigh = Math.floor(a / SIM_ONE);
  const aLow = a - aHigh * SIM_ONE;
  const bHigh = Math.floor(b / SIM_ONE);
  const bLow = b - bHigh * SIM_ONE;

  const product =
    aHigh * bHigh * SIM_ONE + aHigh * bLow + aLow * bHigh + Math.floor((aLow * bLow) / SIM_ONE);

  return clamp(product);
}

/** Divide. Deterministic rather than exact; see §3 of the header. Division by zero saturates. */
export function simDiv(a: Sim, b: Sim): Sim {
  if (b === 0) return a < 0 ? SIM_MIN : a > 0 ? SIM_MAX : 0;
  return clamp(Math.floor((a / b) * SIM_ONE));
}

/**
 * Square root, by Newton's method on integers.
 *
 * **Not `Math.sqrt` of the scaled value**, even though `Math.sqrt` is exactly rounded and would be
 * reproducible: the scaling back and forth introduces a rounding this file has no way to pin, and
 * the whole argument for fixed point is that no floating-point reasoning is needed to believe it.
 * Newton on integers converges in a bounded number of steps and every step is exact.
 *
 * Negative input answers zero, the way a length does. It is not an error worth a branch at every
 * call site.
 */
export function simSqrt(a: Sim): Sim {
  if (a <= 0) return 0;

  /* sqrt(a/ONE) * ONE = sqrt(a * ONE). The product is the one place range matters. */
  const target = a * SIM_ONE;
  if (!Number.isFinite(target) || target > SIM_MAX) {
    /* Halve the argument twice, take the root, and double the result: sqrt(4x) = 2·sqrt(x). */
    return clamp(2 * simSqrt(Math.floor(a / 4)));
  }

  let guess = Math.floor(a) || 1;
  for (let i = 0; i < 40; i++) {
    const next = Math.floor((guess + Math.floor(target / guess)) / 2);
    if (next === guess || next === guess - 1) return clamp(next);
    guess = next;
  }
  return clamp(guess);
}

function clamp(value: number): number {
  if (value > SIM_MAX) return SIM_MAX;
  if (value < SIM_MIN) return SIM_MIN;
  return value;
}
