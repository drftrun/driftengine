/**
 * How big a piece of geometry is, and where it sits.
 *
 * **Nothing in this engine knew either until now**, which is why there has never been a frustum
 * test: a renderer cannot decide whether a mesh is on screen without knowing what part of space
 * it occupies. `CAPABILITIES.md` recorded the consequence — no draw culling at all, only backface
 * — and every track on the roadmap that wants culling, level of detail, a broadphase or a
 * bounding gizmo wants this object first.
 *
 * Both a box and a sphere, because the two answer different questions cheaply. A sphere survives
 * an arbitrary transform as a sphere, which makes it the right shape for a per-draw visibility
 * test; a box is tighter and is what a physics broadphase and an editor's selection want.
 */
export interface Bounds {
  /** The axis-aligned box, in the geometry's own space. */
  readonly min: Float32Array;
  readonly max: Float32Array;
  /** The box's midpoint, which is what the radius is measured from. */
  readonly centre: Float32Array;
  /** The furthest vertex from `centre`. See `boundsOfPositions` for why not half the diagonal. */
  radius: number;
}

export function createBounds(): Bounds {
  return {
    min: new Float32Array(3),
    max: new Float32Array(3),
    centre: new Float32Array(3),
    radius: 0,
  };
}

/**
 * Measure a vertex array, into bounds the caller owns.
 *
 * **Two passes, and the second one is the point.** The first finds the box; the second finds the
 * furthest vertex from the box's midpoint. Half the diagonal would be one pass and would be the
 * box's circumradius — right for a box, and loose for anything rounded, which is most geometry.
 * A sphere that reaches the corners of a box the geometry never visits answers every test too
 * generously, and the cost is a second walk of an array that is already in cache.
 *
 * **Measured about the box's centre and never about the origin.** A mesh modelled a kilometre
 * from the origin gets a kilometre-wide sphere the other way, and culls nothing for the rest of
 * its life.
 *
 * Allocates nothing: `out` is the caller's and is returned for convenience.
 */
export function boundsOfPositions(positions: Float32Array, out: Bounds): Bounds {
  /* Whole vertices only. A trailing partial one has no third component and cannot be placed;
     reading it as a zero would drag the box to the origin. */
  const vertices = Math.floor(positions.length / 3);
  if (vertices === 0) {
    out.min.fill(0);
    out.max.fill(0);
    out.centre.fill(0);
    out.radius = 0;
    return out;
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vertices; i += 1) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  out.min[0] = minX;
  out.min[1] = minY;
  out.min[2] = minZ;
  out.max[0] = maxX;
  out.max[1] = maxY;
  out.max[2] = maxZ;

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  out.centre[0] = cx;
  out.centre[1] = cy;
  out.centre[2] = cz;

  let furthest = 0;
  for (let i = 0; i < vertices; i += 1) {
    const dx = (positions[i * 3] ?? 0) - cx;
    const dy = (positions[i * 3 + 1] ?? 0) - cy;
    const dz = (positions[i * 3 + 2] ?? 0) - cz;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared > furthest) furthest = squared;
  }
  out.radius = Math.sqrt(furthest);
  return out;
}

/**
 * Bounds for a box the caller names itself, into bounds the caller owns.
 *
 * **`boundsOfPositions` was the only way to make one of these, and it demands a vertex array.**
 * A consumer that wants to ask the renderer about a region rather than about a mesh — a streamed
 * world testing its squares, a trigger volume, a room — has no vertices to hand it, so making the
 * object meant filling `centre` and `radius` by hand and getting the sphere's invariant right. A
 * consumer measured what that costs: with one mesh per material per square, a two-kilometre ring
 * is 1,618 draws it walks one at a time, where the world itself knows 68 squares it could have
 * tested instead.
 *
 * **Here the radius *is* half the diagonal**, which is the opposite of what `boundsOfPositions`
 * does and is right for the same reason. That function measures the furthest actual vertex,
 * because a mesh's corners are usually empty; a named box has no vertices and its corners are
 * exactly the points it promises to contain, so anything tighter would report a region as off
 * screen while part of it is on.
 *
 * Degenerate is allowed: a flat square gives a real box and a real radius, and a caller that
 * passes a max below a min gets those values back rather than a silent swap — the box it asked
 * for is the box it gets, and an inverted one is a bug at the call site.
 */
export function boundsOfBox(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  out: Bounds,
): Bounds {
  out.min[0] = minX;
  out.min[1] = minY;
  out.min[2] = minZ;
  out.max[0] = maxX;
  out.max[1] = maxY;
  out.max[2] = maxZ;

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  out.centre[0] = cx;
  out.centre[1] = cy;
  out.centre[2] = cz;

  const dx = maxX - cx;
  const dy = maxY - cy;
  const dz = maxZ - cz;
  out.radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return out;
}
