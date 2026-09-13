import { describe, expect, it } from 'vitest';

import { createAffine2D, screenToNdc, worldToNdc } from './camera2d.ts';

/** Apply the affine the way the vertex stage does, so a test never reads the matrix by eye. */
function apply(m: Float32Array, x: number, y: number): [number, number] {
  return [
    (m[0] as number) * x + (m[2] as number) * y + (m[4] as number),
    (m[1] as number) * x + (m[3] as number) * y + (m[5] as number),
  ];
}

describe('screenToNdc', () => {
  it('puts the top-left CSS pixel at the top-left of the frame', () => {
    const m = screenToNdc(800, 200, createAffine2D());
    const [x, y] = apply(m, 0, 0);
    expect(x).toBeCloseTo(-1, 6);
    expect(y).toBeCloseTo(1, 6);
  });

  it('puts the bottom-right CSS pixel at the bottom-right of the frame', () => {
    const m = screenToNdc(800, 200, createAffine2D());
    const [x, y] = apply(m, 800, 200);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(-1, 6);
  });

  /*
   * The viewport is deliberately not square. A screen-space affine that divided both axes by the
   * width would land every one of the corner assertions above and still stretch the picture, which
   * is the failure this convention exists to prevent.
   */
  it('scales the two axes by their own extents', () => {
    const m = screenToNdc(800, 200, createAffine2D());
    const [x] = apply(m, 400, 0);
    const [, y] = apply(m, 0, 50);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0.5, 6);
  });
});

describe('worldToNdc', () => {
  it('puts the camera on the middle of the frame', () => {
    const m = worldToNdc({ x: 12, y: -7, zoom: 4 }, 800, 200, createAffine2D());
    const [x, y] = apply(m, 12, -7);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('counts y upward, because a 2D world is not a screen', () => {
    const m = worldToNdc({ x: 0, y: 0, zoom: 10 }, 800, 200, createAffine2D());
    const [, y] = apply(m, 0, 1);
    expect(y).toBeGreaterThan(0);
  });

  it('measures zoom in pixels per world unit on each axis separately', () => {
    const m = worldToNdc({ x: 0, y: 0, zoom: 10 }, 800, 200, createAffine2D());
    const [x] = apply(m, 1, 0);
    const [, y] = apply(m, 0, 1);
    // Ten pixels of an 800-pixel viewport is 2 * 10 / 800 of the [-1, 1] range.
    expect(x).toBeCloseTo(0.025, 6);
    expect(y).toBeCloseTo(0.1, 6);
  });

  /*
   * A point off both axes at an angle that is not a multiple of a quarter turn, checked against an
   * expectation computed a different way. Anything axis-aligned passes with the matrix transposed,
   * and anything at a quarter turn passes with the sine's sign flipped.
   */
  it('turns the world the opposite way from the camera', () => {
    const rotation = 0.4;
    const m = worldToNdc({ x: 3, y: 5, zoom: 10, rotation }, 800, 200, createAffine2D());
    const [px, py] = [3 + 2, 5 + 1];
    const [dx, dy] = [px - 3, py - 5];
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const pixelsX = (dx * cos + dy * sin) * 10;
    const pixelsY = (-dx * sin + dy * cos) * 10;
    const [x, y] = apply(m, px, py);
    expect(x).toBeCloseTo((pixelsX * 2) / 800, 6);
    expect(y).toBeCloseTo((pixelsY * 2) / 200, 6);
  });

  it('fills the array it is handed and returns it, allocating nothing', () => {
    const out = createAffine2D();
    expect(worldToNdc({ x: 0, y: 0, zoom: 1 }, 4, 4, out)).toBe(out);
  });
});
