import { describe, expect, it } from 'vitest';

import { MIN_GAP } from './idm';
import { buildLanes } from './lanes';
import type { StreetData } from './lanes';
import { RED, lightAt } from './signals';
import { STOP_LINE, Traffic } from './traffic';
import type { VehicleKind } from './traffic';

const street = (vertical: boolean, from: number, to: number, green: number): StreetData => ({
  vertical,
  at: 0,
  from,
  to,
  lanes: 2,
  laneWidth: 3.5,
  median: 0,
  sidewalk: 3,
  speed: 11,
  closed: false,
  green,
  y: 0.3,
});

/* A signalled crossing whose four arms turn round at their far ends: a closed loop of queues. */
const graph = buildLanes(
  [
    street(true, -100, 0, 22),
    street(true, 0, 100, 22),
    street(false, -100, 0, 14),
    street(false, 0, 100, 14),
  ],
  [{ x: 0, z: 0, streets: [0, 1, 2, 3] }],
  [],
);
/* A saloon, a lorry, a taxi placed only by name, and a car that has broken down. */
const KINDS: VehicleKind[] = [
  { length: 4.6, maxSpeed: 24, accel: 3.6, brake: 7.5, weight: 1 },
  { length: 8, maxSpeed: 16, accel: 1.8, brake: 5, weight: 1 },
  { length: 4.7, maxSpeed: 24, accel: 3.8, brake: 7.8, weight: 0 },
  { length: 4.6, maxSpeed: 0, accel: 3.6, brake: 7.5, weight: 0 },
];
const DT = 1 / 60;

/** The lane of `street` going `dir`, lane `k`. */
function laneOf(street: number, dir: number, k: number): number {
  for (let e = 0; e < graph.count; e++) {
    if (graph.street[e] === street && graph.dir[e] === dir && graph.lane[e] === k) return e;
  }
  return -1;
}

/** The first moment `phase` of the crossing's signal turns red. */
function redFrom(phase: number): number {
  let t = 0;
  while (lightAt(graph.signals, 0, phase, t) === RED) t += 0.05;
  while (lightAt(graph.signals, 0, phase, t) !== RED) t += 0.05;
  return t;
}

