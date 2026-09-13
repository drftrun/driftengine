/**
 * A room with air in it, on either backend.
 *
 * **This page exists because a beam is not a medium.** `drawLightVolume` marches a hull somebody
 * placed, so a shaft through a window works and fog filling a room does not; `atmosphere.ts` fades
 * a *surface* toward a colour by distance, which dims a wall behind a doorway and cannot put the
 * doorway's shape on the floor. `setGlobalMedium` is the term that was missing, and everything on
 * this page is arranged so that each thing it claims can be measured rather than admired.
 *
 *     /medium.html?steps=32&density=0.03        a room with weather in it
 *     /medium.html?steps=0                      the build where the pass does not exist
 *     /medium.html?steps=32&density=0           the same picture, from a build where it does
 *     /medium.html?steps=32&density=0.06        twice the air, for the far wall
 *     /medium.html?steps=32&density=0.03&sun=40 the sun moved, so the shadow column moves
 *     /medium.html?steps=32&density=0.03&aniso=-0.8&sunshadow=0&sun=180
 *
 * The scene: a floor, a bright far wall, a nearer wall to one side, a slab overhead that keeps the
 * sun off part of the room, and a thin dark post standing well in front of the far wall.
 *
 * **The post is the silhouette instrument.** The march runs at half resolution, so the fog computed
 * for the wall behind the post lands in the same low-resolution texel as the post itself; a plain
 * bilinear upsample spreads the wall's fog onto the post and it wears a halo. The post is dark and
 * the wall behind it is bright so that the contamination is large enough to read off a photograph.
 *
 * Deterministic: one fixed camera, one fixed sun per query, one frame, no clock read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `volume.ts` and `emissive.ts`.
 */

import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Near black, so what the medium adds to a sky pixel is the medium and nothing else. */
const CLEAR: Vec3 = [0.01, 0.012, 0.02];

/**
 * The room, in metres. A box the camera stands inside, with a window cut in its left wall.
 *
 * **A window rather than an open sky, because a shaft is what a global medium is for.** Fog over a
 * field is a tint and a tint is what `atmosphere.ts` already does; what nothing here could do is
 * put the shape of an opening into the air, and that needs an opening.
 */
const ROOM = { x: 11, yTop: 9, zBack: -24, zFront: 13 };
/** The opening in the left wall: the shaft's cross-section, before it starts falling. */
const WINDOW = { yLow: 4.2, yHigh: 7.4, zNear: -7, zFar: -16 };
/** Where the thin dark post stands. Close, so the wall behind it wears far more fog than it does. */
const POST = { x: 0.6, z: 2.2 };

/**
 * Screen position of a world point, in CSS pixels, and how far it is from the eye.
 *
 * **The distance is reported because the extinction claim is arithmetic rather than an
 * inequality.** `exp(-sigma d)` predicts exactly how much of a surface survives, so a check that
 * knows `d` can compare what it measured against what the model says instead of asserting only
 * that the far one moved further — which a flat tint applied twice would also satisfy.
 */
