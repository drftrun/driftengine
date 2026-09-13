/**
 * A kerbside at night, built to reproduce one artefact rather than to be looked at.
 *
 * **This is a test rig with a camera on it, and it is in `DRAFT_SCENES` on purpose.** Every
 * other scene here exists because it shows the engine doing something well. This one exists
 * because two separate consumers reported single white pixels tracing the creases of a dark
 * glossy model at night, and the published showroom is a brightly lit room, which is the one
 * condition that hides it. Reproducing a report is worth a scene; publishing the reproduction
 * is not.
 *
 * What it holds fixed, because these are the conditions the reports share and not decoration:
 *
 * - **A dark surround.** Ambient near zero, so contrast comes from the sources rather than from
 *   fill, and a one-pixel highlight has nothing to hide against.
 * - **Small, bright, high sources.** Street lamps rather than soft ceiling panels: a compact
 *   emitter is what puts a hard reflection somewhere on a curved panel.
 * - **A near-mirror black.** Roughness 0.025 and reflectivity 0.97, which is what a lacquered
 *   body is and is exactly the value both reports were using.
 * - **A reflection probe**, because the artefact is in the environment term and there is nothing
 *   to sample without one.
 *
 * Drive it held, or the measurement is worthless: `?scene=7&model=car&hold=900`. See
 * `demo/dev/heldFrame.ts` for why, and docs/IMPROVEMENTS.md for what has already been ruled out.
 */

import type {
  DemoBudget,
  DemoHandle,
  DemoScene,
  DemoSceneOptions,
  DemoStats,
  ResolutionControl,
} from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  MeshBuilder,
  Spline,
  buildFilmPatch,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '../packages/core/src/index';
import type {
  Environment,
  FilmOptions,
  Mesh,
  MeshHandle,
  MeshData,
  PointLightSource,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  Vec3,
} from '../packages/core/src/index';
import type { DrftMaterial } from '@driftengine/drft';
import { DrftLoader } from '@driftengine/assets';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Where the probe is captured: the middle of the subject, at about the height of a wing. */
const PROBE_ORIGIN: Vec3 = [0, 1.1, 0];

const ROAD_HALF_WIDTH = 7;
const ROAD_LENGTH = 90;
const KERB_HEIGHT = 0.14;
const LAMP_HEIGHT = 6.4;

/** Where the lamps stand, along the kerb on both sides. */
const LAMPS: readonly (readonly [number, number])[] = [
  [-ROAD_HALF_WIDTH - 0.5, -5],
  [ROAD_HALF_WIDTH + 0.5, -1],
  [-ROAD_HALF_WIDTH - 0.5, 6],
  [ROAD_HALF_WIDTH + 0.5, 13],
];

const ROAD: Vec3 = [0.021, 0.023, 0.028];
const KERB: Vec3 = [0.055, 0.056, 0.06];
const MARKING: Vec3 = [0.5, 0.5, 0.47];
const FACADE: Vec3 = [0.04, 0.042, 0.05];
const LAMP_POST: Vec3 = [0.03, 0.031, 0.035];
const LAMP_LENS: Vec3 = [1, 0.93, 0.78];
const WINDOW_LIT: Vec3 = [1, 0.94, 0.8];
const NEON: Vec3 = [0.35, 0.95, 1];

/**
 * The body finish, and it is the whole point of the rig.
 *
 * Both reports were on exactly this: a lacquered black at roughness 0.025 with reflectivity
 * near one. `?paint=matte` is the control, since taking the mirror away is what removes the
 * artefact, and having the two a query apart is what makes that checkable in a minute.
 */
interface Paint {
  readonly color?: Vec3;
  readonly roughness?: number;
  readonly specular?: number;
  readonly reflectivity?: number;
}

const BODY: Readonly<Record<string, Paint>> = {
  black: { color: [0.016, 0.016, 0.018], roughness: 0.025, specular: 1, reflectivity: 0.97 },
  matte: { color: [0.05, 0.05, 0.055], roughness: 0.55, specular: 0.25, reflectivity: 0.05 },
};

function bodyChoice(): Paint {
  const asked = new URLSearchParams(location.search).get('paint');
  return BODY[asked ?? 'black'] ?? (BODY['black'] as Paint);
}

