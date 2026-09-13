import { describe, expect, it, vi } from 'vitest';

import { BrowserDisplay } from './display.ts';

/** A minimal DOM: only what this class touches, so a change to it shows up as a change here. */
function stubDom(options: { fullscreen?: boolean; width?: number; height?: number } = {}): void {
  vi.stubGlobal('document', {
    fullscreenElement: options.fullscreen === true ? {} : null,
    exitFullscreen: vi.fn(async () => undefined),
  });
  vi.stubGlobal('window', {
    innerWidth: options.width ?? 1280,
    innerHeight: options.height ?? 720,
    devicePixelRatio: 2,
    screen: { width: 2560, height: 1440 },
  });
}

describe('BrowserDisplay', () => {
  it('reports not fullscreen when nothing is', () => {
    stubDom();
    const element = { requestFullscreen: vi.fn(async () => undefined) } as unknown as HTMLElement;
    expect(new BrowserDisplay(element).isFullscreen()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reports fullscreen when something is', () => {
    const element = { requestFullscreen: vi.fn(async () => undefined) } as unknown as HTMLElement;
    stubDom({ fullscreen: true });
    expect(new BrowserDisplay(element).isFullscreen()).toBe(true);
    vi.unstubAllGlobals();
  });

  /*
   * A shell reports a real refresh rate; a browser cannot, and must say null rather than 60.
   * A plausible number is what `AGENTS.md` forbids a backend to invent, for the same reason.
   */
  it('answers null for refresh rate rather than guessing', () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    expect(new BrowserDisplay(element).refreshHz).toBeNull();
    vi.unstubAllGlobals();
  });

  it('does not reject when the browser refuses fullscreen', async () => {
    stubDom();
    const element = {
      requestFullscreen: vi.fn(async () => {
        throw new Error('gesture required');
      }),
    } as unknown as HTMLElement;
    await expect(new BrowserDisplay(element).setFullscreen(true)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  /* The two modes a settings screen offers, and the one the browser is in right now. */
  it('reports the window mode it is in', () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    expect(new BrowserDisplay(element).mode()).toBe('windowed');
    vi.unstubAllGlobals();
    stubDom({ fullscreen: true });
    expect(new BrowserDisplay(element).mode()).toBe('fullscreen');
    vi.unstubAllGlobals();
  });

  /*
   * The result is read back rather than assumed, so the stub has to behave like the DOM does:
   * `requestFullscreen` is what puts an element in `document.fullscreenElement`. A stub that
   * only counted the call would pass whether or not the class read anything back, which is the
   * one behaviour worth testing here.
   */
  it('goes fullscreen through setMode, and reports what actually happened', async () => {
    const doc: { fullscreenElement: unknown; exitFullscreen: () => Promise<void> } = {
      fullscreenElement: null,
      exitFullscreen: async () => {
        doc.fullscreenElement = null;
      },
    };
    const element = {
      requestFullscreen: vi.fn(async () => {
        doc.fullscreenElement = element;
      }),
    } as unknown as HTMLElement;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      screen: { width: 800, height: 600 },
    });

    const display = new BrowserDisplay(element);
    expect(await display.setMode('fullscreen')).toBe(true);
    expect(display.mode()).toBe('fullscreen');
    expect(await display.setMode('windowed')).toBe(true);
    expect(display.mode()).toBe('windowed');
    vi.unstubAllGlobals();
  });

  /* A browser that refuses the request outside a gesture must report the refusal, not the ask. */
  it('reports false when the browser refuses to go fullscreen', async () => {
    stubDom();
    const element = {
      requestFullscreen: vi.fn(async () => {
        throw new Error('gesture required');
      }),
    } as unknown as HTMLElement;
    expect(await new BrowserDisplay(element).setMode('fullscreen')).toBe(false);
    vi.unstubAllGlobals();
  });

  /*
   * A browser cannot resize the window it is in — `resizeTo` is refused outside a popup — and a
   * settings screen has to be able to find that out and grey the control rather than offer a
   * resolution list that silently does nothing.
   */
  it('refuses to set a size, because a browser cannot', async () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    expect(await new BrowserDisplay(element).setSize(1920, 1080)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reports the surface it is drawing on', () => {
    stubDom({ width: 1600, height: 900 });
    const element = {} as unknown as HTMLElement;
    expect(new BrowserDisplay(element).size()).toEqual({ width: 1600, height: 900 });
    vi.unstubAllGlobals();
  });

  /*
   * One display rather than none: a browser genuinely knows the screen it is on, and answering
   * with an empty list would make a settings screen say "no displays found" on a machine with
   * one. What it does not know is the refresh rate, which is null for the same reason as above.
   */
  it('reports the one screen it can see, without inventing a refresh rate', () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    const displays = new BrowserDisplay(element).displays();
    expect(displays).toHaveLength(1);
    expect(displays[0]?.width).toBe(2560);
    expect(displays[0]?.refreshHz).toBeNull();
    expect(displays[0]?.primary).toBe(true);
  });
});

/**
 * **Reported from outside 2026-08-28: asking whether a window can be resized meant resizing it.**
 *
 * This interface promises that a call a platform cannot perform answers `false` rather than doing
 * nothing quietly, *so a settings screen can grey the control instead of offering one that does not
 * work* — and `false` from `setSize` was the only way to learn it. `setSize` is the mutator. A
 * screen deciding whether to draw a resolution control at all had to call the thing that changes
 * the window in order to find out whether it may, and the reporter's workaround was exactly that: a
 * no-op probe at boot, `setSize(...size())`, with a paragraph explaining that it is not what it
 * looks like.
 *
 * `refreshHz === null` and `Host.native` both correlate with the answer and neither is it, which
 * this interface says elsewhere about `native` in particular.
 */
describe('whether a resize would work, asked without performing one', () => {
  it('is false in a browser, for the same reason `setSize` is', () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    const display = new BrowserDisplay(element);
    expect(display.canSetSize()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('agrees with what `setSize` actually does', async () => {
    stubDom();
    const element = {} as unknown as HTMLElement;
    const display = new BrowserDisplay(element);
    /* The two must not be able to disagree: a greyed control and a working call, or the reverse,
       are both worse than either being wrong on its own. */
    expect(display.canSetSize()).toBe(await display.setSize(1280, 720));
    vi.unstubAllGlobals();
  });

  it('does not touch the window to answer', () => {
    stubDom();
    const resizeTo = vi.fn();
    vi.stubGlobal('window', {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      screen: { width: 2560, height: 1440 },
      resizeTo,
    });
    const element = { requestFullscreen: vi.fn() } as unknown as HTMLElement;
    new BrowserDisplay(element).canSetSize();
    expect(resizeTo).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
