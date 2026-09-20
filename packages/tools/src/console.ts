/**
 * The log, filtered, with a way back to the line that produced it.
 *
 * **Scrolling up to read something must not be yanked away by the next log line.** That is the
 * whole point of this panel: a console that always jumps to the bottom is unreadable during the
 * thing being debugged, because that is exactly when lines arrive fastest. So the view follows the
 * newest entry *only while it was already at the bottom*, and leaving the bottom stops it.
 *
 * **A repeat collapses into a count.** A warning inside a frame loop arrives sixty times a second,
 * and without this the whole ring becomes one message and everything before it is gone — which is
 * precisely what somebody is looking for when a warning starts repeating.
 *
 * **A long entry is truncated for display and kept whole underneath.** A single line of a hundred
 * kilobytes — a serialised object, a shader source — would otherwise be the panel.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import type { Command } from './command.ts';
import { createPanelRoot, emptyPanel, type Panel } from './panel.ts';

export type Severity = 'debug' | 'info' | 'warn' | 'error';

/** Ascending, so a minimum keeps everything at least as severe. */
const RANK: Readonly<Record<Severity, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  severity: Severity;
  text: string;
  /** How many identical entries this one stands for. One for a single occurrence. */
  count: number;
  /** Where it came from, or empty. */
  file: string;
  line: number;
}

/** A fixed window of entries. Pooled, because a log is appended to forever. */
export interface LogRing {
  readonly pool: LogEntry[];
  readonly capacity: number;
  head: number;
  filled: number;
}

export function createLogRing(capacity: number): LogRing {
  const size = Math.max(1, capacity);
  return {
    pool: Array.from({ length: size }, () => ({
      severity: 'info' as Severity,
      text: '',
      count: 0,
      file: '',
      line: 0,
    })),
    capacity: size,
    head: 0,
    filled: 0,
  };
}

/** The newest entry, or null. What a repeat is compared against. */
function newest(log: LogRing): LogEntry | null {
  if (log.filled === 0) return null;
  return log.pool[(log.head + log.capacity - 1) % log.capacity] as LogEntry;
}

/**
 * Append, collapsing an exact repeat of the newest entry into its count.
 *
 * **Against the newest only**, and not against everything in the window. Collapsing against any
 * earlier entry would reorder the log — the repeat would appear where the first one was, out of
 * sequence with whatever happened in between, and the sequence is what a log is for.
 */
export function appendLog(
  log: LogRing,
  severity: Severity,
  text: string,
  file = '',
  line = 0,
): void {
  const last = newest(log);
  if (
    last !== null &&
    last.severity === severity &&
    last.text === text &&
    last.file === file &&
    last.line === line
  ) {
    last.count += 1;
    return;
  }

  const entry = log.pool[log.head] as LogEntry;
  entry.severity = severity;
  entry.text = text;
  entry.count = 1;
  entry.file = file;
  entry.line = line;
  log.head = (log.head + 1) % log.capacity;
  if (log.filled < log.capacity) log.filled += 1;
}

/** The window, oldest first. */
export function logEntries(log: LogRing): LogEntry[] {
  const first = log.filled < log.capacity ? 0 : log.head;
  const out: LogEntry[] = [];
  for (let at = 0; at < log.filled; at += 1) {
    out.push(log.pool[(first + at) % log.capacity] as LogEntry);
  }
  return out;
}

export interface LogFilter {
  minSeverity: Severity;
  /** Matched case-insensitively against the entry's text. Empty matches everything. */
  text: string;
}

export function createLogFilter(): LogFilter {
  return { minSeverity: 'debug', text: '' };
}

export function filteredEntries(log: LogRing, filter: LogFilter): LogEntry[] {
  const floor = RANK[filter.minSeverity];
  const needle = filter.text.toLowerCase();
  return logEntries(log).filter(
    (entry) =>
      RANK[entry.severity] >= floor && (needle === '' || entry.text.toLowerCase().includes(needle)),
  );
}

/** How much of one entry a row shows. Past this the rest is still on the entry. */
export const DISPLAY_LIMIT = 200;

