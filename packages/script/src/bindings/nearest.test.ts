import { describe, expect, it } from 'vitest';
import { World, defineComponent } from '@driftengine/entities';
import { entitiesImplementation } from './entities.ts';

const Position = defineComponent('NWPosition', { x: 'f64', y: 'f64', z: 'f64' });
const Marker = defineComponent('NWMarker', { value: 'f64' });

const ecs = entitiesImplementation({
  components: new Map([
    ['Position', Position],
    ['Marker', Marker],
  ]),
}) as {
  findNearest: (
    w: unknown,
    component: string,
    fieldX: string,
    fieldY: string,
    fieldZ: string,
    x: number,
    y: number,
    z: number,
    radius: number,
  ) => boolean;
  nearest: (w: unknown) => number;
};

/** Search, then read — the two halves a handle-typed result costs. */
const search = (world: unknown, x: number, y: number, z: number, radius: number) => {
  const hit = ecs.findNearest(world, 'Position', 'x', 'y', 'z', x, y, z, radius);
  return { hit, entity: ecs.nearest(world) };
};

/** A world with three positioned entities, at 1, 5 and 20 metres along x. */
const populated = () => {
  const world = new World();
  const near = world.create();
  const middle = world.create();
  const far = world.create();
  world.add(near, Position, { x: 1, y: 0, z: 0 });
  world.add(middle, Position, { x: 5, y: 0, z: 0 });
  world.add(far, Position, { x: 20, y: 0, z: 0 });
  return { world, near, middle, far };
};

describe('the nearest entity within a radius', () => {
  it('finds the closest one inside the radius', () => {
    const { world, near } = populated();
    expect(search(world, 0, 0, 0, 10)).toEqual({ hit: true, entity: near });
  });

  it('ignores anything outside the radius, and the radius is a sphere', () => {
    const { world, middle } = populated();
    /* Measured from (9, 0, 0): the entity at 5 is four metres away and the one at 1 is eight, so a
       radius of five must take the middle one and not the nearer-to-origin one. */
    expect(search(world, 9, 0, 0, 5)).toEqual({ hit: true, entity: middle });
  });

  it('answers false when nothing is near, which is the only honest test', () => {
    /*
     * **Why the result is a boolean and not a sentinel.** Once the answer is an `Entity` there is no
     * value left to mean "nothing": zero is a legal handle — the first one a fresh world allocates —
     * and a handle is not a number a script can compare to −1, which is the point of it having its
     * own type.
     */
    const { world } = populated();
    expect(ecs.findNearest(world, 'Position', 'x', 'y', 'z', 500, 0, 0, 1)).toBe(false);
  });

  it('answers false for a component nobody has', () => {
    const world = new World();
    expect(ecs.findNearest(world, 'Position', 'x', 'y', 'z', 0, 0, 0, 10)).toBe(false);
  });

  it('answers a negative for a field the component does not have, rather than throwing', () => {
    /* A frame loop may not throw, and a component whose author named the wrong field is a mistake
       that should read as "nothing was near" rather than stopping the tick. A misspelled
       *component* still throws, because that is caught at `resolve` and is not this case. */
    const { world } = populated();
    expect(ecs.findNearest(world, 'Position', 'x', 'y', 'height', 0, 0, 0, 10)).toBe(false);
  });

  it('refuses a component this host never registered', () => {
    /* The silent no-op rule: reading zeroes out of a name nobody registered would run, report
       success and be wrong. */
    const { world } = populated();
    expect(() => ecs.findNearest(world, 'Nope', 'x', 'y', 'z', 0, 0, 0, 10)).toThrow(/Nope/);
  });

  it('measures in three dimensions rather than on the ground plane', () => {
    const world = new World();
    const above = world.create();
    world.add(above, Position, { x: 0, y: 30, z: 0 });
    expect(ecs.findNearest(world, 'Position', 'x', 'y', 'z', 0, 0, 0, 10)).toBe(false);
    expect(search(world, 0, 0, 0, 40)).toEqual({ hit: true, entity: above });
  });

  it('allocates nothing per call, which is what makes it callable every frame', () => {
    /* The reason this returns a handle rather than an option. `some(entity)` is one object per
       call, and an agent looking around once a frame is the per-frame allocation the engine
       forbids — the same call `next` makes. */
    const { world } = populated();
    const before = search(world, 0, 0, 0, 10);
    for (let i = 0; i < 1000; i += 1)
      ecs.findNearest(world, 'Position', 'x', 'y', 'z', 0, 0, 0, 10);
    expect(search(world, 0, 0, 0, 10)).toEqual(before);
    expect(typeof before.entity).toBe('number');
  });
});
