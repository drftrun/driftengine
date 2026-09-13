import { afterEach, expect, test, vi } from 'vitest';
import { BrowserStore, MemoryStore } from './storage.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a browser that refuses storage still reads back what was written', () => {
  /*
   * The whole point of the abstraction. Safari private mode and several
   * embedded webviews throw on plain `localStorage` access, and that is a
   * normal condition rather than an error — the game must keep running, and
   * settings changed in a menu must still take effect for the rest of the
   * session instead of vanishing between screens.
   */
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  });

  const store = new BrowserStore();
  expect(() => store.write('k', 'v')).not.toThrow();
  expect(store.read('k')).toBe('v');
  expect(() => store.remove('k')).not.toThrow();
  expect(store.read('k')).toBe(null);
});

test('a store that reads but cannot write is treated as unavailable', () => {
  // The nastiest variant: probing with a read reports a healthy store, then
  // every write is silently lost and nothing a player changes ever sticks.
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: (k: string) => void backing.delete(k),
  });

  const store = new BrowserStore();
  store.write('k', 'v');
  expect(store.read('k')).toBe('v');
});

test('an asynchronous backend can hydrate a memory store before boot reads it', () => {
  // How a server-backed or IndexedDB save fits a synchronous boot: fetch first,
  // hydrate, then construct everything that reads.
  const store = new MemoryStore();
  store.hydrate([['game.settings', '{"musicVolume":0.5}']]);
  expect(store.read('game.settings')).toBe('{"musicVolume":0.5}');
});
