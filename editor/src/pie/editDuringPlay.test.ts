import { describe, expect, it } from 'vitest';
import type { Snapshotter } from '@driftengine/network';
import { createUndoStack, type Command } from '@driftengine/tools';
import { startPie, type PieSession } from './session.ts';
import { createTimeline, fingerprintAt, frameRange, type Timeline } from './timeline.ts';
import { scrubTo, sessionFrame } from './scrub.ts';
import {
  applyPlayEdit,
  createEditLog,
  editsAt,
  playFrame,
  recordEdit,
  replayHooks,
  resimulateFrom,
  type Playback,
} from './editDuringPlay.ts';

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

function inputFor(tick: number): number {
  return ((tick * 7) % 5) - 2;
}

interface Harness {
  world: World;
  session: PieSession<Slot>;
  playback: Playback<Slot, number>;
  timeline: Timeline<Slot, number>;
  digest: () => string;
  play(frames: number): void;
  /** The command an inspector would emit: it sets a field and can take it back. */
  setA(value: number): Command;
  /** One that *adds*, so two on a frame are distinguishable from the last one alone. */
  addA(value: number): Command;
  /** What live play will feed the next frame. Changed to tell a replay from a fresh run. */
  live: { input: number };
  /** How many snapshot slots have been made. A re-simulation should need no new ones. */
  created: () => number;
}

function harness(options: { interval?: number; capacity?: number } = {}): Harness {
  const world: World = { a: 0, b: 1, pending: 0 };
  const counters = { created: 0 };
  const snapshotter: Snapshotter<Slot> = {
    create: (): Slot => {
      counters.created += 1;
      return { a: 0, b: 0, pending: 0 };
    },
    save: (into: Slot): void => {
      into.a = world.a;
      into.b = world.b;
      into.pending = world.pending;
    },
    restore: (from: Slot): void => {
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
      world.a += world.pending;
      world.b = (world.b * 31 + world.a) % 1000003;
    },
  });
  const timeline = createTimeline<Slot, number>({
    ...options,
    createSnapshot: snapshotter.create,
    saveSnapshot: snapshotter.save,
  });
  /* One slot, reused: a digest that allocated per call would drown the counter below in noise —
     forty-six allocations where the seven that matter are the ones this test is about. */
  const scratch = snapshotter.create();
  const digest = (): string => {
    snapshotter.save(scratch);
    return snapshotter.digest?.(scratch) ?? '';
  };
  const live = { input: Number.NaN };
  const playback: Playback<Slot, number> = {
    timeline,
    edits: createEditLog(),
    /* Live input comes from `live` when it is set, so a re-simulation that called this instead of
       replaying the record would be using a number the original run never saw. */
    inputFor: (tick: number): number => (Number.isNaN(live.input) ? inputFor(tick) : live.input),
    applyInput: (input: number): void => {
      world.pending = input;
    },
    fingerprint: digest,
  };
  return {
    world,
    session,
    playback,
    timeline,
    digest,
    play: (frames: number): void => {
      for (let i = 0; i < frames; i += 1) playFrame(session, playback);
    },
    live,
    created: (): number => counters.created,
    addA: (value: number): Command => ({
      label: `Add ${String(value)} to a`,
      apply: (): void => {
        world.a += value;
      },
      revert: (): void => {
        world.a -= value;
      },
    }),
    setA: (value: number): Command => {
      let previous = 0;
      return {
        label: `Set a to ${String(value)}`,
        apply: (): void => {
          previous = world.a;
          world.a = value;
        },
        revert: (): void => {
          world.a = previous;
        },
      };
    },
  };
}

/** Every fingerprint a run produces, so two runs can be compared frame for frame. */
function traceOf(timeline: Timeline<Slot, number>): string[] {
  return timeline.frames.map((one) => one.fingerprint);
}

