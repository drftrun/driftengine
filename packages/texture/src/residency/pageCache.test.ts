import { describe, expect, it } from 'vitest';
import {
  acquirePage,
  beginCacheFrame,
  createPageCache,
  decodeMode,
  ensurePageDecoded,
  occupiedPages,
  pageDecoded,
  pageSlot,
  releasePage,
  setDecodeMode,
  takeEvicted,
  type PageCache,
} from './pageCache.ts';

/** A cache whose decoder writes a byte a caller can recognise, and counts its own calls. */
function counted(
  pages: number,
  options: { mode?: 'per-sample' | 'on-residency' } = {},
): { cache: PageCache; decodes: string[] } {
  const decodes: string[] = [];
  const cache = createPageCache(pages, 4, {
    mode: options.mode,
    decode: (hash: string, into: Uint8Array): void => {
      decodes.push(hash);
      into.fill(hash.charCodeAt(0));
    },
  });
  return { cache, decodes };
}

/**
 * The slot map and the holder array say the same thing.
 *
 * Checked rather than assumed, because the way this structure goes wrong is that they disagree: a
 * slot claimed by two tiles reads correctly through one of them and hands the other somebody else's
 * bytes, which is the corruption the whole subsystem exists to prevent.
 */
function consistent(cache: PageCache): void {
  for (const [hash, slot] of cache.slotOf) {
    expect(cache.holder[slot], `slot ${String(slot)} should hold ${hash}`).toBe(hash);
  }
  expect(cache.holder.filter((held) => held !== '')).toHaveLength(cache.slotOf.size);
}

describe('a page is acquired once and found again', () => {
  it('gives a slot, and the same slot for the same tile', () => {
    const { cache } = counted(4);
    const first = acquirePage(cache, 'a');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(acquirePage(cache, 'a')).toBe(first);
    expect(occupiedPages(cache)).toBe(1);
  });

  it('gives distinct tiles distinct slots', () => {
    const { cache } = counted(4);
    const slots = ['a', 'b', 'c', 'd'].map((hash) => acquirePage(cache, hash));
    expect(new Set(slots).size).toBe(4);
    expect(occupiedPages(cache)).toBe(4);
    expect(slots.every((slot) => slot >= 0 && slot < 4)).toBe(true);
  });

  it('reports a tile it does not hold as having no slot', () => {
    const { cache } = counted(4);
    expect(pageSlot(cache, 'nowhere')).toBe(-1);
    expect(pageDecoded(cache, 'nowhere')).toBe(false);
  });

  it('frees a released slot for the next tile', () => {
    const { cache } = counted(2);
    const a = acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    releasePage(cache, 'a');
    expect(occupiedPages(cache)).toBe(1);
    expect(acquirePage(cache, 'c')).toBe(a);
    /* And releasing something that was never here is not an error; it is a caller being careful.
       It must also not free somebody else's slot, which a lookup defaulting to zero would do. */
    releasePage(cache, 'never');
    expect(occupiedPages(cache)).toBe(2);
    consistent(cache);
  });
});

describe('a full cache evicts, but never what this frame is using', () => {
  it('takes the least recently used', () => {
    const { cache } = counted(3);
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    acquirePage(cache, 'c');
    /* `a` is oldest until it is touched again, and then `b` is. */
    acquirePage(cache, 'a');
    beginCacheFrame(cache);

    const taken = acquirePage(cache, 'd');
    expect(taken).toBeGreaterThanOrEqual(0);
    expect(pageSlot(cache, 'b')).toBe(-1);
    expect(pageSlot(cache, 'a')).toBeGreaterThanOrEqual(0);
    expect(pageSlot(cache, 'c')).toBeGreaterThanOrEqual(0);
  });

  it('refuses rather than taking a page acquired this frame', () => {
    /*
     * The rule `table.ts` exists to enforce, one level down. A wrong page is worse than no page: a
     * frame drawn against bytes somebody else is writing is a corruption rather than a stall, and
     * it does not look like a streaming problem at all.
     */
    const { cache } = counted(3);
    beginCacheFrame(cache);
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    acquirePage(cache, 'c');
    expect(acquirePage(cache, 'd')).toBe(-1);
    expect(occupiedPages(cache)).toBe(3);

    /* The next frame, the same request succeeds. */
    beginCacheFrame(cache);
    expect(acquirePage(cache, 'd')).toBeGreaterThanOrEqual(0);
  });

  it('says what it took, so the residency table can stop calling it resident', () => {
    /* A table still pointing at a reused slot is the corruption this whole subsystem is about. */
    const { cache } = counted(2);
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    beginCacheFrame(cache);
    acquirePage(cache, 'c');

    const out: string[] = [];
    expect(takeEvicted(cache, out)).toBe(1);
    expect(out).toEqual(['a']);
    /* Drained, not logged: a second drain reports nothing rather than the same eviction again. */
    expect(takeEvicted(cache, out)).toBe(0);
  });

  it('does not count a re-acquisition as an eviction', () => {
    const { cache } = counted(2);
    acquirePage(cache, 'a');
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    const out: string[] = [];
    expect(takeEvicted(cache, out)).toBe(0);
  });
});

