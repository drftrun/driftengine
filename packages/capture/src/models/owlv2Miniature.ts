/**
 * A seeded miniature of OWLv2: every tensor name of the upstream's detector, at a size the CPU
 * evaluates in a moment — what the model's tests and its hand-run oracle share.
 *
 * **Small where the upstream lets it be**: a 64-pixel image in patches of 16, so a grid of four;
 * towers two layers deep of 32 and 24 channels in two heads. **The text keeps
 * the upstream's 16 positions**, since a query's length is what its causal mask and its pooling are
 * about, and the vocabulary is three merges' worth — 517 tokens — which is also the tokenizer's
 * hand-worked table (`clipTokenizer.test.ts`).
 */
import type { GraphTensor } from '@driftengine/texture';

import type { Owlv2Config } from './owlv2.ts';
import { draw } from './seeded.ts';

export const MINIATURE_OWLV2: Owlv2Config = {
  size: 64,
  patch: 16,
  vision: { dim: 32, heads: 2, depth: 2, hidden: 48 },
  text: { dim: 24, heads: 2, depth: 2, hidden: 40, positions: 16 },
};

/** c+a, ca+t</w> and a+t</w>: tokens 512 to 514, and the start and end of text 515 and 516. */
export const MINIATURE_OWLV2_MERGES = Float32Array.of(66, 64, 512, 339, 64, 339);

/**
 * Three queries as token ids: one ending early, one with the padding token inside it — the "!" a
 * text may hold — and one filling every position.
 */
export const MINIATURE_OWLV2_QUERIES: readonly (readonly number[])[] = [
  [515, 513, 516],
  [515, 83, 514, 0, 320, 513, 516],
  [515, 10, 200, 300, 400, 500, 511, 512, 1, 2, 3, 100, 250, 350, 450, 516],
];

/** The original image's size the boxes are scaled to: wider than tall, padded below. */
export const MINIATURE_OWLV2_IMAGE = { height: 36, width: 48 } as const;

/** Every tensor the upstream's `Owlv2ForObjectDetection` holds, named as its checkpoints are. */
export function miniatureOwlv2Checkpoint(
  config: Owlv2Config,
  seed: number,
): Map<string, GraphTensor> {
  const out = new Map<string, GraphTensor>();
  const add = (name: string, shape: readonly number[]): void => {
    out.set(name, { shape, data: draw(name, shape, seed) });
  };
  const tower = (prefix: string, dim: number, hidden: number, depth: number): void => {
    for (let i = 0; i < depth; i += 1) {
      const p = `${prefix}encoder.layers.${i}.`;
      for (const norm of ['layer_norm1', 'layer_norm2']) {
        add(`${p}${norm}.weight`, [dim]);
        add(`${p}${norm}.bias`, [dim]);
      }
      for (const projection of ['q_proj', 'k_proj', 'v_proj', 'out_proj']) {
        add(`${p}self_attn.${projection}.weight`, [dim, dim]);
        add(`${p}self_attn.${projection}.bias`, [dim]);
      }
      add(`${p}mlp.fc1.weight`, [hidden, dim]);
      add(`${p}mlp.fc1.bias`, [hidden]);
      add(`${p}mlp.fc2.weight`, [dim, hidden]);
      add(`${p}mlp.fc2.bias`, [dim]);
    }
  };
  const { vision, text, patch } = config;
  const cells = (config.size / patch) * (config.size / patch);
  const t = 'owlv2.text_model.';
  add(`${t}embeddings.token_embedding.weight`, [
    512 + MINIATURE_OWLV2_MERGES.length / 2 + 2,
    text.dim,
  ]);
  add(`${t}embeddings.position_embedding.weight`, [text.positions, text.dim]);
  tower(t, text.dim, text.hidden, text.depth);
  add(`${t}final_layer_norm.weight`, [text.dim]);
  add(`${t}final_layer_norm.bias`, [text.dim]);
  const v = 'owlv2.vision_model.';
  add(`${v}embeddings.class_embedding`, [vision.dim]);
  add(`${v}embeddings.patch_embedding.weight`, [vision.dim, 3, patch, patch]);
  add(`${v}embeddings.position_embedding.weight`, [cells + 1, vision.dim]);
  for (const norm of ['pre_layernorm', 'post_layernorm']) {
    add(`${v}${norm}.weight`, [vision.dim]);
    add(`${v}${norm}.bias`, [vision.dim]);
  }
  tower(v, vision.dim, vision.hidden, vision.depth);
  add('owlv2.visual_projection.weight', [text.dim, vision.dim]);
  add('owlv2.text_projection.weight', [text.dim, text.dim]);
  add('owlv2.logit_scale', []);
  add('layer_norm.weight', [vision.dim]);
  add('layer_norm.bias', [vision.dim]);
  add('class_head.dense0.weight', [text.dim, vision.dim]);
  add('class_head.dense0.bias', [text.dim]);
  for (const logit of ['logit_shift', 'logit_scale']) {
    add(`class_head.${logit}.weight`, [1, vision.dim]);
    add(`class_head.${logit}.bias`, [1]);
  }
  for (const [head, last] of [
    ['box_head', 4],
    ['objectness_head', 1],
  ] as const) {
    add(`${head}.dense0.weight`, [vision.dim, vision.dim]);
    add(`${head}.dense0.bias`, [vision.dim]);
    add(`${head}.dense1.weight`, [vision.dim, vision.dim]);
    add(`${head}.dense1.bias`, [vision.dim]);
    add(`${head}.dense2.weight`, [last, vision.dim]);
    add(`${head}.dense2.bias`, [last]);
  }
  return out;
}
