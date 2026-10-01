/**
 * The walled quarter: a ring of wall and moat around the district the scripts wall, gates where its
 * streets pass through, towers at the corners and every `wallTowerSpacing`, lamps between.
 *
 * **The scripts' constants fix the cross-section, measured inward from the district's outer block
 * edge**: the moat from 3.8 m to 23.8 m (the moat's own `offset` and `width`, taken from the wall),
 * the wall's centre on `wallRing` = 24 m, and lots only past `wallBeltWidth` = 36 m, which is the
 * wall's half thickness and `wallBeltInner` behind it: 24 + 1.8 + 10. Every lot reaching into that
 * belt is cleared.
 *
 * The walled district is the one whose street class is the old town's — the host's own choice,
 * which the tables leave unsaid; it is the district of the enum's sixth place. What gives: a
 * district whose cells are not one rectangle would need a traced outline; this corpus's is one.
 */
import type { Block } from './blocks.ts';
import type { Lot } from './lots.ts';
import type { Vec2 } from './plane.ts';
import type { Road, RoadNetwork } from './roads.ts';
import type { CityTables } from './tables.ts';

/** The walled district, by its place in the enum. */
const WALLED_DISTRICT = 5;

export interface Gate {
  /** Segment index plus the fraction along it, as the wall's scripts read a position. */
  readonly s: number;
  readonly road: Road;
}

export interface Wall {
  /** The ring, closed: the first corner again at the end. */
  readonly path: readonly Vec2[];
  readonly gates: readonly Gate[];
  /** Positions along the ring and the tower's radius. */
  readonly towers: readonly { readonly s: number; readonly r: number }[];
  readonly lamps: readonly number[];
  /** The belt the wall and moat take, cleared of lots: from `outer` in to `inner`. */
  readonly outer: readonly Vec2[];
  readonly inner: readonly Vec2[];
}

const outline = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

export function buildWall(
  tables: CityTables,
  blocks: readonly Block[],
  roads: RoadNetwork,
): Wall | null {
  const district = tables.districts[WALLED_DISTRICT];
  if (district === undefined) return null;
  const own = blocks.filter((b) => b.district === district.kind);
  if (own.length === 0) return null;
  const x0 = Math.min(...own.map((b) => b.bounds.x0));
  const z0 = Math.min(...own.map((b) => b.bounds.z0));
  const x1 = Math.max(...own.map((b) => b.bounds.x1));
  const z1 = Math.max(...own.map((b) => b.bounds.z1));
  const ring = tables.value('wallRing');
  const belt = tables.value('wallBeltWidth');
  const corners = outline(x0 + ring, z0 + ring, x1 - ring, z1 - ring);
  const path = [...corners, corners[0] as Vec2];
  const lengths = corners.map((p, i) => {
    const q = path[i + 1] as Vec2;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const gates: Gate[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const a = path[i] as Vec2;
    const b = path[i + 1] as Vec2;
    const along = a[1] === b[1];
    for (const road of roads.roads) {
      /* A street crossing this side: perpendicular to it, running across the ring's line. */
      if (road.vertical !== along) continue;
      const line = along ? a[1] : a[0];
      if (road.from >= line || road.to <= line) continue;
      const lo = Math.min(along ? a[0] : a[1], along ? b[0] : b[1]);
      const hi = Math.max(along ? a[0] : a[1], along ? b[0] : b[1]);
      if (road.at <= lo || road.at >= hi) continue;
      const start = along ? a[0] : a[1];
      const end = along ? b[0] : b[1];
      gates.push({ s: i + (road.at - start) / (end - start), road });
    }
  }
  gates.sort((g, h) => g.s - h.s);
  const spacing = tables.value('wallTowerSpacing');
  const towers: { s: number; r: number }[] = [];
  const lamps: number[] = [];
  corners.forEach((_, i) => {
    towers.push({ s: i, r: 4.2 });
    const length = lengths[i] as number;
    const count = Math.max(1, Math.round(length / spacing));
    const clear = (s: number, room: number): boolean =>
      gates.every((g) => Math.abs(g.s - s) * length > g.road.cls.width / 2 + room);
    for (let k = 1; k < count; k += 1) {
      const s = i + k / count;
      if (clear(s, 6)) towers.push({ s, r: 3.2 });
    }
    for (let k = 0; k < count; k += 1) {
      const s = i + (k + 0.5) / count;
      if (clear(s, 3)) lamps.push(s);
    }
  });
  return {
    path,
    gates,
    towers,
    lamps,
    outer: outline(x0, z0, x1, z1),
    inner: outline(x0 + belt, z0 + belt, x1 - belt, z1 - belt),
  };
}

/** Whether `lot` reaches into the wall's belt: outside its inner edge anywhere. */
export function inBelt(lot: Lot, wall: Wall): boolean {
  const [a, , c] = wall.inner as [Vec2, Vec2, Vec2, Vec2];
  const [o, , p] = wall.outer as [Vec2, Vec2, Vec2, Vec2];
  const within =
    lot.bounds.x1 > o[0] && lot.bounds.x0 < p[0] && lot.bounds.z1 > o[1] && lot.bounds.z0 < p[1];
  const inside =
    lot.bounds.x0 >= a[0] &&
    lot.bounds.x1 <= c[0] &&
    lot.bounds.z0 >= a[1] &&
    lot.bounds.z1 <= c[1];
  return within && !inside;
}
