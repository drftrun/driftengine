/**
 * A heightfield and its material weights, held as `DTEX` layers.
 *
 * **What a layer is here is what a texture is everywhere in this engine: a small decode program
 * over a latent image**, run by `@driftengine/texture`'s reference decoder. So terrain gets the
 * whole format for free — the residency, the streaming, the tolerance, the determinism — instead of
 * a second image path of its own, and a terrain layer is a texture a material graph could have
 * produced.
 *
 * **The decode program produces a normalised channel and the range turns it into metres**, because
 * the vocabulary has no affine operation and should not grow one for this: a height map in any
 * format is a normalised value plus a range, and putting the range in the layer keeps the two
 * together. `height-linear` is the semantic that says so.
 *
 * ---
 *
 * **The rule this file exists to hold, and the plan had it the other way round.** The plan asked
 * that heights decoded from a layer match the source heightfield within the format's tolerance.
 * They do. That is not enough, and believing it is is how the most reported terrain defect
 * anywhere gets shipped: if the renderer reads the layer and collision reads the source, the two
 * surfaces differ by exactly that tolerance, everywhere, permanently — a character floating or
 * sinking by a fraction of a millimetre with nothing to attribute it to.
 *
 * So `terrainFromHeightLayer` builds a `Terrain` from the **decoded** samples, and everything —
 * the query, the patch mesh, the collider `heightfieldPatch` feeds — reads that one. The two
 * cannot disagree because there is only one set of numbers. `heightfield.ts` states the same rule
 * one level down, for the triangle against the bilinear patch.
 *
 * **A consumer that never touches this path pays nothing for it.** The imports are named, the
 * package is `sideEffects: false`, and `core-and-terrain`'s floor is what proves it stayed that
 * way.
 */
import {
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  createDecodeRegisters,
  decodeCpu,
  REMAP_SEMANTICS,
  type DecodeGraph,
  type DecodeResources,
  type LatentImage,
} from '@driftengine/texture';

import { Terrain } from './heightfield.ts';

/** Quantisation levels a height layer carries: sixteen bits. */
export const TERRAIN_HEIGHT_LEVELS = 65536;

/** Quantisation levels one splat weight carries: eight bits, four of them to a texel. */
export const TERRAIN_SPLAT_LEVELS = 256;

/** Materials a splat layer blends. Four, because that is one texel. */
export const TERRAIN_SPLAT_CHANNELS = 4;

/** `b` for a `REMAP_CHANNEL` node: the semantic's index in `REMAP_SEMANTICS`, then the component. */
function remapOperand(semantic: (typeof REMAP_SEMANTICS)[number], component: number): number {
  const index = REMAP_SEMANTICS.indexOf(semantic);
  if (index < 0) throw new Error(`terrainTexture: ${semantic} is not a remappable semantic`);
  return (index << 4) | component;
}

/** A decode program that samples one latent and applies one channel convention. */
function oneChannelGraph(semantic: (typeof REMAP_SEMANTICS)[number]): DecodeGraph {
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.REMAP_CHANNEL, 0, remapOperand(semantic, 0), 1);
  graph.result = 1;
  /* Clamped, not wrapped: a field has an edge, and a query past it answers the edge. */
  graph.addressMode = 0;
  return graph;
}

export interface TerrainHeightLayer {
  readonly graph: DecodeGraph;
  readonly resources: DecodeResources;
  /** Samples across x and z, which is also the latent's size in texels. */
  readonly width: number;
  readonly depth: number;
  /** Metres at the bottom of the encoded range. */
  readonly minM: number;
  /** Metres the encoded range spans. Zero for a flat field. */
  readonly rangeM: number;
  /** Metres between samples, carried so a rebuilt terrain cannot be given a different one. */
  readonly spacingM: number;
  /** World position of sample `(0, 0)`, carried for the same reason. */
  readonly origin: Float32Array;
}

