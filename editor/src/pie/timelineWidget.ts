/**
 * There is a slider, and it is the whole of what this capability cost.
 *
 * Play, pause, step and scrub back to any recorded frame — the thing no competing engine offers —
 * reaches a person as a track with a handle on it. Everything underneath was already here:
 * snapshots, a deterministic step, an input log, a fingerprint per frame. **The reason nobody else
 * has this widget is not that the widget is hard. It is that none of them can put the world back.**
 *
 * **It holds no timer and reads no clock.** Not a style preference: the editor has to run under a
 * host with no browser, so anything that reached for `requestAnimationFrame` would be a piece of
 * the editor that had to be rewritten rather than re-hosted. Time comes from the caller, and what
 * the track shows is derived from frame numbers and the fixed step — `frame × fixedDt` is exactly
 * the simulated time, which is the time somebody debugging a simulation actually wants.
 * `scripts/platform.test.mjs` now covers `editor/src`, so the claim is a gate rather than a
 * sentence.
 *
 * **Position and frame are exact inverses, and the same pair is used to draw and to hit.** The
 * lesson the graph canvas paid for: a widget that drew its handle with one formula and read the
 * pointer with another would put the handle where the frame is not, and the error would grow with
 * the length of the track. `frameAtX` and `xOfFrame` are each other's inverse, and there is a test
 * that says so across the whole track.
 *
 * **A frame outside the recorded range is drawn as unavailable rather than left out.** The ring
 * drops its oldest frames, and a track that simply started later looks like a session that started
 * later. Showing the lost part as lost is the difference between "you cannot go there" and "there
 * was never anything there".
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import { type UiEvent } from '@driftengine/tools';
import { frameRange, snapshotAt, type Timeline } from './timeline.ts';

/** How tall the track is, and how wide the handle and the marks are. */
export const TRACK_HEIGHT = 18;
export const HANDLE_WIDTH = 3;
export const MARK_WIDTH = 1;

export interface TimelineWidget {
  readonly node: UiNode;
  /** The frame the handle sits on. */
  frame: number;
  /** Where the track is and how long, in the widget's own space. */
  x: number;
  width: number;
  dragging: boolean;
  /** The first and last frame the track covers. Written by `layoutTimelineWidget`. */
  first: number;
  last: number;
  /** The whole session's extent, which may reach earlier than the ring still holds. */
  oldest: number;
  /** Frames the simulation re-ran, so a network session shows where it rolled back. */
  readonly rollbacks: Set<number>;
}

export function createTimelineWidget(): TimelineWidget {
  return {
    node: createUiNode({
      width: 'grow',
      height: TRACK_HEIGHT,
      interactive: true,
      name: 'timeline',
    }),
    frame: 0,
    x: 0,
    width: 0,
    dragging: false,
    first: 0,
    last: 0,
    oldest: 0,
    rollbacks: new Set<number>(),
  };
}

/**
 * Where a frame is drawn, in the widget's own space. The inverse of `frameAtX`.
 *
 * A track covering one frame puts it at the left edge rather than dividing by zero — a session
 * that has run a single frame is a real state and the first one anybody sees.
 */
export function xOfFrame(widget: TimelineWidget, frame: number): number {
  const span = widget.last - widget.first;
  if (span <= 0) return widget.x;
  const clamped = Math.min(widget.last, Math.max(widget.first, frame));
  return widget.x + ((clamped - widget.first) / span) * widget.width;
}

/** Which frame a position is over. The inverse of `xOfFrame`, and rounded to the nearest. */
export function frameAtX(widget: TimelineWidget, x: number): number {
  const span = widget.last - widget.first;
  if (span <= 0 || widget.width <= 0) return widget.first;
  const share = (x - widget.x) / widget.width;
  const frame = widget.first + share * span;
  return Math.min(widget.last, Math.max(widget.first, Math.round(frame)));
}

/** The simulated time a frame happened at. What a person debugging a simulation wants. */
export function secondsAtFrame(frame: number, fixedDt: number): number {
  return frame * fixedDt;
}

/**
 * Point the widget at what the timeline currently holds.
 *
 * `oldest` is the earliest frame the *session* ever reached, which the caller knows and the
 * timeline does not — the ring has forgotten it. Passing it is what lets the lost part of the
 * track be drawn as lost rather than as never having existed.
 */
export function layoutTimelineWidget<S, I>(
  widget: TimelineWidget,
  timeline: Timeline<S, I>,
  x: number,
  width: number,
  oldest = 0,
): void {
  const range = frameRange(timeline);
  widget.x = x;
  widget.width = width;
  widget.first = Math.min(oldest, range.any ? range.first : oldest);
  widget.last = range.any ? range.last : widget.first;
  widget.oldest = oldest;
  widget.frame = Math.min(widget.last, Math.max(widget.first, widget.frame));
}

