import { expect, test } from 'vitest';
import { RenderedPulse } from './renderedPulse.ts';

/**
 * Does the offline pulse find a kick where a kick is?
 *
 * The live detector is verified by eye — lights either move with the music or they do
 * not. This one can be checked, because its input is a buffer somebody wrote: put a
 * thump at a known second and ask what the level is there and elsewhere.
 */

/** A buffer with a 60 Hz burst at each of `atSec`, over near-silence. */
function withThumps(atSec: readonly number[], seconds = 3, rate = 48000): AudioBuffer {
  const length = Math.round(seconds * rate);
  const data = new Float32Array(length);
  for (const at of atSec) {
    const start = Math.round(at * rate);
    const burst = Math.round(0.05 * rate);
    for (let i = 0; i < burst && start + i < length; i++) {
      // A decaying 60 Hz cycle: a kick, near enough for a band-limited envelope.
      const decay = 1 - i / burst;
      data[start + i] = Math.sin((2 * Math.PI * 60 * i) / rate) * decay * 0.9;
    }
  }
  return {
    sampleRate: rate,
    length,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

test('the pulse peaks where the kick is and not between kicks', () => {
  const pulse = new RenderedPulse(withThumps([0.5, 1.5, 2.5]));

  // Just after each attack, the envelope is high; midway between, it has fallen.
  for (const at of [0.5, 1.5, 2.5]) {
    expect(pulse.at(at + 0.01), `on the kick at ${at}s`).toBeGreaterThan(0.4);
  }
  for (const at of [1.0, 2.0]) {
    expect(pulse.at(at), `between kicks at ${at}s`).toBeLessThan(0.2);
  }
});

test('the envelope rises fast and falls slowly', () => {
  /*
   * A light answers a kick's *attack*. An envelope that tracked energy both ways would
   * end the flash the moment the transient does, which reads as a flicker rather than a
   * pulse — so the fall is the part that has to be slow, and asymmetry is the property.
   */
  const pulse = new RenderedPulse(withThumps([1.0]));
  const before = pulse.at(0.98);
  // The peak is found rather than assumed: a real kick's band energy crests somewhere
  // inside its attack, and pinning the assertion to one millisecond would be testing
  // the shape of the test's own synthetic thump.
  let peak = 0;
  for (let at = 1.0; at < 1.06; at += 0.002) peak = Math.max(peak, pulse.at(at));

  expect(before, 'dark before the kick').toBeLessThan(0.1);
  expect(peak, 'rises on the attack').toBeGreaterThan(0.5);
  expect(pulse.at(1.12), 'still lit a tenth of a second later').toBeGreaterThan(0.1);
  expect(pulse.at(1.25), 'and down again by a quarter second').toBeLessThan(peak * 0.5);
});

test('a silent score never flashes, and a quiet one still does', () => {
  // Normalised against the clip's own loudest moment, because a light is a reaction to
  // the music and "loud" is relative. Absolute thresholds leave a quiet track dark.
  const silent = new RenderedPulse(withThumps([]));
  for (const at of [0, 0.5, 1, 2]) expect(silent.at(at), `silence at ${at}s`).toBeLessThan(0.001);

  const quiet = withThumps([1.0]);
  const data = quiet.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] *= 0.02;
  expect(new RenderedPulse(quiet).at(1.01), 'a quiet kick still reads').toBeGreaterThan(0.4);
});

test('a sustained bassline is not a kick', () => {
  /*
   * The hard problem, and the reason the reading is band-limited at all rather than a
   * plain RMS. A bass-led track's bassline sits at 140 Hz and never stops; a kick is 40 to
   * 110 and arrives. Measure energy without separating them and the lights sit at full
   * brightness for the whole clip, pulsing at nothing — which reads as broken rather
   * than as busy.
   *
   * `RHYTHM_BANDS` puts `bassline` at 95-180 Hz for exactly this, and the same numbers
   * drive the offline edit's cuts, so a light and a cut agree about what a kick is.
   */
  const rate = 48000;
  const seconds = 3;
  const length = Math.round(seconds * rate);
  const data = new Float32Array(length);
  // A loud, continuous 140 Hz bassline.
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 140 * i) / rate) * 0.8;
  // And a kick on each second, quieter than the bass it has to be found under.
  for (const at of [0.5, 1.5, 2.5]) {
    const start = Math.round(at * rate);
    const burst = Math.round(0.05 * rate);
    for (let i = 0; i < burst && start + i < length; i++) {
      const decay = 1 - i / burst;
      data[start + i] =
        (data[start + i] ?? 0) + Math.sin((2 * Math.PI * 60 * i) / rate) * decay * 0.5;
    }
  }
  const buffer = {
    sampleRate: rate,
    length,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => data,
  } as unknown as AudioBuffer;

  const pulse = new RenderedPulse(buffer);
  for (const at of [0.5, 1.5, 2.5]) {
    expect(pulse.at(at + 0.01), `the kick at ${at}s stands out`).toBeGreaterThan(0.4);
  }
  for (const at of [1.0, 2.0]) {
    expect(pulse.at(at), `the bassline alone at ${at}s stays dark`).toBeLessThan(0.3);
  }
});

test('reading the same score twice gives the same pulse', () => {
  // Determinism, extended to the lights: two exports of one run must flash identically.
  const buffer = withThumps([0.4, 1.2, 2.1]);
  const first = new RenderedPulse(buffer);
  const second = new RenderedPulse(buffer);
  for (let at = 0; at < 3; at += 0.017) {
    expect(second.at(at), `at ${at.toFixed(3)}s`).toBe(first.at(at));
  }
});
