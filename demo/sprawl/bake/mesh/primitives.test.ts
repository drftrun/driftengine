import { solidVolume } from '@driftengine/core';
import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { ScriptWorld } from '../script/world.ts';
import { flatten, identity } from './flatten.ts';
import type { Part } from './flatten.ts';
import { placement } from './instantiate.ts';
import { SolidCache, axisBox } from './primitives.ts';

/* An eight-sided cylinder of radius 0.5 is an inscribed octagon: 8/2 · 0.5² · sin(π/4). */
const OCTAGON = 2 * 0.25 * Math.SQRT1_2 * 2;

const SCRIPT = [
  'cuts { Csg: {op: CsgUnion}',
  '  slab { Box: {4, 2, 2} }',
  '  slot { Box: {1, 1, 3}',
  '    Position3: {-1, 0, 0}',
  '    CsgOperator: {op: CsgDifference} }',
  '  bore { Cylinder: {segments: 8, smooth: false, length: 3}',
  '    Position3: {1, 0, 0}',
  '    Rotation3: {1.5707963267948966, 0, 0}',
  '    CsgOperator: {op: CsgDifference} }',
  '}',
  'mixed { Csg: {op: CsgUnion}',
  '  cube { Box: {2, 2, 2} }',
  '  post { Cylinder: {segments: 8, smooth: false, length: 2}',
  '    Position3: {3, 0, 0} }',
  '  top { Box: {10, 0.5, 10}',
  '    Position3: {0, 1, 0}',
  '    CsgOperator: {op: CsgDifference} }',
  '}',
  'refill { Csg: {op: CsgUnion}',
  '  cube { Box: {2, 2, 2} }',
  '  bore { Cylinder: {segments: 8, smooth: false, length: 3}',
  '    CsgOperator: {op: CsgDifference} }',
  '  plug { Box: {0.2, 0.2, 0.2} }',
  '}',
  'pair { Csg: {op: CsgUnion}',
  '  a { Box: {1, 1, 1} }',
  '  b { Box: {1, 1, 1}',
  '    Position3: {0.5, 0, 0} }',
  '}',
  'twin { Csg: {op: CsgUnion}',
  '  Position3: {50, 0, 0}',
  '  a { Box: {1, 1, 1} }',
  '  b { Box: {1, 1, 1}',
  '    Position3: {0.5, 0, 0} }',
  '}',
  'long { Box: {2, 1, 4} }',
].join('\n');

const read = readScripts(['p.flecs'], (f) => (f === 'p.flecs' ? SCRIPT : null));

function group(name: string): Part {
  const e = ScriptWorld.walk(read.world.root, [name]);
  const part = e === null ? undefined : flatten(e, identity()).parts[0];
  if (part === undefined) throw new Error(`no group ${name}`);
  return part;
}

function volume(cache: SolidCache, name: string): number {
  const solid = cache.solid(group(name));
  return solid === null ? NaN : solidVolume(solid);
}

describe('primitives and their groups', () => {
  it('A BOX UNDER A QUARTER TURN KEEPS ITS AXES, WITH ITS EXTENTS SWAPPED; ONE TURNED OFF THEM DOES NOT', () => {
    expect(read.errors).toEqual([]);
    const long = ScriptWorld.walk(read.world.root, ['long']);
    const at = (yaw: number): Part | undefined =>
      long === null ? undefined : flatten(long, placement(10, 0, 0, yaw)).parts[0];
    const turned = at(Math.fround(Math.PI / 2));
    /* 2 × 1 × 4 turned a quarter about y: 4 along x and 2 along z. */
    expect(turned && axisBox(turned)?.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      8, -0.5, -1, 12, 0.5, 1,
    ]);
    const skew = at(Math.PI / 6);
    expect(skew ? axisBox(skew) : undefined).toBeNull();
  });

  it('BOX CUTS AND A ROUND CUT TAKEN APART ARE EXACT IN VOLUME', () => {
    const cache = new SolidCache();
    /* 4 × 2 × 2, less a 1 × 1 slot and an octagonal bore, each through the slab's depth of 2. */
    expect(volume(cache, 'cuts')).toBeCloseTo(16 - 2 - OCTAGON * 2, 4);
    /* A cube and a post of height 2, each losing its top 0.25 to one box cut. */
    expect(volume(cache, 'mixed')).toBeCloseTo(8 + OCTAGON * 2 - 2 * 0.25 * 2 - OCTAGON * 0.25, 4);
  });

  it('a union after a cut is applied after it, not gathered with the unions before it', () => {
    /* The plug sits inside the bore (its corner at 0.14 against the octagon's apothem of 0.46), so
       taken first it would be cut away again. */
    expect(volume(new SolidCache(), 'refill')).toBeCloseTo(8 - OCTAGON * 2 + 0.008, 4);
  });

  it('A UNION GROUP IS MERGED RATHER THAN CUT, AND ONE SHAPE IS MESHED ONCE WHEREVER IT STANDS', () => {
    const cache = new SolidCache();
    const first = cache.solid(group('pair'));
    /* Two overlapping cubes, each its own twelve triangles: a boolean would make one box of twelve. */
    expect(first ? first.indices.length / 3 : NaN).toBe(24);
    expect(cache.solid(group('twin'))).toBe(first);
    expect(cache.hits).toBe(1);
  });
});
