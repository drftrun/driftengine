import { expect, test } from 'vitest';
import { fireLoopBuffer, waterLoopBuffer } from './synth.ts';

/**
 * A minimal stand-in for `BaseAudioContext`: buffer synthesis touches only
 * `createBuffer` and `sampleRate`, and a real context needs a browser.
 */
function fakeContext(sampleRate = 44100): BaseAudioContext {
  return {
    sampleRate,
    createBuffer(channels: number, length: number, rate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        length,
        sampleRate: rate,
        numberOfChannels: channels,
        duration: length / rate,
        getChannelData: (i: number) => data[i] ?? new Float32Array(0),
      };
    },
  } as unknown as BaseAudioContext;
}

/** Root-mean-square difference between neighbouring samples. */
function rmsStep(data: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < data.length; i++) sum += ((data[i] ?? 0) - (data[i - 1] ?? 0)) ** 2;
  return Math.sqrt(sum / Math.max(1, data.length - 1));
}

function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * Averaged over several buffers. Both measurements below are statistics of a
 * random signal, and a single draw of either swings far enough to pass a broken
 * implementation by luck — which is exactly what the first version of these
 * tests did.
 */
/**
 * How many buffers each statistic is averaged over.
 *
 * Sixteen, not four, and the reason is a flake: these beds are built from
 * `Math.random`, so every measurement here is a *statistic* rather than a value, and at
 * four trials the wrap-versus-step ratio crossed its 1.5 bound about one run in twenty.
 * A gate that fails at random teaches people to re-run it, which is worse than not
 * having it. Quadrupling the trials quarters the variance for a few milliseconds.
 */
const TRIALS = 16;

test('a bed joins to itself without a step, so the loop is not heard restarting', () => {
  /*
   * A click once per loop is the single thing that makes a bed read as a
   * recording being retriggered rather than as a fire that is still burning.
   * It is nearly inaudible in isolation and obvious after a minute underneath
   * everything else, which is how it survives listening tests.
   *
   * Stated as: the jump across the wrap is no larger than the jumps the signal
   * already makes inside itself. Without a crossfade the wrap is a difference
   * between two uncorrelated points of a smooth signal, which is several times
   * the sample-to-sample step.
   */
  for (const build of [fireLoopBuffer, waterLoopBuffer]) {
    let wrap = 0;
    let step = 0;
    for (let i = 0; i < TRIALS; i++) {
      const data = build(fakeContext(), 2).getChannelData(0);
      wrap += Math.abs((data[0] ?? 0) - (data[data.length - 1] ?? 0));
      step += rmsStep(data);
    }
    expect(wrap / step).toBeLessThan(1.5);
  }
});

test('the crossfade holds its level instead of dipping through the join', () => {
  /*
   * The obvious crossfade is linear, and between two uncorrelated noise signals
   * it loses about 3 dB in the middle: a hole punched in the bed once per loop.
   * Quieter than a click and more annoying, because it reads as the sound
   * breathing for no reason rather than as a defect.
   *
   * Measured across the middle of the fade, where a linear blend is at its
   * worst — averaged over the whole fade the dip is diluted enough to pass.
   */
  for (const build of [fireLoopBuffer, waterLoopBuffer]) {
    let ratio = 0;
    for (let i = 0; i < TRIALS; i++) {
      const data = build(fakeContext(), 2).getChannelData(0);
      const fade = Math.floor(data.length / 8);
      ratio +=
        rms(data, Math.floor(fade * 0.35), Math.floor(fade * 0.65)) / rms(data, fade, data.length);
    }
    expect(ratio / TRIALS).toBeGreaterThan(1);
  }
});

test('a bed stays inside the range an AudioBuffer can carry', () => {
  // Anything past ±1 clips on the way out, and a clipped bed under the whole
  // mix sounds like a broken speaker rather than like a loud fire.
  for (const build of [fireLoopBuffer, waterLoopBuffer]) {
    const data = build(fakeContext(), 2).getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(data[i] ?? 0)).toBeLessThanOrEqual(1);
    }
  }
});
