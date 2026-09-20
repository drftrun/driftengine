/**
 * The two things a scene draws *over* the world: text, and an inset viewport.
 *
 * **Both were reported missing on WebGPU by the game**, which is the only place either had been
 * looked at on the second backend: no announcement text, and a transparent hole where the character
 * portrait and the display showcase draw their inset. Neither is a stub in `WebGPURenderer` and
 * neither fails to compile, so nothing anywhere reports them.
 *
 *     /overlay.html                 the default backend, which is WebGL2
 *     /overlay.html?backend=webgpu  the other one
 *
 * The page background is deliberately loud: an inset that punches through to it is a hole rather
 * than a dark box, and the two failures look identical in a screenshot otherwise.
 *
 * Deterministic: one fixed time, one fixed camera, and the frame is drawn once.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import { DEFAULT_TEXT_STYLE } from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, TextHandle, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const TIME_SEC = 3.5;

/** Something with an obvious silhouette, so an inset that draws nothing is obvious too. */
function buildBlock(color: Vec3): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addBox([0, 0.9, 0], [0.9, 0.9, 0.9], color)
    .addBox([0, -0.3, 0], [2.2, 0.25, 2.2], [0.16, 0.17, 0.2])
    .build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const world: MeshHandle = renderer.createMesh(buildBlock([0.55, 0.6, 0.7]));
  const insetMesh: MeshHandle = renderer.createMesh(buildBlock([1, 0.55, 0.15]));
  const label: TextHandle = renderer.createText();
  renderer.setText(label, 'RUIN FOUND');

  const env = createEnvironment();
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 200;

  renderer.resize();

  const aim = (): void => {
    camera.position[0] = 0;
    camera.position[1] = 2.4;
    camera.position[2] = 6.5;
    camera.lookAt(0, 0.9, 0);
    const h = canvas.height;
    camera.updateMatrices(h > 0 ? canvas.width / h : 1);
  };

  aim();
  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(world, IDENTITY);

  /*
   * The inset: a box on the right of the canvas, in CSS pixels, exactly as a menu screen hands
   * one over. `beginInset` reads the canvas' own bounding rect, so these are page coordinates.
   */
  const box = canvas.getBoundingClientRect();
  const rect = {
    left: box.left + box.width * 0.62,
    top: box.top + box.height * 0.16,
    width: box.width * 0.3,
    height: box.height * 0.42,
  };
  /*
   * **`?after=1` ends the frame first, which is what the game does.** A consumer draws its whole
   * interface after `endFrame` on purpose, so the interface escapes the screen-space post chain.
   * Both backends allow it: WebGL2 runs its commands eagerly against the canvas, and WebGPU's
   * `openPass` opens an overlay pass against the presented swap view with its own depth.
   *
   * **This comment used to say WebGPU drew neither, and being wrong about that is what hid a real
   * bug.** Under this flag WebGPU drew the text and the inset's clear and not the mesh inside the
   * inset, because the clearing quad wrote the near plane into a reversed depth buffer, which has
   * nothing to do with `endFrame` at all. The ordering had a documented explanation, so a missing
   * mesh read as expected behaviour to everybody who looked, including this file. Both backends
   * now draw all three under both flags.
   */
  const afterEndFrame = new URLSearchParams(location.search).get('after') === '1';
  if (afterEndFrame) renderer.endFrame();
  renderer.beginInset(rect, [0.02, 0.16, 0.1]);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(insetMesh, IDENTITY);
  renderer.endInset();

  /*
   * **`?ladder=1` draws one line per cell size instead of one line at seven**, which is the
   * control a report of "small text is eaten away and large text is not" needs. A consumer sizes
   * a quiet second line off its headline and floors it at three pixels, so the sizes worth seeing
   * are 3 to 12 — and the whole claim is that the *size* is what decides, which cannot be shown
   * by a page that draws one.
   *
   * `?alpha=` is the other half of the pair, because the competing explanation is a fade: the
   * consumer's two lines differ by a tenth of an alpha and by a factor of two in cell size, and
   * only a page that can move each on its own says which one the artefact follows.
   */
  const asked = new URLSearchParams(location.search);
  const ladder = asked.get('ladder') === '1';
  const textAlpha = Number(asked.get('alpha') ?? '1');
  const cell = Number(asked.get('cell') ?? '7');
  /*
   * **The three motion terms, because each one moves a cell by a fraction of a pixel.** A consumer
   * holds a settled message with an idle bob on it, and a bitmap face whose strokes are one cell
   * wide has nothing to spare: a cell offset by half a pixel either covers a row of pixels or does
   * not. Whether that is what eats a small line is a question about `bob` alone, so `bob` alone is
   * what this moves.
   */
  const bob = Number(asked.get('bob') ?? '0');
  const spin = Number(asked.get('spin') ?? '0');
  const punch = Number(asked.get('punch') ?? '0');
  const reveal = Number(asked.get('reveal') ?? '1');

  /* Text last, over everything, the way an announcement is drawn. */
  renderer.bindMeshPass(camera, env);
  if (ladder) {
    for (let size = 3; size <= 12; size++) {
      renderer.setText(label, 'RUIN FOUND');
      renderer.drawText(
        label,
        canvas.width,
        canvas.height,
        Math.round(canvas.width * 0.04),
        Math.round(canvas.height * 0.08 + (size - 3) * canvas.height * 0.085),
        {
          ...DEFAULT_TEXT_STYLE,
          cellSize: size,
          color: [1, 0.85, 0.2],
          glow: 1,
          alpha: textAlpha,
          reveal,
          spin,
          punch,
          bob,
        },
        TIME_SEC,
      );
    }
  } else {
    renderer.drawText(
      label,
      canvas.width,
      canvas.height,
      Math.round(canvas.width * 0.06),
      Math.round(canvas.height * 0.5),
      {
        ...DEFAULT_TEXT_STYLE,
        cellSize: cell,
        color: [1, 0.85, 0.2],
        glow: 1,
        alpha: textAlpha,
        reveal,
        spin,
        punch,
        bob,
      },
      TIME_SEC,
    );
  }
  if (!afterEndFrame) renderer.endFrame();

  stats.textContent =
    `${created.backend} · ${created.reason} · text "RUIN FOUND" + inset` +
    ` · cell ${ladder ? '3..12' : cell} · alpha ${textAlpha} · bob ${bob} · spin ${spin} · punch ${punch} · reveal ${reveal}` +
    (afterEndFrame ? ' · drawn after endFrame' : '');
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
