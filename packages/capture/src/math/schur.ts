/**
 * The Schur complement over points: a bundle adjustment's normal equations solved by eliminating
 * the points first, which leaves a system the size of the cameras.
 *
 * **It is an ordering, not an approximation.** A point appears in the rows of its own observations
 * and nowhere else, so its three parameters can be solved for in terms of the cameras and
 * substituted out exactly; what is left is the cameras' own system with a correction per link, and
 * the points come back by back-substitution. The answer is the answer a dense solve would give —
 * `schur.test.ts` holds it to one — and the saving is that a clip with a thousand points and twenty
 * cameras solves a matrix of 120 rows rather than 3,120.
 *
 * **The damping is the caller's, applied here**, since it has to sit on the diagonal before the
 * points are eliminated rather than after: `diagonal · (1 + λ) + λ`, which is Marquardt's scaling
 * with a floor for a parameter whose curvature is zero.
 *
 * **A block that cannot be factored is refused rather than stepped through.** A point nothing
 * constrains would be a division by nothing, and a reduced system that is singular means the
 * cameras are not determined by what was seen — both are answers a caller must have, so they come
 * back as false rather than as a step full of infinities.
 */
import { cholesky, choleskySolve } from './dense.ts';

/** The normal equations in blocks: cameras, points of three, and one link per observation. */
export interface BlockNormals {
  readonly cameras: number;
  /** Parameters a camera; the points are three each. */
  readonly cameraSize: number;
  readonly points: number;
  /** `cameras · cameraSize²`, each symmetric and row-major. */
  readonly cameraBlocks: Float64Array;
  /** `points · 9`, each symmetric and row-major. */
  readonly pointBlocks: Float64Array;
  /** `links · cameraSize · 3`, row-major: a camera's rows against a point's columns. */
  readonly links: Float64Array;
  readonly linkCamera: Int32Array;
  readonly linkPoint: Int32Array;
  /** The right-hand side: `cameras · cameraSize` and `points · 3`. */
  readonly cameraGradient: Float64Array;
  readonly pointGradient: Float64Array;
}

const POINT = 3;

/**
 * The step for `damping`, into `cameraStep` (`cameras · cameraSize`) and `pointStep`
 * (`points · 3`); false where a point's block or the reduced system cannot be factored.
 */
export function schurSolve(
  normals: BlockNormals,
  damping: number,
  cameraStep: Float64Array,
  pointStep: Float64Array,
): boolean {
  const { cameras, cameraSize, points, links, linkCamera, linkPoint } = normals;
  const width = cameras * cameraSize;
  const linkCount = linkCamera.length;

  /* Each point's own block, damped and factored once: everything below reads it. */
  const factors = new Float64Array(points * POINT * POINT);
  const block = new Float64Array(POINT * POINT);
  for (let p = 0; p < points; p += 1) {
    for (let r = 0; r < POINT; r += 1) {
      for (let c = 0; c < POINT; c += 1) {
        const value = normals.pointBlocks[(p * POINT + r) * POINT + c] as number;
        block[r * POINT + c] = r === c ? value * (1 + damping) + damping : value;
      }
    }
    if (!cholesky(block, POINT, block)) return false;
    factors.set(block, p * POINT * POINT);
  }

  /* The reduced system: the cameras' own blocks, less each link's share of its point. */
  const reduced = new Float64Array(width * width);
  const right = new Float64Array(width);
  for (let c = 0; c < cameras; c += 1) {
    for (let r = 0; r < cameraSize; r += 1) {
      right[c * cameraSize + r] = normals.cameraGradient[c * cameraSize + r] as number;
      for (let k = 0; k < cameraSize; k += 1) {
        const value = normals.cameraBlocks[(c * cameraSize + r) * cameraSize + k] as number;
        reduced[(c * cameraSize + r) * width + c * cameraSize + k] =
          r === k ? value * (1 + damping) + damping : value;
      }
    }
  }

  /* Each link's `w · v⁻¹`, kept for the reduction and for the back-substitution after it. */
  const solved = new Float64Array(linkCount * cameraSize * POINT);
  const column = new Float64Array(POINT);
  for (let link = 0; link < linkCount; link += 1) {
    const point = linkPoint[link] as number;
    const factor = factors.subarray(point * POINT * POINT, (point + 1) * POINT * POINT);
    for (let r = 0; r < cameraSize; r += 1) {
      for (let k = 0; k < POINT; k += 1) {
        column[k] = links[(link * cameraSize + r) * POINT + k] as number;
      }
      choleskySolve(factor, POINT, column);
      for (let k = 0; k < POINT; k += 1) {
        solved[(link * cameraSize + r) * POINT + k] = column[k] as number;
      }
    }
  }

  /* Two links on one point couple their cameras, which is where the reduction's off-diagonals are. */
  for (let a = 0; a < linkCount; a += 1) {
    for (let b = 0; b < linkCount; b += 1) {
      if ((linkPoint[a] as number) !== (linkPoint[b] as number)) continue;
      const rowCamera = (linkCamera[a] as number) * cameraSize;
      const colCamera = (linkCamera[b] as number) * cameraSize;
      for (let r = 0; r < cameraSize; r += 1) {
        for (let c = 0; c < cameraSize; c += 1) {
          let sum = 0;
          for (let k = 0; k < POINT; k += 1) {
            sum +=
              (solved[(a * cameraSize + r) * POINT + k] as number) *
              (links[(b * cameraSize + c) * POINT + k] as number);
          }
          reduced[(rowCamera + r) * width + colCamera + c] -= sum;
        }
      }
    }
  }
  for (let link = 0; link < linkCount; link += 1) {
    const camera = (linkCamera[link] as number) * cameraSize;
    const point = (linkPoint[link] as number) * POINT;
    for (let r = 0; r < cameraSize; r += 1) {
      let sum = 0;
      for (let k = 0; k < POINT; k += 1) {
        sum +=
          (solved[(link * cameraSize + r) * POINT + k] as number) *
          (normals.pointGradient[point + k] as number);
      }
      right[camera + r] -= sum;
    }
  }

  const factor = new Float64Array(width * width);
  if (!cholesky(reduced, width, factor)) return false;
  cameraStep.set(right);
  choleskySolve(factor, width, cameraStep);

  /* And the points come back: their own gradient, less what the cameras just took. */
  for (let p = 0; p < points; p += 1) {
    for (let k = 0; k < POINT; k += 1) {
      pointStep[p * POINT + k] = normals.pointGradient[p * POINT + k] as number;
    }
  }
  for (let link = 0; link < linkCount; link += 1) {
    const camera = (linkCamera[link] as number) * cameraSize;
    const point = (linkPoint[link] as number) * POINT;
    for (let k = 0; k < POINT; k += 1) {
      let sum = 0;
      for (let r = 0; r < cameraSize; r += 1) {
        sum +=
          (links[(link * cameraSize + r) * POINT + k] as number) *
          (cameraStep[camera + r] as number);
      }
      pointStep[point + k] = (pointStep[point + k] as number) - sum;
    }
  }
  for (let p = 0; p < points; p += 1) {
    const factored = factors.subarray(p * POINT * POINT, (p + 1) * POINT * POINT);
    for (let k = 0; k < POINT; k += 1) column[k] = pointStep[p * POINT + k] as number;
    choleskySolve(factored, POINT, column);
    for (let k = 0; k < POINT; k += 1) pointStep[p * POINT + k] = column[k] as number;
  }
  return true;
}
