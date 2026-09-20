/**
 * What the sandbox's page asks for, and the environment that follows from it.
 *
 * **Two flags, read once at mount.** `?pipeline=gpu-driven` draws the terrain on the second
 * pipeline and anything else keeps the forward path, so one page draws the same world both ways;
 * `?radius=` overrides the render radius on both, which is what makes a matched-radius comparison
 * possible at all.
 *
 * **The haze is a function of the radius, not two constants beside it.** The reference's fog radii
 * were written against a radius of six — `(RENDER_RADIUS - 1) * 16 * 0.6` and
 * `RENDER_RADIUS * 16 * 0.95` — so a radius that moved without them would end the world at a hard
 * circle past a haze that stopped short, or bury terrain the player stands beside. The expressions
 * are kept verbatim, so with no flags every number is the one it was.
 */
import { createEnvironment, type Environment, type Vec3 } from '../../packages/core/src/index';

import { CHUNK_SX } from './constants';

export type SandboxPipeline = 'forward' | 'gpu-driven';

export interface SandboxOptions {
  readonly pipeline: SandboxPipeline;
  /** Horizontal render radius, in chunks. */
  readonly radius: number;
  /** Where the haze begins and where it is total, in metres. */
  readonly fogStart: number;
  readonly fogEnd: number;
  /** The camera's far plane, in metres. */
  readonly far: number;
  /** `?at=x,z`: where to look for a spawn instead of the origin. Null when not asked. */
  readonly at: { readonly x: number; readonly z: number } | null;
  /** `?look=yaw,pitch`, in degrees: which way the player starts facing. Null when not asked. */
  readonly look: { readonly yaw: number; readonly pitch: number } | null;
  /**
   * `?fly=`, in metres a second: the eye moves forward at that speed above the spawn's ground,
   * without input, so a measurement streams chunks as walking does. Null when not asked.
   */
  readonly fly: number | null;
  /**
   * `?portshadow=1`: the second pipeline draws the sun's shadow. Off otherwise, because the
   * forward sandbox draws none and the two are compared doing the same work; this is for
   * measuring the shadow stage on a world, and the published sandbox never sets it.
   */
  readonly portShadow: boolean;
}

/**
 * The largest radius the page will take. A typo of a hundred would mesh forty thousand chunks
 * before the first frame; thirty-two is already four thousand, and past anything either pipeline
 * sustains.
 */
export const MAX_RADIUS = 32;

/**
 * Metres around the eye the port's shadow map covers, once the world is larger than that — which
 * it always is. Three chunks either way: a 2048 map over 96 metres has texels under five
 * centimetres, where one map over the world at radius 14 had texels a quarter of a metre wide.
 */
export const PORT_SHADOW_RADIUS = 3 * CHUNK_SX;

/** The far plane the sandbox has always had, and why is in its constructor. */
const CAMERA_FAR = 220;

const FOG_COLOR: Vec3 = [0.7, 0.82, 0.92];

/**
 * @param search The page's query, `location.search` in a browser.
 * @param radius The budget's own radius, which `?radius=` overrides.
 * @param picked The pipeline a host chose from the scene's `pipelines`, which wins over
 *   `?pipeline=` — the query is the harness's way in, and a page that chose gets what it chose.
 */
export function sandboxOptions(
  search: string,
  radius: number,
  picked?: SandboxPipeline,
): SandboxOptions {
  const asked = new URLSearchParams(search);
  const pipeline: SandboxPipeline =
    picked ?? (asked.get('pipeline') === 'gpu-driven' ? 'gpu-driven' : 'forward');
  const requested = Number(asked.get('radius') ?? '');
  const chosen =
    Number.isInteger(requested) && requested >= 1 && requested <= MAX_RADIUS ? requested : radius;
  const fogStart = (chosen - 1) * CHUNK_SX * 0.6;
  const fogEnd = chosen * CHUNK_SX * 0.95;
  /*
   * **The far plane grows only once the haze would reach past it.** It was brought in to 220 m for
   * depth precision, which a first-person near plane of 0.15 needs; keeping it there while the fog
   * ran to 240 would clip the world's far edge out of a haze meant to swallow it.
   */
  const far = Math.max(CAMERA_FAR, Math.ceil(fogEnd) + CHUNK_SX);
  /*
   * **Where to stand and which way to look**, because a capture sees one view and the spawn's has
   * no water in it: the port's blended half has to be photographed on both pipelines from one
   * place. Two numbers each or nothing.
   */
  const place = pairOf(asked.get('at'));
  const heading = pairOf(asked.get('look'));
  return {
    pipeline,
    radius: chosen,
    fogStart,
    fogEnd,
    far,
    at: place === null ? null : { x: place[0], z: place[1] },
    look: heading === null ? null : { yaw: heading[0], pitch: heading[1] },
    fly: speedOf(asked.get('fly')),
    portShadow: asked.get('portshadow') === '1',
  };
}

/** A positive, finite number of metres a second, or null. */
function speedOf(text: string | null): number | null {
  if (text === null || text.trim() === '') return null;
  const speed = Number(text);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

/** Two finite numbers separated by a comma, or null. */
function pairOf(text: string | null): [number, number] | null {
  if (text === null) return null;
  const parts = text.split(',');
  if (parts.length !== 2 || parts.some((part) => part.trim() === '')) return null;
  const [a, b] = parts.map(Number) as [number, number];
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

/**
 * The sandbox's light and air, on the radii the page asked for.
 *
 * **`emissiveGain` is one.** It was zero, and the forward shader multiplies block light by it as
 * well as by the night factor — so every torch in the world was dark at every hour, while the
 * mesher's own comment says block light is "gated on the environment's nightFactor". On WebGPU that
 * was invisible while the backend hard-coded the gain to 1, and became total the day it started
 * reading the environment. The day-night clock drives `nightFactor`; the gain stays at one.
 */
export function sandboxEnvironment(options: SandboxOptions): Environment {
  return createEnvironment({
    directionalDir: [-0.36, 0.72, 0.59],
    directionalColor: [1.18, 1.06, 0.86],
    ambient: [0.34, 0.4, 0.5],
    ambientGround: [0.24, 0.24, 0.19],
    emissiveGain: 1,
    nightFactor: 0,
    fogColor: FOG_COLOR,
    /* The reference hand-writes a ramp between two radii, and `linear` is documented as exactly
       that: nothing before `fogNear`, the fog colour entirely at `fogFar`. */
    fogMode: 'linear',
    fogNear: options.fogStart,
    fogFar: options.fogEnd,
    fogDensity: 0,
    fogHeightFalloff: 0,
    fogBaseY: 0,
  });
}
