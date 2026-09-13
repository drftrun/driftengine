import { describe, expect, it } from 'vitest';
import { ENTITY_INDEX_CEILING, World, buildSchedule, runSchedule } from '@driftengine/entities';
import { NavSearch, buildNavGraph } from '@driftengine/core';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { bindModule } from './host.ts';
import { registerEntityModule } from './entityHost.ts';
import { engineRegistry } from './host.ts';

/**
 * A `.drs` file, compiled and run against a real world.
 *
 * **The only test in this repository where the compiler's output drives the engine.** Everything
 * either side of the boundary is covered on its own; what nothing else covers is whether the bytes
 * one produces are the bytes the other expects — the field name a view is indexed by, the sentinel
 * a walk ends on, the parameter a system is called with.
 */
const run = async (
  source: string,
  options: {
    readonly provides?: readonly string[];
    readonly resources?: ReadonlyMap<string, unknown>;
    /** Extra services this script needs bound, beyond the entity one every test gets. */
    readonly services?: Record<string, unknown>;
  } = {},
): Promise<World> => {
  const compiled = compileDriftScript(source, {
    filename: 'world.drs',
    mode: 'development',
    manifest: { name: 'test', provides: [...(options.provides ?? ['drift/ecs'])] },
    host: singleFileHost(),
    registry: engineRegistry(),
  });
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));

  /*
   * A data URL rather than a file, so the test needs no temporary directory and the module a
   * browser would load is the module this runs.
   *
   * Encoded with `encodeURIComponent` rather than base64, because `Buffer` is Node's and this
   * package is typechecked without Node's types — generated code is browser-valid with no Node
   * assumptions, and a test that reached for `Buffer` to load it would be asserting that from a
   * position that does not hold.
   */
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled.code)}`
  )) as Record<string, unknown>;

  const module = loadModule(namespace);
  const world = new World();
  const registry = new Map();
  const { systems } = registerEntityModule(module, registry, options.resources);
  const bound = bindModule(module, { entities: { components: registry }, ...options.services });
  if (!bound.bound) throw new Error(bound.reason);

  return { world, systems, registry, module } as never;
};

describe('a compiled script drives a real world', () => {
  it('hands a system a host value, so the walk over agents stays in the script', async () => {
    /**
     * **The consumer's report, end to end.** A route is computed and followed by a `system` rather
     * than by a TypeScript loop calling a script function once per agent: `uses` hands the system
     * the graph, `navigation.path` answers a route per walker, and the query is back where the rule
     * is.
     *
     * Both halves are needed and neither is enough. A resource is one per *type*, so the graph fits
     * and a route does not; a route arrives by entity, and without `uses` there is nothing to route
     * it over.
     */
    const graph = buildNavGraph(
      [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
      [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    );
    const parts = (await run(
      `import { path, route, following, remaining } from "drift/navigation"

component Walker {
    x: f32 = 0
    left: f32 = 0
}

system Walk {
    uses graph: NavGraph
    writes Walker

    update {
        for e in query<Walker>() {
            let route = navigation.path(e)
            if !navigation.following(route) {
                navigation.route(route, graph, e.Walker.x, 0, 0, 3, 0, 0)
            }
            e.Walker.left = navigation.remaining(route, e.Walker.x, 0, 0)
        }
    }
}
`,
      {
        provides: ['drift/ecs', 'drift/navigation'],
        resources: new Map([['NavGraph', graph]]),
        services: { navigation: { graph, search: new NavSearch(graph) } },
      },
    )) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, never>;
    };

    const Walker = parts.registry.get('Walker') as never;
    const walker = parts.world.create();
    parts.world.add(walker, Walker, { x: 0, left: -1 });

    runSchedule(parts.world, buildSchedule(parts.systems), 0);

    /* Three metres of route, measured along it. The system routed and read back in one pass, which
       is only possible because the graph and the route both reached the body. */
    expect(parts.world.read(walker, Walker, 'left')).toBeCloseTo(3, 5);
  });

  it('gives an integer component field the column its width asks for', async () => {
    /*
     * **This could not be written before driftscript 1.10.0, and nothing said so.**
     *
     * A component field's type crosses as a string, and `defineComponent` looks it up in the column
     * table — `i32` is an `Int32Array`. The compiler was sending `int` for every integer width,
     * because its `typeKey` fell through to the node's kind, so the lookup found nothing and every
     * integer component field threw at bind naming a type no script had written. It stood because
     * nothing in either repository's corpus declared one: every component in both is `f32`, `f64`
     * or `Entity`.
     *
     * So this is the first `.drs` component with an integer field, and it runs a system over one.
     */
    const parts = (await run(`
