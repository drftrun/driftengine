import { describe, expect, it } from 'vitest';

import { DEFAULT_FRAME_REFLECTIONS, resolveFrameReflections } from './frameReflections.ts';

describe('THE FRAME’S REFLECTIONS RESOLVE TO NUMBERS THE TRACE CAN USE', () => {
  it('IS OFF UNLESS ASKED, AND THE DEFAULTS WHEN ASKED WITH TRUE', () => {
    expect(resolveFrameReflections(undefined)).toBeNull();
    expect(resolveFrameReflections(false)).toBeNull();
    expect(resolveFrameReflections(true)).toEqual({
      maxRoughness: 0.6,
      reachM: 8,
      thicknessM: 0.25,
      steps: 24,
      blur: 0.03,
    });
    expect(resolveFrameReflections({})).toEqual(DEFAULT_FRAME_REFLECTIONS);
  });

  it('HOLDS EVERY NUMBER WHERE THE SHADER CAN USE IT, AND TAKES A NaN AS THE DEFAULT', () => {
    expect(
      resolveFrameReflections({
        maxRoughness: 0,
        reachM: -3,
        thicknessM: 0,
        steps: 99.4,
        blur: 1,
      }),
    ).toEqual({ maxRoughness: 0.01, reachM: 0.01, thicknessM: 0.001, steps: 32, blur: 0.2 });
    expect(resolveFrameReflections({ steps: 0.2, maxRoughness: Number.NaN })).toMatchObject({
      steps: 1,
      maxRoughness: 0.6,
    });
  });
});
