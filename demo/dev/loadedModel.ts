/**
 * A baked model drawn the way a newcomer draws one: `createRenderer` with no quality options, and
 * the loader's own `draw`, `casters`, `shadowFit` and `prepare`, nothing else.
 *
 *     /loadedModel.html                 the engine's defaults: the walls shade the nave, every
 *                                       repeated arch and column is there, the decals are grime
 *     /loadedModel.html?old=1           the defaults before 4.13.0, the control:
 *                                       dark, and the nave in full sun
 *     /loadedModel.html?src=/car.drft   any other baked model, fitted to a two metre box
 *
 * **Why it exists.** A benchmark that drew the same atrium in six engines, each from its own
 * manual, drew it right first time everywhere but here: dark, without wall shadows, with black
 * blotches on the stone, and seven changes from right. The page is that first attempt as the
 * engine now answers it, so a regression in any of the seven is a picture rather than a report.
 *
 * Held once the model is ready, prepared and drawn: `__drawn` is set then. Nothing under `src/`
 * may import this.
 */
import { DrftLoader } from '../../packages/assets/src/index';
import { spawnBcWorker } from '../../packages/assets/src/bcWorkers';
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { DrftFit } from '../../packages/assets/src/index';
import type { RenderQualityOptions, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const SOURCE = ASKED.get('src') ?? '/sponza-base-1024.drft';
/* The atrium is baked in metres where it stands; anything else is fitted to a box to look at. */
const FIT: DrftFit =
  ASKED.get('src') === null ? { fit: 'none' } : { footprint: 2, height: 2, baseY: 0 };
const CLEAR: Vec3 = [0.55, 0.68, 0.85];
/** The defaults until 4.13.0, which this page's control draws with: no encode, short shadows. */
const BEFORE_4_13: RenderQualityOptions = {
  outputTransform: 'none',
  directionalShadowMaxDistance: 6,
  directionalShadowMaxSlope: 3,
};
/* Drawn this many frames after `prepare` resolves, so the picture is a steady one. */
const SETTLE_FRAMES = 8;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(
    canvas,
    ASKED.get('old') === '1' ? BEFORE_4_13 : {},
    DEV_RENDERER,
  );
  const renderer = created.renderer;
  renderer.resize();

  /* A sun seventy degrees up, from the side, so the nave's walls throw their shadow across it. */
  const env = createEnvironment({
    directionalDir: [0.15, 0.94, 0.3],
    directionalColor: [1.6, 1.55, 1.45],
    ambient: [0.22, 0.24, 0.28],
    ambientGround: [0.1, 0.09, 0.08],
    nightFactor: 0,
    fogDensity: 0,
    shadowStrength: 0.9,
  });
  const lightMatrix = new Float32Array(16);
  env.lightViewProj = lightMatrix;

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.near = 0.1;
  camera.far = 200;
  const fitted = 'footprint' in FIT;
  if (fitted) {
    camera.position[0] = 2.4;
    camera.position[1] = 1.4;
    camera.position[2] = 2.4;
    camera.lookAt(0, 0.8, 0);
  } else {
    camera.position[0] = -11;
    camera.position[1] = 2;
    camera.position[2] = -0.4;
    camera.lookAt(10, 4, 0.4);
  }

  const loader = new DrftLoader(renderer, { bcWorker: spawnBcWorker });
  void loader.load(SOURCE, FIT);

  let prepared = false;
  let settled = -1;
  const frame = (): void => {
    loader.update(1 / 60);
    if (!prepared && loader.progress.phase === 'ready') {
      prepared = true;
      void loader.prepare().then(() => {
        settled = 0;
      });
    }
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    const span = loader.shadowFit(env.directionalDir, renderer.shadowMapSize, lightMatrix);
    if (span !== null) {
      env.shadowDepthSpan = span;
      renderer.beginShadowPass(lightMatrix, 'static');
      renderer.drawShadowCasters(loader.casters);
      renderer.endShadowPass();
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    const draws = loader.draw();
    renderer.endFrame();
    stats.textContent = `${created.backend} · ${loader.progress.phase} · ${draws} draws`;
    if (settled >= 0 && ++settled >= SETTLE_FRAMES) {
      (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
