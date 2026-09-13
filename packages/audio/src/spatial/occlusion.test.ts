import { expect, test } from 'vitest';
import { ProbeScheduler, occlusionCutoffHz, occlusionGainFor, smoothToward } from './occlusion.ts';

test('the cutoff sweeps by musical interval, not by hertz', () => {
  /*
   * The rule `liftFrequencyHz` was written under, applied to the same kind of sweep. Pitch is
   * logarithmic: a linear travel from 20 kHz to 500 Hz spends nearly all of itself in a band
   * nothing is made of, so three quarters of a door closing would do nothing audible and the last
   * quarter would slam.
   */
  expect(occlusionCutoffHz(0), 'unoccluded must be inaudible as a filter').toBeGreaterThan(18000);
  expect(occlusionCutoffHz(1)).toBeCloseTo(500, 0);
  expect(occlusionCutoffHz(0.5), 'half way is the geometric mean').toBeCloseTo(
    Math.sqrt(20000 * 500),
    0,
  );
});

test('the cutoff is monotonic — more wall never means more treble', () => {
  let previous = Infinity;
  for (let amount = 0; amount <= 1.0001; amount += 0.05) {
    const hz = occlusionCutoffHz(amount);
    expect(hz, `amount ${amount}`).toBeLessThanOrEqual(previous);
    previous = hz;
  }
});

test('a fully occluded source is quieter but not silent', () => {
  /*
   * Silence is the wrong answer and it is the tempting one. A source that goes to zero behind a
   * wall pops out of existence, and the player learns that walls delete sounds rather than muffle
   * them — which is worse than no occlusion at all, because it removes the information that
   * something is still there.
   */
  expect(occlusionGainFor(0)).toBe(1);
  expect(occlusionGainFor(1)).toBeGreaterThan(0);
  expect(occlusionGainFor(1)).toBeLessThan(0.5);
});

test('smoothing is in time, so one rate means one thing at any frame rate', () => {
  /*
   * `AGENTS.md`, 2026-08-17: a per-step factor is a bug the moment two callers step at different
   * rates. That rule was written after one constant meant 47 ms offline and 158 ms live, and moved
   * with the consumer's frame rate. Sixty steps of a sixtieth must land where one step of a whole
   * second does.
   */
  let sixty = 0;
  for (let i = 0; i < 60; i++) sixty = smoothToward(sixty, 1, 4, 1 / 60);
  expect(sixty).toBeCloseTo(smoothToward(0, 1, 4, 1), 3);
});

test('probes are staggered across sources rather than all landing on one frame', () => {
  /*
   * Twenty sources probing on the same frame is one spike every period; twenty staggered is twenty
   * single tests. The cost is the consumer's — a segment test against their own world — which is
   * exactly why the throttling is here and not left to them to discover.
   */
  const scheduler = new ProbeScheduler(0.2);
  const firstFrame: number[] = [];
  for (let index = 0; index < 20; index++) {
    if (scheduler.due(index, 20, 0)) firstFrame.push(index);
  }
  expect(firstFrame.length, 'not all twenty at once').toBeLessThan(20);

  // And over one whole period, every source gets exactly one turn.
  const served = new Set<number>(firstFrame);
  for (let step = 1; step <= 20; step++) {
    for (let index = 0; index < 20; index++) {
      if (scheduler.due(index, 20, step * 0.01)) served.add(index);
    }
  }
  expect(served.size, 'every source is probed within a period').toBe(20);
});
