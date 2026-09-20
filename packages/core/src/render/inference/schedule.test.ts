import { expect, test } from 'vitest';

import type { DeviceGraph } from './deviceGraph.ts';
import { scheduleGraph } from './schedule.ts';

/**
 * What a graph becomes before a device sees it: one dispatch per node, in the graph's order, each
 * binding its inputs' buffers and then its output's; and the weights, at the precision asked for.
 */

const block: DeviceGraph = {
  inputs: [{ name: 'x', shape: [2, 3] }],
  outputs: ['y'],
  nodes: [
    { op: 'linear', inputs: ['x', 'w', 'b'], output: 'h', attributes: {} },
    { op: 'relu', inputs: ['h'], output: 'r', attributes: {} },
    { op: 'add', inputs: ['r', 'h'], output: 'y', attributes: {} },
  ],
  tensors: [
    { name: 'w', shape: [3, 3], data: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
    { name: 'b', shape: [3], data: new Float32Array([1 + 0.75 * 2 ** -10, -2, 0.5]) },
  ],
  shapes: new Map<string, readonly number[]>([
    ['x', [2, 3]],
    ['w', [3, 3]],
    ['b', [3]],
    ['h', [2, 3]],
    ['r', [2, 3]],
    ['y', [2, 3]],
  ]),
};

test('THE DISPATCHES ARE THE GRAPH IN ITS OWN ORDER, each binding its inputs and then its output', () => {
  const schedule = scheduleGraph(block, { half: false });
  const slot = (name: string): number => schedule.plan.slotOf.get(name) as number;
  expect(schedule.steps.map((step) => step.label)).toEqual(['linear h', 'relu r', 'add y']);
  expect(schedule.steps.map((step) => step.slots)).toEqual([
    [slot('x'), slot('w'), slot('b'), slot('h')],
    [slot('h'), slot('r')],
    [slot('r'), slot('h'), slot('y')],
  ]);
});

test('at half precision the weights are stored as the nearest halves and read as half', () => {
  const schedule = scheduleGraph(block, { half: true });
  const bias = schedule.uploads.find(
    (upload) => upload.slot === schedule.plan.slotOf.get('b'),
  )?.data;
  /* 1 + three quarters of a half's step above 1 is nearer 0x3c01; −2 is 0xc000; ½ is 0x3800. */
  expect(bias).toEqual(new Uint16Array([0x3c01, 0xc000, 0x3800]));
  const linear = schedule.steps[0]?.code ?? '';
  expect(linear).toMatch(/input1: array<f16>/);
  expect(linear).toMatch(/input0: array<f32>/);
  /* Three halves are six bytes; a storage binding is sized in fours. */
  expect(schedule.bytes[schedule.plan.slotOf.get('b') as number]).toBe(8);
});

test('at single precision nothing is narrowed', () => {
  const schedule = scheduleGraph(block, { half: false });
  const bias = schedule.uploads.find(
    (upload) => upload.slot === schedule.plan.slotOf.get('b'),
  )?.data;
  expect(bias).toBeInstanceOf(Float32Array);
  expect(schedule.steps[0]?.code).not.toMatch(/f16/);
});

test('an operator the device has no kernel for is refused by name, before anything is built', () => {
  expect(() =>
    scheduleGraph(
      { ...block, nodes: [{ op: 'fourier', inputs: ['x'], output: 'y', attributes: {} }] },
      { half: false },
    ),
  ).toThrow(/fourier/);
});