/**
 * Fill the widget's node: the track, the lost part, the keyframes, the rollbacks, the handle.
 *
 * Every child is absolute and carries the position `xOfFrame` computed, so what is drawn and what
 * is hit come from one function rather than from two that agree today.
 */
export function buildTimelineWidget<S, I>(widget: TimelineWidget, timeline: Timeline<S, I>): void {
  const node = widget.node;
  node.children.length = 0;

  const range = frameRange(timeline);
  addUiChild(
    node,
    createUiNode({
      absolute: true,
      x: widget.x,
      y: 0,
      width: widget.width,
      height: TRACK_HEIGHT,
      name: 'timeline:track',
    }),
  );

  /* The part the ring has dropped, drawn rather than omitted. */
  if (range.any && range.first > widget.first) {
    const from = xOfFrame(widget, widget.first);
    addUiChild(
      node,
      createUiNode({
        absolute: true,
        x: from,
        y: 0,
        width: Math.max(0, xOfFrame(widget, range.first) - from),
        height: TRACK_HEIGHT,
        name: 'timeline:unavailable',
      }),
    );
  }

  for (const one of timeline.frames) {
    if (snapshotAt(timeline, one.frame) === null) continue;
    addUiChild(
      node,
      createUiNode({
        absolute: true,
        x: xOfFrame(widget, one.frame),
        y: 0,
        width: MARK_WIDTH,
        height: TRACK_HEIGHT,
        name: `timeline:keyframe:${String(one.frame)}`,
      }),
    );
  }

  for (const frame of [...widget.rollbacks].sort((a, b) => a - b)) {
    if (frame < widget.first || frame > widget.last) continue;
    addUiChild(
      node,
      createUiNode({
        absolute: true,
        x: xOfFrame(widget, frame),
        y: 0,
        width: MARK_WIDTH,
        height: TRACK_HEIGHT / 2,
        name: `timeline:rollback:${String(frame)}`,
      }),
    );
  }

  addUiChild(
    node,
    createUiNode({
      absolute: true,
      x: xOfFrame(widget, widget.frame) - HANDLE_WIDTH / 2,
      y: 0,
      width: HANDLE_WIDTH,
      height: TRACK_HEIGHT,
      name: 'timeline:handle',
    }),
  );
}

/** What one event asked of the timeline, or nothing. */
export interface TimelineRequest {
  /** The frame to land on. */
  readonly frame: number;
  /** False while a drag is still in progress, true on the press that ends it. */
  readonly settled: boolean;
}

/**
 * Route one event. Returns the frame it wants, or null.
 *
 * **Every move during a drag asks for a frame**, rather than only the release, because a scrubber
 * that shows nothing until you let go is a scrubber you cannot aim. `settled` is what a caller uses
 * to decide whether to do the expensive thing — write the layout, refresh a panel — once.
 */
export function routeTimelineWidget(
  widget: TimelineWidget,
  event: UiEvent,
): TimelineRequest | null {
  if (event.kind === 'key') {
    /* Exactly one frame, because that is what a step is. A key that moved "a bit" would be a key
       nobody could use to find the frame something went wrong on. */
    if (event.key === 'ArrowLeft') return step(widget, -1);
    if (event.key === 'ArrowRight') return step(widget, 1);
    return null;
  }
  if (event.kind !== 'pointer') return null;

  if (event.phase === 'down') {
    if (event.y < 0 || event.y >= TRACK_HEIGHT) return null;
    if (event.x < widget.x || event.x > widget.x + widget.width) return null;
    widget.dragging = true;
    widget.frame = frameAtX(widget, event.x);
    return { frame: widget.frame, settled: false };
  }
  if (!widget.dragging) return null;

  /* No bounds check on a move: a drag that stopped tracking when the pointer left the track is the
     defect `uiPointer.ts` exists to prevent, and the frame is clamped by `frameAtX` anyway. */
  widget.frame = frameAtX(widget, event.x);
  if (event.phase === 'move') return { frame: widget.frame, settled: false };
  widget.dragging = false;
  return { frame: widget.frame, settled: true };
}

function step(widget: TimelineWidget, by: number): TimelineRequest | null {
  const next = Math.min(widget.last, Math.max(widget.first, widget.frame + by));
  if (next === widget.frame) return null;
  widget.frame = next;
  return { frame: next, settled: true };
}
