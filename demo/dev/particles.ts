/**
 * Every particle material this engine ships, drawn side by side, on either backend.
 *
 * **The point of this page is that two differences are visible rather than asserted.** Task E2
 * added `'mote'`, an unlit, alpha-blended particle material, beside the existing `'smoke'`
 * (soft, eroded, lit) and `'spark'` (hot, additive, unlit) — because neither existing material
 * could draw what drei's `Sparkles` draws: an unlit point with a *real* alpha, blended rather
 * than added. `ParticleBatchOptions.fog` is the other half: `'mote'` is unfogged unless a
 * caller asks, where `'spark'`/`'smoke'` stay unconditionally fogged as they always have.
 *
 * Two cases, each aimed at one of those:
 *
 *   - **Three tight, overlapping clumps in front of a lit wall**, left to right: smoke, spark,
 *     mote (fog left at its default, off). Same particle count, same spread, same size, so the
 *     only real variable is the material. Additive stacks brightness where sparks overlap —
 *     the clump's centre blows out past the wall's own colour. Alpha blending never does that:
 *     smoke's and the mote's overlaps only ever veil the wall behind them, layering toward
 *     their own colour and never past it, which is the whole visual signature `PARTICLE_MOTE_FRAG`
 *     exists to draw and additive cannot. Smoke is also visibly grainy (`erosion` set high) where
 *     the mote is a plain soft point — a second, independent tell that the two are not the same
 *     shader wearing a different blend state.
 *   - **Two identical mote clumps, far into the fog, one option apart.** Same positions, same
 *     colour, same alpha, both at a distance the scene's fog reaches hard — the only difference
 *     is `{ fog: true }` on the right. The left one reads exactly its authored colour at any
 *     range, because leaving `fog` unset is what a caller reaching for `'mote'` is usually
 *     asking for; the right one dissolves toward the fog colour like everything else in the
 *     frame. If the uniform branch in `PARTICLE_MOTE_FRAG` were a no-op, the two would match.
 *     They do not.
 *
 *     /particles.html                 the default backend, which is WebGL2
 *     /particles.html?backend=webgpu  the other one
 *
 * Deterministic: every position comes from a fixed hash of a particle's own index, not
 * `Math.random`, and time is a constant handed to `drawParticles` rather than a clock read — two
 * runs of one build photograph the same pixels. `window.__drawn` marks readiness for the harness.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `plumes.ts` and `translucent.ts`.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  ParticleHandle,
  ParticleInstances,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/* The fog colour doubles as the clear colour, so a fogged clump visibly dissolves into the
   background at range instead of merely dimming — the signature the second case is built to
   show, exactly as translucent.ts's receding rows do for the mesh path. */
const FOG_COLOR: Vec3 = [0.08, 0.09, 0.13];
const FOG_DENSITY = 0.03;

/** The instant every particle is evaluated at. Fixed and arbitrary: nothing here reads a clock. */
const TIME_SEC = 4.0;

/**
 * A reproducible 0..1 value from a particle's own index and a salt, standing in for
 * `Math.random` — which would make two runs of this page photograph different frames and
 * defeat the whole point of a determinism floor.
 */
function jitter(i: number, salt: number): number {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A tight, deliberately overlapping clump of particles, built once and never touched again.
 *
 * Dense on purpose: additive and alpha-blended materials only disagree where particles
 * overlap — a field of particles that never touch each other would draw identically under
 * either blend state, and this page exists to make the disagreement visible.
 */
function buildClump(
  count: number,
  center: Vec3,
  spreadM: number,
  sizeM: number,
  color: Vec3,
  alpha: number,
): ParticleInstances {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count).fill(sizeM);
  const spins = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count).fill(alpha);
  const ages = new Float32Array(count).fill(0.3);
  const seeds = new Float32Array(count);
  const velocities = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = jitter(i, 1) * Math.PI * 2;
    const radius = jitter(i, 2) * spreadM;
    positions[i * 3] = center[0] + Math.cos(angle) * radius;
    positions[i * 3 + 1] = center[1] + (jitter(i, 3) - 0.5) * spreadM * 1.4;
    positions[i * 3 + 2] = center[2] + Math.sin(angle) * radius;
    spins[i] = jitter(i, 4) * Math.PI * 2;
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
    seeds[i] = jitter(i, 5);
  }
  return {
    positions,
    sizes,
    spins,
    colors,
    alphas,
    ages,
    seeds,
    velocities,
    count,
    capacity: count,
  };
}

/**
 * A lit backdrop wall, bright enough that overlapping alpha-blended particles visibly veil it
 * and overlapping additive ones visibly blow out past it.
 *
 * Kept short — 4m, not the near clumps' own 5m headroom — so the sightline to the far, higher
 * pair in case 2 clears its top rather than being hidden behind it: at the wall's distance the
 * camera's ray to a y=8.5 target has already climbed past y=4, which a taller wall would block.
 */
function buildWall(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, 2, -4], [10, 2, 0.15], [0.6, 0.62, 0.66]).build();
}

