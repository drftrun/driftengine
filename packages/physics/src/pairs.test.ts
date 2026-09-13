import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC, BodySet } from './bodies.ts';
import type { BodyType } from './bodies.ts';
import { aabbFromCenter } from './collide/index.ts';
import { MAX_BODIES, PairSet, pairA, pairB, pairKey } from './pairs.ts';
import { PhysicsWorld } from './world.ts';
import { capsuleShape } from './shape.ts';
import { boxShape } from './shape.ts';
import { DynamicTree } from './tree.ts';

interface Spec {
  x: number;
  type?: BodyType;
  layer?: number;
  mask?: number;
}

/** Build a world from specs, in the order given, and return its sorted pair list. */
function pairsFor(specs: readonly Spec[]): string[] {
  const bodies = new BodySet();
  const tree = new DynamicTree(4);
  const leafOf = new Int32Array(specs.length);
  for (const spec of specs) {
    const i = bodies.add({
      type: spec.type ?? BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      x: spec.x,
      layer: spec.layer,
      mask: spec.mask,
    });
    leafOf[i] = tree.insert(i, aabbFromCenter(spec.x, 0, 0, 0.5, 0.5, 0.5));
  }
  const pairs = new PairSet();
  const n = pairs.build(bodies, tree, leafOf);
  // Name each pair by its bodies' x, so the answer survives a reordering of the inputs.
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = pairs.keys[i] ?? 0;
    const xa = bodies.posX[pairA(key)] ?? 0;
    const xb = bodies.posX[pairB(key)] ?? 0;
    out.push([xa, xb].sort((p, q) => p - q).join('|'));
  }
  return out.sort();
}

describe('PairSet', () => {
  it('finds a touching pair and not a distant one', () => {
    expect(pairsFor([{ x: 0 }, { x: 0.5 }, { x: 40 }])).toEqual(['0|0.5']);
  });

  it('reports an unordered pair once, not twice', () => {
    const all = pairsFor([{ x: 0 }, { x: 0.5 }]);
    expect(all.length).toBe(1);
  });

  it('never pairs a body with itself', () => {
    const bodies = new BodySet();
    const tree = new DynamicTree(4);
    const leafOf = new Int32Array(1);
    const i = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5) });
    leafOf[i] = tree.insert(i, aabbFromCenter(0, 0, 0, 0.5, 0.5, 0.5));
    expect(new PairSet().build(bodies, tree, leafOf)).toBe(0);
  });

  /**
   * The load-bearing one. A tree's shape depends on insertion order and its traversal on its
   * shape, so a pair list taken straight from the tree carries insertion history into a solver
   * whose result is order-dependent.
   */
  it('gives the same pairs whichever order the bodies were added in', () => {
    const forward = [{ x: 0 }, { x: 0.5 }, { x: 1 }, { x: 1.5 }, { x: 8 }, { x: 8.5 }];
    const reversed = [...forward].reverse();
    expect(pairsFor(reversed)).toEqual(pairsFor(forward));
  });

  it('sorts by packed body index, ascending', () => {
    const bodies = new BodySet();
    const tree = new DynamicTree(4);
    const leafOf = new Int32Array(6);
    for (let i = 0; i < 6; i++) {
      const b = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), x: i * 0.5 });
      leafOf[b] = tree.insert(b, aabbFromCenter(i * 0.5, 0, 0, 0.5, 0.5, 0.5));
    }
    const pairs = new PairSet();
    const n = pairs.build(bodies, tree, leafOf);
    expect(n).toBeGreaterThan(2);
    for (let i = 1; i < n; i++) {
      expect(pairs.keys[i] ?? 0).toBeGreaterThan(pairs.keys[i - 1] ?? 0);
    }
  });

  it('never pairs two static bodies, however close', () => {
    expect(
      pairsFor([
        { x: 0, type: BODY_STATIC },
        { x: 0.5, type: BODY_STATIC },
      ]),
    ).toEqual([]);
  });

  it('pairs a static body with a dynamic one', () => {
    expect(pairsFor([{ x: 0, type: BODY_STATIC }, { x: 0.5 }])).toEqual(['0|0.5']);
  });

  it('excludes a pair whose layers do not admit each other', () => {
    expect(
      pairsFor([
        { x: 0, layer: 1, mask: 1 },
        { x: 0.5, layer: 2, mask: 2 },
      ]),
    ).toEqual([]);
  });

  /**
   * The mask is checked both ways, and this test exists because the obvious version of it does not
   * check that. `{layer:1, mask:0xffffffff}` against `{layer:2, mask:2}` fails `la & mb` on the
   * *first* clause, so deleting the second one passed it. These values fail only the second:
   * A's layer is in B's mask, and B's layer is not in A's.
   */
  it('needs both sides to admit, not one', () => {
    expect(
      pairsFor([
        { x: 0, layer: 1, mask: 1 },
        { x: 0.5, layer: 2, mask: 1 },
      ]),
    ).toEqual([]);
  });

  it('admits a pair only when each mask holds the other layer', () => {
    expect(
      pairsFor([
        { x: 0, layer: 1, mask: 2 },
        { x: 0.5, layer: 2, mask: 1 },
      ]),
    ).toEqual(['0|0.5']);
  });

  it('packs and unpacks a key at the top of the range', () => {
    const key = 65535 * MAX_BODIES + 65534;
    expect(pairA(key)).toBe(65535);
    expect(pairB(key)).toBe(65534);
  });

  it('refuses more bodies than a pair key can express', () => {
    const bodies = new BodySet();
    // Lie about the count rather than allocating 65,536 real bodies.
    bodies.count = MAX_BODIES;
    expect(() => new PairSet().build(bodies, new DynamicTree(), new Int32Array(1))).toThrow(
      /exceeds/,
    );
  });

  /**
   * Sortedness past body index 256, which is where the key's top byte stops being zero.
   *
   * A twelve-body scene never pushes a key past 2^24, so three radix passes sorted it perfectly and
   * the four-pass version could be cut to three without failing anything. Three hundred bodies put
   * real data in the top byte.
   */
  it('sorts keys whose top byte is not zero', () => {
    const bodies = new BodySet();
    const tree = new DynamicTree(4);
    const leafOf = new Int32Array(300);
    for (let i = 0; i < 300; i++) {
      const b = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), x: i * 0.6 });
      leafOf[b] = tree.insert(b, aabbFromCenter(i * 0.6, 0, 0, 0.5, 0.5, 0.5));
    }
    const pairs = new PairSet();
    const n = pairs.build(bodies, tree, leafOf);
    expect(n).toBeGreaterThan(200);
    expect(pairs.keys[n - 1] ?? 0).toBeGreaterThan(2 ** 24);
    for (let i = 1; i < n; i++) {
      expect(pairs.keys[i] ?? 0).toBeGreaterThan(pairs.keys[i - 1] ?? 0);
    }
  });

  it('grows past its initial capacity', () => {
    const specs: Spec[] = [];
    for (let i = 0; i < 60; i++) specs.push({ x: i * 0.2 });
    expect(pairsFor(specs).length).toBeGreaterThan(256);
  });
});

