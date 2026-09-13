/**
 * A frame that switches material more times than the WebGPU material ring holds.
 *
 * **Past `MAX_MATERIALS_PER_FRAME` the backend skips the draw**, which is a stretch of the world
 * simply not drawn. WebGL2 has no such ceiling and draws the lot, so the two backends disagree
 * about the same scene with nothing failing on either side — and the console line that was the
 * only signal said the draws would *reuse the last material*, which they never did.
 *
 * The rings grow now, at the start of the frame after one that ran out. So this page has two
 * pictures worth photographing and they are a frame apart:
 *
 *     /rings.html?quads=1200&frames=1&backend=webgpu   short by the overflow, once
 *     /rings.html?quads=1200&frames=3&backend=webgpu   whole, because the ring grew
 *     /rings.html?quads=1200&frames=3                  WebGL2, whole either way — the control
 *
 * **Every quad takes a material slot of its own**, which is what `drawTranslucentMesh` with
 * `lit: false` does: it dirties the block and restores it, so the cached slot is invalid on both
 * sides of the call and the next draw takes a fresh one. That is the shape a scene of many small
 * differently-shaded pieces has, and it is the shape the reporting consumer's world has.
 *
 * **Opaque quads on a grid, each a flat colour, no overlap.** A missing draw is then a hole of
 * exactly known area rather than a change of shade, so the check can count pixels rather than
 * compare them — and the count is comparable across backends, which a blended pile would not be.
 *
 * **The page counts its own lit pixels and publishes the number**, rather than leaving that to a
 * screenshot. A WebGPU canvas photographs black through CDP once the frame it was drawn in has
 * ended — measured here at 0 lit pixels against WebGL2's 194,646 for the identical scene, with the
 * engine's own budget confirming every quad had been drawn. Copying the canvas inside the same
 * animation frame, while its texture is still the current one, is what reads it honestly.
 *
 * Deterministic: one fixed camera, one fixed layout, no clock read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `batches.ts` and `volume.ts`.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Black, so every non-background pixel in the frame is a quad and the count is the picture. */
const CLEAR: Vec3 = [0, 0, 0];

/** How far apart the quads sit, in metres, and how big each one is. */
const PITCH = 1;
const HALF = 0.36;

function model(out: Float32Array, x: number, y: number): Float32Array {
  out.set(IDENTITY);
  out[12] = x;
  out[13] = y;
  out[14] = 0;
  return out;
}

/**
 * A colour per quad, bright and never black.
 *
 * Never black because the count is "pixels that are not the clear colour": a quad shaded to the
 * background would be indistinguishable from one that was never drawn, and the check would read a
 * defect as a colour choice.
 */
function tintFor(index: number, total: number): Vec3 {
  const t = (index + 0.5) / total;
  return [0.35 + 0.65 * t, 0.9 - 0.5 * t, 0.35 + (0.5 * ((index * 7) % 11)) / 11];
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const quads = Number(asked.get('quads') ?? '1200');
  const frames = Number(asked.get('frames') ?? '3');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* One mesh, drawn `quads` times. The ceiling under test counts material *changes*, not meshes,
     so a second mesh would prove nothing and a second material per draw is the whole point. */
  const quad: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [HALF, HALF, 0.05], [1, 1, 1]).build(),
  );

  const env = createEnvironment();
  env.directionalDir = [0.2, 0.94, 0.28];
  env.ambient = [1, 1, 1];
  env.directionalColor = [0, 0, 0];

  /* A square-ish grid, sized to the count so the framing holds whatever `quads` is asked for. */
  const columns = Math.ceil(Math.sqrt(quads));
  const rows = Math.ceil(quads / columns);
  const width = columns * PITCH;
  const height = rows * PITCH;

  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.4;
  camera.far = 400;
  camera.position[0] = 0;
  camera.position[1] = 0;
  /* Far enough back that the whole grid is in frame, with a margin so nothing clips the edge. */
  camera.position[2] = Math.max(width, height) * 1.15;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const scratch = new Float32Array(16);
  let budget = '';
  let covered = 0;

  /* The mirror the canvas is copied into, allocated once. Same size, so the count is a count of
     pixels and not of a resampling. */
  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  /**
   * How much of the frame is a quad rather than the clear colour.
   *
   * **Called inside the animation frame that drew it**, for the reason at the top of this file: a
   * WebGPU canvas has a current texture only until the frame ends, and a copy taken afterwards is
   * black. The threshold is well above the clear, which is exactly zero.
   */
  function measure(): number {
    if (mirrorCtx === null) return 0;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 24 || (data[i + 1] ?? 0) > 24 || (data[i + 2] ?? 0) > 24) lit += 1;
    }
    return lit;
  }

  /**
   * One frame per animation frame, rather than a loop.
   *
   * **Growth is a between-frames event and a swap chain is presented between frames**, so a
   * synchronous loop is wrong twice over: it is not what a consumer does, and on WebGPU the canvas
   * comes back black because nothing was ever presented. Measured — the first version of this page
   * drew its three frames in a `for` and photographed 0 lit pixels while the readout said every
   * quad had been drawn.
   */
  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (let i = 0; i < quads; i += 1) {
      const column = i % columns;
      const row = Math.floor(i / columns);
      const x = (column - (columns - 1) / 2) * PITCH;
      const y = (row - (rows - 1) / 2) * PITCH;
      /*
       * `lit: false` is what makes this a material change per draw rather than one for the whole
       * grid — see the note at the top. The tint is a per-draw vertex uniform and would not have
       * moved the material slot on its own.
       */
      renderer.drawTranslucentMesh(quad, model(scratch, x, y), 1, {
        lit: false,
        tint: tintFor(i, quads),
      });
    }
    renderer.endFrame();

    const lines = renderer.frameBudget.lines
      .filter((line) => line.dropped > 0)
      .map((line) => `${line.name} ${line.used}/${line.ceiling ?? '∞'} dropped ${line.dropped}`);
    budget = lines.length === 0 ? 'nothing dropped' : lines.join(' · ');
    covered = measure();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const tick = (): void => {
      frame();
      drawn += 1;
      if (drawn >= frames) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  stats.textContent =
    `${created.backend} · ${created.reason} · ${quads} quads · frame ${frames} · ` +
    `${covered} px lit · ${budget}`;
  (globalThis as unknown as { __budget?: string }).__budget = budget;
  (globalThis as unknown as { __covered?: number }).__covered = covered;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
