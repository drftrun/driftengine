/**
 * What to fetch next, ordered by how soon it will be needed.
 *
 * **That ordering is not available to a reactive system at all.** Everything a feedback buffer
 * reports is already needed; there is nothing to rank. Prediction produces a horizon, so a tile
 * wanted in one frame can outrank one wanted in eight — which is the difference between spending a
 * limited byte budget well and spending it arbitrarily.
 *
 * **A full queue drops its worst entry rather than refusing the best one.** Refusing on arrival
 * would discard exactly the tiles a late prediction found most urgent.
 */
export interface PrefetchQueue {
  /** Priority per hash. Lower is sooner, so it sorts naturally. */
  priority: Map<string, number>;
  capacity: number;
}

export function createPrefetchQueue(capacity: number): PrefetchQueue {
  return { priority: new Map(), capacity };
}

export function enqueue(queue: PrefetchQueue, hash: string, priority: number): void {
  const existing = queue.priority.get(hash);
  /* One entry per tile, keeping the better claim on it. */
  if (existing !== undefined) {
    if (priority < existing) queue.priority.set(hash, priority);
    return;
  }
  queue.priority.set(hash, priority);
  if (queue.priority.size <= queue.capacity) return;

  let worst = '';
  let worstPriority = -Infinity;
  for (const [key, value] of queue.priority) {
    if (value > worstPriority) {
      worstPriority = value;
      worst = key;
    }
  }
  queue.priority.delete(worst);
}

export function queueSize(queue: PrefetchQueue): number {
  return queue.priority.size;
}

/**
 * Take the next batch, soonest first, within a byte budget.
 *
 * **Residency is checked here rather than at enqueue**, because it may have changed in between —
 * a tile requested eight frames ahead may well have arrived by the time its turn comes.
 */
export function takeBatch(
  queue: PrefetchQueue,
  isResident: (hash: string) => boolean,
  bytesBudget: number,
  tileBytes: number,
  out: string[],
): number {
  const ordered = [...queue.priority.entries()].sort(
    (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1),
  );
  let spent = 0;
  let written = 0;
  for (const [hash] of ordered) {
    if (isResident(hash)) {
      queue.priority.delete(hash);
      continue;
    }
    if (spent + tileBytes > bytesBudget) break;
    out[written] = hash;
    written += 1;
    spent += tileBytes;
    queue.priority.delete(hash);
  }
  out.length = written;
  return written;
}
