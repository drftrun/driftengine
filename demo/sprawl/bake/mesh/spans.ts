/**
 * A polyline in the world as the reference's swept templates take it: Hermite spans between its
 * points, each tangent the Catmull-Rom estimate from its neighbours, and a spline entity the
 * template's `AlongSpline` and `Sweep` parts find it by.
 *
 * **A closed loop wraps**: its last point is its first again, so the neighbours of either end are
 * across the join, and a loop's corner at the join bends like any other. **An open route does
 * not**: its end tangents are the one-sided difference, so its first and last spans leave and arrive
 * straight.
 */
import type { Value } from '../script/values.ts';
import type { ScriptEntity, ScriptWorld } from '../script/world.ts';

export type P3 = readonly [number, number, number];

const f32 = (v: number): Value => ({ k: 'num', type: 'f32', v: Math.fround(v) });
export const record = (fields: Record<string, Value>): Value => ({
  k: 'struct',
  fields: new Map(Object.entries(fields)),
  items: [],
});

/** The spline entity a line's parts find it by: its points, in the world. */
export function splineEntity(
  world: ScriptWorld,
  name: string,
  points: readonly P3[],
): ScriptEntity {
  const entity = world.create(name, null);
  entity.components.set(
    'Spline',
    record({
      points: {
        k: 'vector',
        items: points.map(([x, y, z]) => record({ x: f32(x), y: f32(y), z: f32(z) })),
      },
    }),
  );
  return entity;
}

/** Distance along a polyline in plan at each point, as the layout measures its lines. */
export function planAlong(points: readonly P3[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1] as P3, points[i] as P3];
    out.push((out[i - 1] as number) + Math.hypot(b[0] - a[0], b[2] - a[2]));
  }
  return out;
}

/** The `SplineSpans` a swept template takes, for the points from `i0` to `i1`. */
export function spansOf(points: readonly P3[], closed: boolean, i0: number, i1: number): Value {
  const n = points.length;
  const at = (i: number): P3 =>
    closed
      ? (points[((i % (n - 1)) + (n - 1)) % (n - 1)] as P3)
      : (points[Math.min(Math.max(i, 0), n - 1)] as P3);
  const tangent = (i: number): P3 => {
    const a = at(i - 1);
    const b = at(i + 1);
    /* At an open end the step either side is one sample, not two. */
    const steps = !closed && (i <= 0 || i >= n - 1) ? 1 : 2;
    return [(b[0] - a[0]) / steps, (b[1] - a[1]) / steps, (b[2] - a[2]) / steps];
  };
  const items: Value[] = [];
  for (let k = i0; k < i1; k++) {
    const [p0, p1, t0, t1] = [at(k), at(k + 1), tangent(k), tangent(k + 1)];
    items.push(
      record({
        p0x: f32(p0[0]),
        p0y: f32(p0[1]),
        p0z: f32(p0[2]),
        t0x: f32(t0[0]),
        t0y: f32(t0[1]),
        t0z: f32(t0[2]),
        p1x: f32(p1[0]),
        p1y: f32(p1[1]),
        p1z: f32(p1[2]),
        t1x: f32(t1[0]),
        t1y: f32(t1[1]),
        t1z: f32(t1[2]),
        u0x: f32(0),
        u0y: f32(1),
        u0z: f32(0),
        u1x: f32(0),
        u1y: f32(1),
        u1z: f32(0),
        len: f32(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])),
      }),
    );
  }
  return { k: 'vector', items };
}

/** Index ranges covering the polyline in pieces of about `length` metres along it. */
export function chunks(along: readonly number[], length: number): [number, number][] {
  const out: [number, number][] = [];
  const n = along.length;
  let i0 = 0;
  while (i0 < n - 1) {
    let i1 = i0 + 1;
    while (i1 < n - 1 && (along[i1] as number) - (along[i0] as number) < length) i1++;
    out.push([i0, i1]);
    i0 = i1;
  }
  return out;
}
