/** A DriftTexture decode program, interpreted on the device. */

/**
 * **`@driftengine/texture`'s `decodeCpu`, as WGSL — the half that package's README has listed as
 * missing since Wave 2B.** The reference is the specification and this is checked against it by
 * `scripts/gpu-parity.mjs`, over generated programs and a real texture array.
 *
 * **Core does not import that package**, so its vocabulary is written again here and
 * `decode.wgsl.test.ts` asserts the two are equal.
 *
 * **The tables are uniforms because the shading pass is at eight storage buffers**, which is
 * WebGPU's default per stage. A uniform binding is at most 65,536 bytes, so the tables have fixed
 * capacities, and `decodeTables.ts` refuses a set that does not fit rather than truncating it.
 *
 * **Its networks are evaluated by `../network.wgsl.ts`**, the one evaluator the device has, which
 * reads their weights through `decodeNetWeight` here. Until 2026-09-17 this module carried its own
 * copy of the loop.
 */

import { networkWgsl } from '../network.wgsl.ts';

export const DECODE_REGISTERS = 16;

export const DECODE_OPS = {
  SAMPLE_LATENT: 0,
  EVAL_NETWORK: 1,
  SAMPLE_BLOCK: 2,
  PROCEDURAL_FBM: 3,
  FLIPBOOK_INDEX: 4,
  LATENT_LERP: 5,
  REMAP_CHANNEL: 6,
  COMPOSITE: 7,
  CONSTANT: 8,
} as const;

/** Lattice clamp, lattice wrap, centre clamp, centre wrap. `ADDRESS_MODE` in the reference. */
export const DECODE_ADDRESS_MODES = 4;

/** The order `REMAP_CHANNEL` packs a semantic in, which is `REMAP_SEMANTICS`'. */
export const DECODE_SEMANTICS = [
  'albedo-srgb',
  'albedo-linear',
  'normal-tangent-yup',
  'normal-tangent-ydown',
  'roughness-linear',
  'gloss-linear',
  'metallic-linear',
  'occlusion-linear',
  'height-linear',
  'emissive-srgb',
  'mask-linear',
] as const;

/**
 * **Four in and four out are not a choice**: `EVAL_NETWORK` reads one four-lane register and
 * writes one. The hidden limit holds a small refinement network, which the bake does not make yet.
 */
export const DECODE_NETWORK_INPUTS = 4;
export const DECODE_NETWORK_OUTPUTS = 4;
export const DECODE_NETWORK_HIDDEN_LAYERS = 2;
export const DECODE_NETWORK_WIDTH = 16;
/** `PROCEDURAL_FBM`'s octave count is a loop bound on the device, so it has one. */
export const DECODE_FBM_OCTAVES = 16;

/** Sixty-four material slots, three programs each. */
export const DECODE_PROGRAM_CAPACITY = 192;
export const DECODE_NETWORK_CAPACITY = 256;
export const DECODE_NODE_CAPACITY = 3200;
/** Blocks of four floats, so fifteen thousand three hundred and sixty weights. */
export const DECODE_WEIGHT_BLOCKS = 3840;
export const DECODE_CONSTANT_CAPACITY = 256;

export const DECODE_NODES_BYTES =
  (DECODE_PROGRAM_CAPACITY + DECODE_NETWORK_CAPACITY * 2 + DECODE_NODE_CAPACITY) * 16;
export const DECODE_WEIGHTS_BYTES = (DECODE_WEIGHT_BLOCKS + DECODE_CONSTANT_CAPACITY) * 16;

/** What a material's program lane holds when it has no program there. */
export const DECODE_NO_PROGRAM = 0xffffffff;

export interface DecodeBindings {
  readonly group: number;
  readonly nodes: number;
  readonly weights: number;
  readonly latents: number;
  readonly clampSampler: number;
  readonly repeatSampler: number;
}

/**
 * The declarations, at the bindings the including module chooses.
 *
 * The including module also defines `fn decodeLatentSize() -> f32`, the edge of level 0 in texels,
 * because where that number lives is the including module's business.
 */
