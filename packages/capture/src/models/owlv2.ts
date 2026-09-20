/**
 * OWLv2: boxes for things named in words, in two graphs — the image's, run once a frame, and the
 * text's, run once a set of queries — which the host joins (`owlv2Detect.ts`).
 *
 * **Both are CLIP's transformer**: pre-norm layers of attention and a perceptron whose activation is
 * `x·σ(1.702·x)`, every norm at PyTorch's ε. The image is cut into patches of 16, a class token put
 * first, and after the last layer each patch is multiplied by the class token and normed again;
 * from that come a class embedding, a logit shift and scale, a box and an objectness, each a patch.
 * A box is the upstream's: a perceptron's four numbers plus the patch's own prior — the logit of its
 * corner and of the grid's cell size — through the logistic, a centre and a size in the image.
 *
 * **The text reads its queries causally** — `clipTower.ts` holds that mask — and each query is
 * read at the row of its end-of-text token, which is what the upstream pools.
 *
 * **The tokenizer travels in the text graph**, as `tokenizer.merges`, which no node reads.
 */
import type { Architecture } from '@driftengine/texture';
import { exactLog } from '@driftengine/core';

import { clipLayers, type ClipTowerConfig } from './clipTower.ts';

export interface Owlv2Config {
  /** The side the image graph takes an image at. */
  readonly size: number;
  readonly patch: number;
  readonly vision: ClipTowerConfig;
  /**
   * The text tower, and how many tokens a query may be. Its width is also the class embedding's and
   * the projected query's, which the upstream's class head and projection each take from it.
   */
  readonly text: ClipTowerConfig & { readonly positions: number };
}

export const OWLV2_BASE: Owlv2Config = {
  size: 960,
  patch: 16,
  vision: { dim: 768, heads: 12, depth: 12, hidden: 3072 },
  text: { dim: 512, heads: 8, depth: 12, hidden: 2048, positions: 16 },
};

/** The pixel mean and deviation an image is normalised by, CLIP's, in 0–1 RGB. */
export const OWLV2_PIXEL_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
export const OWLV2_PIXEL_STD = [0.26862954, 0.26130258, 0.27577711] as const;

const EPSILON = 1e-5;
const f = Math.fround;

/** `[x, y, w, h]` for every cell, row by row: the logits of its far corner and of the cell's size. */
export function owlv2BoxBias(grid: number): Float32Array {
  /* The upstream's order of roundings: log(c + 1e-4) − log1p(−c + 1e-4), every step single. */
  const offset = f(1e-4);
  const logit = (c: number): number =>
    f(f(exactLog(f(c + offset))) - f(exactLog(1 + f(-c + offset))));
  const size = logit(f(1 / grid));
  const out = new Float32Array(grid * grid * 4);
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const at = (row * grid + col) * 4;
      out[at] = logit(f((col + 1) / grid));
      out[at + 1] = logit(f((row + 1) / grid));
      out[at + 2] = size;
      out[at + 3] = size;
    }
  }
  return out;
}

const TEXT = 'owlv2.text_model.';
const VISION = 'owlv2.vision_model.';

/**
 * `image`, `[3, size, size]`, to five values a patch: `classes`, `[cells, text.dim]`, the class
 * embedding before it is normalised; `shift` and `scale`, `[cells, 1]`, the logit's shift and its
 * scale before the ELU; `boxes`, `[cells, 4]`, centre and size in the image's fractions; and
 * `objectness`, `[cells, 1]`, a logit.
 */
