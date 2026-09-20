import { DrftError, align } from './drftFormat.ts';

/**
 * `DTEX`: a material as a decode program over a latent, rather than as pictures.
 *
 * **The chunk carries no semantics and that is deliberate.** `@driftengine/drft` is the container
 * and has no dependencies — it does not know what a `DecodeGraph` means, only what shape it is. So
 * the types here are plain arrays that `@driftengine/texture`'s own types satisfy structurally,
 * the same arrangement `Terrain` has with `Heightfield` across the physics boundary: a rule that
 * cannot be shared as code is still shared as a test.
 *
 * ```
 * u32  material              which MATL entry this decodes
 * u32  latentWidth
 * u32  latentHeight
 * u32  latentComponents
 * u32  channelCount
 * u32  nodeCount             decode graph nodes, four words each
 * u32  resultRegister
 * u32  addressMode           0 and 1 lattice, 2 and 3 texel-centre; clamp, then wrap
 * u32  networkInputs
 * u32  networkOutputs
 * u32  hiddenCount
 * u32  weightCount
 * u32  tileCount
 * u32  tileSize              texels on a tile's edge, or 0 for a payload that is one image
 * u32  hidden[hiddenCount]
 * u32  channels[channelCount]      (semanticIndex << 4) | component, the packing REMAP_CHANNEL uses
 * u32  nodes[nodeCount * 4]
 * u32  tileOffset[tileCount]       byte offset into the latent payload
 * u32  tileLength[tileCount]
 * u32  tileHash[tileCount * 2]     `hashTile`'s 64 bits, high word first
 * f32  weights[weightCount]
 * u8   latent[...]                 padded to the container's alignment
 * ```
 *
 * **No per-chunk version field, which is where this departs from the plan.** The plan's layout
 * opened with a header and a version; every chunk in this container already answers to the file's
 * own version, and `MSHL` states the reason in one line — a second version is a second thing to
 * keep in step, and the one that drifts is the one nobody reads.
 *
 * **The tile table is the streaming unit, and until 2026-09-20 it could not be.** It was a flat
 * list of offsets into a row-major image with a 32-bit hash that nothing wrote — and a tile of a
 * row-major image is not contiguous, so no offset and length could name one. Three things make it
 * real, and they are one decision rather than three:
 *
 * - **`tileSize` is in the header**, so a reader can work out the grid. Without it the table is a
 *   list of byte ranges nobody can address by tile.
 * - **The payload is tile-major when there are tiles**: each tile's texels run together, in the
 *   grid's own order — row-major across, then down — which is exactly the order and the extent
 *   `@driftengine/texture`'s `latentTileGrid` cuts and `tilesForView` asks for. `tileCount` of 0
 *   means the payload is one row-major image, which is what every material small enough not to
 *   stream still is.
 * - **The hash is `hashTile`'s 64 bits**, the same number residency addresses a tile by, so a tile
 *   that arrived for one material is already resident for every other material sharing it. Thirty
 *   two bits is about a one in ten thousand collision over sixty thousand tiles, and a collision
 *   here is one surface wearing another's texture.
 *
 * **What it gives up**: a reader that wants the whole image must put the tiles back together, which
 * is a copy the row-major form does not need. That is why `tileCount` of 0 stays a legal chunk
 * rather than being tidied away. **What would make it wrong** is a mip chain, which this chunk does
 * not carry — `latentTileGrid` cuts one level per mip and a `DTEX` has one level, so the table is
 * that level's tiles and nothing is implied about the others.
 *
 * **What is validated here is containment, not meaning.** A tile whose bytes run past the payload
 * and a result register no node ever writes are refused, because those make a reader hand back
 * arbitrary memory or an uninitialised value. Whether the program is one an interpreter can *run*
 * is `validateDecodeGraph`'s question, in the package that knows what an operation is.
 *
 * Additive, and additive is what keeps `FORMAT.md`'s freeze intact: a reader that does not know
 * this code skips it by its length and loses only the material, which it could not have decoded.
 */

/** Registers the decode vocabulary has. Mirrors `MAX_REGISTERS`; asserted equal by a test. */
export const DTEX_REGISTERS = 16;

/** Address modes the decode vocabulary has. Mirrors `ADDRESS_MODE_COUNT`; asserted equal by a test. */
export const DTEX_ADDRESS_MODES = 4;

