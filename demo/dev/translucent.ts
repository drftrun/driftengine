/**
 * `drawTranslucentMesh`'s unlit, unfogged mode, looked at on real hardware, on either backend.
 *
 * **The point of this page is that the difference is visible rather than asserted.** Task E1
 * added `{ lit, fog }` to `drawTranslucentMesh` so a translucent draw can read exactly its own
 * colour — three.js's `meshBasicMaterial`, which is what the homepage this engine is being
 * ported for is built out of. A compiling shader is not a correct one, and a uniform that reads
 * as "lit" and draws unlit is the expensive kind of wrong: it never fails a build.
 *
 * Two things, each aimed at one axis the task added:
 *
 *   - **Two identical plates, lit against light that never reaches their face.** Same mesh, same
 *     opacity, same placement; the left one is the plain call and takes the world's ambient and
 *     directional the way every translucent draw always has, the right one asks for `lit: false`.
 *     The directional source sits behind both plates on purpose, so the left one gets nothing
 *     from it and reads at ambient alone — near black — while the right one, unlit, reads exactly
 *     its authored colour regardless. If the branch in the shader were a no-op, the two would
 *     match; they do not.
 *   - **Three rows of chips marching into the distance, to show fog is a second axis and not a
 *     side effect of the first.** All three are small quads at the same series of depths under
 *     the same clear colour, which is set to the fog colour so a fogged surface visibly
 *     disappears into the background rather than merely dimming. Row 1 is unlit and left at its
 *     fog default (`{ lit: false }`) and fades out with distance. Row 2 is unlit and unfogged
 *     (`{ lit: false, fog: false }`) and stays exactly as bright at the far end as at the near
 *     one. Row 3 is lit and unfogged (`{ fog: false }`) — dimmer than Row 2 because lighting still
 *     runs, but just as flat across distance, which is what proves fog is not riding on `lit`.
 *
 *     /translucent.html                 the default backend, which is WebGL2
 *     /translucent.html?backend=webgpu  the other one
 *
 * Deterministic: one fixed light, one fixed camera, no clock read anywhere, so a two-capture
 * diff of an unchanged build reads zero.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `lines.ts` and `shadows.ts`.
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
/* The fog colour doubles as the clear colour, so a fogged surface visibly disappears into the
   background at range instead of merely dimming — the signature this page is built to show. */
const FOG_COLOR: Vec3 = [0.09, 0.1, 0.14];

/** A translation, written fresh each call — every mesh on this page is placed once. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** A dark, wide floor so the receding chips have a ground to sit on. */
function buildGround(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, -0.5, -40], [40, 0.5, 90], [0.05, 0.055, 0.07]).build();
}

/** A camera-facing plate, 4m by 2.5m, centred at the origin. See the two big panels below. */
function buildPlate(color: Vec3): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-2, -1.25, 0], [2, -1.25, 0], [2, 1.25, 0], [-2, 1.25, 0], color)
    .build();
}

/** One small floor tile for the receding rows, facing straight up. */
function buildChip(color: Vec3): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-0.55, 0, -0.55], [-0.55, 0, 0.55], [0.55, 0, 0.55], [0.55, 0, -0.55], color)
    .build();
}

/* How far apart the receding chips sit, and how many of them there are. Eight chips at 8m
   spacing reach 66m, comfortably past the point `FOG_DENSITY` below fogs a surface out. */
const CHIP_COUNT = 8;
const CHIP_SPACING_M = 8;
const CHIP_START_Z = -10;

/*
 * Extinction chosen so the near chip (10m) reads almost untouched and the far one (66m) is
 * most of the way to the fog colour — `1 - exp(-density * dist)` gives roughly 0.36 at 10m
 * and 0.95 at 66m. Strong enough that a screenshot shows the fogged row fading out without
 * needing a pixel sampler to confirm it.
 */
