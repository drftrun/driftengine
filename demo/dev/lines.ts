/**
 * The polyline renderer, looked at on real hardware, on either backend.
 *
 * **Everything in Tasks A7 to A9 had a unit test and neither renderer had ever built a frame
 * with any of it.** `buildSegmentQuads`, `setPolyline` and the two backends' `createLines`/
 * `drawLines` compile against `RendererApi` and have never been asked to produce a pixel. A
 * compiling shader is not a correct one — see `AGENTS.md` on the four-gate problem, and
 * `sdf-text.ts`'s own opening comment for the page this one is modelled on — and a shader whose
 * whole reason for existing is a screen-space antialiased band and a distance-scaled minimum
 * width is exactly the kind of thing that is either right or is not, and the only way to tell
 * the two apart is to look.
 *
 * So, five things, each aimed at one way this can be wrong:
 *
 *   - **Three widths of one shape**, so the antialiasing band can be judged at each rather than
 *     assumed from one.
 *   - **One polyline receding hard into the distance**, the only way to see the sub-pixel width
 *     floor doing its job. Without it a far stroke thins under a pixel and breaks up rather than
 *     merely fading, because a rasteriser either catches a sub-pixel span or it does not.
 *   - **The same shape at `softness` 0 and `softness` 0.6**, side by side, so a clean edge and a
 *     soft one are seen together rather than one at a time.
 *   - **A polyline under a moving, scaling model matrix**, to prove the model transform reaches
 *     the geometry and that the width does *not* — `line.ts`'s own comment says why.
 *   - **A polyline rewritten every frame from an advancing sine**, the waveform case in miniature
 *     and the only way to see that `setPolyline` into a live batch does not tear.
 *
 *     /lines.html                 the default backend, which is WebGL2
 *     /lines.html?backend=webgpu  the other one
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `sdf-text.ts` and `plumes.ts`.
 */

import {
  BoxSurface,
  Camera,
  CompositeSurface,
  MeshBuilder,
  RainField,
  createEnvironment,
  createLineSegments,
  createRenderer,
  setPolyline,
} from '../../packages/core/src/index';
import type {
  LineHandle,
  LineSegments,
  MeshHandle,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.045, 0.05, 0.07];

/** A translation. Every static polyline on this page sits at one of these. */
function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * A uniform scale then a translation, written into `out` in place.
 *
 * In place rather than returned fresh, because the moving-line case calls this every frame and
 * this page follows the engine's own hot-path rule even though it is a harness rather than
 * `src/`: a demo that leaks one allocation a frame is a demo that cannot itself tell a real leak
 * from its own noise if one is ever asked of it.
 */
function setScaleTranslate(
  out: Float32Array,
  scale: number,
  x: number,
  y: number,
  z: number,
): void {
  out[0] = scale;
  out[5] = scale;
  out[10] = scale;
  out[12] = x;
  out[13] = y;
  out[14] = z;
}

/**
 * One zigzag shape, reused for both the three-widths row and the softness pair — the point of
 * each case is the draw parameters, not the geometry, so one shape drawn several ways keeps the
 * comparison honest: whatever changes between two copies is only what the call site changed.
 */
const ZIGZAG_POINTS = new Float32Array([
  0, 0, 0, 1.1, 1.3, 0, 2.2, 0, 0, 3.3, 1.3, 0, 4.4, 0, 0, 5.5, 1.3, 0,
]);
const ZIGZAG_POINT_COUNT = 6;

/** A small zigzag for the moving-model case, a quarter the span of `ZIGZAG_POINTS`. */
const ORBIT_POINTS = new Float32Array([
  -1.5, -0.8, 0, -0.9, 0.8, 0, -0.3, -0.8, 0, 0.3, 0.8, 0, 0.9, -0.8, 0, 1.5, 0.8, 0,
]);
const ORBIT_POINT_COUNT = 6;

/** The receding line: a slight zigzag in X so segment joints stay visible at distance, running
 * a long way down -Z. Fourteen points is enough to show several joints without the per-point
 * detail vanishing into one blurred stroke by the far end. */
const RECEDE_POINT_COUNT = 14;
const RECEDE_STEP_Z = -7;
function buildRecedePoints(): Float32Array {
  const points = new Float32Array(RECEDE_POINT_COUNT * 3);
  for (let p = 0; p < RECEDE_POINT_COUNT; p++) {
    points[p * 3] = p % 2 === 0 ? -0.45 : 0.45;
    points[p * 3 + 1] = 0;
    points[p * 3 + 2] = p * RECEDE_STEP_Z;
  }
  return points;
}

