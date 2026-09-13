import { expect, test } from 'vitest';
import { drawingBufferSize, fitToPixelBudget } from './drawingBuffer.ts';
import type { BufferSize } from './drawingBuffer.ts';

/** The caller owns the result object; every case here reuses one, as the renderer does. */
function fit(width: number, height: number, maxPixels: number): BufferSize {
  const out: BufferSize = { width: 0, height: 0 };
  fitToPixelBudget(width, height, maxPixels, out);
  return out;
}

test('a box inside its budget is left exactly alone', () => {
  /*
   * The common case, and it has to be *exact*: a drawing buffer that came back one
   * pixel different from the CSS box would reallocate the canvas and every target
   * sized from it, every frame, forever.
   */
  expect(fit(3840, 2160, 12_000_000)).toEqual({ width: 3840, height: 2160 });
  expect(fit(1920, 1080, 12_000_000)).toEqual({ width: 1920, height: 1080 });
});

test('zero means uncapped, however large the box', () => {
  // The escape hatch the settings screen offers. Not "a budget of nothing".
  expect(fit(7680, 4320, 0)).toEqual({ width: 7680, height: 4320 });
});

test('an oversized box is scaled under its budget, never over it', () => {
  const out = fit(5120, 2880, 8_000_000);
  expect(out.width * out.height).toBeLessThanOrEqual(8_000_000);
  // And it actually used most of what it was given, rather than being timid.
  expect(out.width * out.height).toBeGreaterThan(7_500_000);
});

test('scaling preserves the aspect ratio the camera composed for', () => {
  /*
   * `Renderer.aspect` is read off the drawing buffer, so a budget that squeezed one
   * axis would change what the shot frames rather than how sharp it is.
   */
  const out = fit(5120, 2880, 6_000_000);
  expect(out.width / out.height).toBeCloseTo(5120 / 2880, 2);
});

test('a budget below one pixel still yields a buffer WebGL will accept', () => {
  // Hand-edited or corrupt storage. A zero-sized drawing buffer is a GL error, not
  // a small picture, so the floor is honoured ahead of the budget and says so.
  const out = fit(1920, 1080, 1);
  expect(out.width).toBeGreaterThanOrEqual(2);
  expect(out.height).toBeGreaterThanOrEqual(2);
});

test('a negative or non-finite budget is treated as uncapped rather than as an error', () => {
  // `resize` runs every frame and must never throw. See AGENTS.md.
  expect(fit(1920, 1080, -5)).toEqual({ width: 1920, height: 1080 });
  expect(fit(1920, 1080, Number.NaN)).toEqual({ width: 1920, height: 1080 });
});

test('the result is whole pixels', () => {
  const out = fit(5121, 2881, 7_000_000);
  expect(Number.isInteger(out.width)).toBe(true);
  expect(Number.isInteger(out.height)).toBe(true);
});

/** As `Renderer.resize` calls it: a CSS box, a clamped DPR, a lock, a budget. */
function sized(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  lockedWidth: number,
  lockedHeight: number,
  maxPixels: number,
): BufferSize {
  const out: BufferSize = { width: 0, height: 0 };
  drawingBufferSize(cssWidth, cssHeight, dpr, lockedWidth, lockedHeight, maxPixels, out);
  return out;
}

test('an export lock is handed back exactly, whatever the budget says', () => {
  /*
   * The rule this file exists to protect. A clip is the size the export asked for, and
   * `Renderer.aspect` follows the lock so the replay's shots are composed for the file —
   * so a budget reaching a locked buffer would both write a file that lies about its own
   * dimensions and re-frame every shot in it. The budget here is a twentieth of the lock
   * on purpose: nothing about it may show up in the answer.
   */
  expect(sized(1280, 720, 2, 1080, 1920, 100_000)).toEqual({ width: 1080, height: 1920 });
  // And uncapped, which is the same answer by a different route.
  expect(sized(1280, 720, 2, 1080, 1920, 0)).toEqual({ width: 1080, height: 1920 });
});

test('a lock ignores the display density too, not only the budget', () => {
  // A lock is in device pixels already. Multiplying it by somebody's DPR would make the
  // same export a different size on a retina machine.
  expect(sized(1280, 720, 3, 1080, 1920, 12_000_000)).toEqual({ width: 1080, height: 1920 });
});

test('a half-set lock is not a lock', () => {
  // Both sides or neither: `unlockDrawingBuffer` zeroes the pair, and a single stray
  // value must not pin one axis and leave the other following the window.
  expect(sized(1280, 720, 1, 1080, 0, 0)).toEqual({ width: 1280, height: 720 });
  expect(sized(1280, 720, 1, 0, 1920, 0)).toEqual({ width: 1280, height: 720 });
});

test('unlocked, the CSS box is scaled by DPR and then fitted under the budget', () => {
  expect(sized(1280, 720, 2, 0, 0, 0)).toEqual({ width: 2560, height: 1440 });
  const capped = sized(2560, 1440, 2, 0, 0, 8_000_000);
  expect(capped.width * capped.height).toBeLessThanOrEqual(8_000_000);
  expect(capped.width).toBeLessThan(5120);
});
