/**
 * Depth Anything 3's head, the DPT that turns four taps of tokens into depth and its confidence.
 *
 * **Each tap is normed, laid back out as an image, projected, and resized to its level of a
 * pyramid** — four times the patch grid, twice, once, and half — then four fusion blocks walk the
 * pyramid from coarse to fine, each adding the level below through a residual unit, and the result
 * is brought up to the image by an aligned bilinear resize and read out by two convolutions: a
 * depth logit and a confidence logit per pixel. Their activations, `exp` and `exp + 1`, are the
 * caller's, applied to the two channels as they are read back, since the runtime has no `exp` and
 * one pass over a map on the host costs less than a kernel for it.
 *
 * **A sinusoidal position is added three times**, after each projection and before the readout:
 * a grid spanning the image's aspect normalised by its diagonal, as the upstream's `create_uv_grid`
 * makes it, embedded at base 100 and scaled by a tenth. It depends only on shapes, so each is a
 * constant of the graph.
 *
 * **The upstream's second head is not built.** It predicts rays for a pose estimate the camera
 * decoder already makes, and the upstream deletes its output when that decoder is present, as it is
 * in every accepted checkpoint; its weights are set aside by name.
 */
import { exactCos, exactExp, exactSin } from '@driftengine/core';
import type { GraphBuilder, Weights } from '@driftengine/texture';

import { LOG_BASE } from './rope.ts';

export interface HeadConfig {
  readonly dimIn: number;
  readonly features: number;
  readonly outChannels: readonly [number, number, number, number];
  readonly outputDim: number;
  readonly patch: number;
}

/** The head's own norms keep PyTorch's default ε. */
const EPSILON = 1e-5;

const f = Math.fround;

/**
 * `[channels, height, width]`: the upstream's `_add_pos_embed` for a map of this size in an image of
 * `aspect` width over height — sine and cosine of the horizontal coordinate, then of the vertical,
 * over `channels / 4` frequencies each, times a tenth.
 */
export function uvEmbedding(
  channels: number,
  height: number,
  width: number,
  aspect: number,
): Float32Array {
  const diagonal = Math.sqrt(aspect * aspect + 1);
  const spanX = aspect / diagonal;
  const spanY = 1 / diagonal;
  const coordinate = (span: number, count: number, i: number): number => {
    const edge = (span * (count - 1)) / count;
    return count === 1 ? -edge : f(-edge + ((2 * edge) / (count - 1)) * i);
  };
  const quarter = channels / 4;
  const omega = Float32Array.from({ length: quarter }, (_, k) =>
    f(1 / f(exactExp(f(k / quarter) * LOG_BASE))),
  );
  const out = new Float32Array(channels * height * width);
  for (let y = 0; y < height; y += 1) {
    const v = coordinate(spanY, height, y);
    for (let x = 0; x < width; x += 1) {
      const u = coordinate(spanX, width, x);
      for (let k = 0; k < quarter; k += 1) {
        const au = f(u * (omega[k] as number));
        const av = f(v * (omega[k] as number));
        const at = y * width + x;
        const plane = height * width;
        out[k * plane + at] = f(f(exactSin(au)) * 0.1);
        out[(quarter + k) * plane + at] = f(f(exactCos(au)) * 0.1);
        out[(2 * quarter + k) * plane + at] = f(f(exactSin(av)) * 0.1);
        out[(3 * quarter + k) * plane + at] = f(f(exactCos(av)) * 0.1);
      }
    }
  }
  return out;
}

/** The size a stride-2 3×3 convolution with padding 1 leaves. */
const halved = (size: number): number => Math.floor((size - 1) / 2) + 1;

/**
 * The head over one view's four taps, each `[rows · cols, dimIn]`; the result is the logits,
 * `[outputDim, rows · patch, cols · patch]`, named `output`. Several views share its constants.
 */
