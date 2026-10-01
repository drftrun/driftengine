import { expect, test } from 'vitest';
import { batchBoxVisible, cullInstances, instancesBox } from './instanceCull.ts';
import { createMeshInstances } from './instances.ts';
import type { MeshInstances } from './instances.ts';
import type { Bounds } from '../math/bounds.ts';

/**
 * The instance cull, against a frustum written out by hand: the box |x|, |y|, |z| ≤ 10, as six
 * planes n·p + d ≥ 0. Every instance is a unit cube (bounding radius √3/2 ≈ 0.866) placed by hand,
 * so which survive is arithmetic a reader can redo.
 */

const BOX = new Float32Array([
  1, 0, 0, 10, -1, 0, 0, 10, 0, 1, 0, 10, 0, -1, 0, 10, 0, 0, 1, 10, 0, 0, -1, 10,
]);

const CUBE: Bounds = {
  min: new Float32Array([-0.5, -0.5, -0.5]),
  max: new Float32Array([0.5, 0.5, 0.5]),
  centre: new Float32Array([0, 0, 0]),
  radius: Math.sqrt(3) / 2,
};

function place(
  data: MeshInstances,
  index: number,
  x: number,
  y: number,
  z: number,
  scale = 1,
): void {
  const m = index * 16;
  data.models.fill(0, m, m + 16);
  data.models[m] = scale;
  data.models[m + 5] = scale;
  data.models[m + 10] = scale;
  data.models[m + 12] = x;
  data.models[m + 13] = y;
  data.models[m + 14] = z;
  data.models[m + 15] = 1;
  data.tints.set([index / 10, 0.5, 1 - index / 10], index * 3);
}

test('AN INSTANCE IS KEPT UNLESS ITS WHOLE SPHERE IS BEYOND ONE PLANE, and the survivors keep their order', () => {
  const data = createMeshInstances(6);
  place(data, 0, 0, 0, 0); //            inside
  place(data, 1, 20, 0, 0); //           outside: 10 below the x ≤ 10 plane
  place(data, 2, 10.5, 0, 0); //         straddling: −0.5 from the plane, radius 0.866
  place(data, 3, 10.9, 0, 0); //         just out: −0.9 < −0.866
  place(data, 4, 12, 0, 0, 4); //        scaled ×4: radius 3.46, −2 from the plane
  place(data, 5, 0, -30, 0); //          below the floor plane
  data.count = 6;
  const out = createMeshInstances(6);

  expect(cullInstances(data, CUBE, BOX, out)).toBe(3);
  expect(out.count).toBe(3);
  const xs = [out.models[12], out.models[28], out.models[44]];
  expect(xs, 'instances 0, 2 and 4, in that order').toEqual([0, 10.5, 12]);
  expect(out.models[16], 'the second survivor is unscaled').toBe(1);
  expect(out.models[32], 'the third keeps its scale of four').toBe(4);
  expect([...out.tints.subarray(0, 9)].map((v) => Math.round(v * 10) / 10)).toEqual([
    0, 0.5, 1, 0.2, 0.5, 0.8, 0.4, 0.5, 0.6,
  ]);
});

test('an empty batch culls to nothing, and a live count past capacity is clamped', () => {
  const out = createMeshInstances(2);
  expect(cullInstances(createMeshInstances(2), CUBE, BOX, out)).toBe(0);
  const data = createMeshInstances(2);
  place(data, 0, 0, 0, 0);
  place(data, 1, 1, 0, 0);
  data.count = 9;
  expect(cullInstances(data, CUBE, BOX, out)).toBe(2);
});

test('THE BATCH BOX HOLDS EVERY INSTANCE SPHERE, and a batch out of view or occluded is dropped whole', () => {
  const data = createMeshInstances(3);
  place(data, 0, -5, 0, 0);
  place(data, 1, 5, 0, 0);
  place(data, 2, 0, 2, 0);
  data.count = 3;
  const box = new Float32Array(6);
  instancesBox(data, CUBE, box);
  /* Each unit cube's sphere reaches 0.866 from its centre: x from −5.866 to 5.866, y from −0.866
     to 2.866, z from −0.866 to 0.866. */
  const r = Math.sqrt(3) / 2;
  expect([...box].map((v) => Math.round(v * 1000) / 1000)).toEqual(
    [-5 - r, -r, -r, 5 + r, 2 + r, r].map((v) => Math.round(v * 1000) / 1000),
  );
  expect(batchBoxVisible(box, BOX, null)).toBe(true);
  expect(batchBoxVisible(box, BOX, { occludedBox: () => true }), 'hidden by the occluder').toBe(
    false,
  );
  const far = createMeshInstances(1);
  place(far, 0, 30, 0, 0);
  far.count = 1;
  instancesBox(far, CUBE, box);
  expect(batchBoxVisible(box, BOX, null), 'wholly past the x ≤ 10 plane').toBe(false);
  instancesBox(createMeshInstances(1), CUBE, box);
  expect(batchBoxVisible(box, BOX, null), 'no instances is nothing to draw').toBe(false);
});
