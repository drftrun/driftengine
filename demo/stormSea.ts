/**
 * Weather over open water, at the scale a game actually needs it.
 *
 * The court is one lit room and the hillside is one field. This one has no bounds at
 * all: the sea follows the camera to the horizon, the storm above it is made of systems
 * that each know nothing about the others, and all of them answer to the same wind.
 *
 * **What it is composed to show:**
 *
 *   1. **A sea that responds to weather rather than to a slider.** Wave steepness and
 *      whitecaps are derived from wind speed through `seaStateForWind`, so a gust
 *      builds the surface and a lull settles it. Nothing here animates the water
 *      directly.
 *   2. **Lightning that is geometry.** Each arc is a real polyline, displaced by
 *      recursive midpoint subdivision, redrawn several times a second while it lives.
 *      It lights the scene as it strikes, because the strike also drives a point light.
 *   3. **Rain, as a lattice that follows the camera.** Streaks are placed in a box that
 *      travels with the viewer, so a storm covers an unbounded ocean for a fixed cost.
 *   4. **Birds that are not sprites.** Two crossed cards each, beating on their own
 *      phase, leaning into the wind.
 *
 * Everything above is drawn with what the engine already has. There is no storm system:
 * there is a wind field, and six components reading it.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  BoltPool,
  Camera,
  MeshBuilder,
  ParticlePool,
  TAU,
  advanceWindField,
  buildLightVolume,
  clamp,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  createWindField,
  mulberry32,
  selectPointLights,
} from '../packages/core/src/index';
import type {
  BoltHandle,
  Environment,
  FlockHandle,
  FlockParams,
  MeshHandle,
  MeshData,
  ParticleHandle,
  PointLightSource,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  SkyColors,
  Vec3,
  WaterBody,
  WaterHandle,
  WindProfile,
  WindStreakHandle,
} from '../packages/core/src/index';

/* -- The world ------------------------------------------------------------- */

const SEA_LEVEL_M = 0;
/** A stack of rock, so the sea has something to break the horizon with. */
const STACK_X_M = 6;
const STACK_Z_M = -14;
/** The tower: where it starts, how tall, and where the lamp ends up. */
const TOWER_BASE_M = -1;
const TOWER_HEIGHT_M = 15.5;
/** The lamp, which is where the arcs are aimed and where the optic turns. */
const BEACON_Y_M = TOWER_BASE_M + TOWER_HEIGHT_M + 1.35;
/** Seconds for one full turn of the optic. Slow, as a real one is. */
const OPTIC_SECONDS = 9;
/** How far the beam reaches before it has dimmed into the rain. */
const BEAM_LENGTH_M = 90;
/**
 * How much of the beam's authored light reaches the frame.
 *
 * A constant because this scene holds one time of day: `nightFactor` is fixed at 0.55, a
 * permanent dusk, so there is no dawn for the lamp to fade up out of. A scene with a clock
 * would drive this from it.
 */
const BEAM_STRENGTH = 0.65;
/**
 * How wide the beam opens, as half-width over distance.
 *
 * 0.09 is about five degrees either side of the axis, so eight metres across at the far end.
 * A real optic throws a tighter fan; at 0.055, which is closer to one, the beam read as a
 * drawn line rather than as a shaft of light from the thirty metres away this camera orbits at.
 * Width is what makes it a volume on screen.
 */
const BEAM_SPREAD = 0.09;

/** Where an arc starts: a cloud base, high enough that the whole strike is in frame. */
const CLOUD_BASE_M = 62;
/** Seconds between strikes, and how much of that is random. */
const STRIKE_EVERY_SEC = 3.4;
const STRIKE_JITTER_SEC = 2.6;

const ORBIT_SECONDS = 96;
const ORBIT_RADIUS_M = 34;
const ORBIT_HEIGHT_M = 7.5;

/* -- Palette --------------------------------------------------------------- */

