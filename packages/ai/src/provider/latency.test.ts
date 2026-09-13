/**
 * The p90 the continuation watermark reads.
 *
 * The watermark issues the next request when the current intent's remaining extent
 * falls to this number, so a fast provider is asked late against fresher context and
 * a slow one early because it has to be. That is the whole reason it is measured
 * rather than configured: a constant would be wrong on every device and wrong again
 * the moment a consumer switched providers.
 */
import { describe, expect, it } from 'vitest';
import { LatencyEstimator } from './latency.ts';

describe('LatencyEstimator', () => {
  it('answers -1 until it has enough samples', () => {
    const estimator = new LatencyEstimator(64, 8);

    for (let i = 0; i < 7; i++) {
      estimator.record(100);
      expect(estimator.p90).toBe(-1);
    }

    estimator.record(100);
    expect(estimator.p90).toBe(100);
    expect(estimator.samples).toBe(8);
  });

  it('lands within one of the ninetieth percentile', () => {
    const estimator = new LatencyEstimator(128, 8);
    for (let ms = 1; ms <= 100; ms++) estimator.record(ms);

    expect(Math.abs(estimator.p90 - 90)).toBeLessThanOrEqual(1);
  });

  it('forgets past its capacity, so a provider that got faster is reported faster', () => {
    const estimator = new LatencyEstimator(16, 8);
    for (let i = 0; i < 16; i++) estimator.record(3000);
    expect(estimator.p90).toBe(3000);

    for (let i = 0; i < 16; i++) estimator.record(40);

    /* Sixteen recordings is the whole window, so nothing of the slow era survives.
       An unbounded estimator would carry a cold start into every later measurement. */
    expect(estimator.p90).toBe(40);
  });

  it('describes neither mode of a bimodal provider, which is the documented blind spot', () => {
    /*
     * A cache-hit-or-miss provider is what the design names as falsifying the p90
     * choice, and this is where that shows. At exactly one slow request in ten the
     * ninetieth percentile sits *at* the fast mode, so the watermark under-leads for
     * precisely the tenth that needed the lead — the agent asks late and drops to its
     * floor on every miss.
     *
     * Asserted rather than avoided by choosing a friendlier ratio. The fix when this
     * is measured in the wild is a per-request estimate from the request's own shape,
     * not a different percentile, and this test is what would justify building it.
     */
    const tenPercent = new LatencyEstimator(64, 8);
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 9; i++) tenPercent.record(40);
      tenPercent.record(3000);
    }
    expect(tenPercent.p90).toBe(40);

    /* One slow request in five, and it flips to the slow mode. The estimator is not
       broken; it is answering the question it was asked, and the question stops being
       the useful one somewhere between these two ratios. */
    const twentyPercent = new LatencyEstimator(64, 8);
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 4; i++) twentyPercent.record(40);
      twentyPercent.record(3000);
    }
    expect(twentyPercent.p90).toBe(3000);
  });

  it('holds a bounded number of samples however many are recorded', () => {
    const estimator = new LatencyEstimator(32, 8);
    for (let i = 0; i < 10_000; i++) estimator.record(i % 500);

    expect(estimator.samples).toBe(32);
  });
});
