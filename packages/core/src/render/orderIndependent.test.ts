import { describe, expect, it } from 'vitest';

import { accumulateOit, newOitAccumulator, oitWeight, resolveOit } from './orderIndependent.ts';

/** Standard `over` compositing, which is what a correctly sorted single layer produces. */
function over(
  colour: readonly [number, number, number],
  alpha: number,
  background: readonly [number, number, number],
): [number, number, number] {
  return [
    colour[0] * alpha + background[0] * (1 - alpha),
    colour[1] * alpha + background[1] * (1 - alpha),
    colour[2] * alpha + background[2] * (1 - alpha),
  ];
}

describe('the depth weight', () => {
  /*
   * **A near fragment must count for more than a far one**, which is the whole of what the weight
   * is for: without it the accumulation is an unweighted average and a distant pane contributes as
   * much as the one against the camera, which reads as fog rather than as glass.
   */
  it('weighs a near fragment above a far one at the same alpha', () => {
    expect(oitWeight(2, 0.5)).toBeGreaterThan(oitWeight(40, 0.5));
    expect(oitWeight(40, 0.5)).toBeGreaterThan(oitWeight(400, 0.5));
  });

  it('scales with alpha, so a fainter fragment contributes less', () => {
    expect(oitWeight(10, 0.8)).toBeCloseTo(oitWeight(10, 0.4) * 2, 10);
  });

  /*
   * **Clamped at both ends, and the clamp is the thing that keeps this stable in float.** Without
   * a ceiling a fragment on the near plane takes a weight large enough to swamp every other layer
   * and the sum loses their contribution to rounding; without a floor a distant one is rounded to
   * nothing and vanishes rather than fading.
   */
  it('is bounded however near or far the fragment is', () => {
    const near = oitWeight(0, 1);
    const far = oitWeight(100000, 1);
    expect(Number.isFinite(near)).toBe(true);
    expect(near).toBeLessThanOrEqual(3e3);
    expect(far).toBeGreaterThanOrEqual(1e-2);
  });

  it('is never negative, whatever it is handed', () => {
    for (const z of [0, 0.1, 1, 25, 1000, 1e6]) {
      expect(oitWeight(z, 0.25)).toBeGreaterThan(0);
    }
  });
});

describe('accumulating and resolving', () => {
  it('leaves the background alone where nothing was drawn', () => {
    const state = newOitAccumulator();
    const out = resolveOit(state, [0.2, 0.4, 0.6]);
    expect(out[0]).toBeCloseTo(0.2, 12);
    expect(out[1]).toBeCloseTo(0.4, 12);
    expect(out[2]).toBeCloseTo(0.6, 12);
  });

  /*
   * **One layer has to be exact, not approximate.** Weighted blending is an approximation of the
   * *ordering* between layers; with only one there is no ordering to approximate, so it must
   * reproduce `over` precisely. If it does not, the error is in the algebra rather than in the
   * heuristic, and every multi-layer result is built on it.
   */
  it('reproduces ordinary alpha blending exactly for a single layer', () => {
    const background: [number, number, number] = [0.1, 0.15, 0.2];
    const colour: [number, number, number] = [0.9, 0.3, 0.4];
    for (const alpha of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const state = newOitAccumulator();
      accumulateOit(state, colour, alpha, 12);
      const out = resolveOit(state, background);
      const want = over(colour, alpha, background);
      expect(out[0]).toBeCloseTo(want[0], 10);
      expect(out[1]).toBeCloseTo(want[1], 10);
      expect(out[2]).toBeCloseTo(want[2], 10);
    }
  });

  /*
   * **This is the row.** "Two panes of glass stop depending on submission order" is the gap the
   * census names, and it is a property of the arithmetic rather than of the renderer: the
   * accumulation is a sum and the revealage a product, and both commute. A change that made
   * either depend on the order it was called in would fail here before it ever reached a GPU.
   */
  it('gives the same answer whichever order the layers arrive in', () => {
    const background: [number, number, number] = [0.05, 0.05, 0.08];
    const near = { colour: [0.9, 0.2, 0.2] as [number, number, number], alpha: 0.4, z: 3 };
    const far = { colour: [0.1, 0.3, 0.95] as [number, number, number], alpha: 0.6, z: 30 };

    const forwards = newOitAccumulator();
    accumulateOit(forwards, near.colour, near.alpha, near.z);
    accumulateOit(forwards, far.colour, far.alpha, far.z);

    const backwards = newOitAccumulator();
    accumulateOit(backwards, far.colour, far.alpha, far.z);
    accumulateOit(backwards, near.colour, near.alpha, near.z);

    const a = resolveOit(forwards, background);
    const b = resolveOit(backwards, background);
    expect(a[0]).toBeCloseTo(b[0], 12);
    expect(a[1]).toBeCloseTo(b[1], 12);
    expect(a[2]).toBeCloseTo(b[2], 12);
  });

  it('gives the same answer for three layers in any of their orders', () => {
    const background: [number, number, number] = [0, 0, 0];
    const layers = [
      { colour: [1, 0, 0] as [number, number, number], alpha: 0.3, z: 2 },
      { colour: [0, 1, 0] as [number, number, number], alpha: 0.5, z: 9 },
      { colour: [0, 0, 1] as [number, number, number], alpha: 0.7, z: 25 },
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [2, 0, 1],
    ];
    const results = orders.map((order) => {
      const state = newOitAccumulator();
      for (const i of order) {
        const layer = layers[i];
        if (layer === undefined) throw new Error('bad order');
        accumulateOit(state, layer.colour, layer.alpha, layer.z);
      }
      return resolveOit(state, background);
    });
    const first = results[0];
    if (first === undefined) throw new Error('no results');
    for (const other of results.slice(1)) {
      expect(other[0]).toBeCloseTo(first[0], 12);
      expect(other[1]).toBeCloseTo(first[1], 12);
      expect(other[2]).toBeCloseTo(first[2], 12);
    }
  });

  /*
   * **An opaque layer must cover what is behind it**, or "order-independent" would have bought
   * transparency at the cost of occlusion.
   */
  it('hides the background behind a fully opaque layer', () => {
    const state = newOitAccumulator();
    accumulateOit(state, [0.3, 0.6, 0.9], 1, 5);
    const out = resolveOit(state, [1, 1, 1]);
    expect(out[0]).toBeCloseTo(0.3, 10);
    expect(out[1]).toBeCloseTo(0.6, 10);
    expect(out[2]).toBeCloseTo(0.9, 10);
  });
});
