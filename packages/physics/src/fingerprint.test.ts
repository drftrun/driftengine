import { describe, expect, test } from 'vitest';
import { aabbFromCenter } from './collide/index.ts';
import { ColliderSet, boxCollider } from './colliderSet.ts';
import { fingerprintColliders } from './fingerprint.ts';

function set(boxes: readonly (readonly [number, number, number])[]): ColliderSet {
  return new ColliderSet(boxes.map(([x, y, z]) => boxCollider(x, y, z, 1, 1, 1)));
}

describe('fingerprintColliders', () => {
  test('is a 16-character hex string', () => {
    expect(fingerprintColliders(set([[0, 0, 0]]))).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the same colliders give the same fingerprint', () => {
    const a = set([
      [0, 0, 0],
      [4, 1, 2],
    ]);
    const b = set([
      [0, 0, 0],
      [4, 1, 2],
    ]);
    expect(fingerprintColliders(a)).toBe(fingerprintColliders(b));
  });

  test('a moved collider gives a different fingerprint', () => {
    const a = set([
      [0, 0, 0],
      [4, 1, 2],
    ]);
    const b = set([
      [0, 0, 0],
      [4, 1, 2.5],
    ]);
    expect(fingerprintColliders(a)).not.toBe(fingerprintColliders(b));
  });

  test('a sub-millimetre move is still a different world', () => {
    // The tolerance question is not this function's to answer. A caller deciding
    // that 0.4 mm does not matter can say so; a hash that quietly agreed would
    // have taken that decision away from every caller at once.
    const a = set([[0, 0, 0]]);
    const b = set([[0, 0, 0.0004]]);
    expect(fingerprintColliders(a)).not.toBe(fingerprintColliders(b));
  });

  test('an extra collider gives a different fingerprint', () => {
    const a = set([[0, 0, 0]]);
    const b = set([
      [0, 0, 0],
      [9, 9, 9],
    ]);
    expect(fingerprintColliders(a)).not.toBe(fingerprintColliders(b));
  });

  test('an empty set has a fingerprint rather than throwing', () => {
    expect(fingerprintColliders(set([]))).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the count is mixed in, so padding cannot forge a match', () => {
    // Two sets whose float payloads could coincide must still differ by count.
    const a = set([[0, 0, 0]]);
    const b = set([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(fingerprintColliders(a)).not.toBe(fingerprintColliders(b));
  });

  test('both halves of the hash carry information', () => {
    // A high half that merely copied the low one would halve the space without
    // any test noticing, because every assertion above passes on 32 bits.
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(fingerprintColliders(set([[i, 0, 0]])).slice(0, 8));
    expect(seen.size).toBeGreaterThan(32);
  });
});

describe('the hash across a set that can change', () => {
  /*
   * **The golden strings, and they are literals on purpose.** A test that derived the expected
   * value would pass through exactly the change it exists to catch. Changing either of these
   * invalidates every recording ever made against this engine: a recording is only replayable
   * against the world it was recorded in, and this is how a caller compares the two.
   *
   * Both were taken from the implementation that hashed the whole of `data` before this function
   * learned about liveness.
   */
  test('a constructor-built set hashes to the string it has always hashed to', () => {
    const built = new ColliderSet([
      aabbFromCenter(0, 0, 0, 1, 2, 3),
      aabbFromCenter(10, -4, 7, 0.5, 0.5, 0.5),
    ]);
    expect(fingerprintColliders(built)).toBe('8e0eb495365aade7');
  });

  /*
   * **The sparse case, which is the one the liveness rule had to be written around.** The
   * constructor skips an `undefined` entry without inserting it into any cell, and counts the slot
   * anyway — so it is live with zero bounds and its twenty-four zero bytes are part of the stream.
   * Calling those slots dead would have been tidier and would have changed this string.
   */
  test('a set built from a sparse array hashes its empty slots, as it always did', () => {
    const built = new ColliderSet([
      aabbFromCenter(0, 0, 0, 1, 2, 3),
      undefined as unknown as ReturnType<typeof aabbFromCenter>,
      aabbFromCenter(10, -4, 7, 0.5, 0.5, 0.5),
    ]);
    expect(fingerprintColliders(built)).toBe('bd35a17d13fda9a6');
  });

  /* Spare capacity is not geometry. A grown set must not hash the slots it has not handed out. */
  test('a grown set hashes its live slots and not its spare capacity', () => {
    const dense = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 2, 3)]);
    const grown = new ColliderSet([]);
    grown.add([aabbFromCenter(0, 0, 0, 1, 2, 3)]);
    const gone = grown.add([aabbFromCenter(9, 9, 9, 1, 1, 1)]);
    grown.remove(gone);
    expect(grown.count).toBe(1);
    expect(fingerprintColliders(grown)).toBe(fingerprintColliders(dense));
  });

  /* The count is hashed first so two sets whose float payloads coincide still differ, and it has
     to be the live count now that a set can hold slots it does not use. */
  test('two sets with the same geometry and different histories still agree', () => {
    const a = new ColliderSet([]);
    a.add([aabbFromCenter(0, 0, 0, 1, 1, 1), aabbFromCenter(5, 0, 0, 1, 1, 1)]);
    const b = new ColliderSet([]);
    b.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
    b.add([aabbFromCenter(5, 0, 0, 1, 1, 1)]);
    expect(fingerprintColliders(a)).toBe(fingerprintColliders(b));
  });
});
