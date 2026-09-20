/**
 * A seeded miniature of Depth Anything 3: the upstream's layout, every tensor name and shape of it,
 * at a size small enough to evaluate on the CPU in milliseconds.
 *
 * **It is what the model's tests and its hand-run oracle share.** The oracle loads this checkpoint
 * into the upstream's own modules — strictly, so a name or shape that differs from theirs fails
 * there — and runs their code; the tests run the same checkpoint through the definition here and
 * compare. So the numbers a test asserts come from an implementation that is not the one under
 * test, and no weights are downloaded or committed: the checkpoint is a function of a seed.
 *
 * **Every tensor the upstream holds is here, those the definition sets aside included** — the ray
 * branch and, since it would only be loaded to be ignored, not the camera encoder, which the
 * oracle does not build. Shipped, as `@driftengine/nav`'s test field is, because a consumer
 * checking a port of their own wants the same fixture.
 */
import { mulberry32 } from '@driftengine/core';
import type { GraphTensor } from '@driftengine/texture';

import type { DepthAnything2Config } from './depthAnything2.ts';
import type { DepthAnything3Config } from './depthAnything3.ts';
import { draw, nameSeed } from './seeded.ts';

/**
 * Four blocks of 32 channels in four heads of 8 — the smallest a two-dimensional rotary embedding
 * divides — with the camera token, query-key norms and rotary embedding from the third block, so
 * one within-view and one across-view block each carry all three; a trained grid of 2, so any other
 * grid is resized; and a head of 16 features.
 */
export const MINIATURE_DEPTH_ANYTHING_3: DepthAnything3Config = {
  backbone: {
    dim: 32,
    heads: 4,
    depth: 4,
    hidden: 128,
    patch: 14,
    trainedGrid: 2,
    taps: [0, 1, 2, 3],
    altStart: 2,
    qkNormStart: 2,
    ropeStart: 2,
  },
  head: { dimIn: 64, features: 16, outChannels: [4, 8, 8, 16], outputDim: 2, patch: 14 },
};

/** The seed the tests and the oracle share. */
export const MINIATURE_SEED = 20260919;

/** One view on a grid its positions are resized to, and two views on the trained grid. */
export const MINIATURE_CASES = {
  single: { views: 1, height: 28, width: 42 },
  pair: { views: 2, height: 28, width: 28 },
} as const;

/** Every tensor the upstream's backbone, head and camera decoder hold, named as the checkpoints are. */
export function miniatureCheckpoint(
  config: DepthAnything3Config,
  seed: number,
): Map<string, GraphTensor> {
  const out = new Map<string, GraphTensor>();
  const add = (name: string, shape: readonly number[]): void => {
    out.set(name, { shape, data: draw(name, shape, seed) });
  };
  const { dim, heads, depth, hidden, patch, trainedGrid } = config.backbone;
  const b = 'model.backbone.pretrained.';
  add(`${b}cls_token`, [1, 1, dim]);
  add(`${b}camera_token`, [1, 2, dim]);
  add(`${b}pos_embed`, [1, trainedGrid * trainedGrid + 1, dim]);
  add(`${b}patch_embed.proj.weight`, [dim, 3, patch, patch]);
  add(`${b}patch_embed.proj.bias`, [dim]);
  for (let i = 0; i < depth; i += 1) {
    const p = `${b}blocks.${i}.`;
    add(`${p}norm1.weight`, [dim]);
    add(`${p}norm1.bias`, [dim]);
    add(`${p}attn.qkv.weight`, [3 * dim, dim]);
    add(`${p}attn.qkv.bias`, [3 * dim]);
    if (i >= config.backbone.qkNormStart) {
      for (const norm of ['q_norm', 'k_norm']) {
        add(`${p}attn.${norm}.weight`, [dim / heads]);
        add(`${p}attn.${norm}.bias`, [dim / heads]);
      }
    }
    add(`${p}attn.proj.weight`, [dim, dim]);
    add(`${p}attn.proj.bias`, [dim]);
    add(`${p}ls1.gamma`, [dim]);
    add(`${p}norm2.weight`, [dim]);
    add(`${p}norm2.bias`, [dim]);
    add(`${p}mlp.fc1.weight`, [hidden, dim]);
    add(`${p}mlp.fc1.bias`, [hidden]);
    add(`${p}mlp.fc2.weight`, [dim, hidden]);
    add(`${p}mlp.fc2.bias`, [dim]);
    add(`${p}ls2.gamma`, [dim]);
  }
  add(`${b}norm.weight`, [dim]);
  add(`${b}norm.bias`, [dim]);

  const h = 'model.head.';
  const { dimIn, features, outChannels, outputDim } = config.head;
  const conv = (name: string, to: number, from: number, kernel: number, bias = true): void => {
    add(`${name}.weight`, [to, from, kernel, kernel]);
    if (bias) add(`${name}.bias`, [to]);
  };
  add(`${h}norm.weight`, [dimIn]);
  add(`${h}norm.bias`, [dimIn]);
  outChannels.forEach((channels, k) => {
    conv(`${h}projects.${k}`, channels, dimIn, 1);
    conv(`${h}scratch.layer${k + 1}_rn`, features, channels, 3, false);
  });
  conv(`${h}resize_layers.0`, outChannels[0], outChannels[0], 4);
  conv(`${h}resize_layers.1`, outChannels[1], outChannels[1], 2);
  conv(`${h}resize_layers.3`, outChannels[3], outChannels[3], 3);
  for (const branch of ['', '_aux']) {
    for (let level = 1; level <= 4; level += 1) {
      const r = `${h}scratch.refinenet${level}${branch}.`;
      for (const unit of level === 4 ? ['resConfUnit2'] : ['resConfUnit1', 'resConfUnit2']) {
        conv(`${r}${unit}.conv1`, features, features, 3);
        conv(`${r}${unit}.conv2`, features, features, 3);
      }
      conv(`${r}out_conv`, features, features, 1);
    }
  }
  conv(`${h}scratch.output_conv1`, features / 2, features, 3);
  conv(`${h}scratch.output_conv2.0`, 32, features / 2, 3);
  conv(`${h}scratch.output_conv2.2`, outputDim, 32, 1);
  for (let level = 0; level < 4; level += 1) {
    const widths = [features / 2, features, features / 2, features, features / 2];
    widths.forEach((to, n) => {
      conv(
        `${h}scratch.output_conv1_aux.${level}.${n}`,
        to,
        n === 0 ? features : (widths[n - 1] as number),
        3,
      );
    });
    conv(`${h}scratch.output_conv2_aux.${level}.0`, 32, features / 2, 3);
    add(`${h}scratch.output_conv2_aux.${level}.2.weight`, [32]);
    add(`${h}scratch.output_conv2_aux.${level}.2.bias`, [32]);
    conv(`${h}scratch.output_conv2_aux.${level}.5`, 7, 32, 1);
  }

  const c = 'model.cam_dec.';
  const wide = 2 * dim;
  for (const [name, to] of [
    ['backbone.0', wide],
    ['backbone.2', wide],
    ['fc_t', 3],
    ['fc_qvec', 4],
    ['fc_fov.0', 2],
  ] as const) {
    add(`${c}${name}.weight`, [to, wide]);
    add(`${c}${name}.bias`, [to]);
  }
  return out;
}