describe('excluding a pair outright', () => {
  /** Two overlapping boxes that would push each other apart, and then do not. */
  const overlapping = (): { world: PhysicsWorld; a: number; b: number } => {
    const world = new PhysicsWorld({ allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(30, 1, 30), y: -1 });
    const a = world.addBody({ type: BODY_DYNAMIC, shape: capsuleShape(0.2, 0.3), y: 2 });
    const b = world.addBody({ type: BODY_DYNAMIC, shape: capsuleShape(0.2, 0.3), y: 2.1 });
    return { world, a, b };
  };

  it('keys a pair the same in either order', () => {
    expect(pairKey(3, 7)).toBe(pairKey(7, 3));
  });

  it('stops two bodies whose layers admit each other from touching', () => {
    const { world, a, b } = overlapping();
    world.ignorePair(a, b);
    for (let i = 0; i < 30; i++) world.step(1 / 60);
    const apart = Math.abs((world.bodies.posY[a] ?? 0) - (world.bodies.posY[b] ?? 0));
    expect(apart, 'they should still be interpenetrating').toBeLessThan(0.2);
  });

  it('and they push apart without it, which is what makes the test above mean something', () => {
    const { world, a, b } = overlapping();
    for (let i = 0; i < 30; i++) world.step(1 / 60);
    const apart = Math.abs((world.bodies.posY[a] ?? 0) - (world.bodies.posY[b] ?? 0));
    expect(apart).toBeGreaterThan(0.3);
  });

  it('undoes one', () => {
    const { world, a, b } = overlapping();
    world.ignorePair(a, b);
    world.allowPair(a, b);
    expect(world.pairIgnored(a, b)).toBe(false);
  });

  /*
   * **A body index is a slot and not an identity.** `removeBody` moves the last body into the
   * hole, so an exclusion left alone would either name a body that is gone or quietly stop the
   * newcomer colliding with whatever the departed was jointed to. This is the same fact the warm
   * cache and the contact events are cleared for.
   */
  it('follows the body that a removal moves', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const a = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 5 });
    const b = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 7 });
    const c = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 9 });
    world.ignorePair(a, c);
    world.removeBody(b);
    /* `c` was last, so it took `b`'s slot and the exclusion has to have come with it. */
    expect(world.pairIgnored(a, b), 'c now lives at index b').toBe(true);
    expect(world.pairIgnored(a, c)).toBe(false);
  });

  it('drops an exclusion when one of its bodies goes', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    const a = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 5 });
    const b = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 7 });
    world.addBody({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), y: 9 });
    world.ignorePair(a, b);
    world.removeBody(a);
    /* Nothing may be excluded any more: `a` left, and whoever took its slot inherits nothing. */
    expect(world.pairIgnored(0, 1)).toBe(false);
  });
});
