/**
 * A seeded miniature of SAM 2.1: every tensor name and shape of the upstream's video model, at a
 * size the CPU evaluates in a moment — what the model's tests and its hand-run oracle share.
 *
 * **Small where the upstream lets it be.** A 64-pixel frame, stages of 8, 16, 32 and 64 channels in
 * 1, 2, 3 and 2 blocks, windows of 8, 4, 14 and 7 over grids of 16, 8, 4 and 2 — so windows divide,
 * pad and outgrow their grid, one block attends globally and every stage change pools its queries.
 * **The width is 128**, where the upstream's is 256: a memory is 64 channels wide, a width the
 * upstream writes as a literal, and an object pointer is cut into width/64 tokens, so the width must
 * be a multiple of 64 — and 128 cuts each pointer in two, as the real model's 256 cuts it in four.
 */
import type { GraphTensor } from '@driftengine/texture';

import type { Sam21Config } from './sam21.ts';
import type { SamPrompt } from './samPrompt.ts';
import { draw } from './seeded.ts';

export const MINIATURE_SAM_21: Sam21Config = {
  size: 64,
  encoder: {
    dims: [8, 16, 32, 64],
    blocks: [1, 2, 3, 2],
    heads: [1, 2, 2, 4],
    windows: [8, 4, 14, 7],
    global: [4],
    background: 7,
    mlpRatio: 4,
    fpn: 128,
    topDown: [2, 3],
  },
  decoder: {
    dim: 128,
    heads: 2,
    mlp: 32,
    depth: 2,
    downsample: 2,
    masks: 4,
    iouHidden: 16,
    iouDepth: 3,
    maskChannels: 16,
  },
  memory: {
    dim: 64,
    attentionLayers: 2,
    attentionHeads: 1,
    feedForward: 32,
    fuserLayers: 2,
    fuserHidden: 64,
    frames: 7,
    pointers: 16,
  },
};

/**
 * The original frame the prompts are given in, 36 by 48, which SAM 2 resizes to its square — so
 * each axis scales by its own factor — and a point, a box, and both with a second point off the
 * object.
 */
export const MINIATURE_SAM_21_IMAGE = { height: 36, width: 48 } as const;
export const MINIATURE_SAM_21_PROMPTS = {
  point: { points: [[20.5, 14.25, 1]] },
  box: { box: [6, 5, 40.5, 30] },
  both: {
    points: [
      [20.5, 14.25, 1],
      [33, 25.75, 0],
    ],
    box: [6, 5, 40.5, 30],
  },
} as const satisfies Record<string, SamPrompt>;

