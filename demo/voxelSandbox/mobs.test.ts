import { describe, expect, it } from 'vitest';

import type { MeshData } from '../../packages/core/src/index';

import { blockDef } from './blocks';
import { Mobs } from './mobs';
import { World } from './world';

/**
 * A renderer that answers what `Mobs` touches at construction and nothing else.
 *
 * `Mobs` bakes one mesh per species in its constructor and draws through the renderer; neither
 * is what these tests are about, so a handle can be any object.
 */
const renderer = {
  createMesh: () => ({}),
  disposeMesh: () => {},
  setMaterial: () => {},
  drawMesh: () => {},
} as never;

/** The same renderer, keeping every `MeshData` it was handed so the geometry can be measured. */
function recordingRenderer(): { renderer: never; baked: MeshData[] } {
  const baked: MeshData[] = [];
  return {
    baked,
    renderer: {
      createMesh: (data: MeshData) => {
        baked.push(data);
        return {};
      },
      disposeMesh: () => {},
      setMaterial: () => {},
      drawMesh: () => {},
    } as never,
  };
}

/** How many triangles are wound against the normal the mesh wrote beside them. */
function backwardsTriangles(data: MeshData): number {
  const { positions, normals, indices } = data;
  const at = (i: number): number[] => [
    positions[i * 3] as number,
    positions[i * 3 + 1] as number,
    positions[i * 3 + 2] as number,
  ];
  let backwards = 0;
  for (let tri = 0; tri < indices.length / 3; tri++) {
    const ia = indices[tri * 3] as number;
    const a = at(ia);
    const b = at(indices[tri * 3 + 1] as number);
    const c = at(indices[tri * 3 + 2] as number);
    const ab = [
      (b[0] as number) - (a[0] as number),
      (b[1] as number) - (a[1] as number),
      (b[2] as number) - (a[2] as number),
    ];
    const ac = [
      (c[0] as number) - (a[0] as number),
      (c[1] as number) - (a[1] as number),
      (c[2] as number) - (a[2] as number),
    ];
    const dot =
      ((ab[1] as number) * (ac[2] as number) - (ab[2] as number) * (ac[1] as number)) *
        (normals[ia * 3] as number) +
      ((ab[2] as number) * (ac[0] as number) - (ab[0] as number) * (ac[2] as number)) *
        (normals[ia * 3 + 1] as number) +
      ((ab[0] as number) * (ac[1] as number) - (ab[1] as number) * (ac[0] as number)) *
        (normals[ia * 3 + 2] as number);
    if (dot <= 0) backwards++;
  }
  return backwards;
}

/**
 * Whether a mob is standing on something, at the block under its feet.
 *
 * Local rather than measured against `surfaceY`, which returns the topmost solid block in the
 * column — a mob under a tree is correctly on the ground with a canopy several blocks above it,
 * and comparing against the canopy would call that sunk.
 */
function standing(world: World, mob: { x: number; y: number; z: number }): boolean {
  const solid = (y: number): boolean =>
    blockDef(world.getBlock(Math.floor(mob.x), y, Math.floor(mob.z)))?.collidable === true;
  return solid(Math.floor(mob.y) - 1) && !solid(Math.floor(mob.y));
}

describe('a mob standing on the ground', () => {
  /**
   * **A mob at rest does not sink into the terrain it spawned on.**
   *
   * A mob standing on the block at index `b` has `y = b + 1`, which is that block's top and the
   * convention `trySpawn` writes. The landing test has to ask whether the block the feet are
   * *entering* is solid — `floor(ny)` — and stand the mob on top of it. Testing `floor(ny) - 1`
   * instead asks about the block below that one and settles the mob a block lower than it
   * started, which is true again on the next tick and every tick after: the mob walks down
   * through the world one block per step until the `y < 1` floor clamp catches it.
   *
   * Measured from a real session: ten mobs, nine of them at `y = 1` with the player standing at
   * `y = 34`. They were being drawn the whole time, thirty-three blocks under the ground.
   */
  it('stays on the surface instead of sinking through it', () => {
    const world = new World(1337);
    const mobs = new Mobs(renderer, world);
    /* The spawn only considers columns whose chunk is already generated. */
    world.getBlock(0, 40, 0);
    for (let cx = -32; cx <= 32; cx += 16) {
      for (let cz = -32; cz <= 32; cz += 16) world.getBlock(cx, 40, cz);
    }
    mobs.populate(0, 0);
    expect(mobs.count, 'nothing spawned, so the test cannot say anything').toBeGreaterThan(0);

    const before = mobs.positions();
    /* Two seconds at the fixed step, which is far longer than a one-block-per-tick sink needs. */
    for (let step = 0; step < 120; step++) mobs.update(1 / 60, 0, 40, 0);

    const sunk = mobs
      .positions()
      .filter((mob) => !standing(world, mob))
      .map((mob) => `(${mob.x.toFixed(1)}, ${mob.y.toFixed(1)}, ${mob.z.toFixed(1)})`);

    expect(before.length).toBeGreaterThan(0);
    expect(sunk, 'these mobs are inside terrain or standing on nothing').toEqual([]);
  });
});

/**
 * **A mob's boxes are wound the way the renderer culls**, the same rule the terrain mesher is
 * held to. The engine culls back faces with a counter-clockwise front on both backends, so a box
 * wound the other way is drawn inside out: the near faces are discarded and the far ones survive,
 * which reads as a flat dark slab where an animal should be.
 *
 * It survived because `SceneTarget.resolve` left `CULL_FACE` disabled, so WebGL2 drew every mob
 * double-sided and the outside faces showed regardless.
 */
describe('mob geometry', () => {
  it('winds every box face counter-clockwise from outside', () => {
    const { renderer: recorder, baked } = recordingRenderer();
    new Mobs(recorder, new World(1337));
    expect(baked.length, 'no species were baked, so nothing was measured').toBeGreaterThan(0);
    const offenders = baked
      .map((data, species) => ({ species, backwards: backwardsTriangles(data) }))
      .filter((entry) => entry.backwards > 0);
    expect(offenders).toEqual([]);
  });
});
