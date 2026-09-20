/**
 * The dense operators a transformer is built from: matrix multiply, bias, layer norm, GELU, softmax.
 *
 * **The references the device kernels are held to**, which is why they are written for exactness
 * rather than speed: every sum accumulates in double precision and is rounded once, on the way into
 * the caller's single-precision output. A kernel that disagrees with one of these is wrong, not
 * this.
 *
 * **Contiguous row-major arrays with their dimensions, and nothing that allocates.** A strided view
 * that permutes without copying would make every operator handle strides, and every device kernel
 * would materialise the permutation anyway; so a permutation is a copy into a buffer the caller
 * owns, and the operators stay one loop each.
 *
 * **The exact GELU, `x·Φ(x)`, and never the tanh approximation.** The two differ by 4e-4 at 3, and
 * a port of a network trained with one and evaluated with the other is a different network. `erf`
 * is here for that reason, accurate to double precision.
 */

/**
 * `out[m×n] = a[m×k] · b`, where `b` is `k×n`, or `n×k` read as its transpose when `transposeB`.
 * The offsets are where each matrix starts in its array, which is how one head of many is taken.
 */
export function matmul(
  out: Float32Array,
  a: Float32Array,
  b: Float32Array,
  m: number,
  k: number,
  n: number,
  transposeB = false,
  outAt = 0,
  aAt = 0,
  bAt = 0,
): void {
  for (let row = 0; row < m; row += 1) {
    const aRow = aAt + row * k;
    for (let col = 0; col < n; col += 1) {
      let sum = 0;
      if (transposeB) {
        const bRow = bAt + col * k;
        for (let i = 0; i < k; i += 1) sum += (a[aRow + i] as number) * (b[bRow + i] as number);
      } else {
        for (let i = 0; i < k; i += 1) {
          sum += (a[aRow + i] as number) * (b[bAt + i * n + col] as number);
        }
      }
      out[outAt + row * n + col] = sum;
    }
  }
}

/** Add `bias[cols]` to every one of `rows` rows of `x`, in place. */
export function addBias(x: Float32Array, rows: number, cols: number, bias: Float32Array): void {
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      x[row * cols + col] = (x[row * cols + col] as number) + (bias[col] as number);
    }
  }
}

/**
 * Each row normalised to zero mean and unit variance, then scaled by `gamma` and shifted by `beta`.
 *
 * **The population variance, divided by the row's length and not one less**, which is what the
 * upstream frameworks compute and therefore what their trained weights expect.
 */
export function layerNorm(
  x: Float32Array,
  rows: number,
  cols: number,
  gamma: Float32Array,
  beta: Float32Array,
  epsilon: number,
  out: Float32Array,
): void {
  for (let row = 0; row < rows; row += 1) {
    const at = row * cols;
    let mean = 0;
    for (let col = 0; col < cols; col += 1) mean += x[at + col] as number;
    mean /= cols;
    let variance = 0;
    for (let col = 0; col < cols; col += 1) variance += ((x[at + col] as number) - mean) ** 2;
    variance /= cols;
    const scale = 1 / Math.sqrt(variance + epsilon);
    for (let col = 0; col < cols; col += 1) {
      const normal = variance + epsilon === 0 ? 0 : ((x[at + col] as number) - mean) * scale;
      out[at + col] = normal * (gamma[col] as number) + (beta[col] as number);
    }
  }
}

const TWO_OVER_ROOT_PI = 2 / Math.sqrt(Math.PI);

/**
 * The error function, to double precision.
 *
 * A Maclaurin series below 3, where its alternating terms peak near 170 at `x = 3` and cost about
 * three digits to cancellation — still 1e-13; a continued fraction for the complement above, which
 * converges fastest exactly where the series is worst; and ±1 past 6, where the complement is below
 * a double's last place.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a >= 6) return sign;
  if (a < 3) {
    let term = a;
    let sum = a;
    const square = a * a;
    for (let n = 1; n < 100; n += 1) {
      term *= -square / n;
      const next = term / (2 * n + 1);
      sum += next;
      if (Math.abs(next) < 1e-17 * Math.abs(sum)) break;
    }
    return sign * TWO_OVER_ROOT_PI * sum;
  }
  /* erfc(a) = exp(−a²)/√π · 1/(a + ½/(a + 1/(a + 3/2/(a + ...)))), evaluated from the tail up. */
  let fraction = 0;
  for (let n = 60; n >= 1; n -= 1) fraction = n / 2 / (a + fraction);
  const complement = Math.exp(-a * a) / Math.sqrt(Math.PI) / (a + fraction);
  return sign * (1 - complement);
}

/** `x·Φ(x)`, the exact GELU, from `x` into `out`. */
export function gelu(x: Float32Array, out: Float32Array): void {
  for (let i = 0; i < x.length; i += 1) {
    const value = x[i] as number;
    out[i] = 0.5 * value * (1 + erf(value / Math.SQRT2));
  }
}

/** The logistic, `1/(1 + e^−x)`, from `x` into `out`: 1 far to the right, and 0 far to the left. */
export function sigmoid(x: Float32Array, out: Float32Array): void {
  for (let i = 0; i < x.length; i += 1) out[i] = 1 / (1 + Math.exp(-(x[i] as number)));
}

/**
 * Each row of `x` to a distribution, stably: the row's largest value is subtracted before the
 * exponential, so logits near a thousand give their logistic rather than `Infinity / Infinity`.
 */
export function softmax(x: Float32Array, rows: number, cols: number, out: Float32Array): void {
  for (let row = 0; row < rows; row += 1) {
    const at = row * cols;
    let largest = -Infinity;
    for (let col = 0; col < cols; col += 1) largest = Math.max(largest, x[at + col] as number);
    let total = 0;
    for (let col = 0; col < cols; col += 1) total += Math.exp((x[at + col] as number) - largest);
    for (let col = 0; col < cols; col += 1) {
      out[at + col] = Math.exp((x[at + col] as number) - largest) / total;
    }
  }
}
