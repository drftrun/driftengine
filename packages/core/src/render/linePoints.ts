/**
 * A polyline as the segments a renderer draws, rewritten in place.
 *
 * **No GL here**, for the reason `sdfTextLayout.ts` gives: which segments a point list
 * produces is the same arithmetic on either backend, so it lives once and the two renderers
 * own only their buffers. It is also the half worth testing, and testing it needs no context.
 *
 * A caller owns one of these for the life of its polyline and rewrites it per frame. That is
 * the whole shape of the thing: an audio waveform, a moving trail and a plotted curve all
 * have a fixed point count and moving points, and none of them should be allocating.
 */

export interface LineSegments {
  /** `from` and `to` per segment, three floats each, live segments first. */
  from: Float32Array;
  to: Float32Array;
  /** How many segments of the above are live. */
  count: number;
  readonly capacity: number;
}

/** Room for `capacity` segments, which is one fewer than the points that fill them. */
export function createLineSegments(capacity: number): LineSegments {
  return {
    from: new Float32Array(capacity * 3),
    to: new Float32Array(capacity * 3),
    count: 0,
    capacity,
  };
}

/**
 * Rewrite a polyline from a flat point list, three floats a point.
 *
 * Returns how many segments were written, which is `pointCount - 1` clamped to capacity: a
 * caller that overruns loses its tail rather than its frame, the same rule
 * `expandBoltSegments` follows.
 *
 * A list of one point writes nothing rather than a zero-length segment. A degenerate segment
 * is not harmless: its direction is undefined, so the shader falls back to an arbitrary
 * perpendicular and draws a quad of full width pointing nowhere.
 */
export function setPolyline(
  out: LineSegments,
  points: ArrayLike<number>,
  pointCount: number,
): number {
  const count = Math.max(0, Math.min(pointCount - 1, out.capacity));
  for (let s = 0; s < count; s++) {
    const a = s * 3;
    const b = a + 3;
    out.from[a] = points[a] as number;
    out.from[a + 1] = points[a + 1] as number;
    out.from[a + 2] = points[a + 2] as number;
    out.to[a] = points[b] as number;
    out.to[a + 1] = points[b + 1] as number;
    out.to[a + 2] = points[b + 2] as number;
  }
  out.count = count;
  return count;
}
