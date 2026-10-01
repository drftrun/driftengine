import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { ScriptWorld } from '../script/world.ts';
import { flatten, identity, localMatrix } from './flatten.ts';
import type { Part } from './flatten.ts';

const SCRIPT = [
  'prefab Mat { Rgba: {10, 20, 30, 255}',
  '  PbrMaterial: {metallic: 0.5, roughness: 0.25} }',
  'prefab Bulb {',
  '  Sphere: {segments: 8, smooth: true, radius: 0.5}',
  '  Scale3: {2, 2, 2}',
  '  cap { Position3: {0, 1, 0}',
  '    Box: {1, 1, 1} }',
  '}',
  'thing {',
  '  Position3: {10, 0, 0}',
  '  Scale3: {2, 2, 2}',
  '  kid {',
  '    Position3: {1, 0, 0}',
  '    Box: {1, 1, 1}',
  '    (IsA, Mat)',
  '    PbrMaterial: {roughness: 0.75}',
  '  }',
  '  _ : Bulb { Position3: {0, 5, 0} }',
  '  cut {',
  '    Csg: {op: CsgDifference}',
  '    a { Box: {2, 2, 2} }',
  '    b { Sphere: {segments: 8, smooth: true, radius: 1} }',
  '  }',
  '  hidden { flecs.core.Disabled',
  '    Box: {1, 1, 1} }',
  '  glow { IcoSphere: {segments: 1, smooth: true, radius: 1}',
  '    Scale3: {0, 0, 0} }',
  '}',
].join('\n');

const num = (p: Part, component: string, key: string): number => {
  const v = p.material.components.get(component);
  const f = v?.k === 'struct' ? v.fields?.get(key) : undefined;
  return f?.k === 'num' ? f.v : NaN;
};

describe('flattening an instantiated tree', () => {
  const r = readScripts(['f.flecs'], (f) => (f === 'f.flecs' ? SCRIPT : null));
  const thing = ScriptWorld.walk(r.world.root, ['thing']);
  if (thing === null) throw new Error('no thing');
  const { parts } = flatten(thing, identity());

  it('SCALE PASSES TO CHILDREN, AND A PREFAB’S CHILDREN AND TRANSFORM COME WITH EVERY INSTANCE', () => {
    expect(r.errors).toEqual([]);
    const kid = parts.find((p) => p.entity.name === 'kid');
    /* thing at x = 10 scaled 2, kid 1 along its x: 12, and still scaled 2. */
    expect(kid ? [kid.matrix[12], kid.matrix[0]] : null).toEqual([12, 2]);
    const bulb = parts.find((p) => p.kind === 'Sphere');
    /* The instance at y = 5 in thing's frame is 10 up; the prefab's own scale makes it 4. */
    expect(bulb ? [bulb.matrix[12], bulb.matrix[13], bulb.matrix[0]] : null).toEqual([10, 10, 4]);
    const cap = parts.find((p) => p.entity.name === 'cap');
    /* The cap is 1 up in the bulb's frame, which is scaled 4: 14. */
    expect(cap ? [cap.matrix[13], cap.matrix[0]] : null).toEqual([14, 4]);
  });

  it('turns in the order X · Y · Z: a quarter about each of X and Y takes +x to +y', () => {
    const turned = readScripts(['t.flecs'], (f) =>
      f === 't.flecs' ? 'turned { Rotation3: {1.5707963267948966, 1.5707963267948966, 0} }' : null,
    );
    const e = ScriptWorld.walk(turned.world.root, ['turned']);
    const m = e ? localMatrix(e) : identity();
    /* Y first takes +x to −z; X then takes −z to +y. Another order lands elsewhere. */
    /* Rotation3 is f32, so π/2 arrives rounded and its cosine is 4e-8, not 0: to a micrometre. */
    expect([m[0], m[1], m[2]].map((v) => Math.round((v ?? 0) * 1e6) / 1e6 + 0)).toEqual([0, 1, 0]);
  });

  it('resolves a material through its base chain, the named members merged over it', () => {
    const kid = parts.find((p) => p.entity.name === 'kid') as Part;
    expect(num(kid, 'Rgba', 'g')).toBe(20);
    expect(num(kid, 'PbrMaterial', 'metallic')).toBe(0.5);
    expect(num(kid, 'PbrMaterial', 'roughness')).toBe(0.75);
  });

  it('makes a CSG group one part, its first child the base, and skips what is disabled or unseen', () => {
    const cut = parts.find((p) => p.kind === 'Csg');
    expect(cut?.csg?.op).toBe('CsgDifference');
    expect(cut?.csg?.operands.map((o) => o.part.kind)).toEqual(['Box', 'Sphere']);
    expect(parts.some((p) => p.entity.name === 'hidden' || p.entity.name === 'glow')).toBe(false);
    expect(parts.map((p) => p.kind).sort()).toEqual(['Box', 'Box', 'Csg', 'Sphere']);
  });
});

