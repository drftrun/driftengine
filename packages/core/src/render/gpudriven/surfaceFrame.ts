/** What a textured pixel needs from its triangle that a compute invocation cannot take for itself. */

/**
 * **Two derivatives the forward path gets from the hardware and this pipeline has to build.** A
 * fragment shader takes `dFdx` and `dFdy`; a compute invocation has no neighbours. The shading
 * pass already has the analytic barycentric gradients — `SHADE_SURFACE_WGSL` builds them for the
 * shadow's receiver plane — and any attribute's screen gradient is those weights applied to its
 * three corners. The UV's picks a mip level; the UV's and the world position's together build the
 * tangent frame a normal map is read through.
 */

/**
 * The mip level a pixel's texture footprint asks for: the log of the longer of the two screen-axis
 * UV steps, in texels. The common isotropic form; a device choosing its own level for an
 * implicit-derivative sample may differ in the last bits, which is stated where the two pipelines
 * are compared rather than hidden here.
 */
export function surfaceLod(
  dudx: number,
  dvdx: number,
  dudy: number,
  dvdy: number,
  size: number,
): number {
  const footprint = Math.max(Math.hypot(dudx, dvdx), Math.hypot(dudy, dvdy)) * size;
  return Math.max(Math.log2(Math.max(footprint, 1e-30)), 0);
}

/**
 * `tangentFrame.ts`'s derived branch, from analytic gradients instead of `dFdx` and `dFdy`.
 *
 * **Term for term, including the determinant's sign and the one scale for both axes**, because the
 * forward path's comment records what each is worth: without the sign the frame points the other
 * way on one backend, and two scales shear a stretched UV layout. The screen axes here are x to the
 * right and y up, as the shading pass measures them; the fold makes the answer the same either way.
 */
export function derivedTangentFrame(
  n: readonly [number, number, number],
  dp1: readonly [number, number, number],
  dp2: readonly [number, number, number],
  duv1: readonly [number, number],
  duv2: readonly [number, number],
  out: Float32Array,
): Float32Array {
  const p2x = dp2[1] * n[2] - dp2[2] * n[1];
  const p2y = dp2[2] * n[0] - dp2[0] * n[2];
  const p2z = dp2[0] * n[1] - dp2[1] * n[0];
  const p1x = n[1] * dp1[2] - n[2] * dp1[1];
  const p1y = n[2] * dp1[0] - n[0] * dp1[2];
  const p1z = n[0] * dp1[1] - n[1] * dp1[0];
  const tx = p2x * duv1[0] + p1x * duv2[0];
  const ty = p2y * duv1[0] + p1y * duv2[0];
  const tz = p2z * duv1[0] + p1z * duv2[0];
  const bx = p2x * duv1[1] + p1x * duv2[1];
  const by = p2y * duv1[1] + p1y * duv2[1];
  const bz = p2z * duv1[1] + p1z * duv2[1];
  const det = duv1[0] * duv2[1] - duv2[0] * duv1[1];
  const handed = det < 0 ? -1 : 1;
  const scale =
    handed / Math.sqrt(Math.max(tx * tx + ty * ty + tz * tz, bx * bx + by * by + bz * bz, 1e-12));
  out[0] = tx * scale;
  out[1] = ty * scale;
  out[2] = tz * scale;
  out[3] = bx * scale;
  out[4] = by * scale;
  out[5] = bz * scale;
  return out;
}
