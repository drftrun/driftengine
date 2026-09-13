import { describe, expect, it } from 'vitest';

import * as engine from '../index.ts';
import {
  DEPTH_CLEAR,
  DEPTH_COMPARE,
  DEPTH_COMPARE_EQUAL,
  DEPTH_FORMAT,
  DEPTH_OFFSET_SIGN,
  REVERSED_DEPTH,
  conventionalDepth,
  glslFarDepth,
  glslSceneDepthToNdc,
} from './depthConvention.ts';

/**
 * **Every one of these follows from `REVERSED_DEPTH` and none may be set by hand.** The whole
 * value of one module holding the depth sense is that a pass cannot end up testing one way while
 * the buffer is cleared the other, and the way that happens is somebody changing four constants
 * and missing the fifth.
 */
describe('the depth convention agrees with itself', () => {
  it('clears to the far plane, whichever end that is', () => {
    expect(DEPTH_CLEAR).toBe(REVERSED_DEPTH ? 0 : 1);
  });

  it('compares toward the near plane, whichever end that is', () => {
    expect(DEPTH_COMPARE).toBe(REVERSED_DEPTH ? 'greater' : 'less');
    expect(DEPTH_COMPARE_EQUAL).toBe(REVERSED_DEPTH ? 'greater-equal' : 'less-equal');
  });

  /* Reversing a unorm buffer moves precision around and creates none; the gain is a float's
     exponent having room near zero, which is where reversing puts the far plane. */
  it('asks for a float attachment whenever it reverses', () => {
    expect(DEPTH_FORMAT).toBe(REVERSED_DEPTH ? 'depth32float' : 'depth24plus');
  });

  /* An overlay is pulled forward with a negative offset under LESS and a positive one under
     GREATER. Getting this wrong hides a marking inside the road rather than making it fight. */
  it('pushes a polygon offset the way its compare requires', () => {
    expect(DEPTH_OFFSET_SIGN).toBe(REVERSED_DEPTH ? -1 : 1);
  });

  /* The sky writes a fixed clip z. Saying 1.0 in a reversed engine puts it at the near plane and
     paints it over the world, which is what the pixel gate caught: 743,669 pixels of 921,600. */
  it('names the far plane for geometry that writes a fixed depth', () => {
    expect(glslFarDepth()).toBe(REVERSED_DEPTH ? '0.0' : '1.0');
  });

  /* Four shaders carried this by hand; a reversed buffer stores `0.5 - 0.5z`, so the inverse is
     `1 - 2 * stored` and not `2 * stored - 1`. */
  it('recovers clip z with the inverse of the mapping actually in use', () => {
    expect(glslSceneDepthToNdc('d')).toBe(REVERSED_DEPTH ? '(1.0 - d * 2.0)' : '(d * 2.0 - 1.0)');
  });

  it('reads a stored depth back into the conventional sense', () => {
    expect(conventionalDepth(0)).toBe(REVERSED_DEPTH ? 1 : 0);
    expect(conventionalDepth(1)).toBe(REVERSED_DEPTH ? 0 : 1);
    expect(conventionalDepth(0.25)).toBeCloseTo(REVERSED_DEPTH ? 0.75 : 0.25, 12);
  });
});

/**
 * **A consumer that cannot ask has to choose its near plane for the worse case.**
 *
 * Reported from outside as the half of this that was missing: the seam existed, every backend read
 * it, and none of it was reachable through the barrel — so a game had no way to know whether it
 * could put its near plane at 0.05 or had to leave it at 0.25, and no way to know how far off a
 * surface a decal needed to sit.
 */
describe('a consumer can reach the convention', () => {
  it('exports what a near plane and a decal offset depend on', () => {
    expect(engine.REVERSED_DEPTH).toBe(REVERSED_DEPTH);
    expect(engine.DEPTH_CLEAR).toBe(DEPTH_CLEAR);
    expect(engine.DEPTH_COMPARE).toBe(DEPTH_COMPARE);
    expect(engine.DEPTH_COMPARE_EQUAL).toBe(DEPTH_COMPARE_EQUAL);
    expect(engine.DEPTH_FORMAT).toBe(DEPTH_FORMAT);
    expect(engine.DEPTH_OFFSET_SIGN).toBe(DEPTH_OFFSET_SIGN);
    expect(engine.conventionalDepth(0.25)).toBe(conventionalDepth(0.25));
  });
});
