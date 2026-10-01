/**
 * `npm run district:bake`: the district's `.blend` baked into a streamed container.
 *
 *     npm run district:bake                          the whole source, at models/district/
 *     npm run district:bake -- --source <file>       somewhere else
 *     npm run district:bake -- --area x0,z0,x1,z1    only what stands in that box, metres, Y up
 *     npm run district:bake -- --core x0,z0,x1,z1    the box baked whole; outside it, skyline
 *     npm run district:bake -- --out <dir>           where to write (demo/dev/public/district)
 *
 * Writes `district.drft` and `district.json` into the output folder, which is not committed, and
 * caches every picture it writes under `~/.cache/district-bake` so a second bake is minutes faster.
 * Prints what it read, what it kept and what it wrote, and exits non-zero on any refusal.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DENSE_MAX_AXIS, bakeDenseField } from '@driftengine/core';
import type { DrftLight, DrftLightVolume, MeshData } from '@driftengine/drft';

import { judged, kindOfLight } from '../lighting.ts';
import { buildPiece } from './kit.ts';
import { fixtureLights } from './lights.ts';
import { transformed } from './merge.ts';
import { splitPanes } from './panes.ts';
import type { KitPiece } from './kit.ts';
import { Materials, isLampGlass } from './materials.ts';
import { LEVELS, SKYLINE, buildRegions } from './regions.ts';
import { Sampler } from './sample.ts';
import { readScene } from './scene.ts';
import type { Placement } from './scene.ts';
import { DEFAULT_SOURCE, openSource } from './source.ts';
import { Pictures } from './textures.ts';
import { isWater, waterBodies } from './water.ts';
import { writeDistrict } from './write.ts';

const REGION = 128;
/** The lights' intensities are in the city scene's own unit, which its lamps were judged in. */
const LIGHT_UNIT = 1;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const log = (line: string): void => console.log(line);

/**
 * The volume's first layer under the lowest ground — the riverbanks run down to the water — and its
 * last past the tallest roofs. A surface outside the volume reads no light from it at all, so a
 * first layer at a walker's waist left every street below it lit by nothing but the sky.
 */
const VOLUME_BOTTOM = -5;
const VOLUME_TOP = 128;
/** What a lamp's bulb is, for how soft the volume's light arrives. */
const BULB_RADIUS = 0.2;

/**
 * Every light, as the night judges it, summed into one volume past the exact ones the runtime picks
 * near the eye, so a street three blocks away is lit by its own lamps. Inverse-square, as the
 * renderer shades the exact ones, or the two disagree where they hand over. Not yet occluded by the
 * buildings: what that costs is light through a wall a block away, softened by the volume's spacing.
 */
function districtVolume(
  lights: readonly DrftLight[],
  regions: readonly { readonly bounds: ArrayLike<number> }[],
): DrftLightVolume {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { bounds } of regions) {
    x0 = Math.min(x0, bounds[0] as number);
    z0 = Math.min(z0, bounds[2] as number);
    x1 = Math.max(x1, bounds[3] as number);
    z1 = Math.max(z1, bounds[5] as number);
  }
  const spacing = Math.ceil((Math.max(x1 - x0, z1 - z0) / (DENSE_MAX_AXIS - 1)) * 4) / 4;
  const field = lights.map((l) => {
    const i = judged(kindOfLight(l.name), l.intensity);
    return {
      x: l.position[0],
      y: l.position[1],
      z: l.position[2],
      radius: l.range,
      r: l.color[0] * i,
      g: l.color[1] * i,
      b: l.color[2] * i,
      sourceRadius: BULB_RADIUS,
    };
  });
  return bakeDenseField(
    field,
    'inverseSquare',
    null,
    [x0, VOLUME_BOTTOM, z0, x1, VOLUME_TOP, z1],
    spacing,
  );
}

/** A mesh's surface in square units. */
function surfaceArea(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let sum = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [
      (idx[t] as number) * 3,
      (idx[t + 1] as number) * 3,
      (idx[t + 2] as number) * 3,
    ];
    const u = [
      (p[b] as number) - (p[a] as number),
      (p[b + 1] as number) - (p[a + 1] as number),
      (p[b + 2] as number) - (p[a + 2] as number),
    ];
    const v = [
      (p[c] as number) - (p[a] as number),
      (p[c + 1] as number) - (p[a + 1] as number),
      (p[c + 2] as number) - (p[a + 2] as number),
    ];
    sum +=
      Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ) / 2;
  }
  return sum;
}

