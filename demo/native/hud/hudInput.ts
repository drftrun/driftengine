/**
 * A pointer on the native window, routed to the HUD first and to the scene's camera only when the
 * HUD does not want it.
 *
 * **Bound once, before any scene binds its camera**, and that order is the whole mechanism: the
 * host dispatches listeners in the order they were added, so this sees every pointer first and
 * stops the ones that land on a control. A press that starts on the HUD belongs to it until it is
 * let go — a drag along the timeline never turns the camera, even when it strays off the track —
 * and a press anywhere else is the scene's, with only hover tracked on the way past.
 *
 * `ui2d` decides what is under the pointer and what counts as a click: a press and a release on
 * the same control, so a person can slide off a wrong button and let go.
 */

import {
  createUiInput,
  resetUiInput,
  routeUiPointer,
  uiHitTest,
} from '../../../packages/ui2d/src/index.ts';
import type { UiNode } from '../../../packages/ui2d/src/index.ts';

import type { HudTree } from './hudTree.ts';

export interface HudActions {
  toggleMenu(): void;
  closeMenu(): void;
  pick(index: number): void;
  playPause(): void;
  stop(): void;
  /** Where along the timeline or the reveal, 0 to 1. */
  seek(fraction: number): void;
  reveal(fraction: number): void;
}

/** Route `target`'s pointer to `tree`, and hand back what unbinds it. */
export function bindHudInput(target: EventTarget, tree: HudTree, actions: HudActions): () => void {
  const input = createUiInput();
  /* Whether the press under way began on the HUD, and the track it is dragging, if any. */
  let owned = false;
  let dragging: UiNode | null = null;

  const slide = (node: UiNode, x: number): void => {
    const fraction = Math.max(0, Math.min(1, (x - node.rect.x) / Math.max(node.rect.w, 1)));
    if (node === tree.timeline) actions.seek(fraction);
    else actions.reveal(fraction);
  };

  const act = (node: UiNode): void => {
    if (node.name === 'menu-button') actions.toggleMenu();
    else if (node.name === 'play') actions.playPause();
    else if (node.name === 'stop') actions.stop();
    else if (node.name.startsWith('scene:')) {
      actions.closeMenu();
      actions.pick(Number(node.name.slice('scene:'.length)));
    }
  };

  const down = (event: Event): void => {
    const e = event as PointerEvent;
    const hit = uiHitTest(tree.root, e.offsetX, e.offsetY);
    if (hit === null) {
      /* A press outside an open menu closes it, and is still the scene's. */
      if (!tree.menu.hidden) actions.closeMenu();
      return;
    }
    owned = true;
    e.stopImmediatePropagation();
    routeUiPointer(input, tree.root, e.offsetX, e.offsetY, true);
    if (hit === tree.timeline || hit === tree.revealTrack) {
      dragging = hit;
      slide(hit, e.offsetX);
    }
  };

  const move = (event: Event): void => {
    const e = event as PointerEvent;
    routeUiPointer(input, tree.root, e.offsetX, e.offsetY, owned);
    if (dragging !== null) slide(dragging, e.offsetX);
    if (owned) e.stopImmediatePropagation();
  };

  const up = (event: Event): void => {
    const e = event as PointerEvent;
    const activated = routeUiPointer(input, tree.root, e.offsetX, e.offsetY, false);
    if (!owned) return;
    owned = false;
    dragging = null;
    e.stopImmediatePropagation();
    if (activated !== null) act(activated);
  };

  /* A wheel or a double click on a control is the control's, not a zoom or a camera release. */
  const onControl = (event: Event): void => {
    const e = event as MouseEvent;
    if (uiHitTest(tree.root, e.offsetX, e.offsetY) !== null) e.stopImmediatePropagation();
  };

  const bindings: [string, (event: Event) => void][] = [
    ['pointerdown', down],
    ['pointermove', move],
    ['pointerup', up],
    ['wheel', onControl],
    ['dblclick', onControl],
  ];
  for (const [type, listener] of bindings) target.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of bindings) target.removeEventListener(type, listener);
    resetUiInput(input);
  };
}
