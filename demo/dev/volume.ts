/**
 * A beam of light meeting a floor, watched from the side, on either backend.
 *
 * **This page exists because the march has no idea where the floor is.** `lightVolume.ts` bounds
 * a ray by the hull it was given — a slab along the axis and the cylinder enclosing it — and by
 * nothing else. There is no depth sample anywhere in that shader. So a ray whose hull continues
 * past a solid surface keeps integrating light through it, and the beam terminates on the hull's
 * own boundary rather than where the light actually lands. Reported from a consumer, about
 * `cathedral-of-light`: *"the ray on the ground felt unnatural"*.
 *
 * Both backends do it, identically, so no comparison between them could ever have shown it —
 * which is why the shaft that ships in `gilded-chamber` never raised it either. What shows it is
 * a beam aimed at a floor, from a camera low enough to see where the two meet.
 *
 *     /volume.html                 the default backend, which is WebGL2
 *     /volume.html?backend=webgpu  the other one
 *     /volume.html?length=26       a hull that runs well past the floor, which is the bad case
 *     /volume.html?length=13       a hull that stops near it, which is the case that hid it
 *
 * The two lengths are the point. At a hull that ends near the floor the artefact reads as a
 * slightly hard edge and is easy to call authoring; at a hull that runs past it the same fault
 * is a flat bright slab lying across the ground, and the two are the same missing clamp.
 *
 * Deterministic: one fixed light, one fixed camera, one frame, no clock read anywhere.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `shadows.ts`, `overlay.ts` and `plumes.ts`.
 */

