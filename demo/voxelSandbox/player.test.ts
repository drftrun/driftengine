import { describe, expect, it } from 'vitest';

import { Camera } from '../../packages/core/src/index';

import { Block } from './blocks';
import { Player } from './player';
import { World } from './world';

const STILL = { forward: 0, strafe: 0, jump: false, sprint: false, flying: false };

/** A player dropped at spawn and left to settle on the ground. */
const standing = (): { world: World; player: Player } => {
  const world = new World(1337);
  const player = new Player(world, world.findSpawn(0, 0));
  for (let i = 0; i < 180; i++) player.step(1 / 60, STILL);
  return { world, player };
};

describe('the player body', () => {
  it('walks where the camera is pointing', () => {
    /*
     * The one thing a screenshot cannot catch, and it shipped inverted once: `Camera` builds
     * forward as (sinYaw·cosPitch, sinPitch, −cosYaw·cosPitch), and a body that disagreed with
     * it walked somewhere other than the view. Asserted against the engine's own camera rather
     * than against a copy of the formula, so the two cannot drift apart.
     */
    const camera = new Camera();
    const { player } = standing();
    for (const yaw of [0, 0.7, -1.9, 2.6]) {
      player.yaw = yaw;
      camera.yaw = yaw;
      camera.pitch = 0;
      camera.updateMatrices(1);

      const before: [number, number] = [player.position[0], player.position[2]];
      player.step(1 / 60, { ...STILL, forward: 1, flying: true });
      const moved = [player.position[0] - before[0], player.position[2] - before[1]];
      const distance = Math.hypot(moved[0]!, moved[1]!);
      expect(distance, `no movement at yaw ${yaw}`).toBeGreaterThan(0);

      /* Same direction as the camera's own flattened forward, to within rounding. */
      const flat = Math.hypot(camera.forward[0], camera.forward[2]);
      expect(moved[0]! / distance).toBeCloseTo(camera.forward[0] / flat, 5);
      expect(moved[1]! / distance).toBeCloseTo(camera.forward[2] / flat, 5);
    }
  });

  it('strafes to the right of where it is pointing', () => {
    const { player } = standing();
    player.yaw = 0;
    const before = player.position[0];
    player.step(1 / 60, { ...STILL, strafe: 1, flying: true });
    /* At yaw 0 the camera looks down −Z, so right is +X. */
    expect(player.position[0]).toBeGreaterThan(before);
  });

  it('falls until it lands, and then stops', () => {
    const { player } = standing();
    expect(player.onGround).toBe(true);
    const resting = player.position[1];
    player.step(1 / 60, STILL);
    expect(player.position[1]).toBeCloseTo(resting, 5);
  });

  it('does not walk through a wall', () => {
    /* Collision is invisible when it breaks: a player who clips into terrain looks fine for one
       frame and is underground on the next. */
    const { world, player } = standing();
    const x = Math.floor(player.position[0]);
    const z = Math.floor(player.position[2]);
    const y = Math.floor(player.position[1]);
    for (let dy = 0; dy < 3; dy++) world.setBlock(x, y + dy, z - 1, Block.STONE);
    player.yaw = 0;
    const before = player.position[2];
    for (let i = 0; i < 60; i++) player.step(1 / 60, { ...STILL, forward: 1 });
    /* Walking at a wall one cell away should not carry the body past it. */
    expect(player.position[2]).toBeGreaterThan(before - 1);
  });

  it('jumps and comes back down', () => {
    const { player } = standing();
    const ground = player.position[1];
    player.step(1 / 60, { ...STILL, jump: true });
    expect(player.position[1]).toBeGreaterThan(ground);
    for (let i = 0; i < 300; i++) player.step(1 / 60, STILL);
    expect(player.position[1]).toBeCloseTo(ground, 3);
  });

  it('knows which blocks its own body occupies', () => {
    /* Placement checks this. Without it, a block placed at your feet buries you. */
    const { player } = standing();
    const bx = Math.floor(player.position[0]);
    const by = Math.floor(player.position[1]);
    const bz = Math.floor(player.position[2]);
    expect(player.intersectsBlock(bx, by, bz)).toBe(true);
    expect(player.intersectsBlock(bx + 4, by, bz)).toBe(false);
  });

  it('never starts inside a solid block', () => {
    /* findSpawn checks the column it examines, and a tree stamped from a neighbour's margin can
       occupy that space anyway. Being stuck is unrecoverable: the axis-by-axis resolve refuses
       every direction at once, so a body cannot walk out of a wall it began in. */
    const world = new World(1337);
    const buried = { x: 4.5, y: 3, z: 4.5 };
    const player = new Player(world, buried);
    expect(player.position[1]).toBeGreaterThan(buried.y);
    /* And it can then move, which is the thing being stuck takes away. */
    const before = player.position[2];
    player.yaw = 0;
    for (let i = 0; i < 30; i++) player.step(1 / 60, { ...STILL, forward: 1, flying: true });
    expect(player.position[2]).not.toBeCloseTo(before, 3);
  });

  it('round-trips its own state', () => {
    const { world, player } = standing();
    player.yaw = 1.25;
    player.pitch = -0.5;
    const state = player.getState();
    const other = new Player(world, { x: 0, y: 90, z: 0 });
    other.setState(state);
    expect(other.getState()).toEqual(state);
  });
});
