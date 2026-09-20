/** Filtering indirect light without smearing it across an edge or losing any of it. */

import { clipToNeighbourhood } from '../temporalAa.ts';

import type { Rgb } from '../temporalAa.ts';
import type { GiSource } from './chain.ts';

/**
 * **Indirect light arrives noisy, and every way of filtering it can quietly darken the scene.**
 *
 * A handful of rays a pixel is what makes this affordable, and a handful of rays is an estimate
 * with variance. The filter is not a finishing touch — without it the chain is unusable — and the
 * three ways it goes wrong all read as the *lighting* wanting a tuning pass rather than as the
 * filter being wrong: a spatial kernel whose weights do not sum to one darkens every edge, a
 * temporal blend that treats a disocclusion as staleness smears whatever moved, and a blend weight
 * that never settles either oscillates or never reaches the mean it is averaging.
 *
 * **The plan asked this to reuse Wave 3A's reprojection, disocclusion and clamping rather than
 * writing a second temporal filter, and one of those three exists.** `clipToNeighbourhood` is
 * here, tested, and mirrored in `TEMPORAL_RESOLVE_FRAG` — so it is used. The other two do not
 * exist in the tree and Wave 3A creates them, which is why **this module takes them as inputs
 * rather than computing them**: `temporalDenoise` is handed the history a caller reprojected and a
 * flag saying whether it may be trusted. That is the right shape regardless of which wave lands
 * first — a denoiser that owned its own reprojection would be the second answer the plan was
 * warning about — and it means the whole of this is testable and shippable today, with Wave 3A
 * plugging into the two parameters rather than into a rewrite.
 */

