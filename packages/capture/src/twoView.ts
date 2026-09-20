/**
 * The pose between two views, and the points it puts in front of them.
 *
 * **Two models are fitted, not one.** An essential matrix explains a pair that moved; a homography
 * explains a pair that turned, or one looking at a plane. Both are fitted by RANSAC and scored the
 * same way, and the homography wins where it explains what the essential explains — because a
 * camera that only turned can be fitted with a translation that reproduces both pictures exactly
 * and means nothing. **That is the failure this exists to prevent**: the translation would go into
 * the reconstruction as a baseline, every triangulated point would take its scale from it, and
 * nothing downstream could tell.
 *
 * **So parallax is measured and reported**, as the median angle between the two rays to a point.
 * Below a threshold the pair is a turn: the rotation is answered, the translation is zeroed, and
 * the caller is told which model spoke.
 *
 * **RANSAC takes its randomness as an argument.** A capture must give the same answer twice, so the
 * caller passes the generator — a seeded one — rather than this reaching for `Math.random`.
 */
import { exactAcos } from '@driftengine/core';

import { cholesky, choleskySolve, svd3, svdN } from './math/dense.ts';

export interface RelativePoseOut {
  /** 3 × 3 row-major: the second camera's rotation relative to the first. */
  readonly rotation: Float64Array;
  /** A unit direction, or zeros where the pair has no parallax to fix one. */
  readonly translation: Float64Array;
}

export interface RelativePoseResult {
  readonly inliers: number;
  readonly model: 'essential' | 'homography';
  /** The median angle between a point's two rays, in degrees. */
  readonly parallax: number;
}

/** How many samples RANSAC draws, and how far a point may sit from its epipolar line. */
const TRIALS = 200;
const THRESHOLD = 1.5;
/** A pair with less parallax than this, in degrees, is a turn rather than a move. */
const TURNED = 1;
/** The homography wins when it explains at least this share of what both models explain. */
const PLANAR = 0.45;

/** The last right-singular vector of `rows × cols`: the least-squares null direction. */
function nullVector(rows: Float64Array, count: number, cols: number): Float64Array {
  const u = new Float64Array(count * cols);
  const s = new Float64Array(cols);
  const v = new Float64Array(cols * cols);
  svdN(rows, count, cols, u, s, v);
  const out = new Float64Array(cols);
  for (let r = 0; r < cols; r += 1) out[r] = v[r * cols + cols - 1] as number;
  return out;
}

/** An essential matrix from eight or more normalised correspondences. */
function essentialFrom(a: Float64Array, b: Float64Array, picks: readonly number[]): Float64Array {
  const rows = new Float64Array(Math.max(9, picks.length) * 9);
  picks.forEach((at, row) => {
    const [x1, y1] = [a[at * 2] as number, a[at * 2 + 1] as number];
    const [x2, y2] = [b[at * 2] as number, b[at * 2 + 1] as number];
    const terms = [x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1];
    for (let c = 0; c < 9; c += 1) rows[row * 9 + c] = terms[c] as number;
  });
  const flat = nullVector(rows, Math.max(9, picks.length), 9);
  /* An essential matrix has two equal singular values and a third of zero: make it one. */
  const u = new Float64Array(9);
  const s = new Float64Array(3);
  const v = new Float64Array(9);
  svd3(flat, u, s, v);
  const scale = ((s[0] as number) + (s[1] as number)) / 2;
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] =
        scale *
        ((u[r * 3] as number) * (v[c * 3] as number) +
          (u[r * 3 + 1] as number) * (v[c * 3 + 1] as number));
    }
  }
  return out;
}

/** A homography from four or more normalised correspondences. */
function homographyFrom(a: Float64Array, b: Float64Array, picks: readonly number[]): Float64Array {
  const count = Math.max(9, picks.length * 2);
  const rows = new Float64Array(count * 9);
  picks.forEach((at, pick) => {
    const [x1, y1] = [a[at * 2] as number, a[at * 2 + 1] as number];
    const [x2, y2] = [b[at * 2] as number, b[at * 2 + 1] as number];
    const first = [-x1, -y1, -1, 0, 0, 0, x2 * x1, x2 * y1, x2];
    const second = [0, 0, 0, -x1, -y1, -1, y2 * x1, y2 * y1, y2];
    for (let c = 0; c < 9; c += 1) {
      rows[pick * 2 * 9 + c] = first[c] as number;
      rows[(pick * 2 + 1) * 9 + c] = second[c] as number;
    }
  });
  return nullVector(rows, count, 9);
}

