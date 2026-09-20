/**
 * How far a network operator on the device may be from its reference, per output, derived.
 *
 * **A bound is worked from the inputs, never sampled.** Every one below follows the operations
 * the kernel performs and charges each its worst rounding: `+` and `*` are correctly rounded in
 * WGSL, so half a unit in the last place, `u = 2^-24` of the result; division is 2.5 units, `exp`
 * 3 + 2|x|, `inverseSqrt` 2 — and a unit in the last place is at most `2u` of the value it sits in,
 * so `k` units cost `2k·u`. The reference is exact to well below that (it sums in double precision)
 * and rounds its answer once, which each bound pays as `u·|ref|`. Second-order terms — products of
 * two errors — are covered by a margin of one part in a hundred, `SECOND_ORDER`.
 *
 * **What a bound gives up is tightness.** A bound on the worst case in every operation at once is
 * loose, sometimes by two orders against the error measured; what it buys is that a kernel inside
 * it is right for a reason, and one outside it is wrong. The perturbations in `inference-parity.mjs`
 * are what show each bound is tight enough to catch a real defect — a bound too loose to fail is a
 * check that cannot, and that is how one would be found.
 *
 * **What would make one wrong**: a device that flushes a subnormal result, charged as `FLUSH` per
 * operation where it can happen; and an implementation contracting a multiply and an add into one
 * fused operation, which rounds once where the bound charged twice, so is inside it.
 */

/** Half a unit in the last place of a single-precision value, relative to it. */
export const U = 2 ** -24;
/** The least normal single; a device may flush anything smaller to zero, on either side. */
export const FLUSH = 2 ** -126;
/** The margin for products of two errors, which every bound below leaves out of its terms. */
export const SECOND_ORDER = 1.01;

/**
 * A sum of `taps` products and a bias, in any order — the tiled order `linear` sums in, the gather
 * order the convolutions do. Recursive summation errs by at most `γ(taps + 1)·Σ|term|` (Higham,
 * *Accuracy and Stability*, 3.1), and `γ(k) = k·u/(1 − k·u)` is under `(k + 1)·u` for any `k` a
 * network has. `magnitude` is `Σ|aᵢwᵢ| + |b|` — the reference evaluated on the absolute values of
 * its inputs, which is the same sum with every sign made to agree.
 */
export function dotBound(taps, magnitude, reference) {
  return SECOND_ORDER * ((taps + 2) * U * magnitude + U * Math.abs(reference)) + (taps + 1) * FLUSH;
}

/* Abramowitz and Stegun 7.1.26's coefficients, a₁ to a₅, as the kernel writes them. */
const ERF_A = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
const ERF_P = 0.3275911;

/**
 * How far the kernel's `erfApprox(x / √2)` may be from `erf(x / √2)`.
 *
 * - **The approximation itself**, 1.5e-7 everywhere (A&S's own bound, in exact arithmetic).
 * - **The scaled argument**: `x · 0.7071…` rounds the constant and the product, `2u` of `a`, which
 *   moves the true `erf` by at most its slope, `(2/√π)·e^(−a²)`, times that.
 * - **`t = 1/(1 + p·a)`**: the constant, `a`'s own error, the product and the sum are `5u`; the
 *   division 2.5 units, `5u` more — `10u` of `t`, moving the polynomial `q(t) = Σ aₖtᵏ` by at most
 *   `10u · Σ k|aₖ|tᵏ`.
 * - **Horner's evaluation of `q`**: a degree-five polynomial is `γ(10)·Σ|aₖ|tᵏ`, and each rounded
 *   coefficient adds `u` of its term — `12u · Σ|aₖ|tᵏ` with the margin γ's denominator needs.
 * - **`e^(−a²)`**: the argument carries `5u` of `a²` (twice `a`'s error, and the product) and
 *   `exp` is `3 + 2a²` units, `(6 + 4a²)u` — `(6 + 9a²)u` of the exponential together.
 * - **The last two operations**, `q·e` and `1 − that`, are each `u` of something at most 1.
 */
