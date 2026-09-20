/**
 * The shell's bridge, `globalThis.__driftHost`, answered by this host.
 *
 * **A packaged game reaches its platform through `createHost()`**, from `@driftengine/package`, which
 * takes the shell's implementations whenever it finds this bridge — and the engine's splash stands
 * aside for a shell. The desktop shell's preload puts one there over Electron's IPC; this host puts
 * its own there over SDL and the filesystem, so a game packaged for one runs on the other with no
 * change. Each member makes the decision the desktop shell's main process makes (`main/ipc.ts`), for
 * the same reasons, written beside it.
 *
 * - **The store** is one file, read whole before the game boots and replaced whole a quarter of a
 *   second after the last write — `storeFile.ts`, which the desktop shell uses too — and written at
 *   once, synchronously, on the way out, because a debounce that loses its last write loses exactly
 *   the setting somebody changed before quitting.
 * - **Fullscreen** is read back after it is asked for, since a window manager may refuse, and a
 *   size is refused while the window covers a display.
 * - **Closing** asks a game that registered to be asked, and waits for it at most three seconds; a
 *   game that did not is closed at once.
 *
 * What it gives up: SDL 2 reports no scale for a display, so a display the window is not on reads
 * 1; the store has no cloud; and `platform` answers that no store's features are here.
 */

import type { DisplayInfo, WindowMode } from '@driftengine/core';

import type { DriftHostBridge } from '@driftengine/package/bridge';
import { readStoreFile, writeStoreFile, writeStoreFileSync } from '@driftengine/package/store';

/** A display, as SDL reports one. */
export interface BridgeDisplay {
  readonly name: string | null;
  readonly frequency: number;
  readonly geometry: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** What the bridge reads and drives of the SDL window. */
export interface BridgeWindow {
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly fullscreen: boolean;
  readonly display: BridgeDisplay;
  setFullscreen(on: boolean): void;
  setSize(width: number, height: number): void;
  on(
    type: 'focus' | 'blur' | 'beforeClose',
    listener: (event: { prevent?: () => void }) => void,
  ): unknown;
  off(
    type: 'focus' | 'blur' | 'beforeClose',
    listener: (event: { prevent?: () => void }) => void,
  ): unknown;
}

export interface NativeFiles {
  openFile(accept: readonly string[]): Promise<{ name: string; bytes: Uint8Array } | null>;
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
}

export interface NativeBridgeOptions {
  readonly window: BridgeWindow;
  readonly displays: () => readonly BridgeDisplay[];
  readonly storePath: string;
  /** End the session: the host stops drawing and closes the window. */
  readonly quit: () => void;
  readonly files?: NativeFiles;
}

/** The bridge, and what writes its store now. */
export interface NativeBridge extends DriftHostBridge {
  flushSync(): void;
}

/** The desktop shell's figures (`main/ipc.ts`), for the same reasons. */
const WRITE_DEBOUNCE_MS = 250;
const QUIT_GRACE_MS = 3000;

const idOf = (display: BridgeDisplay) =>
  `${display.name ?? ''}@${display.geometry.x},${display.geometry.y}`;

/**
 * No file dialog on this desktop: a cancelled pick and a refused save, which a game already handles,
 * and one line saying why, so a player whose picker never opens is told what to install.
 */
function noFiles(): NativeFiles {
  let said = false;
  const say = (): void => {
    if (said) return;
    said = true;
    console.warn(
      '[driftengine] this desktop has no file dialog for the native host: install zenity',
    );
  };
  return {
    openFile: () => {
      say();
      return Promise.resolve(null);
    },
    saveFile: () => {
      say();
      return Promise.resolve(false);
    },
  };
}

export function nativeBridge(options: NativeBridgeOptions): NativeBridge {
  const { window, storePath } = options;
  const snapshot = readStoreFile(storePath);
  const entries = new Map(Object.entries(snapshot));
  let pending: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    pending = null;
    void writeStoreFile(storePath, entries).catch((cause: unknown) =>
      console.error('[driftengine] could not write the store:', cause),
    );
  };
  const schedule = (): void => {
    if (pending === null) pending = setTimeout(flush, WRITE_DEBOUNCE_MS);
  };
  const flushSync = (): void => {
    if (pending === null) return;
    clearTimeout(pending);
    pending = null;
    try {
      writeStoreFileSync(storePath, entries);
    } catch (cause) {
      console.error('[driftengine] could not write the store on the way out:', cause);
    }
  };

  /* One decision for the two members that need it, as the desktop shell's `resizable` is. */
  const resizable = (): boolean => !window.fullscreen;

  const quitHandlers = new Set<() => void>();
  let grace: ReturnType<typeof setTimeout> | null = null;
  const quit = (): void => {
    if (grace !== null) clearTimeout(grace);
    grace = null;
    flushSync();
    options.quit();
  };
  window.on('beforeClose', (event) => {
    if (quitHandlers.size === 0) {
      quit();
      return;
    }
    event.prevent?.();
    for (const handler of quitHandlers) handler();
    /* A ceiling, not a wait: a game that answers with `requestQuit` closes at once. */
    grace ??= setTimeout(quit, QUIT_GRACE_MS);
  });

  const files = options.files ?? noFiles();
  return {
    storeSnapshot: snapshot,
    writeKey(key, value) {
      entries.set(key, value);
      schedule();
    },
    removeKey(key) {
      entries.delete(key);
      schedule();
    },
    flushSync,
    setFullscreen(on) {
      window.setFullscreen(on);
      return Promise.resolve();
    },
    isFullscreen: () => window.fullscreen,
    refreshHz: () => (window.display.frequency > 0 ? window.display.frequency : null),
    mode: (): WindowMode => (window.fullscreen ? 'fullscreen' : 'windowed'),
    setMode(mode) {
      window.setFullscreen(mode === 'fullscreen');
      /* Read back rather than assumed: a window manager may refuse. */
      return Promise.resolve(window.fullscreen === (mode === 'fullscreen'));
    },
    size: () => ({ width: window.width, height: window.height }),
    canSetSize: resizable,
    setSize(width, height) {
      if (!resizable()) return Promise.resolve(false);
      window.setSize(Math.round(width), Math.round(height));
      return Promise.resolve(true);
    },
    displays(): readonly DisplayInfo[] {
      const on = idOf(window.display);
      return options.displays().map((display, at) => ({
        id: idOf(display),
        /* A size where there is no name, which is what somebody choosing a monitor recognises. */
        label:
          display.name !== null && display.name.length > 0
            ? display.name
            : `${display.geometry.width}x${display.geometry.height}`,
        width: display.geometry.width,
        height: display.geometry.height,
        scale: idOf(display) === on ? window.pixelWidth / window.width : 1,
        refreshHz: display.frequency > 0 ? display.frequency : null,
        /* SDL lists the primary display first. */
        primary: at === 0,
      }));
    },
    onFocusChange(handler) {
      const focus = () => handler(true);
      const blur = () => handler(false);
      window.on('focus', focus);
      window.on('blur', blur);
      return () => {
        window.off('focus', focus);
        window.off('blur', blur);
      };
    },
    onQuitRequest(handler) {
      quitHandlers.add(handler);
      return () => quitHandlers.delete(handler);
    },
    canQuit: true,
    requestQuit: quit,
    openFile: (accept) => files.openFile(accept),
    saveFile: (name, bytes) => files.saveFile(name, bytes),
    platform: {
      available: false,
      unlockAchievement: () => undefined,
      setRichPresence: () => undefined,
    },
  };
}
