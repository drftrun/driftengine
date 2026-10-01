import { describe, expect, it } from 'vitest';

import { assignGround, buildBlocks } from './blocks.ts';
import type { Block } from './blocks.ts';
import { buildGrid } from './grid.ts';
import { area, distanceToSegment } from './plane.ts';
import { buildRoads } from './roads.ts';
import type { Row } from './rows.ts';
import type { CityTables, District, GroundKind, RoadClass, Sector } from './tables.ts';

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

function tables(
  sectors: Sector[],
  diagonal: [number, number, number][] = [],
  grounds: GroundKind[] = [],
  share = 1,
): CityTables {
  const districts: District[] = [
    {
      kind: 'A',
      index: 0,
      suffix: 'A',
      short: 'A',
      label: null,
      seed: [0, 0],
      share: 1,
      spacing: 0,
      accent: [0, 0, 0, 0],
      lotWidth: 0,
      lotDepth: 0,
    },
  ];
  const classes = [
    road('RoadAvenue', 30),
    road('RoadCore', 20),
    road('RoadDiagonal', 10),
    road('RoadHighway', 17),
  ];
  return {
    constants: new Map(),
    districts,
    sectors,
    avenues: [],
    roads: new Map(classes.map((c) => [c.cls, c])),
    grounds,
    courts: [],
    alleys: [],
    highway: { points: [], curved: false },
    diagonal: { points: diagonal, curved: false },
    ramps: [],
    value: (name) => (name === 'openGroundShare' ? share : 0),
    district: () => districts[0] as District,
  };
}

const layout = (t: CityTables): Block[] => {
  const grid = buildGrid(t);
  return buildBlocks(grid, buildRoads(t, grid));
};

describe('blocks', () => {
  it('A BLOCK IS ITS CELL LESS HALF OF EVERY ROAD AROUND IT, AND NO PIECE REACHES INTO THE DIAGONAL', () => {
    const t = tables([{ x0: 0, z0: 0, x1: 200, z1: 100, spacing: 100, district: 'A' }]);
    const blocks = layout(t);
    /* Core streets 20 wide: 10 off every side. */
    expect(blocks.map((b) => b.bounds)).toEqual([
      { x0: 10, z0: 10, x1: 90, z1: 90 },
      { x0: 110, z0: 10, x1: 190, z1: 90 },
    ]);

    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [200, 0, 100];
    const cut = layout(
      tables([{ x0: 0, z0: 0, x1: 200, z1: 100, spacing: 100, district: 'A' }], [a, b]),
    );
    expect(cut.length).toBeGreaterThan(2);
    for (const block of cut) {
      for (const p of block.outline) {
        expect(distanceToSegment(p, [0, 0], [200, 100])).toBeGreaterThanOrEqual(5 - 1e-9);
      }
    }
    const whole = cut.reduce((sum, block) => sum + Math.abs(area(block.outline)), 0);
    expect(whole).toBeLessThan(2 * 80 * 80);
  });

  it('gives open ground only where a block meets the kind’s minimum, and stops at the share', () => {
    const park: GroundKind = {
      kind: 'BlockPark',
      district: 'A',
      chance: 1,
      minSize: 70,
      template: 'Park',
      row: {} as Row,
    };
    /* One 80 m block and one 40 m one: only the first meets a 70 m minimum. */
    const t = tables(
      [
        { x0: 0, z0: 0, x1: 100, z1: 100, spacing: 100, district: 'A' },
        { x0: 100, z0: 0, x1: 160, z1: 100, spacing: 100, district: 'A' },
      ],
      [],
      [park],
    );
    const blocks = layout(t);
    assignGround(blocks, t, () => 0);
    expect(blocks.map((b) => b.kind)).toEqual(['BlockPark', 'building']);

    const capped = tables(
      [{ x0: 0, z0: 0, x1: 300, z1: 100, spacing: 100, district: 'A' }],
      [],
      [park],
      0.4,
    );
    const three = layout(capped);
    assignGround(three, capped, () => 0);
    /* Three equal blocks under a 40% share: one fits, a second would make two thirds. */
    expect(three.filter((b) => b.kind === 'BlockPark')).toHaveLength(1);
  });
});
