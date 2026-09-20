/** The dense operators' rows: projections, activations, normalisation, attention. */
import { attention } from './attention.ts';
import { gelu, layerNorm, sigmoid, softmax } from './linear.ts';
import { type Operator, elementwise, num, product, same, type Shape } from './operatorKit.ts';

export const DENSE_OPERATORS: readonly (readonly [string, Operator])[] = [
  [
    'linear',
    {
      ranks: [2, 2, 1],
      arity: [2, 3],
      shape: ([x, w, b]) => {
        const [rows, width] = x as Shape;
        const [outs, ins] = w as Shape;
        if (width !== ins) return `x has ${width} columns and the weight takes ${ins}`;
        if (b !== undefined && b[0] !== outs) return `the bias has ${b[0]} and the weight ${outs}`;
        return [rows as number, outs as number];
      },
      evaluate: ([x, w, b], [xs, ws], _attributes, out) => {
        const [rows, ins] = xs as Shape as [number, number];
        const outs = (ws as Shape)[0] as number;
        for (let row = 0; row < rows; row += 1) {
          for (let o = 0; o < outs; o += 1) {
            let dot = 0;
            for (let i = 0; i < ins; i += 1) {
              dot +=
                ((x as Float32Array)[row * ins + i] as number) *
                ((w as Float32Array)[o * ins + i] as number);
            }
            /* The bias joins the double-precision sum, and the result is rounded once. */
            out[row * outs + o] = dot + (b === undefined ? 0 : (b[o] as number));
          }
        }
      },
    },
  ],
  [
    'relu',
    {
      arity: [1, 1],
      shape: ([x]) => [...(x as Shape)],
      evaluate: ([x], _shapes, _attributes, out) => {
        for (let i = 0; i < out.length; i += 1)
          out[i] = Math.max(0, (x as Float32Array)[i] as number);
      },
    },
  ],
  [
    'gelu',
    {
      arity: [1, 1],
      shape: ([x]) => [...(x as Shape)],
      evaluate: ([x], _shapes, _attributes, out) => gelu(x as Float32Array, out),
    },
  ],
  [
    'sigmoid',
    {
      arity: [1, 1],
      shape: ([x]) => [...(x as Shape)],
      evaluate: ([x], _shapes, _attributes, out) => sigmoid(x as Float32Array, out),
    },
  ],
  ['add', elementwise((a, b) => a + b)],
  ['mul', elementwise((a, b) => a * b)],
  [
    'layerNorm',
    {
      ranks: [2, 1, 1],
      arity: [3, 3],
      shape: ([x, gamma]) => {
        const cols = (x as Shape)[1];
        return gamma?.[0] === cols ? [...(x as Shape)] : `gamma has ${gamma?.[0]} and x ${cols}`;
      },
      evaluate: ([x, gamma, beta], [xs], attributes, out) => {
        const [rows, cols] = xs as Shape as [number, number];
        const epsilon = num(attributes, 'epsilon', 1e-6);
        layerNorm(
          x as Float32Array,
          rows,
          cols,
          gamma as Float32Array,
          beta as Float32Array,
          epsilon,
          out,
        );
      },
    },
  ],
  [
    'softmax',
    {
      arity: [1, 1],
      shape: ([x]) => [...(x as Shape)],
      evaluate: ([x], [xs], _attributes, out) => {
        const shape = xs as Shape;
        const cols = shape[shape.length - 1] as number;
        softmax(x as Float32Array, product(shape) / cols, cols, out);
      },
    },
  ],
  [
    'attention',
    {
      /*
       * Rank 2, or 3 for a batch of windows; checked here rather than by `ranks`, which states one.
       * The bias, where there is one, is a score for each head, query and key.
       */
      arity: [3, 4],
      shape: ([q, k, v, b], attributes) => {
        const qs = q as Shape;
        const ks = k as Shape;
        if (qs.length !== 2 && qs.length !== 3)
          return `the queries have rank ${qs.length}, not 2 or 3`;
        if (ks.length !== qs.length)
          return `the keys have rank ${ks.length} and the queries ${qs.length}`;
        if (!same(ks, v as Shape)) return 'the keys and values differ in shape';
        if (qs.length === 3 && qs[0] !== ks[0]) {
          return `a batch of ${qs[0]} queries and of ${ks[0]} keys`;
        }
        const [queries, channels] = qs.slice(-2) as [number, number];
        const [keys, keyChannels] = ks.slice(-2) as [number, number];
        if (channels !== keyChannels) {
          return `the queries have ${channels} channels and the keys ${keyChannels}`;
        }
        const heads = num(attributes, 'heads', 1);
        if (channels % heads !== 0) return `${channels} channels do not split into ${heads} heads`;
        if (b !== undefined && !same(b, [heads, queries, keys])) {
          return `the bias is [${b.join(', ')}], not [${heads}, ${queries}, ${keys}]`;
        }
        return [...qs];
      },
      scratch: ([q, k]) => ((q as Shape).at(-2) as number) * ((k as Shape).at(-2) as number),
      evaluate: ([q, k, v, b], [qs, ks], attributes, out, scratch) => {
        const shape = qs as Shape;
        const [queries, channels] = shape.slice(-2) as [number, number];
        attention(
          out,
          q as Float32Array,
          k as Float32Array,
          v as Float32Array,
          queries,
          (ks as Shape).at(-2) as number,
          channels,
          num(attributes, 'heads', 1),
          scratch,
          b ?? null,
          shape.length === 3 ? (shape[0] as number) : 1,
        );
      },
    },
  ],
];
