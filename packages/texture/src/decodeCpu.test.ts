import { expect, test } from 'vitest';
import { ADDRESS_MODE, DECODE_OP, addDecodeNode, createDecodeGraph } from './decodeGraph.ts';
import { createDecodeRegisters, decodeCpu } from './decodeCpu.ts';
import type { DecodeResources } from './decodeCpu.ts';

function flat(value: number, channels = 4): DecodeResources {
  const data = new Float32Array(2 * 2 * channels);
  for (let i = 0; i < data.length; i += 1) data[i] = value;
  return {
    latents: [{ data, width: 2, height: 2, channels }],
    blocks: [],
    networks: [],
  };
}

const OUT = new Float32Array(4);

test('a graph that samples a constant latent returns that constant', () => {
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  decodeCpu(graph, flat(0.25), 0.5, 0.5, 0, OUT, createDecodeRegisters());
  expect(OUT[0]).toBeCloseTo(0.25, 6);
});

test('decoding the same inputs twice is bit-identical, which the fingerprint rests on', () => {
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 7, 4, 0);
  graph.result = 0;
  const a = new Float32Array(4);
  const b = new Float32Array(4);
  decodeCpu(graph, flat(0), 0.3, 0.7, 1.5, a, createDecodeRegisters());
  decodeCpu(graph, flat(0), 0.3, 0.7, 1.5, b, createDecodeRegisters());
  expect(Array.from(a)).toEqual(Array.from(b));
});

test('a flipbook node changes with time and a static one does not', () => {
  const book = createDecodeGraph(2);
  addDecodeNode(book, DECODE_OP.FLIPBOOK_INDEX, 8, 24, 0);
  book.result = 0;
  const first = new Float32Array(4);
  const later = new Float32Array(4);
  decodeCpu(book, flat(0), 0, 0, 0, first, createDecodeRegisters());
  decodeCpu(book, flat(0), 0, 0, 3 / 24, later, createDecodeRegisters());
  expect(first[0]).toBe(0);
  expect(later[0]).toBe(3);

  const still = createDecodeGraph(2);
  addDecodeNode(still, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  still.result = 0;
  const s0 = new Float32Array(4);
  const s1 = new Float32Array(4);
  decodeCpu(still, flat(0.4), 0.5, 0.5, 0, s0, createDecodeRegisters());
  decodeCpu(still, flat(0.4), 0.5, 0.5, 99, s1, createDecodeRegisters());
  expect(Array.from(s0)).toEqual(Array.from(s1));
});

test('an sRGB-declared channel comes back linear, exercising the semantics through the decoder', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  /* semantic index 0 is albedo-srgb; component 0. */
  addDecodeNode(graph, DECODE_OP.REMAP_CHANNEL, 0, (0 << 4) | 0, 1);
  graph.result = 1;
  decodeCpu(graph, flat(0.5), 0.5, 0.5, 0, OUT, createDecodeRegisters());
  expect(OUT[0]).toBeCloseTo(0.214, 3);
});

test('wrapping and clamping differ outside the unit square', () => {
  const data = Float32Array.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1]);
  const resources: DecodeResources = {
    latents: [{ data, width: 2, height: 2, channels: 4 }],
    blocks: [],
    networks: [],
  };
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;

  const clamped = new Float32Array(4);
  graph.addressMode = 0;
  decodeCpu(graph, resources, 1.25, 0, 0, clamped, createDecodeRegisters());

  const wrapped = new Float32Array(4);
  graph.addressMode = 1;
  decodeCpu(graph, resources, 1.25, 0, 0, wrapped, createDecodeRegisters());

  expect(clamped[0]).not.toBeCloseTo(wrapped[0] as number, 6);
});

test('composite puts the first register over the second', () => {
  const graph = createDecodeGraph(4);
  const registers = createDecodeRegisters();
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 1, 0, 1);
  addDecodeNode(graph, DECODE_OP.COMPOSITE, 0, 1, 2);
  graph.result = 2;

  const over = new Float32Array(4 * 4).fill(0);
  for (let i = 0; i < 4; i += 1) {
    over[i * 4] = 1;
    over[i * 4 + 3] = 0.5;
  }
  const under = new Float32Array(4 * 4).fill(0);
  for (let i = 0; i < 4; i += 1) under[i * 4 + 3] = 1;

  const resources: DecodeResources = {
    latents: [
      { data: over, width: 2, height: 2, channels: 4 },
      { data: under, width: 2, height: 2, channels: 4 },
    ],
    blocks: [],
    networks: [],
  };
  decodeCpu(graph, resources, 0.5, 0.5, 0, OUT, registers);
  expect(OUT[0]).toBeCloseTo(0.5, 6);
  expect(OUT[3]).toBeCloseTo(1, 6);
});

