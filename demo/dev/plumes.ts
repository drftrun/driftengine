/**
 * Every plume material this engine ships, drawn side by side, on either backend.
 *
 * **This page exists because a material can be added without ever being looked at.** The four
 * gates pass on a table entry: nothing under `src/` compiles a shader against a device, so a
 * material whose fragment block is a different size from its neighbours' is a green test suite
 * and a pipeline that will not build. `arcane` was exactly that — 144 bytes against a binding
 * declared at 128 — and the device's answer is a validation failure at `createRenderPipeline`,
 * which by the 2026-08-14 rule in `AGENTS.md` costs the whole command buffer rather than one
 * effect. No picture, from a frame that recorded correctly.
 *
 * So: one plume per material, at a fixed time, against a flat dark ground.
 *
 *     /plumes.html                 the default backend, which is WebGL2
 *     /plumes.html?backend=webgpu  the other one
 *
 * The two are meant to be compared. Neither is the reference for *quality* — see the parity
 * ledger — but a material present in one picture and absent from the other is a defect, and this
 * is the page that shows it at a glance.
 *
 * Deterministic without the held clock, because it does not read a clock at all: `TIME_SEC` is a
 * constant handed to `drawPlumes`, which takes the time to evaluate at rather than a step to
 * advance by. Two runs photograph the same pixels.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * in the harness, beside `probe.ts` and the held clock.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  PlumeHandle,
  PlumeMaterial,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Nothing moves here, so one matrix serves the only mesh draw the page makes. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The instant every plume is evaluated at.
 *
 * Arbitrary and fixed. Not zero: every material's noise is seeded off time, and at zero several
 * of them sit at the same phase, which photographs as three copies of one shape.
 */
const TIME_SEC = 7.25;

/**
 * One column per material, left to right, with the tint each is drawn with.
 *
 * **`arcane` is the only one that reads `uTint`**, which is why it is the only one given a
 * colour worth naming: an aura takes its scene's glow, and a tint that never arrived would leave
 * it black rather than merely wrong. Drawn additively for the same reason the other two split —
 * a flame and a spell are light, smoke is matter.
 */
const COLUMNS: readonly {
  readonly material: PlumeMaterial;
  readonly blend: 'additive' | 'alpha';
  readonly x: number;
  readonly tint?: Vec3;
}[] = [
  { material: 'fire', blend: 'additive', x: -4.2 },
  { material: 'smoke', blend: 'alpha', x: 0 },
  { material: 'arcane', blend: 'additive', x: 4.2, tint: [0.42, 0.76, 1] },
];

/** What the frame clears to. Dark, so an additive plume is unmistakably brighter than it. */
const CLEAR: Vec3 = [0.03, 0.035, 0.05];

/** A dark floor, so an additive plume has something to be brighter than. */
function buildGround(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, -0.25, 0], [14, 0.25, 14], [0.1, 0.11, 0.13]).build();
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
  const env = createEnvironment();
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 200;

  const plumes: PlumeHandle[] = COLUMNS.map((column) =>
    renderer.createPlumes([{ x: column.x, y: 0, z: 0, width: 1.3, height: 4.2 }], {
      material: column.material,
      blend: column.blend,
      sizePulse: 0.14,
      windResponse: 0.05,
      ...(column.tint === undefined ? {} : { tint: column.tint }),
    }),
  );

  renderer.resize();

  camera.position[0] = 0;
  camera.position[1] = 2.6;
  camera.position[2] = 13.5;
  camera.lookAt(0, 1.9, 0);
  const height = canvas.height;
  camera.updateMatrices(height > 0 ? canvas.width / height : 1);

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(ground, IDENTITY);
  for (const plume of plumes) renderer.drawPlumes(plume, camera, TIME_SEC, env);
  renderer.endFrame();

  /* Reported rather than inferred from the query: a browser without WebGPU, a device request
     that failed and a misspelt `?backend=` all fall back silently and draw a plausible frame. */
  stats.textContent = `${created.backend} · ${created.reason} · ${COLUMNS.map((c) => c.material).join(' ')}`;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
