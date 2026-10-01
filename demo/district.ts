/**
 * A district of neon and rain, streamed from one container and walked through or flown over.
 *
 * A draft that stays one until the maintainer publishes it. The district is a bought `.blend`,
 * read by the engine's own Blender reader and baked by `npm run district:bake`; nothing of it is
 * in this repository. What this file owns is the order of a frame, as `sprawl.ts` lays it out —
 * the fixed steps (the walker, the clock, the weather), then the light they imply, then the world,
 * the sky and what glows — and the keys a visitor drives it with. What each of those is lives
 * beside it: the stream and its materials in `district/world.ts`, how surfaces glow in
 * `district/glow.ts`, the display in `district/hud.ts`; the walker, the day, the sky, the lamps and
 * the rain are the city scene's own (`sprawl/`), which take positions, colours and time.
 *
 * Keys: W A S D, Shift, Space and the mouse to walk; F to fly; T and G an hour on and back, N day
 * or night, P to hold the clock; R the weather, O the fog; V and B the next and last of the source's
 * own camera views, 1 to 9 the first nine; H the keys.
 *
 * Address bar: `?at=x,y,z,yaw,pitch` stand there flying (degrees), `?view=<name or number>` start
 * at a view, `?hour=` the hour, `?weather=clear|drizzle|rain|storm`, `?fog=1`, `?hold=1` a held
 * frame to photograph and `?t=` the moment of the traffic it holds, `?tier=` the quality. The
 * instruments: `?lamps=0|exact|field`, `?glow=0`, `?gain=lamp:40,neon:25`, `?mirror=0`, `?grade=0`.
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
import type { DrftLight } from '@driftengine/drft';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';
import { DistrictWorld } from './district/world';
import { DistrictHud } from './district/hud';
import type { DistrictHudFrame } from './district/hud';
import { DistrictGrade } from './district/grade';
import { DISTRICT_SKY } from './district/sky';
import { KIND_GAIN, judged, kindOfLight, reachOf } from './district/lighting';
import type { LightKind } from './district/lighting';
import { DistrictWaters } from './district/water';
import { DistrictMovers } from './district/movers';
import { Walker } from './sprawl/walker';
import { CityClock, HOUR_SEC, nightAt } from './sprawl/clock';
import { Wetness } from './sprawl/weather';
import { BLOOM_THRESHOLD, CitySky, bloomThreshold } from './sprawl/sky';
import { CityLamps } from './sprawl/lamps';
import { CityRain } from './sprawl/rain';
import { tierFrom, tierQuality } from './sprawl/tiers';

const BASE = './district';
const CONTAINER = `${BASE}/district.drft`;
const SCENE = `${BASE}/district.json`;
const WALKABLE_M = 140;
const SHADOW_M = 180;
const STEP = 1 / 60;
const MAX_STEPS = 5;
const EYE_M = 1.7;
/** The mirror is drawn while a body of water is this near, metres; past it the water shows the sky. */
const MIRROR_M = 260;
/**
 * The material changes the district asks a frame to hold. Its street spends about nine hundred and
 * the river's mirror as many again; at the default 1,024 the mirror came and went as the eye turned.
 */
const MATERIAL_RING = 2048;
/** The draws it asks a frame to hold: a street of the whole city is some three and a half thousand, its mirror more. */
const DRAW_RING = 8192;
/** What the mirror leaves of them for the water, the sky, the rain and the interface. */
const DRAW_MARGIN = 300;
/** What the mirror leaves for the water, the sky, the rain and the interface. */
const MATERIAL_MARGIN = 80;
/** Below this many changes left over, the mirror would show a few walls and is not drawn. */
const MIRROR_LEAST = 120;
/** The hour N takes the day to: an afternoon, whose sun is low enough to throw a street's shadows. */
const DAY_HOUR = 16;
const VIGNETTE = 0.28;
/**
 * How far into the tone curve the frame is exposed by day and by night. By day a city is mostly in
 * shade lit by the sky, and at 1 that shade sat at a quarter of the brightness a frame of the same
 * street from another renderer gives it; by night a little up, so the dark streets read.
 */