test('a network node runs the shared evaluator', () => {
  const graph = createDecodeGraph(4);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.EVAL_NETWORK, 0, 0, 1);
  graph.result = 1;
  const resources: DecodeResources = {
    ...flat(0.5),
    networks: [
      { shape: { inputs: 1, hidden: [], outputs: 1 }, weights: Float32Array.from([2, 0]) },
    ],
  };
  decodeCpu(graph, resources, 0.5, 0.5, 0, OUT, createDecodeRegisters());
  expect(OUT[0]).toBeCloseTo(1, 6);
});

test('a constant writes its four components and nothing else does', () => {
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.CONSTANT, 1, 0, 0);
  graph.result = 0;

  const out = new Float32Array(4);
  decodeCpu(
    graph,
    {
      latents: [],
      blocks: [],
      networks: [],
      constants: new Float32Array([9, 9, 9, 9, 0.25, 0.5, 0.75, 1]),
    },
    0.5,
    0.5,
    0,
    out,
    createDecodeRegisters(),
  );
  expect([...out], 'slot one, not slot zero').toEqual([0.25, 0.5, 0.75, 1]);
});

/** A graph with no `constants` at all reads zero rather than throwing, because the field is new. */
test('a constant with nothing behind it is black', () => {
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.CONSTANT, 0, 0, 0);
  graph.result = 0;

  const out = new Float32Array(4).fill(7);
  decodeCpu(
    graph,
    { latents: [], blocks: [], networks: [] },
    0,
    0,
    0,
    out,
    createDecodeRegisters(),
  );
  expect([...out]).toEqual([0, 0, 0, 0]);
});

/**
 * **Texel-centre addressing, added 2026-09-17 for the GPU-driven pipeline.** Modes 0 and 1 put
 * `u = 0` on the centre of the first texel and `u = 1` on the centre of the last, and terrain
 * heights depend on that. A GPU sampler puts `u = 0` on the first texel's *edge*, so a surface
 * texture sampled on the device needs a mode the reference can be compared against.
 */
function ramp(): DecodeResources {
  /* Four texels in a row whose values are their own indices, so a sample names where it landed. */
  return {
    latents: [{ data: Float32Array.from([0, 1, 2, 3]), width: 4, height: 1, channels: 1 }],
    blocks: [],
    networks: [],
  };
}

function sampleAt(mode: number, u: number): number {
  const graph = createDecodeGraph(1);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  graph.addressMode = mode;
  const out = new Float32Array(4);
  decodeCpu(graph, ramp(), u, 0.5, 0, out, createDecodeRegisters());
  return out[0] as number;
}

test('A CENTRE-ADDRESSED SAMPLE LANDS WHERE A GPU SAMPLER LANDS, half a texel in', () => {
  /* Texel k's centre is at (k + 0.5) / width, and there the value is exactly k. */
  for (let k = 0; k < 4; k += 1) {
    expect(sampleAt(ADDRESS_MODE.CENTRE_CLAMP, (k + 0.5) / 4)).toBeCloseTo(k, 6);
    expect(sampleAt(ADDRESS_MODE.CENTRE_WRAP, (k + 0.5) / 4)).toBeCloseTo(k, 6);
  }
  /* Between two centres it is the blend of those two. */
  expect(sampleAt(ADDRESS_MODE.CENTRE_CLAMP, 0.5)).toBeCloseTo(1.5, 6);
});

test('and v is addressed the way u is, which a one-texel-tall ramp cannot show', () => {
  const column: DecodeResources = {
    latents: [{ data: Float32Array.from([0, 1, 2, 3]), width: 1, height: 4, channels: 1 }],
    blocks: [],
    networks: [],
  };
  const graph = createDecodeGraph(1);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  const out = new Float32Array(4);
  const registers = createDecodeRegisters();
  for (let k = 0; k < 4; k += 1) {
    graph.addressMode = ADDRESS_MODE.CENTRE_CLAMP;
    decodeCpu(graph, column, 0.5, (k + 0.5) / 4, 0, out, registers);
    expect(out[0]).toBeCloseTo(k, 6);
    graph.addressMode = ADDRESS_MODE.LATTICE_CLAMP;
    decodeCpu(graph, column, 0.5, k / 3, 0, out, registers);
    expect(out[0]).toBe(k);
  }
  /* Both ends of the seam: at v = 0 the lower neighbour wraps, at v = 1 the upper one does. */
  graph.addressMode = ADDRESS_MODE.CENTRE_WRAP;
  for (const v of [0, 1]) {
    decodeCpu(graph, column, 0.5, v, 0, out, registers);
    expect(out[0], `v = ${v}`).toBeCloseTo(1.5, 6);
  }
});

