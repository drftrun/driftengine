/**
 * A colour grade: a lookup table over display values, applied where the output transform is.
 *
 * **A look, not a conversion, and the difference decides where it goes.** `outputTransform.ts` is
 * the conversion from scene units to display values and every pass has to agree about it. A grade
 * is what a colourist did afterwards — the same three numbers in, three different numbers out —
 * and it is *display-referred*, which is what every `.cube` a grading tool exports is. So it is
 * applied **after** the transform and never before it.
 *
 * **It rides the composite and needs `screenEffects`, which is the same rule `hdrScene` already
 * carries and in the same words**: without a composite there is nothing at the end to grade in.
 * Every forward pass grades *itself* when nothing follows it, so a lookup table applied there
 * would need a sampler in six programs to reach a consumer who has deliberately switched
 * post-processing off — and a consumer who switched post-processing off did not ask for a grade.
 * `setColourGrade` says so out loud rather than doing nothing, because a look that silently does
 * not apply is the failure this repository's rules exist to prevent.
 *
 * **`RGBA8` and trilinear, which is what a lookup table is everywhere.** The alpha channel is
 * unused and opaque; a three-channel texture would save a quarter and is not a format WebGL2 can
 * filter as a 3D target. The filtering is what makes a 32-lattice table smooth — without it the
 * grade bands, which is the one artefact a grade must never introduce.
 */

/** A cube of display values: `size` on each axis, `size ** 3 * 4` bytes, red varying fastest. */
export interface ColourGradeLut {
  /** Lattice points along each axis. 32 and 33 are what grading tools export. */
  readonly size: number;
  /** `RGBA8`, `size ** 3 * 4` bytes, indexed `((b * size + g) * size + r) * 4`. */
  readonly data: Uint8Array;
}

/**
 * The lattice the placeholder is built at, and **two is exact rather than merely small**.
 *
 * Identity is a linear function and a trilinear fetch through a lattice whose corners hold their
 * own coordinates reproduces a linear function exactly. So the texture bound when nothing is
 * graded is the right answer if anything ever samples it, rather than an inert stand-in that
 * happens not to be read — which is the same reasoning the ambient-occlusion and bloom
 * placeholders give for being a real texture rather than an unbound unit.
 */
export const GRADE_PLACEHOLDER_SIZE = 2;

/**
 * The largest lattice accepted, because the cost is cubic and a caller will not feel it.
 *
 * 64 is a megabyte of texture; 128 would be eight. Refused by name rather than resampled, because
 * a resample is a look the caller did not choose — and a grade that is quietly not the grade
 * somebody authored is worse than one that will not load.
 */
export const MAX_GRADE_SIZE = 64;

/**
 * A table that changes nothing.
 *
 * Live code rather than a test fixture: it is what a frame with no grade has bound, and it is what
 * a consumer starts from when building one by hand.
 */
export function identityGradeLut(size: number): ColourGradeLut {
  const data = new Uint8Array(size * size * size * 4);
  const last = size > 1 ? size - 1 : 1;
  let at = 0;
  /*
   * Blue slowest, red fastest — the order a 3D texture is stored in, and the order the fetch
   * assumes. Walking it the other way builds a table that is valid, filters correctly, and swaps
   * the picture's colour axes, which reads as a bad export rather than as a packing bug.
   */
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[at] = Math.round((r / last) * 255);
        data[at + 1] = Math.round((g / last) * 255);
        data[at + 2] = Math.round((b / last) * 255);
        data[at + 3] = 255;
        at += 4;
      }
    }
  }
  return { size, data };
}

/**
 * Refuse a table that is not one, at init, naming what was expected.
 *
 * **Fail fast and loud is the rule and this is where it applies**: a lookup table of the wrong
 * length is a file read wrongly, and it still uploads, still filters and still draws a picture —
 * one whose colours are a scrambled function of the right ones. Nothing downstream can tell.
 */
export function validateGradeLut(lut: ColourGradeLut): void {
  if (!Number.isInteger(lut.size) || lut.size < 2) {
    throw new Error(
      `setColourGrade: a lookup table needs at least 2 lattice points a side, got ${lut.size}. ` +
        'A single texel is a constant colour, not a grade.',
    );
  }
  if (lut.size > MAX_GRADE_SIZE) {
    throw new Error(
      `setColourGrade: ${lut.size} lattice points a side is past the ceiling of ` +
        `${MAX_GRADE_SIZE}, which is a megabyte of texture. Resample it yourself if that is ` +
        'what you meant — this will not do it silently, because a resample is a look.',
    );
  }
  const expected = lut.size ** 3 * 4;
  if (lut.data.length !== expected) {
    throw new Error(
      `setColourGrade: a ${lut.size}-lattice table expects ${expected} bytes of RGBA8 and this ` +
        `one has ${lut.data.length}. Red varies fastest, then green, then blue.`,
    );
  }
}
