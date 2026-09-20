/**
 * TinyViT as MobileSAM runs it: an image in, a 256-channel embedding at a sixteenth of its size out.
 *
 * **Four stages, the first convolutional.** A patch embedding of two strided convolutions takes the
 * image to a quarter; the first stage is inverted residual blocks, each a pointwise expansion, a
 * depthwise convolution and a pointwise projection; the other three are transformer blocks that
 * attend within windows, each followed by a depthwise convolution over the grid and an MLP. A merge
 * between stages widens the channels and halves the grid — except where the upstream keeps its
 * stride at one, which it decides by the output width and this definition takes as `mergeStrides`.
 *
 * **Every convolution carries a batch norm**, folded in at conversion by `convBatchNorm`, and the
 * transformer blocks attend within windows through `windowAttention`, which pads, partitions and
 * biases them as the upstream does. The blocks' MLP norms take PyTorch's default ε, 1e-5, and the
 * neck's channel norms 1e-6.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import { convBatchNorm } from './batchNorm.ts';
import { windowAttention } from './windowAttention.ts';

type Four = readonly [number, number, number, number];

export interface TinyVitConfig {
  readonly embedDims: Four;
  readonly depths: Four;
  /** Heads per stage; the first stage is convolutional and has none. */
  readonly heads: Four;
  readonly windows: Four;
  /** The stride of each merge between stages. */
  readonly mergeStrides: readonly [number, number, number];
  readonly mlpRatio: number;
  readonly expandRatio: number;
  /** The embedding's channels. */
  readonly neck: number;
}

const EPSILON = 1e-5;
const CHANNEL_EPSILON = 1e-6;

/** The grid the encoder's embedding has for an image `size` across. */
export function tinyVitGrid(config: TinyVitConfig, size: number): number {
  return config.mergeStrides.reduce((grid, stride) => grid / stride, size / 4);
}

/**
 * `[neck, grid, grid]` from `image`, `[3, size, size]`, normalised and padded as the upstream
 * prepares it; the embedding is written as `output`.
 */
export function tinyVit(
  weights: Weights,
  graph: GraphBuilder,
  config: TinyVitConfig,
  prefix: string,
  image: string,
  size: number,
  output: string,
): void {
  const node = graph.node.bind(graph);
  const dims = config.embedDims;
  weights.ignore(`${prefix}norm_head.`);
  weights.ignore(`${prefix}head.`);

  const convBn = (
    p: string,
    x: string,
    cin: number,
    cout: number,
    kernel: number,
    stride: number,
    groups: number,
  ): string => convBatchNorm(weights, graph, p, x, cin, cout, kernel, stride, groups);
  const gelu = (x: string): string => node('gelu', [x]);
  const tokensOf = (map: string, channels: number, cells: number): string =>
    node('permute', [node('reshape', [map], { shape: [channels, cells] })], { order: [1, 0] });
  const mapOf = (tokens: string, channels: number, rows: number, cols: number): string =>
    node('reshape', [node('permute', [tokens], { order: [1, 0] })], {
      shape: [channels, rows, cols],
    });
  const norm = (x: string, p: string, dim: number, epsilon: number): string =>
    node('layerNorm', [x, weights.read(`${p}weight`, [dim]), weights.read(`${p}bias`, [dim])], {
      epsilon,
    });
  const linear = (x: string, p: string, out: number, inputs: number): string =>
    node('linear', [x, weights.read(`${p}weight`, [out, inputs]), weights.read(`${p}bias`, [out])]);

  const merge = (p: string, map: string, dim: number, out: number, stride: number): string => {
    const expanded = gelu(convBn(`${p}conv1.`, map, dim, out, 1, 1, 1));
    const strided = gelu(convBn(`${p}conv2.`, expanded, out, out, 3, stride, out));
    return convBn(`${p}conv3.`, strided, out, out, 1, 1, 1);
  };

  let map = gelu(convBn(`${prefix}patch_embed.seq.0.`, image, 3, dims[0] / 2, 3, 2, 1));
  map = convBn(`${prefix}patch_embed.seq.2.`, map, dims[0] / 2, dims[0], 3, 2, 1);
  let grid = size / 4;
  const hidden = dims[0] * config.expandRatio;
  for (let i = 0; i < config.depths[0]; i += 1) {
    const p = `${prefix}layers.0.blocks.${i}.`;
    const inner = gelu(convBn(`${p}conv1.`, map, dims[0], hidden, 1, 1, 1));
    const spread = gelu(convBn(`${p}conv2.`, inner, hidden, hidden, 3, 1, hidden));
    map = gelu(node('add', [convBn(`${p}conv3.`, spread, hidden, dims[0], 1, 1, 1), map]));
  }
  map = merge(`${prefix}layers.0.downsample.`, map, dims[0], dims[1], config.mergeStrides[0]);
  grid /= config.mergeStrides[0];

  let tokens = tokensOf(map, dims[1], grid * grid);
  for (let stage = 1; stage < 4; stage += 1) {
    const dim = dims[stage] as number;
    const heads = config.heads[stage] as number;
    const window = config.windows[stage] as number;
    for (let i = 0; i < (config.depths[stage] as number); i += 1) {
      const p = `${prefix}layers.${stage}.blocks.${i}.`;
      const attended = node('add', [
        tokens,
        windowAttention(weights, graph, `${p}attn.`, tokens, dim, heads, window, grid, grid),
      ]);
      const local = convBn(
        `${p}local_conv.`,
        mapOf(attended, dim, grid, grid),
        dim,
        dim,
        3,
        1,
        dim,
      );
      const mixed = tokensOf(local, dim, grid * grid);
      const inner = gelu(
        linear(
          norm(mixed, `${p}mlp.norm.`, dim, EPSILON),
          `${p}mlp.fc1.`,
          dim * config.mlpRatio,
          dim,
        ),
      );
      tokens = node('add', [mixed, linear(inner, `${p}mlp.fc2.`, dim, dim * config.mlpRatio)]);
    }
    if (stage < 3) {
      const stride = config.mergeStrides[stage] as number;
      const next = dims[stage + 1] as number;
      const merged = merge(
        `${prefix}layers.${stage}.downsample.`,
        mapOf(tokens, dim, grid, grid),
        dim,
        next,
        stride,
      );
      grid /= stride;
      tokens = tokensOf(merged, next, grid * grid);
    }
  }

  /* The neck: a pointwise and a 3×3 convolution, each followed by a norm over the channels. */
  const channelNorm = (x: string, p: string, name?: string): string =>
    node(
      'reshape',
      [
        node(
          'permute',
          [norm(tokensOf(x, config.neck, grid * grid), p, config.neck, CHANNEL_EPSILON)],
          { order: [1, 0] },
        ),
      ],
      { shape: [config.neck, grid, grid] },
      name,
    );
  const pointwise = node('conv2d', [
    mapOf(tokens, dims[3], grid, grid),
    weights.read(`${prefix}neck.0.weight`, [config.neck, dims[3], 1, 1]),
  ]);
  const spatial = node(
    'conv2d',
    [
      channelNorm(pointwise, `${prefix}neck.1.`),
      weights.read(`${prefix}neck.2.weight`, [config.neck, config.neck, 3, 3]),
    ],
    { padding: 1 },
  );
  channelNorm(spatial, `${prefix}neck.3.`, output);
}
