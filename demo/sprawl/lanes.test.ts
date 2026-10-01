import { describe, expect, it } from 'vitest';

import { buildLanes } from './lanes';
import type { StreetData } from './lanes';
import type { LaneGraph } from './laneEdges';
import { AMBER, GREEN, RED, lightAt } from './signals';

/* Two lanes of 3.5 m each way, no median, 3 m of pavement: 20 m kerb to building line. */
const street = (
  vertical: boolean,
  from: number,
  to: number,
  green: number,
  at = 0,
): StreetData => ({
  vertical,
  at,
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

/* A crossing at the origin: 0 south of it and 1 north, along z; 2 west and 3 east, along x. */
const STREETS = [
  street(true, -100, 0, 22),
  street(true, 0, 100, 22),
  street(false, -100, 0, 14),
  street(false, 0, 100, 14),
];
const graph = buildLanes(STREETS, [{ x: 0, z: 0, streets: [0, 1, 2, 3] }], []);

const laneOf = (g: LaneGraph, s: number, dir: number, k: number): number => {
  for (let e = 0; e < g.count; e++) {
    if (g.turn[e] === 0 && g.street[e] === s && g.dir[e] === dir && g.lane[e] === k) return e;
  }
  return -1;
};
const ends = (g: LaneGraph, e: number): number[] =>
  [0, 2, 6, 8].map((i) => Math.round((g.curve[e * 9 + i] as number) * 100) / 100 + 0);
/** Where a car can be two edges on: through each turn to the lane it joins. */
function reached(g: LaneGraph, e: number): number[] {
  const out: number[] = [];
  for (let i = g.first[e] as number; i < (g.first[e + 1] as number); i++) {
    const t = g.next[i] as number;
    for (let j = g.first[t] as number; j < (g.first[t + 1] as number); j++) {
      out.push(g.next[j] as number);
    }
  }
  return out.sort((a, b) => a - b);
}

describe('the lanes', () => {
  it('A LANE RUNS RIGHT OF ITS STREET’S CENTRE LINE, AND ENDS WHERE THE WIDEST STREET AT ITS JUNCTION BEGINS', () => {
    /* Northbound, +z: right of travel is −x; the inner lane 1.75 m out, the kerbside one 5.25. It
       starts at the street's open end and stops 10 m short of the crossing, half its 20 m width. */
    expect(ends(graph, laneOf(graph, 0, 1, 0))).toEqual([-1.75, -100, -1.75, -10]);
    expect(ends(graph, laneOf(graph, 0, 1, 1))).toEqual([-5.25, -100, -5.25, -10]);
    /* Westbound, −x: right of travel, (−uz, ux), is (0, −1), so the lane is on the −z side. */
    expect(ends(graph, laneOf(graph, 3, -1, 0))).toEqual([100, -1.75, 10, -1.75]);
  });

  it('A KERBSIDE LANE TURNS RIGHT, AN INNER ONE LEFT, BOTH GO STRAIGHT ON, AND NONE GOES BACK', () => {
    /* Northbound, turning right is to −x, westbound; left is to +x, eastbound. */
    const kerbside = reached(graph, laneOf(graph, 0, 1, 1));
    expect(kerbside).toEqual(
      [laneOf(graph, 1, 1, 1), laneOf(graph, 2, -1, 1)].sort((a, b) => a - b),
    );
    const inner = reached(graph, laneOf(graph, 0, 1, 0));
    expect(inner).toEqual([laneOf(graph, 1, 1, 0), laneOf(graph, 3, 1, 0)].sort((a, b) => a - b));
    /* What a turn leads to is a lane along a street, never another turn. */
    for (const e of [...kerbside, ...inner]) expect(graph.turn[e]).toBe(0);
  });

  it('THE MIDDLE LANE OF A STEM MEETING A CROSS STREET TURNS EITHER WAY, AND NEVER BACK', () => {
    /* A three-lane stem from the south into a two-lane street running east–west. */
    const stem = { ...street(true, -100, 0, 22), lanes: 3 };
    const tee = buildLanes(
      [stem, street(false, -100, 0, 14), street(false, 0, 100, 14)],
      [{ x: 0, z: 0, streets: [0, 1, 2] }],
      [],
    );
    /* No straight on and neither the kerbside nor the inner lane: right onto the westbound kerbside
       lane, left onto the eastbound inner one. */
    expect(reached(tee, laneOf(tee, 0, 1, 1))).toEqual(
      [laneOf(tee, 1, -1, 1), laneOf(tee, 2, 1, 0)].sort((a, b) => a - b),
    );
    expect(reached(tee, laneOf(tee, 0, 1, 2))).toEqual([laneOf(tee, 1, -1, 1)]);
  });

  it('A LANE NO JUNCTION SERVES TURNS ROUND ONTO ITS OWN STREET, IN THE SAME LANE', () => {
    expect(reached(graph, laneOf(graph, 1, 1, 0))).toEqual([laneOf(graph, 1, -1, 0)]);
    expect(reached(graph, laneOf(graph, 1, 1, 1))).toEqual([laneOf(graph, 1, -1, 1)]);
  });

  it('WHERE TWO STREETS MEET AT A BEND, EVERY LANE KEEPS ITS PLACE AND NO SIGNAL STANDS', () => {
    const bend = buildLanes(
      [street(true, -100, 0, 22), street(false, 0, 100, 14)],
      [{ x: 0, z: 0, streets: [0, 1] }],
      [],
    );
    /* Northbound onto eastbound is a left turn: the inner lane and the kerbside one both make it. */
    expect(reached(bend, laneOf(bend, 0, 1, 0))).toEqual([laneOf(bend, 1, 1, 0)]);
    expect(reached(bend, laneOf(bend, 0, 1, 1))).toEqual([laneOf(bend, 1, 1, 1)]);
    expect(bend.signals.count).toBe(0);
    expect(bend.signal[laneOf(bend, 0, 1, 0)]).toBe(-1);
  });

  it('EACH CROSSING KEEPS A SIGNAL OF ITS OWN', () => {
    /* Two crossings along one east–west street, at x = 0 and x = 200. */
    const two = buildLanes(
      [
        street(true, -100, 0, 22),
        street(true, 0, 100, 22),
        street(true, -100, 0, 22, 200),
        street(true, 0, 100, 22, 200),
        street(false, -100, 0, 14),
        street(false, 0, 200, 14),
        street(false, 200, 300, 14),
      ],
      [
        { x: 0, z: 0, streets: [0, 1, 4, 5] },
        { x: 200, z: 0, streets: [2, 3, 5, 6] },
      ],
      [],
    );
    expect(two.signals.count).toBe(2);
    expect([two.signal[laneOf(two, 0, 1, 0)], two.signal[laneOf(two, 2, 1, 0)]]).toEqual([0, 1]);
  });

  it('THE ELEVATED ROAD KEEPS RIGHT, MITRED AT ITS CORNERS, AND TURNS ROUND AT BOTH ENDS', () => {
    /* East 100 m, then north 100 m, 10 m up: one lane of 4 m each way beside a 2 m median, so a
       lane's centre is 3 m right of the line. */
    const deck = buildLanes(
      [],
      [],
      [
        {
          points: [0, 10, 0, 100, 10, 0, 100, 10, 100],
          lanes: 1,
          laneWidth: 4,
          median: 2,
          speed: 25,
        },
      ],
    );
    const at = (e: number, i: number): number[] =>
      [0, 1, 2].map((a) => Math.round((deck.curve[e * 9 + i + a] as number) * 1000) / 1000 + 0);
    /* Eastbound, right is +z; at the corner the lane turns inside it, 3 m from both lines. */
    expect([at(0, 0), at(0, 6), at(1, 6)]).toEqual([
      [0, 10, 3],
      [97, 10, 3],
      [97, 10, 100],
    ]);
    /* Back the other way, southbound, right is +x. */
    expect(at(2, 0)).toEqual([103, 10, 100]);
    /* The first stretch leads to the second; the last turns round onto the way back. */
    const nexts = (e: number): number[] =>
      Array.from(deck.next.subarray(deck.first[e], deck.first[e + 1]));
    expect(nexts(0)).toEqual([1]);
    const [round] = nexts(1);
    expect(deck.turn[round as number]).toBe(1);
    expect(nexts(round as number)).toEqual([2]);
  });

  it('A CROSSING’S TWO AXES ARE NEVER GREEN TOGETHER, AND EACH HAS ITS CLASS’S GREEN', () => {
    const north = laneOf(graph, 0, 1, 0);
    const east = laneOf(graph, 2, 1, 0);
    expect([graph.signal[north], graph.signal[east]]).toEqual([0, 0]);
    expect([graph.phase[north], graph.phase[east]]).toEqual([0, 1]);
    /* One cycle, 22 + 14 + two ambers of 3 s = 42 s, sampled every tenth of a second. */
    let along = 0;
    let across = 0;
    for (let i = 0; i < 420; i++) {
      const la = lightAt(graph.signals, 0, 0, i / 10);
      const lb = lightAt(graph.signals, 0, 1, i / 10);
      const a = la === GREEN;
      const b = lb === GREEN;
      expect(a && b).toBe(false);
      /* While one axis shows amber the other still waits: the crossing clears first. */
      if (la === AMBER || lb === AMBER) expect([la, lb]).toContain(RED);
      along += a ? 1 : 0;
      across += b ? 1 : 0;
    }
    expect([along, across]).toEqual([220, 140]);
  });
});