const FOG_DENSITY = 0.045;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Read this back rather than trusting `?backend=`: a browser with no usable WebGPU adapter
     falls back to WebGL2 silently, and this page's whole point is a same-backend comparison. */
  console.log(`[translucent] backend: ${created.backend} · ${created.reason}`);

  const env = createEnvironment({
    /*
     * Low, so the lit plate's ambient-only brightness reads as unmistakably dim rather than
     * merely dimmer — the comparison is meant to be legible from across a room.
     */
    ambient: [0.07, 0.075, 0.095],
    directionalColor: [1, 0.95, 0.85],
    /*
     * Mostly `-Z`: both plates face `+Z`, toward the camera, so a source pointing away from
     * them clamps `ndl` to zero and the lit plate takes ambient alone. This is not a subtle
     * angle chosen to produce a partial dimming — it is chosen so the lit plate gets *nothing*
     * from the sun, which is the starkest version of the same claim a grazing angle would make
     * more weakly.
     */
    directionalDir: [0.14, 0.33, -0.93],
    fogColor: FOG_COLOR,
    fogDensity: FOG_DENSITY,
  });

  const camera = new Camera();
  camera.fovYDeg = 52;
  camera.near = 0.3;
  camera.far = 110;
  camera.position[0] = 0;
  camera.position[1] = 3.4;
  camera.position[2] = 15;
  camera.lookAt(0, 1.2, -20);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const ground: MeshHandle = renderer.createMesh(buildGround());

  /* ---- Case 1: two identical plates, one lit, one not ---- */
  const PLATE_COLOR: Vec3 = [1, 0.55, 0.15];
  const litPlate: MeshHandle = renderer.createMesh(buildPlate(PLATE_COLOR));
  const unlitPlate: MeshHandle = renderer.createMesh(buildPlate(PLATE_COLOR));
  const PLATE_OPACITY = 0.9;
  const litPlateModel = at(-3.4, 2, -7);
  const unlitPlateModel = at(3.4, 2, -7);

  /* ---- Case 2: three rows receding into the fog colour ---- */
  const FOGGED_COLOR: Vec3 = [0.3, 0.85, 1];
  const UNFOGGED_UNLIT_COLOR: Vec3 = [1, 0.35, 0.85];
  const UNFOGGED_LIT_COLOR: Vec3 = [0.4, 0.95, 0.45];
  const foggedChip: MeshHandle = renderer.createMesh(buildChip(FOGGED_COLOR));
  const unfoggedUnlitChip: MeshHandle = renderer.createMesh(buildChip(UNFOGGED_UNLIT_COLOR));
  const unfoggedLitChip: MeshHandle = renderer.createMesh(buildChip(UNFOGGED_LIT_COLOR));

  const rowModels = (x: number): Float32Array[] => {
    const models: Float32Array[] = [];
    for (let i = 0; i < CHIP_COUNT; i++) {
      models.push(at(x, 0.02, CHIP_START_Z - i * CHIP_SPACING_M));
    }
    return models;
  };
  const foggedRow = rowModels(-2.4);
  const unfoggedUnlitRow = rowModels(0);
  const unfoggedLitRow = rowModels(2.4);

  renderer.beginFrame(FOG_COLOR);
  renderer.bindMeshPass(camera, env);
  /* One draw list, called on load and again on resize, so the two paths cannot drift apart —
     the failure mode a duplicated copy would invite. */
  function renderFrame(): void {
    renderer.beginFrame(FOG_COLOR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);

    /* The lit plate: the plain three-argument call, exactly as every translucent draw before
       this task drew. */
    renderer.drawTranslucentMesh(litPlate, litPlateModel, PLATE_OPACITY);
    /* The unlit plate: same mesh, same opacity, same placement, only `lit` differs. */
    renderer.drawTranslucentMesh(unlitPlate, unlitPlateModel, PLATE_OPACITY, { lit: false });

    for (const model of foggedRow) {
      renderer.drawTranslucentMesh(foggedChip, model, 1, { lit: false });
    }
    for (const model of unfoggedUnlitRow) {
      renderer.drawTranslucentMesh(unfoggedUnlitChip, model, 1, { lit: false, fog: false });
    }
    for (const model of unfoggedLitRow) {
      renderer.drawTranslucentMesh(unfoggedLitChip, model, 1, { fog: false });
    }

    renderer.endFrame();
  }

  renderFrame();
  stats.textContent = `${created.backend} · ${created.reason}`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
