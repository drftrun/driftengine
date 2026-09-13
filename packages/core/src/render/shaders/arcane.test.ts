/**
 * Properties of the arcane plume shader that a rewrite must not quietly drop.
 *
 * Source-reading, for the reason `flat.test.ts` sets out: GLSL cannot run here, and
 * the failure worth catching is a term going missing rather than a number being
 * wrong. Each assertion below is a property the effect depends on, not a formatting
 * preference.
 */
import { expect, test } from 'vitest';
import { ARCANE_FRAG } from './arcane.ts';

/** Source with runs of whitespace collapsed, so formatting is not the assertion. */
const source = ARCANE_FRAG.replace(/\s+/g, ' ');

test('the aura is a disc, not a flame', () => {
  /*
   * FIRE_FRAG carves a rising column: a vertical taper and a threshold that climbs
   * with height. An aura is the opposite shape — radial about the quad centre — and
   * copying the fire shader and retinting it is the obvious wrong turn this guards.
   */
  expect(source, 'radius is measured from the quad centre').toContain(
    'float radius = length(vUv - 0.5) * 2.0;',
  );
  expect(source, 'and everything outside the disc is discarded').toContain(
    'if (radius >= 1.0) discard;',
  );
});

test('the swirl counter-rotates, or it reads as a pulsing blob', () => {
  /*
   * Two bands turning opposite ways is what makes this read as a spell rather than
   * as a light being dimmed up and down. One band alone rotates as a sheet — the
   * same mistake `BLADES` documents for the billboarded fire.
   */
  expect(source, 'the inner band turns one way').toContain('angle * 1.9 + t * 0.55');
  expect(source, 'the outer band turns the other').toContain('angle * 3.1 - t * 0.34');
});

test('the aura takes its colour from the caller', () => {
  /*
   * An aura takes the caller's glow colour, so it shifts with the world's palette
   * exactly as the lamps do. Hardcoding a purple here would freeze one palette into
   * every world the engine draws.
   */
  expect(source, 'the tint is declared').toContain('uniform vec3 uTint;');
  expect(source, 'and it actually reaches the output').toContain('col *= uTint;');
});

test('additive light still loses itself to fog', () => {
  /*
   * The exact term FIRE_FRAG carries, and for the exact reason its comment gives:
   * additive light that keeps its alpha through fog makes a distant aura glow
   * through weather and through water.
   */
  expect(source, 'colour is mixed toward the medium').toContain(
    'col = mix(col, mediumColor(), fog);',
  );
  expect(source, 'and alpha is taken down with it').toContain('alpha *= 1.0 - fog;');
});

test('the reflection pass can clip it', () => {
  /*
   * Every plume in the world is drawn a second time for the planar reflection, under
   * a clip plane. A shader that ignores uClipPlane draws its aura through the water
   * surface into the reflected image.
   */
  expect(source, 'the clip test is present').toContain(
    'if (uClipEnabled != 0 && dot(vec4(vWorldPos, 1.0), uClipPlane) < 0.0) discard;',
  );
});