/**
 * Encode a terrain's samples into a height layer.
 *
 * The range is the field's own, not a fixed world range: a valley two metres deep quantised
 * against a range of four kilometres is a staircase, and terrain is where that is most visible
 * because a shallow slope magnifies a step in height into a wide flat shelf.
 */
export function encodeTerrainHeights(terrain: Terrain): TerrainHeightLayer {
  const count = terrain.width * terrain.depth;
  let minM = Infinity;
  let maxM = -Infinity;
  for (let at = 0; at < count; at += 1) {
    const h = terrain.heights[at] as number;
    if (h < minM) minM = h;
    if (h > maxM) maxM = h;
  }
  if (!Number.isFinite(minM)) {
    minM = 0;
    maxM = 0;
  }
  const rangeM = maxM - minM;

  const data = new Float32Array(count);
  for (let at = 0; at < count; at += 1) {
    /* A flat field has no range to divide by, and every sample is the minimum. */
    const normalised = rangeM === 0 ? 0 : ((terrain.heights[at] as number) - minM) / rangeM;
    data[at] = Math.round(normalised * (TERRAIN_HEIGHT_LEVELS - 1)) / (TERRAIN_HEIGHT_LEVELS - 1);
  }
  const latent: LatentImage = { data, width: terrain.width, height: terrain.depth, channels: 1 };

  return {
    graph: oneChannelGraph('height-linear'),
    resources: { latents: [latent], blocks: [], networks: [] },
    width: terrain.width,
    depth: terrain.depth,
    minM,
    rangeM,
    spacingM: terrain.spacingM,
    origin: Float32Array.from(terrain.origin),
  };
}

/**
 * The most a decoded height can differ from the one encoded.
 *
 * **Half a quantisation step plus one float32 step of the range, and the second term is not
 * padding.** The normalised value is stored in the latent as a float32, so the code is exact but
 * `code / 65535` is not — and the decode multiplies that representation error back up by the whole
 * range. Written as half a step alone, this function is wrong by about a part in a thousand, which
 * is exactly enough for a tolerance assertion to fail on a field somebody did not choose
 * carefully: measured 4.6372e-5 against a half-step of 4.6314e-5 over a range of six metres.
 *
 * Stated as a function of the layer rather than as a constant, since it is the field's own range
 * that sets both terms.
 */
export function terrainHeightTolerance(layer: TerrainHeightLayer): number {
  /* 2⁻²⁴, written as a division because `**` is `Math.pow` to the determinism scan — and that
     scan is right to refuse it: an engine is free to round `Math.pow` differently, and a
     tolerance that differs by an ulp between two peers is a replay that disagrees. */
  const FLOAT32_STEP = 1 / 16777216;
  return layer.rangeM * (0.5 / (TERRAIN_HEIGHT_LEVELS - 1) + FLOAT32_STEP);
}

/** Decode every sample of a height layer into `out`, in metres, row-major with x fastest. */
export function decodeTerrainHeights(layer: TerrainHeightLayer, out: Float32Array): void {
  const registers = createDecodeRegisters();
  const sample = new Float32Array(4);
  for (let z = 0; z < layer.depth; z += 1) {
    for (let x = 0; x < layer.width; x += 1) {
      /* Lattice coordinates: the decoder maps `u` across `width - 1`, so a sample lands on its own
         texel exactly and the bilinear filter contributes nothing to a sample-aligned read. */
      const u = layer.width === 1 ? 0 : x / (layer.width - 1);
      const v = layer.depth === 1 ? 0 : z / (layer.depth - 1);
      decodeCpu(layer.graph, layer.resources, u, v, 0, sample, registers);
      out[z * layer.width + x] = layer.minM + (sample[0] as number) * layer.rangeM;
    }
  }
}

/**
 * The terrain a layer describes: the same class every consumer already queries, built from the
 * decoded samples.
 *
 * **This is the whole answer to "collision and rendering read the same height".** They read the
 * same object, because the layer produces exactly one.
 */
