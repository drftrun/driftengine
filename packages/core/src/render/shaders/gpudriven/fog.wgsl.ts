import { LINEAR_FOG } from '../../fog.ts';

/**
 * The medium between the camera and a GPU-driven surface, as WGSL.
 *
 * **`render/fog.ts` is the reference and this is checked against it**, over generated cases on a
 * device by `scripts/gpu-parity.mjs` — the pattern `gpudriven/lit.ts` and `gpudriven/alphaTest.ts`
 * are both written under, and for the reason this file exists at all: the forward path's fog is
 * GLSL, so the two pipelines cannot share text and can only be held to one another by measurement.
 *
 * **Two shaders include this, and neither restates it.** The shading pass fogs an opaque surface
 * and the blended raster fogs a pane, and a pane at the render edge that did not take the haze
 * would stand out of it. The previous wave found the weighted-transparency weight written twice
 * after its gate had been watching the copy, so this one starts shared.
 *
 * The including module declares the `fog` block — `frameBlock.wgsl.ts` does, so both readers get
 * one layout — and every guard and constant below is `render/fog.ts`'s, which is `shaders/fog.ts`'s.
 */
export const FOG_WGSL = /* wgsl */ `
/** What distance converges toward: the day's haze, or the water column. */
fn mediumColour() -> vec3<f32> {
  return mix(frame.fogColour.xyz, frame.fogUnderwater.xyz, frame.fogUnderwater.w);
}

/**
 * The haze's optical depth from where it begins along the ray to a point at "pointY", "dist" metres
 * away: each layer's density at the eye carried over what is left of the ray, the second only
 * where there is one. mediumFog and mediumGlow both integrate it.
 */
fn hazeDepth(dist: f32, pointY: f32) -> f32 {
  /* Where the medium begins along the ray: fogRange.x, the linear mode's near, which this mode
     never read before Atmosphere.fogStart. Integrated from there on, at that point's density; at
     a start of 0 every term is the one it always was. See render/fog.ts. */
  let start = min(frame.fogRange.x, dist);
  var before = 0.0;
  if (dist > 0.0) { before = start / dist; }
  let t = (pointY - frame.fogColour.w) * frame.fogHeight.x;
  let rest = t * (1.0 - before);
  /* (1 - e^-t)/t, which tends to 1 as the ray levels out. Guarded rather than branched: at t = 0
     the quotient is 0/0, and 1e-4 of a scale height is 8 mm. */
  var denom = rest;
  if (abs(rest) < 1e-4) { denom = 1e-4; }
  var depth = frame.fogHeight.y * exp(-t * before) * (dist - start) * (1.0 - exp(-denom)) / denom;
  if (frame.fogHeight.z > 0.0) {
    let t2 = (pointY - frame.fogColour.w) * frame.fogHeight.w;
    let rest2 = t2 * (1.0 - before);
    var denom2 = rest2;
    if (abs(rest2) < 1e-4) { denom2 = 1e-4; }
    depth += frame.fogHeight.z * exp(-t2 * before) * (dist - start) * (1.0 - exp(-denom2)) / denom2;
  }
  return depth;
}

/**
 * How much of a surface at "pointY", "dist" metres away, is lost to the medium between.
 * 0 is perfectly clear, 1 is the medium's own colour.
 */
fn mediumFog(dist: f32, pointY: f32) -> f32 {
  let underwaterFactor = frame.fogUnderwater.w;
  /* Past the cutoff the air hides nothing, in either mode; the water column keeps its own law. */
  let cut = frame.fogLimits.y > 0.0 && dist > frame.fogLimits.y;
  if (frame.fogRange.z == ${LINEAR_FOG}.0) {
    /*
     * A consumer asking for a hard cut writes far == near, and the guard is why that is a cut and
     * not a NaN at the one distance where the quotient is zero over zero.
     *
     * **This copy of it is not observable on the machine this was written on**, and the perturbation
     * says so: removing it changes nothing the parity check can see, because WGSL does not require
     * NaN to be supported and this device answers 0 for 0.0/0.0 rather than NaN. The guard stays
     * because render/fog.ts needs it — its own test fails without it — and because a device that
     * does propagate NaN would paint the fog colour along the cut. The alpha test found the same
     * shape from the other direction on 2026-09-18: a device may assume NaN never arrives.
     */
    let span = max(frame.fogRange.y - frame.fogRange.x, 1e-4);
    var ramp = min(clamp((dist - frame.fogRange.x) / span, 0.0, 1.0), 1.0 - frame.fogLimits.x);
    if (cut) { ramp = 0.0; }
    if (underwaterFactor <= 0.0) { return ramp; }
    let wetLinear = frame.fogRange.w * dist;
    return mix(ramp, 1.0 - exp2(-wetLinear * wetLinear * 1.442695), underwaterFactor);
  }

  /* Beer-Lambert through both layers, leaving at least fogLimits.x of the surface. */
  var air = 1.0 - max(exp(-hazeDepth(dist, pointY)), frame.fogLimits.x);
  if (cut) { air = 0.0; }
  if (underwaterFactor <= 0.0) { return air; }
  /* Water is its own medium and keeps its own curve, so crossing the surface changes nothing
     about how the water column reads. */
  let wet = frame.fogRange.w * dist;
  return mix(air, 1.0 - exp2(-wet * wet * 1.442695), underwaterFactor);
}

/**
 * The sun's light the haze scatters toward the eye along a ray to a point at "pointY", "dist"
 * metres away in the unit direction "toPoint": added after the fog, never mixed. None in a linear
 * ramp, past the cutoff or under water; render/fog.ts says the rest.
 */
fn mediumGlow(dist: f32, pointY: f32, toPoint: vec3<f32>) -> vec3<f32> {
  if (frame.fogRange.z == ${LINEAR_FOG}.0) { return vec3<f32>(0.0); }
  if (max(max(frame.fogGlow.x, frame.fogGlow.y), frame.fogGlow.z) <= 0.0) { return vec3<f32>(0.0); }
  if (frame.fogLimits.y > 0.0 && dist > frame.fogLimits.y) { return vec3<f32>(0.0); }
  let span = dist - min(frame.fogRange.x, dist);
  if (span <= 0.0) { return vec3<f32>(0.0); }
  let perMetre = hazeDepth(dist, pointY) / span;
  let hidden = 1.0 - exp(-perMetre * max(span - frame.fogGlowDir.w, 0.0));
  let lobe = pow(clamp(dot(toPoint, frame.fogGlowDir.xyz), 0.0, 1.0), frame.fogGlow.w);
  return frame.fogGlow.xyz * (lobe * hidden * (1.0 - frame.fogUnderwater.w));
}
`;

