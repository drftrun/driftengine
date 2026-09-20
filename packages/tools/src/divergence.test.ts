import { describe, expect, it } from 'vitest';
import { divergenceIsUnaccounted, divergentComponents } from './divergence.ts';

describe('which component differs', () => {
  const out: string[] = [];

  it('names the ones whose hashes disagree', () => {
    const ours = new Map([
      ['Transform', 'aa'],
      ['Health', 'cc'],
      ['Velocity', 'ee'],
    ]);
    const theirs = new Map([
      ['Transform', 'bb'],
      ['Health', 'cc'],
      ['Velocity', 'ff'],
    ]);
    expect(divergentComponents(ours, theirs, out)).toBe(2);
    expect(out).toEqual(['Transform', 'Velocity']);
  });

  it('names one that only one side has, which is the loudest kind', () => {
    /* One peer created or destroyed something the other did not. */
    const ours = new Map([['Transform', 'aa']]);
    const theirs = new Map([
      ['Transform', 'aa'],
      ['Spawned', 'zz'],
    ]);
    expect(divergentComponents(ours, theirs, out)).toBe(1);
    expect(out).toEqual(['Spawned']);
    expect(divergentComponents(theirs, ours, out)).toBe(1);
    expect(out).toEqual(['Spawned']);
  });

  it('reuses the array it was given', () => {
    const ours = new Map([['A', '1']]);
    divergentComponents(ours, new Map([['A', '2']]), out);
    expect(out).toEqual(['A']);
    divergentComponents(ours, ours, out);
    expect(out).toEqual([]);
  });
});

describe('a difference nobody hashed', () => {
  it('is reported honestly rather than as agreement', () => {
    const agreeing = new Map([['Transform', 'aa']]);
    /* The whole-world fingerprints disagree and every recorded component matches: the state that
       differs was not in the breakdown, and saying "everything is fine" would be provably wrong. */
    expect(divergentComponents(agreeing, agreeing, [])).toBe(0);
    expect(divergenceIsUnaccounted(0, true)).toBe(true);
  });

  it('is not claimed when the components already explain it', () => {
    expect(divergenceIsUnaccounted(2, true)).toBe(false);
  });

  it('is not claimed when the worlds agree', () => {
    expect(divergenceIsUnaccounted(0, false)).toBe(false);
  });
});
