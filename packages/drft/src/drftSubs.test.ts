import { describe, expect, it } from 'vitest';
import { DrftError } from './drftFormat.ts';
import { buildSubs, readSubs } from './drftSubs.ts';

describe('SUBS, at container 1.8', () => {
  it('ROUND-TRIPS MATERIAL ORDINALS PAIRED WITH SUBSTANCE IDS', () => {
    /*
     * `§16`'s second mechanism, and the whole point of it: **an artist labels the oak in Blender and
     * the log burns like oak in the game**, with no code in between. The baker reads
     * `extras.substance` off a glTF material and writes this; the consumer reads it back and hands
     * the ids to `installChemistry().match`.
     */
    const bytes = buildSubs({
      entries: [
        { material: 0, substance: 'oak' },
        { material: 3, substance: 'gypsum-board' },
      ],
    });
    const read = readSubs(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    expect(read.entries).toEqual([
      { material: 0, substance: 'oak' },
      { material: 3, substance: 'gypsum-board' },
    ]);
  });

  it('pairs by the MATERIAL ORDINAL rather than by position in the chunk', () => {
    /*
     * The same correction `MORP` records: the chunk table's `index` is the ordinal *within a
     * FourCC*, so a file where only the fourth material is labelled would carry a chunk at index 0
     * and a reader pairing by it would set the wrong material on fire. The ordinal is in the
     * payload, per entry, which also lets one chunk carry every label a file has.
     */
    const bytes = buildSubs({ entries: [{ material: 7, substance: 'pine' }] });
    expect(
      readSubs(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).entries[0]
        ?.material,
    ).toBe(7);
  });

  it('carries an empty set without becoming a special case', () => {
    const bytes = buildSubs({ entries: [] });
    expect(
      readSubs(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).entries,
    ).toEqual([]);
  });

  it('REFUSES A TRUNCATED CHUNK rather than handing back half a name', () => {
    /* A name is length-prefixed, so a payload that ends inside one is a corrupt file and not a file
       with a shorter name in it. `FORMAT.md` rule 3: a chunk this reader claims to understand and
       cannot read is a refusal. */
    const bytes = buildSubs({ entries: [{ material: 0, substance: 'oak' }] });
    const short = bytes.slice(0, 8);
    expect(() => readSubs(short.buffer as ArrayBuffer, short.byteOffset, short.byteLength)).toThrow(
      DrftError,
    );
  });

  it('holds a name with a non-ASCII character, because an id is text', () => {
    const bytes = buildSubs({ entries: [{ material: 1, substance: 'chêne' }] });
    expect(
      readSubs(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).entries[0]
        ?.substance,
    ).toBe('chêne');
  });
});