/** How many tiles one material may carry. Well past what a streaming budget permits. */
export const DTEX_MAX_TILES = 1 << 16;

/** A material's decode program, and which `MATL` entry it belongs to. */
export interface DtexEntry {
  /** The index of the `MATL` entry this decodes. */
  readonly material: number;
  readonly texture: DtexMaterial;
}

export interface DtexMaterial {
  latentWidth: number;
  latentHeight: number;
  latentComponents: number;
  /** `(semanticIndex << 4) | component` per channel. */
  channels: Uint32Array;
  /** Four words a node: op, a, b, out. */
  nodes: Uint32Array;
  resultRegister: number;
  addressMode: number;
  networkInputs: number;
  networkOutputs: number;
  hidden: Uint32Array;
  weights: Float32Array;
  tileOffset: Uint32Array;
  tileLength: Uint32Array;
  /** Two words a tile, high first, as `hashTile` splits its 64 bits. */
  tileHash: Uint32Array;
  /**
   * Texels on a tile's edge, or 0 where the payload is one row-major image.
   *
   * A grid rather than a count, because what streams is a rectangle of texels and a reader has to
   * be able to say which one it is looking at.
   */
  tileSize: number;
  latent: Uint8Array;
}

/*
 * Fourteen: the thirteen the layout above lists after `material`, and `material` itself.
 *
 * **The pairing is in the chunk rather than in the order the chunks appear**, because a file may
 * carry a decode program for some of its materials and not others — a scene where one surface came
 * from a capture and the rest were authored — and a reader that paired by position would give the
 * wrong material the wrong texture without anything failing.
 */
const HEADER_WORDS = 14;
const HEADER = HEADER_WORDS * 4;

interface Layout {
  hidden: number;
  channels: number;
  nodes: number;
  tileOffset: number;
  tileLength: number;
  tileHash: number;
  weights: number;
  latent: number;
  size: number;
}

function layoutOf(material: DtexMaterial): Layout {
  const hiddenCount = material.hidden.length;
  const channelCount = material.channels.length;
  const nodeWords = material.nodes.length;
  const tiles = material.tileOffset.length;
  let at = HEADER;
  const hidden = at;
  at += hiddenCount * 4;
  const channels = at;
  at += channelCount * 4;
  const nodes = at;
  at += nodeWords * 4;
  const tileOffset = at;
  at += tiles * 4;
  const tileLength = at;
  at += tiles * 4;
  const tileHash = at;
  /* Two words a tile: `hashTile` is 64 bits and JavaScript has no integer that wide. */
  at += tiles * 8;
  const weights = at;
  at += material.weights.length * 4;
  const latent = at;
  at += material.latent.length;
  return { hidden, channels, nodes, tileOffset, tileLength, tileHash, weights, latent, size: at };
}

/** How many tiles across a latent of `width` texels is cut into at this tile size. */
export function dtexTilesAcross(width: number, tileSize: number): number {
  return tileSize > 0 ? Math.ceil(width / tileSize) : 0;
}

/**
 * How many tiles the grid holds, which is what the table's length has to be.
 *
 * **The order is the grid's own**: across a row, then down, the same order
 * `@driftengine/texture`'s `latentTileGrid` cuts in — so a reader with a tile coordinate reads
 * `ty * dtexTilesAcross(width, tileSize) + tx` and gets the entry for it.
 */
export function dtexTileCount(width: number, height: number, tileSize: number): number {
  return dtexTilesAcross(width, tileSize) * dtexTilesAcross(height, tileSize);
}

/** A tile table has to be the grid, or nothing can be addressed by where it is. */
function refuseStrayGrid(material: DtexMaterial, tiles: number): void {
  const { tileSize, latentWidth, latentHeight } = material;
  if (tiles === 0) {
    if (tileSize !== 0) {
      throw new DrftError(`DTEX declares a tile edge of ${tileSize} texels and carries no tiles`);
    }
    return;
  }
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new DrftError(`DTEX carries ${tiles} tiles and a tile edge of ${tileSize} texels`);
  }
  const wanted = dtexTileCount(latentWidth, latentHeight, tileSize);
  if (tiles !== wanted) {
    throw new DrftError(
      `DTEX carries ${tiles} tiles where a ${latentWidth} by ${latentHeight} latent cut at ` +
        `${tileSize} is ${wanted}`,
    );
  }
}

