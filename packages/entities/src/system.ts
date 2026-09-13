/**
 * A system, and the view that holds it to what it declared.
 *
 * **The declaration earns its place by being enforced, not by being documentation.** A system that
 * writes a component it did not declare is refused naming both, because the whole value of the
 * declaration is what can be derived from it — parallel grouping, ordering, profiling — and
 * anything derived from a lie is worse than nothing derived at all.
 *
 * `writes` implies `reads`. A system that can write a component and not read it can only overwrite
 * it, which nothing wants, and making every author write both would be a rule that is obeyed by
 * copying.
 *
 * ---
 *
 * ## Structural change, and the one that is deferred
 *
 * `create` and `add` happen immediately. Neither can corrupt a walk in progress: a handle comes
 * from the allocator and touches no store, and appending to a dense array only grows it. **A newly
 * added entity may be visited in the same pass** if the query is walking the store it was added to,
 * which is surprising and is stated rather than prevented — preventing it means snapshotting the
 * size at the start of the walk, and a system that spawns and expects to see its own spawn is as
 * likely as one that does not.
 *
 * **`destroy` and `remove` are deferred**, and that is not symmetry for its own sake. A removal
 * swaps the last dense entry into the hole, so removing mid-walk moves an entity the cursor has
 * already passed into a position it has already visited — and that entity is **never seen**,
 * silently, and only whichever one happened to be last. Deferring is the smallest fix that is
 * correct; the alternative is a tombstone per entry and a compaction pass, which costs every read.
 */
import type { Entity } from './entity.ts';
import type { QueryCursor } from './query.ts';
import type { ComponentType } from './store.ts';
import type { ComponentView } from './view.ts';
import type { World } from './world.ts';

export interface SystemView {
  query(a: ComponentType, b?: ComponentType, c?: ComponentType, d?: ComponentType): QueryCursor;
  /**
   * The live columns of a component, checked against this system's declarations first.
   *
   * `forWriting` decides which check: a caller that will only read takes a readable view, and one
   * that will write takes a writable one. A compiler that can see the body supplies it; a caller
   * writing this by hand says what it is about to do.
   */
  view(type: ComponentType, forWriting: boolean): ComponentView;
  read(entity: Entity, type: ComponentType, field: string): unknown;
  write(entity: Entity, type: ComponentType, field: string, value: unknown): void;
  has(entity: Entity, type: ComponentType): boolean;
  create(): Entity;
  add(entity: Entity, type: ComponentType, values?: Readonly<Record<string, unknown>>): void;
  /** Deferred to after this system runs. See the header. */
  destroy(entity: Entity): void;
  /** Deferred to after this system runs. See the header. */
  remove(entity: Entity, type: ComponentType): void;
}

export interface SystemDefinition {
  readonly name: string;
  readonly reads?: readonly ComponentType[];
  readonly writes?: readonly ComponentType[];
  /**
   * Run once every this many fixed steps. Absent means every step.
   *
   * **A stride and never a rate in seconds.** A rate in wall-clock time leaves the determinism
   * contract on its first dropped frame: two runs of the same recording would run the system a
   * different number of times. A tick count is the same in every replay of the same input.
   */
  readonly everyTicks?: number;
  /** Systems this one must run after, by name. A cycle here is refused at build. */
  readonly after?: readonly string[];
  run(view: SystemView): void;
}

/**
 * The view one system sees, reused across ticks.
 *
 * One per system rather than one per run, because a system runs every tick for the life of a world
 * and an object per tick per system is the allocation this package refuses everywhere else.
 */
export class BoundSystem implements SystemView {
  readonly definition: SystemDefinition;
  private readonly world: World;
  private readonly readable = new Set<number>();
  private readonly writable = new Set<number>();
  /** Entities to destroy after this system returns. Reused, drained with a count. */
  private readonly pendingDestroy: Entity[] = [];
  private destroyCount = 0;
  private readonly pendingRemoveEntity: Entity[] = [];
  private readonly pendingRemoveType: ComponentType[] = [];
  private removeCount = 0;

