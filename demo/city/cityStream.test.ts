import { describe, expect, test } from 'vitest';

import { clustered } from '../gpuDrivenRig';
import {
  CITY_SEED,
  CITY_WORST,
  CityStream,
  cityCapacity,
  cityVertexBytes,
  reachForCeiling,
} from './cityStream';
import {
  CITY_COLS,
  CITY_ROWS,
  LOT_X,
  LOT_Z,
  PITCH_Z,
  blockOrigin,
  cityBlock,
  cityBlocks,
} from './manhattan';

/**
 * **What this file is for: blocks arrive ahead of the eye and leave behind it, and never refuse.**
 *
 * The city is a `StreamingScene` the way the voxel sandbox's chunks are, so the demo exercises
 * streaming rather than a flag on a rig: a block built when the camera reaches it, clustered then,
 * and taken out once the camera has gone. A refused block is a hole in the skyline, so the capacity
 * is sized from the worst block the published grid makes, and a flight across the grid is the test.
 */

/** A block's middle, in metres. */
function middleOf(bx: number, bz: number): [number, number] {
  const [ox, oz] = blockOrigin(bx, bz);
  return [ox + LOT_X / 2, oz + LOT_Z / 2];
}

/** A reach of two blocks north and south and one east and west. */
const REACH = 2 * PITCH_Z;

test('THE WORST BLOCK THE GRID MAKES IS THE ONE THE CAPACITY IS SIZED FROM', () => {
  /* Measured, not chosen: every block of the published grid at the demo's seed, clustered. */
  let vertices = 0;
  let indices = 0;
  let clusters = 0;
  for (const [bx, bz] of cityBlocks()) {
    let v = 0;
    let i = 0;
    let c = 0;
    for (const mesh of cityBlock(bx, bz, CITY_SEED)) {
      const made = clustered(mesh);
      v += made.positions.length / 3;
      i += made.clusters.indices.length;
      c += made.clusters.count;
    }
    vertices = Math.max(vertices, v);
    indices = Math.max(indices, i);
    clusters = Math.max(clusters, c);
  }
  expect({ vertices, indices, clusters }).toEqual(CITY_WORST);
});

test('THE BLOCKS NEAR THE EYE ARRIVE NEAREST FIRST, a budget at a time', () => {
  const stream = new CityStream(CITY_SEED, REACH);
  const [x, z] = middleOf(0, 0);
  expect(stream.update(x, z, 3)).toBe(3);
  /* The eye's own block, then the two across its streets, which are nearer than the next avenue. */
  expect(stream.has(0, 0)).toBe(true);
  expect(stream.has(0, 1)).toBe(true);
  expect(stream.has(0, -1)).toBe(true);
  /* And the whole ring — one either side east and west, two north and south — in budgets. */
  while (stream.update(x, z, 3) > 0);
  expect(stream.count).toBe(3 * 5);
  expect(stream.refused).toBe(0);
});

test('A FRAME STOPS BUILDING WHEN ITS TIME IS GONE, but always builds the first', () => {
  /*
   * **A block costs up to fifty milliseconds**, so the demo gives a frame a few and stops; a
   * budget of none still builds one, or a frame with no time to spare would never build anything.
   */
  const stream = new CityStream(CITY_SEED, REACH);
  const [x, z] = middleOf(0, 0);
  expect(stream.update(x, z, 10, 0)).toBe(1);
  expect(stream.update(x, z, 10, 0)).toBe(1);
  expect(stream.count).toBe(2);
});

test('A BLOCK THE EYE HAS LEFT GOES, and one a block past the reach stays', () => {
  const stream = new CityStream(CITY_SEED, REACH);
  const [x0, z0] = middleOf(0, 0);
  while (stream.update(x0, z0, 50) > 0);
  const [x1, z1] = middleOf(0, 4);
  stream.update(x1, z1, 0);
  /* Three rows past the eye's is past the ring; one row past the reach is kept. */
  expect(stream.has(0, 0)).toBe(false);
  expect(stream.has(0, 1)).toBe(true);
  expect(stream.has(0, -1)).toBe(false);
});

test('NOTHING OUTSIDE THE PUBLISHED GRID IS BUILT', () => {
  const stream = new CityStream(CITY_SEED, REACH);
  const edgeX = CITY_COLS / 2 - 1;
  const edgeZ = CITY_ROWS / 2 - 1;
  const [x, z] = middleOf(edgeX, edgeZ);
  while (stream.update(x, z, 50) > 0);
  /* A corner block sees two columns of the grid and three rows, and nothing past them. */
  expect(stream.count).toBe(2 * 3);
  expect(stream.has(edgeX + 1, edgeZ)).toBe(false);
});

