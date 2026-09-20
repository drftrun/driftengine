import { expect, test } from 'vitest';

import {
  DECODE_CONSTANT_CAPACITY,
  DECODE_NETWORK_CAPACITY,
  DECODE_NODE_CAPACITY,
  DECODE_NODES_BYTES,
  DECODE_OPS,
  DECODE_PROGRAM_CAPACITY,
  DECODE_WEIGHT_BLOCKS,
  DECODE_WEIGHTS_BYTES,
} from '../shaders/gpudriven/decode.wgsl.ts';
import { packDecodeTables, type GpuDrivenLatent, type GpuDrivenProgram } from './decodeTables.ts';

const NETWORK_AT = DECODE_PROGRAM_CAPACITY * 4;
const NODE_AT = NETWORK_AT + DECODE_NETWORK_CAPACITY * 8;
const CONSTANT_AT = DECODE_WEIGHT_BLOCKS * 4;

/** A full chain for a `size` latent, every byte of level `k` equal to `fill + k`. */
function latent(size: number, components: number, fill: number): GpuDrivenLatent {
  const levels: Uint8Array[] = [];
  for (let edge = size, k = 0; ; edge >>= 1, k += 1) {
    levels.push(new Uint8Array(edge * edge * components).fill(fill + k));
    if (edge === 1) break;
  }
  return { width: size, height: size, components, levels };
}

/** SAMPLE_LATENT slot 0 into r0, then EVAL_NETWORK r0 through slot 0 into r1. */
function program(overrides: Partial<GpuDrivenProgram> = {}): GpuDrivenProgram {
  return {
    graph: {
      nodes: Uint32Array.from([
        DECODE_OPS.SAMPLE_LATENT,
        0,
        0,
        0,
        DECODE_OPS.EVAL_NETWORK,
        0,
        0,
        1,
      ]),
      count: 2,
      result: 1,
      addressMode: 3,
    },
    latents: [latent(4, 3, 10)],
    networks: [
      {
        shape: { inputs: 3, hidden: [], outputs: 2 },
        weights: new Float32Array(3 * 2 + 2).fill(0.5),
      },
    ],
    ...overrides,
  };
}

test('both tables are exactly the size of the uniform structs that read them', () => {
  const tables = packDecodeTables([program()]);
  expect(tables.nodes.byteLength).toBe(DECODE_NODES_BYTES);
  expect(tables.weights.byteLength).toBe(DECODE_WEIGHTS_BYTES);
});

test('A PROGRAM-LOCAL SLOT BECOMES A GLOBAL ONE, so two programs sample two layers', () => {
  const tables = packDecodeTables([program(), program({ latents: [latent(4, 3, 50)] })]);
  expect(tables.layerCount).toBe(2);
  /* Headers: first node, count, result, address mode. */
  expect(Array.from(tables.nodes.subarray(0, 8))).toEqual([0, 2, 1, 3, 2, 2, 1, 3]);
  /* The second program's SAMPLE_LATENT reads layer 1, and its EVAL_NETWORK network 1. */
  expect(tables.nodes[NODE_AT + 2 * 4 + 1]).toBe(1);
  expect(tables.nodes[NODE_AT + 3 * 4 + 2]).toBe(1);
  /* Level 0 of layer 1 starts after sixteen texels of layer 0. */
  expect(tables.levels[0]?.[16 * 4]).toBe(50);
});

test('networks are packed end to end, and their headers say where each begins', () => {
  const tables = packDecodeTables([
    program({
      networks: [
        {
          shape: { inputs: 3, hidden: [5], outputs: 4 },
          weights: new Float32Array(3 * 5 + 5 + 5 * 4 + 4).fill(1),
        },
      ],
    }),
    program(),
  ]);
  expect(Array.from(tables.nodes.subarray(NETWORK_AT, NETWORK_AT + 8))).toEqual([
    0, 3, 4, 1, 5, 0, 0, 0,
  ]);
  expect(Array.from(tables.nodes.subarray(NETWORK_AT + 8, NETWORK_AT + 12))).toEqual([44, 3, 2, 0]);
  expect(tables.weights[43]).toBe(1);
  expect(tables.weights[44]).toBe(0.5);
});

test('a block is a layer too, numbered after the latents that came before it', () => {
  const graph = {
    nodes: Uint32Array.from([DECODE_OPS.SAMPLE_BLOCK, 0, 0, 0]),
    count: 1,
    result: 0,
    addressMode: 0,
  };
  const tables = packDecodeTables([
    program({ graph, latents: [latent(4, 3, 20)], blocks: [latent(4, 3, 90)], networks: [] }),
  ]);
  expect(tables.layerCount).toBe(2);
  expect(tables.nodes[NODE_AT + 1]).toBe(1);
  expect(tables.levels[0]?.[16 * 4]).toBe(90);
});

