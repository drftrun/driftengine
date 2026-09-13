/**
 * A component type, and the sparse set that holds one.
 *
 * **Sparse sets rather than archetypes, and the reason is churn.** An archetype table iterates a
 * multi-component query faster because the components are already adjacent — but adding or removing
 * one component moves the entity between tables, which copies every component it has. A game that
 * adds and removes a marker component per frame pays that copy per frame, and a marker is exactly
 * the pattern queries are built for. Here, add and remove are constant time and move nothing else.
 *
 * The cost is that a multi-component query walks one dense array and tests membership in the others,
 * so the data is not adjacent. **That is to be measured rather than assumed**, and the measurement
 * is a deliverable of this track — in a language where every object field is already an indirection
 * the gap is not the one a systems language would see.
 *
 * ---
 *
 * ## The schema is DriftScript's, and there is no second description
 *
 * A component's fields, their types and their **stable ids** are a `Schema` — the same structure
 * Track N's Phase 5 built for state migration. Storage layout reads it, serialization reads its
 * ids, loading a scene across a field change goes through `migrate` unchanged, and an inspector
 * will read it when Track K exists. Four readers, one description, nothing to keep in sync.
 *
 * A field id is `(declaring module, declaring record, field name)` and never a position, so a field
 * inserted in the middle moves nothing and a scene saved before it loads afterwards.
 *
 * ## Numeric fields get typed arrays; everything else gets a plain one
 *
 * `AGENTS.md`'s bulk-data rule where it belongs. **What it gives up** is that a component is not a
 * value a caller can hold — reading one means reading its fields — which is deliberate, because a
 * component object handed out is an object allocated per read, sixty times a second.
 */
import type { Schema } from 'driftscript';
import { type Entity, entityIndex } from './entity.ts';
import { type ComponentView, type ViewColumn, refreshView } from './view.ts';

/**
 * The presence column's name for an optional field.
 *
 * A suffix rather than a parallel map, because `grow`, `remove` and the view all already walk
 * `this.columns` — and a second map would be one more thing each of them has to remember. What it
 * gives up is a field literally named `of$present`, which the language refuses at declaration and
 * which `$` makes unwritable in a `.drs` file anyway. **What would make it wrong** is a component
 * that is mostly optional, where a bitset over all of its optional fields beats a byte each — a
 * change to how presence is stored, not to what an option is, so it moves nothing a save holds.
 */
export const presenceColumn = (field: string): string => `${field}$present`;

/**
 * `option:f64` → `f64`, and `undefined` for a type that is not an option.
 *
 * A prefix rather than a structured type because a schema's field type is a *key* — one string
 * compared for equality by a migration — and parsing it here is cheaper than carrying a second
 * representation that could disagree with it.
 */
export function optionInner(type: string): string | undefined {
  return type.startsWith('option:') ? type.slice('option:'.length) : undefined;
}

/**
 * Which typed array carries which field type.
 *
 * `i64` and `u64` are `Float64Array` rather than `BigInt64Array` because the language they come
 * from represents them as JavaScript numbers — exact to 2^53 — and a `BigInt` column would be a
 * different representation on this side of a boundary that is supposed to be one.
 *
 * **That was inferred here before DriftScript said it, and now it is the language's own rule.**
 * 1.10.0 defines the domain of `i64` and `u64` as `±(2^53 - 1)` and `0 … 2^53 - 1`, refuses a
 * literal outside it, and refuses wrapping arithmetic on either width because the true result is
 * rounded before anything can reduce it. So this column is not a compromise the engine chose; it is
 * the width the language guarantees, and the two agree by contract rather than by coincidence.
 *
 * `Entity` is here too, and `Float64Array` is what makes a handle survive: a handle spends the
 * whole 53-bit budget, so anything narrower silently truncates the generation, which is the failure
 * the handle's width exists to prevent.
 */
const COLUMNS: Readonly<Record<string, new (length: number) => ArrayLike<number>>> = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  i64: Float64Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  u64: Float64Array,
  bool: Uint8Array,
  Entity: Float64Array,
};

/** Field types held in a plain array because they are not numbers. */
const BOXED: ReadonlySet<string> = new Set(['String']);

