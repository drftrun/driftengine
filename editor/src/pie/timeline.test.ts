import { describe, expect, it } from 'vitest';
import {
  createTimeline,
  fingerprintAt,
  frameRange,
  inputAt,
  nearestKeyframeBefore,
  reachable,
  recordFrame,
  recordedAt,
  snapshotAt,
} from './timeline.ts';

interface Slot {
  value: number;
}

/** A world of one number, recorded through the same seam a real snapshotter would use. */
function recorder(options: { interval?: number; capacity?: number } = {}): {
  timeline: ReturnType<typeof make>;
  world: { value: number };
  play(frames: number): void;
  created: () => number;
} {
  const world = { value: 0 };
  let created = 0;
  const make = (): ReturnType<typeof createTimeline<Slot, string>> =>
    createTimeline<Slot, string>({
      ...options,
      createSnapshot: (): Slot => {
        created += 1;
        return { value: 0 };
      },
      saveSnapshot: (into: Slot): void => {
        into.value = world.value;
      },
    });
  const timeline = make();
  return {
    timeline,
    world,
    play: (frames: number): void => {
      const start = frameRange(timeline).any ? frameRange(timeline).last + 1 : 0;
      for (let frame = start; frame < start + frames; frame += 1) {
        world.value += 1;
        recordFrame(timeline, frame, `in${String(frame)}`, `fp${String(world.value)}`);
      }
    },
    created: (): number => created,
  };
}

function make(): ReturnType<typeof createTimeline<Slot, string>> {
  return createTimeline<Slot, string>({
    createSnapshot: (): Slot => ({ value: 0 }),
    saveSnapshot: (): void => {},
  });
}

describe('the range says what is there', () => {
  it('reports nothing before anything is recorded, which is not a range of one', () => {
    expect(frameRange(make())).toEqual({ first: 0, last: 0, any: false });
  });

  it('covers what was recorded', () => {
    const { timeline, play } = recorder();
    play(10);
    expect(frameRange(timeline)).toEqual({ first: 0, last: 9, any: true });
  });
});

describe('a keyframe every interval, and the input between them', () => {
  it('stores a snapshot at the interval and nothing at the frames between', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(9);
    expect([0, 4, 8].map((frame) => snapshotAt(timeline, frame) !== null)).toEqual([
      true,
      true,
      true,
    ]);
    expect([1, 2, 3, 5, 6, 7].map((frame) => snapshotAt(timeline, frame))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('keeps the input and the fingerprint for every frame, keyframe or not', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(6);
    for (let frame = 0; frame < 6; frame += 1) {
      expect(inputAt(timeline, frame)).toBe(`in${String(frame)}`);
      expect(fingerprintAt(timeline, frame)).toBe(`fp${String(frame + 1)}`);
    }
  });

  it('snapshots the world as it is at that frame, not as it ends up', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(9);
    /* World counts up one a frame from zero, so frame 4 was taken when it read 5. */
    expect(snapshotAt(timeline, 0)?.value).toBe(1);
    expect(snapshotAt(timeline, 4)?.value).toBe(5);
    expect(snapshotAt(timeline, 8)?.value).toBe(9);
  });

  it('refuses an interval below one, which would be a snapshot per frame', () => {
    expect(createTimeline<Slot, string>({ interval: 0, ...seams() }).interval).toBe(1);
    expect(createTimeline<Slot, string>({ interval: -4, ...seams() }).interval).toBe(1);
    expect(createTimeline<Slot, string>({ interval: 7.9, ...seams() }).interval).toBe(7);
  });
});

describe('the nearest keyframe before a frame', () => {
  it('is the keyframe itself at a boundary, not the one before it', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(9);
    expect(nearestKeyframeBefore(timeline, 4)).toBe(4);
    expect(nearestKeyframeBefore(timeline, 8)).toBe(8);
  });

  it('is the one behind for a frame between', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(9);
    expect(nearestKeyframeBefore(timeline, 5)).toBe(4);
    expect(nearestKeyframeBefore(timeline, 7)).toBe(4);
    expect(nearestKeyframeBefore(timeline, 3)).toBe(0);
  });

  it('reports none rather than the oldest for a frame outside the range', () => {
    const { timeline, play } = recorder({ interval: 4 });
    play(9);
    expect(nearestKeyframeBefore(timeline, -1)).toBe(-1);
    expect(nearestKeyframeBefore(timeline, 100)).toBe(-1);
  });
});

describe('the ring drops the oldest and says so', () => {
  it('holds no more than its capacity and moves its range forward', () => {
    const { timeline, play } = recorder({ interval: 4, capacity: 10 });
    play(25);
    expect(timeline.frames).toHaveLength(10);
    expect(frameRange(timeline)).toEqual({ first: 15, last: 24, any: true });
  });

  it('reports a dropped frame as gone rather than handing back the oldest', () => {
    /* Silently substituting is how a scrubber lies: somebody reasons about a bug from a frame the
       bug did not happen on, and nothing tells them. */
    const { timeline, play } = recorder({ interval: 4, capacity: 10 });
    play(25);
    expect(recordedAt(timeline, 3)).toBeNull();
    expect(snapshotAt(timeline, 3)).toBeNull();
    expect(fingerprintAt(timeline, 3)).toBeNull();
    expect(reachable(timeline, 3)).toBe(false);
    expect(reachable(timeline, 20)).toBe(true);
  });

  it('refuses a frame whose keyframe has been dropped even though the frame is still held', () => {
    /* Capacity 10 with keyframes every 8 leaves frames 15..24 and keyframes at 16 and 24, so 15
       is recorded and unreachable — the case a range check alone would pass. */
    const { timeline, play } = recorder({ interval: 8, capacity: 10 });
    play(25);
    expect(recordedAt(timeline, 15)).not.toBeNull();
    expect(nearestKeyframeBefore(timeline, 15)).toBe(-1);
    expect(reachable(timeline, 15)).toBe(false);
    expect(reachable(timeline, 16)).toBe(true);
  });

  it('reuses a dropped slot, so a full ring allocates nothing more', () => {
    const { timeline, play, created } = recorder({ interval: 4, capacity: 10 });
    play(10);
    const madeSoFar = created();
    expect(madeSoFar).toBe(3);
    play(40);
    /* Ten more keyframes went by and every one of them reused a slot the ring had already made. */
    expect(created()).toBe(madeSoFar);
    expect(timeline.frames.filter((one) => one.snapshot !== null).length).toBeGreaterThan(0);
  });
});

function seams(): {
  createSnapshot: () => Slot;
  saveSnapshot: (into: Slot) => void;
} {
  return { createSnapshot: (): Slot => ({ value: 0 }), saveSnapshot: (): void => {} };
}
