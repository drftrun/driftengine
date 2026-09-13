import { describe, expect, it } from 'vitest';
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { bindModule, engineRegistry } from './host.ts';
import { registerEntityModule } from './entityHost.ts';

/**
 * Whether a compiled query loop allocates.
 *
 * **`heapUsed` cannot answer this.** It reads the *live* heap, so garbage made and immediately
 * dropped does not move it — a previous test in this repository measured `heapUsed` and passed
 * against the very perturbation it existed to catch.
 *
 * So garbage **collections** are counted, through a `PerformanceObserver`, and the assertion is the
 * **separation** from a control that deliberately allocates over the same number of iterations —
 * never either number on its own. A collection count is a property of the machine, the heap size
 * and what else was running; the ratio between two loops measured back to back is not.
 *
 * ---
 *
 * ## What this does and does not catch, established by perturbing it
 *
 * **It catches an allocation that crosses the cursor boundary**, which is the one the design
 * forbids: making `QueryCursor.next` return a fresh `{ value, done }` instead of its reused one
 * takes the loop from 0 collections to 5, against a control of 15, and fails this test.
 *
 * **It does not catch an object the loop makes and drops without letting it escape**, and that is
 * worth knowing rather than pretending otherwise. Emitting `const $step = { value: ecs.next(q),
 * done: false }` and reading `.value` from it changes the collection count by nothing at all: V8
 * scalar-replaces an object that never leaves the function. So part of "the loop allocates
 * nothing" is the optimiser's doing rather than the emitter's — and the property this file actually
 * defends is the one that survives a function boundary, which is where the pooled cursor lives.
 */
async function collections(work: () => void): Promise<number> {
  /*
   * **The count arrives asynchronously, and there is no synchronous way to get it.**
   *
   * A `PerformanceObserver`'s callback is delivered on a later turn, so a measurement that
   * observes, runs and disconnects in one go sees nothing — the first version of this reported
   * **zero** collections while its control allocated two million objects, and would have "proved"
   * any implementation whatsoever allocation-free. `takeRecords()` does not help either: it returns
   * an empty list for `gc` entries, which was the second thing tried. Yielding to the event loop
   * before reading is the only thing that works.
   */
  let seen = 0;
  /* The global rather than `node:perf_hooks`, so this package needs no Node types — the same reason
     the round-trip test loads its module from a data URL instead of reaching for `Buffer`. */
  const observer = new PerformanceObserver((list: { getEntries(): unknown[] }) => {
    seen += list.getEntries().length;
  });
  observer.observe({ entryTypes: ['gc'] } as PerformanceObserverInit);
  work();
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  observer.disconnect();
  return seen;
}

const ENTITIES = 2_000;
const TICKS = 1_000;

const compiled = (): string => {
  const result = compileDriftScript(
    `
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
`,
    {
      filename: 'move.drs',
      mode: 'production',
      manifest: { name: 'bench', provides: ['drift/ecs'] },
      host: singleFileHost(),
      registry: engineRegistry(),
    },
  );
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));
  return result.code;
};

describe('a compiled query loop does not allocate per frame', () => {
  it('collects far less often than a control allocating over the same run', async () => {
    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled())}`
    )) as Record<string, unknown>;

    const module = loadModule(namespace);
    const registry = new Map();
    const { systems } = registerEntityModule(module, registry);
    const bound = bindModule(module, { entities: { components: registry } });
    if (!bound.bound) throw new Error(bound.reason);

    const world = new World();
    const Position = registry.get('Position');
    const Velocity = registry.get('Velocity');
    if (Position === undefined || Velocity === undefined) throw new Error('components missing');
    for (let i = 0; i < ENTITIES; i += 1) {
      const e = world.create();
      world.add(e, Position, { x: 0, y: 0 });
      world.add(e, Velocity, { x: 1, y: 1 });
    }
    const schedule = buildSchedule(systems);

    /* Warmed, so neither measurement pays for the other's first-run compilation. */
    for (let tick = 0; tick < 20; tick += 1) runSchedule(world, schedule, tick);

    /*
     * The control does the same number of iterations and allocates two small objects in each, which
     * is the shape a cursor that returned a fresh result record per step would have.
     */
    /*
     * A fraction of the control's objects are kept, so escape analysis cannot elide the rest.
     *
     * Without that V8 scalar-replaces them and the control allocates nothing: an earlier version
     * ran a million iterations of two object literals in 88 ms and collected zero times, which
     * reads exactly like a control that is working.
     */
    const kept: unknown[] = [];
    const control = await collections(() => {
      for (let tick = 0; tick < TICKS; tick += 1) {
        for (let i = 0; i < ENTITIES; i += 1) {
          const step = { value: i, done: false, of: `e${i}` };
          const pair = { x: i, y: i, of: step };
          if (i === 0 && tick % 50 === 0) kept.push(pair);
        }
      }
    });
    expect(kept.length, 'the control has to keep some of what it made').toBeGreaterThan(0);

    const loop = await collections(() => {
      for (let tick = 0; tick < TICKS; tick += 1) runSchedule(world, schedule, tick);
    });

    /*
     * **The control has to actually collect, or the instrument is not working** — a zero here means
     * the assertion below would pass for any implementation whatsoever, which is the failure mode
     * this whole file is written against. Raise `ENTITIES` or `TICKS` rather than weakening it.
     */
    /*
     * **The control has to actually collect, or the instrument is not working.** A zero here means
     * the comparison below would pass for any implementation whatsoever, which is the failure this
     * whole file is written against — so it fails loudly rather than passing vacuously. Raise the
     * workload rather than weakening it.
     */
    expect(control, 'the control must collect, or this measures nothing').toBeGreaterThan(0);
    expect(
      loop * 4,
      `the loop collected ${loop} times against the control's ${control}`,
    ).toBeLessThan(control);
  });
});
