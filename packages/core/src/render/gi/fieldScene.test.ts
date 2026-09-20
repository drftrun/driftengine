import { mat4 } from 'gl-matrix';
import { afterEach, expect, test, vi } from 'vitest';

import {
  DistanceFieldScene,
  MAX_DISTANCE_FIELDS,
  MAX_DISTANCE_FIELD_SAMPLES,
  distanceFieldBounds,
} from './fieldScene.ts';

import type { FieldSource } from './globalField.ts';

/**
 * The frame's declared distance fields.
 *
 * **What this file is really about is the transform being copied.** A consumer holds a matrix and
 * moves it — that is what a matrix is for — and a queue holding the reference replays every field
 * wearing whatever pose was written last. `DecalQueue`'s header says the same thing about the same
 * mistake, and says why it is the dangerous kind: one wheel's skid under every wheel is a plausible
 * picture rather than a broken one, so it gets blamed on the pass.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function source(samples: number): FieldSource {
  const side = Math.max(2, Math.round(Math.cbrt(samples)));
  return {
    field: new Float32Array(side ** 3),
    dims: [side, side, side],
    bounds: Float32Array.from([-1, -1, -1, 1, 1, 1]),
  };
}

function at(x: number): mat4 {
  const model = mat4.create();
  mat4.translate(model, model, [x, 0, 0]);
  return model;
}

test('ONE FIELD DECLARED TWICE IS TWO INSTANCES AND ONE SOURCE', () => {
  /*
   * The whole reason a field and a placement are separate arguments: a scene with forty identical
   * pillars uploads one pillar's samples and forty matrices. A queue that treated a repeat as a
   * duplicate to discard would collapse the pillars into one.
   */
  const scene = new DistanceFieldScene();
  const pillar = source(8);
  scene.record(pillar, at(0));
  scene.record(pillar, at(4));

  expect(scene.length).toBe(2);
  expect(scene.sources).toEqual([pillar]);
  expect(scene.sampleCount).toBe(pillar.field.length);
});

test('THE TRANSFORM IS COPIED, so moving it after the call does not move the field', () => {
  /*
   * **Declared at seven rather than at the origin**, so that a queue which copied nothing at all
   * fails this. A field declared at zero reads zero from a record that was never written, and the
   * test would pass while proving only that a fresh `Float32Array` is zeroed.
   */
  const scene = new DistanceFieldScene();
  const model = at(7);
  scene.record(source(8), model);
  mat4.translate(model, model, [100, 0, 0]);

  const seen: number[] = [];
  scene.replay((instance) => seen.push(instance.transform[12] as number));
  expect(seen).toEqual([7]);
});

test('two fields keep their own placements rather than sharing the last one', () => {
  const scene = new DistanceFieldScene();
  scene.record(source(8), at(1));
  scene.record(source(8), at(2));

  const seen: number[] = [];
  scene.replay((instance) => seen.push(instance.transform[12] as number));
  expect(seen).toEqual([1, 2]);
});

test('over the instance budget it refuses in words, once, and composes what fits', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const scene = new DistanceFieldScene();
  const shared = source(8);
  for (let i = 0; i < MAX_DISTANCE_FIELDS + 3; i += 1) scene.record(shared, at(i));

  expect(scene.length).toBe(MAX_DISTANCE_FIELDS);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain(String(MAX_DISTANCE_FIELDS));
});

test('A SOURCE WHOSE SAMPLES DO NOT FIT IS REFUSED WHOLE, not composed in part', () => {
  /*
   * An instance is admitted only if its samples are: half a field on the device is not a coarser
   * field, it is a field whose far half reads whatever the buffer held, which composes as surfaces
   * that are not there. The instance budget drops the placement; this one drops both.
   */
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const scene = new DistanceFieldScene();
  const small = source(8);
  scene.record(small, at(0));
  scene.record({ ...small, field: new Float32Array(MAX_DISTANCE_FIELD_SAMPLES) }, at(1));

  expect(scene.length).toBe(1);
  expect(scene.sources).toEqual([small]);
  expect(scene.sampleCount).toBe(small.field.length);
  expect(String(warn.mock.calls[0]?.[0])).toContain(String(MAX_DISTANCE_FIELD_SAMPLES));
});

test('every source is offset where the one before it ended, with no gap and no overlap', () => {
  const scene = new DistanceFieldScene();
  const first = source(8);
  const second = source(27);
  scene.record(first, at(0));
  scene.record(second, at(1));
  scene.record(first, at(2));

  expect(scene.offsetOf(first)).toBe(0);
  expect(scene.offsetOf(second)).toBe(first.field.length);
  expect(scene.sampleCount).toBe(first.field.length + second.field.length);
});

test('reset empties the frame and keeps the storage, so a steady scene stops allocating', () => {
  const scene = new DistanceFieldScene();
  const pillar = source(8);
  for (let i = 0; i < 4; i += 1) scene.record(pillar, at(i));
  const pooled = scene.capacity;

  scene.reset();
  expect(scene.length).toBe(0);
  expect(scene.sources).toEqual([]);
  expect(scene.sampleCount).toBe(0);

  for (let i = 0; i < 4; i += 1) scene.record(pillar, at(i));
  expect(scene.capacity).toBe(pooled);
});

