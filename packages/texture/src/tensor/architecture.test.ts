import { expect, test } from 'vitest';

import { graphFromWeights, type Architecture, type WeightSource } from './architecture.ts';
import type { GraphTensor } from './graph.ts';

/**
 * **A network's definition is a function of its weights, run twice**: once over a checkpoint, when
 * it is converted, and again over the converted file whenever the runtime needs the graph at a new
 * size — a video's aspect ratio decides a vision transformer's patch grid, and every kernel bakes
 * its shapes. So the two runs must agree about what a weight is. A weight derived at conversion — a
 * batch norm folded into its convolution — is stored under its own name and answered from the file
 * afterwards, and a table computed from the shapes is rebuilt every time and never stored as a
 * weight. And each run reads every weight its source holds, or sets it aside by name: a forgotten
 * bias is a network that runs and answers wrongly.
 */

function source(entries: Readonly<Record<string, GraphTensor>>): WeightSource {
  return {
    get: (name) => entries[name],
    names: () => Object.keys(entries),
  };
}

const t = (shape: readonly number[], ...values: number[]): GraphTensor => ({
  shape,
  data: Float32Array.from(values),
});

/* `y = x·wᵀ + b` over a checkpoint holding `w` and `b`. */
const layer: Architecture = (weights, graph) => {
  graph.node('linear', ['x', weights.read('w', [2, 2]), weights.read('b', [2])], {}, 'y');
  return { inputs: [{ name: 'x', shape: [1, 2] }], outputs: ['y'] };
};

test('A WEIGHT THE DEFINITION NAMES AND THE SOURCE LACKS IS REFUSED BY ITS NAME, and one at another shape names both', () => {
  expect(() => graphFromWeights(source({ w: t([2, 2], 1, 2, 3, 4) }), layer)).toThrow(
    /no weight "b"/,
  );
  expect(() =>
    graphFromWeights(source({ w: t([1, 4], 1, 2, 3, 4), b: t([2], 0, 0) }), layer),
  ).toThrow(/"w" is \[1, 4\].*\[2, 2\]/);
});

test('A WEIGHT THE SOURCE HOLDS AND THE DEFINITION NEVER READS IS REFUSED, unless set aside', () => {
  const held = source({ w: t([2, 2], 1, 2, 3, 4), b: t([2], 0, 0), head: t([1], 7) });
  expect(() => graphFromWeights(held, layer)).toThrow(/never reads "head"/);
  const aside: Architecture = (weights, graph) => {
    weights.ignore('head');
    return layer(weights, graph);
  };
  expect([...graphFromWeights(held, aside).tensors.keys()].sort()).toEqual(['b', 'w']);
});

test('A DERIVED WEIGHT IS COMPUTED ONCE, and the converted file answers for it afterwards', () => {
  /* A scale folded into a weight: `folded = w · s`, so the file holds `folded` and neither part. */
  let computed = 0;
  const folding: Architecture = (weights, graph) => {
    const folded = weights.derive('folded', [2, 2], (values) => {
      computed += 1;
      const w = values('w', [2, 2]);
      const s = values('s', [2]);
      return w.map((value, i) => value * (s[Math.floor(i / 2)] as number));
    });
    graph.node('linear', ['x', folded], {}, 'y');
    return { inputs: [{ name: 'x', shape: [1, 2] }], outputs: ['y'] };
  };
  const converted = graphFromWeights(
    source({ w: t([2, 2], 1, 2, 3, 4), s: t([2], 10, 100) }),
    folding,
  );
  expect(computed).toBe(1);
  expect([...converted.tensors.keys()]).toEqual(['folded']);
  expect(Array.from(converted.tensors.get('folded')?.data ?? [])).toEqual([10, 20, 300, 400]);
  /* Rebuilt over the converted file, which holds only `folded`: nothing is computed again. */
  const rebuilt = graphFromWeights(
    { get: (name) => converted.tensors.get(name), names: () => converted.tensors.keys() },
    folding,
  );
  expect(computed).toBe(1);
  expect(Array.from(rebuilt.tensors.get('folded')?.data ?? [])).toEqual([10, 20, 300, 400]);
});

test('a constant is rebuilt with the graph, and a file holding an older one is not refused for it', () => {
  /* Two runs at two sizes, as a table of positions would be: the second's constant is its own. */
  const sized =
    (value: number): Architecture =>
    (weights, graph) => {
      graph.node(
        'add',
        ['x', weights.constant('offset', [2], Float32Array.of(value, value))],
        {},
        'y',
      );
      return { inputs: [{ name: 'x', shape: [2] }], outputs: ['y'] };
    };
  const first = graphFromWeights(source({}), sized(1));
  const constant = [...first.tensors.keys()][0] as string;
  expect(constant.startsWith('@')).toBe(true);
  const second = graphFromWeights(
    { get: (name) => first.tensors.get(name), names: () => first.tensors.keys() },
    sized(2),
  );
  expect(Array.from(second.tensors.get(constant)?.data ?? [])).toEqual([2, 2]);
});
