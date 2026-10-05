import { expect, test } from 'vitest';

import { skinVertex } from '../recon/motionVectors.ts';
import { SKINNING_GLSL, skinEight } from './skinning.ts';

/** n joints, all identity, with joint `moved` translated by (dx, 0, 0). Column-major. */
function palette(n: number, moved: number, dx: number): Float64Array {
  const out = new Float64Array(n * 16);
  for (let j = 0; j < n; j++) {
    out[j * 16] = 1;
    out[j * 16 + 5] = 1;
    out[j * 16 + 10] = 1;
    out[j * 16 + 15] = 1;
  }
  out[moved * 16 + 12] = dx;
  return out;
}

/*
 * **A vertex held by its sixth influence moves with that joint.** Eight joints, the fourth moved two
 * along x; the vertex names it only in the second set, at full weight. Four influences would leave
 * it where it was, which is the deformation a face or a shoulder lost.
 */
test('A VERTEX HELD BY ITS SIXTH INFLUENCE MOVES WITH THAT JOINT', () => {
  const out = new Float64Array(4);
  skinVertex(
    palette(8, 3, 2),
    [0, 0, 0, 0, 0, 3, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0],
    [0.5, 1, 0],
    out,
  );
  expect(Array.from(out)).toEqual([2.5, 1, 0, 1]);
});

/* And split across the two sets, half and half, it moves half as far. */
test('half on a first-set joint and half on a second-set one moves half way', () => {
  const out = new Float64Array(4);
  skinVertex(
    palette(8, 6, 4),
    [0, 0, 0, 0, 6, 0, 0, 0],
    [0.5, 0, 0, 0, 0.5, 0, 0, 0],
    [0, 0, 0],
    out,
  );
  expect(out[0]).toBeCloseTo(2, 12);
});

/* The shader makes the same second sum, behind the switch, and only a program built with it on. */
test('the skinning stage adds the second four only where the switch is on', () => {
  const source = SKINNING_GLSL.replace(/\s+/g, ' ');
  expect(source).toContain('const bool SKIN_EIGHT = false;');
  expect(source).toContain('if (SKIN_EIGHT) { m += jointMatrix(int(aJoints2.x)) * aWeights2.x');
  expect(source).toContain('layout(location = 14) in vec4 aJoints2;');
  expect(source).toContain('layout(location = 15) in vec4 aWeights2;');
  expect(skinEight(SKINNING_GLSL)).toContain('const bool SKIN_EIGHT = true;');
  expect(() => skinEight('void main() {}')).toThrow(/SKIN_EIGHT/);
});
