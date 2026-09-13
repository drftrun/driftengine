import { describe, expect, it } from 'vitest';

import { IES_ATLAS_TEXTURE_UNIT } from './lightBudget.ts';
import {
  MAX_JOINTS,
  MAX_MORPH_TARGETS,
  SKIN_PALETTE_TEXTURE_UNIT,
  morphTexelIndex,
  morphTextureRows,
  morphTextureWidth,
  paletteTextureWidth,
  validateMorph,
} from './skinPalette.ts';

describe('the palette texture', () => {
  /* Four texels a 4x4 matrix, one row. Hand-derived, not taken from the function. */
  it('is four texels wide per joint', () => {
    expect(paletteTextureWidth(1)).toBe(4);
    expect(paletteTextureWidth(90)).toBe(360);
  });

  /*
   * WebGL2 guarantees a MAX_TEXTURE_SIZE of 2048 and nothing more, so one row holds 512 matrices.
   * The cap is stated rather than discovered as a rig whose last joints read whatever is past the
   * end of a row.
   */
  it('caps at what the guaranteed texture width holds', () => {
    expect(MAX_JOINTS).toBe(512);
    expect(paletteTextureWidth(MAX_JOINTS)).toBe(2048);
  });

  it('refuses a joint count above the cap, naming it', () => {
    expect(() => paletteTextureWidth(MAX_JOINTS + 1)).toThrow(/512/);
  });

  it('refuses a joint count of zero, which would be a texture of no width', () => {
    expect(() => paletteTextureWidth(0)).toThrow(/joint/i);
  });

  /*
   * **It comes out of the lit pass's own sixteen, and this assertion is the correction.** The
   * first version of this test asserted unit 0 on the reading that
   * `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is a separate guarantee from `MAX_TEXTURE_IMAGE_UNITS`. Those
   * two do bound the stages separately — but they bound how many units each stage may *reference*,
   * not how units are numbered: `activeTexture` selects from one shared pool. Unit 0 is the
   * directional shadow map, and the driver said so on the first hardware capture —
   * `GL_INVALID_OPERATION: two textures of different types use the same sampler location`, on a
   * frame that otherwise drew.
   *
   * Derived from `lightBudget.ts` rather than written as a literal here, for the reason every unit
   * in that file is: a second number for one decision is a collision waiting to happen.
   */
  it('takes a unit above every one the lit pass binds', () => {
    expect(SKIN_PALETTE_TEXTURE_UNIT).toBe(IES_ATLAS_TEXTURE_UNIT + 1);
  });
});

describe('the morph delta texture', () => {
  /*
   * Interleaved by vertex: every target of one vertex is adjacent, because the shader reads all of
   * them for one vertex and nothing reads one target across many vertices. Hand-derived at four
   * targets — vertex 0's four texels are 0..3, so vertex 1's first is 4.
   */
  it('addresses a delta by vertex and target', () => {
    expect(morphTexelIndex(0, 0, 4)).toBe(0);
    expect(morphTexelIndex(0, 1, 4)).toBe(1);
    expect(morphTexelIndex(1, 0, 4)).toBe(4);
    expect(morphTexelIndex(1, 3, 4)).toBe(7);
  });

  it('refuses more targets than the weights array can drive', () => {
    expect(() => validateMorph(new Float32Array(4), 8)).toThrow(/4 weights for 8/);
  });

  it('refuses more targets than the uniform block holds', () => {
    expect(() => validateMorph(new Float32Array(64), MAX_MORPH_TARGETS + 1)).toThrow(
      /outside 1 to 8/,
    );
  });

  /*
   * Unlike the palette, the delta texture routinely needs more than one row: a mesh times its
   * targets passes WebGL2's guaranteed 2048 at 256 vertices with eight targets, which is a small
   * mesh. So wrapping is the ordinary case here rather than the escape hatch.
   */
  it('wraps onto rows once it passes the guaranteed width', () => {
    expect(morphTextureWidth(100, 4)).toBe(400);
    expect(morphTextureRows(100, 4)).toBe(1);
    expect(morphTextureWidth(1000, 8)).toBe(2048);
    expect(morphTextureRows(1000, 8)).toBe(4);
  });
});
