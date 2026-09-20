/**
 * A scorch mark is in the input log, so a replay burns the same wall.
 *
 * **Runtime-mutable textures normally break replay.** The marks are not part of the simulation and
 * nothing records them, so a recording plays back a world where the walls are clean — and the
 * failure has the worst possible shape: nothing goes wrong at the time, everything looks right, and
 * the recording is wrong forever. Anybody who later debugs from it is debugging a session that did
 * not happen.
 *
 * Here a write is recorded in the same log the input goes into, so replaying a session reproduces
 * the exact mark in the exact place — and the same mechanism means a rollback un-draws what the
 * rolled-back frames drew, because rolling back an overlay *is* rebuilding it from the journal up
 * to the frame you rolled back to. An overlay cannot be snapshotted the way the world is: it is
 * sparse and unbounded, and a snapshot per frame of something that grows is the cost the sparseness
 * was for.
 *
 * **Applying does not clear, and rewinding does.** A replay that always cleared could not be used
 * to catch up frame by frame, which is what a live session does. `rewindOverlay` is the one that
 * puts the world back, and it says so in its name.
 *
 * **The journal is truncated on rollback, and forgetting that is the bug.** Re-simulating after a
 * rollback records its writes again; the frames that did not happen must not still be in the log,
 * or a replay from the start draws both the mark that happened and the one that was undone.
 */
import { createOverlay, writeOverlay, type Overlay } from './sparse.ts';

/** Bytes an entry takes on the wire: two `u32` and four `f32`. */
export const JOURNAL_ENTRY_BYTES = 24;
/** `"DOVJ"`, little-endian, as every other record in this package spells its magic. */
export const JOURNAL_MAGIC = 0x4a564f44;
export const JOURNAL_VERSION = 1;

export interface OverlayJournal {
  /** One frame number an entry. */
  frames: Int32Array;
  /** One channel index an entry. */
  channels: Int32Array;
  /** Four values an entry: u, v, radius, value. */
  values: Float32Array;
  count: number;
}

export function createOverlayJournal(capacity = 256): OverlayJournal {
  const size = Math.max(1, Math.floor(capacity));
  return {
    frames: new Int32Array(size),
    channels: new Int32Array(size),
    values: new Float32Array(size * 4),
    count: 0,
  };
}

function grow(journal: OverlayJournal): void {
  if (journal.count < journal.frames.length) return;
  const size = journal.frames.length * 2;
  const frames = new Int32Array(size);
  const channels = new Int32Array(size);
  const values = new Float32Array(size * 4);
  frames.set(journal.frames);
  channels.set(journal.channels);
  values.set(journal.values);
  journal.frames = frames;
  journal.channels = channels;
  journal.values = values;
}

/**
 * Record a write. Stored as `f32`, which is what makes the encoding round-trip exactly.
 *
 * A journal of `f64` written out as `f32` reproduces a *nearly* identical mark, and "nearly" in a
 * replay is a divergence that appears at the worst moment — the fingerprint that no longer matches
 * a recording, for a reason nobody would look for in a texture.
 */
export function recordOverlayWrite(
  journal: OverlayJournal,
  frame: number,
  u: number,
  v: number,
  radius: number,
  channel: number,
  value: number,
): void {
  grow(journal);
  const at = journal.count;
  journal.frames[at] = frame;
  journal.channels[at] = channel;
  journal.values[at * 4] = u;
  journal.values[at * 4 + 1] = v;
  journal.values[at * 4 + 2] = radius;
  journal.values[at * 4 + 3] = value;
  journal.count += 1;
}

export function journalLength(journal: OverlayJournal): number {
  return journal.count;
}

/**
 * Forget every entry from `frame` onward. What a rollback owes the journal.
 *
 * Entries are recorded in frame order, so this is a truncation rather than a filter — and where
 * they are not, the scan below still removes exactly the right ones.
 */
