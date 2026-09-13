/**
 * A whole day in ninety seconds: sunrise, noon, dusk, moonrise, and back.
 *
 * Every other scene here is fixed at one hour. This one is about the hour itself, which
 * is a system rather than a palette: the sun and the moon are placed by a clock, the sky
 * is derived from where they are, and everything else in the frame follows from that
 * without being told about it.
 *
 * **What it is composed to show:**
 *
 *   1. **Shadows that are evidence of a position.** The colonnade's shadows sweep
 *      through a hundred and eighty degrees and lengthen at both ends of the day,
 *      because the light matrix is fitted to a direction the clock produced. Nothing
 *      animates a shadow here; the sun moves and the shadow is a consequence.
 *   2. **A sky that is not a gradient with a time-of-day slider.** Twilight is a band
 *      the clock passes through, and the switch between sun and moon happens inside it.
 *   3. **Lamps that come on because it got dark.** Emissive strength and the lamps'
 *      own output are driven by the same night factor the sky uses, so the moment they
 *      light is the moment the sky says it is dark rather than a separate cue.
 *   4. **A moon with a phase.** Its illuminated fraction comes from a lunar cycle, so
 *      the same clock a month later gives a different moon.
 *
 * The clock is fed a timestamp this scene owns rather than the wall clock, which is the
 * distinction `celestialStateAt` is documented around: a world may run on real time, and
 * anything deterministic must not.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  MeshBuilder,
  TAU,
  celestialStateAt,
  clamp,
  computeLightMatrix,
  createCelestialState,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  lerp,
  mixColorInto,
  moonIllumination,
  mulberry32,
  selectPointLights,
} from '../packages/core/src/index';
import type { RenderBackend, RendererApi } from '../packages/core/src/index';
import type {
  CelestialSite,
  CelestialState,
  Environment,
  MeshHandle,
  MeshData,
  PointLightSource,
  RenderQualityOptions,
  ShadowCasters,
  SkyColors,
  Vec3,
} from '../packages/core/src/index';

/* -- The set, in metres ---------------------------------------------------- */

const GROUND_HALF_M = 40;
const SLAB_M = 2.5;
/** A colonnade in a line rather than a ring: shadows want somewhere long to fall. */
const PILLAR_COUNT = 9;
const PILLAR_SPACING_M = 3.4;
const PILLAR_HEIGHT_M = 6.2;
/** Lamps between the pillars, which is what the evening is for. */
const LAMP_HEIGHT_M = 2.9;

/** How long the day takes. Long enough to watch, short enough to see it turn. */
const DAY_SECONDS = 90;
/** Where the day starts, in hours, so the scene opens in the light rather than at 3am. */
const START_HOUR = 8.5;
/** Which bearing the sun rises on. Authored rather than derived: it is a set decision. */
const SUN_AZIMUTH = 0.9;

const ORBIT_SECONDS = 74;
const ORBIT_RADIUS_M = 21;

/* -- Palette --------------------------------------------------------------- */

const STONE: Vec3 = [0.44, 0.42, 0.39];
const STONE_DARK: Vec3 = [0.33, 0.32, 0.3];
const PILLAR: Vec3 = [0.55, 0.53, 0.49];
const IRON: Vec3 = [0.1, 0.1, 0.11];
const LAMP_GLOW: Vec3 = [1, 0.74, 0.4];
const LAMP_LIGHT: Vec3 = [1, 0.68, 0.33];

/* Sky at the two extremes. The clock decides where between them the frame sits. */
const DAY_SKY = {
  top: [0.19, 0.38, 0.72] as Vec3,
  horizon: [0.72, 0.78, 0.84] as Vec3,
  deep: [0.11, 0.26, 0.56] as Vec3,
};
const NIGHT_SKY = {
  top: [0.012, 0.018, 0.042] as Vec3,
  horizon: [0.055, 0.07, 0.11] as Vec3,
  deep: [0.008, 0.011, 0.026] as Vec3,
};

const DAY_AMBIENT: Vec3 = [0.4, 0.44, 0.53];
const NIGHT_AMBIENT: Vec3 = [0.055, 0.066, 0.095];
const DAY_GROUND: Vec3 = [0.3, 0.285, 0.26];
const NIGHT_GROUND: Vec3 = [0.03, 0.033, 0.042];
const SUN_COLOR: Vec3 = [1.2, 1.05, 0.82];
const MOON_LIGHT: Vec3 = [0.16, 0.2, 0.3];
const DAY_FOG: Vec3 = [0.66, 0.71, 0.78];
const NIGHT_FOG: Vec3 = [0.035, 0.043, 0.062];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Milliseconds in a day, so a fraction of the cycle becomes a wall-clock time. */
const MS_PER_DAY = 86_400_000;

