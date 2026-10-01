/**
 * Convex polygons in the ground plane (x, z): clipping by a half-plane, area, bounds, and whether
 * a polygon is still the axis-aligned rectangle it started as.
 *
 * Outlines are counter-clockwise seen from above with +z toward the viewer — the order `rect`
 * makes — and stay convex under clipping, which is all the layout does to them.
 */

export type Vec2 = readonly [number, number];

/** The rectangle [x0, x1] × [z0, z1] as an outline. */
export function rect(x0: number, z0: number, x1: number, z1: number): Vec2[] {
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
}

/** The part of `poly` where `a·x + b·z >= c`. */
export function clip(poly: readonly Vec2[], a: number, b: number, c: number): Vec2[] {
  const out: Vec2[] = [];
  const side = (p: Vec2): number => a * p[0] + b * p[1] - c;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if (sp >= 0 !== sq >= 0) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Signed area, positive for the outline order `rect` makes. */
export function area(poly: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return sum / 2;
}

export interface Bounds {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export function bounds(poly: readonly Vec2[]): Bounds {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return { x0, z0, x1, z1 };
}

/** Whether `poly` fills its bounds: an axis-aligned rectangle still. */
export function isRect(poly: readonly Vec2[]): boolean {
  const b = bounds(poly);
  return (
    Math.abs(Math.abs(area(poly)) - (b.x1 - b.x0) * (b.z1 - b.z0)) <
    1e-6 * Math.max(1, Math.abs(area(poly)))
  );
}

/** The shortest distance from `p` to the segment a–b. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}