function project(
  viewProjection: Float32Array,
  eye: Float32Array,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): { x: number; y: number; distance: number } {
  const m = viewProjection;
  const cx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  const cy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  const cw = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
  const w = Math.abs(cw) < 1e-6 ? 1e-6 : cw;
  /* Y down, because a screenshot's rows start at the top and clip space's do not. */
  return {
    x: ((cx / w) * 0.5 + 0.5) * width,
    y: (0.5 - (cy / w) * 0.5) * height,
    distance: Math.hypot(x - (eye[0] ?? 0), y - (eye[1] ?? 0), z - (eye[2] ?? 0)),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const number = (key: string, fallback: number): number => {
    const value = Number(asked.get(key));
    return asked.has(key) && Number.isFinite(value) ? value : fallback;
  };

  const density = number('density', 0);
  const albedo = number('albedo', 0.9);
  const anisotropy = number('aniso', 0.6);
  const maxDistance = number('dist', 70);
  /*
   * Where the sun stands, in degrees of azimuth. **0 puts it behind the camera and 180 in front**,
   * which is the axis the phase function is measured on: a forward-scattering medium is bright
   * looking into the sun and dim looking away, and a constant phase is the same either way.
   */
  const sunAzimuth = number('sun', 20);
  const sunShadow = asked.get('sunshadow') === '0' ? 0 : 0.95;

  /*
   * **The surfaces' own shadows reach as far as the medium's do, which they do not by default.**
   *
   * `directionalShadowMaxDistance` is 6 m: a surface shadow fades out once its caster is further
   * than that along the ground, because a shadow map's resolution and its bias are both tuned for
   * contact and a distant one is unreliable. The medium's lookup has no such fade — a shaft
   * through a high window is the whole point of the feature, and it is long-range by nature.
   *
   * The two disagreeing is what this page photographed first: a clean shaft standing in the air
   * over a floor that showed no shadow at all, because the ceiling nine metres up was past the
   * surfaces' reach and not past the march's. It is a real property of the engine rather than a
   * defect in either half, and it is recorded in `docs/IMPROVEMENTS.md`. Here the surfaces are
   * simply told to reach as far, so that what the air says and what the floor says agree and a
   * measurement of one is not confounded by the other.
   */
  const quality = { ...askedQuality(), directionalShadowMaxDistance: 40 };
  const created = await createRenderer(canvas, quality, DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const grey: Vec3 = [0.3, 0.31, 0.34];
  const pale: Vec3 = [0.72, 0.73, 0.76];
  const box = (b: MeshBuilder, centre: Vec3, half: Vec3, colour: Vec3): MeshBuilder =>
    b.addBox(centre, half, colour);

  /*
   * The room, as six slabs and a wall in four pieces.
   *
   * The left wall is the one with the opening in it, so it is built as a sill, a lintel and two
   * jambs. Everything else is one box. The floor is pale because it is what the shaft lands on.
   */
  const midZ = (ROOM.zBack + ROOM.zFront) / 2;
  const halfZ = (ROOM.zFront - ROOM.zBack) / 2;
  const shell: MeshHandle = renderer.createMesh(
    (() => {
      const b = new MeshBuilder();
      box(b, [0, -0.2, midZ], [ROOM.x, 0.2, halfZ], pale);
      box(b, [0, ROOM.yTop + 0.2, midZ], [ROOM.x, 0.2, halfZ], grey);
      box(b, [0, ROOM.yTop / 2, ROOM.zBack - 0.2], [ROOM.x, ROOM.yTop / 2, 0.2], grey);
      box(b, [ROOM.x + 0.2, ROOM.yTop / 2, midZ], [0.2, ROOM.yTop / 2, halfZ], grey);
      /* The left wall, around the opening. */
      const wx = -ROOM.x - 0.2;
      const sillH = WINDOW.yLow / 2;
      box(b, [wx, sillH, midZ], [0.2, sillH, halfZ], grey);
      const lintelH = (ROOM.yTop - WINDOW.yHigh) / 2;
      box(b, [wx, WINDOW.yHigh + lintelH, midZ], [0.2, lintelH, halfZ], grey);
      const openH = (WINDOW.yHigh - WINDOW.yLow) / 2;
      const backJamb = (WINDOW.zFar - ROOM.zBack) / 2;
      box(b, [wx, WINDOW.yLow + openH, ROOM.zBack + backJamb], [0.2, openH, backJamb], grey);
      const frontJamb = (ROOM.zFront - WINDOW.zNear) / 2;
      box(b, [wx, WINDOW.yLow + openH, WINDOW.zNear + frontJamb], [0.2, openH, frontJamb], grey);
      return b.build();
    })(),
  );
  /*
   * The post: thin, dark, and close, in front of a wall that is far.
   *
   * **The silhouette instrument.** The march runs at half resolution, so the fog computed for the
   * wall behind the post lands in the same low-resolution texel as the post itself, and a plain
   * bilinear upsample spreads twenty-one metres of the wall's fog onto a post that has three
   * metres of its own. It is dark and the wall is pale so that the contamination is large enough
   * to read off a photograph.
   */
  const post: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([POST.x, 5.2, POST.z], [0.13, 2.6, 0.13], [0.04, 0.04, 0.05]).build(),
  );

  const env = createEnvironment();
  const elevation = (40 * Math.PI) / 180;
  const azimuth = (sunAzimuth * Math.PI) / 180;
  /* Surface → sun, normalised, which is the convention `Environment.directionalDir` documents.
     The default puts the sun off to -X, so its light comes in through the window. */
  env.directionalDir = [
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ];
  env.directionalColor = [1.1, 1.05, 0.95];
  env.ambient = [0.035, 0.04, 0.055];

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 300;
  camera.position[0] = 7.5;
  camera.position[1] = 5;
  camera.position[2] = 11;
  /*
   * **`?look=` turns the camera in place, and it is the phase function's axis.**
   *
   * A Henyey-Greenstein medium is bright looking into the light and dim looking away from it, and
   * a constant phase is the same either way — so the claim needs two aims rather than two
   * densities. `room` looks across the room at the shaft and is the default; `sun` turns to face
   * the sun's own bearing and `away` turns its back on it, which are the two the phase is measured
   * between. Aimed by the sun's own direction rather than by a fixed angle, so `?sun=` moves both
   * together and the pair stays a pair.
   */
  const look = asked.get('look') ?? 'room';
  const bearing = Math.hypot(env.directionalDir[0], env.directionalDir[2]) || 1;
  const toSun: Vec3 = [env.directionalDir[0] / bearing, 0, env.directionalDir[2] / bearing];
  const aim: Vec3 =
    look === 'sun'
      ? [camera.position[0] + toSun[0] * 30, 5.4, camera.position[2] + toSun[2] * 30]
      : look === 'away'
        ? [camera.position[0] - toSun[0] * 30, 5.4, camera.position[2] - toSun[2] * 30]
        : [-8.5, 3.6, -11];
  camera.lookAt(aim[0], aim[1], aim[2]);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  renderer.resize();

  if (sunShadow > 0) {
    const lightMatrix = new Float32Array(16);
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      4,
      -6,
      26,
      renderer.shadowMapSize,
      lightMatrix,
    );
    env.lightViewProj = lightMatrix;
    env.shadowStrength = sunShadow;
    /* The shell is what shapes the air: the shaft is the hole in its left wall. */
    const casters = (sink: ShadowCasterSink): void => {
      sink.mesh(shell, IDENTITY);
      sink.mesh(post, IDENTITY);
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();
  } else {
    env.shadowStrength = 0;
  }

  renderer.setGlobalMedium(density, albedo, anisotropy, maxDistance);

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(shell, IDENTITY);
  renderer.drawMesh(post, IDENTITY);
  renderer.endFrame();

  /*
   * Where a check measures, in CSS pixels, computed from the camera rather than written down.
   *
   * **A hard-coded coordinate is a claim about the projection**, and it is the claim least likely
   * to survive a field-of-view edit — after which every measurement lands somewhere plausible and
   * nothing says so. These are projections of world points the scene actually placed.
   */
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const vp = camera.viewProjection as Float32Array;
  const eye = camera.position as Float32Array;
  const cells = {
    /*
     * Air inside the shaft and air beside it.
     *
     * **What a check compares is what the medium *added* at each**, against the same page with the
     * ceiling at zero — which cancels whatever surface stands behind either ray and leaves only
     * the march. Two cells whose backgrounds had to match would be a much more fragile
     * instrument, and the thing being claimed is about the air rather than about the wall.
     */
    shaftAir: project(vp, eye, -8.4, 3.4, -10.6, width, height),
    besideAir: project(vp, eye, 6, 3.4, -20, width, height),
    /*
     * Two patches of the same floor, at five metres and at thirty.
     *
     * **The same surface twice rather than two panels**, because the extinction claim needs the
     * two readings to differ only in distance: `S·exp(-sigma d) + A·(1 - exp(-sigma d))` moves by
     * `(S - A)` times the change in transmittance, so equal shading is what makes "the far one
     * moves about twice as far" a statement about `exp` rather than about paint.
     */
    floorNear: project(vp, eye, 0.5, 0, 1.3, width, height),
    floorFar: project(vp, eye, 2, 0, -20, width, height),
    /* The post, and the floor a long way behind it. */
    post: project(vp, eye, POST.x, 5.6, POST.z + 0.16, width, height),
    besidePost: project(vp, eye, -11.2, 5.6, -14.4, width, height),
  };
  (globalThis as unknown as { __mediumCells?: unknown }).__mediumCells = cells;

  stats.textContent =
    `${created.backend} · ${created.reason} · steps ${renderer.quality.globalMediumSteps}` +
    `${renderer.quality.globalMediumHalfResolution ? ' half' : ' full'} · ` +
    `density ${density} · albedo ${albedo} · g ${anisotropy} · reach ${maxDistance} m · ` +
    `sun ${sunAzimuth}° · sunShadow ${sunShadow}`;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
