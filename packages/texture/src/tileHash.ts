/**
 * Content addressing for latent tiles: the same surface stored once however many assets use it.
 *
 * **One mechanism doing three jobs**, which is why it earns its own module rather than being a
 * detail of the encoder. The hash is the deduplication key, the streaming unit and the cache key —
 * so a tile that arrives for one material is already resident for the other thirty-nine that share
 * it.
 *
 * **No seed, no platform dependency, and nothing that varies per process.** A hash that changes
 * between runs makes the baker non-reproducible, which breaks every content comparison downstream
 * and does it silently, because the output is still valid — just different.
 */

/** FNV-1a over 64 bits, carried as two 32-bit halves because JavaScript has no 64-bit integer. */
export function hashTile(bytes: Uint8Array, offset = 0, length = bytes.length - offset): string {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < length; i += 1) {
    lo ^= bytes[offset + i] as number;
    /* 64-bit multiply by the FNV prime 0x100000001b3, split across the two halves. */
    const loLow = lo & 0xffff;
    const loHigh = lo >>> 16;
    const l0 = loLow * 0x01b3;
    const l1 = loHigh * 0x01b3 + (l0 >>> 16);
    const newLo = ((l1 << 16) | (l0 & 0xffff)) >>> 0;
    hi = (Math.imul(hi, 0x01b3) + Math.imul(lo, 0x0100) + (l1 >>> 16)) >>> 0;
    lo = newLo;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

export interface TileIndex {
  /** Slot per hash. */
  slots: Map<string, number>;
  /** The bytes each slot holds. */
  bytes: Uint8Array[];
}

export function createTileIndex(): TileIndex {
  return { slots: new Map(), bytes: [] };
}

/**
 * Give this tile a slot, reusing the one its content already has.
 *
 * Returns the slot. Two calls with identical content return the same slot and store one copy,
 * which is the whole of the deduplication.
 */
export function internTile(index: TileIndex, hash: string, bytes: Uint8Array): number {
  const existing = index.slots.get(hash);
  if (existing !== undefined) return existing;
  const slot = index.bytes.length;
  index.slots.set(hash, slot);
  index.bytes.push(bytes);
  return slot;
}

export function tileSlotCount(index: TileIndex): number {
  return index.bytes.length;
}
