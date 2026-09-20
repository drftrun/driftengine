/**
 * SAM 2's memory: the encoder that makes a frame and its mask into a memory, and the attention that
 * conditions a new frame's features on the memories kept.
 *
 * **A memory is the frame's features where the mask says the object is**: the mask, taken through a
 * sigmoid unless it is already binary, scaled to ±10 and downsampled sixteen times by strided 3×3
 * convolutions, is added to the features projected once, and the sum is fused by ConvNeXt blocks —
 * a depthwise 7×7, a channel norm, and a pointwise MLP scaled per channel — and narrowed to the
 * memory's 64 channels. Norms of channels take ε 1e-6.
 *
 * **The attention reads every memory at once**: the current features, with a tenth of their sine
 * positions added, attend to themselves and then to the memories' tokens — every frame's cells and
 * the object pointers after them — then pass an MLP, four times. Queries and the frames' keys are
 * turned by an axial rotary embedding of the cell's column and row, the same table for every frame;
 * the pointers' keys are not turned, as the upstream's `num_k_exclude_rope` leaves them. Its norms
 * take PyTorch's default ε, 1e-5.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import type { Sam21MemoryConfig } from './sam21.ts';
import { sam2Rotary, sam2SinePositions } from './sam2Positions.ts';

const CHANNEL_EPSILON = 1e-6;
const EPSILON = 1e-5;

/**
 * `[memory.dim, grid, grid]` into `output`, from `features`, `[dim, grid, grid]`, and `mask`,
 * `[1, 16·grid, 16·grid]` — logits, or a binary mask when `binary`.
 */
export function sam2MemoryEncoder(
  weights: Weights,
  graph: GraphBuilder,
  dim: number,
  memory: Sam21MemoryConfig,
  grid: number,
  features: string,
  mask: string,
  binary: boolean,
  output: string,
): void {
  const node = graph.node.bind(graph);
  const read = weights.read.bind(weights);
  const e = 'memory_encoder.';
  const side = 16 * grid;
  const conv = (
    x: string,
    p: string,
    out: number,
    into: number,
    k: number,
    attributes = {},
  ): string =>
    node('conv2d', [x, read(`${p}weight`, [out, into, k, k]), read(`${p}bias`, [out])], attributes);
  const tokensOf = (map: string, channels: number, count: number): string =>
    node('permute', [node('reshape', [map], { shape: [channels, count] })], { order: [1, 0] });
  const mapOf = (tokens: string, channels: number, rows: number): string =>
    node('reshape', [node('permute', [tokens], { order: [1, 0] })], {
      shape: [channels, rows, rows],
    });
  const channelNorm = (map: string, p: string, channels: number, rows: number): string =>
    mapOf(
      node(
        'layerNorm',
        [
          tokensOf(map, channels, rows * rows),
          read(`${p}weight`, [channels]),
          read(`${p}bias`, [channels]),
        ],
        { epsilon: CHANNEL_EPSILON },
      ),
      channels,
      rows,
    );

  /* The mask to ±10: a sigmoid's 0 to 1, or a binary mask's, times 20 less 10. */
  const unit = binary ? mask : node('sigmoid', [mask]);
  const scale = weights.constant(
    `sam2.mask_scale.${side}`,
    [side],
    new Float32Array(side).fill(20),
  );
  const shift = weights.constant(
    `sam2.mask_shift.${side}`,
    [side],
    new Float32Array(side).fill(-10),
  );
  let down = node('add', [node('mul', [unit, scale]), shift]);
  let channels = 1;
  let rows = side;
  for (let i = 0; i < 4; i += 1) {
    const p = `${e}mask_downsampler.layers.${i}.`;
    down = conv(down, `${p}conv.`, channels * 4, channels, 3, { stride: 2, padding: 1 });
    channels *= 4;
    rows /= 2;
    down = node('gelu', [channelNorm(down, `${p}layer_norm.`, channels, rows)]);
  }
  down = conv(down, `${e}mask_downsampler.final_conv.`, dim, channels, 1);
  let fused = node('add', [conv(features, `${e}feature_projection.`, dim, dim, 1), down]);
  for (let i = 0; i < memory.fuserLayers; i += 1) {
    const p = `${e}memory_fuser.layers.${i}.`;
    const spread = conv(fused, `${p}depthwise_conv.`, dim, 1, 7, { padding: 3, groups: dim });
    const normed = tokensOf(channelNorm(spread, `${p}layer_norm.`, dim, grid), dim, grid * grid);
    const hidden = node('gelu', [
      node('linear', [
        normed,
        read(`${p}pointwise_conv1.weight`, [memory.fuserHidden, dim]),
        read(`${p}pointwise_conv1.bias`, [memory.fuserHidden]),
      ]),
    ]);
    const back = node('linear', [
      hidden,
      read(`${p}pointwise_conv2.weight`, [dim, memory.fuserHidden]),
      read(`${p}pointwise_conv2.bias`, [dim]),
    ]);
    fused = node('add', [fused, mapOf(node('mul', [back, read(`${p}scale`, [dim])]), dim, grid)]);
  }
  node(
    'conv2d',
    [
      fused,
      read(`${e}projection.weight`, [memory.dim, dim, 1, 1]),
      read(`${e}projection.bias`, [memory.dim]),
    ],
    {},
    output,
  );
}

