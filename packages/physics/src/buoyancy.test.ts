import { describe, expect, it } from 'vitest';

import { applyBuoyancy, createBuoyancy } from './buoyancy.ts';

/**
 * Water, as the two things it does to a body that falls in.
 *
 * **Drag on every axis, not only the vertical one**, because killing momentum is the whole reason
 * falling in is a setback rather than a shortcut — a body that kept its horizontal speed underwater
 * would be taking a faster line.
 */

const DT = 1 / 60;

describe('a body under water', () => {
  it('leaves a body above the surface entirely alone', () => {
    const state = { velX: 10, velY: -20, velZ: 4 };
    const water = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
    expect(applyBuoyancy(water, 5, state, DT), 'not submerged').toBe(false);
    expect(state.velX).toBe(10);
    expect(state.velY).toBe(-20);
    expect(state.velZ).toBe(4);
  });

  it('bleeds momentum on every axis', () => {
    const state = { velX: 10, velY: 0, velZ: -10 };
    const water = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
    expect(applyBuoyancy(water, -1, state, DT)).toBe(true);
    expect(Math.abs(state.velX)).toBeLessThan(10);
    expect(Math.abs(state.velZ)).toBeLessThan(10);
  });

  it('settles a fall to a slow terminal speed instead of accelerating', () => {
    /* A body that kept accelerating downward would reach the seabed at speed, and the drop into
       water would read as a fall onto glass. */
    const state = { velX: 0, velY: -30, velZ: 0 };
    const water = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
    applyBuoyancy(water, -1, state, DT);
    expect(state.velY).toBe(-1.2);
  });

  it('does not push a sinking body back up', () => {
    /* The sink speed is a floor on how fast it falls, not a target it is driven to: a body
       drifting down slower than terminal is left alone. */
    const state = { velX: 0, velY: -0.3, velZ: 0 };
    const water = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
    applyBuoyancy(water, -1, state, DT);
    expect(state.velY).toBeGreaterThan(-1.2);
    expect(state.velY).toBeLessThan(0);
  });

  it('cannot reverse a velocity however large the step', () => {
    /*
     * `1 − drag·dt` goes negative past `dt = 1/drag`, and a negative factor does not slow a body,
     * it throws it backwards. Clamped at zero, so the worst a long step can do is stop it dead.
     */
    const state = { velX: 10, velY: 0, velZ: 0 };
    const water = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
    applyBuoyancy(water, -1, state, 10);
    expect(state.velX).toBe(0);
  });

  it('has no water at all by default', () => {
    /*
     * A consumer with no water pays nothing and gets nothing: the level is −Infinity, so no
     * position is ever under it. Every consumer that has not asked reaches none of this.
     */
    const state = { velX: 10, velY: -20, velZ: 0 };
    expect(applyBuoyancy(createBuoyancy(), -1e9, state, DT)).toBe(false);
    expect(state.velX).toBe(10);
  });
});
