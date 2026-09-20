/**
 * Pointer capture: `setPointerCapture`, `releasePointerCapture` and `hasPointerCapture` on the
 * canvas, and `gotpointercapture` and `lostpointercapture` when it changes.
 *
 * **As the Pointer Events specification processes it, and in the order Chrome sends it** — measured
 * 2026-09-19 in Chrome 151 over the DevTools protocol. A capture asked for is pending, and
 * `hasPointerCapture` already says so; it is taken, and `gotpointercapture` sent, just before that
 * pointer's next event. A pointer's release lets it go at once, so `lostpointercapture` falls
 * between the `mouseup` and the `click`. A mouse with no button down cannot be captured, and the
 * request is dropped without a word; an id that is no pointer is refused as Chrome refuses it.
 *
 * **What capture moves here is when things are told, not where.** A browser retargets a captured
 * pointer's events at the capturing element; this host has one element, which is every target
 * already, and SDL keeps a pressed pointer to the window past its edge.
 */

import type { HostNode } from './domTree.ts';
import { type PointerInit, PointerEvent } from './uiEvents.ts';

export class PointerCapture {
  /** Each pointer a page can capture, and whether it is pressed — in contact, or a button down. */
  private readonly pointers = new Map<number, () => boolean>();
  private readonly pending = new Map<number, HostNode>();
  private readonly current = new Map<number, HostNode>();

  add(pointerId: number, pressed: () => boolean): void {
    this.pointers.set(pointerId, pressed);
  }

  remove(pointerId: number): void {
    this.pointers.delete(pointerId);
    this.pending.delete(pointerId);
    this.current.delete(pointerId);
  }

  set(element: HostNode, pointerId: number): void {
    const pressed = this.pointers.get(pointerId);
    if (pressed === undefined) throw notFound('setPointerCapture');
    if (pressed()) this.pending.set(pointerId, element);
  }

  release(element: HostNode, pointerId: number): void {
    if (!this.pointers.has(pointerId)) throw notFound('releasePointerCapture');
    if (this.pending.get(pointerId) === element) this.pending.delete(pointerId);
  }

  has(element: HostNode, pointerId: number): boolean {
    return this.pending.get(pointerId) === element;
  }

  /** Before a pointer's next event: a change of capture, told with that event's fields. */
  process(pointerId: number, init: PointerInit): void {
    const was = this.current.get(pointerId);
    const now = this.pending.get(pointerId);
    if (was === now) return;
    if (now === undefined) this.current.delete(pointerId);
    else this.current.set(pointerId, now);
    const told = { ...init, pointerId, bubbles: true, cancelable: false };
    was?.dispatchEvent(new PointerEvent('lostpointercapture', told));
    now?.dispatchEvent(new PointerEvent('gotpointercapture', told));
  }

  /** After a pointer's up or cancel: its capture is let go, and told at once. */
  releaseImplicitly(pointerId: number, init: PointerInit): void {
    this.pending.delete(pointerId);
    this.process(pointerId, init);
  }
}

function notFound(method: string): Error {
  const message = `Failed to execute '${method}' on 'Element': No active pointer with the given id is found.`;
  return Object.assign(new Error(message), { name: 'NotFoundError' });
}
