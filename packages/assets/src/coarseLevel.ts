/**
 * One coarse mesh standing in for a whole asset, so a load can start with an outline.
 *
 * docs/FORMAT.md §4.6 argues for this and states the two things that make it worth building:
 * a coarse whole model has to *exist as geometry* before it can be drawn, so it is baked
 * rather than derived at load; and **level 0 for the whole asset is worth more than level 0
 * for each of 187 parts**, because a single decimated body reads as a car while 187 coarse
 * fragments read as a mess. So this takes every mesh and returns exactly one.
 *
 * **The surface of an occupancy grid, not a cluster of vertices.** The first version of this
 * clustered vertices onto a grid and connected three clusters wherever a source triangle
 * spanned three cells, which is the classic Rossignac-Borrel decimation and was wrong for
 * this job in a way that only showed on screen: nothing stops the three clusters of a
 * triangle from lying on *different surfaces* of the model, so a car whose seats and engine
 * bay share cells with its shell grew triangles straight through the bodywork. It was
 * reported, correctly, as white cliffs.
 *
 * This marks every cell any surface passes through, then emits the boundary between the
 * occupied cells and the empty ones. That boundary is **closed by construction** and cannot
 * contain a triangle joining two sides of the model, because it is the outside of a solid
 * rather than a decimation of a surface. Interior geometry disappears into cells that are
 * already occupied, which is exactly what should happen to it in an outline.
 *
 * The blocky result is then pulled onto the model: each corner of the boundary sits at the
 * average of the real surface inside the cells around it. So a cube grid becomes a shape
 * that follows the car, at the resolution the caller asked for.
 *
 * Offline work in the baker, so it may allocate freely. Nothing here runs per frame.
 */

import type { MeshData } from '@driftengine/drft';

export interface CoarseLevelOptions {
  /**
   * Cells along the asset's longest axis. Higher is finer and larger.
   *
   * The whole point of the level is that it arrives before the model, so it is measured in
   * kilobytes rather than in fidelity: at 40 a five-metre car resolves to about twelve
   * centimetres, which is a recognisable car for a few hundred kilobytes against seventy
   * megabytes of file.
   */
  readonly cells?: number;
  /**
   * How far the outline is held below the surface, as a fraction of a cell.
   *
   * **This is what lets it stay on screen while the real parts land on top of it**, which is
   * the reveal §4.6 describes: an outline, then its elements. A corner of the boundary sits at
   * the average of the surface around it, so it is already close; this is the margin that
   * keeps it from landing in the same plane as the part covering it and showing through in
   * patches. Being a little inside the model costs nothing, because the model is about to
   * cover it.
   */
  readonly inset?: number;
}

/**
 * The grid this uses when nobody names a resolution, exported because two other places used
 * to carry their own copy of the number and disagreed with it.
 *
 * The baker printed 32 and the browser's converter passed nothing, so one path wrote an
 * outline at 32 cells and the other at 40, and the same model taken through the two arrived
 * differently for no stated reason. A default that callers restate is a default in name only.
 */
export const DEFAULT_COARSE_CELLS = 40;
const DEFAULT_CELLS = DEFAULT_COARSE_CELLS;
const MIN_CELLS = 4;
const MAX_CELLS = 192;
const DEFAULT_INSET = 0.3;

/**
 * How finely a triangle bigger than a cell is sampled when marking cells it passes through.
 *
 * Marking only the three corners is right for the overwhelming majority of a real model,
 * whose triangles are centimetres across against a cell of twelve. It is wrong for the few
 * that are not: a backdrop plane or a wall is two triangles the size of the asset, and a hull
 * built from their corners alone would have a hole the shape of the wall. So a triangle is
 * walked at a spacing below one cell, which costs nothing on the small ones because a spacing
 * below one cell is one step.
 */
const MAX_SAMPLE_STEPS = 96;

/**
 * How much the cells around a node must agree about which way the surface faces before the node
 * is moved at all. See where it is used: it is what keeps a thin feature from sliding off itself.
 */
const DIRECTED = 0.5;

/**
 * How closely a surface must face the direction of travel before its plane is honoured.
 *
 * A surface at more than about seventy degrees to it is one the node moves *along* rather than
 * toward, and the arithmetic divides by that alignment, so at ninety degrees it asks for an
 * infinite push to get behind something it can never get behind by moving this way.
 */
