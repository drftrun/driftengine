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
  /**
   * How many cells of height an agent can step across, the number `buildRegions` takes; 1 when
   * absent. A neighbour further above or below than this is an edge, and erosion keeps the agent's
   * radius from it.
   *
   * **Here as well as there because the polygons are flat.** Two regions whose edges touch are
   * joined by a portal whatever their heights, so a floor and a ledge above it must be kept apart
   * by erosion, or a route goes over the ledge.
   */
  readonly maxStep?: number;
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

/**
 * One rasterised sample before the columns are packed: a solid from `bottom` to `top`, in cells,
 * and whether its top can be stood on. A floor is a solid of no height.
 */
interface Sample {
  bottom: number;
  top: number;
  walkable: boolean;
}

/** Scratch for clipping a triangle to one cell: four planes leave at most seven vertices. */
const CLIP_IN = new Float64Array(8 * 3);
const CLIP_OUT = new Float64Array(8 * 3);
const HEIGHTS = new Float64Array(2);

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
        if (walkable) {
          const px = minX + (gx + 0.5) * settings.cellSize;
          const pz = minZ + (gz + 0.5) * settings.cellSize;
          const height = heightAt(ax, ay, az, bx, by, bz, cx, cy, cz, px, pz);
          if (height === null) continue;
          const floor = Math.floor((height - minY) / settings.cellHeight);
          columns[gx + gz * width]?.push({ bottom: floor, top: floor, walkable });
          continue;
        }
        /*
         * **A face too steep to stand on is a solid, over every cell it crosses.** Sampled at the
         * cell's centre like a floor, a wall is never met at all: it is vertical, so it covers no
         * area seen from above, and a building on the ground read as a roof over open floor that a
         * route went straight through. So the face is clipped to the cell's square, and the heights
         * it spans there stand in the column as one solid, whose top is not walkable.
         */
        const x0 = minX + gx * settings.cellSize;
        const z0 = minZ + gz * settings.cellSize;
        CLIP_IN.set([ax, ay, az, bx, by, bz, cx, cy, cz]);
        if (!clipToCell(x0, x0 + settings.cellSize, z0, z0 + settings.cellSize, HEIGHTS)) {
          continue;
        }
        columns[gx + gz * width]?.push({
          bottom: Math.floor(((HEIGHTS[0] as number) - minY) / settings.cellHeight),
          top: Math.floor(((HEIGHTS[1] as number) - minY) / settings.cellHeight),
          walkable: false,
        });
      }
    }
  }

  return pack(columns, width, depth, origin, settings);
}

/**
 * The lowest and highest heights of the triangle in `CLIP_IN` within one cell's square, written to
 * `out`; false where the triangle misses the cell.
 *
 * Sutherland–Hodgman against the square's four sides. Inclusive, so a wall lying exactly on a cell
 * boundary still lands in the cell the bounding box chose for it.
 */
