import { expect, test } from 'vitest';

import { lookAt, renderTestScene, type TestCamera, type TestScene } from './testScene.ts';

/**
 * **A scene whose answers are known before it is rendered**, which is what every later task's
 * fixtures are held to: a camera at a stated pose sees a box at a stated distance, and a step to
 * the side moves it by a parallax the geometry says it must. The renderer is a ray cast, so the
 * depth it writes is the distance itself rather than something interpolated.
 */

const SCENE: TestScene = {
  boxes: [
    { min: [-0.5, -0.5, 4], max: [0.5, 0.5, 5], seed: 1 },
    { min: [-3, -1, 6], max: [-1, 1, 8], seed: 2 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.5, seed: 3 }],
};

const camera = (x: number, y: number, z: number): TestCamera => ({
  width: 64,
  height: 48,
  intrinsics: [60, 60, 32, 24],
  worldToCamera: lookAt([x, y, z], [0, 0, 4.5]),
});

test('A CAMERA SEES WHAT THE GEOMETRY SAYS IT SEES, at the distance it says', () => {
  const view = camera(0, 0, 0);
  const pixels = new Uint8Array(64 * 48 * 4);
  const depth = new Float32Array(64 * 48);
  renderTestScene(SCENE, view, pixels, depth);
  /* Straight ahead is the near face of the first box, four along the axis. */
  const middle = 24 * 64 + 32;
  expect(depth[middle]).toBeCloseTo(4, 5);
  /* Its far corner is behind it, and the sky above the plane is unbounded. */
  expect(depth[2 * 64 + 32]).toBe(0);
  /* Every pixel that hit something is opaque, and the sky is not. */
  expect(pixels[middle * 4 + 3]).toBe(255);
  expect(pixels[(2 * 64 + 32) * 4 + 3]).toBe(0);

  /* Turned around, with the boxes behind it, nothing in front of it is one of them. */
  const behind = new Float32Array(64 * 48);
  renderTestScene(
    SCENE,
    {
      width: 64,
      height: 48,
      intrinsics: [60, 60, 32, 24],
      worldToCamera: lookAt([0, 0, 6], [0, 0, 7]),
    },
    new Uint8Array(64 * 48 * 4),
    behind,
  );
  /* A box behind the camera is not a hit at a negative distance: every depth is ahead. */
  expect(behind.every((value) => value >= 0)).toBe(true);
});

test('a step to the side moves a near thing further than a far one, which is the parallax', () => {
  /*
   * Both cameras look straight along the axis — a camera that turns to keep the target centred
   * would cancel the very shift this is about. The near box stands at four, the far one at six.
   */
  const ahead = (x: number): TestCamera => ({
    width: 64,
    height: 48,
    intrinsics: [60, 60, 32, 24],
    worldToCamera: lookAt([x, 0, 0], [x, 0, 1]),
  });
  const size = 64 * 48;
  const centre = new Float32Array(size);
  const stepped = new Float32Array(size);
  renderTestScene(SCENE, ahead(0), new Uint8Array(size * 4), centre);
  renderTestScene(SCENE, ahead(0.5), new Uint8Array(size * 4), stepped);
  /* Where a row first lands on something within a band of depths. */
  const edge = (depth: Float32Array, row: number, low: number, high: number): number => {
    for (let x = 0; x < 64; x += 1) {
      const here = depth[row * 64 + x] as number;
      if (here >= low && here <= high) return x;
    }
    return -1;
  };
  const near = edge(centre, 24, 3.9, 5.1) - edge(stepped, 24, 3.9, 5.1);
  const far = edge(centre, 24, 5.9, 8.1) - edge(stepped, 24, 5.9, 8.1);
  /* Moving right takes both leftwards, and the near one by the wider margin. */
  expect(near).toBeGreaterThan(0);
  expect(far).toBeGreaterThan(0);
  expect(near).toBeGreaterThan(far);
});

test('the same scene and camera render the same bytes, which is what a fixture needs', () => {
  const first = new Uint8Array(64 * 48 * 4);
  const second = new Uint8Array(64 * 48 * 4);
  renderTestScene(SCENE, camera(0.2, 0.1, -0.3), first);
  renderTestScene(SCENE, camera(0.2, 0.1, -0.3), second);
  expect(Array.from(second)).toEqual(Array.from(first));
  /* And it is textured rather than flat: a corner detector needs something to find. */
  const values = new Set(Array.from(first.filter((_, at) => at % 4 === 0)));
  expect(values.size).toBeGreaterThan(20);
});

test('a camera looks where it is pointed: the target lands in the middle of the frame', () => {
  const view = camera(1.5, 0.8, 1);
  const depth = new Float32Array(64 * 48);
  renderTestScene(SCENE, view, new Uint8Array(64 * 48 * 4), depth);
  /* The first box is centred on the target, so the middle pixel is on it and the sky is not. */
  const middle = depth[24 * 64 + 32] as number;
  expect(middle).toBeGreaterThan(0);
  expect(middle).toBeLessThan(6);
});
