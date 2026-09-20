/**
 * SAM's mask decoder: an image embedding and a prompt's tokens in, masks and their predicted
 * quality out — MobileSAM's, and the original SAM's, which share it.
 *
 * **A two-way transformer** (`twoWay.ts`, under the original's names) over the prompt's tokens,
 * behind a learned token for the quality estimate and one per mask, and the image with its dense
 * prompt added.
 *
 * **Masks come from a product, not a convolution**: the image is upsampled four times by two
 * transposed convolutions, and each mask token, through an MLP of its own, becomes a vector that
 * is dotted with every upsampled pixel. The first mask is the one to take for an unambiguous
 * prompt, and the other three for an ambiguous one, as the upstream's `multimask_output` chooses.
 *
 * **Every prompt weight is read, whether this graph's nodes use it or not**: the prompt's tokens
 * are made on the host from the Fourier weights, and the mask input's downscaling is only in the
 * graph that takes one — but the converted file is built from one graph, and each has to find
 * every weight the others need in it.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import { samGridPositions } from './samPrompt.ts';
import { SAM_NAMES, twoWay } from './twoWay.ts';

export interface SamDecoderConfig {
  readonly dim: number;
  readonly heads: number;
  readonly mlp: number;
  readonly depth: number;
  /** The width attention between tokens and image narrows by. */
  readonly downsample: number;
  /** The mask tokens: one for an unambiguous prompt and three for an ambiguous one. */
  readonly masks: number;
  readonly iouHidden: number;
  readonly iouDepth: number;
  /** The channels a mask input is downscaled through. */
  readonly maskChannels: number;
}

const CHANNEL_EPSILON = 1e-6;

/** What the decoder's two outputs are named. */
export interface SamDecoderOutput {
  /** `[masks, 4·grid, 4·grid]`: each mask's logits at four times the embedding's grid. */
  readonly masks: string;
  /** `[1, masks]`: each mask's predicted intersection over union. */
  readonly quality: string;
}

/**
 * The decoder over `embedding`, `[dim, grid, grid]`, and `promptTokens`, `[tokens, dim]` or null for a
 * prompt of none, with `mask`, `[1, 4·grid, 4·grid]`, the previous logits to refine, or null.
 */
