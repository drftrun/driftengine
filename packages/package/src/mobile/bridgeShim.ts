import type { DisplayInfo, WindowMode } from '@driftengine/core';

import type { DriftHostBridge } from '../preload/bridge.ts';
import { showDeviceReport } from './report.ts';

/**
 * One bridge shape, assembled from what a mobile WebView is able to hand over.
 *
 * **Android's `@JavascriptInterface` can pass strings, numbers and booleans and nothing else.** It
 * cannot return a promise, an object, an array or a callback. So the native surface is flat,
 * synchronous and string-only — `snapshot()` returns JSON, `displays()` returns JSON — and this
 * file turns it into the same `DriftHostBridge` the desktop shell exposes. The engine then sees
 * **one** seam with three shells behind it rather than three seams, which is the whole design.
 *
 * **Naming them differently is deliberate.** The native object is `__driftHostNative`; the one a
 * game reaches is `__driftHost`. A single half-typed object would hide the adaptation; two names
 * make it a file somebody can read.
 *
 * **Events come the other way through a global**, because a WebView cannot call into the page: the
 * host evaluates `globalThis.__driftHostEvents.focus(false)` when the activity pauses. Installed
 * here rather than in the host, so the subscription bookkeeping is written once in TypeScript.
 */
export interface NativeShimSurface {
  snapshot(): string;
  write(key: string, value: string): void;
  remove(key: string): void;
  isFullscreen(): boolean;
  setFullscreen(on: boolean): void;
  refreshHz(): number;
  mode(): string;
  setMode(mode: string): boolean;
  size(): string;
  setSize(width: number, height: number): boolean;
  canSetSize(): boolean;
  displays(): string;
  /**
   * Whether this platform lets an application end itself.
   *
   * Android does — `finish()` closes the activity. iOS does not, and Apple's guidance is explicit
   * that an application should not: a game there answers false and draws no exit button.
   */
  canQuit(): boolean;
  /**
   * Writing a file, in three calls, because a bridge that can only carry strings cannot carry a
   * twenty megabyte clip in one.
   *
   * `saveBegin` returns false where the platform refused to start — no space, no permission — and
   * `saveEnd` returns where the file landed, in words a person can be told.
   */
  saveBegin(name: string, mime: string): boolean;
  saveChunk(base64: string): boolean;
  saveEnd(): string;
  saveAbort(): void;
  requestQuit(): void;
}

/** What the host pushes in. Installed on `globalThis` so a WebView can evaluate against it. */
interface HostEvents {
  focus(on: boolean): void;
  quitRequest(): void;
  /**
   * The back gesture. **True means the game dealt with it and the host must do nothing.**
   *
   * Answered in the order a game would want it answered: a registered quit handler first, because
   * a game that asked to be told about leaving has a confirmation to show; then an Escape key,
   * because a game with no quit handler almost certainly has a pause menu bound to one, and
   * `preventDefault` is the page saying that keystroke was its own. False means neither, and the
   * host is then free to close — after asking twice, which is its own business.
   */
  back(): boolean;
  /**
   * A download the host intercepted, completed here.
   *
   * The host cannot read a `blob:` URL — it belongs to the page — so it hands it back and the page
   * fetches its own blob, then sends the bytes over the same chunked road as `saveFile`.
   */
  saveBlob(url: string, name: string): Promise<boolean>;
}

/**
 * Half a megabyte of bytes a call, which is about seven hundred kilobytes of base64.
 *
 * Large enough that a twenty megabyte clip is forty calls rather than four thousand, and small
 * enough that neither the string nor the argument list is anywhere near a limit.
 */
export const SAVE_CHUNK_BYTES = 512 * 1024;

/**
 * Bytes as base64, built in pieces.
 *
 * `String.fromCharCode(...bytes)` on a whole file overflows the argument list and throws — at a
 * size that depends on the engine, so it works in a test and fails on a real clip.
 */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const step = 8192;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  return btoa(binary);
}

/**
 * What the platform files a name under.
 *
 * Android sorts a download by its declared type, so a clip saved as `application/octet-stream`
 * lands somewhere a gallery will not look for it. Wrong is worse than unknown here, so anything
 * unrecognised stays octet-stream rather than being guessed at.
 */
export function mimeForName(name: string): string {
  const dot = name.lastIndexOf('.');
  switch (dot === -1 ? '' : name.slice(dot + 1).toLowerCase()) {
    case 'webm':
      return 'video/webm';
    case 'mp4':
      return 'video/mp4';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'json':
      return 'application/json';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    /* A malformed payload is a host bug, and a game that cannot start because its preferences
       did not parse is a worse one. Empty is the same degradation `BrowserStore` makes. */
    return fallback;
  }
}

/**
 * Synthesise the key a pause menu is bound to, and report whether the page took it.
 *
 * **A keydown and a keyup**, because a game that tracks held keys and only ever receives the down
 * ends up with Escape held forever — which is a menu that will not close, from a fix meant to stop
 * one closing too easily.
 *
 * Dispatched at the focused element so it bubbles the way a real keystroke does; a game listening
 * on `window`, on `document` or on its canvas all receive it.
 */
