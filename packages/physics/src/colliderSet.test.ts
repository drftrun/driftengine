import { expect, test } from 'vitest';
import { ColliderSet, boxCollider, colliderFromShape, stampAfter } from './colliderSet.ts';
import { hullShape } from './shape.ts';
import { aabbFromCenter } from './collide/index.ts';

const scratch = new Int32Array(ColliderSet.MAX_HITS);

test('a query returns every box overlapping the region and no others', () => {
  const near = aabbFromCenter(0, 0, 0, 1, 1, 1); // x in [-1, 1]
  const far = aabbFromCenter(100, 0, 0, 1, 1, 1); // x in [99, 101]
  const set = new ColliderSet([near, far]);

  expect(set.query(-2, -2, -2, 2, 2, 2, scratch)).toBe(1);
  expect(scratch[0]).toBe(0);

  expect(set.query(98, -2, -2, 102, 2, 2, scratch)).toBe(1);
  expect(scratch[0]).toBe(1);

  expect(set.query(40, -2, -2, 50, 2, 2, scratch)).toBe(0);
});

test('a box spanning many cells is reported exactly once', () => {
  // 200 m slab across a 4 m grid: it occupies ~50 cells.
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 100, 1, 1)], 4);
  expect(set.query(-100, -2, -2, 100, 2, 2, scratch)).toBe(1);
});

test('box bounds survive the round trip into the typed array', () => {
  const set = new ColliderSet([aabbFromCenter(2, 3, 4, 0.5, 1.5, 2.5)]);
  expect(set.count).toBe(1);
  expect(Array.from(set.data.subarray(0, 6))).toEqual([1.5, 1.5, 1.5, 2.5, 4.5, 6.5]);
});

test('the broadphase agrees with a brute-force scan over a dense world', () => {
  // The contract that matters: the hash is an *optimisation*, so it must never
  // return a different answer than checking every box would.
  const boxes = [];
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 400; i++) {
    boxes.push(
      aabbFromCenter(
        rand() * 300 - 150,
        rand() * 60 - 30,
        rand() * 300 - 150,
        0.5 + rand() * 3,
        0.5 + rand() * 3,
        0.5 + rand() * 3,
      ),
    );
  }
  const set = new ColliderSet(boxes);

  for (let q = 0; q < 200; q++) {
    const cx = rand() * 300 - 150;
    const cy = rand() * 60 - 30;
    const cz = rand() * 300 - 150;
    const r = 1 + rand() * 8;
    const minX = cx - r,
      maxX = cx + r;
    const minY = cy - r,
      maxY = cy + r;
    const minZ = cz - r,
      maxZ = cz + r;

    const expected = new Set<number>();
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b === undefined) continue;
      if (
        b.maxX >= minX &&
        b.minX <= maxX &&
        b.maxY >= minY &&
        b.minY <= maxY &&
        b.maxZ >= minZ &&
        b.minZ <= maxZ
      ) {
        expected.add(i);
      }
    }

    const found = set.query(minX, minY, minZ, maxX, maxY, maxZ, scratch);
    const actual = new Set<number>();
    for (let i = 0; i < found; i++) actual.add(scratch[i] ?? -1);

    // The hash may over-report (cell granularity), never under-report: a missed
    // box is a box you fall through.
    for (const index of expected) {
      expect(actual.has(index), `query ${q} missed box ${index}`).toBe(true);
    }
  }
});

test('a collider can be read back out by index', () => {
  // The packing is private. Anything outside this file that decodes it by hand is a
  // bug waiting for the stride to change.
  const set = new ColliderSet([{ minX: -1, minY: -2, minZ: -3, maxX: 4, maxY: 5, maxZ: 6 }]);
  const out = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  set.bounds(0, out);
  expect(out).toEqual({ minX: -1, minY: -2, minZ: -3, maxX: 4, maxY: 5, maxZ: 6 });
});

