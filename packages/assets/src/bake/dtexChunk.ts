/**
 * An encoded material as the chunk a file carries it in.
 *
 * **The join between two packages that cannot see each other.** `@driftengine/assets` knows how to
 * encode a material — a latent, a small network and a decode program — and `@driftengine/drft` knows
 * how to store bytes and nothing about what they mean. This is the one place that knows both, and
 * it is deliberately thin: it moves fields and packs a channel's semantic into a word.
 *
 * **The channels are the one thing the encoding does not already carry.** `EncodedMaterial` holds
 * the latent, the weights and the graph, and the graph is two nodes — sample, then evaluate. What
 * a channel *means* lives in the `ChannelSpec`s the caller handed `encodeMaterial`, so they are
 * handed over again here rather than recovered from a program that never held them.
 *
 * **The tiles are the caller's dedup, not this function's.** Two materials in a bake share a tile
 * whenever their bytes match, which is a decision across the whole bake; a function given one
 * material cannot make it. A caller with no tiling hands over none and the chunk carries its latent
 * as one run, which is what a small material wants anyway.
 */
import type { DtexMaterial } from '@driftengine/drft';
import { hashTile, semanticIndex, type ChannelSpec } from '@driftengine/texture';

import type { EncodedMaterial } from './latent.ts';

/** Where each tile's bytes sit in the latent payload, and what they hash to. */
export interface DtexTiles {
  readonly offset: Uint32Array;
  readonly length: Uint32Array;
  /** Two words a tile, high first, as `hashTile` splits its 64 bits. */
  readonly hash: Uint32Array;
  /** The payload the offsets index: tile-major, each tile's bytes in one run. */
  readonly payload: Uint8Array;
}

/**
 * A latent cut into tiles, in the grid's order, with identical tiles sharing one run.
 *
 * **Tile-major, because a tile of a row-major image is not contiguous** — its rows are a stride
 * apart, so no offset and length can name one, which is why the table this replaces could not be
 * written. Cut across a row and then down, the order `@driftengine/texture`'s `latentTileGrid`
 * uses, so the entry for a tile is `ty * across + tx` and a reader with a coordinate can find it.
 *
 * **Deduplicated by content**, which is the whole reason the hash is in the file: a flat surface
 * tiles into hundreds of identical squares, and a material that stored each of them separately
 * would pay for the flatness. Two tiles with the same bytes get the same offset and length.
 */
export function cutLatentTiles(
  latent: Uint8Array,
  width: number,
  height: number,
  components: number,
  tileSize: number,
): DtexTiles {
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new RangeError(`cutLatentTiles: an edge of ${String(tileSize)} texels is not a tile`);
  }
  const across = Math.ceil(width / tileSize);
  const down = Math.ceil(height / tileSize);
  const offset = new Uint32Array(across * down);
  const length = new Uint32Array(across * down);
  const hash = new Uint32Array(across * down * 2);
  const runs = new Map<string, [number, number]>();
  const bytes: number[] = [];

  for (let ty = 0; ty < down; ty += 1) {
    for (let tx = 0; tx < across; tx += 1) {
      const w = Math.min(tileSize, width - tx * tileSize);
      const h = Math.min(tileSize, height - ty * tileSize);
      const tile = new Uint8Array(w * h * components);
      for (let y = 0; y < h; y += 1) {
        const from = ((ty * tileSize + y) * width + tx * tileSize) * components;
        tile.set(latent.subarray(from, from + w * components), y * w * components);
      }
      const digest = hashTile(tile);
      const at = ty * across + tx;
      const held = runs.get(digest);
      if (held === undefined) {
        runs.set(digest, [bytes.length, tile.length]);
        offset[at] = bytes.length;
        length[at] = tile.length;
        for (const value of tile) bytes.push(value);
      } else {
        offset[at] = held[0];
        length[at] = held[1];
      }
      hash[at * 2] = Number.parseInt(digest.slice(0, 8), 16);
      hash[at * 2 + 1] = Number.parseInt(digest.slice(8), 16);
    }
  }
  return { offset, length, hash, payload: Uint8Array.from(bytes) };
}

/**
 * `encoded` as a `DtexMaterial`, with `channels` saying what each of its outputs is.
 *
 * A channel is packed as `(semanticIndex << 4) | component`, which is what the decode interpreter
 * unpacks and what the chunk stores. **A semantic this build does not know is refused** rather than
 * written as something else: the index is the format's, and a wrong one is a channel that decodes
 * as another channel, which reads as a shading fault in a scene nobody has changed.
 */
export function dtexFromEncoded(
  encoded: EncodedMaterial,
  channels: readonly ChannelSpec[],
  tileSize?: number,
): DtexMaterial {
  if (channels.length === 0) {
    throw new RangeError('dtexFromEncoded: a material with no channels decodes to nothing');
  }
  const packed = new Uint32Array(channels.length);
  channels.forEach((spec, at) => {
    const index = semanticIndex(spec.semantic);
    if (index < 0) {
      throw new RangeError(`dtexFromEncoded: ${spec.semantic} is not a semantic this build knows`);
    }
    if (!Number.isInteger(spec.component) || spec.component < 0 || spec.component > 15) {
      throw new RangeError(
        `dtexFromEncoded: component ${spec.component} does not fit the four bits a channel has`,
      );
    }
    packed[at] = (index << 4) | spec.component;
  });

  /*
   * **No tile size means no table at all**, rather than one entry over the whole image. A table
   * with a made-up hash in it is a table a streaming reader would believe; an empty one says
   * plainly that this material is one image and is not streamed. See `dtex.ts`.
   */
  const table =
    tileSize === undefined
      ? null
      : cutLatentTiles(
          encoded.latent,
          encoded.latentWidth,
          encoded.latentHeight,
          encoded.components,
          tileSize,
        );

  return {
    latentWidth: encoded.latentWidth,
    latentHeight: encoded.latentHeight,
    latentComponents: encoded.components,
    channels: packed,
    nodes: encoded.graph.nodes.slice(0, encoded.graph.count * 4),
    resultRegister: encoded.graph.result,
    addressMode: encoded.graph.addressMode,
    networkInputs: encoded.shape.inputs,
    networkOutputs: encoded.shape.outputs,
    hidden: Uint32Array.from(encoded.shape.hidden),
    weights: encoded.weights,
    tileOffset: table?.offset ?? new Uint32Array(0),
    tileLength: table?.length ?? new Uint32Array(0),
    tileHash: table?.hash ?? new Uint32Array(0),
    tileSize: tileSize ?? 0,
    latent: table?.payload ?? encoded.latent,
  };
}