function pressEscape(): boolean {
  const target =
    (globalThis as { document?: { activeElement?: unknown; body?: unknown } }).document ?? null;
  if (target === null) return false;
  const node = (target.activeElement ?? target.body) as
    { dispatchEvent(event: unknown): boolean } | undefined;
  if (node === undefined || node === null || typeof node.dispatchEvent !== 'function') return false;

  const make = (type: string): unknown =>
    new KeyboardEvent(type, {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    });
  const consumed = !node.dispatchEvent(make('keydown'));
  node.dispatchEvent(make('keyup'));
  return consumed;
}

export function installShim(native: NativeShimSurface): DriftHostBridge {
  const focusHandlers = new Set<(focused: boolean) => void>();
  const quitHandlers = new Set<() => void>();

  const events: HostEvents = {
    focus: (on) => {
      for (const handler of focusHandlers) handler(on);
    },
    quitRequest: () => {
      for (const handler of quitHandlers) handler();
    },
    saveBlob: async (url, name) => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      } catch {
        /* A revoked or cross-origin URL. Nothing is opened, so no empty file is left behind. */
        return false;
      }
      return saveFile(name, bytes);
    },
    back: () => {
      if (quitHandlers.size > 0) {
        for (const handler of quitHandlers) handler();
        return true;
      }
      return pressEscape();
    },
  };
  (globalThis as { __driftHostEvents?: HostEvents }).__driftHostEvents = events;

  const saveFile = async (name: string, bytes: Uint8Array): Promise<boolean> => {
    if (!native.saveBegin(name, mimeForName(name))) return false;
    try {
      for (let at = 0; at < bytes.length; at += SAVE_CHUNK_BYTES) {
        if (!native.saveChunk(base64Of(bytes.subarray(at, at + SAVE_CHUNK_BYTES)))) {
          native.saveAbort();
          return false;
        }
      }
      native.saveEnd();
      return true;
    } catch {
      /* Half a clip on disk looks exactly like a whole one to a file manager, and the person who
         finds it there has no way to know. Abandoned rather than finished. */
      native.saveAbort();
      return false;
    }
  };

  const noPicker = (): never => {
    /*
     * A game does not open files; an editor does, and an editor is not a phone application. The
     * refusal is loud rather than a null, for the same reason `BrowserFileDialogs` throws where a
     * browser has no picker: a cancel and an absent capability are different answers.
     */
    throw new Error('[driftengine] no file picker on this platform; a desktop shell has one');
  };

  return {
    storeSnapshot: parseJson<Record<string, string>>(native.snapshot(), {}),
    writeKey: (key, value) => native.write(key, value),
    removeKey: (key) => native.remove(key),
    isFullscreen: () => native.isFullscreen(),
    setFullscreen: async (on) => {
      native.setFullscreen(on);
    },
    refreshHz: () => {
      const hz = native.refreshHz();
      /* Zero is what a platform reports when it will not say, and a plausible 60 is exactly what
         the engine's rule forbids inventing. */
      return typeof hz === 'number' && hz > 0 ? hz : null;
    },
    mode: () => (native.mode() === 'windowed' ? 'windowed' : 'fullscreen') as WindowMode,
    setMode: async (mode) => native.setMode(mode),
    size: () =>
      parseJson<{ width: number; height: number }>(native.size(), { width: 0, height: 0 }),
    setSize: async (width, height) => native.setSize(width, height),
    /* Asked of the host rather than answered here, so the refusal and the question stay one
       decision: `HostBridge.java` answers both beside each other. */
    canSetSize: () => native.canSetSize(),
    displays: () => parseJson<DisplayInfo[]>(native.displays(), []),
    onFocusChange: (handler) => {
      focusHandlers.add(handler);
      return () => focusHandlers.delete(handler);
    },
    onQuitRequest: (handler) => {
      quitHandlers.add(handler);
      return () => quitHandlers.delete(handler);
    },
    canQuit: native.canQuit(),
    requestQuit: () => native.requestQuit(),
    /* No store on a phone: neither platform's own is integrated, and a game reads `available`
       and never calls the rest. */
    platform: {
      available: false,
      unlockAchievement: () => undefined,
      setRichPresence: () => undefined,
    },
    openFile: async () => noPicker(),
    saveFile,
  };
}

/**
 * Wire the native surface into the global the engine's `hostBridge()` looks for.
 *
 * Called by the injected shim script, which the host evaluates before the game's own scripts run —
 * `WebViewCompat.addDocumentStartJavaScript` on Android, a user script on iOS. That timing is what
 * makes this the mobile equivalent of the desktop preload rather than something a game has to
 * remember to import.
 */
export function attachShim(key: string): void {
  const native = (globalThis as Record<string, unknown>).__driftHostNative as
    NativeShimSurface | undefined;
  if (native === undefined) return;
  (globalThis as Record<string, unknown>)[key] = installShim(native);
  showDeviceReport();
}
