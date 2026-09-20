/**
 * Depth Anything 3, as a definition the runtime builds a graph from at whatever size a clip needs.
 *
 * **From one to a handful of views at once, a depth map, its confidence and a camera per view.**
 * The backbone is `vit.ts`, the head `dualDpt.ts`, and the camera decoder here: two layers over
 * each view's camera token from the last tap, then a translation, a scalar-last quaternion and two
 * fields of view. The graph ends at logits and at that pose encoding; `decodeDepth` and
 * `decodeCamera` turn them into metres of relative depth, a confidence of at least one, a
 * world-to-camera transform and a pinhole, as the upstream's own code does after its network.
 *
 * **What is set aside, by name**: the camera encoder, which conditions on poses a caller already
 * has and this capture never does; and the head's ray branch, whose output the upstream discards
 * whenever the camera decoder is present. Converting a checkpoint that holds anything else fails
 * naming it.
 *
 * **What would make this wrong**: a checkpoint trained with another block layout — the upstream's
 * large and giant models use a different feed-forward — which their configurations would say, and
 * which are refused for their licences in any case.
 */
import { exactCos, exactExp, exactSin } from '@driftengine/core';
import type { Architecture } from '@driftengine/texture';

import { dualDptHead, type HeadConfig } from './dualDpt.ts';
import { vitBackbone, type VitConfig } from './vit.ts';

export interface DepthAnything3Config {
  readonly backbone: VitConfig;
  readonly head: HeadConfig;
}

const PATCH = 14;

/** The two accepted sizes, from each checkpoint's own configuration at its pinned revision. */
export const DEPTH_ANYTHING_3: Readonly<Record<'small' | 'base', DepthAnything3Config>> = {
  small: {
    backbone: {
      dim: 384,
      heads: 6,
      depth: 12,
      hidden: 1536,
      patch: PATCH,
      trainedGrid: 37,
      taps: [5, 7, 9, 11],
      altStart: 4,
      qkNormStart: 4,
      ropeStart: 4,
    },
    head: { dimIn: 768, features: 64, outChannels: [48, 96, 192, 384], outputDim: 2, patch: PATCH },
  },
  base: {
    backbone: {
      dim: 768,
      heads: 12,
      depth: 12,
      hidden: 3072,
      patch: PATCH,
      trainedGrid: 37,
      taps: [5, 7, 9, 11],
      altStart: 4,
      qkNormStart: 4,
      ropeStart: 4,
    },
    head: {
      dimIn: 1536,
      features: 128,
      outChannels: [96, 192, 384, 768],
      outputDim: 2,
      patch: PATCH,
    },
  },
};

/** What the upstream checkpoints hold and no graph here reads. */
const SET_ASIDE = [
  'model.cam_enc.',
  'model.head.scratch.output_conv1_aux.',
  'model.head.scratch.output_conv2_aux.',
  'model.head.scratch.refinenet1_aux.',
  'model.head.scratch.refinenet2_aux.',
  'model.head.scratch.refinenet3_aux.',
  'model.head.scratch.refinenet4_aux.',
];

/**
 * The graph for `views` images of `height × width` pixels, each a multiple of 14, normalised by
 * ImageNet's mean and deviation. Inputs are `image0` … as `[3, height, width]`; outputs are
 * `logits0` … as `[2, height, width]` and `pose` as `[views, 9]`. The first view is the reference.
 */
