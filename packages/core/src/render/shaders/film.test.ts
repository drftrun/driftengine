import { test, expect } from 'vitest';
import { FILM_FRAG } from './film.ts';

/**
 * The film's roughness, and the one property that makes it safe to add.
 *
 * A film had exactly one finish before this — mirror — so every existing consumer is rendering
 * against the assumption that it is one. The scatter is therefore gated on the amount, and this
 * is the test that says so: a caller that does not ask takes the branch nowhere, which is both
 * the compatibility guarantee and the reason a scene with no rough films pays nothing for the
 * feature existing.
 */
test('the reflection scatter is gated on the amount, so a film that asks for none is a mirror', () => {
  const source = FILM_FRAG;
  expect(source).toContain('uniform float uFilmRoughness;');
  expect(source).toContain('uniform float uFilmRoughnessCycles;');
  expect(source).toContain('if (uFilmRoughness > 0.0) {');
});

/**
 * The lookup stays an explicit level, and the comment beside it in `film.ts` records what it
 * cost to learn the fifth time: an implicit derivative under a branch that is not provably
 * uniform fails to compile in WGSL, which invalidates the pipeline and the command buffer while
 * the frame still presents. The scatter adds a *second* varying-dependent branch around that
 * same lookup, so this is worth holding mechanically rather than by memory.
 */
test('the mirror is sampled at an explicit level, with the scatter branch above it', () => {
  const source = FILM_FRAG;
  expect(source).toContain('textureLod(uReflectionMap');
  expect(source).not.toContain('texture(uReflectionMap');
  const scatter = source.indexOf('if (uFilmRoughness > 0.0) {');
  const lookup = source.indexOf('textureLod(uReflectionMap');
  expect(scatter).toBeGreaterThan(-1);
  expect(lookup).toBeGreaterThan(scatter);
});

/**
 * The scatter has to be able to displace a sample off the edge of the mirror, and the pass
 * already fades what leaves it. Re-fading after the displacement is what stops a rough film
 * drawing a hard line across itself where the original sample was inside the target and the
 * moved one is not.
 */
test('a displaced sample is re-checked against the target border', () => {
  const source = FILM_FRAG;
  expect(source).toContain('movedBorder');
  expect(source).toContain('valid = min(valid');
});
