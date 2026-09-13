import { expect, test } from 'vitest';
import { analyseTrack } from './beatMap.ts';

const RATE = 44100;

/**
 * A synthetic track: kicks at a known tempo over a sustained bass drone.
 *
 * The drone is the whole difficulty, and it is what bass-led electronic music
 * actually sounds like.
 * A naive "is the low end loud" detector fires continuously on it, and only
 * whitening — subtracting the sustained bass from the kick band — separates the
 * transient from the bed it sits on.
 */
function syntheticTrack(
  bpm: number,
  seconds: number,
  kickGain = 0.9,
  keep: (beat: number) => boolean = () => true,
): Float32Array {
  const samples = new Float32Array(Math.floor(RATE * seconds));
  const period = (60 / bpm) * RATE;

  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.35 * Math.sin((2 * Math.PI * 55 * i) / RATE);
  }
  for (let beat = 0; beat * period < samples.length; beat++) {
    if (!keep(beat)) continue;
    const start = Math.floor(beat * period);
    const length = Math.floor(RATE * 0.12);
    let phase = 0;
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / length;
      /*
       * A real kick sweeps: ~120 Hz down to ~45 Hz over the first few tens of
       * milliseconds, with a click on the front. An earlier version of this
       * fixture used a pure 60 Hz sine, which beats against the 55 Hz drone at
       * 5 Hz — so every fourth kick partially cancelled and the analyser looked
       * unreliable for a reason that exists nowhere outside this file.
       */
      const hz = 45 + 75 * Math.exp(-14 * t);
      phase += (2 * Math.PI * hz) / RATE;
      const click = t < 0.004 ? 0.35 * (1 - t / 0.004) : 0;
      samples[start + i] += kickGain * (Math.exp(-6 * t) * Math.sin(phase) + click);
    }
  }
  return samples;
}

test('the tempo of a track is recovered from the hits it is sure of', () => {
  /*
   * Note what is *not* asserted: that every kick was detected. The analyser is
   * deliberately strict — it reports the hits whose timing it can place within
   * a few milliseconds and stays quiet about the rest, because a vague
   * detection is worse than a missing one when the output is a cut. Recall
   * comes from the grid, not from lowering the bar.
   */
  const map = analyseTrack(syntheticTrack(140, 8), RATE);
  const expected = Math.ceil(8 / (60 / 140));

  expect(map.beats.length).toBeGreaterThan(expected / 2);
  expect(map.beats.length).toBeLessThanOrEqual(expected + 1);
  // One percent either side. The band was 136 to 144 and the reading sat at
  // 136.4, so the assertion passed on a tempo 2.6% slow with 0.4 to spare.
  expect(map.bpm).toBeGreaterThan(138.6);
  expect(map.bpm).toBeLessThan(141.4);
  expect(map.bpmConfidence).toBeGreaterThan(0.9);
});

test('each detected beat sits within 25 ms of a real one', () => {
  /*
   * The tolerance is the design. A cut 25 ms off the beat is imperceptible; a
   * cut 80 ms off is what makes an edit read as amateur, and it is the single
   * reason this analysis is offline rather than live — a real-time detector
   * cannot fire before the transient it is detecting.
   */
  const map = analyseTrack(syntheticTrack(140, 8), RATE);
  const period = 60 / 140;

  for (const t of map.beats) {
    const nearest = Math.round(t / period) * period;
    expect(Math.abs(t - nearest), `beat at ${t.toFixed(3)}s`).toBeLessThan(0.025);
  }
});

test('a track counted from some of its kicks is counted at its own tempo', () => {
  /*
   * The gaps are the whole point, and every real track has them: a detector
   * strict enough to be worth cutting to reports the hits it is sure of and
   * stays quiet about the rest. What that leaves is an interval set with two
   * modes in it, one beat and two, and the middle of such a set is the top of
   * the shorter mode rather than the beat itself. Read that way, a track played
   * at 140 counts as 136 — which is not a rounding error, because a bar length
   * derived from it walks away from the music for as long as the track runs.
   *
   * Every third kick is missing here by construction rather than by the
   * detector's choice, so this stays a test about counting even if detection
   * later improves.
   */
  for (const bpm of [90, 110, 128, 140, 150, 174]) {
    const map = analyseTrack(
      syntheticTrack(bpm, 12, 0.9, (beat) => beat % 3 !== 2),
      RATE,
    );

    // One percent. Wider than a 5 ms hop grid can resolve at these tempos, far
    // tighter than the gap between a tempo and the one its clusters suggest.
    expect(map.bpm, `${bpm} bpm`).toBeGreaterThan(bpm * 0.99);
    expect(map.bpm, `${bpm} bpm`).toBeLessThan(bpm * 1.01);
  }
});

