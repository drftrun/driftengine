import { expect, test } from 'vitest';
import { buildTree } from './treeBuilder.ts';
import type { TreeParams } from './treeBuilder.ts';
import { mulberry32 } from '../core/rng.ts';

const SPRUCE: TreeParams = {
  height: 6,
  trunkRadius: 0.22,
  taper: 0.55,
  canopyRadius: 1.8,
  canopyClusters: 7,
  trunkColor: [0.3, 0.22, 0.16],
  canopyColor: [0.2, 0.45, 0.24],
};

function extents(positions: Float32Array): { maxY: number; maxRadius: number } {
  let maxY = -Infinity;
  let maxRadius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (y > maxY) maxY = y;
    maxRadius = Math.max(maxRadius, Math.hypot(x, z));
  }
  return { maxY, maxRadius };
}

test('a tree stays inside the bounds its placer was promised', () => {
  /*
   * The test that earns its keep. The scatter placer keeps trees clear of the
   * route using these numbers, so a tree that quietly exceeds them pokes
   * through the geometry it was carefully placed beside — and that reads as a
   * placement bug, miles from the builder that actually caused it.
   */
  for (let seed = 1; seed <= 40; seed++) {
    const tree = buildTree(SPRUCE, mulberry32(seed));
    for (const part of [tree.solid, tree.flexible]) {
      const { maxY, maxRadius } = extents(part.positions);
      expect(maxY, `seed ${seed} height`).toBeLessThanOrEqual(SPRUCE.height * 1.35);
      expect(maxRadius, `seed ${seed} radius`).toBeLessThanOrEqual(SPRUCE.canopyRadius * 1.35);
    }
  }
});

test('the same seed grows the same tree', () => {
  // Trees are placed from the daily seed, so two players must see one forest.
  const a = buildTree(SPRUCE, mulberry32(42));
  const b = buildTree(SPRUCE, mulberry32(42));
  expect(Array.from(b.solid.positions)).toEqual(Array.from(a.solid.positions));
  expect(Array.from(b.flexible.positions)).toEqual(Array.from(a.flexible.positions));
});

test('different seeds grow different trees', () => {
  const a = buildTree(SPRUCE, mulberry32(1));
  const b = buildTree(SPRUCE, mulberry32(2));
  expect(Array.from(b.solid.positions)).not.toEqual(Array.from(a.solid.positions));
});

test('trunk and canopy come back separately', () => {
  /*
   * Not a formality: the trunk is collidable and must never deform, the canopy
   * bends in the wind and must never be merged into static geometry. One mesh
   * can be collidable or animated, not both, and merging them would surface as
   * either a tree that separates from its own collider or a forest that stands
   * dead still in a gale.
   */
  const tree = buildTree(SPRUCE, mulberry32(9));
  expect(tree.solid.positions.length).toBeGreaterThan(0);
  expect(tree.flexible.positions.length).toBeGreaterThan(0);
  expect(tree.colliderRadius).toBeGreaterThan(0);
  expect(tree.colliderHeight).toBeGreaterThan(0);
  expect(tree.colliderHeight).toBeLessThan(SPRUCE.height);
});

test('degenerate parameters are rejected at build time', () => {
  expect(() => buildTree({ ...SPRUCE, height: 0 }, mulberry32(1))).toThrow();
  expect(() => buildTree({ ...SPRUCE, trunkRadius: 0 }, mulberry32(1))).toThrow();
});
