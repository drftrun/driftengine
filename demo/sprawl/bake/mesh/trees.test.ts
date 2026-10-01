import { describe, expect, it } from 'vitest';

import { growTree } from './trees.ts';

const plane = { species: 'TreePlane', variant: 1, bare: 0, size: null, leafSize: 1 } as const;

describe('grown trees', () => {
  it('A TREE STANDS ON ITS ROOT, ONE UNIT TALL, AND SWAYS FROM NOTHING AT THE ROOT TO ALL OF IT AT THE LEAVES', () => {
    const { wood, leaves } = growTree(plane, 0, 5);
    if (wood === null) throw new Error('a plane has wood');
    const ys = (m: typeof leaves) => Array.from(m.positions).filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys(wood))).toBeCloseTo(0, 6);
    /* The crown's top is the unit height, and a card reaches at most half its side above that. */
    expect(Math.max(...ys(leaves))).toBeLessThanOrEqual(1 + 0.2 * 1.2);
    const sway = (m: typeof leaves) => Array.from(m.channel ?? []).filter((_, i) => i % 4 === 0);
    /* The root's ring does not move; every leaf moves fully. */
    expect(Math.min(...sway(wood))).toBe(0);
    expect(new Set(sway(leaves))).toEqual(new Set([1]));
    expect(new Set(Array.from(leaves.layers ?? []))).toEqual(new Set([5]));
  });

  it('a hedge fills its own box, and bare leaves out that share of a crown', () => {
    const hedge = growTree(
      { species: 'TreeHedge', variant: 0, bare: 0, size: [2.6, 2.3, 0.34], leafSize: 1 },
      0,
      0,
    );
    expect(hedge.wood).toBeNull();
    /* 2.6 m across in 1 m cards is 3, 2.3 m up is 2, 0.34 m deep is 1: six crossed pairs. */
    expect(hedge.leaves.positions.length / 3).toBe(6 * 2 * 4);
    const bare = growTree({ ...plane, bare: 0.8 }, 0, 0);
    /* A plane's 46 cards, 80% gone: 9 crossed pairs. */
    expect(bare.leaves.positions.length / 3).toBe(9 * 2 * 4);
  });

  it('a variant grows the same every time', () => {
    const a = growTree(plane, 0, 0).leaves.positions;
    const b = growTree(plane, 0, 0).leaves.positions;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(growTree({ ...plane, variant: 2 }, 0, 0).leaves.positions)).not.toEqual(
      Array.from(a),
    );
  });
});
