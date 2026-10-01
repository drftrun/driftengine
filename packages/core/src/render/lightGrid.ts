/**
 * A world's fixed lights bucketed once, so the frame's exact choice looks only at the lights near
 * the eye rather than at every one of them.
 *
 * **The choice must be the full scan's, exactly, and needs no sort to be.** Both of the choice's
 * lists break a tie in distance by source index, so the order the lights are met in cannot reach the
 * result: what reaches it is the full scan's candidates minus only lights no query could keep —
 * every light whose cell lies within `viewRange + maxRadius` of the eye is gathered, and the
 * selection's own `viewRange + radius` test does the rest.
 *
 * **Cost stated**: built once, from where the lights stood. A light that moves or changes its reach
 * must be re-bucketed by the caller — this is for the city's fixed thousands, and a scene's handful
 * of movers stays with the plain scan.
 *
 * Nothing here allocates after construction; the gather writes into the grid's own scratch.
 */
import type { PointLightSource } from './pointLightSelection.ts';

/** The most cells a grid may span, which keeps a stray light far away from costing a gigabyte. */
export const LIGHT_GRID_MAX_CELLS = 1 << 22;

export interface LightGrid {
  readonly sources: readonly PointLightSource[];
  /** Metres a cell spans on each axis. */
  readonly cell: number;
  /** The world position of cell (0, 0, 0)'s corner. */
  readonly origin: readonly [number, number, number];
  readonly dims: readonly [number, number, number];
  /** Where cell `c`'s lights start in `lights`; `start[c + 1]` is where they end. */
  readonly start: Uint32Array;
  /** Source indices by cell, ascending within each. */
  readonly lights: Uint32Array;
  /** The largest reach of any source, which widens every query. */
  readonly maxRadius: number;
  /** The last gather, cell by cell: `gathered[0..count)`. */
  readonly gathered: Int32Array;
}

/** Bucket `sources` into cells of `cell` metres. Built once; not a frame path. */
export function createLightGrid(sources: readonly PointLightSource[], cell: number): LightGrid {
  if (!(cell > 0)) throw new Error(`createLightGrid: a cell of ${String(cell)} metres`);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let maxRadius = 0;
  for (const light of sources) {
    minX = Math.min(minX, light.x);
    minY = Math.min(minY, light.y);
    minZ = Math.min(minZ, light.z);
    maxX = Math.max(maxX, light.x);
    maxY = Math.max(maxY, light.y);
    maxZ = Math.max(maxZ, light.z);
    maxRadius = Math.max(maxRadius, light.radius);
  }
  if (sources.length === 0) minX = minY = minZ = maxX = maxY = maxZ = 0;
  const dims: [number, number, number] = [
    Math.floor((maxX - minX) / cell) + 1,
    Math.floor((maxY - minY) / cell) + 1,
    Math.floor((maxZ - minZ) / cell) + 1,
  ];
  const cells = dims[0] * dims[1] * dims[2];
  if (cells > LIGHT_GRID_MAX_CELLS) {
    throw new Error(
      `createLightGrid: these lights span ${dims.join(' × ')} cells of ${cell} m, past ` +
        `${LIGHT_GRID_MAX_CELLS}; a larger cell fits them.`,
    );
  }
  const cellOf = (light: PointLightSource): number =>
    Math.floor((light.x - minX) / cell) +
    dims[0] * (Math.floor((light.y - minY) / cell) + dims[1] * Math.floor((light.z - minZ) / cell));
  const start = new Uint32Array(cells + 1);
  for (const light of sources) {
    const c = cellOf(light);
    start[c + 1] = (start[c + 1] as number) + 1;
  }
  for (let c = 0; c < cells; c++) start[c + 1] = (start[c + 1] as number) + (start[c] as number);
  const lights = new Uint32Array(sources.length);
  const cursor = start.slice(0, cells);
  for (let index = 0; index < sources.length; index++) {
    const c = cellOf(sources[index] as PointLightSource);
    lights[cursor[c] as number] = index;
    cursor[c] = (cursor[c] as number) + 1;
  }
  return {
    sources,
    cell,
    origin: [minX, minY, minZ],
    dims,
    start,
    lights,
    maxRadius,
    gathered: new Int32Array(sources.length),
  };
}

/**
 * Gather into `grid.gathered`, cell by cell, every light whose cell lies within `reach` metres of
 * (x, y, z) on each axis, and answer how many.
 */
export function gatherLights(
  grid: LightGrid,
  x: number,
  y: number,
  z: number,
  reach: number,
): number {
  const { cell, origin, dims, start, lights, gathered } = grid;
  const x0 = Math.max(0, Math.floor((x - reach - origin[0]) / cell));
  const x1 = Math.min(dims[0] - 1, Math.floor((x + reach - origin[0]) / cell));
  const y0 = Math.max(0, Math.floor((y - reach - origin[1]) / cell));
  const y1 = Math.min(dims[1] - 1, Math.floor((y + reach - origin[1]) / cell));
  const z0 = Math.max(0, Math.floor((z - reach - origin[2]) / cell));
  const z1 = Math.min(dims[2] - 1, Math.floor((z + reach - origin[2]) / cell));
  let count = 0;
  for (let cz = z0; cz <= z1; cz++) {
    for (let cy = y0; cy <= y1; cy++) {
      const row = dims[0] * (cy + dims[1] * cz);
      for (let cx = x0; cx <= x1; cx++) {
        const c = row + cx;
        for (let at = start[c] as number; at < (start[c + 1] as number); at++) {
          gathered[count++] = lights[at] as number;
        }
      }
    }
  }
  return count;
}