test('a constant is copied to its global slot and its node is pointed at it', () => {
  const constants = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  const graph = {
    nodes: Uint32Array.from([DECODE_OPS.CONSTANT, 0, 0, 2]),
    count: 1,
    result: 2,
    addressMode: 0,
  };
  const tables = packDecodeTables([
    program({ graph, constants, latents: [], networks: [] }),
    program({ graph, constants, latents: [], networks: [] }),
  ]);
  expect(tables.weights[CONSTANT_AT + 4]).toBeCloseTo(0.1, 6);
  expect(tables.nodes[NODE_AT + 1 * 4 + 1]).toBe(1);
});

test('A LATENT WITH FEWER THAN FOUR COMPONENTS READS ZERO, AND ONE IN ITS ALPHA', () => {
  /* decodeCpu's rule for a channel an image does not have, so the device reads the same. */
  const tables = packDecodeTables([program({ latents: [latent(4, 2, 7)] })]);
  expect(Array.from(tables.levels[0]?.subarray(0, 4) ?? [])).toEqual([7, 7, 0, 255]);
});

test('a pass with no textured material still has one layer, one texel across', () => {
  const tables = packDecodeTables([]);
  expect(tables.layerCount).toBe(1);
  expect(tables.layerSize).toBe(1);
  expect(tables.levels.length).toBe(1);
  expect(tables.levels[0]?.length).toBe(4);
});

test('EVERY LIMIT IS REFUSED IN WORDS, with the number that broke it', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    [
      'size',
      () => packDecodeTables([program(), program({ latents: [latent(8, 3, 0)] })]),
      /8 by 8/,
    ],
    [
      'power of two',
      () => packDecodeTables([program({ latents: [{ ...latent(4, 3, 0), width: 3, height: 3 }] })]),
      /3/,
    ],
    [
      'chain',
      () =>
        packDecodeTables([
          program({ latents: [{ ...latent(4, 3, 0), levels: [new Uint8Array(48)] }] }),
        ]),
      /1 level/,
    ],
    [
      'inputs',
      () =>
        packDecodeTables([
          program({
            networks: [
              { shape: { inputs: 5, hidden: [], outputs: 1 }, weights: new Float32Array(6) },
            ],
          }),
        ]),
      /5 inputs/,
    ],
    [
      'width',
      () =>
        packDecodeTables([
          program({
            networks: [
              {
                shape: { inputs: 1, hidden: [17], outputs: 1 },
                weights: new Float32Array(17 + 17 + 17 + 1),
              },
            ],
          }),
        ]),
      /17/,
    ],
    [
      'weights',
      () =>
        packDecodeTables([
          program({
            networks: [
              { shape: { inputs: 3, hidden: [], outputs: 2 }, weights: new Float32Array(7) },
            ],
          }),
        ]),
      /7 weights/,
    ],
    [
      'opcode',
      () =>
        packDecodeTables([
          program({
            graph: { nodes: Uint32Array.from([9, 0, 0, 0]), count: 1, result: 0, addressMode: 0 },
          }),
        ]),
      /opcode 9/,
    ],
    [
      'register',
      () =>
        packDecodeTables([
          program({
            graph: {
              nodes: Uint32Array.from([DECODE_OPS.SAMPLE_LATENT, 0, 0, 16]),
              count: 1,
              result: 0,
              addressMode: 0,
            },
          }),
        ]),
      /16/,
    ],
    [
      'slot',
      () =>
        packDecodeTables([
          program({
            graph: {
              nodes: Uint32Array.from([DECODE_OPS.SAMPLE_LATENT, 3, 0, 0]),
              count: 1,
              result: 0,
              addressMode: 0,
            },
          }),
        ]),
      /latent 3/,
    ],
    [
      'octaves',
      () =>
        packDecodeTables([
          program({
            graph: {
              nodes: Uint32Array.from([DECODE_OPS.PROCEDURAL_FBM, 1, 17, 0]),
              count: 1,
              result: 0,
              addressMode: 0,
            },
          }),
        ]),
      /17 octaves/,
    ],
    [
      'mode',
      () => packDecodeTables([program({ graph: { ...program().graph, addressMode: 4 } })]),
      /address mode 4/,
    ],
    [
      'constants',
      () =>
        packDecodeTables(
          Array.from({ length: 2 }, () =>
            program({ constants: new Float32Array((DECODE_CONSTANT_CAPACITY / 2 + 1) * 4) }),
          ),
        ),
      /constant/,
    ],
    [
      'programs',
      () =>
        packDecodeTables(
          Array.from({ length: DECODE_PROGRAM_CAPACITY + 1 }, () =>
            program({ latents: [latent(1, 1, 0)] }),
          ),
        ),
      /193 programs/,
    ],
    [
      'outputs',
      () =>
        packDecodeTables([
          program({
            networks: [
              { shape: { inputs: 3, hidden: [], outputs: 5 }, weights: new Float32Array(20) },
            ],
          }),
        ]),
      /5 outputs/,
    ],
    [
      'hidden layers',
      () =>
        packDecodeTables([
          program({
            networks: [
              {
                shape: { inputs: 1, hidden: [1, 1, 1], outputs: 1 },
                weights: new Float32Array(8),
              },
            ],
          }),
        ]),
      /3 hidden layers/,
    ],
    [
      'level bytes',
      () => {
        const whole = latent(4, 3, 0);
        const short = [whole.levels[0], new Uint8Array(11), whole.levels[2]] as Uint8Array[];
        return packDecodeTables([program({ latents: [{ ...whole, levels: short }] })]);
      },
      /level 1 of a latent holds 11 bytes, not 12/,
    ],
    [
      'components',
      () => packDecodeTables([program({ latents: [{ ...latent(4, 3, 0), components: 5 }] })]),
      /5 components/,
    ],
  ];
  for (const [name, run, message] of cases) {
    expect(run, name).toThrow(message);
  }
});

