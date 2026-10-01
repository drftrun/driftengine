/**
 * A two-kilometre city through its day, streamed from one container and walked through on foot.
 *
 * A draft that stays one until the maintainer publishes it. What this file owns is the order of a
 * frame: the fixed steps — the walker, the clock, the rain — then the light they imply, then the
 * world, the sky and what glows. What each of those is lives beside it in `sprawl/`: the stream and
 * its levels in `world.ts`, the walker in `walker.ts`, the day in `clock.ts`, the rain in
 * `weather.ts`, the sky in `sky.ts`, the lamps in `lamps.ts`, and what moves in `life.ts`.
 *
 * What the address bar may ask: `?at=x,z,yaw` where the walker stands — `?at=x,z,yaw,h` flying
 * at h metres — `?hour=` the hour,
 * `?rain=` the rain whatever the schedule says, `?hold=1` the clock and the walker held and every
 * switch of level immediate — a frame to photograph and diff — and for photographing the
 * interface, `?map=1` the city map, `?north=1` the minimap north up, `?pause=1` the pause screen,
 * `?tier=low|medium|high|ultra` the quality.
 */
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  InputSource,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
  frustumFromViewProjection,
} from '../packages/core/src/index';
import type {
  Environment,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
} from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';
import { CityWorld } from './sprawl/world';
import { Walker } from './sprawl/walker';
import { CityClock, HOUR_SEC, nightAt } from './sprawl/clock';
import { Wetness, rainAt } from './sprawl/weather';
import { BLOOM_THRESHOLD, CitySky, bloomThreshold } from './sprawl/sky';
import { CityLamps } from './sprawl/lamps';
import { CityShafts } from './sprawl/shafts';
import { CityRain } from './sprawl/rain';
import { CityLife } from './sprawl/life';
import { Hud } from './sprawl/hud';
import type { HudFrame } from './sprawl/hud';
import { CityMaps } from './sprawl/maps';
import { DistrictIndex } from './sprawl/mapMesh';
import { nextTier, tierFrom, tierQuality } from './sprawl/tiers';
import { createRules } from './sprawl/rules';
import type { ScriptHost } from './sprawl/scriptHost';
import type { Tier } from './sprawl/tiers';
import { ON_TAXI, ON_TRAIN, WALK } from './sprawl/riding';
import type { Riding } from './sprawl/riding';

/** Where the bake leaves the city: `npm run sprawl:bake -- --city`. */
const CONTAINER = './sprawl/derived/sprawl.drft';
/** The regions within this of the walker are resident before the first frame is drawn. */
const WALKABLE_M = 150;
/** How far about the walker the sun's shadow reaches: the reference's own range. */
const SHADOW_M = 160;
/** One step of the simulation, and the most a frame may take, so a stall does not run away. */
const STEP = 1 / 60;
const MAX_STEPS = 5;
/** Each field of `rules.drs`'s `Keys`, and the key that presses it. */
const KEY_OF: readonly (readonly [string, string])[] = [
  ['interact', 'KeyE'],
  ['next', 'BracketRight'],
  ['previous', 'BracketLeft'],
  ['leave', 'Escape'],
  ['skip', 'KeyT'],
  ['map', 'KeyM'],
  ['north', 'KeyN'],
  ['pause', 'KeyP'],
  ['quality', 'KeyQ'],
];
/** The walker's eye above its feet (`playerEye`), to board from where it stands. */
const EYE_M = 1.7;
/** Keys the page must not act on while the city has them. */
const KEYS = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyT',
  'KeyE',
  'KeyM',
  'KeyN',
  'KeyP',
  'KeyQ',
  'BracketLeft',
  'BracketRight',
  'Escape',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

interface Asked {
  /** Where the walker stands, its heading, and — above two metres — the height it flies at. */
  readonly at: readonly [number, number, number, number] | null;
  readonly hour: number | null;
  readonly rain: number | null;
  readonly hold: boolean;
  /** For a capture: the city map open, the minimap north up, the pause screen showing. */
  readonly map: boolean;
  readonly north: boolean;
  readonly pause: boolean;
}