function buildSet(): MeshData {
  const builder = new MeshBuilder();
  const random = mulberry32(0xda_9c_10c);

  /*
   * A solid base under the paving, then the slabs on top of it.
   *
   * The slabs are laid with a gap so a low sun has joints to rake across, and without
   * something underneath, those gaps are holes: the first version showed the sky through
   * the floor as a grid of black lines with a blue sliver where the horizon lined up.
   * A joint is a shadow between two stones, which needs a stone underneath.
   */
  builder.setRoughness(0.9);
  /* Everything from here to the lamps is cut stone, so all of it is genuinely mineral. */
  builder.setGrain(0.85);
  builder.addBox([0, -0.35, 0], [GROUND_HALF_M, 0.2, GROUND_HALF_M], STONE_DARK, 0, 0.1);

  builder.setRoughness(0.85);
  const steps = Math.ceil((GROUND_HALF_M * 2) / SLAB_M);
  for (let ix = 0; ix < steps; ix++) {
    for (let iz = 0; iz < steps; iz++) {
      const cx = -GROUND_HALF_M + (ix + 0.5) * SLAB_M;
      const cz = -GROUND_HALF_M + (iz + 0.5) * SLAB_M;
      const shade = 0.9 + random() * 0.2;
      builder.addBox(
        [cx, -0.1, cz],
        [SLAB_M / 2 - 0.04, 0.1, SLAB_M / 2 - 0.04],
        [STONE[0] * shade, STONE[1] * shade, STONE[2] * shade],
      );
    }
  }

  /* The colonnade, and a stylobate under it. */
  const runHalf = ((PILLAR_COUNT - 1) * PILLAR_SPACING_M) / 2 + 1.6;
  builder.addBox([0, 0.16, 0], [runHalf, 0.16, 2.2], STONE_DARK, 0, 0.2);
  for (let i = 0; i < PILLAR_COUNT; i++) {
    const x = (i - (PILLAR_COUNT - 1) / 2) * PILLAR_SPACING_M;
    builder.setRoughness(0.7);
    builder.addBox([x, 0.42, 0], [0.55, 0.14, 0.55], PILLAR, 0, 0.2);
    builder.addCylinder(
      [x, PILLAR_HEIGHT_M / 2 + 0.56, 0],
      0.36,
      PILLAR_HEIGHT_M / 2,
      'y',
      PILLAR,
      0,
      16,
      0.2,
    );
    builder.addBox([x, PILLAR_HEIGHT_M + 0.68, 0], [0.55, 0.16, 0.55], PILLAR, 0, 0.2);
  }
  // The architrave across the top, which is what turns nine posts into a building.
  builder.addBox([0, PILLAR_HEIGHT_M + 1.0, 0], [runHalf, 0.2, 0.75], STONE_DARK, 0, 0.2);

  /* Lamps, out in front of the colonnade where their light has floor to fall on. */
  builder.setRoughness(0.4);
  /* Cast and painted iron, which is manufactured and has no grain to show. */
  builder.setGrain(0);
  for (let i = 0; i < PILLAR_COUNT - 1; i++) {
    const x = (i - (PILLAR_COUNT - 2) / 2) * PILLAR_SPACING_M;
    const z = 5.4;
    builder.addBox([x, 0.12, z], [0.22, 0.12, 0.22], IRON, 0, 0.4);
    builder.addCylinder([x, LAMP_HEIGHT_M / 2, z], 0.055, LAMP_HEIGHT_M / 2, 'y', IRON, 0, 8, 0.5);
    builder.addBox([x, LAMP_HEIGHT_M + 0.28, z], [0.2, 0.04, 0.2], IRON, 0, 0.5);
    builder.setEmissiveColor(LAMP_GLOW);
    builder.addBox([x, LAMP_HEIGHT_M, z], [0.13, 0.2, 0.13], LAMP_GLOW, 1);
    builder.setEmissiveColor(null);
  }

  builder.setRoughness(null);
  return builder.build();
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
    water: false,
    waterReflections: false,
    pointShadowFaceSize: 256,
    pointShadowFacesPerFrame: 2,
    /*
     * Wider than the default, and this scene is why the setting exists.
     *
     * A directional shadow is dropped once it projects further than this per metre of
     * height, because a sun near the horizon throws shadows to infinity and the map runs
     * out. A day that ends at sunrise and sunset spends real time there, so the limit
     * has to be generous or the shadows vanish exactly when they are most interesting.
     */
    directionalShadowMaxSlope: 9,
  },
  lean: {
    water: false,
    waterReflections: false,
    pointShadows: false,
    screenEffects: false,
    shadowFilterTaps: 4,
    directionalShadowMapSize: 1024,
    directionalShadowMaxSlope: 9,
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
  },
};