describe('the traffic', () => {
  it('NO TWO CARS ON AN EDGE COME WITHIN HALF THE MINIMUM GAP OVER TEN MINUTES, AND THEY DO MOVE', () => {
    const traffic = new Traffic(graph, KINDS, 40, 8, 2, 10, 7);
    let closest = Infinity;
    let travelled = 0;
    for (let tick = 0; tick < 36000; tick++) {
      traffic.step(DT, tick * DT);
      for (let i = 0; i < traffic.count; i++) travelled += (traffic.v[i] as number) * DT;
      for (let i = 0; i < traffic.count; i++) {
        for (let j = 0; j < traffic.count; j++) {
          if (i === j || traffic.edge[i] !== traffic.edge[j]) continue;
          const behind = traffic.s[i] as number;
          const front = traffic.s[j] as number;
          if (front < behind) continue;
          const length = (KINDS[traffic.kind[j] as number] as VehicleKind).length;
          closest = Math.min(closest, front - length - behind);
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(MIN_GAP / 2);
    /* A loop this small, half of it red at any moment, still averages a walking pace or better. */
    expect(travelled / 48 / 600).toBeGreaterThan(2);
  });

  it('TWO RUNS FROM ONE SEED ARE THE SAME CAR FOR CAR, AND ANOTHER SEED IS NOT', () => {
    const run = (seed: number): number[] => {
      const traffic = new Traffic(graph, KINDS, 40, 8, 2, 10, seed);
      for (let tick = 0; tick < 1200; tick++) traffic.step(DT, tick * DT);
      return [...traffic.edge, ...traffic.s];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(8)).not.toEqual(run(7));
  });

  it('A CAR STOPS AT A RED LINE, AND GOES ON WHEN IT TURNS GREEN', () => {
    const traffic = new Traffic(graph, KINDS, 1, 0, 2, 10, 7);
    /* Northbound on the south arm: 90 m from its turn-round to 10 m short of the crossing. */
    const lane = laneOf(0, 1, 0);
    const t0 = redFrom(0);
    traffic.place(0, lane, 40, 10);
    for (let tick = 0; tick < 600; tick++) traffic.step(DT, t0 + tick * DT);
    /* Ten seconds into a red of 17: stopped, and short of the line at 90 − 2 = 88 m. */
    expect(traffic.edge[0]).toBe(lane);
    expect(traffic.s[0]).toBeLessThanOrEqual(90 - STOP_LINE + 0.1);
    expect(traffic.s[0]).toBeGreaterThan(80);
    expect(traffic.v[0]).toBeLessThan(0.1);
    /* Twelve seconds more reaches the green; by then it has gone. */
    for (let tick = 600; tick < 1320; tick++) traffic.step(DT, t0 + tick * DT);
    expect(traffic.edge[0]).not.toBe(lane);
  });

  it('A CAR STOPPED A HAIR OVER THE LINE STILL WAITS FOR THE GREEN; ONLY ONE MOVING OVER IT GOES ON', () => {
    const traffic = new Traffic(graph, KINDS, 2, 0, 2, 10, 7);
    const t0 = redFrom(0);
    /* Five centimetres past the line at 88 m, standing: it waits. */
    traffic.place(0, laneOf(0, 1, 0), 88.05, 0);
    traffic.kind[0] = 0;
    /* A metre past it at 8 m/s as the light changes: it cannot stop, and goes on. */
    traffic.place(1, laneOf(0, 1, 1), 89, 8);
    traffic.kind[1] = 0;
    for (let tick = 0; tick < 5 * 60; tick++) traffic.step(DT, t0 + tick * DT);
    expect(traffic.edge[0]).toBe(laneOf(0, 1, 0));
    expect(traffic.s[0]).toBeLessThan(88.2);
    expect(traffic.edge[1]).not.toBe(laneOf(0, 1, 1));
  });

  it('A QUEUE BEHIND A RED LIGHT WAITS OUT A RED LONGER THAN THE RESCUE’S PATIENCE', () => {
    /* Eastbound: its red is 42 − 14 − 3 = 25 s, past the 18 s after which a stuck car is lifted. */
    const traffic = new Traffic(graph, KINDS, 3, 0, 2, 10, 7);
    const lane = laneOf(2, 1, 1);
    const t0 = redFrom(1);
    /* Already queued from the line at 88 m, each 4.6 m long and 2 m behind the next: all three
       stand still for the whole red, and only the first is held by the light itself. */
    traffic.place(0, lane, 88, 0);
    traffic.place(1, lane, 81.4, 0);
    traffic.place(2, lane, 74.8, 0);
    for (let tick = 0; tick < 24 * 60; tick++) traffic.step(DT, t0 + tick * DT);
    expect([...traffic.edge]).toEqual([lane, lane, lane]);
    expect([...traffic.s].map((x) => Math.round(x))).toEqual([88, 81, 75]);
  });

  it('A CAR STOPPED 18 S WHERE NO SIGNAL HOLDS IT IS LIFTED ONTO AN OPEN STRETCH', () => {
    const traffic = new Traffic(graph, KINDS, 1, 0, 2, 10, 7);
    const lane = laneOf(1, 1, 0);
    /* Broken down on the north arm, facing its turn-round, where no signal holds it. */
    traffic.place(0, lane, 50, 0);
    traffic.kind[0] = 3;
    for (let tick = 0; tick < 17 * 60; tick++) traffic.step(DT, tick * DT);
    expect([traffic.edge[0], traffic.s[0]]).toEqual([lane, 50]);
    for (let tick = 17 * 60; tick < 19 * 60; tick++) traffic.step(DT, tick * DT);
    expect([traffic.edge[0], traffic.s[0]]).not.toEqual([lane, 50]);
  });

  it('A CAR THAT CANNOT STOP IN TIME STOPS SHORT OF THE ONE AHEAD, NOT INSIDE IT', () => {
    const traffic = new Traffic(graph, KINDS, 2, 0, 2, 10, 7);
    const lane = laneOf(1, 1, 0);
    traffic.place(0, lane, 60, 0);
    traffic.kind[0] = 3;
    /* 5.4 m behind at 20 m/s: stopping at 7.5 m/s² would take 26.7 m. */
    traffic.place(1, lane, 50, 20);
    traffic.kind[1] = 0;
    for (let tick = 0; tick < 60; tick++) {
      traffic.step(DT, tick * DT);
      expect((traffic.s[0] as number) - 4.6 - (traffic.s[1] as number)).toBeGreaterThan(0);
    }
  });

  it('A CAR SEES A BLOCKED LANE PAST ITS TURN FROM AFAR, AND NEVER HAS TO BRAKE HARD FOR IT', () => {
    const traffic = new Traffic(graph, KINDS, 2, 0, 2, 10, 7);
    /* The north arm's turn-round: broken down just past it, the rear at the southbound start. */
    traffic.place(0, laneOf(1, -1, 0), 4.6, 0);
    traffic.kind[0] = 3;
    traffic.place(1, laneOf(1, 1, 0), 20, 10);
    traffic.kind[1] = 0;
    let hardest = 0;
    /* Fifteen seconds: time to stop, and short of the 18 s after which the broken car is lifted. */
    for (let tick = 0; tick < 15 * 60; tick++) {
      const before = traffic.v[1] as number;
      traffic.step(DT, tick * DT);
      hardest = Math.max(hardest, (before - (traffic.v[1] as number)) / DT);
    }
    /* Its comfortable braking is 3.75 m/s² and its hardest 7.5: it keeps well inside the second. */
    expect(hardest).toBeLessThan(5);
    expect(traffic.v[1]).toBeLessThan(0.1);
  });

  it('A CAR ON A CLEAR ROAD SLOWS TO THE TURN’S PACE BEFORE IT TURNS', () => {
    const traffic = new Traffic(graph, KINDS, 1, 0, 2, 10, 7);
    const lane = laneOf(1, 1, 0);
    traffic.place(0, lane, 20, 11);
    traffic.kind[0] = 0;
    let entering = -1;
    for (let tick = 0; tick < 20 * 60 && entering < 0; tick++) {
      traffic.step(DT, tick * DT);
      if (traffic.edge[0] !== lane) entering = traffic.v[0] as number;
    }
    /* Onto the turn-round at its 6.5 m/s, from the street's 11 — within the little a tick adds. */
    expect(entering).toBeGreaterThan(6);
    expect(entering).toBeLessThanOrEqual(6.7);
  });

  it('OF TWO CARS TURNING INTO ONE LANE, THE ONE FURTHER FROM IT LETS THE OTHER IN FIRST', () => {
    const traffic = new Traffic(graph, KINDS, 2, 0, 2, 10, 7);
    const into = laneOf(1, 1, 1);
    /* The turn from `lane` into the north arm's kerbside lane: straight on from the south, right
       from the west. */
    const turnFrom = (lane: number): number => {
      for (let i = graph.first[lane] as number; i < (graph.first[lane + 1] as number); i++) {
        const t = graph.next[i] as number;
        if (graph.next[graph.first[t] as number] === into) return t;
      }
      return -1;
    };
    const straight = turnFrom(laneOf(0, 1, 1));
    const right = turnFrom(laneOf(2, 1, 1));
    /* One standing 3 m from the lane, 1.3 s away at its 3.6 m/s²; the other 5 m out at 6 m/s,
       0.8 s away, which alone would get there first. */
    traffic.place(0, straight, (graph.length[straight] as number) - 3, 0);
    traffic.place(1, right, (graph.length[right] as number) - 5, 6);
    traffic.kind[0] = 0;
    traffic.kind[1] = 0;
    let first = -1;
    for (let tick = 0; tick < 6 * 60; tick++) {
      traffic.step(DT, tick * DT);
      if (first < 0 && traffic.edge[0] === into) first = 0;
      if (first < 0 && traffic.edge[1] === into) first = 1;
      if (traffic.edge[0] === into && traffic.edge[1] === into) {
        expect((traffic.s[0] as number) - 4.6 - (traffic.s[1] as number)).toBeGreaterThan(0);
      }
    }
    expect(first).toBe(0);
    expect(traffic.edge[1]).toBe(into);
  });
});