describe('an edit during play is the same command as an edit at rest', () => {
  it('is applied through `apply` and nothing else, and still undoes at rest', () => {
    const built = harness({ interval: 8 });
    const command = built.setA(500);
    /* The same object, driven by the ordinary undo stack, behaves the way a panel expects. */
    const stack = createUndoStack(4);
    stack.push(command);
    expect(built.world.a).toBe(500);
    stack.undo();
    expect(built.world.a).toBe(0);
  });

  it('records the edit at the frame it was made on', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    const command = built.setA(500);
    expect(applyPlayEdit(built.session, built.playback, 20, command)).toBe(true);
    expect(editsAt(built.playback.edits, 20)).toEqual([command]);
    expect(editsAt(built.playback.edits, 19)).toEqual([]);
  });

  it('keeps edits out of the input log, which carries what was pressed', () => {
    /* An editor command is not game input: it is not something a peer sends and not something a
       recording of the game produces, and one log for both is how a network session confuses them. */
    const built = harness({ interval: 8 });
    built.play(40);
    applyPlayEdit(built.session, built.playback, 20, built.setA(500));
    expect(built.timeline.frames.map((one) => one.input)).toEqual(
      built.timeline.frames.map((one) => inputFor(one.frame)),
    );
  });
});

describe('the rest of the session happens differently', () => {
  it('produces a world the edit is visible in, and changes every frame after it', () => {
    const before = harness({ interval: 8 });
    before.play(40);
    const untouched = traceOf(before.timeline);

    const built = harness({ interval: 8 });
    built.play(40);
    expect(applyPlayEdit(built.session, built.playback, 20, built.setA(500))).toBe(true);
    const after = traceOf(built.timeline);

    /* Everything before the edit is the run that already happened. */
    expect(after.slice(0, 20)).toEqual(untouched.slice(0, 20));
    /* And everything from it is not. */
    for (let frame = 20; frame < 40; frame += 1) {
      expect(after[frame], `frame ${String(frame)}`).not.toBe(untouched[frame]);
    }
    expect(sessionFrame(built.session)).toBe(39);
  });

  it('reproduces the edited outcome by replaying the whole session from the start', () => {
    /*
     * The property that makes this trustworthy rather than a debugging trick. If a replay from
     * frame zero does not reach the same world, the edit lives somewhere the replay cannot see and
     * the recording is not a recording of what happened.
     */
    const built = harness({ interval: 8 });
    built.play(40);
    applyPlayEdit(built.session, built.playback, 20, built.setA(500));
    const edited = traceOf(built.timeline);
    const ended = built.digest();

    expect(resimulateFrom(built.session, built.playback, 0)).toBe(true);
    expect(traceOf(built.timeline)).toEqual(edited);
    expect(built.digest()).toBe(ended);
  });

  it('survives scrubbing away and back, because the edit is replayed rather than applied once', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    applyPlayEdit(built.session, built.playback, 20, built.setA(500));
    const at30 = fingerprintAt(built.timeline, 30);

    expect(scrubTo(built.session, built.timeline, 5, replayHooks(built.playback))).toBe(true);
    expect(scrubTo(built.session, built.timeline, 30, replayHooks(built.playback))).toBe(true);
    expect(built.digest()).toBe(at30);
  });

  it('replays every edit on one frame, not only the last', () => {
    /* Two that add rather than set, so a log keeping one of them is a different number and not
       merely a different route to the same one. */
    const built = harness({ interval: 8 });
    built.play(20);
    recordEdit(built.playback.edits, 10, built.addA(100));
    recordEdit(built.playback.edits, 10, built.addA(20));
    expect(editsAt(built.playback.edits, 10)).toHaveLength(2);
    expect(resimulateFrom(built.session, built.playback, 10)).toBe(true);
    expect(scrubTo(built.session, built.timeline, 10, replayHooks(built.playback))).toBe(true);

    const plain = harness({ interval: 8 });
    plain.play(20);
    expect(scrubTo(plain.session, plain.timeline, 10, replayHooks(plain.playback))).toBe(true);
    expect(built.world.a - plain.world.a).toBe(120);
  });

  it('applies an edit that live play has not reached yet', () => {
    /* Recorded ahead of the playhead, so nothing re-simulates: live play has to apply it as it
       arrives, or an edit scheduled for a frame in the future never happens at all. */
    const built = harness({ interval: 8 });
    built.play(10);
    recordEdit(built.playback.edits, 15, built.addA(1000));
    built.play(10);
    expect(built.world.a).toBeGreaterThan(900);

    const plain = harness({ interval: 8 });
    plain.play(20);
    expect(built.world.a - plain.world.a).toBe(1000);
  });

  it('replays the recorded input rather than asking for a fresh one', () => {
    /*
     * The recorded run used one input per frame; the live source now answers something else
     * entirely. A re-simulation that asked the source instead of reading the record would produce a
     * world the original run never passed through, and every fingerprint after the edit would be
     * of a run nobody played.
     */
    const built = harness({ interval: 8 });
    built.play(30);
    const before = traceOf(built.timeline).slice(0, 10);
    built.live.input = 99;
    expect(resimulateFrom(built.session, built.playback, 10)).toBe(true);
    expect(traceOf(built.timeline).slice(0, 10)).toEqual(before);
    expect(built.digest()).toBe(fingerprintAt(built.timeline, 29));

    /* And the same run replayed whole still matches, which it could not if 99 had leaked in. */
    const plain = harness({ interval: 8 });
    plain.play(30);
    expect(traceOf(built.timeline)).toEqual(traceOf(plain.timeline));
  });
});

