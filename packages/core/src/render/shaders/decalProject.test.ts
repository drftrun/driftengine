import { expect, test } from 'vitest';

import { DECAL_PROJECT_FRAG } from './decalProject.ts';

/**
 * These are guards and not a specification.
 *
 * A shader's behaviour is settled by pixels, and `scripts/decal-check.mjs` is where that is
 * asserted on a device. What is held here is the set of mistakes this repository has already paid
 * for in shaders shaped like this one — each of them compiled, validated, and failed somewhere
 * else — because a source assertion is the only thing that catches them before a capture does.
 */

/** The shader with its prose removed, so a word in a comment is not read as code. */
const CODE = DECAL_PROJECT_FRAG.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * **An implicit derivative under a non-uniform branch fails to compile in WGSL**, and this shader
 * takes two of them. It invalidates the pipeline and the command buffer while the frame still
 * presents, so the symptom arrives far from the cause.
 *
 * The fetch takes an explicit level for the same rule read the other way: `AGENTS.md` requires it
 * of any `texture()` reached through a branch that is not provably uniform.
 */
test('the depth fetch takes an explicit level', () => {
  expect(CODE).toContain('textureLod(uDecalDepth');
  expect(CODE).not.toContain('texture(uDecalDepth');
});

/**
 * **Nothing here branches and nothing discards**, and that is what keeps the derivatives legal.
 * White is the identity of a multiply, so a pixel the projector missed can write white and change
 * nothing — which is why this shader is able to be one straight line rather than being one by
 * accident. A `discard` or an `if` added later takes the derivative below into undefined control
 * flow, and undefined there means a plausible picture on this driver and a different one on the
 * next.
 */
test('there is no branch and no discard for a derivative to fall inside', () => {
  expect(CODE).not.toContain('discard');
  expect(CODE).not.toMatch(/\bif\s*\(/);
  expect(CODE).toContain('dFdx(point)');
  expect(CODE).toContain('dFdy(point)');
});

/**
 * **A sampler's default precision is lowp**, whatever the file's `precision highp float` says —
 * that line sets the default for float and not for a sampler. A 32-bit depth read at eight bits
 * reconstructs a world position visibly in the wrong place, and it does it without failing.
 */
test('the depth sampler asks for highp, which its default is not', () => {
  expect(CODE).toContain('uniform highp sampler2D uDecalDepth;');
});

/**
 * **The normal's sign comes from the eye and never from the cross product.** Which way
 * `cross(dFdx, dFdy)` points depends on which way the framebuffer's rows run, and the two backends
 * disagree about that — so a facing test taken from the cross product alone marks the tops of
 * things on one backend and the undersides on the other, with nothing raising. A visible surface
 * faces the eye by definition, which is what settles it.
 */
test('the reconstructed normal is turned to face the eye', () => {
  expect(CODE).toContain('sign(dot(uDecalEye - point, normal))');
});

/**
 * **The far plane is asked about through `glslIsFarDepth`.** Under reversed depth the far plane is
 * 0 and not 1, so a guard written as `depth >= 1.0` never fires and the mark is computed over the
 * sky — where the reconstruction is meaningless. `depthConvention.ts` records the same guard
 * inverting on the occlusion pass and what it cost to find.
 */
test('the sky is excluded through the shared far-depth test', () => {
  expect(CODE).toContain('(stored <= 0.0)');
  expect(CODE).not.toContain('stored >= 1.0');
});

/**
 * **White where the mark is not**, because the blend is `dst * src`. A shader that wrote black
 * outside the projector would paint its whole scissor rectangle black, which is the failure that
 * looks like a rendering bug rather than like a decal.
 */
test('a pixel the projector misses multiplies by white', () => {
  expect(CODE).toContain('mix(vec3(1.0), uDecalColor');
});
