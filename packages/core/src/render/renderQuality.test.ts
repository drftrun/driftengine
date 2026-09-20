import { expect, test } from 'vitest';

import { resolveRenderQuality } from './renderQuality.ts';

test('the planar reflection stays at full scale by default', () => {
  /*
   * The GPU-budget design listed half scale as a free win. It is not free: with the timer
   * armed the reflection measures 0.50 ms of an 18.00 ms frame, so halving it globally
   * trades a visibly softer reflection on every machine for 3% none of them needed. Worse,
   * the scale is construction-time, so a clip export could not ask for full back — and an
   * export is the one frame somebody keeps.
   *
   * Weak parts get it halved by the capability clamp instead. This pins the default so a
   * future reader of that design does not "finish the job".
   */
  expect(resolveRenderQuality({}).waterReflectionScale).toBe(1);
});

test('an explicit scale still wins over the default', () => {
  /* `?reflscale=` is how the cost gets A/B'd in seconds rather than argued about. */
  expect(resolveRenderQuality({ waterReflectionScale: 0.5 }).waterReflectionScale).toBe(0.5);
});

test('the scale has to be positive, so a corrupt value cannot size a target at zero', () => {
  expect(() => resolveRenderQuality({ waterReflectionScale: 0 })).toThrow();
  expect(() => resolveRenderQuality({ waterReflectionScale: -1 })).toThrow();
});

test('the capability clamp is on by default', () => {
  /*
   * The overwhelming majority of players never open a settings screen, and a phone opening
   * at a desktop profile is how NFD6QQ happened. The safe default is the one that helps the
   * player who never touches anything.
   */
  expect(resolveRenderQuality({}).capabilityClamp).toBe(true);
});

test('ambient occlusion is off by default, and a radius still stands behind it', () => {
  /*
   * The rule every item in RENDERING.md lands under: a new effect whose default changed the
   * six published demos would be a regression however good it looked. Zero here is what
   * makes the composite pass multiply by exactly one.
   *
   * The radius is *not* zero, though nothing consults it while the strength is: a default of
   * zero would sit there as a legal-looking value that turns the estimator into a division by
   * nothing the moment somebody enables the effect without reading twice.
   */
  const quality = resolveRenderQuality({});
  expect(quality.ambientOcclusion).toBe(0);
  expect(quality.ambientOcclusionRadius).toBeGreaterThan(0);
});

test('an occlusion strength outside 0 to 1 is clamped rather than refused', () => {
  /*
   * Clamped, like `cameraMotionBlur` beside it, because a strength is a mix weight and a
   * caller sliding one past its end has stated something unambiguous. A radius is different
   * and throws: there is no sensible reading of a negative distance.
   */
  expect(resolveRenderQuality({ ambientOcclusion: 4 }).ambientOcclusion).toBe(1);
  expect(resolveRenderQuality({ ambientOcclusion: -1 }).ambientOcclusion).toBe(0);
  expect(() => resolveRenderQuality({ ambientOcclusionRadius: 0 })).toThrow();
  expect(() => resolveRenderQuality({ ambientOcclusionRadius: -0.5 })).toThrow();
});

/**
 * Depth of field is off by default, and its ceiling is clamped the way every other strength is.
 *
 * **Off by default matters more here than elsewhere**, because the effect's other two numbers are
 * per-frame and their defaults are not a picture: the focus distance starts at zero metres, which
 * is behind the camera, so a ceiling that defaulted to anything would defocus every frame of every
 * existing consumer and the fix would be a call nobody knew to make.
 */
test('depth of field is off until asked for, and its ceiling is a clamped strength', () => {
  expect(resolveRenderQuality({}).depthOfField).toBe(0);
  expect(resolveRenderQuality({ depthOfField: 0.02 }).depthOfField).toBeCloseTo(0.02, 6);
  expect(resolveRenderQuality({ depthOfField: 4 }).depthOfField).toBe(1);
  expect(resolveRenderQuality({ depthOfField: -1 }).depthOfField).toBe(0);
});

test('a caller can turn the capability clamp off', () => {
  /*
   * Passed as false to mean "this person chose these numbers themselves". Guessing over the
   * top of an explicit choice is worse than a slow game, because it is a setting that
   * silently does not apply.
   */
  expect(resolveRenderQuality({ capabilityClamp: false }).capabilityClamp).toBe(false);
});

/*
 * The switch beside the size, in the shape `water`/`waterReflections` already uses.
 *
 * A settings screen turns reflections off; it does not know that a cubemap of zero pixels is how
 * that is spelled. Both halves have to hold: on by default so nothing changes for anyone, and off
 * meaning off however large the size beside it.
 */