const DAY_EXPOSURE = 1.55;
const NIGHT_EXPOSURE = 1.35;
/** The city's glow off the sky at full night, linear: from above, and back off the ground. */
const CITY_GLOW: readonly [number, number, number] = [0.11, 0.08, 0.17];
const CITY_GLOW_GROUND: readonly [number, number, number] = [0.04, 0.03, 0.05];
/**
 * The weakest light shaded exactly, in judged units. The choice is nearest-first and a city's
 * fifteen thousand lights are mostly faint glows a few metres across, which would fill every slot
 * near the eye and push the lamps out to the volume.
 */
const EXACT_FLOOR = 0.6;
/** The weathers R cycles through, and how hard each rains. */
const WEATHERS = [
  ['CLEAR', 0],
  ['DRIZZLE', 0.25],
  ['RAIN', 0.6],
  ['STORM', 1],
] as const;
const KEYS = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyT',
  'KeyG',
  'KeyN',
  'KeyP',
  'KeyR',
  'KeyO',
  'KeyV',
  'KeyB',
  'KeyH',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
];

interface Asked {
  /** Where to stand, flying: x, eye height, z, heading and pitch in degrees. */
  readonly at: readonly number[] | null;
  readonly view: string | null;
  readonly hour: number | null;
  readonly weather: number | null;
  readonly fog: boolean;
  readonly hold: boolean;
  /**
   * `?lamps=0|exact|field` and `?glow=0`: the lights, the exact ones alone or the volume alone, or
   * every surface's glow, off — to tell them apart.
   */
  readonly lamps: 'all' | 'exact' | 'field' | 'none';
  readonly glow: boolean;
  /**
   * `?gain=lamp:300,neon:40`: how each kind of light is judged, for judging them by eye. It reaches
   * the exact lights only; the volume keeps the bake's, so a gain far from the bake's shows a seam
   * where the two hand over, and is a number to bake once it is settled.
   */
  readonly gains: Readonly<Record<LightKind, number>>;
  /** `?grade=0`: the frame without the district's look. */
  readonly grade: boolean;
  /** `?mirror=0`: the water shows the sky and not the street. */
  readonly mirror: boolean;
  /** `?t=`: seconds into the traffic's loops, for a held frame of it at a chosen moment. */
  readonly t: number;
}

function asked(): Asked {
  const q = new URLSearchParams(location.search);
  const weather = q.get('weather');
  const index =
    weather === null
      ? -1
      : WEATHERS.findIndex(([name]) => name.toLowerCase() === weather.toLowerCase());
  const hour = Number(q.get('hour'));
  const at = q.get('at')?.split(',').map(Number) ?? null;
  return {
    at: at !== null && at.length >= 3 && at.every(Number.isFinite) ? at : null,
    view: q.get('view'),
    hour: q.has('hour') && Number.isFinite(hour) ? hour : null,
    weather: index >= 0 ? index : null,
    fog: q.get('fog') === '1',
    hold: q.get('hold') === '1',
    lamps:
      q.get('lamps') === '0'
        ? 'none'
        : q.get('lamps') === 'exact'
          ? 'exact'
          : q.get('lamps') === 'field'
            ? 'field'
            : 'all',
    glow: q.get('glow') !== '0',
    gains: gainsFrom(q.get('gain')),
    grade: q.get('grade') !== '0',
    mirror: q.get('mirror') !== '0',
    t: Number(q.get('t')) || 0,
  };
}

function gainsFrom(text: string | null): Readonly<Record<LightKind, number>> {
  const gains = { ...KIND_GAIN };
  for (const pair of (text ?? '').split(',')) {
    const [kind, value] = pair.split(':');
    const n = Number(value);
    if (kind !== undefined && kind in gains && Number.isFinite(n) && n >= 0)
      gains[kind as LightKind] = n;
  }
  return gains;
}

