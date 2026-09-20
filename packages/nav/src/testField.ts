/**
 * A voxel field written as a picture.
 *
 * Building one from `voxeliseWalkable` means expressing "two rooms joined by a corridor one cell
 * wide" as geometry and hoping the rasteriser agrees. Written as a picture it is the thing being
 * tested, exactly, and a reader can see the corridor.
 *
 * `.` is walkable ground, `#` is nothing at all, and a digit is walkable ground that many cells up.
 *
 * **Shipped rather than excluded**, and `scripts/packages.test.mjs` is why: a file a package tracks
 * has to reach a consumer, or the repository is carrying something nobody can use. Keeping it out
 * of the barrel keeps it out of the public surface, and a consumer testing its own integration can
 * reach it by path — which is a better answer than deleting a fixture builder that works.
 */
import type { VoxelField } from './voxelise.ts';

const SPAN_STRIDE = 3;

export function fieldFromMap(rows: readonly string[]): VoxelField {
  const depth = rows.length;
  const width = depth === 0 ? 0 : (rows[0] as string).length;
  const columns: number[][] = [];

  for (let z = 0; z < depth; z += 1) {
    const row = rows[z] as string;
    for (let x = 0; x < width; x += 1) {
      const ch = row[x] ?? '#';
      if (ch === '#') {
        columns.push([]);
        continue;
      }
      const floor = ch === '.' ? 0 : Number.parseInt(ch, 10);
      columns.push([floor, Number.MAX_SAFE_INTEGER, 1]);
    }
  }

  const columnStart = new Uint32Array(width * depth + 1);
  let total = 0;
  for (let at = 0; at < columns.length; at += 1) {
    columnStart[at] = total;
    total += (columns[at] as number[]).length;
  }
  columnStart[width * depth] = total;

  const spans = new Int32Array(total);
  let write = 0;
  for (const column of columns) {
    for (const value of column) {
      spans[write] = value;
      write += 1;
    }
  }

  return {
    width,
    depth,
    cellSize: 1,
    cellHeight: 1,
    origin: new Float64Array(3),
    columnStart,
    spans,
  };
}

/** Two spans stacked in one column, for the overhang cases. */
export function stackedField(rows: readonly string[], upper: number): VoxelField {
  const base = fieldFromMap(rows);
  const columns: number[][] = [];
  for (let at = 0; at < base.width * base.depth; at += 1) {
    const from = base.columnStart[at] as number;
    const to = base.columnStart[at + 1] as number;
    const column: number[] = [];
    for (let i = from; i < to; i += SPAN_STRIDE) {
      column.push(base.spans[i] as number, upper, 1);
      column.push(upper, Number.MAX_SAFE_INTEGER, 1);
    }
    columns.push(column);
  }

  const columnStart = new Uint32Array(base.width * base.depth + 1);
  let total = 0;
  for (let at = 0; at < columns.length; at += 1) {
    columnStart[at] = total;
    total += (columns[at] as number[]).length;
  }
  columnStart[base.width * base.depth] = total;

  const spans = new Int32Array(total);
  let write = 0;
  for (const column of columns) {
    for (const value of column) {
      spans[write] = value;
      write += 1;
    }
  }
  return { ...base, columnStart, spans };
}
