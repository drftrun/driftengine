/** The directional shadow lookup for the device, as the text both consumers include. */

import {
  SHADOW_DEPTH_BIAS,
  SHADOW_DEPTH_FADE,
  SHADOW_PCF_OFFSETS,
  SHADOW_SLOPE_TEXELS,
  SHADOW_TERMINATOR_BAND,
  SHADOW_TEXEL_SCALE,
} from '../../gpudriven/shadow.ts';
import { DIRECTIONAL_SHADOW_FADE_START, POINT_SHADOW_FADE_START } from '../../renderQuality.ts';

/**
 * **`gpudriven/shadow.ts` for the device, term for term, with `gpu-parity.mjs` running both.**
 *
 * The lesson is a week old and this is the first term written with it in hand: a shading term that
 * exists only as a shader is a term nothing can disagree with. The lit expression had no reference
 * until the highlight went in; this one had a reference before it had a shader.
 *
 * **The map is read through a function the *including* module defines**, `shadowDepthAt(u, v)`.
 * The parity entry point reads a storage buffer, because that is what `gpuCompute.mjs` can hand a
 * check; the shading pass reads a depth texture. What must not differ between them is the
 * arithmetic around the read, so the arithmetic is here and the read is not.
 *
 * Every constant is interpolated from the reference rather than restated. A texel scale that is
 * 1.35 here and 1.3 there is a shadow with a different softness on each path, and nothing on screen
 * says which one is the engine's.
 */
