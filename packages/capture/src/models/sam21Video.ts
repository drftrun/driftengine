/**
 * The graphs a SAM 2.1 video adds to its image graphs: the memory encoder, the memory attention for
 * each count of remembered frames and pointer tokens, and the mask brought to the frame's size for
 * the memory. `Sam21Tracker` runs them.
 */
import type { Architecture } from '@driftengine/texture';

import type { Sam21Config } from './sam21.ts';
import { sam2MemoryAttention, sam2MemoryEncoder } from './sam2Memory.ts';

/* Everything but the memory encoder's weights, for a graph that reads only them. */
const IMAGE = [
  'vision_encoder.',
  'prompt_encoder.',
  'mask_decoder.',
  'shared_image_embedding.',
  'object_pointer_proj.',
  'memory_attention.',
  'mask_downsample.',
  'temporal_positional_encoding_projection_layer.',
  'memory_temporal_positional_encoding',
  'no_memory_embedding',
  'no_memory_positional_encoding',
  'no_object_pointer',
] as const;

/**
 * `features`, `[dim, grid, grid]`, and `mask`, `[1, size, size]` — logits, or a binary mask when
 * `binary`, as a frame prompted with points is encoded — to `memory`, `[memory.dim, grid, grid]`.
 * The host adds the occlusion embedding where the object is absent, and keeps the memory rounded to
 * bfloat16, as the upstream keeps it; this graph reads the embedding so the file holds it.
 */
export function sam21MemoryEncoder(config: Sam21Config, binary: boolean): Architecture {
  return (weights, graph) => {
    for (const name of IMAGE) weights.ignore(name);
    const { dim } = config.decoder;
    const grid = config.size / 16;
    weights.read('occlusion_spatial_embedding_parameter', [1, config.memory.dim]);
    sam2MemoryEncoder(
      weights,
      graph,
      dim,
      config.memory,
      grid,
      'features',
      'mask',
      binary,
      'memory',
    );
    return {
      inputs: [
        { name: 'features', shape: [dim, grid, grid] },
        { name: 'mask', shape: [1, config.size, config.size] },
      ],
      outputs: ['memory'],
    };
  };
}

/**
 * `features`, `[dim, grid, grid]`, `memory` and its `positions`, `[frames·grid² + pointers,
 * memory.dim]`, to `conditioned`, `[dim, grid, grid]`: one graph for each count of frames and of
 * pointer tokens a tracker holds. The host makes the memory's positions, so this graph reads the
 * temporal table and the pointers' projection for the file to hold them.
 */
export function sam21MemoryAttention(
  config: Sam21Config,
  frames: number,
  pointers: number,
): Architecture {
  return (weights, graph) => {
    for (const name of [
      'vision_encoder.',
      'prompt_encoder.',
      'mask_decoder.',
      'shared_image_embedding.',
      'object_pointer_proj.',
      'memory_encoder.',
      'mask_downsample.',
      'no_memory_embedding',
      'no_memory_positional_encoding',
      'no_object_pointer',
      'occlusion_spatial_embedding_parameter',
    ]) {
      weights.ignore(name);
    }
    const { dim } = config.decoder;
    const grid = config.size / 16;
    const m = config.memory;
    weights.read('memory_temporal_positional_encoding', [m.frames, 1, 1, m.dim]);
    weights.read('temporal_positional_encoding_projection_layer.weight', [m.dim, dim]);
    weights.read('temporal_positional_encoding_projection_layer.bias', [m.dim]);
    const tokens = frames * grid * grid + pointers;
    sam2MemoryAttention(
      weights,
      graph,
      dim,
      m,
      grid,
      frames,
      pointers,
      'features',
      'memory',
      'positions',
      'conditioned',
    );
    return {
      inputs: [
        { name: 'features', shape: [dim, grid, grid] },
        { name: 'memory', shape: [tokens, m.dim] },
        { name: 'positions', shape: [tokens, m.dim] },
      ],
      outputs: ['conditioned'],
    };
  };
}

/** `masks`, `[count, 4·grid, 4·grid]`, to `high`, `[count, size, size]`, bilinearly. Reads no weights. */
export function sam21Upscale(config: Sam21Config, count: number): Architecture {
  return (_weights, graph) => {
    const low = config.size / 4;
    graph.node(
      'resize',
      ['masks'],
      { height: config.size, width: config.size, mode: 'bilinear', alignCorners: false },
      'high',
    );
    return { inputs: [{ name: 'masks', shape: [count, low, low] }], outputs: ['high'] };
  };
}

/**
 * `masks`, `[count, size / 4, size / 4]`, to `image`, `[count, height, width]`: the tracker's masks
 * brought to the original frame bilinearly, as the upstream's `post_process_masks` brings them —
 * straight from a quarter of the square, since SAM 2 resizes a frame without padding it. Reads no
 * weights.
 */
export function sam21MasksToImage(
  config: Sam21Config,
  count: number,
  height: number,
  width: number,
): Architecture {
  return (_weights, graph) => {
    const low = config.size / 4;
    graph.node(
      'resize',
      ['masks'],
      { height, width, mode: 'bilinear', alignCorners: false },
      'image',
    );
    return { inputs: [{ name: 'masks', shape: [count, low, low] }], outputs: ['image'] };
  };
}
