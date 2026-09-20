/**
 * Networks built in code for the device checks: a vision transformer's encoder and a convolution
 * decoder, with seeded weights, at whatever shapes a check asks for.
 *
 * **The shapes are the upstream's and the weights are noise.** A DINOv2 encoder — patches, a class
 * token, positions, pre-norm blocks with layer scale, a last norm — is what Depth Anything and SAM's
 * image encoders are built on, and the decoder is a DPT head's steps in miniature: tokens back to an
 * image, a projection, a transposed convolution, a residual unit, an aligned resize. Seeded noise is
 * enough for both uses: a chain agrees with its reference whatever its weights are, and a kernel's
 * cost does not depend on them. What it gives up is realistic activations, which only a converted
 * checkpoint has — Task 4's to check.
 *
 * **Queries, keys and values are three multiplies**, where the upstream stores one weight for all
 * three and slices the product: the converter splits that weight once, and the runtime then copies
 * nothing to separate them.
 */
import { mulberry32 } from '../../packages/core/src/core/rng.ts';
import type {
  Attributes,
  GraphNode,
  GraphTensor,
  NetworkGraph,
} from '../../packages/texture/src/index.ts';

const size = (shape: readonly number[]): number => shape.reduce((total, d) => total * d, 1);

/** Nodes and seeded tensors, named in the order they are made. */
function builder(seed: number) {
  const next = mulberry32(seed);
  const nodes: GraphNode[] = [];
  const tensors = new Map<string, GraphTensor>();
  let count = 0;
  return {
    nodes,
    tensors,
    /** A tensor of values uniform in [centre − spread, centre + spread). */
    tensor(shape: readonly number[], spread: number, centre = 0): string {
      const name = `w${(count += 1)}`;
      const data = Float32Array.from(
        { length: size(shape) },
        () => centre + (next() * 2 - 1) * spread,
      );
      tensors.set(name, { shape, data });
      return name;
    },
    /** A node, writing a value named `output` when a graph's caller reads it by name. */
    node(
      op: string,
      inputs: readonly string[],
      attributes: Attributes = {},
      output = `v${(count += 1)}`,
    ): string {
      nodes.push({ op, inputs, output, attributes });
      return output;
    },
  };
}

export interface EncoderShape {
  /** The image's edge in pixels, a multiple of `patch`. */
  readonly image: number;
  readonly patch: number;
  readonly dim: number;
  readonly heads: number;
  readonly hidden: number;
  readonly blocks: number;
  /**
   * The position grid's edge when it differs from the image's, so it is resized first — bicubic,
   * as DINOv2 does for an image it was not trained at; omitted, positions are one tensor.
   */
  readonly positionGrid?: number;
  /** Classes read from the class token, through a softmax; omitted, there is no such head. */
  readonly classes?: number;
}

