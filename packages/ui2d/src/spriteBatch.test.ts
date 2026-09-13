import { describe, expect, it } from 'vitest';

import {
  SPRITE_FLOATS,
  createSpriteBatch,
  drawSprite,
  resetSpriteBatch,
  spriteRun,
} from './spriteBatch.ts';
import type { SpriteBatch } from './spriteBatch.ts';

/** Where a local corner of instance `i` lands, read the way the vertex stage reads it. */
function corner(batch: SpriteBatch, i: number, cx: number, cy: number): [number, number] {
  const at = i * SPRITE_FLOATS;
  const f = batch.instances;
  const ax = f[at] as number;
  const ay = f[at + 1] as number;
  const bx = f[at + 2] as number;
  const by = f[at + 3] as number;
  const ox = f[at + 12] as number;
  const oy = f[at + 13] as number;
  return [ox + ax * cx + bx * cy, oy + ay * cx + by * cy];
}

function uv(batch: SpriteBatch, i: number): number[] {
  const at = i * SPRITE_FLOATS + 4;
  return Array.from(batch.instances.subarray(at, at + 4));
}

function tintOf(batch: SpriteBatch, i: number): number[] {
  const at = i * SPRITE_FLOATS + 8;
  return Array.from(batch.instances.subarray(at, at + 4));
}

describe('drawSprite', () => {
  it('places an unrotated sprite over the rectangle it was given', () => {
    const batch = createSpriteBatch(4);
    drawSprite(batch, 0, { x: 10, y: 20, w: 30, h: 40 }, null, null);
    expect(corner(batch, 0, 0, 0)).toEqual([10, 20]);
    expect(corner(batch, 0, 1, 1)).toEqual([40, 60]);
  });

  it('covers the whole texture and draws white when told nothing else', () => {
    const batch = createSpriteBatch(4);
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    expect(uv(batch, 0)).toEqual([0, 0, 1, 1]);
    expect(tintOf(batch, 0)).toEqual([1, 1, 1, 1]);
  });

  it('carries the frame and the tint it was given', () => {
    const batch = createSpriteBatch(4);
    const frame = { u0: 0.25, v0: 0.5, u1: 0.375, v1: 0.75 };
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, frame, [1, 0.5, 0.25, 0.125]);
    expect(uv(batch, 0)).toEqual([0.25, 0.5, 0.375, 0.75]);
    expect(tintOf(batch, 0)).toEqual([1, 0.5, 0.25, 0.125]);
  });

  /*
   * A quarter turn about the default pivot, on a rectangle that is not a square, checked corner by
   * corner. A square would pass with the two edge vectors swapped, and a pivot at the origin would
   * pass every assertion about the shape while putting the sprite somewhere else entirely.
   */
  it('turns a sprite about its own centre', () => {
    const batch = createSpriteBatch(4);
    drawSprite(batch, 0, { x: 0, y: 0, w: 40, h: 10, rotation: Math.PI / 2 }, null, null);
    const [cx, cy] = corner(batch, 0, 0.5, 0.5);
    expect(cx).toBeCloseTo(20, 5);
    expect(cy).toBeCloseTo(5, 5);
    // The local +x edge is 40 long and, turned a quarter turn anticlockwise, points along +y.
    const [x0, y0] = corner(batch, 0, 0, 0.5);
    const [x1, y1] = corner(batch, 0, 1, 0.5);
    expect(x1 - x0).toBeCloseTo(0, 5);
    expect(y1 - y0).toBeCloseTo(40, 5);
    /*
     * And the +y edge points along −x, which is the half a mirrored rotation gets right. Flipping
     * the sine's sign on this edge alone leaves every assertion above standing and draws the sprite
     * turned the other way.
     */
    const [x2, y2] = corner(batch, 0, 0.5, 0);
    const [x3, y3] = corner(batch, 0, 0.5, 1);
    expect(x3 - x2).toBeCloseTo(-10, 5);
    expect(y3 - y2).toBeCloseTo(0, 5);
  });

  it('turns about a pivot the caller names instead', () => {
    const batch = createSpriteBatch(4);
    drawSprite(
      batch,
      0,
      { x: 100, y: 200, w: 40, h: 10, rotation: 1.1, pivotX: 0, pivotY: 0 },
      null,
      null,
    );
    // The pivot is the sprite's own (x, y) corner, so that corner cannot have moved.
    const [x, y] = corner(batch, 0, 0, 0);
    expect(x).toBeCloseTo(100, 5);
    expect(y).toBeCloseTo(200, 5);
  });

  it('preserves length under rotation, on both edges', () => {
    const batch = createSpriteBatch(4);
    drawSprite(batch, 0, { x: 3, y: 7, w: 40, h: 10, rotation: 0.37 }, null, null);
    const [ax, ay] = [
      corner(batch, 0, 1, 0)[0] - corner(batch, 0, 0, 0)[0],
      corner(batch, 0, 1, 0)[1] - corner(batch, 0, 0, 0)[1],
    ];
    const [bx, by] = [
      corner(batch, 0, 0, 1)[0] - corner(batch, 0, 0, 0)[0],
      corner(batch, 0, 0, 1)[1] - corner(batch, 0, 0, 0)[1],
    ];
    expect(Math.hypot(ax, ay)).toBeCloseTo(40, 5);
    expect(Math.hypot(bx, by)).toBeCloseTo(10, 5);
    // Still a rectangle: the two edges stay perpendicular.
    expect(ax * bx + ay * by).toBeCloseTo(0, 5);
  });
});

