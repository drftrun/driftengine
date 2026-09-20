/**
 * Transient resources a frame declares, addressed by identifier rather than by bit.
 *
 * **`resources.ts` is not replaced and is not wrong.** It is a fixed table of fourteen
 * attachments held in a bit mask, and it says in its own header that the transient allocator a
 * frame graph is famous for would be machinery with no case to serve — which was true while
 * this frame's composition was fixed. A GPU-driven frame's composition is not: hierarchical
 * depth chains, visibility buffers, per-material bin lists and indirect argument buffers are
 * allocated against what the frame contains. Thirty-one bits cannot hold hundreds of them and
 * a thirty-second bit is not the fix.
 *
 * So there are two representations and each is used where it is right: the mask for a fixed
 * composition, identifiers for a dynamic one. Nothing converts between them, because nothing
 * needs to — a frame is scheduled by one or the other.
 *
 * Structure of arrays, growable by doubling, and nothing here holds an object per resource.
 */

/** A transient texture, sized in texels. */
export interface VirtualTextureDesc {
  kind: 'texture';
  width: number;
  height: number;
  bytesPerTexel: number;
}

/** A transient buffer, sized in bytes. */
export interface VirtualBufferDesc {
  kind: 'buffer';
  bytes: number;
}

export type VirtualDesc = VirtualTextureDesc | VirtualBufferDesc;

export interface VirtualTable {
  /** 0 for a texture, 1 for a buffer, one entry per identifier. */
  kinds: Uint8Array;
  /** Byte footprint per identifier, which is what the aliasing allocator packs. */
  bytes: Uint32Array;
  /** How many identifiers have been declared this frame. */
  count: number;
}

export function createVirtualTable(capacity: number): VirtualTable {
  return { kinds: new Uint8Array(capacity), bytes: new Uint32Array(capacity), count: 0 };
}

export function resetVirtualTable(table: VirtualTable): void {
  table.count = 0;
}

export function virtualCount(table: VirtualTable): number {
  return table.count;
}

/*
 * Doubling rather than growing by one, because a frame that declares one more resource than
 * last frame will declare one more again, and a table that reallocates per declaration turns a
 * linear frame into a quadratic one.
 */
function grow(table: VirtualTable): void {
  const size = table.kinds.length === 0 ? 8 : table.kinds.length * 2;
  const kinds = new Uint8Array(size);
  kinds.set(table.kinds);
  const bytes = new Uint32Array(size);
  bytes.set(table.bytes);
  table.kinds = kinds;
  table.bytes = bytes;
}

export function declareVirtual(table: VirtualTable, desc: VirtualDesc): number {
  if (table.count === table.kinds.length) grow(table);
  const id = table.count;
  if (desc.kind === 'texture') {
    table.kinds[id] = 0;
    table.bytes[id] = desc.width * desc.height * desc.bytesPerTexel;
  } else {
    table.kinds[id] = 1;
    table.bytes[id] = desc.bytes;
  }
  table.count = id + 1;
  return id;
}

export function virtualKind(table: VirtualTable, id: number): number {
  return table.kinds[id] ?? 0;
}

export function virtualBytes(table: VirtualTable, id: number): number {
  return table.bytes[id] ?? 0;
}
