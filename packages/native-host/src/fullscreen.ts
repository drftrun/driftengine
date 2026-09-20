/**
 * The Fullscreen API over the host's window: `requestFullscreen` on the canvas, `exitFullscreen`
 * and `fullscreenElement` on the document, and `fullscreenchange` and `fullscreenerror` heard
 * there, as a page expects them.
 *
 * **Chrome's refusals, word for word, measured 2026-09-19 in Chrome 151**: a request with no
 * gesture is `TypeError: Permissions check failed`, and leaving when nothing is fullscreen is
 * `TypeError: Failed to execute 'exitFullscreen' on 'Document': Document not active`. A granted
 * request spends the gesture (`activation.ts`).
 *
 * **Element fullscreen is the window's fullscreen.** The canvas fills the window, so the window is
 * what goes fullscreen, through SDL; and when anything else takes the window out — the shell's
 * bridge, the window manager, Escape — the element leaves with it and the page is told.
 *
 * What it gives up: the change is heard as soon as SDL is asked, rather than on the frame after the
 * window has been resized, which is when Chrome sends it.
 */

import type { UserActivation } from './activation.ts';
import type { NativeCanvas } from './canvas.ts';

export class PageFullscreen {
  element: NativeCanvas | null = null;
  /** The platform's half: put the window in fullscreen or take it out, false when it cannot. */
  setter: ((on: boolean) => boolean) | null = null;
  /** Told after each change, for what reads it: `(display-mode: fullscreen)`. */
  changed: () => void = () => undefined;

  constructor(private readonly activation: UserActivation) {}

  request(canvas: NativeCanvas): Promise<void> {
    if (!this.activation.isActive) {
      return this.refuse(canvas, new TypeError('Permissions check failed'));
    }
    this.activation.consume();
    if (this.element === canvas) return Promise.resolve();
    if (this.setter === null || !this.setter(true)) {
      return this.refuse(canvas, new TypeError('Fullscreen request denied'));
    }
    this.element = canvas;
    canvas.dispatchEvent(new Event('fullscreenchange', { bubbles: true, composed: true }));
    this.changed();
    return Promise.resolve();
  }

  exit(): Promise<void> {
    const element = this.element;
    if (element === null) {
      return Promise.reject(
        new TypeError("Failed to execute 'exitFullscreen' on 'Document': Document not active"),
      );
    }
    this.setter?.(false);
    this.lost();
    return Promise.resolve();
  }

  /** The window is no longer fullscreen, whoever took it out, so neither is the element. */
  lost(): void {
    const element = this.element;
    if (element === null) return;
    this.element = null;
    element.dispatchEvent(new Event('fullscreenchange', { bubbles: true, composed: true }));
    this.changed();
  }

  private refuse(canvas: NativeCanvas, error: TypeError): Promise<void> {
    canvas.dispatchEvent(new Event('fullscreenerror', { bubbles: true, composed: true }));
    return Promise.reject(error);
  }
}
