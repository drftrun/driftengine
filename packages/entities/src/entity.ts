/**
 * What an entity *is*, and the allocator that hands them out.
 *
 * An entity is a handle and nothing else — no object, no class, no fields. What it *has* lives in
 * component stores keyed by it, which is the whole arrangement, and it is why an entity can be a
 * number in a typed array rather than something a frame has to chase a pointer to.
 *
 * ---
 *
 * ## The generation, and why it may not wrap
 *
 * **An index freed and reused makes every old reference to it silently valid** — pointing at a
 * different thing, of a different kind, with no error anywhere. That is the failure the generation
 * exists to prevent, so the only question worth deciding is how long before it wraps and brings the
 * failure back.
 *
 * The conventional answer is a packed 32-bit handle, twenty-four bits of index and eight of
 * generation. It makes a slot's 257th reuse hand back a handle **identical** to its first. Here the
 * split is 26 and 27, combined arithmetically rather than by shifting, because a shift is 32-bit in
 * JavaScript and a double is exact to 53: sixty-seven million entities, and 134 million reuses of
 * each slot before a repeat.
 *
 * **26 + 27 is the whole 53-bit budget, with nothing spare**, so the largest handle is
 * `Number.MAX_SAFE_INTEGER` itself. A third field in a handle, or one more bit of either, stops the
 * arithmetic being exact — and the failure then is a handle that compares equal to a different one,
 * which is the same hole the generation was added to close. A test asserts the top handle rather
 * than leaving that to be discovered.
 *
 * **The cost is that a handle is eight bytes rather than four**, because it lives in a
 * `Float64Array` and not a `Uint32Array`. That is paid on entity *lists* rather than on component
 * data, which is where the bytes actually are.
 *
 * **What would make this wrong** is a consumer with more than 67 million live entities, at which
 * point the split moves and every stored scene has to be rewritten — which is why the two numbers
 * are here, once, and every site goes through `packEntity` rather than writing the arithmetic.
 */

/** One past the highest index a handle can carry: 2^26, or 67,108,864 entities. */
export const ENTITY_INDEX_CEILING = 67_108_864;

/** One past the highest generation: 2^27, or 134,217,728 reuses of one slot. */
export const ENTITY_GENERATION_CEILING = 134_217_728;

/**
 * An entity handle.
 *
 * A plain number so it stores in a typed array and compares with `===`. It is opaque: reading the
 * index or the generation out of one is what `entityIndex` and `entityGeneration` are for, and code
 * that does the arithmetic itself is code that has to be found when the split moves.
 */
export type Entity = number;

export function packEntity(index: number, generation: number): Entity {
  return index + generation * ENTITY_INDEX_CEILING;
}

export function entityIndex(entity: Entity): number {
  return entity % ENTITY_INDEX_CEILING;
}

export function entityGeneration(entity: Entity): number {
  return Math.floor(entity / ENTITY_INDEX_CEILING);
}

/**
 * An allocator's whole position, for a rewind.
 *
 * **Reused between saves rather than made per save.** A rollback loop takes one of these sixty
 * times a second, so the arrays are grown to the allocator's own capacity once and then written
 * over; the fields are mutable for that reason and not because a caller should touch them.
 *
 * The free queue is held as a count and a typed array instead of the `number[]` the allocator
 * keeps, so a save is a memcpy. **Its order is part of the state**, not an incidental detail: the
 * queue is first-in-first-out precisely so slot wear spreads, and restoring the same slots in a
 * different order hands out different handles on the next create.
 */
export interface AllocatorSnapshot {
  generations: Uint32Array;
  live: Uint8Array;
  free: Int32Array;
  freeCount: number;
  highWater: number;
  aliveCount: number;
}

export function createAllocatorSnapshot(): AllocatorSnapshot {
  return {
    generations: new Uint32Array(0),
    live: new Uint8Array(0),
    free: new Int32Array(0),
    freeCount: 0,
    highWater: 0,
    aliveCount: 0,
  };
}

export interface EntityAllocatorOptions {
  /**
   * How many slots this allocator may ever hand out.
   *
   * Present so a test can reach the refusal without allocating sixty-seven million slots. A
   * consumer has no reason to set it, and setting it low does not save memory — the arrays grow on
   * demand either way.
   */
  readonly ceiling?: number;
}

/**
 * Slots, their generations, and a queue of the ones that are free.
 *
 * **The free list is first-in-first-out**, and that is what makes the generation ceiling a number
 * about the pool rather than about one slot. A stack hands the same slot straight back, so one
 * spawn-and-destroy pair in a loop burns that slot's whole range while every other slot sits
 * unused. A queue spreads the wear.
 *
 * The cost is that a freed slot is not reused until every other freed slot has been, so a workload
 * that churns a handful of entities touches more of the arrays than a stack would. That is a cache
 * argument against a correctness one, and correctness wins.
 */
