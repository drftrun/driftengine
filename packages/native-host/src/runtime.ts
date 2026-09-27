/**
 * The host, started: a window with a WebGPU device, and around its canvas every global a page
 * expects, installed in the order a page has them.
 *
 * **One start for everything that runs on the host** — a packaged game (`game.ts`) and the engine
 * repository's scene runner and editor runner — so the three cannot come to disagree about what a
 * page has, which is the drift two copies of one setup would be.
 *
 * The order is the part worth reading. **Threads first**, before a game's modules are imported,
 * because the engine's pools decide whether they have a default worker when they load; a page's
 * `Worker` likewise exists before its scripts run. Audio next, then the window and its device, the
 * page, the shell's bridge (`__driftHost`), controllers, and `fetch` for the game's own files.
 *
 * What it gives up: one window per process, which is what a game on a desktop is.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import sdl from '@kmamal/sdl';
import { BRIDGE_KEY } from '@driftengine/package/bridge';

import { type AudioDefaults, installAudio } from './audio.ts';
import type { NativeBridge } from './bridge.ts';
import type { NativeCanvas } from './canvas.ts';
import { errorsOf } from './device.ts';
import { type FrameCall, runFrames } from './frameLoop.ts';
import { hostFetch } from './files.ts';
import { HostGamepads, type JoystickModule, type PadModule } from './gamepads.ts';
import { installGpu, installLocation } from './globals.ts';
import { installImages } from './images.ts';
import { HostPage } from './page.ts';
import { installThreads } from './threads.ts';
import { HostWindow, type PresentMode } from './window.ts';
import type { WindowMode } from './windowMode.ts';

export interface HostOptions {
  readonly title: string;
  /** The canvas, in pixels. */
  readonly width: number;
  readonly height: number;
  /** A window that is never shown, for checks that should not flash on a desktop. */
  readonly hidden?: boolean;
  /** Windowed, borderless or fullscreen, as a packaged game's manifest says; windowed by default. */
  readonly mode?: WindowMode;
  /** Whether a person can resize the window; true by default, as the manifest's default is. */
  readonly resizable?: boolean;
  /** Where the shell's store lives; by default where the desktop shell keeps its own. */
  readonly storePath?: string;
  /** The game's own files, which `fetch` of a relative address reads. */
  readonly publicDir?: string;
  /** `location.search`, for a game that reads its address. */
  readonly query?: string;
  readonly audio?: AudioDefaults;
  /** How frames reach the screen; `fifo` by default. See `HostWindowOptions.presentMode`. */
  readonly presentMode?: PresentMode;
}

export type { FrameCall } from './frameLoop.ts';

export interface RunOptions {
  readonly frames?: number;
  readonly before?: (drawn: number) => void;
  /** Draw, or answer with a promise to be waited for when there is nothing to draw: see `runFrames`. */
  readonly frame?: (call: FrameCall) => void | Promise<void>;
  readonly after?: (call: FrameCall) => void;
}

export interface NativeHost {
  readonly window: HostWindow;
  readonly page: HostPage;
  readonly canvas: NativeCanvas;
  readonly bridge: NativeBridge;
  /**
   * Draw until the window closes, the game asks to quit, or `frames` have been drawn. Each frame
   * calls `before` (where a held clock moves), runs the page's animation frames, calls `frame`,
   * lets the microtasks it queued run, puts the canvas on the screen and calls `after`. Answers how
   * many were drawn.
   */
  run(options?: RunOptions): Promise<number>;
  /** Flush the store and close the window. */
  close(): Promise<void>;
}

/** Where the desktop shell's Electron keeps application data on this platform. */
export function configDirectory(): string {
  if (process.platform === 'win32') {
    return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
}

export function startHost(options: HostOptions): NativeHost {
  installThreads();
  installAudio(options.audio ?? {});
  const window = new HostWindow({
    title: options.title,
    width: options.width,
    height: options.height,
    hidden: options.hidden === true,
    mode: options.mode,
    resizable: options.resizable,
    presentMode: options.presentMode,
  });
  installGpu(window.gpu);
  installLocation(options.query ?? '');
  installImages();
  const page = new HostPage();
  page.install();
  window.connectPage(page);

  let quitting = false;
  const storePath =
    options.storePath ?? join(configDirectory(), 'driftengine-native-host', 'store.json');
  mkdirSync(dirname(storePath), { recursive: true });
  const bridge = window.createBridge(storePath, () => {
    quitting = true;
  });
  (globalThis as Record<string, unknown>)[BRIDGE_KEY] = bridge;
  new HostGamepads(sdl.controller as unknown as PadModule, {
    joysticks: sdl.joystick as unknown as JoystickModule,
    events: page.window,
  }).install();
  if (options.publicDir !== undefined) {
    globalThis.fetch = hostFetch(options.publicDir, globalThis.fetch.bind(globalThis));
  }
  window.canvas.resizeTo(options.width, options.height);

  return {
    window,
    page,
    canvas: window.canvas,
    bridge,
    /* In a browser's order, the microtask checkpoint before the present included: see `frameLoop.ts`. */
    run(run = {}) {
      return runFrames({
        ...run,
        open: () => !window.isClosed && !quitting,
        clock: () => performance.now(),
        animationFrames: (now) => page.runFrame(now),
        errors: () => {
          const context = window.canvas.getContext('webgpu') as GPUCanvasContext;
          const configuration = context.getConfiguration();
          return configuration === null ? null : errorsOf(configuration.device);
        },
        present: () => window.present(),
      });
    },
    async close() {
      bridge.flushSync();
      await window.close();
    },
  };
}
