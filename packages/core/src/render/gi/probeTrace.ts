/**
 * What a probe asks the indirect chain, and what it does with the answers.
 *
 * **A probe's measurement is an octahedral irradiance map**, because that is what the shading
 * already samples: `gridIrradiance` in `shaders/flat/probeGrid.ts` blends eight probes and reads
 * each through `probeIrradiance(dir, layer)`. So nothing downstream of a probe changes — only where
 * the numbers in that map came from. Today they come from six rasterised faces of the world;
 * `chain.ts` is what they come from once this is wired up, and the difference is a second bounce
 * and radiance from surfaces that were never in frame.
 *
 * **Why a spherical Fibonacci spiral and not random directions.** At a few hundred samples a random
 * set leaves holes and pairs, and a probe with a hole in its sphere has looked at part of its world
 * and reports all of it — as a dark patch in a direction nothing happened to be traced along. The
 * spiral's points are as far from each other as the count allows, and its cost is one sine and one
 * cosine a direction.
 *
 * **And the set turns every frame, which is what makes a probe converge.** A fixed set measures the
 * same few hundred directions for ever, so whatever it misses it misses permanently. Rotating it by
 * an irrational fraction of a turn each refresh means successive refreshes sample different
 * directions, and the accumulation over a few refreshes is a denser set than any one of them.
 */

import { octInsetDir } from '../shaders/octahedral.ts';

/**
 * Why a scene is not lit by what bounces on WebGL2, in words, so both backends read one sentence.
 *
 * **A probe is a few hundred rays and that is a compute dispatch.** This backend has no compute
 * stage, and the alternatives are both worse than saying so: tracing on the processor is a
 * main-thread cost proportional to the grid, and approximating with more frequent cube bakes means
 * the two backends light one scene differently — which is the disagreement every published scene's
 * pixel gate exists to prevent.
 *
 * Written here rather than in either renderer for the reason `OIT_MULTISAMPLE_REFUSAL` is written
 * outside both: it is a decision the two share, so it belongs where neither owns it.
 */
export const INDIRECT_LIGHT_WEBGL2_REFUSAL =
  'driftengine: indirect light traces a few hundred rays a probe, which is a compute dispatch, ' +
  'and WebGL2 has no compute stage — so `quality.indirectLight` lights nothing on this backend ' +
  'and the probe grid keeps the bake it has always had. It is WebGPU only, as reconstruction is.';

/**
 * Directions a probe traces per refresh.
 *
 * **A few hundred, and the number is a cost rather than a quality.** A refresh is this many rays
 * down a three-level chain, and `probeUpdateSchedule` decides how many probes pay it a frame. The
 * convergence comes from the rotation between refreshes, not from this count, so it is set where a
 * single refresh is already recognisable rather than where one refresh is final.
 */
export const PROBE_DIRECTIONS = 256;

/**
 * The golden angle, which is what spaces a spiral's points as far apart as a count allows.
 *
 * Exported because `shaders/gi/probeBake.wgsl.ts` interpolates it: a shader cannot import a
 * constant, so the choice is one value written here and pasted in, or two literals kept in step by
 * hand. `probe-bake-parity.mjs` checks the result either way, but only one of them can be right by
 * construction.
 */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * How far the set turns between one refresh and the next, in turns.
 *
 * The golden ratio's fractional part: successive frames land their offsets as far from each other
 * as the sequence allows, for the same reason the spiral's own points do, and it never repeats.
 */
export const FRAME_TURN = 0.618033988749895;

/**
 * Direction `index` of the set this `frame` traces, into `out`.
 *
 * The spiral runs `z` from near `+1` to near `-1` in equal steps and turns by the golden angle at
 * each, which is the construction whose points are evenly spread on a sphere; the frame's own
 * rotation is added to that turn.
 */
export function probeDirection(index: number, frame: number, out: Float32Array): void {
  const i = ((index % PROBE_DIRECTIONS) + PROBE_DIRECTIONS) % PROBE_DIRECTIONS;
  /* Offset by a half step at each end, so no direction lands exactly on a pole — where the turn
     has no effect and two frames would trace the same ray. */
  const z = 1 - (2 * i + 1) / PROBE_DIRECTIONS;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const angle = i * GOLDEN_ANGLE + frame * FRAME_TURN * Math.PI * 2;
  out[0] = Math.cos(angle) * radius;
  out[1] = Math.sin(angle) * radius;
  out[2] = z;
}

const TEXEL_DIR = new Float32Array(3);

/**
 * The cosine convolution of `count` radiance samples into an octahedral map of `edge` texels.
 *
 * Each texel's direction is the normal of a surface facing that way, and its value is the
 * irradiance such a surface receives: every sample weighted by how much of its hemisphere it
 * occupies, which for a cosine lobe is `max(0, dot(normal, direction))`.
 *
 * **Normalised by the weights that were actually used, and that is the whole of the white-furnace
 * property.** Dividing by an analytic constant — pi, or the sample count — is right only in the
 * limit and wrong for any finite set, so a uniformly white sphere would convolve to something
 * slightly other than white and a room would brighten or darken a little at every refresh. Dividing
 * by the sum of the weights is exact for any set, and it is what makes a constant come back
 * constant to the last place a float holds.
 */
export function convolveProbe(
  samples: Float32Array,
  directions: Float32Array,
  count: number,
  edge: number,
  out: Float32Array,
): void {
  const texels = Math.max(1, Math.floor(edge));
  for (let v = 0; v < texels; v += 1) {
    for (let u = 0; u < texels; u += 1) {
      octInsetDir((u + 0.5) / texels, (v + 0.5) / texels, texels, TEXEL_DIR as unknown as never);
      const nx = TEXEL_DIR[0] as number;
      const ny = TEXEL_DIR[1] as number;
      const nz = TEXEL_DIR[2] as number;
      let weights = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < count; i += 1) {
        const weight =
          nx * (directions[i * 3] as number) +
          ny * (directions[i * 3 + 1] as number) +
          nz * (directions[i * 3 + 2] as number);
        if (weight <= 0) continue;
        weights += weight;
        r += (samples[i * 3] as number) * weight;
        g += (samples[i * 3 + 1] as number) * weight;
        b += (samples[i * 3 + 2] as number) * weight;
      }
      const at = (v * texels + u) * 3;
      /* No weight at all is a texel no sample faced, which a set this dense does not produce —
         and answering zero rather than dividing is what keeps it from being a hole if it ever does. */
      const scale = weights > 0 ? 1 / weights : 0;
      out[at] = Math.max(0, r * scale);
      out[at + 1] = Math.max(0, g * scale);
      out[at + 2] = Math.max(0, b * scale);
    }
  }
}
