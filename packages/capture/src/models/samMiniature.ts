/**
 * A seeded miniature of MobileSAM: the upstream's layout, every tensor name and shape of it, at a
 * size the CPU evaluates in a moment — what the model's tests and its hand-run oracle share, as the
 * depth models' miniature is.
 *
 * **Small everywhere the upstream lets it be.** A 64-pixel image, four stages of 8, 16, 24 and 320
 * channels — the last must be 320, since the upstream keeps its last merge's stride at one by that
 * width alone — windows of 3, 4 and 2 over grids of 8, 4 and 4, so one stage pads its windows, one
 * is attended whole and one divides evenly, and one or two blocks a stage. The neck's 256 channels
 * are the upstream's own constant, so the decoder is 256 wide too; its MLP and quality head are
 * narrow, and its grid is 4.
 *
 * **Every tensor the upstream holds is here**, the classification head the definition sets aside
 * and the batch norms' counters included, so the oracle loads it strictly.
 */
import type { GraphTensor } from '@driftengine/texture';

import type { MobileSamConfig } from './mobileSam.ts';
import type { SamPrompt } from './samPrompt.ts';
import { draw } from './seeded.ts';

export const MINIATURE_MOBILE_SAM: MobileSamConfig = {
  size: 64,
  encoder: {
    embedDims: [8, 16, 24, 320],
    depths: [1, 2, 1, 1],
    heads: [1, 2, 3, 10],
    windows: [7, 3, 4, 2],
    mergeStrides: [2, 2, 1],
    mlpRatio: 4,
    expandRatio: 4,
    neck: 256,
  },
  decoder: {
    dim: 256,
    heads: 8,
    mlp: 32,
    depth: 2,
    downsample: 2,
    masks: 4,
    iouHidden: 16,
    iouDepth: 3,
    maskChannels: 16,
  },
};

/** The classes of the miniature's classification head, which nothing runs. */
export const MINIATURE_SAM_CLASSES = 10;

/**
 * The original image the prompts are given in: 36 by 48, prepared at 48 by 64 in the encoder's 64
 * square, so the masks are cropped before they come down to it and coordinates are scaled by 4/3.
 */
export const MINIATURE_SAM_IMAGE = { height: 36, width: 48 } as const;

