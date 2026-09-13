import { describe, expect, it } from 'vitest';

import {
  IRRADIANCE_EDGE,
  PREFILTER_SAMPLE_COUNTS,
  ggxMaxLevelFor,
  irradianceLevelFor,
  octahedralEdgeFor,
  roughnessForLevel,
  sourceLevelForSample,
} from './prefilterEnvMap.ts';

describe('the roughness a prefiltered level stands for', () => {
  /*
   * **Level 0 is a mirror and the coarsest level is fully rough.** The mapping is linear in the
   * level index rather than in the level's texel count, which is what every published prefilter
   * does and what the shader's own `surfaceRoughness * uEnvironmentMaxLod` already assumes — the
   * lit pass picks its level by multiplying roughness by the top level, so this has to be that
   * relation read backwards or the two disagree about what level three means.
   */
  it('puts a mirror at level 0 and full roughness at the top', () => {
    expect(roughnessForLevel(0, 5)).toBe(0);
    expect(roughnessForLevel(5, 5)).toBe(1);
  });

  it('is linear between them', () => {
    expect(roughnessForLevel(2, 4)).toBeCloseTo(0.5, 6);
    expect(roughnessForLevel(1, 4)).toBeCloseTo(0.25, 6);
  });

  /*
   * A probe small enough to have a single level asks for `maxLevel` 0, and a division by it is
   * NaN — which is a roughness the convolution would carry into every sample and a picture nobody
   * could attribute to a divide. A mirror is the honest answer for a chain with nowhere to go.
   */
  it('answers a mirror rather than NaN when there is only one level', () => {
    expect(roughnessForLevel(0, 0)).toBe(0);
  });
});

describe('which source level one importance sample reads', () => {
  /*
   * **Filtered importance sampling, and the arithmetic is hand-derived here rather than trusted.**
   * A sample drawn from the GGX distribution covers a solid angle of `1 / (N * pdf)`. One texel of
   * a cube whose faces are `w` across covers `4*pi / (6 * w * w)`. Reading the base level when a
   * sample is far wider than a texel is what produces fireflies: a few very bright texels land in
   * some samples and not others, and the variance survives the average.
   *
   * So the level is `0.5 * log2(sampleSolidAngle / texelSolidAngle)`, the half because a level
   * step doubles a texel's width and therefore quadruples its solid angle.
   *
   * Worked at w = 64, N = 32, pdf = 1:
   *   texel  = 4*pi / (6 * 4096)       = 12.5663706 / 24576 = 5.113270e-4
   *   sample = 1 / (32 * 1)            = 3.125e-2
   *   ratio  = 3.125e-2 / 5.113270e-4  = 61.11558
   *   level  = 0.5 * log2(61.11558)    = 0.5 * 5.933466 = 2.966733
   */
  it('reads a coarser level the wider the sample is', () => {
    expect(sourceLevelForSample(1, 64, 32, 6)).toBeCloseTo(2.966733, 5);
  });

  /*
   * A sharply peaked distribution — a near-mirror — draws samples narrower than a texel, so the
   * honest level is below the base one and there is nothing below the base one. It clamps rather
   * than going negative, because a negative level is a driver's business and not a decision this
   * file should be making implicitly.
   */
  it('clamps at the base level rather than going negative', () => {
    expect(sourceLevelForSample(1e6, 64, 32, 6)).toBe(0);
  });

  /* And it never asks for a level the chain does not have. */
  it('clamps at the top of the chain', () => {
    expect(sourceLevelForSample(1e-6, 64, 32, 6)).toBe(6);
  });

  /*
   * More samples means each one is narrower, so it reads a finer level: doubling N drops the
   * ratio by two and therefore the level by exactly 0.5.
   */
  it('reads half a level finer for twice as many samples', () => {
    const few = sourceLevelForSample(1, 64, 32, 12);
    const many = sourceLevelForSample(1, 64, 64, 12);
    expect(few - many).toBeCloseTo(0.5, 6);
  });
});

