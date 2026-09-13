/**
 * One hard edge at a shallow angle, which is the geometry aliasing is worst on.
 *
 * **The question this page answers is whether an edge has intermediate pixels along it.** An
 * aliased edge is made of two colours and nothing between: every pixel is either the quad or the
 * background, and which one it is flips as the edge crosses a pixel centre — that flipping *is*
 * the crawl. A resolved edge has pixels part way between, because eight sub-pixel samples land on
 * both sides of it and the accumulation averages them.
 *
 * So the measurement is a count of pixels that are neither colour, and the control is the same
 * scene with the resolve off:
 *
 *     /taa.html?taa=0&frames=12            two colours, nothing between — the control
 *     /taa.html?taa=1&frames=12            an edge with a gradient along it
 *     /taa.html?taa=1&frames=12&backend=webgpu
 *
 * **The camera never moves**, and that is the strict version of the test rather than the lenient
 * one. A moving camera would let a blur of any kind produce intermediate pixels and pass; a still
 * camera produces them only if something is sampling the geometry at more than one position, which
 * is the jitter and nothing else. It also makes the page deterministic — no clock is read here.
 *
 * **The mean is reported beside the count** because an antialiased edge must not also be a
 * *displaced* one. The jitter sequence is centred so its period sums to zero; if it were not, the
 * resolved picture would sit a fraction of a pixel from where the unresolved one does and the
 * whole frame would change brightness slightly. Comparing the two means is what catches that.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `rings.ts` and `batches.ts`.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Black, so the background is one known colour and anything above it is the quad or an edge. */
const CLEAR: Vec3 = [0, 0, 0];

/**
 * A shallow angle, chosen because it is the worst case rather than a nice one.
 *
 * A vertical or horizontal edge lands on a pixel boundary and aliases barely at all; a 45 degree
 * edge aliases evenly. Something shallow puts a long run of pixels along each step of the
 * staircase, which is what makes the count large enough to be unambiguous.
 */
const TILT_DEGREES = 13;

/** The quad, big enough that its edges cross most of the frame. */
const HALF_X = 2.2;
const HALF_Y = 1.1;

/** A rotation about z, written out rather than pulled from a matrix library the demo need not import. */
function tilted(out: Float32Array, degrees: number): Float32Array {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  out.set([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '12');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const quad: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [HALF_X, HALF_Y, 0.05], [1, 1, 1]).build(),
  );

  /* Flat white on black: the two colours the count is measured between, with no shading gradient
     of its own that could be mistaken for an antialiased edge. */
  const env = createEnvironment();
  env.ambient = [1, 1, 1];
  env.directionalColor = [0, 0, 0];
  env.directionalDir = [0, 1, 0];

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.4;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 6;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const model = tilted(new Float32Array(16), TILT_DEGREES);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let intermediate = 0;
  let lit = 0;
  let mean = 0;

  /**
   * How many pixels are neither the background nor the surface, and how bright the frame is.
   *
   * **Called inside the animation frame that drew it**, because a WebGPU canvas has a current
   * texture only until the frame ends and a copy taken afterwards is black — measured on this
   * repository's own harness before this page existed.
   *
   * The thresholds are wide on purpose: 24 and 231 of 255 leave a generous band at each end, so a
   * pixel counts as intermediate only if it is properly between the two colours rather than one of
   * them off by a rounding step.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    let between = 0;
    let above = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      /* The green channel alone: the scene is grey, so it carries the same value as the other two
         and costs two fewer reads per pixel over a million of them. */
      const v = data[i + 1] ?? 0;
      sum += v;
      if (v > 24) above += 1;
      if (v > 24 && v < 231) between += 1;
    }
    intermediate = between;
    lit = above;
    mean = sum / (data.length / 4);
  }

  /**
   * One frame per animation frame rather than a loop.
   *
   * The resolve is a between-frames effect — the history is what the *last* presented frame left —
   * so a synchronous loop would measure one frame eight times. On WebGPU it would also photograph
   * black, nothing having been presented.
   */
  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    /* `(mesh, model, depthLayer, tint)` — the layer is a number and not an options bag, and
       passing one makes `depthOffsetForLayer` round an object: WebGPU rejects the resulting NaN
       depth bias outright and WebGL2 accepts it and offsets nothing. */
    renderer.drawMesh(quad, model, 0, [1, 1, 1]);
    renderer.endFrame();
    measure();
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
    `${created.backend} · ${created.reason} · frame ${frames} · ` +
    `${intermediate} px between · ${lit} px lit · mean ${mean.toFixed(4)}`;
  (globalThis as unknown as { __intermediate?: number }).__intermediate = intermediate;
  (globalThis as unknown as { __lit?: number }).__lit = lit;
  (globalThis as unknown as { __mean?: number }).__mean = mean;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