/** A DINOv2-style encoder. Its outputs are `tokens` (the patches' features) and, with a head, `classes`. */
export function vitEncoder(shape: EncoderShape, seed: number): NetworkGraph {
  const b = builder(seed);
  const { dim, patch } = shape;
  const grid = shape.image / patch;
  const tokens = grid * grid;
  const scale = (fanIn: number): number => 1 / Math.sqrt(fanIn);

  const patches = b.node(
    'patchEmbed',
    ['image', b.tensor([dim, 3, patch, patch], scale(3 * patch * patch)), b.tensor([dim], 0.1)],
    { patch },
  );
  let x = b.node('concat', [b.tensor([1, dim], 0.5), patches], { axis: 0 });
  let positions: string;
  if (shape.positionGrid === undefined) {
    positions = b.tensor([tokens + 1, dim], 0.2);
  } else {
    const g = shape.positionGrid;
    const resized = b.node('resize', [b.tensor([dim, g, g], 0.2)], {
      height: grid,
      width: grid,
      mode: 'bicubic',
      alignCorners: false,
    });
    const rows = b.node('reshape', [b.node('permute', [resized], { order: [1, 2, 0] })], {
      shape: [tokens, dim],
    });
    positions = b.node('concat', [b.tensor([1, dim], 0.2), rows], { axis: 0 });
  }
  x = b.node('add', [x, positions]);

  const norm = (value: string): string =>
    b.node('layerNorm', [value, b.tensor([dim], 0.1, 1), b.tensor([dim], 0.1)], {
      epsilon: 1e-6,
    });
  const project = (value: string, from: number, to: number): string =>
    b.node('linear', [value, b.tensor([to, from], scale(from)), b.tensor([to], 0.1)]);
  for (let block = 0; block < shape.blocks; block += 1) {
    const h = norm(x);
    const attended = b.node(
      'attention',
      [project(h, dim, dim), project(h, dim, dim), project(h, dim, dim)],
      { heads: shape.heads },
    );
    const scaled = b.node('mul', [project(attended, dim, dim), b.tensor([dim], 0.2, 0.5)]);
    x = b.node('add', [x, scaled]);
    const inner = b.node('gelu', [project(norm(x), dim, shape.hidden)]);
    const out = b.node('mul', [project(inner, shape.hidden, dim), b.tensor([dim], 0.2, 0.5)]);
    x = b.node('add', [x, out]);
  }
  const last = norm(x);
  b.node('slice', [last], { axis: 0, start: 1, end: tokens + 1 }, 'tokens');
  if (shape.classes !== undefined) {
    const cls = b.node('slice', [last], { axis: 0, start: 0, end: 1 });
    b.node('softmax', [project(cls, dim, shape.classes)], {}, 'classes');
  }
  return {
    inputs: [{ name: 'image', shape: [3, shape.image, shape.image] }],
    outputs: shape.classes === undefined ? ['tokens'] : ['tokens', 'classes'],
    nodes: b.nodes,
    tensors: b.tensors,
  };
}

/**
 * A DPT head's steps in miniature, from `tokens` of `grid × grid` patches at `dim` channels to a
 * one-channel map at twice the grid: tokens to an image, a 1×1 projection, a ×2 transposed
 * convolution, a residual unit, an aligned ×2 resize, a strided 3×3, and a 1×1 to one channel.
 */
export function convDecoder(grid: number, dim: number, width: number, seed: number): NetworkGraph {
  const b = builder(seed);
  const conv = (
    value: string,
    from: number,
    to: number,
    kernel: number,
    attributes: Attributes = {},
  ): string =>
    b.node(
      'conv2d',
      [
        value,
        b.tensor([to, from, kernel, kernel], 1 / Math.sqrt(from * kernel * kernel)),
        b.tensor([to], 0.1),
      ],
      attributes,
    );
  const image = b.node('reshape', [b.node('permute', ['tokens'], { order: [1, 0] })], {
    shape: [dim, grid, grid],
  });
  const projected = conv(image, dim, width, 1);
  const up = b.node(
    'convTranspose2d',
    [projected, b.tensor([width, width, 2, 2], 0.5), b.tensor([width], 0.1)],
    {
      stride: 2,
    },
  );
  const inner = conv(b.node('relu', [up]), width, width, 3, { padding: 1 });
  const unit = b.node('add', [up, conv(b.node('relu', [inner]), width, width, 3, { padding: 1 })]);
  const resized = b.node('resize', [unit], {
    height: 4 * grid,
    width: 4 * grid,
    mode: 'bilinear',
    alignCorners: true,
  });
  const narrowed = b.node('relu', [conv(resized, width, width / 2, 3, { padding: 1 })]);
  const strided = conv(narrowed, width / 2, width / 2, 3, { stride: 2, padding: 1 });
  b.node('relu', [conv(strided, width / 2, 1, 1)], {}, 'depth');
  return {
    inputs: [{ name: 'tokens', shape: [grid * grid, dim] }],
    outputs: ['depth'],
    nodes: b.nodes,
    tensors: b.tensors,
  };
}
