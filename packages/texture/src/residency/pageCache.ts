/**
 * Decoded pages, and the switch that decides when the decoding happens.
 *
 * **This carries a mode because the spec's §9 names the risk rather than hoping about it.** If
 * per-sample neural decode turns out too slow in the general case, the fallback is to decode once
 * when a tile becomes resident and sample it as an ordinary texture thereafter — which loses
 * procedural and per-sample parameterisation for the affected materials and keeps the compression,
 * the joint channels and the streaming. Building the switch now costs a field and a branch.
 * Retrofitting it into a pipeline that assumes per-sample decode everywhere costs a great deal,
 * and would be attempted on the day somebody discovered the frame time, which is the worst day.
 *
 * **A page acquired this frame is never evicted.** The same rule `table.ts` exists to enforce, one
 * level down and for the same reason: reclaiming a page the current frame is sampling produces a
 * frame drawn against bytes somebody else is writing, which is a corruption rather than a stall
 * and does not look like a streaming problem at all. A cache with nothing else to give refuses —
 * `acquirePage` returns `-1` — because a wrong page is worse than no page.
 *
 * **What was evicted is reported, and the plan's signature had nowhere to say it.** A residency
 * table that still calls a tile resident after its page has been reused points at a slot another
 * tile now owns. The eviction has to reach the table, so it is drained rather than dropped.
 */

/** Where the decode happens. See the header for which risk the second one is the answer to. */
export type DecodeMode = 'per-sample' | 'on-residency';

/** How a page's bytes are produced. Supplied by the caller: a cache cannot know a format. */
export type PageDecode = (hash: string, into: Uint8Array) => void;

export interface PageCacheOptions {
  readonly mode?: DecodeMode;
  /**
   * What fills a page in `on-residency` mode.
   *
   * Optional, because a cache in `per-sample` mode never decodes and a test of the eviction policy
   * has nothing to decode. Absent in `on-residency` mode, a page is acquired undecoded and
   * `pageDecoded` says so rather than the cache pretending.
   */
  readonly decode?: PageDecode;
}

export interface PageCache {
  readonly pages: number;
  readonly pageBytes: number;
  /** Every page, back to back. Slot `n` is `[n * pageBytes, (n + 1) * pageBytes)`. */
  readonly bytes: Uint8Array;
  /** Which hash holds each slot, or `''` where it is free. */
  readonly holder: string[];
  /** Whether each slot's bytes have been decoded into. */
  readonly decoded: boolean[];
  slotOf: Map<string, number>;
  /** Monotonic, standing in for time, so eviction needs no clock. As `table.ts` does. */
  touchedAt: Map<string, number>;
  clock: number;
  /** The clock at the start of the frame. Nothing touched after it may be evicted. */
  frameStart: number;
  mode: DecodeMode;
  decode: PageDecode | null;
  /** Hashes whose pages have been taken since the caller last drained this. */
  evicted: string[];
}

export function createPageCache(
  pages: number,
  pageBytes: number,
  options: PageCacheOptions = {},
): PageCache {
  const count = Math.max(1, Math.floor(pages));
  const size = Math.max(1, Math.floor(pageBytes));
  return {
    pages: count,
    pageBytes: size,
    bytes: new Uint8Array(count * size),
    holder: new Array<string>(count).fill(''),
    decoded: new Array<boolean>(count).fill(false),
    slotOf: new Map<string, number>(),
    touchedAt: new Map<string, number>(),
    clock: 0,
    frameStart: 0,
    mode: options.mode ?? 'per-sample',
    decode: options.decode ?? null,
    evicted: [],
  };
}

/**
 * Say a new frame has begun, so everything acquired from here is protected from eviction.
 *
 * A caller that never calls this gets a cache that protects everything and fills up, which is a
 * visible stall rather than a silent corruption — the right way round for a mistake to fail.
 */
export function beginCacheFrame(cache: PageCache): void {
  cache.frameStart = cache.clock;
}

function touch(cache: PageCache, hash: string): void {
  cache.clock += 1;
  cache.touchedAt.set(hash, cache.clock);
}

/**
 * The slot holding this tile's page, acquiring one if it is not held. `-1` where none can be given.
 *
 * Acquiring a hash that is already here returns the same slot and takes no page from anybody: the
 * commonest call by far, and the one that must not evict.
 */
