import type { ConvexShape } from './shape.ts';
import { hullShape } from './shape.ts';
import { createMassProperties, shapeMassProperties } from './mass.ts';
import { MAX_BODY_PARTS } from './compoundContact.ts';

/**
 * A triangle mesh, offline, into a handful of convex hulls the runtime can carry on one body.
 *
 * **This is the only function in this package that is not meant to run in a frame**, and that is a
 * statement about what it costs rather than about where it lives. It allocates three grids, walks
 * every cell of them several times, and calls `hullShape` once per part. A bake does that; a tick
 * does not. The convex-decomposition design records the
 * refusal and what would reverse it.
 *
 * **It lives here anyway, beside `hullShape`, because that is what it produces.** The fixtures
 * `scripts/size-gate.test.mjs` measures import named symbols and this package is `sideEffects:
 * false`, so a consumer who never calls this never bundles it — which is measured by `physics-only`
 * staying where it is rather than asserted here.
 *
 * **Why a voxel grid and not the triangles.** A collision mesh is a triangle soup: it is routinely
 * not watertight, routinely self-intersecting, and routinely has a hole where an artist deleted a
 * face nobody would see. Every decomposition that reasons over the source triangles has to decide
 * what the inside of such a thing is, and gets it wrong in a way that depends on the mesh. A grid
 * with a flood fill from the outside answers that question once, the same way, for any input — and
 * its cost is set by the resolution rather than by the triangle count, so a 200,000-triangle
 * collision mesh decomposes in the time a 2,000-triangle one does.
 *
 * **What it gives up** is everything below the cell size: a plate thinner than one cell either
 * disappears or becomes a cell thick. `resolution` is the control, and `Decomposition.resolution`
 * reports what was actually used so a caller who passed nothing can see it.
 */

/** How the interior of the mesh is decided. See `DecomposeOptions.fill`. */
export type DecomposeFill = 'solid' | 'surface';

export interface DecomposeOptions {
  /**
   * Cells along the longest axis of the mesh's bounds. Default 64, refused above 256.
   *
   * **The cap is stated because the alternative is discovering it as an allocation failure.** Two
   * grids are held, a byte of state and four bytes of region index per cell, so 256 is 16.8 million
   * cells and **83.9 MB**. 64 is 262,144 cells and 1.3 MB, which is the design point.
   */
  readonly resolution?: number;
  /** How many hulls to stop at. Default 16, refused above `MAX_BODY_PARTS`. */
  readonly maxHulls?: number;
  /**
   * How empty a merged region's bounding box may be before the merge stops being free. Default 0.05.
   *
   * It does not cap the part count: merging continues past this while more than `maxHulls` regions
   * remain, because a caller asked for a body that a body can be made of. Below that count it is
   * what decides whether two neighbours are worth keeping apart.
   */
  readonly concavity?: number;
  /**
   * `'solid'` fills the interior, `'surface'` keeps the shell alone. Default `'solid'`.
   *
   * **A mesh with a hole in it leaks under `'solid'`, and the fill has no way to know.** The flood
   * escapes through the hole, nothing is left marked inside, and the result is the shell — which is
   * very nearly harmless for collision, because contact only ever touches the boundary, and wrong
   * for mass, because a hollow solid has the wrong inertia. `Decomposition.sourceVolume` is the
   * voxelised volume, so the hollow is visible in the number; `'surface'` is how a caller asks for
   * it deliberately.
   */
  readonly fill?: DecomposeFill;
}

/** One convex piece of the decomposition, ready for `hullShape`. */
export interface ConvexPart {
  /** xyz-packed, at most `SUPPORT_DIRECTIONS` points, in the source mesh's own space. */
  readonly points: Float32Array;
  /** The hull's volume, exactly, by the tetrahedral decomposition `mass.ts` already computes. */
  readonly volume: number;
  /** Cells this part was grown from, as a fraction of its own hull volume. */
  readonly fill: number;
}

export interface Decomposition {
  readonly parts: readonly ConvexPart[];
  /** The voxelised source's volume. What `bloat` is measured against. */
  readonly sourceVolume: number;
  /** The parts' volumes summed, which double-counts wherever two hulls overlap. */
  readonly hullVolume: number;
  /**
   * `(hullVolume - sourceVolume) / sourceVolume`: the empty space the decomposition added.
   *
   * **The number that says whether the decomposition is worth having.** A single hull of a bowl has
   * an enormous one; a decomposition that respects the cavity has a small one. It is not a bound on
   * error in either direction — a hull can only add space, never remove it — which is why
   * `coverage` is reported beside it.
   */
  readonly bloat: number;
  /**
   * The fraction of solid cells whose centre lies inside the part they were grown into.
   *
   * **Below one, and that is the support sampling of `SUPPORT_DIRECTIONS` showing up.** A support
   * set is inscribed in the true hull of a region's corners, so a cell at a corner the direction set
   * does not point at can fall outside by a little. It is the one place this function loses material
   * rather than adding it.
   */
  readonly coverage: number;
  /** The grid that was used, which a caller who passed no resolution wants to know. */
  readonly resolution: number;
  /** Cells in that grid, all three axes multiplied. */
  readonly cells: number;
}

/** The default `maxHulls`, chosen so a decomposed body is well inside `MAX_BODY_PARTS`. */
export const DEFAULT_MAX_HULLS = 16;

/** The default and maximum grids. See `DecomposeOptions.resolution`. */
export const DEFAULT_RESOLUTION = 64;
export const MAX_RESOLUTION = 256;

const OUTSIDE = 0;
const SURFACE = 1;
const INSIDE = 2;

