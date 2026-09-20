import { expect, test } from 'vitest';

import { evalNetwork } from '../inference.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  graphFromStored,
  graphShapes,
  validateGraph,
  type NetworkGraph,
} from './graph.ts';

/**
 * A network as a graph of the runtime's operators.
 *
 * **The first case is the proof there is still one runtime**: a perceptron written as a graph of
 * `linear` and `relu` evaluates bit for bit as `evalNetwork` does on the same weights. The rest are
 * the ways a graph is wrong before it runs — an operator the runtime lacks, a shape that does not
 * fit — which a caller must hear about by name when the graph is loaded, not at its first frame.
 */

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
}

function values(length: number, random: () => number): Float32Array {
  return Float32Array.from({ length }, () => random());
}

test('A PERCEPTRON AS A GRAPH IS evalNetwork, BIT FOR BIT', () => {
  const random = seeded(5);
  /* 5 → 7 → 3, in evalNetwork's layout: each layer's matrix row by output, then its biases. */
  const w1 = values(35, random);
  const b1 = values(7, random);
  const w2 = values(21, random);
  const b2 = values(3, random);
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [1, 5] }],
    outputs: ['y'],
    nodes: [
      { op: 'linear', inputs: ['x', 'w1', 'b1'], output: 'h', attributes: {} },
      { op: 'relu', inputs: ['h'], output: 'a', attributes: {} },
      { op: 'linear', inputs: ['a', 'w2', 'b2'], output: 'y', attributes: {} },
    ],
    tensors: new Map([
      ['w1', { shape: [7, 5], data: w1 }],
      ['b1', { shape: [7], data: b1 }],
      ['w2', { shape: [3, 7], data: w2 }],
      ['b2', { shape: [3], data: b2 }],
    ]),
  };
  expect(validateGraph(graph)).toBe(null);
  const evaluate = createGraphEvaluator(graph);
  const packed = new Float32Array([...w1, ...b1, ...w2, ...b2]);
  const reference = new Float32Array(3);
  const scratch = new Float32Array(14);
  for (let trial = 0; trial < 50; trial += 1) {
    const x = values(5, random);
    const y = evaluate.run(new Map([['x', x]])).get('y') as Float32Array;
    evalNetwork({ inputs: 5, hidden: [7], outputs: 3 }, packed, x, reference, scratch);
    expect(Array.from(y)).toEqual(Array.from(reference));
  }
});

test('AN OPERATOR THE RUNTIME LACKS IS REFUSED AT VALIDATION, BY NAME', () => {
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [1, 4] }],
    outputs: ['y'],
    nodes: [{ op: 'swish', inputs: ['x'], output: 'y', attributes: {} }],
    tensors: new Map(),
  };
  expect(validateGraph(graph)).toMatch(/swish/);
  expect(() => createGraphEvaluator(graph)).toThrow(/swish/);
});

test('a shape that does not fit is refused at validation, naming the node', () => {
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [2, 4] }],
    outputs: ['y'],
    nodes: [{ op: 'linear', inputs: ['x', 'w', 'b'], output: 'y', attributes: {} }],
    tensors: new Map([
      ['w', { shape: [3, 5], data: new Float32Array(15) }],
      ['b', { shape: [3], data: new Float32Array(3) }],
    ]),
  };
  expect(validateGraph(graph)).toMatch(/linear.*y/);
});

test('A VALUE OF THE WRONG RANK IS REFUSED, not read as its first axes', () => {
  /*
   * Each of these fits on the axes its operator reads and has one more: a layer norm over tokens of
   * a batch, a multiply over a batch of rows, a convolution of one image with no channel axis. Read
   * as their first axes, the first two validate, declare an output, and fill part of it.
   */
  const one = (
    op: string,
    x: readonly number[],
    tensors: [string, readonly number[]][],
  ): string | null =>
    validateGraph({
      inputs: [{ name: 'x', shape: x }],
      outputs: ['y'],
      nodes: [{ op, inputs: ['x', ...tensors.map(([name]) => name)], output: 'y', attributes: {} }],
      tensors: new Map(
        tensors.map(([name, shape]) => [
          name,
          { shape, data: new Float32Array(shape.reduce((a, b) => a * b, 1)) },
        ]),
      ),
    });
  expect(
    one(
      'layerNorm',
      [2, 3, 4],
      [
        ['g', [3]],
        ['b', [3]],
      ],
    ),
  ).toMatch(/layerNorm.*y.*rank/);
  expect(one('linear', [2, 3, 4], [['w', [5, 3]]])).toMatch(/linear.*y.*rank/);
  expect(one('linear', [2, 3], [['w', [5, 3, 1]]])).toMatch(/rank/);
  expect(
    one(
      'attention',
      [1, 2, 3, 4],
      [
        ['k', [1, 2, 3, 4]],
        ['v', [1, 2, 3, 4]],
      ],
    ),
  ).toMatch(/rank/);
  expect(one('conv2d', [4, 4], [['w', [1, 1, 3, 3]]])).toMatch(/rank/);
  expect(one('convTranspose2d', [1, 4, 4], [['w', [1, 1, 3]]])).toMatch(/rank/);
  expect(one('patchEmbed', [4, 4], [['w', [2, 1, 2, 2]]])).toMatch(/rank/);
  /* And the right ranks still validate, so the refusals above are about rank alone. */
  expect(
    one(
      'layerNorm',
      [2, 3],
      [
        ['g', [3]],
        ['b', [3]],
      ],
    ),
  ).toBeNull();
  expect(one('linear', [2, 3], [['w', [5, 3]]])).toBeNull();
});

