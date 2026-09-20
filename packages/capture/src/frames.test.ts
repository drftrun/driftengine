import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { eachFrame, selectFrames, type FrameSource } from './frames.ts';

/**
 * **A clip reaches the engine through a seam the host owns.** The engine never opens a file: it is
 * handed a `FrameSource` and reads it one frame at a time, in order, into a buffer of its own —
 * a minute of 1080p is eight gigabytes of pixels, so the frames a capture keeps are chosen while
 * the rest go past.
 *
 * The stub below is that seam's other side: frames drawn from a seed, panning by a given step, so a
 * slow pan and a fast one are the same clip at different speeds.
 */

/**
 * A clip of frames, each the one before shifted right by `steps[i]` pixels, over a scene that is a
 * smooth ramp and a little seeded noise — **smooth because a pan over noise decorrelates at one
 * pixel**, so noise alone would measure a slow pan and a fast one as the same motion.
 */
function panning(width: number, height: number, steps: readonly number[]): FrameSource {
  const random = mulberry32(20260920);
  const wide = width * 8;
  const scene = new Uint8Array(wide * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        const ramp = (x * 3 + y * 5 + c * 17) % 512;
        const value = ramp < 256 ? ramp : 511 - ramp;
        scene[(y * wide + x) * 4 + c] = value + ((random() * 4) | 0);
      }
    }
  }
  let total = 0;
  const offsets = [0, ...steps.map((step) => (total += step))];
  return {
    frameCount: () => offsets.length,
    frameAt(index, out) {
      if (out.length >= width * height * 4) {
        const left = offsets[index] as number;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            for (let c = 0; c < 4; c += 1) {
              out[(y * width + x) * 4 + c] = scene[(y * wide + x + left) * 4 + c] as number;
            }
          }
        }
      }
      return { width, height };
    },
  };
}

test('A CLIP IS READ ONE FRAME AT A TIME, IN ORDER, and its bytes come through unchanged', async () => {
  const source = panning(8, 4, [3, 3, 3]);
  const seen: { index: number; first: number; width: number; height: number }[] = [];
  const buffers = new Set<Uint8Array>();
  await eachFrame(source, (index, pixels, width, height) => {
    buffers.add(pixels);
    seen.push({ index, first: pixels[0] as number, width, height });
  });
  expect(seen.map((frame) => frame.index)).toEqual([0, 1, 2, 3]);
  expect(seen.every((frame) => frame.width === 8 && frame.height === 4)).toBe(true);
  /* One buffer for the whole clip: a frame is read over the last one. */
  expect(buffers.size).toBe(1);
  /* The bytes are the source's own: frame 0's first pixel is the scene's. */
  const mine = new Uint8Array(8 * 4 * 4);
  source.frameAt(0, mine);
  expect(seen[0]?.first).toBe(mine[0]);
});

test('a source of no frames is an empty capture rather than a throw', async () => {
  const empty: FrameSource = { frameCount: () => 0, frameAt: () => ({ width: 0, height: 0 }) };
  const seen: number[] = [];
  await eachFrame(empty, (index) => seen.push(index));
  expect(seen).toEqual([]);
  expect(await selectFrames(empty, { budget: 8 })).toEqual([]);
});

test('SELECTION BY PARALLAX KEEPS WHAT A SLOW PAN NEEDS AND DROPS THE REST', async () => {
  /*
   * Thirteen frames: six pans of one pixel, then six of six. The motion is 42 pixels' worth, so at
   * a budget of five the frames stand 10.5 apart — frame 7 is the first past that, frame 9 the
   * next, frame 11 the next, and the slow half gives up every frame it has.
   */
  const clip = panning(16, 8, [1, 1, 1, 1, 1, 1, 6, 6, 6, 6, 6, 6]);
  expect(await selectFrames(clip, { budget: 5 })).toEqual([0, 7, 9, 11]);
  /* At a budget of three they stand 21 apart, which is the whole slow half and three fast ones. */
  expect(await selectFrames(clip, { budget: 3 })).toEqual([0, 9]);
});

test('a clip that never moves is one frame, and a clip within the budget is not read at all', async () => {
  expect(await selectFrames(panning(8, 4, [0, 0, 0, 0]), { budget: 4 })).toEqual([0]);
  /* Nothing to choose, so nothing is decoded: the budget already covers the clip. */
  const refuses: FrameSource = {
    frameCount: () => 3,
    frameAt: () => {
      throw new Error('a frame was read');
    },
  };
  expect(await selectFrames(refuses, { budget: 8 })).toEqual([0, 1, 2]);
  expect(await selectFrames(refuses, { every: 2, budget: 8 })).toEqual([0, 2]);
});

test('every Nth frame is the other way to choose, bounded by the same budget', async () => {
  expect(await selectFrames(panning(8, 4, [1, 1, 1, 1, 1, 1, 1]), { every: 3, budget: 8 })).toEqual(
    [0, 3, 6],
  );
  expect(await selectFrames(panning(8, 4, [1, 1, 1, 1, 1, 1, 1]), { every: 2, budget: 3 })).toEqual(
    [0, 2, 4],
  );
});
