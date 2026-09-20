/**
 * The dense decompositions structure from motion needs, in double precision: a singular value
 * decomposition, a symmetric eigendecomposition, a Cholesky factor, and Levenberg–Marquardt over a
 * least-squares problem.
 *
 * **Written here rather than depended on.** Each is a few dozen lines against a dependency this
 * engine would carry into every game that captures a scene, and each is held to its own identity —
 * a decomposition that reconstructs what it decomposed, a factor whose square is the matrix — which
 * is a stronger check than agreeing with another implementation.
 *
 * **Both decompositions are Jacobi's**, rotating away one off-diagonal at a time. It is not the
 * fastest way to a large spectrum and it is the most accurate on the small, nearly rank-deficient
 * matrices this is for — a homography from four points, an essential matrix, a 3 × 3 covariance —
 * where the answer's smallest value is the one that matters. **What would make it wrong** is a
 * matrix of thousands of rows, which wants a bidiagonal reduction instead; nothing here has one.
 *
 * **Everything is `Float64Array`.** Geometry accumulates: a pose error of a millionth is visible
 * once a hundred frames carry it. Only arithmetic and `Math.sqrt` are reached for, which IEEE 754
 * fixes, so a capture reproduces on any engine — `scripts/determinism.mjs` holds this package to
 * that.
 */

/** How far off the diagonal a Jacobi sweep tolerates before it stops. */
const SETTLED = 1e-15;
const SWEEPS = 60;

/**
 * One-sided Jacobi: `m`, `rows × cols` row-major with `rows ≥ cols`, into `u` (`rows × cols`),
 * `s` (`cols`, falling) and `v` (`cols × cols`), where `m = u · diag(s) · vᵀ`.
 */
export function svdN(
  m: Float64Array,
  rows: number,
  cols: number,
  u: Float64Array,
  s: Float64Array,
  v: Float64Array,
): void {
  if (rows < cols) {
    throw new RangeError(`a ${rows}×${cols} matrix has more columns than rows; transpose it first`);
  }
  const a = Float64Array.from(m);
  v.fill(0);
  for (let i = 0; i < cols; i += 1) v[i * cols + i] = 1;

  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    let off = 0;
    for (let p = 0; p < cols - 1; p += 1) {
      for (let q = p + 1; q < cols; q += 1) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let r = 0; r < rows; r += 1) {
          const left = a[r * cols + p] as number;
          const right = a[r * cols + q] as number;
          alpha += left * left;
          beta += right * right;
          gamma += left * right;
        }
        if (gamma === 0) continue;
        const scale = Math.sqrt(alpha * beta);
        off = Math.max(off, scale === 0 ? 0 : Math.abs(gamma) / scale);
        if (scale === 0 || Math.abs(gamma) <= SETTLED * scale) continue;
        /* The rotation that makes the two columns orthogonal, by the stable root. */
        const zeta = (beta - alpha) / (2 * gamma);
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const sn = c * t;
        for (let r = 0; r < rows; r += 1) {
          const left = a[r * cols + p] as number;
          const right = a[r * cols + q] as number;
          a[r * cols + p] = c * left - sn * right;
          a[r * cols + q] = sn * left + c * right;
        }
        for (let r = 0; r < cols; r += 1) {
          const left = v[r * cols + p] as number;
          const right = v[r * cols + q] as number;
          v[r * cols + p] = c * left - sn * right;
          v[r * cols + q] = sn * left + c * right;
        }
      }
    }
    if (off <= SETTLED) break;
  }

  /* What is left of each column is its singular value times a unit vector. */
  const order = Array.from({ length: cols }, (_, i) => i);
  const lengths = new Float64Array(cols);
  for (let c = 0; c < cols; c += 1) {
    let sum = 0;
    for (let r = 0; r < rows; r += 1) {
      const value = a[r * cols + c] as number;
      sum += value * value;
    }
    lengths[c] = Math.sqrt(sum);
  }
  order.sort((p, q) => (lengths[q] as number) - (lengths[p] as number));
  const held = Float64Array.from(v);
  for (const [at, from] of order.entries()) {
    const length = lengths[from] as number;
    s[at] = length;
    for (let r = 0; r < rows; r += 1) {
      u[r * cols + at] = length === 0 ? 0 : (a[r * cols + from] as number) / length;
    }
    for (let r = 0; r < cols; r += 1) v[r * cols + at] = held[r * cols + from] as number;
  }
}

