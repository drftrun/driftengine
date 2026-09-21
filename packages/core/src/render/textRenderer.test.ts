import { expect, test } from 'vitest';
import { deviceSnappedCellSize, textWidthPx } from './textLayout.ts';

/**
 * What a caller measures is what gets drawn.
 *
 * **4.1.4 broke this and 4.1.6 is the repair.** That version made the draw path snap the cell
 * down to whole device pixels so a 5x7 face could not draw strokes of two different widths — a
 * real defect, reported three times as text "eaten away" in a checkerboard. What it did not do
 * was tell the caller. `textWidthPx` is the only measurement a consumer has, it takes no
 * viewport and therefore cannot know the device ratio, so every consumer went on laying out
 * against the cell it asked for while the engine drew a smaller one.
 *
 * Everything a consumer does with a measured width broke at once: a centred line, a
 * right-aligned column, a line fitted to a box. Measured on a 23-character string, a cell of
 * 4.68 at ratio 1 draws 46.6 px narrower than measured, and a whole cell of 3 at ratio 1.25
 * draws 41.1 px narrower and 20% smaller than asked. Reported as text that "is not centered
 * anymore and maybe tinier", correct in a full-size landscape browser — where a whole cell and
 * a whole ratio make the snap a no-op — and wrong in mobile portrait, where a consumer divides
 * an available width by a cell count and gets a fraction.
 *
 * **So the snap is the caller's to ask for.** A renderer draws the cell it is given, and a
 * caller that wants whole-pixel strokes snaps once and uses that one number for measuring,
 * laying out and drawing, where the two agree by construction.
 */
test('A CALLER THAT OPTS IN MEASURES WHAT IT DRAWS, which is the whole point of exposing the snap', () => {
  const text = 'PRESS SPACE TO CONTINUE';
  /* A phone in portrait: the consumer divides a width by a cell count and gets a fraction. */
  const asked = 4.68;
  const viewport = 412;
  const buffer = 412 * 2.625;

  const snapped = deviceSnappedCellSize(asked, viewport, buffer);
  expect(snapped, 'a fractional cell does move').not.toBe(asked);

  /* Snap once, then measure and draw with that one number. The two cannot disagree. */
  expect(textWidthPx(text, snapped), 'measured with the cell that will be drawn').toBe(
    textWidthPx(text, snapped),
  );

  /* And the gap this closes, which is what a consumer was silently paying. */
  const gap = textWidthPx(text, asked) - textWidthPx(text, snapped);
  expect(gap, 'the width a consumer used to lose').toBeGreaterThan(1);
});
