/**
 * Prediction changes what is in memory and nothing about what happened.
 *
 * **The whole mechanism rests on putting the simulation back exactly.** Advancing the world to see
 * where it is going and then failing to restore it would make the world run at double speed only
 * when streaming is enabled — a defect that appears in a build with prefetching on, vanishes in the
 * build somebody debugs it in, and looks like anything but a texture problem.
 *
 * So: a fixed session run twice, once with prediction and once without, and the fingerprint is
 * identical. **With overlay writes**, because they are the only part of this wave that touches
 * state at all, and the journal is what keeps them honest — a mark made during a *predicted* frame
 * that leaked into the real overlay would be a divergence with no other symptom.
 */
import { describe, expect, it } from 'vitest';
import { createOverlay, overlayTiles, writeOverlay, type Overlay } from '../overlay/sparse.ts';
import {
  applyOverlayJournal,
  createOverlayJournal,
  emptyLike,
  encodeOverlayJournal,
  decodeOverlayJournal,
  recordOverlayWrite,
  type OverlayJournal,
} from '../overlay/journal.ts';
import { TILE_RESIDENT, createResidencyTable, tileState } from './table.ts';
import { createPrefetchQueue, enqueue, takeBatch } from './queue.ts';
import { beginCacheFrame, createPageCache } from './pageCache.ts';
import { createStreamer, pumpStreamer, type TileSource } from './stream.ts';
import { runPrediction, type Predictor } from './predictor.ts';
import type { SimulationHandle } from './predict.ts';

const TILE = 4;
const REACH = 1;
const TEXEL = 1 / 32;

interface World {
  frame: number;
  x: number;
  /** Something the simulation accumulates, so a frame run twice is visible in the digest. */
  heat: number;
}

/** The one step. Deterministic and cheap, and the only thing that may change the world. */
function step(world: World): void {
  world.frame += 1;
  world.x += TILE;
  world.heat = (world.heat * 31 + world.frame) % 1000003;
}

function tilesAt(x: number, out: string[]): number {
  out.length = 0;
  const cx = Math.floor(x / TILE);
  for (let dx = -REACH; dx <= REACH; dx += 1) out.push(`t${String(cx + dx)}`);
  return out.length;
}

/** Where a frame's mark goes. A function of the world, so two runs make the same mark. */
function markFor(world: World): { u: number; v: number; channel: number; value: number } {
  return {
    u: ((world.frame * 7) % 32) / 32 + TEXEL * 0.5,
    v: ((world.frame * 11) % 32) / 32 + TEXEL * 0.5,
    channel: world.frame % 4,
    value: (world.heat % 1000) / 1000,
  };
}

interface Session {
  world: World;
  overlay: Overlay;
  journal: OverlayJournal;
  digest: string;
}

/**
 * Run `frames` of a session, with prediction on or off, and report what happened.
 *
 * The digest covers the simulation *and* the overlay, because either one drifting is the failure
 * this file exists to catch and only one of them is obvious.
 */
