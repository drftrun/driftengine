import { describe, expect, it } from 'vitest';

import { electronMajor } from './runtimeVersion.ts';

describe('electronMajor', () => {
  it('reads the plain triple the main process reports', () => {
    expect(electronMajor('43.4.1')).toBe(43);
    expect(electronMajor('33.4.11')).toBe(33);
  });

  /** What an installed package can carry, and what a build reads out of it. */
  it('reads a prerelease the way npm writes one', () => {
    expect(electronMajor('44.0.0-beta.7')).toBe(44);
    expect(electronMajor(' 44.0.0 ')).toBe(44);
  });

  /*
   * A plan that guessed a major it could not read would be worse than one that says it does not
   * know: the unknown answer keeps the switch, and a wrong answer would drop it.
   */
  it('answers nothing rather than guessing', () => {
    for (const value of ['', 'latest', 'v43', undefined, null, '0.0.0']) {
      expect(electronMajor(value)).toBe(null);
    }
  });
});