export function buildDtex(entry: DtexEntry): Uint8Array {
  const { texture: material } = entry;
  if (!Number.isInteger(entry.material) || entry.material < 0) {
    throw new DrftError(`DTEX names material ${entry.material}, which is not an index`);
  }
  const tiles = material.tileOffset.length;
  if (tiles > DTEX_MAX_TILES) {
    throw new DrftError(`DTEX carries ${tiles} tiles, past the ${DTEX_MAX_TILES} cap`);
  }
  if (material.tileLength.length !== tiles || material.tileHash.length !== tiles * 2) {
    throw new DrftError('DTEX was given a tile table whose three columns are different lengths');
  }
  refuseStrayGrid(material, tiles);
  if (material.nodes.length === 0 || material.nodes.length % 4 !== 0) {
    throw new DrftError(
      `DTEX was given ${material.nodes.length} node words, which is not whole nodes`,
    );
  }
  if (material.latentComponents < 1 || material.latentComponents > 4) {
    throw new DrftError(`DTEX latent has ${material.latentComponents} components, not one to four`);
  }
  /*
   * **Only where the payload is one image.** With tiles it is tile-major and two identical tiles
   * share one run, so a chunk whose payload is *smaller* than its grid is a chunk that deduplicated
   * — which is the point. What holds there is the per-tile containment check below.
   */
  if (
    tiles === 0 &&
    material.latent.length <
      material.latentWidth * material.latentHeight * material.latentComponents
  ) {
    throw new DrftError('DTEX latent payload is smaller than the grid it declares');
  }

  /*
   * Every tile is checked to lie inside the payload before anything is written. A tile running
   * past the end is a subarray of arbitrary memory on the way back in, which is exactly what
   * `MSHL` checks its cluster table for.
   */
  for (let t = 0; t < tiles; t += 1) {
    const start = material.tileOffset[t] as number;
    const length = material.tileLength[t] as number;
    if (start + length > material.latent.length) {
      throw new DrftError(`DTEX tile ${t} runs past the ${material.latent.length}-byte payload`);
    }
  }

  /* A result register nothing writes hands a reader whatever that register happened to hold. */
  let written = false;
  for (let n = 0; n * 4 < material.nodes.length; n += 1) {
    const out = material.nodes[n * 4 + 3] as number;
    if (out >= DTEX_REGISTERS) {
      throw new DrftError(
        `DTEX node ${n} writes register ${out}, past the ${DTEX_REGISTERS} there are`,
      );
    }
    if (out === material.resultRegister) written = true;
  }
  if (!written) {
    throw new DrftError(
      `DTEX names register ${material.resultRegister} as its result, and no node writes it`,
    );
  }

  const layout = layoutOf(material);
  const bytes = new Uint8Array(align(layout.size));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, entry.material, true);
  view.setUint32(4, material.latentWidth, true);
  view.setUint32(8, material.latentHeight, true);
  view.setUint32(12, material.latentComponents, true);
  view.setUint32(16, material.channels.length, true);
  view.setUint32(20, material.nodes.length / 4, true);
  view.setUint32(24, material.resultRegister, true);
  view.setUint32(28, material.addressMode, true);
  view.setUint32(32, material.networkInputs, true);
  view.setUint32(36, material.networkOutputs, true);
  view.setUint32(40, material.hidden.length, true);
  view.setUint32(44, material.weights.length, true);
  view.setUint32(48, tiles, true);
  view.setUint32(52, material.tileSize, true);

  new Uint32Array(bytes.buffer, layout.hidden, material.hidden.length).set(material.hidden);
  new Uint32Array(bytes.buffer, layout.channels, material.channels.length).set(material.channels);
  new Uint32Array(bytes.buffer, layout.nodes, material.nodes.length).set(material.nodes);
  new Uint32Array(bytes.buffer, layout.tileOffset, tiles).set(material.tileOffset);
  new Uint32Array(bytes.buffer, layout.tileLength, tiles).set(material.tileLength);
  new Uint32Array(bytes.buffer, layout.tileHash, tiles * 2).set(material.tileHash);
  new Float32Array(bytes.buffer, layout.weights, material.weights.length).set(material.weights);
  bytes.set(material.latent, layout.latent);
  return bytes;
}