describe('where the decode happens', () => {
  it('decodes once per acquisition on residency, and not again for the same tile', () => {
    const { cache, decodes } = counted(4, { mode: 'on-residency' });
    expect(decodeMode(cache)).toBe('on-residency');
    acquirePage(cache, 'a');
    expect(decodes).toEqual(['a']);
    acquirePage(cache, 'a');
    expect(decodes).toEqual(['a']);
    expect(pageDecoded(cache, 'a')).toBe(true);
    /* And the bytes really are the decoder's. */
    expect(cache.bytes[pageSlot(cache, 'a') * cache.pageBytes]).toBe('a'.charCodeAt(0));
  });

  it('decodes nothing at acquisition per sample, which is the default', () => {
    const { cache, decodes } = counted(4);
    expect(decodeMode(cache)).toBe('per-sample');
    acquirePage(cache, 'a');
    expect(decodes).toEqual([]);
    expect(pageDecoded(cache, 'a')).toBe(false);
    /* Asking to decode does nothing either: in this mode the bytes belong to whoever samples. */
    expect(ensurePageDecoded(cache, 'a')).toBe(false);
    expect(decodes).toEqual([]);
  });

  it('acquires undecoded on residency when nobody supplied a decoder', () => {
    /* It says so rather than pretending: a page marked decoded that nothing decoded is the stale
       byte this whole mode exists to avoid. */
    const cache = createPageCache(2, 4, { mode: 'on-residency' });
    acquirePage(cache, 'a');
    expect(pageDecoded(cache, 'a')).toBe(false);
    /* And it says so on the way out too, rather than reporting a decode nothing performed. */
    expect(ensurePageDecoded(cache, 'a')).toBe(false);
  });

  it('decodes a tile that takes over a slot, rather than serving the last tenant’s bytes', () => {
    const { cache, decodes } = counted(1, { mode: 'on-residency' });
    acquirePage(cache, 'a');
    beginCacheFrame(cache);
    acquirePage(cache, 'b');
    expect(decodes).toEqual(['a', 'b']);
    expect(cache.bytes[0]).toBe('b'.charCodeAt(0));
  });
});

describe('switching the mode invalidates rather than converts', () => {
  it('drops the claim that decoded pages are current', () => {
    /*
     * A page decoded per-sample and one decoded on residency hold different bytes, so keeping them
     * and changing the flag serves a sampler the wrong ones — silently, and only for whatever
     * happened to be resident when somebody flipped the switch.
     */
    const { cache } = counted(4, { mode: 'on-residency' });
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    expect(pageDecoded(cache, 'a')).toBe(true);

    setDecodeMode(cache, 'per-sample');
    expect(decodeMode(cache)).toBe('per-sample');
    expect(pageDecoded(cache, 'a')).toBe(false);
    expect(pageDecoded(cache, 'b')).toBe(false);
    /* The pages are still held; what was lost is the claim about their contents. */
    expect(occupiedPages(cache)).toBe(2);
    expect(pageSlot(cache, 'a')).toBeGreaterThanOrEqual(0);
  });

  it('re-decodes on demand after switching back, and only once', () => {
    const { cache, decodes } = counted(4, { mode: 'on-residency' });
    acquirePage(cache, 'a');
    setDecodeMode(cache, 'per-sample');
    setDecodeMode(cache, 'on-residency');
    expect(pageDecoded(cache, 'a')).toBe(false);
    expect(ensurePageDecoded(cache, 'a')).toBe(true);
    /* Asked again, it is already done: a page re-decoded on every sample is the cost this mode
       exists to avoid paying. */
    expect(ensurePageDecoded(cache, 'a')).toBe(true);
    expect(decodes).toEqual(['a', 'a']);
  });

  it('does nothing when the mode is already the one asked for', () => {
    const { cache } = counted(4, { mode: 'on-residency' });
    acquirePage(cache, 'a');
    setDecodeMode(cache, 'on-residency');
    expect(pageDecoded(cache, 'a')).toBe(true);
  });
});

describe('occupancy, which is what the profiler shows', () => {
  it('counts what is held and nothing else', () => {
    const { cache } = counted(4);
    expect(occupiedPages(cache)).toBe(0);
    acquirePage(cache, 'a');
    acquirePage(cache, 'b');
    expect(occupiedPages(cache)).toBe(2);
    releasePage(cache, 'a');
    expect(occupiedPages(cache)).toBe(1);
    expect(cache.pages).toBe(4);
  });

  it('never exceeds the page count, however many tiles ask', () => {
    const { cache } = counted(3);
    for (let at = 0; at < 50; at += 1) {
      beginCacheFrame(cache);
      acquirePage(cache, `tile${String(at)}`);
    }
    expect(occupiedPages(cache)).toBe(3);
    consistent(cache);
    /*
     * And it remembers three tiles, not fifty. A timestamp left behind for every tile ever seen is
     * a map that grows for the life of the session while the cache itself never does — the leak
     * that looks like nothing because the thing it is attached to is bounded.
     */
    expect(cache.touchedAt.size).toBe(3);
  });
});
