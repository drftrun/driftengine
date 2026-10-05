/**
 * A city of regions at every level of detail, streamed from a container and drawn through `HlodSet`.
 *
 *     /hlod.html                  street level, the default backend
 *     /hlod.html?backend=webgl2   the other one
 *     /hlod.html?view=high        over the roofs, where most regions are coarse
 *     /hlod.html?hlod=0           the control: every region at its finest
 *     /hlod.html?tol=8            how many pixels of error a level may show; 1.5 unless stated
 *     /hlod.html?fade=0.4         crossfade seconds; 0, the default, suits a held capture
 *     /hlod.html?fly=1            the camera travels, so crossfades can be watched
 *
 * Twelve by twelve regions of 100 m, written to a `.drft` in this page and read back through
 * `DrftLoader`, so the whole path runs: the writer's region order, the stream handing each region
 * over ahead of its meshes, the loader keeping them apart, and the selection. A region's finest
 * level is sixteen buildings with fins and cornices, 7,608 triangles; its coarser two drop the fins
 * (384 triangles, claiming 0.5 m) and then the setbacks (192, claiming 8 m). One lamp post is the
 * prototype every region places a dozen of.
 *
 * **Not `buildProxy`, and the reason is measured.** Its occupancy outline of one block is 21,280
 * triangles at 32 cells — so it refuses itself as not worth writing — and 3,352 at 16, still nine
 * times the block's own towers without their fins. A boundary of grid cells is surface area, and
 * towers are nearly all surface: a city's coarse levels come from its own simpler templates.
 *
 * **What a failure looks like**: a region drawn twice or not at all where levels meet (the dither
 * pair not partitioning, or a level mesh reaching `parts`); regions popping as the camera flies
 * (no crossfade, or a band too narrow); the control no slower than the selection (the levels not
 * being chosen at all).
 */
import {
  Camera,
  HlodSet,
  MeshBuilder,
  createEnvironment,
  createHlodDraws,
  createRenderer,
  frustumFromViewProjection,
  mulberry32,
  projectionScaleOf,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DrftLoader } from '../../packages/assets/src/index';
import { spawnBcWorker } from '../../packages/assets/src/bcWorkers';
import { writeDrft } from '../../packages/drft/src/index';
import type { DrftMaterial, DrftRegion } from '../../packages/drft/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const SKY: Vec3 = [0.55, 0.62, 0.72];
const GRID = 12;
const SIZE = 100;
const FRAMES = 120;

/**
 * Sixteen buildings on a block at three levels: towers with setbacks, fins and cornices; the tower
 * and its setback alone, which stand at most half a metre from the first; and one box a building,
 * which drops the eight-metre setback.
 */
function block(ox: number, oz: number, random: () => number): MeshData[] {
  const fine = new MeshBuilder();
  const plainer = new MeshBuilder();
  const boxes = new MeshBuilder();
  for (let lot = 0; lot < 16; lot++) {
    const cx = ox + 20 + (lot % 4) * 20;
    const cz = oz + 20 + Math.floor(lot / 4) * 20;
    const h = 12 + random() * 60;
    const grey = 0.45 + random() * 0.35;
    const wall: Vec3 = [grey, grey * 0.96, grey * 0.9];
    const fin: Vec3 = [grey * 0.6, grey * 0.6, grey * 0.62];
    /* The coarser levels wear the facade's average: fins cover a fifth of it and cornices a
       thirteenth, both at 0.6 of the wall, so about 0.9. Without it the switch reads as the city
       brightening, because what a level drops is detail *and* the shade that detail cast. */
    const average: Vec3 = [wall[0] * 0.9, wall[1] * 0.9, wall[2] * 0.9];
    fine.addBox([cx, h / 2, cz], [7, h / 2, 7], wall);
    fine.addBox([cx, h + 4, cz], [4.5, 4, 4.5], wall);
    plainer.addBox([cx, h / 2, cz], [7, h / 2, 7], average);
    plainer.addBox([cx, h + 4, cz], [4.5, 4, 4.5], average);
    boxes.addBox([cx, h / 2, cz], [7, h / 2, 7], average);
    for (let y = 4; y < h; y += 4) fine.addBox([cx, y, cz], [7.3, 0.15, 7.3], fin);
    for (let i = 0; i < 7; i++) {
      const along = -6 + i * 2;
      fine.addBox([cx + along, h / 2, cz - 7.2], [0.2, h / 2, 0.25], fin);
      fine.addBox([cx + along, h / 2, cz + 7.2], [0.2, h / 2, 0.25], fin);
      fine.addBox([cx - 7.2, h / 2, cz + along], [0.25, h / 2, 0.2], fin);
      fine.addBox([cx + 7.2, h / 2, cz + along], [0.25, h / 2, 0.2], fin);
    }
  }
  return [fine.build(), plainer.build(), boxes.build()];
}

