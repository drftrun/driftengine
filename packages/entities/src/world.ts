/**
 * A world: the entities, the stores keyed by component type, and the cursor pool.
 *
 * **What a world adds over a bag of stores is that an entity which is gone is gone from all of
 * them.** Without that, destroying something leaves its components behind, a query goes on yielding
 * it, and a scene serialises a handle nothing can reach — three symptoms of one missing sweep.
 */
import {
  type AllocatorSnapshot,
  type Entity,
  EntityAllocator,
  type EntityAllocatorOptions,
  createAllocatorSnapshot,
} from './entity.ts';
import { type CursorHost, QueryCursor } from './query.ts';
import {
  ComponentStore,
  type ComponentType,
  type StoreSnapshot,
  createStoreSnapshot,
} from './store.ts';
import type { ComponentView } from './view.ts';

/**
 * A world's whole state at one instant, for a rewind. **Not a save file**, and the two are not
 * interchangeable.
 *
 * `serializeWorld` in `scene.ts` writes a scene: it carries every component's schema so a load can
 * migrate across a change, keys values by stable field id so a renamed field still loads, and
 * *creates* entities so a scene can be loaded into a world that already holds things. Every one of
 * those properties is wrong here. A rewind needs the handles it had — an input recorded for entity
 * 4,194,307 means nothing if the restore hands that slot a new generation — and it needs to cost
 * nothing per tick, which rules out an object per component per entity.
 *
 * | | `SerializedScene` | `WorldSnapshot` |
 * |---|---|---|
 * | Keyed by | stable field id | column position |
 * | Handles | remapped, all of them change | preserved, generations included |
 * | On load | creates, appending | overwrites in place |
 * | Migration | yes | no |
 * | Allocates | per entity, per component | nothing after the first save |
 * | Goes on a wire | yes | never |
 *
 * **A rewind covers every store the world holds, and takes no list of types.** That is the other
 * half of the difference: `serializeWorld` is handed the types because a scene is a decision about
 * what to save, and a rewind is not a decision at all. A component type left out of a restore is
 * state that survived the rewind, which is the definition of a desync.
 */
export interface WorldSnapshot {
  readonly allocator: AllocatorSnapshot;
  /** By `ComponentType.id`. Holds a slot for every store the world had when this was written. */
  readonly stores: Map<number, StoreSnapshot>;
}

/**
 * An empty slot, to be filled by `World.saveInto` and reused for the life of a rewind ring.
 *
 * Its arrays are zero-length and grow to the world's shape on the first save, so a ring of eight
 * costs eight small objects up front and allocates nothing on the ticks that matter.
 */
export function createWorldSnapshot(): WorldSnapshot {
  return { allocator: createAllocatorSnapshot(), stores: new Map() };
}

export class World implements CursorHost {
  private readonly entities: EntityAllocator;
  private readonly stores = new Map<number, ComponentStore>();
  /**
   * Cursors not currently in a loop.
   *
   * A pool rather than a fresh cursor, because a query runs per frame per system and an object per
   * query is the allocation this whole design refuses. It grows to the deepest nesting a consumer
   * reaches and never shrinks, which for any real workload is a handful.
   */
  private readonly idle: QueryCursor[] = [];
  private inUse = 0;

  constructor(options: EntityAllocatorOptions = {}) {
    this.entities = new EntityAllocator(options);
  }

  get liveCount(): number {
    return this.entities.liveCount;
  }

  /** How many cursors are inside a loop. For a consumer looking at a leak rather than inferring one. */
  get cursorsInUse(): number {
    return this.inUse;
  }

  create(): Entity {
    return this.entities.create();
  }

  alive(entity: Entity): boolean {
    return this.entities.alive(entity);
  }

  /**
   * Destroy an entity and sweep it out of every store.
   *
   * Every store, not the ones it is known to be in: a world keeps no per-entity list of its
   * components, because that list is a second description of what the stores already know and it
   * would be the thing that goes stale. The sweep is one `remove` per registered type, which is a
   * number of component *types* rather than of entities.
   */
  destroy(entity: Entity): boolean {
    if (!this.entities.alive(entity)) return false;
    for (const store of this.stores.values()) store.remove(entity);
    return this.entities.destroy(entity);
  }

