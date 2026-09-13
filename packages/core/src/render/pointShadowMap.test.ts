/**
 * The one thing about a shadow map that can be checked without a GPU: that the value it
 * *assumes* when a caller says nothing is the same value it later *compares* against.
 *
 * Source-level, like `flat.test.ts`, and for the same reason — the failure is not a wrong
 * number, it is two numbers that were supposed to be one.
 */
import { expect, test } from 'vitest';

import { createFaceRange, PointShadowImage, type FaceRange } from './pointShadowImage.ts';

// The `?raw` suffix carries no type declaration; a variable path keeps TypeScript quiet
// and vitest resolves it at run time, as `flat.test.ts` does for the renderer.
const RAW = './pointShadowImage.ts?raw';
const source = ((await import(/* @vite-ignore */ RAW)) as { default: string }).default;

/*
 * **Both signatures moved into one file, and that is the strongest form this can take.**
 *
 * The default, the field and the comparison used to live in `pointShadowMap.ts` beside a GL
 * context; they are now in `pointShadowImage.ts`, which has no device in it and which both
 * backends read. So the property this protects — one number, used everywhere it is assumed —
 * is now protected for the WebGPU path by construction rather than by a second copy of this
 * test. The file it reads moved with the constant; nothing else about the check changed.
 */

test('bake and matchesSource assume the same emitter radius', () => {
  /*
   * They did not. `bake` defaulted the argument to 0.05 and `matchesSource` declared it
   * required, so a JavaScript consumer that never passed one baked 0.05 and then compared
   * it against `undefined` on every frame — every map stale forever, and with a couple of
   * faces of bake budget a frame the only thing on screen was whichever face had most
   * recently finished. It read as a hard square of shadow that followed the camera —
   * reported, from an interior scene, as a squared shadow sitting in a wall.
   *
   * Asserted as "there is exactly one default and both signatures use it", because that
   * is the property that cannot silently come apart again. Any value would do; two would
   * not.
   */
  expect(source, 'the default is named once').toContain('const DEFAULT_SOURCE_RADIUS =');

  const literals = source.match(/sourceRadius\s*=\s*[0-9.]+/g) ?? [];
  expect(literals, 'no signature carries its own copy of the number').toEqual([]);

  const defaulted = source.match(/sourceRadius\s*=\s*DEFAULT_SOURCE_RADIUS/g) ?? [];
  expect(defaulted.length, 'the field and the comparison both take it').toBeGreaterThanOrEqual(2);
});

/*
 * **A bake in flight owns the parameters it started with.**
 *
 * `planBake` used to demand an exact match on position, range, near plane and emitter radius to
 * resume, so a light that changes by any amount between two frames could never satisfy it. Two
 * kinds are ordinary: a flame wanders a few centimetres every frame to look alive, and a light
 * whose brightness is expressed as a radius rescales it every frame while it pulses. For either,
 * the cursor reset to zero every frame — so with a budget of two faces the bake rendered faces 0
 * and 1 for ever and faces 2 to 5 were never written again, while `resolveFace` had already put
 * the new ones into the layer and `hasBaked` stayed true from the last bake that did finish. The
 * shader then sampled a map holding two faces from one place and four from another, permanently.
 */
test('a partial bake finishes at the place it started, however the light moves', () => {
  const image = new PointShadowImage();
  const range: FaceRange = createFaceRange();
  const plan = (x: number): FaceRange => image.planBake(x, 0, 0, 10, 0.1, 0.05, 2, range);

  const first = plan(0);
  expect([first.first, first.last]).toEqual([0, 2]);
  expect(first.x).toBe(0);
  image.completeBake(
    first.last,
    first.x,
    first.y,
    first.z,
    first.range,
    first.near,
    first.sourceRadius,
  );

  /* The light has moved. The bake carries on where it was, at the origin it was started for. */
  const second = plan(0.31);
  expect([second.first, second.last]).toEqual([2, 4]);
  expect(second.x).toBe(0);
  image.completeBake(
    second.last,
    second.x,
    second.y,
    second.z,
    second.range,
    second.near,
    second.sourceRadius,
  );

  const third = plan(0.62);
  expect([third.first, third.last]).toEqual([4, 6]);
  expect(third.x).toBe(0);
  image.completeBake(
    third.last,
    third.x,
    third.y,
    third.z,
    third.range,
    third.near,
    third.sourceRadius,
  );

  /* Six faces, one origin, and only now is it published. */
  expect(image.hasBaked).toBe(true);
  expect(image.matchesSource(0, 0, 0, 10, 0.1, 0.05, 0)).toBe(true);

  /* And the next call starts a fresh bake at wherever the light is now. */
  const fourth = plan(0.93);
  expect([fourth.first, fourth.last]).toEqual([0, 2]);
  expect(fourth.x).toBeCloseTo(0.93, 6);
});