/**
 * Whether a field type is a fieldless enum, which the language writes as `enum:<Name>`.
 *
 * **A discriminant is an integer and always was**, so this is a column rather than a boxed value —
 * which is the whole of why it can be added without deciding anything about layout.
 *
 * **The gap it closes is between a language feature and its usable shape.** DriftScript has `enum`,
 * and `match` over one refuses to compile until every variant is handled; that exhaustiveness is
 * the language's stated advantage over a Lua version which would silently do nothing for a state
 * nobody wrote a branch for. But a state machine's state has to survive between ticks, which means
 * a *component* field, and there was no column for one — so the language's own corpus keeps its
 * `Alertness` in a `data` record, which is not what a system iterates, and a consumer shipped
 * `mood: i32` with the three values written out in a comment. The feature and the place it is
 * needed could not meet.
 */
function enumName(type: string): string | undefined {
  return type.startsWith('enum:') ? type.slice('enum:'.length) : undefined;
}

/**
 * The column a discriminant goes in: `Int32Array`, and the width is the decision.
 *
 * **A byte would hold every enum anybody is likely to write and is not what this uses**, because
 * the failure mode of guessing too small is silent. `defineComponent` is handed `enum:Mood` and a
 * name is all it gets — the variant list belongs to the module that declared it, which this package
 * does not read — so it cannot know whether 256 is enough. Four bytes a field costs three more than
 * a byte for a small enum and cannot truncate a large one.
 *
 * **What would make it wrong** is a consumer measuring enum columns as a real share of their
 * component memory, at which point the width belongs to whoever declares the enum and can count its
 * variants, and this stops choosing.
 */
const ENUM_COLUMN = Int32Array;

export interface ComponentType {
  readonly name: string;
  readonly schema: Schema;
  /**
   * A small dense integer, for indexing by component type in a query or a schedule.
   *
   * Allocated in declaration order at module load, so it is the same on every run of the same
   * code — and it is deliberately **not** what a scene is written with. A scene uses field ids,
   * which survive a reorder; this survives nothing and is never stored.
   */
  readonly id: number;
  /** Fields typed `Entity`, which a scene load has to rewrite through its id map. */
  readonly entityFields: readonly string[];
}

let nextComponentId = 0;

export function defineComponent(schema: Schema): ComponentType;
export function defineComponent(
  name: string,
  fields: Readonly<Record<string, string>>,
): ComponentType;
/**
 * Declare a component type, from a schema or from a name and a field table.
 *
 * **The schema overload is what a language-declared component uses**, and it exists because a field
 * id is `(declaring module, declaring record, field name)`. A `.drs` file that declares `Health` is
 * the declaring module; building the id here would file every language-declared component under
 * `entities` and lose the half that makes a save survive a rename. The record overload goes on
 * building `entities::<Name>::<field>`, because for a component declared in TypeScript this package
 * genuinely *is* where the shape is declared.
 *
 * The ids are still never hand-written in the record overload, for the reason that has always been
 * here: a hand-written id is a chance to write two the same, which `driftscript` refuses at
 * `DS0284` for a record and which nothing would catch on this side.
 *
 * **What this costs** is two entry points to one concept. **What would make it wrong** is a third
 * caller wanting a different id scheme, at which point the id belongs entirely to whoever declares
 * the field and this function stops building one at all.
 */
export function defineComponent(
  first: Schema | string,
  fields?: Readonly<Record<string, string>>,
): ComponentType {
  const schema: Schema =
    typeof first === 'string'
      ? {
          name: first,
          fields: Object.entries(fields ?? {}).map(([field, type]) => ({
            id: `entities::${first}::${field}`,
            name: field,
            type,
          })),
        }
      : first;

  for (const field of schema.fields) {
    const inner = optionInner(field.type) ?? field.type;
    if (COLUMNS[inner] === undefined && !BOXED.has(inner) && enumName(inner) === undefined) {
      throw new Error(
        `\`${schema.name}.${field.name}\` is declared \`${field.type}\`, which has no column. The ` +
          `types with one are ${[...Object.keys(COLUMNS), ...BOXED].join(', ')}, a fieldless ` +
          '`enum:<Name>`, and an option of any of them. A type that has to be boxed is a decision ' +
          'about layout, so it is added here rather than assumed.',
      );
    }
  }

  return {
    name: schema.name,
    id: nextComponentId++,
    schema,
    /* An optional handle is still a handle, so a scene load has to rewrite it through the id map
       exactly as it rewrites a required one. Leaving it out would serialise a handle into a world
       whose indices mean something else. */
    entityFields: schema.fields
      .filter((f) => f.type === 'Entity' || f.type === 'option:Entity')
      .map((f) => f.name),
  };
}