const ROCK: Vec3 = [0.14, 0.145, 0.16];
const ROCK_WET: Vec3 = [0.09, 0.1, 0.115];
const BEACON_GLOW: Vec3 = [1, 0.58, 0.24];
const BEACON_LIGHT: Vec3 = [1, 0.54, 0.2];
const TOWER_PALE: Vec3 = [0.62, 0.62, 0.6];
const TOWER_BAND: Vec3 = [0.3, 0.11, 0.1];
/** Warm, and paler than the lamp itself: what is being seen is rain, not the filament. */
const BEAM_COLOR: Vec3 = [1, 0.86, 0.62];
/** What a strike puts into the world while it lasts. Cold, so it reads as electrical. */
const STRIKE_LIGHT: Vec3 = [0.72, 0.82, 1];
const BOLT_CORE: Vec3 = [1, 1, 1];
const BOLT_EDGE: Vec3 = [0.55, 0.68, 1];
const RAIN_TINT: Vec3 = [0.78, 0.84, 0.95];
const BIRD_TINT: Vec3 = [0.1, 0.11, 0.13];

/**
 * A real blow: enough wind that the sea is near fully developed and breaking.
 *
 * `seaStateForWind` saturates at 7 m/s, so a base near that keeps the surface built up
 * while the gust still moves it either side of the threshold. The steadiness matters
 * more than the number: a storm that changed its mind every few seconds would look
 * authored rather than observed.
 */
const WIND: WindProfile = {
  directionX: -0.64,
  directionZ: 0.77,
  baseSpeed: 6.4,
  gustSpeed: 3.1,
  directionWander: 0.22,
  cycleSeconds: 53,
  phase: 0,
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The lighthouse and its rock: everything in this scene that holds still. */
function buildLighthouse(random: () => number): MeshData {
  const builder = new MeshBuilder();

  /*
   * The rock it stands on, which is a low shelf rather than a mountain.
   *
   * This was a stack of twelve shrinking slabs standing thirteen metres out of the sea,
   * and it read as a stepped pyramid with a lamp balanced on it. The building is the
   * subject; the rock only has to explain why there is a building in the middle of the
   * water, and a metre or two of broken shelf does that.
   */
  builder.setRoughness(0.8);
  /* Sea rock, and the only mineral surface in this scene. */
  builder.setGrain(0.9);
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * TAU + random() * 0.4;
    const reach = 3.4 + random() * 2.6;
    const y = -1.6 + random() * 0.9;
    const wet = clamp(1 - (y + 1.2) / 2.2, 0, 1);
    builder.addBox(
      [STACK_X_M + Math.cos(angle) * reach * 0.45, y, STACK_Z_M + Math.sin(angle) * reach * 0.45],
      [reach * 0.55, 1.5 + random() * 0.6, reach * 0.5],
      [
        ROCK[0] + (ROCK_WET[0] - ROCK[0]) * wet,
        ROCK[1] + (ROCK_WET[1] - ROCK[1]) * wet,
        ROCK[2] + (ROCK_WET[2] - ROCK[2]) * wet,
      ],
      0,
      0.25 + wet * 0.45,
    );
  }

  /*
   * The tower: stacked cylinders that narrow, in bands.
   *
   * A lighthouse is painted in bands so it can be told from every other white tower on
   * a coast, and that is exactly what makes it read at this distance and in this light:
   * the bands give the taper something to be measured against. A plain white column
   * would be a shape, and this has to be a building.
   */
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const t = i / bands;
    const y = TOWER_BASE_M + (TOWER_HEIGHT_M / bands) * (i + 0.5);
    const radius = 2.5 - t * 1.05;
    builder.setRoughness(0.55);
    /*
     * And no grain above this line. The tower is painted masonry: rough, because paint on
     * rendered brick scatters a highlight widely, and entirely without visible mineral
     * structure, because the paint is what you are looking at. It took 55% grain for as
     * long as grain was weighted by roughness, and a white painted building read as marble.
     */
    builder.setGrain(0);
    builder.addCylinder(
      [STACK_X_M, y, STACK_Z_M],
      radius,
      TOWER_HEIGHT_M / bands / 2,
      'y',
      i % 2 === 0 ? TOWER_PALE : TOWER_BAND,
      0,
      22,
      0.2,
    );
  }

  /* The gallery: a ring that steps out under the lamp room, with a rail on it. */
  const galleryY = TOWER_BASE_M + TOWER_HEIGHT_M;
  builder.setRoughness(0.45);
  builder.addCylinder([STACK_X_M, galleryY, STACK_Z_M], 2.05, 0.16, 'y', ROCK_WET, 0, 24, 0.35);
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * TAU;
    builder.addBox(
      [STACK_X_M + Math.cos(angle) * 1.9, galleryY + 0.5, STACK_Z_M + Math.sin(angle) * 1.9],
      [0.06, 0.35, 0.06],
      ROCK_WET,
      0,
      0.4,
    );
  }
  builder.addCylinder(
    [STACK_X_M, galleryY + 0.86, STACK_Z_M],
    1.98,
    0.05,
    'y',
    ROCK_WET,
    0,
    24,
    0.4,
  );

  /* The lamp room, and the light inside it. */
  const lampY = galleryY + 1.35;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TAU;
    builder.addBox(
      [STACK_X_M + Math.cos(angle) * 1.35, lampY, STACK_Z_M + Math.sin(angle) * 1.35],
      [0.09, 1.05, 0.09],
      ROCK_WET,
      0,
      0.45,
    );
  }
  builder.setRoughness(0.2);
  builder.setEmissiveColor(BEACON_GLOW);
  builder.addCylinder([STACK_X_M, lampY, STACK_Z_M], 1.05, 0.85, 'y', BEACON_GLOW, 1, 20);
  builder.setEmissiveColor(null);

  /* The roof and the finial above it. */
  builder.setRoughness(0.4);
  builder.addCylinder([STACK_X_M, lampY + 1.2, STACK_Z_M], 1.5, 0.18, 'y', ROCK_WET, 0, 24, 0.4);
  builder.addCylinder([STACK_X_M, lampY + 1.6, STACK_Z_M], 0.85, 0.3, 'y', ROCK_WET, 0, 18, 0.4);
  builder.addCylinder([STACK_X_M, lampY + 2.1, STACK_Z_M], 0.09, 0.35, 'y', ROCK_WET, 0, 8, 0.5);

  builder.setRoughness(null);
  return builder.build();
}

