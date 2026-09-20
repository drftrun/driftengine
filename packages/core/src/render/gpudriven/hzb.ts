/**
 * The hierarchical depth buffer, and the one decision in it that is easy to get backwards.
 *
 * A texel of level *n+1* must hold the depth **furthest from the camera** of the four it covers.
 * Taking the nearest culls geometry that is visible, which appears as holes that come and go with
 * camera motion and is diagnosed as almost anything else first.
 *
 * **Under reversed-Z, furthest is the minimum value, not the maximum.** `depthConvention.ts` maps
 * the near plane to 1 and the far plane to 0, so the conventional `max` reduction every published
 * description gives is exactly wrong for this engine. That inversion is the reason this module
 * exists as its own file with this paragraph in it rather than as four lines inside a pass.
 *
 * **An odd level includes its extra row and column rather than dropping them.** Dropping them
 * loses the depth of a strip one texel wide along two edges, and a strip of missing occluder is a
 * strip of geometry culled against nothing — conservative in the wrong direction.
 */

/** How many levels a pyramid over this size has, down to a single texel. */
export function hzbMipCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, Math.max(width, height)))) + 1;
}

/** Dimensions of the level below one of this size: halved, never below one. */
export function hzbMipSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(1, width >> 1), height: Math.max(1, height >> 1) };
}

/**
 * Reduce one level into the next, taking the furthest depth of each group.
 *
 * `out` must hold `hzbMipSize(width, height)` texels. Returns the size written.
 */
export function hzbReduce(
  src: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
): { width: number; height: number } {
  const size = hzbMipSize(width, height);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      /* The extra row and column of an odd level are folded into the last group. See the header. */
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const lastX = x === size.width - 1 ? width - 1 : x1;
      const lastY = y === size.height - 1 ? height - 1 : y1;

      let furthest = Infinity;
      for (let sy = y0; sy <= lastY; sy += 1) {
        for (let sx = x0; sx <= lastX; sx += 1) {
          /* Minimum, because reversed-Z puts the far plane at zero. */
          furthest = Math.min(furthest, src[sy * width + sx] as number);
        }
      }
      out[y * size.width + x] = furthest;
    }
  }
  return size;
}

/**
 * A light's pyramid's base: half its shadow map, each texel the furthest of the group under it,
 * **turned over into the camera's convention.**
 *
 * A shadow map's depth is conventional — near is zero — because the lookup both pipelines share
 * reads it so, and `depthConvention.ts` leaves shadow maps alone. Everything downstream of a
 * pyramid is written for reversed-Z, so this stores `1 - depth`, where the furthest of a group is
 * the smallest value, and from here the light's pyramid is the camera's: `hzbReduce` builds the
 * rest, and the cull reads it through a matrix whose depth is turned over to match. The groups are
 * `hzbReduce`'s, an odd map's extra row and column folded in, and so is the answer — it is
 * `hzbReduce` of the turned-over map, exactly.
 *
 * **Half the map rather than all of it**, because the base level is the one that costs: a whole
 * 2048 map's pyramid would be 22 MB beside the 16 MB of the map itself. `out` holds
 * `hzbMipSize(width, height)` texels; returns that size.
 */
export function shadowPyramidBase(
  depth: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
): { width: number; height: number } {
  const size = hzbMipSize(width, height);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      const lastX = x === size.width - 1 ? width - 1 : Math.min(width - 1, x0 + 1);
      const lastY = y === size.height - 1 ? height - 1 : Math.min(height - 1, y0 + 1);
      let deepest = -Infinity;
      for (let sy = y0; sy <= lastY; sy += 1) {
        for (let sx = x0; sx <= lastX; sx += 1) {
          deepest = Math.max(deepest, depth[sy * width + sx] as number);
        }
      }
      out[y * size.width + x] = 1 - deepest;
    }
  }
  return size;
}

/**
 * Whether a sphere is hidden behind the depth already in the pyramid.
 *
 * `sphereDepth` is the **nearest** clip depth of the sphere, which under reversed-Z is its
 * *largest* value. It is hidden when even that is further away than the occluder depth — again a
 * smaller number here.
 */
export function hzbOccluded(sphereNearestDepth: number, occluderFurthestDepth: number): boolean {
  return sphereNearestDepth < occluderFurthestDepth;
}
