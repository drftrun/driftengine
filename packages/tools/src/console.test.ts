import { describe, expect, it } from 'vitest';
import { createUndoStack } from './command.ts';
import { pointerEvent } from './panel.ts';
import {
  DISPLAY_LIMIT,
  appendLog,
  consolePanel,
  createConsoleView,
  createLogFilter,
  createLogRing,
  displayText,
  filteredEntries,
  jumpToSourceCommand,
  logEntries,
  type LogRing,
} from './console.ts';

function ring(capacity = 8): LogRing {
  return createLogRing(capacity);
}

describe('the log', () => {
  it('keeps entries oldest first and drops the oldest at capacity', () => {
    const log = ring(3);
    for (const text of ['one', 'two', 'three']) appendLog(log, 'info', text);
    expect(logEntries(log).map((entry) => entry.text)).toEqual(['one', 'two', 'three']);

    appendLog(log, 'info', 'four');
    expect(logEntries(log).map((entry) => entry.text)).toEqual(['two', 'three', 'four']);
  });

  /**
   * **A repeat collapses with a count instead of filling the buffer.** A warning inside a frame
   * loop arrives sixty times a second, and without this the entire ring is one message and
   * everything that came before it is gone — which is precisely when somebody is looking for what
   * came before it.
   */
  it('collapses a repeat into a count', () => {
    const log = ring(8);
    appendLog(log, 'warn', 'shader recompiled');
    appendLog(log, 'warn', 'shader recompiled');
    appendLog(log, 'warn', 'shader recompiled');

    const entries = logEntries(log);
    expect(entries.length).toBe(1);
    expect(entries[0]?.count).toBe(3);
  });

  it('does not collapse across a different message or a different severity', () => {
    const log = ring(8);
    appendLog(log, 'warn', 'a');
    appendLog(log, 'warn', 'b');
    appendLog(log, 'warn', 'a');
    expect(logEntries(log).map((entry) => entry.text)).toEqual(['a', 'b', 'a']);

    appendLog(log, 'error', 'a');
    expect(
      logEntries(log).length,
      'the same words at a different severity is a different entry',
    ).toBe(4);
  });

  it('collapses only against the newest entry, so an older identical one is untouched', () => {
    const log = ring(8);
    appendLog(log, 'info', 'a');
    appendLog(log, 'info', 'b');
    appendLog(log, 'info', 'b');
    const entries = logEntries(log);
    expect(entries.map((entry) => [entry.text, entry.count])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('keeps a source location where one was given', () => {
    const log = ring(8);
    appendLog(log, 'error', 'undefined is not a function', 'player.drs', 42);
    const entry = logEntries(log)[0];
    expect(entry?.file).toBe('player.drs');
    expect(entry?.line).toBe(42);
  });
});

describe('filtering', () => {
  function noisy(): LogRing {
    const log = ring(16);
    appendLog(log, 'debug', 'entering frame');
    appendLog(log, 'info', 'scene loaded');
    appendLog(log, 'warn', 'shader recompiled');
    appendLog(log, 'error', 'device lost');
    return log;
  }

  it('narrows by severity, keeping everything at least as severe', () => {
    const filter = createLogFilter();
    filter.minSeverity = 'warn';
    expect(filteredEntries(noisy(), filter).map((entry) => entry.text)).toEqual([
      'shader recompiled',
      'device lost',
    ]);
  });

  it('narrows by text, case-insensitively', () => {
    const filter = createLogFilter();
    filter.text = 'SHADER';
    expect(filteredEntries(noisy(), filter).map((entry) => entry.text)).toEqual([
      'shader recompiled',
    ]);
  });

  it('applies both at once', () => {
    const filter = createLogFilter();
    filter.minSeverity = 'error';
    filter.text = 'shader';
    expect(filteredEntries(noisy(), filter)).toEqual([]);
  });

  it('shows everything by default', () => {
    expect(filteredEntries(noisy(), createLogFilter()).length).toBe(4);
  });
});

describe('a very long entry', () => {
  it('is truncated for display and kept whole underneath', () => {
    const log = ring(4);
    const huge = 'x'.repeat(DISPLAY_LIMIT + 500);
    appendLog(log, 'info', huge);

    const entry = logEntries(log)[0]!;
    expect(entry.text.length, 'the whole thing is still there').toBe(DISPLAY_LIMIT + 500);
    expect(displayText(entry).length).toBeLessThanOrEqual(DISPLAY_LIMIT + 1);
    expect(displayText(entry).endsWith('…')).toBe(true);
  });

  it('leaves a short entry alone, and shows a count where there is one', () => {
    const log = ring(4);
    appendLog(log, 'info', 'short');
    appendLog(log, 'info', 'short');
    expect(displayText(logEntries(log)[0]!)).toBe('short  (2)');
  });
});

describe('the console panel', () => {
  it('shows the newest last and says so when there is nothing', () => {
    const view = createConsoleView({ rowHeight: 10, viewHeight: 100 });
    const log = ring(8);

    consolePanel.build({ log }, view, view.root);
    expect(view.root.children[0]?.text).toContain('Nothing logged');

    appendLog(log, 'info', 'first');
    appendLog(log, 'info', 'second');
    consolePanel.build({ log }, view, view.root);
    expect(view.root.children.map((child) => child.text)).toEqual(['first', 'second']);
  });

  /**
   * **Scrolling up to read something must not be yanked away by the next log line.** This is the
   * whole point of the panel: a console that always jumps to the bottom is a console nobody can
   * read during the thing they are debugging, because that is when the lines arrive fastest.
   */
  it('follows the newest line only while it was already at the bottom', () => {
    const view = createConsoleView({ rowHeight: 10, viewHeight: 30 });
    const log = ring(64);
    for (let at = 0; at < 10; at += 1) appendLog(log, 'info', `line ${at}`);
    consolePanel.build({ log }, view, view.root);

    expect(view.pinned).toBe(true);
    expect(view.scrollY, 'ten rows of ten in thirty pixels').toBe(70);

    appendLog(log, 'info', 'line 10');
    consolePanel.build({ log }, view, view.root);
    expect(view.scrollY, 'still following').toBe(80);

    /* Somebody scrolls up to read. */
    consolePanel.route({ log }, view, { kind: 'wheel', x: 0, y: 0, dx: 0, dy: -40 });
    expect(view.pinned, 'leaving the bottom unpins it').toBe(false);
    const held = view.scrollY;

    appendLog(log, 'info', 'line 11');
    consolePanel.build({ log }, view, view.root);
    expect(view.scrollY, 'and the new line does not move the view').toBe(held);
  });

  it('starts following again once it is scrolled back to the bottom', () => {
    const view = createConsoleView({ rowHeight: 10, viewHeight: 30 });
    const log = ring(64);
    for (let at = 0; at < 10; at += 1) appendLog(log, 'info', `line ${at}`);
    consolePanel.build({ log }, view, view.root);

    consolePanel.route({ log }, view, { kind: 'wheel', x: 0, y: 0, dx: 0, dy: -40 });
    expect(view.pinned).toBe(false);
    consolePanel.route({ log }, view, { kind: 'wheel', x: 0, y: 0, dx: 0, dy: 100 });
    expect(view.pinned, 'back at the bottom is following again').toBe(true);
  });

  it('a log shorter than the view is at the bottom already', () => {
    const view = createConsoleView({ rowHeight: 10, viewHeight: 100 });
    const log = ring(8);
    appendLog(log, 'info', 'only');
    consolePanel.build({ log }, view, view.root);
    expect(view.scrollY).toBe(0);
    expect(view.pinned).toBe(true);
  });
});

describe('jumping to source', () => {
  it('asks to move a caller-owned cursor, and can be taken back', () => {
    const cursor = { file: 'main.drs', line: 1 };
    const command = jumpToSourceCommand(cursor, 'player.drs', 42);

    const stack = createUndoStack(4);
    stack.push(command!);
    expect(cursor).toEqual({ file: 'player.drs', line: 42 });
    stack.undo();
    expect(cursor, 'back where it was looking').toEqual({ file: 'main.drs', line: 1 });
  });

  it('asks for nothing when there is nowhere to go', () => {
    expect(jumpToSourceCommand({ file: 'a', line: 1 }, '', 0)).toBe(null);
    expect(jumpToSourceCommand({ file: 'a', line: 1 }, 'a', 1), 'already there').toBe(null);
  });

  it('is what a click on an entry with a location produces', () => {
    const view = createConsoleView({ rowHeight: 10, viewHeight: 100 });
    const log = ring(8);
    appendLog(log, 'info', 'no location here');
    appendLog(log, 'error', 'boom', 'player.drs', 42);
    consolePanel.build({ log }, view, view.root);

    expect(consolePanel.route({ log }, view, pointerEvent('up', 5, 5)), 'no location').toBe(null);
    const command = consolePanel.route({ log }, view, pointerEvent('up', 5, 15));
    expect(command?.label).toBe('Go to player.drs:42');
    expect(view.cursor, 'asking is not going').toEqual({ file: '', line: 0 });
  });
});
