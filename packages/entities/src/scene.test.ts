import { describe, expect, it } from 'vitest';
import { World } from './world.ts';
import { defineComponent } from './store.ts';
import { definePrefab, instantiate } from './prefab.ts';
import { deserializeWorld, serializeWorld } from './scene.ts';

const Health = defineComponent('PHealth', { current: 'f32', maximum: 'f32' });
const Perception = defineComponent('PPerception', { sightRange: 'f32' });
const Target = defineComponent('PTarget', { of: 'Entity' });

describe('a prefab', () => {
  const guard = definePrefab('guard', [
    [Health, { current: 100, maximum: 100 }],
    [Perception, { sightRange: 40 }],
  ]);

  it('writes every component it names into a fresh entity', () => {
    const world = new World();
    const spawned = instantiate(world, guard);

    expect(world.read(spawned, Health, 'current')).toBe(100);
    expect(world.read(spawned, Perception, 'sightRange')).toBe(40);
  });

  it('applies an override', () => {
    const world = new World();
    const spawned = instantiate(world, guard, { PPerception: { sightRange: 60 } });

    expect(world.read(spawned, Perception, 'sightRange')).toBe(60);
    expect(world.read(spawned, Health, 'current')).toBe(100);
  });

  /**
   * **An override key whose value is `undefined` is not an override.**
   *
   * A caller building one from optional data — `{ sightRange: config.range }` where the range may
   * be absent — means "leave it alone". A spread means "set it to nothing", and the component is
   * then written with `undefined` where a number belongs. Measured elsewhere in this repository as
   * the same shape taking a camera's arm to `NaN` on its first step; nothing in this repository's
   * typecheck can see it, because it does not run `exactOptionalPropertyTypes`.
   */
  it('leaves a field alone when its override is present and undefined', () => {
    const world = new World();
    const spawned = instantiate(world, guard, {
      PPerception: { sightRange: undefined } as Record<string, unknown>,
    });

    expect(world.read(spawned, Perception, 'sightRange')).toBe(40);
  });

  it('does not remember the override, and does not link back to the prefab', () => {
    /*
     * **A decision rather than a limitation.** A live link is what an *editor* wants, so that
     * changing a prefab changes every instance — and it costs every instance a record of which
     * fields it has overridden. Track K is what needs that, and it can add the record without
     * changing what a prefab is.
     */
    const world = new World();
    const a = instantiate(world, guard, { PPerception: { sightRange: 60 } });
    const b = instantiate(world, guard);

    expect(world.read(a, Perception, 'sightRange')).toBe(60);
    expect(world.read(b, Perception, 'sightRange')).toBe(40);
  });

  it('refuses an override naming a component the prefab does not have', () => {
    const world = new World();
    expect(() => instantiate(world, guard, { PTarget: { of: 0 } })).toThrow(/PTarget/);
  });
});

