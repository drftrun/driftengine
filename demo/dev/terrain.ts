/**
 * Two patches of one heightfield, drawn at different detail, meeting along a line.
 *
 * **A crack in terrain is a hole through to the sky, and this page is arranged so that is literally
 * true.** The seam is viewed from above and to one side, so a ray that finds a gap between the two
 * edges dives under the coarse patch — whose underside is culled — and leaves the world past its far
 * edge. The clear colour is magenta and nothing else in the scene is, so a crack is a magenta pixel
 * and the count is the whole measurement.
 *
 *     /terrain.html?stitch=0    the fine patch keeps the field along the seam, and cracks appear
 *     /terrain.html?stitch=1    it takes the coarse neighbour's chord instead, and they do not
 *
 * **The control is the pair**, and it is what stops this being vacuous: a scene with no cracks in
 * either case would prove nothing about matching, since there would be nothing to match.
 *
 * Flat-lit, one colour for both patches, no clock read anywhere. Everything that is not the seam is
 * held still.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `ssr.ts` and `decals.ts`.
 */

import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { Terrain, heightfieldPatch } from '../../packages/terrain/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Nothing in the scene is magenta, so a magenta pixel is a place the world is missing. */
const CLEAR: Vec3 = [1, 0, 1];
const GROUND: Vec3 = [0.45, 0.5, 0.38];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Samples across the field. One more than the cells, and the cells split evenly in two patches. */
const SIZE = 33;
/** How coarse the far patch is drawn, in field cells per drawn cell. */
const COARSE = 4;

/**
 * A field with enough relief that a coarse chord visibly sags below it.
 *
 * Two sines at different rates and one of them across the seam: a field that varied only along the
 * seam would have nothing for the chord to cut, and every step of the coarse patch would land on
 * the field by accident.
 */
function heights(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      out[z * SIZE + x] =
        Math.sin(x * 0.55) * 1.1 + Math.cos(z * 0.9) * 0.9 + Math.sin(x * 0.3 + z * 0.45) * 0.8;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const stitch = asked.get('stitch') !== '0';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const half = (SIZE - 1) / 2;
  const terrain = new Terrain({
    width: SIZE,
    depth: SIZE,
    spacingM: 1,
    heights: heights(),
    origin: [-half, 0, -half],
  });

  /*
   * **Four square patches, because the whole field has to be covered.** The frame is arranged so
   * that every pixel of it is terrain — that is what makes a magenta pixel a hole rather than the
   * edge of the world — and the first version of this page drew two patches over a quadrant and
   * measured the undrawn half as cracks.
   *
   * The two on the left are at full detail, the two on the right at a quarter of it, and only the
   * fine ones move: the coarse edge is the reference, which is what `neighbours` means.
   */
  const patches: MeshHandle[] = [];
  for (const z of [0, half]) {
    patches.push(
      renderer.createMesh(
        heightfieldPatch(terrain, {
          x: 0,
          z,
          cells: half,
          step: 1,
          color: GROUND,
          ...(stitch ? { neighbours: { plusX: COARSE } } : {}),
        }),
      ),
    );
    patches.push(
      renderer.createMesh(
        heightfieldPatch(terrain, { x: half, z, cells: half, step: COARSE, color: GROUND }),
      ),
    );
  }

  const env = createEnvironment();
  env.ambient = [1, 1, 1];
  env.directionalColor = [0, 0, 0];
  env.directionalDir = [0, 1, 0];

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.2;
  camera.far = 200;
  /* Above the seam and back along -x, so a ray through a gap dives under the coarse patch and
     leaves the world rather than landing on more terrain. */
  camera.position[0] = 11;
  camera.position[1] = 12;
  camera.position[2] = 0;
  camera.lookAt(-3, 0, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let cracks = 0;
  let ground = 0;
  let digest = '';

  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const empty = (i: number): boolean =>
      (data[i] ?? 0) > 200 && (data[i + 2] ?? 0) > 200 && (data[i + 1] ?? 0) < 100;

    /*
     * **Magenta above the ridgeline is sky and magenta below it is a hole**, and the difference is
     * the whole measurement. Rather than choosing a window by hand — which would have to be
     * re-chosen every time the camera moves — each column finds its own horizon: the first ground
     * pixel from the top. Everything empty after that is somewhere the world should have been.
     */
    let holes = 0;
    let solid = 0;
    let hash = 0x811c9dc5;
    for (let x = 0; x < mirror.width; x++) {
      let landed = false;
      for (let y = 0; y < mirror.height; y++) {
        const i = (y * mirror.width + x) * 4;
        if (empty(i)) {
          if (landed) holes += 1;
        } else {
          landed = true;
          solid += 1;
        }
      }
    }
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    cracks = holes;
    ground = solid;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (const patch of patches) renderer.drawMesh(patch, IDENTITY);
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
    `${created.backend} · ${created.reason} · stitch ${stitch ? 1 : 0} · ` +
    `${cracks} through · ${ground} ground · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__cracks'] = cracks;
  out['__ground'] = ground;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
