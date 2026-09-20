/**
 * Fingers, as a page hears them from Chrome: pointer events of type `touch`, touch events, and the
 * mouse events and click Chrome makes of a tap.
 *
 * **What Chrome sends, measured 2026-09-19 in Chrome 151 over the DevTools protocol** on a page
 * whose canvas filled it, is what this sends:
 * - A finger down is `pointerover`, `pointerenter` at the document and the canvas, `pointerdown`,
 *   then `touchstart`. Fingers are pointers 2, 3 and on, never reused, the first down primary, and
 *   a touch's `identifier` is the lowest one free.
 * - A finger is captured by the canvas when it lands, so `gotpointercapture` comes before its next
 *   event and `lostpointercapture` right after its `pointerup`, then `pointerout`, `pointerleave`
 *   at the canvas and the document, and `touchend`.
 * - A `touchmove` within 15 px of where the finger landed is not sent, unless the `touchstart` was
 *   prevented; 13 px was held back and 17 px sent. A pointer move is always sent.
 * - A tap — one finger, no further than 15 px, neither its `touchstart` nor its `touchend`
 *   prevented — is then a mouse: `mouseover` and `mouseenter` the first time, `mousemove`,
 *   `mousedown`, `mouseup`, and a `click` that is the finger's own pointer event. A second tap
 *   landing within 400 ms of the first's lift and 20 px of it counts two, with a `dblclick`: 340 ms
 *   counted and 380 did not, 20 px counted and 30 did not.
 *
 * **SDL makes a mouse of every finger**, and a finger of the mouse where asked; both are dropped,
 * each already said by the other.
 *
 * What it gives up: SDL reports no contact size, so a finger is a pointer one pixel across; no
 * `touchcancel`, which SDL never reports; and a `touchend` after a move is cancelable here, which
 * Chrome's was not.
 */

import type { NativeCanvas } from './canvas.ts';
import type { MouseWindow } from './mouseEvents.ts';
import type { HostPage } from './page.ts';
import { type ModifierInit, MouseEvent, type PointerInit, PointerEvent } from './uiEvents.ts';
import { Touch, TouchEvent } from './uiTouch.ts';

export interface SdlFinger {
  readonly fingerId: number;
  /** Across the window, from 0 to 1. */
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  /** A finger SDL made of the mouse. */
  readonly mouse?: boolean;
}

interface Finger {
  readonly identifier: number;
  readonly pointerId: number;
  readonly primary: boolean;
  readonly landedAt: number;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  pressure: number;
  /** Past the slop: no longer a tap, and its moves are sent. */
  travelled: boolean;
}

const SLOP_PX = 15;
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 20;

export class TouchModel {
  private readonly fingers = new Map<number, Finger>();
  private nextPointer = 2;
  /** Whether this run of touches may still be a tap: one finger, nothing prevented. */
  private tappable = true;
  private lastTap = { liftedAt: Number.NEGATIVE_INFINITY, x: 0, y: 0, count: 0 };
  /** Whether the mouse Chrome makes of taps is over the canvas yet. */
  private mouseOver = false;

  constructor(
    private readonly window: MouseWindow,
    private readonly page: HostPage,
    private readonly canvas: NativeCanvas,
    private readonly modifiers: () => ModifierInit,
    private readonly now: () => number,
  ) {}

  down(event: SdlFinger): void {
    if (event.mouse === true || this.fingers.has(event.fingerId)) return;
    this.page.noteTouch();
    const taken = new Set([...this.fingers.values()].map((f) => f.identifier));
    let identifier = 0;
    while (taken.has(identifier)) identifier += 1;
    const primary = this.fingers.size === 0;
    /* A second finger down makes the run a gesture of two, which is no tap. */
    this.tappable = primary;
    const x = event.x * this.window.width;
    const y = event.y * this.window.height;
    const finger: Finger = {
      identifier,
      pointerId: this.nextPointer,
      primary,
      landedAt: this.now(),
      startX: x,
      startY: y,
      x,
      y,
      pressure: event.pressure,
      travelled: false,
    };
    this.nextPointer += 1;
    this.fingers.set(event.fingerId, finger);
    const { capture, document } = this.page;
    capture.add(finger.pointerId, () => this.fingers.get(event.fingerId) === finger);
    const init = this.init(finger, 0, 1);
    this.pointer('pointerover', init);
    this.boundary('pointerenter', init, [document, this.canvas]);
    this.pointer('pointerdown', init);
    /* Held by the canvas it landed on, as a browser holds a finger, unless a listener chose. */
    if (!capture.has(this.canvas, finger.pointerId)) capture.set(this.canvas, finger.pointerId);
    if (!this.touch('touchstart', finger)) this.tappable = false;
  }

