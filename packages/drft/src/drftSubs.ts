/**
 * `SUBS` — which substance each material is made of. Container 1.8.
 *
 * **`§16`'s second mechanism, and the whole point of it is that there is no code in between**: the
 * baker reads `extras.substance` off a glTF material, this writes it, a consumer reads it back and
 * hands the ids to `installChemistry().match`. An artist labels the oak in Blender and the log
 * burns like oak in the game.
 *
 * **Additive, so it is free.** `FORMAT.md` rule 2: an optional chunk a reader does not know is
 * skipped in silence, so a 1.7 reader opens a 1.8 file as the geometry it also holds. A game with
 * no chemistry in it pays nothing for a file that carries labels.
 *
 * **One chunk for the whole file rather than one per material.** The chunk table's `index` is the
 * ordinal *within a FourCC*, which `MORP` already found the hard way — a file where only the fourth
 * material is labelled would carry a chunk at index 0, and a reader pairing by it would set the
 * wrong material on fire. Carrying the ordinal per entry makes the pairing explicit and makes one
 * chunk enough.
 */
import { DrftError, align } from './drftFormat.ts';

export interface DrftSubstanceEntry {
  /** The material ordinal this labels, as `MATL` numbers them. */
  readonly material: number;
  /** The substance id, matched **exactly** — see `installChemistry`, which never guesses. */
  readonly substance: string;
}

export interface DrftSubs {
  readonly entries: readonly DrftSubstanceEntry[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `u32` count, then per entry: `u32` material, `u32` name bytes, then the UTF-8 name.
 *
 * Byte length rather than character count, because a name is text and text is not one byte a
 * character — `chêne` is five characters and six bytes, and a reader counting characters would
 * walk off the end of one entry into the next.
 */
export function buildSubs(subs: DrftSubs): Uint8Array {
  const names = subs.entries.map((entry) => encoder.encode(entry.substance));
  let size = 4;
  for (const name of names) size += 8 + name.byteLength;

  const bytes = new Uint8Array(align(size));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, subs.entries.length, true);
  let at = 4;
  for (let i = 0; i < subs.entries.length; i++) {
    const name = names[i] as Uint8Array;
    view.setUint32(at, (subs.entries[i] as DrftSubstanceEntry).material, true);
    view.setUint32(at + 4, name.byteLength, true);
    bytes.set(name, at + 8);
    at += 8 + name.byteLength;
  }
  return bytes;
}

export function readSubs(buffer: ArrayBuffer, offset: number, byteLength: number): DrftSubs {
  if (byteLength < 4) throw new DrftError('SUBS is too short to hold its count');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);

  const entries: DrftSubstanceEntry[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 8 > byteLength) {
      throw new DrftError(`SUBS declares ${count} entries and ends inside entry ${i}`);
    }
    const material = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    if (at + 8 + length > byteLength) {
      throw new DrftError(
        `SUBS entry ${i} names ${length} bytes and the chunk has ${byteLength - at - 8} left`,
      );
    }
    entries.push({
      material,
      substance: decoder.decode(new Uint8Array(buffer, offset + at + 8, length)),
    });
    at += 8 + length;
  }
  return { entries };
}