export function erfDeviceError(x) {
  const a = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + ERF_P * a);
  const e = Math.exp(-a * a);
  let q = 0;
  let absolute = 0;
  let slope = 0;
  for (let k = 1; k <= 5; k += 1) {
    const term = (ERF_A[k - 1] ?? 0) * t ** k;
    q += term;
    absolute += Math.abs(term);
    slope += k * Math.abs(term);
  }
  return (
    1.5e-7 +
    (2 / Math.sqrt(Math.PI)) * e * 2 * U * a +
    e * (Math.abs(q) * (6 + 9 * a * a) * U + 12 * U * absolute + 10 * U * slope) +
    2 * U
  );
}

/**
 * GELU, `0.5·x·(1 + erf(x/√2))`: the error in `erf` is scaled by `½|x|`, and `1 + erf` and the
 * product are `u` of the answer each; the halving is exact.
 */
export function geluBound(x, reference) {
  return (
    SECOND_ORDER * (0.5 * Math.abs(x) * erfDeviceError(x) + 3 * U * Math.abs(reference)) + FLUSH
  );
}

/** GELU's slope, `Φ(x) + x·φ(x)`, is largest at `x = √2`, where it is 1.1289. */
const GELU_SLOPE = 1.13;

/**
 * A multiply with a GELU fused into it: the sum's error passes through GELU's slope, and GELU's own
 * error is charged at the sum. `pre` is the reference's sum, which it rounded once before GELU —
 * that rounding passes through the slope too.
 */
export function fusedGeluBound(taps, magnitude, pre, reference) {
  const sum = (taps + 2) * U * magnitude + U * Math.abs(pre);
  return (
    SECOND_ORDER *
      (GELU_SLOPE * sum + 0.5 * Math.abs(pre) * erfDeviceError(pre) + 3 * U * Math.abs(reference)) +
    (taps + 2) * FLUSH
  );
}

/**
 * The logistic, `1/(1 + e)` with `e = exp(−x)`: `exp` is `3 + 2|x|` units, `(6 + 4|x|)u` of `e`,
 * which reaches the result through `e/(1 + e)`; the sum is `u` and the division 2.5 units, `5u`, of
 * the result; and the reference rounds once. Far to the left `exp` overflows and the result is 0
 * where the reference's is under the least normal, which `FLUSH` covers.
 */
export function sigmoidBound(x, reference) {
  const e = Math.exp(-x);
  const share = Number.isFinite(e) ? e / (1 + e) : 1;
  return SECOND_ORDER * (Math.abs(reference) * (share * (6 + 4 * Math.abs(x)) + 7) * U) + FLUSH;
}

/**
 * Softmax over rows of `cols`. Each `exp(x − max)` carries its argument's rounding, `u` of
 * `|x − max|`, and its own `3 + 2|x − max|` units: `(6 + 5R)u` of itself at most, `R` the row's
 * range. The sum of positive terms in any order is `(cols − 1)u` of itself, and it inherits the
 * worst term's error; the division is 2.5 units. Relative to each output, then,
 * `2(6 + 5R)u + (cols − 1)u + 5u`, and the reference's rounding.
 */
export function softmaxBounds(x, cols, reference) {
  const bounds = new Float64Array(x.length);
  for (let at = 0; at < x.length; at += cols) {
    let high = -Infinity;
    let low = Infinity;
    for (let c = 0; c < cols; c += 1) {
      high = Math.max(high, x[at + c]);
      low = Math.min(low, x[at + c]);
    }
    const relative = (cols + 17 + 10 * (high - low)) * U;
    for (let c = 0; c < cols; c += 1) {
      bounds[at + c] = SECOND_ORDER * relative * Math.abs(reference[at + c]) + FLUSH;
    }
  }
  return bounds;
}

