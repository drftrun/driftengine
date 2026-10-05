import { expect, test } from 'vitest';

import { cullInstances } from './instanceCull.ts';
import { INSTANCE_FLOATS, createMeshInstances, packInstances } from './instances.ts';

test('a batch allocates both arrays at capacity and starts empty', () => {
  const instances = createMeshInstances(4);
  expect(instances.models.length).toBe(64);
  expect(instances.tints.length).toBe(12);
  expect(instances.capacity).toBe(4);
  expect(instances.count).toBe(0);
});

test('packing interleaves matrix then tint, one stride apart', () => {
  const instances = createMeshInstances(2);
  instances.models.set(
    Array.from({ length: 16 }, (_, i) => i),
    0,
  );
  instances.models.set(
    Array.from({ length: 16 }, (_, i) => 100 + i),
    16,
  );
  instances.tints.set([1, 2, 3], 0);
  instances.tints.set([4, 5, 6], 3);
  instances.count = 2;

  const out = new Float32Array(2 * INSTANCE_FLOATS);
  packInstances(instances, out);

  expect(Array.from(out.subarray(0, 16))).toEqual(Array.from({ length: 16 }, (_, i) => i));
  expect(Array.from(out.subarray(16, 19))).toEqual([1, 2, 3]);
  expect(Array.from(out.subarray(INSTANCE_FLOATS, INSTANCE_FLOATS + 16))).toEqual(
    Array.from({ length: 16 }, (_, i) => 100 + i),
  );
  expect(Array.from(out.subarray(INSTANCE_FLOATS + 16, INSTANCE_FLOATS + 19))).toEqual([4, 5, 6]);
});

/*
 * The tail is not written, which is what makes a batch reusable between frames: a frame drawing
 * two instances of a batch sized for ten must not upload the eight it is not drawing, and must
 * not have last frame's tenth instance reappear because the count went back up.
 */
test('packing writes nothing past the live count', () => {
  const instances = createMeshInstances(3);
  instances.models.fill(7);
  instances.tints.fill(7);
  instances.count = 1;

  const out = new Float32Array(3 * INSTANCE_FLOATS).fill(-1);
  packInstances(instances, out);

  expect(out[0]).toBe(7);
  expect(out[INSTANCE_FLOATS]).toBe(-1);
});

test('a count past capacity packs only what the arrays hold', () => {
  const instances = createMeshInstances(1);
  instances.count = 5;
  const out = new Float32Array(1 * INSTANCE_FLOATS);
  expect(() => packInstances(instances, out)).not.toThrow();
});

/*
 * **An instance's opacity rides the float the stride was padded with**, so a draw carrying
 * particles that fade at different rates is one draw rather than a batch per level of opacity. A
 * batch with no opacities — a caller's own literal from before they existed — packs 1, which is
 * what every instance was; and a culled batch keeps each survivor's own.
 */
test('AN INSTANCE CARRIES ITS OWN OPACITY IN THE TWENTIETH FLOAT, 1 WHERE NONE WAS GIVEN', () => {
  const instances = createMeshInstances(2);
  expect(Array.from(instances.alphas ?? [])).toEqual([1, 1]);
  instances.alphas?.set([0.25, 0.75]);
  instances.count = 2;
  const out = new Float32Array(2 * INSTANCE_FLOATS);
  packInstances(instances, out);
  expect(out[19]).toBe(0.25);
  expect(out[INSTANCE_FLOATS + 19]).toBe(0.75);

  const literal = {
    models: new Float32Array(16),
    tints: new Float32Array(3),
    capacity: 1,
    count: 1,
  };
  packInstances(literal, out);
  expect(out[19], 'a batch from before opacities existed').toBe(1);
});

test('a culled batch keeps each survivor’s own opacity', () => {
  const instances = createMeshInstances(3);
  for (let i = 0; i < 3; i++) {
    instances.models.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 100, 0, -5, 1], i * 16);
  }
  instances.alphas?.set([0.1, 0.2, 0.3]);
  instances.count = 3;
  /* Only the first, at the origin, is inside a frustum that is a unit box around it. */
  const frustum = new Float32Array([
    1, 0, 0, 2, -1, 0, 0, 2, 0, 1, 0, 2, 0, -1, 0, 2, 0, 0, 1, 10, 0, 0, -1, 10,
  ]);
  const out = createMeshInstances(3);
  const local = {
    min: new Float32Array([-1, -1, -1]),
    max: new Float32Array([1, 1, 1]),
    centre: new Float32Array(3),
    radius: Math.sqrt(3),
  };
  const kept = cullInstances(instances, local, frustum, out);
  expect(kept).toBe(1);
  expect(out.alphas?.[0]).toBeCloseTo(0.1);
});
