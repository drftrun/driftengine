import { expect, test } from 'vitest';

import {
  createFeatureSet,
  describeFeatures,
  detectFeatures,
  matchFeatures,
  type FeatureSet,
} from './features.ts';
import { lookAt, renderTestScene, type TestCamera, type TestScene } from './testScene.ts';

/**
 * **A corner is worth detecting when it is the same corner next frame.** So these do not assert
 * where a feature lands — a detector is allowed its own opinion — but that the opinion survives
 * what a clip does to a scene: the camera turns a little, the exposure changes, and most of the
 * corners found before are found again within a pixel or two, and matched to each other.
 *
 * The scene is `testScene.ts`'s, rendered at two poses, so every answer is known beforehand.
 */

const SCENE: TestScene = {
  boxes: [
    { min: [-0.5, -0.5, 4], max: [0.5, 0.5, 5], seed: 1 },
    { min: [-3, -1, 6], max: [-1, 1, 8], seed: 2 },
    { min: [1.2, -1, 5], max: [2.4, 0.6, 6.5], seed: 5 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.5, seed: 3 }],
};
const WIDTH = 160;
const HEIGHT = 120;
const BUDGET = 300;

const view = (
  eye: readonly [number, number, number],
  at: readonly [number, number, number],
): TestCamera => ({
  width: WIDTH,
  height: HEIGHT,
  intrinsics: [150, 150, WIDTH / 2, HEIGHT / 2],
  worldToCamera: lookAt(eye, at),
});

const render = (camera: TestCamera, gain = 1): Uint8Array => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  renderTestScene(SCENE, camera, pixels);
  if (gain !== 1) {
    for (let at = 0; at < pixels.length; at += 4) {
      for (let c = 0; c < 3; c += 1) {
        pixels[at + c] = Math.min(255, Math.round((pixels[at + c] as number) * gain));
      }
    }
  }
  return pixels;
};

const found = (pixels: Uint8Array): FeatureSet => {
  const features = createFeatureSet(BUDGET);
  detectFeatures(pixels, WIDTH, HEIGHT, features, BUDGET);
  return features;
};

