import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GLOBAL_MEDIUM,
  MAX_GLOBAL_MEDIUM_STEPS,
  mediumActive,
  mediumTargetSize,
  resolveGlobalMedium,
} from './globalMedium.ts';
import { DEFAULT_RENDER_QUALITY, resolveRenderQuality } from './renderQuality.ts';

describe('the medium a caller asks for', () => {
  it('is off by default, and off is the thing the whole feature is priced on', () => {
    expect(DEFAULT_GLOBAL_MEDIUM.density).toBe(0);
    expect(DEFAULT_RENDER_QUALITY.globalMediumSteps).toBe(0);
    expect(mediumActive(DEFAULT_GLOBAL_MEDIUM, DEFAULT_RENDER_QUALITY.globalMediumSteps)).toBe(
      false,
    );
  });

  it('needs both the ceiling and the dial, because either alone is a pass nobody wants', () => {
    const thick = resolveGlobalMedium({ density: 0.05 });
    /* A game that asks for weather on a profile that cannot afford it gets none, and a profile
       that budgeted for weather draws none until a game asks. */
    expect(mediumActive(thick, 0)).toBe(false);
    expect(mediumActive(DEFAULT_GLOBAL_MEDIUM, 32)).toBe(false);
    expect(mediumActive(thick, 32)).toBe(true);
  });

  it('refuses a negative density rather than growing brighter with distance', () => {
    /* `exp(-density * d)` with a negative density is transmittance above 1: a frame that gets
       brighter the further away it is, which is not a fog and is not clipped anywhere later. */
    expect(resolveGlobalMedium({ density: -1 }).density).toBe(0);
  });

  it('keeps anisotropy short of the poles, where the phase function is 0/0', () => {
    /* At g = 1 the denominator `1 + g^2 - 2g cos` is zero along the forward direction, and a NaN
       in a half-float target spreads over the frame rather than reporting itself. */
    expect(resolveGlobalMedium({ anisotropy: 1 }).anisotropy).toBeLessThan(1);
    expect(resolveGlobalMedium({ anisotropy: -1 }).anisotropy).toBeGreaterThan(-1);
    expect(resolveGlobalMedium({ anisotropy: 0.3 }).anisotropy).toBeCloseTo(0.3, 6);
  });

  it('clamps albedo into 0 to 1, which is what "how much comes back" can mean', () => {
    expect(resolveGlobalMedium({ albedo: 4 }).albedo).toBe(1);
    expect(resolveGlobalMedium({ albedo: -2 }).albedo).toBe(0);
  });

  it('never marches zero metres, which would cost every step and integrate nothing', () => {
    expect(resolveGlobalMedium({ maxDistance: 0 }).maxDistance).toBeGreaterThan(0);
  });

  it('leaves what a caller did not say at the defaults, so one argument is a whole call', () => {
    const one = resolveGlobalMedium({ density: 0.02 });
    expect(one.albedo).toBe(DEFAULT_GLOBAL_MEDIUM.albedo);
    expect(one.anisotropy).toBe(DEFAULT_GLOBAL_MEDIUM.anisotropy);
    expect(one.maxDistance).toBe(DEFAULT_GLOBAL_MEDIUM.maxDistance);
  });
});

describe('the ceiling the profile sets', () => {
  it('is whole steps and never past the shader loop bound it is clamped inside', () => {
    /* A uniform above the bound makes the shader's own `clamp` disagree with the step length
       computed from `uSteps`: a march that divides its distance by more steps than it takes, and
       therefore stops short of the surface it was supposed to reach. */
    expect(resolveRenderQuality({ globalMediumSteps: 1000 }).globalMediumSteps).toBe(
      MAX_GLOBAL_MEDIUM_STEPS,
    );
    expect(resolveRenderQuality({ globalMediumSteps: 24.6 }).globalMediumSteps).toBe(25);
    expect(resolveRenderQuality({ globalMediumSteps: -3 }).globalMediumSteps).toBe(0);
  });

  it('is half resolution unless a caller says otherwise', () => {
    expect(resolveRenderQuality({}).globalMediumHalfResolution).toBe(true);
    expect(
      resolveRenderQuality({ globalMediumHalfResolution: false }).globalMediumHalfResolution,
    ).toBe(false);
  });
});

describe('the march target', () => {
  it('is half the frame each way, rounded up', () => {
    expect(mediumTargetSize(1920, 1080, true)).toEqual({ width: 960, height: 540 });
    /* Up, not down: 961 halved down is 480, and 960 of 961 columns leaves a strip the upsample
       reads past the edge of. */
    expect(mediumTargetSize(1281, 721, true)).toEqual({ width: 641, height: 361 });
  });

  it('is the frame itself when a caller turns the halving off', () => {
    expect(mediumTargetSize(800, 600, false)).toEqual({ width: 800, height: 600 });
  });

  it('never has a zero side, which both backends refuse at creation', () => {
    expect(mediumTargetSize(1, 1, true)).toEqual({ width: 1, height: 1 });
    expect(mediumTargetSize(0, 0, true)).toEqual({ width: 1, height: 1 });
  });
});
