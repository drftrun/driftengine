/**
 * The one property a rewind has to have: **replaying gets you where running would have.**
 *
 * Everything else here supports that. A rollback that lands somewhere else is not a bug that shows
 * up as a crash or a wrong number — it shows up as a world that is entirely plausible and simply is
 * not the world the other peer is in, which is why the central test is a differential one against a
 * run that never rewound at all.
 */
import { describe, expect, it } from 'vitest';
import { savableMulberry32 } from '@driftengine/core';
import { World, defineComponent } from '@driftengine/entities';
import { InputLog } from './inputLog.ts';
import { RewindLoop } from './rewind.ts';
import { combineSnapshotters, randomSnapshotter, worldSnapshotter } from './snapshotter.ts';

const Body = defineComponent('NBody', { x: 'f32', vx: 'f32', jitter: 'f32' });

const FIXED_DT = 1 / 60;
const INPUT_BYTES = 1;

/**
 * A simulation small enough to reason about and rich enough to catch a bad restore.
 *
 * It reads an input, integrates, and **draws from the generator every tick**, which is what makes
 * the RNG's position part of the state a rewind has to put back. A sim that never drew would pass a
 * rewind that forgot the generator entirely.
 */
function makeSim(participants: number) {
  const world = new World();
  const rng = savableMulberry32(1234);
  const entities = Array.from({ length: participants }, () => world.create());
  for (const e of entities) world.add(e, Body, { x: 0, vx: 0, jitter: 0 });

  const scratch = new Uint8Array(INPUT_BYTES);
  const inputs = new InputLog({ participants, depth: 32, inputBytes: INPUT_BYTES });

  const step = (dt: number, tick: number): void => {
    for (let p = 0; p < participants; p++) {
      inputs.into(p, tick, scratch);
      const entity = entities[p] as number;
      const pressed = ((scratch[0] as number) & 1) === 1;
      const vx = (world.read(entity, Body, 'vx') as number) + (pressed ? dt * 10 : -dt * 2);
      world.write(entity, Body, 'vx', vx);
      world.write(entity, Body, 'x', (world.read(entity, Body, 'x') as number) + vx * dt);
      world.write(entity, Body, 'jitter', rng.next());
    }
  };

  const loop = new RewindLoop({
    step,
    snapshotter: combineSnapshotters([worldSnapshotter(world), randomSnapshotter(rng)] as never[]),
    inputs,
    fixedDt: FIXED_DT,
    depth: 16,
  });

  const digest = (): number[] => {
    const out: number[] = [];
    for (const e of entities) {
      out.push(
        world.read(e, Body, 'x') as number,
        world.read(e, Body, 'vx') as number,
        world.read(e, Body, 'jitter') as number,
      );
    }
    return out;
  };

  return { world, rng, entities, inputs, loop, digest };
}

const HELD = new Uint8Array([1]);
const RELEASED = new Uint8Array([0]);

/** Participant 1 holds its control from tick 40 on; participant 0 never presses. */
function inputFor(participant: number, tick: number): Uint8Array {
  if (participant === 0) return RELEASED;
  return tick >= 40 ? HELD : RELEASED;
}

