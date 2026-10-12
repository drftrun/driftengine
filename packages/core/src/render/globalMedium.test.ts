import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GLOBAL_MEDIUM,
  MAX_GLOBAL_MEDIUM_STEPS,
  createResolvedMediumLamps,
  mediumActive,
  mediumTargetSize,
  resolveGlobalMedium,
  resolveGlobalMediumSettings,
  resolveMediumLamps,
} from './globalMedium.ts';
import { createResolvedPointLights, resolvePointLights } from './lightBudget.ts';
import type { PointLightSet } from './lightBudget.ts';
import { createResolvedPointShadows } from './pointShadowImage.ts';
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
    expect(resolveGlobalMedium({ albedo: 4 }).albedo).toEqual([1, 1, 1]);
    expect(resolveGlobalMedium({ albedo: -2 }).albedo).toEqual([0, 0, 0]);
    /* A colour is a share a channel, each clamped alone. */
    expect(resolveGlobalMedium({ albedo: [0.87, 1.4, -0.1] }).albedo).toEqual([0.87, 1, 0]);
  });

  it('never marches zero metres, which would cost every step and integrate nothing', () => {
    expect(resolveGlobalMedium({ maxDistance: 0 }).maxDistance).toBeGreaterThan(0);
  });

  it('leaves what a caller did not say at the defaults, so one argument is a whole call', () => {
    const one = resolveGlobalMedium({ density: 0.02 });
    expect(one.albedo).toEqual([0.9, 0.9, 0.9]);
    expect(one.anisotropy).toBe(DEFAULT_GLOBAL_MEDIUM.anisotropy);
    expect(one.maxDistance).toBe(DEFAULT_GLOBAL_MEDIUM.maxDistance);
    /*
     * **The medium it always was**: as thick everywhere, one layer, the sun and the sky at the
     * strength they light a surface, and no lamp, so a scene that never names the new fields draws
     * the picture and pays the cost it did.
     */
    expect([one.heightFalloff, one.baseY, one.density2]).toEqual([0, 0, 0]);
    expect([one.sunScatter, one.skyScatter, one.lampScatter]).toEqual([1, 1, 0]);
  });

  it('READS THE FOUR NUMBERS AND THE OBJECT ONE WAY, AND A SECOND LAYER BY ITS OWN HEIGHT', () => {
    expect(resolveGlobalMediumSettings(0.03, 0.5, 0.2, 40)).toEqual(
      resolveGlobalMediumSettings({ density: 0.03, albedo: 0.5, anisotropy: 0.2, maxDistance: 40 }),
    );
    const layered = resolveGlobalMediumSettings({
      density: 0.02,
      heightFalloff: 0.1,
      baseY: 3,
      layer2: { density: 0.01, heightFalloff: 0.02, baseY: -5 },
      sunScatter: 5,
      lampScatter: 2,
    });
    expect([layered.heightFalloff, layered.baseY]).toEqual([0.1, 3]);
    expect([layered.density2, layered.heightFalloff2, layered.baseY2]).toEqual([0.01, 0.02, -5]);
    expect([layered.sunScatter, layered.skyScatter, layered.lampScatter]).toEqual([5, 1, 2]);
    /* A density that is not a number is none, in either form. */
    expect(resolveGlobalMediumSettings(Number.NaN).density).toBe(0);
    expect(resolveGlobalMediumSettings({ density: Number.NaN }).density).toBe(0);
  });
});

