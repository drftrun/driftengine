import { expect, test } from 'vitest';
import { DEFAULT_GOVERNOR_LIMITS } from '../packages/core/src/index';
import { SceneGovernor } from './sceneGovernor';
import type { DemoHandle, DemoStats, ResolutionControl } from './types';

/**
 * A scene that does nothing but record what was asked of its density.
 *
 * The governor's own arithmetic is pinned in `resolutionGovernor.test.ts` and is not restated
 * here. What these check is the join: that the lever is found, seeded from the right number,
 * pulled on evidence and left alone otherwise.
 */
function sceneWith(ceiling: number | undefined): {
  handle: DemoHandle;
  applied: number[];
} {
  const applied: number[] = [];
  const resolution: ResolutionControl | undefined =
    ceiling === undefined
      ? undefined
      : {
          get ceiling(): number {
            return ceiling;
          },
          apply(scale: number): void {
            applied.push(scale);
          },
        };
  const handle = {
    frame: (): DemoStats => ({ draws: 0, instances: 0, gpuMs: 0 }) as DemoStats,
    dispose: () => {},
    ...(resolution === undefined ? {} : { resolution }),
  } as DemoHandle;
  return { handle, applied };
}

/** Enough frames at one cost to force however many decisions are asked for. */
function run(governor: SceneGovernor, frameMs: number, windows: number): void {
  const frames = DEFAULT_GOVERNOR_LIMITS.windowFrames * windows;
  for (let at = 0; at < frames; at++) governor.observe(frameMs / 1000);
}

/**
 * A machine whose frame time follows the density in force, for `frames` frames.
 *
 * `msAt` is asked about the last scale the governor applied, or the ceiling before it has applied
 * any, so a drop changes the next frame exactly as a resize would.
 */
function drive(
  governor: SceneGovernor,
  ceiling: number,
  applied: readonly number[],
  msAt: (scale: number) => number,
  frames: number,
): void {
  for (let at = 0; at < frames; at++) {
    const scale = applied.length === 0 ? ceiling : (applied[applied.length - 1] ?? ceiling);
    governor.observe(msAt(scale) / 1000);
  }
}

test('A MACHINE AT FORTY FRAMES A SECOND IS SOFTENED, NOT ONLY ONE AT TWENTY-FIVE', () => {
  /*
   * The front page's scene was reported at 40 fps on ordinary machines and phones, and nothing
   * moved: the engine's budget calls a frame long at 40 ms, which is a game's floor against a
   * slideshow and not a demo's against a stutter. 25 ms at full density and the pixels as the
   * cost, as this scene is: 14.06 ms at 0.75, 19.14 at 0.875, both inside the 20 ms budget. So it
   * drops a step, climbs back a step at a time, misses at full density once, and stays at 0.875,
   * the highest density it was seen to hold.
   */
  const { handle, applied } = sceneWith(1);
  const governor = new SceneGovernor(handle);
  drive(governor, 1, applied, (scale) => 25 * scale * scale, 30 * 30);
  expect(applied).toEqual([0.75, 0.875, 1, 0.75, 0.875]);
});

test('A DROP THAT BUYS NO TIME IS GIVEN BACK', () => {
  /*
   * A browser saving power caps the frame at 30 a second whatever the scene costs, and so does a
   * main thread busy with something else. Softening that picture buys nothing and costs the
   * reader a blurred page, so a drop is judged by the window after it: no faster, and it is
   * undone, and the governor stops, because the frame is not bound by pixels.
   */
  const { handle, applied } = sceneWith(1);
  const governor = new SceneGovernor(handle);
  drive(governor, 1, applied, () => 1000 / 30, 30 * 40);
  expect(applied).toEqual([0.75, 1]);
  expect(governor.exhausted, 'and nothing it holds is worth giving any more').toBe(true);
});

test('A DENSITY THE MACHINE COULD NOT HOLD IS NOT TRIED AGAIN', () => {
  /*
   * The governor climbs back after a run of good windows, which is right after a load and wrong
   * on a machine whose limit sits between two steps: it climbs, misses, drops below where it
   * was, climbs again, and the picture changes density every few seconds for the whole visit.
   * Here the machine holds the rate at 0.75 and not above: one climb to 0.875 is the test of
   * that, and after it the ceiling is the scale it climbed from.
   */
  const { handle, applied } = sceneWith(1);
  const governor = new SceneGovernor(handle);
  drive(governor, 1, applied, (scale) => (scale > 0.75 ? 25 : 14), 30 * 100);
  expect(applied).toEqual([0.75, 0.875, 0.625, 0.75]);
});