/** One frame's worth of what the filter needs, as flat arrays a pass would upload. */
export interface DenoiseFrame {
  /** Three floats a pixel. */
  readonly radiance: Float32Array;
  /** One a pixel, in metres from the eye. A pixel that drew nothing may be `Infinity`. */
  readonly depth: Float32Array;
  /** Three a pixel, unit length. */
  readonly normal: Float32Array;
  /** Which level of the chain answered each pixel. See `filterStepFor`. */
  readonly source: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface SpatialOptions {
  /**
   * Multiplier on the kernel's spacing, in pixels. See `filterStepFor` for what chooses it.
   *
   * **A step rather than a radius**, which is the à-trous arrangement: the same five-tap kernel is
   * run with its taps further apart, so a wide filter costs what a narrow one costs. A radius
   * would cost its own square.
   */
  readonly step: number;
  /**
   * How far apart in depth two pixels may be and still share light, as a fraction of their depth.
   *
   * **Relative rather than absolute**, because a centimetre is a discontinuity across a desk and
   * nothing at all across a valley. A tenth is wide enough to keep a surface tilted away from the
   * camera together and narrow enough to find the edge of the thing standing on it.
   */
  readonly depthTolerance?: number;
  /** The exponent on `max(dot(n, n'), 0)`. Higher keeps the filter inside one face. */
  readonly normalSharpness?: number;
}

const DEFAULT_DEPTH_TOLERANCE = 0.1;
const DEFAULT_NORMAL_SHARPNESS = 32;

/**
 * The five-tap row, which is the kernel a separable à-trous pass runs twice.
 *
 * `[1, 4, 6, 4, 1] / 16`, a binomial — the discrete Gaussian, and the one every implementation of
 * this uses. It is written here rather than computed so a reader can see that it is symmetric and
 * that it sums to one *before* any of the edge-stopping weights touch it.
 */
const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

/**
 * How far apart the taps go, for light that came from each level of the chain.
 *
 * **Task 6's `source` discriminant is what this is for**, and it is the reason that field is on
 * `IndirectResult` at all. A sample the screen answered is as sharp as the frame it came from and
 * wants the narrowest filter there is. One the world field answered stands for a cone's worth of
 * surface. One the probes answered is already an interpolation over metres, and filtering it
 * narrowly buys nothing — its noise is not at pixel scale.
 *
 * Filtering all three at one width either smears the sharp one or leaves the coarse one noisy, and
 * which of those a viewer notices depends on where they are standing.
 */
export function filterStepFor(source: GiSource): number {
  return source === 0 ? 1 : source === 1 ? 2 : 4;
}

/** Scratch, because a filter pass is per pixel and the rule about allocating in one is absolute. */
const TOTAL = new Float32Array(3);
const CLIPPED: Rgb = [0, 0, 0];

/**
 * One separable, edge-stopping pass over a frame.
 *
 * **The weights are renormalised by their own sum, and that is the line this module exists to get
 * right.** A tap rejected for being on the other side of an edge has to be *removed from the
 * average*, not set to zero and left in the denominator — the second darkens every silhouette by
 * however much of its kernel fell off the surface, which looks like contact shadowing and is the
 * filter eating light. `energy.test.ts` makes the same argument about the probe blend one level up.
 */
export function spatialDenoise(
  frame: DenoiseFrame,
  options: SpatialOptions,
  out: Float32Array,
): void {
  const depthTolerance = options.depthTolerance ?? DEFAULT_DEPTH_TOLERANCE;
  const normalSharpness = options.normalSharpness ?? DEFAULT_NORMAL_SHARPNESS;

  /* Horizontal into `out`, then vertical in place. Separable, so a five-tap kernel is ten taps
     rather than twenty-five, and the two halves cannot disagree because they are one function. */
  pass(frame, frame.radiance, out, options.step, depthTolerance, normalSharpness, true);
  pass(frame, out, out, options.step, depthTolerance, normalSharpness, false);
}

function pass(
  frame: DenoiseFrame,
  input: Float32Array,
  out: Float32Array,
  step: number,
  depthTolerance: number,
  normalSharpness: number,
  horizontal: boolean,
): void {
  const { width, height, depth, normal, source } = frame;
  /*
   * A second pass reading its own output would filter the taps it has already written, which is a
   * wider and lopsided kernel rather than the one declared. Copied when the two alias.
   */
  const read = input === out ? new Float32Array(out) : input;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const centreDepth = depth[at] as number;
      const nx = normal[at * 3] as number;
      const ny = normal[at * 3 + 1] as number;
      const nz = normal[at * 3 + 2] as number;
      const spacing = Math.max(1, Math.round(step * filterStepFor(source[at] as GiSource)));

      TOTAL.fill(0);
      let weightSum = 0;
      for (let tap = 0; tap < KERNEL.length; tap++) {
        const offset = (tap - 2) * spacing;
        const sx = horizontal ? x + offset : x;
        const sy = horizontal ? y : y + offset;
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const from = sy * width + sx;

        /* A pixel that drew nothing has no surface to share light with. */
        const tapDepth = depth[from] as number;
        if (!Number.isFinite(tapDepth) || !Number.isFinite(centreDepth)) {
          if (from !== at) continue;
        }

        const reference = Math.max(Math.abs(centreDepth), 1e-3);
        const apart = Math.abs(tapDepth - centreDepth) / reference;
        if (apart > depthTolerance) continue;

        const alignment =
          nx * (normal[from * 3] as number) +
          ny * (normal[from * 3 + 1] as number) +
          nz * (normal[from * 3 + 2] as number);
        const facing = Math.max(alignment, 0) ** normalSharpness;
        if (facing <= 1e-6) continue;

        const weight = (KERNEL[tap] as number) * facing;
        TOTAL[0] = (TOTAL[0] as number) + (read[from * 3] as number) * weight;
        TOTAL[1] = (TOTAL[1] as number) + (read[from * 3 + 1] as number) * weight;
        TOTAL[2] = (TOTAL[2] as number) + (read[from * 3 + 2] as number) * weight;
        weightSum += weight;
      }

      if (weightSum > 0) {
        out[at * 3] = (TOTAL[0] as number) / weightSum;
        out[at * 3 + 1] = (TOTAL[1] as number) / weightSum;
        out[at * 3 + 2] = (TOTAL[2] as number) / weightSum;
      } else {
        /* Every neighbour was rejected, including itself: keep what was there rather than black. */
        out[at * 3] = read[at * 3] as number;
        out[at * 3 + 1] = read[at * 3 + 1] as number;
        out[at * 3 + 2] = read[at * 3 + 2] as number;
      }
    }
  }
}

