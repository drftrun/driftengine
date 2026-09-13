import type { Aabb } from './collide/index.ts';
import type { ConvexShape } from './shape.ts';
import { hullShape, shapeBounds } from './shape.ts';

/**
 * Static world collision in a form that scales: bounds packed into one
 * Float32Array, indexed by a uniform spatial hash so a move query touches a
 * handful of boxes instead of all of them.
 *
 * Built once at world generation; every query afterwards is allocation-free.
 * The hash is an optimisation only — it may over-report a candidate, never
 * under-report one, because a missed box is a box the character falls through.
 *
 * A collider may carry the shape it really is. The bounds then become the
 * broad phase only — what decides whether the shape is worth asking — and the
 * sweep in `collide.ts` resolves against the shape itself, so a banked slab of
 * track is solid exactly where it is drawn and nowhere else. A collider
 * without a shape is its box, exactly as before.
 */
const DEFAULT_CELL_SIZE = 4;
const STRIDE = 6;
/**
 * One slot's packed bounds in bytes, for a reader walking `data` a slot at a time.
 *
 * **The stride is otherwise private and stays that way.** This exists because
 * `fingerprintColliders` has to step slot by slot to skip the dead ones, and a literal 24 over
 * there would be a second place for the packing to be wrong — which is the failure the `bounds`
 * accessor already exists to prevent.
 */
export const STRIDE_BYTES = STRIDE * 4;

/** A world obstacle: its bounds, and optionally the volume it really is. */
export interface Collider extends Aabb {
  /** Points in world space — static shapes are baked, not transformed per query. */
  shape?: ConvexShape | undefined;
}

/** Wrap a world-space shape in the bounds the broad phase needs. */
export function colliderFromShape(shape: ConvexShape): Collider {
  /*
   * **A triangle mesh is refused here rather than bounded.** The collider set feeds the *kinematic*
   * sweep, which tests a fixed list of separating axes and a mesh enumerates none — so a mesh
   * turned into a collider would arrive as its own bounding box, and a hollow level would be a
   * solid brick. A mesh belongs to `PhysicsWorld` as a static body, where `collideMesh` reads its
   * triangles.
   */
  if (shape.triangles !== undefined) {
    throw new Error(
      'colliderFromShape: a triangle mesh is not a kinematic collider. Add it to a PhysicsWorld ' +
        'as a static body instead.',
    );
  }
  const collider: Collider = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, shape };
  shapeBounds(shape, collider);
  return collider;
}

/**
 * The collider of a drawn box, exactly where it is drawn.
 *
 * Same centre and half-extents a mesh builder takes, so a game that draws a
 * box gets its collision from the same numbers — nothing authored twice. The
 * shape routes the touch through the shape sweep, which is what lets a lid sit
 * flush with a walkable surface: the old world-axis path fought a body for the
 * ground it stood on, and lids had to be sunk out of reach to compensate.
 */
export function boxCollider(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): Collider {
  const corners: number[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz));
  }
  return colliderFromShape(hullShape(corners));
}

/**
 * What a collider set costs, in bytes, split so a streaming budget can act on it.
 *
 * A single number would not answer the question a budget asks, which is what to drop.
 */
export interface ColliderBytes {
  /**
   * The packed bounds, the query stamps and the owners. Exact.
   *
   * **What was allocated, not what is used.** The arrays double as they grow and a free list
   * recycles slots without ever shrinking them, so this is the memory actually held — which is
   * what a budget needs and what `count` would misreport.
   */
  readonly slots: number;
  /** The distinct shape payloads reachable from live slots. Exact. */
  readonly shapes: number;
  /** The spatial hash: its buckets and their entries. Part measured, part estimated. */
  readonly index: number;
  /** The three above. */
  readonly total: number;
}