/** The same for the 3 × 3 matrices geometry is full of. */
export function svd3(m: Float64Array, u: Float64Array, s: Float64Array, v: Float64Array): void {
  svdN(m, 3, 3, u, s, v);
}

/**
 * Jacobi's eigendecomposition of a symmetric `m`, `n × n`: `values` in falling order and `vectors`
 * by column, so `m · vectors[:, k] = values[k] · vectors[:, k]`.
 */
export function symmetricEigen(
  m: Float64Array,
  n: number,
  values: Float64Array,
  vectors: Float64Array,
): void {
  const a = Float64Array.from(m);
  vectors.fill(0);
  for (let i = 0; i < n; i += 1) vectors[i * n + i] = 1;

  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) off = Math.max(off, Math.abs(a[p * n + q] as number));
    }
    if (off <= SETTLED) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const pivot = a[p * n + q] as number;
        if (Math.abs(pivot) <= SETTLED * off) continue;
        const zeta = ((a[q * n + q] as number) - (a[p * n + p] as number)) / (2 * pivot);
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const sn = c * t;
        for (let k = 0; k < n; k += 1) {
          const left = a[k * n + p] as number;
          const right = a[k * n + q] as number;
          a[k * n + p] = c * left - sn * right;
          a[k * n + q] = sn * left + c * right;
        }
        for (let k = 0; k < n; k += 1) {
          const left = a[p * n + k] as number;
          const right = a[q * n + k] as number;
          a[p * n + k] = c * left - sn * right;
          a[q * n + k] = sn * left + c * right;
        }
        for (let k = 0; k < n; k += 1) {
          const left = vectors[k * n + p] as number;
          const right = vectors[k * n + q] as number;
          vectors[k * n + p] = c * left - sn * right;
          vectors[k * n + q] = sn * left + c * right;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((p, q) => (a[q * n + q] as number) - (a[p * n + p] as number));
  const held = Float64Array.from(vectors);
  for (const [at, from] of order.entries()) {
    values[at] = a[from * n + from] as number;
    for (let r = 0; r < n; r += 1) vectors[r * n + at] = held[r * n + from] as number;
  }
}

/**
 * The lower triangle `l` with `l · lᵀ = m`, or false where `m` is not positive definite — which is
 * how a caller learns that its normal equations are singular, rather than by finding a NaN later.
 *
 * **`out` may be `m`**: only the lower triangle is read, each element before it is written, so a
 * caller with one matrix to spare factors it in place. Zeroing the whole of `out` first would have
 * erased the matrix in that case, which is a silent wrong answer rather than a refusal.
 */
export function cholesky(m: Float64Array, n: number, out: Float64Array): boolean {
  for (let r = 0; r < n; r += 1) {
    for (let c = r + 1; c < n; c += 1) out[r * n + c] = 0;
    for (let c = 0; c <= r; c += 1) {
      let sum = m[r * n + c] as number;
      for (let k = 0; k < c; k += 1) sum -= (out[r * n + k] as number) * (out[c * n + k] as number);
      if (r === c) {
        if (!(sum > 0)) return false;
        out[r * n + c] = Math.sqrt(sum);
      } else {
        out[r * n + c] = sum / (out[c * n + c] as number);
      }
    }
  }
  return true;
}

/** Solves `l · lᵀ · x = b` in place over `x`, given the Cholesky factor. */
export function choleskySolve(l: Float64Array, n: number, x: Float64Array): void {
  for (let r = 0; r < n; r += 1) {
    let sum = x[r] as number;
    for (let k = 0; k < r; k += 1) sum -= (l[r * n + k] as number) * (x[k] as number);
    x[r] = sum / (l[r * n + r] as number);
  }
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = x[r] as number;
    for (let k = r + 1; k < n; k += 1) sum -= (l[k * n + r] as number) * (x[k] as number);
    x[r] = sum / (l[r * n + r] as number);
  }
}

