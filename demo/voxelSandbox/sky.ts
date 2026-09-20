/**
 * The sky, which the engine draws.
 *
 * **This is the port's largest single subtraction, and it reverses the spec's last prediction.**
 * The reference spends a 121-line WGSL shader on a gradient dome plus a star field, a moon disc
 * with mare shading and a three-tier sun glow, and a further 127-line module on a scrolling cloud
 * quad. `drawSky` has all of it — gradient, sunset reddening, sun disc, stars, a moon with a
 * *phase*, and banded cloud noise carried on an offset — so 248 lines become this adapter.
 *
 * Spec §5 named the sky dome as the one remaining candidate for a contributed pass after the
 * water surface turned out to be an engine feature. It is not one either.
 *
 * All this file does is turn a `LightingSnapshot` into `SkyColors` and keep the clouds moving.
 */
import type {
  RendererApi,
  SkyColors,
  Vec3,
  Camera,
  Environment,
} from '../../packages/core/src/index';

import type { LightingSnapshot } from './lighting';

/** How fast the cloud layer drifts, in offset units a second. */
const CLOUD_DRIFT = 0.9;

/**
 * The sun's apparent radius, in radians — about seven times the real one.
 *
 * **The real sun was the number here, and it drew a speck.** Half a degree across is five pixels of
 * a 720-pixel frame at the sandbox's 70 degrees, which reads as a star; a player said so. A block
 * world's sky is drawn at the size a player reads it: 0.035 is about 45 pixels of bright disc with
 * the engine's soft edge, and past 0.05 the glow `drawSky` derives from the same number starts to
 * wash the sky around it.
 */
export const SUN_ANGULAR_RADIUS = 0.035;
/** The moon's, kept the fraction of the sun's it was when both were the real sizes. */
export const MOON_ANGULAR_RADIUS = 0.034;

const MOON_COLOR: Vec3 = [0.95, 0.95, 0.88];

export class Sky {
  /* One object, written in place each frame: the frame loop must not allocate. */
  private readonly colors: SkyColors = {
    top: [0, 0, 0],
    horizon: [0, 0, 0],
    deep: [0, 0, 0],
    sunDir: [0, 1, 0],
    sunColor: [1, 1, 1],
    sunAngularRadius: SUN_ANGULAR_RADIUS,
    moonDir: [0, -1, 0],
    moonColor: MOON_COLOR,
    moonAngularRadius: MOON_ANGULAR_RADIUS,
    /* A fixed gibbous rather than a cycle: the reference's moon has no phase at all, and an
       arbitrary animated one would be inventing a fact about this world. */
    moonPhase: 0.72,
    nightFactor: 0,
    cloudOffsetX: 0,
    cloudOffsetZ: 0,
  };

  private drift = 0;

  /** Advance the clouds and take the frame's colours from the clock. */
  update(dtSec: number, lighting: LightingSnapshot): void {
    this.drift += dtSec * CLOUD_DRIFT;

    const c = this.colors;
    copy(c.top, lighting.zenithColor);
    /* The horizon is the fog colour exactly, which is what makes terrain fade into sky rather
       than into a visible band where the two meet. */
    copy(c.horizon, lighting.fogColor);
    copy(c.deep, lighting.fogColor);
    copy(c.sunDir, lighting.sunDir);
    copy(c.sunColor, lighting.sunColor);

    /* Opposite the sun, as a moon is. */
    c.moonDir[0] = -lighting.sunDir[0];
    c.moonDir[1] = -lighting.sunDir[1];
    c.moonDir[2] = -lighting.sunDir[2];

    /* Stars, the moon and the cloud tint all fade on this. */
    c.nightFactor = lighting.nightFactor;
    c.cloudOffsetX = this.drift;
    c.cloudOffsetZ = this.drift * 0.6;
  }

  draw(renderer: RendererApi, camera: Camera, env: Environment): void {
    renderer.drawSky(camera, this.colors, env);
  }
}

function copy(into: Vec3, from: Vec3): void {
  into[0] = from[0];
  into[1] = from[1];
  into[2] = from[2];
}
