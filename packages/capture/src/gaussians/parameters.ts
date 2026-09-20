/**
 * What the fit actually steps, and how it becomes what the rasteriser draws.
 *
 * **Two of the six families are not the quantity they stand for.** A scale is held as its
 * logarithm and an opacity as its logit, so that no step can carry either past the end of its own
 * range — a negative standard deviation is not a covariance, and an opacity above one is light
 * from a Gaussian that was never there. Everything downstream works in the real quantities, so
 * this is where the two are made and where the gradients come back through them.
 *
 * **The chain back is one multiplication each and is nearly invisible to Adam**, which divides a
 * step by the size of its own gradients and so cannot see a positive factor applied to every one
 * of them. That is exactly why it is tested here by its own arithmetic rather than through a fit:
 * a fit descends about as well with the factor missing, and the gradient is still wrong.
 */
import { exactExp, exactLog } from '@driftengine/core';
import type { SplatSource } from '@driftengine/splats';

import { createFamily, type Family } from './adam.ts';
import { SCREEN_GRADIENTS, type GaussianGradients } from './gradients.ts';
import { SH1_COEFFICIENTS } from './harmonics.ts';
import type { GaussianSet } from './project.ts';
import type { RefineCloud } from './refine.ts';

/*
 * The step sizes, as fractions of each family's own scale — which is what Adam makes them. They are
 * the reference implementation's, and they are *decisions*: a fit that comes out soft wants the
 * position rate lower and the opacity rate higher, and no test here asserts any of them.
 *
 * **The position rate is the one in real units**, so it is a fraction of the scene rather than a
 * number: the same fit of a room and of a tabletop wants the same *relative* step.
 */
const POSITION_RATE = 1.6e-4;
const SCALE_RATE = 5e-3;
const ROTATION_RATE = 1e-3;
const COLOUR_RATE = 2.5e-3;
/** The band moves at a twentieth of the constant term, as the reference has it. */
const SH1_RATE = COLOUR_RATE / 20;
const OPACITY_RATE = 5e-2;

/** Where a Gaussian starts: faint enough that the fit adds light rather than removing it. */
const INITIAL_OPACITY = 0.1;
/** A Gaussian wider than this fraction of the scene is split rather than cloned. */
export const SPLIT_FRACTION = 0.01;

/** The families, and the scratch the refinement rewrites them through. */
export interface Cloud extends RefineCloud {
  readonly colors: Family;
  readonly sh1: Family | null;
  readonly logits: Family;
  readonly scales: Float64Array;
  readonly budget: number;
}

export function createCloud(budget: number, extent: number, viewDependent: boolean): Cloud {
  const positions = createFamily(3, POSITION_RATE * extent, budget);
  const logScales = createFamily(3, SCALE_RATE, budget);
  const rotations = createFamily(4, ROTATION_RATE, budget);
  const colors = createFamily(3, COLOUR_RATE, budget);
  const sh1 = viewDependent ? createFamily(SH1_COEFFICIENTS, SH1_RATE, budget) : null;
  const logits = createFamily(1, OPACITY_RATE, budget);
  const families = [positions, logScales, rotations, colors, logits];
  if (sh1 !== null) families.push(sh1);
  return {
    count: 0,
    families,
    positions,
    logScales,
    rotations,
    colors,
    sh1,
    logits,
    scales: new Float64Array(budget * 3),
    opacities: new Float64Array(budget),
    motion: new Float64Array(budget),
    sources: new Int32Array(budget),
    reverse: new Int32Array(budget),
    fresh: new Uint8Array(budget),
    scratch: new Float64Array(budget * SH1_COEFFICIENTS),
    budget,
  };
}

/** Every seed as one grey, faint, round Gaussian pointing the way the world does. */
export function start(cloud: Cloud, seeds: Float64Array, count: number, scale: number): void {
  if (!(scale > 0)) {
    throw new RangeError('capture: a fit needs a starting scale, and a single seed has no spacing');
  }
  const logScale = exactLog(scale);
  const logit = exactLog(INITIAL_OPACITY / (1 - INITIAL_OPACITY));
  for (let at = 0; at < count; at += 1) {
    for (let c = 0; c < 3; c += 1) {
      cloud.positions.values[at * 3 + c] = seeds[at * 3 + c] as number;
      cloud.logScales.values[at * 3 + c] = logScale;
      cloud.colors.values[at * 3 + c] = 0.5;
    }
    cloud.rotations.values[at * 4 + 3] = 1;
    cloud.logits.values[at] = logit;
  }
  cloud.count = count;
}

