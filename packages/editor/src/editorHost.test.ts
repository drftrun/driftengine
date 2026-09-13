import { SceneNode } from '@driftengine/core';
import { World, defineComponent } from '@driftengine/entities';
import type { Entity } from '@driftengine/entities';
import { expect, test } from 'vitest';
import { EditorHost } from './editorHost.ts';

const Health = defineComponent('HostHealth', { current: 'f32' });
const TYPES = [Health];

function bound(): { host: EditorHost; world: World; entities: Entity[] } {
  const world = new World();
  const entities = [world.create(), world.create(), world.create()];
  entities.forEach((entity, at) => world.add(entity, Health, { current: 10 * (at + 1) }));
  return { host: new EditorHost({ world, types: TYPES }), world, entities };
}

/** Every entity any bound type holds, which is the only enumeration of a world's live set. */
function population(world: World): number {
  return world.store(Health).size;
}

test('an editor starts in edit mode and does not simulate', () => {
  const { host } = bound();
  expect(host.mode).toBe('edit');
  expect(host.shouldSimulate()).toBe(false);
});

test('play simulates and pause stops simulating', () => {
  const { host } = bound();
  expect(host.play()).toBe(true);
  expect(host.mode).toBe('play');
  expect(host.shouldSimulate()).toBe(true);
  host.pause();
  expect(host.mode).toBe('paused');
  expect(host.shouldSimulate()).toBe(false);
});

/*
 * A step is exactly one tick, which is what makes it a step. Expressing it as a duration would
 * advance a variable number of ticks depending on the frame it landed in.
 */
test('a step simulates exactly one tick and then stops', () => {
  const { host } = bound();
  host.play();
  host.step();
  expect(host.mode).toBe('paused');
  expect(host.shouldSimulate()).toBe(true);
  expect(host.shouldSimulate()).toBe(false);
  expect(host.shouldSimulate()).toBe(false);
});

test('stepping twice runs two ticks, one each', () => {
  const { host } = bound();
  host.play();
  host.step();
  expect(host.shouldSimulate()).toBe(true);
  host.step();
  expect(host.shouldSimulate()).toBe(true);
  expect(host.shouldSimulate()).toBe(false);
});

test('a step in edit mode does nothing, because there is nothing to step', () => {
  const { host } = bound();
  host.step();
  expect(host.mode).toBe('edit');
  expect(host.shouldSimulate()).toBe(false);
});

test('play from paused resumes without taking a second snapshot', () => {
  const { host, world, entities } = bound();
  host.play();
  world.write(entities[0] as Entity, Health, 'current', 999);
  host.pause();
  host.play();
  host.stop();
  /* The snapshot is the one taken before the first play, so the 999 is gone. */
  expect(world.store(Health).size).toBe(3);
  const restored = world.store(Health).dense;
  const values = [0, 1, 2].map((at) => world.read(restored[at] as Entity, Health, 'current'));
  expect(values).toEqual([10, 20, 30]);
});

/*
 * The whole of play-in-editor: change the world, stop, and get the authored world back.
 */
test('stop restores the values play changed', () => {
  const { host, world, entities } = bound();
  host.play();
  world.write(entities[0] as Entity, Health, 'current', 1);
  expect(host.stop()).toBe(true);
  const dense = world.store(Health).dense;
  const values = [0, 1, 2].map((at) => world.read(dense[at] as Entity, Health, 'current'));
  expect(values.sort((a, b) => (a as number) - (b as number))).toEqual([10, 20, 30]);
});

/*
 * **The assertion `deserializeWorld` alone fails.** It creates entities rather than replacing them,
 * so a stop that only loads leaves the world holding what was authored *and* what play produced —
 * a duplication that grows every time somebody presses stop.
 */
test('stop leaves the world the size it was, not twice the size', () => {
  const { host, world } = bound();
  expect(population(world)).toBe(3);
  host.play();
  host.stop();
  expect(population(world)).toBe(3);
  host.play();
  host.stop();
  expect(population(world)).toBe(3);
});

