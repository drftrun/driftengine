import { expandAssembly } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';
import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import type { Instance } from './instances.ts';
import { bakeRegions } from './region.ts';

const SCRIPT = [
  'prefab tile_tex { Texture: {"etc/assets/tile.svg", 256, 256} }',
  'prefab Hut {',
  '  wall { Box: {4, 3, 4} }',
  '  roof { Box: {5, 0.5, 5}',
  '    Position3: {0, 1.75, 0}',
  '    PbrTextures: {albedo: tile_tex} }',
  '}',
  'prefab Post {',
  '  pole { Cylinder: {segments: 6, smooth: false, length: 4} }',
  '  glow { Sphere: {segments: 6, smooth: true, radius: 0.3}',
  '    Position3: {0, 2.2, 0}',
  '    NightLight: {strength: 2, light: 0, offset: 0, flicker: 0} }',
  '}',
  'prefab Grove {',
  '  oak { Tree: {species: TreePlane, height: 8, seed: 5, wind: 0.02}',
  '    Position3: {2, 0, 0} }',
  '}',
].join('\n');

const at = (name: string, x: number, z: number, source: string): Instance => ({
  name,
  props: new Map(),
  position: [x, z],
  y: 0,
  yaw: 0,
  source,
});

describe('the city cut into regions', () => {
  const read = readScripts(['r.flecs'], (f) => (f === 'r.flecs' ? SCRIPT : null));
  const city = bakeRegions(
    read,
    [
      at('Hut', 10, 20, 'building'),
      at('Post', 5, 5, 'lamp'),
      at('Post', 50, 5, 'lamp'),
      at('Hut', 150, 20, 'building'),
      at('Post', 160, 5, 'lamp'),
      at('Grove', 30, 260, 'building'),
    ],
    { size: 100, instanced: new Set(['lamp']) },
  );
  const piece = (o: number): MeshData => city.kit.pieces[o] as MeshData;

  it('A REGION IS ONE ASSEMBLY A MATERIAL CLASS, AND ITS COPIES EXPAND TO EVERY PART IT HOLDS', () => {
    expect(read.errors).toEqual([]);
    const [a, b] = city.regions;
    /* 100 m squares: the hut at x 10 and the posts at 5 and 50 in one, x 150 and 160 the next. */
    /* And the grove at z 260 two rows up, 2 × 2000 ids on. */
    expect(city.regions.map((r) => r.id - (a?.id ?? 0))).toEqual([0, 1, 4000]);
    /* The plain wall wears the blank array, the tiled roof the 256 one: two classes, two draws. */
    expect(a?.assemblies.map((x) => `${x.cls.blend}|${x.cls.texture}`)).toEqual([
      'opaque|0',
      'opaque|1',
    ]);
    /* Each a box, twelve triangles, and nothing lost or doubled in the merge. */
    expect(a?.assemblies.map((x) => expandAssembly(x.assembly, piece).indices.length / 3)).toEqual([
      12, 12,
    ]);
    expect(b?.assemblies).toHaveLength(2);
    /* The wall's box and the roof's are one unit piece; with the post's pole and glow and the
       tree's wood and leaves, five. */
    expect(city.kit.pieces.length).toBe(5);
  });

  it('WHAT REPEATS UNCHANGED IS ONE MESH PLACED BY A MATRIX A COPY, in the region it stands in', () => {
    expect(city.prototypes).toHaveLength(1);
    const [a] = city.regions;
    const translations = (r: typeof a) =>
      Array.from(r?.groups[0]?.transforms ?? []).filter((_, i) => i % 16 >= 12 && i % 16 <= 14);
    expect(translations(a)).toEqual([5, 0, 5, 50, 0, 5]);
    /* A tree is not instanced — a swaying mesh cannot be — but copied: its wood and its leaves, a
       copy each in classes that carry sway, 2 m along from its grove at (30, 260) in a region of
       its own and as tall as its 8 m. */
    const grove = city.regions[2];
    expect(grove?.groups).toEqual([]);
    expect(grove?.assemblies.map((x) => `${x.cls.blend}|${x.cls.sway}`)).toEqual([
      'cutout|true',
      'opaque|true',
    ]);
    for (const { assembly } of grove?.assemblies ?? []) {
      expect(Array.from(assembly.transforms)).toEqual([8, 0, 0, 0, 8, 0, 0, 0, 8, 32, 0, 260]);
    }
  });

  it('a region’s bounds hold its assemblies and its instanced copies', () => {
    const [a] = city.regions;
    /* The posts' poles are unit-diameter hexagons, a vertex on x: 0.5 either side in x, and
       0.5 · sin 60° = 0.433 in z — so x 4.5..50.5 and z from 4.567, to the roof's edge at 22.5;
       y from the pole's foot at −2 to the top of the glow at 2.2 + 0.3. */
    expect(Array.from(a?.bounds ?? []).map((v) => Math.round(v * 100) / 100)).toEqual([
      4.5, -2, 4.57, 50.5, 2.5, 22.5,
    ]);
  });
});

describe('light standing in the air, out of the geometry', () => {
  const AIR = [
    'prefab Lamp {',
    '  pole { Cylinder: {segments: 6, smooth: false, length: 4} }',
    '  cone { Frustum: {segments: 12, smooth: true, length: 3, radius_bottom: 1.2, radius_top: 0.2}',
    '    Position3: {0, 2, 0}',
    '    Rgba: {0, 0, 0, 26}',
    '    Additive',
    '    NightLight: {strength: 0.5, light: 0, offset: 0, flicker: 0} }',
    '}',
  ].join('\n');
  const read = readScripts(['a.flecs'], (f) => (f === 'a.flecs' ? AIR : null));
  const city = bakeRegions(
    read,
    [at('Lamp', 5, 5, 'lamp'), at('Lamp', 50, 5, 'lamp'), at('Lamp', 20, 30, 'street')],
    { size: 100, instanced: new Set(['lamp']) },
  );

  it('A LAMP’S CONE IS A VOLUME WHERE EACH COPY STANDS, AND NO PART OF ITS MESH', () => {
    expect(read.errors).toEqual([]);
    /* Each cone's top at y 3.5, a spread of 1 / 3, its apex 0.6 m above: at y 4.1. The repeating
       lamps are placed from the one flattened at the origin; the third stands as itself. */
    expect(city.volumes.map((v) => v.apex.map((x) => Math.round(x * 1e4) / 1e4))).toEqual([
      [5, 4.1, 5],
      [50, 4.1, 5],
      [20, 4.1, 30],
    ]);
    /* The pole is the only piece: the repeating lamp's mesh and the street lamp's assembly are
       both one opaque cylinder. */
    expect(city.kit.pieces).toHaveLength(1);
    expect(city.prototypes.map((p) => p.cls.blend)).toEqual(['opaque']);
    expect(city.regions[0]?.assemblies.map((a) => a.cls.blend)).toEqual(['opaque']);
  });
});
