import type { BoltSegments } from './boltPool.ts';
import type { LineSegments } from './linePoints.ts';

/**
 * How a list of segments becomes triangles, held once for every renderer that draws one.
 *
 * **Four vertices a segment rather than instancing**, because a segment's two endpoints *are*
 * its geometry: there is no repeated base shape to instance, and an instanced version would
 * upload the same two positions per vertex anyway.
 *
 * Shared by arcs and by lines, which want the same quad and nothing else in common: an arc is
 * additive, unlit, over-bright and jittered along its own path, and a line is a flat fogged
 * colour with a clean edge. Two copies of the corner table would be two different meshes for
 * the same segment, which is the mistake `waterGrid.ts` was extracted after catching in the
 * act, a patch resolution of 48 against 24.
 */

/** Four vertices a segment: both ends, both sides, as (along, side). */
export const SEGMENT_CORNERS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 1],
  [0, 1],
];

/** The static half of a batch: which end and side each vertex is, and the triangle list. */
export interface SegmentQuads {
  readonly corners: Float32Array;
  readonly indices: Uint32Array;
}

export function buildSegmentQuads(capacity: number): SegmentQuads {
  const corners = new Float32Array(capacity * 4 * 2);
  const indices = new Uint32Array(capacity * 6);
  for (let s = 0; s < capacity; s++) {
    const v = s * 4;
    for (let c = 0; c < 4; c++) {
      const corner = SEGMENT_CORNERS[c] as readonly [number, number];
      corners[(v + c) * 2] = corner[0];
      corners[(v + c) * 2 + 1] = corner[1];
    }
    const i = s * 6;
    indices[i] = v;
    indices[i + 1] = v + 1;
    indices[i + 2] = v + 2;
    indices[i + 3] = v;
    indices[i + 4] = v + 2;
    indices[i + 5] = v + 3;
  }
  return { corners, indices };
}

/**
 * Expand this frame's segments to their four vertices each, into arrays the caller owns.
 *
 * Returns how many segments were written, which is the pool's count clamped to the batch's
 * capacity — a pool that overruns loses its tail rather than the frame.
 */
export function expandBoltSegments(
  data: BoltSegments,
  capacity: number,
  from: Float32Array,
  to: Float32Array,
  arc: Float32Array,
): number {
  const count = Math.min(data.count, capacity);
  for (let s = 0; s < count; s++) {
    const fx = data.from[s * 3] as number;
    const fy = data.from[s * 3 + 1] as number;
    const fz = data.from[s * 3 + 2] as number;
    const tx = data.to[s * 3] as number;
    const ty = data.to[s * 3 + 1] as number;
    const tz = data.to[s * 3 + 2] as number;
    const along = data.along[s] as number;
    const fade = data.fade[s] as number;
    const seed = data.seed[s] as number;
    const gain = data.brightness[s] as number;
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      from[v * 3] = fx;
      from[v * 3 + 1] = fy;
      from[v * 3 + 2] = fz;
      to[v * 3] = tx;
      to[v * 3 + 1] = ty;
      to[v * 3 + 2] = tz;
      arc[v * 4] = along;
      arc[v * 4 + 1] = fade;
      arc[v * 4 + 2] = seed;
      arc[v * 4 + 3] = gain;
    }
  }
  return count;
}

/**
 * Expand this frame's segments to their four vertices each, into arrays the caller owns.
 *
 * Returns how many segments were written, which is the list's count clamped to the batch's
 * capacity — a caller that overruns loses its tail rather than its frame, the same rule
 * `expandBoltSegments` follows. Reads only `LineSegments.from`/`.to`.
 *
 * **Both backends call it**, which is the reason it is here: the WebGL2 batch wrote the same walk
 * inline until 2026-09-19, so the number of segments a batch draws — and so whether it draws at
 * all, and is counted — was one decision written twice.
 */
export function expandLineSegments(
  data: LineSegments,
  capacity: number,
  from: Float32Array,
  to: Float32Array,
): number {
  const count = Math.min(data.count, capacity);
  for (let s = 0; s < count; s++) {
    const fx = data.from[s * 3] as number;
    const fy = data.from[s * 3 + 1] as number;
    const fz = data.from[s * 3 + 2] as number;
    const tx = data.to[s * 3] as number;
    const ty = data.to[s * 3 + 1] as number;
    const tz = data.to[s * 3 + 2] as number;
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      from[v * 3] = fx;
      from[v * 3 + 1] = fy;
      from[v * 3 + 2] = fz;
      to[v * 3] = tx;
      to[v * 3 + 1] = ty;
      to[v * 3 + 2] = tz;
    }
  }
  return count;
}
