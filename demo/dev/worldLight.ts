/**
 * A kilometre of city at night, lit by thousands of lamps: the nearest exactly, the rest through
 * one dense volume baked here as a bake tool would bake it.
 *
 *     /worldLight.html?clustered=1                 street level, the default backend
 *     /worldLight.html?clustered=1&backend=webgl2  the other one
 *     /worldLight.html?clustered=1&field=0         the control: exact lights only
 *     /worldLight.html?clustered=1&view=high       over the roofs
 *     /worldLight.html?clustered=1&occlude=0       the volume summed with no walls in the way
 *
 * Streets every 100 m each way, a lamp every 40 m on both sides reaching 30 m, and a few hundred
 * coloured sign lights on the facades — about three thousand lights. `bakeDenseField` sums them at
 * 4 m over the whole kilometre, occluded by the blocks, into a volume the renderer takes whole
 * (`createWorldLightField`); the frame shades its exact choice near the eye and the volume past it.
 *
 * **What a failure looks like**: the far streets dark with the volume on (the dense lookup not
 * reached, or reading the wrong half of the texture); light through the blocks (the volume summed
 * unoccluded, `?occlude=0` being the picture of that); a ring where the exact lights end (the
 * split not honouring `inLightField`); the two backends disagreeing.
 */
import {
  Camera,
  MeshBuilder,
  bakeDenseField,
  createEnvironment,
  createPointLightBuffer,
  createLightGrid,
  createRenderer,
  mulberry32,
  selectGridLights,
  selectPointLights,
} from '../../packages/core/src/index';
import type {
  PointLightSource,
  RendererApi,
  Vec3,
  WorldLightField,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const STREETS = 10;
const PITCH = 100;
const ROAD = 10;
const FRAMES = 60;

/** Each block's height, fixed by its coordinates so the bake and the meshes agree. */
function heightOf(bx: number, bz: number): number {
  return 18 + ((((bx * 73856093) ^ (bz * 19349663)) >>> 0) % 42);
}

/** Signed distance to the nearest block, which is the only thing that occludes here. */
function distanceToBlocks(x: number, y: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  const cx = Math.floor(x / PITCH);
  const cz = Math.floor(z / PITCH);
  for (let bz = cz - 1; bz <= cz + 1; bz++) {
    for (let bx = cx - 1; bx <= cx + 1; bx++) {
      if (bx < 0 || bz < 0 || bx >= STREETS || bz >= STREETS) continue;
      const h = heightOf(bx, bz);
      const half = (PITCH - 2 * ROAD) / 2;
      const qx = Math.abs(x - (bx * PITCH + PITCH / 2)) - half;
      const qy = Math.abs(y - h / 2) - h / 2;
      const qz = Math.abs(z - (bz * PITCH + PITCH / 2)) - half;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      best = Math.min(best, outside + Math.min(Math.max(qx, qy, qz), 0));
    }
  }
  return best;
}

function lamp(x: number, y: number, z: number, radius: number, colour: Vec3): PointLightSource {
  return {
    x,
    y,
    z,
    r: colour[0],
    g: colour[1],
    b: colour[2],
    radius,
    flicker: 0,
    shadowNear: 0.1,
    sourceRadius: 0.2,
    castsShadow: false,
  };
}

function lights(): PointLightSource[] {
  const out: PointLightSource[] = [];
  const warm: Vec3 = [2.4, 1.7, 1.0];
  for (let s = 0; s <= STREETS; s++) {
    for (let along = 20; along < STREETS * PITCH; along += 40) {
      for (const side of [-6, 6]) {
        out.push(lamp(s * PITCH + side, 7, along, 30, warm));
        out.push(lamp(along, 7, s * PITCH + side, 30, warm));
      }
    }
  }
  const random = mulberry32(5);
  const neon: Vec3[] = [
    [2.5, 0.3, 1.8],
    [0.3, 1.6, 2.6],
    [2.6, 1.2, 0.2],
    [0.4, 2.4, 0.9],
  ];
  for (let i = 0; i < 600; i++) {
    const bx = Math.floor(random() * STREETS);
    const bz = Math.floor(random() * STREETS);
    const along = ROAD + random() * (PITCH - 2 * ROAD);
    const face = Math.floor(random() * 4);
    const x = bx * PITCH + (face < 2 ? along : face === 2 ? ROAD - 0.5 : PITCH - ROAD + 0.5);
    const z = bz * PITCH + (face >= 2 ? along : face === 0 ? ROAD - 0.5 : PITCH - ROAD + 0.5);
    out.push(lamp(x, 3 + random() * 10, z, 12, neon[i % 4] as Vec3));
  }
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  const withField = query.get('field') !== '0';
  const high = query.get('view') === 'high';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const city = new MeshBuilder();
  city.addBox([500, -0.1, 500], [520, 0.1, 520], [0.3, 0.3, 0.32]);
  for (let bz = 0; bz < STREETS; bz++) {
    for (let bx = 0; bx < STREETS; bx++) {
      const h = heightOf(bx, bz);
      const half = (PITCH - 2 * ROAD) / 2;
      city.addBox(
        [bx * PITCH + PITCH / 2, h / 2, bz * PITCH + PITCH / 2],
        [half, h / 2, half],
        [0.55, 0.53, 0.5],
      );
    }
  }
  const mesh = renderer.createMesh(city.build());
  const sources = lights();

  let bakeMs = 0;
  let megabytes = 0;
  let world: WorldLightField | null = null;
  if (withField) {
    const started = performance.now();
    const volume = bakeDenseField(
      sources,
      renderer.quality.pointLightFalloff,
      query.get('occlude') === '0' ? null : distanceToBlocks,
      [-12, 0, -12, 1008, 64, 1008],
      4,
    );
    bakeMs = performance.now() - started;
    megabytes = (volume.light.length * 2 * 2) / 1e6;
    world = renderer.createWorldLightField(volume, { fadeSec: 0 });
    /* The volume summed every one, so the selection must not count them twice. */
    for (const source of sources) source.inLightField = true;
  }

  const env = createEnvironment();
  env.directionalColor = [0, 0, 0];
  env.ambient = [0.01, 0.012, 0.018];
  env.ambientGround = [0.005, 0.005, 0.006];
  env.nightFactor = 1;
  const buffer = createPointLightBuffer(renderer.quality.clusteredLights ? 320 : 16);
  /* The exact choice through a grid, or `?grid=0` for the scan over every light. */
  const grid = query.get('grid') === '0' ? null : createLightGrid(sources, 50);
  let selectMs = 0;

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.near = 0.3;
  camera.far = 2000;
  if (high) {
    camera.position[0] = -120;
    camera.position[1] = 260;
    camera.position[2] = -120;
    camera.lookAt(500, 0, 500);
  } else {
    camera.position[0] = 302;
    camera.position[1] = 1.7;
    camera.position[2] = 40;
    camera.lookAt(302, 4, 1000);
  }

  let frame = 0;
  let gpu = 0;
  const draw = (): void => {
    const x = camera.position[0] ?? 0;
    const y = camera.position[1] ?? 0;
    const z = camera.position[2] ?? 0;
    const chose = performance.now();
    if (grid === null) selectPointLights(sources, x, y, z, buffer, 0, 400);
    else selectGridLights(grid, x, y, z, buffer, 0, 400);
    selectMs += performance.now() - chose;
    env.lightCount = buffer.count;
    env.lightPositions = buffer.positions;
    env.lightColors = buffer.colors;
    env.lightRadii = buffer.radii;
    env.lightSourceRadii = buffer.sourceRadii;
    env.lightWeights = buffer.weights;
    env.lightDirections = buffer.directions;
    env.lightConeCos = buffer.coneCos;
    env.lightIesProfiles = buffer.iesProfiles;
    world?.follow(buffer.complete, x, y, z, 1 / 60);
    renderer.resize();
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    renderer.gpuTimer.beginFrame();
    renderer.beginFrame([0.01, 0.012, 0.02]);
    renderer.gpuTimer.begin('rest');
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, IDENTITY);
    renderer.endFrame();
    renderer.gpuTimer.end();
    renderer.gpuTimer.endFrame();
    const sample = renderer.gpuTimer.poll();
    if (sample !== null) gpu = sample.rest;
    frame += 1;
    stats.textContent =
      `${created.backend} · ${sources.length} lights · ${buffer.count} exact to ` +
      `${buffer.complete.toFixed(0)} m · ` +
      (withField
        ? `volume ${megabytes.toFixed(1)} MB baked in ${(bakeMs / 1000).toFixed(1)} s`
        : 'no volume') +
      ` · choice ${grid === null ? 'scanned' : 'gridded'} ${((selectMs / frame) * 1000).toFixed(0)} µs` +
      ` · ${gpu.toFixed(2)} ms gpu`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
