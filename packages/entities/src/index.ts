/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * The entity model's public surface.
 *
 * **This package imports no other engine package**, which is a stronger rule than the one every
 * package obeys and is the reason it can be depended on by anything. An entity model that knew what
 * a `Transform` was would be an entity model that knew it had a scene — and the whole argument for
 * declared reads and writes is that a declaration is about a component *id* rather than about what
 * the component means.
 *
 * It declares no component types at all, for the same reason. A consumer writes the ones its world
 * needs, or takes them from whichever package owns the subsystem.
 *
 * The one dependency is `driftscript`, for `Schema` and `migrate` — 406 bytes gzipped, measured.
 * That is the design's spine rather than a convenience: storage layout, serialization, migration
 * and a future inspector all read **one** description of a component, so there is no second one to
 * keep in sync.
 */
export type { ComponentStoreOptions, ComponentType, StoreSnapshot } from './store.ts';
export { ComponentStore, createStoreSnapshot, defineComponent } from './store.ts';

export type { ComponentView, ViewColumn } from './view.ts';

export type { CursorHost } from './query.ts';
export { QueryCursor } from './query.ts';

export type { WorldSnapshot } from './world.ts';
export { World, createWorldSnapshot } from './world.ts';

export type { SystemDefinition, SystemView } from './system.ts';
export { BoundSystem } from './system.ts';

export type { Schedule } from './schedule.ts';
export { buildSchedule, runSchedule } from './schedule.ts';

export type { Prefab } from './prefab.ts';
export { definePrefab, instantiate } from './prefab.ts';

export type { LoadResult, SerializedScene } from './scene.ts';
export { deserializeWorld, serializeWorld } from './scene.ts';

export type { AllocatorSnapshot, Entity, EntityAllocatorOptions } from './entity.ts';
export {
  ENTITY_GENERATION_CEILING,
  ENTITY_INDEX_CEILING,
  EntityAllocator,
  createAllocatorSnapshot,
  entityGeneration,
  entityIndex,
  packEntity,
} from './entity.ts';
