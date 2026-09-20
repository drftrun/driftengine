/**
 * Which clusters are worth rasterising: the three tests, in the order that makes them cheap.
 *
 * Frustum first, because it is six dot products and throws away most of a world. Then the normal
 * cone, which is one more dot product and throws away roughly half of what is left on a closed
 * surface. Then the hierarchical depth buffer, which costs a projection and four texel reads and
 * is the only one that needs anything from this frame.
 *
 * **Every one of them is conservative in the same direction.** A cluster that might be visible
 * survives; only a cluster that provably cannot be seen is dropped. Culling something visible is a
 * hole in the picture that comes and goes with the camera and is diagnosed as almost anything
 * else; keeping something invisible is a wasted draw. `frustum.ts` says the same in its own words
 * and the two files have to agree about it, because a pipeline whose stages disagree about which
 * way to round is one that drops geometry at exactly the boundaries.
 *
 * **The compaction is here and the flags are the device's.** A dispatch can decide every cluster
 * in parallel and cannot append them in order without a prefix sum, so the shader writes one flag
 * per cluster and this writes the ordered list from the flags. That split is also what
 * `scripts/gpu-parity.mjs` compares: the flags are order-free, so they can be checked
 * element-by-element against a reference that has not had to reproduce an atomic's arrival order.
 */

import { sphereOutsideFrustum } from './frustum.ts';
import { hzbOccluded } from './hzb.ts';

/** Eight floats a cluster: centre, radius, cone axis, cone cutoff. `clusterUpload.ts` packs them. */
export const CLUSTER_CULL_FLOATS = 8;

/** What a kept cluster's flag holds. One rather than a bit mask: there is one reason to keep. */
export const CLUSTER_KEEP = 1;

/** A depth pyramid as a dispatch binds it: one flat buffer, one offset a level. */
export interface ClusterHzb {
  /** Every level's texels, coarsest last, as `hzbReduce` leaves them. */
  readonly depths: Float32Array;
  /** Where each level starts in `depths`. Its length is the level count. */
  readonly offsets: Int32Array;
  /** The base level's dimensions. Every level below is halved, never past one. */
  readonly width: number;
  readonly height: number;
  /** The camera the pyramid was built with, which is this frame's in a two-phase pass. */
  readonly viewProj: Float32Array;
}

/**
 * A cluster's cone as it is carried, turned into the cutoff `coneBackfacing` reads.
 *
 * **A cluster carries a cosine and this test is written in a sine**, and until 2026-09-18 nothing
 * said so. `buildClusters` writes "the minimum dot product of any face normal against the axis",
 * the `MSHL` container stores that and says so, and `ClusterSource` passed it through to the test
 * below untouched. Every cluster before then was a single quad or a near-flat patch, whose cosine
 * of about one reads as a sine of one — a hemisphere, never culled — so the mismatch was silent and
 * cone culling simply did not happen. The voxel sandbox grows its clusters by position, across
 * every direction a block faces: a cosine of zero read as a sine of zero is a flat cluster, and a
 * canopy seen from below lost every block whose cluster pointed up.
 *
 * `cos(a)` at or above zero is `sin(a) = sqrt(1 - cos(a)^2)`. Below zero the cone is wider than a
 * hemisphere and no aim of the eye sees every face from behind, so the answer is one, which the
 * test can never satisfy. Converted where a cluster is packed, once, so neither shader nor
 * reference changes.
 */
export function cullCutoff(minimumDot: number): number {
  if (minimumDot < 0) return 1;
  return Math.sqrt(Math.max(0, 1 - minimumDot * minimumDot));
}

/**
 * Whether every triangle in a cluster faces away from the eye.
 *
 * **`cutoff` is `sin(a)`**, where `a` is the half-angle of the cone containing every normal. Zero
 * is a flat cluster; one is a cluster whose normals span a hemisphere, which can never be culled
 * because the test below cannot be satisfied. Stating it as a sine rather than a cosine is what
 * makes the expression a single comparison with no trigonometry in the shader.
 *
 * The derivation, because the constant is otherwise unfalsifiable. Let `d` be the vector from the
 * eye to the cluster's centre. Directions from the eye to points on the cluster lie within
 * `b = asin(radius / |d|)` of `d`. A triangle is backfacing when its normal has a positive dot
 * with the direction the eye looks along it, so *every* triangle is backfacing when
 * `angle(axis, d) + a + b < 90 degrees`, which is `dot(axis, normalise(d)) > sin(a + b)`.
 * Expanding `sin(a + b)` to `sin a + radius / |d|` is exact at `a = 0` and errs on the side of
 * keeping a cluster everywhere else, which is the direction this file rounds.
 *
 * Multiplied through by `|d|` so there is no divide and no normalise.
 */
