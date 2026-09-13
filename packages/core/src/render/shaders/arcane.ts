import { FOG_GLSL } from './fog.ts';

/**
 * An arcane aura: the volume a floating object sits inside.
 *
 * Pairs with `PLUME_VERT`, exactly as `FIRE_FRAG` does — the vertex stage only builds
 * a world-fixed cross of quads, and which effect that cross becomes is entirely a
 * fragment-stage decision. So this costs no new renderer and no new geometry path.
 *
 * Where a flame is carved *vertically* — a taper toward the tip, a threshold rising
 * with height, so it licks and breaks up — a spell is carved *radially*. Everything
 * below works in polar coordinates about the quad centre: a bright thin core, a wide
 * soft corona, and two noise bands turning in opposite directions.
 *
 * The counter-rotation is the whole effect. One band turning alone reads as a sheet
 * being spun, which is the same flatness `BLADES` describes for a billboarded fire;
 * two bands shearing against each other have no single rotation to read, so the eye
 * gets motion without direction. That is what separates a spell from a lamp on a
 * dimmer.
 */
export const ARCANE_FRAG = `#version 300 es
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
/** The caller's colour, so an aura shifts with the world's own palette. */
uniform vec3 uTint;

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

void main() {
  if (uClipEnabled != 0 && dot(vec4(vWorldPos, 1.0), uClipPlane) < 0.0) discard;

  // Polar about the quad centre. This is the line that makes it an orb rather
  // than a column; everything downstream reads radius and angle, never height.
  float radius = length(vUv - 0.5) * 2.0;
  if (radius >= 1.0) discard;

  vec2 d = vUv - 0.5;
  float angle = atan(d.y, d.x);
  float t = uTime + vSeed * 37.0;

  /*
   * Two bands, turning opposite ways at different rates. Sampled in (angle, radius)
   * space so the noise wraps around the disc instead of sliding across it — noise in
   * UV space would drift off one edge and read as a texture being scrolled.
   */
  float inner = valueNoise(vec2(angle * 1.9 + t * 0.55, radius * 4.2));
  float outer = valueNoise(vec2(angle * 3.1 - t * 0.34, radius * 2.6));
  float swirl = inner * 0.62 + outer * 0.38;
  if (uNoiseOctaves > 1) {
    swirl = mix(swirl, swirl * valueNoise(vec2(angle * 6.3 + t * 0.9, radius * 8.0)) * 2.0, 0.35);
  }

  /*
   * Core and corona as two separate falloffs rather than one curve. A single falloff
   * gives a blob; what makes this read as *contained energy* is a small bright centre
   * with a much wider, much fainter halo, so the object inside stays legible.
   */
  float core = 1.0 - smoothstep(0.0, 0.28, radius);
  float corona = (1.0 - smoothstep(0.18, 1.0, radius)) * (0.35 + swirl * 0.65);
  float body = core * 0.9 + corona;
  if (body <= 0.02) discard;

  // Hot centre through the tint to a dark rim, so the core reads as white-hot
  // energy and the edge as the colour it is made of.
  vec3 col = mix(uTint * 0.35, uTint, smoothstep(0.0, 0.55, body));
  col = mix(col, vec3(1.0), smoothstep(0.82, 1.4, body));
  col *= uTint;

  float alpha = clamp(body * 1.6, 0.0, 1.0);
  // Additive light must lose alpha as it scatters, or mixing its colour alone
  // still makes a distant aura glow through fog and through water.
  float fog = mediumFog(vDistance, vWorldPos.y);
  col = mix(col, mediumColor(), fog);
  alpha *= 1.0 - fog;

  outColor = vec4(col, alpha);
}
`;