/** How many of `a`'s features have one of `b`'s within `distance` pixels. */
function repeated(a: FeatureSet, b: FeatureSet, distance: number): number {
  let count = 0;
  for (let i = 0; i < a.count; i += 1) {
    for (let j = 0; j < b.count; j += 1) {
      const dx = (a.x[i] as number) - (b.x[j] as number);
      const dy = (a.y[i] as number) - (b.y[j] as number);
      if (dx * dx + dy * dy <= distance * distance) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

test('A DETECTOR FINDS CORNERS, and finds them again when the camera moves a little', () => {
  const first = found(render(view([0, 0, 0], [0, 0, 4.5])));
  expect(first.count).toBeGreaterThan(80);
  /* Every feature is inside the frame and none is on top of another. */
  for (let i = 0; i < first.count; i += 1) {
    expect(first.x[i]).toBeGreaterThanOrEqual(0);
    expect(first.x[i]).toBeLessThan(WIDTH);
    expect(first.y[i]).toBeGreaterThanOrEqual(0);
    expect(first.y[i]).toBeLessThan(HEIGHT);
  }
  /* A step of four centimetres and a degree of turn: most corners are the same corners. */
  const moved = found(render(view([0.04, 0.01, 0.02], [0, 0.005, 4.5])));
  expect(repeated(first, moved, 2.5) / first.count).toBeGreaterThan(0.6);
});

test('a brighter frame is the same frame: the corners survive the exposure changing', () => {
  const pixels = render(view([0, 0, 0], [0, 0, 4.5]));
  const plain = found(pixels);
  const brighter = found(render(view([0, 0, 0], [0, 0, 4.5]), 1.25));
  expect(repeated(plain, brighter, 1) / plain.count).toBeGreaterThan(0.9);
});

test('DESCRIPTORS MATCH A PAIR OF VIEWS, and the ratio test throws away what it cannot tell apart', () => {
  const firstPixels = render(view([0, 0, 0], [0, 0, 4.5]));
  const secondPixels = render(view([0.12, 0.03, 0.05], [0, 0.01, 4.5]));
  const first = found(firstPixels);
  const second = found(secondPixels);
  const a = describeFeatures(firstPixels, WIDTH, HEIGHT, first);
  const b = describeFeatures(secondPixels, WIDTH, HEIGHT, second);
  const matches = new Int32Array(2 * Math.min(first.count, second.count));
  const count = matchFeatures(a, b, matches, { ratio: 0.8 });
  expect(count).toBeGreaterThan(30);

  /* A match is right when the two features are near each other: the step is small. */
  let near = 0;
  for (let m = 0; m < count; m += 1) {
    const i = matches[m * 2] as number;
    const j = matches[m * 2 + 1] as number;
    const dx = (first.x[i] as number) - (second.x[j] as number);
    const dy = (first.y[i] as number) - (second.y[j] as number);
    if (Math.sqrt(dx * dx + dy * dy) < 6) near += 1;
  }
  expect(near / count).toBeGreaterThan(0.8);

  /* A stricter ratio keeps fewer and is at least as right; a looser one keeps more. */
  const strict = new Int32Array(matches.length);
  const strictCount = matchFeatures(a, b, strict, { ratio: 0.6 });
  const loose = new Int32Array(matches.length);
  const looseCount = matchFeatures(a, b, loose, { ratio: 0.95 });
  expect(strictCount).toBeLessThan(count);
  expect(looseCount).toBeGreaterThan(count);
});

test('matching is its own answer twice over: the same frames give the same matches', () => {
  const firstPixels = render(view([0, 0, 0], [0, 0, 4.5]));
  const secondPixels = render(view([0.1, 0, 0], [0, 0, 4.5]));
  const first = found(firstPixels);
  const second = found(secondPixels);
  const a = describeFeatures(firstPixels, WIDTH, HEIGHT, first);
  const b = describeFeatures(secondPixels, WIDTH, HEIGHT, second);
  const once = new Int32Array(2 * BUDGET);
  const twice = new Int32Array(2 * BUDGET);
  const count = matchFeatures(a, b, once, {});
  expect(matchFeatures(a, b, twice, {})).toBe(count);
  expect(Array.from(twice.subarray(0, count * 2))).toEqual(Array.from(once.subarray(0, count * 2)));
});

test('AN EDGE IS NOT A CORNER, and neither is a wall', () => {
  /*
   * A single straight edge: bright on one side, dark on the other. The gradient is strong across it
   * and nothing along it, so the weaker direction barely moves — a detector that took the stronger
   * eigenvalue instead would find the whole edge.
   */
  const edge = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = x < WIDTH / 2 ? 40 : 210;
      edge.set([value, value, value, 255], (y * WIDTH + x) * 4);
    }
  }
  const onEdge = createFeatureSet(BUDGET);
  detectFeatures(edge, WIDTH, HEIGHT, onEdge, BUDGET);
  expect(onEdge.count).toBe(0);

  /*
   * And a wall is no corner at all. It carries a level of noise, as a sensor's does, so the
   * strongest response in the frame is a rounding — and a threshold that is only a share of the
   * strongest would answer with a field of corners made of that noise.
   */
  const wall = new Uint8Array(WIDTH * HEIGHT * 4);
  const hash = (n: number): number => {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  };
  for (let at = 0; at < WIDTH * HEIGHT; at += 1) {
    /* Uncorrelated, so it is noise rather than a pattern: a stripe has no corners to reject. */
    const value = 128 + (hash(at) % 3) - 1;
    wall.set([value, value, value, 255], at * 4);
  }
  const onWall = createFeatureSet(BUDGET);
  detectFeatures(wall, WIDTH, HEIGHT, onWall, BUDGET);
  expect(onWall.count).toBe(0);
});

test('two features never sit on top of each other, even where the image ties', () => {
  /* A checkerboard ties response against response; the suppression must still keep one of each. */
  const board = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 30 : 220;
      board.set([value, value, value, 255], (y * WIDTH + x) * 4);
    }
  }
  const features = createFeatureSet(BUDGET);
  detectFeatures(board, WIDTH, HEIGHT, features, BUDGET);
  expect(features.count).toBeGreaterThan(50);
  /* Each kept corner is the strongest within three pixels, so no two are nearer than that. */
  for (let i = 0; i < features.count; i += 1) {
    for (let j = i + 1; j < features.count; j += 1) {
      const dx = (features.x[i] as number) - (features.x[j] as number);
      const dy = (features.y[i] as number) - (features.y[j] as number);
      expect(Math.max(Math.abs(dx), Math.abs(dy)), `${i} against ${j}`).toBeGreaterThan(3);
    }
  }
});

