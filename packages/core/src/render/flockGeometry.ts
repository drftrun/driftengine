/**
 * A flock's static geometry, held once so both backends draw the same bird.
 *
 * Two triangles a bird, a body quad split into two wings, with a per-vertex weight that is 1 at
 * a wingtip and 0 at the body so only the tips beat. Every bird's path is computed in the vertex
 * shader from its index and the clock, so this is uploaded once and the frame loop does nothing.
 *
 * Shared rather than restated for the reason `waterGrid.ts` was extracted: a second corner table
 * is a second bird, and a mesh that differs by a wing between backends is not something the
 * parity gate can attribute.
 */

/** Corner positions, in wingspans: tip, body front, body back. */
export const FLOCK_CORNERS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [0, -0.35],
  [0, 0.35],
  [1, 0],
  [0, 0.35],
  [0, -0.35],
];

/** 1 at a wingtip, 0 at the body, so only the tips beat. */
export const FLOCK_WING: readonly number[] = [1, 0, 0, 1, 0, 0];

/** The three static attribute streams a flock is drawn from. */
export interface FlockGeometry {
  readonly corners: Float32Array;
  readonly wings: Float32Array;
  readonly indices: Float32Array;
  readonly vertexCount: number;
}

export function buildFlockGeometry(count: number): FlockGeometry {
  if (count <= 0) throw new Error('A flock needs at least one bird.');
  const perBird = FLOCK_CORNERS.length;
  const corners = new Float32Array(count * perBird * 2);
  const wings = new Float32Array(count * perBird);
  const indices = new Float32Array(count * perBird);
  let c = 0;
  let w = 0;
  for (let bird = 0; bird < count; bird++) {
    for (let v = 0; v < perBird; v++) {
      const corner = FLOCK_CORNERS[v] as readonly [number, number];
      corners[c++] = corner[0];
      corners[c++] = corner[1];
      wings[w] = FLOCK_WING[v] ?? 0;
      indices[w] = bird;
      w++;
    }
  }
  return { corners, wings, indices, vertexCount: count * perBird };
}
