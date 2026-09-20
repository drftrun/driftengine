import { expect, test } from 'vitest';

import {
  composeInterface,
  createProjection,
  fillHoles,
  frameGenLatency,
  projectForward,
  resolveGenerated,
  type FrameImage,
} from './frameGen.ts';

/**
 * A frame generated between two rendered ones, and what it must never do.
 *
 * **Every case is a strip one pixel tall**, so where each surface lands can be worked out by hand:
 * a wall at depth 10 behind an object at depth 2 that moves along the strip. Colours are single
 * numbers repeated across the three channels, so a pixel's colour names the surface it came from.
 */

const WALL = 0.2;
const OBJECT = 0.9;
const FAR = 10;
const NEAR = 2;

/**
 * A strip `width` wide with the object at `at`, `size` pixels long, having moved `moved` pixels
 * since the frame before — so its motion points `-moved` back along the strip, and the wall's is
 * zero.
 */
function strip(
  width: number,
  at: number,
  size: number,
  moved: number,
  wall = WALL,
  object = OBJECT,
): FrameImage {
  const colour = new Float32Array(width * 4);
  const depth = new Float32Array(width);
  const motion = new Float32Array(width * 2);
  for (let x = 0; x < width; x += 1) {
    const inside = x >= at && x < at + size;
    const value = inside ? object : wall;
    colour.set([value, value, value, 1], x * 4);
    depth[x] = inside ? NEAR : FAR;
    motion[x * 2] = inside ? -moved : 0;
  }
  return { width, height: 1, colour, depth, motion };
}

function reds(image: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < image.length; i += 4) out.push(Math.round((image[i] as number) * 100) / 100);
  return out;
}

function generate(before: FrameImage, after: FrameImage, t: number) {
  const projection = createProjection(after.width, after.height);
  projectForward(after.motion, after.depth, t, projection);
  /* Filled with a value no surface has, so a pixel nothing wrote is visible as that value. */
  const out = new Float32Array(after.width * 4).fill(-1);
  const mask = new Uint8Array(after.width);
  resolveGenerated(projection, before, after, t, out, mask);
  fillHoles(out, before, after, mask);
  return { out, mask };
}

test('AT t = 0 THE GENERATED FRAME IS THE EARLIER ONE, AND AT t = 1 THE LATER', () => {
  /* The object moves two pixels right, from 1–2 to 3–4. */
  const before = strip(7, 1, 2, 0);
  const after = strip(7, 3, 2, 2);
  expect(reds(generate(before, after, 0).out)).toEqual(reds(before.colour));
  expect(reds(generate(before, after, 1).out)).toEqual(reds(after.colour));
});

test('a surface visible in both frames takes its colour from the nearer in time', () => {
  /* The same wall and object, lit differently in the two frames: which frame a pixel came from is
     in its colour. Halfway along, the object stands at 2–3. */
  const before = strip(7, 1, 2, 0, 0.2, 0.9);
  const after = strip(7, 3, 2, 2, 0.3, 0.8);
  const early = generate(before, after, 0.2).out;
  const late = generate(before, after, 0.8).out;
  /* Early: the wall at 0 and the object from the earlier frame. The object has moved 0.4 of a
     pixel, which rounds to where it was; late, 1.6, which rounds to where it is going. Neither is
     a tie, so neither depends on which way a half rounds. */
  expect(reds(early)[0]).toBe(0.2);
  expect(reds(early)[1]).toBe(0.9);
  expect(reds(late)[0]).toBe(0.3);
  expect(reds(late)[4]).toBe(0.8);
});

test('A SURFACE THE EARLIER FRAME HID TAKES THE LATER FRAME’S COLOUR, however early', () => {
  /*
   * The object leaves 0–1 for 4–5. At t = 0.2 the wall at 0 is where the later frame shows it and
   * the object has not yet moved off it by a whole pixel's rounding — but the earlier frame shows
   * the object there, not the wall. Its colour is the object's, and taking it would paint the
   * object where the wall is: the later frame is the only one that saw this wall.
   */
  const before = strip(8, 0, 2, 0);
  const after = strip(8, 4, 2, 4);
  const { out } = generate(before, after, 0.2);
  expect(reds(out)[0]).toBe(WALL);
  /* And the object, which both frames show, from the earlier one: it moved 0.8 of a pixel. */
  expect(reds(out)[1]).toBe(OBJECT);
});

test('A REGION NEITHER FRAME PROJECTS INTO IS FILLED AND MARKED, not left as the buffer was', () => {
  /*
   * Four pixels of travel from 0–1 to 4–5. Halfway, the object is at 2–3; pixels 4 and 5 are wall
   * in the earlier frame and object in the later, so no surface of the later frame lands there. They
   * are filled with the farther of the two frames' surfaces — the wall the object uncovered.
   */
  const before = strip(8, 0, 2, 0);
  const after = strip(8, 4, 2, 4);
  const { out, mask } = generate(before, after, 0.5);
  expect(reds(out)).toEqual([WALL, WALL, OBJECT, OBJECT, WALL, WALL, WALL, WALL]);
  expect(Array.from(mask)).toEqual([0, 0, 0, 0, 1, 1, 0, 0]);
  expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
});

test('THE INTERFACE IS NOT IN THE GENERATED FRAME: a static overlay over a moving world is untouched', () => {
  /*
   * The world moves under a panel that does not. Were the panel part of what is projected, it
   * would move with the object's motion wherever the two overlap; composited afterwards from the
   * interface's own layer, it is exactly the panel, at every pixel it covers.
   */
  const before = strip(8, 0, 3, 0);
  const after = strip(8, 4, 3, 4);
  const { out } = generate(before, after, 0.5);
  const panel = new Float32Array(8 * 4);
  /* Opaque over 1–2, half over 5, nothing elsewhere; premultiplied. */
  panel.set([0.5, 0.5, 0.5, 1], 1 * 4);
  panel.set([0.5, 0.5, 0.5, 1], 2 * 4);
  panel.set([0.25, 0.25, 0.25, 0.5], 5 * 4);
  composeInterface(out, panel);
  expect(reds(out)[1]).toBe(0.5);
  expect(reds(out)[2]).toBe(0.5);
  /* Half the panel over the wall the object uncovered at 5 — it stands at 2–4 halfway. */
  expect(reds(out)[5]).toBe(Math.round((0.25 + WALL / 2) * 100) / 100);
  expect(reds(out)[0]).toBe(WALL);
});

test('the latency it adds is stated: the generation, and the display intervals a frame is held back', () => {
  /*
   * At twice the render rate a rendered frame waits for the one generated before it: one display
   * interval, 1000 / 120 ms, and the generation. At three times it waits for two. At the render
   * rate nothing is generated and nothing is added.
   */
  expect(frameGenLatency(120, 60, 0.5)).toBeCloseTo(1000 / 120 + 0.5, 9);
  expect(frameGenLatency(180, 60, 0.5)).toBeCloseTo(2000 / 180 + 0.5, 9);
  expect(frameGenLatency(60, 60, 0.5)).toBe(0);
  expect(() => frameGenLatency(144, 60, 0.5)).toThrow(/whole multiple/);
});