export function coneBackfacing(
  axisX: number,
  axisY: number,
  axisZ: number,
  cutoff: number,
  centreX: number,
  centreY: number,
  centreZ: number,
  radius: number,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
): boolean {
  const dx = centreX - eyeX;
  const dy = centreY - eyeY;
  const dz = centreZ - eyeZ;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return dx * axisX + dy * axisY + dz * axisZ >= cutoff * distance + radius;
}

/**
 * The screen rectangle a sphere covers and the nearest clip depth it reaches.
 *
 * Writes `minX, minY, maxX, maxY, nearestDepth` into `out`, in the [0, 1] range a texture
 * coordinate uses, and answers **false when the sphere has no rectangle at all** — when any part
 * of it is at or behind the eye. That case is the reason this returns a boolean rather than
 * clamping: a sphere straddling the near plane does not project to a rectangle, and every
 * implementation that pretends it does culls it on the frames where the wrap happens to land
 * outside the screen and keeps it on the frames where it does not. What that looks like is
 * geometry flickering as the camera moves through it, which is the defect this function's shape
 * exists to prevent.
 *
 * The eight corners of the sphere's bounding box rather than an analytic silhouette: the box is
 * larger than the sphere, so the rectangle is conservative, and it is eight transforms instead of
 * a quadratic.
 */
export function sphereScreenBounds(
  viewProj: Float32Array,
  centreX: number,
  centreY: number,
  centreZ: number,
  radius: number,
  out: Float32Array,
): boolean {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let nearest = Number.NEGATIVE_INFINITY;

  for (let corner = 0; corner < 8; corner += 1) {
    const x = centreX + (corner & 1 ? radius : -radius);
    const y = centreY + (corner & 2 ? radius : -radius);
    const z = centreZ + (corner & 4 ? radius : -radius);
    const cw =
      (viewProj[3] as number) * x +
      (viewProj[7] as number) * y +
      (viewProj[11] as number) * z +
      (viewProj[15] as number);
    /* At or behind the eye, so there is no rectangle. See the header. */
    if (cw <= 1e-6) return false;
    const cx =
      (viewProj[0] as number) * x +
      (viewProj[4] as number) * y +
      (viewProj[8] as number) * z +
      (viewProj[12] as number);
    const cy =
      (viewProj[1] as number) * x +
      (viewProj[5] as number) * y +
      (viewProj[9] as number) * z +
      (viewProj[13] as number);
    const cz =
      (viewProj[2] as number) * x +
      (viewProj[6] as number) * y +
      (viewProj[10] as number) * z +
      (viewProj[14] as number);
    const inverse = 1 / cw;
    const u = cx * inverse * 0.5 + 0.5;
    const v = cy * inverse * 0.5 + 0.5;
    minX = Math.min(minX, u);
    maxX = Math.max(maxX, u);
    minY = Math.min(minY, v);
    maxY = Math.max(maxY, v);
    /* Nearest is the *largest* clip depth here; `depthConvention.ts` puts the near plane at 1. */
    nearest = Math.max(nearest, cz * inverse);
  }

  out[0] = minX;
  out[1] = minY;
  out[2] = maxX;
  out[3] = maxY;
  out[4] = nearest;
  return true;
}

/**
 * The pyramid level whose texels are wide enough that four of them cover the rectangle.
 *
 * `ceil(log2(longest side in texels))` minus one, floored at zero: at that level the rectangle
 * spans at most two texels each way, which is what a four-texel gather reads. One level coarser
 * would read a texel covering geometry outside the rectangle and cull against an occluder that is
 * not in front of this cluster at all.
 *
 * Clamped to the top of the pyramid, because a rectangle larger than the screen is a cluster the
 * camera is inside and there is no level coarse enough for it.
 */
export function hzbLevelFor(
  rectWidthTexels: number,
  rectHeightTexels: number,
  width: number,
  height: number,
): number {
  const longest = Math.max(rectWidthTexels, rectHeightTexels, 1);
  const level = Math.max(0, Math.ceil(Math.log2(longest)) - 1);
  const top = Math.floor(Math.log2(Math.max(1, Math.max(width, height))));
  return Math.min(level, top);
}

