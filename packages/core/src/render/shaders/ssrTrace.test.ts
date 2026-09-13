import { expect, test } from 'vitest';

import { SSR_TRACE_FRAG } from './ssrTrace.ts';

/**
 * These are guards and not a specification.
 *
 * The march is specified by `screenSpaceReflection.ts` and its tests, which pin every case that can
 * draw a plausible picture instead of failing; `scripts/ssr-check.mjs` settles the pixels on a
 * device. What is held here is the set of mistakes this repository has already paid for in shaders
 * shaped like this one — each of them compiled, validated, and failed somewhere else — and the
 * places where this shader has to agree with the TypeScript beside it.
 */

/** The shader with its prose removed, so a word in a comment is not read as code. */
const CODE = SSR_TRACE_FRAG.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * **An implicit derivative under a non-uniform branch fails to compile in WGSL**, and this shader
 * takes two of them inside a pass whose whole body is a branch. It invalidates the pipeline and the
 * command buffer while the frame still presents, so the symptom arrives far from the cause.
 */
test('every fetch takes an explicit level, because the march is a branch', () => {
  expect(CODE).toContain('textureLod(uSsrDepth');
  expect(CODE).toContain('textureLod(uSsrScene');
  expect(CODE).not.toContain('texture(uSsrDepth');
  expect(CODE).not.toContain('texture(uSsrScene');
});

/**
 * **The derivatives are taken before anything branches**, which is what makes them legal. A
 * derivative in non-uniform control flow is undefined, and undefined here means a plausible picture
 * on this driver and a different one on the next.
 */
test('the normal is derived above the march rather than inside it', () => {
  const derivative = CODE.indexOf('dFdx(point)');
  const branch = CODE.indexOf('if (mask > 0.0)');
  expect(derivative).toBeGreaterThan(-1);
  expect(branch).toBeGreaterThan(derivative);
});

/**
 * **A sampler's default precision is lowp**, whatever `precision highp float` says — that line sets
 * the default for float and not for a sampler. Every world position in the march is reconstructed
 * by dividing through this depth.
 */
test('the depth sampler asks for highp, which its default is not', () => {
  expect(CODE).toContain('uniform highp sampler2D uSsrDepth;');
});

/**
 * **The normal's sign comes from the eye and never from the cross product.** Which way
 * `cross(dFdx, dFdy)` points depends on which way the framebuffer's rows run, and the two backends
 * disagree about that — so a reflection taken from the cross product alone would bounce off the
 * wrong side of every surface on one of them, with nothing raising.
 */
test('the reconstructed normal is turned to face the eye', () => {
  expect(CODE).toContain('sign(dot(toEye, normal))');
});

/**
 * **A crossing and not a comparison**, which is the whole of the self-intersection guard: the ray
 * has to be in front of the scene at one sample and behind it at the next. A march that called any
 * positive gap a hit would have every pixel of a reflective floor take that comparison on rounding
 * at once, which is the speckle a screen-space effect is remembered for.
 */
test('a hit needs the previous sample in front of the scene', () => {
  expect(CODE).toContain('behind < 0.0 && gap >= 0.0');
});

/**
 * **The thickness test, without which a reflection acquires the foreground.** A depth buffer holds
 * one distance per pixel and says nothing about how thick the thing there is, so a ray that slides
 * onto something near the camera would paste it into the reflection.
 */
test('a crossing is believed only within the thickness', () => {
  expect(CODE).toContain('refinedGap <= uSsrThickness');
});

/**
 * **The sky is not a surface.** Under reversed depth the far plane is 0 and not 1, so a guard
 * written as `depth >= 1.0` never fires — and the march would reflect the whole world in the
 * horizon, which is the failure that looks like a working effect from one angle.
 */
test('an untouched depth is excluded through the shared far-depth test', () => {
  expect(CODE).toContain('(stored <= 0.0)');
  expect(CODE).not.toContain('stored >= 1.0');
});

/**
 * **A sample behind the eye has a negative `w`, and dividing by it mirrors the point** — so it
 * comes back as a perfectly ordinary screen position somewhere else in the frame, and the march
 * would read a depth belonging to a place the ray never went. `projectToUv` refuses it in the
 * TypeScript for the same reason, and `decalScissor` records the same trap for its own bound.
 */
test('a sample behind the eye is refused rather than mirrored through the origin', () => {
  expect(CODE).toContain('if (clip.w <= 0.0) return false;');
});

/**
 * **Quadratic spacing, and it has to match `marchDistance`.** Evenly spaced samples leave a dark
 * band along every contact, which is where a reflection is read first: measured at 11,826 reflected
 * pixels evenly spaced against 13,890 spaced this way, on the same scene.
 */
test('the samples are spaced by the square of their index, as the TypeScript spaces them', () => {
  expect(CODE).toContain('float at = float(i) / steps;');
  expect(CODE).toContain('float t = uSsrReach * at * at;');
});