/** Sampson's distance from an essential matrix, in pixels of the first camera. */
function essentialError(
  e: Float64Array,
  a: Float64Array,
  b: Float64Array,
  at: number,
  focal: number,
): number {
  const x1 = [a[at * 2] as number, a[at * 2 + 1] as number, 1];
  const x2 = [b[at * 2] as number, b[at * 2 + 1] as number, 1];
  const ex1 = [0, 0, 0];
  const etx2 = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      ex1[r] = (ex1[r] as number) + (e[r * 3 + c] as number) * (x1[c] as number);
      etx2[c] = (etx2[c] as number) + (e[r * 3 + c] as number) * (x2[r] as number);
    }
  }
  const numerator =
    (x2[0] as number) * (ex1[0] as number) +
    (x2[1] as number) * (ex1[1] as number) +
    (x2[2] as number) * (ex1[2] as number);
  const denominator =
    (ex1[0] as number) * (ex1[0] as number) +
    (ex1[1] as number) * (ex1[1] as number) +
    (etx2[0] as number) * (etx2[0] as number) +
    (etx2[1] as number) * (etx2[1] as number);
  if (denominator === 0) return Infinity;
  return (Math.abs(numerator) / Math.sqrt(denominator)) * focal;
}

/** The symmetric transfer error of a homography, in pixels. */
function homographyError(
  h: Float64Array,
  a: Float64Array,
  b: Float64Array,
  at: number,
  focal: number,
): number {
  const apply = (m: Float64Array, x: number, y: number): [number, number] | null => {
    const u = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number);
    const v = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number);
    const w = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number);
    return w === 0 ? null : [u / w, v / w];
  };
  const inverse = invert3(h);
  if (inverse === null) return Infinity;
  const forward = apply(h, a[at * 2] as number, a[at * 2 + 1] as number);
  const backward = apply(inverse, b[at * 2] as number, b[at * 2 + 1] as number);
  if (forward === null || backward === null) return Infinity;
  /* A root of a sum, not `Math.hypot`, which the determinism gate refuses. */
  const forwardX = forward[0] - (b[at * 2] as number);
  const forwardY = forward[1] - (b[at * 2 + 1] as number);
  const backwardX = backward[0] - (a[at * 2] as number);
  const backwardY = backward[1] - (a[at * 2 + 1] as number);
  const first = Math.sqrt(forwardX * forwardX + forwardY * forwardY);
  const second = Math.sqrt(backwardX * backwardX + backwardY * backwardY);
  return ((first + second) / 2) * focal;
}

function invert3(m: Float64Array): Float64Array | null {
  const a = m[0] as number;
  const b = m[1] as number;
  const c = m[2] as number;
  const d = m[3] as number;
  const e = m[4] as number;
  const f = m[5] as number;
  const g = m[6] as number;
  const h = m[7] as number;
  const i = m[8] as number;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-14) return null;
  const out = new Float64Array(9);
  out[0] = (e * i - f * h) / determinant;
  out[1] = (c * h - b * i) / determinant;
  out[2] = (b * f - c * e) / determinant;
  out[3] = (f * g - d * i) / determinant;
  out[4] = (a * i - c * g) / determinant;
  out[5] = (c * d - a * f) / determinant;
  out[6] = (d * h - e * g) / determinant;
  out[7] = (b * g - a * h) / determinant;
  out[8] = (a * e - b * d) / determinant;
  return out;
}

