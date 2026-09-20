/**
 * What changed since last frame, and therefore what has to be redrawn.
 *
 * An editor is idle most of the time. A framework that redraws the whole window every frame
 * because a caret is blinking keeps a laptop fan running, which is the difference between a tool
 * somebody uses all day and one they close.
 *
 * **A node that became hidden marks where it used to be.** That is the bug every dirty-rectangle
 * implementation ships with first: the thing that disappeared leaves its pixels behind, because
 * nothing thought to dirty a rectangle belonging to a node that is no longer drawn.
 *
 * **Keyed by traversal index, with the node identity checked.** A tree that changed shape makes
 * every index past the change compare against a different node, which reports dirty — conservative
 * and correct. A map keyed by node would be exact and would allocate on the frame path.
 *
 * **One union rather than a list of rectangles.** A union over-draws and is right; a list needs
 * merging logic that is itself a source of defects, and an editor's redraws are overwhelmingly one
 * panel anyway.
 */
import type { UiNode, UiRect } from './uiNode.ts';

export interface DirtyTracker {
  /** The node seen at each traversal index last frame. */
  nodes: (UiNode | null)[];
  /** Six numbers per index: x, y, w, h, and the visual state packed into two. */
  state: Float64Array;
  /** How many indices the previous walk filled. */
  count: number;
  /** The union of everything marked this frame, and whether anything was. */
  x: number;
  y: number;
  w: number;
  h: number;
  any: boolean;
}

const STRIDE = 6;

export function createDirtyTracker(capacity: number): DirtyTracker {
  return {
    nodes: Array.from({ length: capacity }, () => null),
    state: new Float64Array(capacity * STRIDE),
    count: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    any: false,
  };
}

export function clearDirty(tracker: DirtyTracker): void {
  tracker.any = false;
  tracker.x = 0;
  tracker.y = 0;
  tracker.w = 0;
  tracker.h = 0;
}

/** Union `rect` into what must be redrawn. A zero-area rectangle still counts as a change. */
export function markDirty(tracker: DirtyTracker, rect: UiRect): void {
  if (!tracker.any) {
    tracker.x = rect.x;
    tracker.y = rect.y;
    tracker.w = rect.w;
    tracker.h = rect.h;
    tracker.any = true;
    return;
  }
  const left = Math.min(tracker.x, rect.x);
  const top = Math.min(tracker.y, rect.y);
  const right = Math.max(tracker.x + tracker.w, rect.x + rect.w);
  const bottom = Math.max(tracker.y + tracker.h, rect.y + rect.h);
  tracker.x = left;
  tracker.y = top;
  tracker.w = right - left;
  tracker.h = bottom - top;
}

/** The union of everything marked. Returns false when nothing was. */
export function dirtyBounds(tracker: DirtyTracker, out: UiRect): boolean {
  out.x = tracker.x;
  out.y = tracker.y;
  out.w = tracker.w;
  out.h = tracker.h;
  return tracker.any;
}

/** Visual state that changes pixels, packed so one comparison covers all of it. */
function visualOf(node: UiNode): number {
  return (
    (node.hidden ? 1 : 0) |
    (node.hovered ? 2 : 0) |
    (node.pressed ? 4 : 0) |
    ((node.texture + 1) * 8)
  );
}

const SCRATCH: UiRect = { x: 0, y: 0, w: 0, h: 0 };

function visit(tracker: DirtyTracker, node: UiNode, at: number): number {
  const base = at * STRIDE;
  const previous = tracker.nodes[at] ?? null;
  const visual = visualOf(node);
  const textHash = node.text.length;

  const moved =
    previous !== node ||
    tracker.state[base] !== node.rect.x ||
    tracker.state[base + 1] !== node.rect.y ||
    tracker.state[base + 2] !== node.rect.w ||
    tracker.state[base + 3] !== node.rect.h ||
    tracker.state[base + 4] !== visual ||
    tracker.state[base + 5] !== textHash;

  if (moved) {
    /* Where it was, so a node that moved or vanished does not leave its pixels behind. */
    if (previous !== null) {
      SCRATCH.x = tracker.state[base] ?? 0;
      SCRATCH.y = tracker.state[base + 1] ?? 0;
      SCRATCH.w = tracker.state[base + 2] ?? 0;
      SCRATCH.h = tracker.state[base + 3] ?? 0;
      markDirty(tracker, SCRATCH);
    }
    if (!node.hidden) markDirty(tracker, node.rect);
  }

  tracker.nodes[at] = node;
  tracker.state[base] = node.rect.x;
  tracker.state[base + 1] = node.rect.y;
  tracker.state[base + 2] = node.rect.w;
  tracker.state[base + 3] = node.rect.h;
  tracker.state[base + 4] = visual;
  tracker.state[base + 5] = textHash;

  let next = at + 1;
  for (const child of node.children) next = visit(tracker, child, next);
  return next;
}

/**
 * Compare the tree against last frame and mark what changed.
 *
 * Walks hidden nodes too, because a node that just became hidden is exactly the one whose previous
 * rectangle has to be marked.
 */
export function diffTree(tracker: DirtyTracker, root: UiNode): boolean {
  clearDirty(tracker);
  const count = visit(tracker, root, 0);
  /* A node that existed last frame and is gone now: its rectangle must be repainted. */
  for (let at = count; at < tracker.count; at += 1) {
    const previous = tracker.nodes[at];
    if (previous === null || previous === undefined) continue;
    const base = at * STRIDE;
    SCRATCH.x = tracker.state[base] ?? 0;
    SCRATCH.y = tracker.state[base + 1] ?? 0;
    SCRATCH.w = tracker.state[base + 2] ?? 0;
    SCRATCH.h = tracker.state[base + 3] ?? 0;
    markDirty(tracker, SCRATCH);
    tracker.nodes[at] = null;
  }
  tracker.count = count;
  return tracker.any;
}