export function displayText(entry: LogEntry): string {
  const body =
    entry.text.length > DISPLAY_LIMIT ? `${entry.text.slice(0, DISPLAY_LIMIT)}…` : entry.text;
  return entry.count > 1 ? `${body}  (${entry.count})` : body;
}

/** Where a caller is looking. The console asks to move it; the caller owns it. */
export interface SourceCursor {
  file: string;
  line: number;
}

/**
 * Ask to look at a place in a file.
 *
 * **A command, so going back is the same gesture as any other undo.** Whether a caller puts it on
 * the undo stack or merely applies it is the caller's decision — the console knows how to describe
 * the jump and not what navigation should cost.
 */
export function jumpToSourceCommand(
  cursor: SourceCursor,
  file: string,
  line: number,
): Command | null {
  if (file === '') return null;
  if (cursor.file === file && cursor.line === line) return null;
  const was = { file: cursor.file, line: cursor.line };
  return {
    label: `Go to ${file}:${line}`,
    apply: (): void => {
      cursor.file = file;
      cursor.line = line;
    },
    revert: (): void => {
      cursor.file = was.file;
      cursor.line = was.line;
    },
  };
}

export interface ConsoleWorld {
  readonly log: LogRing;
}

export interface ConsoleView {
  readonly root: UiNode;
  readonly filter: LogFilter;
  /** Where the caller is looking. Read by `route` to refuse a jump that goes nowhere. */
  readonly cursor: SourceCursor;
  rowHeight: number;
  viewHeight: number;
  scrollY: number;
  /** Whether the view follows the newest entry. True while it is at the bottom. */
  pinned: boolean;
  /** What the last build showed, so a click finds the entry rather than the row. */
  shown: LogEntry[];
}

export function createConsoleView(options: {
  rowHeight?: number;
  viewHeight?: number;
}): ConsoleView {
  return {
    root: createPanelRoot(consolePanel),
    filter: createLogFilter(),
    cursor: { file: '', line: 0 },
    rowHeight: options.rowHeight ?? 16,
    viewHeight: options.viewHeight ?? 200,
    scrollY: 0,
    pinned: true,
    shown: [],
  };
}

/** The furthest down the view can go. Zero where the content is shorter than the view. */
function maxScroll(view: ConsoleView, rows: number): number {
  return Math.max(0, rows * view.rowHeight - view.viewHeight);
}

export const consolePanel: Panel<ConsoleWorld, ConsoleView> = {
  id: 'console',
  title: 'Console',

  build(world, view, root): void {
    view.shown = filteredEntries(world.log, view.filter);
    if (view.shown.length === 0) {
      emptyPanel(root, 'Nothing logged');
      view.scrollY = 0;
      return;
    }

    root.children.length = 0;
    for (let at = 0; at < view.shown.length; at += 1) {
      const entry = view.shown[at] as LogEntry;
      addUiChild(
        root,
        createUiNode({
          width: 'grow',
          height: view.rowHeight,
          text: displayText(entry),
          interactive: true,
          name: `log:${at}`,
        }),
      );
    }
    /* The follow happens here and not on append, because only a build knows how tall the list is. */
    if (view.pinned) view.scrollY = maxScroll(view, view.shown.length);
  },

  route(_world, view, event): Command | null {
    if (event.kind === 'wheel') {
      /* `+= dy`, which is `scrollBy`'s convention in `@driftengine/ui2d`: positive goes down the
         content. Inverting it here would make this the one scrollable thing in the editor that
         went the other way. */
      const limit = maxScroll(view, view.shown.length);
      view.scrollY = Math.min(limit, Math.max(0, view.scrollY + event.dy));
      view.pinned = view.scrollY >= limit;
      return null;
    }
    if (event.kind !== 'pointer' || event.phase !== 'up' || event.button !== 0) return null;

    const at = Math.floor((event.y + view.scrollY) / view.rowHeight);
    const entry = view.shown[at];
    if (entry === undefined) return null;
    return jumpToSourceCommand(view.cursor, entry.file, entry.line);
  },
};