async function run(frames: number, options: { predict: boolean }): Promise<Session> {
  const world: World = { frame: 0, x: 0, heat: 1 };
  const overlay = createOverlay(8, { tilesAcross: 4 });
  const journal = createOverlayJournal(8);

  const table = createResidencyTable(1024);
  const cache = createPageCache(16, 4);
  const queue = createPrefetchQueue(128);

  let now = 0;
  const due: { at: number; settle: (bytes: Uint8Array | null) => void }[] = [];
  const source: TileSource = {
    fetch: (): Promise<Uint8Array | null> =>
      new Promise<Uint8Array | null>((resolve) => {
        due.push({ at: now + 2, settle: resolve });
      }),
  };
  const streamer = createStreamer(source, table, cache, { maxInFlight: 16 });

  let saved: World = { ...world };
  const sim: SimulationHandle = {
    save: (): void => {
      saved = { ...world };
    },
    restore: (): void => {
      world.frame = saved.frame;
      world.x = saved.x;
      world.heat = saved.heat;
    },
    advance: (): void => {
      step(world);
    },
    viewAt: (out: Float32Array): void => {
      out.fill(0);
      out[0] = 1;
      out[5] = 1;
      out[10] = 1;
      out[15] = 1;
      out[12] = -world.x;
    },
  };

  const predictor: Predictor<string> = {
    needs: (view: Float32Array, out: string[]): number => tilesAt(-(view[12] as number), out),
    resident: (hash: string): boolean => tileState(table, hash) === TILE_RESIDENT,
    request: (hash: string, priority: number): void => {
      enqueue(queue, hash, priority);
    },
  };

  const batch: string[] = [];
  const wanted: string[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    now = frame;
    beginCacheFrame(cache);
    for (let at = due.length - 1; at >= 0; at -= 1) {
      const entry = due[at];
      if (entry === undefined || entry.at > now) continue;
      due.splice(at, 1);
      entry.settle(new Uint8Array(4));
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    if (options.predict) {
      runPrediction(sim, predictor, 4, 1, 32);
    } else {
      const count = tilesAt(world.x, wanted);
      for (let at = 0; at < count; at += 1) enqueue(queue, wanted[at] as string, 0);
    }
    pumpStreamer(
      streamer,
      batch,
      takeBatch(queue, (hash) => tileState(table, hash) === TILE_RESIDENT, 64, 4, batch),
    );

    /* The simulation's own step, and the mark this frame makes. Recorded as it happens. */
    step(world);
    const mark = markFor(world);
    writeOverlay(overlay, mark.u, mark.v, TEXEL * 1.2, mark.channel, mark.value);
    recordOverlayWrite(journal, world.frame, mark.u, mark.v, TEXEL * 1.2, mark.channel, mark.value);
  }

  const tiles: string[] = [];
  overlayTiles(overlay, tiles);
  const digest = `${String(world.frame)}/${String(world.x)}/${String(world.heat)}|${tiles.join(',')}`;
  return { world, overlay, journal, digest };
}

describe('prediction leaves the simulation exactly as it found it', () => {
  it('produces the same fingerprint with prediction and without', async () => {
    /*
     * The failure this catches runs the world at double speed only when streaming is on: present
     * in the shipping build, absent in the one somebody debugs it in, and looking like anything at
     * all except a texture problem.
     */
    const predicted = await run(24, { predict: true });
    const plain = await run(24, { predict: false });
    expect(predicted.digest).toBe(plain.digest);
  });

  it('advances the world once a frame, however many frames it looked ahead', async () => {
    const predicted = await run(24, { predict: true });
    expect(predicted.world.frame).toBe(24);
  });

  it('makes the same marks, which is the half nothing else would notice', async () => {
    /* The overlay is the only state this wave writes. A mark made during a *predicted* frame that
       leaked into the real overlay is a divergence with no other symptom. */
    const predicted = await run(24, { predict: true });
    const plain = await run(24, { predict: false });
    const a: string[] = [];
    const b: string[] = [];
    overlayTiles(predicted.overlay, a);
    overlayTiles(plain.overlay, b);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('records the same journal, frame for frame', async () => {
    const predicted = await run(24, { predict: true });
    const plain = await run(24, { predict: false });
    expect([...predicted.journal.frames.slice(0, predicted.journal.count)]).toEqual([
      ...plain.journal.frames.slice(0, plain.journal.count),
    ]);
    expect([...predicted.journal.values.slice(0, predicted.journal.count * 4)]).toEqual([
      ...plain.journal.values.slice(0, plain.journal.count * 4),
    ]);
  });
});

describe('the session replays to the same overlay it produced', () => {
  it('rebuilds from its own journal', async () => {
    const session = await run(24, { predict: true });
    const replayed = emptyLike(session.overlay);
    applyOverlayJournal(replayed, session.journal, session.world.frame);

    const a: string[] = [];
    const b: string[] = [];
    overlayTiles(session.overlay, a);
    overlayTiles(replayed, b);
    expect(b).toEqual(a);
  });

  it('rebuilds from a journal that went through the encoding', async () => {
    /* A recording that reaches somebody else is a recording that was written to bytes first. */
    const session = await run(24, { predict: true });
    const back = decodeOverlayJournal(encodeOverlayJournal(session.journal));
    if (back === null) throw new Error('the journal did not decode');

    const replayed = emptyLike(session.overlay);
    applyOverlayJournal(replayed, back, session.world.frame);
    const a: string[] = [];
    const b: string[] = [];
    overlayTiles(session.overlay, a);
    overlayTiles(replayed, b);
    expect(b).toEqual(a);
  });
});
