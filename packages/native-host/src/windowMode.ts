/**
 * The window a packaged game asked for, in SDL's flags: the manifest's `window.mode` and
 * `window.resizable`, which the desktop shell hands to Electron's `BrowserWindow`.
 *
 * **Fullscreen is the desktop's**: `@kmamal/sdl` opens it as `SDL_WINDOW_FULLSCREEN_DESKTOP`,
 * covering the screen at the screen's own resolution, which is what Electron's `fullscreen: true`
 * is. No mode is switched. **Borderless** is a window with no frame, which is Electron's
 * `frame: false`.
 *
 * What it gives up: nothing chooses the display. SDL opens the window on its first display, as
 * Electron does.
 */

export type WindowMode = 'windowed' | 'borderless' | 'fullscreen';

export interface WindowFlags {
  readonly fullscreen: boolean;
  readonly borderless: boolean;
  readonly resizable: boolean;
}

export function sdlWindowFlags(mode: WindowMode = 'windowed', resizable = true): WindowFlags {
  return { fullscreen: mode === 'fullscreen', borderless: mode === 'borderless', resizable };
}
