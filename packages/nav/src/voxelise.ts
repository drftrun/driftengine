/**
 * Geometry to a field of where an agent of a given size could stand.
 *
 * **Why the refusal reopens, and it is the module's own words.** `core/src/nav/navGraph.ts` says in
 * its header that it is a graph rather than a mesh, that this is a decision rather than a first
 * step, and that *"if a world's walkable space genuinely is a region, this is the wrong structure
 * and a mesh is the row that is still open."* A streamed open world is that world. The module named
 * its own trigger; this pulls it. The graph is not replaced — it stays right for roads, corridors
 * and docking lanes, which is what consumers kept arriving with.
 *
 * **A voxel field and not a heightfield, and an overhang is the whole reason.** A bridge over a
 * path is two walkable surfaces at one horizontal position. A heightfield holds one of them, so an
 * agent under the bridge is either standing on the bridge or standing in the void — and which of
 * those it is depends on which triangle happened to be rasterised last.
 *
 * **The agent's size is applied here rather than at query time.** Eroding at query time means every
 * query pays for it and every query can get it wrong. Eroding here means the mesh *is* the space
 * that agent can occupy, which is what a navigation mesh is for.
 */

export interface NavGeometry {
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** Three per triangle. */
  readonly indices: Uint32Array;
}

export interface VoxeliseSettings {
  /** Horizontal voxel size, world units. */
  readonly cellSize: number;
  /** Vertical voxel size, world units. */
  readonly cellHeight: number;
  /** The steepest surface an agent can stand on, in degrees. */
  readonly maxSlope: number;
  /** How much headroom an agent needs above the floor. */
  readonly agentHeight: number;
  /** How far from an edge an agent's centre must stay. */
  readonly agentRadius: number;
}

/** Words per span: floor cell, ceiling cell, walkable. */
const SPAN_STRIDE = 3;

/**
 * Walkable surfaces as spans, in columns on a horizontal grid.
 *
 * Structure of arrays and CSR columns, matching `NavGraph` in core: a span is three integers and a
 * column is a slice, so building a region out of this walks memory in order and allocates nothing
 * per span.
 */
export interface VoxelField {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly cellHeight: number;
  /** World position of cell (0, 0)'s minimum corner: x, y, z. */
  readonly origin: Float64Array;
  /** Column `x + z * width`'s spans are `[columnStart[i], columnStart[i + 1])`. */
  readonly columnStart: Uint32Array;
  /** Three words per span. See `SPAN_STRIDE`. */
  readonly spans: Int32Array;
}

const EMPTY: VoxelField = {
  width: 0,
  depth: 0,
  cellSize: 0,
  cellHeight: 0,
  origin: new Float64Array(3),
  columnStart: new Uint32Array(1),
  spans: new Int32Array(0),
};

/** The column index for a world position, or `-1` outside the field. */
export function columnAt(field: VoxelField, x: number, z: number): number {
  if (field.width === 0) return -1;
  const cx = Math.floor((x - (field.origin[0] as number)) / field.cellSize);
  const cz = Math.floor((z - (field.origin[2] as number)) / field.cellSize);
  if (cx < 0 || cz < 0 || cx >= field.width || cz >= field.depth) return -1;
  return cx + cz * field.width;
}

export function spanCount(field: VoxelField, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= field.width || z >= field.depth) return 0;
  const column = x + z * field.width;
  return (
    ((field.columnStart[column + 1] as number) - (field.columnStart[column] as number)) /
    SPAN_STRIDE
  );
}

/** The world height of a span's floor, by column index and span number. */
export function spanFloor(field: VoxelField, column: number, at: number): number {
  const base = (field.columnStart[column] as number) + at * SPAN_STRIDE;
  return (field.origin[1] as number) + (field.spans[base] as number) * field.cellHeight;
}

export function spanWalkable(field: VoxelField, x: number, z: number, at: number): boolean {
  if (x < 0 || z < 0 || x >= field.width || z >= field.depth) return false;
  const column = x + z * field.width;
  const base = (field.columnStart[column] as number) + at * SPAN_STRIDE;
  if (base + 2 >= (field.columnStart[column + 1] as number) + SPAN_STRIDE) return false;
  return field.spans[base + 2] === 1;
}

