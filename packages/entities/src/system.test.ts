import { describe, expect, it } from 'vitest';
import { World } from './world.ts';
import { defineComponent } from './store.ts';
import { buildSchedule, runSchedule } from './schedule.ts';

const Hunger = defineComponent('SHunger', { value: 'f32' });
const Health = defineComponent('SHealth', { value: 'f32' });
const Mark = defineComponent('SMark', {});

/**
 * What `runSchedule` said about a failing system, as one line.
 *
 * **The refusals below used to be asserted as a throw out of `runSchedule`, and are asserted on the
 * message now**, because a system's failure stopped taking the rest of the tick down on 2026-08-28.
 * The rule they are about has not moved a millimetre: an undeclared touch is refused, the refusal
 * names the system and the component, and the system's work does not happen. What changed is where a
 * caller reads it — see `runSchedule` for what the old vehicle cost somebody.
 */
const refusalOf = (world: World, schedule: Parameters<typeof runSchedule>[1]): string => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => void lines.push(String(args[0]));
  try {
    runSchedule(world, schedule, 0);
  } finally {
    console.error = original;
  }
  return lines.join('\n');
};

describe('what a system may touch', () => {
  it('reads and writes what it declared', () => {
    const world = new World();
    const a = world.create();
    world.add(a, Hunger, { value: 1 });

    const schedule = buildSchedule([
      {
        name: 'hunger',
        reads: [Hunger],
        writes: [Hunger],
        run(view) {
          for (const entity of view.query(Hunger)) {
            view.write(entity, Hunger, 'value', (view.read(entity, Hunger, 'value') as number) + 1);
          }
        },
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(world.read(a, Hunger, 'value')).toBe(2);
  });

  it('refuses a write it did not declare, naming both', () => {
    /* The declaration earns its place by being enforced. A schedule derived from a lie is worse
       than no schedule. */
    const world = new World();
    const a = world.create();
    world.add(a, Health, { value: 1 });

    const schedule = buildSchedule([
      {
        name: 'hunger',
        reads: [Hunger],
        writes: [Hunger],
        run(view) {
          view.write(a, Health, 'value', 0);
        },
      },
    ]);

    const refusal = refusalOf(world, schedule);
    expect(refusal).toMatch(/hunger/);
    expect(refusal).toMatch(/SHealth/);
    expect(world.read(a, Health, 'value'), 'and the write did not happen').toBe(1);
  });

  it('refuses a read it did not declare', () => {
    const world = new World();
    const a = world.create();
    world.add(a, Health, { value: 1 });

    const schedule = buildSchedule([
      { name: 's', reads: [Hunger], writes: [], run: (view) => void view.read(a, Health, 'value') },
    ]);

    expect(refusalOf(world, schedule)).toMatch(/SHealth/);
  });

  it('lets a declared write be read without declaring the read as well', () => {
    /* Writing a component you cannot read is a system that can only overwrite, which nothing
       wants. `writes` implies `reads`, and saying so is cheaper than making every author write
       both. */
    const world = new World();
    const a = world.create();
    world.add(a, Hunger, { value: 3 });

    let seen = 0;
    const schedule = buildSchedule([
      {
        name: 's',
        writes: [Hunger],
        run: (view) => void (seen = view.read(a, Hunger, 'value') as number),
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(seen).toBe(3);
  });

  it('accepts a system that declares more than it touches', () => {
    /* Over-declaring is conservative: it only costs schedule width, so it is not worth refusing. */
    const world = new World();
    const schedule = buildSchedule([
      { name: 's', reads: [Hunger, Health], writes: [Mark], run: () => undefined },
    ]);

    expect(() => runSchedule(world, schedule, 0)).not.toThrow();
  });

  it('refuses a query over something undeclared, where the read would have happened', () => {
    const world = new World();
    const schedule = buildSchedule([
      { name: 's', reads: [Hunger], writes: [], run: (view) => void [...view.query(Health)] },
    ]);

    expect(refusalOf(world, schedule)).toMatch(/SHealth/);
  });
});

describe('structural change from inside a system', () => {
  it('defers a destroy, so a query cannot skip the entity swapped into the hole', () => {
    /*
     * A removal is a swap of the last entry into the hole. Doing it mid-walk moves an entity the
     * cursor has already passed into a position it has already visited, so that entity is **never
     * seen** — silently, and only for whichever entity happened to be last.
     */
    const world = new World();
    const made: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const entity = world.create();
      made.push(entity);
      world.add(entity, Hunger, { value: i });
    }

    const seen: number[] = [];
    const schedule = buildSchedule([
      {
        name: 'reaper',
        writes: [Hunger],
        run(view) {
          for (const entity of view.query(Hunger)) {
            seen.push(entity);
            view.destroy(entity);
          }
        },
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(seen).toHaveLength(10);
    expect(world.liveCount).toBe(0);
  });

  it('creates immediately, and says a new entity may be seen in the same pass', () => {
    const world = new World();
    const schedule = buildSchedule([
      {
        name: 'spawner',
        writes: [Mark],
        run(view) {
          const made = view.create();
          view.add(made, Mark);
        },
      },
    ]);
    runSchedule(world, schedule, 0);

    expect(world.liveCount).toBe(1);
  });
});

describe('the schedule', () => {
  const noop = () => undefined;

  it('runs systems in declaration order', () => {
    const order: string[] = [];
    const schedule = buildSchedule([
      { name: 'a', run: () => order.push('a') },
      { name: 'b', run: () => order.push('b') },
      { name: 'c', run: () => order.push('c') },
    ]);
    runSchedule(new World(), schedule, 0);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by declaration order and not by name', () => {
    /*
     * Named backwards on purpose. With `a`, `b`, `c` the two rules agree and the test cannot tell
     * them apart — which is exactly what happened when this was written the obvious way, and a
     * perturbation that sorted by name passed.
     */
    const order: string[] = [];
    const schedule = buildSchedule([
      { name: 'z', run: () => order.push('z') },
      { name: 'y', run: () => order.push('y') },
      { name: 'x', run: () => order.push('x') },
    ]);
    runSchedule(new World(), schedule, 0);

    expect(order).toEqual(['z', 'y', 'x']);
  });

  it('honours an explicit `after`, and breaks ties by declaration order', () => {
    const order: string[] = [];
    const schedule = buildSchedule([
      { name: 'z', after: ['x'], run: () => order.push('z') },
      { name: 'y', run: () => order.push('y') },
      { name: 'x', run: () => order.push('x') },
    ]);
    runSchedule(new World(), schedule, 0);

    /* `y` first because it is declared before `x` and is ready; `z` last because it waits. */
    expect(order).toEqual(['y', 'x', 'z']);
  });

  it('refuses a cycle in `after`, naming both systems', () => {
    expect(() =>
      buildSchedule([
        { name: 'a', after: ['b'], run: noop },
        { name: 'b', after: ['a'], run: noop },
      ]),
    ).toThrow(/a.*b|b.*a/);
  });

  it('refuses an `after` naming a system nothing declares', () => {
    expect(() => buildSchedule([{ name: 'a', after: ['ghost'], run: noop }])).toThrow(/ghost/);
  });

  it('refuses two systems of one name, because `after` addresses them by it', () => {
    expect(() =>
      buildSchedule([
        { name: 'a', run: noop },
        { name: 'a', run: noop },
      ]),
    ).toThrow(/more than once/);
  });

  it('produces the same order on every build, which is what a replay needs', () => {
    const define = () => [
      { name: 'a', after: ['c'], run: noop },
      { name: 'b', run: noop },
      { name: 'c', run: noop },
    ];
    expect(buildSchedule(define()).order.map((s) => s.name)).toEqual(
      buildSchedule(define()).order.map((s) => s.name),
    );
  });

  it('strides the fixed step, and lands on the same tick every run', () => {
    /*
     * A rate in wall-clock seconds leaves the determinism contract on its first dropped frame: two
     * runs of the same recording would run the system a different number of times. A stride over
     * fixed ticks cannot, because the tick count is the same in every replay of the same input.
     */
    const ran: number[] = [];
    const schedule = buildSchedule([{ name: 'slow', everyTicks: 60, run: () => ran.push(-1) }]);
    const world = new World();
    for (let tick = 0; tick < 121; tick += 1) {
      ran.length = 0;
      runSchedule(world, schedule, tick);
      if (ran.length > 0) ran[0] = tick;
      if (ran.length > 0) expect(tick % 60).toBe(0);
    }

    let count = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      const before = count;
      runSchedule(
        world,
        buildSchedule([{ name: 's', everyTicks: 60, run: () => (count += 1) }]),
        tick,
      );
      if (count !== before) expect(tick % 60).toBe(0);
    }
    expect(count).toBe(2);
  });

  it('reports which adjacent systems could run together, without running them that way', () => {
    /*
     * The declarations' other payoff, and it is *reported* rather than taken: running two systems
     * in workers means transferring or sharing component storage, which is a decision about
     * `SharedArrayBuffer` and a consumer's deployment rather than about scheduling.
     */
    const schedule = buildSchedule([
      { name: 'a', writes: [Hunger], run: noop },
      { name: 'b', writes: [Health], run: noop },
      { name: 'c', reads: [Hunger], run: noop },
    ]);

    expect(schedule.groups.map((g) => g.map((s) => s.name))).toEqual([['a', 'b'], ['c']]);
  });
});

describe('a view is checked before it is handed out', () => {
  /*
   * The seam this whole mechanism turns on. Every other accessor on a bound system checks a
   * declaration before it answers; a view that went straight to the store would hand a caller the
   * raw columns of a component its system never declared — after which `reads` and `writes` are
   * reachable around rather than through, and the schedule derived from them means nothing.
   */
  const caughtFrom = (definition: {
    name: string;
    reads?: readonly ReturnType<typeof defineComponent>[];
    writes?: readonly ReturnType<typeof defineComponent>[];
    run: (view: Parameters<Parameters<typeof buildSchedule>[0][number]['run']>[0]) => void;
  }): string => {
    let caught = '';
    const world = new World();
    const schedule = buildSchedule([
      {
        ...definition,
        run(view) {
          try {
            definition.run(view);
          } catch (error) {
            caught = (error as Error).message;
          }
        },
      },
    ]);
    runSchedule(world, schedule, 0);
    return caught;
  };

  it('refuses a writable view of a component declared only as read', () => {
    const message = caughtFrom({
      name: 'reader',
      reads: [Hunger],
      run: (view) => void view.view(Hunger, true),
    });
    expect(message).toContain('SHunger');
    expect(message).toContain('reader');
  });

  it('refuses any view of a component that was not declared at all', () => {
    const message = caughtFrom({
      name: 'reader',
      reads: [Hunger],
      run: (view) => void view.view(Health, false),
    });
    expect(message).toContain('SHealth');
  });

  it('allows a readable view of a component declared only as written, because writes imply reads', () => {
    const message = caughtFrom({
      name: 'writer',
      writes: [Hunger],
      run: (view) => void view.view(Hunger, false),
    });
    expect(message).toBe('');
  });

  it('hands back the live columns when the declaration allows it', () => {
    let columns: unknown = null;
    const world = new World();
    const e = world.create();
    world.add(e, Hunger, { value: 3 });
    const schedule = buildSchedule([
      {
        name: 'writer',
        writes: [Hunger],
        run: (view) => {
          columns = view.view(Hunger, true);
        },
      },
    ]);
    runSchedule(world, schedule, 0);
    expect(columns).toBe(world.view(Hunger));
  });
});

/**
 * **What a throwing system takes down with it, reported from outside 2026-08-28.**
 *
 * A system that touches a component it did not declare throws — which is right, since a schedule
 * derived from a lie is worse than no schedule — and until now the throw left `runSchedule`, so
 * **every system after it in that tick never ran**. Once per tick, for as long as the game was up,
 * with the only evidence a console line.
 *
 * The reporter found it from play: the system that stopped was the one stepping their vehicle, and
 * the symptom was a car moving in jerks. The declaration mistake was three systems earlier. That is
 * the shape this contains: a broken system must not be able to silently starve its neighbours, and
 * `AGENTS.md` has said since it was written that the frame loop does not throw after boot.
 */
describe('a system that throws', () => {
  it('does not stop the systems scheduled after it', () => {
    const world = new World();
    const a = world.create();
    world.add(a, Health, { value: 1 });

    const reached: string[] = [];
    const schedule = buildSchedule([
      {
        name: 'undeclared',
        run(view) {
          reached.push('undeclared');
          /* The reported shape exactly: a query naming a component the system never declared. */
          view.query(Health);
        },
      },
      {
        name: 'after',
        writes: [Health],
        run(view) {
          reached.push('after');
          view.write(a, Health, 'value', 2);
        },
      },
    ]);

    expect(() => runSchedule(world, schedule, 0)).not.toThrow();
    expect(reached).toEqual(['undeclared', 'after']);
    expect(world.read(a, Health, 'value'), 'the later system did its work').toBe(2);
  });

  /**
   * Said once and not once a tick. A declaration error repeats every step by construction, and a
   * line per tick at sixty hertz is a console nobody can read — which is the same reason
   * `DebugLines` counts a dropped segment instead of throwing.
   */
  it('is reported once, however many ticks it fails on', () => {
    const world = new World();
    const seen: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      seen.push(args[0]);
    };
    try {
      const schedule = buildSchedule([
        {
          name: 'undeclared',
          run(view) {
            view.query(Mark);
          },
        },
      ]);
      for (let tick = 0; tick < 5; tick += 1) runSchedule(world, schedule, tick);
    } finally {
      console.error = original;
    }
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('undeclared');
    expect(String(seen[0]), 'and it names what the system failed to do').toContain('SMark');
  });

  it('reports each failing system on its own, so one does not mask another', () => {
    const world = new World();
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      seen.push(String(args[0]));
    };
    try {
      const schedule = buildSchedule([
        { name: 'first', run: (view) => void view.query(Mark) },
        { name: 'second', run: (view) => void view.query(Health) },
      ]);
      runSchedule(world, schedule, 0);
      runSchedule(world, schedule, 1);
    } finally {
      console.error = original;
    }
    expect(seen).toHaveLength(2);
    expect(seen.some((line) => line.includes('first'))).toBe(true);
    expect(seen.some((line) => line.includes('second'))).toBe(true);
  });
});