  /** The store for a component type, made on first ask. */
  store(type: ComponentType): ComponentStore {
    const existing = this.stores.get(type.id);
    if (existing !== undefined) return existing;
    const made = new ComponentStore(type);
    this.stores.set(type.id, made);
    return made;
  }

  /**
   * The live columns of a component, for a caller indexing them directly.
   *
   * **Unenforced, and that is not an oversight**: a world outside a system has no declarations to
   * enforce against. Inside one, go through `SystemView.view`, which checks first — see the note
   * there for what happens if anything routes around it.
   */
  view(type: ComponentType): ComponentView {
    return this.store(type).view();
  }

  add(entity: Entity, type: ComponentType, values: Readonly<Record<string, unknown>> = {}): void {
    if (!this.entities.alive(entity)) {
      throw new Error(
        `entity ${entity} is not alive, so \`${type.name}\` has nowhere to go. Storing it anyway ` +
          'would leave a component keyed to a handle nothing can reach, which a query would skip ' +
          'and a scene would serialise.',
      );
    }
    this.store(type).add(entity, values);
  }

  remove(entity: Entity, type: ComponentType): boolean {
    return this.store(type).remove(entity);
  }

  has(entity: Entity, type: ComponentType): boolean {
    return this.store(type).has(entity);
  }

  read(entity: Entity, type: ComponentType, field: string): unknown {
    return this.store(type).read(entity, field);
  }

  write(entity: Entity, type: ComponentType, field: string, value: unknown): void {
    this.store(type).write(entity, field, value);
  }

  /**
   * Everything that has all of these components.
   *
   * The cursor is borrowed and is given back when the loop ends — including when it `break`s, which
   * `for…of` reports through the iterator's `return`. A caller that keeps the result past its loop
   * gets whatever the next query writes into it; see `query.ts`.
   */
  query(a: ComponentType, b?: ComponentType, c?: ComponentType, d?: ComponentType): QueryCursor {
    const cursor = this.idle.pop() ?? new QueryCursor(this);
    this.inUse += 1;
    return cursor.open(a, b, c, d);
  }

  /** Called by a cursor when its loop ends, including when the loop breaks. Not for a consumer. */
  releaseCursor(cursor: QueryCursor): void {
    this.inUse -= 1;
    this.idle.push(cursor);
  }

  /**
   * Write this world's whole state into a slot. See `WorldSnapshot` for why this is not a save.
   *
   * **Every store, and the slot keeps one for each.** A store is never removed from a world, so a
   * later restore always finds the stores this save described still present — which is why nothing
   * here has to record a component *type*, only its id.
   */
  saveInto(slot: WorldSnapshot): void {
    this.entities.saveInto(slot.allocator);
    for (const [id, store] of this.stores) {
      let into = slot.stores.get(id);
      if (into === undefined) {
        into = createStoreSnapshot();
        slot.stores.set(id, into);
      }
      store.saveInto(into);
    }
  }

  /**
   * Put this world back to a saved slot.
   *
   * **A store the slot does not mention is emptied rather than skipped.** Such a store was created
   * after the save — by a query, or by something adding a component the world had never seen — and
   * leaving its contents alone would leave components attached to entities the restored allocator
   * says do not exist. Emptying it is what the snapshot actually claims.
   *
   * The cursor pool is untouched: a borrowed cursor belongs to a loop that is running, and a
   * rewind happens between ticks.
   */
  loadFrom(slot: WorldSnapshot): void {
    this.entities.loadFrom(slot.allocator);
    for (const [id, store] of this.stores) {
      store.loadFrom(slot.stores.get(id) ?? EMPTY_STORE);
    }
  }
}

/**
 * The slot a store restores from when the snapshot never knew about it: count zero.
 *
 * Shared and never written to — `ComponentStore.loadFrom` only reads its slot — so this costs one
 * object for the process instead of one per rewind.
 */
const EMPTY_STORE: StoreSnapshot = createStoreSnapshot();
