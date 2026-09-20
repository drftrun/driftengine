/**
 * SAM 2.1: masks from a point or a box, and masks carried through a video, as graphs — an encoder
 * run once a frame, a decoder once a prompt, and the memory that carries an object from one frame
 * to the next.
 *
 * **The encoder takes a frame at 1024 square**, resized without keeping its aspect, as the upstream's
 * processor resizes it, and normalised by ImageNet's mean and deviation. It answers three levels of
 * features — the decoder's input at a sixteenth of the frame and its two skips at an eighth and a
 * quarter — which a video's memory then reads too.
 */
import type { Architecture } from '@driftengine/texture';

import { hiera, type HieraConfig } from './hiera.ts';
import { sam2Decoder } from './sam2Decoder.ts';
import type { SamDecoderConfig } from './samDecoder.ts';

export interface Sam21Config {
  /** The side the encoder takes a frame at. */
  readonly size: number;
  readonly encoder: HieraConfig;
  readonly decoder: SamDecoderConfig;
  readonly memory: Sam21MemoryConfig;
}

export interface Sam21MemoryConfig {
  /** A memory's channels: the encoder's are narrowed to these before they are kept. */
  readonly dim: number;
  readonly attentionLayers: number;
  readonly attentionHeads: number;
  readonly feedForward: number;
  readonly fuserLayers: number;
  readonly fuserHidden: number;
  /** Frames of memory kept, the prompted frame among them, and object pointers read. */
  readonly frames: number;
  readonly pointers: number;
}

export const SAM_21_TINY: Sam21Config = {
  size: 1024,
  encoder: {
    dims: [96, 192, 384, 768],
    blocks: [1, 2, 7, 2],
    heads: [1, 2, 4, 8],
    windows: [8, 4, 14, 7],
    global: [5, 7, 9],
    background: 7,
    mlpRatio: 4,
    fpn: 256,
    topDown: [2, 3],
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
  memory: {
    dim: 64,
    attentionLayers: 4,
    attentionHeads: 1,
    feedForward: 2048,
    fuserLayers: 2,
    fuserHidden: 1024,
    frames: 7,
    pointers: 16,
  },
};

/** `image`, `[3, size, size]`, to `features`, `high1` and `high0`. */
export function sam21Encoder(config: Sam21Config): Architecture {
  return (weights, graph) => {
    for (const prefix of [
      'prompt_encoder.',
      'shared_image_embedding.',
      'memory_attention.',
      'memory_encoder.',
      'object_pointer_proj.',
      'temporal_positional_encoding_projection_layer.',
      'mask_downsample.',
    ]) {
      weights.ignore(prefix);
    }
    for (const name of [
      'no_memory_embedding',
      'no_memory_positional_encoding',
      'memory_temporal_positional_encoding',
      'no_object_pointer',
      'occlusion_spatial_embedding_parameter',
    ]) {
      weights.ignore(name);
    }
    /* The decoder's, but for the two projections the encoder applies once a frame, which it reads. */
    weights.ignore('mask_decoder.');
    hiera(weights, graph, config.encoder, 'image', config.size, {
      features: 'features',
      high1: 'high1',
      high0: 'high0',
    });
    return {
      inputs: [{ name: 'image', shape: [3, config.size, config.size] }],
      outputs: ['features', 'high1', 'high0'],
    };
  };
}

/** The prefixes and names of the memory's weights, which the image graphs set aside. */
const MEMORY = [
  'memory_attention.',
  'memory_encoder.',
  'mask_downsample.',
  'temporal_positional_encoding_projection_layer.',
  'memory_temporal_positional_encoding',
  'no_memory_positional_encoding',
  'occlusion_spatial_embedding_parameter',
] as const;

/**
 * `embedding`, `high1`, `high0` and `prompt`, `[tokens, dim]` — absent when `tokens` is zero — and
 * `mask` when `refine` is set, to `masks`, `quality`, `object` and `pointers`. With `noMemory` the
 * decoder adds `no_memory_embedding` to the features itself, as an image with nothing remembered
 * is decoded; otherwise the features are the memory attention's.
 */
export function sam21Decoder(
  config: Sam21Config,
  tokens: number,
  options: { readonly refine?: boolean; readonly noMemory?: boolean } = {},
): Architecture {
  return (weights, graph) => {
    weights.ignore('vision_encoder.');
    weights.ignore('mask_decoder.conv_s0.');
    weights.ignore('mask_decoder.conv_s1.');
    for (const name of MEMORY) weights.ignore(name);
    const { dim } = config.decoder;
    const grid = config.size / 16;
    /* Read whether this graph uses them or not: the host's pointer when no object is seen. */
    weights.read('no_object_pointer', [1, dim]);
    const noMemory = weights.read('no_memory_embedding', [1, 1, dim]);
    let embedding = 'embedding';
    if (options.noMemory === true) {
      const flat = graph.node('reshape', [noMemory], { shape: [dim] });
      const tokensFirst = graph.node(
        'permute',
        [graph.node('reshape', ['embedding'], { shape: [dim, grid * grid] })],
        { order: [1, 0] },
      );
      embedding = graph.node(
        'reshape',
        [graph.node('permute', [graph.node('add', [tokensFirst, flat])], { order: [1, 0] })],
        {
          shape: [dim, grid, grid],
        },
      );
    }
    const inputs = [
      { name: 'embedding', shape: [dim, grid, grid] },
      { name: 'high1', shape: [dim / 4, 2 * grid, 2 * grid] },
      { name: 'high0', shape: [dim / 8, 4 * grid, 4 * grid] },
      ...(tokens > 0 ? [{ name: 'prompt', shape: [tokens, dim] }] : []),
      ...(options.refine === true ? [{ name: 'mask', shape: [1, 4 * grid, 4 * grid] }] : []),
    ];
    sam2Decoder(
      weights,
      graph,
      config.decoder,
      grid,
      {
        embedding,
        prompt: tokens > 0 ? 'prompt' : null,
        mask: options.refine === true ? 'mask' : null,
        high1: 'high1',
        high0: 'high0',
      },
      { masks: 'masks', quality: 'quality', object: 'object', pointers: 'pointers' },
    );
    return { inputs, outputs: ['masks', 'quality', 'object', 'pointers'] };
  };
}