/**
 * The directions a region's extreme corners are kept along, as integer vectors.
 *
 * **Fifty of them, and every one is integers**, so the table is built by arithmetic and nothing here
 * reaches for a transcendental the determinism gate would refuse — `packages/physics/src` is a
 * declared root of it and this file is inside the scan.
 *
 * They are an octahedron's own directions taken three ways: its six vertices, the twelve midpoints
 * of its edges, the eight centres of its faces, and the twenty-four points halfway between a vertex
 * and an edge midpoint. That is a 50-DOP, whose worst angular gap leaves a support hull within about
 * two per cent of the true hull of the same corners — small against a region that is a fraction of
 * the mesh, and measured by `Decomposition.coverage` rather than trusted.
 *
 * **Fifty and not sixty-four** because these four families are what an octahedron gives without
 * inventing a direction; the next family would be twenty-four more and overrun `hullShape`'s cap of
 * sixty-four points. Nothing is gained by padding the set to the cap.
 */
const DIRECTIONS = buildDirections();

/** How many, which is also the most points any part can carry. */
export const SUPPORT_DIRECTIONS = DIRECTIONS.length / 3;

function buildDirections(): Int32Array {
  const families: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
    [2, 1, 0],
  ];
  const seen = new Set<string>();
  const out: number[] = [];
  for (const [a, b, c] of families) {
    /*
     * Every distinct permutation of the family's magnitudes, with every sign on every non-zero
     * component. A zero has one sign and not two, which is what keeps (1,0,0) from arriving twice.
     */
    for (const p of permutations(a, b, c)) {
      for (let s = 0; s < 8; s++) {
        const x = (p[0] as number) * (s & 1 ? -1 : 1);
        const y = (p[1] as number) * (s & 2 ? -1 : 1);
        const z = (p[2] as number) * (s & 4 ? -1 : 1);
        const key = `${x},${y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x, y, z);
      }
    }
  }
  return new Int32Array(out);
}

function permutations(a: number, b: number, c: number): readonly (readonly number[])[] {
  const all = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const p of all) {
    const key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function decomposeConvex(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: DecomposeOptions = {},
): Decomposition {
  const resolution = Math.trunc(options.resolution ?? DEFAULT_RESOLUTION);
  const maxHulls = Math.trunc(options.maxHulls ?? DEFAULT_MAX_HULLS);
  const concavity = options.concavity ?? 0.05;
  const fill = options.fill ?? 'solid';

  if (resolution < 4 || resolution > MAX_RESOLUTION) {
    throw new Error(
      `decomposeConvex: resolution must be between 4 and ${MAX_RESOLUTION}, got ${resolution}`,
    );
  }
  if (maxHulls < 1 || maxHulls > MAX_BODY_PARTS) {
    throw new Error(
      `decomposeConvex: maxHulls must be between 1 and ${MAX_BODY_PARTS}, got ${maxHulls}`,
    );
  }
  if (!(concavity >= 0) || concavity >= 1) {
    throw new Error(`decomposeConvex: concavity must be at least 0 and below 1, got ${concavity}`);
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      `decomposeConvex: ${indices.length} indices is not a whole number of triangles`,
    );
  }
  if (indices.length === 0) throw new Error('decomposeConvex: no triangles');

  const grid = buildGrid(positions, resolution);
  const state = new Uint8Array(grid.nx * grid.ny * grid.nz);
  voxelise(positions, indices, grid, state);
  if (fill === 'solid') fillOutside(grid, state);

  /*
   * `fillOutside` marks what the flood reached; everything it did not reach and did not already own
   * is interior. Under `'surface'` the pass never ran, so nothing is interior and the shell stands
   * alone — which is the whole difference between the two settings.
   */
  const solid = new Uint8Array(state.length);
  let solidCells = 0;
  for (let i = 0; i < state.length; i++) {
    const s = state[i] ?? OUTSIDE;
    if (s === SURFACE || (fill === 'solid' && s === INSIDE)) {
      solid[i] = 1;
      solidCells++;
    }
  }
  if (solidCells === 0) {
    throw new Error(
      'decomposeConvex: the mesh occupied no cells — it is thinner than one cell at this resolution',
    );
  }

  const regions = growRegions(grid, solid, concavity);
  mergeRegions(regions, maxHulls, concavity, grid.cell * grid.cell * grid.cell);
  const parts = buildParts(grid, solid, regions);

  const cellVolume = grid.cell * grid.cell * grid.cell;
  const sourceVolume = solidCells * cellVolume;
  let hullVolume = 0;
  for (const part of parts.parts) hullVolume += part.volume;

  return {
    parts: parts.parts,
    sourceVolume,
    hullVolume,
    bloat: (hullVolume - sourceVolume) / sourceVolume,
    coverage: parts.covered / solidCells,
    resolution,
    cells: state.length,
  };
}

/** The grid a mesh is rasterised into: where its origin is, how wide a cell is, and how many. */
interface Grid {
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * Cubic cells, sized by the longest axis, with one cell of padding on every side.
 *
 * **The padding is what makes the flood fill correct rather than nearly correct.** A mesh whose face
 * sits exactly on the grid's boundary would have no outside cell on that side to flood from, and the
 * fill would leave the whole slab beyond it marked interior — a solid wall where the model has a
 * flat back. One ring of empty cells removes the case entirely.
 */
function buildGrid(positions: ArrayLike<number>, resolution: number): Grid {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!(maxX >= minX)) throw new Error('decomposeConvex: no positions');

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const longest = Math.max(spanX, Math.max(spanY, spanZ));
  if (!(longest > 0)) throw new Error('decomposeConvex: the mesh has no extent');

  const cell = longest / resolution;
  /* Two cells of padding in each axis, one at each end, hence the +2 on every count. */
  const nx = Math.max(1, Math.ceil(spanX / cell)) + 2;
  const ny = Math.max(1, Math.ceil(spanY / cell)) + 2;
  const nz = Math.max(1, Math.ceil(spanZ / cell)) + 2;
  return {
    originX: minX - cell,
    originY: minY - cell,
    originZ: minZ - cell,
    cell,
    nx,
    ny,
    nz,
  };
}

/** Cell index from coordinates. x fastest, then y, then z — the order every walk here uses. */
function at(grid: Grid, x: number, y: number, z: number): number {
  return x + grid.nx * (y + grid.ny * z);
}

/**
 * Every cell a triangle touches, marked `SURFACE`.
 *
 * The overlap test is the standard thirteen-axis separating-axis test between a triangle and an
 * axis-aligned box: the box's three face normals, the triangle's own normal, and the nine cross
 * products of a triangle edge with a box axis. It uses multiplication, addition, `Math.abs`,
 * `Math.min` and `Math.max` and nothing else, which is what keeps it inside the determinism gate.
 *
 * **Conservative on purpose.** A cell that the triangle only grazes is marked, so a surface is never
 * one cell thin where it should be closed — a hole in the shell is what lets the flood fill escape
 * and turn a solid into a hollow one, and it is much cheaper to over-mark than to detect that later.
 */
function voxelise(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  grid: Grid,
  state: Uint8Array,
): void {
  /*
   * **The cell box is grown by one part in a million, and that is the difference between a shell
   * that holds and one with a hole straight through it.**
   *
   * A face lying exactly in a cell boundary plane is not an edge case in this domain — it is what
   * every floor, wall, lid and cap in every model does, and the fans that close a prism are two of
   * them. Such a face is exactly tangent to the boxes on both sides, so the plane test compares two
   * quantities that are equal in exact arithmetic and differ by a rounding step in this one. When it
   * falls the wrong way *neither* neighbour is marked, the flood walks straight through the gap, and
   * the whole interior comes back empty.
   *
   * Measured on a closed twenty-four-sided prism of true volume 3.106: the fill answered 3.57, 0.56,
   * 0.47, 3.37, 3.33, 3.31, 0.20 and 0.17 at resolutions 32 through 96 — correct at four of them and
   * the bare shell at the other four, with nothing in the shape to explain which. The escape path
   * ran down the axis and out through the base, whose disc sits exactly on the boundary between two
   * cell rows.
   *
   * **Growing the box is the right direction to be wrong in.** This marking is conservative by
   * design: a cell marked that need not be costs a little accuracy at the surface, and a cell missed
   * that should be marked is a hole. The epsilon is ten orders of magnitude above the rounding it
   * covers and six below a cell, so it can decide a tangency and can decide nothing else.
   */
  const TANGENCY = 1e-6;
  const half = grid.cell * (0.5 + TANGENCY);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = (indices[t] as number) * 3;
    const i1 = (indices[t + 1] as number) * 3;
    const i2 = (indices[t + 2] as number) * 3;
    const ax = positions[i0] as number;
    const ay = positions[i0 + 1] as number;
    const az = positions[i0 + 2] as number;
    const bx = positions[i1] as number;
    const by = positions[i1 + 1] as number;
    const bz = positions[i1 + 2] as number;
    const cx = positions[i2] as number;
    const cy = positions[i2 + 1] as number;
    const cz = positions[i2 + 2] as number;

    const loX = cellOf(Math.min(ax, Math.min(bx, cx)), grid.originX, grid.cell, grid.nx);
    const hiX = cellOf(Math.max(ax, Math.max(bx, cx)), grid.originX, grid.cell, grid.nx);
    const loY = cellOf(Math.min(ay, Math.min(by, cy)), grid.originY, grid.cell, grid.ny);
    const hiY = cellOf(Math.max(ay, Math.max(by, cy)), grid.originY, grid.cell, grid.ny);
    const loZ = cellOf(Math.min(az, Math.min(bz, cz)), grid.originZ, grid.cell, grid.nz);
    const hiZ = cellOf(Math.max(az, Math.max(bz, cz)), grid.originZ, grid.cell, grid.nz);

    for (let z = loZ; z <= hiZ; z++) {
      const centreZ = grid.originZ + (z + 0.5) * grid.cell;
      for (let y = loY; y <= hiY; y++) {
        const centreY = grid.originY + (y + 0.5) * grid.cell;
        for (let x = loX; x <= hiX; x++) {
          const index = at(grid, x, y, z);
          if (state[index] === SURFACE) continue;
          const centreX = grid.originX + (x + 0.5) * grid.cell;
          if (
            triangleTouchesBox(
              ax - centreX,
              ay - centreY,
              az - centreZ,
              bx - centreX,
              by - centreY,
              bz - centreZ,
              cx - centreX,
              cy - centreY,
              cz - centreZ,
              half,
            )
          ) {
            state[index] = SURFACE;
          }
        }
      }
    }
  }
}

/** Which cell a coordinate falls in, clamped into the grid. */
function cellOf(value: number, origin: number, cell: number, count: number): number {
  const raw = Math.floor((value - origin) / cell);
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * The thirteen-axis test, with the triangle already translated so the box is at the origin.
 *
 * `half` is the box's half-extent, the same on all three axes because the cells are cubes.
 */
function triangleTouchesBox(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  half: number,
): boolean {
  /* The box's own three axes first: they reject the great majority of candidates for one compare. */
  if (Math.min(ax, Math.min(bx, cx)) > half || Math.max(ax, Math.max(bx, cx)) < -half) return false;
  if (Math.min(ay, Math.min(by, cy)) > half || Math.max(ay, Math.max(by, cy)) < -half) return false;
  if (Math.min(az, Math.min(bz, cz)) > half || Math.max(az, Math.max(bz, cz)) < -half) return false;

  const e0x = bx - ax;
  const e0y = by - ay;
  const e0z = bz - az;
  const e1x = cx - bx;
  const e1y = cy - by;
  const e1z = cz - bz;
  const e2x = ax - cx;
  const e2y = ay - cy;
  const e2z = az - cz;

  /* The triangle's own plane against the box. */
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const d = nx * ax + ny * ay + nz * az;
  const reach = half * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
  if (d > reach || d < -reach) return false;

  /* And the nine edge-by-axis crosses. */
  if (!axisTest(e0z, -e0y, ay, az, by, bz, cy, cz, half)) return false;
  if (!axisTest(-e0z, e0x, ax, az, bx, bz, cx, cz, half)) return false;
  if (!axisTest(e0y, -e0x, ax, ay, bx, by, cx, cy, half)) return false;
  if (!axisTest(e1z, -e1y, ay, az, by, bz, cy, cz, half)) return false;
  if (!axisTest(-e1z, e1x, ax, az, bx, bz, cx, cz, half)) return false;
  if (!axisTest(e1y, -e1x, ax, ay, bx, by, cx, cy, half)) return false;
  if (!axisTest(e2z, -e2y, ay, az, by, bz, cy, cz, half)) return false;
  if (!axisTest(-e2z, e2x, ax, az, bx, bz, cx, cz, half)) return false;
  if (!axisTest(e2y, -e2x, ax, ay, bx, by, cx, cy, half)) return false;
  return true;
}

/**
 * One separating-axis test, in the plane the axis lives in.
 *
 * Every one of the nine crosses has a zero component, so each reduces to a two-dimensional dot
 * product against the two triangle corners that are not on the edge — which is why this takes two
 * multipliers and three pairs of coordinates instead of three vectors.
 */
function axisTest(
  u: number,
  v: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  c0: number,
  c1: number,
  half: number,
): boolean {
  const pa = u * a0 + v * a1;
  const pb = u * b0 + v * b1;
  const pc = u * c0 + v * c1;
  const lo = Math.min(pa, Math.min(pb, pc));
  const hi = Math.max(pa, Math.max(pb, pc));
  const reach = half * (Math.abs(u) + Math.abs(v));
  return !(lo > reach || hi < -reach);
}

/**
 * Everything the outside can reach, marked `OUTSIDE`; everything else becomes `INSIDE`.
 *
 * A breadth-first flood from every cell of the grid's boundary. The padding `buildGrid` added
 * guarantees that boundary is empty, so the flood always has somewhere to start.
 */
function fillOutside(grid: Grid, state: Uint8Array): void {
  const visited = new Uint8Array(state.length);
  const queue = new Int32Array(state.length);
  let head = 0;
  let tail = 0;

  const push = (index: number): void => {
    if (visited[index] === 1 || state[index] === SURFACE) return;
    visited[index] = 1;
    queue[tail++] = index;
  };

  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const onBoundary =
          x === 0 ||
          y === 0 ||
          z === 0 ||
          x === grid.nx - 1 ||
          y === grid.ny - 1 ||
          z === grid.nz - 1;
        if (onBoundary) push(at(grid, x, y, z));
      }
    }
  }

  while (head < tail) {
    const index = queue[head++] as number;
    const x = index % grid.nx;
    const y = Math.floor(index / grid.nx) % grid.ny;
    const z = Math.floor(index / (grid.nx * grid.ny));
    if (x > 0) push(index - 1);
    if (x < grid.nx - 1) push(index + 1);
    if (y > 0) push(index - grid.nx);
    if (y < grid.ny - 1) push(index + grid.nx);
    if (z > 0) push(index - grid.nx * grid.ny);
    if (z < grid.nz - 1) push(index + grid.nx * grid.ny);
  }

  for (let i = 0; i < state.length; i++) {
    if (state[i] === SURFACE) continue;
    state[i] = visited[i] === 1 ? OUTSIDE : INSIDE;
  }
}

/** The regions a grid was grown into, and the bookkeeping merging needs. */
interface Regions {
  /** Region id per cell, or -1 where the cell is not solid. */
  readonly of: Int32Array;
  /** Cells in each region. */
  count: Int32Array;
  /** Each region's cell-space bounds, six entries a region. */
  bounds: Int32Array;
  /** Union-find, so a merged region keeps answering to the ids that fed it. */
  parent: Int32Array;
  /** Each live region's neighbours, by id. */
  neighbours: Set<number>[];
  /**
   * Each region's furthest point along every direction of `DIRECTIONS`, and how far.
   *
   * **Exact, and cheap, because a region is always a union of boxes.** A box's extreme point along
   * any direction is one of its eight corners, so a seed's whole support set comes from eight
   * points, and a merged region's is the better of its two parents' — no walk over cells, at any
   * stage. This is what makes a true hull affordable where the merge needs one.
   */
  supports: Float64Array;
  bestDot: Float64Array;
  live: number;
  total: number;
}

/**
 * Every solid cell claimed by a maximal box of solid cells.
 *
 * **Seeds are exact boxes, and that is what makes the result stable.** The first version of this
 * grew a region by breadth-first search while its own bounding box stayed 95% full, which sounds
 * like the same thing and is not: on a curved wall it produced regions that filled their box well
 * enough to be accepted while wrapping far enough around the ring that the hull over them enclosed
 * the cavity. The consequence was a decomposition that was excellent at one resolution and useless
 * at the next — measured on a twenty-four-sided cup, **0.2% bloat at resolution 64 and 118% at 80**,
 * with nothing between them to explain it. A box is convex, entirely, always, so a seed's hull is
 * the seed and no resolution can make it otherwise. Every instability above came out of the seeding
 * rather than out of the merge that follows it.
 *
 * **Cells are visited in index order, x fastest**, and each unclaimed one starts a box that extends
 * a whole layer at a time in a fixed direction order while every cell of that layer is solid and
 * unclaimed. A layer is accepted or it is not; a partial one is never taken, which is the property
 * that keeps the box solid.
 */
function growRegions(grid: Grid, solid: Uint8Array, concavity: number): Regions {
  void concavity;
  const of = new Int32Array(solid.length).fill(-1);
  const count: number[] = [];
  const bounds: number[] = [];

  /** Whether every cell of an inclusive box is solid and unclaimed. */
  const layerFree = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): boolean => {
    if (x0 < 0 || y0 < 0 || z0 < 0) return false;
    if (x1 >= grid.nx || y1 >= grid.ny || z1 >= grid.nz) return false;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const index = at(grid, x, y, z);
          if (solid[index] !== 1 || of[index] !== -1) return false;
        }
      }
    }
    return true;
  };

  for (let seed = 0; seed < solid.length; seed++) {
    if (solid[seed] !== 1 || of[seed] !== -1) continue;

    const region = count.length;
    let minX = seed % grid.nx;
    let minY = Math.floor(seed / grid.nx) % grid.ny;
    let minZ = Math.floor(seed / (grid.nx * grid.ny));
    let maxX = minX;
    let maxY = minY;
    let maxZ = minZ;

    /*
     * Six directions, in a fixed order, repeated until a whole pass adds nothing. Fixed order and
     * whole layers are together what make two machines produce the same boxes from the same grid.
     */
    for (let growing = true; growing;) {
      growing = false;
      if (layerFree(minX - 1, minY, minZ, minX - 1, maxY, maxZ)) {
        minX--;
        growing = true;
      }
      if (layerFree(maxX + 1, minY, minZ, maxX + 1, maxY, maxZ)) {
        maxX++;
        growing = true;
      }
      if (layerFree(minX, minY - 1, minZ, maxX, minY - 1, maxZ)) {
        minY--;
        growing = true;
      }
      if (layerFree(minX, maxY + 1, minZ, maxX, maxY + 1, maxZ)) {
        maxY++;
        growing = true;
      }
      if (layerFree(minX, minY, minZ - 1, maxX, maxY, minZ - 1)) {
        minZ--;
        growing = true;
      }
      if (layerFree(minX, minY, maxZ + 1, maxX, maxY, maxZ + 1)) {
        maxZ++;
        growing = true;
      }
    }

    for (let z = minZ; z <= maxZ; z++) {
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) of[at(grid, x, y, z)] = region;
      }
    }
    count.push((maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1));
    bounds.push(minX, minY, minZ, maxX, maxY, maxZ);
  }

  const total = count.length;
  const directions = SUPPORT_DIRECTIONS;
  const supports = new Float64Array(total * directions * 3);
  const bestDot = new Float64Array(total * directions).fill(-Infinity);
  for (let region = 0; region < total; region++) {
    const b = region * 6;
    for (let corner = 0; corner < 8; corner++) {
      const cx = (bounds[b + (corner & 1 ? 3 : 0)] as number) + (corner & 1 ? 1 : 0);
      const cy = (bounds[b + (corner & 2 ? 4 : 1)] as number) + (corner & 2 ? 1 : 0);
      const cz = (bounds[b + (corner & 4 ? 5 : 2)] as number) + (corner & 4 ? 1 : 0);
      const px = grid.originX + cx * grid.cell;
      const py = grid.originY + cy * grid.cell;
      const pz = grid.originZ + cz * grid.cell;
      offerSupport(supports, bestDot, region, px, py, pz);
    }
  }

  const regions: Regions = {
    of,
    count: Int32Array.from(count),
    bounds: Int32Array.from(bounds),
    parent: new Int32Array(total).map((_, i) => i),
    neighbours: [],
    supports,
    bestDot,
    live: total,
    total,
  };
  for (let i = 0; i < total; i++) regions.neighbours.push(new Set<number>());

  /*
   * Adjacency, from one walk over the grid looking only forward. Looking both ways would find every
   * pair twice and the set would answer the same, so the walk is halved.
   */
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const index = at(grid, x, y, z);
        const a = of[index] as number;
        if (a < 0) continue;
        if (x + 1 < grid.nx) link(regions, a, of[index + 1] as number);
        if (y + 1 < grid.ny) link(regions, a, of[index + grid.nx] as number);
        if (z + 1 < grid.nz) link(regions, a, of[index + grid.nx * grid.ny] as number);
      }
    }
  }
  return regions;
}

/** Keep a point if it reaches further along any direction than what the region already had. */
function offerSupport(
  supports: Float64Array,
  bestDot: Float64Array,
  region: number,
  x: number,
  y: number,
  z: number,
): void {
  const directions = SUPPORT_DIRECTIONS;
  for (let d = 0; d < directions; d++) {
    const dot =
      (DIRECTIONS[d * 3] as number) * x +
      (DIRECTIONS[d * 3 + 1] as number) * y +
      (DIRECTIONS[d * 3 + 2] as number) * z;
    const k = region * directions + d;
    if (dot <= (bestDot[k] as number)) continue;
    bestDot[k] = dot;
    supports[k * 3] = x;
    supports[k * 3 + 1] = y;
    supports[k * 3 + 2] = z;
  }
}

function link(regions: Regions, a: number, b: number): void {
  if (b < 0 || a === b) return;
  (regions.neighbours[a] as Set<number>).add(b);
  (regions.neighbours[b] as Set<number>).add(a);
}

function find(regions: Regions, id: number): number {
  let root = id;
  while ((regions.parent[root] as number) !== root) root = regions.parent[root] as number;
  let walk = id;
  while ((regions.parent[walk] as number) !== walk) {
    const next = regions.parent[walk] as number;
    regions.parent[walk] = root;
    walk = next;
  }
  return root;
}

/**
 * Neighbouring regions merged until the count is one a body can hold, then while it is free.
 *
 * **Two phases, measured two ways, and the split is the whole design.** Reaching the part budget
 * takes as many merges as there are regions, which is thousands: those are ordered by the cheap box
 * measure, which is good at saying *which* merge is least bad and useless at saying whether any
 * merge is worth making. Going below the budget takes at most a handful, and each of those asks the
 * real question — how much of the merged hull would not be solid — because that is the only measure
 * that separates a convex solid, where merging costs nothing, from a cavity, where it costs the
 * cavity.
 *
 * **The tie-break is the determinism.** Two candidates with the same cost are ordered by their lower
 * region id and then their higher one. Without it a heap orders equal costs by insertion, and two
 * runs that inserted in a different order decompose the same mesh differently.
 */
function mergeRegions(
  regions: Regions,
  maxHulls: number,
  concavity: number,
  cellVolume: number,
): void {
  /*
   * **Is the whole thing convex? Asked once, before anything is merged, because the pairwise merge
   * below cannot answer it.** Greedy merging judges one pair at a time, and on a slanted solid every
   * individual step looks bad while the end state is free: two boxes of a staircase have a notch
   * between them, so their hull is a fifth empty and the merge is refused — even where merging *all*
   * of them gives back the solid exactly.
   *
   * Measured on a tetrahedron, which is as convex as a shape can be: **sixteen parts and 20.3%
   * bloat**, where the answer is one part and nothing. A crate, a wedge, a rock and a wheel are all
   * this case, and it is much the most common thing a bake will meet.
   *
   * One hull over every region's supports answers it for the cost of a single `hullShape`.
   */
  if (regions.live > 1 && wholeConcavity(regions, cellVolume) <= concavity) {
    for (let i = 1; i < regions.total; i++) {
      const a = find(regions, 0);
      const b = find(regions, i);
      if (a !== b) merge(regions, a, b);
    }
    return;
  }

  const heap = new CandidateHeap();
  for (let a = 0; a < regions.total; a++) {
    for (const b of regions.neighbours[a] as Set<number>) {
      if (b > a) heap.push(cost(regions, a, b), a, b);
    }
  }

  while (regions.live > maxHulls) {
    const top = heap.pop();
    if (top === null) break;
    const a = find(regions, top.a);
    const b = find(regions, top.b);
    if (a === b) continue;
    /* A stale entry: one of the two has merged since, so its cost is no longer the pair's. */
    const current = cost(regions, a, b);
    if (current !== top.cost) {
      heap.push(current, a, b);
      continue;
    }
    merge(regions, a, b);
    const root = find(regions, a);
    for (const other of regions.neighbours[root] as Set<number>) {
      heap.push(cost(regions, root, other), Math.min(root, other), Math.max(root, other));
    }
  }

  /*
   * The tail. At most `maxHulls` regions remain, so every adjacent pair can be measured properly and
   * the answers cached; a merge invalidates only the pairs its region is part of.
   */
  const measured = new Map<number, number>();
  const keyOf = (a: number, b: number): number =>
    Math.min(a, b) * (regions.total + 1) + Math.max(a, b);

  for (;;) {
    let bestCost = Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < regions.total; i++) {
      const a = find(regions, i);
      if (a !== i) continue;
      for (const raw of regions.neighbours[a] as Set<number>) {
        const b = find(regions, raw);
        if (b === a) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = keyOf(lo, hi);
        let value = measured.get(key);
        if (value === undefined) {
          value = hullConcavity(regions, lo, hi, cellVolume);
          measured.set(key, value);
        }
        /* Ties resolve by the pair's ids, for the reason the heap has a tie-break. */
        if (
          value < bestCost ||
          (value === bestCost && (lo < bestA || (lo === bestA && hi < bestB)))
        ) {
          bestCost = value;
          bestA = lo;
          bestB = hi;
        }
      }
    }
    if (bestA < 0 || bestCost > concavity) break;
    merge(regions, bestA, bestB);
    if (regions.live <= 1) break;
    const root = find(regions, bestA);
    for (const key of [...measured.keys()]) {
      const lo = Math.floor(key / (regions.total + 1));
      const hi = key % (regions.total + 1);
      if (find(regions, lo) === root || find(regions, hi) === root) measured.delete(key);
    }
  }
}

/**
 * The fraction of the hull over two regions that would not be solid.
 *
 * **The real measure, and the reason the support sets exist.** A region is a union of boxes, so its
 * extreme point along any direction is a corner of one of them, and the hull over those points is
 * the hull over the region. Comparing that hull's volume against the cells actually held says
 * exactly what merging would cost: nothing for two halves of a cylinder, and the whole cavity for
 * two walls facing each other across one.
 *
 * Measured at 1.09 ms for a fifty-point hull, which is why `mergeRegions` asks it about a hundred
 * and fifty times and not a hundred and fifty thousand.
 */
function hullConcavity(regions: Regions, a: number, b: number, cellVolume: number): number {
  const directions = SUPPORT_DIRECTIONS;
  const points = new Float32Array(directions * 3);
  for (let d = 0; d < directions; d++) {
    const ka = a * directions + d;
    const kb = b * directions + d;
    const from = (regions.bestDot[kb] as number) > (regions.bestDot[ka] as number) ? kb : ka;
    points[d * 3] = regions.supports[from * 3] as number;
    points[d * 3 + 1] = regions.supports[from * 3 + 1] as number;
    points[d * 3 + 2] = regions.supports[from * 3 + 2] as number;
  }
  const volume = shapeMassProperties(hullShape(points), 1, CONCAVITY_MASS).volume;
  if (!(volume > 0)) return 1;
  const solid = ((regions.count[a] as number) + (regions.count[b] as number)) * cellVolume;
  return Math.max(0, (volume - solid) / volume);
}

/** The same question asked of every live region at once: is this solid already convex? */
function wholeConcavity(regions: Regions, cellVolume: number): number {
  const directions = SUPPORT_DIRECTIONS;
  const points = new Float32Array(directions * 3);
  const best = new Float64Array(directions).fill(-Infinity);
  let cells = 0;
  for (let i = 0; i < regions.total; i++) {
    if (find(regions, i) !== i) continue;
    cells += regions.count[i] as number;
    for (let d = 0; d < directions; d++) {
      const k = i * directions + d;
      if ((regions.bestDot[k] as number) <= (best[d] as number)) continue;
      best[d] = regions.bestDot[k] as number;
      points[d * 3] = regions.supports[k * 3] as number;
      points[d * 3 + 1] = regions.supports[k * 3 + 1] as number;
      points[d * 3 + 2] = regions.supports[k * 3 + 2] as number;
    }
  }
  const volume = shapeMassProperties(hullShape(points), 1, CONCAVITY_MASS).volume;
  if (!(volume > 0)) return 1;
  return Math.max(0, (volume - cells * cellVolume) / volume);
}

/** Reused by `hullConcavity`, which the tail calls once per candidate pair. */
const CONCAVITY_MASS = createMassProperties();

/**
 * How empty the box around two regions would be if they became one.
 *
 * **The cheap half of a two-part rule, and it only ever orders merges the budget forces.** Six
 * integer compares and a divide, against a hull whose volume costs a millisecond, so this is what
 * can be asked thousands of times while a mesh's regions come down to the part budget.
 *
 * **What it cannot answer is whether a merge is *free*, and three attempts to make it were wrong in
 * three different ways.** A fixed threshold on this number can never join the last two halves of a
 * cylinder, whose box is 21.5% empty however it is cut — a convex prism came back as eight parts.
 * Scoring the change against the emptier parent fixes that and then runs away: each merge licenses
 * the next against a laxer number, and a cup's wall merged around its own ring until the vessel was
 * one hull holding 57% more than the cup. Anchoring the allowance so it cannot rise stops the
 * runaway and brings back the eight-part prism. **A box cannot tell a convex solid from a cavity**,
 * and that is not a rule to be tuned into existence. `hullConcavity` is what answers it, and
 * `mergeRegions` calls it only where the count is small enough to afford one.
 */
function cost(regions: Regions, a: number, b: number): number {
  const ab = a * 6;
  const bb = b * 6;
  const minX = Math.min(regions.bounds[ab] as number, regions.bounds[bb] as number);
  const minY = Math.min(regions.bounds[ab + 1] as number, regions.bounds[bb + 1] as number);
  const minZ = Math.min(regions.bounds[ab + 2] as number, regions.bounds[bb + 2] as number);
  const maxX = Math.max(regions.bounds[ab + 3] as number, regions.bounds[bb + 3] as number);
  const maxY = Math.max(regions.bounds[ab + 4] as number, regions.bounds[bb + 4] as number);
  const maxZ = Math.max(regions.bounds[ab + 5] as number, regions.bounds[bb + 5] as number);
  const union = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  const taken = (regions.count[a] as number) + (regions.count[b] as number);
  return (union - taken) / union;
}

function merge(regions: Regions, a: number, b: number): void {
  /* The lower id survives, so a decomposition's part order follows the grid walk that made it. */
  const keep = Math.min(a, b);
  const gone = Math.max(a, b);
  regions.parent[gone] = keep;
  regions.count[keep] = (regions.count[keep] as number) + (regions.count[gone] as number);

  const kb = keep * 6;
  const gb = gone * 6;
  for (let i = 0; i < 3; i++) {
    regions.bounds[kb + i] = Math.min(
      regions.bounds[kb + i] as number,
      regions.bounds[gb + i] as number,
    );
    regions.bounds[kb + 3 + i] = Math.max(
      regions.bounds[kb + 3 + i] as number,
      regions.bounds[gb + 3 + i] as number,
    );
  }

  const directions = SUPPORT_DIRECTIONS;
  for (let d = 0; d < directions; d++) {
    const kk = keep * directions + d;
    const kg = gone * directions + d;
    if ((regions.bestDot[kg] as number) <= (regions.bestDot[kk] as number)) continue;
    regions.bestDot[kk] = regions.bestDot[kg] as number;
    regions.supports[kk * 3] = regions.supports[kg * 3] as number;
    regions.supports[kk * 3 + 1] = regions.supports[kg * 3 + 1] as number;
    regions.supports[kk * 3 + 2] = regions.supports[kg * 3 + 2] as number;
  }

  const into = regions.neighbours[keep] as Set<number>;
  for (const other of regions.neighbours[gone] as Set<number>) {
    const root = find(regions, other);
    if (root !== keep) into.add(root);
  }
  into.delete(gone);
  into.delete(keep);
  regions.neighbours[gone] = new Set<number>();
  regions.live--;
}

/** A candidate merge, in a binary heap ordered by cost then by the pair's two ids. */
class CandidateHeap {
  private costs: number[] = [];
  private as: number[] = [];
  private bs: number[] = [];

  push(cost: number, a: number, b: number): void {
    this.costs.push(cost);
    this.as.push(a);
    this.bs.push(b);
    let i = this.costs.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { cost: number; a: number; b: number } | null {
    if (this.costs.length === 0) return null;
    const top = { cost: this.costs[0] as number, a: this.as[0] as number, b: this.bs[0] as number };
    const last = this.costs.length - 1;
    this.swap(0, last);
    this.costs.pop();
    this.as.pop();
    this.bs.pop();
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.costs.length && this.less(left, best)) best = left;
      if (right < this.costs.length && this.less(right, best)) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return top;
  }

  private less(i: number, j: number): boolean {
    const ci = this.costs[i] as number;
    const cj = this.costs[j] as number;
    if (ci !== cj) return ci < cj;
    const ai = this.as[i] as number;
    const aj = this.as[j] as number;
    if (ai !== aj) return ai < aj;
    return (this.bs[i] as number) < (this.bs[j] as number);
  }

  private swap(i: number, j: number): void {
    const c = this.costs[i] as number;
    this.costs[i] = this.costs[j] as number;
    this.costs[j] = c;
    const a = this.as[i] as number;
    this.as[i] = this.as[j] as number;
    this.as[j] = a;
    const b = this.bs[i] as number;
    this.bs[i] = this.bs[j] as number;
    this.bs[j] = b;
  }
}

/**
 * Each live region's extreme corners along `DIRECTIONS`, and the hull over them.
 *
 * One walk over the grid. A solid cell offers its eight corners to its region's support set, which
 * keeps whichever reach furthest along each direction; the set is then deduplicated by `hullShape`
 * itself, so a boxy region arrives as its eight corners and a rounded one as up to fifty.
 *
 * **Coverage is measured here rather than assumed**, by asking whether each cell's centre lies
 * inside the hull its own region produced. A support set is inscribed in the true hull of the
 * corners it was drawn from, so a cell at a corner no direction points at can fall outside — and
 * that is the one way this function loses material instead of adding it.
 */
function buildParts(
  grid: Grid,
  solid: Uint8Array,
  regions: Regions,
): { parts: ConvexPart[]; covered: number } {
  const directions = SUPPORT_DIRECTIONS;
  const order: number[] = [];
  const slotOf = new Map<number, number>();
  for (let i = 0; i < regions.total; i++) {
    const root = find(regions, i);
    if (slotOf.has(root)) continue;
    slotOf.set(root, order.length);
    order.push(root);
  }

  const best = new Float64Array(order.length * directions).fill(-Infinity);
  const point = new Float64Array(order.length * directions * 3);

  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const index = at(grid, x, y, z);
        if (solid[index] !== 1) continue;
        const slot = slotOf.get(find(regions, regions.of[index] as number)) as number;
        for (let corner = 0; corner < 8; corner++) {
          const cxCell = x + (corner & 1);
          const cyCell = y + (corner & 2 ? 1 : 0);
          const czCell = z + (corner & 4 ? 1 : 0);
          const px = grid.originX + cxCell * grid.cell;
          const py = grid.originY + cyCell * grid.cell;
          const pz = grid.originZ + czCell * grid.cell;
          for (let d = 0; d < directions; d++) {
            const dot =
              (DIRECTIONS[d * 3] as number) * px +
              (DIRECTIONS[d * 3 + 1] as number) * py +
              (DIRECTIONS[d * 3 + 2] as number) * pz;
            const k = slot * directions + d;
            if (dot <= (best[k] as number)) continue;
            best[k] = dot;
            point[k * 3] = px;
            point[k * 3 + 1] = py;
            point[k * 3 + 2] = pz;
          }
        }
      }
    }
  }

  const cellVolume = grid.cell * grid.cell * grid.cell;
  /* A plane test wants a tolerance in the units the planes are in, which is the grid's own. */
  const slack = grid.cell * 1e-3;
  const mass = createMassProperties();
  const parts: ConvexPart[] = [];
  const shapes: ConvexShape[] = [];
  for (let slot = 0; slot < order.length; slot++) {
    const points = new Float32Array(directions * 3);
    for (let d = 0; d < directions; d++) {
      const k = (slot * directions + d) * 3;
      points[d * 3] = point[k] as number;
      points[d * 3 + 1] = point[k + 1] as number;
      points[d * 3 + 2] = point[k + 2] as number;
    }
    const shape = hullShape(points);
    shapes.push(shape);
    const volume = shapeMassProperties(shape, 1, mass).volume;
    const cells = regions.count[order[slot] as number] as number;
    parts.push({ points: shape.vertices, volume, fill: (cells * cellVolume) / volume });
  }

  let covered = 0;
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const index = at(grid, x, y, z);
        if (solid[index] !== 1) continue;
        const slot = slotOf.get(find(regions, regions.of[index] as number)) as number;
        const px = grid.originX + (x + 0.5) * grid.cell;
        const py = grid.originY + (y + 0.5) * grid.cell;
        const pz = grid.originZ + (z + 0.5) * grid.cell;
        if (insideHull(shapes[slot] as ConvexShape, px, py, pz, slack)) covered++;
      }
    }
  }

  return { parts, covered };
}

/** Whether a point is on the inner side of every one of a hull's face planes. */
function insideHull(shape: ConvexShape, x: number, y: number, z: number, slack: number): boolean {
  const planes = shape.facePlanes;
  for (let i = 0; i + 3 < planes.length; i += 4) {
    const d =
      (planes[i] as number) * x +
      (planes[i + 1] as number) * y +
      (planes[i + 2] as number) * z -
      (planes[i + 3] as number);
    if (d > slack) return false;
  }
  return true;
}