test('THE PACKING IS ONLY CALLED CHANGED WHEN IT CHANGED, because it is megabytes', () => {
  /*
   * The samples are the large upload and the placements are the small one. A renderer that
   * rewrote the samples every frame would move the whole field across the bus to say the same
   * thing, so the queue is what knows whether the distinct sources are the ones it packed last.
   */
  const scene = new DistanceFieldScene();
  const first = source(8);
  const second = source(27);

  scene.record(first, at(0));
  expect(scene.packingChanged).toBe(true);

  scene.reset();
  scene.record(first, at(5));
  expect(scene.packingChanged).toBe(false);

  scene.reset();
  scene.record(first, at(0));
  scene.record(second, at(1));
  expect(scene.packingChanged).toBe(true);

  scene.reset();
  scene.record(first, at(0));
  scene.record(second, at(1));
  expect(scene.packingChanged).toBe(false);

  /* The same two sources in the other order is a different packing: the offsets swap. */
  scene.reset();
  scene.record(second, at(0));
  scene.record(first, at(1));
  expect(scene.packingChanged).toBe(true);
});

test("a frame that declared nothing is an empty packing, not the previous frame's", () => {
  const scene = new DistanceFieldScene();
  scene.record(source(8), at(0));
  scene.reset();

  expect(scene.length).toBe(0);
  expect(scene.packingChanged).toBe(true);
  expect(scene.sampleCount).toBe(0);
});

test('THE DECLARED FIELDS ARE THE SCENE BOUNDS, which is what a fitted grid is fitted to', () => {
  /*
   * A renderer asked for indirect light with no probe grid declared has to put the probes
   * somewhere, and the one description of the world it holds is what a consumer said its light may
   * be traced against. Using the declared fields rather than everything drawn is also the right
   * answer: a grid sized to include the sky-sphere would spend every probe on empty air.
   */
  const scene = new DistanceFieldScene();
  const unit = source(8);
  scene.record(unit, at(0));
  scene.record(unit, at(10));

  const min = new Float32Array(3);
  const max = new Float32Array(3);
  expect(distanceFieldBounds(scene, min, max)).toBe(true);
  /* The source's own bounds are the unit cube, so two placements ten apart span -1 to 11. */
  expect(min[0]).toBeCloseTo(-1, 5);
  expect(max[0]).toBeCloseTo(11, 5);
  expect(min[1]).toBeCloseTo(-1, 5);
  expect(max[1]).toBeCloseTo(1, 5);
});

test('a rotated field is bounded by where its corners went, not by its own box', () => {
  const scene = new DistanceFieldScene();
  const model = mat4.create();
  mat4.rotateY(model, model, Math.PI / 4);
  scene.record(source(8), model);

  const min = new Float32Array(3);
  const max = new Float32Array(3);
  distanceFieldBounds(scene, min, max);
  /* A unit cube turned 45 degrees reaches sqrt(2) on the axes it turned about. */
  expect(max[0]).toBeCloseTo(Math.SQRT2, 4);
  expect(max[2]).toBeCloseTo(Math.SQRT2, 4);
  /* And not at all further on the axis it turned around. */
  expect(max[1]).toBeCloseTo(1, 5);
});

test('a scale reaches the bounds, so a grid fitted to a big field is big', () => {
  const scene = new DistanceFieldScene();
  const model = mat4.create();
  mat4.scale(model, model, [3, 3, 3]);
  scene.record(source(8), model);

  const min = new Float32Array(3);
  const max = new Float32Array(3);
  distanceFieldBounds(scene, min, max);
  expect(max[0]).toBeCloseTo(3, 5);
  expect(min[0]).toBeCloseTo(-3, 5);
});

test('a frame that declared nothing has no bounds, and says so rather than answering zero', () => {
  /*
   * Zero would be a point at the origin, which `fitProbeGrid` answers with a grid of one standing
   * there — a plausible grid for a scene that has no idea where anything is. Refusing is what lets
   * the caller keep the probes it had.
   */
  const min = new Float32Array(3);
  const max = new Float32Array(3);
  expect(distanceFieldBounds(new DistanceFieldScene(), min, max)).toBe(false);
});

test('A SOURCE WHOSE VOXELS ARE NOT CUBIC IS REFUSED WHERE IT IS DECLARED', () => {
  /*
   * **The renderer never calls `composeGlobalField`**, so the check that file makes protects the
   * reference path and nothing else: a frame's fields are composed on the device by
   * `FieldComposer`, whose shader assumes cubic voxels in a comment and cannot be told otherwise.
   * A consumer who declares an oblong source gets a field with nothing in it and no complaint —
   * which is what `demo/dev/bounce.html` was measuring as a bounce that lost a thirty-fifth of its
   * light, with every gate green.
   *
   * Refused here rather than warned about, because this is a malformed source rather than a
   * budget: the two warnings above are a scene asking for more than a frame can carry, and
   * dropping the surplus is the honest answer to that. There is no honest answer to this one.
   */
  const scene = new DistanceFieldScene();
  const oblong: FieldSource = {
    field: new Float32Array(9 ** 3),
    dims: [9, 9, 9],
    bounds: Float32Array.from([-1, -3, -3, 1, 3, 3]),
  };
  expect(() => scene.record(oblong, at(0))).toThrow(/cubic/i);
  expect(scene.length).toBe(0);
});