export function owlv2Image(config: Owlv2Config): Architecture {
  return (weights, graph) => {
    for (const aside of [TEXT, 'owlv2.text_projection.weight', 'owlv2.visual_projection.weight']) {
      weights.ignore(aside);
    }
    weights.ignore('owlv2.logit_scale');
    weights.ignore('tokenizer.merges');
    const node = graph.node.bind(graph);
    const { dim } = config.vision;
    const grid = config.size / config.patch;
    const cells = grid * grid;
    const read = weights.read.bind(weights);
    const norm = (value: string, p: string): string =>
      node('layerNorm', [value, read(`${p}.weight`, [dim]), read(`${p}.bias`, [dim])], {
        epsilon: EPSILON,
      });
    const linear = (value: string, p: string, out: number, output?: string): string =>
      node(
        'linear',
        [value, read(`${p}.weight`, [out, dim]), read(`${p}.bias`, [out])],
        {},
        output,
      );

    const patches = node(
      'patchEmbed',
      [
        'image',
        read(`${VISION}embeddings.patch_embedding.weight`, [dim, 3, config.patch, config.patch]),
      ],
      { patch: config.patch },
    );
    const cls = node('reshape', [read(`${VISION}embeddings.class_embedding`, [dim])], {
      shape: [1, dim],
    });
    let x = node('add', [
      node('concat', [cls, patches], { axis: 0 }),
      read(`${VISION}embeddings.position_embedding.weight`, [cells + 1, dim]),
    ]);
    x = norm(x, `${VISION}pre_layernorm`);
    x = clipLayers(weights, graph, VISION, config.vision, x, 1, cells + 1, false);
    x = norm(x, `${VISION}post_layernorm`);
    const token = node('reshape', [node('slice', [x], { axis: 0, start: 0, end: 1 })], {
      shape: [dim],
    });
    const features = norm(
      node('mul', [node('slice', [x], { axis: 0, start: 1, end: cells + 1 }), token]),
      'layer_norm',
    );

    linear(features, 'class_head.dense0', config.text.dim, 'classes');
    linear(features, 'class_head.logit_shift', 1, 'shift');
    linear(features, 'class_head.logit_scale', 1, 'scale');
    const head = (p: string, out: number, output?: string): string => {
      const inner = node('gelu', [
        linear(node('gelu', [linear(features, `${p}.dense0`, dim)]), `${p}.dense1`, dim),
      ]);
      return linear(inner, `${p}.dense2`, out, output);
    };
    const bias = weights.constant(`box_bias.${grid}`, [cells, 4], owlv2BoxBias(grid));
    graph.node('sigmoid', [node('add', [head('box_head', 4), bias])], {}, 'boxes');
    head('objectness_head', 1, 'objectness');
    return {
      inputs: [{ name: 'image', shape: [3, config.size, config.size] }],
      outputs: ['classes', 'shift', 'scale', 'boxes', 'objectness'],
    };
  };
}

/**
 * `tokens`, `[queries · positions]`, and `ends`, `[queries]`, as `owlv2Tokens` makes them, to
 * `queries`, `[queries, text.dim]`: each query's embedding before it is normalised.
 */
export function owlv2Text(config: Owlv2Config, queries: number): Architecture {
  return (weights, graph) => {
    for (const aside of [VISION, 'owlv2.visual_projection.weight', 'owlv2.logit_scale']) {
      weights.ignore(aside);
    }
    for (const aside of ['class_head.', 'box_head.', 'objectness_head.', 'layer_norm.']) {
      weights.ignore(aside);
    }
    weights.read('tokenizer.merges');
    const node = graph.node.bind(graph);
    const { dim, positions } = config.text;
    const read = weights.read.bind(weights);

    const embedded = node('gather', [read(`${TEXT}embeddings.token_embedding.weight`), 'tokens']);
    const placed = node('add', [
      node('reshape', [embedded], { shape: [queries, positions * dim] }),
      node('reshape', [read(`${TEXT}embeddings.position_embedding.weight`, [positions, dim])], {
        shape: [positions * dim],
      }),
    ]);
    let x = node('reshape', [placed], { shape: [queries * positions, dim] });
    x = clipLayers(weights, graph, TEXT, config.text, x, queries, positions, true);
    x = node(
      'layerNorm',
      [
        node('gather', [x, 'ends']),
        read(`${TEXT}final_layer_norm.weight`, [dim]),
        read(`${TEXT}final_layer_norm.bias`, [dim]),
      ],
      { epsilon: EPSILON },
    );
    graph.node('linear', [x, read('owlv2.text_projection.weight', [dim, dim])], {}, 'queries');
    return {
      inputs: [
        { name: 'tokens', shape: [queries * positions] },
        { name: 'ends', shape: [queries] },
      ],
      outputs: ['queries'],
    };
  };
}