/**
 * Depth Anything V2 in miniature: four blocks of 32 channels in four heads, every block tapped, a
 * trained grid of 2, and a neck and head of 16 and 8.
 */
export const MINIATURE_DEPTH_ANYTHING_2: DepthAnything2Config = {
  dim: 32,
  heads: 4,
  depth: 4,
  hidden: 128,
  patch: 14,
  trainedGrid: 2,
  taps: [0, 1, 2, 3],
  neck: [4, 8, 8, 16],
  fusion: 16,
  headHidden: 8,
};

/** Every tensor Transformers' Depth Anything holds, in the older names its checkpoints keep. */
export function miniatureCheckpoint2(
  config: DepthAnything2Config,
  seed: number,
): Map<string, GraphTensor> {
  const out = new Map<string, GraphTensor>();
  const add = (name: string, shape: readonly number[]): void => {
    out.set(name, { shape, data: draw(name, shape, seed) });
  };
  const pair = (name: string, to: number, from: number): void => {
    add(`${name}.weight`, [to, from]);
    add(`${name}.bias`, [to]);
  };
  const conv = (name: string, to: number, from: number, kernel: number, bias = true): void => {
    add(`${name}.weight`, [to, from, kernel, kernel]);
    if (bias) add(`${name}.bias`, [to]);
  };
  const { dim, depth, hidden, patch, trainedGrid, neck, fusion, headHidden } = config;
  const e = 'backbone.embeddings.';
  add(`${e}cls_token`, [1, 1, dim]);
  add(`${e}mask_token`, [1, dim]);
  add(`${e}position_embeddings`, [1, trainedGrid * trainedGrid + 1, dim]);
  conv(`${e}patch_embeddings.projection`, dim, 3, patch);
  for (let i = 0; i < depth; i += 1) {
    const p = `backbone.encoder.layer.${i}.`;
    add(`${p}norm1.weight`, [dim]);
    add(`${p}norm1.bias`, [dim]);
    for (const part of ['query', 'key', 'value']) pair(`${p}attention.attention.${part}`, dim, dim);
    pair(`${p}attention.output.dense`, dim, dim);
    add(`${p}layer_scale1.lambda1`, [dim]);
    add(`${p}norm2.weight`, [dim]);
    add(`${p}norm2.bias`, [dim]);
    pair(`${p}mlp.fc1`, hidden, dim);
    pair(`${p}mlp.fc2`, dim, hidden);
    add(`${p}layer_scale2.lambda1`, [dim]);
  }
  add('backbone.layernorm.weight', [dim]);
  add('backbone.layernorm.bias', [dim]);
  neck.forEach((channels, k) => {
    const r = `neck.reassemble_stage.layers.${k}.`;
    conv(`${r}projection`, channels, dim, 1);
    if (k !== 2) conv(`${r}resize`, channels, channels, k === 0 ? 4 : k === 1 ? 2 : 3);
    conv(`neck.convs.${k}`, fusion, channels, 3, false);
  });
  for (let n = 0; n < 4; n += 1) {
    const name = `neck.fusion_stage.layers.${n}`;
    conv(`${name}.projection`, fusion, fusion, 1);
    for (const unit of ['residual_layer1', 'residual_layer2']) {
      conv(`${name}.${unit}.convolution1`, fusion, fusion, 3);
      conv(`${name}.${unit}.convolution2`, fusion, fusion, 3);
    }
  }
  conv('head.conv1', fusion / 2, fusion, 3);
  conv('head.conv2', headHidden, fusion / 2, 3);
  conv('head.conv3', 1, headHidden, 1);
  return out;
}

/** Seeded images for `views` views, normalised as the model expects, `[3, height, width]` each. */
export function miniatureImages(
  views: number,
  height: number,
  width: number,
  seed: number,
): Float32Array[] {
  return Array.from({ length: views }, (_, v) => {
    const next = mulberry32(nameSeed(`image${v}`, seed));
    return Float32Array.from({ length: 3 * height * width }, () => (next() * 2 - 1) * 2);
  });
}