import {
  Camera,
  MeshBuilder,
  buildLightVolume,
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
const CLEAR: Vec3 = [0.02, 0.03, 0.05];
const BEAM: Vec3 = [0.85, 0.92, 1];
const SPREAD = 0.1;

/**
 * The shaft's placement: apex up at the ceiling, opening straight down at the floor.
 *
 * The volume's own space opens along +Z, so this turns +Z to point down and lifts the apex to
 * the opening it falls through. Column major, as `gl-matrix` produces.
 */
function shaftModel(apexY: number, x = 0, z = 0): Float32Array {
  /*
   * A quarter turn about X, then the apex's height: local +Z becomes world −Y, so the beam
   * opens downward. Written the other way round first, which points it at the ceiling and
   * photographs as no beam at all rather than as a beam in the wrong place.
   */
  return new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, apexY, z, 1]);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const askedLength = Number(asked.get('length'));
  /* Well past the floor by default: the fault is a slab on the ground rather than a hard edge,
     and a page that has to be squinted at is a page nobody reads an answer off. */
  const length = Number.isFinite(askedLength) && askedLength > 0 ? askedLength : 26;
  const APEX_Y = 12;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* A floor, and one block standing on it so the beam has something to be interrupted by
     that is not the ground — a solid in the middle of a beam is the same missing clamp seen
     end-on rather than edge-on. */
  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.15, 0], [14, 0.15, 14], [0.5, 0.52, 0.56]).build(),
  );
  /*
   * A ceiling with an aperture the shaft falls through, which is the other end of the same
   * question and the end that was missed.
   *
   * **A beam has two ends and a clamp can spoil either.** The first version of this page put the
   * apex in open air, so every ray toward the top of the beam ran off to the far plane and the
   * clamp there was free — the page could not have shown a beam cut short at its source, and
   * that is exactly what was reported next, from a cathedral where the shaft comes through a
   * roof. Four slabs leaving a hole, so the rays near the top of the beam land on real geometry
   * at a real distance rather than on nothing.
   */
  const APERTURE = 1.6;
  const ceiling: MeshHandle = renderer.createMesh(
    (() => {
      const b = new MeshBuilder();
      const grey: Vec3 = [0.34, 0.35, 0.38];
      const outer = 14;
      const y = 9.4;
      const t = 0.3;
      const arm = (outer - APERTURE) / 2;
      const mid = (outer + APERTURE) / 2;
      b.addBox([0, y, mid], [outer, t, arm], grey);
      b.addBox([0, y, -mid], [outer, t, arm], grey);
      b.addBox([mid, y, 0], [arm, t, APERTURE], grey);
      b.addBox([-mid, y, 0], [arm, t, APERTURE], grey);
      return b.build();
    })(),
  );
  const block: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([2.6, 1.2, 0], [0.9, 1.2, 0.9], [0.62, 0.55, 0.48]).build(),
  );
  const shaft: MeshHandle = renderer.createMesh(
    buildLightVolume({ nearM: 0.2, lengthM: length, spread: SPREAD, color: BEAM }),
  );

  const env = createEnvironment();
  env.directionalDir = [0.1, 0.97, 0.2];
  env.ambient = [0.06, 0.07, 0.1];
  env.directionalColor = [0.5, 0.55, 0.65];

  const camera = new Camera();
  /*
   * **The axis this page was missing, and the reason it called two backends identical for four
   * capture rounds while a shaft in a consumer was visibly cut in half.**
   *
   * The scene-depth clamp reconstructs a hit from a screen position, so anything wrong with that
   * reconstruction is wrong *as a function of the angle a pixel sits at off the view axis* — and
   * a 48-degree vertical field of view never gets more than 24 degrees off it. That is small
   * enough for a mirrored reconstruction to read as a faint band on the floor and nothing else.
   * That consumer composes portrait, where the long side is the vertical one and a pose reaches far
   * wider angles, and the same fault takes the top off a beam.
   *
   * So the field of view is a control, and `?fov=100` is the setting that made the fault
   * unmistakable here. A page that can only photograph small angles cannot photograph this
   * class of defect at all, whatever else it varies.
   */
  const askedFov = Number(asked.get('fov'));
  camera.fovYDeg = Number.isFinite(askedFov) && askedFov > 0 ? askedFov : 48;
  camera.near = 0.3;
  camera.far = 300;
  /* Low and to the side: where the beam meets the floor has to be in shot, and a camera looking
     down the barrel is the one arrangement in which this fault is invisible. */
  /* Both ends of the beam in one shot: the aperture it comes through at the top and the floor
     it lands on at the bottom. A camera that frames only one of them can pass while the other
     is broken, which is how the source end was missed. */
  camera.position[0] = 9.5;
  camera.position[1] = 3.4;
  camera.position[2] = 11;
  /*
   * **What the camera is aimed at, because where the beam sits in the frame is the other half of
   * the same axis `?fov=` opens.**
   *
   * A reconstruction fault that grows with the angle off the view axis is *zero* along the
   * frame's horizontal centre line, and this page framed the beam straight down the middle for
   * its whole first life. Widening the field of view alone does not help: it shrinks the beam
   * toward that same centre line and photographs the one place the fault cannot show.
   *
   * Aiming low puts the beam through the top of the frame, which is where that consumer's portrait
   * poses put a shaft and where the fault was actually reported from. `?aim=0&fov=100` is the
   * pair that reproduces it.
   */
  const askedAim = Number(asked.get('aim'));
  const aimY = Number.isFinite(askedAim) ? askedAim : 5.4;

  /*
   * **A beam that travels, and a camera that travels with it.** `?phase=` is a position along a
   * fixed sweep, 0 to 1, and it moves both: the cone slides along X while the camera arcs the
   * other way, so the beam crosses the frame instead of sitting in it. Deterministic — a phase is
   * a number in a query, never a clock — which is what lets two captures of one phase be compared.
   *
   * **`?warm=` is the half that makes it an instrument rather than a picture.** It runs that many
   * frames of the sweep *before* the one that is photographed, arriving at the same phase from
   * motion. Anything the volume derives from a stale camera — a reprojection, a per-frame origin,
   * a matrix uploaded once — draws a different picture on the way to a pose than it does at the
   * pose. `?phase=P` alone and `?phase=P&warm=12` must be the same frame, and `volume-cones-check`
   * asserts that. A page that only ever draws frame zero can say nothing about it, which is the
   * state this one was in.
   */
  const askedPhase = Number(asked.get('phase'));
  const phase = Number.isFinite(askedPhase) ? Math.max(0, Math.min(1, askedPhase)) : 0;
  const warm = Math.max(0, Math.trunc(Number(asked.get('warm'))) || 0);
  /** Where the cone stands, and where the camera is, at one point along the sweep. */
  const poseAt = (p: number): { beamX: number; eye: [number, number, number] } => ({
    beamX: -4 + 8 * p,
    eye: [9.5 - 5 * p, 3.4 + 1.4 * p, 11 - 2 * p],
  });

  renderer.resize();

  /*
   * The sun's own map, because a shaft carries the shape of the opening it fell through — and
   * because that is the permutation both products actually run.
   *
   * **`?sunshadow=0` turns it off, and the two are a pair worth photographing.** Without it the
   * volume compiles the plain permutation, which samples no maps at all; with it the march takes
   * a shadow lookup per step through `sunReach`. A page that only ever ran the plain one cannot
   * say anything about the shaded one, which is the gap that let a beam divergence be reported
   * from `cathedral-of-light` while this page called the two backends identical.
   */
  const sunShadow = asked.get('sunshadow') === '0' ? 0 : 0.9;
  /*
   * **The axis that shows a beam answering to the weather.** `?fog=` sets the haze the shaft is
   * standing in and `medium` tells the draw which density the beam was authored for, so the same
   * call fades to nothing as the air clears. Without it the shaft is identical in clear air and in
   * soup, which is what a consumer reported: fog filtered the frame instead of changing what could
   * be seen through it. `?fog=` absent leaves the beam at the strength it always had.
   */
  const fog = asked.has('fog') ? Number(asked.get('fog')) : null;
  if (fog !== null) env.fogDensity = fog;
  const medium = fog === null ? undefined : { atmosphere: env, fullAtDensity: 0.05 };
  if (sunShadow > 0) {
    const lightMatrix = new Float32Array(16);
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      5,
      0,
      16,
      renderer.shadowMapSize,
      lightMatrix,
    );
    env.lightViewProj = lightMatrix;
    env.shadowStrength = 0.9;
    /* The ceiling is what shapes the shaft: everything but the aperture blocks the sun. */
    const casters = (sink: ShadowCasterSink): void => {
      sink.mesh(ceiling, IDENTITY);
      sink.mesh(block, IDENTITY);
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();
  }

  /*
   * `warm + 1` frames, the last of which is the one that is photographed. With `warm` at 0 this is
   * the single frame this page has always drawn, at phase 0, which is where it has always stood.
   */
  const cones = Math.max(1, Math.trunc(Number(asked.get('cones'))) || 1);
  const only = asked.has('only') ? Number(asked.get('only')) : null;
  let beamX = 0;
  for (let frame = 0; frame <= warm; frame++) {
    const p = warm === 0 ? phase : (phase * frame) / warm;
    const pose = poseAt(p);
    beamX = pose.beamX;
    camera.position[0] = pose.eye[0];
    camera.position[1] = pose.eye[1];
    camera.position[2] = pose.eye[2];
    camera.lookAt(0, aimY, 0);
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, IDENTITY);
    renderer.drawMesh(block, IDENTITY);
    renderer.drawMesh(ceiling, IDENTITY);
    /*
     * Last and additive, which is what a volume is. See `gildedChamber`'s own call.
     *
     * **`?cones=2` is the case nothing in this repository has ever drawn**, and it is the case a
     * travelling beam is made of: a consumer moving a shaft through a scene issues one draw per
     * cone per frame, each with its own model matrix and its own strength. Four other WebGPU passes
     * are on record handing every draw in a frame the *last* draw's uniforms, because they write
     * one shared buffer with `queue.writeBuffer` while the encoder is submitted afterwards — water
     * had it and lost three bodies of four. `drawLightVolume` is documented as taking its uniforms
     * from a ring, which is the fix for that hazard, and until this switch existed nothing had
     * checked. `?only=` draws one of the pair on its own, which is the control the check compares
     * against.
     */
    for (let i = 0; i < cones; i++) {
      if (only !== null && only !== i) continue;
      /*
       * The first stays where the single-cone page has always put it, under the aperture, so every
       * capture this page already produces is unchanged. The second is 6.4 m along Z: far enough
       * not to overlap, and **outside the aperture, which matters** — with `sunshadow` on, the
       * ceiling blocks the sun everywhere but the hole, so a second cone placed away from it draws
       * almost nothing and a comparison against it measures almost nothing. `?sunshadow=0` is the
       * setting in which both are lit, and it is what `volume-cones-check.mjs` uses.
       *
       * They are given *different* strengths and different dust as well: two identical cones are
       * the one arrangement in which a shared uniform slot draws the right picture.
       */
      const z = i * 6.4;
      renderer.drawLightVolume(
        shaft,
        shaftModel(APEX_Y, beamX, z),
        camera,
        i === 0 ? 0.8 : 0.35,
        length,
        SPREAD,
        {
          dust: i === 0 ? 0.25 : 0.6,
          sunShadow,
          env,
          medium,
        },
      );
    }
    renderer.endFrame();
  }

  stats.textContent =
    `${created.backend} · ${created.reason} · hull ${length} m from an apex at ${APEX_Y} m · ` +
    `floor at 0 · sunShadow ${sunShadow} · ` +
    (fog === null ? 'no medium' : `fog ${fog} of 0.05`) +
    (cones === 1 ? '' : ` · ${cones} cones${only === null ? '' : `, only ${only}`}`) +
    (phase === 0 && warm === 0 ? '' : ` · phase ${phase.toFixed(3)} after ${warm} frames`);
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