function clipToCell(x0: number, x1: number, z0: number, z1: number, out: Float64Array): boolean {
  let count = 3;
  count = clipSide(CLIP_IN, count, CLIP_OUT, 0, x0, 1);
  count = clipSide(CLIP_OUT, count, CLIP_IN, 0, x1, -1);
  count = clipSide(CLIP_IN, count, CLIP_OUT, 2, z0, 1);
  count = clipSide(CLIP_OUT, count, CLIP_IN, 2, z1, -1);
  if (count === 0) return false;
  let low = Infinity;
  let high = -Infinity;
  for (let at = 0; at < count; at += 1) {
    const y = CLIP_IN[at * 3 + 1] as number;
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  out[0] = low;
  out[1] = high;
  return true;
}

/** Keep the part of a polygon on one side of `axis = bound`: above it for `side` 1, below for -1. */
function clipSide(
  from: Float64Array,
  count: number,
  to: Float64Array,
  axis: number,
  bound: number,
  side: number,
): number {
  let written = 0;
  for (let at = 0; at < count; at += 1) {
    const next = (at + 1) % count;
    const here = ((from[at * 3 + axis] as number) - bound) * side;
    const there = ((from[next * 3 + axis] as number) - bound) * side;
    if (here >= 0) {
      to[written * 3] = from[at * 3] as number;
      to[written * 3 + 1] = from[at * 3 + 1] as number;
      to[written * 3 + 2] = from[at * 3 + 2] as number;
      written += 1;
    }
    if (here >= 0 !== there >= 0) {
      const t = here / (here - there);
      for (let k = 0; k < 3; k += 1) {
        const a = from[at * 3 + k] as number;
        to[written * 3 + k] = a + ((from[next * 3 + k] as number) - a) * t;
      }
      written += 1;
    }
  }
  return written;
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
    samples.sort(
      (a, b) => a.bottom - b.bottom || a.top - b.top || Number(a.walkable) - Number(b.walkable),
    );
    const spans: number[] = [];
    /* Where each span's solid starts, which is the ceiling of the span below it. */
    const bottoms: number[] = [];
    for (const sample of samples) {
      const last = spans.length - SPAN_STRIDE;
      const top = spans[last] as number;
      /*
       * A sample starting within one cell of a span's top is part of that solid, not a new one.
       * The span stands on the highest top, and is walkable if anything ending within a cell of
       * that top is: a wall rising past a floor takes the floor over, and a floor's two triangles
       * at one height agree.
       */
      if (last >= 0 && sample.bottom - top <= 1) {
        const flag = sample.walkable ? 1 : 0;
        if (sample.top > top + 1) spans[last + 2] = flag;
        else if (sample.top >= top - 1) spans[last + 2] = (spans[last + 2] as number) | flag;
        spans[last] = Math.max(top, sample.top);
        continue;
      }
      spans.push(sample.top, Number.MAX_SAFE_INTEGER, sample.walkable ? 1 : 0);
      bottoms.push(sample.bottom);
    }
    /* A span's ceiling is where the next solid starts. The topmost has open sky. */
    for (let at = 0, next = 1; at + SPAN_STRIDE < spans.length; at += SPAN_STRIDE, next += 1) {
      spans[at + 1] = bottoms[next] as number;
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
 *
 * **A neighbour is judged at this span's height, not anywhere in its column.** Asked whether a
 * neighbouring column had any walkable span at all, a wall answered yes, with the roof on top of
 * it, and the floor beside the wall kept no margin. A neighbour counts as open when it has a
 * walkable span within `maxStep` of this one, a step the agent can take. Further than that is a
 * wall, a ledge or a drop, and the agent keeps its radius from it.
 */
function erode(
  columns: number[][],
  width: number,
  depth: number,
  settings: VoxeliseSettings,
): void {
  const steps = Math.ceil(settings.agentRadius / settings.cellSize);
  const reach = settings.maxStep ?? 1;
  for (let pass = 0; pass < steps; pass += 1) {
    const before = columns.map((column) => [...column]);
    const open = (gx: number, gz: number, floor: number): boolean => {
      if (gx < 0 || gz < 0 || gx >= width || gz >= depth) return false;
      const column = before[gx + gz * width] as number[];
      for (let at = 0; at < column.length; at += SPAN_STRIDE) {
        if (column[at + 2] === 1 && Math.abs((column[at] as number) - floor) <= reach) return true;
      }
      return false;
    };

    for (let gz = 0; gz < depth; gz += 1) {
      for (let gx = 0; gx < width; gx += 1) {
        const column = columns[gx + gz * width] as number[];
        for (let at = 0; at < column.length; at += SPAN_STRIDE) {
          if (column[at + 2] !== 1) continue;
          const floor = column[at] as number;
          if (
            open(gx - 1, gz, floor) &&
            open(gx + 1, gz, floor) &&
            open(gx, gz - 1, floor) &&
            open(gx, gz + 1, floor)
          ) {
            continue;
          }
          column[at + 2] = 0;
        }
      }
    }
  }
}
