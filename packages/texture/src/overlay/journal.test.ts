/**
 * A mark made during play is a mark made again during replay.
 *
 * This is the half of the design that makes runtime-writable textures compatible with everything
 * else in this engine. A write that is not in the journal is a divergence that appears only on
 * replay, which is the worst kind: nothing fails at the time, and the recording is wrong forever.
 */
import { describe, expect, it } from 'vitest';
import { createOverlay, overlayTileCount, writeOverlay, type Overlay } from './sparse.ts';
import {
  JOURNAL_ENTRY_BYTES,
  JOURNAL_MAGIC,
  applyOverlayJournal,
  clearOverlay,
  createOverlayJournal,
  decodeOverlayJournal,
  emptyLike,
  encodeOverlayJournal,
  journalLength,
  recordOverlayWrite,
  rewindOverlay,
  truncateJournalFrom,
  type OverlayJournal,
} from './journal.ts';

function overlay(): Overlay {
  return createOverlay(8, { tilesAcross: 4 });
}

const centre = (texel: number): number => (texel + 0.5) / 32;
const TEXEL = 1 / 32;

/**
 * Every written texel of every tile, as a comparable string.
 *
 * Texel by texel rather than by tile hash: a hash comparison passes for two overlays that differ
 * in a way the hash happens not to see, and this is the one comparison in the package that has to
 * be exact.
 */
function dump(o: Overlay): string {
  const keys = [...o.tiles.keys()].sort();
  return keys
    .map((key) => {
      const tile = o.tiles.get(key);
      if (tile === undefined) return key;
      const written = [...tile.written].join('');
      const texels = [...tile.texels].map((value) => value.toFixed(6)).join(',');
      return `${key}|${written}|${texels}`;
    })
    .join('\n');
}

/** A session: marks on known frames, applied to a live overlay and recorded as they happen. */
function played(): { live: Overlay; journal: OverlayJournal; marks: number } {
  const live = overlay();
  const journal = createOverlayJournal(4);
  const marks: [number, number, number, number, number, number][] = [
    [1, centre(2), centre(2), TEXEL * 1.2, 0, 0.25],
    [3, centre(18), centre(4), TEXEL * 2, 1, 0.5],
    [3, centre(2), centre(2), TEXEL * 0.4, 0, 0.75],
    [7, centre(20), centre(20), TEXEL * 1.5, 3, 1],
    [9, centre(2), centre(3), TEXEL * 0.4, 2, 0.125],
  ];
  for (const [frame, u, v, radius, channel, value] of marks) {
    writeOverlay(live, u, v, radius, channel, value);
    recordOverlayWrite(journal, frame, u, v, radius, channel, value);
  }
  return { live, journal, marks: marks.length };
}

describe('a replay reproduces the marks exactly', () => {
  it('rebuilds the whole session texel by texel', () => {
    const { live, journal } = played();
    const replayed = emptyLike(live);
    expect(applyOverlayJournal(replayed, journal, 9)).toBe(journalLength(journal));
    expect(dump(replayed)).toBe(dump(live));
    expect(overlayTileCount(replayed)).toBe(overlayTileCount(live));
  });

  it('leaves a fresh overlay clean for an empty journal', () => {
    const o = overlay();
    expect(applyOverlayJournal(o, createOverlayJournal(), 100)).toBe(0);
    expect(overlayTileCount(o)).toBe(0);
    expect(dump(o)).toBe('');
  });

  it('is exact rather than nearly exact, because the journal holds what it will write', () => {
    /*
     * A journal of `f64` written out as `f32` reproduces a *nearly* identical mark, and "nearly" in
     * a replay is a divergence at the worst moment: a fingerprint that stops matching a recording
     * for a reason nobody would look for in a texture.
     */
    const live = overlay();
    const journal = createOverlayJournal(1);
    const u = 1 / 3;
    writeOverlay(live, u, u, TEXEL * 1.2, 0, 1 / 3);
    recordOverlayWrite(journal, 0, u, u, TEXEL * 1.2, 0, 1 / 3);

    const replayed = emptyLike(live);
    applyOverlayJournal(replayed, journal, 0);
    expect(dump(replayed)).toBe(dump(live));
  });
});