/** A least-squares problem: how many residuals, how many parameters, and both at a point. */
export interface LeastSquares {
  readonly residuals: number;
  readonly parameters: number;
  /** The residuals at `x`, and — unless `jacobian` is null — their derivatives, row by residual. */
  evaluate(x: Float64Array, residuals: Float64Array, jacobian: Float64Array | null): void;
}

export interface FitOptions {
  /** The first damping; **zero is plain Gauss–Newton**, steps taken whatever they cost. */
  readonly damping?: number;
  readonly maxIterations?: number;
  /** Stop once a step moves every parameter less than this. */
  readonly tolerance?: number;
}

/**
 * Levenberg–Marquardt over `x`, in place: the Gauss–Newton step with `damping · diag(JᵀJ)` added,
 * the damping raised where a step would cost more and lowered where it pays, which is the whole
 * reason it is not Gauss–Newton — **a step that overshoots is rejected rather than taken**, and a
 * start far from the answer is where that decides between converging and diverging.
 */
export function levenbergMarquardt(
  problem: LeastSquares,
  x: Float64Array,
  options: FitOptions = {},
): { readonly iterations: number; readonly cost: number } {
  const { residuals: rows, parameters: columns } = problem;
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-14;
  let damping = options.damping ?? 1e-3;
  const undamped = damping === 0;

  const residual = new Float64Array(rows);
  const jacobian = new Float64Array(rows * columns);
  const normals = new Float64Array(columns * columns);
  const factor = new Float64Array(columns * columns);
  const gradient = new Float64Array(columns);
  const step = new Float64Array(columns);
  const trial = new Float64Array(columns);

  const costOf = (values: Float64Array): number => {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += (values[i] as number) * (values[i] as number);
    return sum;
  };

  problem.evaluate(x, residual, null);
  let cost = costOf(residual);
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    problem.evaluate(x, residual, jacobian);
    normals.fill(0);
    gradient.fill(0);
    for (let r = 0; r < rows; r += 1) {
      for (let p = 0; p < columns; p += 1) {
        const value = jacobian[r * columns + p] as number;
        gradient[p] = (gradient[p] as number) - value * (residual[r] as number);
        for (let q = p; q < columns; q += 1) {
          normals[p * columns + q] =
            (normals[p * columns + q] as number) + value * (jacobian[r * columns + q] as number);
        }
      }
    }
    for (let p = 0; p < columns; p += 1) {
      for (let q = 0; q < p; q += 1) normals[p * columns + q] = normals[q * columns + p] as number;
    }

    let taken = false;
    for (let attempt = 0; attempt < 12 && !taken; attempt += 1) {
      factor.set(normals);
      for (let p = 0; p < columns; p += 1) {
        /* Marquardt's scaling: the damping rides each parameter's own curvature. */
        const diagonal = normals[p * columns + p] as number;
        factor[p * columns + p] = diagonal * (1 + damping) + damping;
      }
      if (!cholesky(factor, columns, factor)) {
        if (undamped) return { iterations, cost };
        damping *= 10;
        continue;
      }
      step.set(gradient);
      choleskySolve(factor, columns, step);
      let moved = 0;
      for (let p = 0; p < columns; p += 1) {
        trial[p] = (x[p] as number) + (step[p] as number);
        moved = Math.max(moved, Math.abs(step[p] as number));
      }
      problem.evaluate(trial, residual, null);
      const next = costOf(residual);
      if (undamped || next < cost) {
        x.set(trial);
        cost = next;
        taken = true;
        if (!undamped) damping = Math.max(damping / 10, 1e-12);
        if (moved <= tolerance) return { iterations, cost };
      } else {
        damping *= 10;
        if (damping > 1e12) return { iterations, cost };
      }
    }
    if (!taken) return { iterations, cost };
  }
  return { iterations, cost };
}