test('a resize stepped on one axis only, or stepped with aligned corners, is refused at validation', () => {
  const stepped = (attributes: Record<string, number | string | boolean>): string | null =>
    validateGraph({
      inputs: [{ name: 'x', shape: [1, 4, 4] }],
      outputs: ['y'],
      nodes: [
        {
          op: 'resize',
          inputs: ['x'],
          output: 'y',
          attributes: { height: 4, width: 4, mode: 'bicubic', ...attributes },
        },
      ],
      tensors: new Map(),
    });
  expect(stepped({ stepHeight: 1, stepWidth: 1 })).toBeNull();
  expect(stepped({ stepHeight: 1 })).toMatch(/one axis/);
  expect(stepped({ stepHeight: 1, stepWidth: 1, alignCorners: true })).toMatch(/aligned corners/);
});

test('A RESIZE NAMES ITS MODE, and a mode the runtime lacks is refused rather than run as bilinear', () => {
  const resized = (attributes: Record<string, number | string | boolean>): string | null =>
    validateGraph({
      inputs: [{ name: 'x', shape: [1, 4, 4] }],
      outputs: ['y'],
      nodes: [
        {
          op: 'resize',
          inputs: ['x'],
          output: 'y',
          attributes: { height: 8, width: 8, ...attributes },
        },
      ],
      tensors: new Map(),
    });
  expect(resized({ mode: 'nearest' })).toBeNull();
  expect(resized({ mode: 'bilinear' })).toBeNull();
  expect(resized({ mode: 'area' })).toMatch(/area/);
  expect(resized({ mode: 'nearest', alignCorners: true })).toMatch(/nearest/);
});

test('a max pool validates its window against the value it pools', () => {
  const pooled = (attributes: Record<string, number>, shape: readonly number[] = [2, 5, 7]) =>
    validateGraph({
      inputs: [{ name: 'x', shape }],
      outputs: ['y'],
      nodes: [{ op: 'maxPool2d', inputs: ['x'], output: 'y', attributes }],
      tensors: new Map(),
    });
  expect(pooled({ kernel: 2 })).toBeNull();
  expect(pooled({ kernel: 6 })).toMatch(/window/);
  expect(pooled({ kernel: 2 }, [5, 7])).toMatch(/rank/);
});

test('attention validates a batch, more keys than queries, and a bias of one score a head, query and key', () => {
  const attend = (
    q: readonly number[],
    kv: readonly number[],
    bias?: readonly number[],
    heads = 2,
  ): string | null =>
    validateGraph({
      inputs: [{ name: 'q', shape: q }],
      outputs: ['y'],
      nodes: [
        {
          op: 'attention',
          inputs: ['q', 'k', 'v', ...(bias === undefined ? [] : ['b'])],
          output: 'y',
          attributes: { heads },
        },
      ],
      tensors: new Map(
        (
          [['k', kv], ['v', kv], ...(bias === undefined ? [] : [['b', bias]])] as [
            string,
            readonly number[],
          ][]
        ).map(([name, shape]) => [
          name,
          { shape, data: new Float32Array(shape.reduce((a, b) => a * b, 1)) },
        ]),
      ),
    });
  expect(attend([3, 8], [3, 8])).toBeNull();
  expect(attend([7, 8], [49, 8], [2, 7, 49])).toBeNull();
  expect(attend([4, 7, 8], [4, 49, 8], [2, 7, 49])).toBeNull();
  expect(attend([4, 7, 8], [5, 49, 8])).toMatch(/batch/);
  expect(attend([4, 7, 8], [49, 8])).toMatch(/rank/);
  expect(attend([7, 8], [49, 6])).toMatch(/channels/);
  expect(attend([7, 8], [49, 8], [2, 49, 7])).toMatch(/bias/);
  expect(attend([7, 8], [49, 8], [1, 7, 49])).toMatch(/bias/);
  expect(attend([7, 8], [49, 8], undefined, 3)).toMatch(/3 heads/);
});

