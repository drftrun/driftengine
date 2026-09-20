import { expect, test } from 'vitest';
import { readDrft, writeDrft } from '@driftengine/drft';
import {
  createGraphEvaluator,
  evalNetwork,
  graphFromStored,
  halfWeights,
  roundHalf,
} from '@driftengine/texture';

/**
 * **A graph written into the container and read back is the network it was**, held here because
 * this package imports both: `@driftengine/drft` stores a graph without knowing what an operator is,
 * and `@driftengine/texture` evaluates one without knowing what a file is. A perceptron goes through
 * a whole `.drft` at half precision and evaluates as `evalNetwork` does on the same half-rounded
 * weights — the seam a transposed tensor or a mis-decoded half would open.
 */
test('a perceptron through a whole file, at half precision, evaluates as the runtime does', () => {
  const w1 = Float32Array.from([0.5, -0.25, 1, 0.75, -1, 0.125]);
  const b1 = Float32Array.from([0.1, -0.2, 0.3]);
  const w2 = Float32Array.from([1, -0.5, 0.25]);
  const b2 = Float32Array.from([0.05]);
  const file = writeDrft({
    meshes: [],
    graphs: [
      {
        role: 'TEST',
        inputs: [{ name: 'x', shape: [1, 2] }],
        outputs: ['y'],
        nodes: [
          { op: 'linear', inputs: ['x', 'w1', 'b1'], output: 'h', attributes: {} },
          { op: 'relu', inputs: ['h'], output: 'a', attributes: {} },
          { op: 'linear', inputs: ['a', 'w2', 'b2'], output: 'y', attributes: {} },
        ],
        tensors: [
          { name: 'w1', shape: [3, 2], data: halfWeights(w1) },
          { name: 'b1', shape: [3], data: halfWeights(b1) },
          { name: 'w2', shape: [1, 3], data: halfWeights(w2) },
          { name: 'b2', shape: [1], data: halfWeights(b2) },
        ],
      },
    ],
  });
  const stored = readDrft(file).graphs[0];
  expect(stored?.role).toBe('TEST');
  const graph = graphFromStored(stored as NonNullable<typeof stored>);
  const run = createGraphEvaluator(graph);
  /*
   * The same weights, rounded to half and back on their own — not read out of the graph under
   * test, which would agree with a graph that never decoded its bits at all.
   */
  const rounded = Float32Array.from([...w1, ...b1, ...w2, ...b2], (value) => roundHalf(value));
  expect(rounded.length).toBe(13);
  const reference = new Float32Array(1);
  for (const x of [
    [0.5, 0.25],
    [-1, 2],
    [3, -0.5],
  ]) {
    const input = Float32Array.from(x);
    const y = run.run(new Map([['x', input]])).get('y') as Float32Array;
    evalNetwork(
      { inputs: 2, hidden: [3], outputs: 1 },
      rounded,
      input,
      reference,
      new Float32Array(8),
    );
    expect(Array.from(y)).toEqual(Array.from(reference));
  }
});