test('a constructor-built set is dense, and its slots belong to the base group', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 1, 1), aabbFromCenter(9, 0, 0, 1, 1, 1)]);
  expect(set.count).toBe(2);
  expect(set.capacity).toBe(2);
  expect(set.liveAt(0)).toBe(true);
  expect(set.liveAt(1)).toBe(true);
});

/*
 * **The base group is reserved and that is not tidiness.** The constructor skips an `undefined`
 * entry without inserting it into any cell while still counting the slot, so those slots are live
 * and are in no bucket. Any removal path that reached them would walk buckets they were never
 * written to. Reserving the group keeps them out of every such path.
 */
test('the base group cannot be removed, and the refusal says what to do instead', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  expect(() => set.remove(ColliderSet.BASE_GROUP)).toThrow(/constructed empty/);
});

test('an unknown group is refused rather than quietly ignored', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  expect(() => set.remove(4321)).toThrow(/4321/);
});

/*
 * **The stamp used to be as short-lived as the set.** A rebuild per crossing handed out a fresh
 * one every few seconds; one mutable set lives a whole session. Two properties matter and neither
 * is reachable by driving `query` two billion times, so the decision is asserted where it is made.
 *
 * Past the limit a mark would truncate negative in `seen` and never match again, degrading `query`
 * to reporting every box in every cell it touches — safe under the over-report rule, and a cliff
 * with nothing pointing at it. And the value it returns to must never be one `seen` can already
 * hold: `add` writes `seen[slot] = 0` on a recycled slot, so a 0 mark would skip that slot, which
 * is the under-report direction the class forbids.
 */
test('the query stamp advances by one and never returns a value seen could hold', () => {
  expect(stampAfter(1)).toBe(2);
  expect(stampAfter(0x7ffffffd)).toBe(0x7ffffffe);
  expect(stampAfter(0x7ffffffe)).toBe(0x7fffffff);
  /* 0 is the signal to clear `seen`; the caller then marks with 1. Never a negative, which is
     what an Int32Array would have truncated it to. */
  expect(stampAfter(0x7fffffff)).toBe(0);
});

test('a group added after construction is queryable', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  const group = set.add([aabbFromCenter(50, 0, 0, 1, 1, 1)]);
  expect(group).not.toBe(ColliderSet.BASE_GROUP);
  expect(set.count).toBe(2);
  expect(set.query(48, -2, -2, 52, 2, 2, scratch)).toBe(1);
  expect(scratch[0]).toBe(1);
});

/* How a streamer builds one: empty, then a group per region. */
test('an empty set grows from nothing', () => {
  const set = new ColliderSet([]);
  expect(set.count).toBe(0);
  set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  set.add([aabbFromCenter(9, 0, 0, 1, 1, 1)]);
  expect(set.count).toBe(2);
  expect(set.capacity).toBeGreaterThanOrEqual(2);
  expect(set.query(-2, -2, -2, 2, 2, 2, scratch)).toBe(1);
  expect(set.query(7, -2, -2, 11, 2, 2, scratch)).toBe(1);
});

test('a shape added after construction is read back by index', () => {
  const set = new ColliderSet([]);
  set.add([boxCollider(5, 0, 0, 1, 1, 1)]);
  expect(set.shapeAt(0)).toBeDefined();
});

/*
 * The contract that matters, restated against a set that was grown instead of built: the hash is
 * an *optimisation*, so it must never answer differently from checking every box.
 */
