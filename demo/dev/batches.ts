/**
 * Two batches of one effect in one frame, which is the case nothing in this repository draws.
 *
 * **Four WebGPU passes write their per-draw uniforms into one shared buffer.** `drawBolts`,
 * `drawFlock`, `drawWindStreaks` and `drawCaustics` each call `queue.writeBuffer` and then record
 * a draw — and queue writes are ordered on the queue timeline while the frame's encoder is
 * submitted after all of them, so the **last** write reaches every draw. Two batches of any of the
 * four come out wearing the second one's colour, width, time and placement. One of each is
 * correct, which is why nothing has ever shown it. Water had the same defect and lost three bodies
 * of four, 387,837 pixels of a 921,600-pixel frame.
 *
 * Each of these takes a handle per batch, so drawing several is what the API is for.
 *
 *     /batches.html?effect=bolts            the default backend, which is WebGL2
 *     /batches.html?effect=bolts&backend=webgpu
 *     /batches.html?effect=caustics&only=0  one batch alone, which is the control
 *
 * **The two batches are tinted red and blue on purpose**, and the assertion built on that is
 * colour presence rather than a pixel diff. Only two of the four are additive — bolts and caustics
 * add, a flock is opaque and writes depth, and wind streaks are alpha blended and therefore
 * order-dependent — so no single arithmetic identity covers all four. What does cover all four is
 * that a frame drawing both batches must contain *both* signatures. Under the defect the first
 * batch wears the second's tint and its signature vanishes entirely, whatever the blend mode.
 *
 * Deterministic: one fixed camera, one fixed clock, one frame, no wall clock read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `volume.ts` and `water.ts`.
 */

