/**
 * A region's boundary, as a closed loop that never crosses itself.
 *
 * **A self-intersecting contour produces a polygon the funnel algorithm walks out of** — a path
 * that leaves the mesh, and an agent that walks through a wall. So simplification is *checked*
 * rather than trusted: Douglas–Peucker on a simple closed polygon is usually simple, and "usually"
 * is not a property a pathfinder can rest on. Where the simplified loop crosses itself the
 * deviation is halved and it is tried again, down to the raw boundary, which cannot cross itself
 * because it is a walk along cell edges.
 *
 * **The raw boundary is kept beside the simplified one.** The deviation is a claim about the two
 * together, and a test that cannot see the original cannot check it.
 */
import type { VoxelField } from './voxelise.ts';
import type { RegionField } from './regions.ts';

const SPAN_STRIDE = 3;

export interface Contour {
  readonly region: number;
  /** x,z pairs in cell units. A closed loop: the last point joins the first. */
  readonly points: Int32Array;
  /** The boundary before simplification, same layout. What the deviation is measured against. */
  readonly raw: Int32Array;
}

/** The four sides of a cell, as the directed edge each contributes when its neighbour is absent. */
const SIDES: readonly (readonly [number, number, number, number, number, number])[] = [
  /* dx, dz, from x, from z, to x, to z — all in cell-corner units, relative to the cell. */
  [-1, 0, 0, 1, 0, 0],
  [1, 0, 1, 0, 1, 1],
  [0, -1, 0, 0, 1, 0],
  [0, 1, 1, 1, 0, 1],
];

/** Which region a column's first walkable span belongs to, or `-1`. */
function regionAtColumn(field: VoxelField, regions: RegionField, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= field.width || z >= field.depth) return -1;
  const column = x + z * field.width;
  const from = (field.columnStart[column] as number) / SPAN_STRIDE;
  const to = (field.columnStart[column + 1] as number) / SPAN_STRIDE;
  for (let at = from; at < to; at += 1) {
    if (field.spans[at * SPAN_STRIDE + 2] === 1) return regions.regionOf[at] as number;
  }
  return -1;
}

/**
 * One closed loop per region, holes bridged into it, simplified.
 *
 * **This took the longest loop and dropped the rest until 2026-09-16, and the limitation was worse
 * than it was written down as.** It was stated as losing a pillar — an agent walking through a
 * column in the middle of a room. What it actually did was *claim ground*: a ring's outer loop is
 * the room's whole perimeter, so simplifying it gives a rectangle covering the pillar and whatever
 * else the watershed carved out of the middle. Measured on
 * `['..........', '....##....', '....##....', '..........']`, the ring's polygon came out as the
 * entire ten-by-four map, area 40 where the region is 32 — a navigation mesh asserting that a wall
 * and a neighbouring region are both walkable by the same agent.
 *
 * **Holes are bridged rather than emitted separately.** A hole as its own contour would become its
 * own walkable polygon, which is the same defect pointing the other way. A bridge joins the inner
 * loop to the outer along a segment traversed once each way, so the pair becomes **one closed loop
 * with a zero-width slit** — weakly simple rather than simple, which is what ear clipping wants and
 * what `segmentsCross` tolerates, since it requires a *strict* crossing and the two bridge edges
 * are coincident.
 */
