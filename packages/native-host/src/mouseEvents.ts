/**
 * The mouse, as a page hears it from Chrome: pointer 1, and every event a browser builds around it.
 *
 * **What Chrome sends, measured 2026-09-19 in Chrome 151 over the DevTools protocol**, on a page
 * whose canvas filled it, is what this sends:
 * - Coming in is `pointerover`, `pointerenter` at the document and then the canvas, the same three as
 *   mouse events, and then the move. Going out is the reverse, the canvas before the document.
 * - A press is `pointerdown` then `mousedown`, whose `detail` counts the clicks, and a release is
 *   `pointerup`, `mouseup` and a `click`. The click is a `PointerEvent`, as are `contextmenu` and
 *   `auxclick`, and a second click in time and place is followed by `dblclick`.
 * - The right button opens its context menu on the press, as on Linux.
 * - A second button pressed while one is held is a `pointermove` rather than a `pointerdown`. The
 *   first button's release after that clicks nothing, with a `detail` of 0.
 *
 * **Pointer lock is the cursor hidden and put back in the middle of the window after every move**,
 * the delta being how far it got. `@kmamal/sdl` 0.11 offers no relative mouse mode and reports only
 * where the pointer is, so this is the one way to it; it carries the desktop's acceleration, which a
 * browser's lock without `unadjustedMovement` does too.
 *
 * What it gives up: clicks count by Chromium's own figures, 500 ms between presses and 2 px either
 * way of the first, where Chrome on a desktop that sets its own uses that; a wheel notch is 100
 * pixels, a browser's figure varying by platform; and a drag out of the window stays over the canvas
 * until its release, which is SDL's capture of a held button.
 */

import type { NativeCanvas } from './canvas.ts';
import { sdlCursor } from './canvasStyle.ts';
import type { HostPage } from './page.ts';
import {
  type ModifierInit,
  type MouseInit,
  MouseEvent,
  PointerEvent,
  WheelEvent,
} from './uiEvents.ts';

export interface SdlPointer {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly dx?: number;
  readonly dy?: number;
  readonly flipped?: boolean;
  /** SDL's mouse made from a finger, which the touch events already said. */
  readonly touch?: boolean;
}

/** Where the window is on the screen and how large, and SDL's mouse, which the lock warps. */
export interface MouseWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface EventMouse {
  setPosition(x: number, y: number): void;
  showCursor(show?: boolean): void;
  capture(): void;
  uncapture(): void;
  /** One of SDL's system cursors, by name. */
  setCursor?(cursor: string): void;
}

/** SDL counts buttons from 1: left, middle, right, back, forward. A browser counts from 0. */
const BUTTON = [-1, 0, 1, 2, 3, 4];
/** And `buttons` is a mask in which the right button comes before the middle. */
const BUTTON_BIT = [0, 1, 4, 2, 8, 16];
/** One notch of the wheel, in the pixels `deltaMode` 0 counts in. */
const NOTCH_PX = 100;
const CLICK_MS = 500;
const CLICK_PX = 2;

export class MouseModel {
  private buttons = 0;
  /** The button whose press a release would complete as a click, or −1. */
  private pressed = -1;
  private count = 0;
  private lastPress = { at: Number.NEGATIVE_INFINITY, x: 0, y: 0, button: -1 };
  private x = 0;
  private y = 0;
  private inside = false;
  /** The pointer left while a button held it here, so it leaves once the last one is let go. */
  private away = false;
  private locked = false;
  /** Whether the page hid the cursor, `cursor: none`, which a lock let go does not undo. */
  private cursorHidden = false;

  constructor(
    private readonly window: MouseWindow,
    private readonly mouse: EventMouse,
    private readonly page: HostPage,
    private readonly canvas: NativeCanvas,
    private readonly modifiers: () => ModifierInit,
    private readonly now: () => number,
  ) {
    page.setPointerLocker((lock) => this.lock(lock));
    page.capture.add(1, () => this.buttons !== 0);
  }

