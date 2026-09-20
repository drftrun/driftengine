/**
 * Depth Anything V2 Small, the lighter fallback: plain DINOv2 and a DPT, in the Transformers layout
 * its Apache-2.0 checkpoint is published in.
 *
 * **Plain where Depth Anything 3 is not**: one view, no camera token, no query-key norms, no rotary
 * embedding, and positions resized to the grid by the ratio of the sizes, as Transformers' DINOv2
 * resizes them. Four taps — after the third, sixth, ninth and twelfth blocks, each through the
 * backbone's last norm — are reassembled into a pyramid and fused as Depth Anything 3's head fuses
 * its own, without the sinusoidal positions that head adds. The output is one channel through a
 * rectifier: relative inverse depth, larger nearer, with no scale.
 *
 * **The checkpoint keeps Transformers' older names** — `attention.attention.query`,
 * `layer_scale1.lambda1` — which the library renames as it loads; this reads them as stored. Its
 * mask token is for training and set aside, and so is the first fusion block's lateral unit, which
 * the upstream builds and never runs because the coarsest level has no level below it.
 */
import type { Architecture } from '@driftengine/texture';

export interface DepthAnything2Config {
  readonly dim: number;
  readonly heads: number;
  readonly depth: number;
  readonly hidden: number;
  readonly patch: number;
  readonly trainedGrid: number;
  /** The blocks whose outputs are tapped, counted from zero. */
  readonly taps: readonly [number, number, number, number];
  readonly neck: readonly [number, number, number, number];
  readonly fusion: number;
  readonly headHidden: number;
}

/** The checkpoint's configuration at its pinned revision. */
export const DEPTH_ANYTHING_2_SMALL: DepthAnything2Config = {
  dim: 384,
  heads: 6,
  depth: 12,
  hidden: 1536,
  patch: 14,
  trainedGrid: 37,
  taps: [2, 5, 8, 11],
  neck: [48, 96, 192, 384],
  fusion: 64,
  headHidden: 32,
};

/** Transformers' DINOv2 trains every norm at ε = 1e-6. */
const EPSILON = 1e-6;

/**
 * The graph for one image of `height × width` pixels, each a multiple of the patch, normalised by
 * ImageNet's mean and deviation: input `image`, `[3, height, width]`; output `depth`,
 * `[1, height, width]`.
 */
