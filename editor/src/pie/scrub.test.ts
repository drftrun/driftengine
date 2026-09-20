import { describe, expect, it } from 'vitest';
import type { Snapshotter } from '@driftengine/network';
import { advancePie, startPie, type PieSession } from './session.ts';
import { createTimeline, fingerprintAt, recordFrame, type Timeline } from './timeline.ts';
import { scrubTo, sessionFrame } from './scrub.ts';

interface World {
  a: number;
  b: number;
  pending: number;
}
interface Slot {
  a: number;
  b: number;
  pending: number;
}

/**
 * A world that accumulates, so replaying a tick twice or missing one shows up in the fingerprint.
 *
 * `b` folds every previous `a` into itself, which is what makes the digest sensitive to the order
 * and the count of the ticks rather than only to where the world ended up.
 */
function stepWorld(world: World): void {
  world.a += world.pending;
  world.b = (world.b * 31 + world.a) % 1000003;
}

/** The input for a tick. Deterministic, so a replay has something real to replay. */
function inputFor(tick: number): number {
  return ((tick * 7) % 5) - 2;
}

interface Harness {
  world: World;
  session: PieSession<Slot>;
  timeline: ReturnType<typeof createTimeline<Slot, number>>;
  digest: () => string;
  steps: number;
  restores: number;
  play(frames: number): void;
  applyInput: (input: number, frame: number) => void;
}

function harness(options: { interval?: number; capacity?: number } = {}): Harness {
  const world: World = { a: 0, b: 1, pending: 0 };
  const counters = { steps: 0, restores: 0 };
  const snapshotter: Snapshotter<Slot> = {
    create: (): Slot => ({ a: 0, b: 0, pending: 0 }),
    save: (into: Slot): void => {
      into.a = world.a;
      into.b = world.b;
      into.pending = world.pending;
    },
    restore: (from: Slot): void => {
      counters.restores += 1;
      world.a = from.a;
      world.b = from.b;
      world.pending = from.pending;
    },
    digest: (from: Slot): string => `${String(from.a)}/${String(from.b)}/${String(from.pending)}`,
  };
  const session = startPie<Slot>({
    snapshotter,
    fixedDt: 0.02,
    step: (): void => {
      counters.steps += 1;
      stepWorld(world);
    },
  });
  const timeline = createTimeline<Slot, number>({
    ...options,
    createSnapshot: snapshotter.create,
    saveSnapshot: snapshotter.save,
  });
  const digest = (): string => {
    const slot = snapshotter.create();
    snapshotter.save(slot);
    return snapshotter.digest?.(slot) ?? '';
  };
  const applyInput = (input: number): void => {
    world.pending = input;
  };

  const built: Harness = {
    world,
    session,
    timeline,
    digest,
    applyInput,
    get steps(): number {
      return counters.steps;
    },
    get restores(): number {
      return counters.restores;
    },
    play: (frames: number): void => {
      for (let i = 0; i < frames; i += 1) {
        const tick = session.frame;
        applyInput(inputFor(tick));
        advancePie(session, 1);
        recordFrame(timeline, tick, inputFor(tick), digest());
      }
    },
  };
  return built;
}

/** Every fingerprint a straight-through run of `frames` produces, keyed by timeline frame. */
function straightThrough(frames: number, options: { interval?: number } = {}): string[] {
  const { timeline, play } = harness(options);
  play(frames);
  const out: string[] = [];
  for (let frame = 0; frame < frames; frame += 1) out.push(fingerprintAt(timeline, frame) ?? '');
  return out;
}

