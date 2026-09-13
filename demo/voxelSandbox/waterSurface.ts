/**
 * The wash when the camera goes under water.
 *
 * **This used to draw the sea with `drawWater`, and that was wrong.** `WaterBody` is a *bounded
 * pool*: one level, one rectangle. In a voxel world water is wherever the cells are, so a sheet
 * at sea level following the camera put water over every dry inland basin below y=30 and, because
 * the mesher had stopped emitting fluid top faces to avoid z-fighting it, left a hole everywhere
 * the sheet did not reach. Reported from a real session as "all transparent on the surface".
 *
 * The water surface is the mesher's again, drawn as blend-mode quads like every other face.
 * `UnderwaterAtmosphere` stays, because that part was right: going under is a participating
 * medium rather than the reference's fixed-position `div`.
 */
import type { Camera, Environment, UnderwaterAtmosphere } from '../../packages/core/src/index';

import { Block } from './blocks';
import { SEA_LEVEL } from './constants';
import type { BlockSource } from './world';

/** What the eye sees while submerged. */
const UNDERWATER: UnderwaterAtmosphere = {
  surfaceY: SEA_LEVEL,
  color: [0.12, 0.35, 0.6],
  fogDensity: 0.08,
  transitionDepth: 0.5,
};

export class WaterSurface {
  /** Whether the eye is inside a water cell, which is the reference's own test. */
  submerged(blocks: BlockSource, x: number, eyeY: number, z: number): boolean {
    return blocks.getBlock(Math.floor(x), Math.floor(eyeY), Math.floor(z)) === Block.WATER;
  }

  /**
   * Set the submerged medium on the environment.
   *
   * `env.underwater` is what makes going under read as *being under something* rather than as a
   * tint over the picture. `surfaceY` is flat, which is right here: the sea has one level, and a
   * cave flooded below it is still below it.
   */
  update(camera: Camera, env: Environment, blocks: BlockSource): void {
    env.underwater = this.submerged(
      blocks,
      camera.position[0],
      camera.position[1],
      camera.position[2],
    )
      ? UNDERWATER
      : null;
  }
}
