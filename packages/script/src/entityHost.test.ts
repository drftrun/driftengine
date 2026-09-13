import { describe, expect, it } from 'vitest';
import { World, buildSchedule, defineComponent, runSchedule } from '@driftengine/entities';
import { loadModule } from 'driftscript';
import { assertHostShapes, registerEntityModule } from './entityHost.ts';

/** A generated module namespace, hand-built so a test does not depend on the compiler's output. */
const moduleOf = (
  info: Record<string, unknown>,
  exports: Record<string, unknown> = {},
): ReturnType<typeof loadModule> =>
  loadModule({
    ...exports,
    __drift: { module: 'w.drs', requires: [], shapes: {}, schemas: {}, ...info },
  });

const HUNGER = {
  name: 'Hunger',
  fromHost: false,
  schema: {
    name: 'Hunger',
    fields: [{ id: 'w.drs::Hunger::value', name: 'value', type: 'f64' }],
  },
};

describe('building a world from what a module declares', () => {
  it('makes a component type per declared component, keeping the module in its ids', () => {
    const registry = new Map();
    const { components } = registerEntityModule(moduleOf({ components: [HUNGER] }), registry);
    expect(components[0]?.schema.fields[0]?.id).toBe('w.drs::Hunger::value');
    expect(registry.get('Hunger')).toBe(components[0]);
  });

  it('creates nothing for a host-declared component, and asserts its shape', () => {
    const registry = new Map([['Transform', defineComponent('Transform', { x: 'f64' })]]);
    const { components } = registerEntityModule(
      moduleOf({
        components: [
          {
            name: 'Transform',
            fromHost: true,
            schema: {
              name: 'Transform',
              fields: [{ id: 'w.drs::Transform::x', name: 'x', type: 'f64' }],
            },
          },
        ],
      }),
      registry,
    );
    expect(components).toEqual([]);
    expect(registry.size).toBe(1);
  });

  it('refuses a host-declared shape the host disagrees with, naming both types', () => {
    const registry = new Map([['Transform', defineComponent('Transform', { x: 'f32' })]]);
    expect(() =>
      assertHostShapes(
        moduleOf({
          components: [
            {
              name: 'Transform',
              fromHost: true,
              schema: {
                name: 'Transform',
                fields: [{ id: 'w.drs::Transform::x', name: 'x', type: 'f64' }],
              },
            },
          ],
        }),
        registry,
      ),
    ).toThrow(/Transform\.x.*f64.*f32/s);
  });

  it('refuses a host-declared component the host never registered', () => {
    expect(() =>
      assertHostShapes(
        moduleOf({
          components: [
            { name: 'Transform', fromHost: true, schema: { name: 'Transform', fields: [] } },
          ],
        }),
        new Map(),
      ),
    ).toThrow(/registered no component/);
  });

  it('refuses a host-declared field the registered component does not have', () => {
    const registry = new Map([['Transform', defineComponent('Transform', { x: 'f64' })]]);
    expect(() =>
      assertHostShapes(
        moduleOf({
          components: [
            {
              name: 'Transform',
              fromHost: true,
              schema: {
                name: 'Transform',
                fields: [{ id: 'w.drs::Transform::z', name: 'z', type: 'f64' }],
              },
            },
          ],
        }),
        registry,
      ),
    ).toThrow(/Transform\.z/);
  });

  it('keeps the store a reloaded module already made', () => {
    /* Replacing the type would orphan every entity holding one — a world that silently loses its
       components on an edit. */
    const registry = new Map();
    const first = registerEntityModule(moduleOf({ components: [HUNGER] }), registry);
    const second = registerEntityModule(moduleOf({ components: [HUNGER] }), registry);
    expect(second.components[0]).toBe(first.components[0]);
  });

  it('builds a prefab from constants', () => {
    const registry = new Map();
    const { prefabs } = registerEntityModule(
      moduleOf({
        components: [HUNGER],
        prefabs: [{ name: 'Guard', components: [{ name: 'Hunger', values: { value: 5 } }] }],
      }),
      registry,
    );
    expect(prefabs[0]?.name).toBe('Guard');
    expect(prefabs[0]?.components[0]?.[1]).toEqual({ value: 5 });
  });

  it('builds a system definition carrying its stride and ordering', () => {
    const registry = new Map();
    const { systems } = registerEntityModule(
      moduleOf({
        components: [HUNGER],
        systems: [
          {
            name: 'Feeder',
            reads: ['Hunger'],
            writes: ['Hunger'],
            after: ['Movement'],
            everyTicks: 60,
          },
        ],
      }),
      registry,
    );
    expect(systems[0]).toMatchObject({ name: 'Feeder', after: ['Movement'], everyTicks: 60 });
    expect(systems[0]?.writes?.[0]).toBe(registry.get('Hunger'));
  });

  it('reads the function through exports on every tick, so a hot patch reaches the schedule', () => {
    /*
     * **The property the whole indirection exists for.** `runSchedule` caches one `BoundSystem` per
     * world and definition, so a definition that captured the function would pin the pre-patch body
     * forever — and the symptom is an edit that compiles, reloads, reports success and changes
     * nothing at all.
     */
    const registry = new Map();
    let ran = 0;
    const module = moduleOf(
      {
        components: [HUNGER],
        systems: [{ name: 'Feeder', reads: [], writes: [], after: [], everyTicks: 1 }],
      },
      {
        Feeder: () => {
          ran += 1;
        },
      },
    );
    const { systems } = registerEntityModule(module, registry);

    const world = new World();
    const schedule = buildSchedule(systems);
    runSchedule(world, schedule, 0);
    expect(ran).toBe(1);

    /* The patch: the same definition object, a different function behind the same export. */
    module.exports.Feeder = () => {
      ran += 10;
    };
    runSchedule(world, schedule, 1);
    expect(ran).toBe(11);
  });

  it('fails loudly when a disposed module is left in a schedule', () => {
    const registry = new Map();
    const module = moduleOf(
      { systems: [{ name: 'Feeder', reads: [], writes: [], after: [], everyTicks: 1 }] },
      { Feeder: () => {} },
    );
    const { systems } = registerEntityModule(module, registry);
    delete module.exports.Feeder;
    expect(() => (systems[0] as { run: (v: unknown) => void }).run({} as never)).toThrow(
      /not exported/,
    );
  });

  it('takes a module compiled before any of this existed', () => {
    /* Every list is optional, so a module with no entity metadata loads and contributes nothing —
       rather than a runtime that refuses a module working perfectly for everything else. */
    const registry = new Map();
    expect(registerEntityModule(moduleOf({}), registry)).toEqual({
      components: [],
      prefabs: [],
      systems: [],
    });
  });
});
