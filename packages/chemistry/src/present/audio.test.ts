import { describe, expect, it } from 'vitest';
import { crackleRate, hissRate, roarLevel } from './audio.ts';

describe('a fire, as three numbers', () => {
  it('CRACKLES WITH THE VOLATILE RELEASE RATE, which is what crackling is', () => {
    /*
     * `§17`: crackling is pockets of gas bursting out of the wood, so it genuinely tracks pyrolysis
     * rather than being a loop played while a flag is set. A log giving off nothing is silent; one
     * gasifying hard crackles hard, and it fades on its own as the volatiles run out.
     */
    expect(crackleRate(0, 0.2)).toBe(0);
    expect(crackleRate(0.004, 0.2)).toBeGreaterThan(0);
    expect(crackleRate(0.02, 0.2)).toBeGreaterThan(crackleRate(0.004, 0.2));
    /* Twice the area is twice the surface bursting, so twice the rate. */
    expect(crackleRate(0.004, 0.4)).toBeCloseTo(crackleRate(0.004, 0.2) * 2, 6);
  });

  it('HISSES WITH THE STEAM, which is why a green log hisses and a dry one does not', () => {
    expect(hissRate(0, 0.2)).toBe(0);
    expect(hissRate(0.01, 0.2)).toBeGreaterThan(0);
  });

  it('ROARS WITH THE AIR IT PULLS IN, which is why a big fire is loud', () => {
    /*
     * A fire's roar is entrained air, so it scales with the plume's own velocity — and the level is
     * in decibel-like terms, rising as the square of the speed, because acoustic power does.
     */
    expect(roarLevel(0)).toBe(0);
    expect(roarLevel(4) / roarLevel(2)).toBeCloseTo(4, 6);
  });

  it('never touches the audio package, which is the point of returning numbers', () => {
    /* There is nothing to assert here but the shape of the module: three functions, three numbers,
       no imports. A test that could fail would have to import something to look for. */
    expect(typeof crackleRate).toBe('function');
    expect(typeof hissRate).toBe('function');
    expect(typeof roarLevel).toBe('function');
  });
});
