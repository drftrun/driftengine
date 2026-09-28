/**
 * The Sponza atrium through one midsummer day: noon, golden hour, blue hour and a night by fire.
 *
 * A draft that stays one until the maintainer publishes it. What this file owns is the order of a frame: the clock, then the
 * light it implies, then the fires, the sun's map, a probe, and the world. What each of those is
 * lives beside it in `sponza/`: the site and the loop in `clock.ts`, the hour's light in `light.ts`
 * and `palette.ts`, the camera in `shots.ts`, the packs in `packs.ts`, the bounce in `bounce.ts`,
 * the fires and candles in `fires.ts`, and what the address bar may ask in `asked.ts`.
 */
import { DEMO_BACKEND } from './backend';
import { isHighTier, readDemoDeviceHints } from './deviceBudget';
import { OrbitView } from './orbit';
import {
  Camera,
  computeLightMatrix,
  createCameraPathSample,
  createRenderer,
  describeGpu,
  sampleCameraPath,
} from '../packages/core/src/index';
import type {
  ColourGradeLut,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  ShadowCasters,
  Vec3,
} from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';
import { SponzaTimeline } from './sponza/timeline';
import { filmGrade } from './sponza/grade';
import { SponzaLoading } from './sponza/loading';
import { CAMERA_PATH, nearCameraPath } from './sponza/shots';
import { candlesThatGo } from './sponza/candles';
import { SponzaPacks } from './sponza/packs';
import { SponzaBounce } from './sponza/bounce';
import { SponzaFires } from './sponza/fires';
import { SponzaLight } from './sponza/light';
import { askedEye, askedNumber } from './sponza/asked';
import type { HeldEye } from './sponza/asked';

/**
 * Where the sun's map looks from, and how far it reaches: the whole building, roofs and end halls.
 *
 * **Thirty-four metres, because the map fades to lit over its outer quarter.** At twenty, centred on
 * the courtyard, the hall at the far end of it sat in that fade, lost its roof's shadow, and was lit
 * by the sun through the roof at ten in the morning: a bright room behind the curtains with nothing
 * to light it. At thirty-four the hall is in its roof's shadow at that hour. The building is 36 m
 * long, and a 4,096 map spends 1.7 cm a texel on it.
 */
const SHADOW_FOCUS: Vec3 = [-2.6, 9, 0];
const SHADOW_RADIUS_M = 34;
/** How far the camera's path is kept clear of candles: a wax stick nearer fills the frame. */
const CANDLE_CLEARANCE_M = 0.8;
/** The share of Intel's ten thousand candles kept: all of them read as clutter. */
const CANDLE_SHARE = 0.2;
/** How far a candle's parts stand from its light: the flame at the top, the wax a hand below. */
const CANDLE_SIZE_M = 0.35;
/**
 * How bright a pixel has to be on screen, after exposure, before it blooms: flames and the sun's
 * glints, not sunlit stone. Divided by the exposure every frame, because the threshold is compared
 * before exposure is applied and this scene's exposure spans 2.5 to 14.
 */
const BLOOM_ON_SCREEN = 4;
/** The load screen's colour, a warm near-black, and how long the veil takes to lift. */
const VEIL: Vec3 = [0.022, 0.02, 0.018];
const VEIL_LIFT_SEC = 1.2;
/** Probes a frame for the first light behind the veil: sixteen frames of about a tenth of a second. */
const WARM_PROBES = 12;
/**
 * **How far each region is brought toward the frame's brightness: a fifth.** The arcades at noon
 * hold a fiftieth of the light on the sunlit paving, measured in the probes that light them, which
 * is right for a canyon of grey stone and more than a curve can hold: exposed for the paving the
 * galleries went to black, exposed for the galleries the paving went to white. At half, a gallery
 * five stops under the frame came up two and a half and the courtyard went flat, its darkest twentieth
 * at 40 where the maker's renders keep it at 13 to 19; at a fifth it is 30, and the light reads as
 * coming from somewhere. It was three tenths until the maintainer found that a little washed out.
 * `?local=` for comparison.
 */
const LOCAL_EXPOSURE = 0.2;
/**
 * The lens's corner falloff: about a third of a stop at the corner. See `filmLook.ts`. It was 0.35
 * with a film grain over it until 2026-09-26, and the day read dark and dirty beside every photograph
 * of the place, which is clean and bright: the grain is gone and the corners barely fall.
 */
const VIGNETTE = 0.15;

