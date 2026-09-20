import { describe, expect, it } from 'vitest';
import type { Snapshotter } from '@driftengine/network';
import {
  advancePie,
  pausePie,
  pieFrame,
  resumePie,
  startPie,
  stepPie,
  stopPie,
  type PieOptions,
  type PieSession,
} from './session.ts';

/**
 * A world with more in it than one number, so that "restored exactly" is a claim a spot check
 * could fail to notice. The digest covers all of it.
 */
interface World {
  x: number;
  y: number;
  tags: string[];
}

interface Slot {
  x: number;
  y: number;
  tags: string[];
}

function snapshotterFor(world: World): Snapshotter<Slot> {
  return {
    create: (): Slot => ({ x: 0, y: 0, tags: [] }),
    save: (into: Slot): void => {
      into.x = world.x;
      into.y = world.y;
      into.tags = [...world.tags];
    },
    restore: (from: Slot): void => {
      world.x = from.x;
      world.y = from.y;
      world.tags = [...from.tags];
    },
    digest: (from: Slot): string => `${String(from.x)}:${String(from.y)}:${from.tags.join(',')}`,
  };
}

function digestOf(world: World, snapshotter: Snapshotter<Slot>): string {
  const slot = snapshotter.create();
  snapshotter.save(slot);
  return snapshotter.digest?.(slot) ?? '';
}

interface Harness {
  world: World;
  options: PieOptions<Slot>;
  calls: { dt: number; tick: number }[];
  snapshotter: Snapshotter<Slot>;
}

function harness(): Harness {
  const world: World = { x: 3, y: -7, tags: ['authored', 'by hand'] };
  const snapshotter = snapshotterFor(world);
  const calls: { dt: number; tick: number }[] = [];
  const options: PieOptions<Slot> = {
    snapshotter,
    /* Not a sixtieth: a step that hard-coded the usual delta would be indistinguishable from one
       that passed the supplied one through, which is the commonest way a constant goes unnoticed. */
    fixedDt: 0.02,
    step: (dt: number, tick: number): void => {
      calls.push({ dt, tick });
      world.x += 1;
      world.y *= 2;
      world.tags.push(`t${String(tick)}`);
    },
  };
  return { world, options, calls, snapshotter };
}

function play(): { session: PieSession<Slot> } & Harness {
  const built = harness();
  return { ...built, session: startPie(built.options) };
}

describe('playing and stopping leaves the scene exactly as it was', () => {
  it('restores every field, not the ones a test happened to look at', () => {
    const { world, options, snapshotter } = harness();
    const before = digestOf(world, snapshotter);
    expect(before).toBe('3:-7:authored,by hand');

    const session = startPie(options);
    advancePie(session, 40);
    expect(digestOf(world, snapshotter)).not.toBe(before);

    stopPie(session);
    expect(digestOf(world, snapshotter)).toBe(before);
    /* And the array really is the authored one rather than one that happens to match today. */
    expect(world.tags).toEqual(['authored', 'by hand']);
  });

  it('captures at start, because at stop there is nothing left but what play produced', () => {
    const { world, options, snapshotter } = harness();
    const session = startPie(options);
    advancePie(session, 5);
    /* The captured world is untouched by five frames of play. */
    expect(snapshotter.digest?.(session.before)).toBe('3:-7:authored,by hand');
    stopPie(session);
    expect(digestOf(world, snapshotter)).toBe('3:-7:authored,by hand');
  });

  it('restores from a pause too', () => {
    const { session, world, snapshotter } = play();
    advancePie(session, 9);
    pausePie(session);
    stopPie(session);
    expect(digestOf(world, snapshotter)).toBe('3:-7:authored,by hand');
    expect(session.state).toBe('stopped');
    expect(pieFrame(session)).toBe(0);
  });

  it('stops twice without restoring a second time', () => {
    const { session, world, snapshotter } = play();
    advancePie(session, 3);
    stopPie(session);
    world.x = 99;
    /* A second stop must not overwrite what somebody did after the first one. */
    stopPie(session);
    expect(digestOf(world, snapshotter)).toBe('99:-7:authored,by hand');
  });
});

describe('the loop is the caller’s and the session never reaches for one', () => {
  it('calls exactly the step it was given, with the delta it was given', () => {
    const { session, calls, options } = play();
    advancePie(session, 3);
    expect(calls).toEqual([
      { dt: options.fixedDt, tick: 0 },
      { dt: options.fixedDt, tick: 1 },
      { dt: options.fixedDt, tick: 2 },
    ]);
  });

  it('numbers the tick as the frame about to run, so the first is zero', () => {
    const { session, calls } = play();
    advancePie(session, 1);
    expect(calls[0]?.tick).toBe(0);
    expect(pieFrame(session)).toBe(1);
  });
});

describe('pausing, stepping and resuming', () => {
  it('holds the frame while paused, however often the loop calls', () => {
    const { session } = play();
    advancePie(session, 10);
    pausePie(session);
    expect(advancePie(session, 5)).toBe(0);
    expect(advancePie(session, 5)).toBe(0);
    expect(pieFrame(session)).toBe(10);
  });

  it('steps exactly the count asked for, and stays paused after', () => {
    const { session, calls } = play();
    pausePie(session);
    expect(stepPie(session, 3)).toBe(3);
    expect(pieFrame(session)).toBe(3);
    expect(session.state).toBe('paused');
    expect(calls.map((call) => call.tick)).toEqual([0, 1, 2]);
    expect(advancePie(session, 10)).toBe(0);
  });

  it('pauses a session that was playing when it is stepped', () => {
    /* Stepping is what somebody does instead of playing; a step that resumed would run away on
       the next frame, which is the opposite of what the button is for. */
    const { session } = play();
    stepPie(session, 1);
    expect(session.state).toBe('paused');
  });

  it('resumes from where it paused with no frame skipped and none repeated', () => {
    const { session, calls } = play();
    advancePie(session, 4);
    pausePie(session);
    advancePie(session, 100);
    resumePie(session);
    advancePie(session, 3);
    expect(calls.map((call) => call.tick)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pieFrame(session)).toBe(7);
  });

  it('does not resume or pause a stopped session, which is started again instead', () => {
    const { session } = play();
    stopPie(session);
    pausePie(session);
    expect(session.state).toBe('stopped');
    resumePie(session);
    expect(session.state).toBe('stopped');
    expect(advancePie(session, 5)).toBe(0);
    expect(stepPie(session, 5)).toBe(0);
  });

  it('advances nothing for a count of nothing, or less', () => {
    const { session, calls } = play();
    expect(advancePie(session, 0)).toBe(0);
    expect(advancePie(session, -3)).toBe(0);
    expect(advancePie(session, 2.7)).toBe(2);
    expect(calls).toHaveLength(2);
  });
});
