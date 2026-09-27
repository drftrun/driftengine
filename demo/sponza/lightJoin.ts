/**
 * Two selections joined into one light buffer, the first ahead of the second.
 *
 * The fires choose the braziers and lanterns and the candles separately, because one nearest-first
 * list gave every slot to candles, and hand the renderer one list. Allocation-free: it copies
 * slots between buffers that already exist.
 */
import type { createPointLightBuffer } from '../../packages/core/src/index';

export type LightBuffer = ReturnType<typeof createPointLightBuffer>;

/**
 * `first`'s lights then `second`'s into `out`, with `second`'s source indices moved past the
 * `offset` lights that precede them in the full list. The shadow pool is `first`'s: only it casts.
 */
export function join(
  out: LightBuffer,
  first: LightBuffer,
  second: LightBuffer,
  offset: number,
): void {
  const slot = append(out, first, 0, 0);
  out.count = append(out, second, offset, slot);
  out.shadowCount = first.shadowCount;
  out.shadowIndex.set(first.shadowIndex);
}

/** `from`'s lights into `out` from `slot` on, source indices moved by `shift`. Answers the next slot. */
function append(out: LightBuffer, from: LightBuffer, shift: number, slot: number): number {
  const room = out.radii.length;
  for (let at = 0; at < from.count && slot < room; at++, slot++) {
    for (let c = 0; c < 3; c++) {
      out.positions[slot * 3 + c] = from.positions[at * 3 + c] ?? 0;
      out.colors[slot * 3 + c] = from.colors[at * 3 + c] ?? 0;
      out.directions[slot * 3 + c] = from.directions[at * 3 + c] ?? 0;
    }
    out.coneCos[slot * 2] = from.coneCos[at * 2] ?? 0;
    out.coneCos[slot * 2 + 1] = from.coneCos[at * 2 + 1] ?? 0;
    out.radii[slot] = from.radii[at] ?? 0;
    out.sourceRadii[slot] = from.sourceRadii[at] ?? 0;
    out.weights[slot] = from.weights[at] ?? 0;
    out.iesProfiles[slot] = from.iesProfiles[at] ?? -1;
    out.sourceIndex[slot] = (from.sourceIndex[at] ?? 0) + shift;
  }
  return slot;
}
