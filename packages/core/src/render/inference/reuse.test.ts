import { expect, test } from 'vitest';

import { planReuse } from './reuse.ts';

/**
 * Which values may share a buffer — the rule the reference evaluator and the device's runner both
 * plan by.
 *
 * **A buffer is reused once nothing will read what it holds, and never while something will.** The
 * second is the property that matters: a value overwritten before its last reader reads it is a
 * network that runs, validates and answers wrongly.
 */

const chain = {
  nodes: [
    { inputs: ['x'], output: 'a' },
    { inputs: ['a'], output: 'b' },
    { inputs: ['b'], output: 'c' },
    { inputs: ['c', 'a'], output: 'd' },
    { inputs: ['d'], output: 'e' },
  ],
  held: ['x'],
  outputs: ['e'],
};
const sizes: Record<string, number> = { x: 4, a: 4, b: 100, c: 4, d: 7, e: 4 };

test('A VALUE STILL TO BE READ KEEPS ITS BUFFER, and a node never writes over its own input', () => {
  const plan = planReuse(chain, (name) => sizes[name] as number);
  const slot = (name: string): number => plan.slotOf.get(name) as number;
  /* `a` is read again by `d`, so neither `b` nor `c` may take its buffer. */
  expect(slot('b')).not.toBe(slot('a'));
  expect(slot('c')).not.toBe(slot('a'));
  for (const node of chain.nodes) {
    for (const input of node.inputs)
      expect(slot(node.output), `${node.output} over ${input}`).not.toBe(slot(input));
  }
});

test('a value nothing will read again gives its buffer back, as large as the largest it holds', () => {
  const plan = planReuse(chain, (name) => sizes[name] as number);
  /* `b` is last read by `c`, so `d` — written after — takes `b`'s buffer, at `b`'s size. */
  expect(plan.slotOf.get('d')).toBe(plan.slotOf.get('b'));
  expect(plan.sizes[plan.slotOf.get('d') as number]).toBe(100);
  expect(plan.sizes.length).toBeLessThan(chain.nodes.length + 1);
});

test('what is neither held nor written by a node is not planned, and nothing takes its buffer', () => {
  /* A weight the caller owns: it has no buffer here, and is not handed out as a free one. */
  const plan = planReuse(
    {
      nodes: [
        { inputs: ['x', 'w'], output: 'a' },
        { inputs: ['a'], output: 'b' },
        { inputs: ['b'], output: 'e' },
      ],
      held: [],
      outputs: ['e'],
    },
    () => 4,
  );
  expect(plan.slotOf.has('w')).toBe(false);
  expect(plan.slotOf.has('x')).toBe(false);
  /* Three buffers for the three values written: the two intermediates and the pinned output. */
  expect(plan.sizes.length).toBe(3);
});