export function decodeResourcesWgsl(b: DecodeBindings): string {
  return /* wgsl */ `
struct DecodeNodes {
  programs: array<vec4<u32>, ${DECODE_PROGRAM_CAPACITY}>,
  networks: array<vec4<u32>, ${DECODE_NETWORK_CAPACITY * 2}>,
  nodes: array<vec4<u32>, ${DECODE_NODE_CAPACITY}>,
}

struct DecodeWeights {
  values: array<vec4<f32>, ${DECODE_WEIGHT_BLOCKS}>,
  constants: array<vec4<f32>, ${DECODE_CONSTANT_CAPACITY}>,
}

@group(${b.group}) @binding(${b.nodes}) var<uniform> decodeNodes: DecodeNodes;
@group(${b.group}) @binding(${b.weights}) var<uniform> decodeWeights: DecodeWeights;
@group(${b.group}) @binding(${b.latents}) var decodeLatents: texture_2d_array<f32>;
@group(${b.group}) @binding(${b.clampSampler}) var decodeClampSampler: sampler;
@group(${b.group}) @binding(${b.repeatSampler}) var decodeRepeatSampler: sampler;
`;
}

/**
 * The interpreter. Every function is the reference's, operation for operation; where a line looks
 * odd, `decodeCpu.ts` is why.
 *
 * - **Registers are a fresh function-scope array**, zeros, one per call. The reference reuses the
 *   caller's registers, so its parity check hands it fresh ones per case.
 * - **`PROCEDURAL_FBM`'s hash is `u32` arithmetic with wrapping multiplies**, which is exactly what
 *   `Math.imul` computes; only its final division is float, so that operation is compared at a
 *   stated tolerance.
 * - **Component-wise aliasing is safe**: the reference reads component `c` of a source before it
 *   writes component `c` of a destination, so reading whole vectors first gives the same answer
 *   when a node writes the register it reads.
 * - **Every index into a table is clamped**, because a uniform array read past its end is clamped
 *   by the language anyway and saying so is cheaper than finding out.
 */
