import { describe, expect, it } from 'vitest';
import {
  TILE_ABSENT,
  TILE_REQUESTED,
  TILE_RESIDENT,
  createResidencyTable,
  evict,
  residentCount,
  slotFor,
  tileState,
  type ResidencyTable,
} from './table.ts';
import { acquirePage, beginCacheFrame, createPageCache, type PageCache } from './pageCache.ts';
import {
  clearMissing,
  createStreamer,
  forgetMissing,
  pumpStreamer,
  streamerInFlight,
  type Streamer,
  type TileSource,
} from './stream.ts';

/** A source a test drives by hand: it records what was asked and answers when told to. */
interface Controlled extends TileSource {
  readonly asked: string[];
  settle(hash: string, bytes: Uint8Array | null): void;
  fail(hash: string): void;
  pendingCount(): number;
}

function controlled(): Controlled {
  const pending = new Map<
    string,
    { resolve: (bytes: Uint8Array | null) => void; reject: (reason: Error) => void }
  >();
  const asked: string[] = [];
  return {
    asked,
    fetch: (hash: string): Promise<Uint8Array | null> => {
      asked.push(hash);
      return new Promise<Uint8Array | null>((resolve, reject) => {
        pending.set(hash, { resolve, reject });
      });
    },
    settle: (hash: string, bytes: Uint8Array | null): void => {
      pending.get(hash)?.resolve(bytes);
      pending.delete(hash);
    },
    fail: (hash: string): void => {
      pending.get(hash)?.reject(new Error('refused'));
      pending.delete(hash);
    },
    pendingCount: (): number => pending.size,
  };
}

/** Let every settled promise run its handlers. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Rig {
  source: Controlled;
  table: ResidencyTable;
  cache: PageCache;
  streamer: Streamer;
}

function rig(options: { pages?: number; maxInFlight?: number } = {}): Rig {
  const source = controlled();
  const table = createResidencyTable(64);
  const cache = createPageCache(options.pages ?? 8, 4);
  const streamer = createStreamer(source, table, cache, { maxInFlight: options.maxInFlight ?? 8 });
  return { source, table, cache, streamer };
}

const bytes = (fill: number): Uint8Array => new Uint8Array(4).fill(fill);

describe('a fetched tile becomes resident', () => {
  it('asks, waits, and lands in a page', async () => {
    const { source, table, cache, streamer } = rig();
    expect(pumpStreamer(streamer, ['a'], 1)).toBe(1);
    expect(source.asked).toEqual(['a']);
    expect(tileState(table, 'a')).toBe(TILE_REQUESTED);
    expect(streamerInFlight(streamer)).toBe(1);

    source.settle('a', bytes(7));
    await flush();

    expect(tileState(table, 'a')).toBe(TILE_RESIDENT);
    expect(streamerInFlight(streamer)).toBe(0);
    expect(residentCount(table)).toBe(1);
    const slot = slotFor(table, 'a');
    expect(cache.bytes[slot * cache.pageBytes]).toBe(7);
  });

  it('does not ask twice for a tile evicted while its fetch was still out', async () => {
    /*
     * The table says absent again, so the state check waves it through; the in-flight set is what
     * stops a second fetch of bytes already on their way. Content-addressed, so they are the same
     * bytes — a second request could only ever arrive later and be discarded.
     */
    const { source, table, streamer } = rig();
    pumpStreamer(streamer, ['a'], 1);
    evict(table, 'a');
    expect(tileState(table, 'a')).toBe(TILE_ABSENT);

    pumpStreamer(streamer, ['a'], 1);
    expect(source.asked).toEqual(['a']);
    expect(streamerInFlight(streamer)).toBe(1);

    /* And once it has landed and been discarded as stale, the next pump does ask again. */
    source.settle('a', bytes(1));
    await flush();
    pumpStreamer(streamer, ['a'], 1);
    expect(source.asked).toEqual(['a', 'a']);
  });

  it('asks once however many times it is pumped', async () => {
    const { source, streamer } = rig();
    pumpStreamer(streamer, ['a'], 1);
    pumpStreamer(streamer, ['a'], 1);
    pumpStreamer(streamer, ['a', 'a', 'a'], 3);
    expect(source.asked).toEqual(['a']);

    /* And once it is resident, still not again — which is what makes pumping the same batch every
       frame the ordinary way to use this rather than a fetch storm. */
    source.settle('a', bytes(1));
    await flush();
    pumpStreamer(streamer, ['a'], 1);
    expect(source.asked).toEqual(['a']);
  });
});

