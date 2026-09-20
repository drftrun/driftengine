import type { ReadonlyMat4 } from 'gl-matrix';

/**
 * The six planes bounding what a camera can see, and whether a sphere is among them.
 *
 * **A `Float32Array(24)` rather than six objects**, for the reason every hot path in this engine
 * gives: a visibility test runs per draw per frame, and an array of plane objects is six
 * dereferences a test and an allocation per rebuild.
 *
 * Planes are stored as `(nx, ny, nz, d)` with the normal pointing *inwards*, so a point is inside
 * the frustum when `n · p + d >= 0` for all six.
 */
export type Frustum = Float32Array;

/**
 * Planes in either precision. **Double precision is for a world past 2^24 units**, where a plane's
 * offset is a number a single float cannot hold to the metre; `cellsInFrustum` asks for it.
 */
export type FrustumPlanes = Float32Array | Float64Array;

/** Left, right, bottom, top, near, far — the order the extraction below produces. */
const PLANE_COUNT = 6;

export function createFrustum(): Frustum {
  return new Float32Array(PLANE_COUNT * 4);
}

/**
 * Pull the six planes out of a view-projection matrix.
 *
 * **This is Gribb and Hartmann, and it is worth naming because it looks like a trick.** A
 * view-projection takes a world point to clip space, where being inside the frustum is
 * `-w <= x <= w` and the same for y and z. Writing `x >= -w` as `x + w >= 0` and substituting the
 * matrix rows gives a plane equation in world coordinates directly — so the left plane is row 4
 * plus row 1, the right is row 4 minus row 1, and so on. No inversion, no corner extraction.
 *
 * **Normalising is not tidiness.** Straight out of the matrix a plane's normal has an arbitrary
 * length, so `n · p + d` is a distance in some unscaled clip unit. Dividing through by the
 * normal's length makes it a distance in world units, which is the only form a radius in metres
 * can be compared against. Skipping it produces a test that is *nearly* right, and wrong by a
 * factor that changes with the field of view.
 *
 * gl-matrix stores column-major, so `m[column * 4 + row]`.
 */
export function frustumFromViewProjection<T extends FrustumPlanes>(
  m: ReadonlyMat4 | Float64Array,
  out: T,
): T {
  const m0 = m[0] ?? 0;
  const m1 = m[1] ?? 0;
  const m2 = m[2] ?? 0;
  const m3 = m[3] ?? 0;
  const m4 = m[4] ?? 0;
  const m5 = m[5] ?? 0;
  const m6 = m[6] ?? 0;
  const m7 = m[7] ?? 0;
  const m8 = m[8] ?? 0;
  const m9 = m[9] ?? 0;
  const m10 = m[10] ?? 0;
  const m11 = m[11] ?? 0;
  const m12 = m[12] ?? 0;
  const m13 = m[13] ?? 0;
  const m14 = m[14] ?? 0;
  const m15 = m[15] ?? 0;

  /* Row 4 ± row 1, 2, 3. Row r of a column-major matrix is m[r], m[4+r], m[8+r], m[12+r]. */
  setPlane(out, 0, m3 + m0, m7 + m4, m11 + m8, m15 + m12);
  setPlane(out, 1, m3 - m0, m7 - m4, m11 - m8, m15 - m12);
  setPlane(out, 2, m3 + m1, m7 + m5, m11 + m9, m15 + m13);
  setPlane(out, 3, m3 - m1, m7 - m5, m11 - m9, m15 - m13);
  /*
   * **Near is `row4 + row3` and not `row3` alone**, which is the WebGL convention where clip z
   * runs -w..w. WebGPU's runs 0..w and its near plane really is row 3 — but every matrix in this
   * engine is built by gl-matrix's `perspective`, which is the OpenGL convention, and the
   * WebGPU backend corrects it with `CLIP_CORRECTION` at the last moment before drawing. So the
   * matrix reaching here is the OpenGL one on both backends, and one extraction serves both.
   */
  setPlane(out, 4, m3 + m2, m7 + m6, m11 + m10, m15 + m14);
  setPlane(out, 5, m3 - m2, m7 - m6, m11 - m10, m15 - m14);
  return out;
}

function setPlane(
  out: FrustumPlanes,
  index: number,
  x: number,
  y: number,
  z: number,
  d: number,
): void {
  const length = Math.sqrt(x * x + y * y + z * z);
  /* A degenerate matrix gives a zero-length normal; leaving it unscaled is better than NaN,
     and the plane then accepts everything, which is the safe direction for a cull to fail. */
  const scale = length > 1e-12 ? 1 / length : 0;
  const at = index * 4;
  out[at] = x * scale;
  out[at + 1] = y * scale;
  out[at + 2] = z * scale;
  out[at + 3] = d * scale;
}

/**
 * Whether a world-space sphere is anywhere inside the frustum.
 *
 * **The question is "outside any one plane", not "inside every plane".** A sphere is rejected
 * only when it lies entirely on the far side of a single plane; anything else is kept. Asking
 * whether the *centre* is inside all six is the version that looks equivalent and is not — it
 * throws away everything larger than the view, so a room the camera is standing in vanishes.
 *
 * Conservative at the corners: a sphere can be outside the frustum and still be within radius of
 * all six planes, near an edge. That costs a draw that turns out to be invisible and never costs
 * a draw that was visible, which is the only asymmetry a cull may have.
 */
export function sphereInFrustum(
  frustum: FrustumPlanes,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  for (let plane = 0; plane < PLANE_COUNT; plane += 1) {
    const at = plane * 4;
    const distance =
      (frustum[at] ?? 0) * x +
      (frustum[at + 1] ?? 0) * y +
      (frustum[at + 2] ?? 0) * z +
      (frustum[at + 3] ?? 0);
    if (distance < -radius) return false;
  }
  return true;
}

/**
 * Whether an axis-aligned box is anywhere inside the frustum, by the same question the sphere test
 * asks: outside only when wholly beyond one plane.
 *
 * **The corner that decides it is chosen per plane** — the one furthest along that plane's normal.
 * A fixed corner answers correctly for the planes whose normals happen to point its way and culls a
 * box straddling any of the others. Conservative at the edges, as the sphere test is: a box near a
 * corner of the frustum can be outside it and still kept.
 */
export function boxInFrustum(
  frustum: FrustumPlanes,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  for (let plane = 0; plane < PLANE_COUNT; plane += 1) {
    const at = plane * 4;
    const nx = frustum[at] ?? 0;
    const ny = frustum[at + 1] ?? 0;
    const nz = frustum[at + 2] ?? 0;
    const reach =
      nx * (nx >= 0 ? maxX : minX) +
      ny * (ny >= 0 ? maxY : minY) +
      nz * (nz >= 0 ? maxZ : minZ) +
      (frustum[at + 3] ?? 0);
    if (reach < 0) return false;
  }
  return true;
}