export function depthAnything3(
  config: DepthAnything3Config,
  views: number,
  height: number,
  width: number,
): Architecture {
  const rows = height / PATCH;
  const cols = width / PATCH;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
    throw new RangeError(`${height} × ${width} is not a whole number of ${PATCH}-pixel patches`);
  }
  return (weights, graph) => {
    for (const prefix of SET_ASIDE) weights.ignore(prefix);
    const images = Array.from({ length: views }, (_, v) => `image${v}`);
    const { features, cameras } = vitBackbone(
      weights,
      graph,
      config.backbone,
      'model.backbone.pretrained.',
      images,
      rows,
      cols,
    );
    const outputs = images.map((_, v) =>
      dualDptHead(
        weights,
        graph,
        config.head,
        'model.head.',
        features.map((tap) => tap[v] as string),
        rows,
        cols,
        `logits${v}`,
      ),
    );

    const width2 = 2 * config.backbone.dim;
    const node = graph.node.bind(graph);
    const layer = (x: string, name: string, to: number): string =>
      node('linear', [
        x,
        weights.read(`model.cam_dec.${name}.weight`, [to, width2]),
        weights.read(`model.cam_dec.${name}.bias`, [to]),
      ]);
    const trunk = node('relu', [
      layer(
        node('relu', [layer(cameras[cameras.length - 1] as string, 'backbone.0', width2)]),
        'backbone.2',
        width2,
      ),
    ]);
    node(
      'concat',
      [
        layer(trunk, 'fc_t', 3),
        layer(trunk, 'fc_qvec', 4),
        node('relu', [layer(trunk, 'fc_fov.0', 2)]),
      ],
      { axis: 1 },
      'pose',
    );
    return {
      inputs: images.map((name) => ({ name, shape: [3, height, width] })),
      outputs: [...outputs, 'pose'],
    };
  };
}

/**
 * Depth and confidence from one view's logits, `[2, height, width]`: `exp` of the first channel,
 * and one more than `exp` of the second, into the caller's maps.
 */
export function decodeDepth(
  logits: Float32Array,
  depth: Float32Array,
  confidence: Float32Array,
): void {
  const pixels = depth.length;
  for (let i = 0; i < pixels; i += 1) {
    depth[i] = exactExp(logits[i] as number);
    confidence[i] = exactExp(logits[pixels + i] as number) + 1;
  }
}

/**
 * One view's camera from its pose encoding: `worldToCamera`, 3 × 4 row-major — the inverse of the
 * camera-to-world rotation and translation the decoder predicts — and `intrinsics`, 3 × 3 row-major,
 * with focal lengths from the two fields of view and the principal point at the centre.
 */
export function decodeCamera(
  pose: Float32Array,
  at: number,
  height: number,
  width: number,
  worldToCamera: Float32Array,
  intrinsics: Float32Array,
): void {
  const p = at * 9;
  const tx = pose[p] as number;
  const ty = pose[p + 1] as number;
  const tz = pose[p + 2] as number;
  const i = pose[p + 3] as number;
  const j = pose[p + 4] as number;
  const k = pose[p + 5] as number;
  const r = pose[p + 6] as number;
  const s = 2 / (i * i + j * j + k * k + r * r);
  /*
   * The camera-to-world rotation is `quat_to_mat`'s; its inverse is the transpose, so row `n` here
   * is column `n` there, and the translation is carried back through it.
   */
  const r00 = 1 - s * (j * j + k * k);
  const r01 = s * (i * j - k * r);
  const r02 = s * (i * k + j * r);
  const r10 = s * (i * j + k * r);
  const r11 = 1 - s * (i * i + k * k);
  const r12 = s * (j * k - i * r);
  const r20 = s * (i * k - j * r);
  const r21 = s * (j * k + i * r);
  const r22 = 1 - s * (i * i + j * j);
  worldToCamera[0] = r00;
  worldToCamera[1] = r10;
  worldToCamera[2] = r20;
  worldToCamera[3] = -(r00 * tx + r10 * ty + r20 * tz);
  worldToCamera[4] = r01;
  worldToCamera[5] = r11;
  worldToCamera[6] = r21;
  worldToCamera[7] = -(r01 * tx + r11 * ty + r21 * tz);
  worldToCamera[8] = r02;
  worldToCamera[9] = r12;
  worldToCamera[10] = r22;
  worldToCamera[11] = -(r02 * tx + r12 * ty + r22 * tz);
  const tangent = (angle: number): number => exactSin(angle / 2) / exactCos(angle / 2);
  const fy = height / 2 / Math.max(tangent(pose[p + 7] as number), 1e-6);
  const fx = width / 2 / Math.max(tangent(pose[p + 8] as number), 1e-6);
  intrinsics.fill(0);
  intrinsics[0] = fx;
  intrinsics[2] = width / 2;
  intrinsics[4] = fy;
  intrinsics[5] = height / 2;
  intrinsics[8] = 1;
}
