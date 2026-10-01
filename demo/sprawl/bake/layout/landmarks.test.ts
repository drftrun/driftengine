import { mulberry32 } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { buildBlocks } from './blocks.ts';
import { buildGrid } from './grid.ts';
import { placeLandmarks } from './landmarks.ts';
import type { Lot } from './lots.ts';
import { buildRoads } from './roads.ts';
import type { Row } from './rows.ts';
import type { CityTables, District, RoadClass, Sector } from './tables.ts';
import { buildWall, inBelt } from './wall.ts';

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

const VALUES: Record<string, number> = { wallRing: 24, wallBeltWidth: 36, wallTowerSpacing: 120 };

/** Six districts, so the sixth — the walled one — exists; all sectors belong to `kind`. */
function tables(sectors: Sector[], seed: [number, number]): CityTables {
  const districts: District[] = ['A', 'B', 'C', 'D', 'E', 'W'].map((kind, index) => ({
    kind,
    index,
    suffix: kind,
    short: kind,
    label: null,
    seed,
    share: 0,
    spacing: 0,
    accent: [0, 0, 0, 0],
    lotWidth: 0,
    lotDepth: 0,
  }));
  const classes = [
    road('RoadAvenue', 30),
    road('RoadCore', 20),
    road('RoadOld', 10),
    road('RoadDiagonal', 10),
    road('RoadHighway', 17),
  ];
  return {
    constants: new Map(),
    districts,
    sectors,
    avenues: [],
    roads: new Map(classes.map((c) => [c.cls, c])),
    grounds: [],
    courts: [],
    alleys: [],
    highway: { points: [], curved: false },
    diagonal: { points: [], curved: false },
    ramps: [],
    value: (name) => VALUES[name] ?? 0,
    district: (kind) => districts.find((d) => d.kind === kind) as District,
  };
}

const STYLES = [
  'landmark_styles {',
  '  big { LandmarkStyle: {district: A, priority: 100, min_size: 150, max_w: 200, max_d: 200,',
  '    build_w: 0.5, build_d: 0.5, front: 0.75, setback: 5, height: 300, centrality: 1}',
  '    (LandmarkBuildsWith, Big) }',
  '  small { LandmarkStyle: {district: A, priority: 50, min_size: 50, max_w: 80, max_d: 80,',
  '    build_w: 0.5, build_d: 0.5, front: 0.5, setback: 2, height: 20, centrality: 1}',
  '    (LandmarkBuildsWith, Small) }',
  '}',
].join('\n');

function city(anchors?: Map<string, readonly [number, number]>) {
  const t = tables([{ x0: 0, z0: 0, x1: 300, z1: 100, spacing: 100, district: 'A' }], [150, 50]);
  const grid = buildGrid(t);
  const roads = buildRoads(t, grid);
  const blocks = buildBlocks(grid, roads);
  const world = readScripts(['s.flecs'], (f) => (f === 's.flecs' ? STYLES : null)).world;
  return { ...placeLandmarks(world, blocks, roads, t, mulberry32(1), anchors), blocks, roads };
}

describe('landmarks and the wall', () => {
  it('A LANDMARK TOO BIG FOR ONE BLOCK TAKES TWO AND CLOSES THE STREET BETWEEN, FRONT TO ITS WIDEST SIDE', () => {
    const { landmarks, closed, roads } = city();
    /* 150 m does not fit a 100 m cell; two merged are 200 on their longer side. */
    expect(landmarks.map((l) => [l.template, l.blocks])).toEqual([['Big', [0, 1]]]);
    expect([...closed].map((id) => roads.roads[id]).map((r) => [r?.vertical, r?.at])).toEqual([
      [true, 100],
    ]);
    const big = landmarks[0];
    const n = (key: string): number => {
      const v = big?.props.get(key);
      return v?.k === 'num' ? v.v : NaN;
    };
    /* Every side is a 20 m street, so the front turns toward the seed at (150, 50): +x. */
    expect(big?.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect([n('w'), n('d'), n('bw'), n('bd'), n('front'), n('bz')]).toEqual([
      80, 180, 40, 90, 45, 0,
    ]);
  });

  it('keeps an unanchored landmark off its neighbour’s block, and lets an anchored one stand beside it', () => {
    expect(city().landmarks.map((l) => l.template)).toEqual(['Big']);
    const anchored = city(new Map([['small', [250, 50] as const]]));
    expect(anchored.landmarks.map((l) => [l.template, l.blocks])).toEqual([
      ['Big', [0, 1]],
      ['Small', [2]],
    ]);
  });

  it('rings the walled district 24 m in, with a gate at every street and the belt cleared to 36 m', () => {
    const t = tables([{ x0: 0, z0: 0, x1: 300, z1: 300, spacing: 100, district: 'W' }], [150, 150]);
    const grid = buildGrid(t);
    const roads = buildRoads(t, grid);
    const wall = buildWall(t, buildBlocks(grid, roads), roads);
    if (wall === null) throw new Error('no wall');
    /* Old-town streets are 10 m: the blocks' outer edge is at 5 and 295, the ring at 29 and 271. */
    expect(wall.path).toEqual([
      [29, 29],
      [271, 29],
      [271, 271],
      [29, 271],
      [29, 29],
    ]);
    /* The streets at 100 and 200 cross each of the four sides. */
    expect(wall.gates).toHaveLength(8);
    /* A corner each, and one between the two gates of every side. */
    expect(wall.towers).toHaveLength(8);
    const lot = (x0: number, z0: number, x1: number, z1: number) =>
      ({ bounds: { x0, z0, x1, z1 } }) as Lot;
    expect(inBelt(lot(10, 10, 20, 20), wall)).toBe(true);
    expect(inBelt(lot(50, 50, 60, 60), wall)).toBe(false);
    /* Behind the wall but inside the belt: the walk along its inner face. */
    expect(inBelt(lot(35, 35, 40, 40), wall)).toBe(true);
  });
});
