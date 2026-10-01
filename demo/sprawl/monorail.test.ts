import { describe, expect, it } from 'vitest';

import { DWELL, Monorail, RUN } from './monorail';
import type { LineData } from './scene';
import { Track } from './track';

/**
 * A rounded rectangle 400 m by 200 m at 14 m, its corners arcs of 30 m in 4° pieces, walked the
 * way a one-way loop runs: out along +x, up +z, back −x, down −z.
 */
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

/** A path walked from the origin heading +x: straights, and arcs turned left in 2 m pieces. */
function walk(steps: readonly (readonly [number] | readonly [number, number])[]): number[] {
  const out = [0, 14, 0];
  let x = 0;
  let z = 0;
  let a = 0;
  for (const step of steps) {
    if (step.length === 1) {
      x += Math.cos(a) * step[0];
      z += Math.sin(a) * step[0];
      out.push(x, 14, z);
      continue;
    }
    const [r, turn] = step;
    const pieces = Math.max(1, Math.round((r * turn) / 2));
    for (let k = 0; k < pieces; k++) {
      const da = turn / pieces;
      const chord = 2 * r * Math.sin(da / 2);
      x += Math.cos(a + da / 2) * chord;
      z += Math.sin(a + da / 2) * chord;
      a += da;
      out.push(x, 14, z);
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
const DT = 1 / 60;

describe('the monorail', () => {
  it('A CORNER OF 30 M ALLOWS √(3.2 × 30) = 9.8 M/S, AND THE TRACK BEFORE IT BRAKES FOR IT', () => {
    const track = new Track(LINE.path, 3.2, 5.2, 84 / 3.6);
    /* The track starts where the first corner's arc does: its middle is an eighth of a circle on. */
    expect(track.limitAt((Math.PI * 30) / 4)).toBeCloseTo(Math.sqrt(3.2 * 30), 1);
    /* 40 m before that arc, on the closing straight: no faster than braking at 5.2 m/s² allows. */
    expect(track.limitAt(track.length - 40)).toBeCloseTo(Math.sqrt(3.2 * 30 + 2 * 5.2 * 40), 0);
    /* The closing straight's middle, 170 m from either corner: the cruise cap. */
    expect(track.limitAt(track.length - 170)).toBeCloseTo(84 / 3.6, 3);
    /* 2 × 140 + 2 × 340 of straight and four quarter circles of 30 m. */
    expect(track.length).toBeCloseTo(960 + 60 * Math.PI, 0);
  });

  it('A GENTLE BEND BEFORE A TIGHT ONE IS ALREADY SLOW ENOUGH TO BRAKE FOR THE TIGHT ONE', () => {
    /* 300 m, then 6° of a 100 m radius (10.5 m) running straight into a quarter turn of 5 m. */
    const track = new Track(
      walk([
        [300],
        [100, (6 * Math.PI) / 180],
        [5, Math.PI / 2],
        [300],
        [30, Math.PI / 2],
        [300],
        [30, Math.PI / 2],
      ]),
      3.2,
      5.2,
      84 / 3.6,
    );
    /* The tight turn allows √(3.2 × 5) = 4 m/s; 10.5 m before it, √(16 + 2 × 5.2 × 10.5) = 11.2,
       well under the gentle bend's own √(3.2 × 100) = 17.9. */
    expect(track.limitAt(300 + 0.01)).toBeGreaterThan(10.5);
    expect(track.limitAt(300 + 0.01)).toBeLessThan(11.6);
  });

  it('A TRAIN STOPS ITS MIDDLE AT EACH PLATFORM FOR THE DWELL AND ITS DOORS BOTH WAYS', () => {
    const rail = new Monorail(
      [LINE],
      [
        { line: 'ring', along: 100 },
        { line: 'ring', along: 600 },
      ],
    );
    const stands: [number, number][] = [];
    let since = -1;
    let hardest = 0;
    let arriving = 0;
    for (let tick = 0; tick < 60 * 240; tick++) {
      const before = rail.v[0] as number;
      const running = rail.phase[0] === RUN;
      rail.step(DT);
      if (running && rail.phase[0] === DWELL) arriving = Math.max(arriving, before);
      else hardest = Math.max(hardest, (before - (rail.v[0] as number)) / DT);
      if (rail.phase[0] === DWELL && since < 0) {
        since = tick;
        /* The middle car's centre is half the train, 21.9 m, behind its front. */
        stands.push([Math.round(((rail.s[0] as number) - 21.9) * 10) / 10, 0]);
      }
      if (rail.phase[0] === RUN && since >= 0) {
        (stands[stands.length - 1] as [number, number])[1] =
          Math.round((tick - since) * DT * 10) / 10;
        since = -1;
      }
    }
    /* It brakes into each platform along its line's 5.2 m/s² curve — within a per cent, the
       track's own envelope being continuous rather than a tick at a time — and the tick that ends
       the curve takes off no more than a crawl. */
    expect(hardest).toBeLessThanOrEqual(5.2 * 1.01);
    expect(arriving).toBeLessThan(0.35);
    expect(stands.slice(0, 4)).toEqual([
      [100, 6],
      [600, 6],
      [100, 6],
      [600, 6],
    ]);
  });

  it('TRAINS KEEP THE MINIMUM GAP, AND NO CAR IS EVER FASTER THAN ITS CURVE ALLOWS', () => {
    const rail = new Monorail(
      [{ ...LINE, trains: 6 }],
      [
        { line: 'ring', along: 100 },
        { line: 'ring', along: 300 },
        { line: 'ring', along: 600 },
        { line: 'ring', along: 900 },
      ],
    );
    const track = (rail.lines[0] as { track: Track }).track;
    let closest = Infinity;
    let fastest = 0;
    for (let tick = 0; tick < 60 * 600; tick++) {
      rail.step(DT);
      for (let i = 0; i < 6; i++) {
        const ahead = (i + 1) % 6;
        const gap =
          ((((rail.s[ahead] as number) - 43.8 - (rail.s[i] as number)) % track.length) +
            track.length) %
          track.length;
        closest = Math.min(closest, gap);
        for (const back of [0, 21.9, 43.8]) {
          fastest = Math.max(
            fastest,
            (rail.v[i] as number) - track.limitAt((rail.s[i] as number) - back),
          );
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(60 - 0.5);
    expect(fastest).toBeLessThanOrEqual(0.1);
  });
});
