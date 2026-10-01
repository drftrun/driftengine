/**
 * `npm run sprawl:bake`: reads the reference's scripts and reports on what they built.
 *
 * The bake grows a phase at a time: this first stage reads every layer, instantiates every
 * template with its defaults, and prints what came out with a content hash, so a change to the
 * reader that moves anything shows as a different hash. It refuses, naming the path it looked
 * for, when the source is absent, and exits non-zero on any error.
 *
 *     npm run sprawl:bake                       the source where a checkout keeps it
 *     npm run sprawl:bake -- --source <dir>     somewhere else
 *     npm run sprawl:bake -- --plot <file.png>  and a top-down picture of the layout
 *     npm run sprawl:bake -- --textures         and every picture the city wears, rasterised
 *                                               into the data folder (a browser, and the network
 *                                               once for the faces)
 *     npm run sprawl:bake -- --region x,z       and the 3 × 3 regions about (x, z) written as
 *                                               derived/region.drft, with region.json beside it
 *     npm run sprawl:bake -- --city             and the whole city written as derived/sprawl.drft,
 *                                               the regions nearest the spawn first
 *     npm run sprawl:bake -- --light-plot <f>   and the light volume's street level as a picture:
 *                                               lamps along every street, buildings black
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { mulberry32 } from '@driftengine/core';
import type { DrftAssembly } from '@driftengine/drft';

import { drawLayout } from './layout/drawLayout.ts';
import { cityInstances } from './mesh/instances.ts';
import { highwayInstances } from './mesh/highway.ts';
import { railInstances } from './mesh/rail.ts';
import { pavingInstances, roadInstances } from './mesh/roads.ts';
import { bakeRegions, regionIdAt } from './mesh/region.ts';
import { dataMaps, planByName, planData, planPictures } from './output/textures.ts';
import { coarseLevels } from './output/coarse.ts';
import { cityLife } from './output/life.ts';
import { LIGHT_UNIT, cityVolume, liteOf, plotVolume } from './output/lights.ts';
import { sceneOf, spawnOf } from './output/scene.ts';
import { bytesUntil } from './output/walkable.ts';
import { pictureMeans } from './output/means.ts';
import { encodePictures, picturesOf } from './output/pictures.ts';
import { writeCity } from './output/write.ts';
import { ensureFaces } from './textures/fonts.ts';
import { rasterize } from './textures/rasterize.ts';
import type { CellDistrict } from './layout/grid.ts';
import type { Vec2 } from './layout/plane.ts';
import { buildLayout } from './layout/layout.ts';
import { area } from './layout/plane.ts';
import { DEFAULT_SOURCE, LAYERS, missingSource, readSource, sourceFiles } from './load.ts';
import { writeWorld } from './script/digest.ts';
import { parseScript } from './script/parse.ts';
import type { Value } from './script/values.ts';
import type { ScriptEntity } from './script/world.ts';

/**
 * The two functions the reference's host registers for its scripts, answered empty until the
 * layout can answer them: a sign post asks which way the nearest places lie, and what stands at a
 * corner. Empty is a sign post with no blades, which is what it shows where nothing is near.
 */
const HOSTS = new Map<string, (args: readonly Value[]) => Value>([
  ['wayfinding.blades', () => ({ k: 'vector', items: [] })],
  ['wayfinding.info', () => ({ k: 'entity', entity: null })],
]);

const hash = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** How far from the spawn a region must be whole before the walker's first frame. */
const WALKABLE = 150;

/** The distance in plan from (x, z) to a box, min xyz then max xyz: none inside it. */
function boxDistance(bounds: ArrayLike<number>, x: number, z: number): number {
  const dx = Math.max((bounds[0] as number) - x, 0, x - (bounds[3] as number));
  const dz = Math.max((bounds[2] as number) - z, 0, z - (bounds[5] as number));
  return Math.hypot(dx, dz);
}

/** The seed the placements' own random numbers are drawn from: a block's pattern, a prop's. */
const CITY_SEED = 99;
/** The side of a region, in metres. */
const REGION = 100;

