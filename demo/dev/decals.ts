/**
 * One mark on one floor, and the floor deforms under it.
 *
 * **This is the difference between the two halves of decals, drawn as a picture.** `projectDecal`
 * clips the receiving surface's own triangles to a projector box and hands back a mesh: exact,
 * free every frame afterwards, and built against the surface *as it stood*. `drawDecal` keeps the
 * projector alive and decides the mark from the frame's own depth buffer instead. On a floor that
 * never moves the two agree; on a floor that then deforms, only one of them is still on it.
 *
 *     /decals.html?mark=none&phase=flat     the floor, unmarked, and the baseline for the sky count
 *     /decals.html?mark=static&phase=flat   projectDecal, on the surface it was clipped from
 *     /decals.html?mark=static&phase=wave   the same mesh, now buried under a floor that rose
 *     /decals.html?mark=drawn&phase=flat    the projector, on the same floor
 *     /decals.html?mark=drawn&phase=wave    the projector, on the floor that rose — still on it
 *     /decals.html?mark=drawn&fx=0         no off-screen target, so no depth and no mark at all
 *
 * **The control is the static pair**, and it is what stops this being vacuous: if a clipped decal
 * survived the deformation there would be nothing for the drawn one to be for.
 *
 * **The floor rises rather than waving about zero**, and that is the whole design of the scene. A
 * wave through the old surface leaves half the clipped mark buried and half of it floating, which
 * halves a count and reads as noise; a floor that only ever rises puts every triangle of the
 * clipped mark inside the new surface, so the count goes to nothing and the failure is unambiguous.
 *
 * **The projector hangs over the floor's edge on purpose.** Its scissor rectangle therefore covers
 * pixels showing no surface at all, and a pass that painted its rectangle rather than what the
 * depth buffer holds would tint the background. The sky count against `mark=none` is what asserts
 * it does not.
 *
 * Flat-lit, white floor, no clock read anywhere: everything that is not the mark is held still, so
 * two frames of this scene differ only in what is being compared.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `oit.ts` and `taa.ts`.
 */

import {
  Camera,
  DecalProjector,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  projectDecal,
} from '../../packages/core/src/index';
import type { MeshData, MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Dark enough that the floor and the mark are both unmistakable against it. */
const CLEAR: Vec3 = [0.02, 0.03, 0.08];
/** White, so a red multiply reads as red and an unmarked pixel reads as white. */
const FLOOR: Vec3 = [1, 1, 1];
/** What the mark is. Both halves take the same colour, so one classifier reads either. */
const MARK: Vec3 = [1, 0.25, 0.25];

const HALF = 2;
const CELLS = 40;
/** Where the floor sits when it is flat, above zero so the clipped mark has somewhere to be. */
const BASE = 0.02;
/** How far the floor rises at a crest. Gentle: the point is the deformation, not a steep wall. */
const RISE = 0.25;
const WAVELENGTH = 1.8;
/**
 * How far the whole floor lifts as well as waving, and it is here because of a measurement.
 *
 * **A wave alone leaves a band of the clipped mark alive at every trough.** `projectDecal` lifts
 * its mark 2 mm off the surface along the normal, so wherever the risen floor comes back to within
 * 2 mm of where it was — which a cosine does, exactly, at every trough — the clipped mark is still
 * above it and still drawn. Measured at 8,998 px of 94,736, which is a fact about a cosine rather
 * than about decals, and it made the control read as a partial failure.
 *
 * 50 mm clears that lift twenty-five times over, so the floor rises *everywhere* and a mark
 * clipped from the flat one is buried everywhere.
 */
const LIFT = 0.05;

/** The floor's height and slope at one x, flat or risen. */
function surface(x: number, risen: boolean): { y: number; slope: number } {
  if (!risen) return { y: BASE, slope: 0 };
  const phase = (2 * Math.PI * x) / WAVELENGTH;
  return {
    y: BASE + LIFT + (RISE * (1 - Math.cos(phase))) / 2,
    slope: ((RISE * Math.PI) / WAVELENGTH) * Math.sin(phase),
  };
}

/**
 * The floor, as a grid of ground quads.
 *
 * Built by the same code for both phases, so the vertex order is identical and `updateMesh` can
 * rewrite the positions of the mesh already on the GPU — which is the deformation this page is
 * about, rather than a second mesh standing in for one.
 */
function floorData(risen: boolean): MeshData {
  const builder = new MeshBuilder();
  const step = (2 * HALF) / CELLS;
  for (let iz = 0; iz < CELLS; iz++) {
    for (let ix = 0; ix < CELLS; ix++) {
      const x0 = -HALF + ix * step;
      const x1 = x0 + step;
      const z0 = -HALF + iz * step;
      const z1 = z0 + step;
      const y0 = surface(x0, risen).y;
      const y1 = surface(x1, risen).y;
      builder.addGroundQuad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], FLOOR);
    }
  }
  return builder.build();
}

