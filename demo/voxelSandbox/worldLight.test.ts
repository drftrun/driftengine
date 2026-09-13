import { describe, expect, it } from 'vitest';

import { Block } from './blocks';
import { World } from './world';
import { MAX_LIGHT, WorldLight } from './worldLight';

const sky = (packed: number): number => packed >> 4;
const block = (packed: number): number => packed & 15;

/** A world with a flat roof built over one column, so there is a genuine shadow to measure. */
const roofed = (): { world: World; light: WorldLight; y: number } => {
  const world = new World(1337);
  const y = world.surfaceY(4, 4);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) world.setBlock(4 + dx, y + 4, 4 + dz, Block.STONE);
  }
  return { world, light: new WorldLight(world), y };
};

describe('light through the world', () => {
  it('gives open sky the full sky value', () => {
    const world = new World(1337);
    const light = new WorldLight(world);
    expect(sky(light.getPacked(4, world.surfaceY(4, 4) + 6, 4))).toBe(MAX_LIGHT);
  });

  it('darkens a cell roofed over', () => {
    /* A cave as bright as a hilltop is the failure this module exists to prevent, and it is
       invisible until somebody walks into one. */
    const { light, y } = roofed();
    expect(sky(light.getPacked(4, y + 1, 4))).toBeLessThan(MAX_LIGHT);
  });

  it('lets sky light reach further in under the edge of a roof than under its middle', () => {
    /* Sideways travel costs a level a block. If it did not, a roof would cast no gradient and
       shade would be a hard binary edge. */
    const { light, y } = roofed();
    const underEdge = sky(light.getPacked(7, y + 1, 4));
    const underMiddle = sky(light.getPacked(4, y + 1, 4));
    expect(underEdge).toBeGreaterThan(underMiddle);
  });

  it('spreads block light outward and falls off with distance', () => {
    const world = new World(1337);
    const y = world.surfaceY(8, 8) + 2;
    world.setBlock(8, y, 8, Block.GLOWSTONE);
    const light = new WorldLight(world);
    const near = block(light.getPacked(9, y, 8));
    expect(near).toBeGreaterThan(0);
    expect(block(light.getPacked(12, y, 8))).toBeLessThan(near);
  });

  it('emits no block light at all before a glowing block is placed', () => {
    /* Worldgen never emits, and the whole full-height emitter scan is skipped while that holds. */
    const world = new World(1337);
    expect(world.anyEmitters).toBe(false);
    expect(block(new WorldLight(world).getPacked(4, world.surfaceY(4, 4) + 1, 4))).toBe(0);
  });

  it('never reports more than the maximum on either channel', () => {
    const world = new World(1337);
    const y = world.surfaceY(4, 4);
    world.setBlock(4, y + 1, 4, Block.GLOWSTONE);
    const packed = new WorldLight(world).getPacked(4, y + 2, 4);
    expect(sky(packed)).toBeLessThanOrEqual(MAX_LIGHT);
    expect(block(packed)).toBeLessThanOrEqual(MAX_LIGHT);
  });

  it('spends no more than its budget of floods in a frame', () => {
    /* Meshing a cold chunk cascades a flood for it and all eight neighbours. The budget is what
       spreads that over frames instead of stalling one. */
    const world = new World(1337);
    const light = new WorldLight(world);
    light.beginFrame();
    expect(light.warmFor(0, 0, 4)).toBe(false);
    light.beginFrame();
    expect(light.warmFor(0, 0, 9)).toBe(true);
  });

  it('forgets a neighbour only when an edit is on their shared seam', () => {
    const world = new World(1337);
    const light = new WorldLight(world);
    light.beginFrame();
    light.warmFor(0, 0, Number.POSITIVE_INFINITY);

    /* An interior edit: only its own chunk is dropped, so the eight neighbours stay warm. */
    light.invalidateEdit(8, 8);
    light.beginFrame();
    light.warmFor(0, 0, 1);
    expect(light.warmFor(0, 0, 1)).toBe(true);
  });
});