const MIN_ALIGN = 0.35;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * What one cell of the grid knows about the surface inside it, as one flat accumulator.
 *
 * Position, normal, colour, emissive, then how many samples went in: `0..2`, `3..5`, `6..8`,
 * `9`, `10`. One array rather than several because the cells are addressed by a slot and a
 * second array indexed by the same slot is a second thing to keep in step.
 */
const CELL_STRIDE = 11;
const AT_POSITION = 0;
const AT_NORMAL = 3;
const AT_COLOUR = 6;
const AT_EMISSIVE = 9;
const AT_COUNT = 10;

/**
 * Build the coarse level, or `null` when there is nothing to build one from.
 *
 * `null` rather than an empty mesh: an asset with no extent, or one whose geometry all falls
 * inside a single cell, has no outline worth a chunk in the file, and every caller would
 * otherwise have to check the vertex count to find that out.
 *
 * Whether the result is *worth writing* is a separate question with a separate answer:
 * `isOutlineWorthWriting`.
 */
export function buildCoarseLevel(
  meshes: readonly MeshData[],
  options: CoarseLevelOptions = {},
): MeshData | null {
  const cells = clamp(Math.round(options.cells ?? DEFAULT_CELLS), MIN_CELLS, MAX_CELLS);
  const inset = Math.max(0, options.inset ?? DEFAULT_INSET);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const mesh of meshes) {
    for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
      const x = mesh.positions[at] as number;
      const y = mesh.positions[at + 1] as number;
      const z = mesh.positions[at + 2] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return null;

  const cell = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / cells;
  if (!(cell > 0)) return null;

  /* At least one cell on every axis, so a flat asset has a grid rather than none. */
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));

  /**
   * Which cells hold surface, and what that surface is: summed position, normal, colour and
   * emissive, then the sample count, so a cell can report the average of what passed through it.
   */
  const occupied = new Map<number, number>();
  const cellSums: number[] = [];

  const ixOf = (x: number): number => clamp(Math.floor((x - minX) / cell), 0, nx - 1);
  const iyOf = (y: number): number => clamp(Math.floor((y - minY) / cell), 0, ny - 1);
  const izOf = (z: number): number => clamp(Math.floor((z - minZ) / cell), 0, nz - 1);
  const cellId = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;

  /** Mark the cell a point falls in, and fold the surface there into it. */
  const mark = (
    x: number,
    y: number,
    z: number,
    nxs: number,
    nys: number,
    nzs: number,
    r: number,
    g: number,
    b: number,
    emissive: number,
  ): void => {
    const id = cellId(ixOf(x), iyOf(y), izOf(z));
    let slot = occupied.get(id);
    if (slot === undefined) {
      slot = cellSums.length;
      occupied.set(id, slot);
      for (let i = 0; i < CELL_STRIDE; i++) cellSums.push(0);
    }
    cellSums[slot + AT_POSITION] = (cellSums[slot + AT_POSITION] as number) + x;
    cellSums[slot + AT_POSITION + 1] = (cellSums[slot + AT_POSITION + 1] as number) + y;
    cellSums[slot + AT_POSITION + 2] = (cellSums[slot + AT_POSITION + 2] as number) + z;
    cellSums[slot + AT_NORMAL] = (cellSums[slot + AT_NORMAL] as number) + nxs;
    cellSums[slot + AT_NORMAL + 1] = (cellSums[slot + AT_NORMAL + 1] as number) + nys;
    cellSums[slot + AT_NORMAL + 2] = (cellSums[slot + AT_NORMAL + 2] as number) + nzs;
    cellSums[slot + AT_COLOUR] = (cellSums[slot + AT_COLOUR] as number) + r;
    cellSums[slot + AT_COLOUR + 1] = (cellSums[slot + AT_COLOUR + 1] as number) + g;
    cellSums[slot + AT_COLOUR + 2] = (cellSums[slot + AT_COLOUR + 2] as number) + b;
    cellSums[slot + AT_EMISSIVE] = (cellSums[slot + AT_EMISSIVE] as number) + emissive;
    cellSums[slot + AT_COUNT] = (cellSums[slot + AT_COUNT] as number) + 1;
  };

  for (const mesh of meshes) {
    const p = mesh.positions;
    const n = mesh.normals;
    const c = mesh.colors;
    const e = mesh.emissive;
    for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
      const i0 = mesh.indices[at] as number;
      const i1 = mesh.indices[at + 1] as number;
      const i2 = mesh.indices[at + 2] as number;
      const ax = p[i0 * 3] as number,
        ay = p[i0 * 3 + 1] as number,
        az = p[i0 * 3 + 2] as number;
      const bx = p[i1 * 3] as number,
        by = p[i1 * 3 + 1] as number,
        bz = p[i1 * 3 + 2] as number;
      const cx = p[i2 * 3] as number,
        cy = p[i2 * 3 + 1] as number,
        cz = p[i2 * 3 + 2] as number;

      /* One step for anything smaller than a cell, which is nearly everything. */
      const longest = Math.max(
        Math.hypot(bx - ax, by - ay, bz - az),
        Math.hypot(cx - bx, cy - by, cz - bz),
        Math.hypot(ax - cx, ay - cy, az - cz),
      );
      const steps = clamp(Math.ceil(longest / cell), 1, MAX_SAMPLE_STEPS);

      for (let i = 0; i <= steps; i++) {
        for (let j = 0; i + j <= steps; j++) {
          const u = i / steps;
          const v = j / steps;
          const w = 1 - u - v;
          mark(
            ax * w + bx * u + cx * v,
            ay * w + by * u + cy * v,
            az * w + bz * u + cz * v,
            (n[i0 * 3] as number) * w + (n[i1 * 3] as number) * u + (n[i2 * 3] as number) * v,
            (n[i0 * 3 + 1] as number) * w +
              (n[i1 * 3 + 1] as number) * u +
              (n[i2 * 3 + 1] as number) * v,
            (n[i0 * 3 + 2] as number) * w +
              (n[i1 * 3 + 2] as number) * u +
              (n[i2 * 3 + 2] as number) * v,
            (c[i0 * 3] as number) * w + (c[i1 * 3] as number) * u + (c[i2 * 3] as number) * v,
            (c[i0 * 3 + 1] as number) * w +
              (c[i1 * 3 + 1] as number) * u +
              (c[i2 * 3 + 1] as number) * v,
            (c[i0 * 3 + 2] as number) * w +
              (c[i1 * 3 + 2] as number) * u +
              (c[i2 * 3 + 2] as number) * v,
            (e[i0] as number) * w + (e[i1] as number) * u + (e[i2] as number) * v,
          );
        }
      }
    }
  }

  if (occupied.size === 0) return null;

  return buildBoundary({ occupied, cellSums, nx, ny, nz, cell, minX, minY, minZ, inset });
}

