import { BrowserWindow, app, dialog, ipcMain, screen } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WindowMode } from '@driftengine/core';

import { SteamCloudStore } from '../steam/cloudStore.ts';
import { readStoreFile, writeStoreFile, writeStoreFileSync } from './storeFile.ts';
import type { SteamRuntime } from '../steam/main.ts';

/**
 * The main-process half of the bridge: a file-backed store, dialogs, focus, and quit.
 *
 * **The store is read once, synchronously, before the window exists.** That is what lets the
 * renderer satisfy `KeyValueStore`'s synchronous contract; see `preload/bridge.ts` for why that
 * contract is not negotiable. Writes are debounced to one file write, because a settings screen
 * with a slider writes on every frame of a drag and a save per frame is a stutter.
 *
 * **Three channels answer synchronously** — the snapshot, fullscreen state and refresh rate — and
 * that is a deliberate cost. A synchronous IPC blocks the renderer, so each is a single value
 * read at boot or from a settings screen, never anything per frame.
 */
const storeFile = (): string => join(app.getPath('userData'), 'store.json');

/** Milliseconds a write waits for its neighbours. A drag writes every frame; disk should not. */
const WRITE_DEBOUNCE_MS = 250;

/** How long a quit waits for a game that asked to be told about it. */
const QUIT_GRACE_MS = 3000;

/**
 * What the game starts with, read from wherever this build's saves live.
 *
 * Steam Cloud first where a store answered, because a player who moved machines expects their
 * settings to have travelled — and falling back to the local file when the cloud has nothing is
 * what makes the first launch after enabling Steam keep the saves it already had.
 */
export function readStoreSnapshot(steam: SteamRuntime | null = null): Record<string, string> {
  if (steam !== null) {
    const cloud = cloudSnapshot(steam);
    if (Object.keys(cloud).length > 0) return cloud;
  }
  return readLocalSnapshot();
}

/**
 * Every key Steam Cloud holds for this application.
 *
 * The API lists files rather than keys, and `SteamCloudStore` writes one file per key with a
 * `.txt` suffix — so the mapping is undone here rather than guessed at by a caller.
 */
function cloudSnapshot(steam: SteamRuntime): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const cloud = steam.cloud as SteamRuntime['cloud'] & { listFiles?(): { name: string }[] };
    for (const file of cloud.listFiles?.() ?? []) {
      if (!file.name.endsWith('.txt')) continue;
      const value = cloud.readFile(file.name);
      if (typeof value === 'string' && value.length > 0) {
        out[file.name.slice(0, -'.txt'.length)] = value;
      }
    }
  } catch {
    /* Cloud storage off for this title or this account. The local file is the answer. */
  }
  return out;
}

function readLocalSnapshot(): Record<string, string> {
  /* No file yet, or an unreadable one, reads as a fresh store: see `storeFile.ts`. */
  return readStoreFile(storeFile());
}

/** What the window half needs back from here, so quitting is one decision in one place. */
export interface QuitProtocol {
  /** True once the game has said it wants to be told before the window closes. */
  wantsNotice(): boolean;
  /** True when the close should proceed rather than be deferred. */
  mayClose(): boolean;
  /** Called from the window's `close` handler when it defers, to arm the grace timer. */
  deferClose(window: BrowserWindow): void;
}