/** One point from a pair of rays, by the linear method, into `out` at `at`. */
function triangulatePoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rotation: Float64Array,
  translation: Float64Array,
  out: Float64Array,
  at: number,
): boolean {
  /* Four rows of `x × (P · X) = 0`, two from each camera, solved by their normal equations. */
  const rows = [
    [-1, 0, ax, 0],
    [0, -1, ay, 0],
    [
      (rotation[0] as number) - bx * (rotation[6] as number),
      (rotation[1] as number) - bx * (rotation[7] as number),
      (rotation[2] as number) - bx * (rotation[8] as number),
      (translation[0] as number) - bx * (translation[2] as number),
    ],
    [
      (rotation[3] as number) - by * (rotation[6] as number),
      (rotation[4] as number) - by * (rotation[7] as number),
      (rotation[5] as number) - by * (rotation[8] as number),
      (translation[1] as number) - by * (translation[2] as number),
    ],
  ];
  const normals = new Float64Array(9);
  const right = new Float64Array(3);
  for (const row of rows) {
    for (let r = 0; r < 3; r += 1) {
      right[r] = (right[r] as number) - (row[r] as number) * (row[3] as number);
      for (let c = 0; c < 3; c += 1) {
        normals[r * 3 + c] =
          (normals[r * 3 + c] as number) + (row[r] as number) * (row[c] as number);
      }
    }
  }
  const factor = new Float64Array(9);
  if (!cholesky(normals, 3, factor)) return false;
  const point = Float64Array.from(right);
  choleskySolve(factor, 3, point);
  out[at * 3] = point[0] as number;
  out[at * 3 + 1] = point[1] as number;
  out[at * 3 + 2] = point[2] as number;
  return true;
}

/**
 * The points behind `count` correspondences, in the first camera's frame, into `out` (3 each), and
 * how many landed in front of both cameras. A point that did not is left at zero.
 */
export function triangulate(
  a: Float64Array,
  b: Float64Array,
  count: number,
  intrinsics: readonly [number, number, number, number],
  rotation: Float64Array,
  translation: Float64Array,
  out: Float64Array,
): number {
  const [fx, fy, cx, cy] = intrinsics;
  let ahead = 0;
  for (let at = 0; at < count; at += 1) {
    const ax = ((a[at * 2] as number) - cx) / fx;
    const ay = ((a[at * 2 + 1] as number) - cy) / fy;
    const bx = ((b[at * 2] as number) - cx) / fx;
    const by = ((b[at * 2 + 1] as number) - cy) / fy;
    out[at * 3] = 0;
    out[at * 3 + 1] = 0;
    out[at * 3 + 2] = 0;
    if (!triangulatePoint(ax, ay, bx, by, rotation, translation, out, at)) continue;
    const z = out[at * 3 + 2] as number;
    if (!(z > 0)) {
      out[at * 3] = 0;
      out[at * 3 + 1] = 0;
      out[at * 3 + 2] = 0;
      continue;
    }
    /* And in front of the second camera too, which is what a wrong decomposition fails. */
    let second = translation[2] as number;
    for (let k = 0; k < 3; k += 1) {
      second += (rotation[6 + k] as number) * (out[at * 3 + k] as number);
    }
    if (second > 0) ahead += 1;
    else {
      out[at * 3] = 0;
      out[at * 3 + 1] = 0;
      out[at * 3 + 2] = 0;
    }
  }
  return ahead;
}

