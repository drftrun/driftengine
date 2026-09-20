/**
 * How far away a cloud of Gaussians is, a pixel at a time.
 *
 * **A splat cloud has no surface**, so there is no depth to read off it the way a triangle
 * rasteriser reads one. What it has is light arriving from a sequence of overlapping blobs, and the
 * honest answer is where that light came from: each splat's own depth, weighted by how much of the
 * pixel it actually contributed. A nearly opaque splat in front takes almost all of the weight, so
 * the answer is its depth; a thin haze in front of a wall averages towards the wall.
 *
 * **The coverage is answered beside it, and callers need both.** At a silhouette a cloud thins out
 * and a pixel may be a tenth covered — a depth averaged out of a tenth of a pixel's light is not a
 * measurement of anything, and a fusion that treated it as one would carve the silhouette into the
 * volume. So this answers how much light arrived as well, and the fusion weights by it rather than
 * choosing a cutoff here on the caller's behalf.
 *
 * **Depth along the camera's own axis, not along the ray.** That is what a projection's `z` is and
 * what `fuseDepth` compares a voxel against; a radial distance would be a different quantity with
 * the same name, which is the kind of mistake that reads as a scene slightly the wrong shape.
 */
import { exactExp } from '@driftengine/core';

import {
  visibleGaussians,
  type GaussianSet,
  type Projected,
  type RasterCamera,
} from './project.ts';

/** Below this a Gaussian contributes less than a quarter of a value of an eight-bit channel. */
const FAINT = 1 / 255 / 4;

/**
 * The cloud's depth and coverage, one of each per pixel.
 *
 * A pixel no light reached is left at zero in both, which is a coverage of nothing rather than a
 * surface at the camera — a caller reading the depth alone would find a wall in front of its face.
 */
export function renderDepth(
  set: GaussianSet,
  camera: RasterCamera,
  depth: Float32Array,
  coverage: Float32Array,
): void {
  const { width, height } = camera;
  depth.fill(0);
  coverage.fill(0);
  const pixels = width * height;
  const transmittance = new Float64Array(pixels).fill(1);
  const weighted = new Float64Array(pixels);
  const { order, projected } = visibleGaussians(set, camera);

  for (const at of order) {
    const one = projected[at] as Projected;
    const determinant = one.a * one.d - one.b * one.b;
    const inverse = [one.d / determinant, -one.b / determinant, one.a / determinant];
    const left = Math.max(0, Math.floor(one.x - one.radius));
    const right = Math.min(width - 1, Math.ceil(one.x + one.radius));
    const top = Math.max(0, Math.floor(one.y - one.radius));
    const bottom = Math.min(height - 1, Math.ceil(one.y + one.radius));
    const opacity = set.opacities[at] as number;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - one.x;
        const dy = y + 0.5 - one.y;
        const power =
          -0.5 *
          ((inverse[0] as number) * dx * dx +
            2 * (inverse[1] as number) * dx * dy +
            (inverse[2] as number) * dy * dy);
        const alpha = opacity * exactExp(power);
        if (alpha < FAINT) continue;
        const pixel = y * width + x;
        const share = alpha * (transmittance[pixel] as number);
        weighted[pixel] = (weighted[pixel] as number) + share * one.depth;
        coverage[pixel] = (coverage[pixel] as number) + share;
        transmittance[pixel] = (transmittance[pixel] as number) * (1 - alpha);
      }
    }
  }

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const covered = coverage[pixel] as number;
    /* Divided by the light that arrived rather than by one: a half-covered pixel is still at the
       depth of what covered it, and the caller is told how much that was. */
    if (covered > 0) depth[pixel] = (weighted[pixel] as number) / covered;
  }
}
