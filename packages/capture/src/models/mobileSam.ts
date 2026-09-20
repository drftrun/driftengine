/**
 * MobileSAM: masks from a point or a box, in two graphs — an encoder run once per image, and a
 * decoder run once per prompt against the embedding it left.
 *
 * **The encoder takes the image at 1024 square**: resized with its longest side to 1024, normalised
 * by the upstream's pixel mean and deviation, and padded with zeros after its last row and column.
 * The decoder takes that embedding, a prompt's tokens from `samPromptTokens`, and optionally the
 * previous mask's logits to refine, and answers four masks at a quarter of the image's size with a
 * predicted quality each; `samMasksToImage` brings them to the original image as the upstream's
 * `postprocess_masks` does — up to the encoder's size, cropped to the prepared image, and down to the
 * original.
 *
 * **One decoder graph per prompt size**, since every kernel bakes its shapes: a point and its
 * padding are two tokens, and a box is two.
 */
import type { Architecture } from '@driftengine/texture';

import { samDecoder, type SamDecoderConfig } from './samDecoder.ts';
import { samInputSize } from './samPrompt.ts';
import { tinyVit, tinyVitGrid, type TinyVitConfig } from './tinyVit.ts';

export interface MobileSamConfig {
  /** The side the encoder takes an image at. */
  readonly size: number;
  readonly encoder: TinyVitConfig;
  readonly decoder: SamDecoderConfig;
}

export const MOBILE_SAM: MobileSamConfig = {
  size: 1024,
  encoder: {
    embedDims: [64, 128, 160, 320],
    depths: [2, 2, 6, 2],
    heads: [2, 4, 5, 10],
    windows: [7, 7, 14, 7],
    mergeStrides: [2, 2, 1],
    mlpRatio: 4,
    expandRatio: 4,
    neck: 256,
  },
  decoder: {
    dim: 256,
    heads: 8,
    mlp: 2048,
    depth: 2,
    downsample: 2,
    masks: 4,
    iouHidden: 256,
    iouDepth: 3,
    maskChannels: 16,
  },
};

/** The pixel mean and deviation the encoder's input is normalised by, in 0–255 RGB. */
export const SAM_PIXEL_MEAN = [123.675, 116.28, 103.53] as const;
export const SAM_PIXEL_STD = [58.395, 57.12, 57.375] as const;

/** `image`, `[3, size, size]`, to `embedding`, `[neck, grid, grid]`. */
export function mobileSamEncoder(config: MobileSamConfig): Architecture {
  return (weights, graph) => {
    weights.ignore('prompt_encoder.');
    weights.ignore('mask_decoder.');
    tinyVit(weights, graph, config.encoder, 'image_encoder.', 'image', config.size, 'embedding');
    return {
      inputs: [{ name: 'image', shape: [3, config.size, config.size] }],
      outputs: ['embedding'],
    };
  };
}

/**
 * `embedding` and `prompt`, `[tokens, dim]` — absent when `tokens` is zero — and `mask` when
 * `refine` is set, to `masks`, `[4, 4·grid, 4·grid]`, and `quality`, `[1, 4]`.
 */
export function mobileSamDecoder(
  config: MobileSamConfig,
  tokens: number,
  refine = false,
): Architecture {
  return (weights, graph) => {
    weights.ignore('image_encoder.');
    const { dim } = config.decoder;
    const grid = tinyVitGrid(config.encoder, config.size);
    const inputs = [
      { name: 'embedding', shape: [config.encoder.neck, grid, grid] },
      ...(tokens > 0 ? [{ name: 'prompt', shape: [tokens, dim] }] : []),
      ...(refine ? [{ name: 'mask', shape: [1, 4 * grid, 4 * grid] }] : []),
    ];
    samDecoder(
      weights,
      graph,
      config.decoder,
      'embedding',
      tokens > 0 ? 'prompt' : null,
      refine ? 'mask' : null,
      grid,
      { masks: 'masks', quality: 'quality' },
    );
    return { inputs, outputs: ['masks', 'quality'] };
  };
}

/**
 * `masks`, `[count, 4·grid, 4·grid]`, to `image`, `[count, height, width]`: up to the encoder's
 * size, cropped to the image as it was prepared, and down to the original — bilinearly, without
 * aligned corners, as the upstream's `postprocess_masks` does both. Reads no weights.
 */
export function samMasksToImage(
  config: MobileSamConfig,
  count: number,
  height: number,
  width: number,
): Architecture {
  return (_weights, graph) => {
    const grid = tinyVitGrid(config.encoder, config.size);
    const [inputHeight, inputWidth] = samInputSize(height, width, config.size);
    const bilinear = { mode: 'bilinear', alignCorners: false } as const;
    let x = graph.node('resize', ['masks'], {
      height: config.size,
      width: config.size,
      ...bilinear,
    });
    if (inputHeight < config.size) {
      x = graph.node('slice', [x], { axis: 1, start: 0, end: inputHeight });
    }
    if (inputWidth < config.size) {
      x = graph.node('slice', [x], { axis: 2, start: 0, end: inputWidth });
    }
    graph.node('resize', [x], { height, width, ...bilinear }, 'image');
    return {
      inputs: [{ name: 'masks', shape: [count, 4 * grid, 4 * grid] }],
      outputs: ['image'],
    };
  };
}