export function buildContours(
  field: VoxelField,
  regions: RegionField,
  maxDeviation: number,
): Contour[] {
  const traced: { region: number; raw: Int32Array; bridges: number[] }[] = [];
  for (let region = 0; region < regions.count; region += 1) {
    const edges: Edge[] = [];
    for (let z = 0; z < field.depth; z += 1) {
      for (let x = 0; x < field.width; x += 1) {
        if (regionAtColumn(field, regions, x, z) !== region) continue;
        for (const [dx, dz, fx, fz, tx, tz] of SIDES) {
          if (regionAtColumn(field, regions, x + dx, z + dz) === region) continue;
          edges.push({ fx: x + fx, fz: z + fz, tx: x + tx, tz: z + tz, used: false });
        }
      }
    }
    if (edges.length === 0) continue;

    const loops = chainLoops(edges);
    if (loops.length === 0) continue;

    /*
     * **Bridge first, then simplify with the bridge vertices held fixed**, and both halves of that
     * were arrived at by getting them wrong.
     *
     * Simplifying the bridged loop *freely* destroys the slit: Douglas–Peucker has no idea the two
     * traversals of a bridge have to stay coincident, so it moves them independently and what was
     * weakly simple becomes genuinely self-overlapping. Ear clipping then produces a mesh that does
     * not cover its own contour — 67.5 against 82 on one of 150 random blobs, and 89 against 88 on
     * another.
     *
     * Simplifying each loop *before* bridging fixes that and breaks something else: a hole and the
     * boundary containing it then move independently, by up to the deviation each, so a hole can
     * poke through its own container and the contour crosses itself with no bridge involved.
     *
     * What works is holding the bridge's vertices — two endpoints, each appearing twice — and
     * simplifying the chains between them. A bridge has no interior vertices, so fixing its ends
     * fixes it exactly.
     */
    const bridged = bridgeHoles(loops);
    traced.push({ region, raw: Int32Array.from(bridged.loop), bridges: bridged.anchors });
  }

  /*
   * **A border two regions share has to come out of simplification the same from both sides.** A
   * portal is where two polygons' edges overlap, and each region's outline was simplified on its
   * own: a jagged border between two regions came out as two different lines, which overlap
   * nowhere, and a room the watershed had split was islands with no route between them. On a 16 by
   * 10 room with a pillar, simplified to 1.3, there were two regions and no path across.
   *
   * So the points where a border changes what it faces are held in every loop that passes through
   * them, which makes each stretch between two held points one border with the same two ends from
   * both sides; a bridge's ends are held everywhere for the same reason, since the region on the
   * far side of a hole meets them too. Each stretch is simplified in one canonical direction, so
   * both sides take the same points. And the halving that keeps a loop from crossing itself is
   * applied to every region together, because a shared stretch simplified at two deviations is two
   * lines again. One awkward region makes every outline finer, which costs vertices and nothing
   * else.
   */
  const bridgeEnds = new Set<string>();
  for (const { raw, bridges } of traced) {
    for (const at of bridges) bridgeEnds.add(`${raw[at * 2]},${raw[at * 2 + 1]}`);
  }
  const held = traced.map(({ raw }) => {
    const indices: number[] = [];
    for (let at = 0; at < raw.length / 2; at += 1) {
      const x = raw[at * 2] as number;
      const z = raw[at * 2 + 1] as number;
      if (bridgeEnds.has(`${x},${z}`) || isJunction(field, regions, x, z)) indices.push(at);
    }
    return indices;
  });

  for (let deviation = maxDeviation; deviation > 1e-4; deviation /= 2) {
    const simplified = traced.map(({ raw }, at) => simplifyOnce(raw, deviation, held[at] ?? []));
    if (simplified.some(contourSelfIntersects)) continue;
    return traced.map(({ region, raw }, at) => ({
      region,
      points: simplified[at] as Int32Array,
      raw,
    }));
  }
  return traced.map(({ region, raw }) => ({ region, points: raw, raw }));
}

/**
 * Whether three or more different things meet at a cell corner: regions, or regions and nothing.
 *
 * Where a region's boundary stops facing one thing and starts facing another, the corner has the
 * region and both of those around it, and that is the only way three can meet. So this is exactly
 * the set of points where some loop through the corner changes what it borders, decided from the
 * field alone, which is what lets every loop through it agree.
 */
function isJunction(field: VoxelField, regions: RegionField, x: number, z: number): boolean {
  const around = [
    regionAtColumn(field, regions, x - 1, z - 1),
    regionAtColumn(field, regions, x, z - 1),
    regionAtColumn(field, regions, x - 1, z),
    regionAtColumn(field, regions, x, z),
  ];
  return new Set(around).size >= 3;
}

/** One side of one cell, pointing so the region stays on the same hand throughout. */
interface Edge {
  readonly fx: number;
  readonly fz: number;
  readonly tx: number;
  readonly tz: number;
  used: boolean;
}

