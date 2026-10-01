import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { buildMonorail } from './monorail.ts';
import type { RailLine } from './monorail.ts';
import type { Vec2 } from './plane.ts';

const line = (name: string, index: number, points: Vec2[]): string =>
  [
    `  ${name} { MonorailLine: {index: ${index}, rank: ${index}, corridor: 9, corner_radius: 10,`,
    '    arc_span_length: 1, track_y: 14, platform_half: 20}',
    ...points.map(([x, z], i) => `    p${i} { RailPoint: {index: ${i}, x: ${x}, z: ${z}} }`),
    '  }',
  ].join('\n');

const SCRIPT = [
  'mono_lines {',
  line('a', 0, [
    [0, 0],
    [200, 0],
    [200, 200],
    [0, 200],
  ]),
  line('b', 1, [
    [200, 0],
    [400, 0],
    [400, 200],
    [200, 200],
  ]),
  /* Crosses a's first edge twice, at x = 100 and x = 150. */
  line('c', 2, [
    [100, -100],
    [150, -100],
    [150, 100],
    [100, 100],
  ]),
  /* A chamfered corner at (100, 0), 135° inside, like the outer ring's. */
  line('bent', 4, [
    [1000, 0],
    [1100, 0],
    [1150, 50],
    [1150, 150],
    [1000, 150],
  ]),
  /* Straight pieces of 10 m: nowhere holds a 40 m platform. */
  line('tiny', 3, [
    [600, 0],
    [630, 0],
    [630, 30],
    [600, 30],
  ]),
  '}',
  'mono_stops {',
  '  top { MonorailStop: {index: 0, line: a, x: 100, z: 200} }',
  '  corner { MonorailStop: {index: 1, line: a, x: 3, z: 3} }',
  '  nowhere { MonorailStop: {index: 2, line: tiny, x: 615, z: 0} }',
  '}',
].join('\n');

function nearest(l: RailLine, p: Vec2): number {
  let best = 0;
  let distance = Infinity;
  l.path.forEach((q, k) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < distance) {
      distance = d;
      best = k;
    }
  });
  return best;
}

describe('the monorail', () => {
  const world = readScripts(['m.flecs'], (f) => (f === 'm.flecs' ? SCRIPT : null)).world;
  const { lines, stops, dropped } = buildMonorail(world);
  const [a, b, c] = lines as [RailLine, RailLine, RailLine];

  it('RUNS TWO LINES SHARING AN EDGE A CORRIDOR APART, AND ROUNDS EVERY CORNER TO ITS RADIUS', () => {
    expect(a.path[0]).toEqual(a.path[a.path.length - 1]);
    /* Halfway up the shared edge at x = 200, the two tracks stand 9 m apart. */
    const onA = a.path[nearest(a, [200, 100])] as Vec2;
    const onB = b.path[nearest(b, [200, 100])] as Vec2;
    expect(Math.abs(onA[0] - onB[0])).toBeCloseTo(9, 6);
    /* A 10 m fillet on a square corner passes r(√2 − 1) from the vertex. */
    const corner = Math.min(...a.path.map((q) => Math.hypot(q[0], q[1])));
    expect(corner).toBeCloseTo(10 * (Math.SQRT2 - 1), 1);
    /* At 135° a 10 m fillet passes r(1 / sin 67.5° − 1) from its vertex. */
    const bent = lines.find((l) => l.name === 'bent') as RailLine;
    const chamfer = Math.min(...bent.path.map((q) => Math.hypot(q[0] - 1100, q[1])));
    expect(chamfer).toBeCloseTo(10 * (1 / Math.sin((67.5 * Math.PI) / 180) - 1), 1);
  });

  it('lifts the higher-ranked line over a crossing and leaves the lower level', () => {
    const k = nearest(c, [100, 0]);
    expect(c.height[k]).toBeCloseTo(21, 1);
    expect(a.height[nearest(a, [100, 0])]).toBe(14);
    expect(c.height[nearest(c, [125, -100])]).toBe(14);
  });

  it('seats a stop on the nearest straight, level stretch, and drops one that has none', () => {
    const top = stops.find((s) => s.name === 'top');
    expect(top?.position[0]).toBeCloseTo(100, 6);
    expect(top?.position[1]).toBeCloseTo(200, 6);
    /* The top edge runs from (200, 200) to (0, 200): local +x along it is world −x. */
    expect(Math.abs(top?.heading ?? 0)).toBeCloseTo(Math.PI, 6);
    const moved = stops.find((s) => s.name === 'corner');
    expect(moved).toBeDefined();
    const [mx, mz] = moved?.position ?? [0, 0];
    /* Off the corner's arc, with 20 m of straight either side: at least 30 m along an edge. */
    expect(Math.max(mx, mz)).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(Math.min(mx, mz)).toBeCloseTo(0, 6);
    expect(stops.some((s) => s.name === 'nowhere')).toBe(false);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/^nowhere: no clear platform/);
  });
});