export function installIpc(
  snapshot: Record<string, string>,
  windowOf: () => BrowserWindow | null,
  steam: SteamRuntime | null = null,
): QuitProtocol {
  const entries = new Map(Object.entries(snapshot));
  let pending: NodeJS.Timeout | null = null;

  /*
   * **Where a save actually lands, decided once, here.** A game asks the same `KeyValueStore` for
   * its preferences whatever platform it is on; whether those bytes go to a file beside the
   * application or into Steam Cloud — and therefore onto the player's other machine — is this
   * process's decision and nothing the renderer can see. That is the whole return on the seam.
   */
  const cloud = steam === null ? null : new SteamCloudStore(steam.cloud);

  const flush = (): void => {
    pending = null;
    if (cloud !== null) {
      for (const [key, value] of entries) cloud.write(key, value);
      return;
    }
    void writeStoreFile(storeFile(), entries).catch((cause: unknown) =>
      console.error('[driftengine] could not write the store:', cause),
    );
  };
  const schedule = (): void => {
    if (pending === null) pending = setTimeout(flush, WRITE_DEBOUNCE_MS);
  };

  ipcMain.on('drift:snapshot', (event) => {
    event.returnValue = Object.fromEntries(entries);
  });
  ipcMain.on('drift:write', (_event, key: string, value: string) => {
    entries.set(key, value);
    schedule();
  });
  ipcMain.on('drift:remove', (_event, key: string) => {
    entries.delete(key);
    schedule();
  });

  ipcMain.on('drift:platformAvailable', (event) => {
    event.returnValue = steam !== null;
  });
  ipcMain.on('drift:achievement', (_event, id: string) => steam?.unlockAchievement(id));
  ipcMain.on('drift:presence', (_event, text: string) => steam?.setRichPresence(text));

  ipcMain.on('drift:isFullscreen', (event) => {
    event.returnValue = windowOf()?.isFullScreen() ?? false;
  });
  ipcMain.handle('drift:setFullscreen', (_event, on: boolean) => {
    windowOf()?.setFullScreen(on);
  });
  ipcMain.on('drift:refreshHz', (event) => {
    event.returnValue = refreshHzFor(windowOf());
  });

  ipcMain.on('drift:mode', (event) => {
    event.returnValue = windowOf()?.isFullScreen() === true ? 'fullscreen' : 'windowed';
  });
  ipcMain.handle('drift:setMode', (_event, mode: WindowMode) => {
    const window = windowOf();
    if (window === null) return false;
    window.setFullScreen(mode === 'fullscreen');
    /* Read back rather than assume. A window manager may refuse, and a settings screen that
       believed the request would show a state the desktop disagrees with. */
    return window.isFullScreen() === (mode === 'fullscreen');
  });

  ipcMain.on('drift:size', (event) => {
    const [width = 0, height = 0] = windowOf()?.getContentSize() ?? [];
    event.returnValue = { width, height };
  });
  /**
   * Whether a resize would be performed, decided once for the two handlers that need it.
   *
   * **Refused while the window is covering a display**, because there is nothing honest to do:
   * Chromium never takes an exclusive fullscreen, so there is no display mode to change, and
   * resizing the window out from under a fullscreen state would silently leave it. A game that
   * wants fewer pixels while fullscreen changes its render scale, which is the engine's own
   * `RenderQuality`, not the window's business.
   *
   * **One function and not two conditions**, because the two handlers below answer the same
   * question — one by doing it and one by being asked — and a pair that drifted would give a
   * settings screen a greyed control that works, or a live one that does nothing. `AGENTS.md` calls
   * that shape out on its own: two implementations of one decision drift, and they drift invisibly
   * when they start identical.
   */
  const resizable = (): boolean => {
    const window = windowOf();
    return window !== null && !window.isFullScreen();
  };

  /*
   * Synchronous, like `drift:size`: a settings screen asks this while it is drawing a control, and
   * an answer a frame later would draw the control twice.
   */
  ipcMain.on('drift:canSetSize', (event) => {
    event.returnValue = resizable();
  });
  ipcMain.handle('drift:setSize', (_event, width: number, height: number) => {
    if (!resizable()) return false;
    const window = windowOf();
    if (window === null) return false;
    window.setContentSize(Math.round(width), Math.round(height));
    return true;
  });

  ipcMain.on('drift:displays', (event) => {
    const primary = screen.getPrimaryDisplay();
    event.returnValue = screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      /* A platform that has no name for a display gets its size, which is what a person picking
         between two monitors in a list actually recognises. */
      label:
        typeof display.label === 'string' && display.label.length > 0
          ? display.label
          : `${display.size.width}x${display.size.height}`,
      width: display.size.width,
      height: display.size.height,
      scale: display.scaleFactor,
      refreshHz:
        typeof display.displayFrequency === 'number' && display.displayFrequency > 0
          ? display.displayFrequency
          : null,
      primary: display.id === primary.id,
    }));
  });

  /*
   * **Quitting is a two-part protocol and the interest flag is what keeps it cheap.** A game that
   * registers `onQuitRequest` wants a moment to flush a save; a game that does not must close
   * instantly. Without the flag the only correct implementation defers *every* close for a grace
   * period, which is three seconds of nothing on the way out of a game that had nothing to say.
   */
  let noticeWanted = false;
  let closing = false;
  ipcMain.on('drift:quitInterest', () => {
    noticeWanted = true;
  });
  ipcMain.on('drift:quit', () => {
    closing = true;
    app.quit();
  });

  ipcMain.handle('drift:openFile', async (_event, accept: readonly string[]) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'files', extensions: accept.map((entry) => entry.replace(/^\./, '')) }],
    });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return null;
    return { name: path.split(/[\\/]/).pop() ?? path, bytes: new Uint8Array(await readFile(path)) };
  });

  ipcMain.handle('drift:saveFile', async (_event, name: string, bytes: Uint8Array) => {
    const result = await dialog.showSaveDialog({ defaultPath: name });
    if (result.canceled || result.filePath === undefined) return false;
    await writeFile(result.filePath, bytes);
    return true;
  });

  /*
   * **Flushed synchronously on the way out, and the synchronous part is the whole point.**
   *
   * A debounce that loses its last write loses exactly the setting somebody just changed before
   * quitting — and an *asynchronous* flush here loses it too, silently, because `app.quit()`
   * tears the process down without waiting for a promise. Measured: a probe that wrote a key and
   * then asked to quit left no file at all. A blocking write of a few kilobytes on the way out is
   * not a cost anybody can perceive; the alternative is a settings screen that sometimes works.
   */
  app.on('before-quit', () => {
    if (pending === null) return;
    clearTimeout(pending);
    pending = null;
    try {
      if (cloud !== null) {
        for (const [key, value] of entries) cloud.write(key, value);
        return;
      }
      writeStoreFileSync(storeFile(), entries);
    } catch (cause) {
      console.error('[driftengine] could not write the store on the way out:', cause);
    }
  });

  return {
    wantsNotice: () => noticeWanted,
    mayClose: () => closing,
    deferClose: (window) => {
      window.webContents.send('drift:quitRequest');
      /* The grace is a ceiling, not a wait: a game that answers with `requestQuit` closes at
         once. Without one, a game that hangs must not make the window unclosable. */
      setTimeout(() => {
        closing = true;
        window.close();
      }, QUIT_GRACE_MS);
    },
  };
}

/**
 * The refresh rate of the display this window is on, which the browser implementation of
 * `DisplayControl` has to answer null for.
 *
 * Null rather than a plausible 60 where the platform withholds it, matching the engine's rule:
 * something will divide by this.
 */
export function refreshHzFor(window: BrowserWindow | null): number | null {
  if (window === null) return null;
  const bounds = window.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  return typeof display.displayFrequency === 'number' && display.displayFrequency > 0
    ? display.displayFrequency
    : null;
}
