import { expect, test } from 'vitest';
import { type StubNode, stubContext } from '../audioHarness.ts';
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

/**
 * **The slam's wet arm is late, and whatever it is summed with has to be as late.** An oversampled
 * `WaveShaperNode` is a pair of resampling filters around its curve, and they delay what passes by
 * an amount no specification fixes: measured 2026-09-19, 192 samples at 4x in Chrome and 128 in
 * `node-web-audio-api`. Nothing on the dry side waited, so a strike combed against the score it was
 * blended into — 1.6 dB of a full strike cancelled in Chrome, and a different comb on each
 * implementation. The alignment is the same oversampling around a curve that changes nothing, so
 * it is as late as the wet arm wherever it runs; `host/native/src/audio.test.ts` renders it.
 */
test('the alignment is the wet shaper’s oversampling around a curve that changes nothing', () => {
  const slam = slamInsert(stubContext() as unknown as BaseAudioContext, () => 0);
  type Shaper = StubNode & { curve: Float32Array; oversample: string };
  const wetShaper = (slam.wetGain as unknown as StubNode).inputs[0] as unknown as Shaper;
  const align = slam.align.output as unknown as Shaper;
  const into = slam.align.input as unknown as StubNode;
  expect(wetShaper.oversample, 'the wet arm is oversampled, or none of this arises').not.toBe(
    'none',
  );
  expect(align.oversample).toBe(wetShaper.oversample);
  expect(align.inputs).toContain(into);

  /*
   * What a sample comes out as, by the specification's curve lookup rather than by anything in the
   * code under test: v = (N − 1)(x + 1) / 2, the curve's ends past either side, linear between.
   */
  const curve = align.curve;
  const last = curve.length - 1;
  const shaped = (x: number): number => {
    const v = (last * (x * into.gain.value + 1)) / 2;
    if (v <= 0) return curve[0] as number;
    if (v >= last) return curve[last] as number;
    const k = Math.floor(v);
    return (1 - (v - k)) * (curve[k] as number) + (v - k) * (curve[k + 1] as number);
  };
  /* Silence stays silent, and two full-scale stems summed pass unclipped. */
  for (const x of [-2, -0.5, 0, 0.25, 1, 2]) expect(shaped(x)).toBeCloseTo(x, 6);
  expect(shaped(0)).toBe(0);
});