function buildGround(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, -0.4, -20], [20, 0.4, 110], [0.05, 0.055, 0.07]).build();
}

const CLUMP_COUNT = 20;
const CLUMP_SPREAD_M = 1.1;
const CLUMP_SIZE_M = 1.15;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Read this back rather than trusting `?backend=`: a browser with no usable WebGPU adapter
     falls back to WebGL2 silently, and this page's whole point is a same-backend comparison. */
  console.log(`[particles] backend: ${created.backend} · ${created.reason}`);

  const env = createEnvironment({
    ambient: [0.25, 0.26, 0.3],
    directionalColor: [1, 0.97, 0.9],
    directionalDir: [0.3, 0.6, 0.74],
    fogColor: FOG_COLOR,
    fogDensity: FOG_DENSITY,
  });

  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.3;
  camera.far = 150;
  camera.position[0] = 0;
  camera.position[1] = 3.4;
  camera.position[2] = 24;
  camera.lookAt(0, 3.6, -40);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const ground: MeshHandle = renderer.createMesh(buildGround());
  const wall: MeshHandle = renderer.createMesh(buildWall());

  /* ---- Case 1: blend comparison, three clumps in front of the lit wall ---- */
  const SMOKE_COLOR: Vec3 = [0.68, 0.65, 0.6];
  const SPARK_COLOR: Vec3 = [1, 0.55, 0.15];
  const MOTE_COLOR: Vec3 = [0.75, 0.85, 1];

  const smokeBatch: ParticleHandle = renderer.createParticles(CLUMP_COUNT, {
    material: 'smoke',
    blend: 'alpha',
    erosion: 0.6,
  });
  const sparkBatch: ParticleHandle = renderer.createParticles(CLUMP_COUNT, {
    material: 'spark',
    blend: 'additive',
    coreGain: 1.8,
  });
  /*
   * `fog` left unset — the default this whole case relies on. One handle per clump, matching
   * how every real consumer already uses this API (a production consumer draws tyre smoke, body-impact
   * dust and oil spray as three separate 'smoke' handles in one frame, never one handle for
   * more than one pool) — `drawParticles` uploads a batch's live data and draws it in the same
   * call, and nothing about a batch is safe to reuse for a second, unrelated draw within the
   * same frame: WebGPU does not submit its command buffer until `endFrame`, so a second
   * `drawParticles` on the same handle would overwrite the first's instance data before the
   * GPU ever reads it.
   */
  const moteNearBatch: ParticleHandle = renderer.createParticles(CLUMP_COUNT, {
    material: 'mote',
    blend: 'alpha',
  });
  const moteFarUnfoggedBatch: ParticleHandle = renderer.createParticles(CLUMP_COUNT, {
    material: 'mote',
    blend: 'alpha',
  });
  const moteFarFoggedBatch: ParticleHandle = renderer.createParticles(CLUMP_COUNT, {
    material: 'mote',
    blend: 'alpha',
    fog: true,
  });

  const smokeNear = buildClump(
    CLUMP_COUNT,
    [-7, 2, 0],
    CLUMP_SPREAD_M,
    CLUMP_SIZE_M,
    SMOKE_COLOR,
    0.55,
  );
  const sparkNear = buildClump(
    CLUMP_COUNT,
    [0, 2, 0],
    CLUMP_SPREAD_M,
    CLUMP_SIZE_M,
    SPARK_COLOR,
    0.95,
  );
  const moteNear = buildClump(
    CLUMP_COUNT,
    [7, 2, 0],
    CLUMP_SPREAD_M,
    CLUMP_SIZE_M,
    MOTE_COLOR,
    0.6,
  );

  /* ---- Case 2: two identical mote clumps, deep in the fog, one option apart ---- */
  const moteFarUnfogged = buildClump(
    CLUMP_COUNT,
    [-3, 8.5, -80],
    CLUMP_SPREAD_M,
    CLUMP_SIZE_M,
    MOTE_COLOR,
    0.6,
  );
  const moteFarFogged = buildClump(
    CLUMP_COUNT,
    [3, 8.5, -80],
    CLUMP_SPREAD_M,
    CLUMP_SIZE_M,
    MOTE_COLOR,
    0.6,
  );

  /* One draw list, called on load and again on resize, so the two paths cannot drift apart. */
  function renderFrame(): void {
    renderer.beginFrame(FOG_COLOR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    renderer.drawMesh(wall, IDENTITY);

    renderer.drawParticles(smokeBatch, smokeNear, camera, env, TIME_SEC);
    renderer.drawParticles(sparkBatch, sparkNear, camera, env, TIME_SEC);
    renderer.drawParticles(moteNearBatch, moteNear, camera, env, TIME_SEC);

    renderer.drawParticles(moteFarUnfoggedBatch, moteFarUnfogged, camera, env, TIME_SEC);
    renderer.drawParticles(moteFarFoggedBatch, moteFarFogged, camera, env, TIME_SEC);

    renderer.endFrame();
  }

  renderFrame();
  stats.textContent = `${created.backend} · ${created.reason} · smoke spark mote mote-fogged`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
