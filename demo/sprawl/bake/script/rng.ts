/**
 * The script language's seeded generator (`math.Rng`), reproduced bit for bit.
 *
 * Every building in the reference draws its variation from one of these, seeded per instance, so a
 * generator that differs in one bit, or a draw made in a different order, changes every building
 * after it. It is a **middle-square Weyl sequence** (Widynski, arXiv:1704.00358, 2017) whose state
 * is seeded through the **SplitMix64** finaliser (Steele, Lea and Flood, OOPSLA 2014; constants from
 * Vigna's `splitmix64.c`), exactly as the language's own `math.Rng` does (Flecs, MIT).
 *
 * The seed is read on the first draw rather than at construction: the language builds the value
 * first and fills `seed` afterwards, so a generator nobody draws from is never seeded at all.
 *
 * All arithmetic is 64-bit unsigned, which JavaScript only has as `BigInt`. That costs roughly a
 * microsecond per draw, and a whole city makes a few million draws.
 */

const MASK = (1n << 64n) - 1n;
const WEYL = 0xb5ad4eceda1ce2a9n;
/** `(double)UINT64_MAX` in C, which rounds to 2⁶⁴. */
const U64_MAX_AS_DOUBLE = 18446744073709551616;

/** SplitMix64's finaliser, applied to `x` plus the golden-ratio increment. */
export function splitMix(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}

export class ScriptRng {
  /** The seed as a 64-bit unsigned integer; read on the first draw. */
  seed: bigint;
  private x = 0n;
  private w = 0n;
  private seeded = false;

  constructor(seed: bigint) {
    this.seed = BigInt.asUintN(64, seed);
  }

  /** The next 64 bits of the sequence. */
  next(): bigint {
    if (!this.seeded) {
      this.x = splitMix(this.seed);
      this.w = splitMix(this.x);
      this.seeded = true;
    }
    this.x = (this.x * this.x) & MASK;
    this.w = (this.w + WEYL) & MASK;
    this.x = (this.x + this.w) & MASK;
    this.x = ((this.x >> 32n) | (this.x << 32n)) & MASK;
    return this.x;
  }

  /**
   * An integer in `[0, max)`. `max` is the language's conversion of its argument to `u64`,
   * truncation, which the caller has already applied. Zero is refused: the language reports it
   * as a division by zero.
   */
  u(max: bigint): bigint {
    if (max === 0n) throw new Error('Rng.u(): the bound is zero');
    return this.next() % max;
  }

  /** A float in `[0, max]`, formed as the language forms it: `x / (UINT64_MAX / max)` in `f64`. */
  f(max: number): number {
    if (max === 0) throw new Error('Rng.f(): the bound is zero');
    return Number(this.next()) / (U64_MAX_AS_DOUBLE / max);
  }
}
