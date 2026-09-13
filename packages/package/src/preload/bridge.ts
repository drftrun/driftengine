import type { DisplayInfo, WindowMode } from '@driftengine/core';

/**
 * The single surface the renderer can see, and the only one it ever gets.
 *
 * **This file is a security boundary, and it is deliberately small enough to read in full.**
 * `contextIsolation` is on and `nodeIntegration` is off, so a game — which may run third-party
 * code, a shader from a URL, or a mod — reaches the operating system through exactly these
 * members and nothing else. Adding one is a decision about what a compromised renderer can do.
 *
 * **`storeSnapshot` is a snapshot, not a live view.** `KeyValueStore.read` is synchronous by the
 * engine's contract, because preferences are read during boot and an await there is a visible
 * flicker on every load. IPC is asynchronous. So the main process reads the store from disk once,
 * before the window exists, and hands it over whole; writes go the other way and do not block.
 * **What this costs**: two windows of one application would not see each other's writes, which is
 * why the main process makes the application single-instance.
 */
export interface DriftHostBridge {
  readonly storeSnapshot: Readonly<Record<string, string>>;
  writeKey(key: string, value: string): void;
  removeKey(key: string): void;
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): boolean;
  /**
   * A call rather than a value, unlike the store snapshot beside it.
   *
   * Every other read here is taken once at preload because it cannot change; these can. A window
   * dragged to a second monitor changes its refresh rate, its size and which display it is on, and
   * a settings screen showing the value from boot would be showing the wrong monitor's.
   */
  refreshHz(): number | null;
  mode(): WindowMode;
  setMode(mode: WindowMode): Promise<boolean>;
  size(): { width: number; height: number };
  /**
   * Whether `setSize` would work right now.
   *
   * Synchronous like `size()` beside it, and for the same reason: a settings screen asks while it
   * is drawing a control, and an answer that arrived a frame later would draw the control twice.
   * The main process decides it with the same function that decides whether `setSize` refuses —
   * two conditions written twice would drift into a greyed control that works.
   */
  canSetSize(): boolean;
  setSize(width: number, height: number): Promise<boolean>;
  displays(): readonly DisplayInfo[];
  onFocusChange(handler: (focused: boolean) => void): () => void;
  onQuitRequest(handler: () => void): () => void;
  /** Whether `requestQuit` ends the process here. False on a platform that does not exit. */
  canQuit: boolean;
  requestQuit(): void;
  openFile(accept: readonly string[]): Promise<{ name: string; bytes: Uint8Array } | null>;
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * A store's own features, when there is a store and it answered.
   *
   * **The SDK lives in the main process and can only live there.** `steamworks.js` is a native
   * Node module and the renderer runs sandboxed with no Node at all, so a game reaching for Steam
   * directly is a game reaching for something that is not in its process. It crosses here like
   * every other capability.
   *
   * `available` is false when the manifest named no app, when the module is not installed, or when
   * the copy was launched outside Steam — all three of which are ordinary, and none of which is a
   * reason for a game to refuse to start.
   */
  readonly platform: {
    readonly available: boolean;
    unlockAchievement(id: string): void;
    setRichPresence(text: string): void;
  };
}

/** Where the bridge lands on `globalThis`. One name, so a game can feature-detect the shell. */
export const BRIDGE_KEY = '__driftHost';
