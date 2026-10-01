import { describe, expect, it } from 'vitest';

import type { StreetData } from './lanes';
import { PavementGraph } from './pavements';

/* Two lanes of 3.5 m each way, 3 m of pavement: a pavement's middle is 8.5 m from the centre. */
const street = (vertical: boolean, from: number, to: number): StreetData => ({
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
  green: 14,
  y: 0.3,
});

/* A signalled crossing at the origin, its four arms ending 100 m out. */
const CROSS = [
  street(true, -100, 0),
  street(true, 0, 100),
  street(false, -100, 0),
  street(false, 0, 100),
];
const graph = new PavementGraph(CROSS, [{ x: 0, z: 0, streets: [0, 1, 2, 3] }], [0]);

const at = (g: PavementGraph, n: number): number[] => [g.x[n] as number, g.z[n] as number];
const node = (g: PavementGraph, x: number, z: number): number => {
  for (let n = 0; n < g.count; n++) if (g.x[n] === x && g.z[n] === z) return n;
  return -1;
};
const neighbours = (g: PavementGraph, n: number): number[][] => {
  const out: number[][] = [];
  for (let e = g.first[n] as number; e < (g.first[n + 1] as number); e++) {
    out.push(at(g, g.next[e] as number));
  }
  return out.sort(
    (a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number),
  );
};

describe('the pavements', () => {
  it('A CORNER STANDS WHERE TWO PAVEMENTS MEET, AND EACH SIDE OF A STREET RUNS CORNER TO END', () => {
    /* NE, NW, SW, SE. */
    expect([0, 1, 2, 3].map((n) => at(graph, n))).toEqual([
      [8.5, 8.5],
      [-8.5, 8.5],
      [-8.5, -8.5],
      [8.5, -8.5],
    ]);
    /* The south-east corner: across to the south-west and the north-east, down the east side of
       the south arm and out along the south side of the east arm, each to where it ends. */
    expect(neighbours(graph, 3)).toEqual([
      [-8.5, -8.5],
      [8.5, -100],
      [8.5, 8.5],
      [100, -8.5],
    ]);
    /* The north-east corner: up the east side of the north arm, and along the north side of the
       east arm. */
    expect(neighbours(graph, 0)).toEqual([
      [-8.5, 8.5],
      [8.5, -8.5],
      [8.5, 100],
      [100, 8.5],
    ]);
    /* Where the south arm ends with no junction, its two sides join across the road. */
    expect(neighbours(graph, node(graph, 8.5, -100))).toEqual([
      [-8.5, -100],
      [8.5, -8.5],
    ]);
  });

  it('A CROSSING WAITS FOR THE PHASE THAT STOPS WHAT IT CROSSES; A PAVEMENT WAITS FOR NOTHING', () => {
    const se = 3;
    const step = (a: number, b: number): number => graph.stepOf(a, b);
    /* Across the south arm, a street along z: it goes on the phase of the streets along x. */
    expect([graph.signal[step(se, 2)], graph.phase[step(se, 2)]]).toEqual([0, 1]);
    /* Across the east arm, a street along x: on the phase of those along z. */
    expect([graph.signal[step(se, 0)], graph.phase[step(se, 0)]]).toEqual([0, 0]);
    expect(graph.signal[step(se, node(graph, 8.5, -100))]).toBe(-1);
  });

  it('ROUND A CORNER NO STREET LEAVES BY, THE WALK NEEDS NO SIGNAL', () => {
    /* The same junction without its north arm. */
    const tee = new PavementGraph(
      [CROSS[0] as StreetData, CROSS[2] as StreetData, CROSS[3] as StreetData],
      [{ x: 0, z: 0, streets: [0, 1, 2] }],
      [0],
    );
    expect(tee.signal[tee.stepOf(1, 0)]).toBe(-1);
    expect(tee.signal[tee.stepOf(2, 3)]).toBe(0);
  });

  it('A ROUTE IS THE SHORTEST WALK, CUT AT ITS FIRST NODES WHEN IT WILL NOT FIT', () => {
    /* From the south-west corner out along the east arm's south side: across the south arm and
       along, 108.5 m; every other way goes round a corner more. */
    const from = 2;
    const to = node(graph, 100, -8.5);
    const out = new Uint16Array(8);
    expect(graph.route(from, to, out, 2, 6)).toBe(2);
    expect(Array.from(out.subarray(2, 4)).map((n) => at(graph, n))).toEqual([
      [8.5, -8.5],
      [100, -8.5],
    ]);
    expect(graph.route(from, to, out, 0, 1)).toBe(1);
    expect(at(graph, out[0] as number)).toEqual([8.5, -8.5]);
    expect(graph.route(from, from, out, 0, 4)).toBe(0);
    expect(graph.nearest(7, 9)).toBe(0);
  });
});