/**
 * Whether a built level is worth writing into a file as an outline.
 *
 * **A level of detail that is bigger than the model is not one.** The grid is a fixed number of
 * cells across whatever it is given, so its cost follows the *shape* rather than the detail: four
 * hand-written triangles come back as a 9,840-triangle shell, which is 308 KB of outline arriving
 * ahead of a model measured in bytes. Everything an outline is for, being on screen before the
 * geometry at a fraction of the download, is inverted.
 *
 * Found the day the default flipped from off to on, by a fixture. While an outline was asked for
 * per asset by somebody who had looked, the case could not arise. A default has to hold for the
 * assets nobody looks at, which is what makes it a default.
 *
 * **Separate from `buildCoarseLevel`, which stays a geometry function.** This is a budget, and a
 * caller that wants the hull of a small mesh for some other purpose is entitled to it. It lives
 * here rather than in the two callers because the baker and the browser's converter have to agree
 * about what a file carries, and a rule stated twice is a rule until somebody edits one copy.
 *
 * Half rather than merely smaller: an outline that saves a few per cent is a chunk, an upload and
 * a swap for no visible gain.
 */
export function isOutlineWorthWriting(level: MeshData, meshes: readonly MeshData[]): boolean {
  let sourceTriangles = 0;
  for (const mesh of meshes) sourceTriangles += mesh.indices.length / 3;
  return level.indices.length / 3 <= sourceTriangles / 2;
}

/** Everything the boundary pass needs, gathered so the two halves stay separable. */
interface Grid {
  readonly occupied: Map<number, number>;
  readonly cellSums: readonly number[];
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cell: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly inset: number;
}

/**
 * The surface between the occupied cells and the empty ones, pulled onto the model.
 *
 * Every quad is a face an occupied cell shares with a cell that holds nothing, wound so it
 * faces out of the solid. Its four corners are grid nodes shared with the neighbouring faces,
 * so the result is one welded, closed shell rather than a pile of squares — and because the
 * corners then move to the average of the real surface around them, the shell follows the
 * model instead of stepping around it.
 */