export const SHADE_SHADOW_WGSL = /* wgsl */ `
struct ShadowSettings {
  strength: f32,
  mapSize: f32,
  depthSpan: f32,
  maxDistance: f32,
  maxSlope: f32,
  taps: f32,
  padA: f32,
  padB: f32,
  lightDir: vec4<f32>,
}

const SHADOW_TAPS: array<vec2<f32>, ${SHADOW_PCF_OFFSETS.length}> = array<vec2<f32>, ${SHADOW_PCF_OFFSETS.length}>(
${SHADOW_PCF_OFFSETS.map(([x, y]) => `  vec2<f32>(${x.toFixed(3)}, ${y.toFixed(3)})`).join(',\n')}
);

/*
 * The receiver plane, from the two derivatives of the light-space position.
 *
 * Takes them rather than computing them: a fragment shader has dFdx and dFdy and a compute
 * invocation has neither, so the forward path would pass what the hardware gave it and the second
 * pipeline passes what it derives from the barycentric gradients it already has. Refused where the
 * two-by-two system is ill-conditioned — see gpudriven/shadow.ts, which carries the argument.
 */
fn receiverPlaneDepthGradient(dx: vec3<f32>, dy: vec3<f32>) -> vec2<f32> {
  let determinant = dx.x * dy.y - dx.y * dy.x;
  let conditioning = length(dx.xy) * length(dy.xy);
  if (abs(determinant) < 1e-4 * conditioning) {
    return vec2<f32>(0.0, 0.0);
  }
  return vec2<f32>(
    (dx.z * dy.y - dx.y * dy.z) / determinant,
    (dx.x * dy.z - dx.z * dy.x) / determinant,
  );
}

/*
 * The receiver plane from the barycentric gradients the shading pass already has.
 *
 * gpudriven/shadow.ts is the twin and carries the argument: a light-space position is a linear
 * combination of the three corners, so its derivative is the same combination of the weight
 * gradients. Exact because a directional light's projection is orthographic.
 *
 * The halving on x and y is the remap into the map's 0-to-1 coordinates. Depth is not halved,
 * because this pipeline's light matrix already emits z in 0..1.
 */
fn receiverPlaneFromWeights(
  l0: vec3<f32>,
  l1: vec3<f32>,
  l2: vec3<f32>,
  gx: vec3<f32>,
  gy: vec3<f32>,
) -> vec2<f32> {
  let dx = vec3<f32>(
    (gx.x * l0.x + gx.y * l1.x + gx.z * l2.x) * 0.5,
    (gx.x * l0.y + gx.y * l1.y + gx.z * l2.y) * 0.5,
    gx.x * l0.z + gx.y * l1.z + gx.z * l2.z,
  );
  let dy = vec3<f32>(
    (gy.x * l0.x + gy.y * l1.x + gy.z * l2.x) * 0.5,
    (gy.x * l0.y + gy.y * l1.y + gy.z * l2.y) * 0.5,
    gy.x * l0.z + gy.y * l1.z + gy.z * l2.z,
  );
  return receiverPlaneDepthGradient(dx, dy);
}

/* How much of a shadow survives having been cast this far along the ground. */
fn shadowReach(distance: f32, maxDistance: f32) -> f32 {
  return 1.0 - smoothstep(maxDistance * ${POINT_SHADOW_FADE_START.toFixed(2)}, maxDistance, distance);
}

fn directionalVisibility(
  receiverDepth: f32,
  compareDepth: f32,
  storedDepth: f32,
  settings: ShadowSettings,
) -> f32 {
  if (compareDepth <= storedDepth) {
    return 1.0;
  }
  let rayDistance = max(receiverDepth - storedDepth, 0.0) * settings.depthSpan;
  let ground = rayDistance * length(settings.lightDir.xz);
  return 1.0 - shadowReach(ground, settings.maxDistance);
}

/*
 * How much light reaches a receiver: 0 in full shadow, 1 in full light.
 *
 * Four early-outs, and the reference records that every one is a cost rather than a correctness
 * guard — the result is a mix by the product of all four fades, so a fade at zero returns one
 * whether or not the return fires. They stay because each skips twelve reads. The bounds check has
 * a second job: without it the taps read outside the map.
 */
fn shadowFactor(
  lightPos: vec4<f32>,
  depthGradient: vec2<f32>,
  ndl: f32,
  settings: ShadowSettings,
) -> f32 {
  if (settings.strength <= 0.0) {
    return 1.0;
  }
  if (lightPos.w == 0.0) {
    return 1.0;
  }
  /*
   * x and y are remapped and z is not: WebGPU clips z to 0..1 already, where the GLSL this is
   * transcribed from clips it to -1..1. See gpudriven/shadow.ts, which carries the argument.
   */
  let ndc = lightPos.xyz / lightPos.w;
  let p = vec3<f32>(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5, ndc.z);

  let receiverFade = smoothstep(${SHADOW_TERMINATOR_BAND[0].toFixed(2)}, ${SHADOW_TERMINATOR_BAND[1].toFixed(2)}, ndl);
  if (receiverFade <= 0.0) {
    return 1.0;
  }
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) {
    return 1.0;
  }

  let fromCentre = max(abs(p.x - 0.5) * 2.0, abs(p.y - 0.5) * 2.0);
  let edgeFade = (1.0 - smoothstep(0.72, 0.98, fromCentre)) * (1.0 - smoothstep(${SHADOW_DEPTH_FADE[0].toFixed(2)}, ${SHADOW_DEPTH_FADE[1].toFixed(2)}, p.z));
  if (edgeFade <= 0.0) {
    return 1.0;
  }

  let slope = length(settings.lightDir.xz) / max(settings.lightDir.y, 0.001);
  let lowElevationFade =
    1.0 - smoothstep(settings.maxSlope * ${DIRECTIONAL_SHADOW_FADE_START.toFixed(2)}, settings.maxSlope, slope);
  if (lowElevationFade <= 0.0) {
    return 1.0;
  }

  let texel = ${SHADOW_TEXEL_SCALE.toFixed(2)} / settings.mapSize;
  let slopeLimit = ${SHADOW_SLOPE_TEXELS.toFixed(1)} / settings.mapSize;
  let taps = u32(clamp(settings.taps, 1.0, ${SHADOW_PCF_OFFSETS.length}.0));

  var lit = 0.0;
  for (var tap = 0u; tap < taps; tap = tap + 1u) {
    let offset = SHADOW_TAPS[tap] * texel;
    let u = p.x + offset.x;
    let v = p.y + offset.y;
    /*
     * The fetched depth belongs to the centre of the containing texel, not to the continuous
     * coordinate — so the plane compensation is measured to that centre. Following the continuous
     * one leaves half a texel of uncompensated slope, which is the repeating ribs a grazing face
     * shows.
     */
    let centreU = (floor(u * settings.mapSize) + 0.5) / settings.mapSize;
    let centreV = (floor(v * settings.mapSize) + 0.5) / settings.mapSize;
    let raw = depthGradient.x * (centreU - p.x) + depthGradient.y * (centreV - p.y);
    let slopeOffset = clamp(raw, -slopeLimit, slopeLimit);
    let receiverDepth = p.z + slopeOffset;
    let compare = receiverDepth - ${SHADOW_DEPTH_BIAS.toFixed(2)} / settings.depthSpan;
    lit = lit + directionalVisibility(receiverDepth, compare, shadowDepthAt(u, v), settings);
  }
  lit = lit / f32(taps);

  let amount = settings.strength * edgeFade * lowElevationFade * receiverFade;
  return 1.0 + (lit - 1.0) * amount;
}
`;

/** Floats the parity entry point's settings block holds. Matches `ShadowSettings`. */
export const SHADOW_SETTINGS_FLOATS = 12;

/** Floats a receiver: the light-space clip position, the depth gradient and `n · l`. */
export const SHADOW_RECEIVER_FLOATS = 8;

/**
 * An entry point that does nothing but look a shadow up, so `gpu-parity.mjs` can compare the
 * function above with `gpudriven/shadow.ts` directly.
 *
 * It defines `shadowDepthAt` over a storage buffer, which is what a compute harness can be handed;
 * the shading pass will define it over a depth texture. Nearest, which is what the comparison
 * assumes — the arithmetic above measures its compensation to the texel centre.
 */
