import { expect, test } from 'vitest';

import type { DeviceGraph } from './deviceGraph.ts';
import { fuseActivations } from './fuse.ts';

/**
 * **A GELU folds into the multiply before it only when nothing else reads what the multiply wrote**
 * — the fused kernel never writes the pre-activation value, so a second reader of it would read a
 * buffer nobody filled. That is the property worth a test: a fusion taken where it may not be is a
 * network that runs and answers wrongly.
 */

const mlp = (outputs: readonly string[], extra: DeviceGraph['nodes'] = []): DeviceGraph => ({
  inputs: [{ name: 'x', shape: [2, 3] }],
  outputs,
  nodes: [
    { op: 'linear', inputs: ['x', 'w'], output: 'h', attributes: {} },
    { op: 'gelu', inputs: ['h'], output: 'g', attributes: {} },
    { op: 'relu', inputs: ['g'], output: 'y', attributes: {} },
    ...extra,
  ],
  tensors: [{ name: 'w', shape: [4, 3], data: new Float32Array(12) }],
  shapes: new Map<string, readonly number[]>([
    ['x', [2, 3]],
    ['w', [4, 3]],
    ['h', [2, 4]],
    ['g', [2, 4]],
    ['y', [2, 4]],
    ['z', [2, 4]],
  ]),
});

test('a multiply whose only reader is a GELU writes the GELU of its sum, and the GELU goes', () => {
  const fused = fuseActivations(mlp(['y']));
  expect(fused.nodes.map((node) => node.op)).toEqual(['linear', 'relu']);
  expect(fused.nodes[0]).toMatchObject({
    inputs: ['x', 'w'],
    output: 'g',
    attributes: { activation: 'gelu' },
  });
});

test('A MULTIPLY READ BY ANYTHING ELSE, OR ASKED FOR AS AN OUTPUT, IS LEFT ALONE', () => {
  const readTwice = fuseActivations(
    mlp(['y', 'z'], [{ op: 'add', inputs: ['h', 'y'], output: 'z', attributes: {} }]),
  );
  expect(readTwice.nodes.map((node) => node.op)).toEqual(['linear', 'gelu', 'relu', 'add']);
  const askedFor = fuseActivations(mlp(['y', 'h']));
  expect(askedFor.nodes.map((node) => node.op)).toEqual(['linear', 'gelu', 'relu']);
});
