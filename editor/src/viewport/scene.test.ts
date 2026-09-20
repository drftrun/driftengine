import { createSelection, selectOnly } from '@driftengine/tools';
import { expect, test } from 'vitest';

import type { ShellScene } from '../shell.ts';
import { drawViewport, viewportItems, type ViewportItem, type ViewportTarget } from './scene.ts';

/**
 * **The viewport is a scene rather than a row of discs.**
 *
 * What is under test is the description, not the drawing: one call for the captured surface and one
 * per thing in it, in the scene's own order, with the selection marked. A host turns those into its
 * renderer's calls, and a test turns them into a list.
 */

function scene(places: readonly (readonly [number, number, number, number])[]): ShellScene {
  return {
    entities: () => places.map((_, at) => at + 1),
    nameOf: (entity) => `thing ${entity}`,
    radiusOf: (entity) => (places[entity - 1]?.[3] as number) ?? 0,
    positionOf: (entity, out) => {
      const place = places[entity - 1];
      if (place === undefined) return false;
      out[0] = place[0];
      out[1] = place[1];
      out[2] = place[2];
      return true;
    },
    setPosition: () => {},
  };
}

test('EVERY THING IN THE SCENE IS DESCRIBED ONCE, WITH THE SELECTION MARKED', () => {
  const world = scene([
    [1, 2, 3, 0.5],
    [-4, 0, 0, 2],
  ]);
  const selection = createSelection();
  selectOnly(selection, 2);

  const items: ViewportItem[] = [];
  expect(viewportItems(world, selection, items)).toBe(2);
  expect(items[0]?.entity).toBe(1);
  expect(items[0]?.x).toBe(1);
  expect(items[0]?.radius).toBe(0.5);
  expect(items[0]?.selected).toBe(false);
  expect(items[1]?.selected).toBe(true);

  const calls: string[] = [];
  const target: ViewportTarget = {
    surface: () => calls.push('surface'),
    marker: (item) => calls.push(`marker ${item.entity}${item.selected ? ' selected' : ''}`),
  };
  drawViewport(items, 2, target);
  /* The surface first: a capture's own geometry is the subject and the markers annotate it. */
  expect(calls).toEqual(['surface', 'marker 1', 'marker 2 selected']);
});

test('the array is the caller’s and is refilled rather than rebuilt', () => {
  /*
   * **Sixty times a second over every entity in a scene.** A list of fresh objects per frame is
   * exactly the garbage the engine's rules forbid, and the tell is that the objects themselves
   * survive a second call — the same one, written over.
   */
  const world = scene([
    [0, 0, 0, 1],
    [1, 1, 1, 1],
  ]);
  const items: ViewportItem[] = [];
  viewportItems(world, createSelection(), items);
  const first = items[0];
  viewportItems(world, createSelection(), items);
  expect(items[0]).toBe(first);
  expect(items.length).toBe(2);
});

test('an entity the scene has no position for is left out rather than drawn at the origin', () => {
  /*
   * **The origin is a real place**, and something drawn there because its position could not be
   * read is a thing in the middle of the room nobody put there — which reads as a bug in the
   * capture rather than in the viewport.
   */
  const world: ShellScene = {
    entities: () => [1, 2, 3],
    nameOf: () => '',
    radiusOf: () => 1,
    positionOf: (entity, out) => {
      if (entity === 2) return false;
      out[0] = entity;
      out[1] = 0;
      out[2] = 0;
      return true;
    },
    setPosition: () => {},
  };
  const items: ViewportItem[] = [];
  const count = viewportItems(world, createSelection(), items);
  expect(count).toBe(2);
  expect(items[0]?.entity).toBe(1);
  expect(items[1]?.entity).toBe(3);
});