test('and the lattice modes are exactly what they were, because terrain heights rest on them', () => {
  /* u = k / (width - 1) lands on texel k — `terrainTexture.ts` samples exactly this. */
  for (let k = 0; k < 4; k += 1) {
    expect(sampleAt(ADDRESS_MODE.LATTICE_CLAMP, k / 3)).toBe(k);
  }
  expect(sampleAt(ADDRESS_MODE.LATTICE_WRAP, 1.25)).toBeCloseTo(0.75, 6);
});

test('CENTRE CLAMP HOLDS THE EDGE TEXEL, and centre wrap blends across the seam', () => {
  expect(sampleAt(ADDRESS_MODE.CENTRE_CLAMP, 0)).toBe(0);
  expect(sampleAt(ADDRESS_MODE.CENTRE_CLAMP, -3)).toBe(0);
  expect(sampleAt(ADDRESS_MODE.CENTRE_CLAMP, 1)).toBe(3);
  /*
   * At u = 0 a repeating sampler sits halfway between the last texel and the first: the seam
   * blends. Lattice wrap cannot — it jumps from the last texel to the first — which is the seam
   * a tiling surface texture shows under mode 1.
   */
  expect(sampleAt(ADDRESS_MODE.CENTRE_WRAP, 0)).toBeCloseTo(1.5, 6);
  expect(sampleAt(ADDRESS_MODE.CENTRE_WRAP, 1)).toBeCloseTo(1.5, 6);
  expect(sampleAt(ADDRESS_MODE.CENTRE_WRAP, -0.875)).toBeCloseTo(sampleAt(3, 0.125), 6);
});

/** A two-level chain: level 0 is all 0.2, level 1 is all 0.6, so a sample names its level. */
function chain(): DecodeResources {
  return {
    latents: [
      {
        data: new Float32Array(4).fill(0.2),
        width: 2,
        height: 2,
        channels: 1,
        mips: [{ data: new Float32Array(1).fill(0.6), width: 1, height: 1 }],
      },
    ],
    blocks: [],
    networks: [],
  };
}

function atLevel(lod: number, resources = chain()): number {
  const graph = createDecodeGraph(1);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  graph.result = 0;
  graph.addressMode = ADDRESS_MODE.CENTRE_CLAMP;
  const out = new Float32Array(4);
  decodeCpu(graph, resources, 0.3, 0.7, 0, out, createDecodeRegisters(), lod);
  return out[0] as number;
}

test('A LEVEL IS READ FROM ITS OWN IMAGE, and between two levels the two are mixed', () => {
  expect(atLevel(0)).toBeCloseTo(0.2, 6);
  expect(atLevel(1)).toBeCloseTo(0.6, 6);
  /* A quarter of the way: trilinear, which is what the device sampler does. */
  expect(atLevel(0.25)).toBeCloseTo(0.2 * 0.75 + 0.6 * 0.25, 6);
});

test('a level past the chain reads its last level, and a negative or missing one reads level 0', () => {
  expect(atLevel(7)).toBeCloseTo(0.6, 6);
  expect(atLevel(-2)).toBeCloseTo(0.2, 6);
  expect(atLevel(Number.NaN)).toBeCloseTo(0.2, 6);
  const single = chain();
  delete (single.latents[0] as { mips?: unknown }).mips;
  expect(atLevel(1, single)).toBeCloseTo(0.2, 6);
});

test('LEVEL ZERO IS EXACTLY WHAT THE DECODER RETURNED BEFORE IT HAD LEVELS', () => {
  /* The existing callers pass no lod, so this is the promise that nothing they decode moved. */
  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 3, 4, 1);
  graph.result = 0;
  const resources = chain();
  const implicit = new Float32Array(4);
  const explicit = new Float32Array(4);
  decodeCpu(graph, resources, 0.3, 0.7, 0, implicit, createDecodeRegisters());
  decodeCpu(graph, resources, 0.3, 0.7, 0, explicit, createDecodeRegisters(), 0);
  expect(Array.from(explicit)).toEqual(Array.from(implicit));
});

test('at a whole level the next one is never read, so a broken level past it cannot leak in', () => {
  /* Level 1 claims a texel it does not carry; reading it at all would put NaN into the mix. */
  const broken = chain();
  (broken.latents[0] as { mips?: unknown }).mips = [
    { data: new Float32Array(0), width: 1, height: 1 },
  ];
  expect(atLevel(0, broken)).toBe(atLevel(0));
});
