/**
 * Where the frame's milliseconds went, per pass.
 *
 * **Unmeasured is not zero, and this panel is the reason Wave 1A drew that line.** `passMs` returns
 * null where nothing sampled a pass, and this renders it as `—`. A profiler that showed 0.00 there
 * could not be told apart from a pass that genuinely ran in no time, and the person reading it
 * would go and optimise a pass that never ran. A *measured* zero still reads as `0.00`, because
 * that one is a fact.
 *
 * **A pass that did nothing this frame keeps its row.** That is what Wave 1A's labels persisting
 * while its timings reset buys: the rows stop jumping about as quality settings toggle passes on
 * and off, which is exactly when somebody is reading them.
 *
 * **Nothing here allocates on a rebuild.** This panel is rebuilt every frame by definition, so the
 * rows and the nodes are both pooled and refilled; a profiler that allocated would be reporting on
 * a frame it was making worse.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import { passLabel, passMs, type PassTimings } from '@driftengine/core';
import { residentCount, type ResidencyTable } from '@driftengine/texture';
import type { Command } from './command.ts';
import { createPanelRoot, emptyPanel, type Panel } from './panel.ts';

export interface ProfilerRow {
  label: string;
  /** Milliseconds, or null where nothing measured this pass. Null is not zero. */
  ms: number | null;
}

/** `—` for unmeasured. Two decimals, because a pass under a hundredth is not the one to look at. */
export function formatMs(ms: number | null): string {
  return ms === null ? '—' : ms.toFixed(2);
}

/**
 * One row per *labelled* pass, oldest index first, written into `out`.
 *
 * A pass with no label was never part of this frame's composition, so it is not a row — as against
 * a pass that has a label and no sample, which is a row reading `—`.
 */
export function profilerRows(timings: PassTimings, out: ProfilerRow[]): ProfilerRow[] {
  let at = 0;
  for (let pass = 0; pass < timings.labels.length; pass += 1) {
    const label = passLabel(timings, pass);
    if (label === '') continue;
    const row = out[at] ?? { label: '', ms: null };
    row.label = label;
    row.ms = passMs(timings, pass);
    out[at] = row;
    at += 1;
  }
  out.length = at;
  return out;
}

/**
 * A fixed window of frame times, oldest first.
 *
 * A ring rather than a growing array, because this is pushed once a frame forever and the window
 * is the only part anybody looks at.
 */
export interface FrameHistory {
  readonly ms: Float64Array;
  /** Where the next frame goes. */
  head: number;
  /** How many of `ms` are live, up to its length. */
  filled: number;
}

export function createFrameHistory(capacity: number): FrameHistory {
  return { ms: new Float64Array(Math.max(0, capacity)), head: 0, filled: 0 };
}

export function pushFrame(history: FrameHistory, ms: number): void {
  const capacity = history.ms.length;
  if (capacity === 0) return;
  history.ms[history.head] = ms;
  history.head = (history.head + 1) % capacity;
  if (history.filled < capacity) history.filled += 1;
}

/** The window, oldest first. Allocates, so it is for a reader rather than for a frame. */
export function historyValues(history: FrameHistory): number[] {
  const capacity = history.ms.length;
  const out: number[] = [];
  const first = history.filled < capacity ? 0 : history.head;
  for (let at = 0; at < history.filled; at += 1) {
    out.push(history.ms[(first + at) % capacity] as number);
  }
  return out;
}

/**
 * How full the page cache is, or null where there is no cache to be full.
 *
 * **Null rather than zero for a capacity of nothing.** A cache that is not there is not an empty
 * cache, and a bar reading 0% would say the streamer had failed rather than that it was absent.
 */
export function occupancy(table: ResidencyTable | null): number | null {
  if (table === null || table.capacity <= 0) return null;
  return residentCount(table) / table.capacity;
}

export interface ProfilerWorld {
  readonly timings: PassTimings;
  readonly history: FrameHistory;
  readonly residency: ResidencyTable | null;
}

export interface ProfilerView {
  readonly root: UiNode;
  rows: ProfilerRow[];
  rowHeight: number;
}

export function createProfilerView(options: { rowHeight?: number }): ProfilerView {
  return {
    root: createPanelRoot(profilerPanel),
    rows: [],
    rowHeight: options.rowHeight ?? 18,
  };
}

/** A pooled row, shown; rows past the end are hidden rather than removed, so the pool survives. */
function lineAt(root: UiNode, index: number, text: string, height: number): void {
  const existing = root.children[index];
  if (existing !== undefined) {
    existing.hidden = false;
    existing.text = text;
    return;
  }
  addUiChild(
    root,
    createUiNode({ width: 'grow', height, text, interactive: false, name: `line:${index}` }),
  );
}

function hideFrom(root: UiNode, index: number): void {
  for (let at = index; at < root.children.length; at += 1) {
    (root.children[at] as UiNode).hidden = true;
  }
}

/** The mean of the window, which is the number worth showing beside the current frame. */
function meanOf(history: FrameHistory): number | null {
  if (history.filled === 0) return null;
  let total = 0;
  for (let at = 0; at < history.filled; at += 1) total += history.ms[at] as number;
  return total / history.filled;
}

export const profilerPanel: Panel<ProfilerWorld, ProfilerView> = {
  id: 'profiler',
  title: 'Profiler',

  build(world, view, root): void {
    view.rows = profilerRows(world.timings, view.rows);
    /*
     * **Nothing at all, rather than no *passes*.** A host with no device still knows how long its
     * frames took, and this returned before the frame line was ever added — so a panel holding
     * sixty samples said `No timings yet`. Reporting nothing where there is something is the same
     * fault as reporting a zero where there is nothing, which the row formatter exists to avoid.
     */
    if (view.rows.length === 0 && world.history.filled === 0) {
      emptyPanel(root, 'No timings yet');
      return;
    }

    let at = 0;
    for (const row of view.rows) {
      lineAt(root, at, `${row.label}  ${formatMs(row.ms)}`, view.rowHeight);
      at += 1;
    }
    lineAt(
      root,
      at,
      `frame  ${formatMs(meanOf(world.history))} mean of ${world.history.filled}`,
      view.rowHeight,
    );
    at += 1;
    const full = occupancy(world.residency);
    lineAt(
      root,
      at,
      `residency  ${full === null ? '—' : `${(full * 100).toFixed(0)}%`}`,
      view.rowHeight,
    );
    at += 1;
    hideFrom(root, at);
  },

  route(): Command | null {
    /* A profiler reads. There is nothing here a person could ask the world to change. */
    return null;
  },
};
