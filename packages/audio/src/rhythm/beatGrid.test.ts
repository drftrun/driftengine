import { expect, test } from 'vitest';
import { TapTempo, beatGrid } from './beatGrid.ts';

test('a grid is an ordinary beat map, so nothing downstream needs a special case', () => {
  const map = beatGrid(120, 0.25, 4);
  expect(map.bpm).toBe(120);
  expect(map.bpmConfidence).toBe(1);
  expect(Array.from(map.beats)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]);
  expect(map.strength.length).toBe(map.beats.length);
  expect(map.durationSec).toBe(4);
});

test('an offset past one beat wraps rather than skipping the start of the clip', () => {
  // A player nudging the offset will run it past a whole beat without thinking
  // about it, and a grid that then began a second in would silently lose the
  // opening cut.
  const map = beatGrid(120, 1.75, 3);
  expect(map.beats[0]).toBeCloseTo(0.25, 6);
});

test('tap tempo ignores the one tap that was late', () => {
  /*
   * Somebody tapping along to a track will fumble one, and a mean over four
   * intervals turns a single 400 ms fumble into a double-digit BPM error —
   * audible as drift within about ten seconds of edit. The median does not
   * care.
   */
  const tap = new TapTempo();
  for (const t of [0, 500, 1000, 1900, 2000, 2500]) tap.tap(t);
  expect(tap.bpm).toBeGreaterThan(115);
  expect(tap.bpm).toBeLessThan(125);
});

test('too few taps is no answer rather than a wrong one', () => {
  const tap = new TapTempo();
  tap.tap(0);
  tap.tap(500);
  expect(tap.bpm, 'two taps is one interval, which is a guess').toBe(null);
  tap.tap(1000);
  tap.tap(1500);
  expect(tap.bpm).toBeCloseTo(120, 5);
});

test('a stale tap starts a new count', () => {
  // Walking away and coming back must not average across the gap — which would
  // produce a tempo of about two beats a minute and a clip with one cut in it.
  const tap = new TapTempo();
  for (const t of [0, 500, 1000, 1500]) tap.tap(t);
  tap.tap(30_000);
  expect(tap.bpm).toBe(null);
});

test('an absurd tempo is refused', () => {
  // A double-tap reads as 600 BPM, which would ask the director to cut every
  // 100 ms; a very slow one asks it never to cut at all.
  const fast = new TapTempo();
  for (const t of [0, 40, 80, 120]) fast.tap(t);
  expect(fast.bpm).toBe(null);

  const slow = new TapTempo();
  for (const t of [0, 4000, 8000, 12_000]) slow.tap(t);
  expect(slow.bpm).toBe(null);
});

test('the phase is the last tap, so the grid lands where the player was tapping', () => {
  /*
   * The point of tapping is not the tempo — a player could type that. It is the
   * *phase*: where the downbeat falls in the sound they are going to add in
   * TikTok. A grid at the right tempo and the wrong phase is off by up to half
   * a beat everywhere, which is worse than not syncing at all.
   */
  const tap = new TapTempo();
  for (const t of [1000, 1500, 2000, 2500]) tap.tap(t);
  expect(tap.offsetSec).toBeCloseTo(2.5, 3);
});

test('resetting forgets everything', () => {
  const tap = new TapTempo();
  for (const t of [0, 500, 1000, 1500]) tap.tap(t);
  tap.reset();
  expect(tap.bpm).toBe(null);
});