/**
 * Follow the directed edges into closed loops.
 *
 * **A vertex may have two outgoing edges, and the first version of this kept one of them.** Where a
 * region pinches — a one-cell isthmus, or a ring closing on itself — the boundary passes through
 * one corner twice, so a map from vertex to edge silently drops half the loop. Over 23,636 contours
 * from random blobs that produced 46 self-intersecting results, every one of which the guard in
 * `simplify` could not fix because the *raw* boundary was already wrong.
 *
 * The fix is to keep every edge. **Which of two edges is taken at a fork does not matter**, and a
 * sharpest-turn rule was written, measured and removed: every vertex has as many edges in as out,
 * so any choice decomposes the boundary into closed walks along cell edges, and a closed walk along
 * cell edges cannot cross itself whichever walk it is. Across 106,000 contours at six fill
 * densities the rule changed nothing, so it is not here.
 *
 * What the choice *does* decide is how a pinched boundary splits between two loops, and this takes
 * the longest — the same heuristic, and the same limitation, as a region with a hole.
 */
function chainLoops(edges: readonly Edge[]): number[][] {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = `${edge.fx},${edge.fz}`;
    const list = outgoing.get(key);
    if (list === undefined) outgoing.set(key, [edge]);
    else list.push(edge);
  }

  const loops: number[][] = [];
  /* Sorted, so a region with two loops always yields them in the same order. */
  for (const start of [...outgoing.keys()].sort()) {
    for (;;) {
      const first = (outgoing.get(start) ?? []).find((edge) => !edge.used);
      if (first === undefined) break;

      const loop: number[] = [];
      let edge: Edge | undefined = first;
      while (edge !== undefined && !edge.used) {
        edge.used = true;
        loop.push(edge.tx, edge.tz);
        edge = (outgoing.get(`${edge.tx},${edge.tz}`) ?? []).find((next) => !next.used);
      }
      if (loop.length >= 6) loops.push(loop);
    }
  }
  return loops;
}

/** Twice the signed area of a closed loop, which is the sign of its winding and the size of it. */
function twiceSignedArea(loop: readonly number[]): number {
  let total = 0;
  const count = loop.length / 2;
  for (let at = 0; at < count; at += 1) {
    const next = (at + 1) % count;
    total +=
      (loop[at * 2] as number) * (loop[next * 2 + 1] as number) -
      (loop[next * 2] as number) * (loop[at * 2 + 1] as number);
  }
  return total;
}

/** Whether every loop visits each vertex once and no two loops share one. */
function loopsAreDisjointAndSimple(loops: readonly (readonly number[])[]): boolean {
  const all = new Set<string>();
  for (const loop of loops) {
    const mine = new Set<string>();
    for (let at = 0; at < loop.length / 2; at += 1) {
      const key = `${loop[at * 2]},${loop[at * 2 + 1]}`;
      if (mine.has(key) || all.has(key)) return false;
      mine.add(key);
    }
    for (const key of mine) all.add(key);
  }
  return true;
}

/**
 * One loop out of several, with every hole cut into the outer one by a bridge.
 *
 * **The outer loop is the one with the largest area, not the most points.** A hole traced round a
 * long thin slot can carry more vertices than the boundary containing it, and picking by length
 * then makes the hole the region — the old heuristic failing in the one direction nobody looks.
 *
 * **Each hole is wound against the outer before it is spliced**, because that is what subtracts it.
 * A hole wound the same way *adds* its area, and every test about which corners are on the boundary
 * passes either way: the loop visits the same points, and only the shoelace sum can tell.
 *
 * **The bridge is the closest pair that nothing gets in the way of.** Every pair of vertices is
 * tried in order of distance and the first whose segment crosses no edge — of the outer loop, of
 * this hole, or of any hole still to be cut — is taken. That is quadratic in a region's boundary
 * and this is a bake: `buildContours` runs when a level is built, never in a tick, and the
 * alternative is the ray-casting construction whose correctness argument is three pages long.
 *
 * **A pinched boundary already visits a corner twice, and a bridge into one cannot be told from
 * the pinch.** `chainLoops` records the case: where a region narrows to a one-cell isthmus the walk
 * along cell edges passes through the same corner twice, so the loop is not simple before anything
 * is spliced into it. Bridging such a loop produces a vertex visited three times, which
 * `segmentsCross` tolerates — three edges meeting at a point never strictly cross — and which ear
 * clipping resolves by covering part of the region twice. Measured on a 12x12 blob whose region 7
 * is pinched *and* holed: a mesh of 83 against a contour of 82, a navigation mesh claiming ground
 * that is not walkable, which is the defect this whole change exists to remove. So a region whose
 * loops are not individually simple, or which share a vertex, keeps exactly what it had before —
 * the outer loop alone. **The limitation is now the narrow one it was always described as**, a
 * pillar in a room that also pinches, rather than every pillar in every room.
 */
