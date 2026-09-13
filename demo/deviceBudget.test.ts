import { describe, expect, it } from 'vitest';

import { demoQualityFor, isHandheld, readDemoDeviceHints } from './deviceBudget';

const PHONE = { coarsePointer: true, devicePixelRatio: 3.5 };
const DESKTOP = { coarsePointer: false, devicePixelRatio: 1 };

describe('what a demo costs on a handheld', () => {
  it('recognises a phone by its panel and its input, not by its GPU', () => {
    expect(isHandheld(PHONE)).toBe(true);
    expect(isHandheld({ coarsePointer: true, devicePixelRatio: 2 })).toBe(true);
    expect(isHandheld(DESKTOP)).toBe(false);
    expect(isHandheld({ coarsePointer: false, devicePixelRatio: 2 })).toBe(false);
  });

  it('does not mistake a touchscreen laptop for one', () => {
    /* A coarse pointer alone is any touch panel. The density separates a phone from a desktop
       GPU behind a touchscreen, which has none of the problems this exists for. */
    expect(isHandheld({ coarsePointer: true, devicePixelRatio: 1 })).toBe(false);
  });

  it('changes nothing at all on a desktop', () => {
    expect(demoQualityFor(DESKTOP)).toEqual({});
  });

  /**
   * The point of the whole module, asserted rather than described.
   *
   * This page has no settings screen, so anything switched off here is switched off for that
   * reader for good. A phone is owed a cheaper frame, never a smaller engine.
   */
  it('turns nothing off — every trim is a dial, not a switch', () => {
    const quality = demoQualityFor(PHONE) as Record<string, unknown>;

    for (const feature of [
      'directionalShadows',
      'pointShadows',
      'water',
      'waterReflections',
      'screenEffects',
      'underwaterAtmosphere',
      'planarReflections',
    ]) {
      expect(
        quality[feature],
        `${feature} must not be decided here: a reader on a phone sees the same passes`,
      ).toBeUndefined();
    }
  });

  it('cuts the terms the frame is actually bound on', () => {
    const quality = demoQualityFor(PHONE);

    /* Density and area first: the frame is roughly 90% fragment-bound. */
    expect(quality.maxDevicePixelRatio).toBe(1.5);
    expect(quality.maxDrawingBufferPixels).toBe(1_600_000);
    /* Four samples is four times the colour and depth bandwidth, and WebGPU offers no middle. */
    expect(quality.sceneSamples).toBe(1);
    /* Still a real reflection, at half the pixels the nine-tap water filter would blur anyway. */
    expect(quality.waterReflectionScale).toBe(0.5);
    /* Still shadows, from the same lights, sized and filtered for a screen this big. */
    expect(quality.directionalShadowMapSize).toBe(1024);
    expect(quality.pointShadowFaceSize).toBe(256);
    expect(quality.shadowFilterTaps).toBe(4);
  });

  it('answers rather than throwing where the browser cannot be asked', () => {
    /* A host may call this during module evaluation, and a test or server environment has no
       `matchMedia`. Throwing would cost a page for a question whose wrong answer costs a reload. */
    expect(() => readDemoDeviceHints()).not.toThrow();
    const hints = readDemoDeviceHints();
    expect(typeof hints.coarsePointer).toBe('boolean');
    expect(hints.devicePixelRatio).toBeGreaterThan(0);
  });
});
