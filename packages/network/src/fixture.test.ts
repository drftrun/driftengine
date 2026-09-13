/**
 * Both arms of the conformance fixture, and what each one is asserted to be.
 *
 * **Not that they agree with each other.** Fixed point truncates where floating point rounds, so
 * they diverge within a few ticks by design, and a test claiming otherwise would be asserting
 * something false. What each must be is reproducible: identical to itself run twice, and identical
 * to a digest committed here — which is what another machine compares against.
 */
import { describe, expect, it } from 'vitest';
import { exactCos, exactSin } from '@driftengine/core';
import { createFixture } from './fixture.ts';

const fixture = createFixture({ sin: exactSin, cos: exactCos });

describe('the conformance fixture', () => {
  it('is reproducible in doubles', () => {
    expect(fixture.runFloat(600).digest).toBe(fixture.runFloat(600).digest);
  });

  it('is reproducible in fixed point', () => {
    expect(fixture.runFixed(600).digest).toBe(fixture.runFixed(600).digest);
  });

  /**
   * The two arms differ, and saying so is the honest assertion.
   *
   * If they ever match, one of them has stopped doing its own arithmetic — most likely the fixed
   * arm falling back to doubles somewhere, which would make the whole second arm decorative.
   */
  it('the two arms disagree, because they are two different arithmetics', () => {
    expect(fixture.runFixed(600).digest).not.toBe(fixture.runFloat(600).digest);
  });

  /**
   * **Measured on V8 / x86-64 on 2026-09-03.** Another machine must produce these.
   *
   * `scripts/exactness-cross.mjs` prints them for pasting. A change to `math/exact.ts`, to
   * `simNumber.ts`, or to the fixture itself moves them, which is what should fail a suite.
   */
  it('produces the committed digests', () => {
    expect(fixture.runFloat(1).digest).toBe('034856de49aedf62');
    expect(fixture.runFloat(600).digest).toBe('880e84f536aadca5');
    expect(fixture.runFixed(1).digest).toBe('8d6a114be7fe0d91');
    expect(fixture.runFixed(600).digest).toBe('33e6de2f06b34870');
  });

  it('actually moves the bodies, so the digests are of a simulation rather than of a start state', () => {
    const still = fixture.runFloat(0);
    const moved = fixture.runFloat(600);
    expect(moved.digest).not.toBe(still.digest);
    /* The bodies steer toward each other and circle, so x displaces by a fraction of a unit rather
       than running away. 0.40 measured on 2026-09-03; the assertion is that it moved at all. */
    expect(Math.abs(moved.x - still.x)).toBeGreaterThan(0.1);
  });

  it('the fixed arm moves too, and lands within a metre of the floating one', () => {
    const float = fixture.runFloat(600);
    const fixed = fixture.runFixed(600);
    /* Close, because they are the same simulation; not equal, because they are not the same
       arithmetic. A metre over six hundred ticks of accumulated truncation is the shape of it. */
    expect(Math.abs(fixed.x - float.x)).toBeLessThan(1);
    expect(fixed.x).not.toBe(float.x);
  });
});
