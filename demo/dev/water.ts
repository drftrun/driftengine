/**
 * Four bodies of water in one frame: the sea, a basin, a channel, and the same channel turned.
 *
 * **This page exists because every shape `bounds` can take was untestable from inside.** A body
 * was a centre and one half-extent until 2026-08-28, so the only bounded shape was a square, and
 * the two published scenes that draw one draw a square each. Reported from outside: a channel is
 * long and thin, and the square that contains a 3 by 21 metre ditch floods eighteen metres of
 * field either side of it.
 *
 * It draws **four bodies in one frame** on purpose, and that is the second half of the row. WebGPU
 * held every body's uniforms in one buffer rewritten before each draw, and a `queue.write*` does
 * not interleave with the draws it sits between — so all four took the *last* body's extents,
 * level, colours and direction, and the frame showed one sheet where it should show four. Nothing
 * had ever drawn two, which is exactly how the joint palette's copy of this defect survived eight
 * releases. Both halves are visible here at a glance:
 *
 *     /water.html                 the default backend, which is WebGL2
 *     /water.html?backend=webgpu  the other one
 *
 * A capture of the two is the parity check. Four separate footprints, one of them at an angle to
 * everything else, is the picture; one shape, or four stacked in one place, is the bug.
 *
 * Deterministic without the held clock, because it reads no clock: `TIME_SEC` is a constant handed
 * to `drawWater`, which takes the instant to evaluate at. Two runs photograph the same pixels.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * in the harness, beside `plumes.ts` and the held clock.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  Vec3,
  WaterBody,
  WaterHandle,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Nothing moves here, so one matrix serves the only mesh draw the page makes. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The instant every body is evaluated at.
 *
 * Fixed and not zero: the Gerstner sum is seeded off time and at zero every wave train sits at the
 * same phase, which photographs as a surface nobody would call water.
 */
const TIME_SEC = 11.5;

/** Enough wind to build a visible sea state, and the same numbers every body answers to. */
const WIND_X = 5.5;
const WIND_Z = 1.5;

/** Where the ground sits, and where the placed bodies sit on it. */
const GROUND_Y = 0;
const PLACED_LEVEL = 0.05;
/** The sea, below the slab, so it is seen past the slab's edges and not through it. */
const SEA_LEVEL = -1.4;

const DEEP: Vec3 = [0.03, 0.07, 0.1];
const SHALLOW: Vec3 = [0.16, 0.3, 0.34];

/**
 * The four bodies, and each is here to make one claim.
 *
 * The **sea** is the case nothing may change: no `bounds` at all, the camera-following sheet.
 * The **basin** is the old shape, one number, still spelled the old way — a consumer's existing
 * `halfM` has to keep meaning what it meant. The **channel** is the entry this page was written
 * for: separate extents, six metres across and forty-two long. The **turned channel** is the same
 * rectangle laid along a direction, which is what a ditch beside a road that does not run along an
 * axis needs.
 */
const BODIES: readonly { readonly label: string; readonly body: WaterBody }[] = [
  {
    label: 'sea (unbounded)',
    body: {
      level: SEA_LEVEL,
      deepColor: DEEP,
      shallowColor: SHALLOW,
      density: 0.85,
    },
  },
  {
    label: 'basin (halfM 4)',
    body: {
      level: PLACED_LEVEL,
      deepColor: DEEP,
      shallowColor: SHALLOW,
      density: 0.4,
      waveScale: 0.3,
      agitation: 0.25,
      bounds: { centreX: -11, centreZ: 6, halfM: 4 },
    },
  },
  {
    label: 'channel (3 x 21)',
    body: {
      level: PLACED_LEVEL,
      deepColor: DEEP,
      shallowColor: SHALLOW,
      density: 0.55,
      waveScale: 0.2,
      agitation: 0.2,
      bounds: { centreX: 0, centreZ: 0, halfX: 3, halfZ: 21 },
    },
  },
  {
    label: 'channel turned 40 degrees',
    body: {
      level: PLACED_LEVEL,
      deepColor: DEEP,
      shallowColor: SHALLOW,
      density: 0.55,
      waveScale: 0.2,
      agitation: 0.2,
      /*
       * A direction and not an angle, so the page states one too: 40 degrees off +z is
       * (sin 40, cos 40) = (0.643, 0.766), written out because this file may not compute it —
       * a literal is what makes the picture reproducible on any engine's `Math.sin`.
       */
      bounds: { centreX: 14, centreZ: -2, halfX: 2.2, halfZ: 16, forwardX: 0.643, forwardZ: 0.766 },
    },
  },
];

/** What the frame clears to, and the sky the water reflects nothing of. */
const CLEAR: Vec3 = [0.05, 0.07, 0.1];

/**
 * The slab the placed bodies sit on, wide enough that the sea is only seen past its edge.
 *
 * Pale, because every claim this page makes is about a *footprint*: the eye is being asked where
 * one sheet stops and the ground beside it starts, and a dark floor under dark water hides exactly
 * that boundary.
 */
function buildGround(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, GROUND_Y - 0.6, 0], [34, 0.6, 34], [0.46, 0.44, 0.4]).build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const ground: MeshHandle = renderer.createMesh(buildGround());
  /*
   * **One handle for every body**, which is what the engine intends: a bounded body is drawn from
   * a shared unit sheet scaled per draw, so four bodies cost four draws and no extra geometry.
   * Handing each body its own handle would hide the defect this page is here to show, because the
   * hazard is a shared *uniform buffer* and not a shared mesh.
   */
  const water: WaterHandle = renderer.createWater();
  const env = createEnvironment();
  const camera = new Camera();
  camera.fovYDeg = 52;
  camera.near = 0.3;
  camera.far = 400;

  renderer.resize();

  camera.position[0] = -6;
  camera.position[1] = 26;
  camera.position[2] = 44;
  camera.lookAt(2, 0, -2);
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  /* Reported rather than inferred from the query: a browser without WebGPU, a device request that
     failed and a misspelt `?backend=` all fall back silently and draw a plausible frame. */
  stats.textContent =
    `${created.backend} · ${created.reason} · ${BODIES.length} bodies · ` +
    `${BODIES.map((b) => b.label).join(' · ')} · ${BODIES.length + 1} draws`;

  /*
   * A loop that redraws one frame, and the loop is what makes the page photographable.
   *
   * Every frame is identical — `TIME_SEC` is a constant and nothing here reads a clock — so two
   * runs are the same pixels either way. What the loop buys is the capture harness: `shots.mjs`
   * waits for a page to have *held* a frame, and a page that draws once and returns never counts
   * one, so it cannot be photographed by the gate this repository verifies rendering with.
   */
  const frame = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    /*
     * **Four `drawWater` calls between one `beginFrame` and one `endFrame`**, which is the second
     * claim this page makes. On WebGPU those four draws are recorded on one encoder and submitted
     * after every queue write, so a single shared uniform buffer hands all four the numbers of
     * whichever was written last.
     */
    for (const entry of BODIES) {
      renderer.drawWater(water, camera, TIME_SEC, entry.body, env, WIND_X, WIND_Z);
    }
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
  });
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