describe('scrubbing lands on the frame that was played', () => {
  it('reproduces a recorded frame’s fingerprint exactly', () => {
    const { session, timeline, digest, play, applyInput } = harness({ interval: 8 });
    play(40);
    for (const frame of [0, 1, 7, 8, 9, 23, 31, 39]) {
      expect(scrubTo(session, timeline, frame, { applyInput })).toBe(true);
      expect(digest(), `frame ${String(frame)}`).toBe(fingerprintAt(timeline, frame));
      expect(sessionFrame(session)).toBe(frame);
    }
  });

  it('needs the recorded input, and says so by being wrong without it', () => {
    /* Not a test of a defect but of a dependency: without `applyInput` the replay runs the same
       ticks with the wrong input, and the fingerprint is a world that never existed. If this ever
       passes, the input is not reaching the simulation and the whole scheme is decoration. */
    const { session, timeline, digest, play, applyInput } = harness({ interval: 8 });
    play(40);
    scrubTo(session, timeline, 20);
    expect(digest()).not.toBe(fingerprintAt(timeline, 20));

    scrubTo(session, timeline, 0, { applyInput });
    expect(scrubTo(session, timeline, 20, { applyInput })).toBe(true);
    expect(digest()).toBe(fingerprintAt(timeline, 20));
  });

  it('matches a straight-through run frame for frame after scrubbing back', () => {
    /*
     * The test this whole file exists for. A scrubber that perturbs the simulation produces a
     * version of the bug that is not the bug, and nothing about the result looks wrong.
     */
    const expected = straightThrough(60, { interval: 10 });
    const { session, timeline, digest, play, applyInput } = harness({ interval: 10 });
    play(60);
    expect(scrubTo(session, timeline, 25, { applyInput })).toBe(true);

    for (let frame = 26; frame < 60; frame += 1) {
      expect(scrubTo(session, timeline, frame, { applyInput })).toBe(true);
      expect(digest(), `frame ${String(frame)}`).toBe(expected[frame]);
    }
  });

  it('is exact at a keyframe with nothing re-advanced', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    const before = built.steps;
    expect(scrubTo(built.session, built.timeline, 24, { applyInput: built.applyInput })).toBe(true);
    expect(built.steps).toBe(before);
    expect(built.digest()).toBe(fingerprintAt(built.timeline, 24));
  });

  it('re-advances only from the keyframe, not from the beginning', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    const before = built.steps;
    /* Frame 30 is six past the keyframe at 24, so six ticks and no more. */
    expect(scrubTo(built.session, built.timeline, 30, { applyInput: built.applyInput })).toBe(true);
    expect(built.steps - before).toBe(6);
  });
});

describe('what scrubbing refuses and what it leaves alone', () => {
  it('reports failure rather than clamping outside the range', () => {
    const built = harness({ interval: 8, capacity: 16 });
    built.play(40);
    const where = built.digest();
    expect(scrubTo(built.session, built.timeline, 5, { applyInput: built.applyInput })).toBe(false);
    expect(scrubTo(built.session, built.timeline, 900, { applyInput: built.applyInput })).toBe(
      false,
    );
    /* And a refused scrub changes nothing: no restore, no step, the same world. */
    expect(built.digest()).toBe(where);
    expect(built.restores).toBe(0);
    expect(sessionFrame(built.session)).toBe(39);
  });

  it('always succeeds in going where it already is, even with nothing recorded', () => {
    /* Asking to go where you are cannot fail, and it must not consult the timeline to find that
       out: a fresh session sits on −1, which no timeline holds. */
    const built = harness();
    expect(sessionFrame(built.session)).toBe(-1);
    expect(scrubTo(built.session, built.timeline, -1)).toBe(true);
    expect(built.steps).toBe(0);
    expect(built.restores).toBe(0);
  });

  it('does not restore when the target is ahead of where it is', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    scrubTo(built.session, built.timeline, 10, { applyInput: built.applyInput });
    const restores = built.restores;
    expect(scrubTo(built.session, built.timeline, 35, { applyInput: built.applyInput })).toBe(true);
    expect(built.restores).toBe(restores);
    expect(built.digest()).toBe(fingerprintAt(built.timeline, 35));
  });

  it('is idempotent, and a scrub to where it already is does nothing at all', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    scrubTo(built.session, built.timeline, 17, { applyInput: built.applyInput });
    const once = built.digest();
    const steps = built.steps;
    const restores = built.restores;

    expect(scrubTo(built.session, built.timeline, 17, { applyInput: built.applyInput })).toBe(true);
    expect(built.steps).toBe(steps);
    expect(built.restores).toBe(restores);
    expect(built.digest()).toBe(once);

    /* And going away and coming back reaches the same world, not merely the same number. */
    scrubTo(built.session, built.timeline, 33, { applyInput: built.applyInput });
    scrubTo(built.session, built.timeline, 17, { applyInput: built.applyInput });
    expect(built.digest()).toBe(once);
  });

  it('refuses a frame still recorded whose keyframe has been dropped', () => {
    const built = harness({ interval: 8, capacity: 10 });
    built.play(25);
    /* Frames 15..24 survive and the keyframes among them are 16 and 24, so 15 is held and
       unreachable — the case a range check alone would wave through. */
    expect(scrubTo(built.session, built.timeline, 15, { applyInput: built.applyInput })).toBe(
      false,
    );
    expect(scrubTo(built.session, built.timeline, 16, { applyInput: built.applyInput })).toBe(true);
  });
});

describe('a timeline holds what the session ran', () => {
  it('numbers a frame by its tick, so the session sits one past it', () => {
    const built = harness({ interval: 8 });
    built.play(3);
    expect(built.session.frame).toBe(3);
    expect(sessionFrame(built.session)).toBe(2);
    expect(fingerprintAt(built.timeline, 2)).toBe(built.digest());
  });

  it('gives the same fingerprints for two identical straight-through runs', () => {
    /* The premise the whole wave spends. If this ever fails, nothing below it means anything. */
    expect(straightThrough(30, { interval: 10 })).toEqual(straightThrough(30, { interval: 10 }));
  });
});