describe('the lamps the medium is lit by', () => {
  /** Two lamps: a point at (1, 2, 3) of radius 6, and a spot at the origin aimed down. */
  const lights = (): PointLightSet => {
    const set = {
      lightCount: 2,
      lightPositions: new Float32Array(16 * 3),
      lightColors: new Float32Array(16 * 3),
      lightRadii: new Float32Array(16),
      lightWeights: new Float32Array(16).fill(1),
      lightDirections: new Float32Array(16 * 3),
      lightConeCos: new Float32Array(16 * 2).fill(-2),
      lightFalloffExponents: new Float32Array(16),
    };
    set.lightPositions.set([1, 2, 3, 0, 4, 0]);
    set.lightColors.set([2, 1, 0.5, 1, 1, 1]);
    set.lightRadii.set([6, 9]);
    set.lightWeights[1] = 0.5;
    set.lightDirections.set([0, 0, 1, 0, -1, 0]);
    set.lightConeCos.set([-2, -2, 0.9, 0.8]);
    set.lightFalloffExponents[1] = 2;
    return set;
  };

  it('IS NONE UNTIL A CALLER ASKS, WHATEVER THE FRAME LIGHTS SURFACES WITH', () => {
    const resolved = resolvePointLights(lights(), 'smooth', createResolvedPointLights());
    const out = resolveMediumLamps(
      resolveGlobalMedium({ density: 0.02 }),
      resolved,
      null,
      undefined,
      createResolvedMediumLamps(),
    );
    expect(out.count).toBe(0);
  });

  /*
   * Each lamp's colour times its presence, the medium's lampScatter and its own scatter: the
   * point's (2, 1, 0.5) at presence 1, scatter 3 and its own 2 is (12, 6, 3); the spot's white at
   * presence 0.5, scatter 3 and its own 1 (a short array is 1) is 1.5. Its own exponent rides the
   * colour's fourth lane, its radius the position's, its cone and aim beside them. Its maps are the
   * lit stage's: the layers and projections the shadows resolved, and none where there are none.
   */
  it('PACKS EACH LAMP AS THE MARCH READS IT, THROUGH THE LIT STAGE’S OWN MAPS', () => {
    const resolved = resolvePointLights(lights(), 'inverseSquare', createResolvedPointLights());
    const shadows = createResolvedPointShadows(16);
    shadows.layers[0] = 4;
    shadows.near[0] = 0.1;
    shadows.presence[0] = 0.75;
    shadows.projections.set([1, 2, 3.5, 20], 0);
    shadows.liveLayers[1] = 7;
    shadows.liveWeights[1] = 1;
    shadows.liveProjections.set([0, 4, 0, 12], 4);
    const own = new Float32Array([2, 1]);
    const out = resolveMediumLamps(
      resolveGlobalMedium({ density: 0.02, lampScatter: 3 }),
      resolved,
      shadows,
      own,
      createResolvedMediumLamps(),
    );
    expect(out.count).toBe(2);
    expect(out.falloff).toBe(1);
    expect(Array.from(out.position.subarray(0, 8))).toEqual([1, 2, 3, 6, 0, 4, 0, 9]);
    expect(Array.from(out.color.subarray(0, 8))).toEqual([12, 6, 3, 0, 1.5, 1.5, 1.5, 2]);
    expect(Array.from(out.aim.subarray(4, 7))).toEqual([0, -1, 0]);
    expect(Array.from(out.cone.subarray(4, 6)).map((v) => Math.round(v * 10) / 10)).toEqual([
      0.9, 0.8,
    ]);
    expect(Array.from(out.shadow.subarray(0, 3))).toEqual([4, Math.fround(0.1), 0.75]);
    expect(Array.from(out.shadowAt.subarray(0, 4))).toEqual([1, 2, 3.5, 20]);
    expect(out.shadow[4]).toBe(-1);
    expect(Array.from(out.live.subarray(4, 7))).toEqual([7, 0, 1]);
    expect(Array.from(out.liveAt.subarray(4, 8))).toEqual([0, 4, 0, 12]);
    const bare = resolveMediumLamps(
      resolveGlobalMedium({ density: 0.02, lampScatter: 1 }),
      resolved,
      null,
      undefined,
      createResolvedMediumLamps(),
    );
    expect([bare.shadow[0], bare.live[0], bare.shadow[4], bare.live[4]]).toEqual([-1, -1, -1, -1]);
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
