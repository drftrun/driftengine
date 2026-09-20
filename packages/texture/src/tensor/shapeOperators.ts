/** The shape operators' rows: they move values and compute nothing. */
import { type Operator, list, num, product, strides, type Shape } from './operatorKit.ts';

export const SHAPE_OPERATORS: readonly (readonly [string, Operator])[] = [
  [
    'permute',
    {
      arity: [1, 1],
      shape: ([x], attributes) => {
        const order = list(attributes, 'order');
        const shape = x as Shape;
        const valid =
          order.length === shape.length &&
          [...order].sort((p, q) => p - q).every((d, i) => d === i);
        return valid
          ? order.map((d) => shape[d] as number)
          : `order [${order.join(', ')}] is not a permutation of ${shape.length} axes`;
      },
      evaluate: ([x], [xs], attributes, out) => {
        const shape = xs as Shape;
        const order = list(attributes, 'order');
        const from = strides(shape);
        const to = order.map((d) => shape[d] as number);
        const index = new Array<number>(shape.length).fill(0);
        for (let at = 0; at < out.length; at += 1) {
          let source = 0;
          for (let d = 0; d < order.length; d += 1)
            source += (index[d] as number) * (from[order[d] as number] as number);
          out[at] = (x as Float32Array)[source] as number;
          for (let d = order.length - 1; d >= 0; d -= 1) {
            index[d] = (index[d] as number) + 1;
            if ((index[d] as number) < (to[d] as number)) break;
            index[d] = 0;
          }
        }
      },
    },
  ],
  [
    'reshape',
    {
      arity: [1, 1],
      shape: ([x], attributes) => {
        const shape = list(attributes, 'shape');
        return product(shape) === product(x as Shape)
          ? [...shape]
          : `[${shape.join(', ')}] does not hold [${(x as Shape).join(', ')}]`;
      },
      evaluate: ([x], _shapes, _attributes, out) => out.set(x as Float32Array),
    },
  ],
  [
    'concat',
    {
      arity: [2, 16],
      shape: (inputs, attributes) => {
        const axis = num(attributes, 'axis');
        const first = inputs[0] as Shape;
        let along = 0;
        for (const shape of inputs) {
          if (shape.length !== first.length || shape.some((d, i) => i !== axis && d !== first[i])) {
            return `inputs differ off axis ${axis}`;
          }
          along += shape[axis] as number;
        }
        return first.map((d, i) => (i === axis ? along : d));
      },
      evaluate: (inputs, shapes, attributes, out) => {
        const axis = num(attributes, 'axis');
        const first = shapes[0] as Shape;
        const outer = product(first, 0, axis);
        let at = 0;
        for (let o = 0; o < outer; o += 1) {
          for (let i = 0; i < inputs.length; i += 1) {
            const block = product(shapes[i] as Shape, axis);
            out.set((inputs[i] as Float32Array).subarray(o * block, (o + 1) * block), at);
            at += block;
          }
        }
      },
    },
  ],
  [
    'slice',
    {
      arity: [1, 1],
      shape: ([x], attributes) => {
        const axis = num(attributes, 'axis');
        const start = num(attributes, 'start');
        const end = num(attributes, 'end');
        const shape = x as Shape;
        return start >= 0 && end <= (shape[axis] as number) && start < end
          ? shape.map((d, i) => (i === axis ? end - start : d))
          : `[${start}, ${end}) is outside axis ${axis} of length ${shape[axis]}`;
      },
      evaluate: ([x], [xs], attributes, out) => {
        const axis = num(attributes, 'axis');
        const start = num(attributes, 'start');
        const end = num(attributes, 'end');
        const shape = xs as Shape;
        const inner = product(shape, axis + 1);
        const outer = product(shape, 0, axis);
        const length = shape[axis] as number;
        const take = (end - start) * inner;
        for (let o = 0; o < outer; o += 1) {
          const from = (o * length + start) * inner;
          out.set((x as Float32Array).subarray(from, from + take), o * take);
        }
      },
    },
  ],
  [
    /*
     * Zeros after the end of each axis, `after[axis]` of them, as a window partition pads a grid it
     * does not divide. Every value keeps its index along every axis.
     */
    'pad',
    {
      arity: [1, 1],
      shape: ([x], attributes) => {
        const after = list(attributes, 'after');
        const shape = x as Shape;
        if (after.length !== shape.length) {
          return `the pad names ${after.length} axes and the value has ${shape.length} axes`;
        }
        if (after.some((d) => d < 0)) return `a pad of [${after.join(', ')}] is negative`;
        return shape.map((d, i) => d + (after[i] as number));
      },
      evaluate: ([x], [xs], attributes, out) => {
        const shape = xs as Shape;
        const after = list(attributes, 'after');
        const outShape = shape.map((d, i) => d + (after[i] as number));
        const from = strides(shape);
        const to = strides(outShape);
        out.fill(0);
        const values = x as Float32Array;
        for (let i = 0; i < values.length; i += 1) {
          let at = 0;
          for (let axis = 0; axis < shape.length; axis += 1) {
            at +=
              (Math.floor(i / (from[axis] as number)) % (shape[axis] as number)) *
              (to[axis] as number);
          }
          out[at] = values[i] as number;
        }
      },
    },
  ],
  [
    /*
     * Rows of a table by index, as a token's embedding is looked up: `indices` holds whole numbers
     * as values, and row i of the output is row `indices[i]` of the table. An index that is not one
     * of the table's rows is refused here; a device cannot refuse, and clamps it to the last row.
     */
    'gather',
    {
      ranks: [2, 1],
      arity: [2, 2],
      shape: ([table, indices]) => [(indices as Shape)[0] as number, (table as Shape)[1] as number],
      evaluate: ([table, indices], [ts], _attributes, out) => {
        const [rows, width] = ts as Shape as [number, number];
        const at = indices as Float32Array;
        for (let i = 0; i < at.length; i += 1) {
          const row = at[i] as number;
          if (!Number.isInteger(row) || row < 0 || row >= rows) {
            throw new RangeError(`gather: index ${row} at ${i} is not a row of a table of ${rows}`);
          }
          out.set((table as Float32Array).subarray(row * width, (row + 1) * width), i * width);
        }
      },
    },
  ],
];