import {
  BoltPool,
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  CausticSheet,
  FlockParams,
  MeshHandle,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/*
 * **Exactly neutral, and every other colour in this scene with it.** The assertion counts pixels
 * where one channel leads the others, so anything in the frame that is not the effect has to be
 * grey or it is counted as a signature. The floor, the clear, the ambient and the sun were all
 * faintly blue in the first version of this page, which put a blue bias under the whole frame.
 */
const CLEAR: Vec3 = [0.012, 0.012, 0.012];

/**
 * The two signatures, and they are as far apart as the channels go.
 *
 * A tint that merely differs would need a threshold to read; one that owns a whole channel is
 * counted rather than measured, and the count is what the check asserts on.
 */
const RED: Vec3 = [1, 0.04, 0.04];
const BLUE: Vec3 = [0.04, 0.12, 1];

/** A fixed clock: the effects animate off a time, and a photograph needs a stated one. */
const NOW = 4.25;

/**
 * Two wind states, so the two lattices lean different ways as well as wearing different tints.
 *
 * **Mirror images, and that is not cosmetic.** A first version gave the second field a shorter
 * drift and a stronger gust, and it drew 134 signature pixels against the first field's 1,023 —
 * so the control that says "batch 1 alone is blue" failed on the backend that has no defect. Equal
 * magnitudes make the two fields equally visible, which is what lets their *tints* be the thing
 * under test.
 */
const WIND_A = { velocityX: 5, velocityZ: 1, speed: 5.1, gust: 0.4, driftX: 12, driftZ: 2 };
const WIND_B = { velocityX: -5, velocityZ: -1, speed: 5.1, gust: 0.4, driftX: -12, driftZ: -2 };

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const effect = asked.get('effect') ?? 'bolts';
  const only = asked.has('only') ? Number(asked.get('only')) : null;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* A dark floor, so an additive effect has something to add to and an opaque one something to
     stand in front of. Dark because the signatures are counted by which channel dominates. */
  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.5, 0], [60, 0.5, 60], [0.07, 0.07, 0.07]).build(),
  );

  const env = createEnvironment();
  env.directionalDir = [0.2, 0.94, 0.28];
  env.ambient = [0.06, 0.06, 0.06];
  env.directionalColor = [0.32, 0.32, 0.32];

  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.4;
  camera.far = 400;
  camera.position[0] = 0;
  camera.position[1] = 14;
  camera.position[2] = 46;
  camera.lookAt(0, 8, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  /**
   * Whether this batch is drawn at all. `?only=` names one of them; anything else draws both.
   *
   * An index the loop never reaches gives the scene with no batch in it, which is the background
   * every additive comparison needs.
   */
  const draws = (index: number): boolean => only === null || only === index;

  /* -- The four effects, two batches each, placed apart along X ---------------------------- */

  /** Two bolt pools, struck along fixed paths so the arcs are the same every load. */
  function bolts(): void {
    const batches = [0, 1].map((i) => {
      const pool = new BoltPool({
        capacity: 2,
        nodes: 33,
        lifeSec: 6,
        jitter: 0.14,
        restrikeHz: 0,
      });
      const x = i === 0 ? -16 : 16;
      /* Struck from a fixed seed, so the filament's shape is a property of the page. */
      pool.strike(x, 20, 0, x, 0, 0, 7 + i, 1);
      pool.update(NOW);
      return { handle: renderer.createBolts(2 * 33, `batch-${i}`), data: pool.segments };
    });
    for (const [i, batch] of batches.entries()) {
      if (!draws(i)) continue;
      /* Width and gain differ too, not only the tint: a shared slot carries all of them. */
      renderer.drawBolts(
        batch.handle,
        batch.data,
        camera,
        env,
        NOW,
        i === 0 ? RED : BLUE,
        i === 0 ? RED : BLUE,
        i === 0 ? 0.5 : 0.22,
        i === 0 ? 4 : 2.2,
      );
    }
  }

  /** Two caustic sheets, each a square of floor, lit from a water height of its own. */
  function caustics(): void {
    const sheetAt = (x: number, y: number): CausticSheet => ({
      spans: [
        { x0: x - 11, z0: -11, x1: x + 11, z1: -11, y: 0 },
        { x0: x - 11, z0: 11, x1: x + 11, z1: 11, y: 0 },
      ],
      waterY: y,
    });
    const batches = [
      renderer.createCaustics([sheetAt(-16, 3)]),
      renderer.createCaustics([sheetAt(16, 3)]),
    ];
    for (const [i, handle] of batches.entries()) {
      if (!draws(i) || handle === null) continue;
      /*
       * Caustics take no tint of their own: the pass derives one from `directionalColor` and
       * `ambient` at the moment of the call, which is a per-draw uniform like any other. So the
       * signature is set on the environment between the two draws, and the strength differs too —
       * one shared slot carries both.
       */
      env.directionalColor = i === 0 ? RED : BLUE;
      renderer.drawCaustics(handle, camera, NOW, env, 0, 0, i === 0 ? 3.2 : 1.1);
    }
  }

  /** Two flocks, circling centres of their own. Opaque, so these write depth. */
  function flock(): void {
    const params = (x: number): FlockParams => ({
      center: [x, 16, -4],
      radius: 9,
      height: 4,
      count: 40,
      speed: 5,
      scale: 1.6,
    });
    const batches = [renderer.createFlock(40), renderer.createFlock(40)];
    for (const [i, handle] of batches.entries()) {
      if (!draws(i)) continue;
      renderer.drawFlock(handle, camera, NOW, params(i === 0 ? -16 : 16), i === 0 ? RED : BLUE);
    }
  }

  /**
   * Two wind-street lattices, which are the one pair that cannot be placed apart.
   *
   * The lattice travels with the viewer, so both fields fill the same space and overlap
   * completely. That is why the assertion is colour presence and not a region comparison: two
   * alpha-blended fields over one another are order-dependent, and no arithmetic identity
   * survives that. Both signatures being *present* does.
   */
  function streaks(): void {
    /*
     * **Dense, and in a big cell, because this effect is built to be faint.** A streak's alpha is
     * `vFade * taper^2 * 0.13` and `vFade` carries `rx^3`, so most particles are nearly invisible
     * by design — "a uniform field is a veil", as the shader says. It also fades out past
     * `cellSize * 0.5` and in from 2 to 16 m, and those two windows barely overlap at a small
     * cell: at `cellSize` 12 there is no distance where a streak is both near enough and far
     * enough. A first version of this page used 2,600 in a cell of 34 and moved 24 pixels of the
     * frame by 3 levels, which is a page that cannot see anything.
     */
    const batches = [
      renderer.createWindStreaks({ count: 24000, cellSize: 64, onsetSpeed: 0.8, fullSpeed: 3 }),
      renderer.createWindStreaks({ count: 24000, cellSize: 64, onsetSpeed: 0.8, fullSpeed: 3 }),
    ];
    for (const [i, handle] of batches.entries()) {
      if (!draws(i)) continue;
      renderer.drawWindStreaks(
        handle,
        camera,
        i === 0 ? WIND_A : WIND_B,
        NOW,
        i === 0 ? RED : BLUE,
        env,
      );
    }
  }

  const EFFECTS: Record<string, () => void> = { bolts, caustics, flock, streaks };
  const run = EFFECTS[effect];
  if (run === undefined)
    throw new Error(`unknown effect "${effect}"; one of ${Object.keys(EFFECTS).join(', ')}`);

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floor, IDENTITY);
  run();
  renderer.endFrame();

  stats.textContent =
    `${created.backend} · ${created.reason} · ${effect} · ` +
    (only === null ? 'both batches' : `only ${only}`) +
    ' · batch 0 red, batch 1 blue';
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
