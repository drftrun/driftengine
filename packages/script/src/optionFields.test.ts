/**
 * A component field that may be absent, read and written from a script, through a query and
 * through a handle.
 *
 * The world stores an optional field as a value and a presence column, and answers `undefined`
 * for an absent one; a script's option is `{ tag: 'some', value }` or `{ tag: 'none' }`. Nothing
 * converted between the two: a read answered a bare number, so `if let` on it never matched, and a
 * write of `some(x)` stored `Number` of an object, which is NaN, marked present. A consumer kept
 * every optional handle as a plain entity and a flag beside it because of this.
 */
import { describe, expect, it } from 'vitest';
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import type { ComponentType, Entity } from '@driftengine/entities';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { bindModule, engineRegistry } from './host.ts';
import { registerEntityModule } from './entityHost.ts';

const SOURCE = `
component Follow {
    target: Entity?
    gap: f64?
}

component Seen {
    count: f64 = 0
    gap: f64 = 0
}

system Look {
    writes Follow
    writes Seen

    update {
        for e in query<Follow, Seen>() {
            if let t = e.Follow.target {
                e.Seen.count = e.Seen.count + 1
                if let g = t.Follow.gap {
                    e.Seen.gap = g
                }
                t.Follow.gap = some(7)
                e.Follow.gap = some(1.5)
            }
        }
    }
}

system Forget {
    writes Follow

    update at 1Hz {
        for e in query<Follow>() {
            e.Follow.target = none
        }
    }
}
`;

async function compileAndRegister() {
  const compiled = compileDriftScript(SOURCE, {
    filename: 'follow.drs',
    mode: 'development',
    manifest: { name: 'test', provides: ['drift/ecs'] },
    host: singleFileHost(),
    registry: engineRegistry(),
  });
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));
  const module = loadModule(
    (await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiled.code)}`
    )) as Record<string, unknown>,
  );
  const registry = new Map<string, ComponentType>();
  const { systems } = registerEntityModule(module, registry);
  const bound = bindModule(module, { entities: { components: registry, prefabs: new Map() } });
  if (!bound.bound) throw new Error(bound.reason);
  const Follow = registry.get('Follow') as ComponentType;
  const Seen = registry.get('Seen') as ComponentType;
  return { systems, Follow, Seen };
}

describe('an optional component field', () => {
  it('reads as an option and writes from one, through a query and through a handle', async () => {
    const { systems, Follow, Seen } = await compileAndRegister();
    const look = systems.filter((s) => s.name === 'Look');
    const world = new World();
    const leader = world.create();
    world.add(leader, Follow, { gap: 4 });
    world.add(leader, Seen, {});
    const follower = world.create();
    world.add(follower, Follow, { target: leader });
    world.add(follower, Seen, {});

    runSchedule(world, buildSchedule(look), 1);

    /* The query read the follower's target as `some(leader)`, and the leader's absent target as
       `none`: only one entity counted. */
    expect(world.read(follower, Seen, 'count')).toBe(1);
    expect(world.read(leader, Seen, 'count')).toBe(0);
    /* Through the handle: the leader's gap read as `some(4)`, then written as `some(7)`. */
    expect(world.read(follower, Seen, 'gap')).toBe(4);
    expect(world.read(leader, Follow, 'gap')).toBe(7);
    /* Through the query: the follower's own gap written as `some(1.5)`. */
    expect(world.read(follower, Follow, 'gap')).toBe(1.5);
  });

  it('clears a field written as none, so it reads as absent', async () => {
    const { systems, Follow } = await compileAndRegister();
    const world = new World();
    const leader = world.create();
    const follower = world.create();
    world.add(follower, Follow, { target: leader as Entity });

    runSchedule(world, buildSchedule(systems.filter((s) => s.name === 'Forget')), 0);

    expect(world.read(follower, Follow, 'target')).toBe(undefined);
  });
});
