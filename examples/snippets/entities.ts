/**
 * The entity model from TypeScript: components declared in code, a system with its reads and
 * writes, a scene saved and loaded, and what a handle is made of.
 *
 * A snippet, typechecked with the examples and quoted by the manual's entities chapter.
 */
import {
  World,
  buildSchedule,
  defineComponent,
  definePrefab,
  deserializeWorld,
  entityGeneration,
  entityIndex,
  instantiate,
  runSchedule,
  serializeWorld,
} from '@driftengine/entities';
import type { Entity, SerializedScene } from '@driftengine/entities';

// #region components
/** A component is a name and its fields' types; each field becomes one typed column. */
const Health = defineComponent('Health', { current: 'f32', max: 'f32' });
const Hunger = defineComponent('Hunger', { value: 'f32' });
/** A field holding a handle is typed `Entity`, so a scene load can rewrite it. */
const Follows = defineComponent('Follows', { leader: 'Entity' });

const world = new World();
const wolf = world.create();
world.add(wolf, Health, { current: 30, max: 30 });
world.add(wolf, Hunger, { value: 0 });
// #endregion

// #region system
/** Hunger rises once a second, and health falls while it is high. Each says what it touches. */
const schedule = buildSchedule([
  {
    name: 'hunger',
    writes: [Hunger],
    everyTicks: 60,
    run(view) {
      const hunger = view.view(Hunger, true);
      for (const entity of view.query(Hunger)) {
        const at = hunger.sparse[entity % 2 ** 26] ?? 0;
        (hunger.value as Float32Array)[at] = ((hunger.value as Float32Array)[at] ?? 0) + 1;
      }
    },
  },
  {
    name: 'starve',
    reads: [Hunger],
    writes: [Health],
    everyTicks: 60,
    after: ['hunger'],
    run(view) {
      for (const entity of view.query(Hunger, Health)) {
        if ((view.read(entity, Hunger, 'value') as number) < 50) continue;
        const current = view.read(entity, Health, 'current') as number;
        view.write(entity, Health, 'current', current - 1);
        if (current <= 1) view.destroy(entity);
      }
    },
  },
]);

/** One fixed step: the schedule, at the tick the loop is on. */
export function tick(count: number): void {
  runSchedule(world, schedule, count);
}
// #endregion

// #region prefab
/** A pack: a leader, and followers made from one prefab with a handle to it written after. */
const pupPrefab = definePrefab('pup', [
  [Health, { current: 10, max: 10 }],
  [Follows, {}],
]);
const pups: Entity[] = [0, 1, 2].map(() => {
  const pup = instantiate(world, pupPrefab, { Health: { max: 12 } });
  world.write(pup, Follows, 'leader', wolf);
  return pup;
});
// #endregion

// #region scene
/** A save names the component types it holds; a load is handed the same, and refuses in words. */
export function save(): string {
  return JSON.stringify(serializeWorld(world, [Health, Hunger, Follows]));
}

export function load(text: string): World {
  const fresh = new World();
  const result = deserializeWorld(fresh, JSON.parse(text) as SerializedScene, [
    Health,
    Hunger,
    Follows,
  ]);
  if (!result.loaded) throw new Error(result.reason);
  return fresh;
}
// #endregion

// #region handles
/** A handle is one number: which slot, and how many times that slot has been reused. */
export function describe(entity: Entity): string {
  return `slot ${entityIndex(entity)}, use ${entityGeneration(entity)}, ${world.alive(entity) ? 'alive' : 'gone'}`;
}
// #endregion

export { pups };