/** The waved floor's normals, analytic rather than faceted, so the shading does not step. */
function smoothNormals(data: MeshData, risen: boolean): Float32Array {
  const normals = new Float32Array(data.normals.length);
  for (let v = 0; v < data.positions.length; v += 3) {
    const { slope } = surface(data.positions[v] ?? 0, risen);
    const length = Math.hypot(slope, 1);
    normals[v] = -slope / length;
    normals[v + 1] = 1 / length;
    normals[v + 2] = 0;
  }
  return normals;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const mark = asked.get('mark') ?? 'drawn';
  const phase = asked.get('phase') ?? 'flat';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const flat = floorData(false);
  const floor: MeshHandle = renderer.createMesh(flat, { dynamic: true });
  if (phase === 'wave') {
    const waved = floorData(true);
    renderer.updateMesh(floor, waved.positions, smoothNormals(waved, true));
  }

  /*
   * The projector, one box for both halves so the two marks are the same mark.
   *
   * Centred off to one side, so the box overhangs the floor's `x = 2` edge and its scissor
   * rectangle covers background. Deep enough along the projection to contain the risen floor.
   */
  const BOX = {
    center: [0.9, 0.5, 0] as Vec3,
    halfExtents: [1.4, 1.4, 1.2] as Vec3,
    forward: [0, -1, 0] as Vec3,
    up: [0, 0, 1] as Vec3,
  };

  /* Clipped from the floor **as it was flat**, which is when a consumer would have made the mark. */
  const clipped: MeshHandle | null =
    mark === 'static' ? renderer.createMesh(projectDecal(flat, { ...BOX, color: MARK })) : null;
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /* Nearly hard-edged, so the mark reaches the box and the overhang is actually tested. A soft
     edge would fade to nothing before it got there and prove nothing about the background. */
  const projector = new DecalProjector({ ...BOX, color: MARK, softness: 0.02 });

  const env = createEnvironment();
  env.ambient = [1, 1, 1];
  env.directionalColor = [0, 0, 0];
  env.directionalDir = [0, 1, 0];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 100;
  /* Steep rather than straight down: a floor seen from directly above needs an up vector parallel
     to the view, and the rise then changes the distance to the camera by three per cent instead
     of by a foreshortening nobody is measuring. */
  camera.position[0] = 0;
  camera.position[1] = 7;
  camera.position[2] = 2.2;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let marked = 0;
  let surfacepx = 0;
  let sky = 0;
  let digest = '';
  /**
   * Where the mark sits, as the mean of the pixels it covers.
   *
   * **A count alone is a weak way to tell the two backends apart and this is a sharp one.** Each
   * reconstructs a world position from depth through its own framebuffer convention, and a mark
   * reconstructed through the wrong one lands mirrored about the middle of the frame. Measured:
   * swapping `DEPTH_01_TO_CLIP_Y_DOWN` for its Y-up twin on WebGPU took the count from 77,522 to
   * 85,494 and the centre from 738.3,368.1 to 737.8,379.5 — and left every per-backend assertion
   * passing, because a mark in the wrong place is still a mark on a floor.
   */
  let centreX = 0;
  let centreY = 0;

  /**
   * What the frame contains, counted from the canvas rather than from a screenshot.
   *
   * **From the canvas for the reason `oit.ts` records**: the first version of that page's check
   * compared screenshots and found 120 differing pixels which turned out to be its own caption.
   *
   * The background is whatever the first pixel is, rather than a constant written here: the clear
   * colour goes through the composite, and a page that assumed it knew the answer would be
   * measuring its own assumption.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const skyR = data[0] ?? 0;
    const skyG = data[1] ?? 0;
    const skyB = data[2] ?? 0;
    let red = 0;
    let white = 0;
    let clear = 0;
    let sumX = 0;
    let sumY = 0;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r === skyR && g === skyG && b === skyB) clear += 1;
      else if (r > 200 && g < 200) {
        red += 1;
        const pixel = i / 4;
        sumX += pixel % mirror.width;
        sumY += Math.floor(pixel / mirror.width);
      } else if (r > 200 && g > 200 && b > 200) white += 1;
      hash = Math.imul(hash ^ r, 0x01000193);
      hash = Math.imul(hash ^ g, 0x01000193);
      hash = Math.imul(hash ^ b, 0x01000193);
    }
    marked = red;
    surfacepx = white;
    sky = clear;
    centreX = red === 0 ? 0 : sumX / red;
    centreY = red === 0 ? 0 : sumY / red;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, identity);
    if (clipped !== null) renderer.drawMesh(clipped, identity, 1);
    if (mark === 'drawn') renderer.drawDecal(projector);
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
    `${created.backend} · ${created.reason} · ${mark} · ${phase} · ` +
    `${marked} marked at ${centreX.toFixed(1)},${centreY.toFixed(1)} · ` +
    `${surfacepx} floor · ${sky} sky · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__marked'] = marked;
  out['__centreX'] = centreX;
  out['__centreY'] = centreY;
  out['__surface'] = surfacepx;
  out['__sky'] = sky;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