export function acquirePage(cache: PageCache, hash: string): number {
  const held = cache.slotOf.get(hash);
  if (held !== undefined) {
    touch(cache, hash);
    return held;
  }

  let slot = cache.holder.indexOf('');
  if (slot < 0) {
    const victim = evictable(cache);
    if (victim === null) return -1;
    slot = cache.slotOf.get(victim) as number;
    release(cache, victim, slot);
    cache.evicted.push(victim);
  }

  cache.holder[slot] = hash;
  cache.slotOf.set(hash, slot);
  /* No `decoded[slot] = false` here: `release` owns that, and every slot reaching this point came
     either from `release` or from never having been used. A second reset changed nothing, which a
     perturbation showed by failing no test. */
  cache.bytes.fill(0, slot * cache.pageBytes, (slot + 1) * cache.pageBytes);
  touch(cache, hash);

  /* The whole of the mode switch: in one, the bytes are produced now; in the other, at sample
     time by whoever samples, and this cache holds the compressed page unchanged. */
  if (cache.mode === 'on-residency') ensurePageDecoded(cache, hash);
  return slot;
}

/** The least recently used page that this frame has not touched, or null. */
function evictable(cache: PageCache): string | null {
  let worst: string | null = null;
  let at = Infinity;
  for (const hash of cache.slotOf.keys()) {
    const when = cache.touchedAt.get(hash) ?? 0;
    if (when > cache.frameStart) continue;
    if (when >= at) continue;
    at = when;
    worst = hash;
  }
  return worst;
}

/**
 * Take a page back, leaving the slot free and claimed by nobody.
 *
 * **`touchedAt` is deleted as well**, which is not tidiness: without it the map grows by one entry
 * per tile the cache has ever seen, so a three-page cache that streamed a level holds three pages
 * and thousands of timestamps. There is a test that counts them.
 */
function release(cache: PageCache, hash: string, slot: number): void {
  cache.holder[slot] = '';
  cache.decoded[slot] = false;
  cache.slotOf.delete(hash);
  cache.touchedAt.delete(hash);
}

/** Give a page back. Its slot is free for the next acquisition, and its bytes are not kept. */
export function releasePage(cache: PageCache, hash: string): void {
  const slot = cache.slotOf.get(hash);
  if (slot === undefined) return;
  release(cache, hash, slot);
}

export function pageSlot(cache: PageCache, hash: string): number {
  return cache.slotOf.get(hash) ?? -1;
}

export function pageDecoded(cache: PageCache, hash: string): boolean {
  const slot = cache.slotOf.get(hash);
  return slot === undefined ? false : (cache.decoded[slot] ?? false);
}

/**
 * Decode a held page if the mode says the cache owns that, and it has not been done.
 *
 * Returns whether the page's bytes are now the decoded ones. `false` in `per-sample` mode is the
 * ordinary answer rather than a failure: the bytes are the compressed page and whoever samples
 * decodes them.
 */
export function ensurePageDecoded(cache: PageCache, hash: string): boolean {
  if (cache.mode !== 'on-residency') return false;
  const slot = cache.slotOf.get(hash);
  if (slot === undefined) return false;
  if (cache.decoded[slot] === true) return true;
  if (cache.decode === null) return false;
  cache.decode(hash, cache.bytes.subarray(slot * cache.pageBytes, (slot + 1) * cache.pageBytes));
  cache.decoded[slot] = true;
  return true;
}

export function decodeMode(cache: PageCache): DecodeMode {
  return cache.mode;
}

/**
 * Change where the decode happens, invalidating every page that was decoded under the old rule.
 *
 * **Invalidating rather than converting.** A page decoded per-sample and one decoded on residency
 * hold different bytes, so keeping them and changing the flag serves a sampler the wrong ones —
 * silently, and only for the pages that happened to be resident when somebody flipped the switch.
 * The pages stay held; what is lost is the claim that their contents are current.
 */
export function setDecodeMode(cache: PageCache, mode: DecodeMode): void {
  if (mode === cache.mode) return;
  cache.mode = mode;
  cache.decoded.fill(false);
}

/** How many pages are held. What a profiler panel shows beside the resident tile count. */
export function occupiedPages(cache: PageCache): number {
  return cache.slotOf.size;
}

/**
 * Drain the hashes whose pages have been taken, into `out`. Returns how many.
 *
 * A caller that never drains this leaks a string per eviction, which is why it is a drain rather
 * than a log: the list is a message to the residency table, and a message nobody reads is a bug in
 * the caller that should grow rather than hide.
 */
export function takeEvicted(cache: PageCache, out: string[]): number {
  out.length = 0;
  for (const hash of cache.evicted) out.push(hash);
  cache.evicted.length = 0;
  return out.length;
}