test('the broadphase agrees with a brute-force scan over a set built by two hundred adds', () => {
  const set = new ColliderSet([]);
  const boxes: ReturnType<typeof aabbFromCenter>[] = [];
  let seed = 999;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 200; i++) {
    const box = aabbFromCenter(rand() * 300 - 150, rand() * 60 - 30, rand() * 300 - 150, 1, 1, 1);
    boxes.push(box);
    set.add([box]);
  }
  for (let q = 0; q < 200; q++) {
    const x = rand() * 320 - 160;
    const y = rand() * 70 - 35;
    const z = rand() * 320 - 160;
    const n = set.query(x - 5, y - 5, z - 5, x + 5, y + 5, z + 5, scratch);
    const found = new Set(Array.from(scratch.subarray(0, n)));
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i] as (typeof boxes)[number];
      const overlaps =
        b.maxX >= x - 5 &&
        b.minX <= x + 5 &&
        b.maxY >= y - 5 &&
        b.minY <= y + 5 &&
        b.maxZ >= z - 5 &&
        b.minZ <= z + 5;
      if (overlaps) expect(found.has(i)).toBe(true);
    }
  }
});

test('a removed group is gone from every query that used to find it', () => {
  const set = new ColliderSet([]);
  const keep = set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  const drop = set.add([aabbFromCenter(50, 0, 0, 1, 1, 1)]);
  expect(keep).not.toBe(drop);
  expect(set.query(48, -2, -2, 52, 2, 2, scratch)).toBe(1);

  set.remove(drop);
  expect(set.query(48, -2, -2, 52, 2, 2, scratch)).toBe(0);
  expect(set.query(-2, -2, -2, 2, 2, 2, scratch)).toBe(1);
  expect(set.count).toBe(1);
});

/*
 * **The defect this structure can have, and it has no symptom of its own.** A `remove` that misses
 * a bucket entry leaves the slot marked dead — so the fingerprint skips it and is right, and
 * nothing walks it by index — while the stale entry still names it. `query` returns it and the
 * sweep reads its stale bounds and collides with geometry that is gone. Nothing about frame time,
 * a query-cost ratio or a hash can see that, so it is asserted structurally.
 */
test('no bucket holds a dead slot, over a hundred cycles of add and remove', () => {
  const set = new ColliderSet([]);
  const groups: number[] = [];
  for (let i = 0; i < 100; i++) {
    groups.push(
      set.add([aabbFromCenter(i * 7, 0, 0, 3, 3, 3), aabbFromCenter(i * 7, 0, 40, 0.5, 20, 0.5)]),
    );
    if (i >= 3) set.remove(groups[i - 3] as number);
  }
  expect(set.auditCells()).toBe(0);
});

test('a long collider spanning many cells leaves none of them behind', () => {
  const set = new ColliderSet([], 4);
  const group = set.add([aabbFromCenter(0, 0, 0, 100, 1, 1)]);
  set.remove(group);
  expect(set.auditCells()).toBe(0);
  expect(set.query(-100, -2, -2, 100, 2, 2, scratch)).toBe(0);
});

test('a slot freed by remove is reused by the next add', () => {
  const set = new ColliderSet([]);
  const first = set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  const grown = set.capacity;
  set.remove(first);
  set.add([aabbFromCenter(50, 0, 0, 1, 1, 1)]);
  expect(set.capacity).toBe(grown);
  expect(set.count).toBe(1);
});

test('removing a group twice throws instead of quietly doing nothing', () => {
  const set = new ColliderSet([]);
  const group = set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  set.remove(group);
  expect(() => set.remove(group)).toThrow();
});

/* A recycled slot must not inherit the stamp of the collider that used to be there: it would be
   skipped on the very query that recycled it, which is the under-report direction. */
test('a recycled slot is reported by the query after it is recycled', () => {
  const set = new ColliderSet([], 4);
  const first = set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  set.query(-2, -2, -2, 2, 2, 2, scratch);
  set.remove(first);
  set.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  expect(set.query(-2, -2, -2, 2, 2, 2, scratch)).toBe(1);
});

/* The geometry of a dropped region has to become collectable, or a streamer leaks whole worlds. */
test('a dropped group releases its shapes', () => {
  const set = new ColliderSet([]);
  const group = set.add([boxCollider(0, 0, 0, 1, 1, 1)]);
  expect(set.shapeAt(0)).toBeDefined();
  set.remove(group);
  expect(set.shapeAt(0)).toBeUndefined();
});