test('A DENSITY HELD AFTER A CLIMB IS NOT CAPPED BY A LATER HITCH', () => {
  /*
   * The other side of the rule above. A climb that holds for windows on end was right, and a
   * hitch long after it (a section of the page loading, another tab compiling) says nothing about
   * it. 8 ms everywhere but two windows of 25 at the start and two more at frame 1200, each
   * window-aligned: both bursts drop a step, and both are climbed all the way back out of.
   */
  const { handle, applied } = sceneWith(1);
  const governor = new SceneGovernor(handle);
  for (let frame = 0; frame < 30 * 80; frame++) {
    const burst = frame < 60 || (frame >= 1200 && frame < 1260);
    governor.observe((burst ? 25 : 8) / 1000);
  }
  expect(applied).toEqual([0.75, 0.875, 1, 0.75, 0.875, 1]);
});

test('a scene that offers no lever is left entirely alone', () => {
  /*
   * The compatibility that matters: a host may now construct one of these around any handle,
   * including the ones that have nothing to say about density, and must not have to ask first.
   */
  const { handle } = sceneWith(undefined);
  const governor = new SceneGovernor(handle);
  expect(governor.active).toBe(false);
  expect(governor.observe(1 / 60)).toBe(null);
});

test('a machine holding the rate is never softened', () => {
  const { handle, applied } = sceneWith(2);
  const governor = new SceneGovernor(handle);
  // 8 ms: what the showroom measured on the machine the black frame was reported against.
  run(governor, 8, 12);
  expect(applied, 'a fast machine must reach the end of a visit at the density it started').toEqual(
    [],
  );
});

test('a machine that cannot hold the rate is given a softer picture rather than none', () => {
  const { handle, applied } = sceneWith(2);
  const governor = new SceneGovernor(handle);
  // Well past the budget, sustained and bound by its pixels: the case the whole class exists for.
  drive(governor, 2, applied, (scale) => 120 * (scale / 2) ** 2, 30 * 3);
  expect(applied.length).toBeGreaterThan(0);
  expect(applied[0]).toBeLessThan(2);
  expect(applied[0]).toBeGreaterThanOrEqual(DEFAULT_GOVERNOR_LIMITS.minScale);
});

test('the density it starts from is the one in force, not the one that was asked for', () => {
  /*
   * `capabilityClamp` lowers the request on exactly the devices this exists for, so a governor
   * seeded from the request would spend its first decisions walking back down to where the
   * renderer already was, softening nothing while a reader waited.
   */
  const { handle, applied } = sceneWith(1);
  const governor = new SceneGovernor(handle);
  run(governor, 120, DEFAULT_GOVERNOR_LIMITS.badWindows + 1);
  expect(applied[0]).toBeLessThan(1);
});

test('frames while nothing is being drawn are not evidence about the machine', () => {
  /*
   * A hidden tab receives no frames, so the first one back carries the whole gap. Believing it
   * would soften a scene that was never asked to draw, which is the false positive the game's
   * own frame health already learned to refuse.
   */
  const { handle, applied } = sceneWith(2);
  const governor = new SceneGovernor(handle);
  const frames = DEFAULT_GOVERNOR_LIMITS.windowFrames * (DEFAULT_GOVERNOR_LIMITS.badWindows + 1);
  for (let at = 0; at < frames; at++) governor.observe(60, true);
  expect(applied).toEqual([]);
});

/**
 * The ordering between softening and stopping, which the first version of this got wrong.
 *
 * A host that measures frame times has its own verdict, and that verdict is reached over fewer
 * frames than a governor needs: driftengine.dev judges over 48 and a decision here takes two
 * windows. So the probe always won the race, the density never moved once, and wiring the
 * governor up changed nothing at all on the machine it was written for. Verified by measurement
 * rather than argument: at 20x throttle the scene reported `too-slow at 16 fps` four times over
 * and `density dropped` never.
 *
 * `exhausted` is what lets a host order them properly. It is not a second opinion about the
 * machine, it is the answer to a different question: is there anything left to give.
 */
test('a governor with room left says so, and stops saying so at the floor', () => {
  const { handle, applied } = sceneWith(2);
  const governor = new SceneGovernor(handle);
  expect(governor.exhausted, 'a scene at full density has everything still to give').toBe(false);

  /*
   * Drive it down until it can go no further. Bound by its pixels, so every step buys time and is
   * kept, and slow enough at the floor (50 ms at 0.5) that none of them is ever enough.
   */
  drive(governor, 2, applied, (scale) => 200 * scale * scale, 30 * 80);
  expect(applied.at(-1), 'it went all the way down').toBe(DEFAULT_GOVERNOR_LIMITS.minScale);
  expect(governor.exhausted, 'and nothing left once it is on the floor').toBe(true);
});

test('a scene with no lever is exhausted from the start, so a host is never left waiting', () => {
  /*
   * The dangerous reading of `exhausted` is "keep the scene alive until it becomes true". A
   * scene that offers no density at all must therefore answer true immediately, or a host that
   * defers to it would never stop anything.
   */
  const { handle } = sceneWith(undefined);
  expect(new SceneGovernor(handle).exhausted).toBe(true);
});
