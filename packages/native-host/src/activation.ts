/**
 * Whether a person has just done something, as a browser's transient activation answers it — the
 * gate on what a page may do only in answer to a person: pointer lock, fullscreen.
 *
 * **Chrome's rules, measured 2026-09-19 in Chrome 151 over the DevTools protocol.** A key down
 * other than Escape, a mouse press or a finger lifted makes a page active for five seconds: a
 * request 4.5 s after an unused click was granted and one at 5.5 s refused. Fullscreen spends it —
 * a second request 100 ms after a granted one was refused — and pointer lock does not: a lock and
 * then fullscreen from one click were both granted. The input is noted before its event is sent,
 * so a listener for that very event may already ask.
 *
 * What it gives up: a script's own `dispatchEvent` is never a gesture, as in a browser, so input a
 * capture replays goes through SDL's events (`HostWindow.replay`) to count as one.
 */

const ACTIVE_MS = 5000;

export class UserActivation {
  private at = Number.NEGATIVE_INFINITY;
  private ever = false;

  constructor(private readonly now: () => number) {}

  /** A person did something: a key down, a mouse press, a finger lifted. */
  notify(): void {
    this.at = this.now();
    this.ever = true;
  }

  /** Spent, by an ask that takes the gesture with it. */
  consume(): void {
    this.at = Number.NEGATIVE_INFINITY;
  }

  get isActive(): boolean {
    return this.now() - this.at < ACTIVE_MS;
  }

  get hasBeenActive(): boolean {
    return this.ever;
  }
}
