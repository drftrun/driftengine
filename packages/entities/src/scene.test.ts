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

  it('COSTS THE SAME FOR ONE BIG WORLD AS FOR EIGHT SMALL ONES, which quadratic would not', () => {
    /*
     * **A ratio between two measurements that allocate the same amount, which is the third shape
     * this test has taken.** What it is for has not changed: `serializeWorld` built its entity list
     * with `Array.includes` as the membership test, a linear scan per entity, and a hundred
     * thousand entities across three components took **8.8 seconds** where a `Set` takes 74
     * milliseconds. It reads as obviously correct — the list is the thing being built, so testing
     * it is the natural move — and the cost is invisible until the world is large.
     *
     * **The two shapes before this one were timing comparisons that flaked, and raising the numbers
     * did not fix it.** 4,000 against 8,000 failed about one run in five; 10,000 against 80,000,
     * with best-of-three and eight times the separation, still failed **two full-suite runs in six**
     * on 2026-09-17 while other work shared the machine. The reason is not noise: the large arm
     * allocated eight times as much as the small one, so a major collection was eight times likelier
     * to land inside the measurement that was being compared *against*. A bias, not a hiccup, and
     * more rounds do not average it away.
     *
     * **So both arms do the same work and allocate the same amount**, and the only thing that
     * differs is how many entities are in one world. Forty thousand entities either way: once as a
     * single world, and once as eight worlds of five thousand serialized in a row. A linear
     * algorithm cannot tell the difference. A quadratic one does 40,000² against 8 × 5,000², which
     * is eight times as much.
     *
     * Measured on 2026-09-17: **1.00 to 1.27 linear, 6.78 to 7.26 quadratic.** The ceiling of three
     * sits about two and a half times above the one and two and a half times below the other, and
     * a collection now lands in whichever arm it likes.
     */
    const fill = (n: number): World => {
      const world = new World();
      for (let i = 0; i < n; i += 1) world.add(world.create(), Health, { current: i, maximum: i });
      return world;
    };
    const TOTAL = 40_000;
    const PARTS = 8;
    const one = fill(TOTAL);
    const many = Array.from({ length: PARTS }, () => fill(TOTAL / PARTS));

    /* Best of three, because a single timing is a fact about what else the machine was doing. */
    const measure = (run: () => void): number => {
      let best = Infinity;
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const big = (): void => void serializeWorld(one, [Health]);
    const small = (): void => {
      for (const world of many) serializeWorld(world, [Health]);
    };
    /* Warmed together so neither pays for the other's first run. */
    big();
    small();

    const ratio = Math.max(measure(big), 0.05) / Math.max(measure(small), 0.05);
    expect(
      ratio,
      'one world of 40,000 should cost what eight of 5,000 do, not eight times as much',
    ).toBeLessThan(3);
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