test('an entity created during play is gone after a stop', () => {
  const { host, world } = bound();
  host.play();
  const spawned = world.create();
  world.add(spawned, Health, { current: 500 });
  expect(population(world)).toBe(4);
  host.stop();
  expect(population(world)).toBe(3);
});

test('an entity destroyed during play comes back', () => {
  const { host, world, entities } = bound();
  host.play();
  world.destroy(entities[1] as Entity);
  expect(population(world)).toBe(2);
  host.stop();
  expect(population(world)).toBe(3);
});

/* The control: without a stop, what play did stands. */
test('a play that is not stopped keeps what it changed', () => {
  const { host, world, entities } = bound();
  host.play();
  world.write(entities[0] as Entity, Health, 'current', 1);
  host.pause();
  expect(world.read(entities[0] as Entity, Health, 'current')).toBe(1);
});

/*
 * **Every handle changes across a stop**, because the restored entities are new ones. A selection
 * held as a handle is stale the moment play ends — pointing at nothing, or at whatever reused the
 * slot, which is the worse of the two because it looks like it worked.
 */
test('a selected entity survives a stop by its index rather than its handle', () => {
  const { host, world, entities } = bound();
  host.selectEntity(entities[1] as Entity);
  host.play();
  host.stop();
  expect(host.entity).not.toBe(null);
  expect(host.entity).not.toBe(entities[1]);
  expect(world.read(host.entity as Entity, Health, 'current')).toBe(20);
});

test('a selection made during play on an entity play created is emptied by the stop', () => {
  const { host, world } = bound();
  host.play();
  const spawned = world.create();
  world.add(spawned, Health, { current: 500 });
  host.selectEntity(spawned);
  host.stop();
  expect(host.entity).toBe(null);
  expect(host.inspector.showing).toBe('nothing');
});

test('an unbound editor refuses to play and says so rather than pretending', () => {
  const host = new EditorHost();
  expect(host.play()).toBe(false);
  expect(host.mode).toBe('edit');
  expect(host.stop()).toBe(false);
});

test('selecting a node shows its transform and moves the gizmo onto it', () => {
  const { host } = bound();
  const node = new SceneNode();
  node.setPosition(4, 5, 6);
  host.select(node);
  expect(host.tree.selected).toBe(node);
  expect(host.inspector.showing).toBe('node');
  expect(Array.from(host.gizmo.position)).toEqual([4, 5, 6]);
});

test('selecting nothing empties the inspector', () => {
  const { host } = bound();
  host.select(new SceneNode());
  host.select(null);
  expect(host.tree.selected).toBe(null);
  expect(host.inspector.showing).toBe('nothing');
});

test('selecting a node clears an entity selection and the other way round', () => {
  const { host, entities } = bound();
  host.selectEntity(entities[0] as Entity);
  expect(host.entity).not.toBe(null);
  host.select(new SceneNode());
  expect(host.entity).toBe(null);
  host.selectEntity(entities[0] as Entity);
  expect(host.tree.selected).toBe(null);
});

/*
 * Through the node's setters, for the reason `inspector.ts` gives: writing the arrays leaves the
 * world matrix stale and the node draws where it used to be.
 */
test('applying the gizmo moves the node and its world matrix follows', () => {
  const { host } = bound();
  const node = new SceneNode();
  host.select(node);
  host.gizmo.position.set([9, 0, 0]);
  host.applyGizmo();
  node.updateWorld();
  expect(node.position[0]).toBe(9);
  expect(node.worldMatrix[12]).toBe(9);
  expect(host.inspector.fields[0]!.value).toBe(9);
});

test('applying the gizmo with nothing selected does nothing', () => {
  const { host } = bound();
  host.gizmo.position.set([9, 0, 0]);
  expect(() => host.applyGizmo()).not.toThrow();
});

test('syncing the gizmo takes the rotation and the scale too', () => {
  const { host } = bound();
  const node = new SceneNode();
  node.setScale(2, 3, 4);
  node.rotation.set([0, 0.7071, 0, 0.7071]);
  host.select(node);
  expect(Array.from(host.gizmo.scale)).toEqual([2, 3, 4]);
  expect(host.gizmo.rotation[1]).toBeCloseTo(0.7071, 5);
});
