/**
 * The sun's two shadow layers on squares of their own: the static layer over a wide stage, so
 * distant pillars keep their shadows, and the moving layer either on the same square or on a tight
 * one around the block that moves.
 *
 *     /sunLayers.html?moving=wide    the control: both layers drawn and read through the wide square
 *     /sunLayers.html?moving=tight   the moving layer drawn through six metres around the block, and
 *                                    read through the same, so its shadow is sharp where it falls
 *     /sunLayers.html?radius=200     the wide square at 400 m, its texels 20 cm, where the block's
 *                                    shadow on it is a blur and on the tight square is not
 *
 * **What is measured**: the pillars' shadows are the static layer's and must not move between the
 * two; the block's shadow must land in the same place in both, its edge sharper under the tight
 * square. Held at frame 60. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, ShadowCasters, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 60;
const SUN: Vec3 = [0.35, 0.8, 0.5];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const tight = ASKED.get('moving') === 'tight';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const ground = renderer.createMesh(
    new MeshBuilder()
      .addGroundQuad([-30, 0, -30], [30, 0, -30], [30, 0, 30], [-30, 0, 30], [0.6, 0.6, 0.58])
      .build(),
  );
  const pillar = renderer.createMesh(
    new MeshBuilder().addBox([0, 2, 0], [0.5, 2, 0.5], [0.7, 0.68, 0.62]).build(),
  );
  const block = renderer.createMesh(
    new MeshBuilder().addBox([0, 0.9, 0], [0.4, 0.9, 0.25], [0.75, 0.4, 0.3]).build(),
  );
  await renderer.ready();

  const wide = new Float32Array(16);
  const close = new Float32Array(16);
  const env = createEnvironment();
  env.directionalDir = SUN;
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.25, 0.27, 0.3];
  env.fogDensity = 0;
  env.shadowStrength = 1;
  env.lightViewProj = wide;
  const radius = Number(ASKED.get('radius') ?? '24');
  env.shadowDepthSpan = computeLightMatrix(SUN, 0, 0, 0, radius, renderer.shadowMapSize, wide);

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.position[0] = 4;
  camera.position[1] = 9;
  camera.position[2] = 12;
  camera.lookAt(-1, 0, -2);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const pillars = [
    [-14, -12],
    [12, -15],
    [-16, 6],
  ].map(([x, z]) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x ?? 0, 0, z ?? 0, 1]));
  const blockAt = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const still: ShadowCasters = (sink) => {
    for (const at of pillars) sink.mesh(pillar, at);
  };
  const moving: ShadowCasters = (sink) => sink.mesh(block, blockAt);

  let frame = 0;
  const draw = (): void => {
    /* The block walks a short line, so the moving layer has something to follow. */
    blockAt[12] = -1 + Math.sin(frame * 0.05) * 0.5;
    blockAt[14] = -2;
    computeLightMatrix(SUN, blockAt[12] ?? 0, 0.9, -2, 3, renderer.shadowMapSize, close);

    renderer.beginShadowPass(wide, 'static');
    renderer.drawShadowCasters(still);
    renderer.endShadowPass();
    renderer.beginShadowPass(tight ? close : wide, 'dynamic');
    renderer.drawShadowCasters(moving);
    renderer.endShadowPass();

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.drawMesh(ground, identity);
    for (const at of pillars) renderer.drawMesh(pillar, at);
    renderer.drawMesh(block, blockAt);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · moving layer ${tight ? 'tight' : 'wide'}`;
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
