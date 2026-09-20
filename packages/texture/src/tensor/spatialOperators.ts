/** The spatial operators' rows: convolution, its transpose, patch embedding, resizing, pooling. */
import { resize } from './resize.ts';
import { conv2d, convTranspose2d, maxPool2d, patchEmbed } from './spatial.ts';
import { type Attributes, type Operator, num, type Shape } from './operatorKit.ts';

/*
 * A resize's `stepHeight` and `stepWidth`: the source pixels one destination pixel covers, where
 * that is not the ratio of the sizes — PyTorch's interpolate handed a scale factor samples by the
 * factor's inverse, and DINOv2's positional embeddings are resized that way. Both or neither.
 */
function stepOf(attributes: Attributes): readonly [number, number] | undefined {
  const height = attributes['stepHeight'];
  const width = attributes['stepWidth'];
  return typeof height === 'number' && typeof width === 'number' ? [height, width] : undefined;
}

/* A resize's mode, bilinear when none is named, and undefined for one the runtime lacks. */
function modeOf(attributes: Attributes): 'bilinear' | 'bicubic' | 'nearest' | undefined {
  const mode = attributes['mode'] ?? 'bilinear';
  return mode === 'bilinear' || mode === 'bicubic' || mode === 'nearest' ? mode : undefined;
}

export const SPATIAL_OPERATORS: readonly (readonly [string, Operator])[] = [
  [
    'conv2d',
    {
      ranks: [3, 4, 1],
      arity: [2, 3],
      shape: ([x, w], attributes) => {
        const [c, h, width] = x as Shape as [number, number, number];
        const [o, ci, kh, kw] = w as Shape as [number, number, number, number];
        const groups = num(attributes, 'groups', 1);
        if (c % groups !== 0) return `x's ${c} channels do not split into ${groups} groups`;
        if (o % groups !== 0) return `the weight's ${o} outputs do not split into ${groups} groups`;
        if (c !== ci * groups) return `x has ${c} channels and the weight takes ${ci * groups}`;
        const stride = num(attributes, 'stride', 1);
        const padding = num(attributes, 'padding', 0);
        return [
          o,
          Math.floor((h + 2 * padding - kh) / stride) + 1,
          Math.floor((width + 2 * padding - kw) / stride) + 1,
        ];
      },
      evaluate: ([x, w, b], [xs, ws], attributes, out) => {
        const [c, h, width] = xs as Shape as [number, number, number];
        const [o, , kh, kw] = ws as Shape as [number, number, number, number];
        conv2d(
          out,
          x as Float32Array,
          c,
          h,
          width,
          w as Float32Array,
          b ?? null,
          o,
          kh,
          kw,
          num(attributes, 'stride', 1),
          num(attributes, 'padding', 0),
          num(attributes, 'groups', 1),
        );
      },
    },
  ],
  [
    'convTranspose2d',
    {
      ranks: [3, 4, 1],
      arity: [2, 3],
      shape: ([x, w], attributes) => {
        const [c, h, width] = x as Shape as [number, number, number];
        const [ci, o, kh, kw] = w as Shape as [number, number, number, number];
        if (c !== ci) return `x has ${c} channels and the weight takes ${ci}`;
        const stride = num(attributes, 'stride', 1);
        const padding = num(attributes, 'padding', 0);
        return [o, (h - 1) * stride - 2 * padding + kh, (width - 1) * stride - 2 * padding + kw];
      },
      evaluate: ([x, w, b], [xs, ws], attributes, out) => {
        const [c, h, width] = xs as Shape as [number, number, number];
        const [, o, kh, kw] = ws as Shape as [number, number, number, number];
        convTranspose2d(
          out,
          x as Float32Array,
          c,
          h,
          width,
          w as Float32Array,
          b ?? null,
          o,
          kh,
          kw,
          num(attributes, 'stride', 1),
          num(attributes, 'padding', 0),
        );
      },
    },
  ],
  [
    'patchEmbed',
    {
      ranks: [3, 4, 1],
      arity: [2, 3],
      shape: ([x, w], attributes) => {
        const [c, h, width] = x as Shape as [number, number, number];
        const [dim, ci] = w as Shape as [number, number];
        if (c !== ci) return `x has ${c} channels and the weight takes ${ci}`;
        const patch = num(attributes, 'patch');
        return [Math.floor(h / patch) * Math.floor(width / patch), dim];
      },
      evaluate: ([x, w, b], [xs, ws], attributes, out) => {
        const [c, h, width] = xs as Shape as [number, number, number];
        patchEmbed(
          out,
          x as Float32Array,
          c,
          h,
          width,
          w as Float32Array,
          b ?? null,
          (ws as Shape)[0] as number,
          num(attributes, 'patch'),
        );
      },
    },
  ],
  [
    'resize',
    {
      ranks: [3],
      arity: [1, 1],
      shape: ([x], attributes) => {
        const stepped = ['stepHeight', 'stepWidth'].filter((name) => name in attributes).length;
        if (stepped === 1) return 'a step is given for one axis and not the other';
        if (stepped === 2 && attributes['alignCorners'] === true) {
          return 'a step has no meaning with aligned corners, which fix the corners instead';
        }
        const mode = modeOf(attributes);
        if (mode === undefined)
          return `the runtime has no resize mode "${String(attributes['mode'])}"`;
        if (mode === 'nearest' && attributes['alignCorners'] === true) {
          return 'nearest has no aligned corners, as PyTorch has none';
        }
        return [(x as Shape)[0] as number, num(attributes, 'height'), num(attributes, 'width')];
      },
      evaluate: ([x], [xs], attributes, out) => {
        const [c, h, width] = xs as Shape as [number, number, number];
        const mode = modeOf(attributes) ?? 'bilinear';
        resize(
          out,
          x as Float32Array,
          c,
          h,
          width,
          num(attributes, 'height'),
          num(attributes, 'width'),
          mode,
          attributes['alignCorners'] === true,
          stepOf(attributes),
        );
      },
    },
  ],
  [
    'maxPool2d',
    {
      ranks: [3],
      arity: [1, 1],
      shape: ([x], attributes) => {
        const [c, h, w] = x as Shape as [number, number, number];
        const kernel = num(attributes, 'kernel');
        const stride = num(attributes, 'stride', kernel);
        if (kernel > h || kernel > w) return `a window of ${kernel} does not fit ${h} × ${w}`;
        return [c, Math.floor((h - kernel) / stride) + 1, Math.floor((w - kernel) / stride) + 1];
      },
      evaluate: ([x], [xs], attributes, out) => {
        const [c, h, w] = xs as Shape as [number, number, number];
        const kernel = num(attributes, 'kernel');
        maxPool2d(out, x as Float32Array, c, h, w, kernel, num(attributes, 'stride', kernel));
      },
    },
  ],
];
