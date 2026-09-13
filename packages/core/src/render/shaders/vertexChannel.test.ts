import { expect, test } from 'vitest';

import { CHANNEL_ATTRIBUTE, CHANNEL_BEND } from './vertexChannel.ts';

test('declares the channel at 13 and every wind uniform the bend reads', () => {
  expect(CHANNEL_ATTRIBUTE).toContain('layout(location = 13) in vec4 aChannel;');
  for (const name of [
    'uWindDirection',
    'uWindSpeed',
    'uWindGust',
    'uWindTime',
    'uWindSpatialPhase',
  ]) {
    expect(CHANNEL_ATTRIBUTE).toContain(name);
  }
});

/*
 * **The one deliberate deviation from `scatter.ts`, asserted so it cannot drift back.** That
 * shader squares a falloff it derives from height; this lane is authored, so squaring it would
 * overrule a curve the author already shaped. A reviewer who "fixes" this to match scatter is
 * changing a decision, and this test is where they find that out.
 */
test('scales the bend by the lane once, not by its square', () => {
  expect(CHANNEL_BEND).toContain('* sway');
  expect(CHANNEL_BEND).not.toContain('sway * sway');
});

/*
 * Phase from world position is what makes a gust travel rather than the whole canopy pulsing at
 * once. A bend that read only the clock would animate every vertex in the world in lockstep.
 */
test('takes its phase from world position, so a gust travels across geometry', () => {
  expect(CHANNEL_BEND).toContain('dot(worldPos.xz, uWindSpatialPhase)');
});

/*
 * Geometry that never said it bends must reach exactly the position it reached before this
 * existed. `sin(phase) * 0.0` is not reliably bit-identical to not moving, so the zero case
 * returns early rather than arriving at the same place by arithmetic.
 */
test('leaves an unswayed vertex untouched rather than multiplying it by zero', () => {
  expect(CHANNEL_BEND).toContain('if (sway <= 0.0) return worldPos;');
});
