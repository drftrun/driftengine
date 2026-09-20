/**
 * The screen-space gradients of one Gaussian carried back to its own parameters.
 *
 * **`project.ts` run backwards**, term for term: the perspective Jacobian, the covariance it acts
 * on, the rotation and scale that covariance is built from, and the quaternion behind the rotation.
 * Nothing here knows about pixels or compositing — it takes what `gradients.ts` gathered over a
 * Gaussian's own pixels and answers what that means for where it stands and how it is shaped.
 */
import { rotationFromQuaternion, type GaussianSet, type RasterCamera } from './project.ts';

import type { GaussianGradients } from './gradients.ts';

/**
 * The screen-space gradients carried back to a Gaussian's position, scale and rotation, by the
 * same chain the projection is built from.
 */
export function screenToParameters(
  set: GaussianSet,
  at: number,
  camera: RasterCamera,
  dMeanX: number,
  dMeanY: number,
  dA: number,
  dB: number,
  dD: number,
  out: GaussianGradients,
): void {
  const [fx, fy] = camera.intrinsics;
  const m = camera.worldToCamera;
  const view = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    view[r] =
      (m[r * 4] as number) * (set.positions[at * 3] as number) +
      (m[r * 4 + 1] as number) * (set.positions[at * 3 + 1] as number) +
      (m[r * 4 + 2] as number) * (set.positions[at * 3 + 2] as number) +
      (m[r * 4 + 3] as number);
  }
  const z = view[2] as number;
  const invZ = 1 / z;
  const invZ2 = invZ * invZ;
  const invZ3 = invZ2 * invZ;

  /* The world covariance in the camera's frame, which the Jacobian acts on. */
  const rotation = new Float64Array(9);
  rotationFromQuaternion(set.rotations, at, rotation);
  const scaled = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      scaled[r * 3 + c] = (rotation[r * 3 + c] as number) * (set.scales[at * 3 + c] as number);
    }
  }
  const world = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1)
        sum += (scaled[r * 3 + k] as number) * (scaled[c * 3 + k] as number);
      world[r * 3 + c] = sum;
    }
  }
  const viewRotation = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) viewRotation[r * 3 + c] = m[r * 4 + c] as number;
  }
  const inCamera = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        for (let j = 0; j < 3; j += 1) {
          sum +=
            (viewRotation[r * 3 + k] as number) *
            (world[k * 3 + j] as number) *
            (viewRotation[c * 3 + j] as number);
        }
      }
      inCamera[r * 3 + c] = sum;
    }
  }

  const j = [
    [fx * invZ, 0, -fx * (view[0] as number) * invZ2],
    [0, fy * invZ, -fy * (view[1] as number) * invZ2],
  ];
  /* dΣ'/dΣcam, then the same into the world and the Gaussian's own axes. */
  const dScreen = [
    [dA, dB / 2],
    [dB / 2, dD],
  ];
  const dCamera = new Float64Array(9);
  for (let k = 0; k < 3; k += 1) {
    for (let l = 0; l < 3; l += 1) {
      let sum = 0;
      for (let r = 0; r < 2; r += 1) {
        for (let c = 0; c < 2; c += 1) {
          sum +=
            ((dScreen[r] as number[])[c] as number) *
            ((j[r] as number[])[k] as number) *
            ((j[c] as number[])[l] as number);
        }
      }
      dCamera[k * 3 + l] = sum;
    }
  }
  const dWorld = new Float64Array(9);
  for (let k = 0; k < 3; k += 1) {
    for (let l = 0; l < 3; l += 1) {
      let sum = 0;
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          sum +=
            (viewRotation[r * 3 + k] as number) *
            (dCamera[r * 3 + c] as number) *
            (viewRotation[c * 3 + l] as number);
        }
      }
      dWorld[k * 3 + l] = sum;
    }
  }

  /* Σ = M · Mᵀ with M = R · diag(s), so dΣ/dM = 2 · dΣ · M for a symmetric dΣ. */
  const dM = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1)
        sum += (dWorld[r * 3 + k] as number) * (scaled[k * 3 + c] as number);
      dM[r * 3 + c] = 2 * sum;
    }
  }
  for (let c = 0; c < 3; c += 1) {
    let sum = 0;
    for (let r = 0; r < 3; r += 1)
      sum += (dM[r * 3 + c] as number) * (rotation[r * 3 + c] as number);
    out.scales[at * 3 + c] = (out.scales[at * 3 + c] as number) + sum;
  }
  /* And through the rotation to the quaternion, by its own derivatives. */
  const dRotation = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      dRotation[r * 3 + c] = (dM[r * 3 + c] as number) * (set.scales[at * 3 + c] as number);
    }
  }
  quaternionGradient(set.rotations, at, dRotation, out.rotations);

  /*
   * The position moves the mean and, through the Jacobian, the covariance. The second term is what
   * a gradient written from the mean alone misses — it is small at the centre of the frame and is
   * not small at its edges.
   */
  const dView = [
    dMeanX * fx * invZ,
    dMeanY * fy * invZ,
    -dMeanX * fx * (view[0] as number) * invZ2 - dMeanY * fy * (view[1] as number) * invZ2,
  ];
  /* dJ/dview, the only part of Σ' that the position enters. */
  const dJ = [
    [
      [0, 0, -fx * invZ2],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, -fy * invZ2],
    ],
    [
      [-fx * invZ2, 0, 2 * fx * (view[0] as number) * invZ3],
      [0, -fy * invZ2, 2 * fy * (view[1] as number) * invZ3],
    ],
  ];
  for (let k = 0; k < 3; k += 1) {
    for (let l = 0; l < 3; l += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        let sum = 0;
        for (let r = 0; r < 2; r += 1) {
          for (let c = 0; c < 2; c += 1) {
            const term =
              (((dJ[axis] as number[][])[r] as number[])[k] as number) *
                ((j[c] as number[])[l] as number) +
              ((j[r] as number[])[k] as number) *
                (((dJ[axis] as number[][])[c] as number[])[l] as number);
            sum += ((dScreen[r] as number[])[c] as number) * term * (inCamera[k * 3 + l] as number);
          }
        }
        dView[axis] = (dView[axis] as number) + sum;
      }
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    let sum = 0;
    for (let r = 0; r < 3; r += 1) sum += (dView[r] as number) * (m[r * 4 + axis] as number);
    out.positions[at * 3 + axis] = (out.positions[at * 3 + axis] as number) + sum;
  }
}