/** `?lat=` and `?day=` off the address bar, or nothing at all. See `DayClockHandle.site`. */
function readSite(): CelestialSite | undefined {
  const asked = new URLSearchParams(location.search);
  const latitude = asked.get('lat');
  if (latitude === null || !Number.isFinite(Number(latitude))) return undefined;
  const day = asked.get('day');
  return {
    latitudeDeg: Number(latitude),
    ...(day !== null && Number.isFinite(Number(day)) ? { dayOfYear: Number(day) } : {}),
  };
}

class DayClockHandle implements DemoHandle {
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
  readonly view = new OrbitView(6, 70, 0.6);
  private readonly set: MeshHandle;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly celestial: CelestialState = createCelestialState();
  /**
   * Where in the world this sky is, or nothing — which is the model the scene was authored against.
   *
   * **Read once at mount**, because `frame` may not allocate and a `URLSearchParams` is an
   * allocation. Absent by default, so the published capture of this scene is the one it has always
   * been; `?lat=69.6&day=172` is a midnight sun and `?lat=69.6&day=355` a polar night, which is the
   * pair that makes the difference a picture rather than a number.
   */
  private readonly site: CelestialSite | undefined = readSite();
  private readonly lights: PointLightSource[] = [];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly lightMatrix = new Float32Array(16);
  private readonly casters: ShadowCasters;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };

  private elapsedSec = 0;
  private disposed = false;
  private lastGpuMs = 0;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.set = renderer.createMesh(buildSet());

    /*
     * Two of the eight are on their last legs, and the rest are steady.
     *
     * A row of lamps all breathing at the same amplitude reads as a shader effect
     * applied to lamps. A row where most are solid and two are guttering reads as a row
     * of lamps, one of which somebody needs to fix, and it is the second reading that
     * makes the place feel maintained by anybody.
     *
     * `flicker` is the engine's own per-source modulation, applied inside
     * `selectPointLights` from the time it is handed. Nothing here runs per frame, and
     * the radius is deliberately left alone: a light whose *range* animates invalidates
     * its own shadow cubemap every frame and would starve every other lamp of bake
     * budget forever.
     */
    const GUTTERING = new Set([1, 5]);
    for (let i = 0; i < PILLAR_COUNT - 1; i++) {
      this.lights.push({
        x: (i - (PILLAR_COUNT - 2) / 2) * PILLAR_SPACING_M,
        y: LAMP_HEIGHT_M,
        z: 5.4,
        r: 0,
        g: 0,
        b: 0,
        radius: 11,
        flicker: GUTTERING.has(i) ? 0.42 : 0.03,
        shadowNear: 0.3,
        sourceRadius: 0.12,
      });
    }

    this.env = createEnvironment({
      directionalDir: [0, 1, 0],
      directionalColor: [0, 0, 0],
      ambient: [0, 0, 0],
      ambientGround: [0, 0, 0],
      emissiveGain: 0,
      nightFactor: 0,
      fogColor: [0, 0, 0],
      fogDensity: 0.0075,
      fogHeightFalloff: 0.03,
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
      top: [0, 0, 0],
      horizon: [0, 0, 0],
      deep: [0, 0, 0],
      sunDir: this.celestial.sunDir,
      sunColor: SUN_COLOR,
      sunAngularRadius: 0.0047,
      moonDir: this.celestial.moonDir,
      moonColor: [0.66, 0.71, 0.86],
      moonAngularRadius: 0.014,
      moonPhase: 0,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };

    this.casters = (sink) => {
      this.stats.draws++;
      sink.mesh(this.set, IDENTITY);
    };

    this.camera.fovYDeg = 50;
    this.camera.near = 0.3;
    this.camera.far = 190;

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

    /*
     * The clock, and it is this scene's own rather than the machine's.
     *
     * `celestialStateAt` takes a local wall-clock timestamp; it is documented as the
     * caller's job to decide where that comes from, and to keep real time out of
     * anything deterministic. Here it is a fraction of a cycle turned into an hour of
     * a fixed day, so the sky is a function of `elapsedSec` and nothing else.
     */
    const dayFraction = (START_HOUR / 24 + now / DAY_SECONDS) % 1;
    celestialStateAt(dayFraction * MS_PER_DAY, SUN_AZIMUTH, this.celestial, this.site);
    this.applySky();

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      const angle = (now / ORBIT_SECONDS) * TAU;
      camera.position[0] = Math.sin(angle) * ORBIT_RADIUS_M;
      camera.position[1] = 4.6 + Math.sin(now * 0.17) * 0.9;
      camera.position[2] = 12 + Math.cos(angle) * 7;
      camera.lookAt(0, 3.2, 0);
      this.view.follow(camera, 0, 3.2, 0);
    }
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

    renderer.gpuTimer.beginFrame();

    renderer.updatePointShadows(
      this.lights,
      this.lightBuffer.sourceIndex,
      env.lightCount,
      0,
      2,
      2,
      dtSec,
      this.casters,
      NO_MOVING_CASTERS,
      this.lightBuffer.shadowIndex,
      this.lightBuffer.shadowCount,
    );

    /*
     * The directional pass follows whichever body is up.
     *
     * Strength falls away through twilight and returns for the moon, which is the one
     * moment in the cycle where getting it wrong is obvious: a shadow that stays sharp
     * while the sun sets reads as a light that has stopped following the sky.
     */
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      2,
      2,
      22,
      renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    env.shadowStrength = lerp(0.42, 0.9, this.celestial.dayFactor);
    renderer.beginShadowPass(this.lightMatrix, 'static');
    renderer.drawShadowCasters(this.casters);
    renderer.endShadowPass();

    renderer.beginFrame(this.sky.horizon);
    renderer.gpuTimer.begin('rest');

    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.set, IDENTITY);
    this.stats.draws++;
    renderer.drawSky(camera, this.sky, env);
    this.stats.draws++;

    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    this.stats.extra = clockLabel(dayFraction);

    return this.stats;
  }

  /**
   * Turn the clock's answer into an environment, in place.
   *
   * Every value here is a lerp on `dayFactor` except the two that are not: the lighting
   * direction, which is a body's actual position, and the lamps, which follow the night
   * factor so that the moment they come on is the moment the sky says it is dark.
   */
  private applySky(): void {
    const state = this.celestial;
    const env = this.env;
    const sky = this.sky;
    const day = state.dayFactor;

    // Whichever body is up is the one casting. The sky keeps both and gates them itself.
    const dir = day > 0.5 ? state.sunDir : state.moonDir;
    env.directionalDir[0] = dir[0];
    env.directionalDir[1] = dir[1];
    env.directionalDir[2] = dir[2];

    const moonlit = moonIllumination(state.moonPhase);
    env.directionalColor[0] = lerp(MOON_LIGHT[0] * moonlit, SUN_COLOR[0], day);
    env.directionalColor[1] = lerp(MOON_LIGHT[1] * moonlit, SUN_COLOR[1], day);
    env.directionalColor[2] = lerp(MOON_LIGHT[2] * moonlit, SUN_COLOR[2], day);

    mixColorInto(env.ambient, NIGHT_AMBIENT, DAY_AMBIENT, day);
    mixColorInto(env.ambientGround as Vec3, NIGHT_GROUND, DAY_GROUND, day);
    mixColorInto(env.fogColor as Vec3, NIGHT_FOG, DAY_FOG, day);
    env.nightFactor = state.nightFactor;

    mixColorInto(sky.top, NIGHT_SKY.top, DAY_SKY.top, day);
    mixColorInto(sky.horizon, NIGHT_SKY.horizon, DAY_SKY.horizon, day);
    mixColorInto(sky.deep, NIGHT_SKY.deep, DAY_SKY.deep, day);
    sky.nightFactor = state.nightFactor;
    sky.moonPhase = state.moonPhase;

    /*
     * The lamps, and they are on a steeper curve than everything else.
     *
     * Fading them linearly with daylight leaves them faintly lit at noon, which reads as
     * a bug rather than as a lamp. Squaring the night factor keeps them off through the
     * afternoon and brings them up quickly once the light actually goes.
     */
    const lit = clamp(state.nightFactor * state.nightFactor * 1.4, 0, 1);
    env.emissiveGain = lit;
    for (const light of this.lights) {
      light.r = LAMP_LIGHT[0] * lit;
      light.g = LAMP_LIGHT[1] * lit;
      light.b = LAMP_LIGHT[2] * lit;
    }
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
    this.renderer.disposeMesh(this.set);
    this.renderer.dispose();
  }
}

/** Nothing in this scene moves, so the live-caster enumeration is empty. */
const NO_MOVING_CASTERS: ShadowCasters = () => {};

/** The hour, as a clock face, so a reader can see where in the day the frame is. */
function clockLabel(dayFraction: number): string {
  const hours = dayFraction * 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const dayClock: DemoScene = {
  id: 'day-clock',
  title: 'A day in ninety seconds',
  note: 'Sunrise to moonrise on a clock, with the sky, the shadows and the lamps all derived from where the sun and moon actually are. Nothing here animates a shadow; the sun moves and the shadow follows.',
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
    return new DayClockHandle(renderer, canvas);
  },
};
