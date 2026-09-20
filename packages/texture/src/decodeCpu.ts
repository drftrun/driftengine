/**
 * The reference decoder: what the shader has to agree with.
 *
 * **A second implementation is not duplication here, it is the specification.** A shader cannot be
 * unit-tested at speed, and a decoder that is subtly wrong is a picture that is subtly wrong
 * everywhere — the hardest defect in this whole design to notice and the easiest to ship. So the
 * arithmetic is written once in TypeScript, where it can be asserted in milliseconds, and the
 * device copy is checked against it over generated input.
 *
 * The repository already takes this position: `splats` authors its shader once and generates the
 * second backend from it. This is the same discipline where the second copy cannot be generated.
 *
 * **Deterministic by construction.** No clock, no random, and `t` is the caller's. Decoding the
 * same inputs twice is bit-identical, which is what the fingerprint test rests on.
 */
import {
  ADDRESS_MODE,
  DECODE_OP,
  MAX_REGISTERS,
  nodeA,
  nodeB,
  nodeOp,
  nodeOut,
} from './decodeGraph.ts';
import type { DecodeGraph } from './decodeGraph.ts';
import { evalNetwork } from './inference.ts';
import type { NetworkShape } from './inference.ts';
import { CHANNEL_SEMANTICS, normaliseSample } from './semantics.ts';
import type { ChannelSemantic } from './semantics.ts';
import { flipbookFrame } from './timeNodes.ts';

/** One level of a latent's chain. Components are the image's own. */
export interface LatentLevel {
  data: Float32Array;
  width: number;
  height: number;
}

export interface LatentImage {
  data: Float32Array;
  width: number;
  height: number;
  /** Components per texel, up to four. */
  channels: number;
  /**
   * Levels 1 onward, each half the one before. `mips[k]` is level `k + 1`.
   *
   * Absent is a single level, which is every image written before 2026-09-17 — and at `lod` 0 the
   * chain is never read, so those callers decode exactly what they did.
   */
  mips?: readonly LatentLevel[];
}

export interface DecodeResources {
  latents: readonly LatentImage[];
  blocks: readonly LatentImage[];
  networks: readonly { shape: NetworkShape; weights: Float32Array }[];
  /**
   * Four floats per slot, for `CONSTANT`.
   *
   * Optional, so every caller written before Wave 4C still type-checks and still runs — a graph
   * with no constant in it never reads this.
   */
  constants?: Float32Array;
}

/**
 * The order `REMAP_CHANNEL` packs a semantic in, which is `CHANNEL_SEMANTICS` and not a copy of it.
 *
 * **It was a copy until 2026-09-20**, written out again here — the same eleven names in the same
 * order in two files, with nothing holding them together. That is a list a file's channels are
 * *numbered* by: the two drifting apart means every material written by one and read by the other
 * decodes its channels as something else, and a normal map read as roughness inverts every
 * highlight in a scene. The name is kept because `terrainTexture.ts`, the WGSL interpreter's test
 * and this file all say `REMAP_SEMANTICS` when they mean the packing.
 */
export const REMAP_SEMANTICS: readonly ChannelSemantic[] = CHANNEL_SEMANTICS;

/** Lattice addressing only: where a coordinate lands before it is scaled across the lattice. */
function address(value: number, mode: number): number {
  if (mode === ADDRESS_MODE.LATTICE_WRAP) return value - Math.floor(value);
  return Math.min(1, Math.max(0, value));
}

/** A texel index inside the image: wrapped for centre wrap, clamped for everything else. */
function texelIndex(value: number, size: number, mode: number): number {
  if (mode === ADDRESS_MODE.CENTRE_WRAP) return ((value % size) + size) % size;
  return Math.min(size - 1, Math.max(0, value));
}

/**
 * Bilinear on one level, with the graph's address mode applied first.
 *
 * **For the lattice modes this is byte-identical to what it replaced**: `su` is inside
 * `[0, width - 1]`, so clamping `floor(su)` and `floor(su) + 1` is exactly the `min` it was.
 */
