import { FOG_GLSL } from './fog.ts';

/**
 * Smoke: a column that rises, expands and dissipates. Shares the plume
 * billboard vertex shader with fire — only the fragment behaviour differs.
 *
 * Alpha-blended rather than additive: smoke occludes what is behind it, and
 * adding it would make it glow instead of darken.
 */
export const SMOKE_FRAG = `#version 300 es
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

float billow(vec2 p, float t) {
  float v = valueNoise(p * 2.2 + vec2(0.0, -t * 0.55)) * 0.55;
  if (uNoiseOctaves == 1) return v / 0.55;
  v += valueNoise(p * 4.7 + vec2(t * 0.12, -t * 0.9)) * 0.29;
  if (uNoiseOctaves == 2) return v / 0.84;
  return v + valueNoise(p * 9.3 + vec2(-t * 0.09, -t * 1.4)) * 0.16;
}

void main() {
  if (uClipEnabled != 0 && dot(vec4(vWorldPos, 1.0), uClipPlane) < 0.0) discard;

  float t = uTime + vSeed * 53.0;
  float height = vUv.y;

  // Widens as it climbs: sample a compressed space low down, a stretched one up
  // top. Narrow at the bottom is what lets it sit inside the flame's tip.
  float spread = mix(0.5, 1.0, height);
  float centred = (vUv.x - 0.5) / spread + 0.5;

  // Soft horizontal falloff rather than a hard cut — a clipped edge here shows
  // the quad and is the single most obvious way smoke reads as fake.
  float sides = smoothstep(0.0, 0.55, 1.0 - clamp(abs(centred - 0.5) * 2.0, 0.0, 1.0));
  if (sides <= 0.001) discard;

  // Leans away over its height instead of rising ruler-straight.
  float drift = (valueNoise(vec2(t * 0.21, vSeed * 7.0)) - 0.5) * 0.6 * height * height;
  float n = billow(vec2(centred + drift, height), t);

  float density = n * sides * 1.35 - height * 0.88;
  if (density <= 0.02) discard;

  // Colour tells the story of the plume: ember-lit where it leaves the flame,
  // cooling through soot, then dispersing into the fog. Starting at flat grey
  // is what made it look like a separate object parked above the fire.
  vec3 col = mix(vec3(0.90, 0.42, 0.16), vec3(0.11, 0.10, 0.10), smoothstep(0.0, 0.34, height));
  vec3 atmosphereColor = mediumColor();
  col = mix(col, atmosphereColor, smoothstep(0.30, 0.95, height));

  // Fade in at the base so it emerges out of the flame, and out at the top so
  // it dissipates rather than ending.
  float emerge = smoothstep(0.0, 0.30, height);
  float dissipate = 1.0 - smoothstep(0.22, 0.75, height);

  float fog = mediumFog(vDistance, vWorldPos.y);
  col = mix(col, atmosphereColor, fog);
  float alpha = clamp(density * 0.95, 0.0, 1.0) * emerge * dissipate * 0.13;
  outColor = vec4(col, alpha * (1.0 - fog));
}
`;
