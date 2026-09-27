import { expect, test } from 'vitest';
import { ProbeSweeps } from './probeSweeps.ts';

/**
 * The grid's sweeps, held and blended: which layer a bake writes, when a sweep is complete, and how
 * far the shading has moved from the last complete sweep toward the newest. Values by hand, over a
 * grid of four probes so every step can be listed.
 */

test('A GRID BAKED A PROBE AT A TIME CHANGES SMOOTHLY: the last sweep blends into the newest', () => {
  const sweeps = new ProbeSweeps(4, true);
  const uniforms = new Float32Array(3);
  expect(sweeps.sets).toBe(3);
  expect(sweeps.ready, 'nothing to show until one sweep is whole').toBe(false);

  /* The first sweep writes the first set. */
  for (let layer = 0; layer < 4; layer++) {
    expect(sweeps.writeLayer(layer)).toBe(layer);
    sweeps.baked(layer);
  }
  expect(sweeps.ready).toBe(true);
  /* It is shown alone: blending it with itself. */
  sweeps.uniforms(uniforms);
  expect([...uniforms]).toEqual([0, 0, 0]);

  /* The second sweep writes the second set, and nothing shown moves until it is whole. */
  expect(sweeps.writeLayer(2)).toBe(6);
  sweeps.baked(2);
  sweeps.uniforms(uniforms);
  expect([...uniforms]).toEqual([0, 0, 0.25]);
  for (const layer of [0, 1, 3]) sweeps.baked(layer);

  /* Whole: the first sweep is shown, blending toward the second as the third is baked. */
  sweeps.uniforms(uniforms);
  expect([...uniforms]).toEqual([0, 4, 0]);
  expect(sweeps.writeLayer(0), 'the third set, which neither end of the blend holds').toBe(8);
  sweeps.baked(0);
  sweeps.baked(0);
  sweeps.uniforms(uniforms);
  expect(uniforms[2], 'a probe baked twice counts once').toBe(0.25);
  for (const layer of [1, 2, 3]) sweeps.baked(layer);

  /* And round: the second shown, toward the third, the first set written again. */
  sweeps.uniforms(uniforms);
  expect([...uniforms]).toEqual([4, 8, 0]);
  expect(sweeps.writeLayer(3)).toBe(3);
});

test('a grid that does not blend writes its one set and shows it', () => {
  const sweeps = new ProbeSweeps(4, false);
  const uniforms = new Float32Array(3);
  expect(sweeps.sets).toBe(1);
  expect(sweeps.writeLayer(3)).toBe(3);
  for (let layer = 0; layer < 3; layer++) sweeps.baked(layer);
  expect(sweeps.ready, 'every probe, as before').toBe(false);
  sweeps.baked(3);
  expect(sweeps.ready).toBe(true);
  sweeps.baked(1);
  sweeps.uniforms(uniforms);
  expect([...uniforms]).toEqual([0, 0, 0]);
  expect(sweeps.writeLayer(1)).toBe(1);
});
