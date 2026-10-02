---
title: Coordinates and units
description: Metres, Y up, which way the camera looks, how matrices are laid out, and how a world larger than single precision stays exact.
packages: ['@driftengine/core']
areas: ['math', 'world']
covers: ['A world bigger than a float']
---

# Coordinates and units

## The conventions

- **Units are metres** and seconds. Physics gravity defaults to 9.81 metres per second squared,
  downward.
- **Y is up.** The ground is the XZ plane.
- **The camera looks toward negative Z at yaw 0.** Positive yaw turns right, toward positive X, and
  positive pitch looks up. With X to the right, Y up and the view down negative Z, the system is
  right-handed.
- **Rotations are quaternions** on scene nodes and physics bodies, stored `x, y, z, w`.
- **Matrices are column-major `Float32Array`s of sixteen**, the layout WebGPU, WebGL2 and gl-matrix
  all use. A translation is in elements 12, 13 and 14.
- **Colours are RGB triples from 0 to 1**, written `[r, g, b]`. A light's colour may go above 1,
  which means brighter than white. How the shaded result maps to the screen is the `outputTransform`
  quality option, covered in [Render quality](quality.md).

## Worlds bigger than a float

A `Float32Array` holds about seven significant digits. Forty kilometres from the origin, a single
precision coordinate can no longer tell two points a few millimetres apart, so vertices jitter and
the camera shakes. Engines usually answer by shifting the origin under the player now and then.
DriftEngine splits the problem in two, because a shift that touches the simulation changes its
floating-point results, and a replay recorded before the shift stops matching one recorded after.

**The simulation never rebases.** Its positions are absolute and kept in double precision, which is
exact to well under a millimetre anywhere on a planet.

**Rendering does, in whole cells.** The render origin is the minimum corner of the grid cell the
camera is in, so it only moves when the camera crosses a cell boundary. An origin that followed the
camera continuously would re-quantise every vertex every frame, and the world would shimmer in a
different way.

```ts sample=snippets/coordinates.ts#origin
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
```

`toRenderSpace` subtracts in double precision and only narrows the small result to single precision,
which keeps the precision; narrowing first and then subtracting would already have lost it.
`toWorldSpace` goes back, exactly.

Three consequences are worth knowing before you meet them:

- A view matrix is single precision, so it cannot hold an absolute position in a large world. Views
  are in render space, and anything that predicts where the camera will be, such as streaming, is
  told the origin and adds it back in double precision.
- A navigation mesh is built and queried in render space for the same reason.
- **Freezing is a simulation decision and unloading is a memory decision.** A grid cell outside the
  simulated radius freezes whether or not its contents are loaded, and only a frozen cell may be
  unloaded. If unloading caused freezing, the simulation would depend on how much memory a machine
  had, and two players would diverge.

The cell grid, streaming cells in and out, and freezing and thawing them are covered in
[Large worlds](../worlds/large-worlds.md), and drawing distant regions coarsely in
[Hierarchical detail](../worlds/hierarchical-detail.md).
