/**
 * Iterating the entities that have a set of components, without allocating.
 *
 * **An iterator allocated per frame is the per-frame allocation `AGENTS.md` forbids**, arriving
 * through the most-used call in the package. So a cursor is its own iterator, returns a **reused**
 * result record, and comes from a pool the world owns — the same shape the render graph's arena
 * uses, and for the same reason.
 *
 * The cost is that **a query result may not outlive the loop it was made in**. A caller that stores
 * one gets whatever the next query writes into it. That is stated here rather than discovered, and
 * it is the bargain the arena makes too.
 *
 * ---
 *
 * ## The walk is over the smallest set
 *
 * A query over three components walks one dense array and tests membership in the other two, so the
 * work is bounded by the *smallest* of them. Walking the first named instead would make
 * `query(Position, Dying)` cost the whole world when two entities are dying.
 *
 * **The order is not sorted and is not promised.** It follows the chosen dense array, whose order is
 * insertion modified by swap-removal — deterministic given the same history, which is what a replay
 * needs, and not a stable property of the set. A consumer needing a stable order sorts by entity,
 * and the fact that it is a choice is why this says so.
 */
import type { Entity } from './entity.ts';
import type { ComponentStore, ComponentType } from './store.ts';

/**
 * What a cursor needs from the world it belongs to.
 *
 * An interface rather than the `World` class, because a cursor importing the world and the world
 * importing the cursor is a cycle — and because what a cursor actually needs is two functions.
 */
export interface CursorHost {
  store(type: ComponentType): ComponentStore;
  releaseCursor(cursor: QueryCursor): void;
}

/** What `next` hands back. One object, rewritten — see the header. */
interface Step {
  value: Entity;
  done: boolean;
}

export class QueryCursor implements Iterator<Entity>, Iterable<Entity> {
  /**
   * Stores every yielded entity must be in, including the one being walked.
   *
   * **Reused with a count rather than emptied**, and that is not a micro-optimisation. Setting
   * `length = 0` and pushing again makes V8 re-grow the backing store, which allocates — measured:
   * half a million `length = 0` and two pushes collected as often as a control allocating two
   * objects per iteration, while writing in place collected nothing. The whole point of a pooled
   * cursor is undone by emptying its arrays.
   */
  private readonly required: ComponentStore[] = [];
  private requiredCount = 0;
  /** Stores no yielded entity may be in. Same arrangement, same reason. */
  private readonly excluded: ComponentStore[] = [];
  private excludedCount = 0;
  private walking: ComponentStore | null = null;
  private at = 0;
  private readonly step: Step = { value: 0, done: false };
  private host: CursorHost | null = null;
  private open_ = false;

  constructor(host: CursorHost) {
    this.host = host;
    this.owner = host;
  }

  private readonly owner: CursorHost;

  /**
   * Configure and take ownership.
   *
   * **Four component types rather than a rest parameter**, because `...types` allocates an array on
   * every call — once per system per frame, which is exactly the hot path this file exists for.
   * Four covers every query in the corpus; a fifth is `.with()`, which is one more call and no
   * array either.
   */
  open(a: ComponentType, b?: ComponentType, c?: ComponentType, d?: ComponentType): this {
    this.requiredCount = 0;
    this.excludedCount = 0;
    this.require(a);
    if (b !== undefined) this.require(b);
    if (c !== undefined) this.require(c);
    if (d !== undefined) this.require(d);
    this.walking = null;
    this.at = 0;
    this.host = this.owner;
    this.open_ = true;
    return this;
  }

  /** Require a component without yielding anything about it. */
  with(type: ComponentType): this {
    this.require(type);
    return this;
  }

  /** Exclude everything that has this component. */
  without(type: ComponentType): this {
    const store = this.owner.store(type);
    if (this.excludedCount < this.excluded.length) this.excluded[this.excludedCount] = store;
    else this.excluded.push(store);
    this.excludedCount += 1;
    return this;
  }

  private require(type: ComponentType): void {
    const store = this.owner.store(type);
    /* Written in place where the slot exists; pushed only the first time the cursor is asked for a
       query this wide, so a pool of cursors settles at the widest query a consumer makes. */
    if (this.requiredCount < this.required.length) this.required[this.requiredCount] = store;
    else this.required.push(store);
    this.requiredCount += 1;
  }

  [Symbol.iterator](): Iterator<Entity> {
    /*
     * The cursor is its own iterator. Returning a fresh object here would allocate one per loop,
     * which is the whole thing this file exists to avoid — and it is what makes `for…of` over a
     * cursor twice at once wrong, which the pool is what stops.
     */
    return this;
  }

  next(): IteratorResult<Entity> {
    if (!this.open_) return this.step.done ? this.step : this.finish();
    if (this.walking === null) this.chooseSmallest();
    const walking = this.walking;
    if (walking === null) return this.finish();

    const dense = walking.dense;
    for (; this.at < walking.size; this.at += 1) {
      const entity = dense[this.at] as Entity;
      if (!this.matches(entity, walking)) continue;
      this.at += 1;
      this.step.value = entity;
      this.step.done = false;
      return this.step;
    }
    return this.finish();
  }

  /** Called by `for…of` when a loop breaks, which is what stops an abandoned cursor leaking. */
  return(): IteratorResult<Entity> {
    return this.finish();
  }

  private matches(entity: Entity, walking: ComponentStore): boolean {
    for (let i = 0; i < this.requiredCount; i += 1) {
      const store = this.required[i] as ComponentStore;
      if (store !== walking && !store.has(entity)) return false;
    }
    for (let i = 0; i < this.excludedCount; i += 1) {
      if ((this.excluded[i] as ComponentStore).has(entity)) return false;
    }
    return true;
  }

  private chooseSmallest(): void {
    let smallest: ComponentStore | null = null;
    for (let i = 0; i < this.requiredCount; i += 1) {
      const store = this.required[i] as ComponentStore;
      if (smallest === null || store.size < smallest.size) smallest = store;
    }
    this.walking = smallest;
  }

  private finish(): IteratorResult<Entity> {
    this.walking = null;
    if (this.open_) {
      this.open_ = false;
      /* Through the host rather than a closure handed in at `open`: a closure per query is an
         allocation per system per frame, which is the thing this file refuses. */
      this.owner.releaseCursor(this);
    }
    this.step.value = 0;
    this.step.done = true;
    return this.step;
  }
}
