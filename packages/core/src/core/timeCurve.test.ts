import { expect, test } from 'vitest';
import { MAX_TIME_CURVE_AMOUNT, curveOffsetSec, curveSpanSec, timeCurve } from './timeCurve.ts';
import type { TimeCurve, TimeCurveKind } from './timeCurve.ts';

const KINDS: readonly TimeCurveKind[] = ['linear', 'hold', 'ramp', 'stutter', 'reverse'];

/** Every kind at a strong setting, so a broken one cannot hide behind a tiny amount. */
function strongCurves(durationSec: number): TimeCurve[] {
  return KINDS.map((kind) =>
    timeCurve(kind, durationSec, { amount: 0.4, stepSec: 0.5, reversibleSec: 0.6 }),
  );
}

test('a re-timed shot spends exactly the source time its clip time is worth', () => {
  /*
   * The contract the whole feature rests on, and the reason a curve is a
   * reparameterisation rather than a speed setting: a fifteen-second clip has to
   * still cover fifteen seconds of the run once curves are applied. A curve that
   * slowed time without catching up would silently shorten the footage, and the
   * clip would end before the moment it was cut for.
   *
   * The expectation is the segment's own duration, hand-derived from the
   * definition rather than measured from the implementation.
   */
  for (const curve of strongCurves(2.4)) {
    expect(curveSpanSec(curve), curve.kind).toBeCloseTo(2.4, 9);
  }

  // And at the ceiling, where the catch-up rate is highest and an off-by-one in
  // the debt maths is largest.
  for (const kind of KINDS) {
    const curve = timeCurve(kind, 1.75, {
      amount: MAX_TIME_CURVE_AMOUNT,
      stepSec: 0.4,
      reversibleSec: 10,
    });
    expect(curveSpanSec(curve), kind).toBeCloseTo(1.75, 9);
  }
});

test('a curve never runs time backwards past the buffer', () => {
  /*
   * A reverse can only go back as far as the consumer kept states for. Running a
   * re-simulated intent stream backwards by re-simulating from the start on
   * every frame is the obvious implementation and it is quadratic, so the real
   * one is a short ring buffer — and a curve that asked for more than the buffer
   * holds would show a jump instead of a rewind.
   */
  const budget = 0.35;
  const curve = timeCurve('reverse', 3, { amount: MAX_TIME_CURVE_AMOUNT, reversibleSec: budget });
  for (let local = 0; local <= 3.0001; local += 0.005) {
    expect(curveOffsetSec(curve, local)).toBeGreaterThanOrEqual(-budget - 1e-9);
  }
  // It uses what it is given: with a budget this generous the deepest point is
  // the whole amount, and the clamp is what keeps it honest above.
  expect(curveOffsetSec(curve, budget)).toBeCloseTo(-budget, 9);

  /*
   * And a consumer with no buffer gets no reversal at all rather than a smaller
   * one. This is the case that actually ships today: the replay re-simulates,
   * keeps no states, and passes zero.
   */
  const noBuffer = timeCurve('reverse', 3, { amount: 0.5, reversibleSec: 0 });
  let previous = -Infinity;
  for (let local = 0; local <= 3.0001; local += 0.01) {
    const at = curveOffsetSec(noBuffer, local);
    expect(at).toBeGreaterThanOrEqual(previous - 1e-9);
    previous = at;
  }
});

test('the source clock never jumps', () => {
  /*
   * Continuity, sampled densely. A discontinuity is not a subtle timing error —
   * it teleports the subject mid-shot, which reads as a dropped frame or a
   * broken recording. The bound is the fastest catch-up any curve is allowed to
   * run (`1 / (1 - amount)`, doubled for reverse, which also has the segment's
   * own advance to make up) times the sample interval.
   */
  const dt = 0.001;
  for (const curve of strongCurves(2)) {
    const maxRate = 2 / (1 - curve.amount);
    let previous = curveOffsetSec(curve, 0);
    expect(previous, curve.kind).toBeCloseTo(0, 12);
    for (let local = dt; local <= 2.0001; local += dt) {
      const at = curveOffsetSec(curve, local);
      expect(Math.abs(at - previous), `${curve.kind} at ${local.toFixed(3)}s`).toBeLessThan(
        maxRate * dt + 1e-9,
      );
      previous = at;
    }
  }
});

test('a curve with no duration is refused at plan time, not at play time', () => {
  // Fail fast where a plan is being built. The alternative is a NaN offset in
  // the frame loop, which is the one place this project is not allowed to throw.
  expect(() => timeCurve('hold', 0)).toThrow(/duration/i);
  expect(() => timeCurve('stutter', 1, { stepSec: 0 })).toThrow(/step/i);
});