/**
 * What one bucket's array costs beyond its entries, and what one `Map` entry costs.
 *
 * **Estimates, and they are the only estimates in `bytes()`.** A JavaScript engine's array and
 * hash-table headers are not observable from inside it, so the alternative to a named guess is to
 * report a number that silently omits them. The entry and bucket *counts* multiplied by these are
 * exact; these two constants are not. **What would make them wrong** is a different engine or a
 * V8 that changes its element backing store — at which point the shape of the answer still holds
 * and the constant is off by a small factor.
 */
const BUCKET_OVERHEAD_BYTES = 64;
const MAP_ENTRY_BYTES = 32;

export class ColliderSet {
  static readonly MAX_HITS = 512;

  /**
   * The group the constructor's own colliders belong to, which `add` never mints and `remove`
   * refuses.
   *
   * **Reserved because of the slots nothing inserts.** The constructor skips an `undefined` entry
   * without putting it in any cell, and still counts it — so those slots are live and are in no
   * bucket, and a removal that reached one would walk buckets it was never written to. Keeping the
   * constructor's slots in a group nothing can drop puts that case out of reach instead of making
   * it survivable.
   *
   * **A set meant to stream is constructed empty** and takes everything through `add`, which is
   * what the refusal points at when it fires.
   */
  static readonly BASE_GROUP: ColliderGroup = 0;

  /**
   * The packed bounds, six floats a slot.
   *
   * **A reference to this is valid until the next `add`**, which may reallocate. `bounds()` is the
   * reader that survives both that and a change of packing.
   *
   * **Its length is `capacity`, not `count`.** Those are equal on a set that has never had
   * `remove` called on it, which is every set built the old way; after a removal the live slots
   * are sparse and a walk of `0..count` reads the wrong ones. Walk `0..capacity` and skip
   * `!liveAt(i)`.
   */
  data: Float32Array;

  private readonly cellSize: number;
  private readonly cells = new Map<number, number[]>();
  private shapes: (ConvexShape | undefined)[];
  /** Per-query stamp, so a box spanning several cells is reported once. */
  private seen: Int32Array;
  private stamp = 0;

  /** Slots allocated, live or not. */
  private slots: number;
  /** Slots in use. `count` reads this. */
  private live: number;
  /**
   * Who holds each slot: `-1` for a free one, otherwise the group.
   *
   * One array for both liveness and provenance, which is what `bytes`, `liveAt` and the
   * fingerprint each need, at four bytes a slot instead of a flag array beside a group array.
   */
  private owner: Int32Array;
  private readonly freeSlots: number[] = [];
  /**
   * Each group's slots, for the only operation that needs them.
   *
   * **A `Map`, and `remove` is its only reader.** `fingerprint.ts` states the rule this respects:
   * nothing feeding a hash may iterate a `Map` or a `Set`, because insertion order would leak into
   * the answer.
   */
  private readonly groups = new Map<ColliderGroup, number[]>();
  private nextGroup = 1;