class SponzaHandle implements DemoHandle {
  readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera = new Camera();
  readonly view = new OrbitView(0.5, 45, 0.3);
  private readonly packs: SponzaPacks;
  private readonly heldEye: HeldEye | undefined;
  private readonly light = new SponzaLight();
  private readonly bounce: SponzaBounce;
  private readonly fires: SponzaFires;
  /** Everything that casts: the packs and the braziers. One list for the sun and every fire. */
  private readonly casters: ShadowCasters;
  /** Seconds since mount, for the flames. The loop's clock is the hour, and it can be held. */
  private elapsedSec = 0;
  private frameCount = 0;
  /** Where the camera flies, and whether the candles standing in its path have been moved. */
  private readonly inPath = nearCameraPath(CANDLE_CLEARANCE_M);
  private candlesCleared = false;
  /** Which candles go, decided once their lights arrive. See `candles.ts`. */
  private candleGoes: ((x: number, y: number, z: number) => boolean) | null = null;
  /** The share of the pack's candles kept. `?candles=` changes it. */
  private readonly candleShare: number;
  private readonly shot = createCameraPathSample();
  private readonly lightMatrix = new Float32Array(16);
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };
  /** The loop and its transport. See `timeline.ts`. */
  readonly clock: SponzaTimeline;
  /** The grade, built once, or null when `?grade=0` asks for none. See `grade.ts`. */
  private readonly grade: ColourGradeLut | null;
  /** `?sun=0`: no key light, the control for what the sun or the moon reaches. */
  private readonly keyLit: boolean;
  /** `?ev=`: stops over or under the palette's exposure, for matching a reference. */
  private readonly evScale: number;
  /** `?haze=`: the air's density scaled, 0 for none; the control for what the shafts do. */
  private readonly hazeScale: number;
  private gradeStrength = -1;
  private readonly drawProbeFace: (camera: Camera) => void;
  private lastGpuMs = 0;
  /** The load screen, and how much of the frame it covers: 1 until the courtyard is whole. */
  private readonly loading: SponzaLoading;
  private veil = 1;
  private disposed = false;
  /** Whether the viewer held the camera last frame: letting go snaps it back, which is a cut. */
  private wasTaken = false;
  /** Whether the courtyard was whole last frame: its first whole frame is metered afresh. */
  private wasWhole = false;
  /** How far the eye adapts, 0 to 1: `?adapt=0` holds the palette's exposure alone. */
  private readonly adapt: number;
  /** How far each region is brought toward the frame, 0 to 1: `?local=0` is the control. */
  private readonly local: number;
  /** Whether DriftRay traces the bounce, which is WebGPU unless `?indirect=0`: see `mount`. */
  private readonly traced: boolean;

  get backend(): RenderBackend {
    return this.renderer.backend;
  }
  get lost(): boolean {
    return this.renderer.contextLost;
  }

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement, traced: boolean) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.traced = traced;
    const search = new URLSearchParams(location.search);
    this.clock = new SponzaTimeline(askedNumber(search, 'hour'), askedNumber(search, 'speed') ?? 1);
    this.heldEye = askedEye(search);
    this.candleShare = Math.min(1, Math.max(0, askedNumber(search, 'candles') ?? CANDLE_SHARE));
    this.packs = new SponzaPacks(renderer, search);
    this.bounce = new SponzaBounce(renderer, search.get('bounce') !== '0');
    /* The look, unless `?grade=0` asks for the frame without it. Scaled by the day each frame. */
    this.grade = search.get('grade') === '0' ? null : filmGrade();
    this.keyLit = search.get('sun') !== '0';
    this.evScale = 2 ** (askedNumber(search, 'ev') ?? 0);
    this.hazeScale = Math.max(0, askedNumber(search, 'haze') ?? 1);
    this.adapt = Math.min(1, Math.max(0, askedNumber(search, 'adapt') ?? 1));
    this.local = Math.min(1, Math.max(0, askedNumber(search, 'local') ?? LOCAL_EXPOSURE));
    const lights = askedNumber(search, 'lights');
    const candleRadius = askedNumber(search, 'candleradius');
    this.loading = new SponzaLoading(renderer);
    this.fires = new SponzaFires(renderer, {
      ...(lights === undefined ? {} : { lights }),
      ...(candleRadius === undefined ? {} : { candleRadius }),
      shadows: search.get('pointshadows') !== '0',
      summed: search.get('driftlight') !== '0',
    });
    this.casters = (sink) => {
      this.packs.casters(sink);
      this.fires.cast(sink);
    };

    /*
     * The sky is drawn in each face, so a probe under the open roof sees the sky it stands under and
     * the grid lights the arcades by it as well as by the walls. That was wrong on WebGPU until the
     * sky had a uniform slot a draw: all six faces drew the last face's sky.
     */
    const { env, sky } = this.light;
    this.drawProbeFace = (probeCamera) => {
      renderer.bindMeshPass(probeCamera, env);
      this.packs.draw(true);
      renderer.drawSky(probeCamera, sky, env);
    };
    this.camera.near = 0.1;
    this.camera.far = 150;
    renderer.resize();
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;
    this.stats.draws = 0;
    this.packs.update(dtSec);
    const clock = this.clock;
    clock.advance(dtSec);
    const light = this.light;
    /*
     * A held hour and a jump both start adapted, since the eye has nothing to adapt from. A seek is
     * a new shot too, so nothing temporal carries the last one into it, and neither does letting go
     * of the camera, which snaps it back to the path.
     */
    const jumped = clock.takeJump();
    light.apply(clock.hour, dtSec, jumped || clock.held !== undefined);
    if (jumped || this.view.taken !== this.wasTaken) renderer.cameraCut();
    this.wasTaken = this.view.taken;
    if (!this.keyLit) light.env.directionalColor.fill(0);
    this.elapsedSec += dtSec;
    this.frameCount++;
    this.packs.setPresence('candles', light.lit);
    const candleLights = this.packs.lightsOf('candles');
    if (this.candleGoes === null && candleLights.length > 0) {
      this.candleGoes = candlesThatGo(candleLights, this.candleShare, this.inPath, CANDLE_SIZE_M);
    }
    const goes = this.candleGoes;
    if (goes !== null) {
      if (!this.candlesCleared) this.candlesCleared = this.packs.clearInstances('candles', goes);
      /* Once every pack is in, so the candles' summed light is occluded by the whole courtyard. */
      if (this.fires.waiting && this.packs.settled) {
        this.fires.offer(this.packs.lightsOf('base'), candleLights, goes, this.packs.occluders());
      }
    }

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else if (this.heldEye !== undefined) {
      const { eye, target, fovDeg } = this.heldEye;
      camera.position[0] = eye[0];
      camera.position[1] = eye[1];
      camera.position[2] = eye[2];
      camera.fovYDeg = fovDeg;
      camera.lookAt(target[0], target[1], target[2]);
    } else {
      const shot = sampleCameraPath(CAMERA_PATH, clock.atSec, this.shot);
      camera.position[0] = shot.eye[0];
      camera.position[1] = shot.eye[1];
      camera.position[2] = shot.eye[2];
      camera.fovYDeg = shot.fovDeg;
      camera.lookAt(shot.target[0], shot.target[1], shot.target[2]);
      this.view.follow(camera, shot.target[0], shot.target[1], shot.target[2]);
    }
    renderer.resize();
    const bufferHeight = this.canvas.height;
    camera.updateMatrices(bufferHeight > 0 ? this.canvas.width / bufferHeight : 1);

    renderer.gpuTimer.beginFrame();
    const { env, sky } = light;
    /*
     * Nothing is lit, shadowed or baked until every pack is in: the load is behind a veil, and a
     * frame that drew half a courtyard would spend on it what the uploads could have had.
     */
    const settled = this.packs.settled;
    if (settled) {
      this.fires.update(this.elapsedSec, dtSec, camera, env, light.lit, this.casters);
      env.shadowDepthSpan = computeLightMatrix(
        env.directionalDir,
        SHADOW_FOCUS[0],
        SHADOW_FOCUS[1],
        SHADOW_FOCUS[2],
        SHADOW_RADIUS_M,
        renderer.shadowMapSize,
        this.lightMatrix,
      );
      env.lightViewProj = this.lightMatrix;
      renderer.beginShadowPass(this.lightMatrix, 'static');
      renderer.drawShadowCasters(this.casters);
      renderer.endShadowPass();
    }

    /*
     * The first light behind the veil once the model is in, a dozen probes a frame; then a few faces.
     * After the candles' summed light is in, so the probes warmed behind the veil see it too.
     */
    if (settled && this.fires.summedIn) {
      if (!this.bounce.complete) this.bounce.warm(sky.horizon, this.drawProbeFace, WARM_PROBES);
      else if (clock.takeRefresh()) {
        /* A jump makes every probe wrong at once: sixteen a frame closes three sweeps in twelve. */
        this.bounce.step(sky.horizon, this.drawProbeFace, 16);
      } else if (clock.held === undefined) {
        this.bounce.drift(sky.horizon, this.drawProbeFace, dtSec, this.bounceRate());
      }
    }

    renderer.setOutputExposure(light.exposure * this.evScale);
    renderer.setGlobalMedium(light.haze * this.hazeScale, 0.9, 0.6, 60);
    /* All of the grade by day and a quarter of it under the moon, set only when it moves. */
    const strength = 0.25 + 0.75 * (1 - light.lit);
    if (this.grade !== null && Math.abs(strength - this.gradeStrength) > 0.01) {
      this.gradeStrength = strength;
      renderer.setColourGrade(this.grade, strength);
    }
    /* Half the bloom by day and most of it by firelight, from the same brightness on screen. */
    renderer.setBloom(0.5 + 0.3 * light.lit, BLOOM_ON_SCREEN / light.exposure);
    /* A lens's corners, faintly. No grain: see VIGNETTE. */
    renderer.setVignette(VIGNETTE);
    const whole = settled && this.fires.summedIn && this.bounce.complete;
    /*
     * **The eye adapts to the frame, and the palette's exposure is a bias on it.** Full adaptation,
     * so a floor in the shade of a 19 m wall opens up as it would to anyone standing on it,
     * and the hour's exposure says how far above or below middle grey that hour sits: a night is
     * kept a night by a bias under one. Only once the courtyard is whole: the veil draws black, and
     * an eye adapted to black opens six stops. Its first whole frame is a cut, so that frame is
     * metered rather than eased into.
     */
    renderer.setAutoExposure(whole ? this.adapt : 0, dtSec);
    /* And each region moved partly toward the frame. See `LOCAL_EXPOSURE`. */
    renderer.setLocalExposure(whole ? this.local : 0);
    if (whole && !this.wasWhole) renderer.cameraCut();
    this.wasWhole = whole;
    if (whole) clock.ready = true;
    renderer.beginFrame(whole ? sky.horizon : VEIL);
    if (whole && this.traced) this.packs.declareFields();
    renderer.gpuTimer.begin('rest');
    if (whole) {
      renderer.bindMeshPass(camera, env);
      this.stats.draws += this.packs.draw();
      renderer.drawSky(camera, sky, env);
      this.stats.draws += this.fires.draw(camera, env, this.elapsedSec, light.lit);
      this.stats.draws++;
    }
    /* Lifted over a second once the courtyard is whole, and at once for a held capture. */
    if (whole) {
      this.veil = clock.held !== undefined ? 0 : Math.max(0, this.veil - dtSec / VEIL_LIFT_SEC);
    }
    if (this.veil > 0) renderer.setFrameVeil(VEIL[0], VEIL[1], VEIL[2], this.veil);
    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();
    const loaded =
      this.packs.fraction * 0.85 +
      (settled ? 0.02 : 0) +
      this.fires.summedProgress * 0.05 +
      this.bounce.warmth * 0.08;
    this.loading.draw(loaded, this.veil, this.elapsedSec);

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    this.stats.extra =
      `${clock.label} · sun ${light.elevationDeg.toFixed(1)}° · ` +
      `exposure ${light.exposure.toFixed(2)} · ${this.packs.describe()}`;
    return this.stats;
  }

  /**
   * How fast the grid is re-baked, as a share of the day's rate: all of it while the sun is up and
   * moving, an eighth after dark, when only the moon moves and the fires do not. A face bins every
   * lit fire again on WebGL2, and at night that is most of a frame's CPU.
   */
  private bounceRate(): number {
    return this.light.lit > 0.5 ? 1 / 8 : 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.packs.dispose();
    this.fires.dispose();
    this.loading.dispose();
    this.renderer.dispose();
  }
}

