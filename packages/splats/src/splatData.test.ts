import { describe, expect, it } from 'vitest';
import { halfToFloat } from './half.ts';
import { SPLAT_WORDS, packSplats } from './splatData.ts';
import type { SplatSource } from './splatData.ts';

/** The six covariance terms a splat's second texel carries, in the order it carries them. */
function covarianceOf(packed: Uint32Array, index: number): number[] {
  const at = index * SPLAT_WORDS;
  const pair = (word: number): number[] => [
    halfToFloat((packed[word] ?? 0) & 0xffff),
    halfToFloat((packed[word] ?? 0) >>> 16),
  ];
  return [...pair(at + 4), ...pair(at + 5), ...pair(at + 6)];
}

function source(over: Partial<SplatSource> = {}): SplatSource {
  return {
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    scales: new Float32Array([1, 1, 1]),
    /* xyzw, so the identity is w = 1. Both file formats store wxyz and each reader reorders. */
    rotations: new Float32Array([0, 0, 0, 1]),
    colors: new Float32Array([0, 0, 0]),
    opacities: new Float32Array([1]),
    ...over,
  };
}

describe('packSplats', () => {
  it('turns a unit splat into an identity covariance', () => {
    /* R is the identity and every scale is 1, so Sigma = R diag(1) R^T is the identity: ones down
       the diagonal and nothing off it. Order is xx, xy, xz, yy, yz, zz, so the diagonal is the
       first, fourth and sixth — which is where this expectation was wrong on its first writing,
       carrying a 0 in the zz slot against code that was right. */
    const data = packSplats(source());
    expect(covarianceOf(data.packed, 0)).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it('produces the off-diagonal a rotated, unequal scale demands', () => {
    /*
     * Hand-derived, not taken from a run. A quarter-turn's half-angle: 45 degrees about z is
     * xyzw = (0, 0, sin 22.5, cos 22.5), so R is [[c, -c, 0], [c, c, 0], [0, 0, 1]] with
     * c = 1/sqrt(2). With scales (2, 1, 1) the weights are (4, 1, 1) and
     * Sigma[i][k] = sum_j R[i][j] R[k][j] w_j:
     *
     *   xx = 0.5*4 + 0.5*1        = 2.5
     *   xy = 0.5*4 + (-0.5)*1     = 1.5
     *   yy = 0.5*4 + 0.5*1        = 2.5
     *   zz = 0 + 0 + 1*1          = 1
     *   xz = yz = 0
     *
     * Every one of those is exactly representable as a half, so this is an equality rather than a
     * tolerance — which is the point of choosing 45 degrees and a scale of 2.
     */
    const data = packSplats(
      source({
        scales: new Float32Array([2, 1, 1]),
        rotations: new Float32Array([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]),
      }),
    );
    expect(covarianceOf(data.packed, 0)).toEqual([2.5, 1.5, 0, 2.5, 0, 1]);
  });

  it('normalises a quaternion rather than trusting it', () => {
    /* The same rotation at four times the length. An un-normalised quaternion scales the whole
       matrix, so without this the covariance would come back sixteen times too large. */
    const scaled = packSplats(
      source({
        rotations: new Float32Array([0, 0, 4 * Math.sin(Math.PI / 8), 4 * Math.cos(Math.PI / 8)]),
        scales: new Float32Array([2, 1, 1]),
      }),
    );
    expect(covarianceOf(scaled.packed, 0)).toEqual([2.5, 1.5, 0, 2.5, 0, 1]);
  });

  it('refuses a quaternion that names no orientation, and says which splat', () => {
    /*
     * A zero quaternion divides by zero and a NaN covariance fails every comparison in the vertex
     * stage — which is an invisible splat on most drivers and one that covers the screen on some.
     * Neither points at the file that caused it, so this stops at the source.
     */
    expect(() => packSplats(source({ rotations: new Float32Array([0, 0, 0, 0]) }))).toThrow(
      /splat 0/,
    );
    expect(() =>
      packSplats(
        source({
          count: 2,
          positions: new Float32Array(6),
          scales: new Float32Array([1, 1, 1, 1, 1, 1]),
          rotations: new Float32Array([0, 0, 0, 1, NaN, 0, 0, 1]),
          colors: new Float32Array(6),
          opacities: new Float32Array([1, 1]),
        }),
      ),
    ).toThrow(/splat 1/);
  });

  it('carries the position through the reinterpretation unchanged', () => {
    /* The words are float bits, not a conversion: the shader reads them back with the inverse. */
    const data = packSplats(source({ positions: new Float32Array([1.5, -2.25, 300]) }));
    const asFloat = new Float32Array(data.packed.buffer);
    expect([asFloat[0], asFloat[1], asFloat[2]]).toEqual([1.5, -2.25, 300]);
  });

  it('packs red in the lowest byte and opacity in the highest', () => {
    /* `unpackUnorm4x8` reads the lowest byte as x. Getting this backwards swaps red and alpha,
       which on an opaque capture is a red cast nobody can attribute to a packing order. */
    const data = packSplats(
      source({ colors: new Float32Array([1, 0, 0]), opacities: new Float32Array([0.5]) }),
    );
    const word = data.packed[3] ?? 0;
    expect(word & 0xff).toBe(255);
    expect((word >>> 8) & 0xff).toBe(0);
    expect((word >>> 16) & 0xff).toBe(0);
    expect((word >>> 24) & 0xff).toBe(128);
  });

  it('carries the extent in the record, so a container stores it for nothing', () => {
    /*
     * **The eighth word was reserved and now holds the extent's own float bits.** The GPU never
     * reads it — the fragment stage takes three of texel one's four components — so it costs the
     * draw nothing, and it means a `.drft` block can be exactly the packed record rather than the
     * record plus a parallel four bytes a splat. `SplatData.extents` still exists beside it,
     * because the sort reads it in a tight loop and reinterpreting bits per access there would
     * not be free.
     */
    const data = packSplats(source({ scales: new Float32Array([0.25, 2, 0.5]) }));
    expect(data.extents[0]).toBe(2);
    expect(new Float32Array(data.packed.buffer, 7 * 4, 1)[0], 'and in the record').toBe(2);
  });

  it('encloses every splat in the bounds, and collapses an empty capture', () => {
    const data = packSplats(
      source({
        count: 2,
        positions: new Float32Array([-1, 2, 3, 4, -5, 6]),
        scales: new Float32Array([1, 1, 1, 1, 1, 1]),
        rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
        colors: new Float32Array(6),
        opacities: new Float32Array([1, 1]),
      }),
    );
    expect(Array.from(data.boundsMin)).toEqual([-1, -5, 3]);
    expect(Array.from(data.boundsMax)).toEqual([4, 2, 6]);

    /* Infinity in a bound is a frustum test that never answers, so an empty capture collapses. */
    const empty = packSplats({
      count: 0,
      positions: new Float32Array(0),
      scales: new Float32Array(0),
      rotations: new Float32Array(0),
      colors: new Float32Array(0),
      opacities: new Float32Array(0),
    });
    expect(Array.from(empty.boundsMin)).toEqual([0, 0, 0]);
    expect(Array.from(empty.boundsMax)).toEqual([0, 0, 0]);
  });

  it('refuses an array that does not match the count, naming it', () => {
    expect(() => packSplats(source({ scales: new Float32Array([1, 1]) }))).toThrow(/scales/);
    expect(() => packSplats(source({ rotations: new Float32Array([0, 0, 1]) }))).toThrow(
      /rotations/,
    );
  });
});

describe('packSplats extents', () => {
  it("records each splat's largest standard deviation, for a budget to rank by", () => {
    /*
     * The budget ranks by screen-space size, which is the world extent over the distance. The
     * world extent of an anisotropic Gaussian depends on which way it is turned, and the largest
     * of its three sigmas bounds that from above for every orientation — which is what a ranking
     * key needs and is one number rather than a per-frame projection.
     */
    const data = packSplats(
      source({
        count: 3,
        positions: new Float32Array(9),
        /* Exactly representable as float32, so this is an equality rather than a tolerance. */
        scales: new Float32Array([0.125, 0.25, 0.5, 3, 1, 1, 0.75, 0.75, 0.75]),
        rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        colors: new Float32Array(9),
        opacities: new Float32Array([1, 1, 1]),
      }),
    );

    expect(Array.from(data.extents)).toEqual([0.5, 3, 0.75]);
  });
});