/*
 * A streaming budget's question is "does the resident ring fit on a phone", and a consumer can
 * count its own bytes and not the engine's. These four numbers are that answer.
 */
test('the slot cost is exact, and it is what was allocated and not what is used', () => {
  const built = new ColliderSet([
    aabbFromCenter(0, 0, 0, 1, 1, 1),
    aabbFromCenter(9, 0, 0, 1, 1, 1),
  ]);
  /* Six floats of bounds, a stamp and an owner, per slot. A constructor-built set allocates
     exactly what it was handed, so this is `count` slots' worth. */
  expect(built.bytes().slots).toBe(2 * (6 * 4 + 4 + 4));

  /* After a drop the arrays are unchanged: a free list recycles slots and never shrinks. That is
     the honest number for a budget, and it is why this reports allocation and not use. */
  const before = built.bytes().slots;
  const grown = new ColliderSet([]);
  const group = grown.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  const held = grown.bytes().slots;
  grown.remove(group);
  expect(grown.bytes().slots).toBe(held);
  expect(before).toBeGreaterThan(0);
});

test('a shape shared by two colliders is counted once', () => {
  const shape = hullShape([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const one = new ColliderSet([colliderFromShape(shape)]);
  const two = new ColliderSet([colliderFromShape(shape), colliderFromShape(shape)]);
  expect(two.bytes().shapes).toBe(one.bytes().shapes);
  expect(one.bytes().shapes).toBeGreaterThan(0);
});

test('a set of bare boxes carries no shape payload at all', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  expect(set.bytes().shapes).toBe(0);
});

test('the index is not free, and total is the three parts', () => {
  const set = new ColliderSet([aabbFromCenter(0, 0, 0, 100, 1, 1)], 4);
  const b = set.bytes();
  expect(b.index).toBeGreaterThan(0);
  expect(b.total).toBe(b.slots + b.shapes + b.index);
});

/* A dropped region has to stop costing index memory, or the budget this answers is a fiction. */
test('dropping a group gives its index memory back', () => {
  const set = new ColliderSet([], 4);
  const empty = set.bytes().index;
  const group = set.add([aabbFromCenter(0, 0, 0, 100, 1, 1)]);
  expect(set.bytes().index).toBeGreaterThan(empty);
  set.remove(group);
  expect(set.bytes().index).toBe(empty);
});

test('an absorbed set queries identically to a one-shot build of the union', () => {
  const boxes = [
    aabbFromCenter(0, 0, 0, 1, 1, 1),
    aabbFromCenter(30, 0, 0, 1, 1, 1),
    aabbFromCenter(60, 0, 0, 1, 1, 1),
  ] as const;
  const oneShot = new ColliderSet([...boxes]);
  const built = new ColliderSet([boxes[0]]);
  built.absorb(new ColliderSet([boxes[1], boxes[2]]));
  for (const x of [0, 30, 60, 15, 45]) {
    expect(built.query(x - 2, -2, -2, x + 2, 2, 2, scratch)).toBe(
      oneShot.query(x - 2, -2, -2, x + 2, 2, 2, scratch),
    );
  }
  expect(built.count).toBe(3);
});

/*
 * **The subtle one, and it is why `absorb` copies liveness and not just bytes.** The bucket remap
 * is a constant offset, which is only valid while every source slot occupies a destination slot —
 * so a churned source cannot be compacted on the way in. Copying its holes while calling them live
 * would report the bytes of colliders that were deleted, which is resurrected geometry. They come
 * across as holes.
 *
 * Refusing a non-dense source instead would have fired on every streamed set, which is the input
 * this was asked for.
 */
test('a churned source contributes its live colliders and none of its holes', () => {
  const source = new ColliderSet([]);
  const gone = source.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  source.add([aabbFromCenter(30, 0, 0, 1, 1, 1)]);
  source.remove(gone);

  const dest = new ColliderSet([]);
  dest.absorb(source);
  expect(dest.count).toBe(1);
  expect(dest.query(-2, -2, -2, 2, 2, 2, scratch)).toBe(0);
  expect(dest.query(28, -2, -2, 32, 2, 2, scratch)).toBe(1);
  expect(dest.auditCells()).toBe(0);
});

test('the hole a source brought across is filled by the next add', () => {
  const source = new ColliderSet([]);
  const gone = source.add([aabbFromCenter(0, 0, 0, 1, 1, 1)]);
  source.add([aabbFromCenter(30, 0, 0, 1, 1, 1)]);
  source.remove(gone);
  const dest = new ColliderSet([]);
  dest.absorb(source);
  const before = dest.capacity;
  dest.add([aabbFromCenter(90, 0, 0, 1, 1, 1)]);
  expect(dest.capacity).toBe(before);
  expect(dest.count).toBe(2);
});

test('absorbing a set with a different cell size throws instead of rehashing quietly', () => {
  const dest = new ColliderSet([], 4);
  expect(() => dest.absorb(new ColliderSet([], 8))).toThrow(/cell/i);
});

test('an absorbed group can be dropped again, and the source is untouched', () => {
  const source = new ColliderSet([aabbFromCenter(30, 0, 0, 1, 1, 1)]);
  const dest = new ColliderSet([]);
  const group = dest.absorb(source);
  dest.remove(group);
  expect(dest.count).toBe(0);
  expect(dest.auditCells()).toBe(0);
  /* A copy, not a move: a consumer can keep a prototype region and stamp it more than once. */
  expect(source.count).toBe(1);
  expect(source.query(28, -2, -2, 32, 2, 2, scratch)).toBe(1);
});

test('an absorbed collider keeps the shape it really is', () => {
  const dest = new ColliderSet([]);
  dest.absorb(new ColliderSet([boxCollider(0, 0, 0, 1, 1, 1)]));
  expect(dest.shapeAt(0)).toBeDefined();
});

test('a set absorbed twice holds both copies', () => {
  const source = new ColliderSet([aabbFromCenter(30, 0, 0, 1, 1, 1)]);
  const dest = new ColliderSet([]);
  dest.absorb(source);
  dest.absorb(source);
  expect(dest.count).toBe(2);
  expect(dest.query(28, -2, -2, 32, 2, 2, scratch)).toBe(2);
});

/* A joined set answers what checking every box would, which is the contract the hash serves. */
test('absorbing agrees with a brute-force scan over the union', () => {
  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const make = (n: number): ReturnType<typeof aabbFromCenter>[] =>
    Array.from({ length: n }, () =>
      aabbFromCenter(rand() * 200 - 100, rand() * 40 - 20, rand() * 200 - 100, 1.5, 1.5, 1.5),
    );
  const a = make(60);
  const b = make(60);
  const dest = new ColliderSet(a);
  dest.absorb(new ColliderSet(b));
  const all = [...a, ...b];
  for (let q = 0; q < 200; q++) {
    const x = rand() * 220 - 110;
    const y = rand() * 50 - 25;
    const z = rand() * 220 - 110;
    const n = dest.query(x - 4, y - 4, z - 4, x + 4, y + 4, z + 4, scratch);
    const found = new Set(Array.from(scratch.subarray(0, n)));
    let expected = 0;
    for (const box of all) {
      const hit =
        box.maxX >= x - 4 &&
        box.minX <= x + 4 &&
        box.maxY >= y - 4 &&
        box.minY <= y + 4 &&
        box.maxZ >= z - 4 &&
        box.minZ <= z + 4;
      if (hit) expected++;
    }
    let seenLive = 0;
    for (const index of found) if (dest.liveAt(index)) seenLive++;
    expect(seenLive).toBe(found.size);
    expect(n).toBeGreaterThanOrEqual(expected);
  }
});
