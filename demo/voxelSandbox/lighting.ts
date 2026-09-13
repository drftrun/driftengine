/**
 * The clock, and every colour that follows from it.
 *
 * One source of truth for the world's lighting: a phase in `[0,1)` where 0 is midnight, 0.25 is
 * sunrise, 0.5 is noon and 0.75 is sunset. Everything else — sun direction, sun colour, ambient,
 * fog, zenith — is derived, so nothing can drift out of step with anything else. The fog and the
 * horizon are deliberately the same colour, which is what makes the terrain fade into the sky
 * rather than into a band.
 *
 * **The snapshot is the same object every call.** `frame` runs sixty times a second and must not
 * allocate, so the ramps write into fields through `mixColorInto` and the snapshot is a view of
 * them.
 *
 * `nightFactor` has no counterpart in the reference and is required here: the engine gates
 * emissive on it, so block light stays invisible until this drives one. That is the single most
 * likely reason a correct mesher looks broken.
 */
import { mixColorInto, type Vec3 } from '../../packages/core/src/index';

/* Palette keyframes. Night is floored rather than black, so a world at midnight is still
   readable and the fog never becomes a hole in the picture. */
const DAY_AMBIENT: Vec3 = [0.45, 0.48, 0.55];
const NIGHT_AMBIENT: Vec3 = [0.12, 0.14, 0.22];
const SUNSET_AMBIENT_TINT: Vec3 = [0.12, 0.05, 0.02];

const DAY_SUN: Vec3 = [0.55, 0.5, 0.42];
const SUNSET_SUN: Vec3 = [0.85, 0.42, 0.16];

const DAY_FOG: Vec3 = [0.7, 0.82, 0.92];
const NIGHT_FOG: Vec3 = [0.03, 0.04, 0.09];
const SUNSET_FOG: Vec3 = [0.8, 0.52, 0.4];

const DAY_ZENITH: Vec3 = [0.28, 0.5, 0.86];
const NIGHT_ZENITH: Vec3 = [0.02, 0.03, 0.08];
const SUNSET_ZENITH: Vec3 = [0.3, 0.3, 0.55];

export interface LightingSnapshot {
  readonly sunDir: Vec3;
  readonly sunColor: Vec3;
  readonly ambientColor: Vec3;
  readonly fogColor: Vec3;
  readonly zenithColor: Vec3;
  /** 0 in full day, 1 in full night. The engine gates emissive on it. */
  nightFactor: number;
}

export interface LightingOptions {
  /** Seconds a full day takes. The reference's 150. */
  dayLengthSec: number;
  /** Where to start, in `[0,1)`. Defaults to mid-morning so a first look is lit. */
  startTimeOfDay?: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class Lighting {
  private readonly dayLength: number;
  private timeOfDay: number;

  /* Written in place by `recompute`; the snapshot is a view of these. */
  private readonly sunDir: Vec3 = [0, 1, 0];
  private readonly sunColor: Vec3 = [0, 0, 0];
  private readonly ambient: Vec3 = [0, 0, 0];
  private readonly fog: Vec3 = [0, 0, 0];
  private readonly zenith: Vec3 = [0, 0, 0];
  private readonly view: LightingSnapshot;

  constructor(options: LightingOptions) {
    this.dayLength = options.dayLengthSec;
    this.timeOfDay = (((options.startTimeOfDay ?? 0.35) % 1) + 1) % 1;
    /* The vectors are held by reference and written in place; only the scalar is assigned. */
    this.view = {
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      ambientColor: this.ambient,
      fogColor: this.fog,
      zenithColor: this.zenith,
      nightFactor: 0,
    };
    this.recompute();
  }

  get time(): number {
    return this.timeOfDay;
  }

  set time(t: number) {
    this.timeOfDay = ((t % 1) + 1) % 1;
    this.recompute();
  }

  tick(dtSec: number): void {
    this.timeOfDay = (this.timeOfDay + dtSec / this.dayLength) % 1;
    this.recompute();
  }

  /** The same object every call. Read it, do not keep it past the frame. */
  snapshot(): LightingSnapshot {
    return this.view;
  }

  /** A 24-hour clock, for the readout. */
  clockText(): string {
    const minutes = Math.floor(this.timeOfDay * 24 * 60);
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  private recompute(): void {
    /* The sun rises east, passes overhead and sets west, with a fixed tilt on z so no face is
       ever lit perfectly axis-aligned — which would flatten a whole side of the world. */
    const theta = (this.timeOfDay - 0.25) * Math.PI * 2;
    const sx = Math.cos(theta);
    const sy = Math.sin(theta);
    const sz = 0.3;
    const inv = 1 / Math.hypot(sx, sy, sz);
    this.sunDir[0] = sx * inv;
    this.sunDir[1] = sy * inv;
    this.sunDir[2] = sz * inv;

    const elevation = this.sunDir[1];
    const day = smoothstep(-0.05, 0.25, elevation);
    /* Twilight peaks with the sun near the horizon and fades out once it is properly down. */
    const nearHorizon = clamp01(1 - Math.abs(elevation) / 0.25);
    const twilight = nearHorizon * nearHorizon * smoothstep(-0.2, -0.04, elevation);

    mixColorInto(this.ambient, NIGHT_AMBIENT, DAY_AMBIENT, day);
    this.ambient[0] += SUNSET_AMBIENT_TINT[0] * twilight;
    this.ambient[1] += SUNSET_AMBIENT_TINT[1] * twilight;
    this.ambient[2] += SUNSET_AMBIENT_TINT[2] * twilight;

    /* Warm at the horizon, whiter at noon, and off entirely once the sun is below. */
    const intensity = smoothstep(-0.05, 0.15, elevation);
    mixColorInto(this.sunColor, SUNSET_SUN, DAY_SUN, smoothstep(0.08, 0.35, elevation));
    this.sunColor[0] *= intensity;
    this.sunColor[1] *= intensity;
    this.sunColor[2] *= intensity;

    mixColorInto(this.fog, NIGHT_FOG, DAY_FOG, day);
    mixColorInto(this.fog, this.fog, SUNSET_FOG, twilight * 0.7);

    mixColorInto(this.zenith, NIGHT_ZENITH, DAY_ZENITH, day);
    mixColorInto(this.zenith, this.zenith, SUNSET_ZENITH, twilight * 0.5);

    this.view.nightFactor = 1 - day;
  }
}