/** The four poses an essential matrix allows, and the one its points stand in front of. */
function decompose(
  e: Float64Array,
  a: Float64Array,
  b: Float64Array,
  picks: readonly number[],
  out: RelativePoseOut,
): number {
  const u = new Float64Array(9);
  const s = new Float64Array(3);
  const v = new Float64Array(9);
  svd3(e, u, s, v);
  const w = Float64Array.from([0, -1, 0, 1, 0, 0, 0, 0, 1]);
  const build = (turned: boolean): Float64Array => {
    /* U · W · Vᵀ, or U · Wᵀ · Vᵀ: the two rotations an essential matrix allows. */
    const out2 = new Float64Array(9);
    const uw = new Float64Array(9);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1) {
          sum +=
            (u[r * 3 + k] as number) *
            (turned ? (w[c * 3 + k] as number) : (w[k * 3 + c] as number));
        }
        uw[r * 3 + c] = sum;
      }
    }
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1) sum += (uw[r * 3 + k] as number) * (v[c * 3 + k] as number);
        out2[r * 3 + c] = sum;
      }
    }
    /* A rotation has determinant one; the other sign is a reflection. */
    const determinant =
      (out2[0] as number) *
        ((out2[4] as number) * (out2[8] as number) - (out2[5] as number) * (out2[7] as number)) -
      (out2[1] as number) *
        ((out2[3] as number) * (out2[8] as number) - (out2[5] as number) * (out2[6] as number)) +
      (out2[2] as number) *
        ((out2[3] as number) * (out2[7] as number) - (out2[4] as number) * (out2[6] as number));
    if (determinant < 0) for (let i = 0; i < 9; i += 1) out2[i] = -(out2[i] as number);
    return out2;
  };

  const direction = Float64Array.from([u[2] as number, u[5] as number, u[8] as number]);
  const scratch = new Float64Array(picks.length * 3);
  const subA = new Float64Array(picks.length * 2);
  const subB = new Float64Array(picks.length * 2);
  picks.forEach((at, i) => {
    subA[i * 2] = a[at * 2] as number;
    subA[i * 2 + 1] = a[at * 2 + 1] as number;
    subB[i * 2] = b[at * 2] as number;
    subB[i * 2 + 1] = b[at * 2 + 1] as number;
  });
  let best = -1;
  for (const turned of [false, true]) {
    const rotation = build(turned);
    for (const sign of [1, -1]) {
      const translation = Float64Array.from([
        sign * (direction[0] as number),
        sign * (direction[1] as number),
        sign * (direction[2] as number),
      ]);
      const ahead = triangulate(
        subA,
        subB,
        picks.length,
        [1, 1, 0, 0],
        rotation,
        translation,
        scratch,
      );
      if (ahead > best) {
        best = ahead;
        out.rotation.set(rotation);
        out.translation.set(translation);
      }
    }
  }
  return best;
}

/** The median angle between the two rays to each point, in degrees. */
function parallaxOf(
  a: Float64Array,
  b: Float64Array,
  picks: readonly number[],
  rotation: Float64Array,
  translation: Float64Array,
): number {
  const angles: number[] = [];
  const point = new Float64Array(3);
  const centre = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    /* The second camera's centre in the first's frame: −Rᵀ · t. */
    centre[k] = -(
      (rotation[k] as number) * (translation[0] as number) +
      (rotation[3 + k] as number) * (translation[1] as number) +
      (rotation[6 + k] as number) * (translation[2] as number)
    );
  }
  for (const at of picks) {
    if (
      !triangulatePoint(
        a[at * 2] as number,
        a[at * 2 + 1] as number,
        b[at * 2] as number,
        b[at * 2 + 1] as number,
        rotation,
        translation,
        point,
        0,
      )
    ) {
      continue;
    }
    const first = [point[0] as number, point[1] as number, point[2] as number];
    const second = [
      first[0] - (centre[0] as number),
      first[1] - (centre[1] as number),
      first[2] - (centre[2] as number),
    ];
    const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
    const lengths =
      Math.sqrt(first[0] * first[0] + first[1] * first[1] + first[2] * first[2]) *
      Math.sqrt(second[0] * second[0] + second[1] * second[1] + second[2] * second[2]);
    if (lengths === 0) continue;
    angles.push((exactAcos(Math.min(1, Math.max(-1, dot / lengths))) * 180) / Math.PI);
  }
  if (angles.length === 0) return 0;
  angles.sort((p, q) => p - q);
  return angles[Math.floor(angles.length / 2)] as number;
}

/**
 * The pose of the second view relative to the first, from `count` correspondences in pixels.
 * `random` is the caller's seeded generator: a capture answers the same twice.
 */
