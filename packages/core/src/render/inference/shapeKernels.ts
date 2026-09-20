/**
 * The shape operators on the device: they move values and compute nothing, or write a zero.
 *
 * **Each is a copy, one invocation per output element**, with the index arithmetic baked from the
 * shapes. `reshape` is a copy too rather than an alias of its input's buffer: aliasing would make
 * two values share a buffer and the planner's rule — a buffer is reused once nothing reads what it
 * holds — would have to follow aliases, which is a second rule for one saving the size of a copy.
 */
import { type KernelGenerator, list, num, perElement, read, size } from './kernelKit.ts';

/* Strides of a row-major shape. */
function strides(shape: readonly number[]): number[] {
  const out = shape.map(() => 1);
  for (let d = shape.length - 2; d >= 0; d -= 1)
    out[d] = (out[d + 1] as number) * (shape[d + 1] as number);
  return out;
}

const permute: KernelGenerator = (request) => {
  const input = request.inputShapes[0] as readonly number[];
  const order = list(request.attributes, 'order');
  const from = strides(input);
  const outStrides = strides(request.outputShape);
  /* Output axis d walks input axis order[d]: its index times that axis's input stride. */
  const terms = order.map(
    (axis, d) =>
      `((i / ${outStrides[d]}u) % ${request.outputShape[d]}u) * ${from[axis as number]}u`,
  );
  return perElement(
    request,
    size(request.outputShape),
    `  output[i] = ${read(request, 0, terms.join(' + ') || '0u')};`,
  );
};

const reshape: KernelGenerator = (request) =>
  perElement(request, size(request.outputShape), `  output[i] = ${read(request, 0, 'i')};`);

const concat: KernelGenerator = (request) => {
  const axis = num(request.attributes, 'axis');
  const out = request.outputShape;
  const inner = size(out.slice(axis + 1));
  const along = out[axis] as number;
  /* Walk the inputs along the axis: each owns a run of it, starting where the one before ended. */
  let start = 0;
  const branches = request.inputShapes.map((shape, n) => {
    const length = shape[axis] as number;
    const branch = `if (a < ${start + length}u) { output[i] = ${read(request, n, `(outer * ${length}u + a - ${start}u) * ${inner}u + rest`)}; return; }`;
    start += length;
    return branch;
  });
  return perElement(
    request,
    size(out),
    `  let rest = i % ${inner}u;
  let a = (i / ${inner}u) % ${along}u;
  let outer = i / ${inner * along}u;
  ${branches.join('\n  ')}`,
  );
};

const slice: KernelGenerator = (request) => {
  const axis = num(request.attributes, 'axis');
  const begin = num(request.attributes, 'start');
  const input = request.inputShapes[0] as readonly number[];
  const inner = size(input.slice(axis + 1));
  const length = input[axis] as number;
  const taken = request.outputShape[axis] as number;
  return perElement(
    request,
    size(request.outputShape),
    `  let rest = i % ${inner}u;
  let a = (i / ${inner}u) % ${taken}u;
  let outer = i / ${inner * taken}u;
  output[i] = ${read(request, 0, `(outer * ${length}u + a + ${begin}u) * ${inner}u + rest`)};`,
  );
};

/* An output element past the input's end on any axis is a zero; the rest read their own index. */
const pad: KernelGenerator = (request) => {
  const input = request.inputShapes[0] as readonly number[];
  const from = strides(input);
  const to = strides(request.outputShape);
  const at = (axis: number): string => `((i / ${to[axis]}u) % ${request.outputShape[axis]}u)`;
  const inside = input.map((d, axis) => `${at(axis)} < ${d}u`).join(' && ');
  const index = input.map((_, axis) => `${at(axis)} * ${from[axis]}u`).join(' + ');
  return perElement(
    request,
    size(request.outputShape),
    `  if (${inside}) { output[i] = ${read(request, 0, index)}; } else { output[i] = 0.0; }`,
  );
};

/* Row `indices[r]` of the table, clamped to the last row, since a device cannot refuse an index. */
const gather: KernelGenerator = (request) => {
  const [rows, width] = request.inputShapes[0] as readonly number[] as [number, number];
  return perElement(
    request,
    size(request.outputShape),
    `  let row = min(u32(${read(request, 1, `i / ${width}u`)}), ${rows - 1}u);
  output[i] = ${read(request, 0, `row * ${width}u + i % ${width}u`)};`,
  );
};

export const SHAPE_KERNELS: readonly (readonly [string, KernelGenerator])[] = [
  ['permute', permute],
  ['reshape', reshape],
  ['concat', concat],
  ['slice', slice],
  ['pad', pad],
  ['gather', gather],
];
