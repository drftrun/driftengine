import { expect, test } from 'vitest';
import { LoadTracker } from './loadTracker.ts';

/**
 * The arithmetic a loading bar is, which every consumer otherwise gets slightly wrong.
 *
 * What is worth testing here is not that a mean works. It is the three decisions that make a bar
 * honest rather than decorative: weights so a big thing counts for more than a small one, dropping
 * an absent task rather than completing it, and a defined answer when a caller feeds in a number
 * that is not one.
 */

test('the total is weighted, so a big task counts for more than a small one', () => {
  const tracker = new LoadTracker();
  tracker.add('model', 90);
  tracker.add('settings', 10);

  tracker.report('settings', 1);
  /*
   * A bar over two *tasks* would read 50% here, which is the failure this exists to prevent: the
   * thing a viewer is waiting for has not started, and the bar is halfway.
   */
  expect(tracker.summary.fraction).toBeCloseTo(0.1, 5);

  tracker.report('model', 0.5);
  expect(tracker.summary.fraction).toBeCloseTo(0.55, 5);
});

test('the active task is the heaviest one outstanding, not the first registered', () => {
  /*
   * Because that is the one a viewer is actually waiting for. Naming the first-registered task
   * means a bar that says "reading settings" for the eight seconds a model takes.
   */
  const tracker = new LoadTracker();
  tracker.add('settings', 10);
  tracker.add('model', 90);
  expect(tracker.summary.activeId).toBe('model');

  tracker.finish('model');
  expect(tracker.summary.activeId).toBe('settings');
});

test('an absent optional task is dropped, not completed', () => {
  /*
   * The distinction is the whole point. A model that was never baked is not fully loaded, it is
   * not part of this load — and counting it as finished makes the bar claim something arrived
   * that never did.
   */
  const tracker = new LoadTracker();
  tracker.add('room', 50);
  tracker.add('model', 50);
  tracker.report('room', 0.5);

  tracker.drop('model');
  expect(tracker.summary.fraction, 'the total is now over the room alone').toBeCloseTo(0.5, 5);
  expect(tracker.summary.tasksTotal).toBe(1);
});

test('a weight learned late does not throw away the progress already reported', () => {
  /*
   * A caller frequently learns the real size after starting: a fetch that finally reports its
   * length, a model whose manifest says how many parts are coming. Making that choice between a
   * wrong weight and a lost fraction would be a bad choice to force.
   */
  const tracker = new LoadTracker();
  tracker.add('model', 1);
  tracker.report('model', 0.4);
  tracker.add('model', 900);
  expect(tracker.summary.fraction).toBeCloseTo(0.4, 5);
});

test('nothing to wait for is done, and a finished set stays finished', () => {
  const empty = new LoadTracker();
  expect(empty.summary.done).toBe(true);
  expect(empty.summary.fraction).toBe(1);

  const tracker = new LoadTracker();
  tracker.add('one', 5);
  expect(tracker.summary.done).toBe(false);
  tracker.finish('one');
  expect(tracker.summary.done).toBe(true);
  /* A late report after finishing cannot walk it backwards, which is the shape of a stream that
     reports progress once more after its last byte. */
  tracker.report('one', 0.2);
  expect(tracker.summary.fraction).toBe(1);
});

test('a fraction that is not a number leaves the bar defined', () => {
  /*
   * This is fed by arithmetic the caller did, and a division by a total that has not arrived is
   * one edit away. A NaN here would spread to the bar and then to whatever the bar drives, which
   * in this engine has meant a whole frame resolving to black before.
   */
  const tracker = new LoadTracker();
  tracker.add('model', 10);
  tracker.report('model', Number.NaN);
  expect(tracker.summary.fraction).toBe(0);
  tracker.report('model', Number.POSITIVE_INFINITY);
  expect(tracker.summary.fraction).toBe(0);
  tracker.report('model', 4);
  expect(tracker.summary.fraction).toBe(1);
});

test('an unknown id is ignored rather than thrown at', () => {
  /*
   * A load reports from a callback that outlives the thing it was loading — a decode finishing
   * after a scene was torn down is the ordinary case, not the exceptional one — and throwing
   * inside somebody's promise chain to report a bookkeeping mismatch is the wrong trade.
   */
  const tracker = new LoadTracker();
  expect(() => tracker.report('gone', 0.5)).not.toThrow();
  expect(() => tracker.finish('gone')).not.toThrow();
  expect(tracker.summary.done).toBe(true);
});
