import { describe, expect, it, vi } from 'vitest';

import { BrowserLifecycle } from './lifecycle.ts';

describe('BrowserLifecycle', () => {
  it('calls the handler when focus changes, and stops after unsubscribe', () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const lifecycle = new BrowserLifecycle();
    const seen: boolean[] = [];
    const stop = lifecycle.onFocusChange((focused) => seen.push(focused));

    listeners.get('focus')?.();
    listeners.get('blur')?.();
    expect(seen).toEqual([true, false]);

    stop();
    expect(listeners.has('focus')).toBe(false);
    vi.unstubAllGlobals();
  });

  /*
   * The question a settings menu asks before it draws an Exit button. Getting `false` here is what
   * stops a game shipping a button that does nothing in a tab.
   */
  it('says plainly that it cannot quit', () => {
    expect(new BrowserLifecycle().canQuit).toBe(false);
  });

  /*
   * A browser cannot close its own tab. Doing nothing loudly is the honest answer, and it is
   * what makes the shell implementation's version obviously different rather than subtly so.
   */
  it('does not pretend it can quit', () => {
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new BrowserLifecycle().requestQuit();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  /* A handler that is never called must still be unsubscribable, or a caller leaks it. */
  it('hands back an unsubscribe for a quit request nothing will send', () => {
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const stop = new BrowserLifecycle().onQuitRequest(() => undefined);
    expect(() => stop()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