class DistrictHandle implements DemoHandle {
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, extra: '' };
  private readonly camera = new Camera();
  private readonly env: Environment = createEnvironment({ ambientGround: [0, 0, 0] });
  private readonly frustum = new Float32Array(24);
  private readonly mirrorFrustum = new Float32Array(24);
  private waters: DistrictWaters | null = null;
  /** The container's lights as the night judges them, made once when they arrive. */
  private judgedLights: DrftLight[] | null = null;
  private readonly grade: DistrictGrade | null;
  /** The mirror this frame: -1 not wanted, 0 refused by the renderer, else its allowance. */
  private mirrored = -1;
  private readonly eye = new Float32Array(3);
  private readonly lightMatrix = new Float32Array(16);
  private readonly world: DistrictWorld;
  private readonly movers: DistrictMovers;
  private readonly walker: Walker;
  private readonly day: CityClock;
  private readonly wetness: Wetness;
  private readonly sky = new CitySky(DISTRICT_SKY);
  private readonly lamps: CityLamps;
  private readonly rain: CityRain;
  private readonly input: InputSource;
  private readonly hud: DistrictHud;
  private readonly hudFrame: DistrictHudFrame;
  private weather: number;
  private fog: boolean;
  private holdClock: boolean;
  private help = false;
  private viewIndex = -1;
  private viewAge = 99;
  private seconds: number;
  private accumulated = 0;
  private placed = false;
  private ready = false;
  private disposed = false;
  private walkable = { resident: 0, total: 1 };
  private failed: string | null = null;

  constructor(
    readonly renderer: RendererApi,
    readonly backend: RenderBackend,
    private readonly canvas: HTMLCanvasElement,
    private readonly ask: Asked,
  ) {
    this.seconds = ask.t;
    this.camera.fovYDeg = 70;
    this.camera.near = 0.2;
    this.camera.far = 6000;
    this.world = new DistrictWorld(renderer, ask.hold ? 0 : 0.4);
    this.movers = new DistrictMovers(renderer);
    for (const row of new URLSearchParams(location.search).get('hide')?.split(',') ?? [])
      if (row !== '') this.world.hidden.add(Number(row));
    this.input = new InputSource(canvas, KEYS);
    canvas.addEventListener('click', () => this.input.requestPointerLock());
    this.walker = new Walker(this.input);
    this.day = new CityClock(ask.hour ?? 21.5);
    this.weather = ask.weather ?? 0;
    this.fog = ask.fog;
    this.holdClock = ask.hold;
    const rain = (WEATHERS[this.weather] as (typeof WEATHERS)[number])[1];
    this.wetness = new Wetness(rain > 0 ? 1 : 0);
    this.lamps = new CityLamps(renderer, this.env);
    this.rain = new CityRain(renderer);
    this.hud = new DistrictHud(renderer, 'A DISTRICT AFTER DARK');
    this.grade = ask.grade ? new DistrictGrade() : null;
    renderer.setVignette(ask.grade ? VIGNETTE : 0);
    this.hudFrame = {
      hour: 0,
      fps: 60,
      ms: 0,
      weather: '',
      mode: '',
      view: '',
      viewAge: 99,
      resident: 0,
      total: 1,
      ready: false,
      help: false,
      detail: 'ARRIVING',
    };
  }

  open(): void {
    Promise.all([fetch(CONTAINER), fetch(SCENE)])
      .then(async ([container, scene]) => {
        /* A dev server answers a missing file with its own page, so a 200 is not enough: the type says. */
        const baked = (r: Response): boolean =>
          r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
        if (!baked(container) || !baked(scene))
          throw new Error('THE DISTRICT IS NOT BAKED YET: NPM RUN DISTRICT:BAKE');
        return this.world.open(container, scene);
      })
      .catch((error: unknown) => {
        this.failed = error instanceof Error ? error.message : String(error);
      });
    /* The traffic streams beside the city, and a district baked without it is still a district. */
    this.movers
      .open(BASE)
      .catch((error: unknown) => console.warn('district: the traffic did not load', error));
  }

  private get rainNow(): number {
    return (WEATHERS[this.weather] as (typeof WEATHERS)[number])[1];
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    const world = this.world;
    world.update(dtSec);
    this.movers.update(dtSec, this.seconds);
    this.arrive();
    this.keys();
    if (!this.ask.hold) {
      this.accumulated = Math.min(this.accumulated + dtSec, STEP * MAX_STEPS);
      while (this.accumulated >= STEP) {
        this.accumulated -= STEP;
        if (this.ready) this.walker.step(STEP);
        if (!this.holdClock) this.day.tick(STEP);
        this.wetness.step(this.rainNow, STEP / HOUR_SEC);
        this.seconds += STEP;
      }
    }
    this.viewAge += dtSec;
    const alpha = this.ask.hold ? 1 : this.accumulated / STEP;
    this.walker.eye(alpha, this.eye);
    this.aim();

    const env = this.env;
    const x = this.eye[0] as number;
    const y = this.eye[1] as number;
    const z = this.eye[2] as number;
    const night = nightAt(this.day.hour);
    this.sky.apply(this.day.hour, this.wetness.value, env, this.rainNow);
    /*
     * The district's own glow off the sky: a city this lit is never dark overhead, and a cloud
     * sends more of it back. Faint and violet, what a river or a back street far from any fixture
     * is lit by at night.
     */
    const glow = night * (1 + 0.6 * this.rainNow);
    for (let c = 0; c < 3; c++) {
      env.ambient[c] = (env.ambient[c] as number) + (CITY_GLOW[c] as number) * glow;
      (env.ambientGround as number[])[c] =
        ((env.ambientGround as number[])[c] as number) + (CITY_GLOW_GROUND[c] as number) * glow;
    }
    if (this.fog) env.fogDensity = Math.max(env.fogDensity, 0.012);
    this.renderer.setBloom(1, bloomThreshold(env));
    /* A night exposed as a film exposes one: up a little, so the dark streets read and the lamps clip. */
    this.renderer.setOutputExposure(DAY_EXPOSURE + (NIGHT_EXPOSURE - DAY_EXPOSURE) * night);
    this.lamps.update(night, x, y, z, dtSec, env);
    if (this.ask.lamps === 'field') env.lightCount = 0;
    this.rain.update(this.ask.hold ? 0 : dtSec, x, y, z, this.rainNow);
    world.shine(night, this.seconds, this.ask.glow ? 1 : 0);
    this.look(night);
    const waters = this.waters;
    if (waters !== null) {
      waters.weather(this.rainNow, night);
      waters.choose(x, z);
    }

    const camera = this.camera;
    const timer = this.renderer.gpuTimer;
    timer.beginFrame();
    if (this.ready) this.shadow(x, y, z);
    this.renderer.beginFrame(this.sky.colors.horizon);
    /* The street seen from under the water, while a body of it is near enough to show it. */
    /* Not before one real pass has been counted: the first frame's allowance would be the whole ring. */
    this.mirrored = -1;
    if (
      this.ready &&
      this.ask.mirror &&
      waters !== null &&
      y > waters.level &&
      waters.seen(this.frustum, MIRROR_M) &&
      world.lastChanges > 0 &&
      this.mirrorAllowance() >= MIRROR_LEAST
    ) {
      const mirrored = this.renderer.beginPlanarReflection(
        camera,
        waters.level,
        this.sky.colors.horizon,
      );
      this.mirrored = mirrored === null ? 0 : this.mirrorAllowance();
      if (mirrored !== null) {
        frustumFromViewProjection(mirrored.viewProjection, this.mirrorFrustum);
        this.renderer.bindMeshPass(mirrored, env);
        world.draw(
          mirrored.position,
          mirrored.fovYDeg,
          this.canvas.height,
          this.mirrorFrustum,
          true,
          this.mirrorAllowance(),
          this.renderer.quality.drawsPerFrame - DRAW_MARGIN - this.stats.draws,
        );
        this.sky.draw(this.renderer, mirrored, env);
        this.renderer.endPlanarReflection();
      }
    }
    timer.begin('rest');
    this.renderer.bindMeshPass(camera, env);
    if (this.ready) {
      world.draw(this.eye, camera.fovYDeg, this.canvas.height, this.frustum);
      this.movers.draw();
      world.issued += this.movers.changes;
      this.sky.draw(this.renderer, camera, env);
      /* After the sky, which its far edge fades into, and before the glass, which lies over it. */
      if (waters !== null)
        world.issued += waters.draw(
          camera,
          this.seconds,
          env,
          1.2 + 5 * this.rainNow,
          0.6 + 2 * this.rainNow,
        );
      world.drawLater();
      this.movers.drawLater();
      this.rain.draw(camera, env);
    }
    timer.end();
    this.renderer.endFrame();
    this.interface(dtSec, camera, env);
    timer.endFrame();
    const sample = timer.poll();
    if (sample !== null) this.stats.gpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.draws = world.issued;
    this.stats.extra = this.failed ?? this.readout();
    return this.stats;
  }

  private keys(): void {
    const input = this.input;
    if (input.consumeKeyPress('KeyT')) this.day.skip();
    if (input.consumeKeyPress('KeyG')) this.day.hour = (this.day.hour + 23) % 24;
    if (input.consumeKeyPress('KeyN')) this.day.hour = nightAt(this.day.hour) > 0.5 ? DAY_HOUR : 22;
    if (input.consumeKeyPress('KeyP')) this.holdClock = !this.holdClock;
    if (input.consumeKeyPress('KeyR')) this.weather = (this.weather + 1) % WEATHERS.length;
    if (input.consumeKeyPress('KeyO')) this.fog = !this.fog;
    if (input.consumeKeyPress('KeyH')) this.help = !this.help;
    const views = this.world.scene?.views ?? [];
    if (views.length === 0) return;
    if (input.consumeKeyPress('KeyV')) this.take((this.viewIndex + 1) % views.length);
    if (input.consumeKeyPress('KeyB'))
      this.take((this.viewIndex - 1 + views.length) % views.length);
    for (let d = 1; d <= 9; d++)
      if (input.consumeKeyPress(`Digit${d}`)) this.take(Math.min(views.length - 1, d - 1));
  }

  /** Stand where a camera of the source stands, flying, looking where it looks. */
  private take(index: number): void {
    const view = this.world.scene?.views[index];
    if (view === undefined) return;
    this.viewIndex = index;
    this.viewAge = 0;
    const [fx, fy, fz] = view.forward;
    this.walker.place(
      view.position[0],
      view.position[1] - EYE_M,
      view.position[2],
      Math.atan2(fx, fz),
    );
    this.walker.fly(view.position[1]);
    this.walker.pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
  }

  private interface(dt: number, camera: Camera, env: Environment): void {
    const frame = this.hudFrame;
    frame.hour = this.day.hour;
    frame.fps = dt > 0 ? frame.fps + (1 / dt - frame.fps) * 0.1 : frame.fps;
    frame.ms = this.stats.gpuMs > 0 ? this.stats.gpuMs : dt * 1000;
    frame.weather = `${(WEATHERS[this.weather] as (typeof WEATHERS)[number])[0]}${this.fog ? '  FOG' : ''}${this.holdClock ? '  HELD' : ''}`;
    frame.mode = this.walker.flying ? 'FLYING' : 'WALKING';
    frame.view =
      this.viewIndex >= 0
        ? (this.world.scene?.views[this.viewIndex]?.name
            .replace(/^view_/, '')
            .replace(/_/g, ' ')
            .toUpperCase() ?? '')
        : '';
    frame.viewAge = this.viewAge;
    frame.resident = this.walkable.resident;
    frame.total = this.walkable.total;
    frame.ready = this.ready;
    frame.help = this.help;
    frame.detail =
      this.failed ??
      `ARRIVING ${this.walkable.resident} OF ${this.walkable.total} REGIONS ABOUT YOU`;
    this.hud.draw(frame, dt, camera, env);
  }

  private arrive(): void {
    const world = this.world;
    const scene = world.scene;
    if (scene === null) return;
    if (!this.placed) {
      const views = scene.views;
      const named =
        this.ask.view === null
          ? -1
          : views.findIndex((v) => v.name === this.ask.view || v.name === `view_${this.ask.view}`);
      const numbered =
        this.ask.view !== null && /^\d+$/.test(this.ask.view) ? Number(this.ask.view) - 1 : -1;
      const chosen = named >= 0 ? named : numbered;
      const at = this.ask.at;
      if (at !== null) {
        this.walker.place(
          at[0] as number,
          (at[1] as number) - EYE_M,
          at[2] as number,
          ((at[3] ?? 0) * Math.PI) / 180,
        );
        this.walker.fly(at[1] as number);
        this.walker.pitch = ((at[4] ?? 0) * Math.PI) / 180;
      } else if (chosen >= 0 && chosen < views.length) this.take(chosen);
      else this.walker.place(scene.spawn.x, scene.spawn.y, scene.spawn.z, scene.spawn.yaw);
      this.placed = true;
    }
    this.walker.eye(1, this.eye);
    this.walkable = world.pageAround(this.eye[0] as number, this.eye[2] as number, WALKABLE_M);
    for (const region of world.loader.regions.values())
      this.walker.admit(region.id, region.collision);
    this.ready =
      this.ready ||
      (this.walkable.resident === this.walkable.total &&
        this.walkable.total > 0 &&
        world.loader.textures !== null);
    if (this.judgedLights === null && world.loader.lights.length > 0) {
      /* Judged once, as the bake judged them for the volume; a light's kind leaves in its name. */
      this.judgedLights = [];
      for (const l of world.loader.lights) {
        const intensity = judged(kindOfLight(l.name), l.intensity, this.ask.gains);
        /* A faint glow is the volume's alone: shaded exactly it would take a slot from a lamp. */
        if (intensity >= EXACT_FLOOR)
          this.judgedLights.push({ ...l, name: 'night', intensity, range: reachOf(intensity) });
      }
    }
    if (this.ask.lamps !== 'none' && this.judgedLights !== null)
      this.lamps.arrive(
        this.judgedLights,
        this.ask.lamps === 'exact' ? null : world.loader.lightVolume,
        scene.lightUnit,
      );
    if (this.waters === null && scene.water !== null && scene.water !== undefined)
      this.waters = new DistrictWaters(this.renderer, scene.water);
  }

  /**
   * The material changes the mirror may spend: the frame's ring, less what the last real frame
   * spent and a margin for the water, the sky, the rain and the interface.
   */
  private mirrorAllowance(): number {
    return (
      this.renderer.quality.materialChangesPerFrame -
      MATERIAL_MARGIN -
      this.world.lastChanges -
      this.movers.changes
    );
  }

  /** The grade for this hour, whole: the day's or the night's or between them, set only when it moves. */
  private look(night: number): void {
    const table = this.grade?.at(night) ?? null;
    if (table !== null) this.renderer.setColourGrade(table, 1);
  }

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
    this.renderer.drawShadowCasters(this.movers.casters);
    this.renderer.endShadowPass();
  }

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
    if (!this.ready)
      return `${time} · arriving: ${this.world.loader.regions.size} regions, ${this.walkable.resident} of ${this.walkable.total} about the walker`;
    const q = this.world.queued;
    const at = `at ${Math.round(this.eye[0] as number)},${Math.round(this.eye[1] as number)},${Math.round(this.eye[2] as number)},${Math.round((this.walker.yaw * 180) / Math.PI)},${Math.round((this.walker.pitch * 180) / Math.PI)}`;
    let materials = '';
    for (const line of this.renderer.frameBudget.lines)
      if (line.name === 'materials')
        materials = ` · materials ${line.used}${line.dropped > 0 ? ` DROPPED ${line.dropped}` : ''}`;
    const f = (
      this.lamps as unknown as { field: { presence: number; radius: number; scale: number } | null }
    ).field;
    const fieldText =
      f === null
        ? ' · no field'
        : ` · field ${f.presence.toFixed(2)} r ${f.radius.toFixed(1)} x${f.scale.toFixed(3)}`;
    const w = this.waters;
    const mirror =
      (w === null ? ' · no water' : ` · water ${Math.round(w.nearest)} m`) +
      (this.mirrored < 0
        ? ''
        : this.mirrored === 0
          ? ' · mirror refused'
          : ` · mirror ${this.mirrored}`);
    const traffic = this.movers.playing > 0 ? ` · ${this.movers.playing} movers` : '';
    return `${time} · ${at} · ${this.env.lightCount} lamps near${fieldText}${materials}${mirror}${traffic} · statics ${q.statics} copies ${q.copies} coarse ${q.coarse} paging ${q.paging} · wet ${this.wetness.value.toFixed(2)}${this.walker.flying ? ' · flying' : ''}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
    this.waters?.dispose();
    this.movers.dispose();
    this.world.loader.dispose();
    this.renderer.dispose();
  }
}

export const district: DemoScene = {
  id: 'district',
  title: 'A district after dark',
  loadsModel: true,
  note:
    "A bought Blender city read by the engine's own .blend reader, baked into one streamed container " +
    'and walked through or flown over, by day, by night and in the rain.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const created = await createRenderer(
      canvas,
      (drawing) => ({
        clusteredLights: true,
        /* A lamp is a small bright pool, as it is in a street: see `district/lighting.ts`. */
        pointLightFalloff: 'inverseSquare' as const,
        materialChangesPerFrame: MATERIAL_RING,
        drawsPerFrame: DRAW_RING,
        hdrScene: true,
        outputTransform: 'aces' as const,
        /* A soft halo on what clears the threshold — lamps, neon — and nothing else. */
        bloom: 0.22,
        bloomThreshold: BLOOM_THRESHOLD,
        temporalAa: true,
        ...tierQuality(tierFrom(location.search), drawing),
        directionalShadowMaxDistance: SHADOW_M,
        ...overrides,
      }),
      DEMO_BACKEND,
    );
    await created.renderer.ready();
    const handle = new DistrictHandle(created.renderer, created.backend, canvas, asked());
    handle.open();
    return handle;
  },
};
