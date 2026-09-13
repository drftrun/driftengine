import { describe, expect, it } from 'vitest';

import { MemoryStore } from '../../packages/core/src/index';

import { autosave, decodeSave, encodeSave, restore, type SaveData } from './saveLoad';

const SAVE: SaveData = {
  v: 1,
  seed: 1337,
  time: 0.25,
  player: { x: 1.5, y: 64, z: -2.5, yaw: 0.75, pitch: -0.25 },
  edits: [1, 2, 3, 4],
};

describe('a saved world', () => {
  it('round-trips every field', () => {
    expect(decodeSave(encodeSave(SAVE))).toEqual(SAVE);
  });

  it('refuses bytes that are not a save', () => {
    /* Every caller is a click handler or a page load, and neither has anywhere to put an
       exception. A foreign file has to come back as null. */
    expect(decodeSave(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('refuses a version it does not know', () => {
    expect(decodeSave(encodeSave({ ...SAVE, v: 99 as 1 }))).toBeNull();
  });

  it('refuses a save missing a field rather than reading undefined back', () => {
    const partial = new TextEncoder().encode(JSON.stringify({ v: 1, seed: 1, time: 0 }));
    expect(decodeSave(partial)).toBeNull();
  });

  it('round-trips through a key-value store', () => {
    const store = new MemoryStore();
    autosave(store, SAVE);
    expect(restore(store)).toEqual(SAVE);
  });

  it('returns null from an empty store rather than throwing', () => {
    expect(restore(new MemoryStore())).toBeNull();
  });
});