/**
 * One store's contents, for a rewind. Reused between saves; see `AllocatorSnapshot`.
 *
 * **`sparse` is absent and that is a decision.** It is derivable from `dense` — position *i* holds
 * the entity whose sparse entry is *i* — and its length grows with the highest entity index the
 * world has ever reached rather than with the live set. A world of forty entities that once held
 * forty thousand would copy 160 KB per store per tick to save an array it can rebuild in forty
 * writes. `loadFrom` rebuilds it.
 */
export interface StoreSnapshot {
  count: number;
  dense: Float64Array;
  /** Field name to its column's contents, mirroring `columns`. Grown to match, never shrunk. */
  columns: Map<string, NumericColumn | unknown[]>;
}

export function createStoreSnapshot(): StoreSnapshot {
  return { count: 0, dense: new Float64Array(0), columns: new Map() };
}

export interface ComponentStoreOptions {
  /** Initial column length. Present for the growth test; a consumer has no reason to set it. */
  readonly capacity?: number;
}

/** A mutable numeric column, which the readonly `ArrayLike` in `COLUMNS` does not describe. */
type NumericColumn =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

export class ComponentStore {
  readonly type: ComponentType;

  /**
   * The entities that have this component, in insertion order modified by swap-removal.
   *
   * **Deterministic given the same history, and not a stable property of the set** — two worlds
   * holding the same entities in a different removal order iterate differently. That is what replay
   * needs and is not what a consumer wanting a stable order gets; they sort by entity, and the fact
   * that it is a choice is why this says so.
   */
  private denseArray: Float64Array;
  /** Entity index → position in `dense`, or -1. */
  private sparse: Int32Array;
  private readonly columns = new Map<string, NumericColumn | unknown[]>();
  private count = 0;
  /**
   * The live view of these columns, made on first ask.
   *
   * Lazy rather than built in the constructor, because a store that nobody indexes directly should
   * not carry an object per field name it will never hand out.
   */
  private viewObject: ComponentView | null = null;

  constructor(type: ComponentType, options: ComponentStoreOptions = {}) {
    this.type = type;
    const capacity = Math.max(1, options.capacity ?? 16);
    this.denseArray = new Float64Array(capacity);
    this.sparse = new Int32Array(64).fill(-1);
    for (const field of type.schema.fields) {
      const inner = optionInner(field.type);
      const declared = inner ?? field.type;
      /* A discriminant is an integer, so it takes an integer column rather than being boxed. */
      const Column = enumName(declared) === undefined ? COLUMNS[declared] : ENUM_COLUMN;
      this.columns.set(
        field.name,
        Column === undefined
          ? new Array<unknown>(capacity)
          : (new Column(capacity) as NumericColumn),
      );
      /* An option keeps its inner type's column and gains a byte per entity saying whether the
         value in it means anything. Without the second column, an optional `Entity` would have to
         live in a boxed array so `null` could stand for absence — which is the whole bulk-data
         rule given up for one bit. */
      if (inner !== undefined)
        this.columns.set(presenceColumn(field.name), new Uint8Array(capacity));
    }
  }

  get size(): number {
    return this.count;
  }

  /** The entities this store holds, oldest first. Valid up to `size`; the rest is capacity. */
  get dense(): Float64Array {
    return this.denseArray;
  }

  /**
   * The live columns of this store, addressable by field name.
   *
   * The same object every call, refreshed after every reallocation — see `view.ts` for why that is
   * the contract rather than a convenience.
   */
  view(): ComponentView {
    if (this.viewObject === null) this.viewObject = { sparse: this.sparse } as ComponentView;
    refreshView(this.viewObject, this.sparse, this.columns as ReadonlyMap<string, ViewColumn>);
    return this.viewObject;
  }

  /** Point the view at the arrays that exist now. Called after either kind of growth. */
  private refresh(): void {
    if (this.viewObject === null) return;
    refreshView(this.viewObject, this.sparse, this.columns as ReadonlyMap<string, ViewColumn>);
  }

