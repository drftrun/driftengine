import { describe, expect, it } from 'vitest';

import { buildGrid, divisions } from './grid.ts';
import { buildRoads } from './roads.ts';
import type { Row } from './rows.ts';
import type { CityTables, District, RoadClass, Sector } from './tables.ts';

const road = (cls: string, width: number): RoadClass => ({
  cls,
  lanes: 1,
  laneWidth: 1,
  median: 0,
  sidewalk: 0,
  speed: 1,
  lightGap: 1,
  tile: 1,
  row: {} as Row,
  width,
});

/** Tables for two districts — the enum's first (core streets) and fifth (lanes) — and `sectors`. */
function tables(sectors: Sector[], avenues: CityTables['avenues'] = []): CityTables {
  const district = (kind: string, index: number): District => ({
    kind,
    index,
    suffix: kind,
    short: kind,
    label: null,
    seed: [0, 0],
    share: 0,
    spacing: 0,
    accent: [0, 0, 0, 0],
    lotWidth: 0,
    lotDepth: 0,
  });
  const districts = [district('A', 0), district('E', 4)];
  const classes = [
    road('RoadAvenue', 33.5),
    road('RoadCore', 24),
    road('RoadLane', 13.2),
    road('RoadStreet', 20.6),
    road('RoadDiagonal', 23),
    road('RoadHighway', 17.1),
  ];
  return {
    constants: new Map(),
    districts,
    sectors,
    avenues,
    roads: new Map(classes.map((c) => [c.cls, c])),
    grounds: [],
    courts: [],
    alleys: [],
    highway: { points: [], curved: false },
    diagonal: { points: [], curved: false },
    ramps: [],
    value: () => 0,
    district: (kind) => districts.find((d) => d.kind === kind) as District,
  };
}

describe('the street grid', () => {
  it('EVERY STREET LANDS WHERE THE REFERENCE’S OWN MONORAIL WAYPOINTS SAY IT DOES', () => {
    /* The waypoints the notes found, each on a division of its sector and nowhere else. */
    expect(divisions(0, 350, 122.5)).toEqual([0, 350 / 3, 700 / 3, 350]);
    expect(divisions(350, 650, 98)).toEqual([350, 450, 550, 650]);
    expect(divisions(-650, -350, 70)).toEqual([-650, -575, -500, -425, -350]);
    expect(divisions(0, 350, 98)).toEqual([0, 87.5, 175, 262.5, 350]);
    expect(divisions(0, 350, 70)).toEqual([0, 70, 140, 210, 280, 350]);
    /* A sector half its spacing wide rounds up to one block, and a narrower one is still one. */
    expect(divisions(825, 912.5, 175)).toEqual([825, 912.5]);
    expect(divisions(0, 50, 175)).toEqual([0, 50]);
  });

  it('stops a street at a sector edge where the neighbour rounds differently: a T-junction', () => {
    const t = tables([
      { x0: 0, z0: 0, x1: 100, z1: 100, spacing: 50, district: 'A' },
      { x0: 100, z0: 0, x1: 200, z1: 100, spacing: 100, district: 'A' },
    ]);
    const grid = buildGrid(t);
    expect(grid.cells).toHaveLength(5);
    const middle = grid.lines.filter((l) => !l.vertical && l.at === 50);
    expect(middle).toEqual([{ vertical: false, at: 50, from: 0, to: 100 }]);
    const shared = grid.lines.filter((l) => l.vertical && l.at === 100);
    expect(shared).toEqual([{ vertical: true, at: 100, from: 0, to: 100 }]);
    /* The two sectors' bottom edges touch and run on as one street. */
    const bottom = grid.lines.filter((l) => !l.vertical && l.at === 0);
    expect(bottom).toEqual([{ vertical: false, at: 0, from: 0, to: 200 }]);
    const roads = buildRoads(t, grid);
    const tee = roads.junctions.find((j) => j.x === 100 && j.z === 50);
    expect(tee?.roads).toHaveLength(3);
  });

  it('gives a street between two districts the wider class, and an avenue the avenue class', () => {
    const t = tables(
      [
        { x0: 0, z0: 0, x1: 100, z1: 100, spacing: 100, district: 'E' },
        { x0: 100, z0: 0, x1: 200, z1: 100, spacing: 100, district: 'A' },
      ],
      [{ vertical: false, pos: 0, wide: true }],
    );
    const roads = buildRoads(t, buildGrid(t));
    const at = (vertical: boolean, pos: number, from: number): string | undefined =>
      roads.roads.find((r) => r.vertical === vertical && r.at === pos && r.from === from)?.cls.cls;
    expect(at(true, 0, 0)).toBe('RoadLane');
    expect(at(true, 100, 0)).toBe('RoadCore');
    expect(at(true, 200, 0)).toBe('RoadCore');
    expect(at(false, 0, 0)).toBe('RoadAvenue');
    expect(roads.width(false, 100, 0, 100)).toBe(13.2);
  });
});