/** A rotation matrix's gradient carried back to the quaternion it came from. */
function quaternionGradient(
  q: Float64Array,
  at: number,
  dRotation: Float64Array,
  out: Float64Array,
): void {
  const x = q[at * 4] as number;
  const y = q[at * 4 + 1] as number;
  const z = q[at * 4 + 2] as number;
  const w = q[at * 4 + 3] as number;
  const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  const nx = x / length;
  const ny = y / length;
  const nz = z / length;
  const nw = w / length;
  /* dR/d(normalised quaternion), the nine entries against each of the four. */
  const d = [
    [0, 2 * ny, 2 * nz, 2 * ny, -4 * nx, -2 * nw, 2 * nz, 2 * nw, -4 * nx],
    [-4 * ny, 2 * nx, 2 * nw, 2 * nx, 0, 2 * nz, -2 * nw, 2 * nz, -4 * ny],
    [-4 * nz, -2 * nw, 2 * nx, 2 * nw, -4 * nz, 2 * ny, 2 * nx, 2 * ny, 0],
    [0, -2 * nz, 2 * ny, 2 * nz, 0, -2 * nx, -2 * ny, 2 * nx, 0],
  ];
  /* Through the normalisation: the part of a change that lengthens the quaternion does nothing. */
  const raw = [0, 0, 0, 0];
  for (let p = 0; p < 4; p += 1) {
    let sum = 0;
    for (let i = 0; i < 9; i += 1)
      sum += ((d[p] as number[])[i] as number) * (dRotation[i] as number);
    raw[p] = sum;
  }
  const unit = [nx, ny, nz, nw];
  let along = 0;
  for (let p = 0; p < 4; p += 1) along += (raw[p] as number) * (unit[p] as number);
  for (let p = 0; p < 4; p += 1) {
    out[at * 4 + p] =
      (out[at * 4 + p] as number) + ((raw[p] as number) - along * (unit[p] as number)) / length;
  }
}
