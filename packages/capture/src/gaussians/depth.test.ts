import { expect, test } from 'vitest';

import { lookAt, renderTestScene, type TestCamera, type TestScene } from '../testScene.ts';
import { renderDepth } from './depth.ts';
import type { GaussianSet, RasterCamera } from './project.ts';

/**
 * **Where a cloud's surfaces are, as a depth the fusion can take.**
 *
 * A splat cloud has no surface — it is a volume of overlapping blobs — so the depth of a pixel is
 * the one the light actually came from: each splat's own depth weighted by how much of that pixel
 * it contributed.
 *
 * **The cloud under test is placed on the scene rather than fitted to it**, and the difference
 * matters. Splats put on the analytic scene's own surfaces from one view are read back at the
 * scene's depth from *another* view to four millimetres, which is a statement about this module and
 * the projection under it. A cloud that was *fitted* answers its own depth just as faithfully and
 * that depth is only as good as the fit: measured on a deliberately coarse one — four views at
 * 48 × 36 — the median was **0.7 m in a five-metre room**. Both numbers are true and they are about
 * different things, and the fusion downstream inherits the second.
 */

const WIDTH = 96;
const HEIGHT = 72;
const INTRINSICS = [96, 96, WIDTH / 2, HEIGHT / 2] as const;

const SCENE: TestScene = {
  boxes: [
    { min: [-0.7, -0.7, 3.4], max: [0.7, 0.7, 4.6], seed: 1 },
    { min: [1.0, -1.0, 4.4], max: [2.4, 0.6, 6.0], seed: 5 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.3, seed: 3 }],
};

function cameraAt(t: number): TestCamera {
  return {
    width: WIDTH,
    height: HEIGHT,
    intrinsics: INTRINSICS,
    worldToCamera: lookAt([-0.4 + 0.8 * t, 0.1, 0], [0, 0, 5]),
  };
}

/** Where a pixel of a view's depth map is, in the world: the projection run backwards. */
function unproject(camera: TestCamera, x: number, y: number, z: number): [number, number, number] {
  const [fx, fy, cx, cy] = camera.intrinsics;
  const m = camera.worldToCamera;
  const view = [((x + 0.5 - cx) * z) / fx, ((y + 0.5 - cy) * z) / fy, z];
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] += (m[r * 4 + c] as number) * ((view[r] as number) - (m[r * 4 + 3] as number));
    }
  }
  return out;
}

/** One small opaque Gaussian on every surface point one view can see. */
function cloudOnTheScene(source: TestCamera): GaussianSet {
  const truth = new Float32Array(WIDTH * HEIGHT);
  renderTestScene(SCENE, source, new Uint8Array(WIDTH * HEIGHT * 4), truth);
  const points: number[] = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const z = truth[y * WIDTH + x] as number;
      if (!(z > 0)) continue;
      points.push(...unproject(source, x, y, z));
    }
  }
  const count = points.length / 3;
  const set: GaussianSet = {
    count,
    positions: Float64Array.from(points),
    scales: new Float64Array(count * 3).fill(0.03),
    rotations: new Float64Array(count * 4),
    colors: new Float64Array(count * 3).fill(0.6),
    opacities: new Float64Array(count).fill(0.99),
  };
  for (let at = 0; at < count; at += 1) set.rotations[at * 4 + 3] = 1;
  return set;
}

/** The depth of every pixel the cloud covered solidly, against what the scene really is. */
function errorsAgainstScene(set: GaussianSet, camera: TestCamera): number[] {
  const want = new Float32Array(WIDTH * HEIGHT);
  renderTestScene(SCENE, camera, new Uint8Array(WIDTH * HEIGHT * 4), want);
  const depth = new Float32Array(WIDTH * HEIGHT);
  const coverage = new Float32Array(WIDTH * HEIGHT);
  renderDepth(set, camera as RasterCamera, depth, coverage);
  const errors: number[] = [];
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    if ((coverage[pixel] as number) < 0.8) continue;
    if (!((want[pixel] as number) > 0)) continue;
    errors.push(Math.abs((depth[pixel] as number) - (want[pixel] as number)));
  }
  errors.sort((a, b) => a - b);
  return errors;
}

test('A CLOUD’S DEPTH IS THE SCENE’S DEPTH, from a view the cloud was not built from', () => {
  const set = cloudOnTheScene(cameraAt(0));
  expect(set.count).toBeGreaterThan(3000);

  /* The view the splats were placed from, which is the easy half: 4 mm at the median. */
  const home = errorsAgainstScene(set, cameraAt(0));
  expect(home.length).toBeGreaterThan(3000);
  expect(home[Math.floor(home.length / 2)] as number).toBeLessThan(0.02);

  /*
   * And a view forty centimetres away, which is the half that could have hidden a wrong projection
   * or a depth taken along the ray instead of the axis — both of which look right from where the
   * cloud was built and wrong from anywhere else. Measured at 3.9 mm at the median.
   */
  const moved = errorsAgainstScene(set, cameraAt(1));
  expect(moved.length).toBeGreaterThan(3000);
  expect(moved[Math.floor(moved.length / 2)] as number).toBeLessThan(0.02);
  /*
   * The tail is the silhouettes, where a near surface's splats and a far surface's mix in one
   * pixel and the average lands between them. It is why the coverage is answered beside the depth.
   */
  expect(moved[Math.floor(moved.length * 0.9)] as number).toBeLessThan(0.3);
});

test('an empty sky has no depth and says so, rather than answering zero', () => {
  const set: GaussianSet = {
    count: 1,
    positions: Float64Array.from([0, 0, 3]),
    scales: Float64Array.from([0.1, 0.1, 0.1]),
    rotations: Float64Array.from([0, 0, 0, 1]),
    colors: Float64Array.from([1, 1, 1]),
    opacities: Float64Array.from([0.95]),
  };
  const camera: RasterCamera = {
    width: WIDTH,
    height: HEIGHT,
    intrinsics: INTRINSICS,
    worldToCamera: lookAt([0, 0, 0], [0, 0, 1]),
  };
  const depth = new Float32Array(WIDTH * HEIGHT);
  const coverage = new Float32Array(WIDTH * HEIGHT);
  renderDepth(set, camera, depth, coverage);

  const middle = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  expect(coverage[middle]).toBeGreaterThan(0.5);
  expect(depth[middle]).toBeCloseTo(3, 2);
  /* The corner is sky: no light arrived, so there is no depth and the coverage says zero. */
  expect(coverage[0]).toBe(0);
  expect(depth[0]).toBe(0);
});

test('a near splat in front of a far one is read at the near one’s depth', () => {
  const set: GaussianSet = {
    count: 2,
    positions: Float64Array.from([0, 0, 2, 0, 0, 6]),
    scales: Float64Array.from([0.15, 0.15, 0.15, 0.4, 0.4, 0.4]),
    rotations: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1]),
    colors: Float64Array.from([1, 0, 0, 0, 1, 0]),
    opacities: Float64Array.from([0.99, 0.99]),
  };
  const camera: RasterCamera = {
    width: WIDTH,
    height: HEIGHT,
    intrinsics: INTRINSICS,
    worldToCamera: lookAt([0, 0, 0], [0, 0, 1]),
  };
  const depth = new Float32Array(WIDTH * HEIGHT);
  const coverage = new Float32Array(WIDTH * HEIGHT);
  renderDepth(set, camera, depth, coverage);
  const middle = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  /* The near splat takes nearly all the light, so the depth is its own and not an average. */
  expect(depth[middle]).toBeLessThan(2.2);
  expect(depth[middle]).toBeGreaterThan(1.9);
});
