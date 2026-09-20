/**
 * SAM 2's mask decoder: SAM's two-way transformer with the encoder's finer levels brought back in,
 * an object score, and every mask token's object pointer for a video's memory.
 *
 * **The tokens lead with an object-score token**, then the quality token and one per mask, then
 * the prompt's. **The upsampling adds the encoder's skips**: its second level after the first
 * transposed convolution, and its first after the second, each before the activation. Quality is
 * a sigmoid, as the upstream's `sigmoid_output`; the object score is a logit, positive where the
 * object is present. **Each mask token's object pointer is projected here**, all four, so the host
 * can keep the one it chooses without another graph. Norms of channels take ε 1e-6.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import type { SamDecoderConfig } from './samDecoder.ts';
import { samGridPositions } from './samPrompt.ts';
import { SAM2_NAMES, twoWay } from './twoWay.ts';

const CHANNEL_EPSILON = 1e-6;

export interface Sam2DecoderInputs {
  /** `[dim, grid, grid]`: the features, conditioned on memory or given `no_memory_embedding`. */
  readonly embedding: string;
  /** `[tokens, dim]`, or null for a prompt of none. */
  readonly prompt: string | null;
  /** `[1, 4·grid, 4·grid]`: a mask's logits to refine, or null. */
  readonly mask: string | null;
  /** The encoder's narrowed finer levels, `[dim / 4, 2·grid, 2·grid]` and `[dim / 8, 4·grid, 4·grid]`. */
  readonly high1: string;
  readonly high0: string;
}

/** What the decoder's four outputs are named. */
export interface Sam2DecoderOutput {
  /** `[masks, 4·grid, 4·grid]` logits. */
  readonly masks: string;
  /** `[1, masks]`, each mask's predicted intersection over union. */
  readonly quality: string;
  /** `[1, 1]`: the object score's logit. */
  readonly object: string;
  /** `[masks, dim]`: each mask token's object pointer. */
  readonly pointers: string;
}