describe('a scene', () => {
  const populate = (world: World) => {
    /*
     * Churned first, on purpose. In a fresh world the first handle is 0 and the second is 1 —
     * which are also the scene indices — so a serializer that wrote the raw handle would look
     * correct. Three created and then all three destroyed leaves three slots free with their
     * generations moved on, so the handles that follow are large numbers. Creating and destroying
     * one at a time does **not** work: the free list is a queue of one and only slot zero is ever
     * recycled, which is how this test failed to separate them the first time.
     */
    const churn: number[] = [];
    for (let i = 0; i < 3; i += 1) churn.push(world.create());
    for (const spent of churn) world.destroy(spent);
    const a = world.create();
    const b = world.create();
    world.add(a, Health, { current: 30, maximum: 100 });
    world.add(b, Health, { current: 70, maximum: 100 });
    world.add(b, Perception, { sightRange: 12 });
    world.add(a, Target, { of: b });
    return { a, b };
  };

  it('round-trips a world', () => {
    const source = new World();
    const { a, b } = populate(source);
    const scene = serializeWorld(source, [Health, Perception, Target]);

    const loaded = new World();
    const result = deserializeWorld(loaded, scene, [Health, Perception, Target]);

    expect(result.loaded).toBe(true);
    if (!result.loaded) throw new Error(result.reason);
    expect(loaded.liveCount).toBe(2);
    const [first, second] = result.entities;
    expect(loaded.read(first as number, Health, 'current')).toBe(30);
    expect(loaded.read(second as number, Health, 'current')).toBe(70);
    expect(loaded.read(second as number, Perception, 'sightRange')).toBe(12);
    void a;
    void b;
  });

  it('names fields by id, so a rename or an insertion does not move them', () => {
    const source = new World();
    populate(source);
    const scene = serializeWorld(source, [Health]);

    const fields = Object.keys(scene.entities[0]?.components.PHealth ?? {});
    expect(fields).toEqual(['entities::PHealth::current', 'entities::PHealth::maximum']);
  });

  it('remaps entity references rather than preserving the handles', () => {
    /*
     * A saved entity's slot may be live in the world being loaded into, and a scene that assumed
     * its handles were free would overwrite whatever held them.
     */
    const source = new World();
    const { b } = populate(source);
    const scene = serializeWorld(source, [Health, Perception, Target]);

    const loaded = new World();
    /* Something already there, so the fresh handles cannot coincide with the saved ones. */
    for (let i = 0; i < 5; i += 1) loaded.create();
    const result = deserializeWorld(loaded, scene, [Health, Perception, Target]);
    if (!result.loaded) throw new Error(result.reason);

    const [first, second] = result.entities;
    /* The saved handle and the scene index are different numbers here, so this can tell them
       apart — see the churn in `populate`. */
    expect(b).not.toBe(1);
    expect(loaded.read(first as number, Target, 'of')).toBe(second);
    expect(loaded.read(first as number, Target, 'of')).not.toBe(b);
    expect(loaded.alive(loaded.read(first as number, Target, 'of') as number)).toBe(true);
  });

  it('loads a scene saved before a field was added, with the field at its default', () => {
    const source = new World();
    const Small = defineComponent('SceneSmall', { a: 'f32' });
    const entity = source.create();
    source.add(entity, Small, { a: 7 });
    const scene = serializeWorld(source, [Small]);

    /* The same component, grown. Its `a` keeps its id because an id is not a position. */
    const Grown = defineComponent('SceneSmall', { a: 'f32', b: 'f32' });
    const loaded = new World();
    const result = deserializeWorld(loaded, scene, [Grown]);
    if (!result.loaded) throw new Error(result.reason);

    expect(loaded.read(result.entities[0] as number, Grown, 'a')).toBe(7);
    expect(loaded.read(result.entities[0] as number, Grown, 'b')).toBe(0);
  });

  it('loads a scene saved before a field was removed, without it', () => {
    const source = new World();
    const Big = defineComponent('SceneBig', { a: 'f32', b: 'f32' });
    const entity = source.create();
    source.add(entity, Big, { a: 7, b: 9 });
    const scene = serializeWorld(source, [Big]);

    const Shrunk = defineComponent('SceneBig', { a: 'f32' });
    const loaded = new World();
    const result = deserializeWorld(loaded, scene, [Shrunk]);
    if (!result.loaded) throw new Error(result.reason);

    expect(loaded.read(result.entities[0] as number, Shrunk, 'a')).toBe(7);
  });

  it('refuses a field whose type changed, naming it, rather than coercing', () => {
    const source = new World();
    const Numeric = defineComponent('SceneTyped', { v: 'f32' });
    source.add(source.create(), Numeric, { v: 7 });
    const scene = serializeWorld(source, [Numeric]);

    const Textual = defineComponent('SceneTyped', { v: 'String' });
    const loaded = new World();
    const result = deserializeWorld(loaded, scene, [Textual]);

    expect(result.loaded).toBe(false);
    if (result.loaded) throw new Error('expected a refusal');
    expect(result.reason).toContain('v');
    expect(loaded.liveCount).toBe(0);
  });

  it('refuses a scene naming a component type the caller did not supply', () => {
    const source = new World();
    source.add(source.create(), Health, { current: 1, maximum: 1 });
    const scene = serializeWorld(source, [Health]);

    const result = deserializeWorld(new World(), scene, []);
    expect(result.loaded).toBe(false);
    if (result.loaded) throw new Error('expected a refusal');
    expect(result.reason).toContain('PHealth');
  });

  it('writes nothing into the world when it refuses', () => {
    const source = new World();
    const Numeric = defineComponent('SceneAtomic', { v: 'f32' });
    for (let i = 0; i < 5; i += 1) source.add(source.create(), Numeric, { v: i });
    const scene = serializeWorld(source, [Numeric]);

    const Textual = defineComponent('SceneAtomic', { v: 'String' });
    const loaded = new World();
    deserializeWorld(loaded, scene, [Textual]);

    expect(loaded.liveCount).toBe(0);
  });

  it('costs about eight times as much for eight times as many, rather than sixty-four', () => {
    /*
     * **A ratio, not a threshold**, because a threshold is a fact about the machine and this is a
     * fact about the algorithm. Multiplying the entities by eight multiplies a linear cost by eight
     * and a quadratic one by sixty-four.
     *
     * **The two sizes are far apart on purpose, and that matters more than making them large.**
     * At 2x the hypotheses are 2 and 4, so a ceiling sits halfway between them and a scheduling
     * hiccup inside one measurement crosses it — this failed about one run in five at 4,000/8,000
     * and about one in six at 20,000/40,000, because raising the counts raises the work *and* the
     * window a hiccup can land in. At 8x they are 8 and 64, and the measured quadratic version
     * comes in at 97.8 against a ceiling of 20.
     *
     * What it caught: the entity list was built with `Array.includes` as its membership test, which
     * is a linear scan per entity. A hundred thousand entities across three components took **8.8
     * seconds**; with a `Set` it is 74 milliseconds. It reads as obviously correct — the list is
     * the thing being built, so testing it is the natural move — and the cost is invisible until
     * the world is large.
     */
    const fill = (n: number): World => {
      const world = new World();
      for (let i = 0; i < n; i += 1) world.add(world.create(), Health, { current: i, maximum: i });
      return world;
    };
    /* **Best of three**, because a single timing is a fact about what else the machine was doing.
       A scheduling hiccup inside one measurement is exactly what makes a ratio test flaky, and the
       minimum is the reading least contaminated by one. */
    const measure = (world: World): number => {
      let best = Infinity;
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now();
        serializeWorld(world, [Health]);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    /*
     * **Eight times the entities rather than two, and the margin is the whole change.**
     *
     * At 2x, linear costs 2 and quadratic costs 4 — a ceiling of 3 sits halfway between them, and
     * a scheduling hiccup inside one measurement crosses it. This test failed about one full-suite
     * run in six on 2026-08-26 despite best-of-three, and had already been raised once from
     * 4,000/8,000 for the same reason. Raising the counts again buys nothing: doubling the work
     * doubles the window a hiccup can land in.
     *
     * At 8x the two hypotheses are 8 and 64. A ceiling of 20 is more than twice the linear cost
     * and less than a third of the quadratic one, so noise would have to more than double a
     * measurement to reach it — and the test still fails on a quadratic serialize by a factor of
     * three. That is a wider *separation*, not a weaker assertion.
     */
    const small = fill(10_000);
    const large = fill(80_000);
    /* Warmed together so neither pays for the other's first run. */
    measure(small);
    measure(large);

    const ratio = Math.max(measure(large), 0.05) / Math.max(measure(small), 0.05);
    expect(
      ratio,
      'eight times the entities should cost about eight times as much, not sixty-four',
    ).toBeLessThan(20);
  });

  it('round-trips through JSON, which is what a save file is', () => {
    const source = new World();
    populate(source);
    const scene = serializeWorld(source, [Health, Perception, Target]);

    const loaded = new World();
    const result = deserializeWorld(loaded, JSON.parse(JSON.stringify(scene)), [
      Health,
      Perception,
      Target,
    ]);

    expect(result.loaded).toBe(true);
    expect(loaded.liveCount).toBe(2);
  });
});