/**
 * The least weight this frame may be given, however long a pixel has been accumulating.
 *
 * **An honest running mean converges and then stops listening.** One over the count is the
 * unbiased average of everything seen, which is exactly what is wanted while a pixel is settling
 * and exactly wrong once the world changes: at ten thousand frames a new value moves the answer by
 * a ten-thousandth, so a light switched on takes minutes to arrive. A twentieth is the floor, which
 * is about a third of a second at sixty frames and is the same order as
 * `TEMPORAL_HISTORY_BLEND`'s own one-tenth.
 */
export const DENOISE_MIN_ALPHA = 0.05;

/** What a pixel carries between frames. The caller owns one per pixel. */
export interface TemporalPixel {
  /** The accumulated answer. */
  readonly value: Float32Array;
  /** How many frames have contributed since the last disocclusion. */
  samples: number;
}

export function newTemporalPixel(): TemporalPixel {
  return { value: new Float32Array(3), samples: 0 };
}

/**
 * Blend this frame into the history a caller reprojected, and answer how much history there is.
 *
 * `history` is where this pixel was last frame, already reprojected — **this module does not do
 * that and is not the place for it.** `disoccluded` says the reprojection landed on something that
 * is no longer there; `neighbourhood`, when supplied, is the box of colours actually around this
 * pixel this frame, and the history is clipped into it by `temporalAa.ts`'s own function.
 *
 * **A disocclusion resets rather than blends.** It is not a stale history, it is a wrong one: a
 * character stepping away from a wall uncovers pixels whose history is the character, and blending
 * nine parts of that is a smear of them that follows them about. Resetting leaves one frame of
 * noise, which the spatial pass has already reduced and which is gone by the next frame.
 */
export function temporalDenoise(
  current: readonly [number, number, number] | Float32Array,
  history: readonly [number, number, number] | Float32Array,
  neighbourhood: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  } | null,
  disoccluded: boolean,
  pixel: TemporalPixel,
  out: Float32Array,
): TemporalPixel {
  if (disoccluded) {
    pixel.samples = 1;
    for (let c = 0; c < 3; c++) {
      pixel.value[c] = current[c] as number;
      out[c] = current[c] as number;
    }
    return pixel;
  }

  let hx = history[0] as number;
  let hy = history[1] as number;
  let hz = history[2] as number;
  if (neighbourhood !== null) {
    clipToNeighbourhood(CLIPPED, [hx, hy, hz], neighbourhood.min, neighbourhood.max);
    hx = CLIPPED[0];
    hy = CLIPPED[1];
    hz = CLIPPED[2];
  }

  /*
   * One over the count while a pixel is settling, so what comes out is the unbiased mean of
   * everything it has seen rather than a blend biased toward whatever it started at — which is the
   * difference between converging *to* the noisy mean and converging near it. The floor is what
   * keeps a settled pixel able to notice the world changing; see `DENOISE_MIN_ALPHA`.
   */
  const samples = pixel.samples + 1;
  const alpha = Math.max(1 / samples, DENOISE_MIN_ALPHA);
  pixel.samples = samples;

  const blended = [hx, hy, hz];
  for (let c = 0; c < 3; c++) {
    const value =
      (blended[c] as number) + ((current[c] as number) - (blended[c] as number)) * alpha;
    pixel.value[c] = value;
    out[c] = value;
  }
  return pixel;
}
