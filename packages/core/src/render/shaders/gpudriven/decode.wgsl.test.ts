import { expect, test } from 'vitest';
import {
  ADDRESS_MODE_COUNT,
  DECODE_OP,
  MAX_REGISTERS,
  REMAP_SEMANTICS,
} from '@driftengine/texture';

import { networkWgsl } from '../network.wgsl.ts';
import {
  DECODE_ADDRESS_MODES,
  DECODE_CONSTANT_CAPACITY,
  DECODE_NETWORK_CAPACITY,
  DECODE_NODE_CAPACITY,
  DECODE_NODES_BYTES,
  DECODE_OPS,
  DECODE_PARITY_WGSL,
  DECODE_PROGRAM_CAPACITY,
  DECODE_REGISTERS,
  DECODE_SEMANTICS,
  DECODE_WEIGHT_BLOCKS,
  DECODE_WEIGHTS_BYTES,
  DECODE_WGSL,
  decodeResourcesWgsl,
} from './decode.wgsl.ts';

/**
 * **What this file is for: core may not import `@driftengine/texture`, so the vocabulary is
 * written twice and this is what keeps the copies equal.** `drft/src/dtex.ts` has the same
 * arrangement with `DTEX_REGISTERS`. A rule that cannot be shared as code is shared as a test.
 */

test('THE DEVICE SPEAKS THE SAME VOCABULARY AS THE REFERENCE, opcode for opcode', () => {
  expect({ ...DECODE_OPS }).toEqual({ ...DECODE_OP });
  expect(DECODE_REGISTERS).toBe(MAX_REGISTERS);
  expect(DECODE_ADDRESS_MODES).toBe(ADDRESS_MODE_COUNT);
  expect([...DECODE_SEMANTICS]).toEqual([...REMAP_SEMANTICS]);
});

test('both tables fit the uniform binding every WebGPU device offers', () => {
  expect(DECODE_NODES_BYTES).toBe(
    (DECODE_PROGRAM_CAPACITY + DECODE_NETWORK_CAPACITY * 2 + DECODE_NODE_CAPACITY) * 16,
  );
  expect(DECODE_WEIGHTS_BYTES).toBe((DECODE_WEIGHT_BLOCKS + DECODE_CONSTANT_CAPACITY) * 16);
  expect(DECODE_NODES_BYTES).toBeLessThanOrEqual(65536);
  expect(DECODE_WEIGHTS_BYTES).toBeLessThanOrEqual(65536);
});

test('the declarations carry the capacities and the bindings they were asked for', () => {
  const wgsl = decodeResourcesWgsl({
    group: 0,
    nodes: 21,
    weights: 22,
    latents: 23,
    clampSampler: 24,
    repeatSampler: 25,
  });
  for (const expected of [
    `array<vec4<u32>, ${DECODE_PROGRAM_CAPACITY}>`,
    `array<vec4<u32>, ${DECODE_NETWORK_CAPACITY * 2}>`,
    `array<vec4<u32>, ${DECODE_NODE_CAPACITY}>`,
    `array<vec4<f32>, ${DECODE_WEIGHT_BLOCKS}>`,
    `array<vec4<f32>, ${DECODE_CONSTANT_CAPACITY}>`,
    '@group(0) @binding(21) var<uniform> decodeNodes',
    '@group(0) @binding(22) var<uniform> decodeWeights',
    '@group(0) @binding(23) var decodeLatents: texture_2d_array<f32>',
    '@group(0) @binding(24) var decodeClampSampler: sampler',
    '@group(0) @binding(25) var decodeRepeatSampler: sampler',
  ]) {
    expect(wgsl).toContain(expected);
  }
  expect(wgsl).not.toContain('`');
});

test('the interpreter handles every operation the vocabulary has, and nothing else', () => {
  for (const op of Object.values(DECODE_OPS)) {
    expect(DECODE_WGSL, `opcode ${op}`).toMatch(new RegExp(`case ${op}u[,:]|, ${op}u:`));
  }
  expect(DECODE_WGSL).toContain(
    'fn decodeProgram(program: u32, uv: vec2<f32>, lod: f32, t: f32) -> vec4<f32>',
  );
  expect(DECODE_WGSL).not.toContain('`');
  expect(DECODE_PARITY_WGSL).toContain('fn decodeLatentSize() -> f32');
});

test('THE INTERPRETER EVALUATES ITS NETWORKS WITH THE ONE EVALUATOR, not a copy of it', () => {
  /*
   * A weighted sum inside a loop is the evaluator's signature, and it appears exactly as many times
   * as the shared text has it. A second copy of the loop here would be a second set of numerical
   * conventions — the thing `inference.ts` names as what this engine refuses — and would add to
   * the count.
   */
  const signature = /current\[i\] \* \w+Weight\(/g;
  const shared = networkWgsl({ name: 'decodeNet', scalar: 'f32', width: 16, hidden: 2 });
  expect((DECODE_WGSL.match(signature) ?? []).length).toBe((shared.match(signature) ?? []).length);
  expect(DECODE_WGSL).toContain(shared);
  expect(DECODE_WGSL).toContain('fn decodeNetWeight(index: u32) -> f32');
});
