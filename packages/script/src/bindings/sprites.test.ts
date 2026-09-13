import { expect, test } from 'vitest';
import { createSpriteBatch, createTilemap, gridSheet, setTile, spriteRun } from '@driftengine/ui2d';

import { SPRITES_CAPABILITIES, SPRITES_MODULE, spritesImplementation } from './sprites.ts';

const SHEET = gridSheet(3, 32, 32, 16, 16);

test('every capability the module declares has an implementation behind it', () => {
  /*
   * **The failure this catches is silent.** A capability registered with no implementation resolves
   * to nothing at the call — the script compiles, the linker is satisfied, and the function returns
   * undefined at run time. Named rather than counted, so a rename fails here rather than passing on
   * a matching total.
   */
  const implemented = new Set(Object.keys(spritesImplementation()));
  const declared = SPRITES_CAPABILITIES.map((capability) => capability.name);

  expect(declared.length).toBeGreaterThan(0);
  for (const name of declared) expect(implemented.has(name)).toBe(true);
});

/*
 * The line the module turns on: putting a quad in a batch is a change to the *view*, so a
 * `@deterministic` system may not do it; asking what is in a cell is a read of state the simulation
 * already produced, so it may. A binding that declared a draw deterministic would let a fixed-step
 * system draw, which is the thing the annotation exists to forbid.
 */
test('a draw is a scene write and outside the fixed step; a read is inside it', () => {
  for (const capability of SPRITES_CAPABILITIES) {
    expect(capability.module).toBe(SPRITES_MODULE);
    const writes = capability.effects.includes('scene.write');
    expect(capability.effects).toEqual(writes ? ['scene.write'] : ['scene.read']);
    expect(capability.deterministic).toBe(!writes);
  }
});

test('a sprite lands where the script put it, on the texture it named', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const batch = createSpriteBatch(8);
  (api['sprite'] as (b: unknown, t: number, x: number, y: number, w: number, h: number) => void)(
    batch,
    2,
    10,
    20,
    30,
    40,
  );
  expect(batch.count).toBe(1);
  expect(spriteRun(batch, 0).texture).toBe(2);
  // Origin, at the end of the instance: the corner the two edges grow from.
  expect(batch.instances[12]).toBe(10);
  expect(batch.instances[13]).toBe(20);
});

test('a tint reaches the instance rather than being dropped on the way', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const batch = createSpriteBatch(8);
  (
    api['tinted'] as (
      b: unknown,
      t: number,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
      g: number,
      b2: number,
      a: number,
    ) => void
  )(batch, 0, 0, 0, 1, 1, 0.25, 0.5, 0.75, 1);
  expect(Array.from(batch.instances.subarray(8, 12))).toEqual([0.25, 0.5, 0.75, 1]);
});

test('a frame draws from the sheet its own texture is on, not from slot zero', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const batch = createSpriteBatch(8);
  (
    api['frame'] as (
      b: unknown,
      s: unknown,
      f: number,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => void
  )(batch, SHEET, 1, 0, 0, 16, 16);
  expect(spriteRun(batch, 0).texture).toBe(3);
  // Frame 1 of a two-by-two grid is the top-right quadrant.
  expect(Array.from(batch.instances.subarray(4, 8))).toEqual([0.5, 0, 1, 0.5]);
});

test('a name answers its index, and a name the sheet does not have answers -1', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const named = api['named'] as (s: unknown, n: string) => number;
  expect(named(SHEET, '2')).toBe(2);
  expect(named(SHEET, 'nowhere')).toBe(-1);
});

test('a tilemap draws what the view reaches and answers how many', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const map = createTilemap(100, 100, 10, 10);
  map.tiles.fill(0);
  const batch = createSpriteBatch(64);
  const drawn = (
    api['tilemap'] as (
      b: unknown,
      m: unknown,
      s: unknown,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => number
  )(batch, map, SHEET, 0, 0, 30, 20);
  expect(drawn).toBe(6);
  expect(batch.count).toBe(6);
});

test('reads and writes a cell, and answers empty for one outside the map', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const map = createTilemap(4, 3, 10, 10);
  (api['setTile'] as (m: unknown, c: number, r: number, t: number) => void)(map, 2, 1, 7);
  const tile = api['tile'] as (m: unknown, c: number, r: number) => number;
  expect(tile(map, 2, 1)).toBe(7);
  expect(tile(map, 9, 9)).toBe(-1);
  expect((api['columns'] as (m: unknown) => number)(map)).toBe(4);
  expect((api['rows'] as (m: unknown) => number)(map)).toBe(3);
});

/*
 * A batch that overflows drops draws silently, and a script with no way to see the count finds out
 * by noticing something missing from a corner of the screen.
 */
test('a script can see the batch overflow', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const batch = createSpriteBatch(2);
  const map = createTilemap(4, 4, 10, 10);
  map.tiles.fill(0);
  setTile(map, 0, 0, 1);
  (
    api['tilemap'] as (
      b: unknown,
      m: unknown,
      s: unknown,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => number
  )(batch, map, SHEET, 0, 0, 40, 40);
  expect((api['count'] as (b: unknown) => number)(batch)).toBe(2);
  expect((api['dropped'] as (b: unknown) => number)(batch)).toBe(14);
});

test('drawing allocates nothing per call, so a script may draw in a frame loop', () => {
  const api = spritesImplementation() as Record<string, (...args: never[]) => unknown>;
  const batch = createSpriteBatch(64);
  const sprite = api['sprite'] as (
    b: unknown,
    t: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => void;
  const storage = batch.instances;
  for (let i = 0; i < 64; i += 1) sprite(batch, 0, i, 0, 1, 1);
  expect(batch.instances).toBe(storage);
  expect(batch.dropped).toBe(0);
});
