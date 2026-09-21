import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * What a caller measures is what gets drawn.
 *
 * **4.1.4 broke this and this is the repair.** That version made the draw path snap the cell
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
 * **Read out of the shipped draw paths rather than asserted about a number**, because the defect
 * was not a wrong value: it was the engine transforming one the caller had already measured
 * with. A `.mjs` beside the module because reading a file needs node types, which this package's
 * `src` config does not carry; `npm run test:scripts` runs it.
 */
const WEBGL2 = readFileSync(new URL('./textRenderer.ts', import.meta.url), 'utf8');
const WEBGPU = readFileSync(new URL('./backend/webgpu/renderer.ts', import.meta.url), 'utf8');

test('THE CELL DRAWN IS THE CELL ASKED FOR, because a measured width is the only layout a consumer has', () => {
  const upload = /uCellSize'\],\s*([^,)]+)\)/.exec(WEBGL2);
  assert.ok(upload, 'the WebGL2 path uploads a cell size');
  assert.match(upload[1], /style\.cellSize/, 'and it is the caller\u2019s own cell, untransformed');
  assert.doesNotMatch(upload[1], /deviceSnapped/, 'nothing snaps it on the caller\u2019s behalf');
});

test('AND THE SAME ON WEBGPU, because a size is a decision and not a binding', () => {
  assert.match(
    WEBGPU,
    /at\('uCellSize'\), style\.cellSize\)/,
    'the second backend draws the caller\u2019s cell too',
  );
  assert.doesNotMatch(
    WEBGPU,
    /deviceSnappedCellSize/,
    'and does not snap what the first one stopped snapping',
  );
});

test('THE ORIGIN SNAP STAYS, because a position that moves half a device pixel breaks no layout', () => {
  /* The cell is a size a consumer measures with; the origin is not. Rounding it to the nearest
     device pixel keeps a stroke off a pixel boundary and shifts a line by at most half of one,
     against the 40-odd pixels the cell snap was moving a centred line by. */
  assert.match(WEBGL2, /deviceSnappedOrigin/, 'WebGL2 still snaps the origin');
  assert.match(WEBGPU, /deviceSnappedOrigin/, 'and so does WebGPU');
});
