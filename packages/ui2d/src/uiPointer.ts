/**
 * Who the pointer belongs to, and what a drag is carrying.
 *
 * **Capture is the half without which every slider in the interface is wrong in the same way.** A
 * control being dragged has to keep receiving motion after the pointer leaves its rectangle — that
 * is what dragging *is* — and a framework that routes purely by hit test cannot express it.
 *
 * **A drag records its target as the pointer moves**, rather than hit-testing once at release,
 * because the release position is the only thing a drop handler could otherwise use and a pointer
 * that leaves the window never produces one.
 */
import type { UiNode } from './uiNode.ts';
import { uiHitTest } from './uiFocus.ts';

export interface PointerState {
  /** The node holding the pointer, or null. */
  captured: UiNode | null;
  /** Where a drag began, or null when none is in progress. */
  dragSource: UiNode | null;
  /** The last node the drag was over, excluding the source itself. */
  dragTarget: UiNode | null;
  /** What the drag is carrying. Opaque to this module. */
  dragPayload: string;
}

export function createPointerState(): PointerState {
  return { captured: null, dragSource: null, dragTarget: null, dragPayload: '' };
}

export function capturePointer(state: PointerState, node: UiNode): void {
  state.captured = node;
}

export function releasePointer(state: PointerState): void {
  state.captured = null;
}

/**
 * Who should receive pointer input at this position.
 *
 * A captured node receives it wherever the pointer is, including outside the window. Otherwise it
 * is an ordinary hit test — and while a drag is in progress, the result is remembered as the
 * prospective drop target.
 */
export function pointerTarget(
  state: PointerState,
  root: UiNode,
  x: number,
  y: number,
): UiNode | null {
  if (state.captured !== null) return state.captured;
  const hit = uiHitTest(root, x, y);
  if (state.dragSource !== null) state.dragTarget = hit === state.dragSource ? null : hit;
  return hit;
}

export function beginDrag(state: PointerState, source: UiNode, payload: string): void {
  state.dragSource = source;
  state.dragTarget = null;
  state.dragPayload = payload;
}

/** The node a drop would land on, or null. */
export function dropTarget(state: PointerState): UiNode | null {
  return state.dragTarget;
}

/**
 * Finish a drag and report where it landed. Null when no drag was in progress.
 *
 * A null `target` is an ordinary outcome — a drop on nothing — and is reported rather than
 * suppressed, because a caller often wants to know a drag ended even where it achieved nothing.
 */
export function endDrag(
  state: PointerState,
): { source: UiNode; target: UiNode | null; payload: string } | null {
  const source = state.dragSource;
  if (source === null) return null;
  const result = { source, target: state.dragTarget, payload: state.dragPayload };
  state.dragSource = null;
  state.dragTarget = null;
  state.dragPayload = '';
  return result;
}
