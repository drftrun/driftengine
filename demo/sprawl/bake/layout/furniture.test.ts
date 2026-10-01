import { mulberry32 } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { buildBlocks } from './blocks.ts';
import { placeLamps, placeSignals, sidewalkRuns } from './furniture.ts';
import { buildGrid } from './grid.ts';
import { placeProps } from './props.ts';
import { buildRoads } from './roads.ts';
import { readCityTables } from './tables.ts';

const road = (cls: string, fields: string): string =>
  `  ${cls.toLowerCase()} { RoadStyle: {cls: ${cls}, ${fields}} }`;

function city(avenue: boolean, props = '') {
  const script = [
    'cfg {',
    '  export const cityScale: f32 = 0.5',
    '  export const lotWidthA: f32 = 20',
    '  export const lotDepthA: f32 = 20',
    '  export const propSpacingCore: f32 = 10',
    '  export const propWallChance: f32 = 0',
    '  export const propEndMargin: f32 = 2',
    '}',
    'city_districts { a { DistrictDef: {kind: DistrictA, seed_x: 0, seed_z: 0, share: 1, spacing: 100,',
    '  accent: {1, 2, 3, 255}} } }',
    'city_sectors { s { CitySector: {x0: 0, z0: 0, x1: 200, z1: 100, spacing: 100, home: DistrictA} } }',
    avenue ? 'city_avenues { h { CityAvenue: {vertical: false, pos: 0, wide: true} } }' : '',
    'road_classes {',
    road(
      'RoadCore',
      'lanes: 2, lane_w: 3.5, median: 0, sidewalk: 5, speed: 1, light_gap: 32, tile: 1, lamp: Pole, bulb: Bulb, signal: Head, mount_median: 0, lamp_offset: 0.9, lamp_reach: 3, lamp_y: 7.9, lamp_light: 13, lamp_range: 30',
    ),
    road(
      'RoadAvenue',
      'lanes: 3, lane_w: 3.5, median: 2.5, sidewalk: 5, speed: 1, light_gap: 40, tile: 1, lamp: Mast, bulb: Bulb, signal: Head, mount_median: 1, lamp_offset: 3.4, lamp_reach: 0, lamp_y: 10, lamp_light: 16, lamp_range: 34',
    ),
    road(
      'RoadStreet',
      'lanes: 1, lane_w: 3, median: 0, sidewalk: 3, speed: 1, light_gap: 40, tile: 1',
    ),
    road(
      'RoadDiagonal',
      'lanes: 1, lane_w: 3, median: 0, sidewalk: 3, speed: 1, light_gap: 40, tile: 1',
    ),
    road(
      'RoadHighway',
      'lanes: 1, lane_w: 3, median: 0, sidewalk: 0, speed: 1, light_gap: 40, tile: 1',
    ),
    '}',
    'highway_route { Spline: {points: [], kind: Linear} }',
    'diagonal_route { Spline: {points: [], kind: Linear} }',
    props,
  ].join('\n');
  const r = readScripts(['c.flecs'], (f) => (f === 'c.flecs' ? script : null));
  expect(r.errors).toEqual([]);
  const tables = readCityTables(r.world);
  const grid = buildGrid(tables);
  const roads = buildRoads(tables, grid);
  return {
    world: r.world,
    tables,
    roads,
    blocks: buildBlocks(grid, roads),
    runs: sidewalkRuns(roads, new Set()),
  };
}

/** To the millimetre: the scripts' numbers are f32, so 7.9 arrives as 7.899999976. */
const mm = (v: number): number => Math.round(v * 1000) / 1000 + 0;

describe('street furniture', () => {
  it('STANDS LAMPS A GAP APART CLEAR OF THE JUNCTIONS, STAGGERED ACROSS THE STREET, BULBS OVER THE ROAD', () => {
    const { runs } = city(false);
    const lamps = placeLamps(
      runs.filter((r) => !r.road.vertical && r.road.at === 0 && r.road.from === 0),
    );
    /* The run clears 14 m at each end (half a 24 m street and 2): 14 to 86, three poles 32 apart. */
    const poles = lamps.filter((l) => l.light === undefined).map((l) => l.position.map(mm));
    expect(poles).toEqual([
      [18, 7.9],
      [50, 7.9],
      [82, 7.9],
      [34, -7.9],
      [66, -7.9],
    ]);
    const bulbs = lamps.filter((l) => l.light !== undefined);
    expect(bulbs.map((b) => mm(b.position[1]))).toEqual([4.9, 4.9, 4.9, -4.9, -4.9]);
    const light = bulbs[0]?.light;
    expect([light?.intensity, light?.range, mm(light?.y ?? 0)]).toEqual([13, 30, 7.9]);
  });

  it('puts a median class’s pole on the centre line with a bulb each side', () => {
    const { runs } = city(true);
    const lamps = placeLamps(
      runs.filter((r) => !r.road.vertical && r.road.at === 0 && r.road.from === 0),
    );
    /* One row of masts, not one a side: 18.75 to 81.25 clear of the avenue's junctions, 40 apart. */
    const masts = lamps.filter((l) => l.template === 'Mast');
    expect(masts).toHaveLength(2);
    expect(masts.every((l) => l.position[1] === 0)).toBe(true);
    expect([...new Set(lamps.filter((l) => l.light).map((l) => mm(l.position[1])))].sort()).toEqual(
      [-3.4, 3.4],
    );
  });

  it('stands a signal on every approach to a junction, on the driver’s right, facing the traffic', () => {
    const { roads } = city(false);
    const signals = placeSignals(roads, new Set()).filter(
      (s) => Math.hypot(s.position[0] - 100, s.position[1]) < 20,
    );
    expect(signals.map((s) => [s.position.map(mm), mm(s.yaw)])).toEqual(
      expect.arrayContaining([
        [[86, 8], mm(-Math.PI / 2)],
        [[114, -8], mm(Math.PI / 2)],
        [[108, 14], 0],
      ]),
    );
    expect(signals).toHaveLength(3);
  });

  it('never stands a prop that cannot leave its walkway clear, or one its district mask excludes', () => {
    const table = [
      'prop_sets {',
      '  deep { PropDef: {context: PropCurb, districts: 0, weight: 1, w: 1, d: 8, offset: 1, clear: 1.5}',
      '    (PropUses, Deep) }',
      '  bench { PropDef: {context: PropCurb, districts: 0, weight: 1, w: 2, d: 1, offset: 1, clear: 1.5}',
      '    (PropUses, Bench) }',
      '  elsewhere { PropDef: {context: PropCurb, districts: 2, weight: 50, w: 1, d: 1, offset: 1,',
      '    clear: 1.5}',
      '    (PropUses, Elsewhere) }',
      '}',
    ].join('\n');
    const { world, tables, runs, blocks } = city(false, table);
    const props = placeProps(world, tables, runs, placeLamps(runs), blocks, [], [], mulberry32(5));
    expect(props.length).toBeGreaterThan(10);
    expect(new Set(props.map((p) => p.template))).toEqual(new Set(['Bench']));
  });
});
