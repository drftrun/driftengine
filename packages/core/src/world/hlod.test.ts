import { expect, test } from 'vitest';
import { HLOD_NONE, HlodSet, createHlodDraws } from './hlod.ts';
import type { HlodOptions } from './hlod.ts';

/**
 * One region ten metres square, errors 0, 0.5 and 2 metres, seen through a screen of 1,000 pixels
 * a metre at a metre's distance with a tolerance of one pixel: level 1 takes over at 500 m and
 * level 2 at 2,000 m. A band of 0.1 makes those coarsen past 550 and 2,200 and refine under 450
 * and 1,800; past 5,500 it is drawn at nothing, against a far limit of 5,000.
 *
 * The eye stands on the region's centre line, `d` metres beyond its face at x = 10, so its distance
 * to the box is exactly `d`.
 */
const BOX = [0, 0, 0, 10, 10, 10];
const ERRORS = [0, 0.5, 2];
const SCALE = 1000;
const EVERYWHERE = new Float32Array(24);
for (let p = 0; p < 6; p++) EVERYWHERE[p * 4 + 3] = 1;
const NOWHERE = EVERYWHERE.slice();
NOWHERE[3] = -1;

function set(options: Partial<HlodOptions> = {}): HlodSet {
  const hlod = new HlodSet({
    capacity: 4,
    pixelTolerance: 1,
    hysteresis: 0.1,
    fadeSec: 0,
    farDistance: 5000,
    ...options,
  });
  hlod.add(7, BOX, ERRORS);
  return hlod;
}

const draws = createHlodDraws(4);
const at = (d: number): number[] => [10 + d, 5, 5];

/** The level region 7 is drawn at from `d`, after one select; NONE when nothing is drawn. */
function levelFrom(hlod: HlodSet, d: number, frustum = EVERYWHERE): number {
  hlod.select(at(d), SCALE, frustum, null, 1, draws);
  return draws.count === 0 ? HLOD_NONE : (draws.level[0] as number);
}

test('A STILL EYE NEVER FLIPS A REGION, standing on a switch or wobbling across it inside the band', () => {
  const arriving = set();
  /* Arriving at 500 from nothing it refines only while under 450, so it stops at level 1. */
  for (let i = 0; i < 100; i++) expect(levelFrom(arriving, 500)).toBe(1);
  for (let i = 0; i < 100; i++) expect(levelFrom(arriving, i % 2 === 0 ? 460 : 540)).toBe(1);

  /* Arriving at the same 500 from the near side it stays at 0 until past 550: same distance,
     its own history, and neither ever moves while the eye does not. */
  const near = set();
  expect(levelFrom(near, 100)).toBe(0);
  for (let i = 0; i < 100; i++) expect(levelFrom(near, i % 2 === 0 ? 500 : 545)).toBe(0);
});

test('CROSSING A SWITCH AND COMING BACK returns the level the region had, and far is nothing', () => {
  const hlod = set();
  expect(levelFrom(hlod, 100)).toBe(0);
  expect(levelFrom(hlod, 600)).toBe(1);
  expect(levelFrom(hlod, 100)).toBe(0);
  expect(levelFrom(hlod, 2500), 'two levels in one step').toBe(2);
  expect(levelFrom(hlod, 100)).toBe(0);
  expect(levelFrom(hlod, 6000), 'past the far limit and its band').toBe(HLOD_NONE);
  expect(hlod.levelOf(7)).toBe(HLOD_NONE);
  expect(levelFrom(hlod, 4000)).toBe(2);
  /* A region nobody can see draws nothing, and keeps its level for when it is seen. */
  expect(levelFrom(hlod, 4000, NOWHERE)).toBe(HLOD_NONE);
  expect(hlod.levelOf(7)).toBe(2);

  /* Distance is to the box: a region two kilometres long whose end is under the eye is at its
     finest, where its centre, 990 m off, would have put it at level 1. */
  const long = new HlodSet({ capacity: 1, pixelTolerance: 1, hysteresis: 0.1, fadeSec: 0 });
  long.add(1, [0, 0, 0, 2000, 10, 10], ERRORS);
  long.select([1990, 5, 5], SCALE, EVERYWHERE, null, 1, draws);
  expect(draws.level[0]).toBe(0);
});

