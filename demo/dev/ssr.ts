/**
 * Two identical objects over one floor, and only half the floor reflects.
 *
 * **The control is built into the scene rather than bolted onto the test.** Both blocks are the
 * same mesh, the same colour, the same height and the same distance from the camera; the only
 * difference between them is that a `ReflectiveSurface` covers the floor under one and not under
 * the other. So a reflection appearing under the left block and not the right one cannot be the
 * lighting, the geometry or the camera — it is the region, which is the whole of what this API
 * claims.
 *
 *     /ssr.html?ssr=0     no surface submitted at all, and the floor is bare under both
 *     /ssr.html?ssr=1     the left half of the floor reflects
 *     /ssr.html?ssr=1&lift=1   the blocks rise, and their reflections move away from them
 *     /ssr.html?ssr=1&fx=0     no off-screen target, so nothing to march against
 *
 * **Dark floor, bright blocks, flat light, no clock read anywhere.** A reflection is a fraction of
 * what it reflects, so the floor has to be dark enough for that fraction to show, and everything
 * that is not the reflection is held still.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `decals.ts` and `oit.ts`.
 */

import {
  Camera,
  MeshBuilder,
  ReflectiveSurface,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0.02, 0.025, 0.04];
/** Dark, so a reflection of something bright is unmistakable against it. */
const FLOOR: Vec3 = [0.12, 0.12, 0.13];
/** Green, because nothing else in the scene is: one channel test classifies every pixel. */
const BLOCK: Vec3 = [0.08, 1, 0.2];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const reflect = asked.get('ssr') !== '0';
  const lift = Number(asked.get('lift') ?? '0');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addGroundQuad([-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5], FLOOR).build(),
  );
  /* One mesh for both blocks, drawn twice: same geometry, same colour, same everything but where
     they stand. A second mesh would be a second thing that could differ. */
  const block: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.6, 0.6, 0.6], BLOCK).build(),
  );

  const at = (x: number): Float32Array => {
    const m = new Float32Array(IDENTITY);
    m[12] = x;
    m[13] = 0.6 + lift;
    m[14] = 0;
    return m;
  };
  const left = at(-2);
  const right = at(2);

  /*
   * The reflective region: the left half of the floor, and a slab thin enough in `y` to contain
   * the floor and nothing else. A box reaching up to the blocks would make their own top faces
   * reflective, which is a real thing to want and not what this page is measuring.
   */
  const surface = new ReflectiveSurface({
    center: [-2.5, 0, 0],
    halfExtents: [2.5, 4.5, 0.3],
    forward: [0, -1, 0],
    up: [0, 0, 1],
    strength: 0.7,
    reachM: 10,
  });

  const env = createEnvironment();
  env.ambient = [1, 1, 1];
  env.directionalColor = [0, 0, 0];
  env.directionalDir = [0, 1, 0];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.4;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 2.4;
  camera.position[2] = 8;
  camera.lookAt(0, 0.9, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let reflectedLeft = 0;
  let reflectedRight = 0;
  let objectPixels = 0;
  let reflectU = 0;
  let reflectV = 0;
  let digest = '';

  /**
   * What the frame contains, counted from the canvas rather than from a screenshot.
   *
   * **Green-dominant and dim is a reflection; green-dominant and bright is a block.** Nothing else
   * in the scene has any green in it, so one channel comparison separates the three things on
   * screen without a threshold anybody has to defend. `oit.ts` records why the count comes off the
   * canvas rather than out of a screenshot: the first version of that check was comparing its own
   * caption.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    let nearer = 0;
    let further = 0;
    let blocks = 0;
    let sumU = 0;
    let sumV = 0;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (g > r + 15 && g > b + 10) {
        if (g > 180) blocks += 1;
        else if (g > 30) {
          const pixel = i / 4;
          const x = pixel % mirror.width;
          if (x < mirror.width / 2) nearer += 1;
          else further += 1;
          sumU += x;
          sumV += Math.floor(pixel / mirror.width);
        }
      }
      hash = Math.imul(hash ^ r, 0x01000193);
      hash = Math.imul(hash ^ g, 0x01000193);
      hash = Math.imul(hash ^ b, 0x01000193);
    }
    reflectedLeft = nearer;
    reflectedRight = further;
    objectPixels = blocks;
    const total = nearer + further;
    reflectU = total === 0 ? 0 : sumU / total;
    reflectV = total === 0 ? 0 : sumV / total;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, IDENTITY);
    renderer.drawMesh(block, left);
    renderer.drawMesh(block, right);
    if (reflect) renderer.drawReflection(surface);
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
    `${created.backend} · ${created.reason} · ssr ${reflect ? 1 : 0} · lift ${lift} · ` +
    `${reflectedLeft} left · ${reflectedRight} right · ${objectPixels} block · ` +
    `${reflectU.toFixed(1)},${reflectV.toFixed(1)} · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__reflectedLeft'] = reflectedLeft;
  out['__reflectedRight'] = reflectedRight;
  out['__object'] = objectPixels;
  out['__reflectU'] = reflectU;
  out['__reflectV'] = reflectV;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