/** Every tensor the upstream's `Sam2VideoModel` holds, named as its checkpoints are. */
export function miniatureSam21Checkpoint(
  config: Sam21Config,
  seed: number,
): Map<string, GraphTensor> {
  const out = new Map<string, GraphTensor>();
  const add = (name: string, shape: readonly number[]): void => {
    out.set(name, { shape, data: draw(name, shape, seed) });
  };
  const linear = (p: string, outputs: number, inputs: number): void => {
    add(`${p}weight`, [outputs, inputs]);
    add(`${p}bias`, [outputs]);
  };
  const conv = (p: string, outputs: number, inputs: number, kernel: number): void => {
    add(`${p}weight`, [outputs, inputs, kernel, kernel]);
    add(`${p}bias`, [outputs]);
  };
  const norm = (p: string, dim: number): void => {
    add(`${p}weight`, [dim]);
    add(`${p}bias`, [dim]);
  };
  /* The upstream's two-to-n-layer perceptron: `proj_in`, then `layers`, then `proj_out`. */
  const perceptron = (
    p: string,
    input: number,
    hidden: number,
    output: number,
    depth: number,
  ): void => {
    linear(`${p}proj_in.`, hidden, input);
    for (let i = 0; i < depth - 2; i += 1) linear(`${p}layers.${i}.`, hidden, hidden);
    linear(`${p}proj_out.`, output, hidden);
  };

  const { encoder, decoder, memory } = config;
  const width = decoder.dim;
  add('no_memory_embedding', [1, 1, width]);
  add('no_memory_positional_encoding', [1, 1, width]);
  add('memory_temporal_positional_encoding', [memory.frames, 1, 1, memory.dim]);
  add('no_object_pointer', [1, width]);
  add('occlusion_spatial_embedding_parameter', [1, memory.dim]);
  add('shared_image_embedding.positional_embedding', [2, width / 2]);

  const b = 'vision_encoder.backbone.';
  const d0 = encoder.dims[0];
  add(`${b}pos_embed`, [1, d0, encoder.background, encoder.background]);
  add(`${b}pos_embed_window`, [1, d0, encoder.windows[0], encoder.windows[0]]);
  conv(`${b}patch_embed.projection.`, d0, 3, 7);
  let index = 0;
  for (let stage = 0; stage < 4; stage += 1) {
    for (let block = 0; block < (encoder.blocks[stage] as number); block += 1) {
      const p = `${b}blocks.${index}.`;
      const first = stage > 0 && block === 0;
      const dim = first ? (encoder.dims[stage - 1] as number) : (encoder.dims[stage] as number);
      const outDim = encoder.dims[stage] as number;
      norm(`${p}layer_norm1.`, dim);
      linear(`${p}attn.qkv.`, 3 * outDim, dim);
      linear(`${p}attn.proj.`, outDim, outDim);
      norm(`${p}layer_norm2.`, outDim);
      linear(`${p}mlp.proj_in.`, outDim * encoder.mlpRatio, outDim);
      linear(`${p}mlp.proj_out.`, outDim, outDim * encoder.mlpRatio);
      if (first) linear(`${p}proj.`, outDim, dim);
      index += 1;
    }
  }
  for (let i = 0; i < 4; i += 1)
    conv(`vision_encoder.neck.convs.${i}.`, encoder.fpn, encoder.dims[3 - i] as number, 1);

  const pe = 'prompt_encoder.';
  add(`${pe}shared_embedding.positional_embedding`, [2, width / 2]);
  const c = decoder.maskChannels;
  conv(`${pe}mask_embed.conv1.`, c / 4, 1, 2);
  conv(`${pe}mask_embed.conv2.`, c, c / 4, 2);
  conv(`${pe}mask_embed.conv3.`, width, c, 1);
  norm(`${pe}mask_embed.layer_norm1.`, c / 4);
  norm(`${pe}mask_embed.layer_norm2.`, c);
  add(`${pe}no_mask_embed.weight`, [1, width]);
  add(`${pe}point_embed.weight`, [4, width]);
  add(`${pe}not_a_point_embed.weight`, [1, width]);

  const m = 'mask_decoder.';
  const t = `${m}transformer.`;
  const inner = width / decoder.downsample;
  const attention = (p: string, dim: number, kv = width): void => {
    linear(`${p}q_proj.`, dim, width);
    linear(`${p}k_proj.`, dim, kv);
    linear(`${p}v_proj.`, dim, kv);
    linear(`${p}o_proj.`, width, dim);
  };
  add(`${m}iou_token.weight`, [1, width]);
  add(`${m}mask_tokens.weight`, [decoder.masks, width]);
  for (let i = 0; i < decoder.depth; i += 1) {
    const p = `${t}layers.${i}.`;
    attention(`${p}self_attn.`, width);
    norm(`${p}layer_norm1.`, width);
    attention(`${p}cross_attn_token_to_image.`, inner);
    norm(`${p}layer_norm2.`, width);
    perceptron(`${p}mlp.`, width, decoder.mlp, width, decoder.depth);
    norm(`${p}layer_norm3.`, width);
    norm(`${p}layer_norm4.`, width);
    attention(`${p}cross_attn_image_to_token.`, inner);
  }
  attention(`${t}final_attn_token_to_image.`, inner);
  norm(`${t}layer_norm_final_attn.`, width);
  add(`${m}upscale_conv1.weight`, [width, width / 4, 2, 2]);
  add(`${m}upscale_conv1.bias`, [width / 4]);
  add(`${m}upscale_conv2.weight`, [width / 4, width / 8, 2, 2]);
  add(`${m}upscale_conv2.bias`, [width / 8]);
  norm(`${m}upscale_layer_norm.`, width / 4);
  for (let i = 0; i < decoder.masks; i += 1) {
    perceptron(`${m}output_hypernetworks_mlps.${i}.`, width, width, width / 8, 3);
  }
  perceptron(`${m}iou_prediction_head.`, width, decoder.iouHidden, decoder.masks, decoder.iouDepth);
  conv(`${m}conv_s0.`, width / 8, width, 1);
  conv(`${m}conv_s1.`, width / 4, width, 1);
  add(`${m}obj_score_token.weight`, [1, width]);
  perceptron(`${m}pred_obj_score_head.`, width, width, 1, 3);

  const a = 'memory_attention.';
  for (let i = 0; i < memory.attentionLayers; i += 1) {
    const p = `${a}layers.${i}.`;
    attention(`${p}self_attn.`, width);
    attention(`${p}cross_attn_image.`, width, memory.dim);
    linear(`${p}linear1.`, memory.feedForward, width);
    linear(`${p}linear2.`, width, memory.feedForward);
    norm(`${p}layer_norm1.`, width);
    norm(`${p}layer_norm2.`, width);
    norm(`${p}layer_norm3.`, width);
  }
  norm(`${a}layer_norm.`, width);

  const e = 'memory_encoder.';
  let channels = 1;
  for (let i = 0; i < 4; i += 1) {
    conv(`${e}mask_downsampler.layers.${i}.conv.`, channels * 4, channels, 3);
    norm(`${e}mask_downsampler.layers.${i}.layer_norm.`, channels * 4);
    channels *= 4;
  }
  conv(`${e}mask_downsampler.final_conv.`, width, channels, 1);
  conv(`${e}feature_projection.`, width, width, 1);
  for (let i = 0; i < memory.fuserLayers; i += 1) {
    const p = `${e}memory_fuser.layers.${i}.`;
    add(`${p}scale`, [width]);
    conv(`${p}depthwise_conv.`, width, 1, 7);
    norm(`${p}layer_norm.`, width);
    linear(`${p}pointwise_conv1.`, memory.fuserHidden, width);
    linear(`${p}pointwise_conv2.`, width, memory.fuserHidden);
  }
  conv(`${e}projection.`, memory.dim, width, 1);
  conv('mask_downsample.', 1, 1, 4);
  perceptron('object_pointer_proj.', width, width, width, 3);
  linear('temporal_positional_encoding_projection_layer.', memory.dim, width);
  return out;
}