describe('placed along a line', () => {
  it('A PART ALONG A SPLINE STANDS WHERE THE LINE IS AT ITS DISTANCE, OFFSET RIGHT AND UP, TURNED WITH IT', () => {
    /* A line 14 m up running 20 m along +x, then 20 m along +z. At 30 m it is 10 m into the
       second leg, heading +z. Right is the reference's own — up × tangent, as its sweeps take it,
       and the only choice that keeps (right, up, heading) a turn rather than a mirror — so +x:
       2 m right and 0.5 m up puts the part at (22, 14.5, 10), its own +z along the line. */
    const r = readScripts(['a.flecs'], (f) =>
      f === 'a.flecs'
        ? [
            'post {',
            '  Box: {0.1, 1, 0.1}',
            '  AlongSpline: {spline: line, s: 30, offset_right: 2, offset_up: 0.5, align: true}',
            '}',
            'early {',
            '  Box: {0.1, 1, 0.1}',
            '  AlongSpline: {spline: line, s: 10, offset_right: 2, offset_up: 0.5, align: true}',
            '}',
          ].join('\n')
        : null,
    );
    const line = r.world.create('line', r.world.root);
    const point = (x: number, y: number, z: number) => ({
      k: 'struct' as const,
      fields: new Map([
        ['x', { k: 'num' as const, type: 'f32' as const, v: x }],
        ['y', { k: 'num' as const, type: 'f32' as const, v: y }],
        ['z', { k: 'num' as const, type: 'f32' as const, v: z }],
      ]),
      items: [],
    });
    line.components.set('Spline', {
      k: 'struct',
      fields: new Map([
        ['points', { k: 'vector', items: [point(0, 14, 0), point(20, 14, 0), point(20, 14, 20)] }],
      ]),
      items: [],
    });
    /* The line an instance is handed as an entity, which is how a placer hands it over. */
    for (const name of ['post', 'early']) {
      const e = ScriptWorld.walk(r.world.root, [name]);
      const along = e?.components.get('AlongSpline');
      if (e !== null && along?.k === 'struct') {
        e.components.set('AlongSpline', {
          ...along,
          fields: new Map([...(along.fields ?? []), ['spline', { k: 'entity', entity: line }]]),
        });
      }
    }
    const post = ScriptWorld.walk(r.world.root, ['post']);
    const part = post === null ? undefined : flatten(post, identity()).parts[0];
    const m = part?.matrix ?? identity();
    const round = (v: number | undefined): number => Math.round((v ?? 0) * 1e6) / 1e6 + 0;
    expect([m[12], m[13], m[14]].map(round)).toEqual([22, 14.5, 10]);
    /* Its own axes: right (+x) and the heading (+z). */
    expect([m[0], m[1], m[2], m[8], m[9], m[10]].map(round)).toEqual([1, 0, 0, 0, 0, 1]);
    /* 10 m along the first leg, heading +x: right is −z, so (10, 14.5, −2), turned a quarter. */
    const early = ScriptWorld.walk(r.world.root, ['early']);
    const e =
      (early === null ? undefined : flatten(early, identity()).parts[0])?.matrix ?? identity();
    expect([e[12], e[13], e[14]].map(round)).toEqual([10, 14.5, -2]);
    expect([e[0], e[1], e[2], e[8], e[9], e[10]].map(round)).toEqual([0, 0, -1, 1, 0, 0]);
  });
});
