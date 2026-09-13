import { FOG_GLSL } from './fog.ts';

/**
 * Procedural flames: camera-facing quads whose shape and colour come entirely
 * from animated noise. No sprite sheets, no image assets — and no static
 * geometry pretending to be fire either (AGENTS.md, fidelity).
 *
 * The flame silhouette is carved by thresholding rising turbulence against a
 * tapered mask, so it licks and breaks up at the tip the way a real flame does
 * rather than pulsing as a whole.
 */
/** Shared billboard vertex stage: used by fire, smoke and any future plume. */
export const PLUME_VERT = `#version 300 es
layout(location = 0) in vec3 aCenter;
layout(location = 1) in vec2 aCorner;
layout(location = 2) in vec2 aSize;
layout(location = 3) in float aSeed;
layout(location = 4) in float aBlade;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
uniform float uTime;
/** Amplitude of the size pulse; 0 keeps the quad a fixed size. */
uniform float uSizePulse;
/**
 * Horizontal wind, m/s. Plumes lean with it, increasingly toward their top —
 * the base is anchored to whatever is burning, the crown is free. Sharing one
 * wind with the rest of the world is the point: smoke drifting one way while
 * foliage leans another is the clearest tell that a scene is a pile of effects
 * rather than a place.
 */
uniform vec2 uWind;
/**
 * Whole-batch offset. Plume centres live in a static buffer because braziers
 * never move; a batch that *does* move — a tornado — shifts by a uniform rather
 * than rewriting geometry every frame.
 */
uniform vec3 uOrigin;
/** How strongly this plume type answers the wind; smoke far more than flame. */
uniform float uWindResponse;

out vec2 vUv;
out float vSeed;
out float vDistance;
out vec3 vWorldPos;

/**
 * Plumes are not a constant size: a fire flares and dies back, a smoke column
 * swells and thins. Two out-of-phase sines, offset per plume, so the whole
 * effect breathes rather than only its interior pattern animating.
 */
float sizePulse(float seed) {
  return 1.0 + uSizePulse * (
    sin(uTime * 1.7 + seed * 9.1) * 0.62 +
    sin(uTime * 3.3 + seed * 4.7) * 0.38
  );
}

void main() {
  // Height swells more than width, the way a real flame stretches upward.
  vec3 anchor = aCenter + uOrigin;

  /*
   * No billboarding at all: the blade's heading is fixed in the world.
   *
   * Each plume is drawn as a CROSS of two blades 90 degrees apart (see BLADES in
   * plumeRenderer), and aSeed advances by the golden ratio per plume, so the crosses
   * themselves are scattered by the golden angle rather than aligned into a grid.
   *
   * Nothing here reads the camera, and that is the fix. Anything that does - a full
   * billboard, or merely leaning edge-on cards toward the viewer - rotates geometry
   * as the camera moves, which is exactly what reads as flat: orbiting a fire showed
   * the same silhouette from every angle. A cross cannot track the viewer, so turning
   * around a fire genuinely brings one blade broadside while the other goes edge-on.
   * That is the parallax a volume has, and it is also why no blade needs to be turned
   * to stay visible - its partner is square-on whenever it is not.
   *
   * World up stays the vertical axis: a flame that tilts with the camera reads as a
   * decal.
   */
  vec3 up = vec3(0.0, 1.0, 0.0);
  float yaw = aSeed * 6.28318530718 + aBlade * 1.57079632679;
  vec3 right = vec3(cos(yaw), 0.0, sin(yaw));
  float pulse = sizePulse(aSeed);
  vec2 size = vec2(aSize.x * mix(1.0, pulse, 0.55), aSize.y * pulse);

  float rise = aCorner.y * 0.5 + 0.5;
  vec3 world = anchor
    + right * (aCorner.x * size.x)
    + up * (rise * size.y);

  // Quadratic in height: a column bends away from its anchor rather than
  // shearing uniformly, which would slide its base off the fire.
  world.xz += uWind * (uWindResponse * rise * rise * size.y);

  vUv = vec2(aCorner.x * 0.5 + 0.5, aCorner.y * 0.5 + 0.5);
  vSeed = aSeed;
  vDistance = distance(world, uCameraPos);
  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const FIRE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in float vSeed;
in float vDistance;
in vec3 vWorldPos;

uniform float uTime;
${FOG_GLSL}
uniform int uNoiseOctaves;
uniform vec4 uClipPlane;
uniform int uClipEnabled;

out vec4 outColor;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/** Rising turbulence: octaves scrolled upward at different rates. */
float turbulence(vec2 p, float t) {
  float v = valueNoise(p * 3.0 + vec2(0.0, -t * 1.9)) * 0.55;
  if (uNoiseOctaves == 1) return v / 0.55;
  v += valueNoise(p * 6.5 + vec2(t * 0.3, -t * 3.1)) * 0.28;
  if (uNoiseOctaves == 2) return v / 0.83;
  return v + valueNoise(p * 13.0 + vec2(-t * 0.2, -t * 4.6)) * 0.17;
}

void main() {
  if (uClipEnabled != 0 && dot(vec4(vWorldPos, 1.0), uClipPlane) < 0.0) discard;

  vec2 uv = vUv;
  float t = uTime + vSeed * 37.0;

  // Taper toward the tip and pinch the sides, so the quad never shows.
  float sides = 1.0 - abs(uv.x - 0.5) * 2.0;
  float taper = sides * (1.0 - uv.y * 0.72);
  if (taper <= 0.0) discard;

  // Sway: the column leans and wanders instead of standing to attention.
  float sway = (valueNoise(vec2(t * 0.55, vSeed * 11.0)) - 0.5) * 0.34 * uv.y;
  vec2 p = vec2(uv.x + sway, uv.y);

  float n = turbulence(p, t);
  // Flame body: noise must beat a threshold that rises with height, which is
  // what makes the tip break into separate licks.
  float body = n * taper * 1.9 - uv.y * 0.55;
  if (body <= 0.02) discard;

  // Colour ramp: white-hot core through yellow and orange to a dark red edge.
  float heat = clamp(body * 1.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.62, 0.06, 0.02), vec3(1.0, 0.45, 0.06), smoothstep(0.0, 0.45, heat));
  col = mix(col, vec3(1.0, 0.85, 0.35), smoothstep(0.45, 0.75, heat));
  col = mix(col, vec3(1.0, 0.98, 0.88), smoothstep(0.78, 1.0, heat));

  float alpha = clamp(body * 2.2, 0.0, 1.0) * (1.0 - smoothstep(0.72, 1.0, uv.y));
  // Additive light must lose alpha as it scatters, or mixing its colour alone
  // still makes a distant flame glow through fog and through water.
  float fog = mediumFog(vDistance, vWorldPos.y);
  col = mix(col, mediumColor(), fog);
  alpha *= 1.0 - fog;

  outColor = vec4(col, alpha);
}
`;
