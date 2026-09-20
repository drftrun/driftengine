/**
 * Contours to convex polygons that tile the region and border each other both ways.
 *
 * **Convex, because the funnel algorithm is what makes a path a straight line** and it walks a
 * corridor of convex cells. A concave polygon has an interior point the straight line between two
 * of its own vertices leaves, so the funnel would produce a path through a wall.
 *
 * **Adjacency is built from shared edges in both directions at once**, because a one-directional
 * build breaks silently: what it produces is a mesh where a path from A to B exists and the same
 * path from B to A does not, which reads as a pathfinding bug and is a mesh-building one.
 *
 * Ear clipping first, then merge neighbours while the result stays convex. Triangles are convex by
 * definition, so the merge can only ever improve the mesh and never make it invalid — which is why
 * it can be a plain greedy pass with no backtracking.
 */
import type { Contour } from './contour.ts';

const NO_VERTEX = -1;
export const NO_NEIGHBOUR = -1;

/**
 * Where a mesh stands in the world: a vertex at cell `(i, j)` is at `originX + i * cellSize`,
 * `originZ + j * cellSize`. A `VoxelField` is one, which is what `buildPolyMesh` is meant to be
 * handed.
 */
export interface NavPlacement {
  /** x, y, z of the field's corner; y is not used, since a polygon mesh has none. */
  readonly origin: ArrayLike<number>;
  readonly cellSize: number;
}

export interface PolyMesh {
  /** x,z per vertex, in cell units. `originX`, `originZ` and `cellSize` turn them into metres. */
  readonly vertices: Int32Array;
  readonly vertexCount: number;
  /** `maxVertsPerPoly` slots per polygon, padded with `-1`. */
  readonly polys: Int32Array;
  /** The polygon across each edge, or `-1`. Same layout as `polys`: edge `i` leaves vertex `i`. */
  readonly neighbours: Int32Array;
  readonly polyCount: number;
  readonly maxVertsPerPoly: number;
  /** Which region each polygon came from. */
  readonly polyRegion: Int32Array;
  /**
   * **Where the mesh stands, kept with it.** The field it was built from knew and the mesh used to
   * drop it, so a query given positions in metres compared them with cell indices and answered in
   * a mixture of the two — invisible to every test that built its field at the origin with one-unit
   * cells, where the two are the same number.
   */
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
}

export function polyVertexCount(mesh: PolyMesh, poly: number): number {
  let count = 0;
  for (let at = 0; at < mesh.maxVertsPerPoly; at += 1) {
    if (mesh.polys[poly * mesh.maxVertsPerPoly + at] !== NO_VERTEX) count += 1;
  }
  return count;
}

export function polyNeighbour(mesh: PolyMesh, poly: number, edge: number): number {
  return mesh.neighbours[poly * mesh.maxVertsPerPoly + edge] ?? NO_NEIGHBOUR;
}

/** The shoelace area, which is positive for the winding this builds and zero for a degenerate. */
export function polyArea(mesh: PolyMesh, poly: number): number {
  const count = polyVertexCount(mesh, poly);
  let twice = 0;
  for (let at = 0; at < count; at += 1) {
    const a = mesh.polys[poly * mesh.maxVertsPerPoly + at] as number;
    const b = mesh.polys[poly * mesh.maxVertsPerPoly + ((at + 1) % count)] as number;
    twice +=
      (mesh.vertices[a * 2] as number) * (mesh.vertices[b * 2 + 1] as number) -
      (mesh.vertices[b * 2] as number) * (mesh.vertices[a * 2 + 1] as number);
  }
  return Math.abs(twice) / 2;
}

export function polyIsConvex(mesh: PolyMesh, poly: number): boolean {
  const count = polyVertexCount(mesh, poly);
  if (count < 3) return false;
  const indices: number[] = [];
  for (let at = 0; at < count; at += 1) {
    indices.push(mesh.polys[poly * mesh.maxVertsPerPoly + at] as number);
  }
  return isConvexLoop(indices, mesh.vertices);
}

