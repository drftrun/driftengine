/**
 * How many surfaces stand between each point of a distance grid and the open air around it: the
 * sign of a field that parity cannot give.
 *
 * **Parity is exact for a closed solid and wrong for a sheet**, and a bought scene is sheets:
 * single-sided walls, rooms open to the sky, a floor with nothing under it. A ray along one axis
 * that passes a sheet flips every point after it, which on a baked courtyard striped the open air
 * by altitude, +2.6 at 4 m and -2.7 from 5 m to 9 m, and light traced through the striped half
 * found black. A closed ball behind that sheet came back empty for the same reason.
 *
 * **So the grid is walked instead.** Everything reachable from the grid's own faces without
 * crossing the surface is depth 0, outside. A region bordering depth 0 across the surface is
 * depth 1, the inside of whatever it borders; a region bordering only depth 1 is sealed air inside
 * that solid, depth 2; and so on. An odd depth is inside. No axis is preferred and no sheet
 * reaches past the region it bounds.
 *
 * **A step between neighbours crosses no surface when their distances add to more than the step**:
 * a surface crossing the segment would be nearer each end than the crossing is, and the two parts
 * of the segment sum to the step. So the walk is exact where it moves and conservative where it
 * stops. What that gives up is a gap narrower than about a voxel, which reads as sealed, and a point
 * within a step of the surface along an inside corner, where every step is blocked and the point
 * becomes a region of its own. `bakeObjectSdf` signs that shell by parity instead, which is exact
 * there for a closed solid and wrong only by the voxel's own small distance next to a sheet.
 */

/**
 * The walk's margin over the step. A surface through a grid point is the equality case of the
 * rule, a point at zero beside one a step away, and float rounding decides it either way; a cube's
 * faces land on grid points whenever its size is a whole number of voxels. A hundredth of a step
 * settles it on the sealed side, and seals a gap only that much sooner.
 */
const WALK_MARGIN = 1.01;

/**
 * Each point's depth, from an unsigned `field` on a grid of `dims` points `step` apart, `x`
 * fastest. Depth 0 is the air reachable from the grid's faces; odd depths are inside.
 */
export function surfaceDepth(
  field: Float32Array,
  dims: readonly [number, number, number],
  step: number,
): Int32Array {
  const [nx, ny, nz] = dims;
  const count = field.length;
  const depth = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  /** Blocked neighbours of this depth's walk, which seed the next, each listed once. */
  let seeds = new Int32Array(count);
  let spare = new Int32Array(count);
  const listed = new Uint8Array(count);
  let seedCount = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
        seeds[seedCount++] = i + nx * (j + ny * k);
      }
    }
  }
  const plane = nx * ny;
  const limit = step * WALK_MARGIN;
  for (let current = 0; seedCount > 0; current++) {
    let head = 0;
    let tail = 0;
    for (let s = 0; s < seedCount; s++) {
      const seed = seeds[s] as number;
      listed[seed] = 0;
      if (depth[seed] !== -1) continue;
      depth[seed] = current;
      queue[tail++] = seed;
    }
    let nextCount = 0;
    while (head < tail) {
      const index = queue[head++] as number;
      const here = Math.abs(field[index] as number);
      const i = index % nx;
      const j = Math.floor(index / nx) % ny;
      const k = Math.floor(index / plane);
      for (let n = 0; n < 6; n++) {
        const axis = n >> 1;
        const delta = (n & 1) === 0 ? -1 : 1;
        const at = axis === 0 ? i : axis === 1 ? j : k;
        const size = axis === 0 ? nx : axis === 1 ? ny : nz;
        if (at + delta < 0 || at + delta >= size) continue;
        const neighbour = index + delta * (axis === 0 ? 1 : axis === 1 ? nx : plane);
        if (depth[neighbour] !== -1) continue;
        if (here + Math.abs(field[neighbour] as number) > limit) {
          depth[neighbour] = current;
          queue[tail++] = neighbour;
        } else if (listed[neighbour] === 0) {
          listed[neighbour] = 1;
          spare[nextCount++] = neighbour;
        }
      }
    }
    const used = seeds;
    seeds = spare;
    spare = used;
    seedCount = nextCount;
  }
  return depth;
}
