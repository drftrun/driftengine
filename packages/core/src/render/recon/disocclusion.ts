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
 * **And in proportion to the surface's own slope.** A new jitter samples a surface somewhere else, so
 * on one turned from the eye two frames' samples of it differ by up to a texel's worth of its depth
 * with nothing moved. `surfaceSlope` measures that step on the surface's own side of any silhouette.
 *
 * **Normals, for the case depth cannot see.** A leaf's two sides are at one depth, and the history of
 * the front is not the back. The forward frame has no normal buffer, so both normals come from their
 * frame's depth — `worldPositionFromDepth` and `normalFromPositions` — in world space, where the two
 * frames agree. **A normal differenced across an edge is not a normal**, so the caller weighs each by
 * `planarity`: at an edge, a sliver, or anything finer than a texel the depth test decides alone.
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
 * The band over which three texels stop being one plane: how far their two steps in inverse depth
 * fail to cancel, as a share of the two together. None of it is a plane at any angle; all of it is an
 * edge — one side steps, the other does not — or a sliver, both stepping the same way.
 *
 * **A share and not a size**, which is the lesson of the rods in `resolve.test.ts`: a part a
 * hundredth of the depth in front of a wall passes the depth test, and a normal differenced across it
 * still leans by its height over a texel's width — nearly edge-on where texels are small. What would
 * make this wrong is a curved surface judged at its apex, where both steps lean one way and the
 * normal is sound; there it only gives the normals less say, which the depth test does not need.
 */
export const PLANAR_FROM = 0.25;
export const PLANAR_TO = 0.5;

/**
 * How sure it is that `centre` and its neighbours either side along one axis lie on one plane, one to
 * zero. Inverse depth is affine across a plane on screen, so a plane's two steps cancel whatever its
 * angle. One where a neighbour is missing — zero, off the picture or undrawn — or where there is no
 * step to compare: nothing to judge by, so a normal keeps the say it always had.
 */
export function planarity(before: number, centre: number, after: number): number {
  if (!(before > 0) || !(centre > 0) || !(after > 0)) return 1;
  const a = 1 / after - 1 / centre;
  const b = 1 / before - 1 / centre;
  const spread = Math.abs(a) + Math.abs(b);
  if (!(spread > 0)) return 1;
  return 1 - smoothstep(PLANAR_FROM, PLANAR_TO, Math.abs(a + b) / spread);
}

/**
 * How far a surface's depth moves across one texel along an axis, relative to the depth: the smaller
 * of the steps to its two neighbours, because beside a silhouette one of them is the surface behind.
 * Zero at a sliver — nearer or farther than both, so each step is to another surface — and one
 * neighbour's step where only one is there.
 */
export function surfaceSlope(before: number, centre: number, after: number): number {
  const a = after > 0 ? after - centre : Number.NaN;
  const b = before > 0 ? before - centre : Number.NaN;
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : Math.abs(b) / centre;
  if (Number.isNaN(b)) return Math.abs(a) / centre;
  if (a * b > 0) return 0;
  return Math.min(Math.abs(a), Math.abs(b)) / centre;
}

/**
 * One where the history is trustworthy, zero where it is not, and continuous between.
 *
 * `currDepth` is the view depth this surface should have had last frame; `histDepth` the view depth
 * last frame held where it lands, or zero where it landed off the screen; `motionLength` the motion's
 * length in uv; `normalDot` the cosine between the two frames' world normals there; `slope` the
 * surface's `surfaceSlope`, which widens the tolerance one for one.
 */
export function disocclusionWeight(
  currDepth: number,
  histDepth: number,
  motionLength: number,
  normalDot: number,
  params: DisocclusionParams,
  slope = 0,
): number {
  if (!(currDepth > 0) || !(histDepth > 0) || !(motionLength >= 0) || Number.isNaN(normalDot)) {
    return 0;
  }
  const disagreement = Math.abs(currDepth - histDepth) / currDepth;
  const tolerance = params.depthTolerance + params.motionScale * motionLength + slope;
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
