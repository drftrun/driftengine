import { describe, expect, it } from 'vitest';
import { defineComponent } from './store.ts';
import { World } from './world.ts';

describe('a component view', () => {
  it('is the same object every call, so a caller may hoist it', () => {
    const Position = defineComponent('ViewPosition', { x: 'f64' });
    const world = new World();
    expect(world.view(Position)).toBe(world.view(Position));
  });

  it('answers about the arrays that exist now, not the ones it was made over', () => {
    /*
     * The whole reason a view exists. A store's columns are reallocated when it grows, and `add` is
     * immediate inside a system on purpose — so a walk that adds a component grows the array it is
     * walking. A caller holding the array rather than the view writes into storage nothing reads
     * any more, which produces no error and no wrong type.
     */
    const Position = defineComponent('GrowPosition', { x: 'f64' });
    const world = new World();

    const first = world.create();
    world.add(first, Position, { x: 1 });

    const view = world.view(Position);
    const before = view.x as Float64Array;
    expect(before.length).toBe(16);

    /* Past the initial capacity of 16, so every column is reallocated. */
    for (let i = 0; i < 100; i += 1) {
      world.add(world.create(), Position, { x: i + 2 });
    }

    expect(view.x).not.toBe(before);
    expect(world.view(Position)).toBe(view);

    const at = (view.sparse as Int32Array)[first % 2 ** 26] as number;
    expect((view.x as Float64Array)[at]).toBe(1);
  });

  it('answers about columns that grew without the sparse array growing', () => {
    /*
     * **The case that made this test necessary.** `add` grows the columns and then the sparse
     * array, and refreshing after the second one rewrites every column too — so a store whose
     * sparse array happens to grow in the same call masks a missing refresh in the first. Removing
     * the refresh from column growth passed every other test in this file.
     *
     * Here the entities are all created first, so the sparse array is already wide enough and only
     * the columns grow. Nothing else refreshes the view.
     */
    const Position = defineComponent('LateAddPosition', { x: 'f64' });
    const world = new World();

    const entities: number[] = [];
    for (let i = 0; i < 300; i += 1) entities.push(world.create());

    /* One component, so the sparse array is sized for the whole range on the first add. */
    world.add(entities[299] as number, Position, { x: -1 });
    const view = world.view(Position);
    const before = view.x as Float64Array;
    const sparseBefore = view.sparse;

    for (let i = 0; i < 299; i += 1) world.add(entities[i] as number, Position, { x: i });

    expect(view.sparse).toBe(sparseBefore);
    expect(view.x).not.toBe(before);
    const at = view.sparse[(entities[150] as number) % 2 ** 26] as number;
    expect((view.x as Float64Array)[at]).toBe(150);
  });

  it('answers about the sparse array that exists now', () => {
    /* `sparse` is grown by its own path — a caller holding the old one would index an array that
       stops short of the entity it is looking for and read whatever is past the end. */
    const Position = defineComponent('SparsePosition', { x: 'f64' });
    const world = new World();
    const view = world.view(Position);
    const before = view.sparse;

    let last = 0;
    for (let i = 0; i < 200; i += 1) {
      last = world.create();
      world.add(last, Position, { x: i });
    }

    expect(view.sparse).not.toBe(before);
    const at = view.sparse[last % 2 ** 26] as number;
    expect((view.x as Float64Array)[at]).toBe(199);
  });

  it('carries an optional field presence column beside its value column', () => {
    const Follow = defineComponent({
      name: 'Follow',
      fields: [{ id: 'x::Follow::of', name: 'of', type: 'option:Entity' }],
    });
    const world = new World();
    const view = world.view(Follow);
    expect(view.of).toBeInstanceOf(Float64Array);
    expect(view['of$present']).toBeInstanceOf(Uint8Array);
  });
});