function bridgeHoles(loops: readonly (readonly number[])[]): {
  loop: number[];
  anchors: number[];
} {
  if (loops.length === 1) return { loop: [...(loops[0] as readonly number[])], anchors: [] };

  const areas = loops.map(twiceSignedArea);
  let outerAt = 0;
  for (let at = 1; at < loops.length; at += 1) {
    if (Math.abs(areas[at] as number) > Math.abs(areas[outerAt] as number)) outerAt = at;
  }
  if (!loopsAreDisjointAndSimple(loops)) {
    return { loop: [...(loops[outerAt] as readonly number[])], anchors: [] };
  }
  const outerSign = Math.sign(areas[outerAt] as number);

  let merged = [...(loops[outerAt] as readonly number[])];
  const holes: number[][] = [];
  for (let at = 0; at < loops.length; at += 1) {
    if (at === outerAt) continue;
    const hole = [...(loops[at] as readonly number[])];
    if (Math.sign(areas[at] as number) === outerSign) reverseLoop(hole);
    holes.push(hole);
  }
  /* Deterministic order, so two builds of one level produce the same mesh. */
  holes.sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number));

  let anchors: number[] = [];
  /* The coordinates every bridge placed so far lands on. See `spliceHole` for why they are barred. */
  const taken = new Set<string>();
  for (let at = 0; at < holes.length; at += 1) {
    const spliced = spliceHole(merged, holes[at] as number[], holes.slice(at + 1), taken);
    /* Anchors recorded earlier sit before the splice, or shift by the hole's length after it. */
    const grew = (holes[at] as number[]).length / 2 + 1;
    anchors = [
      ...anchors.map((index) => (index <= spliced.insertedAfter ? index : index + grew)),
      ...spliced.anchors,
    ];
    merged = spliced.loop;
  }
  anchors.sort((a, b) => a - b);
  return { loop: merged, anchors };
}

/** A loop the other way round, in place. */
function reverseLoop(loop: number[]): void {
  const count = loop.length / 2;
  for (let at = 0; at < Math.floor(count / 2); at += 1) {
    const other = count - 1 - at;
    const x = loop[at * 2] as number;
    const z = loop[at * 2 + 1] as number;
    loop[at * 2] = loop[other * 2] as number;
    loop[at * 2 + 1] = loop[other * 2 + 1] as number;
    loop[other * 2] = x;
    loop[other * 2 + 1] = z;
  }
}

