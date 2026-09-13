import { expect, test } from 'vitest';
import { stubContext } from '../audioHarness.ts';
import { slamInsert } from './inserts.ts';

test('an idle slam is a dry path at unity and a wet path at zero', () => {
  /*
   * `graph.ts` says it in words: with a dry path at unity and a wet path at zero, an idle graph is
   * sample-identical to one without this stage in it. That sentence is why the identity gate can
   * pass across a rewrite that moved the slam into a bus, and this is it asserted rather than
   * believed — a wet path that came up at anything other than zero would colour every mix in the
   * engine and nothing else would report it.
   */
  const slam = slamInsert(stubContext() as unknown as BaseAudioContext, () => 0);
  expect(slam.dryGain.gain.value).toBe(1);
  expect(slam.wetGain.gain.value).toBe(0);
});

test('a slam below the threshold is a no-op rather than a whisper', () => {
  const slam = slamInsert(stubContext() as unknown as BaseAudioContext, () => 0);
  slam.strike(0.04);
  const ramps = (slam.wetGain.gain as unknown as { ramps: unknown[] }).ramps;
  expect(ramps.length, 'nothing was scheduled at all').toBe(0);
});
