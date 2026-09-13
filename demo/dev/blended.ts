/**
 * How a *set* of blended surfaces resolves against itself, looked at on real hardware.
 *
 * **The page exists because the failure is a photograph and not a number.** A consumer importing
 * vehicles reported a car drawn as interpenetrating shards, with its dashboard showing through its
 * bonnet: a quarter of that model's materials declare a blend, and 96 of them are interior
 * surfaces sitting inside the shell. Every check it had was green. Two separate mechanisms are at
 * work in that picture and they need different answers, so both are here side by side.
 *
 *   - **Left, nested panels.** Four blended panels at four depths inside an open shell, submitted
 *     deliberately near-to-far — the order a model's own material groups arrive in, which has
 *     nothing to do with where the camera is. A blended draw writes depth, so the near panel
 *     claims it and the three behind it are *rejected*: the set draws as one panel where it should
 *     read as four sheets of tinted glass. `?depthwrite=0` stops them claiming depth; `?sort=1`
 *     submits them far-to-near. **Both are needed** and the page is built to show that: without
 *     depth writing but in the wrong order the panels blend in submission order and the far ones
 *     paint over the near one, which is a different wrong picture. This is the cost that keeps
 *     `depthWrite` an option rather than a default.
 *
 *   - **Right, a coplanar decal.** A blended quad in exactly the plane of the opaque panel it
 *     decorates, which is what a model's interior decal layer is. Coplanar surfaces have equal
 *     depth in exact arithmetic, so no ordering separates them and no depth format resolves them:
 *     which one survives is decided per pixel by which way the rounding fell. `?layer=1` declares
 *     the decal the higher layer. **The two backends disagree here before the flag and agree
 *     after it**, which is the second thing this page is for: WebGL2's blended draw admits the
 *     equal case and WebGPU's rejects it, so the same scene draws the decal patchy on one and
 *     absent on the other.
 *
 *     /blended.html                       the default backend, which is WebGL2
 *     /blended.html?backend=webgpu        the other one
 *     /blended.html?depthwrite=0&sort=1   the nested panels, answered
 *     /blended.html?layer=1               the decal, answered
 *
 * Deterministic: one fixed light, one fixed camera, no clock read anywhere, so a two-capture diff
 * of an unchanged build reads zero.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `translucent.ts` and `shadows.ts`.
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
const BACKDROP: Vec3 = [0.05, 0.06, 0.08];

/** A translation, written fresh each call — every mesh on this page is placed once. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

const params = new URLSearchParams(location.search);
const flag = (name: string): boolean => params.get(name) === '1';
/** Depth writing is on unless the page is told otherwise, which is the engine's own default. */
const depthWrite = params.get('depthwrite') !== '0';
const sorted = flag('sort');
/* A number, not a flag: the point of the right-hand case is how far a declared layer has to push
   before a coplanar surface stops fighting, and the two backends had to be asked that separately. */
const decalLayer = Math.max(0, Math.round(Number(params.get('layer') ?? 0)) || 0);

/** A camera-facing quad. */
function quad(width: number, height: number, color: Vec3): ReturnType<MeshBuilder['build']> {
  const w = width / 2;
  const h = height / 2;
  return new MeshBuilder().addQuad([-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0], color).build();
}

/**
 * The shell the nested panels sit inside: a floor, a back wall and two sides, all opaque.
 *
 * Open toward the camera on purpose. The reported model is an interior seen through a windscreen,
 * and what matters is that the blended set is *inside* something solid — so the shell has to be
 * drawn and has to be opaque, or the panels would be blending against the backdrop alone and the
 * picture would not be the reported one.
 */
function buildShell(): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  const grey: Vec3 = [0.16, 0.17, 0.19];
  /* Floor, back wall and a left wall. **No right wall and no roof**: the camera sits off to the
     right of the opening, and a fourth side would stand between it and the thing being
     photographed, which is a picture of an occluder and not of the panels behind it. */
  builder.addBox([0, -0.1, -2], [3.6, 0.2, 4.6], grey);
  builder.addBox([0, 1.5, -4.3], [3.6, 3.2, 0.2], grey);
  builder.addBox([-1.8, 1.5, -2], [0.2, 3.2, 4.6], grey);
  return builder.build();
}

/** Four panels, near to far, in four colours a photograph can tell apart. */
const PANEL_COLORS: readonly Vec3[] = [
  [0.25, 0.55, 1],
  [1, 0.4, 0.35],
  [0.4, 1, 0.5],
  [1, 0.85, 0.25],
];
const PANEL_Z: readonly number[] = [-0.6, -1.4, -2.2, -3];
const PANEL_OPACITY = 0.55;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it. On WebGPU the two options
     this page exercises are pipeline state, so a draw that opts in compiles on its first frame —
     which is exactly why this page awaits `ready()` and then draws twice below. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Read back rather than trusting `?backend=`: a browser with no usable WebGPU adapter falls
     back to WebGL2 silently, and this page's whole point is a per-backend comparison. */
  console.log(`[blended] backend: ${created.backend} · ${created.reason}`);

  const env = createEnvironment({
    ambient: [0.24, 0.25, 0.28],
    directionalColor: [1, 0.97, 0.9],
    directionalDir: [0.3, 0.6, 0.74],
    fogColor: BACKDROP,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  /* Off the axis by enough that the four panels read as four sheets and not as one, and shallow
     enough that the whole depth of the set stays inside the opening. */
  camera.position[0] = 2.6;
  camera.position[1] = 2.2;
  camera.position[2] = 5.8;
  camera.lookAt(1.1, 1.35, -1.8);

  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  const shell: MeshHandle = renderer.createMesh(buildShell());
  const panels: MeshHandle[] = PANEL_COLORS.map((color) =>
    renderer.createMesh(quad(2.4, 2, color)),
  );
  const panelModels = PANEL_Z.map((z) => at(0, 1.4, z));

  /* The decal case: an opaque panel, and a smaller blended quad in exactly its plane. */
  const DECAL_PLANE_Z = -1.2;
  const board: MeshHandle = renderer.createMesh(quad(2.6, 2.2, [0.35, 0.36, 0.4]));
  const decal: MeshHandle = renderer.createMesh(quad(1.5, 1.1, [1, 0.5, 0.1]));
  const boardModel = at(4.4, 1.4, DECAL_PLANE_Z);
  const decalModel = at(4.4, 1.4, DECAL_PLANE_Z);

  function renderFrame(): void {
    renderer.beginFrame(BACKDROP);
    renderer.bindMeshPass(camera, env);

    renderer.drawMesh(shell, IDENTITY);
    renderer.drawMesh(board, boardModel);

    /*
     * Near to far unless the page is asked to sort, because that is the order the reported
     * defect arrives in: a model's parts are submitted in the order the file stores them, which
     * is a fact about the exporter and not about where the camera is standing.
     */
    const order = panels.map((_, i) => i);
    if (sorted) order.reverse();
    for (const i of order) {
      renderer.drawTranslucentMesh(
        panels[i] as MeshHandle,
        panelModels[i] as Float32Array,
        PANEL_OPACITY,
        { depthWrite },
      );
    }

    /* Coplanar with the board, and declared over it only when the flag says so. */
    renderer.drawTranslucentMesh(decal, decalModel, 0.999, { depthLayer: decalLayer });

    renderer.endFrame();
  }

  renderFrame();
  stats.textContent = `${created.backend} · depthWrite=${depthWrite} sort=${sorted} decalLayer=${decalLayer}`;

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