/**
 * Floats a case of the fog check: distance, height, the ten options, the second layer, the floor
 * and the cutoff, the glow's colour, exponent, direction and start, the ray's direction, and one
 * spare.
 */
export const FOG_CASE_FLOATS = 32;

/** Floats a case's answer: the fog, the colour, and the glow, and one spare. */
export const FOG_RESULT_FLOATS = 8;

/**
 * An entry point that does nothing but fog, so `gpu-parity.mjs` can compare the expression above
 * with `render/fog.ts` directly rather than through a shading pass that writes to a texture.
 *
 * **It declares its own `frame` and fills it from the case**, rather than restating the arithmetic:
 * the whole point is that the function under test is the one the frame draws with, and a second
 * copy here is a gate watching a copy of what it guards.
 */
export const FOG_PARITY_WGSL = /* wgsl */ `
struct Frame {
  /** rgb is the haze's colour, w is the eye's height. */
  fogColour: vec4<f32>,
  /** rgb is the water's colour, w is how far under it the camera is. */
  fogUnderwater: vec4<f32>,
  /** Reciprocal scale height, extinction per metre at the eye, and two spare. */
  fogHeight: vec4<f32>,
  /** Linear near and far, the mode, and the water's own density. */
  fogRange: vec4<f32>,
  /** The least of a surface the haze must leave, the cutoff, and two spare. */
  fogLimits: vec4<f32>,
  /** The sun glow's colour and exponent. */
  fogGlow: vec4<f32>,
  /** Surface → its light, and its start. */
  fogGlowDir: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> cases: array<f32>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;

var<private> frame: Frame;
${FOG_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let at = id.x * ${FOG_CASE_FLOATS}u;
  if (at + ${FOG_CASE_FLOATS - 1}u >= arrayLength(&cases)) { return; }
  let dist = cases[at];
  let pointY = cases[at + 1u];
  frame.fogColour = vec4<f32>(cases[at + 2u], cases[at + 3u], cases[at + 4u], cases[at + 5u]);
  frame.fogUnderwater = vec4<f32>(cases[at + 6u], cases[at + 7u], cases[at + 8u], cases[at + 9u]);
  frame.fogHeight = vec4<f32>(cases[at + 10u], cases[at + 11u], cases[at + 16u], cases[at + 17u]);
  frame.fogRange = vec4<f32>(cases[at + 12u], cases[at + 13u], cases[at + 14u], cases[at + 15u]);
  frame.fogLimits = vec4<f32>(cases[at + 18u], cases[at + 19u], 0.0, 0.0);
  frame.fogGlow = vec4<f32>(cases[at + 20u], cases[at + 21u], cases[at + 22u], cases[at + 23u]);
  frame.fogGlowDir = vec4<f32>(cases[at + 24u], cases[at + 25u], cases[at + 26u], cases[at + 27u]);
  let toPoint = vec3<f32>(cases[at + 28u], cases[at + 29u], cases[at + 30u]);

  let out = id.x * ${FOG_RESULT_FLOATS}u;
  results[out] = mediumFog(dist, pointY);
  let colour = mediumColour();
  results[out + 1u] = colour.x;
  results[out + 2u] = colour.y;
  results[out + 3u] = colour.z;
  let glow = mediumGlow(dist, pointY, toPoint);
  results[out + 4u] = glow.x;
  results[out + 5u] = glow.y;
  results[out + 6u] = glow.z;
}
`;
