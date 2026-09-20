/**
 * Where each transient resource lives in the frame's arena, so that two which are never alive
 * together share the memory.
 *
 * **First fit over slots, in declaration order.** Not best fit and not a bin-packing search:
 * the input is tens of resources whose order is already meaningful, the packing runs once per
 * frame composition rather than per frame, and a first-fit result is stable — which matters far
 * more than a few saved bytes, because an allocator whose output moves between frames moves
 * every binding with it.
 *
 * A slot records the widest resource it has held and the node at which its current occupant
 * dies. A later resource may take the slot when it is born strictly after that node.
 */
import type { Lifetimes } from './lifetime.ts';
import { firstWrite, lastRead } from './lifetime.ts';
import type { VirtualTable } from './virtual.ts';
import { virtualBytes } from './virtual.ts';

export interface AliasPlan {
  /** Byte offset into the arena per identifier, or -1 when nothing writes it. */
  offsets: Int32Array;
  /** Byte offset of each slot, parallel to `slotEnd` and `slotSize`. */
  slotAt: Int32Array;
  /** Node at which each slot's current occupant is last read. */
  slotEnd: Int32Array;
  /** Widest resource each slot has held. */
  slotSize: Int32Array;
  /** How many slots are in use. */
  slots: number;
}

export function createAliasPlan(capacity: number): AliasPlan {
  return {
    offsets: new Int32Array(capacity),
    slotAt: new Int32Array(capacity),
    slotEnd: new Int32Array(capacity),
    slotSize: new Int32Array(capacity),
    slots: 0,
  };
}

/** Alignment every slot starts on. 256 is the widest uniform-buffer alignment WebGPU requires. */
const ALIGN = 256;

function aligned(bytes: number): number {
  return Math.ceil(bytes / ALIGN) * ALIGN;
}

export function planAliases(table: VirtualTable, lifetimes: Lifetimes, out: AliasPlan): number {
  out.offsets.fill(-1);
  out.slots = 0;
  let total = 0;

  for (let id = 0; id < table.count; id += 1) {
    const born = firstWrite(lifetimes, id);
    if (born === -1) continue;
    const dies = lastRead(lifetimes, id);
    const size = aligned(virtualBytes(table, id));

    let placed = -1;
    for (let slot = 0; slot < out.slots; slot += 1) {
      if ((out.slotEnd[slot] ?? 0) < born) {
        placed = slot;
        break;
      }
    }

    if (placed === -1) {
      placed = out.slots;
      out.slotAt[placed] = total;
      out.slotSize[placed] = size;
      total += size;
      out.slots = placed + 1;
    } else if (size > (out.slotSize[placed] ?? 0)) {
      /*
       * The slot has to widen, and widening in place would overlap whatever follows it. Retiring
       * the slot and opening a new one is correct and costs one wasted slot; compacting would
       * move every offset after it, which is the stability the header refuses to give up.
       */
      out.slotEnd[placed] = Number.MAX_SAFE_INTEGER;
      placed = out.slots;
      out.slotAt[placed] = total;
      out.slotSize[placed] = size;
      total += size;
      out.slots = placed + 1;
    }

    out.offsets[id] = out.slotAt[placed] ?? 0;
    out.slotEnd[placed] = dies;
  }

  return total;
}

export function offsetOf(plan: AliasPlan, id: number): number {
  return plan.offsets[id] ?? -1;
}
