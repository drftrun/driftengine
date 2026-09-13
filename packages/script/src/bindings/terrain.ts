import { exactAcos } from '@driftengine/core';
import type { Terrain } from '@driftengine/terrain';
import type { CapabilityDefinition, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const TERRAIN_MODULE = 'drift/terrain';

/**
 * `drift/terrain` — where the ground is, and which way it faces.
 *
 * **The linker has refused this module by name since the language shipped**, saying it waits on
 * Track L. It does not any more: `@driftengine/terrain` ships a heightfield whose query answers the
 * surface that is *drawn*, which is the one property a script needs to be able to trust. A script
 * placing a tree, deciding whether a slope is walkable, or dropping a dead body on the ground is
 * asking this module and nothing else.
 *
 * **Every capability here is a read of static data**, so all of them are deterministic and a
 * `@deterministic` system may ask where the ground is. That is the point — deciding where to stand
 * belongs inside the fixed step.
 *
 * ## The effect these are declared under, and why it is not `terrain.read`
 *
 * **The language names no terrain effect.** `Effect` in `driftscript`'s registry runs from `pure`
 * through `network.write`, and there is no `terrain.*` in it — `drift/terrain` is in
 * `SPECIFIED_MODULES` and was missed when the effects were named. `drift/behavior` was in exactly
 * this position and the language fixed it the other way round, naming `behavior.read` and
 * `behavior.write` in 2026-08-28 *ahead of any provider*, with a comment saying it was so the track
 * that built it would not need a language release first. Terrain did not get that.
 *
 * **This engine does not move the language's version**, which the navigation binding states where it
 * meets the same wall. So the choice was between shipping under an effect that exists and not
 * shipping.
 *
 * **`physics.read` is the one it ships under, and it is a description rather than a borrowing.**
 * The terrain package's own tests assert that the surface a query answers, the surface that is
 * drawn and the surface a body collides with are one surface — a ray cast against the mesh built
 * from a patch lands where `heightAt` says the ground is. So "ask the terrain how high the ground
 * is" and "cast a ray down and see what you hit" are the same question about the same surface, and
 * the second is `physics.read` already. It is also in `DETERMINISTIC_EFFECTS`, which is what a
 * script needs.
 *
 * **What would change it**: the language naming `terrain.read`. `docs/IMPROVEMENTS.md` carries that
 * as a one-line change on the language's side and a one-word change here.
 */
export const TERRAIN_TYPES: readonly OpaqueType[] = [
  {
    module: TERRAIN_MODULE,
    name: 'Terrain',
    doc: 'A heightfield: ask it how high the ground is and which way it faces.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: TERRAIN_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: ['physics.read'],
    deterministic: true,
    doc,
    implementation: `${TERRAIN_MODULE}.${name}`,
  });

const AT = [
  { name: 'terrain', type: 'Terrain' },
  { name: 'x', type: 'float' },
  { name: 'z', type: 'float' },
] as const;

export const TERRAIN_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'heightAt',
    AT,
    'float',
    'How high the ground is at a place, in metres. The surface that is drawn, not an approximation of it, so a thing put here stands on what you can see.',
  ),
  /*
   * **Three calls rather than one that returns a vector**, which is the shape `drift/physics`
   * already uses for a body's position and `drift/navigation` for a steer point: the language
   * returns one value, and the alternative is a search-then-read pair with state between the two.
   * A normal is cheap enough that three independent reads beat a hidden cursor.
   */
  define('normalX', AT, 'float', 'Which way the ground faces at a place, along x.'),
  define('normalY', AT, 'float', 'The same, along y. One on the flat and smaller on a slope.'),
  define('normalZ', AT, 'float', 'The same, along z.'),
  /*
   * **The slope as an angle, because that is what a script actually asks.** Every use of a terrain
   * normal in a script is "is this too steep" — for a footpath, for a building, for whether a cart
   * rolls — and each of those written from three components is an `acos` of a dot product a script
   * author has to get right. Radians from vertical: zero on the flat.
   */
  define(
    'slopeAt',
    AT,
    'float',
    'How steep the ground is at a place, in radians from flat. Zero on the level; a quarter turn on a wall.',
  ),
  define(
    'covers',
    AT,
    'bool',
    'Whether a place is over the field at all. A query outside it answers the nearest edge rather than nothing, so ask this first where it matters.',
  ),
  /*
   * **`f32` rather than `float`, and the language is right to insist.** `float` is width-polymorphic
   * and takes its width from a `float` parameter; these take none, so nothing would fix it. A field
   * is stored as `Float32Array`, so `f32` is what the number actually is rather than a width chosen
   * to satisfy a checker.
   */
  define(
    'extentX',
    [{ name: 'terrain', type: 'Terrain' }],
    'f32',
    'How far the field reaches along x, in metres.',
  ),
  define(
    'extentZ',
    [{ name: 'terrain', type: 'Terrain' }],
    'f32',
    'How far the field reaches along z, in metres.',
  ),
];

/**
 * **No services, and that is the shape rather than an omission.**
 *
 * Every capability here takes the field it is asking about, so the module needs nothing from the
 * host to answer — the terrain reaches a script the way a `NavGraph` does, as a resource handed in
 * through `uses`. `drift/animation` made the same move on 2026-08-28 when `blendTree` was replaced
 * by `blendSet` and `blendAt`: drive a thing the host built, rather than offering to build one out
 * of values the language has no shape for.
 *
 * So this is registered unconditionally, and a script that never receives a `Terrain` simply never
 * calls it.
 */
export function terrainImplementation(): Record<string, unknown> {
  /* One scratch for every normal read, because these run inside the fixed step and the frame rules
     forbid allocating there. Reused rather than returned: each capability answers one number. */
  const normal = new Float32Array(3);

  const at = (terrain: Terrain, x: number, z: number): Float32Array =>
    terrain.normalAt(x, z, normal);

  return {
    heightAt: (terrain: Terrain, x: number, z: number) => terrain.heightAt(x, z),
    normalX: (terrain: Terrain, x: number, z: number) => at(terrain, x, z)[0] ?? 0,
    normalY: (terrain: Terrain, x: number, z: number) => at(terrain, x, z)[1] ?? 1,
    normalZ: (terrain: Terrain, x: number, z: number) => at(terrain, x, z)[2] ?? 0,
    slopeAt: (terrain: Terrain, x: number, z: number) => {
      /*
       * `exactAcos` of the upward component, clamped: a normal is a unit vector in exact arithmetic
       * and a hair outside the domain in float, where `acos` answers NaN rather than zero.
       *
       * **`Math.acos` until 2026-09-03, and that was a defect rather than a tidiness point.**
       * `drift/terrain` ships under `physics.read`, which is inside the language's
       * `DETERMINISTIC_EFFECTS`, so a `@deterministic` system asking a hillside how steep it is was
       * receiving a number ECMAScript does not specify — two engines may answer an ulp apart, and
       * the annotation promising the system replays identically was false for anything that
       * branched on the answer. Found by widening `scripts/determinism.mjs` past the one package it
       * had scanned since Track B.
       */
      const up = Math.min(1, Math.max(-1, at(terrain, x, z)[1] ?? 1));
      return exactAcos(up);
    },
    covers: (terrain: Terrain, x: number, z: number) => {
      const u = x - (terrain.origin[0] ?? 0);
      const v = z - (terrain.origin[2] ?? 0);
      return u >= 0 && v >= 0 && u <= terrain.extentX && v <= terrain.extentZ;
    },
    extentX: (terrain: Terrain) => terrain.extentX,
    extentZ: (terrain: Terrain) => terrain.extentZ,
  };
}