export function depthAnything2(
  config: DepthAnything2Config,
  height: number,
  width: number,
): Architecture {
  const rows = height / config.patch;
  const cols = width / config.patch;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
    throw new RangeError(
      `${height} × ${width} is not a whole number of ${config.patch}-pixel patches`,
    );
  }
  return (weights, graph) => {
    const { dim, heads, trainedGrid } = config;
    const node = graph.node.bind(graph);
    const w = (name: string, shape: readonly number[]): string => weights.read(name, shape);
    const linear = (x: string, name: string, to: number, from: number): string =>
      node('linear', [x, w(`${name}.weight`, [to, from]), w(`${name}.bias`, [to])]);
    const conv = (
      x: string,
      name: string,
      to: number,
      from: number,
      kernel: number,
      attributes = {},
      bias = true,
    ): string =>
      node(
        'conv2d',
        bias
          ? [x, w(`${name}.weight`, [to, from, kernel, kernel]), w(`${name}.bias`, [to])]
          : [x, w(`${name}.weight`, [to, from, kernel, kernel])],
        attributes,
      );
    weights.ignore('backbone.embeddings.mask_token');
    weights.ignore('neck.fusion_stage.layers.0.residual_layer1.');

    const e = 'backbone.embeddings.';
    const patches = rows * cols;
    const tokens = patches + 1;
    const table = node(
      'reshape',
      [w(`${e}position_embeddings`, [1, trainedGrid * trainedGrid + 1, dim])],
      {
        shape: [trainedGrid * trainedGrid + 1, dim],
      },
    );
    let positions = table;
    if (rows !== trainedGrid || cols !== trainedGrid) {
      const grid = node(
        'permute',
        [
          node(
            'reshape',
            [node('slice', [table], { axis: 0, start: 1, end: trainedGrid * trainedGrid + 1 })],
            {
              shape: [trainedGrid, trainedGrid, dim],
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
      });
      positions = node(
        'concat',
        [
          node('slice', [table], { axis: 0, start: 0, end: 1 }),
          node('reshape', [node('permute', [resized], { order: [1, 2, 0] })], {
            shape: [patches, dim],
          }),
        ],
        { axis: 0 },
      );
    }
    const embedded = node(
      'patchEmbed',
      [
        'image',
        w(`${e}patch_embeddings.projection.weight`, [dim, 3, config.patch, config.patch]),
        w(`${e}patch_embeddings.projection.bias`, [dim]),
      ],
      { patch: config.patch },
    );
    let x = node('add', [
      node(
        'concat',
        [node('reshape', [w(`${e}cls_token`, [1, 1, dim])], { shape: [1, dim] }), embedded],
        { axis: 0 },
      ),
      positions,
    ]);

    const taps: string[] = [];
    for (let i = 0; i < config.depth; i += 1) {
      const p = `backbone.encoder.layer.${i}.`;
      const h = node('layerNorm', [x, w(`${p}norm1.weight`, [dim]), w(`${p}norm1.bias`, [dim])], {
        epsilon: EPSILON,
      });
      const attended = node(
        'attention',
        [
          linear(h, `${p}attention.attention.query`, dim, dim),
          linear(h, `${p}attention.attention.key`, dim, dim),
          linear(h, `${p}attention.attention.value`, dim, dim),
        ],
        { heads },
      );
      const out = linear(attended, `${p}attention.output.dense`, dim, dim);
      x = node('add', [x, node('mul', [out, w(`${p}layer_scale1.lambda1`, [dim])])]);
      const h2 = node('layerNorm', [x, w(`${p}norm2.weight`, [dim]), w(`${p}norm2.bias`, [dim])], {
        epsilon: EPSILON,
      });
      const mlp = linear(
        node('gelu', [linear(h2, `${p}mlp.fc1`, config.hidden, dim)]),
        `${p}mlp.fc2`,
        dim,
        config.hidden,
      );
      x = node('add', [x, node('mul', [mlp, w(`${p}layer_scale2.lambda1`, [dim])])]);
      if (config.taps.includes(i)) {
        taps.push(
          node(
            'layerNorm',
            [x, w('backbone.layernorm.weight', [dim]), w('backbone.layernorm.bias', [dim])],
            { epsilon: EPSILON },
          ),
        );
      }
    }

    const half = (size: number): number => Math.floor((size - 1) / 2) + 1;
    const sizes: [number, number][] = [
      [4 * rows, 4 * cols],
      [2 * rows, 2 * cols],
      [rows, cols],
      [half(rows), half(cols)],
    ];
    const levels = taps.map((tap, k) => {
      const channels = config.neck[k] as number;
      const r = `neck.reassemble_stage.layers.${k}.`;
      const image = node(
        'reshape',
        [
          node('permute', [node('slice', [tap], { axis: 0, start: 1, end: tokens })], {
            order: [1, 0],
          }),
        ],
        {
          shape: [dim, rows, cols],
        },
      );
      const projected = conv(image, `${r}projection`, channels, dim, 1);
      const resized =
        k === 0
          ? node(
              'convTranspose2d',
              [
                projected,
                w(`${r}resize.weight`, [channels, channels, 4, 4]),
                w(`${r}resize.bias`, [channels]),
              ],
              { stride: 4 },
            )
          : k === 1
            ? node(
                'convTranspose2d',
                [
                  projected,
                  w(`${r}resize.weight`, [channels, channels, 2, 2]),
                  w(`${r}resize.bias`, [channels]),
                ],
                { stride: 2 },
              )
            : k === 2
              ? projected
              : conv(projected, `${r}resize`, channels, channels, 3, { stride: 2, padding: 1 });
      return conv(resized, `neck.convs.${k}`, config.fusion, channels, 3, { padding: 1 }, false);
    });

    const f = config.fusion;
    const residual = (value: string, name: string): string => {
      const first = conv(node('relu', [value]), `${name}.convolution1`, f, f, 3, { padding: 1 });
      return node('add', [
        conv(node('relu', [first]), `${name}.convolution2`, f, f, 3, { padding: 1 }),
        value,
      ]);
    };
    /* Coarsest first: layer 0 takes the fourth level alone, and each after it adds the next finer. */
    let fused = '';
    for (let n = 0; n < 4; n += 1) {
      const level = levels[3 - n] as string;
      const name = `neck.fusion_stage.layers.${n}`;
      const merged =
        n === 0 ? level : node('add', [fused, residual(level, `${name}.residual_layer1`)]);
      const refined = residual(merged, `${name}.residual_layer2`);
      const size =
        n < 3
          ? (sizes[2 - n] as [number, number])
          : ([2 * sizes[0][0], 2 * sizes[0][1]] as [number, number]);
      const up = node('resize', [refined], {
        height: size[0],
        width: size[1],
        mode: 'bilinear',
        alignCorners: true,
      });
      fused = conv(up, `${name}.projection`, f, f, 1);
    }

    const first = conv(fused, 'head.conv1', f / 2, f, 3, { padding: 1 });
    const up = node('resize', [first], { height, width, mode: 'bilinear', alignCorners: true });
    const second = node('relu', [
      conv(up, 'head.conv2', config.headHidden, f / 2, 3, { padding: 1 }),
    ]);
    node('relu', [conv(second, 'head.conv3', 1, config.headHidden, 1)], {}, 'depth');
    return { inputs: [{ name: 'image', shape: [3, height, width] }], outputs: ['depth'] };
  };
}
