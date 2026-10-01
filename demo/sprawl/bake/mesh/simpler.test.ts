import { describe, expect, it } from 'vitest';

import type { Value } from '../script/values.ts';
import type { Part } from './flatten.ts';
import { Kit } from './kit.ts';
import type { CopyOf } from './kit.ts';
import type { Surface } from './materials.ts';
import { simpler } from './simpler.ts';

const num = (v: number): Value => ({ k: 'num', type: 'f32', v });
const spec = (fields: Record<string, number>): Value => ({
  k: 'struct',
  fields: new Map(Object.entries(fields).map(([k, v]) => [k, num(v)])),
  items: [],
});
const at = (x: number, y: number, z: number): Float64Array => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m.set([x, y, z], 12);
  return m;
};
const part = (
  kind: string,
  fields: Record<string, number>,
  matrix: Float64Array,
  csg: Part['csg'] = null,
): Part => ({ kind, spec: spec(fields), matrix, smooth: null, csg }) as unknown as Part;
const surface = {
  color: [1, 1, 1],
  alpha: 1,
  emissive: 0,
  emissiveColor: null,
  windowSeed: 0,
  roughness: 0.8,
  metallic: 0,
  textures: { albedo: null, emissive: null, mr: null },
  rooms: null,
  tiling: null,
  transform: { sx: 1, sy: 1, ox: 0, oy: 0 },
  clamp: false,
  blend: 'opaque',
  effect: undefined,
} as Surface;
const whole: CopyOf = { piece: 99, matrix: new Float32Array(12), uv: new Float32Array(8) };
const placed = (copies: CopyOf[]): number[][] =>
  copies.map((c) => Array.from(c.matrix, (v) => Math.round(v * 1000) / 1000 + 0));

describe('a copy in a coarse level', () => {
  it('A CUT PIECE STANDS AS WHAT IT WAS CUT FROM, AND A ROUNDED BOX AS ITS BOX', () => {
    const kit = new Kit();
    /* A wall 10 × 4 × 1 at (2, 1, 0) inside its group, a notch cut from it; the group turned a
       quarter about y — its x onto −z, its z onto x — and placed at (5, 2, 0). */
    const wall = part('Box', { x: 10, y: 4, z: 1 }, at(2, 1, 0));
    const notch = part('Box', { x: 1, y: 1, z: 2 }, at(4, 3, 0));
    const turned = at(5, 2, 0);
    turned.set([0, 0, -1], 0);
    turned.set([1, 0, 0], 8);
    const cut = part('Csg', {}, turned, {
      op: 'CsgDifference',
      operands: [
        { part: wall, op: 'CsgDifference' },
        { part: notch, op: 'CsgDifference' },
      ],
    });
    /* The wall's 10 m run along −z, its 1 m along x; (2, 1, 0) turned is (0, 1, −2), then placed. */
    expect(placed(simpler(kit, cut, surface, whole))).toEqual([
      [0, 0, -10, 0, 4, 0, 1, 0, 0, 5, 3, -2],
    ]);
    /* A union keeps both of its operands. */
    const joined = part('Csg', {}, at(0, 0, 0), {
      op: 'CsgUnion',
      operands: [
        { part: wall, op: 'CsgUnion' },
        { part: notch, op: 'CsgUnion' },
      ],
    });
    expect(placed(simpler(kit, joined, surface, whole))).toEqual([
      [10, 0, 0, 0, 4, 0, 0, 0, 1, 2, 1, 0],
      [1, 0, 0, 0, 1, 0, 0, 0, 2, 4, 3, 0],
    ]);
    /* What an intersection leaves is no one operand, so it stands as it is. */
    const common = part('Csg', {}, at(0, 0, 0), {
      op: 'CsgIntersection',
      operands: [
        { part: wall, op: 'CsgIntersection' },
        { part: notch, op: 'CsgIntersection' },
      ],
    });
    expect(simpler(kit, common, surface, whole)).toEqual([whole]);
    /* A rounded box 2 × 3 × 4 is the unit box stretched to it. */
    const rounded = part('RoundedBox', { x: 2, y: 3, z: 4, radius: 0.3 }, at(0, 0, 0));
    const [square] = simpler(kit, rounded, surface, whole);
    expect(placed(square === undefined ? [] : [square])).toEqual([
      [2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0],
    ]);
    expect(kit.pieces[square?.piece ?? -1]?.indices.length).toBe(36);
    /* Anything else is itself. */
    expect(simpler(kit, wall, surface, whole)).toEqual([whole]);
  });
});