/** Cut one hole into a loop along the shortest segment that crosses nothing. */
function spliceHole(
  outer: readonly number[],
  hole: readonly number[],
  pending: readonly (readonly number[])[],
  taken: Set<string>,
): { loop: number[]; anchors: number[]; insertedAfter: number } {
  const outerCount = outer.length / 2;
  const holeCount = hole.length / 2;
  const pairs: { outerAt: number; holeAt: number; distance: number }[] = [];
  for (let o = 0; o < outerCount; o += 1) {
    for (let h = 0; h < holeCount; h += 1) {
      const dx = (outer[o * 2] as number) - (hole[h * 2] as number);
      const dz = (outer[o * 2 + 1] as number) - (hole[h * 2 + 1] as number);
      pairs.push({ outerAt: o, holeAt: h, distance: dx * dx + dz * dz });
    }
  }
  /* Ties broken by index, so the choice does not depend on the sort's stability. */
  pairs.sort((a, b) => a.distance - b.distance || a.outerAt - b.outerAt || a.holeAt - b.holeAt);

  for (const pair of pairs) {
    const ax = outer[pair.outerAt * 2] as number;
    const az = outer[pair.outerAt * 2 + 1] as number;
    const bx = hole[pair.holeAt * 2] as number;
    const bz = hole[pair.holeAt * 2 + 1] as number;
    if (ax === bx && az === bz) continue;
    /*
     * **No two bridges may land on the same vertex**, and **no bridge may cross an edge.** Sharing a
     * vertex gives a loop that visits it three times, which is a tangle rather than a slit — two
     * bridges meeting at a point never *strictly* cross, so `segmentsCross` allows it and ear
     * clipping resolves it by covering part of the region twice. A bridge across an edge gives a
     * polygon that is not even weakly simple.
     *
     * **Neither guard has been reached by a test, and both are kept.** The disjoint-and-simple
     * check above turns away the shapes that produced tangles, and across 150 random blobs, three
     * hand-drawn pillar rooms and a spiral corridor, every hole's closest vertex pair was already
     * clear and unclaimed. They are guards against a case the check above has not been *proved* to
     * exclude, which is a different thing from one it has — a hole tucked inside a concavity has a
     * blocked closest pair by construction, and nothing here says a region cannot have one.
     * Perturbing either changes no test; that is recorded rather than papered over.
     */
    if (taken.has(`${ax},${az}`) || taken.has(`${bx},${bz}`)) continue;
    if (bridgeBlocked(ax, az, bx, bz, outer, hole, pending)) continue;

    taken.add(`${ax},${az}`);
    taken.add(`${bx},${bz}`);
    const out: number[] = [];
    for (let at = 0; at <= pair.outerAt; at += 1) {
      out.push(outer[at * 2] as number, outer[at * 2 + 1] as number);
    }
    for (let step = 0; step <= holeCount; step += 1) {
      const at = (pair.holeAt + step) % holeCount;
      out.push(hole[at * 2] as number, hole[at * 2 + 1] as number);
    }
    for (let at = pair.outerAt; at < outerCount; at += 1) {
      out.push(outer[at * 2] as number, outer[at * 2 + 1] as number);
    }
    /*
     * The four vertices the bridge is made of: the outer vertex either side of the slit, and the
     * hole vertex at each end of the loop round the hole. Holding these is what keeps the two
     * traversals of the bridge exactly on top of each other through simplification.
     */
    const holeStart = pair.outerAt + 1;
    return {
      loop: out,
      anchors: [pair.outerAt, holeStart, holeStart + holeCount, holeStart + holeCount + 1],
      insertedAfter: pair.outerAt,
    };
  }

  /*
   * **Nothing could be joined, so the hole is left out rather than joined wrongly.** A bridge that
   * crossed an edge would produce a polygon that is not even weakly simple, which is worse than the
   * limitation this replaces.
   */
  return { loop: [...outer], anchors: [], insertedAfter: outerCount - 1 };
}