  /** One field's storage, for a caller iterating it directly rather than through `read`. */
  column(field: string): NumericColumn | unknown[] {
    const found = this.columns.get(field);
    if (found === undefined) throw new Error(this.noField(field));
    return found;
  }

  has(entity: Entity): boolean {
    const at = this.positionOf(entity);
    return at >= 0;
  }

  add(entity: Entity, values: Readonly<Record<string, unknown>> = {}): void {
    if (this.has(entity)) {
      for (const [field, value] of Object.entries(values)) this.write(entity, field, value);
      return;
    }

    const at = this.count;
    this.grow(at + 1);
    this.growSparse(entityIndex(entity) + 1);
    this.denseArray[at] = entity;
    this.sparse[entityIndex(entity)] = at;
    this.count += 1;

    /*
     * Every field written, including the ones the caller omitted.
     *
     * A column is reused storage — the slot may hold whatever the entity that was there last left
     * — so an omitted field would silently inherit a stranger's value. Zeroing is what makes
     * `add(e, { x: 5 })` mean what it reads like.
     */
    for (const field of this.type.schema.fields) {
      const column = this.columns.get(field.name);
      if (column === undefined) continue;
      const given = values[field.name];
      if (Array.isArray(column)) column[at] = given ?? null;
      else (column as NumericColumn)[at] = typeof given === 'number' ? given : Number(given ?? 0);
      /*
       * Presence is written here rather than left at whatever the slot held.
       *
       * This loop walks the *schema's* fields and the presence columns are not among them, so a
       * reused slot would otherwise inherit the presence of whichever entity was there last —
       * an optional field that reads as set, holding a number the caller never wrote.
       */
      const present = this.columns.get(presenceColumn(field.name));
      if (present !== undefined) (present as NumericColumn)[at] = given === undefined ? 0 : 1;
    }
  }

  /**
   * Drop an entity's component. `false` when it never had one, which is not an error.
   *
   * The last entry is swapped into the hole and **its** sparse entry is fixed — the fix-up being
   * the whole of what makes a constant-time removal correct.
   *
   * **The order of the two sparse writes is load-bearing**, and it is the only thing that is. When
   * the entry being removed *is* the last, the swap is with itself and `moved` is `entity`: writing
   * the position first and then the -1 leaves it absent, which is right; the other way round leaves
   * it pointing into the space past `size`.
   *
   * There was a `position < size` guard in `positionOf` as well, which made the order not matter —
   * and made a perturbation of the order pass every test. Two defences for one case is one defence
   * and one comment that cannot be checked, so the guard is gone and the order is what the test
   * for removing the last entry actually holds.
   */
  remove(entity: Entity): boolean {
    const at = this.positionOf(entity);
    if (at < 0) return false;

    const last = this.count - 1;
    const moved = this.denseArray[last] as number;
    this.denseArray[at] = moved;
    for (const column of this.columns.values()) {
      if (Array.isArray(column)) column[at] = column[last];
      else (column as NumericColumn)[at] = (column as NumericColumn)[last] as number;
    }
    this.sparse[entityIndex(moved)] = at;
    this.sparse[entityIndex(entity)] = -1;
    this.count -= 1;
    return true;
  }

  read(entity: Entity, field: string): unknown {
    const column = this.columns.get(field);
    if (column === undefined) throw new Error(this.noField(field));
    const at = this.positionOf(entity);
    if (at < 0) return undefined;
    const present = this.columns.get(presenceColumn(field));
    if (present !== undefined && (present as NumericColumn)[at] === 0) return undefined;
    return column[at];
  }

  write(entity: Entity, field: string, value: unknown): void {
    const column = this.columns.get(field);
    if (column === undefined) throw new Error(this.noField(field));
    const at = this.positionOf(entity);
    if (at < 0) return;
    /* `undefined` is how an optional field is cleared. On a non-optional field there is no presence
       column and the value goes through the same coercion it always did. */
    const present = this.columns.get(presenceColumn(field));
    if (present !== undefined) (present as NumericColumn)[at] = value === undefined ? 0 : 1;
    if (Array.isArray(column)) column[at] = value;
    else (column as NumericColumn)[at] = typeof value === 'number' ? value : Number(value ?? 0);
  }

