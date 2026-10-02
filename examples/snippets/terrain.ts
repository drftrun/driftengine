/**
 * A terrain that collides, a patch matched to a coarser neighbour, and a field kept as texture
 * layers.
 *
 * A snippet, typechecked with the examples and quoted by the manual's terrain chapter.
 */
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  heightfieldShape,
  meshShape,
  sphereShape,
} from '@driftengine/physics';
import {
  TERRAIN_SPLAT_CHANNELS,
  Terrain,
  decodeTerrainSplat,
  encodeTerrainHeights,
  encodeTerrainSplat,
  heightfieldPatch,
  terrainFromHeightLayer,
  terrainHeightTolerance,
} from '@driftengine/terrain';

// #region field
/** A gentle slope 64 metres square, rising toward +x, with sample (0, 0) at the origin. */
const SIDE = 65;
const heights = new Float32Array(SIDE * SIDE);
for (let row = 0; row < SIDE; row += 1)
  for (let column = 0; column < SIDE; column += 1)
    heights[row * SIDE + column] = column * 0.1 + Math.sin(row * 0.3) * 0.5;
export const field = new Terrain({ width: SIDE, depth: SIDE, spacingM: 1, heights });

/** How high the ground is, and which way it faces, at a place on it. */
export const groundY = field.heightAt(10.5, 20.25);
export const up = field.normalAt(10.5, 20.25, new Float32Array(3));
// #endregion

// #region seam
/** A full-detail patch whose +x neighbour is drawn at a quarter of the detail. */
export const fine = heightfieldPatch(field, {
  x: 0,
  z: 0,
  cells: 32,
  step: 1,
  neighbours: { plusX: 4 },
});
export const coarse = heightfieldPatch(field, { x: 32, z: 0, cells: 32, step: 4 });
// #endregion

// #region collide
/** The field as a collider: one static body holding the heights, and a ball dropped onto it. */
export const world = new PhysicsWorld();
world.addBody({ type: BODY_STATIC, shape: heightfieldShape(field), friction: 0.8 });
export const ball = world.addBody({
  type: BODY_DYNAMIC,
  shape: sphereShape(0.5),
  x: 20,
  y: field.heightAt(20, 20) + 3,
  z: 20,
});

/** Or the patch that is drawn, chords and all, so a coarse patch collides as coarse as it looks. */
export const drawnWorld = new PhysicsWorld();
drawnWorld.addBody({ type: BODY_STATIC, shape: meshShape(coarse.positions, coarse.indices) });
// #endregion

// #region layer
/** The heights as a texture layer, and the terrain everything should read, built from it. */
const layer = encodeTerrainHeights(field);
export const stored = terrainFromHeightLayer(layer);
/** How far a decoded height may sit from the source: half a 16-bit step of the field's range. */
export const tolerance = terrainHeightTolerance(layer);
// #endregion

// #region splat
/** Four materials per sample, summing to one: grass that turns to rock up the slope. */
const weights = new Float32Array(SIDE * SIDE * TERRAIN_SPLAT_CHANNELS);
for (let at = 0; at < SIDE * SIDE; at += 1) {
  const rock = (at % SIDE) / (SIDE - 1);
  weights[at * TERRAIN_SPLAT_CHANNELS] = 1 - rock;
  weights[at * TERRAIN_SPLAT_CHANNELS + 1] = rock;
}
const splat = encodeTerrainSplat(SIDE, SIDE, weights);
/** The four weights halfway across, renormalised so they sum to one again. */
export const blend = new Float32Array(TERRAIN_SPLAT_CHANNELS);
decodeTerrainSplat(splat, 0.5, 0.5, blend);
// #endregion