component Score { points: i32 = 0  tier: u8 = 0 }

system Tally {
    writes Score

    update {
        for e in query<Score>() {
            e.Score.points = e.Score.points + 1
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, never>;
    };

    const Score = parts.registry.get('Score') as never;
    const one = parts.world.create();
    parts.world.add(one, Score, { points: 41, tier: 200 });

    runSchedule(parts.world, buildSchedule(parts.systems), 0);

    expect(parts.world.read(one, Score, 'points')).toBe(42);
    /* And the narrow one kept its width rather than being widened to a double: a `u8` column is a
       `Uint8Array`, which is the whole reason the type is named rather than collapsed. */
    expect(parts.world.read(one, Score, 'tier')).toBe(200);
  });

  it('refuses to register a system whose resource nothing supplied', async () => {
    /* Not left as `undefined`: an absent argument reaches a capability as a wrong *answer* rather
       than an error, and init is where a person is watching. */
    await expect(
      run(
        `system Walk {
    uses graph: NavGraph

    update {
    }
}
`,
        { provides: ['drift/ecs', 'drift/navigation'] },
      ),
    ).rejects.toThrow(/uses `graph: NavGraph`, and no `NavGraph` was supplied/);
  });
  it('runs a system that writes through a query, tick after tick', async () => {
    const parts = (await run(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger

    update {
        for e in query<Hunger>() {
            e.Hunger.value = e.Hunger.value + 1
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, Parameters<World['add']>[1]>;
    };

    const Hunger = parts.registry.get('Hunger');
    if (Hunger === undefined) throw new Error('Hunger was not registered');

    const a = parts.world.create();
    const b = parts.world.create();
    parts.world.add(a, Hunger, { value: 0 });
    parts.world.add(b, Hunger, { value: 10 });

    const schedule = buildSchedule(parts.systems);
    runSchedule(parts.world, schedule, 0);
    runSchedule(parts.world, schedule, 1);
    runSchedule(parts.world, schedule, 2);

    expect(parts.world.read(a, Hunger, 'value')).toBe(3);
    expect(parts.world.read(b, Hunger, 'value')).toBe(13);
  });

  it('honours a stride, so `at 1Hz` runs once a second and not every tick', async () => {
    const parts = (await run(`
component Ticks { n: f64 = 0 }

system Counter {
    writes Ticks

    update at 1Hz {
        for e in query<Ticks>() {
            e.Ticks.n = e.Ticks.n + 1
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, never>;
    };

    const Ticks = parts.registry.get('Ticks') as never;
    const e = parts.world.create();
    parts.world.add(e, Ticks, { n: 0 });

    const schedule = buildSchedule(parts.systems);
    for (let tick = 0; tick < 121; tick += 1) runSchedule(parts.world, schedule, tick);

    /* Ticks 0, 60 and 120 — a stride of 60 over the fixed step. */
    expect(parts.world.read(e, Ticks, 'n')).toBe(3);
  });

  it('finds the right column for a handle carrying a generation', async () => {
    /*
     * **The case that made every other round trip blind to the index arithmetic.** A handle is a
     * 26-bit index with a 27-bit generation above it, and generated code takes the index as
     * `handle % 67108864` because it cannot import `entityIndex`. Every entity in a fresh world has
     * generation 0, where that arithmetic is the identity — so a *wrong* modulus passed all of
     * them. Destroying and recreating puts a generation on the handle, and the modulus is then the
     * only thing standing between a system and someone else's column.
     */
    const parts = (await run(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger

    update {
        for e in query<Hunger>() {
            e.Hunger.value = e.Hunger.value + 1
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, never>;
    };

    const Hunger = parts.registry.get('Hunger') as never;

    /*
     * Burn slots until the free list hands one back with an **odd** generation on it.
     *
     * Odd is not fussiness. A handle is `index + generation * 2 ** 26`, so a wrong modulus that is
     * a multiple or a divisor of 2 ** 26 gives the same answer for an even generation — `2 ** 24`
     * aliases for every generation, and `2 ** 27` aliases for every even one. The first version of
     * this test stopped at generation 40 and passed against both.
     */
    let reused = 0;
    for (let i = 0; i < 41; i += 1) {
      parts.world.destroy(parts.world.create());
      reused = parts.world.create();
      if (i < 40) parts.world.destroy(reused);
    }
    const generation = Math.floor(reused / 2 ** 26);
    expect(generation % 2, 'the generation has to be odd for this test to discriminate').toBe(1);
    expect(reused % 2 ** 26, 'and the index small, so a wrong modulus lands somewhere else').toBe(
      0,
    );

    parts.world.add(reused, Hunger, { value: 5 });
    runSchedule(parts.world, buildSchedule(parts.systems), 0);

    expect(parts.world.read(reused, Hunger, 'value')).toBe(6);
  });

  it('narrows with `without`, leaving excluded entities untouched', async () => {
    const parts = (await run(`
component Hunger { value: f64 = 0 }
component Dead { at: f64 = 0 }

system Feeder {
    writes Hunger

    update {
        for e in query<Hunger>().without<Dead>() {
            e.Hunger.value = 99
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, never>;
    };

    const Hunger = parts.registry.get('Hunger') as never;
    const Dead = parts.registry.get('Dead') as never;
    const alive = parts.world.create();
    const gone = parts.world.create();
    parts.world.add(alive, Hunger, { value: 1 });
    parts.world.add(gone, Hunger, { value: 2 });
    parts.world.add(gone, Dead, { at: 0 });

    runSchedule(parts.world, buildSchedule(parts.systems), 0);

    expect(parts.world.read(alive, Hunger, 'value')).toBe(99);
    expect(parts.world.read(gone, Hunger, 'value')).toBe(2);
  });

  it('is refused by the engine when a system writes what it did not declare', async () => {
    /*
     * The declaration is checked at compile time *and* enforced at runtime, and this is the second.
     * A hand-built definition claiming less than the generated body does is exactly what the
     * engine's `requireWritable` exists for — so the two halves are shown to be connected rather
     * than merely both present.
     */
    const parts = (await run(`
component Hunger { value: f64 = 0 }

system Feeder {
    writes Hunger

    update {
        for e in query<Hunger>() {
            e.Hunger.value = 1
        }
    }
}
`)) as unknown as {
      world: World;
      systems: { name: string; run: unknown }[];
      registry: Map<string, never>;
    };

    const Hunger = parts.registry.get('Hunger') as never;
    const entity = parts.world.create();
    parts.world.add(entity, Hunger, { value: 0 });

    const lying = [{ ...parts.systems[0], writes: [], reads: [Hunger] }] as never;
    /*
     * **Read off the report rather than off a throw.** A system's failure stopped leaving
     * `runSchedule` on 2026-08-28 — it used to take every system after it down with it, once a tick,
     * which is how a declaration mistake presented as a *different* system stuttering. The refusal
     * itself is unchanged and is what this test is about: the engine will not let the generated body
     * write what the hand-built definition denied.
     */
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void lines.push(String(args[0]));
    try {
      runSchedule(parts.world, buildSchedule(lying), 0);
    } finally {
      console.error = original;
    }
    expect(lines.join('\n')).toMatch(/Hunger/);
    expect(parts.world.read(entity, Hunger, 'value'), 'and the write did not land').toBe(0);
  });
});

describe('the one number the two packages have to agree about', () => {
  /*
   * **`driftscript` cannot import `@driftengine/entities`** — the dependency runs the other way, and
   * the entity model taking the language for `Schema` is already the only edge between them. So the
   * emitter writes `2 ** 26` as a literal while the entity model derives every handle from
   * `ENTITY_INDEX_CEILING`, and nothing on either side can see the other.
   *
   * This package sees both, which makes it the only place the two can be held together.
   *
   * **A round-trip test cannot do this job**, which is why the assertion is arithmetic rather than
   * behavioural. A modulus that is too *large* aliases the generation into the index and is caught
   * by the odd-generation case above; a modulus that is too *small* is a divisor of the real one
   * and gives identical answers until an index exceeds it — 16.7 million entities for `2 ** 24`.
   * Both were tried: `2 ** 27` fails that test and `2 ** 25` and `2 ** 24` sail through it.
   */
  it("emits the entity model's own index ceiling", async () => {
    const compiled = compileDriftScript(
      `
component Hunger { value: f64 = 0 }

fn feed(world: World) {
    for e in query<Hunger>() {
        e.Hunger.value = 1
    }
}
`,
      {
        filename: 'm.drs',
        mode: 'development',
        manifest: { name: 'test', provides: ['drift/ecs'] },
        host: singleFileHost(),
        registry: engineRegistry(),
      },
    );
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.code).toContain(`% ${ENTITY_INDEX_CEILING}`);
  });
});

describe('a script asking what is near it', () => {
  it('finds an entity it was never handed, and reads a component through the handle', async () => {
    /*
     * The gap this closes, end to end. Before `nearestWithin` a script could only act on entities
     * the host passed in or a query yielded, so "react to whatever is close" had to live in
     * TypeScript — which is the wrong place for a rule somebody wants to change and hot-reload.
     *
     * **The handle comes back as an `Entity` and is read through directly** — `who.Position.x`,
     * not `ecs.read(world, who, "Position", "x")`. Both halves of that are DriftScript 1.6.0: a
     * capability can name the type, and a component reached through a handle compiles to a read
     * instead of to a property of a number.
     */
    const parts = (await run(`
import { findNearest, nearest } from "drift/ecs"

component Position { x: f64 = 0, y: f64 = 0, z: f64 = 0 }
component Alarm { level: f64 = 0 }

system Watch {
    reads Position
    writes Alarm

    update {
        for e in query<Alarm>() {
            if ecs.findNearest(world, "Position", "x", "y", "z", 0, 0, 0, 10) {
                let who = ecs.nearest(world)
                e.Alarm.level = who.Position.x
            }
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, Parameters<World['add']>[1]>;
    };

    const Position = parts.registry.get('Position');
    const Alarm = parts.registry.get('Alarm');
    if (Position === undefined || Alarm === undefined) throw new Error('components not registered');

    const watcher = parts.world.create();
    parts.world.add(watcher, Alarm, { level: 0 });

    const close = parts.world.create();
    parts.world.add(close, Position, { x: 3, y: 0, z: 0 });
    const distant = parts.world.create();
    parts.world.add(distant, Position, { x: 40, y: 0, z: 0 });

    const schedule = buildSchedule(parts.systems);
    runSchedule(parts.world, schedule, 0);

    /* The near one at x = 3, not the far one at x = 40 — so the handle really was found by
       distance and really did index the right entity's column. */
    expect(parts.world.read(watcher, Alarm, 'level')).toBe(3);
  });

  it('reports nothing near when nothing is in range', async () => {
    const parts = (await run(`
import { findNearest } from "drift/ecs"

component Position { x: f64 = 0, y: f64 = 0, z: f64 = 0 }
component Alarm { level: f64 = 0 }

system Watch {
    reads Position
    writes Alarm

    update {
        for e in query<Alarm>() {
            if ecs.findNearest(world, "Position", "x", "y", "z", 0, 0, 0, 5) {
                e.Alarm.level = 1
            } else {
                e.Alarm.level = 99
            }
        }
    }
}
`)) as unknown as {
      world: World;
      systems: Parameters<typeof buildSchedule>[0];
      registry: Map<string, Parameters<World['add']>[1]>;
    };

    const Position = parts.registry.get('Position');
    const Alarm = parts.registry.get('Alarm');
    if (Position === undefined || Alarm === undefined) throw new Error('components not registered');

    const watcher = parts.world.create();
    parts.world.add(watcher, Alarm, { level: 0 });
    const distant = parts.world.create();
    parts.world.add(distant, Position, { x: 40, y: 0, z: 0 });

    const schedule = buildSchedule(parts.systems);
    runSchedule(parts.world, schedule, 0);

    expect(parts.world.read(watcher, Alarm, 'level')).toBe(99);
  });
});
