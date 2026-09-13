import type {
  DisplayControl,
  DisplayInfo,
  FileDialogs,
  Lifecycle,
  OpenedFile,
  PlatformServices,
  WindowMode,
} from '@driftengine/core';

import { BRIDGE_KEY } from '../preload/bridge.ts';
import type { DriftHostBridge } from '../preload/bridge.ts';

/**
 * The engine's capability interfaces, implemented over the shell's one bridge.
 *
 * Each of these is the native half of a pair whose browser half ships in the engine. The pairs
 * differ in exactly the places a browser cannot answer honestly: a refresh rate is a number here
 * and null there, and quitting works here and warns there.
 *
 * **A game is one bundle.** `hostBridge()` answers null in a plain browser rather than throwing,
 * so a consumer picks its implementations at boot and ships the same code to both.
 */
export function hostBridge(): DriftHostBridge | null {
  const found = (globalThis as Record<string, unknown>)[BRIDGE_KEY];
  return found === undefined || found === null ? null : (found as DriftHostBridge);
}

/**
 * The video half of a settings screen, on a platform that can actually answer it.
 *
 * Every member here is the same call the browser implementation makes and refuses. That is the
 * point of the pair: a game writes one settings screen against `DisplayControl`, and it is fully
 * populated in a shell and honestly degraded in a tab — a resolution list that reports `false`
 * from `setSize` is a control the game greys out rather than one that silently does nothing.
 */
export class NativeDisplay implements DisplayControl {
  constructor(private readonly bridge: DriftHostBridge) {}

  /**
   * A real number, which is the whole reason the browser implementation returns null.
   *
   * Read on each access rather than captured in the constructor: a window moved to another
   * monitor changes it, and a value from boot would be the previous monitor's.
   */
  get refreshHz(): number | null {
    return this.bridge.refreshHz();
  }

  isFullscreen(): boolean {
    return this.bridge.isFullscreen();
  }

  async setFullscreen(on: boolean): Promise<void> {
    await this.bridge.setFullscreen(on);
  }

  mode(): WindowMode {
    return this.bridge.mode();
  }

  async setMode(mode: WindowMode): Promise<boolean> {
    return this.bridge.setMode(mode);
  }

  size(): { readonly width: number; readonly height: number } {
    return this.bridge.size();
  }

  /**
   * The question, asked without performing the resize.
   *
   * The shell decides it with the same function that decides whether `setSize` refuses, so the two
   * cannot disagree — see `main/ipc.ts`. Before this existed the only way to learn the answer was
   * to call `setSize`, and a consumer's settings screen probed it at boot by resizing the window to
   * the size it already had.
   */
  canSetSize(): boolean {
    return this.bridge.canSetSize();
  }

  async setSize(width: number, height: number): Promise<boolean> {
    return this.bridge.setSize(width, height);
  }

  displays(): readonly DisplayInfo[] {
    return this.bridge.displays();
  }
}

export class NativeLifecycle implements Lifecycle {
  constructor(private readonly bridge: DriftHostBridge) {}

  /** What the shell says, rather than what a desktop assumes: an iOS host answers false. */
  get canQuit(): boolean {
    return this.bridge.canQuit;
  }

  onFocusChange(handler: (focused: boolean) => void): () => void {
    return this.bridge.onFocusChange(handler);
  }

  onQuitRequest(handler: () => void): () => void {
    return this.bridge.onQuitRequest(handler);
  }

  requestQuit(): void {
    this.bridge.requestQuit();
  }
}

export class NativeFileDialogs implements FileDialogs {
  constructor(private readonly bridge: DriftHostBridge) {}

  async openFile(accept: readonly string[]): Promise<OpenedFile | null> {
    const picked = await this.bridge.openFile(accept);
    return picked === null ? null : { name: picked.name, bytes: picked.bytes };
  }

  async saveFile(name: string, bytes: Uint8Array): Promise<boolean> {
    return this.bridge.saveFile(name, bytes);
  }
}

/**
 * A store's achievements and presence, over the bridge.
 *
 * **Only created where a store answered.** `createHost` returns `null` for `services` otherwise,
 * which is the same shape the engine's own interface has: there is no browser implementation of
 * `PlatformServices` because there is nothing honest for one to do, and a game that gets null
 * simply never calls it.
 *
 * Neither method reports failure, deliberately. An achievement that does not unlock is not a
 * reason for a frame to stop, and a store that is offline is an ordinary state.
 */
export class NativePlatformServices implements PlatformServices {
  constructor(private readonly bridge: DriftHostBridge) {}

  unlockAchievement(id: string): void {
    this.bridge.platform.unlockAchievement(id);
  }

  setRichPresence(text: string): void {
    this.bridge.platform.setRichPresence(text);
  }
}