test('a sustained bass drone alone produces no beats', () => {
  // The failure mode that makes a naive low-energy detector useless on this
  // genre: the bassline is louder than the kick and never stops.
  const drone = new Float32Array(RATE * 4);
  for (let i = 0; i < drone.length; i++) {
    drone[i] = 0.5 * Math.sin((2 * Math.PI * 55 * i) / RATE);
  }
  expect(analyseTrack(drone, RATE).beats.length).toBe(0);
});

test('a hi-hat pattern is not mistaken for a kick', () => {
  // The other direction: something percussive and regular, but in the wrong
  // octave. Cutting an edit to the hats instead of the kick is subtly, badly
  // wrong — twice or four times too fast, and nobody can say why it feels off.
  const hats = new Float32Array(RATE * 4);
  const period = RATE * 0.125;
  const noise = noiseSource(0x5eed);
  for (let hit = 0; hit * period < hats.length; hit++) {
    const start = Math.floor(hit * period);
    for (let i = 0; i < RATE * 0.03 && start + i < hats.length; i++) {
      const t = i / (RATE * 0.03);
      hats[start + i] = 0.8 * Math.exp(-18 * t) * (noise() * 2 - 1);
    }
  }
  expect(analyseTrack(hats, RATE).beats.length).toBe(0);
});

test('silence is silent, and the result is still well-formed', () => {
  const map = analyseTrack(new Float32Array(RATE * 2), RATE);
  expect(map.beats.length).toBe(0);
  expect(map.bpmConfidence).toBe(0);
  expect(map.durationSec).toBeCloseTo(2, 2);
  expect(Number.isFinite(map.bpm)).toBe(true);
  expect(map.energy.length).toBeGreaterThan(0);
});

test('the same samples always produce the same map', () => {
  /*
   * A replay must be identical every time it is watched, and two people
   * watching the same shared run must see the same edit. That rules out any
   * dependence on wall time, frame cadence or `Math.random`, all of which the
   * live detector has and this must not.
   */
  const samples = syntheticTrack(128, 5);
  const a = analyseTrack(samples, RATE);
  const b = analyseTrack(samples, RATE);
  expect(Array.from(b.beats)).toEqual(Array.from(a.beats));
  expect(Array.from(b.strength)).toEqual(Array.from(a.strength));
});

test('beats come out in order, with a strength for each', () => {
  // The director indexes the two arrays together and walks beats forward
  // without sorting; either assumption breaking is a silent mis-cut.
  const map = analyseTrack(syntheticTrack(150, 6), RATE);
  expect(map.strength.length).toBe(map.beats.length);
  for (let i = 1; i < map.beats.length; i++) {
    expect(map.beats[i]).toBeGreaterThan(map.beats[i - 1] ?? 0);
  }
  for (const s of map.strength) {
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  }
});

test('a quiet track is analysed on its own terms, not against an absolute floor', () => {
  /*
   * Thresholds adapt from a running mean and deviation rather than from fixed
   * levels, which is what lets one analyser work across tracks mastered ten
   * decibels apart. A player importing a quietly-mastered song must not get an
   * edit with no cuts in it.
   */
  const loud = analyseTrack(syntheticTrack(140, 6, 0.9), RATE);
  const quiet = analyseTrack(scale(syntheticTrack(140, 6, 0.9), 0.25), RATE);
  expect(quiet.beats.length).toBeGreaterThanOrEqual(loud.beats.length - 2);
});

function scale(samples: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) * factor;
  return out;
}

/**
 * A pinned noise source, so this file feeds the analyser the same track twice.
 *
 * The hats above were cut from `Math.random`, which made the *fixture* a new
 * track on every run while the analyser under it is deterministic by contract.
 * Measured over 6,000 draws, five of them put enough of the burst in the kick
 * band to clear its adaptive floor and report a single beat — about one run in
 * 1,200, which is a suite that goes red a few times a year for no reason
 * anybody present can reproduce. It cost one investigation already, recorded in
 * `docs/IMPROVEMENTS.md`.
 *
 * The seed is arbitrary and only has to stay put; nearly every other one passes
 * too. What this gives up is the sampling: one pinned pattern cannot discover a
 * sixth failure the way 6,000 draws did. That is the right trade for a gate,
 * whose job is to answer the same question the same way every time, and the
 * sampling belongs in a measurement run on purpose rather than in `npm test`.
 */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
