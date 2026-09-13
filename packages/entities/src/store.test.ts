import { describe, expect, it } from 'vitest';
import { EntityAllocator, packEntity } from './entity.ts';
import { ComponentStore, type ComponentType, defineComponent } from './store.ts';

const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
const Label = defineComponent('Label', { text: 'String' });
const Link = defineComponent('Link', { to: 'Entity' });

describe('defining a component', () => {
  it('gives every field an id keyed to the component that declares it', () => {
    expect(Position.schema.fields.map((f) => f.id)).toEqual([
      'entities::Position::x',
      'entities::Position::y',
    ]);
  });

  it('gives each component type a distinct id, so a query can index by it', () => {
    expect(Position.id).not.toBe(Label.id);
  });

  it('keeps the declaring module in every field id when built from a schema', () => {
    /* A field id is `(declaring module, declaring record, field name)`. A `.drs` file that declares
       `Health` is the declaring module, so building the id here would file every language-declared
       component under `entities` and lose exactly the part that makes a save survive a rename. */
    const type = defineComponent({
      name: 'Health',
      fields: [
        { id: 'demo/world.drs::Health::current', name: 'current', type: 'f64' },
        { id: 'demo/world.drs::Health::maximum', name: 'maximum', type: 'f64' },
      ],
    });
    expect(type.schema.fields.map((f) => f.id)).toEqual([
      'demo/world.drs::Health::current',
      'demo/world.drs::Health::maximum',
    ]);
  });

  it('still files ids under `entities` when built from a name and a field table', () => {
    expect(defineComponent('Vigour', { current: 'f64' }).schema.fields[0]?.id).toBe(
      'entities::Vigour::current',
    );
  });

  it('names an optional entity field among the ones a scene load has to remap', () => {
    const type = defineComponent({
      name: 'Follow',
      fields: [{ id: 'x::Follow::of', name: 'of', type: 'option:Entity' }],
    });
    expect(type.entityFields).toEqual(['of']);
  });

  it('refuses a field type it has no column for, rather than silently boxing it', () => {
    expect(() => defineComponent('Bad', { v: 'Vec3' })).toThrow(/Vec3/);
  });

  /**
   * A fieldless enum is an integer, and a component may hold one.
   *
   * **This is where a language feature and its usable shape came apart.** DriftScript has `enum`,
   * and `match` over one refuses to compile until every variant is handled — which the language's
   * own corpus demonstrates as the selling point over a Lua version that would silently do nothing
   * for a state nobody wrote a branch for. But a state machine's state has to persist between
   * ticks, which means a component field, and this store had no column for one. So the corpus keeps
   * its `Alertness` in a `data` record, which is not what a system iterates, and a consumer shipped
   * `mood: i32` with three numbers written out in a comment — exactly the thing the language
   * advertises against.
   *
   * The discriminant needs no boxing: it is the integer it always was.
   */
  it('gives a fieldless enum an integer column, because that is what a discriminant is', () => {
    expect(() => defineComponent('Mob', { mood: 'enum:Mood' })).not.toThrow();
  });

  it('takes an optional enum too, on the same reading', () => {
    expect(() => defineComponent('Guard', { alert: 'option:enum:Alertness' })).not.toThrow();
  });

  /* Still a name, so a typo in the enum's own name is not silently given a column. */
  it('still refuses a bare name that names no type', () => {
    expect(() => defineComponent('Bad', { v: 'Mood' })).toThrow(/Mood/);
  });
});