export const SHADOW_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> settingsBuffer: array<f32>;
@group(0) @binding(2) var<storage, read> receivers: array<f32>;
@group(0) @binding(3) var<storage, read> shadowMap: array<f32>;
@group(0) @binding(4) var<storage, read> gradients: array<f32>;
@group(0) @binding(5) var<storage, read_write> factors: array<f32>;

fn shadowDepthAt(u: f32, v: f32) -> f32 {
  let size = settingsBuffer[1];
  let x = clamp(floor(u * size), 0.0, size - 1.0);
  let y = clamp(floor(v * size), 0.0, size - 1.0);
  return shadowMap[u32(y) * u32(size) + u32(x)];
}

${SHADE_SHADOW_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(params[0])) {
    return;
  }
  var settings: ShadowSettings;
  settings.strength = settingsBuffer[0];
  settings.mapSize = settingsBuffer[1];
  settings.depthSpan = settingsBuffer[2];
  settings.maxDistance = settingsBuffer[3];
  settings.maxSlope = settingsBuffer[4];
  settings.taps = settingsBuffer[5];
  settings.lightDir = vec4<f32>(settingsBuffer[8], settingsBuffer[9], settingsBuffer[10], 0.0);

  let at = id.x * ${SHADOW_RECEIVER_FLOATS}u;
  /*
   * The gradient is solved here rather than passed, so the solve is checked too — the corpus feeds
   * the two derivative vectors and the reference runs the same two-by-two.
   */
  let gradient = receiverPlaneDepthGradient(
    vec3<f32>(gradients[id.x * 6u], gradients[id.x * 6u + 1u], gradients[id.x * 6u + 2u]),
    vec3<f32>(gradients[id.x * 6u + 3u], gradients[id.x * 6u + 4u], gradients[id.x * 6u + 5u]),
  );
  factors[id.x] = shadowFactor(
    vec4<f32>(receivers[at], receivers[at + 1u], receivers[at + 2u], receivers[at + 3u]),
    gradient,
    receivers[at + 6u],
    settings,
  );
}
`;

/** Floats a case of the receiver-plane check: three corners and the two weight gradients. */
export const RECEIVER_PLANE_FLOATS = 15;

/**
 * The gradient assembly alone, as a dispatch, because it is the one piece of the shadow the
 * shading pass computes for itself.
 *
 * The eleventh check hands the solve two derivative vectors. This is the step *before* that one:
 * turning three light-space corners and two barycentric gradients into those vectors, which is
 * where a factor of two or a transposed weight lives. Both are invisible in a picture — a gradient
 * off by two compensates a tap by half of what it should, which is acne on grazing surfaces and
 * looks like a bias that wants tuning.
 */
export const RECEIVER_PLANE_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cases: array<f32>;
@group(0) @binding(2) var<storage, read_write> planes: array<f32>;

fn receiverPlaneDepthGradient(dx: vec3<f32>, dy: vec3<f32>) -> vec2<f32> {
  let determinant = dx.x * dy.y - dx.y * dy.x;
  let conditioning = length(dx.xy) * length(dy.xy);
  if (abs(determinant) < 1e-4 * conditioning) {
    return vec2<f32>(0.0, 0.0);
  }
  return vec2<f32>(
    (dx.z * dy.y - dx.y * dy.z) / determinant,
    (dx.x * dy.z - dx.z * dy.x) / determinant,
  );
}

fn receiverPlaneFromWeights(
  l0: vec3<f32>,
  l1: vec3<f32>,
  l2: vec3<f32>,
  gx: vec3<f32>,
  gy: vec3<f32>,
) -> vec2<f32> {
  let dx = vec3<f32>(
    (gx.x * l0.x + gx.y * l1.x + gx.z * l2.x) * 0.5,
    (gx.x * l0.y + gx.y * l1.y + gx.z * l2.y) * 0.5,
    gx.x * l0.z + gx.y * l1.z + gx.z * l2.z,
  );
  let dy = vec3<f32>(
    (gy.x * l0.x + gy.y * l1.x + gy.z * l2.x) * 0.5,
    (gy.x * l0.y + gy.y * l1.y + gy.z * l2.y) * 0.5,
    gy.x * l0.z + gy.y * l1.z + gy.z * l2.z,
  );
  return receiverPlaneDepthGradient(dx, dy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(params[0])) {
    return;
  }
  let at = id.x * ${RECEIVER_PLANE_FLOATS}u;
  let plane = receiverPlaneFromWeights(
    vec3<f32>(cases[at], cases[at + 1u], cases[at + 2u]),
    vec3<f32>(cases[at + 3u], cases[at + 4u], cases[at + 5u]),
    vec3<f32>(cases[at + 6u], cases[at + 7u], cases[at + 8u]),
    vec3<f32>(cases[at + 9u], cases[at + 10u], cases[at + 11u]),
    vec3<f32>(cases[at + 12u], cases[at + 13u], cases[at + 14u]),
  );
  planes[id.x * 2u] = plane.x;
  planes[id.x * 2u + 1u] = plane.y;
}
`;
