/**
 * Does occlusion culling remove draws without removing pixels?
 *
 * **Those are the two halves and neither is evidence on its own.** A cull that removes nothing is a
 * feature that does not work; a cull that changes the picture is a hole in the world, which is
 * worse than no culling at all. So this page reports a count *and* draws the result, and the check
 * beside it compares both: the count must fall and the frame must be **identical**, pixel for
 * pixel, to the same scene with the buffer turned off.
 *
 *     /occlusion.html?backend=webgpu&occ=256
 *     /occlusion.html?backend=webgl2&occ=0      the control
 *
 * The scene is a wall with a field of boxes behind it and a few in front. The wall is declared as
 * an occluder; every box asks `renderer.occluded` before it draws. Boxes in front of the wall, past
 * its edges, and taller than it are all there on purpose — each of them is a cull that must not
 * happen, and each would show as a changed pixel rather than as a number.
 *
 * **What a failure looks like:**
 *
 *   - **`culled 0`** — no occluder reached the buffer, or `occlusionCulling` is off. Check the
 *     readout: it prints the width the renderer was built with.
 *   - **A changed pixel** — something visible was culled. That is the failure this page exists for,
 *     and the box that vanished says where the conservatism broke.
 *
 * Nothing here is engine API and nothing under `packages/*​/src` may import it.
 */
import {
  Camera,
  MeshBuilder,
  boundsOfPositions,
  createBounds,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The occluder, in world units: a wall standing across the view. */
const WALL_MIN = [-6, 0, -0.5];
const WALL_MAX = [6, 8, 0.5];

/** How many frames to draw before holding. Two, like `probe.html`, and for the same reason. */
const FRAMES = 2;

function translation(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * The boxes: a field behind the wall, and four that must survive whatever the buffer says.
 *
 * The four are the controls, and they are the reason this is a scene rather than a counter: one in
 * front of the wall, two past its edges at the depth of things it does hide, and one taller than it.
 * A cull that lost its conservatism takes one of those and the comparison sees it.
 */
function places(): { x: number; y: number; z: number; control: boolean }[] {
  const out: { x: number; y: number; z: number; control: boolean }[] = [];
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 12; column++) {
      out.push({
        x: (column - 5.5) * 0.9,
        y: 0.6 + row * 1.1,
        z: -4 - row * 2.6,
        control: false,
      });
    }
  }
  out.push({ x: 0, y: 1.2, z: 6, control: true });
  out.push({ x: -9.5, y: 2, z: -6, control: true });
  out.push({ x: 9.5, y: 2, z: -6, control: true });
  out.push({ x: 0, y: 9.4, z: -6, control: true });
  return out;
}

interface Result {
  backend: string;
  width: number;
  drawn: number;
  culled: number;
  controlsDrawn: number;
  error: string | null;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const width = Math.max(0, Math.round(Number(asked.get('occ') ?? '0') || 0));
  const drawAll = asked.get('draw') === 'all';

  const created = await createRenderer(
    canvas,
    { ...askedQuality(), occlusionCulling: width },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  await renderer.ready();

  const wall: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 4, 0], [6, 4, 0.5], [0.42, 0.44, 0.48]).build(),
  );
  /* One mesh, drawn many times: what is being culled is the draw rather than the geometry. */
  const cubeData = new MeshBuilder()
    .addBox([0, 0, 0], [0.35, 0.35, 0.35], [0.85, 0.6, 0.3], 0.6)
    .build();
  const cube: MeshHandle = renderer.createMesh(cubeData);
  /* The cube's own bounds, measured here rather than asked of the renderer: a mesh handle is
     opaque and `boundsOfPositions` is what built the renderer's copy in the first place. */
  const cubeBounds = createBounds();
  boundsOfPositions(cubeData.positions, cubeBounds);
  const models = places().map((p) => ({ ...p, model: translation(p.x, p.y, p.z) }));

  const env = createEnvironment({
    directionalDir: [0.35, 0.8, 0.5],
    directionalColor: [1, 0.97, 0.9],
    ambient: [0.2, 0.22, 0.26],
    ambientGround: [0.07, 0.07, 0.08],
    nightFactor: 0,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.2;
  camera.far = 120;
  camera.position[0] = 0;
  camera.position[1] = 4;
  camera.position[2] = 22;
  camera.lookAt(0, 4, 0);

  const result: Result = {
    backend: created.backend,
    width,
    drawn: 0,
    culled: 0,
    controlsDrawn: 0,
    error: null,
  };

  renderer.resize();
  /**
   * Draw the same frame, for ever.
   *
   * **Not two frames and a stop, which is what this page did first and what cost an afternoon.**
   * The camera never moves, so every frame is identical and a capture may land anywhere; a page
   * that stops leaves the browser compositing a canvas nobody is drawing into any more, and a
   * screenshot then catches however much of the last frame had reached the compositor. Measured:
   * `occ=0` against `occ=1` — a one-texel buffer that culls nothing and costs nothing — differed by
   * 74 pixels in an eight-by-ten block at one corner, and `occ=256` by 1,945 in a band spreading
   * out of the same corner. The difference scaled with the *time* the page spent, which is the tell.
   */
  const draw = (): void => {
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    renderer.beginFrame([0.05, 0.06, 0.09]);
    renderer.bindMeshPass(camera, env);
    /*
     * The occluder before the first draw, because the first test is what freezes the pyramid — and
     * the wall itself is drawn like anything else, since declaring a box is a claim about what may
     * hide behind it rather than an instruction to draw one.
     */
    renderer.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
    renderer.drawMesh(wall, IDENTITY);

    result.drawn = 0;
    result.culled = 0;
    result.controlsDrawn = 0;
    for (const place of models) {
      const hidden = renderer.occluded(cubeBounds, place.model);
      if (hidden) result.culled++;
      /*
       * `?draw=all` counts without acting, which is the control that separates *the buffer
       * existing* from *the draws being removed*. Two frames that differ under it differ for a
       * reason that has nothing to do with culling.
       */
      if (hidden && !drawAll) continue;
      if (!hidden) {
        result.drawn++;
        if (place.control) result.controlsDrawn++;
      }
      renderer.drawMesh(cube, place.model);
    }
    renderer.endFrame();
  };

  for (let frame = 0; frame < FRAMES; frame++) draw();
  (globalThis as unknown as { __occlusionCheck: Result }).__occlusionCheck = result;
  stats.textContent =
    `${result.backend} · occ ${result.width} · drawn ${result.drawn} · culled ${result.culled} · ` +
    `controls ${result.controlsDrawn} of 4`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
  const loop = (): void => {
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `occlusion failed:\n${String(error)}`;
  (globalThis as unknown as { __occlusionCheck: Result }).__occlusionCheck = {
    backend: 'none',
    width: 0,
    drawn: 0,
    culled: 0,
    controlsDrawn: 0,
    error: error instanceof Error ? error.message : String(error),
  };
});