  move(event: SdlFinger): void {
    const finger = this.fingers.get(event.fingerId);
    if (event.mouse === true || finger === undefined) return;
    finger.x = event.x * this.window.width;
    finger.y = event.y * this.window.height;
    finger.pressure = event.pressure;
    if (Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > SLOP_PX) {
      finger.travelled = true;
    }
    this.pointer('pointermove', this.init(finger, -1, 1));
    /* A move still inside the slop is held back, unless the page took the touch at its start. */
    if (finger.travelled || !this.tappable) this.touch('touchmove', finger);
  }

  up(event: SdlFinger): void {
    const finger = this.fingers.get(event.fingerId);
    if (event.mouse === true || finger === undefined) return;
    finger.x = event.x * this.window.width;
    finger.y = event.y * this.window.height;
    /* A finger lifted is a person's gesture, noted before its events so their listeners may use it. */
    this.page.userActivation.notify();
    /* The pointer's pressure is gone; the touch keeps the force it last had, as Chrome's did. */
    const init: PointerInit = { ...this.init(finger, 0, 0), pressure: 0 };
    this.pointer('pointerup', init);
    this.page.capture.releaseImplicitly(finger.pointerId, init);
    this.pointer('pointerout', init);
    this.boundary('pointerleave', init, [this.canvas, this.page.document]);
    this.fingers.delete(event.fingerId);
    this.page.capture.remove(finger.pointerId);
    const ended = this.touch('touchend', finger);
    if (ended && this.tappable && !finger.travelled && this.fingers.size === 0) this.tap(finger);
  }

  /** The mouse Chrome makes of a tap, and its click. */
  private tap(finger: Finger): void {
    const last = this.lastTap;
    const again =
      finger.landedAt - last.liftedAt <= DOUBLE_TAP_MS &&
      Math.hypot(finger.startX - last.x, finger.startY - last.y) <= DOUBLE_TAP_PX;
    const count = again ? last.count + 1 : 1;
    this.lastTap = { liftedAt: this.now(), x: finger.startX, y: finger.startY, count };
    const at = { ...this.init(finger, -1, 0), clientX: finger.startX, clientY: finger.startY };
    if (!this.mouseOver) {
      this.mouseOver = true;
      this.mouse('mouseover', at);
      this.boundary('mouseenter', at, [this.page.document, this.canvas]);
    }
    this.mouse('mousemove', at);
    const down = this.mouse('mousedown', { ...at, button: 0, buttons: 1, detail: count });
    if (!down.defaultPrevented) this.canvas.focus();
    this.mouse('mouseup', { ...at, button: 0, buttons: 0, detail: count });
    this.canvas.dispatchEvent(
      new PointerEvent('click', {
        ...at,
        button: 0,
        buttons: 0,
        detail: count,
        isPrimary: false,
        bubbles: true,
        cancelable: true,
      }),
    );
    if (count === 2) this.mouse('dblclick', { ...at, button: 0, buttons: 0, detail: count });
  }

  private init(finger: Finger, button: number, buttons: number): PointerInit {
    return {
      clientX: finger.x,
      clientY: finger.y,
      screenX: this.window.x + finger.x,
      screenY: this.window.y + finger.y,
      button,
      buttons,
      pressure: finger.pressure,
      pointerId: finger.pointerId,
      pointerType: 'touch',
      isPrimary: finger.primary,
      ...this.modifiers(),
    };
  }

  private pointer(type: string, init: PointerInit): void {
    this.page.capture.process(init.pointerId ?? 0, init);
    this.canvas.dispatchEvent(new PointerEvent(type, { ...init, bubbles: true, cancelable: true }));
  }

  private mouse(type: string, init: PointerInit): MouseEvent {
    const event = new MouseEvent(type, { ...init, bubbles: true, cancelable: true });
    this.canvas.dispatchEvent(event);
    return event;
  }

  /** An enter or a leave, which does not bubble: sent to each node it crosses, in turn. */
  private boundary(type: string, init: PointerInit, nodes: readonly EventTarget[]): void {
    const Kind = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    for (const node of nodes) node.dispatchEvent(new Kind(type, { ...init, bubbles: false }));
  }

  /** A touch event for `finger`, answering whether it went uncancelled. */
  private touch(type: string, finger: Finger): boolean {
    const touchOf = (f: Finger) =>
      new Touch({
        identifier: f.identifier,
        target: this.canvas,
        clientX: f.x,
        clientY: f.y,
        screenX: this.window.x + f.x,
        screenY: this.window.y + f.y,
        force: f.pressure,
      });
    const all = [...this.fingers.values()].map(touchOf);
    const event = new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: all,
      targetTouches: all,
      changedTouches: [touchOf(finger)],
      ...this.modifiers(),
    });
    this.canvas.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}