function buildBoundary(grid: Grid): MeshData | null {
  const { occupied, cellSums, nx, ny, nz, cell, minX, minY, minZ, inset } = grid;
  const cellId = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;
  const holds = (ix: number, iy: number, iz: number): boolean =>
    ix >= 0 &&
    iy >= 0 &&
    iz >= 0 &&
    ix < nx &&
    iy < ny &&
    iz < nz &&
    occupied.has(cellId(ix, iy, iz));

  /**
   * Whether a point in space falls in a cell that holds surface.
   *
   * Unclamped, deliberately: clamping a point that is outside the grid into the nearest cell
   * would report the asset as occupying places it does not, which is the opposite of what this
   * is asked for.
   */
  const holdsPoint = (x: number, y: number, z: number): boolean =>
    holds(
      Math.floor((x - minX) / cell),
      Math.floor((y - minY) / cell),
      Math.floor((z - minZ) / cell),
    );

  /** Node ids run over the grid's corners, one more than the cells on every axis. */
  const nodeId = (ix: number, iy: number, iz: number): number =>
    (iz * (ny + 1) + iy) * (nx + 1) + ix;
  const nodes = new Map<number, number>();
  const nodeAt: number[] = [];
  const vertexOf = (ix: number, iy: number, iz: number): number => {
    const id = nodeId(ix, iy, iz);
    let found = nodes.get(id);
    if (found === undefined) {
      found = nodeAt.length / 3;
      nodes.set(id, found);
      nodeAt.push(ix, iy, iz);
    }
    return found;
  };

  /**
   * The six faces, each as the four corner offsets in the order that faces outward.
   *
   * Written out rather than derived, because a face wound the wrong way is invisible in the
   * source and shows up as a hole in the hull from one side only.
   */
  const FACES: readonly (readonly [number, number, number, readonly number[][]])[] = [
    [
      1,
      0,
      0,
      [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    ],
    [
      -1,
      0,
      0,
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
      ],
    ],
    [
      0,
      1,
      0,
      [
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
      ],
    ],
    [
      0,
      -1,
      0,
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    ],
    [
      0,
      0,
      1,
      [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
    ],
    [
      0,
      0,
      -1,
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
    ],
  ];

  /**
   * Which empty cells can be reached from outside the asset, found by flooding inward.
   *
   * **This is what keeps the outline to the outside of the model, and it halves it.** A car body
   * is a shell, so the cells it occupies have empty space on both sides, and a boundary drawn
   * against every empty neighbour produces two shells: the one a viewer sees and a second one
   * lining the cabin. The inner one is invisible, doubles the triangle count, and where the
   * shell is a single cell thick both sheets snap to the same surface and fight over the depth
   * buffer, which reads as dark speckle across the model.
   *
   * A cavity is exactly an empty region the flood cannot reach, so this is the whole test.
   */
  const outside = new Uint8Array(nx * ny * nz);
  const queue: number[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const onRim =
          ix === 0 || iy === 0 || iz === 0 || ix === nx - 1 || iy === ny - 1 || iz === nz - 1;
        if (!onRim) continue;
        const id = cellId(ix, iy, iz);
        if (occupied.has(id) || outside[id] === 1) continue;
        outside[id] = 1;
        queue.push(ix, iy, iz);
      }
    }
  }
  const STEPS: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  /* Breadth first over an explicit list rather than by recursion: a grid of a hundred thousand
     cells would be a hundred thousand frames deep in the worst case. */
  for (let head = 0; head + 2 < queue.length; head += 3) {
    const ix = queue[head] as number;
    const iy = queue[head + 1] as number;
    const iz = queue[head + 2] as number;
    for (const [dx, dy, dz] of STEPS) {
      const jx = ix + dx;
      const jy = iy + dy;
      const jz = iz + dz;
      if (jx < 0 || jy < 0 || jz < 0 || jx >= nx || jy >= ny || jz >= nz) continue;
      const id = cellId(jx, jy, jz);
      if (occupied.has(id) || outside[id] === 1) continue;
      outside[id] = 1;
      queue.push(jx, jy, jz);
    }
  }

  /** Whether this neighbour is open air a viewer could be standing in. */
  const open = (ix: number, iy: number, iz: number): boolean => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return true;
    const id = cellId(ix, iy, iz);
    return !occupied.has(id) && outside[id] === 1;
  };

  const triangles: number[] = [];
  for (const id of occupied.keys()) {
    const ix = id % nx;
    const iy = Math.floor(id / nx) % ny;
    const iz = Math.floor(id / (nx * ny));
    for (const [dx, dy, dz, corners] of FACES) {
      if (!open(ix + dx, iy + dy, iz + dz)) continue;
      const a = vertexOf(
        ix + (corners[0]?.[0] as number),
        iy + (corners[0]?.[1] as number),
        iz + (corners[0]?.[2] as number),
      );
      const b = vertexOf(
        ix + (corners[1]?.[0] as number),
        iy + (corners[1]?.[1] as number),
        iz + (corners[1]?.[2] as number),
      );
      const c = vertexOf(
        ix + (corners[2]?.[0] as number),
        iy + (corners[2]?.[1] as number),
        iz + (corners[2]?.[2] as number),
      );
      const d = vertexOf(
        ix + (corners[3]?.[0] as number),
        iy + (corners[3]?.[1] as number),
        iz + (corners[3]?.[2] as number),
      );
      triangles.push(a, b, c, a, c, d);
    }
  }

  const count = nodeAt.length / 3;
  if (count < 3 || triangles.length === 0) return null;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const emissive = new Float32Array(count);

  for (let at = 0; at < count; at++) {
    const ix = nodeAt[at * 3] as number;
    const iy = nodeAt[at * 3 + 1] as number;
    const iz = nodeAt[at * 3 + 2] as number;
    /*
     * The average of the real surface in the cells touching this node, which is what turns a
     * staircase of cubes into the shape of the thing. Up to eight cells meet at a node and only
     * the occupied ones have anything to say.
     */
    let px = 0,
      py = 0,
      pz = 0;
    let nxs = 0,
      nys = 0,
      nzs = 0;
    let r = 0,
      g = 0,
      b = 0,
      glow = 0;
    let found = 0;
    /** The planes this node has to end up behind: one per occupied cell around it. */
    const planes: number[] = [];
    for (let ox = -1; ox <= 0; ox++) {
      for (let oy = -1; oy <= 0; oy++) {
        for (let oz = -1; oz <= 0; oz++) {
          const cx = ix + ox;
          const cy = iy + oy;
          const cz = iz + oz;
          if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) continue;
          const slot = occupied.get(cellId(cx, cy, cz));
          if (slot === undefined) continue;
          const samples = cellSums[slot + AT_COUNT] as number;
          if (samples <= 0) continue;
          const qx = (cellSums[slot + AT_POSITION] as number) / samples;
          const qy = (cellSums[slot + AT_POSITION + 1] as number) / samples;
          const qz = (cellSums[slot + AT_POSITION + 2] as number) / samples;
          px += qx;
          py += qy;
          pz += qz;
          /*
           * Each cell's facing, as a unit vector, so the node's own facing is an average of
           * directions rather than of magnitudes. A cell whose samples cancel has no facing to
           * offer and is left out of both the average and the planes: it is a fold or a doubled
           * face, and it has no side for anything to be behind.
           */
          let mx = cellSums[slot + AT_NORMAL] as number;
          let my = cellSums[slot + AT_NORMAL + 1] as number;
          let mz = cellSums[slot + AT_NORMAL + 2] as number;
          const facing = Math.hypot(mx, my, mz);
          if (facing > 1e-6) {
            mx /= facing;
            my /= facing;
            mz /= facing;
            nxs += mx;
            nys += my;
            nzs += mz;
            planes.push(qx, qy, qz, mx, my, mz);
          }
          r += (cellSums[slot + AT_COLOUR] as number) / samples;
          g += (cellSums[slot + AT_COLOUR + 1] as number) / samples;
          b += (cellSums[slot + AT_COLOUR + 2] as number) / samples;
          glow += (cellSums[slot + AT_EMISSIVE] as number) / samples;
          found++;
        }
      }
    }

    if (found === 0) {
      /* Cannot happen for a node of a boundary face, and if it ever does, the node's own grid
         position is the honest answer rather than a division by zero. */
      positions[at * 3] = minX + ix * cell;
      positions[at * 3 + 1] = minY + iy * cell;
      positions[at * 3 + 2] = minZ + iz * cell;
      normals[at * 3 + 1] = 1;
      continue;
    }

    px /= found;
    py /= found;
    pz /= found;
    /*
     * How much the cells around this node agree about which way the surface faces, which is the
     * sum of unit facings over their count: one when they all agree, zero when they cancel.
     *
     * **A node that has no agreed facing is left exactly where it is**, and that is what keeps a
     * thin feature intact. A wing mirror or a spoiler thinner than a cell has both of its faces
     * inside the same cells, so there is no side to be behind, and pushing along whichever
     * direction the arithmetic happened to produce would slide the outline off the part it
     * stands for.
     */
    const agreement = Math.hypot(nxs, nys, nzs) / found;
    const length = Math.hypot(nxs, nys, nzs);
    if (length > 1e-6) {
      nxs /= length;
      nys /= length;
      nzs /= length;
    } else {
      nxs = 0;
      nys = 1;
      nzs = 0;
    }

    /*
     * **How far back this node has to sit, measured against the surfaces around it.**
     *
     * The outline stays on screen while the real parts land on top of it, so anywhere it ends up
     * in *front* of the surface it stands for, it shows through the finished model. A constant
     * cannot do this job: a smooth panel needs almost nothing and a concave crease needs most of
     * a cell, because a node there averages two surfaces and lands in the air between them.
     *
     * So each surrounding cell states a plane and the node has to end up behind all of them. For
     * a plane at `q` facing `m`, a node at `c - t·n` is behind it while
     * `dot(c - q, m) <= t·dot(n, m)`, so the cell demands `t >= dot(c - q, m) / dot(n, m)` and
     * the node takes the largest demand made of it. A cell facing nearly across the direction of
     * travel is skipped rather than honoured: dividing by an alignment approaching zero asks for
     * an unbounded push to clear a surface this node is sliding along rather than facing.
     */
    let behind = 0;
    if (agreement >= DIRECTED) {
      for (let plane = 0; plane + 5 < planes.length; plane += 6) {
        const mx = planes[plane + 3] as number;
        const my = planes[plane + 4] as number;
        const mz = planes[plane + 5] as number;
        const align = nxs * mx + nys * my + nzs * mz;
        if (align < MIN_ALIGN) continue;
        const overshoot =
          (px - (planes[plane] as number)) * mx +
          (py - (planes[plane + 1] as number)) * my +
          (pz - (planes[plane + 2] as number)) * mz;
        if (overshoot <= 0) continue;
        const need = overshoot / align;
        if (need > behind) behind = need;
      }
      /* Capped at a cell: a larger demand comes from a fold narrower than the grid, where no
         position clears every surface at once, and honouring it would tear the hull. */
      behind = Math.min(behind, cell);
      /*
       * **And bounded by the cells the asset actually occupies, which is the half that had to be
       * measured to be found.** A demand comes from whichever surfaces happen to sit in the cells
       * around a node, and a cell whose only surface is an interior lining facing downward
       * demands a push *upward* — so the outline ended up standing 0.14 m above the roof of a car
       * 1.49 m tall, which is 0.92 of a cell and was visible as a shape floating over the model.
       *
       * A push that leaves the occupied region is not a push behind anything, so it is halved
       * until it lands inside or given up. The margin below is applied regardless, because at 0.3
       * of a cell it is small enough to be worth the certainty of never coinciding with the
       * surface it hides under.
       */
      for (let tries = 0; tries < 4 && behind > 0; tries++) {
        if (holdsPoint(px - nxs * behind, py - nys * behind, pz - nzs * behind)) break;
        behind = tries === 3 ? 0 : behind / 2;
      }
      /*
       * The **demand** is bounded by occupancy and the margin is not, which is a deliberate split
       * and the only one that serves both shapes this has to handle. A car is a shell inside a
       * volume of parts, where a large push that leaves the occupied cells is going the wrong way.
       * A bare floor meeting a bare wall is a shell and nothing else, where the push that clears
       * both surfaces *has* to leave the two cells holding them — there is no solid to stay in.
       * Bounding the demand fixes the first and bounding the margin as well would break the
       * second, so the margin stays free at 0.3 of a cell.
       */
      behind += inset * cell;
    }

    positions[at * 3] = px - nxs * behind;
    positions[at * 3 + 1] = py - nys * behind;
    positions[at * 3 + 2] = pz - nzs * behind;
    normals[at * 3] = nxs;
    normals[at * 3 + 1] = nys;
    normals[at * 3 + 2] = nzs;
    colors[at * 3] = r / found;
    colors[at * 3 + 1] = g / found;
    colors[at * 3 + 2] = b / found;
    emissive[at] = glow / found;
  }

  /*
   * The four mandatory attributes and nothing else, deliberately.
   *
   * Colour is carried because a grey outline of a painted model is a worse first frame than no
   * outline at all, and emissive because a lamp that glows in the model should glow in its
   * outline. Everything optional is left absent, so the engine's own constants apply and the
   * chunk stays small: a level of detail is a *silhouette*, and spending bytes on the roughness
   * of a surface nobody will look at for half a second is the opposite of the point.
   */
  return { positions, normals, colors, emissive, indices: new Uint32Array(triangles) };
}
