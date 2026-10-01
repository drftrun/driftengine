import { describe, expect, it } from 'vitest';

import type { CityLayout } from '../layout/layout.ts';
import type { Road } from '../layout/roads.ts';
import type { Row } from '../layout/rows.ts';
import type { RoadClass } from '../layout/tables.ts';
import { readScripts } from '../script/reader.ts';
import type { Instance } from './instances.ts';
import { pavingInstances, roadInstances } from './roads.ts';

/* One lane a side of 3 m, no median, 3 m sidewalks, a picture every 6 m: 6 m kerb to kerb. */
const row = { n: () => 0, v: () => undefined } as unknown as Row;
const cls: RoadClass = {
  cls: 'RoadStreet',
  lanes: 1,
  laneWidth: 3,
  median: 0,
  sidewalk: 3,
  speed: 10,
  lightGap: 40,
  tile: 6,
  row,
  width: 12,
};
const road = (id: number, vertical: boolean, from: number, to: number): Road => ({
  id,
  vertical,
  at: 0,
  from,
  to,
  cls,
  avenue: false,
});
const layoutOf = (roads: Road[]): CityLayout =>
  ({
    roads: { roads, junctions: [{ x: 0, z: 0, roads: roads.map((r) => r.id) }] },
  }) as unknown as CityLayout;
const world = readScripts(['e.flecs'], () => '').world;

const round = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const num = (i: Instance, key: string): number => {
  const v = i.props.get(key);
  return v?.k === 'num' ? round(v.v) : NaN;
};
const summary = (i: Instance): string =>
  `${i.name} ${i.bases?.[0]} at ${round(i.position[0])},${round(i.y)},${round(i.position[1])} ` +
  `${round(i.yaw) === 0 ? 'x' : 'z'} ${num(i, 'len')}×${num(i, 'width')}`;

describe('the road surface', () => {
  it('A SEGMENT STOPS AT THE CROSSING ROAD: ITS CARRIAGEWAY PAST THE CROSSWALK, ITS SIDEWALK AT THE CORNER', () => {
    /* A cross at the origin. The north arm runs z 0..50: its carriageway starts past the crossing
       road's 3 m half and a 3.2 m crosswalk, at 6.2; its sidewalks start past that road's 3 m
       sidewalk too, at 6, and run the kerb 0.34 m and the 2.66 m walk either side of 3 m. */
    const out = roadInstances(
      layoutOf([
        road(0, true, -50, 0),
        road(1, true, 0, 50),
        road(2, false, -50, 0),
        road(3, false, 0, 50),
      ]),
      world,
    ).map(summary);
    expect(out).toContain('RoadSlab RoadStreet at 0,0,28.1 z 43.8×6');
    expect(out).toContain('KerbSlab Kerb at 3.17,0,28 z 44×0.34');
    expect(out).toContain('WalkSlab Sidewalk at -4.67,0,28 z 44×2.66');
    /* The crosswalk across the whole carriageway, 1.6 m into its band; the stop bar 1.1 m beyond
       it, on the lanes that arrive heading south — the +x side — and on top of the road. */
    expect(out).toContain('CrossSlab Crosswalk at 0,0,4.6 x 6×3.2');
    expect(out).toContain('JunctionBar JunctionPaint at 1.5,0.33,7.55 z 0.5×3');
    /* The square, and its four corners of paving. */
    expect(out).toContain('RoadSlab JunctionSurface at 0,0,0 x 6×6');
    expect(out.filter((s) => s.startsWith('WalkSlab JunctionWalk at 4.5,0,4.5'))).toHaveLength(1);
    expect(out.filter((s) => s.startsWith('WalkSlab JunctionWalk'))).toHaveLength(4);
  });

  it('a road that ends at another leaves no hole: the far sidewalk and kerb run on across its mouth', () => {
    /* No east arm: the north–south road's east sidewalk continues across z −3..3. */
    const out = roadInstances(
      layoutOf([road(0, true, -50, 0), road(1, true, 0, 50), road(2, false, -50, 0)]),
      world,
    ).map(summary);
    expect(out).toContain('WalkSlab JunctionWalk at 4.67,0,0 z 6×2.66');
    expect(out).toContain('KerbSlab JunctionKerb at 3.17,0,0 z 6×0.34');
    expect(out.filter((s) => s.includes(' at -4.67,0,0 '))).toHaveLength(0);
  });
});

describe('the blocks between the roads', () => {
  it('a block with no ground of its own is paved to its edges, at the sidewalk’s height', () => {
    const layout = {
      blocks: [
        { bounds: { x0: 10, z0: 20, x1: 50, z1: 80 }, ground: null },
        { bounds: { x0: 60, z0: 20, x1: 90, z1: 80 }, ground: { template: 'Park' } },
      ],
    } as unknown as CityLayout;
    /* 40 × 60 about (30, 50), tiled every 2 m; the park paves itself. */
    expect(pavingInstances(layout).map(summary)).toEqual(['WalkSlab Paving at 30,0,50 x 40×60']);
  });
});
