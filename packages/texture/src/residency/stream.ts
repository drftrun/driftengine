/**
 * Getting the bytes, and giving up on the ones that are not coming.
 *
 * **A tile that will not arrive stops being waited for.** That is the whole of this file's
 * difficulty. A fetch that resolves with nothing — a tile the container does not hold, a name from
 * a stale index, a range the server refused — leaves the tile marked requested and its slot
 * occupied forever if nobody handles it. A handful of those and the in-flight budget is gone, so
 * every subsequent fetch is refused and **streaming stops entirely**, with no error anywhere: the
 * world simply never finishes loading, and the last thing that happened was unrelated.
 *
 * So a missing tile is remembered as missing. Not evicted-and-forgotten, which asks for it again on
 * the next pump and turns one absent tile into a fetch every frame; and not left requested, which
 * is the leak. `forgetMissing` exists because "missing" is a fact about a container and a caller
 * that mounts a different one is entitled to ask again.
 *
 * **The source is the caller's.** What a tile's bytes are behind — a `.drft` container, a range
 * request, a file — is not this package's business, and a streamer that knew would be a streamer
 * every host had to agree with. It is one method returning a promise of bytes or nothing.
 *
 * **Nothing here awaits.** `pumpStreamer` starts work and returns; a source that never resolves
 * costs an in-flight slot and nothing else. A streamer that awaited its own fetches would stall the
 * frame that called it, which is the failure streaming exists to avoid.
 */
import {
  TILE_ABSENT,
  TILE_REQUESTED,
  evict,
  markRequested,
  markResident,
  tileState,
  type ResidencyTable,
} from './table.ts';
import { acquirePage, takeEvicted, type PageCache } from './pageCache.ts';

/** Where a tile's bytes come from. Resolving `null` means the source does not have it. */
export interface TileSource {
  fetch(hash: string): Promise<Uint8Array | null>;
}

export interface StreamerOptions {
  /**
   * How many fetches may be outstanding at once.
   *
   * A bound rather than none, because an unbounded streamer asked for a thousand tiles opens a
   * thousand connections and finishes none of them sooner.
   */
  readonly maxInFlight?: number;
}

export interface Streamer {
  readonly source: TileSource;
  readonly table: ResidencyTable;
  readonly cache: PageCache;
  readonly maxInFlight: number;
  /** Tiles asked for and not yet answered. */
  readonly inFlight: Set<string>;
  /** Tiles the source answered `null` for. Not asked for again until forgotten. */
  readonly missing: Set<string>;
  /** Fetches that landed after their tile had been evicted. Counted, not silently dropped. */
  stale: number;
  /** Fetches that landed with no page free to put them in. The tile stays absent and is retried. */
  deferred: number;
  /** Fetches whose bytes were larger than a page. A container and a cache disagreeing. */
  oversize: number;
}

export function createStreamer(
  source: TileSource,
  table: ResidencyTable,
  cache: PageCache,
  options: StreamerOptions = {},
): Streamer {
  return {
    source,
    table,
    cache,
    maxInFlight: Math.max(1, Math.floor(options.maxInFlight ?? 8)),
    inFlight: new Set<string>(),
    missing: new Set<string>(),
    stale: 0,
    deferred: 0,
    oversize: 0,
  };
}

export function streamerInFlight(streamer: Streamer): number {
  return streamer.inFlight.size;
}

/** Stop calling a tile missing, so the next pump asks for it again. */
export function forgetMissing(streamer: Streamer, hash: string): void {
  streamer.missing.delete(hash);
}

export function clearMissing(streamer: Streamer): void {
  streamer.missing.clear();
}

/**
 * Ask for the first `count` tiles of `batch` that are worth asking for. Returns how many were sent.
 *
 * Skips anything already resident, already in flight, or known missing — which is what makes
 * calling this every frame with the same batch correct rather than a fetch storm.
 */
export function pumpStreamer(streamer: Streamer, batch: readonly string[], count: number): number {
  let sent = 0;
  /* A bound on the loop rather than a correctness check — the `undefined` guard below is what
     makes a short batch behave, and a perturbation removing this one fails no test. It stays
     because without it `pumpStreamer(s, [], 1e9)` spins a billion times to do nothing. */
  const wanted = Math.min(count, batch.length);
  for (let at = 0; at < wanted; at += 1) {
    if (streamer.inFlight.size >= streamer.maxInFlight) break;
    const hash = batch[at];
    if (hash === undefined) continue;
    if (streamer.missing.has(hash)) continue;
    /* Already asked for. Usually the table says so too, but not after an eviction while the fetch
       was still out: the tile is absent again and a second fetch of bytes already on their way is
       exactly what a content-addressed store makes pointless. */
    if (streamer.inFlight.has(hash)) continue;
    if (tileState(streamer.table, hash) !== TILE_ABSENT) continue;

    markRequested(streamer.table, hash);
    streamer.inFlight.add(hash);
    sent += 1;
    /*
     * Not awaited: this returns to the frame that called it. A rejection is treated exactly as a
     * missing tile, because from here they are the same fact — the bytes are not coming — and a
     * streamer that let one through would be the leak this file is about, arriving by the one path
     * nobody writes a test for.
     */
    void streamer.source
      .fetch(hash)
      .then((bytes) => {
        land(streamer, hash, bytes);
      })
      .catch(() => {
        land(streamer, hash, null);
      });
  }
  return sent;
}

function land(streamer: Streamer, hash: string, bytes: Uint8Array | null): void {
  streamer.inFlight.delete(hash);

  /*
   * Evicted while in flight. Its slot belongs to somebody else now, so these bytes go nowhere —
   * and the tile is left absent rather than resurrected, because whatever evicted it decided it
   * was not wanted and this arriving late does not change that.
   */
  if (tileState(streamer.table, hash) !== TILE_REQUESTED) {
    streamer.stale += 1;
    return;
  }

  if (bytes === null) {
    evict(streamer.table, hash);
    streamer.missing.add(hash);
    return;
  }

  if (bytes.length > streamer.cache.pageBytes) {
    /* A truncation here would be a tile that decodes to something nobody authored, found weeks
       later as a corrupt-looking texture. Refused, counted, and left absent. */
    streamer.oversize += 1;
    evict(streamer.table, hash);
    streamer.missing.add(hash);
    return;
  }

  const slot = acquirePage(streamer.cache, hash);
  if (slot < 0) {
    /* Every page is in use by this frame. The tile stays absent, so the next pump asks again. */
    streamer.deferred += 1;
    evict(streamer.table, hash);
    return;
  }
  drainEvictions(streamer);

  streamer.cache.bytes.set(bytes, slot * streamer.cache.pageBytes);
  markResident(streamer.table, hash, slot);
}

/**
 * Tell the table about pages the cache took, so nothing is called resident in a slot it lost.
 *
 * The one piece of wiring between the two structures, and the reason `takeEvicted` exists: a table
 * still pointing at a reused slot hands a frame another tile's bytes.
 */
function drainEvictions(streamer: Streamer): void {
  const taken: string[] = [];
  takeEvicted(streamer.cache, taken);
  for (const hash of taken) evict(streamer.table, hash);
}