describe('applying up to a frame stops at that frame', () => {
  it('reproduces frame n and not frame n plus one', () => {
    const { live, journal } = played();

    /* Up to frame 3: the first three marks and not the two after them. */
    const at3 = emptyLike(live);
    expect(applyOverlayJournal(at3, journal, 3)).toBe(3);

    const expected = emptyLike(live);
    writeOverlay(expected, centre(2), centre(2), TEXEL * 1.2, 0, 0.25);
    writeOverlay(expected, centre(18), centre(4), TEXEL * 2, 1, 0.5);
    writeOverlay(expected, centre(2), centre(2), TEXEL * 0.4, 0, 0.75);
    expect(dump(at3)).toBe(dump(expected));

    /* And it is not the whole session, which is the half that a boundary error passes. */
    expect(dump(at3)).not.toBe(dump(live));
  });

  it('includes everything on the frame asked for, not everything before it', () => {
    const { live, journal } = played();
    const inclusive = emptyLike(live);
    const exclusive = emptyLike(live);
    applyOverlayJournal(inclusive, journal, 3);
    applyOverlayJournal(exclusive, journal, 2);
    expect(dump(inclusive)).not.toBe(dump(exclusive));
  });

  it('applies nothing for a frame before the first mark', () => {
    const { live, journal } = played();
    const before = emptyLike(live);
    expect(applyOverlayJournal(before, journal, 0)).toBe(0);
    expect(overlayTileCount(before)).toBe(0);
  });
});