/**
 * The material a `DTEX` chunk carries, as views over the fetched buffer.
 *
 * Views rather than copies, like every other chunk here, so a load allocates nothing beyond the
 * object holding them.
 */
export function readDtex(buffer: ArrayBuffer, offset: number, byteLength: number): DtexEntry {
  if (byteLength < HEADER) throw new DrftError('DTEX is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const materialIndex = view.getUint32(0, true);
  const latentWidth = view.getUint32(4, true);
  const latentHeight = view.getUint32(8, true);
  const latentComponents = view.getUint32(12, true);
  const channelCount = view.getUint32(16, true);
  const nodeCount = view.getUint32(20, true);
  const resultRegister = view.getUint32(24, true);
  const addressMode = view.getUint32(28, true);
  const networkInputs = view.getUint32(32, true);
  const networkOutputs = view.getUint32(36, true);
  const hiddenCount = view.getUint32(40, true);
  const weightCount = view.getUint32(44, true);
  const tiles = view.getUint32(48, true);
  const tileSize = view.getUint32(52, true);

  if (nodeCount === 0) throw new DrftError('DTEX carries no decode program');
  if (latentComponents < 1 || latentComponents > 4) {
    throw new DrftError(`DTEX latent declares ${latentComponents} components, not one to four`);
  }
  if (addressMode >= DTEX_ADDRESS_MODES) {
    throw new DrftError(
      `DTEX declares address mode ${String(addressMode)}; this reader knows 0 to ${String(DTEX_ADDRESS_MODES - 1)}`,
    );
  }

  const shape: DtexMaterial = {
    latentWidth,
    latentHeight,
    latentComponents,
    channels: new Uint32Array(channelCount),
    nodes: new Uint32Array(nodeCount * 4),
    resultRegister,
    addressMode,
    networkInputs,
    networkOutputs,
    hidden: new Uint32Array(hiddenCount),
    weights: new Float32Array(weightCount),
    tileOffset: new Uint32Array(tiles),
    tileLength: new Uint32Array(tiles),
    tileHash: new Uint32Array(tiles * 2),
    tileSize,
    latent: new Uint8Array(0),
  };
  const layout = layoutOf(shape);
  const latentBytes = byteLength - layout.latent;
  if (latentBytes < 0) {
    throw new DrftError(
      `DTEX declares ${String(layout.latent)} bytes of tables in a ${String(byteLength)}-byte chunk`,
    );
  }

  const base = offset;
  const material: DtexMaterial = {
    latentWidth,
    latentHeight,
    latentComponents,
    channels: new Uint32Array(buffer, base + layout.channels, channelCount),
    nodes: new Uint32Array(buffer, base + layout.nodes, nodeCount * 4),
    resultRegister,
    addressMode,
    networkInputs,
    networkOutputs,
    hidden: new Uint32Array(buffer, base + layout.hidden, hiddenCount),
    weights: new Float32Array(buffer, base + layout.weights, weightCount),
    tileOffset: new Uint32Array(buffer, base + layout.tileOffset, tiles),
    tileLength: new Uint32Array(buffer, base + layout.tileLength, tiles),
    tileHash: new Uint32Array(buffer, base + layout.tileHash, tiles * 2),
    tileSize,
    latent: new Uint8Array(buffer, base + layout.latent, latentBytes),
  };

  refuseStrayGrid(material, tiles);
  if (tiles === 0 && latentBytes < latentWidth * latentHeight * latentComponents) {
    throw new DrftError('DTEX latent payload is smaller than the grid it declares');
  }
  for (let t = 0; t < tiles; t += 1) {
    const start = material.tileOffset[t] as number;
    const length = material.tileLength[t] as number;
    if (start + length > latentBytes) {
      throw new DrftError(`DTEX tile ${t} runs past the ${String(latentBytes)}-byte payload`);
    }
  }
  let written = false;
  for (let n = 0; n < nodeCount; n += 1) {
    const out = material.nodes[n * 4 + 3] as number;
    if (out >= DTEX_REGISTERS) {
      throw new DrftError(
        `DTEX node ${n} writes register ${out}, past the ${DTEX_REGISTERS} there are`,
      );
    }
    if (out === resultRegister) written = true;
  }
  if (!written) {
    throw new DrftError(
      `DTEX names register ${resultRegister} as its result, and no node writes it`,
    );
  }
  return { material: materialIndex, texture: material };
}
