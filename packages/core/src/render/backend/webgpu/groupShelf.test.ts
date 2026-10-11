import { describe, expect, it } from 'vitest';

import { GroupShelf, SHELF_CAPACITY } from './groupShelf.ts';

const group = (name: string): GPUBindGroup => ({ label: name }) as unknown as GPUBindGroup;

describe('a shelf of bind groups', () => {
  it('FINDS A GROUP AGAIN BY THE FOUR IT WAS BUILT WITH, AND BY NOTHING THAT DIFFERS IN ONE', () => {
    const shelf = new GroupShelf();
    const [a, b, c, d, e] = [{}, {}, {}, {}, {}];
    expect(shelf.find(a, b, c, d)).toBeNull();
    const kept = group('kept');
    shelf.keep(kept, a, b, c, d);
    expect(shelf.find(a, b, c, d)).toBe(kept);
    expect(shelf.find(e, b, c, d)).toBeNull();
    expect(shelf.find(a, e, c, d)).toBeNull();
    expect(shelf.find(a, b, e, d)).toBeNull();
    expect(shelf.find(a, b, c, e)).toBeNull();
    expect(shelf.find(a, b, c, null)).toBeNull();
  });

  it('keeps both of the textures a garment takes turns between, which one group a key could not', () => {
    const shelf = new GroupShelf();
    const [palette, binding, even, odd] = [{}, {}, {}, {}];
    const first = group('even');
    const second = group('odd');
    shelf.keep(first, palette, null, even, binding);
    shelf.keep(second, palette, null, odd, binding);
    expect(shelf.find(palette, null, even, binding)).toBe(first);
    expect(shelf.find(palette, null, odd, binding)).toBe(second);
  });

  it('replaces the oldest once it is full, and keeps the rest', () => {
    const shelf = new GroupShelf();
    const keys = Array.from({ length: SHELF_CAPACITY + 1 }, () => ({}));
    const groups = keys.map((_, at) => group(String(at)));
    keys.forEach((key, at) => shelf.keep(groups[at] as GPUBindGroup, key, null, null, null));
    expect(shelf.find(keys[0] as object, null, null, null), 'the oldest went').toBeNull();
    expect(shelf.find(keys[1] as object, null, null, null)).toBe(groups[1]);
    expect(shelf.find(keys[SHELF_CAPACITY] as object, null, null, null)).toBe(
      groups[SHELF_CAPACITY],
    );
  });
});
