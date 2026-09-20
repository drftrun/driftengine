/**
 * Hiera and its feature pyramid, as SAM 2 runs them: an image in, three levels of features out.
 *
 * **Four stages of transformer blocks over a shrinking grid.** A 7×7 convolution at stride 4 takes
 * the image to a quarter; each later stage's first block halves the grid by pooling its queries 2×2
 * — within each window for attention, and over the whole grid for the residual, which a projection
 * widens — so attention reads every key and writes a quarter as many queries. Blocks attend within
 * windows, padded with zeros after the block's norm where the window does not divide the grid, and
 * the blocks the configuration names attend over the whole grid instead. A first block partitions by
 * the previous stage's window and unpartitions by half of it.
 *
 * **The positional embedding is computed in the graph, from its two weights**: a table resized
 * bicubically to the grid, plus a window's table tiled across it. Laid out at conversion it would be
 * 12.6 MB of the file at half precision; computed, it costs two permutes a run.
 *
 * **The pyramid runs top-down only into the levels the configuration names**: each stage's output is
 * projected to the pyramid's width, and a named level adds the level above it doubled by nearest
 * resizing. The two finest levels are then narrowed by the mask decoder's own projections, as the
 * upstream's `get_image_features` narrows them once rather than on every prompt. Norms take ε 1e-6.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import { hieraAttention } from './hieraAttention.ts';

type Four = readonly [number, number, number, number];

export interface HieraConfig {
  readonly dims: Four;
  readonly blocks: Four;
  readonly heads: Four;
  readonly windows: Four;
  /** Block indices, counted across stages, that attend over the whole grid. */
  readonly global: readonly number[];
  /** The positional table's trained size, square. */
  readonly background: number;
  readonly mlpRatio: number;
  /** The pyramid's width, and the levels (by stage) that take the level above them. */
  readonly fpn: number;
  readonly topDown: readonly number[];
}

export interface HieraOutput {
  /** `[fpn, grid, grid]` at a sixteenth of the image: the features the decoder and memory read. */
  readonly features: string;
  /** `[fpn / 4, 2·grid, 2·grid]` and `[fpn / 8, 4·grid, 4·grid]`: the decoder's skips, narrowed. */
  readonly high1: string;
  readonly high0: string;
}

const EPSILON = 1e-6;

/**
 * The encoder over `image`, `[3, size, size]` normalised as the upstream prepares it, writing its
 * three outputs under the names given.
 */
