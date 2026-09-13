/**
 * Focus, and the end of the process.
 *
 * The engine needs to know when it stopped being looked at — a paused simulation, a muted mixer —
 * and a shell additionally needs to be told to close. **A browser cannot close its own tab**, so
 * `requestQuit` warns rather than silently doing nothing: a silent no-op reads as a working call,
 * which is the failure `AGENTS.md` names where an unimplemented capability returns a plausible
 * answer instead of a defined one.
 *
 * Every subscription returns its own unsubscribe. Nothing here is called per frame.
 */
export interface Lifecycle {
  /**
   * Whether `requestQuit` will actually end the process.
   *
   * **This is what an exit button should be drawn from.** A browser cannot close its own tab and
   * iOS applications do not exit programmatically, so a menu that always shows Exit has a button
   * that does nothing on two of the platforms a game ships to — and a game that instead branches
   * on "am I in a shell" has hard-coded an assumption that stops being true. Ask the capability.
   */
  readonly canQuit: boolean;
  onFocusChange(handler: (focused: boolean) => void): () => void;
  /**
   * The shell is closing and the game may finish what it is doing.
   *
   * A shell calls the handler on a window-close request and waits; a browser never calls it,
   * because a tab closing gives nothing that can be waited on.
   */
  onQuitRequest(handler: () => void): () => void;
  requestQuit(): void;
}

export class BrowserLifecycle implements Lifecycle {
  /** False: no page may close the tab it is in. An exit button here is a button that lies. */
  readonly canQuit = false;

  onFocusChange(handler: (focused: boolean) => void): () => void {
    const focused = (): void => handler(true);
    const blurred = (): void => handler(false);
    window.addEventListener('focus', focused);
    window.addEventListener('blur', blurred);
    return () => {
      window.removeEventListener('focus', focused);
      window.removeEventListener('blur', blurred);
    };
  }

  /**
   * A browser is never asked to quit, so this handler is never called here.
   *
   * The unsubscribe is real rather than the handler being rejected: a consumer registers the
   * same handler on both platforms and must be able to drop it on both, and code that has to
   * ask which platform it is on has lost the point of the seam.
   */
  onQuitRequest(handler: () => void): () => void {
    void handler;
    return () => undefined;
  }

  requestQuit(): void {
    console.warn('[driftengine] requestQuit: a browser cannot close its own tab; a shell can');
  }
}
