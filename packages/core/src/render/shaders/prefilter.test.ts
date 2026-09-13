import { describe, expect, it } from 'vitest';

import { PREFILTER_FRAG } from './prefilter.ts';

describe('the environment prefilter', () => {
  /*
   * **The 2026-08-07 rule, asserted on the string because only a GPU could confirm it otherwise.**
   * The convolution's fetch sits inside a loop carrying a `continue`, which no compiler can prove
   * uniform. An implicit derivative there is what lets a driver flatten the loop and cost every
   * arm instead of the one taken — the defect that measured 60 fps for six weeks and cost 13 ms a
   * frame on somebody else's stack.
   */
  it('never takes an implicit derivative', () => {
    expect(PREFILTER_FRAG).not.toMatch(/[^A-Za-z]texture\s*\(/);
    expect(PREFILTER_FRAG).toMatch(/textureLod\s*\(/);
  });

  /*
   * **It samples the capture and never the cube it is writing.** The two-cube split is what makes
   * the feedback-loop question moot and what stops a level being convolved from an already
   * convolved one. A shader naming the lit pass's own environment sampler would be reading its own
   * target on the backend where they are the same object.
   */
  it('names only the capture as its source', () => {
    expect(PREFILTER_FRAG).toMatch(/uPrefilterSource/);
    expect(PREFILTER_FRAG).not.toMatch(/uEnvironment\b/);
  });

  /*
   * A mirror is a fetch rather than an integral. At roughness 0 the distribution is a delta, every
   * importance sample collapses onto one direction, and the sum is one sample's worth of noise
   * where the answer is exactly the texel. Without this arm level 0 is visibly noisier than the
   * capture it came from, which reads as the prefilter having damaged the probe.
   */
  it('takes a mirror as a direct fetch rather than as a sum', () => {
    expect(PREFILTER_FRAG).toMatch(/uPrefilterRoughness\s*<=\s*0\.0/);
  });

  /*
   * Normalising by the sample count rather than the accumulated weight darkens every rough level
   * by the fraction of samples that fell below the horizon, which reads as roughness losing energy
   * — which is the artefact `uEnvironmentGain` exists to compensate for, so a prefilter that
   * reintroduced it would have replaced nothing.
   */
  it('normalises by accumulated weight, not by the sample count', () => {
    expect(PREFILTER_FRAG).toMatch(/sum\s*\/\s*max\(weight/);
  });

  /*
   * **A profile that has not asked for the lobe chain must get the picture it already had.**
   * `environmentPrefilter` is off by default and that default is a correction: the prefilter once
   * shipped wired straight into the lit pass and changed every consumer that had a probe, reported
   * as metals reading opaque. With one array instead of two cubes the flag decides what is baked
   * rather than which texture is bound, so the box arm has to exist here.
   */
  it('keeps a box arm for the profile that has not asked for the lobe chain', () => {
    expect(PREFILTER_FRAG).toMatch(/uPrefilterBox\s*>\s*0\.5/);
    expect(PREFILTER_FRAG).toMatch(/uPrefilterLevel/);
  });

  /*
   * **The target is a layer, so there is no face basis at all.** A cube's convolution rebuilt its
   * direction from a face's centre and two in-plane steps, six times per level. An octahedral map
   * has no faces: the texel's own coordinate is the direction, and in the gutter it is the folded
   * one. A shader still carrying the face uniforms would be one that never moved.
   */
  it('takes its direction from the octahedral inset rather than a face basis', () => {
    expect(PREFILTER_FRAG).toMatch(/octInsetDir\(vUv, uPrefilterEdge\)/);
    expect(PREFILTER_FRAG).not.toMatch(/uFaceForward|uFaceBasisX|uFaceBasisY/);
  });

  /* The fold's two ends have to be in the source, or the direction it computes is undefined. */
  it('carries the octahedral chunk it folds with', () => {
    expect(PREFILTER_FRAG).toMatch(/vec3 octDecode\(/);
    expect(PREFILTER_FRAG).toMatch(/vec2 octWrapUv\(/);
    expect(PREFILTER_FRAG).toMatch(/vec3 octInsetDir\(/);
  });

  /*
   * **The diffuse level is a mean and the reflection is a weighted sum, and the difference is the
   * pi.** A cosine-weighted sample carries its weight in its own density, so the estimate divides
   * by the count; irradiance divided by pi is what the lit pass wants, and `irradianceSh.ts` folds
   * the same division into its band factors. A convolution that normalised this arm by an
   * accumulated weight instead would be 3.14 times out, with every direction still in the right
   * proportion to every other — which reads as a scene needing a tuning pass.
   */
  it('takes the diffuse level as a plain mean, which is where the pi divides out', () => {
    expect(PREFILTER_FRAG).toMatch(/uPrefilterIrradiance\s*>\s*0\.5/);
    expect(PREFILTER_FRAG).toMatch(/diffuse\s*\/\s*max\(uPrefilterSamples/);
    expect(PREFILTER_FRAG).toMatch(/importanceSampleCosine/);
  });
});
