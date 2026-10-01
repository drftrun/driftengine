import { describe, expect, it } from 'vitest';

import { readScripts } from './reader.ts';
import type { ScriptRead } from './reader.ts';
import type { Value } from './values.ts';
import { effective } from './world.ts';
import type { ScriptEntity } from './world.ts';

/**
 * Every generator draw below was printed by the language's own C generator (seed 7: 0.2481114565525093
 * then 0.97499872949997379; seed 24: 0.96850766447839431), and every f32 by C's `(float)` cast.
 */
const SEED_7_FIRST_F32 = 0.24811145663261414;
const SEED_7_SECOND_F32 = 0.97499871253967285;
const SEED_24_FIRST_F32 = 0.96850764751434326;

function read(
  files: Record<string, string>,
  hosts?: Map<string, (args: readonly Value[]) => Value>,
): ScriptRead {
  const r = readScripts(Object.keys(files), (f) => files[f] ?? null, hosts ? { hosts } : {});
  expect(r.errors).toEqual([]);
  return r;
}

/** A component's members as plain numbers, or a scalar. */
function plain(value: Value | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.k === 'num') return value.v;
  if (value.k === 'struct' && value.fields) {
    return Object.fromEntries([...value.fields].map(([k, v]) => [k, plain(v)]));
  }
  if (value.k === 'symbol') return value.name;
  return value.k;
}

const child = (e: ScriptEntity, name: string): ScriptEntity => {
  const found = e.named.get(name);
  if (!found) throw new Error(`no child ${name}`);
  return found;
};