/** One rasterised sample before the columns are packed. */
interface Sample {
  floor: number;
  walkable: boolean;
}

/**
 * Rasterise, then decide.
 *
 * **Three passes and not one**, because each answers a question the previous one could not: what is
 * solid, what has headroom, and what an agent's width reaches. Slope is decided per triangle at
 * rasterisation because that is the only place the triangle's normal is known; headroom needs the
 * whole column; and erosion needs the neighbours' answers, so it cannot run until they exist.
 */
export function voxeliseWalkable(geometry: NavGeometry, settings: VoxeliseSettings): VoxelField {
  const triangles = geometry.indices.length / 3;
  if (triangles === 0 || settings.cellSize <= 0 || settings.cellHeight <= 0) return EMPTY;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let at = 0; at < geometry.positions.length; at += 3) {
    minX = Math.min(minX, geometry.positions[at] as number);
    minY = Math.min(minY, geometry.positions[at + 1] as number);
    minZ = Math.min(minZ, geometry.positions[at + 2] as number);
    maxX = Math.max(maxX, geometry.positions[at] as number);
    maxZ = Math.max(maxZ, geometry.positions[at + 2] as number);
  }

  const width = Math.max(1, Math.ceil((maxX - minX) / settings.cellSize) + 1);
  const depth = Math.max(1, Math.ceil((maxZ - minZ) / settings.cellSize) + 1);
  const origin = new Float64Array([minX, minY, minZ]);
  const columns: Sample[][] = Array.from({ length: width * depth }, () => []);

  // determinism: build-time — the slope limit is read once per bake
  const cosLimit = Math.cos((settings.maxSlope * Math.PI) / 180);

  for (let tri = 0; tri < triangles; tri += 1) {
    const ia = (geometry.indices[tri * 3] as number) * 3;
    const ib = (geometry.indices[tri * 3 + 1] as number) * 3;
    const ic = (geometry.indices[tri * 3 + 2] as number) * 3;

    const ax = geometry.positions[ia] as number;
    const ay = geometry.positions[ia + 1] as number;
    const az = geometry.positions[ia + 2] as number;
    const bx = geometry.positions[ib] as number;
    const by = geometry.positions[ib + 1] as number;
    const bz = geometry.positions[ib + 2] as number;
    const cx = geometry.positions[ic] as number;
    const cy = geometry.positions[ic + 1] as number;
    const cz = geometry.positions[ic + 2] as number;

    /* The normal's y against its length is the cosine of the slope, which is the whole slope test. */
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length === 0) continue;
    const walkable = Math.abs(ny) / length >= cosLimit;

    const loX = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / settings.cellSize));
    const hiX = Math.min(width - 1, Math.floor((Math.max(ax, bx, cx) - minX) / settings.cellSize));
    const loZ = Math.max(0, Math.floor((Math.min(az, bz, cz) - minZ) / settings.cellSize));
    const hiZ = Math.min(depth - 1, Math.floor((Math.max(az, bz, cz) - minZ) / settings.cellSize));

    for (let gz = loZ; gz <= hiZ; gz += 1) {
      for (let gx = loX; gx <= hiX; gx += 1) {
        const px = minX + (gx + 0.5) * settings.cellSize;
        const pz = minZ + (gz + 0.5) * settings.cellSize;
        const height = heightAt(ax, ay, az, bx, by, bz, cx, cy, cz, px, pz);
        if (height === null) continue;
        const floor = Math.floor((height - minY) / settings.cellHeight);
        columns[gx + gz * width]?.push({ floor, walkable });
      }
    }
  }

  return pack(columns, width, depth, origin, settings);
}

/**
 * The triangle's height at (px, pz), or null where the point is outside it.
 *
 * Barycentric on the xz projection. A degenerate triangle — one edge-on to the grid — has zero
 * area there and is skipped: it covers no column, so there is nothing for it to contribute.
 */
