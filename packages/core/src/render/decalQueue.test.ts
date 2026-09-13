import { afterEach, expect, test, vi } from 'vitest';

import { DecalProjector } from './decalProjector.ts';
import { DecalQueue, MAX_DRAWN_DECALS } from './decalQueue.ts';

function projector(x: number): DecalProjector {
  return new DecalProjector({
    center: [x, 0, 0],
    halfExtents: [1, 1, 1],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('copies what it records, since a projector is moved between frames and not rebuilt', () => {
  const queue = new DecalQueue();
  const mark = projector(0);
  queue.record(mark);

  mark.setPose([50, 0, 0], [0, -1, 0], [0, 0, 1]);
  mark.setColor([0, 0, 0]);
  mark.opacity = 0.1;

  const seen: { worldToDecal: Float32Array; color: Float32Array; opacity: number }[] = [];
  queue.replay((decal) => {
    seen.push({
      worldToDecal: Float32Array.from(decal.worldToDecal),
      color: Float32Array.from(decal.color),
      opacity: decal.opacity,
    });
  });

  /* The recorded mark is still at the origin and still white: a queue holding the projector by
     reference would replay every mark wearing the last pose set, which is a plausible picture. */
  expect(seen[0]?.worldToDecal[12]).toBe(0);
  expect([...(seen[0]?.color ?? [])]).toEqual([1, 1, 1]);
  expect(seen[0]?.opacity).toBe(1);
});

test('walks what it recorded, in order', () => {
  const queue = new DecalQueue();
  queue.record(projector(1));
  queue.record(projector(2));

  const centres: number[] = [];
  queue.replay((decal) => centres.push(decal.decalToWorld[12] ?? 0));

  expect(centres).toEqual([1, 2]);
});

test('reuses its records across frames, because the frame loop may not allocate', () => {
  const queue = new DecalQueue();
  const mark = projector(0);
  for (let frame = 0; frame < 4; frame++) {
    queue.reset();
    queue.record(mark);
    queue.record(mark);
  }

  expect(queue.length).toBe(2);
  expect(queue.capacity).toBe(2);
});

test('drops marks past the cap and says so once rather than every frame', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const queue = new DecalQueue();
  const mark = projector(0);

  for (let frame = 0; frame < 3; frame++) {
    queue.reset();
    for (let i = 0; i < MAX_DRAWN_DECALS + 5; i++) queue.record(mark);
    expect(queue.length).toBe(MAX_DRAWN_DECALS);
  }

  expect(warn).toHaveBeenCalledTimes(1);
});