/**
 * Layer norm over rows of `cols`, the mean and the variance each by a strided sum and a tree.
 *
 * - **The mean** errs by `(cols − 1)u` of `Σ|x|` over `cols`, and the division `5u` of itself:
 *   `δμ ≤ (cols + 4)u·A`, `A` the mean absolute value.
 * - **The variance**: each deviation carries `δμ` and `u` of itself. Their linear parts cancel in
 *   the sum, because deviations from the true mean sum to zero, which is why a two-pass variance is
 *   stable; what is left is `cols·δμ²` and `(cols + 2)u` of the sum. The division is `5u`, the
 *   epsilon's literal and the addition `u` each: `(cols + 8)u·V + 2u·ε + δμ²` of `V + ε`.
 * - **The scale**, `inverseSqrt` of that, moves by `(1 − ε_den)^(−1/2) − 1` and its own 2 units.
 * - **Each output**, `(x − μ)·scale·γ + β`, carries the deviation's error through the scale, the
 *   scale's error through the normalised value, and two products' and one sum's roundings.
 *
 * A row whose variance is near zero has a large scale, and the mean's error is multiplied by it:
 * that is the true behaviour of the operator in single precision, not slack in the bound.
 */
export function layerNormBounds(x, cols, gamma, epsilon, reference) {
  const bounds = new Float64Array(x.length);
  for (let at = 0; at < x.length; at += cols) {
    let sum = 0;
    let absolute = 0;
    for (let c = 0; c < cols; c += 1) {
      sum += x[at + c];
      absolute += Math.abs(x[at + c]);
    }
    const mean = sum / cols;
    let squares = 0;
    for (let c = 0; c < cols; c += 1) squares += (x[at + c] - mean) ** 2;
    const variance = squares / cols;
    const scale = 1 / Math.sqrt(variance + epsilon);
    const meanError = (cols + 4) * U * (absolute / cols);
    const denominator =
      ((cols + 8) * U * variance + 2 * U * epsilon + meanError ** 2 * (1 + cols * U)) /
      (variance + epsilon);
    const scaleError =
      denominator < 1 ? (1 + 4 * U) / Math.sqrt(1 - denominator) - 1 : Number.POSITIVE_INFINITY;
    for (let c = 0; c < cols; c += 1) {
      const deviation = x[at + c] - mean;
      const deviationError = meanError * (1 + U) + U * Math.abs(deviation);
      const normal = Math.abs(deviation * scale);
      bounds[at + c] =
        SECOND_ORDER *
          (Math.abs(gamma[c]) *
            (scale * deviationError * (1 + scaleError) + normal * (scaleError + 2 * U)) +
            2 * U * Math.abs(reference[at + c])) +
        FLUSH;
    }
  }
  return bounds;
}

/**
 * Attention, one query and head at a time, with the running-maximum softmax.
 *
 * - **Scores**: a dot over `d` channels is `γ(d)` of `Σ|q·k|`, and the scale's literal and product
 *   `2u` more — `Δs ≤ (d + 3)u·Σ|q·k|/√d`, the worst over the keys.
 * - **Weights**: every key's weight is `e^(s − max)` times the rescales of every later maximum. A
 *   score's error moves its weight by `e^Δs`, and a common factor cancels when the weights are
 *   normalised, so `Δs` is charged once. Each `exp` carries `(6 + 5|argument|)u`, and the
 *   rescales' arguments sum to at most the scores' range `R`: `θ ≤ Δs + (6·tokens + 6 + 10R)u`
 *   of each weight, and twice that of each normalised one.
 * - **The accumulation**: the gathered values take `2·tokens + 1` roundings a term and the total
 *   `2·tokens`, and the division 2.5 units.
 * - **A bias** is added to the scaled score, one rounding of the sum on the device and one in the
 *   reference: `2u·|s|` more of each score, `s` now the biased one.
 * - **The reference** stores each score and each weight in single precision before the next step,
 *   so it moves by `2u·max|s|` and `u` of `Σ p|v|`, and rounds its answer.
 *
 * **The same bound holds for the kernel's split form**, where 64 threads each walk every 64th key
 * and then merge: each thread's partial is rescaled once to the query's largest score and summed in
 * a tree. A key's weight passes through its thread's rescales and that one more, at most
 * `⌈keys/64⌉ + 1`, which is under `keys` wherever the split form is chosen — and the rescales'
 * arguments still telescope to at most `R`, from the key's score to the query's maximum. Its term
 * takes two roundings a rescale and one an addition, `log₂ 64` of those, under the `2·keys + 1`
 * charged.
 *
 * Each window of a batch is its own set of rows, over its own keys. `magnitude` is `Σ pₖ|vₖ|` per
 * output — the reference on the absolute values. `bias` may be null.
 */