/** `count` one-layer programs, each carrying the networks `nets` builds. */
function withNetworks(count: number, nets: (index: number) => GpuDrivenProgram['networks']) {
  return Array.from({ length: count }, (_, index) =>
    program({ latents: [latent(1, 1, 0)], networks: nets(index) }),
  );
}

function network(inputs: number, hidden: number[], outputs: number) {
  let total = 0;
  let previous = inputs;
  for (const width of hidden) {
    total += previous * width + width;
    previous = width;
  }
  total += previous * outputs + outputs;
  return { shape: { inputs, hidden, outputs }, weights: new Float32Array(total) };
}

test('EVERY CAPACITY IS EXACT: the last slot fits, and one past it is refused', () => {
  /* Past any of these, a write lands in the next region of the same uniform — silently. */
  const small = network(3, [], 2);
  expect(() =>
    packDecodeTables(withNetworks(DECODE_NETWORK_CAPACITY / 2, () => [small, small])),
  ).not.toThrow();
  expect(() =>
    packDecodeTables([
      ...withNetworks(DECODE_NETWORK_CAPACITY / 2, () => [small, small]),
      ...withNetworks(1, () => [small]),
    ]),
  ).toThrow(new RegExp(`more than ${DECODE_NETWORK_CAPACITY} networks`));

  /* 36 · 420 + 60 · 4 is exactly 15,360; swap two fours for three threes and it is 15,361. */
  const big = network(4, [16, 16], 4);
  const four = network(1, [], 2);
  const three = network(2, [], 1);
  expect(big.weights.length * 36 + four.weights.length * 60).toBe(DECODE_WEIGHT_BLOCKS * 4);
  const full = [...Array(36).fill(big), ...Array(60).fill(four)];
  expect(() => packDecodeTables(withNetworks(1, () => full))).not.toThrow();
  const over = [...Array(36).fill(big), ...Array(58).fill(four), ...Array(3).fill(three)];
  expect(() => packDecodeTables(withNetworks(1, () => over))).toThrow(
    new RegExp(`${DECODE_WEIGHT_BLOCKS * 4} weights`),
  );

  const flipbooks = (count: number) => {
    const nodes = new Uint32Array(count * 4);
    for (let i = 0; i < count; i += 1) nodes[i * 4] = DECODE_OPS.FLIPBOOK_INDEX;
    return program({
      graph: { nodes, count, result: 0, addressMode: 0 },
      latents: [],
      networks: [],
    });
  };
  const half = DECODE_NODE_CAPACITY / 2;
  expect(() => packDecodeTables([flipbooks(half), flipbooks(half)])).not.toThrow();
  expect(() => packDecodeTables([flipbooks(half), flipbooks(half + 1)])).toThrow(
    new RegExp(`more than ${DECODE_NODE_CAPACITY} decode nodes`),
  );

  const slots = (count: number) =>
    program({ latents: [latent(1, 1, 0)], constants: new Float32Array(count * 4) });
  const halfConstants = DECODE_CONSTANT_CAPACITY / 2;
  expect(() => packDecodeTables([slots(halfConstants), slots(halfConstants)])).not.toThrow();
  expect(() => packDecodeTables([slots(halfConstants), slots(halfConstants + 1)])).toThrow(
    new RegExp(`more than ${DECODE_CONSTANT_CAPACITY} constants`),
  );

  const programs = (count: number) =>
    Array.from({ length: count }, () => program({ latents: [latent(1, 1, 0)] }));
  expect(() => packDecodeTables(programs(DECODE_PROGRAM_CAPACITY))).not.toThrow();
  expect(() => packDecodeTables(programs(DECODE_PROGRAM_CAPACITY + 1))).toThrow(
    new RegExp(`${DECODE_PROGRAM_CAPACITY + 1} programs`),
  );
});