describe('the script evaluator', () => {
  it('A GENERATOR DRAWS ONLY WHERE THE REFERENCE DRAWS: THE CASE AND THE BRANCH TAKEN, IN ORDER', () => {
    const r = read({
      'a.flecs': [
        'template T {',
        '  prop seed: i32 = 1',
        '  const rng: math.Rng = {seed: seed}',
        '  const a = match 0 {',
        '    0: 5',
        '    _: rng.u(10)',
        '  }',
        '  if a > 9 {',
        '    Box: {rng.f(1), 0, 0}',
        '  }',
        '  Quad: {rng.f(1), rng.f(1)}',
        '}',
      ].join('\n'),
    });
    const t = r.instantiate('T', new Map([['seed', { k: 'num', type: 'i32', v: 7 }]]));
    expect(t.components.has('Box')).toBe(false);
    expect(plain(t.components.get('Quad'))).toEqual({ x: SEED_7_FIRST_F32, y: SEED_7_SECOND_F32 });
  });

  it('gives a template its props over their defaults, and a nested instance its derived seed', () => {
    const r = read({
      'a.flecs': [
        'template Leaf {',
        '  prop seed: i32 = 1',
        '  prop h: f32 = 0',
        '  const rng: math.Rng = {seed: seed}',
        '  Box: {h, rng.f(1), 0}',
        '}',
        'template Plant {',
        '  prop seed: i32 = 1',
        '  prop n: i32 = 2',
        '  const rng: math.Rng = {seed: seed}',
        '  for i in 0..n {',
        '    _ { Leaf: {seed: seed + i * 17, h: rng.f(1)} }',
        '  }',
        '}',
      ].join('\n'),
    });
    const plant = r.instantiate('Plant', new Map([['seed', { k: 'num', type: 'i32', v: 7 }]]));
    expect(plant.children).toHaveLength(2);
    const [first, second] = plant.children as [ScriptEntity, ScriptEntity];
    expect(plain(first.components.get('Leaf'))).toMatchObject({ seed: 7, h: SEED_7_FIRST_F32 });
    expect(plain(first.components.get('Box'))).toEqual({
      x: SEED_7_FIRST_F32,
      y: SEED_7_FIRST_F32,
      z: 0,
    });
    expect(plain(second.components.get('Leaf'))).toMatchObject({ seed: 24, h: SEED_7_SECOND_F32 });
    expect(plain(second.components.get('Box'))).toEqual({
      x: SEED_7_SECOND_F32,
      y: SEED_24_FIRST_F32,
      z: 0,
    });
  });

  it('keeps inherited members under a named initialiser, and replaces them under a positional one', () => {
    const r = read({
      'a.flecs': [
        'prefab Base {',
        '  PbrMaterial: {metallic: 0.5, roughness: 0.25, absorption: 0.75}',
        '  Box: {1, 2, 3}',
        '}',
        'prefab Kid : Base {',
        '  PbrMaterial: {roughness: 0.5}',
        '}',
        'thing : Kid {',
        '  Box: {4, 5}',
        '}',
      ].join('\n'),
    });
    const kid = child(r.world.root, 'Kid');
    expect(plain(kid.components.get('PbrMaterial'))).toEqual({
      metallic: 0.5,
      roughness: 0.5,
      absorption: 0.75,
    });
    expect(plain(child(r.world.root, 'Base').components.get('PbrMaterial'))).toEqual({
      metallic: 0.5,
      roughness: 0.25,
      absorption: 0.75,
    });
    const thing = child(r.world.root, 'thing');
    expect(plain(thing.components.get('Box'))).toEqual({ x: 4, y: 5, z: 0 });
    expect(plain(effective(thing, 'PbrMaterial'))).toMatchObject({ roughness: 0.5 });
  });

  it('merges a block across files, keeps top-level consts in their file, and reads exports by path', () => {
    const r = read({
      'a.flecs':
        'const k = 2\ncfg {\n  export const size: f32 = 10 * k\n}\nexport const shared = 5\n',
      'b.flecs':
        'const k = 3\ncfg {\n  export const half: f32 = cfg.size / 2\n}\nthing { ObstacleTop: {k + shared} }\n',
    });
    const cfg = child(r.world.root, 'cfg');
    expect(plain(cfg.exports.get('size'))).toBe(20);
    expect(plain(cfg.exports.get('half'))).toBe(10);
    expect(plain(child(r.world.root, 'thing').components.get('ObstacleTop'))).toEqual({ h: 8 });
  });

  it('computes under the type it assigns to: f32 rounding at every step, u8 wrapping', () => {
    const r = read({
      'a.flecs': [
        'const w: f32 = 3',
        'const tint: Rgba = {300.7, 2, 3, 255}',
        'thing {',
        '  ObstacleTop: {w * 0.7 + 0.1}',
        '  Rgba: {tint.r, tint.g - 4, tint.b, tint.a}',
        '}',
      ].join('\n'),
    });
    const thing = child(r.world.root, 'thing');
    /* In f32 at every step this is 2.1999998092651367; in f64 rounded once, 2.200000047683716. */
    expect(plain(thing.components.get('ObstacleTop'))).toEqual({ h: 2.1999998092651367 });
    /* 300 wraps to 44 on the way into a byte; 2 - 4 is u8 arithmetic and wraps to 254. */
    expect(plain(thing.components.get('Rgba'))).toEqual({ r: 44, g: 254, b: 3, a: 255 });
  });

  it('truncates loop bounds and excludes the end, iterates vectors, and tags inside a with', () => {
    const r = read({
      'a.flecs': [
        'row {',
        '  for i in 0..2.9 { _ { } }',
        '}',
        'list {',
        '  for (i, e) in [10, 20] { _ { ObstacleTop: {e + i} } }',
        '}',
        'moving {',
        '  with Dynamic { _ { } }',
        '}',
      ].join('\n'),
    });
    expect(child(r.world.root, 'row').children).toHaveLength(2);
    expect(
      child(r.world.root, 'list').children.map((c) => plain(c.components.get('ObstacleTop'))),
    ).toEqual([{ h: 10 }, { h: 21 }]);
    expect([...(child(r.world.root, 'moving').children[0]?.tags ?? [])]).toEqual(['Dynamic']);
  });

  it('calls a host function the caller supplies, and keeps an unknown engine constant as a symbol', () => {
    const hosts = new Map([
      [
        'host.twice',
        (args: readonly Value[]): Value => ({
          k: 'num',
          type: 'f64',
          v: (args[0]?.k === 'num' ? args[0].v : 0) * 2,
        }),
      ],
    ]);
    const r = read(
      {
        'a.flecs':
          'thing {\n  ObstacleTop: {host.twice(21)}\n  District: {kind: DistrictDowntown}\n}\n',
      },
      hosts,
    );
    const thing = child(r.world.root, 'thing');
    expect(plain(thing.components.get('ObstacleTop'))).toEqual({ h: 42 });
    expect(plain(thing.components.get('District'))).toEqual({ kind: 'DistrictDowntown' });
    expect(r.world.symbols.get('DistrictDowntown')).toBe(1);
  });

  it('answers state that exists only at run time with a notice, taking the branch the running host would draw', () => {
    const r = read({
      'a.flecs': 'panel {\n  const s = State[State]\n  if s.open { shown { } }\n}\n',
    });
    expect(child(child(r.world.root, 'panel'), 'shown')).toBeDefined();
    expect(r.world.notices.length).toBeGreaterThan(0);
  });
});