describe('the sample counts a quality tier names', () => {
  /*
   * Named tiers rather than a bare number in `RenderQuality`, because a phone and a workstation
   * should not agree on this and neither should have to know what a good number is. They rise
   * strictly, so a consumer moving up a tier never gets a coarser convolution.
   */
  it('rises strictly with the tier', () => {
    expect(PREFILTER_SAMPLE_COUNTS.low).toBeLessThan(PREFILTER_SAMPLE_COUNTS.medium);
    expect(PREFILTER_SAMPLE_COUNTS.medium).toBeLessThan(PREFILTER_SAMPLE_COUNTS.high);
  });

  /*
   * Every tier is a power of two. The Hammersley sequence's radical inverse is a bit reversal, so
   * a count that is not a power of two leaves the sequence's stratification uneven — which shows
   * as a faint directional bias in a rough level rather than as an error.
   */
  it('names only powers of two', () => {
    for (const count of Object.values(PREFILTER_SAMPLE_COUNTS)) {
      expect(Number.isInteger(Math.log2(count))).toBe(true);
    }
  });
});

describe('the octahedral edge and the levels of its chain', () => {
  /*
   * **One rule for both octahedral resources in this engine.** `OCTAHEDRAL_EDGE` is 1024 for a 512
   * cube face and this is 256 for the default 128 face; both are twice the face, which is the
   * 1.22x angular coarsening the point-shadow array's comment derives and accepts. A second rule
   * here would mean the two were each calibrated to taste.
   */
  it('gives an octahedral map twice the cube face it replaces', () => {
    expect(octahedralEdgeFor(128)).toBe(256);
    expect(octahedralEdgeFor(512)).toBe(1024);
    expect(octahedralEdgeFor(64)).toBe(128);
  });

  /* A probe clamped to the smallest size the device path allows still needs a usable chain. */
  it('keeps a floor under the edge so the chain has room for both terms', () => {
    expect(octahedralEdgeFor(8)).toBe(32);
    expect(ggxMaxLevelFor(octahedralEdgeFor(8))).toBeGreaterThanOrEqual(1);
  });

  /*
   * The division that lets one binding carry both terms: the GGX chain stops one level below the
   * cosine convolution, so a roughness of 1 can never blend into the irradiance image. A shader
   * that read `uEnvironmentMaxLod` as the top of the chain instead would sample diffuse light as
   * though it were a reflection, on every rough metal in the world.
   */
  it('puts irradiance one level above the roughest GGX level', () => {
    expect(irradianceLevelFor(256)).toBe(5);
    expect(ggxMaxLevelFor(256)).toBe(4);
    expect(irradianceLevelFor(128)).toBe(4);
    expect(ggxMaxLevelFor(128)).toBe(3);
  });

  /* The irradiance level is the one whose image is IRRADIANCE_EDGE across. Derived, not written. */
  it('lands the irradiance level on an image of the stated edge', () => {
    for (const edge of [32, 64, 128, 256, 512, 1024]) {
      expect(edge >> irradianceLevelFor(edge), `edge ${edge}`).toBe(IRRADIANCE_EDGE);
    }
  });

  /*
   * **Nothing above the irradiance level is allocated**, which is what makes the fold free rather
   * than merely cheap. `texStorage3D` takes a level count, so the chain simply stops: a 256 edge
   * is six levels, and the three that would hold sixteen, four and one texel are never created.
   * The arithmetic is here because a layer's memory is what `MAX_ENV_PROBES` is derived from.
   */
  it('allocates a chain that stops at the irradiance level', () => {
    const edge = 256;
    let texels = 0;
    for (let level = 0; level <= irradianceLevelFor(edge); level++) {
      texels += (edge >> level) * (edge >> level);
    }
    expect(irradianceLevelFor(edge) + 1, 'levels allocated').toBe(6);
    expect(texels).toBe(87360);
    /* Half-float RGBA, which is what a scene keeping its range gets. 683 KB a layer. */
    expect(Math.round((texels * 8) / 1024)).toBe(683);
  });
});
