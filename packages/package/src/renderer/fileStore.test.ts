import { describe, expect, it, vi } from 'vitest';

import type { DriftHostBridge } from '../preload/bridge.ts';
import { FileStore } from './fileStore.ts';

function stubBridge(snapshot: Record<string, string> = {}): DriftHostBridge {
  return {
    storeSnapshot: snapshot,
    writeKey: vi.fn(),
    removeKey: vi.fn(),
    setFullscreen: vi.fn(async () => undefined),
    isFullscreen: () => false,
    refreshHz: () => 144,
    mode: () => 'windowed' as const,
    setMode: vi.fn(async () => true),
    size: () => ({ width: 1280, height: 720 }),
    setSize: vi.fn(async () => true),
    canSetSize: () => false,
    displays: () => [],
    onFocusChange: () => () => undefined,
    onQuitRequest: () => () => undefined,
    canQuit: true,
    platform: { available: false, unlockAchievement: vi.fn(), setRichPresence: vi.fn() },
    requestQuit: vi.fn(),
    openFile: vi.fn(async () => null),
    saveFile: vi.fn(async () => true),
  };
}

describe('FileStore', () => {
  it('reads synchronously from the snapshot handed over at boot', () => {
    expect(new FileStore(stubBridge({ a: '1' })).read('a')).toBe('1');
  });

  it('answers null for a key that was never written', () => {
    expect(new FileStore(stubBridge()).read('missing')).toBeNull();
  });

  /*
   * A write must be readable immediately by the same session even though it reaches disk
   * asynchronously. Anything else means a setting saved and then read back in the same frame
   * returns the old value, which is a bug nobody would look for.
   */
  it('reads back its own write without waiting for disk', () => {
    const bridge = stubBridge();
    const store = new FileStore(bridge);
    store.write('volume', '0.8');
    expect(store.read('volume')).toBe('0.8');
    expect(bridge.writeKey).toHaveBeenCalledWith('volume', '0.8');
  });

  it('forgets a removed key locally and tells the main process', () => {
    const bridge = stubBridge({ a: '1' });
    const store = new FileStore(bridge);
    store.remove('a');
    expect(store.read('a')).toBeNull();
    expect(bridge.removeKey).toHaveBeenCalledWith('a');
  });
});
