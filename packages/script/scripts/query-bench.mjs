#!/usr/bin/env node
/**
 * What a hoisted view buys over a host call per field.
 *
 * The design's decision 2 rests on a claim — that indexing a live view is meaningfully cheaper than
 * calling the host for every field of every entity of every frame — and a design that asserts a
 * number without measuring it is the failure `docs/README.md` opens by describing. This is the
 * measurement.
 *
 * ```sh
 * node --experimental-strip-types packages/script/scripts/query-bench.mjs generated
 * node --experimental-strip-types packages/script/scripts/query-bench.mjs handwritten
 * node --experimental-strip-types packages/script/scripts/query-bench.mjs calls
 * ```
 *
 * ---
 *
 * ## One implementation per process, and that is not tidiness
 *
 * The first DriftScript benchmark called three implementations through one `fn` parameter, which
 * made the call site **megamorphic**: whichever ran first got a monomorphic site and won. The same
 * generated function measured 3.80 ns when it ran first and 10.01 ns when it ran second, and the
 * first ordering reported the language *faster* than the JavaScript a person would write — a result
 * that is not a thing that happens, believed for a while because it was measured.
 *
 * So this script runs exactly one implementation and exits. Comparing two means running it twice.
 *
 * ## It binds the module by hand rather than through `host.ts`
 *
 * **Node can only load the engine packages whose relative imports name a `.ts` file.** `driftscript`
 * does, because it ships a Vite plugin the toolchain loads; `@driftengine/entities` does, because it
 * depends on `driftscript`. Every other engine package uses extensionless imports, which a bundler
 * resolves and Node does not — so importing `host.ts` pulls in `@driftengine/audio` and the script
 * cannot start.
 *
 * The two pieces this needs are both reachable, so it calls `__bind` with the one implementation map
 * it wants. **What that costs** is that this measures the binding rather than the host's assembly of
 * it. **What would make it wrong** is a host that did something to the implementations on the way
 * through, which `bindModule` does not: it checks requirements and passes the map along.
 */
import { World, buildSchedule, defineComponent, runSchedule } from '@driftengine/entities';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { registerEntityModule } from '../src/entityHost.ts';
import { entitiesImplementation } from '../src/bindings/entities.ts';

const ENTITIES = 20_000;
const TICKS = 200;

const SOURCE = `
component Position { x: f64 = 0, y: f64 = 0 }
component Velocity { x: f64 = 0, y: f64 = 0 }

system Movement {
    reads Velocity
    writes Position

    update {
        for e in query<Position, Velocity>() {
            e.Position.x = e.Position.x + e.Velocity.x
            e.Position.y = e.Position.y + e.Velocity.y
        }
    }
}
`;

/** A world with `ENTITIES` movers, and the two component types. */
function populate() {
  const Position = defineComponent('Position', { x: 'f64', y: 'f64' });
  const Velocity = defineComponent('Velocity', { x: 'f64', y: 'f64' });
  const world = new World();
  for (let i = 0; i < ENTITIES; i += 1) {
    const e = world.create();
    world.add(e, Position, { x: 0, y: 0 });
    world.add(e, Velocity, { x: 1, y: 1 });
  }
  return { world, Position, Velocity };
}

/** Time `TICKS` runs of `tick`, best of three, in nanoseconds per entity. */
function measure(tick) {
  for (let warm = 0; warm < 20; warm += 1) tick();
  let best = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const started = process.hrtime.bigint();
    for (let t = 0; t < TICKS; t += 1) tick();
    const elapsed = Number(process.hrtime.bigint() - started);
    best = Math.min(best, elapsed / (TICKS * ENTITIES));
  }
  return best;
}

/** The compiled `.drs` system, run through the schedule exactly as a host would. */
async function generated() {
  /* No registry: this module imports no capability by name, and the query form's requirement is
     added by the compiler. Passing one would pull in the host assembly this script cannot load. */
  const compiled = compileDriftScript(SOURCE, {
    filename: 'move.drs',
    mode: 'production',
    manifest: { name: 'bench', provides: ['drift/ecs'] },
    host: singleFileHost(),
  });
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));

  const namespace = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);
  const module = loadModule(namespace);
  const registry = new Map();
  const { systems } = registerEntityModule(module, registry);
  module.exports.__bind({ 'drift/ecs': entitiesImplementation({ components: registry }) });

  const Position = registry.get('Position');
  const Velocity = registry.get('Velocity');
  const world = new World();
  for (let i = 0; i < ENTITIES; i += 1) {
    const e = world.create();
    world.add(e, Position, { x: 0, y: 0 });
    world.add(e, Velocity, { x: 1, y: 1 });
  }
  const schedule = buildSchedule(systems);
  let tick = 0;
  return measure(() => {
    runSchedule(world, schedule, tick);
    tick += 1;
  });
}

/** What a person would write against the engine directly: the same views, by hand. */
function handwritten() {
  const { world, Position, Velocity } = populate();
  return measure(() => {
    const cursor = world.query(Position, Velocity);
    const position = world.view(Position);
    const velocity = world.view(Velocity);
    for (;;) {
      const step = cursor.next();
      if (step.done === true) break;
      const e = step.value;
      const p = position.sparse[e % 2 ** 26];
      const v = velocity.sparse[e % 2 ** 26];
      position.x[p] = position.x[p] + velocity.x[v];
      position.y[p] = position.y[p] + velocity.y[v];
    }
  });
}

/** The interim shape: a host call per field, which is what the query form replaced. */
function calls() {
  const { world, Position, Velocity } = populate();
  const ecs = entitiesImplementation({
    components: new Map([
      ['Position', Position],
      ['Velocity', Velocity],
    ]),
  });
  return measure(() => {
    const count = ecs.count(world, 'Position');
    for (let i = 0; i < count; i += 1) {
      const e = ecs.at(world, 'Position', i);
      ecs.write(
        world,
        e,
        'Position',
        'x',
        ecs.read(world, e, 'Position', 'x') + ecs.read(world, e, 'Velocity', 'x'),
      );
      ecs.write(
        world,
        e,
        'Position',
        'y',
        ecs.read(world, e, 'Position', 'y') + ecs.read(world, e, 'Velocity', 'y'),
      );
    }
  });
}

const which = process.argv[2];
const implementations = { generated, handwritten, calls };
const chosen = implementations[which];
if (chosen === undefined) {
  console.error(`usage: query-bench.mjs <${Object.keys(implementations).join('|')}>`);
  process.exit(1);
}

const nanoseconds = await chosen();
console.log(
  `${which}: ${nanoseconds.toFixed(2)} ns per entity ` +
    `(${ENTITIES.toLocaleString('en-GB')} entities x ${TICKS} ticks, best of three)`,
);
