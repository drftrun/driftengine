import { describe, expect, it } from 'vitest';
import { World, buildSchedule, defineComponent, runSchedule } from '@driftengine/entities';
import { entitiesImplementation } from './entities.ts';

const Hunger = defineComponent('QHunger', { value: 'f64' });
const Health = defineComponent('QHealth', { current: 'f64' });
const Dead = defineComponent('QDead', { at: 'f64' });

const ecs = entitiesImplementation({
  components: new Map([
    ['Hunger', Hunger],
    ['Health', Health],
    ['Dead', Dead],
  ]),
}) as {
  query: (w: unknown, a: string, b?: string, c?: string, d?: string) => unknown;
  without: (cursor: unknown, component: string) => void;
  next: (cursor: unknown) => number;
  view: (w: unknown, component: string, forWriting: boolean) => Record<string, unknown>;
};

describe('the four capabilities a query loop is built on', () => {
  it('walks every entity carrying the component, then ends on a negative', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    world.add(a, Hunger, { value: 1 });
    world.add(b, Hunger, { value: 2 });

    const cursor = ecs.query(world, 'Hunger');
    const seen = [ecs.next(cursor), ecs.next(cursor)];
    expect(seen.sort()).toEqual([a, b].sort());
    expect(ecs.next(cursor)).toBeLessThan(0);
  });

  it('ends below zero rather than at it, because zero is a legal handle', () => {
    /* The first entity a fresh world allocates is handle 0. A sentinel of 0 would end the walk on
       the very first entity of every world, which reads as an empty query. */
    const world = new World();
    const first = world.create();
    expect(first).toBe(0);
    world.add(first, Hunger, { value: 1 });

    const cursor = ecs.query(world, 'Hunger');
    expect(ecs.next(cursor)).toBe(0);
    expect(ecs.next(cursor)).toBeLessThan(0);
  });

  it('gives the cursor back when the walk ends, so a loop does not leak one', () => {
    const world = new World();
    world.add(world.create(), Hunger, { value: 1 });

    const cursor = ecs.query(world, 'Hunger');
    expect(world.cursorsInUse).toBe(1);
    while (ecs.next(cursor) >= 0) {
      /* drain */
    }
    expect(world.cursorsInUse).toBe(0);
  });

  it('narrows an open walk with `without`', () => {
    const world = new World();
    const alive = world.create();
    const gone = world.create();
    world.add(alive, Hunger, { value: 1 });
    world.add(gone, Hunger, { value: 2 });
    world.add(gone, Dead, { at: 0 });

    const cursor = ecs.query(world, 'Hunger');
    ecs.without(cursor, 'Dead');
    expect(ecs.next(cursor)).toBe(alive);
    expect(ecs.next(cursor)).toBeLessThan(0);
  });

  it('hands back the store’s live columns, indexable by sparse', () => {
    const world = new World();
    const e = world.create();
    world.add(e, Hunger, { value: 7 });

    const view = ecs.view(world, 'Hunger', true);
    const at = (view.sparse as Int32Array)[e % 2 ** 26] as number;
    expect((view.value as Float64Array)[at]).toBe(7);
  });

  it('refuses a component the host never registered, naming what it has', () => {
    const world = new World();
    expect(() => ecs.query(world, 'Nothing')).toThrow(/Nothing/);
    expect(() => ecs.query(world, 'Nothing')).toThrow(/Hunger/);
  });

  it('passes `forWriting` through, so a declared read cannot be taken as a write', () => {
    /*
     * **The seam the design calls the one where a mistake disables every declaration in the track.**
     * A test asking for an *undeclared* component is refused whether or not `forWriting` is honoured
     * — which is why the case below passed with the flag hardcoded to `false`. The case that
     * separates them is a component the system declared as `reads` and the loop asks to write.
     */
    const world = new World();
    world.add(world.create(), Hunger, { value: 1 });

    let asRead = 'not tried';
    let asWrite = 'not tried';
    const schedule = buildSchedule([
      {
        name: 'reader',
        reads: [Hunger],
        run(view) {
          try {
            ecs.view(view, 'Hunger', false);
            asRead = 'allowed';
          } catch (error) {
            asRead = (error as Error).message;
          }
          try {
            ecs.view(view, 'Hunger', true);
            asWrite = 'allowed';
          } catch (error) {
            asWrite = (error as Error).message;
          }
        },
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(asRead).toBe('allowed');
    expect(asWrite).toContain('QHunger');
    expect(asWrite).not.toBe('allowed');
  });

  it('runs the same calls against a system view, so declarations still apply', () => {
    /*
     * The reason `query` and `view` take a structural source rather than a `World`. Inside a
     * system the generated code is handed the schedule's view, and every declaration check the
     * engine makes still runs — the same bytes, a different receiver.
     */
    const world = new World();
    world.add(world.create(), Hunger, { value: 1 });

    let readable = 0;
    let refused = '';
    const schedule = buildSchedule([
      {
        name: 'reader',
        reads: [Hunger],
        run(view) {
          const cursor = ecs.query(view, 'Hunger');
          while (ecs.next(cursor) >= 0) readable += 1;
          try {
            ecs.view(view, 'Health', false);
          } catch (error) {
            refused = (error as Error).message;
          }
        },
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(readable).toBe(1);
    expect(refused).toContain('QHealth');
  });
});
