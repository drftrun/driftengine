/**
 * Frustum planes from a view-projection matrix, and the sphere test against them.
 *
 * **The reference implementation, and that is its job.** The culling arithmetic is written twice —
 * here for the processor and in WGSL for the device — and a test asserts the two agree over
 * generated input. `splats` already establishes that discipline for shaders authored once and
 * generated to two backends; this is the same rule where the second copy cannot be generated.
 *
 * **Reversed-Z does not change the planes, only their names.** `depthConvention.ts` maps near to 1
 * and far to 0, but the two depth planes are still "clip z at or above 0" and "clip z at or below
 * w" — the mapping swaps which physical plane each one is, and a sphere satisfying both is inside
 * either way. Nothing here has to know which way depth runs, which is why nothing here asks.
 *
 * Column-major throughout, matching the matrices the renderer already passes around.
 */

/** Six planes, four floats each: a, b, c, d with the normal pointing inward. */
export const FRUSTUM_FLOATS = 24;

function setPlane(out: Float32Array, at: number, a: number, b: number, c: number, d: number): void {
  /* Normalised so the plane test is a true signed distance and can be compared against a radius. */
  const length = Math.hypot(a, b, c);
  const k = length > 0 ? 1 / length : 0;
  out[at] = a * k;
  out[at + 1] = b * k;
  out[at + 2] = c * k;
  out[at + 3] = d * k;
}

export function frustumPlanes(viewProj: Float32Array, out: Float32Array): void {
  const m = viewProj;
  /* Rows of a column-major matrix: row i is m[i], m[4+i], m[8+i], m[12+i]. */
  const r0 = [m[0] as number, m[4] as number, m[8] as number, m[12] as number];
  const r1 = [m[1] as number, m[5] as number, m[9] as number, m[13] as number];
  const r2 = [m[2] as number, m[6] as number, m[10] as number, m[14] as number];
  const r3 = [m[3] as number, m[7] as number, m[11] as number, m[15] as number];

  setPlane(out, 0, r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]);
  setPlane(out, 4, r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]);
  setPlane(out, 8, r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]);
  setPlane(out, 12, r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]);
  /* The two depth planes, in clip terms rather than near/far terms. See the header. */
  setPlane(out, 16, r2[0], r2[1], r2[2], r2[3]);
  setPlane(out, 20, r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]);
}

/**
 * Whether a bounding sphere is entirely outside the frustum.
 *
 * **Conservative in one direction only.** A sphere straddling a plane survives, because culling
 * something visible is a hole in the picture and keeping something invisible is a wasted draw.
 */
export function sphereOutsideFrustum(
  planes: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): boolean {
  for (let p = 0; p < 6; p += 1) {
    const at = p * 4;
    const distance =
      (planes[at] as number) * cx +
      (planes[at + 1] as number) * cy +
      (planes[at + 2] as number) * cz +
      (planes[at + 3] as number);
    if (distance < -radius) return true;
  }
  return false;
}