/**
 * `[dim, grid, grid]` into `output`: `features`, `[dim, grid, grid]`, conditioned on `memory`,
 * `[frames·grid² + pointers, memory.dim]`, whose positions are `positions` of that shape — the
 * frames' cells first and `pointers` object-pointer tokens after them.
 */
export function sam2MemoryAttention(
  weights: Weights,
  graph: GraphBuilder,
  dim: number,
  config: Sam21MemoryConfig,
  grid: number,
  frames: number,
  pointers: number,
  features: string,
  memory: string,
  positions: string,
  output: string,
): void {
  const node = graph.node.bind(graph);
  const read = weights.read.bind(weights);
  const a = 'memory_attention.';
  const cells = grid * grid;
  const linear = (x: string, p: string, out: number, into: number): string =>
    node('linear', [x, read(`${p}weight`, [out, into]), read(`${p}bias`, [out])]);
  const norm = (x: string, p: string): string =>
    node('layerNorm', [x, read(`${p}weight`, [dim]), read(`${p}bias`, [dim])], {
      epsilon: EPSILON,
    });
  const tokensOf = (map: string, channels: number): string =>
    node('permute', [node('reshape', [map], { shape: [channels, cells] })], { order: [1, 0] });

  const sine = sam2SinePositions(dim / 2, grid, grid);
  const tenth = Float32Array.from(sine, (value) => Math.fround(Math.fround(0.1) * value));
  const place = weights.constant(`sam2.feature_positions.${grid}`, [dim, grid, grid], tenth);
  let x = tokensOf(node('add', [features, place]), dim);
  const rotary = sam2Rotary(dim / config.attentionHeads, grid, grid);
  if (config.attentionHeads !== 1)
    throw new Error('the memory attention is written for one head, as SAM 2.1 has');
  const cos = weights.constant(`sam2.rotary_cos.${grid}`, [cells * dim], rotary.cos);
  const sin = weights.constant(`sam2.rotary_sin.${grid}`, [cells * dim], rotary.sin);
  /* `x·cos + swap(x)·sin` over `count` blocks of the grid's cells, `swap` exchanging each pair. */
  const turn = (value: string, count: number): string => {
    const pairs = node('reshape', [value], { shape: [count * cells * (dim / 2), 2] });
    const swapped = node(
      'concat',
      [
        node('slice', [pairs], { axis: 1, start: 1, end: 2 }),
        node('slice', [pairs], { axis: 1, start: 0, end: 1 }),
      ],
      { axis: 1 },
    );
    const flat = (v: string): string => node('reshape', [v], { shape: [count, cells * dim] });
    const turned = node('add', [
      node('mul', [flat(value), cos]),
      node('mul', [flat(swapped), sin]),
    ]);
    return node('reshape', [turned], { shape: [count * cells, dim] });
  };
  const keyed = node('add', [memory, positions]);
  const rotated = frames * cells;
  const attend = (
    p: string,
    q: string,
    k: string,
    v: string,
    into: number,
    turnKeys: boolean,
  ): string => {
    const queries = turn(linear(q, `${p}q_proj.`, dim, dim), 1);
    let keys = linear(k, `${p}k_proj.`, dim, into);
    if (turnKeys) {
      const cellsPart = turn(node('slice', [keys], { axis: 0, start: 0, end: rotated }), frames);
      keys =
        pointers === 0
          ? cellsPart
          : node(
              'concat',
              [
                cellsPart,
                node('slice', [keys], { axis: 0, start: rotated, end: rotated + pointers }),
              ],
              { axis: 0 },
            );
    } else {
      keys = turn(keys, 1);
    }
    const values = linear(v, `${p}v_proj.`, dim, into);
    return linear(
      node('attention', [queries, keys, values], { heads: config.attentionHeads }),
      `${p}o_proj.`,
      dim,
      dim,
    );
  };
  for (let i = 0; i < config.attentionLayers; i += 1) {
    const p = `${a}layers.${i}.`;
    const q1 = norm(x, `${p}layer_norm1.`);
    x = node('add', [x, attend(`${p}self_attn.`, q1, q1, q1, dim, false)]);
    const q2 = norm(x, `${p}layer_norm2.`);
    x = node('add', [x, attend(`${p}cross_attn_image.`, q2, keyed, memory, config.dim, true)]);
    const q3 = norm(x, `${p}layer_norm3.`);
    x = node('add', [
      x,
      linear(
        node('relu', [linear(q3, `${p}linear1.`, config.feedForward, dim)]),
        `${p}linear2.`,
        dim,
        config.feedForward,
      ),
    ]);
  }
  const normed = norm(x, `${a}layer_norm.`);
  node(
    'reshape',
    [node('permute', [normed], { order: [1, 0] })],
    { shape: [dim, grid, grid] },
    output,
  );
}