test("A CHANGE CROSSFADES as the pair +t and -t, over fadeSec of the caller's time, and a region arrives faded in", () => {
  const hlod = set({ fadeSec: 0.5 });
  /* Arriving: only the level coming in, at +t, since nothing was there before it. */
  hlod.select(at(100), SCALE, EVERYWHERE, null, 0.1, draws);
  expect(draws.count).toBe(1);
  expect(draws.level[0]).toBe(0);
  expect(draws.dither[0]).toBeCloseTo(0.2, 6);
  hlod.select(at(100), SCALE, EVERYWHERE, null, 1, draws);
  expect([draws.count, draws.dither[0]], 'settled, and whole').toEqual([1, 0]);

  /* 0 to 1: the arriving level at +t, the leaving one at -t, together every pixel once. */
  hlod.select(at(600), SCALE, EVERYWHERE, null, 0.1, draws);
  expect(draws.count).toBe(2);
  expect([draws.level[0], draws.level[1]]).toEqual([1, 0]);
  expect(draws.dither[0]).toBeCloseTo(0.2, 6);
  expect(draws.dither[1]).toBeCloseTo(-0.2, 6);

  /* A held clock holds the fade where it is. */
  hlod.select(at(600), SCALE, EVERYWHERE, null, 0, draws);
  expect(draws.dither[0]).toBeCloseTo(0.2, 6);

  /* Turned back at 0.2: level 0 arrives again from the share it still covered, 0.8. */
  hlod.select(at(100), SCALE, EVERYWHERE, null, 0, draws);
  expect([draws.level[0], draws.level[1]]).toEqual([0, 1]);
  expect(draws.dither[0]).toBeCloseTo(0.8, 6);
  expect(draws.dither[1]).toBeCloseTo(-0.8, 6);
  hlod.select(at(100), SCALE, EVERYWHERE, null, 0.2, draws);
  expect([draws.count, draws.level[0], draws.dither[0]]).toEqual([1, 0, 0]);

  /* Unseen mid-fade: the fade is over by the time it is seen again. */
  hlod.select(at(600), SCALE, EVERYWHERE, null, 0.1, draws);
  hlod.select(at(600), SCALE, NOWHERE, null, 0, draws);
  hlod.select(at(600), SCALE, EVERYWHERE, null, 0, draws);
  expect([draws.count, draws.level[0], draws.dither[0]]).toEqual([1, 1, 0]);

  /* A change under a held clock: nothing of the arriving level yet, and the leaving one whole —
     a dither of 0 on the arriving draw would have drawn it whole on top. */
  hlod.select(at(100), SCALE, EVERYWHERE, null, 0, draws);
  expect([draws.count, draws.level[0]]).toEqual([1, 1]);
  expect(draws.dither[0]).toBeCloseTo(0, 6);

  /* Redirected to a third level at 0.2 of the way from 1 to 0: it leaves from 1, which still
     covers 0.8 of the region, rather than from 0. */
  hlod.select(at(100), SCALE, EVERYWHERE, null, 0.1, draws);
  hlod.select(at(2500), SCALE, EVERYWHERE, null, 0.1, draws);
  expect([draws.count, draws.level[0], draws.level[1]]).toEqual([2, 2, 1]);
  expect(draws.dither[0]).toBeCloseTo(0.2, 6);
});

test('a removed region takes nothing of another with it', () => {
  const hlod = set();
  hlod.add(9, [100, 0, 0, 110, 10, 10], [0, 1]);
  hlod.select(at(600), SCALE, EVERYWHERE, null, 1, draws);
  hlod.remove(7);
  expect(hlod.size).toBe(1);
  expect(hlod.levelOf(9), 'region 9, 500 m from the eye, arrived at its level 0').toBe(0);
  /* 1,500 m from region 9, whose level 1 takes over at 1,000: its own two levels came with it. */
  hlod.select(at(1600), SCALE, EVERYWHERE, null, 1, draws);
  expect([draws.count, draws.region[0], draws.level[0]]).toEqual([1, 9, 1]);
  expect(() => hlod.add(9, BOX, ERRORS)).toThrow(/already/);
  expect(() => hlod.add(3, BOX, [1, 0.5])).toThrow(/finer/);
});
