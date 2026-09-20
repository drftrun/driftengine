/**
 * What is here, what is on its way, and what is not.
 *
 * **The tile the current frame is sampling is never evicted.** That is the one rule this structure
 * exists to enforce: an eviction policy that can reclaim a tile in use produces a frame drawn
 * against a page somebody else is writing, which is a corruption rather than a stall and does not
 * look like a streaming problem at all.
 */
export const TILE_ABSENT = 0;
export const TILE_REQUESTED = 1;
export const TILE_RESIDENT = 2;

export interface ResidencyTable {
  state: Map<string, number>;
  slot: Map<string, number>;
  /** Monotonic counter standing in for time, so eviction needs no clock. */
  touchedAt: Map<string, number>;
  clock: number;
  capacity: number;
}

export function createResidencyTable(capacity: number): ResidencyTable {
  return { state: new Map(), slot: new Map(), touchedAt: new Map(), clock: 0, capacity };
}

export function tileState(table: ResidencyTable, hash: string): number {
  return table.state.get(hash) ?? TILE_ABSENT;
}

export function markRequested(table: ResidencyTable, hash: string): void {
  /* An already-resident tile is not re-requested: that is a second fetch of bytes we hold. */
  if (tileState(table, hash) !== TILE_ABSENT) return;
  table.state.set(hash, TILE_REQUESTED);
}

export function markResident(table: ResidencyTable, hash: string, slot: number): void {
  table.state.set(hash, TILE_RESIDENT);
  table.slot.set(hash, slot);
  touchTile(table, hash);
}

/** Say this tile is in use now, so eviction will not take it. */
export function touchTile(table: ResidencyTable, hash: string): void {
  table.clock += 1;
  table.touchedAt.set(hash, table.clock);
}

export function evict(table: ResidencyTable, hash: string): void {
  table.state.delete(hash);
  table.slot.delete(hash);
  table.touchedAt.delete(hash);
}

export function slotFor(table: ResidencyTable, hash: string): number {
  return table.slot.get(hash) ?? -1;
}

export function residentCount(table: ResidencyTable): number {
  let count = 0;
  for (const state of table.state.values()) if (state === TILE_RESIDENT) count += 1;
  return count;
}

/**
 * The least recently used resident tiles, oldest first, **excluding anything touched since
 * `since`**.
 *
 * The exclusion is the point. A caller passes the clock value from the start of the frame, and
 * everything this frame has sampled is off the table.
 */
export function leastRecentlyUsed(
  table: ResidencyTable,
  since: number,
  out: string[],
  count: number,
): number {
  const candidates: { hash: string; at: number }[] = [];
  for (const [hash, state] of table.state) {
    if (state !== TILE_RESIDENT) continue;
    const at = table.touchedAt.get(hash) ?? 0;
    if (at > since) continue;
    candidates.push({ hash, at });
  }
  candidates.sort((a, b) => a.at - b.at || (a.hash < b.hash ? -1 : 1));
  const written = Math.min(count, candidates.length);
  for (let i = 0; i < written; i += 1) out[i] = (candidates[i] as { hash: string }).hash;
  out.length = written;
  return written;
}
