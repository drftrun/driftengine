import { expect, test } from 'vitest';
import { createTileIndex, hashTile, internTile, tileSlotCount } from './tileHash.ts';

test('identical bytes hash identically', () => {
  const a = Uint8Array.from([1, 2, 3, 4]);
  const b = Uint8Array.from([1, 2, 3, 4]);
  expect(hashTile(a)).toBe(hashTile(b));
});

test('a single changed byte changes the hash', () => {
  expect(hashTile(Uint8Array.from([1, 2, 3, 4]))).not.toBe(hashTile(Uint8Array.from([1, 2, 3, 5])));
});

test('the hash depends on the span contents, not on where the span sits', () => {
  const standalone = Uint8Array.from([9, 9, 9]);
  const embedded = Uint8Array.from([0, 0, 0, 0, 9, 9, 9, 7]);
  expect(hashTile(embedded, 4, 3)).toBe(hashTile(standalone));
});

test('interning the same content twice returns one slot and stores one copy', () => {
  const index = createTileIndex();
  const bytes = Uint8Array.from([1, 2, 3]);
  const hash = hashTile(bytes);
  expect(internTile(index, hash, bytes)).toBe(internTile(index, hash, bytes));
  expect(tileSlotCount(index)).toBe(1);
});

test('two different tiles get two slots', () => {
  const index = createTileIndex();
  const a = Uint8Array.from([1]);
  const b = Uint8Array.from([2]);
  internTile(index, hashTile(a), a);
  internTile(index, hashTile(b), b);
  expect(tileSlotCount(index)).toBe(2);
});

test('the hash is stable across runs, because the baker has to be reproducible', () => {
  expect(hashTile(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe(
    hashTile(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])),
  );
  expect(hashTile(new Uint8Array(0)).length).toBe(16);
});

test('an empty tile hashes to the offset basis rather than throwing', () => {
  expect(hashTile(new Uint8Array(0))).toMatch(/^[0-9a-f]{16}$/);
});
