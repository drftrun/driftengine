/**
 * Whether a lot stands under the elevated road: within `half` metres of its route in plan.
 *
 * **Nothing is built under the deck.** The route's corner curve crosses blocks diagonally, and a
 * building there would stand through the road at 14 m; so a lot the corridor touches is left
 * vacant — paved, as every vacant lot is — rather than trimmed. What would make it wrong is a
 * capture of the reference showing buildings under its elevated road with the deck passing over
 * their roofs.
 */
import type { Bounds } from './plane.ts';

type P3 = readonly [number, number, number];

/** Distance in plan from a point to a segment. */
function pointSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const [dx, dz] = [bx - ax, bz - az];
  const len = dx * dx + dz * dz;
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Whether a segment crosses the rectangle: an end inside, or a crossing of one of its sides. */
function crosses(b: Bounds, ax: number, az: number, bx: number, bz: number): boolean {
  const inside = (x: number, z: number): boolean =>
    x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
  if (inside(ax, az) || inside(bx, bz)) return true;
  const hit = (cx: number, cz: number, ex: number, ez: number): boolean => {
    const d = (bx - ax) * (ez - cz) - (bz - az) * (ex - cx);
    if (d === 0) return false;
    const t = ((cx - ax) * (ez - cz) - (cz - az) * (ex - cx)) / d;
    const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  return (
    hit(b.x0, b.z0, b.x1, b.z0) ||
    hit(b.x1, b.z0, b.x1, b.z1) ||
    hit(b.x1, b.z1, b.x0, b.z1) ||
    hit(b.x0, b.z1, b.x0, b.z0)
  );
}

export function underRoute(bounds: Bounds, route: readonly P3[], half: number): boolean {
  const corners: [number, number][] = [
    [bounds.x0, bounds.z0],
    [bounds.x1, bounds.z0],
    [bounds.x1, bounds.z1],
    [bounds.x0, bounds.z1],
  ];
  for (let i = 0; i + 1 < route.length; i++) {
    const [a, b] = [route[i] as P3, route[i + 1] as P3];
    if (crosses(bounds, a[0], a[2], b[0], b[2])) return true;
    for (const [x, z] of corners)
      if (pointSegment(x, z, a[0], a[2], b[0], b[2]) < half) return true;
    /* An end of the route beside the rectangle's side, nearer than any corner. */
    for (const [x, z] of [
      [a[0], a[2]],
      [b[0], b[2]],
    ] as const) {
      const dx = Math.max(bounds.x0 - x, 0, x - bounds.x1);
      const dz = Math.max(bounds.z0 - z, 0, z - bounds.z1);
      if (Math.hypot(dx, dz) < half) return true;
    }
  }
  return false;
}
