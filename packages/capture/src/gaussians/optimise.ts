/**
 * A cloud of Gaussians fitted to a clip's frames, from a camera path and a sparse start.
 *
 * **The engine already knows how to draw the answer.** What comes out is `@driftengine/splats`'
 * `SplatSource` — the same shape its `.ply` and `.sog` readers produce — so a fitted capture goes
 * through `packSplats` and into a `.drft` beside anything else, and is drawn by the shader this
 * package's rasteriser was written to match.
 *
 * **Two parameters are fitted through a transform, and it is what keeps the fit standing.** A
 * scale is optimised as its logarithm and an opacity as its logit, so neither can be stepped past
 * the end of its own range: a negative standard deviation is a covariance that is not a covariance,
 * and an opacity above one is light arriving from a Gaussian that was never there. The gradients
 * this receives are with respect to the real quantities, and the chain rule back to the transformed
 * ones is one multiplication each.
 *
 * **The frames are linear and carry their own coverage.** A synthetic frame comes out of the
 * rasteriser with both; a photograph has to be decoded from its display transform and given an
 * alpha of one by whoever read it, because a photograph *is* fully covered and saying so is the
 * caller's statement about their clip rather than this module's guess. A masked capture says
 * something narrower with the same field, and the fit needs no further telling.
 */
import type { SplatSource } from '@driftengine/splats';

import { adamStep, createAdamState } from './adam.ts';
import { accumulateGradients, createGradients, imageLoss } from './gradients.ts';
import {
  chain,
  clear,
  createCloud,
  harvest,
  materialise,
  start,
  viewOf,
  SPLIT_FRACTION,
} from './parameters.ts';
import type { RasterCamera } from './project.ts';
import { rasteriseGaussians, type Frame } from './rasterise.ts';
import { refineCloud } from './refine.ts';

export interface OptimiseOptions {
  /** `fx`, `fy`, `cx`, `cy`, shared by every frame, as the path was solved with. */
  readonly intrinsics: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
  /** Three per point: where the fit starts, usually the path's own sparse reconstruction. */
  readonly seeds: Float64Array;
  /** The most Gaussians the answer may carry. */
  readonly budget: number;
  readonly iterations: number;
  /** The engine's seeded generator: the same one twice gives the same capture. */
  readonly random: () => number;
  /**
   * The standard deviation every Gaussian starts at, in metres.
   *
   * Left out, it is the distance from each seed to its nearest neighbour — the spacing of the
   * cloud, which is the size at which the seeds tile what they were sampled from. **A cloud of one
   * seed has no spacing**, and is refused rather than given a number out of the air.
   */
  readonly initialScale?: number;
  /** Fit the degree-1 band as well as the constant term. */
  readonly viewDependent?: boolean;
  /** How often the cloud is grown and pruned. */
  readonly refineEvery?: number;
}

/** How often the cloud is grown and pruned, where the caller does not say. */
const DEFAULT_REFINE_EVERY = 50;

/** A clip fitted to Gaussians. Nothing here is the caller's array; everything is freshly cut. */
export function optimiseGaussians(
  targets: readonly Frame[],
  poses: readonly Float64Array[],
  options: OptimiseOptions,
): SplatSource {
  const { intrinsics, width, height, seeds, budget, iterations, random } = options;
  if (targets.length === 0 || targets.length !== poses.length) {
    throw new RangeError(
      `capture: ${targets.length} frames against ${poses.length} poses, and a fit needs one of each`,
    );
  }
  const seeded = Math.floor(seeds.length / 3);
  if (seeded === 0) throw new RangeError('capture: a fit needs at least one seed to start from');
  if (seeded > budget) {
    throw new RangeError(`capture: ${seeded} seeds do not fit a budget of ${budget} Gaussians`);
  }
  const cameras: RasterCamera[] = poses.map((worldToCamera) => ({
    width,
    height,
    intrinsics,
    worldToCamera,
  }));
  const extent = sceneExtent(seeds, seeded, cameras);
  const scale = options.initialScale ?? seedSpacing(seeds, seeded);

  const cloud = createCloud(budget, extent, options.viewDependent === true);
  start(cloud, seeds, seeded, scale);

  const pixels = width * height * 4;
  const rendered = new Float64Array(pixels);
  const dPixels = new Float64Array(pixels);
  const gradients = createGradients(budget);
  const adam = createAdamState();
  const refineEvery = options.refineEvery ?? DEFAULT_REFINE_EVERY;
  const set = viewOf(cloud, budget);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    materialise(cloud);
    set.count = cloud.count;
    const view = iteration % targets.length;
    rasteriseGaussians(set, cameras[view] as RasterCamera, rendered);
    imageLoss(rendered, targets[view] as Frame, dPixels);
    clear(gradients, cloud.count);
    accumulateGradients(set, cameras[view] as RasterCamera, dPixels, gradients);
    chain(cloud, gradients);
    adamStep(cloud.families, cloud.count, adam);
    /*
     * Grown and pruned between steps, never on the last one: a refinement leaves fresh Gaussians
     * that have taken no step, and a cloud handed back in that state is one the caller is drawing
     * before the fit has looked at it.
     */
    if (iteration + 1 < iterations && (iteration + 1) % refineEvery === 0) {
      materialise(cloud);
      refineCloud(cloud, { budget, splitAbove: SPLIT_FRACTION * extent, random });
    }
  }
  materialise(cloud);
  return harvest(cloud);
}

/**
 * How big the capture is: the radius of the sphere holding the seeds and the cameras.
 *
 * **The cameras are in it deliberately.** A position's step is in metres, so it has to be a
 * fraction of something real, and a seed cloud can be a single point — which has no size of its own
 * and is still a scene, because the cameras looking at it are a distance away.
 */
function sceneExtent(seeds: Float64Array, count: number, cameras: readonly RasterCamera[]): number {
  const points: number[][] = [];
  for (let at = 0; at < count; at += 1) {
    points.push([
      seeds[at * 3] as number,
      seeds[at * 3 + 1] as number,
      seeds[at * 3 + 2] as number,
    ]);
  }
  for (const camera of cameras) {
    const m = camera.worldToCamera;
    const centre = [0, 0, 0];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        centre[c] = (centre[c] as number) - (m[r * 4 + c] as number) * (m[r * 4 + 3] as number);
      }
    }
    points.push(centre);
  }
  const middle = [0, 0, 0];
  for (const point of points) {
    for (let c = 0; c < 3; c += 1) middle[c] = (middle[c] as number) + (point[c] as number);
  }
  for (let c = 0; c < 3; c += 1) middle[c] = (middle[c] as number) / points.length;
  let furthest = 0;
  for (const point of points) {
    let square = 0;
    for (let c = 0; c < 3; c += 1) {
      const off = (point[c] as number) - (middle[c] as number);
      square += off * off;
    }
    furthest = square > furthest ? square : furthest;
  }
  return Math.sqrt(furthest);
}

/** The mean distance from a seed to its nearest neighbour: the spacing the cloud was sampled at. */
function seedSpacing(seeds: Float64Array, count: number): number {
  if (count < 2) return 0;
  let total = 0;
  for (let at = 0; at < count; at += 1) {
    let nearest = Infinity;
    for (let other = 0; other < count; other += 1) {
      if (other === at) continue;
      let square = 0;
      for (let c = 0; c < 3; c += 1) {
        const off = (seeds[at * 3 + c] as number) - (seeds[other * 3 + c] as number);
        square += off * off;
      }
      if (square < nearest) nearest = square;
    }
    total += Math.sqrt(nearest);
  }
  return total / count;
}
