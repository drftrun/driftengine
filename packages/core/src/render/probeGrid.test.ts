import { expect, test } from 'vitest';

import type { Vec3 } from '../math/color.ts';
import { MAX_ENV_PROBES, ProbeGrid, createProbeBlend, nearestProbes } from './probeGrid.ts';

const blend = createProbeBlend();
const at = (): Vec3 => [0, 0, 0];

function grid(counts: Vec3, spacing: Vec3 = [2, 2, 2], origin: Vec3 = [0, 0, 0]): ProbeGrid {
  return new ProbeGrid({ origin, spacing, counts });
}

function sum(weights: Float32Array): number {
  let total = 0;
  for (const w of weights) total += w;
  return total;
}

/** What every fragment of every lit frame relies on, so it is asserted everywhere rather than once. */
test('the weights sum to one, inside the grid and outside it', () => {
  const g = grid([3, 2, 4], [2, 3, 1.5], [-4, 1, 10]);
  for (let i = -6; i <= 12; i++) {
    for (let j = -6; j <= 12; j++) {
      const x = -4 + i * 0.7;
      const y = 1 + j * 0.9;
      const z = 10 + ((i * j) % 7) * 0.8;
      nearestProbes(g, x, y, z, blend);
      expect(sum(blend.weights), `at ${x},${y},${z}`).toBeCloseTo(1, 6);
    }
  }
});

/*
 * The single-probe case is the one every scene that exists today becomes, so it is not allowed to
 * be a special case in the code and it has to behave exactly here. Every corner resolves to the
 * one layer and the weights add to one across the duplicates.
 */
test('a one-probe grid returns that probe at weight one, from anywhere', () => {
  const g = grid([1, 1, 1], [4, 4, 4], [7, -2, 3]);
  expect(g.layers).toBe(1);
  for (const p of [
    [7, -2, 3],
    [0, 0, 0],
    [-100, 40, 900],
  ] as Vec3[]) {
    nearestProbes(g, p[0], p[1], p[2], blend);
    expect(sum(blend.weights)).toBeCloseTo(1, 6);
    for (const layer of blend.layers) expect(layer).toBe(0);
  }
});

/*
 * A probe's own position must take that probe and nothing else, or a bake and the lookup that
 * reads it disagree about which room a probe photographed — which reads as the grid being
 * misaligned by one cell and points at neither half.
 */
test('standing on a probe takes that probe alone', () => {
  const g = grid([3, 3, 3], [2, 2, 2], [-2, 0, 5]);
  const where = at();
  for (let layer = 0; layer < g.layers; layer++) {
    g.positionOf(layer, where);
    nearestProbes(g, where[0], where[1], where[2], blend);
    let taken = 0;
    for (let i = 0; i < 8; i++) {
      if ((blend.weights[i] ?? 0) > 1e-6) {
        expect(blend.layers[i], `layer ${layer}`).toBe(layer);
        taken += blend.weights[i] ?? 0;
      }
    }
    expect(taken, `layer ${layer}`).toBeCloseTo(1, 6);
  }
});

/*
 * Halfway between two probes on one axis is the case the whole trilinear blend exists for, and the
 * one a nearest-probe lookup gets visibly wrong: it is where a hard selection steps.
 */
test('halfway between two probes splits evenly between them', () => {
  const g = grid([2, 1, 1], [4, 4, 4], [0, 0, 0]);
  nearestProbes(g, 2, 0, 0, blend);
  const share = new Map<number, number>();
  for (let i = 0; i < 8; i++) {
    const layer = blend.layers[i] ?? 0;
    share.set(layer, (share.get(layer) ?? 0) + (blend.weights[i] ?? 0));
  }
  expect(share.get(0)).toBeCloseTo(0.5, 6);
  expect(share.get(1)).toBeCloseTo(0.5, 6);
});

/*
 * Clamping rather than wrapping, asserted because the alternative is not a crash: a wrap would
 * light an object at one end of the world with the probe from the other end, which reads as the
 * environment being wrong in one place and is invisible in a test that only checks the interior.
 */
test('outside the grid clamps to the edge probes rather than wrapping', () => {
  const g = grid([3, 1, 1], [2, 2, 2], [0, 0, 0]);
  nearestProbes(g, -50, 0, 0, blend);
  for (let i = 0; i < 8; i++) if ((blend.weights[i] ?? 0) > 1e-6) expect(blend.layers[i]).toBe(0);
  nearestProbes(g, 50, 0, 0, blend);
  for (let i = 0; i < 8; i++) if ((blend.weights[i] ?? 0) > 1e-6) expect(blend.layers[i]).toBe(2);
});

/*
 * **x fastest, then y, then z**, and the shader computes the same expression from three uniforms.
 * If the two ever disagree, every fragment reads a different probe than the one baked for it, and
 * nothing anywhere says so.
 */
test('the layer order is x fastest, then y, then z', () => {
  const g = grid([2, 3, 4]);
  expect(g.layers).toBe(24);
  expect(g.layerAt(0, 0, 0)).toBe(0);
  expect(g.layerAt(1, 0, 0)).toBe(1);
  expect(g.layerAt(0, 1, 0)).toBe(2);
  expect(g.layerAt(0, 0, 1)).toBe(6);
  expect(g.layerAt(1, 2, 3)).toBe(23);
});

test('a layer round-trips to its position and back', () => {
  const g = grid([2, 3, 4], [1.5, 2.5, 0.5], [3, -1, 8]);
  const where = at();
  for (let layer = 0; layer < g.layers; layer++) {
    g.positionOf(layer, where);
    const x = Math.round((where[0] - 3) / 1.5);
    const y = Math.round((where[1] + 1) / 2.5);
    const z = Math.round((where[2] - 8) / 0.5);
    expect(g.layerAt(x, y, z)).toBe(layer);
  }
});

/*
 * Fail fast at init, and say the arithmetic. Both of these reach the device as something else
 * entirely: a grid too large is a `texStorage3D` that loses the context, and a zero step is a
 * division by zero whose NaN arrives as a probe weight and reads as the environment being wrong
 * everywhere.
 */
test('a grid larger than the layer budget is refused at construction', () => {
  expect(() => grid([8, 8, 2])).toThrow(/128 probes and the limit is 64/);
  expect(MAX_ENV_PROBES).toBe(64);
});

test('a zero or negative step is refused at construction', () => {
  expect(() => grid([2, 2, 2], [2, 0, 2])).toThrow(/spacing on axis 1/);
  expect(() => grid([2, 2, 2], [2, 2, -1])).toThrow(/spacing on axis 2/);
});
