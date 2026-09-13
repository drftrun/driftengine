import { describe, expect, it, vi } from 'vitest';

import { BrowserScreenPresentation } from './screen.ts';

function stubScreen(
  options: {
    type?: string;
    lock?: () => Promise<void>;
    insets?: Record<string, string>;
    wakeLock?: unknown;
  } = {},
): void {
  const style = new Map(Object.entries(options.insets ?? {}));
  vi.stubGlobal('document', {
    documentElement: {},
    head: { appendChild: vi.fn() },
    createElement: () => ({ setAttribute: vi.fn(), textContent: '' }),
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => style.get(name) ?? '',
  }));
  vi.stubGlobal('window', {
    innerWidth: 400,
    innerHeight: 800,
    screen: {
      orientation:
        options.type === undefined
          ? undefined
          : { type: options.type, lock: options.lock, unlock: vi.fn() },
    },
  });
  vi.stubGlobal('navigator', options.wakeLock === undefined ? {} : { wakeLock: options.wakeLock });
}

describe('BrowserScreenPresentation', () => {
  it('reports the orientation the platform says it is in', () => {
    stubScreen({ type: 'portrait-primary' });
    expect(new BrowserScreenPresentation().orientation()).toBe('portrait');
    vi.unstubAllGlobals();
    stubScreen({ type: 'landscape-secondary' });
    expect(new BrowserScreenPresentation().orientation()).toBe('landscape');
    vi.unstubAllGlobals();
  });

  /*
   * Every desktop browser and iOS Safari report no orientation API at all. Falling back to the
   * shape of the window is right rather than clever: it is the same answer the platform would
   * give, and the alternative is a game that cannot lay itself out on the platform with the
   * most users.
   */
  it('falls back to the shape of the window where there is no orientation API', () => {
    stubScreen({});
    expect(new BrowserScreenPresentation().orientation()).toBe('portrait');
    vi.unstubAllGlobals();
  });

  it('locks the orientation when the platform allows it', async () => {
    const lock = vi.fn(async () => undefined);
    stubScreen({ type: 'portrait-primary', lock });
    expect(await new BrowserScreenPresentation().lockOrientation('landscape')).toBe(true);
    expect(lock).toHaveBeenCalledWith('landscape');
    vi.unstubAllGlobals();
  });

  /*
   * iOS refuses this outright and Android refuses it outside fullscreen. A game has to be able
   * to find that out, because the alternative to knowing is a layout built for one orientation
   * on a device that will happily rotate out of it.
   */
  it('reports the refusal rather than swallowing it', async () => {
    stubScreen({
      type: 'portrait-primary',
      lock: async () => {
        throw new Error('not available on this device');
      },
    });
    expect(await new BrowserScreenPresentation().lockOrientation('landscape')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reads the safe area the platform reserves', () => {
    stubScreen({
      insets: {
        '--drift-safe-top': '44px',
        '--drift-safe-right': '0px',
        '--drift-safe-bottom': '34px',
        '--drift-safe-left': '0px',
      },
    });
    expect(new BrowserScreenPresentation().safeArea()).toEqual({
      top: 44,
      right: 0,
      bottom: 34,
      left: 0,
    });
    vi.unstubAllGlobals();
  });

  /* A platform with no notch reserves nothing, and that is zero rather than unknown. */
  it('reads zeroes where nothing is reserved', () => {
    stubScreen({});
    expect(new BrowserScreenPresentation().safeArea()).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    vi.unstubAllGlobals();
  });

  it('reports false for a wake lock the browser does not have', async () => {
    stubScreen({});
    expect(await new BrowserScreenPresentation().keepAwake(true)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('holds a wake lock and releases it again', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release }));
    stubScreen({ wakeLock: { request } });
    const presentation = new BrowserScreenPresentation();
    expect(await presentation.keepAwake(true)).toBe(true);
    expect(request).toHaveBeenCalledWith('screen');
    expect(await presentation.keepAwake(false)).toBe(true);
    expect(release).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