export function attentionBounds(
  q,
  k,
  bias,
  batch,
  queries,
  keys,
  channels,
  heads,
  magnitude,
  reference,
) {
  const bounds = new Float64Array(q.length);
  const d = channels / heads;
  const scale = 1 / Math.sqrt(d);
  for (let b = 0; b < batch; b += 1) {
    const qAt = b * queries * channels;
    const kAt = b * keys * channels;
    for (let head = 0; head < heads; head += 1) {
      const first = head * d;
      for (let query = 0; query < queries; query += 1) {
        let scoreError = 0;
        let high = -Infinity;
        let low = Infinity;
        let largest = 0;
        for (let key = 0; key < keys; key += 1) {
          let dot = 0;
          let absolute = 0;
          for (let c = 0; c < d; c += 1) {
            const product =
              q[qAt + query * channels + first + c] * k[kAt + key * channels + first + c];
            dot += product;
            absolute += Math.abs(product);
          }
          const scaled = dot * scale;
          const score =
            bias === null ? scaled : scaled + bias[(head * queries + query) * keys + key];
          scoreError = Math.max(
            scoreError,
            (d + 3) * U * absolute * scale + (bias === null ? 0 : 2 * U * Math.abs(score)),
          );
          high = Math.max(high, score);
          low = Math.min(low, score);
          largest = Math.max(largest, Math.abs(scaled), Math.abs(score));
        }
        const range = high - low + 2 * scoreError;
        const theta = scoreError + (6 * keys + 6 + 10 * range) * U;
        const relative = 2 * theta + (4 * keys + 6) * U + 2 * U * largest + U;
        for (let c = 0; c < d; c += 1) {
          const at = qAt + query * channels + first + c;
          bounds[at] =
            SECOND_ORDER * (relative * magnitude[at] + U * Math.abs(reference[at])) + FLUSH;
        }
      }
    }
  }
  return bounds;
}

/* The cubic kernel at a = −0.75, and the same polynomial with every coefficient made positive. */
const CUBIC_NEAR = (x) => (1.25 * x - 2.25) * x * x + 1;
const CUBIC_FAR = (x) => ((-0.75 * x + 3.75) * x - 6) * x + 3;
const ABS_NEAR = (x) => (1.25 * x + 2.25) * x * x + 1;
const ABS_FAR = (x) => ((0.75 * x + 3.75) * x + 6) * x + 3;
/* The kernel's steepest slope, at x = 0.6 in the near half; and the most its four weights sum to
   in absolute value, 1 + 2 · 0.75·t(1 − t) at t = ½. */
const CUBIC_SLOPE = 1.35;
const CUBIC_WEIGHT = 1.375;

/* A source coordinate in the reference's convention, for choosing the neighbourhood a bound reads. */
function sourceOf(i, input, output, align, cubic, step) {
  if (align) return output <= 1 ? 0 : (i * (input - 1)) / (output - 1);
  const source = step === undefined ? ((i + 0.5) * input) / output - 0.5 : (i + 0.5) * step - 0.5;
  return !cubic && source < 0 ? 0 : source;
}

