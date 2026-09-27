/**
 * Eye adaptation: the frame's own brightness, measured on the GPU and followed over time.
 *
 * **A fixed exposure is right for one view and wrong for the next.** A courtyard with the sun on
 * its upper walls and its floor in the shade of a 19 m wall is several stops darker at ground level
 * than from the gallery, and an exposure set for one draws the other either clipped or black. A
 * camera meters and an eye adapts; this does both, from the finished scene, with no readback.
 *
 * **Two passes, both tiny.** The meter writes a 32×32 grid, each texel the mean of 8×8 taps of log
 * luminance over its share of the frame. The adaptation reads all 1,024 of them in one texel,
 * averages them into the frame's log-mean luminance, and moves the held value toward it by a blend
 * the caller's frame time decides. The composite reads the held value and scales the scene toward
 * middle grey. Log luminance, because an eye's response is to ratios: one sunlit pixel beside a
 * dark frame should not set the exposure the way an arithmetic mean lets it.
 *
 * What it gives up is metering by region: every pixel counts the same, so a small bright window in
 * a dark room pulls less than a photographer's spot meter would. What would change it is a scene
 * that needs a subject held at a brightness, and the answer then is a centre weight in the meter.
 */

/** Texels a side in the meter's grid, and taps a side within each. */
export const METER_GRID = 32;
export const METER_TAPS = 8;
/** The luminance the meter clamps to, in stops: a black pixel is not minus infinity. */
export const METER_MIN_LOG2 = -12;
export const METER_MAX_LOG2 = 8;
/** What full adaptation brings the frame's log-mean luminance to: middle grey. */
export const ADAPTED_KEY = 0.18;
/** The furthest adaptation moves the exposure either way, in stops. A black loading screen is not a
 *  reason to multiply the next frame by a thousand. */
export const ADAPT_RANGE_STOPS = 6;
/**
 * How fast the held brightness follows the measured one, per second: 1.5 closes about 78% of the
 * way in a second. An eye takes longer to open than to close, and a camera's meter is faster than
 * either; one rate is what a scene that cuts between shots can predict.
 */
export const ADAPT_RATE = 1.5;

export const EXPOSURE_METER_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The finished scene, in scene light, before any exposure or curve. */
uniform highp sampler2D uScene;

out float fragColor;

void main() {
  /* This texel's corner, and taps spread evenly over its share of the frame. */
  vec2 corner = vUv - vec2(0.5 / ${METER_GRID.toFixed(1)});
  float sum = 0.0;
  for (int y = 0; y < ${METER_TAPS}; y++) {
    for (int x = 0; x < ${METER_TAPS}; x++) {
      vec2 uv = corner + (vec2(float(x), float(y)) + 0.5) / ${(METER_GRID * METER_TAPS).toFixed(1)};
      vec3 c = textureLod(uScene, uv, 0.0).rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      sum += clamp(log2(max(luma, 1e-8)), ${METER_MIN_LOG2.toFixed(1)}, ${METER_MAX_LOG2.toFixed(1)});
    }
  }
  fragColor = sum / ${(METER_TAPS * METER_TAPS).toFixed(1)};
}
`;

export const EXPOSURE_ADAPT_FRAG = `#version 300 es
precision highp float;

/** The meter's grid of log luminances. */
uniform highp sampler2D uMeter;
/** The brightness held from the frames before, in stops, one texel. */
uniform highp sampler2D uHeld;
/** How far toward this frame's measurement to move: 1 snaps, 0 holds. */
uniform float uBlend;

out float fragColor;

void main() {
  float sum = 0.0;
  for (int y = 0; y < ${METER_GRID}; y++) {
    for (int x = 0; x < ${METER_GRID}; x++) {
      sum += texelFetch(uMeter, ivec2(x, y), 0).r;
    }
  }
  float measured = sum / ${(METER_GRID * METER_GRID).toFixed(1)};
  float held = texelFetch(uHeld, ivec2(0, 0), 0).r;
  fragColor = mix(held, measured, uBlend);
}
`;

/**
 * `uAutoExposure`, `uExposureHeld` and `autoExposureGain`, for the composite. The gain scales scene
 * light before the tone curve, toward the key by the fraction the caller asked for.
 */
export const AUTO_EXPOSURE_GLSL = `
/** How far the frame adapts toward middle grey, 0 to 1. 0 is off and the whole of the off path. */
uniform float uAutoExposure;
/** The held log-mean luminance, in stops, one texel. */
uniform highp sampler2D uExposureHeld;

float autoExposureGain() {
  if (uAutoExposure <= 0.0) return 1.0;
  float held = texelFetch(uExposureHeld, ivec2(0, 0), 0).r;
  float stops = uAutoExposure * (${Math.log2(ADAPTED_KEY).toFixed(6)} - held);
  return exp2(clamp(stops, -${ADAPT_RANGE_STOPS.toFixed(1)}, ${ADAPT_RANGE_STOPS.toFixed(1)}));
}
`;

/**
 * The fraction of the way toward this frame's measurement to move, after `dtSec` seconds. A cut,
 * or a first frame with nothing held, snaps.
 */
export function adaptBlend(dtSec: number, snap: boolean): number {
  if (snap) return 1;
  if (!(dtSec > 0)) return 0;
  return 1 - Math.exp(-ADAPT_RATE * dtSec);
}

/** The scene's gain for a held log-mean `heldLog2` at `strength`, as the composite computes it. */
export function autoExposureGain(heldLog2: number, strength: number): number {
  if (!(strength > 0)) return 1;
  const stops = strength * (Math.log2(ADAPTED_KEY) - heldLog2);
  return 2 ** Math.min(Math.max(stops, -ADAPT_RANGE_STOPS), ADAPT_RANGE_STOPS);
}

/** An adaptation strength as the shader takes it: 0 to 1, anything else off. */
export function clampAutoExposure(strength: number): number {
  return Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1) : 0;
}
