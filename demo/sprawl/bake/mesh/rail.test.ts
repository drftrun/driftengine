import { describe, expect, it } from 'vitest';

import type { CityLayout } from '../layout/layout.ts';
import type { RailLine } from '../layout/monorail.ts';
import type { Row } from '../layout/rows.ts';
import type { Vec2 } from '../layout/plane.ts';
import { readScripts } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import { railInstances } from './rail.ts';

/* A square loop 100 m a side at 14 m, sampled every 10 m, the first sample again at the end. */
const path: Vec2[] = [];
for (let i = 0; i < 10; i++) path.push([i * 10, 0]);
for (let i = 0; i < 10; i++) path.push([100, i * 10]);
for (let i = 0; i < 10; i++) path.push([100 - i * 10, 100]);
for (let i = 0; i < 10; i++) path.push([0, 100 - i * 10]);
path.push([0, 0]);
const numbers: Record<string, number> = { span_length: 40, pylon_gap: 50, track_y: 14 };
const row = {
  n: (k: string, f?: number) => numbers[k] ?? f ?? 0,
  v: () => undefined,
} as unknown as Row;
const line: RailLine = {
  name: 'loop',
  rank: 0,
  row,
  path,
  along: path.map((_, i) => i * 10),
  height: path.map(() => 14),
  straight: path.map(() => true),
  length: 400,
};
const layout = {
  rail: {
    lines: [line],
    stops: [{ name: 's', line: 'loop', row, along: 50, position: [50, 0], heading: 0 }],
  },
} as unknown as CityLayout;

const n = (v: Value | undefined): number =>
  v?.k === 'num' ? Math.round(v.v * 1000) / 1000 + 0 : NaN;

describe('the monorail', () => {
  const world = readScripts(['e.flecs'], () => '').world;
  const out = railInstances(layout, world);

  it('A LINE IS BEAMS OF ITS SPAN LENGTH, EACH SPANNING THE SAMPLES, STRAIGHT WHERE THE LINE IS AND BENT AT A CORNER', () => {
    const beams = out.filter((i) => i.name === 'MonoBeam');
    /* 400 m in 40 m beams, four 10 m spans each. */
    expect(beams).toHaveLength(10);
    expect([n(beams[0]?.props.get('s0')), n(beams[0]?.props.get('s1'))]).toEqual([0, 40]);
    const spans = beams[0]?.props.get('spans');
    const span = (k: number, f: string): number => {
      const v = spans?.k === 'vector' ? spans.items[k] : undefined;
      return n(v?.k === 'struct' ? v.fields?.get(f) : undefined);
    };
    expect(spans?.k === 'vector' ? spans.items.length : 0).toBe(4);
    /* Mid-edge the tangent is the samples either side over two: 10 m along x, at the track's 14 m. */
    expect([span(1, 'p0x'), span(1, 'p0y'), span(1, 't0x'), span(1, 't0z')]).toEqual([
      10, 14, 10, 0,
    ]);
    /* The third beam covers 80..120 m, samples 8 to 12: its second span ends at the corner
       (100, 0), where the tangent turns halfway — (5, 0, 5). */
    const corner = beams[2]?.props.get('spans');
    const last = corner?.k === 'vector' ? corner.items[1] : undefined;
    const f = (k: string): number => n(last?.k === 'struct' ? last.fields?.get(k) : undefined);
    expect([f('p1x'), f('p1z'), f('t1x'), f('t1z')]).toEqual([100, 0, 5, 5]);
  });

  it('A PYLON STANDS BESIDE THE TRACK AND REACHES BACK OVER IT; A STATION STANDS ON IT, TURNED ALONG IT', () => {
    const pylon = out.find((i) => i.name === 'MonoPylon');
    /* 25 m along the first edge, heading +x: right of that — up × tangent — is −z, 8 m of reach. */
    expect(pylon?.position.map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([25, -8]);
    /* Its local +x turned onto +z: from the column back to the track. */
    const yaw = pylon?.yaw ?? 0;
    expect([Math.cos(yaw), -Math.sin(yaw)].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([
      0, 1,
    ]);
    const station = out.find((i) => i.name === 'MonoStation');
    /* Heading 0 runs the platform along +x; the station draws its track along its own +z. */
    const s = station?.yaw ?? 0;
    expect([Math.sin(s), Math.cos(s)].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([1, 0]);
  });
});