/**
 * Whether a rectangle's nearest depth is behind everything already drawn under it.
 *
 * **The weakest of the four texels decides.** Each holds the furthest depth in its own region, so
 * a cluster is hidden only where it is behind *all* of them — and under reversed-Z the furthest of
 * four is the smallest. Taking the nearest instead would cull a cluster visible through a gap,
 * which is the failure mode that reads as holes appearing in geometry as the camera turns.
 */
export function clusterOccluded(
  depths: Float32Array,
  offsets: Int32Array,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  nearestDepth: number,
): boolean {
  const level = hzbLevelFor((maxX - minX) * width, (maxY - minY) * height, width, height);
  if (level >= offsets.length) return false;
  const levelWidth = Math.max(1, width >> level);
  const levelHeight = Math.max(1, height >> level);
  const base = offsets[level] as number;

  const x0 = Math.max(0, Math.min(levelWidth - 1, Math.floor(minX * levelWidth)));
  const x1 = Math.max(0, Math.min(levelWidth - 1, Math.floor(maxX * levelWidth)));
  /*
   * **The rows run the other way, and the swap is not cosmetic.** `sphereScreenBounds` reports the
   * rectangle in clip-up coordinates — `v` of 1 is clip `y` of +1 — and the pyramid is seeded
   * straight from the depth texture, whose row 0 is exactly there. So a `v` used as a row index
   * reads the mirror of what the cluster covers, and the top edge of the rectangle becomes the
   * bottom row.
   *
   * It shipped that way and drew holes: geometry near the top of the frame tested against whatever
   * stood near the bottom, coming and going with the camera. `gpu-parity.mjs` agreed about it for
   * as long, because the WGSL made the same mistake — a parity check compares two implementations
   * and neither of them is the truth.
   */
  const y0 = Math.max(0, Math.min(levelHeight - 1, Math.floor((1 - maxY) * levelHeight)));
  const y1 = Math.max(0, Math.min(levelHeight - 1, Math.floor((1 - minY) * levelHeight)));

  let furthest = Number.POSITIVE_INFINITY;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      furthest = Math.min(furthest, depths[base + y * levelWidth + x] as number);
    }
  }
  return hzbOccluded(nearestDepth, furthest);
}

/**
 * Every test, over every cluster: one flag each, and the kept indices in input order.
 *
 * `selected`, where given, is the cut's flag a cluster: a cluster it did not select is not tested
 * and not kept, which is how an instance cull reaches the clusters of a mesh it hid. Absent, every
 * cluster is judged.
 *
 * `hzb` is null in the first phase of a two-phase pass, where there is no depth from this frame to
 * test against yet — and null rather than an empty pyramid, because an empty one is a pyramid full
 * of zeroes and under reversed-Z zero is the far plane, which occludes nothing and would look like
 * the test running when it is not.
 *
 * Returns how many survived, which is also what an indirect draw's instance count wants.
 */
export function cullClusters(
  clusters: Float32Array,
  planes: Float32Array,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  hzb: ClusterHzb | null,
  keep: Uint32Array,
  list: Uint32Array,
  selected: ArrayLike<number> | null = null,
  /** False for the blended run, whose raster draws both sides. See `CULL_CONES`. */
  cones = true,
): number {
  const bounds = new Float32Array(5);
  const count = Math.floor(clusters.length / CLUSTER_CULL_FLOATS);
  let kept = 0;

  for (let i = 0; i < count; i += 1) {
    if (selected !== null && selected[i] === 0) {
      keep[i] = 0;
      continue;
    }
    const at = i * CLUSTER_CULL_FLOATS;
    const cx = clusters[at] as number;
    const cy = clusters[at + 1] as number;
    const cz = clusters[at + 2] as number;
    const radius = clusters[at + 3] as number;

    let survives = !sphereOutsideFrustum(planes, cx, cy, cz, radius);
    if (survives && cones) {
      survives = !coneBackfacing(
        clusters[at + 4] as number,
        clusters[at + 5] as number,
        clusters[at + 6] as number,
        clusters[at + 7] as number,
        cx,
        cy,
        cz,
        radius,
        eyeX,
        eyeY,
        eyeZ,
      );
    }
    if (survives && hzb !== null && sphereScreenBounds(hzb.viewProj, cx, cy, cz, radius, bounds)) {
      survives = !clusterOccluded(
        hzb.depths,
        hzb.offsets,
        hzb.width,
        hzb.height,
        bounds[0] as number,
        bounds[1] as number,
        bounds[2] as number,
        bounds[3] as number,
        bounds[4] as number,
      );
    }

    keep[i] = survives ? CLUSTER_KEEP : 0;
    if (survives) {
      list[kept] = i;
      kept += 1;
    }
  }
  return kept;
}
