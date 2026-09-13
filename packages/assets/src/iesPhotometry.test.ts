import { describe, expect, it } from 'vitest';

import { readIesProfile } from './iesPhotometry.ts';

/**
 * The smallest legal LM-63 file: a header, the ten-number line, the seven-number line, then the
 * angle lists and the candela values.
 *
 * Written out rather than fetched, because the whole point of the assertions below is that the
 * numbers coming out are the numbers going in and a real fixture file would make that unreadable.
 */
function file(vertical: number[], horizontal: number[], candela: number[]): string {
  return [
    'IESNA:LM-63-2002',
    '[TEST] a hand-built fixture',
    'TILT=NONE',
    /* lamps, lumens per lamp, multiplier, vertical count, horizontal count, type, units, w, l, h */
    `1 1000 1 ${vertical.length} ${horizontal.length} 1 2 0 0 0`,
    /* ballast factor, future use, input watts */
    '1 1 100',
    vertical.join(' '),
    horizontal.join(' '),
    candela.join(' '),
  ].join('\n');
}

describe('the IES photometric reader', () => {
  /*
   * **The candela values come through multiplied, and by both factors.** LM-63 has a `multiplier`
   * on the ten-number line and a `ballast factor` on the seven-number line, and a fixture's real
   * output is the product of the three. Dropping either is a profile that is uniformly too dim,
   * which reads as the light having been authored wrong rather than as the file being misread.
   */
  it('reads the angles and the candela grid', () => {
    const profile = readIesProfile(file([0, 45, 90], [0], [1000, 500, 0]));
    expect(Array.from(profile.verticalAngles)).toEqual([0, 45, 90]);
    expect(Array.from(profile.horizontalAngles)).toEqual([0]);
    expect(Array.from(profile.candela)).toEqual([1000, 500, 0]);
    expect(profile.maxCandela).toBe(1000);
  });

  it('applies the multiplier and the ballast factor', () => {
    const text = file([0, 90], [0], [100, 50])
      .replace('1 1000 1 2 1 1 2 0 0 0', '1 1000 2 2 1 1 2 0 0 0')
      .replace('1 1 100', '1.5 1 100');
    const profile = readIesProfile(text);
    /* Hand-derived: 100 * 2 * 1.5 = 300, and 50 * 2 * 1.5 = 150. */
    expect(Array.from(profile.candela)).toEqual([300, 150]);
    expect(profile.maxCandela).toBe(300);
  });

  /*
   * **A list may wrap, and most real files wrap.** LM-63 is whitespace-delimited with no meaning
   * attached to a line break, so a reader that parses line by line works on a hand-built fixture
   * and fails on every file a manufacturer publishes.
   */
  it('reads a list that wraps across lines', () => {
    const text = [
      'IESNA:LM-63-2002',
      'TILT=NONE',
      '1 1000 1 4 1 1 2 0 0 0',
      '1 1 100',
      '0 30',
      '60 90',
      '0',
      '400 300',
      '200 100',
    ].join('\n');
    const profile = readIesProfile(text);
    expect(Array.from(profile.verticalAngles)).toEqual([0, 30, 60, 90]);
    expect(Array.from(profile.candela)).toEqual([400, 300, 200, 100]);
  });

  /*
   * More than one horizontal plane is the ordinary case for anything not axially symmetric — a wall
   * washer, a street light — and the grid is stored horizontal-major, which is the order LM-63
   * writes it in. A reader that assumes symmetry silently transposes those fixtures.
   */
  it('reads a grid with more than one horizontal plane', () => {
    const profile = readIesProfile(file([0, 90], [0, 90], [100, 50, 20, 10]));
    expect(Array.from(profile.horizontalAngles)).toEqual([0, 90]);
    expect(Array.from(profile.candela)).toEqual([100, 50, 20, 10]);
    expect(profile.maxCandela).toBe(100);
  });

  /*
   * Refusals name what was found. A profile that silently comes back empty is a light with no
   * distribution at all, which looks exactly like a light nobody aimed.
   */
  it('refuses a file with no IESNA signature', () => {
    expect(() => readIesProfile('not a photometric file')).toThrow(/IESNA/);
  });

  it('refuses a TILT it cannot honour, by name', () => {
    const tilted = file([0], [0], [1]).replace('TILT=NONE', 'TILT=INCLUDE');
    expect(() => readIesProfile(tilted)).toThrow(/TILT=INCLUDE/);
  });

  it('refuses a grid whose size does not match its angle counts', () => {
    /* Two vertical angles and one horizontal plane needs two values; this gives three. */
    expect(() => readIesProfile(file([0, 90], [0], [1, 2, 3]))).toThrow(/2/);
  });
});