export function samDecoder(
  weights: Weights,
  graph: GraphBuilder,
  config: SamDecoderConfig,
  embedding: string,
  promptTokens: string | null,
  mask: string | null,
  grid: number,
  names: SamDecoderOutput,
): void {
  const node = graph.node.bind(graph);
  const { dim, masks } = config;
  const cells = grid * grid;
  const d = 'mask_decoder.';
  const t = `${d}transformer.`;
  const pe = 'prompt_encoder.';
  const read = weights.read.bind(weights);

  const linear = (x: string, p: string, out: number, inputs: number, name?: string): string =>
    node('linear', [x, read(`${p}weight`, [out, inputs]), read(`${p}bias`, [out])], {}, name);
  const tokensOf = (map: string, channels: number, count: number): string =>
    node('permute', [node('reshape', [map], { shape: [channels, count] })], { order: [1, 0] });
  const channelNorm = (map: string, p: string, channels: number, rows: number): string =>
    node(
      'reshape',
      [
        node(
          'permute',
          [
            node(
              'layerNorm',
              [
                tokensOf(map, channels, rows * rows),
                read(`${p}weight`, [channels]),
                read(`${p}bias`, [channels]),
              ],
              { epsilon: CHANNEL_EPSILON },
            ),
          ],
          { order: [1, 0] },
        ),
      ],
      { shape: [channels, rows, rows] },
    );
  const perceptron = (x: string, p: string, sizes: readonly number[], name?: string): string => {
    let y = x;
    for (let i = 0; i + 1 < sizes.length; i += 1) {
      const last = i + 2 === sizes.length;
      y = linear(
        y,
        `${p}layers.${i}.`,
        sizes[i + 1] as number,
        sizes[i] as number,
        last ? name : undefined,
      );
      if (i + 2 < sizes.length) y = node('relu', [y]);
    }
    return y;
  };

  /* The prompt encoder's weights, all of them: see the header. */
  read(`${pe}pe_layer.positional_encoding_gaussian_matrix`, [2, dim / 2]);
  for (let i = 0; i < 4; i += 1) read(`${pe}point_embeddings.${i}.weight`, [1, dim]);
  read(`${pe}not_a_point_embed.weight`, [1, dim]);
  const c = config.maskChannels;
  const downscaled = (input: string): string => {
    const p = `${pe}mask_downscaling.`;
    let x = node(
      'conv2d',
      [input, read(`${p}0.weight`, [c / 4, 1, 2, 2]), read(`${p}0.bias`, [c / 4])],
      { stride: 2 },
    );
    x = node('gelu', [channelNorm(x, `${p}1.`, c / 4, 2 * grid)]);
    x = node('conv2d', [x, read(`${p}3.weight`, [c, c / 4, 2, 2]), read(`${p}3.bias`, [c])], {
      stride: 2,
    });
    x = node('gelu', [channelNorm(x, `${p}4.`, c, grid)]);
    x = node('conv2d', [x, read(`${p}6.weight`, [dim, c, 1, 1]), read(`${p}6.bias`, [dim])]);
    return tokensOf(x, dim, cells);
  };
  const noMask = read(`${pe}no_mask_embed.weight`, [1, dim]);
  if (mask === null) downscaledWeights(read, `${pe}mask_downscaling.`, dim, c);
  const dense = mask === null ? node('reshape', [noMask], { shape: [dim] }) : downscaled(mask);

  const positions = weights.derive(`${pe}grid_positions.${grid}x${grid}`, [cells, dim], (values) =>
    samGridPositions(
      values(`${pe}pe_layer.positional_encoding_gaussian_matrix`, [2, dim / 2]),
      dim,
      grid,
    ),
  );
  const tokens = node(
    'concat',
    [
      read(`${d}iou_token.weight`, [1, dim]),
      read(`${d}mask_tokens.weight`, [masks, dim]),
      ...(promptTokens === null ? [] : [promptTokens]),
    ],
    { axis: 0 },
  );
  const { queries, keys } = twoWay(
    weights,
    graph,
    t,
    config,
    SAM_NAMES,
    tokens,
    node('add', [tokensOf(embedding, dim, cells), dense]),
    positions,
  );

  /* Upsampled four times, and each mask token's vector dotted with every pixel. */
  const u = `${d}output_upscaling.`;
  const image = node('reshape', [node('permute', [keys], { order: [1, 0] })], {
    shape: [dim, grid, grid],
  });
  let up = node(
    'convTranspose2d',
    [image, read(`${u}0.weight`, [dim, dim / 4, 2, 2]), read(`${u}0.bias`, [dim / 4])],
    { stride: 2 },
  );
  up = node('gelu', [channelNorm(up, `${u}1.`, dim / 4, 2 * grid)]);
  up = node('gelu', [
    node(
      'convTranspose2d',
      [up, read(`${u}3.weight`, [dim / 4, dim / 8, 2, 2]), read(`${u}3.bias`, [dim / 8])],
      { stride: 2 },
    ),
  ]);
  const vectors = Array.from({ length: masks }, (_, i) =>
    perceptron(
      node('slice', [queries], { axis: 0, start: 1 + i, end: 2 + i }),
      `${d}output_hypernetworks_mlps.${i}.`,
      [dim, dim, dim, dim / 8],
    ),
  );
  const pixels = 16 * cells;
  const products = node('linear', [
    tokensOf(up, dim / 8, pixels),
    node('concat', vectors, { axis: 0 }),
  ]);
  node(
    'reshape',
    [node('permute', [products], { order: [1, 0] })],
    { shape: [masks, 4 * grid, 4 * grid] },
    names.masks,
  );
  perceptron(
    node('slice', [queries], { axis: 0, start: 0, end: 1 }),
    `${d}iou_prediction_head.`,
    [dim, ...Array.from({ length: config.iouDepth - 1 }, () => config.iouHidden), masks],
    names.quality,
  );
}

/* The mask input's downscaling weights, read into a graph that takes no mask input. */
function downscaledWeights(
  read: (name: string, shape?: readonly number[]) => string,
  p: string,
  dim: number,
  c: number,
): void {
  read(`${p}0.weight`, [c / 4, 1, 2, 2]);
  read(`${p}0.bias`, [c / 4]);
  read(`${p}1.weight`, [c / 4]);
  read(`${p}1.bias`, [c / 4]);
  read(`${p}3.weight`, [c, c / 4, 2, 2]);
  read(`${p}3.bias`, [c]);
  read(`${p}4.weight`, [c]);
  read(`${p}4.bias`, [c]);
  read(`${p}6.weight`, [dim, c, 1, 1]);
  read(`${p}6.bias`, [dim]);
}