function sampleLevel(
  level: LatentLevel,
  channels: number,
  u: number,
  v: number,
  mode: number,
  out: Float32Array,
): void {
  const centre = mode === ADDRESS_MODE.CENTRE_CLAMP || mode === ADDRESS_MODE.CENTRE_WRAP;
  const su = centre ? u * level.width - 0.5 : address(u, mode) * (level.width - 1);
  const sv = centre ? v * level.height - 0.5 : address(v, mode) * (level.height - 1);
  const baseX = Math.floor(su);
  const baseY = Math.floor(sv);
  const fx = su - baseX;
  const fy = sv - baseY;
  const x0 = texelIndex(baseX, level.width, mode);
  const x1 = texelIndex(baseX + 1, level.width, mode);
  const y0 = texelIndex(baseY, level.height, mode);
  const y1 = texelIndex(baseY + 1, level.height, mode);
  for (let c = 0; c < 4; c += 1) {
    if (c >= channels) {
      out[c] = c === 3 ? 1 : 0;
      continue;
    }
    const at = (x: number, y: number) => level.data[(y * level.width + x) * channels + c] as number;
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

const SECOND = new Float32Array(4);

/**
 * Trilinear: bilinear on the two levels either side of `lod`, mixed by its fraction.
 *
 * **At a whole level only that level is read**, so an integer `lod` — and 0 above all — costs and
 * returns exactly one bilinear sample.
 */
function sampleImage(
  image: LatentImage,
  u: number,
  v: number,
  mode: number,
  lod: number,
  out: Float32Array,
): void {
  const top = image.mips?.length ?? 0;
  const level = lod > 0 ? Math.min(lod, top) : 0;
  const lower = Math.floor(level);
  const blend = level - lower;
  const levelOf = (k: number): LatentLevel =>
    k === 0 ? image : (image.mips?.[k - 1] as LatentLevel);
  sampleLevel(levelOf(lower), image.channels, u, v, mode, out);
  if (blend === 0) return;
  sampleLevel(levelOf(Math.min(lower + 1, top)), image.channels, u, v, mode, SECOND);
  for (let c = 0; c < 4; c += 1) {
    out[c] = (out[c] as number) * (1 - blend) + (SECOND[c] as number) * blend;
  }
}

/** A deterministic integer hash, so the procedural node reproduces across runs and platforms. */
function hash2(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}

function valueNoise(u: number, v: number, seed: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

const SCRATCH = new Float32Array(256);
const SAMPLE = new Float32Array(4);
const NET_IN = new Float32Array(64);
const NET_OUT = new Float32Array(64);

/**
 * Run the graph at one texture coordinate and one time, writing four components into `out`.
 *
 * `registers` is the caller's, `MAX_REGISTERS * 4` floats, reused so this allocates nothing.
 * `lod` picks the level a latent is sampled at; 0, and anything that is not a positive number, is
 * level 0.
 */
export function decodeCpu(
  graph: DecodeGraph,
  resources: DecodeResources,
  u: number,
  v: number,
  t: number,
  out: Float32Array,
  registers: Float32Array,
  lod = 0,
): void {
  for (let i = 0; i < graph.count; i += 1) {
    const op = nodeOp(graph, i);
    const a = nodeA(graph, i);
    const b = nodeB(graph, i);
    const dst = nodeOut(graph, i) * 4;

    switch (op) {
      case DECODE_OP.CONSTANT: {
        const constants = resources.constants;
        const base = a * 4;
        for (let c = 0; c < 4; c += 1) registers[dst + c] = constants?.[base + c] ?? 0;
        break;
      }
      case DECODE_OP.SAMPLE_LATENT: {
        const image = resources.latents[a];
        if (image === undefined) break;
        sampleImage(image, u, v, graph.addressMode, lod, SAMPLE);
        registers.set(SAMPLE, dst);
        break;
      }
      case DECODE_OP.SAMPLE_BLOCK: {
        const image = resources.blocks[a];
        if (image === undefined) break;
        sampleImage(image, u, v, graph.addressMode, lod, SAMPLE);
        registers.set(SAMPLE, dst);
        break;
      }
      case DECODE_OP.PROCEDURAL_FBM: {
        let sum = 0;
        let amplitude = 0.5;
        let frequency = 1;
        const octaves = Math.max(1, b);
        for (let o = 0; o < octaves; o += 1) {
          sum += valueNoise(u * frequency * 8, v * frequency * 8, a) * amplitude;
          amplitude *= 0.5;
          frequency *= 2;
        }
        registers[dst] = sum;
        registers[dst + 1] = sum;
        registers[dst + 2] = sum;
        registers[dst + 3] = 1;
        break;
      }
      case DECODE_OP.FLIPBOOK_INDEX: {
        registers[dst] = flipbookFrame(t, a, b, true);
        registers[dst + 1] = 0;
        registers[dst + 2] = 0;
        registers[dst + 3] = 1;
        break;
      }
      case DECODE_OP.LATENT_LERP: {
        const mix = t - Math.floor(t);
        const src0 = a * 4;
        const src1 = b * 4;
        for (let c = 0; c < 4; c += 1) {
          registers[dst + c] =
            (registers[src0 + c] as number) * (1 - mix) + (registers[src1 + c] as number) * mix;
        }
        break;
      }
      case DECODE_OP.REMAP_CHANNEL: {
        const src = a * 4;
        for (let c = 0; c < 4; c += 1) registers[dst + c] = registers[src + c] as number;
        const semantic = REMAP_SEMANTICS[b >>> 4] ?? 'mask-linear';
        const component = b & 0xf;
        SAMPLE.set(registers.subarray(dst, dst + 4));
        normaliseSample(SAMPLE, { semantic, component }, registers[src + component] as number);
        registers.set(SAMPLE, dst);
        break;
      }
      case DECODE_OP.COMPOSITE: {
        const src0 = a * 4;
        const src1 = b * 4;
        const alpha = registers[src0 + 3] as number;
        for (let c = 0; c < 3; c += 1) {
          registers[dst + c] =
            (registers[src0 + c] as number) * alpha + (registers[src1 + c] as number) * (1 - alpha);
        }
        registers[dst + 3] = alpha + (registers[src1 + 3] as number) * (1 - alpha);
        break;
      }
      case DECODE_OP.EVAL_NETWORK: {
        const net = resources.networks[b];
        if (net === undefined) break;
        const src = a * 4;
        for (let c = 0; c < net.shape.inputs; c += 1) {
          NET_IN[c] = c < 4 ? (registers[src + c] as number) : 0;
        }
        evalNetwork(net.shape, net.weights, NET_IN, NET_OUT, SCRATCH);
        for (let c = 0; c < 4; c += 1) {
          registers[dst + c] = c < net.shape.outputs ? (NET_OUT[c] as number) : 0;
        }
        break;
      }
      default:
        break;
    }
  }
  const result = graph.result * 4;
  for (let c = 0; c < 4; c += 1) out[c] = registers[result + c] as number;
}

/** A registers array of the right size, for a caller that holds one across calls. */
export function createDecodeRegisters(): Float32Array {
  return new Float32Array(MAX_REGISTERS * 4);
}