export function terrainFromHeightLayer(layer: TerrainHeightLayer): Terrain {
  const heights = new Float32Array(layer.width * layer.depth);
  decodeTerrainHeights(layer, heights);
  return new Terrain({
    width: layer.width,
    depth: layer.depth,
    spacingM: layer.spacingM,
    heights,
    origin: layer.origin,
  });
}

export interface TerrainSplatLayer {
  readonly graph: DecodeGraph;
  readonly resources: DecodeResources;
  readonly width: number;
  readonly depth: number;
}

/**
 * Encode four material weights per sample.
 *
 * Refuses a map whose weights do not already sum to one, rather than normalising it on the way in.
 * A weight map nobody filled in sums to zero at every texel, and a normalisation applied quietly
 * turns that into "material zero, everywhere" — a whole world of one texture, shipped, with no
 * error anywhere. The caller's own weights are a statement about the ground and this does not
 * edit it.
 */
export function encodeTerrainSplat(
  width: number,
  depth: number,
  weights: ArrayLike<number>,
): TerrainSplatLayer {
  const count = width * depth;
  if (weights.length !== count * TERRAIN_SPLAT_CHANNELS) {
    throw new Error(
      `encodeTerrainSplat: ${width} by ${depth} needs ${count * TERRAIN_SPLAT_CHANNELS} weights, ` +
        `got ${weights.length}`,
    );
  }
  const data = new Float32Array(count * TERRAIN_SPLAT_CHANNELS);
  for (let at = 0; at < count; at += 1) {
    let sum = 0;
    for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) {
      sum += weights[at * TERRAIN_SPLAT_CHANNELS + c] as number;
    }
    if (Math.abs(sum - 1) > 1e-3) {
      throw new Error(
        `encodeTerrainSplat: the weights at sample ${at} sum to ${sum.toFixed(4)} and must sum to one`,
      );
    }
    for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) {
      const raw = weights[at * TERRAIN_SPLAT_CHANNELS + c] as number;
      data[at * TERRAIN_SPLAT_CHANNELS + c] =
        Math.round(raw * (TERRAIN_SPLAT_LEVELS - 1)) / (TERRAIN_SPLAT_LEVELS - 1);
    }
  }
  const latent: LatentImage = { data, width, height: depth, channels: TERRAIN_SPLAT_CHANNELS };
  const graph = createDecodeGraph(1);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  graph.addressMode = 0;
  return { graph, resources: { latents: [latent], blocks: [], networks: [] }, width, depth };
}

const SPLAT_REGISTERS = createDecodeRegisters();
const SPLAT_SAMPLE = new Float32Array(4);

/**
 * Sample the four weights at a field coordinate, renormalised so they sum to one.
 *
 * **The renormalisation is not tidiness.** Four weights each rounded to eight bits sum to anywhere
 * between 0.994 and 1.006, and a shader that trusts the sum draws a hillside slightly too bright
 * or slightly too dark — smoothly, so it reads as lighting rather than as a texture bug. The
 * alternative, storing three weights and deriving the fourth, puts the entire error on one
 * material and is worse for the same total.
 */
export function decodeTerrainSplat(
  layer: TerrainSplatLayer,
  u: number,
  v: number,
  out: Float32Array,
): void {
  decodeCpu(layer.graph, layer.resources, u, v, 0, SPLAT_SAMPLE, SPLAT_REGISTERS);
  let sum = 0;
  for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) sum += SPLAT_SAMPLE[c] as number;
  if (sum <= 0) {
    /* Unreachable through `encodeTerrainSplat`, which refuses a map that could produce it. Kept
       because a caller may build a layer another way, and dividing by zero here would answer NaN
       weights that a shader turns into a black patch of ground. */
    for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) out[c] = c === 0 ? 1 : 0;
    return;
  }
  for (let c = 0; c < TERRAIN_SPLAT_CHANNELS; c += 1) out[c] = (SPLAT_SAMPLE[c] as number) / sum;
}
