import type { MeshData } from '@driftengine/drft';
import { expect, test } from 'vitest';

import { segmentGeometry } from './segment.ts';

/**
 * **A room cuts itself into surfaces with no model loaded.**
 *
 * The claim being tested is deliberately small. Nothing here knows what an object *is*; what it
 * knows is where one surface stops and another starts. That is available to every consumer,
 * including the ones who will never download a weight file, and it is most of what a scene needs.
 */

/** A room: a floor, two walls at right angles to it, and a small block standing on the floor. */
function room(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const quad = (
    corners: readonly (readonly [number, number, number])[],
    normal: readonly [number, number, number],
  ): void => {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) {
      positions.push(x, y, z);
      normals.push(normal[0], normal[1], normal[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  /* The floor, as four quads so a region is more than one triangle. */
  for (const [ox, oz] of [
    [-2, -2],
    [0, -2],
    [-2, 0],
    [0, 0],
  ] as const) {
    quad(
      [
        [ox, 0, oz],
        [ox, 0, oz + 2],
        [ox + 2, 0, oz + 2],
        [ox + 2, 0, oz],
      ],
      [0, 1, 0],
    );
  }
  /*
   * Two walls, and **the tall one is the largest surface in the room** — 24 m² against the floor's
   * 16. A fixture whose floor is also its biggest region cannot tell "the floor" from "the largest
   * thing", and every test of the choice below would pass with the choice deleted.
   */
  quad(
    [
      [-2, 0, -2],
      [2, 0, -2],
      [2, 6, -2],
      [-2, 6, -2],
    ],
    [0, 0, 1],
  );
  quad(
    [
      [-2, 0, -2],
      [-2, 2, -2],
      [-2, 2, 2],
      [-2, 0, 2],
    ],
    [1, 0, 0],
  );
  /* A block: the top of it, well above the floor and parallel to it. */
  quad(
    [
      [0.4, 0.5, 0.4],
      [0.4, 0.5, 1.0],
      [1.0, 0.5, 1.0],
      [1.0, 0.5, 0.4],
    ],
    [0, 1, 0],
  );

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: new Float32Array(positions.length).fill(1),
    emissive: new Float32Array(3),
    indices: Uint32Array.from(indices),
  };
}

/**
 * Two triangles sharing an edge, the second an eighth of the first's area and folded from it.
 *
 * The tilt arrives as its sine and cosine rather than as degrees, so every number in this file is
 * one somebody wrote down: 15° is 0.2588 and 0.9659, 30° is 0.5 and 0.8660.
 */
function wedge(sinTilt: number, cosTilt: number): MeshData {
  return {
    positions: Float32Array.from([0, 0, 0, 4, 0, 0, 0, 0, 4, 0, sinTilt * 0.25, -cosTilt * 0.25]),
    /* Vertex normals, deliberately empty: a region's normal is the geometry's, not the file's. */
    normals: new Float32Array(12),
    colors: new Float32Array(12).fill(1),
    emissive: new Float32Array(3),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3]),
  };
}

const SIN15 = 0.25881904510252074;
const COS15 = 0.9659258262890683;

test('A ROOM CUTS ITSELF INTO SURFACES WITH NO MODEL LOADED', () => {
  const regions = segmentGeometry(room());
  /* The floor, two walls and the block's top: four surfaces, largest first. */
  expect(regions.length).toBe(4);
  expect(regions[0]?.area).toBeCloseTo(24, 6);

  const horizontal = regions.filter((region) => (region.normal[1] as number) > 0.9);
  expect(horizontal.length).toBe(2);
  const floor = horizontal[0] as (typeof regions)[number];
  const block = horizontal[1] as (typeof regions)[number];
  /*
   * **The floor is one region although its four quads share no vertex**, which is the shape every
   * flat-shaded mesh arrives in: each face carries its own copy of each corner. Joined by index
   * alone this room comes back as seven regions — four of floor — and a segmentation that found
   * nothing looks exactly like one that worked.
   */
  expect(floor.area).toBeCloseTo(16, 6);
  expect(floor.normal[1]).toBeCloseTo(1, 6);

  /*
   * **The block's top stays its own region though it is parallel to the floor and above it**,
   * because it shares no edge with it. Joining every horizontal triangle in a building into one
   * region — a table top with the floor under it — is the other way to find nothing.
   */
  expect(block.area).toBeCloseTo(0.36, 6);
  expect(block.bounds[1]).toBeCloseTo(0.5, 6);

  /* And every triangle went somewhere: nothing is dropped and nothing is counted twice. */
  const claimed = new Set<number>();
  for (const region of regions) for (const face of region.triangles) claimed.add(face);
  expect(claimed.size).toBe(room().indices.length / 3);
});

test('A CREASE STEEPER THAN THE TOLERANCE ENDS THE SURFACE', () => {
  /*
   * **The crease angle is the one number that decides what a region is** with no model loaded, and
   * a fixture of right angles never asks it anything: two triangles at 90° are told apart by any
   * tolerance at all. So fold one edge by 15° and by 30° and hold the default between them.
   */
  expect(segmentGeometry(wedge(SIN15, COS15)).length).toBe(1);
  expect(segmentGeometry(wedge(0.5, 0.8660254037844387)).length).toBe(2);
  /* And the number belongs to the caller: the same 30° fold is one surface when they say so. */
  expect(segmentGeometry(wedge(0.5, 0.8660254037844387), { creaseDegrees: 40 }).length).toBe(1);
});

test('a surface smaller than the caller cares about is not a region', () => {
  /* The block's top is 0.36 m²: above the default, below a caller that wants whole surfaces. */
  expect(segmentGeometry(room(), { minimumArea: 1 }).length).toBe(3);
  expect(segmentGeometry(room()).length).toBe(4);
});

test("A REGION'S NORMAL IS WEIGHTED BY AREA RATHER THAN BY TRIANGLE COUNT", () => {
  /*
   * Two triangles sharing an edge, one 16 times the area of the other and tilted 15° from it. The
   * mean of the two unit normals leans 7.5° off vertical; weighted by area it leans 0.874°, which
   * is sin 0.874° = 0.015253 in z. **A sliver must not outvote the surface it sits on** — a
   * decimated capture is full of them, and a floor whose normal came back a few degrees off is a
   * floor a character slides down.
   */
  const regions = segmentGeometry(wedge(SIN15, COS15));
  expect(regions.length).toBe(1);
  expect(regions[0]?.area).toBeCloseTo(8.5, 6);
  expect(regions[0]?.normal[2]).toBeCloseTo(0.015253, 5);
});

test('the same mesh segments the same way twice, down to the order', () => {
  const first = segmentGeometry(room());
  const second = segmentGeometry(room());
  expect(second.map((region) => region.triangles.join(','))).toEqual(
    first.map((region) => region.triangles.join(',')),
  );
  expect(second.map((region) => region.area)).toEqual(first.map((region) => region.area));
});