test('A DESCRIPTION TURNS WITH ITS FEATURE, so a rolled camera still matches', () => {
  /* The same viewpoint, the camera rolled by twenty degrees about its own axis. */
  const roll = (degrees: number): TestCamera => {
    const radians = (degrees * Math.PI) / 180;
    return {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: [150, 150, WIDTH / 2, HEIGHT / 2],
      worldToCamera: lookAt([0, 0, 0], [0, 0, 4.5], [Math.sin(radians), Math.cos(radians), 0]),
    };
  };
  const firstPixels = render(roll(0));
  const rolledPixels = render(roll(20));
  const first = found(firstPixels);
  const rolled = found(rolledPixels);
  const a = describeFeatures(firstPixels, WIDTH, HEIGHT, first);
  const b = describeFeatures(rolledPixels, WIDTH, HEIGHT, rolled);
  const matches = new Int32Array(2 * BUDGET);
  const count = matchFeatures(a, b, matches, { ratio: 0.85 });
  expect(count).toBeGreaterThan(20);
  /* A match is right when the two lie where the roll puts them: about the frame's centre. */
  let right = 0;
  const radians = (20 * Math.PI) / 180;
  for (let m = 0; m < count; m += 1) {
    const i = matches[m * 2] as number;
    const j = matches[m * 2 + 1] as number;
    const dx = (first.x[i] as number) - WIDTH / 2;
    const dy = (first.y[i] as number) - HEIGHT / 2;
    const turnedX = Math.cos(radians) * dx + Math.sin(radians) * dy + WIDTH / 2;
    const turnedY = -Math.sin(radians) * dx + Math.cos(radians) * dy + HEIGHT / 2;
    const offX = turnedX - (rolled.x[j] as number);
    const offY = turnedY - (rolled.y[j] as number);
    if (Math.sqrt(offX * offX + offY * offY) < 4) right += 1;
  }
  expect(right / count).toBeGreaterThan(0.6);
});

test('a match is mutual: matching the other way round answers the same pairs', () => {
  const firstPixels = render(view([0, 0, 0], [0, 0, 4.5]));
  const secondPixels = render(view([0.12, 0.03, 0.05], [0, 0.01, 4.5]));
  const first = found(firstPixels);
  const second = found(secondPixels);
  const a = describeFeatures(firstPixels, WIDTH, HEIGHT, first);
  const b = describeFeatures(secondPixels, WIDTH, HEIGHT, second);
  const forward = new Int32Array(2 * BUDGET);
  const backward = new Int32Array(2 * BUDGET);
  const count = matchFeatures(a, b, forward, {});
  const other = matchFeatures(b, a, backward, {});
  expect(other).toBe(count);
  const pairs = new Set<string>();
  for (let m = 0; m < count; m += 1) pairs.add(`${forward[m * 2]}:${forward[m * 2 + 1]}`);
  for (let m = 0; m < other; m += 1) {
    expect(pairs.has(`${backward[m * 2 + 1]}:${backward[m * 2]}`)).toBe(true);
  }
});
