import { contextBridge, ipcRenderer } from 'electron';

import type { DisplayInfo, WindowMode } from '@driftengine/core';

/**
 * Everything the renderer will ever be able to reach, assembled once.
 *
 * `contextBridge` is what keeps this a boundary rather than a suggestion: the renderer sees the
 * object below and no `require`, no `ipcRenderer`, and no `process`.
 *
 * **Written as an ES module and emitted as CommonJS.** A sandboxed preload is loaded before ES
 * modules exist in that context, so the artifact must be `preload.cjs` — but the module format is
 * the builder's decision rather than the source's, and a `.cts` file cannot use `import` at all
 * under this repository's `verbatimModuleSyntax`.
 *
 * **Three values are read synchronously at load.** The store snapshot is what lets the engine's
 * `KeyValueStore` stay synchronous — see `bridge.ts` — and fullscreen and refresh rate are read
 * once here rather than per call so a settings screen never blocks a frame on IPC.
 */
const snapshot = ipcRenderer.sendSync('drift:snapshot') as Record<string, string>;

const bridge = {
  storeSnapshot: snapshot,
  writeKey: (key: string, value: string): void => {
    ipcRenderer.send('drift:write', key, value);
  },
  removeKey: (key: string): void => {
    ipcRenderer.send('drift:remove', key);
  },
  setFullscreen: (on: boolean): Promise<void> => ipcRenderer.invoke('drift:setFullscreen', on),
  isFullscreen: (): boolean => ipcRenderer.sendSync('drift:isFullscreen') as boolean,
  /* Read on every call, not once: a window moved to another monitor changes all four of these,
     and a settings screen is exactly where somebody looks after moving it. */
  refreshHz: (): number | null => ipcRenderer.sendSync('drift:refreshHz') as number | null,
  mode: (): WindowMode => ipcRenderer.sendSync('drift:mode') as WindowMode,
  setMode: (mode: WindowMode): Promise<boolean> =>
    ipcRenderer.invoke('drift:setMode', mode) as Promise<boolean>,
  size: (): { width: number; height: number } =>
    ipcRenderer.sendSync('drift:size') as { width: number; height: number },
  canSetSize: (): boolean => ipcRenderer.sendSync('drift:canSetSize') as boolean,
  setSize: (width: number, height: number): Promise<boolean> =>
    ipcRenderer.invoke('drift:setSize', width, height) as Promise<boolean>,
  displays: (): readonly DisplayInfo[] =>
    ipcRenderer.sendSync('drift:displays') as readonly DisplayInfo[],
  onFocusChange: (handler: (focused: boolean) => void): (() => void) => {
    const listener = (_event: unknown, focused: boolean): void => handler(focused);
    ipcRenderer.on('drift:focus', listener);
    return () => {
      ipcRenderer.removeListener('drift:focus', listener);
    };
  },
  onQuitRequest: (handler: () => void): (() => void) => {
    /*
     * **Registering interest is what makes a quit fast for everybody else.** The main process
     * defers a window close only for a game that asked to be told; without this signal the only
     * correct implementation waits a grace period on every close, including for the games that
     * had nothing to say.
     */
    ipcRenderer.send('drift:quitInterest');
    const listener = (): void => handler();
    ipcRenderer.on('drift:quitRequest', listener);
    return () => {
      ipcRenderer.removeListener('drift:quitRequest', listener);
    };
  },
  /* A desktop shell can always close its own window, which is most of the point of having one. */
  canQuit: true,
  requestQuit: (): void => {
    ipcRenderer.send('drift:quit');
  },
  openFile: (accept: readonly string[]): Promise<{ name: string; bytes: Uint8Array } | null> =>
    ipcRenderer.invoke('drift:openFile', accept) as Promise<{
      name: string;
      bytes: Uint8Array;
    } | null>,
  saveFile: (name: string, bytes: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke('drift:saveFile', name, bytes) as Promise<boolean>,
  platform: {
    /* Read once: whether a store answered is decided before the window exists and does not
       change while the game is running. */
    available: ipcRenderer.sendSync('drift:platformAvailable') as boolean,
    unlockAchievement: (id: string): void => {
      ipcRenderer.send('drift:achievement', id);
    },
    setRichPresence: (text: string): void => {
      ipcRenderer.send('drift:presence', text);
    },
  },
};

contextBridge.exposeInMainWorld('__driftHost', bridge);