/** The determinant of a matrix's 3×3: how much it scales volume, negative for a mirror. */
function determinant(m: readonly number[]): number {
  const g = (i: number): number => m[i] as number;
  return (
    g(0) * (g(5) * g(10) - g(9) * g(6)) -
    g(4) * (g(1) * g(10) - g(9) * g(2)) +
    g(8) * (g(1) * g(6) - g(5) * g(2))
  );
}
const seconds = (since: number): string => `${((performance.now() - since) / 1000).toFixed(1)} s`;

async function main(): Promise<number> {
  const started = performance.now();
  const source = resolve(flag('--source') ?? DEFAULT_SOURCE);
  const out = resolve(flag('--out') ?? 'demo/dev/public/district');
  const area = flag('--area')?.split(',').map(Number);
  /*
   * The district walked, about a kilometre square round the source's own street views: baked whole,
   * with its props, its collision and its lights. Past it the city is skyline (`regions.ts`).
   */
  const box = (flag('--core') ?? '-460,-380,560,620').split(',').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const core = (x: number, z: number): boolean =>
    x >= box[0] && z >= box[1] && x <= box[2] && z <= box[3];
  const blend = openSource(source, log);

  const scene = readScene(blend);
  if (scene.refusals.length > 0) {
    for (const r of scene.refusals.slice(0, 20)) console.error(`refused: ${r}`);
    return 1;
  }
  /*
   * The area is judged where things are, not where their origins are: a static's triangles by
   * their centres and a copy by its box's, in `buildRegions`. Here only what certainly lies outside
   * is dropped — a copy whose origin is far outside — to keep the kit to what the area could use.
   */
  const keep =
    area === undefined
      ? undefined
      : (x: number, z: number): boolean =>
          x >= (area[0] as number) &&
          z >= (area[1] as number) &&
          x <= (area[2] as number) &&
          z <= (area[3] as number);
  /** How far a point is outside the area, metres; zero inside it. */
  const outside = (x: number, z: number): number =>
    area === undefined
      ? 0
      : Math.hypot(
          Math.max(0, (area[0] as number) - x, x - (area[2] as number)),
          Math.max(0, (area[1] as number) - z, z - (area[3] as number)),
        );
  const near = (p: Placement): boolean =>
    outside(p.world[12] as number, p.world[14] as number) < 400;
  const statics = scene.statics;
  const copies = new Map<string, Placement[]>();
  for (const [key, list] of scene.copies) {
    const kept = list.filter(near);
    if (kept.length > 0) copies.set(key, kept);
  }
  log(
    `scene: ${statics.length} statics, ${copies.size} prototypes with ${[...copies.values()].reduce((n, l) => n + l.length, 0)} copies, ${scene.movers.length} movers, ${scene.lights.length} lights, ${scene.views.length} views`,
  );

  /* Every piece once: a static is its own piece, a prototype one piece for all its copies. */
  const building = performance.now();
  const pieces = new Map<string, KitPiece>();
  const keys = new Set([...statics.map((p) => p.key), ...copies.keys()]);
  let source0 = 0;
  let kept0 = 0;
  for (const key of keys) {
    const object = scene.sample.get(key);
    if (object === undefined) continue;
    const piece = buildPiece(blend, key, object);
    if (piece === null) continue;
    pieces.set(key, piece);
    source0 += piece.sourceTriangles;
    kept0 += piece.triangles;
  }
  /* A lamp whose panes are faces of its iron gives them up to the glass its picture keeps there. */
  log(`panes: ${splitPanes(pieces, isLampGlass)} parts gave up their glass`);
  log(
    `kit: ${pieces.size} pieces, ${(source0 / 1e6).toFixed(2)} M triangles simplified to ${(kept0 / 1e6).toFixed(2)} M, ${seconds(building)}`,
  );

  const pictures = new Pictures(join(homedir(), '.cache', 'district-bake'));
  const materials = new Materials(pictures, blend.header.version);
  const painting = performance.now();
  /*
   * Every copy wears its own slots' materials on the piece's geometry: the row is the slot's
   * material's, whichever copy the piece was converted from. Each row is told how much of the
   * city wears it, which is what sizes its pictures.
   */
  const partArea = new Map<string, number>();
  const areaOf = (key: string, part: number, mesh: MeshData): number => {
    const id = `${key}#${part}`;
    let known = partArea.get(id);
    if (known === undefined) partArea.set(id, (known = surfaceArea(mesh)));
    return known;
  };
  const rowOf = new Map<string, number>();
  const wear = (placement: Placement): void => {
    const piece = pieces.get(placement.key);
    if (piece === undefined) return;
    const scale = Math.cbrt(Math.abs(determinant(placement.world)));
    for (let i = 0; i < piece.parts.length; i++) {
      const part = piece.parts[i] as KitPiece['parts'][number];
      const slot = piece.slotOf[i] ?? -1;
      const material =
        part.wears !== undefined ? part.wears : slot < 0 ? null : (placement.slots[slot] ?? null);
      const row = materials.of(part, material);
      rowOf.set(`${placement.name}#${i}`, row);
      materials.wear(row, areaOf(placement.key, i, part.mesh) * scale * scale);
    }
  };
  for (const p of statics) wear(p);
  for (const list of copies.values()) for (const p of list) wear(p);
  await materials.write(log);
  log(
    `materials: ${materials.rows.length} rows, ${pictures.written.length} pictures, ${(pictures.written.reduce((n, t) => n + t.bytes.length, 0) / 1e6).toFixed(1)} MB, ${seconds(painting)}`,
  );

  /*
   * The water is not drawn as the source drew it: its sheets become bodies of the engine's water
   * at run time, so they leave the regions here and are neither drawn nor stood on.
   */
  const waterRows = new Set(materials.rows.filter((r) => isWater(r.name)).map((r) => r.id));
  const sheets: MeshData[] = [];
  let waterColor: [number, number, number] = [0.02, 0.04, 0.05];
  const collect = (placement: Placement): void => {
    const piece = pieces.get(placement.key);
    if (piece === undefined) return;
    for (let i = 0; i < piece.parts.length; i++) {
      const row = rowOf.get(`${placement.name}#${i}`);
      if (row === undefined || !waterRows.has(row)) continue;
      sheets.push(transformed((piece.parts[i] as KitPiece['parts'][number]).mesh, placement.world));
      const c = materials.rows[row]?.drft.color;
      if (c !== undefined) waterColor = [c[0], c[1], c[2]];
    }
  };
  for (const p of statics) collect(p);
  for (const list of copies.values()) for (const p of list) collect(p);
  const water = waterBodies(sheets, waterColor, keep);
  log(
    water === null
      ? 'water: none'
      : `water: ${water.bodies.length} bodies at ${water.level.toFixed(2)} m, from ${sheets.length} sheets of ${[...waterRows].map((r) => materials.rows[r]?.name).join(', ')}`,
  );

  const coarseRow = materials.coarse();
  const sampler = new Sampler(pictures, blend.header.version);
  const cutting = performance.now();
  const regions = await buildRegions({
    statics,
    copies,
    pieces,
    materialOf: (placement, part) => rowOf.get(`${placement.name}#${part}`) ?? 0,
    skip: (row) => waterRows.has(row),
    sourceOf: (row) => materials.sources[row] ?? null,
    sampler,
    size: REGION,
    ...(keep === undefined ? {} : { keep }),
    core,
    log,
  });
  log(`regions cut in ${seconds(cutting)}`);
  log(
    `regions: ${regions.length}, ${(regions.reduce((n, r) => n + r.triangles, 0) / 1e6).toFixed(1)} M triangles at the finest, copies counted`,
  );

  log('lights:');
  const lights = await fixtureLights(
    {
      scene,
      statics,
      copies,
      pieces,
      rowOf,
      materials,
      sampler,
      keep: (x, z) => core(x, z) && (keep === undefined || keep(x, z)),
    },
    log,
  );
  const lighting = performance.now();
  const lightVolume = districtVolume(
    lights,
    regions.filter((r) => !r.skyline),
  );
  log(`lights: ${lights.length}, summed into a volume in ${seconds(lighting)}`);

  const views = scene.views;
  const start =
    views.find((v) => v.name === 'view_plaza') ?? views.find((v) => v.position[1] < 4) ?? views[0];
  const spawn =
    start === undefined
      ? { x: 0, y: 0, z: 0, yaw: 0 }
      : {
          x: start.position[0],
          y: start.position[1] - 1.7,
          z: start.position[2],
          yaw: Math.atan2(start.forward[0], start.forward[2]),
        };

  const { container, scene: file } = writeDistrict({
    regions,
    pieces,
    materials: materials.rows,
    textures: pictures.written,
    lights,
    lightVolume,
    spawn,
    views,
    regionSize: REGION,
    lightUnit: LIGHT_UNIT,
    coarseRow,
    levelErrors: LEVELS,
    skylineErrors: SKYLINE,
    water,
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'district.drft'), new Uint8Array(container));
  writeFileSync(join(out, 'district.json'), JSON.stringify(file));
  log(
    `wrote ${join(out, 'district.drft')} (${(container.byteLength / 1e6).toFixed(1)} MB) and district.json, ${seconds(started)} in all`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