export const DECODE_WGSL = /* wgsl */ `
fn decodeWeight(index: u32) -> f32 {
  let block = min(index / 4u, ${DECODE_WEIGHT_BLOCKS - 1}u);
  return decodeWeights.values[block][index % 4u];
}

/* The exact sRGB curve, as semantics.ts has it, not the 2.2 power. */
fn decodeSrgbToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

fn decodeHash(x: i32, y: i32, seed: u32) -> f32 {
  var h = (bitcast<u32>(x) * 0x27d4eb2du) ^ (bitcast<u32>(y) * 0x165667b1u) ^ (seed * 0x9e3779b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return f32(h ^ (h >> 15u)) / 4294967295.0;
}

fn decodeValueNoise(u: f32, v: f32, seed: u32) -> f32 {
  let x0 = floor(u);
  let y0 = floor(v);
  let fx = u - x0;
  let fy = v - y0;
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  let ix = i32(x0);
  let iy = i32(y0);
  let a = decodeHash(ix, iy, seed);
  let b = decodeHash(ix + 1, iy, seed);
  let c = decodeHash(ix, iy + 1, seed);
  let d = decodeHash(ix + 1, iy + 1, seed);
  return (a * (1.0 - sx) + b * sx) * (1.0 - sy) + (c * (1.0 - sx) + d * sx) * sy;
}

fn decodeFbm(uv: vec2<f32>, seed: u32, octaves: u32) -> f32 {
  var total = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  let count = clamp(octaves, 1u, ${DECODE_FBM_OCTAVES}u);
  for (var o = 0u; o < count; o = o + 1u) {
    total = total + decodeValueNoise(uv.x * frequency * 8.0, uv.y * frequency * 8.0, seed) * amplitude;
    amplitude = amplitude * 0.5;
    frequency = frequency * 2.0;
  }
  return total;
}

/*
 * timeNodes.ts flipbookFrame with loop true: a modulo that stays non-negative, in integers.
 *
 * Not raw - count * floor(raw / count). On the device that wrote this check, a float 144 / 12 came
 * back 11.999999 and floored to 11, so every frame index that was an exact multiple of the frame
 * count read as the count itself. Integer remainder is what the reference computes, and it has
 * no rounding to disagree about.
 */
fn decodeFlipbook(t: f32, frames: u32, fps: u32) -> f32 {
  if (frames == 0u) {
    return 0.0;
  }
  let raw = i32(floor(t * f32(fps)));
  let count = i32(min(frames, 2147483647u));
  return f32(((raw % count) + count) % count);
}

fn decodeRemap(value: vec4<f32>, packed: u32) -> vec4<f32> {
  var dst = value;
  let semantic = packed >> 4u;
  let component = packed & 15u;
  if (component >= 4u) {
    return dst;
  }
  let raw = value[component];
  var mapped = raw;
  /* albedo-srgb and emissive-srgb decode; normal-tangent-ydown and gloss-linear flip. */
  if (semantic == 0u || semantic == 9u) {
    mapped = decodeSrgbToLinear(raw);
  } else if (semantic == 3u || semantic == 5u) {
    mapped = 1.0 - raw;
  }
  dst[component] = mapped;
  return dst;
}

/* The networks are the engine's one evaluator, reading its weights out of the uniform table. */
fn decodeNetWeight(index: u32) -> f32 {
  return decodeWeight(index);
}
${networkWgsl({
  name: 'decodeNet',
  scalar: 'f32',
  width: DECODE_NETWORK_WIDTH,
  hidden: DECODE_NETWORK_HIDDEN_LAYERS,
})}
fn decodeNetwork(network: u32, input: vec4<f32>) -> vec4<f32> {
  let slot = min(network, ${DECODE_NETWORK_CAPACITY - 1}u) * 2u;
  let header = decodeNodes.networks[slot];
  let widths = decodeNodes.networks[slot + 1u];
  var values: array<f32, ${DECODE_NETWORK_WIDTH}>;
  for (var i = 0u; i < 4u; i = i + 1u) {
    values[i] = input[i];
  }
  let result = decodeNetEval(
    header.x,
    min(header.y, ${DECODE_NETWORK_INPUTS}u),
    header.w,
    array<u32, ${DECODE_NETWORK_HIDDEN_LAYERS}>(widths.x, widths.y),
    min(header.z, ${DECODE_NETWORK_OUTPUTS}u),
    values,
  );
  return vec4<f32>(result[0], result[1], result[2], result[3]);
}

/* One whole level of a lattice-addressed latent: bilinear by hand, exactly as decodeCpu does it. */
fn decodeLatticeLevel(layer: u32, uv: vec2<f32>, level: i32, mode: u32) -> vec4<f32> {
  let size = max(i32(decodeLatentSize()) >> u32(level), 1);
  let edge = f32(size);
  var a = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  if (mode == 1u) {
    a = uv - floor(uv);
  }
  let s = a * (edge - 1.0);
  let base = floor(s);
  let f = s - base;
  let x0 = clamp(i32(base.x), 0, size - 1);
  let x1 = clamp(i32(base.x) + 1, 0, size - 1);
  let y0 = clamp(i32(base.y), 0, size - 1);
  let y1 = clamp(i32(base.y) + 1, 0, size - 1);
  let index = i32(layer);
  let t00 = textureLoad(decodeLatents, vec2<i32>(x0, y0), index, level);
  let t10 = textureLoad(decodeLatents, vec2<i32>(x1, y0), index, level);
  let t01 = textureLoad(decodeLatents, vec2<i32>(x0, y1), index, level);
  let t11 = textureLoad(decodeLatents, vec2<i32>(x1, y1), index, level);
  let top = t00 * (1.0 - f.x) + t10 * f.x;
  let bottom = t01 * (1.0 - f.x) + t11 * f.x;
  return top * (1.0 - f.y) + bottom * f.y;
}

fn decodeLatentSample(layer: u32, uv: vec2<f32>, lod: f32, mode: u32) -> vec4<f32> {
  let top = f32(textureNumLevels(decodeLatents)) - 1.0;
  /* Negative and not-a-number read level 0, as the reference's lod > 0 test does. */
  let level = min(select(0.0, lod, lod > 0.0), top);
  if (mode == 3u) {
    return textureSampleLevel(decodeLatents, decodeRepeatSampler, uv, layer, level);
  }
  if (mode == 2u) {
    return textureSampleLevel(decodeLatents, decodeClampSampler, uv, layer, level);
  }
  let lower = floor(level);
  let upper = min(lower + 1.0, top);
  let blend = level - lower;
  let near = decodeLatticeLevel(layer, uv, i32(lower), mode);
  let far = decodeLatticeLevel(layer, uv, i32(upper), mode);
  return near * (1.0 - blend) + far * blend;
}

fn decodeProgram(program: u32, uv: vec2<f32>, lod: f32, t: f32) -> vec4<f32> {
  var r: array<vec4<f32>, ${DECODE_REGISTERS}>;
  if (program >= ${DECODE_PROGRAM_CAPACITY}u) {
    return r[0];
  }
  let header = decodeNodes.programs[program];
  let first = header.x;
  let count = min(header.y, ${DECODE_NODE_CAPACITY}u);
  let mode = header.w;
  for (var i = 0u; i < count; i = i + 1u) {
    let node = decodeNodes.nodes[min(first + i, ${DECODE_NODE_CAPACITY - 1}u)];
    let a = node.y;
    let b = node.z;
    let dst = min(node.w, ${DECODE_REGISTERS - 1}u);
    let ra = r[min(a, ${DECODE_REGISTERS - 1}u)];
    let rb = r[min(b, ${DECODE_REGISTERS - 1}u)];
    switch (node.x) {
      case 0u, 2u: {
        r[dst] = decodeLatentSample(a, uv, lod, mode);
      }
      case 1u: {
        r[dst] = decodeNetwork(b, ra);
      }
      case 3u: {
        let n = decodeFbm(uv, a, b);
        r[dst] = vec4<f32>(n, n, n, 1.0);
      }
      case 4u: {
        r[dst] = vec4<f32>(decodeFlipbook(t, a, b), 0.0, 0.0, 1.0);
      }
      case 5u: {
        let m = t - floor(t);
        r[dst] = ra * (1.0 - m) + rb * m;
      }
      case 6u: {
        r[dst] = decodeRemap(ra, b);
      }
      case 7u: {
        let alpha = ra.w;
        r[dst] = vec4<f32>(ra.xyz * alpha + rb.xyz * (1.0 - alpha), alpha + rb.w * (1.0 - alpha));
      }
      case 8u: {
        r[dst] = decodeWeights.constants[min(a, ${DECODE_CONSTANT_CAPACITY - 1}u)];
      }
      default: {
      }
    }
  }
  return r[min(header.z, ${DECODE_REGISTERS - 1}u)];
}
`;

/** Floats a case of the device check: program, u, v, lod, t. */
export const DECODE_CASE_FLOATS = 5;

export const DECODE_PARITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> cases: array<f32>;
@group(0) @binding(7) var<storage, read_write> results: array<f32>;
${decodeResourcesWgsl({ group: 0, nodes: 2, weights: 3, latents: 4, clampSampler: 5, repeatSampler: 6 })}

fn decodeLatentSize() -> f32 {
  return params[1];
}

${DECODE_WGSL}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(params[0])) {
    return;
  }
  let at = id.x * ${DECODE_CASE_FLOATS}u;
  let value = decodeProgram(
    u32(cases[at]),
    vec2<f32>(cases[at + 1u], cases[at + 2u]),
    cases[at + 3u],
    cases[at + 4u],
  );
  results[id.x * 4u] = value.x;
  results[id.x * 4u + 1u] = value.y;
  results[id.x * 4u + 2u] = value.z;
  results[id.x * 4u + 3u] = value.w;
}
`;
