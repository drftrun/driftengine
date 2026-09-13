import type { Aabb } from './collide/index.ts';
import type { ConvexShape } from './shape.ts';
import type { Heightfield } from './heightfieldShape.ts';
import { DynamicTree } from './tree.ts';

/**
 * A static triangle mesh as a collision shape: the triangles, their planes, and the tree over them.
 *
 * **Static only, and the limit is enforced rather than documented.** `PhysicsWorld.addBody` refuses
 * one on anything but a static body and `colliderFromShape` refuses one outright. A moving concave
 * mesh needs its tree rebuilt or refitted every tick and needs a mass tensor a triangle soup does
 * not have — and the usual answer to a moving concave thing is convex decomposition, which is a row
 * of its own. **Most consumers want exactly this**: the level is a mesh and everything in it is a
 * hull, a box or a sphere.
 *
 * **The tree is `DynamicTree`, built once and never moved.** A second acceleration structure would
 * be a second thing to get right, and the one this package already has is an AABB tree with a
 * tested query — its incremental machinery simply goes unused. *What that costs* is the 10 cm fat
 * margin every proxy carries, which for a small triangle means a query returns a few candidates it
 * did not need; the narrow phase rejects them in one separating-axis test each. *What would make it
 * wrong* is a mesh of millimetre triangles, where the margin dwarfs the geometry and every query
 * returns most of the mesh.
 *
 * **The interior-edge data is the half that decides whether it feels right.** A box sliding across
 * two triangles catches on their shared edge, because at the seam the narrow phase finds the edge
 * rather than the face and pushes the box back along it — the classic symptom is a character
 * stumbling on a perfectly flat floor every metre. Each edge is therefore classified once, here,
 * as convex or not, and `meshContact.ts` uses that to replace an edge normal with the face's.
 */
export interface TriangleMesh {
  /** xyz per vertex, in the mesh's own space. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  /** `nx, ny, nz, d` per triangle: the outward plane, with `d = n · v0`. */
  readonly planes: Float32Array;
  /**
   * Three bits per triangle, one per edge: set where the fold at that edge turns **away** from the
   * front face, or where the edge has no neighbour at all.
   *
   * Edge `i` runs from local vertex `i` to `(i + 1) % 3`. A boundary edge counts as convex because
   * there is nothing on the other side to be caught between; a coplanar neighbour counts as *not*
   * convex, because a flat seam is exactly the case a contact must never come off.
   */
  readonly convexEdges: Uint8Array;
  /**
   * Over triangle indices, built once — and **null for a heightfield**, which needs none.
   *
   * A field's candidates are an index range rather than a tree query: the cells a box covers are
   * arithmetic on its own bounds. See `heightfieldShape.ts`, which is the other producer of this
   * shape and the reason this is nullable.
   */
  readonly tree: DynamicTree | null;
  /**
   * Set where the triangles are generated from a heightfield rather than stored.
   *
   * The arrays above are then empty and nothing reads them: `meshContact.ts` and `query.ts` take
   * their corners, planes and edge classifications from the field instead. Everything *else* about
   * a mesh — the one-sided rule, the many manifolds, the interior-edge filter — is shared, which is
   * the whole design.
   */
  readonly field?: Heightfield;
}

/** How far a neighbour's opposite vertex must sit off a plane before the fold has a direction. */
const COPLANAR_M = 1e-5;

/**
 * Build a static mesh shape.
 *
 * Returns a `ConvexShape` whose `triangles` names the mesh, whose `vertices` are the eight corners
 * of its bounding box — so `shapeBounds`, `boundRadius` and the broad phase need no special case —
 * and whose `faceNormals` and `edgeDirs` are **empty**. That last part is deliberate: a mesh has no
 * separating axes worth enumerating, and handing the kinematic sweep the box's three would make it
 * treat a hollow level as a solid brick.
 *
 * **`positions` and `indices` are kept, not copied**, the same bargain `packSplats` makes: a level
 * mesh is megabytes and duplicating it serves nobody. A caller must not go on mutating them, which
 * is stated here because nothing enforces it.
 */