describe('a component store', () => {
  /*
   * An enum lands in a typed array like every other integer, which is the whole point of giving it
   * a column: a system iterating a state machine reads it the way it reads a position.
   */
  it('stores an enum in a typed array rather than boxing it', () => {
    const Mob = defineComponent('MobState', { mood: 'enum:Mood' });
    const store = new ComponentStore(Mob);
    const allocator = new EntityAllocator();
    const entity = allocator.create();
    store.add(entity, { mood: 2 });
    expect(store.column('mood')).toBeInstanceOf(Int32Array);
    expect(store.read(entity, 'mood')).toBe(2);
  });

  it('puts a numeric field in a typed array and everything else in a plain one', () => {
    /* `AGENTS.md`'s bulk-data rule where it belongs: a position is a typed-array read, not a
       property lookup on an object in a list. */
    const numbers = new ComponentStore(Position);
    const words = new ComponentStore(Label);

    expect(numbers.column('x')).toBeInstanceOf(Float32Array);
    expect(Array.isArray(words.column('text'))).toBe(true);
  });

  it('holds a value per entity and reads it back', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();
    const b = allocator.create();

    store.add(a, { x: 1, y: 2 });
    store.add(b, { x: 3, y: 4 });

    expect(store.read(a, 'x')).toBe(1);
    expect(store.read(b, 'y')).toBe(4);
    expect(store.size).toBe(2);
  });

  it('fills a field the caller omitted with the zero for its type', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();

    store.add(a, { x: 5 });

    expect(store.read(a, 'x')).toBe(5);
    expect(store.read(a, 'y')).toBe(0);
  });

  it('says no for an entity it does not hold', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();
    const b = allocator.create();
    store.add(a, { x: 1, y: 2 });

    expect(store.has(a)).toBe(true);
    expect(store.has(b)).toBe(false);
  });

  it('says no for a stale handle whose slot is live, which is what the generation is for', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const first = allocator.create();
    store.add(first, { x: 1, y: 2 });
    store.remove(first);
    allocator.destroy(first);

    const second = allocator.create();
    store.add(second, { x: 9, y: 9 });

    expect(store.has(second)).toBe(true);
    expect(store.has(first)).toBe(false);
    expect(store.read(first, 'x')).toBe(undefined);
  });

  it('swaps the last entry into a removed one and fixes that entity own position', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();
    const b = allocator.create();
    const c = allocator.create();
    store.add(a, { x: 1, y: 1 });
    store.add(b, { x: 2, y: 2 });
    store.add(c, { x: 3, y: 3 });

    store.remove(a);

    expect(store.size).toBe(2);
    /* `c` moved into `a`'s slot, and reading it must still find its own values. */
    expect(store.read(c, 'x')).toBe(3);
    expect(store.read(b, 'x')).toBe(2);
    expect(store.has(a)).toBe(false);
  });

  it('removes the last entry without corrupting the one before it', () => {
    /* The swap-remove edge most first implementations get wrong: the entry being removed *is* the
       last, so swapping it with itself must not leave a dangling sparse entry. */
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();
    const b = allocator.create();
    store.add(a, { x: 1, y: 1 });
    store.add(b, { x: 2, y: 2 });

    store.remove(b);

    expect(store.size).toBe(1);
    expect(store.has(a)).toBe(true);
    expect(store.read(a, 'x')).toBe(1);
    expect(store.has(b)).toBe(false);
  });

  it('returns false for removing something it never held', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    expect(store.remove(allocator.create())).toBe(false);
  });

  it('keeps every survivor intact through a hundred thousand adds and fifty thousand removes', () => {
    /* The property the whole storage model exists for: removing one entity moves exactly one
       other, and moves nobody else's values at all. */
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const made: number[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      const entity = allocator.create();
      made.push(entity);
      store.add(entity, { x: i, y: -i });
    }

    for (let i = 0; i < made.length; i += 2) store.remove(made[i] as number);

    expect(store.size).toBe(50_000);
    for (let i = 1; i < made.length; i += 2) {
      const entity = made[i] as number;
      expect(store.read(entity, 'x'), `x of ${i}`).toBe(i);
      expect(store.read(entity, 'y'), `y of ${i}`).toBe(-i);
    }
  });

  it('grows its columns without moving anybody values', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position, { capacity: 2 });
    const made: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const entity = allocator.create();
      made.push(entity);
      store.add(entity, { x: i, y: i * 2 });
    }

    for (let i = 0; i < made.length; i += 1) {
      expect(store.read(made[i] as number, 'y'), `${i}`).toBe(i * 2);
    }
  });

  it('carries an entity-typed field as a number, so a scene can remap it', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Link);
    const a = allocator.create();
    const target = allocator.create();
    store.add(a, { to: target });

    expect(store.read(a, 'to')).toBe(target);
    expect(Link.entityFields).toEqual(['to']);
  });

  it('refuses a field the component does not have, rather than writing into nothing', () => {
    const allocator = new EntityAllocator();
    const store = new ComponentStore(Position);
    const a = allocator.create();
    store.add(a, { x: 1, y: 1 });

    expect(() => store.write(a, 'z', 1)).toThrow(/z/);
    expect(() => store.read(a, 'z')).toThrow(/z/);
  });

  it('holds an entity handle exactly, at the top of the range', () => {
    /* A `Float64Array` is what makes this true. Anything narrower silently truncates the
       generation, which is the whole failure the handle's width exists to prevent. */
    const store = new ComponentStore(Link);
    const holder = packEntity(1, 0);
    const top = Number.MAX_SAFE_INTEGER;
    store.add(holder, { to: top });

    expect(store.read(holder, 'to')).toBe(top);
  });
});