async function main(): Promise<number> {
  const flag = process.argv.indexOf('--source');
  const root = resolve(flag > 0 ? (process.argv[flag + 1] ?? '') : DEFAULT_SOURCE);
  const missing = missingSource(root);
  if (missing !== null) {
    console.error(missing);
    console.error(
      'The source is not committed: the data folder beside it says where it comes from.',
    );
    return 1;
  }

  const started = performance.now();
  const read = readSource(root, { hosts: HOSTS });
  const world = read.world;
  const readMs = performance.now() - started;

  const all = sourceFiles(root);
  const unreached = all.filter((file) => !read.files.includes(file));
  const empty = unreached.filter(
    (file) => parseScript(readFileSync(join(root, file), 'utf8'), file).statements.length === 0,
  );

  const holder = world.create('', null);
  const instancing = performance.now();
  for (const name of world.templates.keys()) {
    try {
      read.instantiate(name, new Map(), holder);
    } catch (error) {
      read.errors.push(`${name}: ${(error as Error).message}`);
    }
  }
  const instanceMs = performance.now() - instancing;
  const errors = read.errors;

  let prefabs = 0;
  const count = (e: ScriptEntity): number => {
    if (e.prefab) prefabs += 1;
    return e.children.reduce((n, c) => n + count(c), 1);
  };
  const entities = count(world.root);
  const instances = count(holder) - 1;

  console.log(`source      ${root}`);
  console.log(`layers      ${LAYERS.length}, ${read.files.length} of ${all.length} files run`);
  for (const file of unreached) {
    console.log(
      `  not run   ${file}${empty.includes(file) ? ' (no statements)' : ' (nothing includes it)'}`,
    );
  }
  console.log(
    `world       ${entities} entities, ${prefabs} prefabs, ${world.templates.size} templates`,
  );
  console.log(`read        ${readMs.toFixed(0)} ms`);
  console.log(
    `instances   ${world.templates.size} templates with their defaults: ${instances} entities, ${instanceMs.toFixed(0)} ms`,
  );
  console.log(`symbols     ${world.symbols.size} names taken as the engine's enum constants`);
  console.log(`notices     ${world.notices.length} reads of state only a running host has`);
  console.log(
    `hash        world ${hash(writeWorld(world.root))}, instances ${hash(writeWorld(holder))}`,
  );

  /* Per-cell districts, where the data folder carries a table of them beside the source. */
  const districtsFile = join(dirname(dirname(root)), 'derived', 'cell-districts.json');
  const districts: CellDistrict[] = existsSync(districtsFile)
    ? (JSON.parse(readFileSync(districtsFile, 'utf8')) as { cells: CellDistrict[] }).cells
    : [];
  const anchorsFile = join(dirname(dirname(root)), 'derived', 'landmarks.json');
  const anchors = new Map<string, Vec2>(
    existsSync(anchorsFile)
      ? Object.entries(
          (JSON.parse(readFileSync(anchorsFile, 'utf8')) as { anchors: Record<string, Vec2> })
            .anchors,
        )
      : [],
  );
  const layout = buildLayout(world, { districts, anchors });
  console.log(
    `data        ${districts.length} cell districts, ${anchors.size} landmark anchors${districts.length + anchors.size === 0 ? ' (none: the scripts alone decide)' : ''}`,
  );
  const blockArea = layout.blocks.reduce((sum, b) => sum + Math.abs(area(b.outline)), 0);
  const open = layout.blocks.filter((b) => b.ground !== null);
  const openArea = open.reduce((sum, b) => sum + Math.abs(area(b.outline)), 0);
  const kilometres = layout.roads.roads.reduce((sum, r) => sum + (r.to - r.from), 0) / 1000;
  console.log(
    `layout      ${layout.grid.cells.length} cells, ${layout.blocks.length} blocks, ${kilometres.toFixed(1)} km of grid road, ${layout.roads.junctions.length} junctions`,
  );
  console.log(
    `            ${open.length} open-ground blocks, ${((100 * openArea) / blockArea).toFixed(1)}% of block area`,
  );
  const forms = new Map<string, number>();
  for (const plan of layout.plans) forms.set(plan.form, (forms.get(plan.form) ?? 0) + 1);
  console.log(
    `            ${layout.lots.length} lots on ${layout.plans.length} building blocks (${[...forms].map(([f, n]) => `${n} ${f}`).join(', ')})`,
  );
  const tallest = [...layout.buildings].sort((a, b) => b.height - a.height)[0];
  const styles = new Set(layout.buildings.map((b) => b.style.name));
  const decks = layout.buildings.filter((b) => {
    const v = b.props.get('skyport');
    return v?.k === 'num' && v.v === 1;
  });
  console.log(
    `            ${layout.buildings.length} buildings of ${styles.size} styles on ${layout.lots.length} lots (${layout.vacant.length} vacant); tallest ${tallest?.height.toFixed(1)} m; ${decks.length} sky decks`,
  );
  console.log(
    `            ${layout.landmarks.length} landmarks (${layout.landmarks.filter((l) => l.blocks.length > 1).length} on merged blocks, ${layout.closed.size} street segments closed); wall ${layout.wall ? `${layout.wall.gates.length} gates, ${layout.wall.towers.length} towers` : 'none'}`,
  );
  const railKm = layout.rail.lines.reduce((sum, l) => sum + l.length, 0) / 1000;
  console.log(
    `            monorail ${layout.rail.lines.length} lines, ${railKm.toFixed(1)} km of track, ${layout.rail.stops.length} stops seated, ${layout.dropped.length} dropped`,
  );
  for (const d of layout.dropped) console.log(`              ${d}`);
  const lit = [...layout.lamps, ...layout.props].filter((p) => p.light).length;
  console.log(
    `            ${layout.lamps.filter((l) => !l.light).length} lamp poles, ${layout.signals.length} signal heads, ${layout.props.length} props; ${lit} point lights`,
  );
  const plotAt = process.argv.indexOf('--plot');
  if (plotAt > 0) {
    const file = resolve(process.argv[plotAt + 1] ?? 'sprawl-plot.png');
    writeFileSync(file, drawLayout(layout).png());
    console.log(`plot        ${file}`);
  }
  const regionFlag = process.argv.indexOf('--region');
  const cityFlag = process.argv.includes('--city');
  if (process.argv.includes('--textures') || regionFlag > 0 || cityFlag) {
    const meshing = performance.now();
    const instances = [
      ...cityInstances(layout, mulberry32(CITY_SEED)),
      ...roadInstances(layout, world),
      ...pavingInstances(layout),
      ...railInstances(layout, world),
      ...highwayInstances(layout, world),
    ];
    const city = bakeRegions(read, instances, {
      size: REGION,
      instanced: new Set(['lamp', 'signal']),
    });
    const copies = city.regions.reduce(
      (n, r) => n + r.assemblies.reduce((m, a) => m + a.assembly.pieces.length, 0),
      0,
    );
    console.log(
      `meshing     ${city.regions.length} regions, ${copies} copies of ${city.kit.pieces.length} pieces, ${city.prototypes.length} instanced prototypes, ${(performance.now() - meshing).toFixed(0)} ms`,
    );
    console.log(
      `            ${instances.length} instances; missing ${[...city.missing].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
    );
    const night = city.lights.filter((l) => l.night).length;
    const reach = city.lights.reduce((m, l) => Math.max(m, l.range), 0);
    console.log(
      `            ${city.lights.length} lights (${night} at night, ${city.lights.length - night} always), reaching up to ${reach} m; ${city.volumes.length} volumes of light in the air`,
    );
    console.log(
      `            texture layers ${city.plan.classes.map((c) => `${c.layers.length} at ${c.size}`).join(', ')}; unmade ${[...city.kit.unmade].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
    );
    for (const [source, { copies: n, triangles }] of [...city.cost].sort(
      (a, b) => b[1].triangles - a[1].triangles,
    )) {
      console.log(
        `              ${source.padEnd(10)} ${String(n).padStart(7)} copies ${String(triangles).padStart(9)} triangles`,
      );
    }
    const derived = join(dirname(dirname(root)), 'derived');
    const raster = await rasterize(
      planPictures(city.plan),
      root,
      join(derived, 'textures'),
      await ensureFaces(join(derived, 'fonts')),
    );
    console.log(
      `textures    ${raster.paths.size} pictures, ${raster.drawn} drawn, ${raster.cached} from the cache`,
    );
    const webp = await encodePictures(raster.paths, dataMaps(city.plan));
    let webpBytes = 0;
    for (const file of webp.files.values()) webpBytes += statSync(file).size;
    console.log(
      `            as WebP: ${webp.encoded} encoded, ${webp.cached} from the cache, ${(webpBytes / 1e6).toFixed(2)} MB`,
    );
    const coarse = coarseLevels(city, pictureMeans(raster.paths));
    const triangles = (assemblies: Iterable<{ assembly: DrftAssembly }>): number => {
      let n = 0;
      for (const { assembly } of assemblies)
        for (const p of assembly.pieces) n += (city.kit.pieces[p]?.indices.length ?? 0) / 3;
      return n;
    };
    const fine = triangles(city.regions.flatMap((r) => r.assemblies));
    const far = triangles([...coarse.levels.values()].flat());
    console.log(
      `coarse      ${city.buildings.length} buildings as boxes; ${far} triangles against ${fine} at the finest (${((100 * far) / fine).toFixed(1)}%)`,
    );
    const lighting = performance.now();
    const volume = cityVolume(city.lights, coarse.solids, city.regions);
    console.log(
      `light       ${city.lights.length} lights over ${coarse.solids.length} boxes: a volume ${volume.dims.join(' × ')} at ${volume.spacing} m, ${(performance.now() - lighting).toFixed(0)} ms`,
    );
    const lightPlot = process.argv.indexOf('--light-plot');
    if (lightPlot > 0) {
      const file = resolve(process.argv[lightPlot + 1] ?? 'sprawl-light.png');
      writeFileSync(file, plotVolume(volume, 0));
      console.log(`            street level of the volume: ${file}`);
    }
    if (cityFlag) {
      const spawn = spawnOf(world);
      const life = cityLife(read);
      const scene = sceneOf({
        city,
        coarse,
        layout,
        world,
        textures: planByName(city.plan),
        regionSize: REGION,
        lightUnit: LIGHT_UNIT,
        life,
      });
      const writing = performance.now();
      const bytes = writeCity(city, {
        coarse,
        scene,
        lights: liteOf(city.lights),
        lightVolume: volume,
        pictures: picturesOf(planPictures(city.plan), webp.files),
        first: [spawn.x, spawn.z],
        movers: life.kinds,
      });
      const file = join(derived, 'sprawl.drft');
      writeFileSync(file, new Uint8Array(bytes));
      const near = new Set(
        city.regions
          .filter((r) => boxDistance(r.bounds, spawn.x, spawn.z) <= WALKABLE)
          .map((r) => r.id),
      );
      const first = bytesUntil(bytes, near);
      console.log(
        `city        derived/sprawl.drft, ${(bytes.byteLength / 1e6).toFixed(2)} MB, written in ${(performance.now() - writing).toFixed(0)} ms; hash ${hash(new Uint8Array(bytes))}`,
      );
      console.log(
        `            first walkable: the ${near.size} regions within ${WALKABLE} m of the spawn at (${spawn.x}, ${spawn.z}) are whole after ${(first / 1e6).toFixed(2)} MB`,
      );
    }
    if (regionFlag > 0) {
      const [x, z] = (process.argv[regionFlag + 1] ?? '0,0').split(',').map(Number) as [
        number,
        number,
      ];
      const wanted = new Set<number>();
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++)
          wanted.add(regionIdAt(x + dx * REGION, z + dz * REGION, REGION));
      }
      const textures = planData(city.plan, raster.paths, derived);
      const scene = sceneOf({
        city,
        coarse,
        layout,
        world,
        textures,
        regionSize: REGION,
        lightUnit: LIGHT_UNIT,
        keep: (id) => wanted.has(id),
      });
      const bytes = writeCity(city, { keep: (r) => wanted.has(r.id), coarse, scene });
      console.log(
        `            scene: ${scene.entities.length} entities, ${(JSON.stringify(scene).length / 1e3).toFixed(0)} kB`,
      );
      writeFileSync(join(derived, 'region.drft'), new Uint8Array(bytes));
      /* Which class each region's meshes are, in the order the container lists them. */
      const regions = city.regions
        .filter((r) => wanted.has(r.id))
        .map((r) => ({
          id: r.id,
          levels: [
            r.assemblies.map((a) => a.cls),
            (coarse.levels.get(r.id) ?? []).map((a) => a.cls),
          ],
          groups: r.groups.map((g) => city.prototypes[g.prototype]?.cls),
        }));
      writeFileSync(
        join(derived, 'region.json'),
        JSON.stringify({ ...planData(city.plan, raster.paths, derived), regions }),
      );
      console.log(
        `region      ${wanted.size} regions about (${x}, ${z}): derived/region.drft, ${(bytes.byteLength / 1e6).toFixed(2)} MB`,
      );
    }
  }
  if (errors.length > 0) {
    console.error(`errors      ${errors.length}`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  console.log('errors      none');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
