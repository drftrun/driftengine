/**
 * Getting a number back from the GPU without waiting for it.
 *
 * The answer to a request made this frame arrives two or three frames later, and a caller that
 * waits has stalled the pipeline to learn something it could have learned late for free. So this
 * is a ring of slots: a request takes one, the completion fills it, and the caller collects
 * whatever has arrived whenever it asks.
 *
 * **A full ring refuses rather than overwrites.** Silently dropping the oldest result produces a
 * statistic that is wrong in a way nothing detects — a frame time that is quietly somebody
 * else's, which is worse than a frame time that is missing.
 *
 * **Deliberately not what texture residency uses.** Reactive streaming is exactly the
 * arrangement where this latency becomes visible as pop-in; the answer there is to predict
 * rather than to read back. This ring is for timings and statistics, where being three frames
 * late costs nothing.
 */
export interface ReadbackRing {
  /** 0 free, 1 outstanding, 2 arrived, one per slot. */
  state: Uint8Array;
  /** The arrived buffer per slot, or null. */
  data: (ArrayBuffer | null)[];
  /** Where to start looking for a free slot, so requests spread rather than reusing one. */
  next: number;
}

export function createReadbackRing(slots: number): ReadbackRing {
  return {
    state: new Uint8Array(slots),
    data: Array.from({ length: slots }, () => null),
    next: 0,
  };
}

export function beginReadback(ring: ReadbackRing): number {
  const slots = ring.state.length;
  for (let i = 0; i < slots; i += 1) {
    const slot = (ring.next + i) % slots;
    if (ring.state[slot] === 0) {
      ring.state[slot] = 1;
      ring.next = (slot + 1) % slots;
      return slot;
    }
  }
  return -1;
}

export function completeReadback(ring: ReadbackRing, slot: number, data: ArrayBuffer): void {
  if (slot < 0 || slot >= ring.state.length) return;
  /* Only an outstanding slot may be completed: one that was evicted or never requested is not
   * ours to fill, and filling it would hand the caller a result for a request it has forgotten. */
  if (ring.state[slot] !== 1) return;
  ring.state[slot] = 2;
  ring.data[slot] = data;
}

export function takeReadback(ring: ReadbackRing): ArrayBuffer | null {
  for (let slot = 0; slot < ring.state.length; slot += 1) {
    if (ring.state[slot] === 2) {
      const data = ring.data[slot] ?? null;
      ring.state[slot] = 0;
      ring.data[slot] = null;
      return data;
    }
  }
  return null;
}

export function readbackPending(ring: ReadbackRing): number {
  let pending = 0;
  for (let slot = 0; slot < ring.state.length; slot += 1) if (ring.state[slot] === 1) pending += 1;
  return pending;
}