/** What each of those levels claims: how far its surface may stand from the finest. */
const ERRORS = [0, 0.5, 8];

function plain(name: string): DrftMaterial {
  return {
    name,
    color: [1, 1, 1],
    specular: 0,
    roughness: 0.8,
    emissive: 0,
    emissiveColor: [0, 0, 0],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    reflectivity: 0,
    cutout: 0,
  };
}

/** The whole city as a container: the ground first, then each region ahead of its meshes. */
function city(): { bytes: ArrayBuffer; triangles: Map<string, number> } {
  const random = mulberry32(17);
  const meshes: MeshData[] = [
    new MeshBuilder()
      .addBox(
        [(GRID * SIZE) / 2, -0.1, (GRID * SIZE) / 2],
        [GRID * SIZE, 0.1, GRID * SIZE],
        [0.3, 0.31, 0.33],
      )
      .build(),
  ];
  const lamp = new MeshBuilder()
    .addCylinder([0, 3, 0], 0.12, 3, 'y', [0.2, 0.2, 0.22], 0, 8)
    .addSphere([0, 6.2, 0], 0.35, [1, 0.9, 0.7], 1, 12, 8)
    .build();
  const triangles = new Map<string, number>();
  const regions: DrftRegion[] = [];
  /* Introduced by the first region, so it sits among that region's meshes. */
  let lampOrdinal = -1;
  for (let r = 0; r < GRID * GRID; r++) {
    const ox = (r % GRID) * SIZE;
    const oz = Math.floor(r / GRID) * SIZE;
    const levels = block(ox, oz, random).map((mesh, level) => {
      triangles.set(`${r}:${level}`, mesh.indices.length / 3);
      return { error: ERRORS[level] ?? 0, meshes: [meshes.push(mesh) - 1] };
    });
    if (r === 0) lampOrdinal = meshes.push(lamp) - 1;
    const posts: number[] = [];
    for (let i = 0; i < 6; i++) {
      posts.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox + 8 + i * 16, 0, oz + 5, 1);
      posts.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox + 5, 0, oz + 8 + i * 16, 1);
    }
    regions.push({
      id: r,
      bounds: [ox, 0, oz, ox + SIZE, 90, oz + SIZE],
      levels,
      instances: [{ mesh: lampOrdinal, transforms: new Float32Array(posts) }],
      occluders: new Float32Array([ox + 13, 0, oz + 13, ox + 87, 12, oz + 87]),
      collision: null,
    });
  }
  const bytes = writeDrft({
    head: { name: 'regions' },
    meshes,
    materials: meshes.map((_, i) => plain(`m${i}`)),
    regions,
  });
  return { bytes, triangles };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  const hlodOn = query.get('hlod') !== '0';
  const high = query.get('view') === 'high';
  const fly = query.get('fly') === '1';
  const created = await createRenderer(
    canvas,
    { ...askedQuality(), occlusionCulling: 256 },
    DEV_RENDERER,
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const { bytes, triangles } = city();
  const loader = new DrftLoader(renderer, {
    bcWorker: spawnBcWorker,
    revealSec: 0,
    uploadMsPerFrame: 1000,
  });
  await loader.consume(new Response(bytes), { fit: 'none' });
  const hlod = new HlodSet({
    capacity: GRID * GRID,
    pixelTolerance: Number(query.get('tol') ?? '1.5'),
    fadeSec: Number(query.get('fade') ?? '0'),
  });
  const draws = createHlodDraws(GRID * GRID);

  const env = createEnvironment();
  env.directionalDir = [0.4, 0.8, 0.3];
  env.ambient = [0.35, 0.38, 0.45];
  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.3;
  camera.far = 3000;
  const frustum = new Float32Array(24);
  const eye = new Float32Array(3);

  let frame = 0;
  let last = performance.now();
  let gpu = 0;
  const draw = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    loader.update(dt);
    for (const region of loader.regions.values()) {
      if (region.pending === 0 && !hlod.has(region.id)) {
        hlod.add(
          region.id,
          region.bounds,
          region.levels.map((level) => level.error),
        );
      }
    }
    const t = fly ? frame * 0.01 : 0;
    if (high) {
      camera.position[0] = -150;
      camera.position[1] = 380;
      camera.position[2] = -150;
      camera.lookAt(600, 0, 600);
    } else {
      camera.position[0] = 499;
      camera.position[1] = 1.8;
      camera.position[2] = 120 + t * 300;
      camera.lookAt(499 + Math.sin(t) * 40, 8, 1100);
    }
    renderer.resize();
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    frustumFromViewProjection(camera.viewProjection, frustum);
    eye[0] = camera.position[0] ?? 0;
    eye[1] = camera.position[1] ?? 0;
    eye[2] = camera.position[2] ?? 0;

    renderer.gpuTimer.beginFrame();
    renderer.beginFrame(SKY);
    renderer.gpuTimer.begin('rest');
    renderer.bindMeshPass(camera, env);
    for (const region of loader.regions.values()) {
      const o = region.occluders;
      for (let i = 0; i < o.length; i += 6) {
        renderer.addOccluder(
          [o[i] ?? 0, o[i + 1] ?? 0, o[i + 2] ?? 0],
          [o[i + 3] ?? 0, o[i + 4] ?? 0, o[i + 5] ?? 0],
          IDENTITY,
        );
      }
    }
    for (const part of loader.parts) renderer.drawMesh(part.mesh, IDENTITY);
    const scale = projectionScaleOf(camera.fovYDeg, canvas.height);
    const n = hlodOn ? hlod.select(eye, scale, frustum, renderer, dt, draws) : 0;
    const shown = [0, 0, 0];
    let issued = 0;
    let tris = 0;
    const regionDraw = (id: number, level: number, dither: number): void => {
      const region = loader.regions.get(id);
      if (region === undefined) return;
      if (dither !== 0) renderer.setDitherFade(dither);
      for (const part of region.levels[level]?.parts ?? []) {
        renderer.drawMesh(part.mesh, IDENTITY);
        issued++;
      }
      if (level === 0) {
        for (const part of region.batches) {
          if (part.instances !== null)
            renderer.drawInstanced(part.instances.batch, part.instances.data);
          issued++;
        }
      }
      if (dither !== 0) renderer.setDitherFade(0);
      tris += triangles.get(`${id}:${level}`) ?? 0;
      if (dither >= 0) shown[level] = (shown[level] ?? 0) + 1;
    };
    if (hlodOn) {
      for (let i = 0; i < n; i++) {
        regionDraw(draws.region[i] ?? 0, draws.level[i] ?? 0, draws.dither[i] ?? 0);
      }
    } else {
      for (const region of loader.regions.values()) regionDraw(region.id, 0, 0);
    }
    renderer.endFrame();
    renderer.gpuTimer.end();
    renderer.gpuTimer.endFrame();
    const sample = renderer.gpuTimer.poll();
    if (sample !== null) gpu = sample.rest;
    stats.textContent =
      `${created.backend} · hlod ${hlodOn ? 'on' : 'off'} · ${hlod.size} of ${GRID * GRID} regions · ` +
      `levels ${shown.join(' / ')} · ${issued} draws · ${(tris / 1e6).toFixed(2)} M triangles · ` +
      `${gpu.toFixed(2)} ms gpu`;
    frame += 1;
    if (frame < FRAMES || fly || hlod.size < GRID * GRID) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
