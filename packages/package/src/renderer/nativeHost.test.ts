import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_KEY } from '../preload/bridge.ts';
import type { DriftHostBridge } from '../preload/bridge.ts';
import { NativeDisplay, NativeLifecycle, hostBridge } from './nativeHost.ts';

function stubBridge(overrides: Partial<DriftHostBridge> = {}): DriftHostBridge {
  return {
    storeSnapshot: {},
    writeKey: vi.fn(),
    removeKey: vi.fn(),
    setFullscreen: vi.fn(async () => undefined),
    isFullscreen: () => false,
    refreshHz: () => 144,
    mode: () => 'windowed' as const,
    setMode: vi.fn(async () => true),
    size: () => ({ width: 1280, height: 720 }),
    canSetSize: () => true,
    setSize: vi.fn(async () => true),
    displays: () => [
      {
        id: '1',
        label: 'DELL U2723',
        width: 2560,
        height: 1440,
        scale: 1,
        refreshHz: 144,
        primary: true,
      },
    ],
    onFocusChange: () => () => undefined,
    onQuitRequest: () => () => undefined,
    canQuit: true,
    platform: { available: false, unlockAchievement: vi.fn(), setRichPresence: vi.fn() },
    requestQuit: vi.fn(),
    openFile: vi.fn(async () => null),
    saveFile: vi.fn(async () => true),
    ...overrides,
  };
}

describe('nativeHost', () => {
  /*
   * The browser implementation answers null here because no browser API reports it. A shell
   * knows, and reporting the real number is the point of having a shell at all.
   */
  it('reports the real refresh rate the browser could not', () => {
    expect(new NativeDisplay(stubBridge({ refreshHz: () => 144 })).refreshHz).toBe(144);
  });

  /*
   * Read on every access rather than captured once. A window dragged from a 60 Hz panel to a
   * 144 Hz one changes the answer, and a settings screen is where somebody looks afterwards.
   */
  it('re-reads the refresh rate rather than remembering it', () => {
    let hz = 60;
    const display = new NativeDisplay(stubBridge({ refreshHz: () => hz }));
    expect(display.refreshHz).toBe(60);
    hz = 144;
    expect(display.refreshHz).toBe(144);
  });

  it('reports the window mode and asks the shell to change it', async () => {
    const setMode = vi.fn(async () => true);
    const display = new NativeDisplay(stubBridge({ setMode }));
    expect(display.mode()).toBe('windowed');
    expect(await display.setMode('fullscreen')).toBe(true);
    expect(setMode).toHaveBeenCalledWith('fullscreen');
  });

  /*
   * The resolution half of a video settings screen. Unlike a browser, a shell can actually do
   * this — which is the whole reason the interface has it — and it still refuses while the
   * window is covering a display, where there is no display mode to change.
   */
  it('passes a resolution through, and reports a refusal as one', async () => {
    const setSize = vi.fn(async () => true);
    expect(await new NativeDisplay(stubBridge({ setSize })).setSize(1920, 1080)).toBe(true);
    expect(setSize).toHaveBeenCalledWith(1920, 1080);
    expect(
      await new NativeDisplay(stubBridge({ setSize: async () => false })).setSize(1920, 1080),
    ).toBe(false);
  });

  it('lists the displays the shell can see, with their real refresh rates', () => {
    const displays = new NativeDisplay(stubBridge()).displays();
    expect(displays).toHaveLength(1);
    expect(displays[0]?.label).toBe('DELL U2723');
    expect(displays[0]?.refreshHz).toBe(144);
  });

  it('can actually quit, unlike the browser implementation', () => {
    const bridge = stubBridge();
    new NativeLifecycle(bridge).requestQuit();
    expect(bridge.requestQuit).toHaveBeenCalled();
  });

  /*
   * A game bundled for the web and for a shell is one bundle. It has to be able to ask which
   * one it is in without throwing, so the absence of a bridge is null rather than an error.
   */
  it('answers null when the game is running in a plain browser', () => {
    expect(hostBridge()).toBeNull();
  });

  it('finds the bridge when the shell installed one', () => {
    const bridge = stubBridge();
    vi.stubGlobal(BRIDGE_KEY, bridge);
    expect(hostBridge()).toBe(bridge);
    vi.unstubAllGlobals();
  });
});

/**
 * **Reported from outside 2026-08-28.** Whether a resize would work could only be learned by
 * performing one: `false` from `setSize` was the only signal, and `setSize` is the mutator. The
 * reporter's workaround was a no-op probe at boot — `setSize(...size())` — which is exact and is
 * still a mutation on the boot path that exists only to ask a question.
 */
describe('asking a shell whether a resize would work', () => {
  it('forwards the question and touches nothing', () => {
    const canSetSize = vi.fn(() => true);
    const setSize = vi.fn(async () => true);
    expect(new NativeDisplay(stubBridge({ canSetSize, setSize })).canSetSize()).toBe(true);
    expect(canSetSize).toHaveBeenCalledTimes(1);
    expect(setSize, 'the question does not resize the window').not.toHaveBeenCalled();
  });

  it('answers false where the shell says the window cannot be resized now', () => {
    /* Which is what a shell says while its window is covering a display: there is no display mode
       to change, so there is nothing honest for a resize to do. */
    expect(new NativeDisplay(stubBridge({ canSetSize: () => false })).canSetSize()).toBe(false);
  });
});