describe('a tile that will not arrive stops being waited for', () => {
  it('frees the slot and stops asking when the source has nothing', async () => {
    /*
     * The leak this file exists for: a handful of absent tiles fills the in-flight budget, every
     * later fetch is refused, and streaming stops with no error anywhere. The world simply never
     * finishes loading and the last thing that happened was unrelated.
     */
    const { source, table, streamer } = rig({ maxInFlight: 2 });
    pumpStreamer(streamer, ['gone', 'also-gone'], 2);
    expect(streamerInFlight(streamer)).toBe(2);

    source.settle('gone', null);
    source.settle('also-gone', null);
    await flush();

    expect(streamerInFlight(streamer)).toBe(0);
    expect(tileState(table, 'gone')).toBe(TILE_ABSENT);
    /* And the budget is available again, which is the whole point. */
    expect(pumpStreamer(streamer, ['real'], 1)).toBe(1);
  });

  it('does not ask again for what the source said it does not have', async () => {
    const { source, streamer } = rig();
    pumpStreamer(streamer, ['gone'], 1);
    source.settle('gone', null);
    await flush();

    pumpStreamer(streamer, ['gone'], 1);
    pumpStreamer(streamer, ['gone'], 1);
    expect(source.asked).toEqual(['gone']);
    expect(streamer.missing.has('gone')).toBe(true);
  });

  it('asks again once it is told to forget', async () => {
    /* "Missing" is a fact about a container, and a caller that mounted another one may ask. */
    const { source, streamer } = rig();
    pumpStreamer(streamer, ['gone'], 1);
    source.settle('gone', null);
    await flush();

    forgetMissing(streamer, 'gone');
    pumpStreamer(streamer, ['gone'], 1);
    expect(source.asked).toEqual(['gone', 'gone']);

    source.settle('gone', null);
    await flush();
    clearMissing(streamer);
    pumpStreamer(streamer, ['gone'], 1);
    expect(source.asked).toHaveLength(3);
  });

  it('treats a refusal exactly as a tile that is not there', async () => {
    /* The path nobody writes a test for, and the one that would reintroduce the leak. */
    const { source, table, streamer } = rig();
    pumpStreamer(streamer, ['broken'], 1);
    source.fail('broken');
    await flush();

    expect(streamerInFlight(streamer)).toBe(0);
    expect(tileState(table, 'broken')).toBe(TILE_ABSENT);
    expect(streamer.missing.has('broken')).toBe(true);
  });

  it('refuses bytes larger than a page rather than truncating them', async () => {
    /* A truncation is a tile that decodes to something nobody authored, found weeks later as a
       texture that looks corrupt for no reason anybody can trace. */
    const { source, table, streamer } = rig();
    pumpStreamer(streamer, ['huge'], 1);
    source.settle('huge', new Uint8Array(64));
    await flush();

    expect(streamer.oversize).toBe(1);
    expect(tileState(table, 'huge')).toBe(TILE_ABSENT);
    expect(residentCount(table)).toBe(0);
  });
});

describe('a fetch that lands too late', () => {
  it('does not resurrect a tile that was evicted while it was in flight', async () => {
    const { source, table, cache, streamer } = rig();
    pumpStreamer(streamer, ['a'], 1);
    evict(table, 'a');

    source.settle('a', bytes(9));
    await flush();

    expect(streamer.stale).toBe(1);
    expect(tileState(table, 'a')).toBe(TILE_ABSENT);
    expect(residentCount(table)).toBe(0);
    /* And it took no page: its slot belongs to whatever the eviction made room for. */
    expect(cache.slotOf.has('a')).toBe(false);
  });

  it('leaves a tile absent when every page is in use this frame, so it is asked again', async () => {
    const { source, table, cache, streamer } = rig({ pages: 1 });
    beginCacheFrame(cache);
    acquirePage(cache, 'held');

    pumpStreamer(streamer, ['a'], 1);
    source.settle('a', bytes(3));
    await flush();

    expect(streamer.deferred).toBe(1);
    expect(tileState(table, 'a')).toBe(TILE_ABSENT);
    /* Not remembered as missing: the source has it, this frame had nowhere to put it. */
    expect(streamer.missing.has('a')).toBe(false);
    expect(pumpStreamer(streamer, ['a'], 1)).toBe(1);
  });

  it('tells the table about a page the cache took for somebody else', async () => {
    /* A table still pointing at a reused slot hands a frame another tile's bytes. */
    const { source, table, cache, streamer } = rig({ pages: 1 });
    pumpStreamer(streamer, ['a'], 1);
    source.settle('a', bytes(1));
    await flush();
    expect(tileState(table, 'a')).toBe(TILE_RESIDENT);

    beginCacheFrame(cache);
    pumpStreamer(streamer, ['b'], 1);
    source.settle('b', bytes(2));
    await flush();

    expect(tileState(table, 'b')).toBe(TILE_RESIDENT);
    expect(tileState(table, 'a')).toBe(TILE_ABSENT);
    expect(residentCount(table)).toBe(1);
  });
});

describe('the streamer is bounded and never blocks', () => {
  it('sends no more than its budget allows', () => {
    const { source, streamer } = rig({ maxInFlight: 3 });
    expect(pumpStreamer(streamer, ['a', 'b', 'c', 'd', 'e'], 5)).toBe(3);
    expect(streamerInFlight(streamer)).toBe(3);
    expect(source.asked).toEqual(['a', 'b', 'c']);
    expect(pumpStreamer(streamer, ['d'], 1)).toBe(0);
  });

  it('returns while a source is still thinking, and again on the next call', () => {
    /* A streamer that awaited its own fetches would stall the frame that called it, which is the
       failure streaming exists to avoid. The source below never resolves anything. */
    const { source, streamer } = rig({ maxInFlight: 4 });
    expect(pumpStreamer(streamer, ['a', 'b'], 2)).toBe(2);
    expect(pumpStreamer(streamer, ['c', 'd'], 2)).toBe(2);
    expect(source.pendingCount()).toBe(4);
    expect(streamerInFlight(streamer)).toBe(4);
  });

  it('asks for no more of a batch than it was told to', () => {
    const { source, streamer } = rig();
    pumpStreamer(streamer, ['a', 'b', 'c'], 2);
    expect(source.asked).toEqual(['a', 'b']);
    /* And a count past the end of the batch is the batch, not a crash. */
    pumpStreamer(streamer, ['c'], 99);
    expect(source.asked).toEqual(['a', 'b', 'c']);
  });
});
