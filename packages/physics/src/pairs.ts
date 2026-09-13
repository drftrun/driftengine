import { BODY_STATIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';
import type { Aabb } from './collide/index.ts';
import { DynamicTree } from './tree.ts';

/**
 * Candidate body pairs, ordered by body index and never by tree shape.
 *
 * **This is the file that makes the broadphase safe to change.** A dynamic tree's shape depends on
 * the order proxies were inserted in, and its traversal order depends on its shape — so a pair list
 * taken straight from the tree carries insertion history in it. Sequential impulses are
 * order-dependent, so that history would reach the simulation's *result*, and a scene rebuilt in a
 * different order would diverge while looking identical.
 *
 * So every pair is packed into one 32-bit key as `min * 2^16 + max`, radix-sorted, and nothing
 * downstream ever learns there was a tree. **What this costs** is a two-pass sort over preallocated
 * scratch each tick. **What would make it wrong** is more than 65,536 bodies, which the key cannot
 * express; `MAX_BODIES` names that and the builder refuses past it rather than aliasing two pairs
 * onto one key.
 */

/** The key packs two indices into 32 bits, so neither may reach this. */
export const MAX_BODIES = 1 << 16;

export class PairSet {
  /** Packed `(min, max)` keys, sorted ascending. Read `count` of them. */
  keys: Uint32Array;
  count = 0;

  private scratch: Uint32Array;
  private histogram = new Uint32Array(256);
  private hits: Int32Array;
  private queryBox: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  constructor(capacity = 256) {
    this.keys = new Uint32Array(capacity);
    this.scratch = new Uint32Array(capacity);
    this.hits = new Int32Array(256);
  }

  /**
   * Collect every candidate pair among the tree's proxies, sorted.
   *
   * `leafOf` maps a body index to its tree leaf, because a query answers with proxy ids and the
   * tree needs the leaf to read a body's stored bounds back.
   */
  build(
    bodies: BodySet,
    tree: DynamicTree,
    leafOf: Int32Array,
    ignored: ReadonlySet<number> | null = null,
  ): number {
    this.count = 0;
    if (bodies.count >= MAX_BODIES) {
      throw new Error(`PairSet: ${bodies.count} bodies exceeds the ${MAX_BODIES} a pair key holds`);
    }
    for (let a = 0; a < bodies.count; a++) {
      const leaf = leafOf[a] ?? -1;
      if (leaf < 0) continue;
      const at = leaf * 6;
      this.queryBox.minX = tree.bounds[at] ?? 0;
      this.queryBox.minY = tree.bounds[at + 1] ?? 0;
      this.queryBox.minZ = tree.bounds[at + 2] ?? 0;
      this.queryBox.maxX = tree.bounds[at + 3] ?? 0;
      this.queryBox.maxY = tree.bounds[at + 4] ?? 0;
      this.queryBox.maxZ = tree.bounds[at + 5] ?? 0;

      let found = tree.query(this.queryBox, this.hits);
      while (found === this.hits.length) {
        // The query truncated, so it cannot be trusted to have reported everything.
        this.hits = new Int32Array(this.hits.length * 2);
        found = tree.query(this.queryBox, this.hits);
      }
      for (let k = 0; k < found; k++) {
        const b = this.hits[k] ?? 0;
        // Each unordered pair once, and never a body against itself.
        if (b <= a) continue;
        if (!layersInteract(bodies, a, b)) continue;
        /* `b > a` by the test above, so this is already the order `pairKey` writes. */
        const key = a * MAX_BODIES + b;
        /* The size test rather than the lookup: a world that never excluded a pair pays one
           integer compare per candidate, which is what keeps this out of everybody else's way. */
        if (ignored !== null && ignored.size !== 0 && ignored.has(key)) continue;
        this.push(key);
      }
    }
    this.sort();
    return this.count;
  }

  private push(key: number): void {
    if (this.count === this.keys.length) {
      const wider = new Uint32Array(this.keys.length * 2);
      wider.set(this.keys);
      this.keys = wider;
      this.scratch = new Uint32Array(wider.length);
    }
    this.keys[this.count++] = key;
  }

  /**
   * Four passes of an 8-bit radix sort, which is stable and touches no comparator.
   *
   * A comparison sort would also be deterministic, and this is here for the hot path rather than
   * for correctness: the pair list is rebuilt every tick and is the one array whose length grows
   * with the square of local density.
   */
  private sort(): void {
    let from = this.keys;
    let into = this.scratch;
    for (let shift = 0; shift < 32; shift += 8) {
      this.histogram.fill(0);
      for (let i = 0; i < this.count; i++) {
        this.histogram[((from[i] ?? 0) >>> shift) & 255]++;
      }
      let sum = 0;
      for (let d = 0; d < 256; d++) {
        const c = this.histogram[d] ?? 0;
        this.histogram[d] = sum;
        sum += c;
      }
      for (let i = 0; i < this.count; i++) {
        const key = from[i] ?? 0;
        const d = (key >>> shift) & 255;
        into[this.histogram[d]++] = key;
      }
      const swap = from;
      from = into;
      into = swap;
    }
    // Four passes is even, so the result is back where it started.
    this.keys = from;
    this.scratch = into;
  }
}

/** The 32-layer mask, both ways. A pair layersInteract only if each side admits the other. */
export function layersInteract(bodies: BodySet, a: number, b: number): boolean {
  if (bodies.type[a] === BODY_STATIC && bodies.type[b] === BODY_STATIC) return false;
  const la = bodies.layer[a] ?? 0;
  const lb = bodies.layer[b] ?? 0;
  const ma = bodies.mask[a] ?? 0;
  const mb = bodies.mask[b] ?? 0;
  return (la & mb) !== 0 && (lb & ma) !== 0;
}

/**
 * The key a pair of bodies is stored under, in either order.
 *
 * **Two bodies that must never collide cannot always be said with layers.** The mask is a property
 * of each body on its own, so it can express "this kind does not meet that kind" and cannot express
 * "these two in particular" — and a ragdoll is entirely the second thing: every bone overlaps the
 * one it hangs from, because that is what having a radius means, while the same two *kinds* of bone
 * elsewhere in the body must still collide. A consumer that tried it with layers spent a bit per
 * bone and most of the 32 on one doll.
 */
export function pairKey(a: number, b: number): number {
  return a < b ? a * MAX_BODIES + b : b * MAX_BODIES + a;
}

/** Unpack a key's lower body index. */
export function pairA(key: number): number {
  return Math.floor(key / MAX_BODIES);
}

/** Unpack a key's higher body index. */
export function pairB(key: number): number {
  return key % MAX_BODIES;
}