/**
 * Everything that is not the body keeps a dark, unremarkable finish.
 *
 * Deliberately not the showroom's name table. A rig wants one surface under test and everything
 * else out of the picture, and a second table of finishes would be a second thing to hold
 * constant while comparing two builds.
 */
const OTHER: Paint = { color: [0.03, 0.03, 0.033], roughness: 0.5, specular: 0.1 };

const BODY_NAME = /^body|paint|karosse/i;
const GLASS_NAME = /glass|windscreen|windshield|window/i;

function paintFor(name: string): Paint {
  if (BODY_NAME.test(name)) return bodyChoice();
  if (GLASS_NAME.test(name))
    return { color: [0.012, 0.014, 0.017], roughness: 0.04, specular: 1, reflectivity: 1 };
  return OTHER;
}

function paint(mesh: MeshData, material: DrftMaterial | undefined): MeshData {
  const wanted = paintFor(material?.name ?? '');
  const vertices = mesh.positions.length / 3;
  const out: MeshData = { ...mesh };
  if (wanted.color !== undefined && (material?.albedo ?? -1) < 0) {
    const colors = new Float32Array(vertices * 3);
    for (let i = 0; i < vertices; i++) {
      colors[i * 3] = wanted.color[0];
      colors[i * 3 + 1] = wanted.color[1];
      colors[i * 3 + 2] = wanted.color[2];
    }
    out.colors = colors;
  }
  if (wanted.roughness !== undefined)
    out.roughness = new Float32Array(vertices).fill(wanted.roughness);
  if (wanted.specular !== undefined)
    out.specular = new Float32Array(vertices).fill(wanted.specular);
  return out;
}

function buildStreet(): MeshData {
  const builder = new MeshBuilder();

  /* The road: one dark slab, smooth enough to hold a reflection as wet tarmac does, and
     carrying the relief that makes it read as asphalt rather than as a grey plane. */
  builder.setRoughness(0.22);
  builder.setGrain(0.35);
  builder.setRelief(0.85);
  builder.addBox([0, -0.05, 0], [ROAD_HALF_WIDTH, 0.05, ROAD_LENGTH / 2], ROAD, 0, 0.35);

  /* A dashed centre line. Bright against the road, so it is also the check that the frame is
     exposed as it was last time: a marking that changes brightness is a changed grade. */
  builder.setRoughness(0.6);
  builder.setGrain(0);
  builder.setRelief(0);
  for (let at = -ROAD_LENGTH / 2 + 3; at < ROAD_LENGTH / 2 - 3; at += 6) {
    builder.addBox([0, 0.002, at], [0.09, 0.002, 1.4], MARKING, 0, 0.1);
  }

  /* Facades, far enough back to be a backdrop and near enough to be in the probe. */
  builder.setRoughness(0.85);
  for (const side of [-1, 1]) {
    builder.addBox(
      [side * (ROAD_HALF_WIDTH + 5.4), 7, 0],
      [0.4, 7, ROAD_LENGTH / 2],
      FACADE,
      0,
      0.05,
    );
  }

  /*
   * Lit windows, and they are not decoration.
   *
   * **What a probe holds is what a mirror shows**, so a backdrop of small bright rectangles is
   * most of what a lacquered panel has to reflect on a street at night. A facade that is one flat
   * dark slab gives the paint nothing, and the artefact under test needs something with hard
   * edges in the cubemap to land in one pixel and not its neighbour.
   */
  builder.setRoughness(0.9);
  builder.setGrain(0);
  for (const side of [-1, 1]) {
    for (let floor = 0; floor < 4; floor++) {
      for (let at = -ROAD_LENGTH / 2 + 4; at < ROAD_LENGTH / 2 - 4; at += 3.2) {
        /* Not every window: a facade with every pane lit reads as an office block on fire. */
        if ((floor * 7 + Math.round(at)) % 3 === 0) continue;
        builder.addBox(
          [side * (ROAD_HALF_WIDTH + 5.0), 2.6 + floor * 3.1, at],
          [0.05, 0.75, 0.62],
          WINDOW_LIT,
          1,
          0.08,
        );
      }
    }
    /* A neon strip low on one wall, which is the other hard-edged source a street has. */
    builder.addBox(
      [side * (ROAD_HALF_WIDTH + 5.0), 1.5, side * 8],
      [0.05, 0.14, 2.2],
      NEON,
      1,
      0.08,
    );
  }

  /*
   * The lamps: a post, an arm and a lens.
   *
   * The lens is emissive and small, which is the condition under test. A large soft source
   * spreads its reflection over enough pixels to resolve; a compact one puts the whole of it
   * into whichever fragment happens to face it, which is where the artefact lives.
   */
  for (const [x, z] of LAMPS) {
    const inward = x < 0 ? 1 : -1;
    builder.setRoughness(0.45);
    builder.addCylinder([x, LAMP_HEIGHT / 2, z], 0.09, LAMP_HEIGHT / 2, 'y', LAMP_POST, 0, 12, 0.3);
    builder.addBox([x + inward * 0.6, LAMP_HEIGHT, z], [0.6, 0.06, 0.06], LAMP_POST, 0, 0.3);
    builder.setRoughness(0.9);
    builder.addBox(
      [x + inward * 1.15, LAMP_HEIGHT - 0.12, z],
      [0.28, 0.06, 0.16],
      LAMP_LENS,
      1,
      0.1,
    );
  }

  builder.setRoughness(null);
  return builder.build();
}

