import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { readCityTables } from './tables.ts';

const SCRIPT = [
  'cfg {',
  '  export const cityScale: f32 = 0.5',
  '  export const lotWidthDowntown: f32 = 47',
  '  export const lotDepthDowntown: f32 = 55',
  '  export const lotWidthMarket: f32 = 16',
  '  export const lotDepthMarket: f32 = 23',
  '}',
  'city_districts {',
  '  @name The Middle',
  '  downtown { DistrictDef: {kind: DistrictDowntown, seed_x: 0, seed_z: 0, share: 0.5,',
  '    spacing: 122.5, accent: {96, 200, 255, 255}} }',
  '  market { DistrictDef: {kind: DistrictMarket, seed_x: -500, seed_z: 325, share: 0.5,',
  '    spacing: 70, accent: {255, 72, 168, 255}} }',
  '}',
  'city_sectors {',
  '  s0 { CitySector: {x0: -350, z0: -350, x1: 0, z1: 0, spacing: 122.5, home: DistrictDowntown} }',
  '}',
  'city_avenues { vc { CityAvenue: {vertical: true, pos: 0, wide: true} } }',
  'road_classes {',
  '  avenue { RoadStyle: {cls: RoadAvenue, lanes: 3, lane_w: 3.5, median: 2.5, sidewalk: 5,',
  '    speed: 16, light_gap: 40, tile: 24} }',
  '}',
  'block_styles {',
  '  green { BlockStyle: {kind: BlockPark, district: DistrictDowntown, chance: 0.09, min_size: 40}',
  '    (BuildsWith, Park) }',
  '}',
  'highway_route { Spline: {points: [{-2160, 14, -1150}, {0, 14, -1150}], kind: CatmullRom} }',
  'diagonal_route { Spline: {points: [{-700, 0, 700}, {-1960, 0, 1560}], kind: Linear} }',
].join('\n');

describe('the city tables', () => {
  it('reads districts in enum order, with both of the host’s names for each', () => {
    const r = readScripts(['a.flecs'], (f) => (f === 'a.flecs' ? SCRIPT : null));
    expect(r.errors).toEqual([]);
    const t = readCityTables(r.world);
    expect(t.districts.map((d) => [d.kind, d.index, d.suffix, d.short])).toEqual([
      ['DistrictDowntown', 0, 'Downtown', 'Core'],
      ['DistrictMarket', 1, 'Market', 'Row'],
    ]);
    const core = t.district('DistrictDowntown');
    expect(core).toMatchObject({ label: 'The Middle', spacing: 122.5, lotWidth: 47, lotDepth: 55 });
    expect(core.accent).toEqual([96, 200, 255, 255]);
    expect(t.sectors).toEqual([
      { x0: -350, z0: -350, x1: 0, z1: 0, spacing: 122.5, district: 'DistrictDowntown' },
    ]);
    expect(t.avenues).toEqual([{ vertical: true, pos: 0, wide: true }]);
  });

  it('sums a road class across its lanes, median and sidewalks, and scales the routes', () => {
    const r = readScripts(['a.flecs'], (f) => (f === 'a.flecs' ? SCRIPT : null));
    const t = readCityTables(r.world);
    /* 2 × 3 lanes × 3.5 + 2.5 + 2 × 5: the avenue total the notes derived from the swept profiles. */
    expect(t.roads.get('RoadAvenue')?.width).toBe(33.5);
    expect(t.grounds).toMatchObject([
      { kind: 'BlockPark', district: 'DistrictDowntown', minSize: 40, template: 'Park' },
    ]);
    expect(t.highway).toEqual({
      points: [
        [-1080, 14, -575],
        [0, 14, -575],
      ],
      curved: true,
    });
    expect(t.diagonal.points).toEqual([
      [-350, 0, 350],
      [-980, 0, 780],
    ]);
    expect(t.diagonal.curved).toBe(false);
  });
});
