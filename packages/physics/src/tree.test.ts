import { describe, expect, it } from 'vitest';
import { aabbFromCenter } from './collide/index.ts';
import type { Aabb } from './collide/index.ts';
import { DynamicTree } from './tree.ts';

function box(cx: number, cy: number, cz: number, h = 0.5): Aabb {
  return aabbFromCenter(cx, cy, cz, h, h, h);
}

/** Brute force, so the tree is checked against something that is not the tree. */
function overlapping(boxes: readonly Aabb[], q: Aabb): number[] {
  const out: number[] = [];
  boxes.forEach((b, i) => {
    // The tree stores fat bounds, so brute force uses the same margin to be comparable.
    if (
      b.minX - 0.1 <= q.maxX &&
      b.maxX + 0.1 >= q.minX &&
      b.minY - 0.1 <= q.maxY &&
      b.maxY + 0.1 >= q.minY &&
      b.minZ - 0.1 <= q.maxZ &&
      b.maxZ + 0.1 >= q.minZ
    )
      out.push(i);
  });
  return out;
}

/** A seeded generator, because a test whose input changes per run is not a test. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('DynamicTree', () => {
  it('finds a proxy that overlaps and not one that does not', () => {
    const tree = new DynamicTree();
    tree.insert(7, box(0, 0, 0));
    tree.insert(9, box(10, 0, 0));
    const out = new Int32Array(8);
    expect(tree.query(box(0.2, 0, 0), out)).toBe(1);
    expect(out[0]).toBe(7);
    expect(tree.query(box(100, 0, 0), out)).toBe(0);
  });

  it('agrees with brute force over two hundred seeded boxes', () => {
    const rand = seeded(12345);
    const tree = new DynamicTree(4);
    const boxes: Aabb[] = [];
    for (let i = 0; i < 200; i++) {
      const b = box(rand() * 40 - 20, rand() * 40 - 20, rand() * 40 - 20, 0.2 + rand() * 2);
      boxes.push(b);
      tree.insert(i, b);
    }
    const out = new Int32Array(256);
    for (let q = 0; q < 30; q++) {
      const query = box(rand() * 40 - 20, rand() * 40 - 20, rand() * 40 - 20, 1 + rand() * 3);
      const n = tree.query(query, out);
      const found = [...out.slice(0, n)].sort((a, b) => a - b);
      expect(found).toEqual(overlapping(boxes, query));
    }
  });

  it('holds 2n − 1 nodes for n leaves', () => {
    const tree = new DynamicTree(4);
    for (let i = 0; i < 17; i++) tree.insert(i, box(i * 3, 0, 0));
    expect(tree.count).toBe(2 * 17 - 1);
  });

  it('does not touch the tree for a move inside the fat margin', () => {
    const tree = new DynamicTree();
    const leaf = tree.insert(0, box(0, 0, 0));
    tree.insert(1, box(5, 0, 0));
    expect(tree.move(leaf, box(0.05, 0, 0))).toBe(false);
  });

  it('re-places a proxy that leaves its margin, and still finds it', () => {
    const tree = new DynamicTree();
    const leaf = tree.insert(0, box(0, 0, 0));
    tree.insert(1, box(5, 0, 0));
    expect(tree.move(leaf, box(20, 0, 0))).toBe(true);
    const out = new Int32Array(8);
    expect(tree.query(box(20, 0, 0), out)).toBe(1);
    expect(out[0]).toBe(0);
    expect(tree.query(box(0, 0, 0), out)).toBe(0);
  });

  it('keeps every other proxy findable after a removal', () => {
    const tree = new DynamicTree(4);
    const leaves: number[] = [];
    for (let i = 0; i < 12; i++) leaves.push(tree.insert(i, box(i * 3, 0, 0)));
    tree.remove(leaves[5] ?? 0);
    const out = new Int32Array(8);
    for (let i = 0; i < 12; i++) {
      const n = tree.query(box(i * 3, 0, 0), out);
      expect(n).toBe(i === 5 ? 0 : 1);
    }
    expect(tree.count).toBe(2 * 11 - 1);
  });

  it('empties cleanly and can be refilled', () => {
    const tree = new DynamicTree(4);
    const leaves: number[] = [];
    for (let i = 0; i < 6; i++) leaves.push(tree.insert(i, box(i * 3, 0, 0)));
    for (const leaf of leaves) tree.remove(leaf);
    expect(tree.count).toBe(0);
    const out = new Int32Array(8);
    expect(tree.query(box(0, 0, 0), out)).toBe(0);
    tree.insert(99, box(0, 0, 0));
    expect(tree.query(box(0, 0, 0), out)).toBe(1);
    expect(out[0]).toBe(99);
  });

  /**
   * A floor against total degeneration, not an assertion about the heuristic.
   *
   * Sixty-four boxes in a row along x built a **chain of height 63** before rotations existed,
   * because the surface-area descent unions most cheaply with the last leaf every time. A wall, a
   * stack and a floor strip are all that shape, and a chain makes every query linear. With
   * rotations it is 6, which is log2(64).
   *
   * The bound is 20 rather than 7 deliberately: pinning it near optimum would assert the
   * *heuristic*, which is tuning and which `AGENTS.md` says never to test. Removing the
   * surface-area choice entirely gives 8, and this test passes — that is correct, because what the
   * heuristic buys once rotations exist is tightness of fit rather than depth, and tightness is a
   * benchmark's question.
   */
  it('does not degenerate into a chain on a row of boxes', () => {
    const tree = new DynamicTree(4);
    for (let i = 0; i < 64; i++) tree.insert(i, box(i * 3, 0, 0));
    expect(tree.height[tree.root]).toBeLessThan(20);
  });

  it('grows past its node capacity', () => {
    const tree = new DynamicTree(2);
    for (let i = 0; i < 64; i++) tree.insert(i, box(i, 0, 0));
    const out = new Int32Array(256);
    expect(tree.query(box(-100, -100, -100, 1000), out)).toBe(64);
  });
});
