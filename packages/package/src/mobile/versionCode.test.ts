import { describe, expect, it } from 'vitest';

import { versionCodeFor } from './versionCode.ts';

describe('versionCodeFor', () => {
  /*
   * Android orders upgrades by an integer and refuses to install a lower one over a higher one, so
   * this has to rise with the version name it is derived from.
   */
  it('rises with the version', () => {
    expect(versionCodeFor('1.4.2')).toBe(10402);
    expect(versionCodeFor('1.4.3')).toBeGreaterThan(versionCodeFor('1.4.2'));
    expect(versionCodeFor('1.5.0')).toBeGreaterThan(versionCodeFor('1.4.99'));
    expect(versionCodeFor('2.0.0')).toBeGreaterThan(versionCodeFor('1.99.99'));
  });

  /*
   * **Zero is not a version code**, and this is how the first Android build failed: a project with
   * no `package.json` has no version, `0.0.0` computes to 0, and Gradle refuses it with a message
   * about a positive integer rather than about the missing file.
   */
  it('never produces zero, whatever it is given', () => {
    expect(versionCodeFor('0.0.0')).toBe(1);
    expect(versionCodeFor('')).toBe(1);
    expect(versionCodeFor('not-a-version')).toBe(1);
  });

  /* A pre-release suffix is part of the name and not part of the ordering. */
  it('ignores what follows the numbers', () => {
    expect(versionCodeFor('1.4.2-rc.1')).toBe(10402);
  });
});