  constructor(boxes: readonly Collider[], cellSize = DEFAULT_CELL_SIZE) {
    this.slots = boxes.length;
    this.live = boxes.length;
    this.cellSize = cellSize;
    this.data = new Float32Array(boxes.length * STRIDE);
    this.shapes = new Array<ConvexShape | undefined>(boxes.length);
    this.seen = new Int32Array(boxes.length);
    /*
     * Every slot the constructor allocates is live and belongs to the base group — including the
     * ones the `undefined` check below skips. They are live with zero bounds today, and keeping
     * them so is what makes `fingerprintColliders` produce the byte stream it always has.
     */
    this.owner = new Int32Array(boxes.length).fill(ColliderSet.BASE_GROUP);

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b === undefined) continue;
      const o = i * STRIDE;
      this.data[o] = b.minX;
      this.data[o + 1] = b.minY;
      this.data[o + 2] = b.minZ;
      this.data[o + 3] = b.maxX;
      this.data[o + 4] = b.maxY;
      this.data[o + 5] = b.maxZ;
      this.shapes[i] = b.shape;
      this.insert(i, b);
    }
  }

  /** How many colliders the set holds. */
  get count(): number {
    return this.live;
  }

  /** How many slots are allocated, live or not. The true bound of a walk over `data`. */
  get capacity(): number {
    return this.slots;
  }

  /** Whether slot `index` holds a collider. Every slot of a set that has never had `remove`
   *  called on it does. */
  liveAt(index: number): boolean {
    return this.owner[index] !== -1;
  }

  /**
   * Take a batch of colliders and hand back the handle that drops them again.
   *
   * **The grid is updated for these colliders and for no others**, which is the whole point: a
   * consumer whose world streams was rebuilding a set at every region crossing, at about 2.1 µs a
   * box, and paying a whole frame for it.
   *
   * Slots come off the free list before the arrays grow, so a set that loads a ring of regions
   * around a player settles at the ring's high-water mark instead of climbing with distance
   * travelled. Live indices are untouched by this: a slot already in use stays where it is.
   */
  add(boxes: readonly Collider[]): ColliderGroup {
    const group = this.nextGroup++;
    const slots: number[] = [];
    this.ensureCapacity(this.live + boxes.length);

    for (const b of boxes) {
      if (b === undefined) continue;
      const slot = this.freeSlots.pop() ?? this.slots++;
      /*
       * **A recycled slot starts unmarked, and this is the one line that keeps the hash honest
       * through a reuse.** `query` skips a slot whose stamp is already the current mark; a slot
       * carrying a stamp from an earlier life could be skipped on the query that recycles it, and
       * a skipped box is a box the character falls through — the under-report direction this class
       * forbids. One store, unconditional, because working out whether it is needed costs more
       * than doing it.
       */
      this.seen[slot] = 0;
      const o = slot * STRIDE;
      this.data[o] = b.minX;
      this.data[o + 1] = b.minY;
      this.data[o + 2] = b.minZ;
      this.data[o + 3] = b.maxX;
      this.data[o + 4] = b.maxY;
      this.data[o + 5] = b.maxZ;
      this.shapes[slot] = b.shape;
      this.owner[slot] = group;
      this.insert(slot, b);
      slots.push(slot);
      this.live++;
    }

    this.groups.set(group, slots);
    return group;
  }

  /**
   * Take everything in another set as one group, without hashing any of it again.
   *
   * **Copy and offset instead of recompute.** One `Float32Array.set` moves the packed bounds, the
   * shapes are copied by reference, and each of the source's buckets is appended to this set's
   * with a constant added to every index. Nothing is floored, no shape bounds are recomputed, and
   * the result queries identically to a one-shot build of the union.
   *
   * **It appends past everything and skips the free list**, because a constant offset is what
   * makes the bucket remap a copy: source slot `i` has to land at `base + i` and nothing may
   * disturb that.
   *
   * **Which is exactly why the source's holes come across as holes.** A source that has had
   * `remove` called on it — every streamed set — cannot be compacted on the way in, because
   * skipping its holes would make the offset a function of position. Copying them while calling
   * them live would be worse: those slots carry the bytes of colliders that were deleted, and a
   * set reporting them would have resurrected geometry a consumer believed was gone. So liveness
   * is copied with the bytes, the holes land on this set's free list, and the next `add` fills
   * them. **Requiring a dense source instead** was the other option and was rejected: it would
   * refuse the only input this was asked for.
   *
   * What a churned source does cost is its dead slots as bytes copied and space held until the
   * free list drains them. Bounded, visible in `bytes()`, and not a leak.
   *
   * **A copy and not a move.** The source is unchanged and stays usable, which is what lets a
   * caller keep a prototype region and stamp it more than once.
   *
   * `join(a, b, c)` is this in a loop, which is why there is no second method for it.
   */
  absorb(other: ColliderSet): ColliderGroup {
    if (other.cellSize !== this.cellSize) {
      throw new Error(
        `ColliderSet.absorb: this set hashes on a ${this.cellSize} m grid and that one on ` +
          `${other.cellSize} m. The copy is only valid while both agree which cell a coordinate ` +
          'falls in, and rehashing quietly would turn the cheap path into the expensive one at ' +
          'the moment you most need to know.',
      );
    }

    const group = this.nextGroup++;
    const base = this.slots;
    this.ensureCapacity(base + other.slots);
    this.slots = base + other.slots;

    this.data.set(other.data.subarray(0, other.slots * STRIDE), base * STRIDE);
    /*
     * **The absorbed range starts unmarked.** These slots are past everything handed out, so they
     * are already zero unless a growth reused an array — and `query` skips a slot whose stamp is
     * the current mark, so one arriving marked would be missed on the query that first sees it.
     * Cheaper to fill the range than to reason about which paths can leave a stamp behind.
     */
    this.seen.fill(0, base, base + other.slots);

    const slots: number[] = [];
    for (let i = other.slots - 1; i >= 0; i--) {
      const slot = base + i;
      this.shapes[slot] = other.shapes[i];
      if (other.owner[i] === -1) {
        this.owner[slot] = -1;
        this.freeSlots.push(slot);
        continue;
      }
      this.owner[slot] = group;
      slots.push(slot);
      this.live++;
    }
    /* Recorded ascending, because `drop` walks a group's slots backwards to free them descending
       and the pop is what hands them back in order. */
    slots.reverse();

    /*
     * The source's buckets hold only live indices — `remove` unhooked the rest — so every remapped
     * index names a live slot and the offset needs no filtering.
     */
    for (const [key, bucket] of other.cells) {
      const mine = this.cells.get(key);
      if (mine === undefined)
        this.cells.set(
          key,
          bucket.map((index) => index + base),
        );
      else for (const index of bucket) mine.push(index + base);
    }

    this.groups.set(group, slots);
    return group;
  }

  /**
   * Drop a group and everything in it.
   *
   * Refuses the base group and a group it does not hold; a streamer double-freeing a region is a
   * bug, and a silent no-op hides it until the memory it was meant to release turns up in a
   * budget.
   */
  remove(group: ColliderGroup): void {
    if (group === ColliderSet.BASE_GROUP) {
      throw new Error(
        "ColliderSet.remove: the constructor's own colliders cannot be dropped. A set meant to " +
          'stream is constructed empty and takes everything through `add`.',
      );
    }
    const slots = this.groups.get(group);
    if (slots === undefined) {
      throw new Error(
        `ColliderSet.remove: no group ${group} here. It was never added, or it was already ` +
          'removed — either way something is keeping a handle it should not.',
      );
    }
    this.drop(slots);
    this.groups.delete(group);
  }

  /** The volume collider `index` really is, or undefined where it is its box. */
  shapeAt(index: number): ConvexShape | undefined {
    return this.shapes[index];
  }

  /**
   * The packed bounds of collider `index`, written into `out`. Allocation-free.
   *
   * `data` is public and the stride is not. A reader outside this file that decodes
   * `data[i * 6 + 1]` by hand keeps working right up until the packing changes, and
   * then reports confident nonsense rather than failing.
   */
  bounds(index: number, out: Aabb): void {
    const o = index * STRIDE;
    out.minX = this.data[o] as number;
    out.minY = this.data[o + 1] as number;
    out.minZ = this.data[o + 2] as number;
    out.maxX = this.data[o + 3] as number;
    out.maxY = this.data[o + 4] as number;
    out.maxZ = this.data[o + 5] as number;
  }

  query(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Int32Array,
  ): number {
    const s = this.cellSize;
    const x0 = Math.floor(minX / s);
    const x1 = Math.floor(maxX / s);
    const y0 = Math.floor(minY / s);
    const y1 = Math.floor(maxY / s);
    const z0 = Math.floor(minZ / s);
    const z1 = Math.floor(maxZ / s);

    /*
     * **The stamp outlives a rebuild now, so it can reach the end of its range.** A set used to be
     * rebuilt every few seconds and got a fresh stamp with it; one mutable set lives a whole
     * session. `stampAfter` answers 0 when the next mark would truncate negative in `seen`, at
     * which point the array is cleared and marking starts again at 1 — never at 0, because `add`
     * writes `seen[slot] = 0` on a recycled slot and a 0 mark would skip it.
     */
    let mark = stampAfter(this.stamp);
    if (mark === 0) {
      this.seen.fill(0);
      mark = 1;
    }
    this.stamp = mark;
    let found = 0;

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const bucket = this.cells.get(hash(x, y, z));
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k++) {
            const index = bucket[k];
            if (index === undefined || this.seen[index] === mark) continue;
            this.seen[index] = mark;
            if (found < out.length) out[found++] = index;
          }
        }
      }
    }
    return found;
  }

  /**
   * What this set costs in memory.
   *
   * **Because a consumer can count its own bytes and cannot see the engine's**, which makes a
   * streaming budget half-measurable: the question "does the ring of regions around the player fit
   * on a phone" has no answer without this.
   *
   * O(n) over slots and over the index, and it allocates a `Set` to count each distinct shape
   * once. Not a per-frame call.
   */
  bytes(): ColliderBytes {
    const slots = this.data.byteLength + this.seen.byteLength + this.owner.byteLength;

    /*
     * **Each distinct shape once.** A streamer that shares one shape across a hundred colliders
     * wants the truth and not a hundred copies of it. Identity is the object, which is exactly how
     * the colliders share it.
     *
     * A shape's `triangles` is not summed because a collider cannot carry a mesh: `colliderFromShape`
     * refuses one, and a mesh belongs to `PhysicsWorld` as a static body.
     */
    const counted = new Set<ConvexShape>();
    let shapes = 0;
    for (let slot = 0; slot < this.slots; slot++) {
      const shape = this.shapes[slot];
      if (shape === undefined || counted.has(shape)) continue;
      counted.add(shape);
      shapes +=
        shape.vertices.byteLength +
        shape.faceNormals.byteLength +
        shape.edgeDirs.byteLength +
        shape.facePlanes.byteLength +
        shape.faceVertexStart.byteLength +
        shape.faceVertexIndices.byteLength;
    }

    /* Buckets and entries are counted exactly; the two constants above are the estimate, and the
       comment on them says which half is which. */
    let buckets = 0;
    let entries = 0;
    for (const bucket of this.cells.values()) {
      buckets++;
      entries += bucket.length;
    }
    const index = buckets * (BUCKET_OVERHEAD_BYTES + MAP_ENTRY_BYTES) + entries * 8;

    return { slots, shapes, index, total: slots + shapes + index };
  }

  /**
   * How many bucket entries name a slot nothing holds. Always zero.
   *
   * **The one defect in this structure that has no symptom of its own**, which is why it gets a
   * check of its own. A `remove` that misses a bucket entry leaves the slot marked dead — so the
   * fingerprint skips it and is right, and nothing walks it by index — while the stale entry goes
   * on naming it: `query` returns it, and the sweep reads its stale bounds and collides with
   * geometry that is gone. No measurement of frame time, query cost or hash can see that.
   *
   * O(total entries) and not something to call in a frame. For tests and for the streaming check.
   */
  auditCells(): number {
    let dead = 0;
    for (const bucket of this.cells.values()) {
      for (const index of bucket) if (this.owner[index] === -1) dead++;
    }
    return dead;
  }

  /**
   * Unhook slots from every cell they occupy, then free them.
   *
   * **The same triple loop `insert` uses**, so the two cannot disagree about which cells a box
   * occupies — which is the disagreement that would leave an entry behind. A bucket entry goes by
   * swapping the last one into its place and popping, because bucket order carries no meaning, and
   * an emptied bucket leaves `cells` so a dropped region costs a `Map.get` that misses instead of
   * a scan.
   *
   * **Slots are freed in descending order** so the last-in-first-out pop hands them back
   * ascending: a region added after another is dropped then lands on a contiguous run of that
   * region's slots. Incidental locality and not a guarantee — see the compaction note in the
   * design if a churned set's query cost ever drifts.
   */
  private drop(slots: readonly number[]): void {
    const s = this.cellSize;
    for (let k = slots.length - 1; k >= 0; k--) {
      const slot = slots[k] as number;
      const o = slot * STRIDE;
      const minX = this.data[o] as number;
      const minY = this.data[o + 1] as number;
      const minZ = this.data[o + 2] as number;
      const maxX = this.data[o + 3] as number;
      const maxY = this.data[o + 4] as number;
      const maxZ = this.data[o + 5] as number;

      for (let x = Math.floor(minX / s); x <= Math.floor(maxX / s); x++) {
        for (let y = Math.floor(minY / s); y <= Math.floor(maxY / s); y++) {
          for (let z = Math.floor(minZ / s); z <= Math.floor(maxZ / s); z++) {
            const key = hash(x, y, z);
            const bucket = this.cells.get(key);
            if (bucket === undefined) continue;
            const at = bucket.indexOf(slot);
            if (at === -1) continue;
            const last = bucket.pop() as number;
            if (at < bucket.length) bucket[at] = last;
            if (bucket.length === 0) this.cells.delete(key);
          }
        }
      }

      this.owner[slot] = -1;
      /* So a dropped region's geometry can be collected. A streamer that held these would keep
         every world it had ever driven through. */
      this.shapes[slot] = undefined;
      this.freeSlots.push(slot);
      this.live--;
    }
  }

  /**
   * Room for `n` slots, growing by doubling.
   *
   * **The shape is `island.ts`'s `ensureBodies`, with one difference worth naming**: that one
   * allocates and discards, because it rebuilds its arrays from scratch every tick, and these
   * carry a world that has to survive the growth. So they copy.
   *
   * A grown `seen` is zero-filled by the allocation, which is the same thing `add` writes on a
   * recycled slot and for the same reason.
   */
  private ensureCapacity(n: number): void {
    if (n <= this.owner.length) return;
    let size = this.owner.length || 1;
    while (size < n) size *= 2;

    const data = new Float32Array(size * STRIDE);
    data.set(this.data);
    this.data = data;

    const seen = new Int32Array(size);
    seen.set(this.seen);
    this.seen = seen;

    const owner = new Int32Array(size).fill(-1);
    owner.set(this.owner);
    this.owner = owner;

    this.shapes.length = size;
  }

  private insert(index: number, b: Aabb): void {
    const s = this.cellSize;
    for (let x = Math.floor(b.minX / s); x <= Math.floor(b.maxX / s); x++) {
      for (let y = Math.floor(b.minY / s); y <= Math.floor(b.maxY / s); y++) {
        for (let z = Math.floor(b.minZ / s); z <= Math.floor(b.maxZ / s); z++) {
          const key = hash(x, y, z);
          const bucket = this.cells.get(key);
          if (bucket === undefined) this.cells.set(key, [index]);
          else bucket.push(index);
        }
      }
    }
  }
}

/**
 * A handle to one batch of colliders, so a region can be dropped without naming its members.
 *
 * Opaque on purpose: it is an integer today and the only thing a caller may do with it is hand it
 * back.
 */
export type ColliderGroup = number;

/**
 * The stamp a query marks with next, or 0 meaning `seen` has to be cleared first.
 *
 * **Its own function because it cannot be reached by driving `query`.** The condition needs 2^31
 * queries, which no test will do, so the decision is asserted where it is made rather than through
 * the behaviour it protects.
 */
export function stampAfter(previous: number): number {
  return previous >= 0x7fffffff ? 0 : previous + 1;
}

/** Cheap 3D integer hash. A collision only costs an extra bounds test. */
function hash(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
}