  constructor(world: World, definition: SystemDefinition) {
    this.world = world;
    this.definition = definition;
    for (const type of definition.writes ?? []) {
      this.writable.add(type.id);
      /* `writes` implies `reads` — see the header. */
      this.readable.add(type.id);
    }
    for (const type of definition.reads ?? []) this.readable.add(type.id);
  }

  run(): void {
    this.definition.run(this);
    this.drain();
  }

  query(a: ComponentType, b?: ComponentType, c?: ComponentType, d?: ComponentType): QueryCursor {
    this.requireReadable(a);
    if (b !== undefined) this.requireReadable(b);
    if (c !== undefined) this.requireReadable(c);
    if (d !== undefined) this.requireReadable(d);
    return this.world.query(a, b, c, d);
  }

  /**
   * The live columns of a component, checked first.
   *
   * **This is the seam where one mistake disables every declaration in this file.** Every other
   * accessor here checks before it answers, and a view that went straight to the store would hand
   * out the raw columns of a component this system never declared — after which `reads` and
   * `writes` are reachable *around* rather than through, and nothing in the schedule derived from
   * them means anything.
   *
   * **What this costs** is that a caller must say in advance whether it will write, before it has
   * written anything. **What would make it wrong** is a view narrow enough to enforce per field,
   * which would be a second object per field and the allocation this package refuses.
   */
  view(type: ComponentType, forWriting: boolean): ComponentView {
    if (forWriting) this.requireWritable(type);
    else this.requireReadable(type);
    return this.world.view(type);
  }

  read(entity: Entity, type: ComponentType, field: string): unknown {
    this.requireReadable(type);
    return this.world.read(entity, type, field);
  }

  write(entity: Entity, type: ComponentType, field: string, value: unknown): void {
    this.requireWritable(type);
    this.world.write(entity, type, field, value);
  }

  has(entity: Entity, type: ComponentType): boolean {
    this.requireReadable(type);
    return this.world.has(entity, type);
  }

  create(): Entity {
    return this.world.create();
  }

  add(entity: Entity, type: ComponentType, values: Readonly<Record<string, unknown>> = {}): void {
    this.requireWritable(type);
    this.world.add(entity, type, values);
  }

  destroy(entity: Entity): void {
    if (this.destroyCount < this.pendingDestroy.length)
      this.pendingDestroy[this.destroyCount] = entity;
    else this.pendingDestroy.push(entity);
    this.destroyCount += 1;
  }

  remove(entity: Entity, type: ComponentType): void {
    this.requireWritable(type);
    if (this.removeCount < this.pendingRemoveEntity.length) {
      this.pendingRemoveEntity[this.removeCount] = entity;
      this.pendingRemoveType[this.removeCount] = type;
    } else {
      this.pendingRemoveEntity.push(entity);
      this.pendingRemoveType.push(type);
    }
    this.removeCount += 1;
  }

  /** Apply what was deferred. Drained by count, never by emptying — see `IMPROVEMENTS.md`. */
  private drain(): void {
    for (let i = 0; i < this.removeCount; i += 1) {
      this.world.remove(
        this.pendingRemoveEntity[i] as Entity,
        this.pendingRemoveType[i] as ComponentType,
      );
    }
    this.removeCount = 0;
    for (let i = 0; i < this.destroyCount; i += 1)
      this.world.destroy(this.pendingDestroy[i] as Entity);
    this.destroyCount = 0;
  }

  private requireReadable(type: ComponentType): void {
    if (this.readable.has(type.id)) return;
    throw new Error(
      `\`${this.definition.name}\` reads \`${type.name}\` and did not declare it. The schedule is ` +
        'derived from what systems declare, so one that touches more than it says makes every ' +
        'derivation wrong — add it to `reads`, or to `writes` if it also writes it.',
    );
  }

  private requireWritable(type: ComponentType): void {
    if (this.writable.has(type.id)) return;
    throw new Error(
      `\`${this.definition.name}\` writes \`${type.name}\` and did not declare it. Add it to ` +
        '`writes`; over-declaring is conservative and only costs schedule width.',
    );
  }
}