export const sponza: DemoScene = {
  id: 'sponza',
  title: 'Sponza atrium',
  loadsModel: true,
  note:
    'The atrium of the Sponza Palace through one midsummer day in Dubrovnik: noon on the floor, ' +
    'golden hour on the gallery, blue hour at the lion-head end, and a moonlit night.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    /*
     * `?tone=none` writes linear light straight out, an instrument: with it, a textured frame over
     * an untextured one at the same pixel is the albedo the shader used, with no curve in between.
     */
    const search = new URLSearchParams(location.search);
    const linear = search.get('tone') === 'none';
    /*
     * **DriftRay lights the bounce on WebGPU:** the probe grid is filled by tracing rays through the
     * courtyard's distance field, `quality.indirectLight`, rather than by rasterising six faces a
     * probe. It was the rasterised grid until 2026-09-27, because the trace read about half of it
     * in a shaded gallery, and three defects were why: the bake divided the sun by pi where the
     * frame does not, the far end of the courtyard lay past the field's reach and was lit as open
     * sky from every side, and an escaping ray read the palette's ambient rather than the sky drawn.
     * With them fixed a noon view matches the rasterised grid within a level of mean and keeps the
     * covered galleries lit where the grid left them near black, and dusk comes out a little cooler,
     * which is the sky's doing. It costs 0.1 to 0.2 ms a frame at 1440p. What would make it wrong
     * is light that depends on the stone's colour: the field gives the whole courtyard one albedo,
     * `STONE_ALBEDO`, where the rasterised capture saw every texture.
     *
     * **On the high tier** (`isHighTier`): WebGPU, not a handheld, not a GPU family the engine
     * knows is weak, asked through a function of the backend since WebGL2 has no compute stage and
     * says so when handed it. Everywhere else the rasterised grid, which is also `?indirect=0`;
     * `?indirect=1` traces on any WebGPU device, for a look at a phone. The part is only named when
     * the address leaves the choice to the tier, since naming it costs a detached context.
     */
    const asked = search.get('indirect');
    const hints = readDemoDeviceHints();
    const weak = asked === null ? (await describeGpu()).weak : false;
    const tracedOn = (drawing: RenderBackend): boolean =>
      asked !== '0' && drawing === 'webgpu' && (asked === '1' || isHighTier(hints, drawing, weak));
    const { renderer, backend } = await createRenderer(
      canvas,
      (drawing) => ({
        /*
         * **One sample a pixel, and the temporal resolve for the antialiasing.** Four samples under
         * it cost 2.3 ms of a 12 ms frame at 4K and added nothing the resolve had not: the same view
         * captured both ways at 4K measured a fine-detail Laplacian of 15.5 with them and 15.9
         * without, and the ivy, the lace and the column edges come out alike. What it gives up is the
         * first frame after a cut, which has no history and is drawn at one sample.
         */
        sceneSamples: 1,
        hdrScene: true,
        /*
         * ACES, measured against the model maker's own render of the same view: a median of 61
         * against 69 and 4.1% of the frame under 16 against 4.8%. AgX was tried and could not reach
         * that contrast at any exposure: brought down to the median, its highlights stopped at 158
         * where the render's reach 209.
         */
        outputTransform: 'aces',
        outputExposure: 1,
        bloom: 0.5,
        bloomThreshold: BLOOM_ON_SCREEN,
        /* Contact shade under the arches and in the folds; above this the cloth before a column
           darkens whole, which is the depth test's halo rather than a crease. */
        ambientOcclusion: 0.45,
        /* A shutter's smear on the camera's moves, cut at every seek by `cameraCut`. */
        cameraMotionBlur: 0.3,
        /* The resolve: the cypress needles and the lace sparkled under multisampling alone. */
        temporalAa: true,
        directionalShadowMapSize: 4096,
        /*
         * The courtyard is 19 m tall and closed on every side, so the sun has to cast until it has
         * set, and a grazing shadow has to reach the length of it. At a slope of 30 the shadow let
         * go at 2° with the sun still bright, and every wall facing west took the whole of it
         * through the building: the golden hour came out as one orange. Six hundred holds to a
         * tenth of a degree, where `light.ts` has already put the sun out. The map's depth is
         * 120 m, so nothing in it reaches 150 m and no shadow in the courtyard dissolves.
         */
        directionalShadowMaxDistance: 150,
        directionalShadowMaxSlope: 600,
        reflectionProbeSize: 64,
        /* Ten thousand candles, three hundred and twenty at a time, falling off as light does. */
        clusteredLights: true,
        /* The air, for the sun's shafts: 32 steps at half resolution. */
        globalMediumSteps: 32,
        pointLightFalloff: 'inverseSquare',
        /*
         * **A flame's shadow is baked where the flame stands, once.** A flame's light sways a few
         * centimetres, and at the default millimetre every sway made its map stale, so each flame
         * re-drew six faces of eleven million triangles every frame: 21 ms of a night's 26 at 1440p.
         * A brazier sways up to 6 cm on each axis, so two places it stands are at most
         * 2 × 6 × √3 = 21 cm apart; a quarter of a metre clears that, and the maps are drawn once
         * and the lookups use the place they were drawn from. At fifteen centimetres they were not:
         * a brazier crossed it every second or so and re-drew its whole cube in one frame. The light
         * still flickers and sways, and its shadow, under a penumbra half a metre wide, holds still.
         */
        pointShadowRebakeDistance: 0.25,
        ...(linear ? { outputTransform: 'none' as const, bloom: 0 } : {}),
        ...(tracedOn(drawing) ? { indirectLight: true } : {}),
        ...overrides,
      }),
      DEMO_BACKEND,
    );
    await renderer.ready();
    return new SponzaHandle(renderer, canvas, tracedOn(backend));
  },
};