/** The advancing sine: rewritten every frame by `updateWave`, never reallocated. */
const WAVE_POINT_COUNT = 48;
const WAVE_SPAN_X = 8;
const WAVE_AMPLITUDE = 0.9;
const WAVE_FREQUENCY = 1.4;
const WAVE_PHASE_SPEED = 1.6;
const wavePoints = new Float32Array(WAVE_POINT_COUNT * 3);
function updateWave(phase: number): void {
  for (let p = 0; p < WAVE_POINT_COUNT; p++) {
    const x = (p / (WAVE_POINT_COUNT - 1)) * WAVE_SPAN_X;
    wavePoints[p * 3] = x;
    wavePoints[p * 3 + 1] = Math.sin(x * WAVE_FREQUENCY + phase) * WAVE_AMPLITUDE;
    wavePoints[p * 3 + 2] = 0;
  }
}

/** A dark, wide floor, so the receding line has a ground to be measured against rather than
 * floating over the clear colour. */
function buildGround(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, -0.5, -40], [90, 0.5, 110], [0.08, 0.09, 0.11]).build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  /* Pipelines compiled before the first frame rather than inside it; on WebGPU
     `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /*
   * **Read this back rather than trusting `?backend=`.** A browser with no usable WebGPU
   * adapter falls back to WebGL2 silently and draws a perfectly reasonable frame — see
   * `createRenderer`'s own comment on `choice.reason`.
   */
  console.log(`[lines] backend: ${created.backend} · ${created.reason}`);

  const env = createEnvironment({
    fogColor: [0.42, 0.47, 0.56],
    fogDensity: 0.01,
  });
  const camera = new Camera();
  camera.fovYDeg = 54;
  camera.near = 0.4;
  camera.far = 140;
  camera.position[0] = -1.5;
  camera.position[1] = 6;
  camera.position[2] = 21;
  camera.lookAt(-1, 1.6, -25);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const ground: MeshHandle = renderer.createMesh(buildGround());

  /* ---- Case 1: one shape at three widths ---- */
  const zigzagLines: LineHandle = renderer.createLines(ZIGZAG_POINT_COUNT - 1, 'lines.zigzag');
  const zigzagData: LineSegments = createLineSegments(ZIGZAG_POINT_COUNT - 1);
  setPolyline(zigzagData, ZIGZAG_POINTS, ZIGZAG_POINT_COUNT);
  const WIDTH_COLOR: Vec3 = [1, 0.78, 0.32];
  const WIDTH_ROWS: readonly { readonly widthM: number; readonly y: number }[] = [
    { widthM: 0.03, y: 7.6 },
    { widthM: 0.1, y: 5.2 },
    { widthM: 0.28, y: 2.8 },
  ];
  const widthModels = WIDTH_ROWS.map((row) => at(-13, row.y, -4));

  /*
   * ---- Case 3: the same shape at softness 0 and 0.6, side by side ----
   *
   * Wider than the thickest width row: `uSoftness` widens the band as a *fraction* of the
   * half-width, so a thin stroke has little half-width for 0.6 to be 60% of and the two
   * copies read as almost the same edge. A generous width is what turns the difference into
   * something legible at a glance rather than something only a pixel sampler can find.
   */
  const SOFTNESS_COLOR: Vec3 = [0.35, 0.82, 1];
  const SOFTNESS_WIDTH = 0.34;
  const softLeftModel = at(-13, 0.2, -4);
  const softRightModel = at(-5.6, 0.2, -4);

  /* ---- Case 2: receding hard into the distance ---- */
  const recedeLines = renderer.createLines(RECEDE_POINT_COUNT - 1, 'lines.recede');
  const recedeData = createLineSegments(RECEDE_POINT_COUNT - 1);
  setPolyline(recedeData, buildRecedePoints(), RECEDE_POINT_COUNT);
  const RECEDE_COLOR: Vec3 = [0.65, 0.88, 1];
  const RECEDE_WIDTH_M = 0.016;
  /*
   * Deliberately smaller than the floor takes over almost immediately: `uWidth` alone is a
   * hairline, and everything past the first few metres is `minWidthPerMetre` doing the work.
   * That is the point — a floor that only matters at the far end would not prove it reaches
   * the shader every frame, only that it exists.
   */
  const RECEDE_MIN_WIDTH_PER_METRE = 0.0028;
  const recedeModel = at(2.6, 0.35, 9);

  /* ---- Case 4: a moving, scaling model matrix ---- */
  const orbitLines = renderer.createLines(ORBIT_POINT_COUNT - 1, 'lines.orbit');
  const orbitData = createLineSegments(ORBIT_POINT_COUNT - 1);
  setPolyline(orbitData, ORBIT_POINTS, ORBIT_POINT_COUNT);
  const ORBIT_COLOR: Vec3 = [0.85, 0.42, 0.95];
  const ORBIT_WIDTH_M = 0.07;
  const ORBIT_CENTER_X = 9;
  const ORBIT_CENTER_Y = 4.2;
  const ORBIT_CENTER_Z = -6;
  const ORBIT_RADIUS = 1.9;
  const orbitModel = new Float32Array(IDENTITY);

  /*
   * ---- Case 6: rain, with a roof over half of it ----
   *
   * **The one case here whose geometry a batch does not own.** `RainField` fills a `LineSegments`
   * every frame from where its drops are, so this is the same upload path as case 5 with a
   * different author — and it is what puts falling water on screen at all, which the particle pool
   * cannot do: a drop is a streak, not a sprite.
   *
   * The two pads with a gap between them are the point. Rain lands *on* a roof, and rain under one
   * is not drawn, and rain through the gap reaches the ground — none of which the rain arranges:
   * `coveredAbove` asks whether the surface has a face overhead, so the opening is the geometry's
   * and cannot disagree with it. `?rain=0` turns the whole case off.
   *
   * **`?rainspeed=14` is hail, and it is the dial for a per-frame value.** The fall speed became
   * settable on 2026-08-28 because a weather state changes under a player, and a constructor
   * argument here would have proven nothing about that: the page writes it **every frame**, so a
   * field that read its speed once at construction draws the wrong streaks and the capture says so.
   * Drizzle is nearer 2, rain 9, hail 14, and the streak lengthens with the speed because it is
   * the distance a drop covers while the shutter is open.
   */
  const asked = new URLSearchParams(location.search);
  const RAIN_ON = asked.get('rain') !== '0';
  /* Positive only, so `?rainspeed=0` — which would hang the drops in the air — reads as unset. */
  const askedRainSpeed = Number(asked.get('rainspeed'));
  const RAIN_SPEED_MPS = Number.isFinite(askedRainSpeed) && askedRainSpeed > 0 ? askedRainSpeed : 9;
  const RAIN_DROPS = 900;
  const RAIN_ROOF_Y = 3.4;
  const rainRoof = new CompositeSurface([
    new BoxSurface([
      { minX: -30, maxX: 30, minZ: -30, maxZ: 30, topY: 0, distanceM: 0, tangentX: 1, tangentZ: 0 },
    ]),
    new BoxSurface([
      {
        minX: -9,
        maxX: -1.4,
        minZ: -22,
        maxZ: -10,
        topY: RAIN_ROOF_Y,
        distanceM: 0,
        tangentX: 1,
        tangentZ: 0,
      },
      {
        minX: 1.4,
        maxX: 9,
        minZ: -22,
        maxZ: -10,
        topY: RAIN_ROOF_Y,
        distanceM: 0,
        tangentX: 1,
        tangentZ: 0,
      },
    ]),
  ]);
  const rain = new RainField({
    count: RAIN_DROPS,
    radiusM: 9,
    heightM: 7,
    speedMps: 9,
    streakSec: 0.05,
    ground: rainRoof,
  });
  const rainLines = renderer.createLines(RAIN_DROPS, 'lines.rain');
  const RAIN_COLOR: Vec3 = [0.72, 0.82, 0.95];
  const RAIN_WIDTH_M = 0.012;
  const rainModel = at(0, 0, -16);

  /* ---- Case 5: rewritten every frame from an advancing sine ---- */
  const waveLines = renderer.createLines(WAVE_POINT_COUNT - 1, 'lines.wave');
  const waveData = createLineSegments(WAVE_POINT_COUNT - 1);
  const WAVE_COLOR: Vec3 = [0.42, 0.95, 0.6];
  const WAVE_WIDTH_M = 0.045;
  /*
   * `y=1.2` and not the below-ground `y=-2.6` this first read. The ground box spans `y=-1` to
   * `0`, so the sine's own amplitude of 0.9 either side of a negative centre put every point of
   * it under the floor — on both backends alike, since a wrong model matrix is wrong the same
   * way regardless of which renderer reads it. Caught by the WebGPU screenshot showing nothing
   * where a wave should be and the WebGL2 one showing the same nothing once looked for.
   */
  const waveModel = at(3, 1.2, -2);
  updateWave(0);
  setPolyline(waveData, wavePoints, WAVE_POINT_COUNT);

  /* A rolling window of frame times, sampled without allocating, so `stats` can report whether
     frame time is growing rather than just the instantaneous number. */
  const FRAME_SAMPLES = 90;
  const frameSamplesMs = new Float32Array(FRAME_SAMPLES);
  let frameSampleIndex = 0;
  let frameSamplesFilled = 0;
  let lastStatsUpdate = 0;

  let lastNow = performance.now();
  let wavePhase = 0;

  function frame(now: number): void {
    const dtSec = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;

    wavePhase += dtSec * WAVE_PHASE_SPEED;
    updateWave(wavePhase);
    setPolyline(waveData, wavePoints, WAVE_POINT_COUNT);

    const tSec = now / 1000;
    const orbitScale = 1 + 0.55 * Math.sin(tSec * 0.9);
    const orbitX = ORBIT_CENTER_X + Math.cos(tSec * 0.6) * ORBIT_RADIUS;
    const orbitZ = ORBIT_CENTER_Z + Math.sin(tSec * 0.6) * ORBIT_RADIUS;
    setScaleTranslate(orbitModel, orbitScale, orbitX, ORBIT_CENTER_Y, orbitZ);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);

    for (let row = 0; row < WIDTH_ROWS.length; row++) {
      const width = WIDTH_ROWS[row]?.widthM ?? 0;
      renderer.drawLines(
        zigzagLines,
        zigzagData,
        widthModels[row] ?? IDENTITY,
        camera,
        env,
        WIDTH_COLOR,
        width,
        1,
      );
    }
    renderer.drawLines(
      zigzagLines,
      zigzagData,
      softLeftModel,
      camera,
      env,
      SOFTNESS_COLOR,
      SOFTNESS_WIDTH,
      1,
      0,
    );
    renderer.drawLines(
      zigzagLines,
      zigzagData,
      softRightModel,
      camera,
      env,
      SOFTNESS_COLOR,
      SOFTNESS_WIDTH,
      1,
      0.6,
    );
    renderer.drawLines(
      recedeLines,
      recedeData,
      recedeModel,
      camera,
      env,
      RECEDE_COLOR,
      RECEDE_WIDTH_M,
      1,
      0,
      RECEDE_MIN_WIDTH_PER_METRE,
    );
    renderer.drawLines(
      orbitLines,
      orbitData,
      orbitModel,
      camera,
      env,
      ORBIT_COLOR,
      ORBIT_WIDTH_M,
      1,
    );
    renderer.drawLines(waveLines, waveData, waveModel, camera, env, WAVE_COLOR, WAVE_WIDTH_M, 1);
    if (RAIN_ON) {
      /* Written every frame rather than at construction: this is what asserts the field reads its
         speed live, which is the whole of what `?rainspeed=` is here to show. */
      rain.speedMps = RAIN_SPEED_MPS;
      /* Leaned by a wind that swings, so the streaks are visibly the velocity rather than a
         constant tilt somebody typed in. */
      rain.update(dtSec, 0, 3, -16, Math.sin(tSec * 0.4) * 4, 0);
      renderer.drawLines(
        rainLines,
        rain.segments,
        rainModel,
        camera,
        env,
        RAIN_COLOR,
        RAIN_WIDTH_M,
        0.85,
        0.4,
      );
    }

    renderer.endFrame();

    /* The real inter-frame gap, already computed as `dtSec` above — this is what a stall or a
       per-frame allocation shows up in, whether the cost lands in this page's own code or in a
       GC pause the frame loop pays for regardless of where the garbage came from. */
    frameSamplesMs[frameSampleIndex] = dtSec * 1000;
    frameSampleIndex = (frameSampleIndex + 1) % FRAME_SAMPLES;
    if (frameSamplesFilled < FRAME_SAMPLES) frameSamplesFilled++;

    if (now - lastStatsUpdate > 250) {
      lastStatsUpdate = now;
      let total = 0;
      for (let s = 0; s < frameSamplesFilled; s++) total += frameSamplesMs[s] ?? 0;
      const meanMs = frameSamplesFilled > 0 ? total / frameSamplesFilled : 0;
      const fps = meanMs > 0 ? 1000 / meanMs : 0;
      stats.textContent = `${created.backend} · ${created.reason} · ${fps.toFixed(0)} fps · ${meanMs.toFixed(2)} ms mean`;
    }

    requestAnimationFrame(frame);
  }

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
  });

  requestAnimationFrame(frame);

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
