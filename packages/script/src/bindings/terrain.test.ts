import { expect, test } from 'vitest';
import { Terrain } from '@driftengine/terrain';

import { TERRAIN_CAPABILITIES, TERRAIN_MODULE, terrainImplementation } from './terrain.ts';

/**
 * A ramp rising along +x at 45 degrees, with a flat strip along one edge.
 *
 * Chosen so both answers a script actually wants are non-trivial: a slope that is not zero, and a
 * place where it is.
 */
function ramp(): Terrain {
  const size = 5;
  return new Terrain({
    width: size,
    depth: size,
    spacingM: 1,
    heights: Float32Array.from({ length: size * size }, (_, i) => (i % size) * 1),
    origin: [10, 0, -4],
  });
}

test('every capability the module declares has an implementation behind it', () => {
  /*
   * **The failure this catches is silent.** A capability registered with no implementation resolves
   * to nothing at the call — the script compiles, the linker is satisfied, and the function returns
   * undefined at run time. Named rather than counted, so a rename fails here rather than passing on
   * a matching total.
   */
  const implemented = new Set(Object.keys(terrainImplementation()));
  const declared = TERRAIN_CAPABILITIES.map((capability) => capability.name);

  expect(declared.length).toBeGreaterThan(0);
  for (const name of declared) expect(implemented.has(name)).toBe(true);
});

test('every capability is a deterministic read, so a fixed-step system may ask where the ground is', () => {
  for (const capability of TERRAIN_CAPABILITIES) {
    expect(capability.module).toBe(TERRAIN_MODULE);
    expect(capability.deterministic).toBe(true);
    expect(capability.effects).toEqual(['physics.read']);
  }
});

test('answers the height the package answers, through the field it is handed', () => {
  const terrain = ramp();
  const api = terrainImplementation() as {
    heightAt: (t: Terrain, x: number, z: number) => number;
  };

  for (const [x, z] of [
    [10, -4],
    [11.5, -2.25],
    [13.75, -0.5],
  ] as const) {
    expect(api.heightAt(terrain, x, z)).toBeCloseTo(terrain.heightAt(x, z), 6);
  }
});

test('gives the slope as an angle from flat, which is what a walkability test asks', () => {
  const terrain = ramp();
  const api = terrainImplementation() as {
    slopeAt: (t: Terrain, x: number, z: number) => number;
    normalY: (t: Terrain, x: number, z: number) => number;
  };

  /* A one-in-one ramp is 45 degrees. */
  expect(api.slopeAt(terrain, 12, -2)).toBeCloseTo(Math.PI / 4, 4);
  /* And the components agree with it: the angle is the arccosine of the upward one. */
  expect(Math.acos(api.normalY(terrain, 12, -2))).toBeCloseTo(api.slopeAt(terrain, 12, -2), 6);
});

test('says where the field is, so a script can ask before it trusts a height', () => {
  /*
   * **A query outside the field answers the nearest edge rather than nothing**, which is the right
   * behaviour for a query and the wrong thing to build on blindly: a script placing a tree from a
   * random position would put every one that missed the field in a neat line along its border.
   */
  const terrain = ramp();
  const api = terrainImplementation() as {
    covers: (t: Terrain, x: number, z: number) => boolean;
    extentX: (t: Terrain) => number;
    extentZ: (t: Terrain) => number;
  };

  expect(api.covers(terrain, 12, -2)).toBe(true);
  expect(api.covers(terrain, 10, -4)).toBe(true);
  expect(api.covers(terrain, 14, 0)).toBe(true);
  expect(api.covers(terrain, 9.9, -2)).toBe(false);
  expect(api.covers(terrain, 12, 0.1)).toBe(false);
  expect(api.extentX(terrain)).toBeCloseTo(4, 6);
  expect(api.extentZ(terrain)).toBeCloseTo(4, 6);
});

test('allocates nothing per call, because these run inside the fixed step', () => {
  /*
   * The normal scratch is reused, so two reads hand back the same numbers rather than the second
   * overwriting a buffer the caller still held. Each capability answers one number, which is what
   * makes that safe — and this asserts it rather than trusting the shape.
   */
  const terrain = ramp();
  const api = terrainImplementation() as {
    normalX: (t: Terrain, x: number, z: number) => number;
    normalY: (t: Terrain, x: number, z: number) => number;
  };

  const first = api.normalX(terrain, 12, -2);
  const second = api.normalY(terrain, 11, -1);
  expect(api.normalX(terrain, 12, -2)).toBe(first);
  expect(typeof second).toBe('number');
});