export class EntityAllocator {
  /** Generation per slot. Index `i` holds the generation of whatever lives at index `i` now. */
  private generations: Uint32Array = new Uint32Array(64);
  /** Whether slot `i` is currently handed out. */
  private live: Uint8Array = new Uint8Array(64);
  /** Freed slots, oldest first. A plain array: a queue that grows, drained from the front. */
  private readonly free: number[] = [];
  /** How far into the arrays this allocator has ever reached. */
  private highWater = 0;
  private alive_ = 0;
  private readonly ceiling: number;

  constructor(options: EntityAllocatorOptions = {}) {
    this.ceiling = options.ceiling ?? ENTITY_INDEX_CEILING;
  }

  get liveCount(): number {
    return this.alive_;
  }

  create(): Entity {
    /* `shift` is O(n) on a large array and this is not a per-frame path — an entity is created when
       something enters the world. A ring buffer is the fix if a profile ever says so. */
    const recycled = this.free.shift();
    if (recycled !== undefined) {
      this.live[recycled] = 1;
      this.alive_ += 1;
      return packEntity(recycled, this.generations[recycled] as number);
    }

    if (this.highWater >= this.ceiling) {
      throw new Error(
        `this world has handed out ${this.ceiling} entities, which is its index ceiling. Nothing ` +
          'is wrapped or reused: a handle beyond the ceiling would repeat one that is already ' +
          'live, and answering the wrong entity is worse than refusing.',
      );
    }

    const index = this.highWater;
    this.highWater += 1;
    this.grow(index + 1);
    this.live[index] = 1;
    this.alive_ += 1;
    return packEntity(index, this.generations[index] as number);
  }

  /**
   * Free an entity's slot. `false` when the handle was already stale, which is not an error.
   *
   * A caller destroying something twice is a caller that lost track, and the honest answer is that
   * there was nothing to destroy — the same shape `patchModule` and `Scope.leave` use.
   */
  destroy(entity: Entity): boolean {
    if (!this.alive(entity)) return false;
    const index = entityIndex(entity);
    this.live[index] = 0;
    /*
     * The generation moves on **destroy**, not on the next create, so a handle stops being live the
     * moment it is destroyed rather than the moment somebody happens to take its slot. Moving it
     * later would leave a window in which a destroyed handle still answered `alive`.
     */
    const next = ((this.generations[index] as number) + 1) % ENTITY_GENERATION_CEILING;
    this.generations[index] = next;
    this.free.push(index);
    this.alive_ -= 1;
    return true;
  }

  alive(entity: Entity): boolean {
    const index = entityIndex(entity);
    if (index >= this.highWater) return false;
    return this.live[index] === 1 && this.generations[index] === entityGeneration(entity);
  }

  /**
   * Copy this allocator's position into a slot, growing the slot's arrays if it has not held one
   * this large before.
   *
   * **`highWater` bounds every copy**, because slots beyond it have never been handed out and their
   * generations are zero on both sides. That is what keeps the cost proportional to the world rather
   * than to the arrays' capacity.
   */
  saveInto(slot: AllocatorSnapshot): void {
    const reach = this.highWater;
    if (slot.generations.length < reach) slot.generations = new Uint32Array(reach);
    if (slot.live.length < reach) slot.live = new Uint8Array(reach);
    if (slot.free.length < this.free.length) slot.free = new Int32Array(this.free.length);

    for (let i = 0; i < reach; i++) {
      slot.generations[i] = this.generations[i] as number;
      slot.live[i] = this.live[i] as number;
    }
    for (let i = 0; i < this.free.length; i++) slot.free[i] = this.free[i] as number;

    slot.freeCount = this.free.length;
    slot.highWater = reach;
    slot.aliveCount = this.alive_;
  }

  /**
   * Put this allocator back to a saved position.
   *
   * **Slots between the saved `highWater` and the current one are cleared rather than left**, and
   * that is the whole difference between a restore and a partial one. An entity created after the
   * save has a live slot the save knows nothing about; leaving it live would leave an entity in the
   * world that the snapshot says does not exist, and its handle would keep answering `alive`.
   */
  loadFrom(slot: AllocatorSnapshot): void {
    this.grow(slot.highWater);
    for (let i = 0; i < slot.highWater; i++) {
      this.generations[i] = slot.generations[i] as number;
      this.live[i] = slot.live[i] as number;
    }
    for (let i = slot.highWater; i < this.highWater; i++) {
      this.generations[i] = 0;
      this.live[i] = 0;
    }

    this.free.length = 0;
    for (let i = 0; i < slot.freeCount; i++) this.free.push(slot.free[i] as number);

    this.highWater = slot.highWater;
    this.alive_ = slot.aliveCount;
  }

  private grow(needed: number): void {
    if (needed <= this.generations.length) return;
    let size = this.generations.length;
    while (size < needed) size *= 2;
    const generations = new Uint32Array(size);
    generations.set(this.generations);
    this.generations = generations;
    const live = new Uint8Array(size);
    live.set(this.live);
    this.live = live;
  }
}
