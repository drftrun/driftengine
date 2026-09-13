import { expect, test } from 'vitest';

import { analyseTrack } from './beatMap.ts';
import { KickDetector } from './kickDetector.ts';
import { KickCore } from './kickCore.ts';

const RATE = 48_000;
const BPM = 140;
const BEAT_SEC = 60 / BPM;
const DURATION_SEC = 16;

/** Kicks on 1 and 3 over a moving bassline and hats, which is the case the gates exist for. */
function kickTimes(): number[] {
  const times: number[] = [];
  for (let beat = 0; beat * BEAT_SEC < DURATION_SEC; beat++) {
    if (beat % 4 === 0 || beat % 4 === 2) times.push(beat * BEAT_SEC);
  }
  return times;
}

function render(): Float32Array {
  const samples = new Float32Array(RATE * DURATION_SEC);
  const kicks = kickTimes();
  let bassPhase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (const at of kicks) {
      const dt = t - at;
      if (dt >= 0 && dt < 0.12) v += Math.sin(2 * Math.PI * 55 * dt) * Math.exp(-dt * 26) * 0.9;
    }
    /* Phase-continuous, so a note change is a change of pitch rather than a click that would
       itself read as a transient and make this test measure the stimulus. */
    const note = 110 + (Math.floor(t / BEAT_SEC) % 4) * 12;
    bassPhase += (2 * Math.PI * note) / RATE;
    v += Math.sin(bassPhase) * 0.3;
    const hatDt = t % (BEAT_SEC / 2);
    if (hatDt < 0.02) v += ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.2 * (1 - hatDt / 0.02);
    samples[i] = Math.max(-1, Math.min(1, v));
  }
  return samples;
}

/**
 * The claim both analysers' headers make, as a test rather than a comment.
 *
 * They were two copies of one decision, and copies drift: when this was written the live one
 * whitened differently, smoothed at whatever rate its consumer happened to call it, and read a
 * decibel scale where the offline one reads linear amplitude. Nothing in either file said so.
 */
test('the live detector finds the same kicks the offline analyser does', () => {
  const samples = render();
  const map = analyseTrack(samples, RATE);

  /* The live path reads analysers rather than samples, so it is driven from the same signal
     through a stub that reports the band magnitudes of a window around each frame. */
  const bins = 1024;
  const nyquist = RATE / 2;
  let frameAt = 0;
  const magnitudes = new Float32Array(bins);
  const analyser = {
    frequencyBinCount: bins,
    fftSize: bins * 2,
    getFloatFrequencyData: (out: Float32Array) => {
      /* One naive DFT magnitude per bin over a short window: enough to give the detector a real
         spectrum without pulling an FFT into a test. */
      const window = 1024;
      const start = Math.max(0, Math.min(samples.length - window, Math.round(frameAt * RATE)));
      for (let bin = 0; bin < out.length; bin++) {
        const hz = (bin / out.length) * nyquist;
        if (hz > 4000) {
          out[bin] = -120;
          continue;
        }
        let re = 0;
        let im = 0;
        const w = (2 * Math.PI * hz) / RATE;
        for (let n = 0; n < window; n += 4) {
          const x = samples[start + n] ?? 0;
          re += x * Math.cos(w * n);
          im += x * Math.sin(w * n);
        }
        const magnitude = (Math.sqrt(re * re + im * im) * 4) / window;
        out[bin] = magnitude > 1e-7 ? 20 * Math.log10(magnitude) : -120;
      }
      magnitudes.set(out.subarray(0, magnitudes.length));
    },
    getByteTimeDomainData: (out: Uint8Array) => out.fill(128),
  } as unknown as AnalyserNode;

  const detector = new KickDetector({
    wide: analyser,
    kick: analyser,
    bandpass: { frequency: { setTargetAtTime: () => {} } } as unknown as BiquadFilterNode,
    context: { sampleRate: RATE, currentTime: 0 } as unknown as BaseAudioContext,
  });

  const live: number[] = [];
  let previous = 0;
  for (let step = 0; step * (1 / 60) < DURATION_SEC; step++) {
    frameAt = step / 60;
    detector.update(frameAt * 1000);
    if (detector.pulse > previous + 0.01) live.push(frameAt);
    previous = detector.pulse;
  }

  /*
   * Within a tenth of a second, which is the window a listener would call the same hit: the two
   * measure the spectrum differently by construction (a filter bank over samples against an FFT
   * over a window), so what has to agree is where the kicks are, not the third decimal place.
   */
  const offline = [...map.beats];
  const matched = offline.filter((at) => live.some((v) => Math.abs(v - at) < 0.1));
  expect(offline.length).toBeGreaterThan(4);
  expect(matched.length / offline.length).toBeGreaterThan(0.8);
});

/**
 * The property that made the drift invisible: one set of constants, one meaning, any step.
 *
 * Settled rather than per step, and the difference is worth stating. Every envelope here is
 * exactly rate-independent on its own, but the deviation trackers follow `|x - mean|` against a
 * mean that is itself still moving, and an absolute value is not linear, so two step sizes take
 * slightly different paths through a transient before landing in the same place. Measured: at
 * two seconds the energy floors differ in the fourth decimal, at ten they are identical.
 */
test('the core reaches the same state whatever step it is advanced in', () => {
  const bands = {
    sub: 0.4,
    punch: 0.35,
    sweet: 0.2,
    bassline: 0.1,
    mud: 0.05,
    lowMid: 0.04,
    high: 0.02,
  };
  const coarse = new KickCore();
  const fine = new KickCore();
  for (let t = 0; t < 10; t += 1 / 60) coarse.step(bands, 1 / 60);
  for (let t = 0; t < 10; t += 1 / 240) fine.step(bands, 1 / 240);
  expect(fine.whitened).toBeCloseTo(coarse.whitened, 8);
  expect(fine.onsetFloor).toBeCloseTo(coarse.onsetFloor, 8);
  expect(fine.energyFloor).toBeCloseTo(coarse.energyFloor, 8);
});
