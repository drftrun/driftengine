/**
 * Transcendentals that give the same bits on every JavaScript engine.
 *
 * **Not more accurate than `Math`, and that is not what they are for.** These are within a couple
 * of units in the last place of correctly rounded, which is about what a platform `sin` gives you.
 * What they are is *reproducible*: ECMAScript declines to specify `sin`, `cos`, `exp`, `acos` and
 * eighteen more, so two engines may differ by an ulp, and an ulp is enough to make two peers running
 * the same simulation disagree — first invisibly, then completely.
 *
 * `scripts/determinism.mjs` is the gate that refuses the unspecified ones inside the simulation set
 * and names the twenty-two. Its header carries the other half of the argument: `+ - * /` are IEEE
 * 754 operations by specification, JavaScript permits no fused-multiply-add contraction, and
 * `Math.sqrt` is required correctly rounded and is *not* on that list. **So everything below uses
 * only those five operations**, which is the whole design: reproducibility by construction rather
 * than by hoping two engines chose the same algorithm.
 *
 * ---
 *
 * ## What is here, and what is deliberately not
 *
 * `exactSin`, `exactCos`, `exactExp`, `exactAcos`. Four, because four is what the engine and its
 * first consumer actually reach for: the terrain binding's slope angle needs `acos`, a lockstep
 * fixture rotating anything needs `sin` and `cos`, and exponential decay needs `exp`.
 *
 * **`atan2` is absent.** It is the obvious fifth and nothing here needs one: `shape.ts` sorts by a
 * comparison key computed from two in-plane axes rather than by an angle, and `joints.ts` compares
 * a quaternion component against a half-angle's sine. *Reversed by* a site that genuinely needs a
 * signed angle from two components, at which point it arrives with its own golden vectors.
 *
 * ## Nothing in core imports these
 *
 * Deliberately. `core-only` is the one size figure in this repository that every consumer pays, and
 * a module reachable from `createRenderer` is in it whether anybody calls it or not. These are
 * reached by the script bindings and by consumers who ask for them, so tree-shaking keeps them out
 * of a bundle that does not, which is measured rather than assumed.
 *
 * ## The coefficients
 *
 * The polynomial and rational coefficients are fdlibm's, which is the ancestor of most platform
 * libms and is public domain. They are written as literals: **a literal is the same number on
 * every engine, which is the only property being bought.** Their provenance matters less than their
 * fixity — a coefficient somebody re-derived to one more digit is a different function, and
 * `exact.test.ts`'s golden bit patterns are what would catch that.
 */

/*
 * π/2 in four pieces, most significant first, so a large multiple of it can be removed without
 * losing the small remainder in the subtraction.
 *
 * **Two pieces are not enough and the measurement says so**: at an angle of 740 radians a two-part
 * reduction leaves `sin` and `cos` 18.5 ulps out, because `k * PIO2_1` needs more than 53 bits once
 * `k` grows. Three brings it under two ulps for the cost of two multiplies.
 *
 * **`PIO2_TAIL` and `PIO2_TAIL_LO` are one number in two halves, not two successive corrections.**
 * fdlibm carries a fourth constant, `pio2_1t`, which is the tail for its *single*-iteration path;
 * `pio2_2` is the same tail rounded differently, with `pio2_2t` as its own tail, and the two paths
 * are alternatives. Refining the first with the second is not more accurate, it is wrong: it
 * subtracts the tail twice and took `sin` to 2.2e11 ulps out, which is how this comment came to be
 * here.
 */
const PIO2_1 = 1.5707963267341256;
const PIO2_TAIL = 6.077100506303966e-11;
const PIO2_TAIL_LO = 2.0222662487959506e-21;
const TWO_OVER_PI = 0.6366197723675814;

const HALF_PI = 1.5707963267948966;
const PI = 3.141592653589793;

/* fdlibm's `__kernel_sin` coefficients. */
const S1 = -1.6666666666666632e-1;
const S2 = 8.3333333333224894e-3;
const S3 = -1.984126982985795e-4;
const S4 = 2.7557313707070068e-6;
const S5 = -2.5050760253406863e-8;
const S6 = 1.5896909952115501e-10;

/* fdlibm's `__kernel_cos` coefficients. */
const C1 = 4.1666666666666602e-2;
const C2 = -1.3888888888874109e-3;
const C3 = 2.480158728947673e-5;
const C4 = -2.7557314351390663e-7;
const C5 = 2.0875723212981748e-9;
const C6 = -1.1359647557788195e-11;

/* fdlibm's `asin` rational, numerator then denominator. */
const P0 = 1.6666666666666666e-1;
const P1 = -3.2556581862240092e-1;
const P2 = 2.0121253213486293e-1;
const P3 = -4.0055534500679411e-2;
const P4 = 7.9153499428981453e-4;
const P5 = 3.4793310759602117e-5;
const Q1 = -2.4033949117344142;
const Q2 = 2.0209457602335057;
const Q3 = -6.8828397160545329e-1;
const Q4 = 7.7038150555901935e-2;

/** ln 2, split for the same reason π/2 is. */
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const ONE_OVER_LN2 = 1.4426950408889634;

/** 2^(2^i), for i = 0 to 9. Every one is exact, so a product of them is exact. */
const POW2 = [
  2, 4, 16, 256, 65536, 4294967296, 1.8446744073709552e19, 3.402823669209385e38,
  1.157920892373162e77, 1.3407807929942597e154,
];

/**
 * Two to an integer power, by binary decomposition of the exponent.
 *
 * Multiplication by a power of two is exact in IEEE 754, so this is exact wherever it does not
 * overflow — which is what makes it a legitimate substitute for the `Math.pow` a range reduction
 * would otherwise reach for.
 *
 * A large negative exponent lands on zero instead of a subnormal, because the reciprocal is taken
 * after the product overflows. That is `exp` underflowing to zero, which is where it was going.
 */