export function meshShape(positions: Float32Array, indices: Uint32Array): ConvexShape {
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error(
      `meshShape: ${indices.length} indices is not a whole number of triangles, or is none at all`,
    );
  }
  const triangleCount = indices.length / 3;
  const planes = new Float32Array(triangleCount * 4);
  const convexEdges = new Uint8Array(triangleCount);
  const tree = new DynamicTree(Math.max(64, triangleCount * 2));

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const box: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  /*
   * Every undirected edge to the one triangle that has claimed it, so the second triangle to meet
   * it finds the first. A `Map` rather than a sorted array because this is build-time and the key
   * is a pair of indices; the value packs the triangle and which of its three edges it was.
   */
  const edges = new Map<number, number>();
  const vertexCount = positions.length / 3;
  const edgeKey = (a: number, b: number): number => (a < b ? a : b) * vertexCount + (a < b ? b : a);

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3] ?? 0;
    const i1 = indices[t * 3 + 1] ?? 0;
    const i2 = indices[t * 3 + 2] ?? 0;
    const ax = positions[i0 * 3] ?? 0;
    const ay = positions[i0 * 3 + 1] ?? 0;
    const az = positions[i0 * 3 + 2] ?? 0;
    const bx = positions[i1 * 3] ?? 0;
    const by = positions[i1 * 3 + 1] ?? 0;
    const bz = positions[i1 * 3 + 2] ?? 0;
    const cx = positions[i2 * 3] ?? 0;
    const cy = positions[i2 * 3 + 1] ?? 0;
    const cz = positions[i2 * 3 + 2] ?? 0;

    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    /*
     * A degenerate triangle has no normal and is dropped rather than refused: a mesh exported from
     * a modelling tool routinely carries a few, and rejecting the whole level for three slivers
     * would be a refusal a consumer cannot act on. It keeps its slot so triangle indices still
     * name the caller's own triangles, and its plane is a zero the contact code skips.
     */
    if (length > 1e-12) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    planes[t * 4] = nx;
    planes[t * 4 + 1] = ny;
    planes[t * 4 + 2] = nz;
    planes[t * 4 + 3] = nx * ax + ny * ay + nz * az;

    box.minX = Math.min(ax, bx, cx);
    box.minY = Math.min(ay, by, cy);
    box.minZ = Math.min(az, bz, cz);
    box.maxX = Math.max(ax, bx, cx);
    box.maxY = Math.max(ay, by, cy);
    box.maxZ = Math.max(az, bz, cz);
    tree.insert(t, box);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    minZ = Math.min(minZ, box.minZ);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    maxZ = Math.max(maxZ, box.maxZ);

    /* Every edge starts convex; meeting a neighbour is what can take that away. */
    convexEdges[t] = 0b111;
    for (let e = 0; e < 3; e++) {
      const from = indices[t * 3 + e] ?? 0;
      const to = indices[t * 3 + ((e + 1) % 3)] ?? 0;
      const key = edgeKey(from, to);
      const seen = edges.get(key);
      if (seen === undefined) {
        edges.set(key, t * 3 + e);
        continue;
      }
      classify(positions, indices, planes, convexEdges, t, e, seen);
    }
  }

  return {
    /* The eight corners of the bounds, so everything that measures a shape measures the right box. */
    vertices: new Float32Array([
      minX,
      minY,
      minZ,
      maxX,
      minY,
      minZ,
      minX,
      maxY,
      minZ,
      maxX,
      maxY,
      minZ,
      minX,
      minY,
      maxZ,
      maxX,
      minY,
      maxZ,
      minX,
      maxY,
      maxZ,
      maxX,
      maxY,
      maxZ,
    ]),
    faceNormals: new Float32Array(0),
    edgeDirs: new Float32Array(0),
    radius: 0,
    sideRadius: 0,
    boundRadius: Math.sqrt(
      Math.max(minX * minX, maxX * maxX) +
        Math.max(minY * minY, maxY * maxY) +
        Math.max(minZ * minZ, maxZ * maxZ),
    ),
    facePlanes: new Float32Array(0),
    faceVertexStart: new Uint16Array(0),
    faceVertexIndices: new Uint16Array(0),
    triangles: { positions, indices, triangleCount, planes, convexEdges, tree },
  };
}

/**
 * Decide, for one shared edge, whether either side of it may produce a contact normal of its own.
 *
 * The test is where the *other* triangle's opposite vertex sits relative to this one's plane, and
 * both sides are answered at once because the answer is symmetric in what it forbids: a fold that
 * turns away from one face turns toward the other.
 */
function classify(
  positions: Float32Array,
  indices: Uint32Array,
  planes: Float32Array,
  convexEdges: Uint8Array,
  triangle: number,
  edge: number,
  other: number,
): void {
  const otherTriangle = Math.floor(other / 3);
  const otherEdge = other % 3;
  /* The vertex neither triangle shares: the one opposite the edge. */
  const opposite = indices[otherTriangle * 3 + ((otherEdge + 2) % 3)] ?? 0;
  const px = positions[opposite * 3] ?? 0;
  const py = positions[opposite * 3 + 1] ?? 0;
  const pz = positions[opposite * 3 + 2] ?? 0;
  const height =
    px * (planes[triangle * 4] ?? 0) +
    py * (planes[triangle * 4 + 1] ?? 0) +
    pz * (planes[triangle * 4 + 2] ?? 0) -
    (planes[triangle * 4 + 3] ?? 0);

  /*
   * **Below the plane is a convex fold and everything else is not.** A neighbour that rises above
   * this triangle's face is a concave corner, where a contact normal off the edge is a normal
   * pointing into a wall that is really there; a neighbour lying in the plane is a flat seam, where
   * an edge normal is the interior-edge artefact this exists to remove.
   */
  const convex = height < -COPLANAR_M;
  if (!convex) {
    convexEdges[triangle] = (convexEdges[triangle] ?? 0) & ~(1 << edge);
    convexEdges[otherTriangle] = (convexEdges[otherTriangle] ?? 0) & ~(1 << otherEdge);
  }
}