export function dualDptHead(
  weights: Weights,
  graph: GraphBuilder,
  config: HeadConfig,
  prefix: string,
  taps: readonly string[],
  rows: number,
  cols: number,
  output: string,
): string {
  const node = graph.node.bind(graph);
  const w = (name: string, shape: readonly number[]): string =>
    weights.read(`${prefix}${name}`, shape);
  const height = rows * config.patch;
  const width = cols * config.patch;
  const aspect = width / height;
  const features = config.features;
  const embed = (x: string, channels: number, h: number, wide: number): string =>
    node('add', [
      x,
      weights.constant(
        `uv.${channels}.${h}.${wide}`,
        [channels, h, wide],
        uvEmbedding(channels, h, wide, aspect),
      ),
    ]);
  const conv = (
    x: string,
    name: string,
    from: number,
    to: number,
    kernel: number,
    attributes = {},
    bias = true,
    named?: string,
  ): string =>
    node(
      'conv2d',
      bias
        ? [x, w(`${name}.weight`, [to, from, kernel, kernel]), w(`${name}.bias`, [to])]
        : [x, w(`${name}.weight`, [to, from, kernel, kernel])],
      attributes,
      named,
    );

  const sizes: [number, number][] = [
    [4 * rows, 4 * cols],
    [2 * rows, 2 * cols],
    [rows, cols],
    [halved(rows), halved(cols)],
  ];
  const levels = taps.map((tap, k) => {
    const channels = config.outChannels[k] as number;
    const normed = node(
      'layerNorm',
      [tap, w('norm.weight', [config.dimIn]), w('norm.bias', [config.dimIn])],
      { epsilon: EPSILON },
    );
    const image = node('reshape', [node('permute', [normed], { order: [1, 0] })], {
      shape: [config.dimIn, rows, cols],
    });
    const projected = embed(
      conv(image, `projects.${k}`, config.dimIn, channels, 1),
      channels,
      rows,
      cols,
    );
    const resized =
      k === 0
        ? node(
            'convTranspose2d',
            [
              projected,
              w('resize_layers.0.weight', [channels, channels, 4, 4]),
              w('resize_layers.0.bias', [channels]),
            ],
            { stride: 4 },
          )
        : k === 1
          ? node(
              'convTranspose2d',
              [
                projected,
                w('resize_layers.1.weight', [channels, channels, 2, 2]),
                w('resize_layers.1.bias', [channels]),
              ],
              { stride: 2 },
            )
          : k === 2
            ? projected
            : conv(projected, 'resize_layers.3', channels, channels, 3, { stride: 2, padding: 1 });
    return conv(resized, `scratch.layer${k + 1}_rn`, channels, features, 3, { padding: 1 }, false);
  });

  const residual = (x: string, name: string): string => {
    const first = conv(node('relu', [x]), `${name}.conv1`, features, features, 3, { padding: 1 });
    return node('add', [
      conv(node('relu', [first]), `${name}.conv2`, features, features, 3, { padding: 1 }),
      x,
    ]);
  };
  const fuse = (
    level: number,
    top: string,
    lateral: string | null,
    size: [number, number],
  ): string => {
    const name = `scratch.refinenet${level}`;
    const merged =
      lateral === null ? top : node('add', [top, residual(lateral, `${name}.resConfUnit1`)]);
    const refined = residual(merged, `${name}.resConfUnit2`);
    const up = node('resize', [refined], {
      height: size[0],
      width: size[1],
      mode: 'bilinear',
      alignCorners: true,
    });
    return conv(up, `${name}.out_conv`, features, features, 1);
  };
  const [l1, l2, l3, l4] = levels as [string, string, string, string];
  let out = fuse(4, l4, null, sizes[2]);
  out = fuse(3, out, l3, sizes[1]);
  out = fuse(2, out, l2, sizes[0]);
  out = fuse(1, out, l1, [2 * sizes[0][0], 2 * sizes[0][1]]);
  out = conv(out, 'scratch.output_conv1', features, features / 2, 3, { padding: 1 });

  const up = node('resize', [out], { height, width, mode: 'bilinear', alignCorners: true });
  const read = conv(
    embed(up, features / 2, height, width),
    'scratch.output_conv2.0',
    features / 2,
    32,
    3,
    { padding: 1 },
  );
  return conv(
    node('relu', [read]),
    'scratch.output_conv2.2',
    32,
    config.outputDim,
    1,
    {},
    true,
    output,
  );
}
