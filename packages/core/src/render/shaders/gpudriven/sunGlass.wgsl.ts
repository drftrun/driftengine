/**
 * The sun through glass for the device: `gpudriven/sunGlass.ts`'s `glassTintAt`, term for term, as
 * the text the shading pass and the parity entry point both include.
 *
 * **The reads are the including module's**, as `SHADE_SHADOW_WGSL`'s are: `glassDepthAt(u, v)` the
 * nearest pane's depth, `glassTintTexel(u, v)` the tint at the finest level, and
 * `glassTintAround(u, v, radius)` the tint averaged over a spread of that radius. The shading pass
 * answers the last from the tint's mip chain; the parity entry answers it with the reference's own
 * box average, so everything around the reads is checked as it stands. Every constant is the
 * reference's, interpolated rather than restated.
 */
import { FROST_RADIUS_CAP, FROST_SPREAD } from '../../glassShadow.ts';
import {
  SHADOW_DEPTH_BIAS,
  SHADOW_PCF_OFFSETS,
  SHADOW_TEXEL_SCALE,
} from '../../gpudriven/shadow.ts';
import { SHADE_SHADOW_WGSL } from './shadow.wgsl.ts';

export const SUN_GLASS_WGSL = /* wgsl */ `
struct SunGlassSettings {
  mapSize: f32,
  depthSpan: f32,
  uvPerMetre: f32,
  taps: f32,
}

/*
 * A coarse texel with the open ground's white taken back out, by how milky the pane at the
 * receiver is: the pane's colour and its share of the texel. glassShadow.ts's unmixTint.
 */
fn sunGlassUnmix(mip: vec4<f32>, centreClarity: f32) -> vec4<f32> {
  if (centreClarity >= 1.0) { return vec4<f32>(mip.xyz, 1.0); }
  let share = clamp((1.0 - mip.w) / (1.0 - centreClarity), 0.0, 1.0);
  if (share <= 0.0) { return vec4<f32>(1.0, 1.0, 1.0, 0.0); }
  let colour = clamp((mip.xyz - vec3<f32>(1.0 - share)) / share, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(colour, share);
}

/* What the sun keeps through glass at map position (u, v) and light depth "depth". */
fn sunGlass(u: f32, v: f32, depth: f32, settings: SunGlassSettings) -> vec3<f32> {
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) { return vec3<f32>(1.0); }
  let texel = ${SHADOW_TEXEL_SCALE.toFixed(4)} / settings.mapSize;
  let bias = ${SHADOW_DEPTH_BIAS.toFixed(4)} / settings.depthSpan;
  let taps = min(u32(settings.taps), ${SHADOW_PCF_OFFSETS.length}u);
  let clarity = glassTintTexel(u, v).w;
  let behind = max(depth - glassDepthAt(u, v), 0.0) * settings.depthSpan;
  let spread = (1.0 - clarity) * ${FROST_SPREAD.toFixed(6)} * behind * settings.uvPerMetre;
  let radius = min(max(texel, spread), texel * ${FROST_RADIUS_CAP.toFixed(1)});

  var cover = 0.0;
  var colour = vec3<f32>(0.0);
  var found = 0.0;
  for (var i = 0u; i < taps; i = i + 1u) {
    let offset = SHADOW_TAPS[i];
    /* The outline: a tap counts the pane only where the receiver is behind it, by the bias. */
    if (depth > glassDepthAt(u + offset.x * texel, v + offset.y * texel) + bias) {
      cover = cover + 1.0;
    }
    /* The colour: the spread's taps, each an average, unmixed and weighed by the pane's share. */
    let pane = sunGlassUnmix(glassTintAround(u + offset.x * radius, v + offset.y * radius, radius), clarity);
    colour = colour + pane.xyz * pane.w;
    found = found + pane.w;
  }
  let mixed = select(vec3<f32>(1.0), colour / max(found, 1e-6), found > 0.0);
  return mix(vec3<f32>(1.0), mixed, cover / f32(max(taps, 1u)));
}
`;

/**
 * `sunGlass` over maps held in storage buffers, read as the reference reads them, so the whole
 * lookup can be compared with `glassTintAt` rather than only the arithmetic between the reads.
 *
 * Four floats a case in — u, v, the receiver's depth, one spare — and four out, the tint and one
 * spare. The config is the map's size, the depth span, map units a metre, and the tap count.
 */
export const SUN_GLASS_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> depths: array<f32>;
@group(0) @binding(1) var<storage, read> tints: array<f32>;
@group(0) @binding(2) var<storage, read> cases: array<f32>;
@group(0) @binding(3) var<storage, read> config: array<f32>;
@group(0) @binding(4) var<storage, read_write> results: array<f32>;

/* The opaque lookup's own read, which this entry never calls: included only for its tap table. */
fn shadowDepthAt(u: f32, v: f32) -> f32 { return 1.0; }
${SHADE_SHADOW_WGSL}

fn glassIndex(u: f32, v: f32) -> u32 {
  let size = config[0];
  let x = u32(clamp(floor(u * size), 0.0, size - 1.0));
  let y = u32(clamp(floor(v * size), 0.0, size - 1.0));
  return y * u32(size) + x;
}

fn glassDepthAt(u: f32, v: f32) -> f32 {
  return depths[glassIndex(u, v)];
}

fn glassTintTexel(u: f32, v: f32) -> vec4<f32> {
  let at = glassIndex(u, v) * 4u;
  return vec4<f32>(tints[at], tints[at + 1u], tints[at + 2u], tints[at + 3u]);
}

/* The reference's coarse read: the average of every texel within the radius. */
fn glassTintAround(u: f32, v: f32, radius: f32) -> vec4<f32> {
  let size = config[0];
  let reach = radius * size;
  let x0 = u32(max(0.0, floor(u * size - reach)));
  let x1 = u32(min(size - 1.0, floor(u * size + reach)));
  let y0 = u32(max(0.0, floor(v * size - reach)));
  let y1 = u32(min(size - 1.0, floor(v * size + reach)));
  var sum = vec4<f32>(0.0);
  var n = 0.0;
  for (var y = y0; y <= y1; y = y + 1u) {
    for (var x = x0; x <= x1; x = x + 1u) {
      let at = (y * u32(size) + x) * 4u;
      sum = sum + vec4<f32>(tints[at], tints[at + 1u], tints[at + 2u], tints[at + 3u]);
      n = n + 1.0;
    }
  }
  return sum / max(n, 1.0);
}
${SUN_GLASS_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x * 4u + 3u >= arrayLength(&cases)) { return; }
  var settings: SunGlassSettings;
  settings.mapSize = config[0];
  settings.depthSpan = config[1];
  settings.uvPerMetre = config[2];
  settings.taps = config[3];
  let at = id.x * 4u;
  let tint = sunGlass(cases[at], cases[at + 1u], cases[at + 2u], settings);
  results[at] = tint.x;
  results[at + 1u] = tint.y;
  results[at + 2u] = tint.z;
}
`;
