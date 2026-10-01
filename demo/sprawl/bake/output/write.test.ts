import { DrftStream, readDrft } from '@driftengine/drft';
import { expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import type { Instance } from '../mesh/instances.ts';
import { bakeRegions } from '../mesh/region.ts';
import { coarseLevels } from './coarse.ts';
import { bytesUntil } from './walkable.ts';
import { writeCity } from './write.ts';

const SCRIPT = [
  'prefab Hut {',
  '  wall { Box: {4, 3, 4} }',
  '  cap { Cylinder: {segments: 6, smooth: false, length: 1}',
  '    Position3: {0, 2, 0} }',
  '}',
  'prefab Post { pole { Cylinder: {segments: 5, smooth: false, length: 4} } }',
  'prefab Dome { shell { Sphere: {segments: 8, smooth: true, radius: 2} } }',
  'prefab Slab { deck { Box: {90, 1, 4} } }',
].join('\n');

const at = (name: string, x: number, source: string): Instance => ({
  name,
  props: new Map(),
  position: [x, 0],
  y: 0,
  yaw: 0,
  source,
});

it('A DISTRICT WRITTEN ALONE CARRIES ITS OWN KIT, ITS ASSEMBLIES AND ITS FURNITURE, AND READS BACK WHOLE', () => {
  const read = readScripts(['w.flecs'], (f) => (f === 'w.flecs' ? SCRIPT : null));
  const city = bakeRegions(
    read,
    [
      at('Hut', 10, 'building'),
      at('Post', 20, 'lamp'),
      at('Hut', 150, 'building'),
      at('Dome', 250, 'building'),
    ],
    { instanced: new Set(['lamp']) },
  );
  const first = city.regions[0]?.id;
  const asset = readDrft(writeCity(city, { keep: (r) => r.id === first }));
  /* The hut's box and cap: two pieces, and nothing of the second region's. */
  expect(asset.kit).toEqual([0, 1]);
  expect(asset.regions).toHaveLength(1);
  const [region] = asset.regions;
  /* One class — both untextured and opaque — so one assembly: a box's 12 triangles, and a
     six-sided cap's six side quads and two capping fans of six, 24. */
  const level = region?.levels[0]?.meshes ?? [];
  expect(level).toHaveLength(1);
  expect((asset.meshes[level[0] as number]?.indices.length ?? 0) / 3).toBe(12 + 24);
  /* The post placed once, at x 20, from a prototype written after the district's assembly. */
  const group = region?.instances[0];
  expect(group?.mesh).toBe((level[0] as number) + 1);
  expect(group?.transforms[12]).toBe(20);
  /* The dome's district alone: its one piece, the kit's fourth, renumbered to the first. */
  const last = city.regions[city.regions.length - 1]?.id;
  const dome = readDrft(writeCity(city, { keep: (r) => r.id === last }));
  expect(dome.kit).toEqual([0]);
  const mesh = dome.meshes[dome.regions[0]?.levels[0]?.meshes[0] as number];
  expect(mesh?.positions.length).toBe(city.kit.pieces[3]?.positions.length);
});

it('A REGION WRITTEN WITH ITS COARSE LEVEL CARRIES IT, ITS OCCLUDERS, AND A CLOSED COLLISION MESH', () => {
  const read = readScripts(['w.flecs'], (f) => (f === 'w.flecs' ? SCRIPT : null));
  const city = bakeRegions(read, [at('Hut', 10, 'building'), at('Post', 20, 'lamp')], {
    instanced: new Set(['lamp']),
  });
  const coarse = coarseLevels(city, () => [1, 1, 1]);
  /* The hut's 3 m of wall is under an occluder's 4 m, so none; one given by hand goes as it is. */
  const id = city.regions[0]?.id ?? -1;
  expect(coarse.occluders.get(id)).toEqual([]);
  coarse.occluders.set(id, [0, 4, 0, 1, 8, 1]);
  const [region] = readDrft(writeCity(city, { coarse })).regions;
  expect(region?.levels.map((l) => l.error)).toEqual([0, 4]);
  expect(Array.from(region?.occluders ?? [])).toEqual([0, 4, 0, 1, 8, 1]);
  /* Collision is the coarse level's opaque geometry, welded. The hut's wall box is centred on the
     ground, so it rises 1.5 m, and its cap's sides show above it to 2.5 m in the same plain
     surface: one run of wall from the ground to 2.5 m, and the slab its top wears, 0.1 m thick
     about that. Two boxes of eight corners and twelve triangles, each closed: every edge between
     exactly two triangles. */
  const collision = region?.collision;
  expect([(collision?.positions.length ?? 0) / 3, (collision?.indices.length ?? 0) / 3]).toEqual([
    16, 24,
  ]);
  const ys = new Set(
    Array.from(collision?.positions ?? [])
      .filter((_, i) => i % 3 === 1)
      .map((y) => Math.round(y * 1000) / 1000),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual([0, 2.45, 2.5, 2.55]);
  const edges = new Map<string, number>();
  const idx = collision?.indices ?? new Uint32Array(0);
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [idx[t + e] as number, idx[t + ((e + 1) % 3)] as number];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect([...edges.values()].every((n) => n === 2)).toBe(true);
});

it('THE REGIONS COME OUT NEAREST THE SPAWN FIRST', () => {
  const read = readScripts(['w.flecs'], (f) => (f === 'w.flecs' ? SCRIPT : null));
  const city = bakeRegions(read, [
    at('Hut', 10, 'building'),
    at('Hut', 150, 'building'),
    at('Dome', 250, 'building'),
  ]);
  /* A region's box is what it holds: from x 230 the dome's, about 250, is nearest, then the hut's
     at 150, then the hut's at 10. */
  const ids = city.regions.map((r) => r.id);
  const order = readDrft(writeCity(city, { first: [230, 50] })).regions.map((r) => r.id);
  expect(order).toEqual([ids[2], ids[1], ids[0]]);
  /* Without a spawn, the bake's own order. */
  expect(readDrft(writeCity(city)).regions.map((r) => r.id)).toEqual(ids);
  /* A box is as near as its nearest side: a slab from x 5 to 95 is 15 m from x 110, nearer than
     the hut at 150, though its middle is further. */
  const wide = bakeRegions(read, [at('Slab', 50, 'building'), at('Hut', 150, 'building')]);
  const [slab, hut] = wide.regions.map((r) => r.id);
  expect(readDrft(writeCity(wide, { first: [110, 0] })).regions.map((r) => r.id)).toEqual([
    slab,
    hut,
  ]);
});

it('THE FIRST WALKABLE BYTES HOLD THE REGIONS NEAR THE SPAWN WHOLE, AND NOT THE ONES PAST THEM', () => {
  const read = readScripts(['w.flecs'], (f) => (f === 'w.flecs' ? SCRIPT : null));
  const city = bakeRegions(read, [at('Hut', 10, 'building'), at('Dome', 250, 'building')]);
  const [near, far] = city.regions.map((r) => r.id) as [number, number];
  const buffer = writeCity(city, { first: [0, 0] });
  const until = bytesUntil(buffer, new Set([near]), 1);
  expect(until).toBeLessThan(buffer.byteLength);
  /* Read exactly that far: the near region and its assembly are in, the far one's is not. */
  const seen = new Set<number>();
  const pieces = new Set<number>();
  const regions: number[] = [];
  const stream = new DrftStream({
    onRegion: (r) => regions.push(r.id),
    onAssembly: (_, ordinal) => seen.add(ordinal),
    onPiece: (_, ordinal) => pieces.add(ordinal),
  });
  stream.push(new Uint8Array(buffer, 0, until));
  const whole = readDrft(buffer).regions;
  const meshOf = (id: number): number => whole.find((r) => r.id === id)?.levels[0]?.meshes[0] ?? -1;
  expect(seen.has(meshOf(near))).toBe(true);
  expect(seen.has(meshOf(far))).toBe(false);
  expect(regions).not.toContain(far);
  /* Nor has the far region's piece — the dome travels with its region, not ahead of the city. */
  expect([...pieces].sort()).toEqual([0, 1]);
  expect(readDrft(buffer).kit).toEqual([0, 1, 3]);
  /* One byte fewer, and the near region is not whole. */
  const short = new Set<number>();
  const cut = new DrftStream({ onAssembly: (_, ordinal) => short.add(ordinal) });
  cut.push(new Uint8Array(buffer, 0, until - 1));
  expect(short.has(meshOf(near))).toBe(false);
});