export function hiera(
  weights: Weights,
  graph: GraphBuilder,
  config: HieraConfig,
  image: string,
  size: number,
  names: HieraOutput,
): void {
  const node = graph.node.bind(graph);
  const b = 'vision_encoder.backbone.';
  const read = weights.read.bind(weights);
  const linear = (x: string, p: string, out: number, inputs: number): string =>
    node('linear', [x, read(`${p}weight`, [out, inputs]), read(`${p}bias`, [out])]);
  const norm = (x: string, p: string, dim: number): string =>
    node('layerNorm', [x, read(`${p}weight`, [dim]), read(`${p}bias`, [dim])], {
      epsilon: EPSILON,
    });

  /* The patch embedding, then the positions, both channel-major. */
  const [d0] = config.dims;
  let grid = size / 4;
  const patches = node(
    'conv2d',
    [
      image,
      read(`${b}patch_embed.projection.weight`, [d0, 3, 7, 7]),
      read(`${b}patch_embed.projection.bias`, [d0]),
    ],
    { stride: 4, padding: 3 },
  );
  const window0 = config.windows[0];
  const tiles = grid / window0;
  const background = node(
    'resize',
    [
      node('reshape', [read(`${b}pos_embed`, [1, d0, config.background, config.background])], {
        shape: [d0, config.background, config.background],
      }),
    ],
    { height: grid, width: grid, mode: 'bicubic', alignCorners: false },
  );
  /* The window's table added to every tile: tiles to the leading axes, the window to the last. */
  const byTile = node(
    'reshape',
    [
      node(
        'permute',
        [node('reshape', [background], { shape: [d0, tiles, window0, tiles, window0] })],
        { order: [1, 3, 0, 2, 4] },
      ),
    ],
    { shape: [tiles * tiles, d0 * window0 * window0] },
  );
  const window = node('reshape', [read(`${b}pos_embed_window`, [1, d0, window0, window0])], {
    shape: [d0 * window0 * window0],
  });
  const positions = node(
    'reshape',
    [
      node(
        'permute',
        [
          node('reshape', [node('add', [byTile, window])], {
            shape: [tiles, tiles, d0, window0, window0],
          }),
        ],
        { order: [2, 0, 3, 1, 4] },
      ),
    ],
    { shape: [d0, grid, grid] },
  );
  const embedded = node('add', [patches, positions]);
  /* Tokens, row by row, `[grid · grid, dim]`, from here to the pyramid. */
  let x = node('permute', [node('reshape', [embedded], { shape: [d0, grid * grid] })], {
    order: [1, 0],
  });

  const pooled = (tokens: string, rows: number, dim: number): string => {
    const map = node('reshape', [node('permute', [tokens], { order: [1, 0] })], {
      shape: [dim, rows, rows],
    });
    const pool = node('maxPool2d', [map], { kernel: 2 });
    return node('permute', [node('reshape', [pool], { shape: [dim, (rows / 2) * (rows / 2)] })], {
      order: [1, 0],
    });
  };

  const outputs: string[] = [];
  let index = 0;
  for (let stage = 0; stage < 4; stage += 1) {
    for (let block = 0; block < (config.blocks[stage] as number); block += 1) {
      const p = `${b}blocks.${index}.`;
      const first = stage > 0 && block === 0;
      const dim = first ? (config.dims[stage - 1] as number) : (config.dims[stage] as number);
      const out = config.dims[stage] as number;
      const heads = config.heads[stage] as number;
      const side = config.global.includes(index)
        ? 0
        : first
          ? (config.windows[stage - 1] as number)
          : (config.windows[stage] as number);
      const normed = norm(x, `${p}layer_norm1.`, dim);
      const residual = first ? pooled(linear(normed, `${p}proj.`, out, dim), grid, out) : x;
      const attended = hieraAttention(
        weights,
        graph,
        p,
        normed,
        grid,
        dim,
        out,
        heads,
        side,
        first,
      );
      if (first) grid /= 2;
      x = node('add', [residual, attended]);
      const hidden = node('gelu', [
        linear(norm(x, `${p}layer_norm2.`, out), `${p}mlp.proj_in.`, out * config.mlpRatio, out),
      ]);
      x = node('add', [x, linear(hidden, `${p}mlp.proj_out.`, out, out * config.mlpRatio)]);
      index += 1;
    }
    outputs.push(x);
  }

  /* The pyramid, coarsest first: each stage projected, and a named level adding the one above. */
  const n = 3;
  const sides = [size / 4, size / 8, size / 16, size / 32];
  const levels: string[] = [];
  let previous = '';
  for (let i = n; i >= 0; i -= 1) {
    const p = `vision_encoder.neck.convs.${n - i}.`;
    const channels = config.dims[i] as number;
    const side = sides[i] as number;
    const map = node('reshape', [node('permute', [outputs[i] as string], { order: [1, 0] })], {
      shape: [channels, side, side],
    });
    const down = config.topDown.includes(i) && i !== n;
    const name = i === 2 ? names.features : undefined;
    let lateral = node(
      'conv2d',
      [map, read(`${p}weight`, [config.fpn, channels, 1, 1]), read(`${p}bias`, [config.fpn])],
      {},
      down ? undefined : name,
    );
    if (down) {
      const above = node('resize', [previous], { height: side, width: side, mode: 'nearest' });
      lateral = node('add', [lateral, above], {}, name);
    }
    previous = lateral;
    levels[i] = lateral;
  }
  const d = 'mask_decoder.';
  node(
    'conv2d',
    [
      levels[0] as string,
      read(`${d}conv_s0.weight`, [config.fpn / 8, config.fpn, 1, 1]),
      read(`${d}conv_s0.bias`, [config.fpn / 8]),
    ],
    {},
    names.high0,
  );
  node(
    'conv2d',
    [
      levels[1] as string,
      read(`${d}conv_s1.weight`, [config.fpn / 4, config.fpn, 1, 1]),
      read(`${d}conv_s1.bias`, [config.fpn / 4]),
    ],
    {},
    names.high1,
  );
  /* The coarsest level feeds the one below and is not itself an output, as the upstream keeps three. */
}
