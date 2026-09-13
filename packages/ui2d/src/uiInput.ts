/** Routing: a pointer and a keyboard turned into hover, press, focus and one activation. */

import { uiFocusNext, uiFocusPrevious, uiHitTest } from './uiFocus.ts';
import type { UiNode } from './uiNode.ts';

/**
 * What the router remembers between calls.
 *
 * Held by the caller rather than by the tree, because a tree can be shown in two places — a HUD and
 * an editor preview of the same tree — and each has its own pointer. It is also what makes the
 * router testable without a tree at all.
 */
export interface UiInput {
  hovered: UiNode | null;
  /** The node the pointer went down on, until it comes up again. */
  pressed: UiNode | null;
  focused: UiNode | null;
  /** Whether the pointer was down at the previous call, so an edge can be found. */
  wasDown: boolean;
}

export function createUiInput(): UiInput {
  return { hovered: null, pressed: null, focused: null, wasDown: false };
}

/**
 * Route a pointer. Returns the node this call activated, or `null`.
 *
 * **An activation is a press and a release on the same node**, which is what every pointer
 * convention worth copying does and what lets somebody who has pressed the wrong button slide off
 * it and let go. A release somewhere else clears the press and activates nothing.
 *
 * Press moves focus to the node pressed when that node is focusable, and **leaves focus alone
 * otherwise** — clicking the background should not silently take the keyboard away from a field.
 *
 * Allocates nothing, and is meant to be called once per frame with whatever the pointer is doing.
 */
export function routeUiPointer(
  input: UiInput,
  root: UiNode,
  x: number,
  y: number,
  down: boolean,
): UiNode | null {
  const over = uiHitTest(root, x, y);
  if (input.hovered !== over) {
    if (input.hovered !== null) input.hovered.hovered = false;
    if (over !== null) over.hovered = true;
    input.hovered = over;
  }

  let activated: UiNode | null = null;
  if (down && !input.wasDown) {
    input.pressed = over;
    if (over !== null) {
      over.pressed = true;
      if (over.focusable) setUiFocus(input, over);
    }
  } else if (!down && input.wasDown) {
    if (input.pressed !== null) {
      input.pressed.pressed = false;
      if (input.pressed === over) activated = input.pressed;
    }
    input.pressed = null;
  }
  input.wasDown = down;
  return activated;
}

/** Move focus, clearing whatever had it. `null` focuses nothing. */
export function setUiFocus(input: UiInput, node: UiNode | null): void {
  input.focused = node;
}

/**
 * Route a key. Returns the node it activated, or `null`.
 *
 * Three keys and no more: `Tab` and `Shift+Tab` move focus, `Enter` and `' '` activate what has it.
 * Everything else is the caller's — a text field's own characters, a game's own bindings — and is
 * reported as unhandled by returning `null` so the caller can tell.
 *
 * `key` is a DOM `KeyboardEvent.key`, because that is what a consumer already has and inventing a
 * second spelling of `Tab` would be a table to keep in step.
 */
export function routeUiKey(
  input: UiInput,
  root: UiNode,
  key: string,
  shift = false,
): UiNode | null {
  if (key === 'Tab') {
    setUiFocus(
      input,
      shift ? uiFocusPrevious(root, input.focused) : uiFocusNext(root, input.focused),
    );
    return null;
  }
  if ((key === 'Enter' || key === ' ') && input.focused !== null) return input.focused;
  return null;
}

/**
 * Forget everything, and clear the flags this router set on the tree.
 *
 * For a tree going away or a pointer leaving the window. Without it a node keeps the `hovered` it
 * had when the cursor left, and draws lit for ever.
 */
export function resetUiInput(input: UiInput): void {
  if (input.hovered !== null) input.hovered.hovered = false;
  if (input.pressed !== null) input.pressed.pressed = false;
  input.hovered = null;
  input.pressed = null;
  input.focused = null;
  input.wasDown = false;
}
