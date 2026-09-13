import { describe, expect, it, vi } from 'vitest';

import { SteamCloudStore } from './cloudStore.ts';
import type { SteamCloud } from './cloudStore.ts';

function stubClient(files: Record<string, string> = {}): { cloud: SteamCloud } {
  return {
    cloud: {
      readFile: vi.fn((name: string) => files[name] ?? ''),
      writeFile: vi.fn((name: string, data: string) => {
        files[name] = data;
        return true;
      }),
      deleteFile: vi.fn((name: string) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete files[name];
        return true;
      }),
      fileExists: vi.fn((name: string) => name in files),
    },
  };
}

describe('SteamCloudStore', () => {
  /*
   * A key is stored as `<key>.txt`, which is what a person sees in Steam's own cloud file list.
   * Asserted rather than assumed, because the mapping is the contract with every save already
   * written by a shipped game.
   */
  it('reads a key that Steam has a file for', () => {
    expect(new SteamCloudStore(stubClient({ 'volume.txt': '0.8' }).cloud).read('volume')).toBe(
      '0.8',
    );
  });

  it('answers null rather than throwing for a key with no file', () => {
    expect(new SteamCloudStore(stubClient().cloud).read('missing')).toBeNull();
  });

  it('reads back its own write', () => {
    const store = new SteamCloudStore(stubClient().cloud);
    store.write('a', '1');
    expect(store.read('a')).toBe('1');
  });

  /*
   * Cloud storage can be off per title or per account, and a player with it disabled must get a
   * working game with local saves rather than a crash on the first preference read. The same
   * degradation `BrowserStore` makes when `localStorage` throws.
   */
  it('degrades to memory when the cloud throws', () => {
    const client = stubClient();
    client.cloud.writeFile = vi.fn(() => {
      throw new Error('cloud disabled');
    });
    const store = new SteamCloudStore(client.cloud);
    store.write('a', '1');
    expect(store.read('a')).toBe('1');
  });

  it('forgets a removed key on both sides', () => {
    const files: Record<string, string> = { 'a.txt': '1' };
    const client = stubClient(files);
    const store = new SteamCloudStore(client.cloud);
    store.remove('a');
    expect(store.read('a')).toBeNull();
    expect(files['a.txt']).toBeUndefined();
  });

  /* A key is a file name on somebody's disk, so the characters a path cannot carry are refused. */
  it('does not let a key escape into a path', () => {
    const files: Record<string, string> = {};
    const store = new SteamCloudStore(stubClient(files).cloud);
    store.write('../../etc/passwd', 'x');
    expect(Object.keys(files).every((name) => !name.includes('..'))).toBe(true);
    expect(store.read('../../etc/passwd')).toBe('x');
  });
});
