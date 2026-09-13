import { describe, expect, it, vi } from 'vitest';

import { installShim } from './bridgeShim.ts';
import type { NativeShimSurface } from './bridgeShim.ts';

function stubNative(overrides: Partial<NativeShimSurface> = {}): NativeShimSurface {
  return {
    snapshot: () => JSON.stringify({ 'settings.volume': '0.7' }),
    write: vi.fn(),
    remove: vi.fn(),
    isFullscreen: () => true,
    setFullscreen: vi.fn(),
    refreshHz: () => 120,
    mode: () => 'fullscreen',
    setMode: vi.fn(() => true),
    size: () => JSON.stringify({ width: 1080, height: 2400 }),
    setSize: () => false,
    canSetSize: () => false,
    displays: () =>
      JSON.stringify([
        {
          id: '0',
          label: 'built-in',
          width: 1080,
          height: 2400,
          scale: 2.75,
          refreshHz: 120,
          primary: true,
        },
      ]),
    canQuit: () => true,
    saveBegin: vi.fn(() => true),
    saveChunk: vi.fn(() => true),
    saveEnd: vi.fn(() => 'Downloads/clip.webm'),
    saveAbort: vi.fn(),
    requestQuit: vi.fn(),
    ...overrides,
  };
}

describe('installShim', () => {
  /*
   * **Android's `@JavascriptInterface` can only pass strings, numbers and booleans.** It cannot
   * hand back a promise, an object or a callback — so the native surface is flat, synchronous and
   * string-only, and this is what turns it into the same `DriftHostBridge` the desktop shell
   * exposes. The engine then sees one seam with three shells behind it rather than three seams.
   */
  it('parses the store snapshot a native surface can only send as a string', () => {
    const bridge = installShim(stubNative());
    expect(bridge.storeSnapshot['settings.volume']).toBe('0.7');
  });

  it('answers a malformed snapshot with an empty store rather than throwing', () => {
    const bridge = installShim(stubNative({ snapshot: () => 'not json' }));
    expect(bridge.storeSnapshot).toEqual({});
  });

  it('turns the synchronous calls into the promises the interface returns', async () => {
    const setMode = vi.fn(() => true);
    const bridge = installShim(stubNative({ setMode }));
    await expect(bridge.setMode('windowed')).resolves.toBe(true);
    expect(setMode).toHaveBeenCalledWith('windowed');
  });

  /* A phone has no window to size. Reporting the refusal is what lets a settings screen grey it. */
  it('reports that a phone cannot be resized', async () => {
    await expect(installShim(stubNative()).setSize(800, 600)).resolves.toBe(false);
  });

  /* Android closes an activity; iOS does not, and a game's exit button is drawn from this. */
  it('carries whether the platform lets an application end itself', () => {
    expect(installShim(stubNative()).canQuit).toBe(true);
    expect(installShim(stubNative({ canQuit: () => false })).canQuit).toBe(false);
  });

  it('parses the display list and the surface size', () => {
    const bridge = installShim(stubNative());
    expect(bridge.size()).toEqual({ width: 1080, height: 2400 });
    expect(bridge.displays()[0]?.refreshHz).toBe(120);
  });

  /*
   * An editor opens files; a game does not, and Android's picker is an intent with an
   * asynchronous result rather than a call. Refusing loudly is the honest state — the same one
   * `BrowserFileDialogs` reports where a browser has no picker.
   */
  it('refuses to open a file rather than pretending to have a picker', async () => {
    await expect(installShim(stubNative()).openFile(['.drft'])).rejects.toThrow(/no file picker/i);
  });

  /*
   * **Saving is the half a game actually needs**, and it is the half that failed silently: a clip
   * export ends in a download, a WebView drops one on the floor with no listener, and the player
   * taps save and gets nothing at all. The bytes go across in chunks because the only thing this
   * bridge can carry is a string.
   */
  it('saves a file by handing the bytes across in chunks', async () => {
    const native = stubNative();
    const saved = await installShim(native).saveFile('clip.webm', new Uint8Array([1, 2, 3, 4]));
    expect(saved).toBe(true);
    expect(native.saveBegin).toHaveBeenCalledWith('clip.webm', expect.any(String));
    expect(native.saveChunk).toHaveBeenCalled();
    expect(native.saveEnd).toHaveBeenCalled();
  });

  it('reports a save the platform refused to start', async () => {
    const native = stubNative({ saveBegin: vi.fn(() => false) });
    expect(await installShim(native).saveFile('clip.webm', new Uint8Array([1]))).toBe(false);
    expect(native.saveChunk).not.toHaveBeenCalled();
  });

  /* A chunk that fails mid-file must not leave half a clip looking like a whole one. */
  it('abandons a file whose write failed part way', async () => {
    const native = stubNative({
      saveChunk: vi.fn(() => {
        throw new Error('no space');
      }),
    });
    expect(await installShim(native).saveFile('clip.webm', new Uint8Array([1, 2]))).toBe(false);
    expect(native.saveAbort).toHaveBeenCalled();
    expect(native.saveEnd).not.toHaveBeenCalled();
  });

  it('guesses a type from the name, because the platform files by it', async () => {
    const native = stubNative();
    const shim = installShim(native);
    await shim.saveFile('a.webm', new Uint8Array([1]));
    await shim.saveFile('b.png', new Uint8Array([1]));
    expect(native.saveBegin).toHaveBeenNthCalledWith(1, 'a.webm', 'video/webm');
    expect(native.saveBegin).toHaveBeenNthCalledWith(2, 'b.png', 'image/png');
  });

  /*
   * The host has no way to call into the page directly, so events arrive through a global the
   * shim installs and the activity evaluates against. Registering a handler must survive the
   * host calling before anything subscribed.
   */
  it('delivers focus and quit events the host pushes in', () => {
    const events: unknown[] = [];
    const bridge = installShim(stubNative());
    const stop = bridge.onFocusChange((focused) => events.push(focused));
    bridge.onQuitRequest(() => events.push('quit'));

    const pump = (
      globalThis as { __driftHostEvents?: { focus(on: boolean): void; quitRequest(): void } }
    ).__driftHostEvents;
    pump?.focus(false);
    pump?.quitRequest();
    expect(events).toEqual([false, 'quit']);

    stop();
    pump?.focus(true);
    expect(events).toEqual([false, 'quit']);
  });

  /*
   * **The back gesture, and why it is not a quit.** On Android, back closing a game outright is
   * how a run is lost by a thumb, and there is no window manager asking "are you sure". So the
   * host asks the page first, and the page answers in the order a game would want it answered.
   */
  describe('the back gesture', () => {
    const backOf = (): (() => boolean) => {
      const events = (globalThis as { __driftHostEvents?: { back(): boolean } }).__driftHostEvents;
      if (events === undefined) throw new Error('the shim installed no events');
      return () => events.back();
    };

    it('asks a game that registered a quit handler, and reports it handled', () => {
      const bridge = installShim(stubNative());
      let asked = 0;
      bridge.onQuitRequest(() => {
        asked += 1;
      });
      expect(backOf()()).toBe(true);
      expect(asked).toBe(1);
    });

    /*
     * A game with no quit handler still usually binds Escape, because that is the key a pause
     * menu opens on. Back becomes Escape, and whether the game consumed it is the answer — a
     * `preventDefault` is the page saying "that was mine".
     */
    it('becomes an Escape key when nothing registered a quit handler', () => {
      const seen: string[] = [];
      const listeners: Array<(event: { key: string; preventDefault(): void }) => void> = [];
      vi.stubGlobal(
        'KeyboardEvent',
        class {
          readonly key: string;
          prevented = false;
          constructor(_type: string, init: { key: string }) {
            this.key = init.key;
          }
          preventDefault(): void {
            this.prevented = true;
          }
        },
      );
      vi.stubGlobal('document', {
        activeElement: null,
        body: {
          dispatchEvent: (event: { key: string; prevented: boolean }) => {
            seen.push(event.key);
            for (const listener of listeners) listener(event as never);
            return !event.prevented;
          },
        },
      });

      installShim(stubNative());
      expect(backOf()()).toBe(false);
      expect(seen).toEqual(['Escape', 'Escape']);

      /* Now a game that handles it. */
      listeners.push((event) => event.preventDefault());
      expect(backOf()()).toBe(true);
      vi.unstubAllGlobals();
    });

    /* No DOM at all is a page that has not loaded. Unhandled, so the host falls back. */
    it('reports unhandled when there is nothing to dispatch to', () => {
      vi.stubGlobal('document', undefined);
      installShim(stubNative());
      expect(backOf()()).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  /*
   * **The path a game takes without knowing there is a host at all.** `offerClip` ends in an
   * anchor with a `download` attribute pointing at a blob URL, which is what every browser
   * understands and what a WebView drops on the floor unless something picks it up. The host's
   * download listener hands the URL back here, and the bytes take the same chunked road as an
   * explicit `saveFile`.
   */
  describe('a download the host caught', () => {
    it('fetches the blob and saves it', async () => {
      const native = stubNative();
      installShim(native);
      vi.stubGlobal('fetch', async () => ({
        arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
      }));

      const events = (
        globalThis as {
          __driftHostEvents?: { saveBlob(url: string, name: string): Promise<boolean> };
        }
      ).__driftHostEvents;
      expect(await events?.saveBlob('blob:https://x/y', 'clip.webm')).toBe(true);
      expect(native.saveBegin).toHaveBeenCalledWith('clip.webm', 'video/webm');
      vi.unstubAllGlobals();
    });

    it('reports a blob it could not read rather than writing an empty file', async () => {
      const native = stubNative();
      installShim(native);
      vi.stubGlobal('fetch', async () => {
        throw new Error('gone');
      });
      const events = (
        globalThis as {
          __driftHostEvents?: { saveBlob(url: string, name: string): Promise<boolean> };
        }
      ).__driftHostEvents;
      expect(await events?.saveBlob('blob:https://x/y', 'clip.webm')).toBe(false);
      expect(native.saveBegin).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
