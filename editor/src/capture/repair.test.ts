import { expect, test } from 'vitest';

import {
  beginStroke,
  createRepairLayer,
  endStroke,
  paintAt,
  type BrushSettings,
} from './repair.ts';

/**
 * **A person repairs what the capture was unsure of, and takes a stroke back in one press.**
 *
 * Two claims, and the first is the one that makes this a repair tool rather than a paint tool: the
 * capture's own confidence weights every texel the brush touches, so a measurement it stands behind
 * is not quietly overwritten by somebody dragging across it.
 */

const WHITE: BrushSettings = { radius: 2, colour: [1, 1, 1, 1], strength: 1 };

test('THE CAPTURE’S CONFIDENCE WEIGHTS EVERY TEXEL THE BRUSH TOUCHES', () => {
  /*
   * Four texels in a row: trusted completely, trusted half, not at all, and not at all. The brush
   * is centred on the second so the falloff is known — at radius 2, a texel one away from the
   * centre takes 1 − 1/2 of the weight and one two away takes none.
   */
  const confidence = Float32Array.from([1, 0.5, 0, 0]);
  const layer = createRepairLayer(4, 1, confidence);
  const stroke = beginStroke(layer, WHITE);
  paintAt(stroke, 1.5, 0.5);

  /* Fully trusted, at the very centre of the brush: untouched, which is the whole rule. */
  expect(layer.texels[0]).toBe(0);
  /* Half trusted, at the centre: full falloff, half the weight — 0 + (1 − 0) × 0.5. */
  expect(layer.texels[4]).toBeCloseTo(0.5, 6);
  /* Not trusted, one texel away: falloff 1 − 1/2, so 0.5 of the way to white. */
  expect(layer.texels[8]).toBeCloseTo(0.5, 6);
  /* Not trusted, two away: outside the falloff entirely. */
  expect(layer.texels[12]).toBe(0);
});

test('A STROKE IS ONE COMMAND, AND TAKING IT BACK RESTORES WHAT WAS THERE BEFORE IT', () => {
  const layer = createRepairLayer(8, 8);
  /* Something already painted, so "back to before" is not the same as "back to zero". */
  layer.texels.fill(0.25);
  const was = layer.texels.slice();

  const stroke = beginStroke(layer, { radius: 3, colour: [1, 0, 0, 1], strength: 0.5 });
  /*
   * **Dragged across the same texels several times**, which is what a gesture is and is the case
   * that catches a brush recording `before` on every touch: it would restore the half-painted
   * value from the middle of the stroke and leave the layer changed after an undo.
   */
  for (let step = 0; step <= 10; step += 1) paintAt(stroke, 2 + step * 0.2, 4);
  const painted = layer.texels.slice();
  expect(painted).not.toEqual(was);

  const command = endStroke(stroke);
  expect(command).not.toBeNull();
  if (command === null) return;
  expect(command.label).toContain('repair');

  command.revert();
  expect(Array.from(layer.texels)).toEqual(Array.from(was));
  /* And forward again, because an undo stack redoes by applying the same command. */
  command.apply();
  expect(Array.from(layer.texels)).toEqual(Array.from(painted));
});

test('a stroke that moved nothing is not an entry in the undo stack', () => {
  /*
   * **Null rather than an empty command.** A click on a texel the capture stands behind did
   * nothing, and an entry for it makes the *previous* action take two presses to take back —
   * which reads as an undo stack that has lost track of itself.
   */
  const layer = createRepairLayer(4, 4, new Float32Array(16).fill(1));
  const trusted = beginStroke(layer, WHITE);
  paintAt(trusted, 2, 2);
  expect(endStroke(trusted)).toBeNull();

  const outside = beginStroke(createRepairLayer(4, 4), WHITE);
  paintAt(outside, -8, -8);
  expect(endStroke(outside)).toBeNull();
});

test('the brush writes nothing outside the layer it was given', () => {
  const layer = createRepairLayer(3, 3);
  const stroke = beginStroke(layer, { radius: 4, colour: [1, 1, 1, 1], strength: 1 });
  paintAt(stroke, 0, 0);
  paintAt(stroke, 3, 3);
  expect(endStroke(stroke)).not.toBeNull();
  /* Nine texels of four, and every one of them is a number rather than whatever followed. */
  expect(layer.texels.length).toBe(36);
  for (const value of layer.texels) expect(Number.isFinite(value)).toBe(true);
});