/** A point, which a padding point follows; a box; and two points with a box, which none follows. */
export const MINIATURE_SAM_PROMPTS = {
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

/** Every tensor the upstream's encoder, prompt encoder and mask decoder hold. */
export function miniatureSamCheckpoint(
  config: MobileSamConfig,
  seed: number,
): Map<string, GraphTensor> {
  const out = new Map<string, GraphTensor>();
  const add = (name: string, shape: readonly number[]): void => {
    out.set(name, { shape, data: draw(name, shape, seed) });
  };
  const convBn = (p: string, cout: number, cin: number, kernel: number): void => {
    add(`${p}c.weight`, [cout, cin, kernel, kernel]);
    for (const part of ['weight', 'bias', 'running_mean', 'running_var'])
      add(`${p}bn.${part}`, [cout]);
    out.set(`${p}bn.num_batches_tracked`, { shape: [], data: new Float32Array(1) });
  };
  const linear = (p: string, outputs: number, inputs: number): void => {
    add(`${p}weight`, [outputs, inputs]);
    add(`${p}bias`, [outputs]);
  };
  const norm = (p: string, dim: number): void => {
    add(`${p}weight`, [dim]);
    add(`${p}bias`, [dim]);
  };

  const { embedDims: dims, depths, windows, mlpRatio, expandRatio, neck } = config.encoder;
  const e = 'image_encoder.';
  convBn(`${e}patch_embed.seq.0.`, dims[0] / 2, 3, 3);
  convBn(`${e}patch_embed.seq.2.`, dims[0], dims[0] / 2, 3);
  for (let i = 0; i < depths[0]; i += 1) {
    const p = `${e}layers.0.blocks.${i}.`;
    const hidden = dims[0] * expandRatio;
    convBn(`${p}conv1.`, hidden, dims[0], 1);
    convBn(`${p}conv2.`, hidden, 1, 3);
    convBn(`${p}conv3.`, dims[0], hidden, 1);
  }
  for (let stage = 0; stage < 4; stage += 1) {
    const dim = dims[stage] as number;
    if (stage > 0) {
      for (let i = 0; i < (depths[stage] as number); i += 1) {
        const p = `${e}layers.${stage}.blocks.${i}.`;
        const window = windows[stage] as number;
        add(`${p}attn.attention_biases`, [config.encoder.heads[stage] as number, window * window]);
        norm(`${p}attn.norm.`, dim);
        linear(`${p}attn.qkv.`, 3 * dim, dim);
        linear(`${p}attn.proj.`, dim, dim);
        norm(`${p}mlp.norm.`, dim);
        linear(`${p}mlp.fc1.`, dim * mlpRatio, dim);
        linear(`${p}mlp.fc2.`, dim, dim * mlpRatio);
        convBn(`${p}local_conv.`, dim, 1, 3);
      }
    }
    if (stage < 3) {
      const next = dims[stage + 1] as number;
      const p = `${e}layers.${stage}.downsample.`;
      convBn(`${p}conv1.`, next, dim, 1);
      convBn(`${p}conv2.`, next, 1, 3);
      convBn(`${p}conv3.`, next, next, 1);
    }
  }
  norm(`${e}norm_head.`, dims[3]);
  linear(`${e}head.`, MINIATURE_SAM_CLASSES, dims[3]);
  add(`${e}neck.0.weight`, [neck, dims[3], 1, 1]);
  norm(`${e}neck.1.`, neck);
  add(`${e}neck.2.weight`, [neck, neck, 3, 3]);
  norm(`${e}neck.3.`, neck);

  const { dim, masks, mlp, maskChannels: c, iouHidden, iouDepth } = config.decoder;
  const pe = 'prompt_encoder.';
  add(`${pe}pe_layer.positional_encoding_gaussian_matrix`, [2, dim / 2]);
  for (let i = 0; i < 4; i += 1) add(`${pe}point_embeddings.${i}.weight`, [1, dim]);
  add(`${pe}not_a_point_embed.weight`, [1, dim]);
  add(`${pe}mask_downscaling.0.weight`, [c / 4, 1, 2, 2]);
  add(`${pe}mask_downscaling.0.bias`, [c / 4]);
  norm(`${pe}mask_downscaling.1.`, c / 4);
  add(`${pe}mask_downscaling.3.weight`, [c, c / 4, 2, 2]);
  add(`${pe}mask_downscaling.3.bias`, [c]);
  norm(`${pe}mask_downscaling.4.`, c);
  add(`${pe}mask_downscaling.6.weight`, [dim, c, 1, 1]);
  add(`${pe}mask_downscaling.6.bias`, [dim]);
  add(`${pe}no_mask_embed.weight`, [1, dim]);

  const d = 'mask_decoder.';
  const t = `${d}transformer.`;
  const attention = (p: string, inner: number): void => {
    for (const projection of ['q_proj', 'k_proj', 'v_proj'])
      linear(`${p}${projection}.`, inner, dim);
    linear(`${p}out_proj.`, dim, inner);
  };
  const inner = dim / config.decoder.downsample;
  for (let i = 0; i < config.decoder.depth; i += 1) {
    const p = `${t}layers.${i}.`;
    attention(`${p}self_attn.`, dim);
    norm(`${p}norm1.`, dim);
    attention(`${p}cross_attn_token_to_image.`, inner);
    norm(`${p}norm2.`, dim);
    linear(`${p}mlp.lin1.`, mlp, dim);
    linear(`${p}mlp.lin2.`, dim, mlp);
    norm(`${p}norm3.`, dim);
    norm(`${p}norm4.`, dim);
    attention(`${p}cross_attn_image_to_token.`, inner);
  }
  attention(`${t}final_attn_token_to_image.`, inner);
  norm(`${t}norm_final_attn.`, dim);
  add(`${d}iou_token.weight`, [1, dim]);
  add(`${d}mask_tokens.weight`, [masks, dim]);
  add(`${d}output_upscaling.0.weight`, [dim, dim / 4, 2, 2]);
  add(`${d}output_upscaling.0.bias`, [dim / 4]);
  norm(`${d}output_upscaling.1.`, dim / 4);
  add(`${d}output_upscaling.3.weight`, [dim / 4, dim / 8, 2, 2]);
  add(`${d}output_upscaling.3.bias`, [dim / 8]);
  for (let i = 0; i < masks; i += 1) {
    const p = `${d}output_hypernetworks_mlps.${i}.layers.`;
    linear(`${p}0.`, dim, dim);
    linear(`${p}1.`, dim, dim);
    linear(`${p}2.`, dim / 8, dim);
  }
  const sizes = [dim, ...Array.from({ length: iouDepth - 1 }, () => iouHidden), masks];
  for (let i = 0; i + 1 < sizes.length; i += 1) {
    linear(`${d}iou_prediction_head.layers.${i}.`, sizes[i + 1] as number, sizes[i] as number);
  }
  return out;
}