/**
 * Resizing, per output.
 *
 * - **The source coordinate** is `(i + ½)·scale − ½`, or `i·scale` with aligned corners: the
 *   scale's literal and the two operations are within `4u·(edge + 1)` of it, the edge being the
 *   furthest source coordinate a given step reaches where it passes the input's own. Both kernels are
 *   continuous in the coordinate, so a floor landing on the other side of an integer costs
 *   nothing beyond the slope — at most the neighbourhood's range for bilinear, and
 *   `1.375 · 4 · 1.35` of it for bicubic, whose weights sum to zero slope.
 * - **Bilinear**'s two lerps are three roundings each, `6u` of the largest tap.
 * - **Bicubic**'s weights are Horner cubics: `γ(6)` of the polynomial with its coefficients made
 *   positive, and the argument's rounding through the slope. Each row's sum of four products is
 *   `γ(4)` of itself, and so is the sum of the rows.
 */
export function resizeBounds(input, channels, h, w, oh, ow, cubic, align, reference, step) {
  const bounds = new Float64Array(channels * oh * ow);
  /* A given step reaches (output + ½)·step, which may pass the input's own edge. */
  const shiftY = 4 * U * (Math.max(h, step === undefined ? 0 : (oh + 0.5) * step[0]) + 1);
  const shiftX = 4 * U * (Math.max(w, step === undefined ? 0 : (ow + 0.5) * step[1]) + 1);
  const at = (plane, y, x) =>
    input[plane + Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
  const weights = (t) => [CUBIC_FAR(t + 1), CUBIC_NEAR(t), CUBIC_NEAR(1 - t), CUBIC_FAR(2 - t)];
  const errors = (t) =>
    [ABS_FAR(t + 1), ABS_NEAR(t), ABS_NEAR(1 - t), ABS_FAR(2 - t)].map(
      (absolute) => 6 * U * absolute + 2 * CUBIC_SLOPE * U,
    );
  for (let c = 0; c < channels; c += 1) {
    const plane = c * h * w;
    for (let y = 0; y < oh; y += 1) {
      const sy = sourceOf(y, h, oh, align, cubic, step?.[0]);
      const y0 = Math.floor(sy);
      const ty = sy - y0;
      for (let x = 0; x < ow; x += 1) {
        const sx = sourceOf(x, w, ow, align, cubic, step?.[1]);
        const x0 = Math.floor(sx);
        const tx = sx - x0;
        let high = -Infinity;
        let low = Infinity;
        let largest = 0;
        for (let j = -2; j <= 3; j += 1) {
          for (let i = -2; i <= 3; i += 1) {
            const value = at(plane, y0 + j, x0 + i);
            high = Math.max(high, value);
            low = Math.min(low, value);
            largest = Math.max(largest, Math.abs(value));
          }
        }
        const range = high - low;
        const out = (c * oh + y) * ow + x;
        let bound;
        if (!cubic) {
          bound = range * (shiftX + shiftY) + 6 * U * largest;
        } else {
          const wx = weights(tx);
          const wy = weights(ty);
          const ex = errors(tx);
          const ey = errors(ty);
          let rounding = 0;
          for (let j = 0; j < 4; j += 1) {
            let across = 0;
            let acrossError = 0;
            for (let i = 0; i < 4; i += 1) {
              const value = Math.abs(at(plane, y0 - 1 + j, x0 - 1 + i));
              across += Math.abs(wx[i]) * value;
              acrossError += ex[i] * value;
            }
            acrossError += 4 * U * across;
            rounding += ey[j] * across + Math.abs(wy[j]) * (acrossError + 4 * U * across);
          }
          bound = CUBIC_WEIGHT * 4 * CUBIC_SLOPE * range * (shiftX + shiftY) + rounding;
        }
        bounds[out] = SECOND_ORDER * (bound + U * Math.abs(reference[out])) + FLUSH;
      }
    }
  }
  return bounds;
}
