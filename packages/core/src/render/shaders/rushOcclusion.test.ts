import { expect, test } from 'vitest';

import { RUSH_FRAG } from './rush.ts';

/** Source with runs of whitespace collapsed, so formatting is not the assertion. */
const source = RUSH_FRAG.replace(/\s+/g, ' ');

/*
 * The occlusion is measured from the frame's jittered depth and applied to a picture a resolve has
 * taken the jitter out of: read at the pixel's own uv, every crevice shimmered by the jitter. Both
 * backends write the offset (their renderer tests say in which convention); this is the read.
 */
test('THE COMPOSITE READS THE OCCLUSION WHERE THE JITTER PUT IT', () => {
  expect(source).toContain('uniform vec2 uAoOffset;');
  expect(source).toContain('textureLod(uAo, vUv + uAoOffset, 0.0)');
});
