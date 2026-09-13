/**
 * A rewind puts a world back, and the property it has to have is *identity*.
 *
 * The tests that matter here are not "the values came back". They are that a handle means the same
 * entity afterwards, that an entity created since is gone, that one destroyed since is alive again
 * as the same handle, and that the next `create` hands out what it handed out the first time. Every
 * one of those is a way a rollback silently produces a different world from the one it is replaying
 * — silently, because the world it produces is perfectly plausible.
 */
import { describe, expect, it } from 'vitest';
import { entityGeneration, entityIndex, packEntity } from './entity.ts';
import { defineComponent } from './store.ts';
import { World, createWorldSnapshot } from './world.ts';

const Position = defineComponent('RPosition', { x: 'f32', y: 'f32' });
const Health = defineComponent('RHealth', { current: 'f32', alive: 'bool' });
const Named = defineComponent('RNamed', { label: 'String' });
const Target = defineComponent('RTarget', { of: 'Entity' });
const Late = defineComponent('RLate', { value: 'i32' });

describe('a world snapshot', () => {
  it('restores every value it held', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    world.add(a, Position, { x: 1.5, y: -2.5 });
    world.add(b, Position, { x: 30, y: 40 });
    world.add(a, Health, { current: 10, alive: 1 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    world.write(a, Position, 'x', 999);
    world.write(a, Health, 'current', 0);
    world.write(b, Position, 'y', -1);

    world.loadFrom(slot);

    expect(world.read(a, Position, 'x')).toBe(1.5);
    expect(world.read(a, Position, 'y')).toBe(-2.5);
    expect(world.read(a, Health, 'current')).toBe(10);
    expect(world.read(b, Position, 'x')).toBe(30);
    expect(world.read(b, Position, 'y')).toBe(40);
  });

  /**
   * The one property `SerializedScene` deliberately does not have.
   *
   * A load through `deserializeWorld` creates entities and remaps every handle, which is right for
   * a save file and fatal here: an input recorded against entity 4,194,307 has to still mean that
   * entity after the rewind, or the replay applies it to a stranger.
   */
  it('preserves handles exactly, generation included', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    world.add(a, Position, { x: 7, y: 8 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);
    world.loadFrom(slot);

    expect(world.alive(a)).toBe(true);
    expect(world.alive(b)).toBe(true);
    expect(world.read(a, Position, 'x')).toBe(7);
    expect(world.liveCount).toBe(2);

    /* And the *next* generation of a's slot is still not alive, which is what says the generation
       came back rather than merely being some number. A restore that bumped it would leave the
       handle above stale and this one live, and the value assertions could not tell. */
    expect(world.alive(packEntity(entityIndex(a), entityGeneration(a) + 1))).toBe(false);
  });

  it('an entity created after the save is gone, and its handle is not alive', () => {
    const world = new World();
    const before = world.create();

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    const after = world.create();
    world.add(after, Position, { x: 5, y: 5 });
    expect(world.liveCount).toBe(2);

    world.loadFrom(slot);

    expect(world.liveCount).toBe(1);
    expect(world.alive(before)).toBe(true);
    expect(world.alive(after)).toBe(false);
    expect(world.has(after, Position)).toBe(false);
  });

  /**
   * A destroyed entity comes back as *the same handle*, which is stronger than coming back.
   *
   * `destroy` moves the slot's generation on, so a naive restore that put the components back but
   * left the generation would leave the old handle stale: every stored reference to it — an input,
   * another component's `Entity` field — would answer `alive: false` while the entity sat in the
   * world.
   */
  it('an entity destroyed after the save is alive again as the same handle', () => {
    const world = new World();
    const doomed = world.create();
    world.add(doomed, Health, { current: 42, alive: 1 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    world.destroy(doomed);
    expect(world.alive(doomed)).toBe(false);

    world.loadFrom(slot);

    expect(world.alive(doomed)).toBe(true);
    expect(world.read(doomed, Health, 'current')).toBe(42);

    /* The generation went *back*: the handle `destroy` would have invalidated to is dead again. */
    expect(world.alive(packEntity(entityIndex(doomed), entityGeneration(doomed) + 1))).toBe(false);
  });

  /**
   * The deep one: a replay creates the same entities the first run created.
   *
   * A spawn during a replayed tick has to produce the handle it produced the first time, or every
   * reference the rest of the replay makes to it is wrong. That depends on three pieces of the
   * allocator being restored together — the generations, the high-water mark, and the free queue
   * *in order*, since the queue is first-in-first-out and a different order hands out a different
   * slot.
   */
  it('the next spawn after a restore repeats the spawn it made before', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    const c = world.create();
    /* Two holes in the free queue, in a known order, so the restore has an order to get wrong. */
    world.destroy(a);
    world.destroy(c);

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    const firstRun = [world.create(), world.create(), world.create()];

    world.loadFrom(slot);

    const replay = [world.create(), world.create(), world.create()];

    expect(replay).toEqual(firstRun);
    expect(world.alive(b)).toBe(true);
  });

  it('a component added after the save is gone after the restore', () => {
    const world = new World();
    const e = world.create();
    world.add(e, Position, { x: 1, y: 2 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    world.add(e, Health, { current: 5, alive: 1 });
    expect(world.has(e, Health)).toBe(true);

    world.loadFrom(slot);

    expect(world.has(e, Health)).toBe(false);
    expect(world.has(e, Position)).toBe(true);
  });

  /**
   * A store the snapshot never knew about is emptied, not skipped.
   *
   * `World.store` makes a store on first ask, so a component type touched for the first time after
   * a save has a store the slot has no entry for. Skipping it would leave those components attached
   * to entities the restored allocator says are dead.
   */
  it('a store created after the save is emptied', () => {
    const world = new World();
    const e = world.create();
    world.add(e, Position, { x: 0, y: 0 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    world.add(e, Late, { value: 77 });
    expect(world.store(Late).size).toBe(1);

    world.loadFrom(slot);

    expect(world.store(Late).size).toBe(0);
    expect(world.has(e, Late)).toBe(false);
  });

  /**
   * `sparse` is rebuilt from `dense` rather than copied, so this is the assertion that the rebuild
   * is right — including the entries it has to *clear*.
   *
   * A stale sparse entry is worse than a missing one: `positionOf` would find a live position
   * holding a different handle, and the dense-array check is the only thing standing between that
   * and reading another entity's component.
   */
  it('rebuilds the sparse index, clearing what the live set no longer occupies', () => {
    const world = new World();
    const kept = world.create();
    const spawned: number[] = [];
    world.add(kept, Position, { x: 1, y: 1 });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    /* Enough to move `kept` around by swap-removal and to push the sparse array wider. */
    for (let i = 0; i < 20; i++) {
      const e = world.create();
      spawned.push(e);
      world.add(e, Position, { x: i, y: i });
    }
    world.remove(kept, Position);
    world.add(kept, Position, { x: 500, y: 500 });

    world.loadFrom(slot);

    expect(world.store(Position).size).toBe(1);
    expect(world.has(kept, Position)).toBe(true);
    expect(world.read(kept, Position, 'x')).toBe(1);
    for (const e of spawned) {
      expect(world.has(e, Position)).toBe(false);
      expect(world.alive(e)).toBe(false);
    }
  });

  it('restores a boxed column and an entity-typed field', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    world.add(a, Named, { label: 'sentry' });
    world.add(a, Target, { of: b });

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    world.write(a, Named, 'label', 'changed');
    world.write(a, Target, 'of', a);

    world.loadFrom(slot);

    expect(world.read(a, Named, 'label')).toBe('sentry');
    expect(world.read(a, Target, 'of')).toBe(b);
  });

  /**
   * Nothing is reallocated on a save whose shape has not changed, which is what makes a ring
   * affordable at sixty ticks a second.
   *
   * Asserted by identity on the arrays themselves. A save that replaced them every time would pass
   * every value assertion above and quietly allocate a few hundred typed arrays a second.
   */
  it('reuses its arrays once the world has stopped growing', () => {
    const world = new World();
    for (let i = 0; i < 8; i++) {
      const e = world.create();
      world.add(e, Position, { x: i, y: i });
    }

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    const dense = slot.stores.get(Position.id)?.dense;
    const column = slot.stores.get(Position.id)?.columns.get('x');
    const generations = slot.allocator.generations;

    world.saveInto(slot);
    world.saveInto(slot);

    expect(slot.stores.get(Position.id)?.dense).toBe(dense);
    expect(slot.stores.get(Position.id)?.columns.get('x')).toBe(column);
    expect(slot.allocator.generations).toBe(generations);
  });

  /**
   * What a snapshot of a realistic world costs, measured rather than estimated.
   *
   * The figure is asserted loosely — the point is that it is *recorded* and that a change which
   * multiplied it would fail here. A rewind ring of eight is eight of these.
   */
  it('costs a bounded number of bytes for a thousand entities', () => {
    const world = new World();
    for (let i = 0; i < 1000; i++) {
      const e = world.create();
      world.add(e, Position, { x: i, y: i });
      world.add(e, Health, { current: 100, alive: 1 });
    }

    const slot = createWorldSnapshot();
    world.saveInto(slot);

    let bytes = slot.allocator.generations.byteLength + slot.allocator.live.byteLength;
    bytes += slot.allocator.free.byteLength;
    for (const store of slot.stores.values()) {
      bytes += store.dense.byteLength;
      for (const column of store.columns.values()) {
        if (!Array.isArray(column)) bytes += (column as { byteLength: number }).byteLength;
      }
    }

    /* Two components over a thousand entities: two dense arrays of 8 bytes, four f32 columns, one
       byte column, and the allocator's five bytes an entity. Measured at 34,816 on 2026-09-03. */
    expect(bytes).toBeLessThan(64 * 1024);
    expect(bytes).toBeGreaterThan(16 * 1024);
  });
});
