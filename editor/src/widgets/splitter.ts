/**
 * A draggable divider between two panes.
 *
 * **The stored ratio is the one the person chose, and a minimum is applied at the last moment.**
 * Storing the clamped ratio is the tempting version and it loses the setting: narrow the window
 * until a minimum bites, widen it again, and the pane comes back at the minimum's proportion
 * instead of where it was put. Over a session of resizing the panel walks across the screen, and
 * nobody can say what moved it.
 *
 * **Capture is what makes a splitter usable at all.** A divider is six pixels wide and a hand is
 * not that steady, so a drag leaves it immediately — and under routing by hit test the motion then
 * stops arriving. The pointer is held from press to release, which is `capturePointer`'s whole
 * reason for existing.
 */
import { capturePointer, createUiNode, releasePointer, uiRectHolds } from '@driftengine/ui2d';
import type { PointerState, UiNode } from '@driftengine/ui2d';

/** Which way the divider slides: `x` for panes side by side, `y` for one above the other. */
export type SplitterAxis = 'x' | 'y';

export interface SplitterOptions {
  readonly axis?: SplitterAxis;
  /** Share of the *pane* space given to the first pane, before any minimum is applied. */
  readonly ratio?: number;
  readonly thickness?: number;
  readonly minFirst?: number;
  readonly minSecond?: number;
  readonly name?: string;
}

export interface Splitter {
  readonly node: UiNode;
  readonly axis: SplitterAxis;
  /** What the person chose. Never written by a clamp. */
  ratio: number;
  thickness: number;
  minFirst: number;
  minSecond: number;
  dragging: boolean;
  /** Where along the axis the press landed, and what the ratio was then. */
  dragFrom: number;
  dragRatio: number;
}

export interface SplitterSizes {
  first: number;
  second: number;
}

export function createSplitter(options: SplitterOptions = {}): Splitter {
  const axis = options.axis ?? 'x';
  const thickness = options.thickness ?? 6;
  return {
    node: createUiNode({
      width: axis === 'x' ? thickness : 'grow',
      height: axis === 'x' ? 'grow' : thickness,
      interactive: true,
      name: options.name ?? '',
    }),
    axis,
    ratio: options.ratio ?? 0.5,
    thickness,
    minFirst: options.minFirst ?? 0,
    minSecond: options.minSecond ?? 0,
    dragging: false,
    dragFrom: 0,
    dragRatio: 0,
  };
}

/**
 * How the two panes divide `extent`, with the handle's own thickness taken out first.
 *
 * **When neither minimum can be met there is no correct answer, so there is a stated one**: each
 * pane takes its share of what there is, in proportion to what it asked for. The alternatives are a
 * pane of zero, which cannot be seen, and a negative one, which inverts the layout — and both are
 * reached by a window the person is still dragging, so neither is rare.
 */
export function splitterSizes(splitter: Splitter, extent: number): SplitterSizes {
  const panes = Math.max(0, extent - splitter.thickness);
  if (panes <= 0) return { first: 0, second: 0 };

  const min1 = splitter.minFirst;
  const min2 = splitter.minSecond;
  if (min1 + min2 > panes) {
    const total = min1 + min2;
    const first = total <= 0 ? panes / 2 : (panes * min1) / total;
    return { first, second: panes - first };
  }

  const wanted = splitter.ratio * panes;
  const first = Math.min(panes - min2, Math.max(min1, wanted));
  return { first, second: panes - first };
}

/**
 * Route one pointer event. Returns true while a drag is in progress.
 *
 * `extent` is the space the two panes and the handle share, which the caller owns because only the
 * caller knows what the splitter was laid out inside.
 */
export function routeSplitterPointer(
  splitter: Splitter,
  pointer: PointerState,
  phase: 'down' | 'move' | 'up',
  x: number,
  y: number,
  extent: number,
): boolean {
  const along = splitter.axis === 'x' ? x : y;

  if (phase === 'down') {
    if (!uiRectHolds(splitter.node, x, y)) return false;
    splitter.dragging = true;
    splitter.dragFrom = along;
    splitter.dragRatio = splitter.ratio;
    capturePointer(pointer, splitter.node);
    return true;
  }

  if (!splitter.dragging) return false;

  /*
   * Moved by the delta since the press rather than set to the pointer's absolute position, so the
   * divider does not jump to centre itself under the cursor on the first pixel of movement. The
   * grab point is kept for the whole drag.
   */
  const panes = Math.max(1, extent - splitter.thickness);
  const moved = (along - splitter.dragFrom) / panes;
  splitter.ratio = Math.min(1, Math.max(0, splitter.dragRatio + moved));

  if (phase === 'move') return true;
  splitter.dragging = false;
  releasePointer(pointer);
  return false;
}
