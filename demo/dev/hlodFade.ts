/**
 * The screen-door crossfade's one promise: two draws at `t` and `-t` cover every pixel once.
 *
 *     /hlodFade.html?t=0.3                 the default backend
 *     /hlodFade.html?t=0.3&backend=webgl2  the other one
 *     /hlodFade.html?t=0.3&instanced=1     the same through instanced batches
 *     /hlodFade.html?t=0                   the control: dither off, one red box
 *     /hlodFade.html?t=0&opacity=0.4       one instance at opacity 0.4 under `setDitherOpacity`:
 *                                          red on 0.4 of the box, the clear colour on the rest
 *     /hlodFade.html?t=0.3&opacity=0.6     both: red on 0.3, blue on 0.3, clear on 0.4, so the
 *                                          crossfade covers the instance's share once
 *
 * One box drawn twice at the same place: red at `setDitherFade(t)`, blue at `setDitherFade(-t)`.
 * Unlit by construction — ambient white, no sun — so a pixel is red, blue or the clear colour and
 * nothing in between, and a script counting the photograph can read the three off exactly.
 *
 * **What a failure looks like**: the clear colour showing through the box (a hole — the two
 * patterns are not complements), purple (both kept one pixel, which blending off would hide, so
 * it shows as whichever drew last and is caught by the share instead), or a red share away from
 * `t` by more than one cell of 64.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  const t = Number(query.get('t') ?? '0.3');
  /* An instance's own opacity, spent on the screen door; implies instanced batches. */
  const opacity = query.get('opacity') === null ? null : Number(query.get('opacity'));
  const instanced = query.get('instanced') === '1' || opacity !== null;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const box = (colour: Vec3): MeshHandle =>
    renderer.createMesh(new MeshBuilder().addBox([0, 0, 0], [1, 0.6, 0.2], colour).build());
  const red = box([1, 0, 0]);
  const blue = box([0, 0, 1]);
  const one = createMeshInstances(1);
  one.models.set(IDENTITY);
  one.tints.fill(1);
  if (opacity !== null) one.alphas?.fill(opacity);
  one.count = 1;
  const redBatch = renderer.createInstanced(red, 1);
  const blueBatch = renderer.createInstanced(blue, 1);
  renderer.uploadInstanced(redBatch, one);
  renderer.uploadInstanced(blueBatch, one);

  const env = createEnvironment();
  env.directionalColor = [0, 0, 0];
  env.ambient = [1, 1, 1];
  env.ambientGround = [1, 1, 1];

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 4;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setDitherOpacity(opacity !== null);
    renderer.setDitherFade(t);
    if (instanced) renderer.drawInstanced(redBatch, one);
    else renderer.drawMesh(red, IDENTITY);
    if (t !== 0) {
      renderer.setDitherFade(-t);
      if (instanced) renderer.drawInstanced(blueBatch, one);
      else renderer.drawMesh(blue, IDENTITY);
    }
    renderer.setDitherFade(0);
    renderer.setDitherOpacity(false);
    renderer.endFrame();
    frame += 1;
    stats.textContent =
      `${created.backend} · t ${t} · ${instanced ? 'instanced' : 'meshes'}` +
      (opacity === null ? '' : ` · opacity ${opacity}`);
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
