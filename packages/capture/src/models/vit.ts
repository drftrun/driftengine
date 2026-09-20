/**
 * Depth Anything 3's backbone: DINOv2 as that model runs it, over one view or several at once.
 *
 * **Plain DINOv2 until `altStart`, and something else after it**, which is why this is not a
 * generic vision transformer. From that block the class token of every view is replaced by a
 * learned camera token — one for the first view, the reference, and another for the rest — and
 * blocks alternate: an even one attends within each view, an odd one across all views at once.
 * From `qkNormStart` each head's queries and keys are layer-normed, and from `ropeStart` they are
 * turned by a two-dimensional rotary embedding: by the patch's row and column within a view, and
 * across views by one position shared by every patch, so the global blocks see no geometry but
 * which view a token belongs to.
 *
 * **Each tap is the last within-view output beside the current one**, `2·dim` wide, with only the
 * second half normed — the upstream's `cat_token` — and its first token kept apart as that view's
 * camera token, unnormed, which the camera decoder reads.
 *
 * **The positional embeddings are resized as the upstream resizes them**: bicubically, by the scale
 * factor `(grid + 0.1)/trained`, whose inverse is the step a sample moves — not the ratio of the
 * sizes. Only a square image at the trained grid skips it. The block norms take ε = 1e-6 and every
 * other norm here PyTorch's default, 1e-5, which is a difference the checkpoint was trained with.
 *
 * What it gives up: the upstream reorders views around a chosen reference once there are three or
 * more; here the first view given is the reference, and choosing it is the caller's.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

import { applyRope, ropeConstants } from './rope.ts';

export interface VitConfig {
  readonly dim: number;
  readonly heads: number;
  readonly depth: number;
  readonly hidden: number;
  readonly patch: number;
  /** The patch grid the positional embeddings were trained at: 518 / 14 = 37. */
  readonly trainedGrid: number;
  readonly taps: readonly number[];
  readonly altStart: number;
  readonly qkNormStart: number;
  readonly ropeStart: number;
}

export interface VitOutput {
  /** Per tap, per view: the patch tokens, `[rows · cols, 2 · dim]`. */
  readonly features: readonly (readonly string[])[];
  /** Per tap: every view's camera token, `[views, 2 · dim]`. */
  readonly cameras: readonly string[];
}

/** Block norms are trained with ε = 1e-6; the rest keep PyTorch's default. */
const BLOCK_EPSILON = 1e-6;
const DEFAULT_EPSILON = 1e-5;