export function sam2Decoder(
  weights: Weights,
  graph: GraphBuilder,
  config: SamDecoderConfig,
  grid: number,
  inputs: Sam2DecoderInputs,
  names: Sam2DecoderOutput,
): void {
  const node = graph.node.bind(graph);
  const read = weights.read.bind(weights);
  const { dim, masks } = config;
  const cells = grid * grid;
  const m = 'mask_decoder.';
  const pe = 'prompt_encoder.';
  const linear = (x: string, p: string, out: number, width: number, name?: string): string =>
    node('linear', [x, read(`${p}weight`, [out, width]), read(`${p}bias`, [out])], {}, name);
  /* The upstream's perceptron: `proj_in`, then `layers`, then `proj_out`, ReLU between. */
  const perceptron = (x: string, p: string, sizes: readonly number[], name?: string): string => {
    const parts = sizes.length - 1;
    let y = x;
    for (let i = 0; i < parts; i += 1) {
      const at = i === 0 ? 'proj_in' : i === parts - 1 ? 'proj_out' : `layers.${i - 1}`;
      const last = i === parts - 1;
      y = linear(
        y,
        `${p}${at}.`,
        sizes[i + 1] as number,
        sizes[i] as number,
        last ? name : undefined,
      );
      if (!last) y = node('relu', [y]);
    }
    return y;
  };
  const tokensOf = (map: string, channels: number, count: number): string =>
    node('permute', [node('reshape', [map], { shape: [channels, count] })], { order: [1, 0] });
  const channelNorm = (map: string, p: string, channels: number, rows: number): string => {
    const normed = node(
      'layerNorm',
      [
        tokensOf(map, channels, rows * rows),
        read(`${p}weight`, [channels]),
        read(`${p}bias`, [channels]),
      ],
      { epsilon: CHANNEL_EPSILON },
    );
    return node('reshape', [node('permute', [normed], { order: [1, 0] })], {
      shape: [channels, rows, rows],
    });
  };

  /* The prompt encoder's weights, all of them, for the host's tokens and the graph that refines. */
  read(`${pe}shared_embedding.positional_embedding`, [2, dim / 2]);
  read(`${pe}point_embed.weight`, [4, dim]);
  read(`${pe}not_a_point_embed.weight`, [1, dim]);
  const c = config.maskChannels;
  const embed = `${pe}mask_embed.`;
  const convs = [
    [`${embed}conv1.`, c / 4, 1, 2],
    [`${embed}conv2.`, c, c / 4, 2],
    [`${embed}conv3.`, dim, c, 1],
  ] as const;
  const w = convs.map(([p, out, into, k]) => [
    read(`${p}weight`, [out, into, k, k]),
    read(`${p}bias`, [out]),
  ]);
  let dense = node('reshape', [read(`${pe}no_mask_embed.weight`, [1, dim])], { shape: [dim] });
  if (inputs.mask !== null) {
    let x = node('conv2d', [inputs.mask, ...(w[0] as string[])], { stride: 2 });
    x = node('gelu', [channelNorm(x, `${embed}layer_norm1.`, c / 4, 2 * grid)]);
    x = node('conv2d', [x, ...(w[1] as string[])], { stride: 2 });
    x = node('gelu', [channelNorm(x, `${embed}layer_norm2.`, c, grid)]);
    dense = tokensOf(node('conv2d', [x, ...(w[2] as string[])]), dim, cells);
  } else {
    for (const [i, channels] of [
      [1, c / 4],
      [2, c],
    ] as const) {
      read(`${embed}layer_norm${i}.weight`, [channels]);
      read(`${embed}layer_norm${i}.bias`, [channels]);
    }
  }

  const positions = weights.derive(
    `shared_image_embedding.grid_positions.${grid}x${grid}`,
    [cells, dim],
    (values) =>
      samGridPositions(
        values('shared_image_embedding.positional_embedding', [2, dim / 2]),
        dim,
        grid,
      ),
  );
  read('shared_image_embedding.positional_embedding', [2, dim / 2]);
  const tokens = node(
    'concat',
    [
      read(`${m}obj_score_token.weight`, [1, dim]),
      read(`${m}iou_token.weight`, [1, dim]),
      read(`${m}mask_tokens.weight`, [masks, dim]),
      ...(inputs.prompt === null ? [] : [inputs.prompt]),
    ],
    { axis: 0 },
  );
  const image = node('add', [tokensOf(inputs.embedding, dim, cells), dense]);
  const { queries, keys } = twoWay(
    weights,
    graph,
    `${m}transformer.`,
    config,
    SAM2_NAMES,
    tokens,
    image,
    positions,
  );

  /* Upsampled four times with the encoder's skips, and each mask token's vector dotted with every pixel. */
  const map = node('reshape', [node('permute', [keys], { order: [1, 0] })], {
    shape: [dim, grid, grid],
  });
  let up = node(
    'convTranspose2d',
    [
      map,
      read(`${m}upscale_conv1.weight`, [dim, dim / 4, 2, 2]),
      read(`${m}upscale_conv1.bias`, [dim / 4]),
    ],
    { stride: 2 },
  );
  up = node('gelu', [
    channelNorm(node('add', [up, inputs.high1]), `${m}upscale_layer_norm.`, dim / 4, 2 * grid),
  ]);
  up = node(
    'convTranspose2d',
    [
      up,
      read(`${m}upscale_conv2.weight`, [dim / 4, dim / 8, 2, 2]),
      read(`${m}upscale_conv2.bias`, [dim / 8]),
    ],
    { stride: 2 },
  );
  up = node('gelu', [node('add', [up, inputs.high0])]);
  const maskTokens = node('slice', [queries], { axis: 0, start: 2, end: 2 + masks });
  const vectors = Array.from({ length: masks }, (_, i) =>
    perceptron(
      node('slice', [maskTokens], { axis: 0, start: i, end: i + 1 }),
      `${m}output_hypernetworks_mlps.${i}.`,
      [dim, dim, dim, dim / 8],
    ),
  );
  const products = node('linear', [
    tokensOf(up, dim / 8, 16 * cells),
    node('concat', vectors, { axis: 0 }),
  ]);
  node(
    'reshape',
    [node('permute', [products], { order: [1, 0] })],
    { shape: [masks, 4 * grid, 4 * grid] },
    names.masks,
  );
  const hidden = Array.from({ length: config.iouDepth - 1 }, () => config.iouHidden);
  const quality = perceptron(
    node('slice', [queries], { axis: 0, start: 1, end: 2 }),
    `${m}iou_prediction_head.`,
    [dim, ...hidden, masks],
  );
  node('sigmoid', [quality], {}, names.quality);
  perceptron(
    node('slice', [queries], { axis: 0, start: 0, end: 1 }),
    `${m}pred_obj_score_head.`,
    [dim, dim, dim, 1],
    names.object,
  );
  perceptron(maskTokens, 'object_pointer_proj.', [dim, dim, dim, dim], names.pointers);
}