/**
 * The optic inside the lamp room, built about the lamp and offset along +Z so the same yaw
 * turns it.
 *
 * A lighthouse lamp is a lens assembly that rotates, and the beam is what it throws. Both are
 * built in this same local space and drawn with the same matrix, so the two cannot drift out
 * of step: a beam sweeping while the lens behind it sits still is the tell that they are
 * unrelated objects, which is what they used to be.
 */
function buildOptic(): MeshData {
  const builder = new MeshBuilder();
  builder.setEmissiveColor(BEACON_GLOW);
  builder.setRoughness(0.2);
  builder.addBox([0, 0, 0.52], [0.3, 0.62, 0.26], BEACON_GLOW, 1);
  builder.setEmissiveColor(null);
  return builder.build();
}

/**
 * The beam the optic throws, in the optic's own local space so one matrix turns both.
 *
 * `buildLightVolume` takes the same length and aperture the draw call is given, which is the
 * point of it: the panes and the falloff cannot disagree, because they are the same two
 * numbers. This scene wrote the loop by hand until the engine grew the helper, and the first
 * version of it cut each pane into eight segments with falling emissive — `MeshBuilder` states
 * one emissive per quad, so building a gradient into geometry means building it out of steps.
 * The gradient belongs to the shader.
 *
 * The beam starts a metre out rather than at the lamp, because the optic itself is drawn there
 * and light emerging from inside a solid box reads as a leak.
 */
