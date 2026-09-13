/**
 * All three directional shadow layers, on either backend.
 *
 * **This page exists because no scene in this harness opens the `dynamic` layer**, and that is
 * how the WebGPU backend shipped a `beginShadowPass` that returned false for it. Every gate was
 * green, every capture in the parity ledger matched, and every moving caster in both consumers
 * cast nothing at all — reported from one of them as *"sun shadow works for other than the character
 * itself"*, which is exactly what a missing movers' layer looks like from inside a game.
 *
 * A page cannot be added for every hole. It is added for this one because the failure is silent
 * by construction: the layer degrades to a white stand-in that reads as the far plane, so the
 * absence is an *empty* picture rather than a wrong one, and nothing in an automated comparison
 * of two empty pictures says anything.
 *
 *     /shadows.html                 the default backend, which is WebGL2
 *     /shadows.html?backend=webgpu  the other one
 *     /shadows.html?layers=1        one static depth layer, so the peel is absent by profile
 *
 * Three casters, one per layer, each dropping its shadow on a bare floor with nothing else to
 * confuse it:
 *
 *   - **left**, a post submitted to `static` only.
 *   - **centre**, two posts one behind the other along the light, submitted to `static` and then
 *     `static-peel`. The peel holds the second occluder, which a single depth map discards.
 *   - **right**, a post submitted to `dynamic` only. **This is the one that was missing.**
 *
 * Every shadow is the same shape, so the picture reads as "three shadows or fewer than three"
 * from across a room, and which one is absent names the layer that failed.
 *
 * Deterministic: one fixed light, one fixed camera, one frame, no clock read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `overlay.ts` and `plumes.ts`.
 */

import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];

/**
 * Where the sun is, **pointing at it** — the convention `createEnvironment` defaults to `[0,1,0]`
 * for, and the one `computeLightMatrix` looks along the negation of.
 *
 * Behind the posts and to one side, so every shadow falls *toward* the camera and lands on open
 * floor. Written the other way round first, which puts the sun under the floor: no shadow from
 * any layer, on either backend, and a page that would have reported the fix as still broken.
 *
 * High enough to clear `lowElevationFade`, which thins a shadow as the sun approaches the
 * horizon — a grazing sun is its own measurement and not this one.
 */
const SUN: Vec3 = [0.38, 0.74, -0.55];

/** A translation, because a caster is the same mesh in three places. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);

  const created = await createRenderer(
    canvas,
    {
      ...askedQuality(),
      /*
       * Two layers unless asked otherwise, because one of the three casters is the peel and a
       * profile with a single depth layer has nowhere to put it. `?layers=1` is how that state is
       * looked at rather than reasoned about — the centre pair should then drop to one shadow and
       * the outer two should be unchanged.
       */
      directionalShadowDepthLayers: asked.get('layers') === '1' ? 1 : 2,
    },
    DEV_RENDERER,
  );
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* A floor wide enough that every shadow lands on it, and one post shape reused everywhere. */
  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.1, 0], [9, 0.1, 9], [0.42, 0.44, 0.48]).build(),
  );
  const post: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 1.1, 0], [0.34, 1.1, 0.34], [0.82, 0.78, 0.62]).build(),
  );

  /* One posture per layer. The centre's second post stands behind the first *along the light*,
     which is the only arrangement in which a peel has anything to hold. */
  const STATIC_AT = at(-3.6, 0, 0);
  const PEEL_FRONT = at(0, 0, 0);
  const PEEL_BEHIND = at(0.85, 0, 1.0);
  const DYNAMIC_AT = at(3.6, 0, 0);

  const staticCasters = (sink: ShadowCasterSink): void => {
    sink.mesh(post, STATIC_AT);
    sink.mesh(post, PEEL_FRONT);
    sink.mesh(post, PEEL_BEHIND);
  };
  /* The peel layer is offered the same set: `depth.ts` discards everything at or in front of
     what the static pass stored, so what lands is the second occluder and nothing else. */
  const peelCasters = staticCasters;
  /* A shadow is a *difference* from the lit floor, so the floor has to be lit. Left at the
     default ambient the whole page reads as one flat grey and no layer can be told from any
     other. */
  const LIT: Vec3 = [1, 0.97, 0.9];
  const dynamicCasters = (sink: ShadowCasterSink): void => {
    sink.mesh(post, DYNAMIC_AT);
  };

  const env = createEnvironment();
  env.directionalDir = SUN;
  env.directionalColor = LIT;
  /* Low, so what is *not* in shadow is clearly brighter than what is. The default 0.25 lifts a
     shadow to within a few units of the floor beside it, which photographs as no shadow. */
  env.ambient = [0.16, 0.18, 0.23];
  env.shadowStrength = 0.9;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 200;
  camera.position[0] = 0;
  camera.position[1] = 6.4;
  camera.position[2] = 11.5;
  camera.lookAt(0, 0.4, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    1,
    0,
    9,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;

  /*
   * The three layers, in the order a consumer draws them: static, its peel, then the movers.
   * The order is load-bearing — the peel is peeled against what the static pass stored — and it
   * is also the order that caught a latch resetting the peel when the third layer opened.
   */
  const opened: string[] = [];
  for (const [layer, casters] of [
    ['static', staticCasters],
    ['static-peel', peelCasters],
    ['dynamic', dynamicCasters],
  ] as const) {
    /* WebGL2's `beginShadowPass` returns void and WebGPU's returns a boolean, so this reads the
       picture rather than the return value: what is asserted here is what got drawn. */
    renderer.beginShadowPass(lightMatrix, layer);
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();
    opened.push(layer);
  }

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floor, IDENTITY);
  renderer.drawMesh(post, STATIC_AT);
  renderer.drawMesh(post, PEEL_FRONT);
  renderer.drawMesh(post, PEEL_BEHIND);
  renderer.drawMesh(post, DYNAMIC_AT);
  renderer.endFrame();

  stats.textContent =
    `${created.backend} · ${created.reason} · layers ${opened.join(', ')} · ` +
    `left static · centre peel · right dynamic`;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