/**
 * The kerbs and the pavement behind them, as a mesh of their own.
 *
 * **Separate from the road because the scale of a relief is pass state, not vertex state.** The
 * amount is per vertex, so one mesh can carry textured and smooth surfaces together; how coarse
 * the bumps are belongs to the material, and one draw states one. Cast concrete is finer than
 * asphalt and shallower, and putting both in one mesh would give the pavement the road's
 * aggregate at the road's size, which reads as one material laid twice. Two draws, two materials,
 * and it is the same mechanism both times.
 */
function buildPavement(): MeshData {
  const builder = new MeshBuilder();
  builder.setRoughness(0.7);
  builder.setGrain(0.2);
  builder.setRelief(0.55);
  for (const side of [-1, 1]) {
    builder.addBox(
      [side * (ROAD_HALF_WIDTH + 0.2), KERB_HEIGHT / 2, 0],
      [0.2, KERB_HEIGHT / 2, ROAD_LENGTH / 2],
      KERB,
      0,
      0.2,
    );
    builder.addBox(
      [side * (ROAD_HALF_WIDTH + 2.6), KERB_HEIGHT / 2, 0],
      [2.4, KERB_HEIGHT / 2, ROAD_LENGTH / 2],
      KERB,
      0,
      0.15,
    );
  }
  builder.setRoughness(null);
  return builder.build();
}

function buildEnvironment(): Environment {
  /*
   * Night, and committed to it. The values are the reporting consumer's, because a rig that
   * reproduces a report at a different exposure is reproducing something else.
   */
  return createEnvironment({
    directionalDir: [-0.35, 0.86, 0.37],
    directionalColor: [0.02, 0.024, 0.04],
    ambient: [0.05, 0.056, 0.08],
    ambientGround: [0.015, 0.015, 0.02],
    emissiveGain: 1,
    nightFactor: 1,
    shadowStrength: 0.85,
    fogColor: [0.024, 0.028, 0.042],
    fogDensity: 0.012,
    fogHeightFalloff: 0.05,
    fogBaseY: 0,
  });
}

/**
 * The subject's own lamps, and they are the condition the street lamps cannot supply.
 *
 * **A headlight sits closer to the bodywork than anything else in a scene ever does**, which is
 * the reporting consumer's own words, and it is why their app widened the source radius for
 * these specifically. A bright compact source a few centimetres from a near-mirror panel moves
 * its reflected image an enormous distance per pixel, so it is the worst case for the artefact
 * this rig exists to hold still.
 *
 * A pair at each end rather than a guessed front. Which direction a bought model faces is not
 * something a scene is told, and for reproducing a sampling artefact it does not matter: what
 * matters is that a small bright source is near the paint.
 */
const SUBJECT_LAMPS: readonly (readonly [number, number, number])[] = [
  [-0.72, 0.62, 2.05],
  [0.72, 0.62, 2.05],
  [-0.72, 0.66, -2.05],
  [0.72, 0.66, -2.05],
];

