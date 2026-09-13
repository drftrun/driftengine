/**
 * Two translucent panes that intersect, drawn in either submission order.
 *
 * **Sorted alpha blending cannot draw this correctly and no sort can fix it.** `over` does not
 * commute, so the frame depends on which pane was submitted first — and where two panes *intersect*
 * there is no back-to-front order at all: each is in front of the other over part of the screen.
 * A consumer meeting this reaches for a better sort, which cannot help, and then for splitting the
 * geometry, which is a modelling change to work around a renderer.
 *
 * So this page draws the same two panes twice over, in both orders:
 *
 *     /oit.html?oit=0&order=ab      sorted blending, one order
 *     /oit.html?oit=0&order=ba      sorted blending, the other — a *different picture*
 *     /oit.html?oit=1&order=ab      weighted blending
 *     /oit.html?oit=1&order=ba      weighted blending — the *same picture*
 *
 * **The control is the pair with the effect off**, and it is what stops this test being vacuous: if
 * those two frames were already identical the scene would not be order-dependent, and the pair with
 * it on would prove nothing at all. `scripts/oit-check.mjs` asserts both halves.
 *
 * **`&samples=4` is the third case, and it is a refusal rather than a picture.** Multisampling
 * excludes the effect on both backends — the two passes attach the scene target's own depth and a
 * multisampled frame is not drawn into that texture — so that profile draws the *sorted* pair, and
 * the two orders differ again. It says so once on the console. `askedQuality` has carried the flag
 * all along; it is named here because for two releases WebGL2 took the unguarded path and drew
 * weighted blending against the previous frame's depth while WebGPU sorted.
 *
 * **Opaque backdrop, black clear, flat unlit panes.** A lit pane would change with the sun's angle
 * between runs and a textured one with filtering; what is being compared is two frames of the same
 * scene, so everything that is not the ordering is held still. No clock is read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `taa.ts` and `rings.ts`.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0, 0, 0];

/** How solid each pane is. Half, so both contribute and neither hides the other. */
const OPACITY = 0.5;

/**
 * A rotation about y, so the two panes cross rather than stack.
 *
 * **Crossing is the whole point.** Two parallel panes have a correct back-to-front order and a
 * sort would find it; two that intersect do not have one, which is the case sorted blending cannot
 * answer however hard it sorts.
 */
function turned(out: Float32Array, degrees: number, x: number, z: number): Float32Array {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  out.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1]);
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const order = asked.get('order') ?? 'ab';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* A tall thin slab: wide enough to fill much of the frame, thin enough that the two read as
     panes crossing rather than as boxes overlapping. */
  const pane: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [1.6, 1.1, 0.02], [1, 1, 1]).build(),
  );

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

  /* Two panes turned opposite ways about y and offset in z, so they intersect near the middle of
     the frame: over the left of the screen one is nearer, over the right the other is. */
  const a = turned(new Float32Array(16), 32, -0.35, 0.35);
  const b = turned(new Float32Array(16), -32, 0.35, -0.35);
  const RED: Vec3 = [1, 0.15, 0.15];
  const BLUE: Vec3 = [0.15, 0.35, 1];

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let lit = 0;
  let digest = '';

  /**
   * A digest of the canvas, and the lit count beside it.
   *
   * **Of the canvas rather than of a screenshot, and that is not a detail.** The first version of
   * this check compared the two screenshots and found 120 differing pixels in a sixteen-by-eleven
   * patch at the bottom left — which turned out to be the stats line below, reading `order ab`
   * against `order ba`. The render was already identical; the instrument was comparing its own
   * caption. A digest taken from the canvas cannot make that mistake.
   *
   * FNV-1a over every byte: order-independence is an exact claim, so what is compared has to be
   * exact rather than a threshold somebody chose.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    let above = 0;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r > 12 || g > 12 || b > 12) above += 1;
      hash = Math.imul(hash ^ r, 0x01000193);
      hash = Math.imul(hash ^ g, 0x01000193);
      hash = Math.imul(hash ^ b, 0x01000193);
    }
    lit = above;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    /* The only difference between the two runs, and the whole subject of the test. */
    if (order === 'ba') {
      renderer.drawTranslucentMesh(pane, b, OPACITY, { lit: false, tint: BLUE });
      renderer.drawTranslucentMesh(pane, a, OPACITY, { lit: false, tint: RED });
    } else {
      renderer.drawTranslucentMesh(pane, a, OPACITY, { lit: false, tint: RED });
      renderer.drawTranslucentMesh(pane, b, OPACITY, { lit: false, tint: BLUE });
    }
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

  stats.textContent = `${created.backend} · ${created.reason} · order ${order} · ${lit} px lit · ${digest}`;
  (globalThis as unknown as { __digest?: string }).__digest = digest;
  (globalThis as unknown as { __lit?: number }).__lit = lit;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