describe('a rewind', () => {
  /**
   * The central assertion, and the reason it is a *pair*.
   *
   * One run is told every input before it needs it and never rewinds. The other is told nothing
   * about participant 1 until tick 47, predicts it wrong for seven ticks, and then learns the truth
   * and replays. If a rewind is correct the two worlds are the same afterwards, to the bit. A test
   * asserting only that the second run "looks reasonable" would pass a rewind that lands one tick
   * out, which is the error that produces slow drift instead of a visible break.
   */
  it('replaying lands exactly where running would have', () => {
    const straight = makeSim(2);
    for (let tick = 0; tick <= 59; tick++) {
      for (let p = 0; p < 2; p++) straight.inputs.set(p, tick, inputFor(p, tick));
      straight.inputs.retain(Math.max(0, tick - 15));
      straight.loop.advance(FIXED_DT, tick);
    }

    const rolled = makeSim(2);
    for (let tick = 0; tick <= 59; tick++) {
      rolled.inputs.set(0, tick, inputFor(0, tick));
      /* Participant 1 is silent until 47, then everything it owes arrives at once. */
      if (tick === 47) {
        for (let late = 40; late <= 47; late++) {
          expect(rolled.loop.supply(1, late, inputFor(1, late))).toBe(true);
        }
      }
      if (tick > 47) rolled.inputs.set(1, tick, inputFor(1, tick));
      rolled.inputs.retain(Math.max(0, tick - 15));
      rolled.loop.advance(FIXED_DT, tick);
    }

    expect(rolled.loop.stats.replays).toBeGreaterThan(0);
    expect(straight.loop.stats.replays).toBe(0);
    expect(rolled.digest()).toEqual(straight.digest());
  });

  /**
   * The generator is part of the state, and this is the assertion that says so.
   *
   * Without the RNG in the snapshot every value above still matches, because the jitter is
   * overwritten every tick from wherever the stream happens to be. What breaks is that the *stream*
   * has advanced further in the rolled-back run than in the straight one, so the two diverge on the
   * first tick after the replay rather than during it.
   */
  it('puts the generator back, so a replayed tick redraws', () => {
    const sim = makeSim(1);
    for (let tick = 0; tick <= 9; tick++) {
      sim.inputs.set(0, tick, RELEASED);
      sim.loop.advance(FIXED_DT, tick);
    }
    const afterTen = sim.rng.save();

    expect(sim.loop.rewindTo(5)).toBe(true);

    /* Ten ticks ran, five were replayed, and the stream is where ten ticks leaves it — not where
       fifteen would. */
    expect(sim.rng.save()).toBe(afterTen);
  });

  it('refuses to advance a tick that has already run', () => {
    const sim = makeSim(1);
    sim.loop.advance(FIXED_DT, 0);
    sim.loop.advance(FIXED_DT, 1);
    expect(() => sim.loop.advance(FIXED_DT, 1)).toThrow(/already advanced/);
  });

  /**
   * A confirmed input that matches the guess costs nothing.
   *
   * The common case on any held control, and a driver that replayed for it would burn a rewind's
   * work per packet to produce the identical world.
   */
  it('does not replay when the real input matches the prediction', () => {
    const sim = makeSim(2);
    for (let tick = 0; tick <= 9; tick++) {
      sim.inputs.set(0, tick, RELEASED);
      sim.loop.advance(FIXED_DT, tick);
    }
    /* Participant 1 was predicted as released throughout, which is what it actually did. */
    for (let tick = 0; tick <= 9; tick++) {
      expect(sim.loop.supply(1, tick, RELEASED)).toBe(true);
    }

    /*
     * **The advance is the assertion.** A rewind is performed by the next `advance`, so checking
     * the counter without taking another tick asserts nothing at all — which is how this test
     * passed before `set` stopped treating a confirmation as a change.
     */
    sim.inputs.set(0, 10, RELEASED);
    sim.inputs.set(1, 10, RELEASED);
    sim.loop.advance(FIXED_DT, 10);
    expect(sim.loop.stats.replays).toBe(0);
  });

  it('refuses an input for a tick it can no longer reach', () => {
    const sim = makeSim(2);
    for (let tick = 0; tick <= 40; tick++) {
      sim.inputs.set(0, tick, RELEASED);
      sim.inputs.set(1, tick, RELEASED);
      sim.inputs.retain(Math.max(0, tick - 15));
      sim.loop.advance(FIXED_DT, tick);
    }
    /* Tick 2 left the sixteen-slot ring long ago. */
    expect(sim.loop.supply(1, 2, HELD)).toBe(false);
  });

  /**
   * An authoritative state is a different correction from a late input, and the difference is what
   * `reconcileSnapshot` exists for: the ticks since were computed from a wrong *world*, not from a
   * wrong input, so the local inputs are kept and only the state is overwritten.
   */
  it('reconciles an authoritative state and replays the local ticks over it', () => {
    const sim = makeSim(1);
    const entity = sim.entities[0] as number;
    for (let tick = 0; tick <= 20; tick++) {
      sim.inputs.set(0, tick, HELD);
      sim.loop.advance(FIXED_DT, tick);
    }

    const drifted = sim.world.read(entity, Body, 'x') as number;
    expect(drifted).toBeGreaterThan(0);

    const accepted = sim.loop.reconcileSnapshot(15, () => {
      sim.world.write(entity, Body, 'x', -100);
      sim.world.write(entity, Body, 'vx', 0);
    });

    expect(accepted).toBe(true);
    /* Six ticks of the player's own held input were replayed over the correction, so the position
       is near the authority's and moving again — not equal to it, and not the old value. */
    const corrected = sim.world.read(entity, Body, 'x') as number;
    expect(corrected).toBeGreaterThan(-100);
    expect(corrected).toBeLessThan(-99);
    expect(sim.loop.tick).toBe(20);
  });

  it('refuses to reconcile a tick outside the window', () => {
    const sim = makeSim(1);
    for (let tick = 0; tick <= 40; tick++) {
      sim.inputs.set(0, tick, RELEASED);
      sim.inputs.retain(Math.max(0, tick - 15));
      sim.loop.advance(FIXED_DT, tick);
    }
    expect(sim.loop.reconcileSnapshot(1, () => {})).toBe(false);
  });

  /**
   * A replay rewrites the snapshots it passes over, and **this has to be differential to see it.**
   *
   * A second correction landing inside a range that has already been replayed must find the state
   * that tick began with *this* time. If the replay left the original snapshots in place, the
   * second rewind restores a world built from inputs that have since been overruled, and the run
   * diverges — while every counter, every tick number and every "did it rewind" assertion stays
   * perfectly correct. An earlier version of this test checked exactly those and passed with the
   * rewrite deleted.
   *
   * The input is a *tap* rather than a hold, because repeat-the-last then predicts wrongly on both
   * sides of it and each correction has something to change.
   */
  it('a second correction into a replayed range lands where a straight run would', () => {
    /** Participant 1 taps its control for ticks 12 through 14 and is released otherwise. */
    const tap = (participant: number, tick: number): Uint8Array => {
      if (participant === 0) return RELEASED;
      return tick >= 12 && tick <= 14 ? HELD : RELEASED;
    };

    const straight = makeSim(2);
    for (let tick = 0; tick <= 29; tick++) {
      for (let p = 0; p < 2; p++) straight.inputs.set(p, tick, tap(p, tick));
      straight.loop.advance(FIXED_DT, tick);
    }

    const rolled = makeSim(2);
    for (let tick = 0; tick <= 29; tick++) {
      rolled.inputs.set(0, tick, tap(0, tick));
      /* The first batch corrects ticks 10 to 13, leaving 14 onward predicted from a held control. */
      if (tick === 20) {
        for (let late = 10; late <= 13; late++) {
          expect(rolled.loop.supply(1, late, tap(1, late))).toBe(true);
        }
      }
      /* The second lands inside the range the first one replayed. */
      if (tick === 21) {
        for (let late = 14; late <= 21; late++) rolled.loop.supply(1, late, tap(1, late));
      }
      if (tick > 21) rolled.inputs.set(1, tick, tap(1, tick));
      rolled.loop.advance(FIXED_DT, tick);
    }

    expect(rolled.loop.stats.replays).toBe(2);
    expect(rolled.digest()).toEqual(straight.digest());
  });

  it('reports the oldest tick it can still reach', () => {
    const sim = makeSim(1);
    expect(sim.loop.earliest).toBe(-1);
    for (let tick = 0; tick <= 20; tick++) {
      sim.inputs.set(0, tick, RELEASED);
      sim.loop.advance(FIXED_DT, tick);
    }
    /* Sixteen slots, the newest holding tick 20. */
    expect(sim.loop.earliest).toBe(5);
  });

  it('tells a step whether it is a replay', () => {
    const world = new World();
    const rng = savableMulberry32(1);
    const inputs = new InputLog({ participants: 1, depth: 32, inputBytes: 1 });
    const seen: boolean[] = [];
    let loop: RewindLoop<readonly unknown[]>;

    loop = new RewindLoop({
      step: () => seen.push(loop.isReplaying),
      snapshotter: combineSnapshotters([
        worldSnapshotter(world),
        randomSnapshotter(rng),
      ] as never[]),
      inputs,
      fixedDt: FIXED_DT,
      depth: 8,
    });

    loop.advance(FIXED_DT, 0);
    loop.advance(FIXED_DT, 1);
    expect(seen).toEqual([false, false]);

    loop.rewindTo(0);
    expect(seen).toEqual([false, false, true, true]);
  });
});