test('a grouped convolution validates only where its channels split evenly into its groups', () => {
  const grouped = (weight: readonly number[], groups?: number): string | null =>
    validateGraph({
      inputs: [{ name: 'x', shape: [4, 8, 8] }],
      outputs: ['y'],
      nodes: [
        {
          op: 'conv2d',
          inputs: ['x', 'w'],
          output: 'y',
          attributes: groups === undefined ? {} : { groups },
        },
      ],
      tensors: new Map([
        ['w', { shape: weight, data: new Float32Array(weight.reduce((a, b) => a * b, 1)) }],
      ]),
    });
  expect(grouped([4, 1, 3, 3], 4)).toBeNull();
  expect(grouped([6, 2, 3, 3], 2)).toBeNull();
  expect(grouped([4, 1, 3, 3])).toMatch(/4 channels and the weight takes 1/);
  expect(grouped([4, 2, 3, 3], 3)).toMatch(/3 groups/);
  expect(grouped([5, 2, 3, 3], 2)).toMatch(/5 outputs/);
});

test('A GRAPH GOES TO THE DEVICE WITH EVERY SHAPE AND NOTHING EVALUATED, and an invalid one is refused', () => {
  /*
   * The device's runner takes the shapes this module infers; asking an evaluator for them would
   * size every value first, which for a depth model over two views is most of a gigabyte spent on
   * a question of shapes.
   */
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [2, 3] }],
    outputs: ['y'],
    nodes: [
      { op: 'linear', inputs: ['x', 'w'], output: 'h', attributes: {} },
      { op: 'relu', inputs: ['h'], output: 'y', attributes: {} },
    ],
    tensors: new Map([['w', { shape: [4, 3], data: new Float32Array(12) }]]),
  };
  expect(graphShapes(graph)).toEqual(
    new Map<string, readonly number[]>([
      ['x', [2, 3]],
      ['w', [4, 3]],
      ['h', [2, 4]],
      ['y', [2, 4]],
    ]),
  );
  const device = graphForDevice(graph);
  expect(device.tensors).toEqual([{ name: 'w', shape: [4, 3], data: new Float32Array(12) }]);
  expect(device.shapes.get('y')).toEqual([2, 4]);
  expect(() =>
    graphShapes({
      ...graph,
      nodes: [{ op: 'fourier', inputs: ['x'], output: 'y', attributes: {} }],
    }),
  ).toThrow(/fourier/);
});

test('a value read before anything writes it is refused', () => {
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [1, 2] }],
    outputs: ['y'],
    nodes: [{ op: 'relu', inputs: ['nowhere'], output: 'y', attributes: {} }],
    tensors: new Map(),
  };
  expect(validateGraph(graph)).toMatch(/nowhere/);
});

test('the shape operators move data and nothing else', () => {
  /* [1 2 3; 4 5 6]: transposed, a row of three prepended, then its first two rows kept, flattened. */
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [2, 3] }],
    outputs: ['flat'],
    nodes: [
      { op: 'permute', inputs: ['x'], output: 't', attributes: { order: [1, 0] } },
      { op: 'concat', inputs: ['head', 't'], output: 'c', attributes: { axis: 0 } },
      { op: 'slice', inputs: ['c'], output: 's', attributes: { axis: 0, start: 0, end: 2 } },
      { op: 'reshape', inputs: ['s'], output: 'flat', attributes: { shape: [4] } },
    ],
    tensors: new Map([['head', { shape: [1, 2], data: Float32Array.from([9, 8]) }]]),
  };
  expect(validateGraph(graph)).toBe(null);
  const out = createGraphEvaluator(graph).run(
    new Map([['x', Float32Array.from([1, 2, 3, 4, 5, 6])]]),
  );
  /* Transposed: [1 4; 2 5; 3 6]. With [9 8] on top and two rows kept: [9 8; 1 4]. */
  expect(Array.from(out.get('flat') as Float32Array)).toEqual([9, 8, 1, 4]);
});

