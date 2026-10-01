import { describe, expect, it } from 'vitest';

import { AirTaxis, taxiConfig } from './airTaxis';
import type { TaxiRow } from './data/life';
import { Monorail } from './monorail';
import { ON_TAXI, ON_TRAIN, Riding, WAIT_TAXI, WAIT_TRAIN, WALK, rideConfig } from './riding';
import type { LineData } from './scene';

/* The monorail test's loop: a rounded rectangle 400 m by 200 m, corners of 30 m. */
function loop(): number[] {
  const out: number[] = [];
  const r = 30;
  const corners: [number, number, number][] = [
    [200 - r, -100 + r, -Math.PI / 2],
    [200 - r, 100 - r, 0],
    [-200 + r, 100 - r, Math.PI / 2],
    [-200 + r, -100 + r, Math.PI],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= 22; k++) {
      const a = a0 + (k / 22) * (Math.PI / 2);
      out.push(cx + r * Math.cos(a), 14, cz + r * Math.sin(a));
    }
  }
  return out;
}
const LINE: LineData = {
  name: 'ring',
  path: loop(),
  trains: 1,
  minGap: 60,
  carLength: 14.6,
  cruise: 84 / 3.6,
  accel: 4.4,
  brake: 5.2,
  curveAccel: 3.2,
  dwell: 4,
  doorTime: 1,
  tint: 0xffffffff,
  deck: 14.9,
  cars: [
    { kind: 'Cab', flipped: false },
    { kind: 'Car', flipped: false },
    { kind: 'Cab', flipped: true },
  ],
};
const CAB: TaxiRow = { kind: 'cab', prefab: 'Taxi', weight: 1, cruise: 44, bias: 0, dwellScale: 1 };
const DT = 1 / 60;
const CAMERAS = {};

describe('riding', () => {
  it('A RIDER WAITS AT A PLATFORM, BOARDS THE NEXT TRAIN, PASSES A STOP, AND IS SET DOWN WHERE IT ASKED', () => {
    /* Platforms 100, 400 and 700 m round: on the first straight, the second, and the third. */
    const stops = [100, 400, 700].map((along) => {
      const p = new Float32Array(5);
      const rail = new Monorail([LINE], []);
      (rail.lines[0] as { track: { pointAt: (s: number, o: Float32Array) => void } }).track.pointAt(
        along,
        p,
      );
      return { line: 'ring', x: p[0] as number, z: p[2] as number, along };
    });
    const rail = new Monorail([LINE], stops);
    const air = new AirTaxis([], [CAB], taxiConfig({}), 1);
    const [first, , third] = stops as [(typeof stops)[0], (typeof stops)[0], (typeof stops)[0]];
    const riding = new Riding(
      rail,
      air,
      stops,
      [],
      [{ x: third.x, z: third.z + 40, name: 'far_end' }],
      rideConfig({}),
      CAMERAS,
    );
    /* 30 m off, in the street: out of reach. Under it: in. */
    expect(riding.board(first.x + 30, 0, first.z)).toBe(false);
    expect(riding.board(first.x + 5, 0, first.z)).toBe(true);
    expect(riding.state).toBe(WAIT_TRAIN);
    let boardedAt = -1;
    for (let t = 0; t < 600 && !riding.landed; t += DT) {
      rail.step(DT);
      riding.step();
      if (boardedAt < 0 && riding.state === ON_TRAIN) boardedAt = t;
    }
    expect(boardedAt).toBeGreaterThanOrEqual(0);
    expect([riding.state, riding.landed]).toEqual([WALK, true]);
    /* On the third platform's deck, 3.6 m out from the track: the loop's outside. */
    const [x, y, z] = riding.setDown;
    expect(y).toBeCloseTo(14.9, 3);
    expect(Math.hypot((x as number) - third.x, (z as number) - third.z)).toBeCloseTo(3.6, 1);
    expect(Math.hypot(x as number, z as number)).toBeGreaterThan(Math.hypot(third.x, third.z));
  });

  it('A RIDER ON A SKYPORT TAKES THE TAXI PARKED THERE TO THE SKYPORT NEAREST ITS DESTINATION', () => {
    /* Six skyports, so a taxi left to itself would seldom pick the one asked for. */
    const ports = [
      { x: 0, z: 0, yaw: 0, deck: 12.3 },
      { x: 1500, z: 0, yaw: 0, deck: 12.3 },
      { x: 0, z: 1500, yaw: 0, deck: 12.3 },
      { x: -1500, z: 0, yaw: 0, deck: 12.3 },
      { x: 0, z: -1500, yaw: 0, deck: 12.3 },
      { x: 1500, z: 1500, yaw: 0, deck: 12.3 },
    ];
    const air = new AirTaxis(ports, [CAB], taxiConfig({ airTaxiCount: 6 }), 2);
    const rail = new Monorail([], []);
    const riding = new Riding(
      rail,
      air,
      [],
      ports,
      [{ x: 1400, z: 100, name: 'east' }],
      rideConfig({}),
      CAMERAS,
    );
    expect(riding.board(4, 12.3, 3)).toBe(true);
    expect(riding.state).toBe(WAIT_TAXI);
    let flew = false;
    for (let t = 0; t < 300 && !riding.landed; t += DT) {
      air.step(DT);
      riding.step();
      if (riding.state === ON_TAXI) flew = true;
    }
    expect(flew).toBe(true);
    /* By the second deck's door, 3.6 m to its −z. */
    expect(Array.from(riding.setDown).map((v) => Math.round(v * 10) / 10)).toEqual([
      1500, 12.3, -3.6,
    ]);
  });

  it('ESC STOPS WAITING', () => {
    const riding = new Riding(
      new Monorail([], []),
      new AirTaxis([], [CAB], taxiConfig({}), 1),
      [],
      [{ x: 0, z: 0, yaw: 0, deck: 12 }],
      [],
      rideConfig({}),
      CAMERAS,
    );
    riding.board(0, 12, 0);
    riding.leave();
    expect(riding.state).toBe(WALK);
  });
});
