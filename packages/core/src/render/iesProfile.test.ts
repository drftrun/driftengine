import { describe, expect, it } from 'vitest';

import { IES_ATLAS_WIDTH, packIesAtlas } from './iesProfile.ts';
import type { PhotometricProfile } from './iesProfile.ts';

function profile(vertical: number[], candela: number[]): PhotometricProfile {
  return {
    verticalAngles: new Float32Array(vertical),
    horizontalAngles: new Float32Array([0]),
    candela: new Float32Array(candela),
    maxCandela: Math.max(...candela),
  };
}

/**
 * An asymmetric fixture: one vertical list, several horizontal planes, candela horizontal-major.
 *
 * That is the layout `readIesProfile` produces — "all vertical angles of the first plane, then the
 * second" — restated here rather than referred to, because a test built on the wrong reading of a
 * grid passes against a packer built on the same wrong reading.
 */
function asymmetric(
  vertical: number[],
  horizontal: number[],
  planes: number[][],
): PhotometricProfile {
  const candela = planes.flat();
  return {
    verticalAngles: new Float32Array(vertical),
    horizontalAngles: new Float32Array(horizontal),
    candela: new Float32Array(candela),
    maxCandela: Math.max(...candela),
  };
}

describe('the IES atlas', () => {
  /*
   * **An empty atlas is one row of ones, not a zero-height texture.**
   *
   * A sampler declared in the shader needs a complete texture bound whether or not any branch reads
   * it — the argument `emptyTexture.ts` makes — and a zero-height allocation is an `INVALID_VALUE`
   * rather than an empty one. Ones rather than zeros because this multiplies a light's colour: an
   * all-zero fallback switches off every light that reaches it, which is the loudest possible
   * failure for the quietest possible cause.
   */
  it('packs nothing as one row of ones', () => {
    const atlas = packIesAtlas([]);
    expect(atlas.height).toBe(1);
    expect(atlas.width).toBe(IES_ATLAS_WIDTH);
    expect(Array.from(atlas.data).every((value) => value === 1)).toBe(true);
  });

  /**
   * **A profile occupies `planes + 1` rows, and the extra one repeats the first.**
   *
   * That wrap row is what lets the shader do the whole azimuth blend in one fetch: a fractional
   * row inside a profile is the blend, and the wrap from the last plane back to the first is a
   * blend into the repeat rather than a bleed into the next profile's first plane. For an axially
   * symmetric profile it is 512 bytes that are never sampled — the shader lands on the row centre
   * exactly, because the azimuth is not computed at all when there is one plane.
   */
  it('gives each profile its planes plus a wrap row', () => {
    const atlas = packIesAtlas([profile([0, 90], [100, 0]), profile([0, 90], [50, 50])]);
    expect(atlas.planes).toBe(1);
    expect(atlas.height).toBe(4);
    expect(atlas.data.length).toBe(IES_ATLAS_WIDTH * 4);
    /* The wrap row of the first profile is the first profile's own plane 0, not the second's. */
    for (let column = 0; column < IES_ATLAS_WIDTH; column++) {
      expect(atlas.data[IES_ATLAS_WIDTH + column]).toBe(atlas.data[column]);
    }
  });

  /*
   * **Normalised to the profile's own peak**, because the row multiplies a light's colour and the
   * colour already carries the intensity a consumer chose. Carrying absolute candela as well would
   * multiply the two and make every IES light either black or blinding.
   *
   * Hand-derived: a profile peaking at 100 has 1.0 at its peak whatever the number was, and a
   * profile that is flat at 50 is 1.0 everywhere.
   */
  it('normalises each row to its own peak', () => {
    const atlas = packIesAtlas([profile([0, 90], [100, 0]), profile([0, 90], [50, 50])]);
    /* Two rows a profile now — its one plane and its wrap — so the second profile starts at 2. */
    expect(atlas.data[0]).toBeCloseTo(1, 6);
    expect(atlas.data[IES_ATLAS_WIDTH * 2]).toBeCloseTo(1, 6);
    expect(atlas.data[IES_ATLAS_WIDTH * 3 - 1]).toBeCloseTo(1, 6);
  });

  /*
   * **Linear between measured angles, not nearest.** A real file is sparse where the distribution
   * is flat, so nearest-neighbour produces visible steps exactly where the light is smooth — which
   * reads as banding in the fixture rather than as a sampling choice.
   *
   * Hand-derived on a profile measured at 0 and 90 with candela 100 and 0, packed over a fixed 0 to
   * 180 arc: 45 degrees is a quarter of the way along the row and half way between the two
   * samples, so the value there is 0.5.
   */
  it('interpolates between the angles a file actually measured', () => {
    const atlas = packIesAtlas([profile([0, 90], [100, 0])]);
    const quarter = atlas.data[Math.round((IES_ATLAS_WIDTH - 1) * 0.25)] ?? 0;
    expect(quarter).toBeCloseTo(0.5, 2);
  });

  /*
   * **Every row spans the same 0 to 180 arc, whatever the file measured**, which is what keeps a
   * light's record to a single slot: the shader maps an angle to a column with `angle / 180` and
   * needs no per-light range. Beyond the measured end the row holds the last measured value, which
   * for a downlight is the near-zero that already says it emits nothing upward.
   */
  /**
   * **A set of axially symmetric profiles is one plane, and shades exactly as it did.**
   *
   * The overwhelming majority of published profiles are symmetric, so the common case must not pay
   * for the rare one. `planes` is 1, so the shader never computes an azimuth and lands on the row
   * centre exactly — a texel centre, where the linear filter returns that texel — and the shading
   * is bit-identical to what it was. What it does cost is the wrap row, 512 bytes a profile, which
   * for a symmetric profile is never sampled.
   */
  it('is one plane when nothing is asymmetric', () => {
    const atlas = packIesAtlas([profile([0, 90], [100, 0]), profile([0, 90], [50, 50])]);
    expect(atlas.planes).toBe(1);
  });

  /**
   * **An asymmetric fixture keeps its planes, and every profile is padded to the same count.**
   *
   * One plane count for the whole atlas rather than one per profile, because the shader's row is
   * `profile * planes + plane` and a per-profile count would need a second number in a light's
   * record to divide by. Padding a symmetric profile to N identical rows costs 512 bytes a plane,
   * which is nothing against the image an IES profile replaces.
   */
  it('keeps the planes of an asymmetric profile and pads the rest to match', () => {
    const wallWasher = asymmetric(
      [0, 90],
      [0, 90, 180],
      [
        [100, 0],
        [50, 0],
        [10, 0],
      ],
    );
    const atlas = packIesAtlas([profile([0, 90], [80, 0]), wallWasher]);
    expect(atlas.planes).toBe(3);
    /* Two profiles at three planes and a wrap row each. */
    expect(atlas.height).toBe(8);
    expect(atlas.data.length).toBe(IES_ATLAS_WIDTH * 8);
  });

  /**
   * **The planes carry different values, which is the whole capability.**
   *
   * Measured at 0, 120 and 240 so the file's own planes land exactly on the regular grid — the
   * resampling is a separate question and has its own test below, and a fixture chosen to need
   * both at once would not say which of the two it was testing.
   *
   * Hand-derived: the fixture peaks at 100 in its first plane, so normalised to the **profile's**
   * peak the three planes start at 1, 0.5 and 0.1. A packer that normalised each plane to its own
   * peak gives 1 in all three and throws the asymmetry away; the version this file shipped until
   * now kept the first plane and repeated it, which gives 1 in all three by a different route.
   */
  it('normalises every plane against the profile, not against itself', () => {
    const wallWasher = asymmetric(
      [0, 90],
      [0, 120, 240],
      [
        [100, 0],
        [50, 0],
        [10, 0],
      ],
    );
    const atlas = packIesAtlas([wallWasher]);
    expect(atlas.planes).toBe(3);
    expect(atlas.data[0]).toBeCloseTo(1, 6);
    expect(atlas.data[IES_ATLAS_WIDTH]).toBeCloseTo(0.5, 6);
    expect(atlas.data[IES_ATLAS_WIDTH * 2]).toBeCloseTo(0.1, 6);
  });

  /* A symmetric profile padded to three planes holds the same row three times, not two blanks. */
  it('pads a symmetric profile by repeating it rather than by zeroing', () => {
    const wallWasher = asymmetric(
      [0, 90],
      [0, 90, 180],
      [
        [100, 0],
        [50, 0],
        [10, 0],
      ],
    );
    const atlas = packIesAtlas([profile([0, 90], [80, 0]), wallWasher]);
    for (let plane = 1; plane < 3; plane++) {
      expect(atlas.data[IES_ATLAS_WIDTH * plane]).toBeCloseTo(atlas.data[0] as number, 6);
    }
  });

  /**
   * **The planes are resampled onto a regular 0 to 360 grid**, for the same reason the vertical
   * angles are resampled onto a fixed arc: the shader maps an azimuth to a plane with
   * `azimuth / 360 * planes` and carries no per-profile angle list to search.
   *
   * Hand-derived on a fixture measured at 0 and 180 only: packed into four planes, the grid runs
   * 0, 90, 180, 270 — so plane 1 is half way between the two measurements and plane 3 is half way
   * back, both 0.55 where the ends are 1 and 0.1.
   */
  it('resamples the measured planes onto a regular arc', () => {
    const twoPlane = asymmetric(
      [0, 90],
      [0, 180],
      [
        [100, 0],
        [10, 0],
      ],
    );
    const atlas = packIesAtlas([
      twoPlane,
      asymmetric(
        [0, 90],
        [0, 90, 180, 270],
        [
          [1, 0],
          [1, 0],
          [1, 0],
          [1, 0],
        ],
      ),
    ]);
    expect(atlas.planes).toBe(4);
    /* The wrap row of the first profile repeats its plane 0, so the fifth row is the first again. */
    expect(atlas.data[IES_ATLAS_WIDTH * 4]).toBeCloseTo(atlas.data[0] as number, 6);
    expect(atlas.data[0]).toBeCloseTo(1, 6);
    expect(atlas.data[IES_ATLAS_WIDTH]).toBeCloseTo(0.55, 2);
    expect(atlas.data[IES_ATLAS_WIDTH * 2]).toBeCloseTo(0.1, 6);
    expect(atlas.data[IES_ATLAS_WIDTH * 3]).toBeCloseTo(0.55, 2);
  });

  it('pins every row to the same arc and clamps past the measurement', () => {
    const atlas = packIesAtlas([profile([0, 90], [100, 0])]);
    expect(atlas.data[0]).toBeCloseTo(1, 6);
    /* Half way along the row is 90 degrees, the last angle the file measured: candela 0. */
    expect(atlas.data[Math.round((IES_ATLAS_WIDTH - 1) * 0.5)]).toBeCloseTo(0, 2);
    /* And everything past it holds that same last value rather than wrapping or going negative. */
    expect(atlas.data[IES_ATLAS_WIDTH - 1]).toBeCloseTo(0, 6);
  });
});
