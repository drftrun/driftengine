import { expect, test } from 'vitest';
import { KickDetector, kickPulseAfter } from './kickDetector.ts';

test('a pulse is gone well inside one beat at club tempo', () => {
  /*
   * At 140 BPM a beat is 428 ms. A pulse still standing when the next kick
   * lands turns a rhythm into a plateau — the light never comes back down, so
   * no individual hit reads as an event and the whole effect becomes "the
   * scene is slightly brighter now".
   */
  expect(kickPulseAfter(1, 0)).toBe(1);
  expect(kickPulseAfter(1, 0.2)).toBeLessThan(0.2);
  expect(kickPulseAfter(1, 0.4)).toBeLessThan(0.02);
});

test('the envelope only ever falls, and never below zero', () => {
  let previous = 2;
  for (let t = 0; t <= 1; t += 0.01) {
    const value = kickPulseAfter(1, t);
    expect(value, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(previous);
    expect(value).toBeGreaterThanOrEqual(0);
    previous = value;
  }
});

test('a weak hit produces a proportionally weak pulse', () => {
  // Strength has to survive into the light, or a fill and a downbeat flash
  // identically and the lighting stops describing the music.
  expect(kickPulseAfter(0.3, 0.05)).toBeLessThan(kickPulseAfter(1, 0.05));
  expect(kickPulseAfter(0.3, 0)).toBeCloseTo(0.3, 6);
});

test('a frame gap cannot revive or invert a pulse', () => {
  // A backgrounded tab hands back a delta of many seconds on the frame it
  // returns, and negative deltas turn up whenever a clock is stubbed or steps
  // backwards. Both must decay to rest rather than produce a flash.
  expect(kickPulseAfter(1, 60)).toBe(0);
  expect(kickPulseAfter(1, -1)).toBeLessThanOrEqual(1);
  expect(Number.isFinite(kickPulseAfter(1, -1))).toBe(true);
});

/*
 * A stub analyser, so the detector can be driven without an audio context.
 *
 * `getByteFrequencyData` is the whole interface that matters here: the detector reads bands out
 * of it and nothing else about a real `AnalyserNode` reaches its arithmetic. The spectrum is
 * described in hertz and painted into bins, because a band table in bins would silently stop
 * meaning the same thing if `RHYTHM_BANDS` ever moved.
 */
function analyserOf(
  bins: number,
  sampleRate: number,
  hzLevels: readonly [number, number, number][],
) {
  const nyquist = sampleRate / 2;
  /* Decibels, because that is what an analyser reports and what the detector reads. A level of
     0 is silence and reports -Infinity, exactly as a real one does. */
  const values = new Float32Array(bins).fill(-Infinity);
  for (const [lowHz, highHz, level] of hzLevels) {
    const from = Math.floor((lowHz / nyquist) * bins);
    const to = Math.max(from + 1, Math.floor((highHz / nyquist) * bins));
    const db = level > 0 ? 20 * Math.log10(level) : -Infinity;
    for (let i = from; i < to && i < bins; i++) values[i] = db;
  }
  return {
    frequencyBinCount: bins,
    fftSize: bins * 2,
    getFloatFrequencyData: (out: Float32Array) => out.set(values.subarray(0, out.length)),
    getByteTimeDomainData: (out: Uint8Array) => out.fill(128),
  } as unknown as AnalyserNode;
}

function detectorOver(wide: AnalyserNode) {
  const kick = analyserOf(256, 48_000, []);
  const bandpass = {
    frequency: { setTargetAtTime: () => {} },
  } as unknown as BiquadFilterNode;
  return new KickDetector({
    wide,
    kick,
    bandpass,
    context: { sampleRate: 48_000 } as unknown as BaseAudioContext,
  });
}

/*
 * The defect this exists to prevent: `energy` is the raw low bands with a gain, so on anything
 * mastered loud it pins at its own ceiling and a consumer driving a visual from it draws a
 * constant. Both spectra below are loud in the kick bands; they differ only in how much of that
 * low end the bassline explains, which is exactly the difference a listener hears.
 */
test('a level survives a loud master where energy saturates', () => {
  const loudKickQuietBass = detectorOver(
    analyserOf(512, 48_000, [
      [30, 60, 0.9],
      [60, 100, 0.9],
      [100, 180, 0.05],
      [180, 400, 0.05],
    ]),
  );
  const loudKickLoudBass = detectorOver(
    analyserOf(512, 48_000, [
      [30, 60, 0.9],
      [60, 100, 0.9],
      [100, 180, 0.9],
      [180, 400, 0.9],
    ]),
  );
  for (let frame = 0; frame < 8; frame++) {
    loudKickQuietBass.update(frame * 16);
    loudKickLoudBass.update(frame * 16);
  }

  /* Both are at the ceiling, so `energy` cannot tell them apart at all. */
  expect(loudKickQuietBass.energy).toBe(1);
  expect(loudKickLoudBass.energy).toBe(1);

  /* The level can, and that is the whole point of exposing it. */
  expect(loudKickQuietBass.level).toBeGreaterThan(loudKickLoudBass.level);
  expect(loudKickQuietBass.level).toBeGreaterThan(0);
});

test('the level stays inside its documented range on silence and on a wall of noise', () => {
  const silent = detectorOver(analyserOf(512, 48_000, []));
  const everything = detectorOver(analyserOf(512, 48_000, [[0, 24_000, 1]]));
  for (let frame = 0; frame < 8; frame++) {
    silent.update(frame * 16);
    everything.update(frame * 16);
  }
  expect(silent.level).toBe(0);
  expect(everything.level).toBeGreaterThanOrEqual(0);
  expect(everything.level).toBeLessThanOrEqual(1);
});
