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
  // Well past the budget, sustained: the case the whole class exists for.
  run(governor, 120, DEFAULT_GOVERNOR_LIMITS.badWindows + 1);
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
  const { handle } = sceneWith(2);
  const governor = new SceneGovernor(handle);
  expect(governor.exhausted, 'a scene at full density has everything still to give').toBe(false);

  // Drive it down until it can go no further.
  for (let round = 0; round < 40; round++) run(governor, 200, 2);
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