function buildBeam(): MeshData {
  return buildLightVolume({
    nearM: 1.1,
    lengthM: BEAM_LENGTH_M,
    spread: BEAM_SPREAD,
    color: BEAM_COLOR,
  });
}

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  full: {
    /*
     * Four samples. The one place a demo deliberately asks for *more* than the engine
     * default, because the default is 1 only so that no scene written before multisampling
     * existed changes by a bit — not because 1 is the right look. These scenes are what the
     * engine is judged on, and a panel gap or a trim edge seen at a shallow angle is a
     * staircase without it.
     */
    sceneSamples: 4,
    pointShadowFaceSize: 256,
    // An ocean under a storm reflects a sky that is nearly uniform grey, so a full
    // planar pass would buy a difference nobody can see for a second scene submission.
    waterReflections: false,
  },
  lean: {
    directionalShadows: false,
    pointShadows: false,
    waterReflections: false,
    screenEffects: false,
    waterResolution: 64,
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
  },
};

class StormSeaHandle implements DemoHandle {
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
  /** Handed out through the contract, so a viewer can take the camera at any time. */
  readonly view = new OrbitView(8, 120, 1.6);
  private readonly tower: MeshHandle;
  private readonly optic: MeshHandle;
  /** What the optic throws, on the optic's own matrix. See `buildBeam`. */
  private readonly beam: MeshHandle;
  /** Rebuilt in place every frame: a yaw about the lamp, and nothing else. */
  /** The optic's yaw, rewritten in place each frame rather than reallocated. */
  private readonly opticModel = new Float32Array(IDENTITY);
  private readonly water: WaterHandle;
  private readonly streaks: WindStreakHandle;
  private readonly flock: FlockHandle;
  private readonly bolts: BoltPool;
  private readonly boltBatch: BoltHandle;
  private readonly spray: ParticlePool;
  private readonly sprayBatch: ParticleHandle;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly body: WaterBody;
  private readonly lights: PointLightSource[];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly wind = createWindField();
  private readonly flockParams: FlockParams;
  private readonly random: () => number;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };

  private elapsedSec = 0;
  private nextStrikeSec = 1.2;
  /** How lit the sky still is from the last strike, 0 to 1. */
  private flash = 0;
  private nextSpraySec = 0;
  private disposed = false;
  private lastGpuMs = 0;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    const renderer_ = renderer;
    this.random = mulberry32(0x51e_a570);

    this.tower = renderer.createMesh(buildLighthouse(this.random));
    this.optic = renderer.createMesh(buildOptic());
    this.beam = renderer.createMesh(buildBeam());
    // A near sheet of real waves and a flat skirt beyond it, which is what lets an
    // ocean reach the horizon without tessellating the whole of it.
    this.water = renderer.createWater(undefined, 420, 3200);
    this.streaks = renderer.createWindStreaks({
      count: 4200,
      // Tighter than the default box: rain has to be dense enough near the camera to
      // read as falling water rather than as drifting specks, and the lattice is what
      // decides that. It travels with the viewer, so the count is the whole cost.
      cellSize: 30,
      onsetSpeed: 1.2,
      fullSpeed: 4.5,
    });
    this.flock = renderer.createFlock(34);
    this.bolts = new BoltPool({
      capacity: 4,
      // `2^k + 1`, which is what midpoint subdivision lands on exactly.
      nodes: 33,
      lifeSec: 0.42,
      jitter: 0.16,
      // Redrawn while it lives, so an arc flickers along its own length rather than
      // hanging in the air as a fixed shape.
      restrikeHz: 22,
    });
    this.boltBatch = renderer.createBolts(4 * 33, 'demo-bolts');

    /*
     * Spray, and the second attempt at it.
     *
     * The first was alpha blended and grew from 0.22 m to 0.7 m over a second and a half.
     * A particle drawn like that is *lit*, and this is a night scene with almost no light
     * in it, so a burst of them read as a cluster of large dark bubbles sitting on the
     * water. That is the same trap the sea itself fell into: anything shaded by ambient
     * alone at night is black, whatever colour it was given.
     *
     * Additive fixes it at the root rather than by brightening the colour. Spray thrown
     * up by a lightning strike is lit *by* the strike, so it should add light to the
     * frame rather than occlude what is behind it, and additive geometry cannot go dark
     * because there is nothing to shade. Smaller, shorter lived and fewer per burst, so
     * it reads as water thrown into the air rather than as a shape appearing.
     */
    this.spray = new ParticlePool({
      capacity: 480,
      lifeSec: 0.9,
      sizeStart: 0.1,
      sizeEnd: 0.03,
      colorStart: [0.75, 0.85, 1],
      colorEnd: [0.16, 0.24, 0.4],
      gravity: 13,
      drag: 1.4,
      rise: 0,
      alphaStart: 0.9,
      alphaEnd: 0,
    });
    this.sprayBatch = renderer.createParticles(480, {
      material: 'spark',
      blend: 'additive',
      // Stretched along its own travel, so a fast grain is a streak of water rather
      // than a dot that happens to be moving.
      stretchSec: 0.045,
      coreGain: 1.4,
    });

    this.env = createEnvironment({
      // A storm has no sun to speak of; what light there is arrives from everywhere.
      directionalDir: [-0.28, 0.86, 0.42],
      directionalColor: [0.34, 0.37, 0.42],
      ambient: [0.2, 0.23, 0.28],
      ambientGround: [0.11, 0.13, 0.16],
      emissiveGain: 0.85,
      nightFactor: 0.55,
      fogColor: [0.26, 0.29, 0.34],
      fogDensity: 0.011,
      fogHeightFalloff: 0.012,
      fogBaseY: 0,
    });
    this.env.lightPositions = this.lightBuffer.positions;
    this.env.lightColors = this.lightBuffer.colors;
    this.env.lightRadii = this.lightBuffer.radii;
    /* The emitter's own size, which is what lets a highlight be as wide as the light is. */
    this.env.lightSourceRadii = this.lightBuffer.sourceRadii;
    this.env.lightWeights = this.lightBuffer.weights;
    this.env.activeLightWorldIndices = this.lightBuffer.sourceIndex;

    this.sky = {
      top: [0.1, 0.12, 0.16],
      horizon: [0.34, 0.36, 0.4],
      deep: [0.06, 0.07, 0.1],
      sunDir: [0, -1, 0],
      sunColor: [0, 0, 0],
      sunAngularRadius: 0.0046,
      moonDir: [0, -1, 0],
      moonColor: [0, 0, 0],
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0.55,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };

    this.body = {
      level: SEA_LEVEL_M,
      deepColor: [0.028, 0.045, 0.06],
      shallowColor: [0.08, 0.12, 0.14],
      // An ocean hides its own floor, and reflects by Fresnel alone. A basin may cheat;
      // the sea may not, which is why `mirror` is absent here and generous next door.
      density: 0.9,
      visibility: 1,
      waveScale: 1,
    };

    /*
     * Two lights: the beacon, always on, and the strike, which exists only while an arc
     * does. The second is the point — a flash that lit the sky but left the rock and the
     * sea unlit would read as a texture animating rather than as lightning.
     */
    this.lights = [
      {
        x: STACK_X_M,
        y: BEACON_Y_M,
        z: STACK_Z_M,
        r: BEACON_LIGHT[0],
        g: BEACON_LIGHT[1],
        b: BEACON_LIGHT[2],
        radius: 26,
        flicker: 0.1,
        shadowNear: 0.3,
        sourceRadius: 0.3,
      },
      {
        x: STACK_X_M,
        y: CLOUD_BASE_M * 0.45,
        z: STACK_Z_M,
        r: 0,
        g: 0,
        b: 0,
        radius: 0,
        flicker: 0,
        shadowNear: 1,
        sourceRadius: 6,
        // A light that changes its radius every frame invalidates its own cubemap every
        // frame, and would starve every other light of bake budget forever.
        castsShadow: false,
      },
    ];

    /*
     * A tighter ring, further off and higher, so the flock has less depth in it.
     *
     * A bird is a flat shape, so how big it looks depends on how far away it is *and* on
     * where it happens to be pointing — measured at 2.1x from distance and about 3x
     * from heading, which multiply to the one bird that reads as giant while the rest are
     * specks. The heading part is what a flat bird is; the distance part is this ring
     * being 22 m across while the near edge of it was barely half as far away as the far
     * edge. Pulling it in and pushing it out takes that from 2.1x to about 1.6x.
     */
    this.flockParams = {
      center: [-18, 30, -14],
      radius: 15,
      height: 6,
      count: 34,
      speed: 9,
      /*
       * Half the wingspan, so these are 1.6 m tip to tip: a big gull in a gale. It was 1.5,
       * which is 3 m and an albatross, because the parameter documented itself as the whole
       * wingspan. At that size the one bird in the flock not foreshortened read as giant.
       */
      scale: 0.8,
    };

    this.camera.fovYDeg = 55;
    this.camera.near = 0.4;
    this.camera.far = 900;

    renderer.resize();
    renderer.prepareStaticPointShadows(this.lights);
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;

    this.elapsedSec += dtSec;
    const now = this.elapsedSec;
    this.stats.draws = 0;

    renderer.resize();
    advanceWindField(this.wind, WIND, now, dtSec, 1);

    this.strike(dtSec);
    this.bolts.update(dtSec);
    this.spray.update(dtSec);

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      const angle = (now / ORBIT_SECONDS) * TAU;
      camera.position[0] = Math.sin(angle) * ORBIT_RADIUS_M;
      camera.position[1] = ORBIT_HEIGHT_M + Math.sin(now * 0.31) * 1.1;
      camera.position[2] = Math.cos(angle) * ORBIT_RADIUS_M;
      camera.lookAt(STACK_X_M * 0.4, 5.5, STACK_Z_M * 0.4);
      this.view.follow(camera, STACK_X_M * 0.4, 5.5, STACK_Z_M * 0.4);
    }
    // A roll that answers to the gust. It is the cheapest thing in the scene and it is
    // most of why the weather is felt rather than merely seen.
    camera.roll = this.wind.gust * 0.035;
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    const env = this.env;
    selectPointLights(
      this.lights,
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
      this.lightBuffer,
      now,
    );
    env.lightCount = this.lightBuffer.count;

    this.sky.cloudOffsetX = this.wind.driftX;
    this.sky.cloudOffsetZ = this.wind.driftZ;

    renderer.gpuTimer.beginFrame();
    renderer.beginFrame(this.sky.horizon);
    renderer.gpuTimer.begin('rest');

    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.tower, IDENTITY);
    this.stats.draws++;
    renderer.drawSky(camera, this.sky, env);
    this.stats.draws++;

    renderer.drawWater(
      this.water,
      camera,
      now,
      this.body,
      env,
      this.wind.velocityX,
      this.wind.velocityZ,
    );
    this.stats.draws++;

    renderer.drawFlock(
      this.flock,
      camera,
      now,
      this.flockParams,
      BIRD_TINT,
      this.wind.velocityX,
      this.wind.velocityZ,
    );
    this.stats.draws++;

    /*
     * The optic, turned by writing four numbers into a matrix that already exists.
     *
     * A yaw about the lamp is the whole transform, so the model is built once and only
     * its rotation block is rewritten.
     */
    const sweep = (now / OPTIC_SECONDS) * TAU;
    const cos = Math.cos(sweep);
    const sin = Math.sin(sweep);
    const model = this.opticModel;
    model[0] = cos;
    model[2] = -sin;
    model[8] = sin;
    model[10] = cos;
    model[12] = STACK_X_M;
    model[13] = BEACON_Y_M;
    model[14] = STACK_Z_M;
    renderer.drawMesh(this.optic, model);
    this.stats.draws++;

    /*
     * And the beam, on the same matrix, so the light and the lens that throws it turn as one
     * object. `drawLightVolume` rather than a mesh draw: this is light in the air rather than a
     * surface, and drawing it as a surface is what put a dark wedge across this frame for a
     * whole session. See the method, and AGENTS.md 2026-08-10.
     */
    renderer.drawLightVolume(this.beam, model, camera, BEAM_STRENGTH, BEAM_LENGTH_M, BEAM_SPREAD);
    this.stats.draws++;

    renderer.drawParticles(this.sprayBatch, this.spray.particles, camera, env, now);
    this.stats.draws++;

    renderer.drawBolts(
      this.boltBatch,
      this.bolts.segments,
      camera,
      env,
      now,
      BOLT_CORE,
      BOLT_EDGE,
      0.17,
      3.6,
    );
    this.stats.draws++;

    // Last of the transparent passes: rain is in front of everything, including the arc.
    renderer.drawWindStreaks(this.streaks, camera, this.wind, now, RAIN_TINT, env);
    this.stats.draws++;

    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;

    return this.stats;
  }

  /**
   * Fire an arc when one is due, and carry the light it leaves behind.
   *
   * The flash decays on its own clock rather than following the arc's lifetime, because
   * what a strike does to a scene outlasts the filament by a good fraction of a second.
   * Driving the point light from that decay is what puts the strike *in* the world.
   */
  private strike(dtSec: number): void {
    this.flash = Math.max(0, this.flash - dtSec * 3.2);

    if (this.elapsedSec >= this.nextStrikeSec) {
      const random = this.random;
      const spread = 26;
      const x = STACK_X_M + (random() - 0.5) * spread;
      const z = STACK_Z_M + (random() - 0.5) * spread;
      // Aimed at the beacon roughly one time in three: a storm that hit the same rock
      // every time would read as a scripted effect rather than as weather.
      const hitsBeacon = random() < 0.34;
      this.bolts.strike(
        x,
        CLOUD_BASE_M,
        z,
        hitsBeacon ? STACK_X_M : x,
        hitsBeacon ? BEACON_Y_M : SEA_LEVEL_M,
        hitsBeacon ? STACK_Z_M : z,
        random() * 1000,
        0.75 + random() * 0.5,
        0.7 + random() * 0.8,
      );
      this.flash = 1;
      this.nextStrikeSec = this.elapsedSec + STRIKE_EVERY_SEC + random() * STRIKE_JITTER_SEC;

      // Spray where it met the water, thrown along the wind.
      if (!hitsBeacon) {
        // A tight cone rather than a hemisphere: water struck from above goes up and
        // outward, and a burst spread evenly in every direction reads as an explosion.
        for (let i = 0; i < 26; i++) {
          const speed = 2 + random() * 4.5;
          const bearing = random() * TAU;
          this.spray.emit(
            x,
            SEA_LEVEL_M + 0.15,
            z,
            Math.cos(bearing) * speed + this.wind.velocityX * 0.4,
            6 + random() * 7,
            Math.sin(bearing) * speed + this.wind.velocityZ * 0.4,
            random(),
          );
        }
      }
    }

    const light = this.lights[1];
    if (light === undefined) return;
    const strength = this.flash * this.flash;
    light.r = STRIKE_LIGHT[0] * strength * 2.4;
    light.g = STRIKE_LIGHT[1] * strength * 2.4;
    light.b = STRIKE_LIGHT[2] * strength * 2.4;
    light.radius = strength > 0.01 ? 150 : 0;
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
    this.renderer.disposeMesh(this.tower);
    /* Geometry goes back through the renderer, which is backend-neutral and always runs. */
    this.renderer.disposeMesh(this.optic);
    this.renderer.disposeMesh(this.beam);
    this.renderer.disposeWindStreaks(this.streaks);
    this.renderer.disposeFlock(this.flock);
    this.renderer.disposeBolts(this.boltBatch);
    this.renderer.disposeWater(this.water);
    this.renderer.disposeParticles(this.sprayBatch);
    this.renderer.dispose();
  }
}

export const stormSea: DemoScene = {
  id: 'storm-sea',
  title: 'Storm at sea',
  note: 'An unbounded ocean whose waves are built by the wind that is blowing, a lighthouse whose optic turns through the rain, lightning that lights what it strikes, and a flock leaning into the gust.',
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(
      canvas,
      { ...PROFILES[budget], ...overrides },
      DEMO_BACKEND,
    );
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    return new StormSeaHandle(renderer, canvas);
  },
};
