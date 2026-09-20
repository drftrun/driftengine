/**
 * Whether a pixel's history is the same surface, as a weight from one to zero.
 *
 * **What is compared.** The camera moved, so this frame's depth and last frame's are depths from two
 * eyes. The resolve compares the depth this surface *should* have had last frame — the w of its
 * reprojected position, which is a view depth — with the view depth last frame actually held where it
 * lands. Equal, and it is the same surface; different, and something else was there: a pixel that was
 * hidden last frame would otherwise take its colour from whatever was in front of it.
 *
 * **Relative, and forgiving in proportion to the motion.** A tenth of a unit is nothing at a hundred
 * units and everything at one. And a depth read at a reprojected position under fast motion comes from
 * a different part of a texel than the one it stands for, which at a grazing angle is a different
 * depth; the tolerance grows with the motion's length.
 *
 * **Normals, for the case depth cannot see.** A leaf's two sides are at one depth, and the history of
 * the front is not the back. The forward frame has no normal buffer, so both normals come from their
 * frame's depth — `worldPositionFromDepth` and `normalFromPositions` — in world space, where the two
 * frames agree.
 *
 * **Continuous in every input**, because a step is a line on screen along which the history is kept on
 * one frame and dropped on the next: every threshold is a smoothstep, never a comparison.
 *
 * Anything that is not a number, a depth that is not positive — which is what the resolve passes
 * where the reprojection left the screen — and a negative motion length all trust nothing.
 */

export interface DisocclusionParams {
  /** The relative depth disagreement trusted fully; trust falls to zero at twice it. */
  readonly depthTolerance: number;
  /** How much the tolerance grows per unit of motion, in uv. */
  readonly motionScale: number;
  /** The cosine between the two normals at and below which nothing is trusted. */
  readonly normalFloor: number;
  /** The cosine at and above which the normals are trusted fully. */
  readonly normalCeiling: number;
}

/**
 * A percent of depth, growing by half a percent for every hundredth of the screen the surface moved;
 * normals trusted fully within sixty degrees and not at all past ninety.
 */
export const DEFAULT_DISOCCLUSION: DisocclusionParams = {
  depthTolerance: 0.01,
  motionScale: 0.5,
  normalFloor: 0,
  normalCeiling: 0.5,
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One where the history is trustworthy, zero where it is not, and continuous between.
 *
 * `currDepth` is the view depth this surface should have had last frame; `histDepth` the view depth
 * last frame held where it lands, or zero where it landed off the screen; `motionLength` the motion's
 * length in uv; `normalDot` the cosine between the two frames' world normals there.
 */
export function disocclusionWeight(
  currDepth: number,
  histDepth: number,
  motionLength: number,
  normalDot: number,
  params: DisocclusionParams,
): number {
  if (!(currDepth > 0) || !(histDepth > 0) || !(motionLength >= 0) || Number.isNaN(normalDot)) {
    return 0;
  }
  const disagreement = Math.abs(currDepth - histDepth) / currDepth;
  const tolerance = params.depthTolerance + params.motionScale * motionLength;
  const depth = 1 - smoothstep(tolerance, 2 * tolerance, disagreement);
  const normal = smoothstep(params.normalFloor, params.normalCeiling, normalDot);
  return depth * normal;
}

/**
 * The world position a depth stands for: `(u, v, clipDepth)` through the inverse view-projection,
 * in whatever depth convention that matrix was built for. Returns false where the matrix has no
 * answer there — singular, or the point at infinity.
 */
export function worldPositionFromDepth(
  inverseViewProj: ArrayLike<number>,
  u: number,
  v: number,
  clipDepth: number,
  out: Float64Array,
): boolean {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const m = inverseViewProj;
  const w =
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * clipDepth + (m[15] as number);
  if (!(Math.abs(w) > 1e-12)) return false;
  for (let r = 0; r < 3; r += 1) {
    out[r] =
      ((m[r] as number) * x +
        (m[4 + r] as number) * y +
        (m[8 + r] as number) * clipDepth +
        (m[12 + r] as number)) /
      w;
  }
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
}

/**
 * The unit normal of the surface through `centre` and its two screen neighbours, turned to face
 * `eye` — so the answer is the same whichever way the target's rows run. Returns false where the
 * three are in a line: there is no surface to have a normal.
 */
export function normalFromPositions(
  centre: ArrayLike<number>,
  right: ArrayLike<number>,
  up: ArrayLike<number>,
  eye: ArrayLike<number>,
  out: Float64Array,
): boolean {
  const ax = (right[0] as number) - (centre[0] as number);
  const ay = (right[1] as number) - (centre[1] as number);
  const az = (right[2] as number) - (centre[2] as number);
  const bx = (up[0] as number) - (centre[0] as number);
  const by = (up[1] as number) - (centre[1] as number);
  const bz = (up[2] as number) - (centre[2] as number);
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const length2 = nx * nx + ny * ny + nz * nz;
  const scale2 = (ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz);
  if (!(length2 > 1e-12 * scale2)) return false;
  const toEye =
    nx * ((eye[0] as number) - (centre[0] as number)) +
    ny * ((eye[1] as number) - (centre[1] as number)) +
    nz * ((eye[2] as number) - (centre[2] as number));
  const inverse = (toEye < 0 ? -1 : 1) / Math.sqrt(length2);
  nx *= inverse;
  ny *= inverse;
  nz *= inverse;
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  return true;
}