test('A PAD ADDS ZEROS AFTER THE END OF EACH AXIS, and leaves every value where it was', () => {
  /* [1 2 3; 4 5 6] padded by one row and two columns: the values keep their places. */
  const padded = (after: readonly number[]): NetworkGraph => ({
    inputs: [{ name: 'x', shape: [2, 3] }],
    outputs: ['y'],
    nodes: [{ op: 'pad', inputs: ['x'], output: 'y', attributes: { after } }],
    tensors: new Map(),
  });
  expect(validateGraph(padded([1, 2]))).toBe(null);
  const out = createGraphEvaluator(padded([1, 2])).run(
    new Map([['x', Float32Array.from([1, 2, 3, 4, 5, 6])]]),
  );
  expect(Array.from(out.get('y') as Float32Array)).toEqual([
    1, 2, 3, 0, 0, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0,
  ]);
  expect(validateGraph(padded([1]))).toMatch(/2 axes/);
  expect(validateGraph(padded([1, -1]))).toMatch(/negative/);
});

test('A GATHER TAKES A TABLE’S ROWS BY INDEX, as a token is looked up, and refuses an index that is no row', () => {
  /* Rows 2, 0, 2 of [1 2; 3 4; 5 6]: [5 6; 1 2; 5 6]. */
  const gathered: NetworkGraph = {
    inputs: [{ name: 'indices', shape: [3] }],
    outputs: ['y'],
    nodes: [{ op: 'gather', inputs: ['table', 'indices'], output: 'y', attributes: {} }],
    tensors: new Map([['table', { shape: [3, 2], data: Float32Array.from([1, 2, 3, 4, 5, 6]) }]]),
  };
  expect(validateGraph(gathered)).toBe(null);
  const run = (indices: readonly number[]): Float32Array =>
    createGraphEvaluator(gathered)
      .run(new Map([['indices', Float32Array.from(indices)]]))
      .get('y') as Float32Array;
  expect(Array.from(run([2, 0, 2]))).toEqual([5, 6, 1, 2, 5, 6]);
  expect(() => run([2, 3, 0])).toThrow(/3 at 1 is not a row of a table of 3/);
  expect(() => run([0.5, 0, 0])).toThrow(/0.5 at 0/);
  expect(() => run([0, -1, 0])).toThrow(/-1 at 1/);
});

test('add and mul broadcast a vector along the rows, as a position embedding and a layer scale do', () => {
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [2, 2] }],
    outputs: ['y'],
    nodes: [
      { op: 'mul', inputs: ['x', 'scale'], output: 'm', attributes: {} },
      { op: 'add', inputs: ['m', 'x'], output: 'y', attributes: {} },
    ],
    tensors: new Map([['scale', { shape: [2], data: Float32Array.from([10, 100]) }]]),
  };
  expect(validateGraph(graph)).toBe(null);
  const out = createGraphEvaluator(graph).run(new Map([['x', Float32Array.from([1, 2, 3, 4])]]));
  /* x·[10 100] + x: [11 202; 33 404]. */
  expect(Array.from(out.get('y') as Float32Array)).toEqual([11, 202, 33, 404]);
});

test('an input missing at run time is refused by name', () => {
  const graph: NetworkGraph = {
    inputs: [{ name: 'x', shape: [1, 2] }],
    outputs: ['y'],
    nodes: [{ op: 'relu', inputs: ['x'], output: 'y', attributes: {} }],
    tensors: new Map(),
  };
  expect(() => createGraphEvaluator(graph).run(new Map())).toThrow(/x/);
});

test('A STORED GRAPH BECOMES ONE THE RUNTIME RUNS, its half-precision bits decoded', () => {
  /* 1.0 is 0x3c00 and -2.0 is 0xc000 in half precision. */
  const graph = graphFromStored({
    inputs: [{ name: 'x', shape: [1, 2] }],
    outputs: ['y'],
    nodes: [{ op: 'linear', inputs: ['x', 'w'], output: 'y', attributes: {} }],
    tensors: [{ name: 'w', shape: [1, 2], data: Uint16Array.from([0x3c00, 0xc000]) }],
  });
  expect(Array.from(graph.tensors.get('w')?.data ?? [])).toEqual([1, -2]);
  const out = createGraphEvaluator(graph).run(new Map([['x', Float32Array.from([3, 5])]]));
  /* 3·1 + 5·(−2). */
  expect(Array.from(out.get('y') as Float32Array)).toEqual([-7]);
});

test('a stored graph naming an operator the runtime lacks is refused when it is taken, by name', () => {
  expect(() =>
    graphFromStored({
      inputs: [{ name: 'x', shape: [1, 2] }],
      outputs: ['y'],
      nodes: [{ op: 'swish', inputs: ['x'], output: 'y', attributes: {} }],
      tensors: [],
    }),
  ).toThrow(/swish/);
});