describe('a rollback un-draws what the rolled-back frames drew', () => {
  it('rebuilds rather than undoes, because a write is not invertible', () => {
    /* Two marks on one texel leave no record of what was underneath, so undoing would need a
       history per texel — the dense layer the whole design exists to avoid. */
    const { live, journal } = played();
    const at3 = emptyLike(live);
    applyOverlayJournal(at3, journal, 3);

    expect(rewindOverlay(live, journal, 3)).toBe(3);
    expect(dump(live)).toBe(dump(at3));
  });

  it('survives the netcode: roll back, re-simulate, and the overlay is the same', () => {
    /*
     * The case that proves the mechanism. The session runs to frame 9, rolls back to 3, and the
     * frames after it are simulated again — producing the same writes, because the simulation is
     * deterministic. The journal is truncated first, or the replay draws both what happened and
     * what was undone.
     */
    const { live, journal } = played();
    const straightThrough = dump(live);

    expect(truncateJournalFrom(journal, 4)).toBe(2);
    expect(journalLength(journal)).toBe(3);
    rewindOverlay(live, journal, 3);

    /* Re-simulated: the same marks on the same frames, recorded as they happen. */
    writeOverlay(live, centre(20), centre(20), TEXEL * 1.5, 3, 1);
    recordOverlayWrite(journal, 7, centre(20), centre(20), TEXEL * 1.5, 3, 1);
    writeOverlay(live, centre(2), centre(3), TEXEL * 0.4, 2, 0.125);
    recordOverlayWrite(journal, 9, centre(2), centre(3), TEXEL * 0.4, 2, 0.125);

    expect(dump(live)).toBe(straightThrough);
    /* And a replay of the re-simulated journal from nothing reaches the same place. */
    const replayed = emptyLike(live);
    applyOverlayJournal(replayed, journal, 9);
    expect(dump(replayed)).toBe(straightThrough);
  });

  it('draws a mark twice when the journal was not truncated, which is the bug', () => {
    /* Pinned rather than assumed: the failure is invisible unless the re-simulation writes
       something different from what it wrote the first time. */
    const { live, journal } = played();
    rewindOverlay(live, journal, 3);
    /* A different frame 7 this time, and the old one still in the log. */
    recordOverlayWrite(journal, 7, centre(20), centre(20), TEXEL * 1.5, 3, 0.2);

    const replayed = emptyLike(live);
    applyOverlayJournal(replayed, journal, 9);
    /* Both entries applied, and the second wins — a value nobody in the re-simulation wrote. */
    expect(journalLength(journal)).toBe(6);
    expect(dump(replayed)).not.toBe(dump(live));
  });

  it('drops the frame it was told to truncate from, not just the ones after it', () => {
    /* Marks sit on frames 1, 3, 3, 7 and 9, so truncating from 7 has to take the mark *on* 7 —
       a boundary every other test here happens to step over, because none of them names a frame
       that carries an entry. */
    const { journal } = played();
    expect(truncateJournalFrom(journal, 7)).toBe(2);
    expect([...journal.frames.slice(0, journal.count)]).toEqual([1, 3, 3]);
  });

  it('clears an overlay without touching its shape', () => {
    const { live } = played();
    expect(overlayTileCount(live)).toBeGreaterThan(0);
    clearOverlay(live);
    expect(overlayTileCount(live)).toBe(0);
    expect(live.resolution).toBe(32);
    /* Still writable afterwards, which a cleared-and-broken overlay would not be. */
    writeOverlay(live, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    expect(overlayTileCount(live)).toBe(1);
  });

  it('keeps an overlay like the one it came from', () => {
    const like = createOverlay(16, { tilesAcross: 8, addressMode: 1 });
    const fresh = emptyLike(like);
    expect([fresh.tileSize, fresh.tilesAcross, fresh.addressMode]).toEqual([16, 8, 1]);
    expect(overlayTileCount(fresh)).toBe(0);
  });
});

describe('the encoding round-trips', () => {
  it('reads back what it wrote, entry for entry', () => {
    const { journal } = played();
    const bytes = encodeOverlayJournal(journal);
    expect(bytes.byteLength).toBe(12 + journalLength(journal) * JOURNAL_ENTRY_BYTES);

    const back = decodeOverlayJournal(bytes);
    if (back === null) throw new Error('the journal did not decode');
    expect(journalLength(back)).toBe(journalLength(journal));
    expect([...back.frames.slice(0, back.count)]).toEqual([
      ...journal.frames.slice(0, journal.count),
    ]);
    expect([...back.channels.slice(0, back.count)]).toEqual([
      ...journal.channels.slice(0, journal.count),
    ]);
    expect([...back.values.slice(0, back.count * 4)]).toEqual([
      ...journal.values.slice(0, journal.count * 4),
    ]);
  });

  it('replays to the same overlay after a round trip', () => {
    const { live, journal } = played();
    const back = decodeOverlayJournal(encodeOverlayJournal(journal));
    if (back === null) throw new Error('the journal did not decode');
    const replayed = emptyLike(live);
    applyOverlayJournal(replayed, back, 9);
    expect(dump(replayed)).toBe(dump(live));
  });

  it('round-trips an empty journal', () => {
    const bytes = encodeOverlayJournal(createOverlayJournal());
    expect(bytes.byteLength).toBe(12);
    const back = decodeOverlayJournal(bytes);
    expect(back?.count).toBe(0);
  });

  it('refuses bytes that are not a journal rather than reading half of one', () => {
    /* A replay against half a log diverges partway through for no visible reason, which is worse
       than one that refuses to start. */
    /* Shorter than the header: without a length check this reads past the buffer and throws,
       which `toBeNull` would not survive. */
    expect(decodeOverlayJournal(new Uint8Array(2))).toBeNull();
    expect(decodeOverlayJournal(new Uint8Array(4))).toBeNull();
    expect(decodeOverlayJournal(new Uint8Array(12))).toBeNull();

    /* A journal in every respect except the magic — the only input that tests the magic, because
       everything else that is not a journal fails the version or the length first. */
    const notOurs = encodeOverlayJournal(played().journal);
    new DataView(notOurs.buffer).setUint32(0, JOURNAL_MAGIC + 1, true);
    expect(decodeOverlayJournal(notOurs)).toBeNull();

    const bytes = encodeOverlayJournal(played().journal);
    expect(decodeOverlayJournal(bytes.slice(0, bytes.byteLength - 1))).toBeNull();

    const wrongVersion = encodeOverlayJournal(played().journal);
    new DataView(wrongVersion.buffer).setUint32(4, 99, true);
    expect(decodeOverlayJournal(wrongVersion)).toBeNull();

    const magic = new Uint8Array(12);
    new DataView(magic.buffer).setUint32(0, JOURNAL_MAGIC, true);
    expect(decodeOverlayJournal(magic)).toBeNull();
  });
});

describe('the journal grows without losing anything', () => {
  it('keeps every entry past its initial capacity', () => {
    const journal = createOverlayJournal(2);
    for (let at = 0; at < 100; at += 1) {
      recordOverlayWrite(journal, at, at / 100, 0.5, TEXEL, at % 4, at / 100);
    }
    expect(journalLength(journal)).toBe(100);
    expect(journal.frames[99]).toBe(99);
    expect(journal.channels[99]).toBe(3);
    expect(journal.values[99 * 4]).toBeCloseTo(0.99, 6);
  });
});
