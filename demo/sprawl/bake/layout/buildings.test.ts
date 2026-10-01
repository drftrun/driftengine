import { mulberry32 } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import type { Value } from '../script/values.ts';
import type { ScriptEntity } from '../script/world.ts';
import { placeBuildings } from './buildings.ts';
import type { Lot } from './lots.ts';
import { bounds, rect } from './plane.ts';
import type { Row } from './rows.ts';
import type { BuildingStyle, Palette } from './styleTables.ts';
import type { CityTables } from './tables.ts';

function fakeRow(values: Record<string, number>): Row {
  return {
    entity: {} as ScriptEntity,
    n(key, fallback) {
      const v = values[key];
      if (v !== undefined) return v;
      if (fallback !== undefined) return fallback;
      throw new Error(`no ${key}`);
    },
    s: (key, fallback) => fallback ?? key,
    c: () => [0, 0, 0, 0],
    v: (key): Value | undefined => {
      const v = values[key];
      return v === undefined ? undefined : { k: 'num', type: 'f32', v };
    },
  };
}

const colour: Value = { k: 'struct', fields: null, items: [] };
const palette = (name: string): Palette => ({
  name,
  weight: 1,
  lit: 1,
  variant: 0,
  wall: colour,
  trim: colour,
  window: colour,
  accent: colour,
});

const NUMBERS = {
  min_w: 1,
  max_w: 100,
  min_d: 1,
  max_d: 100,
  height_min: 10,
  height_max: 100,
  centrality: 0,
  min_floors: 2,
  max_floors: 30,
  floor_height: 3,
  ground_floor: 4,
  col_width: 4,
  inset: 1,
  lit: 1,
  dark_chance: 0,
};

function style(
  name: string,
  extra: Partial<BuildingStyle>,
  numbers: Record<string, number> = {},
): BuildingStyle {
  return {
    name,
    template: name,
    row: fakeRow({ ...NUMBERS, ...numbers }),
    district: 'A',
    weight: 1,
    polygon: false,
    palettes: [palette('one'), palette('two'), palette('three')],
    venues: [],
    rarity: null,
    ...extra,
  };
}

const tables = {
  value: (name: string) => ({ sizeStep: 0.5, skyports: 1 })[name] ?? 0,
  district: () => ({ seed: [0, 0] }),
} as unknown as CityTables;

/** Eight lots side by side along one street, 20 m wide and 30 deep. */
const lots: Lot[] = Array.from({ length: 8 }, (_, i) => {
  const outline = rect(i * 20, 0, i * 20 + 20, 30);
  return {
    id: i,
    block: 0,
    district: 'A',
    outline,
    bounds: bounds(outline),
    facing: [0, 1] as const,
    width: 20,
    depth: 30,
    corner: i === 0 || i === 7,
    polygon: false,
  };
});

describe('buildings', () => {
  it('KEEPS THE PROTOCOL: THE ROOF AT gh + floors · fh, NO PALETTE TWICE RUNNING, RARE STYLES CAPPED', () => {
    const slot = (name: string, group: number) => ({
      name,
      kind: name,
      group,
      weight: 1,
      row: fakeRow({}),
    });
    const tall = style(
      'tall',
      {
        venues: [slot('home', 0), slot('bar', 1), slot('cafe', 1)],
      },
      { skyport_rank: 1 },
    );
    /* At most two, 30 m apart: lots are 20 m wide, so each cap refuses something the other allows. */
    const rare = style('rare', { weight: 1000, rarity: { maxCount: 2, minSpacing: 30 } });
    const { buildings, vacant } = placeBuildings(lots, [tall, rare], tables, mulberry32(7));
    expect(vacant).toEqual([]);
    expect(buildings).toHaveLength(8);
    const rares = buildings.filter((b) => b.style.name === 'rare');
    expect(rares).toHaveLength(2);
    const [r0, r1] = rares.map((b) => b.position);
    expect(
      Math.hypot((r0?.[0] ?? 0) - (r1?.[0] ?? 0), (r0?.[1] ?? 0) - (r1?.[1] ?? 0)),
    ).toBeGreaterThanOrEqual(30);
    for (const b of buildings) {
      const floors = b.props.get('floors');
      const n = floors?.k === 'num' ? floors.v : -1;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(30);
      expect(b.height).toBe(4 + n * 3);
      expect([b.width, b.depth]).toEqual([18, 28]);
      expect(b.yaw).toBe(0);
      const seed = b.props.get('seed');
      expect(seed?.k === 'num' && seed.v !== 0).toBe(true);
    }
    for (let i = 1; i < buildings.length; i += 1) {
      expect(buildings[i]?.palette.name).not.toBe(buildings[i - 1]?.palette.name);
    }
    for (const b of buildings.filter((x) => x.style.name === 'tall')) {
      const names = b.venues.map((v) => v.name);
      expect(names[0]).toBe('home');
      expect(names).toHaveLength(2);
    }
  });

  it('gives the sky decks to the tallest towers whose style ranks for one', () => {
    const tall = style('tall', {}, { skyport_rank: 1 });
    const low = style('low', {}, { height_min: 200, height_max: 300, max_floors: 200 });
    const { buildings } = placeBuildings(lots, [tall, low], tables, mulberry32(3));
    const decked = buildings.filter((b) => {
      const v = b.props.get('skyport');
      return v?.k === 'num' && v.v === 1;
    });
    expect(decked).toHaveLength(1);
    const tallest = buildings
      .filter((b) => b.style.name === 'tall')
      .reduce((a, b) => (b.height > a.height ? b : a));
    expect(decked[0]).toBe(tallest);
  });
});
