/**
 * Put the browser's input event classes on the global a page reads them from, where the runtime
 * has none, and hand back what takes them away again. Node has `Event` and none of these.
 */

import {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  UIEvent,
  WheelEvent,
} from './uiEvents.ts';
import { Touch, TouchEvent, TouchList } from './uiTouch.ts';

/** A pad arriving or leaving, as `gamepadconnected` and `gamepaddisconnected` carry it. */
export class GamepadEvent extends Event {
  readonly gamepad: unknown;
  constructor(type: string, init: EventInit & { gamepad: unknown }) {
    super(type, init);
    this.gamepad = init.gamepad;
  }
}

const CLASSES = {
  UIEvent,
  FocusEvent,
  MouseEvent,
  WheelEvent,
  PointerEvent,
  KeyboardEvent,
  Touch,
  TouchList,
  TouchEvent,
  GamepadEvent,
};

export function installEventClasses(
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
): () => void {
  const added = Object.entries(CLASSES).filter(([name]) => !(name in scope));
  for (const [name, value] of added) scope[name] = value;
  return () => {
    for (const [name] of added) delete scope[name];
  };
}
