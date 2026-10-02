/**
 * A world larger than single precision can address: positions kept absolute in double precision,
 * drawn relative to an origin that follows the camera in whole cells.
 *
 * A snippet, typechecked with the examples and quoted by the manual's coordinates chapter.
 */
import { Camera, SceneNode, renderOrigin, toRenderSpace } from '@driftengine/core';

// #region origin
/** Cells are this many metres on a side. The render origin moves a whole cell at a time. */
const CELL = 256;

/** The simulation's positions: absolute, in metres, in double precision. Never rebased. */
const player = new Float64Array([40_000_123.25, 12, -7_500_000.5]);
const beacon = new Float64Array([40_000_180, 30, -7_500_040]);

const origin = new Float64Array(3);
const scratch = new Float32Array(3);

/** Each frame: choose the origin, then hand the renderer only small numbers. */
export function placeForFrame(camera: Camera, beaconNode: SceneNode): void {
  renderOrigin(player[0], player[1], player[2], CELL, origin);

  // The camera sits behind and above the player, in render space.
  toRenderSpace(player[0], player[1] + 6, player[2] + 10, origin, scratch);
  camera.position[0] = scratch[0];
  camera.position[1] = scratch[1];
  camera.position[2] = scratch[2];
  toRenderSpace(player[0], player[1], player[2], origin, scratch);
  camera.lookAt(scratch[0], scratch[1], scratch[2]);

  // Every drawn thing goes through the same subtraction, done in doubles before it narrows.
  toRenderSpace(beacon[0], beacon[1], beacon[2], origin, scratch);
  beaconNode.setPosition(scratch[0], scratch[1], scratch[2]);
  beaconNode.updateWorld();
}
// #endregion