function buildLights(): PointLightSource[] {
  const own: PointLightSource[] = SUBJECT_LAMPS.map(([x, y, z]) => ({
    x,
    y,
    z,
    r: 3.2,
    g: 3.0,
    b: 2.6,
    radius: 16,
    flicker: 0,
    shadowNear: 0.3,
    /* Wide, matching the consumer's own value, which they raised for exactly this reason. */
    sourceRadius: 0.9,
  }));
  const lamps: PointLightSource[] = LAMPS.map(([x, z]) => ({
    x: x + (x < 0 ? 1.15 : -1.15),
    y: LAMP_HEIGHT - 0.2,
    z,
    r: 2.6,
    g: 2.35,
    b: 1.85,
    radius: 26,
    flicker: 0,
    shadowNear: 0.6,
    /* Small, because a compact source is the condition being reproduced. */
    sourceRadius: 0.18,
  }));
  return [...own, ...lamps];
}

class NightStreetHandle implements DemoHandle {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: RendererApi;

  /** Which backend is actually drawing, asked of the renderer rather than of the address bar. */
  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  /** Whether the device has gone, so a host can remount rather than show a black frame. */
  get lost(): boolean {
    return this.renderer.contextLost;
  }
  private readonly camera = new Camera();
  readonly view = new OrbitView(1.2, 40, 0.2);
  private readonly street: MeshHandle;
  private readonly pavement: MeshHandle;
  /**
   * A wet strip down the carriageway, which is the second thing this rig is for.
   *
   * A consumer asked for a film that can show the scene rather than only shimmer over it, and
   * the reason it is here rather than in the showroom is the same reason the rest of this scene
   * is: a mirror is worth nothing over a lit room and everything under fourteen neon signs.
   */
  private readonly puddles: readonly MeshHandle[];
  /**
   * How much of the mirrored street the film shows, read once and held.
   *
   * `?wet=0` is the control: sheen alone, which is everything a film could do before. Read at
   * mount rather than per frame, because `frame` may not allocate and a `URLSearchParams` is an
   * allocation. The scene gate caught exactly that, which is what it is for.
   */
  private readonly wetOptions: FilmOptions;
  /** How much aggregate the road shows. `?relief=0` is the control. */
  private readonly relief: number;
  private readonly env: Environment;
  private readonly lights: PointLightSource[];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly loader: DrftLoader;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };
  private probeBaked = false;
  private elapsedSec = 0;
  private lastGpuMs = 0;
  private disposed = false;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    const asked = new URLSearchParams(location.search);
    const reliefAsked = asked.get('relief');
    this.relief =
      reliefAsked === null || reliefAsked === ''
        ? 1
        : Math.max(0, Math.min(1, Number(reliefAsked)));
    const wet = asked.get('wet');
    this.wetOptions = {
      reflectionStrength: wet === null || wet === '' ? 0.6 : Math.max(0, Math.min(1, Number(wet))),
      reflectionPlaneY: 0,
    };
    this.street = this.renderer.createMesh(buildStreet());
    this.pavement = this.renderer.createMesh(buildPavement());
    /* Straight down the middle of the road, since a spline is what `buildFilmPatch` takes and
       this street is straight. Three patches so the rim of one is not the whole test. */
    const centre = new Spline(
      [-ROAD_LENGTH / 2, -ROAD_LENGTH / 6, ROAD_LENGTH / 6, ROAD_LENGTH / 2].map((z) => ({
        x: 0,
        y: 0,
        z,
        bankRad: 0,
        widthM: ROAD_HALF_WIDTH * 2,
      })),
    );
    this.puddles = [
      { fromM: 8, toM: 34, centreM: -1.6, halfWidthM: 3.4, seed: 11 },
      { fromM: 36, toM: 58, centreM: 2.1, halfWidthM: 3.0, seed: 27 },
      { fromM: 60, toM: 82, centreM: -0.6, halfWidthM: 3.8, seed: 43 },
    ].map((patch) =>
      this.renderer.createMesh(
        buildFilmPatch(centre, {
          ...patch,
          /* A centimetre clear of the road so it cannot fight it for the depth buffer. The plane
             it mirrors across is still the road's own, which is what `reflectionPlaneY` states. */
          liftM: 0.012,
          color: [0.012, 0.014, 0.018],
        }),
      ),
    );
    this.loader = new DrftLoader(this.renderer, {
      transform: (mesh, material) => paint(mesh, material),
      surface: (material) => {
        const chosen = paintFor(material?.name ?? '');
        return chosen.reflectivity === undefined
          ? undefined
          : { reflectivity: chosen.reflectivity };
      },
      anisotropy: 8,
    });
    this.env = buildEnvironment();
    this.lights = buildLights();
    this.env.lightPositions = this.lightBuffer.positions;
    this.env.lightColors = this.lightBuffer.colors;
    this.env.lightRadii = this.lightBuffer.radii;
    /* The emitter's own size, which is what lets a highlight be as wide as the light is. */
    this.env.lightSourceRadii = this.lightBuffer.sourceRadii;
    this.env.lightWeights = this.lightBuffer.weights;
    this.env.activeLightWorldIndices = this.lightBuffer.sourceIndex;
    this.camera.fovYDeg = 46;
    this.camera.near = 0.3;
    this.camera.far = 220;
    void this.load();
  }

  private async load(): Promise<void> {
    const asked = new URLSearchParams(location.search).get('model');
    const base = asked !== null && /^[A-Za-z0-9 _-]{1,64}$/.test(asked) ? asked : 'car';
    await this.loader.load(`${base}.drft`, { footprint: 5.2, height: 1.6, baseY: 0.01 });
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    /*
     * The rig's own instrument was switched off, which is a poor look for the scene that
     * exists to measure things: `begin` and `end` do nothing on a frame that was never opened,
     * so every GPU figure this scene has ever printed was zero.
     */
    renderer.gpuTimer.beginFrame();
    this.elapsedSec += dtSec;
    this.loader.update(dtSec);

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      /* A slow pass down the near side, which is the angle both reports were shot from. */
      const angle = 0.6 + Math.sin(this.elapsedSec * 0.11) * 0.5;
      const distance = 9.5 + Math.sin(this.elapsedSec * 0.07) * 2;
      camera.position[0] = Math.sin(angle) * distance;
      camera.position[1] = 1.5 + Math.sin(this.elapsedSec * 0.09) * 0.5;
      camera.position[2] = Math.cos(angle) * distance;
      camera.lookAt(0, 0.75, 0);
      this.view.follow(camera, 0, 0.75, 0);
    }
    renderer.resize();
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    if (!this.probeBaked && this.loader.progress.phase === 'ready') {
      this.probeBaked = true;
      renderer.bakeReflectionProbe(PROBE_ORIGIN, this.env.fogColor as Vec3, (probeCamera) => {
        renderer.bindMeshPass(probeCamera, this.env);
        renderer.setSurfaceTexture(null);
        renderer.setSurfaceGrain(1);
        renderer.drawMesh(this.street, IDENTITY);
      });
    }

    /*
     * The scene mirrored in the road, rendered before the frame it appears in.
     *
     * Everything above the road appears twice on a wet street, and that is most of what the look
     * is: without it the neon is a row of coloured dots on black asphalt. The pass draws the same
     * street from the mirrored camera and nothing else, which is enough here because the subject
     * sits on the road rather than over it.
     */
    const mirror = renderer.beginPlanarReflection(camera, 0, this.env.fogColor as Vec3);
    if (mirror !== null) {
      renderer.bindMeshPass(mirror, this.env);
      renderer.setSurfaceTexture(null);
      renderer.setSurfaceGrain(1);
      renderer.drawMesh(this.street, IDENTITY);
      renderer.drawMesh(this.pavement, IDENTITY);
      renderer.endPlanarReflection();
    }

    renderer.beginFrame(this.env.fogColor as Vec3);
    renderer.gpuTimer.begin('rest');
    selectPointLights(
      this.lights,
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
      this.lightBuffer,
      this.elapsedSec,
    );
    this.env.lightCount = this.lightBuffer.count;
    renderer.bindMeshPass(camera, this.env);
    renderer.setSurfaceTexture(null);
    renderer.setSurfaceGrain(1);
    /* Aggregate, roughly sixty bumps to the metre, which is what a road actually has. `?relief=0`
       is the control: the same geometry as a smooth plane. See `Renderer.setSurfaceRelief`. */
    renderer.setSurfaceRelief(this.relief, 60);
    renderer.drawMesh(this.street, IDENTITY);
    /* The same mechanism, a different material: finer bumps and a shallower amount read as cast
       concrete rather than as the road laid twice. */
    renderer.setSurfaceRelief(this.relief * 0.8, 150);
    renderer.drawMesh(this.pavement, IDENTITY);
    renderer.setSurfaceRelief(0);
    this.stats.draws = 2;

    renderer.setSurfaceGrain(0);
    const textures = this.loader.textures;
    for (const part of this.loader.parts) {
      renderer.setSurfaceTexture(part.albedo >= 0 ? (textures?.at(part.albedo) ?? null) : null);
      renderer.setSurfaceReflectivity(part.reflectivity);
      const opacity = part.opacity * part.reveal;
      if (opacity < 1) renderer.drawTranslucentMesh(part.mesh, IDENTITY, opacity);
      else renderer.drawMesh(part.mesh, IDENTITY);
      this.stats.draws++;
    }
    renderer.setSurfaceTexture(null);
    renderer.setSurfaceGrain(1);
    renderer.setSurfaceReflectivity(0);

    /* The wet strip, over the world and under the sheen. See `wetStrength`. */
    for (const puddle of this.puddles) {
      renderer.drawFilm(puddle, camera, this.elapsedSec, this.env, 0.16, this.wetOptions);
      this.stats.draws++;
    }

    /*
     * The bracket closes *after* the resolve rather than before it, which is the difference
     * between measuring the world and measuring the frame. Every screen-space effect this rig
     * exists to compare — the blur, the occlusion, the bloom chain — runs inside `endFrame`,
     * so a bracket that ended first reported the one part of the frame none of them touch.
     */
    renderer.endFrame();
    renderer.gpuTimer.end();
    renderer.gpuTimer.endFrame();
    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    const load = this.loader.progress;
    this.stats.extra =
      load.phase === 'ready'
        ? `${load.partsTotal} parts, reflectivity ${bodyChoice().reflectivity ?? 0}`
        : load.phase === 'absent' || load.phase === 'failed'
          ? load.message
          : `${load.phase}, ${Math.round(load.fraction * 100)}%`;
    return this.stats;
  }

  /**
   * Density, so a host that measures this scene can soften it rather than stop it.
   *
   * A getter rather than a stored object: `this.renderer` is assigned in the constructor body
   * on most of these scenes and a class field would be initialised before it, which would
   * capture `undefined` and fail at the first frame a governor moved.
   */
  get resolution(): ResolutionControl {
    return {
      ceiling: this.renderer.resolutionScale,
      apply: (scale: number): void => this.renderer.applyResolutionScale(scale),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loader.dispose();
    this.renderer.disposeMesh(this.street);
    this.renderer.disposeMesh(this.pavement);
    for (const puddle of this.puddles) this.renderer.disposeMesh(puddle);
    this.renderer.dispose();
  }
}

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  full: {
    /*
     * Four, matching the other scenes, because the rig has to be representative.
     *
     * Eight was measured on this exact frame and it is the demonstration that multisampling is
     * the wrong tool here: speckle above 25 went 320 to 316, while the weaker threshold moved
     * 829 to 758, which is the silhouette pixels it legitimately does fix. `sceneSamples` takes
     * any number a consumer wants and is clamped to the driver's own MAX_SAMPLES; it simply
     * cannot touch a value that varies too fast inside one triangle.
     */
    sceneSamples: 4,
    ambientOcclusion: 0.5,
    ambientOcclusionRadius: 0.35,
    /* 128 a face, matching the reporting consumer rather than this repository's own 256. */
    reflectionProbeSize: 128,
    pointShadows: true,
    /* No water in this scene, so the planar target has to be asked for. */
    planarReflections: true,
  },
  lean: {
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
    pointShadows: false,
    screenEffects: false,
  },
};

export const nightStreet: DemoScene = {
  id: 'night-street',
  title: 'Night street (rig)',
  loadsModel: true,
  note: 'A dark kerbside with four compact lamps and a lacquered black subject, built to reproduce a reported artefact rather than to be looked at. Hold the frame and compare two builds: nothing here is tuned to be pretty, and it is registered as a draft so it stays out of anything published.',
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
    _options: DemoSceneOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(
      canvas,
      { ...PROFILES[budget], ...overrides },
      DEMO_BACKEND,
    );
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    return new NightStreetHandle(renderer, canvas);
  },
};