test('A FLIGHT ACROSS THE WHOLE GRID IS NEVER REFUSED, and what it holds is counted', () => {
  const reach = 3 * PITCH_Z;
  const stream = new CityStream(CITY_SEED, reach);
  for (let bz = -CITY_ROWS / 2; bz < CITY_ROWS / 2; bz += 2) {
    const [x, z] = middleOf(Math.floor(bz / 4), bz);
    while (stream.update(x, z, 40) > 0);
  }
  expect(stream.refused).toBe(0);
  let triangles = 0;
  for (const [bx, bz] of cityBlocks()) {
    if (!stream.has(bx, bz)) continue;
    for (const mesh of cityBlock(bx, bz, CITY_SEED)) triangles += mesh.indices.length / 3;
  }
  expect(stream.triangles).toBe(triangles);
  expect(stream.scene.capacity).toEqual(cityCapacity(reach));
});

test('A BLOCK THAT DOES NOT FIT IS REFUSED WHOLE, counted, and leaves nothing behind', () => {
  /*
   * **All of a block or none of it**: a block half in the scene is a tower with no roof, and its
   * handles would be lost to the next removal. Room for the first block and all of the second but
   * one vertex, so the second's first meshes fit and its last does not — the case the rollback is
   * for. The second is (0, -1): the street to the north is as near as the one to the south, and
   * ties go by place, row first.
   */
  const verticesOf = (bx: number, bz: number) =>
    cityBlock(bx, bz, CITY_SEED).reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const first = cityBlock(0, 0, CITY_SEED).map((mesh) => clustered(mesh));
  const stream = new CityStream(CITY_SEED, REACH, {
    vertices: verticesOf(0, 0) + verticesOf(0, -1) - 1,
    indices: CITY_WORST.indices * 4,
    clusters: CITY_WORST.clusters * 4,
    meshes: 64,
  });
  const [x, z] = middleOf(0, 0);
  expect(stream.update(x, z, 1)).toBe(1);
  const before = stream.scene.freeVertices;
  stream.update(x, z, 1);
  expect(stream.refused).toBe(1);
  expect(stream.count).toBe(1);
  expect(stream.scene.freeVertices).toBe(before);
  expect(stream.scene.liveClusters).toBe(first.reduce((sum, mesh) => sum + mesh.clusters.count, 0));
});

/*
 * **Reported from a Galaxy S23 Ultra, on the published site over HTTPS.** The scene asked for
 * 152,314,560 bytes as one storage binding and the device binds 134,217,728 — 128 MiB, the WebGPU
 * default, which is what most handhelds offer against the several gigabytes a desktop adapter
 * does. The engine was already asking the adapter for its ceiling rather than taking the default,
 * so there was nothing to raise: the city was simply larger than the part could hold, and every
 * phone got a blank frame with the refusal in a console nobody had open.
 */
describe('the reach a device can actually bind', () => {
  const PHONE = 134_217_728;
  const DESKTOP = 4 * 1024 * 1024 * 1024;
  const PER_VERTEX = 48;

  test('costs more than a phone can bind at the published reach', () => {
    expect(cityVertexBytes(900, PER_VERTEX)).toBe(152_314_560);
    expect(cityVertexBytes(900, PER_VERTEX)).toBeGreaterThan(PHONE);
  });

  test('leaves a desktop the reach it asked for', () => {
    expect(reachForCeiling(900, DESKTOP, PER_VERTEX)).toBe(900);
  });

  test('steps a phone down to something it can bind, with room under the ceiling', () => {
    const reach = reachForCeiling(900, PHONE, PER_VERTEX);
    expect(reach).toBeLessThan(900);
    expect(cityVertexBytes(reach, PER_VERTEX)).toBeLessThanOrEqual(PHONE * 0.8);
  });

  /* A smaller reach asked for is a decision, so it is never raised to fill the room available. */
  test('never hands back more than it was asked for', () => {
    expect(reachForCeiling(300, DESKTOP, PER_VERTEX)).toBe(300);
    expect(reachForCeiling(250, PHONE, PER_VERTEX)).toBe(250);
  });
});