/** Whether a proposed bridge strictly crosses any edge of any loop it has to pass. */
function bridgeBlocked(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  outer: readonly number[],
  hole: readonly number[],
  pending: readonly (readonly number[])[],
): boolean {
  for (const loop of [outer, hole, ...pending]) {
    const count = loop.length / 2;
    for (let at = 0; at < count; at += 1) {
      const next = (at + 1) % count;
      if (
        segmentsCross(
          ax,
          az,
          bx,
          bz,
          loop[at * 2] as number,
          loop[at * 2 + 1] as number,
          loop[next * 2] as number,
          loop[next * 2 + 1] as number,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Perpendicular distance from `p` to the segment `a`–`b`, or to `a` where the segment is a point. */
function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  // determinism: build-time — contour simplification is a bake, never a tick
  if (lengthSq === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  // determinism: build-time — contour simplification is a bake, never a tick
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** The furthest any raw point sits from the simplified loop. What the deviation bound means. */
export function maxDeviationOf(raw: Int32Array, simplified: Int32Array): number {
  const count = simplified.length / 2;
  if (count < 2) return Infinity;
  let worst = 0;
  for (let at = 0; at < raw.length; at += 2) {
    let best = Infinity;
    for (let seg = 0; seg < count; seg += 1) {
      const next = (seg + 1) % count;
      best = Math.min(
        best,
        distanceToSegment(
          raw[at] as number,
          raw[at + 1] as number,
          simplified[seg * 2] as number,
          simplified[seg * 2 + 1] as number,
          simplified[next * 2] as number,
          simplified[next * 2 + 1] as number,
        ),
      );
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/**
 * Whether any two non-adjacent segments of a closed loop cross.
 *
 * Adjacent segments share an endpoint by construction and are skipped; everything else is a proper
 * crossing test, so a loop that merely touches itself at a vertex is not reported — that is a
 * pinch rather than a crossing, and a polygon built from it is still walkable.
 */
export function contourSelfIntersects(points: Int32Array): boolean {
  const count = points.length / 2;
  if (count < 4) return false;
  for (let a = 0; a < count; a += 1) {
    const a2 = (a + 1) % count;
    for (let b = a + 1; b < count; b += 1) {
      const b2 = (b + 1) % count;
      if (a === b || a2 === b || b2 === a) continue;
      if (
        segmentsCross(
          points[a * 2] as number,
          points[a * 2 + 1] as number,
          points[a2 * 2] as number,
          points[a2 * 2 + 1] as number,
          points[b * 2] as number,
          points[b * 2 + 1] as number,
          points[b2 * 2] as number,
          points[b2 * 2 + 1] as number,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function side(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  return Math.sign((bx - ax) * (pz - az) - (bz - az) * (px - ax));
}

function segmentsCross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = side(ax, az, bx, bz, cx, cz);
  const d2 = side(ax, az, bx, bz, dx, dz);
  const d3 = side(cx, cz, dx, dz, ax, az);
  const d4 = side(cx, cz, dx, dz, bx, bz);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/**
 * Douglas–Peucker around a closed loop, holding `held` and simplifying the stretches between.
 *
 * `buildContours` halves the deviation until no loop crosses itself. The raw boundary is a walk
 * along cell edges and cannot cross itself, so that terminates at something valid however hostile
 * the shape: it costs a few extra passes on a shape that needs them and nothing on one that does
 * not.
 */
function simplifyOnce(raw: Int32Array, maxDeviation: number, held: readonly number[]): Int32Array {
  const count = raw.length / 2;
  if (count < 4) return raw;

  const keep = new Uint8Array(count);
  let fixed: number[];
  if (held.length > 0) {
    /*
     * **Held points are a bridge or a change of neighbour, and they are not negotiable.** Every
     * stretch between two of them is an open polyline Douglas–Peucker may do as it likes with; the
     * held points are what keep the two traversals of each bridge coincident, and each shared
     * border the same from both of its regions.
     */
    fixed = [...held];
  } else {
    /* Two anchors, so the loop becomes two open chains: the first point and the one furthest. */
    let far = 0;
    let farDistance = -1;
    for (let at = 1; at < count; at += 1) {
      // determinism: build-time — contour simplification is a bake, never a tick
      const d = Math.hypot(
        (raw[at * 2] as number) - (raw[0] as number),
        (raw[at * 2 + 1] as number) - (raw[1] as number),
      );
      if (d > farDistance) {
        farDistance = d;
        far = at;
      }
    }
    fixed = [0, far];
  }

  for (const at of fixed) keep[at] = 1;
  for (let at = 0; at < fixed.length; at += 1) {
    const from = fixed[at] as number;
    const to = at + 1 < fixed.length ? (fixed[at + 1] as number) : (fixed[0] as number) + count;
    stretch(raw, from, to, maxDeviation, keep);
  }

  /*
   * **Only a *held* point is protected from the collinear pass, never the arbitrary pair.** The two
   * anchors of a loop with nothing held are wherever the trace happened to start and whatever was
   * furthest from it, so one is routinely a point in the middle of a straight edge — and
   * `dropCollinear` exists precisely to remove that, which is what keeps an L six-cornered.
   */
  const out: number[] = [];
  const protectedOut: number[] = [];
  for (let at = 0; at < count; at += 1) {
    if (keep[at] !== 1) continue;
    if (held.length > 0 && fixed.includes(at)) protectedOut.push(out.length / 2);
    out.push(raw[at * 2] as number, raw[at * 2 + 1] as number);
  }
  return dropCollinear(Int32Array.from(out), protectedOut);
}

/**
 * Remove any point that lies on the line between its neighbours.
 *
 * **The anchors are arbitrary and one of them is always kept**, so without this a loop that happens
 * to start halfway along an edge carries a seventh point through a six-cornered shape — a vertex
 * that is not a corner, in a mesh whose polygons are built from these. Removing a collinear point
 * cannot affect the deviation bound, because a point on the line between its neighbours is at
 * distance zero from the segment that replaces it.
 */
function dropCollinear(points: Int32Array, protect: readonly number[] = []): Int32Array {
  const count = points.length / 2;
  if (count < 4) return points;
  const out: number[] = [];
  for (let at = 0; at < count; at += 1) {
    /* A bridge endpoint is collinear with its neighbours as often as not, and removing one opens
       the slit into the rest of the polygon. */
    if (protect.includes(at)) {
      out.push(points[at * 2] as number, points[at * 2 + 1] as number);
      continue;
    }
    const prev = (at + count - 1) % count;
    const next = (at + 1) % count;
    const cross =
      ((points[at * 2] as number) - (points[prev * 2] as number)) *
        ((points[next * 2 + 1] as number) - (points[prev * 2 + 1] as number)) -
      ((points[at * 2 + 1] as number) - (points[prev * 2 + 1] as number)) *
        ((points[next * 2] as number) - (points[prev * 2] as number));
    if (cross === 0) continue;
    out.push(points[at * 2] as number, points[at * 2 + 1] as number);
  }
  return out.length >= 6 ? Int32Array.from(out) : points;
}

/**
 * Mark the points of `raw` from `from` to `to` that have to stay. `to` may pass the end, which
 * wraps; `to` equal to `from` plus the loop's length is the whole loop from one held point.
 *
 * **Walked in one canonical direction, whichever way the loop runs**, so a border two regions
 * share, which each traces the other way round, keeps the same points from both sides: the
 * stretch runs from its lesser end to its greater, comparing x then z, and a stretch that starts
 * and ends at one point runs toward the lesser of its two neighbours.
 */
function stretch(
  raw: Int32Array,
  from: number,
  to: number,
  maxDeviation: number,
  keep: Uint8Array,
): void {
  const count = raw.length / 2;
  if (to - from < 2) return;
  const order: number[] = [];
  for (let at = from; at <= to; at += 1) order.push(at % count);
  const last = order.length - 1;
  const first = order[0] as number;
  const end = order[last] as number;
  const sameEnds = raw[first * 2] === raw[end * 2] && raw[first * 2 + 1] === raw[end * 2 + 1];
  const backwards = sameEnds
    ? lesser(raw, order[last - 1] as number, order[1] as number)
    : lesser(raw, end, first);
  if (backwards) order.reverse();
  douglasPeucker(raw, order, 0, last, maxDeviation, keep);
}

/** Whether point `a` comes before point `b`, by x and then by z. */
function lesser(raw: Int32Array, a: number, b: number): boolean {
  const ax = raw[a * 2] as number;
  const bx = raw[b * 2] as number;
  return ax < bx || (ax === bx && (raw[a * 2 + 1] as number) < (raw[b * 2 + 1] as number));
}

/** Keep the furthest point of `order` between `lo` and `hi` while it is further than the bound. */
function douglasPeucker(
  raw: Int32Array,
  order: readonly number[],
  lo: number,
  hi: number,
  maxDeviation: number,
  keep: Uint8Array,
): void {
  if (hi - lo < 2) return;
  const a = order[lo] as number;
  const b = order[hi] as number;
  let worst = -1;
  let worstAt = -1;
  for (let at = lo + 1; at < hi; at += 1) {
    const point = order[at] as number;
    const d = distanceToSegment(
      raw[point * 2] as number,
      raw[point * 2 + 1] as number,
      raw[a * 2] as number,
      raw[a * 2 + 1] as number,
      raw[b * 2] as number,
      raw[b * 2 + 1] as number,
    );
    if (d > worst) {
      worst = d;
      worstAt = at;
    }
  }
  if (worst <= maxDeviation || worstAt < 0) return;
  keep[order[worstAt] as number] = 1;
  douglasPeucker(raw, order, lo, worstAt, maxDeviation, keep);
  douglasPeucker(raw, order, worstAt, hi, maxDeviation, keep);
}
