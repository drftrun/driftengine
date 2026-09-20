import { expect, test } from 'vitest';

import { planBuffers } from './plan.ts';

/**
 * Which buffer each value of a graph lives in on the device.
 *
 * **A buffer is reused once nothing will read what it holds, and never while something will** — the
 * second is the property that matters, because a value overwritten before its last reader reads it
 * is a network that runs, validates and answers wrongly.
 */

const chain = {
  inputs: [{ name: 'x', shape: [4] }],
  outputs: ['e'],
  nodes: [
    { op: 'relu', inputs: ['x'], output: 'a', attributes: {} },
    { op: 'relu', inputs: ['a'], output: 'b', attributes: {} },
    { op: 'relu', inputs: ['b'], output: 'c', attributes: {} },
    { op: 'add', inputs: ['c', 'a'], output: 'd', attributes: {} },
    { op: 'relu', inputs: ['d'], output: 'e', attributes: {} },
  ],
  tensors: [],
  shapes: new Map<string, readonly number[]>([
    ['x', [4]],
    ['a', [4]],
    ['b', [4]],
    ['c', [4]],
    ['d', [4]],
    ['e', [4]],
  ]),
};

test('A VALUE STILL TO BE READ KEEPS ITS BUFFER', () => {
  const plan = planBuffers(chain);
  const slot = (name: string): number => plan.slotOf.get(name) as number;
  /* `a` is read again by `d`, so neither `b` nor `c` may take its buffer. */
  expect(slot('b')).not.toBe(slot('a'));
  expect(slot('c')).not.toBe(slot('a'));
  /* And every node's output differs from each of its inputs' buffers. */
  for (const node of chain.nodes) {
    for (const input of node.inputs)
      expect(slot(node.output), `${node.output} over ${input}`).not.toBe(slot(input));
  }
});

test('a value nothing will read again gives its buffer back', () => {
  const plan = planBuffers(chain);
  const slot = (name: string): number => plan.slotOf.get(name) as number;
  /* `b` is last read by `c`, so `d` — written after — may take `b`'s buffer. */
  expect(slot('d')).toBe(slot('b'));
  /* Five intermediate values in three buffers, plus the input and the output of their own. */
  expect(plan.sizes.length).toBeLessThan(chain.nodes.length + 1);
});

test('inputs, outputs and weights are never reused', () => {
  const plan = planBuffers({
    ...chain,
    tensors: [{ name: 'w', shape: [4], data: new Float32Array(4) }],
    nodes: [
      { op: 'add', inputs: ['x', 'w'], output: 'a', attributes: {} },
      { op: 'relu', inputs: ['a'], output: 'e', attributes: {} },
    ],
    shapes: new Map([
      ['x', [4]],
      ['w', [4]],
      ['a', [4]],
      ['e', [4]],
    ]),
  });
  const slots = ['x', 'w', 'e'].map((name) => plan.slotOf.get(name));
  expect(new Set(slots).size).toBe(3);
  expect(slots).not.toContain(plan.slotOf.get('a'));
});

test('a reused buffer is as large as the largest value it ever holds', () => {
  const plan = planBuffers({
    ...chain,
    shapes: new Map<string, readonly number[]>([
      ['x', [4]],
      ['a', [4]],
      ['b', [100]],
      ['c', [4]],
      ['d', [7]],
      ['e', [4]],
    ]),
  });
  const slot = plan.slotOf.get('d') as number;
  expect(plan.sizes[slot]).toBe(100);
});