function heightAt(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  pz: number,
): number | null {
  const area = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(area) < 1e-12) return null;
  const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / area;
  const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / area;
  const w = 1 - u - v;
  const slack = -1e-6;
  if (u < slack || v < slack || w < slack) return null;
  return u * ay + v * by + w * cy;
}

/**
 * Merge samples into spans, apply headroom, then erode by the agent's radius.
 *
 * **Headroom before erosion**, because a floor with no headroom is not walkable at all and eroding
 * around it would carve a margin into ground that was already unwalkable — which shows up as a
 * navigation mesh with a hole larger than the obstacle that made it.
 */
function pack(
  columns: Sample[][],
  width: number,
  depth: number,
  origin: Float64Array,
  settings: VoxeliseSettings,
): VoxelField {
  const headroom = Math.ceil(settings.agentHeight / settings.cellHeight);
  const merged: number[][] = [];

  for (const samples of columns) {
    samples.sort((a, b) => a.floor - b.floor || Number(a.walkable) - Number(b.walkable));
    const spans: number[] = [];
    for (const sample of samples) {
      const last = spans.length - SPAN_STRIDE;
      /* Samples within one cell of each other are one surface, not two. */
      if (last >= 0 && sample.floor - (spans[last] as number) <= 1) {
        spans[last + 2] = (spans[last + 2] as number) | (sample.walkable ? 1 : 0);
        continue;
      }
      spans.push(sample.floor, Number.MAX_SAFE_INTEGER, sample.walkable ? 1 : 0);
    }
    /* A span's ceiling is the next span's floor. The topmost has open sky. */
    for (let at = 0; at + SPAN_STRIDE < spans.length; at += SPAN_STRIDE) {
      spans[at + 1] = spans[at + SPAN_STRIDE] as number;
      if ((spans[at + 1] as number) - (spans[at] as number) < headroom) spans[at + 2] = 0;
    }
    merged.push(spans);
  }

  erode(merged, width, depth, settings);

  const columnStart = new Uint32Array(width * depth + 1);
  let total = 0;
  for (let at = 0; at < merged.length; at += 1) {
    columnStart[at] = total;
    total += (merged[at] as number[]).length;
  }
  columnStart[width * depth] = total;

  const spans = new Int32Array(total);
  let write = 0;
  for (const column of merged) {
    for (const value of column) {
      spans[write] = value;
      write += 1;
    }
  }

  return {
    width,
    depth,
    cellSize: settings.cellSize,
    cellHeight: settings.cellHeight,
    origin,
    columnStart,
    spans,
  };
}

/**
 * Clear walkability within the agent's radius of anything that is not walkable.
 *
 * A distance transform would be exact and is not needed: the radius is a handful of cells, and
 * doing it as that many single-cell passes keeps the whole thing integer arithmetic with no
 * distance to round. **Copied per pass**, because eroding in place erodes into what the same pass
 * just cleared and eats the mesh from its edges inward.
 */
function erode(
  columns: number[][],
  width: number,
  depth: number,
  settings: VoxeliseSettings,
): void {
  const steps = Math.ceil(settings.agentRadius / settings.cellSize);
  for (let pass = 0; pass < steps; pass += 1) {
    const before = columns.map((column) => [...column]);
    const open = (gx: number, gz: number): boolean => {
      if (gx < 0 || gz < 0 || gx >= width || gz >= depth) return false;
      const column = before[gx + gz * width] as number[];
      for (let at = 0; at < column.length; at += SPAN_STRIDE) {
        if (column[at + 2] === 1) return true;
      }
      return false;
    };

    for (let gz = 0; gz < depth; gz += 1) {
      for (let gx = 0; gx < width; gx += 1) {
        if (open(gx - 1, gz) && open(gx + 1, gz) && open(gx, gz - 1) && open(gx, gz + 1)) continue;
        const column = columns[gx + gz * width] as number[];
        for (let at = 0; at < column.length; at += SPAN_STRIDE) column[at + 2] = 0;
      }
    }
  }
}
