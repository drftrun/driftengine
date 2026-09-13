/**
 * Visible wind: streaks of dust and debris carried past the camera.
 *
 * Wind you cannot see is a force from nowhere. Once it pushes the player even
 * slightly, it has to be legible — otherwise a drift in the air reads as the
 * controls being imprecise rather than as weather, which is the worst possible
 * reading because it blames the game's feel for something that is deliberate.
 *
 * Entirely GPU-side: particles live on a repeating lattice that follows the
 * camera, so there is no spawning, no pooling, no per-frame CPU work, and no
 * bookkeeping that could disagree with the wind everything else is using.
 */
export const WIND_STREAK_VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aIndex;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
/*
 * No uCameraRight. It was declared here and read nowhere, which GLSL answers by optimising the
 * location away — so the WebGL2 path never bound it and nothing was wrong. A uniform block is
 * laid out whole, though, so the generated WGSL carried sixteen bytes of it at offset 80 and
 * pushed everything after it along, leaving a field in the layout with no writer. That is the
 * shape AGENTS.md 2026-08-13 is about, arriving as dead weight rather than as a bug.
 */
uniform vec2 uWind;
uniform vec2 uDrift;
uniform float uSpeed;
uniform float uStrength;
uniform float uCount;
uniform float uCellSize;
uniform float uTime;

out float vFade;
out float vAlong;

void main() {
  float id = aIndex;
  float rx = fract(sin(id * 12.9898) * 43758.5453);
  float ry = fract(sin(id * 39.3467) * 24634.6345);
  float rz = fract(sin(id * 78.2330) * 12934.1234);

  /*
   * Scatter through a box that follows the camera, wrapped so a particle
   * leaving one side re-enters the other. That wrap is what makes a finite
   * count look like endless weather, and why nothing ever needs respawning.
   */
  /*
   * Biased low. You do not see air — you see what the wind has picked up, and
   * it picks things up from surfaces. Spreading debris evenly through a volume
   * puts streaks at head height in open sky, which is the single thing that
   * makes this read as an effect rather than as weather.
   */
  float lowBias = ry * ry;
  vec3 cell = vec3(rx * uCellSize, lowBias * uCellSize * 0.42, rz * uCellSize);
  vec3 base = vec3(
    uCameraPos.x + cell.x - uCellSize * 0.5 - uDrift.x,
    uCameraPos.y + cell.y - uCellSize * 0.3,
    uCameraPos.z + cell.z - uCellSize * 0.5 - uDrift.y
  );
  vec3 rel = base - uCameraPos;
  rel.x = mod(rel.x + uCellSize * 0.5, uCellSize) - uCellSize * 0.5;
  rel.z = mod(rel.z + uCellSize * 0.5, uCellSize) - uCellSize * 0.5;
  vec3 centre = uCameraPos + rel;

  // Streaks lie along the wind and lengthen with it: a smear is how speed
  // reads when the thing moving is too small to resolve.
  vec2 alongXZ = uSpeed > 0.001 ? uWind / uSpeed : vec2(1.0, 0.0);
  vec3 along = vec3(alongXZ.x, 0.0, alongXZ.y);
  vec3 across = normalize(cross(along, vec3(0.0, 1.0, 0.0)));

  /*
   * Turbulent, not ruled. A dead-straight line is the giveaway that something
   * was drawn rather than blown, so each streak curls on its own slow phase and
   * varies in length — a gust is made of eddies, and eddies are what the eye is
   * actually reading when it decides air is moving.
   */
  float curl = sin(uTime * 1.7 + id * 2.3) * 0.35 + sin(uTime * 0.9 + id) * 0.2;
  float length = (0.18 + uSpeed * 0.09) * (0.5 + rz);
  vec3 world = centre
    + along * (aCorner.y * length)
    + across * (aCorner.x * 0.012 + aCorner.y * curl * length * 0.35);

  // Fade with distance from the camera so the lattice edge is never a visible
  // boundary, and with strength so a calm day shows nothing at all.
  float dist = distance(centre, uCameraPos);
  /*
   * Three fades, all of which have to hold for a streak to be visible at all:
   * distance, so the lattice edge is never a boundary; a per-streak weight, so
   * they are not a uniform field; and a near fade, because debris a metre from
   * the eye is a smear across the screen rather than a cue.
   */
  /*
   * Fades spread across the whole volume rather than clipped into a band.
   *
   * Narrow near and far fades carve a spherical shell out of the lattice, and a
   * shell centred on the camera is seen as a curtain hanging in front of the
   * player — every particle at roughly the same distance, moving together. The
   * cure is depth: a long ramp at both ends, so density falls away gradually
   * and no distance is privileged.
   */
  float far = 1.0 - smoothstep(uCellSize * 0.12, uCellSize * 0.5, dist);
  float near = smoothstep(2.0, 16.0, dist);
  // Most particles are faint; a few carry the effect. A uniform field is a veil.
  float weight = rx * rx * rx;
  vFade = uStrength * far * near * weight;
  vAlong = aCorner.y * 0.5 + 0.5;

  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const WIND_STREAK_FRAG = `#version 300 es
precision highp float;

in float vFade;
in float vAlong;
uniform vec3 uTint;
out vec4 outColor;

void main() {
  // Tapered at both ends, so a streak reads as motion rather than as a stick.
  // Squared taper: a streak should be a smear that thins to nothing, not a
  // capsule with visible ends.
  float taper = sin(vAlong * 3.14159);
  float alpha = vFade * taper * taper * 0.13;
  if (alpha <= 0.002) discard;
  outColor = vec4(uTint, alpha);
}
`;