describe('runs', () => {
  it('draws two sprites on one texture in one run', () => {
    const batch = createSpriteBatch(4);
    drawSprite(batch, 3, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(batch, 3, { x: 1, y: 0, w: 1, h: 1 }, null, null);
    expect(batch.runCount).toBe(1);
    expect(spriteRun(batch, 0)).toEqual({ texture: 3, first: 0, count: 2 });
  });

  /*
   * The third run is the assertion that matters. A batch that grouped by texture would answer two
   * runs here and draw the same pixels in a different order, which is the one thing an immediate
   * 2D API may not do: submission order *is* the layering, and there is no depth to fall back on.
   */
  it('starts a new run at every texture change, and never regroups', () => {
    const batch = createSpriteBatch(8);
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(batch, 1, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    expect(batch.runCount).toBe(3);
    expect(spriteRun(batch, 0)).toEqual({ texture: 0, first: 0, count: 1 });
    expect(spriteRun(batch, 1)).toEqual({ texture: 1, first: 1, count: 1 });
    expect(spriteRun(batch, 2)).toEqual({ texture: 0, first: 2, count: 1 });
  });
});

describe('capacity', () => {
  it('drops what will not fit and counts it, rather than growing under a frame', () => {
    const batch = createSpriteBatch(2);
    for (let i = 0; i < 5; i += 1) {
      drawSprite(batch, 0, { x: i, y: 0, w: 1, h: 1 }, null, null);
    }
    expect(batch.count).toBe(2);
    expect(batch.dropped).toBe(3);
    expect(batch.instances.length).toBe(2 * SPRITE_FLOATS);
  });

  it('drops rather than opening a run it cannot fill', () => {
    const batch = createSpriteBatch(1);
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(batch, 1, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    expect(batch.runCount).toBe(1);
    expect(batch.dropped).toBe(1);
  });

  it('reuses its storage across frames', () => {
    const batch = createSpriteBatch(4);
    const storage = batch.instances;
    drawSprite(batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    resetSpriteBatch(batch);
    expect(batch.count).toBe(0);
    expect(batch.runCount).toBe(0);
    expect(batch.dropped).toBe(0);
    expect(batch.instances).toBe(storage);
  });
});