describe('option columns', () => {
  const optional: ComponentType = {
    name: 'Target',
    id: 900,
    entityFields: [],
    schema: {
      name: 'Target',
      fields: [{ id: 'test::Target::of', name: 'of', type: 'option:Entity' }],
    },
  };

  it('keeps the typed-array column its inner type asks for', () => {
    /* The point of the presence column: an optional handle is still a handle, so it belongs in a
       `Float64Array` and not in a boxed array where `null` stands in for absence. Falling back to a
       plain array is what this looked like before presence existed, and it read as working. */
    const store = new ComponentStore(optional);
    expect(store.column('of')).toBeInstanceOf(Float64Array);
  });

  it('an option field starts absent, holds a value, and clears back to absent', () => {
    const store = new ComponentStore(optional);
    const e = packEntity(3, 1);
    store.add(e, {});
    expect(store.read(e, 'of')).toBeUndefined();

    const other = packEntity(9, 2);
    store.write(e, 'of', other);
    expect(store.read(e, 'of')).toBe(other);

    store.write(e, 'of', undefined);
    expect(store.read(e, 'of')).toBeUndefined();
  });

  it('a reused slot starts absent rather than inheriting the last entity there', () => {
    /*
     * The case a version that only ever *sets* presence passes. `add`'s zeroing loop walks the
     * schema's fields and the presence columns are not among them, so without an explicit clear a
     * reused slot keeps the presence of whoever was there before — an optional field reading as
     * set, holding a number the caller never wrote. Perturbing the clear passed every other test
     * in this file, which is why this one exists.
     */
    const store = new ComponentStore(optional);
    const first = packEntity(1, 1);
    store.add(first, { of: packEntity(7, 1) });
    store.remove(first);

    const second = packEntity(2, 1);
    store.add(second, {});
    expect(store.read(second, 'of')).toBeUndefined();
  });

  it('a swap-removal carries presence with the value, in both directions', () => {
    const store = new ComponentStore(optional);
    const a = packEntity(1, 1);
    const b = packEntity(2, 1);
    const c = packEntity(3, 1);

    /* `b` is absent and `c` holds one. Removing `a` swaps `c` into slot 0; removing `c` then swaps
       `b` into slot 0. Both directions have to move presence, and a `remove` that moved only the
       value would pass one of them and fail the other. */
    store.add(a, {});
    store.add(b, {});
    store.add(c, { of: packEntity(7, 1) });

    store.remove(a);
    expect(store.read(c, 'of')).toBe(packEntity(7, 1));

    store.remove(c);
    expect(store.read(b, 'of')).toBeUndefined();
  });
});
