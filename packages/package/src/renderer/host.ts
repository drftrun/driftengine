import {
  BrowserDisplay,
  BrowserFileDialogs,
  BrowserLifecycle,
  BrowserScreenPresentation,
  BrowserStore,
} from '@driftengine/core';
import type {
  DisplayControl,
  FileDialogs,
  KeyValueStore,
  Lifecycle,
  PlatformServices,
  ScreenPresentation,
} from '@driftengine/core';

import { showDeviceReport } from '../mobile/report.ts';
import { FileStore } from './fileStore.ts';
import {
  NativeDisplay,
  NativeFileDialogs,
  NativeLifecycle,
  NativePlatformServices,
  hostBridge,
} from './nativeHost.ts';

/**
 * Every capability the engine takes, chosen for wherever this build is running.
 *
 * **One call, at boot, and no platform test anywhere else.** A game shipped to a browser and
 * packaged for a desktop is one bundle; the difference between them is which objects these five
 * fields hold, and finding that out is this function's job rather than a game's. What a game
 * writes against is the interfaces — so its own settings menu calls `display.setMode`,
 * `display.setSize` and `display.displays()` the same way in both, and reads `false` from the ones
 * a browser genuinely cannot do rather than discovering nothing happened.
 *
 * ```ts
 * const host = createHost(canvas);
 * const { renderer } = await createRenderer(canvas, quality);
 * const settings = loadPreferences(host.store, SCHEMA);
 * await host.display.setMode(settings.fullscreen ? 'fullscreen' : 'windowed');
 * ```
 *
 * **`screen` is the browser implementation on every platform including the shell**, and that is
 * not an omission: orientation, safe-area insets and the wake lock are answered by Chromium
 * itself, so a native override would be a second implementation of the same answers. A phone host
 * supplies its own where the WebView cannot answer — see the mobile plan.
 *
 * **`native` is for telling somebody**, not for branching: a build badge, a bug report, a
 * "restart required" line. A game that branches on it is doing what this function exists to
 * prevent.
 */
export interface Host {
  /** Whether a shell supplied these, rather than the browser. */
  readonly native: boolean;
  readonly display: DisplayControl;
  readonly lifecycle: Lifecycle;
  readonly files: FileDialogs;
  readonly store: KeyValueStore;
  readonly screen: ScreenPresentation;
  /**
   * A store's own features, or null where there is no store.
   *
   * Null in a browser, null in a shell whose manifest named no app, and null when the copy was
   * launched outside the store — a game checks once and never calls it, rather than calling into
   * something that quietly does nothing.
   */
  readonly services: PlatformServices | null;
}

export function createHost(surface: HTMLElement): Host {
  /* `?report=1` draws what the device says about itself over the game, on every platform. It is
     how a shader that compiles here and not on a phone gets attributed to a WebView build. */
  showDeviceReport();
  const bridge = hostBridge();
  if (bridge === null) {
    return {
      native: false,
      display: new BrowserDisplay(surface),
      lifecycle: new BrowserLifecycle(),
      files: new BrowserFileDialogs(),
      store: new BrowserStore(),
      screen: new BrowserScreenPresentation(),
      services: null,
    };
  }
  return {
    native: true,
    display: new NativeDisplay(bridge),
    lifecycle: new NativeLifecycle(bridge),
    files: new NativeFileDialogs(bridge),
    store: new FileStore(bridge),
    screen: new BrowserScreenPresentation(),
    services: bridge.platform.available ? new NativePlatformServices(bridge) : null,
  };
}