export function vitBackbone(
  weights: Weights,
  graph: GraphBuilder,
  config: VitConfig,
  prefix: string,
  images: readonly string[],
  rows: number,
  cols: number,
): VitOutput {
  const { dim, heads } = config;
  const headDim = dim / heads;
  const patches = rows * cols;
  const tokens = patches + 1;
  const w = (name: string, shape: readonly number[]): string =>
    weights.read(`${prefix}${name}`, shape);
  const node = graph.node.bind(graph);

  /* Positions, resized to this grid unless it is the trained one on a square image. */
  const trained = config.trainedGrid;
  const table = node('reshape', [w('pos_embed', [1, trained * trained + 1, dim])], {
    shape: [trained * trained + 1, dim],
  });
  let positions = table;
  if (rows !== trained || cols !== trained) {
    const grid = node(
      'permute',
      [
        node(
          'reshape',
          [node('slice', [table], { axis: 0, start: 1, end: trained * trained + 1 })],
          {
            shape: [trained, trained, dim],
          },
        ),
      ],
      { order: [2, 0, 1] },
    );
    const resized = node('resize', [grid], {
      height: rows,
      width: cols,
      mode: 'bicubic',
      alignCorners: false,
      stepHeight: trained / (rows + 0.1),
      stepWidth: trained / (cols + 0.1),
    });
    const flat = node('reshape', [node('permute', [resized], { order: [1, 2, 0] })], {
      shape: [patches, dim],
    });
    positions = node('concat', [node('slice', [table], { axis: 0, start: 0, end: 1 }), flat], {
      axis: 0,
    });
  }

  const cls = node('reshape', [w('cls_token', [1, 1, dim])], { shape: [1, dim] });
  let views = images.map((image) => {
    const embedded = node(
      'patchEmbed',
      [
        image,
        w('patch_embed.proj.weight', [dim, 3, config.patch, config.patch]),
        w('patch_embed.proj.bias', [dim]),
      ],
      { patch: config.patch },
    );
    return node('add', [node('concat', [cls, embedded], { axis: 0 }), positions]);
  });

  /* Rotary tables: within a view by row and column from 1, across views all patches at 1, 1. */
  const local = new Int32Array(2 * tokens);
  const global = new Int32Array(2 * tokens * images.length);
  for (let p = 0; p < patches; p += 1) {
    local[2 * (p + 1)] = Math.floor(p / cols) + 1;
    local[2 * (p + 1) + 1] = (p % cols) + 1;
  }
  for (let v = 0; v < images.length; v += 1) {
    for (let p = 1; p < tokens; p += 1)
      global.fill(1, 2 * (v * tokens + p), 2 * (v * tokens + p) + 2);
  }
  const rope =
    config.ropeStart >= 0
      ? {
          local: ropeConstants(weights, 'rope.local', local, heads, headDim),
          global: ropeConstants(weights, 'rope.global', global, heads, headDim),
        }
      : null;

  const block = (i: number, x: string, count: number, across: boolean): string => {
    const p = `blocks.${i}.`;
    const h = node('layerNorm', [x, w(`${p}norm1.weight`, [dim]), w(`${p}norm1.bias`, [dim])], {
      epsilon: BLOCK_EPSILON,
    });
    const qkv = node('linear', [
      h,
      w(`${p}attn.qkv.weight`, [3 * dim, dim]),
      w(`${p}attn.qkv.bias`, [3 * dim]),
    ]);
    let q = node('slice', [qkv], { axis: 1, start: 0, end: dim });
    let k = node('slice', [qkv], { axis: 1, start: dim, end: 2 * dim });
    const v = node('slice', [qkv], { axis: 1, start: 2 * dim, end: 3 * dim });
    if (config.qkNormStart >= 0 && i >= config.qkNormStart) {
      const perHead = (value: string, norm: string): string =>
        node(
          'reshape',
          [
            node(
              'layerNorm',
              [
                node('reshape', [value], { shape: [count * heads, headDim] }),
                w(`${p}attn.${norm}.weight`, [headDim]),
                w(`${p}attn.${norm}.bias`, [headDim]),
              ],
              { epsilon: DEFAULT_EPSILON },
            ),
          ],
          { shape: [count, dim] },
        );
      q = perHead(q, 'q_norm');
      k = perHead(k, 'k_norm');
    }
    if (rope !== null && i >= config.ropeStart) {
      const tables = across ? rope.global : rope.local;
      q = applyRope(graph, q, count, heads, headDim, tables.cos, tables.sin);
      k = applyRope(graph, k, count, heads, headDim, tables.cos, tables.sin);
    }
    const attended = node('attention', [q, k, v], { heads });
    const projected = node('linear', [
      attended,
      w(`${p}attn.proj.weight`, [dim, dim]),
      w(`${p}attn.proj.bias`, [dim]),
    ]);
    const x1 = node('add', [x, node('mul', [projected, w(`${p}ls1.gamma`, [dim])])]);
    const h2 = node('layerNorm', [x1, w(`${p}norm2.weight`, [dim]), w(`${p}norm2.bias`, [dim])], {
      epsilon: BLOCK_EPSILON,
    });
    const inner = node('gelu', [
      node('linear', [
        h2,
        w(`${p}mlp.fc1.weight`, [config.hidden, dim]),
        w(`${p}mlp.fc1.bias`, [config.hidden]),
      ]),
    ]);
    const out = node('linear', [
      inner,
      w(`${p}mlp.fc2.weight`, [dim, config.hidden]),
      w(`${p}mlp.fc2.bias`, [dim]),
    ]);
    return node('add', [x1, node('mul', [out, w(`${p}ls2.gamma`, [dim])])]);
  };

  const features: string[][] = [];
  const cameras: string[] = [];
  let latest = views;
  for (let i = 0; i < config.depth; i += 1) {
    if (config.altStart >= 0 && i === config.altStart) {
      const camera = node('reshape', [w('camera_token', [1, 2, dim])], { shape: [2, dim] });
      const reference = node('slice', [camera], { axis: 0, start: 0, end: 1 });
      const source = node('slice', [camera], { axis: 0, start: 1, end: 2 });
      views = views.map((x, v) =>
        node(
          'concat',
          [v === 0 ? reference : source, node('slice', [x], { axis: 0, start: 1, end: tokens })],
          { axis: 0 },
        ),
      );
    }
    const across = config.altStart >= 0 && i >= config.altStart && i % 2 === 1;
    if (across) {
      const all = views.length === 1 ? (views[0] as string) : node('concat', views, { axis: 0 });
      const mixed = block(i, all, tokens * views.length, true);
      views = views.map((_, v) =>
        views.length === 1
          ? mixed
          : node('slice', [mixed], { axis: 0, start: v * tokens, end: (v + 1) * tokens }),
      );
    } else {
      views = views.map((x) => block(i, x, tokens, false));
      latest = views;
    }
    if (config.taps.includes(i)) {
      const tapped = views.map((x, v) => node('concat', [latest[v] as string, x], { axis: 1 }));
      cameras.push(
        tapped.length === 1
          ? node('slice', [tapped[0] as string], { axis: 0, start: 0, end: 1 })
          : node(
              'concat',
              tapped.map((t) => node('slice', [t], { axis: 0, start: 0, end: 1 })),
              { axis: 0 },
            ),
      );
      features.push(
        tapped.map((t) => {
          const normed = node(
            'layerNorm',
            [
              node('slice', [t], { axis: 1, start: dim, end: 2 * dim }),
              w('norm.weight', [dim]),
              w('norm.bias', [dim]),
            ],
            { epsilon: DEFAULT_EPSILON },
          );
          const joined = node(
            'concat',
            [node('slice', [t], { axis: 1, start: 0, end: dim }), normed],
            { axis: 1 },
          );
          return node('slice', [joined], { axis: 0, start: 1, end: tokens });
        }),
      );
    }
  }
  return { features, cameras };
}
