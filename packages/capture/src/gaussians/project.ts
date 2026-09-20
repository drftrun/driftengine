/**
 * Where a Gaussian lands on screen: the projection `@driftengine/splats`' shader performs, in
 * JavaScript, and the order a frame draws them in.
 *
 * **The same model, in the capture's own frame.** A perspective divide is not linear, so a
 * three-dimensional Gaussian does not project to a two-dimensional one; the standard treatment,
 * which that shader uses and this repeats, linearises about the splat's centre — `Σ' = J·R·Σ·Rᵀ·Jᵀ`
 * — and adds a low-pass of 0.3 to the screen variances so that a splat smaller than a pixel still
 * covers one. The one difference is handedness: the shader works in the renderer's view space,
 * where z runs away from the camera negatively, and a capture's cameras look down positive z. The
 * arithmetic is the same and the frame is the caller's.
 *
 * **It exists to be differentiated.** `projectGradient.ts` is this chain run backwards, and
 * `gradients.test.ts` holds the two together by a central difference of one against the other.
 */
export interface GaussianSet {
  count: number;
  /** Three per Gaussian, in the capture's world. */
  readonly positions: Float64Array;
  /** Three per Gaussian: a standard deviation along each of its own axes, in metres. */
  readonly scales: Float64Array;
  /** Four per Gaussian, xyzw, as the engine's quaternions are. */
  readonly rotations: Float64Array;
  /** Three per Gaussian, linear, which is a spherical harmonic's constant term. */
  readonly colors: Float64Array;
  /** Nine per Gaussian for the degree-1 band, or absent for a cloud with no view dependence. */
  readonly sh1?: Float64Array;
  /** One per Gaussian, 0 to 1. */
  readonly opacities: Float64Array;
}

/**
 * A frame this rasteriser writes: **single precision where it stands in for a render target, double
 * where the caller is differentiating through it.** The fitting loop accumulates its loss in double
 * and a frame quantised to single is a floor under every difference taken through one — measured at
 * about a part in five hundred of the slope, against a part in ten million when the frame is double.
 */
export type Frame = Float32Array | Float64Array;

export interface RasterCamera {
  readonly width: number;
  readonly height: number;
  /** `fx`, `fy`, `cx`, `cy`. */
  readonly intrinsics: readonly [number, number, number, number];
  /** 3 × 4 row-major world-to-camera, as `estimatePoses` answers. */
  readonly worldToCamera: Float64Array;
}

/** The low-pass the shader adds to the screen variances, in square pixels. */
export const LOW_PASS = 0.3;
/** How many standard deviations of a splat are drawn, and the largest radius in pixels. */
export const REACH = 3;
const MAX_RADIUS = 256;

/** One Gaussian as the screen sees it. */
export interface Projected {
  /** Where its centre lands, in pixels. */
  readonly x: number;
  readonly y: number;
  /** Its screen covariance, `[a, b, d]` for `[[a, b], [b, d]]`, the low-pass included. */
  readonly a: number;
  readonly b: number;
  readonly d: number;
  /** Along the camera's own axis, which is what the painter's order is by. */
  readonly depth: number;
  /** The half-width of its axis-aligned box, in pixels. */
  readonly radius: number;
}

/** The rotation a quaternion stands for, into `out` (3 × 3 row-major). */
export function rotationFromQuaternion(q: ArrayLike<number>, at: number, out: Float64Array): void {
  const x = q[at * 4] as number;
  const y = q[at * 4 + 1] as number;
  const z = q[at * 4 + 2] as number;
  const w = q[at * 4 + 3] as number;
  const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  const nx = x / length;
  const ny = y / length;
  const nz = z / length;
  const nw = w / length;
  out[0] = 1 - 2 * (ny * ny + nz * nz);
  out[1] = 2 * (nx * ny - nz * nw);
  out[2] = 2 * (nx * nz + ny * nw);
  out[3] = 2 * (nx * ny + nz * nw);
  out[4] = 1 - 2 * (nx * nx + nz * nz);
  out[5] = 2 * (ny * nz - nx * nw);
  out[6] = 2 * (nx * nz - ny * nw);
  out[7] = 2 * (ny * nz + nx * nw);
  out[8] = 1 - 2 * (nx * nx + ny * ny);
}

/** One Gaussian projected, or null where it is behind the camera or too flat to draw. */
export function projectGaussian(
  set: GaussianSet,
  at: number,
  camera: RasterCamera,
): Projected | null {
  const [fx, fy, cx, cy] = camera.intrinsics;
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
  if (!(z > 1e-3)) return null;

  /* The world covariance: R · diag(s²) · Rᵀ, turned into the camera's frame by the view rotation. */
  const rotation = new Float64Array(9);
  rotationFromQuaternion(set.rotations, at, rotation);
  const scaled = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const s = set.scales[at * 3 + c] as number;
      scaled[r * 3 + c] = (rotation[r * 3 + c] as number) * s;
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
  const inCamera = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        for (let j = 0; j < 3; j += 1) {
          sum += (m[r * 4 + k] as number) * (world[k * 3 + j] as number) * (m[c * 4 + j] as number);
        }
      }
      inCamera[r * 3 + c] = sum;
    }
  }

  /* The projection's Jacobian at this point, in pixels. */
  const invZ = 1 / z;
  const invZ2 = invZ * invZ;
  const j = [
    [fx * invZ, 0, -fx * (view[0] as number) * invZ2],
    [0, fy * invZ, -fy * (view[1] as number) * invZ2],
  ];
  const screen = [0, 0, 0, 0];
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 2; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        for (let l = 0; l < 3; l += 1) {
          sum +=
            ((j[r] as number[])[k] as number) *
            (inCamera[k * 3 + l] as number) *
            ((j[c] as number[])[l] as number);
        }
      }
      screen[r * 2 + c] = sum;
    }
  }
  const a = (screen[0] as number) + LOW_PASS;
  const b = screen[1] as number;
  const d = (screen[3] as number) + LOW_PASS;
  const determinant = a * d - b * b;
  if (!(determinant > 1e-12)) return null;
  /* The ellipse's larger eigenvalue fixes how far it reaches. */
  const mid = 0.5 * (a + d);
  const spread = Math.sqrt(Math.max(0.1, mid * mid - determinant));
  const radius = Math.min(MAX_RADIUS, REACH * Math.sqrt(Math.max(mid + spread, 0)));
  return {
    x: fx * (view[0] as number) * invZ + cx,
    y: fy * (view[1] as number) * invZ + cy,
    a,
    b,
    d,
    depth: z,
    radius,
  };
}

/** The Gaussians a camera sees, nearest first, and where each lands. */
export function visibleGaussians(
  set: GaussianSet,
  camera: RasterCamera,
): { readonly order: number[]; readonly projected: (Projected | null)[] } {
  const projected: (Projected | null)[] = [];
  const order: number[] = [];
  for (let at = 0; at < set.count; at += 1) {
    const one = projectGaussian(set, at, camera);
    projected.push(one);
    if (one === null) continue;
    if (one.x + one.radius < 0 || one.x - one.radius >= camera.width) continue;
    if (one.y + one.radius < 0 || one.y - one.radius >= camera.height) continue;
    order.push(at);
  }
  /* Nearest first, ties by index so the answer does not depend on the sort's stability. */
  order.sort((p, q) => {
    const first = (projected[p] as Projected).depth;
    const second = (projected[q] as Projected).depth;
    return first === second ? p - q : first - second;
  });
  return { order, projected };
}
