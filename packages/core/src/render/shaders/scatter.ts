import { FOG_GLSL } from './fog.ts';

/**
 * Instanced scatter: grass, flowers, foliage — anything there are thousands of.
 *
 * Two programs, one material. The visible one lights and fogs the batch; the depth
 * one records it as an occluder for a shadow map. They share the instance transform
 * below, and that sharing is the point: a caster whose depth is computed from a
 * different pose than its picture is a shadow that has come loose from the thing
 * casting it.
 *
 * Lighting deliberately mirrors the flat material's terms (sun, ambient, fog),
 * because scatter has to sit in the same world as the geometry it stands on. A
 * separate lighting model is exactly how foliage ends up looking pasted onto a
 * scene rather than growing out of it.
 */

/**
 * Where an instance's vertex ends up: scaled, turned, bent by the wind, pressed by
 * whatever walked through it.
 *
 * Shared source rather than two copies, because the two programs have to agree
 * *exactly*. A canopy bends by tens of centimetres at its crown, and a crown is
 * metres across — so a depth pass that skipped the bend would slide a tree's whole
 * shade off the deck it belongs to, drifting as the gust changed. One expression,
 * two callers.
 */
const SCATTER_DEFORM = `
uniform vec2 uWindDirection;
uniform float uWindSpeed;
uniform float uWindGust;
uniform float uWindTime;
/* Spatial frequency of the travelling gust, per metre. */
uniform vec2 uWindSpatialPhase;
/*
 * Where something heavy has just been: xyz world position, w how pressed, 0 unused.
 *
 * Uniforms rather than a texture or a re-upload, because this is the hottest shader
 * in the game and the effect is a metre wide. Eight of them is about two seconds of
 * trail at running pace. See TrampleField.
 */
uniform vec4 uTrample[8];
/* How far a press reaches, metres, and how much of a plant it takes away. */
uniform float uTrampleRadius;
uniform float uTrampleDepth;

/* Yaw as (sin, cos). Computed once per vertex and shared by position and normal. */
vec2 scatterYaw(float yaw) {
  return vec2(sin(yaw), cos(yaw));
}

/* The instance's local offset from its root, after scale, yaw, wind and trampling. */
vec3 scatterOffset(
  vec3 position,
  vec3 instancePos,
  vec2 scaleYaw,
  vec3 windResponse,
  vec2 yawTrig
) {
  float s = yawTrig.x;
  float c = yawTrig.y;

  vec3 local = position * scaleYaw.x;
  vec3 rotated = vec3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c);

  /*
   * Wind phase comes from world position, so neighbouring plants are never in
   * lockstep and a gust visibly travels across a field instead of the whole
   * field pulsing at once. Direction and strength come from the shared wind —
   * this adds spatial variation, never a second wind.
   *
   * Amplitude rises with the square of height, so the base stays planted and
   * only the tip travels. A linear falloff slides the whole plant sideways,
   * which reads as the ground moving.
   */
  float phase = dot(instancePos.xz, uWindSpatialPhase) + uWindTime + windResponse.z;
  float rooted = clamp(rotated.y * windResponse.x, 0.0, 1.0);
  float bend = (uWindSpeed + uWindGust * windResponse.y) * sin(phase) * rooted * rooted;
  rotated.xz += uWindDirection * bend;

  /*
   * Trampling: pressed toward the ground and pushed away from whatever pressed it.
   *
   * The strongest press wins rather than the sum. Two overlapping presses adding up
   * would drive a blade through the deck, and a character crossing their own trail is
   * exactly when that would happen.
   *
   * Direction comes from the *press*, so a plant leans away from where the foot was
   * instead of all of them lying the same way, which is what makes it read as
   * something having gone through rather than as a second wind.
   */
  float pressed = 0.0;
  vec2 away = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 p = uTrample[i];
    if (p.w <= 0.0) continue;
    vec3 offset = instancePos - p.xyz;
    float dist = length(offset);
    if (dist >= uTrampleRadius) continue;
    float fade = 1.0 - dist / uTrampleRadius;
    float strength = p.w * fade * fade;
    if (strength <= pressed) continue;
    pressed = strength;
    // Degenerate at the exact centre, where any direction is as good as another.
    away = dist > 1e-4 ? offset.xz / dist : vec2(0.0);
  }
  if (pressed > 0.0) {
    float take = pressed * uTrampleDepth;
    // Height goes first — a flattened plant is shorter, and the fold outward is
    // what makes the loss of height read as bending rather than as sinking.
    rotated.y *= 1.0 - take;
    rotated.xz += away * take * rotated.y * 1.4;
  }

  return rotated;
}
`;

export const SCATTER_VERT = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
layout(location = 3) in vec3 aInstancePos;
layout(location = 4) in vec2 aScaleYaw;
layout(location = 5) in vec3 aTint;
layout(location = 6) in vec3 aWindResponse;

uniform mat4 uViewProj;
${SCATTER_DEFORM}
out vec3 vColor;
out vec3 vNormal;
out vec3 vWorldPos;

void main() {
  vec2 yawTrig = scatterYaw(aScaleYaw.y);
  vec3 rotated = scatterOffset(aPosition, aInstancePos, aScaleYaw, aWindResponse, yawTrig);
  vec3 world = aInstancePos + rotated;

  float s = yawTrig.x;
  float c = yawTrig.y;
  vColor = aColor * aTint;
  vNormal = vec3(aNormal.x * c + aNormal.z * s, aNormal.y, -aNormal.x * s + aNormal.z * c);
  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

/**
 * The same batch, recorded as a shadow caster.
 *
 * Pairs with `DEPTH_FRAG`, whose peel mode needs `vLightPosition` — so the two
 * scatter programs and the rigid depth program all speak the same depth protocol,
 * and a batch can be submitted to any layer a rigid mesh can.
 *
 * Only the four attributes the transform needs are declared. The instanced VAO
 * also carries normals, colours and tints; a depth pass has no use for them and a
 * program is not obliged to read every attribute a VAO offers.
 */
export const SCATTER_DEPTH_VERT = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 3) in vec3 aInstancePos;
layout(location = 4) in vec2 aScaleYaw;
layout(location = 6) in vec3 aWindResponse;

uniform mat4 uLightViewProj;
${SCATTER_DEFORM}
out vec4 vLightPosition;

void main() {
  vec3 rotated = scatterOffset(
    aPosition,
    aInstancePos,
    aScaleYaw,
    aWindResponse,
    scatterYaw(aScaleYaw.y)
  );
  vLightPosition = uLightViewProj * vec4(aInstancePos + rotated, 1.0);
  gl_Position = vLightPosition;
}
`;

export const SCATTER_FRAG = `#version 300 es
precision highp float;

in vec3 vColor;
in vec3 vNormal;
in vec3 vWorldPos;

uniform vec3 uDirectionalDir;
uniform vec3 uDirectionalColor;
uniform vec3 uAmbient;
uniform vec3 uCameraPos;
${FOG_GLSL}

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  /*
   * Two-sided. A blade of grass is a flat sliver seen from both faces, and
   * lighting its back face as though it faced away leaves half of every field
   * black — the cheapest and most obvious foliage tell there is.
   */
  float ndl = abs(dot(n, uDirectionalDir));
  vec3 lit = vColor * (uAmbient + uDirectionalColor * ndl);

  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);

  outColor = vec4(mix(lit, mediumColor(), fog), 1.0);
}
`;