export function truncateJournalFrom(journal: OverlayJournal, frame: number): number {
  let kept = 0;
  for (let at = 0; at < journal.count; at += 1) {
    if ((journal.frames[at] as number) >= frame) continue;
    if (kept !== at) {
      journal.frames[kept] = journal.frames[at] as number;
      journal.channels[kept] = journal.channels[at] as number;
      for (let c = 0; c < 4; c += 1) {
        journal.values[kept * 4 + c] = journal.values[at * 4 + c] as number;
      }
    }
    kept += 1;
  }
  const dropped = journal.count - kept;
  journal.count = kept;
  return dropped;
}

/** Apply every entry up to and including `upToFrame`, onto whatever the overlay already holds. */
export function applyOverlayJournal(
  overlay: Overlay,
  journal: OverlayJournal,
  upToFrame: number,
): number {
  let applied = 0;
  for (let at = 0; at < journal.count; at += 1) {
    if ((journal.frames[at] as number) > upToFrame) continue;
    writeOverlay(
      overlay,
      journal.values[at * 4] as number,
      journal.values[at * 4 + 1] as number,
      journal.values[at * 4 + 2] as number,
      journal.channels[at] as number,
      journal.values[at * 4 + 3] as number,
    );
    applied += 1;
  }
  return applied;
}

/** Throw away every written tile. The overlay keeps its shape and holds nothing. */
export function clearOverlay(overlay: Overlay): void {
  overlay.tiles.clear();
}

/**
 * Put the overlay back to how it was at `upToFrame`: clear, then replay.
 *
 * Rebuilt rather than undone, because a write is not invertible — two marks on one texel leave no
 * record of what was underneath, and an overlay that tried to undo would need a history per texel,
 * which is the dense layer the whole design exists to avoid.
 */
export function rewindOverlay(
  overlay: Overlay,
  journal: OverlayJournal,
  upToFrame: number,
): number {
  clearOverlay(overlay);
  return applyOverlayJournal(overlay, journal, upToFrame);
}

/** An overlay with the same shape as `like` and nothing written. What a replay starts from. */
export function emptyLike(like: Overlay): Overlay {
  return createOverlay(like.tileSize, {
    tilesAcross: like.tilesAcross,
    addressMode: like.addressMode,
  });
}

export function encodeOverlayJournal(journal: OverlayJournal): Uint8Array {
  const bytes = new Uint8Array(12 + journal.count * JOURNAL_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, JOURNAL_MAGIC, true);
  view.setUint32(4, JOURNAL_VERSION, true);
  view.setUint32(8, journal.count, true);
  for (let at = 0; at < journal.count; at += 1) {
    const base = 12 + at * JOURNAL_ENTRY_BYTES;
    view.setInt32(base, journal.frames[at] as number, true);
    view.setInt32(base + 4, journal.channels[at] as number, true);
    for (let c = 0; c < 4; c += 1) {
      view.setFloat32(base + 8 + c * 4, journal.values[at * 4 + c] as number, true);
    }
  }
  return bytes;
}

/**
 * Read a journal back. Null where the bytes are not one.
 *
 * Null rather than a partial journal: a replay against half a log is a session that diverges partway
 * through for no visible reason, which is worse than one that refuses to start.
 */
export function decodeOverlayJournal(bytes: Uint8Array): OverlayJournal | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== JOURNAL_MAGIC) return null;
  if (view.getUint32(4, true) !== JOURNAL_VERSION) return null;
  const count = view.getUint32(8, true);
  if (bytes.byteLength !== 12 + count * JOURNAL_ENTRY_BYTES) return null;

  const journal = createOverlayJournal(Math.max(1, count));
  for (let at = 0; at < count; at += 1) {
    const base = 12 + at * JOURNAL_ENTRY_BYTES;
    recordOverlayWrite(
      journal,
      view.getInt32(base, true),
      view.getFloat32(base + 8, true),
      view.getFloat32(base + 12, true),
      view.getFloat32(base + 16, true),
      view.getInt32(base + 4, true),
      view.getFloat32(base + 20, true),
    );
  }
  return journal;
}
