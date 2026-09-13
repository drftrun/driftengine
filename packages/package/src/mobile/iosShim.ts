import type { DisplayInfo, WindowMode } from '@driftengine/core';

import type { DriftHostBridge } from '../preload/bridge.ts';
import { SAVE_CHUNK_BYTES, base64Of, mimeForName } from './bridgeShim.ts';
import { showDeviceReport } from './report.ts';

/**
 * The same bridge again, from a platform with no synchronous return.
 *
 * **This is why iOS needs its own adapter rather than Android's.** `@JavascriptInterface` on
 * Android returns a value; `WKScriptMessageHandler` does not — it is one-way and asynchronous, and
 * there is no synchronous path from native code into JavaScript on this platform at all. The
 * engine's `KeyValueStore` is synchronous by contract, because preferences are read during boot
 * and an await there is a frame drawn with the wrong settings and corrected afterwards, which is a
 * visible flicker on every load.
 *
 * So the split is: **everything that must be read is injected**, as a literal object written into
 * the page before its first line of script runs, and **everything that changes something is a
 * message**. The host keeps that object current — a rotation replaces its `size` — which is why
 * this reads through it on every call rather than copying the values once.
 *
 * The mutations that report a result ride on `WKScriptMessageHandlerWithReply`, which does hand a
 * promise back, and which is why the deployment target is iOS 15 rather than something older.
 */
export interface IosState {
  snapshot: Record<string, string>;
  refreshHz: number | null;
  mode: WindowMode;
  size: { width: number; height: number };
  displays: DisplayInfo[];
  fullscreen: boolean;
  canQuit: boolean;
}

/** One message to the host. Resolves with whatever it replied, or rejects if it did not. */
export type IosCall = (name: string, payload: unknown) => Promise<unknown>;

export function installIosShim(state: IosState, call: IosCall): DriftHostBridge {
  const focusHandlers = new Set<(focused: boolean) => void>();
  const quitHandlers = new Set<() => void>();

  const send = (name: string, payload: unknown): void => {
    void call(name, payload).catch(() => undefined);
  };

  const ask = async (name: string, payload: unknown): Promise<boolean> => {
    try {
      return (await call(name, payload)) === true;
    } catch {
      /* The host went away, or the handler is not registered. A game must not see an exception
         from a settings screen. */
      return false;
    }
  };

  (globalThis as { __driftHostEvents?: unknown }).__driftHostEvents = {
    focus: (on: boolean) => {
      for (const handler of focusHandlers) handler(on);
    },
    quitRequest: () => {
      for (const handler of quitHandlers) handler();
    },
  };

  const noPicker = (): never => {
    throw new Error('[driftengine] no file picker on this platform; a desktop shell has one');
  };

  return {
    storeSnapshot: state.snapshot,
    writeKey: (key, value) => send('write', { key, value }),
    removeKey: (key) => send('remove', { key }),
    isFullscreen: () => state.fullscreen,
    setFullscreen: async (on) => {
      /* The status bar is the only thing there is to hide, and hiding it is not refused — so this
         is a message rather than a question. */
      send('fullscreen', { on });
    },
    refreshHz: () => state.refreshHz,
    mode: () => state.mode,
    setMode: async (mode) => ask('mode', { mode }),
    size: () => state.size,
    /* Constant rather than a round trip: there is no window on this platform to give a size to. */
    setSize: async () => false,
    /* The question, beside the refusal it must agree with. Both are constants here for the same
       reason, and the day iOS gains a resizable window they move together. */
    canSetSize: () => false,
    displays: () => state.displays,
    onFocusChange: (handler) => {
      focusHandlers.add(handler);
      return () => focusHandlers.delete(handler);
    },
    onQuitRequest: (handler) => {
      quitHandlers.add(handler);
      return () => quitHandlers.delete(handler);
    },
    /** False, always: an iOS application does not exit itself, and Apple asks that it not try. */
    canQuit: false,
    requestQuit: () => {
      console.warn('[driftengine] requestQuit: an iOS application does not exit itself');
    },
    /* No store on a phone: neither platform's own is integrated, and a game reads `available`
       and never calls the rest. */
    platform: {
      available: false,
      unlockAchievement: () => undefined,
      setRichPresence: () => undefined,
    },
    openFile: async () => noPicker(),
    /**
     * Saving goes to the share sheet, which is where a file goes on this platform.
     *
     * The bytes travel base64 in one message rather than in chunks: a reply-capable handler takes
     * a string of whatever size, and iOS has no equivalent of Android's per-call binder limit. The
     * chunk size is still respected for the encode itself, because building one enormous string
     * from a twenty megabyte clip is what overflows an argument list.
     */
    saveFile: async (name, bytes) => {
      const pieces: string[] = [];
      for (let at = 0; at < bytes.length; at += SAVE_CHUNK_BYTES) {
        pieces.push(base64Of(bytes.subarray(at, at + SAVE_CHUNK_BYTES)));
      }
      return ask('save', { name, mime: mimeForName(name), data: pieces });
    },
  };
}

/**
 * Install the bridge from what the host injected.
 *
 * Called by the bundled shim script, which the host evaluates at document start — the same timing
 * as the desktop preload and Android's document-start script.
 */
export function attachIosShim(key: string): void {
  const holder = globalThis as {
    __driftHostState?: IosState;
    webkit?: {
      messageHandlers?: Record<string, { postMessage(value: unknown): Promise<unknown> }>;
    };
  };
  const state = holder.__driftHostState;
  const handler = holder.webkit?.messageHandlers?.driftHost;
  if (state === undefined || handler === undefined) return;
  (globalThis as Record<string, unknown>)[key] = installIosShim(state, async (name, payload) =>
    handler.postMessage({ name, payload }),
  );
  showDeviceReport();
}
