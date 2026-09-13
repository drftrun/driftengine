import { describe, expect, it } from 'vitest';

import {
  GRADE_PLACEHOLDER_SIZE,
  MAX_GRADE_SIZE,
  identityGradeLut,
  validateGradeLut,
} from './colourGrade.ts';

/** The texel a lookup table holds for one lattice point, as four bytes. */
function texelAt(
  lut: { readonly size: number; readonly data: Uint8Array },
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const at = ((b * lut.size + g) * lut.size + r) * 4;
  return [lut.data[at] as number, lut.data[at + 1] as number, lut.data[at + 2] as number];
}

describe('an identity colour grade', () => {
  /**
   * **A lattice point holds the colour it stands for**, which is the whole definition of identity
   * and the thing every other assertion here rests on. Hand-derived at size 4: the lattice runs
   * 0, 1/3, 2/3, 1, which in eight bits is 0, 85, 170, 255.
   */
  it('holds each lattice point at the value it stands for', () => {
    const lut = identityGradeLut(4);
    expect(texelAt(lut, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(texelAt(lut, 3, 3, 3)).toEqual([255, 255, 255]);
    expect(texelAt(lut, 1, 0, 0)).toEqual([85, 0, 0]);
    expect(texelAt(lut, 0, 2, 0)).toEqual([0, 170, 0]);
    expect(texelAt(lut, 0, 0, 3)).toEqual([0, 0, 255]);
  });

  /**
   * **The red axis is the fastest, and getting that wrong swaps red for blue.**
   *
   * A 3D texture is indexed `(r, g, b)` and stored with the first axis contiguous, so the offset
   * is `((b * size + g) * size + r) * 4`. A packer that walked it the other way produces a
   * lookup table that is *valid*, filters correctly and inverts the picture's colour axes — which
   * reads as a bad export rather than as a packing bug.
   */
  it('stores red as the fastest-varying axis', () => {
    const lut = identityGradeLut(4);
    /* One step along red from black is red; one step along blue from black is blue. If the axes
       were swapped both of these would still be 85, and only their *positions* would move. */
    expect(lut.data[4]).toBe(85);
    expect(lut.data[5]).toBe(0);
    expect(lut.data[6]).toBe(0);
    /* The first texel of the second blue slice: `size * size * 4` bytes in. */
    const blueSlice = 4 * 4 * 4;
    expect(lut.data[blueSlice]).toBe(0);
    expect(lut.data[blueSlice + 2]).toBe(85);
  });

  /** Alpha is opaque throughout: a lookup table has no transparency and a zero would read as one. */
  it('is opaque at every lattice point', () => {
    const lut = identityGradeLut(4);
    for (let i = 3; i < lut.data.length; i += 4) expect(lut.data[i]).toBe(255);
  });

  /**
   * **The placeholder is two, and two is exact rather than merely small.**
   *
   * Identity is a linear function, and a trilinear fetch through a lattice whose corners hold
   * their own coordinates reproduces a linear function exactly. So the texture bound when nothing
   * is graded is not an inert stand-in that happens never to be sampled — it is the right answer
   * if anything ever samples it, which is what makes it safe to leave bound.
   */
  it('is exact at size two, which is what the placeholder relies on', () => {
    const lut = identityGradeLut(GRADE_PLACEHOLDER_SIZE);
    expect(GRADE_PLACEHOLDER_SIZE).toBe(2);
    expect(lut.data.length).toBe(2 * 2 * 2 * 4);
    expect(texelAt(lut, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(texelAt(lut, 1, 1, 1)).toEqual([255, 255, 255]);
    expect(texelAt(lut, 1, 0, 1)).toEqual([255, 0, 255]);
  });
});

describe('validating a colour grade', () => {
  /* A lookup table of the wrong length is a file read wrongly, and it draws a picture. */
  it('refuses a data array that is not size cubed times four', () => {
    expect(() => validateGradeLut({ size: 4, data: new Uint8Array(4 * 4 * 4 * 3) })).toThrow(
      /256 bytes|expects/i,
    );
  });

  it('refuses a size below two, because a single texel is a constant colour', () => {
    expect(() => validateGradeLut({ size: 1, data: new Uint8Array(4) })).toThrow(/at least 2/i);
  });

  /**
   * **A ceiling, because the cost is cubic and a caller will not feel it until the device does.**
   *
   * A 64-lattice table is a megabyte; 128 is eight. The refusal names the number rather than
   * silently downsampling, because a downsample is a look the caller did not choose.
   */
  it('refuses a size past the ceiling rather than resampling it', () => {
    const size = MAX_GRADE_SIZE + 1;
    expect(() => validateGradeLut({ size, data: new Uint8Array(size ** 3 * 4) })).toThrow(
      new RegExp(String(MAX_GRADE_SIZE)),
    );
  });

  it('accepts what identityGradeLut builds, at every size it will be built at', () => {
    for (const size of [2, 8, 16, 32, MAX_GRADE_SIZE]) {
      expect(() => validateGradeLut(identityGradeLut(size))).not.toThrow();
    }
  });
});
