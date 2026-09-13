import { describe, expect, it } from 'vitest';
import { World } from './world.ts';
import { defineComponent } from './store.ts';

const Position = defineComponent('WPosition', { x: 'f32', y: 'f32' });
const Velocity = defineComponent('WVelocity', { dx: 'f32', dy: 'f32' });
const Dead = defineComponent('WDead', {});

describe('a world', () => {
  it('creates entities and knows they are alive', () => {
    const world = new World();
    const a = world.create();

    expect(world.alive(a)).toBe(true);
    expect(world.liveCount).toBe(1);
  });

  it('forgets a destroyed entity from every store it was in', () => {
    /* The one thing a world adds over a bag of stores: an entity that is gone is gone from all of
       them, so a query cannot yield something that no longer exists. */
    const world = new World();
    const a = world.create();
    world.add(a, Position, { x: 1, y: 2 });
    world.add(a, Velocity, { dx: 1, dy: 1 });

    world.destroy(a);

    expect(world.alive(a)).toBe(false);
    expect(world.store(Position).has(a)).toBe(false);
    expect(world.store(Velocity).has(a)).toBe(false);
  });

  it('refuses to add a component to something that is not alive', () => {
    /* Silently storing it would leave a component keyed to a handle nothing can reach, which a
       query would then have to skip and a scene would serialise. */
    const world = new World();
    const a = world.create();
    world.destroy(a);

    expect(() => world.add(a, Position, { x: 1, y: 1 })).toThrow(/not alive/);
  });

  it('makes one store per component type, however often it is asked for', () => {
    const world = new World();
    expect(world.store(Position)).toBe(world.store(Position));
  });

  it('holds a component with no fields at all, which is what a marker is', () => {
    const world = new World();
    const a = world.create();
    world.add(a, Dead);

    expect(world.has(a, Dead)).toBe(true);
    world.remove(a, Dead);
    expect(world.has(a, Dead)).toBe(false);
  });
});

describe('a query', () => {
  const populate = (world: World, n: number) => {
    const made: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const entity = world.create();
      made.push(entity);
      world.add(entity, Position, { x: i, y: i });
      if (i % 2 === 0) world.add(entity, Velocity, { dx: 1, dy: 1 });
      if (i % 10 === 0) world.add(entity, Dead);
    }
    return made;
  };

  it('yields exactly the entities that have every component named', () => {
    const world = new World();
    populate(world, 20);

    const found = [...world.query(Position, Velocity)];
    expect(found).toHaveLength(10);
    for (const entity of found) {
      expect(world.has(entity, Position)).toBe(true);
      expect(world.has(entity, Velocity)).toBe(true);
    }
  });

  it('excludes with `without` and requires with `with`', () => {
    const world = new World();
    populate(world, 20);

    expect([...world.query(Position, Velocity).without(Dead)]).toHaveLength(8);
    expect([...world.query(Position).with(Dead)]).toHaveLength(2);
  });

  it('walks the smallest set, counted rather than timed', () => {
    /*
     * A timing test here passes on a fast machine with the wrong array chosen. Counting the
     * membership tests is what actually sees it: walking the 10,000-entity store would ask about
     * every one of them, and walking the 5-entity store asks five times.
     */
    const world = new World();
    for (let i = 0; i < 10_000; i += 1) world.add(world.create(), Position, { x: i, y: i });
    for (let i = 0; i < 5; i += 1) {
      const entity = world.create();
      world.add(entity, Position, { x: 0, y: 0 });
      world.add(entity, Velocity, { dx: 0, dy: 0 });
    }

    const big = world.store(Position);
    let asked = 0;
    const real = big.has.bind(big);
    big.has = (entity: number) => {
      asked += 1;
      return real(entity);
    };

    const found = [...world.query(Position, Velocity)];

    expect(found).toHaveLength(5);
    expect(asked).toBeLessThanOrEqual(5);
  });

  it('allocates nothing per iteration', async () => {
    /*
     * Counted by garbage collections, never by `heapUsed` — which reads the live heap, so garbage
     * made and dropped does not move it. The control allocates one object per iteration; the
     * assertion is the separation, not either number.
     */
    const world = new World();
    for (let i = 0; i < 1000; i += 1) {
      const entity = world.create();
      world.add(entity, Position, { x: i, y: i });
      world.add(entity, Velocity, { dx: 1, dy: 1 });
    }

    const collections = async (work: () => void): Promise<number> => {
      let n = 0;
      const observer = new PerformanceObserver((list) => {
        n += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['gc'] });
      work();
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return n;
    };

    let sink: unknown;
    let total = 0;
    const ROUNDS = 2000;
    /* The control first, so it collects whatever earlier work left in the young generation. */
    const noisy = await collections(() => {
      for (let i = 0; i < ROUNDS * 1000; i += 1) sink = { at: i, of: [i] };
    });
    const quiet = await collections(() => {
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const entity of world.query(Position, Velocity)) total += entity;
      }
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(total).toBeGreaterThan(0);
    expect(sink).not.toBe(undefined);
  });

  it('allocates nothing per query call either, not only per step', async () => {
    /*
     * **The iteration test above could not see this**, and that is why there are two. It ran two
     * thousand loops over a thousand entities, so a few objects per *call* were three thousand
     * allocations against a control's two million — invisible inside the margin. This calls the
     * query half a million times and steps it once, so the per-call cost is the only cost there is.
     *
     * What it caught when it was written: `query(...types)` allocated an array for its rest
     * parameter and a closure for the release, once per system per frame.
     */
    const world = new World();
    const lonely = world.create();
    world.add(lonely, Position, { x: 0, y: 0 });

    const collections = async (work: () => void): Promise<number> => {
      let n = 0;
      const observer = new PerformanceObserver((list) => {
        n += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['gc'] });
      work();
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return n;
    };

    const CALLS = 500_000;
    let sink: unknown;
    /* Two objects per call, which is what the rest array and the closure were. */
    const noisy = await collections(() => {
      for (let i = 0; i < CALLS; i += 1) sink = [{ at: i }, [i]];
    });
    let seen = 0;
    const quiet = await collections(() => {
      for (let i = 0; i < CALLS; i += 1) {
        for (const entity of world.query(Position, Velocity)) seen += entity;
      }
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(seen).toBe(0);
    expect(sink).not.toBe(undefined);
  });

  it('gives two open queries different cursors', () => {
    const world = new World();
    populate(world, 6);

    const outer: number[] = [];
    for (const a of world.query(Position, Velocity)) {
      for (const b of world.query(Position, Velocity)) outer.push(a * 1000 + b);
    }

    expect(outer).toHaveLength(9);
  });

  it('gives a cursor back when a loop breaks early, rather than leaking it', () => {
    const world = new World();
    populate(world, 100);

    const before = world.cursorsInUse;
    for (const entity of world.query(Position)) {
      if (entity !== 0) break;
    }

    expect(world.cursorsInUse).toBe(before);
  });
});
