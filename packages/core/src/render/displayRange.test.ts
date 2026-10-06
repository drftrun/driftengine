import { describe, expect, it } from 'vitest';

import { chooseDisplayRange, displayHeadroom } from './displayRange.ts';

/*
 * **A high range is had only where all three are true**: asked for, held by a composite, and shown
 * by the display. Each refusal says which was missing, since `displayRangeReason` is what a game
 * reads to explain why its HDR look is not on.
 */
describe('THE FRAME GOES OUT IN A HIGH RANGE ONLY WHERE IT WAS ASKED, HELD AND CAN BE SHOWN', () => {
  it('IS HIGH WHERE ALL THREE ARE TRUE', () => {
    expect(chooseDisplayRange(true, true, true).range).toBe('high');
  });

  it('IS STANDARD WHERE ANY IS MISSING, AND SAYS WHICH', () => {
    expect(chooseDisplayRange(false, true, true)).toEqual({
      range: 'standard',
      reason: 'highDynamicRange was not asked for',
    });
    expect(chooseDisplayRange(true, false, true).reason).toMatch(/screenEffects and hdrScene/);
    expect(chooseDisplayRange(true, true, false).reason).toMatch(/standard dynamic range/);
  });

  it('GIVES THE HEADROOM AS PEAK OVER PAPER WHITE, ONE WHERE THE RANGE IS STANDARD', () => {
    expect(displayHeadroom('high', 200, 1000)).toBe(5);
    expect(displayHeadroom('standard', 200, 1000)).toBe(1);
    expect(displayHeadroom('high', 300, 100), 'never below paper white').toBe(1);
    expect(displayHeadroom('high', 0, 1000), 'a paper white of nothing is no headroom').toBe(1);
    expect(displayHeadroom('high', Number.NaN, 1000)).toBe(1);
  });
});