  /**
   * Where an entity sits, or -1.
   *
   * **The dense array holds the whole handle**, so the generation is compared for free: a stale
   * handle whose slot is live finds a different number and is refused. A sparse array alone could
   * only compare indices, which is the silent-reuse failure one level down.
   */
  private positionOf(entity: Entity): number {
    const index = entityIndex(entity);
    if (index >= this.sparse.length) return -1;
    const at = this.sparse[index] as number;
    if (at < 0) return -1;
    return this.denseArray[at] === entity ? at : -1;
  }

  /**
   * Copy this store's contents into a slot, growing the slot to match if it is short.
   *
   * **`count` bounds every copy, not capacity.** A store that once held ten thousand entities and
   * now holds four has ten thousand slots of stale numbers behind the live four, and copying them
   * would make a snapshot's cost depend on the world's history instead of its size.
   *
   * A boxed column copies references. That is correct rather than a shortcut: the one boxed field
   * type is `String`, and a string cannot be mutated behind the snapshot's back.
   */
  saveInto(slot: StoreSnapshot): void {
    const count = this.count;
    if (slot.dense.length < count) slot.dense = new Float64Array(this.denseArray.length);
    for (let i = 0; i < count; i++) slot.dense[i] = this.denseArray[i] as number;

    for (const [field, column] of this.columns) {
      let into = slot.columns.get(field);
      if (into === undefined || into.length < count) {
        into = Array.isArray(column)
          ? new Array<unknown>(column.length)
          : new (column.constructor as new (n: number) => NumericColumn)(column.length);
        slot.columns.set(field, into);
      }
      if (Array.isArray(column)) {
        const target = into as unknown[];
        for (let i = 0; i < count; i++) target[i] = column[i];
      } else {
        const source = column as NumericColumn;
        const target = into as NumericColumn;
        for (let i = 0; i < count; i++) target[i] = source[i] as number;
      }
    }

    slot.count = count;
  }

  /**
   * Put this store back to a saved slot, rebuilding `sparse` from the restored `dense`.
   *
   * **The order of the two sparse passes is load-bearing.** The entries this store's *current* live
   * set occupies are cleared first, while `dense` still says which they are; overwriting `dense`
   * first loses that record and leaves stale positions behind, and a stale position is worse than a
   * missing one because `positionOf` would find a live slot holding a different handle.
   */
  loadFrom(slot: StoreSnapshot): void {
    for (let at = 0; at < this.count; at++) {
      this.sparse[entityIndex(this.denseArray[at] as number)] = -1;
    }

    /* Before the columns are read out of the map: `grow` replaces every array in it. */
    this.grow(Math.max(1, slot.count));

    for (let i = 0; i < slot.count; i++) this.denseArray[i] = slot.dense[i] as number;

    for (const [field, column] of this.columns) {
      const from = slot.columns.get(field);
      if (from === undefined) continue;
      if (Array.isArray(column)) {
        const source = from as unknown[];
        for (let i = 0; i < slot.count; i++) column[i] = source[i];
      } else {
        const source = from as NumericColumn;
        const target = column as NumericColumn;
        for (let i = 0; i < slot.count; i++) target[i] = source[i] as number;
      }
    }

    this.count = slot.count;

    for (let at = 0; at < slot.count; at++) {
      const index = entityIndex(this.denseArray[at] as number);
      this.growSparse(index + 1);
      this.sparse[index] = at;
    }
  }

  private noField(field: string): string {
    return (
      `\`${this.type.name}\` has no field \`${field}\`. It has ` +
      `${this.type.schema.fields.map((f) => `\`${f.name}\``).join(', ')}.`
    );
  }

  private grow(needed: number): void {
    if (needed <= this.denseArray.length) return;
    let size = this.denseArray.length;
    while (size < needed) size *= 2;

    const dense = new Float64Array(size);
    dense.set(this.denseArray);
    this.denseArray = dense;

    for (const [field, column] of this.columns) {
      if (Array.isArray(column)) {
        column.length = size;
        continue;
      }
      const grown = new (column.constructor as new (n: number) => NumericColumn)(size);
      grown.set(column as never);
      this.columns.set(field, grown);
    }
    this.refresh();
  }

  private growSparse(needed: number): void {
    if (needed <= this.sparse.length) return;
    let size = this.sparse.length;
    while (size < needed) size *= 2;
    const sparse = new Int32Array(size).fill(-1);
    sparse.set(this.sparse);
    this.sparse = sparse;
    this.refresh();
  }
}