test('environment reflections are on by default and change nothing on their own', () => {
  const quality = resolveRenderQuality({});
  expect(quality.environmentReflections).toBe(true);
  /* The feature still costs nothing until a caller asks for a probe. */
  expect(quality.reflectionProbeSize).toBe(0);
});

test('turning environment reflections off survives a size beside it', () => {
  const quality = resolveRenderQuality({ environmentReflections: false, reflectionProbeSize: 512 });
  expect(quality.environmentReflections).toBe(false);
  /* The size is carried rather than zeroed: it is what the caller asked for, and the renderer is
     what decides no probe is built. A profile toggled back on keeps the quality it had. */
  expect(quality.reflectionProbeSize).toBe(512);
});

/**
 * Temporal antialiasing is off unless a consumer asks.
 *
 * **Every published capture was taken without it**, and it changes what a still frame looks like
 * by construction: the projection is jittered, so the first frame of a scene is sampled half a
 * pixel from where every existing shot sampled it. Defaulting it on would move every reference
 * image in the repository, which is the shape of change that has to be opted into rather than
 * inherited.
 */
test('temporal antialiasing is off by default', () => {
  expect(resolveRenderQuality({}).temporalAa).toBe(false);
});

test('a consumer that asks for temporal antialiasing gets it', () => {
  expect(resolveRenderQuality({ temporalAa: true }).temporalAa).toBe(true);
});

/**
 * Order-independent transparency is off unless a consumer asks.
 *
 * It replaces sorted alpha blending with a weighted sum, which is exact for one layer and an
 * approximation for several — so a scene whose translucent surfaces never overlap gets the same
 * picture and pays two extra targets and a second submission of its translucent geometry for it.
 * That is a trade a consumer makes deliberately.
 */
test('order-independent transparency is off by default', () => {
  expect(resolveRenderQuality({}).orderIndependent).toBe(false);
});

test('a consumer that asks for order-independent transparency gets it', () => {
  expect(resolveRenderQuality({ orderIndependent: true }).orderIndependent).toBe(true);
});

/**
 * Reconstruction is a ratio, and its off value is zero rather than one.
 *
 * **Zero and not one, because one is a thing somebody might mean.** A ratio of one is the resolve
 * running at the output size with no upscaling — a temporal antialiaser with a better
 * neighbourhood rule — which is a configuration worth being able to ask for, and a sentinel that
 * collided with it would make it unaskable. So the off value is outside the range entirely.
 *
 * **The range is clamped rather than refused.** Below 1.3 the render saves less than a third of the
 * fragment work and the resolve's own cost eats it; above 2 the render is a quarter of the output
 * and no reconstruction holds an edge through that. A number outside is a caller reaching for
 * "as much as possible", which is what the end of the range is.
 */
test('reconstruction is off at zero, and any other value is a ratio inside its range', () => {
  expect(resolveRenderQuality({}).reconstruction).toBe(0);
  expect(resolveRenderQuality({ reconstruction: 0 }).reconstruction).toBe(0);
  expect(resolveRenderQuality({ reconstruction: 1.5 }).reconstruction).toBeCloseTo(1.5, 6);
  expect(resolveRenderQuality({ reconstruction: 1 }).reconstruction).toBeCloseTo(1.3, 6);
  expect(resolveRenderQuality({ reconstruction: 3 }).reconstruction).toBe(2);
  /* Negative is off, not a clamp to the bottom of the range: it cannot mean "a little". */
  expect(resolveRenderQuality({ reconstruction: -1 }).reconstruction).toBe(0);
  expect(resolveRenderQuality({ reconstruction: Number.NaN }).reconstruction).toBe(0);
});

/**
 * Indirect light is a switch rather than a strength, and it is off.
 *
 * **A strength would be a lie about what the feature does.** A reconstruction at half a ratio is a
 * meaningful thing to ask for; half an indirect bounce is not — a probe either holds what the chain
 * traced or it holds what the rasterised cube held, and mixing the two is two solutions averaged
 * rather than one at a lower quality. What is genuinely adjustable is how many probes refresh a
 * frame, and that is the grid's business rather than this one's.
 */
test('indirect light is off by default, and is a switch rather than a strength', () => {
  expect(resolveRenderQuality({}).indirectLight).toBe(false);
  expect(resolveRenderQuality({ indirectLight: true }).indirectLight).toBe(true);
  expect(resolveRenderQuality({ indirectLight: false }).indirectLight).toBe(false);
});
