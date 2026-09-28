/**
 * A flame: one point light and one plume from a single description, flickering at the rate a flame
 * of that size flickers.
 *
 * **The rate is physics, not taste.** A buoyant flame puffs at about 1.5 / √D times a second for a
 * burning area D metres across (Cetegen and Ahmed, 1993). That is 15 Hz for a candle's centimetre,
 * which is why a candle trembles, and 2.4 Hz for a 40 cm brazier, which is why a fire breathes.
 * Before this, a scene wired its plume, its light and a flicker amplitude by hand. The selection's
 * shared wobble ran every light at the same two rates, so a candle and a bonfire pulsed together.
 *
 * **What the description fixes.** The flame stands 2.5 D tall, which is a candle's 2.5 cm and a
 * brazier's metre. The light sits a third of the way up it, where a flame is brightest, and its
 * physical radius is D / 2, so its shadows soften as a fire's do. It sways by up to 6 per cent of
 * the flame's height on each axis, a few centimetres for a brazier, so a shadow it casts travels
 * rather than only dimming.
 *
 * **What it gives up.** The waveform is two sines, the pulse and a harmonic, which never gust. A
 * fire in wind wants its sway driven by the scene's `WindField`, and nothing here reads one. What
 * would make the rate wrong is a flame far outside the law's range: a jet, or a pool fire of
 * several metres, which puffs slower than the formula says.
 *
 * Plain data and two functions. `updateFlame` writes into the light it made and allocates nothing,
 * so a scene updates every flame in its frame and hands the lights to `selectPointLights`.
 */
import type { Vec3 } from '../math/color.ts';
import type { PlumePlacement } from './plumeRenderer.ts';
import type { PointLightSource } from './pointLightSelection.ts';

export interface FlameOptions {
  /** Where the fire burns from, world space: the wick's tip, the top of the coals. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** How wide the burning area is, metres: a candle 0.01, a lantern 0.03, a brazier's bowl 0.4. */
  readonly diameterM: number;
  /** The light's colour at its mean brightness, in the caller's light units. */
  readonly color: Vec3;
  /** Metres at which the light ends. */
  readonly radius: number;
  /** How far the brightness swings either side of its mean, 0 to 1. Defaults to 0.18. */
  readonly flicker?: number;
  /** Keeps two flames of one size out of step. Defaults to 0. */
  readonly seed?: number;
  /** Whether the light may take a shadow slot. Defaults to true, as `PointLightSource` does. */
  readonly castsShadow?: boolean;
  /**
   * How far the light wanders on each axis, as a share of the flame's height. Defaults to 0.06.
   *
   * 0 holds it still. A point light's static shadow map is baked from where the light stood, so a
   * light that wanders reads that map from a few centimetres off. What would make the default wrong
   * is a flame near a surface it shadows, where that offset shows as a band.
   */
  readonly sway?: number;
}

export interface Flame {
  /** Rewritten by `updateFlame`. Offer it to `selectPointLights` with the scene's other lights. */
  readonly light: PointLightSource;
  /** Where the plume stands and how big it is, for `createPlumes`. */
  readonly plume: PlumePlacement;
  /** Pulses a second: 1.5 / √D. */
  readonly frequencyHz: number;
  readonly centre: Vec3;
  readonly color: Vec3;
  readonly flicker: number;
  readonly phase: number;
  readonly swayM: number;
}

/** How tall a flame stands, as a multiple of the width it burns from. */
const HEIGHT_PER_DIAMETER = 2.5;
/** How far the light sways on each axis, as a share of the flame's height. */
const SWAY_PER_HEIGHT = 0.06;
/** The harmonic's rate against the pulse's, chosen irrational so the two never lock. */
const HARMONIC = 2.37;

/** The puffing rate of a flame burning from `diameterM` metres across. */
export function flameFrequencyHz(diameterM: number): number {
  return 1.5 / Math.sqrt(Math.max(diameterM, 1e-3));
}

export function createFlame(options: FlameOptions): Flame {
  const height = HEIGHT_PER_DIAMETER * options.diameterM;
  const centre: Vec3 = [options.x, options.y + height / 3, options.z];
  const swayM = (options.sway ?? SWAY_PER_HEIGHT) * height;
  /* A seed spread over the whole turn, so seeds 1 and 2 are not neighbours in phase. */
  const phase = ((options.seed ?? 0) * 2.399963) % (Math.PI * 2);
  const light: PointLightSource = {
    x: centre[0],
    y: centre[1],
    z: centre[2],
    r: options.color[0],
    g: options.color[1],
    b: options.color[2],
    radius: options.radius,
    /* Off, because this helper is the flicker; the selection's own would apply a second one. */
    flicker: 0,
    /*
     * **Clear of what the fire burns from wherever the light has wandered**, which is the sway added
     * to the near plane a still flame would want. The shadow map is baked from where the light
     * stood, so the cut moves with it, and each axis moves by at most `swayM`: a near plane of D
     * alone left a brazier's bowl 7 mm inside it at the top of the sway and 13 cm outside at the
     * bottom, and the bowl's shadow on the floor under the brazier came and went with every
     * re-bake — a dark disc on some, none on others.
     *
     * What it gives up is `swayM` of shadow nearest the light, which is inside the fixture. What
     * would make it wrong is a fixture reaching further below the flame than D / 6: this clears
     * that far and no further, so a deep bowl sets its own `shadowNear` from its own depth.
     */
    shadowNear: Math.max(0.05, options.diameterM) + swayM,
    sourceRadius: options.diameterM / 2,
    ...(options.castsShadow === false ? { castsShadow: false } : {}),
  };
  return {
    light,
    plume: {
      x: options.x,
      y: options.y,
      z: options.z,
      width: options.diameterM / 2,
      height,
    },
    frequencyHz: flameFrequencyHz(options.diameterM),
    centre,
    color: [options.color[0], options.color[1], options.color[2]],
    flicker: options.flicker ?? 0.18,
    phase,
    swayM,
  };
}

/** Where the flame's light is and how bright, at `timeSeconds`. Writes `flame.light` in place. */
export function updateFlame(flame: Flame, timeSeconds: number): void {
  const w = 2 * Math.PI * flame.frequencyHz * timeSeconds;
  const p = flame.phase;
  const pulse = 0.65 * Math.sin(w + p) + 0.35 * Math.sin(HARMONIC * w + 1.9 * p);
  const scale = 1 + flame.flicker * pulse;
  const light = flame.light;
  light.r = flame.color[0] * scale;
  light.g = flame.color[1] * scale;
  light.b = flame.color[2] * scale;
  /* The sway runs slower than the pulse and on its own rates, so the light wanders rather than
     tracing one loop. Up when the flame puffs up. */
  const sway = flame.swayM;
  light.x = flame.centre[0] + sway * Math.sin(0.83 * w + 2.1 * p);
  light.y = flame.centre[1] + sway * Math.sin(w + p);
  light.z = flame.centre[2] + sway * Math.cos(0.71 * w + 3.3 * p);
}