export function relativePose(
  a: Float64Array,
  b: Float64Array,
  count: number,
  intrinsics: readonly [number, number, number, number],
  random: () => number,
  out: RelativePoseOut,
): RelativePoseResult {
  const [fx, fy, cx, cy] = intrinsics;
  const focal = (fx + fy) / 2;
  const normalA = new Float64Array(count * 2);
  const normalB = new Float64Array(count * 2);
  for (let at = 0; at < count; at += 1) {
    normalA[at * 2] = ((a[at * 2] as number) - cx) / fx;
    normalA[at * 2 + 1] = ((a[at * 2 + 1] as number) - cy) / fy;
    normalB[at * 2] = ((b[at * 2] as number) - cx) / fx;
    normalB[at * 2 + 1] = ((b[at * 2 + 1] as number) - cy) / fy;
  }

  const sample = (size: number): number[] => {
    const picks: number[] = [];
    while (picks.length < size) {
      const at = Math.min(count - 1, Math.floor(random() * count));
      if (!picks.includes(at)) picks.push(at);
    }
    return picks;
  };
  const score = (
    fit: (picks: readonly number[]) => Float64Array,
    error: (model: Float64Array, at: number) => number,
    size: number,
  ): { model: Float64Array | null; inliers: number[]; score: number } => {
    let best: Float64Array | null = null;
    let bestInliers: number[] = [];
    let bestScore = -1;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const model = fit(sample(size));
      let sum = 0;
      const inliers: number[] = [];
      for (let at = 0; at < count; at += 1) {
        const off = error(model, at);
        if (off < THRESHOLD) {
          inliers.push(at);
          /* A score that rewards a close fit rather than counting alone. */
          sum += THRESHOLD - off;
        }
      }
      if (sum > bestScore) {
        bestScore = sum;
        best = model;
        bestInliers = inliers;
      }
    }
    return { model: best, inliers: bestInliers, score: bestScore };
  };

  const essential = score(
    (picks) => essentialFrom(normalA, normalB, picks),
    (model, at) => essentialError(model, normalA, normalB, at, focal),
    8,
  );
  const homography = score(
    (picks) => homographyFrom(normalA, normalB, picks),
    (model, at) => homographyError(model, normalA, normalB, at, focal),
    4,
  );

  const total = essential.score + homography.score;
  const planar = total > 0 && homography.score / total > PLANAR;
  out.rotation.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  out.translation.set([0, 0, 0]);

  if (!planar && essential.model !== null && essential.inliers.length >= 8) {
    const refined = essentialFrom(normalA, normalB, essential.inliers);
    decompose(refined, normalA, normalB, essential.inliers, out);
    const parallax = parallaxOf(normalA, normalB, essential.inliers, out.rotation, out.translation);
    if (parallax >= TURNED) {
      return { inliers: essential.inliers.length, model: 'essential', parallax };
    }
    /* It moved too little to say where: answer the turn and claim no baseline. */
    out.translation.set([0, 0, 0]);
    return { inliers: essential.inliers.length, model: 'homography', parallax };
  }

  if (homography.model !== null) {
    /* A turn's homography is `R` itself once the intrinsics are out of it; scale it to a rotation. */
    const h = homography.model;
    const u = new Float64Array(9);
    const s = new Float64Array(3);
    const v = new Float64Array(9);
    svd3(h, u, s, v);
    const rotation = new Float64Array(9);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1) sum += (u[r * 3 + k] as number) * (v[c * 3 + k] as number);
        rotation[r * 3 + c] = sum;
      }
    }
    const determinant =
      (rotation[0] as number) *
        ((rotation[4] as number) * (rotation[8] as number) -
          (rotation[5] as number) * (rotation[7] as number)) -
      (rotation[1] as number) *
        ((rotation[3] as number) * (rotation[8] as number) -
          (rotation[5] as number) * (rotation[6] as number)) +
      (rotation[2] as number) *
        ((rotation[3] as number) * (rotation[7] as number) -
          (rotation[4] as number) * (rotation[6] as number));
    if (determinant < 0) for (let i = 0; i < 9; i += 1) rotation[i] = -(rotation[i] as number);
    out.rotation.set(rotation);
    return { inliers: homography.inliers.length, model: 'homography', parallax: 0 };
  }
  return { inliers: 0, model: 'homography', parallax: 0 };
}
