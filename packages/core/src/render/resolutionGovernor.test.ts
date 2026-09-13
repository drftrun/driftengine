import { expect, test } from 'vitest';

import { DEFAULT_GOVERNOR_LIMITS, ResolutionGovernor } from './resolutionGovernor.ts';

const { budgetMs, dropStep, raiseStep, windowFrames, raisePatience } = DEFAULT_GOVERNOR_LIMITS;
const GOOD = 8;
const BAD = budgetMs + 20;

/**
 * Play `windows` windows into `g`, choosing each frame's length with `pick`.
 *
 * `pick` takes the frame's index within its window, which is what lets a test say "one
 * frame in sixty is long" without writing the loop out every time.
 */
function play(
  g: ResolutionGovernor,
  windows: number,
  pick: (indexInWindow: number) => number,
): number | null {
  let last: number | null = null;
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < windowFrames; i++) {
      const decided = g.sample(pick(i), true);
      if (decided !== null) last = decided;
    }
  }
  return last;
}

test('a healthy machine is never touched', () => {
  const g = new ResolutionGovernor(2);
  expect(play(g, 20, () => GOOD)).toBeNull();
  expect(g.scale).toBe(2);
});

test('a single hitch cannot degrade a fast machine, however often it happens', () => {
  /*
   * The failure this is here to prevent, and the first version of this governor had it: it
   * took the *worst* frame in the window, so one 21 ms frame on a 120 fps machine dropped a
   * resolution step. A garbage collection is one frame. A shader compile is a handful. Another
   * application grabbing the GPU for a moment is a fraction of a window. None of them is a
   * verdict about the hardware, and a control loop has to ignore everything it cannot act on.
   */
  const g = new ResolutionGovernor(2);
  expect(play(g, 40, (i) => (i === 0 ? BAD : GOOD))).toBeNull();
  expect(g.scale).toBe(2);
});

test('a machine that is long on a large minority of frames is still left alone', () => {
  // Just under the share. Sustained unpleasantness, and still not the governor's business.
  const g = new ResolutionGovernor(2);
  expect(play(g, 30, (i) => (i < windowFrames * 0.45 ? BAD : GOOD))).toBeNull();
  expect(g.scale).toBe(2);
});

test('one bad window on its own decides nothing', () => {
  /*
   * A world build, a tab coming back, a level load. The same reasoning `SLOW_WINDOWS`
   * carries in the game's frame health, for the same reason.
   */
  const g = new ResolutionGovernor(2);
  expect(play(g, 1, () => BAD)).toBeNull();
  expect(g.scale).toBe(2);
});

test('two bad windows in a row lowers the scale', () => {
  const g = new ResolutionGovernor(2);
  expect(play(g, 2, () => BAD)).toBeCloseTo(2 - dropStep);
});

test('a good window between two bad ones is two hiccups, not a streak', () => {
  /*
   * Without clearing, a long enough session always accumulates two bad windows eventually
   * and every machine gets degraded given enough time.
   */
  const g = new ResolutionGovernor(2);
  play(g, 1, () => BAD);
  play(g, 1, () => GOOD);
  expect(play(g, 1, () => BAD)).toBeNull();
  expect(g.scale).toBe(2);
});

test('the device this exists for is caught without ambiguity', () => {
  /*
   * NFD6QQ's Adreno 619 held 156.66 ms a frame: every frame long, a share of 1.0, so it
   * clears two windows immediately. The tolerance above costs nothing against a device that
   * is actually broken, which is the whole point of choosing it this way.
   */
  const g = new ResolutionGovernor(2);
  expect(play(g, 2, () => 156.66)).toBeCloseTo(2 - dropStep);
});

test('it stops at the floor rather than reaching zero', () => {
  const g = new ResolutionGovernor(2);
  play(g, 200, () => BAD);
  expect(g.scale).toBe(DEFAULT_GOVERNOR_LIMITS.minScale);
});

test('it will not raise on the first clean window, only after patience', () => {
  /*
   * Asymmetric on purpose: drop slowly and carefully, raise even more slowly. An
   * oscillating resolution is more visible than a slightly low one.
   */
  const g = new ResolutionGovernor(2);
  play(g, 2, () => BAD);
  const dropped = g.scale;

  expect(play(g, raisePatience - 1, () => GOOD)).toBeNull();
  expect(g.scale).toBe(dropped);
  expect(play(g, 1, () => GOOD)).toBeCloseTo(dropped + raiseStep);
});

test('it never rises above the ceiling the player set', () => {
  const g = new ResolutionGovernor(1);
  play(g, 40, () => GOOD);
  expect(g.scale).toBe(1);
});

test('a lowered ceiling pulls the current scale down with it', () => {
  const g = new ResolutionGovernor(2);
  g.setCeiling(0.75);
  expect(g.scale).toBe(0.75);
});

test('a raised ceiling does not raise the scale by itself', () => {
  /*
   * The ceiling is a permission, not an instruction. Jumping to a new ceiling would undo a
   * drop the device had already earned; the patience path decides whether it can climb back.
   */
  const g = new ResolutionGovernor(1);
  play(g, 2, () => BAD);
  const dropped = g.scale;
  g.setCeiling(2);
  expect(g.scale).toBe(dropped);
});

test('unplayable frames are not evidence about the device', () => {
  /*
   * The DZTF9F lesson, as a governor: a menu frame and a hidden-tab frame are not verdicts
   * about the machine, and that false positive reached a player once already.
   */
  const g = new ResolutionGovernor(2);
  for (let i = 0; i < windowFrames * 10; i++) g.sample(500, false);
  expect(g.scale).toBe(2);
});

test('a window is only decided once it is full', () => {
  const g = new ResolutionGovernor(2);
  for (let i = 0; i < windowFrames - 1; i++) expect(g.sample(BAD, true)).toBeNull();
  // Full now, but it is only the first bad window, so it still decides nothing.
  expect(g.sample(BAD, true)).toBeNull();
});

test('reset clears the evidence without touching the scale', () => {
  const g = new ResolutionGovernor(2);
  play(g, 1, () => BAD);
  g.reset();
  // That bad window is forgotten, so the next one is again the first of its kind.
  expect(play(g, 1, () => BAD)).toBeNull();
  expect(g.scale).toBe(2);
});
