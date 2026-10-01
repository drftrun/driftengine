import { describe, expect, it, test } from 'vitest';

import type { DroneRow } from './data/life';
import { CLIMBING, DOCKED, Drones, HOVERING, levelFor } from './drones';
import { blinkOn } from './movers';
import type { Depot, Pad } from './drones';

/* A courier as the reference's table has it, less its spread of speeds. */
const COURIER: DroneRow = {
  kind: 'courier',
  body: 'Drone',
  lite: 'DroneLite',
  weight: 1,
  scale: 1,
  speed: 15,
  speedVar: 0,
  altitude: 0,
  hover: 2.9,
};
const DT = 1 / 60;
const WEST: Pad = { x: -200, y: 0.34, z: 0 };
const EAST: Pad = { x: 200, y: 0.34, z: 0 };

describe('the drones', () => {
  it('A LEG FLIES AT THE LEVEL ITS HEADING KEYS: EAST 44, WEST 52, NORTH 60, SOUTH 68', () => {
    expect([levelFor(10, 3), levelFor(-10, 3), levelFor(3, 10), levelFor(3, -10)]).toEqual([
      44, 52, 60, 68,
    ]);
  });

  it('A DRONE CLIMBS TO ITS LEVEL, CRUISES THERE, AND COMES DOWN TO HOVER OVER ITS PAD', () => {
    const drones = new Drones(2, [COURIER], [], [WEST, EAST], 3);
    drones.place(0, -200, 3, 0, EAST);
    drones.place(1, 200, 3, 0, WEST);
    const top = [0, 0];
    let t = 0;
    for (; t < 60 && drones.phase[0] !== HOVERING; t += DT) {
      drones.step(DT);
      for (const i of [0, 1]) top[i] = Math.max(top[i] as number, drones.y[i] as number);
    }
    /* Eastbound at 44 m and westbound at 52, each within its 2.4 m of jitter. */
    expect(Math.abs((top[0] as number) - 44)).toBeLessThanOrEqual(2.4);
    expect(Math.abs((top[1] as number) - 52)).toBeLessThanOrEqual(2.4);
    /* Over the pad at its hover height, 0.34 + 2.9 m; about 5.5 s up, 26.7 across, 6.9 down. */
    expect([drones.x[0], drones.z[0]]).toEqual([200, 0]);
    expect(drones.y[0]).toBeCloseTo(3.24, 3);
    expect(t).toBeGreaterThan(35);
    expect(t).toBeLessThan(45);
    /* It hovers five to ten seconds, and then it is off again. */
    for (let s = 0; s < 4.9; s += DT) drones.step(DT);
    expect(drones.phase[0]).toBe(HOVERING);
    for (let s = 4.9; s < 10.1; s += DT) drones.step(DT);
    expect(drones.phase[0]).toBe(CLIMBING);
  });

  it('NO TWO DRONES EVER HOLD ONE CHARGING SLOT, HOWEVER MANY WANT ONE', () => {
    /* Two depots of four slots each, and forty drones. */
    const depots: Depot[] = [
      { x: 0, z: 100, yaw: 0, deck: 7.9, slots: 2, pitch: 3 },
      { x: 0, z: -100, yaw: 0.5, deck: 7.9, slots: 2, pitch: 3 },
    ];
    const drones = new Drones(40, [COURIER], depots, [WEST, EAST, { x: 0, y: 0.34, z: 0 }], 9);
    let most = 0;
    let later = 0;
    for (let tick = 0; tick < 60 * 60 * 10; tick++) {
      drones.step(DT);
      const docked: string[] = [];
      for (let i = 0; i < 40; i++) {
        if (drones.phase[i] === DOCKED)
          docked.push(
            `${Math.round((drones.x[i] as number) * 10)},${Math.round((drones.z[i] as number) * 10)}`,
          );
      }
      expect(new Set(docked).size).toBe(docked.length);
      most = Math.max(most, docked.length);
      /* Past four minutes every drone docked at the start has lifted: these came home. */
      if (tick > 60 * 60 * 4) later = Math.max(later, docked.length);
    }
    expect(most).toBe(8);
    expect(later).toBeGreaterThan(0);
  });
});

test('A STROBE IS LIT FOR ITS DUTY OF EACH BEAT, on its own phase', () => {
  /* 1.35 Hz lit for 0.14 of a beat: at t = 0.05 s the beat is 0.0675 in, lit; at 0.2 s, 0.27 in,
     dark; a phase of 0.9 beats puts t = 0.05 at 0.9675, dark, and t = 0.1 at 1.035, lit again. */
  expect(blinkOn(0.05, 1.35, 0.14, 0)).toBe(true);
  expect(blinkOn(0.2, 1.35, 0.14, 0)).toBe(false);
  expect(blinkOn(0.05, 1.35, 0.14, 0.9)).toBe(false);
  expect(blinkOn(0.1, 1.35, 0.14, 0.9)).toBe(true);
});
