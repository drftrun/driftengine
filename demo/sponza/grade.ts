/**
 * The scene's look: a film grade, built as a lookup table in code so the scene adds no image.
 *
 * **Display-referred, as `setColourGrade` takes it**, so it acts after the tone curve and cannot
 * change what is bright, only how a colour reads. One move: **less saturation in the midtones as
 * they are shown**, most at middle grey and none at black or white. The courtyard's cloths decode to
 * nearly pure red and teal, and through the curve they came out the loudest thing in every frame
 * where the maker's renders show coral and a dark teal: 0.50 of saturation over a view the renders
 * hold at 0.29. Weighted by the shown brightness rather than the light's, because a dark red cloth is
 * a midtone on screen and a deep shadow in linear light, and weighting by the second let it through.
 * A quarter out: at -0.45 the maintainer found the courtyard a little washed out, and at a quarter,
 * with local exposure at a fifth, the cloths read 0.44 and the darkest twentieth drops from 35 to 30.
 *
 * **It added a fifth more until 2026-09-26**, against photographs with the colour maps read undecoded,
 * which were pale for that reason and needed it.
 *
 * **It warmed the white and lifted the shade toward amber until 2026-09-25**, to make stone that
 * the tone curve's shoulder had bleached read cream. That was answering an exposure a stop and a
 * half too high with colour, and it put the frame at +0.17 of red over blue against the
 * photographs' +0.05. With the exposure matched it has nothing left to correct. What would make
 * that wrong is a reference graded warm on purpose, which is a look rather than a correction and
 * belongs to whoever chooses it.
 */
import type { ColourGradeLut } from '../../packages/core/src/index';

const SIZE = 32;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toDisplay = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;

export function filmGrade(): ColourGradeLut {
  const data = new Uint8Array(SIZE * SIZE * SIZE * 4);
  const last = SIZE - 1;
  let at = 0;
  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        /* Into linear light, where saturation about luma is a mix. */
        let lr = toLinear(r / last);
        let lg = toLinear(g / last);
        let lb = toLinear(b / last);
        /* Saturation about luma, strongest in the midtones as they are shown. */
        const luma = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        const shown = 0.2126 * (r / last) + 0.7152 * (g / last) + 0.0722 * (b / last);
        const mid = 4 * shown * (1 - shown);
        const sat = 1 - 0.25 * mid;
        lr = luma + (lr - luma) * sat;
        lg = luma + (lg - luma) * sat;
        lb = luma + (lb - luma) * sat;
        const clamp = (v: number): number =>
          Math.round(Math.min(1, Math.max(0, toDisplay(v))) * 255);
        data[at] = clamp(lr);
        data[at + 1] = clamp(lg);
        data[at + 2] = clamp(lb);
        data[at + 3] = 255;
        at += 4;
      }
    }
  }
  return { size: SIZE, data };
}
