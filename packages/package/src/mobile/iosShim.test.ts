import { describe, expect, it, vi } from 'vitest';

import { installIosShim } from './iosShim.ts';
import type { IosState } from './iosShim.ts';

function stubState(overrides: Partial<IosState> = {}): IosState {
  return {
    snapshot: { 'settings.volume': '0.4' },
    refreshHz: 120,
    mode: 'fullscreen',
    size: { width: 393, height: 852 },
    displays: [
      {
        id: '0',
        label: 'built-in',
        width: 393,
        height: 852,
        scale: 3,
        refreshHz: 120,
        primary: true,
      },
    ],
    fullscreen: true,
    canQuit: false,
    ...overrides,
  };
}

describe('installIosShim', () => {
  /*
   * **The platform has no synchronous return at all.** A `WKScriptMessageHandler` is one-way and
   * asynchronous, and the engine's `KeyValueStore` is synchronous by contract — preferences are
   * read during boot, and an await there is a frame drawn with the wrong settings and corrected
   * after, which is a visible flicker on every load. So everything that must be read synchronously
   * is *injected* before the first line of page script runs, and only the mutations are messages.
   */
  it('reads the state the host injected, without asking for it', () => {
    const bridge = installIosShim(
      stubState(),
      vi.fn(async () => undefined),
    );
    expect(bridge.storeSnapshot['settings.volume']).toBe('0.4');
    expect(bridge.refreshHz()).toBe(120);
    expect(bridge.size()).toEqual({ width: 393, height: 852 });
    expect(bridge.displays()[0]?.scale).toBe(3);
    expect(bridge.isFullscreen()).toBe(true);
  });

  /*
   * The state object is the host's, live: a rotation replaces its size, and a bridge that had
   * copied the values at boot would report the old ones for the rest of the session.
   */
  it('re-reads state the host changed after boot', () => {
    const state = stubState();
    const bridge = installIosShim(
      state,
      vi.fn(async () => undefined),
    );
    state.size = { width: 852, height: 393 };
    expect(bridge.size()).toEqual({ width: 852, height: 393 });
  });

  it('sends a write without waiting for it', () => {
    const call = vi.fn(async () => undefined);
    installIosShim(stubState(), call).writeKey('a', '1');
    expect(call).toHaveBeenCalledWith('write', { key: 'a', value: '1' });
  });

  /*
   * iOS applications do not exit programmatically and Apple's guidance is that they should not.
   * A game reads this and draws no exit button, which is the whole reason the property exists.
   */
  it('says it cannot quit, because on this platform nothing can', () => {
    expect(
      installIosShim(
        stubState(),
        vi.fn(async () => undefined),
      ).canQuit,
    ).toBe(false);
  });

  /* There is no window to resize, so the refusal is a constant rather than a round trip. */
  it('refuses a resize without asking the host', async () => {
    const call = vi.fn(async () => undefined);
    expect(await installIosShim(stubState(), call).setSize(800, 600)).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  /*
   * `WKScriptMessageHandlerWithReply` gives a promise back, which is what lets a save report
   * whether it worked. Everything asynchronous here rides on that.
   */
  it('saves a file and reports what the host answered', async () => {
    const call = vi.fn(async () => true);
    expect(
      await installIosShim(stubState(), call).saveFile('clip.webm', new Uint8Array([1, 2, 3])),
    ).toBe(true);
    expect(call).toHaveBeenCalledWith(
      'save',
      expect.objectContaining({ name: 'clip.webm', mime: 'video/webm' }),
    );
  });

  it('reports a save the host refused', async () => {
    expect(
      await installIosShim(
        stubState(),
        vi.fn(async () => false),
      ).saveFile('a.png', new Uint8Array([1])),
    ).toBe(false);
  });

  /* A message that throws is a host that went away; a game must not see an exception for it. */
  it('answers false rather than throwing when the host does not reply', async () => {
    const call = vi.fn(async () => {
      throw new Error('no handler');
    });
    expect(await installIosShim(stubState(), call).saveFile('a.png', new Uint8Array([1]))).toBe(
      false,
    );
  });
});
