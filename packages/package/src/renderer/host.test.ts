import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_KEY } from '../preload/bridge.ts';
import type { DriftHostBridge } from '../preload/bridge.ts';
import { createHost } from './host.ts';
import { NativeDisplay } from './nativeHost.ts';

function stubBridge(): DriftHostBridge {
  return {
    storeSnapshot: { 'settings.volume': '0.5' },
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

describe('createHost', () => {
  /*
   * The same call in both places is the whole point: a game asks for a host once, at boot, and
   * writes one settings screen against what it gets back. Branching on the platform is this
   * function's job and nobody else's.
   */
  it('gives browser implementations when there is no shell', () => {
    const host = createHost({} as unknown as HTMLElement);
    expect(host.native).toBe(false);
    expect(host.display).not.toBeInstanceOf(NativeDisplay);
  });

  it('gives shell implementations when a shell installed a bridge', () => {
    vi.stubGlobal(BRIDGE_KEY, stubBridge());
    const host = createHost({} as unknown as HTMLElement);
    expect(host.native).toBe(true);
    expect(host.display).toBeInstanceOf(NativeDisplay);
    /* The store is the shell's file, hydrated from the snapshot it handed over at boot. */
    expect(host.store.read('settings.volume')).toBe('0.5');
    vi.unstubAllGlobals();
  });
});
