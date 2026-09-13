import { describe, expect, it } from 'vitest';

import { accelerateAlong } from './groundMotor.ts';

const DT = 1 / 60;

describe('accelerating along a wish direction', () => {
  it('adds speed toward the wish', () => {
    const state = { velX: 0, velZ: 0 };
    const added = accelerateAlong(state, 0, 1, 10, 30, DT);
    expect(added).toBeCloseTo(30 * DT, 9);
    expect(state.velZ).toBeCloseTo(30 * DT, 9);
    expect(state.velX).toBe(0);
  });

  it('stops at the wish speed rather than accelerating for ever', () => {
    const state = { velX: 0, velZ: 0 };
    for (let t = 0; t < 600; t++) accelerateAlong(state, 0, 1, 10, 30, DT);
    expect(state.velZ).toBeCloseTo(10, 6);
  });

  it('adds nothing to a body already faster than it asked for', () => {
    /* This can only ever add. Slowing a body down is drag's job, and a motor that braked when you
       eased off would make coasting impossible. */
    const state = { velX: 0, velZ: 20 };
    expect(accelerateAlong(state, 0, 1, 10, 30, DT)).toBe(0);
    expect(state.velZ).toBe(20);
  });

  it('clamps against the shortfall, not against the wish speed', () => {
    /*
     * **The trap.** With `addSpeed` measured against the wish speed rather than the shortfall, a
     * body one tick from its target overshoots it — and a body moving fast in one direction gets
     * a full tick of acceleration in every other, which is a body that cannot turn.
     */
    const state = { velX: 0, velZ: 9.9 };
    const added = accelerateAlong(state, 0, 1, 10, 1000, DT);
    expect(added).toBeCloseTo(0.1, 6);
    expect(state.velZ).toBeCloseTo(10, 6);
  });

  it('lets a body at full speed still gain across its own travel', () => {
    /*
     * **Air-strafing, and it falls out of the dot product rather than being written.** A body at
     * its wish speed along z has zero current speed along x, so a wish pointing at x is entirely
     * unmet and gets a whole tick of acceleration. That is why turning while airborne gains speed
     * in every game descended from Quake, and why it is a verb players learn rather than a bug.
     */
    const state = { velX: 0, velZ: 10 };
    const added = accelerateAlong(state, 1, 0, 10, 30, DT);
    expect(added).toBeCloseTo(30 * DT, 9);
    expect(Math.hypot(state.velX, state.velZ)).toBeGreaterThan(10);
  });

  it('does nothing when nothing was asked for', () => {
    const state = { velX: 3, velZ: 4 };
    expect(accelerateAlong(state, 0, 0, 0, 30, DT)).toBe(0);
    expect(state.velX).toBe(3);
    expect(state.velZ).toBe(4);
  });

  it('reports what it added, so a stalled motor is distinguishable from a satisfied one', () => {
    /* A demand the ground refuses is exactly the interesting case for anything drawing wheelspin:
       a burnout accelerates nobody and smokes the most there is. */
    const stalled = { velX: 0, velZ: 10 };
    expect(accelerateAlong(stalled, 0, 1, 10, 30, DT)).toBe(0);
    const working = { velX: 0, velZ: 0 };
    expect(accelerateAlong(working, 0, 1, 10, 30, DT)).toBeGreaterThan(0);
  });
});