function pow2(exponent: number): number {
  let remaining = exponent < 0 ? -exponent : exponent;
  let result = 1;
  let index = 0;
  while (remaining > 0 && index < POW2.length) {
    if ((remaining & 1) === 1) result *= POW2[index] as number;
    remaining >>= 1;
    index += 1;
  }
  return exponent < 0 ? 1 / result : result;
}

/** sin on [-π/4, π/4]. */
function sinKernel(x: number): number {
  const z = x * x;
  const poly = S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))));
  return x + x * z * poly;
}

/** cos on [-π/4, π/4]. */
function cosKernel(x: number): number {
  const z = x * x;
  const poly = C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))));
  return 1 - 0.5 * z + z * z * poly;
}

/**
 * Fold an angle into [-π/4, π/4] and say which quadrant it came from.
 *
 * Cody-Waite: the multiple of π/2 is removed in pieces, so the subtraction that produces a small
 * remainder from two large numbers does not lose the bits it is supposed to keep. One-piece
 * reduction is accurate to about 1e-8 at an angle of a thousand radians, which for a simulation
 * that accumulates rotation is the difference between an object facing forward and facing sideways
 * after a few minutes.
 */
function reduce(x: number): { r: number; quadrant: number } {
  const k = Math.round(x * TWO_OVER_PI);

  /* The leading piece, whose product with `k` is exact for every `k` a simulation reaches. */
  const head = x - k * PIO2_1;

  /*
   * The tail, in two halves. `head - tail` loses the bits below its own last place, and
   * `PIO2_TAIL_LO - (head - r - tail)` is exactly those bits recovered — the same
   * subtract-and-recover fdlibm uses on its two-iteration path.
   */
  const tail = k * PIO2_TAIL;
  let r = head - tail;
  const lost = k * PIO2_TAIL_LO - (head - r - tail);
  r = r - lost;

  return { r, quadrant: ((k % 4) + 4) % 4 };
}

/** `Math.sin`, reproducibly. NaN in, NaN out; an infinity answers NaN, as `Math.sin` does. */
export function exactSin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { r, quadrant } = reduce(x);
  switch (quadrant) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

/** `Math.cos`, reproducibly. */
export function exactCos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { r, quadrant } = reduce(x);
  switch (quadrant) {
    case 0:
      return cosKernel(r);
    case 1:
      return -sinKernel(r);
    case 2:
      return -cosKernel(r);
    default:
      return sinKernel(r);
  }
}

/**
 * `Math.exp`, reproducibly.
 *
 * Reduce by a multiple of ln 2 into [-ln2/2, ln2/2], sum the Taylor series there, and scale by a
 * power of two. **A degree-14 series and not a shorter minimax**, because on that interval the
 * fifteenth term is about 4e-20 — below the precision of a double — so the series is exact to the
 * representation and there is nothing a fitted polynomial would buy.
 */
export function exactExp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  if (x > 709.782712893384) return Number.POSITIVE_INFINITY;
  if (x < -745.1332191019411) return 0;

  const k = Math.round(x * ONE_OVER_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;

  /* Horner over 1/n!, highest term first. */
  let sum = 1 / 87178291200; // 1/14!
  sum = 1 / 6227020800 + r * sum; // 1/13!
  sum = 1 / 479001600 + r * sum; // 1/12!
  sum = 1 / 39916800 + r * sum; // 1/11!
  sum = 1 / 3628800 + r * sum; // 1/10!
  sum = 1 / 362880 + r * sum; // 1/9!
  sum = 1 / 40320 + r * sum; // 1/8!
  sum = 1 / 5040 + r * sum; // 1/7!
  sum = 1 / 720 + r * sum; // 1/6!
  sum = 1 / 120 + r * sum; // 1/5!
  sum = 1 / 24 + r * sum; // 1/4!
  sum = 1 / 6 + r * sum; // 1/3!
  sum = 0.5 + r * sum;
  sum = 1 + r * sum;
  sum = 1 + r * sum;

  return sum * pow2(k);
}

/** fdlibm's `asin` rational on `z = x²`, valid where `z` is small. */
function asinRational(z: number): number {
  const numerator = z * (P0 + z * (P1 + z * (P2 + z * (P3 + z * (P4 + z * P5)))));
  const denominator = 1 + z * (Q1 + z * (Q2 + z * (Q3 + z * Q4)));
  return numerator / denominator;
}

/**
 * `Math.acos`, reproducibly. Outside [-1, 1] this answers NaN, as `Math.acos` does.
 *
 * Three branches rather than one, and the split at ±0.5 is the reason it is accurate near the ends:
 * `acos` has infinite derivative at ±1, so a polynomial in `x` loses its footing there. Substituting
 * `s = sqrt((1 ∓ x)/2)` moves the awkward point to zero, where a polynomial is comfortable — which
 * is also why `sqrt` being exactly rounded matters here rather than being a convenience.
 */
export function exactAcos(x: number): number {
  if (Number.isNaN(x) || x > 1 || x < -1) return Number.NaN;
  if (x === 1) return 0;
  if (x === -1) return PI;

  if (x >= 0.5) {
    const z = (1 - x) / 2;
    const s = Math.sqrt(z);
    return 2 * (s + s * asinRational(z));
  }
  if (x <= -0.5) {
    const z = (1 + x) / 2;
    const s = Math.sqrt(z);
    return PI - 2 * (s + s * asinRational(z));
  }
  const z = x * x;
  return HALF_PI - (x + x * asinRational(z));
}