describe('frames after the edit are forgotten, not overwritten', () => {
  it('re-records exactly the frames that were there', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    applyPlayEdit(built.session, built.playback, 20, built.setA(500));
    expect(frameRange(built.timeline)).toEqual({ first: 0, last: 39, any: true });
    expect(built.timeline.frames.map((one) => one.frame)).toEqual(
      Array.from({ length: 40 }, (_unused, at) => at),
    );
  });

  it('gives the truncated slots back, so re-simulating allocates nothing new', () => {
    const built = harness({ interval: 8 });
    built.play(40);
    /* One for the session's own capture, one for the digest scratch, and keyframes at 0, 8, 16,
       24 and 32. Spelled out so that an allocation creeping into the per-frame path is visible
       here as well as in the claim below. */
    expect(built.created()).toBe(7);
    expect(applyPlayEdit(built.session, built.playback, 20, built.setA(500))).toBe(true);
    /* Two keyframes were dropped by the truncation and two were made by the replay — the same two
       slots, or a leak on every edit somebody makes. */
    expect(built.created()).toBe(7);
  });

  it('does not leave a stale frame beyond the replay when the run was shortened', () => {
    /* Re-simulating a shorter span would otherwise leave the tail still describing the old run —
       recorded-looking and wrong. `truncateFrom` is why that cannot happen. */
    const built = harness({ interval: 8 });
    built.play(40);
    const timeline = built.playback.timeline;
    const keyframes = timeline.frames.filter((one) => one.snapshot !== null).length;
    applyPlayEdit(built.session, built.playback, 20, built.setA(500));
    expect(timeline.frames.filter((one) => one.snapshot !== null).length).toBe(keyframes);
    expect(timeline.frames).toHaveLength(40);
  });
});

describe('what an edit refuses', () => {
  it('refuses a frame outside the range and records nothing', () => {
    const built = harness({ interval: 8, capacity: 16 });
    built.play(40);
    const command = built.setA(500);
    expect(applyPlayEdit(built.session, built.playback, 5, command)).toBe(false);
    expect(applyPlayEdit(built.session, built.playback, 900, command)).toBe(false);
    expect(editsAt(built.playback.edits, 5)).toEqual([]);
    expect(editsAt(built.playback.edits, 900)).toEqual([]);
  });

  it('refuses a frame whose predecessor can no longer be reached', () => {
    const built = harness({ interval: 8, capacity: 10 });
    built.play(25);
    /* Frames 15..24 survive with keyframes at 16 and 24, so 16 is the earliest editable frame:
       editing 16 needs 15, which is held but unreachable. */
    expect(applyPlayEdit(built.session, built.playback, 16, built.setA(1))).toBe(false);
    expect(applyPlayEdit(built.session, built.playback, 17, built.setA(1))).toBe(true);
  });

  it('refuses to re-simulate an empty timeline', () => {
    const built = harness({ interval: 8 });
    expect(resimulateFrom(built.session, built.playback, 0)).toBe(false);
  });

  it('refuses the frame just past the end, which has nothing to re-simulate', () => {
    /*
     * The one case the cheaper checks miss: the frame before it *is* reachable, so the replay lands
     * and then runs nothing at all — reporting success for an edit on a frame that never ran, and
     * leaving it in the log to be applied whenever play next reaches there.
     */
    const built = harness({ interval: 8 });
    built.play(40);
    expect(resimulateFrom(built.session, built.playback, 40)).toBe(false);
    expect(applyPlayEdit(built.session, built.playback, 40, built.setA(1))).toBe(false);
    expect(editsAt(built.playback.edits, 40)).toEqual([]);
  });
});