/** The transformed parameters as the rasteriser wants them: real scales and real opacities. */
export function materialise(cloud: Cloud): void {
  for (let at = 0; at < cloud.count; at += 1) {
    for (let c = 0; c < 3; c += 1) {
      cloud.scales[at * 3 + c] = exactExp(cloud.logScales.values[at * 3 + c] as number);
    }
    cloud.opacities[at] = 1 / (1 + exactExp(-(cloud.logits.values[at] as number)));
  }
}

/** One `GaussianSet` over the cloud's own arrays, whose `count` moves as the cloud does. */
export function viewOf(cloud: Cloud, budget: number): GaussianSet {
  const set: GaussianSet = {
    count: 0,
    positions: cloud.positions.values,
    scales: cloud.scales,
    rotations: cloud.rotations.values,
    colors: cloud.colors.values,
    opacities: cloud.opacities,
  };
  return cloud.sh1 === null ? set : { ...set, sh1: cloud.sh1.values.subarray(0, budget * 9) };
}

export function clear(gradients: GaussianGradients, count: number): void {
  gradients.positions.fill(0, 0, count * 3);
  gradients.scales.fill(0, 0, count * 3);
  gradients.rotations.fill(0, 0, count * 4);
  gradients.colors.fill(0, 0, count * 3);
  gradients.sh1.fill(0, 0, count * SH1_COEFFICIENTS);
  gradients.screen.fill(0, 0, count * SCREEN_GRADIENTS);
  gradients.opacities.fill(0, 0, count);
}

/**
 * The render's gradients onto the parameters that are actually stepped.
 *
 * Position, rotation, colour and the band are themselves; a scale arrives as a derivative by the
 * metre and is wanted by the logarithm, which is one factor of the scale; an opacity arrives by the
 * proportion and is wanted by the logit, which is the logistic's own derivative. **This is also
 * where each Gaussian's pull is recorded** — how hard the frames are asking it to move, which is
 * what the refinement grows the busiest of.
 */
export function chain(cloud: Cloud, gradients: GaussianGradients): void {
  for (let at = 0; at < cloud.count; at += 1) {
    let pull = 0;
    for (let c = 0; c < 3; c += 1) {
      const move = gradients.positions[at * 3 + c] as number;
      cloud.positions.gradient[at * 3 + c] = move;
      pull += move * move;
      cloud.logScales.gradient[at * 3 + c] =
        (gradients.scales[at * 3 + c] as number) * (cloud.scales[at * 3 + c] as number);
      cloud.colors.gradient[at * 3 + c] = gradients.colors[at * 3 + c] as number;
    }
    cloud.motion[at] = (cloud.motion[at] as number) + Math.sqrt(pull);
    for (let c = 0; c < 4; c += 1) {
      cloud.rotations.gradient[at * 4 + c] = gradients.rotations[at * 4 + c] as number;
    }
    const opacity = cloud.opacities[at] as number;
    cloud.logits.gradient[at] = (gradients.opacities[at] as number) * opacity * (1 - opacity);
    if (cloud.sh1 === null) continue;
    for (let c = 0; c < SH1_COEFFICIENTS; c += 1) {
      cloud.sh1.gradient[at * SH1_COEFFICIENTS + c] = gradients.sh1[
        at * SH1_COEFFICIENTS + c
      ] as number;
    }
  }
}

/** The fitted cloud as a capture: single precision, cut to what it holds. */
export function harvest(cloud: Cloud): SplatSource {
  const { count } = cloud;
  const source: SplatSource = {
    count,
    positions: Float32Array.from(cloud.positions.values.subarray(0, count * 3)),
    scales: Float32Array.from(cloud.scales.subarray(0, count * 3)),
    rotations: Float32Array.from(cloud.rotations.values.subarray(0, count * 4)),
    colors: Float32Array.from(cloud.colors.values.subarray(0, count * 3)),
    opacities: Float32Array.from(cloud.opacities.subarray(0, count)),
  };
  if (cloud.sh1 === null) return source;
  return {
    ...source,
    sh1: Float32Array.from(cloud.sh1.values.subarray(0, count * SH1_COEFFICIENTS)),
  };
}
