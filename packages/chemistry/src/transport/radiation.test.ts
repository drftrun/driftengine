import { describe, expect, it } from 'vitest';
import {
  RadiativeSources,
  STEFAN_BOLTZMANN,
  convectiveCoefficient,
  radiantFlux,
  sourceRange,
} from './radiation.ts';

describe('radiantFlux', () => {
  it('is the Stefan-Boltzmann law through a point-source view factor', () => {
    /* A square metre of flame at 1200 K seen from one metre away, straight on. */
    const flux = radiantFlux(1200, 1, 293.15, 0.9, 1, 1);
    const expected = (0.9 * STEFAN_BOLTZMANN * 1 * (1200 ** 4 - 293.15 ** 4)) / Math.PI;
    expect(flux).toBeCloseTo(expected, 6);
  });

  it('FALLS AS ONE OVER R SQUARED, which is what makes distance mean anything', () => {
    /*
     * **The single relationship the whole track is built on.** `§10`: move a log twice as far from
     * a fire and it takes four times as long to catch. One line of arithmetic, and without it
     * "leading a piece of wood near the fire" has no right answer at all.
     */
    const near = radiantFlux(1200, 1, 293.15, 0.9, 0.5, 1);
    const far = radiantFlux(1200, 1, 293.15, 0.9, 1.0, 1);
    const further = radiantFlux(1200, 1, 293.15, 0.9, 2.0, 1);
    expect(near / far).toBeCloseTo(4, 6);
    expect(far / further).toBeCloseTo(4, 6);
  });

  it('goes as the fourth power of the source temperature', () => {
    /* Halving a flame's temperature cuts its radiation sixteenfold, which is why a cool smoulder
       warms nothing across a room and a flame at 1200 K sets fire to it. */
    const hot = radiantFlux(1200, 1, 293.15, 0.9, 1, 1);
    const cool = radiantFlux(600, 1, 293.15, 0.9, 1, 1);
    expect(hot / cool).toBeGreaterThan(15);
  });

  it('reverses when the surface is hotter than the source', () => {
    expect(radiantFlux(300, 1, 1000, 0.9, 1, 1)).toBeLessThan(0);
  });

  it('is zero looking edge-on and full looking straight at it', () => {
    expect(radiantFlux(1200, 1, 293.15, 0.9, 1, 0)).toBe(0);
    expect(radiantFlux(1200, 1, 293.15, 0.9, 1, -0.5)).toBe(0);
    expect(radiantFlux(1200, 1, 293.15, 0.9, 1, 0.5)).toBeCloseTo(
      radiantFlux(1200, 1, 293.15, 0.9, 1, 1) * 0.5,
      9,
    );
  });

  it('does not blow up at zero distance', () => {
    /* A point source is wrong close in, and the honest failure is a bounded number rather than an
       infinite one. Clamped at the source's own size, which is where the approximation ends. */
    const touching = radiantFlux(1200, 1, 293.15, 0.9, 0, 1);
    expect(Number.isFinite(touching)).toBe(true);
    expect(touching).toBeGreaterThan(0);
  });
});

describe('sourceRange', () => {
  it('grows with the square root of the power, so a big fire reaches further', () => {
    const small = sourceRange(10000, 1000);
    const big = sourceRange(160000, 1000);
    expect(big / small).toBeCloseTo(4, 6);
  });

  it('is zero for a source with no power', () => {
    expect(sourceRange(0, 1000)).toBe(0);
  });
});

describe('convectiveCoefficient', () => {
  it('is natural convection in still air and forced convection in a wind', () => {
    /* 2 to 25 W/m²K natural, up to about 250 forced. */
    const still = convectiveCoefficient(0);
    expect(still).toBeGreaterThan(2);
    expect(still).toBeLessThan(25);
    const gale = convectiveCoefficient(20);
    expect(gale).toBeGreaterThan(50);
    expect(gale).toBeLessThanOrEqual(250);
  });

  it('rises with speed and never above its ceiling', () => {
    let previous = 0;
    for (const speed of [0, 1, 3, 10, 30, 100]) {
      const h = convectiveCoefficient(speed);
      expect(h).toBeGreaterThanOrEqual(previous);
      expect(h).toBeLessThanOrEqual(250);
      previous = h;
    }
  });
});

describe('RadiativeSources', () => {
  it('gathers and clears without allocating a list per tick', () => {
    const sources = new RadiativeSources();
    expect(sources.count).toBe(0);
    sources.add(0, 0, 0, 1200, 0.5, 60000);
    sources.add(5, 0, 0, 900, 0.2, 10000);
    expect(sources.count).toBe(2);
    expect(sources.temperatureOf(0)).toBe(1200);
    expect(sources.areaOf(1)).toBe(0.2);
    sources.clear();
    expect(sources.count).toBe(0);
  });

  it('reports whether a point is within a source’s reach', () => {
    const sources = new RadiativeSources();
    sources.add(0, 0, 0, 1200, 0.5, 60000);
    expect(sources.reaches(0, 0.4, 0, 0)).toBe(true);
    expect(sources.reaches(0, 500, 0, 0)).toBe(false);
  });

  it('sums the flux a point receives from everything that can see it', () => {
    const sources = new RadiativeSources();
    sources.add(0, 0, 0, 1200, 1, 60000);
    sources.add(0, 0, 0, 1200, 1, 60000);
    const one = new RadiativeSources();
    one.add(0, 0, 0, 1200, 1, 60000);
    expect(sources.fluxAt(1, 0, 0, 293.15, 0.9, null)).toBeCloseTo(
      2 * one.fluxAt(1, 0, 0, 293.15, 0.9, null),
      9,
    );
  });

  it('lets an occluder cut a source out entirely', () => {
    const sources = new RadiativeSources();
    sources.add(0, 0, 0, 1200, 1, 60000);
    const clear = sources.fluxAt(1, 0, 0, 293.15, 0.9, null);
    expect(clear).toBeGreaterThan(0);
    expect(sources.fluxAt(1, 0, 0, 293.15, 0.9, () => true)).toBe(0);
    expect(sources.fluxAt(1, 0, 0, 293.15, 0.9, () => false)).toBeCloseTo(clear, 9);
  });

  it('grows past its initial capacity without losing a source', () => {
    const sources = new RadiativeSources();
    for (let i = 0; i < 200; i++) sources.add(i, 0, 0, 1000 + i, 1, 1000);
    expect(sources.count).toBe(200);
    for (let i = 0; i < 200; i++) expect(sources.temperatureOf(i)).toBe(1000 + i);
  });
});
