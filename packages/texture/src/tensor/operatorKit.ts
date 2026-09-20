/**
 * What every operator table shares: the shape of an operator, and the few helpers they all read
 * their attributes and shapes with.
 */
export type AttributeValue = number | string | boolean | readonly number[];
export type Attributes = Readonly<Record<string, AttributeValue>>;
export type Shape = readonly number[];

export interface Operator {
  /** How many inputs it takes, fewest and most. */
  readonly arity: readonly [number, number];
  /**
   * The rank each input must have, in order, where it matters. **Checked before `shape` runs**,
   * because an operator reading an image as `[channels, height, width]` reads a value with one more
   * axis as its first three and validates it — and then declares an output it fills only part of.
   */
  readonly ranks?: readonly number[];
  shape(inputs: readonly Shape[], attributes: Attributes): number[] | string;
  /** Scratch values it needs beyond its output, if any. */
  scratch?(inputs: readonly Shape[], attributes: Attributes): number;
  evaluate(
    inputs: readonly Float32Array[],
    shapes: readonly Shape[],
    attributes: Attributes,
    out: Float32Array,
    scratch: Float32Array,
  ): void;
}

export const num = (attributes: Attributes, name: string, fallback?: number): number => {
  const value = attributes[name];
  if (typeof value === 'number') return value;
  if (fallback !== undefined) return fallback;
  throw new RangeError(`attribute "${name}" must be a number`);
};

export const list = (attributes: Attributes, name: string): readonly number[] => {
  const value = attributes[name];
  return Array.isArray(value) ? (value as readonly number[]) : [];
};

export const same = (a: Shape, b: Shape): boolean =>
  a.length === b.length && a.every((d, i) => d === b[i]);

export const elementwise = (apply: (a: number, b: number) => number): Operator => ({
  arity: [2, 2],
  shape: ([a, b]) => {
    const x = a as Shape;
    const y = b as Shape;
    if (same(x, y) || (y.length === 1 && y[0] === x[x.length - 1])) return [...x];
    return `[${y.join(', ')}] is neither [${x.join(', ')}] nor its last dimension`;
  },
  evaluate: ([a, b], _shapes, _attributes, out) => {
    const left = a as Float32Array;
    const right = b as Float32Array;
    const n = right.length;
    for (let i = 0; i < left.length; i += 1) {
      out[i] = apply(left[i] as number, right[i % n] as number);
    }
  },
});

/* Strides of a row-major shape. */
export function strides(shape: Shape): number[] {
  const out = new Array<number>(shape.length).fill(1);
  for (let d = shape.length - 2; d >= 0; d -= 1) {
    out[d] = (out[d + 1] as number) * (shape[d + 1] as number);
  }
  return out;
}

export const product = (shape: Shape, from = 0, to = shape.length): number => {
  let total = 1;
  for (let d = from; d < to; d += 1) total *= shape[d] as number;
  return total;
};