  /** The cursor a page wrote to the canvas's style. */
  cursor(css: string): void {
    const cursor = sdlCursor(css);
    const hidden = cursor === null;
    if (hidden !== this.cursorHidden) {
      this.cursorHidden = hidden;
      if (!this.locked) this.mouse.showCursor(!hidden);
    }
    if (cursor !== null) this.mouse.setCursor?.(cursor);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  move(event: SdlPointer): void {
    let dx = event.x - this.x;
    let dy = event.y - this.y;
    if (this.locked) {
      /* The warp back lands as a move to where the pointer already is: nothing moved. */
      if (dx === 0 && dy === 0) return;
      const centre = this.middle();
      this.mouse.setPosition(centre.x, centre.y);
    } else {
      this.x = event.x;
      this.y = event.y;
      if (!this.inside) {
        this.enter();
        dx = 0;
        dy = 0;
      }
    }
    this.both('move', this.init(dx, dy, -1, 0));
  }

  down(event: SdlPointer): void {
    this.settle(event);
    const button = BUTTON[event.button ?? 0] ?? -1;
    const chord = this.buttons !== 0;
    this.buttons |= BUTTON_BIT[event.button ?? 0] ?? 0;
    const at = this.now();
    const last = this.lastPress;
    const again =
      button === last.button &&
      at - last.at <= CLICK_MS &&
      Math.abs(this.x - last.x) <= CLICK_PX &&
      Math.abs(this.y - last.y) <= CLICK_PX;
    this.count = again ? this.count + 1 : 1;
    this.lastPress = { at, x: this.x, y: this.y, button };
    this.pressed = button;
    /* A press is a person's gesture, noted before its events so their listeners may use it. */
    this.page.userActivation.notify();
    const init = this.init(0, 0, button, this.count);
    this.pointer(chord ? 'pointermove' : 'pointerdown', init);
    const mousedown = this.mouseEvent('mousedown', init);
    if (!mousedown.defaultPrevented) this.canvas.focus();
    /* On the press, where Chrome on Linux sends it. */
    if (button === 2) this.pointer('contextmenu', { ...init, detail: 0 }, false);
  }

  up(event: SdlPointer): void {
    this.settle(event);
    const button = BUTTON[event.button ?? 0] ?? -1;
    this.buttons &= ~(BUTTON_BIT[event.button ?? 0] ?? 0);
    const clicked = this.pressed === button;
    const init = this.init(0, 0, button, clicked ? this.count : 0);
    this.pointer(this.buttons !== 0 ? 'pointermove' : 'pointerup', init);
    this.mouseEvent('mouseup', init);
    if (this.buttons === 0) this.page.capture.releaseImplicitly(1, { ...init, ...POINTER(0) });
    if (clicked) {
      this.pointer(button === 0 ? 'click' : 'auxclick', init, false);
      if (button === 0 && this.count === 2) this.mouseEvent('dblclick', init);
    }
    this.pressed = -1;
    const { width, height } = this.window;
    const outside = this.x < 0 || this.y < 0 || this.x >= width || this.y >= height;
    if (this.buttons === 0 && (this.away || outside)) this.leave();
  }

  wheel(event: SdlPointer): void {
    this.settle(event);
    const direction = event.flipped === true ? -1 : 1;
    this.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        ...this.init(0, 0, -1, 0),
        bubbles: true,
        cancelable: true,
        deltaX: (event.dx ?? 0) * direction * NOTCH_PX,
        deltaY: -(event.dy ?? 0) * direction * NOTCH_PX,
        deltaMode: 0,
      }),
    );
  }

  /** SDL's word that the pointer is over the window again, which cancels a leave still waiting. */
  hover(): void {
    this.away = false;
  }

  /** SDL's word that the pointer left the window: out and leave, once no button holds it here. */
  leave(): void {
    if (!this.inside || this.locked) return;
    if (this.buttons !== 0) {
      this.away = true;
      return;
    }
    this.away = false;
    this.inside = false;
    const init = this.init(0, 0, -1, 0);
    this.pointer('pointerout', init);
    this.boundary('pointerleave', init, [this.canvas, this.page.document]);
    this.mouseEvent('mouseout', init);
    this.boundary('mouseleave', init, [this.canvas, this.page.document]);
  }

  /** A press or the wheel where no move came first: the pointer is here, so it came in. */
  private settle(event: SdlPointer): void {
    if (this.locked) return;
    this.x = event.x;
    this.y = event.y;
    if (!this.inside) this.enter();
  }

  private enter(): void {
    this.inside = true;
    const init = this.init(0, 0, -1, 0);
    this.pointer('pointerover', init);
    this.boundary('pointerenter', init, [this.page.document, this.canvas]);
    this.mouseEvent('mouseover', init);
    this.boundary('mouseenter', init, [this.page.document, this.canvas]);
  }

  /** An enter or a leave, which does not bubble: sent to each node it crosses, in turn. */
  private boundary(type: string, init: MouseInit, nodes: readonly EventTarget[]): void {
    const Kind = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const extra = type.startsWith('pointer') ? POINTER(init.buttons ?? 0) : {};
    for (const node of nodes) {
      node.dispatchEvent(new Kind(type, { ...init, ...extra, bubbles: false, cancelable: false }));
    }
  }

  private both(type: string, init: MouseInit): void {
    this.pointer(`pointer${type}`, init);
    this.mouseEvent(`mouse${type}`, init);
  }

  private pointer(type: string, init: MouseInit, primary = true): PointerEvent {
    /* A change of capture is told just before the pointer's next pointer event. */
    if (type.startsWith('pointer')) {
      this.page.capture.process(1, { ...init, ...POINTER(init.buttons ?? 0), isPrimary: true });
    }
    const event = new PointerEvent(type, {
      ...init,
      ...POINTER(init.buttons ?? 0),
      isPrimary: primary,
      detail: type === 'click' || type === 'auxclick' ? (init.detail ?? 0) : 0,
      bubbles: true,
      cancelable: true,
    });
    this.canvas.dispatchEvent(event);
    return event;
  }

  private mouseEvent(type: string, init: MouseInit): MouseEvent {
    const event = new MouseEvent(type, { ...init, bubbles: true, cancelable: true });
    this.canvas.dispatchEvent(event);
    return event;
  }

  private init(movementX: number, movementY: number, button: number, detail: number): MouseInit {
    return {
      clientX: this.x,
      clientY: this.y,
      screenX: this.window.x + this.x,
      screenY: this.window.y + this.y,
      movementX,
      movementY,
      button,
      buttons: this.buttons,
      detail,
      ...this.modifiers(),
    };
  }

  private middle(): { x: number; y: number } {
    return {
      x: Math.round(this.window.x + this.window.width / 2),
      y: Math.round(this.window.y + this.window.height / 2),
    };
  }

  /*
   * Hide the cursor and hold it, or let it go. SDL refuses to capture the mouse for a window without
   * focus, and says so by throwing; that is a refused lock, with the cursor left as it was, and not
   * an error to take the process down from inside a click.
   */
  private lock(lock: boolean): boolean {
    const { mouse } = this;
    if (!lock) {
      this.locked = false;
      /* A release always succeeds from the page's side, whatever SDL says about it. */
      try {
        mouse.showCursor(!this.cursorHidden);
        mouse.uncapture();
      } catch {
        /* Nothing held to let go of. */
      }
      return true;
    }
    try {
      mouse.showCursor(false);
      mouse.capture();
      const centre = this.middle();
      mouse.setPosition(centre.x, centre.y);
      this.x = centre.x - this.window.x;
      this.y = centre.y - this.window.y;
      this.locked = true;
      return true;
    } catch {
      mouse.showCursor(true);
      return false;
    }
  }
}

/** The mouse is pointer 1, always primary, one pixel across, and pressing at half pressure. */
function POINTER(buttons: number) {
  return { pointerId: 1, pointerType: 'mouse', pressure: buttons !== 0 ? 0.5 : 0 };
}