function asked(): Asked {
  const q = new URLSearchParams(location.search);
  const numbers = (key: string): number[] | null => {
    const v = q.get(key);
    if (v === null) return null;
    const out = v.split(',').map(Number);
    return out.every(Number.isFinite) ? out : null;
  };
  const at = numbers('at');
  return {
    at:
      at !== null && at.length >= 2
        ? [at[0] as number, at[1] as number, at[2] ?? 0, at[3] ?? 0]
        : null,
    hour: numbers('hour')?.[0] ?? null,
    rain: numbers('rain')?.[0] ?? null,
    hold: q.get('hold') === '1',
    map: q.get('map') === '1',
    north: q.get('north') === '1',
    pause: q.get('pause') === '1',
  };
}

class SprawlHandle implements DemoHandle {
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, extra: '' };
  private readonly camera = new Camera();
  private readonly env: Environment = createEnvironment({ ambientGround: [0, 0, 0] });
  private readonly frustum = new Float32Array(24);
  private readonly eye = new Float32Array(3);
  private readonly lightMatrix = new Float32Array(16);
  private readonly world: CityWorld;
  private readonly walker: Walker;
  private readonly day: CityClock;
  private readonly wetness: Wetness;
  private readonly sky = new CitySky();
  private readonly lamps: CityLamps;
  private readonly rain: CityRain;
  private life: CityLife | null = null;
  private shafts: CityShafts | null = null;
  private readonly input: InputSource;
  private readonly hud: Hud;
  private readonly rules: ScriptHost;
  private maps: CityMaps | null = null;
  private districts: DistrictIndex | null = null;
  private districtNames: string[] = [];
  private sinceDistrict = 0;
  private paused = false;
  private readonly tier: Tier;
  private readonly hudFrame: HudFrame;
  private disposed = false;
  private placed = false;
  private ready = false;
  private accumulated = 0;
  private moverDraws = 0;
  private walkable = { resident: 0, total: 1 };
  private failed: string | null = null;

  constructor(
    readonly renderer: RendererApi,
    readonly backend: RenderBackend,
    private readonly canvas: HTMLCanvasElement,
    private readonly ask: Asked,
  ) {
    this.camera.fovYDeg = 75;
    this.camera.near = 0.25;
    this.camera.far = 5000;
    this.world = new CityWorld(renderer, ask.hold ? { fadeSec: 0 } : {});
    this.input = new InputSource(canvas, KEYS);
    canvas.addEventListener('click', () => this.input.requestPointerLock());
    this.walker = new Walker(this.input);
    this.day = new CityClock(ask.hour ?? undefined);
    /* A street that has been rained on is wet: a held capture asking for rain starts soaked. */
    this.wetness = new Wetness(ask.rain !== null && ask.rain > 0 ? 1 : 0);
    this.lamps = new CityLamps(renderer, this.env);
    this.rain = new CityRain(renderer);
    this.tier = tierFrom(location.search);
    this.paused = ask.pause;
    this.rules = createRules();
    const Play = this.rules.type('Play');
    this.rules.write(Play, 'paused', ask.pause ? 1 : 0);
    this.rules.write(Play, 'mapOpen', ask.map ? 1 : 0);
    this.rules.write(Play, 'northUp', ask.north ? 1 : 0);
    this.hud = new Hud(renderer, 'A CITY THROUGH ITS DAY');
    this.hudFrame = {
      hour: 0,
      fps: 60,
      ms: 0,
      district: '',
      rideKey: -1,
      rideWords: () => this.rideWords(),
      resident: 0,
      total: 1,
      ready: false,
      paused: false,
      tier: this.tier,
    };
  }

  /** Stream the city; each frame draws what has arrived. */
  open(response: Promise<Response>): void {
    response
      .then((r) => {
        if (!r.ok) {
          throw new Error(`${CONTAINER}: ${r.status}; bake it: npm run sprawl:bake -- --city`);
        }
        return this.world.open(r);
      })
      .catch((error: unknown) => {
        this.failed = error instanceof Error ? error.message : String(error);
      });
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    const world = this.world;
    world.update(dtSec);
    this.arrive();

    this.keys();
    /* The fixed steps: the walker once the ground under it is in, the clock and the rain always —
       none while paused. */
    if (!this.ask.hold && !this.paused) {
      this.accumulated = Math.min(this.accumulated + dtSec, STEP * MAX_STEPS);
      while (this.accumulated >= STEP) {
        this.accumulated -= STEP;
        const riding = this.life?.riding;
        if (this.ready && (riding === undefined || riding.state === WALK)) this.walker.step(STEP);
        this.life?.step(STEP, this.day.hour, this.eye[0] as number, this.eye[2] as number);
        if (riding?.landed === true) this.land(riding);
        this.day.tick(STEP);
        this.wetness.step(this.ask.rain ?? rainAt(this.day.hour), STEP / HOUR_SEC);
      }
    }
    const alpha = this.ask.hold ? 1 : this.accumulated / STEP;
    this.walker.eye(alpha, this.eye);
    this.life?.riding.eye(alpha, this.eye);
    this.aim();

    const env = this.env;
    const x = this.eye[0] as number;
    const y = this.eye[1] as number;
    const z = this.eye[2] as number;
    this.sky.apply(this.day.hour, this.wetness.value, env, this.ask.rain ?? rainAt(this.day.hour));
    this.renderer.setBloom(1, bloomThreshold(env));
    this.lamps.update(nightAt(this.day.hour), x, y, z, dtSec, env);
    this.rain.update(this.ask.hold ? 0 : dtSec, x, y, z, this.ask.rain ?? rainAt(this.day.hour));
    this.life?.fill(x, y, z, this.ask.hold ? 1 : this.accumulated / STEP);

    const camera = this.camera;
    const timer = this.renderer.gpuTimer;
    timer.beginFrame();
    if (this.ready) this.shadow(x, y, z);
    this.renderer.beginFrame(this.sky.colors.horizon);
    timer.begin('rest');
    this.renderer.bindMeshPass(camera, env);
    if (this.ready) {
      world.draw(this.eye, camera.fovYDeg, this.canvas.height, this.frustum);
      this.moverDraws = this.life?.draw() ?? 0;
      this.lamps.drawBulbs();
      this.sky.draw(this.renderer, camera, env);
      world.drawLater();
      this.shafts?.draw(
        camera,
        this.frustum,
        nightAt(this.day.hour),
        this.day.hour * HOUR_SEC,
        x,
        y,
        z,
      );
      this.rain.draw(camera, env);
    }
    timer.end();
    this.renderer.endFrame();
    /* After the present, in the overlay pass: the interface stays out of the temporal resolve,
       which would otherwise keep a map or a loading card in its history. */
    this.interface(dtSec, x, z, camera, env);
    timer.endFrame();
    const sample = timer.poll();
    if (sample !== null) this.stats.gpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.draws = world.issued + this.moverDraws;
    this.stats.extra = this.failed ?? this.readout();
    return this.stats;
  }

  /**
   * The frame's keys, through `rules.drs`, which decides what each means now: E boards, `[` and
   * `]` choose, Esc leaves a ride; M the city map, N north up; P pauses, and Q while paused opens
   * the scene at the next tier; T an hour on. The presses go in, the intents come out, and the
   * pause, the map and north up are the script's to keep.
   */
  private keys(): void {
    const input = this.input;
    const rules = this.rules;
    const Keys = rules.type('Keys');
    const Play = rules.type('Play');
    for (const [field, code] of KEY_OF)
      rules.write(Keys, field, input.consumeKeyPress(code) ? 1 : 0);
    const riding = this.life?.riding;
    rules.write(Play, 'riding', riding !== undefined && riding.state !== WALK ? 1 : 0);
    rules.step();
    this.paused = rules.read(Play, 'paused') === 1;
    if (this.maps !== null) {
      this.maps.open = rules.read(Play, 'mapOpen') === 1;
      this.maps.northUp = rules.read(Play, 'northUp') === 1;
    }
    if (rules.read(Play, 'nextTier') === 1) {
      const q = new URLSearchParams(location.search);
      q.set('tier', nextTier(this.tier));
      location.search = q.toString();
    }
    if (rules.read(Play, 'skipHour') === 1) this.day.skip();
    if (riding === undefined) return;
    if (rules.read(Play, 'board') === 1) {
      riding.board(this.eye[0] as number, (this.eye[1] as number) - EYE_M, this.eye[2] as number);
    }
    const choose = rules.read(Play, 'choose');
    if (choose !== 0) riding.choose(choose);
    if (rules.read(Play, 'getOff') === 1) riding.leave();
  }

  /** What the ride panel says: the ride, or where E would take the walker, and the keys that apply. */
  private rideWords(): string {
    const riding = this.life?.riding;
    if (riding === undefined) return '';
    const state = riding.state;
    const keys =
      state === WALK
        ? '[ ] CHOOSE   E BOARD'
        : state === ON_TRAIN
          ? 'ESC NEXT STOP'
          : state === ON_TAXI
            ? ''
            : 'ESC LEAVE';
    return keys === '' ? riding.describe() : `${riding.describe()}   ${keys}`;
  }

  /** A rider set down walks on from where the ride left it. */
  private land(riding: Riding): void {
    riding.landed = false;
    const at = riding.setDown;
    this.walker.place(at[0] as number, at[1] as number, at[2] as number, this.walker.yaw);
  }

  /** The maps and the display over the finished frame. */
  private interface(dt: number, x: number, z: number, camera: Camera, env: Environment): void {
    const frame = this.hudFrame;
    frame.hour = this.day.hour;
    frame.fps = dt > 0 ? frame.fps + (1 / dt - frame.fps) * 0.1 : frame.fps;
    frame.ms = this.stats.gpuMs > 0 ? this.stats.gpuMs : dt * 1000;
    frame.resident = this.walkable.resident;
    frame.total = this.walkable.total;
    frame.ready = this.ready;
    frame.paused = this.paused;
    const riding = this.life?.riding;
    frame.rideKey = riding === undefined ? -1 : riding.state * 100 + riding.destination;
    if (this.ready && this.maps !== null) {
      if (this.maps.open) this.maps.drawCity(x, z, this.walker.yaw);
      else this.maps.drawMinimap(x, z, this.walker.yaw);
    }
    if (this.districts !== null && this.sinceDistrict++ % 30 === 0) {
      /* In a street, the block across the pavement: fifteen metres to either side. */
      let d = this.districts.at(x, z);
      for (let k = 0; d < 0 && k < 4; k++) {
        d = this.districts.at(
          x + (k === 0 ? 15 : k === 1 ? -15 : 0),
          z + (k === 2 ? 15 : k === 3 ? -15 : 0),
        );
      }
      if (d >= 0) frame.district = this.districtNames[d] ?? frame.district;
    }
    this.hud.draw(frame, dt, camera, env);
  }

  /** What has arrived since the last frame: the walker's place, its ground, the lamps. */
  private arrive(): void {
    const world = this.world;
    const scene = world.scene;
    if (scene === null) return;
    if (!this.placed) {
      const at = this.ask.at;
      const s = scene.spawn;
      if (at === null) this.walker.place(s.x, s.y, s.z, s.yaw);
      else {
        this.walker.place(at[0], s.y, at[1], at[2]);
        if (at[3] > 2) this.walker.fly(at[3]);
      }
      this.placed = true;
    }
    this.walker.eye(1, this.eye);
    this.walkable = world.pageAround(this.eye[0] as number, this.eye[2] as number, WALKABLE_M);
    for (const region of world.loader.regions.values()) {
      this.walker.admit(region.id, region.collision);
    }
    this.ready =
      this.ready ||
      (this.walkable.resident === this.walkable.total && world.arrays?.complete === true);
    this.lamps.arrive(world.loader.lights, world.loader.lightVolume, scene.lightUnit);
    if (this.shafts === null) this.shafts = new CityShafts(this.renderer, scene.shafts);
    if (this.maps === null) {
      this.maps = new CityMaps(this.renderer, this.canvas, scene);
      this.districts = new DistrictIndex(scene.blocks);
      for (const d of scene.districts) this.districtNames[d.index] = d.name;
    }
    if (this.life === null && CityLife.ready(scene, world.moverMeshes)) {
      this.life = new CityLife(this.renderer, scene, world.moverMeshes, this.day.hour, {
        x: this.eye[0] as number,
        z: this.eye[2] as number,
      });
    }
  }

  /**
   * The sun's shadow — or the moon's — over the reference's 160 m about the walker, redrawn every
   * frame: the walker moves it and the day turns it.
   */
  private shadow(x: number, y: number, z: number): void {
    const env = this.env;
    const world = this.world;
    world.shadowCentre[0] = x;
    world.shadowCentre[1] = z;
    world.shadowRange = SHADOW_M;
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      x,
      y,
      z,
      SHADOW_M,
      this.renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    this.renderer.beginShadowPass(this.lightMatrix, 'static');
    this.renderer.drawShadowCasters(world.casters);
    if (this.life !== null) this.renderer.drawShadowCasters(this.life.casters);
    this.renderer.endShadowPass();
  }

  /** The camera where the walker's eye is, looking where it looks. */
  private aim(): void {
    const camera = this.camera;
    const eye = this.eye;
    camera.position[0] = eye[0] as number;
    camera.position[1] = eye[1] as number;
    camera.position[2] = eye[2] as number;
    const level = Math.cos(this.walker.pitch);
    camera.lookAt(
      (eye[0] as number) + Math.sin(this.walker.yaw) * level,
      (eye[1] as number) + Math.sin(this.walker.pitch),
      (eye[2] as number) + Math.cos(this.walker.yaw) * level,
    );
    this.renderer.resize();
    camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);
    frustumFromViewProjection(camera.viewProjection, this.frustum);
  }

  private readout(): string {
    const hour = this.day.hour;
    const hh = Math.floor(hour);
    const mm = Math.floor((hour - hh) * 60);
    const time = `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
    if (!this.ready) {
      return (
        `${time} · arriving: ${this.world.loader.regions.size} regions, ` +
        `${this.walkable.resident} of ${this.walkable.total} about the walker`
      );
    }
    return (
      `${time} · ${this.env.lightCount} lamps near · ${this.shafts?.drawn ?? 0} shafts` +
      ` · wet ${this.wetness.value.toFixed(2)}` +
      (this.life === null ? '' : ` · ${this.life.describe()} · ${this.life.riding.describe()}`) +
      (this.walker.flying ? ' · flying' : '')
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
    this.world.loader.dispose();
    this.renderer.dispose();
  }
}

export const sprawl: DemoScene = {
  id: 'sprawl',
  title: 'A city through its day',
  loadsModel: true,
  note:
    'Two kilometres of city streamed from one container and walked through on foot: the regions ' +
    'about the walker arrive first, every region is drawn at the detail its distance asks for, ' +
    'and every lamp in every street is lit at night.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const created = await createRenderer(
      canvas,
      (drawing) => ({
        /* Every lamp near the eye, three hundred and twenty at a time; the volume past them. */
        clusteredLights: true,
        hdrScene: true,
        outputTransform: 'aces' as const,
        /*
         * Bloom where the reference blooms — neon, signs, lit windows — with a threshold they clear:
         * a strength with nothing above its threshold is silently nothing. The frame raises it with
         * the daylight (`bloomThreshold`), so a sunlit street never clears it.
         */
        bloom: 0.35,
        bloomThreshold: BLOOM_THRESHOLD,
        temporalAa: true,
        /* The tier's contact shade, reconstruction and sun's shadow map (`tiers.ts`), over 160 m. */
        ...tierQuality(tierFrom(location.search), drawing),
        directionalShadowMaxDistance: SHADOW_M,
        ...overrides,
      }),
      DEMO_BACKEND,
    );
    await created.renderer.ready();
    const handle = new SprawlHandle(created.renderer, created.backend, canvas, asked());
    handle.open(fetch(CONTAINER));
    return handle;
  },
};