function cross(vertices: Int32Array, a: number, b: number, c: number): number {
  return (
    ((vertices[b * 2] as number) - (vertices[a * 2] as number)) *
      ((vertices[c * 2 + 1] as number) - (vertices[a * 2 + 1] as number)) -
    ((vertices[b * 2 + 1] as number) - (vertices[a * 2 + 1] as number)) *
      ((vertices[c * 2] as number) - (vertices[a * 2] as number))
  );
}

/** Every turn the same way round, treating a straight run as no turn at all. */
function isConvexLoop(loop: readonly number[], vertices: Int32Array): boolean {
  let sign = 0;
  for (let at = 0; at < loop.length; at += 1) {
    const a = loop[at] as number;
    const b = loop[(at + 1) % loop.length] as number;
    const c = loop[(at + 2) % loop.length] as number;
    const turn = Math.sign(cross(vertices, a, b, c));
    if (turn === 0) continue;
    if (sign === 0) sign = turn;
    else if (turn !== sign) return false;
  }
  return sign !== 0;
}

/** Whether `p` is inside or on triangle `a b c`, used to reject an ear that swallows a vertex. */
function inTriangle(vertices: Int32Array, a: number, b: number, c: number, p: number): boolean {
  const d1 = cross(vertices, a, b, p);
  const d2 = cross(vertices, b, c, p);
  const d3 = cross(vertices, c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** Ear clipping. The loop is counter-clockwise by the time it gets here. */
function triangulate(loop: number[], vertices: Int32Array): number[][] {
  const out: number[][] = [];
  const working = [...loop];
  let guard = working.length * working.length + 8;

  while (working.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let at = 0; at < working.length; at += 1) {
      const a = working[(at + working.length - 1) % working.length] as number;
      const b = working[at] as number;
      const c = working[(at + 1) % working.length] as number;
      if (cross(vertices, a, b, c) <= 0) continue;

      let swallows = false;
      for (const other of working) {
        if (other === a || other === b || other === c) continue;
        if (inTriangle(vertices, a, b, c, other)) {
          swallows = true;
          break;
        }
      }
      if (swallows) continue;

      out.push([a, b, c]);
      working.splice(at, 1);
      clipped = true;
      break;
    }
    /* A loop with no ear at all is degenerate; stopping beats spinning inside a bake. */
    if (!clipped) break;
  }
  if (working.length === 3) out.push([...working]);
  return out;
}

/** Merge neighbours while the result stays convex and inside the vertex budget. */
function mergeConvex(polys: number[][], vertices: Int32Array, maxVerts: number): number[][] {
  const live = polys.map((poly) => [...poly]);
  for (let changed = true; changed;) {
    changed = false;
    for (let a = 0; a < live.length && !changed; a += 1) {
      for (let b = a + 1; b < live.length && !changed; b += 1) {
        const merged = mergeIfConvex(live[a] as number[], live[b] as number[], vertices, maxVerts);
        if (merged === null) continue;
        live[a] = merged;
        live.splice(b, 1);
        changed = true;
      }
    }
  }
  return live;
}

/** The two polygons as one, or null where they do not share an edge or the result is not convex. */
function mergeIfConvex(
  a: readonly number[],
  b: readonly number[],
  vertices: Int32Array,
  maxVerts: number,
): number[] | null {
  for (let i = 0; i < a.length; i += 1) {
    const a0 = a[i] as number;
    const a1 = a[(i + 1) % a.length] as number;
    for (let j = 0; j < b.length; j += 1) {
      const b0 = b[j] as number;
      const b1 = b[(j + 1) % b.length] as number;
      /* A shared edge runs the other way round in the neighbour, which is what makes them fit. */
      if (a0 !== b1 || a1 !== b0) continue;

      const loop: number[] = [];
      for (let k = 1; k < a.length; k += 1) loop.push(a[(i + k) % a.length] as number);
      for (let k = 1; k < b.length; k += 1) loop.push(b[(j + k) % b.length] as number);
      if (loop.length > maxVerts) return null;
      return isConvexLoop(loop, vertices) ? loop : null;
    }
  }
  return null;
}

export function buildPolyMesh(
  contours: readonly Contour[],
  maxVertsPerPoly: number,
  placement: NavPlacement,
): PolyMesh {
  const maxVerts = Math.max(3, maxVertsPerPoly);
  const vertexKeys = new Map<string, number>();
  const vertexList: number[] = [];
  const polys: number[][] = [];
  const regions: number[] = [];

  const intern = (x: number, z: number): number => {
    const key = `${x},${z}`;
    const found = vertexKeys.get(key);
    if (found !== undefined) return found;
    const index = vertexList.length / 2;
    vertexList.push(x, z);
    vertexKeys.set(key, index);
    return index;
  };

  for (const contour of contours) {
    const loop: number[] = [];
    for (let at = 0; at < contour.points.length; at += 2) {
      loop.push(intern(contour.points[at] as number, contour.points[at + 1] as number));
    }
    if (loop.length < 3) continue;

    const vertices = Int32Array.from(vertexList);
    /* Counter-clockwise, because ear clipping tests a positive turn and the walk may go either way. */
    if (signedArea(loop, vertices) < 0) loop.reverse();

    const pieces = mergeConvex(triangulate(loop, vertices), vertices, maxVerts);
    for (const piece of pieces) {
      polys.push(piece);
      regions.push(contour.region);
    }
  }

  const vertices = Int32Array.from(vertexList);
  const polyCount = polys.length;
  const table = new Int32Array(polyCount * maxVerts).fill(NO_VERTEX);
  const neighbours = new Int32Array(polyCount * maxVerts).fill(NO_NEIGHBOUR);
  for (let poly = 0; poly < polyCount; poly += 1) {
    const piece = polys[poly] as number[];
    for (let at = 0; at < piece.length && at < maxVerts; at += 1) {
      table[poly * maxVerts + at] = piece[at] as number;
    }
  }

  /*
   * Both directions in one pass. An edge `a → b` in one polygon is `b → a` in its neighbour, so
   * recording the pair the moment it is found makes the relation symmetric by construction rather
   * than by a second loop somebody could forget.
   */
  const edgeOwner = new Map<string, [number, number]>();
  for (let poly = 0; poly < polyCount; poly += 1) {
    const piece = polys[poly] as number[];
    for (let at = 0; at < piece.length; at += 1) {
      const from = piece[at] as number;
      const to = piece[(at + 1) % piece.length] as number;
      const reverse = edgeOwner.get(`${to},${from}`);
      if (reverse === undefined) {
        edgeOwner.set(`${from},${to}`, [poly, at]);
        continue;
      }
      neighbours[poly * maxVerts + at] = reverse[0];
      neighbours[reverse[0] * maxVerts + reverse[1]] = poly;
    }
  }

  return {
    vertices,
    vertexCount: vertices.length / 2,
    polys: table,
    neighbours,
    polyCount,
    maxVertsPerPoly: maxVerts,
    polyRegion: Int32Array.from(regions),
    originX: placement.origin[0] as number,
    originZ: placement.origin[2] as number,
    cellSize: placement.cellSize,
  };
}

function signedArea(loop: readonly number[], vertices: Int32Array): number {
  let twice = 0;
  for (let at = 0; at < loop.length; at += 1) {
    const a = loop[at] as number;
    const b = loop[(at + 1) % loop.length] as number;
    twice +=
      (vertices[a * 2] as number) * (vertices[b * 2 + 1] as number) -
      (vertices[b * 2] as number) * (vertices[a * 2 + 1] as number);
  }
  return twice / 2;
}
